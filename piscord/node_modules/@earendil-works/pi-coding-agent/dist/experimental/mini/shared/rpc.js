/**
 * The whole protocol: call, result, error, cancel, event, ping. Plus named services and one routing
 * rule.
 *
 * A peer provides any number of services and uses the other side's. A call for a service this peer
 * does not provide goes to `forward`, which is what makes the server transparent: a TUI uses
 * `lane.prompt`, the server does not provide `lane`, so it hands the call to the attached worker.
 * The same rule lets a worker use `sessions.list` back through the server.
 */
const DEFAULT_DEAD_MS = 15_000;
/** A bidirectional peer on one connection. */
export function createPeer(connection, options = {}) {
    const services = new Map();
    const provided = new Set();
    /** What the other side told us it provides, so routing is a lookup rather than a guess. */
    const announced = new Set();
    const pending = new Map();
    /** Controllers for calls this peer is currently answering, so a `cancel` frame can stop them. */
    const inflight = new Map();
    const eventHandlers = [];
    let nextId = 1;
    let lastFrameAt = Date.now();
    // The signal is appended to every handler call: services that care declare a trailing
    // `AbortSignal` parameter, the rest ignore an extra argument.
    const dispatch = async (method, args, signal) => {
        const dot = method.indexOf(".");
        const local = dot === -1 ? undefined : services.get(method.slice(0, dot));
        if (!local) {
            if (!options.forward)
                throw new Error(`No service provides ${method}`);
            return options.forward(method, args);
        }
        const handler = local[method.slice(dot + 1)];
        if (typeof handler !== "function")
            throw new Error(`Unknown method: ${method}`);
        return handler.apply(local, [...args, signal]);
    };
    connection.onMessage((frameValue) => {
        const frame = frameValue;
        lastFrameAt = Date.now();
        switch (frame.kind) {
            case "event": {
                for (const handler of eventHandlers)
                    handler(frame.service, frame.payload, frame.to);
                return;
            }
            case "call": {
                const controller = new AbortController();
                inflight.set(frame.id, controller);
                void dispatch(frame.method, frame.args, controller.signal)
                    .then(
                // `undefined` vanishes through JSON, so an absent result is sent as null.
                (result) => connection.send({ kind: "result", id: frame.id, result: result ?? null }), (error) => connection.send({ kind: "error", id: frame.id, error: message(error) }))
                    .finally(() => inflight.delete(frame.id));
                return;
            }
            case "cancel": {
                inflight.get(frame.id)?.abort(new Error("Cancelled by caller"));
                inflight.delete(frame.id);
                return;
            }
            case "result":
            case "error": {
                const waiter = pending.get(frame.id);
                pending.delete(frame.id);
                if (frame.kind === "error")
                    waiter?.reject(new Error(frame.error));
                else
                    waiter?.resolve(frame.result);
                return;
            }
            case "announce": {
                announced.clear();
                for (const service of frame.services)
                    announced.add(service);
                return;
            }
            case "ping":
                return;
            default: {
                const unknownFrame = frame;
                throw new Error(`Unknown frame: ${JSON.stringify(unknownFrame)}`);
            }
        }
    });
    connection.onClose(() => {
        if (liveness)
            clearInterval(liveness);
        for (const waiter of pending.values())
            waiter.reject(new Error("Connection closed"));
        pending.clear();
        for (const controller of inflight.values())
            controller.abort(new Error("Connection closed"));
        inflight.clear();
    });
    /**
     * A peer can vanish without closing: a killed machine, a wedged event loop. Any frame counts as
     * proof of life, and pings keep an idle connection proving it.
     */
    const deadMs = options.deadMs ?? DEFAULT_DEAD_MS;
    const liveness = deadMs > 0
        ? setInterval(() => {
            if (Date.now() - lastFrameAt > deadMs)
                connection.close();
            else
                connection.send({ kind: "ping" });
        }, Math.floor(deadMs / 3))
        : undefined;
    liveness?.unref();
    const callWith = (callOptions, method, ...args) => new Promise((resolve, reject) => {
        const id = nextId++;
        let timer;
        const abandon = (error) => {
            if (!pending.delete(id))
                return;
            if (timer)
                clearTimeout(timer);
            callOptions.signal?.removeEventListener("abort", onAbort);
            // Tell the peer to stop; it may already be gone, in which case this is a no-op.
            connection.send({ kind: "cancel", id });
            reject(error);
        };
        const onAbort = () => abandon(new Error("Call cancelled"));
        const settle = (handler) => (value) => {
            if (timer)
                clearTimeout(timer);
            callOptions.signal?.removeEventListener("abort", onAbort);
            handler(value);
        };
        if (callOptions.signal?.aborted) {
            reject(new Error("Call cancelled"));
            return;
        }
        pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
        callOptions.signal?.addEventListener("abort", onAbort, { once: true });
        if (callOptions.timeoutMs !== undefined) {
            timer = setTimeout(() => abandon(new Error(`${method} timed out after ${callOptions.timeoutMs}ms`)), callOptions.timeoutMs);
            timer.unref();
        }
        connection.send({ kind: "call", id, method, args });
    });
    const peer = {
        provide: (token, implementation) => {
            services.set(token.name, implementation);
            provided.add(token.name);
            connection.send({ kind: "announce", services: [...provided] });
        },
        provided,
        announced,
        use: (token, callOptions = {}) => new Proxy({}, {
            get: (_target, method) => (...args) => callWith(callOptions, `${token.name}.${String(method)}`, ...args),
        }),
        emit: (token, event) => connection.send({ kind: "event", service: token.name, payload: event }),
        emitTo: (token, event, to) => connection.send({ kind: "event", service: token.name, payload: event, to }),
        emitRaw: (service, payload, to) => connection.send({ kind: "event", service, payload, ...(to === undefined ? {} : { to }) }),
        on: (token, handler) => eventHandlers.push((name, payload) => {
            if (name === token.name)
                handler(payload);
        }),
        onEvent: (handler) => eventHandlers.push(handler),
        call: (method, ...args) => callWith({}, method, ...args),
        callWith,
        onClose: (handler) => connection.onClose(handler),
        close: () => connection.close(),
    };
    return peer;
}
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=rpc.js.map