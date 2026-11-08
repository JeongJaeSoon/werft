import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PULL_REQUEST_SETTINGS,
  GITHUB_CEILING_NONE,
  type GitHubAppCheckFailure,
  type GitHubAppRole,
  type GitHubCeiling,
  type PullRequestSettings,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import {
  GitHubAppCheckError,
  type GitHubAppDirectory,
  type GitHubAppInstallationView,
  type GitHubAppStore,
  type GitHubInstallationLink,
  type GitHubInstallationSnapshot,
  type GitHubInstallationStore,
} from "../ports/github-app-store.ts";
import type {
  GitHubOAuthStore,
  GitHubSettingsStore,
  GitHubWorkspaceSettings,
} from "../ports/github-settings.ts";
import type {
  PullRequestSettingsRead,
  PullRequestSettingsStore,
} from "../ports/pull-request-settings.ts";
import { fakeGitHubClientSecret } from "../testing/github-fakes.ts";
import { refusal } from "../testing/refusal.ts";
import { createGitHubSettingsService } from "./github-settings-service.ts";
import { type Caller, callerFor, createAuthorizationPolicy } from "./policy.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const OTHER = "019a0000-0000-7000-8000-0000000000f2";
const AUTHOR_CONNECTION = "019a0000-0000-7000-8000-0000000000a1";

function user(
  role: WorkspaceRole,
  options: { surface?: "web" | "api"; workspace?: string } = {},
): Caller {
  return callerFor(
    {
      kind: "user",
      id: crypto.randomUUID(),
      workspace_id: options.workspace ?? WORKSPACE,
      role,
      scopes: [...scopesForRole(role)],
    },
    { kind: options.surface ?? "web" },
    crypto.randomUUID(),
  );
}

function apiKey(): Caller {
  return callerFor(
    {
      kind: "api_key",
      id: "key-1",
      owner_id: WORKSPACE,
      workspace_id: WORKSPACE,
      scopes: [...scopesForRole("owner")],
    },
    { kind: "api" },
    crypto.randomUUID(),
    { creatorId: crypto.randomUUID() },
  );
}

const CALLBACK = "https://console.example.com/settings/linked-accounts/github";
const NOW = new Date("2026-11-02T09:00:00.000Z");

type FakeConnection = {
  id: string;
  role: GitHubAppRole;
  appId: number;
  /** The App the key read finds on the row, when a replacement landed between. */
  keyAppId?: number;
  fails?: GitHubAppCheckFailure;
  installations?: GitHubAppInstallationView[];
};

const ASKED = { contents: "write", pull_requests: "write" } as const;

function installation(
  id: number,
  account: string,
  overrides: Partial<GitHubAppInstallationView> = {},
): GitHubAppInstallationView {
  return {
    id,
    account,
    accountType: "organization",
    accountId: 9000 + id,
    repositorySelection: "selected",
    htmlUrl: `https://github.com/organizations/${account}/settings/installations/${id}`,
    permissions: ASKED,
    createdAt: new Date("2026-10-01T09:00:00.000Z"),
    suspendedAt: null,
    ...overrides,
  };
}

function fakeApps(connections: readonly FakeConnection[]) {
  const recorded: string[] = [];
  const record = (held: FakeConnection) => ({
    id: held.id,
    role: held.role,
    workspaceId: WORKSPACE,
    appId: held.appId,
    slug: `app-${held.appId}`,
    name: `stored-${held.appId}`,
    htmlUrl: `https://github.com/apps/app-${held.appId}`,
    permissions: null,
    permissionsCheckedAt: null,
    clientId: null,
    apiBase: "https://api.github.com",
    createdAt: NOW,
    updatedAt: NOW,
    privateKey: { updatedAt: NOW, updatedBy: null },
  });
  const apps = {
    list: async () => connections.map(record),
    credentials: async (role: GitHubAppRole) =>
      connections
        .filter((held) => held.role === role)
        .map((held) => ({
          id: held.id,
          workspaceId: WORKSPACE,
          appId: held.keyAppId ?? held.appId,
          apiBase: "https://api.github.com",
          privateKey: "pem",
          updatedAt: NOW,
        })),
    recordPermissions: async (id: string) => {
      recorded.push(id);
    },
  } as unknown as GitHubAppStore;
  const by = (appId: number) => {
    const held = connections.find((each) => each.appId === appId);
    if (held === undefined) throw new Error(`no fake App ${appId}`);
    if (held.fails !== undefined) throw new GitHubAppCheckError(held.fails);
    return held;
  };
  const directory = {
    describe: async (app: { appId: number }) => {
      by(app.appId);
      return {
        appId: app.appId,
        slug: `app-${app.appId}`,
        name: `App ${app.appId}`,
        htmlUrl: `https://github.com/apps/app-${app.appId}`,
        permissions: ASKED,
        clientId: null,
        owner: { login: "acme", type: "organization" },
      };
    },
    installations: async (app: { appId: number }) =>
      by(app.appId).installations ?? [],
    installationRepositoriesPage: async () => ({
      repositories: [],
      totalCount: 3,
    }),
  } as unknown as GitHubAppDirectory;
  return { apps, directory, recorded };
}

