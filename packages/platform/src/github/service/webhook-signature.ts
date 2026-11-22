import { createHmac, timingSafeEqual } from "node:crypto";

/** `sha256=<hex>` of the body under `secret`, compared in constant time. */
export function githubSignatureMatches(
  secret: string,
  body: Uint8Array,
  header: string,
): boolean {
  const sent = /^sha256=([0-9a-f]{64})$/.exec(header)?.[1];
  if (sent === undefined) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(sent, "hex"));
}
