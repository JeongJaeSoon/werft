import { createHash } from "node:crypto";
import { GET_PULL_REQUEST_BODY_MAX_BYTES } from "@werft-ai/contracts";
import { withoutPullRequestTail } from "../../sessions/index.ts";
import { lineRedactor } from "./pull-request-text.ts";

/** The hash `get_pull_request` answers and `update_pull_request` compares. */
export function bodySha256(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/**
 * A body as the model may read it: the platform's tail left out, each line
 * through `redact`, and at most `GET_PULL_REQUEST_BODY_MAX_BYTES` UTF-8
 * bytes, cut between characters.
 */
export function readablePullRequestBody(
  raw: string,
  redact: (line: string) => string,
): { body: string; truncated: boolean } {
  const redactLine = lineRedactor(redact);
  const text = withoutPullRequestTail(raw)
    .split("\n")
    .map((line) => redactLine(line))
    .join("\n");
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= GET_PULL_REQUEST_BODY_MAX_BYTES) {
    return { body: text, truncated: false };
  }
  let end = GET_PULL_REQUEST_BODY_MAX_BYTES;
  // A UTF-8 continuation byte is 10xxxxxx: never start the cut inside one.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return {
    body: new TextDecoder().decode(bytes.subarray(0, end)),
    truncated: true,
  };
}
