#!/usr/bin/env node
import { runCoordinatorProcess } from "./coordinator.js";
import { consumeInternalProcessRole } from "./process.js";
const role = consumeInternalProcessRole();
if (role !== "coordinator")
    throw new Error("Coordinator entrypoint requires an internal coordinator invocation");
void runCoordinatorProcess(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exit(1);
});
//# sourceMappingURL=coordinator-entry.js.map