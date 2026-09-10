import { type Context, type RemoteServiceSource, type ReplicatedState } from "@earendil-works/chord";
import { type Client } from "@earendil-works/pi-client";
export type ServerConnectionState = {
    status: "connecting";
    attempt: number;
} | {
    status: "connected";
    since: string;
} | {
    status: "disconnected";
    since: string;
    reason: string;
    retryAt: string | null;
};
export type SessionAttachmentState = {
    status: "detached";
} | {
    status: "attaching" | "attached" | "degraded";
    sessionId: string;
};
export interface ServerServiceSource extends RemoteServiceSource {
    readonly connection: ReplicatedState<ServerConnectionState>;
    dispose(context: Context): Promise<void>;
}
export interface SessionServiceSource extends RemoteServiceSource {
    readonly attachment: ReplicatedState<SessionAttachmentState>;
    /** Wait for the exact current attachment generation to finish hydrating. */
    whenAttached(sessionId: string, context: Context): Promise<void>;
    /** Wait for every binding to finish releasing the previous attachment. */
    whenDetached(context: Context): Promise<void>;
    dispose(context: Context): Promise<void>;
}
export interface ServiceSourceOptions {
    readonly onError?: (error: Error) => void;
}
/** Create the server-scoped remote service source for one presentation client. */
export declare function createServerServiceSource(client: Client, options?: ServiceSourceOptions): ServerServiceSource;
/** Create the selected-Session remote service source for one presentation client. */
export declare function createSessionServiceSource(client: Client, options?: ServiceSourceOptions): SessionServiceSource;
//# sourceMappingURL=connection.d.ts.map