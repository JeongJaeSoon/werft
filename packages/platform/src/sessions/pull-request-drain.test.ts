import { describe, expect, test } from "bun:test";
import { DEFAULT_PULL_REQUEST_SETTINGS } from "@werft-ai/contracts";
import { createAuthorizationPolicy } from "../musterrolle/policy.ts";
import type { ForgePullRequestWithBody } from "../ports/forge.ts";
import { ForgeCredentialError } from "../ports/forge.ts";
import {
  type GitHubApi,
  type GitHubGate,
  GitHubGateError,
} from "../ports/github-gate.ts";
import {
  PULL_REQUEST_MAX_ATTEMPTS,
  type PullRequestDrainOutcome,
  type PullRequestDrainStore,
  type PullRequestJob,
  type PullRequestSettled,
  pullRequestBackoffMs,
} from "../ports/pull-request-drain.ts";
import {
  type FakeFile,
  fakeRepositoryReads,
} from "../testing/repository-tree-fake.ts";
import { repositoryBinding, type SessionCatalog } from "./catalog.ts";
import { pushRequestMarker, pushRequestMarkerOf } from "./git-attribution.ts";
import { createPullRequestDrain } from "./pull-request-drain.ts";
import { createPullRequestService } from "./pull-request-service.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const PUSH = "22222222-2222-4222-8222-222222222222";
const HEAD = `agent/${SESSION}`;
const COMMIT = "a".repeat(40);
const CATALOG = {
  profiles: {},
  repositories: {
    app: {
      url: "https://github.com/acme/app.git",
      branch: "develop",
      profiles: ["default"],
      auth: { kind: "github_app", registered: true },
    },
  },
} satisfies SessionCatalog;

function job(overrides: Partial<PullRequestJob> = {}): PullRequestJob {
  return {
    id: PUSH,
    ownerId: "owner-a",
    sessionId: SESSION,
    repositoryId: "app",
    repositoryBinding: repositoryBinding("app", CATALOG.repositories.app),
    targetBranch: HEAD,
    gitCommit: COMMIT,
    intent: { title: "Add the thing", summary: "What changed." },
    claimToken: "token-1",
    attempt: 1,
    leaseExpiresAt: new Date(Date.now() + 300_000),
    ...overrides,
  };
}

function listed(
  overrides: Partial<ForgePullRequestWithBody> = {},
): ForgePullRequestWithBody {
  return {
    number: 7,
    url: "https://github.com/acme/app/pull/7",
    state: "open",
    head: HEAD,
    headSha: COMMIT,
    base: "develop",
    mergedAt: null,
    closedAt: null,
    body: "",
    headRepository: "acme/app",
    ...overrides,
  };
}

