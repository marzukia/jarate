import { type JsonValue, type ServiceCall } from "@earendil-works/chord";
import { type JsonlSessionMetadata, type Session } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import Type, { type Static } from "typebox";
import { type SessionWorkerRuntime, type WorkerServiceScope } from "./services/worker.ts";
export type { SessionWorkerRuntime } from "./services/worker.ts";
export declare const SESSION_WORKER_CONTROL_ADDRESS_ENV = "PI_SESSION_WORKER_CONTROL_ADDRESS";
export declare const SESSION_WORKER_CONTROL_TOKEN_ENV = "PI_SESSION_WORKER_CONTROL_TOKEN";
export declare const SESSION_WORKER_SESSION_KEY_ENV = "PI_SESSION_WORKER_SESSION_KEY_BASE64";
export declare const SESSION_WORKER_PEER_ID_ENV = "PI_SESSION_WORKER_PEER_ID";
export declare const SessionWorkerMetadataSchema: Type.TObject<{
    readonly id: Type.TString;
    readonly createdAt: Type.TInteger;
    readonly storageVersion: Type.TInteger;
    readonly cwd: Type.TString;
    readonly path: Type.TString;
    readonly modifiedAt: Type.TNumber;
    readonly parentSessionId: Type.TOptional<Type.TString>;
}>;
export declare const SessionWorkerOptionsSchema: Type.TObject<{
    readonly sessionDir: Type.TString;
    readonly metadata: Type.TObject<{
        readonly id: Type.TString;
        readonly createdAt: Type.TInteger;
        readonly storageVersion: Type.TInteger;
        readonly cwd: Type.TString;
        readonly path: Type.TString;
        readonly modifiedAt: Type.TNumber;
        readonly parentSessionId: Type.TOptional<Type.TString>;
    }>;
    readonly provider: Type.TOptional<Type.TString>;
    readonly model: Type.TOptional<Type.TString>;
    readonly pluginManifestPaths: Type.TArray<Type.TString>;
}>;
export type SessionWorkerOptions = Static<typeof SessionWorkerOptionsSchema>;
export declare const WorkerOperationScopeSchema: Type.TObject<{
    readonly serverConnectionId: Type.TString;
    readonly attachmentId: Type.TString;
}>;
export type WorkerOperationScope = WorkerServiceScope;
export declare const WorkerOperationRequestSchema: Type.TObject<{
    readonly type: Type.TLiteral<"operation">;
    readonly requestId: Type.TString;
    readonly scope: Type.TObject<{
        readonly serverConnectionId: Type.TString;
        readonly attachmentId: Type.TString;
    }>;
    readonly call: Type.TUnsafe<ServiceCall>;
}>;
export type WorkerOperationRequest = Static<typeof WorkerOperationRequestSchema>;
export declare const WorkerOperationResponseSchema: Type.TUnion<[Type.TObject<{
    readonly type: Type.TLiteral<"operation_result">;
    readonly requestId: Type.TString;
    readonly scope: Type.TObject<{
        readonly serverConnectionId: Type.TString;
        readonly attachmentId: Type.TString;
    }>;
    readonly result: Type.TOptional<Type.TUnsafe<JsonValue>>;
}>, Type.TObject<{
    readonly type: Type.TLiteral<"operation_error">;
    readonly requestId: Type.TString;
    readonly scope: Type.TObject<{
        readonly serverConnectionId: Type.TString;
        readonly attachmentId: Type.TString;
    }>;
    readonly code: Type.TOptional<Type.TUnsafe<"service_instance_not_found" | "service_invalid_value" | "service_member_mismatch" | "service_member_not_found" | "service_mode_mismatch" | "service_not_allowed" | "service_not_found" | "service_stale_instance">>;
    readonly message: Type.TString;
}>]>;
export type WorkerOperationResponse = Static<typeof WorkerOperationResponseSchema>;
export declare const SessionWorkerCommandSchema: Type.TUnion<[Type.TObject<{
    type: Type.TLiteral<"shutdown">;
}>, Type.TObject<{
    type: Type.TLiteral<"discover_workers">;
}>, Type.TObject<{
    type: Type.TLiteral<"session_demand">;
    serverConnectionId: Type.TString;
    requestId: Type.TString;
    attachmentId: Type.TString;
    attached: Type.TBoolean;
}>, Type.TObject<{
    readonly type: Type.TLiteral<"operation">;
    readonly requestId: Type.TString;
    readonly scope: Type.TObject<{
        readonly serverConnectionId: Type.TString;
        readonly attachmentId: Type.TString;
    }>;
    readonly call: Type.TUnsafe<ServiceCall>;
}>, Type.TObject<{
    readonly type: Type.TLiteral<"operation_cancel">;
    readonly requestId: Type.TString;
    readonly scope: Type.TObject<{
        readonly serverConnectionId: Type.TString;
        readonly attachmentId: Type.TString;
    }>;
}>]>;
export type SessionWorkerCommand = Static<typeof SessionWorkerCommandSchema>;
export declare const SessionWorkerEventSchema: Type.TUnion<[Type.TObject<{
    type: Type.TLiteral<"worker_ready">;
    token: Type.TString;
    sessionKey: Type.TString;
    sessionId: Type.TString;
    pid: Type.TInteger;
    metadata: Type.TObject<{
        readonly id: Type.TString;
        readonly createdAt: Type.TInteger;
        readonly storageVersion: Type.TInteger;
        readonly cwd: Type.TString;
        readonly path: Type.TString;
        readonly modifiedAt: Type.TNumber;
        readonly parentSessionId: Type.TOptional<Type.TString>;
    }>;
    pluginManifestPaths: Type.TArray<Type.TString>;
}>, Type.TObject<{
    type: Type.TLiteral<"worker_failed">;
    token: Type.TString;
    sessionKey: Type.TString;
    message: Type.TString;
}>, Type.TObject<{
    type: Type.TLiteral<"demand_applied">;
    token: Type.TString;
    sessionKey: Type.TString;
    requestId: Type.TString;
    attachmentId: Type.TString;
    attached: Type.TBoolean;
}>, Type.TObject<{
    type: Type.TLiteral<"demand_rejected">;
    token: Type.TString;
    sessionKey: Type.TString;
    requestId: Type.TString;
    message: Type.TString;
}>, Type.TObject<{
    type: Type.TLiteral<"operation_response">;
    token: Type.TString;
    sessionKey: Type.TString;
    response: Type.TUnion<[Type.TObject<{
        readonly type: Type.TLiteral<"operation_result">;
        readonly requestId: Type.TString;
        readonly scope: Type.TObject<{
            readonly serverConnectionId: Type.TString;
            readonly attachmentId: Type.TString;
        }>;
        readonly result: Type.TOptional<Type.TUnsafe<JsonValue>>;
    }>, Type.TObject<{
        readonly type: Type.TLiteral<"operation_error">;
        readonly requestId: Type.TString;
        readonly scope: Type.TObject<{
            readonly serverConnectionId: Type.TString;
            readonly attachmentId: Type.TString;
        }>;
        readonly code: Type.TOptional<Type.TUnsafe<"service_instance_not_found" | "service_invalid_value" | "service_member_mismatch" | "service_member_not_found" | "service_mode_mismatch" | "service_not_allowed" | "service_not_found" | "service_stale_instance">>;
        readonly message: Type.TString;
    }>]>;
}>, Type.TObject<{
    type: Type.TLiteral<"service_update">;
    token: Type.TString;
    sessionKey: Type.TString;
    scope: Type.TObject<{
        readonly serverConnectionId: Type.TString;
        readonly attachmentId: Type.TString;
    }>;
    subscriptionId: Type.TString;
    update: Type.TUnknown;
}>]>;
export type SessionWorkerEvent = Static<typeof SessionWorkerEventSchema>;
/** Worker-local reconciliation of server-generation demand and Harness activity. */
export declare class WorkerLifecycle {
    #private;
    constructor(options: {
        initialServerConnectionId?: string;
        initialDemandGraceMs: number;
        orphanDemandGraceMs: number;
        onRetire(): void;
    });
    serverConnected(serverConnectionId: string): void;
    serverDisconnected(serverConnectionId: string): void;
    beginRequest(serverConnectionId: string, attachmentId: string): () => void;
    holdRetirement(): () => void;
    setDemand(serverConnectionId: string, attachmentId: string, attached: boolean): void;
    operationStarted(kind: "run" | "compaction" | "navigation", lane: string, operationId: string): void;
    operationStopped(kind: "run" | "compaction" | "navigation", lane: string, operationId: string): void;
    close(): void;
}
export declare const SESSION_WORKER_INITIAL_DEMAND_GRACE_ENV = "__PI_SESSION_WORKER_INITIAL_DEMAND_GRACE_MS";
export declare const SESSION_WORKER_ORPHAN_DEMAND_GRACE_ENV = "__PI_SESSION_WORKER_ORPHAN_DEMAND_GRACE_MS";
export type CreateSessionWorkerHarness = (session: Session<JsonlSessionMetadata>, options: SessionWorkerOptions, executionEnv: NodeExecutionEnv) => Promise<SessionWorkerRuntime>;
export declare function runSessionWorkerWithHarness(args: readonly string[], createHarness: CreateSessionWorkerHarness): Promise<void>;
export declare function runSessionWorkerProcess(args: readonly string[]): Promise<void>;
//# sourceMappingURL=session-worker.d.ts.map