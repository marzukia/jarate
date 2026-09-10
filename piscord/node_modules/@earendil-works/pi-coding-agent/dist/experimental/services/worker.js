import { createFacetHost, createRemoteServiceEndpoint, createStaticFacetLoader, defineFacet, } from "@earendil-works/chord";
import { AgentController } from "./agent-controller.js";
import { createAgentController } from "./agent-controller-provider.js";
import { createModelsServiceFacet } from "./models-provider.js";
import { SessionPlugins } from "./plugins.js";
import { createTranscriptServiceFacet } from "./transcript-provider.js";
export async function createSessionWorkerServices(options) {
    const agentControllerRuntimeFacet = defineFacet({
        id: "@pi/agent-controller-runtime",
        setup(env) {
            env.provide(AgentController, createAgentController(options.lane));
        },
    });
    let reloadPlugins = () => Promise.reject(new Error("Session plugins are not ready"));
    const pluginRuntimeFacet = defineFacet({
        id: "@pi/session-plugins-runtime",
        setup(env) {
            env.provide(SessionPlugins, { reload: () => reloadPlugins() });
        },
    });
    const builtins = await createStaticFacetLoader([
        agentControllerRuntimeFacet,
        pluginRuntimeFacet,
        createModelsServiceFacet(options),
        createTranscriptServiceFacet(options.lane),
    ]).load();
    const pluginLoader = options.facetLoader ?? createStaticFacetLoader([]);
    let loadedPlugins = await pluginLoader.load();
    let facetHost;
    try {
        facetHost = await createFacetHost({ facets: [...builtins.facets, ...loadedPlugins.facets] });
    }
    catch (error) {
        const cleanup = await Promise.allSettled([loadedPlugins.dispose(), builtins.dispose()]);
        const cleanupErrors = cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
        if (cleanupErrors.length > 0) {
            throw new AggregateError([error, ...cleanupErrors], "Session facets failed to start and clean up");
        }
        throw error;
    }
    let reloadTail = Promise.resolve();
    reloadPlugins = () => {
        const operation = reloadTail.then(async () => {
            const candidate = await pluginLoader.load();
            try {
                await facetHost.reload(candidate.facets);
            }
            catch (error) {
                try {
                    await candidate.dispose();
                }
                catch (cleanupError) {
                    throw new AggregateError([error, cleanupError], "Session plugin reload and cleanup failed");
                }
                throw error;
            }
            const retired = loadedPlugins;
            loadedPlugins = candidate;
            await retired.dispose();
        });
        reloadTail = operation.catch(() => { });
        return operation;
    };
    const provider = facetHost.services;
    const endpoints = new Map();
    const removeSubscriptions = (matches) => {
        for (const [key, entry] of endpoints) {
            if (!matches(entry.scope))
                continue;
            entry.endpoint.dispose();
            endpoints.delete(key);
        }
    };
    return {
        invoke(call, scope, context) {
            const key = serviceScopeKey(scope);
            let entry = endpoints.get(key);
            if (entry === undefined) {
                entry = { scope, endpoint: createRemoteServiceEndpoint(provider) };
                endpoints.set(key, entry);
            }
            return entry.endpoint.invoke(call, (subscriptionId, update) => options.publish(scope, subscriptionId, update), context);
        },
        removeSubscriptions,
        async dispose() {
            removeSubscriptions(() => true);
            await reloadTail;
            const errors = [];
            try {
                await facetHost.dispose();
            }
            catch (error) {
                errors.push(error);
            }
            const results = await Promise.allSettled([loadedPlugins.dispose(), builtins.dispose()]);
            errors.push(...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])));
            if (errors.length === 1)
                throw errors[0];
            if (errors.length > 1)
                throw new AggregateError(errors, "Failed to dispose Session facets");
        },
    };
}
function serviceScopeKey(scope) {
    return `${scope.serverConnectionId}\0${scope.attachmentId}`;
}
//# sourceMappingURL=worker.js.map