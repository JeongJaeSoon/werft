import { describe, expect, test } from "bun:test";
import {
  GITHUB_FEATURES_NONE,
  type Principal,
  type PushAttached,
  type PushRequest,
  pushDecisionOf,
} from "@werft-ai/contracts";
import { testCaller } from "@werft-ai/testkit";
import type { PushSourceResult } from "../../checkpoints/checkpoint-service.ts";
import { SessionServiceError } from "../../musterrolle/index.ts";
import {
  type AuthorizationPolicy,
  callerFor,
  createAuthorizationPolicy,
} from "../../musterrolle/policy.ts";
import type { SessionCatalog } from "../../sessions/catalog.ts";
import type {
  CreatePushRequestInput,
  PushPolicyApproval,
  PushRefusalRecord,
  PushRequestStore,
} from "../ports/push-requests.ts";
import { mayDecidePush } from "./push-decision.ts";
import { createPushRequestService } from "./push-request-service.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const PUSH = "22222222-2222-4222-8222-222222222222";
const CATALOG = {
  connections: {},
  repositories: {
    "sample-app": {
      url: "https://git.example/acme/sample-app.git",
      branch: "main",
      auth: { kind: "github_app", registered: true },
    },
  },
} satisfies SessionCatalog;

function service() {
  const refusals: PushRefusalRecord[] = [];
  const decided: unknown[] = [];
  const store = {
    recordRefusal: async (input: PushRefusalRecord) => {
      refusals.push(input);
      return "receipt-1";
    },
    decide: async (input: unknown) => {
      decided.push(input);
      throw new Error("not reached");
    },
  } as unknown as PushRequestStore;
  return {
    refusals,
    decided,
    push: createPushRequestService({
      authorization: createAuthorizationPolicy(),
      store,
      catalog: CATALOG,
      intents: {} as never,
      source: {
        readPushSource: async () => ({ status: "none" }),
        readPushSourceAt: async () => ({ status: "none" }),
      },
    }),
  };
}

