import { describe, expect, test } from "bun:test";
import {
  GitHubAppCheckError,
  type GitHubAppCredential,
} from "../github/ports/github-app-store.ts";
import { callerFor, createAuthorizationPolicy } from "../musterrolle/policy.ts";
import type {
  SkillListingEntry,
  SkillRepository,
  SkillRepositoryStore,
  SkillRepositoryTrigger,
} from "./ports/skill-repository-store.ts";
import type {
  GitHubRepositoryTree,
  GitHubSkillReader,
  GitHubSkillRepository,
  GitHubTreeEntry,
} from "./skill-git-sync.ts";
import { createSkillRepositoryService } from "./skill-repositories.ts";

// The store's transactions, locks and receipts are in packages/db's
// skill-repositories.test.ts; this file holds what the service
// decides around them, over a store that keeps the same rules in memory.

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const USER = "019a0000-0000-7000-8000-0000000000d1";
const CONNECTION = "019a0000-0000-7000-8000-0000000000b1";
const OTHER_CONNECTION = "019a0000-0000-7000-8000-0000000000b2";
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const URL = "https://github.com/anthropics/skills";

const caller = (
  role: "owner" | "admin" | "member" = "owner",
  surface: "web" | "api" = "web",
) =>
  callerFor(
    {
      kind: "user",
      id: USER,
      workspace_id: WORKSPACE,
      role,
      scopes: ["sessions:read", "sessions:write"],
    },
    { kind: surface },
    crypto.randomUUID(),
  );

const credential = (id: string, appId = 1234): GitHubAppCredential => ({
  id,
  workspaceId: WORKSPACE,
  appId,
  apiBase: "https://api.github.com",
  privateKey: "pem",
  updatedAt: new Date(0),
});

const skillFile = (name: string) =>
  `---\nname: ${name}\ndescription: What ${name} does.\n---\nBody.\n`;

function treeOf(
  files: Record<string, string>,
  mode: Record<string, string> = {},
) {
  const blobs = new Map<string, Uint8Array>();
  const entries: GitHubTreeEntry[] = [];
  const dirs = new Set<string>();
  for (const [path, text] of Object.entries(files)) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++)
      dirs.add(parts.slice(0, i).join("/"));
    const bytes = new TextEncoder().encode(text);
    const sha = `blob:${path}:${text.length}`;
    blobs.set(sha, bytes);
    entries.push({
      path,
      mode: mode[path] ?? "100644",
      type: "blob",
      sha,
      size: bytes.byteLength,
    });
  }
  for (const dir of dirs) {
    entries.push({
      path: dir,
      mode: "040000",
      type: "tree",
      sha: `tree:${dir}`,
      size: 0,
    });
  }
  const tree: GitHubRepositoryTree = {
    sha: "tree:",
    entries,
    truncated: false,
  };
  return { tree, blobs };
}

const REPOSITORY: GitHubSkillRepository = {
  id: 7,
  fullName: "anthropics/skills",
  ownerId: 70,
  public: true,
  defaultBranch: "main",
  license: "Apache-2.0",
};
const NOT_PUBLIC = { ...REPOSITORY, public: false };

type State = ReturnType<typeof fakeReader>["state"];

/** The tree of `commit` as GitHub answers one it cut short. */
function cutShort(state: State, commit: string): Partial<State> {
  const built = state.trees[commit];
  return built === undefined
    ? {}
    : {
        trees: {
          ...state.trees,
          [commit]: { ...built, tree: { ...built.tree, truncated: true } },
        },
      };
}

