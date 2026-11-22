import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  hashWorkerToken,
  type LaunchIntent,
  launchNonceFingerprint,
} from "@werft-ai/platform";
import {
  LABELS,
  LocalDockerBackend,
  volumeLabelsOf,
  workspaceVolumePrefixFor,
} from "./backend.ts";
import type { LocalDockerBackendConfig, WorkspaceQuota } from "./config.ts";
import { DockerApiError, DockerClient } from "./docker-client.ts";
import {
  quotaForTestDaemon,
  removeWorkerNetworks,
  startStandInProxy,
  testDockerHost,
} from "./testing.ts";

/**
 * Workspace volumes against a real daemon: the ceiling, the labels GC reads,
 * and the reclaim. Opt in with `DOCKER_BACKEND_TEST=1`.
 *
 * The ceiling only exists where the daemon's storage can carry one — xfs with
 * `prjquota` — and neither of the two daemons this repo runs on has it.
 * Docker Desktop's LinuxKit kernel is built without XFS quota support at all
 * (`XFS (loop0): quota support not available in this kernel`), and a stock
 * Linux runner keeps its data root on ext4; both answer
 * `POST /volumes/create` with 400 `quota size requested but no quota support`.
 * So this suite probes the daemon and asserts what that daemon can prove:
 * enforcement where a quota exists, refusal to start where it does not. The
 * `workspace-quota` CI job builds a daemon that has one, which is where the
 * disk-pressure test actually runs.
 */
const enabled = process.env.DOCKER_BACKEND_TEST === "1";
const integration = enabled ? describe : describe.skip;
const IMAGE = process.env.DOCKER_BACKEND_TEST_IMAGE ?? "busybox:1.36";
const dockerHost = await testDockerHost();
/** Small enough that filling it is a second of `dd`, not a minute. */
const QUOTA_BYTES = 64 * 1024 * 1024;
/** Small enough that exhausting it is a few seconds of `touch`. */
const QUOTA_INODES = 1000;

/**
 * Runs `script` against `volume` at /workspace and hands back its exit
 * status. The container is root and otherwise unconstrained on purpose: what
 * is under test is the volume's ceiling, not the worker's isolation, and a
 * fresh volume is root-owned until an image seeds it.
 */
