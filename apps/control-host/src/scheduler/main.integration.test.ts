import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@werft-ai/db";
import {
  executions,
  sessions,
  turns,
  unassignedSessions,
  workerLaunches,
} from "@werft-ai/db";
import {
  containerNameFor,
  DockerClient,
  LABELS,
  LocalDockerBackend,
  localDockerConfigFromEnv,
  networkNameFor,
  volumeLabelsOf,
  workspaceVolumePrefixFor,
} from "@werft-ai/execution-local-docker";
import {
  removeWorkerNetworks,
  startStandInProxy,
} from "@werft-ai/execution-local-docker/testing";
import {
  hashWorkerToken,
  launchNonceFingerprint,
  launchSpecFingerprint,
} from "@werft-ai/platform";
import { createTempDatabase, type TempDatabase } from "@werft-ai/testkit";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { judgeHealth, readStatus } from "../pass-loop/health.ts";
import { runPassLoop } from "../pass-loop/loop.ts";
import { main } from "./main.ts";

/**
 * The acceptance run for the slot limit: 15 unassigned sessions, one pass,
 * at most `EXECUTION_SLOT_LIMIT` containers. Needs both opt-ins: a real
 * Docker daemon (`DOCKER_BACKEND_TEST=1`) and PostgreSQL
 * (`QUEUE_DATABASE_URL`). Uses a sleeping busybox as the worker image.
 */
const databaseUrl = process.env.QUEUE_DATABASE_URL;
const enabled = process.env.DOCKER_BACKEND_TEST === "1" && databaseUrl;
const integration = enabled ? describe : describe.skip;
const IMAGE = process.env.DOCKER_BACKEND_TEST_IMAGE ?? "busybox:1.36";
const dockerHost =
  process.env.DOCKER_HOST ??
  ((await Bun.file(`${process.env.HOME}/.docker/run/docker.sock`).exists())
    ? `unix://${process.env.HOME}/.docker/run/docker.sock`
    : "unix:///var/run/docker.sock");

/**
 * A describe's run for the launch failure suites: a temporary database, a
 * stand-in proxy, and every container, volume and network the run labelled
 * removed after it.
 */
