import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";
import {
  Chaos,
  database,
  gateEnv,
  Messages,
  PublicApi,
  prompt,
  run,
  Workers,
  waitFor,
  write,
} from "./harness.ts";

/**
 * the compose stack's reconciler service recovers on its own, with
 * nobody running a pass by hand. On the D2 gate stack (the product topology
 * with the gate's scripted Messages API and fault injector):
 *
 * R1. a worker that stops heartbeating (docker pause) loses its lease; the
 *     periodic pass fences it and asks for its removal, and the scheduler
 *     removes it and settles the open turn outcome_unknown;
 * R2. a worker that keeps heartbeating but cannot end an interrupted turn
 *     (its finalize refused by the fault injector) is sent down the
 *     terminate path once the interrupt is past its deadline, and the
 *     receipt ends unknown instead of staying accepted.
 *
 * Run against a stack run.sh keeps up:
 *   D2_GATE_UP_ONLY=1 scripts/d2-gate/run.sh
 *   . <out>/vars.sh && bun test tests/d2-gate/reconciler-sweep.e2e.test.ts
 * Without it (D2_GATE unset) every test skips.
 */

const env = gateEnv();
// Spec ids carry a suffix so a rerun on a kept stack never matches the
// model calls of an earlier run.
const evidence: Record<string, unknown> = {};

let api: PublicApi;
let db: Pool;
let chaos: Chaos;
let messages: Messages;
let workers: Workers;

async function rows<T>(sql: string, params: unknown[]): Promise<T[]> {
  return (await db.query(sql, params)).rows as T[];
}

async function one<T>(sql: string, params: unknown[]): Promise<T> {
  const [row] = await rows<T>(sql, params);
  if (!row) throw new Error(`no row for ${sql}`);
  return row;
}

/** The reconciler service's log lines that name this session. */
async function reconcilerLines(sessionId: string): Promise<string[]> {
  const { stdout } = await run(
    ["docker", "logs", `${env?.project}-reconciler-1`],
    { allowFail: true },
  );
  return stdout.split("\n").filter((line) => line.includes(sessionId));
}

/**
 * The sweeps that fenced this session. A pass logs one line per sweep for
 * every session it touched, so the session is looked up in the line: in
 * `fenced_session_ids` for the lease sweep, whose `session_ids` also names
 * attempts it only ended, and in `session_ids` for the interrupt sweep,
 * which fences every session it names.
 */
function fencedBy(lines: string[], message: string, sessionId: string) {
  return lines.filter((line) => {
    try {
      const record = JSON.parse(line) as {
        message?: string;
        fields?: { fenced_session_ids?: string[]; session_ids?: string[] };
      };
      const fenced =
        record.fields?.fenced_session_ids ?? record.fields?.session_ids ?? [];
      return record.message === message && fenced.includes(sessionId);
    } catch {
      return false;
    }
  });
}

