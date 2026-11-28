import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { scopesForRole, type WorkspaceRole } from "@werft-ai/contracts";
import {
  type BundleInputFile,
  callerFor,
  createExtensionBundleService,
  EXTENSION_MANAGER_ROLES,
  type ExtensionBundle,
  plainTextHostExtractor,
} from "@werft-ai/platform";
import { createMemoryCheckpointObjectStore } from "@werft-ai/testkit/checkpoint-objects";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { and, eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { createPostgresSessionUnitOfWork } from "../postgres-unit-of-work.ts";
import * as schema from "../schema.ts";
import {
  agents,
  extensionAttachments,
  extensionBundles,
  memberships,
  skillGitSources,
  skillRepositories,
  skillRepositorySkills,
  users,
  workspaces,
} from "../schema.ts";
import { testWorkerGateway, workerOf } from "../testing/gateway.ts";
import { launchSession } from "../testing/launches.ts";
import {
  fixtureRelease,
  TEST_MODEL,
  testSessionCatalog,
} from "../testing/spec-pins.ts";
import { createPostgresExtensionBundleStore } from "./extension-bundles.ts";

// What a skill of a registered repository is to a new session: its switch
// and its repository, read where attachments are read. Nothing switches one
// on yet, so the rows are written here the way switching on writes them: a
// source row naming the repository and the directory, sync off.

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
const files = (name: string): BundleInputFile[] => [
  {
    path: `skills/${name}/SKILL.md`,
    kind: "file",
    mode: 0o644,
    bytes: text(
      `---\nname: ${name}\ndescription: Use for ${name}\n---\nDo it.\n`,
    ),
  },
];

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
  const userId = randomUUID();
  const role: WorkspaceRole = "owner";
  await db.insert(users).values({
    id: userId,
    email: `owner-${userId}@example.invalid`,
    displayName: role,
  });
  await db.insert(memberships).values({ workspaceId, userId, role });
  const owner = callerFor(
    {
      kind: "user",
      id: userId,
      workspace_id: workspaceId,
      role,
      scopes: [...scopesForRole(role)],
    },
    { kind: "web" },
    randomUUID(),
  );
  const store = createPostgresExtensionBundleStore(db);
  const objects = createMemoryCheckpointObjectStore();
  const service = createExtensionBundleService({
    store,
    objects,
    hosts: plainTextHostExtractor,
  });
  const repositoryId = randomUUID();
  await db.insert(skillRepositories).values({
    id: repositoryId,
    workspaceId,
    repositoryId: 7,
    repository: "anthropics/skills",
    ref: "main",
    connectionId,
    installationId: 40,
    ownerId: 70,
    createdBy: userId,
  });

  /** An approved, current version of `name`. */
  async function version(name: string): Promise<ExtensionBundle> {
    const result = await service.register({
      principal: owner,
      slug: name,
      files: files(name),
      label: name,
      source: "upload",
      skill: true,
    });
    if (result.outcome !== "registered") throw new Error(result.outcome);
    const [row] = await db
      .update(extensionBundles)
      .set({
        review: "approved",
        reviewedBy: result.bundle.registeredBy,
        reviewedAt: new Date(),
        current: true,
      })
      .where(eq(extensionBundles.id, result.bundle.id))
      .returning();
    if (!row) throw new Error("no bundle row");
    return { ...result.bundle, review: "approved", current: true };
  }

  /** `name` as a skill of the repository, under `skills/<name>`. */
  async function fromRepository(
    name: string,
    enabled: boolean,
    path = `skills/${name}`,
  ) {
    await db.insert(skillRepositorySkills).values({
      id: randomUUID(),
      skillRepositoryId: repositoryId,
      path: `skills/${name}`,
      name,
      treeSha: "c".repeat(40),
      fileCount: 1,
      totalBytes: 10,
      hasScripts: false,
      enabled,
      ...(enabled
        ? {
            enabledBy: userId,
            enabledAt: new Date(),
            enableGrantId: randomUUID(),
          }
        : {}),
    });
    await db.insert(skillGitSources).values({
      workspaceId,
      name,
      connectionId,
      installationId: 40,
      access: "public",
      repositoryId: 7,
      repository: "anthropics/skills",
      path,
      ref: "main",
      syncEnabled: false,
      repositorySourceId: repositoryId,
      createdBy: userId,
    });
  }

  const setEnabled = (name: string, enabled: boolean) =>
    db
      .update(skillRepositorySkills)
      .set(
        enabled
          ? { enabled, enableGrantId: randomUUID() }
          : { enabled, enableGrantId: null },
      )
      .where(
        and(
          eq(skillRepositorySkills.skillRepositoryId, repositoryId),
          eq(skillRepositorySkills.name, name),
        ),
      );
  const removeRepository = () =>
    db
      .update(skillRepositories)
      .set({ removedAt: new Date(), removedBy: userId })
      .where(eq(skillRepositories.id, repositoryId));

  const agentReleaseId = await fixtureRelease(db, workspaceId);
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.workspaceId, workspaceId));
  if (!agent) throw new Error("no fixture agent");

  const attach = (
    bundle: ExtensionBundle,
    over: {
      scope?: "agent" | "workspace";
      mode?: "required" | "optional" | "forbidden";
      kind?: "attach" | "detach";
      follow?: boolean;
    } = {},
  ) =>
    store.recordAttachment({
      receiptId: randomUUID(),
      workspaceId,
      bundleId: bundle.id,
      scope: over.scope ?? "agent",
      ...(over.scope === "workspace" ? {} : { agentId: agent.id }),
      mode: over.mode ?? "optional",
      kind: over.kind ?? "attach",
      ...(over.follow ? { follow: true } : {}),
      principal: owner,
      managerRoles: EXTENSION_MANAGER_ROLES,
    });

  return {
    workspaceId,
    agentId: agent.id,
    agentReleaseId,
    owner,
    store,
    service,
    version,
    fromRepository,
    setEnabled,
    removeRepository,
    attach,
  };
}

