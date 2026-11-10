import { describe, expect, test } from "bun:test";
import {
  GITHUB_FEATURES_NONE,
  type Principal,
  type PushRequest,
} from "@werft-ai/contracts";
import { testCaller } from "@werft-ai/testkit";
import type { PushSourceResult } from "../../checkpoints/checkpoint-service.ts";
import { createAuthorizationPolicy } from "../../musterrolle/policy.ts";
import type {
  CreatePushIntentInput,
  PushIntentJob,
  PushIntentStore,
} from "../../ports/push-intents.ts";
import type {
  PushRefusalRecord,
  PushRequestStore,
} from "../../ports/push-requests.ts";
import type { SessionCatalog } from "../../sessions/catalog.ts";
import { SessionServiceError } from "../../sessions/session-service.ts";
import { createPushRequestService } from "./push-request-service.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const PUSH = "22222222-2222-4222-8222-222222222222";
const COMMIT = "a".repeat(40);
const CATALOG = {
  connections: {},
  repositories: {
    "sample-app": {
      url: "https://git.example/acme/sample-app.git",
      branch: "main",
      auth: { kind: "github_app", registered: true },
    },
    docs: {
      url: "https://git.example/acme/docs.git",
      branch: "main",
      auth: { kind: "github_app", registered: true },
    },
  },
} satisfies SessionCatalog;

const actor = {
  caller: testCaller("owner-a"),
  principal: {
    kind: "api_key",
    id: "owner-a",
    owner_id: "owner-a",
    workspace_id: null,
    scopes: ["sessions:write", "sessions:approve"],
  } as Principal,
  ownerId: "owner-a",
  verified: true,
};

const APPROVAL = {
  releaseId: "019a0000-0000-7000-8000-0000000000d1",
  source: "release" as const,
  settingsRevision: null,
};

function harness(
  options: {
    githubEnabled?: boolean;
    pinned?: PushSourceResult;
    turnRunning?: boolean;
    takenTarget?: string;
    push?: "allow" | "ask" | "deny";
    request?: Partial<PushRequest> | null;
  } = {},
) {
  const pinned: PushSourceResult = options.pinned ?? {
    status: "ready",
    revision: 3,
    gitCommit: COMMIT,
  };
  const refusals: PushRefusalRecord[] = [];
  const deferred: CreatePushIntentInput[] = [];
  const ended: Array<[string, string]> = [];
  const transitions: unknown[] = [];
  const decided: unknown[] = [];
  const store = {
    findSession: async () => ({
      repositoryId: "sample-app",
      attached: null,
      github: {
        repositories: ["sample-app", "docs"],
        features: GITHUB_FEATURES_NONE,
        actions_allow: [],
        push_approval: true,
      },
      policySource: "release",
      repositoryCeiling: {
        repository_ids: ["sample-app", "docs"],
        github_app_repositories: "listed",
      },
      githubEnabled: options.githubEnabled ?? true,
      push: options.push ?? "ask",
      policyApproval: APPROVAL,
      policyFields: { policy_source: "release" },
    }),
    recordRefusal: async (input: PushRefusalRecord) => {
      refusals.push(input);
      return "receipt-1";
    },
    get: async () =>
      options.request === null
        ? null
        : {
            origin: "intent",
            state: "requested",
            checkpoint_revision: 3,
            git_commit: COMMIT,
            ...options.request,
          },
    decide: async (input: unknown) => {
      decided.push(input);
      return { outcome: "refused", refusal: "not_found" };
    },
  } as unknown as PushRequestStore;
  const intents = {
    createDeferred: async (input: CreatePushIntentInput) => {
      deferred.push(input);
      if (options.takenTarget !== undefined) {
        return {
          outcome: "source_ref_required",
          targetBranch: options.takenTarget,
        };
      }
      return options.turnRunning === false
        ? { outcome: "turn_not_running" }
        : { outcome: "written", intent: { id: "intent-1" } };
    },
    end: async (_job: PushIntentJob, status: string, code: string) => {
      ended.push([status, code]);
      return true;
    },
    transition: async (_job: PushIntentJob, input: unknown) => {
      transitions.push(input);
      return { outcome: "requested", pushRequestId: PUSH };
    },
  } as unknown as PushIntentStore;
  const push = createPushRequestService({
    authorization: createAuthorizationPolicy(),
    store,
    intents,
    catalog: CATALOG,
    source: {
      readPushSource: async () => ({
        status: "ready",
        revision: 9,
        gitCommit: "b".repeat(40),
      }),
      readPushSourceAt: async () => pinned,
    },
  });
  return { push, refusals, deferred, ended, transitions, decided };
}

