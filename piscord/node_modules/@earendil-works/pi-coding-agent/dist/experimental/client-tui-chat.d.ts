import type { LaneSnapshot } from "@earendil-works/pi-agent-core";
import { Container, type TUI } from "@earendil-works/pi-tui";
/** Snapshot-driven transcript used by the service-only experimental presentation. */
export declare class ExperimentalChatView {
    #private;
    readonly transcript: Container;
    readonly pendingMessages: Container;
    readonly status: Container;
    constructor(ui: TUI, cwd: string);
    apply(snapshot: LaneSnapshot): void;
    refreshTheme(snapshot: LaneSnapshot): void;
    dispose(): void;
}
//# sourceMappingURL=client-tui-chat.d.ts.map