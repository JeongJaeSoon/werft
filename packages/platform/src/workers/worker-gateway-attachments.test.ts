import { describe, expect, test } from "bun:test";
import {
  bootstrapClaimResponseSchema,
  GITHUB_CEILING_NONE,
  GITHUB_FEATURES_NONE,
  type ReceiptActor,
} from "@werft-ai/contracts";
import type {
  GitHubConnection,
  GitHubGateReceipt,
  GitHubGrant,
  GitHubSessionContext,
} from "../github/ports/github-gate.ts";
import { createGitHubGate } from "../github/service/github-gate.ts";
import { acceptAllCheckpoints } from "../ports/checkpoint-verifier.ts";
import type { WorkerPendingStore } from "../ports/pending-requests.ts";
import type { WorkerUnitOfWork } from "../ports/worker-unit-of-work.ts";
import type { CatalogProfile, CatalogRepository } from "../sessions/catalog.ts";
import { withSeededInstallation } from "../sessions/profile-registry.ts";
import { createRepositoryAttachmentService } from "../sessions/repository-attachment-service.ts";
import { releasePolicy } from "../testing/github-fakes.ts";
import { memoryAttachmentStore } from "../testing/repository-attachment-fakes.ts";
import { createWorkerGateway } from "./worker-gateway.ts";

const SESSION = "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const COMMIT = "d".repeat(40);
const scope = {
  session_id: SESSION,
  turn_id: null,
  attempt_id: "att_1",
  lease_epoch: 1,
  execution_generation: 1,
  auth_revision: 0,
};
const principal = {
  kind: "session",
  attemptId: "att_1",
  sessionId: SESSION,
  leaseEpoch: 1,
  executionGeneration: 1,
  authRevision: 0,
} as const;
const actor: ReceiptActor = {
  principal: { kind: "user", id: "user-1" },
  actor_user_id: "user-1",
  agent_id: "agent-1",
};

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
    auth: { kind: "api_key", value: "anthropic-key", ref: { value_env: "K" } },
  },
};
const onGitHub = (name: string): CatalogRepository => ({
  url: `https://github.com/acme/${name}.git`,
  branch: "main",
  profiles: ["p"],
  auth: { kind: "github_app", registered: true },
});
const catalog = withSeededInstallation({
  profiles: { p: profile },
  repositories: { docs: onGitHub("docs"), tools: onGitHub("tools") },
});

/** Every unit-of-work call these tests do not expect throws. */
function work(overrides: Partial<WorkerUnitOfWork>): WorkerUnitOfWork {
  return new Proxy(overrides, {
    get(target, key) {
      if (key in target) return target[key as keyof WorkerUnitOfWork];
      return () => {
        throw new Error(`not reached: ${String(key)}`);
      };
    },
  }) as WorkerUnitOfWork;
}

