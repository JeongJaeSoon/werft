import {
  eventToolCall,
  isCutOffTurnReason,
  type PendingRequest,
  type SessionDetail,
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
  /**
   * The turns were read no earlier than the session. Older, a turn they
   * show open that the session no longer runs has ended since.
   */
  readonly turnsCurrent: boolean;
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
      return isCutOffTurnReason(turn.terminal_reason) ? "cut_off" : "failed";
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

/** A turn in these runs on a worker; a queued one has not started. */
const LIVE_TURN: ReadonlySet<TurnSummary["status"]> = new Set([
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
  turnsCurrent,
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
  // An event can say a turn's Slack source was deleted before the turns
  // read does; its instruction is withheld from then on.
  const deleted = new Map<string, string>();
  for (const frame of events)
    if (frame.sourceDeletedAt !== undefined && frame.turnId !== null)
      deleted.set(frame.turnId, frame.sourceDeletedAt);
  // A session read newer than the list that counts nothing open outdates
  // every request the list still holds.
  const listed =
    !listCurrent && session.pending_request_count === 0 ? [] : requests;
  const steps = turns.map((read, index): SessionStep => {
    const deletedAt = deleted.get(read.turn_id);
    const turn =
      deletedAt === undefined || read.source_deleted_at
        ? read
        : { ...read, message: "", source_deleted_at: deletedAt };
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
    const ended =
      !turnsCurrent &&
      LIVE_TURN.has(turn.status) &&
      turn.turn_id !== session.current_turn_id;
    return {
      turn,
      number: index + 1,
      state:
        ended && asked.length === 0
          ? "unknown"
          : stateOf(turn, asked, heldOpen),
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
  // A turns read newer than the session may show the turn it runs next.
  const live = turnsCurrent
    ? steps.findIndex((step) => LIVE_TURN.has(step.turn.status))
    : -1;
  if (live !== -1) return { steps, focus: live, current: true };
  const asking = steps.findIndex((step) => step.requests.length > 0);
  if (asking !== -1) return { steps, focus: asking, current: false };
  // One cancelled before it ran (an emergency stop's) leaves the turn before
  // it the last.
  let last = steps.length - 1;
  while (steps[last]?.turn.status === "cancelled") last -= 1;
  const stopped =
    session.status === "idle" && steps[last]?.state === "cut_off" ? last : -1;
  return { steps, focus: stopped === -1 ? null : stopped, current: false };
}

/**
 * The session and its turns name different running turns, or count
 * different queued ones: one read is behind the other. Each lands when its response does, not when the server
 * answered it, so only reading both again tells which.
 */
export function readsDisagree(
  session: Pick<SessionDetail, "current_turn_id" | "queued_turn_count">,
  turns: readonly TurnSummary[],
): boolean {
  const currentTurnId = session.current_turn_id;
  const queued = turns.filter((turn) => turn.status === "queued").length;
  if (queued !== session.queued_turn_count) return true;
  const named = turns.find((turn) => turn.turn_id === currentTurnId);
  if (currentTurnId !== null && !(named && OPEN_TURN.has(named.status)))
    return true;
  return turns.some(
    (turn) => LIVE_TURN.has(turn.status) && turn.turn_id !== currentTurnId,
  );
}

/**
 * How long the turns have run, in milliseconds. The session sums its ended
 * turns, and so do the turns read with the current turn's time so far; the
 * two reads lag each other either way, so the larger stands. A turn still
 * open in the turns read but no longer current to the session has ended
 * there, and only the session's sum knows how long it took.
 */
export function sessionTime(
  session: Pick<SessionDetail, "turn_time_ms">,
  steps: SessionSteps,
  now: number,
): number {
  const current = steps.current ? steps.focus : null;
  let fromTurns = 0;
  steps.steps.forEach(({ turn }, index) => {
    if (turn.started_at === null) return;
    const end =
      turn.ended_at !== null
        ? Date.parse(turn.ended_at)
        : index === current
          ? now
          : null;
    if (end !== null)
      fromTurns += Math.max(0, end - Date.parse(turn.started_at));
  });
  return Math.max(session.turn_time_ms, fromTurns);
}
