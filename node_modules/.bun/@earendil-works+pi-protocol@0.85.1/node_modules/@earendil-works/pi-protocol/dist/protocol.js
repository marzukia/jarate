import Type from "typebox";
import { Check } from "typebox/value";
export const PROTOCOL_VERSION = 8;
const IdSchema = Type.String({ minLength: 1 });
const OpaqueJsonValueSchema = Type.Unsafe(Type.Unknown());
const StrictObject = (properties) => Type.Object(properties, { additionalProperties: false });
const ServerIdSchema = Type.String({
    pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
export function isServerId(value) {
    return Check(ServerIdSchema, value);
}
const ProtocolErrorSchema = StrictObject({
    code: IdSchema,
    message: Type.String(),
});
/** Must be the first frame sent by a client. */
const ClientHelloSchema = StrictObject({
    type: Type.Literal("hello"),
    version: Type.Integer({ minimum: 0 }),
});
/** A server-wide call, fenced to one logical server. */
const ServerTargetSchema = StrictObject({
    serverId: ServerIdSchema,
});
/** A session call, fenced to one logical server, durable session, and live attachment. */
const SessionTargetSchema = StrictObject({
    serverId: ServerIdSchema,
    sessionId: IdSchema,
    attachmentId: IdSchema,
});
const RpcTargetSchema = Type.Union([ServerTargetSchema, SessionTargetSchema]);
const RequestEnvelopeSchema = StrictObject({
    type: Type.Literal("request"),
    id: IdSchema,
    target: RpcTargetSchema,
    call: OpaqueJsonValueSchema,
});
const CancelEnvelopeSchema = StrictObject({
    type: Type.Literal("cancel"),
    id: IdSchema,
    target: RpcTargetSchema,
});
export const ClientMessageSchema = Type.Union([ClientHelloSchema, RequestEnvelopeSchema, CancelEnvelopeSchema]);
const ServerHelloSchema = StrictObject({
    type: Type.Literal("hello"),
    version: Type.Literal(PROTOCOL_VERSION),
    serverId: ServerIdSchema,
});
const ServerHelloErrorSchema = StrictObject({
    type: Type.Literal("hello_error"),
    error: ProtocolErrorSchema,
});
const ResponseEnvelopeSchema = Type.Union([
    StrictObject({
        type: Type.Literal("response"),
        id: IdSchema,
        ok: Type.Literal(true),
        result: Type.Optional(OpaqueJsonValueSchema),
    }),
    StrictObject({
        type: Type.Literal("response"),
        id: IdSchema,
        ok: Type.Literal(false),
        error: ProtocolErrorSchema,
    }),
]);
const ServiceEventEnvelopeSchema = StrictObject({
    type: Type.Literal("service_update"),
    subscriptionId: IdSchema,
    update: OpaqueJsonValueSchema,
});
/** Out-of-band update to this presentation's selected Session route. */
const AttachmentEnvelopeSchema = StrictObject({
    type: Type.Literal("attachment"),
    attachment: Type.Union([SessionTargetSchema, Type.Null()]),
});
export const ServerMessageSchema = Type.Union([
    ServerHelloSchema,
    ServerHelloErrorSchema,
    ResponseEnvelopeSchema,
    ServiceEventEnvelopeSchema,
    AttachmentEnvelopeSchema,
]);
//# sourceMappingURL=protocol.js.map