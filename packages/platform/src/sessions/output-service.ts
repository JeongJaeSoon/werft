import type { ListSessionOutputsResponse } from "@werft-ai/contracts";
import type { StoredOutput } from "@werft-ai/runtime-core";
import type {
  SessionOutputBodyResult,
  SessionOutputsResult,
} from "../checkpoints/index.ts";
import type { Caller } from "../musterrolle/policy.ts";
import { type SessionService, SessionServiceError } from "./session-service.ts";

export interface SessionOutputSource {
  readOutputs(sessionId: string): Promise<SessionOutputsResult>;
  openOutput(sessionId: string, path: string): Promise<SessionOutputBodyResult>;
}

/**
 * The `out/` files a session's latest committed checkpoint lists, and their
 * bytes. Whoever may read the session may read them, and is refused exactly
 * as `getSession` would refuse them.
 */
export function createSessionOutputService(deps: {
  sessions: Pick<SessionService, "getSession">;
  source: SessionOutputSource;
}) {
  const { sessions, source } = deps;

  async function requireReadable(actor: Caller, sessionId: string) {
    await sessions.getSession(actor, sessionId);
  }

  function unavailable(reason: string): never {
    throw new SessionServiceError(
      "CHECKPOINT_UNAVAILABLE",
      `The session's latest checkpoint cannot be read: ${reason}`,
    );
  }

  return {
    async listOutputs(
      actor: Caller,
      sessionId: string,
    ): Promise<ListSessionOutputsResponse> {
      await requireReadable(actor, sessionId);
      const listed = await source.readOutputs(sessionId);
      if (listed.status === "unavailable") unavailable(listed.reason);
      if (listed.status === "none") {
        return { session_id: sessionId, checkpoint_revision: null, items: [] };
      }
      return {
        session_id: sessionId,
        checkpoint_revision: listed.revision,
        items: listed.outputs.map((output) =>
          "omitted" in output
            ? {
                path: output.path,
                bytes: output.bytes,
                sha256: null,
                omitted: output.omitted,
              }
            : {
                path: output.path,
                bytes: output.bytes,
                sha256: output.sha256,
                omitted: null,
              },
        ),
      };
    },

    async openOutput(
      actor: Caller,
      sessionId: string,
      path: string,
    ): Promise<{ body: AsyncIterable<Uint8Array>; output: StoredOutput }> {
      await requireReadable(actor, sessionId);
      const opened = await source.openOutput(sessionId, path);
      if (opened.status === "unavailable") unavailable(opened.reason);
      if (opened.status === "missing") {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      return { body: opened.body, output: opened.output };
    },
  };
}

export type SessionOutputService = ReturnType<
  typeof createSessionOutputService
>;