function failureRun(options: {
  prefix: string;
  slotLimit: string;
  tempDir?: string;
}) {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const client = new DockerClient(dockerHost);
  const runLabel = `it-${crypto.randomUUID()}`;
  const crashing = crypto.randomUUID();
  const healthy = crypto.randomUUID();
  let proxy: string | undefined;
  let dir = "";

  const settings = (command: string) => ({
    AWS_ACCESS_KEY_ID: "test",
    AWS_ENDPOINT_URL: "http://localstack:4566",
    AWS_REGION: "ap-northeast-1",
    AWS_SECRET_ACCESS_KEY: "test",
    DATABASE_URL: database.url,
    DOCKER_HOST: dockerHost,
    EXECUTION_EGRESS_PROXY_URL: "http://egress-proxy:3128",
    EXECUTION_INSTALLATION_ID: runLabel,
    EXECUTION_DOCKER_COMMAND: command,
    EXECUTION_SLOT_LIMIT: options.slotLimit,
    EXECUTION_WORKSPACE_QUOTA: "off",
    QUEUED_INPUT_LIMIT_PER_SESSION: "20",
    SESSION_COST_LIMIT_USD: "25",
    STORAGE_LIMIT_BYTES: "1073741824",
    S3_BUCKET: "claude-sessions",
    WORKER_CPUS: "0.25",
    WORKER_GATEWAY_URL: "http://host.docker.internal:3000",
    WORKER_IMAGE: IMAGE,
    WORKER_MEMORY_MB: "64",
    WORKER_PIDS_LIMIT: "32",
  });

  async function session(id: string) {
    await db.insert(sessions).values({
      id,
      ownerId: runLabel,
      repoUrl: "https://example.invalid/repo.git",
      branch: `session/${id}`,
    });
    await db.insert(turns).values({
      sessionId: id,
      sequence: 1,
      message: "hi",
      status: "queued",
    });
    await db.insert(unassignedSessions).values({ sessionId: id });
  }

  beforeAll(async () => {
    await new DockerClient(dockerHost, "v1.44", {
      timeoutMs: 110_000,
    }).pullImage(IMAGE);
    proxy = await startStandInProxy({
      dockerHost,
      image: IMAGE,
      installationId: runLabel,
    });
    database = await createTempDatabase({ prefix: options.prefix });
    pool = new Pool({ connectionString: database.url });
    db = drizzle(pool, { schema });
    if (options.tempDir) dir = await mkdtemp(join(tmpdir(), options.tempDir));
    await session(crashing);
  }, 120_000);

  afterAll(async () => {
    for (const container of await client
      .listContainers([`${LABELS.installation}=${runLabel}`])
      .catch(() => [])) {
      await client
        .stopAndRemoveContainer(container.Id, 1)
        .catch(() => undefined);
    }
    for (const sessionId of [crashing, healthy]) {
      for (const volume of await client
        .listVolumes([`${LABELS.sessionId}=${sessionId}`])
        .catch(() => [])) {
        await fetch(`http://docker/v1.44/volumes/${volume.Name}?force=true`, {
          method: "DELETE",
          unix: dockerHost.replace("unix://", ""),
        } as RequestInit).catch(() => undefined);
      }
    }
    if (proxy) await client.stopAndRemoveContainer(proxy, 1).catch(() => {});
    await removeWorkerNetworks(client, runLabel).catch((error: unknown) => {
      console.warn("[scheduler.integration] worker networks left", error);
    });
    await pool.end();
    await database.drop();
    if (dir) await rm(dir, { force: true, recursive: true });
  }, 120_000);

  return {
    get db() {
      return db;
    },
    get dir() {
      return dir;
    },
    client,
    runLabel,
    crashing,
    healthy,
    settings,
    session,
  };
}

