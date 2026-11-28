import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { scopesForRole } from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  createPostgresSkillRepositoryStore,
  memberships,
  receipts,
  skillRepositories,
  users,
  workspaces,
} from "@werft-ai/db";
import {
  createGitHubAppDirectory,
  createGitHubSkillReader,
} from "@werft-ai/forge-github";
import {
  callerFor,
  createAuthorizationPolicy,
  createSkillRepositoryService,
  type GitHubAppCredential,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type FakeGitHub,
  startFakeGitHub,
  type TempDatabase,
} from "@werft-ai/testkit";
import { asc, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const integration = process.env.QUEUE_DATABASE_URL ? describe : describe.skip;

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keys.privateKey
  .export({ type: "pkcs1", format: "pem" })
  .toString();
const publicKey = keys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const APP_ID = 101;
const INSTALLATION = 77;

const skillMd = (name: string, body = "Body.") =>
  `---\nname: ${name}\ndescription: Use for ${name}\n---\n${body}\n`;

integration("skill repositories against fake GitHub", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let github: FakeGitHub;
  const connections = new Map<string, GitHubAppCredential>();
  let service: ReturnType<typeof createSkillRepositoryService>;
  let seq = 0;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "skill_repositories_it" });
    pool = new Pool({ connectionString: database.url, max: 6 });
    db = drizzle(pool, { schema });
    // The App's one installation covers acme/home and nothing else.
    github = await startFakeGitHub({
      appId: APP_ID,
      publicKey,
      installationId: INSTALLATION,
      installedOn: ["acme/home"],
    });
    await github.createRepository("acme", "home", { "README.md": "x\n" });
    const directory = createGitHubAppDirectory({ retryAfterBaseMs: 1 });
    service = createSkillRepositoryService({
      authorization: createAuthorizationPolicy({}),
      store: createPostgresSkillRepositoryStore(db),
      reader: createGitHubSkillReader({ retryAfterBaseMs: 1 }),
      apps: async (workspaceId) =>
        [...connections.values()].filter(
          (one) => one.workspaceId === workspaceId,
        ),
      installations: (app) => directory.installations(app),
    });
  }, 60_000);

  afterAll(async () => {
    await github.stop();
    await pool.end();
    await database.drop();
  }, 60_000);

  /** A workspace with an admin and its author App on the fake. */
  async function workspace() {
    const workspaceId = randomUUID();
    const slug = `ws-${workspaceId.slice(0, 8)}`;
    await db.insert(workspaces).values({ id: workspaceId, slug, name: slug });
    const connectionId = randomUUID();
    await pool.query(
      `INSERT INTO github_apps (id, workspace_id, role, app_id, slug, name, html_url, api_base)
       VALUES ($1, $2, 'author', $3, 's', 'n', 'https://github.com/apps/s', $4)`,
      [connectionId, workspaceId, APP_ID, github.origin],
    );
    connections.set(connectionId, {
      id: connectionId,
      workspaceId,
      appId: APP_ID,
      apiBase: github.origin,
      privateKey,
      updatedAt: new Date(),
    });
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `admin-${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: "admin",
    });
    await db.insert(memberships).values({ workspaceId, userId, role: "admin" });
    const caller = callerFor(
      {
        kind: "user",
        id: userId,
        workspace_id: workspaceId,
        role: "admin",
        scopes: [...scopesForRole("admin")],
      },
      { kind: "web" },
      randomUUID(),
    );
    return { workspaceId, connectionId, userId, caller };
  }

  /** A public repository of the fake that the App is not installed on. */
  async function publicRepository(
    files: Record<string, string> = {
      LICENSE: "Apache\n",
      "skills/pdf/SKILL.md": skillMd("pdf"),
      "skills/pdf/scripts/fill.py": "print(1)\n",
      "skills/notes/SKILL.md": skillMd("notes"),
    },
  ) {
    seq += 1;
    const name = `skills-${seq}`;
    const repositoryId = await github.createRepository(
      "anthropics",
      name,
      files,
      { private: false, ownerId: 4242, license: "Apache-2.0" },
    );
    return {
      name,
      repositoryId,
      url: `https://github.com/anthropics/${name}`,
      head: async () =>
        (await github.refs("anthropics", name))["refs/heads/main"] ?? "",
      write: (changes: Record<string, string | null | { symlink: string }>) =>
        github.writeFiles("anthropics", name, "main", changes),
    };
  }

  const refusal = async (run: Promise<unknown>) => {
    const error = (await run.catch((caught: unknown) => caught)) as {
      code?: string;
      details?: { reason_code?: string };
    };
    return [error.code, error.details?.reason_code];
  };

  const waitFor = async (hold: { waiting(): number }) => {
    for (let tries = 0; hold.waiting() === 0 && tries < 250; tries += 1) {
      await Bun.sleep(20);
    }
    expect(hold.waiting()).toBeGreaterThan(0);
  };

  test("registers a public repository the App is not installed on, listing its skills off and fetching only the SKILL.md files", async () => {
    const { connectionId, userId, caller } = await workspace();
    const repo = await publicRepository();
    await repo.write({ "skills/notes/data.md": { symlink: "../../LICENSE" } });
    const before = github.apiRequests.length;
    const registered = await service.register(caller, { url: repo.url });
    expect(registered.outcome).toBe("registered");
    expect(registered.repository).toMatchObject({
      repository_id: repo.repositoryId,
      repository: `anthropics/${repo.name}`,
      ref: "main",
      access: "public",
      connection_id: connectionId,
      installation_id: INSTALLATION,
      owner_id: 4242,
      license: "Apache-2.0",
      state: "active",
      last_commit: await repo.head(),
      last_sync: {
        trigger: { kind: "register", user_id: userId },
        result: "listed",
      },
      skill_count: 2,
      created_by: userId,
    });
    expect(
      registered.skills.map((skill) => [
        skill.path,
        skill.name,
        skill.status,
        skill.enabled,
        skill.has_scripts,
        skill.issues.map((issue) => `${issue.path} ${issue.code}`),
      ]),
    ).toEqual([
      [
        "skills/notes",
        "notes",
        "unavailable",
        false,
        false,
        ["data.md unsupported_entry_kind"],
      ],
      ["skills/pdf", "pdf", "off", false, true, []],
    ]);
    const asked = github.apiRequests.slice(before);
    expect(
      asked.filter((one) => one.path.includes("/git/blobs/")),
    ).toHaveLength(2);
    expect(
      asked.filter((one) => one.path.includes("/git/trees/")),
    ).toHaveLength(1);
    expect(
      new Set(github.tokenRequests.map((one) => one.installationId)),
    ).toEqual(new Set([INSTALLATION]));

    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, registered.receipt_id));
    expect(receipt).toMatchObject({
      operation: "register_skill_repository",
      status: "succeeded",
      result: {
        action: "register",
        skill_repository_id: registered.repository.id,
        url: repo.url,
        repository_id: repo.repositoryId,
        owner_id: 4242,
        ref: "main",
        commit: await repo.head(),
        license: "Apache-2.0",
        skills: 2,
      },
    });
    expect((await service.list(caller)).items).toHaveLength(1);
    expect(await service.get(caller, registered.repository.id)).toEqual({
      repository: registered.repository,
      skills: registered.skills,
    });
    expect((await service.list((await workspace()).caller)).items).toEqual([]);
  });

  test("a private repository, an internal one the App covers, and a ref that names nothing are refused and write no row", async () => {
    const { workspaceId, caller } = await workspace();
    await github.createRepository(
      "anthropics",
      "closed",
      { "skills/pdf/SKILL.md": skillMd("pdf") },
      { private: true },
    );
    expect(
      await refusal(
        service.register(caller, {
          url: "https://github.com/anthropics/closed",
        }),
      ),
    ).toEqual(["BAD_REQUEST", "repository_not_found"]);
    // Covered by the installation, so GitHub answers it; internal is not public.
    github.setInternal("acme", "home");
    try {
      expect(
        await refusal(
          service.register(caller, { url: "https://github.com/acme/home" }),
        ),
      ).toEqual(["BAD_REQUEST", "repository_not_public"]);
    } finally {
      github.setPrivate("acme", "home", true);
    }
    const repo = await publicRepository();
    expect(
      await refusal(service.register(caller, { url: repo.url, ref: "gone" })),
    ).toEqual(["BAD_REQUEST", "ref_not_found"]);
    github.truncateTrees(true);
    try {
      expect(
        await refusal(service.register(caller, { url: repo.url })),
      ).toEqual(["BAD_REQUEST", "listing_refused"]);
    } finally {
      github.truncateTrees(false);
    }
    expect(
      await db
        .select()
        .from(skillRepositories)
        .where(eq(skillRepositories.workspaceId, workspaceId)),
    ).toEqual([]);
  });

  test("two registrations of one repository at once make one row", async () => {
    const { workspaceId, caller } = await workspace();
    const repo = await publicRepository();
    const outcomes = await Promise.all(
      [1, 2].map(() =>
        service
          .register(caller, { url: repo.url })
          .then((one) => one.outcome)
          .catch(
            (error: { details?: { reason_code?: string } }) =>
              error.details?.reason_code,
          ),
      ),
    );
    expect(outcomes.sort()).toEqual([
      "registered",
      "repository_already_registered",
    ]);
    expect(
      await db
        .select()
        .from(skillRepositories)
        .where(eq(skillRepositories.workspaceId, workspaceId)),
    ).toHaveLength(1);
  });

  test("지금 확인 lists the new commit; a repository turned private, or a tree cut short, leaves the listing", async () => {
    const { caller } = await workspace();
    const repo = await publicRepository();
    const { repository } = await service.register(caller, { url: repo.url });
    const next = await repo.write({
      "skills/docx/SKILL.md": skillMd("docx"),
      "skills/notes/SKILL.md": null,
    });
    const checked = await service.checkNow(caller, repository.id);
    expect(checked.outcome).toBe("checked");
    expect(checked.repository).toMatchObject({
      last_commit: next,
      skill_count: 2,
      last_sync: { trigger: { kind: "manual" }, result: "listed" },
    });
    expect(checked.skills.map((skill) => [skill.path, skill.present])).toEqual([
      ["skills/docx", true],
      ["skills/notes", false],
      ["skills/pdf", true],
    ]);

    await repo.write({ "skills/xlsx/SKILL.md": skillMd("xlsx") });
    github.truncateTrees(true);
    try {
      expect(
        (await service.checkNow(caller, repository.id)).repository,
      ).toMatchObject({
        last_commit: next,
        last_sync: {
          result: "rejected",
          issues: [{ code: "tree_truncated" }],
        },
      });
    } finally {
      github.truncateTrees(false);
    }
    github.setPrivate("anthropics", repo.name, true);
    const gone = await service.checkNow(caller, repository.id);
    expect(gone.repository).toMatchObject({
      last_commit: next,
      last_sync: { result: "source_missing" },
    });
    expect(gone.skills.map((skill) => skill.path)).toEqual([
      "skills/docx",
      "skills/notes",
      "skills/pdf",
    ]);
  });

  test("a registered repository the App covers that turned internal is asked for no ref or file, and takes no new ref", async () => {
    const { caller } = await workspace();
    github.setPrivate("acme", "home", false);
    try {
      const { repository } = await service.register(caller, {
        url: "https://github.com/acme/home",
      });
      github.setInternal("acme", "home");
      const before = github.apiRequests.length;
      const checked = await service.checkNow(caller, repository.id);
      expect(checked.repository.last_sync).toMatchObject({
        result: "source_missing",
        commit: null,
      });
      expect(
        await refusal(service.setRef(caller, repository.id, "v2")),
      ).toEqual(["BAD_REQUEST", "repository_not_public"]);
      // The installation could read them; only the repository was asked.
      expect(
        github.apiRequests
          .slice(before)
          .filter((one) => /\/(git|commits)\//.test(one.path)),
      ).toEqual([]);
    } finally {
      github.setPrivate("acme", "home", true);
    }
  });

  test("a check that arrives while one reads GitHub is queued, and the holder lists once more", async () => {
    const { caller } = await workspace();
    const repo = await publicRepository();
    const { repository } = await service.register(caller, { url: repo.url });
    const hold = github.holdRest(/\/git\/trees\//);
    let first: Promise<{ outcome: string }>;
    try {
      first = service.checkNow(caller, repository.id);
      await waitFor(hold);
      expect((await service.checkNow(caller, repository.id)).outcome).toBe(
        "queued",
      );
    } finally {
      hold.release();
    }
    const before = github.apiRequests.length;
    expect((await first).outcome).toBe("checked");
    // The kept trigger's run read the tree again after the first one ended.
    expect(
      github.apiRequests
        .slice(before)
        .filter((one) => one.path.includes("/git/trees/")).length,
    ).toBeGreaterThanOrEqual(1);
    expect((await service.checkNow(caller, repository.id)).outcome).toBe(
      "checked",
    );
  });

  test("a removal while a listing reads GitHub leaves nothing written; registering again restores the row", async () => {
    const { caller } = await workspace();
    const repo = await publicRepository();
    const { repository } = await service.register(caller, { url: repo.url });
    const first = repository.last_commit;
    await repo.write({ "skills/docx/SKILL.md": skillMd("docx") });
    const hold = github.holdRest(/\/git\/trees\//);
    let running: Promise<unknown>;
    try {
      running = service.check(caller.ownerId, repository.id, {
        kind: "manual",
        userId: null,
      });
      await waitFor(hold);
      const removed = await service.remove(caller, repository.id);
      expect(removed.repository.state).toBe("removed");
      expect(removed.receipt_id).not.toBeNull();
    } finally {
      hold.release();
    }
    await running;
    const after = await service.get(caller, repository.id);
    expect(after.repository).toMatchObject({
      state: "removed",
      last_commit: first,
      last_sync: { trigger: { kind: "register" } },
    });
    expect(after.skills.map((skill) => skill.path)).toEqual([
      "skills/notes",
      "skills/pdf",
    ]);
    expect(await refusal(service.checkNow(caller, repository.id))).toEqual([
      "BAD_REQUEST",
      "repository_removed",
    ]);

    const restored = await service.register(caller, { url: repo.url });
    expect(restored.outcome).toBe("restored");
    expect(restored.repository).toMatchObject({
      id: repository.id,
      state: "active",
      last_commit: await repo.head(),
      skill_count: 3,
    });
    const [row] = await db
      .select()
      .from(skillRepositories)
      .where(eq(skillRepositories.id, repository.id));
    expect(row?.generation).toBe(3);
    expect(
      (
        await db
          .select({ operation: receipts.operation, result: receipts.result })
          .from(receipts)
          .where(eq(receipts.ownerId, caller.ownerId))
          .orderBy(asc(receipts.createdAt))
      ).map((one) => [
        one.operation,
        (one.result as { action?: string }).action ?? null,
      ]),
    ).toEqual([
      ["register_skill_repository", "register"],
      ["remove_skill_repository", null],
      ["register_skill_repository", "restore"],
    ]);
  });

  test("a ref change follows a tag once GitHub resolves it; one that names nothing changes nothing", async () => {
    const { caller } = await workspace();
    const repo = await publicRepository();
    const { repository } = await service.register(caller, { url: repo.url });
    const tagged = await repo.head();
    await github.setRef("anthropics", repo.name, "refs/tags/v1", tagged);
    const moved = await repo.write({ "skills/docx/SKILL.md": skillMd("docx") });
    expect(
      (await service.checkNow(caller, repository.id)).repository.last_commit,
    ).toBe(moved);

    expect(
      await refusal(service.setRef(caller, repository.id, "nope")),
    ).toEqual(["BAD_REQUEST", "ref_not_found"]);
    const changed = await service.setRef(caller, repository.id, "v1");
    expect(changed.check).toBe("checked");
    expect(changed.repository).toMatchObject({
      ref: "v1",
      last_commit: tagged,
      skill_count: 2,
      last_sync: { trigger: { kind: "ref" }, result: "listed" },
    });
    expect(changed.skills.map((skill) => [skill.path, skill.present])).toEqual([
      ["skills/docx", false],
      ["skills/notes", true],
      ["skills/pdf", true],
    ]);
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, changed.receipt_id ?? ""));
    expect(receipt).toMatchObject({
      operation: "update_skill_repository_ref",
      result: { from: "main", to: "v1", generation: 2 },
    });
    const same = await service.setRef(caller, repository.id, "v1");
    expect([same.receipt_id, same.check]).toEqual([null, null]);
  });
});
