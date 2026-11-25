export const MASKED = "[REDACTED]";

// Whole values that are a credential by their shape: GitHub, Slack, model
// provider and AWS keys, the platform's own tokens, a private key block. A
// platform token is a short lowercase prefix, `_` and 32 random bytes in
// base64url, whatever the prefix: 40 characters or more with a capital in
// them, which an id (`att_<uuid>`) or a long snake_case name is not.
// Every pattern reads its input once: no two repeats in one can share a
// character, and the lookahead is bounded.
const SECRET_VALUES = [
  /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bx(?:ox[abeoprs]|app)-[A-Za-z0-9-]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b[a-z]{2,4}_(?=[a-z0-9_-]{0,42}[A-Z])[A-Za-z0-9_-]{40,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];
// The value after `Bearer`, and the login of a URL; the words around stay.
const BEARER = /\b(bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi;
const URL_LOGIN = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/?#@:]*:[^\s/?#@]*@/gi;

/**
 * `text` with every secret-shaped value in it replaced, the rest kept. The
 * built-in `werft` server passes everything it answers through here, so a
 * part that reads a value it should not have still does not hand it to an
 * agent. A part keeps secrets out by not reading them; this is the net under
 * that, and it knows only shapes.
 */
export function maskSecrets(text: string): string {
  let masked = text;
  for (const shape of SECRET_VALUES) masked = masked.replace(shape, MASKED);
  return masked
    .replace(BEARER, `$1${MASKED}`)
    .replace(URL_LOGIN, `$1${MASKED}@`);
}

/** `value` with every string in it masked, keys included in neither direction. */
export function maskSecretsIn<T>(value: T): T {
  if (typeof value === "string") return maskSecrets(value) as T;
  if (Array.isArray(value)) return value.map(maskSecretsIn) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, maskSecretsIn(item)]),
    ) as T;
  }
  return value;
}
