import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createCheckpointObjectStore } from "@werft-ai/storage";
import type { Pool } from "pg";
import {
  BUCKET,
  Chaos,
  type ChaosEntry,
  database,
  run,
  type WorkerContainer,
  Workers,
} from "../../tests/d2-gate/harness.ts";
import { checkInvariants, runningWorkers } from "./invariants.ts";
import {
  type Criterion,
  compose,
  composeToFile,
  container,
  criterion,
  markdownReport,
  Output,
  reproMeta,
  type SoakEnv,
  soakEnv,
} from "./lib.ts";
import { NO_FAULTS } from "./messages.ts";
import {
  Api,
  admissionProbe,
  Model,
  modelEvidence,
  settle,
  settleReceipt,
  type TurnKind,
  terminateProbe,
  turnPrompt,
} from "./probes.ts";

/**
 * The fault and contention campaigns. Each runs on its own freshly
 * reset stack (scripts/soak/campaign.sh resets between them), drives a few
 * sessions from outside, injects one kind of trouble, and records rows of
 * the criteria table: 입력·기대·실제·pass/fail/skip, plus the invariants
 * after it. Two campaigns run a whole existing check instead: the D2 gate's
 * control-host role test on this stack, and tests/e2e/restore-resume.sh on
 * projects of its own.
 *
 *   source "$SOAK_STATE/vars.sh"
 *   bun scripts/soak/campaigns.ts list
 *   bun scripts/soak/campaigns.ts <campaign-id> [out-dir]
 */

type Ctx = {
  api: Api;
  chaos: Chaos;
  db: Pool;
  env: SoakEnv;
  model: Model;
  out: Output;
  rows: Criterion[];
  workers: Workers;
  id: string;
  counter: number;
};

type Campaign = {
  id: string;
  kind: "fault" | "race";
  title: string;
  run?: (ctx: Ctx) => Promise<void>;
  /**
   * Instead of `run`, for a campaign that brings compose projects of its
   * own: campaign.sh takes the soak stack down first (the host holds two
   * stacks at most), and the rows come from what this returns.
   */
  standalone?: (out: Output) => Promise<Criterion[]>;
};

const TURN_MS = 300_000;
const HEARTBEAT_TTL_MS = 30_000;
const GATEWAY = "/internal/worker";
// A bootstrap-claim carries the launch nonce, not the session: the injector
// logs it with sessionId null. Campaigns that watch claims run one live
// session at a time and scope them by log index and rule instead.

// ---------------------------------------------------------------- helpers

function docker(args: string[]) {
  return run(["docker", ...args], { allowFail: true });
}

/**
 * Starts a stopped or killed service again. Its host port is ephemeral, and
 * Docker hands out a new one on start, so the runner follows it.
 */
async function startAgain(
  ctx: Ctx,
  service: "api" | "postgres" | "scheduler",
): Promise<void> {
  await docker(["start", container(ctx.env, service)]);
  await follow(ctx, service);
}

/** Points the runner at the host port a restarted service has now. */
async function follow(
  ctx: Ctx,
  service: "api" | "postgres" | "scheduler",
): Promise<void> {
  const hostPort = async (port: number) => {
    const result = await compose(ctx.env, ["port", service, String(port)]);
    const found = result.stdout.trim().split(":").at(-1);
    if (result.code !== 0 || !found) {
      throw new Error(`no host port for ${service}:${port}: ${result.stderr}`);
    }
    return found;
  };
  if (service === "api") {
    ctx.env.apiUrl = `http://127.0.0.1:${await hostPort(3000)}`;
    ctx.api = new Api(
      ctx.env.apiUrl,
      ctx.env.apiKey,
      undefined,
      ctx.env.approveKey,
    );
  } else if (service === "postgres") {
    const url = new URL(ctx.env.databaseUrl);
    url.port = await hostPort(5432);
    ctx.env.databaseUrl = url.toString();
    const stale = ctx.db;
    ctx.db = database(ctx.env.databaseUrl);
    await stale.end().catch(() => {});
  }
}

function note(ctx: Ctx, record: Record<string, unknown>): void {
  ctx.out.jsonl("steps").write({ campaign: ctx.id, ...record });
  console.error(`[${ctx.id}] ${JSON.stringify(record).slice(0, 300)}`);
}

type Started = { sessionId: string; specId: string; turnId: string };

async function startTurn(
  ctx: Ctx,
  sessionId: string | null,
  kind: TurnKind,
  slowStepMs = 60_000,
): Promise<Started> {
  const specId = `${ctx.id}-${++ctx.counter}`;
  const text = turnPrompt({
    id: specId,
    kind,
    slowStepMs,
    stepDelayMs: 200,
    slot: ctx.counter % 20,
  });
  const posted = sessionId
    ? await ctx.api.postMessage(sessionId, text)
    : await ctx.api.createSession(text);
  const body = (posted.body ?? {}) as { session_id?: string; turn_id?: string };
  const id = sessionId ?? body.session_id;
  if (
    (posted.status !== 201 && posted.status !== 202) ||
    !id ||
    !body.turn_id
  ) {
    throw new Error(
      `turn not accepted: ${posted.status} ${JSON.stringify(posted.body)}`,
    );
  }
  note(ctx, {
    step: "turn",
    sessionId: id,
    turnId: body.turn_id,
    specId,
    kind,
  });
  return { sessionId: id, specId, turnId: body.turn_id };
}

async function finish(ctx: Ctx, started: Started, timeoutMs = TURN_MS) {
  const settled = await settle(ctx.api, started.sessionId, started.turnId, {
    pollMs: 500,
    timeoutMs,
  });
  const status = settled ? String(settled.turn.status) : "timeout";
  note(ctx, { step: "settled", ...started, status });
  return { status, turn: settled?.turn ?? null };
}

/** A new session with one completed turn; returns its spec for context checks. */
async function readySession(ctx: Ctx): Promise<Started & { status: string }> {
  const started = await startTurn(ctx, null, "normal");
  const { status } = await finish(ctx, started);
  return { ...started, status };
}

async function sessionRow(db: Pool, sessionId: string) {
  const { rows } = await db.query(
    `SELECT status::text, admission_state::text, checkpoint_revision, checkpoint_pending_reason,
            checkpoint_fallback_revision, context_reset_turn_sequence, lease_epoch, execution_generation
       FROM sessions WHERE id = $1`,
    [sessionId],
  );
  return (rows[0] ?? null) as Record<string, unknown> | null;
}

async function turnRow(db: Pool, sessionId: string, turnId: string) {
  const { rows } = await db.query(
    `SELECT status, outcome_unknown, terminal_reason, attempt_id
       FROM turns WHERE session_id = $1 AND sequence::text = $2`,
    [sessionId, turnId],
  );
  return (rows[0] ?? null) as Record<string, unknown> | null;
}

/** The pointer is the newest committed checkpoint, or none. */
async function pointerMismatches(db: Pool): Promise<unknown[]> {
  const { rows } = await db.query(
    `SELECT s.id::text, s.checkpoint_revision, max(c.revision) AS newest
       FROM sessions s LEFT JOIN checkpoints c ON c.session_id = s.id
      GROUP BY s.id, s.checkpoint_revision
     HAVING s.checkpoint_revision IS DISTINCT FROM max(c.revision)`,
  );
  return rows;
}

/**
 * Every attempt's events are numbered 1, 2, 3… with no gap or repeat. Events
 * the control plane records about an attempt ('s restore failure)
 * carry its id but no worker sequence, so they are not part of the count.
 */
async function numberingProblems(db: Pool): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT e.attempt_id, e.source_sequence,
        EXISTS (SELECT 1 FROM session_event_archives a
                WHERE a.session_id = e.session_id AND a.through_id < e.id)
          AS follows_archive
      FROM events e
      WHERE e.attempt_id IS NOT NULL AND e.source_sequence IS NOT NULL
      ORDER BY e.attempt_id, e.source_sequence`,
  );
  const problems: string[] = [];
  let last: string | null = null;
  let sequence = 0;
  for (const row of rows as Array<{
    attempt_id: string;
    follows_archive: boolean;
    source_sequence: number;
  }>) {
    const continues = row.attempt_id === last;
    const expected = continues ? sequence + 1 : 1;
    // An attempt's opening events may have moved into an archived chunk.
    const archivedStart = !continues && row.follows_archive;
    if (row.source_sequence !== expected && !archivedStart) {
      problems.push(`${row.attempt_id}: ${sequence} → ${row.source_sequence}`);
    }
    last = row.attempt_id;
    sequence = row.source_sequence;
  }
  return problems;
}

async function invariants(ctx: Ctx, input: string): Promise<void> {
  const { results, observations } = await checkInvariants(ctx.db, {
    installation: ctx.env.installation,
    slotLeakGraceSec: 120,
    slotLimit: 10,
    toleranceMs: 1000,
  });
  const pointer = await pointerMismatches(ctx.db);
  const numbering = await numberingProblems(ctx.db);
  ctx.out
    .jsonl("invariants")
    .write({ results, observations, pointer, numbering });
  const bad = results.filter((result) => result.count > 0);
  ctx.rows.push(
    criterion({
      id: `${ctx.id}/inv`,
      area: "불변식",
      input,
      expected:
        "stale write·중복 실행·slot 누수·미확인 성공·조용한 context 초기화 0건, checkpoint pointer = 최신 commit, attempt별 event 번호 연속",
      actual:
        bad.length + pointer.length + numbering.length === 0
          ? `0건 (${JSON.stringify(observations)})`
          : {
              violations: bad.map((result) => ({
                id: result.id,
                count: result.count,
                rows: result.rows.slice(0, 3),
              })),
              pointer,
              numbering,
            },
      pass: bad.length + pointer.length + numbering.length === 0,
    }),
  );
}

async function readyzFor(ctx: Ctx, ms: number, intervalMs = 500) {
  const samples: Array<{ at: number; status: number }> = [];
  const until = Date.now() + ms;
  while (Date.now() < until) {
    let status = 0;
    try {
      status = (
        await fetch(`${ctx.env.apiUrl}/readyz`, {
          signal: AbortSignal.timeout(2000),
        })
      ).status;
    } catch {}
    samples.push({ at: Date.now(), status });
    await Bun.sleep(intervalMs);
  }
  return samples;
}

async function waitReady(ctx: Ctx, timeoutMs: number): Promise<number | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${ctx.env.apiUrl}/readyz`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.status === 200) return Date.now() - started;
    } catch {}
    await Bun.sleep(500);
  }
  return null;
}

