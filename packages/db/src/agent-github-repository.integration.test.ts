import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { GITHUB_FEATURES_NONE } from "@werft-ai/contracts";
import { callerFor } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresAgentGitHubStore } from "./agent-github.ts";
import { workspaceRepositoryCeiling } from "./github-settings.ts";
import * as schema from "./schema.ts";
import { fixtureTeamSql } from "./testing/fixture-team.ts";
import {
  RELEASE_SPEC_SQL_COLUMNS,
  releaseSpecSqlValues,
} from "./testing/spec-pins.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const PIN = {
  repositories: ["sample-app"],
  push_approval: true,
  features: { ...GITHUB_FEATURES_NONE, actions: true },
  actions_allow: [{ workflow: "ci.yml" }],
};
const MANAGERS = ["owner", "admin"] as const;

integration("turning one repository on or off on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const store = () => createPostgresAgentGitHubStore(db);

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "agent_github_toggle_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  async function catalogRow(id: string, repositoryId?: number) {
    await pool.query(
      `INSERT INTO catalog_repositories (id, github_repository_id, owner, name, url, branch, auth_kind, source)
       VALUES ($1, $2, 'acme', $1, $3, 'main', 'github_app', $4)`,
      [
        id,
        repositoryId ?? null,
        `https://github.com/acme/${id}.git`,
        // A row with no GitHub id is a seeded one.
        repositoryId === undefined ? "seed" : "selection",
      ],
    );
  }

  /**
   * A workspace with an owner, an agent whose active release pins `PIN`, the
   * release's repository `sample-app` and a second catalog row `other-app`.
   */
  async function fixture(
    options: {
      release?: boolean;
      role?: "owner" | "member";
      app?: boolean;
      /** The release's `github` pin; releases cannot be changed later. */
      github?: unknown;
    } = {},
  ) {
    const workspaceId = randomUUID();
    const userId = randomUUID();
    const agentId = randomUUID();
    const sample = `sample-${workspaceId.slice(0, 8)}`;
    const other = `other-${workspaceId.slice(0, 8)}`;
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
      [workspaceId, `ws-${workspaceId.slice(0, 8)}`],
    );
    await pool.query(
      "INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'x', 'person')",
      [userId, `${userId}@example.invalid`],
    );
    await pool.query(
      "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)",
      [workspaceId, userId, options.role ?? "owner"],
    );
    const teamId = await fixtureTeamSql(pool, workspaceId);
    await pool.query(
      "INSERT INTO agents (id, workspace_id, slug, name, github_enabled, managing_team_id) VALUES ($1, $2, $3, 'a', true, $4)",
      [agentId, workspaceId, `a-${agentId.slice(0, 8)}`, teamId],
    );
    await catalogRow(sample);
    await catalogRow(other);
    if (options.release !== false) {
      const versionId = randomUUID();
      const releaseId = `sha256:${randomUUID()}`;
      await pool.query(
        `INSERT INTO agent_versions (id, agent_id, version_no, card, content_sha256)
         VALUES ($1, $2, 1, '{}', $3)`,
        [versionId, agentId, "a".repeat(64)],
      );
      await pool.query(
        `INSERT INTO agent_releases (id, agent_id, version_id, card_sha256,
           repository_id, runtime_config_snapshot, effective_tools, policy_pins,
           ${RELEASE_SPEC_SQL_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, '{}', '{}', $6, ${releaseSpecSqlValues()})`,
        [
          releaseId,
          agentId,
          versionId,
          "a".repeat(64),
          sample,
          JSON.stringify({
            github: options.github ?? { ...PIN, repositories: [sample] },
          }),
        ],
      );
      await pool.query(
        "UPDATE agents SET active_release_id = $2, activation_revision = 0 WHERE id = $1",
        [agentId, releaseId],
      );
    }
    const connectionId = randomUUID();
    if (options.app !== false) {
      await pool.query(
        `INSERT INTO github_apps (id, workspace_id, role, app_id, slug, name, html_url, api_base)
         VALUES ($1, $2, 'author', 77, 'app', 'App', 'https://github.com/apps/app', 'https://api.github.com')`,
        [connectionId, workspaceId],
      );
    }
    const principal = callerFor(
      {
        kind: "user",
        id: userId,
        workspace_id: workspaceId,
        role: options.role ?? "owner",
        scopes: ["sessions:read", "sessions:write"],
      },
      { kind: "web" },
      randomUUID(),
    );
    return {
      workspaceId,
      userId,
      agentId,
      sample,
      other,
      connectionId,
      principal,
    };
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>;

  const toggle = (
    f: Fixture,
    over: Partial<
      Parameters<ReturnType<typeof store>["setRepository"]>[0]
    > = {},
  ) =>
    store().setRepository({
      workspaceId: f.workspaceId,
      agentId: f.agentId,
      enabled: true,
      expectedRevision: undefined,
      target: { kind: "catalog", id: f.other },
      userId: f.userId,
      principal: f.principal,
      managerRoles: MANAGERS,
      check: () => {},
      ...over,
    });

  // The catalog is shared by the tests of this file, so every pick that does
  // not name its repository is a new one.
  let picked = 0;
  const pick = (
    f: Fixture,
    over: {
      name?: string;
      githubRepositoryId?: number;
      receiptId?: string;
      pinReceiptId?: string | null;
    } = {},
  ) => {
    picked += 1;
    const name = over.name ?? `NewRepo${picked}`;
    return {
      kind: "github" as const,
      resolve: {
        base: name.toLowerCase(),
        githubRepositoryId: over.githubRepositoryId ?? 90_000 + picked,
        owner: "Acme",
        name,
        url: `https://github.com/Acme/${name}.git`,
        branch: "main",
        receiptId: over.receiptId ?? randomUUID(),
      },
      pin:
        over.pinReceiptId === null
          ? null
          : {
              connectionId: f.connectionId,
              appId: 77,
              receiptId: over.pinReceiptId ?? randomUUID(),
            },
    };
  };

  async function settingsRow(f: Fixture) {
    await pool.query(
      `INSERT INTO agent_github_settings (agent_id, workspace_id, repositories,
         push_approval, features, actions_allow, start_repository_id, revision,
         updated_by, push_attached)
       VALUES ($1, $2, $3, false, $4, '[]', $5, 3, $6, 'ask')`,
      [
        f.agentId,
        f.workspaceId,
        JSON.stringify([f.sample]),
        JSON.stringify(GITHUB_FEATURES_NONE),
        f.sample,
        f.userId,
      ],
    );
  }

  const settingsOf = async (f: Fixture) =>
    (
      await pool.query(
        "SELECT repositories, push_approval, start_repository_id, push_attached, revision, updated_by FROM agent_github_settings WHERE agent_id = $1",
        [f.agentId],
      )
    ).rows[0] as
      | {
          repositories: string[];
          push_approval: boolean;
          start_repository_id: string | null;
          push_attached: string | null;
          revision: number;
          updated_by: string | null;
        }
      | undefined;

  const receiptsOf = async (f: Fixture) =>
    (
      await pool.query(
        "SELECT operation, result FROM receipts WHERE owner_id = $1 ORDER BY created_at, id",
        [f.workspaceId],
      )
    ).rows as { operation: string; result: Record<string, unknown> }[];

  const count = async (sql: string, args: unknown[]) =>
    Number((await pool.query(sql, args)).rows[0]?.n ?? 0);

  test("turns a catalog repository on and off, keeping every other field", async () => {
    const f = await fixture();
    await settingsRow(f);
    const on = await toggle(f);
    expect(on).toMatchObject({
      outcome: "saved",
      revision: 4,
      catalogChanged: false,
    });
    expect(await settingsOf(f)).toMatchObject({
      repositories: [f.sample, f.other],
      push_approval: false,
      start_repository_id: f.sample,
      push_attached: "ask",
      revision: 4,
    });
    // The repository sessions start on: turning it off clears the start.
    const off = await toggle(f, {
      enabled: false,
      target: { kind: "catalog", id: f.sample },
    });
    expect(off).toMatchObject({ outcome: "saved", revision: 5 });
    expect(await settingsOf(f)).toMatchObject({
      repositories: [f.other],
      start_repository_id: null,
    });
    const receipts = await receiptsOf(f);
    expect(receipts.map((r) => r.operation)).toEqual([
      "set_agent_github",
      "set_agent_github",
    ]);
    expect(receipts[0]?.result).toMatchObject({
      change: "repository",
      repository_id: f.other,
      repository: `acme/${f.other}`,
      enabled: true,
      agent_settings_revision: 4,
    });
  });

  test("a toggle makes no release and activates nothing", async () => {
    const f = await fixture();
    const releases = async () =>
      count("SELECT count(*) AS n FROM agent_releases WHERE agent_id = $1", [
        f.agentId,
      ]);
    const active = async () =>
      (
        await pool.query(
          "SELECT active_release_id, activation_revision FROM agents WHERE id = $1",
          [f.agentId],
        )
      ).rows[0];
    const before = { releases: await releases(), active: await active() };
    await toggle(f);
    await toggle(f, { enabled: false });
    await toggle(f, { target: pick(f) });
    expect({ releases: await releases(), active: await active() }).toEqual(
      before,
    );
    const operations = (await receiptsOf(f)).map((r) => r.operation);
    expect(operations).not.toContain("create_agent_release");
    expect(operations).not.toContain("activate_agent");
  });

  test("a revision is compared only when given, and null means no row", async () => {
    const f = await fixture();
    await settingsRow(f);
    expect(await toggle(f, { expectedRevision: 2 })).toEqual({
      outcome: "conflict",
      revision: 3,
    });
    expect(await toggle(f, { expectedRevision: null })).toEqual({
      outcome: "conflict",
      revision: 3,
    });
    expect((await settingsOf(f))?.repositories).toEqual([f.sample]);
    expect(await toggle(f, { expectedRevision: 3 })).toMatchObject({
      outcome: "saved",
      revision: 4,
    });
    // Left out: whatever the row holds now.
    expect(await toggle(f, { enabled: false })).toMatchObject({
      outcome: "saved",
      revision: 5,
    });
    const fresh = await fixture();
    expect(await toggle(fresh, { expectedRevision: 1 })).toEqual({
      outcome: "conflict",
      revision: null,
    });
    expect(await settingsOf(fresh)).toBeUndefined();
  });

  test("a toggle that changes nothing writes nothing", async () => {
    const f = await fixture();
    await settingsRow(f);
    const same = await toggle(f, {
      target: { kind: "catalog", id: f.sample },
    });
    expect(same).toMatchObject({
      outcome: "saved",
      revision: 3,
      receiptId: null,
    });
    const gone = await toggle(f, { enabled: false });
    expect(gone).toMatchObject({
      outcome: "saved",
      revision: 3,
      receiptId: null,
    });
    expect(await receiptsOf(f)).toEqual([]);
    expect((await settingsOf(f))?.revision).toBe(3);
  });

  test("an agent with no row starts from the active release's pins, read under its lock", async () => {
    const f = await fixture();
    const saved = await toggle(f);
    expect(saved).toMatchObject({ outcome: "saved", revision: 1 });
    expect(await settingsOf(f)).toMatchObject({
      repositories: [f.sample, f.other],
      push_approval: true,
      // The release's repository is kept as the start.
      start_repository_id: f.sample,
      push_attached: "allow",
      updated_by: f.userId,
    });
    const features = (
      await pool.query(
        "SELECT features, actions_allow FROM agent_github_settings WHERE agent_id = $1",
        [f.agentId],
      )
    ).rows[0];
    expect(features).toEqual({
      features: PIN.features,
      actions_allow: PIN.actions_allow,
    });
  });

  test("turning off the release's own repository first drops it from the start", async () => {
    const f = await fixture();
    await toggle(f, {
      enabled: false,
      target: { kind: "catalog", id: f.sample },
    });
    expect(await settingsOf(f)).toMatchObject({
      repositories: [],
      start_repository_id: null,
    });
  });

  test("with no active release or unreadable pins there is nothing to start from", async () => {
    const none = await fixture({ release: false });
    expect(await toggle(none)).toEqual({ outcome: "seed_unavailable" });
    expect(await settingsOf(none)).toBeUndefined();
    expect(await receiptsOf(none)).toEqual([]);
    const broken = await fixture({ github: { repositories: "x" } });
    expect(await toggle(broken)).toEqual({ outcome: "seed_unavailable" });
    expect(await settingsOf(broken)).toBeUndefined();
  });

  test("a catalog id with no active row is refused", async () => {
    const f = await fixture();
    await pool.query(
      "UPDATE catalog_repositories SET removed_at = now() WHERE id = $1",
      [f.other],
    );
    expect(await toggle(f)).toEqual({ outcome: "repository_not_found" });
    expect(
      await toggle(f, { target: { kind: "catalog", id: "never-held" } }),
    ).toEqual({ outcome: "repository_not_found" });
    expect(await settingsOf(f)).toBeUndefined();
  });

  test("a repository the catalog dropped or never held can be turned off while the settings list it", async () => {
    const f = await fixture();
    await settingsRow(f);
    await pool.query(
      "UPDATE agent_github_settings SET repositories = $2 WHERE agent_id = $1",
      [f.agentId, JSON.stringify([f.sample, "ghost"])],
    );
    await pool.query(
      "UPDATE catalog_repositories SET removed_at = now() WHERE id = $1",
      [f.sample],
    );
    const off = (id: string) =>
      toggle(f, { enabled: false, target: { kind: "catalog", id } });

    // Turning on needs an active row even for an id the settings list.
    for (const id of [f.sample, "ghost"]) {
      expect(await toggle(f, { target: { kind: "catalog", id } })).toEqual({
        outcome: "repository_not_found",
      });
    }

    // Dropped from the catalog: turned off, and the start repository goes.
    expect(await off(f.sample)).toMatchObject({
      outcome: "saved",
      repository: { id: f.sample },
    });
    expect(await settingsOf(f)).toMatchObject({
      repositories: ["ghost"],
      start_repository_id: null,
    });
    // Never in the catalog: only its id is known.
    expect(await off("ghost")).toMatchObject({
      outcome: "saved",
      repository: { id: "ghost", owner: "", name: "ghost" },
    });
    expect((await settingsOf(f))?.repositories).toEqual([]);

    // Nothing lists them now, so there is nothing to turn off.
    expect(await off(f.sample)).toEqual({ outcome: "repository_not_found" });
    expect(await off("ghost")).toEqual({ outcome: "repository_not_found" });
    // Turning on still needs an active catalog row.
    expect(
      await toggle(f, { target: { kind: "catalog", id: f.sample } }),
    ).toEqual({ outcome: "repository_not_found" });
    expect((await settingsOf(f))?.repositories).toEqual([]);
  });

  test("a catalog row with no owner or name is shown by its id, never as an empty string", async () => {
    const f = await fixture();
    await settingsRow(f);
    const ids = [
      `blank-${f.sample}`,
      `gone-${f.sample}`,
      `half-${f.sample}`,
    ] as const;
    // The URL's last two path segments, or empty (schema.ts).
    for (const [id, owner, name, removed] of [
      [ids[0], "", "", false],
      [ids[1], "", "", true],
      [ids[2], "acme", "", false],
    ] as const) {
      await pool.query(
        `INSERT INTO catalog_repositories (id, owner, name, url, branch, auth_kind, source, removed_at)
         VALUES ($1, $2, $3, 'https://example.invalid/x.git', 'main', 'github_app', 'seed', ${removed ? "now()" : "NULL"})`,
        [id, owner, name],
      );
    }
    await pool.query(
      "UPDATE agent_github_settings SET repositories = $2 WHERE agent_id = $1",
      [f.agentId, JSON.stringify([f.sample, ...ids])],
    );
    for (const id of ids) {
      const off = await toggle(f, {
        enabled: false,
        target: { kind: "catalog", id },
      });
      expect(off).toMatchObject({
        outcome: "saved",
        repository: { id, label: id },
      });
    }
    const changes = (await receiptsOf(f)).filter(
      (r) =>
        r.operation === "set_agent_github" && r.result.change === "repository",
    );
    expect(changes.map((r) => r.result.repository)).toEqual([...ids]);
    // A named row keeps owner/name.
    expect(
      await toggle(f, {
        enabled: false,
        target: { kind: "catalog", id: f.sample },
      }),
    ).toMatchObject({ repository: { label: `acme/${f.sample}` } });
  });

  test("a pick writes the catalog row, the settings, the receipts and the pin together", async () => {
    const f = await fixture();
    const target = pick(f, { name: "TogetherRepo", githubRepositoryId: 41 });
    const saved = await toggle(f, { target });
    expect(saved).toMatchObject({
      outcome: "saved",
      catalogChanged: true,
      repository: { id: "togetherrepo", owner: "Acme", name: "TogetherRepo" },
    });
    expect((await settingsOf(f))?.repositories).toEqual([
      f.sample,
      "togetherrepo",
    ]);
    expect((await receiptsOf(f)).map((r) => r.operation).sort()).toEqual([
      "resolve_repository",
      "set_agent_github",
      "set_repository_github_app",
    ]);
    const pin = (
      await pool.query(
        "SELECT connection_id, pinned_by FROM catalog_repository_github_apps WHERE repository_id = 'togetherrepo' AND role = 'author'",
      )
    ).rows[0];
    expect(pin).toEqual({
      connection_id: f.connectionId,
      pinned_by: "selection",
    });
    // The same repository again is the same row, and a pin made stays.
    const again = await toggle(f, {
      enabled: false,
      target: pick(f, { name: "TogetherRepo", githubRepositoryId: 41 }),
    });
    expect(again).toMatchObject({
      outcome: "saved",
      catalogChanged: false,
      repository: { id: "togetherrepo" },
    });
  });

  test("a refusal after the row was added rolls the catalog, the settings and the ceiling back", async () => {
    const f = await fixture();
    expect(await workspaceRepositoryCeiling(db, f.workspaceId)).toBeNull();
    const target = pick(f);
    await expect(
      toggle(f, {
        target,
        check: () => {
          throw new Error("ceiling says no");
        },
      }),
    ).rejects.toThrow("ceiling says no");
    expect(
      await count(
        "SELECT count(*) AS n FROM catalog_repositories WHERE id = $1",
        [target.resolve.base],
      ),
    ).toBe(0);
    expect(await settingsOf(f)).toBeUndefined();
    expect(await receiptsOf(f)).toEqual([]);
    // The default ceiling the first save writes is rolled back with it.
    expect(await workspaceRepositoryCeiling(db, f.workspaceId)).toBeNull();
  });

  test("an App removed after GitHub was asked leaves no row, no settings and no receipt", async () => {
    const f = await fixture({ app: false });
    const target = pick(f);
    expect(await toggle(f, { target })).toEqual({ outcome: "app_gone" });
    expect(
      await count(
        "SELECT count(*) AS n FROM catalog_repositories WHERE id = $1",
        [target.resolve.base],
      ),
    ).toBe(0);
    expect(await settingsOf(f)).toBeUndefined();
    expect(await receiptsOf(f)).toEqual([]);
  });

  test("a failing pin rolls everything back: the new row, a rename, the settings, every receipt", async () => {
    const f = await fixture();
    // A new row: the pin's receipt takes the id of the row's own.
    const clash = randomUUID();
    const target = pick(f, { receiptId: clash, pinReceiptId: clash });
    await expect(toggle(f, { target })).rejects.toThrow();
    expect(
      await count(
        "SELECT count(*) AS n FROM catalog_repositories WHERE id = $1",
        [target.resolve.base],
      ),
    ).toBe(0);
    expect(await settingsOf(f)).toBeUndefined();
    expect(await receiptsOf(f)).toEqual([]);
    expect(
      await count(
        "SELECT count(*) AS n FROM catalog_repository_github_apps WHERE repository_id = $1",
        [target.resolve.base],
      ),
    ).toBe(0);

    // A rename: the row exists under its old name, and must come back to it.
    await catalogRow("renamed-old", 5150);
    const before = (
      await pool.query(
        "SELECT owner, name, url, version FROM catalog_repositories WHERE id = 'renamed-old'",
      )
    ).rows[0];
    const same = randomUUID();
    await expect(
      toggle(f, {
        target: pick(f, {
          name: "RenamedNew",
          githubRepositoryId: 5150,
          receiptId: same,
          pinReceiptId: same,
        }),
      }),
    ).rejects.toThrow();
    expect(
      (
        await pool.query(
          "SELECT owner, name, url, version FROM catalog_repositories WHERE id = 'renamed-old'",
        )
      ).rows[0],
    ).toEqual(before);
    expect(await receiptsOf(f)).toEqual([]);
  });

  test("a rename on GitHub moves the row and keeps its id; a name another repository holds is refused with nothing written", async () => {
    const f = await fixture();
    await catalogRow("moved", 6000);
    const moved = await toggle(f, {
      target: pick(f, { name: "MovedAgain", githubRepositoryId: 6000 }),
    });
    expect(moved).toMatchObject({
      outcome: "saved",
      catalogChanged: true,
      repository: { id: "moved", name: "MovedAgain" },
    });
    const receipts = await receiptsOf(f);
    expect(
      receipts.find((r) => r.operation === "resolve_repository")?.result,
    ).toMatchObject({ previous_full_name: "acme/moved" });

    const g = await fixture();
    await catalogRow("holder", 7000);
    await pool.query(
      "UPDATE catalog_repositories SET owner = 'Acme', name = 'Taken' WHERE id = 'holder'",
    );
    expect(
      await toggle(g, {
        target: pick(g, { name: "Taken", githubRepositoryId: 7001 }),
      }),
    ).toEqual({ outcome: "name_held", id: "holder" });
    expect(await settingsOf(g)).toBeUndefined();
    expect(await receiptsOf(g)).toEqual([]);
    expect(await workspaceRepositoryCeiling(db, g.workspaceId)).toBeNull();
  });

  test("whoever lost the right to manage the agent changes nothing, a pick included", async () => {
    const f = await fixture({ role: "member" });
    expect(await toggle(f)).toEqual({ outcome: "outranked" });
    const target = pick(f);
    expect(await toggle(f, { target })).toEqual({ outcome: "outranked" });
    expect(
      await count(
        "SELECT count(*) AS n FROM catalog_repositories WHERE id = $1",
        [target.resolve.base],
      ),
    ).toBe(0);
    expect(await settingsOf(f)).toBeUndefined();
    const gone = await fixture();
    await pool.query("DELETE FROM memberships WHERE user_id = $1", [
      gone.userId,
    ]);
    expect(await toggle(gone)).toEqual({ outcome: "actor_inactive" });
    expect(await toggle(gone, { target: pick(gone) })).toEqual({
      outcome: "actor_inactive",
    });
    expect(await receiptsOf(gone)).toEqual([]);
  });

  test("without an App store nothing is pinned, and the row is still added", async () => {
    const f = await fixture({ app: false });
    const saved = await toggle(f, { target: pick(f, { pinReceiptId: null }) });
    expect(saved).toMatchObject({ outcome: "saved", catalogChanged: true });
    expect((await receiptsOf(f)).map((r) => r.operation).sort()).toEqual([
      "resolve_repository",
      "set_agent_github",
    ]);
  });

  test("toggles that run at once all stay, and the last request of one repository wins", async () => {
    const f = await fixture();
    await settingsRow(f);
    const extra = ["extra-a", "extra-b", "extra-c", "extra-d"];
    for (const id of extra) await catalogRow(id);
    const results = await Promise.all(
      extra.map((id) => toggle(f, { target: { kind: "catalog", id } })),
    );
    expect(results.every((r) => r.outcome === "saved")).toBe(true);
    const revisions = results.flatMap((r) =>
      r.outcome === "saved" ? [r.revision] : [],
    );
    expect(new Set(revisions).size).toBe(extra.length);
    expect(new Set((await settingsOf(f))?.repositories)).toEqual(
      new Set([f.sample, ...extra]),
    );
    // One repository, flipped by requests that follow one another.
    for (const enabled of [true, false, true, false, true]) {
      await toggle(f, { enabled });
    }
    expect((await settingsOf(f))?.repositories).toContain(f.other);
    await toggle(f, { enabled: false });
    expect((await settingsOf(f))?.repositories).not.toContain(f.other);
  });

  test("a pick, a toggle by ref and a concurrent settings save take their locks in one order", async () => {
    const f = await fixture();
    await settingsRow(f);
    const attempts = Array.from({ length: 6 }, (_, n) => n);
    const results = await Promise.allSettled(
      attempts.flatMap((n) => [
        toggle(f, {
          target: pick(f, {
            name: `Picked${n}`,
            githubRepositoryId: 8000 + n,
          }),
        }),
        toggle(f, { enabled: n % 2 === 0 }),
        // The revision is read fresh, so a save can win, not only conflict.
        settingsOf(f).then((row) =>
          store().putSettings({
            workspaceId: f.workspaceId,
            agentId: f.agentId,
            expectedRevision: row?.revision ?? null,
            settings: {
              repositories: [],
              push_approval: false,
              features: { ...GITHUB_FEATURES_NONE },
              actions_allow: [],
            },
            startRepositoryId: null,
            userId: f.userId,
            principal: f.principal,
            managerRoles: MANAGERS,
            check: () => {},
          }),
        ),
      ]),
    );
    // A stale save returns a conflict; nothing may throw, a deadlock least.
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    const saves = results.flatMap((r) =>
      r.status === "fulfilled" && "outcome" in r.value ? [r.value.outcome] : [],
    );
    expect(saves).toContain("saved");
  });
});
