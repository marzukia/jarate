/**
 * The whole protocol: call, result, error, cancel, event, ping. Plus named services and one routing
 * rule.
 *
 * A peer provides any number of services and uses the other side's. A call for a service this peer
 * does not provide goes to `forward`, which is what makes the server transparent: a TUI uses
 * `lane.prompt`, the server does not provide `lane`, so it hands the call to the attached worker.
 * The same rule lets a worker use `sessions.list` back through the server.
 */
import type { Remote, ServiceToken } from "./protocol.ts";
import type { Connection } from "./transport.ts";
export type Forward = (method: string, args: unknown[]) => Promise<unknown>;
export interface CallOptions {
    /** Abandon the call and tell the peer to stop. */
    signal?: AbortSignal;
    /** Reject if the peer has not answered in time. Omit for calls with no bounded duration. */
    timeoutMs?: number;
}
export interface PeerOptions {
    /** Handles calls for services this peer does not provide. */
    forward?: Forward;
    /** Silence tolerated before the peer is declared gone. Default 15s; 0 disables liveness. */
    deadMs?: number;
}
export interface RpcPeer {
    /** Register an implementation and announce the name to the other side. */
    provide<TApi extends object, TEvent>(token: ServiceToken<TApi, TEvent>, implementation: TApi): void;
    /** Services this peer provides. */
    readonly provided: ReadonlySet<string>;
    /** Services the other side announced. */
    readonly announced: ReadonlySet<string>;
    /** Use a service, wherever it is provided: this peer's other side, or its next hop. */
    use<TApi extends object, TEvent>(token: ServiceToken<TApi, TEvent>, options?: CallOptions): Remote<TApi>;
    /** Publish to everyone listening on the other side. */
    emit<TApi extends object, TEvent>(token: ServiceToken<TApi, TEvent>, event: TEvent): void;
    /** Publish for one destination. A router delivers it there instead of broadcasting. */
    emitTo<TApi extends object, TEvent>(token: ServiceToken<TApi, TEvent>, event: TEvent, to: string): void;
    on<TApi extends object, TEvent>(token: ServiceToken<TApi, TEvent>, handler: (event: TEvent) => void): void;
    /** Router half of the event channel: observe and republish without knowing the service. */
    onEvent(handler: (service: string, payload: unknown, to: string | undefined) => void): void;
    emitRaw(service: string, payload: unknown, to?: string): void;
    call(method: string, ...args: unknown[]): Promise<unknown>;
    callWith(options: CallOptions, method: string, ...args: unknown[]): Promise<unknown>;
    onClose(handler: () => void): void;
    close(): void;
}
/** A bidirectional peer on one connection. */
export declare function createPeer(connection: Connection, options?: PeerOptions): RpcPeer;
//# sourceMappingURL=rpc.d.ts.map