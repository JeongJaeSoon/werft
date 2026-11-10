import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubAppRole } from "@werft-ai/contracts";
import {
  type CatalogRepository,
  ForgeCredentialError,
  GitHubAppCheckError,
  type GitHubAppCredential,
  type GitHubConnectionSource,
  GitHubPermissionError,
  type SessionCatalog,
} from "@werft-ai/platform";
import { type FakeGitHub, startFakeGitHub } from "@werft-ai/testkit";
import {
  connectionsOf,
  createAppBotUsers,
  createGitHubAppDirectory,
  createGitHubConnection,
  createRegisteredGitHubConnections,
  REFRESH_BEFORE_EXPIRY_MS,
} from "./forge-github.ts";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keys.privateKey
  .export({ type: "pkcs1", format: "pem" })
  .toString();
const publicKey = keys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const repo = { owner: "acme", name: "app" };
const READ = { contents: "read" } as const;
const WRITE = { contents: "write" } as const;

let github: FakeGitHub;
beforeAll(async () => {
  github = await startFakeGitHub({ appId: 101, publicKey });
  await github.createRepository("acme", "app", { "README.md": "hello\n" });
  await github.createRepository("acme", "other", { "README.md": "no\n" });
});
afterAll(async () => {
  await github.stop();
});

function appConnection(options: { now?: () => Date; apiBase?: string } = {}) {
  const warnings: Array<Record<string, unknown>> = [];
  const connection = createGitHubConnection({
    apiBase: options.apiBase ?? github.origin,
    credentials: { kind: "app", appId: 101, installationId: 202, privateKey },
    ...(options.now === undefined ? {} : { now: options.now }),
    retryAfterBaseMs: 1,
    paced: false,
    logger: {
      warn: (message: string, fields?: Record<string, unknown>) =>
        warnings.push({ message, ...fields }),
    },
  });
  return { connection, warnings };
}

