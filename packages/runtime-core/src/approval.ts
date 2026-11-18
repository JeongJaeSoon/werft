import { createHash } from "node:crypto";
import {
  canonicalJson,
  type PendingQuestion,
  type QuestionAnswer,
} from "@werft-ai/contracts";

/**
 * A rule the engine proposed to keep allowing for the session, as people see
 * it: the run's redacted copy, never what the engine gets back.
 */
export type RememberRule = { toolName: string; ruleContent?: string };

/**
 * `tool.input` is what the engine will act on; `display` and `questions` are
 * the run's redacted copy for people to see, which the host shows as it is.
 * `rememberOffer` is the allow rules the engine proposed and the run kept (it
 * drops the rest); absent, the request cannot be allowed for the session.
 */
export type ApprovalRequested = {
  /** Minted by the run, fresh per request: an engine-side id can come round again. */
  localId: string;
  toolCallId: string;
  tool: { name: string; input: unknown };
  inputHash: string;
  /**
   * `performance.now()` when the engine asked. A host waiting for the tool
   * call to be stored counts from here, so the run's own wait for that call
   * is not counted twice.
   */
  askedAt: number;
} & (
  | {
      kind: "permission";
      display: Record<string, unknown>;
      rememberOffer?: readonly RememberRule[];
      /** The run hands an allow's `message` to the model; absent, a host refuses one. */
      acceptsNote?: true;
    }
  | {
      kind: "question";
      /** Ids are the run's own; an answer names them, never the engine's text. */
      questions: PendingQuestion[];
    }
);

/**
 * Why a request ended without a person's choice. `expired` is a question
 * nobody answered in time; `refused` is an answer, or a request, the host
 * could not accept.
 */
export type CancelReason =
  | "park"
  | "shutdown"
  | "interrupt"
  | "expired"
  | "refused";

/**
 * `message` is what the engine is told on a refusal; absent, the run says
 * something for the reason. On an allow it is the approver's instruction,
 * which the model is given once the call has run. `remember` on an allow keeps the offered rules
 * for the session: `rules` are the ones the person agreed to, and the run
 * installs a rule only if the engine's offer is still exactly those (a
 * resumed turn asks again, and may offer something else).
 */
export type ApprovalAnswer =
  | {
      localId: string;
      inputHash: string;
      kind: "selected";
      optionKind: "allow_once";
      remember?: { scope: "session"; rules: readonly RememberRule[] };
      message?: string;
    }
  | {
      localId: string;
      inputHash: string;
      kind: "selected";
      optionKind: "reject_once";
      message?: string;
    }
  | {
      localId: string;
      inputHash: string;
      kind: "answered";
      answers: readonly QuestionAnswer[];
    }
  | {
      localId: string;
      inputHash: string;
      kind: "cancelled";
      reason: CancelReason;
      message?: string;
    };

type WithoutIds<T> = T extends unknown
  ? Omit<T, "localId" | "inputHash">
  : never;

/** An answer before it is addressed to a request. */
export type ApprovalDecisionPayload = WithoutIds<ApprovalAnswer>;

/** `stale`: already settled, or for other arguments. `unknown`: never asked. */
export type AnswerResult = "applied" | "stale" | "unknown";

/** The engine withdrew the request itself: its call was aborted. */
export type ApprovalOutcome = "withdrawn";

/**
 * Over the arguments the engine will act on, before any redaction: an
 * approval is for exactly these, and a display copy cannot tell apart two
 * calls that differ only in a redacted value. Throws for arguments that are
 * not JSON.
 */
export function approvalInputHash(tool: string, input: unknown): string {
  return createHash("sha256")
    .update(canonicalJson({ tool, input }))
    .digest("hex");
}

type Waiting = {
  inputHash: string;
  settle: (answer: ApprovalAnswer) => void;
};

/**
 * The run's side of its open approvals: each request is settled exactly once,
 * by the first answer that fits it, by its call's abort, or by `cancelAll`.
 */
export class ApprovalChannel {
  private readonly waiting = new Map<string, Waiting>();
  private readonly settled = new Set<string>();
  get open(): number {
    return this.waiting.size;
  }

  /** Resolves with the answer that settles it; an abort settles it as an interrupt. */
  request(
    request: ApprovalRequested,
    signal: AbortSignal,
  ): Promise<ApprovalAnswer> {
    if (
      this.waiting.has(request.localId) ||
      this.settled.has(request.localId)
    ) {
      throw new Error(`Approval ${request.localId} was already requested`);
    }
    return new Promise<ApprovalAnswer>((resolve) => {
      const onAbort = () =>
        this.settle(request.localId, {
          localId: request.localId,
          inputHash: request.inputHash,
          kind: "cancelled",
          reason: "interrupt",
        });
      this.waiting.set(request.localId, {
        inputHash: request.inputHash,
        settle: (answer) => {
          signal.removeEventListener("abort", onAbort);
          resolve(answer);
        },
      });
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  answer(answer: ApprovalAnswer): AnswerResult {
    const waiting = this.waiting.get(answer.localId);
    if (waiting === undefined) {
      return this.settled.has(answer.localId) ? "stale" : "unknown";
    }
    if (waiting.inputHash !== answer.inputHash) return "stale";
    this.settle(answer.localId, answer);
    return "applied";
  }

  cancelAll(reason: CancelReason, message?: string): void {
    for (const [localId, waiting] of [...this.waiting]) {
      this.settle(localId, {
        localId,
        inputHash: waiting.inputHash,
        kind: "cancelled",
        reason,
        ...(message === undefined ? {} : { message }),
      });
    }
  }

  private settle(localId: string, answer: ApprovalAnswer): void {
    const waiting = this.waiting.get(localId);
    if (waiting === undefined) return;
    this.waiting.delete(localId);
    this.settled.add(localId);
    waiting.settle(answer);
  }
}