function fakeInstallations(
  seed: {
    snapshots?: Array<
      { connectionId: string; appId: number } & GitHubInstallationSnapshot
    >;
    links?: GitHubInstallationLink[];
  } = {},
) {
  const snapshots = [...(seed.snapshots ?? [])];
  const store = {
    recordSnapshot: async (
      connectionId: string,
      appId: number,
      snapshot: GitHubInstallationSnapshot,
    ) => {
      const at = snapshots.findIndex(
        (held) => held.connectionId === connectionId,
      );
      if (at >= 0) snapshots.splice(at, 1);
      snapshots.push({ connectionId, appId, ...snapshot });
    },
    snapshot: async (connectionId: string, appId: number) =>
      snapshots.find(
        (held) => held.connectionId === connectionId && held.appId === appId,
      ) ?? null,
    links: async () => seed.links ?? [],
  } as unknown as GitHubInstallationStore;
  return { store, snapshots };
}

function harness(
  options: {
    authorApp?: boolean;
    secretsOn?: boolean;
    connections?: readonly FakeConnection[];
    installations?: GitHubInstallationStore;
    failPermissionsWrite?: boolean;
    now?: () => Date;
  } = {},
) {
  const secrets: Array<{ workspaceId: string; secret: string }> = [];
  const oauth: GitHubOAuthStore = {
    status: async () => ({
      authorApp: options.authorApp !== false,
      connectionId: options.authorApp === false ? null : AUTHOR_CONNECTION,
      clientId: options.authorApp === false ? null : "Iv23liClient",
      clientSecretSet: secrets.length > 0,
    }),
    client: async () => null,
    putClientSecret: async (workspaceId, secret, _audit, clientId) => {
      if (options.authorApp === false) return { outcome: "no_author_app" };
      if (clientId !== "Iv23liClient") return { outcome: "client_changed" };
      secrets.push({ workspaceId, secret });
      return { outcome: "stored" };
    },
  };
  let settings: GitHubWorkspaceSettings = {
    ceiling: GITHUB_CEILING_NONE,
    revision: 0,
  };
  const puts: Array<{ updatedBy: string; ceiling: GitHubCeiling }> = [];
  const fake = fakeApps(options.connections ?? []);
  if (options.failPermissionsWrite) {
    fake.apps.recordPermissions = () => Promise.reject(new Error("db down"));
  }
  const store: GitHubSettingsStore = {
    get: async () => settings,
    agentsUsing: async () => ({
      workflows: 0,
      actions: 2,
      checks: 0,
      issues: 0,
      review: 1,
    }),
    appPermissions: async () => ({
      author: { permissions: { contents: "write", actions: "write" } },
      reviewer: null,
    }),
    putCeiling: async (input) => {
      if (input.revision !== settings.revision) {
        return { outcome: "revision_conflict" };
      }
      puts.push({ updatedBy: input.updatedBy, ceiling: input.ceiling });
      settings = { ceiling: input.ceiling, revision: settings.revision + 1 };
      return { outcome: "stored", settings };
    },
  };
  // Revision-checked like the Postgres store; a save with the values held is a no-op.
  let layout: PullRequestSettingsRead = {
    settings: DEFAULT_PULL_REQUEST_SETTINGS,
    revision: 0,
  };
  const layoutPuts: PullRequestSettings[] = [];
  const pullRequestSettings: Pick<PullRequestSettingsStore, "get" | "put"> = {
    get: async () => layout,
    put: async (input) => {
      if (input.revision !== layout.revision) {
        return { outcome: "revision_conflict" };
      }
      layoutPuts.push(input.settings);
      layout = { settings: input.settings, revision: layout.revision + 1 };
      return { ...layout, outcome: "stored", receiptId: "receipt-1" };
    },
  };
  const service = createGitHubSettingsService({
    authorization: createAuthorizationPolicy(),
    store,
    pullRequestSettings,
    oauth,
    callbackUrl: CALLBACK,
    secretsOn: options.secretsOn ?? true,
    apps: fake.apps,
    directory: fake.directory,
    installations: options.installations ?? null,
    newId: () => "019a0000-0000-7000-8000-0000000000aa",
    now: options.now ?? (() => NOW),
  });
  return {
    service,
    puts,
    layoutPuts,
    secrets,
    recorded: fake.recorded,
  };
}