const job = (over: Partial<PushIntentJob> = {}): PushIntentJob => ({
  id: "intent-1",
  ownerId: "owner-a",
  sessionId: SESSION,
  repositoryId: "sample-app",
  targetBranch: `agent/${SESSION}`,
  pinnedRevision: 3,
  actor: {
    principal: { kind: "api_key", id: "owner-a" },
    actor_user_id: null,
    agent_id: null,
  },
  sourceRef: null,
  pushClass: "push.primary",
  pullRequest: null,
  claimToken: "token-1",
  sessionClosed: false,
  ...over,
});

describe("requestIntent", () => {
  const ask = { attemptId: "attempt-1", turnId: 7, body: {} };

  test("records the turn's intent with the target and the push class, and creates no request", async () => {
    const { push, deferred } = harness();
    const result = await push.requestIntent(actor, SESSION, {
      ...ask,
      pullRequest: { title: "t" },
    });
    expect(result).toMatchObject({ status: "deferred" });
    expect(deferred).toMatchObject([
      {
        sessionId: SESSION,
        turnId: 7,
        attemptId: "attempt-1",
        repositoryId: "sample-app",
        targetBranch: `agent/${SESSION}`,
        pushClass: "push",
        pullRequest: { title: "t" },
      },
    ]);
  });

  test("a release without GitHub writes nothing", async () => {
    const { push, deferred, refusals } = harness({ githubEnabled: false });
    expect(await push.requestIntent(actor, SESSION, ask)).toEqual({
      status: "github_disabled",
    });
    expect(deferred).toEqual([]);
    expect(refusals).toEqual([]);
  });

  test("a second push that lacks a source is reported with the target that lacks one, not recorded", async () => {
    const { push } = harness({ takenTarget: `agent/${SESSION}` });
    expect(
      await push.requestIntent(actor, SESSION, {
        ...ask,
        body: { branch: "docs" },
      }),
    ).toEqual({
      status: "source_ref_required",
      target_branch: `agent/${SESSION}`,
    });
  });

  test("the source branch is handed to the store with the intent", async () => {
    const { push, deferred } = harness();
    await push.requestIntent(actor, SESSION, {
      ...ask,
      body: { repository_id: "docs" },
      sourceRef: "guard-docs",
    });
    expect(deferred).toMatchObject([
      { repositoryId: "docs", sourceRef: "guard-docs" },
    ]);
  });

  test("a turn that is no longer running is reported, not recorded", async () => {
    const { push } = harness({ turnRunning: false });
    expect(await push.requestIntent(actor, SESSION, ask)).toEqual({
      status: "turn_not_running",
    });
  });

  test("a repository outside the release is refused with a receipt and no intent", async () => {
    const { push, deferred, refusals } = harness();
    const error = await push
      .requestIntent(actor, SESSION, {
        ...ask,
        body: { repository_id: "elsewhere" },
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionServiceError);
    expect((error as SessionServiceError).details).toMatchObject({
      refusal: "no_repository",
    });
    expect(refusals).toHaveLength(1);
    expect(deferred).toEqual([]);
  });
});

describe("push.attached = deny on the intent path", () => {
  test("requestIntent refuses an allowed attached repository with a receipt and records no intent", async () => {
    const { push, deferred, refusals } = harness({ push: "deny" });
    const error = await push
      .requestIntent(actor, SESSION, {
        attemptId: "attempt-1",
        turnId: 7,
        body: { repository_id: "docs" },
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionServiceError);
    expect((error as SessionServiceError).details).toMatchObject({
      refusal: "repository_not_allowed",
    });
    expect(refusals).toHaveLength(1);
    expect(deferred).toEqual([]);
  });

  test("the same attached repository is accepted when the policy is ask", async () => {
    const { push, deferred } = harness();
    const result = await push.requestIntent(actor, SESSION, {
      attemptId: "attempt-1",
      turnId: 7,
      body: { repository_id: "docs" },
    });
    expect(result).toMatchObject({ status: "deferred" });
    expect(deferred).toMatchObject([
      { repositoryId: "docs", pushClass: "push" },
    ]);
  });

  test("createFromIntent fails an intent whose attached repository became deny, with no transition", async () => {
    const { push, ended, transitions } = harness({ push: "deny" });
    await push.createFromIntent(
      job({ repositoryId: "docs", pushClass: "push.attached" }),
    );
    expect(ended).toEqual([["failed", "repository_not_allowed"]]);
    expect(transitions).toEqual([]);
  });
});

describe("one push class, and a stored class is never a permission", () => {
  const STORED = ["push.primary", "push.attached", "push"] as const;

  test("requestIntent records `push` for every repository", async () => {
    const { push, deferred } = harness();
    for (const repository_id of ["sample-app", "docs"]) {
      await push.requestIntent(actor, SESSION, {
        attemptId: "attempt-1",
        turnId: 7,
        body: { repository_id },
      });
    }
    expect(deferred.map((input) => input.pushClass)).toEqual(["push", "push"]);
  });

  test("an own-repository push is denied for any stored class once the store says deny", async () => {
    for (const pushClass of STORED) {
      const { push, ended, transitions } = harness({ push: "deny" });
      await push.createFromIntent(job({ pushClass }));
      expect(ended).toEqual([["failed", "repository_not_allowed"]]);
      expect(transitions).toEqual([]);
    }
  });

  test("the approval follows the decision at run time, not the class stored with the intent", async () => {
    for (const pushClass of STORED) {
      for (const repositoryId of ["sample-app", "docs"]) {
        const open = harness({ push: "allow" });
        await open.push.createFromIntent(job({ repositoryId, pushClass }));
        expect(open.transitions).toMatchObject([{ policyApproval: APPROVAL }]);
        const narrowed = harness({ push: "ask" });
        await narrowed.push.createFromIntent(job({ repositoryId, pushClass }));
        expect(narrowed.transitions).toMatchObject([{ policyApproval: null }]);
      }
    }
  });
});

describe("createFromIntent", () => {
  test("a closed session cancels the intent before anything is read", async () => {
    const { push, ended, transitions } = harness();
    await push.createFromIntent(job({ sessionClosed: true }));
    expect(ended).toEqual([["cancelled", "session_closed"]]);
    expect(transitions).toEqual([]);
  });

  test("a release that dropped GitHub since the turn fails the intent", async () => {
    const { push, ended } = harness({ githubEnabled: false });
    await push.createFromIntent(job());
    expect(ended).toEqual([["failed", "github_disabled"]]);
  });

  test("a repository the release no longer allows fails the intent", async () => {
    const { push, ended } = harness();
    await push.createFromIntent(job({ repositoryId: "elsewhere" }));
    expect(ended).toEqual([["failed", "repository_not_allowed"]]);
  });

  test("a pinned revision that cannot be read ends with the matching code", async () => {
    const none = harness({ pinned: { status: "none" } });
    await none.push.createFromIntent(job());
    expect(none.ended).toEqual([["failed", "source_missing"]]);
    const gone = harness({
      pinned: { status: "unavailable", reason: "gone" },
    });
    await gone.push.createFromIntent(job());
    expect(gone.ended).toEqual([["failed", "checkpoint_unavailable"]]);
  });

  test("a verified pinned revision becomes an actions-flow request on that commit", async () => {
    const { push, transitions, ended } = harness();
    const result = await push.createFromIntent(
      job({ pullRequest: { title: "t" } }),
    );
    expect(result).toBe("requested");
    expect(ended).toEqual([]);
    expect(transitions).toMatchObject([
      {
        sessionId: SESSION,
        checkpointRevision: 3,
        gitCommit: COMMIT,
        flow: "actions",
        pullRequestIntent: { title: "t" },
        targetBranch: `agent/${SESSION}`,
      },
    ]);
  });
});

describe("an intent with a source branch", () => {
  const SKILLS = "d".repeat(40);
  const GUARD = "e".repeat(40);
  const pinned: PushSourceResult = {
    status: "ready",
    revision: 3,
    gitCommit: COMMIT,
    sources: [
      { name: "guard-docs", commit: GUARD },
      { name: "skills-sample", commit: SKILLS },
    ],
    mismatches: [{ commit: COMMIT, problems: ["author"] }],
  };

  test("each branch becomes a request on its own commit, not the snapshot's", async () => {
    const { push, transitions, ended } = harness({ pinned });
    await push.createFromIntent(
      job({ repositoryId: "docs", sourceRef: "guard-docs" }),
    );
    await push.createFromIntent(job({ sourceRef: "skills-sample" }));
    expect(ended).toEqual([]);
    expect(transitions).toMatchObject([
      { repositoryId: "docs", gitCommit: GUARD, checkpointRevision: 3 },
      { repositoryId: "sample-app", gitCommit: SKILLS, checkpointRevision: 3 },
    ]);
  });

  test("a branch the checkpoint did not keep fails the intent as a missing source", async () => {
    const { push, ended, transitions } = harness({ pinned });
    await push.createFromIntent(job({ sourceRef: "never-committed" }));
    expect(ended).toEqual([["failed", "source_missing"]]);
    expect(transitions).toEqual([]);
  });

  test("an intent without a branch still stops on the snapshot's problems", async () => {
    const { push, ended } = harness({ pinned });
    await push.createFromIntent(job());
    expect(ended).toEqual([["failed", "attribution_mismatch"]]);
  });
});

describe("approving an intent request", () => {
  const approve = (push: ReturnType<typeof harness>["push"]) =>
    push
      .decide(actor, SESSION, PUSH, {
        idempotencyKey: "k-1",
        readBody: async () => ({ decision: "approve", git_commit: COMMIT }),
      })
      .catch((caught: unknown) => caught);

  test("a pinned revision that no longer verifies is refused, and nothing is decided", async () => {
    const { push, decided, refusals } = harness({
      pinned: { status: "unavailable", reason: "gone" },
    });
    const error = await approve(push);
    expect(error).toBeInstanceOf(SessionServiceError);
    expect((error as SessionServiceError).details).toMatchObject({
      refusal: "pinned_source_invalid",
    });
    expect(refusals.at(-1)).toMatchObject({ operation: "resolve_push" });
    expect(decided).toEqual([]);
  });

  test("a pinned revision whose commit differs from the request's is refused too", async () => {
    const { push, decided } = harness({
      pinned: { status: "ready", revision: 3, gitCommit: "c".repeat(40) },
    });
    const error = await approve(push);
    expect((error as SessionServiceError).details).toMatchObject({
      refusal: "pinned_source_invalid",
    });
    expect(decided).toEqual([]);
  });

  test("a request on a kept branch's commit is approvable, one on a commit the revision never held is not", async () => {
    const kept = harness({
      pinned: {
        status: "ready",
        revision: 3,
        gitCommit: "c".repeat(40),
        sources: [{ name: "guard-docs", commit: COMMIT }],
      },
    });
    await approve(kept.push);
    expect(kept.decided).toMatchObject([{ decision: "approve" }]);
    const foreign = harness({
      pinned: {
        status: "ready",
        revision: 3,
        gitCommit: "c".repeat(40),
        sources: [{ name: "guard-docs", commit: "f".repeat(40) }],
      },
    });
    const error = await approve(foreign.push);
    expect((error as SessionServiceError).details).toMatchObject({
      refusal: "pinned_source_invalid",
    });
    expect(foreign.decided).toEqual([]);
  });

  test("a verifying pinned revision reaches the store even though the pointer moved on", async () => {
    const { push, decided } = harness();
    await approve(push);
    expect(decided).toMatchObject([{ decision: "approve" }]);
  });

  test("a decided request, replayed after its revision was collected, skips the pinned check", async () => {
    const { push, decided } = harness({
      request: { state: "approved" },
      pinned: { status: "none" },
    });
    await approve(push);
    expect(decided).toHaveLength(1);
  });

  test("a direct request keeps the pointer rule and skips the pinned check", async () => {
    const { push, decided } = harness({
      request: { origin: "direct" },
      pinned: { status: "none" },
    });
    await approve(push);
    expect(decided).toHaveLength(1);
  });
});
