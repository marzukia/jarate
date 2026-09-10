import { type JsonValue, type RemoteServiceTransport, type ServiceCall, type ServiceCatalogueEntry, type ServiceMode, type ServiceProviderUpdate } from "@earendil-works/chord";
import { type RpcTarget, type ServerHello, type SessionTarget } from "@earendil-works/pi-protocol";
import type { AttachmentChangeListener, ClientOptions, ConnectionState, ConnectionStateChange, ServiceSubscription, Unsubscribe } from "./types.ts";
type ServiceResult = JsonValue | undefined;
export declare class Client {
    #private;
    constructor(options: ClientOptions);
    get disposed(): boolean;
    get connectionState(): ConnectionState;
    get connected(): boolean;
    get serverId(): string;
    get hello(): ServerHello | undefined;
    get attachment(): SessionTarget | undefined;
    static connect(options: ClientOptions): Promise<Client>;
    connect(): Promise<ServerHello>;
    reconnect(): Promise<ServerHello>;
    disconnect(reason?: string): void;
    onConnectionStateChange(listener: (change: ConnectionStateChange) => void): Unsubscribe;
    onAttachmentChange(listener: AttachmentChangeListener): Unsubscribe;
    /** Invoke one low-level protocol call against an explicit routed target. */
    request(target: RpcTarget, call: ServiceCall, signal?: AbortSignal): Promise<ServiceResult>;
    serviceCatalogue(target: RpcTarget, signal?: AbortSignal): Promise<readonly ServiceCatalogueEntry[]>;
    subscribeService(target: RpcTarget, serviceId: string, mode: ServiceMode, listener: (update: ServiceProviderUpdate) => void | Promise<void>, signal?: AbortSignal): Promise<ServiceSubscription>;
    dispose(): Promise<void>;
    [Symbol.asyncDispose](): Promise<void>;
}
/** Adapts a lazily resolved routed client target to a Chord service transport. */
export declare function createClientServiceTransport(client: Client, getTarget: () => RpcTarget | undefined): RemoteServiceTransport;
export {};
//# sourceMappingURL=client.d.ts.map