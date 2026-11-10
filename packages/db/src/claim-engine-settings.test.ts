import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import {
  mcpDeniedBy,
  recordClaimRules,
  claimEngineSettingsOf as withAudit,
} from "./claim-engine-settings.ts";
import * as schema from "./schema.ts";
import { fixtureTeamSql } from "./testing/fixture-team.ts";
import {
  RELEASE_SPEC_SQL_COLUMNS,
  releaseSpecSqlValues,
} from "./testing/spec-pins.ts";

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let workspaceId: string;
let agentId: string;
const releaseId = `sha256:${"d".repeat(64)}`;
const both = { engineSettings: true, permissionRules: true };

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema });
  workspaceId = randomUUID();
  agentId = randomUUID();
  const versionId = randomUUID();
  await client.query(
    "INSERT INTO workspaces (id, slug, name) VALUES ($1, 'acme', 'acme')",
    [workspaceId],
  );
  await client.query(
    "INSERT INTO agents (id, workspace_id, slug, name, status, managing_team_id) VALUES ($1, $2, 'bot', 'bot', 'active', $3)",
    [agentId, workspaceId, await fixtureTeamSql(client, workspaceId)],
  );
  await client.query(
    `INSERT INTO agent_versions (id, agent_id, version_no, card, content_sha256)
     VALUES ($1, $2, 1, '{}', $3)`,
    [versionId, agentId, "a".repeat(64)],
  );
  await client.query(
    `INSERT INTO agent_releases (id, agent_id, version_id, card_sha256,
       runtime_config_snapshot, effective_tools, policy_pins,
       ${RELEASE_SPEC_SQL_COLUMNS})
     VALUES ($1, $2, $3, $4, '{}', '{}', '{}', ${releaseSpecSqlValues()})`,
    [releaseId, agentId, versionId, "a".repeat(64)],
  );
});

afterEach(async () => {
  await client.close();
});

const session = (over: Record<string, unknown> = {}) => ({
  workspaceId,
  agentReleaseId: releaseId as string | null,
  engineSettingsStart: null as unknown,
  ...over,
});

const workspaceRules = (permissions: unknown, revision = 1) =>
  client.query(
    `INSERT INTO workspace_engine_settings (workspace_id, permissions, auto_mode, revision)
     VALUES ($1, $2::jsonb, '{}'::jsonb, $3)`,
    [workspaceId, JSON.stringify(permissions), revision],
  );
const agentRules = (
  permissions: unknown,
  adminDeny: unknown = [],
  revision = 1,
) =>
  client.query(
    `INSERT INTO agent_engine_settings (agent_id, workspace_id, permissions, auto_mode, admin_deny, revision)
     VALUES ($1, $2, $3::jsonb, '{}'::jsonb, $4::jsonb, $5)`,
    [
      agentId,
      workspaceId,
      JSON.stringify(permissions),
      JSON.stringify(adminDeny),
      revision,
    ],
  );

// Most cases are about the verdict; the audit has its own tests below.
async function claimEngineSettingsOf(
  ...args: Parameters<typeof withAudit>
): Promise<unknown> {
  const { audit: _audit, ...verdict } = await withAudit(...args);
  return verdict;
}

describe("claim receipts", () => {
  const receiptsOf = async () =>
    (
      await client.query<{ status: string; result: Record<string, unknown> }>(
        "SELECT status, result FROM receipts WHERE operation = 'resolve_session_engine_settings' ORDER BY created_at",
      )
    ).rows;
  const target = () => ({ id: randomUUID(), ownerId: workspaceId });

  test("an agent no rule row touches writes no receipt", async () => {
    const result = await withAudit(db, session(), both);
    await recordClaimRules(db, target(), result);
    expect(result.audit.untouched).toBe(true);
    expect(await receiptsOf()).toEqual([]);
  });

  test("a claim that met rules records revisions, result and counts, never the rules", async () => {
    await workspaceRules({ ask: ["Bash(git push:*)"] }, 2);
    await agentRules({ deny: ["Skill"] }, [], 4);
    const result = await withAudit(
      db,
      session({
        engineSettingsStart: { permissions: {}, auto_mode: {}, revision: 3 },
      }),
      both,
    );
    await recordClaimRules(db, target(), result);
    const [row] = await receiptsOf();
    expect(row?.status).toBe("succeeded");
    expect(row?.result).toEqual({
      outcome: "rules",
      start_revision: 3,
      workspace_revision: 2,
      agent_revision: 4,
      counts: { engine: 1, disallowed_tools: 1, mcp_deny: 0 },
    });
    expect(JSON.stringify(row)).not.toContain("git push");
  });

  test("a refusal is recorded with its reason, and repeating it adds no row", async () => {
    await agentRules({}, [], 1);
    const closed = await withAudit(
      db,
      session({
        engineSettingsStart: { permissions: {}, auto_mode: {}, revision: 5 },
      }),
      both,
    );
    const owner = target();
    await recordClaimRules(db, owner, closed);
    await recordClaimRules(db, owner, closed);
    const rows = await receiptsOf();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.result).toMatchObject({
      outcome: "closed",
      reason: "agent_revision_regressed",
      start_revision: 5,
      agent_revision: 1,
    });
  });
});