/** GitHub as a test sets it: commits by ref, a tree by commit. */
function fakeReader() {
  const state = {
    repository: REPOSITORY as GitHubSkillRepository | null,
    /** What lookups by id answer, in order; after them, and unset: `repository`. */
    byId: undefined as Array<GitHubSkillRepository | null> | undefined,
    refs: { main: COMMIT_A } as Record<string, string>,
    trees: {
      [COMMIT_A]: treeOf({ "skills/pdf/SKILL.md": skillFile("pdf") }),
    } as Record<string, ReturnType<typeof treeOf>>,
    fail: null as Error | null,
    /** Held before a tree is answered, so a test can change things meanwhile. */
    gate: null as Promise<void> | null,
    calls: [] as string[],
    asked: [] as number[],
  };
  const check = (what: string, installation: number) => {
    state.calls.push(what);
    state.asked.push(installation);
    if (state.fail) throw state.fail;
  };
  const reader: GitHubSkillReader = {
    async repository(_app, installation, owner, name) {
      check(`repository ${owner}/${name}`, installation);
      return state.repository;
    },
    async repositoryById(_app, installation) {
      check("repositoryById", installation);
      const next = state.byId?.shift();
      return next === undefined ? state.repository : next;
    },
    async resolve(_app, installation, _repository, ref) {
      check(`resolve ${ref}`, installation);
      return state.refs[ref] ?? null;
    },
    async tree(_app, installation, _repository, commit) {
      check(`tree ${commit[0]}`, installation);
      if (state.gate) await state.gate;
      return state.trees[commit]?.tree ?? null;
    },
    async blobs(_app, installation, _repository, shas) {
      check("blobs", installation);
      const all = new Map(
        Object.values(state.trees).flatMap((one) => [...one.blobs]),
      );
      return new Map(
        shas.flatMap((sha) => {
          const bytes = all.get(sha);
          return bytes === undefined ? [] : [[sha, bytes] as const];
        }),
      );
    },
    async read() {
      throw new Error("a repository listing reads no skill directory");
    },
    async isBranch() {
      throw new Error("a repository listing asks for no branch");
    },
  };
  return { reader, state };
}

type Row = SkillRepository & {
  holder: string | null;
  kept: SkillRepositoryTrigger | null;
  skills: Array<SkillListingEntry & { id: string; present: boolean }>;
};

function memoryStore() {
  const rows = new Map<string, Row>();
  const receipts: Array<{ operation: string; id: string }> = [];
  /** Names another skill of the workspace holds. */
  const owners = new Map<string, "upload" | "github">();
  const view = (row: Row): SkillRepository => {
    const { holder: _holder, kept: _kept, skills, ...repository } = row;
    return {
      ...repository,
      skillCount: skills.filter((skill) => skill.present).length,
    };
  };
  const write = (row: Row, entries: readonly SkillListingEntry[]) => {
    for (const skill of row.skills) skill.present = false;
    for (const entry of entries) {
      const at = row.skills.findIndex((skill) => skill.path === entry.path);
      const next = {
        ...entry,
        id: at === -1 ? crypto.randomUUID() : (row.skills[at]?.id ?? ""),
        present: true,
      };
      if (at === -1) row.skills.push(next);
      else row.skills[at] = next;
    }
  };
  const store: SkillRepositoryStore = {
    async list() {
      return [...rows.values()].map(view);
    },
    async find(_workspaceId, id) {
      const row = rows.get(id);
      return row ? view(row) : null;
    },
    async skills(_workspaceId, id) {
      const row = rows.get(id);
      const active = [...rows.values()].filter(
        (one) => one.removedAt === null || one.id === id,
      );
      return (row?.skills ?? [])
        .map((skill) => ({
          ...skill,
          enabled: false,
          nameOwner: (skill.name && owners.get(skill.name)) || null,
          nameShared: active.some((one) =>
            one.skills.some(
              (other) =>
                other.present &&
                other.name === skill.name &&
                other.id !== skill.id,
            ),
          ),
        }))
        .sort((a, b) => (a.path < b.path ? -1 : 1));
    },
    async register(input) {
      const existing = [...rows.values()].find(
        (row) => row.repositoryId === input.github.repositoryId,
      );
      if (existing && existing.removedAt === null) {
        return { outcome: "already_registered", repository: view(existing) };
      }
      const row: Row = {
        ...(existing ?? {
          workspaceId: input.workspaceId,
          id: input.id,
          access: "public",
          generation: 0,
          skillCount: 0,
          createdBy: USER,
          createdAt: input.at,
          skills: [],
        }),
        repositoryId: input.github.repositoryId,
        repository: input.github.repository,
        ownerId: input.github.ownerId,
        ref: input.ref,
        connectionId: input.connectionId,
        installationId: input.installationId,
        license: input.read.license,
        generation: (existing?.generation ?? 0) + 1,
        lastCommit: input.read.commit,
        lastSync: {
          at: input.at,
          trigger: { kind: "register", userId: USER },
          commit: input.read.commit,
          result: "listed",
          issues: [],
        },
        removedAt: null,
        removedBy: null,
        holder: null,
        kept: null,
      };
      write(row, input.read.entries);
      rows.set(row.id, row);
      receipts.push({
        operation: "register_skill_repository",
        id: input.receiptId,
      });
      return {
        outcome: existing ? "restored" : "registered",
        repository: view(row),
        receiptId: input.receiptId,
      };
    },
    async remove(input) {
      const row = rows.get(input.id);
      if (!row) return { outcome: "not_found" };
      if (row.removedAt !== null) {
        return { outcome: "unchanged", repository: view(row) };
      }
      row.removedAt = new Date();
      row.removedBy = USER;
      row.generation += 1;
      row.holder = null;
      row.kept = null;
      receipts.push({
        operation: "remove_skill_repository",
        id: input.receiptId,
      });
      return {
        outcome: "removed",
        repository: view(row),
        receiptId: input.receiptId,
      };
    },
    async setRef(input) {
      const row = rows.get(input.id);
      if (!row || row.removedAt !== null) return { outcome: "not_found" };
      if (row.ref === input.ref) {
        return { outcome: "unchanged", repository: view(row) };
      }
      row.ref = input.ref;
      row.generation += 1;
      receipts.push({
        operation: "update_skill_repository_ref",
        id: input.receiptId,
      });
      return {
        outcome: "updated",
        repository: view(row),
        receiptId: input.receiptId,
      };
    },
    async begin(_workspaceId, id, trigger) {
      const row = rows.get(id);
      if (!row || row.removedAt !== null) return { outcome: "not_found" };
      if (row.holder !== null) {
        row.kept = trigger;
        return { outcome: "queued" };
      }
      row.holder = crypto.randomUUID();
      return { outcome: "started", token: row.holder };
    },
    async finish(_workspaceId, id, _leaseMs, lease) {
      const row = rows.get(id);
      if (!row || row.holder !== lease) return null;
      const kept = row.kept;
      row.kept = null;
      if (kept === null) row.holder = null;
      return kept;
    },
    async record(input) {
      const row = rows.get(input.id);
      if (
        !row ||
        row.removedAt !== null ||
        row.holder !== input.token ||
        row.generation !== input.generation
      ) {
        return false;
      }
      row.lastSync = input.sync;
      if (input.read !== null) {
        row.lastCommit = input.read.commit;
        row.license = input.read.license;
        write(row, input.read.entries);
      }
      return true;
    },
  };
  return { store, rows, receipts, owners };
}

