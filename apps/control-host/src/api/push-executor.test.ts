import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GITHUB_CEILING_NONE } from "@werft-ai/contracts";
import {
  createGitHubGate,
  createPushExecutor,
  type GitHubConnections,
  type GitHubGateReceipt,
  type GitHubSessionContext,
  type PushJob,
  type PushOutcome,
  type PushRequestStore,
  repositoryBinding,
  type SessionCatalog,
} from "@werft-ai/platform";
import { releasePolicy } from "@werft-ai/platform/testing/github";
import type { AttributionExpectation } from "@werft-ai/runtime-core";
import {
  DEFAULT_MAX_GIT_MEMORY_BYTES,
  defaultGitRunner,
  type GitCommandOptions,
  type GitCommandRunner,
} from "@werft-ai/storage";
import {
  createGitBundleChain,
  type FakeGitHub,
  type GitBundleFixture,
  startFakeGitHub,
} from "@werft-ai/testkit";
import { connectionsOf } from "./forge-github.ts";
import {
  createGitPusher,
  parseLsRemote,
  workflowsPermissionRefused,
} from "./git-push.ts";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keys.privateKey
  .export({ type: "pkcs1", format: "pem" })
  .toString();
const publicKey = keys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();

let github: FakeGitHub;
let chain: { base: GitBundleFixture; tip: GitBundleFixture };
let tempRoot: string;

beforeAll(async () => {
  github = await startFakeGitHub({ appId: 101, publicKey });
  await github.createRepository("acme", "app", { "README.md": "hello\n" });
  await github.createRepository("acme", "other", { "README.md": "no\n" });
  chain = await createGitBundleChain();
  // A checkpoint builds on the repository it was cloned from.
  await github.seedBranch("acme", "app", "main", chain.base);
  tempRoot = await mkdtemp(join(tmpdir(), "push-executor-test-"));
});
afterAll(async () => {
  await github.stop();
  await rm(tempRoot, { force: true, recursive: true });
});

function appRepository(
  name = "app",
  url = `${github.origin}/acme/${name}.git`,
) {
  return {
    url,
    branch: "main",
    profiles: ["default"],
    auth: {
      kind: "github_app" as const,
      app_id: 101,
      installation_id: 202,
      api_base: github.origin,
      value: privateKey,
      ref: { value_env: "GITHUB_APP_PRIVATE_KEY" },
    },
  };
}

function catalogOf(
  repositories: SessionCatalog["repositories"],
): SessionCatalog {
  return { profiles: {}, repositories };
}

let sessions = 0;
function jobFor(
  catalog: SessionCatalog,
  repositoryId: string,
  overrides: Partial<PushJob> = {},
): PushJob {
  sessions += 1;
  const sessionId = `00000000-0000-4000-8000-${String(sessions).padStart(12, "0")}`;
  const entry = catalog.repositories[repositoryId];
  return {
    id: crypto.randomUUID(),
    ownerId: "owner-a",
    sessionId,
    repositoryId,
    repositoryBinding: entry ? repositoryBinding(repositoryId, entry) : null,
    checkpointRevision: 2,
    gitCommit: chain.tip.commit,
    targetBranch: `agent/${sessionId}`,
    attempt: 1,
    ...overrides,
  };
}

type Run = {
  outcome: PushOutcome | undefined;
  argv: string[][];
  gitOptions: GitCommandOptions[];
  credentialFiles: string[];
  logged: string[];
  receipts: GitHubGateReceipt[];
};

