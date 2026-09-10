import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { createServiceUnsubscribeCall, decodeServiceControlCall, parseServiceProviderUpdate, } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, TODO_CONTEXT, } from "@earendil-works/pi-agent-core";
import { ServerError } from "@earendil-works/pi-server";
import { Check } from "typebox/value";
import { spawnInternalProcess } from "./process.js";
import { SESSION_WORKER_CONTROL_ADDRESS_ENV, SESSION_WORKER_CONTROL_TOKEN_ENV, SESSION_WORKER_PEER_ID_ENV, SESSION_WORKER_SESSION_KEY_ENV, SessionWorkerEventSchema, } from "./session-worker.js";
const WORKER_STARTUP_TIMEOUT_MS = 15_000;
const WORKER_SHUTDOWN_TIMEOUT_MS = 10_000;
const WORKER_DISCOVERY_TIMEOUT_MS = 5_000;
const WORKER_DEMAND_TIMEOUT_MS = 5_000;
export class SessionPluginSelectionConflictError extends Error {
    constructor(message) {
        super(message);
        this.name = "SessionPluginSelectionConflictError";
    }
}
/** Session and process bookkeeping owned by one replaceable server process. */
export class SessionWorkerManager {
    workerPids = new Map();
    #coordinator;
    #sessionDir;
    #model;
    #workersBySession = new Map();
    #workersByPeer = new Map();
    #pending = new Map();
    #pendingDemand = new Map();
    #pendingOperations = new Map();
    #serviceSubscriptions = new Map();
    #removeListener;
    #onWorkerCountChanged;
    #discoveryPeers;
    #resolveDiscovery;
    #detached = false;
    #shuttingDown = false;
    constructor(coordinator, sessionDir, model, onWorkerCountChanged) {
        this.#coordinator = coordinator;
        this.#sessionDir = sessionDir;
        this.#model = model;
        this.#onWorkerCountChanged = onWorkerCountChanged;
        this.#removeListener = coordinator.onEvent((event) => this.#handleCoordinatorEvent(event));
    }
    get trackedSessions() {
        return [...this.#workersBySession.values()].map((worker) => worker.metadata);
    }
    assertSessionPluginManifestPaths(metadata, manifestPaths) {
        const existing = this.#workersBySession.get(metadata.path);
        if (existing !== undefined && !sameStrings(existing.pluginManifestPaths, manifestPaths)) {
            throw new SessionPluginSelectionConflictError(`Session ${metadata.id} is active with a different plugin selection`);
        }
        const pending = this.#pending.get(metadata.path);
        if (pending !== undefined && !sameStrings(pending.pluginManifestPaths, manifestPaths)) {
            throw new SessionPluginSelectionConflictError(`Session ${metadata.id} is starting with a different plugin selection`);
        }
    }
    async discover(peerIds) {
        if (this.#detached)
            return;
        const undiscovered = new Set([...peerIds].filter((peerId) => !this.#workersByPeer.has(peerId) && !this.#pendingPeer(peerId)));
        if (undiscovered.size === 0)
            return;
        this.#discoveryPeers = undiscovered;
        const discovered = new Promise((resolve) => {
            this.#resolveDiscovery = resolve;
        });
        await this.#coordinator.broadcast({ type: "discover_workers" });
        let timer;
        await Promise.race([
            discovered,
            new Promise((resolve) => {
                timer = setTimeout(resolve, WORKER_DISCOVERY_TIMEOUT_MS);
                timer.unref();
            }),
        ]);
        if (timer)
            clearTimeout(timer);
        this.#discoveryPeers = undefined;
        this.#resolveDiscovery = undefined;
    }
    async openSession(metadata, context, pluginManifestPaths) {
        if (this.#detached || this.#shuttingDown)
            throw new Error("Experimental server is shutting down");
        this.assertSessionPluginManifestPaths(metadata, pluginManifestPaths);
        const existing = this.#workersBySession.get(metadata.path);
        if (existing)
            return this.#routedHandle(existing);
        const pending = this.#pending.get(metadata.path);
        if (pending)
            return this.#routedHandle(await pending.promise);
        return this.#routedHandle(await this.#launch(metadata, context, pluginManifestPaths));
    }
    async closeSession(metadata, context) {
        const worker = this.#workersBySession.get(metadata.path) ?? (await this.#pending.get(metadata.path)?.promise);
        if (worker !== undefined)
            await this.#stopWorker(worker, context);
    }
    #routedHandle(worker) {
        return {
            terminated: worker.terminated,
            attachClient: (context) => this.#attachClient(worker, context),
            close: (context) => this.#stopWorker(worker, context),
        };
    }
    async #attachClient(worker, context) {
        if (this.#detached || this.#shuttingDown || worker.stopping) {
            throw new Error("Experimental Session worker is stopping");
        }
        if (this.#workersByPeer.get(worker.peerId) !== worker) {
            throw new Error("Experimental Session worker is no longer available");
        }
        const attachmentId = randomUUID();
        worker.attachmentIds.add(attachmentId);
        try {
            await this.#applyDemand(worker, attachmentId, true, true, context);
        }
        catch (error) {
            worker.attachmentIds.delete(attachmentId);
            throw error;
        }
        const scope = this.#operationScope(worker, attachmentId);
        let released = false;
        return {
            invokeService: (call, publish, serviceContext) => this.#invokeService(worker, scope, call, publish, serviceContext),
            release: async (releaseContext) => {
                if (released)
                    return;
                released = true;
                if (this.#detached || !worker.attachmentIds.has(attachmentId))
                    return;
                try {
                    await this.#applyDemand(worker, attachmentId, false, true, releaseContext);
                }
                catch (error) {
                    if (!this.#detached && !this.#coordinator.wasReplaced)
                        throw error;
                }
                finally {
                    worker.attachmentIds.delete(attachmentId);
                    this.#removeServiceSubscriptions((entry) => entry.worker === worker && sameScope(entry.scope, scope));
                }
            },
        };
    }
    async #invokeService(worker, scope, call, publish, context) {
        const control = decodeServiceControlCall(call);
        let addedSubscriptionKey;
        if (control?.type === "subscribe") {
            const key = scopedServiceSubscriptionKey(scope, control.subscriptionId);
            if (this.#serviceSubscriptions.has(key))
                throw new Error("Service subscription ID is already active");
            this.#serviceSubscriptions.set(key, {
                worker,
                scope,
                listener: (update, updateContext) => publish(control.subscriptionId, update, updateContext),
                deliveryTail: Promise.resolve(),
            });
            addedSubscriptionKey = key;
        }
        let response;
        try {
            response = await this.#invoke(worker, scope, call, context);
        }
        catch (error) {
            if (addedSubscriptionKey !== undefined && control?.type === "subscribe") {
                this.#serviceSubscriptions.delete(addedSubscriptionKey);
                void this.#invoke(worker, scope, createServiceUnsubscribeCall(control.subscriptionId), BACKGROUND_CONTEXT).catch(() => { });
            }
            throw error;
        }
        if (control?.type === "unsubscribe") {
            this.#serviceSubscriptions.delete(scopedServiceSubscriptionKey(scope, control.subscriptionId));
        }
        return response;
    }
    async #applyDemand(worker, attachmentId, attached, compensateOnTimeout, _context) {
        if (worker.stopping || this.#workersByPeer.get(worker.peerId) !== worker) {
            throw new Error("Experimental Session worker is stopping");
        }
        const requestId = randomUUID();
        let resolve;
        let reject;
        const applied = new Promise((resolvePromise, rejectPromise) => {
            resolve = resolvePromise;
            reject = rejectPromise;
        });
        const timer = setTimeout(() => {
            if (compensateOnTimeout)
                void this.#reconcileDemandTimeout(requestId);
            else
                this.#rejectDemand(requestId, new Error("Session worker demand update timed out"));
        }, WORKER_DEMAND_TIMEOUT_MS);
        timer.unref();
        const pending = { attachmentId, attached, requestId, timer, worker, resolve, reject };
        this.#pendingDemand.set(requestId, pending);
        try {
            await this.#coordinator.send(worker.peerId, {
                type: "session_demand",
                serverConnectionId: this.#coordinator.serverConnectionId,
                requestId,
                attachmentId,
                attached,
            });
        }
        catch (error) {
            this.#rejectDemand(requestId, error instanceof Error ? error : new Error(String(error)));
        }
        return applied;
    }
    /** Worker operations have no wall-clock timeout: completion, disconnect, replacement, or shutdown settles them. */
    #invoke(worker, scope, call, context) {
        try {
            this.#operationScope(worker, scope.attachmentId);
        }
        catch (error) {
            return Promise.reject(error);
        }
        if (context.abortSignal?.aborted)
            return Promise.reject(abortError(context.abortSignal));
        const requestId = randomUUID();
        let resolve;
        let reject;
        const result = new Promise((resolvePromise, rejectPromise) => {
            resolve = resolvePromise;
            reject = rejectPromise;
        });
        const signal = context.abortSignal;
        const onAbort = () => {
            if (signal === undefined || !this.#pendingOperations.has(requestId))
                return;
            void this.#coordinator.send(worker.peerId, { type: "operation_cancel", requestId, scope }).catch(() => { });
            this.#rejectOperation(requestId, abortError(signal));
        };
        if (signal !== undefined)
            signal.addEventListener("abort", onAbort, { once: true });
        this.#pendingOperations.set(requestId, {
            worker,
            scope,
            cleanup: () => signal?.removeEventListener("abort", onAbort),
            resolve,
            reject,
        });
        void this.#coordinator
            .send(worker.peerId, { type: "operation", requestId, scope, call })
            .catch((error) => this.#rejectOperation(requestId, error instanceof Error ? error : new Error(String(error))));
        return result;
    }
    #operationScope(worker, attachmentId) {
        if (this.#detached || this.#shuttingDown || worker.stopping) {
            throw new Error("Experimental Session worker is stopping");
        }
        if (this.#workersByPeer.get(worker.peerId) !== worker || !worker.attachmentIds.has(attachmentId)) {
            throw new Error("Experimental Session worker has no active attachment");
        }
        return {
            serverConnectionId: this.#coordinator.serverConnectionId,
            attachmentId,
        };
    }
    #stopWorker(worker, _context) {
        if (this.#detached || this.#workersByPeer.get(worker.peerId) !== worker)
            return Promise.resolve();
        worker.stopPromise ??= this.#stopWorkerInternal(worker);
        return worker.stopPromise;
    }
    async #stopWorkerInternal(worker) {
        this.#rejectWorkerOperations(worker, new Error("Session worker is stopping"));
        worker.stopping = true;
        worker.expectedStop = true;
        void this.#coordinator.send(worker.peerId, { type: "shutdown" }).catch(() => { });
        let timer;
        const timedOut = new Promise((resolve) => {
            timer = setTimeout(() => resolve(true), WORKER_SHUTDOWN_TIMEOUT_MS);
            timer.unref();
        });
        try {
            if ((await Promise.race([worker.terminated.then(() => false), timedOut])) === true) {
                try {
                    process.kill(worker.pid, "SIGKILL");
                }
                catch (error) {
                    if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
                        throw error;
                }
                this.#removeWorker(worker, undefined);
                await worker.terminated;
            }
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }
    async shutdown() {
        if (this.#detached || this.#shuttingDown)
            return;
        this.#shuttingDown = true;
        const pendingWorkers = [...this.#pending.values()];
        for (const pending of pendingWorkers) {
            void this.#coordinator.send(pending.peerId, { type: "shutdown" }).catch(() => { });
        }
        const pendingFinished = Promise.all(pendingWorkers.map((pending) => {
            if (pending.child.exitCode !== null || pending.child.signalCode !== null)
                return Promise.resolve();
            return new Promise((resolve) => pending.child.once("exit", () => resolve()));
        })).then(() => undefined);
        let timer;
        const pendingTimedOut = new Promise((resolve) => {
            timer = setTimeout(() => resolve(true), WORKER_SHUTDOWN_TIMEOUT_MS);
            timer.unref();
        });
        const stopPending = (async () => {
            if ((await Promise.race([pendingFinished.then(() => false), pendingTimedOut])) === true) {
                for (const pending of pendingWorkers)
                    pending.child.kill("SIGKILL");
                await pendingFinished;
            }
            if (timer)
                clearTimeout(timer);
        })();
        await Promise.all([
            stopPending,
            ...[...this.#workersBySession.values()].map((worker) => this.#stopWorker(worker, BACKGROUND_CONTEXT)),
        ]);
        this.#detachState();
    }
    /** Forget workers without stopping them when this server is replaced. */
    detach() {
        if (this.#detached)
            return;
        this.#detached = true;
        for (const pending of this.#pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error("Experimental server was replaced"));
        }
        for (const requestId of [...this.#pendingOperations.keys()]) {
            this.#rejectOperation(requestId, new Error("Experimental server was replaced during a worker operation"));
        }
        this.#detachState();
    }
    #launch(metadata, _context, pluginManifestPaths) {
        const sessionKey = metadata.path;
        const peerId = `worker-${randomUUID()}`;
        const token = randomUUID();
        let child;
        try {
            const options = {
                sessionDir: this.#sessionDir,
                metadata: {
                    id: metadata.id,
                    createdAt: metadata.createdAt,
                    storageVersion: metadata.storageVersion,
                    cwd: metadata.cwd,
                    path: metadata.path,
                    modifiedAt: metadata.modifiedAt,
                    ...(metadata.parentSessionId === undefined ? {} : { parentSessionId: metadata.parentSessionId }),
                },
                pluginManifestPaths: [...pluginManifestPaths],
                ...(this.#model ?? {}),
            };
            child = spawnInternalProcess("session-worker", [JSON.stringify(options)], {
                env: {
                    [SESSION_WORKER_CONTROL_ADDRESS_ENV]: this.#coordinator.controlPath,
                    [SESSION_WORKER_CONTROL_TOKEN_ENV]: token,
                    [SESSION_WORKER_SESSION_KEY_ENV]: Buffer.from(sessionKey).toString("base64url"),
                    [SESSION_WORKER_PEER_ID_ENV]: peerId,
                },
            });
        }
        catch (error) {
            return Promise.reject(error);
        }
        let resolve;
        let reject;
        const promise = new Promise((resolvePromise, rejectPromise) => {
            resolve = resolvePromise;
            reject = rejectPromise;
        });
        const timer = setTimeout(() => this.#failPending(sessionKey, new Error("Session worker startup timed out")), WORKER_STARTUP_TIMEOUT_MS);
        timer.unref();
        const pending = {
            sessionKey,
            peerId,
            token,
            pluginManifestPaths: Object.freeze([...pluginManifestPaths]),
            child,
            timer,
            promise,
            resolve,
            reject,
        };
        this.#pending.set(sessionKey, pending);
        this.#notifyWorkerCountChanged();
        child.once("error", (error) => this.#failPending(sessionKey, error));
        child.once("exit", (code, signal) => this.#childExited(pending, code, signal));
        return promise;
    }
    #handleCoordinatorEvent(event) {
        if (this.#detached)
            return;
        if (event.type === "peer_disconnected") {
            this.#markDiscovered(event.peerId);
            const worker = this.#workersByPeer.get(event.peerId);
            if (worker) {
                this.#removeWorker(worker, worker.expectedStop
                    ? undefined
                    : new Error(`Session worker ${worker.metadata.id} disconnected unexpectedly`));
            }
            const pending = this.#pendingPeer(event.peerId);
            if (pending)
                this.#failPending(pending.sessionKey, new Error("Session worker disconnected during startup"));
            return;
        }
        if (event.type !== "message")
            return;
        if (!Check(SessionWorkerEventSchema, event.payload)) {
            if (typeof event.payload === "object" &&
                event.payload !== null &&
                "type" in event.payload &&
                event.payload.type === "operation_response") {
                const worker = this.#workersByPeer.get(event.from);
                if (worker)
                    this.#rejectWorkerOperations(worker, new Error("Session worker returned an invalid operation response"));
            }
            return;
        }
        const message = event.payload;
        if (message.type === "worker_failed") {
            const pending = this.#pending.get(message.sessionKey);
            if (pending?.peerId === event.from && pending.token === message.token) {
                this.#failPending(message.sessionKey, new Error(`Session worker failed: ${message.message}`));
            }
            return;
        }
        if (message.type === "demand_applied" || message.type === "demand_rejected") {
            const pending = this.#pendingDemand.get(message.requestId);
            if (!pending ||
                pending.worker.peerId !== event.from ||
                pending.worker.token !== message.token ||
                pending.worker.metadata.path !== message.sessionKey ||
                (message.type === "demand_applied" &&
                    (pending.attachmentId !== message.attachmentId || pending.attached !== message.attached))) {
                return;
            }
            this.#pendingDemand.delete(message.requestId);
            clearTimeout(pending.timer);
            if (message.type === "demand_applied")
                pending.resolve();
            else
                pending.reject(new Error(`Session worker rejected demand: ${message.message}`));
            return;
        }
        if (message.type === "operation_response") {
            this.#handleOperationResponse(event.from, message.token, message.sessionKey, message.response);
            return;
        }
        if (message.type === "service_update") {
            this.#handleServiceEvent(event.from, message.token, message.sessionKey, message.scope, message.subscriptionId, message.update);
            return;
        }
        this.#recordReadyWorker(event.from, message);
    }
    #handleOperationResponse(peerId, token, sessionKey, response) {
        const pending = this.#pendingOperations.get(response.requestId);
        if (!pending)
            return;
        if (pending.worker.peerId !== peerId ||
            pending.worker.token !== token ||
            pending.worker.metadata.path !== sessionKey ||
            response.scope.serverConnectionId !== pending.scope.serverConnectionId ||
            response.scope.attachmentId !== pending.scope.attachmentId) {
            this.#rejectOperation(response.requestId, new Error("Session worker returned a mismatched operation response"));
            return;
        }
        this.#pendingOperations.delete(response.requestId);
        pending.cleanup();
        if (response.type === "operation_error") {
            pending.reject(response.code === undefined
                ? new Error(`Session worker operation failed: ${response.message}`)
                : new ServerError(response.code, response.message));
        }
        else {
            pending.resolve(response.result);
        }
    }
    #handleServiceEvent(peerId, token, sessionKey, scope, subscriptionId, update) {
        const entry = this.#serviceSubscriptions.get(scopedServiceSubscriptionKey(scope, subscriptionId));
        if (entry === undefined ||
            entry.worker.peerId !== peerId ||
            entry.worker.token !== token ||
            entry.worker.metadata.path !== sessionKey ||
            !sameScope(entry.scope, scope)) {
            return;
        }
        let parsed;
        try {
            parsed = parseServiceProviderUpdate(update);
        }
        catch {
            return;
        }
        entry.deliveryTail = entry.deliveryTail.then(() => entry.listener(parsed, TODO_CONTEXT)).catch(() => { });
    }
    #recordReadyWorker(peerId, message) {
        if (message.sessionKey !== message.metadata.path ||
            message.sessionId !== message.metadata.id ||
            !isAbsolute(message.metadata.cwd) ||
            !isAbsolute(message.metadata.path)) {
            return;
        }
        this.#markDiscovered(peerId);
        const pending = this.#pending.get(message.sessionKey);
        if (pending?.peerId === peerId && !sameStrings(message.pluginManifestPaths, pending.pluginManifestPaths)) {
            this.#failPending(message.sessionKey, new Error("Session worker started with stale plugin packages"));
            return;
        }
        const existing = this.#workersBySession.get(message.sessionKey);
        if (existing && existing.peerId !== peerId) {
            void this.#coordinator.send(peerId, { type: "shutdown" }).catch(() => { });
            return;
        }
        if (pending &&
            (pending.peerId !== peerId || pending.token !== message.token || pending.child.pid !== message.pid)) {
            return;
        }
        if (existing)
            return;
        let resolveTerminated;
        const terminated = new Promise((resolve) => {
            resolveTerminated = resolve;
        });
        const worker = {
            peerId,
            metadata: message.metadata,
            pid: message.pid,
            token: message.token,
            pluginManifestPaths: Object.freeze([...message.pluginManifestPaths]),
            terminated,
            resolveTerminated,
            attachmentIds: new Set(),
            expectedStop: false,
            stopping: false,
        };
        this.#workersBySession.set(message.sessionKey, worker);
        this.#workersByPeer.set(peerId, worker);
        this.workerPids.set(message.sessionId, message.pid);
        if (pending) {
            this.#pending.delete(message.sessionKey);
            clearTimeout(pending.timer);
            pending.resolve(worker);
        }
        this.#notifyWorkerCountChanged();
    }
    #childExited(pending, code, signal) {
        if (this.#pending.get(pending.sessionKey) === pending) {
            this.#failPending(pending.sessionKey, new Error(`Session worker exited before readiness (${signal ?? code ?? "unknown"})`));
            return;
        }
        const worker = this.#workersByPeer.get(pending.peerId);
        if (worker) {
            this.#removeWorker(worker, worker.expectedStop
                ? undefined
                : new Error(`Session worker ${worker.metadata.id} exited unexpectedly (${signal ?? code ?? "unknown"})`));
        }
    }
    #failPending(sessionKey, error) {
        const pending = this.#pending.get(sessionKey);
        if (!pending)
            return;
        this.#pending.delete(sessionKey);
        clearTimeout(pending.timer);
        this.#notifyWorkerCountChanged();
        if (pending.child.exitCode === null && pending.child.signalCode === null)
            pending.child.kill("SIGKILL");
        pending.reject(error);
    }
    #rejectDemand(requestId, error) {
        const pending = this.#pendingDemand.get(requestId);
        if (!pending)
            return;
        this.#pendingDemand.delete(requestId);
        clearTimeout(pending.timer);
        pending.reject(error);
    }
    #rejectOperation(requestId, error) {
        const pending = this.#pendingOperations.get(requestId);
        if (!pending)
            return;
        this.#pendingOperations.delete(requestId);
        pending.cleanup();
        pending.reject(error);
    }
    #rejectWorkerOperations(worker, error) {
        for (const [requestId, pending] of this.#pendingOperations) {
            if (pending.worker === worker)
                this.#rejectOperation(requestId, error);
        }
    }
    async #reconcileDemandTimeout(requestId) {
        const pending = this.#pendingDemand.get(requestId);
        if (!pending)
            return;
        this.#pendingDemand.delete(requestId);
        clearTimeout(pending.timer);
        const timeoutError = new Error("Session worker demand update timed out");
        try {
            await this.#applyDemand(pending.worker, pending.attachmentId, false, false, BACKGROUND_CONTEXT);
            if (pending.attached)
                pending.reject(timeoutError);
            else
                pending.resolve();
        }
        catch (cleanupError) {
            try {
                await this.#stopWorker(pending.worker, BACKGROUND_CONTEXT);
            }
            catch (stopError) {
                pending.reject(new AggregateError([timeoutError, cleanupError, stopError], "Session worker demand reconciliation and termination failed"));
                return;
            }
            pending.reject(new AggregateError([timeoutError, cleanupError], "Session worker demand reconciliation failed; worker was terminated"));
        }
    }
    #removeWorker(worker, error) {
        if (this.#workersByPeer.get(worker.peerId) !== worker)
            return;
        this.#rejectWorkerOperations(worker, new Error("Session worker disconnected during an operation"));
        this.#removeServiceSubscriptions((entry) => entry.worker === worker);
        for (const pending of [...this.#pendingDemand.values()]) {
            if (pending.worker === worker) {
                this.#rejectDemand(pending.requestId, new Error("Session worker disconnected during demand update"));
            }
        }
        this.#workersByPeer.delete(worker.peerId);
        this.#workersBySession.delete(worker.metadata.path);
        if (this.workerPids.get(worker.metadata.id) === worker.pid)
            this.workerPids.delete(worker.metadata.id);
        worker.resolveTerminated(error);
        this.#notifyWorkerCountChanged();
    }
    #removeServiceSubscriptions(matches) {
        for (const [key, entry] of this.#serviceSubscriptions) {
            if (matches(entry))
                this.#serviceSubscriptions.delete(key);
        }
    }
    #notifyWorkerCountChanged() {
        this.#onWorkerCountChanged?.(this.#workersBySession.size + this.#pending.size);
    }
    #pendingPeer(peerId) {
        return [...this.#pending.values()].find((pending) => pending.peerId === peerId);
    }
    #markDiscovered(peerId) {
        if (!this.#discoveryPeers?.delete(peerId) || this.#discoveryPeers.size !== 0)
            return;
        this.#resolveDiscovery?.();
    }
    #detachState() {
        this.#removeListener();
        for (const requestId of [...this.#pendingOperations.keys()]) {
            this.#rejectOperation(requestId, new Error("Experimental server detached during a worker operation"));
        }
        for (const pending of [...this.#pendingDemand.values()]) {
            this.#pendingDemand.delete(pending.requestId);
            clearTimeout(pending.timer);
            pending.resolve();
        }
        this.#pending.clear();
        this.#serviceSubscriptions.clear();
        this.#workersByPeer.clear();
        this.#workersBySession.clear();
        this.workerPids.clear();
        this.#discoveryPeers = undefined;
        this.#resolveDiscovery?.();
        this.#resolveDiscovery = undefined;
    }
}
function sameStrings(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
function sameScope(left, right) {
    return left.serverConnectionId === right.serverConnectionId && left.attachmentId === right.attachmentId;
}
function scopedServiceSubscriptionKey(scope, subscriptionId) {
    return `${scope.serverConnectionId}\0${scope.attachmentId}\0${subscriptionId}`;
}
function abortError(signal) {
    const reason = signal.reason;
    return reason instanceof Error ? reason : new DOMException("The operation was aborted", "AbortError");
}
//# sourceMappingURL=session-worker-manager.js.map