async function reconcileOnce(ctx: Ctx): Promise<string> {
  const result = await docker([
    "run",
    "--rm",
    "--network",
    ctx.env.network,
    "-e",
    "DATABASE_URL=postgres://postgres:dev@postgres:5432/sessions",
    "-e",
    "HEARTBEAT_TTL_SEC=30",
    "-e",
    "LOG_LEVEL=info",
    ctx.env.apiImage,
    "bun",
    "run",
    "apps/control-host/src/main.ts",
    "reconciler",
    "--once",
  ]);
  const output = `${result.stdout}${result.stderr}`;
  ctx.out
    .jsonl("reconciler")
    .write({ code: result.code, output: output.slice(-4000) });
  return output;
}

async function waitChaos(
  ctx: Ctx,
  match: (entry: ChaosEntry) => boolean,
  timeoutMs: number,
): Promise<ChaosEntry | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const found = (await ctx.chaos.log()).find(match);
    if (found) return found;
    await Bun.sleep(100);
  }
  return null;
}

/** The index the injector will give the next request it sees. */
async function chaosCursor(ctx: Ctx): Promise<number> {
  return ((await ctx.chaos.log()).at(-1)?.index ?? -1) + 1;
}

function regexLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function worker(ctx: Ctx, sessionId: string): Promise<WorkerContainer> {
  return ctx.workers.running(sessionId, 180_000);
}

/** After a turn the soak cannot vouch for, get the session taking input again. */
async function unblock(
  ctx: Ctx,
  sessionId: string,
  turnId: string,
): Promise<string> {
  const row = await sessionRow(ctx.db, sessionId);
  if (row?.admission_state !== "recovery_required") return "none needed";
  const session = await ctx.api.session(sessionId);
  const decided = await ctx.api.call(
    "POST",
    `/v1/sessions/${sessionId}/recovery-decisions`,
    {
      decision: "abandon",
      target_turn_id: turnId,
      expected_revision: Number(session?.revision ?? 0),
      reason: "94S-135 campaign: the killed turn is given up",
    },
  );
  // Abandon leaves the session stopped; only a resume admits input again.
  if (decided.status !== 202) return `abandon → ${decided.status}`;
  const resumed = await ctx.api.control(sessionId, "resume");
  return `abandon → 202, resume → ${resumed.status}`;
}

// ---------------------------------------------------------------- faults

const dbOutage: Campaign = {
  id: "fault-db",
  kind: "fault",
  title: "Postgres stops for 30s while turns run",
  async run(ctx) {
    const a = await readySession(ctx);
    const b = await readySession(ctx);
    const slow = await startTurn(ctx, a.sessionId, "interrupt", 60_000);
    await ctx.model.reached(slow.specId, 1, 120_000);
    const stopped = Date.now();
    await docker(["stop", "-t", "10", container(ctx.env, "postgres")]);
    const during = await readyzFor(ctx, 30_000);
    await startAgain(ctx, "postgres");
    const recoveredMs = await waitReady(ctx, 180_000);
    const slowEnd = await finish(ctx, slow);
    const slowRow = await turnRow(ctx.db, slow.sessionId, slow.turnId);
    const unblocked = await unblock(ctx, a.sessionId, slow.turnId);
    const nextA = await finish(
      ctx,
      await startTurn(ctx, a.sessionId, "normal"),
    );
    const nextB = await startTurn(ctx, b.sessionId, "normal");
    const nextBEnd = await finish(ctx, nextB);
    const evidence = modelEvidence(
      await ctx.model.requests({ spec: nextB.specId }),
      b.specId,
    );
    const notReady = during.filter((sample) => sample.status !== 200).length;
    ctx.rows.push(
      criterion({
        id: "fault-db/readyz",
        area: "장애: DB",
        input: "docker stop postgres 30s, /readyz 500ms 폴링, docker start",
        expected: "중단 중 /readyz가 ready가 아니고, 재시작 뒤 180초 안에 200",
        actual: {
          notReadySamples: notReady,
          samples: during.length,
          recoveredMs,
          outageMs: Date.now() - stopped,
        },
        pass: notReady > 0 && recoveredMs !== null,
      }),
      criterion({
        id: "fault-db/turns",
        area: "장애: DB",
        input: "중단 동안 진행 중이던 turn과, 재시작 뒤 두 세션의 다음 turn",
        expected:
          "진행 중 turn은 종료 상태로 끝나고 outcome_unknown이면 completed가 아니다; 다음 turn은 둘 다 completed, 세션 B는 직전 turn을 기억",
        actual: {
          slow: slowEnd.status,
          slowRow,
          unblocked,
          nextA: nextA.status,
          nextB: nextBEnd.status,
          contextKept: evidence.contextKept,
        },
        pass:
          slowEnd.status !== "timeout" &&
          !(
            slowRow?.outcome_unknown === true && slowRow?.status === "completed"
          ) &&
          nextA.status === "completed" &&
          nextBEnd.status === "completed" &&
          evidence.contextKept === true,
      }),
    );
    await invariants(ctx, "DB 중단·재시작 뒤");
  },
};

const s3Outage: Campaign = {
  id: "fault-s3",
  kind: "fault",
  title: "the object store fails for workers, then for the API",
  async run(ctx) {
    const a = await readySession(ctx);
    const before = await sessionRow(ctx.db, a.sessionId);
    // Worker side: every object request the worker makes fails.
    const rule = await ctx.chaos.arm({
      action: "fail",
      upstream: "s3",
      path: ".*",
      times: -1,
    });
    const during = await startTurn(ctx, a.sessionId, "normal");
    const duringEnd = await finish(ctx, during);
    const blocked = await sessionRow(ctx.db, a.sessionId);
    await ctx.chaos.disarm(rule);
    const reconciled = await unblock(ctx, a.sessionId, during.turnId);
    let after: { status: string } = { status: "not attempted" };
    let afterRow: Record<string, unknown> | null = null;
    try {
      after = await finish(ctx, await startTurn(ctx, a.sessionId, "normal"));
      afterRow = await sessionRow(ctx.db, a.sessionId);
    } catch (error) {
      after = { status: `refused: ${String(error).slice(0, 200)}` };
    }
    ctx.rows.push(
      criterion({
        id: "fault-s3/worker",
        area: "장애: S3",
        input:
          "gate-chaos가 워커의 모든 S3 요청에 500, turn 1개, 해제 뒤 turn 1개",
        expected:
          "장애 중 checkpoint pointer가 전진하지 않고(불완전한 checkpoint 승격 없음) 막힌 이유가 세션에 남는다; 해제 뒤 다음 turn이 checkpoint를 다시 올리거나, 명시적 이유로 거절된다",
        actual: {
          before: before?.checkpoint_revision,
          during: duringEnd.status,
          blocked: {
            revision: blocked?.checkpoint_revision,
            reason: blocked?.checkpoint_pending_reason,
          },
          reconciled,
          after: after.status,
          afterRow,
        },
        pass:
          blocked?.checkpoint_revision === before?.checkpoint_revision &&
          blocked?.checkpoint_pending_reason != null &&
          (afterRow?.checkpoint_revision !== blocked?.checkpoint_revision ||
            after.status.startsWith("refused")),
      }),
    );

    // API side: LocalStack frozen while a turn finalizes.
    const b = await readySession(ctx);
    const bBefore = await sessionRow(ctx.db, b.sessionId);
    const slow = await startTurn(ctx, b.sessionId, "normal");
    await ctx.model.reached(slow.specId, 1, 120_000);
    await docker(["pause", container(ctx.env, "localstack")]);
    const readyDuring = await readyzFor(ctx, 30_000);
    await docker(["unpause", container(ctx.env, "localstack")]);
    const slowEnd = await finish(ctx, slow);
    const bAfter = await sessionRow(ctx.db, b.sessionId);
    const next = await finish(ctx, await startTurn(ctx, b.sessionId, "normal"));
    const bNext = await sessionRow(ctx.db, b.sessionId);
    ctx.rows.push(
      criterion({
        id: "fault-s3/all",
        area: "장애: S3",
        input:
          "docker pause localstack 30s (API·워커 모두), 그 사이 turn 종료, unpause 뒤 turn 1개",
        expected:
          "pause 중 finalize가 끝난 turn은 checkpoint를 승격하지 못하면 이유를 남긴다; unpause 뒤 다음 turn은 completed이고 pointer가 전진한다",
        actual: {
          readyzNot200: readyDuring.filter((s) => s.status !== 200).length,
          slow: slowEnd.status,
          before: bBefore?.checkpoint_revision,
          afterSlow: {
            revision: bAfter?.checkpoint_revision,
            reason: bAfter?.checkpoint_pending_reason,
          },
          next: next.status,
          afterNext: {
            revision: bNext?.checkpoint_revision,
            reason: bNext?.checkpoint_pending_reason,
          },
        },
        pass:
          next.status === "completed" &&
          Number(bNext?.checkpoint_revision ?? -1) >
            Number(bBefore?.checkpoint_revision ?? -1) &&
          (bAfter?.checkpoint_revision !== bBefore?.checkpoint_revision ||
            bAfter?.checkpoint_pending_reason != null),
      }),
    );
    await invariants(ctx, "S3 장애 두 가지 뒤");
  },
};

