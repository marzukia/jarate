/** Service contracts and everything that crosses the wire. */
export function defineService(name) {
    return { name };
}
/** Provided by the worker. One subscription per presentation; `watch` again to rebase. */
export const Lane = defineService("lane");
/** Provided by the worker. Small enough to publish whole. */
export const Models = defineService("models");
/** Provided by the worker, consumed only by the server. */
export const Worker = defineService("worker");
/** Provided by the server. */
export const Sessions = defineService("sessions");
//# sourceMappingURL=protocol.js.map