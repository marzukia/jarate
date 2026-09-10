import { type SessionMetadata } from "@earendil-works/pi-agent-core";
import { type ByteConnection, type ByteConnectionHandler } from "./connection.ts";
import type { ServerHost, ServerOptions } from "./types.ts";
export declare class Server<TMetadata extends SessionMetadata = SessionMetadata> {
    readonly serverId: string;
    /** Resolves after shutdown, or rejects when listener or routed-Session cleanup fails. */
    readonly closed: Promise<void>;
    private readonly host;
    private readonly listeners;
    private readonly maxFrameLength;
    private readonly handshakeTimeoutMs;
    private readonly onConnectionCountChanged;
    private readonly onError;
    private readonly connections;
    private readonly sessions;
    private closing;
    private closePromise?;
    private closedSettled;
    private rejectClosed;
    private resolveClosed;
    private startPromise?;
    private started;
    constructor(host: ServerHost<TMetadata>, options: ServerOptions);
    start(): Promise<this>;
    private startInternal;
    accept(connection: ByteConnection): ByteConnectionHandler;
    close(): Promise<void>;
    private closeInternal;
    private receive;
    private dispatchMessage;
    private finishHandshake;
    private handleCancel;
    private handleRequest;
    private transportClosed;
    private disconnect;
    private sendServiceUpdate;
    private sendMessage;
    private failProtocol;
    private closeServerState;
    private closeConnection;
    private toProtocolError;
    private notifyConnectionCountChanged;
    private reportError;
    private settleClosed;
}
//# sourceMappingURL=server.d.ts.map