const ACTIONS_ON: GitHubCeiling = { ...GITHUB_CEILING_NONE, actions: true };

describe("GitHub settings service", () => {
  test("GET by any member returns ceiling, revision, agents_using and apps", async () => {
    const { service } = harness();
    for (const role of ["owner", "admin"] as const) {
      expect(await service.get(user(role), WORKSPACE)).toMatchObject({
        revision: 0,
      });
    }
    expect(await service.get(user("member"), WORKSPACE)).toEqual({
      ceiling: GITHUB_CEILING_NONE,
      revision: 0,
      pull_request: DEFAULT_PULL_REQUEST_SETTINGS,
      pull_request_revision: 0,
      agents_using: {
        workflows: 0,
        actions: 2,
        checks: 0,
        issues: 0,
        review: 1,
      },
      oauth: {
        connection_id: AUTHOR_CONNECTION,
        client_id: "Iv23liClient",
        client_secret_set: false,
        callback_url: CALLBACK,
      },
      connections: [],
      apps: {
        author: { permissions: { contents: "write", actions: "write" } },
        reviewer: null,
      },
    });
  });

  test("connections lists every App, two of one role included, with their installations", async () => {
    const { service, recorded } = harness({
      connections: [
        {
          id: "conn-a",
          role: "author",
          appId: 11,
          installations: [
            installation(2, "zeta"),
            installation(1, "acme", {
              permissions: { contents: "write" },
            }),
          ],
        },
        {
          id: "conn-b",
          role: "author",
          appId: 12,
          installations: [
            installation(3, "acme-labs", {
              accountType: "user",
              suspendedAt: new Date("2026-11-01T00:00:00.000Z"),
            }),
          ],
        },
        { id: "conn-r", role: "reviewer", appId: 13 },
      ],
    });
    const { connections } = await service.get(user("owner"), WORKSPACE);
    expect(connections.map((each) => [each.connection_id, each.role])).toEqual([
      ["conn-a", "author"],
      ["conn-b", "author"],
      ["conn-r", "reviewer"],
    ]);
    const [first, second] = connections;
    expect(first).toMatchObject({
      name: "App 11",
      app_id: 11,
      owner: { login: "acme", type: "organization" },
      permissions: ASKED,
      key_status: "ok",
      installations_read_at: NOW.toISOString(),
      check: { state: "ok", checked_at: NOW.toISOString() },
    });
    expect(first?.installations).toEqual([
      {
        id: 1,
        account: "acme",
        account_type: "organization",
        status: "approval_pending",
        detail: {
          connection_id: "conn-a",
          role: "author",
          account_id: 9001,
          permissions: { contents: "write" },
          approval: "pending",
          repository_count: 3,
          repository_selection: "selected",
          html_url:
            "https://github.com/organizations/acme/settings/installations/1",
          created_at: "2026-10-01T09:00:00.000Z",
          suspended_at: null,
          connected: null,
        },
      },
      expect.objectContaining({ id: 2, account: "zeta", status: "active" }),
    ]);
    expect(second?.installations).toEqual([
      expect.objectContaining({
        account: "acme-labs",
        account_type: "user",
        status: "suspended",
        detail: expect.objectContaining({
          repository_count: null,
          suspended_at: "2026-11-01T00:00:00.000Z",
        }),
      }),
    ]);
    expect(recorded.sort()).toEqual(["conn-a", "conn-b", "conn-r"]);
  });

  test("one App GitHub fails for keeps the others' installations", async () => {
    const { service } = harness({
      connections: [
        {
          id: "conn-a",
          role: "author",
          appId: 11,
          fails: "github_unreachable",
        },
        {
          id: "conn-r",
          role: "reviewer",
          appId: 13,
          fails: "github_rejected",
        },
        {
          id: "conn-b",
          role: "author",
          appId: 12,
          installations: [installation(3, "acme")],
        },
      ],
    });
    const { connections } = await service.get(user("admin"), WORKSPACE);
    const byId = new Map(connections.map((each) => [each.connection_id, each]));
    expect(byId.get("conn-a")).toMatchObject({
      name: "stored-11",
      owner: null,
      key_status: "unknown",
      installations: [],
      installations_read_at: null,
      check: {
        state: "failed",
        reason_code: "github_unavailable",
        checked_at: NOW.toISOString(),
      },
    });
    expect(byId.get("conn-r")).toMatchObject({
      key_status: "rejected",
      check: { state: "failed", reason_code: "github_app_auth_failed" },
    });
    expect(byId.get("conn-b")).toMatchObject({
      key_status: "ok",
      check: { state: "ok" },
      installations: [expect.objectContaining({ account: "acme" })],
    });
  });

  test("a member reads each installation's account, type and status only", async () => {
    const { service, recorded } = harness({
      connections: [
        {
          id: "conn-a",
          role: "author",
          appId: 11,
          installations: [installation(1, "acme")],
        },
      ],
    });
    const { connections } = await service.get(user("member"), WORKSPACE);
    // A member's read writes nothing.
    expect(recorded).toEqual([]);
    expect(connections[0]?.installations).toEqual([
      {
        id: 1,
        account: "acme",
        account_type: "organization",
        status: "active",
        detail: null,
      },
    ]);
    expect(JSON.stringify(connections)).not.toContain("repository_count");
  });

  test("any successful read keeps each connection's list, timed when the list answered", async () => {
    const kept = fakeInstallations();
    const connections: FakeConnection[] = [
      {
        id: "conn-a",
        role: "author",
        appId: 11,
        installations: [installation(1, "acme")],
      },
    ];
    // Each reading of the clock is a second later, so a list stamped after
    // the whole lookup would carry a later time than when it answered.
    let ticks = 0;
    const { service } = harness({
      connections,
      installations: kept.store,
      now: () => new Date(NOW.getTime() + 1000 * ticks++),
    });
    const read = await service.get(user("member"), WORKSPACE);
    const [connection] = read.connections;
    expect(connection?.installations_read_at).toBe(NOW.toISOString());
    expect(connection?.check.checked_at).not.toBe(NOW.toISOString());
    expect(kept.snapshots).toEqual([
      {
        connectionId: "conn-a",
        appId: 11,
        installations: [installation(1, "acme")],
        readAt: NOW,
      },
    ]);
  });

  test("a connection GitHub fails for answers its last list, each installation unknown, read at the last answer", async () => {
    const lastRead = new Date("2026-11-02T08:00:00.000Z");
    const kept = fakeInstallations({
      snapshots: [
        {
          connectionId: "conn-a",
          appId: 11,
          installations: [
            installation(2, "beta", {
              suspendedAt: new Date("2026-10-20T00:00:00.000Z"),
            }),
            installation(1, "acme", { permissions: { contents: "read" } }),
          ],
          readAt: lastRead,
        },
        {
          connectionId: "conn-r",
          appId: 99,
          installations: [installation(5, "old")],
          readAt: lastRead,
        },
      ],
    });
    const { service } = harness({
      installations: kept.store,
      connections: [
        { id: "conn-a", role: "author", appId: 11, fails: "github_rejected" },
        {
          id: "conn-r",
          role: "reviewer",
          appId: 13,
          fails: "github_unreachable",
        },
      ],
    });
    for (const role of ["admin", "member"] as const) {
      const { connections } = await service.get(user(role), WORKSPACE);
      const byId = new Map(
        connections.map((each) => [each.connection_id, each]),
      );
      const failed = byId.get("conn-a");
      expect(failed?.check).toEqual({
        state: "failed",
        reason_code: "github_app_auth_failed",
        checked_at: NOW.toISOString(),
      });
      expect(failed?.installations_read_at).toBe(lastRead.toISOString());
      expect(
        failed?.installations.map((each) => [each.account, each.status]),
      ).toEqual([
        ["acme", "unknown"],
        ["beta", "unknown"],
      ]);
      if (role === "admin") {
        expect(failed?.installations[0]?.detail).toMatchObject({
          approval: "unknown",
          repository_count: null,
          account_id: 9001,
        });
      } else {
        expect(failed?.installations[0]?.detail).toBeNull();
      }
      expect(byId.get("conn-r")).toMatchObject({
        installations: [],
        installations_read_at: null,
      });
    }
    expect(kept.snapshots.map((held) => held.readAt)).toEqual([
      lastRead,
      lastRead,
    ]);
  });

  test("a manager reads who connected an installation from the console; a member does not", async () => {
    const connectedAt = new Date("2026-11-01T10:00:00.000Z");
    const kept = fakeInstallations({
      links: [
        {
          connectionId: "conn-a",
          installationId: 1,
          connectedBy: { userId: OTHER, displayName: "Jae" },
          connectedAt,
        },
        {
          connectionId: "conn-b",
          installationId: 2,
          connectedBy: null,
          connectedAt,
        },
      ],
    });
    const { service } = harness({
      installations: kept.store,
      connections: [
        {
          id: "conn-a",
          role: "author",
          appId: 11,
          installations: [installation(1, "acme"), installation(2, "beta")],
        },
      ],
    });
    const managed = await service.get(user("owner"), WORKSPACE);
    expect(
      managed.connections[0]?.installations.map(
        (each) => each.detail?.connected,
      ),
    ).toEqual([
      {
        by: { user_id: OTHER, display_name: "Jae" },
        at: connectedAt.toISOString(),
      },
      null,
    ]);
    const read = await service.get(user("member"), WORKSPACE);
    expect(JSON.stringify(read.connections)).not.toContain("Jae");
  });

  test("a manager's read answers what GitHub said when keeping the permissions fails", async () => {
    const { service } = harness({
      failPermissionsWrite: true,
      connections: [
        {
          id: "conn-a",
          role: "author",
          appId: 11,
          installations: [installation(1, "acme")],
        },
      ],
    });
    const { connections } = await service.get(user("owner"), WORKSPACE);
    expect(connections[0]).toMatchObject({
      key_status: "ok",
      check: { state: "ok" },
      installations: [expect.objectContaining({ status: "active" })],
    });
  });

  test("an App replaced between the row read and the key read is left out, not mixed", async () => {
    const { service } = harness({
      connections: [
        { id: "conn-a", role: "author", appId: 11, keyAppId: 14 },
        { id: "conn-r", role: "reviewer", appId: 13 },
      ],
    });
    const { connections } = await service.get(user("owner"), WORKSPACE);
    expect(connections.map((each) => each.connection_id)).toEqual(["conn-r"]);
  });

  test("GET for another workspace is NOT_FOUND", async () => {
    const { service } = harness();
    expect((await refusal(service.get(user("owner"), OTHER))).code).toBe(
      "NOT_FOUND",
    );
    expect(
      (
        await refusal(
          service.get(user("owner", { workspace: OTHER }), WORKSPACE),
        )
      ).code,
    ).toBe("NOT_FOUND");
  });

  test("GET by an API key is FORBIDDEN", async () => {
    const { service } = harness();
    expect((await refusal(service.get(apiKey(), WORKSPACE))).code).toBe(
      "FORBIDDEN",
    );
  });

  test("an owner and an admin signed in to the console can PUT", async () => {
    const { service, puts } = harness();
    const owner = user("owner");
    const stored = await service.put(owner, WORKSPACE, async () => ({
      ceiling: ACTIONS_ON,
      revision: 0,
    }));
    expect(stored).toMatchObject({ ceiling: ACTIONS_ON, revision: 1 });
    const admin = user("admin");
    expect(
      await service.put(admin, WORKSPACE, async () => ({
        ceiling: GITHUB_CEILING_NONE,
        revision: 1,
      })),
    ).toMatchObject({ ceiling: GITHUB_CEILING_NONE, revision: 2 });
    expect(puts.map((put): string | undefined => put.updatedBy)).toEqual([
      owner.subject.principal?.id,
      admin.subject.principal?.id,
    ]);
  });

  test("turning merge on is a manager's: a member is FORBIDDEN, an admin stores it", async () => {
    const MERGE_ON: GitHubCeiling = { ...GITHUB_CEILING_NONE, merge: true };
    const denied = harness();
    expect(
      (
        await refusal(
          denied.service.put(user("member"), WORKSPACE, async () => ({
            ceiling: MERGE_ON,
            revision: 0,
          })),
        )
      ).code,
    ).toBe("FORBIDDEN");
    expect(denied.puts).toEqual([]);
    const allowed = harness();
    await allowed.service.put(user("admin"), WORKSPACE, async () => ({
      ceiling: MERGE_ON,
      revision: 0,
    }));
    expect(allowed.puts.map((put) => put.ceiling)).toEqual([MERGE_ON]);
  });

  test("a member PUT is FORBIDDEN and the body is not read", async () => {
    const { service, puts } = harness();
    let read = false;
    expect(
      (
        await refusal(
          service.put(user("member"), WORKSPACE, async () => {
            read = true;
            return { ceiling: ACTIONS_ON, revision: 0 };
          }),
        )
      ).code,
    ).toBe("FORBIDDEN");
    expect(read).toBe(false);
    expect(puts).toEqual([]);
  });

  test("an API key, or an owner off the web surface, is FORBIDDEN", async () => {
    const { service, puts } = harness();
    const body = async () => ({ ceiling: ACTIONS_ON, revision: 0 });
    expect((await refusal(service.put(apiKey(), WORKSPACE, body))).code).toBe(
      "FORBIDDEN",
    );
    expect(
      await refusal(
        service.put(user("owner", { surface: "api" }), WORKSPACE, body),
      ),
    ).toEqual({
      code: "FORBIDDEN",
      details: { reason_code: "web_session_required" },
    });
    expect(puts).toEqual([]);
  });

  test("a stale revision is REVISION_CONFLICT", async () => {
    const { service } = harness();
    await service.put(user("owner"), WORKSPACE, async () => ({
      ceiling: ACTIONS_ON,
      revision: 0,
    }));
    expect(
      (
        await refusal(
          service.put(user("owner"), WORKSPACE, async () => ({
            ceiling: GITHUB_CEILING_NONE,
            revision: 0,
          })),
        )
      ).code,
    ).toBe("REVISION_CONFLICT");
  });
});

