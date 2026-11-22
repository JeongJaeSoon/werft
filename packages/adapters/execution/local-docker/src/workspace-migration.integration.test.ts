import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  hashWorkerToken,
  type LaunchIntent,
  launchNonceFingerprint,
} from "@werft-ai/platform";
import {
  LABELS,
  LocalDockerBackend,
  legacyWorkspaceVolumeName,
  volumeLabelsOf,
} from "./backend.ts";
import type { LocalDockerBackendConfig, WorkspaceQuota } from "./config.ts";
import { DockerApiError, DockerClient } from "./docker-client.ts";
import {
  quotaForTestDaemon,
  removeWorkerNetworks,
  startStandInProxy,
  testDockerHost,
} from "./testing.ts";
import {
  DEFAULT_MIGRATION_HELPER_IMAGE,
  MIGRATION_HELPER_LABEL,
  WorkspaceMigrator,
} from "./workspace-migration.ts";

/**
 * Moving a legacy workspace onto the quota contract against a real daemon
 * . Opt in with `DOCKER_BACKEND_TEST=1`. Where the daemon can carry
 * a quota (the `workspace-quota` CI job) the copy lands under one; elsewhere
 * under `off`, which is the same procedure with a different stamp.
 */
const enabled = process.env.DOCKER_BACKEND_TEST === "1";
const integration = enabled ? describe : describe.skip;
const IMAGE = process.env.DOCKER_BACKEND_TEST_IMAGE ?? "busybox:1.36";
// CI points both at its mirror (ci-image-mirror.yml) instead of Docker Hub.
const HELPER_IMAGE =
  process.env.EXECUTION_WORKSPACE_MIGRATION_IMAGE ||
  DEFAULT_MIGRATION_HELPER_IMAGE;
const dockerHost = await testDockerHost();
const QUOTA_BYTES = 64 * 1024 * 1024;

/** A worker's tree: nested files, an owner that is not root, a symlink, modes. */
const SEED = [
  "mkdir -p /workspace/repo/src",
  "echo 'export const x = 1;' > /workspace/repo/src/index.ts",
  "printf 'binary\\000data' > /workspace/repo/blob",
  "ln -s src/index.ts /workspace/repo/entry",
  "chmod 750 /workspace/repo/src",
  "chown -R 1000:1000 /workspace/repo",
].join(" && ");

/** What `SEED` wrote, read back; any drift fails the `test` chain. */
const VERIFY = [
  'test "$(cat /workspace/repo/src/index.ts)" = "export const x = 1;"',
  'test "$(stat -c %u:%g /workspace/repo/src/index.ts)" = 1000:1000',
  'test "$(stat -c %a /workspace/repo/src)" = 750',
  'test "$(readlink /workspace/repo/entry)" = src/index.ts',
  "test -f /workspace/repo/blob",
  "ls -la /workspace/repo",
].join(" && ");

