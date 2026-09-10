import { type Context, type ReplicatedState } from "@earendil-works/chord";
import type { ServerId } from "@earendil-works/pi-protocol";
export interface SessionAddress {
    serverId: ServerId;
    sessionId: string;
}
export interface SessionSummary extends SessionAddress {
    createdAt: number;
}
export interface SessionCreateOptions {
    id?: string;
}
export interface SessionDirectoryState {
    revision: number;
    sessions: SessionSummary[];
}
export interface SessionDirectory {
    readonly state: ReplicatedState<SessionDirectoryState>;
}
export declare const SessionDirectory: import("@earendil-works/chord").Service<SessionDirectory>;
export interface SessionManagement {
    create(options: SessionCreateOptions, context: Context): Promise<SessionSummary>;
    remove(sessionId: string, context: Context): Promise<void>;
    attach(sessionId: string, context: Context): Promise<void>;
    detach(context: Context): Promise<void>;
}
export declare const SessionManagement: import("@earendil-works/chord").Service<SessionManagement>;
//# sourceMappingURL=sessions.d.ts.map