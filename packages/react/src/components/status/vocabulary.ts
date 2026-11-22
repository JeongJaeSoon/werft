import type {
  AdmissionState,
  ExecutionState,
  ReceiptStatus,
  SessionStatus,
  TurnStatus,
} from "@werft-ai/contracts";
import type { StatusDotStatus } from "@werft-ai/ui";

/**
 * session·admission·turn·receipt·execution are separate axes and are never merged into
 * one badge. A tone is a meaning; the hex lives in tokens.css.
 */
export const STATUS_AXIS_VALUES = [
  "session",
  "admission",
  "turn",
  "receipt",
  "execution",
] as const;
export type StatusAxis = (typeof STATUS_AXIS_VALUES)[number];

export const STATUS_TONE_VALUES = [
  "neutral",
  "progress",
  "attention",
  "caution",
  "danger",
  "unknown",
  "positive",
] as const;
export type StatusTone = (typeof STATUS_TONE_VALUES)[number];

export type StatusStateOf<A extends StatusAxis> = A extends "session"
  ? SessionStatus
  : A extends "admission"
    ? AdmissionState
    : A extends "turn"
      ? TurnStatus
      : A extends "receipt"
        ? ReceiptStatus
        : ExecutionState;

export interface StatusDescriptor {
  /** What a person reads. Korean operational copy, never uppercased. */
  readonly label: string;
  readonly tone: StatusTone;
  /** True while the platform is still moving; drives the spinner. */
  readonly inFlight: boolean;
}

/** The axis name a screen reader hears before the state. */
export const STATUS_AXIS_LABEL: Record<StatusAxis, string> = {
  session: "작업",
  admission: "세션",
  turn: "턴",
  receipt: "접수",
  execution: "실행",
};

/*
 * What the session is doing, as the session list reports it. `idle` is not a
 * finished turn: the session is open and waiting for the next message, so it
 * reads as rest, not success.
 */
const session: Record<SessionStatus, StatusDescriptor> = {
  queued: { label: "대기 중", tone: "neutral", inFlight: false },
  running: { label: "작업 중", tone: "progress", inFlight: true },
  needs_input: { label: "답변 대기", tone: "attention", inFlight: false },
  idle: { label: "쉬는 중", tone: "neutral", inFlight: false },
  failed: { label: "실패", tone: "danger", inFlight: false },
  stopped: { label: "멈춤", tone: "neutral", inFlight: false },
};

// An open session takes work; that is the state worth a colour.
const admission: Record<AdmissionState, StatusDescriptor> = {
  active: { label: "활성", tone: "positive", inFlight: false },
  pausing: { label: "일시 정지 중", tone: "caution", inFlight: true },
  paused: { label: "일시 정지됨", tone: "caution", inFlight: false },
  resuming: { label: "복원 중", tone: "progress", inFlight: true },
  stopping: { label: "종료 중", tone: "neutral", inFlight: true },
  stopped: { label: "종료됨", tone: "neutral", inFlight: false },
  recovery_required: {
    label: "확인 필요 — 결과를 알 수 없음",
    tone: "danger",
    inFlight: false,
  },
  closing: { label: "보관 중", tone: "neutral", inFlight: true },
  closed: { label: "보관됨", tone: "neutral", inFlight: false },
};

const turn: Record<TurnStatus, StatusDescriptor> = {
  queued: { label: "대기 중", tone: "neutral", inFlight: false },
  running: { label: "작업 중", tone: "progress", inFlight: true },
  needs_input: { label: "답변 대기", tone: "attention", inFlight: false },
  completed: { label: "완료", tone: "positive", inFlight: false },
  failed: { label: "실패", tone: "danger", inFlight: false },
  interrupted: { label: "중단됨", tone: "neutral", inFlight: false },
  cancelled: { label: "취소됨", tone: "neutral", inFlight: false },
  outcome_unknown: { label: "결과 미확정", tone: "unknown", inFlight: false },
};

/*
 * `accepted` is deliberately not positive: 접수와 완료를 구분한다. Only
 * `succeeded` — the server's own confirmation — earns the success tone.
 */
const receipt: Record<ReceiptStatus, StatusDescriptor> = {
  accepted: { label: "접수됨", tone: "progress", inFlight: true },
  succeeded: { label: "확정됨", tone: "positive", inFlight: false },
  failed: { label: "실패", tone: "danger", inFlight: false },
  unknown: { label: "결과 미확정", tone: "unknown", inFlight: false },
};

const execution: Record<ExecutionState, StatusDescriptor> = {
  pending: { label: "준비 중", tone: "neutral", inFlight: true },
  running: { label: "실행 중", tone: "progress", inFlight: true },
  suspended: { label: "멈춤", tone: "caution", inFlight: false },
  terminating: { label: "정리 중", tone: "neutral", inFlight: true },
  terminated: { label: "정리됨", tone: "neutral", inFlight: false },
  unknown: { label: "상태 미확인", tone: "unknown", inFlight: false },
};

export const STATUS_VOCABULARY = {
  session,
  admission,
  turn,
  receipt,
  execution,
} as const;

export function describeStatus<A extends StatusAxis>(
  axis: A,
  state: StatusStateOf<A>,
): StatusDescriptor {
  const axisVocabulary: Record<string, StatusDescriptor> =
    STATUS_VOCABULARY[axis];
  // `hasOwn`, not a plain lookup: the state comes from the server, and
  // "__proto__" would hand back Object.prototype — no label, no tone.
  if (Object.hasOwn(axisVocabulary, state)) {
    return axisVocabulary[state] as StatusDescriptor;
  }
  return {
    // A state the server added and this build has not learned yet: say so
    // rather than guessing a tone that might read as success.
    label: state,
    tone: "unknown",
    inFlight: false,
  };
}

// The dot's colour once the state stands still; a moving state turns the ring.
const TONE_DOT: Record<StatusTone, StatusDotStatus> = {
  attention: "wait",
  caution: "wait",
  progress: "run",
  positive: "done",
  danger: "failed",
  neutral: "idle",
  unknown: "idle",
};

/**
 * The dot every screen draws for a state, from its tone; no screen keeps a
 * table of its own. `stopped` is neutral, so it rests rather than reading
 * as a success: a stopped session can be resumed.
 */
export function statusDot<A extends StatusAxis>(
  axis: A,
  state: StatusStateOf<A>,
): StatusDotStatus {
  return TONE_DOT[describeStatus(axis, state).tone];
}