integration("scheduler pass against Docker and PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const client = new DockerClient(dockerHost);
  const sessionIds: string[] = [];
  const runLabel = `it-${crypto.randomUUID()}`;
  /** Where the rollout test points the configured tag. */
  const movedRepo = `ap-${runLabel}`;
  let proxy: string | undefined;

  const environment = () => ({
    ...process.env,
    AWS_ACCESS_KEY_ID: "test",
    AWS_ENDPOINT_URL: "http://localstack:4566",
    AWS_REGION: "ap-northeast-1",
    AWS_SECRET_ACCESS_KEY: "test",
    DATABASE_URL: database.url,
    DOCKER_HOST: dockerHost,
    EXECUTION_EGRESS_PROXY_URL: "http://egress-proxy:3128",
    EXECUTION_INSTALLATION_ID: runLabel,
    EXECUTION_DOCKER_COMMAND: "sleep 600",
    EXECUTION_SLOT_LIMIT: "10",
    QUEUED_INPUT_LIMIT_PER_SESSION: "20",
    SESSION_COST_LIMIT_USD: "25",
    STORAGE_LIMIT_BYTES: "1073741824",
    // The runner's data root is on ext4, so the daemon cannot carry a
    // volume quota; the quota itself is covered by workspace.integration.test.ts.
    EXECUTION_WORKSPACE_QUOTA: "off",
    S3_BUCKET: "claude-sessions",
    WORKER_CPUS: "0.25",
    WORKER_GATEWAY_URL: "http://host.docker.internal:3000",
    WORKER_IMAGE: IMAGE,
    WORKER_MEMORY_MB: "64",
    WORKER_PIDS_LIMIT: "32",
  });

  beforeAll(async () => {
    await new DockerClient(dockerHost, "v1.44", {
      timeoutMs: 110_000,
    }).pullImage(IMAGE);
    proxy = await startStandInProxy({
      dockerHost,
      image: IMAGE,
      installationId: runLabel,
    });
    database = await createTempDatabase({ prefix: "scheduler_it" });
    pool = new Pool({ connectionString: database.url });
    db = drizzle(pool, { schema });
    for (let i = 0; i < 15; i += 1) {
      const id = crypto.randomUUID();
      sessionIds.push(id);
      await db.insert(sessions).values({
        id,
        ownerId: runLabel,
        repoUrl: "https://example.invalid/repo.git",
        branch: `session/${id}`,
      });
      await db.insert(unassignedSessions).values({ sessionId: id });
    }
  }, 120_000);

  afterAll(async () => {
    const rows = await db
      .select({ id: executions.id, generation: executions.generation })
      .from(executions)
      .where(inArray(executions.sessionId, sessionIds));
    for (const row of rows) {
      await client
        .stopAndRemoveContainer(
          containerNameFor(
            { executionId: row.id, generation: row.generation },
            runLabel,
          ),
          1,
        )
        .catch(() => undefined);
    }
    for (const sessionId of sessionIds) {
      for (const volume of await client
        .listVolumes([`${LABELS.sessionId}=${sessionId}`])
        .catch(() => [])) {
        await fetch(`http://docker/v1.44/volumes/${volume.Name}?force=true`, {
          method: "DELETE",
          unix: dockerHost.replace("unix://", ""),
        } as RequestInit).catch(() => undefined);
      }
    }
    for (const container of await client
      .listContainers([`${LABELS.installation}=${runLabel}`])
      .catch(() => [])) {
      await client
        .stopAndRemoveContainer(container.Id, 1)
        .catch(() => undefined);
    }
    if (proxy) await client.stopAndRemoveContainer(proxy, 1).catch(() => {});
    await fetch(`http://docker/v1.44/images/${movedRepo}:moved?force=true`, {
      method: "DELETE",
      unix: dockerHost.replace("unix://", ""),
    } as RequestInit).catch(() => undefined);
    await removeWorkerNetworks(client, runLabel).catch((error: unknown) => {
      console.warn("[scheduler.integration] worker networks left", error);
    });
    await pool.end();
    await database.drop();
  }, 120_000);

  test("15 unassigned sessions → at most 10 containers, and a rerun adds none", async () => {
    const first = await main(environment());
    expect(first.launched).toHaveLength(10);
    expect(first.failedLaunches).toEqual([]);

    const second = await main(environment());
    expect(second.launched).toEqual([]);
    expect(second.reensured).toEqual([]);
    expect(second.orphansTerminated).toEqual([]);
    expect(second.activeAfter).toBe(10);

    const ours = (
      await client.listContainers([`${LABELS.managed}=true`])
    ).filter((c) => sessionIds.includes(c.Labels?.[LABELS.sessionId] ?? ""));
    expect(ours).toHaveLength(10);
    expect(ours.every((c) => c.State === "running")).toBe(true);

    const live = await db
      .select({
        sessionId: executions.sessionId,
        state: executions.observedState,
      })
      .from(executions)
      .where(inArray(executions.sessionId, sessionIds));
    expect(live).toHaveLength(10);
    expect(new Set(live.map((row) => row.sessionId)).size).toBe(10);

    // Every container is labelled with exactly the row it belongs to.
    const rows = await db
      .select({ id: executions.id, generation: executions.generation })
      .from(executions)
      .where(inArray(executions.sessionId, sessionIds));
    const rowKeys = new Set(rows.map((r) => `${r.id}#${r.generation}`));
    for (const container of ours) {
      const key = `${container.Labels?.[LABELS.executionId]}#${container.Labels?.[LABELS.generation]}`;
      expect(rowKeys.has(key)).toBe(true);
    }
    // One network per worker, none shared.
    const networks = await client.listNetworks([
      `${LABELS.workerNetwork}=true`,
      `${LABELS.installation}=${runLabel}`,
    ]);
    expect(networks.map((n) => n.Name).sort()).toEqual(
      rows
        .map((r) =>
          networkNameFor(
            { executionId: r.id, generation: r.generation },
            runLabel,
          ),
        )
        .sort(),
    );
  }, 180_000);

  test("a force-removed worker that is re-ensured keeps its one network", async () => {
    const [row] = await db
      .select({ id: executions.id, generation: executions.generation })
      .from(executions)
      .where(inArray(executions.sessionId, sessionIds));
    if (!row) throw new Error("no execution row");
    const ref = { executionId: row.id, generation: row.generation };
    const before = await client.inspectNetwork(networkNameFor(ref, runLabel));
    await client.stopAndRemoveContainer(containerNameFor(ref, runLabel), 1);

    const summary = await main(environment());

    expect(summary.reensured).toContainEqual(ref);
    expect(summary.networksReclaimed).toEqual([]);
    const after = await client.inspectNetwork(networkNameFor(ref, runLabel));
    expect(after?.Id).toBe(before?.Id);
  }, 180_000);

  test("a worker re-created after the tag moved runs the image its launch was pinned to; only a new launch gets the moved one", async () => {
    const resources = {
      cpus: 0.25,
      memoryBytes: 64 * 1024 * 1024,
      pidsLimit: 32,
      workerLimits: { maxTurnSeconds: 3600, providerMaxRetries: 2 },
    };
    const pinned = (await client.inspectImage(IMAGE))?.Id;
    if (!pinned) throw new Error(`${IMAGE} has no id`);
    const launches = await db
      .select()
      .from(workerLaunches)
      .where(inArray(workerLaunches.sessionId, sessionIds));
    const [launch] = launches;
    if (!launch) throw new Error("no launch");
    for (const row of launches) {
      expect(row.image).toBe(pinned);
      expect(row.resources).toEqual(resources);
    }
    const ref = { executionId: launch.executionId, generation: 1 };
    const spec = launchSpecFingerprint(pinned, resources);
    const before = await client.inspectContainer(
      containerNameFor(ref, runLabel),
    );
    expect(before?.Image).toBe(pinned);
    expect(before?.Config.Labels?.[LABELS.launchSpec]).toBe(spec);

    // A rollout: the configured reference now names other content. A
    // committed container is an image with its own id, no pull needed; it
    // is committed from a bare one, since a commit keeps the labels of what
    // it was taken from.
    const socket = { unix: dockerHost.replace("unix://", "") };
    const bare = `ap-it-bare-${runLabel}`;
    const created = await fetch(
      `http://docker/v1.44/containers/create?name=${bare}`,
      {
        ...socket,
        body: JSON.stringify({ Cmd: ["true"], Image: IMAGE }),
        headers: { "content-type": "application/json" },
        method: "POST",
      } as RequestInit,
    );
    expect(created.status).toBe(201);
    try {
      const commit = await fetch(
        `http://docker/v1.44/commit?container=${bare}&repo=${movedRepo}&tag=moved`,
        { ...socket, method: "POST" } as RequestInit,
      );
      expect(commit.status).toBe(201);
    } finally {
      await client.stopAndRemoveContainer(bare, 1).catch(() => undefined);
    }
    const moved = (await client.inspectImage(`${movedRepo}:moved`))?.Id;
    if (!moved) throw new Error("the moved image has no id");
    expect(moved).not.toBe(pinned);
    await client.stopAndRemoveContainer(containerNameFor(ref, runLabel), 1);

    const summary = await main({
      ...environment(),
      // One more slot, so a waiting session is admitted under the new tag.
      EXECUTION_SLOT_LIMIT: "11",
      WORKER_IMAGE: `${movedRepo}:moved`,
    });

    expect(summary.reensured).toContainEqual(ref);
    expect(summary.launched).toHaveLength(1);
    expect(summary.imageUnresolved).toBe(false);
    const rebuilt = await client.inspectContainer(
      containerNameFor(ref, runLabel),
    );
    expect(rebuilt?.Id).not.toBe(before?.Id);
    expect(rebuilt?.Image).toBe(pinned);
    expect(rebuilt?.Config.Labels?.[LABELS.launchSpec]).toBe(spec);
    const [fresh] = summary.launched;
    if (!fresh) throw new Error("nothing admitted");
    const admitted = await client.inspectContainer(
      containerNameFor(fresh, runLabel),
    );
    expect(admitted?.Image).toBe(moved);
    expect(admitted?.Config.Labels?.[LABELS.launchSpec]).toBe(
      launchSpecFingerprint(moved, resources),
    );
  }, 180_000);

  test("the network of a worker nothing will relaunch is gone after one pass", async () => {
    // A worker with no launch intent behind it — what a force-removed
    // container leaves when its execution is already finished. With the
    // container gone, only the network is left to find.
    const backend = new LocalDockerBackend(
      localDockerConfigFromEnv(environment()),
    );
    const ref = { executionId: crypto.randomUUID(), generation: 1 };
    const sessionId = crypto.randomUUID();
    // Tracked so afterAll removes its workspace; GC would leave one this young.
    sessionIds.push(sessionId);
    await backend.ensureExecution({
      ...ref,
      bootstrapCredentialState: async () => ({
        claimed: false,
        fingerprint: launchNonceFingerprint(hashWorkerToken("wln-orphan")),
      }),
      image: IMAGE,
      issueBootstrapNonce: async () => "wln-orphan",
      launchSpec: null,
      operationId: crypto.randomUUID(),
      resources: { cpus: 0.25, memoryBytes: 64 * 1024 * 1024, pidsLimit: 32 },
      sessionId,
    });
    await fetch(
      `http://docker/v1.44/containers/${containerNameFor(ref, runLabel)}?force=true`,
      {
        method: "DELETE",
        unix: dockerHost.replace("unix://", ""),
      } as RequestInit,
    );
    const name = networkNameFor(ref, runLabel);
    expect(await client.inspectNetwork(name)).not.toBeNull();

    const summary = await main(environment());

    expect(summary.networksReclaimed).toEqual([name]);
    expect(summary.networksFailed).toEqual([]);
    expect(await client.inspectNetwork(name)).toBeNull();
  }, 180_000);

  test("a second running proxy costs the live networks both, before the pass refuses", async () => {
    const [row] = await db
      .select({ id: executions.id, generation: executions.generation })
      .from(executions)
      .where(inArray(executions.sessionId, sessionIds));
    if (!row) throw new Error("no execution row");
    const network = networkNameFor(
      { executionId: row.id, generation: row.generation },
      runLabel,
    );
    const second = await startStandInProxy({
      dockerHost,
      image: IMAGE,
      installationId: runLabel,
      name: `ap-it-proxy2-${runLabel}`,
    });
    try {
      await client.connectNetwork(network, second, ["egress-proxy"]);
      const proxyNames = async () =>
        Object.values((await client.inspectNetwork(network))?.Containers ?? {})
          .map((member) => member.Name)
          .filter((name) => name === proxy || name === second);
      expect((await proxyNames()).sort()).toEqual([proxy ?? "", second].sort());

      await expect(main(environment())).rejects.toThrow(
        "2 running containers carry",
      );

      expect(await proxyNames()).toEqual([]);
    } finally {
      await client.stopAndRemoveContainer(second, 1).catch(() => undefined);
    }
    // Down to one again: the next pass gives it back.
    const summary = await main(environment());
    expect(summary.networksRepaired).toContain(network);
  }, 180_000);

  test("a refused quota preflight still reclaims the workspaces it can", async () => {
    // The probe needs disk, so the daemon that fails it is often the one that
    // is full — the moment reclaiming finished sessions matters most. This
    // daemon fails the probe for a different reason (no project quota behind
    // its storage), which exercises the same path: refuse to admit work, but
    // not before the pass has had its chance to free disk.
    const closedSession = crypto.randomUUID();
    sessionIds.push(closedSession);
    await db.insert(sessions).values({
      id: closedSession,
      ownerId: runLabel,
      repoUrl: "https://example.invalid/repo.git",
      branch: `session/${closedSession}`,
      admissionState: "closed",
    });
    const naming = {
      installationId: runLabel,
      volumeLabelNamespace: "werft",
      volumeNamePrefix: "werft-ws-",
    };
    const volumeKeys = volumeLabelsOf(naming);
    const name = `${workspaceVolumePrefixFor(closedSession, naming)}7a6b5c4d`;
    await client.createVolume({
      Driver: "local",
      Labels: {
        [volumeKeys.installation]: runLabel,
        [volumeKeys.managed]: "true",
        [volumeKeys.sessionId]: closedSession,
        [volumeKeys.workspaceQuota]: "off",
      },
      Name: name,
    });

    await expect(
      main({
        ...environment(),
        EXECUTION_WORKSPACE_QUOTA: "on",
        EXECUTION_WORKSPACE_GC_MIN_AGE_SEC: "0",
      }),
    ).rejects.toThrow("cannot put a size and inode quota");

    expect(await client.inspectVolume(name)).toBeNull();
  }, 180_000);
});