function setup(
  options: {
    apps?: GitHubAppCredential[];
    installations?: Record<
      number,
      Array<{ id: number; suspendedAt: Date | null }>
    >;
  } = {},
) {
  const { reader, state } = fakeReader();
  const memory = memoryStore();
  const listedFor: number[] = [];
  const service = createSkillRepositoryService({
    authorization: createAuthorizationPolicy({}),
    store: memory.store,
    reader,
    apps: async () => options.apps ?? [credential(CONNECTION)],
    installations: async (app) => {
      listedFor.push(app.appId);
      return (
        options.installations?.[app.appId] ?? [
          { id: 90, suspendedAt: new Date(0) },
          { id: 50, suspendedAt: null },
          { id: 40, suspendedAt: null },
        ]
      );
    },
    now: () => new Date("2026-11-28T00:00:00.000Z"),
  });
  return { service, state, listedFor, ...memory };
}

const refusal = async (run: Promise<unknown>) => {
  const error = (await run.catch((caught: unknown) => caught)) as {
    code?: string;
    details?: { reason_code?: string; issues?: unknown };
  };
  return [error.code, error.details?.reason_code];
};

describe("registering a skill repository", () => {
  test("reads the default branch through the App's oldest live installation and lists every skill off", async () => {
    const { service, state, rows, receipts } = setup();
    const registered = await service.register(caller(), { url: URL });
    expect(registered.outcome).toBe("registered");
    expect(registered.repository).toMatchObject({
      repository_id: 7,
      repository: "anthropics/skills",
      ref: "main",
      access: "public",
      connection_id: CONNECTION,
      installation_id: 40,
      owner_id: 70,
      license: "Apache-2.0",
      state: "active",
      last_commit: COMMIT_A,
      last_sync: {
        trigger: { kind: "register", user_id: USER },
        commit: COMMIT_A,
        result: "listed",
        issues: [],
      },
      skill_count: 1,
    });
    expect(registered.skills).toMatchObject([
      {
        path: "skills/pdf",
        name: "pdf",
        description: "What pdf does.",
        status: "off",
        enabled: false,
        present: true,
        issues: [],
      },
    ]);
    expect(new Set(state.asked)).toEqual(new Set([40]));
    // Asked whether it is public before its files are read, and again after.
    expect(state.calls).toEqual([
      "repository anthropics/skills",
      "repositoryById",
      "resolve main",
      "tree a",
      "blobs",
      "repositoryById",
    ]);
    expect(receipts).toEqual([
      { operation: "register_skill_repository", id: registered.receipt_id },
    ]);
    expect(rows.size).toBe(1);
  });

  test("a ref given is the one followed, and an address may end in .git", async () => {
    const { service, state } = setup();
    state.refs.v1 = COMMIT_A;
    const registered = await service.register(caller("admin"), {
      url: `${URL}.git`,
      ref: "v1",
    });
    expect(registered.repository.ref).toBe("v1");
    expect(state.calls).toContain("repository anthropics/skills");
    expect(state.calls).toContain("resolve v1");
  });

  test("the first author connection with a live installation reads", async () => {
    const { service, listedFor } = setup({
      apps: [credential(CONNECTION, 1), credential(OTHER_CONNECTION, 2)],
      installations: {
        1: [{ id: 5, suspendedAt: new Date(0) }],
        2: [{ id: 9, suspendedAt: null }],
      },
    });
    const registered = await service.register(caller(), { url: URL });
    expect(registered.repository).toMatchObject({
      connection_id: OTHER_CONNECTION,
      installation_id: 9,
    });
    expect(listedFor).toEqual([1, 2]);
  });

  test("only an owner or admin in a console session registers, and nothing is read for anyone else", async () => {
    const { service, state, rows } = setup();
    expect(
      await refusal(service.register(caller("owner", "api"), { url: URL })),
    ).toEqual(["FORBIDDEN", "web_session_required"]);
    expect(
      (await refusal(service.register(caller("member"), { url: URL })))[0],
    ).toBe("FORBIDDEN");
    expect(state.calls).toEqual([]);
    expect(rows.size).toBe(0);
  });

  test("is refused with the reason, and writes no row", async () => {
    const cases: Array<[string, string, (state: State) => Partial<State>]> = [
      ["BAD_REQUEST", "repository_not_found", () => ({ repository: null })],
      [
        "BAD_REQUEST",
        "repository_not_public",
        () => ({ repository: NOT_PUBLIC }),
      ],
      ["BAD_REQUEST", "ref_not_found", () => ({ refs: {} })],
      ["BAD_REQUEST", "ref_not_found", () => ({ trees: {} })],
      ["BAD_REQUEST", "listing_refused", (s) => cutShort(s, COMMIT_A)],
      // Public when found, not public once its files were read.
      [
        "BAD_REQUEST",
        "repository_not_public",
        () => ({ byId: [REPOSITORY, NOT_PUBLIC] }),
      ],
      [
        "BAD_REQUEST",
        "repository_not_public",
        () => ({ byId: [REPOSITORY, null] }),
      ],
      [
        "GITHUB_UNAVAILABLE",
        "github_unavailable",
        () => ({ fail: new GitHubAppCheckError("github_unreachable") }),
      ],
    ];
    for (const [code, reason, arrange] of cases) {
      const { service, state, rows, receipts } = setup();
      Object.assign(state, arrange(state));
      expect(await refusal(service.register(caller(), { url: URL }))).toEqual([
        code,
        reason,
      ]);
      expect(rows.size).toBe(0);
      expect(receipts).toEqual([]);
    }
  });

  test("a repository that is not public is refused before its tree is read", async () => {
    const { service, state } = setup();
    state.repository = NOT_PUBLIC;
    await refusal(service.register(caller(), { url: URL }));
    expect(state.calls).toEqual(["repository anthropics/skills"]);
  });

  test("with no installation to read with, GitHub's repositories are not asked", async () => {
    const { service, state } = setup({
      installations: { 1234: [{ id: 5, suspendedAt: new Date(0) }] },
    });
    expect(await refusal(service.register(caller(), { url: URL }))).toEqual([
      "BAD_REQUEST",
      "no_installation",
    ]);
    expect(state.calls).toEqual([]);
  });

  test("a listing past the limits carries its issues", async () => {
    const { service, state } = setup();
    Object.assign(state, cutShort(state, COMMIT_A));
    const error = (await service
      .register(caller(), { url: URL })
      .catch((caught: unknown) => caught)) as {
      details: { issues: Array<{ code: string }> };
    };
    expect(error.details.issues).toMatchObject([{ code: "tree_truncated" }]);
  });

  test("a repository already followed is 409 and keeps its row", async () => {
    const { service, rows } = setup();
    const first = await service.register(caller(), { url: URL });
    expect(await refusal(service.register(caller(), { url: URL }))).toEqual([
      "ALREADY_EXISTS",
      "repository_already_registered",
    ]);
    expect([...rows.keys()]).toEqual([first.repository.id]);
  });
});

