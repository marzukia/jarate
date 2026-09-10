/**
 * Worker-side implementation of the `Models` service.
 *
 * `ModelRuntime`, `Model`, and provider objects stay here. What leaves is a serializable catalog and
 * account list, plus login prompts and notices as data.
 */
import { randomUUID } from "node:crypto";
import { refreshModelCatalogs } from "../../../modes/interactive/model-catalog-refresh.js";
const CATALOG_REFRESH_TIMEOUT_MS = 15_000;
export class ModelsService {
    #runtime;
    #publish;
    /** Prompts issued to the presentation, awaiting `authReply`. */
    #pendingAuth = new Map();
    #state;
    constructor(runtime, publish) {
        this.#runtime = runtime;
        this.#publish = publish;
        this.#state = readState(runtime, false);
    }
    get state() {
        return this.#state;
    }
    async refresh() {
        this.#update(true);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), CATALOG_REFRESH_TIMEOUT_MS);
        try {
            const result = await refreshModelCatalogs(this.#runtime, controller.signal);
            return result.errors.size === 0
                ? { ok: true }
                : { ok: false, error: `Some catalogs could not be refreshed: ${[...result.errors.keys()].join(", ")}` };
        }
        catch (error) {
            return { ok: false, error: message(error) };
        }
        finally {
            clearTimeout(timeout);
            this.#update(false);
        }
    }
    /** Prompts and notices travel to the presentation as events; answers come back via `authReply`. */
    async login(providerId, authType) {
        try {
            await this.#runtime.login(providerId, authType, {
                prompt: (prompt) => {
                    const { signal, ...request } = prompt;
                    return this.#ask(request, signal);
                },
                notify: (notice) => this.#publish({ type: "notice", notice }),
            });
            return { ok: true };
        }
        catch (error) {
            return { ok: false, error: message(error) };
        }
        finally {
            this.#update(false);
        }
    }
    async authReply(requestId, answer) {
        const waiter = this.#pendingAuth.get(requestId);
        this.#pendingAuth.delete(requestId);
        waiter?.(answer);
    }
    /** Ask the presentation one question, honouring a provider-supplied deadline. */
    #ask(request, signal) {
        if (signal?.aborted)
            return Promise.reject(new Error("Login cancelled"));
        return new Promise((resolve, reject) => {
            const requestId = randomUUID();
            const settle = (answer) => {
                signal?.removeEventListener("abort", onAbort);
                if (answer === null)
                    reject(new Error("Login cancelled"));
                else
                    resolve(answer);
            };
            const onAbort = () => {
                this.#pendingAuth.delete(requestId);
                reject(new Error("Login cancelled"));
            };
            this.#pendingAuth.set(requestId, settle);
            signal?.addEventListener("abort", onAbort, { once: true });
            this.#publish({ type: "prompt", requestId, request });
        });
    }
    async logout(providerId) {
        try {
            await this.#runtime.logout(providerId);
            return { ok: true };
        }
        catch (error) {
            return { ok: false, error: message(error) };
        }
        finally {
            this.#update(false);
        }
    }
    #update(refreshing) {
        this.#state = readState(this.#runtime, refreshing);
        this.#publish({ type: "state", state: this.#state });
    }
}
function readState(runtime, refreshing) {
    const models = runtime
        .getAvailableSnapshot()
        .map((model) => ({ provider: model.provider, modelId: model.id, name: model.name }));
    const accounts = [];
    for (const provider of runtime.getProviders()) {
        const status = runtime.getProviderAuthStatus(provider.id);
        const shared = {
            id: provider.id,
            name: provider.name,
            configured: status.configured,
            ...((status.label ?? status.source === undefined) ? {} : { source: status.label ?? status.source }),
        };
        if (provider.auth.oauth) {
            accounts.push({ ...shared, authType: "oauth", interactive: true, methodName: provider.auth.oauth.name });
        }
        if (provider.auth.apiKey) {
            accounts.push({
                ...shared,
                authType: "api_key",
                interactive: provider.auth.apiKey.login !== undefined,
                methodName: provider.auth.apiKey.name,
            });
        }
    }
    accounts.sort((left, right) => left.name.localeCompare(right.name));
    return { models, accounts, refreshing };
}
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=models-service.js.map