describe("push request decisions", () => {
  test("a principal kind outside the allowlist cannot decide, even holding sessions:approve", async () => {
    const { push, refusals, decided } = service();
    const installation: Principal = {
      kind: "installation",
      id: "inst-1",
      owner_id: "owner-a",
      workspace_id: "9d2c4e61-8a3b-4f70-b1e5-6c0a7d3f2b98",
      scopes: ["sessions:approve"],
    };
    let bodyRead = false;
    const error = await push
      .decide(
        {
          caller: testCaller("owner-a"),
          principal: installation,
          ownerId: "owner-a",
          verified: true,
        },
        SESSION,
        PUSH,
        {
          idempotencyKey: "k-1",
          readBody: async () => {
            bodyRead = true;
            return { decision: "approve", git_commit: "a".repeat(40) };
          },
        },
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionServiceError);
    expect((error as SessionServiceError).code).toBe("FORBIDDEN");
    expect((error as SessionServiceError).details).toEqual({
      refusal: "unverified_principal",
      receipt_id: "receipt-1",
    });
    expect(refusals).toMatchObject([
      {
        operation: "resolve_push",
        refusal: "unverified_principal",
        actor: {
          principal: { kind: "installation", id: "inst-1" },
          actor_user_id: null,
        },
      },
    ]);
    expect(bodyRead).toBe(false);
    expect(decided).toEqual([]);
  });

  test("a Slack installation decides only as the linked person it names", () => {
    const installation: Principal = {
      kind: "installation",
      id: "inst-1",
      owner_id: "owner-a",
      workspace_id: "9d2c4e61-8a3b-4f70-b1e5-6c0a7d3f2b98",
      scopes: ["sessions:approve"],
    };
    expect(mayDecidePush(installation)).toBe("unverified_principal");
    expect(mayDecidePush(installation, null)).toBe("unverified_principal");
    expect(
      mayDecidePush(installation, "7c1e1a52-3c11-4a8c-9e0f-0a1b2c3d4e5f"),
    ).toBeNull();
    expect(
      mayDecidePush(
        { ...installation, scopes: [] },
        "7c1e1a52-3c11-4a8c-9e0f-0a1b2c3d4e5f",
      ),
    ).toBe("missing_scope");
  });

  test("an uppercase session id reads the checkpoint and records receipts under the stored id", async () => {
    const read: string[] = [];
    const refusals: PushRefusalRecord[] = [];
    const push = createPushRequestService({
      authorization: createAuthorizationPolicy(),
      store: {
        findSession: async () => ({
          repositoryId: "sample-app",
          push: "ask",
          policyApproval: null,
          policyFields: {},
        }),
        replayCreate: async () => null,
        recordRefusal: async (input: PushRefusalRecord) => {
          refusals.push(input);
          return "receipt-1";
        },
      } as unknown as PushRequestStore,
      catalog: CATALOG,
      intents: {} as never,
      source: {
        readPushSource: async (sessionId) => {
          read.push(sessionId);
          return { status: "none" };
        },
        readPushSourceAt: async () => ({ status: "none" }),
      },
    });
    const actor = {
      caller: testCaller("owner-a"),
      principal: {
        kind: "api_key",
        id: "key-1",
        owner_id: "owner-a",
        scopes: [],
      } as unknown as Principal,
      ownerId: "owner-a",
      verified: true,
    };
    const session = "aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb";
    const pushId = "cccccccc-2222-4222-8222-dddddddddddd";
    await push
      .create(actor, session.toUpperCase(), { idempotencyKey: "k-1" })
      .catch(() => {});
    await push
      .decide(actor, session.toUpperCase(), pushId.toUpperCase(), {
        idempotencyKey: "k-2",
        readBody: async () => ({
          decision: "reject",
          git_commit: "a".repeat(40),
        }),
      })
      .catch(() => {});
    expect(read).toEqual([session]);
    expect(refusals.map((refusal) => refusal.sessionId)).toEqual([
      session,
      session,
    ]);
    expect(refusals[1]?.result.push_request_id).toBe(pushId);
  });

  test("an approval hands the store the session's last checkpoint, or null when it cannot be read", async () => {
    const decided: Array<{ latest?: unknown }> = [];
    const approve = (readPushSource: () => Promise<PushSourceResult>) =>
      createPushRequestService({
        authorization: createAuthorizationPolicy({
          sessions: { visibleTo: async () => true, originOf: async () => null },
        }),
        store: {
          get: async () => null,
          decide: async (input: { latest?: unknown }) => {
            decided.push(input);
            return { outcome: "conflict" };
          },
        } as unknown as PushRequestStore,
        catalog: CATALOG,
        intents: {} as never,
        source: { readPushSource, readPushSourceAt: readPushSource },
      })
        .decide(
          {
            caller: testCaller("owner-a"),
            principal: {
              kind: "api_key",
              id: "key-1",
              owner_id: "owner-a",
              scopes: ["sessions:approve"],
            } as unknown as Principal,
            ownerId: "owner-a",
            verified: true,
          },
          SESSION,
          PUSH,
          {
            idempotencyKey: "k-1",
            readBody: async () => ({
              decision: "approve",
              git_commit: "a".repeat(40),
            }),
          },
        )
        .catch(() => {});
    await approve(async () => ({
      status: "ready",
      revision: 3,
      gitCommit: "a".repeat(40),
    }));
    await approve(async () => {
      throw new Error("store outage");
    });
    expect(decided.map((input) => input.latest)).toEqual([
      { revision: 3, gitCommit: "a".repeat(40) },
      null,
    ]);
  });

  test("the key that started the session cannot approve its push; another key of the agent can (GA-8)", async () => {
    const workspace = "9d2c4e61-8a3b-4f70-b1e5-6c0a7d3f2b98";
    const agent = "019a0000-0000-7000-8000-0000000000a1";
    const issuer = "019a0000-0000-7000-8000-0000000000c1";
    const starter = "019a0000-0000-7000-8000-0000000000f1";
    const second = "019a0000-0000-7000-8000-0000000000f2";
    const refusals: PushRefusalRecord[] = [];
    const decided: Array<{ deciderKey?: unknown; actor?: unknown }> = [];
    let bodyRead = 0;
    const push = createPushRequestService({
      authorization: createAuthorizationPolicy({
        identity: {
          reread: async (s) => ({
            status: "ok",
            principal: s.principal,
            keyAgentId: agent,
          }),
        },
        agents: {
          agentOf: async () => agent,
          isAdmin: async () => false,
        },
        sessions: {
          visibleTo: async () => true,
          originOf: async () => ({
            creatorUserId: null,
            creatorApiKeyId: starter,
          }),
        },
      }),
      store: {
        recordRefusal: async (input: PushRefusalRecord) => {
          refusals.push(input);
          return "receipt-self";
        },
        get: async () => null,
        decide: async (input: { deciderKey?: unknown; actor?: unknown }) => {
          decided.push(input);
          return { outcome: "conflict" };
        },
      } as unknown as PushRequestStore,
      catalog: CATALOG,
      intents: {} as never,
      source: {
        readPushSource: async () => ({ status: "none" }),
        readPushSourceAt: async () => ({ status: "none" }),
      },
    });
    const actorOf = (id: string) => {
      const principal: Principal = {
        kind: "api_key",
        id,
        owner_id: workspace,
        workspace_id: workspace,
        scopes: ["sessions:read", "sessions:write", "sessions:approve"],
      };
      return {
        caller: callerFor(principal, { kind: "api" }, "r", {
          creatorId: null,
          agentId: agent,
          issuerId: issuer,
        }),
        principal,
        ownerId: workspace,
        verified: true,
      };
    };
    const decide = (id: string) =>
      push.decide(actorOf(id), SESSION, PUSH, {
        idempotencyKey: `k-${id}`,
        readBody: async () => {
          bodyRead += 1;
          return { decision: "approve", git_commit: "a".repeat(40) };
        },
      });

    const error = await decide(starter).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionServiceError);
    expect((error as SessionServiceError).code).toBe("FORBIDDEN");
    expect((error as SessionServiceError).details).toEqual({
      refusal: "self_approval",
      receipt_id: "receipt-self",
    });
    expect(refusals).toMatchObject([
      {
        operation: "resolve_push",
        refusal: "self_approval",
        actor: {
          principal: { kind: "api_key", id: starter },
          agent_id: agent,
        },
        result: {
          verdict: "refuse",
          refusal: "self_approval",
          decider_key: {
            id: starter,
            kind: "agent",
            issued_by_user_id: issuer,
          },
        },
      },
    ]);
    expect(bodyRead).toBe(0);
    expect(decided).toEqual([]);

    await decide(second).catch(() => {});
    expect(bodyRead).toBe(1);
    expect(decided).toMatchObject([
      {
        actor: { principal: { kind: "api_key", id: second } },
        deciderKey: { id: second, kind: "agent", issued_by_user_id: issuer },
      },
    ]);
  });

  test("a session the caller cannot see is NOT_FOUND, and nothing reads or writes the store", async () => {
    const touched: string[] = [];
    const hidden: AuthorizationPolicy = {
      authorize: async () => ({
        outcome: "deny",
        reason_code: "not_found",
        effective_scopes: [],
        policy_version: "test",
        decision_id: crypto.randomUUID(),
      }),
    };
    const store = new Proxy({} as PushRequestStore, {
      get: (_target, name) => async () => {
        touched.push(String(name));
        return null;
      },
    });
    const push = createPushRequestService({
      authorization: hidden,
      store,
      intents: {} as never,
      source: {
        readPushSource: async () => {
          touched.push("readPushSource");
          return { status: "none" };
        },
        readPushSourceAt: async () => {
          touched.push("readPushSourceAt");
          return { status: "none" };
        },
      },
      catalog: CATALOG,
    });
    const actor = {
      caller: testCaller("owner-a"),
      principal: {
        kind: "api_key",
        id: "key-1",
        owner_id: "owner-a",
        workspace_id: null,
        scopes: ["sessions:read", "sessions:write", "sessions:approve"],
      } as Principal,
      ownerId: "owner-a",
      verified: true,
    };
    const attempts = [
      push.create(actor, SESSION, { idempotencyKey: "k-1" }),
      push.list(actor, SESSION),
      push.get(actor, SESSION, PUSH),
      push.decide(actor, SESSION, PUSH, {
        idempotencyKey: "k-2",
        readBody: async () => ({
          decision: "approve",
          git_commit: "a".repeat(40),
        }),
      }),
    ];
    for (const attempt of attempts) {
      const error = await attempt.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SessionServiceError);
      expect((error as SessionServiceError).code).toBe("NOT_FOUND");
    }
    expect(touched).toEqual([]);
  });
});

