import { type ServerHello, type ServerMessage } from "@earendil-works/pi-protocol";
import type { ByteTransportFactory } from "./transport.ts";
import type { ConnectionState, ConnectionStateChange } from "./types.ts";
interface ConnectionOptions {
    transportFactory: ByteTransportFactory;
    serverId: string;
    maxFrameLength?: number;
    onHandshake(hello: ServerHello): void;
    onMessage(message: Exclude<ServerMessage, {
        type: "hello" | "hello_error";
    }>): void;
    onStateChange(change: ConnectionStateChange): void;
}
export declare class Connection {
    #private;
    constructor(options: ConnectionOptions);
    get state(): ConnectionState;
    get maxFrameLength(): number;
    connect(): Promise<ServerHello>;
    disconnect(reason?: string | Error): void;
    fail(error: Error): void;
    send(frame: Uint8Array): void;
}
export {};
//# sourceMappingURL=connection.d.ts.map