function harness(
  options: {
    existing?: ForgePullRequestWithBody[];
    /** The commit a created pull request reports as its head. */
    createdHeadSha?: string;
    /** The base a created pull request reports, when it is not the asked one. */
    createdBase?: string;
    /** Commits the compare answers are ancestors of the pushed commit. */
    ancestors?: string[];
    compareFails?: boolean;
    lookupFails?: boolean;
    createFails?: boolean;
    refuse?: boolean;
    /** The repository's files; a template among them is read for the body. */
    files?: Record<string, FakeFile>;
    /** How long the template read takes before it answers. */
    readDelayMs?: number;
  } = {},
) {
  const calls: string[] = [];
  const created: Array<{ head: string; base: string; body: string }> = [];
  const tails: string[] = [];
  const unused = async (): Promise<never> => {
    throw new Error("not used");
  };
  const repository = fakeRepositoryReads(options.files ?? {}).reads;
  const forge: GitHubApi = {
    maxBodyLength: 65_536,
    ...repository,
    getRepository: async () => {
      calls.push("template read");
      if (options.readDelayMs !== undefined) {
        await new Promise((resolve) =>
          setTimeout(resolve, options.readDelayMs),
        );
      }
      return repository.getRepository();
    },
    getPullRequest: unused,
    setPullRequestState: unused,
    mergePullRequest: unused,
    upsertComment: unused,
    dispatchWorkflow: unused,
    getWorkflowRun: unused,
    rerunWorkflow: unused,
    submitReview: unused,
    findPullRequestForBranch: unused,
    findPullRequestsForBranch: async (branch) => {
      calls.push(`list ${branch}`);
      if (options.lookupFails) throw new ForgeCredentialError("lookup (502)");
      return options.existing ?? [];
    },
    isAncestor: async (ancestor, descendant) => {
      calls.push(`compare ${ancestor.slice(0, 1)}..${descendant.slice(0, 1)}`);
      if (options.compareFails) throw new ForgeCredentialError("compare (502)");
      return (options.ancestors ?? []).includes(ancestor);
    },
    createPullRequest: async (input) => {
      calls.push(`create ${input.head}`);
      if (options.createFails) throw new ForgeCredentialError("create (502)");
      created.push(input);
      return {
        number: 8,
        url: "https://github.com/acme/app/pull/8",
        state: "open",
        head: input.head,
        headSha: options.createdHeadSha ?? COMMIT,
        base: options.createdBase ?? input.base,
        mergedAt: null,
        closedAt: null,
        created: true,
      };
    },
    updatePullRequestBody: async (number, edit) => {
      calls.push(`tail ${number}`);
      tails.push(edit(""));
    },
  };
  const gate: GitHubGate = {
    grant: async (work) => {
      calls.push(`grant ${work.purpose}`);
      if (options.refuse) throw new GitHubGateError("github_disabled", "r-1");
      return {
        role: "author",
        repo: { owner: "acme", name: "app" },
        permissions: { contents: "read", pull_requests: "write" },
        gitCredential: { username: "x-access-token", password: "[REDACTED]" },
        api: forge,
        unit: async () => "app:test:1",
        allowedBy: null,
        context: {
          ownerId: "owner-a",
          sessionId: work.sessionId,
          agentId: null,
          agentReleaseId: null,
          repositoryId: "app",
          policy: {},
        },
      };
    },
  };
  const service = createPullRequestService({
    authorization: createAuthorizationPolicy({
      sessions: { visibleTo: async () => true, originOf: async () => null },
    }),
    store: {} as never,
    catalog: CATALOG,
    gate,
    redact: (line) => line,
    attribution: { attribution: async () => null },
    settings: {
      get: async () => ({
        settings: DEFAULT_PULL_REQUEST_SETTINGS,
        revision: 1,
      }),
      agentOfSession: async () => null,
    },
    consoleOrigin: "https://console.example.com",
    logger: { warn: () => {} },
  });
  return { service, calls, created, tails };
}

const deadline = () => Date.now() + 60_000;
const TEMPLATE_PATH = ".github/pull_request_template.md";

