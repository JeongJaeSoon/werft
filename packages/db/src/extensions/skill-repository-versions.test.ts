import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { scopesForRole, type WorkspaceRole } from "@werft-ai/contracts";
import {
  type BundleInputFile,
  callerFor,
  createExtensionBundleService,
  EXTENSION_MANAGER_ROLES,
  type ExtensionBundleStore,
  gateSkillVersion,
  plainTextHostExtractor,
  type RepositorySkillGate,
  type SecretFinding,
  type SkillListingEntry,
  type SkillRepositorySkillCheck,
  type SkillRepositoryTrigger,
} from "@werft-ai/platform";
import { createMemoryCheckpointObjectStore } from "@werft-ai/testkit/checkpoint-objects";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { asc, eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { receiptFromRow } from "../postgres-unit-of-work.ts";
import * as schema from "../schema.ts";
import {
  agents,
  extensionBundles,
  memberships,
  receipts,
  skillGitSources,
  skillRepositories,
  skillRepositorySkills,
  users,
  workspaces,
} from "../schema.ts";
import { fixtureRelease } from "../testing/spec-pins.ts";
import { createPostgresExtensionBundleStore } from "./extension-bundles.ts";
import { createPostgresSkillGitSourceStore } from "./skill-git-sources.ts";
import { createPostgresSkillRepositoryStore } from "./skill-repositories.ts";

// A registered repository's skill, from its switch to its versions: what the
// switch writes, and what a check's write reads again under its locks before
// a version becomes the current one. One connection; what two replicas do to
// each other is in apps/control-host's skill-repositories.integration.test.ts.

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const TREE = "c".repeat(40);
const AT = new Date("2026-11-28T00:00:00.000Z");

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema });
});

afterEach(async () => {
  await client.close();
});

const text = (value: string) => new TextEncoder().encode(value);
const files = (name: string, body: string): BundleInputFile[] => [
  {
    path: `skills/${name}/SKILL.md`,
    kind: "file",
    mode: 0o644,
    bytes: text(
      `---\nname: ${name}\ndescription: Use for ${name}\n---\n${body}\n`,
    ),
  },
];

const entry = (
  path: string,
  over: Partial<SkillListingEntry> = {},
): SkillListingEntry => ({
  path,
  name: path.split("/").at(-1) ?? null,
  description: `What ${path} does.`,
  license: "MIT",
  treeSha: TREE,
  fileCount: 1,
  totalBytes: 60,
  hasScripts: false,
  issues: [],
  ...over,
});

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

/** A workspace that registered GitHub repository 7, every skill off. */
async function registered(
  entries: SkillListingEntry[] = [entry("skills/pdf")],
) {
  const workspaceId = randomUUID();
  const slug = `ws-${workspaceId.slice(0, 8)}`;
  await db.insert(workspaces).values({ id: workspaceId, slug, name: slug });
  const connectionId = randomUUID();
  await client.query(
    `INSERT INTO github_apps (id, workspace_id, role, app_id, slug, name, html_url, api_base)
     VALUES ($1, $2, 'author', 54, 's', 'n', 'https://github.com/apps/s', 'https://api.github.com')`,
    [connectionId, workspaceId],
  );
  const owner = await person(workspaceId, "owner");
  const repositories = createPostgresSkillRepositoryStore(db);
  const managed = () => ({
    workspaceId,
    receiptId: randomUUID(),
    principal: owner.caller,
    managerRoles: EXTENSION_MANAGER_ROLES,
  });
  const first = await repositories.register({
    ...managed(),
    id: randomUUID(),
    url: "https://github.com/anthropics/skills",
    github: { repositoryId: 7, repository: "anthropics/skills", ownerId: 70 },
    ref: "main",
    connectionId,
    installationId: 40,
    read: { commit: COMMIT_A, license: "Apache-2.0", entries },
    at: AT,
  });
  if (first.outcome !== "registered") throw new Error(first.outcome);
  const id = first.repository.id;
  const skills = () => repositories.skills(workspaceId, id);
  const skill = async (path = "skills/pdf") => {
    const found = (await skills()).find((one) => one.path === path);
    if (!found) throw new Error(`no directory ${path}`);
    return found;
  };
  const turn = async (enabled: boolean, path = "skills/pdf") =>
    repositories.setSwitch({
      ...managed(),
      id,
      skillId: (await skill(path)).id,
      enabled,
    });
  const receiptsOf = async () =>
    (
      await db
        .select()
        .from(receipts)
        .where(eq(receipts.ownerId, workspaceId))
        .orderBy(receipts.createdAt)
    ).map(receiptFromRow);
  return {
    workspaceId,
    connectionId,
    owner,
    repositories,
    managed,
    id,
    skills,
    skill,
    turn,
    receiptsOf,
  };
}

