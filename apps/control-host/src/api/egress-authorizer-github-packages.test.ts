import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import * as schema from "@werft-ai/db";
import {
  createPostgresSessionUnitOfWork,
  createPostgresWorkerUnitOfWork,
} from "@werft-ai/db";
import { launchSession } from "@werft-ai/db/testing/launches";
import { TEST_MODEL } from "@werft-ai/db/testing/spec-pins";
import { createLogger } from "@werft-ai/observability";
import {
  acceptAllCheckpoints,
  createWorkerGateway,
  type GitHubPackageFetchRecord,
  type GitHubPackagesStore,
} from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { testCatalog } from "../testing/catalog.ts";
import { releaseIn, TEST_OWNER } from "../testing/releases.ts";
import {
  createEgressAuthorizer,
  EGRESS_AUTHORIZER_PATH,
} from "./egress-authorizer.ts";

const BEARER = "authorizer-bearer-for-tests";
const BOT = "fake-bot-credential-for-tests";
const ENTRY = {
  registry: "npm" as const,
  owner: "acme",
  name: "ui",
  repository_id: null,
  agent_id: null,
};

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let gateway: ReturnType<typeof createWorkerGateway>;
let authorize: (request: Request) => Promise<Response>;
let recorded: GitHubPackageFetchRecord[];

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema });
  recorded = [];
  const store = {
    allowlist: async () => [ENTRY],
    sessionState: async () => ({
      ownerId: TEST_OWNER,
      workspaceId: TEST_OWNER,
      agentId: null,
      releaseId: null,
      actor: null,
      token: { value: BOT, expiresAt: null },
      allowlist: [ENTRY],
    }),
    recordFetch: async (record: GitHubPackageFetchRecord) => {
      recorded.push(record);
    },
  } as unknown as GitHubPackagesStore;
  gateway = createWorkerGateway({
    work: createPostgresWorkerUnitOfWork(db),
    catalog: testCatalog({
      provider: {
        kind: "anthropic",
        endpoint: "https://api.anthropic.invalid",
        auth: {
          kind: "api_key",
          value: "catalog-provider-key",
          ref: { value_env: "PROVIDER_KEY" },
        },
      },
      repositories: {
        "sample-app": {
          url: "https://git.invalid/agent/app.git",
          branch: "main",
          auth: { kind: "github_app", registered: true } as const,
        },
      },
    }),
    checkpoints: acceptAllCheckpoints,
    options: {
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
      leaseTtlMs: 60_000,
    },
    githubPackages: { store, upstreams: { npm: "http://fake-npm.invalid" } },
  });
  authorize = createEgressAuthorizer({
    gateway,
    logger: createLogger({ sinks: [] }),
    token: BEARER,
  });
});

afterEach(async () => {
  await client.close();
});

async function claimed() {
  const accepted = await createPostgresSessionUnitOfWork(db).acceptInputAtomic({
    limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
    principal: { ownerId: TEST_OWNER },
    idempotencyKey: crypto.randomUUID(),
    payloadHash: "hash",
    agentReleaseId: await releaseIn(db),
    model: TEST_MODEL,
    repository: {
      id: "sample-app",
      url: "https://git.invalid/agent/app.git",
      branch: "main",
    },
    message: "hello",
  });
  if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
  const launch = await launchSession(db, {
    sessionId: accepted.response.session_id,
  });
  return await gateway.bootstrapClaim(
    { kind: "bootstrap" },
    {
      execution_id: launch.executionId,
      execution_generation: launch.generation,
      credential: { kind: "launch_nonce", nonce: launch.nonce },
    },
  );
}

const ask = (body: unknown) =>
  authorize(
    new Request(`http://authorizer.invalid${EGRESS_AUTHORIZER_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${BEARER}`,
      },
      body: JSON.stringify(body),
    }),
  );

describe("GitHub Packages through the egress authorizer", () => {
  test("the claim names the allowed owners, never the bot credential", async () => {
    const claim = await claimed();
    expect(claim.packages?.github).toEqual({ npm: ["acme"], rubygems: [] });
    expect(JSON.stringify(claim)).not.toContain(BOT);
  });

  test("an allowed package gets the bot credential; GitHub's tarball on the npm route too", async () => {
    const claim = await claimed();
    const token = claim.packages?.access.token ?? "";
    for (const [registry, path] of [
      ["github-npm", "/@acme%2fui"],
      ["npm", "/download/@acme/ui/1.0.0/abcdef01"],
    ]) {
      const response = await ask({
        token,
        purpose: "packages",
        registry,
        path,
      });
      expect(response.status).toBe(200);
      expect((await response.json()).upstream).toEqual({
        url: "http://fake-npm.invalid",
        headers: [["authorization", `Bearer ${BOT}`]],
      });
    }
    expect(recorded.map((record) => record.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);
    // A public npm package still goes out with no credential.
    const plain = await ask({
      token,
      purpose: "packages",
      registry: "npm",
      path: "/left-pad",
    });
    expect((await plain.json()).upstream.headers).toEqual([]);
  });

  test("a package outside the allowlist is refused with its receipt", async () => {
    const claim = await claimed();
    const response = await ask({
      token: claim.packages?.access.token ?? "",
      purpose: "packages",
      registry: "github-npm",
      path: "/@acme%2fother",
    });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(BOT);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      status: "failed",
      result: { reason_code: "package_not_allowed" },
    });
  });

  test("a GitHub registry without a path, or a regrant, records nothing new", async () => {
    const claim = await claimed();
    const token = claim.packages?.access.token ?? "";
    expect(
      (await ask({ token, purpose: "packages", registry: "github-npm" }))
        .status,
    ).toBe(403);
    const regrant = await ask({
      token,
      purpose: "packages",
      registry: "github-npm",
      path: "/@acme%2fui",
      regrant: true,
    });
    expect(regrant.status).toBe(200);
    expect(recorded).toHaveLength(0);
  });
});
