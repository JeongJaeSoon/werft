#!/usr/bin/env node
// Web-user requests whose bodies carry a credential: bootstrap, login,
// invite and accept, personal or agent key. The values are made here and
// kept in the run directory (700), so they never appear in a command line
// or in the output. Prints the response body (credential fields dropped)
// and the HTTP status on the last line, like ap_web.
//
//   web-user.mjs <run> bootstrap <who>              first owner, <who>@example.test
//   web-user.mjs <run> bootstrap-bad-token <who>    the same with a wrong token (401)
//   web-user.mjs <run> login <who>                  cookie → cookie.<who> and cookie
//   web-user.mjs <run> login-wrong <who>            a wrong password (401)
//   web-user.mjs <run> login-no-csrf <who>          without x-requested-with (403)
//   web-user.mjs <run> invite <inviter> <who> <role>  token → users/<who>.invite, credentials → users/<who>
//   web-user.mjs <run> accept <who>                 accept users/<who>.invite, cookie as login
//   web-user.mjs <run> key <who> <personal|agent> <scope,scope> [agent id]  secret → keys/<who>
//   web-user.mjs <run> demo-login <owner|member>  source-defined demo credentials
//   web-user.mjs <run> slack-config <who> <workspace>  mock config token, never printed
//   web-user.mjs <run> slack-install <who> <agent id>  mock OAuth with the person's cookie
//   web-user.mjs <run> slack-event <agent> <mode> [channel seq [parent]]  signed mock inbound request (join|leave: the bot enters or leaves channel; a higher seq is later)
//   web-user.mjs <run> slack-cards <agent>           the mock's cards: ts, buttons, updates so far
//   web-user.mjs <run> slack-click <agent> <allow|allow-session|deny|push-approve|push-reject>  press that button on the newest card, signed by the mock
//   web-user.mjs <run> slack-click-bad <agent>       a press with a wrong signature (401)
//   web-user.mjs <run> github-app <who> <workspace> <app id> [connection id]  register the App, or a new key for that connection; key read from its file
//   web-user.mjs <run> github-app-stranger-key <who> <workspace> <app id> <connection id>  a fresh RSA key GitHub does not know (400)
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseRunState } from "./run-state.mjs";

const [runArg, cmd, who, ...rest] = process.argv.slice(2);
if (!runArg || !cmd || !who) {
  console.error(
    "usage: web-user.mjs <run id | run dir> <command> <who> [...]  (see the header)",
  );
  process.exit(2);
}
const root =
  process.env.VERIFY_AP_ROOT ??
  join(process.env.TMPDIR ?? tmpdir(), "verify-werft");
const run = runArg.includes("/")
  ? runArg
  : join(root, runArg.replace(/^verify-ap-/, ""));
const state = parseRunState(readFileSync(join(run, "state.env"), "utf8"));
const api = state.VERIFY_API;
if (!api) {
  console.error(
    `web-user.mjs: no VERIFY_API in ${run}/state.env; did up.sh finish?`,
  );
  process.exit(1);
}
for (const dir of ["users", "keys"])
  mkdirSync(join(run, dir), { recursive: true, mode: 0o700 });

const userFile = (name) => join(run, "users", name);
const fresh = () => randomBytes(16).toString("hex");
function creds(name, create) {
  const file = userFile(name);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  if (!create)
    throw new Error(
      `no credentials for '${name}' yet: bootstrap or accept first`,
    );
  const made = { email: `${name}@example.test`, password: fresh() };
  writeFileSync(file, JSON.stringify(made), { mode: 0o600, flag: "wx" });
  return made;
}
const cookieOf = (name) => {
  const file = join(run, `cookie.${name}`);
  if (!existsSync(file))
    throw new Error(`no cookie for '${name}': login or accept first`);
  return readFileSync(file, "utf8");
};
const displayName = (name) => `Verify ${name[0].toUpperCase()}${name.slice(1)}`;