integration(
  "scheduler launch failures exhaust the startup budget against Docker and PostgreSQL",
  () => {
    const run = failureRun({ prefix: "scheduler_fail_it", slotLimit: "1" });
    const { client, runLabel, crashing, healthy, session } = run;
    const environment = (command: string) => ({
      ...process.env,
      ...run.settings(command),
    });

    test("a worker that dies before it claims is retried in place, given up on at the limit, and its slot reused", async () => {
      const launches = () =>
        run.db
          .select()
          .from(workerLaunches)
          .where(eq(workerLaunches.sessionId, crashing));
      const summaries = [];
      for (let pass = 0; pass < 16; pass += 1) {
        const summary = await main(environment("false"));
        summaries.push(summary);
        if (summary.launchesQuarantined.length > 0) break;
        // Long enough for `false` to have exited; then the backoff is spent
        // on the database clock instead of waited out.
        await Bun.sleep(500);
        await run.db
          .update(workerLaunches)
          .set({ launchRetryAt: sql`clock_timestamp() - interval '1 second'` })
          .where(eq(workerLaunches.sessionId, crashing));
      }
      const rows = await launches();
      // One launch, one generation, however many times it was built.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.generation).toBe(1);
      expect(rows[0]?.launchFailureCount).toBe(5);
      expect(rows[0]?.lastLaunchError).toMatch(
        /terminated right after launch|exited before a worker claimed/,
      );
      expect(rows[0]?.slotReleasedAt).not.toBeNull();
      const last = summaries.at(-1);
      expect(last?.launchesQuarantined).toHaveLength(1);
      expect(last?.killed).toHaveLength(1);
      expect(
        await client.listContainers([
          `${LABELS.installation}=${runLabel}`,
          `${LABELS.sessionId}=${crashing}`,
        ]),
      ).toEqual([]);
      const [given] = await run.db
        .select({ status: sessions.status })
        .from(sessions)
        .where(eq(sessions.id, crashing));
      expect(given?.status).toBe("failed");
      const [turn] = await run.db
        .select({ status: turns.status })
        .from(turns)
        .where(eq(turns.sessionId, crashing));
      expect(turn?.status).toBe("failed");

      // The one slot is free again: a session that can run gets it.
      await session(healthy);
      const next = await main(environment("sleep 600"));
      expect(next.launched).toHaveLength(1);
      expect(next.failedLaunches).toEqual([]);
      const [running] = await client.listContainers([
        `${LABELS.installation}=${runLabel}`,
        `${LABELS.sessionId}=${healthy}`,
      ]);
      expect(running?.State).toBe("running");
    }, 300_000);
  },
);

