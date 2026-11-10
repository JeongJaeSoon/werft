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
// Network.enable parameters: the browser keeps no body over READ_LIMIT, so a
// body larger than its reported size cannot reach this process whole, and
// bounds what it buffers in all.
export const NETWORK_ENABLE = {
  maxResourceBufferSize: READ_LIMIT,
  maxTotalBufferSize: 16 * READ_BUDGET,
};
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

// Whether the value under a name is a secret. One function for a parsed
// JSON key, a form key (a=b) and a name found in text (the run of name
// characters around a secret word), so the three cannot drift apart.
//   - a secret word anywhere in the name: "access_token", "client_secret[0]",
//     "session_id", "session id", a whole-word "sid";
//   - a name ending in "session" ("session", "current_session"): hidden,
//     unless its value is an object, which is masked key by key so that its
//     "id" is hidden and the rest stays readable; "sessions" (a list, or the
//     scope sessions:read) is not a session;
//   - "id" under such a parent;
//   - an OAuth or device code (code, authCode, user_code), except under
//     error/errors, where it is the error code a report is read for;
//   - a path ("session.id", "session[user][id]", "auth[code]"): secret if any
//     segment is, each read with the segment before it as its parent.
// The name is %-decoded first. A secret word matches anywhere in it.
const SECRET_WORDS =
  "token|secret|password|passwd|cookie|authorization|api[_-]?key|private[_-]?key|csrf|session[_ -]?id|e-?mail";
const SECRET_KEY = new RegExp(`${SECRET_WORDS}|\\bsid\\b`, "i");
const SESSION_NAME = /session$/i;
const CODE_KEY = /^code$|[a-z][_-]?code$/i;
const ERROR_KEY = /^errors?$|^error[_-]?code$|^status[_-]?code$/i;
function secretName(rawName, parent = "", value = undefined) {
  const name = decodeAscii(rawName);
  if (SECRET_KEY.test(name)) return true;
  const path = name.split(/[.[\]]+/).filter(Boolean);
  if (path.length > 1)
    return path.some((segment, i) =>
      secretName(
        segment,
        i === 0 ? parent : path[i - 1],
        i === path.length - 1 ? value : undefined,
      ),
    );
  if (SESSION_NAME.test(name))
    return !(value && typeof value === "object" && !Array.isArray(value));
  if (/^id$/i.test(name) && SESSION_NAME.test(parent)) return true;
  return (
    CODE_KEY.test(name) && !ERROR_KEY.test(parent) && !ERROR_KEY.test(name)
  );
}

