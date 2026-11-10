import { describe, expect, test } from "bun:test";
import type {
  AuthorizationDecision,
  AuthorizationReason,
  AuthorizationRequest,
} from "@werft-ai/contracts";
import { SESSION_SCOPE_VALUES } from "@werft-ai/contracts";
import type { UsageDecision } from "../musterrolle/agent-usage-decision.ts";
import { type AuthorizationPolicy, callerFor } from "../musterrolle/policy.ts";
import type {
  AcceptSessionInput,
  AcceptSessionResult,
  AppendMessageInput,
  AppendMessageResult,
} from "../ports/session-unit-of-work.ts";
import { withSeededInstallation } from "./profile-registry.ts";
import {
  createSessionService,
  SessionServiceError,
} from "./session-service.ts";

const AGENT = "019a0000-0000-7000-8000-00000000b0a1";
const SESSION = "019a0000-0000-7000-8000-00000000e0a1";
const RESPONSE = {
  session_id: SESSION,
  turn_id: "1",
  receipt_id: "019a0000-0000-7000-8000-00000000c0a1",
  receipt_status: "accepted",
  status: "queued",
} as const;

const shapeOf = (error: unknown) => {
  const e = error as SessionServiceError;
  return JSON.stringify({
    name: e.name,
    code: e.code,
    message: e.message,
    details: e.details,
    retry: e.retry,
  });
};

function decision(reason: AuthorizationReason): AuthorizationDecision {
  return {
    outcome: reason === "ok" ? "allow" : "deny",
    reason_code: reason,
    effective_scopes: [],
    policy_version: "test",
    decision_id: "019a0000-0000-7000-8000-00000000d0a1",
  };
}

function setup(options: {
  /** What the policy says about the start; absent, `ok`. */
  decides?: AuthorizationReason;
  usage?: UsageDecision;
  accept?: AcceptSessionResult["outcome"];
  append?: AppendMessageResult["outcome"];
  /** The release reads fine; absent, its integrity check fails. */
  releaseResolves?: true;
}) {
  const asked: AuthorizationRequest[] = [];
  const accepted: AcceptSessionInput[] = [];
  const appended: AppendMessageInput[] = [];
  let resolved = 0;
  const authorization: AuthorizationPolicy = {
    async authorize(request) {
      asked.push(request);
      return decision(options.decides ?? "ok");
    },
    ...(options.usage === undefined
      ? {}
      : {
          usageOfRelease: async () => ({
            agentId: AGENT,
            usage: options.usage as UsageDecision,
          }),
        }),
  };
  const service = createSessionService({
    authorization,
    catalog: withSeededInstallation({ profiles: {}, repositories: {} }),
    controls: {} as never,
    reader: { getSession: async () => null } as never,
    limits: {
      queuedInputLimitPerSession: 10,
      storageLimitBytes: 1e9,
      sessionCostLimitUsd: 100,
      sessionTokenLimit: null,
    },
    releases: {
      async resolveRelease(_workspaceId, releaseId) {
        resolved++;
        if (releaseId !== "rel-1") {
          throw new SessionServiceError("NOT_FOUND", "Resource not found");
        }
        if (options.releaseResolves) {
          return {
            id: releaseId,
            agent_id: AGENT,
            approved_at: "2026-01-01T00:00:00.000Z",
            runtime_profile_id: "coding-v1",
            repository_id: null,
            runtime_config_snapshot: {},
            policy_pins: {},
          };
        }
        // Reached only for someone who may see the agent.
        throw new SessionServiceError(
          "PROFILE_DIGEST_MISMATCH",
          "the release's integrity is broken",
        );
      },
      notRunnableReason: async () => null,
      agentGitHubSettings: async () => null,
      repositoryCeiling: async () => null,
    },
    inputs: {
      async acceptInputAtomic(input) {
        accepted.push(input);
        const outcome = options.accept ?? "accepted";
        return outcome === "accepted" || outcome === "replayed"
          ? { outcome, response: RESPONSE }
          : ({ outcome } as AcceptSessionResult);
      },
      async appendInputAtomic(input) {
        appended.push(input);
        const outcome = options.append ?? "accepted";
        return outcome === "accepted" || outcome === "replayed"
          ? {
              outcome,
              response: {
                turn_id: "2",
                receipt_id: RESPONSE.receipt_id,
                receipt_status: "accepted",
              },
            }
          : ({ outcome } as AppendMessageResult);
      },
    },
  });
  return {
    service,
    asked,
    accepted,
    appended,
    resolved: () => resolved,
  };
}

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const actor = callerFor(
  {
    kind: "user",
    id: "019a0000-0000-7000-8000-0000000000a1",
    workspace_id: WORKSPACE,
    role: "member",
    scopes: SESSION_SCOPE_VALUES.filter(
      (scope) => scope !== "sessions:recover",
    ),
  },
  { kind: "web" },
  "req-1",
);
const start = (release: string) => ({
  idempotencyKey: "key-1",
  body: { agent_release_id: release, message: "hello" },
});

async function failure(promise: Promise<unknown>) {
  return promise.then(
    () => {
      throw new Error("expected a refusal");
    },
    (error: unknown) => error,
  );
}

