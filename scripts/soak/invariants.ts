import type { Pool } from "pg";
import { database, run } from "../../tests/d2-gate/harness.ts";
import { soakEnv } from "./lib.ts";

/**
 * The soak invariants, read from outside the product: the database and
 * the Docker daemon. Each returns the offending rows (capped), so a
 * violation arrives with its evidence. Zero rows everywhere is the pass.
 *
 * Timestamps are transaction starts (defaultNow()), so an ordering check
 * allows `toleranceMs` for a transaction that began just before the fence
 * committed and was serialized behind it.
 */

export type InvariantOptions = {
  installation: string;
  /** How long a stopped/paused session may still hold its slot. */
  slotLeakGraceSec: number;
  slotLimit: number;
  toleranceMs: number;
};

type Invariant =
  /**
   * No context silently reset (the Messages-side check lives in soak.ts,
   * which sees what each turn's conversation carried).
   */
  | "context"
  /**
   * No write accepted from an attempt after it ended or after a newer attempt
   * of the session claimed.
   */
  | "stale_write"
  /**
   * Never two live attempts or two running workers for one session, and no
   * turn run by two attempts.
   */
  | "duplicate_execution"
  /**
   * No slot held for a session that can no longer run, and never more slots
   * than the limit.
   */
  | "slot_leak"
  /** Nothing whose outcome is unknown reads as success. */
  | "unconfirmed_success";

export type InvariantResult = {
  count: number;
  id: string;
  invariant: Invariant;
  rows: unknown[];
  title: string;
};

const ROW_CAP = 20;

type Query = {
  id: string;
  invariant: Invariant;
  sql: string;
  title: string;
  params: (options: InvariantOptions) => unknown[];
};

