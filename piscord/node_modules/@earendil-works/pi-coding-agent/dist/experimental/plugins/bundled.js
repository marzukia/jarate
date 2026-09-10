import { combineFacetLoaders } from "@earendil-works/chord";
import { createFacetBundleArtifactLoader, createFacetBundleLoader, readFacetBundleManifest, } from "@earendil-works/chord/node";
const PRESENTATION_FACET_BUNDLES_KEY = "presentationFacetBundles";
const PI_PLUGIN_API = "@earendil-works/pi-coding-agent/experimental/plugin";
export function createSessionPluginFacetLoader(manifestPaths) {
    if (manifestPaths.length === 0)
        return undefined;
    return combineFacetLoaders(manifestPaths.map(createOptionalSessionFacetLoader));
}
function createOptionalSessionFacetLoader(manifestPath) {
    const loader = createFacetBundleLoader({
        manifestPath,
        entry: "session",
        resolveExternal: resolvePluginExternal,
    });
    return {
        async load() {
            const manifest = await readFacetBundleManifest(manifestPath);
            if (manifest.entries.session !== undefined)
                return loader.load();
            return { facets: Object.freeze([]), async dispose() { } };
        },
    };
}
export function createPresentationFacetData(artifacts) {
    return {
        [PRESENTATION_FACET_BUNDLES_KEY]: artifacts.map((artifact) => artifact),
    };
}
/** Create local loaders only from artifacts selected and sent by the connected server. */
export function createPresentationFacetLoaders(data) {
    if (data === null || Array.isArray(data) || typeof data !== "object") {
        throw new Error("Invalid presentation plugin data");
    }
    const artifacts = data[PRESENTATION_FACET_BUNDLES_KEY];
    if (artifacts === undefined)
        return [];
    if (!Array.isArray(artifacts))
        throw new Error("Invalid presentation plugin bundle list");
    return artifacts.map((artifact) => createFacetBundleArtifactLoader({ artifact, resolveExternal: resolvePluginExternal }));
}
function resolvePluginExternal(specifier) {
    if (specifier !== PI_PLUGIN_API)
        return undefined;
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    return new URL(`../plugin.${extension}`, import.meta.url).href;
}
//# sourceMappingURL=bundled.js.map