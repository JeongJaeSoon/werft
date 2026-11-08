// Pure helpers for browser.mjs: which responses count as failed, and how a
// body is shortened and masked before it reaches the report. No CDP here, so
// tests/verify-werft-response-capture.test.ts runs them without Chrome.

export const BODY_LIMIT = 2000;

// A failed request is a 4xx/5xx response, or any response whose URL matches
// the glob in CAPTURE_URL (`*` only), e.g. CAPTURE_URL='*/v1/sessions*'.
export function globToRegExp(glob) {
  return new RegExp(
    `^${glob
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
}

export function wanted(status, url, pattern) {
  return status >= 400 || (pattern !== undefined && pattern.test(url));
}

// JSON keys whose values are secrets, and the Authorization/Cookie shapes that
// can appear in an echoed request. The key match is a substring, so
// "access_token" and "bootstrap_token" are covered.
const SECRET_KEY =
  /(token|secret|password|passwd|cookie|authorization|api[_-]?key|private[_-]?key|csrf)/i;

export function maskBody(text) {
  return String(text)
    .replace(/("[^"\\]*"\s*:\s*)"(?:[^"\\]|\\.)*"/g, (whole, head) =>
      SECRET_KEY.test(head) ? `${head}"(hidden)"` : whole,
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, "$1 (hidden)")
    .replace(
      /\b((?:set-)?cookie|authorization)\s*[:=]\s*[^\r\n,;]+/gi,
      "$1: (hidden)",
    )
    .replace(/\/invite\/[^/?#\s"]+/g, "/invite/(token)")
    .replace(/([?&](?:code|state|token)=)[^&#\s"]+/g, "$1(hidden)");
}

// Mask first, then cut: a secret split by the cut would escape the patterns.
export function shortBody(text, limit = BODY_LIMIT) {
  const clean = maskBody(text).replace(/\s+/g, " ").trim();
  return clean.length > limit
    ? `${clean.slice(0, limit)}… (+${clean.length - limit} chars cut)`
    : clean;
}

// Query strings can carry OAuth codes; the report names the path only.
export function safeUrl(raw) {
  try {
    const u = new URL(raw);
    return `${u.pathname}${u.search ? "?(query hidden)" : ""}`;
  } catch {
    return "(unparsable url)";
  }
}

export function formatCapture(c) {
  const head = `${c.method} ${safeUrl(c.url)} -> ${c.status}`;
  if (c.bodyError) return `${head} | body unavailable: ${c.bodyError}`;
  return `${head} | ${c.body === "" ? "(empty body)" : shortBody(c.body)}`;
}
