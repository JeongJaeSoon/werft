import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import * as schema from "@werft-ai/db";
import {
  attempts,
  createPostgresSessionUnitOfWork,
  createPostgresWorkerUnitOfWork,
  turns,
  workerLaunches,
} from "@werft-ai/db";
import { TEST_MODEL } from "@werft-ai/db/testing/spec-pins";
import {
  DockerClient,
  LABELS,
  volumeLabelsOf,
  workspaceVolumePrefixFor,
} from "@werft-ai/execution-local-docker";
import { removeWorkerNetworks } from "@werft-ai/execution-local-docker/testing";
import { createLogger } from "@werft-ai/observability";
import {
  acceptAllCheckpoints,
  createWorkerGateway,
  launchNonceFingerprint,
} from "@werft-ai/platform";
import { createTempDatabase, type TempDatabase } from "@werft-ai/testkit";
import {
  type FakeAnthropicServer,
  startFakeAnthropicServer,
  textReply,
} from "@werft-ai/testkit/fake-anthropic";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApiApp } from "../apps/control-host/src/api/app.ts";
import { createEgressAuthorizer } from "../apps/control-host/src/api/egress-authorizer.ts";
import { registerWorkerRoutes } from "../apps/control-host/src/api/routes/workers/worker.ts";
import { main } from "../apps/control-host/src/scheduler/main.ts";
import { testCatalog } from "../apps/control-host/src/testing/catalog.ts";
import {
  releaseIn,
  TEST_OWNER,
} from "../apps/control-host/src/testing/releases.ts";

/**
 * Launch claim end to end: a container the scheduler launched trades
 * the nonce it was given for a binding and pulls its first input, over the
 * real topology — internal worker network, egress proxy, the gateway's own
 * HTTP routes. It is the end-to-end proof that there is one launch registry:
 * the scheduler reserves the slot and the gateway's bootstrapClaim accepts
 * the credential that reservation issued.
 *
 * Needs both opt-ins: a real Docker daemon (`DOCKER_BACKEND_TEST=1`) and
 * PostgreSQL (`QUEUE_DATABASE_URL`).
 */
const databaseUrl = process.env.QUEUE_DATABASE_URL;
const enabled = process.env.DOCKER_BACKEND_TEST === "1" && databaseUrl;
const integration = enabled ? describe : describe.skip;

const WORKER_IMAGE = process.env.BUN_TEST_IMAGE ?? "oven/bun:1.3.14";
const SHELL_IMAGE = process.env.DOCKER_BACKEND_TEST_IMAGE ?? "busybox:1.36";
const PROXY_SOURCE = resolve(import.meta.dir, "..", "apps/egress-proxy");
const MESSAGE = "hello from the scheduler";

const dockerHost = process.env.DOCKER_HOST ?? (await defaultDockerHost());

async function defaultDockerHost(): Promise<string> {
  const candidates = [
    "/var/run/docker.sock",
    `${process.env.HOME}/.docker/run/docker.sock`,
  ];
  for (const path of candidates) {
    if (await Bun.file(path).exists()) return `unix://${path}`;
  }
  return "unix:///var/run/docker.sock";
}

/**
 * What the worker does, as a file on its workspace volume. A real worker is a
 * whole process; this covers the bootstrap claim and the first nextInput,
 * driven only by the env the backend put in the container.
 */
const PROVIDER_KEY_VALUE = `provider-${crypto.randomUUID()}`;
const AUTHORIZER_BEARER = `authorizer-${crypto.randomUUID()}`;

