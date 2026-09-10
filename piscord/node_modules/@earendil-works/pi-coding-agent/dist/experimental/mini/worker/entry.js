/** Session worker process entry: `node worker/entry.ts <sessionsRoot> <cwd> [sessionId]`. */
import { runSessionWorker } from "./run.js";
const [sessionsRoot, cwd, sessionId] = process.argv.slice(2);
if (!sessionsRoot || !cwd)
    throw new Error("Session worker requires <sessionsRoot> <cwd> [sessionId]");
void runSessionWorker({ sessionsRoot, cwd, ...(sessionId === undefined ? {} : { sessionId }) }).catch((error) => {
    console.error(error);
    process.exit(1);
});
//# sourceMappingURL=entry.js.map