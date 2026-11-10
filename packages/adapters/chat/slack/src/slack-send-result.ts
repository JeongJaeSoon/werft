// Slack reports most send failures as HTTP 200 with `ok: false`, and only some
// of them can clear on a retry. The vocabulary and rules follow Kollegium
// packages/slack/src/web-api.ts (d387c73, :21-45 and :76-180).

/** Errors no retry clears. Anything else is treated as transient. */
export const SLACK_PERMANENT_SEND_ERRORS: ReadonlySet<string> = new Set([
  "account_inactive",
  "channel_not_found",
  "invalid_auth",
  "invalid_blocks",
  "invalid_blocks_format",
  "is_archived",
  "missing_scope",
  "msg_too_long",
  "msg_blocks_too_long",
  "no_permission",
  "not_in_channel",
  "restricted_action",
  "token_revoked",
]);

export const SLACK_SEND_MAX_ATTEMPTS = 5;

const DEFAULT_RETRY_AFTER_SECONDS = 1;

export type SlackSendResultInput = {
  httpStatus: number;
  retryAfterHeader: string | null;
  /** The parsed JSON body, or null when there was none or it did not parse. */
  body: unknown;
  /** Attempts made so far, this one included. */
  attempts: number;
};

export type SlackSendOutcome =
  | { kind: "sent"; ts: string }
  | { kind: "retry_after"; waitMs: number }
  | { kind: "retry"; code: string }
  | { kind: "failed"; code: string };

function retryAfterMs(header: string | null): number {
  // Retry-After is a count of whole seconds; Number() alone would also take
  // hex, exponents and values that overflow once turned into milliseconds.
  const trimmed = header?.trim() ?? "";
  const seconds = /^\d+$/.test(trimmed) ? Number(trimmed) : 0;
  const ms = seconds * 1000;
  return seconds > 0 && Number.isSafeInteger(ms)
    ? ms
    : DEFAULT_RETRY_AFTER_SECONDS * 1000;
}

function field(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)[key]
    : undefined;
}

export function classifySlackSendResult(
  input: SlackSendResultInput,
): SlackSendOutcome {
  const error = field(input.body, "error");
  if (input.httpStatus === 429 || error === "ratelimited") {
    return {
      kind: "retry_after",
      waitMs: retryAfterMs(input.retryAfterHeader),
    };
  }

  if (field(input.body, "ok") === true) {
    const ts = field(input.body, "ts");
    // Slack may already hold the message, so retrying without its identity
    // could post it twice.
    return typeof ts === "string" && ts !== ""
      ? { kind: "sent", ts }
      : { kind: "failed", code: "missing_ts" };
  }

  const code =
    typeof error === "string" && error !== ""
      ? error
      : `http_${input.httpStatus}`;
  if (SLACK_PERMANENT_SEND_ERRORS.has(code)) return { kind: "failed", code };
  return input.attempts >= SLACK_SEND_MAX_ATTEMPTS
    ? { kind: "failed", code }
    : { kind: "retry", code };
}
