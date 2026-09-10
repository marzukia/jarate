/**
 * Worker-side implementation of the `Models` service.
 *
 * `ModelRuntime`, `Model`, and provider objects stay here. What leaves is a serializable catalog and
 * account list, plus login prompts and notices as data.
 */
import type { ModelRuntime } from "../../../core/model-runtime.ts";
import type { CommandResult, ModelsEvent, ModelsServiceApi, ModelsState, ProviderAccount } from "../shared/protocol.ts";
export declare class ModelsService implements ModelsServiceApi {
    #private;
    constructor(runtime: ModelRuntime, publish: (event: ModelsEvent) => void);
    get state(): ModelsState;
    refresh(): Promise<CommandResult>;
    /** Prompts and notices travel to the presentation as events; answers come back via `authReply`. */
    login(providerId: string, authType: ProviderAccount["authType"]): Promise<CommandResult>;
    authReply(requestId: string, answer: string | null): Promise<void>;
    logout(providerId: string): Promise<CommandResult>;
}
//# sourceMappingURL=models-service.d.ts.map