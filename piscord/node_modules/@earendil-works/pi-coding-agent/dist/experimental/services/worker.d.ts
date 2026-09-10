import { type Context, type FacetLoader, type JsonValue, type ServiceCall, type ServiceProviderUpdate } from "@earendil-works/chord";
import type { AgentHarness, AgentLane } from "@earendil-works/pi-agent-core";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
export interface SessionWorkerRuntime {
    readonly harness: AgentHarness;
    readonly lane?: AgentLane;
    readonly modelRuntime?: ModelRuntime;
    readonly settingsManager?: SettingsManager;
    readonly facetLoader?: FacetLoader;
}
export interface WorkerServiceScope {
    readonly serverConnectionId: string;
    readonly attachmentId: string;
}
export interface SessionWorkerServices {
    invoke(call: ServiceCall, scope: WorkerServiceScope, context: Context): Promise<JsonValue | undefined>;
    removeSubscriptions(matches: (scope: WorkerServiceScope) => boolean): void;
    dispose(): Promise<void>;
}
export declare function createSessionWorkerServices(options: {
    readonly lane: AgentLane;
    readonly modelRuntime: ModelRuntime | undefined;
    readonly settingsManager?: SettingsManager;
    readonly facetLoader?: FacetLoader;
    publish(scope: WorkerServiceScope, subscriptionId: string, update: ServiceProviderUpdate): Promise<void>;
}): Promise<SessionWorkerServices>;
//# sourceMappingURL=worker.d.ts.map