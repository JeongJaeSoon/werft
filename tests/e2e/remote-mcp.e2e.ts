import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  Api,
  bash,
  type ErrorBody,
  e2eEnv,
  firstOwnerCookie,
  poll,
  REPOSITORY_ID,
  type SseEvent,
  type Step,
  scripted,
  type Turn,
} from "./client.ts";

/**
 * An agent whose card names the settings' `fake` MCP server
 * (tests/fixtures/settings/fake-model.json) calls it through the egress proxy
 * with its service account, on the stack tests/e2e/run.sh started. The
 * agent, its binding and the web key come from the stack's first owner
 * (firstOwnerCookie), in the `verify` workspace the settings allow. The
 * fake server's control
 * port reports how many tool calls reached it and the sha256 of each bearer
 * it accepted, never the bearer.
 */
const env = e2eEnv();
const bootstrapToken = process.env.E2E_BOOTSTRAP_TOKEN ?? "";
const fakeMcpUrl = process.env.E2E_FAKE_MCP_URL ?? "";
const seededSha256 = process.env.E2E_FAKE_MCP_BEARER_HASH ?? "";
if (!bootstrapToken || !fakeMcpUrl || !seededSha256) {
  throw new Error(
    "E2E_BOOTSTRAP_TOKEN, E2E_FAKE_MCP_URL and E2E_FAKE_MCP_BEARER_HASH are unset: run tests/e2e/run.sh",
  );
}
const TIMEOUT = 600_000;
const WEM = /wem_[A-Za-z0-9_-]{8,}/;

const card = {
  role: "remote MCP probe",
  instructions: "Call the fake MCP server.",
  language: "en",
  model: "claude-sonnet-5",
  capabilities: {
    tools: ["Bash", "Read"],
    mcp: [{ server: "fake" }],
    forbidden: [],
    credential_refs: ["mcp/fake"],
    tool_policy: {
      per_tool: { mcp__fake__whoami: "allow", mcp__fake__other: "deny" },
    },
  },
  rules: [],
};

let cookie = "";
let api: Api;
// The key that starts a session never answers it (GA-8), so another answers.
let approver: Api;
let agentId = "";
let releaseId = "";
let bindingId = "";

async function web<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T; headers: Headers }> {
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
  return {
    status: response.status,
    headers: response.headers,
    body: (text === "" ? null : JSON.parse(text)) as T,
  };
}

async function fakeMcp(): Promise<{
  calls: number;
  authorization_sha256: string[];
}> {
  return (await fetch(`${fakeMcpUrl}/calls`)).json() as never;
}

const started: string[] = [];

async function startSession(steps: Step[], id: string) {
  const response = await api.request<
    { session_id: string; turn_id: string } & ErrorBody
  >("POST", "/v1/sessions", {
    repository_id: REPOSITORY_ID,
    message: scripted(id, steps, `${id} done`),
    agent_release_id: releaseId,
  });
  if (response.status === 201) started.push(response.body.session_id);
  return response;
}

// The suites after this one need the execution slots back.
afterAll(async () => {
  for (const sessionId of started) {
    const { revision } = await api.session(sessionId);
    await api.control(sessionId, "terminate", {
      expected_revision: revision,
      reason: "e2e",
    });
  }
}, TIMEOUT);

/**
 * Settles a turn, allowing each permission request as it comes; `before`
 * runs ahead of the answer to the n-th one (0-based). The fake-messages connection
 * runs `permission_mode: default` (no auto mode), so a pinned tool still asks.
 */
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

async function toolResults(
  sessionId: string,
  turnId = "1",
): Promise<SseEvent[]> {
  const events = await api.events(
    sessionId,
    (event) => event.event === "result" && event.data.turn_id === turnId,
  );
  return events.filter(
    (event) => event.event === "tool_result" && event.data.turn_id === turnId,
  );
}

