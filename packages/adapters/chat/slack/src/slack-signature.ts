import { createHmac } from "node:crypto";

/** Slack's `v0` request signature over the timestamp and the raw body. */
export function slackRequestSignature(input: {
  signingSecret: string;
  timestamp: string;
  rawBody: Uint8Array;
}): string {
  return `v0=${createHmac("sha256", input.signingSecret)
    .update(`v0:${input.timestamp}:`)
    .update(input.rawBody)
    .digest("hex")}`;
}
