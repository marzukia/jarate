/**
 * Session worker: one process per session.
 *
 * It owns every live object — storage, harness, lane, model runtime — and publishes them only as the
 * `Lane` and `Models` services. It speaks JSON over its stdio pipes to the server that spawned it,
 * and can call server services (`Sessions`) over the same peer.
 */
/** Run one session worker until its stdio closes. `sessionId` undefined creates a new session. */
export declare function runSessionWorker(options: {
    sessionsRoot: string;
    sessionId?: string;
    cwd: string;
}): Promise<void>;
//# sourceMappingURL=run.d.ts.map