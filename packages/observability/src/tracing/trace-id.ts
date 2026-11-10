import { createHash } from "node:crypto";

/**
 * The trace id of one turn, derived so the API, the worker and the ingest
 * listener agree on it without passing it around. `turnId` is the per-session
 * public sequence number, so the session id is part of the input.
 */
export function turnTraceId(sessionId: string, turnId: number): string {
  return createHash("sha256")
    .update(`werft.turn:${sessionId}:${turnId}`)
    .digest("hex")
    .slice(0, 32);
}