const publishFailure: Campaign = {
  id: "fault-publish",
  kind: "fault",
  title: "a checkpoint publish fails at the manifest (94S-312)",
  async run(ctx) {
    const a = await readySession(ctx);
    const before = await sessionRow(ctx.db, a.sessionId);
    const rule = await ctx.chaos.arm({
      action: "fail",
      upstream: "s3",
      method: "PUT",
      path: `sessions/${a.sessionId}/checkpoints/.*/manifest\\.json`,
      times: -1,
    });
    const failing = await finish(
      ctx,
      await startTurn(ctx, a.sessionId, "normal"),
    );
    const failed = await sessionRow(ctx.db, a.sessionId);
    await ctx.chaos.disarm(rule);
    const next = await finish(ctx, await startTurn(ctx, a.sessionId, "normal"));
    const healed = await sessionRow(ctx.db, a.sessionId);
    ctx.rows.push(
      criterion({
        id: "fault-publish/trace",
        area: "장애: publish 실패",
        input: "manifest PUT을 500으로 실패시키고 turn 1개, 해제 뒤 turn 1개",
        expected:
          "실패한 turn 뒤 pointer 그대로 + checkpoint_pending_reason이 남는다(흔적); 다음 turn이 pointer를 전진시키고 이유를 지운다",
        actual: {
          before: before?.checkpoint_revision,
          failing: failing.status,
          failed: {
            revision: failed?.checkpoint_revision,
            reason: failed?.checkpoint_pending_reason,
          },
          next: next.status,
          healed: {
            revision: healed?.checkpoint_revision,
            reason: healed?.checkpoint_pending_reason,
          },
        },
        pass:
          failed?.checkpoint_revision === before?.checkpoint_revision &&
          failed?.checkpoint_pending_reason != null &&
          next.status === "completed" &&
          Number(healed?.checkpoint_revision ?? -1) >
            Number(failed?.checkpoint_revision ?? -1) &&
          healed?.checkpoint_pending_reason == null,
      }),
    );
    await invariants(ctx, "publish 실패 뒤");
  },
};

const workerKill: Campaign = {
  id: "fault-worker-kill",
  kind: "fault",
  title: "a worker is SIGKILLed mid-turn, then another drains on SIGTERM",
  async run(ctx) {
    const a = await readySession(ctx);
    const slow = await startTurn(ctx, a.sessionId, "interrupt", 60_000);
    const running = await worker(ctx, a.sessionId);
    await ctx.model.reached(slow.specId, 1, 120_000);
    await docker(["kill", "-s", "KILL", running.name]);
    const killed = await finish(ctx, slow);
    await reconcileOnce(ctx);
    const killedRow = await turnRow(ctx.db, slow.sessionId, slow.turnId);
    const killedEvidence = modelEvidence(
      await ctx.model.requests({ spec: slow.specId }),
      null,
    );
    const unblocked = await unblock(ctx, a.sessionId, slow.turnId);
    const next = await startTurn(ctx, a.sessionId, "normal");
    const nextEnd = await finish(ctx, next);
    const nextEvidence = modelEvidence(
      await ctx.model.requests({ spec: next.specId }),
      a.specId,
    );
    ctx.rows.push(
      criterion({
        id: "fault-worker-kill/sigkill",
        area: "장애: worker 종료",
        input: "느린 모델 호출 중 worker SIGKILL, reconciler 1회, 다음 turn",
        expected:
          "죽은 turn은 completed가 아니고(outcome_unknown 기대), 자동 재실행 0(첫 모델 호출 응답 1회); 다음 turn은 새 worker에서 completed이고 직전 완료 turn을 기억한다",
        actual: {
          killed: killed.status,
          killedRow,
          startsAnswered: killedEvidence.startsAnswered,
          unblocked,
          next: nextEnd.status,
          contextKept: nextEvidence.contextKept,
        },
        pass:
          killedRow?.status !== "completed" &&
          killedEvidence.startsAnswered === 1 &&
          nextEnd.status === "completed" &&
          nextEvidence.contextKept === true,
      }),
    );

    const b = await readySession(ctx);
    const draining = await startTurn(ctx, b.sessionId, "normal");
    const drainingWorker = await worker(ctx, b.sessionId);
    await ctx.model.reached(draining.specId, 1, 120_000);
    await docker(["stop", "-t", "120", drainingWorker.name]);
    const code = (
      await docker([
        "inspect",
        "--format",
        "{{.State.ExitCode}}",
        drainingWorker.name,
      ])
    ).stdout.trim();
    const drained = await finish(ctx, draining);
    const after = await finish(
      ctx,
      await startTurn(ctx, b.sessionId, "normal"),
    );
    ctx.rows.push(
      criterion({
        id: "fault-worker-kill/sigterm",
        area: "장애: worker 종료",
        input: "turn 중 docker stop -t 120 (SIGTERM drain), 다음 turn",
        expected:
          "worker가 0으로 끝나고 진행 중 turn이 completed; 다음 turn completed",
        actual: {
          exitCode: code,
          drained: drained.status,
          after: after.status,
        },
        pass:
          code === "0" &&
          drained.status === "completed" &&
          after.status === "completed",
      }),
    );
    await invariants(ctx, "worker SIGKILL·SIGTERM 뒤");
  },
};

const controlKill: Campaign = {
  id: "fault-control-kill",
  kind: "fault",
  title: "the API and the scheduler are SIGKILLed while turns run",
  async run(ctx) {
    const sessions = [await readySession(ctx), await readySession(ctx)];
    const results: Record<string, unknown> = {};
    for (const service of ["api", "scheduler"] as const) {
      const turns = await Promise.all(
        sessions.map((s) => startTurn(ctx, s.sessionId, "normal")),
      );
      await Promise.all(
        turns.map((t) => ctx.model.reached(t.specId, 1, 120_000)),
      );
      await docker(["kill", "-s", "KILL", container(ctx.env, service)]);
      await Bun.sleep(10_000);
      // The API has no restart policy in compose; the scheduler's is
      // unless-stopped, which a kill does not prevent. Start both the way
      // an operator would, idempotently.
      await startAgain(ctx, service);
      const readyMs = await waitReady(ctx, 180_000);
      const ended = await Promise.all(turns.map((t) => finish(ctx, t)));
      // A turn whose outcome the kill left unconfirmed stops its session
      // for an operator decision; give it up the way an operator would.
      const unblocked = await Promise.all(
        turns.map((t) => unblock(ctx, t.sessionId, t.turnId)),
      );
      // A next turn the kill still cost (refused, or not completed) fails
      // this row; it must not also keep the next service's round from
      // starting.
      const nextTurns = await Promise.all(
        sessions.map((s) =>
          startTurn(ctx, s.sessionId, "normal").catch(
            (error: unknown) => `refused: ${String(error)}`,
          ),
        ),
      );
      const next = await Promise.all(
        nextTurns.map((t) =>
          typeof t === "string" ? { status: t } : finish(ctx, t),
        ),
      );
      await Promise.all(
        nextTurns.map((t) =>
          typeof t === "string" ? null : unblock(ctx, t.sessionId, t.turnId),
        ),
      );
      results[service] = {
        readyMs,
        during: ended.map((e) => e.status),
        unblocked,
        next: next.map((e) => e.status),
      };
    }
    const receipts = await ctx.db.query(
      `SELECT operation, status::text, count(*)::int AS n FROM receipts GROUP BY 1, 2 ORDER BY 1, 2`,
    );
    ctx.rows.push(
      criterion({
        id: "fault-control-kill/roles",
        area: "장애: control role 종료",
        input:
          "두 세션 turn 중 api SIGKILL 10초 → start, 같은 방식으로 scheduler",
        expected:
          "API가 180초 안에 ready; 그때 돌던 turn은 끝나고(결과를 모르면 recovery_required → abandon·resume), 다음 turn은 모두 completed; receipt·event·pointer 일치(불변식 행)",
        actual: { ...results, receipts: receipts.rows },
        pass: (["api", "scheduler"] as const).every((service) => {
          const r = results[service] as {
            readyMs: number | null;
            during: string[];
            next: string[];
          };
          return (
            r.readyMs !== null &&
            r.during.every((s) => s !== "timeout") &&
            r.next.every((s) => s === "completed")
          );
        }),
      }),
    );
    await invariants(ctx, "api·scheduler SIGKILL 뒤");
  },
};

