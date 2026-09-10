/**
 * The presentation's half of a session: one connection, services by token, one replicated snapshot.
 *
 * `Sessions` is answered by the server and `Lane`/`Models` by the worker, but both are reached
 * through this one peer, so the view never learns which host provides what.
 *
 * Alignment is not this file's problem. `lane.watch()` captures a snapshot in the worker and buffers
 * that subscription's events there; `lane.start()` drains them. Nothing can arrive before this
 * presentation holds the snapshot and knows its subscription id, so there is nothing to buffer here.
 *
 * The fold is the harness's `reduceLaneSnapshot`: a replica must not have a second opinion.
 */
import { randomUUID } from "node:crypto";
// Narrow entry: the fold is one file, so a presentation never evaluates the harness barrel.
import { reduceLaneSnapshot } from "@earendil-works/pi-agent-core/harness/runtime/reducer";
import { Lane, Models, Sessions, } from "../shared/protocol.js";
import { createPeer } from "../shared/rpc.js";
/** Attach spawns a worker when none is running; runs and other lane calls stay unbounded. */
const ATTACH_TIMEOUT_MS = 60_000;
export async function listSessions(transport) {
    const peer = createPeer(await transport.connect());
    try {
        return await peer.use(Sessions).list();
    }
    finally {
        peer.close();
    }
}
/** Attach to `sessionId`, or to a new session when it is null. */
export async function connect(transport, sessionId, cwd) {
    const peer = createPeer(await transport.connect());
    const lane = peer.use(Lane);
    /** This presentation's identity: the server routes our lane events by it. */
    const presentationId = randomUUID();
    const listeners = new Set();
    const authHandlers = new Set();
    const publish = () => {
        for (const listener of listeners)
            listener();
    };
    let snapshot;
    let subscriptionId;
    const fold = (event) => {
        if (!snapshot)
            return;
        if (reduceLaneSnapshot(snapshot.lane, event) === "rebase") {
            void resubscribe();
            return;
        }
        publish();
    };
    /** First attach and rebase are the same operation: take a new subscription, drop the old one. */
    const resubscribe = async () => {
        const previous = subscriptionId;
        const opened = await lane.watch(presentationId);
        snapshot = opened.snapshot;
        subscriptionId = opened.subscriptionId;
        publish();
        await lane.start(opened.subscriptionId);
        if (previous)
            void lane.unwatch(previous);
    };
    peer.on(Lane, (event) => {
        // Addressed to us by the server; the id check discards a superseded subscription after a rebase.
        if (event.subscriptionId === subscriptionId)
            fold(event.event);
    });
    peer.on(Models, (event) => {
        if (event.type !== "state") {
            // Login prompts and notices are not state; they drive the dialog.
            for (const handler of authHandlers)
                handler(event);
            return;
        }
        if (!snapshot)
            return;
        snapshot = { ...snapshot, models: event.state };
        publish();
    });
    await peer.use(Sessions, { timeoutMs: ATTACH_TIMEOUT_MS }).attach(sessionId, cwd, presentationId);
    await resubscribe();
    return {
        state: () => snapshot,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        onAuth: (handler) => authHandlers.add(handler),
        lane,
        models: peer.use(Models),
        close: () => peer.close(),
    };
}
//# sourceMappingURL=session.js.map