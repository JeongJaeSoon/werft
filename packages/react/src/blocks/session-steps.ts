import {
  eventToolCall,
  type PendingRequest,
  type SessionDetail,
  TURN_WORKER_OWNERSHIP_LOST_REASON,
  type TurnSummary,
} from "@werft-ai/contracts";
import type { SessionEventFrame } from "../sessions.ts";

/**
 * Where one turn of the session stands. A turn is a step: the API has no plan,
 * so the steps are the instructions the session was given, in order.
 */
export type SessionStepState =
  | "queued"
  | "running"
  | "approval"
  | "answer"
  | "done"
  | "failed"
  | "cut_off"
  | "stopped"
  | "unknown";

export interface SessionStep {
  readonly turn: TurnSummary;
  /** 1 for the session's first turn. */
  readonly number: number;
  readonly state: SessionStepState;
  /** The open requests the turn asked, oldest first. */
  readonly requests: readonly PendingRequest[];
  /** Distinct tool calls among the events still in the window. */
  readonly toolCalls: number;
  /** The window may have dropped this turn's earlier events. */
  readonly toolCallsPartial: boolean;
}

export interface SessionSteps {
  readonly steps: readonly SessionStep[];
  /**
   * The step the session is on, else the one that stopped it (cut off, or
   * holding requests); null when the session rests on finished work.
   */
  readonly focus: number | null;
  /** `focus` is the turn the session runs now, not one that stopped it. */
  readonly current: boolean;
}

export interface ReadSessionStepsInput {
  readonly session: Pick<
    SessionDetail,
    "current_turn_id" | "status" | "pending_request_count"
  >;
  readonly turns: readonly TurnSummary[];
  readonly requests: readonly PendingRequest[];
  readonly events: readonly SessionEventFrame[];
  /** Epoch ms: a request past its `expires_at` no longer holds its turn. */
  readonly now: number;
  /**
   * The request list was read no earlier than the session: it is the truth
   * about open requests. Older, the session's own count speaks for requests
   * the list has not caught up with.
   */
  readonly listCurrent: boolean;
  /** The event window is at its cap, so its oldest events are gone. */
  readonly windowFull: boolean;
}

function stateOf(
  turn: TurnSummary,
  requests: readonly PendingRequest[],
  heldOpen: boolean,
): SessionStepState {
  // The list holds only requests still open, whatever the turn's status
  // says: a parked turn waits on them too.
  if (requests.some((request) => request.kind === "permission"))
    return "approval";
  if (requests.length > 0) return "answer";
  switch (turn.status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    // The turns and the request list are read apart, so either may lag: a
    // needs_input turn the list does not name waits only while it is the
    // session's current turn and a session read newer than the list counts
    // open requests.
    case "needs_input":
      return heldOpen ? "answer" : "running";
    case "completed":
      return "done";
    case "failed":
      return turn.terminal_reason === TURN_WORKER_OWNERSHIP_LOST_REASON
        ? "cut_off"
        : "failed";
    case "interrupted":
    case "cancelled":
      return "stopped";
    default:
      return "unknown";
  }
}

const OPEN_TURN: ReadonlySet<TurnSummary["status"]> = new Set([
  "queued",
  "running",
  "needs_input",
]);

export function readSessionSteps({
  session,
  turns,
  requests,
  events,
  windowFull,
  now,
  listCurrent,
}: ReadSessionStepsInput): SessionSteps {
  const calls = new Map<string, Set<string>>();
  for (const frame of events) {
    if (frame.turnId === null) continue;
    const { payload } = frame;
    if (payload.event !== "tool_use" && payload.event !== "assistant") continue;
    const call = eventToolCall(payload.data);
    if (call === null) continue;
    const seen = calls.get(frame.turnId) ?? new Set<string>();
    seen.add(call.id);
    calls.set(frame.turnId, seen);
  }
  // The oldest turn still in a full window may have lost its first calls;
  // events without a turn (control-plane ones) say nothing about that.
  const oldest = events.find((frame) => frame.turnId !== null)?.turnId ?? null;
  // A session read newer than the list that counts nothing open outdates
  // every request the list still holds.
  const listed =
    !listCurrent && session.pending_request_count === 0 ? [] : requests;
  const steps = turns.map((turn, index): SessionStep => {
    const own = listed.filter((request) => request.turn_id === turn.turn_id);
    const asked = own
      .filter((request) => Date.parse(request.expires_at) > now)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    // A turn whose requests are known to have lapsed is not held by a count
    // the session read before they did.
    // The count is the session's, so it can hold only the turn it runs.
    const heldOpen =
      !listCurrent &&
      session.pending_request_count > 0 &&
      turn.turn_id === session.current_turn_id &&
      own.length === asked.length;
    return {
      turn,
      number: index + 1,
      state: stateOf(turn, asked, heldOpen),
      requests: asked,
      toolCalls: calls.get(turn.turn_id)?.size ?? 0,
      toolCallsPartial: windowFull && oldest === turn.turn_id,
    };
  });
  // A turn already ended is no longer current, whatever a session read
  // before its end says.
  const running = steps.findIndex(
    (step) =>
      step.turn.turn_id === session.current_turn_id &&
      OPEN_TURN.has(step.turn.status),
  );
  if (running !== -1) return { steps, focus: running, current: true };
  const asking = steps.findIndex((step) => step.requests.length > 0);
  if (asking !== -1) return { steps, focus: asking, current: false };
  const last = steps.length - 1;
  const stopped =
    session.status === "idle" && steps[last]?.state === "cut_off" ? last : -1;
  return { steps, focus: stopped === -1 ? null : stopped, current: false };
}

/**
 * How long the turns have run, in milliseconds: each ended turn's span and
 * an open one's so far. The session sums its ended turns too, in a read that
 * may be older or newer than the turns', so the larger of the two stands and
 * the figure never runs back.
 */
export function sessionTime(
  session: Pick<SessionDetail, "turn_time_ms">,
  steps: SessionSteps,
  now: number,
): number {
  let fromTurns = 0;
  for (const { turn } of steps.steps) {
    if (turn.started_at === null) continue;
    const end = turn.ended_at === null ? now : Date.parse(turn.ended_at);
    fromTurns += Math.max(0, end - Date.parse(turn.started_at));
  }
  return Math.max(session.turn_time_ms, fromTurns);
}