/** The same, with skills/pdf switched on and the repository held for a check of it. */
async function switchedOn() {
  const ws = await registered();
  const on = await ws.turn(true);
  if (on.outcome !== "updated") throw new Error(on.outcome);
  const trigger: SkillRepositoryTrigger = {
    kind: "enable",
    userId: ws.owner.userId,
  };
  const begun = await ws.repositories.begin(
    ws.workspaceId,
    ws.id,
    trigger,
    60_000,
  );
  if (begun.outcome !== "started") throw new Error(begun.outcome);
  const store = createPostgresExtensionBundleStore(db);
  const state = {
    gateRuns: 0,
    secrets: [] as SecretFinding[],
    /** Runs once, after the gate judged and before the version's write. */
    meanwhile: null as (() => Promise<unknown>) | null,
  };
  const raced: ExtensionBundleStore = {
    ...store,
    async register(input) {
      const meanwhile = state.meanwhile;
      state.meanwhile = null;
      await meanwhile?.();
      return store.register(input);
    },
  };
  const gate: RepositorySkillGate = {
    runner: {
      async run(input) {
        state.gateRuns += 1;
        return { kind: "judged", result: gateSkillVersion(input) };
      },
    },
    secrets: {
      async scan() {
        return { kind: "scanned", findings: state.secrets };
      },
    },
    allowedHosts: () => new Set(),
  };
  const objects = createMemoryCheckpointObjectStore();
  const service = createExtensionBundleService({
    store: raced,
    objects,
    hosts: plainTextHostExtractor,
    gate,
  });
  const skillId = (await ws.skill()).id;
  /** One check's write of skills/pdf as `body`, as the repository service asks for it. */
  const check = (
    body: string,
    over: {
      commit?: string;
      generation?: number;
      leaseToken?: string;
      grantId?: string;
      path?: string;
    } = {},
  ) =>
    service.register({
      principal: { ownerId: ws.workspaceId },
      slug: "pdf",
      files: files("pdf", body),
      label: "pdf",
      source: "github",
      skill: true,
      git: {
        location: {
          repositoryId: 7,
          path: over.path ?? "skills/pdf",
          ref: "main",
          commit: over.commit ?? COMMIT_A,
        },
        trigger: { kind: "register", deliveryId: null, userId: trigger.userId },
        checkedAt: AT,
        repository: {
          skillRepositoryId: ws.id,
          skillId,
          generation: over.generation ?? 1,
          leaseToken: over.leaseToken ?? begun.token,
          grantId: over.grantId ?? on.receiptId,
          trigger,
          treeSha: TREE,
          rootFiles: ["LICENSE"],
        },
      },
    });
  const versions = () =>
    db
      .select({
        id: extensionBundles.id,
        version: extensionBundles.version,
        review: extensionBundles.review,
        current: extensionBundles.current,
        registeredBy: extensionBundles.registeredBy,
        reviewedBy: extensionBundles.reviewedBy,
      })
      .from(extensionBundles)
      .where(eq(extensionBundles.workspaceId, ws.workspaceId))
      .orderBy(asc(extensionBundles.version));
  const lastCheck = async () => (await ws.skill()).lastCheck;
  return {
    ...ws,
    store,
    service,
    objects,
    state,
    trigger,
    token: begun.token,
    grantId: on.receiptId,
    skillId,
    check,
    versions,
    lastCheck,
  };
}

/** Version 1 approved and current; version 2 waiting, as a host from before repositories leaves one. */
async function withOldPending() {
  const ws = await switchedOn();
  const one = await ws.check("First.");
  const two = await ws.check("Second.", { commit: COMMIT_B });
  if (one.outcome !== "registered" || two.outcome !== "registered") {
    throw new Error(`${one.outcome} ${two.outcome}`);
  }
  await db
    .update(extensionBundles)
    .set({ review: "pending", reviewedAt: null, current: false })
    .where(eq(extensionBundles.id, two.bundle.id));
  await db
    .update(extensionBundles)
    .set({ current: true })
    .where(eq(extensionBundles.id, one.bundle.id));
  return { ...ws, one: one.bundle, two: two.bundle };
}

