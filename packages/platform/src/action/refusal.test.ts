import { describe, expect, test } from "bun:test";
import type { Principal, PushRequest } from "@werft-ai/contracts";
import { testCaller } from "@werft-ai/testkit";
import {
  type AuthorizationPolicy,
  createAuthorizationPolicy,
} from "../musterrolle/policy.ts";
import type { PushRequestStore } from "../ports/push-requests.ts";
import type { SessionCatalog } from "../sessions/catalog.ts";
import { SessionServiceError } from "../sessions/session-service.ts";
import { createPushRequestService } from "./change-request/push-request-service.ts";
import {
  createGitHubMcpServer,
  type GitHubMcpServices,
} from "./github/github-mcp-server.ts";
import { refusalFromServiceError } from "./refusal.ts";

const err = (code: string, details: unknown = null) =>
  new SessionServiceError(
    code as never,
    "text a model could read",
    undefined,
    details,
  );

describe("refusalFromServiceError, in the order of catalog 5.7", () => {
  test("1. the service's refusal the tool lists wins, with its table row", () => {
    expect(
      refusalFromServiceError(
        "request_push",
        err("PUSH_REQUEST_OPEN", { refusal: "request_open", receipt_id: "r" }),
      ),
    ).toEqual({
      code: "request_open",
      by: "platform",
      retryable: true,
      details: { receipt_id: "r" },
    });
  });

  test("1b. a push refused for a commit's attribution keeps its code and the commits to repair", () => {
    const mismatches = [{ commit: "a".repeat(40), problems: ["author"] }];
    expect(
      refusalFromServiceError(
        "request_push",
        err("FORBIDDEN", {
          refusal: "attribution_mismatch",
          receipt_id: "r",
          mismatches,
        }),
      ),
    ).toEqual({
      code: "attribution_mismatch",
      by: "platform",
      retryable: false,
      details: { receipt_id: "r", mismatches },
    });
  });

  test("2. else details.reason_code, when the tool lists it", () => {
    expect(
      refusalFromServiceError(
        "attach_repository",
        err("GITHUB_REFUSED", { reason_code: "repository_not_allowed" }),
      ),
    ).toEqual({
      code: "repository_not_allowed",
      by: "policy",
      retryable: false,
      details: { reason_code: "repository_not_allowed" },
    });
    // The pull request's forge failure is GitHub's and can be tried again.
    expect(
      refusalFromServiceError(
        "open_pull_request",
        err("BACKEND_UNAVAILABLE", { refusal: "forge_failed" }),
      ),
    ).toMatchObject({ code: "forge_failed", by: "github", retryable: true });
  });

  test("3. else the service code in lower case", () => {
    expect(
      refusalFromServiceError(
        "dispatch_workflow",
        err("GITHUB_REFUSED", { reason_code: "workflow_not_allowed" }),
      ),
    ).toEqual({
      code: "github_refused",
      by: "github",
      retryable: false,
      details: { reason_code: "workflow_not_allowed" },
    });
    expect(
      refusalFromServiceError("dispatch_workflow", err("BACKEND_UNAVAILABLE")),
    ).toEqual({ code: "backend_unavailable", by: "github", retryable: true });
    expect(
      refusalFromServiceError("dispatch_workflow", err("SESSION_STOPPED")),
    ).toEqual({ code: "session_stopped", by: "platform", retryable: false });
  });

  test("a refusal never carries the service's message", () => {
    const refusal = refusalFromServiceError(
      "request_push",
      err("PUSH_SOURCE_MISSING", { refusal: "no_checkpoint" }),
    );
    expect(JSON.stringify(refusal)).not.toContain("text a model could read");
    expect(refusal).not.toHaveProperty("message");
  });
});

