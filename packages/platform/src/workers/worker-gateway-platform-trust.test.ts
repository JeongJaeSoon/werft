import { describe, expect, test } from "bun:test";
import {
  bootstrapClaimResponseSchema,
  runtimeMcpServerSchema,
} from "@werft-ai/contracts";

import { acceptAllCheckpoints } from "../ports/checkpoint-verifier.ts";
import type { WorkerPendingStore } from "../ports/pending-requests.ts";
import type { WorkerUnitOfWork } from "../ports/worker-unit-of-work.ts";
import { trustedGitHubTools } from "../sessions/catalog.ts";
import { testBinding, testCatalog } from "../testing/catalog-fakes.ts";
import { createWorkerGateway } from "./worker-gateway.ts";

const SESSION = "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const catalog = testCatalog();

const RELEASE_TOOLS = [
  "mcp__github__request_push",
  "mcp__github__open_pull_request",
  "mcp__github__update_pull_request",
  "mcp__github__list_repositories",
  "mcp__github__attach_repository",
  "mcp__github__submit_review",
  "mcp__github__dispatch_workflow",
  "mcp__github__get_workflow_run",
];

// The schema of a worker image from before `platform` and `trusted`: the
// server entry is strict, so a key it does not know refuses the whole claim.
const oldServer = runtimeMcpServerSchema.omit({
  platform: true,
  trusted: true,
});

function claimWith(capabilities?: { platform_tool_trust: true }) {
  const binding = testBinding({
    sessionId: SESSION,
    attemptId: "att_1",
    costUsd: 0,
    providerTokens: 0,
    repository: null,
    leaseEpoch: 1,
    executionGeneration: 1,
    authRevision: 0,
    leaseExpiresAt: new Date("2026-09-22T00:00:30Z"),
    leaseRemainingMs: 29_950,
    unmetered: false,
    ownerScope: "owner-a",
    restore: null,
    grants: [],
    githubMcp: { releaseId: "rel-1", tools: RELEASE_TOOLS },
  });
  const work = new Proxy(
    { claimAtomic: async () => ({ outcome: "claimed", binding }) },
    {
      get(target, key) {
        if (key in target) return target[key as keyof typeof target];
        return () => {
          throw new Error(`not reached: ${String(key)}`);
        };
      },
    },
  ) as unknown as WorkerUnitOfWork;
  const gateway = createWorkerGateway({
    work,
    catalog,
    pending: {} as unknown as WorkerPendingStore,
    checkpoints: acceptAllCheckpoints,
    options: {
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
      leaseTtlMs: 30_000,
    },
  });
  return gateway.bootstrapClaim(
    { kind: "bootstrap" },
    {
      ...(capabilities === undefined ? {} : { capabilities }),
      execution_id: "e",
      execution_generation: 1,
      credential: { kind: "launch_nonce", nonce: "n" },
    },
  );
}

describe("push, pull request and repository read tools, across worker versions", () => {
  test("the trusted tools are the push, pull request and repository read classes", () => {
    expect(trustedGitHubTools(RELEASE_TOOLS)).toEqual([
      "mcp__github__request_push",
      "mcp__github__open_pull_request",
      "mcp__github__update_pull_request",
      "mcp__github__list_repositories",
      "mcp__github__attach_repository",
    ]);
    // Not another server's tool of the same tool name, and not a name that
    // has no class.
    expect(
      trustedGitHubTools([
        "mcp__other__request_push",
        "mcp__github__merge_pull_request",
      ]),
    ).toEqual([]);
  });

  test("a worker that announced platform_tool_trust gets the marks on the built-in server", async () => {
    const claim = await claimWith({ platform_tool_trust: true });
    const server = claim.runtime_config.mcp_servers?.[0];
    expect(server).toMatchObject({ name: "github", platform: true });
    expect(server?.trusted).toEqual(trustedGitHubTools(RELEASE_TOOLS));
    expect(server?.trusted).not.toContain("mcp__github__submit_review");
    expect(server?.trusted).not.toContain("mcp__github__dispatch_workflow");
    expect(bootstrapClaimResponseSchema.safeParse(claim).success).toBe(true);
  });

  test("a worker without the capability gets a claim with neither key, and its old strict schema parses it", async () => {
    const claim = await claimWith();
    const servers = claim.runtime_config.mcp_servers ?? [];
    expect(servers).toHaveLength(1);
    for (const server of servers) {
      expect(Object.keys(server)).not.toContain("platform");
      expect(Object.keys(server)).not.toContain("trusted");
      expect(oldServer.safeParse(server).success).toBe(true);
    }
    // The old schema is what makes this test mean something: it refuses the
    // marks.
    expect(
      oldServer.safeParse({
        ...servers[0],
        platform: true,
        trusted: ["mcp__github__request_push"],
      }).success,
    ).toBe(false);
  });
});