describe("removing and bringing back", () => {
  test("a removed repository stays listed as removed, and registering it again restores the same row", async () => {
    const { service, state, receipts } = setup();
    const first = await service.register(caller(), { url: URL });
    const id = first.repository.id;
    const removed = await service.remove(caller(), id);
    expect(removed.repository).toMatchObject({
      id,
      state: "removed",
      removed_by: USER,
    });
    expect(removed.receipt_id).not.toBeNull();
    expect((await service.remove(caller(), id)).receipt_id).toBeNull();
    expect((await service.list(caller())).items).toMatchObject([
      { id, state: "removed" },
    ]);
    // Removed: neither checked nor pointed elsewhere.
    expect(await refusal(service.checkNow(caller(), id))).toEqual([
      "BAD_REQUEST",
      "repository_removed",
    ]);
    expect(await refusal(service.setRef(caller(), id, "v2"))).toEqual([
      "BAD_REQUEST",
      "repository_removed",
    ]);

    state.refs.v2 = COMMIT_B;
    state.trees[COMMIT_B] = treeOf({
      "skills/pdf/SKILL.md": skillFile("pdf"),
      "skills/docx/SKILL.md": skillFile("docx"),
    });
    const restored = await service.register(caller(), { url: URL, ref: "v2" });
    expect(restored.outcome).toBe("restored");
    expect(restored.repository).toMatchObject({
      id,
      state: "active",
      ref: "v2",
      last_commit: COMMIT_B,
      removed_at: null,
      skill_count: 2,
    });
    expect(restored.skills.map((skill) => [skill.path, skill.enabled])).toEqual(
      [
        ["skills/docx", false],
        ["skills/pdf", false],
      ],
    );
    expect(receipts.map((receipt) => receipt.operation)).toEqual([
      "register_skill_repository",
      "remove_skill_repository",
      "register_skill_repository",
    ]);
  });

  test("an unknown repository is 404 for every change and read", async () => {
    const { service } = setup();
    const id = crypto.randomUUID();
    for (const run of [
      service.get(caller(), id),
      service.remove(caller(), id),
      service.checkNow(caller(), id),
      service.setRef(caller(), id, "v2"),
    ]) {
      expect((await refusal(run))[0]).toBe("NOT_FOUND");
    }
  });

  test("a member reads neither the list nor a repository", async () => {
    const { service } = setup();
    const { repository } = await service.register(caller(), { url: URL });
    expect((await refusal(service.list(caller("member"))))[0]).toBe(
      "FORBIDDEN",
    );
    expect(
      (await refusal(service.get(caller("member"), repository.id)))[0],
    ).toBe("FORBIDDEN");
  });
});

