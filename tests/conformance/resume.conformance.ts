import { describe, expect, test } from "bun:test";
import { Api, e2eEnv } from "../e2e/client.ts";
import { scriptId } from "./engine.ts";
import { engineFromEnv } from "./engines.ts";

/**
 * A checkpoint committed at a turn boundary outlives its worker: after a
 * pause the worker is gone, and a resume starts a new one whose next turn
 * continues the earlier conversation. The engine is asked nothing but the
 * next prompt, so the earlier prompt reaches the provider only if the new
 * worker restored the engine's session from the checkpoint. The turn
 * boundary is the commit point on every engine, since an engine need not
 * checkpoint while it waits for an approval.
 */
const engine = engineFromEnv();
const api = new Api(e2eEnv({ needsMessages: false }));
const TIMEOUT = 600_000;

describe(`resume on ${engine.runtimeKind}`, () => {
  test(
    "a new worker restores the checkpoint and the next turn continues the conversation",
    async () => {
      const before = scriptId("resume-before");
      const created = await api.createSession(
        engine.prompt({ id: before, commands: [], final: "before" }),
        undefined,
        engine.profileId,
        engine.repositoryId,
      );
      expect(created.status).toBe(201);
      const sessionId = created.body.session_id;
      expect((await api.settledTurn(sessionId, "1")).status).toBe("completed");

      // The turn's checkpoint is committed before the worker is asked to go.
      const saved = await api.sessionUntil(
        sessionId,
        "has checkpointed turn 1",
        (s) => s.durability.last_checkpointed_turn_id === "1",
      );
      expect(saved.checkpoint_revision).not.toBeNull();

      const pause = await api.control(sessionId, "pause", {
        expected_revision: saved.revision,
        reason: "conformance",
      });
      expect(pause.status).toBe(202);
      await api.sessionUntil(
        sessionId,
        "is paused",
        (s) => s.admission_state === "paused",
      );

      const resume = await api.control(sessionId, "resume", {
        expected_revision: (await api.session(sessionId)).revision,
      });
      expect(resume.status).toBe(202);
      await api.sessionUntil(
        sessionId,
        "is active again",
        (s) => s.admission_state === "active",
      );

      const after = scriptId("resume-after");
      const next = await api.send(
        sessionId,
        engine.prompt({ id: after, commands: [], final: "after" }),
      );
      expect(next.turn_id).toBe("2");
      expect((await api.settledTurn(sessionId, "2")).status).toBe("completed");

      const calls = await engine.modelCalls(after);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(call.history).toContain(before);
    },
    TIMEOUT,
  );
});