const QUERIES: Query[] = [
  {
    id: "context.reset_without_decision",
    invariant: "context",
    title:
      "sessions whose context was reset (start_fresh) — the soak never decides one, so any is unexplained",
    sql: `SELECT id::text, context_reset_turn_sequence, context_reset_checkpoint_revision
            FROM sessions WHERE context_reset_turn_sequence IS NOT NULL`,
    params: () => [],
  },
  {
    id: "stale_write.after_attempt_end",
    invariant: "stale_write",
    title: "events written by an attempt after it ended",
    // checkpoint_restore_failed and startup_failed are
    // the control plane's record of an ended attempt, written when the exit
    // is observed, not by the attempt.
    sql: `SELECT e.session_id::text, e.attempt_id, e.id, e.type, e.created_at, a.ended_at, a.end_reason
            FROM events e JOIN attempts a ON a.id = e.attempt_id
           WHERE a.ended_at IS NOT NULL
             AND COALESCE(e.payload->>'subtype', '') NOT IN ('checkpoint_restore_failed', 'startup_failed')
             AND e.created_at > a.ended_at + make_interval(secs => $1::double precision / 1000)`,
    params: (o) => [o.toleranceMs],
  },
  {
    id: "stale_write.after_newer_claim",
    invariant: "stale_write",
    title:
      "events written by an attempt after a newer attempt of its session claimed",
    sql: `SELECT e.session_id::text, e.attempt_id AS stale_attempt, b.id AS newer_attempt,
                 e.id, e.type, e.created_at, b.started_at AS newer_started_at
            FROM events e
            JOIN attempts a ON a.id = e.attempt_id
            JOIN attempts b ON b.session_id = a.session_id AND b.id <> a.id
                           AND b.started_at > a.started_at
           WHERE e.created_at > b.started_at + make_interval(secs => $1::double precision / 1000)`,
    params: (o) => [o.toleranceMs],
  },
  {
    id: "stale_write.checkpoint_after_attempt_end",
    invariant: "stale_write",
    title: "checkpoints committed for a turn after its attempt ended",
    sql: `SELECT c.session_id::text, c.revision, c.committed_at, a.id AS attempt_id, a.ended_at
            FROM checkpoints c
            JOIN turns t ON t.id = c.turn_id
            JOIN attempts a ON a.id = t.attempt_id
           WHERE a.ended_at IS NOT NULL
             AND c.committed_at > a.ended_at + make_interval(secs => $1::double precision / 1000)`,
    params: (o) => [o.toleranceMs],
  },
  {
    id: "duplicate_execution.open_attempts",
    invariant: "duplicate_execution",
    title: "sessions with more than one open attempt now",
    sql: `SELECT session_id::text, array_agg(id ORDER BY started_at) AS attempts
            FROM attempts WHERE state NOT IN ('exited', 'lost')
           GROUP BY session_id HAVING count(*) > 1`,
    params: () => [],
  },
  {
    id: "duplicate_execution.turn_by_two_attempts",
    invariant: "duplicate_execution",
    title: "turns with events from more than one attempt (a turn run twice)",
    sql: `SELECT e.session_id::text, t.sequence, t.status, t.outcome_unknown,
                 array_agg(DISTINCT e.attempt_id) AS attempts
            FROM events e JOIN turns t ON t.id = e.turn_id
           WHERE e.attempt_id IS NOT NULL
           GROUP BY e.session_id, t.sequence, t.status, t.outcome_unknown
          HAVING count(DISTINCT e.attempt_id) > 1`,
    params: () => [],
  },
  {
    id: "slot_leak.held_by_idle_session",
    invariant: "slot_leak",
    title:
      "open slots of sessions that are stopped, closed or paused, past the grace period",
    sql: `SELECT wl.execution_id, wl.session_id::text, s.status, s.admission_state,
                 wl.slot_reserved_at, s.updated_at
            FROM worker_launches wl LEFT JOIN sessions s ON s.id = wl.session_id
           WHERE wl.slot_released_at IS NULL
             AND (s.id IS NULL OR s.admission_state IN ('stopped', 'closed', 'paused'))
             AND wl.slot_reserved_at < now() - make_interval(secs => $1)
             AND (s.id IS NULL OR s.updated_at < now() - make_interval(secs => $1))`,
    params: (o) => [o.slotLeakGraceSec],
  },
  {
    id: "slot_leak.over_limit",
    invariant: "slot_leak",
    title: "more open slots than the execution slot limit",
    sql: `SELECT count(*)::int AS open_slots FROM worker_launches
           WHERE slot_released_at IS NULL HAVING count(*) > $1`,
    params: (o) => [o.slotLimit],
  },
  {
    id: "unconfirmed_success.unknown_completed",
    invariant: "unconfirmed_success",
    title: "turns marked completed although their outcome is unknown",
    sql: `SELECT session_id::text, sequence, status, terminal_reason
            FROM turns WHERE outcome_unknown AND status = 'completed'`,
    params: () => [],
  },
  {
    id: "unconfirmed_success.completed_unfinished",
    invariant: "unconfirmed_success",
    title: "turns marked completed with no end time",
    sql: `SELECT session_id::text, sequence FROM turns
           WHERE status = 'completed' AND ended_at IS NULL`,
    params: () => [],
  },
  {
    id: "unconfirmed_success.receipt_ahead_of_turn",
    invariant: "unconfirmed_success",
    title:
      "input receipts settled as succeeded whose turn did not complete (or is unknown)",
    sql: `SELECT r.id::text AS receipt_id, r.operation, t.session_id::text, t.sequence,
                 t.status, t.outcome_unknown
            FROM receipts r
            JOIN turns t ON t.session_id = (r.target_ref->>'session_id')::uuid
                        AND t.sequence::text = r.target_ref->>'turn_id'
           WHERE r.operation IN ('create_session', 'append_message')
             AND r.status = 'succeeded'
             AND (t.status <> 'completed' OR t.outcome_unknown)`,
    params: () => [],
  },
];

