import { defineFacet } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { reduceLaneSnapshot, } from "@earendil-works/pi-agent-core";
import { Transcript } from "./transcript.js";
export function createTranscriptService(lane, createState) {
    const state = createState({ snapshot: null, event: null });
    let watch;
    let rebase;
    let rebaseError;
    const publishSnapshot = (next, event, context) => {
        state.state.snapshot = next;
        state.state.event = event;
        state.publish(context);
    };
    const scheduleRebase = (context) => {
        if (rebase !== undefined)
            return;
        const activeWatch = watch;
        if (activeWatch === undefined)
            return;
        const pending = (async () => {
            const refreshed = await activeWatch.resnapshot(context);
            publishSnapshot(refreshed, null, context);
        })();
        rebase = pending;
        void pending.then(() => {
            if (rebase === pending)
                rebase = undefined;
        }, (error) => {
            rebaseError = error instanceof Error ? error : new Error(String(error));
            if (rebase === pending)
                rebase = undefined;
        });
    };
    const onEvent = (event, context) => {
        if (rebaseError !== undefined)
            throw rebaseError;
        const forwarded = toLaneWatchEvent(event);
        if (forwarded === undefined)
            return;
        const snapshot = state.state.snapshot;
        if (snapshot === null)
            throw new Error("Transcript service is not active");
        if (reduceLaneSnapshot(snapshot, event) === "rebase")
            scheduleRebase(context);
        state.state.event = forwarded;
        state.publish(context);
    };
    return {
        service: { state },
        async activate() {
            if (watch !== undefined)
                throw new Error("Transcript service is already active");
            const opened = await lane.watch(BACKGROUND_CONTEXT);
            watch = opened;
            publishSnapshot(opened.snapshot, null, BACKGROUND_CONTEXT);
            opened.start(onEvent);
        },
        async dispose() {
            let failure;
            try {
                await rebase;
            }
            catch (error) {
                failure = error;
            }
            watch?.unsubscribe();
            watch = undefined;
            if (failure !== undefined)
                throw failure;
        },
    };
}
export function createTranscriptServiceFacet(lane) {
    return defineFacet({
        id: "@pi/transcript",
        setup(env) {
            const runtime = createTranscriptService(lane, env.replicatedState);
            env.provide(Transcript, runtime.service);
            env.onActivate(() => runtime.activate());
            env.own(() => runtime.dispose());
        },
    });
}
function toLaneWatchEvent(event) {
    switch (event.type) {
        case "handler_error":
        case "turn_start":
        case "turn_end":
        case "value_update":
        case "lane_created":
            return undefined;
        case "config_update":
            if (event.property !== "model" && event.property !== "thinkingLevel" && event.property !== "activeTools") {
                return undefined;
            }
            return event;
        case "message_update": {
            if (event.message.role !== "assistant") {
                throw new TypeError("Harness message_update did not carry an assistant message");
            }
            const { event: _providerEvent, ...update } = event;
            return update;
        }
        default:
            return event;
    }
}
//# sourceMappingURL=transcript-provider.js.map