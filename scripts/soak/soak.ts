import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { Pool } from "pg";
import { database, Workers } from "../../tests/d2-gate/harness.ts";
import {
  ContainerLifetimes,
  checkInvariants,
  type InvariantResult,
  SlotWatch,
} from "./invariants.ts";
import {
  between,
  type Criterion,
  clockOffset,
  compose,
  composeToFile,
  criterion,
  distribution,
  markdownReport,
  Output,
  reproMeta,
  type SoakEnv,
  sha256File,
  soakEnv,
} from "./lib.ts";
import { type MessagesFaults, validFaults } from "./messages.ts";
import {
  Api,
  admissionProbe,
  type ControlSample,
  interruptProbe,
  Model,
  modelEvidence,
  resumeStartup,
  type StartupSample,
  settle,
  startupSample,
  type TurnKind,
  terminateProbe,
  turnPrompt,
} from "./probes.ts";
import type { Stall } from "./vm-lag.ts";

/**
 * The soak runner: N sessions repeating scripted turns against the
 * stack scripts/soak/stack.sh started, for a duration and with measurements
 * fixed in a config file before the run (scripts/soak/config/*.json).
 *
 *   source "$SOAK_STATE/vars.sh"
 *   bun scripts/soak/soak.ts scripts/soak/config/preflight-1h.json [out-dir]
 *   bun scripts/soak/soak.ts --judge <out-dir>     judge a run again from its files
 *
 * Every raw observation lands as JSONL in the output directory (turns,
 * controls, readyz, the host probe, invariants, clock, model requests, fault injector
 * traffic, reconciler passes, worker logs), next to config.json (the file
 * as run), meta.json (reproducibility), summary.json and report.md (the
 * criteria table). The exit code is 0 only when every criterion passed.
 */

export type SoakConfig = {
  name: string;
  purpose: string;
  sessions: number;
  durationMin: number;
  warmupMin: number;
  drainSec: number;
  quiesceSec: number;
  ramp: number[];
  turn: {
    stepDelayMs: [number, number];
    thinkMs: [number, number];
    timeoutSec: number;
    pollMs: number;
  };
  probes: {
    interruptEveryTurns: number;
    terminateEveryMin: number;
    pauseResumeEveryMin: number;
    slowStepMs: number;
    pollMs: number;
  };
  messagesFaults: MessagesFaults;
  readyz: { intervalMs: number; timeoutMs: number };
  invariants: {
    intervalMin: number;
    slotLeakGraceSec: number;
    slotLimit: number;
    toleranceMs: number;
  };
  /**
   * How often the product reconciler's status file is read, and
   * how old its last successful pass may be at any reading — the compose
   * healthcheck's RECONCILER_HEALTH_STALE_SEC.
   */
  reconciler: { intervalSec: number; staleSec: number };
  sampleIntervalSec: number;
  targets: {
    acceptP95Ms: number;
    interruptEffectMs: number;
    /** POST to the turn settling `interrupted`, checkpoint included. */
    interruptTerminalMs: number;
    terminateEffectMs: number;
    readyzAvailability: number;
  };
  measurement: Record<string, unknown>;
};

export function validConfig(value: unknown): SoakConfig {
  const config = value as SoakConfig;
  const problems: string[] = [];
  const positive = (name: string, n: unknown) => {
    if (typeof n !== "number" || !(n > 0)) problems.push(`${name} must be > 0`);
  };
  const range = (name: string, r: unknown) => {
    if (
      !Array.isArray(r) ||
      r.length !== 2 ||
      typeof r[0] !== "number" ||
      typeof r[1] !== "number" ||
      r[0] < 0 ||
      r[1] < r[0]
    ) {
      problems.push(`${name} must be [min, max]`);
    }
  };
  if (!config.name) problems.push("name is required");
  positive("sessions", config.sessions);
  positive("durationMin", config.durationMin);
  if (!(config.warmupMin >= 0 && config.warmupMin < config.durationMin)) {
    problems.push("warmupMin must be within [0, durationMin)");
  }
  if (
    !Array.isArray(config.ramp) ||
    config.ramp.length === 0 ||
    config.ramp.some((n, i) => !(n > (config.ramp[i - 1] ?? 0))) ||
    config.ramp.at(-1) !== config.sessions
  ) {
    problems.push("ramp must rise strictly and end at sessions");
  }
  range("turn.stepDelayMs", config.turn?.stepDelayMs);
  range("turn.thinkMs", config.turn?.thinkMs);
  positive("turn.timeoutSec", config.turn?.timeoutSec);
  positive("turn.pollMs", config.turn?.pollMs);
  positive("probes.interruptEveryTurns", config.probes?.interruptEveryTurns);
  positive("probes.terminateEveryMin", config.probes?.terminateEveryMin);
  positive("probes.pauseResumeEveryMin", config.probes?.pauseResumeEveryMin);
  positive("probes.slowStepMs", config.probes?.slowStepMs);
  positive("probes.pollMs", config.probes?.pollMs);
  if (
    config.probes?.slowStepMs <=
    Math.max(config.targets?.interruptEffectMs ?? 0, 0)
  ) {
    problems.push(
      "probes.slowStepMs must outlast targets.interruptEffectMs, or a slow step ending on its own reads as an interrupt",
    );
  }
  const readyz = config.readyz;
  if (
    !Number.isInteger(readyz?.intervalMs) ||
    readyz.intervalMs < 1000 ||
    !(readyz.timeoutMs > 0 && readyz.timeoutMs < readyz.intervalMs)
  ) {
    problems.push(
      "readyz.intervalMs must be an integer >= 1000 and readyz.timeoutMs within (0, intervalMs)",
    );
  }
  positive("invariants.intervalMin", config.invariants?.intervalMin);
  positive("invariants.slotLimit", config.invariants?.slotLimit);
  positive("sampleIntervalSec", config.sampleIntervalSec);
  positive("reconciler.intervalSec", config.reconciler?.intervalSec);
  positive("reconciler.staleSec", config.reconciler?.staleSec);
  positive("targets.acceptP95Ms", config.targets?.acceptP95Ms);
  if (
    !(
      config.targets?.interruptTerminalMs >
      Math.max(config.targets?.interruptEffectMs ?? 0, 0)
    )
  ) {
    problems.push(
      "targets.interruptTerminalMs must outlast targets.interruptEffectMs: the turn settles only after its engine stopped",
    );
  }
  try {
    validFaults(config.messagesFaults);
  } catch (error) {
    problems.push(`messagesFaults: ${String(error)}`);
  }
  if (problems.length > 0) {
    throw new Error(`invalid soak config:\n- ${problems.join("\n- ")}`);
  }
  return config;
}

// ---------------------------------------------------------------- runtime

type Clock = { stopping: boolean };

export type TurnRecord = {
  slot: number;
  generation: number;
  sessionId: string | null;
  turnId: string | null;
  specId: string;
  kind: TurnKind;
  endpoint: "POST /v1/sessions" | "POST /v1/sessions/{id}/messages";
  sentAt: number;
  acceptMs: number;
  acceptStatus: number;
  inWindow: boolean;
  rampStep: number | null;
  startupClass: "cold-create" | "cold-relaunch" | "warm" | "unknown" | null;
  status: string | null;
  terminalReason: unknown;
  outcomeUnknown: unknown;
  settleMs: number | null;
  startup: Awaited<ReturnType<typeof startupSample>> | null;
  contextKept: boolean | null;
  startsAnswered: number | null;
  modelFaults: number | null;
  error?: string;
};

class Soak {
  readonly turns: TurnRecord[] = [];
  readonly controls: ControlSample[] = [];
  readonly readyz: ReadyzSample[] = [];
  readonly vmStalls: VmStall[] = [];
  readonly vmPolls: VmPoll[] = [];
  readonly hostProbe: HostProbeSample[] = [];
  /** Read from the worker logs once the run is over. */
  engineStops: EngineStop[] = [];
  readonly vmCursor: { bootId: string | null; index: number } = {
    bootId: null,
    index: 0,
  };
  readonly phases: Array<Record<string, unknown>> = [];
  readonly reconciler: ReconcilerSample[] = [];
  readonly invariantSamples: Array<{
    at: string;
    results: InvariantResult[];
    observations: Record<string, unknown>;
  }> = [];
  readonly anomalies: Array<Record<string, unknown>> = [];
  windowStart = Number.POSITIVE_INFINITY;
  windowEnd = Number.POSITIVE_INFINITY;
  readonly lifetimes: ContainerLifetimes;
  readonly slots = new SlotWatch();

  constructor(
    readonly config: SoakConfig,
    readonly env: SoakEnv,
    readonly out: Output,
    readonly api: Api,
    readonly model: Model,
    readonly db: Pool,
  ) {
    this.lifetimes = new ContainerLifetimes(
      env.installation,
      out.jsonl("container-events"),
    );
  }

  inWindow(at: number): boolean {
    return at >= this.windowStart && at <= this.windowEnd;
  }

  recordTurn(record: TurnRecord): void {
    this.turns.push(record);
    this.out.jsonl("turns").write(record);
  }

  recordControl(sample: ControlSample): void {
    // An interrupt belongs to the window its POST went out in, as rc.sh
    // counts them; the others by when their probe ended.
    const sentAt = sample.extra?.sentAt;
    const inWindow = this.inWindow(
      typeof sentAt === "string" ? Date.parse(sentAt) : Date.now(),
    );
    this.controls.push(sample);
    this.out.jsonl("controls").write({ ...sample, inWindow });
  }

  phase(entry: Record<string, unknown>): void {
    this.phases.push(entry);
    this.out.jsonl("phases").write(entry);
  }

