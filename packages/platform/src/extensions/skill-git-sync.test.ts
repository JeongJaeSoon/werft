import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  GitHubAppCheckError,
  type GitHubAppCredential,
} from "../github/ports/github-app-store.ts";
import { callerFor, createAuthorizationPolicy } from "../musterrolle/policy.ts";
import type { BundleInputFile } from "./bundle-validator.ts";
import type {
  SkillGitSource,
  SkillGitSourceStore,
  SkillSyncCheck,
  SkillSyncTrigger,
} from "./ports/skill-git-source-store.ts";
import {
  createSkillGitSync,
  type GitHubSkillReader,
  type GitHubSkillTree,
  githubSignatureMatches,
} from "./skill-git-sync.ts";

// The store's locking, coalescing across replicas and version writes are in
// packages/db's skill-git-sources.integration.test.ts; this file holds what
// the sync decides around them.

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const OTHER = "019a0000-0000-7000-8000-0000000000a2";
const USER = "019a0000-0000-7000-8000-0000000000d1";
const CONNECTION = "019a0000-0000-7000-8000-0000000000b1";
const OTHER_CONNECTION = "019a0000-0000-7000-8000-0000000000b2";
const APP_ID = 1234;
const SECRET = "s".repeat(32);
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);

const caller = (role: "owner" | "member" = "owner", surface = "web" as const) =>
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

