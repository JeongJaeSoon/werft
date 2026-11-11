import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { ToolCatalogView } from "@werft-ai/contracts";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "./schema.ts";
import { workspaceEngineSettingsOf } from "./workspace-engine-settings.ts";

/**
 * The workspace's engine settings table and the write gate. Nothing writes
 * either yet, so these tests put rows in directly to pin what the tables
 * accept and what the readers say, before any claim path reads them.
 */

const catalog: ToolCatalogView = {
  id: "test@1",
  tools: ["Read", "Edit", "Bash", "WebFetch", "WebSearch"].map((name) => ({
    name,
    boundary: "local" as const,
  })),
};

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let workspaceId: string;

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema });
  workspaceId = randomUUID();
  await client.query(
    "INSERT INTO workspaces (id, slug, name) VALUES ($1, 'acme', 'acme')",
    [workspaceId],
  );
});

afterEach(async () => {
  await client.close();
});

async function insert(
  permissions: unknown,
  autoMode: unknown = {},
  options: { workspace?: string; revision?: number } = {},
): Promise<string> {
  try {
    await client.query(
      `INSERT INTO workspace_engine_settings (workspace_id, permissions, auto_mode, revision)
       VALUES ($1, $2::jsonb, $3::jsonb, $4)`,
      [
        options.workspace ?? workspaceId,
        JSON.stringify(permissions),
        JSON.stringify(autoMode),
        options.revision ?? 1,
      ],
    );
    return "accepted";
  } catch (error) {
    return (
      /workspace_engine_settings_\w+/.exec(String(error))?.[0] ??
      `error: ${String(error)}`
    );
  }
}

describe("workspace_engine_settings", () => {
  test("a migrated database starts with no rows, so an existing workspace has none", async () => {
    const count = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM workspace_engine_settings",
    );
    expect(count.rows[0]?.n).toBe(0);
    expect(
      await workspaceEngineSettingsOf(db, workspaceId, catalog),
    ).toBeNull();
  });

  test("the reader gives what was saved with its revision", async () => {
    expect(
      await insert(
        { deny: ["WebFetch"], ask: ["Bash(git push:*)"] },
        { hard_deny: ["Do not push to main."] },
        { revision: 2 },
      ),
    ).toBe("accepted");
    expect(
      await workspaceEngineSettingsOf(db, workspaceId.toUpperCase(), catalog),
    ).toEqual({
      permissions: { deny: ["WebFetch"], ask: ["Bash(git push:*)"] },
      auto_mode: { hard_deny: ["Do not push to main."] },
      revision: 2,
    });
  });

  test("a row is one per workspace and names a workspace that exists", async () => {
    expect(await insert({})).toBe("accepted");
    expect(await insert({})).toBe("workspace_engine_settings_pkey");
    expect(await insert({}, {}, { workspace: randomUUID() })).toBe(
      "workspace_engine_settings_workspace_id_workspaces_id_fk",
    );
  });

  test("the two lists keep the structure the agent's table keeps", async () => {
    expect(await insert({ other: [] })).toBe(
      "workspace_engine_settings_permissions_check",
    );
    await client.query("DELETE FROM workspace_engine_settings");
    expect(await insert({ deny: [`x\n${"x".repeat(256)}`] })).toBe(
      "workspace_engine_settings_permissions_check",
    );
    expect(await insert({}, { deny: ["a"] })).toBe(
      "workspace_engine_settings_auto_mode_check",
    );
    expect(await insert({}, {}, { revision: 0 })).toBe(
      "workspace_engine_settings_revision_check",
    );
  });

  test("a row over the workspace's budget throws even though the CHECK accepts it", async () => {
    // 49 rules: within the CHECK's 64, over the 48 a workspace saves.
    const rules = Array.from({ length: 49 }, (_, i) => `Bash(c${i})`);
    expect(await insert({ deny: rules })).toBe("accepted");
    await expect(
      workspaceEngineSettingsOf(db, workspaceId, catalog),
    ).rejects.toThrow(/does not parse: too_many_rules/);
  });

  test("a rule the CHECK lets through but the parser refuses throws too", async () => {
    expect(await insert({ deny: ["Skill(web)"] })).toBe("accepted");
    await expect(
      workspaceEngineSettingsOf(db, workspaceId, catalog),
    ).rejects.toThrow(/does not parse: rule_no_effect/);
  });
});