  anomaly(entry: Record<string, unknown>): void {
    this.anomalies.push(entry);
    this.out.jsonl("anomalies").write(entry);
    console.error(`anomaly: ${JSON.stringify(entry)}`);
  }
}

class SessionLoop {
  sessionId: string | null = null;
  generation = 0;
  turnNo = 0;
  lastCompletedSpec: string | null = null;
  pending: "terminate" | "pause" | null = null;
  busy = false;

  constructor(
    private readonly soak: Soak,
    readonly slot: number,
  ) {}

  private get config() {
    return this.soak.config;
  }

  /** The session's first turn, as a new session; the ramp tags it. */
  async open(rampStep: number | null): Promise<void> {
    this.generation++;
    this.sessionId = null;
    this.turnNo = 0;
    this.lastCompletedSpec = null;
    await this.turn("normal", rampStep);
  }

  async loop(schedule: { deadline: number }, clock: Clock): Promise<void> {
    while (Date.now() < schedule.deadline && !clock.stopping) {
      if (this.sessionId === null) {
        await this.open(null);
        continue;
      }
      const action = this.pending;
      this.pending = null;
      const kind: TurnKind =
        action === "terminate"
          ? "terminate"
          : (this.turnNo + 1) % this.config.probes.interruptEveryTurns === 0
            ? "interrupt"
            : "normal";
      await this.turn(kind, null);
      if (action === "pause" && this.sessionId !== null) {
        await this.pauseAndResume();
      }
      await Bun.sleep(between(this.config.turn.thinkMs));
    }
  }

  private async turn(kind: TurnKind, rampStep: number | null): Promise<void> {
    const soak = this.soak;
    const creating = this.sessionId === null;
    this.turnNo++;
    const specId = `s${this.slot}g${this.generation}t${this.turnNo}`;
    const text = turnPrompt({
      id: specId,
      kind,
      slowStepMs: this.config.probes.slowStepMs,
      stepDelayMs: between(this.config.turn.stepDelayMs),
      slot: this.turnNo % 20,
    });
    this.busy = true;
    try {
      const posted = creating
        ? await soak.api.createSession(text)
        : await soak.api.postMessage(this.sessionId ?? "", text);
      const body = (posted.body ?? {}) as {
        session_id?: string;
        turn_id?: string;
      };
      if (creating && body.session_id) this.sessionId = body.session_id;
      const record: TurnRecord = {
        slot: this.slot,
        generation: this.generation,
        sessionId: this.sessionId,
        turnId: body.turn_id ?? null,
        specId,
        kind,
        endpoint: creating
          ? "POST /v1/sessions"
          : "POST /v1/sessions/{id}/messages",
        sentAt: posted.sentAt,
        acceptMs: posted.ms,
        acceptStatus: posted.status,
        inWindow: soak.inWindow(posted.sentAt),
        rampStep,
        startupClass: null,
        status: null,
        terminalReason: null,
        outcomeUnknown: null,
        settleMs: null,
        startup: null,
        contextKept: null,
        startsAnswered: null,
        modelFaults: null,
      };
      if (
        (posted.status !== 201 && posted.status !== 202) ||
        !this.sessionId ||
        !body.turn_id
      ) {
        record.error = `accept ${posted.status} ${JSON.stringify(posted.body).slice(0, 300)}`;
        soak.recordTurn(record);
        await this.recover(`turn not accepted: ${record.error}`);
        return;
      }
      const sessionId = this.sessionId;
      const turnId = body.turn_id;

      if (kind === "interrupt") {
        soak.recordControl(
          await interruptProbe(soak.api, soak.model, {
            budgetMs: this.config.probes.slowStepMs + 60_000,
            pollMs: this.config.probes.pollMs,
            sessionId,
            slowStepMs: this.config.probes.slowStepMs,
            specId,
            turnId,
          }),
        );
      }
      if (kind === "terminate") {
        soak.recordControl(
          await terminateProbe(soak.api, soak.model, {
            budgetMs: 120_000,
            installation: soak.env.installation,
            pollMs: Math.max(this.config.probes.pollMs, 250),
            sessionId,
            specId,
            turnId,
          }),
        );
      }

      const settled = await settle(soak.api, sessionId, turnId, {
        pollMs: this.config.turn.pollMs,
        timeoutMs: this.config.turn.timeoutSec * 1000,
      });
      record.settleMs = settled ? settled.at - posted.sentAt : null;
      record.status = settled ? String(settled.turn.status) : "timeout";
      record.terminalReason = settled?.turn.terminal_reason ?? null;
      const evidence = modelEvidence(
        await soak.model.requests({ spec: specId }),
        creating ? null : this.lastCompletedSpec,
      );
      record.contextKept = evidence.contextKept;
      record.startsAnswered = evidence.startsAnswered;
      record.modelFaults = evidence.faults;
      record.startup = await startupSample(soak.db, soak.model, {
        sessionId,
        specId,
        turnId,
      });
      record.outcomeUnknown = record.startup.outcomeUnknown;
      record.startupClass = creating
        ? "cold-create"
        : record.startup.temperature === "cold"
          ? "cold-relaunch"
          : record.startup.temperature;
      soak.recordTurn(record);

      if (kind === "terminate") {
        this.sessionId = null;
        return;
      }
      if (record.status === "completed") this.lastCompletedSpec = specId;
      if (!settled) {
        await this.recover(
          `turn ${turnId} did not end in ${this.config.turn.timeoutSec}s`,
        );
      }
    } catch (error) {
      soak.anomaly({
        slot: this.slot,
        sessionId: this.sessionId,
        specId,
        error: String(error),
      });
      await this.recover(`exception: ${String(error)}`);
    } finally {
      this.busy = false;
    }
  }

  private async pauseAndResume(): Promise<void> {
    const soak = this.soak;
    const sessionId = this.sessionId;
    if (!sessionId) return;
    const pause = await admissionProbe(soak.api, {
      budgetMs: 180_000,
      op: "pause",
      pollMs: 250,
      sessionId,
    });
    soak.recordControl(pause);
    if (pause.receiptStatus !== "succeeded") return;
    const resume = await admissionProbe(soak.api, {
      budgetMs: 180_000,
      op: "resume",
      pollMs: 250,
      sessionId,
    });
    if (resume.receiptStatus === "succeeded" && resume.receiptId) {
      resume.extra = {
        ...resume.extra,
        startup: await resumeStartup(soak.db, soak.env.chaosUrl, {
          receiptId: resume.receiptId,
          sessionId,
        }),
      };
    }
    soak.recordControl(resume);
    if (resume.receiptStatus !== "succeeded")
      await this.recover(`resume ${resume.receiptStatus ?? "timeout"}`);
  }

  /**
   * A session the loop cannot drive any more (not accepted, stuck, not
   * resumed) is recorded, terminated best-effort and replaced, so the soak
   * keeps its session count.
   */
  private async recover(reason: string): Promise<void> {
    const soak = this.soak;
    const sessionId = this.sessionId;
    const session = sessionId ? await soak.api.session(sessionId) : null;
    soak.anomaly({
      slot: this.slot,
      sessionId,
      reason,
      admission_state: session?.admission_state ?? null,
      status: session?.status ?? null,
    });
    if (sessionId) await soak.api.control(sessionId, "terminate");
    this.sessionId = null;
    await Bun.sleep(5000);
  }
}

// ---------------------------------------------------------------- background

async function every(
  clock: Clock,
  intervalMs: number,
  task: () => Promise<void>,
): Promise<void> {
  while (!clock.stopping) {
    const started = Date.now();
    try {
      await task();
    } catch (error) {
      console.error(`background task: ${String(error)}`);
    }
    const wait = intervalMs - (Date.now() - started);
    const until = Date.now() + Math.max(0, wait);
    while (!clock.stopping && Date.now() < until) {
      await Bun.sleep(Math.min(1000, until - Date.now()));
    }
  }
}

/**
 * One /readyz request, timed by curl rather than by this process: the
 * runner's own event loop stalls while it parses a large log batch, and a
 * timer measured here would charge that stall to the API. `wallMs` is kept
 * beside it so such a stall stays visible.
 */
export type ReadyzSample = {
  error: string | null;
  ms: number;
  ok: boolean;
  status: number;
  t: string;
  wallMs: number;
  /**
   * From `t` to curl's spawn returning. Kept for the record only: the child
   * may start after the spawn returned.
   */
  spawnMs?: number;
};

/** A host probe request: which of HOST_PROBE's targets it went to. */
export type HostProbeSample = ReadyzSample & { target: string };

/** A VM probe stall, with the host clock offset of the poll that read it. */
export type VmStall = Stall & {
  bootId: string;
  offsetMs: number;
  offsetErrorMs: number;
};

/**
 * The host probe: curl from the host, each slot, to the /healthz
 * of two idle containers that do no product work, vm-lag and its twin
 * host-echo. Both sit behind the same Docker Desktop port forward readyz
 * takes, which can hold requests while the VM keeps ticking (RC4 06:05:52Z,
 * 07:00:48Z) where vm-lag's ticks cannot see it. A request of `nearMissMs`
 * or more is listed. A target is held where a request of READYZ_EXCLUSION's
 * `stallMinMs` or more got no answer but 200; such a request also spent up
 * to `slackMs` on ordinary work on either side of the hold, so the hold
 * surely covered its run less that much at each end. A host stall is a
 * stretch of `stallMinMs` or more where both targets were held at once:
 * one target alone may be its own container, not the shared path. Slots do
 * not wait on each other, so a held request never delays the next.
 */
