export declare const COORDINATOR_PROTOCOL_VERSION = 3;
export type CoordinatorConnectionEvent = {
    readonly type: "peer_connected";
    readonly peerId: string;
} | {
    readonly type: "peer_disconnected";
    readonly peerId: string;
} | {
    readonly type: "message";
    readonly from: string;
    readonly payload: unknown;
};
export interface CoordinatorConnectionOptions {
    readonly controlPath: string;
    readonly endpoint: string;
    readonly serverConnectionId?: string;
}
/** The server-side endpoint of the coordinator's intentionally opaque message router. */
export declare class CoordinatorConnection {
    #private;
    readonly serverConnectionId: string;
    readonly replaced: Promise<void>;
    readonly peerIds: Set<string>;
    constructor(options: CoordinatorConnectionOptions);
    get controlPath(): string;
    get wasReplaced(): boolean;
    onEvent(listener: (event: CoordinatorConnectionEvent) => void): () => void;
    connect(): Promise<void>;
    send(peerId: string, payload: unknown): Promise<void>;
    broadcast(payload: unknown): Promise<void>;
    close(): void;
}
export interface CoordinatorStartupLease {
    close(): void;
}
export declare function ensureCoordinator(publicPath: string, controlPath: string): Promise<CoordinatorStartupLease>;
export declare function runCoordinatorProcess(args: readonly string[]): Promise<void>;
//# sourceMappingURL=coordinator.d.ts.map