import { createRemoteServiceBinding, replicatedState, } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createClientServiceTransport } from "@earendil-works/pi-client";
class RoutedServiceBinding {
    #services;
    #getBound;
    #onActivate;
    #remove;
    #activated = false;
    #activationComplete = false;
    constructor(options) {
        this.#services = createRemoteServiceBinding({
            services: options.services,
            transport: options.transport,
            bound: false,
            assertAccess: options.assertAccess,
            onError: options.onError,
        });
        this.#getBound = options.getBound;
        this.#onActivate = options.onActivate ?? (() => Promise.resolve());
        this.#remove = options.remove;
    }
    use(service) {
        return this.#services.use(service);
    }
    observe(service, handler) {
        return this.#services.observe(service, handler);
    }
    async ready(context) {
        if (!this.#activated) {
            this.#activated = true;
            await this.#services.rebind(this.#getBound(), context);
        }
        await this.serviceReady(context);
        if (!this.#activationComplete) {
            await this.#onActivate(context);
            this.#activationComplete = true;
        }
    }
    serviceReady(context) {
        return this.#services.ready(context);
    }
    updateBound(bound, context) {
        return this.#activated ? this.#services.rebind(bound, context) : Promise.resolve();
    }
    async dispose(context) {
        this.#remove();
        await this.#services.dispose(context);
    }
}
class ServerServiceSourceImpl {
    acceptsUnavailableServices = false;
    connection;
    #client;
    #transport;
    #bindings = new Set();
    #removeConnectionListener;
    #onError;
    #transition = Promise.resolve();
    #connectionAttempt;
    #disposed = false;
    constructor(client, options) {
        this.#client = client;
        this.#transport = createClientServiceTransport(client, () => ({ serverId: client.serverId }));
        this.#onError = options.onError ?? (() => { });
        this.#connectionAttempt = client.connectionState === "connecting" ? 1 : 0;
        const connectionState = replicatedState(toServerConnectionState(client, this.#connectionAttempt));
        this.connection = connectionState;
        this.#removeConnectionListener = client.onConnectionStateChange(({ state, error }) => {
            if (state === "connecting")
                this.#connectionAttempt += 1;
            publishReplacement(connectionState, toServerConnectionState(client, this.#connectionAttempt, error), BACKGROUND_CONTEXT);
            this.#transition = this.#transition
                .then(async () => {
                const results = await Promise.allSettled([...this.#bindings].map((binding) => binding.updateBound(state === "connected", BACKGROUND_CONTEXT)));
                const failures = results.filter((result) => result.status === "rejected");
                if (failures.length > 0)
                    throw new AggregateError(failures.map(({ reason }) => reason));
            })
                .catch((transitionError) => this.#onError(toError(transitionError)));
        });
    }
    catalogue(context) {
        return this.#client.serviceCatalogue({ serverId: this.#client.serverId }, context.abortSignal);
    }
    open(options) {
        if (this.#disposed)
            throw new Error("Server service source is disposed");
        let binding;
        binding = new RoutedServiceBinding({
            services: options.services,
            transport: this.#transport,
            getBound: () => this.#client.connected,
            assertAccess: options.assertAccess,
            onError: options.onError,
            remove: () => this.#bindings.delete(binding),
        });
        this.#bindings.add(binding);
        return binding;
    }
    async dispose(context) {
        if (this.#disposed)
            return;
        this.#disposed = true;
        this.#removeConnectionListener();
        await this.#transition;
        const bindings = [...this.#bindings];
        this.#bindings.clear();
        const results = await Promise.allSettled(bindings.map((binding) => binding.dispose(context)));
        throwFailures(results, "Failed to dispose server service source");
    }
}
class SessionServiceSourceImpl {
    attachment;
    #client;
    #transport;
    #attachmentState;
    #bindings = new Set();
    #removeAttachmentListener;
    #onError;
    #transitions = new Set();
    #catalogue;
    #attachmentRevision = 0;
    #disposed = false;
    get acceptsUnavailableServices() {
        return this.#client.attachment === undefined && this.#catalogue === undefined;
    }
    constructor(client, options) {
        this.#client = client;
        this.#transport = createClientServiceTransport(client, () => client.attachment);
        this.#onError = options.onError ?? (() => { });
        this.#attachmentState = replicatedState(client.attachment === undefined
            ? { status: "detached" }
            : { status: "attaching", sessionId: client.attachment.sessionId });
        this.attachment = this.#attachmentState;
        this.#removeAttachmentListener = client.onAttachmentChange((attachment) => {
            const revision = ++this.#attachmentRevision;
            if (attachment !== undefined) {
                publishReplacement(this.#attachmentState, { status: "attaching", sessionId: attachment.sessionId }, BACKGROUND_CONTEXT);
                void this.#client.serviceCatalogue(attachment).then((catalogue) => {
                    if (this.#attachmentRevision === revision && sameAttachment(this.#client.attachment, attachment)) {
                        this.#catalogue = catalogue;
                    }
                }, (error) => this.#onError(toError(error)));
            }
            const transition = this.#rebind(attachment !== undefined, BACKGROUND_CONTEXT);
            this.#transitions.add(transition);
            void transition.then(() => {
                this.#transitions.delete(transition);
                if (this.#attachmentRevision !== revision || !sameAttachment(this.#client.attachment, attachment))
                    return;
                publishReplacement(this.#attachmentState, attachment === undefined
                    ? { status: "detached" }
                    : { status: "attached", sessionId: attachment.sessionId }, BACKGROUND_CONTEXT);
            }, (error) => {
                this.#transitions.delete(transition);
                if (this.#attachmentRevision !== revision || !sameAttachment(this.#client.attachment, attachment))
                    return;
                publishReplacement(this.#attachmentState, attachment === undefined
                    ? { status: "detached" }
                    : { status: "degraded", sessionId: attachment.sessionId }, BACKGROUND_CONTEXT);
                this.#onError(toError(error));
            });
        });
    }
    async catalogue(context) {
        const target = this.#client.attachment;
        if (target === undefined)
            return this.#catalogue ?? [];
        const catalogue = await this.#client.serviceCatalogue(target, context.abortSignal);
        this.#catalogue = catalogue;
        return catalogue;
    }
    open(options) {
        if (this.#disposed)
            throw new Error("Session service source is disposed");
        let binding;
        binding = new RoutedServiceBinding({
            services: options.services,
            transport: this.#transport,
            getBound: () => this.#client.attachment !== undefined,
            onActivate: async (context) => {
                const attachment = this.#client.attachment;
                if (attachment === undefined)
                    await this.#whenDetached(this.#attachmentRevision, context);
                else
                    await this.#whenAttached(attachment, this.#attachmentRevision, context);
            },
            assertAccess: options.assertAccess,
            onError: options.onError,
            remove: () => this.#bindings.delete(binding),
        });
        this.#bindings.add(binding);
        return binding;
    }
    async whenAttached(sessionId, context) {
        const attachment = this.#client.attachment;
        if (attachment === undefined || attachment.sessionId !== sessionId) {
            throw new Error(`Session ${sessionId} is not the current attachment`);
        }
        await this.#whenAttached(attachment, this.#attachmentRevision, context);
    }
    async whenDetached(context) {
        if (this.#client.attachment !== undefined)
            throw new Error("A Session is still attached");
        await this.#whenDetached(this.#attachmentRevision, context);
    }
    async dispose(context) {
        if (this.#disposed)
            return;
        this.#disposed = true;
        this.#removeAttachmentListener();
        await Promise.allSettled(this.#transitions);
        const bindings = [...this.#bindings];
        this.#bindings.clear();
        const results = await Promise.allSettled(bindings.map((binding) => binding.dispose(context)));
        throwFailures(results, "Failed to dispose Session service source");
    }
    async #rebind(bound, context) {
        const results = await Promise.allSettled([...this.#bindings].map((binding) => binding.updateBound(bound, context)));
        throwFailures(results, "Failed to rebind Session services");
    }
    async #whenAttached(attachment, revision, context) {
        try {
            await Promise.all([...this.#bindings].map((binding) => binding.serviceReady(context)));
        }
        catch (error) {
            if (this.#attachmentRevision === revision && sameAttachment(this.#client.attachment, attachment)) {
                publishReplacement(this.#attachmentState, { status: "degraded", sessionId: attachment.sessionId }, context);
            }
            throw error;
        }
        if (this.#attachmentRevision !== revision || !sameAttachment(this.#client.attachment, attachment)) {
            throw new Error(`Session ${attachment.sessionId} was replaced while attaching`);
        }
        const state = this.#attachmentState.value;
        if (state.status !== "attached" || state.sessionId !== attachment.sessionId) {
            publishReplacement(this.#attachmentState, { status: "attached", sessionId: attachment.sessionId }, context);
        }
    }
    async #whenDetached(revision, context) {
        await Promise.all([...this.#bindings].map((binding) => binding.serviceReady(context)));
        if (this.#attachmentRevision !== revision || this.#client.attachment !== undefined) {
            throw new Error("The Session attachment changed while detaching");
        }
        if (this.#attachmentState.value.status !== "detached") {
            publishReplacement(this.#attachmentState, { status: "detached" }, context);
        }
    }
}
/** Create the server-scoped remote service source for one presentation client. */
export function createServerServiceSource(client, options = {}) {
    return new ServerServiceSourceImpl(client, options);
}
/** Create the selected-Session remote service source for one presentation client. */
export function createSessionServiceSource(client, options = {}) {
    return new SessionServiceSourceImpl(client, options);
}
function publishReplacement(state, value, context) {
    const target = state.state;
    const replacement = value;
    for (const key of Object.keys(target)) {
        if (!Object.hasOwn(replacement, key))
            delete target[key];
    }
    Object.assign(target, replacement);
    state.publish(context);
}
function toServerConnectionState(client, attempt, error) {
    const since = new Date().toISOString();
    switch (client.connectionState) {
        case "connecting":
            return { status: "connecting", attempt };
        case "connected":
            return { status: "connected", since };
        case "disconnected":
            return {
                status: "disconnected",
                since,
                reason: error?.message ?? "Client is disconnected",
                retryAt: null,
            };
    }
}
function sameAttachment(left, right) {
    if (left === undefined || right === undefined)
        return left === right;
    return (left.serverId === right.serverId && left.sessionId === right.sessionId && left.attachmentId === right.attachmentId);
}
function throwFailures(results, message) {
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (errors.length === 1)
        throw errors[0];
    if (errors.length > 1)
        throw new AggregateError(errors, message);
}
function toError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
//# sourceMappingURL=connection.js.map