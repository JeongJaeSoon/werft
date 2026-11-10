import { describe, expect, test } from "bun:test";
import { type ApiErrorCode, apiErrorResponseSchema } from "@werft-ai/contracts";
import {
  type ChangeProfileInput,
  type ChangeProfileResult,
  createAuthorizationPolicy,
  createSessionService,
  profileFingerprint,
  profilePins,
  profileWithModel,
  type SessionCatalog,
  type SessionControl,
  type SessionDetailRecord,
  withSeededInstallation,
} from "@werft-ai/platform";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerSessionRoutes } from "./sessions.ts";

const createApiApp = recordRouteErrors("routes/profile.test.ts");

const sessionId = "019a0000-0000-7000-8000-000000000001";
const path = `/v1/sessions/${sessionId}/profile`;

const notReached = async (): Promise<never> => {
  throw new Error("not reached");
};

const sonnet: SessionCatalog["profiles"][string] = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  tools: ["Read", "Edit", "Bash"],
  permission_mode: "default",
  provider: {
    kind: "anthropic",
    endpoint: "https://api.anthropic.com",
    auth: {
      kind: "api_key",
      value: "catalog-provider-key",
      ref: { value_env: "ANTHROPIC_API_KEY" },
    },
  },
};
const haiku = { ...sonnet, model: "claude-haiku-5" };
const catalog: SessionCatalog = withSeededInstallation({
  profiles: {
    "coding-sonnet": { ...sonnet, models: ["claude-opus-5"] },
    "coding-haiku": haiku,
    "coding-next-runtime": { ...sonnet, runtime_version: "0.4.0" },
    "coding-local": {
      ...sonnet,
      provider: { ...sonnet.provider, billing: "none" },
    },
    // In the catalog, but the session's repository does not allow it.
    "review-only": { ...sonnet, model: "claude-opus-5" },
  },
  repositories: {
    app: {
      url: "https://example.invalid/app.git",
      branch: "main",
      auth: { kind: "github_app", registered: true } as const,
      profiles: [
        "coding-sonnet",
        "coding-haiku",
        "coding-next-runtime",
        "coding-local",
      ],
    },
  },
});

const record: SessionDetailRecord = {
  id: sessionId,
  title: null,
  agent: null,
  agent_hidden: false,
  created_by: null,
  channel: null,
  slack_permalink: null,
  revision: 7,
  admission_state: "active",
  status: "idle",
  model: "claude-sonnet-5",
  repository_id: "app",
  repository: { id: "app", full_name: "app", branch: "main" },
  current_turn_id: null,
  queued_turn_count: 0,
  last_event_at: null,
  created_at: "2026-10-13T00:00:00.000Z",
  updated_at: "2026-10-13T00:00:00.000Z",
  execution: null,
  checkpoint_revision: 1,
  pending_request_count: 0,
  attention: null,
  durability: {
    last_transcript_persisted_at: null,
    checkpoint_committed_at: null,
    checkpoint_revision: 1,
    last_completed_turn_id: "1",
    last_checkpointed_turn_id: "1",
    checkpoint_pending_reason: null,
    checkpoint_fallback_revision: null,
    context_reset_turn_id: null,
  },
  profile_id: "coding-sonnet",
  cost_usd: 0.02,
  provider_tokens: 100,
  repo_url: "https://example.invalid/app.git",
  branch: "main",
  repository_mode: "repository",
  github_policy_source: "release",
  profile_fingerprint: profileFingerprint(sonnet),
  auto_model_migration: true,
};