describe("the switch", () => {
  test("on takes a grant and a receipt naming what was approved; off clears the grant; the same again changes nothing", async () => {
    const ws = await registered();
    const before = await ws.skill();
    const on = await ws.turn(true);
    if (on.outcome !== "updated") throw new Error(on.outcome);
    expect(await ws.skill()).toMatchObject({
      enabled: true,
      grantId: on.receiptId,
      lastCheck: null,
      currentVersionId: null,
    });
    expect(await ws.turn(true)).toEqual({ outcome: "unchanged" });
    const off = await ws.turn(false);
    if (off.outcome !== "updated") throw new Error(off.outcome);
    expect(await ws.skill()).toMatchObject({ enabled: false, grantId: null });
    expect(await ws.turn(false)).toEqual({ outcome: "unchanged" });
    // A switch turned on again is a new grant: a check that read the first
    // one writes nothing under it.
    const again = await ws.turn(true);
    if (again.outcome !== "updated") throw new Error(again.outcome);
    expect(again.receiptId).not.toBe(on.receiptId);
    expect((await ws.receiptsOf()).slice(1)).toMatchObject([
      {
        id: on.receiptId,
        operation: "set_skill_repository_switch",
        status: "succeeded",
        result: {
          action: "on",
          skill_repository_id: ws.id,
          repository_id: 7,
          repository: "anthropics/skills",
          generation: 1,
          skill_id: before.id,
          path: "skills/pdf",
          name: "pdf",
          ref: "main",
          commit: COMMIT_A,
          tree_sha: TREE,
          license: { repository: "Apache-2.0", skill: "MIT" },
        },
      },
      {
        id: off.receiptId,
        operation: "set_skill_repository_switch",
        result: { action: "off", skill_id: before.id, name: "pdf" },
      },
      { id: again.receiptId, result: { action: "on" } },
    ]);
  });

  test("is refused for a directory the listing refuses or no longer finds, a removed repository, and a member", async () => {
    const ws = await registered([
      entry("skills/pdf"),
      entry("skills/broken", {
        name: null,
        issues: [{ path: "SKILL.md", code: "bad_frontmatter", message: "no" }],
      }),
      entry("skills/big", {
        issues: [{ path: "", code: "too_large", message: "no" }],
      }),
    ]);
    expect(await ws.turn(true, "skills/broken")).toEqual({
      outcome: "unavailable",
    });
    expect(await ws.turn(true, "skills/big")).toEqual({
      outcome: "unavailable",
    });
    const pdf = await ws.skill();
    expect(
      await ws.repositories.setSwitch({
        ...ws.managed(),
        id: ws.id,
        skillId: randomUUID(),
        enabled: true,
      }),
    ).toEqual({ outcome: "not_found" });
    const member = await person(ws.workspaceId, "member");
    expect(
      await ws.repositories.setSwitch({
        ...ws.managed(),
        principal: member.caller,
        id: ws.id,
        skillId: pdf.id,
        enabled: true,
      }),
    ).toEqual({ outcome: "outranked" });
    await db
      .update(skillRepositorySkills)
      .set({ present: false })
      .where(eq(skillRepositorySkills.id, pdf.id));
    expect(await ws.turn(true)).toEqual({ outcome: "missing" });
    await ws.repositories.remove({ ...ws.managed(), id: ws.id });
    expect(await ws.turn(true)).toEqual({ outcome: "removed" });
    expect((await ws.skills()).map((skill) => skill.enabled)).toEqual([
      false,
      false,
      false,
    ]);
    // Only the registration and the removal were written.
    expect((await ws.receiptsOf()).map((one) => one.operation)).toEqual([
      "register_skill_repository",
      "remove_skill_repository",
    ]);
  });

  test("on is refused for a name another skill of the workspace holds", async () => {
    const ws = await registered();
    const uploads = createExtensionBundleService({
      store: createPostgresExtensionBundleStore(db),
      objects: createMemoryCheckpointObjectStore(),
      hosts: plainTextHostExtractor,
    });
    const upload = await uploads.register({
      principal: ws.owner.caller,
      slug: "pdf",
      files: files("pdf", "Mine."),
      label: "pdf",
      source: "upload",
      skill: true,
    });
    expect(upload.outcome).toBe("registered");
    expect(await ws.turn(true)).toEqual({
      outcome: "name_conflict",
      owner: "upload",
    });
    expect((await ws.skill()).enabled).toBe(false);
  });
});