export const HOST_PROBE = {
  intervalMs: 500,
  timeoutMs: 2000,
  nearMissMs: 500,
  slackMs: 100,
  targets: ["vm-lag", "host-echo"],
};

/** A worker's own engine_stopped log line, on the container clock. */
export type EngineStop = { sessionId: string; turnId: string; at: number };

type VmPoll = {
  t: string;
  ok: boolean;
  bootId?: string;
  rttMs?: number;
  stalls?: number;
  error?: string;
};

/**
 * O-1 exclusions (decided with Codex). The
 * target itself (availability 1.0, the 2s timeout) is the config's.
 * - runner: a slot the host runner never probed says nothing of the API;
 * - host: a timeout with no answer but 200 while a stall of at least
 *   `stallMinMs` surely overlapped the request: the VM probe's (the whole
 *   VM stood still) or the host probe's (the port forward held). "Surely":
 *   the stall narrowed by its uncertainty, the request to
 *   [t + wallMs - ms, t + ms], what curl ran however late it started. All
 *   on the host's clock.
 * Past either ratio of all samples the measurement itself is suspect, and
 * O-1 fails.
 */
export const READYZ_EXCLUSION = {
  stallMinMs: 1000,
  maxHostExcludedRatio: 0.01,
  maxRunnerMissedRatio: 0.01,
};

const RUNNER_ERRORS = ["slot missed", "probe did not run"];
const CURL_TIMEOUT = "curl exit 28";

/**
 * The stalls long enough to excuse anything, on the host clock and narrowed
 * by their clock uncertainty, each reaching `tailMs` past its end.
 */
function longStalls(stalls: VmStall[], tailMs = 0) {
  return stalls
    .filter((stall) => stall.gapMs >= READYZ_EXCLUSION.stallMinMs)
    .map((stall) => ({
      from: stall.from + stall.offsetMs + stall.offsetErrorMs,
      to: stall.to + stall.offsetMs - stall.offsetErrorMs + tailMs,
      label: `${new Date(stall.from + stall.offsetMs).toISOString()} +${stall.gapMs}ms`,
    }));
}

/** Where curl surely ran: it ended by t + wallMs, so began by that less ms. */
const curlSurely = (sample: ReadyzSample) => {
  const sent = Date.parse(sample.t);
  return {
    from: sent + Math.max(0, sample.wallMs - sample.ms),
    until: sent + sample.ms,
  };
};

/** A request that got no answer but 200 in time: only the path held it. */
const heldOnly = (sample: ReadyzSample) =>
  sample.ok ||
  (sample.error === CURL_TIMEOUT &&
    (sample.status === 0 || sample.status === 200));

/**
 * Where one target was surely held, as disjoint stretches in time order:
 * each held request narrowed by the slack, overlapping ones merged.
 */
function heldStretches(samples: HostProbeSample[], target: string) {
  const held = samples
    .flatMap((sample) => {
      if (
        sample.target !== target ||
        sample.ms < READYZ_EXCLUSION.stallMinMs ||
        !heldOnly(sample)
      ) {
        return [];
      }
      const ran = curlSurely(sample);
      const from = ran.from + HOST_PROBE.slackMs;
      const to = ran.until - HOST_PROBE.slackMs;
      return from < to ? [{ from, to }] : [];
    })
    .sort((a, b) => a.from - b.from);
  const merged: Array<{ from: number; to: number }> = [];
  for (const next of held) {
    const last = merged.at(-1);
    if (last && next.from <= last.to) last.to = Math.max(last.to, next.to);
    else merged.push({ ...next });
  }
  return merged;
}

/** The host probe's stalls, shaped as `longStalls`. */
function hostStalls(samples: HostProbeSample[], tailMs = 0) {
  const [a = [], b = []] = HOST_PROBE.targets.map((target) =>
    heldStretches(samples, target),
  );
  const stalls: Array<{ from: number; to: number; label: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a[i] as { from: number; to: number };
    const y = b[j] as { from: number; to: number };
    const from = Math.max(x.from, y.from);
    const to = Math.min(x.to, y.to);
    if (to - from >= READYZ_EXCLUSION.stallMinMs) {
      stalls.push({
        from,
        to: to + tailMs,
        label: `host ${new Date(from).toISOString()} +${to - from}ms`,
      });
    }
    if (x.to < y.to) i++;
    else j++;
  }
  return stalls;
}

/** The host probe's record for the report; its stalls feed the exclusions. */
export function summarizeHostProbe(samples: HostProbeSample[]) {
  const stalls = hostStalls(samples);
  const targets = Object.fromEntries(
    HOST_PROBE.targets.map((target) => {
      const own = samples.filter((sample) => sample.target === target);
      return [
        target,
        {
          samples: own.length,
          ok: own.filter((sample) => sample.ok).length,
          timeouts: own.filter((sample) => sample.error === CURL_TIMEOUT)
            .length,
          otherFailures: own.filter(
            (sample) => !sample.ok && sample.error !== CURL_TIMEOUT,
          ).length,
          held: heldStretches(own, target).length,
          latency: distribution(
            own.filter((sample) => sample.ok).map((sample) => sample.ms),
          ),
        },
      ];
    }),
  );
  return {
    samples: samples.length,
    targets,
    stalls: { count: stalls.length, list: stalls.map((stall) => stall.label) },
    nearMisses: samples
      .filter((sample) => sample.ms >= HOST_PROBE.nearMissMs || !sample.ok)
      .map(({ target, t, ms, status, error }) => ({
        target,
        t,
        ms,
        status,
        error,
      })),
  };
}

export function judgeReadyz(
  samples: ReadyzSample[],
  stalls: VmStall[],
  target: number,
  host: HostProbeSample[] = [],
) {
  const vm = longStalls(stalls);
  const long = [...vm, ...hostStalls(host)];
  const runnerMissed: ReadyzSample[] = [];
  const hostExcluded: Array<{
    t: string;
    error: string | null;
    stall: string;
  }> = [];
  const product: ReadyzSample[] = [];
  let ok = 0;
  for (const sample of samples) {
    if (sample.ok) {
      ok++;
      continue;
    }
    if (RUNNER_ERRORS.some((prefix) => sample.error?.startsWith(prefix))) {
      runnerMissed.push(sample);
      continue;
    }
    const { from, until } = curlSurely(sample);
    const stall = heldOnly(sample)
      ? long.find((entry) => entry.from < until && entry.to > from)
      : undefined;
    if (stall) {
      hostExcluded.push({
        t: sample.t,
        error: sample.error,
        stall: stall.label,
      });
    } else {
      product.push(sample);
    }
  }
  const total = samples.length;
  const judged = total - runnerMissed.length - hostExcluded.length;
  const ratio = (n: number) => (total ? n / total : 0);
  const availability = judged > 0 ? ok / judged : null;
  return {
    pass:
      availability !== null &&
      availability >= target &&
      ratio(hostExcluded.length) <= READYZ_EXCLUSION.maxHostExcludedRatio &&
      ratio(runnerMissed.length) <= READYZ_EXCLUSION.maxRunnerMissedRatio,
    samples: total,
    ok,
    judged,
    availability,
    productFailures: product.map(({ t, error, status }) => ({
      t,
      error,
      status,
    })),
    runnerMissed: runnerMissed.length,
    runnerMissedRatio: ratio(runnerMissed.length),
    hostExcluded: hostExcluded.length,
    hostExcludedRatio: ratio(hostExcluded.length),
    hostExcludedSamples: hostExcluded,
    stalls: {
      count: vm.length,
      maxGapMs: Math.max(0, ...stalls.map((stall) => stall.gapMs)),
      list: vm.map((stall) => stall.label),
    },
  };
}

/**
 * P-3 host exclusions (decided with Codex), on O-1's
 * rule: an interrupt whose effect came later than the target while a VM or
 * host probe stall of at least `stallMinMs`, or the `afterStallMs` after it
 * the stack takes to catch up (RC4: readyz slow ~20s after one), surely
 * overlapped [POST sent, effect]. Only lateness is excused: an excluded
 * interrupt must still settle `interrupted` in time with its receipt and
 * engine_stopped on record, and its session's next turn must complete.
 * Past the ratio of all interrupts the measurement is suspect, and P-3
 * fails. The targets themselves are the config's.
 */
export const INTERRUPT_EXCLUSION = {
  afterStallMs: 20_000,
  maxHostExcludedRatio: 0.01,
};

/**
 * The interrupt's effect: POST sent → the worker logging
 * engine_stopped, moved onto the host clock at the latest it can have
 * been. The probe reads the container clock just before the POST and again
 * once the event was read; each reading bounds the offset by half its
 * round trip, and taking the later of the two bounds holds even if the
 * clock stepped in between. The runner's SSE read comes after the worker
 * published the event, so it bounds the effect from above and stands in
 * wherever the log cannot be tied to the event: no line, more than one line
 * for the turn, a reading missing, or a value past the SSE read or before
 * the POST. null: the runner never read the event.
 */
function interruptEffect(
  sample: ControlSample,
  sentAt: number,
  stops: Map<string, number[]>,
): { ms: number; from: "worker log" | "sse" } | null {
  if (sample.effectMs === null) return null;
  const sse = { ms: sample.effectMs, from: "sse" as const };
  const found = stops.get(`${sample.sessionId} ${sample.turnId}`) ?? [];
  const extra = sample.extra ?? {};
  const bounds = [
    [extra.clockOffsetMs, extra.clockRttMs],
    [extra.clockAfterOffsetMs, extra.clockAfterRttMs],
  ].map(([offset, rtt]) =>
    typeof offset === "number" && typeof rtt === "number"
      ? offset + Math.ceil(rtt / 2)
      : Number.NaN,
  );
  const [stoppedAt] = found;
  if (
    found.length !== 1 ||
    stoppedAt === undefined ||
    !Number.isFinite(sentAt) ||
    !bounds.every(Number.isFinite)
  ) {
    return sse;
  }
  const ms = stoppedAt + Math.max(...bounds) - sentAt;
  return ms >= 0 && ms < sse.ms ? { ms, from: "worker log" } : sse;
}