function change(
  body: unknown,
  changeProfileAtomic: SessionControl["changeProfileAtomic"] = notReached,
  headers: Record<string, string> = {},
  at = path,
  session: SessionDetailRecord = record,
) {
  const service = createSessionService({
    limits: {
      queuedInputLimitPerSession: 1_000,
      storageLimitBytes: 1e15,
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
    },
    authorization: createAuthorizationPolicy(),
    catalog,
    inputs: { acceptInputAtomic: notReached, appendInputAtomic: notReached },
    controls: {
      terminateAtomic: notReached,
      pauseAtomic: notReached,
      closeAtomic: notReached,
      decideRecoveryAtomic: notReached,
      resumeAtomic: notReached,
      changeProfileAtomic,
      renameAtomic: notReached,
    },
    reader: {
      listSessions: notReached,
      countSessions: notReached,
      getSession: async (ownerId, id) =>
        ownerId === "owner-a" && id === sessionId ? session : null,
      listTurns: notReached,
      getTurn: notReached,
      getReceipt: notReached,
      readEvents: notReached,
    },
  });
  const app = createApiApp({
    authMode: "none",
    registerRoutes: (router) => registerSessionRoutes(router, service),
  });
  return app.request(at, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Owner-Id": "owner-a",
      "Idempotency-Key": "key-1",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function errorCode(response: Response) {
  return apiErrorResponseSchema.parse(await response.json()).error.code;
}

function capturing(result: ChangeProfileResult) {
  const seen: ChangeProfileInput[] = [];
  const atomic: SessionControl["changeProfileAtomic"] = async (input) => {
    seen.push(input);
    return result;
  };
  return { seen, atomic };
}

const settled = (receiptId: string): ChangeProfileResult => ({
  outcome: "accepted",
  response: { receipt_id: receiptId, receipt_status: "succeeded" },
});

describe("POST /v1/sessions/{id}/profile", () => {
  test("answers 200 with a settled receipt, handing the judged profile to the transaction", async () => {
    const receiptId = crypto.randomUUID();
    const { seen, atomic } = capturing(settled(receiptId));
    const response = await change(
      { expected_revision: 7, profile_id: "coding-haiku" },
      atomic,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      receipt_id: receiptId,
      receipt_status: "succeeded",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      principal: { ownerId: "owner-a" },
      sessionId,
      idempotencyKey: "key-1",
      expectedRevision: 7,
      judgedFrom: "coding-sonnet",
      profile: {
        id: "coding-haiku",
        fingerprint: profileFingerprint(haiku),
        model: "claude-haiku-5",
        unmetered: false,
      },
    });
  });

  test("a session created on another of its profile's models changes too, onto the new profile's default model", async () => {
    const onOpus = profileWithModel(
      catalog.profiles["coding-sonnet"] as SessionCatalog["profiles"][string],
      "claude-opus-5",
    );
    if (!onOpus) throw new Error("coding-sonnet offers claude-opus-5");
    const { seen, atomic } = capturing(settled(crypto.randomUUID()));
    const response = await change(
      { expected_revision: 7, profile_id: "coding-haiku" },
      atomic,
      {},
      path,
      {
        ...record,
        profile_fingerprint: profileFingerprint(onOpus),
        model: "claude-opus-5",
      },
    );
    expect(response.status).toBe(200);
    expect(seen[0]?.profile).toEqual({
      id: "coding-haiku",
      fingerprint: profileFingerprint(haiku),
      model: "claude-haiku-5",
      unmetered: false,
    });
  });

  test("the same profile again keeps a version 1 pin on its default model, and moves one on another model to the default", async () => {
    const listed = catalog.profiles[
      "coding-sonnet"
    ] as SessionCatalog["profiles"][string];
    const [, , v1Sonnet, v1Opus] = profilePins(listed, []);
    if (!v1Sonnet || !v1Opus) throw new Error("no version 1 pins");
    for (const [pinned, fingerprint] of [
      [v1Sonnet.fingerprint, v1Sonnet.fingerprint],
      [v1Opus.fingerprint, profileFingerprint(listed)],
    ] as const) {
      const { seen, atomic } = capturing(settled(crypto.randomUUID()));
      const response = await change(
        { expected_revision: 7, profile_id: "coding-sonnet" },
        atomic,
        {},
        path,
        { ...record, profile_fingerprint: pinned, model: null },
      );
      expect(response.status).toBe(200);
      expect(seen[0]?.profile).toEqual({
        id: "coding-sonnet",
        fingerprint,
        model: "claude-sonnet-5",
        unmetered: false,
      });
    }
  });

  test("hands a billing: none profile over as unmetered, for the transaction to compare", async () => {
    const { seen, atomic } = capturing({ outcome: "billing_mismatch" });
    const response = await change(
      { expected_revision: 7, profile_id: "coding-local" },
      atomic,
    );
    expect([response.status, await errorCode(response)]).toEqual([
      422,
      "UNSUPPORTED_CAPABILITY",
    ]);
    expect(seen[0]?.profile?.unmetered).toBe(true);
  });

  test("a profile the catalog refuses reaches the transaction as null, so a replay still answers", async () => {
    for (const profileId of [
      "no-such-profile",
      "review-only",
      "coding-next-runtime",
    ]) {
      const { seen, atomic } = capturing({ outcome: "unsupported" });
      const response = await change(
        { expected_revision: 7, profile_id: profileId },
        atomic,
      );
      expect([response.status, await errorCode(response)]).toEqual([
        422,
        "UNSUPPORTED_CAPABILITY",
      ]);
      expect(seen[0]?.profile).toBeNull();
    }
    const receiptId = crypto.randomUUID();
    const replay = await change(
      { expected_revision: 7, profile_id: "no-such-profile" },
      async () => ({
        outcome: "replayed",
        response: { receipt_id: receiptId, receipt_status: "succeeded" },
      }),
    );
    expect(replay.status).toBe(200);
  });

  test("refuses when the session's own profile is gone or redefined, since its runtime cannot be checked", async () => {
    for (const fingerprint of [
      profileFingerprint({ ...sonnet, runtime_version: "0.2.0" }),
    ]) {
      const { seen, atomic } = capturing({ outcome: "unsupported" });
      const response = await change(
        { expected_revision: 7, profile_id: "coding-next-runtime" },
        atomic,
        {},
        path,
        { ...record, profile_fingerprint: fingerprint },
      );
      expect([response.status, await errorCode(response)]).toEqual([
        422,
        "UNSUPPORTED_CAPABILITY",
      ]);
      expect(seen[0]?.profile).toBeNull();
    }
    const { seen, atomic } = capturing({ outcome: "unsupported" });
    await change(
      { expected_revision: 7, profile_id: "coding-haiku" },
      atomic,
      {},
      path,
      { ...record, profile_id: "removed-profile" },
    );
    expect(seen[0]?.profile).toBeNull();
  });

  test("says why the runtime refuses it", async () => {
    const response = await change(
      { expected_revision: 7, profile_id: "coding-next-runtime" },
      async () => ({ outcome: "unsupported" }),
    );
    const body = apiErrorResponseSchema.parse(await response.json());
    expect(body.error.message).toContain("0.4.0");
    expect(body.error.message).toContain("0.3.270");
  });

  test("requires Idempotency-Key, expected_revision and profile_id, and rejects extra fields", async () => {
    expect(
      (
        await change({ expected_revision: 1, profile_id: "x" }, notReached, {
          "Idempotency-Key": "",
        })
      ).status,
    ).toBe(400);
    expect((await change({ profile_id: "coding-haiku" })).status).toBe(400);
    expect((await change({ expected_revision: 1 })).status).toBe(400);
    expect(
      (
        await change({
          expected_revision: 1,
          profile_id: "coding-haiku",
          model: "claude-opus-5",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await change({
          expected_revision: 1,
          profile_id: "x".repeat(65 * 1024),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await change(
          { expected_revision: 1, profile_id: "coding-haiku" },
          notReached,
          {},
          "/v1/sessions/not-a-uuid/profile",
        )
      ).status,
    ).toBe(404);
  });

  test("a session the caller cannot see is 404 before anything is judged", async () => {
    const response = await change(
      { expected_revision: 7, profile_id: "coding-haiku" },
      notReached,
      { "X-Owner-Id": "owner-b" },
    );
    expect([response.status, await errorCode(response)]).toEqual([
      404,
      "NOT_FOUND",
    ]);
  });

  test("maps each refusal to its status and code", async () => {
    const cases: Array<[ChangeProfileResult, number, ApiErrorCode]> = [
      [
        { outcome: "revision_conflict", currentRevision: 8 },
        409,
        "REVISION_CONFLICT",
      ],
      [{ outcome: "conflict" }, 409, "IDEMPOTENCY_CONFLICT"],
      [
        { outcome: "rejected", admissionState: "pausing" },
        409,
        "SESSION_PAUSED",
      ],
      [
        { outcome: "rejected", admissionState: "resuming" },
        409,
        "SESSION_RESUMING",
      ],
      [
        { outcome: "rejected", admissionState: "stopping" },
        409,
        "SESSION_STOPPED",
      ],
      [
        { outcome: "rejected", admissionState: "recovery_required" },
        409,
        "RECOVERY_REQUIRED",
      ],
      [
        { outcome: "rejected", admissionState: "closed" },
        409,
        "SESSION_CLOSED",
      ],
      [
        { outcome: "release_bound", releaseId: "rel_1" },
        409,
        "RELEASE_PROFILE_MISMATCH",
      ],
      [{ outcome: "billing_mismatch" }, 422, "UNSUPPORTED_CAPABILITY"],
      [{ outcome: "not_found" }, 404, "NOT_FOUND"],
    ];
    for (const [result, status, code] of cases) {
      const response = await change(
        { expected_revision: 7, profile_id: "coding-haiku" },
        async () => result,
      );
      expect([response.status, await errorCode(response)]).toEqual([
        status,
        code,
      ]);
    }
  });
});