describe("what an attachment of a repository skill offers a new session", () => {
  test("ok while switched on, hidden while off, withdrawn once the repository is removed; an upload is ok", async () => {
    const ws = await workspace();
    const pdf = await ws.version("pdf");
    const notes = await ws.version("notes");
    await ws.fromRepository("pdf", true);
    expect((await ws.attach(pdf)).outcome).toBe("recorded");
    expect((await ws.attach(notes, { mode: "required" })).outcome).toBe(
      "recorded",
    );
    const availability = async () =>
      Object.fromEntries(
        (
          await ws.store.listAttachments({
            workspaceId: ws.workspaceId,
            agentId: ws.agentId,
          })
        ).map((row) => [row.name, row.availability]),
      );
    expect(await availability()).toEqual({ notes: "ok", pdf: "ok" });
    // An upload is no repository's skill.
    expect(await ws.store.repositorySkills(ws.workspaceId)).toEqual(
      new Map([["pdf", "ok"]]),
    );

    await ws.setEnabled("pdf", false);
    expect(await availability()).toEqual({ notes: "ok", pdf: "hidden" });
    expect(await ws.store.repositorySkills(ws.workspaceId)).toEqual(
      new Map([["pdf", "hidden"]]),
    );

    // Removal withdraws whatever the switch says.
    await ws.setEnabled("pdf", true);
    await ws.removeRepository();
    expect(await availability()).toEqual({ notes: "ok", pdf: "withdrawn" });
    expect(await ws.store.repositorySkills(ws.workspaceId)).toEqual(
      new Map([["pdf", "withdrawn"]]),
    );
  });

  test("a source whose directory the listing does not hold is hidden", async () => {
    const ws = await workspace();
    await ws.version("pdf");
    await ws.fromRepository("pdf", true, "skills/elsewhere");
    expect(await ws.store.repositorySkills(ws.workspaceId)).toEqual(
      new Map([["pdf", "hidden"]]),
    );
  });
});

