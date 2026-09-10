import { Command } from "./command.ts";
import { type ClientCommandContext } from "./commands/client.ts";
import { type ServerCommandContext } from "./commands/server.ts";
interface ExperimentalCommandGroup {
    readonly command: "experimental";
}
export type CliContext = ServerCommandContext & ClientCommandContext;
export declare const cli: Command<ExperimentalCommandGroup, ServerCommandContext & ClientCommandContext, import("./commands/client.ts").ClientCommand | ExperimentalCommandGroup | import("./commands/server.ts").ServerCommand>;
export {};
//# sourceMappingURL=cli.d.ts.map