describe("claimEngineSettingsOf grants", () => {
  test("a workspace allow is dropped unless the agent allows it too", async () => {
    await workspaceRules({ allow: ["Bash(ls:*)"], ask: ["Edit"] });
    const alone = await withAudit(db, session(), both);
    expect(alone).toMatchObject({
      kind: "ok",
      settings: { engine: { permissions: { ask: ["Edit"] } } },
    });
    await agentRules({ allow: ["Bash(ls:*)"] });
    const started = {
      permissions: { allow: ["Bash(ls:*)"] },
      auto_mode: {},
      revision: 1,
    };
    const both_ = await withAudit(
      db,
      session({ engineSettingsStart: started }),
      both,
    );
    expect(both_).toMatchObject({
      kind: "ok",
      settings: {
        engine: { permissions: { allow: ["Bash(ls:*)"], ask: ["Edit"] } },
      },
    });
  });
});

describe("claimEngineSettingsOf", () => {
  test("no rules anywhere sends nothing, even to a worker that announced nothing", async () => {
    expect(
      await claimEngineSettingsOf(db, session(), {
        engineSettings: false,
        permissionRules: false,
      }),
    ).toEqual({ kind: "ok", settings: { disallowedTools: [] } });
  });

  test("a workspace ask reaches the engine; a worker without the capability is refused", async () => {
    await workspaceRules({ ask: ["Bash(git push:*)"] });
    expect(await claimEngineSettingsOf(db, session(), both)).toEqual({
      kind: "ok",
      settings: {
        engine: { permissions: { ask: ["Bash(git push:*)"] } },
        disallowedTools: [],
      },
    });
    expect(
      await claimEngineSettingsOf(db, session(), {
        engineSettings: false,
        permissionRules: true,
      }),
    ).toEqual({ kind: "unsupported" });
  });

  test("a whole-tool deny rides as disallowed tools and needs permission_rules", async () => {
    await workspaceRules({ deny: ["Skill"] });
    expect(await claimEngineSettingsOf(db, session(), both)).toEqual({
      kind: "ok",
      settings: { disallowedTools: ["Skill"] },
    });
    expect(
      await claimEngineSettingsOf(db, session(), {
        engineSettings: true,
        permissionRules: false,
      }),
    ).toEqual({ kind: "unsupported" });
  });

  test("an mcp__ deny is enforced at call time and never sent to the engine", async () => {
    await workspaceRules({ deny: ["mcp__github__delete_repo"] });
    expect(await claimEngineSettingsOf(db, session(), both)).toEqual({
      kind: "ok",
      settings: { disallowedTools: [] },
    });
  });

  test("an inherited deny binds a release unless it is exempt, and not a session without one", async () => {
    await agentRules({}, [
      { exempt_release_ids: [], permissions_deny: ["Task"], mcp_deny: [] },
    ]);
    const bound = await claimEngineSettingsOf(db, session(), both);
    expect(bound).toEqual({
      kind: "ok",
      settings: { disallowedTools: ["Task"] },
    });
    await client.query(
      "UPDATE agent_engine_settings SET admin_deny = $1::jsonb",
      [
        JSON.stringify([
          {
            exempt_release_ids: [releaseId],
            permissions_deny: ["Task"],
            mcp_deny: [],
          },
        ]),
      ],
    );
    expect(await claimEngineSettingsOf(db, session(), both)).toEqual({
      kind: "ok",
      settings: { disallowedTools: [] },
    });
    expect(
      await claimEngineSettingsOf(db, session({ agentReleaseId: null }), both),
    ).toEqual({ kind: "ok", settings: { disallowedTools: [] } });
  });

  test("mcpDeniedBy lists the saved mcp__ denies and is null when rules cannot be read", async () => {
    await workspaceRules({ deny: ["mcp__github__delete_repo", "Skill"] });
    expect(await mcpDeniedBy(db, session())).toEqual([
      "mcp__github__delete_repo",
    ]);
    expect(
      await mcpDeniedBy(db, session({ agentReleaseId: "sha256:missing" })),
    ).toBeNull();
  });

  test("a release that cannot be resolved closes the claim", async () => {
    expect(
      await claimEngineSettingsOf(
        db,
        session({ agentReleaseId: "sha256:missing" }),
        both,
      ),
    ).toEqual({ kind: "closed", reason: "release_unresolvable" });
  });

  test("a snapshot newer than the saved row closes the claim", async () => {
    await agentRules({}, [], 1);
    const result = await claimEngineSettingsOf(
      db,
      session({
        engineSettingsStart: { permissions: {}, auto_mode: {}, revision: 5 },
      }),
      both,
    );
    expect(result).toEqual({
      kind: "closed",
      reason: "agent_revision_regressed",
    });
  });
});