describe("the pull request settings", () => {
  const layout = (
    over: Partial<PullRequestSettings> = {},
  ): PullRequestSettings => ({ ...DEFAULT_PULL_REQUEST_SETTINGS, ...over });
  const put = (
    caller: Caller,
    service: ReturnType<typeof harness>["service"],
    pull_request: PullRequestSettings,
    revision = 0,
  ) =>
    service.putPullRequest(caller, WORKSPACE, async () => ({
      pull_request,
      revision,
    }));

  test("an owner stores them and the next GET shows them with the new revision", async () => {
    const { service, layoutPuts, puts } = harness();
    const next = layout({ session_link: "id", formatting: "off" });
    expect(await put(user("owner"), service, next)).toEqual({
      pull_request: next,
      pull_request_revision: 1,
      receipt_id: "receipt-1",
    });
    const read = await service.get(user("member"), WORKSPACE);
    expect(read.pull_request).toEqual(next);
    expect(read.pull_request_revision).toBe(1);
    // The ceiling keeps its own revision.
    expect(read.revision).toBe(0);
    expect(layoutPuts).toEqual([next]);
    expect(puts).toEqual([]);
  });

  test("a stale revision is a conflict and nothing is stored", async () => {
    const { service, layoutPuts } = harness();
    await put(user("admin"), service, layout({ session_link: "id" }));
    expect((await refusal(put(user("admin"), service, layout(), 0))).code).toBe(
      "REVISION_CONFLICT",
    );
    expect(layoutPuts).toHaveLength(1);
  });

  test("a member and an API key are refused before the body is read", async () => {
    const { service, layoutPuts } = harness();
    for (const caller of [user("member"), apiKey()]) {
      const refused = await refusal(
        service.putPullRequest(caller, WORKSPACE, async () => {
          throw new Error("the body was read");
        }),
      );
      expect(["FORBIDDEN", "NOT_FOUND"]).toContain(refused.code);
    }
    expect(layoutPuts).toEqual([]);
  });

  test("another workspace is not found", async () => {
    const { service } = harness();
    expect(
      (
        await refusal(
          service.putPullRequest(user("owner"), OTHER, async () => ({
            pull_request: layout(),
            revision: 0,
          })),
        )
      ).code,
    ).toBe("NOT_FOUND");
  });

  test.each([
    ["template_too_large", "x".repeat(16 * 1024 + 1)],
    ["template_not_utf8", "a\ud800b"],
    ["template_unsupported", "# Summary\n<!-- never closed"],
  ])("a template that is %s is refused up front", async (reason, text) => {
    const { service, layoutPuts } = harness();
    const refused = await refusal(
      put(user("owner"), service, layout({ default_template: text })),
    );
    expect(refused.code).toBe("BAD_REQUEST");
    expect(refused.details).toMatchObject({ reason_code: reason });
    expect(layoutPuts).toEqual([]);
  });

  test("a usable template is stored", async () => {
    const { service } = harness();
    const text = "## Summary\n\n## Testing\n- [ ] ran it\n";
    const stored = await put(
      user("owner"),
      service,
      layout({ default_template: text, template_mode: "override" }),
    );
    expect(stored.pull_request.default_template).toBe(text);
  });
});