describe("a start of a private agent by someone outside it", () => {
  const closed: UsageDecision = { allowed: false };

  test("is answered byte for byte as a release that is not there", async () => {
    const { service, resolved } = setup({
      usage: closed,
      accept: "agent_private",
    });
    const hidden = await failure(
      service.createSession(actor, start("rel-1") as never),
    );
    const missingSetup = setup({});
    const missing = await failure(
      missingSetup.service.createSession(actor, start("rel-gone") as never),
    );
    expect(hidden).toBeInstanceOf(SessionServiceError);
    expect(shapeOf(hidden)).toBe(shapeOf(missing));
    expect((hidden as SessionServiceError).code).toBe("NOT_FOUND");
    // The integrity of the release is never looked at.
    expect(resolved()).toBe(0);
  });

  test("keeps the policy's own reason in the log and changes nothing for the caller", async () => {
    for (const reason of [
      "role",
      "agent_ceiling",
      "surface_ceiling",
    ] as const) {
      const { service, asked } = setup({
        usage: closed,
        decides: reason,
        accept: "agent_private",
      });
      const error = await failure(
        service.createSession(actor, start("rel-1") as never),
      );
      expect((error as SessionServiceError).code).toBe("NOT_FOUND");
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatchObject({
        action: "session.submit",
        resource: { agent_id: AGENT, release_id: "rel-1" },
      });
    }
  });

  test("hands the write the visibility result and no more", async () => {
    const { service, accepted } = setup({
      usage: closed,
      accept: "agent_private",
    });
    await failure(service.createSession(actor, start("rel-1") as never));
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      agentPrivate: true,
      agentReleaseId: "rel-1",
      idempotencyKey: "key-1",
    });
    expect(accepted[0]?.credentialsUnbound).toBeUndefined();
    expect(accepted[0]?.notRunnableReason).toBeUndefined();
  });

  test("still gets the stored answer of an earlier acceptance of the same key", async () => {
    const { service } = setup({ usage: closed, accept: "replayed" });
    expect(await service.createSession(actor, start("rel-1") as never)).toEqual(
      RESPONSE,
    );
  });

  // A missing release never reaches the write, so whatever the write finds
  // (a key reused for another body, a key that does not reach the agent, a
  // requester gone) must read as the missing release too.
  for (const outcome of ["conflict", "actor_inactive"] as const) {
    test(`a write that finds ${outcome} still answers as a missing release`, async () => {
      const { service } = setup({ usage: closed, accept: outcome });
      const hidden = await failure(
        service.createSession(actor, start("rel-1") as never),
      );
      const missing = await failure(
        setup({}).service.createSession(actor, start("rel-gone") as never),
      );
      expect(shapeOf(hidden)).toBe(shapeOf(missing));
    });
  }
});

describe("an agent that turned private after the release was read", () => {
  test("someone who may see the agent meets the integrity check", async () => {
    const open = setup({
      usage: { allowed: true, basis: "public", teamId: null },
    });
    const error = await failure(
      open.service.createSession(actor, start("rel-1") as never),
    );
    expect((error as SessionServiceError).code).toBe("PROFILE_DIGEST_MISMATCH");
    expect(open.resolved()).toBe(1);
  });

  test("a policy refusal agent_private after the release was read is a missing release", async () => {
    const { service, accepted, asked } = setup({
      usage: { allowed: true, basis: "public", teamId: null },
      releaseResolves: true,
      decides: "agent_private",
      accept: "agent_private",
    });
    const error = await failure(
      service.createSession(actor, start("rel-1") as never),
    );
    expect((error as SessionServiceError).code).toBe("NOT_FOUND");
    expect(shapeOf(error)).toBe(
      shapeOf(new SessionServiceError("NOT_FOUND", "Resource not found")),
    );
    expect(accepted[0]).toMatchObject({ agentPrivate: true });
    // Judged for the start, then again for the log of the hidden one.
    expect(asked).toHaveLength(2);
  });
});

describe("an input to a session whose agent is private to the requester", () => {
  const send = (service: ReturnType<typeof setup>["service"]) =>
    service.appendMessage(actor, SESSION, {
      idempotencyKey: "key-2",
      body: { message: "more", mode: "enqueue" },
    });

  test("is 403 FORBIDDEN agent_private with no admin contact", async () => {
    const { service, appended } = setup({
      decides: "agent_private",
      append: "agent_private",
    });
    const error = (await failure(send(service))) as SessionServiceError;
    expect(error.code).toBe("FORBIDDEN");
    expect(error.details).toEqual({ reason_code: "agent_private" });
    expect(appended[0]?.agentPrivate).toBe(true);
  });

  test("a retry of an input taken before the requester lost the agent is answered", async () => {
    const { service } = setup({ decides: "agent_private", append: "replayed" });
    expect(await send(service)).toMatchObject({ turn_id: "2" });
  });

  test("a requester the policy let through is judged again by the write", async () => {
    const { service, appended } = setup({ append: "agent_private" });
    const error = (await failure(send(service))) as SessionServiceError;
    expect(error.code).toBe("FORBIDDEN");
    expect(error.details).toEqual({ reason_code: "agent_private" });
    expect(appended[0]?.agentPrivate).toBeUndefined();
  });

  test("a session out of the requester's sight is still not found", async () => {
    const { service } = setup({ decides: "not_found" });
    const error = (await failure(send(service))) as SessionServiceError;
    expect(error.code).toBe("NOT_FOUND");
  });
});
