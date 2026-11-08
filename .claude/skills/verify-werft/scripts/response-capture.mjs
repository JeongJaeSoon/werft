// Failed-request capture for browser.mjs: which responses count as failed,
// how their bodies are masked and cut, and the CDP event collector. No socket
// here (the collector gets `send`), so tests/verify-werft-response-capture.test.ts
// runs all of it without Chrome.

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
  return status >= 400 || (pattern?.test(url) ?? false);
}

// Keys whose values are secrets. A substring match, so "access_token" and
// "bootstrap_token" are covered. `code` is left out on purpose: error.code
// ("UNAUTHORIZED") is what a failed-request report is read for.
const SECRET_KEY =
  /(token|secret|password|passwd|cookie|authorization|api[_-]?key|private[_-]?key|csrf)/i;

// A parsed JSON body is masked by key at any depth and for any value type
// (string, array, object); escaped key spellings are decoded by the parse.
function hideSecrets(value) {
  if (Array.isArray(value)) return value.map(hideSecrets);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        SECRET_KEY.test(k) ? "(hidden)" : hideSecrets(v),
      ]),
    );
  return value;
}

// A key as written in text may use \uXXXX escapes; compare the decoded name.
const jsonText = (literal) => {
  try {
    return JSON.parse(literal);
  } catch {
    return literal;
  }
};

// Where the JSON value that starts at `i` ends. A string, array or object that
// is cut off (no closing mark) runs to the end of the text: hiding too much of
// a truncated body is the safe side.
function valueEnd(s, i) {
  const open = s[i];
  if (open === '"') {
    for (let j = i + 1; j < s.length; j++) {
      if (s[j] === "\\") j++;
      else if (s[j] === '"') return j + 1;
    }
    return s.length;
  }
  if (open === "[" || open === "{") {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      if (s[j] === '"') j = valueEnd(s, j) - 1;
      else if (s[j] === "[" || s[j] === "{") depth++;
      else if ((s[j] === "]" || s[j] === "}") && --depth === 0) return j + 1;
    }
    return s.length;
  }
  const bare = /^[^\s,}\]]*/.exec(s.slice(i))[0];
  return i + bare.length;
}

// JSON that sits inside other text, or a body that is not valid JSON: find
// each `"key":` and hide the value after a secret key, whatever its shape.
function hideEmbedded(text) {
  const keyAt = /("(?:[^"\\]|\\.)*")(\s*:\s*)/g;
  let out = "";
  let last = 0;
  for (let m = keyAt.exec(text); m; m = keyAt.exec(text)) {
    if (!SECRET_KEY.test(jsonText(m[1]))) continue;
    const start = m.index + m[0].length;
    const end = valueEnd(text, start);
    out += `${text.slice(last, start)}"(hidden)"`;
    last = end;
    keyAt.lastIndex = end;
  }
  return out + text.slice(last);
}

