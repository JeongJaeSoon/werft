import { describe, expect, test } from "bun:test";
import { SESSION_SCOPE_VALUES } from "@werft-ai/contracts";
import { callerFor } from "../musterrolle/policy.ts";
import type {
  CallerLimitDimension,
  CallerLimitGate,
} from "../ports/agent-caller-limits-store.ts";
import type {
  AcceptSessionInput,
  AcceptSessionResult,
  AppendMessageInput,
  AppendMessageResult,
} from "../ports/session-unit-of-work.ts";
import { withSeededInstallation } from "./profile-registry.ts";
import {
  createSessionService,
  type SessionServiceError,
} from "./session-service.ts";

const AGENT = "019a0000-0000-7000-8000-00000000b0a1";
const SESSION = "019a0000-0000-7000-8000-00000000e0a1";
const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const USER = "019a0000-0000-7000-8000-0000000000a1";
const RECEIPT = "019a0000-0000-7000-8000-00000000c0a1";

function setup(options: {
  gate?: CallerLimitDimension | null;
  accept?: AcceptSessionResult;
  append?: AppendMessageResult;
}) {
  const asked: Parameters<CallerLimitGate["startRefusal"]>[0][] = [];
  const accepted: AcceptSessionInput[] = [];
  const appended: AppendMessageInput[] = [];
  const service = createSessionService({
    authorization: {
      async authorize() {
        return {
          outcome: "allow",
          reason_code: "ok",
          effective_scopes: [],
          policy_version: "test",
          decision_id: "019a0000-0000-7000-8000-00000000d0a1",
        };
      },
    },
    catalog: withSeededInstallation({ profiles: {}, repositories: {} }),
    controls: {} as never,
    reader: { getSession: async () => null } as never,
    limits: {
      queuedInputLimitPerSession: 10,
      storageLimitBytes: 1e9,
      sessionCostLimitUsd: 100,
      sessionTokenLimit: null,
    },
    callerLimits: {
      async startRefusal(input) {
        asked.push(input);
        return options.gate ?? null;
      },
    },
    releases: {
      async resolveRelease(_workspaceId, releaseId) {
        return {
          id: releaseId,
          agent_id: AGENT,
          approved_at: "2026-01-01T00:00:00.000Z",
          runtime_profile_id: "coding-v1",
          repository_id: null,
          runtime_config_snapshot: {},
          policy_pins: {},
        };
      },
      notRunnableReason: async () => null,
      agentGitHubSettings: async () => null,
      repositoryCeiling: async () => null,
    },
    inputs: {
      async acceptInputAtomic(input) {
        accepted.push(input);
        if (input.callerLimited !== undefined && options.accept === undefined) {
          return { outcome: "caller_limited", dimension: input.callerLimited };
        }
        return (
          options.accept ?? {
            outcome: "accepted",
            response: {
              session_id: SESSION,
              turn_id: "1",
              receipt_id: RECEIPT,
              receipt_status: "accepted",
              status: "queued",
            },
          }
        );
      },
      async appendInputAtomic(input) {
        appended.push(input);
        return (
          options.append ?? {
            outcome: "accepted",
            response: {
              turn_id: "2",
              receipt_id: RECEIPT,
              receipt_status: "accepted",
            },
          }
        );
      },
    },
  });
  return { service, asked, accepted, appended };
}

const actor = callerFor(
  {
    kind: "user",
    id: USER,
    workspace_id: WORKSPACE,
    role: "member",
    scopes: SESSION_SCOPE_VALUES.filter(
      (scope) => scope !== "sessions:recover",
    ),
  },
  { kind: "slack", channel_id: "C0ABC" } as never,
  "req-1",
);
const start = {
  idempotencyKey: "key-1",
  body: { agent_release_id: "rel-1", message: "hello" },
};

async function failure(promise: Promise<unknown>) {
  return promise.then(
    () => {
      throw new Error("expected a refusal");
    },
    (error: unknown) => error as SessionServiceError,
  );
}

describe("a start against the caller's limit", () => {
  test("asks the gate about the caller, their channel and the repositories", async () => {
    const { service, asked, accepted } = setup({});
    await service.createSession(actor, start as never);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      releaseId: "rel-1",
      channelId: "C0ABC",
      repositoryIds: [],
    });
    expect(accepted[0]?.callerLimited).toBeUndefined();
    expect(accepted[0]?.callerSubject).toBe(actor.subject);
  });

  test("is refused 403 caller_limited with the dimension and nothing else, and the write replays by key", async () => {
    const { service, accepted } = setup({ gate: "repository" });
    const error = await failure(service.createSession(actor, start as never));
    expect(error.code).toBe("FORBIDDEN");
    expect(error.details).toEqual({
      reason_code: "caller_limited",
      dimension: "repository",
    });
    expect(accepted[0]?.callerLimited).toBe("repository");
  });

  test("answers the write's own refusal the same way, whatever the gate said", async () => {
    const { service } = setup({
      accept: { outcome: "caller_limited", dimension: "credential" },
    });
    const error = await failure(service.createSession(actor, start as never));
    expect(error.code).toBe("FORBIDDEN");
    expect(error.details).toEqual({
      reason_code: "caller_limited",
      dimension: "credential",
    });
  });
});

describe("an input against the sender's limit", () => {
  test("hands the write who asked and is refused with the write's dimension", async () => {
    const { service, appended } = setup({
      append: { outcome: "caller_limited", dimension: "tool" },
    });
    const error = await failure(
      service.appendMessage(actor, SESSION, {
        idempotencyKey: "key-2",
        body: { message: "more" },
      } as never),
    );
    expect(error.code).toBe("FORBIDDEN");
    expect(error.details).toEqual({
      reason_code: "caller_limited",
      dimension: "tool",
    });
    expect(appended[0]?.callerSubject).toBe(actor.subject);
  });
});
