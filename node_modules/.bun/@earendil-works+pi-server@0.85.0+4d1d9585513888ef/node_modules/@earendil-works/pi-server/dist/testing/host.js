import { BACKGROUND_CONTEXT, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { SessionAmbiguousError, SessionNotFoundError } from "../errors.js";
export class Deferred {
    promise;
    resolvePromise;
    constructor() {
        this.promise = new Promise((resolve) => {
            this.resolvePromise = resolve;
        });
    }
    resolve(value) {
        this.resolvePromise(value);
    }
}
export class TestHarness {
    session;
    closed = new Deferred();
    #termination = new Deferred();
    terminated = this.#termination.promise;
    attachedClients = 0;
    attachmentReleaseCount = 0;
    closeCount = 0;
    serviceCalls = [];
    failAttachmentRelease;
    failClose;
    nextServiceError;
    nextServiceResult = { ok: true };
    nextCloseGate;
    nextServiceGate;
    constructor(session) {
        this.session = session;
    }
    attachClient(_context) {
        this.attachedClients += 1;
        let released = false;
        return {
            invokeService: (call) => this.invokeService(call),
            release: (_context) => {
                if (released)
                    return;
                this.attachmentReleaseCount += 1;
                if (this.failAttachmentRelease)
                    throw this.failAttachmentRelease;
                released = true;
                this.attachedClients -= 1;
            },
        };
    }
    async invokeService(call) {
        this.serviceCalls.push(call);
        if (this.nextServiceError) {
            const error = this.nextServiceError;
            this.nextServiceError = undefined;
            throw error;
        }
        const gate = this.nextServiceGate;
        if (gate) {
            this.nextServiceGate = undefined;
            gate.entered.resolve(undefined);
            await gate.release.promise;
        }
        const result = this.nextServiceResult;
        this.nextServiceResult = { ok: true };
        return result;
    }
    async close(context) {
        this.closeCount += 1;
        const gate = this.nextCloseGate;
        if (gate) {
            this.nextCloseGate = undefined;
            gate.entered.resolve(undefined);
            await gate.release.promise;
        }
        if (this.failClose) {
            const error = this.failClose;
            this.failClose = undefined;
            throw error;
        }
        await this.session.close(context);
        this.closed.resolve(undefined);
        this.#termination.resolve(undefined);
    }
    async terminate(error) {
        await this.session.close(BACKGROUND_CONTEXT);
        this.#termination.resolve(error);
    }
    gateNextClose() {
        const gate = { entered: new Deferred(), release: new Deferred() };
        this.nextCloseGate = gate;
        return gate;
    }
    gateNextServiceCall() {
        const gate = { entered: new Deferred(), release: new Deferred() };
        this.nextServiceGate = gate;
        return gate;
    }
}
export function createTestServerServices() {
    return {
        attachClient(presentation) {
            return {
                async invokeService(call, _publish, context) {
                    if (call.instance === undefined &&
                        call.serviceId === "pi.session-management" &&
                        call.member === "attach" &&
                        call.args.length === 1 &&
                        typeof call.args[0] === "string") {
                        await presentation.attachSession(call.args[0], context);
                        return null;
                    }
                    if (call.instance === undefined &&
                        call.serviceId === "pi.session-management" &&
                        call.member === "detach" &&
                        call.args.length === 0) {
                        await presentation.detachSession(context);
                        return null;
                    }
                    throw new Error(`Unsupported test server service ${call.serviceId}.${call.member}`);
                },
                release() { },
            };
        },
    };
}
export class TestServerHost {
    serverServices = createTestServerServices();
    repo = new MemorySessionRepo({ now: () => 1 });
    harnesses = new Map();
    openSessionCount = 0;
    nextOpenSessionError;
    nextHarnessCloseError;
    nextOpenSessionGate;
    async resolveSession(sessionId, context) {
        const matches = (await this.repo.list(undefined, context)).filter(({ id }) => id === sessionId);
        if (matches.length === 0)
            throw new SessionNotFoundError(`Unknown session: ${sessionId}`);
        if (matches.length > 1)
            throw new SessionAmbiguousError();
        return matches[0];
    }
    async openSession(metadata, context) {
        this.openSessionCount += 1;
        const gate = this.nextOpenSessionGate;
        if (gate) {
            this.nextOpenSessionGate = undefined;
            gate.entered.resolve(undefined);
            await gate.release.promise;
        }
        const session = await this.repo.open(metadata, context);
        try {
            if (this.nextOpenSessionError) {
                const error = this.nextOpenSessionError;
                this.nextOpenSessionError = undefined;
                throw error;
            }
            const harness = new TestHarness(session);
            if (this.nextHarnessCloseError) {
                harness.failClose = this.nextHarnessCloseError;
                this.nextHarnessCloseError = undefined;
            }
            const harnesses = this.harnesses.get(metadata.id) ?? [];
            harnesses.push(harness);
            this.harnesses.set(metadata.id, harnesses);
            return harness;
        }
        catch (error) {
            await session.close(context);
            throw error;
        }
    }
    async seed(id = "session-1", parentSessionId) {
        const session = await this.repo.create({ id, parentSessionId }, BACKGROUND_CONTEXT);
        const metadata = session.metadata;
        await session.close(BACKGROUND_CONTEXT);
        return metadata;
    }
    gateNextOpenSession() {
        const gate = { entered: new Deferred(), release: new Deferred() };
        this.nextOpenSessionGate = gate;
        return gate;
    }
    latestHarness(id) {
        const harnesses = this.harnesses.get(id);
        if (!harnesses?.length)
            throw new Error(`No harness for ${id}`);
        return harnesses.at(-1);
    }
}
//# sourceMappingURL=host.js.map