async function runScript(
  client: DockerClient,
  volume: string,
  script: string,
): Promise<number> {
  const container = `werft-ws-dd-${crypto.randomUUID().slice(0, 8)}`;
  await client.createContainer(container, {
    Cmd: ["sh", "-c", script],
    Env: [],
    HostConfig: {
      CapDrop: [],
      Memory: 256 * 1024 * 1024,
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
      await Bun.sleep(500);
    }
    throw new Error(`${container} never exited`);
  } finally {
    await client.stopAndRemoveContainer(container, 1).catch(() => {});
  }
}

/**
 * Creates empty files until one fails, and exits 0 only if that failure is
 * `No space left on device` within a few files of `limit` — the volume's root
 * directory holds one inode of its own. Empty files cost the byte quota
 * nothing, so this is exactly the exhaustion the byte ceiling lets through.
 */
function exhaustInodes(limit: number): string {
  return [
    "i=0",
    `while [ $i -lt ${limit + 100} ]; do`,
    // `touch`, not `: >`: a redirection that fails on a special builtin
    // ends a non-interactive shell before the error can be read.
    '  if ! touch "/workspace/f$i" 2>/tmp/err; then',
    '    echo "file $i: $(cat /tmp/err)"',
    "    grep -q 'No space left on device' /tmp/err || exit 3",
    `    [ $i -ge ${limit - 5} ] && [ $i -lt ${limit} ] && exit 0`,
    "    exit 4",
    "  fi",
    "  i=$((i + 1))",
    "done",
    "exit 5",
  ].join("\n");
}

integration("workspace volumes against a real daemon", () => {
  const client = new DockerClient(dockerHost);
  const installationId = `wsit-${crypto.randomUUID().slice(0, 8)}`;
  const sessionIds: string[] = [];
  /** Volumes made outside the backend, so cleanup knows about them too. */
  const strayVolumes: string[] = [];
  let supportsQuota = false;
  let proxy: string | undefined;

  const backendConfig = (): LocalDockerBackendConfig => ({
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

  /** What this daemon can actually be held to. */
  function quota(): WorkspaceQuota {
    return quotaForTestDaemon(supportsQuota, {
      inodes: QUOTA_INODES,
      sizeBytes: QUOTA_BYTES,
    });
  }

  function intentFor(): LaunchIntent {
    const suffix = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    sessionIds.push(sessionId);
    return {
      executionId: `exec-${suffix}`,
      generation: 1,
      image: IMAGE,
      bootstrapCredentialState: async () => ({
        claimed: false,
        fingerprint: launchNonceFingerprint(hashWorkerToken(`wln-${suffix}`)),
      }),
      issueBootstrapNonce: async () => `wln-${suffix}`,
      launchSpec: null,
      operationId: `op-${suffix}`,
      resources: { cpus: 0.5, memoryBytes: 128 * 1024 * 1024, pidsLimit: 64 },
      sessionId,
    };
  }

  beforeAll(async () => {
    await client.version();
    await new DockerClient(dockerHost, "v1.44", {
      timeoutMs: 110_000,
    }).pullImage(IMAGE);
    proxy = await startStandInProxy({
      dockerHost,
      image: IMAGE,
      installationId,
    });
    supportsQuota = await probeQuotaSupport();
  }, 120_000);

  afterAll(async () => {
    for (const sessionId of sessionIds) {
      for (const container of await client.listContainers([
        `${LABELS.sessionId}=${sessionId}`,
      ])) {
        await client.stopAndRemoveContainer(container.Id, 1).catch(() => {});
      }
      for (const volume of await client.listVolumes([
        `${LABELS.installation}=${installationId}`,
        `${LABELS.sessionId}=${sessionId}`,
      ])) {
        await client.removeVolume(volume.Name).catch(() => {});
      }
    }
    for (const name of strayVolumes) {
      await client.removeVolume(name).catch(() => {});
    }
    if (proxy) await client.stopAndRemoveContainer(proxy, 1).catch(() => {});
    await removeWorkerNetworks(client, installationId).catch(() => {});
  }, 60_000);

  /** This session's workspace, found the way the backend finds it. */
  async function workspaceOf(sessionId: string) {
    const found = await client.listVolumes([
      `${LABELS.managed}=true`,
      `${LABELS.installation}=${installationId}`,
      `${LABELS.sessionId}=${sessionId}`,
    ]);
    expect(found).toHaveLength(1);
    return found[0] ?? null;
  }

  /** The same question the preflight asks, asked here without an opinion. */
  async function probeQuotaSupport(): Promise<boolean> {
    const name = `werft-ws-probe-${installationId}`;
    strayVolumes.push(name);
    try {
      const volume = await client.createVolume({
        Driver: "local",
        DriverOpts: { size: String(QUOTA_BYTES) },
        Labels: {},
        Name: name,
      });
      return Number(volume.Options?.size) === QUOTA_BYTES;
    } catch (error) {
      if (error instanceof DockerApiError) return false;
      throw error;
    } finally {
      await client.removeVolume(name).catch(() => {});
    }
  }

  test("the volume is labelled for GC and stamped with its ceiling", async () => {
    const backend = new LocalDockerBackend(backendConfig(), client);
    const intent = intentFor();
    await backend.ensureExecution(intent);

    const volume = await workspaceOf(intent.sessionId);
    expect(volume?.Labels).toMatchObject({
      [LABELS.installation]: installationId,
      [LABELS.managed]: "true",
      [LABELS.sessionId]: intent.sessionId,
      [volumeLabelsOf(backendConfig()).workspaceQuota]: supportsQuota
        ? `enforced:${QUOTA_BYTES}`
        : "off",
    });
    expect(volume?.Options?.size).toBe(
      supportsQuota ? String(QUOTA_BYTES) : undefined,
    );
  }, 60_000);

  test("preflight either proves the ceiling or refuses to start", async () => {
    const strict = new LocalDockerBackend(
      {
        ...backendConfig(),
        workspaceQuota: {
          helperImage:
            process.env.DOCKER_BACKEND_TEST_HELPER_IMAGE ?? "busybox:1.36",
          inodes: QUOTA_INODES,
          mode: "enforced",
          sizeBytes: QUOTA_BYTES,
        },
      },
      client,
    );
    if (supportsQuota) {
      await expect(strict.verifyWorkspaceQuota()).resolves.toBeUndefined();
    } else {
      await expect(strict.verifyWorkspaceQuota()).rejects.toThrow(
        "EXECUTION_WORKSPACE_QUOTA=off",
      );
    }
    // Either way it leaves nothing behind.
    expect(
      await client.inspectVolume(`ap-quota-probe-${installationId}`),
    ).toBeNull();
  }, 60_000);

  test("a worker's workspace stops new files at the inode limit and bytes at the byte limit", async () => {
    if (!supportsQuota) {
      // Nothing to hold: this daemon has no quota, and the preflight test
      // above is what holds it to refusing to start instead.
      expect(supportsQuota).toBe(false);
      return;
    }
    const backend = new LocalDockerBackend(backendConfig(), client);
    const intent = intentFor();
    await backend.ensureExecution(intent);
    const volume = (await workspaceOf(intent.sessionId))?.Name ?? "";

    // What `df -i` inside the container reports is the configured limit,
    // and what `df` reports is the configured size.
    expect(
      await runScript(
        client,
        volume,
        `test "$(df -P -i /workspace | awk 'NR==2 {print $2}')" = ${QUOTA_INODES}`,
      ),
    ).toBe(0);
    expect(
      await runScript(
        client,
        volume,
        `test "$(df -P -k /workspace | awk 'NR==2 {print $2}')" -le ${QUOTA_BYTES / 1024}`,
      ),
    ).toBe(0);
    // The byte ceiling is still there beside it.
    expect(
      await runScript(
        client,
        volume,
        "dd if=/dev/zero of=/workspace/over bs=1M count=256 2>&1 | grep -q 'No space left on device'; s=$?; rm -f /workspace/over; exit $s",
      ),
    ).toBe(0);
    expect(await runScript(client, volume, exhaustInodes(QUOTA_INODES))).toBe(
      0,
    );
  }, 180_000);

  test("a workspace from before the inode limit gets it on its next launch", async () => {
    if (!supportsQuota) {
      expect(supportsQuota).toBe(false);
      return;
    }
    const intent = intentFor();
    // Made the way made them: bounded by bytes, labelled, and never
    // shown to the helper.
    const volume = `${workspaceVolumePrefixFor(intent.sessionId, backendConfig())}pre22400`;
    await client.createVolume({
      Driver: "local",
      DriverOpts: { size: String(QUOTA_BYTES) },
      Labels: {
        [LABELS.installation]: installationId,
        [LABELS.managed]: "true",
        [LABELS.sessionId]: intent.sessionId,
        [volumeLabelsOf(backendConfig()).workspaceQuota]:
          `enforced:${QUOTA_BYTES}`,
      },
      Name: volume,
    });
    await new LocalDockerBackend(backendConfig(), client).ensureExecution(
      intent,
    );
    expect((await workspaceOf(intent.sessionId))?.Name).toBe(volume);
    expect(await runScript(client, volume, exhaustInodes(QUOTA_INODES))).toBe(
      0,
    );
  }, 180_000);

  test("the opt-out asks the daemon for nothing", async () => {
    const off = new LocalDockerBackend(
      { ...backendConfig(), workspaceQuota: { mode: "off" } },
      client,
    );
    await expect(off.verifyWorkspaceQuota()).resolves.toBeUndefined();
  });

  test("a reclaimed workspace comes back under a name of its own", async () => {
    // The ceiling this buys is what `workspace disk pressure` measures; what
    // is checked here is the rule it rests on — that a workspace removed and
    // made again never lands on the name it had.
    const backend = new LocalDockerBackend(backendConfig(), client);
    const intent = intentFor();
    await backend.ensureExecution(intent);
    const first = (await workspaceOf(intent.sessionId))?.Name ?? "";
    expect(first).toStartWith(
      workspaceVolumePrefixFor(intent.sessionId, backendConfig()),
    );

    await backend.terminate(intent);
    expect(await backend.removeWorkspace(first)).toEqual({
      outcome: "removed",
    });

    await backend.ensureExecution(intent);
    const second = (await workspaceOf(intent.sessionId))?.Name ?? "";
    expect(second).toStartWith(
      workspaceVolumePrefixFor(intent.sessionId, backendConfig()),
    );
    expect(second).not.toBe(first);
  }, 120_000);

  test("a workspace is reclaimed once nothing mounts it", async () => {
    const backend = new LocalDockerBackend(backendConfig(), client);
    const intent = intentFor();
    await backend.ensureExecution(intent);
    const name = (await workspaceOf(intent.sessionId))?.Name ?? "";

    const listed = await backend.listWorkspaces();
    expect(listed.map((w) => w.id)).toContain(name);
    expect(listed.find((w) => w.id === name)?.sessionId).toBe(intent.sessionId);

    // The container still holds it: Docker answers 409, and that is a
    // "leave it", not a "force it".
    expect(await backend.removeWorkspace(name)).toEqual({
      outcome: "in_use",
    });
    expect(await client.inspectVolume(name)).not.toBeNull();

    await backend.terminate(intent);
    expect(await backend.removeWorkspace(name)).toEqual({
      outcome: "removed",
    });
    expect(await client.inspectVolume(name)).toBeNull();
  }, 120_000);

  test("another installation's volume is not this one's to remove", async () => {
    const name = `werft-ws-other-${crypto.randomUUID().slice(0, 8)}`;
    strayVolumes.push(name);
    await client.createVolume({
      Driver: "local",
      Labels: {
        [LABELS.installation]: "someone-else",
        [LABELS.managed]: "true",
      },
      Name: name,
    });
    const backend = new LocalDockerBackend(backendConfig(), client);

    expect(await backend.removeWorkspace(name)).toEqual({
      outcome: "not_ours",
    });
    expect(await client.inspectVolume(name)).not.toBeNull();
    // It is not even a candidate: the listing is filtered by installation.
    expect((await backend.listWorkspaces()).map((w) => w.id)).not.toContain(
      name,
    );
  }, 60_000);
});

/**
 * The acceptance run for the ceiling itself, and the only test that needs a
 * quota-capable daemon. It runs wherever one exists; see the suite comment
 * for why that is neither a Mac nor a stock Linux runner.
 */
integration("workspace disk pressure", () => {
  const client = new DockerClient(dockerHost);
  const name = `werft-ws-quota-${crypto.randomUUID().slice(0, 8)}`;
  const strayNames: string[] = [];
  let capable = false;

  beforeAll(async () => {
    await new DockerClient(dockerHost, "v1.44", {
      timeoutMs: 110_000,
    }).pullImage(IMAGE);
    try {
      const volume = await client.createVolume({
        Driver: "local",
        DriverOpts: { size: String(QUOTA_BYTES) },
        Labels: {},
        Name: name,
      });
      capable = Number(volume.Options?.size) === QUOTA_BYTES;
    } catch (error) {
      if (!(error instanceof DockerApiError)) throw error;
    }
  }, 120_000);

  afterAll(async () => {
    for (const volume of [name, ...strayNames]) {
      await client.removeVolume(volume).catch(() => {});
    }
  });

  const runAgainstVolume = (script: string, volume = name) =>
    runScript(client, volume, script);

  test("writing past the ceiling fails while writing under it succeeds", async () => {
    if (!capable) {
      // Nothing to assert: this daemon cannot put a ceiling on a volume, and
      // the suite above is what holds it to refusing to start instead.
      expect(capable).toBe(false);
      return;
    }
    expect(
      await runAgainstVolume(
        "dd if=/dev/zero of=/workspace/under bs=1M count=16",
      ),
    ).toBe(0);
    // The pipeline's status is grep's, so exit 0 means `dd` really said it.
    expect(
      await runAgainstVolume(
        "dd if=/dev/zero of=/workspace/over bs=1M count=256 2>&1 | grep -q 'No space left on device'",
      ),
    ).toBe(0);
    // And the ceiling is the configured one, not the host's free space.
    expect(
      await runAgainstVolume(
        `test "$(df -P -k /workspace | awk 'NR==2 {print $2}')" -le ${QUOTA_BYTES / 1024}`,
      ),
    ).toBe(0);
  }, 180_000);

  test("a workspace made after another was removed is bounded too", async () => {
    // Workspaces are removed all the time — GC reclaims a finished session's,
    // an operator clears one by hand — and the next one must still have a
    // ceiling. It does only because the name is never reused: the `local`
    // driver hands a name it has already quota'd back with `Options.size`
    // intact and nothing behind it, which no API call can detect. This is
    // the only daemon in the repo that can tell the two apart, so this is
    // where the rule that names are single-use is held to its promise.
    if (!capable) {
      expect(capable).toBe(false);
      return;
    }
    await client.removeVolume(name);
    const next = `${name}-next`;
    strayNames.push(next);
    const again = await client.createVolume({
      Driver: "local",
      DriverOpts: { size: String(QUOTA_BYTES) },
      Labels: {},
      Name: next,
    });
    expect(Number(again.Options?.size)).toBe(QUOTA_BYTES);

    expect(
      await runAgainstVolume(
        "dd if=/dev/zero of=/workspace/over bs=1M count=256 2>&1 | grep -q 'No space left on device'",
        next,
      ),
    ).toBe(0);
    // And the ceiling is the configured one, not the host's free space.
    expect(
      await runAgainstVolume(
        `test "$(df -P -k /workspace | awk 'NR==2 {print $2}')" -le ${QUOTA_BYTES / 1024}`,
        next,
      ),
    ).toBe(0);
  }, 180_000);
});
