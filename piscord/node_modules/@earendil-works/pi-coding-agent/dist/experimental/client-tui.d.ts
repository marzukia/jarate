import { type FacetLoader } from "@earendil-works/chord";
import { type Component, type TUI } from "@earendil-works/pi-tui";
import type { ClientCommand } from "../cli/experimental/commands/client.ts";
import { type OpenClientRuntimeOptions } from "./client-runtime.ts";
import type { ServerServiceSource, SessionServiceSource } from "./services/connection.ts";
export interface RunClientTuiOptions extends OpenClientRuntimeOptions {
    readonly facetLoader?: FacetLoader;
}
export interface ClientTuiServer {
    readonly serverId: string;
    readonly radius: boolean;
    readonly server: ServerServiceSource;
    readonly session: SessionServiceSource;
}
/** Service-only presentation driven by a replicated main-lane snapshot. */
export declare class ExperimentalClientTui implements Component {
    #private;
    private constructor();
    static create(options: {
        readonly command: ClientCommand;
        readonly ui: TUI;
        readonly servers: readonly ClientTuiServer[];
        readonly facetLoader?: FacetLoader;
        requestRender(): void;
        finish(): void;
    }): Promise<ExperimentalClientTui>;
    get layoutRoot(): Component;
    render(width: number): string[];
    handleInput(data: string): void;
    invalidate(): void;
    dispose(): void;
    refreshTheme(): void;
    showError(error: string): void;
    close(): Promise<void>;
}
export declare function runClientTui(command: ClientCommand, options?: RunClientTuiOptions): Promise<void>;
//# sourceMappingURL=client-tui.d.ts.map