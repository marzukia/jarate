import { isServerId } from "@earendil-works/pi-protocol";
import { Command, stringOption, valueOption } from "../command.js";
import { authTokenFileOption, authTokenOption, parseAuth, unsupportedOptions, } from "../command-options.js";
const serverIdOption = valueOption("--server-id", (value) => isServerId(value)
    ? { ok: true, value }
    : { ok: false, error: `Invalid --server-id "${value}"; expected a lowercase UUIDv4` });
const sessionDirOption = stringOption("--session-dir");
const providerOption = stringOption("--provider");
const modelOption = stringOption("--model");
const pluginPackageOption = stringOption("-e", { repeatable: true });
export const serverCommand = new Command("server")
    .option(serverIdOption)
    .option(sessionDirOption)
    .option(providerOption)
    .option(modelOption)
    .option(pluginPackageOption)
    .option(authTokenOption)
    .option(authTokenFileOption)
    .build((input) => {
    const { auth, errors: authErrors } = parseAuth(input);
    const serverId = input.value(serverIdOption);
    const sessionDir = input.value(sessionDirOption);
    const provider = input.value(providerOption);
    const model = input.value(modelOption);
    const pluginPackages = input.values(pluginPackageOption);
    const modelErrors = provider !== undefined && model === undefined ? ["--provider requires --model"] : [];
    const errors = [...authErrors, ...modelErrors, ...unsupportedOptions("server", input)];
    if (errors.length > 0)
        return { ok: false, errors };
    return {
        ok: true,
        command: {
            command: "server",
            ...(auth === undefined ? {} : { auth }),
            ...(provider === undefined ? {} : { provider }),
            ...(model === undefined ? {} : { model }),
            ...(pluginPackages.length === 0 ? {} : { pluginPackages }),
            ...(serverId === undefined ? {} : { serverId }),
            ...(sessionDir === undefined ? {} : { sessionDir }),
        },
    };
})
    .action((command, context) => context.runServer(command));
//# sourceMappingURL=server.js.map