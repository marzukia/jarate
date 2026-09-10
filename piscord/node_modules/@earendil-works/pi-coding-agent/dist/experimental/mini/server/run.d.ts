/**
 * Session server: accepts client connections, spawns one worker process per session, routes.
 *
 * It provides `Sessions` and holds no agent state. Any other service name is forwarded to the worker
 * the calling client is attached to, and every worker event is pushed back to that worker's clients.
 * Workers reach `Sessions` over the same peer, because the routing rule is symmetric.
 */
import { type Transport } from "../shared/transport.ts";
export declare function runServer(options: {
    transport: Transport;
    sessionsRoot: string;
}): Promise<void>;
//# sourceMappingURL=run.d.ts.map