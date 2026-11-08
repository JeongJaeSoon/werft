import { describe, expect, test } from "bun:test";
import { WorkerGatewayRequestError } from "@werft-ai/runtime-core";

import { WORKER_CAPABILITIES } from "./capabilities.ts";
import { HttpWorkerGatewayClient } from "./gateway-client.ts";

type Sent = { path: string; body: { capabilities?: Record<string, unknown> } };

const claimRequest = {
  capabilities: WORKER_CAPABILITIES,
  execution_id: "exec-1",
  execution_generation: 2,
  credential: { kind: "launch_nonce" as const, nonce: "nonce-1" },
};

const claimAnswer = {
  session_id: "11111111-1111-4111-8111-111111111111",
  turn_id: null,
  attempt_id: "att_1",
  lease_epoch: 1,
  execution_generation: 2,
  auth_revision: 0,
  session_credential: "session-token",
  lease_expires_at: new Date().toISOString(),
  lease_remaining_ms: 30_000,
  runtime: { kind: "claude_agent_sdk", version: "0.3.270", profile_id: "p" },
  profile_fingerprint: `sha256:${"0".repeat(64)}`,
  runtime_config: {
    model: "claude-sonnet-4-5",
    tools: [],
    permission_mode: "default",
    provider: {
      kind: "litellm",
      endpoint: "http://litellm:4000",
      auth: { kind: "egress_token", token: "egress-token" },
    },
  },
  workspace: {
    repository: {
      id: "sample-app",
      url: "https://git.example.test/sample.git",
      branch: "main",
    },
  },
  object_store: { access: { kind: "egress_token", token: "egress-token" } },
  principal: { owner_scope: "owner-a" },
  restore: null,
  remaining_budget_usd: 25,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function badRequest(issues: { path: string; message: string }[] | null) {
  return json(400, {
    error: {
      code: "BAD_REQUEST",
      message: "Request body is invalid",
      retryable: false,
      request_id: "req_1",
      details: issues === null ? null : { issues },
    },
  });
}

// What a control-host from before `platform_tool_trust` answers: its strict
// capabilities object names the key it does not know.
const OLD_SERVER_REFUSAL = [
  {
    path: "capabilities",
    message: 'Unrecognized key: "platform_tool_trust"',
  },
];

function gatewayAgainst(respond: (sent: Sent) => Response) {
  const sent: Sent[] = [];
  const gateway = new HttpWorkerGatewayClient({
    baseUrl: "http://gateway.internal",
    credential: "nonce-1",
    requestTimeoutMs: 1_000,
    fetch: async (input, init) => {
      const entry: Sent = {
        path: new URL(String(input)).pathname,
        body: JSON.parse(String(init?.body ?? "null")),
      };
      sent.push(entry);
      return respond(entry);
    },
  });
  return { gateway, sent };
}

describe("claim against a control-host older than platform_tool_trust", () => {
  test("a new server takes the first claim with the key", async () => {
    const { gateway, sent } = gatewayAgainst(() => json(200, claimAnswer));
    await gateway.bootstrapClaim(claimRequest);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body.capabilities).toEqual({
      approval_remember: true,
      platform_tool_trust: true,
    });
  });

  test("an old server's refusal is answered by claiming again without the key", async () => {
    const { gateway, sent } = gatewayAgainst((request) =>
      request.body.capabilities?.platform_tool_trust === undefined
        ? json(200, claimAnswer)
        : badRequest(OLD_SERVER_REFUSAL),
    );
    const claim = await gateway.bootstrapClaim(claimRequest);
    expect(claim.session_credential).toBe("session-token");
    expect(sent.map((entry) => entry.body.capabilities)).toEqual([
      { approval_remember: true, platform_tool_trust: true },
      { approval_remember: true },
    ]);
  });

  test("the pending-control poll drops the key from then on, without asking again", async () => {
    const answer = { answers: [], control: null, next_poll_ms: 1_000 };
    const { gateway, sent } = gatewayAgainst((request) =>
      request.body.capabilities?.platform_tool_trust === undefined
        ? json(200, answer)
        : badRequest(OLD_SERVER_REFUSAL),
    );
    const scope = {
      session_id: claimAnswer.session_id,
      turn_id: null,
      attempt_id: "att_1",
      lease_epoch: 1,
      execution_generation: 2,
      auth_revision: 0,
      capabilities: WORKER_CAPABILITIES,
      answers_after: 0,
    };
    await gateway.pendingControl(scope);
    await gateway.pendingControl(scope);
    expect(sent.map((entry) => entry.body.capabilities)).toEqual([
      { approval_remember: true, platform_tool_trust: true },
      { approval_remember: true },
      { approval_remember: true },
    ]);
  });

  test.each([
    ["another field", [{ path: "execution_id", message: "Required" }]],
    [
      "another capability key",
      [{ path: "capabilities", message: 'Unrecognized key: "other_key"' }],
    ],
    [
      "the key at another path",
      [
        {
          path: "credential",
          message: 'Unrecognized key: "platform_tool_trust"',
        },
      ],
    ],
    ["no structured issues", null],
  ])("a 400 over %s is thrown as it is", async (_name, issues) => {
    const { gateway, sent } = gatewayAgainst(() => badRequest(issues));
    const error = await gateway.bootstrapClaim(claimRequest).catch((e) => e);
    expect(error).toBeInstanceOf(WorkerGatewayRequestError);
    expect(error.code).toBe("BAD_REQUEST");
    expect(sent).toHaveLength(1);
  });

  test("a second refusal after the retry is thrown, not looped", async () => {
    const { gateway, sent } = gatewayAgainst(() =>
      badRequest(OLD_SERVER_REFUSAL),
    );
    const error = await gateway.bootstrapClaim(claimRequest).catch((e) => e);
    expect(error).toBeInstanceOf(WorkerGatewayRequestError);
    expect(sent).toHaveLength(2);
  });
});

