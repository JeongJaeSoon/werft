import { describe, expect, test } from "bun:test";
import {
  bootstrapClaimResponseSchema,
  GITHUB_CEILING_NONE,
  GITHUB_FEATURES_NONE,
  type PlatformPrompt,
  type RuntimeConfig,
  runtimeConfigSchema,
} from "@werft-ai/contracts";
import { acceptAllCheckpoints } from "../ports/checkpoint-verifier.ts";
import {
  type GitHubConnection,
  type GitHubGate,
  GitHubGateError,
  type GitHubGateReceipt,
  type GitHubGrant,
  type GitHubSessionContext,
  type GitHubWork,
} from "../ports/github-gate.ts";
import type { SessionAttributionRecord } from "../ports/session-attribution.ts";
import type {
  ClaimInput,
  EgressAuthorization,
  FailResumeInput,
  NextInputInput,
  ReadyInput,
  RestoreBaseInput,
  RestoreBaseResult,
  WorkerBinding,
  WorkerUnitOfWork,
} from "../ports/worker-unit-of-work.ts";
import {
  type CatalogProfile,
  type CatalogRepository,
  profileFingerprint,
  profilePins,
  repositoryBinding,
  type SessionCatalog,
} from "../sessions/catalog.ts";
import type { GitHubConnectionResolver } from "../sessions/github-connection-resolver.ts";
import { createGitHubGate } from "../sessions/github-gate.ts";
import { withSeededInstallation } from "../sessions/profile-registry.ts";
import { releasePolicy } from "../testing/github-fakes.ts";
import {
  type CheckpointProtocol,
  createWorkerGateway,
  hashWorkerToken,
  WorkerGatewayError,
} from "./worker-gateway.ts";

const withoutPolicyPairs = (pairs: ClaimInput["runnable"]) =>
  pairs.filter((pair) => pair.policy !== true);

const scope = {
  session_id: "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d",
  turn_id: null,
  attempt_id: "att_1",
  lease_epoch: 1,
  execution_generation: 1,
  auth_revision: 0,
};
const fingerprint = {
  engine: "claude",
  sdk_version: "0.3.270",
  cli_version: "2.1.270",
  profile_sha256: "c".repeat(64),
};
const principal = {
  kind: "session",
  attemptId: "att_1",
  sessionId: scope.session_id,
  leaseEpoch: scope.lease_epoch,
  executionGeneration: scope.execution_generation,
  authRevision: scope.auth_revision,
} as const;

function unimplemented(): never {
  throw new Error("not reached");
}

function work(overrides: Partial<WorkerUnitOfWork>): WorkerUnitOfWork {
  return {
    claimAtomic: unimplemented,
    resolveCredential: unimplemented,
    authorizeEgressAtomic: unimplemented,
    recordModelCutAtomic: unimplemented,
    recordProviderUsageAtomic: unimplemented,
    nextInputAtomic: unimplemented,
    heartbeatAtomic: unimplemented,
    commitEventsAtomic: unimplemented,
    peekFinalizeAtomic: async () => ({ outcome: "open" }),
    finalizeAtomic: unimplemented,
    checkpointStateAtomic: unimplemented,
    recordRestoreBaseAtomic: unimplemented,
    releaseAtomic: unimplemented,
    readyAtomic: unimplemented,
    failResumeAtomic: unimplemented,
    confirmExecutionGoneAtomic: unimplemented,
    ...overrides,
  };
}

function gateway(
  overrides: Partial<WorkerUnitOfWork>,
  clock: { now: Date } = { now: new Date("2026-09-22T00:00:00Z") },
) {
  const slept: number[] = [];
  const instance = createWorkerGateway({
    work: work(overrides),
    catalog: { profiles: {}, repositories: {} },
    checkpoints: acceptAllCheckpoints,
    options: {
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
      leaseTtlMs: 30_000,
      maxWaitMs: 1_000,
      pollIntervalMs: 100,
      now: () => clock.now,
      sleep: async (ms) => {
        slept.push(ms);
        clock.now = new Date(clock.now.getTime() + ms);
      },
    },
  });
  return { instance, slept };
}

