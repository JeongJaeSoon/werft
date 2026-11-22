import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "./migrate.ts";
import { MIGRATIONS_FOLDER } from "./migration-journal.ts";
import { fixtureTeamSql } from "./testing/fixture-team.ts";
import { migrationsThrough } from "./testing/migrations-through.ts";
import {
  RELEASE_SPEC_SQL_COLUMNS,
  releaseSpecSqlValues,
} from "./testing/spec-pins.ts";

/**
 * 0303 deletes the installation catalog's MCP servers, their stored values
 * and the agents' catalog selections, keeps what a restore needs, and
 * refuses every later write that would bring a catalog entry back.
 */
describe("0303 retires the installation catalog MCP", () => {
  let client: PGlite;
  let before: string;
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  const catalogVersionId = randomUUID();
  const plainVersionId = randomUUID();
  const releaseId = `sha256:${"c".repeat(64)}`;
  const plainReleaseId = `sha256:${"p".repeat(64)}`;
  const CATALOG_CARD = {
    capabilities: { mcp: [{ server: "docs" }], credential_refs: ["docs-ref"] },
  };

  const count = async (sql: string, params: unknown[] = []) =>
    Number(
      ((await client.query(sql, params)).rows[0] as { n: number | string }).n,
    );
  const insertRelease = (id: string, versionId: string) =>
    client.query(
      `INSERT INTO agent_releases (id, agent_id, version_id, card_sha256,
         repository_id, runtime_config_snapshot, effective_tools, policy_pins,
         ${RELEASE_SPEC_SQL_COLUMNS})
       VALUES ($1, $2, $3, $4, 'sample-app', '{}', '{}', '{}',
         ${releaseSpecSqlValues({
           connection: {
             id: "c",
             kind: "anthropic",
             endpoint: "https://api.anthropic.invalid",
             billing: "per_token",
           },
         })})`,
      [id, agentId, versionId, "a".repeat(64)],
    );

  beforeAll(async () => {
    client = new PGlite();
    before = migrationsThrough("0303_retire_catalog_mcp", { exclusive: true });
    await migrate(drizzle(client), { migrationsFolder: before });

    await client.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, 'acme', 'acme')",
      [workspaceId],
    );
    const team = await fixtureTeamSql(client, workspaceId);
    for (const [id, slug] of [
      [agentId, "bot"],
      [otherAgentId, "other"],
    ] as const) {
      await client.query(
        "INSERT INTO agents (id, workspace_id, slug, name, managing_team_id) VALUES ($1, $2, $3, $3, $4)",
        [id, workspaceId, slug, team],
      );
    }
    await client.query(
      `INSERT INTO agent_versions (id, agent_id, version_no, card, content_sha256)
       VALUES ($1, $2, 1, $3, $4), ($5, $2, 2, '{"capabilities":{"mcp":null}}', $6)`,
      [
        catalogVersionId,
        agentId,
        JSON.stringify(CATALOG_CARD),
        "1".repeat(64),
        plainVersionId,
        "2".repeat(64),
      ],
    );
    await insertRelease(releaseId, catalogVersionId);
    for (const [id, url, workspaces, disabled] of [
      ["docs", "https://docs.example.invalid/mcp", ["acme"], false],
      ["old", "https://old.example.invalid/mcp", ["acme"], true],
    ] as const) {
      await client.query(
        `INSERT INTO mcp_servers (id, url, credential_ref, auth, credential_source,
           workspaces, origin, disabled_at)
         VALUES ($1, $2, $3, $4, 'stored', $5, 'import', $6)`,
        [
          id,
          url,
          `${id}-ref`,
          JSON.stringify({ kind: "bearer", stored: `mcp:${id}` }),
          JSON.stringify(workspaces),
          disabled ? new Date() : null,
        ],
      );
      await client.query(
        `INSERT INTO secret_values (id, workspace_id, owner_ref, purpose,
           secret_version, key_version, nonce, ciphertext, last4)
         VALUES ($1, $2, $3, 'settings_credential', 1, 1, '\\x00', '\\x00', 'abcd')`,
        [randomUUID(), workspaceId, `mcp:${id}`],
      );
    }
    // A stored value of another kind stays.
    await client.query(
      `INSERT INTO secret_values (id, workspace_id, owner_ref, purpose,
         secret_version, key_version, nonce, ciphertext, last4)
       VALUES ($1, $2, 'connection:c', 'settings_credential', 1, 1, '\\x00', '\\x00', 'abcd')`,
      [randomUUID(), workspaceId],
    );
    await client.query(
      `INSERT INTO agent_mcp_settings (agent_id, workspace_id, server, allowed_tools, credential_refs, updated_by)
       VALUES ($1, $2, 'docs', '["mcp__docs__search"]', '["docs-ref"]', $3),
              ($4, $2, NULL, '[]', '[]', NULL)`,
      [agentId, workspaceId, randomUUID(), otherAgentId],
    );

    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
  });

  afterAll(async () => {
    await client.close();
    rmSync(before, { recursive: true, force: true });
  });

  test("the rows, their values and the selections are gone; other values stay", async () => {
    expect(await count("SELECT count(*) AS n FROM mcp_servers")).toBe(0);
    expect(await count("SELECT count(*) AS n FROM agent_mcp_settings")).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM secret_values WHERE owner_ref LIKE 'mcp:%'",
      ),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM secret_values WHERE owner_ref = 'connection:c'",
      ),
    ).toBe(1);
  });

  test("the restore tables hold every row's name, url and reference, and no value", async () => {
    const servers = await client.query(
      "SELECT * FROM retired_catalog_mcp ORDER BY name",
    );
    expect(
      servers.rows.map((row) => {
        const { retired_at: _, ...rest } = row as Record<string, unknown>;
        return rest;
      }),
    ).toEqual([
      {
        name: "docs",
        url: "https://docs.example.invalid/mcp",
        credential_ref: "docs-ref",
      },
      {
        name: "old",
        url: "https://old.example.invalid/mcp",
        credential_ref: "old-ref",
      },
    ]);
    const settings = await client.query(
      "SELECT agent_id, server, allowed_tools, copied FROM retired_agent_mcp_settings ORDER BY copied",
    );
    expect(settings.rows).toEqual([
      {
        agent_id: agentId,
        server: "docs",
        allowed_tools: ["mcp__docs__search"],
        copied: false,
      },
      { agent_id: otherAgentId, server: null, allowed_tools: [], copied: true },
    ]);
  });

  test("a catalog row or selection cannot be written again", async () => {
    await expect(
      client.query(
        `INSERT INTO mcp_servers (id, url, credential_ref, auth, credential_source, workspaces, origin)
         VALUES ('again', 'https://again.example.invalid/mcp', 'again-ref',
           '{"kind":"bearer","stored":"mcp:again"}', 'stored', '["acme"]', 'console')`,
      ),
    ).rejects.toThrow("installation catalog MCP servers are retired");
    await expect(
      client.query(
        `INSERT INTO agent_mcp_settings (agent_id, workspace_id, server, allowed_tools, credential_refs)
         VALUES ($1, $2, NULL, '[]', '[]')`,
        [agentId, workspaceId],
      ),
    ).rejects.toThrow("installation catalog MCP servers are retired");
  });

  test("no version, release or draft with a catalog entry is written; one without is", async () => {
    await expect(
      client.query(
        `INSERT INTO agent_versions (id, agent_id, version_no, card, content_sha256)
         VALUES ($1, $2, 3, $3, $4)`,
        [randomUUID(), agentId, JSON.stringify(CATALOG_CARD), "3".repeat(64)],
      ),
    ).rejects.toThrow("installation catalog MCP servers are retired");
    await expect(
      insertRelease(`sha256:${"d".repeat(64)}`, catalogVersionId),
    ).rejects.toThrow("installation catalog MCP servers are retired");
    await expect(
      client.query(
        "UPDATE agents SET draft_version_id = $2, draft_connection_id = 'c' WHERE id = $1",
        [agentId, catalogVersionId],
      ),
    ).rejects.toThrow("installation catalog MCP servers are retired");

    await insertRelease(plainReleaseId, plainVersionId);
    await client.query(
      "UPDATE agents SET draft_version_id = $2, draft_connection_id = 'c' WHERE id = $1",
      [agentId, plainVersionId],
    );
    expect(
      await count(
        "SELECT count(*) AS n FROM agents WHERE id = $1 AND draft_version_id = $2",
        [agentId, plainVersionId],
      ),
    ).toBe(1);
  });

  test("a release made before stays and can be active again", async () => {
    await client.query(
      "UPDATE agents SET active_release_id = $2, activation_revision = activation_revision + 1 WHERE id = $1",
      [agentId, releaseId],
    );
    expect(
      await count(
        "SELECT count(*) AS n FROM agents WHERE id = $1 AND active_release_id = $2",
        [agentId, releaseId],
      ),
    ).toBe(1);
  });
});
