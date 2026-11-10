import type { PendingRequest } from "@werft-ai/contracts";
import type { Pool } from "pg";
import { prompt, type Step, write } from "../../tests/d2-gate/harness.ts";
import { runningWorkers } from "./invariants.ts";
import { clockOffset } from "./lib.ts";
import type { MessagesFaults, RequestSummary } from "./messages.ts";

/**
 * How the soak and the campaigns drive a session and time what they drive,
 * all from outside: the public API, the database, Docker, and the soak
 * Messages API's request log. Every wait is bounded; a probe that runs out
 * of time returns what it saw instead of throwing, so one stuck session is
 * a recorded sample, not a dead run.
 */

const REPOSITORY_ID = "gate-app";

/** The gate agent's release (scripts/d2-gate/release.ts); every session runs it. */
function gateReleaseId(): string {
  const id = process.env.D2_GATE_RELEASE_ID;
  if (!id) {
    throw new Error(
      "D2_GATE_RELEASE_ID is unset: source the gate stack's vars.sh",
    );
  }
  return id;
}
const TERMINAL_TURN = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "outcome_unknown",
]);
const OPEN_RECEIPT = "accepted";

export type Timed = {
  body: unknown;
  /** Round trip of this one request, on the host clock. */
  ms: number;
  /** Host epoch ms the request was sent at. */
  sentAt: number;
  status: number;
};

export class Api {
  constructor(
    private readonly base: string,
    private readonly key: string,
    private readonly timeoutMs = 30_000,
  ) {}

  async call(method: string, path: string, body?: unknown): Promise<Timed> {
    const sentAt = Date.now();
    const started = performance.now();
    try {
      const response = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.key}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(method === "GET"
            ? {}
            : { "idempotency-key": crypto.randomUUID() }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await response.text();
      const ms = Math.round(performance.now() - started);
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {}
      return { body: parsed, ms, sentAt, status: response.status };
    } catch (error) {
      return {
        body: { error: String(error) },
        ms: Math.round(performance.now() - started),
        sentAt,
        status: 0,
      };
    }
  }

  createSession(message: string): Promise<Timed> {
    return this.call("POST", "/v1/sessions", {
      agent_release_id: gateReleaseId(),
      repository_id: REPOSITORY_ID,
      message,
    });
  }

  postMessage(sessionId: string, message: string): Promise<Timed> {
    return this.call("POST", `/v1/sessions/${sessionId}/messages`, { message });
  }

  async session(sessionId: string): Promise<Record<string, unknown> | null> {
    const got = await this.call("GET", `/v1/sessions/${sessionId}`);
    return got.status === 200 ? (got.body as Record<string, unknown>) : null;
  }

  async turn(
    sessionId: string,
    turnId: string,
  ): Promise<Record<string, unknown> | null> {
    const got = await this.call(
      "GET",
      `/v1/sessions/${sessionId}/turns/${turnId}`,
    );
    return got.status === 200 ? (got.body as Record<string, unknown>) : null;
  }

  async receipt(receiptId: string): Promise<Record<string, unknown> | null> {
    const got = await this.call("GET", `/v1/receipts/${receiptId}`);
    return got.status === 200 ? (got.body as Record<string, unknown>) : null;
  }

  /** Answers every open permission request the way a user would: allow. */
  async allowPending(sessionId: string): Promise<void> {
    const pending = await this.call(
      "GET",
      `/v1/sessions/${sessionId}/pending-requests`,
    );
    const { items } = (pending.body ?? {}) as { items?: PendingRequest[] };
    for (const request of items ?? []) {
      if (request.kind !== "permission") continue;
      await this.call("POST", `/v1/sessions/${sessionId}/answers`, {
        request_id: request.request_id,
        kind: "permission",
        action: "allow",
      });
    }
  }

  /** Controls that name the session's revision: pause, terminate, resume. */
  async control(
    sessionId: string,
    operation: "pause" | "resume" | "terminate",
  ): Promise<Timed> {
    const session = await this.session(sessionId);
    const revision = Number(session?.revision ?? 0);
    return this.call("POST", `/v1/sessions/${sessionId}/${operation}`, {
      expected_revision: revision,
      ...(operation === "resume" ? {} : { reason: "94S-135 soak probe" }),
    });
  }