const corruptFallback: Campaign = {
  id: "fault-corrupt-fallback",
  kind: "fault",
  title: "the newest checkpoint reads back damaged on restore (94S-204)",
  async run(ctx) {
    const first = await readySession(ctx);
    const second = await startTurn(ctx, first.sessionId, "normal");
    await finish(ctx, second);
    const row = await sessionRow(ctx.db, first.sessionId);
    const revision = Number(row?.checkpoint_revision ?? -1);
    const { rows } = await ctx.db.query(
      "SELECT manifest_ref FROM checkpoints WHERE session_id = $1 AND revision = $2",
      [first.sessionId, revision],
    );
    const manifest = String(
      (rows[0] as { manifest_ref?: string } | undefined)?.manifest_ref ?? "",
    );
    const running = await worker(ctx, first.sessionId);
    await docker(["stop", "-t", "120", running.name]);
    const volumeLabelNamespace =
      process.env.EXECUTION_VOLUME_LABEL_NAMESPACE || "werft";
    const volumes = (
      await docker([
        "volume",
        "ls",
        "-q",
        "--filter",
        `label=${volumeLabelNamespace}.installation=${ctx.env.installation}`,
        "--filter",
        `label=${volumeLabelNamespace}.session-id=${first.sessionId}`,
      ])
    ).stdout
      .split("\n")
      .filter(Boolean);
    let removed = false;
    for (let tries = 0; tries < 60 && !removed; tries++) {
      removed = true;
      for (const volume of volumes) {
        if ((await docker(["volume", "rm", volume])).code !== 0)
          removed = false;
      }
      if (!removed) await Bun.sleep(2000);
    }
    const rule = await ctx.chaos.arm({
      action: "corrupt",
      upstream: "s3",
      method: "GET",
      path: regexLiteral(manifest),
      times: -1,
    });
    const third = await startTurn(ctx, first.sessionId, "normal");
    const thirdEnd = await finish(ctx, third);
    // Without a damaged read the restore took some other path, and whatever
    // it did says nothing about fallback.
    // Answers the rule actually damaged (a 2xx with a body), not merely
    // matched: a failed upstream read changes nothing and proves nothing.
    const corrupted = (await ctx.chaos.log()).filter(
      (entry) => entry.rule === rule && entry.corrupted === true,
    ).length;
    await ctx.chaos.disarm(rule);
    const after = await sessionRow(ctx.db, first.sessionId);
    const evidence = modelEvidence(
      await ctx.model.requests({ spec: third.specId }),
      second.specId,
    );
    const fellBack = after?.checkpoint_fallback_revision != null;
    // The two outcomes designs for damage: an older revision is
    // restored and recorded, or the session stops for a recovery decision.
    const visible = fellBack || after?.admission_state === "recovery_required";
    ctx.rows.push(
      criterion({
        id: "fault-corrupt-fallback/restore",
        area: "장애: 손상 fallback",
        input: `revision ${revision}의 manifest(${manifest})를 복원 GET에서 1바이트 손상, workspace volume 삭제 뒤 turn (손상 규칙이 실제로 1회 이상 적용되어야 유효)`,
        expected:
          "손상을 digest로 잡아 이전 revision으로 fallback하고 그 사실이 세션에 남는다(checkpoint_fallback_revision) — 또는 recovery_required로 멈춘다; 직전 turn을 잃고도 조용히 이어가지 않는다",
        actual: {
          volumeRemoved: removed,
          corruptedReads: corrupted,
          third: thirdEnd.status,
          after,
          contextKeptTurn2: evidence.contextKept,
        },
        pass:
          removed &&
          corrupted > 0 &&
          visible &&
          !(evidence.contextKept === false && !fellBack),
      }),
    );
    await invariants(ctx, "손상 fallback 뒤");
  },
};

/**
 * Worker wall-clock skew and jumps through libfaketime in a derived worker
 * image: Docker Desktop runs every container on one kernel clock, so moving
 * the real clock would move every other card's stack too. Monotonic time is
 * left alone (FAKETIME_DONT_FAKE_MONOTONIC), which is what a skewed host
 * looks like. (lease on a monotonic deadline) is what should make
 * this pass; before it lands a failure here is the expected finding.
 */