// Every refusal comes before the body, so these never hold a client secret.
describe("storing the OAuth client secret", () => {
  test("an owner or an admin stores it for the App shown; only that it is set comes back", async () => {
    const { service, secrets } = harness();
    for (const role of ["owner", "admin"] as const) {
      const typed = fakeGitHubClientSecret();
      const stored = await service.putOAuthClientSecret(
        user(role),
        WORKSPACE,
        async () => ({ client_id: "Iv23liClient", client_secret: typed }),
      );
      // Field by field: a matcher handed the whole object would print it.
      expect(Object.keys(stored).sort()).toEqual(["oauth", "receipt_id"]);
      expect(Object.keys(stored.oauth).sort()).toEqual([
        "callback_url",
        "client_id",
        "client_secret_set",
        "connection_id",
      ]);
      expect(stored.receipt_id).toBe("019a0000-0000-7000-8000-0000000000aa");
      expect(stored.oauth.client_id).toBe("Iv23liClient");
      expect(stored.oauth.client_secret_set).toBe(true);
      expect(stored.oauth.callback_url).toBe(CALLBACK);
      expect(JSON.stringify(stored).includes(typed)).toBe(false);
      expect(secrets.at(-1)?.secret === typed).toBe(true);
      expect(secrets.at(-1)?.workspaceId).toBe(WORKSPACE);
    }
    expect(secrets.length).toBe(2);
  });
});