async function run(
  catalog: SessionCatalog,
  job: PushJob,
  options: {
    bundles?: readonly GitBundleFixture[];
    connections?: GitHubConnections;
    leaseMs?: number;
    /** Absent: a session with no agent or release, as before the gate. */
    release?: GitHubSessionContext["release"];
    policy?: GitHubSessionContext["policy"];
    /** The porcelain output of a `git push` that fails instead of running. */
    pushRefusedWith?: string;
    /** What the session's claims issued; absent, the ledger is empty. */
    issued?: AttributionExpectation[];
  } = {},
): Promise<Run> {
  const finished: PushOutcome[] = [];
  const receipts: GitHubGateReceipt[] = [];
  const gate = createGitHubGate({
    catalog,
    connections: options.connections ?? connectionsOf(catalog),
    store: {
      context: async (sessionId) => ({
        ownerId: job.ownerId,
        sessionId,
        repositoryId: job.repositoryId,
        profileId: null,
        attachedRepositoryIds: null,
        // The executor checks the job's binding itself; the gate sees the
        // entry as pinned.
        repository: Object.hasOwn(catalog.repositories, job.repositoryId)
          ? {
              url: catalog.repositories[job.repositoryId]?.url ?? "",
              branch: catalog.repositories[job.repositoryId]?.branch ?? "",
            }
          : null,
        startedBy: null,
        agent: null,
        release: options.release ?? null,
        policy: options.policy ?? releasePolicy(null),
        ceiling: GITHUB_CEILING_NONE,
        repositoryCeiling: null,
        ceilingRevision: 0,
      }),
      findDispatch: async () => null,
      recordReceipt: async (receipt) => {
        receipts.push(receipt);
        return crypto.randomUUID();
      },
    },
  });
  const store = {
    claimNextApproved: async () => job,
    finish: async (_job: PushJob, outcome: PushOutcome) => {
      finished.push(outcome);
      return true;
    },
  } as unknown as PushRequestStore;
  const argv: string[][] = [];
  const recorded: GitCommandOptions[] = [];
  const credentialFiles: string[] = [];
  const logged: string[] = [];
  const recording: GitCommandRunner = async (args, gitOptions) => {
    argv.push([...args]);
    recorded.push(gitOptions);
    if (gitOptions.cwd !== undefined) {
      credentialFiles.push(...(await credentialsUnder(gitOptions.cwd)));
    }
    if (options.pushRefusedWith !== undefined && args.includes("push")) {
      return { exitCode: 1, stdout: options.pushRefusedWith, stderr: "" };
    }
    return defaultGitRunner(args, gitOptions);
  };
  const executor = createPushExecutor({
    store,
    catalog,
    gate,
    bundles: {
      async spoolPushBundles({ directory }) {
        const files: string[] = [];
        for (const [index, bundle] of (
          options.bundles ?? [chain.base, chain.tip]
        ).entries()) {
          const path = join(directory, `push-${index}.bundle`);
          await writeFile(path, bundle.bytes);
          files.push(path);
        }
        return { status: "ready", files };
      },
    },
    pusher: createGitPusher({ gitRunner: recording }),
    attributions: {
      record: async () => {},
      recordTurnCoAuthor: async () => {},
      list: async () => options.issued ?? [],
    },
    logger: {
      info: (message, fields) =>
        logged.push(JSON.stringify({ message, fields })),
      warn: (message, fields) =>
        logged.push(JSON.stringify({ message, fields })),
    },
    tempRoot,
    ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
  });
  expect(await executor.runOnce()).toBe(true);
  return {
    outcome: finished[0],
    argv,
    gitOptions: recorded,
    credentialFiles,
    logged,
    receipts,
  };
}

async function credentialsUnder(directory: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const text = (await readFile(path)).toString("latin1");
    if (/ghs_|pat-value|eC1hY2Nlc3Mt|cHVzaC1ib3Q6|extraheader/i.test(text)) {
      found.push(path);
    }
  }
  return found;
}

function expectNoCredentialIn(result: Run) {
  expect(result.credentialFiles).toEqual([]);
  for (const line of result.logged) {
    expect(line).not.toMatch(/ghs_|pat-value|authorization/i);
  }
  for (const args of result.argv) {
    expect(args.join(" ")).not.toMatch(/ghs_|pat-value|authorization/i);
  }
}