const sign = (body: string, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

const push = (ref = "refs/heads/main", repositoryId = 7) =>
  JSON.stringify({
    ref,
    after: "f".repeat(40),
    repository: { id: repositoryId, full_name: "acme/skills" },
    installation: { id: 42 },
  });

const credential = (id: string, workspaceId: string): GitHubAppCredential => ({
  id,
  workspaceId,
  appId: APP_ID,
  apiBase: "https://api.github.com",
  privateKey: "unused",
  updatedAt: new Date(0),
});

function memorySources(initial: SkillGitSource[]) {
  const rows = new Map(
    initial.map((source) => [`${source.workspaceId}/${source.name}`, source]),
  );
  const holding = new Map<string, SkillSyncTrigger | null>();
  const checks: Array<{ name: string; check: SkillSyncCheck }> = [];
  const store: SkillGitSourceStore = {
    async get(workspaceId, name) {
      return rows.get(`${workspaceId}/${name}`) ?? null;
    },
    async list(workspaceId) {
      return [...rows.values()].filter(
        (row) => row.workspaceId === workspaceId,
      );
    },
    async matching(input) {
      return [...rows.values()].filter(
        (row) =>
          row.syncEnabled &&
          input.connectionIds.includes(row.connectionId) &&
          row.installationId === input.installationId &&
          row.repositoryId === input.repositoryId &&
          (input.ref === row.ref ||
            (!row.ref.startsWith("refs/") &&
              (input.ref === `refs/heads/${row.ref}` ||
                input.ref === `refs/tags/${row.ref}`))),
      );
    },
    async due() {
      return [...rows.values()]
        .filter((row) => row.syncEnabled)
        .map(({ workspaceId, name }) => ({ workspaceId, name }));
    },
    async begin(workspaceId, name, trigger) {
      const key = `${workspaceId}/${name}`;
      if (!rows.has(key)) return { outcome: "not_found" };
      if (holding.has(key)) {
        holding.set(key, trigger);
        return { outcome: "queued" };
      }
      holding.set(key, null);
      return { outcome: "started", token: "t" };
    },
    async finish(workspaceId, name) {
      const key = `${workspaceId}/${name}`;
      const again = holding.get(key) ?? null;
      if (again === null) holding.delete(key);
      else holding.set(key, null);
      return again;
    },
    async recordCheck(workspaceId, name, check) {
      checks.push({ name, check });
      const key = `${workspaceId}/${name}`;
      const row = rows.get(key);
      if (row) rows.set(key, { ...row, lastCheck: check });
    },
    async setEnabled(input) {
      const key = `${input.workspaceId}/${input.name}`;
      const row = rows.get(key);
      if (!row) return { outcome: "not_found" };
      if (row.syncEnabled === input.enabled) {
        return { outcome: "unchanged", source: row };
      }
      const source = { ...row, syncEnabled: input.enabled };
      rows.set(key, source);
      return { outcome: "updated", source, receiptId: input.receiptId };
    },
  };
  return { store, checks, rows };
}

const source = (overrides: Partial<SkillGitSource> = {}): SkillGitSource => ({
  workspaceId: WORKSPACE,
  name: "research",
  connectionId: CONNECTION,
  installationId: 42,
  repositoryId: 7,
  repository: "acme/skills",
  path: "skills/research",
  ref: "main",
  syncEnabled: true,
  lastCheck: null,
  ...overrides,
});

const files = (body: string): BundleInputFile[] => [
  {
    path: "SKILL.md",
    kind: "file",
    mode: 0o644,
    bytes: new TextEncoder().encode(
      `---\nname: research\ndescription: d\n---\n${body}`,
    ),
  },
];

/** A reader whose answers a test sets, and whose calls it can hold. */
function fakeReader() {
  const state = {
    commit: COMMIT_A as string | null,
    tree: { kind: "files", files: files("one") } as GitHubSkillTree,
    fail: null as Error | null,
    failOnce: null as Error | null,
    gate: null as Promise<void> | null,
    resolved: [] as string[],
    read: [] as string[],
    repository: { id: 7, fullName: "acme/skills" } as {
      id: number;
      fullName: string;
    } | null,
  };
  const reader: GitHubSkillReader = {
    async repository() {
      if (state.fail) throw state.fail;
      return state.repository;
    },
    async resolve(_app, _installation, _repository, ref) {
      if (state.gate) await state.gate;
      if (state.fail) throw state.fail;
      const once = state.failOnce;
      state.failOnce = null;
      if (once) throw once;
      state.resolved.push(ref);
      return state.commit;
    },
    async read(_app, _installation, _repository, commit) {
      if (state.fail) throw state.fail;
      state.read.push(commit);
      return state.tree;
    },
  };
  return { reader, state };
}

function setup(
  options: {
    sources?: SkillGitSource[];
    secrets?: Array<{ workspaceId: string; connectionId: string }>;
    apps?: GitHubAppCredential[];
    webhookUrl?: string | null;
  } = {},
) {
  const sources = memorySources(options.sources ?? [source()]);
  const { reader, state } = fakeReader();
  const registered: Array<{
    slug: string;
    commit: string;
    trigger: SkillSyncTrigger;
    newSource: boolean;
  }> = [];
  const failed: unknown[] = [];
  const sync = createSkillGitSync({
    authorization: createAuthorizationPolicy({}),
    sources: sources.store,
    // Writes the version as the store would and records the check with it.
    bundles: {
      async register(input: {
        slug: string;
        git?: {
          location: { commit: string };
          trigger: SkillSyncTrigger;
          checkedAt: Date;
          newSource?: object;
          leaseToken?: string;
        };
        principal: { ownerId: string };
      }) {
        const git = input.git;
        if (!git) throw new Error("not a git registration");
        registered.push({
          slug: input.slug,
          commit: git.location.commit,
          trigger: git.trigger,
          newSource: git.newSource !== undefined,
        });
        await sources.store.recordCheck(
          input.principal.ownerId,
          input.slug,
          {
            at: git.checkedAt,
            trigger: git.trigger,
            commit: git.location.commit,
            result: "created",
            versionId: "v1",
            issues: [],
          },
          git.leaseToken ?? "",
        );
        return {
          outcome: "registered",
          bundle: {
            id: "019a0000-0000-7000-8000-0000000000e1",
            workspaceId: WORKSPACE,
            name: input.slug,
            digest: "d".repeat(64),
            label: input.slug,
            source: "github",
            git: {
              repositoryId: 7,
              path: "skills/research",
              ref: "main",
              commit: git.location.commit,
              trigger: git.trigger,
            },
            sizeBytes: 10,
            manifest: {
              schema: 1,
              slug: input.slug,
              skills: [{ name: input.slug, has_scripts: false }],
            },
            review: "pending",
            registeredBy: null,
            registeredAt: new Date(0),
            reviewedBy: null,
            reviewedAt: null,
            version: 1,
            archivedAt: null,
          },
          receiptId: "019a0000-0000-7000-8000-0000000000f9",
        };
      },
    } as never,
    reader,
    apps: async (workspaceId) =>
      (options.apps ?? [credential(CONNECTION, WORKSPACE)]).filter(
        (app) => app.workspaceId === workspaceId,
      ),
    installationFor: async () => ({ id: 42 }),
    webhookSecrets: async (appId) =>
      appId === APP_ID
        ? (
            options.secrets ?? [
              { workspaceId: WORKSPACE, connectionId: CONNECTION },
            ]
          ).map((one) => ({ ...one, secret: SECRET }))
        : [],
    webhookUrl:
      options.webhookUrl === undefined
        ? "https://werft.example.com/v1/github/webhook"
        : options.webhookUrl,
    failed: (error) => failed.push(error),
  });
  return { sync, sources, state, registered, failed };
}

const deliver = (
  sync: ReturnType<typeof setup>["sync"],
  body: string,
  headers: { appId?: string | null; event?: string; signature?: string } = {},
) =>
  sync.receive({
    appId: headers.appId === undefined ? String(APP_ID) : headers.appId,
    event: headers.event ?? "push",
    deliveryId: "d-1",
    signature: headers.signature ?? sign(body),
    body: new TextEncoder().encode(body),
  });

describe("the webhook signature", () => {
  test("is HMAC-SHA256 of the raw body under the secret", () => {
    const body = new TextEncoder().encode("{}");
    expect(githubSignatureMatches(SECRET, body, sign("{}"))).toBe(true);
    expect(
      githubSignatureMatches(SECRET, body, sign("{}", "x".repeat(32))),
    ).toBe(false);
    expect(githubSignatureMatches(SECRET, body, sign("{ }"))).toBe(false);
    for (const malformed of ["", "sha1=abc", `sha256=${"0".repeat(63)}`]) {
      expect(githubSignatureMatches(SECRET, body, malformed)).toBe(false);
    }
  });
});

describe("a push delivery", () => {
  test("no App id, no stored secret or a wrong signature is unauthorized and checks nothing", async () => {
    const { sync, state, registered } = setup();
    const body = push();
    expect(await deliver(sync, body, { appId: null })).toBe("unauthorized");
    expect(await deliver(sync, body, { appId: "999" })).toBe("unauthorized");
    expect(
      await deliver(sync, body, { signature: sign(body, "x".repeat(32)) }),
    ).toBe("unauthorized");
    await sync.idle();
    expect(state.resolved).toEqual([]);
    expect(registered).toEqual([]);
  });

  test("is answered before its check ends, and the check reads the commit the API resolves, not the body's", async () => {
    const { sync, state, registered } = setup();
    let release = () => {};
    state.gate = new Promise((resolve) => {
      release = resolve;
    });
    state.commit = COMMIT_B;
    expect(await deliver(sync, push())).toBe("accepted");
    expect(registered).toEqual([]);
    release();
    await sync.idle();
    expect(state.resolved).toEqual(["main"]);
    expect(registered).toEqual([
      {
        slug: "research",
        commit: COMMIT_B,
        trigger: { kind: "webhook", deliveryId: "d-1", userId: null },
        newSource: false,
      },
    ]);
  });

  test("another ref, repository, event, or a source paused or behind another workspace's secret, is not checked", async () => {
    const { sync, state } = setup({
      sources: [
        source(),
        source({ name: "paused", syncEnabled: false }),
        source({
          workspaceId: OTHER,
          name: "theirs",
          connectionId: OTHER_CONNECTION,
        }),
      ],
    });
    expect(await deliver(sync, push("refs/heads/dev"))).toBe("accepted");
    expect(await deliver(sync, push("refs/heads/main", 8))).toBe("accepted");
    expect(await deliver(sync, push(), { event: "ping" })).toBe("accepted");
    await sync.idle();
    expect(state.resolved).toEqual([]);
    expect(await deliver(sync, push())).toBe("accepted");
    await sync.idle();
    // "research" only: "paused" is off, "theirs" is behind OTHER's secret.
    expect(state.resolved).toEqual(["main"]);
  });

  test("a tag push reaches a source on that tag", async () => {
    const { sync, state } = setup({ sources: [source({ ref: "v1.2.0" })] });
    expect(await deliver(sync, push("refs/tags/v1.2.0"))).toBe("accepted");
    await sync.idle();
    expect(state.resolved).toEqual(["v1.2.0"]);
  });

  test("pushes during a check run it once more, for the last of them", async () => {
    const { sync, state, registered } = setup();
    let release = () => {};
    state.gate = new Promise((resolve) => {
      release = resolve;
    });
    await deliver(sync, push());
    await deliver(sync, push());
    await deliver(sync, push());
    state.commit = COMMIT_B;
    release();
    state.gate = null;
    await sync.idle();
    expect(state.resolved).toEqual(["main", "main"]);
    expect(registered.map((one) => one.commit)).toEqual([COMMIT_B, COMMIT_B]);
  });

  test("a run that throws still runs the push kept meanwhile, and the failure is reported", async () => {
    const { sync, state, registered, failed } = setup();
    let release = () => {};
    state.gate = new Promise((resolve) => {
      release = resolve;
    });
    await deliver(sync, push());
    await deliver(sync, push());
    state.failOnce = new Error("store down");
    release();
    state.gate = null;
    await sync.idle();
    expect(state.resolved).toEqual(["main"]);
    expect(registered.map((one) => one.trigger.kind)).toEqual(["webhook"]);
    expect(failed).toHaveLength(1);
  });
});

describe("a check's outcome without a version", () => {
  test("a ref or path gone is source_missing, a refused tree rejected, GitHub down github_unavailable", async () => {
    const { sync, sources, state, registered } = setup();
    const manual: SkillSyncTrigger = {
      kind: "manual",
      deliveryId: null,
      userId: USER,
    };
    const last = () => sources.rows.get(`${WORKSPACE}/research`)?.lastCheck;

    state.commit = null;
    await sync.check(WORKSPACE, "research", manual);
    expect(last()).toMatchObject({ result: "source_missing", commit: null });

    state.commit = COMMIT_A;
    state.tree = { kind: "missing" };
    await sync.check(WORKSPACE, "research", manual);
    expect(last()).toMatchObject({
      result: "source_missing",
      commit: COMMIT_A,
    });

    const issue = { path: "big.bin", code: "too_large", message: "big" };
    state.tree = { kind: "refused", issues: [issue] };
    await sync.check(WORKSPACE, "research", manual);
    expect(last()).toMatchObject({ result: "rejected", issues: [issue] });

    state.fail = new GitHubAppCheckError("github_unreachable");
    await sync.check(WORKSPACE, "research", manual);
    expect(last()).toMatchObject({ result: "github_unavailable" });
    expect(registered).toEqual([]);
  });

  test("an App connection that is gone is github_unavailable", async () => {
    const { sync, sources } = setup({ apps: [] });
    await sync.check(WORKSPACE, "research", {
      kind: "daily",
      deliveryId: null,
      userId: null,
    });
    expect(sources.rows.get(`${WORKSPACE}/research`)?.lastCheck?.result).toBe(
      "github_unavailable",
    );
  });
});

describe("the daily check", () => {
  test("checks each due source once and counts them", async () => {
    const { sync, state, registered } = setup({
      sources: [source(), source({ name: "paused", syncEnabled: false })],
    });
    expect(await sync.daily()).toBe(1);
    expect(state.resolved).toEqual(["main"]);
    expect(registered[0]?.trigger.kind).toBe("daily");
  });
});

describe("the console", () => {
  test("check now runs while paused and waits for the check; an unknown skill is not found", async () => {
    const { sync, registered } = setup({
      sources: [source({ syncEnabled: false })],
    });
    const checked = await sync.checkNow(caller(), "research");
    expect(checked.outcome).toBe("checked");
    expect(checked.last_check?.result).toBe("created");
    expect(registered[0]?.trigger).toEqual({
      kind: "manual",
      deliveryId: null,
      userId: USER,
    });
    await expect(sync.checkNow(caller(), "nope")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  test("a member or an API key is refused", async () => {
    const { sync } = setup();
    await expect(
      sync.checkNow(caller("member"), "research"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      sync.checkNow(caller("owner", "api" as never), "research"),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { reason_code: "web_session_required" },
    });
  });

  test("pausing writes no check; resuming checks once right away", async () => {
    const { sync, registered } = setup();
    const paused = await sync.setSync(caller(), "research", false);
    expect(paused.git.sync_enabled).toBe(false);
    expect(paused.receipt_id).not.toBeNull();
    expect(registered).toEqual([]);
    const again = await sync.setSync(caller(), "research", false);
    expect(again.receipt_id).toBeNull();
    const resumed = await sync.setSync(caller(), "research", true);
    expect(resumed.git.sync_enabled).toBe(true);
    expect(resumed.git.last_check?.trigger.kind).toBe("resume");
    expect(registered.map((one) => one.trigger.kind)).toEqual(["resume"]);
  });

  test("a resume or push kept while sync was paused again checks nothing", async () => {
    const { sync, state, registered } = setup({
      sources: [source({ syncEnabled: false })],
    });
    for (const kind of ["resume", "webhook", "daily", "register"] as const) {
      expect(
        await sync.check(WORKSPACE, "research", {
          kind,
          deliveryId: null,
          userId: null,
        }),
      ).toBe("checked");
    }
    expect(state.resolved).toEqual([]);
    expect(registered).toEqual([]);
  });

  test("the list says whether this installation can take the push webhook", async () => {
    const ready = setup();
    expect((await ready.sync.views(WORKSPACE)).get("research")?.webhook).toBe(
      "ready",
    );
    const noSecret = setup({ secrets: [] });
    expect(
      (await noSecret.sync.views(WORKSPACE)).get("research")?.webhook,
    ).toBe("no_secret");
    const noUrl = setup({ webhookUrl: null });
    expect((await noUrl.sync.views(WORKSPACE)).get("research")?.webhook).toBe(
      "no_public_url",
    );
  });
});

describe("registering from GitHub", () => {
  const request = {
    name: "research",
    repository: "acme/skills",
    path: "skills/research",
    ref: "main",
  };

  test("reads the directory at the resolved commit and makes the source with the first version", async () => {
    const { sync, state, registered } = setup({ sources: [] });
    const result = await sync.register(caller(), request);
    expect(result.outcome).toBe("registered");
    expect(state.read).toEqual([COMMIT_A]);
    expect(registered).toEqual([
      {
        slug: "research",
        commit: COMMIT_A,
        trigger: { kind: "register", deliveryId: null, userId: USER },
        newSource: true,
      },
    ]);
  });

  test("each thing it cannot read is its own refusal", async () => {
    const cases: Array<
      [string, (state: ReturnType<typeof setup>["state"]) => void]
    > = [
      [
        "repository_not_installed",
        (state) => {
          state.repository = null;
        },
      ],
      [
        "ref_not_found",
        (state) => {
          state.commit = null;
        },
      ],
      [
        "path_not_found",
        (state) => {
          state.tree = { kind: "missing" };
        },
      ],
      [
        "skill_invalid",
        (state) => {
          state.tree = {
            kind: "refused",
            issues: [{ path: "x", code: "too_large", message: "big" }],
          };
        },
      ],
    ];
    for (const [reason, arrange] of cases) {
      const { sync, state, registered } = setup({ sources: [] });
      arrange(state);
      await expect(sync.register(caller(), request)).rejects.toMatchObject({
        code: "BAD_REQUEST",
        details: { reason_code: reason },
      });
      expect(registered).toEqual([]);
    }
    const down = setup({ sources: [] });
    down.state.fail = new GitHubAppCheckError("github_unreachable");
    await expect(down.sync.register(caller(), request)).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
    });
  });

  test("with several author Apps the connection is named; an unknown one is refused", async () => {
    const { sync } = setup({
      sources: [],
      apps: [
        credential(CONNECTION, WORKSPACE),
        credential(OTHER_CONNECTION, WORKSPACE),
      ],
    });
    await expect(sync.register(caller(), request)).rejects.toMatchObject({
      details: { reason_code: "connection_required" },
    });
    await expect(
      sync.register(caller(), {
        ...request,
        connection_id: "019a0000-0000-7000-8000-0000000000b9",
      }),
    ).rejects.toMatchObject({
      details: { reason_code: "connection_not_found" },
    });
    expect(
      (
        await sync.register(caller(), {
          ...request,
          connection_id: OTHER_CONNECTION,
        })
      ).outcome,
    ).toBe("registered");
  });
});
