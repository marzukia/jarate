export class ServerError extends Error {
    code;
    constructor(error) {
        super(error.message);
        this.name = "ServerError";
        this.code = error.code;
    }
}
export class DisconnectedError extends Error {
    constructor(message = "Client is disconnected", cause) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = "DisconnectedError";
    }
}
export class ClientDisposedError extends Error {
    constructor() {
        super("Client is disposed");
        this.name = "ClientDisposedError";
    }
}
export function toError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
export function toDisconnectedError(error) {
    const cause = toError(error);
    return cause instanceof DisconnectedError ? cause : new DisconnectedError(cause.message, cause);
}
//# sourceMappingURL=errors.js.map