describe("the platform's push", () => {
  test("pushes the pinned commit to agent/<session-id> with a write token for that one repository", async () => {
    const catalog = catalogOf({ app: appRepository() });
    const job = jobFor(catalog, "app");
    const tokensBefore = github.tokenRequests.length;
    const result = await run(catalog, job);
    expect(result.outcome).toEqual({
      state: "pushed",
      remoteUrl: `${github.origin}/acme/app.git`,
      remoteRef: `refs/heads/${job.targetBranch}`,
      previousCommit: null,
    });
    expect(
      (await github.refs("acme", "app"))[`refs/heads/${job.targetBranch}`],
    ).toBe(chain.tip.commit);
    const writes = github.tokenRequests
      .slice(tokensBefore)
      .filter(
        (request) =>
          (request.body as { permissions?: { contents?: string } }).permissions
            ?.contents === "write",
      );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body).toEqual({
      repositories: ["app"],
      permissions: { contents: "write" },
    });
    const refs = await github.refs("acme", "app");
    expect(Object.keys(refs).sort()).toEqual(
      ["refs/heads/main", `refs/heads/${job.targetBranch}`].sort(),
    );
    expectNoCredentialIn(result);
    expect(await readdir(tempRoot)).toEqual([]);
    expect(result.receipts).toMatchObject([
      {
        operation: "mint_github_token",
        status: "succeeded",
        actor: null,
        result: {
          session_id: job.sessionId,
          repository_id: "app",
          purpose: "push",
          role: "author",
          app_id: 101,
          permissions: { contents: "write" },
        },
      },
    ]);
  });

  test("the same commit already on the remote ends as pushed, and a descendant fast-forwards", async () => {
    const catalog = catalogOf({ app: appRepository() });
    const first = jobFor(catalog, "app", { gitCommit: chain.base.commit });
    expect(
      (await run(catalog, first, { bundles: [chain.base] })).outcome,
    ).toMatchObject({ state: "pushed", previousCommit: null });
    expect(
      (await run(catalog, { ...first, attempt: 2 }, { bundles: [chain.base] }))
        .outcome,
    ).toMatchObject({ state: "pushed", previousCommit: chain.base.commit });
    expect(
      (
        await run(catalog, {
          ...first,
          gitCommit: chain.tip.commit,
          attempt: 1,
        })
      ).outcome,
    ).toMatchObject({ state: "pushed", previousCommit: chain.base.commit });
  });

  test("never force-pushes: a remote branch the commit does not build on is refused", async () => {
    const catalog = catalogOf({ app: appRepository() });
    const job = jobFor(catalog, "app");
    const unrelated = await github.writeUnrelatedCommit(
      "acme",
      "app",
      job.targetBranch,
    );
    const pushesBefore = github.gitRequests.filter(
      (request) => request.push && request.method === "POST",
    ).length;
    expect((await run(catalog, job)).outcome).toEqual({
      state: "failed",
      refusal: "non_fast_forward",
      remoteUrl: `${github.origin}/acme/app.git`,
      remoteRef: `refs/heads/${job.targetBranch}`,
    });
    expect(
      (await github.refs("acme", "app"))[`refs/heads/${job.targetBranch}`],
    ).toBe(unrelated);
    expect(
      github.gitRequests.filter(
        (request) => request.push && request.method === "POST",
      ).length,
    ).toBe(pushesBefore);
  });

  test("a new branch whose commit shares no history with the remote's HEAD is refused as unrelated_history", async () => {
    // acme/other was never cloned into the checkpoint: its content is not
    // what the bundles carry.
    const catalog = catalogOf({ other: appRepository("other") });
    const job = jobFor(catalog, "other");
    const pushesBefore = github.gitRequests.filter(
      (request) => request.push && request.method === "POST",
    ).length;
    expect((await run(catalog, job)).outcome).toEqual({
      state: "failed",
      refusal: "unrelated_history",
      remoteUrl: `${github.origin}/acme/other.git`,
      remoteRef: `refs/heads/${job.targetBranch}`,
    });
    expect(
      (await github.refs("acme", "other"))[`refs/heads/${job.targetBranch}`],
    ).toBeUndefined();
    expect(
      github.gitRequests.filter(
        (request) => request.push && request.method === "POST",
      ).length,
    ).toBe(pushesBefore);
    expect(await readdir(tempRoot)).toEqual([]);
  });

  test("pushes to the session's suffixed branch, and only to a branch of its own", async () => {
    const catalog = catalogOf({ app: appRepository() });
    const base = jobFor(catalog, "app");
    const suffixed = { ...base, targetBranch: `${base.targetBranch}-docs-fix` };
    expect((await run(catalog, suffixed)).outcome).toMatchObject({
      state: "pushed",
      remoteRef: `refs/heads/${suffixed.targetBranch}`,
    });
    for (const targetBranch of [
      `${base.targetBranch}/nested`,
      `${base.targetBranch}-Upper`,
      `agent/00000000-0000-4000-8000-999999999999-docs`,
    ]) {
      expect(
        (await run(catalog, { ...base, targetBranch })).outcome,
      ).toMatchObject({ state: "failed", refusal: "target_refused" });
    }
  });

  test("refuses the repository's default branch, by the catalog and by the remote", async () => {
    const byCatalog = catalogOf({ app: appRepository() });
    const pinned = jobFor(byCatalog, "app");
    const catalogBranch = catalogOf({
      app: { ...appRepository(), branch: pinned.targetBranch },
    });
    expect(
      (
        await run(catalogBranch, {
          ...pinned,
          repositoryBinding: repositoryBinding(
            "app",
            catalogBranch.repositories
              .app as SessionCatalog["repositories"][string],
          ),
        })
      ).outcome,
    ).toMatchObject({ state: "failed", refusal: "default_branch" });

    const sessionId = "00000000-0000-4000-8000-0000000000ff";
    await github.createRepository(
      "acme",
      "odd",
      { "README.md": "odd\n" },
      {
        branch: `agent/${sessionId}`,
      },
    );
    const odd = catalogOf({ odd: appRepository("odd") });
    expect(
      (
        await run(
          odd,
          jobFor(odd, "odd", {
            sessionId,
            targetBranch: `agent/${sessionId}`,
          }),
        )
      ).outcome,
    ).toMatchObject({ state: "failed", refusal: "default_branch" });
    expect(
      (await github.refs("acme", "odd"))[`refs/heads/agent/${sessionId}`],
    ).not.toBe(chain.tip.commit);
  });

  test("refuses any target but agent/<session-id>", async () => {
    const catalog = catalogOf({ app: appRepository() });
    for (const targetBranch of ["main", "feature/x", "agent/someone-else"]) {
      expect(
        (await run(catalog, jobFor(catalog, "app", { targetBranch }))).outcome,
      ).toMatchObject({ state: "failed", refusal: "target_refused" });
    }
  });

  test("a catalog entry changed after the request is refused before anything reaches the forge", async () => {
    const pinned = catalogOf({ app: appRepository() });
    const job = jobFor(pinned, "app");
    const gitBefore = github.gitRequests.length;
    const tokensBefore = github.tokenRequests.length;
    for (const changed of [
      catalogOf({
        app: appRepository("app", `${github.origin}/acme/other.git`),
      }),
      catalogOf({
        app: {
          ...appRepository(),
          auth: { ...appRepository().auth, ref: { value_env: "OTHER_KEY" } },
        },
      }),
      catalogOf({ other: appRepository("other") }),
    ]) {
      expect((await run(changed, job)).outcome).toEqual({
        state: "failed",
        refusal: "catalog_changed",
      });
    }
    expect(
      (await run(pinned, { ...job, repositoryBinding: null })).outcome,
    ).toMatchObject({ refusal: "catalog_changed" });
    expect(github.gitRequests.length).toBe(gitBefore);
    expect(github.tokenRequests.length).toBe(tokensBefore);
  });

  test("a session whose release carries GitHub settings the gate cannot read is failed before a token is asked for", async () => {
    const catalog = catalogOf({ app: appRepository() });
    const job = jobFor(catalog, "app");
    const gitBefore = github.gitRequests.length;
    const tokensBefore = github.tokenRequests.length;
    const result = await run(catalog, job, {
      release: { id: crypto.randomUUID() },
      policy: releasePolicy("invalid"),
    });
    expect(result.outcome).toEqual({
      state: "failed",
      refusal: "github_refused",
      reasonCode: "github_settings_unsupported",
      remoteUrl: `${github.origin}/acme/app.git`,
      remoteRef: `refs/heads/${job.targetBranch}`,
    });
    expect(result.receipts).toMatchObject([
      {
        operation: "mint_github_token",
        status: "failed",
        actor: null,
        result: { purpose: "push", reason_code: "github_settings_unsupported" },
        error: { code: "GITHUB_REFUSED" },
      },
    ]);
    expect(result.argv).toEqual([]);
    expect(github.gitRequests.length).toBe(gitBefore);
    expect(github.tokenRequests.length).toBe(tokensBefore);
  });

  test("a workflow change GitHub refuses for want of the workflows permission says so in the outcome", async () => {
    const catalog = catalogOf({ app: appRepository() });
    const job = jobFor(catalog, "app");
    const remoteRef = `refs/heads/${job.targetBranch}`;
    const result = await run(catalog, job, {
      pushRefusedWith: `To ${github.origin}/acme/app.git\n!\t${job.gitCommit}:${remoteRef}\t[remote rejected] (refusing to allow a GitHub App to create or update workflow \`.github/workflows/x.yml\` without \`workflows\` permission)\nDone\n`,
    });
    expect(result.outcome).toEqual({
      state: "failed",
      refusal: "push_failed",
      reasonCode: "workflows_permission_missing",
      remoteUrl: `${github.origin}/acme/app.git`,
      remoteRef,
    });
    // GitHub's own text is not passed on.
    expect(result.logged.join("\n")).not.toContain(".github/workflows/x.yml");

    const ordinary = await run(catalog, jobFor(catalog, "app"), {
      pushRefusedWith: `!\t${job.gitCommit}:${remoteRef}\t[remote rejected] (pre-receive hook declined)\n`,
    });
    expect(ordinary.outcome).toEqual({
      state: "failed",
      refusal: "push_failed",
      remoteUrl: `${github.origin}/acme/app.git`,
      remoteRef: expect.any(String),
    });
  });

  test("a request taken up too many times is failed without pushing", async () => {
    const catalog = catalogOf({ app: appRepository() });
    const gitBefore = github.gitRequests.length;
    expect(
      (await run(catalog, jobFor(catalog, "app", { attempt: 4 }))).outcome,
    ).toEqual({ state: "failed", refusal: "lease_expired" });
    expect(github.gitRequests.length).toBe(gitBefore);
  });

  test("a token the forge would not issue fails the push and says nothing of why in the outcome", async () => {
    const catalog = catalogOf({ app: appRepository() });
    const uncached = connectionsOf(catalog, { retryAfterBaseMs: 1 });
    github.failTokens(true);
    try {
      const result = await run(catalog, jobFor(catalog, "app"), {
        connections: uncached,
      });
      expect(result.outcome).toEqual({
        state: "failed",
        refusal: "push_failed",
      });
      expect(result.logged.some((line) => line.includes("Push failed"))).toBe(
        true,
      );
      expectNoCredentialIn(result);
    } finally {
      github.failTokens(false);
    }
  });

  test("an App repository with no connection is not pushed to", async () => {
    const catalog = catalogOf({ app: appRepository() });
    const result = await run(catalog, jobFor(catalog, "app"), {
      connections: () => null,
    });
    expect(result.outcome).toMatchObject({
      state: "failed",
      refusal: "no_push_credential",
    });
  });

  test("every git runs under resource limits and is cut off before the lease runs out", async () => {
    const catalog = catalogOf({ app: appRepository() });
    const leaseMs = 60_000;
    const startedAt = Date.now();
    const result = await run(catalog, jobFor(catalog, "app"), { leaseMs });
    expect(result.outcome).toMatchObject({ state: "pushed" });
    expect(result.gitOptions.length).toBeGreaterThan(0);
    const chainBytes = chain.base.bytes.length + chain.tip.bytes.length;
    for (const options of result.gitOptions) {
      expect(options.limits?.memoryBytes).toBe(DEFAULT_MAX_GIT_MEMORY_BYTES);
      expect(options.limits?.fileSizeBytes).toBeGreaterThan(chainBytes);
      expect(options.timeoutMs).toBeLessThanOrEqual(leaseMs * 0.8);
    }
    expect(Date.now() - startedAt).toBeLessThan(leaseMs * 0.8);
  });

  test("a push whose deadline has passed starts no git and fails", async () => {
    const catalog = catalogOf({ app: appRepository() });
    const gitBefore = github.gitRequests.length;
    const result = await run(catalog, jobFor(catalog, "app"), { leaseMs: 1 });
    expect(result.outcome).toEqual({ state: "failed", refusal: "push_failed" });
    expect(result.argv).toEqual([]);
    expect(github.gitRequests.length).toBe(gitBefore);
  });

  test("a bundle chain without the pinned commit fails the push", async () => {
    const catalog = catalogOf({ app: appRepository() });
    expect(
      (await run(catalog, jobFor(catalog, "app"), { bundles: [chain.base] }))
        .outcome,
    ).toMatchObject({ state: "failed", refusal: "push_failed" });
  });
});

