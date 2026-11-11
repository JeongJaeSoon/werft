import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { ToolCatalogView } from "@werft-ai/contracts";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "../schema.ts";
import { fixtureTeamSql } from "../testing/fixture-team.ts";
import { agentEngineSettingsOf } from "./agent-engine-settings.ts";

/**
 * The table an agent's engine settings will live in. Nothing writes it yet, so
 * these tests put rows in directly: they pin what the table accepts and what
 * the reader says, before any claim path reads it.
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
let agentId: string;

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema });
  workspaceId = randomUUID();
  agentId = randomUUID();
  await client.query(
    "INSERT INTO workspaces (id, slug, name) VALUES ($1, 'acme', 'acme')",
    [workspaceId],
  );
  await client.query(
    "INSERT INTO agents (id, workspace_id, slug, name, status, managing_team_id) VALUES ($1, $2, 'bot', 'bot', 'active', $3)",
    [agentId, workspaceId, await fixtureTeamSql(client, workspaceId)],
  );
});

afterEach(async () => {
  await client.close();
});

async function insert(
  permissions: unknown,
  autoMode: unknown = {},
  options: { agent?: string; workspace?: string; revision?: number } = {},
): Promise<string> {
  try {
    await client.query(
      `INSERT INTO agent_engine_settings (agent_id, workspace_id, permissions, auto_mode, revision)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)`,
      [
        options.agent ?? agentId,
        options.workspace ?? workspaceId,
        JSON.stringify(permissions),
        JSON.stringify(autoMode),
        options.revision ?? 1,
      ],
    );
    return "accepted";
  } catch (error) {
    return (
      /agent_engine_settings_\w+/.exec(String(error))?.[0] ??
      /duplicate key[^"]*"([^"]+)"/.exec(String(error))?.[1] ??
      `error: ${String(error)}`
    );
  }
}

describe("agent_engine_settings", () => {
  test("a migrated database starts with no rows, so an existing agent has none", async () => {
    const count = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM agent_engine_settings",
    );
    expect(count.rows[0]?.n).toBe(0);
    expect(await agentEngineSettingsOf(db, agentId, catalog)).toBeNull();
  });

  test("the reader gives what was saved with its revision", async () => {
    expect(
      await insert(
        { deny: ["WebFetch"], ask: ["Bash(git push:*)"] },
        { hard_deny: ["Do not push to main."] },
        { revision: 4 },
      ),
    ).toBe("accepted");
    expect(
      await agentEngineSettingsOf(db, agentId.toUpperCase(), catalog),
    ).toEqual({
      permissions: { deny: ["WebFetch"], ask: ["Bash(git push:*)"] },
      auto_mode: { hard_deny: ["Do not push to main."] },
      revision: 4,
    });
  });

  test("a row over the agent's own budget throws even though the CHECK accepts it", async () => {
    // The CHECK allows 64 rules a list; an agent saves at most 24, so that a
    // claim's merge stays within what a worker accepts.
    const rules = Array.from({ length: 30 }, (_, i) => `Bash(c${i})`);
    expect(await insert({ deny: rules })).toBe("accepted");
    await expect(agentEngineSettingsOf(db, agentId, catalog)).rejects.toThrow(
      /does not parse: too_many_rules/,
    );
  });

  test("a row is one per agent and belongs to the agent's own workspace", async () => {
    expect(await insert({})).toBe("accepted");
    expect(await insert({})).toBe("agent_engine_settings_pkey");
    const stranger = randomUUID();
    expect(await insert({}, {}, { agent: stranger })).toBe(
      "agent_engine_settings_agent_fk",
    );
    const other = randomUUID();
    await client.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, 'other', 'other')",
      [other],
    );
    const second = randomUUID();
    await client.query(
      "INSERT INTO agents (id, workspace_id, slug, name, status, managing_team_id) VALUES ($1, $2, 'bot2', 'bot2', 'active', $3)",
      [second, workspaceId, await fixtureTeamSql(client, workspaceId)],
    );
    // The agent exists, but not in the workspace the row names.
    expect(await insert({}, {}, { agent: second, workspace: other })).toBe(
      "agent_engine_settings_agent_fk",
    );
  });

  test("permissions hold only allow, ask and deny, each a list of non-empty strings", async () => {
    const cases: [unknown, string][] = [
      [{ allow: ["Read"], ask: [], deny: ["Edit"] }, "accepted"],
      [[], "agent_engine_settings_permissions_check"],
      [{ other: [] }, "agent_engine_settings_permissions_check"],
      [{ deny: "Bash" }, "agent_engine_settings_permissions_check"],
      [{ deny: [3] }, "agent_engine_settings_permissions_check"],
      [{ deny: [["Bash"]] }, "agent_engine_settings_permissions_check"],
      [{ deny: [""] }, "agent_engine_settings_permissions_check"],
      [{ deny: ["x".repeat(257)] }, "agent_engine_settings_permissions_check"],
      [{ deny: ["x".repeat(256)] }, "accepted"],
      // `.` does not match a newline unless told to; a line break must not
      // end the length count.
      [
        { deny: [`x\n${"x".repeat(256)}`] },
        "agent_engine_settings_permissions_check",
      ],
      [{ deny: [`${"x".repeat(255)}\n`] }, "accepted"],
      [
        { deny: Array.from({ length: 65 }, (_, i) => `Bash(c${i})`) },
        "agent_engine_settings_permissions_check",
      ],
    ];
    for (const [permissions, expected] of cases) {
      await client.query("DELETE FROM agent_engine_settings");
      expect([JSON.stringify(permissions), await insert(permissions)]).toEqual([
        JSON.stringify(permissions),
        expected,
      ]);
    }
  });

  test("auto mode holds only its four lists of sentences up to 1024 characters", async () => {
    const cases: [unknown, string][] = [
      [
        {
          allow: ["a"],
          soft_deny: ["b"],
          hard_deny: ["c"],
          environment: ["d"],
        },
        "accepted",
      ],
      [{ deny: ["a"] }, "agent_engine_settings_auto_mode_check"],
      [{ allow: "a" }, "agent_engine_settings_auto_mode_check"],
      [{ allow: [{}] }, "agent_engine_settings_auto_mode_check"],
      [{ allow: [""] }, "agent_engine_settings_auto_mode_check"],
      [{ allow: ["x".repeat(1025)] }, "agent_engine_settings_auto_mode_check"],
      [{ allow: ["x".repeat(1024)] }, "accepted"],
      [
        { allow: [`x\n${"x".repeat(1024)}`] },
        "agent_engine_settings_auto_mode_check",
      ],
      [{ allow: [`${"x".repeat(1023)}\n`] }, "accepted"],
      [
        { allow: Array.from({ length: 65 }, (_, i) => `s${i}`) },
        "agent_engine_settings_auto_mode_check",
      ],
    ];
    for (const [autoMode, expected] of cases) {
      await client.query("DELETE FROM agent_engine_settings");
      expect([JSON.stringify(autoMode), await insert({}, autoMode)]).toEqual([
        JSON.stringify(autoMode),
        expected,
      ]);
    }
  });

  test("a revision starts at one", async () => {
    expect(await insert({}, {}, { revision: 0 })).toBe(
      "agent_engine_settings_revision_check",
    );
    expect(await insert({}, {}, { revision: 1 })).toBe("accepted");
  });

  test("a row that does not parse throws; it is never read as no rules", async () => {
    // The CHECK is what keeps this from happening; take it away to see the reader.
    await client.query(
      "ALTER TABLE agent_engine_settings DROP CONSTRAINT agent_engine_settings_permissions_check",
    );
    expect(await insert({ deny: "Bash" })).toBe("accepted");
    await expect(agentEngineSettingsOf(db, agentId, catalog)).rejects.toThrow(
      "does not parse",
    );
  });

  test("a rule the CHECK lets through but the parser refuses throws too", async () => {
    // Well-formed strings, so the CHECK accepts them; the engine would drop
    // each one without a word, which is what a silent "no rules" would hide.
    for (const rule of ["Skill(web)", "Nope", "Read("]) {
      await client.query("DELETE FROM agent_engine_settings");
      expect(await insert({ deny: [rule] })).toBe("accepted");
      await expect(agentEngineSettingsOf(db, agentId, catalog)).rejects.toThrow(
        /does not parse: rule_/,
      );
    }
  });
});
