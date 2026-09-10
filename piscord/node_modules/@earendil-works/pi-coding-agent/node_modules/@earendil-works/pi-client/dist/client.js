import { createServiceCatalogueCall, createServiceStateDecoder, createServiceSubscribeCall, createServiceUnsubscribeCall, parseServiceCall, parseServiceCatalogue, parseWireServiceProviderUpdate, parseWireServiceSubscriptionSnapshot, } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { encodeClientMessage, isServerId, ProtocolValidationError, } from "@earendil-works/pi-protocol";
import { Connection } from "./connection.js";
import { ClientDisposedError, DisconnectedError, ServerError, toError } from "./errors.js";
import { createPromiseResolvers } from "./promise.js";
export class Client {
    #options;
    #connection;
    #pendingRequests = new Map();
    #connectionStateListeners = new Set();
    #attachmentListeners = new Set();
    #serviceListeners = new Map();
    #requestSequence = 0;
    #serviceSubscriptionSequence = 0;
    #hello;
    #attachment;
    #disposed = false;
    #disposePromise;
    constructor(options) {
        if (!isServerId(options.serverId)) {
            throw new TypeError("serverId must be a canonical lowercase UUIDv4");
        }
        this.#options = options;
        this.#connection = new Connection({
            transportFactory: options.transportFactory,
            serverId: options.serverId,
            maxFrameLength: options.maxFrameLength,
            onHandshake: (hello) => {
                this.#hello = hello;
            },
            onMessage: (message) => this.#handleMessage(message),
            onStateChange: (change) => this.#handleConnectionStateChange(change),
        });
    }
    get disposed() {
        return this.#disposed;
    }
    get connectionState() {
        return this.#connection.state;
    }
    get connected() {
        return this.#connection.state === "connected";
    }
    get serverId() {
        return this.#options.serverId;
    }
    get hello() {
        return this.#hello;
    }
    get attachment() {
        return this.#attachment;
    }
    static async connect(options) {
        const client = new Client(options);
        try {
            await client.connect();
            return client;
        }
        catch (error) {
            await client.dispose();
            throw error;
        }
    }
    connect() {
        if (this.#disposed)
            return Promise.reject(new ClientDisposedError());
        this.#hello = undefined;
        return this.#connection.connect();
    }
    reconnect() {
        return this.connect();
    }
    disconnect(reason = "Client disconnected") {
        this.#connection.disconnect(reason);
    }
    onConnectionStateChange(listener) {
        this.#assertNotDisposed();
        this.#connectionStateListeners.add(listener);
        return () => this.#connectionStateListeners.delete(listener);
    }
    onAttachmentChange(listener) {
        this.#assertNotDisposed();
        this.#attachmentListeners.add(listener);
        return () => this.#attachmentListeners.delete(listener);
    }
    /** Invoke one low-level protocol call against an explicit routed target. */
    request(target, call, signal) {
        return this.#request(target, call, signal);
    }
    async serviceCatalogue(target, signal) {
        const result = await this.#request(target, createServiceCatalogueCall(), signal);
        try {
            return parseServiceCatalogue(result);
        }
        catch (error) {
            const validationError = new ProtocolValidationError(error instanceof Error ? error.message : "Invalid service catalogue");
            this.#connection.fail(validationError);
            throw validationError;
        }
    }
    async subscribeService(target, serviceId, mode, listener, signal) {
        const subscriptionId = `service-${++this.#serviceSubscriptionSequence}`;
        const active = {
            target,
            listener,
            decoder: createServiceStateDecoder(),
            queuedWireUpdates: [],
            queued: [],
            deliveryTail: Promise.resolve(),
            hydrated: false,
            ready: false,
        };
        this.#serviceListeners.set(subscriptionId, active);
        let snapshot;
        try {
            snapshot = await this.#request(target, createServiceSubscribeCall(subscriptionId, serviceId, mode), signal, (result) => {
                const decoded = active.decoder.decodeSnapshot(parseWireServiceSubscriptionSnapshot(result));
                active.hydrated = true;
                for (const update of active.queuedWireUpdates.splice(0)) {
                    active.queued.push(active.decoder.decodeUpdate(parseWireServiceProviderUpdate(update)));
                }
                return decoded;
            });
        }
        catch (error) {
            if (this.#serviceListeners.get(subscriptionId) === active)
                this.#serviceListeners.delete(subscriptionId);
            throw error;
        }
        if (this.#serviceListeners.get(subscriptionId) !== active)
            throw new DisconnectedError();
        let disposed = false;
        return {
            id: subscriptionId,
            target,
            snapshot,
            start: () => {
                if (disposed || active.ready)
                    return;
                active.ready = true;
                for (const update of active.queued.splice(0))
                    this.#deliverServiceUpdate(active, update);
            },
            dispose: async () => {
                if (disposed)
                    return;
                disposed = true;
                if (this.#serviceListeners.get(subscriptionId) === active)
                    this.#serviceListeners.delete(subscriptionId);
                try {
                    if (this.connected && this.#targetIsCurrent(target)) {
                        await this.#request(target, createServiceUnsubscribeCall(subscriptionId));
                    }
                    await active.deliveryTail;
                }
                finally {
                    active.queuedWireUpdates.length = 0;
                    active.queued.length = 0;
                }
            },
        };
    }
    #request(target, call, signal, transform) {
        if (this.#disposed)
            return Promise.reject(new ClientDisposedError());
        if (!this.connected)
            return Promise.reject(new DisconnectedError());
        if (signal?.aborted)
            return Promise.reject(abortError(signal));
        const id = `request-${++this.#requestSequence}`;
        const { promise, resolve, reject } = createPromiseResolvers();
        let sent = false;
        let aborted = false;
        let onAbort;
        const sendCancel = () => {
            if (!sent || !this.connected)
                return;
            try {
                this.#connection.send(encodeClientMessage({ type: "cancel", id, target }, { maxFrameLength: this.#connection.maxFrameLength }));
            }
            catch (error) {
                this.#connection.fail(toError(error));
            }
        };
        if (signal !== undefined) {
            onAbort = () => {
                if (aborted)
                    return;
                aborted = true;
                reject(abortError(signal));
                sendCancel();
            };
            signal.addEventListener("abort", onAbort, { once: true });
        }
        this.#pendingRequests.set(id, {
            resolve: (result) => {
                try {
                    resolve(transform === undefined ? result : transform(result));
                }
                catch (error) {
                    const validationError = new ProtocolValidationError(error instanceof Error ? error.message : "Invalid service operation stream");
                    this.#connection.fail(validationError);
                    reject(validationError);
                }
            },
            reject,
            cleanup: () => {
                if (signal !== undefined && onAbort !== undefined)
                    signal.removeEventListener("abort", onAbort);
            },
        });
        let frame;
        try {
            frame = encodeClientMessage({ type: "request", id, target, call: parseServiceCall(call) }, { maxFrameLength: this.#connection.maxFrameLength });
        }
        catch (error) {
            this.#takePendingRequest(id)?.reject(toError(error));
            return promise;
        }
        this.#connection.send(frame);
        sent = true;
        if (aborted)
            sendCancel();
        return promise;
    }
    #handleMessage(message) {
        if (message.type === "attachment") {
            if (message.attachment !== null && message.attachment.serverId !== this.#options.serverId) {
                this.#connection.fail(new ProtocolValidationError("Attachment update belongs to another server"));
                return;
            }
            this.#setAttachment(message.attachment ?? undefined);
            return;
        }
        if (message.type === "service_update") {
            const active = this.#serviceListeners.get(message.subscriptionId);
            if (active === undefined)
                return;
            if (!active.hydrated) {
                active.queuedWireUpdates.push(message.update);
                return;
            }
            let update;
            try {
                update = active.decoder.decodeUpdate(parseWireServiceProviderUpdate(message.update));
            }
            catch (error) {
                this.#connection.fail(new ProtocolValidationError(error instanceof Error ? error.message : "Invalid service operation stream"));
                return;
            }
            if (active.ready)
                this.#deliverServiceUpdate(active, update);
            else
                active.queued.push(update);
            return;
        }
        const pending = this.#takePendingRequest(message.id);
        if (!pending) {
            this.#connection.fail(new ProtocolValidationError("Response has no matching request"));
            return;
        }
        if (!message.ok) {
            pending.reject(new ServerError(message.error));
            return;
        }
        pending.resolve(message.result);
    }
    #handleConnectionStateChange(change) {
        if (change.state === "disconnected") {
            this.#hello = undefined;
            this.#setAttachment(undefined);
            this.#rejectPendingRequests(change.error ?? new DisconnectedError());
            this.#serviceListeners.clear();
        }
        for (const listener of this.#connectionStateListeners) {
            try {
                listener(change);
            }
            catch (error) {
                this.#reportListenerError(error);
            }
        }
    }
    #takePendingRequest(id) {
        const request = this.#pendingRequests.get(id);
        if (request) {
            this.#pendingRequests.delete(id);
            request.cleanup();
        }
        return request;
    }
    #rejectPendingRequests(error) {
        const requests = [...this.#pendingRequests.values()];
        this.#pendingRequests.clear();
        for (const request of requests) {
            request.cleanup();
            request.reject(error);
        }
    }
    dispose() {
        if (this.#disposePromise)
            return this.#disposePromise;
        this.#disposed = true;
        this.#disposePromise = Promise.resolve();
        const error = new ClientDisposedError();
        this.#rejectPendingRequests(error);
        this.#connection.disconnect(error);
        this.#hello = undefined;
        this.#setAttachment(undefined);
        this.#connectionStateListeners.clear();
        this.#attachmentListeners.clear();
        this.#serviceListeners.clear();
        return this.#disposePromise;
    }
    [Symbol.asyncDispose]() {
        return this.dispose();
    }
    #setAttachment(attachment) {
        const previous = this.#attachment;
        if (previous?.serverId === attachment?.serverId &&
            previous?.sessionId === attachment?.sessionId &&
            previous?.attachmentId === attachment?.attachmentId) {
            return;
        }
        this.#attachment = attachment;
        for (const listener of this.#attachmentListeners) {
            try {
                listener(attachment);
            }
            catch (error) {
                this.#reportListenerError(error);
            }
        }
    }
    #deliverServiceUpdate(active, update) {
        active.deliveryTail = active.deliveryTail
            .then(() => active.listener(update))
            .catch((error) => this.#reportListenerError(error));
    }
    #targetIsCurrent(target) {
        if (!("sessionId" in target))
            return this.#hello?.serverId === target.serverId;
        const attachment = this.#attachment;
        return (attachment?.serverId === target.serverId &&
            attachment.sessionId === target.sessionId &&
            attachment.attachmentId === target.attachmentId);
    }
    #assertNotDisposed() {
        if (this.#disposed)
            throw new ClientDisposedError();
    }
    #reportListenerError(error) {
        if (!this.#options.onListenerError)
            return;
        try {
            this.#options.onListenerError(toError(error));
        }
        catch {
            // Diagnostics cannot affect protocol or transport state.
        }
    }
}
/** Adapts a lazily resolved routed client target to a Chord service transport. */
export function createClientServiceTransport(client, getTarget) {
    const target = () => {
        const resolved = getTarget();
        if (resolved === undefined)
            throw new Error("Remote service target is unavailable");
        return resolved;
    };
    return {
        invoke: async (call, context) => client.request(target(), call, context.abortSignal),
        async subscribe(serviceId, mode, listener, context) {
            const subscription = await client.subscribeService(target(), serviceId, mode, (update) => listener(update, BACKGROUND_CONTEXT), context.abortSignal);
            return {
                snapshot: subscription.snapshot,
                activate: () => subscription.start(),
                close: () => subscription.dispose(),
            };
        },
    };
}
function abortError(signal) {
    const reason = signal.reason;
    return reason instanceof Error ? reason : new DOMException("The operation was aborted", "AbortError");
}
//# sourceMappingURL=client.js.map