/** Every engine_stopped the worker logs in `dir` hold, under the session each log claimed. */
export function readEngineStops(dir: string): EngineStop[] {
  if (!existsSync(dir)) return [];
  const stops: EngineStop[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".log")) continue;
    let sessionId: string | null = null;
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        record.event === "worker.claimed" &&
        typeof record.session_id === "string"
      ) {
        sessionId = record.session_id;
      } else if (
        record.event === "worker.turn.engine_stopped" &&
        sessionId !== null &&
        typeof record.turn_id === "string"
      ) {
        const at = Date.parse(String(record.timestamp));
        if (Number.isFinite(at)) {
          stops.push({ sessionId, turnId: record.turn_id, at });
        }
      }
    }
  }
  return stops;
}

export function judgeInterrupts(
  samples: ControlSample[],
  turns: Array<
    Pick<
      TurnRecord,
      | "acceptStatus"
      | "contextKept"
      | "kind"
      | "sentAt"
      | "sessionId"
      | "status"
      | "turnId"
    >
  >,
  stalls: VmStall[],
  targets: Pick<
    SoakConfig["targets"],
    "interruptEffectMs" | "interruptTerminalMs"
  >,
  evidence: { host?: HostProbeSample[]; engineStops?: EngineStop[] } = {},
) {
  const windows = [
    ...longStalls(stalls, INTERRUPT_EXCLUSION.afterStallMs),
    ...hostStalls(evidence.host ?? [], INTERRUPT_EXCLUSION.afterStallMs),
  ];
  const stops = new Map<string, number[]>();
  for (const stop of evidence.engineStops ?? []) {
    const key = `${stop.sessionId} ${stop.turnId}`;
    stops.set(key, [...(stops.get(key) ?? []), stop.at]);
  }
  const sentAtOf = (sample: ControlSample) =>
    typeof sample.extra?.sentAt === "string"
      ? Date.parse(sample.extra.sentAt)
      : Number.NaN;
  const effects = new Map(
    samples.map((sample) => [
      sample,
      interruptEffect(sample, sentAtOf(sample), stops),
    ]),
  );
  const terminalMsOf = (sample: ControlSample): number | null =>
    typeof sample.extra?.terminalMs === "number"
      ? sample.extra.terminalMs
      : null;
  const settledInTime = (sample: ControlSample) => {
    const ms = terminalMsOf(sample);
    return ms !== null && ms <= targets.interruptTerminalMs;
  };
  const continued = (sample: ControlSample) =>
    Number(sample.extra?.continuedAfterInterrupt ?? 0) > 0;
  const nextTurn = (sample: ControlSample) => {
    const own = turns.find(
      (turn) =>
        turn.sessionId === sample.sessionId && turn.turnId === sample.turnId,
    );
    if (!own) return null;
    return (
      turns
        .filter(
          (turn) =>
            turn.sessionId === sample.sessionId && turn.sentAt > own.sentAt,
        )
        .sort((a, b) => a.sentAt - b.sentAt)[0] ?? null
    );
  };
  const late: Array<{
    sessionId: string;
    turnId: string | null;
    effectMs: number;
    sseEffectMs: number | null;
  }> = [];
  const hostExcluded: Array<{
    sessionId: string;
    turnId: string | null;
    sentAt: string;
    effectMs: number;
    sseEffectMs: number | null;
    terminalMs: number | null;
    stall: string;
    nextTurn: string | null;
    broken: string[];
  }> = [];
  for (const sample of samples) {
    const effect = effects.get(sample);
    if (!effect || effect.ms <= targets.interruptEffectMs) continue;
    const sentAt = sentAtOf(sample);
    const effectAt = sentAt + effect.ms;
    const stall = Number.isFinite(sentAt)
      ? windows.find((entry) => entry.from < effectAt && entry.to > sentAt)
      : undefined;
    if (!stall) {
      late.push({
        sessionId: sample.sessionId,
        turnId: sample.turnId,
        effectMs: effect.ms,
        sseEffectMs: sample.effectMs,
      });
      continue;
    }
    const next = nextTurn(sample);
    const nextOk =
      next !== null &&
      next.kind === "normal" &&
      next.acceptStatus === 202 &&
      next.status === "completed" &&
      next.contextKept === true;
    const broken = [
      sample.extra?.valid === true ? null : "invalid",
      sample.effect === "interrupted" ? null : `effect ${sample.effect}`,
      settledInTime(sample) ? null : "terminal late",
      sample.receiptStatus === "succeeded"
        ? null
        : `receipt ${sample.receiptStatus}`,
      continued(sample) ? "continued" : null,
      nextOk ? null : "next turn not completed",
    ].filter((reason): reason is string => reason !== null);
    hostExcluded.push({
      sessionId: sample.sessionId,
      turnId: sample.turnId,
      sentAt: new Date(sentAt).toISOString(),
      effectMs: effect.ms,
      sseEffectMs: sample.effectMs,
      terminalMs: terminalMsOf(sample),
      stall: stall.label,
      nextTurn: next ? `${next.turnId} ${next.status}` : null,
      broken,
    });
  }
  const total = samples.length;
  const hostExcludedRatio = total ? hostExcluded.length / total : 0;
  const measured = [...effects.values()].filter(
    (effect): effect is NonNullable<typeof effect> => effect !== null,
  );
  return {
    pass:
      total > 0 &&
      samples.every(
        (sample) =>
          sample.extra?.valid === true &&
          sample.effect === "interrupted" &&
          sample.effectMs !== null &&
          settledInTime(sample) &&
          !continued(sample),
      ) &&
      late.length === 0 &&
      hostExcluded.every((entry) => entry.broken.length === 0) &&
      hostExcludedRatio <= INTERRUPT_EXCLUSION.maxHostExcludedRatio,
    samples: total,
    judged: total - hostExcluded.length,
    valid: samples.filter((sample) => sample.extra?.valid === true).length,
    unobserved: samples.filter((sample) => sample.effectMs === null).length,
    notInterrupted: samples.filter((sample) => sample.effect !== "interrupted")
      .length,
    settledLate: samples.filter((sample) => !settledInTime(sample)).length,
    continued: samples.filter(continued).length,
    late,
    hostExcluded: hostExcluded.length,
    hostExcludedRatio,
    hostExcludedSamples: hostExcluded,
    effectMs: measured.map((effect) => effect.ms),
    effectFromWorkerLog: measured.filter(
      (effect) => effect.from === "worker log",
    ).length,
    // The runner's SSE read, reported beside the effect and not judged.
    sseEffectMs: samples
      .map((sample) => sample.effectMs)
      .filter((ms): ms is number => ms !== null),
    sseLate: samples
      .filter(
        (sample) =>
          sample.effectMs !== null &&
          sample.effectMs > targets.interruptEffectMs,
      )
      .map((sample) => ({
        sessionId: sample.sessionId,
        turnId: sample.turnId,
        sseEffectMs: sample.effectMs,
        effectMs: effects.get(sample)?.ms ?? null,
      })),
    terminalMs: samples
      .map(terminalMsOf)
      .filter((ms): ms is number => ms !== null),
  };
}
type ReconcilerSample = {
  t: string;
  code: number;
  status: {
    consecutiveFailures?: number;
    lastFailureAt?: string | null;
    lastFailureReason?: string | null;
    lastSuccessAt?: string | null;
    loopStartedAt?: string;
    passes?: number;
  } | null;
};

/**
 * One curl per fixed slot from the loop's start. Every slot yields a
 * sample: a probe that could not run, and a slot the runner was too
 * stalled to reach, are failed intervals, never missing ones. Slots do not
 * wait on each other, so a held request never delays the next one; curl's
 * own timeout bounds how many run at once.
 */
export async function curlLoop(
  clock: Clock,
  url: string,
  interval: number,
  timeoutMs: number,
  record: (sample: ReadyzSample) => void,
): Promise<void> {
  const failed = (t: number, error: string): ReadyzSample => ({
    t: new Date(t).toISOString(),
    error,
    ms: 0,
    ok: false,
    status: 0,
    wallMs: 0,
  });
  // How late a probe may start and still stand for its slot.
  const grace = Math.min(1000, interval / 2);
  const running = new Set<Promise<void>>();
  let slot = Date.now();
  while (!clock.stopping) {
    const own = slot;
    const probe = curlProbe(url, timeoutMs, own + grace)
      .catch((error) =>
        failed(Date.now(), `probe did not run: ${String(error)}`),
      )
      .then((sample) =>
        record(
          sample === null
            ? failed(own, "slot missed: the runner did not get to it")
            : sample,
        ),
      );
    running.add(probe);
    void probe.finally(() => running.delete(probe));
    slot += interval;
    while (!clock.stopping && Date.now() < slot) {
      await Bun.sleep(Math.min(1000, slot - Date.now()));
    }
  }
  await Promise.all(running);
}

/**
 * null when the probe could not start by `notAfter`. `t` and `wallMs` count
 * from one instant, the one curlSurely() bounds curl's start from.
 */
