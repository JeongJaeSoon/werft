import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { AgentGitHub } from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  createPostgresGitHubMcpStore,
  createPostgresMcpEgressStore,
  createPostgresSessionUnitOfWork,
  createPostgresWorkerUnitOfWork,
} from "@werft-ai/db";
import { fixtureTeam } from "@werft-ai/db/testing/fixture-team";
import { launchSession } from "@werft-ai/db/testing/launches";
import { createLogger } from "@werft-ai/observability";
import {
  acceptAllCheckpoints,
  createGitHubMcpServer,
  createWorkerGateway,
  GITHUB_MCP_UPSTREAM_PATH,
  githubMcpBinding,
  type PushActor,
  type SessionCatalog,
  withSeededInstallation,
} from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import {
  createEgressAuthorizer,
  EGRESS_AUTHORIZER_PATH,
  githubMcpGrantKeyOf,
} from "./egress-authorizer.ts";

const AUTHORIZER_BEARER = "authorizer-bearer-for-tests-0123456789abcdef";
const GRANT_KEY = githubMcpGrantKeyOf({
  hostname: "127.0.0.1",
  port: 1,
  token: AUTHORIZER_BEARER,
});

const catalog: SessionCatalog = withSeededInstallation({
  profiles: {
    coding: {
      runtime_kind: "claude_agent_sdk",
      runtime_version: "0.3.270",
      model: "claude-sonnet-5",
      tools: ["Read"],
      permission_mode: "default",
      provider: {
        kind: "anthropic",
        endpoint: "https://api.anthropic.invalid",
        auth: {
          kind: "api_key",
          value: "catalog-provider-key",
          ref: { value_env: "PROVIDER_KEY" },
        },
      },
    },
  },
  repositories: {
    app: {
      url: "https://git.invalid/agent/app.git",
      branch: "main",
      profiles: ["coding"],
      auth: { kind: "github_app", registered: true } as const,
    },
  },
  mcp_servers: {
    fake: {
      url: "http://fake-mcp:4020/mcp",
      credential_ref: "mcp/fake",
      auth: {
        kind: "bearer",
        value: "service-account-value",
        ref: { value_env: "FAKE_MCP_SA" },
      },
      workspaces: ["default"],
    },
  },
});

const settings = (
  features: Partial<AgentGitHub["features"]> = {},
): AgentGitHub => ({
  repositories: ["app"],
  push_approval: true,
  features: {
    workflows: false,
    actions: false,
    checks: false,
    issues: false,
    review: false,
    ...features,
  },
  actions_allow: [],
});

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let serve: (request: Request) => Promise<Response>;
let gateway: ReturnType<typeof createWorkerGateway>;
let pushes: Array<{ actor: PushActor; sessionId: string }>;

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema });
  pushes = [];
  const store = createPostgresGitHubMcpStore(db);
  gateway = createWorkerGateway({
    work: createPostgresWorkerUnitOfWork(db),
    catalog,
    checkpoints: acceptAllCheckpoints,
    mcp: createPostgresMcpEgressStore(db),
    githubMcp: { store, grantKey: GRANT_KEY },
    options: {
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
      leaseTtlMs: 60_000,
    },
  });
  const unused = async (): Promise<never> => {
    throw new Error("not used");
  };
  serve = createEgressAuthorizer({
    gateway,
    logger: createLogger({ sinks: [] }),
    token: AUTHORIZER_BEARER,
    githubMcp: {
      grantKey: GRANT_KEY,
      handle: createGitHubMcpServer({
        store,
        services: () => ({
          pushRequests: {
            create: unused,
            get: unused,
            snapshot: unused,
            requestIntent: async (actor, sessionId) => {
              pushes.push({ actor, sessionId });
              return { status: "unavailable" } as never;
            },
          },
          pullRequests: {
            schedule: unused,
            open: unused,
            update: unused,
            comment: unused,
            setState: unused,
            merge: unused,
          },
          githubWork: {
            dispatch: unused,
            getRun: unused,
            rerun: unused,
            review: unused,
          },
          attachments: { list: unused, attach: unused },
        }),
      }),
    },
  });
});

afterEach(async () => {
  await client.close();
});

