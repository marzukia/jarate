/**
 * Pluggable transport: newline-delimited JSON over any duplex pair.
 *
 * `Connection` is the shared abstraction and every host uses it. `Transport` is only for hops that
 * have an address to negotiate: the unix socket between presentations and the server. A spawned
 * worker needs none, because the pipes exist before it does.
 */
import { rm } from "node:fs/promises";
import { createConnection as connectSocket, createServer } from "node:net";
/** Frame JSON messages as one line each over a readable/writable pair. */
export function jsonConnection(input, output, close) {
    const messageHandlers = [];
    const closeHandlers = [];
    let buffered = "";
    let closed = false;
    const notifyClosed = () => {
        if (closed)
            return;
        closed = true;
        for (const handler of closeHandlers)
            handler();
    };
    input.setEncoding("utf8");
    input.on("data", (chunk) => {
        buffered += chunk;
        let newline = buffered.indexOf("\n");
        while (newline !== -1) {
            const line = buffered.slice(0, newline);
            buffered = buffered.slice(newline + 1);
            if (line.length > 0) {
                const message = JSON.parse(line);
                for (const handler of messageHandlers)
                    handler(message);
            }
            newline = buffered.indexOf("\n");
        }
    });
    input.on("end", notifyClosed);
    input.on("error", notifyClosed);
    output.on("error", notifyClosed);
    return {
        send: (message) => {
            if (!closed)
                output.write(`${JSON.stringify(message)}\n`);
        },
        onMessage: (handler) => messageHandlers.push(handler),
        onClose: (handler) => closeHandlers.push(handler),
        close: () => {
            notifyClosed();
            close();
        },
    };
}
function socketConnection(socket) {
    return jsonConnection(socket, socket, () => socket.destroy());
}
/**
 * A spawned child is connected at birth, so there is no address to dial and no `Transport`: the
 * parent reads the child's stdout and writes its stdin, and the child sees the same pipes reversed.
 */
export function childConnection(child) {
    if (!child.stdin || !child.stdout)
        throw new Error("Child process was spawned without pipes");
    return jsonConnection(child.stdout, child.stdin, () => child.kill());
}
/** The child's own view of the pipes its parent created. */
export function parentConnection() {
    return jsonConnection(process.stdin, process.stdout, () => process.stdin.pause());
}
export function socketTransport(path) {
    return {
        async listen(onConnection) {
            await rm(path, { force: true });
            const server = createServer((socket) => onConnection(socketConnection(socket)));
            await new Promise((resolve, reject) => {
                server.once("error", reject);
                server.listen(path, resolve);
            });
            return {
                close: () => new Promise((resolve) => {
                    server.close(() => resolve());
                }),
            };
        },
        connect() {
            return new Promise((resolve, reject) => {
                const socket = connectSocket(path);
                socket.once("connect", () => resolve(socketConnection(socket)));
                socket.once("error", reject);
            });
        },
    };
}
//# sourceMappingURL=transport.js.map