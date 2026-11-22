import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { docker, serviceContainer } from "../conformance/docker.ts";
import {
  Api,
  type ApiResponse,
  bash,
  type ErrorBody,
  e2eEnv,
  e2eOwnerCookie,
  poll,
  REPOSITORY_ID,
  type SseEvent,
  type Step,
  scripted,
  type Turn,
} from "./client.ts";

/**
 * A workspace admin registers the stack's fake MCP server
 * (packages/testkit/src/fake-mcp.ts) twice: `/oauth/mcp` signed in to with
 * OAuth (discovery, DCR, PKCE; the suite plays the browser on the fake's
 * control port) and `/static/mcp` with a static token. An agent with both
 * turned on calls them through the egress proxy, and the remote side sees
 * the admin's account. Then the admin disconnects, and the running
 * session's next call is refused with a receipt.
 *
 * What the fake issued carries a prefix (`fmo_` access, `fmr_` refresh,
 * `fmc_` code, `fms_` the static token), so the worker, every container's
 * log, the API's answers and a dump of the database are shown to hold none
 * without the suite ever reading one.
 */
const env = e2eEnv();
const fakeMcpUrl = process.env.E2E_FAKE_MCP_URL ?? "";
const installation = process.env.EXECUTION_INSTALLATION_ID ?? "";
const project = process.env.E2E_COMPOSE_PROJECT ?? "";
if (!fakeMcpUrl || !installation || !project) {
  throw new Error(
    "E2E_FAKE_MCP_URL, EXECUTION_INSTALLATION_ID and E2E_COMPOSE_PROJECT are unset: run tests/e2e/run.sh",
  );
}
const TIMEOUT = 600_000;
const ISSUED = /fm[ocrs]_[A-Za-z0-9_-]{16,}/g;
const MCP = "http://fake-mcp:4020";
// tests/e2e/compose.yml sets the API's CONSOLE_ORIGIN to this.
const CONSOLE = "http://127.0.0.1:3000";
const REFUSED = /credential_unbound \(receipt ([0-9a-f-]{36})\)/;
// Names are the workspace's own: a suite run again on a kept stack
// (E2E_UP_ONLY) registers its servers and agent beside the last run's.
const tag = randomBytes(3).toString("hex");
const PROBE = `wsmcp${tag}`;
const TRACKER = `tracker${tag}`;
const WIKI = `wiki${tag}`;
const WHOAMI: Step = { tool: `mcp__${TRACKER}__whoami`, input: {} };
// call_mcp receipt lines (callReceipts). The first connection is
// generation 1; the disconnect makes it 2, which the refusal names.
const ACCEPTED = `accepted ${TRACKER} whoami 1 -`;
const REFUSED_AFTER_CUT = `failed ${TRACKER} - 2 credential_unavailable`;

const card = {
  role: "workspace MCP probe",
  instructions: "Call the workspace's MCP servers.",
  language: "en",
  model: "claude-sonnet-5",
  // No catalog server: the workspace's servers are turned on per agent.
  capabilities: { mcp: null, forbidden: [] },
  rules: [],
};

type Person = { user_id: string; display_name: string };
type Server = {
  id: string;
  name: string;
  auth_kind: "oauth" | "bearer";
  redirect_uri: string | null;
  bearer: { last4: string } | null;
  connection: {
    state: string;
    connected_by: Person | null;
    granted_scope: string | null;
  };
  tools: { name: string }[];
};
type Calls = { calls: number; authorization_sha256: string[] };
type WorkspaceCalls = {
  oauth: Calls & {
    registrations: number;
    authorizations: number;
    code_grants: number;
    refresh_grants: number;
    token_refusals: number;
    revocations: number;
  };
  static: Calls;
};

let cookie = "";
let api: Api;
let approver: Api;
let agentId = "";
let releaseId = "";
let oauthServer: Server;
let staticServer: Server;
const staticToken = `fms_${randomBytes(18).toString("base64url")}`;
// Every API answer the suite read, scanned at the end.
const answers: string[] = [];
const started: string[] = [];

/** An Api whose every answer (turns, pending requests, receipts) joins `answers`. */
class RecordingApi extends Api {
  override async request<T>(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string | null,
  ): Promise<ApiResponse<T>> {
    const response = await super.request<T>(method, path, body, idempotencyKey);
    answers.push(JSON.stringify(response.body));
    return response;
  }
}

