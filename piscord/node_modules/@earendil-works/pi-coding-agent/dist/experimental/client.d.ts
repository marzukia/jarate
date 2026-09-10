import { type LaneWatchEvent } from "@earendil-works/pi-agent-core";
import type { ClientCommand } from "../cli/experimental/commands/client.ts";
import type { SessionAddress } from "./services/sessions.ts";
export type ClientResult = {
    readonly kind: "list";
    readonly sessions: readonly SessionAddress[];
} | {
    readonly kind: "attached";
    readonly serverId: string;
    readonly sessionId: string;
} | {
    readonly kind: "prompted";
    readonly serverId: string;
    readonly sessionId: string;
    readonly text: string;
};
export interface RunClientOptions {
    /** Directory searched when --connect is omitted. Defaults to PI_SERVER_DIR or ~/.pi/server. */
    readonly directory?: string;
    /** Receives snapshot-ordered main-lane events while a prompt is active. */
    readonly onEvent?: (event: LaneWatchEvent) => void | Promise<void>;
}
/** Discover servers, then list Sessions, attach to one, or create one for a prompt. */
export declare function runClient(command: ClientCommand, options?: RunClientOptions): Promise<ClientResult>;
//# sourceMappingURL=client.d.ts.map