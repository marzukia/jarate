/**
 * Worker-side implementation of the `Lane` service.
 *
 * The lane, harness, and model registry stay here. Each presentation gets its own `lane.watch()`,
 * whose snapshot and event stream the harness already pairs with no gap and no duplicate, so nothing
 * here re-implements that alignment: a subscription is just a watch handle plus an id.
 */
import { randomUUID } from "node:crypto";
export class LaneService {
    #options;
    #watches = new Map();
    constructor(options) {
        this.#options = options;
    }
    /** Capture a snapshot. The harness buffers this subscription's events until `start`. */
    async watch(presentationId) {
        const { lane, context, session } = this.#options;
        const subscriptionId = randomUUID();
        const handle = await lane.watch(context);
        try {
            this.#watches.set(subscriptionId, { handle, to: presentationId });
            const snapshot = {
                sessionId: session.id,
                cwd: session.cwd,
                sessionPath: session.path,
                lane: handle.snapshot,
                models: this.#options.modelsState(),
            };
            return { subscriptionId, snapshot };
        }
        catch (error) {
            // A watcher that is never started buffers without bound.
            handle.unsubscribe();
            throw error;
        }
    }
    /** Begin delivery, draining what buffered since the snapshot. */
    async start(subscriptionId) {
        const watch = this.#watches.get(subscriptionId);
        if (!watch)
            throw new Error(`Unknown subscription: ${subscriptionId}`);
        watch.handle.start((event) => this.#options.publish(subscriptionId, watch.to, event));
    }
    async unwatch(subscriptionId) {
        this.#watches.get(subscriptionId)?.handle.unsubscribe();
        this.#watches.delete(subscriptionId);
    }
    prompt(text) {
        return this.#command(() => this.#options.lane.prompt(text, undefined, this.#options.context));
    }
    steer(text) {
        return this.#command(() => this.#options.lane.steer(text, undefined, this.#options.context));
    }
    followUp(text) {
        return this.#command(() => this.#options.lane.followUp(text, undefined, this.#options.context));
    }
    compact() {
        return this.#command(() => this.#options.lane.compact(undefined, this.#options.context));
    }
    abort() {
        return this.#command(() => this.#options.lane.abort(this.#options.context));
    }
    /**
     * The lane stores a durable identity, so the ref passes straight through. The registry lookup is
     * only a courtesy: an identity this worker cannot serve fails at generation time otherwise.
     */
    async setModel(ref) {
        if (!this.#options.models.getModel(ref.provider, ref.modelId)) {
            return { ok: false, error: `Unknown model: ${ref.provider}/${ref.modelId}` };
        }
        try {
            await this.#options.lane.setModel(ref, this.#options.context);
            return { ok: true };
        }
        catch (error) {
            return { ok: false, error: message(error) };
        }
    }
    close() {
        for (const watch of this.#watches.values())
            watch.handle.unsubscribe();
        this.#watches.clear();
    }
    async #command(run) {
        try {
            const result = await run();
            return result.ok ? { ok: true } : { ok: false, error: result.error?.message ?? "Command failed" };
        }
        catch (error) {
            return { ok: false, error: message(error) };
        }
    }
}
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=lane-service.js.map