function textOf(event: SseEvent | undefined): string {
  const content = event?.data.data.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

beforeAll(async () => {
  cookie = await firstOwnerCookie(env.apiUrl, bootstrapToken);
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
  api = new Api({ ...env, apiKey: key.body.secret });

  const approverKey = await web<{ secret: string }>("POST", "/v1/api-keys", {
    kind: "personal",
    scopes: ["sessions:read", "sessions:approve"],
  });
  expect(approverKey.status).toBe(201);
  approver = new Api({ ...env, apiKey: approverKey.body.secret });

  const team = await web<{ team: { id: string } }>("POST", "/v1/teams", {
    name: "mcpprobe",
  });
  expect(team.status).toBe(201);
  const created = await web<{
    agent: { id: string };
    versions: { id: string }[];
  }>("POST", "/v1/agents", {
    slug: "mcpprobe",
    name: "mcpprobe",
    managing_team_id: team.body.team.id,
    card,
  });
  expect(created.status).toBe(201);
  agentId = created.body.agent.id;
  const released = await web<{
    release: { id: string; effective_tools: unknown };
  }>("POST", `/v1/agents/${agentId}/releases`, {
    version_id: created.body.versions[0]?.id,
    connection_id: "fake-messages",
    repository_id: REPOSITORY_ID,
  });
  expect(released.status).toBe(200);
  releaseId = released.body.release.id;
  expect(released.body.release.effective_tools).toEqual({
    tools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash", "AskUserQuestion"],
    mcp: ["mcp__fake__whoami"],
  });
  const activate = () =>
    web<ErrorBody>("POST", `/v1/agents/${agentId}/activate`, {
      release_id: releaseId,
      expected_revision: -1,
    });
  expect((await activate()).status).toBe(409);
  const bound = await web<{ binding: { id: string } }>(
    "POST",
    `/v1/agents/${agentId}/credential-bindings`,
    { credential_ref: "mcp/fake" },
  );
  expect(bound.status).toBe(200);
  bindingId = bound.body.binding.id;
  expect((await activate()).status).toBe(200);
}, TIMEOUT);

describe("remote MCP with the agent's service account", () => {
  test(
    "the pinned tool answers, called with the seeded service-account bearer, and no egress token reaches the worker",
    async () => {
      const before = await fakeMcp();
      const started = await startSession(
        [{ tool: "mcp__fake__whoami", input: {} }],
        "mcp-whoami",
      );
      expect(started.status).toBe(201);
      const sessionId = started.body.session_id;
      expect((await settle(sessionId, "1")).status).toBe("completed");
      const [result] = await toolResults(sessionId);
      expect(textOf(result)).toContain("ok:fake-mcp");
      const after = await fakeMcp();
      expect(after.calls).toBe(before.calls + 1);
      expect(after.authorization_sha256).toEqual([seededSha256]);

      // The pattern below does not match itself. The planted file is the
      // control: a scan that cannot see shows files=0 and fails.
      const scan = [
        "pattern='wem_[A-Za-z0-9_-]{8,}'",
        "printf 'wem_%s\\n' plantedcontrol > /tmp/scan-control",
        'n() { grep -aoE "$pattern" | wc -l | tr -d " "; }',
        'echo "env=$(env | n)"',
        'echo "proc=$(for p in /proc/[0-9]*; do cat $p/environ $p/cmdline 2>/dev/null; echo; done | n)"',
        'echo "files=$(grep -raoE "$pattern" /workspace "$HOME" /tmp 2>/dev/null | wc -l | tr -d " ")"',
      ].join("\n");
      await api.send(sessionId, scripted("mcp-scan", [bash(scan)], "scanned"));
      expect((await settle(sessionId, "2")).status).toBe("completed");
      const [counts] = await toolResults(sessionId, "2");
      expect(textOf(counts)).toMatch(/env=0\s+proc=0\s+files=1/);
      const stream = await api.events(
        sessionId,
        (event) => event.event === "result" && event.data.turn_id === "2",
      );
      expect(JSON.stringify(stream)).not.toMatch(WEM);
    },
    TIMEOUT,
  );

  test(
    "a tool outside the pin is refused: the engine never has it, and the proxy route wants the attempt's token",
    async () => {
      const before = await fakeMcp();
      const direct = [
        'for auth in "" "Bearer wem_forged0000000000"; do',
        '  bun -e \'const a = process.argv[1]; const r = await fetch("http://egress-proxy:3129/mcp/fake", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(a ? { authorization: a } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "other", arguments: {} } }) }); console.log("status=" + r.status)\' "$auth"',
        "done",
      ].join("\n");
      const started = await startSession(
        [bash(direct), { tool: "mcp__fake__other", input: {} }],
        "mcp-other",
      );
      expect(started.status).toBe(201);
      const sessionId = started.body.session_id;
      expect((await settle(sessionId, "1")).status).toBe("completed");
      const [curl, other] = await toolResults(sessionId);
      expect(textOf(curl)).toMatch(/status=401\s+status=401/);
      expect(textOf(other)).toContain(
        "No such tool available: mcp__fake__other",
      );
      expect((await fakeMcp()).calls).toBe(before.calls);
    },
    TIMEOUT,
  );

  test(
    "revoking the binding refuses the next call with one call_mcp receipt, then the session's next message and a new session",
    async () => {
      const before = await fakeMcp();
      const whoami: Step = { tool: "mcp__fake__whoami", input: {} };
      const started = await startSession(
        [whoami, whoami, whoami],
        "mcp-revoke",
      );
      expect(started.status).toBe(201);
      const sessionId = started.body.session_id;
      const turn = await settle(sessionId, "1", {
        // The first call has run; the second waits for its answer.
        1: async () => {
          const revoked = await web(
            "DELETE",
            `/v1/agents/${agentId}/credential-bindings/${bindingId}`,
          );
          expect(revoked.status).toBe(200);
        },
      });
      expect(turn.status).toBe("completed");
      const [first, second, third] = await toolResults(sessionId);
      expect(textOf(first)).toContain("ok:fake-mcp");
      const refused =
        /egress denied: credential_unbound \(receipt ([0-9a-f-]{36})\)/;
      const receiptId = refused.exec(textOf(second))?.[1];
      expect(receiptId).toBeDefined();
      expect(refused.exec(textOf(third))?.[1]).toBe(receiptId);
      expect(second?.data.data.is_error).toBe(true);
      expect((await fakeMcp()).calls).toBe(before.calls + 1);
      expect(await api.receipt(receiptId ?? "")).toMatchObject({
        operation: "call_mcp",
        status: "failed",
        error: { code: "CREDENTIAL_UNBOUND" },
        result: { server_id: "fake", reason: "credential_unbound" },
      });

      const appended = await api.request<{
        error: { code: string; details: { receipt_id: string } };
      }>("POST", `/v1/sessions/${sessionId}/messages`, {
        message: scripted("mcp-append", [], "never"),
      });
      expect(appended.status).toBe(409);
      expect(appended.body.error.code).toBe("CREDENTIAL_UNBOUND");
      expect(
        await api.receipt(appended.body.error.details.receipt_id),
      ).toMatchObject({ operation: "append_message", status: "failed" });

      const again = await startSession([whoami], "mcp-unbound");
      expect(again.status).toBe(409);
      const details = (
        again.body as unknown as {
          error: { code: string; details: { receipt_id: string } };
        }
      ).error;
      expect(details.code).toBe("CREDENTIAL_UNBOUND");
      expect(await api.receipt(details.details.receipt_id)).toMatchObject({
        operation: "create_session",
        status: "failed",
      });
      expect((await fakeMcp()).calls).toBe(before.calls + 1);
    },
    TIMEOUT,
  );
});
