import type { SessionMetadata } from "@earendil-works/pi-agent-core";
import { Server } from "../../server.ts";
import type { ServerHost } from "../../types.ts";
import type { UnixServerOptions } from "./types.ts";
/** Compose Server with one Unix-domain socket listener. */
export declare function createUnixServer<TMetadata extends SessionMetadata>(host: ServerHost<TMetadata>, options: UnixServerOptions): Server<TMetadata>;
//# sourceMappingURL=preset.d.ts.map