const clockSkew: Campaign = {
  id: "fault-clock",
  kind: "fault",
  title: "worker wall clock skewed ±120s and jumped +300s mid-turn",
  async run(ctx) {
    const dir = join(ctx.out.dir, "faketime");
    mkdirSync(dir, { recursive: true });
    const tag = `${ctx.env.workerImage}-faketime`;
    writeFileSync(
      join(dir, "Dockerfile"),
      [
        "FROM debian:bookworm-slim AS faketime",
        'RUN apt-get update && apt-get install -y --no-install-recommends faketime && mkdir /out && cp "$(find /usr/lib -name libfaketime.so.1 | head -n 1)" /out/',
        `FROM ${ctx.env.workerImage}`,
        "COPY --from=faketime /out/libfaketime.so.1 /opt/faketime/libfaketime.so.1",
        "ENV LD_PRELOAD=/opt/faketime/libfaketime.so.1 FAKETIME_DONT_FAKE_MONOTONIC=1 FAKETIME_NO_CACHE=1 FAKETIME_TIMESTAMP_FILE=/tmp/faketimerc",
        "",
      ].join("\n"),
    );
    const built = await docker(["build", "-t", tag, dir]);
    ctx.out.text("faketime-build.log", `${built.stdout}${built.stderr}`);
    if (built.code !== 0) throw new Error("faketime image build failed");
    // The scheduler hands workers WORKER_IMAGE; recreating it with another
    // value is how the whole installation's next launches get that image.
    const useImage = async (image: string) => {
      const child = Bun.spawn(
        [
          "docker",
          "compose",
          "-p",
          ctx.env.project,
          ...ctx.env.composeFiles,
          "--profile",
          "apps",
          "up",
          "-d",
          "--no-deps",
          "--wait",
          "scheduler",
        ],
        {
          env: { ...process.env, WORKER_IMAGE: image },
          stderr: "pipe",
          stdout: "pipe",
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      note(ctx, {
        step: "scheduler image",
        image,
        code,
        output: `${stdout}${stderr}`.slice(-500),
      });
    };
    const results: Record<string, unknown> = {};
    try {
      for (const skew of ["+120s", "-120s"]) {
        await useImage(tag);
        const started = await startTurn(ctx, null, "normal");
        const running = await worker(ctx, started.sessionId);
        await docker([
          "exec",
          running.name,
          "sh",
          "-c",
          `echo ${skew} > /tmp/faketimerc`,
        ]);
        const firstEnd = await finish(ctx, started);
        const next = await finish(
          ctx,
          await startTurn(ctx, started.sessionId, "normal"),
        );
        results[`skew ${skew}`] = { first: firstEnd.status, next: next.status };
      }
      const jumping = await startTurn(ctx, null, "interrupt", 20_000);
      const running = await worker(ctx, jumping.sessionId);
      await ctx.model.reached(jumping.specId, 1, 120_000);
      await docker([
        "exec",
        running.name,
        "sh",
        "-c",
        "echo +300s > /tmp/faketimerc",
      ]);
      const jumped = await finish(ctx, jumping);
      const after = await finish(
        ctx,
        await startTurn(ctx, jumping.sessionId, "normal"),
      );
      results["jump +300s"] = { during: jumped.status, after: after.status };
    } finally {
      await useImage(ctx.env.workerImage);
    }
    ctx.rows.push(
      criterion({
        id: "fault-clock/worker",
        area: "장애: clock skew/jump",
        input:
          "libfaketime 파생 worker 이미지: 시작 직후 벽시계 +120s, -120s; 느린 모델 호출 중 +300s 점프 (monotonic은 그대로)",
        expected:
          "벽시계가 틀어져도 lease를 스스로 잃지 않고 turn이 completed (94S-322 착지 전에는 실패가 예상 결과)",
        actual: results,
        pass: Object.values(results).every((r) =>
          Object.values(r as Record<string, string>).every(
            (s) => s === "completed",
          ),
        ),
      }),
    );
    await invariants(ctx, "clock skew/jump 뒤");
  },
};

// ---------------------------------------------------------------- races

/**
 * A terminate already posted: when its receipt settled (succeeded or
 * unknown) and no worker of the session was running, both observed.
 */
async function terminateEffect(
  ctx: Ctx,
  sessionId: string,
  posted: { body: unknown; sentAt: number; status: number },
): Promise<{ effectMs: number | null; receiptStatus: string | null }> {
  const receiptId =
    ((posted.body ?? {}) as { receipt_id?: string }).receipt_id ?? null;
  let receiptStatus: string | null = null;
  while (receiptId && Date.now() - posted.sentAt < 60_000) {
    const receipt = await ctx.api.receipt(receiptId);
    if (receipt && receipt.status !== "accepted") {
      receiptStatus = String(receipt.status);
      const running = (await runningWorkers(ctx.env.installation)).get(
        sessionId,
      );
      if (!running?.length) {
        return { effectMs: Date.now() - posted.sentAt, receiptStatus };
      }
    }
    await Bun.sleep(250);
  }
  return { effectMs: null, receiptStatus };
}

const claimTerminate: Campaign = {
  id: "race-claim-terminate",
  kind: "race",
  title: "terminate lands between a claim and its replay (94S-291)",
  async run(ctx) {
    const results: unknown[] = [];
    for (let round = 0; round < 3; round++) {
      const since = await chaosCursor(ctx);
      const lost = await ctx.chaos.arm({
        action: "lose_response",
        upstream: "gateway",
        method: "POST",
        path: `${GATEWAY}/bootstrap-claim$`,
        times: 1,
      });
      // Held until released after the terminate is accepted; the cap only
      // keeps a broken round from stranding the worker for good.
      const held = await ctx.chaos.arm({
        action: "hold",
        delayMs: 120_000,
        upstream: "gateway",
        method: "POST",
        path: `${GATEWAY}/bootstrap-claim$`,
        times: -1,
      });
      const started = await startTurn(ctx, null, "normal");
      // The order under test: the first claim commits upstream and its answer
      // is lost; the worker's replay reaches the injector and is held; the
      // terminate is accepted; only then is the replay released to the
      // gateway. Each step is waited for, not assumed.
      const firstClaim = await waitChaos(
        ctx,
        (entry) =>
          entry.index >= since &&
          entry.rule === lost &&
          entry.upstreamStatus !== null,
        180_000,
      );
      const replayHeld = firstClaim
        ? await waitChaos(
            ctx,
            (entry) => entry.index > firstClaim.index && entry.rule === held,
            60_000,
          )
        : null;
      const posted = await ctx.api.control(started.sessionId, "terminate");
      // Released only once the terminate is durable; any other answer leaves
      // the round without its premise, and the pass condition says so.
      if (posted.status === 202) await ctx.chaos.release(held);
      const terminateReceipt =
        ((posted.body ?? {}) as { receipt_id?: string }).receipt_id ?? null;
      // The terminate's commit on the database's clock, which the injector
      // shares: the replay must have gone on after it.
      const { rows: receiptRows } = terminateReceipt
        ? await ctx.db.query("SELECT created_at FROM receipts WHERE id = $1", [
            terminateReceipt,
          ])
        : { rows: [] };
      const acceptedAt =
        (
          receiptRows[0] as { created_at: Date } | undefined
        )?.created_at.toISOString() ?? null;
      const replayAnswered = replayHeld
        ? await waitChaos(
            ctx,
            (entry) =>
              entry.index === replayHeld.index && entry.upstreamStatus !== null,
            30_000,
          )
        : null;
      const terminated = await terminateEffect(ctx, started.sessionId, posted);
      await ctx.chaos.disarm(lost);
      await ctx.chaos.disarm(held);
      const replays = (await ctx.chaos.log()).filter(
        (entry) =>
          entry.index > (firstClaim?.index ?? Number.MAX_SAFE_INTEGER) &&
          entry.path.endsWith("/bootstrap-claim"),
      );
      const models = await ctx.model.requests({ spec: started.specId });
      const turn = await turnRow(ctx.db, started.sessionId, started.turnId);
      const open = await ctx.db.query(
        "SELECT count(*)::int AS n FROM attempts WHERE session_id = $1 AND state NOT IN ('exited', 'lost')",
        [started.sessionId],
      );
      results.push({
        round,
        firstClaimUpstream: firstClaim?.upstreamStatus ?? null,
        replayHeldAt: replayHeld?.at ?? null,
        terminateAcceptedAt: acceptedAt,
        replayForwardedAt: replayAnswered?.forwardedAt ?? null,
        heldReplayUpstream: replayAnswered?.upstreamStatus ?? null,
        terminateAccepted: posted.status,
        terminate: {
          receipt: terminated.receiptStatus,
          effectMs: terminated.effectMs,
        },
        replays: replays.map((entry) => entry.upstreamStatus),
        modelRequestsAfterTerminate: models.filter(
          (entry) => Date.parse(entry.at) > Date.now() - 60_000,
        ).length,
        turn,
        openAttempts: (open.rows[0] as { n: number }).n,
      });
    }
    note(ctx, { step: "rounds", results });
    ctx.rows.push(
      criterion({
        id: "race-claim-terminate/replay",
        area: "경합: claim/replay↔terminate",
        input:
          "첫 bootstrap-claim이 upstream에서 2xx로 commit된 뒤 응답 유실 → 재시도를 injector가 붙잡음 → terminate 202를 받은 뒤에야 풀어 gateway로 보냄; 3회",
        expected:
          "선행 조건(첫 claim 2xx·재시도 붙잡힘·terminate 202)이 모두 성립하고, terminate가 30초 안에 확인되며, terminate 뒤 도달한 재시도는 모두 4xx 이상이고, 세션에 열린 attempt·완료 turn이 없다",
        actual: results,
        pass: results.every((r) => {
          const x = r as {
            firstClaimUpstream: number | null;
            heldReplayUpstream: number | null;
            replayForwardedAt: string | null;
            terminateAcceptedAt: string | null;
            terminateAccepted: number;
            terminate: { receipt: string | null; effectMs: number | null };
            replays: Array<number | null>;
            turn: Record<string, unknown> | null;
            openAttempts: number;
          };
          return (
            x.firstClaimUpstream !== null &&
            x.firstClaimUpstream < 300 &&
            x.terminateAccepted === 202 &&
            x.terminateAcceptedAt !== null &&
            x.replayForwardedAt !== null &&
            Date.parse(x.replayForwardedAt) >
              Date.parse(x.terminateAcceptedAt) &&
            x.heldReplayUpstream !== null &&
            x.heldReplayUpstream >= 400 &&
            x.terminate.effectMs !== null &&
            x.terminate.effectMs <= 30_000 &&
            x.replays.length > 0 &&
            x.replays.every((status) => status !== null && status >= 400) &&
            x.turn?.status !== "completed" &&
            x.openAttempts === 0
          );
        }),
      }),
    );
    await invariants(ctx, "claim/replay↔terminate 3회 뒤");
  },
};

const heartbeatLease: Campaign = {
  id: "race-heartbeat-lease",
  kind: "race",
  title: "heartbeats fail, then arrive right at lease expiry",
  async run(ctx) {
    const results: Record<string, unknown> = {};
    for (const variant of ["fail", "delay"] as const) {
      const a = await readySession(ctx);
      const slow = await startTurn(ctx, a.sessionId, "interrupt", 120_000);
      const running = await worker(ctx, a.sessionId);
      await ctx.model.reached(slow.specId, 1, 120_000);
      const armedAt = new Date().toISOString();
      const rule = await ctx.chaos.arm(
        variant === "fail"
          ? {
              action: "fail",
              upstream: "gateway",
              method: "POST",
              path: `${GATEWAY}/heartbeat$`,
              bodyContains: a.sessionId,
              times: -1,
            }
          : {
              action: "delay",
              delayMs: HEARTBEAT_TTL_MS + 1000,
              upstream: "gateway",
              method: "POST",
              path: `${GATEWAY}/heartbeat$`,
              bodyContains: a.sessionId,
              times: -1,
            },
      );
      await Bun.sleep(HEARTBEAT_TTL_MS + 15_000);
      await reconcileOnce(ctx);
      await Bun.sleep(10_000);
      await ctx.chaos.disarm(rule);
      const ended = await finish(ctx, slow);
      const events = await ctx.workers.events(running.name);
      const turn = await turnRow(ctx.db, slow.sessionId, slow.turnId);
      const unblocked = await unblock(ctx, a.sessionId, slow.turnId);
      const next = await finish(
        ctx,
        await startTurn(ctx, a.sessionId, "normal"),
      );
      results[variant] = {
        armedAt,
        ended: ended.status,
        turn,
        ownershipLost: events.some((e) => e.event === "worker.ownership.lost"),
        unblocked,
        next: next.status,
      };
    }
    ctx.rows.push(
      criterion({
        id: "race-heartbeat-lease/expiry",
        area: "경합: heartbeat↔lease expiry",
        input:
          "느린 turn 중 (a) heartbeat 실패 45초, (b) heartbeat를 TTL+1초씩 지연; reconciler 1회",
        expected:
          "lease를 잃은 attempt의 turn은 completed가 아니고 worker가 ownership lost로 멈춘다; 새 attempt에서 다음 turn completed; stale write 0(불변식 행)",
        actual: results,
        pass: Object.values(results).every((r) => {
          const x = r as { turn: Record<string, unknown> | null; next: string };
          return x.turn?.status !== "completed" && x.next === "completed";
        }),
      }),
    );
    await invariants(ctx, "heartbeat↔lease 두 변형 뒤");
  },
};

function finalizeRace(op: "pause" | "terminate"): Campaign {
  return {
    id: `race-finalize-${op}`,
    kind: "race",
    title: `${op} lands while the turn's finalize is in flight`,
    async run(ctx) {
      const results: unknown[] = [];
      for (const delayMs of [500, 1500, 3000]) {
        const a = await readySession(ctx);
        const since = await chaosCursor(ctx);
        const rule = await ctx.chaos.arm({
          action: "delay",
          delayMs,
          upstream: "gateway",
          method: "POST",
          path: `${GATEWAY}/finalize$`,
          bodyContains: a.sessionId,
          times: 1,
        });
        const started = await startTurn(ctx, a.sessionId, "normal");
        const finalize = await waitChaos(
          ctx,
          (entry) => entry.index >= since && entry.rule === rule,
          180_000,
        );
        const control =
          op === "pause"
            ? await admissionProbe(ctx.api, {
                budgetMs: 120_000,
                op: "pause",
                pollMs: 250,
                sessionId: a.sessionId,
              })
            : await terminateProbe(ctx.api, ctx.model, {
                budgetMs: 120_000,
                installation: ctx.env.installation,
                pollMs: 250,
                sessionId: a.sessionId,
                specId: null,
                turnId: started.turnId,
              });
        await ctx.chaos.disarm(rule);
        const ended = await finish(ctx, started, 120_000);
        const turn = await turnRow(ctx.db, a.sessionId, started.turnId);
        const session = await sessionRow(ctx.db, a.sessionId);
        const workersLeft =
          (await runningWorkers(ctx.env.installation)).get(a.sessionId)
            ?.length ?? 0;
        results.push({
          delayMs,
          finalizeSeen: finalize !== null,
          finalizeUpstream: finalize?.upstreamStatus ?? null,
          control: {
            receipt: control.receiptStatus,
            acceptStatus: control.acceptStatus,
            effectMs: control.effectMs,
          },
          ended: ended.status,
          turn,
          session,
          workersLeft,
        });
      }
      note(ctx, { step: "rounds", results });
      ctx.rows.push(
        criterion({
          id: `race-finalize-${op}/outcome`,
          area: `경합: finalize↔${op}`,
          input: `finalize 요청을 500/1500/3000ms 붙잡은 채 ${op}`,
          expected:
            op === "pause"
              ? "pause receipt가 정산되고(succeeded면 admission paused + worker 없음), turn은 completed 또는 미확인 표시; completed이면서 unknown인 turn 0"
              : "terminate가 확인(succeeded|unknown)되고 worker 없음; turn은 completed 또는 outcome_unknown, 둘이 겹치지 않음",
          actual: results,
          pass: results.every((r) => {
            const x = r as {
              control: { receipt: string | null };
              turn: Record<string, unknown> | null;
              session: Record<string, unknown> | null;
              workersLeft: number;
            };
            const settled = x.control.receipt !== null;
            const consistent = !(
              x.turn?.status === "completed" && x.turn?.outcome_unknown === true
            );
            if (op === "pause") {
              return (
                settled &&
                consistent &&
                (x.control.receipt !== "succeeded" ||
                  (x.session?.admission_state === "paused" &&
                    x.workersLeft === 0))
              );
            }
            return (
              (x.control.receipt === "succeeded" ||
                x.control.receipt === "unknown") &&
              x.workersLeft === 0 &&
              consistent
            );
          }),
        }),
      );
      await invariants(ctx, `finalize↔${op} 3회 뒤`);
    },
  };
}

const replacementLateClaim: Campaign = {
  id: "race-replacement-late-claim",
  kind: "race",
  title: "a dead worker's delayed claim arrives after its replacement",
  async run(ctx) {
    const since = await chaosCursor(ctx);
    // The injector forwards a held request after its delay whether or not
    // the sender is still alive, so the dead worker's claim does arrive —
    // late, after the replacement's own claim if the delay is long enough.
    const delayMs = 90_000;
    const held = await ctx.chaos.arm({
      action: "delay",
      delayMs,
      upstream: "gateway",
      method: "POST",
      path: `${GATEWAY}/bootstrap-claim$`,
      times: 1,
    });
    const started = await startTurn(ctx, null, "normal");
    const late = await waitChaos(
      ctx,
      (entry) => entry.index >= since && entry.rule === held,
      180_000,
    );
    const first = late ? (await ctx.workers.of(started.sessionId))[0] : null;
    const killed = first
      ? (await docker(["kill", "-s", "KILL", first.name])).code === 0
      : false;
    const replacement = late
      ? await waitChaos(
          ctx,
          (entry) =>
            entry.index > late.index &&
            entry.path.endsWith("/bootstrap-claim") &&
            entry.upstreamStatus !== null &&
            entry.upstreamStatus < 300,
          delayMs - 5000,
        )
      : null;
    const ended = await finish(ctx, started);
    const lateAnswered = late
      ? await waitChaos(
          ctx,
          (entry) =>
            entry.index === late.index && entry.upstreamStatus !== null,
          delayMs + 30_000,
        )
      : null;
    const claims = (await ctx.chaos.log()).filter(
      (entry) =>
        entry.index >= since && entry.path.endsWith("/bootstrap-claim"),
    );
    const generations = (await ctx.workers.of(started.sessionId)).map(
      (c) => c.generation,
    );
    const turn = await turnRow(ctx.db, started.sessionId, started.turnId);
    const replacedFirst =
      replacement !== null &&
      late !== null &&
      Date.parse(replacement.at) < Date.parse(late.at) + delayMs;
    ctx.rows.push(
      criterion({
        id: "race-replacement-late-claim/fence",
        area: "경합: replacement↔late claim",
        input: `첫 worker의 bootstrap-claim을 ${delayMs / 1000}초 붙잡고 그 worker를 SIGKILL; 교체 worker의 claim이 2xx로 끝난 뒤 늦은 claim이 gateway에 도달`,
        expected:
          "선행 조건(규칙 적용·첫 worker kill·교체 claim 2xx가 늦은 claim보다 먼저)이 모두 성립하고, turn은 교체 worker에서 completed, 늦은 claim은 4xx 이상(중복 실행 0은 불변식 행)",
        actual: {
          killed: killed ? (first?.name ?? null) : null,
          replacementClaimAt: replacement?.at ?? null,
          replacedFirst,
          ended: ended.status,
          turn,
          lateClaimUpstream: lateAnswered?.upstreamStatus ?? null,
          claims: claims.map((entry) => ({
            at: entry.at,
            upstream: entry.upstreamStatus,
            status: entry.status,
          })),
          generations,
        },
        pass:
          late !== null &&
          killed &&
          replacedFirst &&
          ended.status === "completed" &&
          lateAnswered?.upstreamStatus != null &&
          lateAnswered.upstreamStatus >= 400,
      }),
    );
    await ctx.chaos.disarm(held);
    await invariants(ctx, "replacement↔late claim 뒤");
  },
};

const resumeClose: Campaign = {
  id: "race-resume-close",
  kind: "race",
  title: "resume and terminate race on a paused session",
  async run(ctx) {
    const results: unknown[] = [];
    for (let round = 0; round < 3; round++) {
      const a = await readySession(ctx);
      const paused = await admissionProbe(ctx.api, {
        budgetMs: 180_000,
        op: "pause",
        pollMs: 250,
        sessionId: a.sessionId,
      });
      const revision = Number(
        (await ctx.api.session(a.sessionId))?.revision ?? 0,
      );
      const [resumed, terminated] = await Promise.all([
        ctx.api.call("POST", `/v1/sessions/${a.sessionId}/resume`, {
          expected_revision: revision,
        }),
        ctx.api.call("POST", `/v1/sessions/${a.sessionId}/terminate`, {
          expected_revision: revision,
          reason: "94S-135 race",
        }),
      ]);
      const receiptOf = (posted: { body: unknown }) =>
        ((posted.body ?? {}) as { receipt_id?: string }).receipt_id ?? null;
      const settleOf = async (id: string | null) =>
        id
          ? String(
              (
                await settleReceipt(ctx.api, id, {
                  pollMs: 250,
                  timeoutMs: 120_000,
                })
              )?.receipt.status ?? "timeout",
            )
          : null;
      const resumeReceipt = await settleOf(receiptOf(resumed));
      const terminateReceipt = await settleOf(receiptOf(terminated));
      await Bun.sleep(15_000);
      const session = await sessionRow(ctx.db, a.sessionId);
      const workersLeft =
        (await runningWorkers(ctx.env.installation)).get(a.sessionId)?.length ??
        0;
      const slots = await ctx.db.query(
        "SELECT count(*)::int AS n FROM worker_launches WHERE session_id = $1 AND slot_released_at IS NULL",
        [a.sessionId],
      );
      results.push({
        round,
        pause: paused.receiptStatus,
        resume: { status: resumed.status, receipt: resumeReceipt },
        terminate: { status: terminated.status, receipt: terminateReceipt },
        session,
        workersLeft,
        openSlots: (slots.rows[0] as { n: number }).n,
      });
    }
    note(ctx, { step: "rounds", results });
    ctx.rows.push(
      criterion({
        id: "race-resume-close/outcome",
        area: "경합: resume↔close",
        input:
          "pause된 세션에 같은 revision으로 resume과 terminate를 동시에; 3회",
        expected:
          "terminate가 이기면 세션 stopped·worker 없음·slot 반납; resume이 이기면 terminate는 거절(409)되거나 뒤이어 적용되어 역시 stopped. 어느 쪽도 정산 안 된 receipt 없음",
        actual: results,
        pass: results.every((r) => {
          const x = r as {
            terminate: { status: number; receipt: string | null };
            resume: { status: number; receipt: string | null };
            session: Record<string, unknown> | null;
            workersLeft: number;
            openSlots: number;
          };
          const terminatedWon =
            x.terminate.receipt === "succeeded" ||
            x.terminate.receipt === "unknown";
          const noHang =
            x.terminate.receipt !== "timeout" && x.resume.receipt !== "timeout";
          return (
            noHang &&
            (!terminatedWon ||
              (["stopped", "closed"].includes(
                String(x.session?.admission_state),
              ) &&
                x.workersLeft === 0 &&
                x.openSlots === 0))
          );
        }),
      }),
    );
    await invariants(ctx, "resume↔close 3회 뒤");
  },
};

/**
 * the object store the stack runs (the compose-pinned LocalStack)
 * must let exactly one of many concurrent create-only PUTs to one key win
 * and keep the winner's bytes; putImmutable must then answer duplicate for
 * the same bytes and conflict for others, without changing what is stored.
 */
const concurrentPut: Campaign = {
  id: "race-s3-concurrent-put",
  kind: "race",
  title: "concurrent create-only PUTs to one key (94S-336)",
  async run(ctx) {
    const client = new S3Client({
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      endpoint: ctx.env.s3Url,
      forcePathStyle: true,
      region: "ap-northeast-1",
    });
    const rounds: unknown[] = [];
    let allPass = true;
    for (let round = 0; round < 5; round++) {
      const key = `soak135-conformance/${crypto.randomUUID()}/manifest.json`;
      const bodies = Array.from({ length: 16 }, (_, i) =>
        new TextEncoder().encode(`writer ${i} ${crypto.randomUUID()}`),
      );
      const outcomes = await Promise.all(
        bodies.map(async (body, writer) => {
          try {
            await client.send(
              new PutObjectCommand({
                Bucket: BUCKET,
                Key: key,
                Body: body,
                IfNoneMatch: "*",
              }),
            );
            return { writer, status: 200 };
          } catch (error) {
            const status =
              (error as { $metadata?: { httpStatusCode?: number } }).$metadata
                ?.httpStatusCode ?? 0;
            return { writer, status, code: (error as { name?: string }).name };
          }
        }),
      );
      const winners = outcomes.filter((o) => o.status >= 200 && o.status < 300);
      const losersOk = outcomes
        .filter((o) => !(o.status >= 200 && o.status < 300))
        .every((o) => o.status === 412 || o.status === 409);
      const stored = await client.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: key }),
      );
      const storedBytes = await (
        stored.Body as { transformToByteArray(): Promise<Uint8Array> }
      ).transformToByteArray();
      const winner = winners[0];
      const keptWinner =
        winner !== undefined &&
        Buffer.from(storedBytes).equals(
          Buffer.from(bodies[winner.writer] ?? new Uint8Array()),
        );
      const store = createCheckpointObjectStore({ bucket: BUCKET, client });
      const same = await store.putImmutable(key, storedBytes);
      const other = await store.putImmutable(
        key,
        new TextEncoder().encode("different"),
      );
      const after = await client.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: key }),
      );
      const afterBytes = await (
        after.Body as { transformToByteArray(): Promise<Uint8Array> }
      ).transformToByteArray();
      const unchanged = Buffer.from(afterBytes).equals(
        Buffer.from(storedBytes),
      );
      const pass =
        winners.length === 1 &&
        losersOk &&
        keptWinner &&
        same.outcome === "duplicate" &&
        other.outcome === "conflict" &&
        unchanged;
      allPass &&= pass;
      rounds.push({
        round,
        winners: winners.length,
        statuses: outcomes.map((o) => o.status),
        keptWinner,
        retrySame: same.outcome,
        retryOther: other.outcome,
        unchanged,
        pass,
      });
    }
    const localstack = (
      await docker([
        "inspect",
        "--format",
        "{{.Config.Image}} {{.Image}}",
        container(ctx.env, "localstack"),
      ])
    ).stdout.trim();
    ctx.rows.push(
      criterion({
        id: "race-s3-concurrent-put/one-winner",
        area: "경합: 같은 key 동시 PUT (94S-336)",
        input: `스택의 LocalStack(${localstack})에 같은 key로 서로 다른 bytes의 IfNoneMatch:"*" PUT 16개 동시; 5회. 이어서 putImmutable 같은/다른 bytes`,
        expected:
          "정확히 하나만 2xx, 나머지 412(또는 409); 저장 bytes = 이긴 요청; putImmutable은 같은 bytes duplicate·다른 bytes conflict, 저장 bytes 불변",
        actual: rounds,
        pass: allPass,
      }),
    );
  },
};

