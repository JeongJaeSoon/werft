import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { WORKER_EXIT_LEASE_LOST } from "@werft-ai/contracts";
import type { Pool } from "pg";
import { inputUuid } from "../../apps/worker/src/worker-host.ts";
import {
  Bucket,
  Chaos,
  type ChaosEntry,
  type CheckpointRow,
  database,
  GateReport,
  gateEnv,
  Messages,
  PublicApi,
  prompt,
  read,
  run,
  sha256,
  verifyCheckpoint,
  type WorkerContainer,
  type WorkerEvent,
  Workers,
  waitFor,
  write,
} from "./harness.ts";

/**
 * The D2 completion gate: the product stack built from this
 * checkout — public API, scheduler, the worker image with the real Claude
 * Agent SDK — driven only from outside, with a scripted Messages API and a
 * fault injector in the worker's path. scripts/d2-gate/run.sh builds the
 * stack and runs this file; without it (D2_GATE unset) every test skips, so
 * `bun run test` never needs Docker for it.
 *
 * Scenarios run in order on one stack, each on a session of its own:
 * A. two turns on one engine, checkpoint, and a restore onto a clean
 *    workspace volume and HOME, with one append response lost on the way;
 * B. a publish that fails at the manifest, then one that succeeds;
 * C. a transcript mirror that fails;
 * D. a worker that loses its lease while its turn is open;
 * E. interrupts repeated on fresh sessions, as early as the API takes them
 *    and mid-response (D2_GATE_INTERRUPT_REPEAT rounds, 6 by default), and
 *    one that reaches a turn already over.
 */

const env = gateEnv();
const TURN_MS = 300_000;
const report = new GateReport();

let api: PublicApi;
let db: Pool;
let bucket: Bucket;
let chaos: Chaos;
let messages: Messages;
let workers: Workers;

type TurnRow = {
  attempt_id: string | null;
  id: string;
  outcome_unknown: boolean;
  sequence: number;
  status: string;
  terminal_reason: string | null;
};

async function rows<T>(sql: string, params: unknown[]): Promise<T[]> {
  return (await db.query(sql, params)).rows as T[];
}

type SessionRow = {
  admission_state: string;
  checkpoint_pending_attempt_id: string | null;
  checkpoint_pending_reason: string | null;
  checkpoint_revision: number | null;
  execution_generation: number;
  lease_epoch: number;
  status: string;
};

async function sessionRow(sessionId: string): Promise<SessionRow> {
  const [row] = await rows<SessionRow>(
    `SELECT status, admission_state, checkpoint_revision, checkpoint_pending_reason,
            checkpoint_pending_attempt_id, execution_generation, lease_epoch
       FROM sessions WHERE id = $1`,
    [sessionId],
  );
  if (!row) throw new Error(`no session ${sessionId}`);
  return row;
}

function checkpointRows(
  sessionId: string,
): Promise<Array<CheckpointRow & { turn_id: string }>> {
  return rows(
    `SELECT revision, manifest_ref, manifest_sha256, manifest_version, turn_id::text
       FROM checkpoints WHERE session_id = $1 ORDER BY revision`,
    [sessionId],
  );
}

function turnRows(sessionId: string): Promise<TurnRow[]> {
  return rows(
    `SELECT id::text, sequence, status, terminal_reason, outcome_unknown, attempt_id
       FROM turns WHERE session_id = $1 ORDER BY sequence`,
    [sessionId],
  );
}

/** Every attempt's events must be numbered 1, 2, 3… with no gap or repeat. */
async function eventNumbering(sessionId: string): Promise<{
  attempts: Record<string, number>;
  problems: string[];
}> {
  const found = await rows<{ attempt_id: string; source_sequence: number }>(
    `SELECT attempt_id, source_sequence FROM events
      WHERE session_id = $1 AND attempt_id IS NOT NULL
      ORDER BY attempt_id, source_sequence`,
    [sessionId],
  );
  const attempts: Record<string, number> = {};
  const problems: string[] = [];
  let lastAttempt: string | null = null;
  let lastSequence = 0;
  for (const row of found) {
    attempts[row.attempt_id] = (attempts[row.attempt_id] ?? 0) + 1;
    const expected = lastAttempt === row.attempt_id ? lastSequence + 1 : 1;
    if (row.source_sequence !== expected) {
      problems.push(
        `${row.attempt_id}: ${lastSequence} → ${row.source_sequence}`,
      );
    }
    lastAttempt = row.attempt_id;
    lastSequence = row.source_sequence;
  }
  return { attempts, problems };
}

async function queueDepth(sessionId: string): Promise<number> {
  const [row] = await rows<{ n: string }>(
    "SELECT count(*)::text AS n FROM queue_messages WHERE session_id = $1",
    [sessionId],
  );
  return Number(row?.n ?? "0");
}

async function receiptStatuses(sessionId: string): Promise<string[]> {
  return (
    await rows<{ operation: string; status: string }>(
      `SELECT operation, status FROM receipts
        WHERE target_ref->>'session_id' = $1 ORDER BY created_at`,
      [sessionId],
    )
  ).map((row) => `${row.operation}:${row.status}`);
}

/** Waits for the worker's own log to say something, and returns that line. */
function logged(
  container: WorkerContainer,
  event: string,
  match: (line: WorkerEvent) => boolean = () => true,
  timeoutMs = 120_000,
): Promise<WorkerEvent> {
  return waitFor(
    `${event} in ${container.name}`,
    async () =>
      (await workers.events(container.name)).find(
        (line) => line.event === event && match(line),
      ),
    timeoutMs,
    500,
  );
}

/**
 * The worker's exit code, whenever it comes. `docker wait` is attached
 * before anything stops it: the scheduler removes a container once it has
 * seen it exit, and the code would go with it.
 */
function exitOf(container: WorkerContainer): Promise<number> {
  return run(["docker", "wait", container.name], { allowFail: true }).then(
    (waited) => (waited.code === 0 ? Number(waited.stdout.trim()) : -1),
  );
}

