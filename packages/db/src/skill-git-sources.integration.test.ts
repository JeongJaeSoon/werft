import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { scopesForRole, type WorkspaceRole } from "@werft-ai/contracts";
import {
  type BundleInputFile,
  type Caller,
  callerFor,
  createExtensionBundleService,
  EXTENSION_MANAGER_ROLES,
  type GitVersionInput,
  type SkillSyncTrigger,
} from "@werft-ai/platform";
import { createMemoryCheckpointObjectStore } from "@werft-ai/testkit/checkpoint-objects";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresExtensionBundleStore } from "./extensions/extension-bundles.ts";
import { createPostgresSkillGitSourceStore } from "./extensions/skill-git-sources.ts";
import * as schema from "./schema.ts";
import {
  extensionBundles,
  memberships,
  receipts,
  skillGitSources,
  users,
  workspaces,
} from "./schema.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const INSTALLATION = 77;
const REPOSITORY = 9001;
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);

const skillFiles = (name: string, body: string): BundleInputFile[] => [
  {
    path: `skills/${name}/SKILL.md`,
    kind: "file",
    mode: 0o644,
    bytes: new TextEncoder().encode(
      `---\nname: ${name}\ndescription: Use for ${name}\n---\n${body}\n`,
    ),
  },
];
const trigger = (
  kind: SkillSyncTrigger["kind"],
  userId: string | null = null,
): SkillSyncTrigger => ({
  kind,
  deliveryId: kind === "webhook" ? "d-1" : null,
  userId,
});

