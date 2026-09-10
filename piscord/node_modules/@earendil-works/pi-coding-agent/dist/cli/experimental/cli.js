import { Command } from "./command.js";
import { clientCommand } from "./commands/client.js";
import { serverCommand } from "./commands/server.js";
const experimentalCommand = new Command("experimental").build(() => ({
    ok: false,
    errors: ["Expected experimental command: server or client"],
}));
export const cli = experimentalCommand.command(serverCommand).command(clientCommand);
//# sourceMappingURL=cli.js.map