describe("WorkerGateway", () => {
  test("nextInput polls until input arrives and caps wait_ms at maxWaitMs", async () => {
    let calls = 0;
    const seen: NextInputInput[] = [];
    const { instance, slept } = gateway({
      async nextInputAtomic(input) {
        seen.push(input);
        calls += 1;
        return {
          outcome: "ok",
          leaseExpiresAt: new Date(input.now.getTime() + 30_000),
          input:
            calls === 3
              ? {
                  turnId: "1",
                  inputId: "7",
                  message: "go",
                  deliveryStartedAt: input.now,
                }
              : null,
        };
      },
    });
    const response = await instance.nextInput(principal, {
      ...scope,
      wait_ms: 60_000,
    });
    expect(response.input?.turn_id).toBe("1");
    expect(slept).toEqual([100, 100]);
    expect(seen[0]?.fence).toEqual({
      sessionId: scope.session_id,
      attemptId: "att_1",
      leaseEpoch: 1,
      executionGeneration: 1,
      authRevision: 0,
    });

    calls = 0;
    const empty = gateway({
      async nextInputAtomic(input) {
        calls += 1;
        return {
          outcome: "ok",
          input: null,
          leaseExpiresAt: new Date(input.now.getTime() + 30_000),
        };
      },
    });
    const none = await empty.instance.nextInput(principal, {
      ...scope,
      wait_ms: 60_000,
    });
    expect(none.input).toBeNull();
    // 1s cap at 100ms per poll: ten sleeps, eleven attempts.
    expect(empty.slept).toHaveLength(10);
    expect(calls).toBe(11);
  });

  test("nextInput without wait_ms asks once", async () => {
    let calls = 0;
    const { instance, slept } = gateway({
      async nextInputAtomic(input) {
        calls += 1;
        return {
          outcome: "ok",
          input: null,
          leaseExpiresAt: new Date(input.now.getTime() + 30_000),
        };
      },
    });
    await instance.nextInput(principal, scope);
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
  });

  test("nextInput stops waiting once stopWaiting aborts and answers with no input", async () => {
    const stop = new AbortController();
    let calls = 0;
    const slept: number[] = [];
    let at = new Date("2026-09-22T00:00:00.000Z");
    const instance = createWorkerGateway({
      work: work({
        async nextInputAtomic(input) {
          calls += 1;
          if (calls === 2) stop.abort();
          return {
            outcome: "ok",
            input: null,
            leaseExpiresAt: new Date(input.now.getTime() + 30_000),
          };
        },
      }),
      catalog: { profiles: {}, repositories: {} },
      checkpoints: acceptAllCheckpoints,
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 30_000,
        maxWaitMs: 25_000,
        pollIntervalMs: 100,
        stopWaiting: stop.signal,
        now: () => at,
        sleep: async (ms: number) => {
          slept.push(ms);
          at = new Date(at.getTime() + ms);
        },
      },
    });
    const response = await instance.nextInput(principal, {
      ...scope,
      wait_ms: 20_000,
    });
    expect(response).toEqual({
      input: null,
      lease_expires_at: "2026-09-22T00:00:30.100Z",
    });
    expect(calls).toBe(2);
    expect(slept).toEqual([100]);

    calls = 0;
    slept.length = 0;
    await instance.nextInput(principal, { ...scope, wait_ms: 20_000 });
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
  });

  test("fence rejections map to 409 LEASE_EXPIRED / STALE_EPOCH", async () => {
    const { instance } = gateway({
      async heartbeatAtomic() {
        return { outcome: "lease_expired" };
      },
      async commitEventsAtomic() {
        return { outcome: "stale_epoch" };
      },
    });
    await expect(
      instance.heartbeat(principal, { ...scope, attempt_state: "running" }),
    ).rejects.toMatchObject({ status: 409, code: "LEASE_EXPIRED" });
    await expect(
      instance.appendEvents(principal, {
        ...scope,
        batch_key: "b",
        events: [
          {
            event: "status",
            data: { phase: "running" },
            source_sequence: 1,
            occurred_at: "2026-09-22T00:00:00.000Z",
          },
        ],
      }),
    ).rejects.toMatchObject({ status: 409, code: "STALE_EPOCH" });
  });

  test("appended events are stored as sent, the session runtime's neutral fields beside them", async () => {
    const committed: unknown[] = [];
    const neutral: unknown[] = [];
    const asked: Array<string | null> = [];
    const instance = createWorkerGateway({
      work: work({
        async commitEventsAtomic(input) {
          committed.push(...input.events);
          neutral.push(...input.events.map((event) => input.neutral?.(event)));
          return { outcome: "ok", acceptedThrough: 2, cursor: "ev_2" };
        },
      }),
      catalog: { profiles: {}, repositories: {} },
      checkpoints: acceptAllCheckpoints,
      neutralize: (profileId, event) => {
        asked.push(profileId);
        return event.event === "assistant"
          ? { ...event, data: { ...event.data, text: "neutral" } }
          : event;
      },
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 30_000,
        maxWaitMs: 1_000,
        pollIntervalMs: 100,
      },
    });
    const events = [
      {
        event: "assistant" as const,
        data: { type: "assistant" as const, message: { content: [] } },
        source_sequence: 1,
        occurred_at: "2026-09-22T00:00:00.000Z",
      },
      {
        event: "status" as const,
        data: { phase: "running" as const },
        source_sequence: 2,
        occurred_at: "2026-09-22T00:00:00.000Z",
      },
    ];
    await instance.appendEvents(
      { ...principal, profileId: "coding" },
      { ...scope, batch_key: "b", events },
    );
    expect(committed).toEqual(events);
    expect(neutral).toEqual([{ text: "neutral" }, null]);
    expect(asked).toEqual(["coding", "coding"]);
  });

  test("finalize consults the checkpoint verifier before the transaction", async () => {
    let committed = 0;
    // The verifier has to be able to prove the manifest belongs to *this*
    // attempt, so it gets the whole fence and the turn, not just the session.
    const asked: unknown[] = [];
    const instance = createWorkerGateway({
      work: work({
        async finalizeAtomic() {
          committed += 1;
          return unimplemented();
        },
      }),
      catalog: { profiles: {}, repositories: {} },
      checkpoints: {
        async verify(input) {
          asked.push(input);
          return { status: "rejected", reason: "sha mismatch" };
        },
      },
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 30_000,
      },
    });
    await expect(
      instance.finalize(principal, {
        ...scope,
        turn_id: "1",
        finalize_key: "f",
        final_source_sequence: 0,
        terminal: {
          status: "completed",
          reason: null,
          result: null,
          usage: null,
        },
        checkpoint: {
          revision: 1,
          manifest_ref: "ref",
          manifest_sha256: "0".repeat(64),
        },
      }),
    ).rejects.toMatchObject({ status: 409, code: "CHECKPOINT_UNAVAILABLE" });
    expect(committed).toBe(0);
    expect(asked).toEqual([
      {
        fence: {
          sessionId: scope.session_id,
          attemptId: scope.attempt_id,
          leaseEpoch: scope.lease_epoch,
          executionGeneration: scope.execution_generation,
          authRevision: scope.auth_revision,
        },
        turnId: "1",
        checkpoint: {
          revision: 1,
          manifest_ref: "ref",
          manifest_sha256: "0".repeat(64),
        },
        at: expect.any(Date),
      },
    ]);
  });

  test("a manifest past the transcript limits is recorded on the session before finalize refuses it", async () => {
    const recorded: unknown[] = [];
    let committed = 0;
    const instance = createWorkerGateway({
      work: work({
        async checkpointStateAtomic(input) {
          recorded.push(input.pendingReason);
          return {
            outcome: "ok",
            pointer: null,
            restorable: false,
            pendingReason: input.pendingReason ?? null,
          };
        },
        async finalizeAtomic() {
          committed += 1;
          throw new Error("not reached");
        },
      }),
      catalog: { profiles: {}, repositories: {} },
      checkpoints: {
        async verify() {
          return {
            status: "rejected",
            reason: "the transcript is 9 bytes, over the 8-byte limit",
            limit: "transcript_too_large",
          };
        },
      },
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 30_000,
      },
    });
    await expect(
      instance.finalize(principal, {
        ...scope,
        turn_id: "1",
        finalize_key: "f",
        final_source_sequence: 0,
        terminal: {
          status: "completed",
          reason: null,
          result: null,
          usage: null,
        },
        checkpoint: {
          revision: 1,
          manifest_ref: "ref",
          manifest_sha256: "0".repeat(64),
        },
      }),
    ).rejects.toMatchObject({ status: 409, code: "CHECKPOINT_UNAVAILABLE" });
    expect(recorded).toEqual(["transcript_too_large"]);
    expect(committed).toBe(0);
  });

  test("finalize hands the verified transcript size to the commit", async () => {
    const seen: unknown[] = [];
    const instance = createWorkerGateway({
      work: work({
        async finalizeAtomic(input) {
          seen.push(input.checkpointTranscriptBytes);
          return {
            outcome: "finalized",
            result: { turnId: "1", status: "completed", checkpointRevision: 1 },
          };
        },
      }),
      catalog: { profiles: {}, repositories: {} },
      checkpoints: {
        async verify() {
          return { status: "verified", transcriptBytes: 1234 };
        },
      },
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 30_000,
      },
    });
    await instance.finalize(principal, {
      ...scope,
      turn_id: "1",
      finalize_key: "f",
      final_source_sequence: 0,
      terminal: {
        status: "completed",
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint: {
        revision: 1,
        manifest_ref: "ref",
        manifest_sha256: "0".repeat(64),
      },
    });
    expect(seen).toEqual([1234]);
  });

  test("a committed finalize replays without asking the verifier again", async () => {
    let verified = 0;
    let committed = 0;
    const instance = createWorkerGateway({
      work: work({
        async peekFinalizeAtomic() {
          return {
            outcome: "replayed",
            result: {
              turnId: "1",
              status: "completed",
              checkpointRevision: 3,
            },
          };
        },
        async finalizeAtomic() {
          committed += 1;
          throw new Error("not reached");
        },
      }),
      catalog: { profiles: {}, repositories: {} },
      checkpoints: {
        async verify() {
          verified += 1;
          return { status: "rejected", reason: "storage is unreachable" };
        },
      },
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 30_000,
      },
    });
    // The turn is already terminal, so a verifier that happens to be down
    // must not hide a result the worker has no other way to learn.
    expect(
      await instance.finalize(principal, {
        ...scope,
        turn_id: "1",
        finalize_key: "f",
        final_source_sequence: 0,
        terminal: {
          status: "completed",
          reason: null,
          result: null,
          usage: null,
        },
        checkpoint: {
          revision: 3,
          manifest_ref: "ref",
          manifest_sha256: "0".repeat(64),
        },
      }),
    ).toEqual({ turn_id: "1", status: "completed", checkpoint_revision: 3 });
    expect([verified, committed]).toEqual([0, 0]);
  });

  test("a short wait_ms is not rounded up to a whole poll interval", async () => {
    const slept: number[] = [];
    let at = new Date("2026-09-22T00:00:00.000Z");
    const instance = createWorkerGateway({
      work: work({
        async nextInputAtomic() {
          return {
            outcome: "ok",
            input: null,
            leaseExpiresAt: new Date(at.getTime() + 30_000),
          };
        },
      }),
      catalog: { profiles: {}, repositories: {} },
      checkpoints: {
        async verify() {
          return { status: "verified" };
        },
      },
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 30_000,
        pollIntervalMs: 250,
        now: () => at,
        sleep: async (ms: number) => {
          slept.push(ms);
          at = new Date(at.getTime() + ms);
        },
      },
    });
    await instance.nextInput(principal, { ...scope, wait_ms: 1 });
    expect(slept).toEqual([1]);
  });

  test("authenticate hashes the bearer token and rejects unknown ones", async () => {
    const seen: Uint8Array[] = [];
    const { instance } = gateway({
      async resolveCredential(hash) {
        seen.push(hash);
        return null;
      },
    });
    await expect(instance.authenticate("wsc_x")).rejects.toBeInstanceOf(
      WorkerGatewayError,
    );
    await expect(instance.authenticate(null)).rejects.toMatchObject({
      status: 401,
    });
    expect(seen).toEqual([hashWorkerToken("wsc_x")]);
  });

  test("an operator ceiling on every installed App repository may claim one it does not list", async () => {
    const profile = {
      runtime_kind: "claude_agent_sdk" as const,
      runtime_version: "0.3.270",
      model: "claude-sonnet-5",
      tools: ["Read"],
      permission_mode: "plan" as const,
      provider: {
        kind: "anthropic" as const,
        endpoint: "https://api.anthropic.invalid",
        auth: {
          kind: "api_key" as const,
          value: "provider-key",
          ref: { value_env: "PROVIDER_KEY" },
        },
      },
    };
    const appRepositories: Record<string, CatalogRepository> = {
      app: {
        url: "https://github.com/acme/app.git",
        branch: "main",
        auth: { kind: "github_app", registered: true },
      },
    };
    const seeded = withSeededInstallation({
      profiles: { p: profile },
      repositories: appRepositories,
    });
    const ceiling = seeded.installation.get("p");
    if (!ceiling) throw new Error("no seeded ceiling");
    const runnable: ClaimInput["runnable"][] = [];
    const instance = createWorkerGateway({
      work: work({
        claimAtomic: async (input) => {
          runnable.push(input.runnable);
          throw new Error("stop after the pairs");
        },
      }),
      catalog: {
        ...seeded,
        installation: new Map([
          ["p", { ...ceiling, github_app_repositories: "installed" as const }],
        ]),
      },
      checkpoints: acceptAllCheckpoints,
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 30_000,
      },
    });
    await instance
      .bootstrapClaim(
        { kind: "bootstrap" },
        {
          execution_id: "e",
          execution_generation: 1,
          credential: { kind: "launch_nonce" as const, nonce: "n" },
        },
      )
      .catch(() => {});
    const repositories = new Set(runnable[0]?.map((pair) => pair.repositoryId));
    expect(ceiling.repository_ids).toEqual([]);
    expect(repositories.has("app")).toBe(true);
  });

  test("bootstrapClaim answers the row's repository and the catalog's resolved profile", async () => {
    const binding = {
      sessionId: scope.session_id,
      attemptId: "att_1",
      leaseEpoch: 1,
      executionGeneration: 1,
      authRevision: 0,
      leaseExpiresAt: new Date("2026-09-22T00:00:30Z"),
      leaseRemainingMs: 29_950,
      profileId: "claude-coding-v1",
      profileFingerprint: null,
      model: null,
      unmetered: false,
      ownerScope: "owner-a",
      repository: {
        id: "gone-from-catalog",
        url: "https://example.invalid/team/app.git",
        branch: "release",
      },
      restore: null,
      restoreProfiles: [],
      costUsd: 250.5,
      providerTokens: 0,
    };
    const profile = {
      runtime_kind: "claude_agent_sdk" as const,
      runtime_version: "0.3.270",
      model: "claude-sonnet-5",
      tools: ["Read"],
      permission_mode: "plan" as const,
      provider: {
        kind: "anthropic" as const,
        endpoint: "https://api.anthropic.invalid",
        auth: {
          kind: "api_key" as const,
          value: "provider-key",
          ref: { value_env: "PROVIDER_KEY" },
        },
      },
      project_settings: { claude_md: true },
    };
    const runnable: ClaimInput["runnable"][] = [];
    const issued: ClaimInput["egress"][] = [];
    const instance = createWorkerGateway({
      work: work({
        claimAtomic: async (input) => {
          runnable.push(input.runnable);
          issued.push(input.egress);
          return { outcome: "claimed", binding };
        },
      }),
      catalog: withSeededInstallation({
        profiles: { "claude-coding-v1": profile, other: profile },
        repositories: {
          "sample-app": {
            url: "https://example.invalid/app.git",
            branch: "main",
            profiles: ["claude-coding-v1", "other"],
            auth: { kind: "github_app", registered: true },
          },
          docs: {
            url: "https://example.invalid/docs.git",
            branch: "trunk",
            profiles: ["other"],
            auth: { kind: "github_app", registered: true },
          },
        },
      }),
      checkpoints: acceptAllCheckpoints,
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 30_000,
        workspaceEnforce: "fail",
      },
    });
    const request = {
      execution_id: "e",
      execution_generation: 1,
      credential: { kind: "launch_nonce" as const, nonce: "n" },
    };
    const claimed = await instance.bootstrapClaim(
      { kind: "bootstrap" },
      request,
    );
    // The repository comes from the row, with the attempt's token for the
    // proxy's read-only route beside it — never a credential for the host.
    expect(claimed.workspace).toEqual({
      repository: {
        ...binding.repository,
        access: { kind: "egress_token", token: expect.stringMatching(/^wer_/) },
      },
    });
    // The worker tracks the remainder the store measured, not the deadline.
    expect(claimed.lease_remaining_ms).toBe(29_950);
    // The claim may bind only what the catalog pairs, at the URL and branch
    // it registers now, with the profile's settings as hashed now
    // one entry per allowed pair, nothing else.
    const [current, v1] = profilePins(profile, []);
    expect(current).toEqual({
      fingerprint: profileFingerprint(profile),
      model: "claude-sonnet-5",
    });
    expect(v1?.model).toBeNull();
    const app = {
      repositoryId: "sample-app",
      url: "https://example.invalid/app.git",
      branch: "main",
    };
    const docs = {
      repositoryId: "docs",
      url: "https://example.invalid/docs.git",
      branch: "trunk",
    };
    expect(runnable.map(withoutPolicyPairs) as unknown[]).toEqual([
      [
        ["claude-coding-v1", app] as const,
        ["other", app] as const,
        ["other", docs] as const,
      ].flatMap(([profileId, repository]) =>
        [current, v1].map((pin) => ({
          profileId,
          profileFingerprint: pin?.fingerprint,
          model: pin?.model,
          ...repository,
        })),
      ),
    ]);
    // The row's owner partition, not anything from the shared catalog: it is
    // the checkpoint principal the worker hashes.
    expect(claimed.principal).toEqual({ owner_scope: "owner-a" });
    expect(claimed.runtime).toEqual({
      kind: "claude_agent_sdk",
      version: "0.3.270",
      profile_id: "claude-coding-v1",
    });
    // Neither the provider key nor where the catalog found it rides
    // the worker gets the upstream to name and a token for the
    // proxy, whose hash is what the claim stored.
    expect(claimed.runtime_config).toEqual({
      model: "claude-sonnet-5",
      tools: ["Read"],
      permission_mode: "plan",
      provider: {
        kind: "anthropic",
        endpoint: "https://api.anthropic.invalid",
        auth: { kind: "egress_token", token: expect.stringMatching(/^wep_/) },
      },
      project_settings: { claude_md: true },
    });
    expect(JSON.stringify(claimed)).not.toContain("provider-key");
    const [egress] = issued;
    if (!egress) throw new Error("claim was not asked to issue egress tokens");
    expect(egress.providerHash).toEqual(
      hashWorkerToken(claimed.runtime_config.provider.auth.token),
    );
    expect(egress.repositoryHash).toEqual(
      hashWorkerToken(claimed.workspace.repository?.access?.token ?? ""),
    );
    expect(egress.objectStoreHash).toEqual(
      hashWorkerToken(claimed.object_store.access.token),
    );
    expect(claimed.object_store.access.token).toMatch(/^weo_/);
    expect(egress.packagesHash).toEqual(
      hashWorkerToken(claimed.packages?.access.token ?? ""),
    );
    expect(claimed.packages?.access.token).toMatch(/^wek_/);
    expect(
      egress.bindingsOf({
        id: "s-1",
        profileId: "claude-coding-v1",
        profileFingerprint: null,
        model: null,
        repositoryMode: "repository",
        githubPolicySource: "release",
        repositoryId: "sample-app",
      }),
    ).toEqual({
      object_store: "sessions/s-1/",
      packages: "public",
      provider: profileFingerprint(profile),
      repository: repositoryBinding("sample-app", {
        url: "https://example.invalid/app.git",
        branch: "main",
        profiles: ["claude-coding-v1", "other"],
        auth: { kind: "github_app", registered: true },
      }),
    });
    expect(claimed.profile_fingerprint).toBe(profileFingerprint(profile));
    expect(claimed.profile_fingerprint).not.toContain("provider-key");
    // The engine's own budget is what the session has left.
    expect(claimed.remaining_budget_usd).toBe(749.5);
    expect(claimed.workspace_enforce).toBe("fail");
    // Off leaves the field out, so the answer is one a worker built before it
    // still reads: its schema was this one without the field, and strict.
    const beforeTheField = bootstrapClaimResponseSchema.extend({
      runtime_config: runtimeConfigSchema.omit({ project_settings: true }),
    });
    expect(beforeTheField.safeParse(claimed).success).toBe(false);
    const off = createWorkerGateway({
      work: work({
        claimAtomic: async () => ({ outcome: "claimed", binding }),
      }),
      catalog: {
        profiles: {
          "claude-coding-v1": {
            ...profile,
            project_settings: { claude_md: false },
          },
        },
        repositories: {},
      },
      checkpoints: acceptAllCheckpoints,
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 30_000,
      },
    });
    const offClaim = await off.bootstrapClaim({ kind: "bootstrap" }, request);
    expect("project_settings" in offClaim.runtime_config).toBe(false);
    expect(
      beforeTheField.safeParse(bootstrapClaimResponseSchema.parse(offClaim))
        .success,
    ).toBe(true);
    // A profile the catalog lost between the row's binding and this replay
    // is refused rather than answered with a guess.
    const stranger = createWorkerGateway({
      work: work({
        claimAtomic: async () => ({ outcome: "replayed", binding }),
      }),
      catalog: { profiles: {}, repositories: {} },
      checkpoints: acceptAllCheckpoints,
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 30_000,
      },
    });
    await expect(
      stranger.bootstrapClaim({ kind: "bootstrap" }, request),
    ).rejects.toMatchObject({ status: 503, code: "BACKEND_UNAVAILABLE" });
    // A replay does not check the budget, so a session that spent past it
    // in between is answered with nothing left rather than a negative.
    const spent = createWorkerGateway({
      work: work({
        claimAtomic: async () => ({
          outcome: "replayed",
          binding: { ...binding, costUsd: 1_000.25 },
        }),
      }),
      catalog: { profiles: { "claude-coding-v1": profile }, repositories: {} },
      checkpoints: acceptAllCheckpoints,
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 30_000,
      },
    });
    const spentClaim = await spent.bootstrapClaim(
      { kind: "bootstrap" },
      request,
    );
    expect(spentClaim.remaining_budget_usd).toBe(0);
    expect(bootstrapClaimResponseSchema.safeParse(spentClaim).success).toBe(
      true,
    );
    expect("git" in spentClaim).toBe(false);

    // The commit trailers: the linked starter as co-author, then a session
    // no person started, which names only itself.
    const asked: string[] = [];
    let starter: SessionAttributionRecord["starter"] = {
      userId: "user-1",
      github: { id: "583231", login: "octocat" },
    };
    let authorApp: SessionAttributionRecord["authorApp"] = {
      slug: "werft-dev",
      apiBase: "https://api.github.com",
    };
    const attributed = createWorkerGateway({
      work: work({
        claimAtomic: async () => ({ outcome: "claimed", binding }),
      }),
      catalog: { profiles: { "claude-coding-v1": profile }, repositories: {} },
      checkpoints: acceptAllCheckpoints,
      attribution: {
        store: {
          attribution: async (sessionId) => {
            asked.push(sessionId);
            return {
              ownerId: "owner-a",
              trigger: starter === null ? "agent_key" : "web",
              agentId: null,
              agentReleaseId: null,
              starter,
              authorApp,
              authorPinned: true,
            };
          },
        },
        consoleOrigin: "https://console.example.com",
      },
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 30_000,
      },
    });
    const sessionUrl = `https://console.example.com/sessions/${scope.session_id}`;
    const linked = bootstrapClaimResponseSchema.parse(
      await attributed.bootstrapClaim({ kind: "bootstrap" }, request),
    );
    expect(linked.git).toEqual({
      co_author: {
        name: "octocat",
        email: "583231+octocat@users.noreply.github.com",
      },
      session_url: sessionUrl,
    });
    expect(linked.git_strip).toEqual(["noreply@anthropic.com"]);
    starter = null;
    const agentKey = await attributed.bootstrapClaim(
      { kind: "bootstrap" },
      request,
    );
    expect(agentKey.git).toEqual({ co_author: null, session_url: sessionUrl });
    expect(asked).toEqual([scope.session_id, scope.session_id]);

    // The workspace chose `id`: the claim sends no address, so the worker's
    // trailer names the session id. Asked for the claim's workspace.
    const linksAsked: string[] = [];
    const idOnly = createWorkerGateway({
      work: work({
        claimAtomic: async () => ({ outcome: "claimed", binding }),
      }),
      catalog: { profiles: { "claude-coding-v1": profile }, repositories: {} },
      checkpoints: acceptAllCheckpoints,
      attribution: {
        store: { attribution: async () => null },
        consoleOrigin: "https://console.example.com",
        sessionLink: async (workspaceId) => {
          linksAsked.push(workspaceId);
          return "id";
        },
      },
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 30_000,
      },
    });
    const bare = await idOnly.bootstrapClaim({ kind: "bootstrap" }, request);
    expect(bare.git).toEqual({ co_author: null, session_url: null });
    expect(linksAsked).toEqual([binding.ownerScope]);

    // A failing settings read is the claim's failure, not a silent default:
    // a wrong address in a commit is worse than a session that retries.
    const unreadable = createWorkerGateway({
      work: work({
        claimAtomic: async () => ({ outcome: "claimed", binding }),
      }),
      catalog: { profiles: { "claude-coding-v1": profile }, repositories: {} },
      checkpoints: acceptAllCheckpoints,
      attribution: {
        store: { attribution: async () => null },
        consoleOrigin: "https://console.example.com",
        sessionLink: async () => {
          throw new Error("connection refused");
        },
      },
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 30_000,
      },
    });
    await expect(
      unreadable.bootstrapClaim({ kind: "bootstrap" }, request),
    ).rejects.toThrow("connection refused");
    // No bot lookup wired: the claim leaves the image's author alone.
    expect("git_author" in linked).toBe(false);

    // The commit author: the console App's bot, only for a repository on
    // that App, and only once GitHub named the bot's id.
    const looked: { slug: string; apiBase: string }[] = [];
    const ledgerRows: [string, unknown][] = [];
    let ledgerDown = false;
    let botUserId: string | null = "41898282";
    let repositories: Parameters<
      typeof createWorkerGateway
    >[0]["catalog"]["repositories"] = {
      "gone-from-catalog": {
        url: "https://github.com/team/app.git",
        branch: "release",
        profiles: ["claude-coding-v1"],
        auth: { kind: "github_app", registered: true },
      } as never,
    };
    const authored = () =>
      createWorkerGateway({
        work: work({
          claimAtomic: async () => ({ outcome: "claimed", binding }),
        }),
        catalog: { profiles: { "claude-coding-v1": profile }, repositories },
        checkpoints: acceptAllCheckpoints,
        attribution: {
          store: {
            attribution: async () => ({
              ownerId: "owner-a",
              trigger: "personal_key",
              agentId: null,
              agentReleaseId: null,
              starter,
              authorApp,
              authorPinned: true,
            }),
          },
          ledger: {
            record: async (sessionId, expectation) => {
              if (ledgerDown) throw new Error("database down");
              ledgerRows.push([sessionId, expectation]);
            },
            list: async () => [],
          },
          consoleOrigin: null,
          appBotUserId: async (app) => {
            looked.push(app);
            return botUserId;
          },
        },
        options: {
          sessionCostLimitUsd: 1_000,
          sessionTokenLimit: null,
          leaseTtlMs: 30_000,
        },
      });
    const claimOf = async () =>
      bootstrapClaimResponseSchema.parse(
        await authored().bootstrapClaim({ kind: "bootstrap" }, request),
      );
    const bot = await claimOf();
    expect(bot.git_author).toEqual({
      name: "werft-dev[bot]",
      email: "41898282+werft-dev[bot]@users.noreply.github.com",
    });
    expect(bot.git).toEqual({ co_author: null, session_url: null });
    expect(looked).toEqual([
      { slug: "werft-dev", apiBase: "https://api.github.com" },
    ]);
    // What the claim asked for is kept, for the push's check.
    expect(ledgerRows).toEqual([
      [
        scope.session_id,
        {
          author: bot.git_author,
          coAuthor: null,
          agentSession: scope.session_id,
        },
      ],
    ]);

    botUserId = null;
    expect((await claimOf()).git_author).toBeNull();
    // A claim that names no bot expects the image's author.
    expect(ledgerRows.at(-1)).toEqual([
      scope.session_id,
      {
        author: { name: "Werft", email: "noreply@werft.invalid" },
        coAuthor: null,
        agentSession: scope.session_id,
      },
    ]);
    botUserId = "41898282";
    authorApp = null;
    expect((await claimOf()).git_author).toBeNull();
    authorApp = { slug: "werft-dev", apiBase: "https://api.github.com" };
    repositories = {
      "gone-from-catalog": {
        url: "https://github.com/team/app.git",
        branch: "release",
        profiles: ["claude-coding-v1"],
      } as never,
    };
    expect((await claimOf()).git_author).toBeNull();
    repositories = {};
    expect((await claimOf()).git_author).toBeNull();
    expect(looked).toHaveLength(2);
    // A ledger that cannot write fails the claim, so the worker asks again
    // instead of running a session no push could be judged for.
    ledgerDown = true;
    await expect(claimOf()).rejects.toThrow("database down");
    ledgerDown = false;
    expect((await claimOf()).git_author).toBeNull();

    // No author pin on the primary repository yet (decision D11): the claim
    // pins it the way a token issue would, then reads the App back through
    // the pin. Anything that stops the pin leaves the image's author.
    repositories = {
      "gone-from-catalog": {
        url: "https://github.com/team/app.git",
        branch: "release",
        profiles: ["claude-coding-v1"],
        auth: { kind: "github_app", registered: true },
      } as never,
    };
    type Choice = Awaited<ReturnType<GitHubConnectionResolver["resolve"]>>;
    let pinned = false;
    let answer: () => Promise<Choice> = async () => {
      pinned = true;
      return {
        kind: "connection",
        connection: {} as never,
        connectionId: "conn-1",
        pinnedBy: "claim",
      };
    };
    const resolved: unknown[] = [];
    const failures: unknown[] = [];
    const pinning = () =>
      createWorkerGateway({
        work: work({
          claimAtomic: async () => ({ outcome: "claimed", binding }),
        }),
        catalog: { profiles: { "claude-coding-v1": profile }, repositories },
        checkpoints: acceptAllCheckpoints,
        attribution: {
          store: {
            attribution: async () => ({
              ownerId: "owner-a",
              trigger: "web",
              agentId: null,
              agentReleaseId: null,
              starter: null,
              authorApp: pinned
                ? { slug: "pinned-app", apiBase: "https://api.github.com" }
                : null,
              authorPinned: pinned,
            }),
          },
          consoleOrigin: null,
          appBotUserId: async () => "41898282",
          commitPin: {
            resolver: {
              resolve: async (...args) => {
                resolved.push(args);
                return answer();
              },
            },
            onFailed: (failure) => failures.push(failure),
          },
        },
        options: {
          sessionCostLimitUsd: 1_000,
          sessionTokenLimit: null,
          leaseTtlMs: 30_000,
        },
      });
    const pinClaim = async () =>
      bootstrapClaimResponseSchema.parse(
        await pinning().bootstrapClaim({ kind: "bootstrap" }, request),
      );
    expect((await pinClaim()).git_author).toEqual({
      name: "pinned-app[bot]",
      email: "41898282+pinned-app[bot]@users.noreply.github.com",
    });
    expect(resolved).toEqual([
      [
        "gone-from-catalog",
        "author",
        { owner: "team", name: "app" },
        {
          pin: true,
          claim: { sessionId: scope.session_id, receiptId: expect.any(String) },
        },
      ],
    ]);
    // Held now: the next claim reads the pin and resolves nothing.
    await pinClaim();
    expect(resolved).toHaveLength(1);
    expect(failures).toEqual([]);

    pinned = false;
    for (const [choice, reason] of [
      [
        {
          kind: "refused",
          reason: "ambiguous_app",
          candidateConnectionIds: ["a", "b"],
        },
        "ambiguous_app",
      ],
      [
        { kind: "unreachable", pinState: "lookup_failed", connectionId: null },
        "lookup_failed",
      ],
      [{ kind: "none" }, "no_author_app"],
    ] as const) {
      answer = async () => choice as Choice;
      failures.length = 0;
      expect((await pinClaim()).git_author).toBeNull();
      expect(failures).toEqual([
        {
          sessionId: scope.session_id,
          repositoryId: "gone-from-catalog",
          reason,
        },
      ]);
    }
    // The pin store failing (or a connection replaced between the choice
    // and the pin, which leaves no pin): the claim is still issued.
    answer = async () => {
      throw new TypeError("connection reset");
    };
    failures.length = 0;
    const failed = await pinClaim();
    expect(failed.git_author).toBeNull();
    expect(failed.session_id).toBe(scope.session_id);
    expect(failures).toEqual([
      {
        sessionId: scope.session_id,
        repositoryId: "gone-from-catalog",
        reason: "TypeError",
      },
    ]);
    answer = async () => ({
      kind: "connection",
      connection: {} as never,
      connectionId: "conn-1",
      pinnedBy: null,
    });
    failures.length = 0;
    expect((await pinClaim()).git_author).toBeNull();
    expect(failures).toEqual([
      {
        sessionId: scope.session_id,
        repositoryId: "gone-from-catalog",
        reason: "not_pinned",
      },
    ]);
  });

  test("the claim lists the other repositories the gate allows, on the attempt's repository token", async () => {
    const profile = {
      runtime_kind: "claude_agent_sdk" as const,
      runtime_version: "0.3.270",
      model: "claude-sonnet-5",
      tools: ["Read"],
      permission_mode: "plan" as const,
      provider: {
        kind: "anthropic" as const,
        endpoint: "https://api.anthropic.invalid",
        auth: {
          kind: "api_key" as const,
          value: "provider-key",
          ref: { value_env: "PROVIDER_KEY" },
        },
      },
    };
    const asked: unknown[] = [];
    const instance = createWorkerGateway({
      work: work({
        claimAtomic: async () => ({
          outcome: "claimed",
          binding: {
            sessionId: scope.session_id,
            attemptId: "att_1",
            leaseEpoch: 1,
            executionGeneration: 1,
            authRevision: 0,
            leaseExpiresAt: new Date("2026-09-22T00:00:30Z"),
            leaseRemainingMs: 29_950,
            profileId: "p",
            profileFingerprint: null,
            model: null,
            unmetered: false,
            ownerScope: "owner-a",
            repository: {
              id: "app",
              url: "https://example.invalid/app.git",
              branch: "main",
            },
            restore: null,
            restoreProfiles: [],
            costUsd: 0,
            providerTokens: 0,
          },
        }),
      }),
      catalog: withSeededInstallation({
        profiles: { p: profile },
        repositories: {
          app: {
            url: "https://example.invalid/app.git",
            branch: "main",
            profiles: ["p"],
            auth: { kind: "github_app", registered: true } as const,
          },
          docs: {
            url: "https://example.invalid/docs.git",
            branch: "trunk",
            profiles: ["p"],
            auth: { kind: "github_app", registered: true } as const,
          },
        },
      }),
      github: {
        grant: async () => null,
        additionalRepositories: async (sessionId) => {
          asked.push(sessionId);
          return ["docs", "gone-from-catalog"];
        },
      },
      checkpoints: acceptAllCheckpoints,
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 30_000,
      },
    });
    const claimed = await instance.bootstrapClaim(
      { kind: "bootstrap" },
      {
        execution_id: "e",
        execution_generation: 1,
        credential: { kind: "launch_nonce", nonce: "n" },
      },
    );
    const token = claimed.workspace.repository?.access?.token;
    expect(token).toMatch(/^wer_/);
    expect(claimed.workspace.additional_repositories).toEqual([
      {
        id: "docs",
        url: "https://example.invalid/docs.git",
        branch: "trunk",
        access: { kind: "egress_token", token: token ?? "" },
      },
    ]);
    expect(asked).toEqual([scope.session_id]);
  });

  test("a session pinned before its profile's runtime moved to the next image is still claimed while the previous image is configured", async () => {
    const before = {
      runtime_kind: "claude_agent_sdk" as const,
      runtime_version: "0.3.270",
      model: "claude-sonnet-5",
      tools: ["Read"],
      permission_mode: "plan" as const,
      repository: "none" as const,
      provider: {
        kind: "anthropic" as const,
        endpoint: "https://api.anthropic.invalid",
        auth: {
          kind: "api_key" as const,
          value: "provider-key",
          ref: { value_env: "PROVIDER_KEY" },
        },
      },
    };
    const after = { ...before, runtime_version: "0.3.280" };
    const pinned = profileFingerprint(before);
    const binding = {
      sessionId: scope.session_id,
      attemptId: "att_1",
      leaseEpoch: 1,
      executionGeneration: 1,
      authRevision: 0,
      leaseExpiresAt: new Date("2026-09-22T00:00:30Z"),
      leaseRemainingMs: 29_950,
      profileId: "p",
      profileFingerprint: pinned,
      model: "claude-sonnet-5" as string | null,
      unmetered: false,
      ownerScope: "owner-a",
      repository: null,
      restore: null,
      restoreProfiles: [],
      costUsd: 0,
      providerTokens: 0,
    };
    const runnable: ClaimInput["runnable"][] = [];
    const issued: ClaimInput["egress"][] = [];
    const gatewayWith = (accepted: string[]) =>
      createWorkerGateway({
        work: work({
          claimAtomic: async (input) => {
            runnable.push(input.runnable);
            issued.push(input.egress);
            return { outcome: "claimed", binding };
          },
        }),
        catalog: {
          ...withSeededInstallation({
            profiles: { p: after },
            repositories: {},
          }),
          runtime_versions: { accepted, current: ["0.3.280", "2.1.280"] },
        },
        checkpoints: acceptAllCheckpoints,
        options: {
          sessionCostLimitUsd: 1_000,
          sessionTokenLimit: null,
          leaseTtlMs: 30_000,
        },
      });
    const request = {
      execution_id: "e",
      execution_generation: 1,
      credential: { kind: "launch_nonce" as const, nonce: "n" },
    };

    const claimed = await gatewayWith([
      "0.3.280",
      "2.1.280",
      "0.3.270",
      "2.1.270",
    ]).bootstrapClaim({ kind: "bootstrap" }, request);
    expect(claimed.session_id).toBe(scope.session_id);
    expect(runnable.at(-1)).toContainEqual({
      profileId: "p",
      profileFingerprint: pinned,
      model: "claude-sonnet-5",
      repositoryId: null,
    });
    expect(
      issued.at(-1)?.bindingsOf({
        id: "s-1",
        profileId: "p",
        profileFingerprint: pinned,
        model: "claude-sonnet-5",
        repositoryMode: "none",
        githubPolicySource: "release",
        repositoryId: null,
      }).provider,
    ).toBe(pinned);

    // Once the previous image leaves the configuration, so does its pin.
    await expect(
      gatewayWith(["0.3.280", "2.1.280"]).bootstrapClaim(
        { kind: "bootstrap" },
        request,
      ),
    ).rejects.toMatchObject({ status: 503, code: "BACKEND_UNAVAILABLE" });
    expect(
      runnable.at(-1)?.some((pair) => pair.profileFingerprint === pinned),
    ).toBe(false);
  });

  test("a session without a repository is claimed with no workspace repository token and no CLAUDE.md", async () => {
    const base = {
      runtime_kind: "claude_agent_sdk" as const,
      runtime_version: "0.3.270",
      model: "claude-sonnet-5",
      tools: ["Read"],
      permission_mode: "plan" as const,
      provider: {
        kind: "anthropic" as const,
        endpoint: "https://api.anthropic.invalid",
        auth: {
          kind: "api_key" as const,
          value: "provider-key",
          ref: { value_env: "PROVIDER_KEY" },
        },
      },
    };
    const optional = {
      ...base,
      repository: "optional" as const,
      project_settings: { claude_md: true },
    };
    const general = {
      ...base,
      tools: ["Write"],
      models: ["claude-opus-5-5"],
      repository: "none" as const,
    };
    const binding = {
      sessionId: scope.session_id,
      attemptId: "att_1",
      leaseEpoch: 1,
      executionGeneration: 1,
      authRevision: 0,
      leaseExpiresAt: new Date("2026-09-22T00:00:30Z"),
      leaseRemainingMs: 29_950,
      profileId: "general",
      profileFingerprint: profileFingerprint(general),
      model: "claude-sonnet-5" as string | null,
      unmetered: false,
      ownerScope: "owner-a",
      repository: null,
      restore: null,
      restoreProfiles: [
        {
          profileId: "optional",
          profileFingerprint: profileFingerprint(optional),
          model: "claude-sonnet-5" as string | null,
        },
      ],
      costUsd: 0,
      providerTokens: 0,
    };
    const runnable: ClaimInput["runnable"][] = [];
    const issued: ClaimInput["egress"][] = [];
    const claimWith = (bound: typeof binding) =>
      createWorkerGateway({
        work: work({
          claimAtomic: async (input) => {
            runnable.push(input.runnable);
            issued.push(input.egress);
            return { outcome: "claimed", binding: bound };
          },
        }),
        catalog: withSeededInstallation({
          profiles: { required: base, optional, general },
          repositories: {
            app: {
              url: "https://example.invalid/app.git",
              branch: "main",
              profiles: ["required", "optional"],
              auth: { kind: "github_app", registered: true } as const,
            },
          },
        }),
        checkpoints: acceptAllCheckpoints,
        options: {
          sessionCostLimitUsd: 1_000,
          sessionTokenLimit: null,
          leaseTtlMs: 30_000,
        },
      }).bootstrapClaim(
        { kind: "bootstrap" },
        {
          execution_id: "e",
          execution_generation: 1,
          credential: { kind: "launch_nonce", nonce: "n" },
        },
      );
    const claimed = await claimWith(binding);
    expect(claimed.workspace).toEqual({ repository: null });
    // Only the route token a mid-session attachment fetches with.
    const { repository_access, ...rest } = claimed;
    expect(repository_access?.token).toStartWith("wer_");
    expect(JSON.stringify(rest)).not.toContain("wer_");
    expect(claimed.runtime_config.tools).toEqual(["Write"]);
    expect(claimed.restore_runtime_configs).toHaveLength(1);
    expect(claimed.restore_runtime_configs?.[0]).not.toHaveProperty(
      "project_settings",
    );
    expect(bootstrapClaimResponseSchema.safeParse(claimed).success).toBe(true);
    expect(withoutPolicyPairs(runnable[0] ?? [])).toEqual([
      ...["required", "optional"].flatMap((profileId) =>
        [0, 1].map(() =>
          expect.objectContaining({ profileId, repositoryId: "app" }),
        ),
      ),
      ...profilePins(optional, []).map((pin) => ({
        profileId: "optional",
        profileFingerprint: pin.fingerprint,
        model: pin.model,
        repositoryId: null,
      })),
      ...profilePins(general, []).map((pin) => ({
        profileId: "general",
        profileFingerprint: pin.fingerprint,
        model: pin.model,
        repositoryId: null,
      })),
    ]);
    expect(
      withoutPolicyPairs(runnable[0] ?? [])
        .filter((pair) => pair.profileId === "general")
        .map((pair) => pair.model),
    ).toEqual(["claude-sonnet-5", "claude-opus-5-5", null, null]);
    // Each profile also gets the pairs an `agent` session is claimed by,
    // which no `release` session matches.
    const policy = (runnable[0] ?? []).filter((pair) => pair.policy === true);
    expect(new Set(policy.map((pair) => pair.profileId))).toEqual(
      new Set(["required", "optional", "general"]),
    );
    expect(policy.every((pair) => pair.workspaceScoped === false)).toBe(true);
    const [egress] = issued;
    if (!egress) throw new Error("claim was not asked to issue egress tokens");
    expect(
      egress.bindingsOf({
        id: "s-1",
        profileId: "general",
        profileFingerprint: profileFingerprint(general),
        model: "claude-sonnet-5",
        repositoryMode: "none",
        githubPolicySource: "release",
        repositoryId: null,
      }),
    ).toEqual({
      provider: profileFingerprint(general),
      repository: null,
      object_store: "sessions/s-1/",
      packages: "public",
    });
    // Under the agent's settings the tools stay attached, so even a profile
    // with no repository keeps the token for what the session attaches.
    expect(
      egress.bindingsOf({
        id: "s-1",
        profileId: "general",
        profileFingerprint: profileFingerprint(general),
        model: "claude-sonnet-5",
        repositoryMode: "none",
        githubPolicySource: "agent",
        repositoryId: null,
      }).repository,
    ).toBe("attached-only");
    // An optional session without a repository still gets a repository
    // token, for the ones it attaches.
    expect(
      egress.bindingsOf({
        id: "s-1",
        profileId: "optional",
        profileFingerprint: profileFingerprint(optional),
        model: "claude-sonnet-5",
        repositoryMode: "none",
        githubPolicySource: "release",
        repositoryId: null,
      }).repository,
    ).toBe("attached-only");
    const optionalClaim = await claimWith({
      ...binding,
      profileId: "optional",
      profileFingerprint: profileFingerprint(optional),
      restoreProfiles: [],
    });
    expect(optionalClaim.runtime_config).not.toHaveProperty("project_settings");
    expect(optionalClaim.workspace).toEqual({ repository: null });

    const opus = await claimWith({ ...binding, model: "claude-opus-5-5" });
    expect(opus.runtime_config.model).toBe("claude-opus-5-5");
    const v1Opus = profilePins(general, [])[3]?.fingerprint;
    if (!v1Opus) throw new Error("no version 1 pin for the second model");
    const legacy = await claimWith({
      ...binding,
      profileFingerprint: v1Opus,
      model: null,
      restoreProfiles: [
        { profileId: "general", profileFingerprint: v1Opus, model: null },
      ],
    });
    expect(legacy.runtime_config.model).toBe("claude-opus-5-5");
    expect(legacy.restore_runtime_configs).toBeUndefined();
    expect(
      issued.at(-1)?.bindingsOf({
        id: "s-1",
        profileId: "general",
        profileFingerprint: v1Opus,
        model: null,
        repositoryMode: "none",
        githubPolicySource: "release",
        repositoryId: null,
      }).provider,
    ).toBe(v1Opus);
    await expect(
      claimWith({ ...binding, model: "claude-fable-5-1" }),
    ).rejects.toMatchObject({ status: 503, code: "BACKEND_UNAVAILABLE" });

    // A checkpoint from before the built-in server, under the profile the
    // session runs now, survives the cap however many others there are.
    const withGitHub = {
      ...binding,
      githubMcp: { releaseId: "rel-1", tools: ["mcp__github__request_push"] },
      restoreProfiles: Array.from({ length: 16 }, () => ({
        profileId: "optional",
        profileFingerprint: profileFingerprint(optional),
        model: "claude-sonnet-5" as string | null,
      })),
    };
    const restored = (await claimWith(withGitHub)).restore_runtime_configs;
    expect(restored).toHaveLength(16);
    expect(
      restored
        ?.slice(0, 3)
        .map((config) => [
          config.mcp_servers?.map((server) => server.name),
          config.tools,
        ]),
    ).toEqual([
      [undefined, ["Write"]],
      [["github"], ["Read", "mcp__github__request_push"]],
      [undefined, ["Read"]],
    ]);
  });

  test("a claim needing an MCP server this host's catalog does not hold binds nothing and is retried", async () => {
    const general = {
      runtime_kind: "claude_agent_sdk" as const,
      runtime_version: "0.3.270",
      model: "claude-sonnet-5",
      tools: ["Read"],
      permission_mode: "plan" as const,
      repository: "none" as const,
      provider: {
        kind: "anthropic" as const,
        endpoint: "https://api.anthropic.invalid",
        auth: {
          kind: "api_key" as const,
          value: "provider-key",
          ref: { value_env: "PROVIDER_KEY" },
        },
      },
    };
    const mcpOf = (server: string) => ({
      releaseId: "rel-1",
      server,
      tools: [`mcp__${server}__search`],
    });
    const session = (server: string) => ({
      id: "s-1",
      profileId: "general",
      profileFingerprint: profileFingerprint(general),
      model: "claude-sonnet-5",
      repositoryMode: "none" as const,
      githubPolicySource: "release",
      repositoryId: null,
      mcp: mcpOf(server),
    });
    const catalog = {
      ...withSeededInstallation({
        profiles: { general },
        repositories: {},
      }),
      mcp_servers: {
        kept: {
          url: "https://mcp.example.invalid/kept",
          credential_ref: "kept",
          auth: {
            kind: "bearer" as const,
            value: "kept-token",
            ref: { value_env: "KEPT_TOKEN" },
          },
          workspaces: [],
        },
      } as SessionCatalog["mcp_servers"],
    };
    const issued: ClaimInput["egress"][] = [];
    let refreshMidClaim = false;
    const gateway = createWorkerGateway({
      work: work({
        claimAtomic: async (input) => {
          issued.push(input.egress);
          if (!refreshMidClaim) return { outcome: "no_session" };
          input.egress.bindingsOf(session("kept"));
          // A registry refresh that drops the server lands mid-claim.
          catalog.mcp_servers = {};
          return {
            outcome: "claimed",
            binding: {
              sessionId: scope.session_id,
              attemptId: "att_1",
              leaseEpoch: 1,
              executionGeneration: 1,
              authRevision: 0,
              leaseExpiresAt: new Date("2026-09-22T00:00:30Z"),
              leaseRemainingMs: 29_950,
              profileId: "general",
              profileFingerprint: profileFingerprint(general),
              model: "claude-sonnet-5",
              unmetered: false,
              ownerScope: "owner-a",
              repository: null,
              restore: null,
              restoreProfiles: [],
              costUsd: 0,
              providerTokens: 0,
              mcp: mcpOf("kept"),
            },
          };
        },
      }),
      catalog,
      checkpoints: acceptAllCheckpoints,
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 30_000,
      },
    });
    const claim = () =>
      gateway.bootstrapClaim(
        { kind: "bootstrap" },
        {
          execution_id: "e",
          execution_generation: 1,
          credential: { kind: "launch_nonce", nonce: "n" },
        },
      );
    await claim().catch(() => undefined);
    const [egress] = issued;
    if (!egress) throw new Error("claim was not asked to issue egress tokens");
    expect(() => egress.bindingsOf(session("docs"))).toThrow(
      expect.objectContaining({
        status: 503,
        code: "BACKEND_UNAVAILABLE",
        retryable: true,
      }),
    );
    expect(egress.bindingsOf(session("kept")).mcp).toBeDefined();

    refreshMidClaim = true;
    const claimed = await claim();
    expect(
      claimed.runtime_config.mcp_servers?.map((server) => server.name),
    ).toEqual(["kept"]);
  });

  test("a claim runs its release's tools and offers the profile's for restore, and the switched-off claim offers them back", async () => {
    const current = {
      runtime_kind: "claude_agent_sdk" as const,
      runtime_version: "0.3.270",
      model: "claude-sonnet-5",
      tools: ["Read", "Edit", "Bash"],
      permission_mode: "plan" as const,
      repository: "none" as const,
      provider: {
        kind: "anthropic" as const,
        endpoint: "https://api.anthropic.invalid",
        auth: {
          kind: "api_key" as const,
          value: "provider-key",
          ref: { value_env: "PROVIDER_KEY" },
        },
      },
    };
    const earlier = { ...current, tools: ["Read", "Bash"] };
    const wide = { ...current, model: "claude-opus-5-5" };
    const binding: WorkerBinding = {
      sessionId: scope.session_id,
      attemptId: "att_1",
      leaseEpoch: 1,
      executionGeneration: 1,
      authRevision: 0,
      leaseExpiresAt: new Date("2026-09-22T00:00:30Z"),
      leaseRemainingMs: 29_950,
      profileId: "current",
      profileFingerprint: profileFingerprint(current),
      model: "claude-sonnet-5",
      unmetered: false,
      ownerScope: "owner-a",
      repository: null,
      restore: null,
      restoreProfiles: [
        {
          profileId: "earlier",
          profileFingerprint: profileFingerprint(earlier),
          model: "claude-sonnet-5",
        },
      ],
      costUsd: 0,
      providerTokens: 0,
      githubMcp: { releaseId: "rel-1", tools: ["mcp__github__request_push"] },
      // Forbids Edit; Glob is not the profile's and never runs.
      releaseTools: ["Read", "Bash", "Glob"],
    };
    const claimWith = (bound: WorkerBinding, runReleaseTools?: boolean) =>
      createWorkerGateway({
        work: work({
          claimAtomic: async () => ({ outcome: "claimed", binding: bound }),
        }),
        catalog: withSeededInstallation({
          profiles: { current, earlier, wide },
          repositories: {},
        }),
        checkpoints: acceptAllCheckpoints,
        options: {
          sessionCostLimitUsd: 1_000,
          sessionTokenLimit: null,
          leaseTtlMs: 30_000,
          ...(runReleaseTools === undefined ? {} : { runReleaseTools }),
        },
      }).bootstrapClaim(
        { kind: "bootstrap" },
        {
          execution_id: "e",
          execution_generation: 1,
          credential: { kind: "launch_nonce", nonce: "n" },
        },
      );
    // What the fingerprint reads of a config; the tokens differ per claim.
    const shape = (config: RuntimeConfig) => ({
      model: config.model,
      tools: config.tools,
      mcp: config.mcp_servers?.map((server) => server.name) ?? [],
    });
    const github = "mcp__github__request_push";

    const claimed = await claimWith(binding);
    const withoutRelease = await claimWith({ ...binding, releaseTools: null });
    const unbound = { ...binding };
    delete unbound.releaseTools;
    // Without a release the profile's tools run, as before the switch.
    expect(withoutRelease.runtime_config.tools).toEqual([
      "Read",
      "Edit",
      "Bash",
      github,
    ]);
    expect(shape((await claimWith(unbound)).runtime_config)).toEqual(
      shape(withoutRelease.runtime_config),
    );
    // With one, the release's tools within the profile run.
    expect(claimed.runtime_config.tools).toEqual(["Read", "Bash", github]);
    expect(bootstrapClaimResponseSchema.safeParse(claimed).success).toBe(true);
    // Newest first, every profile list before the release's: the current
    // profile's (with and before the built-in server), the earlier
    // profile's, then the release's as checkpoints from before the server.
    expect(claimed.restore_runtime_configs?.map(shape)).toEqual([
      {
        model: "claude-sonnet-5",
        tools: ["Read", "Edit", "Bash", github],
        mcp: ["github"],
      },
      { model: "claude-sonnet-5", tools: ["Read", "Edit", "Bash"], mcp: [] },
      {
        model: "claude-sonnet-5",
        tools: ["Read", "Bash", github],
        mcp: ["github"],
      },
      { model: "claude-sonnet-5", tools: ["Read", "Bash"], mcp: [] },
      { model: "claude-sonnet-5", tools: ["Read", "Bash"], mcp: [] },
    ]);

    // Switched off (the rollback floor's claim), the profile's tools run and
    // the release's are offered: a checkpoint either makes resumes on the
    // other.
    const off = await claimWith(binding, false);
    expect(shape(off.runtime_config)).toEqual(
      shape(withoutRelease.runtime_config),
    );
    expect(off.restore_runtime_configs?.map(shape)).toEqual([
      { model: "claude-sonnet-5", tools: ["Read", "Edit", "Bash"], mcp: [] },
      {
        model: "claude-sonnet-5",
        tools: ["Read", "Bash", github],
        mcp: ["github"],
      },
      { model: "claude-sonnet-5", tools: ["Read", "Bash"], mcp: [] },
      {
        model: "claude-sonnet-5",
        tools: ["Read", "Bash", github],
        mcp: ["github"],
      },
      { model: "claude-sonnet-5", tools: ["Read", "Bash"], mcp: [] },
    ]);
    // The earlier profile allows only the release's tools: one list.
    expect(withoutRelease.restore_runtime_configs?.map(shape)).toEqual([
      { model: "claude-sonnet-5", tools: ["Read", "Edit", "Bash"], mcp: [] },
      {
        model: "claude-sonnet-5",
        tools: ["Read", "Bash", github],
        mcp: ["github"],
      },
      { model: "claude-sonnet-5", tools: ["Read", "Bash"], mcp: [] },
    ]);

    expect(off.restore_runtime_configs?.map(shape)).toContainEqual(
      shape(claimed.runtime_config),
    );
    expect(claimed.restore_runtime_configs?.map(shape)).toContainEqual(
      shape(off.runtime_config),
    );
    // `[]` is a release that allows no built-in tool, not one missing.
    const none = await claimWith({ ...binding, releaseTools: [] });
    expect(none.runtime_config.tools).toEqual([github]);

    const configsOf = (claim: typeof claimed) => [
      claim.runtime_config,
      ...(claim.restore_runtime_configs ?? []),
    ];
    // A card's retired agent_instructions never reaches a config.
    expect(
      configsOf(claimed).some((config) => "agent_instructions" in config),
    ).toBe(false);

    // The row's platform prompt rides the same way: on every config, run or
    // restore, so no restore candidate of a revision 1 session lacks it; a
    // revision 0 row adds the field nowhere.
    const prompt: PlatformPrompt = {
      prompt_revision: 1,
      agent_identity: { name: "code-review", description: null },
      origin_surface: "slack_channel",
      language: "ko",
      repository: "acme/app",
    };
    for (const runReleaseTools of [true, false]) {
      const prompted = await claimWith(
        { ...binding, platformPrompt: prompt },
        runReleaseTools,
      );
      expect(bootstrapClaimResponseSchema.safeParse(prompted).success).toBe(
        true,
      );
      expect(configsOf(prompted).length).toBeGreaterThan(1);
      expect(
        configsOf(prompted).map((config) => config.platform_prompt),
      ).toEqual(configsOf(prompted).map(() => prompt));
      expect(
        configsOf(prompted).map(({ platform_prompt: _, ...config }) =>
          shape(config),
        ),
      ).toEqual(
        configsOf(await claimWith(binding, runReleaseTools)).map(shape),
      );
    }
    for (const without of [{ ...binding, platformPrompt: null }, binding]) {
      expect(
        configsOf(await claimWith(without)).some(
          (config) => "platform_prompt" in config,
        ),
      ).toBe(false);
    }

    // At the cap, the profile lists go first: every profile list a claim
    // offered before release lists existed is still offered, either way.
    const many: WorkerBinding = {
      ...binding,
      githubMcp: null,
      restoreProfiles: Array.from({ length: 8 }, () => ({
        profileId: "wide",
        profileFingerprint: profileFingerprint(wide),
        model: "claude-opus-5-5",
      })),
    };
    const full = ["Read", "Edit", "Bash"];
    const narrow = ["Read", "Bash"];
    const crowded = (await claimWith(many, false)).restore_runtime_configs;
    expect(crowded?.map((config) => config.tools)).toEqual([
      ...Array.from({ length: 8 }, () => full),
      ...Array.from({ length: 8 }, () => narrow),
    ]);
    expect(crowded?.[8]?.model).toBe("claude-sonnet-5");
    const crowdedOn = (await claimWith(many)).restore_runtime_configs;
    expect(crowdedOn?.map((config) => config.tools)).toEqual([
      ...Array.from({ length: 9 }, () => full),
      ...Array.from({ length: 7 }, () => narrow),
    ]);
  });

  test("bootstrapClaim answers a launch whose session was failed for a catalog mismatch with a final 409", async () => {
    const { instance } = gateway({
      claimAtomic: async () => ({ outcome: "catalog_mismatch" }),
    });
    await expect(
      instance.bootstrapClaim(
        { kind: "bootstrap" },
        {
          execution_id: "exec-1",
          execution_generation: 1,
          credential: { kind: "launch_nonce", nonce: "nonce" },
        },
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "CATALOG_MISMATCH",
      retryable: false,
    });
  });

  test("bootstrapClaim refuses workload_identity and non-bootstrap principals", async () => {
    const { instance } = gateway({});
    await expect(
      instance.bootstrapClaim(
        { kind: "bootstrap" },
        {
          execution_id: "e",
          execution_generation: 1,
          credential: { kind: "workload_identity", job_uid: "j" },
        },
      ),
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(
      instance.bootstrapClaim(principal, {
        execution_id: "e",
        execution_generation: 1,
        credential: { kind: "launch_nonce", nonce: "n" },
      }),
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  test("requestCheckpoint records the runtime's durable refusal, then answers from the fenced pointer", async () => {
    const stateCalls: unknown[] = [];
    const protocolCalls: unknown[] = [];
    const pointer = {
      committedAt: new Date("2026-09-22T00:00:00Z"),
      manifestRef: "sessions/s/checkpoints/0000000003/att_1/manifest.json",
      manifestSha256: "a".repeat(64),
      revision: 3,
      turnId: "4",
    };
    const instance = createWorkerGateway({
      work: work({
        async checkpointStateAtomic(input) {
          stateCalls.push(input);
          return {
            outcome: "ok",
            pointer,
            restorable: true,
            pendingReason: null,
          };
        },
      }),
      catalog: { profiles: {}, repositories: {} },
      checkpoints: acceptAllCheckpoints,
      checkpointProtocol: {
        async requestCheckpoint(input) {
          protocolCalls.push(input);
          return {
            status: "ready",
            request: {
              manifestRef:
                "sessions/s/checkpoints/0000000004/att_1/manifest.json",
              revision: 4,
              sessionId: input.sessionId,
            },
          };
        },
        async getRestorePlan() {
          return unimplemented();
        },
      },
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 30_000,
      },
    });
    expect(
      await instance.requestCheckpoint(principal, {
        ...scope,
        preparation: { status: "ready" },
      }),
    ).toEqual({
      status: "ready",
      revision: 4,
      manifest_ref: "sessions/s/checkpoints/0000000004/att_1/manifest.json",
    });
    // The pointer the protocol sees is the one the fenced read returned.
    expect(protocolCalls).toEqual([
      {
        attemptId: "att_1",
        preparation: { status: "ready" },
        sessionId: scope.session_id,
        pointer,
      },
    ]);
    // A ready preparation records nothing.
    expect(stateCalls).toHaveLength(1);
    expect(stateCalls[0]).not.toHaveProperty("pendingReason");

    // A mirror failure is the one refusal that outlives the turn: it is
    // written before the answer, so a crash in between cannot lose it.
    expect(
      await instance.requestCheckpoint(principal, {
        ...scope,
        preparation: {
          status: "rejected",
          reason: "mirror_error",
          detail: "batch 7 dropped",
        },
      }),
    ).toEqual({
      status: "blocked",
      reason: "mirror_error",
      detail: "batch 7 dropped",
    });
    expect(stateCalls[1]).toMatchObject({ pendingReason: "mirror_error" });
    // A turn in flight is an ordinary state and leaves nothing behind.
    await instance.requestCheckpoint(principal, {
      ...scope,
      preparation: {
        status: "rejected",
        reason: "turn_in_flight",
        detail: "input pending",
      },
    });
    expect(stateCalls[2]).not.toHaveProperty("pendingReason");
    // The protocol was consulted for the ready request only: a refusal is
    // answered without reading the pointer.
    expect(protocolCalls).toHaveLength(1);
  });

  describe("protectedCommits", () => {
    const build = (
      protocol: Parameters<typeof createWorkerGateway>[0]["checkpointProtocol"],
      state: "ok" | "stale_epoch" = "ok",
    ) =>
      createWorkerGateway({
        work: work({
          async checkpointStateAtomic() {
            return state === "ok"
              ? {
                  outcome: "ok",
                  pointer: null,
                  restorable: false,
                  pendingReason: null,
                }
              : { outcome: "stale_epoch" };
          },
        }),
        catalog: { profiles: {}, repositories: {} },
        checkpoints: acceptAllCheckpoints,
        ...(protocol === undefined ? {} : { checkpointProtocol: protocol }),
        options: {
          sessionCostLimitUsd: 1_000,
          sessionTokenLimit: null,
          leaseTtlMs: 30_000,
        },
      });

    test("lists what the protocol protects, for the fenced session", async () => {
      const asked: unknown[] = [];
      const instance = build({
        requestCheckpoint: unimplemented,
        getRestorePlan: unimplemented,
        protectedCommits: async (input) => {
          asked.push(input);
          return ["a".repeat(40)];
        },
      });
      expect(await instance.protectedCommits(principal, scope)).toEqual({
        commits: ["a".repeat(40)],
      });
      expect(asked).toEqual([{ sessionId: scope.session_id, pointer: null }]);
    });

    test("a stale attempt, a missing object store and a protocol that cannot list are refused, never answered with nothing protected", async () => {
      await expect(
        build(
          {
            requestCheckpoint: unimplemented,
            getRestorePlan: unimplemented,
            protectedCommits: async () => [],
          },
          "stale_epoch",
        ).protectedCommits(principal, scope),
      ).rejects.toMatchObject({ status: 409, code: "STALE_EPOCH" });
      await expect(
        build(undefined).protectedCommits(principal, scope),
      ).rejects.toMatchObject({ status: 409, code: "CHECKPOINT_UNAVAILABLE" });
      await expect(
        build({
          requestCheckpoint: unimplemented,
          getRestorePlan: unimplemented,
        }).protectedCommits(principal, scope),
      ).rejects.toMatchObject({ status: 409, code: "CHECKPOINT_UNAVAILABLE" });
    });
  });

  test("checkpoint protocol calls are fenced and refused outright without an object store", async () => {
    const fenced = createWorkerGateway({
      work: work({
        async checkpointStateAtomic() {
          return { outcome: "stale_epoch" };
        },
      }),
      catalog: { profiles: {}, repositories: {} },
      checkpoints: acceptAllCheckpoints,
      checkpointProtocol: {
        requestCheckpoint: unimplemented,
        getRestorePlan: unimplemented,
      },
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 30_000,
      },
    });
    await expect(
      fenced.requestCheckpoint(principal, {
        ...scope,
        preparation: { status: "ready" },
      }),
    ).rejects.toMatchObject({ status: 409, code: "STALE_EPOCH" });
    await expect(
      fenced.restorePlan(principal, { ...scope, runtime: fingerprint }),
    ).rejects.toMatchObject({ status: 409, code: "STALE_EPOCH" });

    const { instance } = gateway({});
    for (const call of [
      () =>
        instance.requestCheckpoint(principal, {
          ...scope,
          preparation: { status: "ready" },
        }),
      () => instance.restorePlan(principal, { ...scope, runtime: fingerprint }),
    ]) {
      await expect(call()).rejects.toMatchObject({
        status: 409,
        code: "CHECKPOINT_UNAVAILABLE",
      });
    }
  });

  test("restorePlan never plans a restore from a pointer that is not a restore point", async () => {
    // A start_fresh decision retired this pointer: the claim handed out no
    // restore, and a worker asking anyway must not be given the old engine
    // session's transcript either.
    const seen: unknown[] = [];
    const instance = createWorkerGateway({
      work: work({
        async checkpointStateAtomic() {
          return {
            outcome: "ok",
            pointer: {
              committedAt: new Date("2026-09-23T00:00:00Z"),
              manifestRef: "sessions/s/checkpoints/0000000000/att_1/m.json",
              manifestSha256: "a".repeat(64),
              revision: 0,
              turnId: "1",
            },
            restorable: false,
            pendingReason: null,
          };
        },
        // The refusal a missing plan leads to reaches the resume check,
        // which leaves a session that is not resuming alone.
        async failResumeAtomic() {
          return { outcome: "ok", failed: false };
        },
      }),
      catalog: { profiles: {}, repositories: {} },
      checkpoints: acceptAllCheckpoints,
      checkpointProtocol: {
        requestCheckpoint: unimplemented,
        async getRestorePlan(input) {
          seen.push(input.pointer);
          return { status: "none" };
        },
      },
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 30_000,
      },
    });
    expect(
      await instance.restorePlan(principal, { ...scope, runtime: fingerprint }),
    ).toEqual({ status: "none" });
    expect(seen).toEqual([null]);
  });

  test("restorePlan puts the service's plan on the wire and passes refusals through", async () => {
    const seen: unknown[] = [];
    const recorded: RestoreBaseInput[] = [];
    let base: RestoreBaseResult = { outcome: "ok" };
    const failed: FailResumeInput[] = [];
    let resuming = false;
    let answer: Awaited<ReturnType<CheckpointProtocol["getRestorePlan"]>> = {
      status: "none",
    };
    const instance = createWorkerGateway({
      work: work({
        async checkpointStateAtomic() {
          return {
            outcome: "ok",
            pointer: null,
            restorable: false,
            pendingReason: null,
          };
        },
        async recordRestoreBaseAtomic(input) {
          recorded.push(input);
          return base;
        },
        async failResumeAtomic(input) {
          failed.push(input);
          return { outcome: "ok", failed: resuming };
        },
      }),
      catalog: { profiles: {}, repositories: {} },
      checkpoints: acceptAllCheckpoints,
      checkpointProtocol: {
        requestCheckpoint: unimplemented,
        async getRestorePlan(input) {
          seen.push(input);
          return answer;
        },
      },
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 30_000,
      },
    });
    expect(
      await instance.restorePlan(principal, { ...scope, runtime: fingerprint }),
    ).toEqual({ status: "none" });
    expect(seen).toEqual([
      {
        runtime: {
          cliVersion: "2.1.270",
          engine: "claude",
          profileSha256: "c".repeat(64),
          sdkVersion: "0.3.270",
        },
        sessionId: scope.session_id,
        pointer: null,
      },
    ]);

    const object = {
      key: "sessions/s/mirror/root-0.jsonl",
      bytes: 3,
      sha256: "b".repeat(64),
    };
    const bundle = {
      key: "sessions/s/checkpoints/0000000000/att_1/workspace.bundle",
      bytes: 9,
      sha256: "d".repeat(64),
    };
    answer = {
      status: "ready",
      plan: {
        artifacts: [
          { kind: "transcript_root", label: "", objects: [object] },
          { kind: "workspace_bundle", label: "", objects: [bundle] },
          {
            kind: "workspace_untracked",
            label: "",
            objects: [
              { ...object, path: "notes.md" },
              { ...object, executable: true, path: "bin/tool" },
            ],
          },
        ],
        cwd: "/workspace",
        engine: "claude",
        gitCommit: "e".repeat(40),
        manifestRef: "sessions/s/checkpoints/0000000000/att_1/manifest.json",
        manifestSha256: "f".repeat(64),
        objectKeys: [object.key, bundle.key],
        resume: "sdk-session",
        revision: 0,
      },
    };
    expect(
      await instance.restorePlan(principal, { ...scope, runtime: fingerprint }),
    ).toEqual({
      status: "ready",
      plan: {
        revision: 0,
        manifest_ref: "sessions/s/checkpoints/0000000000/att_1/manifest.json",
        manifest_sha256: "f".repeat(64),
        engine: "claude",
        resume: "sdk-session",
        cwd: "/workspace",
        git_commit: "e".repeat(40),
        artifacts: [
          { kind: "transcript_root", label: "", objects: [object] },
          { kind: "workspace_bundle", label: "", objects: [bundle] },
          {
            kind: "workspace_untracked",
            label: "",
            objects: [
              { ...object, path: "notes.md" },
              { ...object, executable: true, path: "bin/tool" },
            ],
          },
        ],
        object_keys: [object.key, bundle.key],
      },
    });

    // An earlier revision restored in the pointer's place says so on the
    // wire too.
    if (answer.status !== "ready") throw new Error("expected a plan");
    answer = {
      status: "ready",
      plan: {
        ...answer.plan,
        fallback: {
          pointerRevision: 1,
          skipped: [{ revision: 1, reason: "manifest object is missing" }],
        },
      },
    };
    expect(
      await instance.restorePlan(principal, { ...scope, runtime: fingerprint }),
    ).toMatchObject({
      status: "ready",
      plan: {
        revision: 0,
        fallback: {
          pointer_revision: 1,
          skipped: [{ revision: 1, reason: "manifest object is missing" }],
        },
      },
    });
    // Each ready plan is recorded before it is handed out: the plain one
    // clears any earlier fallback, this one records its own.
    expect(recorded.map((input) => input.fallback)).toEqual([
      null,
      {
        revision: 0,
        skipped: [{ revision: 1, reason: "manifest object is missing" }],
      },
    ]);
    for (const [result, expected] of [
      [
        { outcome: "pointer_moved", currentRevision: 2 },
        { status: 409, code: "REVISION_CONFLICT" },
      ],
      [
        { outcome: "base_changed", recordedRevision: 3 },
        { status: 409, code: "CHECKPOINT_UNAVAILABLE" },
      ],
      [{ outcome: "stale_epoch" }, { status: 409, code: "STALE_EPOCH" }],
    ] as const) {
      base = result;
      await expect(
        instance.restorePlan(principal, { ...scope, runtime: fingerprint }),
      ).rejects.toMatchObject(expected);
    }
    base = { outcome: "ok" };

    // A resume from `paused` promised the pointer's state: a fallback ends
    // it for an operator instead of quietly resuming older state, and is not
    // recorded as the session's base (with).
    resuming = true;
    const before = recorded.length;
    await expect(
      instance.restorePlan(principal, { ...scope, runtime: fingerprint }),
    ).rejects.toMatchObject({ status: 409, code: "CHECKPOINT_UNAVAILABLE" });
    expect(recorded).toHaveLength(before);
    resuming = false;

    answer = {
      status: "incompatible",
      code: "INCOMPATIBLE_CHECKPOINT",
      mismatches: [
        { field: "sdkVersion", expected: "0.3.270", found: "0.3.1" },
      ],
    };
    expect(
      await instance.restorePlan(principal, { ...scope, runtime: fingerprint }),
    ).toEqual({
      status: "incompatible",
      code: "INCOMPATIBLE_CHECKPOINT",
      mismatches: [
        { field: "sdkVersion", expected: "0.3.270", found: "0.3.1" },
      ],
    });
    answer = {
      status: "incompatible",
      code: "INCOMPATIBLE_CHECKPOINT",
      mismatches: [
        { field: "sdkVersion", expected: "0.3.270", found: "0.3.1" },
      ],
      fallback: {
        pointerRevision: 1,
        revision: 0,
        skipped: [{ revision: 1, reason: "manifest object is missing" }],
      },
    };
    expect(
      await instance.restorePlan(principal, { ...scope, runtime: fingerprint }),
    ).toMatchObject({
      status: "incompatible",
      fallback: {
        pointer_revision: 1,
        revision: 0,
        skipped: [{ revision: 1, reason: "manifest object is missing" }],
      },
    });
    answer = {
      status: "unavailable",
      code: "CHECKPOINT_UNAVAILABLE",
      reason: "manifest object is missing",
    };
    expect(
      await instance.restorePlan(principal, { ...scope, runtime: fingerprint }),
    ).toEqual({
      status: "unavailable",
      code: "CHECKPOINT_UNAVAILABLE",
      reason: "manifest object is missing",
    });
    // Every refusal and every fallback is offered to a resume from `paused`
    // standing on that pointer; a plain plan is not.
    const fellBack = [
      1,
      "CHECKPOINT_UNAVAILABLE",
      "the resume could not restore its checkpoint: revision 1 is damaged and only revision 0 verifies",
    ];
    const incompatible = [
      null,
      "CHECKPOINT_UNAVAILABLE",
      "the resume could not restore its checkpoint: the checkpoint is incompatible with this worker: sdkVersion 0.3.270 != 0.3.1",
    ];
    expect(
      failed.map((input) => [
        input.pointerRevision,
        input.error.code,
        input.error.message,
      ]),
    ).toEqual([
      [
        null,
        "CHECKPOINT_UNAVAILABLE",
        "the resume could not restore its checkpoint: no committed checkpoint to restore",
      ],
      // The fallback plan, the three recording outcomes, and the resume.
      fellBack,
      fellBack,
      fellBack,
      fellBack,
      fellBack,
      incompatible,
      incompatible,
      [
        null,
        "CHECKPOINT_UNAVAILABLE",
        "the resume could not restore its checkpoint: manifest object is missing",
      ],
    ]);
  });

  test("ready reports the restored revision and maps a failed resume to 409 CHECKPOINT_UNAVAILABLE", async () => {
    const seen: ReadyInput[] = [];
    let answer: Awaited<ReturnType<WorkerUnitOfWork["readyAtomic"]>> = {
      outcome: "ok",
      activated: true,
    };
    const { instance } = gateway({
      async readyAtomic(input) {
        seen.push(input);
        return answer;
      },
    });
    expect(
      await instance.ready(principal, { ...scope, restored_revision: 3 }),
    ).toEqual({ activated: true });
    expect(seen[0]?.restoredRevision).toBe(3);
    expect(seen[0]?.fence.attemptId).toBe(scope.attempt_id);

    answer = { outcome: "restore_mismatch" };
    await expect(
      instance.ready(principal, { ...scope, restored_revision: 3 }),
    ).rejects.toMatchObject({ status: 409, code: "CHECKPOINT_UNAVAILABLE" });
    answer = { outcome: "stale_epoch" };
    await expect(
      instance.ready(principal, { ...scope, restored_revision: null }),
    ).rejects.toMatchObject({ status: 409, code: "STALE_EPOCH" });
  });

  test("a restore refusal from an attempt that lost the session answers STALE_EPOCH", async () => {
    const instance = createWorkerGateway({
      work: work({
        async checkpointStateAtomic() {
          return {
            outcome: "ok",
            pointer: null,
            pendingReason: null,
            restorable: false,
          };
        },
        async failResumeAtomic() {
          return { outcome: "stale_epoch" };
        },
      }),
      catalog: { profiles: {}, repositories: {} },
      checkpoints: acceptAllCheckpoints,
      checkpointProtocol: {
        requestCheckpoint: unimplemented,
        async getRestorePlan() {
          return { status: "none" };
        },
      },
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 30_000,
      },
    });
    await expect(
      instance.restorePlan(principal, { ...scope, runtime: fingerprint }),
    ).rejects.toMatchObject({ status: 409, code: "STALE_EPOCH" });
  });

  test("heartbeat forwards the transcript report as dates and leaves it out when absent", async () => {
    const seen: unknown[] = [];
    const { instance } = gateway({
      async heartbeatAtomic(input) {
        seen.push(input);
        return {
          outcome: "ok",
          leaseExpiresAt: new Date(input.now.getTime() + 30_000),
          leaseRemainingMs: 29_990,
          authRevision: 0,
        };
      },
    });
    const beat = await instance.heartbeat(principal, {
      ...scope,
      attempt_state: "running",
    });
    expect(beat.lease_remaining_ms).toBe(29_990);
    expect(seen[0]).not.toHaveProperty("transcript");
    await instance.heartbeat(principal, {
      ...scope,
      attempt_state: "running",
      transcript: {
        persisted_at: "2026-09-22T00:00:05.000Z",
        mirror_error: "batch 3 dropped",
      },
    });
    expect(seen[1]).toMatchObject({
      transcript: {
        persistedAt: new Date("2026-09-22T00:00:05.000Z"),
        mirrorError: "batch 3 dropped",
      },
    });
  });

  test("a checkpoint store that throws is a retryable 503, a verdict stays a 409", async () => {
    const outage = new Error("S3 answered 503 SlowDown");
    const throwing = createWorkerGateway({
      work: work({
        async checkpointStateAtomic() {
          return {
            outcome: "ok",
            pointer: null,
            restorable: false,
            pendingReason: null,
          };
        },
      }),
      catalog: { profiles: {}, repositories: {} },
      checkpoints: {
        async verify() {
          throw outage;
        },
      },
      checkpointProtocol: {
        async requestCheckpoint() {
          throw outage;
        },
        async getRestorePlan() {
          throw outage;
        },
      },
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 30_000,
      },
    });
    const finalizeRequest = {
      ...scope,
      turn_id: "1",
      finalize_key: "f",
      final_source_sequence: 0,
      terminal: {
        status: "completed" as const,
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint: {
        revision: 0,
        manifest_ref: "sessions/s/checkpoints/0000000000/att_1/manifest.json",
        manifest_sha256: "a".repeat(64),
      },
    };
    for (const call of [
      () => throwing.finalize(principal, finalizeRequest),
      () =>
        throwing.requestCheckpoint(principal, {
          ...scope,
          preparation: { status: "ready" },
        }),
      () => throwing.restorePlan(principal, { ...scope, runtime: fingerprint }),
    ]) {
      await expect(call()).rejects.toMatchObject({
        status: 503,
        code: "BACKEND_UNAVAILABLE",
        retryable: true,
      });
    }

    const { instance } = gateway({
      async finalizeAtomic() {
        return { outcome: "checkpoint_conflict", currentRevision: 4 };
      },
    });
    await expect(
      instance.finalize(principal, finalizeRequest),
    ).rejects.toMatchObject({ status: 409, code: "REVISION_CONFLICT" });
  });

  test("a completed turn the session cannot checkpoint is answered 409 CHECKPOINT_UNAVAILABLE", async () => {
    const { instance } = gateway({
      async finalizeAtomic() {
        return { outcome: "checkpoint_required", reason: "mirror_error" };
      },
    });
    await expect(
      instance.finalize(principal, {
        ...scope,
        turn_id: "1",
        finalize_key: "f",
        final_source_sequence: 0,
        terminal: {
          status: "completed",
          reason: null,
          result: null,
          usage: null,
        },
        checkpoint: null,
      }),
    ).rejects.toMatchObject({ status: 409, code: "CHECKPOINT_UNAVAILABLE" });
  });

  test("a gateway without a pending store refuses registration and never reports answers waiting", async () => {
    const { instance } = gateway({
      heartbeatAtomic: async () => ({
        outcome: "ok",
        leaseExpiresAt: new Date("2026-09-22T00:01:00Z"),
        leaseRemainingMs: 60_000,
        authRevision: 0,
      }),
    });
    const refused = await instance
      .registerPending(principal, {
        ...scope,
        turn_id: "1",
        request_id: "req_1",
        input_hash: "a".repeat(64),
        request: { kind: "permission", tool: "Bash", input: {} },
      })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(WorkerGatewayError);
    expect((refused as WorkerGatewayError).status).toBe(404);
    const beat = await instance.heartbeat(principal, {
      ...scope,
      attempt_state: "running",
    });
    expect(beat.control_pending).toBe(false);
  });
});