describe("the first version of a skill switched on", () => {
  test("is written approved and current under who switched it on, with a source row no host syncs", async () => {
    const ws = await switchedOn();
    const result = await ws.check("First.");
    if (result.outcome !== "registered") throw new Error(result.outcome);
    expect(result.bundle).toMatchObject({
      name: "pdf",
      version: 1,
      review: "approved",
      current: true,
      registeredBy: ws.owner.userId,
      reviewedBy: null,
    });
    expect(
      await db
        .select()
        .from(skillGitSources)
        .where(eq(skillGitSources.workspaceId, ws.workspaceId)),
    ).toMatchObject([
      {
        name: "pdf",
        connectionId: ws.connectionId,
        installationId: 40,
        access: "public",
        repositoryId: 7,
        repository: "anthropics/skills",
        path: "skills/pdf",
        ref: "main",
        syncEnabled: false,
        autoApprove: "off",
        repositorySourceId: ws.id,
        createdBy: ws.owner.userId,
      },
    ]);
    expect(await ws.skill()).toMatchObject({
      enabled: true,
      skillName: "pdf",
      currentVersionId: result.bundle.id,
      nameOwner: "github",
      lastCheck: {
        at: AT,
        trigger: ws.trigger,
        commit: COMMIT_A,
        result: "passed",
        versionId: result.bundle.id,
        blocks: [],
      },
    });
    const [row] = await db
      .select({ passed: skillRepositorySkills.passedTreeSha })
      .from(skillRepositorySkills)
      .where(eq(skillRepositorySkills.id, ws.skillId));
    expect(row?.passed).toBe(TREE);
    // Both receipts say no person approved it, and what did.
    expect((await ws.receiptsOf()).slice(2)).toMatchObject([
      {
        operation: "register_extension",
        result: {
          name: "pdf",
          version: 1,
          by: "sync",
          basis: "repository",
          skill_repository_id: ws.id,
        },
      },
      {
        operation: "approve_extension",
        result: {
          from: null,
          review: "approved",
          by: "sync",
          basis: "repository",
          skill_repository_id: ws.id,
          repository_id: 7,
          commit: COMMIT_A,
          license: { repository: "Apache-2.0", skill: "MIT" },
          current: { from: null, to: 1 },
        },
      },
    ]);
  });

  test("is offered to a new session while the switch is on, hidden while off, withdrawn once the repository is removed", async () => {
    const ws = await switchedOn();
    const result = await ws.check("First.");
    if (result.outcome !== "registered") throw new Error(result.outcome);
    await fixtureRelease(db, ws.workspaceId);
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.workspaceId, ws.workspaceId));
    if (!agent) throw new Error("no fixture agent");
    const attached = await ws.store.recordAttachment({
      receiptId: randomUUID(),
      workspaceId: ws.workspaceId,
      bundleId: result.bundle.id,
      scope: "agent",
      agentId: agent.id,
      mode: "optional",
      kind: "attach",
      principal: ws.owner.caller,
      managerRoles: EXTENSION_MANAGER_ROLES,
    });
    expect(attached.outcome).toBe("recorded");
    const availability = async () =>
      (
        await ws.store.listAttachments({
          workspaceId: ws.workspaceId,
          agentId: agent.id,
        })
      ).map((row) => [row.name, row.availability]);
    expect(await availability()).toEqual([["pdf", "ok"]]);
    expect(await ws.store.repositorySkills(ws.workspaceId)).toEqual(
      new Map([["pdf", "ok"]]),
    );
    await ws.turn(false);
    expect(await availability()).toEqual([["pdf", "hidden"]]);
    await ws.turn(true);
    expect(await availability()).toEqual([["pdf", "ok"]]);
    await ws.repositories.remove({ ...ws.managed(), id: ws.id });
    expect(await availability()).toEqual([["pdf", "withdrawn"]]);
  });
});

describe("content a version already holds", () => {
  test("the current version checked again writes no version and no receipt, and is not judged again", async () => {
    const ws = await switchedOn();
    const first = await ws.check("First.");
    if (first.outcome !== "registered") throw new Error(first.outcome);
    const written = (await ws.receiptsOf()).length;
    const again = await ws.check("First.", { commit: COMMIT_B });
    expect(again).toMatchObject({
      outcome: "already_registered",
      bundle: { id: first.bundle.id, current: true },
    });
    expect(ws.state.gateRuns).toBe(1);
    expect(await ws.versions()).toHaveLength(1);
    expect((await ws.receiptsOf()).length).toBe(written);
    expect(await ws.lastCheck()).toMatchObject({
      result: "passed",
      commit: COMMIT_B,
      versionId: first.bundle.id,
    });
  });

  test("an update becomes the current version with no person behind it; upstream going back makes the earlier one current again", async () => {
    const ws = await switchedOn();
    const one = await ws.check("First.");
    const two = await ws.check("Second.", { commit: COMMIT_B });
    if (one.outcome !== "registered" || two.outcome !== "registered") {
      throw new Error(`${one.outcome} ${two.outcome}`);
    }
    expect(await ws.versions()).toMatchObject([
      { version: 1, review: "approved", current: false },
      {
        version: 2,
        review: "approved",
        current: true,
        registeredBy: null,
        reviewedBy: null,
      },
    ]);
    const back = await ws.check("First.");
    expect(back).toMatchObject({
      outcome: "already_registered",
      bundle: { id: one.bundle.id, current: true },
    });
    // Approved in its day: not judged a second time.
    expect(ws.state.gateRuns).toBe(2);
    expect(await ws.versions()).toMatchObject([
      { version: 1, current: true },
      { version: 2, review: "approved", current: false },
    ]);
    expect((await ws.receiptsOf()).at(-1)).toMatchObject({
      operation: "approve_extension",
      result: {
        from: "approved",
        basis: "repository",
        current: { from: 2, to: 1 },
      },
    });
    expect((await ws.skill()).currentVersionId).toBe(one.bundle.id);
  });

  test("a version a manager rejected stays out, whatever upstream holds", async () => {
    const ws = await switchedOn();
    const one = await ws.check("First.");
    if (one.outcome !== "registered") throw new Error(one.outcome);
    const rejected = await ws.store.review({
      receiptId: randomUUID(),
      workspaceId: ws.workspaceId,
      bundleId: one.bundle.id,
      review: "rejected",
      principal: ws.owner.caller,
      managerRoles: EXTENSION_MANAGER_ROLES,
    });
    expect(rejected.outcome).toBe("reviewed");
    const again = await ws.check("First.");
    expect(again).toMatchObject({
      outcome: "withheld",
      bundle: { id: one.bundle.id, review: "rejected", current: false },
    });
    expect(ws.state.gateRuns).toBe(1);
    expect(await ws.lastCheck()).toMatchObject({
      result: "withheld",
      versionId: one.bundle.id,
    });
    expect((await ws.skill()).currentVersionId).toBeNull();
  });
});