  interrupt(sessionId: string, turnId: string): Promise<Timed> {
    return this.call("POST", `/v1/sessions/${sessionId}/interrupt`, {
      target_turn_id: turnId,
    });
  }

  /** The last event id read per session, so a stream replays only what is new. */
  private readonly cursors = new Map<string, string>();

  /**
   * Reads the session's event stream until a `status` event with `phase`
   * for `turnId` arrives, and answers the host time it was read (null:
   * `signal` aborted first, or the API refused the stream for good). The
   * stream opens from the last id this Api read for the session, so each
   * probe replays only the turns since the one before it, and a stream the
   * API closes or turns away for now is reopened from there: the event is
   * durable, so it is read late, never lost.
   */
  async statusPhase(
    sessionId: string,
    turnId: string,
    phase: string,
    signal: AbortSignal,
  ): Promise<number | null> {
    while (!signal.aborted) {
      const at = await this.readPhase(sessionId, turnId, phase, signal);
      if (at !== undefined) return at;
      await Bun.sleep(100);
    }
    return null;
  }

  /** One stream: when `phase` was read, null if it never can be, else undefined. */
  private async readPhase(
    sessionId: string,
    turnId: string,
    phase: string,
    signal: AbortSignal,
  ): Promise<number | null | undefined> {
    const after = this.cursors.get(sessionId);
    let response: Response;
    try {
      response = await fetch(`${this.base}/v1/sessions/${sessionId}/events`, {
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${this.key}`,
          ...(after === undefined ? {} : { "last-event-id": after }),
        },
        signal,
      });
    } catch {
      return undefined;
    }
    const reader = response.body?.getReader();
    if (response.status !== 200 || reader === undefined) {
      await reader?.cancel().catch(() => {});
      // Other probes holding the owner's streams (8), or a server error, are
      // worth another try; anything else would be refused the same way.
      return response.status === 429 || response.status >= 500
        ? undefined
        : null;
    }
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return undefined;
        buffered += decoder.decode(chunk.value, { stream: true });
        let end = buffered.indexOf("\n\n");
        while (end !== -1) {
          const frame = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);
          end = buffered.indexOf("\n\n");
          const field = (name: string) =>
            frame
              .split("\n")
              .find((line) => line.startsWith(`${name}:`))
              ?.slice(name.length + 1)
              .trim();
          const id = field("id");
          if (id) this.cursors.set(sessionId, id);
          if (field("event") !== "status") continue;
          let envelope: { turn_id?: unknown; data?: { phase?: unknown } };
          try {
            envelope = JSON.parse(field("data") ?? "");
          } catch {
            continue;
          }
          if (envelope.turn_id === turnId && envelope.data?.phase === phase) {
            return Date.now();
          }
        }
      }
    } catch {
      return undefined;
    } finally {
      reader.cancel().catch(() => {});
    }
  }
}

// ---------------------------------------------------------------- model

export class Model {
  constructor(private readonly base: string) {}

  /** Host clock minus the model's (the containers') clock. */
  offset(): Promise<{ offsetMs: number; rttMs: number }> {
    return clockOffset(this.base);
  }

  async setFaults(faults: MessagesFaults): Promise<void> {
    const response = await fetch(`${this.base}/faults`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(faults),
    });
    if (!response.ok) {
      throw new Error(`faults ${response.status} ${await response.text()}`);
    }
  }

  async requests(
    filter: { since?: number; spec?: string } = {},
  ): Promise<RequestSummary[]> {
    const query = new URLSearchParams();
    if (filter.since !== undefined) query.set("since", String(filter.since));
    if (filter.spec !== undefined) query.set("spec", filter.spec);
    const response = await fetch(`${this.base}/requests?${query}`, {
      signal: AbortSignal.timeout(30_000),
    });
    return (await response.json()) as RequestSummary[];
  }

  /** Waits until the engine has asked for `step` of the spec (it is mid-turn). */
  async reached(
    spec: string,
    step: number,
    timeoutMs: number,
  ): Promise<RequestSummary | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // An injected error answers at once, so only a clean request is
      // one the engine is still waiting on.
      const found = (await this.requests({ spec })).find(
        (entry) => (entry.step ?? -1) >= step && entry.fault === null,
      );
      if (found) return found;
      await Bun.sleep(200);
    }
    return null;
  }
}

// ---------------------------------------------------------------- scripted turns

export type TurnKind = "normal" | "interrupt" | "terminate";

/**
 * A turn the soak Messages API plays back. Every turn writes a file (so it
 * has a workspace change to checkpoint), and a probe turn holds its second
 * model call `slowStepMs`, which is the window the probe acts in.
 */
export function turnPrompt(input: {
  id: string;
  kind: TurnKind;
  slowStepMs: number;
  stepDelayMs: number;
  slot: number;
}): string {
  const file = `soak/${input.slot}.txt`;
  const steps: Step[] = [
    { ...write(file, `${input.id}\n`), delayMs: input.stepDelayMs },
    {
      ...write(`${file}.done`, `${input.id}\n`),
      delayMs: input.kind === "normal" ? input.stepDelayMs : input.slowStepMs,
    },
  ];
  return prompt(`94S-135 soak turn ${input.id}.`, {
    id: input.id,
    steps,
    final: `soak turn ${input.id} done`,
    finalDelayMs: input.stepDelayMs,
  });
}

/** Polls the turn until it ends; null when it did not within the budget. */
export async function settle(
  api: Api,
  sessionId: string,
  turnId: string,
  options: { pollMs: number; timeoutMs: number },
): Promise<{ at: number; turn: Record<string, unknown> } | null> {
  const deadline = Date.now() + options.timeoutMs;
  let polls = 0;
  while (Date.now() < deadline) {
    const turn = await api.turn(sessionId, turnId);
    const status = String(turn?.status ?? "");
    if (turn && TERMINAL_TURN.has(status)) return { at: Date.now(), turn };
    if (status === "needs_input" || polls++ % 5 === 0) {
      await api.allowPending(sessionId);
    }
    await Bun.sleep(options.pollMs);
  }
  return null;
}

/** Polls a receipt until it leaves `accepted`. */
export async function settleReceipt(
  api: Api,
  receiptId: string,
  options: { pollMs: number; timeoutMs: number },
): Promise<{ at: number; receipt: Record<string, unknown> } | null> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await api.receipt(receiptId);
    if (receipt && receipt.status !== OPEN_RECEIPT) {
      return { at: Date.now(), receipt };
    }
    await Bun.sleep(options.pollMs);
  }
  return null;
}

// ---------------------------------------------------------------- measurements

export type ControlSample = {
  acceptStatus: number;
  /** POST round trip: the accepted response time. */
  acceptedMs: number;
  /**
   * POST sent → the effect observed by the runner (null: not within the
   * budget). For an interrupt that is the SSE read; P-3 judges the worker's
   * own engine_stopped time where its log has one.
   */
  effectMs: number | null;
  effect: string | null;
  op: "interrupt" | "terminate" | "pause" | "resume";
  receiptId: string | null;
  receiptMs: number | null;
  receiptStatus: string | null;
  sessionId: string;
  turnId: string | null;
  extra?: Record<string, unknown>;
};

/**
 * Interrupts a turn that is waiting on its slow model call. The effect is
 * the engine having stopped the turn: its `status{phase:"engine_stopped"}`
 * event read off the session's stream. The turn reaching a
 * terminal status (polled every `pollMs`) is timed apart as `terminalMs`,
 * since it waits on the checkpoint, and so is the receipt. `continued` says
 * whether the engine asked the model for anything after the interrupt was
 * accepted — it should not have.
 *
 * A sample is `valid` only when the slow call was pending when the
 * interrupt went out, the API accepted it (202), and the settled receipt
 * says the interrupt ended the turn (`no_op` false): otherwise a turn that
 * ended on its own would read as a fast interrupt.
 */
export async function interruptProbe(
  api: Api,
  model: Model,
  input: {
    budgetMs: number;
    pollMs: number;
    sessionId: string;
    /** How long the scripted model holds the slow call's answer. */
    slowStepMs: number;
    specId: string;
    turnId: string;
  },
): Promise<ControlSample> {
  const reached = await model.reached(input.specId, 1, 120_000);
  const clock = await model.offset();
  // Open before the POST, so the event cannot land ahead of the reader.
  const watching = new AbortController();
  const stopped = api.statusPhase(
    input.sessionId,
    input.turnId,
    "engine_stopped",
    watching.signal,
  );
  const posted = await api.interrupt(input.sessionId, input.turnId);
  const budget = setTimeout(
    () => watching.abort(),
    Math.max(0, posted.sentAt + input.budgetMs - Date.now()),
  );
  // The slow call is answered `latencyMs + slowStepMs` after it arrived, on
  // the model's clock. The interrupt counts only if the API had accepted it
  // before then — the latest the acceptance can have happened, moved onto
  // that clock, with the clock reading's own uncertainty added.
  const pendingUntil = reached
    ? Date.parse(reached.at) + reached.latencyMs + input.slowStepMs
    : null;
  const acceptedBy =
    posted.sentAt + posted.ms - clock.offsetMs + Math.ceil(clock.rttMs / 2);
  const pending = pendingUntil !== null && acceptedBy < pendingUntil;
  const receiptId =
    ((posted.body ?? {}) as { receipt_id?: string }).receipt_id ?? null;
  let terminalMs: number | null = null;
  let effect: string | null = null;
  let receiptMs: number | null = null;
  let receiptStatus: string | null = null;
  let receiptResult: unknown = null;
  const deadline = posted.sentAt + input.budgetMs;
  while (Date.now() < deadline && (terminalMs === null || receiptMs === null)) {
    if (terminalMs === null) {
      const turn = await api.turn(input.sessionId, input.turnId);
      const status = String(turn?.status ?? "");
      if (TERMINAL_TURN.has(status)) {
        terminalMs = Date.now() - posted.sentAt;
        effect = status;
      }
    }
    if (receiptMs === null && receiptId) {
      const receipt = await api.receipt(receiptId);
      if (receipt && receipt.status !== OPEN_RECEIPT) {
        receiptMs = Date.now() - posted.sentAt;
        receiptStatus = String(receipt.status);
        receiptResult = receipt.result ?? null;
      }
    }
    await Bun.sleep(input.pollMs);
  }
  // An interrupt the engine never acknowledged has no event to wait for; one
  // it did was read long before its turn could settle.
  if (terminalMs !== null && effect !== "interrupted") watching.abort();
  const at = await stopped;
  clearTimeout(budget);
  watching.abort();
  // With the reading before the POST, brackets the engine_stopped log line.
  const clockAfter = await model.offset().catch(() => null);
  const effectMs = at === null ? null : at - posted.sentAt;
  const noOp = (receiptResult as { no_op?: boolean } | null)?.no_op ?? null;
  const after = (await model.requests({ spec: input.specId })).filter(
    (entry) =>
      Date.parse(entry.at) > posted.sentAt + posted.ms &&
      (entry.step ?? 0) >= 2,
  );
  return {
    op: "interrupt",
    sessionId: input.sessionId,
    turnId: input.turnId,
    acceptStatus: posted.status,
    acceptedMs: posted.ms,
    effectMs,
    effect,
    receiptId,
    receiptMs,
    receiptStatus,
    extra: {
      reachedSlowStep: reached !== null,
      sentAt: new Date(posted.sentAt).toISOString(),
      // Place the worker's engine_stopped log line on this clock.
      clockOffsetMs: clock.offsetMs,
      clockRttMs: clock.rttMs,
      clockAfterOffsetMs: clockAfter?.offsetMs ?? null,
      clockAfterRttMs: clockAfter?.rttMs ?? null,
      slowPendingUntil:
        pendingUntil === null ? null : new Date(pendingUntil).toISOString(),
      acceptedBy: new Date(acceptedBy).toISOString(),
      terminalMs,
      continuedAfterInterrupt: after.length,
      receiptResult,
      valid: pending && posted.status === 202 && noOp === false,
    },
  };
}

/**
 * Terminates a session mid-turn. Confirmed means the receipt settled
 * (succeeded or unknown) and no worker
 * container of the session is still running; the effect time is when both
 * held. A receipt that says succeeded while a worker still runs is
 * reported (`succeededWhileRunning`).
 */
export async function terminateProbe(
  api: Api,
  model: Model,
  input: {
    budgetMs: number;
    installation: string;
    pollMs: number;
    sessionId: string;
    specId: string | null;
    turnId: string | null;
  },
): Promise<ControlSample> {
  const reached = input.specId
    ? await model.reached(input.specId, 1, 120_000)
    : null;
  const posted = await api.control(input.sessionId, "terminate");
  const receiptId =
    ((posted.body ?? {}) as { receipt_id?: string }).receipt_id ?? null;
  let receiptMs: number | null = null;
  let receiptStatus: string | null = null;
  let goneMs: number | null = null;
  let succeededWhileRunning = false;
  let dockerFailures = 0;
  const deadline = posted.sentAt + input.budgetMs;
  // Gone is an observation that no worker runs; it is dropped again if a
  // later look finds one, and a failed look observes nothing either way.
  while (Date.now() < deadline && (receiptMs === null || goneMs === null)) {
    let running: string[] | null = null;
    try {
      running =
        (await runningWorkers(input.installation)).get(input.sessionId) ?? [];
    } catch {
      dockerFailures++;
    }
    if (running !== null) {
      if (running.length > 0) goneMs = null;
      else if (goneMs === null) goneMs = Date.now() - posted.sentAt;
    }
    if (receiptMs === null && receiptId && running !== null) {
      const receipt = await api.receipt(receiptId);
      if (receipt && receipt.status !== OPEN_RECEIPT) {
        receiptMs = Date.now() - posted.sentAt;
        receiptStatus = String(receipt.status);
        if (receiptStatus === "succeeded" && running.length > 0) {
          succeededWhileRunning = true;
        }
      }
    }
    await Bun.sleep(input.pollMs);
  }
  const confirmed =
    receiptStatus === "succeeded" || receiptStatus === "unknown";
  return {
    op: "terminate",
    sessionId: input.sessionId,
    turnId: input.turnId,
    acceptStatus: posted.status,
    acceptedMs: posted.ms,
    effectMs:
      confirmed && receiptMs !== null && goneMs !== null
        ? Math.max(receiptMs, goneMs)
        : null,
    effect: receiptStatus,
    receiptId,
    receiptMs,
    receiptStatus,
    extra: {
      containerGoneMs: goneMs,
      dockerFailures,
      reachedSlowStep: input.specId ? reached !== null : null,
      succeededWhileRunning,
      valid:
        posted.status === 202 && (input.specId === null || reached !== null),
    },
  };
}

/** Pause or resume, timed to the receipt settling. */
export async function admissionProbe(
  api: Api,
  input: {
    budgetMs: number;
    op: "pause" | "resume";
    pollMs: number;
    sessionId: string;
  },
): Promise<ControlSample> {
  const posted = await api.control(input.sessionId, input.op);
  const receiptId =
    ((posted.body ?? {}) as { receipt_id?: string }).receipt_id ?? null;
  const settled = receiptId
    ? await settleReceipt(api, receiptId, {
        pollMs: input.pollMs,
        timeoutMs: input.budgetMs,
      })
    : null;
  const receiptMs = settled ? settled.at - posted.sentAt : null;
  const receiptStatus = settled ? String(settled.receipt.status) : null;
  return {
    op: input.op,
    sessionId: input.sessionId,
    turnId: null,
    acceptStatus: posted.status,
    acceptedMs: posted.ms,
    effectMs: receiptStatus === "succeeded" ? receiptMs : null,
    effect: receiptStatus,
    receiptId,
    receiptMs,
    receiptStatus,
    extra: {
      body: posted.status === 202 ? undefined : posted.body,
      error: settled?.receipt.error ?? null,
    },
  };
}

export type StartupSample = {
  acceptedToClaimMs: number | null;
  acceptedToReadyMs: number | null;
  attemptId: string | null;
  claimToReadyMs: number | null;
  /** The turn row's own flag; the public API only shows it as a status. */
  outcomeUnknown: boolean | null;
  /** cold: the attempt that ran the turn claimed after it was accepted. */
  temperature: "cold" | "warm" | "unknown";
};

/**
 * accepted → claim → SDK ready for one turn, all on the container clock:
 * accepted is the turn row's creation, claim the attempt's start, and SDK
 * ready the first model request the engine made for the turn's spec.
 */
export async function startupSample(
  db: Pool,
  model: Model,
  input: { sessionId: string; specId: string; turnId: string },
): Promise<StartupSample> {
  const { rows } = await db.query(
    `SELECT t.created_at, t.attempt_id, t.outcome_unknown, a.started_at AS claimed_at
       FROM turns t LEFT JOIN attempts a ON a.id = t.attempt_id
      WHERE t.session_id = $1 AND t.sequence::text = $2`,
    [input.sessionId, input.turnId],
  );
  const row = rows[0] as
    | {
        attempt_id: string | null;
        claimed_at: Date | null;
        created_at: Date;
        outcome_unknown: boolean;
      }
    | undefined;
  const first = (await model.requests({ spec: input.specId }))[0];
  const accepted = row?.created_at?.getTime() ?? null;
  const claimed = row?.claimed_at?.getTime() ?? null;
  const ready = first ? Date.parse(first.at) : null;
  const diff = (a: number | null, b: number | null) =>
    a === null || b === null ? null : b - a;
  return {
    attemptId: row?.attempt_id ?? null,
    outcomeUnknown: row?.outcome_unknown ?? null,
    temperature:
      accepted === null || claimed === null
        ? "unknown"
        : claimed > accepted
          ? "cold"
          : "warm",
    acceptedToClaimMs:
      claimed !== null && accepted !== null && claimed > accepted
        ? claimed - accepted
        : null,
    claimToReadyMs:
      claimed !== null && accepted !== null && claimed > accepted
        ? diff(claimed, ready)
        : null,
    acceptedToReadyMs: diff(accepted, ready),
  };
}

/**
 * accepted → claim → ready for a resume out of `paused`, on the container
 * clock: accepted is the resume receipt's creation, claim the first attempt
 * of the session after it, and ready the worker's `/ready` report through
 * the fault injector — sent once the checkpoint is restored and the resumed
 * engine is initialized (worker-host reportReady).
 */
export async function resumeStartup(
  db: Pool,
  chaosUrl: string,
  input: { receiptId: string; sessionId: string },
): Promise<StartupSample> {
  const { rows } = await db.query(
    `SELECT r.created_at, a.id AS attempt_id, a.started_at AS claimed_at
       FROM receipts r
       LEFT JOIN LATERAL (
         SELECT id, started_at FROM attempts
          WHERE session_id = $2 AND started_at > r.created_at
          ORDER BY started_at LIMIT 1
       ) a ON true
      WHERE r.id = $1`,
    [input.receiptId, input.sessionId],
  );
  const row = rows[0] as
    | { attempt_id: string | null; claimed_at: Date | null; created_at: Date }
    | undefined;
  const accepted = row?.created_at?.getTime() ?? null;
  const claimed = row?.claimed_at?.getTime() ?? null;
  const log = (await (
    await fetch(`${chaosUrl}/log?session=${input.sessionId}`, {
      signal: AbortSignal.timeout(30_000),
    })
  ).json()) as Array<{ at: string; path: string; status: number }>;
  const ready = log.find(
    (entry) =>
      entry.path.endsWith("/internal/worker/ready") &&
      entry.status === 200 &&
      claimed !== null &&
      Date.parse(entry.at) >= claimed,
  );
  const readyAt = ready ? Date.parse(ready.at) : null;
  const diff = (a: number | null, b: number | null) =>
    a === null || b === null ? null : b - a;
  return {
    attemptId: row?.attempt_id ?? null,
    outcomeUnknown: null,
    temperature: claimed === null ? "unknown" : "cold",
    acceptedToClaimMs: diff(accepted, claimed),
    claimToReadyMs: diff(claimed, readyAt),
    acceptedToReadyMs: diff(accepted, readyAt),
  };
}

/**
 * What the turn's model calls say: whether the conversation still carried
 * the previous completed turn (no silent context reset), and how many times
 * the model was asked to start the turn and answered (more than once is the
 * turn run twice).
 */
export function modelEvidence(
  requests: readonly RequestSummary[],
  previousSpec: string | null,
): { contextKept: boolean | null; startsAnswered: number; faults: number } {
  const first = requests[0];
  return {
    contextKept:
      previousSpec === null || first === undefined
        ? null
        : first.specs.includes(previousSpec),
    startsAnswered: requests.filter(
      (entry) => entry.step === 0 && entry.fault === null,
    ).length,
    faults: requests.filter((entry) => entry.fault !== null).length,
  };
}