describe("refusing the OAuth client secret", () => {
  const unread = async (): Promise<never> => {
    throw new Error("the body was read");
  };

  test("a member, an API key, an owner off the web or another workspace", async () => {
    const { service, secrets } = harness();
    for (const [caller, workspaceId, code] of [
      [user("member"), WORKSPACE, "FORBIDDEN"],
      [apiKey(), WORKSPACE, "FORBIDDEN"],
      [user("owner", { surface: "api" }), WORKSPACE, "FORBIDDEN"],
      [user("owner"), OTHER, "NOT_FOUND"],
    ] as const) {
      expect(
        (
          await refusal(
            service.putOAuthClientSecret(caller, workspaceId, unread),
          )
        ).code,
      ).toBe(code);
    }
    expect(secrets).toEqual([]);
  });

  test("no author App is GITHUB_LINK_NOT_CONFIGURED", async () => {
    const { service } = harness({ authorApp: false });
    expect(
      await refusal(
        service.putOAuthClientSecret(user("admin"), WORKSPACE, unread),
      ),
    ).toEqual({
      code: "GITHUB_LINK_NOT_CONFIGURED",
      details: { reason_code: "no_author_app" },
    });
  });

  test("a secret typed for an App since replaced is REVISION_CONFLICT", async () => {
    const { service, secrets } = harness();
    expect(
      await refusal(
        service.putOAuthClientSecret(user("owner"), WORKSPACE, async () => ({
          client_id: "Iv23liReplaced",
          // Refused before it is stored, as in the callback fixtures.
          client_secret: "",
        })),
      ),
    ).toEqual({
      code: "REVISION_CONFLICT",
      details: { reason_code: "github_app_changed" },
    });
    expect(secrets).toEqual([]);
  });

  test("the secret store off is BACKEND_UNAVAILABLE", async () => {
    const { service } = harness({ secretsOn: false });
    expect(
      (
        await refusal(
          service.putOAuthClientSecret(user("owner"), WORKSPACE, unread),
        )
      ).code,
    ).toBe("BACKEND_UNAVAILABLE");
  });
});