async function web<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {
    "x-requested-with": "werft-web",
  };
  if (cookie !== "") headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${env.apiUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? null : JSON.stringify(body),
  });
  const text = await response.text();
  answers.push(text);
  return {
    status: response.status,
    body: (text === "" ? null : JSON.parse(text)) as T,
  };
}

async function workspaceCalls(): Promise<WorkspaceCalls> {
  return (await fetch(`${fakeMcpUrl}/workspace-calls`)).json() as never;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function startSession(steps: Step[], id: string) {
  const response = await api.request<
    { session_id: string; turn_id: string } & ErrorBody
  >("POST", "/v1/sessions", {
    repository_id: REPOSITORY_ID,
    message: scripted(id, steps, `${id} done`),
    agent_release_id: releaseId,
  });
  expect(response.status).toBe(201);
  started.push(response.body.session_id);
  return response.body.session_id;
}

afterAll(async () => {
  for (const sessionId of started) {
    const { revision } = await api.session(sessionId);
    await api.control(sessionId, "terminate", {
      expected_revision: revision,
      reason: "e2e",
    });
  }
}, TIMEOUT);

/** As remote-mcp.e2e.ts: an ask rule that stops the turn for a person. */
const GATE: Step = bash('echo gate | sed -n "w gate.txt"');

/** As remote-mcp.e2e.ts: allows each permission request as it comes. */
async function settle(
  sessionId: string,
  turnId: string,
  before: Record<number, () => Promise<void>> = {},
): Promise<Turn> {
  const answered = new Set<string>();
  return poll(`turn ${turnId} of ${sessionId}`, 180_000, async () => {
    const turn = await api.turn(sessionId, turnId);
    if (
      ["completed", "failed", "interrupted", "cancelled"].includes(turn.status)
    ) {
      return turn;
    }
    for (const request of await api.pending(sessionId)) {
      if (answered.has(request.request_id)) continue;
      await before[answered.size]?.();
      answered.add(request.request_id);
      await approver.allow(sessionId, request.request_id);
    }
    return null;
  });
}

async function streamOf(sessionId: string, turnId: string) {
  return api.events(
    sessionId,
    (event) => event.event === "result" && event.data.turn_id === turnId,
  );
}

async function toolResults(
  sessionId: string,
  turnId = "1",
): Promise<SseEvent[]> {
  const events = await streamOf(sessionId, turnId);
  answers.push(JSON.stringify(events));
  return events.filter(
    (event) => event.event === "tool_result" && event.data.turn_id === turnId,
  );
}

function textOf(event: SseEvent | undefined): string {
  const content = event?.data.data.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

/** psql in the stack's postgres container, as the container's own user. */
async function sql(query: string): Promise<string[]> {
  const out = await docker([
    "exec",
    await serviceContainer("postgres"),
    "sh",
    "-c",
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "$1"',
    "sh",
    query,
  ]);
  return out.split("\n").filter((line) => line.trim() !== "");
}

/** The session's `call_mcp` receipts: status, server, tool, generation, reason. */
async function callReceipts(sessionId: string): Promise<string[]> {
  return sql(
    `select status || ' ' || (result->>'server_id') || ' ' || coalesce(result->>'tool', '-') || ' ' || coalesce(result->>'connection_generation', '-') || ' ' || coalesce(result->>'reason', '-') from receipts where operation = 'call_mcp' and target_ref->>'session_id' = '${sessionId}' order by created_at`,
  );
}

/**
 * The engine cannot read the worker process, which is non-dumpable, so the
 * in-session scan sees only the engine's side. Root with CAP_SYS_PTRACE
 * (`docker exec --privileged -u 0`, as the isolation docs say) reads every
 * process's environment in each running worker container; the worker's own
 * user, which cannot read the worker process, is the control.
 */
async function workerEnvironments(): Promise<string[]> {
  const ids = (
    await docker([
      "ps",
      "-q",
      "--filter",
      `label=werft.installation=${installation}`,
    ])
  )
    .split("\n")
    .filter((id) => id.trim() !== "");
  // A process gone before its read is not a miss.
  const loop = [
    "pattern='fm[ocrs]_[A-Za-z0-9_-]{16,}'",
    "read=0; missed=0; found=0",
    "for p in /proc/[0-9]*; do",
    '  if cat "$p/environ" >/dev/null 2>&1; then',
    "    read=$((read + 1))",
    '    found=$((found + $(cat "$p/environ" 2>/dev/null | grep -aoE "$pattern" | wc -l)))',
    '  elif [ -d "$p" ]; then missed=$((missed + 1)); fi',
    "done",
    'echo "read=$read missed=$missed found=$found"',
  ].join("\n");
  const lines: string[] = [];
  for (const id of ids) {
    const privileged = await docker([
      "exec",
      "--privileged",
      "-u",
      "0",
      id,
      "sh",
      "-c",
      loop,
    ]);
    const own = await docker(["exec", id, "sh", "-c", loop]);
    lines.push(`privileged ${privileged.trim()} worker-user ${own.trim()}`);
  }
  return lines;
}

const count = (text: string) => text.match(ISSUED)?.length ?? 0;

beforeAll(async () => {
  cookie = await e2eOwnerCookie(env.apiUrl);
  const key = await web<{ secret: string }>("POST", "/v1/api-keys", {
    kind: "personal",
    scopes: [
      "sessions:read",
      "sessions:write",
      "sessions:approve",
      "sessions:control",
    ],
  });
  expect(key.status).toBe(201);
  api = new RecordingApi({ ...env, apiKey: key.body.secret });
  const approverKey = await web<{ secret: string }>("POST", "/v1/api-keys", {
    kind: "personal",
    scopes: ["sessions:read", "sessions:approve"],
  });
  expect(approverKey.status).toBe(201);
  approver = new RecordingApi({ ...env, apiKey: approverKey.body.secret });

  const team = await web<{ team: { id: string } }>("POST", "/v1/teams", {
    name: PROBE,
  });
  expect(team.status).toBe(201);
  const created = await web<{
    agent: { id: string };
    versions: { id: string }[];
  }>("POST", "/v1/agents", {
    slug: PROBE,
    name: PROBE,
    managing_team_id: team.body.team.id,
    card,
  });
  expect(created.status).toBe(201);
  agentId = created.body.agent.id;
  const released = await web<{ release: { id: string } }>(
    "POST",
    `/v1/agents/${agentId}/releases`,
    {
      version_id: created.body.versions[0]?.id,
      connection_id: "fake-messages",
      repository_id: REPOSITORY_ID,
    },
  );
  expect(released.status).toBe(200);
  releaseId = released.body.release.id;
  const activated = await web("POST", `/v1/agents/${agentId}/activate`, {
    release_id: releaseId,
    expected_revision: -1,
  });
  expect(activated.status).toBe(200);
}, TIMEOUT);

describe("workspace MCP servers an admin connects", () => {
  test(
    "OAuth: discovery, DCR and the browser's consent connect the server as the admin, and an agent's call reaches it with a refreshed token",
    async () => {
      const discovered = await web<{
        oauth: { issuer: string; default_scope: string | null } | null;
      }>("POST", "/v1/workspace/mcp-servers/discover", {
        url: `${MCP}/oauth/mcp`,
      });
      expect(discovered.status).toBe(200);
      expect(discovered.body.oauth).toMatchObject({
        issuer: MCP,
        default_scope: "read",
      });

      const created = await web<Server>("POST", "/v1/workspace/mcp-servers", {
        name: TRACKER,
        url: `${MCP}/oauth/mcp`,
        auth_kind: "oauth",
      });
      expect(created.status).toBe(201);
      oauthServer = created.body;
      const callback = `${CONSOLE}/settings/workspace/mcp-servers/${oauthServer.id}/callback`;
      expect(oauthServer.redirect_uri).toBe(callback);
      expect(oauthServer.connection.state).toBe("none");

      const before = await workspaceCalls();
      const start = await web<{ authorization_url: string }>(
        "POST",
        `/v1/workspace/mcp-servers/${oauthServer.id}/oauth/start`,
      );
      expect(start.status).toBe(200);
      // The browser's step: the URL names the stack's own address for the
      // fake, so the suite opens it on the fake's published control port.
      const asked = new URL(start.body.authorization_url);
      expect(asked.origin).toBe(MCP);
      const consent = await fetch(
        `${fakeMcpUrl}${asked.pathname}${asked.search}`,
        { redirect: "manual" },
      );
      expect(consent.status).toBe(302);
      const back = new URL(consent.headers.get("location") ?? "");
      expect(`${back.origin}${back.pathname}`).toBe(callback);

      const completed = await web<Server>(
        "POST",
        `/v1/workspace/mcp-servers/${oauthServer.id}/oauth/complete`,
        {
          code: back.searchParams.get("code"),
          state: back.searchParams.get("state"),
          iss: back.searchParams.get("iss"),
        },
      );
      expect(completed.status).toBe(200);
      oauthServer = completed.body;
      expect(oauthServer.connection).toMatchObject({
        state: "active",
        granted_scope: "read",
      });
      expect(oauthServer.connection.connected_by?.user_id).toBeString();
      expect(oauthServer.tools.map((tool) => tool.name)).toEqual([
        "whoami",
        "other",
      ]);
      const signedIn = await workspaceCalls();
      expect(signedIn.oauth.registrations).toBe(before.oauth.registrations + 1);
      expect(signedIn.oauth.code_grants).toBe(before.oauth.code_grants + 1);
      // A replayed callback is refused: the flow is spent.
      const replayed = await web(
        "POST",
        `/v1/workspace/mcp-servers/${oauthServer.id}/oauth/complete`,
        {
          code: back.searchParams.get("code"),
          state: back.searchParams.get("state"),
          iss: back.searchParams.get("iss"),
        },
      );
      expect(replayed.status).toBe(400);

      const turnedOn = await web<{
        servers: {
          items: { name: string; on: boolean; connected_by: Person | null }[];
        };
      }>("PUT", `/v1/agents/${agentId}/mcp/workspace-servers`, {
        server_ids: [oauthServer.id],
      });
      expect(turnedOn.status).toBe(200);
      expect(turnedOn.body.servers.items).toContainEqual(
        expect.objectContaining({
          name: TRACKER,
          on: true,
          connected_by: oauthServer.connection.connected_by,
        }),
      );

      const sessionId = await startSession([WHOAMI], "wsmcp-oauth");
      expect((await settle(sessionId, "1")).status).toBe("completed");
      const [result] = await toolResults(sessionId);
      expect(textOf(result)).toContain("ok:oauth:fake-account");
      const after = await workspaceCalls();
      expect(after.oauth.calls).toBe(signedIn.oauth.calls + 1);
      // A 30s access token is inside the refresh margin: the call refreshed.
      expect(after.oauth.refresh_grants).toBeGreaterThan(
        signedIn.oauth.refresh_grants,
      );
      expect(await callReceipts(sessionId)).toEqual([ACCEPTED]);
    },
    TIMEOUT,
  );

  test(
    "static token: the server takes the admin's token, both servers answer one session, and no issued value reaches the worker",
    async () => {
      // Before the registration, which reads the tools with the token.
      const before = await workspaceCalls();
      const created = await web<Server>("POST", "/v1/workspace/mcp-servers", {
        name: WIKI,
        url: `${MCP}/static/mcp`,
        auth_kind: "bearer",
        token: staticToken,
      });
      expect(created.status).toBe(201);
      staticServer = created.body;
      expect(staticServer.bearer?.last4).toBe(staticToken.slice(-4));
      expect(staticServer.connection.state).toBe("active");

      const turnedOn = await web(
        "PUT",
        `/v1/agents/${agentId}/mcp/workspace-servers`,
        {
          server_ids: [oauthServer.id, staticServer.id],
        },
      );
      expect(turnedOn.status).toBe(200);
      const sessionId = await startSession(
        [WHOAMI, { tool: `mcp__${WIKI}__whoami`, input: {} }],
        "wsmcp-both",
      );
      expect((await settle(sessionId, "1")).status).toBe("completed");
      const [tracker, wiki] = await toolResults(sessionId);
      expect(textOf(tracker)).toContain("ok:oauth:fake-account");
      expect(textOf(wiki)).toContain("ok:static");
      const after = await workspaceCalls();
      expect(after.oauth.calls).toBe(before.oauth.calls + 1);
      expect(after.static.calls).toBe(before.static.calls + 1);
      // The one bearer this run's server was sent is the admin's token.
      expect(after.static.authorization_sha256).toEqual(
        [
          ...new Set([
            ...before.static.authorization_sha256,
            sha256Hex(staticToken),
          ]),
        ].sort(),
      );
      expect(before.static.authorization_sha256).not.toContain(
        sha256Hex(staticToken),
      );

      // The pattern does not match itself. The planted file is the control:
      // a scan that cannot see shows files=0 and fails.
      const scan = [
        "pattern='fm[ocrs]_[A-Za-z0-9_-]{16,}'",
        "printf 'fmo_%s\\n' plantedcontrolvalue > /tmp/scan-control",
        'n() { grep -aoE "$pattern" | wc -l | tr -d " "; }',
        'echo "env=$(env | n)"',
        'echo "proc=$(for p in /proc/[0-9]*; do cat $p/environ $p/cmdline 2>/dev/null; echo; done | n)"',
        'echo "files=$(grep -raoE "$pattern" /workspace "$HOME" /tmp 2>/dev/null | wc -l | tr -d " ")"',
      ].join("\n");
      await api.send(
        sessionId,
        scripted("wsmcp-scan", [bash(scan), GATE], "scanned"),
      );
      // While the gate waits for its answer the worker is running and has
      // made both calls.
      const worker: { seen?: string[] } = {};
      const scanned = await settle(sessionId, "2", {
        0: async () => {
          worker.seen = await workerEnvironments();
        },
      });
      expect(scanned.status).toBe("completed");
      const [counts] = await toolResults(sessionId, "2");
      expect(textOf(counts)).toMatch(/env=0\s+proc=0\s+files=1/);
      expect(worker.seen?.length).toBeGreaterThan(0);
      for (const line of worker.seen ?? []) {
        expect(line).toMatch(
          /^privileged read=[1-9]\d* missed=0 found=0 worker-user read=\d+ missed=[1-9]\d* found=0$/,
        );
      }
    },
    TIMEOUT,
  );

  test(
    "disconnect revokes at the server, and the running session's next call is refused with a call_mcp receipt",
    async () => {
      const before = await workspaceCalls();
      const sessionId = await startSession([WHOAMI, GATE, WHOAMI], "wsmcp-cut");
      const disconnected: { revoked?: boolean | null } = {};
      const turn = await settle(sessionId, "1", {
        // The first call has run; the gate waits for its answer.
        0: async () => {
          const cut = await web<{ server: Server; revoked: boolean | null }>(
            "POST",
            `/v1/workspace/mcp-servers/${oauthServer.id}/disconnect`,
          );
          expect(cut.status).toBe(200);
          expect(cut.body.server.connection.state).toBe("none");
          disconnected.revoked = cut.body.revoked;
        },
      });
      expect(turn.status).toBe("completed");
      expect(disconnected.revoked).toBe(true);
      const [first, , second] = await toolResults(sessionId);
      expect(textOf(first)).toContain("ok:oauth:fake-account");
      const receiptId = REFUSED.exec(textOf(second))?.[1];
      expect(receiptId).toBeDefined();
      expect(second?.data.data.is_error).toBe(true);
      expect(await api.receipt(receiptId ?? "")).toMatchObject({
        operation: "call_mcp",
        status: "failed",
        error: { code: "CREDENTIAL_UNBOUND" },
        result: {
          server_id: TRACKER,
          workspace_server_id: oauthServer.id,
          reason: "credential_unavailable",
        },
      });
      const after = await workspaceCalls();
      expect(after.oauth.calls).toBe(before.oauth.calls + 1);
      expect(after.oauth.revocations).toBeGreaterThan(before.oauth.revocations);
      expect(await callReceipts(sessionId)).toEqual([
        ACCEPTED,
        REFUSED_AFTER_CUT,
      ]);

      const listed = await web<{ items: Server[] }>(
        "GET",
        "/v1/workspace/mcp-servers",
      );
      expect(listed.status).toBe(200);
      expect(
        listed.body.items.find((server) => server.id === oauthServer.id)
          ?.connection,
      ).toMatchObject({ state: "none", connected_by: null });
      expect(
        (await web("GET", `/v1/agents/${agentId}/mcp/workspace-servers`))
          .status,
      ).toBe(200);
    },
    TIMEOUT,
  );

  test(
    "no issued value is in an API answer, a container's log or the database",
    async () => {
      expect(answers.length).toBeGreaterThan(10);
      expect(answers.map(count)).toEqual(answers.map(() => 0));

      const containers = [
        ...(
          await docker([
            "ps",
            "-aq",
            "--filter",
            `label=com.docker.compose.project=${project}`,
          ])
        ).split("\n"),
        ...(
          await docker([
            "ps",
            "-aq",
            "--filter",
            `label=werft.installation=${installation}`,
          ])
        ).split("\n"),
      ].filter((id) => id.trim() !== "");
      expect(containers.length).toBeGreaterThan(5);
      const found: Record<string, number> = {};
      for (const id of containers) {
        const n = count(await docker(["logs", id]));
        if (n > 0) found[id] = n;
      }
      expect(found).toEqual({});

      const dump = await docker([
        "exec",
        await serviceContainer("postgres"),
        "sh",
        "-c",
        'pg_dump --data-only -U "$POSTGRES_USER" "$POSTGRES_DB"',
      ]);
      // The control: the dump does hold the servers' rows.
      expect(dump).toContain(`${MCP}/oauth/mcp`);
      expect(dump).toContain(`${MCP}/static/mcp`);
      expect(count(dump)).toBe(0);
    },
    TIMEOUT,
  );
});