async function curlProbe(
  url: string,
  timeoutMs: number,
  notAfter: number,
): Promise<ReadyzSample | null> {
  const sent = Date.now();
  if (sent > notAfter) return null;
  const child = Bun.spawn(
    [
      "curl",
      "-s",
      "-o",
      "/dev/null",
      "-m",
      String(timeoutMs / 1000),
      "-w",
      "%{http_code} %{time_total}",
      url,
    ],
    { stderr: "ignore", stdout: "pipe" },
  );
  const spawnMs = Date.now() - sent;
  const [text, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  const [httpCode = "0", seconds = "0"] = text.trim().split(" ");
  const status = Number(httpCode);
  return {
    t: new Date(sent).toISOString(),
    error: code === 0 ? null : `curl exit ${code}`,
    ms: Math.round(Number(seconds) * 1000),
    ok: code === 0 && status === 200,
    status,
    wallMs: Date.now() - sent,
    spawnMs,
  };
}

/**
 * Reads the VM probe's new stalls. A poll slower than the stalls the soak
 * judges on is dropped whole: its clock offset is too loose to place them.
 */
/** The host probe's targets, by name; refuses a stack from before them. */
function hostProbeUrls(env: SoakEnv): Record<string, string> {
  if (!env.hostEchoUrl) {
    throw new Error(
      "SOAK_HOST_ECHO_URL is not set: bring the stack up with this checkout's scripts/soak/stack.sh",
    );
  }
  return {
    "vm-lag": `${vmLagUrl(env)}/healthz`,
    "host-echo": `${env.hostEchoUrl}/healthz`,
  };
}

function vmLagUrl(env: SoakEnv): string {
  if (!env.vmLagUrl) {
    throw new Error(
      "SOAK_VM_LAG_URL is not set: bring the stack up with this checkout's scripts/soak/stack.sh",
    );
  }
  return env.vmLagUrl;
}

async function pollVmStalls(soak: Soak, url: string): Promise<void> {
  const cursor = soak.vmCursor;
  const t = new Date().toISOString();
  const poll = soak.out.jsonl("vm-probe");
  try {
    const sent = Date.now();
    const response = await fetch(`${url}/stalls?since=${cursor.index}`, {
      signal: AbortSignal.timeout(5000),
    });
    const body = (await response.json()) as {
      bootId: string;
      now: number;
      stalls: Stall[];
    };
    const received = Date.now();
    const rttMs = received - sent;
    if (rttMs >= READYZ_EXCLUSION.stallMinMs) {
      throw new Error(`poll took ${rttMs}ms`);
    }
    // A restarted probe counts from 0 again; what it missed while down
    // stays missed, which only leaves failures unexcused.
    if (body.bootId !== cursor.bootId) {
      const reread = cursor.index > 0;
      cursor.bootId = body.bootId;
      cursor.index = 0;
      if (reread) throw new Error(`probe restarted as ${body.bootId}`);
    }
    const offsetMs = Math.round((sent + received) / 2 - body.now);
    const offsetErrorMs = Math.ceil(rttMs / 2);
    const sink = soak.out.jsonl("vm-stalls");
    for (const stall of body.stalls) {
      const entry = { ...stall, bootId: body.bootId, offsetMs, offsetErrorMs };
      soak.vmStalls.push(entry);
      sink.write(entry);
      cursor.index = stall.index + 1;
    }
    const sample = {
      t,
      ok: true,
      bootId: body.bootId,
      rttMs,
      stalls: body.stalls.length,
    };
    soak.vmPolls.push(sample);
    poll.write(sample);
  } catch (error) {
    const sample = { t, ok: false, error: String(error) };
    soak.vmPolls.push(sample);
    poll.write(sample);
  }
}

function background(soak: Soak, clock: Clock): Promise<void>[] {
  const { config, env, out } = soak;
  let modelCursor = 0;
  let chaosCursor = 0;
  const tasks = [
    curlLoop(
      clock,
      `${env.apiUrl}/readyz`,
      config.readyz.intervalMs,
      config.readyz.timeoutMs,
      (sample) => {
        soak.readyz.push(sample);
        out.jsonl("readyz").write(sample);
      },
    ),
    ...Object.entries(hostProbeUrls(env)).map(([target, url]) =>
      curlLoop(
        clock,
        url,
        HOST_PROBE.intervalMs,
        HOST_PROBE.timeoutMs,
        (sample) => {
          const entry = { target, ...sample };
          soak.hostProbe.push(entry);
          out.jsonl("host-probe").write(entry);
        },
      ),
    ),
    every(clock, config.sampleIntervalSec * 1000, async () => {
      out.jsonl("clock").write(await clockOffset(env.messagesUrl));
      const requests = await soak.model.requests({ since: modelCursor });
      const sink = out.jsonl("model-requests");
      for (const entry of requests) sink.write({ ...entry });
      modelCursor = (requests.at(-1)?.index ?? modelCursor - 1) + 1;
      const traffic = (await fetch(
        `${env.chaosUrl}/log?since=${chaosCursor}`,
      ).then((response) => response.json())) as Array<{ index: number }>;
      const chaosSink = out.jsonl("worker-traffic");
      for (const entry of traffic) chaosSink.write({ ...entry });
      chaosCursor = (traffic.at(-1)?.index ?? chaosCursor - 1) + 1;
    }),
    every(clock, config.invariants.intervalMin * 60_000, async () => {
      await invariantSample(soak);
    }),
    every(clock, config.sampleIntervalSec * 1000, () =>
      pollVmStalls(soak, vmLagUrl(env)),
    ),
  ];
  // The compose reconciler runs its own loop; its status file is
  // the record of whether passes kept succeeding over the whole run.
  tasks.push(
    every(clock, config.reconciler.intervalSec * 1000, async () => {
      const result = await compose(env, [
        "exec",
        "-T",
        "reconciler",
        "cat",
        "/tmp/reconciler-status.json",
      ]);
      let status: unknown = null;
      try {
        status = JSON.parse(result.stdout);
      } catch {}
      const sample = {
        t: new Date().toISOString(),
        code: result.code,
        status: status as ReconcilerSample["status"],
      };
      soak.reconciler.push(sample);
      out.jsonl("reconciler").write({
        ...sample,
        ...(status === null ? { output: result.stderr.slice(-2000) } : {}),
      });
    }),
  );
  return tasks;
}

async function invariantSample(soak: Soak): Promise<void> {
  const { results, observations } = await checkInvariants(
    soak.db,
    { installation: soak.env.installation, ...soak.config.invariants },
    { lifetimes: soak.lifetimes, slots: soak.slots },
  );
  const sample = { at: new Date().toISOString(), results, observations };
  soak.invariantSamples.push(sample);
  soak.out.jsonl("invariants").write(sample);
}

// ---------------------------------------------------------------- report

type JudgeInput = Pick<
  Soak,
  | "anomalies"
  | "config"
  | "controls"
  | "engineStops"
  | "hostProbe"
  | "invariantSamples"
  | "phases"
  | "readyz"
  | "reconciler"
  | "turns"
  | "vmPolls"
  | "vmStalls"
>;

/** The longest stretch in [from, to] with no sample, in ms. */
function longestGap(times: number[], from: number, to: number): number {
  const points = [from, ...times.filter((t) => t > from && t < to), to].sort(
    (a, b) => a - b,
  );
  let longest = 0;
  for (let i = 1; i < points.length; i++) {
    longest = Math.max(longest, (points[i] ?? 0) - (points[i - 1] ?? 0));
  }
  return longest;
}

function judge(
  soak: JudgeInput,
  meta: Record<string, unknown>,
): {
  criteria: Criterion[];
  summary: Record<string, unknown>;
} {
  const { config, turns, controls, readyz, invariantSamples } = soak;
  // The steady phase the run was meant to cover, and whether it got there.
  const steadyPhase = soak.phases.find((entry) => entry.phase === "steady") as
    | { deadline?: number; rampEnded?: number }
    | undefined;
  const quiescePhase = soak.phases.find((entry) => entry.phase === "quiesce") as
    | { at?: number }
    | undefined;
  const steadyFrom = Number(steadyPhase?.rampEnded ?? Number.NaN);
  const steadyTo = Number(steadyPhase?.deadline ?? Number.NaN);
  const steadyKnown = Number.isFinite(steadyFrom) && Number.isFinite(steadyTo);
  const gap = (times: number[]) =>
    steadyKnown ? longestGap(times, steadyFrom, steadyTo) : null;
  const gaps = {
    readyz: gap(readyz.map((sample) => Date.parse(sample.t))),
    invariants: gap(invariantSamples.map((sample) => Date.parse(sample.at))),
    reconciler: gap(soak.reconciler.map((sample) => Date.parse(sample.t))),
  };
  const gapLimits = {
    readyz: 3 * config.readyz.intervalMs + config.readyz.timeoutMs,
    invariants: 1.5 * config.invariants.intervalMin * 60_000,
    reconciler: 3 * config.reconciler.intervalSec * 1000,
  };
  const inSteady = (t: string) =>
    steadyKnown && Date.parse(t) >= steadyFrom && Date.parse(t) <= steadyTo;
  const reconcilerSamples = soak.reconciler.filter((sample) =>
    inSteady(sample.t),
  );
  const unreadable = reconcilerSamples.filter(
    (sample) => sample.code !== 0 || sample.status === null,
  );
  // The status keeps only the latest failure, so a failed pass followed by
  // a success between two readings still shows through lastFailureAt.
  const failing = reconcilerSamples.filter(
    (sample) =>
      (sample.status?.consecutiveFailures ?? 0) > 0 ||
      (sample.status?.lastFailureAt != null &&
        Date.parse(sample.status.lastFailureAt) >= steadyFrom),
  );
  const staleness = reconcilerSamples.map((sample) =>
    sample.status?.lastSuccessAt
      ? Date.parse(sample.t) - Date.parse(sample.status.lastSuccessAt)
      : Number.POSITIVE_INFINITY,
  );
  // A restarted loop writes a new loopStartedAt, whatever its pass count,
  // and its fresh status clears lastFailureAt: every loop that started inside
  // the window is a restart, seen or not in the reading before it. The loop
  // and the runner share the Docker host's clock.
  const restarts = new Set(
    reconcilerSamples
      .map((sample) => sample.status?.loopStartedAt)
      .filter(
        (id): id is string =>
          typeof id === "string" && Date.parse(id) >= steadyFrom,
      ),
  ).size;
  const targets = config.targets;
  const accepted = (endpoint: TurnRecord["endpoint"]) =>
    distribution(
      turns
        .filter(
          (turn) =>
            turn.endpoint === endpoint &&
            turn.inWindow &&
            (turn.acceptStatus === 201 || turn.acceptStatus === 202),
        )
        .map((turn) => turn.acceptMs),
    );
  const messagesAccept = accepted("POST /v1/sessions/{id}/messages");
  const createAccept = accepted("POST /v1/sessions");
  const rejected = turns.filter(
    (turn) => turn.acceptStatus !== 201 && turn.acceptStatus !== 202,
  );
  const ofOp = (op: ControlSample["op"]) => controls.filter((c) => c.op === op);
  const interrupts = ofOp("interrupt");
  const terminates = ofOp("terminate");
  const effect = (samples: ControlSample[]) =>
    distribution(
      samples
        .map((sample) => sample.effectMs)
        .filter((ms): ms is number => ms !== null),
    );
  // Latency of what the API accepted; refusals are counted, not timed.
  const acceptedOf = (samples: ControlSample[]) =>
    distribution(
      samples
        .filter((sample) => sample.acceptStatus === 202)
        .map((sample) => sample.acceptedMs),
    );
  const refused = (samples: ControlSample[]) =>
    samples.filter((sample) => sample.acceptStatus !== 202).length;
  const valid = (samples: ControlSample[]) =>
    samples.filter((sample) => sample.extra?.valid === true);
  const interruptsJudged = judgeInterrupts(
    interrupts,
    turns,
    soak.vmStalls,
    targets,
    { host: soak.hostProbe, engineStops: soak.engineStops },
  );
  const validTerminates = valid(terminates);

  const stages = (samples: StartupSample[]) => {
    const of = (key: keyof StartupSample) =>
      distribution(
        samples
          .map((sample) => sample[key])
          .filter((value): value is number => typeof value === "number"),
      );
    return {
      acceptedToClaim: of("acceptedToClaimMs"),
      claimToReady: of("claimToReadyMs"),
      acceptedToReady: of("acceptedToReadyMs"),
    };
  };
  const startupOf = (name: NonNullable<TurnRecord["startupClass"]>) =>
    turns
      .filter((turn) => turn.startupClass === name)
      .flatMap((turn) => (turn.startup ? [turn.startup] : []));
  const resumeStartups = ofOp("resume").flatMap((sample) => {
    const startup = sample.extra?.startup as StartupSample | undefined;
    return startup ? [startup] : [];
  });
  const startupRows: Record<string, ReturnType<typeof stages>> = {
    "cold-create": stages(startupOf("cold-create")),
    "cold-resume": stages(resumeStartups),
    "cold-relaunch": stages(startupOf("cold-relaunch")),
    warm: stages(startupOf("warm")),
  };
  const rampRows: Record<string, ReturnType<typeof stages>> = {};
  for (const step of config.ramp) {
    rampRows[`concurrency_${step}`] = stages(
      turns
        .filter((turn) => turn.rampStep === step)
        .flatMap((turn) => (turn.startup ? [turn.startup] : [])),
    );
  }

  const worst = new Map<string, InvariantResult>();
  for (const sample of invariantSamples) {
    for (const result of sample.results) {
      const seen = worst.get(result.id);
      if (!seen || result.count > seen.count) worst.set(result.id, result);
    }
  }
  const byInvariant = (name: InvariantResult["invariant"]) =>
    [...worst.values()].filter((result) => result.invariant === name);
  const violations = (name: InvariantResult["invariant"]) =>
    byInvariant(name).filter((result) => result.count > 0);
  const contextLost = turns.filter((turn) => turn.contextKept === false);
  const contextChecked = turns.filter((turn) => turn.contextKept !== null);
  const startedTwice = turns.filter((turn) => (turn.startsAnswered ?? 0) > 1);
  const succeededWhileRunning = terminates.filter(
    (sample) => sample.extra?.succeededWhileRunning === true,
  );
  const timeouts = turns.filter((turn) => turn.status === "timeout");
  const statusCounts: Record<string, number> = {};
  for (const turn of turns) {
    const key = turn.status ?? `rejected ${turn.acceptStatus}`;
    statusCounts[key] = (statusCounts[key] ?? 0) + 1;
  }
  const readyzJudged = judgeReadyz(
    readyz,
    soak.vmStalls,
    targets.readyzAvailability,
    soak.hostProbe,
  );
  const hostProbe = summarizeHostProbe(soak.hostProbe);
  const probePolls = {
    ok: soak.vmPolls.filter((poll) => poll.ok).length,
    failed: soak.vmPolls.filter((poll) => !poll.ok).length,
  };
  const lastObservations = invariantSamples.at(-1)?.observations ?? {};
  const maxObservation = (name: string) =>
    Math.max(
      0,
      ...invariantSamples.map((sample) =>
        Number(sample.observations[name] ?? 0),
      ),
    );
  const invariantRow = (
    id: string,
    name: InvariantResult["invariant"],
    extra: { count: number; label: string }[],
  ) => {
    const found = violations(name);
    const extraFound = extra.filter((entry) => entry.count > 0);
    return criterion({
      id,
      area: "불변식",
      input: `${invariantSamples.length}회 표본의 DB·Docker 검사 (${byInvariant(
        name,
      )
        .map((result) => result.id)
        .join(
          ", ",
        )})${extra.length ? ` + ${extra.map((e) => e.label).join(", ")}` : ""}`,
      expected: "모든 검사 0건",
      actual:
        found.length + extraFound.length === 0
          ? "0건"
          : [
              ...found.map(
                (result) =>
                  `${result.id}=${result.count} ${JSON.stringify(result.rows.slice(0, 3))}`,
              ),
              ...extraFound.map((entry) => `${entry.label}=${entry.count}`),
            ].join("; "),
      pass:
        invariantSamples.length > 0 && found.length + extraFound.length === 0,
    });
  };

  const criteria: Criterion[] = [
    criterion({
      id: "L-1",
      area: "지속 부하",
      input: `${config.sessions}세션, ${config.durationMin}분, turn ${turns.length}개 (${JSON.stringify(statusCounts)})`,
      expected:
        "모든 슬롯이 끝까지 turn을 반복하고, 제한 시간을 넘긴 turn과 잃어버린 세션이 0",
      actual: `timeout ${timeouts.length}, anomaly ${soak.anomalies.length}, rejected ${rejected.length}`,
      pass: timeouts.length === 0 && soak.anomalies.length === 0,
    }),
    criterion({
      id: "P-1",
      area: "성능",
      input: `POST /v1/sessions/{id}/messages ${messagesAccept.n}건 (창 안, 202)`,
      expected: `p95 ≤ ${targets.acceptP95Ms}ms`,
      actual: messagesAccept,
      pass:
        messagesAccept.p95 !== null &&
        messagesAccept.p95 <= targets.acceptP95Ms,
    }),
    criterion({
      id: "P-2",
      area: "성능",
      input: `POST /v1/sessions ${createAccept.n}건 (창 안, 201/202)`,
      expected: `p95 ≤ ${targets.acceptP95Ms}ms`,
      actual: createAccept,
      pass:
        createAccept.p95 === null
          ? null
          : createAccept.p95 <= targets.acceptP95Ms,
    }),
    criterion({
      id: "P-3",
      area: "성능·종료 의미",
      input: `interrupt ${interrupts.length}건 (유효 ${interruptsJudged.valid}: 느린 호출 중·202·receipt no_op=false): accepted ${JSON.stringify(acceptedOf(interrupts))}, VM stall probe poll ${JSON.stringify(probePolls)}`,
      expected: `유효하지 않은 표본 0, 모든 표본의 engine_stopped를 SSE에서 관찰, host 제외가 아닌 모든 표본의 제품 effect(POST → worker 로그 engine_stopped, POST 앞뒤 /clock 값으로 옮긴 host 시계의 가장 늦은 시각) ≤ ${targets.interruptEffectMs}ms, 모든 표본이 ${targets.interruptTerminalMs}ms 안에 turn이 interrupted, 수락 뒤 모델 호출 0. host 제외는 [POST, 제품 effect]가 ${READYZ_EXCLUSION.stallMinMs}ms 이상 VM stall 또는 host stall의 [시작, 끝+${INTERRUPT_EXCLUSION.afterStallMs}ms]와 겹친 늦은 effect만이고, 그 표본도 receipt succeeded와 그 세션의 다음 turn completed가 있어야 한다. host 제외 ≤ ${INTERRUPT_EXCLUSION.maxHostExcludedRatio * 100}%(넘으면 측정 무효). SSE 관측 시각은 함께 싣는다. worker 로그를 그 event에 묶을 수 없는 표본(로그 줄이 없거나 둘 이상, POST 앞뒤 /clock 값 중 하나라도 없음, 계산 값이 음수이거나 SSE보다 늦음)은 SSE 관측 값으로 판정한다`,
      actual: `제품 effect ${JSON.stringify(distribution(interruptsJudged.effectMs))}(worker 로그 ${interruptsJudged.effectFromWorkerLog}건, 나머지는 SSE 값), SSE 관측 ${JSON.stringify(distribution(interruptsJudged.sseEffectMs))}·${targets.interruptEffectMs}ms 초과 ${JSON.stringify(interruptsJudged.sseLate)}, terminal ${JSON.stringify(distribution(interruptsJudged.terminalMs))}, 무효 ${interrupts.length - interruptsJudged.valid}, 관찰 못 함 ${interruptsJudged.unobserved}, interrupted 아님 ${interruptsJudged.notInterrupted}, 확정 늦음 ${interruptsJudged.settledLate}, 계속 호출 ${interruptsJudged.continued}, effect 초과(제외 아님) ${JSON.stringify(interruptsJudged.late)}, host 제외 ${interruptsJudged.hostExcluded}건(${interruptsJudged.hostExcludedRatio}, 판정 표본 ${interruptsJudged.judged}) ${JSON.stringify(interruptsJudged.hostExcludedSamples)}`,
      pass: interruptsJudged.pass,
    }),
    criterion({
      id: "P-4",
      area: "성능·종료 의미",
      input: `terminate ${terminates.length}건 (유효 ${validTerminates.length}: 느린 호출 중·202): accepted ${JSON.stringify(acceptedOf(terminates))}`,
      expected: `유효하지 않은 표본 0, 모든 표본이 ${targets.terminateEffectMs}ms 안에 receipt succeeded|unknown + worker 없음(receipt 정산 뒤에도)`,
      actual: `effect ${JSON.stringify(effect(validTerminates))}, receipt ${JSON.stringify(terminates.map((s) => s.receiptStatus))}, 확인 못 함 ${terminates.filter((s) => s.effectMs === null).length}, docker 관찰 실패 ${terminates.reduce((n, s) => n + Number(s.extra?.dockerFailures ?? 0), 0)}`,
      pass:
        terminates.length > 0 &&
        validTerminates.length === terminates.length &&
        terminates.every(
          (sample) =>
            sample.effectMs !== null &&
            sample.effectMs <= targets.terminateEffectMs,
        ),
    }),
    criterion({
      id: "P-5",
      area: "성능",
      input: `control accepted (interrupt·terminate·pause·resume ${controls.length}건, 202만 시간 표본)`,
      expected: `각 p95 ≤ ${targets.acceptP95Ms}ms, 거절(202 아님) 0`,
      actual: Object.fromEntries(
        (["interrupt", "terminate", "pause", "resume"] as const).map((op) => [
          op,
          { p95: acceptedOf(ofOp(op)).p95, refused: refused(ofOp(op)) },
        ]),
      ),
      pass: (["interrupt", "terminate", "pause", "resume"] as const).every(
        (op) => {
          const p95 = acceptedOf(ofOp(op)).p95;
          return (
            p95 !== null &&
            p95 <= targets.acceptP95Ms &&
            refused(ofOp(op)) === 0
          );
        },
      ),
    }),
    criterion({
      id: "S-1",
      area: "기동",
      input:
        "accepted→claim→SDK ready, 분류별 (cold-resume: resume receipt→claim→/ready 보고)",
      expected: "cold-create·cold-resume·warm 모두 표본 있음 (숫자 목표 없음)",
      actual: startupRows,
      pass: (["cold-create", "cold-resume", "warm"] as const).every(
        (name) => (startupRows[name]?.acceptedToReady.n ?? 0) > 0,
      ),
    }),
    criterion({
      id: "S-2",
      area: "기동",
      input: `새 세션 첫 turn, 동시 세션 ${config.ramp.join("→")}`,
      expected: "램프 단계마다 표본 있음 (숫자 목표 없음)",
      actual: rampRows,
      pass: config.ramp.every(
        (step) => (rampRows[`concurrency_${step}`]?.acceptedToReady.n ?? 0) > 0,
      ),
    }),
    invariantRow("I-1", "context", [
      {
        count: contextLost.length,
        label: `모델 요청에서 직전 완료 turn이 사라진 turn (검사 ${contextChecked.length}건)`,
      },
    ]),
    invariantRow("I-2", "stale_write", []),
    invariantRow("I-3", "duplicate_execution", [
      {
        count: startedTwice.length,
        label: "같은 turn의 첫 모델 호출이 두 번 응답된 turn",
      },
    ]),
    invariantRow("I-4", "slot_leak", []),
    invariantRow("I-5", "unconfirmed_success", [
      {
        count: succeededWhileRunning.length,
        label: "terminate succeeded인데 worker running",
      },
    ]),
    criterion({
      id: "O-1",
      area: "관측",
      input: `/readyz ${readyz.length}회, ${config.readyz.intervalMs}ms 간격, VM stall probe poll ${JSON.stringify(probePolls)}, host probe ${hostProbe.samples}회(${HOST_PROBE.intervalMs}ms 간격, ${HOST_PROBE.targets.join("·")} /healthz)`,
      expected: `러너 결측과 host 제외를 뺀 표본의 가용률 ≥ ${targets.readyzAvailability}. host 제외는 ${READYZ_EXCLUSION.stallMinMs}ms 이상 VM stall, 또는 두 host probe 대상이 함께 ${READYZ_EXCLUSION.stallMinMs}ms 이상 막힌 host stall이 요청 구간과 확실히 겹친 timeout만이다. host 제외 ≤ ${READYZ_EXCLUSION.maxHostExcludedRatio * 100}%, 러너 결측 ≤ ${READYZ_EXCLUSION.maxRunnerMissedRatio * 100}%(넘으면 측정 무효)`,
      actual: `가용률 ${readyzJudged.availability} (${readyzJudged.ok}/${readyzJudged.judged}), 제품 실패 ${JSON.stringify(readyzJudged.productFailures)}, host 제외 ${readyzJudged.hostExcluded}회(${readyzJudged.hostExcludedRatio}), 러너 결측 ${readyzJudged.runnerMissed}회(${readyzJudged.runnerMissedRatio}), VM stall ≥${READYZ_EXCLUSION.stallMinMs}ms ${readyzJudged.stalls.count}회·최대 ${readyzJudged.stalls.maxGapMs}ms(목록은 summary.json readyz.stalls), host stall ${hostProbe.stalls.count}회, host probe ${HOST_PROBE.nearMissMs}ms 이상 또는 실패 ${hostProbe.nearMisses.length}회, 대상별 ${JSON.stringify(Object.fromEntries(Object.entries(hostProbe.targets).map(([target, row]) => [target, { timeouts: row.timeouts, otherFailures: row.otherFailures, held: row.held }])))}(목록은 summary.json hostProbe), 응답 시간(curl) ${JSON.stringify(distribution(readyz.map((sample) => sample.ms)))}`,
      pass: readyzJudged.pass,
    }),
    criterion({
      id: "O-3",
      area: "관측",
      input: `compose reconciler status 파일 ${reconcilerSamples.length}회 (${config.reconciler.intervalSec}s 간격, steady 구간)`,
      expected: `모든 표본을 읽을 수 있고, 실패한 pass 0, 마지막 성공이 ${config.reconciler.staleSec}s보다 오래된 표본 0, 재시작(passes 감소) 0`,
      actual: {
        unreadable: unreadable.length,
        failing: failing.map((sample) => ({
          t: sample.t,
          reason: sample.status?.lastFailureReason ?? null,
        })),
        maxStalenessMs: staleness.length ? Math.max(...staleness) : null,
        restarts,
        passes: reconcilerSamples.at(-1)?.status?.passes ?? null,
      },
      pass:
        reconcilerSamples.length > 0 &&
        unreadable.length === 0 &&
        failing.length === 0 &&
        restarts === 0 &&
        staleness.every((ms) => ms <= config.reconciler.staleSec * 1000),
    }),
    criterion({
      id: "W-1",
      area: "실행 완주",
      input: `phases.jsonl과 표본 시각 (steady ${config.durationMin}분)`,
      expected: `steady 구간이 설정 길이이고 끝까지 돌았으며(quiesce ≥ deadline), 표본 공백이 readyz ≤ ${gapLimits.readyz}ms · invariants ≤ ${gapLimits.invariants}ms · reconciler ≤ ${gapLimits.reconciler}ms`,
      actual: {
        steadyFrom: steadyKnown ? new Date(steadyFrom).toISOString() : null,
        steadyTo: steadyKnown ? new Date(steadyTo).toISOString() : null,
        quiesceAt: quiescePhase?.at
          ? new Date(quiescePhase.at).toISOString()
          : null,
        gaps,
      },
      pass:
        steadyKnown &&
        steadyTo - steadyFrom === config.durationMin * 60_000 &&
        Number(quiescePhase?.at ?? 0) >= steadyTo &&
        (Object.keys(gaps) as Array<keyof typeof gaps>).every(
          (key) => gaps[key] !== null && (gaps[key] ?? 0) <= gapLimits[key],
        ),
    }),
    criterion({
      id: "O-2",
      area: "관측",
      input: "DB 관측 쿼리",
      expected: "기록 (판정 없음)",
      actual: {
        queue_oldest_age_sec_max: maxObservation("queue_oldest_age_sec"),
        accepted_to_started_p95_ms:
          lastObservations.accepted_to_started_p95_ms ?? null,
        outcome_unknown_turns: lastObservations.outcome_unknown_turns ?? null,
        recovery_required: lastObservations.recovery_required ?? null,
        checkpoint_pending: lastObservations.checkpoint_pending ?? null,
        turns_by_status: lastObservations.turns_by_status ?? null,
      },
      pass: true,
    }),
    criterion({
      id: "R-1",
      area: "재현성",
      input: "meta.json",
      expected:
        "commit·설정·SDK 0.3.319·CLI 2.1.319·Bun·이미지 식별자·bun.lock 해시·명령이 모두 기록됨",
      actual: {
        tested_sha: meta.tested_sha,
        worktree_dirty: meta.worktree_dirty,
        claude_agent_sdk: meta.claude_agent_sdk,
        claude_code: meta.claude_code,
        worker_bun: meta.worker_bun,
        bun_lock_sha256: meta.bun_lock_sha256,
        config_sha256: meta.config_sha256,
      },
      pass:
        meta.claude_agent_sdk === "0.3.319" &&
        String(meta.claude_code).startsWith("2.1.319") &&
        Boolean(meta.tested_sha) &&
        Boolean(meta.bun_lock_sha256) &&
        Boolean(meta.worker_bun),
    }),
  ];
  return {
    criteria,
    summary: {
      accept: { messages: messagesAccept, create: createAccept },
      interrupt: {
        accepted: acceptedOf(interrupts),
        effect: distribution(interruptsJudged.effectMs),
        effectFromWorkerLog: interruptsJudged.effectFromWorkerLog,
        sseEffect: distribution(interruptsJudged.sseEffectMs),
        sseLate: interruptsJudged.sseLate,
        late: interruptsJudged.late,
        judged: interruptsJudged.judged,
        hostExcluded: interruptsJudged.hostExcluded,
        hostExcludedRatio: interruptsJudged.hostExcludedRatio,
        hostExcludedSamples: interruptsJudged.hostExcludedSamples,
      },
      terminate: {
        accepted: acceptedOf(terminates),
        effect: effect(terminates),
      },
      pause: {
        accepted: acceptedOf(ofOp("pause")),
        effect: effect(ofOp("pause")),
      },
      resume: {
        accepted: acceptedOf(ofOp("resume")),
        effect: effect(ofOp("resume")),
      },
      startup: startupRows,
      ramp: rampRows,
      turns: { total: turns.length, byStatus: statusCounts },
      readyz: { ...readyzJudged, probePolls },
      hostProbe,
      anomalies: soak.anomalies.length,
      invariantSamples: invariantSamples.length,
    },
  };
}

// ---------------------------------------------------------------- main

async function main(): Promise<number> {
  const [configPath, outArg] = process.argv.slice(2);
  if (!configPath) {
    console.error("usage: bun scripts/soak/soak.ts <config.json> [out-dir]");
    return 2;
  }
  const config = validConfig(await Bun.file(configPath).json());
  const env = soakEnv();
  hostProbeUrls(env);
  const stamp = new Date().toISOString().replaceAll(":", "").slice(0, 15);
  const dir = resolve(
    outArg ??
      join(process.env.SOAK_STATE ?? ".", `soak-${config.name}-${stamp}`),
  );
  const out = new Output(dir);
  copyFileSync(configPath, join(dir, "config.json"));
  const meta = await reproMeta(env, {
    config: configPath,
    config_sha256: sha256File(configPath),
    run_started_at: new Date().toISOString(),
    reconciler: "compose reconciler service (94S-320)",
  });
  out.json("meta", meta);
  console.error(`soak ${config.name}: output ${dir}`);

  const api = new Api(env.apiUrl, env.apiKey);
  const model = new Model(env.messagesUrl);
  const db = database(env.databaseUrl);
  const soak = new Soak(config, env, out, api, model, db);
  const workerLogs = join(dir, "workers");
  mkdirSync(workerLogs, { recursive: true });
  const workers = new Workers(env.installation, workerLogs);
  workers.watch();
  await soak.lifetimes.start();
  await model.setFaults(config.messagesFaults);

  const clock: Clock = { stopping: false };
  const tasks = background(soak, clock);
  const loops = Array.from(
    { length: config.sessions },
    (_, slot) => new SessionLoop(soak, slot),
  );

  // Ramp: open sessions up to each step at once, so the first turns of a
  // step start together and are tagged with that concurrency; sessions
  // already open keep working meanwhile, as they would while an
  // installation scales from 1 to 10.
  const schedule = { deadline: Number.POSITIVE_INFINITY };
  const running: Promise<void>[] = [];
  let open = 0;
  for (const step of config.ramp) {
    const opening = loops.slice(open, step);
    console.error(`ramp → ${step} sessions`);
    await Promise.all(opening.map((loop) => loop.open(step)));
    for (const loop of opening) running.push(loop.loop(schedule, clock));
    open = step;
  }
  const rampEnded = Date.now();
  soak.windowStart = rampEnded + config.warmupMin * 60_000;
  const deadline = rampEnded + config.durationMin * 60_000;
  schedule.deadline = deadline;
  soak.windowEnd = deadline;
  soak.phase({
    phase: "steady",
    rampEnded,
    windowStart: soak.windowStart,
    deadline,
  });

  let next = 0;
  const pick = () => loops[next++ % loops.length];
  const timers = [
    setInterval(() => {
      const loop = pick();
      if (loop && loop.pending === null) loop.pending = "terminate";
    }, config.probes.terminateEveryMin * 60_000),
    setInterval(() => {
      const loop = pick();
      if (loop && loop.pending === null) loop.pending = "pause";
    }, config.probes.pauseResumeEveryMin * 60_000),
  ];
  const steady = Promise.all(running);
  const drainLimit = new Promise<void>((resolveLimit) =>
    setTimeout(resolveLimit, deadline - Date.now() + config.drainSec * 1000),
  );
  await Promise.race([steady, drainLimit]);
  for (const timer of timers) clearInterval(timer);
  const stuck = loops.filter((loop) => loop.busy).map((loop) => loop.slot);
  if (stuck.length > 0) soak.anomaly({ reason: "drain ran out", slots: stuck });
  soak.phase({ phase: "quiesce", at: Date.now() });
  await Bun.sleep(config.quiesceSec * 1000);
  await invariantSample(soak);
  clock.stopping = true;
  await Promise.all(tasks);
  await pollVmStalls(soak, vmLagUrl(env));
  workers.stop();
  soak.lifetimes.stop();
  soak.engineStops = readEngineStops(workerLogs);

  await dumpTables(db, out);
  await composeToFile(
    env,
    ["logs", "--no-color", "--timestamps"],
    join(dir, "compose.log"),
  );
  await db.end();
  return report(dir, soak, meta);
}

/** The rows the verdict rests on, kept with the run as raw evidence. */
async function dumpTables(db: Pool, out: Output): Promise<void> {
  for (const table of [
    "sessions",
    "turns",
    "attempts",
    "worker_launches",
    "executions",
    "checkpoints",
    "receipts",
    "control_intents",
  ]) {
    const { rows } = await db.query(`SELECT * FROM ${table}`);
    const sink = out.jsonl(`db-${table}`);
    for (const row of rows) sink.write(row as Record<string, unknown>);
  }
}

function report(
  dir: string,
  data: JudgeInput,
  meta: Record<string, unknown>,
): number {
  const out = new Output(dir);
  const { criteria, summary } = judge(data, meta);
  out.json("summary", summary);
  out.json("criteria", criteria);
  out.text(
    "report.md",
    markdownReport(`94S-135 soak — ${data.config.name}`, meta, criteria),
  );
  const failed = criteria.filter((row) => row.status === "fail");
  console.error(
    `soak ${data.config.name}: ${criteria.length - failed.length}/${criteria.length} pass or skip; report ${join(dir, "report.md")}`,
  );
  return failed.length === 0 ? 0 : 1;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

/**
 * Judges a finished run again from its raw files, with the same rules the
 * live run used. A control sample from before probes recorded their own
 * validity carries no proof the slow call was still pending, so it counts
 * as invalid rather than being reconstructed after the fact.
 */
function rejudge(dir: string): number {
  const at = (name: string) => join(dir, name);
  const config = validConfig(
    JSON.parse(readFileSync(at("config.json"), "utf8")),
  );
  const meta = JSON.parse(readFileSync(at("meta.json"), "utf8"));
  const controls = readJsonl<ControlSample>(at("controls.jsonl")).map(
    (sample) => {
      const extra = sample.extra ?? {};
      const proven =
        sample.op !== "interrupt" ||
        (typeof extra.acceptedBy === "string" &&
          typeof extra.slowPendingUntil === "string" &&
          Date.parse(extra.acceptedBy) < Date.parse(extra.slowPendingUntil));
      return extra.valid === true && proven
        ? sample
        : { ...sample, extra: { ...extra, valid: false, unproven: !proven } };
    },
  );
  return report(
    dir,
    {
      anomalies: readJsonl(at("anomalies.jsonl")),
      config,
      controls,
      engineStops: readEngineStops(at("workers")),
      hostProbe: readJsonl(at("host-probe.jsonl")),
      invariantSamples: readJsonl(at("invariants.jsonl")),
      phases: readJsonl(at("phases.jsonl")),
      readyz: readJsonl(at("readyz.jsonl")),
      reconciler: readJsonl(at("reconciler.jsonl")),
      turns: readJsonl(at("turns.jsonl")),
      vmPolls: readJsonl(at("vm-probe.jsonl")),
      vmStalls: readJsonl(at("vm-stalls.jsonl")),
    },
    { ...meta, rejudged_at: new Date().toISOString() },
  );
}

if (import.meta.main) {
  const [first, second] = process.argv.slice(2);
  process.exit(
    first === "--judge" && second ? rejudge(resolve(second)) : await main(),
  );
}