/** Observations the criteria table reports next to the invariants. */
const OBSERVATIONS = {
  queue_oldest_age_sec: `SELECT COALESCE(EXTRACT(EPOCH FROM now() - min(created_at)), 0)::float AS v
                           FROM queue_messages WHERE claimed_by IS NULL`,
  outcome_unknown_turns:
    "SELECT count(*)::int AS v FROM turns WHERE outcome_unknown",
  open_slots:
    "SELECT count(*)::int AS v FROM worker_launches WHERE slot_released_at IS NULL",
  open_attempts:
    "SELECT count(*)::int AS v FROM attempts WHERE state NOT IN ('exited', 'lost')",
  recovery_required:
    "SELECT count(*)::int AS v FROM sessions WHERE admission_state = 'recovery_required'",
  checkpoint_pending:
    "SELECT COALESCE(json_object_agg(r, n), '{}'::json) AS v FROM (SELECT checkpoint_pending_reason AS r, count(*) AS n FROM sessions WHERE checkpoint_pending_reason IS NOT NULL GROUP BY 1) x",
  turns_by_status:
    "SELECT COALESCE(json_object_agg(status, n), '{}'::json) AS v FROM (SELECT status, count(*) AS n FROM turns GROUP BY 1) x",
  accepted_to_started_p95_ms: `SELECT percentile_disc(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM started_at - created_at) * 1000)::float AS v
                                 FROM turns WHERE started_at IS NOT NULL`,
} as const;

type RunningWorker = { execution: string; name: string; session: string };

/** Running worker containers, from Docker's own labels. */
async function listRunning(installation: string): Promise<RunningWorker[]> {
  // Throws when Docker does not answer: an empty listing must mean no
  // workers, never "could not look".
  const { stdout } = await run([
    "docker",
    "ps",
    "--filter",
    `label=werft.installation=${installation}`,
    "--filter",
    "name=ap-worker-",
    "--format",
    '{{.Names}}\t{{.Label "werft.session-id"}}\t{{.Label "werft.session-execution-id"}}',
  ]);
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name = "", session = "", execution = ""] = line.split("\t");
      return { execution, name, session };
    });
}

/** Running worker containers per session. */
export async function runningWorkers(
  installation: string,
): Promise<Map<string, string[]>> {
  const bySession = new Map<string, string[]>();
  for (const { name, session } of await listRunning(installation)) {
    bySession.set(session, [...(bySession.get(session) ?? []), name]);
  }
  return bySession;
}

type Lifetime = {
  container: string;
  die: number | null;
  execution: string;
  name: string;
  session: string;
  start: number;
};

/**
 * Every worker container's lifetime, from `docker events` for as long as
 * the run lasts: two workers of one session alive at once is a duplicate
 * execution even when both are gone before the next snapshot. Each event is
 * also appended to the run's raw output.
 */
export class ContainerLifetimes {
  readonly lifetimes = new Map<string, Lifetime>();
  private process: { kill(): void } | undefined;
  failed: string | null = null;

  constructor(
    private readonly installation: string,
    private readonly sink: { write(record: Record<string, unknown>): void },
  ) {}

  async start(): Promise<void> {
    for (const worker of await listRunning(this.installation)) {
      const { stdout } = await run([
        "docker",
        "inspect",
        "--format",
        "{{.Id}} {{.State.StartedAt}}",
        worker.name,
      ]);
      const [id = worker.name, startedAt = ""] = stdout.trim().split(" ");
      this.lifetimes.set(id, {
        container: id,
        die: null,
        execution: worker.execution,
        name: worker.name,
        session: worker.session,
        start: Date.parse(startedAt),
      });
    }
    const child = Bun.spawn(
      [
        "docker",
        "events",
        "--filter",
        `label=werft.installation=${this.installation}`,
        "--filter",
        "type=container",
        "--filter",
        "event=start",
        "--filter",
        "event=die",
        "--format",
        "{{json .}}",
      ],
      { stderr: "pipe", stdout: "pipe" },
    );
    this.process = child;
    void this.read(child.stdout);
    void child.exited.then((code) => {
      if (this.process === child) this.failed = `docker events exited ${code}`;
    });
  }

