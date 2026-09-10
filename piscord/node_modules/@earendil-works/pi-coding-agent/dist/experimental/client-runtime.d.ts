import { Client } from "@earendil-works/pi-client";
import { type UnixServerRoute } from "@earendil-works/pi-client/unix";
import { type ServerId } from "@earendil-works/pi-protocol";
import type { ClientCommand } from "../cli/experimental/commands/client.ts";
import { AgentController } from "./services/agent-controller.ts";
import { type ServerServiceSource, type SessionServiceSource } from "./services/connection.ts";
import { Models } from "./services/models.ts";
import { PresentationPlugins } from "./services/plugins.ts";
import { SessionDirectory, SessionManagement } from "./services/sessions.ts";
import { Transcript } from "./services/transcript.ts";
export type ClientRuntimeRoute = ({
    readonly transport: "unix";
} & UnixServerRoute) | {
    readonly transport: "radius";
    readonly serverId: ServerId;
};
export interface ClientRuntimeServer {
    readonly route: ClientRuntimeRoute;
    readonly client: Client;
    readonly server: ServerServiceSource;
    readonly session: SessionServiceSource;
}
export interface ActivatedClientRuntimeServer extends ClientRuntimeServer {
    readonly directory: SessionDirectory;
    readonly management: SessionManagement;
    readonly plugins: PresentationPlugins;
    readonly models: Models;
    readonly agent: AgentController;
    readonly transcript: Transcript;
}
export interface ClientRuntime {
    readonly servers: readonly ClientRuntimeServer[];
    dispose(): Promise<void>;
}
export interface OpenClientRuntimeOptions {
    /** Directory searched when --connect is omitted. Defaults to PI_SERVER_DIR or ~/.pi/server. */
    readonly directory?: string;
}
/** Open live server/session service namespaces for one experimental presentation. */
export declare function openClientRuntime(command: ClientCommand, options?: OpenClientRuntimeOptions): Promise<ClientRuntime>;
/** Acquire and connect the built-in service facades used by the non-interactive client. */
export declare function activateBuiltinClientServices(server: ClientRuntimeServer): Promise<ActivatedClientRuntimeServer>;
//# sourceMappingURL=client-runtime.d.ts.map