describe("opening a pull request for a pushed request", () => {
  test("creates one carrying the marker, after looking the branch up in every state", async () => {
    const { service, calls, created } = harness();
    const outcome = await service.openForPushRequest(job(), {
      deadline: deadline(),
    });
    expect(outcome).toMatchObject({
      kind: "opened",
      pullRequest: { number: 8, headSha: COMMIT, created: true },
    });
    expect(calls).toEqual([
      "grant pull_request",
      `list ${HEAD}`,
      "template read",
      `create ${HEAD}`,
    ]);
    expect(created[0]?.base).toBe("develop");
    expect(pushRequestMarkerOf(created[0]?.body ?? "")).toBe(PUSH);
  });

  test("hands back the template record of the repository template the body was laid out on", async () => {
    const { service } = harness({
      files: { [TEMPLATE_PATH]: "## Summary\n\n## Testing\n" },
    });
    const outcome = await service.openForPushRequest(job(), {
      deadline: deadline(),
    });
    expect(outcome).toMatchObject({
      kind: "opened",
      pullRequest: {
        created: true,
        template: { path: TEMPLATE_PATH },
      },
    });
  });

  test("does not create when the template read used up the lease", async () => {
    const { service, calls } = harness({
      files: { [TEMPLATE_PATH]: "## Summary\n" },
      readDelayMs: 60,
    });
    const outcome = await service.openForPushRequest(job(), {
      deadline: Date.now() + 30,
    });
    expect(outcome).toEqual({
      kind: "retry",
      error: "lease_expired",
      delayMs: 0,
    });
    expect(calls).toContain("template read");
    expect(calls.some((call) => call.startsWith("create "))).toBe(false);
  });

  // The stored row cannot say whether an earlier attempt reached the create,
  // so a lease used up before it is never turned into `failed` (a user's
  // second request would then open a second pull request): it stays a retry,
  // and the claim past the last attempt ends `uncertain`.
  for (const attempt of [2, PULL_REQUEST_MAX_ATTEMPTS]) {
    test(`a lease used up on attempt ${attempt} stays a retry, never failed`, async () => {
      const { service, calls } = harness({
        files: { [TEMPLATE_PATH]: "## Summary\n" },
        readDelayMs: 60,
      });
      const outcome = await service.openForPushRequest(job({ attempt }), {
        deadline: Date.now() + 30,
      });
      expect(outcome).toEqual({
        kind: "retry",
        error: "lease_expired",
        delayMs: 0,
      });
      expect(calls.some((call) => call.startsWith("create "))).toBe(false);
    });
  }

  test("the claim past the last attempt ends uncertain", async () => {
    const { service } = harness({});
    expect(
      await service.openForPushRequest(
        job({ attempt: PULL_REQUEST_MAX_ATTEMPTS + 1 }),
        { deadline: Date.now() + 60_000 },
      ),
    ).toEqual({ kind: "stop", stage: "uncertain", error: "lease_expired" });
  });

  test("adopts the branch's open pull request when it is at the pushed commit, and moves its tail", async () => {
    const { service, calls, tails } = harness({ existing: [listed()] });
    const outcome = await service.openForPushRequest(job(), {
      deadline: deadline(),
    });
    expect(outcome).toMatchObject({
      kind: "opened",
      pullRequest: { number: 7, created: false, title: null },
    });
    expect(calls).not.toContain(`create ${HEAD}`);
    expect(pushRequestMarkerOf(tails[0] ?? "")).toBe(PUSH);
  });

  test("an open pull request at another commit ends head_moved, with both commits", async () => {
    const { service, calls } = harness({
      existing: [listed({ headSha: "b".repeat(40) })],
    });
    expect(
      await service.openForPushRequest(job(), { deadline: deadline() }),
    ).toMatchObject({
      kind: "stop",
      stage: "failed",
      error: "head_moved",
      details: { expected_sha: COMMIT, actual_sha: "b".repeat(40) },
    });
    expect(calls).not.toContain(`create ${HEAD}`);
  });

  test("a head that is still the pushed commit's ancestor waits for the backoff instead of ending", async () => {
    const old = "b".repeat(40);
    const { service, calls } = harness({
      existing: [listed({ headSha: old })],
      ancestors: [old],
    });
    expect(
      await service.openForPushRequest(job(), { deadline: deadline() }),
    ).toMatchObject({
      kind: "retry",
      error: "head_moved",
      delayMs: pullRequestBackoffMs(1),
    });
    expect(calls).toContain("compare b..a");
    expect(calls).not.toContain(`create ${HEAD}`);
  });

  test("a pull request created at a lagging head waits, then the next claim adopts it", async () => {
    const old = "c".repeat(40);
    const { service } = harness({ createdHeadSha: old, ancestors: [old] });
    expect(
      await service.openForPushRequest(job(), { deadline: deadline() }),
    ).toMatchObject({ kind: "retry", error: "head_moved" });
  });

  test("a head that is not an ancestor ends head_moved at once", async () => {
    const { service } = harness({
      existing: [listed({ headSha: "d".repeat(40) })],
      ancestors: [],
    });
    expect(
      await service.openForPushRequest(job(), { deadline: deadline() }),
    ).toMatchObject({ kind: "stop", stage: "failed", error: "head_moved" });
  });

  test("a compare that fails closes the question as head_moved", async () => {
    const { service } = harness({
      existing: [listed({ headSha: "b".repeat(40) })],
      ancestors: ["b".repeat(40)],
      compareFails: true,
    });
    expect(
      await service.openForPushRequest(job(), { deadline: deadline() }),
    ).toMatchObject({ kind: "stop", stage: "failed", error: "head_moved" });
  });

  test("the last attempt does not ask the forge again and ends head_moved", async () => {
    const old = "b".repeat(40);
    const { service, calls } = harness({
      existing: [listed({ headSha: old })],
      ancestors: [old],
    });
    expect(
      await service.openForPushRequest(job({ attempt: 3 }), {
        deadline: deadline(),
      }),
    ).toMatchObject({ kind: "stop", stage: "failed", error: "head_moved" });
    expect(calls.some((call) => call.startsWith("compare"))).toBe(false);
  });

  test("a pull request created on the last attempt at a lagging head fails with its number, never uncertain", async () => {
    const old = "c".repeat(40);
    const { service, calls } = harness({
      createdHeadSha: old,
      ancestors: [old],
    });
    expect(
      await service.openForPushRequest(
        job({ attempt: PULL_REQUEST_MAX_ATTEMPTS }),
        { deadline: deadline() },
      ),
    ).toMatchObject({
      kind: "stop",
      stage: "failed",
      error: "head_moved",
      details: { number: 8, actual_sha: old },
    });
    expect(calls.some((call) => call.startsWith("compare"))).toBe(false);
  });

  test("a created pull request whose head is not the pushed commit is compared before it is stored", async () => {
    const { service } = harness({ createdHeadSha: "c".repeat(40) });
    expect(
      await service.openForPushRequest(job(), { deadline: deadline() }),
    ).toMatchObject({
      kind: "stop",
      stage: "failed",
      error: "head_moved",
      details: { number: 8, actual_sha: "c".repeat(40) },
    });
  });

  test("a closed pull request with this request's marker is closed_unrecorded, not created again", async () => {
    const { service, calls } = harness({
      existing: [
        listed({
          state: "closed",
          closedAt: "2026-11-05T00:00:00Z",
          body: `x\n${pushRequestMarker(PUSH)}\n`,
        }),
      ],
    });
    expect(
      await service.openForPushRequest(job(), { deadline: deadline() }),
    ).toMatchObject({
      kind: "stop",
      stage: "closed_unrecorded",
      details: { numbers: [7], merged: false },
    });
    expect(calls).not.toContain(`create ${HEAD}`);
  });

  test("a marker on a pull request from a fork, another base or another head is not this request's", async () => {
    const marked = `${pushRequestMarker(PUSH)}\n`;
    const { service, created } = harness({
      existing: [
        listed({
          state: "closed",
          body: marked,
          headRepository: "mallory/app",
        }),
        listed({ number: 5, state: "closed", body: marked, base: "main" }),
        listed({ number: 4, state: "closed", body: marked, head: "agent/x" }),
        // Closed, in this repository, but another request's marker.
        listed({
          number: 3,
          state: "closed",
          body: pushRequestMarker("33333333-3333-4333-8333-333333333333"),
        }),
      ],
    });
    expect(
      await service.openForPushRequest(job(), { deadline: deadline() }),
    ).toMatchObject({ kind: "opened", pullRequest: { number: 8 } });
    expect(created).toHaveLength(1);
  });

  test("a pull request created at a lagging head and closed before the next claim is not created again", async () => {
    const old = "c".repeat(40);
    const closed = listed({
      state: "closed",
      closedAt: "2026-11-05T00:00:00Z",
      body: `${pushRequestMarker(PUSH)}\n`,
      headSha: old,
    });
    for (const attempt of [2, 3]) {
      const { service, created } = harness({
        existing: [closed],
        ancestors: [old],
      });
      expect(
        await service.openForPushRequest(job({ attempt }), {
          deadline: deadline(),
        }),
      ).toMatchObject({
        kind: "stop",
        stage: "closed_unrecorded",
        details: { numbers: [7] },
      });
      expect(created).toHaveLength(0);
    }
  });

  test("an open pull request still at the lagging head is waited for again, never created again", async () => {
    const old = "c".repeat(40);
    const { service, created } = harness({
      existing: [
        listed({ headSha: old, body: `${pushRequestMarker(PUSH)}\n` }),
      ],
      ancestors: [old],
    });
    expect(
      await service.openForPushRequest(job({ attempt: 2 }), {
        deadline: deadline(),
      }),
    ).toMatchObject({ kind: "retry", error: "head_moved" });
    expect(created).toHaveLength(0);
  });

  test("a closed pull request with this request's marker but another commit does not end the stage", async () => {
    const { service, created } = harness({
      existing: [
        listed({
          state: "closed",
          body: `${pushRequestMarker(PUSH)}\n`,
          headSha: "e".repeat(40),
        }),
      ],
    });
    expect(
      await service.openForPushRequest(job(), { deadline: deadline() }),
    ).toMatchObject({ kind: "opened", pullRequest: { number: 8 } });
    expect(created).toHaveLength(1);
  });

  test("a created pull request that the forge answered with another base is not adopted", async () => {
    const { service } = harness({ createdBase: "main" });
    expect(
      await service.openForPushRequest(job(), { deadline: deadline() }),
    ).toMatchObject({
      kind: "stop",
      stage: "uncertain",
      error: "duplicate_pull_request",
      details: { numbers: [8] },
    });
  });

  test("two open candidates are never guessed between", async () => {
    const { service } = harness({
      existing: [listed(), listed({ number: 9 })],
    });
    expect(
      await service.openForPushRequest(job(), { deadline: deadline() }),
    ).toMatchObject({
      kind: "stop",
      stage: "uncertain",
      error: "duplicate_pull_request",
      details: { numbers: [7, 9] },
    });
  });

  test("a full page of branch pull requests is left uncertain instead of read as complete", async () => {
    const { service, calls } = harness({
      existing: Array.from({ length: 10 }, (_, index) =>
        listed({ number: 100 + index, state: "closed", base: "other" }),
      ),
    });
    expect(
      await service.openForPushRequest(job(), { deadline: deadline() }),
    ).toMatchObject({
      kind: "stop",
      stage: "uncertain",
      error: "lookup_failed",
      details: { limit: 10 },
    });
    expect(calls.filter((call) => call.startsWith("create"))).toEqual([]);
  });

  test("a failed lookup is asked again, and left uncertain at the last attempt", async () => {
    const { service, calls } = harness({ lookupFails: true });
    expect(
      await service.openForPushRequest(job(), { deadline: deadline() }),
    ).toMatchObject({ kind: "retry", error: "lookup_failed" });
    expect(
      await service.openForPushRequest(
        job({ attempt: PULL_REQUEST_MAX_ATTEMPTS }),
        { deadline: deadline() },
      ),
    ).toMatchObject({
      kind: "stop",
      stage: "uncertain",
      error: "lookup_failed",
    });
    expect(calls.filter((call) => call.startsWith("create"))).toEqual([]);
  });

  test("a create that may have been taken is retried after a lookup, not assumed lost", async () => {
    const { service } = harness({ createFails: true });
    expect(
      await service.openForPushRequest(job(), { deadline: deadline() }),
    ).toMatchObject({ kind: "retry", error: "forge_failed" });
  });

  test("with the lease nearly gone, no pull request is created", async () => {
    const { service, calls } = harness();
    expect(
      await service.openForPushRequest(job(), { deadline: Date.now() - 1 }),
    ).toMatchObject({ kind: "retry", error: "lease_expired" });
    expect(calls).not.toContain(`create ${HEAD}`);
  });

  test("a gate refusal ends the stage; a changed catalog entry never reaches the forge", async () => {
    const refused = harness({ refuse: true });
    expect(
      await refused.service.openForPushRequest(job(), {
        deadline: deadline(),
      }),
    ).toMatchObject({ kind: "stop", error: "github_refused" });
    const changed = harness();
    expect(
      await changed.service.openForPushRequest(
        job({ repositoryBinding: "stale" }),
        { deadline: deadline() },
      ),
    ).toMatchObject({ kind: "stop", error: "catalog_changed" });
    expect(changed.calls).toEqual([]);
  });

  test("a stage claimed more times than allowed is left uncertain without a forge call", async () => {
    const { service, calls } = harness();
    expect(
      await service.openForPushRequest(
        job({ attempt: PULL_REQUEST_MAX_ATTEMPTS + 1 }),
        { deadline: deadline() },
      ),
    ).toMatchObject({ stage: "uncertain", error: "lease_expired" });
    expect(calls).toEqual([]);
  });
});

