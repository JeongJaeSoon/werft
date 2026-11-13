#!/usr/bin/env node
// Drive the web console in a headless Chrome of this run's own: its own
// user-data-dir under the run directory, its PID recorded, and stop kills
// only that PID. For when an Orca tab cannot screenshot (a hidden tab fails
// with "page did not draw a frame") or the check needs a width, a color
// scheme, a failed request or a slow network the Orca tab cannot set.
//
//   browser.mjs <run> start | stop
//   browser.mjs <run> open <path|url>            prints path and title
//   browser.mjs <run> login <who> [--here] | accept <who>  web-user.mjs credentials, typed, never printed
//   browser.mjs <run> invite <who>               opens <who>'s invite page and stops there
//   browser.mjs <run> bootstrap <who>            /bootstrap form from state.env's token and users/<who>
//   browser.mjs <run> shot <name> [full]         evidence/<name>.png, prints scrollWidth/innerWidth
//   browser.mjs <run> mockshot <path> <responses.json> <name> [full]   GET response fixtures, explicitly recorded
//   browser.mjs <run> blockshot <path> <url pattern> <name>   that request fails (error state)
//   browser.mjs <run> slowshot <path> <name> [ms]  2.5 s latency, capture mid-load (loading state)
//   browser.mjs <run> click <text|css> | type <css|@N> <text> | select <css|@N> <value>
//   browser.mjs <run> press <text|css> [Key]      focus it, then a real key (Enter): click leaves focus where it was
//   browser.mjs <run> key <Key> [count] | eval <expr>   @N: the Nth field in <main>, from 0
//   browser.mjs <run> measure <name>              evidence/layout/<name>.json for layout-report.mjs
//   browser.mjs <run> slack-consent [team] [nameless]  in-page Slack link start, mock consent, open the callback
//   browser.mjs <run> slack-install-consent <agent id> [deny]   finish a UI-started install through mock consent
//
// Every page command takes W (default 1280), H (900) and THEME (light|dark)
// from the environment, e.g. W=390 THEME=dark browser.mjs <run> shot home-390-dark.
// Every page command also ends with a "! failed request:" line on stderr per
// 4xx/5xx response (method, path, status, masked body up to 2000 chars);
// CAPTURE_URL='*/v1/x*' adds the responses of matching URLs. A command that
// throws skips the lines; `accept` refusing still prints them.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCollector,
  globToRegExp,
  NETWORK_ENABLE,
} from "./response-capture.mjs";

const CHROME =
  process.env.CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [runArg, cmd, ...args] = process.argv.slice(2);
if (!runArg || !cmd) {
  console.error(
    "usage: browser.mjs <run id | run dir> <command> [...]  (see the header)",
  );
  process.exit(2);
}
const root =
  process.env.VERIFY_AP_ROOT ??
  join(process.env.TMPDIR ?? tmpdir(), "verify-werft");
// realpath so start and stop name the same profile in Chrome's command line
// whether the run came by id or by a /private/var… path.
const run = realpathSync(
  runArg.includes("/") ? runArg : join(root, runArg.replace(/^verify-ap-/, "")),
);
const dir = join(run, "browser");
const profile = join(dir, "profile");
const pidFile = join(dir, "pid");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
// A recorded PID is ours only while its command line still names our profile.
const ours = (pid) => {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
    }).includes(profile);
  } catch {
    return false;
  }
};