describe("지금 확인", () => {
  test("lists the commit the ref names now: new directories appear, gone ones stay marked", async () => {
    const { service, state } = setup();
    const { repository } = await service.register(caller(), { url: URL });
    state.refs.main = COMMIT_B;
    state.trees[COMMIT_B] = treeOf({
      "skills/docx/SKILL.md": skillFile("docx"),
    });
    state.calls.length = 0;
    const checked = await service.checkNow(caller(), repository.id);
    expect(checked.outcome).toBe("checked");
    expect(checked.repository).toMatchObject({
      last_commit: COMMIT_B,
      skill_count: 1,
      last_sync: {
        trigger: { kind: "manual", user_id: USER },
        commit: COMMIT_B,
        result: "listed",
      },
    });
    expect(checked.skills.map((skill) => [skill.path, skill.present])).toEqual([
      ["skills/docx", true],
      ["skills/pdf", false],
    ]);
    // By the stored installation, never by name.
    expect(state.calls).toEqual([
      "repositoryById",
      "resolve main",
      "tree b",
      "blobs",
      "repositoryById",
    ]);
  });

  test("a repository that turned private is asked nothing more: no ref, tree or file", async () => {
    const { service, state } = setup();
    const { repository } = await service.register(caller(), { url: URL });
    state.byId = [NOT_PUBLIC];
    state.calls.length = 0;
    const checked = await service.checkNow(caller(), repository.id);
    expect(checked.repository.last_sync).toMatchObject({
      result: "source_missing",
      commit: null,
    });
    expect(state.calls).toEqual(["repositoryById"]);
  });

  test("a listing that fails records why and leaves the skills as they were", async () => {
    const cases: Array<[string, (state: State) => Partial<State>]> = [
      [
        "github_unavailable",
        () => ({ fail: new GitHubAppCheckError("github_unreachable") }),
      ],
      ["source_missing", () => ({ refs: {} })],
      ["source_missing", () => ({ byId: [NOT_PUBLIC] })],
      ["source_missing", () => ({ byId: [null] })],
      // Public when asked, not public once its files were read.
      ["source_missing", () => ({ byId: [REPOSITORY, NOT_PUBLIC] })],
      ["source_missing", () => ({ byId: [REPOSITORY, null] })],
      ["rejected", (s) => cutShort(s, COMMIT_B)],
    ];
    for (const [result, arrange] of cases) {
      const { service, state } = setup();
      const { repository } = await service.register(caller(), { url: URL });
      state.refs.main = COMMIT_B;
      state.trees[COMMIT_B] = treeOf({
        "skills/docx/SKILL.md": skillFile("docx"),
      });
      Object.assign(state, arrange(state));
      const checked = await service.checkNow(caller(), repository.id);
      expect(String(checked.repository.last_sync?.result)).toBe(result);
      expect(checked.repository.last_commit).toBe(COMMIT_A);
      expect(checked.skills.map((skill) => skill.path)).toEqual(["skills/pdf"]);
    }
  });

  test("a repository whose App connection is gone is github_unavailable", async () => {
    const apps = [credential(CONNECTION)];
    const { service, state } = setup({ apps });
    const { repository } = await service.register(caller(), { url: URL });
    apps.length = 0;
    state.calls.length = 0;
    const checked = await service.checkNow(caller(), repository.id);
    expect(checked.repository.last_sync?.result).toBe("github_unavailable");
    expect(state.calls).toEqual([]);
  });

  test("a second check while one runs is queued, and the holder runs once more", async () => {
    const { service, state } = setup();
    const { repository } = await service.register(caller(), { url: URL });
    let release = () => {};
    state.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.calls.length = 0;
    const first = service.checkNow(caller(), repository.id);
    while (!state.calls.includes("tree a")) await Bun.sleep(1);
    expect((await service.checkNow(caller(), repository.id)).outcome).toBe(
      "queued",
    );
    state.gate = null;
    release();
    expect((await first).outcome).toBe("checked");
    expect(state.calls.filter((call) => call === "tree a")).toHaveLength(2);
  });

  test("a removal while the listing reads GitHub leaves nothing written", async () => {
    const { service, state, rows } = setup();
    const { repository } = await service.register(caller(), { url: URL });
    state.refs.main = COMMIT_B;
    state.trees[COMMIT_B] = treeOf({
      "skills/docx/SKILL.md": skillFile("docx"),
    });
    let release = () => {};
    state.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = service.check(WORKSPACE, repository.id, {
      kind: "manual",
      userId: USER,
    });
    while (!state.calls.includes("tree b")) await Bun.sleep(1);
    await service.remove(caller(), repository.id);
    release();
    await running;
    const row = rows.get(repository.id);
    expect(row?.lastCommit).toBe(COMMIT_A);
    expect(row?.lastSync?.trigger.kind).toBe("register");
    expect(row?.skills.map((skill) => skill.path)).toEqual(["skills/pdf"]);
  });
});

