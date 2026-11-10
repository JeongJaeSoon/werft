import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import * as schema from "@werft-ai/db";
import {
  createPostgresSessionUnitOfWork,
  createPostgresWorkerUnitOfWork,
} from "@werft-ai/db";
import { migrate } from "@werft-ai/db/migrate";
import {
  confirmExecutionGone,
  launchSession,
} from "@werft-ai/db/testing/launches";
import { createLogger } from "@werft-ai/observability";
import {
  acceptAllCheckpoints,
  createWorkerGateway,
} from "@werft-ai/platform";
import { createObjectRouteSigner } from "@werft-ai/storage";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { createEgressAuthorizer } from "../apps/control-host/src/api/egress-authorizer.ts";
import { testCatalog } from "../apps/control-host/src/test-support/catalog.ts";
import { TEST_MODEL } from "@werft-ai/db/testing/spec-pins";
import { releaseIn, TEST_OWNER } from "../apps/control-host/src/test-support/releases.ts";

/**
 * The control plane side of the object store route, real from the
 * database up: a session in PGlite, the real gateway claiming it, and the
 * real authorizer listening with the real signer. Shared by the in-process
 * suite (`object-store-route.test.ts`) and the Docker egress suite, which
 * runs this file in a container on the proxy's outer network.
 *
 * Each `openSession()` accepts a new session. Its `claim()` starts the
 * session's next execution generation: the first call claims generation 1;
 * each later one sees the previous execution gone, as the scheduler would,
 * and claims the next. It returns the new attempt's object store token.
 */


type ObjectRouteSession = {
  sessionId: string;
  claim(): Promise<string>;
};

export type ObjectRouteFixture = {
  authorizerUrl: string;
  authorizerToken: string;
  openSession(): Promise<ObjectRouteSession>;
  stop(): Promise<void>;
};

export async function startObjectRouteFixture(options: {
  objectStore: {
    accessKeyId: string;
    bucket: string;
    endpoint: string;
    region: string;
    secretAccessKey: string;
  };
  hostname?: string;
  port?: number;
}): Promise<ObjectRouteFixture> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, {
    migrationsFolder: join(import.meta.dir, "..", "packages/db/migrations"),
  });
  const gateway = createWorkerGateway({
    work: createPostgresWorkerUnitOfWork(db),
    catalog: testCatalog({
provider: {
            kind: "anthropic",
            endpoint: "http://provider.invalid",
            auth: {
              kind: "api_key",
              value: "catalog-provider-value",
              ref: { value_env: "PROVIDER_KEY" },
            },
          },
models: ["claude-sonnet-5", "claude-sonnet-4-5"],
repositories: {
        app: {
          url: "http://git.invalid/app.git",
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
  });
  const authorizerToken = `object-route-fixture-${crypto.randomUUID()}`;
  const authorizer = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 0,
    fetch: createEgressAuthorizer({
      gateway,
      logger: createLogger({ sinks: [] }),
      objectStore: createObjectRouteSigner({
        bucket: options.objectStore.bucket,
        credentials: {
          accessKeyId: options.objectStore.accessKeyId,
          secretAccessKey: options.objectStore.secretAccessKey,
        },
        endpoint: options.objectStore.endpoint,
        region: options.objectStore.region,
      }),
      token: authorizerToken,
    }),
  });

  const sessions = createPostgresSessionUnitOfWork(db);
  async function openSession(): Promise<ObjectRouteSession> {
    const accepted = await sessions.acceptInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: { ownerId: TEST_OWNER },
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      agentReleaseId: await releaseIn(db),
      model: TEST_MODEL,
      repository: {
        id: "app",
        url: "http://git.invalid/app.git",
        branch: "main",
      },
      message: "hello",
    });
    if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
    const sessionId = accepted.response.session_id;
    let execution: string | null = null;
    return {
      sessionId,
      async claim() {
        if (execution !== null) {
          await confirmExecutionGone(db, execution);
          // A worker gone before asking for input is a failed startup whose
          // backoff holds the next launch back; here it has
          // elapsed, as the gateway's own tests let it.
          await db
            .update(schema.sessions)
            .set({
              restoreRetryAt: sql`clock_timestamp() - interval '1 second'`,
            })
            .where(eq(schema.sessions.id, sessionId));
        }
        const launch = await launchSession(db, { sessionId });
        execution = launch.executionId;
        const claim = await gateway.bootstrapClaim(
          { kind: "bootstrap" },
          {
            execution_id: launch.executionId,
            execution_generation: launch.generation,
            credential: { kind: "launch_nonce", nonce: launch.nonce },
          },
        );
        if (claim.session_id !== sessionId) {
          throw new Error(`claimed ${claim.session_id}, not ${sessionId}`);
        }
        return claim.object_store.access.token;
      },
    };
  }

  return {
    authorizerUrl: `http://${authorizer.hostname}:${authorizer.port}`,
    authorizerToken,
    openSession,
    async stop() {
      authorizer.stop(true);
      await client.close();
    },
  };
}
