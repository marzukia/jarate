import type { ProtocolError, ProtocolErrorCode } from "@earendil-works/pi-protocol";
export declare class ServerError extends Error {
    readonly code: ProtocolErrorCode;
    constructor(error: ProtocolError);
}
export declare class DisconnectedError extends Error {
    constructor(message?: string, cause?: Error);
}
export declare class ClientDisposedError extends Error {
    constructor();
}
export declare function toError(error: unknown): Error;
export declare function toDisconnectedError(error: unknown): DisconnectedError;
//# sourceMappingURL=errors.d.ts.map