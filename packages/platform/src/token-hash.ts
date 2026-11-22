import { createHash } from "node:crypto";

/** The SHA-256 bytes of a token's UTF-8 text: what a token column stores. */
export function hashToken(value: string): Uint8Array {
  return createHash("sha256").update(value, "utf8").digest();
}