describe("a version left waiting by a host from before repositories", () => {
  test("is approved and made current only by this gate's pass", async () => {
    const ws = await withOldPending();
    // The gate refuses it: it stays as it is.
    ws.state.secrets = [{ rule: "generic-api-key", path: "x", line: 1 }];
    expect(await ws.check("Second.", { commit: COMMIT_B })).toMatchObject({
      outcome: "blocked",
      blocks: [{ rule: "secret", samples: ["generic-api-key"] }],
    });
    expect(await ws.versions()).toMatchObject([
      { version: 1, current: true },
      { version: 2, review: "pending", current: false },
    ]);
    // No person may approve it in the gate's place.
    expect(
      await ws.store.review({
        receiptId: randomUUID(),
        workspaceId: ws.workspaceId,
        bundleId: ws.two.id,
        review: "approved",
        principal: ws.owner.caller,
        managerRoles: EXTENSION_MANAGER_ROLES,
      }),
    ).toEqual({ outcome: "repository_skill" });
    ws.state.secrets = [];
    expect(await ws.check("Second.", { commit: COMMIT_B })).toMatchObject({
      outcome: "already_registered",
      bundle: { id: ws.two.id, review: "approved", current: true },
    });
    expect((await ws.receiptsOf()).at(-1)).toMatchObject({
      operation: "approve_extension",
      result: { from: "pending", basis: "repository", by: "sync" },
    });
  });

  test("stays waiting when the version it was judged against is no longer the last approved one", async () => {
    const ws = await withOldPending();
    ws.state.meanwhile = () =>
      ws.store.review({
        receiptId: randomUUID(),
        workspaceId: ws.workspaceId,
        bundleId: ws.one.id,
        review: "rejected",
        principal: ws.owner.caller,
        managerRoles: EXTENSION_MANAGER_ROLES,
      });
    expect(await ws.check("Second.", { commit: COMMIT_B })).toEqual({
      outcome: "baseline_changed",
    });
    expect(await ws.versions()).toMatchObject([
      { version: 1, review: "rejected" },
      { version: 2, review: "pending", current: false },
    ]);
    expect(await ws.lastCheck()).toMatchObject({
      result: "baseline_changed",
      versionId: null,
    });
  });
});