integration("Git skill sources on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "skill_git_sources_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const sources = () => createPostgresSkillGitSourceStore(db);
  const service = () =>
    createExtensionBundleService({
      store: createPostgresExtensionBundleStore(db),
      objects: createMemoryCheckpointObjectStore(),
    });

  async function workspace() {
    const workspaceId = randomUUID();
    const slug = `ws-${workspaceId.slice(0, 8)}`;
    await db.insert(workspaces).values({ id: workspaceId, slug, name: slug });
    const connectionId = randomUUID();
    await pool.query(
      `INSERT INTO github_apps (id, workspace_id, role, app_id, slug, name, html_url, api_base)
       VALUES ($1, $2, 'author', 54, 's', 'n', 'https://github.com/apps/s', 'https://api.github.com')`,
      [connectionId, workspaceId],
    );
    return { workspaceId, connectionId };
  }

  async function person(workspaceId: string, role: WorkspaceRole) {
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${role}-${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: role,
    });
    await db.insert(memberships).values({ workspaceId, userId, role });
    return {
      userId,
      caller: callerFor(
        {
          kind: "user",
          id: userId,
          workspace_id: workspaceId,
          role,
          scopes: [...scopesForRole(role)],
        },
        { kind: "web" },
        randomUUID(),
      ),
    };
  }

  const git = (
    commit: string,
    by: SkillSyncTrigger,
    newSource?: GitVersionInput["newSource"],
    ref = "main",
  ): GitVersionInput => ({
    location: { repositoryId: REPOSITORY, path: "skills/x", ref, commit },
    trigger: by,
    checkedAt: new Date(),
    ...(newSource === undefined ? {} : { newSource }),
  });

  /** A skill a person registered from GitHub, so a source row exists. */
  async function registered(name: string, ref = "main") {
    const ws = await workspace();
    const admin = await person(ws.workspaceId, "admin");
    const result = await service().register({
      principal: admin.caller,
      slug: name,
      files: skillFiles(name, "First."),
      label: name,
      source: "github",
      skill: true,
      git: git(
        COMMIT_A,
        trigger("register", admin.userId),
        {
          connectionId: ws.connectionId,
          installationId: INSTALLATION,
          repositoryId: REPOSITORY,
          repository: "acme/skills",
        },
        ref,
      ),
    });
    if (result.outcome !== "registered") throw new Error(result.outcome);
    return { ...ws, admin, first: result };
  }

  const syncWith = (
    workspaceId: string,
    name: string,
    body: string,
    by: SkillSyncTrigger,
    leaseToken: string | undefined,
    commit = COMMIT_B,
  ) =>
    service().register({
      principal: { ownerId: workspaceId } as Caller,
      slug: name,
      files: skillFiles(name, body),
      label: name,
      source: "github",
      skill: true,
      git: {
        ...git(commit, by),
        ...(leaseToken === undefined ? {} : { leaseToken }),
      },
    });

  /** A version the sync writes under its own lease, as a check does. */
  async function synced(
    workspaceId: string,
    name: string,
    body: string,
    by: SkillSyncTrigger,
  ) {
    const begun = await sources().begin(workspaceId, name, by, 60_000);
    const token = begun.outcome === "started" ? begun.token : undefined;
    try {
      return await syncWith(workspaceId, name, body, by, token);
    } finally {
      if (token !== undefined) {
        await sources().finish(workspaceId, name, 60_000, token);
      }
    }
  }

  test("a person's first registration writes the source with the version, and fixes the skill's source", async () => {
    const { workspaceId, connectionId, admin, first } =
      await registered("review");
    expect(first.bundle).toMatchObject({
      source: "github",
      review: "pending",
      registeredBy: admin.userId,
      git: {
        repositoryId: REPOSITORY,
        path: "skills/x",
        ref: "main",
        commit: COMMIT_A,
        trigger: { kind: "register", deliveryId: null, userId: admin.userId },
      },
    });
    expect(await sources().get(workspaceId, "review")).toMatchObject({
      connectionId,
      installationId: INSTALLATION,
      repositoryId: REPOSITORY,
      repository: "acme/skills",
      syncEnabled: true,
      lastCheck: { result: "created", commit: COMMIT_A },
    });
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, first.receiptId));
    expect(receipt?.result).toMatchObject({ by: "user" });

    const again = await service().register({
      principal: admin.caller,
      slug: "review",
      files: skillFiles("review", "Other."),
      label: "review",
      source: "github",
      skill: true,
      git: git(COMMIT_B, trigger("register", admin.userId), {
        connectionId,
        installationId: INSTALLATION,
        repositoryId: REPOSITORY + 1,
        repository: "acme/other",
      }),
    });
    expect(again.outcome).toBe("source_mismatch");
    const upload = await service().register({
      principal: admin.caller,
      slug: "review",
      files: skillFiles("review", "Uploaded."),
      label: "review",
      source: "upload",
      skill: true,
    });
    expect(upload.outcome).toBe("source_mismatch");
  });

  test("a synced version has no person behind it, and the same content again is recorded as unchanged", async () => {
    const { workspaceId } = await registered("lint");
    const made = await synced(
      workspaceId,
      "lint",
      "Second.",
      trigger("webhook"),
    );
    if (made.outcome !== "registered") throw new Error(made.outcome);
    expect(made.bundle).toMatchObject({
      registeredBy: null,
      review: "pending",
      git: {
        commit: COMMIT_B,
        trigger: { kind: "webhook", deliveryId: "d-1" },
      },
    });
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, made.receiptId));
    expect(receipt?.result).toMatchObject({ by: "sync" });
    expect((await sources().get(workspaceId, "lint"))?.lastCheck).toMatchObject(
      { result: "created", versionId: made.bundle.id, commit: COMMIT_B },
    );

    const same = await synced(workspaceId, "lint", "Second.", trigger("daily"));
    expect(same.outcome).toBe("already_registered");
    expect((await sources().get(workspaceId, "lint"))?.lastCheck).toMatchObject(
      {
        result: "unchanged",
        versionId: made.bundle.id,
        trigger: { kind: "daily" },
      },
    );
    const versions = await db
      .select()
      .from(extensionBundles)
      .where(
        and(
          eq(extensionBundles.workspaceId, workspaceId),
          eq(extensionBundles.name, "lint"),
        ),
      );
    expect(versions.map((row) => row.version).sort()).toEqual([1, 2]);
  });

  test("a sync with no source row writes nothing", async () => {
    const { workspaceId } = await workspace();
    expect(
      (await synced(workspaceId, "ghost", "Body.", trigger("daily"))).outcome,
    ).toBe("source_mismatch");
    expect(
      await db
        .select()
        .from(extensionBundles)
        .where(eq(extensionBundles.workspaceId, workspaceId)),
    ).toEqual([]);
  });

  test("paused sync skips the webhook and the daily check, but not a person's check; pausing writes a receipt", async () => {
    const { workspaceId, admin } = await registered("docs");
    const member = await person(workspaceId, "member");
    const asMember = await sources().setEnabled({
      workspaceId,
      name: "docs",
      enabled: false,
      receiptId: randomUUID(),
      principal: member.caller,
      managerRoles: EXTENSION_MANAGER_ROLES,
    });
    expect(asMember.outcome).toBe("outranked");
    const receiptId = randomUUID();
    const paused = await sources().setEnabled({
      workspaceId,
      name: "docs",
      enabled: false,
      receiptId,
      principal: admin.caller,
      managerRoles: EXTENSION_MANAGER_ROLES,
    });
    expect(paused).toMatchObject({
      outcome: "updated",
      receiptId,
      source: { syncEnabled: false },
    });
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, receiptId));
    expect(receipt).toMatchObject({
      operation: "update_extension_sync",
      result: { name: "docs", action: "pause" },
    });
    expect(
      (
        await sources().setEnabled({
          workspaceId,
          name: "docs",
          enabled: false,
          receiptId: randomUUID(),
          principal: admin.caller,
          managerRoles: EXTENSION_MANAGER_ROLES,
        })
      ).outcome,
    ).toBe("unchanged");

    for (const kind of ["webhook", "daily"] as const) {
      expect(
        (await synced(workspaceId, "docs", "Paused.", trigger(kind))).outcome,
      ).toBe("paused");
      expect(
        (await sources().get(workspaceId, "docs"))?.lastCheck,
      ).toMatchObject({ result: "paused", versionId: null });
    }
    expect(
      (
        await synced(
          workspaceId,
          "docs",
          "Pressed.",
          trigger("manual", admin.userId),
        )
      ).outcome,
    ).toBe("registered");
  });

  async function started(
    workspaceId: string,
    name: string,
    by: SkillSyncTrigger,
    leaseMs = 60_000,
  ) {
    const begun = await sources().begin(workspaceId, name, by, leaseMs);
    if (begun.outcome !== "started") throw new Error(begun.outcome);
    return begun.token;
  }
  const outcomeOf = async (
    workspaceId: string,
    name: string,
    by: SkillSyncTrigger,
  ) => (await sources().begin(workspaceId, name, by, 60_000)).outcome;

  test("one check at a time: a trigger meanwhile is kept once and run after", async () => {
    const { workspaceId } = await registered("queue");
    const store = sources();
    const token = await started(workspaceId, "queue", trigger("webhook"));
    expect(await outcomeOf(workspaceId, "queue", trigger("daily"))).toBe(
      "queued",
    );
    expect(await outcomeOf(workspaceId, "queue", trigger("webhook"))).toBe(
      "queued",
    );
    expect(await store.finish(workspaceId, "queue", 60_000, token)).toEqual(
      trigger("webhook"),
    );
    expect(await outcomeOf(workspaceId, "queue", trigger("daily"))).toBe(
      "queued",
    );
    expect(await store.finish(workspaceId, "queue", 60_000, token)).toEqual(
      trigger("daily"),
    );
    expect(await store.finish(workspaceId, "queue", 60_000, token)).toBeNull();
    expect(await outcomeOf(workspaceId, "nothing", trigger("webhook"))).toBe(
      "not_found",
    );
  });

  test("a person's check kept meanwhile is not replaced by a webhook or the daily check", async () => {
    const { workspaceId, admin } = await registered("kept");
    const token = await started(workspaceId, "kept", trigger("daily"));
    const manual = trigger("manual", admin.userId);
    expect(await outcomeOf(workspaceId, "kept", manual)).toBe("queued");
    expect(await outcomeOf(workspaceId, "kept", trigger("webhook"))).toBe(
      "queued",
    );
    expect(await outcomeOf(workspaceId, "kept", trigger("daily"))).toBe(
      "queued",
    );
    expect(await sources().finish(workspaceId, "kept", 60_000, token)).toEqual(
      manual,
    );
  });

  test("an expired lease is taken over; the old holder's finish, check and version then write nothing", async () => {
    const { workspaceId } = await registered("taken");
    const store = sources();
    const old = await started(workspaceId, "taken", trigger("daily"), 1);
    await Bun.sleep(20);
    const token = await started(workspaceId, "taken", trigger("webhook"));
    expect(await store.finish(workspaceId, "taken", 60_000, old)).toBeNull();
    expect(await outcomeOf(workspaceId, "taken", trigger("daily"))).toBe(
      "queued",
    );
    const before = (await store.get(workspaceId, "taken"))?.lastCheck;
    await store.recordCheck(
      workspaceId,
      "taken",
      {
        at: new Date(),
        trigger: trigger("daily"),
        commit: null,
        result: "github_unavailable",
        versionId: null,
        issues: [],
      },
      old,
    );
    expect((await store.get(workspaceId, "taken"))?.lastCheck).toEqual(before);
    expect(
      (await syncWith(workspaceId, "taken", "Late.", trigger("daily"), old))
        .outcome,
    ).toBe("lease_lost");
    expect(
      (
        await syncWith(
          workspaceId,
          "taken",
          "Bare.",
          trigger("daily"),
          undefined,
        )
      ).outcome,
    ).toBe("lease_lost");
    expect(
      (await syncWith(workspaceId, "taken", "Now.", trigger("webhook"), token))
        .outcome,
    ).toBe("registered");
    expect(await store.finish(workspaceId, "taken", 60_000, token)).toEqual(
      trigger("daily"),
    );
  });

  test("a trigger kept for a holder that died is run by the next holder", async () => {
    const { workspaceId } = await registered("orphan");
    await started(workspaceId, "orphan", trigger("daily"), 300);
    expect(await outcomeOf(workspaceId, "orphan", trigger("webhook"))).toBe(
      "queued",
    );
    await Bun.sleep(400);
    const token = await started(workspaceId, "orphan", trigger("daily"));
    expect(
      await sources().finish(workspaceId, "orphan", 60_000, token),
    ).toEqual(trigger("webhook"));
  });

  test("two replicas beginning at once: one starts, one queues", async () => {
    const { workspaceId } = await registered("race");
    const answers = await Promise.all([
      sources().begin(workspaceId, "race", trigger("webhook"), 60_000),
      sources().begin(workspaceId, "race", trigger("daily"), 60_000),
    ]);
    expect(answers.map((answer) => answer.outcome).sort()).toEqual([
      "queued",
      "started",
    ]);
  });

  test("a push matches by connection, installation, repository and branch or tag; not paused or commit-pinned skills", async () => {
    const { workspaceId, connectionId, admin } = await registered("tagged");
    const store = sources();
    const at = (ref: string, connectionIds = [connectionId]) =>
      store
        .matching({
          connectionIds,
          installationId: INSTALLATION,
          repositoryId: REPOSITORY,
          ref,
        })
        .then((found) =>
          found
            .filter((source) => source.workspaceId === workspaceId)
            .map((source) => source.name),
        );
    expect(await at("refs/heads/main")).toEqual(["tagged"]);
    expect(await at("refs/tags/main")).toEqual(["tagged"]);
    expect(await at("refs/heads/other")).toEqual([]);
    expect(await at("refs/heads/main", [randomUUID()])).toEqual([]);
    await db
      .update(skillGitSources)
      .set({ ref: COMMIT_A })
      .where(eq(skillGitSources.workspaceId, workspaceId));
    expect(await at(`refs/heads/${COMMIT_A}`)).toEqual([]);
    await db
      .update(skillGitSources)
      .set({ ref: "refs/heads/main" })
      .where(eq(skillGitSources.workspaceId, workspaceId));
    expect(await at("refs/heads/main")).toEqual(["tagged"]);
    expect(await at("refs/tags/main")).toEqual([]);
    expect(await at("refs/heads/refs/heads/main")).toEqual([]);
    await db
      .update(skillGitSources)
      .set({ ref: "main" })
      .where(eq(skillGitSources.workspaceId, workspaceId));
    await store.setEnabled({
      workspaceId,
      name: "tagged",
      enabled: false,
      receiptId: randomUUID(),
      principal: admin.caller,
      managerRoles: EXTENSION_MANAGER_ROLES,
    });
    expect(await at("refs/heads/main")).toEqual([]);
  });

  test("the daily pass claims a due source once, oldest first, and skips paused ones", async () => {
    const first = await registered("daily-a");
    const second = await registered("daily-b");
    const mine = new Set<string>([first.workspaceId, second.workspaceId]);
    await db
      .update(skillGitSources)
      .set({ lastCheckedAt: null })
      .where(eq(skillGitSources.workspaceId, first.workspaceId));
    await sources().setEnabled({
      workspaceId: second.workspaceId,
      name: "daily-b",
      enabled: false,
      receiptId: randomUUID(),
      principal: second.admin.caller,
      managerRoles: EXTENSION_MANAGER_ROLES,
    });
    const before = new Date(Date.now() + 60_000);
    const dueMine = async (at: Date) =>
      (await sources().due(at, 1000, 60_000)).filter((row) =>
        mine.has(row.workspaceId),
      );
    expect(await dueMine(before)).toEqual([
      { workspaceId: first.workspaceId, name: "daily-a" },
    ]);
    expect(await dueMine(before)).toEqual([]);
    // A replica that claimed it and died lets it go once the claim runs out.
    expect(await dueMine(new Date(before.getTime() + 120_000))).toEqual([
      { workspaceId: first.workspaceId, name: "daily-a" },
    ]);
  });
});