const WORKER_SCRIPT = `
const gateway = process.env.WORKER_GATEWAY_URL;
const proxy = process.env.HTTP_PROXY;
const nonce = process.env.WORKER_BOOTSTRAP_NONCE;

async function post(path, token, body) {
  const response = await fetch(gateway + "/internal/worker/" + path, {
    method: "POST",
    proxy,
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + token,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(path + " " + response.status + " " + text);
  return JSON.parse(text);
}

const claimed = await post("bootstrap-claim", nonce, {
  execution_id: process.env.WORKER_EXECUTION_ID,
  execution_generation: Number(process.env.WORKER_EXECUTION_GENERATION),
  credential: { kind: "launch_nonce", nonce },
});
console.log("CLAIMED " + claimed.session_id + " " + claimed.attempt_id);
// The claim carries a token for the credential route, never the key
// (94S-252); the route is on the proxy's own name, which NO_PROXY exempts.
console.log(
  "PROVIDER " +
    claimed.runtime_config.provider.auth.kind +
    " " +
    claimed.spec_digest,
);
const reply = await fetch(
  process.env.WORKER_EGRESS_CREDENTIAL_URL + "/provider/v1/messages",
  {
    method: "POST",
    headers: {
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": claimed.runtime_config.provider.auth.token,
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 16,
      messages: [{ role: "user", content: "hello" }],
    }),
  },
);
console.log("MESSAGES " + reply.status + " " + (await reply.text()).length);

const next = await post("next-input", claimed.session_credential, {
  session_id: claimed.session_id,
  turn_id: null,
  attempt_id: claimed.attempt_id,
  lease_epoch: claimed.lease_epoch,
  execution_generation: claimed.execution_generation,
  auth_revision: claimed.auth_revision,
  wait_ms: 5000,
});
console.log("INPUT " + JSON.stringify(next.input));
// Stay up: the test reads this container's log while it is still there.
await new Promise((done) => setTimeout(done, 120000));
`;

