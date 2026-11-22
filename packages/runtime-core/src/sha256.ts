import { createHash } from "node:crypto";

/** A string is hashed as its UTF-8 bytes. */
export function sha256Hex(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}
