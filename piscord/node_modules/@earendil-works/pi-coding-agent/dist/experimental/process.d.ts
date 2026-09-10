import { type ChildProcess } from "node:child_process";
export declare const INTERNAL_PROCESS_ENV = "__PI_INTERNAL_SPAWN";
export type InternalProcessRole = "coordinator" | "server" | "session-worker";
/** Detect a directly executed source or unbundled internal-process module. */
export declare function isDirectInternalProcessEntry(moduleUrl: string): boolean;
/** Read and validate an internal process role without consuming it. */
export declare function getInternalProcessRole(): InternalProcessRole | undefined;
/** Read, validate, and remove the role so descendants do not inherit it. */
export declare function consumeInternalProcessRole(): InternalProcessRole | undefined;
export interface InternalProcessSpawnOptions {
    readonly entryUrl?: URL;
    readonly env?: NodeJS.ProcessEnv;
}
/** Spawn a detached Pi-owned process consistently across Node and compiled Bun. */
export declare function spawnInternalProcess(role: InternalProcessRole, args: readonly string[], options?: InternalProcessSpawnOptions): ChildProcess;
/** Force a spawned internal process to exit and wait until it can no longer take ownership. */
export declare function terminateInternalProcess(child: ChildProcess): Promise<void>;
export declare const MAX_CONTROL_LINE_BYTES: number;
export declare function encodeControlLine(message: unknown): string;
//# sourceMappingURL=process.d.ts.map