async function seeded(
  options: { github?: AgentGitHub | null; remote?: boolean } = {},
) {
  const github = options.github === undefined ? settings() : options.github;
  const workspaceId = randomUUID();
  await db
    .insert(schema.workspaces)
    .values({ id: workspaceId, slug: "default", name: "default" });
  const userId = randomUUID();
  await db.insert(schema.users).values({
    id: userId,
    email: `${userId}@example.invalid`,
    passwordHash: "argon2id$placeholder",
    displayName: "owner",
  });
  await db
    .insert(schema.memberships)
    .values({ workspaceId, userId, role: "owner" });
  const agentId = randomUUID();
  await db.insert(schema.agents).values({
    id: agentId,
    workspaceId,
    managingTeamId: await fixtureTeam(db, workspaceId),
    slug: "gh-agent",
    name: "gh agent",
  });
  const versionId = randomUUID();
  await db.insert(schema.agentVersions).values({
    id: versionId,
    agentId,
    versionNo: 1,
    card: {
      role: "r",
      instructions: "i",
      model: "claude-sonnet-5",
      capabilities: {
        tools: null,
        mcp: options.remote ? [{ server: "fake" }] : null,
        forbidden: [],
        credential_refs: options.remote ? ["mcp/fake"] : [],
      },
    },
    contentSha256: "0".repeat(64),
  });
  const releaseId = `rel-${randomUUID()}`;
  await db.insert(schema.agentReleases).values({
    id: releaseId,
    agentId,
    versionId,
    cardSha256: "0".repeat(64),
    runtimeProfileId: "coding",
    profileDigest: "digest",
    runtimeConfigSnapshot: { tools: ["Read"] },
    effectiveTools: { tools: ["Read"], mcp: [] },
    policyPins: {
      tools: {
        per_tool: options.remote
          ? { Read: "allow", mcp__fake__whoami: "allow" }
          : { Read: "allow" },
      },
      ...(github === null ? {} : { github }),
    },
  });
  if (options.remote) {
    await db.insert(schema.credentialBindings).values({
      id: randomUUID(),
      workspaceId,
      credentialRef: "mcp/fake",
      target: "agent",
      targetId: agentId,
      boundBy: userId,
    });
  }
  const accepted = await createPostgresSessionUnitOfWork(db).acceptInputAtomic({
    limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
    principal: {
      ownerId: workspaceId,
      actor: {
        principal: { kind: "user", id: userId },
        userId,
        workspaceId,
        apiKeyId: null,
      },
    },
    idempotencyKey: randomUUID(),
    payloadHash: "hash",
    profileId: "coding",
    repository: {
      id: "app",
      url: "https://git.invalid/agent/app.git",
      branch: "main",
    },
    agentReleaseId: releaseId,
    message: "hello",
  });
  if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
  const launch = await launchSession(db, {
    sessionId: accepted.response.session_id,
  });
  const claim = await gateway.bootstrapClaim(
    { kind: "bootstrap" },
    {
      execution_id: launch.executionId,
      execution_generation: launch.generation,
      credential: { kind: "launch_nonce", nonce: launch.nonce },
    },
  );
  const token = claim.runtime_config.mcp_servers?.[0]?.access.token;
  // request_push is an intent of the running turn: give the attempt one.
  await db
    .update(schema.turns)
    .set({ status: "running", attemptId: claim.attempt_id })
    .where(eq(schema.turns.sessionId, claim.session_id));
  return { agentId, userId, releaseId, claim, token };
}

function authorize(body: unknown) {
  return serve(
    new Request(`http://authorizer.invalid${EGRESS_AUTHORIZER_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${AUTHORIZER_BEARER}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

// What the proxy does with a grant: the path on the authorizer, the
// grant's headers in place of the worker's.
async function relay(token: unknown, message: Record<string, unknown>) {
  const granted = await authorize({
    token,
    purpose: "mcp",
    server: "github",
    rpc: {
      method: message.method ?? null,
      tool:
        message.method === "tools/call"
          ? ((message.params as { name: string }).name ?? null)
          : null,
    },
  });
  if (granted.status !== 200) return { status: granted.status, body: null };
  const grant = (await granted.json()) as {
    upstream: { url: string; headers: Array<[string, string]> };
  };
  const answered = await serve(
    new Request(`http://authorizer.invalid${grant.upstream.url}`, {
      method: "POST",
      headers: [
        ["content-type", "application/json"],
        ...grant.upstream.headers,
      ],
      body: JSON.stringify(message),
    }),
  );
  return {
    status: answered.status,
    body: answered.status === 200 ? ((await answered.json()) as unknown) : null,
  };
}

const GITHUB_TOKEN_SHAPES = /ghs_|ghp_|gho_|github_pat_|x-access-token/;

