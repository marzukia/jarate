import { Command } from "../command.ts";
import { type AuthInput, type TransportAddress } from "../command-options.ts";
export interface ClientCommand {
    readonly command: "client";
    readonly auth?: AuthInput;
    readonly connect?: TransportAddress;
    readonly sessionId?: string;
    readonly continue?: boolean;
    readonly resume?: boolean;
    readonly provider?: string;
    readonly model?: string;
    readonly pluginPackages?: readonly string[];
    readonly prompt?: string;
}
export interface ClientCommandContext {
    runClient(command: ClientCommand): void | Promise<void>;
}
export declare const clientCommand: Command<ClientCommand, ClientCommandContext, ClientCommand>;
//# sourceMappingURL=client.d.ts.map