export function maskBody(text) {
  let out = String(text);
  try {
    out = JSON.stringify(hideSecrets(JSON.parse(out)));
  } catch {
    // Not JSON (HTML, plain text, a cut body): the patterns below still run.
  }
  return hideEmbedded(out)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, "$1 (hidden)")
    .replace(
      /\b((?:set-)?cookie|authorization)\s*[:=]\s*(?:"[^"]*"|"[^"\r\n]*|[^\r\n"])+/gi,
      "$1: (hidden)",
    )
    .replace(/\/invite\/[^/?#\s"\\]+/g, "/invite/(token)")
    .replace(
      /((?:code|state|[a-z_]*(?:token|secret|password|passwd|api[_-]?key))(?:=|%3D))(?:(?!%26|%23)[^&#\s"])+/gi,
      "$1(hidden)",
    );
}

// Mask first, then cut: a secret split by the cut would escape the patterns.
export function shortBody(text, limit = BODY_LIMIT) {
  const clean = maskBody(text).replace(/\s+/g, " ").trim();
  return clean.length > limit
    ? `${clean.slice(0, limit)}… (+${clean.length - limit} chars cut)`
    : clean;
}

// Query strings can carry OAuth codes and paths an invite token; the report
// names the masked path only.
export function safeUrl(raw) {
  try {
    const u = new URL(raw);
    // Decode first: /in%76ite/<token> is the same path as /invite/<token>.
    let path = u.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {}
    return `${maskBody(path)}${u.search ? "?(query hidden)" : ""}`;
  } catch {
    return "(unparsable url)";
  }
}

export function formatCapture(c) {
  const head = `${c.method} ${safeUrl(c.url)} -> ${c.status ?? "no response"}`;
  if (c.bodyError) return `${head} | body unavailable: ${c.bodyError}`;
  return `${head} | ${c.body === "" ? "(empty body)" : shortBody(c.body)}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Feed every CDP message to onEvent; report() waits for the wanted requests
// still loading (up to settleMs), then returns one line per capture. A request
// that ends in loadingFailed or never finishes is listed with the reason.
export function createCollector({ send, pattern, settleMs = 3000 }) {
  // One record per hop of a request id, in the order the hops started. A
  // record is listed once it has a body or a reason (bodyError); `waiting`
  // holds the ones still loading or being read.
  const records = [];
  const current = new Map(); // requestId -> record of the hop in flight
  const waiting = new Set();
  const settle = (rec, extra) => {
    Object.assign(rec, extra);
    waiting.delete(rec);
  };
  // A URL that matches CAPTURE_URL is tracked from the request on, so a
  // refused connection or a hang before any header is listed too.
  const begin = (id, method, url) => {
    const rec = { method, url, listed: false };
    current.set(id, rec);
    if (pattern?.test(url)) track(rec);
  };
  const track = (rec) => {
    if (rec.listed) return;
    rec.listed = true;
    records.push(rec);
    waiting.add(rec);
  };
  function onEvent(m) {
    const p = m.params;
    if (m.method === "Network.requestWillBeSent") {
      const prev = current.get(p.requestId);
      if (prev && p.redirectResponse) {
        // The redirect answered the previous hop; it has no body to read.
        prev.status = p.redirectResponse.status;
        if (wanted(prev.status, prev.url, pattern)) track(prev);
        if (prev.listed) settle(prev, { bodyError: "redirect, no body" });
      }
      begin(p.requestId, p.request.method, p.request.url);
    } else if (m.method === "Network.responseReceived") {
      const rec =
        current.get(p.requestId) ??
        (begin(p.requestId, "GET", p.response.url), current.get(p.requestId));
      rec.status = p.response.status;
      rec.url = p.response.url;
      if (wanted(rec.status, rec.url, pattern)) track(rec);
    } else if (m.method === "Network.loadingFinished") {
      const rec = current.get(p.requestId);
      if (!rec?.listed || !waiting.has(rec)) return;
      send("Network.getResponseBody", { requestId: p.requestId }).then(
        (r) =>
          settle(rec, {
            body: r.base64Encoded
              ? Buffer.from(r.body, "base64").toString("utf8")
              : r.body,
          }),
        (error) =>
          settle(rec, {
            bodyError: error.message.replace(/^Network\.getResponseBody: /, ""),
          }),
      );
    } else if (m.method === "Network.loadingFailed") {
      const rec = current.get(p.requestId);
      if (rec?.listed && waiting.has(rec))
        settle(rec, { bodyError: p.errorText ?? "loading failed" });
    }
  }
  async function report() {
    const end = Date.now() + settleMs;
    while (waiting.size > 0 && Date.now() < end)
      await sleep(Math.min(50, end - Date.now()));
    // Whatever is still open ran out of time: list it with why.
    for (const rec of [...waiting])
      settle(rec, { bodyError: "no response body within the wait" });
    return records.map((c) => `! failed request: ${formatCapture(c)}`);
  }
  return { onEvent, report };
}