integration("workspace migration against a real daemon", () => {
  const client = new DockerClient(dockerHost);
  const installationId = `wsmig-${crypto.randomUUID().slice(0, 8)}`;
  const sessionIds: string[] = [];
  let supportsQuota = false;
  let proxy: string | undefined;

  function quota(): WorkspaceQuota {
    return quotaForTestDaemon(supportsQuota, {
      inodes: 10_000,
      sizeBytes: QUOTA_BYTES,
    });
  }

  const config = (): LocalDockerBackendConfig => ({
    apiVersion: "v1.44",
    command: ["sleep", "600"],
    dockerHost,
    egressCredentialPort: 3129,
    egressProxyUrl: "http://egress-proxy:3128",
    gatewayUrl: "http://host.docker.internal:3000",
    homeDir: "/home/worker",
    installationId,
    objectStore: {
      bucket: "claude-sessions",
      region: "ap-northeast-1",
    },
    requestTimeoutMs: 30_000,
    stopTimeoutSeconds: 1,
    tmpfsSizeBytes: 16 * 1024 * 1024,
    user: "1000:1000",
    workspaceDir: "/workspace",
    volumeLabelNamespace: "werft",
    volumeNamePrefix: "werft-ws-",
    workspaceGcMinAgeMs: 0,
    workspaceQuota: quota(),
  });

  function intentFor(sessionId: string): LaunchIntent {
    const suffix = crypto.randomUUID();
    return {
      bootstrapCredentialState: async () => ({
        claimed: false,
        fingerprint: launchNonceFingerprint(hashWorkerToken(`wln-${suffix}`)),
      }),
      executionId: `exec-${suffix}`,
      generation: 1,
      image: IMAGE,
      issueBootstrapNonce: async () => `wln-${suffix}`,
      // What the workspace is judged on does not depend on it.
      launchSpec: null,
      operationId: `op-${suffix}`,
      resources: { cpus: 0.5, memoryBytes: 128 * 1024 * 1024, pidsLimit: 64 },
      sessionId,
    };
  }

  /** A session whose workspace predates the quota: unlabelled, at its derived name. */
  async function legacySession(): Promise<{
    sessionId: string;
    legacy: string;
  }> {
    const sessionId = crypto.randomUUID();
    sessionIds.push(sessionId);
    const legacy = legacyWorkspaceVolumeName(sessionId, config());
    // Exactly what a mount spec used to conjure: a volume with no labels.
    await client.createVolume({ Driver: "local", Labels: {}, Name: legacy });
    expect(await run(SEED, legacy)).toBe(0);
    return { legacy, sessionId };
  }

  /** Runs `script` as root against `volume` at /workspace; its exit code. */
  async function run(
    script: string,
    volume: string,
    options: { keep?: string } = {},
  ): Promise<number> {
    const container =
      options.keep ?? `ap-wsmig-run-${crypto.randomUUID().slice(0, 8)}`;
    await client.createContainer(container, {
      Cmd: ["sh", "-c", script],
      Env: [],
      HostConfig: {
        CapDrop: [],
        Memory: 128 * 1024 * 1024,
        Mounts: [{ Source: volume, Target: "/workspace", Type: "volume" }],
        NanoCpus: 1_000_000_000,
        NetworkMode: "none",
        PidsLimit: 64,
        ReadonlyRootfs: false,
        RestartPolicy: { Name: "no" },
        SecurityOpt: [],
        Tmpfs: {},
      },
      Image: IMAGE,
      Labels: { [LABELS.installation]: installationId },
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
      if (options.keep === undefined) {
        await client.stopAndRemoveContainer(container, 1).catch(() => {});
      }
    }
  }

  async function workspacesOf(sessionId: string) {
    return client.listVolumes([
      `${LABELS.managed}=true`,
      `${LABELS.installation}=${installationId}`,
      `${LABELS.sessionId}=${sessionId}`,
    ]);
  }

  /** The pins and helpers the migrator has left for a session. */
  const toolContainers = async (sessionId: string) =>
    (
      await client.listContainers([
        `${MIGRATION_HELPER_LABEL}=${installationId}`,
        `${LABELS.sessionId}=${sessionId}`,
      ])
    ).map((container) => container.Names[0]);

  const migrate = (sessionId: string) =>
    new WorkspaceMigrator(config(), client).migrate({
      deadlineMs: 60_000,
      helperImage: HELPER_IMAGE,
      pollMs: 200,
      sessionId,
    });

  beforeAll(async () => {
    const puller = new DockerClient(dockerHost, "v1.44", {
      timeoutMs: 110_000,
    });
    await puller.pullImage(IMAGE);
    await puller.pullImage(HELPER_IMAGE);
    proxy = await startStandInProxy({
      dockerHost,
      image: IMAGE,
      installationId,
    });
    const probe = `ap-wsmig-probe-${installationId}`;
    try {
      const volume = await client.createVolume({
        Driver: "local",
        DriverOpts: { size: String(QUOTA_BYTES) },
        Labels: {},
        Name: probe,
      });
      supportsQuota = Number(volume.Options?.size) === QUOTA_BYTES;
    } catch (error) {
      if (!(error instanceof DockerApiError)) throw error;
    } finally {
      await client.removeVolume(probe).catch(() => {});
    }
  }, 180_000);

  afterAll(async () => {
    for (const container of await client.listContainers([
      `${LABELS.installation}=${installationId}`,
    ])) {
      await client.stopAndRemoveContainer(container.Id, 1).catch(() => {});
    }
    for (const sessionId of sessionIds) {
      for (const container of await client.listContainers([
        `${LABELS.sessionId}=${sessionId}`,
      ])) {
        await client.stopAndRemoveContainer(container.Id, 1).catch(() => {});
      }
      for (const volume of await workspacesOf(sessionId)) {
        await client.removeVolume(volume.Name).catch(() => {});
      }
      await client
        .removeVolume(legacyWorkspaceVolumeName(sessionId, config()))
        .catch(() => {});
    }
    if (proxy) await client.stopAndRemoveContainer(proxy, 1).catch(() => {});
    await removeWorkerNetworks(client, installationId).catch(() => {});
  }, 60_000);

  test("a legacy workspace lands under the quota with its tree intact, and the session launches on it", async () => {
    const { legacy, sessionId } = await legacySession();
    const backend = new LocalDockerBackend(config(), client);
    // The container is gone and the legacy volume cannot be relaunched onto.
    await expect(backend.ensureExecution(intentFor(sessionId))).rejects.toThrow(
      "was created under quota <none>",
    );

    const result = await migrate(sessionId);

    if (result.outcome !== "migrated") throw new Error(result.outcome);
    expect(result.source).toBe(legacy);
    expect(await client.inspectVolume(legacy)).toBeNull();
    const [copy, ...others] = await workspacesOf(sessionId);
    expect(others).toEqual([]);
    expect(copy?.Name).toBe(result.target);
    expect(copy?.Labels).toMatchObject({
      [LABELS.installation]: installationId,
      [LABELS.managed]: "true",
      [volumeLabelsOf(config()).migratedFrom]: legacy,
      [LABELS.sessionId]: sessionId,
      [volumeLabelsOf(config()).workspaceQuota]: supportsQuota
        ? `enforced:${QUOTA_BYTES}`
        : "off",
    });
    expect(copy?.Options?.size).toBe(
      supportsQuota ? String(QUOTA_BYTES) : undefined,
    );
    expect(await run(VERIFY, result.target)).toBe(0);

    // The relaunch the legacy volume refused now mounts the copy.
    await backend.ensureExecution(intentFor(sessionId));
    const [worker] = await client.listContainers([
      `${LABELS.sessionId}=${sessionId}`,
      `${LABELS.managed}=true`,
    ]);
    const inspected = await client.inspectContainer(worker?.Id ?? "");
    expect(
      inspected?.Mounts.find((mount) => mount.Destination === "/workspace")
        ?.Name,
    ).toBe(result.target);

    // And a second run has nothing left to do.
    await client.stopAndRemoveContainer(worker?.Id ?? "", 1);
    expect(await migrate(sessionId)).toEqual({
      outcome: "current",
      workspace: result.target,
    });
  }, 180_000);

  test("a copy that fails part-way leaves the original, and a re-run starts over", async () => {
    const { legacy, sessionId } = await legacySession();
    // A device node: root in an ordinary container can make one, the
    // helper — which holds no MKNOD — cannot, so its `cp -a` fails after
    // copying whatever came before it.
    expect(await run("mknod /workspace/repo/zz-device c 1 3", legacy)).toBe(0);

    await expect(migrate(sessionId)).rejects.toThrow(
      "the copy failed part-way",
    );
    expect(await run(VERIFY, legacy)).toBe(0);
    const leftovers = await workspacesOf(sessionId);
    expect(
      leftovers.map(
        (volume) => volume.Labels?.[volumeLabelsOf(config()).migratedFrom],
      ),
    ).toEqual([legacy]);
    // The unfinished copy is not something the session can launch onto.
    await expect(
      new LocalDockerBackend(config(), client).ensureExecution(
        intentFor(sessionId),
      ),
    ).rejects.toThrow("finish the migration");

    expect(await run("rm /workspace/repo/zz-device", legacy)).toBe(0);
    const result = await migrate(sessionId);
    if (result.outcome !== "migrated") throw new Error(result.outcome);
    // The leftover went; only the new copy remains.
    expect(
      (await workspacesOf(sessionId)).map((volume) => volume.Name),
    ).toEqual([result.target]);
    expect(result.target).not.toBe(leftovers[0]?.Name);
    expect(await run(VERIFY, result.target)).toBe(0);
  }, 180_000);

  test("a volume a container still holds is not copied", async () => {
    const { legacy, sessionId } = await legacySession();
    // Stopped counts: starting it again would write to the source mid-copy.
    const holder = `ap-wsmig-holder-${crypto.randomUUID().slice(0, 8)}`;
    expect(await run("true", legacy, { keep: holder })).toBe(0);

    await expect(migrate(sessionId)).rejects.toThrow(`is mounted by ${holder}`);
    expect(await workspacesOf(sessionId)).toEqual([]);
    expect(await run(VERIFY, legacy)).toBe(0);

    await client.stopAndRemoveContainer(holder, 1);
    expect((await migrate(sessionId)).outcome).toBe("migrated");
  }, 180_000);

  test("a tree with more files than the inode limit fails the copy and keeps the source", async () => {
    if (!supportsQuota) {
      // No quota here, so no limit for the copy to meet.
      expect(supportsQuota).toBe(false);
      return;
    }
    const { legacy, sessionId } = await legacySession();
    // SEED's tree is six inodes, root included. The limit goes on the copy
    // before anything is copied into it, so the copy runs out part-way.
    const tight: LocalDockerBackendConfig = {
      ...config(),
      workspaceQuota: quotaForTestDaemon(true, {
        inodes: 3,
        sizeBytes: QUOTA_BYTES,
      }),
    };
    await expect(
      new WorkspaceMigrator(tight, client).migrate({
        deadlineMs: 60_000,
        helperImage: HELPER_IMAGE,
        pollMs: 200,
        sessionId,
      }),
    ).rejects.toThrow("the copy failed part-way");
    expect(await run(VERIFY, legacy)).toBe(0);

    // Under a limit the tree fits in, a re-run starts over and lands.
    expect((await migrate(sessionId)).outcome).toBe("migrated");
  }, 180_000);

  test("a lost lock leaves the source pinned against a GC that outran it", async () => {
    const { legacy, sessionId } = await legacySession();
    // The lock's signal fires once the copy exists: the moment a GC pass
    // that listed only the source could come to remove it.
    const lock = new AbortController();
    const watch = (async () => {
      while (!lock.signal.aborted) {
        if ((await workspacesOf(sessionId)).length > 0) lock.abort();
        else await Bun.sleep(10);
      }
    })();
    await expect(
      new WorkspaceMigrator(config(), client).migrate({
        deadlineMs: 60_000,
        helperImage: HELPER_IMAGE,
        pollMs: 200,
        sessionId,
        signal: lock.signal,
      }),
    ).rejects.toThrow();
    await watch;

    const backend = new LocalDockerBackend(config(), client);
    expect(await backend.removeWorkspace(legacy, { sessionId })).toEqual({
      outcome: "in_use",
    });
    expect(await run(VERIFY, legacy)).toBe(0);

    // The next run, under the lock again, takes the pin down with it.
    const result = await migrate(sessionId);
    if (result.outcome !== "migrated") throw new Error(result.outcome);
    expect(await toolContainers(sessionId)).toEqual([]);
    expect(await run(VERIFY, result.target)).toBe(0);
  }, 180_000);

  test("a run that resumes late cannot unpin the run that followed it", async () => {
    const { legacy, sessionId } = await legacySession();
    // A lost its lock after verifying its copy and stalls just before taking
    // its pin down; B, under the lock now, runs until its own pin holds the
    // source; then A goes on to remove the source.
    let resumeB!: () => void;
    const bMayCopy = new Promise<void>((resolve) => {
      resumeB = resolve;
    });
    let bPinned!: () => void;
    const bHasPin = new Promise<void>((resolve) => {
      bPinned = resolve;
    });
    let runB: Promise<unknown> | undefined;
    const clientB = new (class extends DockerClient {
      override async createVolume(
        ...args: Parameters<DockerClient["createVolume"]>
      ) {
        bPinned();
        await bMayCopy;
        return super.createVolume(...args);
      }
    })(dockerHost);
    const pinsOfA = new Set<string>();
    const clientA = new (class extends DockerClient {
      override async createContainer(
        ...args: Parameters<DockerClient["createContainer"]>
      ) {
        const created = await super.createContainer(...args);
        if (args[0].startsWith("werft-ws-migrate-pin-"))
          pinsOfA.add(created.Id);
        return created;
      }
      override async stopAndRemoveContainer(id: string, timeout: number) {
        if (pinsOfA.has(id) && runB === undefined) {
          runB = new WorkspaceMigrator(config(), clientB)
            .migrate({
              deadlineMs: 60_000,
              helperImage: HELPER_IMAGE,
              pollMs: 200,
              sessionId,
            })
            .then(
              (result) => result,
              (error: unknown) => error,
            );
          await bHasPin;
        }
        return super.stopAndRemoveContainer(id, timeout);
      }
    })(dockerHost);

    await expect(
      new WorkspaceMigrator(config(), clientA).migrate({
        deadlineMs: 60_000,
        helperImage: HELPER_IMAGE,
        pollMs: 200,
        sessionId,
      }),
    ).rejects.toThrow("is held by another container after the copy");
    expect(await run(VERIFY, legacy)).toBe(0);

    resumeB();
    const result = await runB;
    if (result instanceof Error) throw result;
    expect(result).toMatchObject({ outcome: "migrated", source: legacy });
    expect(await client.inspectVolume(legacy)).toBeNull();
    const { target } = result as { target: string };
    expect(await run(VERIFY, target)).toBe(0);
    expect(await toolContainers(sessionId)).toEqual([]);
  }, 180_000);

  test("a run that stalls after pinning leaves the next run's pin and copy alone", async () => {
    const { legacy, sessionId } = await legacySession();
    // A pins the source and stalls; B, under the lock now, pins it too and
    // makes its copy; then A goes on while B waits to start its helper.
    let resumeB!: () => void;
    const bMayCopy = new Promise<void>((resolve) => {
      resumeB = resolve;
    });
    let bCopied!: () => void;
    const bHasCopy = new Promise<void>((resolve) => {
      bCopied = resolve;
    });
    let runB: Promise<unknown> | undefined;
    const clientB = new (class extends DockerClient {
      override async createVolume(
        ...args: Parameters<DockerClient["createVolume"]>
      ) {
        const created = await super.createVolume(...args);
        bCopied();
        await bMayCopy;
        return created;
      }
    })(dockerHost);
    const clientA = new (class extends DockerClient {
      override async createContainer(
        ...args: Parameters<DockerClient["createContainer"]>
      ) {
        const created = await super.createContainer(...args);
        if (args[0].startsWith("werft-ws-migrate-pin-") && runB === undefined) {
          runB = new WorkspaceMigrator(config(), clientB)
            .migrate({
              deadlineMs: 60_000,
              helperImage: HELPER_IMAGE,
              pollMs: 200,
              sessionId,
            })
            .then(
              (result) => result,
              (error: unknown) => error,
            );
          await bHasCopy;
        }
        return created;
      }
    })(dockerHost);

    await expect(
      new WorkspaceMigrator(config(), clientA).migrate({
        deadlineMs: 60_000,
        helperImage: HELPER_IMAGE,
        pollMs: 200,
        sessionId,
      }),
    ).rejects.toThrow(`another migration of ${legacy} is in progress`);
    expect(await run(VERIFY, legacy)).toBe(0);

    resumeB();
    const result = await runB;
    if (result instanceof Error) throw result;
    expect(result).toMatchObject({ outcome: "migrated", source: legacy });
    const { target } = result as { target: string };
    expect(
      (await workspacesOf(sessionId)).map((volume) => volume.Name),
    ).toEqual([target]);
    expect(await run(VERIFY, target)).toBe(0);
    expect(await toolContainers(sessionId)).toEqual([]);
  }, 180_000);

  test("a run that stalls before pinning cannot make a finished migration undone", async () => {
    const { legacy, sessionId } = await legacySession();
    // Docker stamps CreatedAt to the second; a stand-in made within the
    // second the source was would pass for it. No real source is that young.
    await Bun.sleep(1_100);
    // A has planned and stalls before its pin; B migrates to the end and
    // removes the source; A's pin mount then makes an empty volume under
    // the source's name.
    let finishedB: unknown;
    const clientA = new (class extends DockerClient {
      override async createContainer(
        ...args: Parameters<DockerClient["createContainer"]>
      ) {
        if (args[0].startsWith("werft-ws-migrate-pin-") && !finishedB) {
          finishedB = await migrate(sessionId);
        }
        return super.createContainer(...args);
      }
    })(dockerHost);

    await expect(
      new WorkspaceMigrator(config(), clientA).migrate({
        deadlineMs: 60_000,
        helperImage: HELPER_IMAGE,
        pollMs: 200,
        sessionId,
      }),
    ).rejects.toThrow("was removed and recreated empty");
    expect(finishedB).toMatchObject({ outcome: "migrated", source: legacy });
    const { target } = finishedB as { target: string };
    expect(await client.inspectVolume(legacy)).not.toBeNull();

    // The retry an operator would make refuses rather than discarding B's
    // copy as a leftover of the empty stand-in.
    await expect(migrate(sessionId)).rejects.toThrow(
      "not from the one there now",
    );
    expect(await run(VERIFY, target)).toBe(0);
    expect(await toolContainers(sessionId)).toEqual([]);
  }, 180_000);

  test("a helper image not pinned by digest is refused before anything is made", async () => {
    const { sessionId } = await legacySession();
    await expect(
      new WorkspaceMigrator(config(), client).migrate({
        deadlineMs: 60_000,
        helperImage: "busybox:1.36",
        sessionId,
      }),
    ).rejects.toThrow("must be pinned by digest");
    expect(await workspacesOf(sessionId)).toEqual([]);
  }, 60_000);
});
