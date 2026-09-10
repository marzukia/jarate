import { Client } from "@earendil-works/pi-client";
import { type UnixServerRoute } from "@earendil-works/pi-client/unix";
import { type ServerId } from "@earendil-works/pi-protocol";
import { type Server } from "@earendil-works/pi-server";
import type { AuthInput } from "../cli/experimental/command-options.ts";
import { type RadiusRelayHostStatus } from "./radius-relay.ts";
export declare const ENV_SERVER_DIR = "PI_SERVER_DIR";
export declare const ENV_SERVER_ID = "PI_SERVER_ID";
export declare function resolveServerDirectory(directory?: string): string;
export declare function ensurePrivateServerDirectory(directory: string): Promise<void>;
export declare function resolveSessionDirectory(sessionDir?: string): string;
export interface ServerProfile {
    readonly serverId: ServerId;
    release(): Promise<void>;
}
/** Lock one logical server ID in a shared experimental server directory. */
export declare function acquireServerProfile(directory: string, requestedServerId?: string): Promise<ServerProfile>;
export interface ActivatedServer {
    readonly client: Client;
    readonly route: UnixServerRoute;
}
export interface ActivateServerOptions {
    readonly directory: string;
    readonly requestedServerId?: ServerId | string;
    readonly sessionDir: string;
    readonly provider?: string;
    readonly model?: string;
}
/** Ensure the selected logical server is reachable, launching the current Pi installation if needed. */
export declare function activateServer(options: ActivateServerOptions): Promise<ActivatedServer>;
export declare function acquireServerActivation(directory: string, serverId: ServerId): Promise<() => Promise<void>>;
/** Reconcile operator, startup, client, and worker holds for one server generation. */
export declare class ServerLifetime {
    #private;
    constructor(keepAlive: boolean);
    start(retire: () => void): void;
    setConnectionCount(count: number): void;
    setWorkerCount(count: number): void;
    stop(): void;
}
export interface RunningServer {
    readonly serverId: string;
    readonly sessionDir: string;
    readonly socketPath: string;
    readonly server: Server;
    readonly workerPids: ReadonlyMap<string, number>;
    readonly closed: Promise<void>;
    close(): Promise<void>;
}
export interface StartServerOptions {
    /** Server profile and socket directory. Defaults to PI_SERVER_DIR or ~/.pi/server. */
    readonly directory?: string;
    /** Logical service ID. Defaults to PI_SERVER_ID or the directory's default-server-id. */
    readonly serverId?: ServerId;
    /** Durable session directory. Defaults to the experimental directory under the configured agent directory. */
    readonly sessionDir?: string;
    /** Optional provider for an explicitly selected Session worker model. */
    readonly provider?: string;
    /** Optional model override for newly started Session workers. */
    readonly model?: string;
    /** Hold the server open without client or Session demand. Defaults to true for foreground servers. */
    readonly keepAlive?: boolean;
    /** Optional explicit Radius credential. Stored Radius auth is used when omitted. */
    readonly relayAuth?: AuthInput;
    /** Explicit plugin packages. Undefined restores the logical server profile; an empty list clears it. */
    readonly pluginPackages?: readonly string[];
    readonly onRelayStatus?: (status: RadiusRelayHostStatus) => void;
}
/** Start a replaceable experimental server behind the stable coordinator endpoint. */
export declare function startServer(options?: StartServerOptions): Promise<RunningServer>;
/** Start an operator-held server while serializing against automatic cold activation. */
export declare function startForegroundServer(options?: Omit<StartServerOptions, "keepAlive">): Promise<RunningServer>;
/** Run an automatically activated server until its client and Session demand disappears. */
export declare function runServerProcess(args: readonly string[]): Promise<void>;
//# sourceMappingURL=server.d.ts.map