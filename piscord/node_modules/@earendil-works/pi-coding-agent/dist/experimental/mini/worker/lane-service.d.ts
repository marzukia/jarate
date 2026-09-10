/**
 * Worker-side implementation of the `Lane` service.
 *
 * The lane, harness, and model registry stay here. Each presentation gets its own `lane.watch()`,
 * whose snapshot and event stream the harness already pairs with no gap and no duplicate, so nothing
 * here re-implements that alignment: a subscription is just a watch handle plus an id.
 */
import type { AgentLane, Context, HarnessEvent } from "@earendil-works/pi-agent-core";
import type { Models } from "@earendil-works/pi-ai";
import type { CommandResult, LaneServiceApi, LaneSubscription, ModelRef, ModelsState } from "../shared/protocol.ts";
export interface LaneServiceOptions {
    lane: AgentLane;
    models: Models;
    context: Context;
    session: {
        id: string;
        cwd: string;
        path: string;
    };
    /** Model catalog state belongs to the `Models` service; the snapshot carries a copy. */
    modelsState: () => ModelsState;
    publish: (subscriptionId: string, to: string, event: HarnessEvent) => void;
}
export declare class LaneService implements LaneServiceApi {
    #private;
    constructor(options: LaneServiceOptions);
    /** Capture a snapshot. The harness buffers this subscription's events until `start`. */
    watch(presentationId: string): Promise<LaneSubscription>;
    /** Begin delivery, draining what buffered since the snapshot. */
    start(subscriptionId: string): Promise<void>;
    unwatch(subscriptionId: string): Promise<void>;
    prompt(text: string): Promise<CommandResult>;
    steer(text: string): Promise<CommandResult>;
    followUp(text: string): Promise<CommandResult>;
    compact(): Promise<CommandResult>;
    abort(): Promise<CommandResult>;
    /**
     * The lane stores a durable identity, so the ref passes straight through. The registry lookup is
     * only a courtesy: an identity this worker cannot serve fails at generation time otherwise.
     */
    setModel(ref: ModelRef): Promise<CommandResult>;
    close(): void;
}
//# sourceMappingURL=lane-service.d.ts.map