/** Stops a worker the way an operator would: SIGTERM, then the drain. */
async function stopWorker(container: WorkerContainer): Promise<number> {
  const waited = exitOf(container);
  await run(["docker", "stop", "-t", "120", container.name], {
    allowFail: true,
  });
  const inspected = await run(
    ["docker", "inspect", "--format", "{{.State.ExitCode}}", container.name],
    { allowFail: true },
  );
  return inspected.code === 0 ? Number(inspected.stdout.trim()) : waited;
}

/** `docker ps` names the image by tag, or by short id once the tag moved on. */
async function sameImage(listed: string): Promise<boolean> {
  if (listed === env?.workerImage) return true;
  const { stdout } = await run(
    [
      "docker",
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      env?.workerImage ?? "",
    ],
    { allowFail: true },
  );
  return (
    listed.length >= 12 &&
    stdout.trim().replace("sha256:", "").startsWith(listed)
  );
}

async function workspaceVolumes(sessionId: string): Promise<string[]> {
  const volumeLabelNamespace =
    process.env.EXECUTION_VOLUME_LABEL_NAMESPACE || "werft";
  const { stdout } = await run([
    "docker",
    "volume",
    "ls",
    "-q",
    "--filter",
    `label=${volumeLabelNamespace}.installation=${env?.installation}`,
    "--filter",
    `label=${volumeLabelNamespace}.session-id=${sessionId}`,
  ]);
  return stdout.split("\n").filter(Boolean);
}

async function scheduler(action: "start" | "stop"): Promise<void> {
  await run(["docker", action, `${env?.project}-scheduler-1`]);
}

/** One pass of the lease reconciler, from the API image as the product runs it. */
async function reconcileOnce(): Promise<string> {
  const { stdout, stderr } = await run([
    "docker",
    "run",
    "--rm",
    "--network",
    env?.network ?? "",
    "-e",
    "DATABASE_URL=postgres://postgres:dev@postgres:5432/sessions",
    "-e",
    "LOG_LEVEL=info",
    env?.apiImage ?? "",
    "bun",
    "run",
    "apps/control-host/src/main.ts",
    "reconciler",
    "--once",
  ]);
  return `${stdout}${stderr}`;
}

async function collectMeta(): Promise<void> {
  if (!env) return;
  const text = async (command: string[]) =>
    (await run(command, { allowFail: true })).stdout.trim();
  const imageId = (image: string) =>
    text(["docker", "image", "inspect", "--format", "{{.Id}}", image]);
  const inWorker = (script: string) =>
    text([
      "docker",
      "run",
      "--rm",
      "--entrypoint",
      "sh",
      env.workerImage,
      "-c",
      script,
    ]);
  const containerImage = (service: string) =>
    text([
      "docker",
      "inspect",
      "--format",
      "{{.Config.Image}} {{.Image}}",
      `${env.project}-${service}-1`,
    ]);
  Object.assign(report.meta, {
    command: env.command,
    tested_sha: await text(["git", "rev-parse", "HEAD"]),
    worktree_dirty: (await text(["git", "status", "--porcelain"])) !== "",
    api_image: `${env.apiImage} ${await imageId(env.apiImage)}`,
    worker_image: `${env.workerImage} ${await imageId(env.workerImage)}`,
    postgres_image: await containerImage("postgres"),
    localstack_image: await containerImage("localstack"),
    git_host_image: await containerImage("fake-git"),
    // Built by run.sh from this checkout, like the three app images.
    egress_proxy_image: await containerImage("egress-proxy"),
    reconciler_image: await containerImage("reconciler"),
    claude_agent_sdk: await inWorker(
      'sed -n \'s/^  "version": "\\(.*\\)",$/\\1/p\' /app/node_modules/@anthropic-ai/claude-agent-sdk/package.json',
    ),
    claude_code: await inWorker(
      "$(find /app/node_modules/@anthropic-ai -path '*claude-agent-sdk-linux-*/claude' -type f | head -n 1) --version",
    ),
    worker_bun: await inWorker("bun --version"),
    host_bun: Bun.version,
    docker: await text([
      "docker",
      "version",
      "--format",
      "{{.Server.Version}} (API {{.Server.APIVersion}})",
    ]),
    object_store:
      "LocalStack S3, versioned bucket with Object Lock (CHECKPOINT_OBJECT_PROTECTION=locked)",
    model_api: "scripts/d2-gate/fake-messages.ts (scripted Messages API)",
  });
}

