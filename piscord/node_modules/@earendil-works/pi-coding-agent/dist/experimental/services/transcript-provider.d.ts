import { type Facet, type MutableReplicatedState } from "@earendil-works/chord";
import { type AgentLane } from "@earendil-works/pi-agent-core";
import { type Transcript as TranscriptService, type TranscriptState } from "./transcript.ts";
interface TranscriptRuntime {
    readonly service: TranscriptService;
    activate(): Promise<void>;
    dispose(): Promise<void>;
}
export declare function createTranscriptService(lane: AgentLane, createState: (initial: TranscriptState) => MutableReplicatedState<TranscriptState>): TranscriptRuntime;
export declare function createTranscriptServiceFacet(lane: AgentLane): Facet;
export {};
//# sourceMappingURL=transcript-provider.d.ts.map