/** The operator's Grant command, run where keys.ts runs. */
async function grants(
  ctx: Ctx,
  command: "revoke" | "restore",
  sessionId: string,
): Promise<{ code: number; line: string }> {
  const result = await run(
    [
      "docker",
      "exec",
      container(ctx.env, "api"),
      "bun",
      "run",
      "apps/control-host/src/api/grants.ts",
      command,
      sessionId,
      "--reason",
      `94S-135 campaign ${ctx.id}`,
    ],
    { allowFail: true },
  );
  const line =
    `${result.stdout}${result.stderr}`.trim().split("\n").at(-1) ?? "";
  note(ctx, { step: `grants ${command}`, code: result.code, line });
  return { code: result.code, line };
}

// Gateway paths a worker writes through; a 2xx on any of them after the
// revocation committed is a write the revoked binding still got in.
const WRITE_PATHS =
  /\/internal\/worker\/(append-events|finalize|heartbeat|checkpoint-request|register-pending|ready|bootstrap-claim|next-input)$/;

const grantRevoke: Campaign = {
  id: "race-grant-revoke",
  kind: "race",
  title: "Grant revoked while a turn is in flight (94S-321)",
  async run(ctx) {
    const a = await readySession(ctx);
    const slow = await startTurn(ctx, a.sessionId, "interrupt", 60_000);
    const reached = await ctx.model.reached(slow.specId, 1, 120_000);
    const since = await chaosCursor(ctx);
    const sent = Date.now();
    const revoked = await grants(ctx, "revoke", a.sessionId);
    // The commit point on the database's clock, which the injector and the
    // scripted model share (one kernel): writes and model calls are compared
    // with it directly, not with when the command returned on the host.
    const { rows: revokedRows } = await ctx.db.query(
      "SELECT execution_revoked_at FROM sessions WHERE id = $1",
      [a.sessionId],
    );
    const revokedAt = (
      revokedRows[0] as { execution_revoked_at: Date | null } | undefined
    )?.execution_revoked_at;
    const committed = revokedAt ? revokedAt.getTime() : Number.NaN;
    const receiptId = /receipt=([0-9a-f-]{36})/.exec(revoked.line)?.[1] ?? null;

    // Worker gone and receipt settled, each timed from the command.
    let goneMs: number | null = null;
    let receiptMs: number | null = null;
    let receiptStatus: string | null = null;
    while (
      Date.now() - sent < 60_000 &&
      (goneMs === null || receiptMs === null)
    ) {
      const running = (await runningWorkers(ctx.env.installation)).get(
        a.sessionId,
      );
      if (goneMs === null && !running?.length) goneMs = Date.now() - sent;
      if (receiptMs === null && receiptId) {
        const receipt = await ctx.api.receipt(receiptId);
        if (receipt && receipt.status !== "accepted") {
          receiptMs = Date.now() - sent;
          receiptStatus = String(receipt.status);
        }
      }
      await Bun.sleep(250);
    }
    const refusedInput = await ctx.api.postMessage(
      a.sessionId,
      "94S-135: input after the Grant was revoked",
    );
    // Long enough for several scheduling passes: a revoked session must not
    // be given a new worker.
    await Bun.sleep(20_000);
    // The revoked worker was already seen gone, so any running one is new.
    const relaunched =
      (await runningWorkers(ctx.env.installation)).get(a.sessionId) ?? [];
    const lateWrites = (await ctx.chaos.log()).filter(
      (entry) =>
        entry.index >= since &&
        (entry.sessionId === a.sessionId ||
          (entry.sessionId === null &&
            entry.path.endsWith("/bootstrap-claim"))) &&
        WRITE_PATHS.test(entry.path) &&
        entry.upstreamStatus !== null &&
        entry.upstreamStatus < 300 &&
        Date.parse(entry.at) > committed,
    );
    const turn = await turnRow(ctx.db, a.sessionId, slow.turnId);
    const models = await ctx.model.requests({ spec: slow.specId });
    const afterRevoke = models.filter(
      (entry) => Date.parse(entry.at) > committed,
    );

    // Restore is refused until the scheduler has confirmed the revoked
    // execution gone, which can trail the container's disappearance.
    let restored = await grants(ctx, "restore", a.sessionId);
    for (
      let tries = 0;
      tries < 30 && restored.line.includes("not been observed gone");
      tries++
    ) {
      await Bun.sleep(2000);
      restored = await grants(ctx, "restore", a.sessionId);
    }
    // Restore lifts the revocation only; the killed turn is still unknown
    // (recovery_required) or the session is stopped, as after a terminate.
    const afterRestore = await sessionRow(ctx.db, a.sessionId);
    const recovered =
      afterRestore?.admission_state === "recovery_required"
        ? await unblock(ctx, a.sessionId, slow.turnId)
        : `resume → ${(await ctx.api.control(a.sessionId, "resume")).status}`;
    const next = /resume → 202/.test(recovered)
      ? await finish(ctx, await startTurn(ctx, a.sessionId, "normal"))
      : null;

    ctx.rows.push(
      criterion({
        id: "race-grant-revoke/in-flight",
        area: "경합: Grant 회수↔in-flight turn",
        input:
          "느린 모델 호출 중인 turn이 있는 세션에 grants.ts revoke → 20초 관찰 → restore → (recovery_required면 abandon) → resume → 새 turn",
        expected:
          "revoke 성공, worker가 30초 안에 사라지고 receipt가 succeeded|unknown으로 정산, 회수 뒤 입력은 202가 아니고, 회수 커밋 뒤 도착한 worker 쓰기 2xx 0건, restore 전 재기동 0, 회수된 turn은 completed가 아니며, restore·resume 뒤 새 turn은 completed",
        actual: {
          reachedSlowStep: reached !== null,
          revoke: revoked.line,
          goneMs,
          receipt: { status: receiptStatus, ms: receiptMs },
          inputAfterRevoke: refusedInput.status,
          relaunched,
          lateWrites: lateWrites.map((entry) => ({
            at: entry.at,
            path: entry.path,
            upstream: entry.upstreamStatus,
          })),
          modelRequestsAfterRevoke: afterRevoke.length,
          turn,
          revokedAt: revokedAt?.toISOString() ?? null,
          restore: restored.line,
          afterRestore: afterRestore?.admission_state ?? null,
          recovered,
          next: next?.status ?? null,
        },
        pass:
          reached !== null &&
          revoked.code === 0 &&
          Number.isFinite(committed) &&
          revoked.line.startsWith("revoked ") &&
          goneMs !== null &&
          goneMs <= 30_000 &&
          (receiptStatus === "succeeded" || receiptStatus === "unknown") &&
          refusedInput.status !== 202 &&
          relaunched.length === 0 &&
          lateWrites.length === 0 &&
          afterRevoke.length === 0 &&
          turn?.status !== "completed" &&
          restored.line.startsWith("restored ") &&
          next?.status === "completed",
      }),
    );
    await invariants(ctx, "Grant 회수·복구 뒤");
  },
};