describe("claim against a control-host older than user_env", () => {
  const withUserEnv = {
    ...claimRequest,
    capabilities: { ...WORKER_CAPABILITIES, user_env: true as const },
  };
  const refusing = (...keys: string[]) => [
    {
      path: "capabilities",
      message: `Unrecognized key${keys.length > 1 ? "s" : ""}: ${keys
        .map((key) => `"${key}"`)
        .join(", ")}`,
    },
  ];
  const lacks = (sent: Sent, key: string) =>
    sent.body.capabilities?.[key] === undefined;

  test("an old server's refusal is answered by claiming again without user_env only", async () => {
    const { gateway, sent } = gatewayAgainst((request) =>
      lacks(request, "user_env")
        ? json(200, claimAnswer)
        : badRequest(refusing("user_env")),
    );
    await gateway.bootstrapClaim(withUserEnv);
    expect(sent.map((entry) => entry.body.capabilities)).toEqual([
      { approval_remember: true, platform_tool_trust: true, user_env: true },
      { approval_remember: true, platform_tool_trust: true },
    ]);
  });

  test("a server that knows neither key is answered once with both dropped", async () => {
    const { gateway, sent } = gatewayAgainst((request) =>
      lacks(request, "user_env") && lacks(request, "platform_tool_trust")
        ? json(200, claimAnswer)
        : badRequest(refusing("platform_tool_trust", "user_env")),
    );
    await gateway.bootstrapClaim(withUserEnv);
    expect(sent.map((entry) => entry.body.capabilities)).toEqual([
      { approval_remember: true, platform_tool_trust: true, user_env: true },
      { approval_remember: true },
    ]);
  });

  test("a refused key stays off for the next request, without asking again", async () => {
    const { gateway, sent } = gatewayAgainst((request) =>
      lacks(request, "user_env")
        ? json(200, claimAnswer)
        : badRequest(refusing("user_env")),
    );
    await gateway.bootstrapClaim(withUserEnv);
    await gateway.bootstrapClaim(withUserEnv);
    expect(sent).toHaveLength(3);
    expect(lacks(sent[2] as Sent, "user_env")).toBe(true);
  });

  test("a worker that did not announce user_env never loses it to a refusal", async () => {
    const { gateway, sent } = gatewayAgainst(() =>
      badRequest(refusing("user_env")),
    );
    const error = await gateway.bootstrapClaim(claimRequest).catch((e) => e);
    expect(error).toBeInstanceOf(WorkerGatewayRequestError);
    expect(sent).toHaveLength(1);
  });
});