if (cmd === "start") {
  if (existsSync(pidFile) && ours(Number(readFileSync(pidFile, "utf8")))) {
    console.log(`already running: pid ${readFileSync(pidFile, "utf8")}`);
    process.exit(0);
  }
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  rmSync(join(profile, "DevToolsActivePort"), { force: true });
  const log = openSync(join(dir, "chrome.log"), "a");
  const child = spawn(
    CHROME,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { detached: true, stdio: ["ignore", log, log] },
  );
  writeFileSync(pidFile, String(child.pid));
  child.unref();
  for (
    let i = 0;
    i < 50 && !existsSync(join(profile, "DevToolsActivePort"));
    i++
  )
    await sleep(200);
  if (!existsSync(join(profile, "DevToolsActivePort"))) {
    console.error(
      `browser.mjs: Chrome (pid ${child.pid}) gave no DevTools port; see ${dir}/chrome.log, then stop`,
    );
    process.exit(1);
  }
  console.log(`started headless Chrome pid ${child.pid} (profile ${profile})`);
  process.exit(0);
}

if (cmd === "stop") {
  if (!existsSync(pidFile)) {
    console.log("no browser recorded for this run");
    process.exit(0);
  }
  const pid = Number(readFileSync(pidFile, "utf8"));
  if (alive(pid) && ours(pid)) {
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 50 && alive(pid); i++) await sleep(200);
    if (alive(pid)) process.kill(pid, "SIGKILL");
    for (let i = 0; i < 25 && alive(pid); i++) await sleep(200);
  }
  // Read-only check: a Chrome on our profile under another PID (not recorded,
  // so never signalled here) means the profile is still in use.
  const inUse = execFileSync("ps", ["-axo", "command="], { encoding: "utf8" })
    .split("\n")
    .some((line) => line.includes(`--user-data-dir=${profile}`));
  if (inUse) {
    console.error(
      `browser.mjs: a Chrome on ${profile} is still running (recorded pid ${pid}); profile kept, nothing else signalled`,
    );
    process.exit(1);
  }
  rmSync(profile, { recursive: true, force: true });
  rmSync(pidFile);
  console.log(
    `stopped pid ${pid}; profile removed (alive: ${alive(pid) && ours(pid)})`,
  );
  process.exit(0);
}

const state = Object.fromEntries(
  readFileSync(join(run, "state.env"), "utf8")
    .split("\n")
    .map((line) => line.replace(/^export /, "").match(/^([A-Z_]+)=(.*)$/))
    .filter(Boolean)
    .map(([, k, v]) => [k, v.replace(/^"(.*)"$/, "$1")]),
);
const url = (p) => (/^https?:/.test(p) ? p : state.VERIFY_API + p);
const W = Number(process.env.W ?? 1280);
const H = Number(process.env.H ?? 900);
const THEME = process.env.THEME ?? "light";
const shotPath = (name) => join(run, "evidence", `${name}.png`);

