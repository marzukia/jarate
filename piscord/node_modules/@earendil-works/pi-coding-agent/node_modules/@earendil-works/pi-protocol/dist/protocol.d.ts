import type { JsonValue } from "@earendil-works/chord";
import Type, { type Static } from "typebox";
export declare const PROTOCOL_VERSION: 8;
declare const ServerIdSchema: Type.TString;
export type ServerId = Static<typeof ServerIdSchema>;
export declare function isServerId(value: unknown): value is ServerId;
declare const ProtocolErrorSchema: Type.TObject<{
    readonly code: Type.TString;
    readonly message: Type.TString;
}>;
export type ProtocolErrorCode = string;
export type ProtocolError = Static<typeof ProtocolErrorSchema>;
/** Must be the first frame sent by a client. */
declare const ClientHelloSchema: Type.TObject<{
    readonly type: Type.TLiteral<"hello">;
    readonly version: Type.TInteger;
}>;
export type ClientHello = Static<typeof ClientHelloSchema>;
/** A session call, fenced to one logical server, durable session, and live attachment. */
declare const SessionTargetSchema: Type.TObject<{
    readonly serverId: Type.TString;
    readonly sessionId: Type.TString;
    readonly attachmentId: Type.TString;
}>;
export type SessionTarget = Static<typeof SessionTargetSchema>;
declare const RpcTargetSchema: Type.TUnion<[Type.TObject<{
    readonly serverId: Type.TString;
}>, Type.TObject<{
    readonly serverId: Type.TString;
    readonly sessionId: Type.TString;
    readonly attachmentId: Type.TString;
}>]>;
export type RpcTarget = Static<typeof RpcTargetSchema>;
declare const RequestEnvelopeSchema: Type.TObject<{
    readonly type: Type.TLiteral<"request">;
    readonly id: Type.TString;
    readonly target: Type.TUnion<[Type.TObject<{
        readonly serverId: Type.TString;
    }>, Type.TObject<{
        readonly serverId: Type.TString;
        readonly sessionId: Type.TString;
        readonly attachmentId: Type.TString;
    }>]>;
    readonly call: Type.TUnsafe<JsonValue>;
}>;
declare const CancelEnvelopeSchema: Type.TObject<{
    readonly type: Type.TLiteral<"cancel">;
    readonly id: Type.TString;
    readonly target: Type.TUnion<[Type.TObject<{
        readonly serverId: Type.TString;
    }>, Type.TObject<{
        readonly serverId: Type.TString;
        readonly sessionId: Type.TString;
        readonly attachmentId: Type.TString;
    }>]>;
}>;
export type RequestEnvelope = Static<typeof RequestEnvelopeSchema>;
export type CancelEnvelope = Static<typeof CancelEnvelopeSchema>;
export declare const ClientMessageSchema: Type.TUnion<[Type.TObject<{
    readonly type: Type.TLiteral<"hello">;
    readonly version: Type.TInteger;
}>, Type.TObject<{
    readonly type: Type.TLiteral<"request">;
    readonly id: Type.TString;
    readonly target: Type.TUnion<[Type.TObject<{
        readonly serverId: Type.TString;
    }>, Type.TObject<{
        readonly serverId: Type.TString;
        readonly sessionId: Type.TString;
        readonly attachmentId: Type.TString;
    }>]>;
    readonly call: Type.TUnsafe<JsonValue>;
}>, Type.TObject<{
    readonly type: Type.TLiteral<"cancel">;
    readonly id: Type.TString;
    readonly target: Type.TUnion<[Type.TObject<{
        readonly serverId: Type.TString;
    }>, Type.TObject<{
        readonly serverId: Type.TString;
        readonly sessionId: Type.TString;
        readonly attachmentId: Type.TString;
    }>]>;
}>]>;
export type ClientMessage = Static<typeof ClientMessageSchema>;
declare const ServerHelloSchema: Type.TObject<{
    readonly type: Type.TLiteral<"hello">;
    readonly version: Type.TLiteral<8>;
    readonly serverId: Type.TString;
}>;
declare const ServerHelloErrorSchema: Type.TObject<{
    readonly type: Type.TLiteral<"hello_error">;
    readonly error: Type.TObject<{
        readonly code: Type.TString;
        readonly message: Type.TString;
    }>;
}>;
declare const ResponseEnvelopeSchema: Type.TUnion<[Type.TObject<{
    readonly type: Type.TLiteral<"response">;
    readonly id: Type.TString;
    readonly ok: Type.TLiteral<true>;
    readonly result: Type.TOptional<Type.TUnsafe<JsonValue>>;
}>, Type.TObject<{
    readonly type: Type.TLiteral<"response">;
    readonly id: Type.TString;
    readonly ok: Type.TLiteral<false>;
    readonly error: Type.TObject<{
        readonly code: Type.TString;
        readonly message: Type.TString;
    }>;
}>]>;
declare const ServiceEventEnvelopeSchema: Type.TObject<{
    readonly type: Type.TLiteral<"service_update">;
    readonly subscriptionId: Type.TString;
    readonly update: Type.TUnsafe<JsonValue>;
}>;
/** Out-of-band update to this presentation's selected Session route. */
declare const AttachmentEnvelopeSchema: Type.TObject<{
    readonly type: Type.TLiteral<"attachment">;
    readonly attachment: Type.TUnion<[Type.TObject<{
        readonly serverId: Type.TString;
        readonly sessionId: Type.TString;
        readonly attachmentId: Type.TString;
    }>, Type.TNull]>;
}>;
export declare const ServerMessageSchema: Type.TUnion<[Type.TObject<{
    readonly type: Type.TLiteral<"hello">;
    readonly version: Type.TLiteral<8>;
    readonly serverId: Type.TString;
}>, Type.TObject<{
    readonly type: Type.TLiteral<"hello_error">;
    readonly error: Type.TObject<{
        readonly code: Type.TString;
        readonly message: Type.TString;
    }>;
}>, Type.TUnion<[Type.TObject<{
    readonly type: Type.TLiteral<"response">;
    readonly id: Type.TString;
    readonly ok: Type.TLiteral<true>;
    readonly result: Type.TOptional<Type.TUnsafe<JsonValue>>;
}>, Type.TObject<{
    readonly type: Type.TLiteral<"response">;
    readonly id: Type.TString;
    readonly ok: Type.TLiteral<false>;
    readonly error: Type.TObject<{
        readonly code: Type.TString;
        readonly message: Type.TString;
    }>;
}>]>, Type.TObject<{
    readonly type: Type.TLiteral<"service_update">;
    readonly subscriptionId: Type.TString;
    readonly update: Type.TUnsafe<JsonValue>;
}>, Type.TObject<{
    readonly type: Type.TLiteral<"attachment">;
    readonly attachment: Type.TUnion<[Type.TObject<{
        readonly serverId: Type.TString;
        readonly sessionId: Type.TString;
        readonly attachmentId: Type.TString;
    }>, Type.TNull]>;
}>]>;
export type ServerHello = Static<typeof ServerHelloSchema>;
export type ServerHelloError = Static<typeof ServerHelloErrorSchema>;
export type ResponseEnvelope = Static<typeof ResponseEnvelopeSchema>;
export type ServiceEventEnvelope = Static<typeof ServiceEventEnvelopeSchema>;
export type AttachmentEnvelope = Static<typeof AttachmentEnvelopeSchema>;
export type ServerMessage = Static<typeof ServerMessageSchema>;
export {};
//# sourceMappingURL=protocol.d.ts.map