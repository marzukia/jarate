/**
 * The view. It holds no live objects: no harness, lane, session, or model runtime.
 *
 * Everything it renders comes from a replicated `SessionView` snapshot, and everything it does is a
 * command that answers with data. Whether that view is in-process or a socket away is invisible here.
 */
import type { AttachedSession } from "./session.ts";
/** Run the view against one attached session until the user exits. */
export declare function runView(client: AttachedSession): Promise<void>;
//# sourceMappingURL=view.d.ts.map