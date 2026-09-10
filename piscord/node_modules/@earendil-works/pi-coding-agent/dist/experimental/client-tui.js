import { resolve } from "node:path";
import { combineFacetLoaders, createFacetHost, defineFacet, } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CombinedAutocompleteProvider, Container, SelectList, setKeybindings, Text, } from "@earendil-works/pi-tui";
import { getAgentDir } from "../config.js";
import { KeybindingsManager } from "../core/keybindings.js";
import { DefaultResourceLoader } from "../core/resource-loader.js";
import { SettingsManager } from "../core/settings-manager.js";
import { createChatViewport } from "../modes/interactive/chat-viewport.js";
import { CustomEditor } from "../modes/interactive/components/custom-editor.js";
import { getEditorTheme, setRegisteredThemes, stopThemeWatcher, theme } from "../modes/interactive/theme/theme.js";
import { InteractiveThemeController } from "../modes/interactive/theme/theme-controller.js";
import { createInteractiveTui } from "../modes/interactive/tui-renderer.js";
import { openClientRuntime } from "./client-runtime.js";
import { ExperimentalChatView } from "./client-tui-chat.js";
import { createPresentationFacetLoaders } from "./plugins/bundled.js";
import { AgentController } from "./services/agent-controller.js";
import { PresentationPlugins } from "./services/plugins.js";
import { PresentationUI } from "./services/presentation-ui.js";
import { SessionDirectory, SessionManagement } from "./services/sessions.js";
import { SlashCommands } from "./services/slash-commands.js";
import { createBuiltInSlashCommandsFacet, createSlashCommandsRuntimeFacet, } from "./services/slash-commands-provider.js";
import { Transcript } from "./services/transcript.js";
const selectTheme = {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("dim", text),
    noMatch: (text) => theme.fg("warning", text),
};
/** Service-only presentation driven by a replicated main-lane snapshot. */
export class ExperimentalClientTui {
    #ui;
    #requestRender;
    #finish;
    #documentContainer = new Container();
    #sessionHeading = new Text("", 1, 0);
    #pendingMessagesContainer = new Container();
    #statusContainer = new Container();
    #editorContainer = new Container();
    #footerComponent = new Text("", 1, 0);
    #layoutRoot;
    #sharedFacets;
    #keybindings = KeybindingsManager.create();
    #presentationFacets;
    #facetHost;
    #facetReloadTail = Promise.resolve();
    #session;
    #slashCommands;
    #controller;
    #chatInput;
    #selectList;
    #selection;
    #screen = "chat";
    #selectedServerId;
    #sessionId;
    #status = "Starting Session…";
    #busy = false;
    #closed = false;
    #closePromise;
    #recoveryTransition = Promise.resolve();
    #laneUnsubscribe;
    #chatView;
    constructor(ui, requestRender, finish, loadedFacets) {
        this.#ui = ui;
        this.#requestRender = requestRender;
        this.#finish = finish;
        this.#sharedFacets = loadedFacets;
        setKeybindings(this.#keybindings);
        this.#chatInput = new CustomEditor(ui, getEditorTheme(), this.#keybindings, { paddingX: 1 });
        this.#chatInput.onSubmit = (message) => void this.#runPrompt(message);
        this.#chatInput.onEscape = () => this.#interrupt();
        this.#chatInput.onCtrlD = finish;
        this.#chatInput.onAction("app.clear", finish);
        this.#chatInput.onAction("app.model.select", () => void this.#executeSlashCommand("model", ""));
        this.#chatInput.onAction("app.message.followUp", () => {
            const text = this.#chatInput.getText().trim();
            if (text.length === 0)
                return;
            this.#chatInput.setText("");
            void this.#queueFollowUp(text);
        });
        this.#editorContainer.addChild(this.#chatInput);
        this.#layoutRoot = createChatViewport({
            document: this.#documentContainer,
            pendingMessages: this.#pendingMessagesContainer,
            status: this.#statusContainer,
            editor: this.#editorContainer,
            footer: this.#footerComponent,
            scrollbarTrackStyle: (text) => theme.fg("scrollbarTrack", text),
            scrollbarThumbStyle: (text) => theme.fg("scrollbarThumb", text),
        }).root;
        this.#rebuild();
    }
    static async create(options) {
        const prepared = await prepareClientSession(options.command, options.servers);
        const loadedFacets = await combineFacetLoaders(options.facetLoader === undefined ? [] : [options.facetLoader]).load();
        const component = new ExperimentalClientTui(options.ui, options.requestRender, options.finish, loadedFacets);
        try {
            await component.#start(prepared);
            await component.#openPreparedSession(prepared);
            return component;
        }
        catch (error) {
            try {
                await component.close();
            }
            catch (cleanupError) {
                throw new AggregateError([error, cleanupError], "Experimental TUI startup and cleanup failed");
            }
            throw error;
        }
    }
    get layoutRoot() {
        return this.#layoutRoot;
    }
    render(width) {
        return [
            ...this.#documentContainer.render(width),
            ...this.#pendingMessagesContainer.render(width),
            ...this.#statusContainer.render(width),
            ...this.#editorContainer.render(width),
            ...this.#footerComponent.render(width),
        ];
    }
    handleInput(data) {
        if (this.#busy) {
            if (this.#keybindings.matches(data, "app.clear") ||
                (this.#chatInput.getText().length === 0 && this.#keybindings.matches(data, "app.exit"))) {
                this.#finish();
            }
            return;
        }
        if (this.#screen === "chat") {
            this.#chatInput.handleInput(data);
            this.#requestRender();
            return;
        }
        this.#selectList?.handleInput(data);
    }
    invalidate() {
        this.#layoutRoot.invalidate();
    }
    dispose() {
        void this.close().catch(() => { });
    }
    refreshTheme() {
        const snapshot = this.#laneSnapshot();
        if (snapshot !== undefined)
            this.#chatView?.refreshTheme(snapshot);
        this.#rebuild();
    }
    showError(error) {
        this.#status = `Error: ${error}`;
        this.#rebuild();
    }
    close() {
        this.#closePromise ??= this.#close();
        return this.#closePromise;
    }
    async #start(prepared) {
        const server = prepared.server;
        let presentationFacets = await combineFacetLoaders(createPresentationFacetLoaders(prepared.presentationPlugins)).load();
        this.#presentationFacets = presentationFacets;
        let facetHost;
        const reloadPresentationPlugins = (data) => {
            const operation = this.#facetReloadTail.then(async () => {
                const candidate = await combineFacetLoaders(createPresentationFacetLoaders(data)).load();
                try {
                    await facetHost.reload(candidate.facets);
                }
                catch (error) {
                    try {
                        await candidate.dispose();
                    }
                    catch (cleanupError) {
                        throw new AggregateError([error, cleanupError], "TUI plugin reload and cleanup failed");
                    }
                    throw error;
                }
                const retired = presentationFacets;
                presentationFacets = candidate;
                this.#presentationFacets = candidate;
                await retired.dispose();
            });
            this.#facetReloadTail = operation.catch(() => { });
            return operation;
        };
        const presentationBridgeFacet = defineFacet({
            id: "@pi/presentation-bridge",
            setup: (env) => {
                env.provide(PresentationUI, {
                    select: (title, items, selectedValue) => this.#select(title, items.map((item) => ({ ...item })), selectedValue),
                    showStatus: (status) => {
                        this.#status = status;
                        this.#rebuild();
                    },
                });
                const commands = env.use(SlashCommands);
                const controller = env.use(AgentController);
                const transcript = env.use(Transcript);
                const sessionFeature = {
                    serverId: server.serverId,
                    session: server.session,
                    transcript,
                };
                env.onActivate(() => {
                    if (this.#session !== undefined || this.#slashCommands !== undefined || this.#controller !== undefined) {
                        throw new Error("Presentation services are already active");
                    }
                    this.#session = sessionFeature;
                    this.#slashCommands = commands;
                    this.#controller = controller;
                    env.own(() => {
                        if (this.#session === sessionFeature)
                            this.#session = undefined;
                        if (this.#slashCommands === commands)
                            this.#slashCommands = undefined;
                        if (this.#controller === controller)
                            this.#controller = undefined;
                    });
                    env.own(commands.subscribe(() => this.#updateAutocomplete()));
                    if (server.radius) {
                        env.own(server.server.connection.subscribe((state) => this.#handleConnectionState(server.serverId, state)));
                        env.own(server.session.attachment.subscribe((state) => this.#handleAttachmentState(sessionFeature, state)));
                    }
                });
            },
        });
        facetHost = await createFacetHost({
            facets: [
                createSlashCommandsRuntimeFacet(),
                presentationBridgeFacet,
                createBuiltInSlashCommandsFacet({ reloadPresentationPlugins }),
                ...this.#sharedFacets.facets,
                ...presentationFacets.facets,
            ],
            serviceSources: [server.server, server.session],
        });
        this.#facetHost = facetHost;
    }
    async #openPreparedSession(prepared) {
        const feature = this.#session;
        if (feature === undefined)
            throw new Error(`No Session service is available for ${prepared.server.serverId}`);
        await feature.session.whenAttached(prepared.summary.sessionId, BACKGROUND_CONTEXT);
        this.#selectedServerId = feature.serverId;
        this.#sessionId = prepared.summary.sessionId;
        this.#updateAutocomplete();
        await this.#openLane(feature);
        this.#screen = "chat";
        this.#status = "";
        this.#rebuild();
    }
    async #close() {
        this.#closed = true;
        this.#completeSelection(undefined);
        const errors = [];
        try {
            await this.#recoveryTransition;
            await this.#closeLane();
            await this.#facetReloadTail;
        }
        catch (error) {
            errors.push(error);
        }
        if (this.#facetHost !== undefined) {
            try {
                await this.#facetHost.dispose();
            }
            catch (error) {
                errors.push(error);
            }
            this.#facetHost = undefined;
        }
        const generations = [this.#presentationFacets, this.#sharedFacets].filter((generation) => generation !== undefined);
        this.#presentationFacets = undefined;
        const results = await Promise.allSettled(generations.map((generation) => generation.dispose()));
        errors.push(...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])));
        if (errors.length === 1)
            throw errors[0];
        if (errors.length > 1)
            throw new AggregateError(errors, "Failed to dispose experimental TUI facets");
    }
    #rebuild() {
        this.#sessionHeading.setText(this.#sessionId === undefined || this.#selectedServerId === undefined
            ? ""
            : theme.fg("dim", `Server: ${this.#selectedServerId}\nSession: ${this.#sessionId}`));
        this.#statusContainer.clear();
        if (this.#status.length > 0) {
            this.#statusContainer.addChild(new Text(theme.fg("dim", this.#status), 1, 0));
        }
        if (this.#chatView !== undefined)
            this.#statusContainer.addChild(this.#chatView.status);
        this.#footerComponent.setText(theme.fg("dim", this.#footer()));
        this.#editorContainer.clear();
        if (this.#screen === "select" && this.#selection !== undefined) {
            this.#chatInput.focused = false;
            const selector = new Container();
            selector.addChild(new Text(theme.bold(this.#selection.title), 1, 1));
            const items = [...this.#selection.items];
            this.#selectList = new SelectList(items, Math.min(Math.max(items.length, 1), 12), selectTheme);
            const selectedIndex = items.findIndex((item) => item.value === this.#selection?.selectedValue);
            if (selectedIndex >= 0)
                this.#selectList.setSelectedIndex(selectedIndex);
            this.#selectList.onSelect = (item) => this.#completeSelection(item.value);
            this.#selectList.onCancel = () => this.#completeSelection(undefined);
            selector.addChild(this.#selectList);
            this.#editorContainer.addChild(selector);
        }
        else {
            this.#selectList = undefined;
            this.#chatInput.focused = !this.#busy;
            this.#editorContainer.addChild(this.#chatInput);
        }
        this.#layoutRoot.invalidate();
        this.#requestRender();
    }
    #select(title, items, selectedValue) {
        if (this.#selection !== undefined)
            throw new Error("A slash command selector is already active");
        return new Promise((resolve) => {
            this.#selection = { title, items, ...(selectedValue === undefined ? {} : { selectedValue }), resolve };
            this.#screen = "select";
            this.#rebuild();
        });
    }
    #completeSelection(value) {
        const selection = this.#selection;
        if (selection === undefined)
            return;
        this.#selection = undefined;
        this.#screen = "chat";
        selection.resolve(value);
        if (!this.#closed)
            this.#rebuild();
    }
    #updateAutocomplete() {
        const commands = this.#selectedSlashCommands()?.list() ?? [];
        this.#chatInput.setAutocompleteProvider(new CombinedAutocompleteProvider(commands.map((command) => ({
            name: command.name,
            description: command.description,
            ...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint }),
            ...(command.getArgumentCompletions === undefined
                ? {}
                : {
                    getArgumentCompletions: async (prefix) => {
                        const items = await command.getArgumentCompletions(prefix);
                        return items === null ? null : [...items];
                    },
                }),
        })), process.cwd()));
        this.#requestRender();
    }
    #selectedSlashCommands() {
        return this.#slashCommands;
    }
    #handleConnectionState(serverId, state) {
        if (this.#closed || this.#selectedServerId !== serverId)
            return;
        if (state.status === "connected") {
            if (this.#laneUnsubscribe === undefined) {
                this.#busy = true;
                this.#status = "Reattaching Session…";
                this.#rebuild();
            }
            return;
        }
        this.#busy = true;
        this.#status = state.status === "connecting" ? "Reconnecting to Radius…" : "Radius disconnected; retrying…";
        this.#queueRecovery(() => this.#closeLane());
        this.#rebuild();
    }
    #handleAttachmentState(feature, state) {
        if (this.#closed || this.#selectedServerId !== feature.serverId || this.#sessionId === undefined)
            return;
        if (state.status === "attached" && state.sessionId === this.#sessionId) {
            this.#queueRecovery(async () => {
                if (this.#laneUnsubscribe === undefined)
                    await this.#openLane(feature);
                this.#busy = false;
                this.#status = "";
                this.#rebuild();
            });
            return;
        }
        if (state.status === "attaching" && state.sessionId === this.#sessionId) {
            this.#busy = true;
            this.#status = "Reattaching Session…";
            this.#rebuild();
        }
    }
    #queueRecovery(operation) {
        this.#recoveryTransition = this.#recoveryTransition
            .then(async () => {
            if (!this.#closed)
                await operation();
        })
            .catch((error) => {
            if (this.#closed)
                return;
            this.#busy = true;
            this.#status = `Reconnect error: ${message(error)}`;
            this.#rebuild();
        });
    }
    async #openLane(feature) {
        await this.#closeLane();
        const view = new ExperimentalChatView(this.#ui, process.cwd());
        this.#chatView = view;
        this.#documentContainer.addChild(this.#sessionHeading);
        this.#documentContainer.addChild(view.transcript);
        this.#pendingMessagesContainer.addChild(view.pendingMessages);
        this.#laneUnsubscribe = feature.transcript.state.subscribe((value) => {
            if (value.snapshot === null)
                return;
            view.apply(value.snapshot);
            this.#rebuild();
        });
        if (feature.transcript.state.value?.snapshot === null || feature.transcript.state.value?.snapshot === undefined) {
            await this.#closeLane();
            throw new Error("Transcript has no initialized snapshot");
        }
    }
    async #closeLane() {
        this.#laneUnsubscribe?.();
        this.#laneUnsubscribe = undefined;
        this.#chatView?.dispose();
        this.#chatView = undefined;
        this.#documentContainer.clear();
        this.#pendingMessagesContainer.clear();
        this.#statusContainer.clear();
    }
    async #runPrompt(messageText) {
        const prompt = messageText.trim();
        if (prompt.length === 0)
            return;
        if (prompt.startsWith("/")) {
            const separator = prompt.indexOf(" ");
            const name = prompt.slice(1, separator === -1 ? undefined : separator);
            const args = separator === -1 ? "" : prompt.slice(separator + 1).trim();
            await this.#executeSlashCommand(name, args);
            return;
        }
        this.#chatInput.setText("");
        try {
            await this.#submitPrompt(prompt);
        }
        catch (error) {
            this.#status = `Error: ${message(error)}`;
            this.#rebuild();
        }
    }
    async #executeSlashCommand(name, args) {
        const command = this.#selectedSlashCommands()
            ?.list()
            .find((candidate) => candidate.name === name);
        this.#chatInput.setText("");
        if (command === undefined) {
            this.#status = `Unknown slash command: /${name}`;
            this.#rebuild();
            return;
        }
        try {
            const result = await command.run(args, BACKGROUND_CONTEXT);
            if (result !== undefined) {
                if ("entryId" in result)
                    this.#reportQueue(result);
                else
                    this.#reportOperation(result);
            }
        }
        catch (error) {
            this.#status = `Error: ${message(error)}`;
            this.#rebuild();
        }
    }
    async #submitPrompt(prompt) {
        const controller = this.#selectedController();
        if (controller === undefined)
            throw new Error("No Session AgentController service is available");
        const operation = this.#laneSnapshot()?.operation;
        const running = operation !== null && operation !== undefined;
        this.#status = running ? "Queueing steering message…" : "Running turn…";
        this.#rebuild();
        if (running)
            this.#reportQueue(await controller.steer({ message: prompt, images: null }, BACKGROUND_CONTEXT));
        else
            this.#reportOperation(await controller.prompt({ message: prompt, images: null }, BACKGROUND_CONTEXT));
    }
    async #queueFollowUp(text) {
        const controller = this.#selectedController();
        if (controller === undefined)
            return;
        try {
            this.#status = "Queueing follow-up…";
            this.#rebuild();
            this.#reportQueue(await controller.followUp({ message: text, images: null }, BACKGROUND_CONTEXT));
        }
        catch (error) {
            this.#status = `Error: ${message(error)}`;
            this.#rebuild();
        }
    }
    #reportOperation(response) {
        this.#status = response.accepted
            ? response.error === null
                ? ""
                : `Operation failed: ${response.error.message}`
            : `Operation rejected: ${response.error.message}`;
        this.#rebuild();
    }
    #reportQueue(response) {
        this.#status = response.accepted ? `Queued ${response.entryId}.` : `Message rejected: ${response.error.message}`;
        this.#rebuild();
    }
    #interrupt() {
        const operation = this.#laneSnapshot()?.operation;
        const controller = this.#selectedController();
        if (operation === null || operation === undefined || controller === undefined)
            return;
        this.#status = `Aborting ${operation.id}…`;
        this.#rebuild();
        void controller.requestAbort(operation.id, BACKGROUND_CONTEXT).catch((error) => {
            this.#status = `Error: ${message(error)}`;
            this.#rebuild();
        });
    }
    #selectedController() {
        return this.#controller;
    }
    #laneSnapshot() {
        const snapshot = this.#session?.transcript.state.value?.snapshot;
        return snapshot === null ? undefined : snapshot;
    }
    #footer() {
        const snapshot = this.#laneSnapshot();
        if (!snapshot)
            return "/model · /thinking · /compact · /reload";
        return `${snapshot.configuration.model.provider}/${snapshot.configuration.model.modelId} · thinking:${snapshot.configuration.thinkingLevel} · ${snapshot.stats.messageCount} messages · /model · /thinking · /compact · /reload`;
    }
}
async function prepareClientSession(command, servers) {
    const opened = servers.map((server) => ({
        server,
        services: server.server.open({
            services: [SessionDirectory, SessionManagement, PresentationPlugins],
            assertAccess() { },
            onError() { },
        }),
    }));
    try {
        const features = opened.map(({ server, services }) => ({
            server,
            directory: services.use(SessionDirectory),
            management: services.use(SessionManagement),
            plugins: services.use(PresentationPlugins),
        }));
        await Promise.all(opened.map(({ services }) => services.ready(BACKGROUND_CONTEXT)));
        let selected;
        if (command.sessionId !== undefined) {
            const matches = features.flatMap((feature) => (feature.directory.state.value?.sessions ?? [])
                .filter((session) => session.sessionId === command.sessionId)
                .map((summary) => ({
                server: feature.server,
                management: feature.management,
                plugins: feature.plugins,
                summary,
            })));
            if (matches.length > 1)
                throw new Error(`Session ${command.sessionId} is available from more than one server`);
            selected = matches[0];
            if (selected === undefined) {
                if (command.connect?.transport === "radius") {
                    throw new Error(`Remote server does not contain Session ${command.sessionId}`);
                }
                const feature = requireSingleServer(features);
                selected = {
                    server: feature.server,
                    management: feature.management,
                    plugins: feature.plugins,
                    summary: await feature.management.create({ id: command.sessionId }, BACKGROUND_CONTEXT),
                };
            }
        }
        else if (command.continue === true || command.resume === true) {
            selected = features
                .flatMap((feature) => (feature.directory.state.value?.sessions ?? []).map((summary) => ({
                server: feature.server,
                management: feature.management,
                plugins: feature.plugins,
                summary,
            })))
                .sort((left, right) => right.summary.createdAt - left.summary.createdAt ||
                left.summary.serverId.localeCompare(right.summary.serverId) ||
                left.summary.sessionId.localeCompare(right.summary.sessionId))[0];
        }
        if (selected === undefined) {
            const feature = requireSingleServer(features);
            selected = {
                server: feature.server,
                management: feature.management,
                plugins: feature.plugins,
                summary: await feature.management.create({}, BACKGROUND_CONTEXT),
            };
        }
        const presentationPlugins = await selected.plugins.prepareSession({
            sessionId: selected.summary.sessionId,
            packagePaths: command.pluginPackages?.map((packagePath) => resolve(packagePath)) ?? null,
        }, BACKGROUND_CONTEXT);
        await selected.management.attach(selected.summary.sessionId, BACKGROUND_CONTEXT);
        await selected.server.session.whenAttached(selected.summary.sessionId, BACKGROUND_CONTEXT);
        return {
            server: selected.server,
            summary: selected.summary,
            presentationPlugins,
        };
    }
    finally {
        await Promise.allSettled(opened.map(({ services }) => services.dispose(BACKGROUND_CONTEXT)));
    }
}
export async function runClientTui(command, options = {}) {
    const cwd = process.cwd();
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noContextFiles: true,
    });
    await resourceLoader.reload();
    setRegisteredThemes(resourceLoader.getThemes().themes);
    const runtime = await openClientRuntime(command, options);
    const tui = createInteractiveTui({
        tuiMode: "fullscreen",
        showHardwareCursor: settingsManager.getShowHardwareCursor(),
        logDirectory: agentDir,
    });
    tui.setClearOnShrink(settingsManager.getClearOnShrink());
    let component;
    let tuiStarted = false;
    const themeController = new InteractiveThemeController(tui, {
        getSettingsManager: () => settingsManager,
        showError: (error) => component?.showError(error),
        onChanged: () => component?.refreshTheme(),
    });
    try {
        let finish;
        const finished = new Promise((resolve) => {
            finish = () => {
                themeController.disableAutoSync();
                if (tuiStarted) {
                    tui.stop();
                    tuiStarted = false;
                }
                resolve();
            };
        });
        component = await ExperimentalClientTui.create({
            command,
            ui: tui,
            servers: runtime.servers.map((server) => ({
                serverId: server.route.serverId,
                radius: server.route.transport === "radius",
                server: server.server,
                session: server.session,
            })),
            facetLoader: options.facetLoader,
            requestRender: () => tui.requestRender(),
            finish,
        });
        tui.addChild(component);
        tui.setLayoutRoot(component.layoutRoot);
        tui.setFocus(component);
        tuiStarted = true;
        tui.start();
        await themeController.applyFromSettings();
        await finished;
    }
    finally {
        themeController.dispose();
        stopThemeWatcher();
        if (tuiStarted)
            tui.stop();
        await component?.close();
        await runtime.dispose();
    }
}
function requireSingleServer(features) {
    if (features.length !== 1)
        throw new Error("Starting a Session requires exactly one server");
    return features[0];
}
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=client-tui.js.map