// A parsed JSON body is masked by key at any depth and for any value type
// (string, array, object); escaped key spellings are decoded by the parse.
// Every string value left goes through maskBody again, so form pairs and
// JSON serialized into a string meet the same steps as a whole body.
// Nested deeper than this, a string value is hidden whole.
const MAX_DEPTH = 4;
function hideSecrets(value, parent, depth) {
  if (typeof value === "string")
    return depth < MAX_DEPTH ? maskBody(value, depth + 1) : "(hidden)";
  if (Array.isArray(value))
    return value.map((v) => hideSecrets(v, parent, depth));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        secretName(k, parent, v) ? "(hidden)" : hideSecrets(v, k, depth),
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

// Where the value that starts at `i` ends, for JSON in text and for form
// values alike. A quoted string (either quote) skips what a backslash
// escapes; a string, array or object that is cut off (no closing mark) runs
// to the end of the text: hiding too much of a truncated body is the safe
// side. A bare value ends where `bareEnd` stops.
function valueEnd(s, i, bareEnd = /^[^\s,}\]&]*/) {
  const open = s[i];
  if (open === '"' || open === "'") {
    for (let j = i + 1; j < s.length; j++) {
      if (s[j] === "\\") j++;
      else if (s[j] === open) return j + 1;
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
  const bare = bareEnd.exec(s.slice(i))[0];
  return i + bare.length;
}

// Text that is not JSON (a cut body, form or query pairs, `key=value` lines,
// JSON behind other text). Quotes are never paired here (a stray, escaped or
// missing one broke every pairing scheme): find a secret word, read the name
// around it (secretName decides), take the first `:` or `=` after it however
// far away (the rest of a name with brackets, commas or any length, its
// closing quote, a tab), and hide the value that follows, whatever its shape.
// Over-hiding prose such as "token expired: retry" is the safe side. The next
// separator is found once per position and a name is read 64 characters
// each way at most, so the scan stays linear in the text.
const NAME_AT = new RegExp(
  `${SECRET_WORDS}|\\bsid\\b|\\bcode\\b|session`,
  "gi",
);
const nameAround = (text, from, to) => {
  let a = from;
  let b = to;
  while (a > 0 && from - a < 64 && /[\w.[\]$-]/.test(text[a - 1])) a--;
  while (b < text.length && b - to < 64 && /[\w.[\]$-]/.test(text[b])) b++;
  return text.slice(a, b);
};

// Form pairs (a=1&b=2) are split on the raw text, before %XX is decoded, so
// an encoded "&", ";" or space inside a secret value cannot end its mask and
// leave the rest of the value in the report. The key is decoded to be read
// (secretName) and the value ends where valueEnd() says: at its closing quote,
// escapes skipped, or for a bare value at a raw "&", ";" or space, running
// through any quoted part inside it (ab"c d", %22c d%22). The scan goes on inside a
// value it leaves, so a pair whose own separators are encoded
// (a%3D1%26password%3D…) is still found. Keys are read up to 256 characters,
// which keeps the scan linear.
const FORM_BARE =
  /^(?:%22(?:(?!%22)[\s\S])*(?:%22)?|[^&;\s"']|"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)*/i;
function hideFormPairs(text) {
  const pair = /(^|[&;?\s]|%2[60]|%3B)([^=&;\s]{1,256}?)(=|%3D)/gi;
  let out = "";
  let last = 0;
  for (let m = pair.exec(text); m; m = pair.exec(text)) {
    const start = m.index + m[0].length;
    if (start < last || !secretName(m[2])) continue;
    const end = valueEnd(text, start, FORM_BARE);
    if (end === start) continue;
    out += `${text.slice(last, start)}(hidden)`;
    last = end;
    pair.lastIndex = end;
  }
  return out + text.slice(last);
}
function hideEmbedded(text) {
  const pattern = new RegExp(NAME_AT);
  let out = "";
  let last = 0;
  let sep = -1; // the first ":" or "=" at or after the last search start
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    const from = m.index + m[0].length;
    if (!secretName(nameAround(text, m.index, from))) continue;
    if (sep < from) {
      const next = /[:=]/g;
      next.lastIndex = from;
      sep = next.exec(text)?.index ?? text.length;
    }
    if (sep >= text.length) break;
    const start =
      sep + 1 + /^\s*/.exec(text.slice(sep + 1, sep + 257))[0].length;
    // Already hidden by the form step: leave it as it is.
    if (text.startsWith("(hidden)", start)) {
      pattern.lastIndex = start + 8;
      continue;
    }
    out += `${text.slice(last, start)}"(hidden)"`;
    // Outside JSON a bare value runs to a space or the next form pair: a
    // bracket inside it (a[0]=…) must not end it before a later secret key.
    last = valueEnd(text, start, /^[^\s&]*/);
    pattern.lastIndex = Math.max(last, start);
  }
  return out + text.slice(last);
}

// JSON behind a prefix, e.g. the anti-hijacking `)]}'` line or `while(1);`:
// parse from the first `{` or `[` so the value is masked by key like plain
// JSON. The prefix itself still meets the text masks.
function parsePrefixed(text) {
  for (const open of ["{", "["]) {
    const at = text.indexOf(open);
    if (at <= 0) continue;
    try {
      return { prefix: text.slice(0, at), value: JSON.parse(text.slice(at)) };
    } catch {
      // Try the other bracket, then fall back to the text masks.
    }
  }
  return undefined;
}

// Markup is not parsed: a body with a tag and a secret-like name anywhere is
// withheld whole. A scan for the end of a secret element was bypassed by
// CDATA, comments, processing instructions, a trailing "/" and character
// references in turn. Withheld, for example <password>…</password>.
// The hint is broader than SECRET_WORDS (any "key", "mail", "session",
// "code"): withholding a harmless page is the safe side. Numeric character
// references are decoded first (pass&#119;ord), with or without ";".
// Any name start counts, not only ASCII letters (XML allows <비밀 …/>);
// only "<" before a space, digit, "=" or another bracket is taken as text.
const MARKUP = /<[^\s\d=<>]/;
const SECRET_HINT =
  /token|secret|passw|cookie|authoriz|key|csrf|session|sid|mail|code/i;
function decodeRefs(text) {
  return text.replace(/&#(?:x([0-9a-f]+)|([0-9]+));?/gi, (_, hex, dec) => {
    const n = hex ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    return n <= 0x10ffff ? String.fromCodePoint(n) : "";
  });
}
const withheld = (text) =>
  MARKUP.test(text) && SECRET_HINT.test(decodeRefs(text));

// One order for every body and every string value inside one:
//   1. parse it as JSON, whole or behind a prefix, and mask by key, each
//      string value going through maskBody again;
//   2. text that did not parse (the whole body, or the prefix before the
//      JSON, which may be the start of a cut body) has form pairs hidden on
//      the raw text, then the text scan;
//   3. both then get the decoding and the token, cookie, invite, query and
//      email masks.
export function maskBody(text, depth = 0) {
  const raw = String(text);
  const json = parseJson(raw);
  if (!json) return maskText(raw, false);
  return (
    maskText(json.prefix, false) +
    maskText(JSON.stringify(hideSecrets(json.value, "", depth)), true)
  );
}
function parseJson(text) {
  try {
    return { prefix: "", value: JSON.parse(text) };
  } catch {
    return parsePrefixed(text);
  }
}
function maskText(text, parsed) {
  if (text === "") return text;
  let out = parsed ? text : hideFormPairs(text);
  out = decodeAscii(out);
  // A key may be spelled with t-style escapes; write the plain letters
  // back before searching (only [A-Za-z0-9_-], so no quote or bracket moves).
  out = out.replace(/\\u00([0-7][0-9a-f])/gi, (whole, hex) => {
    const c = String.fromCharCode(Number.parseInt(hex, 16));
    return /[A-Za-z0-9_-]/.test(c) ? c : whole;
  });
  if (withheld(out))
    return `(markup with secret-like names withheld, ${out.length} chars)`;
  if (!parsed) out = hideEmbedded(out);
  return (
    out
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 (hidden)")
      .replace(
        /\b((?:set-)?cookie|authorization)\s*[:=]\s*(?:"[^"]*"|"[^"\r\n]*|[^\r\n"])+/gi,
        "$1: (hidden)",
      )
      .replace(/\/invite\/[^/?#\s"'<>\\]+/gi, "/invite/(token)")
      .replace(
        /((?:code|state|sid|[a-z_]{0,40}(?:token|secret|password|passwd|api[_-]?key|session[_-]?id|e-?mail))(?:=|%3D))(?:(?!%26|%23)[^&#\s"\\])+/gi,
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
  if (c.omitted !== undefined)
    return `${head} | body omitted: ${c.omitted} bytes (over the ${READ_LIMIT}-byte read limit)`;
  if (c.bodyError) return `${head} | body unavailable: ${c.bodyError}`;
  return `${head} | ${c.body === "" ? "(empty body)" : shortBody(c.body)}`;
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
  // getResponseBody has no length argument, so the decoded size the browser
  // reported (dataReceived, or Content-Length of an unencoded body) is the
  // only bound: a body without one is not read. `final` is set once loading
  // finished, when no more size can arrive.
  const unreadable = (rec, final) => {
    if (rec.mimeType && !TEXT_MIME.test(rec.mimeType))
      return `not read (${rec.mimeType})`;
    const size = Math.max(rec.size, rec.wire ?? 0);
    if (size > READ_LIMIT) return { omitted: size };
    if (!final) return undefined;
    if (!rec.sizeKnown) return "not read (size unknown)";
    if (reserved + rec.size > READ_BUDGET)
      return "not read (capture budget for this command spent)";
    return undefined;
  };
  const skip = (rec, why) =>
    settle(rec, typeof why === "string" ? { bodyError: why } : why);
  const read = (id, rec) => {
    const why = unreadable(rec, true);
    if (why) return skip(rec, why);
    const take = rec.size;
    reserved += take;
    send("Network.getResponseBody", { requestId: id }).then(
      (r) => {
        // Settled in bytes actually read, in case the reported size was low.
        const bytes = Buffer.byteLength(
          r.body,
          r.base64Encoded ? "base64" : "utf8",
        );
        reserved += bytes - take;
        // Larger than reported: dropped whole rather than cut and kept.
        if (bytes > READ_LIMIT) return settle(rec, { omitted: bytes });
        const body = r.base64Encoded
          ? Buffer.from(r.body, "base64").toString("utf8")
          : r.body;
        settle(rec, { body });
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
    // Data on an open stream is not a request starting or ending; counting
    // it kept a live SSE from ever letting the network go quiet.
    if (m.method !== "Network.dataReceived") lastEvent = Date.now();
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
      // Content-Length is the decoded size only when there is no encoding;
      // a compressed length is still a lower bound for the over-limit check.
      const length = Number(
        headerValue(p.response.headers, "content-length") ?? Number.NaN,
      );
      if (Number.isFinite(length)) {
        if (headerValue(p.response.headers, "content-encoding"))
          rec.wire = length;
        else {
          rec.size = length;
          rec.sizeKnown = true;
        }
      }
      if (wanted(rec.status, rec.url, pattern)) track(rec);
      const why = waiting.has(rec) && unreadable(rec, false);
      if (why) skip(rec, why);
    } else if (m.method === "Network.dataReceived") {
      const rec = current.get(p.requestId);
      if (rec) {
        rec.got = (rec.got ?? 0) + p.dataLength;
        rec.size = Math.max(rec.size, rec.got);
        rec.sizeKnown = true;
      }
    } else if (m.method === "Network.loadingFinished") {
      const rec = current.get(p.requestId);
      done(p.requestId);
      if (!rec || !waiting.has(rec)) return;
      rec.wire = Math.max(rec.wire ?? 0, p.encodedDataLength ?? 0);
      read(p.requestId, rec);
    } else if (m.method === "Network.loadingFailed") {
      const rec = current.get(p.requestId);
      // A request that never got headers (refused, DNS, TLS) is a failure
      // too; one the page itself cancelled (navigation, abort()) is not.
      if (rec && noHeaders.has(p.requestId) && !p.canceled) track(rec);
      done(p.requestId);
      if (rec && waiting.has(rec))
        settle(rec, {
          bodyError: p.errorText || p.blockedReason || "loading failed",
        });
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
