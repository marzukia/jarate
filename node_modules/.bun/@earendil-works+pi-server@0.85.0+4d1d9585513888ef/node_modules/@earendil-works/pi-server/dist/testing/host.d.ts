import type { JsonValue, ServiceCall } from "@earendil-works/chord";
import type { Context, Session, SessionMetadata } from "@earendil-works/pi-agent-core";
import { MemorySessionRepo } from "@earendil-works/pi-agent-core";
import type { RoutedServerServiceHost, RoutedSessionHandle, ServerHost } from "../types.ts";
export declare class Deferred<T> {
    readonly promise: Promise<T>;
    private resolvePromise;
    constructor();
    resolve(value: T): void;
}
interface OpenGate {
    entered: Deferred<void>;
    release: Deferred<void>;
}
export declare class TestHarness {
    #private;
    readonly session: Session;
    readonly closed: Deferred<void>;
    readonly terminated: Promise<Error | undefined>;
    attachedClients: number;
    attachmentReleaseCount: number;
    closeCount: number;
    readonly serviceCalls: ServiceCall[];
    failAttachmentRelease?: Error;
    failClose?: Error;
    nextServiceError?: Error;
    nextServiceResult: JsonValue | undefined;
    private nextCloseGate?;
    private nextServiceGate?;
    constructor(session: Session);
    attachClient(_context: Context): {
        invokeService: TestHarness["invokeService"];
        release(context: Context): void;
    };
    invokeService(call: ServiceCall): Promise<JsonValue | undefined>;
    close(context: Context): Promise<void>;
    terminate(error: Error): Promise<void>;
    gateNextClose(): OpenGate;
    gateNextServiceCall(): OpenGate;
}
export declare function createTestServerServices(): RoutedServerServiceHost;
export declare class TestServerHost implements ServerHost {
    readonly serverServices: RoutedServerServiceHost;
    readonly repo: MemorySessionRepo;
    readonly harnesses: Map<string, TestHarness[]>;
    openSessionCount: number;
    nextOpenSessionError?: Error;
    nextHarnessCloseError?: Error;
    private nextOpenSessionGate?;
    resolveSession(sessionId: string, context: Context): Promise<SessionMetadata>;
    openSession(metadata: SessionMetadata, context: Context): Promise<RoutedSessionHandle>;
    seed(id?: string, parentSessionId?: string): Promise<SessionMetadata>;
    gateNextOpenSession(): OpenGate;
    latestHarness(id: string): TestHarness;
}
export {};
//# sourceMappingURL=host.d.ts.map