async function clone(url: string, authorization: string) {
  const dir = await mkdtemp(join(tmpdir(), "forge-clone-"));
  try {
    const child = Bun.spawn(
      [
        "git",
        "-c",
        `http.extraHeader=Authorization: ${authorization}`,
        "clone",
        "--quiet",
        url,
        join(dir, "checkout"),
      ],
      {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: dir,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
        stderr: "pipe",
      },
    );
    const code = await child.exited;
    if (code !== 0) return null;
    return await Bun.file(join(dir, "checkout", "README.md")).text();
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

const basic = (username: string, password: string) =>
  `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

describe("a GitHub App connection", () => {
  test("asks for a token scoped to the one repository and the permissions named, with a JWT the App signed", async () => {
    const before = github.tokenRequests.length;
    const started = Math.floor(Date.now() / 1000);
    const { connection } = appConnection();
    expect(connection).toMatchObject({
      kind: "app",
      appId: 101,
      githubCom: false,
    });
    const { credential, fresh } = await connection.credential(repo, READ);
    expect(fresh).toBe(true);
    const [asked] = github.tokenRequests.slice(before);
    expect(github.tokenRequests.length - before).toBe(1);
    expect(asked).toMatchObject({
      installationId: 202,
      status: 201,
      body: { repositories: ["app"], permissions: { contents: "read" } },
      jwt: { iss: "101" },
    });
    const jwt = asked?.jwt;
    if (!jwt) throw new Error("no JWT");
    // Back-dated against clock skew, and inside GitHub's 10-minute cap.
    expect(jwt.iat).toBeLessThan(started);
    expect(jwt.exp - jwt.iat).toBeLessThanOrEqual(600);
    expect(credential.username).toBe("x-access-token");
    expect(credential.expiresAt).toBeInstanceOf(Date);

    // The token clones that repository, and no other.
    const authorization = basic(credential.username, credential.password);
    expect(await clone(`${github.origin}/acme/app.git`, authorization)).toBe(
      "hello\n",
    );
    expect(await clone(`${github.origin}/acme/other.git`, authorization)).toBe(
      null,
    );
  });

  test("keeps a token per repository and permission set, and re-issues it ten minutes before it expires", async () => {
    let offset = 0;
    const { connection } = appConnection({
      now: () => new Date(Date.now() + offset),
    });
    const before = github.tokenRequests.length;
    const first = await connection.credential(repo, READ);
    const cached = await connection.credential(repo, READ);
    expect(cached.credential.password).toBe(first.credential.password);
    expect(cached.fresh).toBe(false);
    expect(github.tokenRequests.length - before).toBe(1);

    const expiresAt = first.credential.expiresAt?.getTime() ?? 0;
    offset = expiresAt - REFRESH_BEFORE_EXPIRY_MS - Date.now() - 5_000;
    expect((await connection.credential(repo, READ)).credential.password).toBe(
      first.credential.password,
    );
    offset = expiresAt - REFRESH_BEFORE_EXPIRY_MS - Date.now() + 1_000;
    const second = await connection.credential(repo, READ);
    expect(second.credential.password).not.toBe(first.credential.password);
    expect(second.fresh).toBe(true);
    expect(github.tokenRequests.length - before).toBe(2);

    // Write access is its own token, asked with contents:write.
    await connection.credential(repo, WRITE);
    expect(github.tokenRequests.at(-1)?.body).toEqual({
      repositories: ["app"],
      permissions: { contents: "write" },
    });
    expect(github.tokenRequests.length - before).toBe(3);

    // The same permissions in another order are the same token.
    offset = 0;
    await connection.credential(repo, {
      pull_requests: "write",
      contents: "read",
    });
    await connection.credential(repo, {
      contents: "read",
      pull_requests: "write",
    });
    expect(github.tokenRequests.length - before).toBe(4);
  });

  test("concurrent asks for the same token issue it once", async () => {
    const { connection } = appConnection();
    const before = github.tokenRequests.length;
    const all = await Promise.all(
      Array.from({ length: 8 }, () => connection.credential(repo, READ)),
    );
    expect(new Set(all.map((c) => c.credential.password)).size).toBe(1);
    expect(all.filter((c) => c.fresh)).toHaveLength(1);
    expect(github.tokenRequests.length - before).toBe(1);
  });

  test("a failing token endpoint fails the ask, naming the status and GitHub's message", async () => {
    const { connection, warnings } = appConnection();
    const before = github.tokenRequests.length;
    github.failTokens(true);
    try {
      const error = await connection.credential(repo, READ).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ForgeCredentialError);
      expect((error as Error).message).toBe(
        "GitHub installation token request failed (500)",
      );
      expect(warnings).toEqual([
        {
          message: "GitHub request failed",
          request: "installation token request",
          status: 500,
          error: "HttpError",
          github_reason: "Server Error",
        },
      ]);
      expect(github.tokenRequests.length - before).toBe(3);
    } finally {
      github.failTokens(false);
    }
    // Nothing failed is cached: the next ask issues.
    expect((await connection.credential(repo, READ)).credential.username).toBe(
      "x-access-token",
    );
  });

  test("permissions the installation does not grant are a GitHubPermissionError", async () => {
    const { connection, warnings } = appConnection();
    github.setPermissions({ contents: "read", metadata: "read" });
    try {
      const refused = await connection.credential(repo, WRITE).then(
        () => null,
        (e: unknown) => e,
      );
      expect(refused).toBeInstanceOf(GitHubPermissionError);
      expect(github.tokenRequests.at(-1)?.status).toBe(422);
      expect(warnings).toMatchObject([
        { request: "installation token request", status: 422 },
      ]);
      // What it does grant is still issued.
      expect((await connection.credential(repo, READ)).fresh).toBe(true);
    } finally {
      github.setPermissions(undefined);
    }
  });

  test("a GHES API base under /api/v3 works the same", async () => {
    const before = github.tokenRequests.length;
    const { connection } = appConnection({
      apiBase: `${github.origin}/api/v3/`,
    });
    expect(connection.githubCom).toBe(false);
    const { credential } = await connection.credential(repo, READ);
    expect(github.tokenRequests.length - before).toBe(1);
    expect(await connection.api(repo, credential).getRepository()).toEqual({
      id: expect.any(Number),
      defaultBranch: "main",
      private: true,
    });
  });

  test("names itself Werft in the User-Agent", async () => {
    const calls = spyOn(globalThis, "fetch");
    try {
      const { connection } = appConnection();
      const { credential } = await connection.credential(repo, READ);
      await connection.api(repo, credential).getRepository();
      // Another file's unrestored fetch spy can be the one returned here, so
      // only requests to this fake GitHub count.
      const agents = calls.mock.calls
        .filter(([url]) => String(url).startsWith(github.origin))
        .map(([, init]) => new Headers(init?.headers).get("user-agent"));
      expect(agents.length).toBeGreaterThan(0);
      for (const agent of agents) expect(agent).toStartWith("Werft ");
    } finally {
      calls.mockRestore();
    }
  });
});

describe("connectionsOf", () => {
  const base = { branch: "main", profiles: ["p"] };
  const catalog: SessionCatalog = {
    profiles: {},
    repositories: {
      app: {
        ...base,
        url: "https://github.com/acme/app.git",
        auth: {
          kind: "github_app",
          app_id: 101,
          installation_id: 202,
          api_base: "https://api.github.com",
          value: privateKey,
          ref: { value_env: "K" },
        },
      },
    },
  };

  test("an App has an author connection; the reviewer role and a missing repository have none", () => {
    const connections = connectionsOf(catalog);
    expect(connections("app", "author")).toMatchObject({
      kind: "fixed",
      connection: { kind: "app", appId: 101, githubCom: true },
    });
    expect(fixedOf(connections("app", "author"))).toBe(
      fixedOf(connections("app", "author")),
    );
    expect(connections("app", "reviewer")).toBeNull();
    expect(connections("missing", "author")).toBeNull();
  });

  test("refreshes fixed App connections when installation settings change", () => {
    const changing: SessionCatalog = { profiles: {}, repositories: {} };
    const connections = connectionsOf(changing);
    expect(connections("app", "author")).toBeNull();

    changing.repositories = catalog.repositories;
    const first = fixedOf(connections("app", "author"));
    expect(first).not.toBeNull();
    expect(fixedOf(connections("app", "author"))).toBe(first);

    changing.repositories = {};
    expect(connections("app", "author")).toBeNull();

    changing.repositories = catalog.repositories;
    expect(fixedOf(connections("app", "author"))).not.toBe(first);
  });
});

function registeredFor({
  role,
  ...options
}: { role: GitHubAppRole } & Parameters<
  typeof createRegisteredGitHubConnections
>[0]) {
  const all = createRegisteredGitHubConnections({
    ...options,
    store:
      options.store === null
        ? null
        : {
            credentials: (asked) =>
              asked === role
                ? (options.store?.credentials(asked) ?? Promise.resolve([]))
                : Promise.resolve([]),
          },
  });
  return {
    all,
    refresh: () => all.refresh(),
    connection: () => all.connections(role)[0]?.connection ?? null,
  };
}

const fixedOf = (source: GitHubConnectionSource | null) =>
  source?.kind === "fixed" ? source.connection : null;
const firstCandidateOf = (source: GitHubConnectionSource | null) =>
  source?.kind === "registered"
    ? (source.candidates[0]?.connection ?? null)
    : null;

describe("the App registered in the console", () => {
  const credential = (fields: Partial<GitHubAppCredential> = {}) => ({
    id: "8b0d2f4e-0000-4000-8000-000000000001",
    workspaceId: "8b0d2f4e-0000-4000-8000-0000000000aa",
    appId: 101,
    apiBase: github.origin,
    privateKey,
    updatedAt: new Date("2026-10-30T00:00:00Z"),
    ...fields,
  });

  test("finds the installation that covers the repository, then asks for a token on it", async () => {
    const registered = registeredFor({
      role: "author",
      store: { credentials: async () => [credential()] },
      paced: false,
    });
    expect(registered.connection()).toBeNull();
    await registered.refresh();
    const before = github.tokenRequests.length;
    const issued = await registered.connection()?.credential(repo, READ);
    expect(issued?.credential.username).toBe("x-access-token");
    const [asked] = github.tokenRequests.slice(before);
    expect(asked).toMatchObject({
      installationId: 1,
      status: 201,
      body: { repositories: ["app"], permissions: { contents: "read" } },
    });
  });

  test("reads its own role's App only, with the other registered beside it", async () => {
    const asked: string[] = [];
    const reviewer = registeredFor({
      role: "reviewer",
      store: {
        credentials: async (role: "author" | "reviewer") => {
          asked.push(role);
          return [credential({ appId: role === "reviewer" ? 202 : 101 })];
        },
      },
    });
    await reviewer.refresh();
    expect(asked).toEqual(["reviewer"]);
    expect(reviewer.connection()?.appId).toBe(202);
    asked.length = 0;
    const registered = registeredFor({
      role: "author",
      store: {
        credentials: async (role: "author" | "reviewer") => {
          asked.push(role);
          // GitHub knows no App 999, so a token from it would fail.
          return role === "reviewer"
            ? [
                credential({
                  id: "8b0d2f4e-0000-4000-8000-000000000002",
                  appId: 999,
                }),
              ]
            : [credential()];
        },
      },
      paced: false,
    });
    await registered.refresh();
    const before = github.tokenRequests.length;
    expect(
      (await registered.connection()?.credential(repo, WRITE))?.credential
        .username,
    ).toBe("x-access-token");
    expect(asked).toEqual(["author"]);
    expect(github.tokenRequests.slice(before)).toMatchObject([
      { status: 201, body: { permissions: { contents: "write" } } },
    ]);
  });

  test("a repository the App is not installed on fails the ask by name", async () => {
    const registered = registeredFor({
      role: "author",
      store: { credentials: async () => [credential()] },
      paced: false,
    });
    await registered.refresh();
    const asking = registered
      .connection()
      ?.credential({ owner: "acme", name: "absent" }, READ);
    await expect(asking).rejects.toThrow(
      new ForgeCredentialError("GitHub App is not installed on acme/absent"),
    );
  });

  test("a replaced App or key gets a new connection; a removed one leaves none", async () => {
    let held = [credential()];
    const registered = registeredFor({
      role: "author",
      store: { credentials: async () => held },
    });
    await registered.refresh();
    const first = registered.connection();
    await registered.refresh();
    expect(registered.connection()).toBe(first);
    held = [credential({ updatedAt: new Date("2026-10-30T01:00:00Z") })];
    await registered.refresh();
    expect(registered.connection()).not.toBe(first);
    held = [];
    await registered.refresh();
    expect(registered.connection()).toBeNull();
  });

  test("a slow read from before a delete cannot bring the App back", async () => {
    let release: () => void = () => {};
    const reads = [
      new Promise<ReturnType<typeof credential>[]>((resolve) => {
        release = () => resolve([credential()]);
      }),
      Promise.resolve([]),
    ];
    const registered = registeredFor({
      role: "author",
      store: { credentials: () => reads.shift() ?? Promise.resolve([]) },
    });
    const periodic = registered.refresh();
    const afterDelete = registered.refresh();
    release();
    await Promise.all([periodic, afterDelete]);
    expect(registered.connection()).toBeNull();
  });

  test("connectionsOf hands each role's Apps to repositories written as { kind: github_app }", async () => {
    let reviewerOn = false;
    const registered = createRegisteredGitHubConnections({
      store: {
        credentials: async (role: GitHubAppRole) =>
          role === "author"
            ? [credential()]
            : reviewerOn
              ? [
                  credential({
                    id: "8b0d2f4e-0000-4000-8000-000000000002",
                    appId: 202,
                  }),
                ]
              : [],
      },
    });
    const connections = connectionsOf(
      {
        profiles: {},
        repositories: {
          app: {
            branch: "main",
            url: "https://github.com/acme/app.git",
            auth: { kind: "github_app", registered: true },
          },
        },
      },
      { registered: (role) => registered.connections(role) },
    );
    expect(connections("app", "author")).toEqual({
      kind: "registered",
      candidates: [],
    });
    await registered.refresh();
    expect(firstCandidateOf(connections("app", "author"))).toBe(
      registered.connections("author")[0]?.connection ?? null,
    );
    expect(connections("app", "reviewer")).toEqual({
      kind: "registered",
      candidates: [],
    });
    reviewerOn = true;
    await registered.refresh();
    expect(firstCandidateOf(connections("app", "reviewer"))?.appId).toBe(202);
  });

  test("a repository the console adds after startup uses the registered App", async () => {
    const registered = registeredFor({
      role: "author",
      store: { credentials: async () => [credential()] },
    });
    await registered.refresh();
    const repositories: Record<string, CatalogRepository> = {};
    const connections = connectionsOf(
      {
        profiles: {},
        get repositories() {
          return repositories;
        },
      },
      { registered: (role) => registered.all.connections(role) },
    );
    expect(connections("later", "author")).toBeNull();
    repositories.later = {
      branch: "main",
      url: "https://github.com/acme/later.git",
      auth: { kind: "github_app", registered: true },
    };
    expect(firstCandidateOf(connections("later", "author"))).toBe(
      registered.connection(),
    );
    delete repositories.later;
    expect(connections("later", "author")).toBeNull();
  });

  test("installed asks GitHub with the App's JWT and issues no token", async () => {
    const registered = registeredFor({
      role: "author",
      store: { credentials: async () => [credential()] },
    });
    await registered.refresh();
    const before = github.tokenRequests.length;
    expect(await registered.connection()?.installed(repo)).toBe(true);
    expect(
      await registered
        .connection()
        ?.installed({ owner: "acme", name: "absent" }),
    ).toBe(false);
    expect(github.tokenRequests.length).toBe(before);
  });

  test("installedOn answers many repositories from the installation's list, case-insensitively", async () => {
    const registered = registeredFor({
      role: "author",
      store: { credentials: async () => [credential()] },
    });
    await registered.refresh();
    const answers = await registered
      .connection()
      ?.installedOn([
        repo,
        { owner: "ACME", name: "Other" },
        { owner: "acme", name: "absent" },
        { owner: "elsewhere", name: "app" },
      ]);
    expect([...(answers ?? [])]).toEqual([
      ["acme/app", true],
      ["acme/other", true],
      ["acme/absent", false],
      ["elsewhere/app", false],
    ]);
    expect((await registered.connection()?.installedOn([]))?.size).toBe(0);
  });

  test("installedOn takes one installation token for any number of repositories", async () => {
    const registered = registeredFor({
      role: "author",
      store: { credentials: async () => [credential()] },
    });
    await registered.refresh();
    const before = github.tokenRequests.length;
    await registered
      .connection()
      ?.installedOn([
        repo,
        { owner: "acme", name: "other" },
        { owner: "acme", name: "absent" },
      ]);
    expect(github.tokenRequests.length - before).toBe(1);
  });

  test("installedOn on a catalog App counts only its named installation", async () => {
    const catalogApp = (installationId: number) =>
      createGitHubConnection({
        apiBase: github.origin,
        credentials: { kind: "app", appId: 101, installationId, privateKey },
        paced: false,
      });
    expect((await catalogApp(1).installedOn([repo])).get("acme/app")).toBe(
      true,
    );
    expect((await catalogApp(202).installedOn([repo])).get("acme/app")).toBe(
      false,
    );
  });

  test("a catalog App is installed only where its named installation covers the repository", async () => {
    const catalogApp = (installationId: number) =>
      createGitHubConnection({
        apiBase: github.origin,
        credentials: { kind: "app", appId: 101, installationId, privateKey },
        paced: false,
      });
    const before = github.tokenRequests.length;
    // The fake's one installation is 1.
    expect(await catalogApp(1).installed(repo)).toBe(true);
    expect(await catalogApp(202).installed(repo)).toBe(false);
    expect(
      await catalogApp(1).installed({ owner: "acme", name: "absent" }),
    ).toBe(false);
    expect(github.tokenRequests.length).toBe(before);
  });
});

describe("createGitHubAppDirectory", () => {
  const directory = createGitHubAppDirectory({ retryAfterBaseMs: 1 });
  const app = () => ({ appId: 101, apiBase: github.origin, privateKey });

  test("describes the App with its permissions, lists its installation, and finds it per repository", async () => {
    expect(await directory.describe(app())).toEqual({
      appId: 101,
      slug: "fake-app",
      name: "Fake fake-app",
      htmlUrl: `${github.origin}/apps/fake-app`,
      clientId: "Iv23lifake-app",
      permissions: {
        contents: "write",
        metadata: "read",
        pull_requests: "write",
      },
      owner: { login: "fake-owner", type: "organization" },
    });
    github.setPermissions({ actions: "write", contents: "read" });
    try {
      expect((await directory.describe(app())).permissions).toEqual({
        actions: "write",
        contents: "read",
      });
    } finally {
      github.setPermissions(undefined);
    }
    expect(await directory.installations(app())).toEqual([
      {
        id: 1,
        account: "acme",
        accountType: "organization",
        accountId: 9001,
        repositorySelection: "selected",
        htmlUrl: `${github.origin}/organizations/acme/settings/installations/1`,
        permissions: expect.any(Object),
        createdAt: new Date("2026-10-01T09:00:00Z"),
        suspendedAt: null,
      },
    ]);
    github.suspendInstallations(true);
    try {
      expect((await directory.installations(app()))[0]?.suspendedAt).toEqual(
        new Date("2026-11-01T00:00:00Z"),
      );
    } finally {
      github.suspendInstallations(false);
    }
    expect(await directory.installationFor(app(), repo)).toEqual({
      id: 1,
      permissions: {
        contents: "write",
        metadata: "read",
        pull_requests: "write",
      },
    });
    expect(
      await directory.installationFor(app(), { owner: "acme", name: "absent" }),
    ).toBeNull();
  });

  test("a key GitHub does not know for the id is rejected; no answer is unreachable", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs1", format: "pem" })
      .toString();
    const rejected = directory.describe({ ...app(), privateKey: other });
    await expect(rejected).rejects.toMatchObject({ reason: "github_rejected" });
    await expect(rejected).rejects.toBeInstanceOf(GitHubAppCheckError);
    const wrongId = directory.describe({ ...app(), appId: 999 });
    await expect(wrongId).rejects.toMatchObject({ reason: "github_rejected" });
    const closed = Bun.serve({ port: 0, fetch: () => new Response("") });
    const unreachable = `http://127.0.0.1:${closed.port}`;
    closed.stop(true);
    await expect(
      directory.describe({ ...app(), apiBase: unreachable }),
    ).rejects.toMatchObject({ reason: "github_unreachable" });
  });
});

