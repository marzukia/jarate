import { Server } from "../server.ts";
import type { ServerHost, ServerOptions } from "../types.ts";
export interface TestServerOptions extends Omit<ServerOptions, "serverId"> {
    host?: ServerHost;
    serverId?: string;
}
export interface TestServer {
    server: Server;
    host: ServerHost;
}
/** Create an unstarted Server with deterministic defaults for transport conformance tests. */
export declare function createTestServer(options: TestServerOptions): TestServer;
//# sourceMappingURL=server.d.ts.map