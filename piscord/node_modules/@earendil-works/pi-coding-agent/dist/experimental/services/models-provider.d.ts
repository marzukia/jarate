import { type Context, type Facet, type MutableReplicatedState } from "@earendil-works/chord";
import type { AgentLane } from "@earendil-works/pi-agent-core";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { type Models as ModelsService, type ModelsState } from "./models.ts";
export interface ModelsServiceRuntime {
    readonly service: ModelsService;
    activate(context: Context): Promise<void>;
}
export declare function createModelsService(lane: AgentLane, modelRuntime: ModelRuntime | undefined, settingsManager: SettingsManager | undefined, createState: (initial: ModelsState) => MutableReplicatedState<ModelsState>): ModelsServiceRuntime;
export declare function createModelsServiceFacet(options: {
    readonly lane: AgentLane;
    readonly modelRuntime: ModelRuntime | undefined;
    readonly settingsManager?: SettingsManager;
}): Facet;
//# sourceMappingURL=models-provider.d.ts.map