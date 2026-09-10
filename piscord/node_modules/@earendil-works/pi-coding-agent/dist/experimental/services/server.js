import { createRemoteServiceEndpoint, RemoteServiceProvider, replicatedState, } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { PresentationPlugins } from "./plugins.js";
import { SessionDirectory, SessionManagement, } from "./sessions.js";
export async function createExperimentalServerServices(options) {
    let revision = 1;
    const directory = replicatedState({
        revision,
        sessions: await options.list(BACKGROUND_CONTEXT),
    });
    const attachments = new Set();
    let mutationTail = Promise.resolve();
    const refreshNow = async (context) => {
        const sessions = await options.list(context);
        revision += 1;
        directory.state.revision = revision;
        directory.state.sessions = sessions;
        directory.publish(context);
    };
    const serialize = (operation) => {
        const result = mutationTail.catch(() => { }).then(operation);
        mutationTail = result.then(() => undefined, () => undefined);
        return result;
    };
    return {
        host: {
            attachClient(presentation) {
                let preparedPluginPackagePaths;
                const provider = new RemoteServiceProvider([
                    { service: SessionDirectory, mode: "singleton" },
                    { service: SessionManagement, mode: "singleton" },
                    { service: PresentationPlugins, mode: "singleton" },
                ]);
                provider.provide(SessionDirectory, { state: directory });
                provider.provide(PresentationPlugins, {
                    prepareSession: ({ sessionId, packagePaths }, context) => serialize(async () => {
                        const selected = await options.prepareSessionPlugins(sessionId, packagePaths ?? undefined, context);
                        preparedPluginPackagePaths = selected.packagePaths;
                        return selected.presentationPlugins;
                    }),
                    reload: (context) => serialize(() => {
                        if (preparedPluginPackagePaths === undefined) {
                            throw new Error("No Session plugin selection is prepared");
                        }
                        return options.reloadPresentationPlugins(preparedPluginPackagePaths, context);
                    }),
                });
                provider.provide(SessionManagement, {
                    create: (createOptions, context) => serialize(async () => {
                        const created = await options.create(createOptions, context);
                        await refreshNow(context);
                        return created;
                    }),
                    remove: (sessionId, context) => serialize(async () => {
                        await presentation.prepareSessionRemoval(sessionId, context);
                        await options.remove(sessionId, context);
                        await refreshNow(context);
                    }),
                    attach: (sessionId, context) => serialize(async () => {
                        await presentation.attachSession(sessionId, context);
                    }),
                    detach: (context) => serialize(async () => {
                        await presentation.detachSession(context);
                        preparedPluginPackagePaths = undefined;
                    }),
                });
                const attachment = createProviderAttachment(provider, () => attachments.delete(attachment));
                attachments.add(attachment);
                return attachment;
            },
        },
        refresh: (context = BACKGROUND_CONTEXT) => serialize(() => refreshNow(context)),
        async dispose() {
            const releases = await Promise.allSettled([...attachments].map((attachment) => attachment.release(BACKGROUND_CONTEXT)));
            attachments.clear();
            await mutationTail;
            const errors = releases.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
            if (errors.length === 1)
                throw errors[0];
            if (errors.length > 1)
                throw new AggregateError(errors, "Failed to release server service attachments");
        },
    };
}
function createProviderAttachment(provider, onRelease) {
    const endpoint = createRemoteServiceEndpoint(provider);
    let released = false;
    return {
        invokeService(call, publish, context) {
            if (released)
                return Promise.reject(new Error("Server service attachment is released"));
            return endpoint.invoke(call, publish, context);
        },
        release() {
            if (released)
                return;
            released = true;
            endpoint.dispose();
            provider.dispose();
            onRelease();
        },
    };
}
//# sourceMappingURL=server.js.map