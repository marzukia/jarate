/**
 * Session server: accepts client connections, spawns one worker process per session, routes.
 *
 * It provides `Sessions` and holds no agent state. Any other service name is forwarded to the worker
 * the calling client is attached to, and every worker event is pushed back to that worker's clients.
 * Workers reach `Sessions` over the same peer, because the routing rule is symmetric.
 */
import { spawn } from "node:child_process";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
// Narrow entries: the server routes and lists sessions, it never runs an agent.
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/harness/env/nodejs";
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core/harness/session";
import { Sessions, Worker } from "../shared/protocol.js";
import { createPeer } from "../shared/rpc.js";
import { childConnection } from "../shared/transport.js";
const SELF_EXTENSION = extname(fileURLToPath(import.meta.url));
const WORKER_ENTRY = fileURLToPath(new URL(`../worker/entry${SELF_EXTENSION}`, import.meta.url));
const WORKER_START_TIMEOUT_MS = 30_000;
/** Grace period before an idle server retires, so a reconnecting presentation does not race it. */
const IDLE_SHUTDOWN_MS = 10_000;
async function listSessions(sessionsRoot) {
    const executionEnv = new NodeExecutionEnv({ cwd: process.cwd() });
    const repo = new JsonlSessionRepo({ fileSystem: executionEnv, sessionsRoot });
    try {
        return (await repo.list(undefined, BACKGROUND_CONTEXT)).map((metadata) => ({
            id: metadata.id,
            path: metadata.path,
            cwd: metadata.cwd,
            createdAt: metadata.createdAt,
        }));
    }
    finally {
        await repo.close(BACKGROUND_CONTEXT);
        await executionEnv.cleanup(BACKGROUND_CONTEXT);
    }
}
export async function runServer(options) {
    const routes = new Map();
    let presentations = 0;
    let retire = () => { };
    const retired = new Promise((resolve) => {
        retire = resolve;
    });
    let idleTimer;
    /** Nothing to serve and nothing running: leave, so the next start always gets current code. */
    const considerRetiring = () => {
        if (idleTimer)
            clearTimeout(idleTimer);
        if (presentations > 0 || routes.size > 0)
            return;
        idleTimer = setTimeout(() => {
            if (presentations === 0 && routes.size === 0)
                retire();
        }, IDLE_SHUTDOWN_MS);
        idleTimer.unref();
    };
    /** Concurrent attaches to one session must share a worker: two writers would corrupt the session. */
    const spawning = new Map();
    const spawnWorker = async (sessionId, cwd) => {
        const args = [...process.execArgv, WORKER_ENTRY, options.sessionsRoot, cwd, ...(sessionId ? [sessionId] : [])];
        const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "inherit"] });
        const connection = childConnection(child);
        const peer = createPeer(connection);
        // Workers consume `Sessions` through this same peer.
        peer.provide(Sessions, { list, attach: attachUnsupported });
        // A worker that never answers must not wedge the attach that spawned it.
        const described = await peer.use(Worker, { timeoutMs: WORKER_START_TIMEOUT_MS }).describe();
        const route = {
            sessionId: described.sessionId,
            worker: peer,
            subscribers: new Map(),
            stop: () => child.kill(),
        };
        // Routing is the server's job. An addressed event reaches one presentation; the rest are shared.
        peer.onEvent((service, payload, to) => {
            if (to !== undefined) {
                route.subscribers.get(to)?.emitRaw(service, payload);
                return;
            }
            for (const subscriber of route.subscribers.values())
                subscriber.emitRaw(service, payload);
        });
        peer.onClose(() => {
            routes.delete(route.sessionId);
            considerRetiring();
        });
        routes.set(route.sessionId, route);
        return route;
    };
    const ensureRoute = (sessionId, cwd) => {
        if (sessionId === null)
            return spawnWorker(undefined, cwd);
        const existing = routes.get(sessionId);
        if (existing)
            return Promise.resolve(existing);
        const pending = spawning.get(sessionId);
        if (pending)
            return pending;
        const started = spawnWorker(sessionId, cwd).finally(() => spawning.delete(sessionId));
        spawning.set(sessionId, started);
        return started;
    };
    const list = () => listSessions(options.sessionsRoot);
    const attachUnsupported = async () => {
        throw new Error("Only presentations attach to sessions");
    };
    const listener = await options.transport.listen((connection) => {
        presentations += 1;
        let route;
        let attachedAs;
        const sessions = {
            list,
            attach: async (sessionId, cwd, presentationId) => {
                route?.subscribers.delete(attachedAs ?? "");
                attachedAs = presentationId;
                route = await ensureRoute(sessionId, cwd);
                route.subscribers.set(presentationId, presentation);
                return route.sessionId;
            },
        };
        const presentation = createPeer(connection, {
            forward: (method, args) => {
                if (!route)
                    throw new Error("Not attached to a session");
                const service = method.slice(0, method.indexOf("."));
                if (!route.worker.announced.has(service)) {
                    throw new Error(`No host provides ${service}: server has [${[...presentation.provided]}], worker has [${[...route.worker.announced]}]`);
                }
                return route.worker.call(method, ...args);
            },
        });
        presentation.provide(Sessions, sessions);
        connection.onClose(() => {
            presentations -= 1;
            if (route && attachedAs !== undefined) {
                route.subscribers.delete(attachedAs);
                // One worker per session, kept alive only while someone is looking at it.
                if (route.subscribers.size === 0)
                    route.stop();
            }
            considerRetiring();
        });
    });
    considerRetiring();
    await retired;
    await listener.close();
}
//# sourceMappingURL=run.js.map