/**
 * The presentation host: find or start the session server, attach to a session, run the view.
 */
export interface TuiOptions {
    cwd?: string;
    continueSession?: boolean;
}
export declare function runTui(options?: TuiOptions): Promise<void>;
//# sourceMappingURL=run.d.ts.map