describe("heartbeat control_pending", () => {
  test("a hint that cannot be read does not fail a beat whose lease already renewed", async () => {
    const instance = createWorkerGateway({
      work: work({
        heartbeatAtomic: async () => ({
          outcome: "ok",
          leaseExpiresAt: new Date("2026-09-22T00:01:00Z"),
          leaseRemainingMs: 60_000,
          authRevision: 0,
        }),
      }),
      catalog: { profiles: {}, repositories: {} },
      checkpoints: acceptAllCheckpoints,
      pending: {
        hasUndelivered: async () => {
          throw Object.assign(new Error("deadlock detected"), {
            code: "40P01",
          });
        },
      } as unknown as NonNullable<
        Parameters<typeof createWorkerGateway>[0]["pending"]
      >,
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 30_000,
      },
    });
    const beat = await instance.heartbeat(principal, {
      ...scope,
      attempt_state: "running",
    });
    expect(beat.lease_remaining_ms).toBe(60_000);
    expect(beat.control_pending).toBe(false);
  });
});

describe("authorizeEgress", () => {
  const profile: CatalogProfile = {
    runtime_kind: "claude_agent_sdk",
    runtime_version: "0.3.270",
    model: "claude-sonnet-5",
    tools: ["Read"],
    permission_mode: "default",
    provider: {
      kind: "litellm",
      endpoint: "https://litellm.invalid/anthropic",
      auth: {
        kind: "bearer",
        value: "provider-key",
        ref: { value_env: "PROVIDER_KEY" },
      },
    },
  };
  const repository: CatalogRepository = {
    url: "https://git.invalid/team/app.git",
    branch: "main",
    profiles: ["p"],
    auth: { kind: "github_app", registered: true },
  };
  const granted = (binding: string, costUsd = 0): EgressAuthorization => ({
    outcome: "ok",
    sessionId: scope.session_id,
    attemptId: "att_1",
    binding,
    profileId: "p",
    githubPolicySource: "release",
    model: profile.model,
    costUsd,
    providerTokens: 0,
    repository: { id: "app", url: repository.url, branch: "main" },
  });

  function authorizer(
    answer: EgressAuthorization,
    catalog: SessionCatalog = {
      profiles: { p: profile },
      repositories: { app: repository },
    },
  ) {
    const asked: Array<{ tokenHash: Uint8Array; purpose: string }> = [];
    const cuts: Array<{ sessionId: string; attemptId: string; model: string }> =
      [];
    const instance = createWorkerGateway({
      work: work({
        authorizeEgressAtomic: async (input) => {
          asked.push(input);
          return answer;
        },
        recordModelCutAtomic: async (input) => {
          cuts.push(input);
          return { recorded: true };
        },
      }),
      catalog: withSeededInstallation(catalog),
      github: {
        grant: async () =>
          ({
            gitCredential: {
              username: "x-access-token",
              password: "installation-token",
            },
          }) as GitHubGrant,
      },
      checkpoints: acceptAllCheckpoints,
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 30_000,
      },
    });
    return { asked, cuts, instance };
  }

  test("a model taken off the list is cut with the reason written to the session, other moves are not", async () => {
    const binding = profileFingerprint(profile);
    const retired = { ...granted(binding), model: "retired-model" };
    const cut = authorizer(retired);
    await expect(
      cut.instance.authorizeEgress({ token: "tok", purpose: "provider" }),
    ).rejects.toMatchObject({ status: 409, code: "CATALOG_MISMATCH" });
    expect(cut.cuts).toEqual([
      {
        sessionId: scope.session_id,
        attemptId: "att_1",
        model: "retired-model",
      },
    ]);
    // Still on the list: nothing to say.
    const kept = authorizer(granted(binding));
    await kept.instance.authorizeEgress({ token: "tok", purpose: "provider" });
    expect(kept.cuts).toEqual([]);
    // The profile itself changed: the catalog's own cut, no model note.
    const changed = authorizer(granted(binding), {
      profiles: {
        p: {
          ...profile,
          provider: { ...profile.provider, endpoint: "https://x.invalid" },
        },
      },
      repositories: { app: repository },
    });
    await expect(
      changed.instance.authorizeEgress({ token: "tok", purpose: "provider" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(changed.cuts).toEqual([]);
  });

  test("a note that cannot be written is reported and the cut stays a 409", async () => {
    const reported: Array<{ error: unknown; sessionId: string }> = [];
    const failure = new Error("db down");
    const instance = createWorkerGateway({
      work: work({
        authorizeEgressAtomic: async () => ({
          ...granted(profileFingerprint(profile)),
          model: "retired-model",
        }),
        recordModelCutAtomic: async () => {
          throw failure;
        },
      }),
      catalog: withSeededInstallation({
        profiles: { p: profile },
        repositories: { app: repository },
      }),
      checkpoints: acceptAllCheckpoints,
      onModelCutError: (error, cut) =>
        reported.push({ error, sessionId: cut.sessionId }),
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 30_000,
      },
    });
    await expect(
      instance.authorizeEgress({ token: "tok", purpose: "provider" }),
    ).rejects.toMatchObject({ status: 409, code: "CATALOG_MISMATCH" });
    expect(reported).toEqual([{ error: failure, sessionId: scope.session_id }]);
  });

  test("a provider token is answered with the endpoint and the key to inject", async () => {
    const { asked, instance } = authorizer(
      granted(profileFingerprint(profile)),
    );
    const grant = await instance.authorizeEgress({
      token: "wep_x",
      purpose: "provider",
    });
    expect(asked).toEqual([
      { tokenHash: hashWorkerToken("wep_x"), purpose: "provider" },
    ]);
    expect(grant).toEqual({
      session_id: scope.session_id,
      attempt_id: "att_1",
      upstream: {
        url: "https://litellm.invalid/anthropic",
        headers: [["authorization", "Bearer provider-key"]],
      },
    });
    const apiKey: CatalogProfile = {
      ...profile,
      provider: {
        kind: "anthropic",
        endpoint: "https://api.anthropic.invalid",
        auth: {
          kind: "api_key",
          value: "anthropic-key",
          ref: { value_env: "K" },
        },
      },
    };
    const anthropic = authorizer(granted(profileFingerprint(apiKey)), {
      profiles: { p: apiKey },
      repositories: { app: repository },
    });
    expect(
      (
        await anthropic.instance.authorizeEgress({
          token: "wep_x",
          purpose: "provider",
        })
      ).upstream.headers,
    ).toEqual([["x-api-key", "anthropic-key"]]);
  });

  test("an unknown token is 401 and an attempt that lost its session is 403", async () => {
    await expect(
      authorizer({ outcome: "invalid_token" }).instance.authorizeEgress({
        token: "wep_x",
        purpose: "provider",
      }),
    ).rejects.toMatchObject({ status: 401 });
    for (const outcome of ["stale_epoch", "lease_expired"] as const) {
      await expect(
        authorizer({ outcome }).instance.authorizeEgress({
          token: "wep_x",
          purpose: "provider",
        }),
      ).rejects.toMatchObject({ status: 403 });
    }
  });

  test("a session at its cost limit gets no provider grant, and still its repository", async () => {
    const binding = profileFingerprint(profile);
    const under = await authorizer(
      granted(binding, 999.99),
    ).instance.authorizeEgress({ token: "tok", purpose: "provider" });
    expect(under.session_id).toBe(scope.session_id);
    await expect(
      authorizer(granted(binding, 1_000)).instance.authorizeEgress({
        token: "tok",
        purpose: "provider",
      }),
    ).rejects.toMatchObject({ status: 403, code: "BUDGET_EXCEEDED" });
    // The checkout a recovery needs is not a provider call.
    const repositoryGrant = await authorizer(
      granted(repositoryBinding("app", repository), 1_000),
    ).instance.authorizeEgress({ token: "tok", purpose: "repository" });
    expect(repositoryGrant.session_id).toBe(scope.session_id);
  });

  test("a catalog that moved since the claim is refused, a rotated value is not", async () => {
    const binding = profileFingerprint(profile);
    const moved: CatalogProfile = {
      ...profile,
      provider: { ...profile.provider, endpoint: "https://elsewhere.invalid" },
    };
    await expect(
      authorizer(granted(binding), {
        profiles: { p: moved },
        repositories: { app: repository },
      }).instance.authorizeEgress({ token: "wep_x", purpose: "provider" }),
    ).rejects.toMatchObject({ status: 409, code: "CATALOG_MISMATCH" });
    const rotated: CatalogProfile = {
      ...profile,
      provider: {
        ...profile.provider,
        auth: { ...profile.provider.auth, value: "rotated-key" },
      },
    } as CatalogProfile;
    expect(
      (
        await authorizer(granted(binding), {
          profiles: { p: rotated },
          repositories: { app: repository },
        }).instance.authorizeEgress({ token: "wep_x", purpose: "provider" })
      ).upstream.headers,
    ).toEqual([["authorization", "Bearer rotated-key"]]);

    const repoBinding = repositoryBinding("app", repository);
    for (const repositories of [
      // Re-pointed at another URL, or another branch.
      { app: { ...repository, url: "https://git.invalid/other.git" } },
      { app: { ...repository, branch: "dev" } },
      // The pair is no longer allowed.
      { app: { ...repository, profiles: ["someone-else"] } },
      // Gone.
      {},
    ]) {
      await expect(
        authorizer(granted(repoBinding), {
          profiles: { p: profile },
          repositories,
        }).instance.authorizeEgress({ token: "wer_x", purpose: "repository" }),
      ).rejects.toMatchObject({ status: 409 });
    }
  });
});

describe("authorizeEgress through a forge", () => {
  const profile: CatalogProfile = {
    runtime_kind: "claude_agent_sdk",
    runtime_version: "0.3.270",
    model: "claude-sonnet-5",
    tools: ["Read"],
    permission_mode: "default",
    provider: {
      kind: "anthropic",
      endpoint: "https://api.anthropic.invalid",
      auth: {
        kind: "api_key",
        value: "anthropic-key",
        ref: { value_env: "K" },
      },
    },
  };
  const app: CatalogRepository = {
    url: "https://github.com/acme/app.git",
    branch: "main",
    profiles: ["p"],
    auth: {
      kind: "github_app",
      app_id: 101,
      installation_id: 202,
      api_base: "https://api.github.com",
      value: "-----BEGIN RSA PRIVATE KEY-----fixture",
      ref: { value_env: "GITHUB_APP_KEY" },
    },
  };

  function gateway(
    repository: CatalogRepository,
    github?: GitHubGate,
    others: { docs?: CatalogRepository; source?: string } = {},
  ): ReturnType<typeof createWorkerGateway> {
    const { source = "release", ...repositories } = others;
    return createWorkerGateway({
      work: work({
        authorizeEgressAtomic: async () => ({
          outcome: "ok",
          sessionId: scope.session_id,
          attemptId: "att_1",
          binding: repositoryBinding("app", repository),
          profileId: "p",
          model: profile.model,
          githubPolicySource: source,
          costUsd: 0,
          providerTokens: 0,
          repository: { id: "app", url: repository.url, branch: "main" },
        }),
      }),
      catalog: withSeededInstallation({
        profiles: { p: profile },
        repositories: { app: repository, ...repositories },
      }),
      checkpoints: acceptAllCheckpoints,
      ...(github === undefined ? {} : { github }),
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 30_000,
      },
    });
  }
  function gate(
    answer: (work: GitHubWork) => Promise<GitHubGrant["gitCredential"] | null>,
  ): GitHubGate & { asked: GitHubWork[] } {
    const asked: GitHubWork[] = [];
    return {
      asked,
      async grant(work) {
        asked.push(work);
        const issued = await answer(work);
        if (issued === null) return null;
        return {
          role: "author",
          repo: { owner: "acme", name: "app" },
          permissions: { contents: "read" },
          gitCredential: issued,
          api: {} as GitHubGrant["api"],
          unit: async () => "app:test:1",
          allowedBy: null,
          context: {
            ownerId: "owner",
            sessionId: work.sessionId,
            agentId: null,
            agentReleaseId: null,
            repositoryId: "app",
            policy: {},
          },
        };
      },
    };
  }
  const basic = (login: string) =>
    `Basic ${Buffer.from(login).toString("base64")}`;

  test("an App repository's route carries the installation token the gate issued for clone", async () => {
    const github = gate(async () => ({
      username: "x-access-token",
      password: "installation-token-1",
      expiresAt: new Date("2030-01-01T00:00:00Z"),
    }));
    const grant = await gateway(app, github).authorizeEgress({
      token: "tok",
      purpose: "repository",
    });
    expect(github.asked).toEqual([
      { sessionId: scope.session_id, purpose: "clone" },
    ]);
    expect(grant.upstream).toEqual({
      url: app.url,
      headers: [
        ["authorization", basic("x-access-token:installation-token-1")],
      ],
    });
  });

  test("a gate refusal gets no clone credential: policy refusals are 403, the rest 409", async () => {
    for (const [reason, status] of [
      ["github_disabled", 403],
      ["repository_not_allowed", 403],
      ["github_settings_unsupported", 409],
      ["app_required", 409],
    ] as const) {
      const github = gate(async () => {
        throw new GitHubGateError(reason, "receipt-1");
      });
      for (const repository of [app]) {
        await expect(
          gateway(repository, github).authorizeEgress({
            token: "tok",
            purpose: "repository",
          }),
        ).rejects.toMatchObject({
          status,
          code: "GITHUB_REFUSED",
          reasonCode: reason,
        });
      }
    }
  });

  test("the session's own repository off the profile's list: moved on a release, the gate's call on an agent's", async () => {
    const offProfile: CatalogRepository = { ...app, profiles: ["elsewhere"] };
    const github = gate(async () => ({
      username: "x-access-token",
      password: "from-gate",
    }));
    await expect(
      gateway(offProfile, github).authorizeEgress({
        token: "tok",
        purpose: "repository",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(github.asked).toEqual([]);
    await gateway(offProfile, github, { source: "agent" }).authorizeEgress({
      token: "tok",
      purpose: "repository",
    });
    expect(github.asked).toEqual([
      { sessionId: scope.session_id, purpose: "clone" },
    ]);
  });

  test("a stored source this image does not know reads as the agent's", async () => {
    const offProfile: CatalogRepository = { ...app, profiles: ["elsewhere"] };
    const github = gate(async () => ({
      username: "x-access-token",
      password: "from-gate",
    }));
    await gateway(offProfile, github, { source: "later" }).authorizeEgress({
      token: "tok",
      purpose: "repository",
    });
    expect(github.asked).toHaveLength(1);
  });

  test("another repository's route asks the gate for that repository and goes to its url", async () => {
    const docs: CatalogRepository = {
      ...app,
      url: "https://github.com/acme/docs.git",
    };
    const github = gate(async () => ({
      username: "x-access-token",
      password: "docs-install-token",
    }));
    const grant = await gateway(app, github, { docs }).authorizeEgress({
      token: "tok",
      purpose: "repository",
      repository_id: "docs",
    });
    expect(github.asked).toEqual([
      { sessionId: scope.session_id, purpose: "clone", repositoryId: "docs" },
    ]);
    expect(grant.upstream).toEqual({
      url: docs.url,
      headers: [["authorization", basic("x-access-token:docs-install-token")]],
    });
    await expect(
      gateway(app, undefined, { docs }).authorizeEgress({
        token: "tok",
        purpose: "repository",
        repository_id: "docs",
      }),
    ).rejects.toThrow();
  });

  test("an App repository with no gate, a gate that fails, or no GitHub connection is refused with nothing of the failure", async () => {
    const failing = gate(async () => {
      throw new Error("token endpoint said ghs_leaky and eyJ.jwt");
    });
    for (const instance of [
      gateway(app),
      gateway(app, failing),
      gateway(
        app,
        gate(async () => null),
      ),
    ]) {
      const refusal = await instance
        .authorizeEgress({ token: "t", purpose: "repository" })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(refusal).toBeInstanceOf(WorkerGatewayError);
      expect(refusal).toMatchObject({
        status: 503,
        code: "BACKEND_UNAVAILABLE",
        message: "The repository's forge credential could not be issued",
      });
    }
    expect(failing.asked).toHaveLength(1);
  });
});

describe("unmetered sessions", () => {
  const local: CatalogProfile = {
    runtime_kind: "claude_agent_sdk",
    runtime_version: "0.3.270",
    model: "gemma4-local",
    tools: ["Read"],
    permission_mode: "default",
    provider: {
      kind: "litellm",
      endpoint: "http://litellm:4000",
      auth: {
        kind: "bearer",
        value: "master-key",
        ref: { value_env: "LITELLM_MASTER_KEY" },
      },
      billing: "none",
    },
  };
  const usage = {
    // A name the table knows, so a billed session prices it from the table.
    model: "claude-sonnet-5",
    inputTokens: 1_000_000,
    outputTokens: 1_000,
    cacheCreationInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    cacheReadInputTokens: 0,
    speed: "standard",
    inferenceGeo: "global",
    webSearchRequests: 0,
    webFetchRequests: 0,
    codeExecutionRequests: 0,
    estimated: false,
  };

  // The catalog is empty on purpose: a replica that does not know the
  // session's profile prices its calls from the row all the same.
  function priced(unmetered: boolean, reported = usage) {
    const instance = createWorkerGateway({
      work: work({
        recordProviderUsageAtomic: async (input) => ({
          outcome: "recorded",
          ...input.priceFor({ unmetered }),
        }),
      }),
      catalog: { profiles: {}, repositories: {} },
      checkpoints: acceptAllCheckpoints,
      options: {
        sessionCostLimitUsd: 1,
        sessionTokenLimit: null,
        leaseTtlMs: 30_000,
      },
    });
    return instance.recordProviderUsage({
      exchangeId: "ex_1",
      sessionId: scope.session_id,
      attemptId: "att_1",
      usage: reported,
    });
  }

  test("a call on an unmetered session costs nothing, whatever model the answer names", async () => {
    expect(await priced(true)).toEqual({ costUsd: 0, pricedBy: "unmetered" });
    expect(await priced(true, { ...usage, model: "gemma4-local" })).toEqual({
      costUsd: 0,
      pricedBy: "unmetered",
    });
  });

  test("a call on a billed session prices as before: the table, or the fallback", async () => {
    expect((await priced(false)).pricedBy).toBe("table");
    expect(
      (await priced(false, { ...usage, model: "gemma4-local" })).pricedBy,
    ).toBe("fallback");
  });

  test("the claim gives an unmetered session no budget and a billed one what is left", async () => {
    const claim = async (unmetered: boolean) => {
      const instance = createWorkerGateway({
        work: work({
          claimAtomic: async () => ({
            outcome: "claimed",
            binding: {
              sessionId: scope.session_id,
              attemptId: "att_1",
              leaseEpoch: 1,
              executionGeneration: 1,
              authRevision: 0,
              leaseExpiresAt: new Date("2026-09-22T00:00:30Z"),
              leaseRemainingMs: 30_000,
              profileId: "local",
              profileFingerprint: null,
              model: null,
              unmetered,
              ownerScope: "owner-a",
              repository: {
                id: "app",
                url: "https://example.invalid/app.git",
                branch: "main",
              },
              restore: null,
              restoreProfiles: [],
              costUsd: 0.25,
              providerTokens: 0,
            },
          }),
        }),
        catalog: withSeededInstallation({
          profiles: { local },
          repositories: {
            app: {
              url: "https://example.invalid/app.git",
              branch: "main",
              profiles: ["local"],
              auth: { kind: "github_app", registered: true },
            },
          },
        }),
        checkpoints: acceptAllCheckpoints,
        options: {
          sessionCostLimitUsd: 1,
          sessionTokenLimit: null,
          leaseTtlMs: 30_000,
        },
      });
      const response = await instance.bootstrapClaim(
        { kind: "bootstrap" },
        {
          execution_id: "e",
          execution_generation: 1,
          credential: { kind: "launch_nonce", nonce: "n" },
        },
      );
      return bootstrapClaimResponseSchema.parse(response).remaining_budget_usd;
    };
    expect(await claim(true)).toBeNull();
    expect(await claim(false)).toBe(0.75);
  });
});

describe("egress and claim through the real GitHub gate", () => {
  // The release lists docs and tools; the session attached docs alone.
  const profile: CatalogProfile = {
    runtime_kind: "claude_agent_sdk",
    runtime_version: "0.3.270",
    model: "claude-sonnet-5",
    tools: ["Read"],
    permission_mode: "default",
    repository: "optional",
    provider: {
      kind: "anthropic",
      endpoint: "https://api.anthropic.invalid",
      auth: {
        kind: "api_key",
        value: "anthropic-key",
        ref: { value_env: "K" },
      },
    },
  };
  const onGitHub = (name: string): CatalogRepository => ({
    url: `https://github.com/acme/${name}.git`,
    branch: "main",
    profiles: ["p"],
    auth: { kind: "github_app", registered: true },
  });
  const catalog = withSeededInstallation({
    // `scratch` runs without repositories: the catalog lets it reach none.
    profiles: {
      p: profile,
      scratch: { ...profile, repository: "none" as const },
    },
    repositories: {
      app: onGitHub("app"),
      docs: onGitHub("docs"),
      tools: onGitHub("tools"),
    },
  });
  const binding = {
    sessionId: scope.session_id,
    attemptId: "att_1",
    profileId: "p",
    model: profile.model,
    githubPolicySource: "release",
    costUsd: 0,
    providerTokens: 0,
    repository: { id: "app", url: onGitHub("app").url, branch: "main" },
  };

  // `repositoryless`: started without a repository, attaching docs alone
  // unless `attached` says otherwise, on the optional profile unless
  // `profileId` names another.
  function wired({
    repositoryless = false,
    profileId = "p",
    attached = ["docs"] as string[] | null,
  } = {}) {
    const own = repositoryless
      ? { repository: null, profileId }
      : { repository: binding.repository, profileId };
    const receipts: GitHubGateReceipt[] = [];
    const connection: GitHubConnection = {
      kind: "app",
      githubCom: true,
      appId: 7,
      installedOn: async (repos) =>
        new Map(
          repos.map((repo) => [
            `${repo.owner}/${repo.name}`.toLowerCase(),
            true,
          ]),
        ),
      quotaKey: async () => "app:7",
      installed: async () => true,
      credential: async (repo) => ({
        credential: {
          username: "x-access-token",
          password: `installation-for-${repo.name}`,
        },
        fresh: true,
      }),
      api: () => ({}) as GitHubGrant["api"],
    };
    const gate = createGitHubGate({
      catalog,
      connections: (_id, role) =>
        role === "author" ? { kind: "fixed", connection } : null,
      store: {
        context: async (sessionId): Promise<GitHubSessionContext | null> => ({
          ownerId: "owner-a",
          sessionId,
          repositoryId: repositoryless ? null : "app",
          profileId,
          attachedRepositoryIds: attached,
          repository: repositoryless
            ? null
            : { url: onGitHub("app").url, branch: "main" },
          startedBy: null,
          agent: { id: "agent-1", workspaceId: "owner-a", githubEnabled: true },
          release: { id: "release-1" },
          policy: releasePolicy({
            repositories: ["app", "docs", "tools"],
            push_approval: true,
            features: GITHUB_FEATURES_NONE,
            actions_allow: [],
          }),
          ceiling: GITHUB_CEILING_NONE,
          repositoryCeiling: null,
          ceilingRevision: 0,
        }),
        findDispatch: async () => null,
        recordReceipt: async (receipt) => {
          receipts.push(receipt);
          return `receipt-${receipts.length}`;
        },
      },
    });
    // What the claim bound the repository token to, as storage keeps it: a
    // null binding issues no token, so the proxy's request is unknown.
    let issued: string | null = repositoryBinding("app", onGitHub("app"));
    const gateway = createWorkerGateway({
      work: work({
        authorizeEgressAtomic: async () =>
          issued === null
            ? { outcome: "invalid_token" }
            : { outcome: "ok", ...binding, ...own, binding: issued },
        claimAtomic: async (input) => {
          issued = input.egress.bindingsOf({
            id: scope.session_id,
            profileId,
            profileFingerprint: null,
            model: null,
            repositoryMode: repositoryless ? "none" : "repository",
            repositoryId: repositoryless ? null : "app",
            githubPolicySource: "release",
          }).repository;
          return {
            outcome: "claimed",
            binding: {
              ...binding,
              ...own,
              leaseEpoch: 1,
              executionGeneration: 1,
              authRevision: 0,
              leaseExpiresAt: new Date("2026-09-22T00:00:30Z"),
              leaseRemainingMs: 29_950,
              profileFingerprint: null,
              model: null,
              unmetered: false,
              ownerScope: "owner-a",
              restore: null,
              restoreProfiles: [],
            },
          };
        },
      }),
      catalog,
      github: gate,
      checkpoints: acceptAllCheckpoints,
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 30_000,
      },
    });
    const claim = () =>
      gateway.bootstrapClaim(
        { kind: "bootstrap" },
        {
          execution_id: "e",
          execution_generation: 1,
          credential: { kind: "launch_nonce", nonce: "n" },
        },
      );
    // Stands for a repository token however it came to be held.
    const hold = (held: string) => {
      issued = held;
    };
    return { gateway, receipts, claim, hold };
  }

  test("a repository the release lists but the session did not attach is refused with its receipt", async () => {
    const { gateway, receipts } = wired();
    await expect(
      gateway.authorizeEgress({
        token: "tok",
        purpose: "repository",
        repository_id: "tools",
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "GITHUB_REFUSED",
      reasonCode: "repository_not_allowed",
    });
    expect(receipts).toEqual([
      expect.objectContaining({
        sessionId: scope.session_id,
        operation: "mint_github_token",
        status: "failed",
        result: expect.objectContaining({
          repository_id: "tools",
          purpose: "clone",
          reason_code: "repository_not_allowed",
        }),
      }),
    ]);
  });

  test("the attached one is fetched with its own contents: read token", async () => {
    const { gateway, receipts } = wired();
    const grant = await gateway.authorizeEgress({
      token: "tok",
      purpose: "repository",
      repository_id: "docs",
    });
    expect(grant.upstream?.url).toBe(onGitHub("docs").url);
    expect(receipts.at(-1)).toMatchObject({
      status: "succeeded",
      result: {
        repository_id: "docs",
        purpose: "clone",
        permissions: { contents: "read" },
      },
    });
  });

  test("a claim attaches only the session's attached repositories", async () => {
    const { gateway } = wired();
    const claimed = await gateway.bootstrapClaim(
      { kind: "bootstrap" },
      {
        execution_id: "e",
        execution_generation: 1,
        credential: { kind: "launch_nonce", nonce: "n" },
      },
    );
    expect(
      claimed.workspace.additional_repositories?.map(({ id }) => id),
    ).toEqual(["docs"]);
  });

  test("a session created with none attached is claimed with none; a null list from before is claimed with the release's whole list", async () => {
    // The release lists app, docs and tools; app is the session's own unless
    // it started without a repository.
    for (const [repositoryless, attached, expected] of [
      [false, [], undefined],
      [true, [], undefined],
      [false, null, ["docs", "tools"]],
      [true, null, ["app", "docs", "tools"]],
    ] as const) {
      const { claim } = wired({
        repositoryless,
        attached: attached === null ? null : [...attached],
      });
      const claimed = await claim();
      expect(
        claimed.workspace.additional_repositories?.map(({ id }) => id),
      ).toEqual(expected === undefined ? undefined : [...expected]);
    }
  });

  test("a session without a repository is claimed with the one it attached", async () => {
    const { gateway } = wired({ repositoryless: true });
    const claimed = await gateway.bootstrapClaim(
      { kind: "bootstrap" },
      {
        execution_id: "e",
        execution_generation: 1,
        credential: { kind: "launch_nonce", nonce: "n" },
      },
    );
    expect(claimed.workspace.repository).toBeNull();
    expect(
      claimed.workspace.additional_repositories?.map(({ id }) => id),
    ).toEqual(["docs"]);
  });

  test("a session without a repository fetches the attached one and is refused the rest", async () => {
    const { gateway, receipts, claim } = wired({ repositoryless: true });
    await claim();
    const grant = await gateway.authorizeEgress({
      token: "tok",
      purpose: "repository",
      repository_id: "docs",
    });
    expect(grant.upstream?.url).toBe(onGitHub("docs").url);
    expect(receipts.at(-1)).toMatchObject({
      status: "succeeded",
      result: { repository_id: "docs", purpose: "clone" },
    });
    await expect(
      gateway.authorizeEgress({
        token: "tok",
        purpose: "repository",
        repository_id: "tools",
      }),
    ).rejects.toMatchObject({
      status: 403,
      reasonCode: "repository_not_allowed",
    });
    expect(receipts.at(-1)).toMatchObject({
      status: "failed",
      result: { repository_id: "tools", reason_code: "repository_not_allowed" },
    });
    // No repository of its own to route an unnamed request to.
    await expect(
      gateway.authorizeEgress({ token: "tok", purpose: "repository" }),
    ).rejects.toMatchObject({ status: 409, code: "CATALOG_MISMATCH" });
  });

  test("a none profile's session gets no repository token, and the gate refuses one it holds", async () => {
    const { gateway, receipts, claim, hold } = wired({
      repositoryless: true,
      profileId: "scratch",
    });
    const claimed = await claim();
    expect(claimed.workspace.additional_repositories).toBeUndefined();
    await expect(
      gateway.authorizeEgress({
        token: "tok",
        purpose: "repository",
        repository_id: "docs",
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(receipts).toEqual([]);

    hold("attached-only");
    await expect(
      gateway.authorizeEgress({
        token: "tok",
        purpose: "repository",
        repository_id: "docs",
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "GITHUB_REFUSED",
      reasonCode: "repository_not_allowed",
    });
    expect(receipts).toEqual([
      expect.objectContaining({
        operation: "mint_github_token",
        status: "failed",
        result: expect.objectContaining({
          repository_id: "docs",
          reason_code: "repository_not_allowed",
        }),
      }),
    ]);
  });
});