describe("pointing a repository at another ref", () => {
  test("follows the new ref once GitHub resolves it, and lists there", async () => {
    const { service, state, receipts } = setup();
    const { repository } = await service.register(caller(), { url: URL });
    state.refs.v2 = COMMIT_B;
    state.trees[COMMIT_B] = treeOf({
      "skills/docx/SKILL.md": skillFile("docx"),
    });
    const changed = await service.setRef(caller(), repository.id, "v2");
    expect(changed.check).toBe("checked");
    expect(changed.receipt_id).not.toBeNull();
    expect(changed.repository).toMatchObject({
      ref: "v2",
      last_commit: COMMIT_B,
      last_sync: { trigger: { kind: "ref", user_id: USER }, result: "listed" },
    });
    expect(changed.skills.map((skill) => [skill.path, skill.present])).toEqual([
      ["skills/docx", true],
      ["skills/pdf", false],
    ]);
    expect(receipts.at(-1)?.operation).toBe("update_skill_repository_ref");
  });

  test("a ref GitHub does not resolve, or GitHub not answering, changes nothing", async () => {
    const { service, state, rows, receipts } = setup();
    const { repository } = await service.register(caller(), { url: URL });
    expect(
      await refusal(service.setRef(caller(), repository.id, "gone")),
    ).toEqual(["BAD_REQUEST", "ref_not_found"]);
    // No longer public: its refs are not asked for.
    state.refs.v2 = COMMIT_A;
    state.byId = [NOT_PUBLIC];
    state.calls.length = 0;
    expect(
      await refusal(service.setRef(caller(), repository.id, "v2")),
    ).toEqual(["BAD_REQUEST", "repository_not_public"]);
    expect(state.calls).toEqual(["repositoryById"]);
    state.fail = new GitHubAppCheckError("github_rejected");
    expect(
      await refusal(service.setRef(caller(), repository.id, "v2")),
    ).toEqual(["GITHUB_UNAVAILABLE", "github_app_auth_failed"]);
    expect(rows.get(repository.id)).toMatchObject({
      ref: "main",
      generation: 1,
    });
    expect(receipts).toHaveLength(1);
  });

  test("the ref it already follows reads nothing and writes no receipt", async () => {
    const { service, state, rows, receipts } = setup();
    const { repository } = await service.register(caller(), { url: URL });
    state.calls.length = 0;
    const same = await service.setRef(caller(), repository.id, "main");
    expect([same.receipt_id, same.check]).toEqual([null, null]);
    expect(state.calls).toEqual([]);
    expect(receipts).toHaveLength(1);
    expect(rows.get(repository.id)).toMatchObject({ generation: 1 });
  });

  test("a change while a listing runs is queued; the old ref's listing writes nothing and the holder lists the new ref", async () => {
    const { service, state, rows } = setup();
    const { repository } = await service.register(caller(), { url: URL });
    state.refs.v2 = COMMIT_B;
    state.trees[COMMIT_B] = treeOf({
      "skills/docx/SKILL.md": skillFile("docx"),
    });
    let release = () => {};
    state.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.calls.length = 0;
    const running = service.checkNow(caller(), repository.id);
    while (!state.calls.includes("tree a")) await Bun.sleep(1);
    const changed = await service.setRef(caller(), repository.id, "v2");
    expect(changed.check).toBe("queued");
    // Still what the registration listed.
    expect(changed.repository.last_sync?.trigger.kind).toBe("register");
    state.gate = null;
    release();
    await running;
    expect(rows.get(repository.id)).toMatchObject({
      ref: "v2",
      lastCommit: COMMIT_B,
      lastSync: { trigger: { kind: "ref" }, result: "listed" },
    });
    expect(state.calls.filter((call) => call.startsWith("tree"))).toEqual([
      "tree a",
      "tree b",
    ]);
  });
});

