import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { scopesForRole, type WorkspaceRole } from "@werft-ai/contracts";
import {
  callerFor,
  EXTENSION_MANAGER_ROLES,
  type SkillListingEntry,
  type SkillRepositoryStore,
} from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { receiptFromRow } from "../postgres-unit-of-work.ts";
import * as schema from "../schema.ts";
import {
  extensionBundles,
  memberships,
  receipts,
  skillRepositories,
  skillRepositorySkills,
  users,
  workspaces,
} from "../schema.ts";
import { createPostgresSkillRepositoryStore } from "./skill-repositories.ts";

// One connection: what two replicas do to each other's locks is in
// apps/control-host's skill-repositories.integration.test.ts.

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const AT = new Date("2026-11-28T00:00:00.000Z");
const URL = "https://github.com/anthropics/skills";

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let store: SkillRepositoryStore;

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema });
  store = createPostgresSkillRepositoryStore(db);
});

afterEach(async () => {
  await client.close();
});

async function workspace() {
  const workspaceId = randomUUID();
  const slug = `ws-${workspaceId.slice(0, 8)}`;
  await db.insert(workspaces).values({ id: workspaceId, slug, name: slug });
  const connectionId = randomUUID();
  await client.query(
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

const entry = (
  path: string,
  over: Partial<SkillListingEntry> = {},
): SkillListingEntry => ({
  path,
  name: path.split("/").at(-1) ?? null,
  description: `What ${path} does.`,
  license: null,
  treeSha: "c".repeat(40),
  fileCount: 2,
  totalBytes: 120,
  hasScripts: false,
  issues: [],
  ...over,
});

/** A workspace with an owner, and a registration of GitHub repository 7 in it. */
async function registered(
  entries: SkillListingEntry[] = [entry("skills/pdf")],
  repositoryId = 7,
) {
  const { workspaceId, connectionId } = await workspace();
  const owner = await person(workspaceId, "owner");
  const register = (
    over: Partial<Parameters<SkillRepositoryStore["register"]>[0]> = {},
  ) =>
    store.register({
      workspaceId,
      id: randomUUID(),
      receiptId: randomUUID(),
      principal: owner.caller,
      managerRoles: EXTENSION_MANAGER_ROLES,
      url: URL,
      github: { repositoryId, repository: "anthropics/skills", ownerId: 70 },
      ref: "main",
      connectionId,
      installationId: 40,
      read: { commit: COMMIT_A, license: "Apache-2.0", entries },
      at: AT,
      ...over,
    });
  const first = await register();
  if (first.outcome !== "registered") throw new Error(first.outcome);
  const managed = (id = first.repository.id) => ({
    workspaceId,
    id,
    receiptId: randomUUID(),
    principal: owner.caller,
    managerRoles: EXTENSION_MANAGER_ROLES,
  });
  return {
    workspaceId,
    connectionId,
    owner,
    register,
    managed,
    id: first.repository.id,
    first,
  };
}

const receiptsOf = async (workspaceId: string) =>
  (
    await db
      .select()
      .from(receipts)
      .where(eq(receipts.ownerId, workspaceId))
      .orderBy(receipts.createdAt)
  ).map(receiptFromRow);

describe("registering", () => {
  test("writes the repository, its listing and a receipt the strict reader reads", async () => {
    const { workspaceId, connectionId, owner, id, first } = await registered([
      entry("skills/pdf", { license: "MIT", hasScripts: true }),
      entry("skills/broken", {
        name: null,
        description: null,
        issues: [{ path: "SKILL.md", code: "bad_frontmatter", message: "no" }],
      }),
    ]);
    expect(first.repository).toEqual({
      workspaceId,
      id,
      repositoryId: 7,
      repository: "anthropics/skills",
      ref: "main",
      access: "public",
      connectionId,
      installationId: 40,
      ownerId: 70,
      license: "Apache-2.0",
      generation: 1,
      lastCommit: COMMIT_A,
      lastSync: {
        at: AT,
        trigger: { kind: "register", userId: owner.userId },
        commit: COMMIT_A,
        result: "listed",
        issues: [],
      },
      skillCount: 2,
      createdBy: owner.userId,
      createdAt: expect.any(Date),
      removedBy: null,
      removedAt: null,
    });
    expect(await store.find(workspaceId, id)).toEqual(first.repository);
    expect(await store.list(workspaceId)).toEqual([first.repository]);
    expect(await store.skills(workspaceId, id)).toEqual([
      {
        ...entry("skills/broken", {
          name: null,
          description: null,
          issues: [
            { path: "SKILL.md", code: "bad_frontmatter", message: "no" },
          ],
        }),
        id: expect.any(String),
        present: true,
        enabled: false,
        nameOwner: null,
        nameShared: false,
      },
      {
        ...entry("skills/pdf", { license: "MIT", hasScripts: true }),
        id: expect.any(String),
        present: true,
        enabled: false,
        nameOwner: null,
        nameShared: false,
      },
    ]);
    expect(await receiptsOf(workspaceId)).toMatchObject([
      {
        id: first.receiptId,
        operation: "register_skill_repository",
        status: "succeeded",
        target_ref: {
          resource: { kind: "workspace", id: workspaceId },
          workspace_id: workspaceId,
        },
        result: {
          action: "register",
          skill_repository_id: id,
          url: URL,
          repository_id: 7,
          repository: "anthropics/skills",
          owner_id: 70,
          ref: "main",
          commit: COMMIT_A,
          license: "Apache-2.0",
          generation: 1,
          skills: 2,
        },
      },
    ]);
  });

  test("a repository the workspace already follows is not written again", async () => {
    const { workspaceId, register, id } = await registered();
    const again = await register({ ref: "other" });
    expect(again).toMatchObject({
      outcome: "already_registered",
      repository: { id, ref: "main", generation: 1 },
    });
    expect(await receiptsOf(workspaceId)).toHaveLength(1);
    expect(await store.list(workspaceId)).toHaveLength(1);
  });

  test("two workspaces follow the same GitHub repository, each in its own row", async () => {
    const one = await registered();
    const two = await registered();
    expect(one.id).not.toBe(two.id);
    expect(await store.find(two.workspaceId, one.id)).toBeNull();
    expect(await store.skills(two.workspaceId, one.id)).toEqual([]);
    expect((await store.remove(two.managed(one.id))).outcome).toBe("not_found");
  });

  test("only a live owner or admin writes", async () => {
    const { workspaceId, owner, register, managed, id } = await registered();
    const member = await person(workspaceId, "member");
    const admin = await person(workspaceId, "admin");
    const outsider = await person((await workspace()).workspaceId, "owner");
    for (const [principal, outcome] of [
      [member.caller, "outranked"],
      [outsider.caller, "actor_inactive"],
    ] as const) {
      expect(
        await register({
          principal,
          github: { repositoryId: 8, repository: "a/b", ownerId: 1 },
        }),
      ).toEqual({ outcome });
      expect(await store.remove({ ...managed(), principal })).toEqual({
        outcome,
      });
      expect(
        await store.setRef({ ...managed(), principal, ref: "v2" }),
      ).toEqual({ outcome });
    }
    expect(
      (await store.setRef({ ...managed(), principal: admin.caller, ref: "v2" }))
        .outcome,
    ).toBe("updated");
    await db
      .update(memberships)
      .set({ disabledAt: new Date() })
      .where(eq(memberships.userId, owner.userId));
    expect(await store.remove(managed())).toEqual({
      outcome: "actor_inactive",
    });
    expect((await store.find(workspaceId, id))?.removedAt).toBeNull();
  });
});

describe("removing and restoring", () => {
  test("a removal marks the row under a new generation and keeps its skills", async () => {
    const { workspaceId, owner, managed, id } = await registered();
    const removed = await store.remove(managed());
    expect(removed).toMatchObject({
      outcome: "removed",
      repository: {
        id,
        generation: 2,
        removedBy: owner.userId,
        removedAt: expect.any(Date),
        skillCount: 1,
      },
    });
    expect(await store.remove(managed())).toMatchObject({
      outcome: "unchanged",
      repository: { generation: 2 },
    });
    expect(await store.skills(workspaceId, id)).toHaveLength(1);
    expect((await receiptsOf(workspaceId)).at(-1)).toMatchObject({
      operation: "remove_skill_repository",
      result: {
        skill_repository_id: id,
        repository_id: 7,
        repository: "anthropics/skills",
        generation: 2,
        skills: 1,
      },
    });
    expect(await receiptsOf(workspaceId)).toHaveLength(2);
  });

  test("registering a removed repository brings the same row back, switches off, at what was read now", async () => {
    const { workspaceId, connectionId, register, managed, id } =
      await registered([entry("skills/pdf"), entry("skills/gone")]);
    const [pdf] = await db
      .select()
      .from(skillRepositorySkills)
      .where(eq(skillRepositorySkills.path, "skills/pdf"));
    await db
      .update(skillRepositorySkills)
      .set({ enabled: true, enableGrantId: randomUUID() })
      .where(eq(skillRepositorySkills.path, "skills/pdf"));
    // A lease a listing held when the repository was removed.
    await store.begin(
      workspaceId,
      id,
      { kind: "manual", userId: null },
      60_000,
    );
    await store.remove(managed());

    const restored = await register({
      ref: "v2",
      installationId: 41,
      github: { repositoryId: 7, repository: "anthropic/skills", ownerId: 71 },
      read: {
        commit: COMMIT_B,
        license: null,
        entries: [entry("skills/pdf"), entry("skills/docx")],
      },
    });
    expect(restored).toMatchObject({
      outcome: "restored",
      repository: {
        id,
        connectionId,
        repository: "anthropic/skills",
        ref: "v2",
        installationId: 41,
        ownerId: 71,
        license: null,
        generation: 3,
        lastCommit: COMMIT_B,
        removedAt: null,
        removedBy: null,
        skillCount: 2,
      },
    });
    expect(
      (await store.skills(workspaceId, id)).map((skill) => [
        skill.path,
        skill.present,
        skill.enabled,
      ]),
    ).toEqual([
      ["skills/docx", true, false],
      ["skills/gone", false, false],
      ["skills/pdf", true, false],
    ]);
    const [after] = await db
      .select()
      .from(skillRepositorySkills)
      .where(eq(skillRepositorySkills.path, "skills/pdf"));
    expect(after).toMatchObject({ id: pdf?.id, enableGrantId: null });
    // The old lease is gone with the removal.
    expect(
      (
        await store.begin(
          workspaceId,
          id,
          { kind: "manual", userId: null },
          60_000,
        )
      ).outcome,
    ).toBe("started");
    expect((await receiptsOf(workspaceId)).at(-1)).toMatchObject({
      operation: "register_skill_repository",
      result: {
        action: "restore",
        skill_repository_id: id,
        ref: "v2",
        commit: COMMIT_B,
        owner_id: 71,
        license: null,
        generation: 3,
      },
    });
  });
});

describe("the ref", () => {
  test("a change raises the generation and records both refs; the same ref changes nothing", async () => {
    const { workspaceId, managed, id } = await registered();
    expect(await store.setRef({ ...managed(), ref: "main" })).toMatchObject({
      outcome: "unchanged",
      repository: { generation: 1 },
    });
    expect(await store.setRef({ ...managed(), ref: "v2" })).toMatchObject({
      outcome: "updated",
      repository: { id, ref: "v2", generation: 2, lastCommit: COMMIT_A },
    });
    expect(await receiptsOf(workspaceId)).toMatchObject([
      { operation: "register_skill_repository" },
      {
        operation: "update_skill_repository_ref",
        result: {
          skill_repository_id: id,
          repository_id: 7,
          from: "main",
          to: "v2",
          generation: 2,
        },
      },
    ]);
    await store.remove(managed());
    expect(await store.setRef({ ...managed(), ref: "v3" })).toEqual({
      outcome: "not_found",
    });
  });
});

describe("a listing's lease and what it may write", () => {
  const manual = { kind: "manual", userId: null } as const;

  test("one listing holds the repository; a trigger that arrives meanwhile runs once more", async () => {
    const { workspaceId, id } = await registered();
    const begun = await store.begin(workspaceId, id, manual, 60_000);
    if (begun.outcome !== "started") throw new Error(begun.outcome);
    expect(
      await store.begin(workspaceId, id, { kind: "ref", userId: "u" }, 60_000),
    ).toEqual({ outcome: "queued" });
    expect(await store.finish(workspaceId, id, 60_000, begun.token)).toEqual({
      kind: "ref",
      userId: "u",
    });
    // Still held for the kept trigger's run.
    expect((await store.begin(workspaceId, id, manual, 60_000)).outcome).toBe(
      "queued",
    );
    expect(await store.finish(workspaceId, id, 60_000, begun.token)).toEqual(
      manual,
    );
    expect(await store.finish(workspaceId, id, 60_000, begun.token)).toBeNull();
    expect(
      await store.finish(workspaceId, id, 60_000, randomUUID()),
    ).toBeNull();
    expect((await store.begin(workspaceId, id, manual, 60_000)).outcome).toBe(
      "started",
    );
  });

  test("a lease that passed is taken over, and its holder then writes nothing", async () => {
    const { workspaceId, id } = await registered();
    const dead = await store.begin(workspaceId, id, manual, 0);
    const next = await store.begin(workspaceId, id, manual, 60_000);
    if (dead.outcome !== "started" || next.outcome !== "started") {
      throw new Error("a passed lease was not taken over");
    }
    const sync = {
      at: AT,
      trigger: manual,
      commit: COMMIT_B,
      result: "listed" as const,
      issues: [],
    };
    const read = { commit: COMMIT_B, license: null, entries: [] };
    expect(
      await store.record({
        workspaceId,
        id,
        token: dead.token,
        generation: 1,
        sync,
        read,
      }),
    ).toBe(false);
    expect((await store.find(workspaceId, id))?.lastCommit).toBe(COMMIT_A);
    expect(
      await store.record({
        workspaceId,
        id,
        token: next.token,
        generation: 1,
        sync,
        read,
      }),
    ).toBe(true);
  });

  test("a listing writes over each path's row, marks the rest gone and leaves the switch alone", async () => {
    const { workspaceId, id } = await registered([
      entry("skills/pdf"),
      entry("skills/gone"),
    ]);
    const before = await store.skills(workspaceId, id);
    await db
      .update(skillRepositorySkills)
      .set({ enabled: true, enableGrantId: randomUUID() })
      .where(eq(skillRepositorySkills.path, "skills/pdf"));
    const begun = await store.begin(workspaceId, id, manual, 60_000);
    if (begun.outcome !== "started") throw new Error(begun.outcome);
    const later = new Date("2026-11-29T00:00:00.000Z");
    expect(
      await store.record({
        workspaceId,
        id,
        token: begun.token,
        generation: 1,
        sync: {
          at: later,
          trigger: manual,
          commit: COMMIT_B,
          result: "listed",
          issues: [],
        },
        read: {
          commit: COMMIT_B,
          license: "MIT",
          entries: [
            entry("skills/pdf", {
              description: "New words.",
              treeSha: "d".repeat(40),
              issues: [{ path: "x", code: "denied_path", message: "no" }],
            }),
            entry("skills/docx"),
          ],
        },
      }),
    ).toBe(true);
    expect(await store.find(workspaceId, id)).toMatchObject({
      lastCommit: COMMIT_B,
      license: "MIT",
      generation: 1,
      skillCount: 2,
      lastSync: { at: later, commit: COMMIT_B, result: "listed" },
    });
    const after = await store.skills(workspaceId, id);
    expect(
      after.map((skill) => [skill.path, skill.present, skill.enabled]),
    ).toEqual([
      ["skills/docx", true, false],
      ["skills/gone", false, false],
      ["skills/pdf", true, true],
    ]);
    expect(after[2]).toMatchObject({
      id: before.find((skill) => skill.path === "skills/pdf")?.id,
      description: "New words.",
      treeSha: "d".repeat(40),
      issues: [{ path: "x", code: "denied_path", message: "no" }],
    });
    // A directory that comes back is present again, in its old row.
    await store.record({
      workspaceId,
      id,
      token: begun.token,
      generation: 1,
      sync: {
        at: later,
        trigger: manual,
        commit: COMMIT_A,
        result: "listed",
        issues: [],
      },
      read: {
        commit: COMMIT_A,
        license: null,
        entries: [entry("skills/gone")],
      },
    });
    expect(
      (await store.skills(workspaceId, id)).map((skill) => [
        skill.path,
        skill.present,
        skill.id === before.find((one) => one.path === skill.path)?.id,
      ]),
    ).toEqual([
      ["skills/docx", false, false],
      ["skills/gone", true, true],
      ["skills/pdf", false, true],
    ]);
  });

  test("a failed listing records why and leaves the commit, the license and the skills", async () => {
    const { workspaceId, id } = await registered();
    const begun = await store.begin(workspaceId, id, manual, 60_000);
    if (begun.outcome !== "started") throw new Error(begun.outcome);
    expect(
      await store.record({
        workspaceId,
        id,
        token: begun.token,
        generation: 1,
        sync: {
          at: AT,
          trigger: manual,
          commit: COMMIT_B,
          result: "rejected",
          issues: [{ path: "", code: "tree_truncated", message: "cut" }],
        },
        read: null,
      }),
    ).toBe(true);
    expect(await store.find(workspaceId, id)).toMatchObject({
      lastCommit: COMMIT_A,
      license: "Apache-2.0",
      skillCount: 1,
      lastSync: {
        commit: COMMIT_B,
        result: "rejected",
        issues: [{ path: "", code: "tree_truncated", message: "cut" }],
      },
    });
  });

  test("a listing read under an older generation, or of a removed repository, writes nothing", async () => {
    const { workspaceId, managed, id } = await registered();
    const begun = await store.begin(workspaceId, id, manual, 60_000);
    if (begun.outcome !== "started") throw new Error(begun.outcome);
    const write = (generation: number) =>
      store.record({
        workspaceId,
        id,
        token: begun.token,
        generation,
        sync: {
          at: AT,
          trigger: manual,
          commit: COMMIT_B,
          result: "listed",
          issues: [],
        },
        read: { commit: COMMIT_B, license: null, entries: [] },
      });
    await store.setRef({ ...managed(), ref: "v2" });
    expect(await write(1)).toBe(false);
    expect(await store.find(workspaceId, id)).toMatchObject({
      lastCommit: COMMIT_A,
      skillCount: 1,
    });
    // The holder's next run reads the row again and writes under the new one.
    expect(await write(2)).toBe(true);
    await store.remove(managed());
    expect(await write(3)).toBe(false);
    expect(await store.begin(workspaceId, id, manual, 60_000)).toEqual({
      outcome: "not_found",
    });
    expect(
      await store.begin(workspaceId, randomUUID(), manual, 60_000),
    ).toEqual({ outcome: "not_found" });
  });

  test("a result or trigger a later host wrote reads as the nearest one this host knows", async () => {
    const { workspaceId, id } = await registered();
    await db
      .update(skillRepositories)
      .set({
        lastSync: {
          at: AT.toISOString(),
          trigger: { kind: "daily", user_id: null },
          commit: COMMIT_A,
          result: "owner_changed",
          issues: [],
        },
      })
      .where(eq(skillRepositories.id, id));
    expect((await store.find(workspaceId, id))?.lastSync).toMatchObject({
      trigger: { kind: "manual", userId: null },
      result: "github_unavailable",
    });
  });
});

describe("who holds a listed name", () => {
  test("a workspace skill of that name, by its source; and another listed directory of that name", async () => {
    const one = await registered([
      entry("skills/pdf"),
      entry("copy/pdf"),
      entry("skills/docx"),
      entry("skills/notes"),
      entry("skills/solo"),
    ]);
    // Another repository of the same workspace lists docx too.
    const other = await one.register({
      github: { repositoryId: 8, repository: "acme/more", ownerId: 71 },
      read: {
        commit: COMMIT_A,
        license: null,
        entries: [entry("skills/docx"), entry("skills/solo")],
      },
    });
    if (other.outcome !== "registered") throw new Error(other.outcome);
    // And another workspace's listing and skills never count.
    const elsewhere = await registered([entry("skills/notes")], 9);
    for (const [workspaceId, name, source] of [
      [one.workspaceId, "notes", "upload"],
      [one.workspaceId, "docx", "github"],
      [elsewhere.workspaceId, "solo", "upload"],
    ] as const) {
      await db.insert(extensionBundles).values({
        id: randomUUID(),
        workspaceId,
        name,
        digest: randomUUID().replaceAll("-", "").repeat(2),
        label: name,
        source,
        sizeBytes: 1,
        manifest: {},
        registeredBy: one.owner.userId,
        ...(source === "github" ? { git: {} } : {}),
        version: 1,
      });
    }
    const shown = async () =>
      (await store.skills(one.workspaceId, one.id)).map((skill) => [
        skill.path,
        skill.nameOwner,
        skill.nameShared,
      ]);
    expect(await shown()).toEqual([
      ["copy/pdf", null, true],
      ["skills/docx", "github", true],
      ["skills/notes", "upload", false],
      ["skills/pdf", null, true],
      ["skills/solo", null, true],
    ]);
    // A removed repository's listing no longer shares a name.
    await store.remove(one.managed(other.repository.id));
    expect(await shown()).toEqual([
      ["copy/pdf", null, true],
      ["skills/docx", "github", false],
      ["skills/notes", "upload", false],
      ["skills/pdf", null, true],
      ["skills/solo", null, false],
    ]);
  });
});

describe("what the tables refuse", () => {
  test("an access other than public, a switch on without its grant, a second row of one GitHub repository", async () => {
    const { workspaceId, connectionId, owner, id } = await registered();
    const refused = async (run: Promise<unknown>) =>
      String(
        ((await run.catch((error: unknown) => error)) as { cause?: unknown })
          .cause ?? "",
      );
    expect(
      await refused(
        db
          .update(skillRepositories)
          .set({ access: "connection" })
          .where(eq(skillRepositories.id, id))
          .execute(),
      ),
    ).toContain("skill_repositories_access_check");
    expect(
      await refused(
        db
          .update(skillRepositorySkills)
          .set({ enabled: true })
          .where(eq(skillRepositorySkills.skillRepositoryId, id))
          .execute(),
      ),
    ).toContain("skill_repository_skills_enabled_check");
    expect(
      await refused(
        db
          .insert(skillRepositories)
          .values({
            id: randomUUID(),
            workspaceId,
            repositoryId: 7,
            repository: "a/b",
            ref: "main",
            connectionId,
            installationId: 1,
            ownerId: 1,
            createdBy: owner.userId,
          })
          .execute(),
      ),
    ).toContain("skill_repositories_workspace_repository_uniq");
  });
});
