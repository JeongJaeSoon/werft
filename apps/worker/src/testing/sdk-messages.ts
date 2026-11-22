import type { EngineMessage } from "@werft-ai/runtime-core/testing";
import type { WorkerCheckpointPort } from "../checkpoint.ts";
import { inputUuid } from "../worker-host.ts";
import type { FakeWorkerGateway } from "./fake-gateway.ts";

/** The engine's result for a turn whose input is `msg-<turn>`. */
export function resultMessage(sessionId: string, turn: number): EngineMessage {
  return {
    type: "result",
    subtype: "success",
    session_id: "fake-session",
    is_error: false,
    usage: { input_tokens: 3 },
    user_message_uuid: inputUuid(sessionId, String(turn), `msg-${turn}`),
  };
}

/** Commits every ready capture at the gateway's next revision. */
export function committedOn(gateway: FakeWorkerGateway): WorkerCheckpointPort {
  return {
    restorePlan: async () => ({ mode: "new" }),
    capture: async (preparation) => {
      if (preparation.status !== "ready") return null;
      const revision = (gateway.checkpointRevision ?? -1) + 1;
      return {
        revision,
        manifest_ref: `checkpoints/${revision}.json`,
        manifest_sha256: "a".repeat(64),
      };
    },
  };
}
