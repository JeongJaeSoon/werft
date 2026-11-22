import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { agentSummaries } from "./agent-summaries.ts";
import { retiredSessionMcpOf } from "./github/mcp-egress.ts";
import { migrate } from "./migrate.ts";
import { MIGRATIONS_FOLDER } from "./migration-journal.ts";
import { credentialsAllowed } from "./musterrolle/administers.ts";
import { sessionReach, startReach } from "./musterrolle/agent-caller-limits.ts";
import { lockUnboundRefs } from "./musterrolle/credential-bindings.ts";
import * as schema from "./schema.ts";
import { fixtureTeamSql } from "./testing/fixture-team.ts";
import { migrationsThrough } from "./testing/migrations-through.ts";
import {
  RELEASE_SPEC_SQL_COLUMNS,
  releaseSpecSqlValues,
  sessionPinColumns,
} from "./testing/spec-pins.ts";

const READ = "mcp__docs__read";
const SEARCH = "mcp__docs__search";
// Before any retire this test runs, after none.
const BEFORE_RETIRE = new Date("2000-01-01T00:00:00Z");

/**
 * Releases made while the installation catalog MCP lived, read after 0303
 * retired it: the session projection leaves the server, its tools and its
 * credential name out, and a restore still rebuilds what a claim gave.
 */