  private async read(stream: ReadableStream<Uint8Array>): Promise<void> {
    let buffered = "";
    for await (const chunk of stream) {
      buffered += new TextDecoder().decode(chunk);
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
        try {
          this.record(JSON.parse(line));
        } catch {}
      }
    }
  }

  private record(event: {
    Action?: string;
    Actor?: { Attributes?: Record<string, string>; ID?: string };
    timeNano?: number;
  }): void {
    const attributes = event.Actor?.Attributes ?? {};
    const id = event.Actor?.ID ?? "";
    const name = attributes.name ?? "";
    if (!name.startsWith("ap-worker-")) return;
    const at = Math.round((event.timeNano ?? 0) / 1e6);
    this.sink.write({ action: event.Action, id, name, at, attributes });
    if (event.Action === "start") {
      this.lifetimes.set(id, {
        container: id,
        die: null,
        execution: attributes["werft.session-execution-id"] ?? "",
        name,
        session: attributes["werft.session-id"] ?? "",
        start: at,
      });
    } else if (event.Action === "die") {
      const known = this.lifetimes.get(id);
      if (known) known.die = at;
    }
  }

  /** Pairs of one session's workers alive together longer than the tolerance. */
  overlaps(toleranceMs: number, now = Date.now()): unknown[] {
    const bySession = new Map<string, Lifetime[]>();
    for (const lifetime of this.lifetimes.values()) {
      bySession.set(lifetime.session, [
        ...(bySession.get(lifetime.session) ?? []),
        lifetime,
      ]);
    }
    const found: unknown[] = [];
    for (const [session, lifetimes] of bySession) {
      const sorted = lifetimes.sort((a, b) => a.start - b.start);
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const a = sorted[i];
          const b = sorted[j];
          if (!a || !b) continue;
          const shared = Math.min(a.die ?? now, b.die ?? now) - b.start;
          if (shared > toleranceMs) {
            found.push({
              session,
              first: a.name,
              second: b.name,
              sharedMs: shared,
            });
          }
        }
      }
    }
    return found;
  }

  stop(): void {
    const child = this.process;
    this.process = undefined;
    child?.kill();
  }
}

/**
 * Open slots whose execution has no running worker, remembered across
 * samples: a slot held that way past the grace period — outside a launch
 * backoff — is a leak whatever the session's state (an active session whose
 * worker vanished included).
 */
export class SlotWatch {
  private readonly missingSince = new Map<string, number>();

  async check(
    db: Pool,
    running: RunningWorker[],
    graceSec: number,
    now = Date.now(),
  ): Promise<unknown[]> {
    const { rows } = await db.query(
      `SELECT wl.execution_id, wl.session_id::text, s.admission_state::text, s.status::text,
              wl.launch_retry_at, wl.last_launch_error
         FROM worker_launches wl LEFT JOIN sessions s ON s.id = wl.session_id
        WHERE wl.slot_released_at IS NULL
          AND (wl.launch_retry_at IS NULL OR wl.launch_retry_at < now())`,
    );
    const live = new Set(running.map((worker) => worker.execution));
    const open = new Set<string>();
    const leaks: unknown[] = [];
    for (const row of rows as Array<
      { execution_id: string } & Record<string, unknown>
    >) {
      open.add(row.execution_id);
      if (live.has(row.execution_id)) {
        this.missingSince.delete(row.execution_id);
        continue;
      }
      const since = this.missingSince.get(row.execution_id) ?? now;
      this.missingSince.set(row.execution_id, since);
      if (now - since >= graceSec * 1000) {
        leaks.push({ ...row, missingForSec: Math.round((now - since) / 1000) });
      }
    }
    for (const execution of this.missingSince.keys()) {
      if (!open.has(execution)) this.missingSince.delete(execution);
    }
    return leaks;
  }
}