// A session started without a repository, attaching nothing at first, whose
// release lists docs and tools. The gate reads the attached list on every
// call; the attachment store writes the same list.
function wired() {
  const attached: string[] = [];
  const receipts: GitHubGateReceipt[] = [];
  const connection: GitHubConnection = {
    kind: "app",
    githubCom: true,
    appId: 7,
    installedOn: async (repos) =>
      new Map(
        repos.map((repo) => [`${repo.owner}/${repo.name}`.toLowerCase(), true]),
      ),
    quotaKey: async () => "app:7",
    installed: async () => true,
    credential: async () => ({
      credential: { username: "x-access-token", password: "app-token" },
      fresh: true,
    }),
    api: () => ({}) as GitHubGrant["api"],
  };
  const context = async (
    sessionId: string,
  ): Promise<GitHubSessionContext | null> => ({
    ownerId: "owner-a",
    sessionId,
    repositoryId: null,
    profileId: "p",
    attachedRepositoryIds: [...attached],
    repository: null,
    startedBy: null,
    agent: { id: "agent-1", workspaceId: "owner-a", githubEnabled: true },
    release: { id: "release-1" },
    policy: releasePolicy({
      repositories: ["docs", "tools"],
      push_approval: true,
      features: GITHUB_FEATURES_NONE,
      actions_allow: [],
    }),
    ceiling: GITHUB_CEILING_NONE,
    repositoryCeiling: null,
    ceilingRevision: 0,
  });
  const gate = createGitHubGate({
    catalog,
    connections: (_id, role) =>
      role === "author" ? { kind: "fixed", connection } : null,
    store: {
      context,
      findDispatch: async () => null,
      recordReceipt: async (receipt) => {
        receipts.push(receipt);
        return `receipt-${receipts.length}`;
      },
    },
  });
  const memory = memoryAttachmentStore();
  const store = Object.assign(Object.create(memory), {
    request: async (input: Parameters<typeof memory.request>[0]) => {
      const outcome = await memory.request(input);
      if (outcome.outcome === "requested") attached.push(input.repositoryId);
      return outcome;
    },
  }) as typeof memory;
  const attachments = createRepositoryAttachmentService({
    store,
    context: { context },
    catalog,
  });
  const binding = {
    sessionId: SESSION,
    attemptId: "att_1",
    profileId: "p",
    model: profile.model,
    githubPolicySource: "release",
    costUsd: 0,
    providerTokens: 0,
    repository: null,
  };
  const pending = {
    hasUndelivered: async () => false,
    pendingControlAtomic: async () => ({
      outcome: "ok",
      control: null,
      answers: [],
    }),
  } as unknown as WorkerPendingStore;
  const gateway = createWorkerGateway({
    work: work({
      authorizeEgressAtomic: async () => ({
        outcome: "ok",
        ...binding,
        binding: "attached-only",
      }),
      heartbeatAtomic: async () => ({
        outcome: "ok",
        leaseExpiresAt: new Date("2026-09-22T00:01:00Z"),
        leaseRemainingMs: 60_000,
        authRevision: 0,
      }),
      claimAtomic: async () => ({
        outcome: "claimed",
        binding: {
          ...binding,
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
      }),
    }),
    catalog,
    github: gate,
    pending,
    attachments: store,
    checkpoints: acceptAllCheckpoints,
    options: {
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
      leaseTtlMs: 30_000,
    },
  });
  const fetchDocs = () =>
    gateway.authorizeEgress({
      token: "tok",
      purpose: "repository",
      repository_id: "docs",
    });
  const attach = (repositoryId: string) =>
    attachments.attach({
      sessionId: SESSION,
      attemptId: "att_1",
      actor,
      repositoryId,
    });
  return { gateway, receipts, memory, attach, fetchDocs };
}

describe("a repository attached mid-session", () => {
  test("its route is refused before the attachment and allowed right after, with no cache between", async () => {
    const w = wired();
    await expect(w.fetchDocs()).rejects.toMatchObject({
      status: 403,
      code: "GITHUB_REFUSED",
      reasonCode: "repository_not_allowed",
    });
    await w.attach("docs");
    const grant = await w.fetchDocs();
    expect(grant.upstream?.url).toBe(onGitHub("docs").url);
    expect(w.receipts.map((r) => r.status)).toEqual(["failed", "succeeded"]);
  });

  test("the claim carries the attempt's repository token when it names no repository", async () => {
    const w = wired();
    const claimed = bootstrapClaimResponseSchema.parse(
      await w.gateway.bootstrapClaim(
        { kind: "bootstrap" },
        {
          execution_id: "e",
          execution_generation: 1,
          credential: { kind: "launch_nonce", nonce: "n" },
        },
      ),
    );
    expect(claimed.workspace.repository).toBeNull();
    expect(claimed.repository_access?.kind).toBe("egress_token");
    expect(claimed.repository_access?.token.length).toBeGreaterThan(0);
  });

  // Claims are built from the session row each time, so a later attempt's
  // claim reads the same list; the worker re-adds what it names after restore.
  test("a claim made after the attachment names it", async () => {
    const w = wired();
    const claim = async () =>
      bootstrapClaimResponseSchema.parse(
        await w.gateway.bootstrapClaim(
          { kind: "bootstrap" },
          {
            execution_id: "e",
            execution_generation: 1,
            credential: { kind: "launch_nonce", nonce: "n" },
          },
        ),
      );
    expect((await claim()).workspace.additional_repositories ?? []).toEqual([]);
    await w.attach("docs");
    expect(
      (await claim()).workspace.additional_repositories?.map(
        ({ id, url, branch }) => ({ id, url, branch }),
      ),
    ).toEqual([{ id: "docs", url: onGitHub("docs").url, branch: "main" }]);
  });

  test("a beat says so, the control poll hands it out until a report settles it", async () => {
    const w = wired();
    const beat = () =>
      w.gateway.heartbeat(principal, { ...scope, attempt_state: "running" });
    const poll = (attached?: unknown[]) =>
      w.gateway.pendingControl(principal, {
        ...scope,
        answers_after: 0,
        ...(attached === undefined ? {} : { attached: attached as never }),
      });
    expect((await beat()).control_pending).toBe(false);
    const receipt_id = (await w.attach("docs")).receipt_id ?? "missing";
    expect((await beat()).control_pending).toBe(true);
    expect((await poll()).attachments).toEqual([
      { id: "docs", url: onGitHub("docs").url, branch: "main", receipt_id },
    ]);
    // Handed out again until a worker reports it.
    expect((await poll()).attachments).toHaveLength(1);

    const report = {
      repository_id: "docs",
      receipt_id,
      status: "attached",
      commit: COMMIT,
    };
    expect((await poll([report])).attachments).toEqual([]);
    expect((await beat()).control_pending).toBe(false);
    // A resent report changes nothing.
    await poll([report]);
    expect(w.memory.receipts.map((r) => r.status)).toEqual(["succeeded"]);
    expect(w.memory.rows.get("docs")).toMatchObject({
      status: "attached",
      commit: COMMIT,
    });
  });
});