// ------------------------------------------------- existing checks, run whole

/** Runs `command` with its stdout and stderr in `log`; resolves to its exit code. */
async function logged(
  command: string[],
  log: string,
  vars: Record<string, string>,
): Promise<number> {
  const child = Bun.spawn(["sh", "-c", '"$@" >"$0" 2>&1', log, ...command], {
    env: { ...process.env, ...vars },
  });
  return await child.exited;
}

/**
 * One row per test case of a bun test JUnit report (a non-TTY bun test
 * prints no line for a passing test). A skip, or a case that asserted
 * nothing (the gate tests return early without their env), did not run.
 */
export function bunTestRows(
  id: string,
  input: string,
  junit: string,
  code: number,
  minimum: number,
): Criterion[] {
  const xml = existsSync(junit) ? readFileSync(junit, "utf8") : "";
  const rows = [
    ...xml.matchAll(
      /<testcase name="([^"]*)"[^>]*? assertions="(\d+)"\s*(?:\/>|>([\s\S]*?)<\/testcase>)/g,
    ),
  ].map(([, name = "", assertions = "0", body = ""]) => {
    const status = body.includes("<failure")
      ? "fail"
      : body.includes("<skipped")
        ? "skip"
        : assertions === "0"
          ? "검증 없이 끝남"
          : "pass";
    return criterion({
      id: `${id}/${name.match(/\bH\d+\b/)?.[0] ?? name.slice(0, 40)}`,
      area: "장애",
      input: name.replaceAll("&quot;", '"').replaceAll("&amp;", "&"),
      expected: "테스트 통과",
      actual: `${status} (assertions ${assertions})`,
      pass: status === "pass",
    });
  });
  if (
    rows.length < minimum ||
    (code !== 0 && rows.every((row) => row.status === "pass"))
  ) {
    rows.push(
      criterion({
        id: `${id}/exit`,
        area: "장애",
        input,
        expected: `bun test가 테스트 ${minimum}개 이상을 돌리고 0으로 끝난다`,
        actual: `exit ${code}, 테스트 ${rows.length}개; ${junit}`,
        pass: false,
      }),
    );
  }
  return rows;
}

