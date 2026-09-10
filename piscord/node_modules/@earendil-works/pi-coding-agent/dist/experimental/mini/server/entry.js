/** Server process entry: `node server/entry.ts <socketPath> <sessionsRoot>`. Spawned detached by the CLI. */
import { socketTransport } from "../shared/transport.js";
import { runServer } from "./run.js";
const [socketPath, sessionsRoot] = process.argv.slice(2);
if (!socketPath || !sessionsRoot)
    throw new Error("Server requires <socketPath> <sessionsRoot>");
void runServer({ transport: socketTransport(socketPath), sessionsRoot }).catch((error) => {
    console.error(error);
    process.exit(1);
});
//# sourceMappingURL=entry.js.map