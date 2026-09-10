import { createConnection } from "node:net";
import { isAbsolute } from "node:path";
import { isJsonValue, parseServiceProviderUpdate, REMOTE_SERVICE_ERROR_CODES, RemoteServiceError, } from "@earendil-works/chord";
import { AgentHarness, BACKGROUND_CONTEXT, createBashTool, createReadTool, createWriteTool, JsonlSessionRepo, TODO_CONTEXT, withCancel, } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import lockfile from "proper-lockfile";
import Type from "typebox";
import { Check } from "typebox/value";
import { findInitialModel, resolveCliModel } from "../core/model-resolver.js";
import { ModelRuntime } from "../core/model-runtime.js";
import { SettingsManager } from "../core/settings-manager.js";
import { COORDINATOR_PROTOCOL_VERSION } from "./coordinator.js";
import { createSessionPluginFacetLoader } from "./plugins/bundled.js";
import { consumeInternalProcessRole, encodeControlLine, isDirectInternalProcessEntry, MAX_CONTROL_LINE_BYTES, } from "./process.js";
import { createSessionWorkerServices, } from "./services/worker.js";
const StrictObject = (properties) => Type.Object(properties, { additionalProperties: false });
const OpaqueJsonValueSchema = Type.Unsafe(Type.Unknown());
const ServiceCallSchema = Type.Unsafe(StrictObject({
    serviceId: Type.String({ minLength: 1 }),
    instance: Type.Optional(StrictObject({ key: Type.String({ minLength: 1 }), generation: Type.Integer({ minimum: 1 }) })),
    member: Type.String({ minLength: 1 }),
    args: Type.Array(Type.Unknown()),
}));
const RemoteServiceErrorCodeSchema = Type.Unsafe(Type.String({ pattern: `^(?:${REMOTE_SERVICE_ERROR_CODES.join("|")})$` }));
export const SESSION_WORKER_CONTROL_ADDRESS_ENV = "PI_SESSION_WORKER_CONTROL_ADDRESS";
export const SESSION_WORKER_CONTROL_TOKEN_ENV = "PI_SESSION_WORKER_CONTROL_TOKEN";
export const SESSION_WORKER_SESSION_KEY_ENV = "PI_SESSION_WORKER_SESSION_KEY_BASE64";
export const SESSION_WORKER_PEER_ID_ENV = "PI_SESSION_WORKER_PEER_ID";
export const SessionWorkerMetadataSchema = StrictObject({
    id: Type.String({ minLength: 1 }),
    createdAt: Type.Integer(),
    storageVersion: Type.Integer(),
    cwd: Type.String(),
    path: Type.String(),
    modifiedAt: Type.Number(),
    parentSessionId: Type.Optional(Type.String()),
});
export const SessionWorkerOptionsSchema = StrictObject({
    sessionDir: Type.String({ minLength: 1 }),
    metadata: SessionWorkerMetadataSchema,
    provider: Type.Optional(Type.String({ minLength: 1 })),
    model: Type.Optional(Type.String({ minLength: 1 })),
    pluginManifestPaths: Type.Array(Type.String({ minLength: 1 })),
});
export const WorkerOperationScopeSchema = StrictObject({
    serverConnectionId: Type.String(),
    attachmentId: Type.String(),
});
export const WorkerOperationRequestSchema = StrictObject({
    type: Type.Literal("operation"),
    requestId: Type.String({ minLength: 1 }),
    scope: WorkerOperationScopeSchema,
    call: ServiceCallSchema,
});
export const WorkerOperationResponseSchema = Type.Union([
    StrictObject({
        type: Type.Literal("operation_result"),
        requestId: Type.String({ minLength: 1 }),
        scope: WorkerOperationScopeSchema,
        result: Type.Optional(OpaqueJsonValueSchema),
    }),
    StrictObject({
        type: Type.Literal("operation_error"),
        requestId: Type.String({ minLength: 1 }),
        scope: WorkerOperationScopeSchema,
        code: Type.Optional(RemoteServiceErrorCodeSchema),
        message: Type.String(),
    }),
]);
export const SessionWorkerCommandSchema = Type.Union([
    Type.Object({ type: Type.Literal("shutdown") }),
    Type.Object({ type: Type.Literal("discover_workers") }),
    Type.Object({
        type: Type.Literal("session_demand"),
        serverConnectionId: Type.String(),
        requestId: Type.String(),
        attachmentId: Type.String(),
        attached: Type.Boolean(),
    }),
    WorkerOperationRequestSchema,
    StrictObject({
        type: Type.Literal("operation_cancel"),
        requestId: Type.String({ minLength: 1 }),
        scope: WorkerOperationScopeSchema,
    }),
]);
export const SessionWorkerEventSchema = Type.Union([
    Type.Object({
        type: Type.Literal("worker_ready"),
        token: Type.String(),
        sessionKey: Type.String(),
        sessionId: Type.String(),
        pid: Type.Integer({ minimum: 1 }),
        metadata: SessionWorkerMetadataSchema,
        pluginManifestPaths: Type.Array(Type.String({ minLength: 1 })),
    }),
    Type.Object({
        type: Type.Literal("worker_failed"),
        token: Type.String(),
        sessionKey: Type.String(),
        message: Type.String(),
    }),
    Type.Object({
        type: Type.Literal("demand_applied"),
        token: Type.String(),
        sessionKey: Type.String(),
        requestId: Type.String(),
        attachmentId: Type.String(),
        attached: Type.Boolean(),
    }),
    Type.Object({
        type: Type.Literal("demand_rejected"),
        token: Type.String(),
        sessionKey: Type.String(),
        requestId: Type.String(),
        message: Type.String(),
    }),
    Type.Object({
        type: Type.Literal("operation_response"),
        token: Type.String(),
        sessionKey: Type.String(),
        response: WorkerOperationResponseSchema,
    }),
    Type.Object({
        type: Type.Literal("service_update"),
        token: Type.String(),
        sessionKey: Type.String(),
        scope: WorkerOperationScopeSchema,
        subscriptionId: Type.String({ minLength: 1 }),
        update: Type.Unknown(),
    }),
]);
/** Worker-local reconciliation of server-generation demand and Harness activity. */
export class WorkerLifecycle {
    #initialDemandGraceMs;
    #orphanDemandGraceMs;
    #onRetire;
    #demands = new Map();
    #activeOperations = new Set();
    #currentServerConnectionId;
    #initialTimer;
    #demandInitialized;
    #retirementHolds = 0;
    #retiring = false;
    constructor(options) {
        this.#currentServerConnectionId = options.initialServerConnectionId;
        this.#initialDemandGraceMs = options.initialDemandGraceMs;
        this.#orphanDemandGraceMs = options.orphanDemandGraceMs;
        this.#onRetire = options.onRetire;
        this.#demandInitialized = false;
        this.#initialTimer = setTimeout(() => {
            this.#initialTimer = undefined;
            this.#demandInitialized = true;
            this.#reconcile();
        }, this.#initialDemandGraceMs);
        this.#initialTimer.unref();
    }
    serverConnected(serverConnectionId) {
        this.#currentServerConnectionId = serverConnectionId;
        for (const demand of this.#demands.values()) {
            if (demand.serverConnectionId !== serverConnectionId || !demand.timer)
                continue;
            clearTimeout(demand.timer);
            delete demand.timer;
        }
    }
    serverDisconnected(serverConnectionId) {
        if (this.#currentServerConnectionId === serverConnectionId)
            this.#currentServerConnectionId = undefined;
        for (const [key, demand] of this.#demands) {
            if (demand.serverConnectionId !== serverConnectionId || demand.timer)
                continue;
            demand.timer = setTimeout(() => {
                if (this.#demands.get(key) !== demand)
                    return;
                this.#demands.delete(key);
                this.#reconcile();
            }, this.#orphanDemandGraceMs);
            demand.timer.unref();
        }
    }
    beginRequest(serverConnectionId, attachmentId) {
        if (this.#retiring)
            throw new Error("Session worker is retiring");
        if (serverConnectionId !== this.#currentServerConnectionId) {
            throw new Error("Session worker received a request from a stale server generation");
        }
        const demand = this.#demands.get(demandKey(serverConnectionId, attachmentId));
        if (!demand || demand.timer) {
            throw new Error("Session worker request does not match the active attachment");
        }
        return this.holdRetirement();
    }
    holdRetirement() {
        this.#retirementHolds += 1;
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            this.#retirementHolds -= 1;
            this.#reconcile();
        };
    }
    setDemand(serverConnectionId, attachmentId, attached) {
        if (this.#retiring)
            throw new Error("Session worker is retiring");
        if (serverConnectionId !== this.#currentServerConnectionId) {
            throw new Error("Session worker received demand from a stale server generation");
        }
        this.#demandInitialized = true;
        if (this.#initialTimer) {
            clearTimeout(this.#initialTimer);
            this.#initialTimer = undefined;
        }
        const key = demandKey(serverConnectionId, attachmentId);
        const previous = this.#demands.get(key);
        if (previous?.timer)
            clearTimeout(previous.timer);
        if (attached)
            this.#demands.set(key, { serverConnectionId, attachmentId });
        else
            this.#demands.delete(key);
        this.#reconcile();
    }
    operationStarted(kind, lane, operationId) {
        this.#activeOperations.add(`${kind}\0${lane}\0${operationId}`);
    }
    operationStopped(kind, lane, operationId) {
        this.#activeOperations.delete(`${kind}\0${lane}\0${operationId}`);
        this.#reconcile();
    }
    close() {
        if (this.#initialTimer)
            clearTimeout(this.#initialTimer);
        for (const demand of this.#demands.values()) {
            if (demand.timer)
                clearTimeout(demand.timer);
        }
        this.#demands.clear();
    }
    #reconcile() {
        if (this.#retiring ||
            !this.#demandInitialized ||
            this.#retirementHolds !== 0 ||
            this.#activeOperations.size !== 0 ||
            this.#demands.size !== 0) {
            return;
        }
        this.#retiring = true;
        this.#onRetire();
    }
}
const DEFAULT_INITIAL_DEMAND_GRACE_MS = 10_000;
const DEFAULT_ORPHAN_DEMAND_GRACE_MS = 30_000;
export const SESSION_WORKER_INITIAL_DEMAND_GRACE_ENV = "__PI_SESSION_WORKER_INITIAL_DEMAND_GRACE_MS";
export const SESSION_WORKER_ORPHAN_DEMAND_GRACE_ENV = "__PI_SESSION_WORKER_ORPHAN_DEMAND_GRACE_MS";
const CoordinatorInputSchema = Type.Union([
    Type.Object({
        type: Type.Literal("peer_registered"),
        peerId: Type.String(),
        serverConnectionId: Type.Optional(Type.String()),
    }),
    Type.Object({ type: Type.Literal("server_connected"), serverConnectionId: Type.String() }),
    Type.Object({ type: Type.Literal("server_disconnected"), serverConnectionId: Type.String() }),
    Type.Object({ type: Type.Literal("message"), from: Type.Literal("server"), payload: Type.Unknown() }),
]);
let failureControl;
async function connectControl() {
    const address = process.env[SESSION_WORKER_CONTROL_ADDRESS_ENV];
    const token = process.env[SESSION_WORKER_CONTROL_TOKEN_ENV];
    const encodedSessionKey = process.env[SESSION_WORKER_SESSION_KEY_ENV];
    if (!address || !token || !encodedSessionKey)
        throw new Error("Session worker requires a control address");
    const peerId = process.env[SESSION_WORKER_PEER_ID_ENV];
    if (!peerId)
        throw new Error("Session worker requires a peer ID");
    const socket = createConnection(address);
    await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
    });
    const messages = createJsonLineMessages(socket);
    await writeJsonLine(socket, { type: "register_peer", protocol: COORDINATOR_PROTOCOL_VERSION, peerId });
    const registered = await messages[Symbol.asyncIterator]().next();
    if (registered.done ||
        !Check(CoordinatorInputSchema, registered.value) ||
        registered.value.type !== "peer_registered") {
        throw new Error("Coordinator rejected the session worker registration");
    }
    return {
        ...(registered.value.serverConnectionId === undefined
            ? {}
            : { initialServerConnectionId: registered.value.serverConnectionId }),
        messages,
        socket,
        send: (event) => writeJsonLine(socket, { type: "send", to: "server", payload: event }),
    };
}
async function readCommands(control, handlers) {
    for await (const value of control.messages) {
        if (!Check(CoordinatorInputSchema, value)) {
            control.socket.destroy(new Error("Coordinator sent an invalid worker message"));
            return;
        }
        const message = value;
        if (message.type === "server_connected") {
            handlers.onServerConnected(message.serverConnectionId);
            continue;
        }
        if (message.type === "server_disconnected") {
            handlers.onServerDisconnected(message.serverConnectionId);
            continue;
        }
        if (message.type !== "message" || !Check(SessionWorkerCommandSchema, message.payload))
            continue;
        const command = message.payload;
        if (command.type === "shutdown")
            handlers.onShutdown();
        else if (command.type === "discover_workers")
            handlers.onDiscovery();
        else if (command.type === "session_demand")
            await handlers.onDemand(command);
        else if (command.type === "operation_cancel")
            handlers.onOperationCancel(command);
        else
            handlers.onOperation(command);
    }
}
function createJsonLineMessages(socket) {
    const queued = [];
    const waiters = [];
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
        buffered += chunk;
        if (Buffer.byteLength(buffered) > MAX_CONTROL_LINE_BYTES) {
            socket.destroy(new Error("Session worker control message is too large"));
            return;
        }
        while (true) {
            const newline = buffered.indexOf("\n");
            if (newline === -1)
                return;
            const line = buffered.slice(0, newline);
            buffered = buffered.slice(newline + 1);
            try {
                const value = JSON.parse(line);
                const waiter = waiters.shift();
                if (waiter)
                    waiter(value);
                else
                    queued.push(value);
            }
            catch {
                socket.destroy(new Error("Session worker received invalid control JSON"));
                return;
            }
        }
    });
    return {
        [Symbol.asyncIterator]() {
            return {
                next: async () => {
                    const value = queued.shift() ?? (await new Promise((resolve) => waiters.push(resolve)));
                    return { done: false, value };
                },
            };
        },
    };
}
function writeJsonLine(socket, message) {
    return new Promise((resolve, reject) => {
        socket.write(encodeControlLine(message), (error) => {
            if (error)
                reject(error);
            else
                resolve();
        });
    });
}
function toWorkerServiceUpdate(update) {
    if (!isJsonValue(update))
        throw new Error("Service produced a non-JSON update");
    return parseServiceProviderUpdate(update);
}
function demandKey(serverConnectionId, attachmentId) {
    return `${serverConnectionId}\0${attachmentId}`;
}
function sameScope(left, right) {
    return left.serverConnectionId === right.serverConnectionId && left.attachmentId === right.attachmentId;
}
function lifecycleDelay(name, fallback) {
    const value = process.env[name];
    if (value === undefined)
        return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0)
        throw new Error(`${name} must be a non-negative safe integer`);
    return parsed;
}
async function closeResources(resources) {
    const errors = [];
    try {
        await resources.services?.dispose();
    }
    catch (error) {
        errors.push(error);
    }
    try {
        if (resources.harness)
            await resources.harness.close(TODO_CONTEXT);
        else
            await resources.session?.close(TODO_CONTEXT);
    }
    catch (error) {
        errors.push(error);
    }
    try {
        await resources.repo.close(TODO_CONTEXT);
    }
    catch (error) {
        errors.push(error);
    }
    try {
        await resources.executionEnv.cleanup(TODO_CONTEXT);
    }
    catch (error) {
        errors.push(error);
    }
    try {
        await resources.releaseOwnership();
    }
    catch (error) {
        errors.push(error);
    }
    if (errors.length === 1)
        throw errors[0];
    if (errors.length > 1)
        throw new AggregateError(errors, "Session worker cleanup failed");
}
async function run(options, createHarness) {
    const { sessionDir, metadata } = options;
    const sessionId = metadata.id;
    const control = await connectControl();
    const token = process.env[SESSION_WORKER_CONTROL_TOKEN_ENV];
    const sessionKey = Buffer.from(process.env[SESSION_WORKER_SESSION_KEY_ENV], "base64url").toString();
    failureControl = control;
    const pluginManifestPaths = options.pluginManifestPaths;
    const releaseOwnership = await lockfile.lock(metadata.path, {
        realpath: true,
        stale: 2_000,
        update: 1_000,
        retries: { retries: 320, factor: 1, minTimeout: 25, maxTimeout: 25, maxRetryTime: 8_000 },
    });
    const executionEnv = new NodeExecutionEnv({ cwd: metadata.cwd });
    const repo = new JsonlSessionRepo({ fileSystem: executionEnv, sessionsRoot: sessionDir });
    let session;
    let harness;
    let lane;
    let services;
    try {
        session = await repo.open(metadata, TODO_CONTEXT);
        const runtime = await createHarness(session, options, executionEnv);
        harness = runtime.harness;
        lane = runtime.lane ?? (await harness.lane("main", TODO_CONTEXT));
        services = await createSessionWorkerServices({
            lane,
            modelRuntime: runtime.modelRuntime,
            settingsManager: runtime.settingsManager,
            facetLoader: runtime.facetLoader,
            publish: (scope, subscriptionId, update) => control.send({
                type: "service_update",
                token,
                sessionKey,
                scope,
                subscriptionId,
                update: toWorkerServiceUpdate(update),
            }),
        });
    }
    catch (error) {
        try {
            await closeResources({ harness, services, session, repo, executionEnv, releaseOwnership });
        }
        catch (cleanupError) {
            throw new AggregateError([error, cleanupError], "Session worker startup and cleanup failed");
        }
        throw error;
    }
    const activeRequests = new Map();
    let lifecycle;
    let removeLifecycleListeners = [];
    let closing;
    const close = () => {
        if (closing)
            return closing;
        lifecycle?.close();
        services.removeSubscriptions(() => true);
        for (const request of activeRequests.values())
            request.cancel(new Error("Session worker is closing"));
        activeRequests.clear();
        for (const remove of removeLifecycleListeners)
            remove();
        removeLifecycleListeners = [];
        closing = closeResources({ harness, services, repo, executionEnv, releaseOwnership });
        return closing;
    };
    const closeAndExit = () => {
        void close().then(() => process.exit(0), (error) => {
            console.error(error);
            process.exit(1);
        });
    };
    lifecycle = new WorkerLifecycle({
        initialServerConnectionId: control.initialServerConnectionId,
        initialDemandGraceMs: lifecycleDelay(SESSION_WORKER_INITIAL_DEMAND_GRACE_ENV, DEFAULT_INITIAL_DEMAND_GRACE_MS),
        orphanDemandGraceMs: lifecycleDelay(SESSION_WORKER_ORPHAN_DEMAND_GRACE_ENV, DEFAULT_ORPHAN_DEMAND_GRACE_MS),
        onRetire: closeAndExit,
    });
    removeLifecycleListeners = [
        harness.events.on("run_start", (event) => lifecycle?.operationStarted("run", event.lane, event.runId)),
        harness.events.on("run_resume", (event) => lifecycle?.operationStarted("run", event.lane, event.runId)),
        harness.events.on("run_suspend", (event) => lifecycle?.operationStopped("run", event.lane, event.runId)),
        harness.events.on("run_end", (event) => lifecycle?.operationStopped("run", event.lane, event.runId)),
        harness.events.on("compaction_start", (event) => lifecycle?.operationStarted("compaction", event.lane, event.runId)),
        harness.events.on("compaction_end", (event) => lifecycle?.operationStopped("compaction", event.lane, event.runId)),
        harness.events.on("navigation_start", (event) => lifecycle?.operationStarted("navigation", event.lane, event.runId)),
        harness.events.on("navigation_end", (event) => lifecycle?.operationStopped("navigation", event.lane, event.runId)),
        harness.events.on("fault", closeAndExit),
    ];
    const handleOperation = async (request) => {
        let releaseRequest = () => { };
        const cancellable = withCancel(BACKGROUND_CONTEXT);
        try {
            releaseRequest = lifecycle.beginRequest(request.scope.serverConnectionId, request.scope.attachmentId);
            activeRequests.set(request.requestId, { scope: request.scope, cancel: cancellable.cancel });
            const result = await services.invoke(request.call, request.scope, cancellable.context);
            if (result !== undefined && !isJsonValue(result))
                throw new Error("Service produced a non-JSON result");
            await control.send({
                type: "operation_response",
                token,
                sessionKey,
                response: {
                    type: "operation_result",
                    requestId: request.requestId,
                    scope: request.scope,
                    ...(result === undefined ? {} : { result }),
                },
            });
        }
        catch (error) {
            let code;
            if (error instanceof RemoteServiceError) {
                code = error.code;
            }
            else if (error instanceof Error && "code" in error) {
                const candidate = error.code;
                if (Check(RemoteServiceErrorCodeSchema, candidate))
                    code = candidate;
            }
            await control.send({
                type: "operation_response",
                token,
                sessionKey,
                response: {
                    type: "operation_error",
                    requestId: request.requestId,
                    scope: request.scope,
                    ...(code === undefined ? {} : { code }),
                    message: error instanceof Error ? error.message : String(error),
                },
            });
        }
        finally {
            if (activeRequests.get(request.requestId)?.cancel === cancellable.cancel) {
                activeRequests.delete(request.requestId);
            }
            releaseRequest();
        }
    };
    let ready = false;
    const announce = () => {
        if (!ready)
            return;
        void control
            .send({
            type: "worker_ready",
            token,
            sessionKey,
            sessionId,
            pid: process.pid,
            metadata,
            pluginManifestPaths: [...pluginManifestPaths],
        })
            .catch(() => closeAndExit());
    };
    void readCommands(control, {
        onShutdown: closeAndExit,
        onDiscovery: announce,
        onDemand: async (command) => {
            const releaseRetirement = lifecycle?.holdRetirement() ?? (() => { });
            try {
                try {
                    if (!command.attached) {
                        const matches = (scope) => scope.serverConnectionId === command.serverConnectionId &&
                            scope.attachmentId === command.attachmentId;
                        services.removeSubscriptions(matches);
                    }
                    lifecycle?.setDemand(command.serverConnectionId, command.attachmentId, command.attached);
                }
                catch (error) {
                    await control.send({
                        type: "demand_rejected",
                        token,
                        sessionKey,
                        requestId: command.requestId,
                        message: error instanceof Error ? error.message : String(error),
                    });
                    return;
                }
                await control.send({
                    type: "demand_applied",
                    token,
                    sessionKey,
                    requestId: command.requestId,
                    attachmentId: command.attachmentId,
                    attached: command.attached,
                });
            }
            finally {
                releaseRetirement();
            }
        },
        onOperation: (request) => {
            void handleOperation(request).catch(() => closeAndExit());
        },
        onOperationCancel: (command) => {
            const active = activeRequests.get(command.requestId);
            if (active !== undefined && sameScope(active.scope, command.scope)) {
                active.cancel(new DOMException("Service operation cancelled", "AbortError"));
            }
        },
        onServerConnected: (serverConnectionId) => lifecycle?.serverConnected(serverConnectionId),
        onServerDisconnected: (serverConnectionId) => {
            const matches = (scope) => scope.serverConnectionId === serverConnectionId;
            services.removeSubscriptions(matches);
            for (const request of activeRequests.values()) {
                if (matches(request.scope))
                    request.cancel(new Error("Server disconnected"));
            }
            lifecycle?.serverDisconnected(serverConnectionId);
        },
    }).catch(() => closeAndExit());
    control.socket.once("close", closeAndExit);
    control.socket.once("error", () => closeAndExit());
    process.once("SIGTERM", closeAndExit);
    process.once("SIGINT", closeAndExit);
    try {
        ready = true;
        await control.send({
            type: "worker_ready",
            token,
            sessionKey,
            sessionId,
            pid: process.pid,
            metadata,
            pluginManifestPaths: [...pluginManifestPaths],
        });
    }
    catch (error) {
        try {
            await close();
        }
        catch (cleanupError) {
            throw new AggregateError([error, cleanupError], "Session worker readiness and cleanup failed");
        }
        throw error;
    }
}
export async function runSessionWorkerWithHarness(args, createHarness) {
    try {
        if (args.length !== 1)
            throw new Error("Session worker requires one options argument");
        let options;
        try {
            options = JSON.parse(args[0]);
        }
        catch (error) {
            throw new Error("Session worker received invalid options", { cause: error });
        }
        if (!Check(SessionWorkerOptionsSchema, options) ||
            !isAbsolute(options.sessionDir) ||
            !isAbsolute(options.metadata.cwd) ||
            !isAbsolute(options.metadata.path) ||
            (options.provider !== undefined && options.model === undefined)) {
            throw new Error("Session worker received invalid options");
        }
        await run(options, createHarness);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const token = process.env[SESSION_WORKER_CONTROL_TOKEN_ENV];
        const encodedSessionKey = process.env[SESSION_WORKER_SESSION_KEY_ENV];
        if (token && encodedSessionKey) {
            const sessionKey = Buffer.from(encodedSessionKey, "base64url").toString();
            await failureControl?.send({ type: "worker_failed", token, sessionKey, message }).catch(() => { });
        }
        throw error;
    }
}
async function createCodingAgentHarness(session, options, executionEnv) {
    const modelRuntime = await ModelRuntime.create();
    const settingsManager = SettingsManager.create(session.metadata.cwd);
    let resolved;
    if (options.model === undefined) {
        resolved = await findInitialModel({
            scopedModels: [],
            isContinuing: true,
            defaultProvider: settingsManager.getDefaultProvider(),
            defaultModelId: settingsManager.getDefaultModel(),
            defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
            modelRuntime,
        });
    }
    else {
        resolved = resolveCliModel({
            cliProvider: options.provider,
            cliModel: options.model,
            modelRuntime,
        });
        if (resolved.error)
            throw new Error(`Session worker could not resolve model: ${resolved.error}`);
    }
    if (!resolved.model)
        throw new Error("Session worker could not resolve a model");
    const tools = [createReadTool(), createWriteTool(), createBashTool()];
    const activeToolNames = tools.map((tool) => tool.name);
    const harness = (await AgentHarness.create({
        session,
        models: modelRuntime,
        model: resolved.model,
        thinkingLevel: resolved.thinkingLevel,
        tools,
        activeToolNames,
        toolContext: { env: executionEnv },
        resources: {},
    }, TODO_CONTEXT)).harness;
    try {
        const lane = await harness.lane("main", TODO_CONTEXT);
        const currentActiveToolNames = await lane.getActiveTools(TODO_CONTEXT);
        if (currentActiveToolNames.length !== activeToolNames.length ||
            currentActiveToolNames.some((name, index) => name !== activeToolNames[index])) {
            await lane.setActiveTools(activeToolNames, TODO_CONTEXT);
        }
        return {
            harness,
            lane,
            modelRuntime,
            settingsManager,
            facetLoader: createSessionPluginFacetLoader(options.pluginManifestPaths),
        };
    }
    catch (error) {
        try {
            await harness.close(TODO_CONTEXT);
        }
        catch (cleanupError) {
            throw new AggregateError([error, cleanupError], "Session worker model selection and cleanup failed");
        }
        throw error;
    }
}
export function runSessionWorkerProcess(args) {
    return runSessionWorkerWithHarness(args, createCodingAgentHarness);
}
if (isDirectInternalProcessEntry(import.meta.url)) {
    const role = consumeInternalProcessRole();
    if (role !== "session-worker") {
        throw new Error("Session worker entrypoint requires an internal session-worker invocation");
    }
    void runSessionWorkerProcess(process.argv.slice(2)).catch(() => process.exit(1));
}
//# sourceMappingURL=session-worker.js.map