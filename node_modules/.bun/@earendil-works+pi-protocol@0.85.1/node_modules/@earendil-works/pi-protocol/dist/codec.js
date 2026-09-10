import { isJsonValue } from "@earendil-works/chord";
import { Check } from "typebox/value";
import { decodeCbor, encodeCbor } from "./cbor/index.js";
import { DEFAULT_MAX_FRAME_LENGTH, encodeFrame, FrameDecoder } from "./framing.js";
import { ClientMessageSchema, PROTOCOL_VERSION, ServerMessageSchema, } from "./protocol.js";
export class ProtocolValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = "ProtocolValidationError";
    }
}
export function parseClientMessage(value) {
    if (!Check(ClientMessageSchema, value) || !isJsonValue(value)) {
        throw new ProtocolValidationError("Invalid client protocol message");
    }
    return value;
}
export function parseServerMessage(value) {
    if (!Check(ServerMessageSchema, value) || !isJsonValue(value)) {
        throw new ProtocolValidationError("Invalid server protocol message");
    }
    return value;
}
function boundedErrorMessage(error) {
    if (!(error instanceof Error))
        return "Unknown codec error";
    return error.message.length <= 500 ? error.message : `${error.message.slice(0, 497)}...`;
}
function encodeProtocolMessage(value, parse, kind, options) {
    const validated = parse(value);
    try {
        const maxFrameLength = options?.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
        return encodeFrame(encodeCbor(validated, { maxByteLength: maxFrameLength }));
    }
    catch (error) {
        if (error instanceof ProtocolValidationError)
            throw error;
        throw new ProtocolValidationError(`Unable to encode ${kind} protocol message: ${boundedErrorMessage(error)}`);
    }
}
/** Validates and encodes one complete length-prefixed client message. */
export function encodeClientMessage(message, options) {
    return encodeProtocolMessage(message, parseClientMessage, "client", options);
}
/** Validates and encodes one complete length-prefixed server message. */
export function encodeServerMessage(message, options) {
    return encodeProtocolMessage(message, parseServerMessage, "server", options);
}
class ValidatedMessageDecoder {
    failed = false;
    frames;
    kind;
    maxFrameLength;
    parse;
    constructor(kind, parse, options) {
        this.frames = new FrameDecoder(options);
        this.kind = kind;
        this.maxFrameLength = options?.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
        this.parse = parse;
    }
    push(chunk) {
        if (this.failed)
            throw new ProtocolValidationError(`${this.kind} message decoder has failed`);
        try {
            const messages = [];
            for (const frame of this.frames.push(chunk)) {
                messages.push(this.parse(decodeCbor(frame, { maxByteLength: this.maxFrameLength })));
            }
            return messages;
        }
        catch (error) {
            this.failed = true;
            if (error instanceof ProtocolValidationError)
                throw error;
            throw new ProtocolValidationError(`Invalid ${this.kind} protocol frame: ${boundedErrorMessage(error)}`);
        }
    }
    end() {
        if (this.failed)
            throw new ProtocolValidationError(`${this.kind} message decoder has failed`);
        try {
            this.frames.end();
        }
        catch (error) {
            this.failed = true;
            throw new ProtocolValidationError(`Invalid ${this.kind} protocol framing: ${boundedErrorMessage(error)}`);
        }
    }
}
/** Incrementally decodes and validates framed client messages. */
export class ClientMessageDecoder {
    decoder;
    constructor(options) {
        this.decoder = new ValidatedMessageDecoder("client", parseClientMessage, options);
    }
    push(chunk) {
        return this.decoder.push(chunk);
    }
    end() {
        this.decoder.end();
    }
}
/** Incrementally decodes and validates framed server messages. */
export class ServerMessageDecoder {
    decoder;
    constructor(options) {
        this.decoder = new ValidatedMessageDecoder("server", parseServerMessage, options);
    }
    push(chunk) {
        return this.decoder.push(chunk);
    }
    end() {
        this.decoder.end();
    }
}
export function isSupportedProtocolVersion(version) {
    return Number.isInteger(version) && version === PROTOCOL_VERSION;
}
//# sourceMappingURL=codec.js.map