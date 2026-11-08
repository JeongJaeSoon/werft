// Failed-request capture for browser.mjs: which responses count as failed,
// how their bodies are masked and cut, and the CDP event collector. No socket
// here (the collector gets `send`), so tests/verify-werft-response-capture.test.ts
// runs all of it without Chrome.

export const BODY_LIMIT = 2000;
// Bounds on what one command pulls out of the browser: the largest body read,
// all bodies read together, and the number of requests listed.
export const READ_LIMIT = 64 * 1024;
export const READ_BUDGET = 256 * 1024;
export const MAX_LISTED = 100;
const TEXT_MIME =
  /^(?:text\/|application\/(?:[\w.+-]*\+)?(?:json|xml|javascript|x-www-form-urlencoded)\b)/i;

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
// "bootstrap_token" are covered; `sid` only as a whole key or word.
const SECRET_WORDS =
  "token|secret|password|passwd|cookie|authorization|api[_-]?key|private[_-]?key|csrf|session[_-]?id|e-?mail";
const SECRET_KEY = new RegExp(`${SECRET_WORDS}|^sid$`, "i");
// An OAuth or device code (code, authCode, user_code). Under error/errors it
// is the error code ("UNAUTHORIZED"), which a failed-request report is read
// for; anywhere else it is hidden.
const CODE_KEY = /^code$|[a-z][_-]?code$/i;
const ERROR_KEY = /^errors?$|^error[_-]?code$/i;

// A parsed JSON body is masked by key at any depth and for any value type
// (string, array, object); escaped key spellings are decoded by the parse.
function secretKey(key, parent) {
  if (SECRET_KEY.test(key)) return true;
  if (/^id$/i.test(key) && /^session$/i.test(parent)) return true;
  return CODE_KEY.test(key) && !ERROR_KEY.test(parent) && !ERROR_KEY.test(key);
}
function hideSecrets(value, parent = "") {
  if (Array.isArray(value)) return value.map((v) => hideSecrets(v, parent));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        secretKey(k, parent) ? "(hidden)" : hideSecrets(v, k),
      ]),
    );
  return value;
}

// Printable ASCII escapes (%76 -> v, %2F -> /) are decoded, again and again
// for double encoding, so an encoded key or invite path meets the masks.
// Control characters and non-ASCII bytes stay escaped.
function decodeAscii(text) {
  let out = text;
  for (let pass = 0; pass < 5; pass++) {
    const next = out.replace(/%(2[0-9a-f]|[3-6][0-9a-f]|7[0-9a-e])/gi, (_, h) =>
      String.fromCharCode(Number.parseInt(h, 16)),
    );
    if (next === out) break;
    out = next;
  }
  return out;
}

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
    const closers = [];
    for (let j = i; j < s.length; j++) {
      if (s[j] === '"') j = valueEnd(s, j) - 1;
      else if (s[j] === "[") closers.push("]");
      else if (s[j] === "{") closers.push("}");
      else if (s[j] === "]" || s[j] === "}") {
        // A closer of the wrong kind means the text is not JSON: hide the rest.
        if (closers.pop() !== s[j]) return s.length;
        if (closers.length === 0) return j + 1;
      }
    }
    return s.length;
  }
  if (open === "\\" && s[i + 1] === '"') {
    // A string inside a string: \"value\"
    const e = s.indexOf('\\"', i + 2);
    return e === -1 ? s.length : e + 2;
  }
  const bare = /^[^\s,}\]]*/.exec(s.slice(i))[0];
  return i + bare.length;
}

// JSON that sits inside other text, or a body that is not valid JSON. Quotes
// are never paired here (a stray, escaped or missing one broke every pairing
// scheme): look for a secret word, allow up to 256 characters after it that
// are not structure (the rest of the name, its closing quote, escapes, a tab
// before the colon), then `:` or `=`, and hide the value that follows,
// whatever its shape. Over-hiding prose such as "token expired: retry" is the
// safe side; the 256 bound keeps the search linear in the text.
// A body that did not parse also has `code` hidden: without the parse there
// is no telling error.code from an OAuth code.
const secretAt = (words) =>
  new RegExp(`(?:${words})[^:=,;{}\\[\\]]{0,256}?[:=]\\s*`, "gi");
const SECRET_AT = secretAt(`${SECRET_WORDS}|\\bsid\\b`);
const SECRET_OR_CODE_AT = secretAt(`${SECRET_WORDS}|\\bsid\\b|\\bcode\\b`);
function hideEmbedded(text, pattern) {
  let out = "";
  let last = 0;
  pattern.lastIndex = 0;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    const start = m.index + m[0].length;
    out += `${text.slice(last, start)}"(hidden)"`;
    last = valueEnd(text, start);
    pattern.lastIndex = Math.max(last, start);
  }
  return out + text.slice(last);
}