describe("a push to another repository", () => {
  const MULTI = {
    connections: {},
    repositories: {
      ...CATALOG.repositories,
      docs: {
        url: "https://git.example/acme/docs.git",
        branch: "main",
        auth: { kind: "github_app", registered: true },
      },
      tools: {
        url: "https://git.example/acme/tools.git",
        branch: "main",
        auth: { kind: "github_app", registered: true },
      },
    },
  } satisfies SessionCatalog;

  function pushing(
    attached: string[] | null,
    own: string | null = "sample-app",
    released = ["sample-app", "docs", "tools"],
    policyApproval: PushPolicyApproval | null = null,
    pinned: PushSourceResult = {
      status: "ready",
      revision: 3,
      gitCommit: "a".repeat(40),
    },
    pushAttached: PushAttached = "ask",
    // The real store fills policyApproval whenever a release exists, so the
    // switch can be on while an approval is still on offer.
    pushApprovalOn: boolean = policyApproval === null,
  ) {
    const created: CreatePushRequestInput[] = [];
    const refusals: PushRefusalRecord[] = [];
    const github = {
      repositories: released,
      features: GITHUB_FEATURES_NONE,
      actions_allow: [],
      push_approval: pushApprovalOn,
    };
    const push = createPushRequestService({
      authorization: createAuthorizationPolicy(),
      store: {
        replayCreate: async () => null,
        findSession: async () => ({
          repositoryId: own,
          attached,
          github,
          policySource: policyApproval?.source ?? "release",
          repositoryCeiling: {
            repository_ids: ["sample-app", "docs", "tools"],
            github_app_repositories: "listed",
          },
          githubEnabled: true,
          push: pushDecisionOf({ settings: github, pushAttached }),
          policyApproval,
          policyFields: { policy_source: "release" },
        }),
        recordRefusal: async (input: PushRefusalRecord) => {
          refusals.push(input);
          return "receipt-1";
        },
        create: async (input: CreatePushRequestInput) => {
          created.push(input);
          return { outcome: "written", request: {} as PushRequest };
        },
      } as unknown as PushRequestStore,
      catalog: MULTI,
      intents: {} as never,
      source: {
        readPushSource: async () => pinned,
        readPushSourceAt: async () => pinned,
      },
    });
    const actor = {
      caller: testCaller("owner-a"),
      principal: {
        kind: "api_key",
        id: "owner-a",
        owner_id: "owner-a",
        workspace_id: null,
        scopes: ["sessions:write"],
      } as Principal,
      ownerId: "owner-a",
      verified: true,
    };
    const to = (repository_id?: string) =>
      push
        .create(actor, SESSION, {
          idempotencyKey: `k-${repository_id}`,
          body: repository_id === undefined ? {} : { repository_id },
        })
        .then(
          () => null,
          (caught: unknown) => caught,
        );
    return { to, created, refusals };
  }

  test("is refused for a repository the release lists but the session did not attach", async () => {
    const { to, created, refusals } = pushing(["docs"]);
    const error = await to("tools");
    expect(error).toBeInstanceOf(SessionServiceError);
    expect((error as SessionServiceError).details).toEqual({
      refusal: "repository_not_allowed",
      receipt_id: "receipt-1",
    });
    expect(refusals.at(-1)?.result).toMatchObject({ repository_id: "tools" });
    expect(await to("docs")).toBeNull();
    expect(created.map((input) => input.repositoryId)).toEqual(["docs"]);
  });

  test("a checkpoint whose worker found wrongly attributed commits is refused before a person is asked", async () => {
    const mismatches = [
      { commit: "b".repeat(40), problems: ["author" as const] },
    ];
    const { to, created, refusals } = pushing(
      null,
      "sample-app",
      undefined,
      null,
      {
        status: "ready",
        revision: 3,
        gitCommit: "a".repeat(40),
        mismatches,
      },
    );
    const error = (await to()) as SessionServiceError;
    expect(error).toBeInstanceOf(SessionServiceError);
    expect(error.details).toEqual({
      refusal: "attribution_mismatch",
      receipt_id: "receipt-1",
      mismatches,
    });
    expect(refusals.at(-1)).toMatchObject({
      operation: "request_push",
      refusal: "attribution_mismatch",
      result: {
        verdict: "refuse",
        refusal: "attribution_mismatch",
        mismatches,
      },
    });
    expect(created).toEqual([]);
  });

  test("a checkpoint whose commit is the working-tree snapshot is refused as uncommitted changes", async () => {
    const snapshot = "c".repeat(40);
    const { to, created, refusals } = pushing(
      null,
      "sample-app",
      undefined,
      null,
      {
        status: "ready",
        revision: 4,
        gitCommit: snapshot,
        mismatches: [{ commit: snapshot, problems: [] }],
      },
    );
    const error = (await to()) as SessionServiceError;
    expect(error).toBeInstanceOf(SessionServiceError);
    expect(error.details).toEqual({
      refusal: "uncommitted_changes",
      receipt_id: "receipt-1",
    });
    expect(refusals.at(-1)).toMatchObject({
      operation: "request_push",
      refusal: "uncommitted_changes",
      result: { verdict: "refuse", refusal: "uncommitted_changes" },
    });
    expect(created).toEqual([]);
  });

  test("an empty mismatch for a commit other than the pinned one is not the snapshot signal", async () => {
    const { to, created } = pushing(null, "sample-app", undefined, null, {
      status: "ready",
      revision: 4,
      gitCommit: "a".repeat(40),
      mismatches: [{ commit: "c".repeat(40), problems: [] }],
    });
    const error = (await to()) as SessionServiceError;
    expect((error.details as { refusal: string }).refusal).toBe(
      "attribution_mismatch",
    );
    expect(created).toEqual([]);
  });

  test("a checkpoint from a worker that checked nothing passes here (the push checks it)", async () => {
    const { to, created } = pushing(null);
    expect(await to()).toBeNull();
    expect(created).toHaveLength(1);
  });

  test("approval off and push_attached allow approve every repository by policy", async () => {
    const approval: PushPolicyApproval = {
      releaseId: "019a0000-0000-7000-8000-0000000000d1",
      source: "release",
      settingsRevision: null,
    };
    const { to, created } = pushing(
      ["docs"],
      "sample-app",
      undefined,
      approval,
      undefined,
      "allow",
    );
    expect(await to()).toBeNull();
    expect(await to("sample-app")).toBeNull();
    expect(await to("docs")).toBeNull();
    expect(
      created.map((input) => [input.repositoryId, input.policyApproval]),
    ).toEqual([
      ["sample-app", approval],
      ["sample-app", approval],
      ["docs", approval],
    ]);
    expect(created[0]?.policyFields).toEqual({ policy_source: "release" });
  });

  test("an agent's settings approve the same way, carrying the settings revision", async () => {
    const approval: PushPolicyApproval = {
      releaseId: "019a0000-0000-7000-8000-0000000000d1",
      source: "agent",
      settingsRevision: 4,
    };
    const { to, created } = pushing(
      ["docs"],
      "sample-app",
      undefined,
      approval,
      undefined,
      "allow",
    );
    expect(await to()).toBeNull();
    expect(await to("docs")).toBeNull();
    expect(
      created.map((input) => [input.repositoryId, input.policyApproval]),
    ).toEqual([
      ["sample-app", approval],
      ["docs", approval],
    ]);
  });

  describe("push_attached with push_approval: the stricter of the two", () => {
    const own: PushPolicyApproval = {
      releaseId: "019a0000-0000-7000-8000-0000000000d1",
      source: "agent",
      settingsRevision: 4,
    };

    test("allow with push_approval on still asks a person, for the own repository and an attached one", async () => {
      const { to, created } = pushing(
        ["docs"],
        "sample-app",
        undefined,
        null,
        undefined,
        "allow",
      );
      expect(await to("docs")).toBeNull();
      expect(await to("sample-app")).toBeNull();
      expect(
        created.map((input) => [input.repositoryId, input.policyApproval]),
      ).toEqual([
        ["docs", null],
        ["sample-app", null],
      ]);
    });

    test("an approval on offer is dropped when push_approval is on, even with push_attached allow", async () => {
      const { to, created } = pushing(
        ["docs"],
        "sample-app",
        undefined,
        own,
        undefined,
        "allow",
        true,
      );
      expect(await to("docs")).toBeNull();
      expect(await to("sample-app")).toBeNull();
      expect(created.map((input) => input.policyApproval)).toEqual([
        null,
        null,
      ]);
    });

    test("ask with push_approval off leaves every repository to a person", async () => {
      const { to, created } = pushing(
        ["docs"],
        "sample-app",
        undefined,
        own,
        undefined,
        "ask",
      );
      expect(await to("docs")).toBeNull();
      expect(await to("sample-app")).toBeNull();
      expect(created.map((input) => input.policyApproval)).toEqual([
        null,
        null,
      ]);
    });

    test("deny refuses every repository as repository_not_allowed and records the refusal", async () => {
      const { to, created, refusals } = pushing(
        ["docs"],
        "sample-app",
        undefined,
        own,
        undefined,
        "deny",
      );
      const error = (await to("docs")) as SessionServiceError;
      expect(error).toBeInstanceOf(SessionServiceError);
      expect(error.details).toEqual({
        refusal: "repository_not_allowed",
        receipt_id: "receipt-1",
      });
      expect(refusals.at(-1)?.result).toMatchObject({
        repository_id: "docs",
        refusal: "repository_not_allowed",
      });
      expect(created).toEqual([]);
      expect(await to("sample-app")).toBeInstanceOf(SessionServiceError);
      expect(created).toEqual([]);
    });

    test("with no repository of its own, deny refuses an attached one", async () => {
      const { to, created } = pushing(
        ["docs"],
        null,
        undefined,
        null,
        undefined,
        "deny",
      );
      expect(await to("docs")).toBeInstanceOf(SessionServiceError);
      expect(created).toEqual([]);
    });
  });

  test("without an attached list, every repository the release lists", async () => {
    const { to, created } = pushing(null);
    expect(await to("tools")).toBeNull();
    expect(created.map((input) => input.repositoryId)).toEqual(["tools"]);
  });

  test("from a session without a repository: an attached one in the release's list, never by omission", async () => {
    const { to, created, refusals } = pushing(["docs", "tools"], null, [
      "docs",
    ]);
    expect(await to("docs")).toBeNull();
    expect(created.map((input) => input.repositoryId)).toEqual(["docs"]);

    // Attached, but off the release's list.
    const outside = await to("tools");
    expect((outside as SessionServiceError).details).toEqual({
      refusal: "repository_not_allowed",
      receipt_id: "receipt-1",
    });
    expect(refusals.at(-1)?.result).toMatchObject({
      verdict: "refuse",
      repository_id: "tools",
    });

    const omitted = await to();
    expect((omitted as SessionServiceError).details).toEqual({
      refusal: "no_repository",
      receipt_id: "receipt-1",
    });
    expect(refusals.at(-1)?.result).toMatchObject({ repository_id: null });
    expect(created).toHaveLength(1);
  });
});

