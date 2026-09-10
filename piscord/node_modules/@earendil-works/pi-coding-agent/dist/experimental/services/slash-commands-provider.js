import { defineFacet } from "@earendil-works/chord";
import { AgentController } from "./agent-controller.js";
import { Models } from "./models.js";
import { PresentationPlugins, SessionPlugins } from "./plugins.js";
import { PresentationUI } from "./presentation-ui.js";
import { SlashCommands } from "./slash-commands.js";
const THINKING_DESCRIPTIONS = {
    off: "No reasoning",
    minimal: "Very brief reasoning",
    low: "Light reasoning",
    medium: "Moderate reasoning",
    high: "Deep reasoning",
    xhigh: "Extra-high reasoning",
    max: "Maximum reasoning",
};
export class SlashCommandRegistry {
    #commands = new Map();
    #listeners = new Set();
    register(command) {
        this.#validate(command);
        if (this.#commands.has(command.name))
            throw new Error(`Slash command /${command.name} is already registered`);
        return this.#add(command);
    }
    replace(command) {
        this.#validate(command);
        return this.#add(command);
    }
    list() {
        return Object.freeze([...this.#commands.values()].map((entries) => entries[0].command));
    }
    subscribe(listener) {
        this.#listeners.add(listener);
        listener(this.list());
        return () => this.#listeners.delete(listener);
    }
    #add(command) {
        const entry = { command: Object.freeze({ ...command }), closed: false };
        const entries = this.#commands.get(command.name) ?? [];
        entries.push(entry);
        this.#commands.set(command.name, entries);
        if (entries.length === 1)
            this.#publish();
        return () => {
            if (entry.closed)
                return;
            entry.closed = true;
            if (entries[0] !== entry)
                return;
            while (entries[0]?.closed)
                entries.shift();
            if (entries.length === 0)
                this.#commands.delete(command.name);
            this.#publish();
        };
    }
    #validate(command) {
        if (!/^[a-z0-9][a-z0-9:-]*$/u.test(command.name)) {
            throw new TypeError(`Invalid slash command name: ${command.name}`);
        }
    }
    #publish() {
        const commands = this.list();
        for (const listener of this.#listeners)
            listener(commands);
    }
}
export function createSlashCommandsRuntimeFacet(registry = new SlashCommandRegistry()) {
    return defineFacet({
        id: "@pi/slash-commands-runtime",
        setup(env) {
            env.provide(SlashCommands, registry);
        },
    });
}
export function createBuiltInSlashCommandsFacet(options) {
    return defineFacet({
        id: "@pi/slash-commands-builtin",
        setup(env) {
            const commands = env.use(SlashCommands);
            const models = env.use(Models);
            const controller = env.use(AgentController);
            const ui = env.use(PresentationUI);
            const presentationPlugins = env.use(PresentationPlugins);
            const sessionPlugins = env.use(SessionPlugins);
            env.onActivate(() => {
                env.own(commands.replace(modelCommand(models, ui)));
                env.own(commands.replace(thinkingCommand(models, ui)));
                env.own(commands.replace(compactCommand(controller, ui)));
                env.own(commands.replace({
                    name: "reload",
                    description: "Reload server-selected plugins",
                    async run(_args, context) {
                        ui.showStatus("Reloading plugins…", context);
                        const data = await presentationPlugins.reload(context);
                        await sessionPlugins.reload(context);
                        await options.reloadPresentationPlugins(data);
                        ui.showStatus("Reloaded plugins.", context);
                        return undefined;
                    },
                }));
            });
        },
    });
}
function modelCommand(models, ui) {
    return {
        name: "model",
        description: "Select model",
        argumentHint: "<provider/model>",
        getArgumentCompletions(prefix) {
            const normalized = prefix.toLowerCase();
            return (models.state.value?.catalog.availableModels ?? [])
                .filter((model) => `${model.provider}/${model.modelId} ${model.name}`.toLowerCase().includes(normalized))
                .map((model) => ({
                value: `${model.provider}/${model.modelId}`,
                label: model.modelId,
                description: model.provider,
            }));
        },
        async run(args, context) {
            const state = models.state.value;
            if (state === undefined)
                throw new Error("Models service is not ready");
            let selected = exactModel(state.catalog.availableModels, args);
            if (args.length > 0 && selected === undefined) {
                throw new Error(`Unknown model: ${args}`);
            }
            if (selected === undefined) {
                const value = await ui.select("Select model:", state.catalog.availableModels.map((model) => ({
                    value: `${model.provider}/${model.modelId}`,
                    label: state.configuration.model?.provider === model.provider &&
                        state.configuration.model.modelId === model.modelId
                        ? `${model.name} (selected)`
                        : model.name,
                    description: `${model.provider}/${model.modelId}`,
                })), state.configuration.model === null
                    ? undefined
                    : `${state.configuration.model.provider}/${state.configuration.model.modelId}`, context);
                if (value === undefined)
                    return undefined;
                selected = exactModel(state.catalog.availableModels, value);
                if (selected === undefined)
                    throw new Error(`Unknown model: ${value}`);
            }
            await models.select({ provider: selected.provider, modelId: selected.modelId }, context);
            ui.showStatus(`Selected ${selected.provider}/${selected.modelId}.`, context);
            return undefined;
        },
    };
}
function thinkingCommand(models, ui) {
    return {
        name: "thinking",
        description: "Set thinking level",
        argumentHint: "<level>",
        async run(args, context) {
            const levels = await models.getThinkingLevels(context);
            let selected = levels.find((level) => level === args.toLowerCase());
            if (args.length > 0 && selected === undefined) {
                throw new Error(`Unknown thinking level "${args}". Available levels: ${levels.join(", ")}.`);
            }
            if (selected === undefined) {
                const value = await ui.select("Select thinking level:", levels.map((level) => ({
                    value: level,
                    label: models.state.value?.configuration.thinkingLevel === level ? `${level} (selected)` : level,
                    description: THINKING_DESCRIPTIONS[level],
                })), models.state.value?.configuration.thinkingLevel, context);
                if (value === undefined)
                    return undefined;
                selected = levels.find((level) => level === value);
                if (selected === undefined)
                    throw new Error(`Unknown thinking level: ${value}`);
            }
            await models.selectThinking(selected, context);
            ui.showStatus(`Thinking level: ${selected}.`, context);
            return undefined;
        },
    };
}
function compactCommand(controller, ui) {
    return {
        name: "compact",
        description: "Manually compact the session context",
        argumentHint: "<instructions>",
        run(args, context) {
            ui.showStatus("Compacting…", context);
            return controller.compact({ customInstructions: args.length === 0 ? null : args }, context);
        },
    };
}
function exactModel(models, query) {
    if (query.length === 0)
        return undefined;
    const normalized = query.toLowerCase();
    const matches = models.filter((model) => `${model.provider}/${model.modelId}`.toLowerCase() === normalized ||
        model.modelId.toLowerCase() === normalized);
    return matches.length === 1 ? matches[0] : undefined;
}
//# sourceMappingURL=slash-commands-provider.js.map