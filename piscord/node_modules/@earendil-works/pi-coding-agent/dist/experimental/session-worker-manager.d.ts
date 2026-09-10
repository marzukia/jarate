import { type Context, type JsonlSessionMetadata } from "@earendil-works/pi-agent-core";
import { type RoutedSessionHandle } from "@earendil-works/pi-server";
import type { CoordinatorConnection } from "./coordinator.ts";
export declare class SessionPluginSelectionConflictError extends Error {
    constructor(message: string);
}
/** Session and process bookkeeping owned by one replaceable server process. */
export declare class SessionWorkerManager {
    #private;
    readonly workerPids: Map<string, number>;
    constructor(coordinator: Pick<CoordinatorConnection, "controlPath" | "serverConnectionId" | "wasReplaced" | "onEvent" | "send" | "broadcast">, sessionDir: string, model?: {
        readonly provider?: string;
        readonly model: string;
    }, onWorkerCountChanged?: (count: number) => void);
    get trackedSessions(): readonly JsonlSessionMetadata[];
    assertSessionPluginManifestPaths(metadata: JsonlSessionMetadata, manifestPaths: readonly string[]): void;
    discover(peerIds: ReadonlySet<string>): Promise<void>;
    openSession(metadata: JsonlSessionMetadata, context: Context, pluginManifestPaths: readonly string[]): Promise<RoutedSessionHandle>;
    closeSession(metadata: JsonlSessionMetadata, context: Context): Promise<void>;
    shutdown(): Promise<void>;
    /** Forget workers without stopping them when this server is replaced. */
    detach(): void;
}
//# sourceMappingURL=session-worker-manager.d.ts.map