integration(
  "the scheduler loop over a crash-looping session against Docker and PostgreSQL",
  () => {
    const run = failureRun({
      prefix: "scheduler_loop_it",
      slotLimit: "2",
      tempDir: "scheduler-loop-it-",
    });
    const { client, runLabel, crashing, healthy, session, settings } = run;

    test("a session waiting out its launch backoff neither ends the loop nor holds up another session", async () => {
      const launch = async () => {
        const [row] = await run.db
          .select()
          .from(workerLaunches)
          .where(eq(workerLaunches.sessionId, crashing));
        return row;
      };
      // A worker that dies before it claims, until the scheduler has counted
      // it as a failed launch; then its backoff outlasts this test, so every
      // pass of the loop below finds it backing off.
      for (let pass = 0; pass < 10; pass += 1) {
        await main({ ...process.env, ...settings("false") });
        if ((await launch())?.launchFailureCount === 1) break;
        await Bun.sleep(500);
      }
      expect((await launch())?.launchFailureCount).toBe(1);
      await run.db
        .update(workerLaunches)
        .set({ launchRetryAt: sql`clock_timestamp() + interval '1 hour'` })
        .where(eq(workerLaunches.sessionId, crashing));
      await session(healthy);

      // The scheduler role as compose runs it: the loop over its `--serve`
      // child, giving up after three failed passes in a row.
      const statusFile = join(run.dir, "status.json");
      const passes = 5;
      const controller = new AbortController();
      const loop = runPassLoop({
        name: "Scheduler",
        command: [
          "env",
          ...Object.entries(settings("sleep 600")).map(
            ([name, value]) => `${name}=${value}`,
          ),
          process.execPath,
          "run",
          join(import.meta.dir, "..", "main.ts"),
          "scheduler",
          "--serve",
        ],
        config: {
          intervalMs: 100,
          passTimeoutMs: 120_000,
          killGraceMs: 30_000,
          maxConsecutiveFailures: 3,
          statusFile,
        },
        logger: {
          info: () => {},
          warn: () => {},
          error: (message, fields) => console.error(message, fields),
        },
        signal: controller.signal,
      });
      let ended = false;
      void loop.then(() => {
        ended = true;
      });
      const deadline = Date.now() + 240_000;
      while (!ended && Date.now() < deadline) {
        if (((await readStatus(statusFile))?.passes ?? 0) >= passes) break;
        await Bun.sleep(250);
      }
      controller.abort();
      // Before every one of these passes exited 1 and the loop
      // returned 1 on the third: the restart policy's cue.
      expect(await loop).toBe(0);
      const status = await readStatus(statusFile);
      expect(status?.passes).toBeGreaterThanOrEqual(passes);
      expect(status).toMatchObject({
        consecutiveFailures: 0,
        lastFailureAt: null,
        lastSuccessAt: null,
      });
      const degradedAt = Date.parse(status?.lastDegradedAt ?? "");
      expect(judgeHealth(status, new Date(degradedAt), 140_000)).toEqual({
        healthy: true,
        reason: "last pass 0s ago completed degraded",
      });

      // Still backing off in its slot: one launch, one generation.
      const row = await launch();
      expect(row?.generation).toBe(1);
      expect(row?.launchFailureCount).toBe(1);
      expect(row?.slotReleasedAt).toBeNull();
      // And the other session got the other slot meanwhile.
      const [running] = await client.listContainers([
        `${LABELS.installation}=${runLabel}`,
        `${LABELS.sessionId}=${healthy}`,
      ]);
      expect(running?.State).toBe("running");
    }, 300_000);
  },
);
