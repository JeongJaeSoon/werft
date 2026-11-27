import type { components } from "@werft-ai/client";
import type { MessageKey } from "../../../i18n/i18n.tsx";

type Reason =
  components["schemas"]["GetSlackJudgmentsResponse"]["recent"][number]["reason"];

export const REASON_LABEL = {
  not_for_agent: "slack.judgments.reason.not_for_agent",
  human_conversation: "slack.judgments.reason.human_conversation",
  already_handled: "slack.judgments.reason.already_handled",
  out_of_scope: "slack.judgments.reason.out_of_scope",
  needs_agent: "slack.judgments.reason.needs_agent",
  unclear: "slack.judgments.reason.unclear",
  invalid_target: "slack.judgments.reason.invalid_target",
  budget_refused: "slack.judgments.reason.budget_refused",
  concurrency_limited: "slack.judgments.reason.concurrency_limited",
  rate_limited: "slack.judgments.reason.rate_limited",
  input_too_large: "slack.judgments.reason.input_too_large",
  no_active_release: "slack.judgments.reason.no_active_release",
  model_unavailable: "slack.judgments.reason.model_unavailable",
  timed_out: "slack.judgments.reason.timed_out",
  unreachable: "slack.judgments.reason.unreachable",
  provider_error: "slack.judgments.reason.provider_error",
  malformed: "slack.judgments.reason.malformed",
} as const satisfies Record<Reason, MessageKey>;

export type JudgmentReason = keyof typeof REASON_LABEL;

/** A reason in the URL's query, or undefined for anything else. */
export function judgmentReasonOf(value: unknown): JudgmentReason | undefined {
  return typeof value === "string" && Object.hasOwn(REASON_LABEL, value)
    ? (value as JudgmentReason)
    : undefined;
}
