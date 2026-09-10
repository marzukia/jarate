/**
 * The view. It holds no live objects: no harness, lane, session, or model runtime.
 *
 * Everything it renders comes from a replicated `SessionView` snapshot, and everything it does is a
 * command that answers with data. Whether that view is in-process or a socket away is invisible here.
 */
import { Container, fuzzyFilter, getKeybindings, Input, ProcessTerminal, ScrollView, SelectList, Spacer, setKeybindings, Text, TruncatedText, TuiAltScreen, VStack, } from "@earendil-works/pi-tui";
import { getAgentDir } from "../../../config.js";
import { KeybindingsManager } from "../../../core/keybindings.js";
import { createAllToolRenderers } from "../../../core/tools/renderers/index.js";
import { AssistantMessageComponent } from "../../../modes/interactive/components/assistant-message.js";
import { CustomEditor } from "../../../modes/interactive/components/custom-editor.js";
import { DynamicBorder } from "../../../modes/interactive/components/dynamic-border.js";
import { ExtensionSelectorComponent } from "../../../modes/interactive/components/extension-selector.js";
import { keyText } from "../../../modes/interactive/components/keybinding-hints.js";
import { LoginDialogComponent } from "../../../modes/interactive/components/login-dialog.js";
import { OAuthSelectorComponent, } from "../../../modes/interactive/components/oauth-selector.js";
import { WorkingStatusIndicator, } from "../../../modes/interactive/components/status-indicator.js";
import { ToolExecutionComponent } from "../../../modes/interactive/components/tool-execution.js";
import { UserMessageComponent } from "../../../modes/interactive/components/user-message.js";
import { getEditorTheme, initTheme, theme } from "../../../modes/interactive/theme/theme.js";
const SUBSCRIPTION_LOGIN_LABEL = "Sign in with an account";
const API_KEY_LOGIN_LABEL = "Sign in with an API key";
function userMessageText(message) {
    if (message.role !== "user")
        return "";
    if (typeof message.content === "string")
        return message.content;
    return message.content
        .filter((content) => content.type === "text")
        .map((content) => content.text)
        .join("");
}
const SELECT_THEME = {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("dim", text),
    noMatch: (text) => theme.fg("warning", text),
};
/** Fuzzy-searchable list over plain data, used where interactive mode needs a live ModelRuntime. */
class ListSelector extends Container {
    #input = new Input();
    #listContainer = new Container();
    #items;
    #onSelect;
    #onCancel;
    #list;
    #isFocused = false;
    constructor(title, items, onSelect, onCancel) {
        super();
        this.#items = items;
        this.#onSelect = onSelect;
        this.#onCancel = onCancel;
        this.#list = this.#build(items);
        this.addChild(new DynamicBorder());
        this.addChild(new Spacer(1));
        this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
        this.addChild(this.#input);
        this.addChild(new Spacer(1));
        this.addChild(this.#listContainer);
        this.addChild(new DynamicBorder());
    }
    get focused() {
        return this.#isFocused;
    }
    set focused(value) {
        this.#isFocused = value;
        this.#input.focused = value;
    }
    handleInput(data) {
        const keybindings = getKeybindings();
        const forwarded = ["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"];
        if (forwarded.some((action) => keybindings.matches(data, action))) {
            this.#list.handleInput(data);
            return;
        }
        this.#input.handleInput(data);
        const query = this.#input.getValue();
        const filtered = query.length === 0 ? this.#items : fuzzyFilter(this.#items, query, (item) => `${item.label} ${item.value}`);
        this.#list = this.#build(filtered);
    }
    #build(items) {
        const list = new SelectList(items, 10, SELECT_THEME);
        list.onSelect = (item) => this.#onSelect(item.value);
        list.onCancel = () => this.#onCancel();
        this.#listContainer.clear();
        this.#listContainer.addChild(list);
        return list;
    }
}
/** Alt-screen chat surface. Rendering is a function of the replicated snapshot. */
class MiniTui {
    #ui;
    #chat = new Container();
    #queue = new Container();
    #status = new Container();
    #footer = new Text("", 1, 0);
    #editorContainer = new Container();
    #editor;
    #cwd;
    #tools = new Map();
    /** Entry ids already painted, in transcript order, so re-renders only append. */
    #renderedEntryIds = [];
    #streaming;
    #indicator;
    #working = false;
    #mountedDispose;
    constructor(cwd, handlers) {
        this.#cwd = cwd;
        this.#ui = new TuiAltScreen(new ProcessTerminal(), false, getAgentDir());
        const keybindings = KeybindingsManager.create();
        setKeybindings(keybindings);
        this.#editor = new CustomEditor(this.#ui, getEditorTheme(), keybindings, { paddingX: 1 });
        this.#editor.onSubmit = handlers.submit;
        this.#editor.onEscape = handlers.interrupt;
        this.#editor.onCtrlD = handlers.exit;
        this.#editor.onAction("app.clear", handlers.exit);
        this.#editor.onAction("app.model.select", handlers.selectModel);
        this.#editor.onAction("app.message.followUp", () => {
            const text = this.#editor.getText().trim();
            if (text.length === 0)
                return;
            this.#editor.setText("");
            handlers.queueFollowUp(text);
        });
        this.#editorContainer.addChild(this.#editor);
        const transcript = new ScrollView(this.#chat, { follow: "end", primary: true, overscroll: "chain" });
        const dock = new VStack([
            { component: this.#queue, shrink: 1, minSize: 0 },
            { component: this.#status, shrink: 1, minSize: 0 },
            { component: this.#editorContainer, shrink: 1, minSize: 3 },
            { component: this.#footer, shrink: 1, minSize: 0 },
        ]);
        this.#ui.addChild(this.#chat);
        this.#ui.addChild(this.#queue);
        this.#ui.addChild(this.#status);
        this.#ui.addChild(this.#editorContainer);
        this.#ui.addChild(this.#footer);
        this.#ui.setLayoutRoot(new VStack([
            { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
            { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
        ]));
        this.#ui.setFocus(this.#editor);
    }
    get ui() {
        return this.#ui;
    }
    start() {
        this.#ui.start();
    }
    stop() {
        this.#mountedDispose?.();
        this.#indicator?.dispose();
        this.#ui.stop();
    }
    render() {
        this.#ui.requestRender();
    }
    addText(text) {
        this.#chat.addChild(new Spacer(1));
        this.#chat.addChild(new Text(text, 1, 0));
        this.render();
    }
    setFooter(text) {
        this.#footer.setText(theme.fg("dim", text));
        this.render();
    }
    /** Swap the editor slot for a selector or dialog. */
    mount(component, focus, dispose) {
        this.#mountedDispose?.();
        this.#mountedDispose = dispose;
        this.#editorContainer.clear();
        this.#editorContainer.addChild(component);
        this.#ui.setFocus(focus);
        this.render();
    }
    restoreEditor() {
        this.#mountedDispose?.();
        this.#mountedDispose = undefined;
        this.#editorContainer.clear();
        this.#editorContainer.addChild(this.#editor);
        this.#ui.setFocus(this.#editor);
        this.render();
    }
    /**
     * Paint one replicated snapshot. Settled entries are keyed by id and only appended, so a redraw
     * per streamed token costs one markdown rebuild, not a full transcript rebuild.
     */
    apply(snapshot) {
        this.#syncTranscript(snapshot.transcript);
        this.#syncStreaming(snapshot.operation?.streamingMessage);
        for (const tool of snapshot.operation?.runningTools ?? []) {
            const component = this.#tool(tool.toolName, tool.toolCallId, tool.args);
            if (tool.status === "running") {
                component.markExecutionStarted();
                if (tool.result !== undefined)
                    component.updateResult({ ...tool.result, isError: false }, true);
            }
            else {
                component.updateResult({ ...tool.result, isError: tool.isError }, false);
            }
        }
        this.#syncQueues(snapshot.queues);
        this.#setWorking(snapshot.operation !== null);
        this.render();
    }
    /** One ordered tagged inbox: steered and queued input, plus writes waiting for a boundary. */
    #syncQueues(queues) {
        this.#queue.clear();
        for (const item of queues) {
            const text = item.type === "message" ? userMessageText(item.message).replace(/\s+/g, " ") : `<${item.customType}>`;
            this.#queue.addChild(new TruncatedText(theme.fg("muted", `[${item.kind}] ${text}`), 1, 0));
        }
    }
    #syncTranscript(transcript) {
        const diverged = this.#renderedEntryIds.some((id, index) => transcript[index]?.id !== id);
        if (diverged) {
            // Compaction, navigation, or a fork rewrote the branch: repaint from scratch.
            this.#chat.clear();
            this.#tools.clear();
            this.#renderedEntryIds = [];
            this.#streaming = undefined;
        }
        for (const entry of transcript.slice(this.#renderedEntryIds.length)) {
            this.#addEntry(entry);
            this.#renderedEntryIds.push(entry.id);
        }
    }
    #addEntry(entry) {
        if (entry.type === "compaction") {
            // The compaction entry heads the branch, so it has to render its own retained messages.
            this.addText(theme.fg("muted", `[compaction] compacted from ${entry.tokensBefore} tokens`));
            for (const retained of entry.retainedTail)
                this.#addMessage(retained);
            return;
        }
        if (entry.type === "branch_summary") {
            this.addText(theme.fg("muted", "[branch summary]"));
            this.addText(entry.summary);
            return;
        }
        if (entry.type === "custom") {
            this.addText(theme.fg("muted", `[${entry.customType}]`));
            return;
        }
        this.#addMessage(entry.message);
    }
    #addMessage(message) {
        if (message.role === "user") {
            this.#chat.addChild(new Spacer(1));
            this.#chat.addChild(new UserMessageComponent(userMessageText(message)));
        }
        else if (message.role === "assistant") {
            // Adopt the streaming component so the settled message replaces it instead of duplicating it.
            const component = this.#streaming ?? new AssistantMessageComponent();
            if (!this.#streaming)
                this.#chat.addChild(component);
            this.#streaming = undefined;
            component.updateContent(message, false);
            for (const content of message.content) {
                if (content.type !== "toolCall")
                    continue;
                this.#tool(content.name, content.id, content.arguments).setArgsComplete();
            }
        }
        else if (message.role === "toolResult") {
            this.#tool(message.toolName, message.toolCallId).updateResult(message);
        }
    }
    #syncStreaming(message) {
        if (!message)
            return;
        if (!this.#streaming) {
            this.#streaming = new AssistantMessageComponent();
            this.#chat.addChild(this.#streaming);
        }
        this.#streaming.updateContent(message, true);
        for (const content of message.content) {
            if (content.type === "toolCall")
                this.#tool(content.name, content.id, content.arguments);
        }
    }
    /** Built-in renderers, without the tool implementations or their schemas. */
    static #renderers = createAllToolRenderers();
    /** Get or create the component for a tool call; omit `args` to look up without overwriting them. */
    #tool(toolName, toolCallId, args) {
        const existing = this.#tools.get(toolCallId);
        if (existing) {
            if (args !== undefined)
                existing.updateArgs(args);
            return existing;
        }
        const component = new ToolExecutionComponent(toolName, toolCallId, args ?? {}, {}, MiniTui.#renderers[toolName], this.#ui, this.#cwd);
        this.#chat.addChild(component);
        this.#tools.set(toolCallId, component);
        return component;
    }
    #setWorking(working) {
        if (working === this.#working)
            return;
        this.#working = working;
        this.#indicator?.dispose();
        this.#indicator = undefined;
        this.#status.clear();
        if (working) {
            this.#indicator = new WorkingStatusIndicator(this.#ui, "Working... (esc to abort)");
            this.#status.addChild(this.#indicator);
        }
    }
}
function toAuthSelectorProviders(accounts) {
    return accounts.map((account) => ({
        id: account.id,
        name: account.name,
        authType: account.authType,
        ...(account.configured ? { status: { type: account.authType, source: account.source ?? "configured" } } : {}),
    }));
}
function runLogin(view, client, account, setUi) {
    const dialog = new LoginDialogComponent(view.ui, account.id, () => view.restoreEditor(), account.name);
    view.mount(dialog, dialog);
    if (!account.interactive) {
        dialog.showInfo(`${account.methodName ?? "Authentication"} is configured outside pi.`, [], true);
        return Promise.resolve({ ok: true });
    }
    setUi({
        notify: (notice) => {
            if (notice.type === "auth_url")
                dialog.showAuth(notice.url, notice.instructions);
            else if (notice.type === "device_code") {
                dialog.showDeviceCode(notice);
                dialog.showWaiting("Waiting for authentication...");
            }
            else if (notice.type === "info")
                dialog.showInfo(notice.message, notice.links);
            else
                dialog.showProgress(notice.message);
        },
        prompt: (request) => {
            if (request.type === "manual_code")
                return dialog.showManualInput(request.message);
            if (request.type !== "select")
                return dialog.showPrompt(request.message, request.placeholder);
            return new Promise((resolve) => {
                const selector = new ExtensionSelectorComponent(request.message, request.options.map((option) => option.label), (label) => {
                    view.mount(dialog, dialog);
                    resolve(request.options.find((option) => option.label === label)?.id ?? null);
                }, () => {
                    view.mount(dialog, dialog);
                    resolve(null);
                });
                view.mount(selector, selector);
            });
        },
    });
    return client.models.login(account.id, account.authType).finally(() => {
        setUi(undefined);
        view.restoreEditor();
    });
}
/** Run the view against one attached session until the user exits. */
export async function runView(client) {
    initTheme();
    let exit = () => { };
    const exited = new Promise((resolve) => {
        exit = () => resolve();
    });
    let view;
    let loginUi;
    const report = (result) => {
        if (!result.ok)
            view.addText(theme.fg("error", result.error));
    };
    client.onAuth((event) => {
        if (event.type === "notice") {
            loginUi?.notify(event.notice);
            return;
        }
        const answer = loginUi?.prompt(event.request) ?? Promise.resolve(null);
        void answer.then((value) => client.models.authReply(event.requestId, value), () => client.models.authReply(event.requestId, null));
    });
    const selectModel = () => {
        const items = client.state().models.models.map((model) => ({
            value: `${model.provider}/${model.modelId}`,
            label: model.modelId,
            description: model.provider,
        }));
        const selector = new ListSelector("Select model:", items, (value) => {
            view.restoreEditor();
            const separator = value.indexOf("/");
            void client.lane
                .setModel({ provider: value.slice(0, separator), modelId: value.slice(separator + 1) })
                .then(report);
        }, () => view.restoreEditor());
        view.mount(selector, selector);
    };
    const selectLoginProvider = (authType) => {
        const accounts = client.state().models.accounts.filter((account) => account.authType === authType);
        if (accounts.length === 0) {
            view.restoreEditor();
            view.addText(theme.fg("dim", "No providers for that method."));
            return;
        }
        const selector = new OAuthSelectorComponent("login", toAuthSelectorProviders(accounts), (providerId) => {
            view.restoreEditor();
            const account = accounts.find((candidate) => candidate.id === providerId);
            const setLoginUi = (ui) => {
                loginUi = ui;
            };
            if (account)
                void runLogin(view, client, account, setLoginUi).then(report);
        }, 
        // Cancelling the provider list steps back to the auth method choice, as in interactive mode.
        () => login());
        view.mount(selector, selector);
    };
    const login = () => {
        const selector = new ExtensionSelectorComponent("Select authentication method:", [SUBSCRIPTION_LOGIN_LABEL, API_KEY_LOGIN_LABEL], (option) => selectLoginProvider(option === SUBSCRIPTION_LOGIN_LABEL ? "oauth" : "api_key"), () => view.restoreEditor());
        view.mount(selector, selector);
    };
    view = new MiniTui(client.state().cwd, {
        submit: (text) => {
            const trimmed = text.trim();
            if (trimmed.length === 0)
                return;
            if (trimmed === "/model")
                return selectModel();
            if (trimmed === "/login")
                return login();
            if (trimmed === "/compact") {
                void client.lane.compact().then(report);
                return;
            }
            // A submission during an active run steers it; alt+enter queues a follow-up instead.
            const busy = client.state().lane.operation !== null;
            void (busy ? client.lane.steer(trimmed) : client.lane.prompt(trimmed)).then(report);
        },
        queueFollowUp: (text) => void client.lane.followUp(text).then(report),
        // The worker is authoritative. Never suppress abort from a potentially stale presentation snapshot.
        interrupt: () => void client.lane.abort().then(report),
        exit,
        selectModel: () => selectModel(),
    });
    const render = () => {
        const snapshot = client.state();
        view.apply(snapshot.lane);
        const { model, thinkingLevel } = snapshot.lane.configuration;
        view.setFooter(`${model.provider}/${model.modelId} · thinking:${thinkingLevel} · ${keyText("app.model.select")} or /model · /login · /compact · ${keyText("app.message.followUp")} follow-up · ${keyText("app.clear")} exit`);
    };
    const unsubscribe = client.subscribe(render);
    view.start();
    render();
    view.addText(theme.fg("dim", client.state().sessionPath));
    await exited;
    unsubscribe();
    view.stop();
}
//# sourceMappingURL=view.js.map