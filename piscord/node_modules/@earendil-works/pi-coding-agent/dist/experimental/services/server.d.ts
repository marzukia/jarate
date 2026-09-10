import { type Context, type JsonValue } from "@earendil-works/chord";
import type { RoutedServerServiceHost } from "@earendil-works/pi-server";
import { type SessionCreateOptions, type SessionSummary } from "./sessions.ts";
export interface ExperimentalServerServices {
    readonly host: RoutedServerServiceHost;
    refresh(context?: Context): Promise<void>;
    dispose(): Promise<void>;
}
export declare function createExperimentalServerServices(options: {
    list(context: Context): Promise<SessionSummary[]>;
    create(createOptions: SessionCreateOptions, context: Context): Promise<SessionSummary>;
    remove(sessionId: string, context: Context): Promise<void>;
    prepareSessionPlugins(sessionId: string, packagePaths: readonly string[] | undefined, context: Context): Promise<{
        readonly packagePaths: readonly string[];
        readonly presentationPlugins: JsonValue;
    }>;
    reloadPresentationPlugins(packagePaths: readonly string[], context: Context): Promise<JsonValue>;
}): Promise<ExperimentalServerServices>;
//# sourceMappingURL=server.d.ts.map