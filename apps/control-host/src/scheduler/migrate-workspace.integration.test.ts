import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as schema from "@werft-ai/db";
import { sessions, unassignedSessions, workerLaunches } from "@werft-ai/db";
import {
  DEFAULT_MIGRATION_HELPER_IMAGE,
  DockerClient,
  LABELS,
  legacyWorkspaceVolumeName,
  volumeLabelsOf,
} from "@werft-ai/execution-local-docker";
import {
  removeWorkerNetworks,
  startStandInProxy,
  testDockerHost,
} from "@werft-ai/execution-local-docker/testing";
import { createTempDatabase, type TempDatabase } from "@werft-ai/testkit";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { main } from "./main.ts";
import { migrateWorkspaces } from "./migrate-workspace.ts";

/**
 * Quota backfill end to end: a session whose workspace predates the quota
 * cannot be brought back, `migrate-workspace` moves it, and the very next
 * scheduler pass relaunches it on the copy. Needs a real daemon
 * (`DOCKER_BACKEND_TEST=1`) and PostgreSQL (`QUEUE_DATABASE_URL`).
 */
const databaseUrl = process.env.QUEUE_DATABASE_URL;
const enabled = process.env.DOCKER_BACKEND_TEST === "1" && databaseUrl;
const integration = enabled ? describe : describe.skip;
const IMAGE = process.env.DOCKER_BACKEND_TEST_IMAGE ?? "busybox:1.36";
// The helper the CLI below reads from the same environment.
const HELPER_IMAGE =
  process.env.EXECUTION_WORKSPACE_MIGRATION_IMAGE ||
  DEFAULT_MIGRATION_HELPER_IMAGE;
const dockerHost = await testDockerHost();