describe("the push's attribution check", () => {
  // The bundles' commits are by Testkit with no trailers. `base` is on the
  // remote's main already; `tip` is the one new commit.
  const testkit = { name: "Testkit", email: "testkit@example.invalid" };
  const matching: AttributionExpectation = {
    author: testkit,
    coAuthor: null,
    agentSession: null,
  };
  const wrong: AttributionExpectation = {
    author: {
      name: "werft[bot]",
      email: "1+werft[bot]@users.noreply.github.com",
    },
    coAuthor: null,
    agentSession: null,
  };

  test("a new commit that matches an issued bundle is pushed", async () => {
    const catalog = catalogOf({ app: appRepository() });
    const result = await run(catalog, jobFor(catalog, "app"), {
      issued: [matching],
    });
    expect(result.outcome).toMatchObject({ state: "pushed" });
  });

  test("a commit with the wrong author is refused with its details and nothing reaches the remote", async () => {
    const catalog = catalogOf({ app: appRepository() });
    const job = jobFor(catalog, "app");
    const before = github.gitRequests.filter(
      (request) => request.push && request.method === "POST",
    ).length;
    const result = await run(catalog, job, { issued: [wrong] });
    expect(result.outcome).toEqual({
      state: "failed",
      refusal: "attribution_mismatch",
      remoteUrl: `${github.origin}/acme/app.git`,
      remoteRef: `refs/heads/${job.targetBranch}`,
      mismatches: [
        { commit: chain.tip.commit, problems: ["author", "committer"] },
      ],
    });
    expect(
      (await github.refs("acme", "app"))[`refs/heads/${job.targetBranch}`],
    ).toBeUndefined();
    expect(
      github.gitRequests.filter(
        (request) => request.push && request.method === "POST",
      ).length,
    ).toBe(before);
  });

  test("any one of the session's issued bundles passes a commit", async () => {
    const catalog = catalogOf({ app: appRepository() });
    const result = await run(catalog, jobFor(catalog, "app"), {
      issued: [wrong, matching],
    });
    expect(result.outcome).toMatchObject({ state: "pushed" });
  });

  test("a base branch the check cannot use refuses the push instead of switching the check off", async () => {
    const catalog = catalogOf({
      app: { ...appRepository(), branch: "topic./child" },
    });
    const job = jobFor(catalog, "app");
    const result = await run(catalog, job, { issued: [matching] });
    expect(result.outcome).toMatchObject({
      state: "failed",
      refusal: "attribution_mismatch",
    });
    expect(
      (await github.refs("acme", "app"))[`refs/heads/${job.targetBranch}`],
    ).toBeUndefined();
  });

  test("a session with no issued bundle is not checked", async () => {
    const catalog = catalogOf({ app: appRepository() });
    const result = await run(catalog, jobFor(catalog, "app"), { issued: [] });
    expect(result.outcome).toMatchObject({ state: "pushed" });
  });

  test("commits already on the base branch are not the session's to vouch for", async () => {
    // `base` is main's tip: the range is empty, so a wrong bundle cannot fail it.
    const catalog = catalogOf({ app: appRepository() });
    const job = jobFor(catalog, "app", { gitCommit: chain.base.commit });
    const result = await run(catalog, job, {
      bundles: [chain.base],
      issued: [wrong],
    });
    expect(result.outcome).toMatchObject({ state: "pushed" });
  });

  test("a later push is judged on what the target does not hold yet", async () => {
    const catalog = catalogOf({ app: appRepository() });
    const first = jobFor(catalog, "app", { gitCommit: chain.base.commit });
    await run(catalog, first, { bundles: [chain.base], issued: [wrong] });
    // The target holds `base`; only `tip` is new, and `tip` is wrong.
    const refused = await run(
      catalog,
      { ...first, gitCommit: chain.tip.commit },
      { issued: [wrong] },
    );
    expect(refused.outcome).toMatchObject({
      state: "failed",
      refusal: "attribution_mismatch",
      mismatches: [{ commit: chain.tip.commit }],
    });
    const pushed = await run(
      catalog,
      { ...first, gitCommit: chain.tip.commit },
      { issued: [matching] },
    );
    expect(pushed.outcome).toMatchObject({
      state: "pushed",
      previousCommit: chain.base.commit,
    });
  });
});

