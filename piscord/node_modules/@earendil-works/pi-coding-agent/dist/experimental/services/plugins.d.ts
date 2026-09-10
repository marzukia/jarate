import { type Context, type JsonValue } from "@earendil-works/chord";
/** Server-built plugin generations available to presentations. */
export interface PresentationPlugins {
    prepareSession(request: {
        readonly sessionId: string;
        readonly packagePaths: readonly string[] | null;
    }, context: Context): Promise<JsonValue>;
    reload(context: Context): Promise<JsonValue>;
}
export declare const PresentationPlugins: import("@earendil-works/chord").Service<PresentationPlugins>;
/** Plugin facets hosted in the currently attached Session worker. */
export interface SessionPlugins {
    reload(context: Context): Promise<void>;
}
export declare const SessionPlugins: import("@earendil-works/chord").Service<SessionPlugins>;
//# sourceMappingURL=plugins.d.ts.map