integration("a legacy session relaunched after migrate-workspace", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const client = new DockerClient(dockerHost);
  const runLabel = `mig-${crypto.randomUUID().slice(0, 8)}`;
  const sessionId = crypto.randomUUID();
  const naming = {
    installationId: runLabel,
    volumeLabelNamespace: "werft",
    volumeNamePrefix: "werft-ws-",
  };
  const volumeKeys = volumeLabelsOf(naming);
  const legacy = legacyWorkspaceVolumeName(sessionId, naming);
  let proxy: string | undefined;

  const environment = () => ({
    ...process.env,
    AWS_ACCESS_KEY_ID: "migration-it",
    AWS_ENDPOINT_URL: "http://localstack:4566",
    AWS_REGION: "ap-northeast-1",
    AWS_SECRET_ACCESS_KEY: "migration-it",
    DATABASE_URL: database.url,
    DOCKER_HOST: dockerHost,
    EXECUTION_DOCKER_COMMAND: "sleep 600",
    EXECUTION_EGRESS_PROXY_URL: "http://egress-proxy:3128",
    EXECUTION_INSTALLATION_ID: runLabel,
    EXECUTION_SLOT_LIMIT: "10",
    // The runner's daemon cannot carry a quota; workspace-migration's own
    // suite covers the bounded copy on the daemon that can.
    EXECUTION_WORKSPACE_QUOTA: "off",
    QUEUED_INPUT_LIMIT_PER_SESSION: "20",
    S3_BUCKET: "claude-sessions",
    SESSION_COST_LIMIT_USD: "25",
    STORAGE_LIMIT_BYTES: "1073741824",
    WORKER_CPUS: "0.25",
    WORKER_GATEWAY_URL: "http://host.docker.internal:3000",
    WORKER_IMAGE: IMAGE,
    WORKER_MEMORY_MB: "64",
    WORKER_PIDS_LIMIT: "32",
  });

  /** Runs `script` as root against `volume`; its exit code. */
  async function run(script: string, volume: string): Promise<number> {
    const container = `ap-mig-run-${crypto.randomUUID().slice(0, 8)}`;
    await client.createContainer(container, {
      Cmd: ["sh", "-c", script],
      Env: [],
      HostConfig: {
        CapDrop: [],
        Memory: 64 * 1024 * 1024,
        Mounts: [{ Source: volume, Target: "/workspace", Type: "volume" }],
        NanoCpus: 1_000_000_000,
        NetworkMode: "none",
        PidsLimit: 32,
        ReadonlyRootfs: false,
        RestartPolicy: { Name: "no" },
        SecurityOpt: [],
        Tmpfs: {},
      },
      Image: IMAGE,
      Labels: {},
      User: "0:0",
    });
    try {
      await client.startContainer(container);
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const inspected = await client.inspectContainer(container);
        if (inspected && !inspected.State.Running) {
          return inspected.State.ExitCode;
        }
        await Bun.sleep(250);
      }
      throw new Error(`${container} never exited`);
    } finally {
      await client.stopAndRemoveContainer(container, 1).catch(() => {});
    }
  }

  beforeAll(async () => {
    const puller = new DockerClient(dockerHost, "v1.44", {
      timeoutMs: 110_000,
    });
    await puller.pullImage(IMAGE);
    await puller.pullImage(HELPER_IMAGE);
    proxy = await startStandInProxy({
      dockerHost,
      image: IMAGE,
      installationId: runLabel,
    });
    database = await createTempDatabase({ prefix: "migrate_ws_it" });
    pool = new Pool({ connectionString: database.url });
    db = drizzle(pool, { schema });
    await db.insert(sessions).values({
      branch: `session/${sessionId}`,
      id: sessionId,
      ownerId: runLabel,
      repoUrl: "https://example.invalid/repo.git",
    });
    await db.insert(unassignedSessions).values({ sessionId });
    await client.createVolume({ Driver: "local", Labels: {}, Name: legacy });
    expect(
      await run(
        "mkdir -p /workspace/repo && echo work > /workspace/repo/file && chown -R 1000:1000 /workspace/repo",
        legacy,
      ),
    ).toBe(0);
  }, 180_000);

  afterAll(async () => {
    for (const container of await client
      .listContainers([`${LABELS.installation}=${runLabel}`])
      .catch(() => [])) {
      await client.stopAndRemoveContainer(container.Id, 1).catch(() => {});
    }
    for (const volume of await client
      .listVolumes([`${LABELS.sessionId}=${sessionId}`])
      .catch(() => [])) {
      await client.removeVolume(volume.Name).catch(() => {});
    }
    await client.removeVolume(legacy).catch(() => {});
    if (proxy) await client.stopAndRemoveContainer(proxy, 1).catch(() => {});
    await removeWorkerNetworks(client, runLabel).catch(() => {});
    await pool.end();
    await database.drop();
  }, 120_000);

  async function workers() {
    return client.listContainers([
      `${LABELS.managed}=true`,
      `${LABELS.sessionId}=${sessionId}`,
    ]);
  }

  test("refused on the legacy volume, relaunched on the copy one pass after the migration", async () => {
    // The launch is reserved but its container cannot be made: the state a
    // legacy session is in once its container is gone.
    const refused = await main(environment());
    expect(refused.failedLaunches).toHaveLength(1);
    expect(await workers()).toEqual([]);

    // In the spelling PostgreSQL accepts and Docker names do not.
    expect(
      await migrateWorkspaces([sessionId.toUpperCase()], environment()),
    ).toBe(0);
    expect(await client.inspectVolume(legacy)).toBeNull();
    const [copy] = await client.listVolumes([
      `${volumeKeys.managed}=true`,
      `${volumeKeys.sessionId}=${sessionId}`,
    ]);
    expect(copy?.Labels?.[volumeKeys.migratedFrom]).toBe(legacy);

    // The refused launch is in its retry backoff; spend it on the
    // DB clock rather than waiting it out.
    await db
      .update(workerLaunches)
      .set({ launchRetryAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(workerLaunches.sessionId, sessionId));
    const relaunched = await main(environment());
    expect(relaunched.failedLaunches).toEqual([]);
    const [worker] = await workers();
    expect(worker?.State).toBe("running");
    const inspected = await client.inspectContainer(worker?.Id ?? "");
    expect(
      inspected?.Mounts.find((mount) => mount.Destination === "/workspace")
        ?.Name,
    ).toBe(copy?.Name);
    expect(
      await run(
        'test "$(cat /workspace/repo/file)" = work && test "$(stat -c %u /workspace/repo/file)" = 1000',
        copy?.Name ?? "",
      ),
    ).toBe(0);
  }, 240_000);
});