describe("what changed between the gate's answer and the write", () => {
  test("the last approved version: nothing is written, and the next check judges again", async () => {
    const ws = await switchedOn();
    const one = await ws.check("First.");
    if (one.outcome !== "registered") throw new Error(one.outcome);
    ws.state.meanwhile = () =>
      ws.store.review({
        receiptId: randomUUID(),
        workspaceId: ws.workspaceId,
        bundleId: one.bundle.id,
        review: "rejected",
        principal: ws.owner.caller,
        managerRoles: EXTENSION_MANAGER_ROLES,
      });
    expect(await ws.check("Second.", { commit: COMMIT_B })).toEqual({
      outcome: "baseline_changed",
    });
    expect(await ws.versions()).toHaveLength(1);
    expect(await ws.lastCheck()).toMatchObject({ result: "baseline_changed" });
    // Judged against no approved version now, it passes on its own.
    expect(await ws.check("Second.", { commit: COMMIT_B })).toMatchObject({
      outcome: "registered",
      bundle: { version: 2, current: true },
    });
  });

  test("another check took the repository over: nothing is written", async () => {
    const ws = await switchedOn();
    ws.state.meanwhile = () =>
      db
        .update(skillRepositories)
        .set({ checkingToken: randomUUID() })
        .where(eq(skillRepositories.id, ws.id));
    expect(await ws.check("First.")).toEqual({ outcome: "lease_lost" });
    expect(await ws.versions()).toEqual([]);
    expect(await ws.lastCheck()).toBeNull();
    expect(
      await db
        .select()
        .from(skillGitSources)
        .where(eq(skillGitSources.workspaceId, ws.workspaceId)),
    ).toEqual([]);
  });

  test.each([
    [
      "the switch turned off",
      async (ws: Awaited<ReturnType<typeof switchedOn>>) => ws.turn(false),
    ],
    [
      "the switch turned off and on again",
      async (ws: Awaited<ReturnType<typeof switchedOn>>) => {
        await ws.turn(false);
        await ws.turn(true);
      },
    ],
    [
      "the repository removed",
      async (ws: Awaited<ReturnType<typeof switchedOn>>) =>
        ws.repositories.remove({ ...ws.managed(), id: ws.id }),
    ],
    [
      // A removal raises the generation too; the mark alone stops the write.
      "the repository marked removed",
      async (ws: Awaited<ReturnType<typeof switchedOn>>) =>
        db
          .update(skillRepositories)
          .set({ removedAt: new Date(), removedBy: ws.owner.userId })
          .where(eq(skillRepositories.id, ws.id)),
    ],
    [
      "the ref changed",
      async (ws: Awaited<ReturnType<typeof switchedOn>>) =>
        ws.repositories.setRef({
          ...ws.managed(),
          id: ws.id,
          ref: "v2",
          generation: 1,
        }),
    ],
  ])("%s: nothing is written", async (_what, change) => {
    const ws = await switchedOn();
    ws.state.meanwhile = () => change(ws);
    expect(await ws.check("First.")).toEqual({ outcome: "stale" });
    expect(await ws.versions()).toEqual([]);
    expect(
      await db
        .select()
        .from(skillGitSources)
        .where(eq(skillGitSources.workspaceId, ws.workspaceId)),
    ).toEqual([]);
  });

  test("a check of another directory's path writes nothing", async () => {
    const ws = await switchedOn();
    expect(await ws.check("First.", { path: "skills/other" })).toEqual({
      outcome: "stale",
    });
    expect(await ws.versions()).toEqual([]);
  });

  test("the name taken by an upload: the switch goes off with a receipt, and stays refused", async () => {
    const ws = await switchedOn();
    ws.state.meanwhile = async () => {
      const upload = await createExtensionBundleService({
        store: ws.store,
        objects: ws.objects,
        hosts: plainTextHostExtractor,
      }).register({
        principal: ws.owner.caller,
        slug: "pdf",
        files: files("pdf", "Mine."),
        label: "pdf",
        source: "upload",
        skill: true,
      });
      if (upload.outcome !== "registered") throw new Error(upload.outcome);
    };
    expect(await ws.check("First.")).toEqual({ outcome: "name_conflict" });
    expect(await ws.skill()).toMatchObject({
      enabled: false,
      grantId: null,
      skillName: null,
      nameOwner: "upload",
      lastCheck: { result: "name_conflict", versionId: null },
    });
    expect(await ws.versions()).toMatchObject([
      { version: 1, review: "pending" },
    ]);
    expect((await ws.receiptsOf()).at(-1)).toMatchObject({
      operation: "set_skill_repository_switch",
      result: {
        action: "off",
        by: "sync",
        reason: "name_conflict",
        skill_id: ws.skillId,
        name: "pdf",
      },
    });
    expect(await ws.turn(true)).toEqual({
      outcome: "name_conflict",
      owner: "upload",
    });
  });
});

