import { type FacetLoader, type JsonValue } from "@earendil-works/chord";
import { type FacetBundleArtifact } from "@earendil-works/chord/node";
export declare function createSessionPluginFacetLoader(manifestPaths: readonly string[]): FacetLoader | undefined;
export declare function createPresentationFacetData(artifacts: readonly FacetBundleArtifact[]): JsonValue;
/** Create local loaders only from artifacts selected and sent by the connected server. */
export declare function createPresentationFacetLoaders(data: JsonValue): readonly FacetLoader[];
//# sourceMappingURL=bundled.d.ts.map