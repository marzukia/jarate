import { Container, Spacer, Text, TruncatedText } from "@earendil-works/pi-tui";
import { createAllToolRenderers } from "../core/tools/renderers/index.js";
import { AssistantMessageComponent } from "../modes/interactive/components/assistant-message.js";
import { WorkingStatusIndicator } from "../modes/interactive/components/status-indicator.js";
import { ToolExecutionComponent } from "../modes/interactive/components/tool-execution.js";
import { UserMessageComponent } from "../modes/interactive/components/user-message.js";
import { theme } from "../modes/interactive/theme/theme.js";
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
/** Snapshot-driven transcript used by the service-only experimental presentation. */
export class ExperimentalChatView {
    static #renderers = createAllToolRenderers();
    transcript = new Container();
    pendingMessages = new Container();
    status = new Container();
    #ui;
    #cwd;
    #tools = new Map();
    #renderedEntryIds = [];
    #streaming;
    #indicator;
    #working = false;
    constructor(ui, cwd) {
        this.#ui = ui;
        this.#cwd = cwd;
    }
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
        this.transcript.invalidate();
        this.pendingMessages.invalidate();
        this.status.invalidate();
    }
    refreshTheme(snapshot) {
        this.#indicator?.dispose();
        this.#indicator = undefined;
        this.#working = false;
        this.transcript.clear();
        this.pendingMessages.clear();
        this.status.clear();
        this.#tools.clear();
        this.#renderedEntryIds = [];
        this.#streaming = undefined;
        this.apply(snapshot);
    }
    dispose() {
        this.#indicator?.dispose();
    }
    #syncQueues(queues) {
        this.pendingMessages.clear();
        for (const item of queues) {
            const text = item.type === "message" ? userMessageText(item.message).replace(/\s+/g, " ") : `<${item.customType}>`;
            this.pendingMessages.addChild(new TruncatedText(theme.fg("muted", `[${item.kind}] ${text}`), 1, 0));
        }
    }
    #syncTranscript(transcript) {
        const diverged = this.#renderedEntryIds.some((id, index) => transcript[index]?.id !== id);
        if (diverged) {
            this.transcript.clear();
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
            this.#addText(theme.fg("muted", `[compaction] compacted from ${entry.tokensBefore} tokens`));
            for (const retained of entry.retainedTail)
                this.#addMessage(retained);
            return;
        }
        if (entry.type === "branch_summary") {
            this.#addText(theme.fg("muted", "[branch summary]"));
            this.#addText(entry.summary);
            return;
        }
        if (entry.type === "custom") {
            this.#addText(theme.fg("muted", `[${entry.customType}]`));
            return;
        }
        this.#addMessage(entry.message);
    }
    #addMessage(message) {
        if (message.role === "user") {
            this.transcript.addChild(new Spacer(1));
            this.transcript.addChild(new UserMessageComponent(userMessageText(message)));
            return;
        }
        if (message.role === "assistant") {
            const component = this.#streaming ?? new AssistantMessageComponent();
            if (!this.#streaming)
                this.transcript.addChild(component);
            this.#streaming = undefined;
            component.updateContent(message, false);
            for (const content of message.content) {
                if (content.type === "toolCall")
                    this.#tool(content.name, content.id, content.arguments).setArgsComplete();
            }
            return;
        }
        if (message.role === "toolResult")
            this.#tool(message.toolName, message.toolCallId).updateResult(message);
    }
    #syncStreaming(message) {
        if (!message)
            return;
        if (!this.#streaming) {
            this.#streaming = new AssistantMessageComponent();
            this.transcript.addChild(this.#streaming);
        }
        this.#streaming.updateContent(message, true);
        for (const content of message.content) {
            if (content.type === "toolCall")
                this.#tool(content.name, content.id, content.arguments);
        }
    }
    #tool(toolName, toolCallId, args) {
        const existing = this.#tools.get(toolCallId);
        if (existing) {
            if (args !== undefined)
                existing.updateArgs(args);
            return existing;
        }
        const component = new ToolExecutionComponent(toolName, toolCallId, args ?? {}, {}, ExperimentalChatView.#renderers[toolName], this.#ui, this.#cwd);
        this.transcript.addChild(component);
        this.#tools.set(toolCallId, component);
        return component;
    }
    #addText(text) {
        this.transcript.addChild(new Spacer(1));
        this.transcript.addChild(new Text(text, 1, 0));
    }
    #setWorking(working) {
        if (working === this.#working)
            return;
        this.#working = working;
        this.#indicator?.dispose();
        this.#indicator = undefined;
        this.status.clear();
        if (working) {
            this.#indicator = new WorkingStatusIndicator(this.#ui, "Working... (esc to abort)");
            this.status.addChild(this.#indicator);
        }
    }
}
//# sourceMappingURL=client-tui-chat.js.map