/**
 * Pluggable transport: newline-delimited JSON over any duplex pair.
 *
 * `Connection` is the shared abstraction and every host uses it. `Transport` is only for hops that
 * have an address to negotiate: the unix socket between presentations and the server. A spawned
 * worker needs none, because the pipes exist before it does.
 */
export interface Connection {
    send(message: unknown): void;
    onMessage(handler: (message: unknown) => void): void;
    onClose(handler: () => void): void;
    close(): void;
}
export interface Listener {
    close(): Promise<void>;
}
export interface Transport {
    listen(onConnection: (connection: Connection) => void): Promise<Listener>;
    connect(): Promise<Connection>;
}
/** Frame JSON messages as one line each over a readable/writable pair. */
export declare function jsonConnection(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, close: () => void): Connection;
/**
 * A spawned child is connected at birth, so there is no address to dial and no `Transport`: the
 * parent reads the child's stdout and writes its stdin, and the child sees the same pipes reversed.
 */
export declare function childConnection(child: {
    stdin: NodeJS.WritableStream | null;
    stdout: NodeJS.ReadableStream | null;
    kill(): unknown;
}): Connection;
/** The child's own view of the pipes its parent created. */
export declare function parentConnection(): Connection;
export declare function socketTransport(path: string): Transport;
//# sourceMappingURL=transport.d.ts.map