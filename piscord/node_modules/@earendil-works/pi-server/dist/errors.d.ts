import type { RemoteServiceErrorCode } from "@earendil-works/chord";
type ServerOperationErrorCode = RemoteServiceErrorCode | "wrong_server" | "session_not_found" | "session_ambiguous" | "session_not_attached" | "server_draining";
export declare const INTERNAL_SERVER_ERROR_MESSAGE = "Internal server error";
/** A host or lifecycle error that can safely cross the protocol boundary. */
export declare class ServerError extends Error {
    readonly code: ServerOperationErrorCode;
    constructor(code: ServerOperationErrorCode, message: string);
}
export declare class WrongServerError extends ServerError {
    constructor();
}
export declare class SessionNotFoundError extends ServerError {
    constructor(message?: string);
}
export declare class SessionAmbiguousError extends ServerError {
    constructor();
}
export declare class SessionNotAttachedError extends ServerError {
    constructor();
}
export declare class ServerDrainingError extends ServerError {
    constructor();
}
export {};
//# sourceMappingURL=errors.d.ts.map