describe("parseLsRemote", () => {
  test("reads HEAD's symref and each ref's commit", () => {
    const sha = "c".repeat(40);
    expect(
      parseLsRemote(
        `ref: refs/heads/main\tHEAD\n${sha}\tHEAD\n${sha}\trefs/heads/agent/x\n`,
      ),
    ).toEqual({
      head: "refs/heads/main",
      refs: new Map([
        ["HEAD", sha],
        ["refs/heads/agent/x", sha],
      ]),
    });
  });
});

describe("workflowsPermissionRefused", () => {
  const ref = "refs/heads/agent/x";
  test("reads GitHub's refusal of a workflow change without the workflows permission", () => {
    expect(
      workflowsPermissionRefused(
        `To https://github.com/acme/app.git\n!\t${"c".repeat(40)}:${ref}\t[remote rejected] (refusing to allow a GitHub App to create or update workflow \`.github/workflows/x.yml\` without \`workflows\` permission)\nDone\n`,
      ),
    ).toBe(true);
  });

  test("an ordinary rejection is not one", () => {
    for (const stdout of [
      `!\t${"c".repeat(40)}:${ref}\t[rejected] (non-fast-forward)\n`,
      `!\t${"c".repeat(40)}:${ref}\t[remote rejected] (pre-receive hook declined)\n`,
      // The phrase alone, outside a refused ref's line, is not GitHub's.
      `=\t${ref}\t[up to date]\nwithout \`workflows\` permission\n`,
      "",
    ]) {
      expect(workflowsPermissionRefused(stdout)).toBe(false);
    }
  });
});
