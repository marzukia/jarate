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
import { type AuthEventPayload, type LaneServiceApi, type ModelsServiceApi, type Remote, type SessionSnapshot, type SessionSummary } from "../shared/protocol.ts";
import type { Transport } from "../shared/transport.ts";
export interface AttachedSession {
    state(): SessionSnapshot;
    subscribe(listener: () => void): () => void;
    onAuth(handler: (event: AuthEventPayload) => void): void;
    readonly lane: Remote<LaneServiceApi>;
    readonly models: Remote<ModelsServiceApi>;
    close(): void;
}
export declare function listSessions(transport: Transport): Promise<SessionSummary[]>;
/** Attach to `sessionId`, or to a new session when it is null. */
export declare function connect(transport: Transport, sessionId: string | null, cwd: string): Promise<AttachedSession>;
//# sourceMappingURL=session.d.ts.map