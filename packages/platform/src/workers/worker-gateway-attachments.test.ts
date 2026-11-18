import { describe, expect, test } from "bun:test";
import {
  bootstrapClaimResponseSchema,
  GITHUB_CEILING_NONE,
  GITHUB_FEATURES_NONE,
  LISTED_REPOSITORY_FAILURE_MEANING,
  type ReceiptActor,
  repositoryPinsRequestSchema,
} from "@werft-ai/contracts";
import type { CatalogRepository } from "../catalog/catalog.ts";
import type {
  GitHubConnection,
  GitHubGateReceipt,
  GitHubGrant,
  GitHubSessionContext,
} from "../github/ports/github-gate.ts";
import { createGitHubGate } from "../github/service/github-gate.ts";
import type { RepositoryPinStore } from "../ports/repository-attachments.ts";
import type { WorkerUnitOfWork } from "../ports/worker-unit-of-work.ts";
import type { WorkerPendingStore } from "../sessions/ports/pending-requests.ts";
import { createRepositoryAttachmentService } from "../sessions/repository-attachment-service.ts";
import { testBinding, testCatalog } from "../testing/catalog-fakes.ts";
import { acceptAllCheckpoints } from "../testing/checkpoints.ts";
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

const onGitHub = (name: string): CatalogRepository => ({
  url: `https://github.com/acme/${name}.git`,
  branch: "main",
  auth: { kind: "github_app", registered: true },
});
const catalog = testCatalog({
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
    repositoryCeiling: {
      repository_ids: ["docs", "tools"],
      github_app_repositories: "listed",
    },
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
  // First writer wins, as the table's primary key does.
  const pins = new Map<string, string>();
  // The pins a worker could not fetch again, as `restore_failed_at` marks.
  const lost = new Set<string>();
  // Whether the attempt's lease has lapsed in the database.
  const owner = { lost: false };
  const live = (ids?: readonly string[]) =>
    new Map(
      [...pins].filter(
        ([id]) => !lost.has(id) && (ids === undefined || ids.includes(id)),
      ),
    );
  const repositoryPins: RepositoryPinStore = {
    list: async () => live(),
    restoreFailures: async () =>
      new Map([...pins].filter(([id]) => lost.has(id))),
    pin: async (_fence, asked, restoreFailed = []) => {
      if (owner.lost) return { outcome: "lease_expired" };
      for (const failure of restoreFailed) {
        if (pins.get(failure.repositoryId) === failure.commit) {
          lost.add(failure.repositoryId);
        }
      }
      for (const pin of asked) {
        if (!pins.has(pin.repositoryId)) pins.set(pin.repositoryId, pin.commit);
      }
      return {
        outcome: "ok",
        pins: live(asked.map((pin) => pin.repositoryId)),
      };
    },
  };
  const attachments = createRepositoryAttachmentService({
    store,
    pins: repositoryPins,
    context: { context },
    catalog,
  });
  const binding = {
    sessionId: SESSION,
    attemptId: "att_1",
    connectionId: "conn-1",
    model: "claude-sonnet-5",
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
        binding: testBinding({ sessionId: SESSION }),
      }),
    }),
    catalog,
    github: gate,
    pending,
    attachments: store,
    repositoryPins,
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
  return {
    gateway,
    receipts,
    memory,
    attach,
    attachments,
    fetchDocs,
    pins,
    lost,
    owner,
  };
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

