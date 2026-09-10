import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getPackageDir, isBunBinary, isBundledNode } from "../config.js";
export const INTERNAL_PROCESS_ENV = "__PI_INTERNAL_SPAWN";
/** Detect a directly executed source or unbundled internal-process module. */
export function isDirectInternalProcessEntry(moduleUrl) {
    return (!isBunBinary &&
        !isBundledNode &&
        process.argv[1] !== undefined &&
        resolve(process.argv[1]) === fileURLToPath(moduleUrl));
}
/** Read and validate an internal process role without consuming it. */
export function getInternalProcessRole() {
    const role = process.env[INTERNAL_PROCESS_ENV];
    if (role === undefined)
        return undefined;
    if (role === "coordinator" || role === "server" || role === "session-worker")
        return role;
    throw new Error(`Unsupported internal process role: ${role}`);
}
/** Read, validate, and remove the role so descendants do not inherit it. */
export function consumeInternalProcessRole() {
    const role = getInternalProcessRole();
    delete process.env[INTERNAL_PROCESS_ENV];
    return role;
}
/** Spawn a detached Pi-owned process consistently across Node and compiled Bun. */
export function spawnInternalProcess(role, args, options = {}) {
    if (isBunBinary && options.entryUrl) {
        throw new Error("A compiled Bun executable cannot launch an external internal-process entrypoint");
    }
    const entryUrl = defaultEntryUrl(role, options.entryUrl);
    const sourceRuntimeArgs = import.meta.url.endsWith(".ts")
        ? ["--import", fileURLToPath(new URL("source-resolver.ts", import.meta.url))]
        : [];
    const child = spawn(process.execPath, isBunBinary ? [...args] : [...sourceRuntimeArgs, fileURLToPath(entryUrl), ...args], {
        cwd: process.cwd(),
        detached: true,
        env: {
            ...process.env,
            ...options.env,
            [INTERNAL_PROCESS_ENV]: role,
        },
        stdio: "ignore",
        windowsHide: true,
    });
    child.unref();
    return child;
}
/** Force a spawned internal process to exit and wait until it can no longer take ownership. */
export async function terminateInternalProcess(child) {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null)
        return;
    const terminated = new Promise((resolve) => {
        child.once("exit", () => resolve());
        child.once("error", () => resolve());
    });
    child.kill("SIGKILL");
    await terminated;
}
function defaultEntryUrl(role, override) {
    if (override)
        return override;
    if (isBundledNode) {
        const entry = role === "coordinator" ? "coordinator.js" : "cli.js";
        return pathToFileURL(join(getPackageDir(), "dist", "bundle", entry));
    }
    const javaScript = import.meta.url.endsWith(".js");
    if (role === "coordinator") {
        return new URL(javaScript ? "coordinator.js" : "coordinator.ts", import.meta.url);
    }
    if (role === "server") {
        return new URL(javaScript ? "server.js" : "server.ts", import.meta.url);
    }
    return new URL(javaScript ? "session-worker.js" : "session-worker.ts", import.meta.url);
}
export const MAX_CONTROL_LINE_BYTES = 128 * 1024 * 1024;
export function encodeControlLine(message) {
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > MAX_CONTROL_LINE_BYTES)
        throw new Error("Internal control message is too large");
    return line;
}
//# sourceMappingURL=process.js.map