describe("the per-skill controls of a host that knows no repositories", () => {
  test("write nothing to a repository's skill: no version, no sync, no auto-approve, no step back", async () => {
    const ws = await switchedOn();
    const one = await ws.check("First.");
    if (one.outcome !== "registered") throw new Error(one.outcome);
    const sources = createPostgresSkillGitSourceStore(db);
    const legacy = createExtensionBundleService({
      store: ws.store,
      objects: ws.objects,
      hosts: plainTextHostExtractor,
    });
    const location = {
      repositoryId: 7,
      path: "skills/pdf",
      ref: "main",
      commit: COMMIT_B,
    };
    const manual = {
      kind: "manual" as const,
      deliveryId: null,
      userId: ws.owner.userId,
    };
    // The per-skill sync, an upload and a second registration.
    expect(
      await legacy.register({
        principal: { ownerId: ws.workspaceId },
        slug: "pdf",
        files: files("pdf", "Second."),
        label: "pdf",
        source: "github",
        skill: true,
        git: { location, trigger: manual, checkedAt: AT, leaseToken: "t" },
      }),
    ).toEqual({ outcome: "source_mismatch" });
    expect(
      await legacy.register({
        principal: ws.owner.caller,
        slug: "pdf",
        files: files("pdf", "Second."),
        label: "pdf",
        source: "upload",
        skill: true,
      }),
    ).toEqual({ outcome: "source_mismatch" });
    expect(
      await legacy.register({
        principal: ws.owner.caller,
        slug: "pdf",
        files: files("pdf", "Second."),
        label: "pdf",
        source: "github",
        skill: true,
        git: {
          location,
          trigger: manual,
          checkedAt: AT,
          newSource: {
            connectionId: ws.connectionId,
            installationId: 40,
            access: "public",
            repositoryId: 7,
            repository: "anthropics/skills",
          },
        },
      }),
    ).toEqual({ outcome: "source_mismatch" });
    expect(await ws.versions()).toHaveLength(1);

    const managed = {
      workspaceId: ws.workspaceId,
      name: "pdf",
      receiptId: randomUUID(),
      principal: ws.owner.caller,
      managerRoles: EXTENSION_MANAGER_ROLES,
    };
    expect(await sources.setEnabled({ ...managed, enabled: true })).toEqual({
      outcome: "repository_skill",
    });
    expect(await sources.setAutoApprove({ ...managed, action: "on" })).toEqual({
      outcome: "repository_skill",
    });
    expect(await sources.begin(ws.workspaceId, "pdf", manual, 1_000)).toEqual({
      outcome: "repository_skill",
    });
    // Neither the daily pass nor a push finds it.
    expect(
      await sources.due(new Date(AT.getTime() + 864e5 * 365), 10, 1_000),
    ).toEqual([]);
    expect(
      await sources.matching({
        connectionIds: [ws.connectionId],
        installationId: 40,
        repositoryId: 7,
        ref: "main",
      }),
    ).toEqual([]);
    expect(
      await ws.store.revert({
        receiptId: randomUUID(),
        workspaceId: ws.workspaceId,
        name: "pdf",
        principal: ws.owner.caller,
        managerRoles: EXTENSION_MANAGER_ROLES,
      }),
    ).toEqual({ outcome: "repository_skill" });
  });

  test("the sync column of a repository's skill cannot be turned on, by any host", async () => {
    const ws = await switchedOn();
    expect((await ws.check("First.")).outcome).toBe("registered");
    await expect(
      client.query(
        "UPDATE skill_git_sources SET sync_enabled = true WHERE workspace_id = $1",
        [ws.workspaceId],
      ),
    ).rejects.toThrow(/skill_git_sources_repository_sync_check/);
  });
});

describe("a check that wrote no version", () => {
  const blocked = (
    over: Partial<SkillRepositorySkillCheck> = {},
  ): SkillRepositorySkillCheck => ({
    at: AT,
    trigger: { kind: "daily", userId: null },
    commit: COMMIT_B,
    result: "blocked",
    versionId: null,
    issues: [],
    blocks: [{ rule: "secret", paths: ["skills/pdf/a.md"], samples: ["aws"] }],
    warnings: [],
    notices: [],
    ...over,
  });

  test("is kept on the skill, and on its source row in the words an older host reads", async () => {
    const ws = await switchedOn();
    const one = await ws.check("First.");
    if (one.outcome !== "registered") throw new Error(one.outcome);
    const record = (over: Record<string, unknown> = {}) =>
      ws.repositories.recordSkillCheck({
        workspaceId: ws.workspaceId,
        id: ws.id,
        skillId: ws.skillId,
        token: ws.token,
        generation: 1,
        grantId: ws.grantId,
        check: blocked(),
        sourceCheck: {
          trigger: { kind: "daily", deliveryId: null, userId: null },
          result: "rejected",
          issues: [{ path: "a.md", code: "secret", message: "no" }],
        },
        ...over,
      });
    expect(await record()).toBe(true);
    expect(await ws.lastCheck()).toEqual(blocked());
    // The version it has stays the current one.
    expect((await ws.skill()).currentVersionId).toBe(one.bundle.id);
    const sources = createPostgresSkillGitSourceStore(db);
    expect((await sources.get(ws.workspaceId, "pdf"))?.lastCheck).toMatchObject(
      {
        result: "rejected",
        commit: COMMIT_B,
        versionId: null,
        issues: [{ path: "a.md", code: "secret", message: "no" }],
      },
    );

    // Not this check's to write: another lease, generation or grant.
    const later = blocked({ result: "gate_unavailable", blocks: [] });
    expect(await record({ check: later, token: randomUUID() })).toBe(false);
    expect(await record({ check: later, generation: 2 })).toBe(false);
    expect(await record({ check: later, grantId: randomUUID() })).toBe(false);
    expect(await record({ check: later, skillId: randomUUID() })).toBe(false);
    await ws.turn(false);
    expect(await record({ check: later })).toBe(false);
    expect(await ws.lastCheck()).toEqual(blocked());
  });

  test("a result a later host wrote reads as the gate not answering", async () => {
    const ws = await switchedOn();
    await db
      .update(skillRepositorySkills)
      .set({
        lastGate: {
          at: AT.toISOString(),
          trigger: { kind: "webhook", user_id: null },
          commit: COMMIT_A,
          result: "passed_with_review",
        },
      })
      .where(eq(skillRepositorySkills.id, ws.skillId));
    expect(await ws.lastCheck()).toEqual({
      at: AT,
      trigger: { kind: "manual", userId: null },
      commit: COMMIT_A,
      result: "gate_unavailable",
      versionId: null,
      issues: [],
      blocks: [],
      warnings: [],
      notices: [],
    });
  });
});

