import { Server } from "../server.js";
import { TestServerHost } from "./host.js";
/** Create an unstarted Server with deterministic defaults for transport conformance tests. */
export function createTestServer(options) {
    const host = options.host ?? new TestServerHost();
    return {
        server: new Server(host, {
            listeners: options.listeners,
            maxFrameLength: options.maxFrameLength,
            handshakeTimeoutMs: options.handshakeTimeoutMs,
            serverId: options.serverId ?? "00000000-0000-4000-8000-000000000001",
            onError: options.onError,
        }),
        host,
    };
}
//# sourceMappingURL=server.js.map