async function call(method, route, body, { cookie, csrf = true } = {}) {
  const headers = { "content-type": "application/json" };
  if (csrf) headers["x-requested-with"] = "werft-web";
  if (cookie) headers.cookie = cookie;
  const res = await fetch(api + route, {
    method,
    headers,
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const session = res.headers
    .getSetCookie()
    .find((c) => c.startsWith("__Host-werft_session="));
  return { status: res.status, json, text, session: session?.split(";")[0] };
}
function keepSession(name, r) {
  if (!r.session) return;
  writeFileSync(join(run, `cookie.${name}`), r.session, { mode: 0o600 });
  writeFileSync(join(run, "cookie"), r.session, { mode: 0o600 });
  r.note = `cookie saved for ${name} (cookie.${name}, cookie)`;
}
function report(r, drop = []) {
  const shown =
    r.json && typeof r.json === "object" ? { ...r.json } : undefined;
  for (const field of drop)
    if (shown && field in shown)
      shown[field] = `(saved, ${shown[field].length} chars)`;
  console.log(shown ? JSON.stringify(shown) : r.text);
  if (r.note) console.log(`# ${r.note}`);
  console.log(r.status);
}

const bootstrapBody = (c, token) => ({
  bootstrap_token: token,
  email: c.email,
  password: c.password,
  display_name: displayName(who),
  workspace_name: "Verify",
  workspace_slug: "verify",
});

function composeBun(source, args = [], input) {
  if (!state.COMPOSE_PROJECT_NAME?.startsWith("verify-ap-"))
    throw new Error("not a verification project");
  if (!state.COMPOSE_FILE?.includes("infra/compose.mock-slack.yml"))
    throw new Error("mock Slack overlay required");
  return execFileSync(
    "docker",
    [
      "compose",
      "--profile",
      "apps",
      "--profile",
      "fake-model",
      "exec",
      "-T",
      "-w",
      "/app",
      "api",
      "bun",
      "-e",
      source,
      ...args,
    ],
    {
      cwd: state.VERIFY_REPO,
      env: { ...process.env, ...state },
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      input,
    },
  ).trim();
}

switch (cmd) {
  case "demo-login": {
    if (!["owner", "member"].includes(who))
      throw new Error("demo role must be owner or member");
    const source = readFileSync(
      join(state.VERIFY_REPO, "apps/control-host/src/api/demo-accounts.ts"),
      "utf8",
    );
    const password = source.match(
      /export const DEMO_PASSWORD = "([^"]+)"/,
    )?.[1];
    if (!password) throw new Error("cannot read demo password constant");
    const name = `demo-${who}`;
    const c = { email: `${name}@example.test`, password };
    writeFileSync(userFile(name), JSON.stringify(c), { mode: 0o600 });
    const r = await call("POST", "/v1/auth/login", c);
    keepSession(name, r);
    report(r);
    break;
  }
  case "slack-install": {
    const agent = rest[0];
    if (!/^[0-9a-f-]{36}$/i.test(agent ?? ""))
      throw new Error("agent UUID required");
    const cookie = cookieOf(who);
    const sensitive = new Set();
    const redact = (value) => {
      if (Array.isArray(value)) return value.map(redact);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          typeof item === "string" &&
          (["state", "authorize_url"].includes(key) || sensitive.has(item))
            ? `(saved, ${item.length} chars)`
            : redact(item),
        ]),
      );
    };
    const start = await call(
      "POST",
      `/v1/agents/${agent}/slack/install/start`,
      {},
      { cookie },
    );
    if (start.status !== 200) {
      report({
        ...start,
        json: redact(start.json),
        text: "install start failed",
      });
      break;
    }
    let grant;
    try {
      grant = JSON.parse(
        composeBun(
          'let status; try { const url = new URL(await Bun.stdin.text()); const r = await fetch("http://mock-slack:4020/fake/oauth/authorize" + url.search); status = r.status; if (!r.ok) throw new Error(); console.log(await r.text()); } catch { console.error(`mock authorize failed (HTTP ${status ?? "unavailable"})`); process.exit(1); }',
          [],
          start.json.authorize_url,
        ),
      );
    } catch (error) {
      // Child errors can include the authorization URL; only a status is safe.
      const status =
        /^mock authorize failed \(HTTP (\d{3}|unavailable)\)\s*$/.exec(
          String(error.stderr ?? ""),
        )?.[1] ?? "unavailable";
      throw new Error(`mock authorize failed (HTTP ${status})`);
    }
    if (typeof grant.state !== "string" || typeof grant.code !== "string")
      throw new Error("mock authorize response missing state/code");
    sensitive.add(grant.state);
    sensitive.add(grant.code);
    sensitive.add(start.json.authorize_url);
    const complete = await call(
      "POST",
      "/v1/slack/install/complete",
      { agent_id: agent, state: grant.state, code: grant.code },
      { cookie },
    );
    report({
      ...complete,
      json: redact(complete.json),
      text: "install complete returned a non-JSON response",
    });
    break;
  }
  case "slack-config": {
    const workspace = rest[0];
    if (!workspace) throw new Error("workspace id required");
    const value = composeBun(
      'const r = await fetch("http://mock-slack:4020/fake/config-tokens", { method: "POST" }); if (!r.ok) throw new Error("mock config failed"); console.log((await r.json())["refresh_token"]);',
    );
    report(
      await call(
        "PUT",
        `/v1/workspaces/${workspace}/slack/config-token`,
        { value },
        { cookie: cookieOf(who) },
      ),
    );
    break;
  }
  case "slack-event": {
    const mode = rest[0];
    if (
      !/^[0-9a-f-]{36}$/i.test(who) ||
      ![
        "challenge",
        "event",
        "duplicate",
        "bad",
        "stale",
        "malformed",
        "bot",
        "mention",
        "plain",
        "reply",
        "join",
        "leave",
        "uninstall",
        "uninstall-late",
      ].includes(mode)
    )
      throw new Error("agent UUID and event mode required");
    // mention|plain take a channel id and a sequence number for new ids;
    // reply also takes the sequence number of the post it answers.
    // The optional last word is the post's text, e.g. a GATE-SPEC script.
    const [channel = "C0VERIFY", seq = "1", parent, text] = rest.slice(1);
    if (!/^[A-Z0-9]{1,20}$/.test(channel) || !/^[0-9]{1,6}$/.test(seq))
      throw new Error("channel id and sequence number required");
    if (mode === "reply" && !/^[0-9]{1,6}$/.test(parent ?? ""))
      throw new Error("reply needs the parent post's sequence number");
    console.log(
      composeBun(
        readFileSync(new URL("./slack-event.ts", import.meta.url), "utf8"),
        [who, mode, channel, seq, parent ?? "", text ?? ""],
      ),
    );
    break;
  }
  case "slack-cards":
  case "slack-click": {
    if (!/^[0-9a-f-]{36}$/i.test(who)) throw new Error("agent UUID required");
    const action = rest[0] ?? "";
    if (
      cmd === "slack-click" &&
      ![
        "allow",
        "allow-session",
        "deny",
        "push-approve",
        "push-reject",
      ].includes(action)
    )
      throw new Error(
        "action must be allow, allow-session, deny, push-approve or push-reject",
      );
    // The app id is public: the owner reads it from the agent's Slack app.
    const app = await call("GET", `/v1/agents/${who}/slack/app`, undefined, {
      cookie: cookieOf("owner"),
    });
    const appId = app.json?.slack_app?.app_id;
    if (typeof appId !== "string")
      throw new Error("create agent Slack app first");
    console.log(
      composeBun(
        readFileSync(new URL("./slack-click.ts", import.meta.url), "utf8"),
        [cmd === "slack-cards" ? "cards" : "click", appId, who, action],
      ),
    );
    break;
  }
  case "slack-click-bad": {
    if (!/^[0-9a-f-]{36}$/i.test(who)) throw new Error("agent UUID required");
    const body = `payload=${encodeURIComponent(JSON.stringify({ type: "block_actions" }))}`;
    const res = await fetch(`${api}/v1/slack/interactions/${who}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "X-Slack-Request-Timestamp": String(Math.floor(Date.now() / 1000)),
        "X-Slack-Signature": `v0=${"0".repeat(64)}`,
      },
      body,
    });
    console.log(await res.text());
    console.log(res.status);
    break;
  }
  case "bootstrap":
    report(
      await call(
        "POST",
        "/v1/auth/bootstrap",
        bootstrapBody(creds(who, true), state.VERIFY_BOOTSTRAP_TOKEN),
      ),
    );
    break;
  case "bootstrap-bad-token":
    report(
      await call(
        "POST",
        "/v1/auth/bootstrap",
        bootstrapBody(creds(who, true), fresh() + fresh()),
      ),
    );
    break;
  case "login": {
    const c = creds(who, false);
    const r = await call("POST", "/v1/auth/login", {
      email: c.email,
      password: c.password,
    });
    keepSession(who, r);
    report(r);
    break;
  }
  case "login-wrong":
    report(
      await call("POST", "/v1/auth/login", {
        email: creds(who, false).email,
        password: fresh(),
      }),
    );
    break;
  case "login-no-csrf": {
    const c = creds(who, false);
    report(
      await call(
        "POST",
        "/v1/auth/login",
        { email: c.email, password: c.password },
        { csrf: false },
      ),
    );
    break;
  }
  case "invite": {
    const [invitee, role] = rest;
    if (!invitee || !role)
      throw new Error("usage: invite <inviter> <who> <role>");
    const r = await call(
      "POST",
      "/v1/invites",
      { email: `${invitee}@example.test`, role },
      { cookie: cookieOf(who) },
    );
    if (r.json?.invite_token) {
      writeFileSync(`${userFile(invitee)}.invite`, r.json.invite_token, {
        mode: 0o600,
      });
      // Made now so the invitee can accept here or in browser.mjs alike.
      creds(invitee, true);
      r.note = `invite token saved as users/${invitee}.invite, credentials as users/${invitee}`;
    }
    report(r, ["invite_token"]);
    break;
  }
  case "accept": {
    const token = readFileSync(`${userFile(who)}.invite`, "utf8");
    const c = creds(who, true);
    const r = await call("POST", "/v1/invites/accept", {
      token,
      password: c.password,
      display_name: displayName(who),
    });
    keepSession(who, r);
    report(r);
    break;
  }
  case "key": {
    const [kind, scopes, agentId] = rest;
    if (!kind || !scopes || (kind === "agent") !== Boolean(agentId))
      throw new Error(
        "usage: key <who> <personal|agent> <scope,scope> [agent id, for agent]",
      );
    const r = await call(
      "POST",
      "/v1/api-keys",
      {
        kind,
        scopes: scopes.split(","),
        ...(agentId ? { agent_id: agentId } : {}),
      },
      { cookie: cookieOf(who) },
    );
    if (r.json?.secret) {
      writeFileSync(join(run, "keys", who), r.json.secret, { mode: 0o600 });
      r.note = `key saved as keys/${who}; load it with ap_as ${who}`;
    }
    report(r, ["secret"]);
    break;
  }
  case "github-app": {
    // The owner's App key goes from its file to the API here and nowhere
    // else: never an argument, never printed. The response carries no key.
    const [workspace, appId, connection] = rest;
    if (!workspace || !/^[0-9]+$/.test(appId ?? ""))
      throw new Error(
        "usage: github-app <who> <workspace id> <app id> [connection id]",
      );
    const keyFile =
      process.env.VERIFY_GITHUB_APP_KEY_FILE ??
      join(homedir(), ".config", "werft", "github-app.pem");
    if (!existsSync(keyFile))
      throw new Error(
        "no App key file: the owner puts it at ~/.config/werft/github-app.pem or names it in VERIFY_GITHUB_APP_KEY_FILE",
      );
    report(
      await call(
        "PUT",
        connection
          ? `/v1/workspaces/${workspace}/github-apps/${connection}`
          : `/v1/workspaces/${workspace}/github-app`,
        { app_id: Number(appId), private_key: readFileSync(keyFile, "utf8") },
        { cookie: cookieOf(who) },
      ),
    );
    break;
  }
  case "github-app-stranger-key": {
    const [workspace, appId, connection] = rest;
    if (!workspace || !/^[0-9]+$/.test(appId ?? "") || !connection)
      throw new Error(
        "usage: github-app-stranger-key <who> <workspace id> <app id> <connection id>",
      );
    const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs1", format: "pem" })
      .toString();
    report(
      await call(
        "PUT",
        `/v1/workspaces/${workspace}/github-apps/${connection}`,
        { app_id: Number(appId), private_key: stranger },
        { cookie: cookieOf(who) },
      ),
    );
    break;
  }
  default:
    console.error(`web-user.mjs: unknown command '${cmd}'`);
    process.exit(2);
}