describe("what a listed skill shows", () => {
  test("a name another skill of the workspace holds is a conflict; a directory the listing refused is unavailable", async () => {
    const { service, state, owners } = setup();
    state.trees[COMMIT_A] = treeOf(
      {
        "skills/pdf/SKILL.md": skillFile("pdf"),
        "skills/taken/SKILL.md": skillFile("taken"),
        "skills/linked/SKILL.md": skillFile("linked"),
        "skills/linked/data.md": "../x",
        "copy/pdf/SKILL.md": skillFile("pdf"),
      },
      { "skills/linked/data.md": "120000" },
    );
    owners.set("taken", "upload");
    owners.set("linked", "github");
    const { skills } = await service.register(caller(), { url: URL });
    expect(
      skills.map((skill) => [
        skill.path,
        skill.status,
        skill.name_owner,
        skill.name_shared,
        skill.issues.map((issue) => issue.code),
      ]),
    ).toEqual([
      ["copy/pdf", "off", null, true, []],
      // Refused by the listing: that is said before who holds the name.
      [
        "skills/linked",
        "unavailable",
        "github",
        false,
        ["unsupported_entry_kind"],
      ],
      ["skills/pdf", "off", null, true, []],
      ["skills/taken", "conflict", "upload", false, []],
    ]);
  });
});
