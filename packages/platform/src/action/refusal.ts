import {
  ACTION_REFUSAL_CODES,
  type ActionRefusal,
  type ActionRefusalCode,
  type GitHubMcpTool,
  githubMcpRefusalSpec,
} from "@werft-ai/contracts";
import type { SessionServiceError } from "../sessions/index.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A refusal of a code the tool lists, with the `by` and `retryable` it fixes. */
export function refusalOf(
  tool: GitHubMcpTool,
  code: ActionRefusalCode,
  details?: Record<string, unknown>,
): ActionRefusal {
  const fixed = githubMcpRefusalSpec(tool, code) ?? ACTION_REFUSAL_CODES[code];
  return {
    code,
    by: fixed.by,
    retryable: fixed.retryable,
    ...(details === undefined || Object.keys(details).length === 0
      ? {}
      : { details }),
  };
}

/** What a person wrote when they rejected the push request a call names. */
export type PersonRejection = { pushRequestId: string; reason: string | null };

/**
 * The refusal a service error stands for (catalog 5.7, "서비스 오류를 봉투로
 * 옮기는 순서"):
 * 1. the service's refusal (`details.refusal`) when the tool lists it;
 * 2. else its `details.reason_code` when the tool lists it;
 * 3. else the service code in lower case: listed codes keep their table
 *    entry, `BACKEND_UNAVAILABLE` and `GITHUB_REFUSED` are GitHub's, and any
 *    other is the platform's and final.
 * A pull request call refused as `not_pushed` on a push request a person
 * rejected is that person's refusal, and their words ride in
 * `details.reason`; one that failed is `push_failed`.
 */
export function refusalFromServiceError(
  tool: GitHubMcpTool,
  error: SessionServiceError,
  rejection: PersonRejection | null = null,
): ActionRefusal {
  const raw = isRecord(error.details) ? error.details : {};
  const { refusal: serviceRefusal, ...rest } = raw;
  const state = raw.push_request_state;
  if (serviceRefusal === "not_pushed" && state === "rejected") {
    return refusalOf(tool, "push_rejected", {
      ...rest,
      ...(rejection === null
        ? {}
        : {
            push_request_id: rejection.pushRequestId,
            ...(rejection.reason === null ? {} : { reason: rejection.reason }),
          }),
    });
  }
  if (serviceRefusal === "not_pushed" && state === "failed") {
    return refusalOf(tool, "push_failed", rest);
  }
  const listed = [serviceRefusal, raw.reason_code, error.code.toLowerCase()];
  for (const code of listed) {
    if (githubMcpRefusalSpec(tool, code) !== null) {
      return refusalOf(tool, code as ActionRefusalCode, rest);
    }
  }
  return {
    code: error.code.toLowerCase(),
    by: "platform",
    retryable: false,
    ...(Object.keys(rest).length === 0 ? {} : { details: rest }),
  };
}