integration(
  "a scheduler-launched worker claims and takes its first input",
  () => {
    const client = new DockerClient(dockerHost, "v1.44", {
      timeoutMs: 120_000,
    });
    const suffix = crypto.randomUUID().slice(0, 8);
    const installationId = `lc-${suffix}`;
    const naming = {
      installationId,
      volumeLabelNamespace: "werft",
      volumeNamePrefix: "werft-ws-",
    };
    const volumeKeys = volumeLabelsOf(naming);
    const outerNetwork = `ap-lc-outer-${suffix}`;
    const proxyName = `ap-lc-proxy-${suffix}`;
    const proxyUrl = `http://${proxyName}:3128`;
    const created: string[] = [];
    const volumes: string[] = [];

    let database: TempDatabase;
    let pool: Pool;
    let db: NodePgDatabase<typeof schema>;
    let server: ReturnType<typeof Bun.serve>;
    let authorizer: ReturnType<typeof Bun.serve>;
    let messages: FakeAnthropicServer;
    const claimBodies: string[] = [];
    let sessionId: string;
    let gatewayUrl: string;

    const environment = () => ({
      ...process.env,
      AWS_ACCESS_KEY_ID: "test",
      AWS_ENDPOINT_URL: "http://localstack:4566",
      AWS_REGION: "ap-northeast-1",
      AWS_SECRET_ACCESS_KEY: "test",
      DATABASE_URL: database.url,
      DOCKER_HOST: dockerHost,
      EXECUTION_DOCKER_COMMAND: "bun /workspace/claim.js",
      EXECUTION_EGRESS_PROXY_URL: proxyUrl,
      EXECUTION_INSTALLATION_ID: installationId,
      EXECUTION_SLOT_LIMIT: "1",
      MAX_TURN_SECONDS: "3600",
      PROVIDER_MAX_RETRIES: "2",
      QUEUED_INPUT_LIMIT_PER_SESSION: "20",
      SESSION_COST_LIMIT_USD: "25",
      STORAGE_LIMIT_BYTES: "1073741824",
      // The runner's data root is ext4, so this daemon cannot put a ceiling
      // on a volume and the preflight refuses to start without the opt-out.
      // The ceiling itself is covered by the `workspace-quota` job.
      EXECUTION_WORKSPACE_QUOTA: "off",
      S3_BUCKET: "claude-sessions",
      WORKER_CPUS: "0.5",
      WORKER_GATEWAY_URL: gatewayUrl,
      WORKER_IMAGE,
      WORKER_MEMORY_MB: "256",
      WORKER_PIDS_LIMIT: "128",
    });

    beforeAll(async () => {
      await client.version();
      for (const image of [WORKER_IMAGE, SHELL_IMAGE]) {
        await client.pullImage(image);
      }
      await client.createNetwork({ Internal: false, Name: outerNetwork });

      database = await createTempDatabase({ prefix: "launch_claim_it" });
      pool = new Pool({ connectionString: database.url });
      db = drizzle(pool, { schema });
      // The Messages upstream, on the host: only the proxy's credential
      // route reaches it, and only with the catalog's key on the request.
      messages = startFakeAnthropicServer(textReply("through the route"), {
        listen: { hostname: "0.0.0.0", port: 0 },
      });
      const messagesPort = Number(new URL(messages.url).port);

      // The real gateway, on the host. Only the proxy may reach it, and only
      // because the allowlist below names it.
      const gateway = createWorkerGateway({
        work: createPostgresWorkerUnitOfWork(db),
        catalog: testCatalog({
          provider: {
            kind: "litellm",
            endpoint: `http://host.docker.internal:${messagesPort}`,
            auth: {
              kind: "api_key",
              value: PROVIDER_KEY_VALUE,
              ref: { value_env: "PROVIDER_KEY" },
            },
          },
          repositories: {
            "sample-app": {
              url: "https://example.invalid/app.git",
              branch: "main",
            },
          },
        }),
        checkpoints: acceptAllCheckpoints,
        options: {
          leaseTtlMs: 60_000,
          sessionCostLimitUsd: 25,
          sessionTokenLimit: null,
        },
      });
      const app = createApiApp({
        authMode: "api-key",
        registerInternalRoutes: (router) =>
          registerWorkerRoutes(router, gateway),
      });
      server = Bun.serve({
        // Every claim body is kept, to show the key is in none of them.
        async fetch(request) {
          const response = await app.fetch(request);
          if (new URL(request.url).pathname.endsWith("/bootstrap-claim")) {
            claimBodies.push(await response.clone().text());
          }
          return response;
        },
        hostname: "0.0.0.0",
        port: 0,
      });
      gatewayUrl = `http://host.docker.internal:${server.port}`;
      authorizer = Bun.serve({
        fetch: createEgressAuthorizer({
          gateway,
          logger: createLogger({ sinks: [] }),
          token: AUTHORIZER_BEARER,
        }),
        hostname: "0.0.0.0",
        port: 0,
      });

      await startProxy(server.port, authorizer.port, messagesPort);

      const accepted = await createPostgresSessionUnitOfWork(
        db,
      ).acceptInputAtomic({
        limits: {
          queuedInputLimitPerSession: 20,
          storageLimitBytes: 1073741824,
        },
        // The session's workspace: its release is one of that workspace's.
        principal: { ownerId: TEST_OWNER },
        idempotencyKey: crypto.randomUUID(),
        payloadHash: "hash",
        agentReleaseId: await releaseIn(db),
        model: TEST_MODEL,
        repository: {
          id: "sample-app",
          url: "https://example.invalid/app.git",
          branch: "main",
        },
        message: MESSAGE,
      });
      if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
      sessionId = accepted.response.session_id;

      // The backend mounts this volume at /workspace, so seeding it is how the
      // worker gets its script without the backend ever taking a bind mount.
      const volume = `${workspaceVolumePrefixFor(sessionId, naming)}seed`;
      volumes.push(volume);
      await seedWorkspace(volume);
    }, 600_000);

    afterAll(async () => {
      server?.stop(true);
      authorizer?.stop(true);
      messages?.stop();
      for (const name of created) {
        await client.stopAndRemoveContainer(name, 1).catch(() => undefined);
      }
      for (const volume of volumes) {
        await raw("DELETE", `/volumes/${volume}?force=true`).catch(
          () => undefined,
        );
      }
      // The worker's own network, made by the backend; empty by now.
      await removeWorkerNetworks(client, installationId).catch(() => undefined);
      await client.removeNetwork(outerNetwork).catch(() => undefined);
      await pool?.end();
      await database?.drop();
    }, 300_000);

    test("the nonce the reservation issued is the one bootstrapClaim accepts", async () => {
      const summary = await main(environment());
      expect(summary.failedLaunches).toEqual([]);
      expect(summary.launched).toHaveLength(1);
      const launched = summary.launched[0];
      if (!launched) throw new Error("nothing launched");
      const containerName = `ap-worker-${installationId}-${launched.executionId}-g${launched.generation}`;
      created.push(containerName);

      const log = await waitForLog(containerName, "INPUT ");
      expect(log).toContain(`CLAIMED ${sessionId} `);
      expect(log).toContain(`"message":"${MESSAGE}"`);
      // The claim handed the worker a route token, not the key
      // and a Messages call through the route reached the upstream with the
      // catalog's key on it.
      expect(log).toMatch(/PROVIDER egress_token sha256:[0-9a-f]{64}/);
      expect(log).toMatch(/MESSAGES 200 \d+/);
      expect(messages.requests).toHaveLength(1);
      expect(messages.requests[0]?.headers["x-api-key"]).toBe(
        PROVIDER_KEY_VALUE,
      );
      expect(claimBodies).toHaveLength(1);
      expect(claimBodies.join("\n")).not.toContain(PROVIDER_KEY_VALUE);
      expect(log).not.toContain(PROVIDER_KEY_VALUE);

      // The binding landed on the session the scheduler reserved the launch
      // for, and the launch row is the thing that records it.
      const [launch] = await db
        .select()
        .from(workerLaunches)
        .where(eq(workerLaunches.executionId, launched.executionId));
      expect(launch?.sessionId).toBe(sessionId);
      expect(launch?.claimedAttemptId).not.toBeNull();
      expect(launch?.slotReleasedAt).toBeNull();

      const bound = await db
        .select()
        .from(attempts)
        .where(eq(attempts.sessionId, sessionId));
      expect(bound).toHaveLength(1);
      expect(bound[0]?.id).toBe(launch?.claimedAttemptId ?? "");
      expect(bound[0]?.executionId).toBe(launched.executionId);

      // nextInput actually delivered the queued turn.
      const [turn] = await db
        .select()
        .from(turns)
        .where(eq(turns.sessionId, sessionId));
      expect(turn?.attemptId).toBe(bound[0]?.id ?? "");
      expect(turn?.deliveryStartedAt).not.toBeNull();

      // The one thing that must never be readable anywhere: the plaintext.
      const container = await inspect(containerName);
      // Nor is the provider key in what `docker inspect` shows.
      expect((container.Config.Env ?? []).join("\n")).not.toContain(
        PROVIDER_KEY_VALUE,
      );
      const nonce = envOf(container, "WORKER_BOOTSTRAP_NONCE");
      expect(nonce).toMatch(/^wln_/);
      const dump = await pool.query(
        "SELECT string_agg(t::text, ' ') AS rows FROM worker_launches t",
      );
      expect(String(dump.rows[0]?.rows ?? "")).not.toContain(nonce);
      // The container's fingerprint label is what the registry's own column
      // computes to, and carries neither the plaintext nor the
      // column itself.
      const labels = container.Config.Labels ?? {};
      if (!launch?.nonceHash) throw new Error("launch row lost its hash");
      expect(labels[LABELS.bootstrapFingerprint]).toBe(
        launchNonceFingerprint(launch.nonceHash),
      );
      expect(JSON.stringify(labels)).not.toContain(nonce);
      expect(JSON.stringify(labels)).not.toContain(
        Buffer.from(launch.nonceHash).toString("hex"),
      );
    }, 600_000);

    /**
     * The real proxy, labelled for this installation so the backend attaches
     * it to the worker's network, exactly as the deployed one runs.
     */
    async function startProxy(
      port: number,
      authorizerPort: number,
      messagesPort: number,
    ): Promise<void> {
      created.push(proxyName);
      const response = await raw(
        "POST",
        `/containers/create?name=${proxyName}`,
        {
          Cmd: ["bun", "run", "/app/src/main.ts"],
          Env: [
            // The gateway is on the daemon host, which is a private address: it
            // has to be named here or the proxy refuses to forward to it.
            `EGRESS_PRIVATE_ALLOWLIST=host.docker.internal:${port},host.docker.internal:${messagesPort}`,
            "EGRESS_PROXY_PORT=3128",
            `EGRESS_AUTHORIZER_URL=http://host.docker.internal:${authorizerPort}`,
            `EGRESS_AUTHORIZER_TOKEN=${AUTHORIZER_BEARER}`,
          ],
          HostConfig: {
            Binds: [`${PROXY_SOURCE}:/app:ro`],
            ExtraHosts: ["host.docker.internal:host-gateway"],
            NetworkMode: outerNetwork,
          },
          Image: WORKER_IMAGE,
          Labels: { [LABELS.egressProxy]: installationId },
        },
      );
      expect(response.status).toBe(201);
      await client.startContainer(proxyName);
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const log = await logsOf(proxyName);
        if (
          log.includes("Egress proxy listening") &&
          log.includes("Credential routes listening")
        ) {
          return;
        }
        await Bun.sleep(500);
      }
      throw new Error(`proxy never came up:\n${await logsOf(proxyName)}`);
    }

    /** Writes the worker script into the session's volume before it is used. */
    async function seedWorkspace(volume: string): Promise<void> {
      // Labelled as the backend labels its own, because that is what it
      // looks the workspace up by; an unlabelled one would be passed over
      // and the worker would start on an empty tree with no script in it.
      await client.createVolume({
        Driver: "local",
        Labels: {
          [volumeKeys.installation]: installationId,
          [volumeKeys.managed]: "true",
          [volumeKeys.sessionId]: sessionId,
          [volumeKeys.workspaceQuota]: "off",
        },
        Name: volume,
      });
      const name = `ap-lc-seed-${suffix}`;
      const response = await raw("POST", `/containers/create?name=${name}`, {
        Cmd: ["sh", "-c", 'printf "%s" "$SCRIPT" > /workspace/claim.js'],
        Env: [`SCRIPT=${WORKER_SCRIPT}`],
        HostConfig: {
          Mounts: [{ Source: volume, Target: "/workspace", Type: "volume" }],
        },
        Image: SHELL_IMAGE,
        User: "0:0",
      });
      expect(response.status).toBe(201);
      try {
        await client.startContainer(name);
        const waited = (await (
          await raw("POST", `/containers/${name}/wait`)
        ).json()) as { StatusCode: number };
        expect(waited.StatusCode).toBe(0);
      } finally {
        await client.stopAndRemoveContainer(name, 1).catch(() => undefined);
      }
    }

    async function waitForLog(name: string, marker: string): Promise<string> {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const log = await logsOf(name);
        if (log.includes(marker)) return log;
        const state = (await inspect(name))?.State;
        if (state && !state.Running && !log.includes(marker)) {
          throw new Error(`worker exited before ${marker}:\n${log}`);
        }
        await Bun.sleep(500);
      }
      throw new Error(`worker never logged ${marker}:\n${await logsOf(name)}`);
    }

    async function logsOf(name: string): Promise<string> {
      const response = await raw(
        "GET",
        `/containers/${name}/logs?stdout=true&stderr=true`,
      );
      return response.ok ? await response.text() : "";
    }

    async function inspect(name: string): Promise<{
      Config: { Env: string[] | null; Labels: Record<string, string> | null };
      State: { Running: boolean };
    }> {
      const response = await raw("GET", `/containers/${name}/json`);
      return (await response.json()) as {
        Config: { Env: string[] | null; Labels: Record<string, string> | null };
        State: { Running: boolean };
      };
    }

    function envOf(
      container: { Config: { Env: string[] | null } },
      key: string,
    ): string {
      const found = (container.Config.Env ?? []).find((entry) =>
        entry.startsWith(`${key}=`),
      );
      if (!found) throw new Error(`${key} is not set on the container`);
      return found.slice(key.length + 1);
    }

    async function raw(
      method: string,
      path: string,
      body?: unknown,
    ): Promise<Response> {
      const socket = dockerHost.startsWith("unix://")
        ? dockerHost.slice("unix://".length)
        : undefined;
      const base = socket
        ? "http://docker"
        : dockerHost.replace(/^tcp:\/\//, "http://");
      return fetch(`${base}/v1.44${path}`, {
        method,
        signal: AbortSignal.timeout(120_000),
        ...(socket ? { unix: socket } : {}),
        ...(body === undefined
          ? {}
          : {
              body: JSON.stringify(body),
              headers: { "content-type": "application/json" },
            }),
      } as RequestInit);
    }
  },
);