describe("a release that named a retired catalog server", () => {
  let client: PGlite;
  let db: PgliteDatabase<typeof schema>;
  let before: string;
  const workspaceId = randomUUID();
  const followsRelease = randomUUID();
  const narrowed = randomUUID();
  const unrecorded = randomUUID();
  const ownerId = randomUUID();
  const releaseOf = (agentId: string) =>
    `sha256:${agentId.replaceAll("-", "")}`;

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    before = migrationsThrough("0303_retire_catalog_mcp", { exclusive: true });
    await migrate(drizzle(client), { migrationsFolder: before });

    await client.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, 'acme', 'acme')",
      [workspaceId],
    );
    const team = await fixtureTeamSql(client, workspaceId);
    for (const [agentId, server] of [
      [followsRelease, "docs"],
      [narrowed, "docs"],
      [unrecorded, "gone"],
    ] as const) {
      const versionId = randomUUID();
      await client.query(
        "INSERT INTO agents (id, workspace_id, slug, name, managing_team_id) VALUES ($1, $2, $3, $3, $4)",
        [agentId, workspaceId, `a-${agentId.slice(0, 8)}`, team],
      );
      await client.query(
        `INSERT INTO agent_versions (id, agent_id, version_no, card, content_sha256)
         VALUES ($1, $2, 1, $3, $4)`,
        [
          versionId,
          agentId,
          JSON.stringify({
            capabilities: {
              tools: null,
              mcp: [{ server }],
              forbidden: [],
              credential_refs: [`${server}-ref`, "other-ref"],
            },
          }),
          "1".repeat(64),
        ],
      );
      await client.query(
        `INSERT INTO agent_releases (id, agent_id, version_id, card_sha256,
           repository_id, runtime_config_snapshot, effective_tools, policy_pins,
           ${RELEASE_SPEC_SQL_COLUMNS})
         VALUES ($1, $2, $3, $4, NULL, '{}', $5, $6, ${releaseSpecSqlValues()})`,
        [
          releaseOf(agentId),
          agentId,
          versionId,
          "a".repeat(64),
          JSON.stringify({
            tools: ["Read"],
            mcp: [`mcp__${server}__read`, `mcp__${server}__search`],
          }),
          JSON.stringify({
            tools: {
              default: { builtin: "allow", mcp: "ask" },
              per_tool: {
                [`mcp__${server}__read`]: "allow",
                [`mcp__${server}__search`]: "allow",
              },
            },
          }),
        ],
      );
      await client.query(
        "UPDATE agents SET active_release_id = $1, activation_revision = 1 WHERE id = $2",
        [releaseOf(agentId), agentId],
      );
    }
    // `gone` was never a catalog row 0303 recorded.
    await client.query(
      `INSERT INTO mcp_servers (id, url, credential_ref, auth, credential_source,
         workspaces, origin)
       VALUES ('docs', 'https://docs.example.invalid/mcp', 'docs-ref', $1, 'stored', '["acme"]', 'import'),
              ('search', 'https://search.example.invalid/mcp', 'search-ref', $2, 'stored', '["acme"]', 'import')`,
      [
        JSON.stringify({ kind: "bearer", stored: "mcp:docs" }),
        JSON.stringify({ kind: "bearer", stored: "mcp:search" }),
      ],
    );
    // A person narrowed one agent's selection to a single tool.
    await client.query(
      `INSERT INTO agent_mcp_settings (agent_id, workspace_id, server, allowed_tools, credential_refs, updated_by)
       VALUES ($1, $2, 'docs', $3, '["docs-ref"]', $4)`,
      [narrowed, workspaceId, JSON.stringify([READ]), randomUUID()],
    );

    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });

    await db.insert(schema.users).values({
      id: ownerId,
      email: `${ownerId}@example.test`,
      passwordHash: "x",
      displayName: "owner",
    });
    await db
      .insert(schema.memberships)
      .values({ workspaceId, userId: ownerId, role: "owner" });
    // Workspace rules: the retired server's name, the unrecorded server's
    // name, and a name the card still needs.
    await db
      .insert(schema.agentUsage)
      .values(
        [followsRelease, unrecorded, narrowed].map((agentId) => ({
          agentId,
          workspaceId,
        })),
      )
      .onConflictDoNothing();
    await db.insert(schema.agentCallerLimits).values([
      {
        agentId: followsRelease,
        workspaceId,
        targetKind: "workspace",
        credentialsDeny: ["docs-ref"],
      },
      {
        agentId: unrecorded,
        workspaceId,
        targetKind: "workspace",
        credentialsDeny: ["gone-ref"],
      },
      {
        agentId: narrowed,
        workspaceId,
        targetKind: "workspace",
        credentialsDeny: ["other-ref"],
      },
    ]);
  });

  afterAll(async () => {
    await client.close();
    rmSync(before, { recursive: true, force: true });
  });

  test("a session start needs the card's other names bound, not the retired server's", async () => {
    expect(
      await lockUnboundRefs(db, {
        workspaceId,
        releaseId: releaseOf(followsRelease),
      }),
    ).toEqual(["other-ref"]);
    // A server 0303 did not record keeps its name counted.
    expect(
      await lockUnboundRefs(db, {
        workspaceId,
        releaseId: releaseOf(unrecorded),
      }),
    ).toEqual(["gone-ref", "other-ref"]);
  });

  test.each([
    ["the card's server", "docs"],
    ["another catalog server", "search"],
  ])(
    "a running session started on a narrower selection of %s still needs only the names it started with, less that server's",
    async (_, server) => {
      const sessionId = randomUUID();
      const mcpStart = {
        server,
        allowed_tools: [`mcp__${server}__read`],
        credential_refs: [`${server}-ref`],
        revision: 1,
      };
      await db.insert(schema.sessions).values({
        id: sessionId,
        ownerId: workspaceId,
        workspaceId,
        agentReleaseId: releaseOf(followsRelease),
        repoUrl: "https://example.invalid/a.git",
        branch: "main",
        repositoryId: "repo-a",
        mcpStart,
        ...sessionPinColumns(),
      });
      expect(
        await lockUnboundRefs(db, {
          workspaceId,
          releaseId: releaseOf(followsRelease),
          sessionId,
        }),
      ).toEqual([]);
      const reach = await sessionReach(db, {
        agentReleaseId: releaseOf(followsRelease),
        repositoryId: null,
        attachedRepositoryIds: [],
        mcpStart,
        workspaceMcpStart: null,
        githubPolicySource: "release",
        githubPolicyStart: null,
      });
      expect(reach?.credentials).toEqual([]);
    },
  );

  test("the caller limit reach holds neither the retired server, its tools nor its name", async () => {
    const reach = await startReach(db, {
      releaseId: releaseOf(followsRelease),
      workspaceMcpStart: null,
      githubPolicySource: "release",
      repositoryIds: [],
    });
    expect(reach).toEqual({
      tools: ["Read"],
      repositories: [],
      mcp_servers: [],
      credentials: ["other-ref"],
    });
  });

  test("a restore rebuilds the server a claim gave: the release's pins, or the snapshot narrowed by the retired selection", async () => {
    expect(
      await retiredSessionMcpOf(db, {
        agentReleaseId: releaseOf(followsRelease),
        mcpStart: null,
        createdAt: BEFORE_RETIRE,
      }),
    ).toEqual({
      releaseId: releaseOf(followsRelease),
      server: "docs",
      url: "https://docs.example.invalid/mcp",
      credentialRef: "docs-ref",
      tools: [READ, SEARCH],
      restorable: true,
    });
    // Without a snapshot a person's row narrows the release's pins.
    expect(
      (
        await retiredSessionMcpOf(db, {
          agentReleaseId: releaseOf(narrowed),
          mcpStart: null,
          createdAt: BEFORE_RETIRE,
        })
      )?.tools,
    ).toEqual([READ]);
    // With one, the tools are what the snapshot and the row both allow.
    expect(
      (
        await retiredSessionMcpOf(db, {
          agentReleaseId: releaseOf(narrowed),
          mcpStart: {
            server: "docs",
            allowed_tools: [READ, SEARCH],
            credential_refs: ["docs-ref"],
            revision: 1,
          },
          createdAt: BEFORE_RETIRE,
        })
      )?.tools,
    ).toEqual([READ]);
  });

  test("a caller rule denying the retired server's name hides no agent from the usable list; one denying another name does", async () => {
    const usable = await db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.workspaceId, workspaceId),
          credentialsAllowed(workspaceId, null, schema.agents.id),
        ),
      );
    expect(usable.map((row) => row.id)).toEqual([followsRelease]);
  });

  test("an agent summary shows neither the retired server nor its name", async () => {
    const summaries = await agentSummaries(
      db,
      workspaceId,
      [followsRelease, unrecorded],
      { userId: ownerId, apiKeyId: null },
    );
    expect(summaries.get(followsRelease)?.version).toMatchObject({
      mcp_servers: [],
      credential_refs: ["other-ref"],
    });
    expect(summaries.get(unrecorded)?.version).toMatchObject({
      mcp_servers: [],
      credential_refs: ["gone-ref", "other-ref"],
    });
  });

  test("a session created after the retire is not restorable to the retired server", async () => {
    expect(
      (
        await retiredSessionMcpOf(db, {
          agentReleaseId: releaseOf(followsRelease),
          mcpStart: null,
          createdAt: new Date(Date.now() + 60_000),
        })
      )?.restorable,
    ).toBe(false);
  });

  test("a server 0303 did not record gives no restore entry", async () => {
    expect(
      await retiredSessionMcpOf(db, {
        agentReleaseId: releaseOf(unrecorded),
        mcpStart: null,
        createdAt: BEFORE_RETIRE,
      }),
    ).toBeNull();
  });
});