if (!existsSync(join(profile, "DevToolsActivePort"))) {
  console.error(
    "browser.mjs: no browser for this run; browser.mjs <run> start first",
  );
  process.exit(1);
}
const port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split(
  "\n",
)[0];
const targets = await (
  await fetch(`http://127.0.0.1:${port}/json/list`)
).json();
const page =
  targets.find((t) => t.type === "page") ??
  (await (
    await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
      method: "PUT",
    })
  ).json());
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) =>
    pending.set(id, (m) =>
      m.error
        ? reject(new Error(`${method}: ${m.error.message}`))
        : resolve(m.result),
    ),
  );
}
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  return r.exceptionDetails
    ? `EXC: ${r.exceptionDetails.exception?.description}`
    : r.result?.value;
}
async function settle() {
  await sleep(300);
  for (let i = 0; i < 30; i++) {
    if (
      !(await evaluate(
        `document.readyState!=='complete' || !!document.querySelector('[aria-busy="true"]')`,
      ))
    )
      break;
    await sleep(200);
  }
  await sleep(400);
}
async function navigate(target) {
  await send("Page.navigate", { url: url(target) });
  await sleep(500);
  await settle();
}
async function capture(name, full = false) {
  let clip;
  if (full) {
    const h = await evaluate(
      "Math.max(document.documentElement.scrollHeight, innerHeight)",
    );
    clip = { x: 0, y: 0, width: W, height: Math.min(h, 6000), scale: 1 };
  }
  const r = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: full,
    ...(clip ? { clip } : {}),
  });
  writeFileSync(shotPath(name), Buffer.from(r.data, "base64"));
  return shotPath(name);
}
// The invite token is a path segment and OAuth callbacks carry code/state in
// the query; never print them.
const masked = (text) =>
  String(text)
    .replace(/\/invite\/[^/?#\s|]+/g, "/invite/(token)")
    .replace(/([?&](?:code|state)=)[^&#\s|]+/g, "$1(hidden)")
    .replace(
      /((?:code|state)%((?:25)*)3D)[\s\S]*?(?=%(?:\2)(?:26|23)|[&#\s|]|$)/gi,
      "$1(hidden)",
    );
const here = async () =>
  masked(await evaluate("location.pathname + location.search"));
// "@N" is the Nth field in <main> (from 0), for forms whose inputs have no name.
const field = (selector) => {
  const nth = selector.match(/^@(\d+)$/);
  return nth
    ? `document.querySelectorAll('main input:not([type=radio]):not([type=checkbox]), main textarea, main select')[${nth[1]}]`
    : `document.querySelector(${JSON.stringify(selector)})`;
};
// Types into a field without the value passing through a command line.
async function fill(selector, text) {
  const found = await evaluate(`(() => { const el = ${field(selector)};
    if (!el) return false; el.focus(); el.select && el.select(); return true; })()`);
  if (!found) throw new Error(`no field ${selector} on ${await here()}`);
  await send("Input.insertText", { text });
}
async function submit() {
  await evaluate(`document.querySelector('form button[type=submit]').click()`);
  for (let i = 0; i < 25; i++) {
    await sleep(200);
    if (
      !(await evaluate(
        `!!document.querySelector('form button[type=submit]:disabled')`,
      ))
    )
      break;
  }
  await sleep(800);
  await settle();
}
const userFile = (who) => join(run, "users", who);
// The same element click and press pick: exact text, then partial, then CSS.
const target = (want) => `(() => { const want = ${JSON.stringify(want)};
  const all = [...document.querySelectorAll('button, a, [role=button], [role=tab], summary, label')];
  let el = all.find((b) => b.textContent.trim() === want) || all.find((b) => b.textContent.trim().includes(want));
  if (!el) { try { el = document.querySelector(want); } catch {} }
  return el; })()`;
const KEY_CODES = { Tab: 9, Enter: 13, Escape: 27, " ": 32 };
async function pressKey(key) {
  const base = { key, code: key, windowsVirtualKeyCode: KEY_CODES[key] ?? 0 };
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    ...base,
    ...(key === "Enter" ? { text: "\r" } : {}),
  });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}
const focused = () =>
  evaluate(`(() => { const a = document.activeElement; if (!a) return null; const s = getComputedStyle(a);
    return { tag: a.tagName, name: (a.getAttribute('aria-label') || a.innerText || a.getAttribute('name') || '').slice(0, 50).replace(/\\s+/g, ' '),
      outline: s.outlineStyle + ' ' + s.outlineWidth }; })()`);

// Failed requests (4xx/5xx, plus CAPTURE_URL='*glob*') are listed with their
// response body, masked and cut, after the command's own output. Without this
// a failed call showed its status only and the cause needed a second repro.
const capturePattern = process.env.CAPTURE_URL
  ? globToRegExp(process.env.CAPTURE_URL)
  : undefined;
const collector = createCollector({ send, pattern: capturePattern });
ws.addEventListener("message", (e) =>
  collector.onEvent(JSON.parse(String(e.data))),
);
// On stderr, so a caller that parses a command's stdout (eval prints JSON)
// sees the same stdout as before.
async function reportCaptures() {
  for (const line of await collector.report()) console.error(line);
}

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable", NETWORK_ENABLE);
await send("Emulation.setDeviceMetricsOverride", {
  width: W,
  height: H,
  deviceScaleFactor: 1,
  mobile: W < 600,
});
await send("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-color-scheme", value: THEME }],
});

switch (cmd) {
  case "open":
    await navigate(args[0]);
    console.log(
      masked(
        await evaluate(
          "location.pathname + location.search + ' | ' + document.title",
        ),
      ),
    );
    break;
  case "login": {
    const c = JSON.parse(readFileSync(userFile(args[0]), "utf8"));
    // --here keeps the page (and its in-memory cache) of a tab already on /login.
    if (args[1] !== "--here") await navigate("/login");
    await fill("input[name=email]", c.email);
    await fill("input[name=password]", c.password);
    await submit();
    console.log(`login ${args[0]} -> ${await here()}`);
    break;
  }
  case "accept": {
    const token = readFileSync(`${userFile(args[0])}.invite`, "utf8");
    const c = JSON.parse(readFileSync(userFile(args[0]), "utf8"));
    // The invite screens other than the form (signed in, used, ended, bad
    // token) carry no secret; print their heading and fail.
    const refused = async () => {
      console.log(
        `accept ${args[0]} -> ${await here()} | ${await evaluate(
          "(document.querySelector('main [data-status] h2') ?? document.querySelector('main [role=alert]') ?? document.querySelector('main'))?.innerText.replace(/\\s+/g, ' ').slice(0, 80)",
        )}`,
      );
      await reportCaptures();
      process.exit(1);
    };
    await navigate(`/invite/${token}`);
    // Step 1 asks whether the account exists; the second button is "new".
    const picked = await evaluate(`(() => {
      const b = document.querySelector('main section[aria-labelledby] button:last-of-type');
      b?.click(); return !!b; })()`);
    if (!picked) await refused();
    await settle();
    await fill(
      "input[name=display_name]",
      `Verify ${args[0][0].toUpperCase()}${args[0].slice(1)}`,
    );
    await fill("input[name=password]", c.password);
    await submit();
    if ((await here()) !== "/") await refused();
    console.log(`accept ${args[0]} -> /`);
    break;
  }
  case "invite": {
    // Only opens <who>'s invite page, for what `accept` does not walk (the
    // provider buttons). The token stays off the command line.
    const token = readFileSync(`${userFile(args[0])}.invite`, "utf8");
    await navigate(`/invite/${token}`);
    console.log(`invite ${args[0]} -> ${await here()}`);
    break;
  }
  case "bootstrap": {
    // Like web-user.mjs bootstrap: the first use makes users/<who>; a later
    // one reuses it, so a second submit shows the 409 screen.
    const file = userFile(args[0]);
    if (!existsSync(file)) {
      mkdirSync(join(run, "users"), { recursive: true, mode: 0o700 });
      writeFileSync(
        file,
        JSON.stringify({
          email: `${args[0]}@example.test`,
          password: randomBytes(16).toString("hex"),
        }),
        { mode: 0o600, flag: "wx" },
      );
    }
    const c = JSON.parse(readFileSync(file, "utf8"));
    await navigate("/bootstrap");
    await fill("input[name=bootstrap_token]", state.VERIFY_BOOTSTRAP_TOKEN);
    await fill("input[name=email]", c.email);
    await fill(
      "input[name=display_name]",
      `Verify ${args[0][0].toUpperCase()}${args[0].slice(1)}`,
    );
    await fill("input[name=password]", c.password);
    await fill("input[name=workspace_name]", "Verify");
    await fill("input[name=workspace_slug]", "verify");
    await submit();
    console.log(
      `bootstrap ${args[0]} -> ${await here()} | ${await evaluate(
        "(document.querySelector('form [role=alert]')?.innerText ?? '').replace(/\\s+/g, ' ')",
      )}`,
    );
    break;
  }
  case "slack-consent": {
    // authorize_url carries the OAuth state and the callback URL the code, so
    // both stay in this process: CDP in, bun's stdin, CDP out. Never argv.
    if (!state.COMPOSE_PROJECT_NAME?.startsWith("verify-ap-"))
      throw new Error("not a verification project");
    if (!state.COMPOSE_FILE?.includes("infra/compose.mock-slack.yml"))
      throw new Error("mock Slack overlay required");
    // `nameless`: the id_token carries no names, like a link made before
    // names were kept.
    const nameless = args.includes("nameless");
    const team = args.find((arg) => arg !== "nameless");
    if (team && !/^T[0-9A-Z]+$/.test(team))
      throw new Error("mock team id like T0OTHER");
    const extra = `${team ? `&mock_team=${team}` : ""}${nameless ? "&mock_team_name=&mock_user_name=" : ""}`;
    const authorize = await evaluate(
      'fetch("/v1/linked-accounts/slack/start",{method:"POST",headers:{"x-requested-with":"werft-web"}}).then(r=>r.json()).then(j=>j.authorize_url ?? "")',
    );
    if (!/^https?:/.test(authorize ?? ""))
      throw new Error(
        "link start gave no authorize_url (logged in? Slack set up?)",
      );
    let location;
    try {
      location = execFileSync(
        "docker",
        [
          "compose",
          "--profile",
          "apps",
          "--profile",
          "fake-model",
          "exec",
          "-T",
          "api",
          "bun",
          "-e",
          'let status; try { const r = await fetch((await Bun.stdin.text()).trim(), { redirect: "manual" }); status = r.status; if (status !== 302) throw new Error(); const location = r.headers.get("location"); if (!location || !/^https?:$/.test(new URL(location).protocol)) throw new Error(); console.log(location); } catch { console.error(`mock consent failed (HTTP ${status ?? "unavailable"})`); process.exit(1); }',
        ],
        {
          cwd: state.VERIFY_REPO,
          env: { ...process.env, ...state },
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
          input: `${authorize}${extra}`,
        },
      ).trim();
    } catch (error) {
      // Child errors can include the authorization URL; only a status is safe.
      const status =
        /^mock consent failed \(HTTP (\d{3}|unavailable)\)\s*$/.exec(
          String(error.stderr ?? ""),
        )?.[1] ?? "unavailable";
      throw new Error(`mock consent failed (HTTP ${status})`);
    }
    if (!/^https?:/.test(location))
      throw new Error("mock consent gave no redirect");
    // The redirect names the overlay's 127.0.0.1:3000 origin, not this run's port.
    const back = new URL(location);
    await navigate(url(back.pathname + back.search));
    await settle();
    console.log(`slack-consent -> ${await evaluate("location.pathname")}`);
    break;
  }
  case "slack-install-consent": {
    if (!state.COMPOSE_PROJECT_NAME?.startsWith("verify-ap-"))
      throw new Error("not a verification project");
    if (!state.COMPOSE_FILE?.includes("infra/compose.mock-slack.yml"))
      throw new Error("mock Slack overlay required");
    const agent = args[0];
    if (!/^[0-9a-f-]{36}$/i.test(agent ?? ""))
      throw new Error("agent UUID required");
    if (args[1] !== undefined && args[1] !== "deny")
      throw new Error("optional outcome must be deny");
    let authorize = new URL(await evaluate("location.href"));
    if (authorize.hostname !== "slack.com")
      throw new Error("start installation with the console button first");
    const redir = authorize.searchParams.get("redir");
    if (redir) authorize = new URL(redir, "https://slack.com");
    const redirect = new URL(
      authorize.searchParams.get("redirect_uri") ?? "https://invalid.test",
    );
    if (redirect.pathname !== `/agents/${agent}/slack/callback`)
      throw new Error("installation redirect does not match this agent");
    const grant = JSON.parse(
      execFileSync(
        "docker",
        [
          "compose",
          "--profile",
          "apps",
          "--profile",
          "fake-model",
          "exec",
          "-T",
          "api",
          "bun",
          "-e",
          'const url = new URL((await Bun.stdin.text()).trim()); const r = await fetch("http://mock-slack:4020/fake/oauth/authorize" + url.search); if (!r.ok) throw new Error("mock consent failed"); console.log(await r.text());',
        ],
        {
          cwd: state.VERIFY_REPO,
          env: { ...process.env, ...state },
          encoding: "utf8",
          input: authorize.href,
        },
      ),
    );
    if (typeof grant.state !== "string" || typeof grant.code !== "string")
      throw new Error("mock consent returned no grant");
    const back = new URL(`/agents/${agent}/slack/callback`, state.VERIFY_API);
    back.searchParams.set("state", grant.state);
    back.searchParams.set(
      args[1] === "deny" ? "error" : "code",
      args[1] === "deny" ? "access_denied" : grant.code,
    );
    await navigate(back.href);
    await settle();
    console.log(
      `slack-install-consent -> ${await evaluate("location.pathname")}`,
    );
    break;
  }
  case "shot": {
    await settle();
    const file = await capture(args[0], args[1] === "full");
    console.log(
      `${file} ${W}px ${THEME} scrollWidth/innerWidth=${await evaluate("document.documentElement.scrollWidth + '/' + innerWidth")}`,
    );
    break;
  }
  case "mockshot": {
    const [target, fixtureFile, name, full] = args;
    if (!state.COMPOSE_PROJECT_NAME?.startsWith("verify-ap-"))
      throw new Error("response fixtures require a verification project");
    if (new URL(url(target)).origin !== new URL(state.VERIFY_API).origin)
      throw new Error(
        "response fixtures must stay on this verification origin",
      );
    const fixtures = JSON.parse(readFileSync(fixtureFile, "utf8"));
    const routes = Object.keys(fixtures);
    if (routes.length === 0 || routes.some((path) => !path.startsWith("/v1/")))
      throw new Error("response fixtures must name exact /v1/ paths");
    const mocked = new Set();
    const failures = [];
    const responding = new Set();
    const intercept = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method !== "Fetch.requestPaused") return;
      const { requestId, request } = message.params;
      const path = new URL(request.url).pathname;
      const response =
        request.method !== "GET"
          ? send("Fetch.failRequest", {
              requestId,
              errorReason: "BlockedByClient",
            })
          : Object.hasOwn(fixtures, path)
            ? (() => {
                mocked.add(path);
                return send("Fetch.fulfillRequest", {
                  requestId,
                  responseCode: 200,
                  responseHeaders: [
                    { name: "content-type", value: "application/json" },
                  ],
                  body: Buffer.from(JSON.stringify(fixtures[path])).toString(
                    "base64",
                  ),
                });
              })()
            : send("Fetch.continueRequest", { requestId });
      const pendingResponse = response
        .catch((error) => failures.push(error))
        .finally(() => responding.delete(pendingResponse));
      responding.add(pendingResponse);
    };
    ws.addEventListener("message", intercept);
    try {
      await send("Fetch.enable", {
        patterns: [
          { urlPattern: `${state.VERIFY_API}/v1/*`, requestStage: "Request" },
        ],
      });
      await navigate(target);
      await settle();
      await Promise.all(responding);
      if (failures.length > 0) throw failures[0];
      if (mocked.size !== routes.length)
        throw new Error("not every response fixture was requested");
      const file = await capture(name, full === "full");
      const record = {
        response_mock: true,
        target,
        fixture_file: fixtureFile,
        mocked_routes: [...mocked].sort(),
        width: W,
        theme: THEME,
        screenshot: file,
        overflow: await evaluate(
          "document.documentElement.scrollWidth > innerWidth",
        ),
      };
      writeFileSync(
        join(run, "evidence", `${name}.response-mock.json`),
        JSON.stringify(record, null, 2),
      );
      console.log(JSON.stringify(record));
    } finally {
      await send("Fetch.disable");
      ws.removeEventListener("message", intercept);
    }
    break;
  }
  case "blockshot": {
    const [target, pattern, name] = args;
    await send("Network.enable", NETWORK_ENABLE);
    await send("Network.setBlockedURLs", { urls: [pattern] });
    await navigate(target);
    await sleep(3000);
    const file = await capture(name);
    console.log(file);
    console.log(
      await evaluate(
        "(document.querySelector('main') ?? document.body).innerText.slice(0, 400)",
      ),
    );
    await send("Network.setBlockedURLs", { urls: [] });
    break;
  }
  case "slowshot": {
    const [target, name, ms] = args;
    await send("Network.enable", NETWORK_ENABLE);
    await send("Network.setCacheDisabled", { cacheDisabled: true });
    await send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 2500,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await send("Page.navigate", { url: url(target) });
    await sleep(Number(ms ?? 4000));
    const file = await capture(name);
    console.log(file);
    console.log(await evaluate("document.body.innerText.slice(0, 300)"));
    await send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    break;
  }
  case "click": {
    const r = await evaluate(`(() => { const el = ${target(args[0])};
      if (!el) return 'not found';
      el.click(); return 'clicked ' + el.tagName + ' ' + el.textContent.trim().slice(0, 40); })()`);
    await settle();
    console.log(r, "->", await here());
    break;
  }
  case "press": {
    const r = await evaluate(`(() => { const el = ${target(args[0])};
      if (!el) return 'not found';
      el.focus();
      // A disabled, hidden or unfocusable match would send the key to whatever held focus.
      if (document.activeElement !== el) return 'not focusable ' + el.tagName + ' ' + el.textContent.trim().slice(0, 40);
      return 'focused ' + el.tagName + ' ' + el.textContent.trim().slice(0, 40); })()`);
    if (!r.startsWith("focused")) {
      console.log(r);
      break;
    }
    await pressKey(args[1] ?? "Enter");
    await settle();
    console.log(
      r,
      "->",
      await here(),
      "| focus",
      JSON.stringify(await focused()),
    );
    break;
  }
  case "type":
    await fill(args[0], args[1]);
    console.log("typed into", args[0]);
    break;
  case "select": {
    // React tracks a select's value itself; set it the way a user change does.
    const r = await evaluate(`(() => { const el = ${field(args[0])};
      if (!el || el.tagName !== 'SELECT') return 'no select ' + ${JSON.stringify(args[0])};
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(args[1])});
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'selected ' + el.value; })()`);
    await settle();
    console.log(r);
    break;
  }
  case "key": {
    for (let i = 0; i < Number(args[1] ?? 1); i++) {
      await pressKey(args[0]);
      await sleep(120);
      console.log(JSON.stringify(await focused()));
    }
    break;
  }
  case "measure": {
    // Geometry for layout-report.mjs; see measure-layout.js for the fields.
    await settle();
    const m = await evaluate(
      readFileSync(new URL("./measure-layout.js", import.meta.url), "utf8"),
    );
    if (typeof m === "string") throw new Error(m);
    m.path = masked(m.path);
    const file = join(run, "evidence", "layout", `${args[0]}.json`);
    mkdirSync(join(run, "evidence", "layout"), { recursive: true });
    writeFileSync(file, `${JSON.stringify(m, null, 1)}\n`);
    console.log(
      `${file} ${m.path} ${W}px ${THEME} gaps=${m.gaps.length} cards=${m.cards.length} scrollWidth=${m.scrollWidth}`,
    );
    break;
  }
  case "eval":
    console.log(JSON.stringify(await evaluate(args[0]), null, 1));
    break;
  default:
    console.error(`browser.mjs: unknown command '${cmd}'`);
    process.exit(2);
}
await reportCaptures();
ws.close();
process.exit(0);
