import { Server } from "../../server.js";
import { createUnixListener } from "./listener.js";
/** Compose Server with one Unix-domain socket listener. */
export function createUnixServer(host, options) {
    const listener = createUnixListener({
        path: options.path,
        mode: options.mode,
        maxFrameLength: options.maxFrameLength,
        maxPendingBytes: options.maxPendingBytes,
        gracefulCloseTimeoutMs: options.gracefulCloseTimeoutMs,
        onError: options.onError,
    });
    return new Server(host, {
        listeners: [listener],
        maxFrameLength: options.maxFrameLength,
        handshakeTimeoutMs: options.handshakeTimeoutMs,
        onConnectionCountChanged: options.onConnectionCountChanged,
        serverId: options.serverId,
        onError: options.onError,
    });
}
//# sourceMappingURL=preset.js.map