/**
 * The role checks (tests/d2-gate/control-host-roles.e2e.test.ts,
 * H1–H5) on the soak stack instead of the gate's: its overlay only swaps
 * the Messages API for one that answers the same `/requests`.
 */
const controlHostRoles: Campaign = {
  id: "fault-control-host-role",
  kind: "fault",
  title:
    "control-host roles (api/scheduler/reconciler, one image): restart, PostgreSQL stop, scheduler without Docker",
  async run(ctx) {
    const log = join(ctx.out.dir, "control-host-roles.log");
    const junit = join(ctx.out.dir, "control-host-roles.junit.xml");
    const code = await logged(
      [
        "bun",
        "test",
        "tests/d2-gate/control-host-roles.e2e.test.ts",
        "--timeout",
        "1800000",
        "--reporter=junit",
        `--reporter-outfile=${junit}`,
      ],
      log,
      {
        D2_GATE: "1",
        D2_GATE_OUT: ctx.out.dir,
        D2_GATE_PROJECT: ctx.env.project,
        D2_GATE_COMMAND: `scripts/soak/campaign.sh ${ctx.id}`,
        D2_GATE_API_URL: ctx.env.apiUrl,
        D2_GATE_API_KEY: ctx.env.apiKey,
        D2_GATE_APPROVE_KEY: ctx.env.approveKey,
        D2_GATE_RELEASE_ID: process.env.D2_GATE_RELEASE_ID ?? "",
        D2_GATE_DATABASE_URL: ctx.env.databaseUrl,
        D2_GATE_S3_URL: ctx.env.s3Url,
        D2_GATE_CHAOS_URL: ctx.env.chaosUrl,
        D2_GATE_MESSAGES_URL: ctx.env.messagesUrl,
        D2_GATE_NETWORK: ctx.env.network,
      },
    );
    ctx.rows.push(...bunTestRows(ctx.id, this.title, junit, code, 5));
    // The test restarted both, and Docker gave them new host ports.
    await follow(ctx, "api");
    await follow(ctx, "postgres");
    await invariants(ctx, "control-host role 검사 뒤");
  },
};

/**
 * tests/e2e/restore-resume.sh: backup, restore into a new
 * project, and a new worker resuming the same native session. It builds
 * and removes projects of its own, named after soak135.
 */
const backupRestoreResume: Campaign = {
  id: "fault-backup-restore-resume",
  kind: "fault",
  title: "backup restored into a new project, resumed by a new process",
  async standalone(out) {
    const rr = join(out.dir, "rr");
    const log = join(out.dir, "restore-resume.log");
    const code = await logged(["tests/e2e/restore-resume.sh"], log, {
      RR_OUT: rr,
      RR_PROJECT: "soak135rr",
      // The stack's images, built from the RC, not from this tools checkout.
      RR_IMAGES_FROM: "soak135",
      // Homebrew's bash 5.3 hangs on the backup's heredoc (docs/operator/backup-restore.md).
      PATH: `/bin:${process.env.PATH}`,
    });
    const record = join(rr, "record.txt");
    const lines = existsSync(record) ? readFileSync(record, "utf8") : "";
    const rows = [...lines.matchAll(/^(PASS|FAIL) (.+)$/gm)].map(
      ([, status = "", name = ""], index) =>
        criterion({
          id: `${this.id}/${index + 1}`,
          area: "장애",
          input: name,
          expected: "PASS",
          actual: status,
          pass: status === "PASS",
        }),
    );
    rows.push(
      criterion({
        id: `${this.id}/exit`,
        area: "장애",
        input: "tests/e2e/restore-resume.sh",
        expected: "0으로 끝나고 record.txt에 FAIL이 없다",
        actual: `exit ${code}, PASS ${rows.filter((row) => row.status === "pass").length}건; ${record}`,
        pass:
          code === 0 &&
          rows.length > 0 &&
          rows.every((row) => row.status === "pass"),
      }),
    );
    return rows;
  },
};

export const CAMPAIGNS: Campaign[] = [
  dbOutage,
  s3Outage,
  publishFailure,
  workerKill,
  controlKill,
  corruptFallback,
  clockSkew,
  claimTerminate,
  heartbeatLease,
  finalizeRace("pause"),
  finalizeRace("terminate"),
  replacementLateClaim,
  resumeClose,
  concurrentPut,
  grantRevoke,
  controlHostRoles,
  backupRestoreResume,
];

// ---------------------------------------------------------------- main

async function main(): Promise<number> {
  const [which, outArg] = process.argv.slice(2);
  if (!which || which === "list") {
    for (const campaign of CAMPAIGNS) {
      console.log(
        `${campaign.id}\t${campaign.kind}\t${campaign.standalone ? "own-stack" : "runs"}\t${campaign.title}`,
      );
    }
    return which ? 0 : 2;
  }
  const campaign = CAMPAIGNS.find((candidate) => candidate.id === which);
  if (!campaign) {
    console.error(
      `no campaign ${which}; see: bun scripts/soak/campaigns.ts list`,
    );
    return 2;
  }
  const stamp = new Date().toISOString().replaceAll(":", "").slice(0, 15);
  const dir = resolve(
    outArg ??
      join(process.env.SOAK_STATE ?? ".", `campaign-${campaign.id}-${stamp}`),
  );
  const out = new Output(dir);
  if (campaign.standalone) {
    const meta = {
      campaign: campaign.id,
      run_started_at: new Date().toISOString(),
    };
    const rows = await campaign.standalone(out);
    out.json("meta", meta);
    out.json("criteria", rows);
    out.text(
      "report.md",
      markdownReport(`94S-135 campaign — ${campaign.id}`, meta, rows),
    );
    const failed = rows.filter((row) => row.status === "fail").length;
    console.error(
      `${campaign.id}: ${rows.length - failed}/${rows.length} pass; ${join(dir, "report.md")}`,
    );
    return failed === 0 ? 0 : 1;
  }
  if (!campaign.run) throw new Error(`${campaign.id} has nothing to run`);
  const env = soakEnv();
  const meta = await reproMeta(env, {
    campaign: campaign.id,
    run_started_at: new Date().toISOString(),
  });
  out.json("meta", meta);
  const db = database(env.databaseUrl);
  const workerLogs = join(dir, "workers");
  mkdirSync(workerLogs, { recursive: true });
  const workers = new Workers(env.installation, workerLogs);
  workers.watch();
  const model = new Model(env.messagesUrl);
  await model.setFaults(NO_FAULTS);
  const ctx: Ctx = {
    api: new Api(env.apiUrl, env.apiKey, undefined, env.approveKey),
    chaos: new Chaos(env.chaosUrl),
    counter: 0,
    db,
    env,
    id: campaign.id,
    model,
    out,
    rows: [],
    workers,
  };
  let crashed: string | null = null;
  try {
    await campaign.run(ctx);
  } catch (error) {
    crashed =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    ctx.rows.push(
      criterion({
        id: `${campaign.id}/run`,
        area: campaign.kind === "race" ? "경합" : "장애",
        input: campaign.title,
        expected: "캠페인이 끝까지 돈다",
        actual: crashed,
        pass: false,
      }),
    );
  }
  workers.stop();
  out.json("criteria", ctx.rows);
  out.text(
    "report.md",
    markdownReport(`94S-135 campaign — ${campaign.id}`, meta, ctx.rows),
  );
  // With the stack's profiles, or the api, scheduler and reconciler logs
  // are left out.
  await composeToFile(
    env,
    ["logs", "--no-color", "--timestamps"],
    join(dir, "compose.log"),
  );
  out.jsonl("worker-traffic").write({ log: await ctx.chaos.log() });
  out.jsonl("model-requests").write({ log: await model.requests() });
  // A campaign that restarted postgres has already swapped (and ended) the
  // pool it started with.
  await ctx.db.end();
  const failed = ctx.rows.filter((row) => row.status === "fail").length;
  console.error(
    `${campaign.id}: ${ctx.rows.length - failed}/${ctx.rows.length} pass; ${join(dir, "report.md")}`,
  );
  return failed === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exit(await main());
}
