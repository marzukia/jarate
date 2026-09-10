import { type ServerId } from "@earendil-works/pi-protocol";
import { Command } from "../command.ts";
import { type AuthInput } from "../command-options.ts";
export interface ServerCommand {
    readonly command: "server";
    readonly auth?: AuthInput;
    readonly provider?: string;
    readonly model?: string;
    readonly pluginPackages?: readonly string[];
    readonly serverId?: ServerId;
    readonly sessionDir?: string;
}
export interface ServerCommandContext {
    runServer(command: ServerCommand): void | Promise<void>;
}
export declare const serverCommand: Command<ServerCommand, ServerCommandContext, ServerCommand>;
//# sourceMappingURL=server.d.ts.map