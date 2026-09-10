import type { JsonValue, ServiceCall, ServiceProviderUpdate } from "@earendil-works/chord";
import { type Context, type SessionMetadata } from "@earendil-works/pi-agent-core";
import type { RpcTarget, SessionTarget } from "@earendil-works/pi-protocol";
import type { ServerHost } from "./types.ts";
interface SessionRouterOptions<TMetadata extends SessionMetadata> {
    host: ServerHost<TMetadata>;
    serverId: string;
    isClosing: () => boolean;
    publishAttachment(client: object, attachment: SessionTarget | undefined, context: Context): Promise<void>;
    reportError: (error: unknown) => void;
}
export declare class SessionRouter<TMetadata extends SessionMetadata = SessionMetadata> {
    private readonly options;
    private readonly hostedSessions;
    private readonly openingSessions;
    private readonly attachmentsByClient;
    private readonly disconnectedClients;
    private readonly clientOperations;
    private closePromise?;
    constructor(options: SessionRouterOptions<TMetadata>);
    executeServiceCall(call: ServiceCall, target: RpcTarget, client: object, publish: (subscriptionId: string, update: ServiceProviderUpdate, context: Context) => Promise<void>, context: Context): Promise<JsonValue | undefined>;
    attachClient(client: object, sessionId: string, context: Context): Promise<void>;
    detachClient(client: object, context: Context): Promise<void>;
    removeSession(sessionId: string, context: Context): Promise<void>;
    disconnect(client: object, context: Context): Promise<void>;
    close(context: Context): Promise<void>;
    private closeInternal;
    private runForClient;
    private attachClientNow;
    private startServiceCall;
    private trackOperation;
    private requireAttachment;
    private releaseAttachment;
    private clearAttachment;
    private acquire;
    private open;
    private invalidate;
}
export {};
//# sourceMappingURL=session-router.d.ts.map