describe("createAppBotUsers", () => {
  const GITHUB_COM = "https://api.github.com";
  const answer = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  test("asks the users API once for <slug>[bot] and keeps its id", async () => {
    const calls = spyOn(globalThis, "fetch").mockImplementation((async () =>
      answer(200, {
        id: 41898282,
        login: "werft-dev[bot]",
        type: "Bot",
      })) as unknown as typeof fetch);
    try {
      const botUser = createAppBotUsers();
      const app = { slug: "werft-dev", apiBase: `${GITHUB_COM}/` };
      expect(await botUser(app)).toBe("41898282");
      expect(await botUser(app)).toBe("41898282");
      const urls = calls.mock.calls.map(([url]) => String(url));
      expect(urls).toEqual([`${GITHUB_COM}/users/werft-dev%5Bbot%5D`]);
    } finally {
      calls.mockRestore();
    }
  });

  test("a failure is not asked again until the retry wait passes", async () => {
    let at = 0;
    let status = 404;
    const calls = spyOn(globalThis, "fetch").mockImplementation((async () =>
      status === 200
        ? answer(200, { id: 7, login: "werft-dev[bot]" })
        : answer(status, { message: "Not Found" })) as unknown as typeof fetch);
    try {
      const botUser = createAppBotUsers({ now: () => new Date(at) });
      const app = { slug: "werft-dev", apiBase: GITHUB_COM };
      expect(await botUser(app)).toBeNull();
      expect(await botUser(app)).toBeNull();
      expect(calls.mock.calls).toHaveLength(1);
      at = 5 * 60_000;
      status = 200;
      expect(await botUser(app)).toBe("7");
      expect(calls.mock.calls).toHaveLength(2);
    } finally {
      calls.mockRestore();
    }
  });

  test("claims at once share one request; a slow GitHub is cut short, not retried", async () => {
    let answerNow: (() => void) | undefined;
    const calls = spyOn(globalThis, "fetch").mockImplementation(
      ((_url: string, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          answerNow = () => resolve(answer(200, { id: 5, login: "a[bot]" }));
          init.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        })) as unknown as typeof fetch,
    );
    try {
      const botUser = createAppBotUsers();
      const app = { slug: "a", apiBase: GITHUB_COM };
      const both = Promise.all([botUser(app), botUser(app)]);
      answerNow?.();
      expect(await both).toEqual(["5", "5"]);
      expect(calls.mock.calls).toHaveLength(1);

      const slow = createAppBotUsers({ timeoutMs: 20 });
      const started = Date.now();
      expect(await slow({ slug: "b", apiBase: GITHUB_COM })).toBeNull();
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(calls.mock.calls).toHaveLength(2);
    } finally {
      calls.mockRestore();
    }
  });

  test("a login other than the App's bot is no answer", async () => {
    const calls = spyOn(globalThis, "fetch").mockImplementation((async () =>
      answer(200, { id: 9, login: "someone" })) as unknown as typeof fetch);
    try {
      expect(
        await createAppBotUsers()({ slug: "werft-dev", apiBase: GITHUB_COM }),
      ).toBeNull();
    } finally {
      calls.mockRestore();
    }
  });

  test("names no bot off github.com, without asking", async () => {
    const calls = spyOn(globalThis, "fetch");
    try {
      expect(
        await createAppBotUsers()({
          slug: "werft-dev",
          apiBase: "https://ghe.example.com/api/v3",
        }),
      ).toBeNull();
      expect(calls.mock.calls).toHaveLength(0);
    } finally {
      calls.mockRestore();
    }
  });
});