describe("attaching a repository skill", () => {
  test("off or withdrawn, a new attachment is refused; forbidding it and taking one back are not", async () => {
    const ws = await workspace();
    const pdf = await ws.version("pdf");
    await ws.fromRepository("pdf", true);
    expect((await ws.attach(pdf)).outcome).toBe("recorded");

    await ws.setEnabled("pdf", false);
    for (const over of [
      { mode: "optional" as const },
      { mode: "required" as const },
      { mode: "optional" as const, follow: true },
    ]) {
      expect(await ws.attach(pdf, over)).toEqual({
        outcome: "unavailable",
        availability: "hidden",
      });
    }
    const modes = () =>
      db
        .select({ mode: extensionAttachments.mode })
        .from(extensionAttachments)
        .where(eq(extensionAttachments.workspaceId, ws.workspaceId));
    expect(await modes()).toEqual([{ mode: "optional" }]);
    expect((await ws.attach(pdf, { mode: "forbidden" })).outcome).toBe(
      "recorded",
    );
    expect(
      (await ws.attach(pdf, { mode: "forbidden", kind: "detach" })).outcome,
    ).toBe("recorded");

    await ws.removeRepository();
    expect(await ws.attach(pdf)).toEqual({
      outcome: "unavailable",
      availability: "withdrawn",
    });
    expect(await modes()).toEqual([]);
    expect((await ws.attach(pdf, { mode: "forbidden" })).outcome).toBe(
      "recorded",
    );
    expect(await modes()).toEqual([{ mode: "forbidden" }]);
  });

  test("the workspace scope is refused in every mode, switched on or not; an upload is attached there", async () => {
    const ws = await workspace();
    const pdf = await ws.version("pdf");
    const notes = await ws.version("notes");
    await ws.fromRepository("pdf", true);
    for (const mode of ["required", "optional", "forbidden"] as const) {
      expect(await ws.attach(pdf, { scope: "workspace", mode })).toEqual({
        outcome: "repository_skill_workspace",
      });
    }
    await ws.setEnabled("pdf", false);
    expect(
      await ws.attach(pdf, { scope: "workspace", mode: "forbidden" }),
    ).toEqual({ outcome: "repository_skill_workspace" });
    expect(
      (await ws.attach(notes, { scope: "workspace", mode: "required" }))
        .outcome,
    ).toBe("recorded");
  });
});

describe("a session that pinned a repository skill", () => {
  test("keeps it once the skill is switched off and its repository removed: a new claim names it and the worker is served it", async () => {
    const ws = await workspace();
    const pdf = await ws.version("pdf");
    await ws.fromRepository("pdf", true);
    const pinned = [
      {
        bundle_id: pdf.id,
        name: "pdf",
        digest: pdf.digest,
        scope: "agent" as const,
      },
    ];
    const accepted = await createPostgresSessionUnitOfWork(
      db,
    ).acceptInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: ws.owner,
      idempotencyKey: randomUUID(),
      payloadHash: randomUUID(),
      agentReleaseId: ws.agentReleaseId,
      model: TEST_MODEL,
      repository: {
        id: "sample-app",
        url: "https://example.invalid/app.git",
        branch: "main",
      },
      message: "first input",
      extensions: pinned,
    });
    if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
    await ws.setEnabled("pdf", false);
    await ws.removeRepository();

    // Resuming a paused session launches it again and the new worker claims
    // it as here; the pause and resume themselves are walked on a stack.
    const gateway = testWorkerGateway(
      db,
      testSessionCatalog({
        repositories: {
          "sample-app": {
            url: "https://example.invalid/app.git",
            branch: "main",
            auth: { kind: "github_app", registered: true },
          },
        },
      }),
      { extensions: ws.service },
    );
    const { executionId, generation, nonce } = await launchSession(db, {
      sessionId: accepted.response.session_id,
    });
    const claimed = await gateway.bootstrapClaim(
      { kind: "bootstrap" },
      {
        execution_id: executionId,
        execution_generation: generation,
        credential: { kind: "launch_nonce", nonce },
      },
    );
    expect(
      claimed.runtime_config.extensions?.map((bundle) => bundle.digest),
    ).toEqual([pdf.digest]);
    const { principal } = workerOf(claimed, executionId);
    const served = await gateway.extensionBundle(principal, {
      attemptId: principal.kind === "session" ? principal.attemptId : "",
      digest: pdf.digest,
    });
    expect(served.digest).toBe(pdf.digest);
    expect(served.tar.byteLength).toBeGreaterThan(0);
  });
});