function memoryStore(jobs: PullRequestJob[]) {
  const settled: Array<{
    job: PullRequestJob;
    outcome: PullRequestDrainOutcome;
  }> = [];
  let live = new Set(jobs.map((entry) => entry.claimToken));
  const store: PullRequestDrainStore = {
    claimNextDue: async () => jobs.shift() ?? null,
    settle: async (claimed, outcome): Promise<PullRequestSettled> => {
      if (!live.has(claimed.claimToken)) return { result: "fenced" };
      settled.push({ job: claimed, outcome });
      return { result: "settled" };
    },
  };
  return {
    store,
    settled,
    revoke: (token: string) => {
      live = new Set([...live].filter((entry) => entry !== token));
    },
  };
}

describe("the pull request drain", () => {
  const logger = { info: () => {}, warn: () => {} };

  test("settles each claimed stage with what the opener decided, until none is due", async () => {
    const { store, settled } = memoryStore([job(), job({ claimToken: "t2" })]);
    const drain = createPullRequestDrain({
      store,
      logger,
      opener: {
        openForPushRequest: async () => ({
          kind: "retry",
          error: "forge_failed",
          delayMs: 1,
        }),
      },
    });
    expect(await drain.runOnce()).toBe(true);
    expect(await drain.runOnce()).toBe(true);
    expect(await drain.runOnce()).toBe(false);
    expect(settled.map((entry) => entry.outcome.kind)).toEqual([
      "retry",
      "retry",
    ]);
  });

  test("an opener that throws leaves the stage to retry, and uncertain at the last attempt", async () => {
    const { store, settled } = memoryStore([
      job(),
      job({ claimToken: "t2", attempt: PULL_REQUEST_MAX_ATTEMPTS }),
    ]);
    const drain = createPullRequestDrain({
      store,
      logger,
      opener: {
        openForPushRequest: async () => {
          throw new Error("boom");
        },
      },
    });
    await drain.runOnce();
    await drain.runOnce();
    expect(settled[0]?.outcome).toMatchObject({ kind: "retry" });
    expect(settled[1]?.outcome).toMatchObject({
      kind: "stop",
      stage: "uncertain",
    });
  });

  test("a claim taken over while it worked writes nothing", async () => {
    const memory = memoryStore([job()]);
    const drain = createPullRequestDrain({
      store: memory.store,
      logger,
      opener: {
        openForPushRequest: async (claimed) => {
          // The lease lapsed and another replica claimed the row.
          memory.revoke(claimed.claimToken);
          return {
            kind: "opened",
            pullRequest: {
              number: 8,
              url: "u",
              head: HEAD,
              base: "develop",
              headSha: COMMIT,
              title: "t",
              created: true,
            },
          };
        },
      },
    });
    await drain.runOnce();
    expect(memory.settled).toEqual([]);
  });
});
