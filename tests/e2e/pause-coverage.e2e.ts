import { describe, expect, test } from "bun:test";
import {
  Api,
  bash,
  e2eStack,
  type SessionDetail,
  scripted,
  type Turn,
} from "./client.ts";

/**
 * The two pause branches alpha-path.e2e.ts does not reach, on the
 * stack tests/e2e/run.sh started. What leaves a turn without its checkpoint
 * is the workspace itself: capture refuses an untracked symlink, the
 * publish is reported as the advisory `publish_failed` and the turn is
 * finalized without a revision, so the pointer stops short of it.
 */
const api = new Api(await e2eStack());
const TIMEOUT = 600_000;

async function completed(
  sessionId: string,
  turnId: string,
): Promise<Turn & { checkpoint_revision: number | null }> {
  const turn = await api.settleAllowing(sessionId, turnId);
  expect(turn.status).toBe("completed");
  return turn as Turn & { checkpoint_revision: number | null };
}

/** A session whose first turn committed a checkpoint, as every pause needs. */
async function coveredSession(spec: string): Promise<string> {
  const created = await api.createSession(scripted(spec, [], "ready"));
  expect(created.status).toBe(201);
  const sessionId = created.body.session_id;
  expect((await completed(sessionId, "1")).checkpoint_revision).not.toBeNull();
  expect((await api.session(sessionId)).durability).toMatchObject({
    last_completed_turn_id: "1",
    last_checkpointed_turn_id: "1",
    checkpoint_pending_reason: null,
  });
  return sessionId;
}

/** Plants an untracked symlink, which the turn's capture refuses. */
async function uncoveredTurn(sessionId: string, spec: string): Promise<string> {
  const before = await api.session(sessionId);
  const sent = await api.send(
    sessionId,
    scripted(spec, [bash("ln -s missing-target link")], "linked"),
  );
  expect((await completed(sessionId, sent.turn_id)).checkpoint_revision).toBe(
    null,
  );
  const after = await api.session(sessionId);
  expect(after.checkpoint_revision).toBe(before.checkpoint_revision);
  expect(after.durability).toMatchObject({
    last_completed_turn_id: sent.turn_id,
    last_checkpointed_turn_id: before.durability.last_checkpointed_turn_id,
    checkpoint_pending_reason: "publish_failed",
  });
  return sent.turn_id;
}

function pause(session: SessionDetail) {
  return api.control(session.id, "pause", {
    expected_revision: session.revision,
    reason: "e2e",
  });
}

function receiptId(response: { body: unknown }): string {
  return (response.body as { receipt_id: string }).receipt_id;
}

describe("pause coverage branches", () => {
  test(
    "a turn skipped its checkpoint, a later one covered it: the pause completes",
    async () => {
      const sessionId = await coveredSession("pc1");
      await uncoveredTurn(sessionId, "pc2");

      // Removing the link lets the next capture through; its commit moves
      // the pointer past the skipped turn and clears the advisory reason.
      const fixed = await api.send(
        sessionId,
        scripted("pc3", [bash("rm link")], "unlinked"),
      );
      const covering = await completed(sessionId, fixed.turn_id);
      expect(covering.checkpoint_revision).not.toBeNull();
      const covered = await api.session(sessionId);
      expect(covered.checkpoint_revision).toBe(covering.checkpoint_revision);
      expect(covered.durability).toMatchObject({
        last_completed_turn_id: fixed.turn_id,
        last_checkpointed_turn_id: fixed.turn_id,
        checkpoint_pending_reason: null,
      });

      const paused = await pause(covered);
      expect(paused.status).toBe(202);
      const receipt = await api.receiptUntil(
        receiptId(paused),
        (r) => r.status !== "accepted",
      );
      expect(receipt).toMatchObject({
        status: "succeeded",
        result: {
          resulting_admission_state: "paused",
          checkpoint_revision: covering.checkpoint_revision,
        },
      });
      expect((await api.session(sessionId)).admission_state).toBe("paused");
    },
    TIMEOUT,
  );

  test(
    "a capture refusal leaves the worker pausing until resume cancels the pause",
    async () => {
      const sessionId = await coveredSession("pn1");
      const skipped = await uncoveredTurn(sessionId, "pn2");

      // The worker is still bound, so the pause is accepted and drains; its
      // release is refused (worker-unit-of-work.ts releaseAtomic →
      // pauseBlocker) and the worker holds the lease rather than exit.
      const paused = await pause(await api.session(sessionId));
      expect(paused.status).toBe(202);
      expect(paused.body).toMatchObject({ receipt_status: "accepted" });
      const pausing = await api.session(sessionId);
      expect(pausing.admission_state).toBe("pausing");
      // Deadline attention is covered by the database-clock integration test.
      expect(pausing.attention).toBeNull();
      expect(pausing.durability).toMatchObject({
        last_completed_turn_id: skipped,
        last_checkpointed_turn_id: "1",
        checkpoint_pending_reason: "publish_failed",
      });
      expect((await api.receipt(receiptId(paused))).status).toBe("accepted");

      // The way out short of terminate: a resume cancels the pause, and the
      // worker that held its lease takes input again.
      const cancel = await api.control(sessionId, "resume", {
        expected_revision: pausing.revision,
      });
      expect(cancel.status).toBe(202);
      expect(cancel.body).toMatchObject({ receipt_status: "succeeded" });
      expect(await api.receipt(receiptId(paused))).toMatchObject({
        status: "failed",
        error: { code: "PAUSE_CANCELLED" },
      });
      const active = await api.session(sessionId);
      expect(active.admission_state).toBe("active");
      expect(active.attention).toBeNull();
      const next = await api.send(sessionId, scripted("pn3", [], "still here"));
      await completed(sessionId, next.turn_id);
    },
    TIMEOUT,
  );
});