describe("the built-in github MCP server on stored rows", () => {
  test("the claim attaches it with the release's tools, and carries no GitHub token", async () => {
    const { releaseId, claim } = await seeded({
      github: settings({ actions: true }),
    });
    expect(claim.runtime_config.mcp_servers).toEqual([
      expect.objectContaining({
        name: "github",
        binding: githubMcpBinding(releaseId),
        access: { kind: "egress_token", token: expect.any(String) },
      }),
    ]);
    expect(claim.runtime_config.tools).toEqual([
      "Read",
      "mcp__github__request_push",
      "mcp__github__open_pull_request",
      "mcp__github__get_push_request",
      "mcp__github__update_pull_request",
      "mcp__github__comment_pull_request",
      "mcp__github__close_pull_request",
      "mcp__github__reopen_pull_request",
      "mcp__github__merge_pull_request",
      "mcp__github__dispatch_workflow",
      "mcp__github__get_workflow_run",
      "mcp__github__rerun_workflow",
      "mcp__github__list_repositories",
      "mcp__github__attach_repository",
    ]);
    expect(JSON.stringify(claim)).not.toMatch(GITHUB_TOKEN_SHAPES);
  });

  test("beside a catalog server, both share the attempt's token", async () => {
    const { claim } = await seeded({ remote: true });
    const servers = claim.runtime_config.mcp_servers ?? [];
    expect(servers.map((server) => server.name)).toEqual(["fake", "github"]);
    expect(servers[0]?.access.token).toBe(servers[1]?.access.token ?? "");
    const token = servers[0]?.access.token;
    const remote = await authorize({
      token,
      purpose: "mcp",
      server: "fake",
      rpc: { method: "tools/call", tool: "whoami" },
    });
    expect(remote.status).toBe(200);
    const builtin = await relay(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(builtin.status).toBe(200);
  });

  test("a checkpoint made before the server was attached still restores", async () => {
    const { claim } = await seeded({ github: settings({ actions: true }) });
    const { mcp_servers: _servers, ...unattached } = claim.runtime_config;
    expect(claim.restore_runtime_configs).toEqual([
      { ...unattached, tools: ["Read"] },
    ]);
  });

  test("beside a catalog server, the earlier checkpoint names that server alone", async () => {
    const { claim } = await seeded({ remote: true });
    expect(
      claim.restore_runtime_configs?.map((config) => [
        config.mcp_servers?.map((server) => server.name),
        config.tools.filter((tool) => tool.startsWith("mcp__github__")),
      ]),
    ).toEqual([[["fake"], []]]);
  });

  test("a release without GitHub settings attaches no server", async () => {
    const { claim } = await seeded({ github: null });
    expect(claim.runtime_config.mcp_servers).toBeUndefined();
    expect(claim.runtime_config.tools).toEqual(["Read"]);
  });

  test("a call reaches the server for the token's session, as its creator and agent", async () => {
    const { claim, token, agentId, userId } = await seeded();
    expect(
      await authorize({
        token,
        purpose: "mcp",
        server: "github",
        rpc: { method: "initialize", tool: null },
      }).then((response) => response.json()),
    ).toMatchObject({
      session_id: claim.session_id,
      upstream: { url: GITHUB_MCP_UPSTREAM_PATH },
    });
    const listed = await relay(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(
      (
        listed.body as { result: { tools: Array<{ name: string }> } }
      ).result.tools.map((tool) => tool.name),
    ).toEqual([
      "request_push",
      "open_pull_request",
      "get_push_request",
      "update_pull_request",
      "comment_pull_request",
      "close_pull_request",
      "reopen_pull_request",
      "merge_pull_request",
      "list_repositories",
      "attach_repository",
    ]);
    // 94S-1479: what the model reads over the wire says how to read an attach.
    const attach = (
      listed.body as {
        result: { tools: Array<{ name: string; description: string }> };
      }
    ).result.tools.find((tool) => tool.name === "attach_repository");
    expect(attach?.description).toContain(
      "git ls-tree -r <repository_id>/<branch>",
    );
    const called = await relay(token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "request_push", arguments: {} },
    });
    expect(called.status).toBe(200);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.sessionId).toBe(claim.session_id);
    expect(pushes[0]?.actor.caller.actor).toMatchObject({
      principal: { kind: "user", id: userId },
      userId,
      agentId,
    });
  });

  test("a tool of a feature the release turned off is refused at the proxy's question", async () => {
    const { token } = await seeded();
    const refused = await relay(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "dispatch_workflow",
        arguments: { workflow: "ci.yml", ref: "main" },
      },
    });
    expect(refused.status).toBe(403);
  });

  test("switching GitHub off refuses the next exchange", async () => {
    const { token, agentId } = await seeded();
    await db
      .update(schema.agents)
      .set({ githubEnabled: false })
      .where(eq(schema.agents.id, agentId));
    const refused = await relay(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(refused.status).toBe(403);
  });

  test("the server's route takes only a signed grant and one POSTed message", async () => {
    const { token } = await seeded();
    const unsigned = await serve(
      new Request(`http://authorizer.invalid${GITHUB_MCP_UPSTREAM_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${AUTHORIZER_BEARER}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(unsigned.status).toBe(401);
    const granted = (await (
      await authorize({
        token,
        purpose: "mcp",
        server: "github",
        rpc: { method: null, tool: null },
      })
    ).json()) as { upstream: { headers: Array<[string, string]> } };
    const headers = granted.upstream.headers;
    expect(
      (
        await serve(
          new Request(`http://authorizer.invalid${GITHUB_MCP_UPSTREAM_PATH}`, {
            method: "GET",
            headers,
          }),
        )
      ).status,
    ).toBe(405);
    expect(
      (
        await serve(
          new Request(`http://authorizer.invalid${GITHUB_MCP_UPSTREAM_PATH}`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              jsonrpc: "2.0",
              method: "notifications/initialized",
            }),
          }),
        )
      ).status,
    ).toBe(202);
  });
});
