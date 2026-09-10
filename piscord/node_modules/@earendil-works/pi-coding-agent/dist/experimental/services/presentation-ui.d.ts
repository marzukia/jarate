import { type Context } from "@earendil-works/chord";
export interface PresentationSelectItem {
    readonly value: string;
    readonly label: string;
    readonly description?: string;
}
/** Narrow process-local UI capabilities available to presentation facets. */
export interface PresentationUI {
    select(title: string, items: readonly PresentationSelectItem[], selectedValue: string | undefined, context: Context): Promise<string | undefined>;
    showStatus(message: string, context: Context): void;
}
export declare const PresentationUI: import("@earendil-works/chord").Service<PresentationUI>;
//# sourceMappingURL=presentation-ui.d.ts.map