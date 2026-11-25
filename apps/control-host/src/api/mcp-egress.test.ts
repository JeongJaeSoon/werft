import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import * as schema from "@werft-ai/db";
import {
  createPostgresMcpEgressStore,
  createPostgresSessionUnitOfWork,
  createPostgresWorkerUnitOfWork,
} from "@werft-ai/db";
import { fixtureTeam } from "@werft-ai/db/testing/fixture-team";
import { launchSession } from "@werft-ai/db/testing/launches";
import { beforeCatalogRetired } from "@werft-ai/db/testing/retired-catalog";
import {
  releaseSpecColumns,
  TEST_CONNECTION_ID,
  TEST_MODEL,
} from "@werft-ai/db/testing/spec-pins";
import { createLogger } from "@werft-ai/observability";
import {
  createWorkerGateway,
  mcpBinding,
  type SessionCatalog,
} from "@werft-ai/platform";
import { acceptAllCheckpoints } from "@werft-ai/platform/testing/checkpoints";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { testCatalog } from "../testing/catalog.ts";
import {
  createEgressAuthorizer,
  EGRESS_AUTHORIZER_PATH,
} from "./egress-authorizer.ts";

const AUTHORIZER_BEARER = "authorizer-test-value";
const RETIRED = {
  name: "fake",
  url: "http://fake-mcp:4020/mcp",
  credentialRef: "mcp/fake",
};

// A new host: the installation catalog holds no MCP server.
const catalog: SessionCatalog = testCatalog({
  provider: {
    kind: "anthropic",
    endpoint: "https://api.anthropic.invalid",
    auth: {
      kind: "api_key",
      value: "catalog-provider-key",
      ref: { stored: "connection:test-connection" },
    },
  },
  repositories: {
    app: {
      url: "https://git.invalid/agent/app.git",
      branch: "main",
      auth: { kind: "github_app", registered: true } as const,
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
      sessionBudget: { costUsd: 1_000, tokens: null },
      leaseTtlMs: 60_000,
    },
  });
  authorize = createEgressAuthorizer({
    gateway,
    logger: createLogger({ sinks: [] }),
    token: AUTHORIZER_BEARER,
  });
});

afterEach(async () => {
  await client.close();
});

// A session of a release made before migration 0304, whose card names the
// catalog server `fake`; the credential it named was never bound.
async function seeded() {
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
    slug: "mcp-agent",
    name: "mcp agent",
  });
  const releaseId = `rel-${randomUUID()}`;
  await beforeCatalogRetired(db, RETIRED, async () => {
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
    await db.insert(schema.agentReleases).values({
      id: releaseId,
      agentId,
      versionId,
      cardSha256: "0".repeat(64),
      connectionId: TEST_CONNECTION_ID,
      ...releaseSpecColumns({ tools: ["Read"] }),
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
  const claimOnce = () =>
    gateway.bootstrapClaim(
      { kind: "bootstrap" },
      {
        execution_id: launch.executionId,
        execution_generation: launch.generation,
        credential: { kind: "launch_nonce", nonce: launch.nonce },
      },
    );
  return { releaseId, claim: await claimOnce(), claimOnce };
}

function ask(body: unknown) {
  return authorize(
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

const skipped = (sessionId: string) =>
  db
    .select({ payload: schema.events.payload })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.sessionId, sessionId),
        sql`${schema.events.payload} ->> 'subtype' = 'catalog_mcp_skipped'`,
      ),
    );

describe("a session of a release that named a retired catalog server", () => {
  test("starts with that credential unbound, and claims without the server or its tools", async () => {
    const { claim } = await seeded();
    // Only the built-in `werft` server, which every session has.
    expect(
      claim.runtime_config.mcp_servers?.map((server) => server.name),
    ).toEqual(["werft"]);
    expect(claim.runtime_config.tools).toEqual(["Read"]);
  });

  test("is offered the config a claim gave before, for a checkpoint taken with the server, after the one it ran before werft", async () => {
    const { releaseId, claim } = await seeded();
    const [beforeWerft, first] = claim.restore_runtime_configs ?? [];
    expect(beforeWerft?.mcp_servers).toBeUndefined();
    expect(beforeWerft?.tools).toEqual(["Read"]);
    expect(first?.tools).toEqual(["Read", "mcp__fake__whoami"]);
    expect(first?.mcp_servers).toEqual([
      {
        name: "fake",
        endpoint: RETIRED.url,
        binding: mcpBinding(releaseId, "fake", {
          url: RETIRED.url,
          credential_ref: RETIRED.credentialRef,
        }),
        access: { kind: "egress_token", token: expect.any(String) },
      },
    ]);
  });

  test("a call to the server after a restore is refused", async () => {
    const { claim } = await seeded();
    // The attempt's one MCP token, as the restore config names it too.
    const token = claim.runtime_config.mcp_servers?.[0]?.access.token;
    expect(
      claim.restore_runtime_configs?.[1]?.mcp_servers?.[0]?.access.token,
    ).toBe(token);
    const refused = await ask({
      token,
      purpose: "mcp",
      server: "fake",
      rpc: { method: "tools/call", tool: "whoami" },
    });
    // The token is for the built-in `werft` server: the retired one is no
    // server of the session, and the catalog holds none.
    expect(refused.status).toBe(403);
  });

  test("the skip is one line of the session, and a claim again adds none", async () => {
    const { claim, claimOnce } = await seeded();
    expect(await skipped(claim.session_id)).toEqual([
      {
        payload: {
          type: "system",
          subtype: "catalog_mcp_skipped",
          server: "fake",
        },
      },
    ]);
    const again = await claimOnce();
    expect(again.attempt_id).toBe(claim.attempt_id);
    expect(await skipped(claim.session_id)).toHaveLength(1);
  });
});
