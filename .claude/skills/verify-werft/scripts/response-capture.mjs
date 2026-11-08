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

export function maskBody(text) {
  let out = String(text);
  try {
    out = JSON.stringify(hideSecrets(JSON.parse(out)));
  } catch {
    // Not JSON (HTML, plain text, a cut body): the patterns below still run.
  }
  return out
    .replace(/("[^"\\]*"\s*:\s*)"(?:[^"\\]|\\.)*"/g, (whole, head) =>
      SECRET_KEY.test(head) ? `${head}"(hidden)"` : whole,
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, "$1 (hidden)")
    .replace(
      /\b((?:set-)?cookie|authorization)\s*[:=]\s*[^\r\n"]+/gi,
      "$1: (hidden)",
    )
    .replace(/\/invite\/[^/?#\s"\\]+/g, "/invite/(token)")
    .replace(
      /((?:code|state|[a-z_]*(?:token|secret|password))(?:=|%3D))(?:(?!%26|%23)[^&#\s"])+/gi,
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
    return `${maskBody(u.pathname)}${u.search ? "?(query hidden)" : ""}`;
  } catch {
    return "(unparsable url)";
  }
}

export function formatCapture(c) {
  const head = `${c.method} ${safeUrl(c.url)} -> ${c.status}`;
  if (c.bodyError) return `${head} | body unavailable: ${c.bodyError}`;
  return `${head} | ${c.body === "" ? "(empty body)" : shortBody(c.body)}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Feed every CDP message to onEvent; report() waits for the wanted requests
// still loading (up to settleMs), then returns one line per capture. A request
// that ends in loadingFailed or never finishes is listed with the reason.
export function createCollector({ send, pattern, settleMs = 3000 }) {
  const methods = new Map();
  const found = new Map();
  const open = new Set();
  const done = [];
  const finish = (id, extra) => {
    open.delete(id);
    done.push({ ...found.get(id), ...extra });
  };
  function onEvent(m) {
    const p = m.params;
    if (m.method === "Network.requestWillBeSent")
      methods.set(p.requestId, p.request.method);
    else if (
      m.method === "Network.responseReceived" &&
      wanted(p.response.status, p.response.url, pattern)
    ) {
      found.set(p.requestId, {
        method: methods.get(p.requestId) ?? "GET",
        url: p.response.url,
        status: p.response.status,
      });
      open.add(p.requestId);
    } else if (
      m.method === "Network.loadingFinished" &&
      open.has(p.requestId)
    ) {
      open.delete(p.requestId);
      const slot = done.push(undefined) - 1;
      send("Network.getResponseBody", { requestId: p.requestId }).then(
        (r) => {
          done[slot] = {
            ...found.get(p.requestId),
            body: r.base64Encoded
              ? Buffer.from(r.body, "base64").toString("utf8")
              : r.body,
          };
        },
        (error) => {
          done[slot] = {
            ...found.get(p.requestId),
            bodyError: error.message.replace(/^Network\.getResponseBody: /, ""),
          };
        },
      );
    } else if (m.method === "Network.loadingFailed" && open.has(p.requestId))
      finish(p.requestId, { bodyError: p.errorText ?? "loading failed" });
  }
  async function report() {
    for (let t = 0; open.size > 0 && t < settleMs; t += 50) await sleep(50);
    for (const id of [...open])
      finish(id, { bodyError: "response had not finished loading" });
    // getResponseBody answers are still in flight when a slot is undefined.
    for (let t = 0; done.includes(undefined) && t < settleMs; t += 50)
      await sleep(50);
    return done
      .filter(Boolean)
      .map((c) => `! failed request: ${formatCapture(c)}`);
  }
  return { onEvent, report };
}