describe("the session's pin of an attached repository", () => {
  const OTHER = "e".repeat(40);
  const claim = (w: ReturnType<typeof wired>, pins: boolean) =>
    w.gateway.bootstrapClaim(
      { kind: "bootstrap" },
      {
        execution_id: "e",
        execution_generation: 1,
        credential: { kind: "launch_nonce", nonce: "n" },
        ...(pins ? { capabilities: { repository_pins: true } } : {}),
      },
    );
  const poll = (w: ReturnType<typeof wired>, pins: boolean) =>
    w.gateway.pendingControl(principal, {
      ...scope,
      answers_after: 0,
      ...(pins ? { capabilities: { repository_pins: true } } : {}),
    });

  test("is kept first-writer-wins, only for a repository the session may work on, once per repository", async () => {
    const w = wired();
    await w.attach("docs");
    const pin = (pins: Array<{ repository_id: string; commit: string }>) =>
      w.gateway.repositoryPins(principal, { ...scope, pins });
    expect(
      await pin([
        { repository_id: "docs", commit: COMMIT },
        { repository_id: "docs", commit: OTHER },
        { repository_id: "tools", commit: COMMIT },
      ]),
    ).toEqual({ pins: [{ repository_id: "docs", commit: COMMIT }] });
    expect(await pin([{ repository_id: "docs", commit: OTHER }])).toEqual({
      pins: [{ repository_id: "docs", commit: COMMIT }],
    });
    expect([...w.pins]).toEqual([["docs", COMMIT]]);
  });

  test("a stale attempt cannot pin", async () => {
    const w = wired();
    await w.attach("docs");
    await expect(
      w.gateway.repositoryPins(
        { ...principal, leaseEpoch: 2 },
        { ...scope, pins: [{ repository_id: "docs", commit: COMMIT }] },
      ),
    ).rejects.toMatchObject({ status: 409, code: "STALE_EPOCH" });
    expect(w.pins.size).toBe(0);
  });

  test("an attempt whose lease lapsed cannot pin, though its token still matches", async () => {
    const w = wired();
    await w.attach("docs");
    w.owner.lost = true;
    await expect(
      w.gateway.repositoryPins(principal, {
        ...scope,
        pins: [{ repository_id: "docs", commit: COMMIT }],
      }),
    ).rejects.toMatchObject({ status: 409, code: "LEASE_EXPIRED" });
    expect(w.pins.size).toBe(0);
  });

  test("rides on the claim and the attach order only for a worker that parses it", async () => {
    const w = wired();
    const receipt_id = (await w.attach("docs")).receipt_id ?? "missing";
    w.pins.set("docs", COMMIT);
    const listed = async (pins: boolean) =>
      bootstrapClaimResponseSchema.parse(await claim(w, pins)).workspace
        .additional_repositories?.[0]?.commit;
    expect(await listed(false)).toBeUndefined();
    expect(await listed(true)).toBe(COMMIT);
    expect((await poll(w, false)).attachments).toEqual([
      { id: "docs", url: onGitHub("docs").url, branch: "main", receipt_id },
    ]);
    expect((await poll(w, true)).attachments).toEqual([
      {
        id: "docs",
        url: onGitHub("docs").url,
        branch: "main",
        receipt_id,
        commit: COMMIT,
      },
    ]);
  });
});

describe("a pinned repository a worker could not fetch again", () => {
  const OTHER = "e".repeat(40);
  const claimed = async (w: ReturnType<typeof wired>, pins: boolean) =>
    bootstrapClaimResponseSchema.parse(
      await w.gateway.bootstrapClaim(
        { kind: "bootstrap" },
        {
          execution_id: "e",
          execution_generation: 1,
          credential: { kind: "launch_nonce", nonce: "n" },
          ...(pins ? { capabilities: { repository_pins: true } } : {}),
        },
      ),
    ).workspace.additional_repositories ?? [];
  const lose = (w: ReturnType<typeof wired>, commit: string) =>
    w.gateway.repositoryPins(principal, {
      ...scope,
      pins: [],
      restore_failed: [{ repository_id: "docs", commit }],
    });

  test("is marked only for the pin it names, and no claim hands it out after", async () => {
    const w = wired();
    await w.attach("docs");
    w.pins.set("docs", COMMIT);
    // Another commit than the pin: an old report, not this pin's failure.
    expect(await lose(w, OTHER)).toEqual({ pins: [] });
    expect(w.lost.size).toBe(0);
    expect((await claimed(w, true)).map(({ id }) => id)).toEqual(["docs"]);

    expect(await lose(w, COMMIT)).toEqual({ pins: [] });
    expect([...w.lost]).toEqual(["docs"]);
    // Neither kind of worker fetches it at the branch tip instead.
    expect(await claimed(w, true)).toEqual([]);
    expect(await claimed(w, false)).toEqual([]);
  });

  test("lists as failed with the commit it could not fetch, and how to get it back", async () => {
    const w = wired();
    const receipt_id = (await w.attach("docs")).receipt_id ?? "missing";
    await w.gateway.pendingControl(principal, {
      ...scope,
      answers_after: 0,
      attached: [
        {
          repository_id: "docs",
          receipt_id,
          status: "attached",
          commit: COMMIT,
        },
      ],
    });
    w.pins.set("docs", COMMIT);
    await lose(w, COMMIT);
    const { repositories } = await w.attachments.list(SESSION);
    expect(repositories.find(({ id }) => id === "docs")).toEqual({
      id: "docs",
      name: "acme/docs",
      branch: "main",
      status: "failed",
      failure: "restore_failed",
      commit: COMMIT,
      meaning: LISTED_REPOSITORY_FAILURE_MEANING.restore_failed,
    });
  });

  test("is refused unless the report names a pin or a restore failure", () => {
    const base = { ...scope, pins: [] };
    expect(repositoryPinsRequestSchema.safeParse(base).success).toBe(false);
    expect(
      repositoryPinsRequestSchema.safeParse({ ...base, restore_failed: [] })
        .success,
    ).toBe(false);
    expect(
      repositoryPinsRequestSchema.safeParse({
        ...base,
        restore_failed: [{ repository_id: "docs", commit: COMMIT }],
      }).success,
    ).toBe(true);
  });
});