// The text of an element named like a secret: <password>…</password>.
const SECRET_TAG = new RegExp(
  `(<[^<>]{0,256}?(?:${SECRET_WORDS}|\\bsid\\b|\\bcode\\b)[^<>]{0,256}>)[^<]*`,
  "gi",
);

export function maskBody(text) {
  let out = String(text);
  let parsed = false;
  try {
    out = JSON.stringify(hideSecrets(JSON.parse(out)));
    parsed = true;
  } catch {
    // Not JSON (HTML, plain text, a cut body): the patterns below still run.
  }
  out = decodeAscii(out);
  // A key may be spelled with t-style escapes; write the plain letters
  // back before searching (only [A-Za-z0-9_-], so no quote or bracket moves).
  out = out.replace(/\\u00([0-7][0-9a-f])/gi, (whole, hex) => {
    const c = String.fromCharCode(Number.parseInt(hex, 16));
    return /[A-Za-z0-9_-]/.test(c) ? c : whole;
  });
  return (
    hideEmbedded(out, parsed ? SECRET_AT : SECRET_OR_CODE_AT)
      .replace(SECRET_TAG, "$1(hidden)")
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 (hidden)")
      .replace(
        /\b((?:set-)?cookie|authorization)\s*[:=]\s*(?:"[^"]*"|"[^"\r\n]*|[^\r\n"])+/gi,
        "$1: (hidden)",
      )
      .replace(/\/invite\/[^/?#\s"'<>\\]+/gi, "/invite/(token)")
      .replace(
        /((?:code|state|sid|[a-z_]{0,40}(?:token|secret|password|passwd|api[_-]?key|session[_-]?id|e-?mail))(?:=|%3D))(?:(?!%26|%23)[^&#\s"])+/gi,
        "$1(hidden)",
      )
      // Bounded runs keep this linear on a long word with no @ in it.
      .replace(
        /[\w.%+-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){0,8}\.[a-z]{2,24}/gi,
        "(email)",
      )
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
    // Decode each run of %XX on its own, so one bad escape elsewhere cannot
    // disable the rest, then look for the invite segment in the decoded path:
    // /in%76ite%2F<token> is the invite path too. Nothing after an invite
    // segment is printed; what comes before goes through the body masks.
    // A run that is not valid UTF-8 still gets its ASCII escapes decoded
    // (%FF%2F -> %FF/). Control characters stay escaped so a path cannot add
    // a line to the report.
    const decoded = u.pathname
      .replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
        try {
          return decodeURIComponent(run);
        } catch {
          return run.replace(/%[0-7][0-9a-f]/gi, (b) =>
            String.fromCharCode(Number.parseInt(b.slice(1), 16)),
          );
        }
      })
      .replace(
        // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
        /[\u0000-\u001f\u007f]/g,
        (c) =>
          `%${c.charCodeAt(0).toString(16).padStart(2, "0").toUpperCase()}`,
      );
    const segments = decoded.split("/");
    const at = segments.findIndex((s) => s.toLowerCase() === "invite");
    const path =
      at === -1
        ? maskBody(decoded)
        : `${maskBody(segments.slice(0, at + 1).join("/"))}/(token)`;
    return `${path}${u.search ? "?(query hidden)" : ""}`;
  } catch {
    return "(unparsable url)";
  }
}

export function formatCapture(c) {
  const head = `${c.method} ${safeUrl(c.url)} -> ${c.status ?? "no response"}`;
  if (c.bodyError) return `${head} | body unavailable: ${c.bodyError}`;
  const cut = c.readCut ? ` [first ${READ_LIMIT} chars read]` : "";
  return `${head} | ${c.body === "" ? "(empty body)" : shortBody(c.body)}${cut}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const headerValue = (headers, name) =>
  Object.entries(headers ?? {}).find(([k]) => k.toLowerCase() === name)?.[1];

// Feed every CDP message to onEvent; report() waits until the network has
// been quiet for quietMs with no request still waiting for its headers or
// body (up to settleMs), then returns one line per capture. A request that
// ends in loadingFailed, gets no headers or never finishes is listed with the
// reason.
export function createCollector({
  send,
  pattern,
  settleMs = 3000,
  quietMs = 300,
}) {
  // One record per hop of a request id, in the order the hops started. A
  // record is listed once it has a body or a reason (bodyError); `waiting`
  // holds the ones still loading or being read, `noHeaders` the requests
  // whose response has not started, whether listed or not.
  const records = [];
  const current = new Map(); // requestId -> record of the hop in flight
  const waiting = new Set();
  const noHeaders = new Map(); // requestId -> record
  let unlisted = 0;
  let reserved = 0; // bytes of the read budget taken by reads
  let lastEvent = 0;
  const settle = (rec, extra) => {
    Object.assign(rec, extra);
    waiting.delete(rec);
  };
  // Checked before any body is read, so a large or binary body never leaves
  // the browser.
  const unreadable = (rec) => {
    if (rec.mimeType && !TEXT_MIME.test(rec.mimeType))
      return `not read (${rec.mimeType})`;
    if (rec.size > READ_LIMIT)
      return `not read (${rec.size} bytes, over ${READ_LIMIT})`;
    if (reserved + Math.min(rec.size || READ_LIMIT, READ_LIMIT) > READ_BUDGET)
      return "not read (capture budget for this command spent)";
    return undefined;
  };
  const read = (id, rec) => {
    const why = unreadable(rec);
    if (why) return settle(rec, { bodyError: why });
    const take = Math.min(rec.size || READ_LIMIT, READ_LIMIT);
    reserved += take;
    send("Network.getResponseBody", { requestId: id }).then(
      (r) => {
        // Cut before masking: what lies past READ_LIMIT is never printed,
        // and the masks hide to the end of a value that the cut leaves open.
        const raw = r.base64Encoded
          ? Buffer.from(
              r.body.slice(0, Math.ceil(READ_LIMIT / 3) * 4),
              "base64",
            ).toString("utf8")
          : r.body;
        const body = raw.slice(0, READ_LIMIT);
        reserved += body.length - take;
        settle(rec, { body, readCut: raw.length > READ_LIMIT });
      },
      (error) =>
        settle(rec, {
          bodyError: error.message.replace(/^Network\.getResponseBody: /, ""),
        }),
    );
  };
  // A URL that matches CAPTURE_URL is tracked from the request on, so a
  // refused connection or a hang before any header is listed too.
  const begin = (id, method, url) => {
    const rec = { method, url, listed: false, size: 0 };
    current.set(id, rec);
    noHeaders.set(id, rec);
    if (pattern?.test(url)) track(rec);
  };
  const track = (rec) => {
    if (rec.listed) return;
    rec.listed = true;
    if (records.length >= MAX_LISTED) {
      unlisted++;
      return;
    }
    records.push(rec);
    waiting.add(rec);
  };
  // A request is done with: drop it so a long command does not pile them up.
  const done = (id) => {
    current.delete(id);
    noHeaders.delete(id);
  };
  function onEvent(m) {
    const p = m.params;
    if (!m.method?.startsWith("Network.")) return;
    lastEvent = Date.now();
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
      noHeaders.delete(p.requestId);
      rec.status = p.response.status;
      rec.url = p.response.url;
      rec.mimeType = p.response.mimeType;
      rec.size = Number(headerValue(p.response.headers, "content-length")) || 0;
      if (wanted(rec.status, rec.url, pattern)) track(rec);
      const why = waiting.has(rec) && unreadable(rec);
      if (why) settle(rec, { bodyError: why });
    } else if (m.method === "Network.dataReceived") {
      const rec = current.get(p.requestId);
      if (rec) {
        rec.got = (rec.got ?? 0) + p.dataLength;
        rec.size = Math.max(rec.size, rec.got);
      }
    } else if (m.method === "Network.loadingFinished") {
      const rec = current.get(p.requestId);
      done(p.requestId);
      if (!rec || !waiting.has(rec)) return;
      rec.size = Math.max(rec.size, p.encodedDataLength ?? 0);
      read(p.requestId, rec);
    } else if (m.method === "Network.loadingFailed") {
      const rec = current.get(p.requestId);
      done(p.requestId);
      if (rec && waiting.has(rec))
        settle(rec, { bodyError: p.errorText ?? "loading failed" });
    }
  }
  async function report() {
    const start = Date.now();
    const end = start + settleMs;
    const busy = () =>
      waiting.size > 0 ||
      noHeaders.size > 0 ||
      Date.now() - Math.max(lastEvent, start) < quietMs;
    while (busy() && Date.now() < end)
      await sleep(Math.max(1, Math.min(50, end - Date.now())));
    // Whatever is still open ran out of time: list it with why.
    for (const rec of noHeaders.values()) {
      track(rec);
      if (waiting.has(rec))
        settle(rec, { bodyError: "no response within the wait" });
    }
    noHeaders.clear();
    for (const rec of [...waiting])
      settle(rec, { bodyError: "no response body within the wait" });
    const lines = records.map((c) => `! failed request: ${formatCapture(c)}`);
    if (unlisted > 0)
      lines.push(
        `! failed request: ${unlisted} more failed requests not listed`,
      );
    return lines;
  }
  return { onEvent, report };
}
