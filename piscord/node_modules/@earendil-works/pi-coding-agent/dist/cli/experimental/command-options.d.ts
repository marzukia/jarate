import { type ServerId } from "@earendil-works/pi-protocol";
import { type ParsedCommandInput } from "./command.ts";
export type AuthInput = {
    readonly type: "token";
    readonly token: string;
} | {
    readonly type: "file";
    readonly path: string;
};
interface UnixTransportAddress {
    readonly transport: "unix";
    readonly path: string;
}
interface RadiusTransportAddress {
    readonly transport: "radius";
    readonly serverId: ServerId;
}
export type TransportAddress = UnixTransportAddress | RadiusTransportAddress;
export declare const authTokenOption: import("./command.ts").CommandOption<string>;
export declare const authTokenFileOption: import("./command.ts").CommandOption<string>;
export declare const connectOption: import("./command.ts").CommandOption<TransportAddress>;
export declare function parseAuth(input: ParsedCommandInput): {
    auth?: AuthInput;
    errors: string[];
};
export declare function unsupportedOptions(command: string, input: ParsedCommandInput): string[];
export {};
//# sourceMappingURL=command-options.d.ts.map