describe("holding a repository across its skills", () => {
  test("the holder extends its lease; another does not", async () => {
    const ws = await switchedOn();
    const until = async () =>
      (
        await db
          .select({ until: skillRepositories.checkingUntil })
          .from(skillRepositories)
          .where(eq(skillRepositories.id, ws.id))
      )[0]?.until?.getTime() ?? 0;
    const before = await until();
    expect(
      await ws.repositories.extend(ws.workspaceId, ws.id, 600_000, ws.token),
    ).toBe(true);
    expect(await until()).toBeGreaterThan(before + 500_000);
    const held = await until();
    expect(
      await ws.repositories.extend(
        ws.workspaceId,
        ws.id,
        6_000_000,
        randomUUID(),
      ),
    ).toBe(false);
    expect(await until()).toBe(held);
  });

  test("a person's kept trigger is not replaced by the daily pass's; the daily pass's is replaced by a person's", async () => {
    const ws = await switchedOn();
    const daily: SkillRepositoryTrigger = { kind: "daily", userId: null };
    const manual: SkillRepositoryTrigger = {
      kind: "manual",
      userId: ws.owner.userId,
    };
    const keep = (trigger: SkillRepositoryTrigger) =>
      ws.repositories.begin(ws.workspaceId, ws.id, trigger, 60_000);
    expect(await keep(manual)).toEqual({ outcome: "queued" });
    expect(await keep(daily)).toEqual({ outcome: "queued" });
    expect(
      await ws.repositories.finish(ws.workspaceId, ws.id, 60_000, ws.token),
    ).toEqual(manual);
    expect(await keep(daily)).toEqual({ outcome: "queued" });
    expect(await keep(manual)).toEqual({ outcome: "queued" });
    expect(
      await ws.repositories.finish(ws.workspaceId, ws.id, 60_000, ws.token),
    ).toEqual(manual);
  });
});

describe("the daily pass", () => {
  test("claims active repositories that follow a branch or tag and were last checked before the day began", async () => {
    const branch = await registered();
    const pinned = await registered();
    const removed = await registered();
    const fresh = await registered();
    await db
      .update(skillRepositories)
      .set({ ref: COMMIT_A })
      .where(eq(skillRepositories.id, pinned.id));
    await removed.repositories.remove({ ...removed.managed(), id: removed.id });
    const day = 864e5;
    await db
      .update(skillRepositories)
      .set({ lastCheckedAt: new Date(AT.getTime() + 2 * day) })
      .where(eq(skillRepositories.id, fresh.id));
    const before = new Date(AT.getTime() + day);
    const due = () => branch.repositories.due(before, 10, 60_000);
    expect(await due()).toEqual([
      { workspaceId: branch.workspaceId, id: branch.id },
    ]);
    // Claimed: another replica's pass leaves it until the claim runs out.
    expect(await due()).toEqual([]);
    expect(
      await branch.repositories.due(new Date(before.getTime() + 60_001), 10, 1),
    ).toEqual([{ workspaceId: branch.workspaceId, id: branch.id }]);
  });
});

describe("a listing that reads another name for a directory switched on", () => {
  const listing = (ws: Awaited<ReturnType<typeof switchedOn>>, name: string) =>
    ws.repositories.record({
      workspaceId: ws.workspaceId,
      id: ws.id,
      token: ws.token,
      generation: 1,
      sync: {
        at: AT,
        trigger: { kind: "daily", userId: null },
        commit: COMMIT_B,
        result: "listed",
        issues: [],
      },
      read: {
        commit: COMMIT_B,
        license: "Apache-2.0",
        entries: [entry("skills/pdf", { name })],
      },
    });

  test("switches it off while it has no version, with a receipt; one with a version keeps its switch and its name", async () => {
    const fresh = await switchedOn();
    expect(await listing(fresh, "reader")).toBe(true);
    expect(await fresh.skill()).toMatchObject({
      name: "reader",
      enabled: false,
      grantId: null,
      lastCheck: {
        result: "rejected",
        issues: [{ path: "SKILL.md", code: "name_changed" }],
      },
    });
    expect((await fresh.receiptsOf()).at(-1)).toMatchObject({
      operation: "set_skill_repository_switch",
      result: {
        action: "off",
        by: "sync",
        reason: "name_changed",
        name: "pdf",
        renamed_to: "reader",
      },
    });

    const versioned = await switchedOn();
    expect((await versioned.check("First.")).outcome).toBe("registered");
    expect(await listing(versioned, "reader")).toBe(true);
    expect(await versioned.skill()).toMatchObject({
      name: "reader",
      skillName: "pdf",
      enabled: true,
      lastCheck: { result: "passed" },
    });
  });
});
