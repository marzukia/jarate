import { type Facet, type JsonValue } from "@earendil-works/chord";
import { type SlashCommandContribution, SlashCommands } from "./slash-commands.ts";
export declare class SlashCommandRegistry implements SlashCommands {
    #private;
    register(command: SlashCommandContribution): () => void;
    replace(command: SlashCommandContribution): () => void;
    list(): readonly SlashCommandContribution[];
    subscribe(listener: (commands: readonly SlashCommandContribution[]) => void): () => void;
}
export declare function createSlashCommandsRuntimeFacet(registry?: SlashCommandRegistry): Facet;
export declare function createBuiltInSlashCommandsFacet(options: {
    reloadPresentationPlugins(data: JsonValue): Promise<void>;
}): Facet;
//# sourceMappingURL=slash-commands-provider.d.ts.map