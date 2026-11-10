import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import * as schema from "@werft-ai/db";
import {
  createPostgresMcpEgressStore,
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
  createPostgresWorkerUnitOfWork,
} from "@werft-ai/db";
import { fixtureTeam } from "@werft-ai/db/testing/fixture-team";
import { launchSession } from "@werft-ai/db/testing/launches";
import { createLogger } from "@werft-ai/observability";
import {
  acceptAllCheckpoints,
  createWorkerGateway,
  mcpBinding,
  type SessionCatalog,
} from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import {
  createEgressAuthorizer,
  EGRESS_AUTHORIZER_PATH,
} from "./egress-authorizer.ts";
import { testCatalog } from "../test-support/catalog.ts";
import { TEST_MODEL, releaseSpecColumns, TEST_CONNECTION_ID } from "@werft-ai/db/testing/spec-pins";

const AUTHORIZER_TOKEN = "authorizer-token-of-at-least-32-characters";
const SERVICE_ACCOUNT = "sa-value-kept-from-the-worker";

const catalog: SessionCatalog = testCatalog({
provider: {
        kind: "anthropic",
        endpoint: "https://api.anthropic.invalid",
        auth: {
          kind: "api_key",
          value: "catalog-provider-key",
          ref: { value_env: "PROVIDER_KEY" },
        },
      },
repositories: {
    app: {
      url: "https://git.invalid/agent/app.git",
      branch: "main",
      auth: { kind: "github_app", registered: true } as const,
    },
  },
mcp_servers: {
    fake: {
      url: "http://fake-mcp:4020/mcp",
      credential_ref: "mcp/fake",
      auth: {
        kind: "bearer",
        value: SERVICE_ACCOUNT,
        ref: { value_env: "FAKE_MCP_SA" },
      },
      workspaces: ["default"],
    },
  },
});

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let authorize: (request: Request) => Promise<Response>;
let gateway: ReturnType<typeof createWorkerGateway>;

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema });
  gateway = createWorkerGateway({
    work: createPostgresWorkerUnitOfWork(db),
    catalog,
    checkpoints: acceptAllCheckpoints,
    mcp: createPostgresMcpEgressStore(db),
    options: {
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
      leaseTtlMs: 60_000,
    },
  });
  authorize = createEgressAuthorizer({
    gateway,
    logger: createLogger({ sinks: [] }),
    token: AUTHORIZER_TOKEN,
  });
});

afterEach(async () => {
  await client.close();
});

async function seeded(slug = "default") {
  const workspaceId = randomUUID();
  await db
    .insert(schema.workspaces)
    .values({ id: workspaceId, slug, name: slug });
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
    slug: "mcp-agent",
    name: "mcp agent",
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
        mcp: [{ server: "fake" }],
        forbidden: [],
        credential_refs: ["mcp/fake"],
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
    connectionId: TEST_CONNECTION_ID,
    ...releaseSpecColumns(),
    runtimeConfigSnapshot: { tools: ["Read"] },
    effectiveTools: { tools: ["Read"], mcp: ["mcp__fake__whoami"] },
    policyPins: {
      tools: {
        per_tool: {
          Read: "allow",
          mcp__fake__whoami: "allow",
          mcp__fake__other: "ask",
        },
      },
    },
  });
  const bindingId = randomUUID();
  await db.insert(schema.credentialBindings).values({
    id: bindingId,
    workspaceId,
    credentialRef: "mcp/fake",
    target: "agent",
    targetId: agentId,
    boundBy: userId,
  });
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
    model: TEST_MODEL,
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
  return { workspaceId, releaseId, bindingId, claim };
}

function ask(body: unknown) {
  return authorize(
    new Request(`http://authorizer.invalid${EGRESS_AUTHORIZER_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${AUTHORIZER_TOKEN}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

const whoami = { method: "tools/call", tool: "whoami" };

describe("the remote MCP route on stored rows", () => {
  test("the claim carries the server and a route token, never the bearer", async () => {
    const { releaseId, claim } = await seeded();
    const [mcp] = claim.runtime_config.mcp_servers ?? [];
    expect(mcp).toMatchObject({
      name: "fake",
      endpoint: "http://fake-mcp:4020/mcp",
      binding: mcpBinding(
        releaseId,
        "fake",
        catalog.mcp_servers?.fake ?? {
          url: "",
          credential_ref: "",
        },
      ),
      access: { kind: "egress_token" },
    });
    expect(mcp?.access.token).toStartWith("wem_");
    expect(claim.runtime_config.tools).toEqual(["Read", "mcp__fake__whoami"]);
    expect(JSON.stringify(claim)).not.toContain(SERVICE_ACCOUNT);

    const granted = await ask({
      token: mcp?.access.token,
      purpose: "mcp",
      server: "fake",
      rpc: whoami,
    });
    expect(granted.status).toBe(200);
    expect(await granted.json()).toMatchObject({
      session_id: claim.session_id,
      upstream: {
        url: "http://fake-mcp:4020/mcp",
        headers: [["authorization", `Bearer ${SERVICE_ACCOUNT}`]],
      },
    });
    expect(
      (await ask({ token: mcp?.access.token, purpose: "provider" })).status,
    ).toBe(401);
    const other = await ask({
      token: mcp?.access.token,
      purpose: "mcp",
      server: "fake",
      rpc: { method: "tools/call", tool: "other" },
    });
    expect(other.status).toBe(403);
    expect(await other.json()).not.toHaveProperty("receipt_id");
  });

  test("an unbound credential is refused with one retrievable failed receipt", async () => {
    const { workspaceId, bindingId, claim } = await seeded();
    const token = claim.runtime_config.mcp_servers?.[0]?.access.token;
    await db
      .update(schema.credentialBindings)
      .set({ revokedAt: new Date() })
      .where(eq(schema.credentialBindings.id, bindingId));
    const body = { token, purpose: "mcp", server: "fake", rpc: whoami };
    const refused = await ask(body);
    expect(refused.status).toBe(403);
    const answer = (await refused.json()) as {
      code: string;
      receipt_id: string;
    };
    expect(answer.code).toBe("CREDENTIAL_UNBOUND");
    const again = (await (await ask(body)).json()) as { receipt_id: string };
    expect(again.receipt_id).toBe(answer.receipt_id);

    const stored = await db
      .select()
      .from(schema.receipts)
      .where(eq(schema.receipts.operation, "call_mcp"));
    expect(stored).toHaveLength(1);
    const receipt = await createPostgresSessionReader(db).getReceipt(
      workspaceId,
      answer.receipt_id,
    );
    expect(receipt).toMatchObject({
      id: answer.receipt_id,
      operation: "call_mcp",
      status: "failed",
      target_ref: { session_id: claim.session_id },
      error: { code: "CREDENTIAL_UNBOUND" },
    });
    expect(JSON.stringify(receipt)).not.toContain(SERVICE_ACCOUNT);
  });

  test("a workspace the catalog does not list is refused the same way", async () => {
    const { claim } = await seeded("elsewhere");
    const refused = await ask({
      token: claim.runtime_config.mcp_servers?.[0]?.access.token,
      purpose: "mcp",
      server: "fake",
      rpc: whoami,
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      code: "CREDENTIAL_UNBOUND",
      receipt_id: expect.any(String),
    });
  });
});
