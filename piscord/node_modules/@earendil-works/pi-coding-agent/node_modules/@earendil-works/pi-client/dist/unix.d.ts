import { type ServerId } from "@earendil-works/pi-protocol";
import type { ByteTransportFactory } from "./transport.ts";
export interface UnixTransportOptions {
    path: string;
    maxPendingBytes?: number;
}
export interface UnixServerRoute {
    serverId: ServerId;
    path: string;
}
export interface DiscoverUnixServersOptions {
    /** Directory containing server-addressed Unix sockets. */
    directory: string;
    /** Maximum time for each connection and handshake. Defaults to 1,000 ms. */
    timeoutMs?: number;
}
/** Discover reachable local servers by probing server-addressed Unix sockets. */
export declare function discoverUnixServers(options: DiscoverUnixServersOptions): Promise<UnixServerRoute[]>;
/** Creates fresh Unix-domain socket transports for Client connection attempts in Node-compatible runtimes. */
export declare function createUnixTransportFactory(options: UnixTransportOptions): ByteTransportFactory;
//# sourceMappingURL=unix.d.ts.map