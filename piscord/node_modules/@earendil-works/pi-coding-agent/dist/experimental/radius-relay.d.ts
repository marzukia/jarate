import type { ByteTransportFactory, Client } from "@earendil-works/pi-client";
import { type ServerId } from "@earendil-works/pi-protocol";
import type { Server } from "@earendil-works/pi-server";
import type { RadiusRelayAuthResolver } from "./radius-auth.ts";
export declare const RADIUS_RELAY_HOST_SUBPROTOCOL = "pi-session-relay.host.v1";
export declare const RADIUS_RELAY_CLIENT_SUBPROTOCOL = "pi-session-relay.client.v1";
interface RadiusRelayMessageEvent extends Event {
    readonly data: unknown;
}
interface RadiusRelayCloseEvent extends Event {
    readonly code: number;
    readonly reason: string;
}
interface RadiusRelayErrorEvent extends Event {
    readonly error?: unknown;
    readonly message?: string;
}
export interface RadiusRelayWebSocket {
    binaryType: "arraybuffer" | "blob";
    readonly bufferedAmount: number;
    readonly protocol: string;
    readonly readyState: number;
    readonly OPEN: number;
    send(data: string | ArrayBuffer): void;
    close(code?: number, reason?: string): void;
    addEventListener(type: "open", listener: (event: Event) => void, options?: {
        once?: boolean;
    }): void;
    addEventListener(type: "message", listener: (event: RadiusRelayMessageEvent) => void, options?: {
        once?: boolean;
    }): void;
    addEventListener(type: "close", listener: (event: RadiusRelayCloseEvent) => void, options?: {
        once?: boolean;
    }): void;
    addEventListener(type: "error", listener: (event: RadiusRelayErrorEvent) => void, options?: {
        once?: boolean;
    }): void;
    removeEventListener(type: "open", listener: (event: Event) => void): void;
    removeEventListener(type: "message", listener: (event: RadiusRelayMessageEvent) => void): void;
    removeEventListener(type: "close", listener: (event: RadiusRelayCloseEvent) => void): void;
    removeEventListener(type: "error", listener: (event: RadiusRelayErrorEvent) => void): void;
}
export type RadiusRelayWebSocketFactory = (options: {
    readonly url: string;
    readonly protocol: string;
    readonly authorization: string;
}) => RadiusRelayWebSocket;
export type RadiusRelayHostStatus = {
    readonly status: "not_authenticated";
} | {
    readonly status: "connecting";
} | {
    readonly status: "connected";
} | {
    readonly status: "retrying";
    readonly error: string;
};
export interface RadiusRelayHostOptions {
    readonly serverId: ServerId;
    readonly server: Pick<Server, "accept">;
    readonly auth: RadiusRelayAuthResolver;
    readonly webSocketFactory?: RadiusRelayWebSocketFactory;
    readonly onStatus?: (status: RadiusRelayHostStatus) => void;
}
/** Maintain the experimental server's multiplexed, authenticated Radius host connection. */
export declare class RadiusRelayHost {
    #private;
    constructor(options: RadiusRelayHostOptions);
    start(): void;
    close(): Promise<void>;
}
export declare function createRadiusClientTransportFactory(options: {
    readonly serverId: ServerId;
    readonly auth: RadiusRelayAuthResolver;
    readonly webSocketFactory?: RadiusRelayWebSocketFactory;
}): ByteTransportFactory;
type RadiusReconnectClient = Pick<Client, "attachment" | "connected" | "connectionState" | "disconnect" | "onAttachmentChange" | "onConnectionStateChange" | "reconnect">;
/** Reconnect one established Radius client and restore its last selected Session. */
export declare class RadiusClientReconnect {
    #private;
    constructor(client: RadiusReconnectClient, reattach: (sessionId: string) => Promise<void>);
    dispose(): Promise<void>;
}
export declare function encodeRelayDataFrame(connectionId: string, payload: Uint8Array): ArrayBuffer;
export declare function parseRelayDataFrame(frame: ArrayBuffer): {
    readonly connectionId: string;
    readonly payload: ArrayBuffer;
} | undefined;
export {};
//# sourceMappingURL=radius-relay.d.ts.map