describe.skipIf(env === null)("D2 gate", () => {
  beforeAll(async () => {
    if (!env) return;
    api = new PublicApi(env.apiUrl, env.apiKey, env.releaseId);
    db = database(env.databaseUrl);
    bucket = new Bucket(env.s3Url);
    chaos = new Chaos(env.chaosUrl);
    messages = new Messages(env.messagesUrl);
    workers = new Workers(env.installation, env.out);
    workers.watch();
    await collectMeta();
  });

  afterAll(async () => {
    if (!env) return;
    report.skip({
      id: "SKIP-1",
      criterion: "외부 서비스",
      title:
        "real AWS S3 (https, Object Lock) and the paid Anthropic Messages API",
      input: "—",
      expected: "the same flow against real endpoints",
      reason:
        "out of this gate by decision (94S-247 comment, decided with Codex): LocalStack and the scripted Messages API stand in; the real-service smoke is its own ticket before an external release",
    });
    await report.write(env.out);
    workers?.stop();
    await db?.end();
  });

  test("A: two turns on one engine, checkpoint, restore onto a clean worker", async () => {
    const spec1 = {
      id: "A1",
      steps: [
        write("/workspace/gate.txt", "gate turn 1\n"),
        {
          tool: "Agent",
          input: {
            description: "write the subagent file",
            subagent_type: "general-purpose",
            // Foreground: a subagent still running when the turn ends holds
            // the checkpoint back (background_writer), and this turn's
            // checkpoint is what the gate compares.
            run_in_background: false,
            prompt: prompt("Write the file.", {
              id: "A1sub",
              steps: [write("/workspace/sub.txt", "written by the subagent\n")],
              final: "SUB DONE",
            }),
          },
        },
      ],
      final: "A1 DONE",
    };
    const created = await api.createSession(prompt("Turn one.", spec1));
    const sessionId = created.session_id;
    report.meta.session_a = sessionId;
    const first = await workers.running(sessionId);
    const turn1 = await api.settle(sessionId, created.turn_id, TURN_MS);
    const engine1 = await workers.engine(first.name);
    report.check({
      id: "A-01",
      criterion: "HTTP→scheduler→빌드 이미지 worker",
      title:
        "public HTTP creates the session and the scheduler launches this build's worker image",
      input: `POST /v1/sessions release of the gate agent, repository gate-app`,
      expected: `turn 1 completed, worker from ${env?.workerImage}`,
      actual: {
        status: turn1.status,
        terminal_reason: turn1.terminal_reason,
        container: first.name,
        image: first.image,
      },
      pass: turn1.status === "completed" && (await sameImage(first.image)),
    });

    // Turn 2 reads and rewrites the file on the same engine, and loses the
    // response to its first event append on the way back.
    const lost = await chaos.arm({
      action: "lose_response",
      upstream: "gateway",
      method: "POST",
      path: "/internal/worker/append-events$",
      bodyContains: sessionId,
      times: 1,
    });
    const spec2 = {
      id: "A2",
      steps: [
        read("/workspace/gate.txt"),
        write("/workspace/gate.txt", "gate turn 2\n"),
      ],
      final: "A2 DONE",
    };
    const turnId2 = await api.message(sessionId, prompt("Turn two.", spec2));
    const turn2 = await api.settle(sessionId, turnId2, TURN_MS);
    await chaos.disarm(lost);
    const engine2 = await workers.engine(first.name);
    report.check({
      id: "A-02",
      criterion: "SDK tool로 workspace 변경",
      title: "both turns complete through tool calls",
      input:
        "A1: Write gate.txt, Agent→Write sub.txt; A2: Read, Write gate.txt",
      expected: "completed, completed",
      actual: [turn1.status, turn2.status],
      pass: turn1.status === "completed" && turn2.status === "completed",
    });
    report.check({
      id: "A-03",
      criterion: "두 turn이 같은 SDK PID",
      title: "the second turn runs on the engine process of the first",
      input: `/proc of ${first.name} after each turn`,
      expected: "same pid and start time",
      actual: { after_turn1: engine1, after_turn2: engine2 },
      pass:
        engine1 !== null &&
        engine2 !== null &&
        engine1.pid === engine2.pid &&
        engine1.startTicks === engine2.startTicks,
    });

    const appendLog = (await chaos.log(sessionId)).filter((entry) =>
      entry.path.endsWith("/append-events"),
    );
    const lostAt = appendLog.find((entry) => entry.rule === lost);
    const attemptOf = (entry: ChaosEntry | undefined) =>
      entry?.batch?.key.split(":")[0];
    // The attempt's next append after the lost one must resend that batch:
    // every lost sequence, byte for byte, before anything later lands.
    const replay = appendLog.find(
      (entry) =>
        lostAt !== undefined &&
        entry.index > lostAt.index &&
        attemptOf(entry) === attemptOf(lostAt),
    );
    const lostEvents = Object.entries(lostAt?.batch?.events ?? {});
    const replayed =
      replay !== undefined &&
      replay.rule === null &&
      replay.status === 200 &&
      lostEvents.length > 0 &&
      lostEvents.every(
        ([sequence, digest]) => replay.batch?.events[sequence] === digest,
      );
    const numbering = await eventNumbering(sessionId);
    report.check({
      id: "A-04",
      criterion: "fault: append 응답 유실",
      title:
        "an append whose response was lost is retried into the same events, once",
      input: "lose_response on the first append-events of turn 2",
      expected:
        "the rule fired after the upstream committed; the attempt's next append resent every lost event unchanged and succeeded; events numbered without gap or repeat",
      actual: {
        fired: appendLog.filter((entry) => entry.rule === lost).length,
        committed_upstream: lostAt?.upstreamStatus ?? null,
        lost_batch: lostAt?.batch ?? null,
        replay:
          replay === undefined
            ? null
            : {
                batch: replay.batch,
                index: replay.index,
                rule: replay.rule,
                status: replay.status,
              },
        per_attempt: numbering.attempts,
        problems: numbering.problems,
      },
      pass:
        lostAt?.upstreamStatus === 200 &&
        replayed &&
        numbering.problems.length === 0,
    });

    const session = await sessionRow(sessionId);
    const checkpoints = await checkpointRows(sessionId);
    const turns = await turnRows(sessionId);
    const receipts = await receiptStatuses(sessionId);
    const depth = await queueDepth(sessionId);
    report.check({
      id: "A-05",
      criterion: "events·terminal·receipt·queue·pointer 정합",
      title: "turns, receipts, queue and checkpoint pointer agree",
      input: "DB after turn 2",
      expected:
        "turns completed with revisions 0 and 1, pointer 1, create/mint/append receipts succeeded, queue empty",
      actual: {
        turns: turns.map((t) => `${t.id}:${t.status}:${t.terminal_reason}`),
        api_turn_revisions: [
          turn1.checkpoint_revision,
          turn2.checkpoint_revision,
        ],
        checkpoints: checkpoints.map((c) => `${c.revision}@turn${c.turn_id}`),
        pointer: session.checkpoint_revision,
        pending_reason: session.checkpoint_pending_reason,
        receipts,
        queue: depth,
      },
      pass:
        turns.length === 2 &&
        turns.every((t) => t.status === "completed" && !t.outcome_unknown) &&
        turn1.checkpoint_revision === 0 &&
        turn2.checkpoint_revision === 1 &&
        checkpoints.map((c) => `${c.revision}@${c.turn_id}`).join() ===
          `0@${turns[0]?.id},1@${turns[1]?.id}` &&
        session.checkpoint_revision === 1 &&
        session.checkpoint_pending_reason === null &&
        receipts.length === 3 &&
        ["create_session", "mint_github_token", "append_message"].every(
          (operation) =>
            receipts.filter((receipt) => receipt.startsWith(`${operation}:`))
              .length === 1,
        ) &&
        receipts.every((r) => r.endsWith(":succeeded")) &&
        depth === 0,
    });

    const pointer = checkpoints.find((c) => c.revision === 1);
    if (!pointer) throw new Error("no revision 1 to verify");
    const verified = await verifyCheckpoint(bucket, pointer);
    const untracked = Object.fromEntries(
      verified.manifest.workspace.untracked.map((file) => [
        file.path,
        file.sha256,
      ]),
    );
    report.check({
      id: "A-06",
      criterion: "manifest·bundle·transcript hash 비교",
      title:
        "every object the manifest names reads back by version with the digest it records",
      input: `${pointer.manifest_ref} @ ${pointer.manifest_version}`,
      expected:
        "no mismatch; gate.txt and sub.txt carried with their final contents; subagent transcript present",
      actual: {
        problems: verified.problems,
        git_commit: verified.manifest.workspace.gitCommit,
        bundle_heads: verified.bundleHeads,
        untracked,
        root_parts: verified.manifest.transcripts.root.parts.length,
        subagents: Object.keys(verified.manifest.transcripts.subagents),
      },
      pass:
        verified.problems.length === 0 &&
        untracked["gate.txt"] === sha256("gate turn 2\n") &&
        untracked["sub.txt"] === sha256("written by the subagent\n") &&
        Object.values(verified.subagentEntries).some((entries) =>
          JSON.stringify(entries).includes("/workspace/sub.txt"),
        ),
    });

    const started = (await workers.events(first.name)).filter(
      (line) => line.event === "worker.turn.started",
    );
    const uuids = started.map((line) => ({
      turn_id: String(line.turn_id),
      uuid: inputUuid(sessionId, String(line.turn_id), String(line.input_id)),
    }));
    const occurrences = (
      entries: Array<Record<string, unknown>>,
      uuid: string,
    ) =>
      entries.filter((entry) => entry.type === "user" && entry.uuid === uuid)
        .length;
    report.check({
      id: "A-07",
      criterion: "input UUID 안정 매핑",
      title:
        "each delivered input sits in the root transcript under its derived UUID, once",
      input: "worker.turn.started (turn_id, input_id) → inputUuid()",
      expected: "two inputs, each exactly once",
      actual: uuids.map((u) => ({
        ...u,
        count: occurrences(verified.rootEntries, u.uuid),
      })),
      pass:
        uuids.length === 2 &&
        uuids.every((u) => occurrences(verified.rootEntries, u.uuid) === 1),
    });

    // Restore: the worker drains and releases, its workspace volume goes,
    // and the next message brings up a new generation on a clean volume
    // and a fresh HOME, which must rebuild both from revision 1.
    const tracked = ["gate.txt", "sub.txt", "README.md"];
    const before = await workers.workspace(first.name, tracked);
    const oldVolumes = await workspaceVolumes(sessionId);
    const exitCode = await stopWorker(first);
    const removed = await waitFor(
      "the workspace volume to be removable",
      async () => {
        for (const volume of await workspaceVolumes(sessionId)) {
          const gone = await run(["docker", "volume", "rm", volume], {
            allowFail: true,
          });
          if (gone.code !== 0) return null;
        }
        return true;
      },
      120_000,
      2000,
    );
    const drained = await workers.events(first.name);
    const spec3 = {
      id: "A3",
      steps: [read("/workspace/gate.txt"), read("/workspace/sub.txt")],
      final: "A3 DONE",
    };
    const outage = await chaos.arm({
      action: "fail",
      upstream: "s3",
      path: `sessions/${sessionId}/`,
      times: -1,
    });
    let second!: WorkerContainer;
    let unavailable!: WorkerEvent[];
    let turnId3!: string;
    try {
      turnId3 = await api.message(sessionId, prompt("Turn three.", spec3));
      second = await waitFor(
        "a new generation",
        async () =>
          (await workers.of(sessionId)).find(
            (c) => c.generation > first.generation && c.state === "running",
          ),
        180_000,
        500,
      );
      workers.follow(second.name);
      unavailable = await waitFor(
        "the restoring worker to wait out the object store outage",
        async () => {
          const found = (await workers.events(second.name)).filter(
            (line) => line.event === "worker.checkpoint.restore_unavailable",
          );
          return found.length >= 2 ? found : null;
        },
        120_000,
        250,
      );
    } finally {
      await chaos.disarm(outage);
    }
    const turn3 = await api.settle(sessionId, turnId3, TURN_MS);
    const recovered = await workers.running(sessionId, 10_000);
    const outageRequests = (await chaos.log(sessionId)).filter(
      (entry) => entry.rule === outage,
    );
    const claimed = await logged(second, "worker.claimed");
    const restored = await logged(second, "worker.checkpoint.restored");
    const after = await workers.workspace(second.name, tracked);
    const engine3 = await workers.engine(second.name);
    const inspected = await workers.inspect(second.name);
    const newVolumes = await workspaceVolumes(sessionId);
    report.check({
      id: "A-08",
      criterion: "새 worker·clean HOME/workspace에서 복원",
      title:
        "one new generation waits out a transient object-store outage, then restores revision 1",
      input:
        "docker stop -t 120; docker volume rm; fail worker S3 requests; POST message; restore S3",
      expected:
        "old worker exits 0 after worker.released; one new generation retries with exponential backoff, stays up, then restores revision 1",
      actual: {
        old_exit: exitCode,
        old_released: drained.some((line) => line.event === "worker.released"),
        old_volumes: oldVolumes,
        volume_removed: removed,
        new_volumes: newVolumes,
        new_container: `${second.name} (generation ${second.generation})`,
        restore_revision: claimed.restore_revision,
        restored: {
          revision: restored.revision,
          git_commit: restored.git_commit,
        },
        outage_requests: outageRequests.length,
        retry_in_ms: unavailable.map((line) => line.retry_in_ms),
        recovered_container: recovered.name,
        home_tmpfs: Object.keys(inspected.HostConfig?.Tmpfs ?? {}),
      },
      pass:
        exitCode === 0 &&
        drained.some((line) => line.event === "worker.released") &&
        claimed.restore_revision === 1 &&
        restored.revision === 1 &&
        restored.git_commit === verified.manifest.workspace.gitCommit &&
        outageRequests.length >= 2 &&
        unavailable.length >= 2 &&
        unavailable[0]?.retry_in_ms === 1_000 &&
        unavailable[1]?.retry_in_ms === 2_000 &&
        recovered.id === second.id &&
        oldVolumes.length > 0 &&
        newVolumes.length > 0 &&
        newVolumes.every((v) => !oldVolumes.includes(v)) &&
        "/home/worker" in (inspected.HostConfig?.Tmpfs ?? {}),
    });
    report.check({
      id: "A-09",
      criterion: "정확한 SHA·파일 복원",
      title: "the restored workspace is the checkpointed one, byte for byte",
      input:
        "HEAD, branch, status, sha256 and executable bit of the files, before stop and after restore",
      expected: before,
      actual: after,
      pass:
        before === after &&
        before.includes(verified.manifest.workspace.gitCommit),
    });

    const turn3Requests = await messages.requests("A3");
    const firstAsk = JSON.stringify(turn3Requests[0]?.messages ?? []);
    const lastAsk = JSON.stringify(turn3Requests.at(-1)?.messages ?? []);
    report.check({
      id: "A-10",
      criterion: "transcript 복원 후 이어서 진행·새 PID",
      title:
        "turn 3 continues the restored conversation on a new engine process",
      input: "Messages API requests of turn 3",
      expected:
        "turn 3 completed; its first request carries turns 1 and 2; the reads return the restored contents; a different container runs the engine",
      actual: {
        status: turn3.status,
        carries_turn1: firstAsk.includes('\\"id\\":\\"A1\\"'),
        carries_turn2: firstAsk.includes('\\"id\\":\\"A2\\"'),
        reads_gate: lastAsk.includes("gate turn 2"),
        reads_sub: lastAsk.includes("written by the subagent"),
        engine_before: `${first.name} pid ${engine2?.pid}`,
        engine_after: `${second.name} pid ${engine3?.pid}`,
      },
      pass:
        turn3.status === "completed" &&
        firstAsk.includes('\\"id\\":\\"A1\\"') &&
        firstAsk.includes('\\"id\\":\\"A2\\"') &&
        lastAsk.includes("gate turn 2") &&
        lastAsk.includes("written by the subagent") &&
        engine3 !== null &&
        second.id !== first.id,
    });

    const final = (await checkpointRows(sessionId)).find(
      (c) => c.revision === 2,
    );
    const finalVerified = final ? await verifyCheckpoint(bucket, final) : null;
    const allUuids = [
      ...uuids,
      ...(await workers.events(second.name))
        .filter((line) => line.event === "worker.turn.started")
        .map((line) => ({
          turn_id: String(line.turn_id),
          uuid: inputUuid(
            sessionId,
            String(line.turn_id),
            String(line.input_id),
          ),
        })),
    ];
    report.check({
      id: "A-11",
      criterion: "input UUID 안정 매핑(복원 후)",
      title:
        "after the restore every input is still in the transcript exactly once",
      input: "revision 2 root transcript",
      expected: "three inputs, each exactly once; no digest mismatch",
      actual: {
        revision: final?.revision ?? null,
        problems: finalVerified?.problems ?? ["no revision 2"],
        counts: allUuids.map((u) => ({
          ...u,
          count: finalVerified
            ? occurrences(finalVerified.rootEntries, u.uuid)
            : 0,
        })),
      },
      pass:
        finalVerified !== null &&
        finalVerified.problems.length === 0 &&
        allUuids.length === 3 &&
        allUuids.every(
          (u) => occurrences(finalVerified.rootEntries, u.uuid) === 1,
        ),
    });

    await stopWorker(second);
    expect(report.failed().filter((c) => c.id.startsWith("A-"))).toEqual([]);
  }, 1_200_000);

  test("B: a publish that fails at the manifest is never promoted", async () => {
    const spec1 = {
      id: "B1",
      steps: [write("/workspace/b.txt", "b turn 1\n")],
      final: "B1 DONE",
    };
    const created = await api.createSession(prompt("Turn one.", spec1));
    const sessionId = created.session_id;
    report.meta.session_b = sessionId;
    const failing = await chaos.arm({
      action: "fail",
      upstream: "s3",
      method: "PUT",
      path: `sessions/${sessionId}/checkpoints/.*/manifest\\.json`,
      times: -1,
    });
    const turn1 = await api.settle(sessionId, created.turn_id, TURN_MS);
    await chaos.disarm(failing);
    const worker = await workers.running(sessionId, 10_000);
    const failed = await logged(worker, "worker.checkpoint.failed");
    const orphanDirectory = String(failed.manifest_ref ?? "").replace(
      /manifest\.json$/,
      "",
    );
    const orphans = orphanDirectory
      ? await bucket.versions(orphanDirectory)
      : [];
    const failedRow = await sessionRow(sessionId);
    const afterFailure = {
      pointer: failedRow.checkpoint_revision,
      checkpoints: (await checkpointRows(sessionId)).length,
      // the session shows the turn went without its checkpoint.
      pending_reason: failedRow.checkpoint_pending_reason,
    };
    report.check({
      id: "B-01",
      criterion: "fault: publish 중 실패",
      title:
        "a publish whose manifest PUT fails leaves no checkpoint and no pointer",
      input: "fail every PUT of this session's manifest.json",
      expected:
        "turn completed without a revision; worker.checkpoint.failed; bundle uploaded but no manifest; no checkpoints row; checkpoint_pending_reason publish_failed",
      actual: {
        status: turn1.status,
        turn_revision: turn1.checkpoint_revision,
        failed: {
          stage: failed.stage,
          reason: String(failed.reason).slice(0, 160),
        },
        orphan_objects: orphans.map((o) => o.key.slice(orphanDirectory.length)),
        ...afterFailure,
      },
      pass:
        turn1.status === "completed" &&
        turn1.checkpoint_revision === null &&
        orphans.length > 0 &&
        orphans.every((o) => !o.key.endsWith("manifest.json")) &&
        afterFailure.pointer === null &&
        afterFailure.checkpoints === 0 &&
        afterFailure.pending_reason === "publish_failed",
    });

    const spec2 = {
      id: "B2",
      steps: [write("/workspace/b.txt", "b turn 2\n")],
      final: "B2 DONE",
    };
    const turnId = await api.message(sessionId, prompt("Turn two.", spec2));
    const turn2 = await api.settle(sessionId, turnId, TURN_MS);
    const checkpoints = await checkpointRows(sessionId);
    const committed = checkpoints[0];
    const verified = committed
      ? await verifyCheckpoint(bucket, committed)
      : null;
    report.check({
      id: "B-02",
      criterion: "fault: publish 중 실패",
      title:
        "the next publish commits in a directory of its own, and only it is pointed at",
      input: "fault removed, turn 2",
      expected:
        "one checkpoint (revision 0, turn 2) outside the failed directory; digests match; the publish_failed reason cleared by the commit",
      actual: {
        status: turn2.status,
        checkpoints: checkpoints.map((c) => `${c.revision}:${c.manifest_ref}`),
        failed_directory: orphanDirectory,
        pointer: (await sessionRow(sessionId)).checkpoint_revision,
        pending_reason: (await sessionRow(sessionId)).checkpoint_pending_reason,
        problems: verified?.problems ?? ["none committed"],
      },
      pass:
        turn2.status === "completed" &&
        (await sessionRow(sessionId)).checkpoint_pending_reason === null &&
        checkpoints.length === 1 &&
        committed?.revision === 0 &&
        (await sessionRow(sessionId)).checkpoint_revision === 0 &&
        committed.turn_id ===
          (await turnRows(sessionId)).find((t) => String(t.sequence) === turnId)
            ?.id &&
        !committed.manifest_ref.startsWith(orphanDirectory) &&
        verified !== null &&
        verified.problems.length === 0,
    });

    await stopWorker(worker);
    expect(report.failed().filter((c) => c.id.startsWith("B-"))).toEqual([]);
  }, 900_000);

  test("C: a transcript mirror error blocks the checkpoint and new input", async () => {
    const spec = {
      id: "C1",
      steps: [write("/workspace/c.txt", "c turn 1\n")],
      final: "C1 DONE",
    };
    const created = await api.createSession(prompt("Turn one.", spec));
    const sessionId = created.session_id;
    report.meta.session_c = sessionId;
    const failing = await chaos.arm({
      action: "fail",
      upstream: "s3",
      method: "PUT",
      path: `sessions/${sessionId}/transcripts/`,
      times: -1,
    });
    const blocked = await waitFor(
      "checkpoint_pending_reason mirror_error",
      async () => {
        const row = await sessionRow(sessionId);
        return row.checkpoint_pending_reason === "mirror_error" ? row : null;
      },
      TURN_MS,
    );
    const worker = await workers.running(sessionId, 10_000).catch(() => null);
    const turn = await waitFor(
      "the turn to leave running",
      async () => {
        const found = await api.turn(sessionId, created.turn_id);
        return found.status !== "queued" && found.status !== "running"
          ? found
          : null;
      },
      TURN_MS,
    ).catch(async () => api.turn(sessionId, created.turn_id));
    const next = await api.postMessage(sessionId, "after the mirror error");
    const detail = await api.session(sessionId);
    const checkpoints = await checkpointRows(sessionId);
    await chaos.disarm(failing);
    const failedPuts = (await chaos.log(sessionId)).filter(
      (entry) => entry.rule === failing,
    ).length;
    report.check({
      id: "C-01",
      criterion: "fault: mirror 오류",
      title:
        "a mirror error is recorded, blocks the checkpoint, and refuses new input",
      input: "fail every PUT under this session's transcripts/",
      expected:
        "checkpoint_pending_reason mirror_error; the turn not completed; no checkpoints row; POST messages refused 409 (CHECKPOINT_UNAVAILABLE, or RECOVERY_REQUIRED once the drained worker left the turn unknown)",
      actual: {
        failed_puts: failedPuts,
        pending_reason: blocked.checkpoint_pending_reason,
        durability: detail?.durability,
        turn: { status: turn.status, terminal_reason: turn.terminal_reason },
        checkpoints: checkpoints.length,
        next_message: {
          status: next.status,
          body: next.body,
        },
      },
      pass:
        failedPuts > 0 &&
        blocked.checkpoint_pending_reason === "mirror_error" &&
        checkpoints.length === 0 &&
        turn.status !== "completed" &&
        next.status === 409 &&
        /CHECKPOINT_UNAVAILABLE|RECOVERY_REQUIRED/.test(
          JSON.stringify(next.body),
        ),
    });
    if (worker) await stopWorker(worker);
    expect(report.failed().filter((c) => c.id.startsWith("C-"))).toEqual([]);
  }, 900_000);

  test("D: a worker that loses its lease mid-turn promotes nothing", async () => {
    const spec = {
      id: "D1",
      // The model holds its answer long enough to stop the scheduler and
      // pause the worker while the turn is still open.
      steps: [{ ...write("/workspace/d.txt", "d turn 1\n"), delayMs: 30_000 }],
      final: "D1 DONE",
    };
    const created = await api.createSession(prompt("Turn one.", spec));
    const sessionId = created.session_id;
    report.meta.session_d = sessionId;
    await waitFor(
      "the model call of D1",
      async () => (await messages.requests("D1")).length > 0,
      TURN_MS,
      250,
    );
    const worker = await workers.running(sessionId, 10_000);
    // With the scheduler stopped nothing replaces or reaps the worker, so
    // what follows is the worker's own reaction to finding its lease gone.
    // The reconciler service keeps running and is expected to fence the
    // attempt during the pause; the pass run by hand below then
    // finds it done, and the checks do not ask which pass it was.
    await scheduler("stop");
    try {
      const exited = exitOf(worker);
      await run(["docker", "pause", worker.name]);
      const pausedAt = new Date();
      await Bun.sleep(40_000);
      const reconciled = await reconcileOnce();
      const lost = await rows<{ state: string; end_reason: string | null }>(
        "SELECT state, end_reason FROM attempts WHERE session_id = $1",
        [sessionId],
      );
      await run(["docker", "unpause", worker.name]);
      const exitCode = await exited;
      const log = await workers.events(worker.name);
      const late = (await chaos.log(sessionId)).filter(
        (entry) =>
          entry.upstream === "gateway" && new Date(entry.at) > pausedAt,
      );
      report.check({
        id: "D-01",
        criterion: "fault: lease 상실",
        title:
          "a worker that was paused past its lease is refused and stops as lost",
        input:
          "docker pause for 40s (lease TTL 30s) under the periodic reconciler, one more pass by hand, docker unpause",
        expected: `attempt lost; the worker's later gateway calls answered 401/409; worker.stopping lost; exit ${WORKER_EXIT_LEASE_LOST} without release`,
        actual: {
          attempts: lost,
          late_calls: late.map(
            (entry) =>
              `${entry.path.split("/").at(-1)} ${entry.upstreamStatus}`,
          ),
          stopping: log.find((line) => line.event === "worker.stopping"),
          released: log.some((line) => line.event === "worker.released"),
          exit: exitCode,
          reconciler: reconciled
            .split("\n")
            .filter((line) => line.includes("lease"))
            .slice(0, 3),
          periodic_reconciler: (
            await run(["docker", "logs", `${env?.project}-reconciler-1`], {
              allowFail: true,
            })
          ).stdout
            .split("\n")
            .filter((line) => line.includes(sessionId))
            .slice(0, 3),
        },
        pass:
          lost.some((a) => a.state === "lost") &&
          late.length > 0 &&
          late.every((entry) =>
            [401, 409].includes(entry.upstreamStatus ?? 0),
          ) &&
          log.some(
            (line) => line.event === "worker.stopping" && line.kind === "lost",
          ) &&
          !log.some((line) => line.event === "worker.released") &&
          exitCode === WORKER_EXIT_LEASE_LOST,
      });
    } finally {
      await run(["docker", "unpause", worker.name], { allowFail: true });
      await scheduler("start");
    }
    const turns = await waitFor(
      "the lost turn to settle",
      async () => {
        const found = await turnRows(sessionId);
        return found.every((t) => t.status !== "running") ? found : null;
      },
      120_000,
    ).catch(() => turnRows(sessionId));
    const session = await sessionRow(sessionId);
    const checkpoints = await checkpointRows(sessionId);
    const turnPut = (await chaos.log(sessionId)).filter(
      (entry) =>
        entry.upstream === "s3" && entry.path.includes("/checkpoints/"),
    );
    report.check({
      id: "D-02",
      criterion: "fault: lease 상실",
      title: "neither the open turn's work nor the old attempt is promoted",
      input: "DB and bucket after the lost worker exited",
      expected:
        "turn outcome unknown; recovery_required; no checkpoints row; no pointer",
      actual: {
        turn: turns.map((t) => ({
          status: t.status,
          reason: t.terminal_reason,
          unknown: t.outcome_unknown,
        })),
        admission: session.admission_state,
        pointer: session.checkpoint_revision,
        checkpoints: checkpoints.length,
        checkpoint_writes: turnPut.map(
          (entry) => `${entry.method} ${entry.upstreamStatus}`,
        ),
      },
      pass:
        turns.length === 1 &&
        turns[0]?.outcome_unknown === true &&
        session.admission_state === "recovery_required" &&
        session.checkpoint_revision === null &&
        checkpoints.length === 0,
    });

    const decision = await api.call(
      "POST",
      `/v1/sessions/${sessionId}/recovery-decisions`,
      {
        decision: "abandon",
        expected_revision: (await api.session(sessionId)).revision,
        reason: "d2 gate: the lost attempt has no confirmed effect",
        target_turn_id: "1",
      },
    );
    const receiptId = (decision.body as { receipt_id?: string }).receipt_id;
    const receipt =
      decision.status === 202 && receiptId !== undefined
        ? await waitFor(
            `recovery receipt ${receiptId} to settle`,
            async () => {
              const found = (await api.call("GET", `/v1/receipts/${receiptId}`))
                .body as { status?: string; result?: unknown };
              return found.status === "accepted" ? null : found;
            },
            120_000,
            250,
          )
        : null;
    const [cleaned] = await turnRows(sessionId);
    const cleanedSession = await sessionRow(sessionId);
    report.check({
      id: "D-03",
      criterion: "outcome_unknown 복구 결정",
      title:
        "an operator decision, not a worker restart, settles the unknown turn",
      input: "abandon turn 1 after the lost execution is confirmed gone",
      expected:
        "202; recovery receipt succeeded; turn cancelled(operator_abandoned); session stopped",
      actual: {
        response_status: decision.status,
        receipt,
        turn: {
          status: cleaned?.status,
          reason: cleaned?.terminal_reason,
          unknown: cleaned?.outcome_unknown,
        },
        admission: cleanedSession.admission_state,
      },
      pass:
        decision.status === 202 &&
        receipt?.status === "succeeded" &&
        cleaned?.status === "cancelled" &&
        cleaned?.terminal_reason === "operator_abandoned" &&
        cleaned?.outcome_unknown === true &&
        cleanedSession.admission_state === "stopped",
    });
    expect(report.failed().filter((c) => c.id.startsWith("D-"))).toEqual([]);
  }, 900_000);

  test("E: an accepted interrupt stops its turn, however early it lands", async () => {
    const rounds = Number(process.env.D2_GATE_INTERRUPT_REPEAT ?? "6");
    const outcomes: Array<Record<string, unknown>> = [];
    for (let round = 0; round < rounds; round++) {
      // Early: the first 202, which a fresh session gives as soon as the
      // worker takes the input — its engine may still be booting. Streaming:
      // once the model call is out, where QA saw one no-op in four.
      const mode = round % 2 === 0 ? "early" : "streaming";
      const specId = `E${round}`;
      const created = await api.createSession(
        prompt("Hold the answer.", {
          id: specId,
          steps: [],
          final: `${specId} DONE`,
          finalDelayMs: 15_000,
        }),
      );
      const sessionId = created.session_id;
      if (mode === "streaming") {
        await waitFor(
          `the model call of ${specId}`,
          async () => (await messages.requests(specId)).length > 0,
          TURN_MS,
          100,
        );
      }
      // 409 TURN_NOT_STARTED while the turn is still queued.
      const accepted = await waitFor(
        `an interrupt of ${sessionId} to be accepted`,
        async () => {
          const answer = await api.call(
            "POST",
            `/v1/sessions/${sessionId}/interrupt`,
            { target_turn_id: "1" },
          );
          return answer.status === 202 ? answer : null;
        },
        TURN_MS,
        25,
      );
      const acceptedAt = Date.now();
      const receiptId = (accepted.body as { receipt_id: string }).receipt_id;
      const receipt = await waitFor(
        `receipt ${receiptId} to settle`,
        async () => {
          const found = (await api.call("GET", `/v1/receipts/${receiptId}`))
            .body as { status: string; result: unknown };
          return found.status === "accepted" ? null : found;
        },
        120_000,
      );
      const settledMs = Date.now() - acceptedAt;
      const [turn] = await turnRows(sessionId);
      outcomes.push({
        mode,
        session: sessionId,
        accepted_as: (accepted.body as { receipt_status: string })
          .receipt_status,
        receipt: receipt.status,
        result: receipt.result,
        turn: turn?.status,
        reason: turn?.terminal_reason,
        settled_ms: settledMs,
        model_calls: (await messages.requests(specId)).length,
      });
      // Frees the execution slot for the next round.
      await api.call("POST", `/v1/sessions/${sessionId}/terminate`, {
        expected_revision: (await api.session(sessionId)).revision,
        reason: "d2 gate E",
      });
    }
    const stopped = (outcome: Record<string, unknown>) => {
      const result = outcome.result as { no_op?: boolean } | null;
      return (
        outcome.receipt === "succeeded" &&
        result?.no_op === false &&
        outcome.turn === "interrupted"
      );
    };
    // A round whose answer still came first (202 already succeeded) tests
    // nothing about stopping; it only has to say it did nothing, as E-02.
    const honest = (outcome: Record<string, unknown>) =>
      outcome.accepted_as === "accepted"
        ? stopped(outcome)
        : outcome.turn === "completed" &&
          (outcome.result as { no_op?: boolean } | null)?.no_op === true;
    report.check({
      id: "E-01",
      criterion: "interrupt",
      title:
        "every accepted interrupt ends its turn; none is acknowledged and then outrun by the answer",
      input: `${rounds} fresh sessions whose answer takes 15s, interrupted alternately at the first 202 and after the model call`,
      expected:
        "each interrupt accepted while its turn ran: receipt succeeded with no_op false and the turn interrupted",
      actual: {
        stopped: outcomes.filter(stopped).length,
        rounds: outcomes,
      },
      pass: outcomes.length === rounds && outcomes.every(honest),
    });

    // What QA took for a silent no-op: an interrupt that reaches a turn
    // already over. It must say so rather than look like it stopped one.
    const late = await api.createSession(
      prompt("Answer at once.", { id: "E-late", steps: [], final: "E DONE" }),
    );
    const ended = await api.settle(late.session_id, "1", TURN_MS);
    const answer = await api.call(
      "POST",
      `/v1/sessions/${late.session_id}/interrupt`,
      { target_turn_id: "1" },
    );
    const { receipt_id: lateReceiptId, receipt_status: lateStatus } =
      answer.body as { receipt_id: string; receipt_status: string };
    const lateReceipt = (await api.call("GET", `/v1/receipts/${lateReceiptId}`))
      .body as {
      status: string;
      result: { no_op: boolean; terminal: string; turn_id: string } | null;
    };
    report.check({
      id: "E-02",
      criterion: "interrupt",
      title: "an interrupt that reaches a finished turn says it did nothing",
      input: "interrupt turn 1 after it completed",
      expected:
        "202 with receipt_status succeeded at once; the receipt's result names the completed terminal with no_op true",
      actual: {
        turn: ended.status,
        response: { status: answer.status, body: answer.body },
        receipt: lateReceipt,
      },
      pass:
        ended.status === "completed" &&
        answer.status === 202 &&
        lateStatus === "succeeded" &&
        lateReceipt.status === "succeeded" &&
        lateReceipt.result?.no_op === true &&
        lateReceipt.result.terminal === "completed" &&
        lateReceipt.result.turn_id === "1",
    });
    await api.call("POST", `/v1/sessions/${late.session_id}/terminate`, {
      expected_revision: (await api.session(late.session_id)).revision,
      reason: "d2 gate E",
    });
    expect(report.failed().filter((c) => c.id.startsWith("E-"))).toEqual([]);
  }, 3_600_000);
});