describe.skipIf(env === null)("periodic reconciler sweep", () => {
  beforeAll(async () => {
    if (!env) return;
    api = new PublicApi(env.apiUrl, env.apiKey, env.releaseId);
    db = database(env.databaseUrl);
    chaos = new Chaos(env.chaosUrl);
    messages = new Messages(env.messagesUrl);
    workers = new Workers(env.installation, env.out);
    workers.watch();
    // Nothing below runs a pass by hand; the service must be the one acting.
    const { stdout } = await run([
      "docker",
      "inspect",
      "--format",
      "{{.State.Status}} {{json .Mounts}}",
      `${env.project}-reconciler-1`,
    ]);
    evidence.reconciler_container = stdout.trim();
    expect(stdout).toStartWith("running ");
    expect(stdout).not.toContain("docker.sock");
  });

  afterAll(async () => {
    if (!env) return;
    await writeFile(
      join(env.out, "reconciler-sweep.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    workers?.stop();
    await db?.end();
  });

  test("R1: a worker whose heartbeat stopped is fenced by the periodic pass and its turn settled unknown", async () => {
    const spec = {
      id: `R1-${crypto.randomUUID().slice(0, 8)}`,
      // Long enough that the turn is still open when the lease runs out.
      steps: [{ ...write("/workspace/r1.txt", "r1\n"), delayMs: 240_000 }],
      final: "R1 DONE",
    };
    const { session_id: sessionId } = await api.createSession(
      prompt("Turn one.", spec),
    );
    evidence.r1_session = sessionId;
    await waitFor(
      "the model call of R1",
      async () => (await messages.requests(spec.id)).length > 0,
      300_000,
      250,
    );
    const worker = await workers.running(sessionId, 10_000);
    const before = await one<{ lease_epoch: number }>(
      "SELECT lease_epoch FROM sessions WHERE id = $1",
      [sessionId],
    );
    await run(["docker", "pause", worker.name]);
    const pausedAt = Date.now();
    try {
      const lost = await waitFor(
        "the attempt to be lost",
        async () =>
          (
            await rows<{ state: string; end_reason: string | null }>(
              "SELECT state, end_reason FROM attempts WHERE session_id = $1 AND state = 'lost'",
              [sessionId],
            )
          )[0],
        120_000,
      );
      evidence.r1_lost_after_ms = Date.now() - pausedAt;
      expect(lost).toEqual({ state: "lost", end_reason: "lease_expired" });

      const turn = await waitFor(
        "the open turn to settle",
        async () => {
          const found = await one<{
            status: string;
            outcome_unknown: boolean;
          }>(
            "SELECT status, outcome_unknown FROM turns WHERE session_id = $1 AND sequence = 1",
            [sessionId],
          );
          return found.status === "running" ? null : found;
        },
        120_000,
      );
      evidence.r1_settled_after_ms = Date.now() - pausedAt;
      const session = await one<{
        admission_state: string;
        lease_epoch: number;
      }>("SELECT admission_state, lease_epoch FROM sessions WHERE id = $1", [
        sessionId,
      ]);
      const lines = await reconcilerLines(sessionId);
      Object.assign(evidence, {
        r1_turn: turn,
        r1_session_after: session,
        r1_reconciler: lines,
      });
      expect(turn.outcome_unknown).toBe(true);
      expect(session.admission_state).toBe("recovery_required");
      // One step for the reconciler's fence, one for the scheduler's
      // confirmed removal; a second fence would make it three.
      expect(session.lease_epoch).toBe(before.lease_epoch + 2);
      expect(
        fencedBy(lines, "Expired lease reconciliation completed", sessionId),
      ).toHaveLength(1);
    } finally {
      await run(["docker", "unpause", worker.name], { allowFail: true });
    }
  }, 600_000);

  test("R2: an interrupt its heartbeating worker cannot settle is sent to terminate and its receipt ends unknown", async () => {
    const spec = {
      id: `R2-${crypto.randomUUID().slice(0, 8)}`,
      steps: [{ ...write("/workspace/r2.txt", "r2\n"), delayMs: 240_000 }],
      final: "R2 DONE",
    };
    const { session_id: sessionId } = await api.createSession(
      prompt("Turn one.", spec),
    );
    evidence.r2_session = sessionId;
    await waitFor(
      "the model call of R2",
      async () => (await messages.requests(spec.id)).length > 0,
      300_000,
      250,
    );
    const worker = await workers.running(sessionId, 10_000);
    const before = await one<{ lease_epoch: number }>(
      "SELECT lease_epoch FROM sessions WHERE id = $1",
      [sessionId],
    );
    // The worker keeps its lease, but no finalize of this session reaches
    // the gateway: the interrupted turn cannot end on its own.
    const rule = await chaos.arm({
      action: "fail",
      bodyContains: sessionId,
      path: "/finalize$",
      times: -1,
      upstream: "gateway",
    });
    try {
      const interrupted = await api.call(
        "POST",
        `/v1/sessions/${sessionId}/interrupt`,
        { target_turn_id: "1" },
      );
      evidence.r2_interrupt = interrupted;
      expect(interrupted.status).toBe(202);
      const receiptId = (interrupted.body as { receipt_id: string }).receipt_id;
      const issuedAt = Date.now();

      const receipt = await waitFor(
        "the interrupt receipt to leave accepted",
        async () => {
          const found = await one<{
            status: string;
            error: unknown;
            result: unknown;
          }>("SELECT status, error, result FROM receipts WHERE id = $1", [
            receiptId,
          ]);
          return found.status === "accepted" ? null : found;
        },
        240_000,
      );
      evidence.r2_receipt_after_ms = Date.now() - issuedAt;
      // The receipt can also go unknown at its own deadline before the
      // scheduler confirms the removal; the epoch below needs that too.
      const turn = await waitFor(
        "the interrupted turn to settle",
        async () => {
          const found = await one<{ status: string }>(
            "SELECT status FROM turns WHERE session_id = $1 AND sequence = 1",
            [sessionId],
          );
          return found.status === "running" ? null : found;
        },
        120_000,
      );
      const execution = await one<{ desired_state: string }>(
        `SELECT e.desired_state FROM executions e
           JOIN attempts a ON a.execution_id = e.id
          WHERE a.session_id = $1 ORDER BY a.started_at DESC LIMIT 1`,
        [sessionId],
      );
      const session = await one<{ lease_epoch: number }>(
        "SELECT lease_epoch FROM sessions WHERE id = $1",
        [sessionId],
      );
      const lines = await reconcilerLines(sessionId);
      const finalizes = (await chaos.log(sessionId)).filter((entry) =>
        entry.path.endsWith("/finalize"),
      );
      Object.assign(evidence, {
        r2_receipt: receipt,
        r2_turn: turn,
        r2_execution: execution,
        r2_lease_epoch: {
          before: before.lease_epoch,
          after: session.lease_epoch,
        },
        r2_refused_finalizes: finalizes.length,
        r2_reconciler: lines,
      });
      expect(receipt.status).toBe("unknown");
      expect(execution.desired_state).toBe("terminated");
      // Fence plus confirmed removal, as in R1.
      expect(session.lease_epoch).toBe(before.lease_epoch + 2);
      // The worker did try to end the turn; only the kill path ended it.
      expect(finalizes.length).toBeGreaterThan(0);
      expect(
        fencedBy(
          lines,
          "Overdue interrupt executions sent to terminate",
          sessionId,
        ),
      ).toHaveLength(1);
    } finally {
      await chaos.disarm(rule);
      await run(["docker", "rm", "-f", worker.name], { allowFail: true });
    }
  }, 600_000);
});