describe("a person's reason survives the tool answer", () => {
  const SESSION = "11111111-1111-4111-8111-111111111111";
  const PUSH = "22222222-2222-4222-8222-222222222222";
  const COMMIT = "a".repeat(40);
  const CATALOG = {
    connections: {},
    repositories: {},
  } satisfies SessionCatalog;

  function row(overrides: Partial<PushRequest>): PushRequest {
    return {
      id: PUSH,
      session_id: SESSION,
      repository_id: "app",
      checkpoint_revision: 1,
      git_commit: COMMIT,
      target_branch: "agent/x",
      state: "requested",
      requested_by: {
        principal: { kind: "user", id: "u" },
        actor_user_id: null,
        agent_id: null,
      },
      requested_at: "2026-11-05T00:00:00.000Z",
      resolved_by: null,
      resolved_at: null,
      resolution_reason: null,
      request_receipt_id: "66666666-6666-4666-8666-666666666666",
      resolution_receipt_id: null,
      finished_at: null,
      push_receipt_id: null,
      ...overrides,
    } as PushRequest;
  }

  /** The push request service over a store that keeps what `decide` is given. */
  function world() {
    let stored = row({});
    const store = {
      decide: async (input: { decision: string; reason: string | null }) => {
        stored = row({
          state: input.decision === "reject" ? "rejected" : "approved",
          resolution_reason: input.reason,
        });
        return { outcome: "written", request: stored };
      },
      get: async () => stored,
    } as unknown as PushRequestStore;
    const pushesWith = (authorization: AuthorizationPolicy) =>
      createPushRequestService({
        authorization,
        store,
        catalog: CATALOG,
        intents: {} as never,
        source: {
          readPushSource: async () => ({ status: "none" }),
          readPushSourceAt: async () => ({ status: "none" }),
        },
      });
    const pushes = pushesWith(
      createAuthorizationPolicy({
        sessions: { visibleTo: async () => true, originOf: async () => null },
      }),
    );
    const principal = {
      kind: "api_key",
      id: "key-1",
      owner_id: "owner-a",
      scopes: ["sessions:approve"],
    } as unknown as Principal;
    const decider = {
      caller: testCaller("owner-a"),
      principal,
      ownerId: "owner-a",
      verified: true,
    };
    // The MCP side runs under the session-bound authorization, as in production.
    const services = (
      authorization: AuthorizationPolicy,
    ): GitHubMcpServices => ({
      pushRequests: pushesWith(authorization),
      pullRequests: {
        // `open_pull_request` goes through the schedule; this fake refuses it
        // the way the open path does.
        schedule(actor, sessionId, ref, input) {
          return this.open(
            actor,
            sessionId,
            ref.pushRequestId as string,
            input,
          );
        },
        open: async () => {
          throw new SessionServiceError("PUSH_NOT_PUSHED", "x", undefined, {
            refusal: "not_pushed",
            receipt_id: "receipt-pr",
            push_request_state: stored.state,
          });
        },
        update: async () => {
          throw new Error("not used");
        },
        comment: async () => {
          throw new Error("not used");
        },
        setState: async () => {
          throw new Error("not used");
        },
        merge: async () => {
          throw new Error("not used");
        },
      },
      githubWork: {} as never,
      attachments: {} as never,
    });
    const handle = createGitHubMcpServer({
      store: {
        sessionState: async () => ({
          ownerId: "owner-a",
          agentId: "agent-1",
          releaseId: "release-1",
          source: "release",
          github: {
            repositories: ["app"],
            push_approval: true,
            features: {
              workflows: false,
              actions: false,
              checks: false,
              issues: false,
              review: false,
            },
            actions_allow: [],
          },
          enabled: true,
          actor: stored.requested_by,
        }),
        runningTurn: async () => null,
      },
      services,
    });
    return { pushes, decider, handle };
  }

  const openPullRequest = async (
    handle: ReturnType<typeof world>["handle"],
  ) => {
    const answer = (await handle(
      { sessionId: SESSION, attemptId: "att_1" },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "open_pull_request",
          arguments: { push_request_id: PUSH },
        },
      },
      "req-1",
    )) as unknown as { result: { structuredContent: unknown } };
    return answer.result.structuredContent;
  };

  test("the web's reason comes back word for word under by: person", async () => {
    const { pushes, decider, handle } = world();
    const words = "Not this way.\nUse the `v2` API — 한국어 <b>그대로</b>";
    await pushes.decide(decider, SESSION, PUSH, {
      idempotencyKey: "web-1",
      readBody: async () => ({
        decision: "reject",
        git_commit: COMMIT,
        reason: words,
      }),
    });
    expect(await openPullRequest(handle)).toMatchObject({
      ok: false,
      refusal: {
        code: "push_rejected",
        by: "person",
        retryable: false,
        details: { push_request_id: PUSH, reason: words },
      },
    });
  });

  test("a Slack button carries no reason, and the answer carries none either", async () => {
    const { pushes, decider, handle } = world();
    // The body Slack's decidePush sends: no reason field.
    await pushes.decide(decider, SESSION, PUSH, {
      idempotencyKey: `slack:${PUSH}:U1`,
      readBody: async () => ({ decision: "reject", git_commit: COMMIT }),
    });
    const answer = (await openPullRequest(handle)) as {
      refusal: { code: string; by: string; details: Record<string, unknown> };
    };
    expect(answer.refusal).toMatchObject({
      code: "push_rejected",
      by: "person",
    });
    expect(answer.refusal.details).not.toHaveProperty("reason");
  });
});