describe("a release with push_approval off", () => {
  const RELEASE = "019a0000-0000-7000-8000-0000000000d1";

  function creating(releaseId: string | null) {
    const created: CreatePushRequestInput[] = [];
    const push = createPushRequestService({
      authorization: createAuthorizationPolicy(),
      store: {
        replayCreate: async () => null,
        recordRefusal: async () => "receipt-1",
        findSession: async () => ({
          repositoryId: "sample-app",
          push: releaseId === null ? "ask" : "allow",
          policyApproval:
            releaseId === null
              ? null
              : { releaseId, source: "release", settingsRevision: null },
          policyFields: {},
        }),
        create: async (input: CreatePushRequestInput) => {
          created.push(input);
          const approved = input.policyApproval !== null;
          const resolution = {
            resolved_by:
              input.policyApproval === null
                ? null
                : {
                    kind: "policy" as const,
                    agent_release_id: input.policyApproval.releaseId,
                  },
            resolved_at: approved ? "2026-10-30T00:00:00.000Z" : null,
            resolution_reason: null,
            resolution_receipt_id: approved
              ? "019a0000-0000-7000-8000-0000000000e2"
              : null,
          };
          const request: PushRequest = {
            id: PUSH,
            session_id: input.sessionId,
            repository_id: input.repositoryId,
            checkpoint_revision: input.checkpointRevision,
            git_commit: input.gitCommit,
            target_branch: `agent/${input.sessionId}`,
            state: approved ? "approved" : "requested",
            requested_by: input.actor,
            requested_at: "2026-10-30T00:00:00.000Z",
            ...resolution,
            request_receipt_id: "019a0000-0000-7000-8000-0000000000e1",
            finished_at: null,
            push_receipt_id: null,
            origin: "direct" as const,
            flow: "legacy" as const,
            pr_state: null,
            pr_error: null,
            pr_number: null,
            pr_url: null,
          };
          return { outcome: "written", request };
        },
      } as unknown as PushRequestStore,
      catalog: CATALOG,
      intents: {} as never,
      source: {
        readPushSourceAt: async () => ({ status: "none" }),
        readPushSource: async () => ({
          status: "ready",
          revision: 3,
          gitCommit: "a".repeat(40),
        }),
      },
    });
    const actor = {
      caller: testCaller("owner-a"),
      principal: {
        kind: "api_key",
        id: "owner-a",
        owner_id: "owner-a",
        workspace_id: null,
        scopes: ["sessions:write"],
      } as Principal,
      ownerId: "owner-a",
      verified: true,
    };
    return { push, actor, created };
  }

  test("creates a request already approved by the release's policy", async () => {
    const { push, actor, created } = creating(RELEASE);
    const request = await push.create(actor, SESSION, { idempotencyKey: "k" });
    expect(created[0]?.policyApproval?.releaseId).toBe(RELEASE);
    expect(request).toMatchObject({
      state: "approved",
      resolved_by: { kind: "policy", agent_release_id: RELEASE },
    });
  });

  test("a release that keeps push approval creates a requested one", async () => {
    const { push, actor, created } = creating(null);
    const request = await push.create(actor, SESSION, { idempotencyKey: "k" });
    expect(created[0]?.policyApproval).toBeNull();
    expect(request.state).toBe("requested");
  });

  test("an omitted checkpoint_revision pins the latest one; a named one is read at that revision", async () => {
    const { push, actor, created } = creating(null);
    await push.create(actor, SESSION, { idempotencyKey: "latest", body: {} });
    expect(created).toMatchObject([{ checkpointRevision: 3 }]);
    // The stub's readPushSourceAt has no checkpoint, so only a named
    // revision reaches it.
    const named = await push
      .create(actor, SESSION, {
        idempotencyKey: "named",
        body: { checkpoint_revision: 2 },
      })
      .catch((caught: unknown) => caught);
    expect(named).toBeInstanceOf(SessionServiceError);
    expect((named as SessionServiceError).code).toBe("PUSH_SOURCE_MISSING");
    expect(created).toHaveLength(1);
  });
});
