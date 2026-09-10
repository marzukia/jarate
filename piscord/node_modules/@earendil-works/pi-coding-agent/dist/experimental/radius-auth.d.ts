import type { AuthInput } from "../cli/experimental/command-options.ts";
export declare const ENV_RADIUS_GATEWAY = "PI_RADIUS_GATEWAY";
export interface RadiusRelayAuth {
    readonly gateway: string;
    readonly token: string;
}
/** Resolve explicit or stored Radius credentials anew for every relay connection attempt. */
export declare class RadiusRelayAuthResolver {
    #private;
    constructor(input?: AuthInput, gateway?: string);
    get gateway(): string;
    resolve(options: {
        readonly required: boolean;
        readonly signal?: AbortSignal;
    }): Promise<RadiusRelayAuth | undefined>;
}
//# sourceMappingURL=radius-auth.d.ts.map