export async function checkInvariants(
  db: Pool,
  options: InvariantOptions,
  watch: { lifetimes?: ContainerLifetimes; slots?: SlotWatch } = {},
): Promise<{
  observations: Record<string, unknown>;
  results: InvariantResult[];
}> {
  const results: InvariantResult[] = [];
  for (const query of QUERIES) {
    const { rows } = await db.query(query.sql, query.params(options));
    results.push({
      id: query.id,
      invariant: query.invariant,
      title: query.title,
      count: rows.length,
      rows: rows.slice(0, ROW_CAP),
    });
  }

  const running = await listRunning(options.installation);
  const workers = new Map<string, string[]>();
  for (const { name, session } of running) {
    workers.set(session, [...(workers.get(session) ?? []), name]);
  }
  const doubled = [...workers].filter(([, names]) => names.length > 1);
  results.push({
    id: "duplicate_execution.running_containers",
    invariant: "duplicate_execution",
    title: "sessions with more than one running worker container now",
    count: doubled.length,
    rows: doubled
      .slice(0, ROW_CAP)
      .map(([session, names]) => ({ session, names })),
  });
  if (watch.lifetimes) {
    const overlaps = watch.lifetimes.overlaps(options.toleranceMs);
    const failed = watch.lifetimes.failed;
    results.push({
      id: "duplicate_execution.overlapping_lifetimes",
      invariant: "duplicate_execution",
      title:
        "two worker containers of one session alive at the same time, over the whole run (docker events)",
      // A dead event stream has stopped watching: that is not a clean result.
      count: overlaps.length + (failed ? 1 : 0),
      rows: [...(failed ? [{ failed }] : []), ...overlaps.slice(0, ROW_CAP)],
    });
  }
  const ids = [...workers.keys()].filter(Boolean);
  const { rows: gone } = ids.length
    ? await db.query(
        `SELECT id::text, status, admission_state FROM sessions
          WHERE id = ANY($1::uuid[])
            AND admission_state IN ('stopped', 'closed', 'paused')
            AND updated_at < now() - make_interval(secs => $2)`,
        [ids, options.slotLeakGraceSec],
      )
    : { rows: [] };
  results.push({
    id: "slot_leak.running_container_of_idle_session",
    invariant: "slot_leak",
    title:
      "worker containers still running for sessions stopped, closed or paused past the grace period",
    count: gone.length,
    rows: gone.slice(0, ROW_CAP),
  });
  if (watch.slots) {
    const leaks = await watch.slots.check(
      db,
      running,
      options.slotLeakGraceSec,
    );
    results.push({
      id: "slot_leak.open_slot_without_worker",
      invariant: "slot_leak",
      title:
        "open slots whose execution has had no running worker for the grace period, outside a launch backoff",
      count: leaks.length,
      rows: leaks.slice(0, ROW_CAP),
    });
  }

  const observations: Record<string, unknown> = {
    running_worker_containers: running.length,
  };
  for (const [name, sql] of Object.entries(OBSERVATIONS)) {
    const { rows } = await db.query(sql);
    observations[name] = (rows[0] as { v: unknown } | undefined)?.v ?? null;
  }
  return { observations, results };
}

if (import.meta.main) {
  // One snapshot against the running soak stack, printed as JSON.
  const env = soakEnv();
  const db = database(env.databaseUrl);
  try {
    const snapshot = await checkInvariants(db, {
      installation: env.installation,
      slotLeakGraceSec: Number(process.argv[2] ?? "180"),
      slotLimit: Number(process.argv[3] ?? "10"),
      toleranceMs: 1000,
    });
    console.log(JSON.stringify(snapshot, null, 2));
  } finally {
    await db.end();
  }
}
