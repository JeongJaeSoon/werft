import { createHash } from "node:crypto";
import type { ExecutionState } from "@werft-ai/contracts";
import {
  ENV,
  egressCredentialUrlOf,
  NO_PROXY_VALUE,
  noProxyValueFor,
} from "@werft-ai/contracts/execution";
import {
  type EnsureExecutionResult,
  type ExecutionBackend,
  type ExecutionBackendCapabilities,
  type ExecutionObservation,
  type ExecutionRef,
  hashWorkerToken,
  type LaunchIntent,
  LaunchOutcomeUnknownError,
  LaunchSpecMismatchError,
  launchNonceFingerprint,
  type ManagedExecution,
  type ManagedWorkspace,
  messageOf,
  type NetworkReconcileResult,
  sessionObjectPrefix,
  type TerminateExecutionResult,
  type TerminateOptions,
  type WorkspaceRemovalResult,
} from "@werft-ai/platform";
import {
  type LocalDockerBackendConfig,
  validateLocalDockerConfig,
  type WorkspaceQuota,
} from "./config.ts";
import {
  type ContainerCreateBody,
  type ContainerInspect,
  type ContainerSummary,
  DockerApiError,
  DockerClient,
  DockerTimeoutError,
  type ImageInspect,
  type NetworkInspect,
  type VolumeInspect,
} from "./docker-client.ts";
import {
  applyInodeLimit,
  removeStrayInodeHelpers,
} from "./workspace-inodes.ts";

export const LABELS = {
  /**
   * `launchNonceFingerprint` of the credential in the container's env. Never
   * the credential: the label is what lets a pass tell whether the container
   * it is about to adopt holds the nonce the registry currently accepts.
   */
  bootstrapFingerprint: "werft.bootstrap-fingerprint",
  /**
   * On the egress proxy container, set by whoever deploys it: which
   * installation's workers it serves. The backend attaches that container,
   * and only that one, to each worker network it creates.
   */
  egressProxy: "werft.egress-proxy",
  executionId: "werft.session-execution-id",
  generation: "werft.generation",
  /** Which isolation contract the container was created under. */
  isolation: "werft.isolation",
  /** Which control host owns the container; two installations may share a daemon. */
  installation: "werft.installation",
  /**
   * The intent's `launchSpec`: which image and limits the launch was
   * reserved with. Absent on a container whose launch stored none.
   */
  launchSpec: "werft.launch-spec",
  managed: "werft.managed",
  operationId: "werft.operation-id",
  sessionId: "werft.session-id",
  /** On a per-execution worker network, beside the execution's own labels. */
  workerNetwork: "werft.worker-network",
} as const;

/**
 * The labels a workspace volume carries. Unlike `LABELS`, the prefix is the
 * install's (`volumeLabelNamespace`): Docker cannot relabel a volume, so an
 * install whose volumes were made under another prefix names it instead of
 * losing sight of them. Only the configured prefix is ever read.
 */
export function volumeLabelsOf(config: {
  volumeLabelNamespace: string;
}): VolumeLabelKeys {
  const ns = config.volumeLabelNamespace;
  return {
    installation: `${ns}.installation`,
    managed: `${ns}.managed`,
    /**
     * On a workspace `migrateWorkspace` made: the volume it copied. While that
     * volume still exists the copy is unfinished, and this label is what lets
     * a re-run remove the copy as its own rather than someone else's.
     */
    migratedFrom: `${ns}.migration-source`,
    /**
     * On a migration copy: the source's creation time when it was copied. A
     * source name alone can come back as a different, empty volume — Docker
     * makes one for any mount of a missing name — and only this tells them
     * apart. Docker keeps it to the second, which is enough: a source is
     * copied, removed and remade within the second it was created only if it
     * was created during the migration, and every source predates it.
     */
    migrationSourceCreatedAt: `${ns}.migration-source-created-at`,
    /**
     * On the preflight's throwaway volume. Deliberately *not* `managed`: GC
     * judges by that label, and a probe has no session for it to match, so
     * labelling it managed would hand the reaper something it can only ever
     * leave alone. This label is what makes the probe ours to delete.
     */
    quotaProbe: `${ns}.quota-probe`,
    sessionId: `${ns}.session-id`,
    /** Which ceiling the workspace volume was created under. */
    workspaceQuota: `${ns}.workspace-quota`,
  };
}

export type VolumeLabelKeys = {
  installation: string;
  managed: string;
  migratedFrom: string;
  migrationSourceCreatedAt: string;
  quotaProbe: string;
  sessionId: string;
  workspaceQuota: string;
};

export { ENV, NO_PROXY_VALUE } from "@werft-ai/contracts/execution";

/**
 * Bumped whenever the isolation a worker container is created with changes.
 * A running container that predates the current value keeps whatever it was
 * created with — an upgrade does not reach inside it — so the scheduler has
 * to be told to replace it instead of reporting it healthy.
 *
 * 1: non-root, read-only rootfs, dropped caps, per-session volume, bridge.
 * 2: internal worker network and egress proxy, no host-gateway mapping.
 * 3: object store access and the session prefix are part of the boundary.
 * 4: the workspace volume is created explicitly, under a byte quota.
 * 5: each worker on an internal network of its own, shared only with the
 * egress proxy, so workers no longer reach one another.
 * 6: that network gives the host no address on it, so a host process
 * listening on a wildcard address is out of reach too.
 * 7: the workspace volume carries an inode ceiling beside its byte one
 * . A version, not only the fingerprint, so a host rolled back
 *    past it reads these workers as newer and leaves them be.
 */
export const ISOLATION_CONTRACT = 7;

/** The first contract whose workers each sit on a network of their own. */
const PER_EXECUTION_NETWORK_CONTRACT = 5;

/** The first contract whose networks leave the host no address on them. */
const HOST_ISOLATED_NETWORK_CONTRACT = 6;

/**
 * Without it even an internal bridge holds an address for the host (the
 * IPAM gateway), and whatever the host serves on that address or on a
 * wildcard is one hop from the worker, proxy or not. `isolated` leaves the
 * host no address on the network at all. Docker 28 (API 1.48) is the first
 * to know the mode.
 */
const GATEWAY_MODE_OPTION = "com.docker.network.bridge.gateway_mode_ipv4";
const GATEWAY_MODE = "isolated";
const GATEWAY_MODE_MIN_API = [1, 48] as const;

/**
 * What goes in the label: the contract version and a fingerprint of the
 * settings that shape the isolation. The version alone would miss a moved
 * network or a repointed proxy, neither of which needs a code change, and
 * both of which leave the old container on the old boundary.
 *
 * CPU, memory and pids limits stay out on purpose: they belong to the launch,
 * pinned at reservation and checked through the launch-spec label, so a
 * lowered limit takes effect from the next launch instead of retiring every
 * running worker at once.
 */
export function isolationStampFor(config: LocalDockerBackendConfig): string {
  const shape = JSON.stringify([
    config.egressProxyUrl,
    // A worker holding the old credential port would lose its provider.
    config.egressCredentialPort,
    config.homeDir,
    NO_PROXY_VALUE,
    config.tmpfsSizeBytes,
    config.user,
    config.workspaceDir,
    // Where the worker's objects go is part of its boundary: a container
    // still pointed at the old bucket would keep writing there. The
    // endpoint and key are the API's now, behind the object store route
    // so moving them retires no worker; a container from before
    // the route, which still holds the key, reads as stale because this
    // shape changed.
    config.objectStore.bucket,
    config.objectStore.region,
    // A container adopted across a quota change would keep mounting the
    // volume it was created with, whose ceiling cannot be raised or lowered
    // in place. Making it stale forces the replacement through
    // `ensureWorkspaceVolume`, which is what reports the mismatch.
    quotaStampOf(config.workspaceQuota),
    // The inode ceiling is not on the volume's label — it can be set in
    // place — but a container from before it has never been through
    // `ensureWorkspaceVolume` with it, and replacing it is what gets it there.
    config.workspaceQuota.mode === "enforced"
      ? config.workspaceQuota.inodes
      : null,
    // The worker plans its drain from the grace it was started with; stopped
    // with a shorter one, the SIGKILL lands mid-finalize.
    config.stopTimeoutSeconds,
    // Same for the turn deadline and provider retries. It also
    // retires containers from before the limits existed, whose workers
    // report no turn cost and so would never reach the budget.
    config.workerLimits ?? null,
  ]);
  const digest = createHash("sha256").update(shape).digest("hex").slice(0, 16);
  return `${ISOLATION_CONTRACT}:${digest}`;
}

/** How long `terminate` without `waitForExit` waits on a stop. */
const STOP_WAIT_MS = 5_000;
// As the Kubernetes backend reads a failed worker's log: up to 200 lines,
// the last 8 KiB of them kept, at most 64 KiB read for it.
const LOG_TAIL_LINES = [200, 20, 1];
const LOG_TAIL_BYTES = 8 * 1024;
const LOG_TAIL_READ_BYTES = 64 * 1024;

const CONTAINER_NAME_PREFIX = "ap-worker-";
const NETWORK_PREFIX = "werft-net-";
/** The preflight probe's volume; see `volumeLabelsOf().quotaProbe`. */
const QUOTA_PROBE_PREFIX = "ap-quota-probe-";
/**
 * How old a probe must be before another preflight takes it for a leftover.
 * Until its helper container references it — after which Docker refuses the
 * removal — a live probe has waited on two Docker requests at most, its own
 * create and the helper's, each bounded by the request timeout; twenty of
 * them is a wide margin.
 */
const STRAY_PROBE_MIN_AGE_MS = 10 * 60_000;
const STRAY_PROBE_REQUEST_TIMEOUTS = 20;
/** Docker's own wording when the volume driver cannot honour `size`. */
const NO_QUOTA_SUPPORT = "no quota support";
// Docker: [a-zA-Z0-9][a-zA-Z0-9_.-]*
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/**
 * Deterministic per intent, so a retried create collides instead of
 * doubling. Container, network and volume names are daemon-global, so all
 * carry the installation id: two installations sharing a daemon (or a cloned
 * database with the same ids) never collide on names or mount each other's
 * workspace.
 */
export function containerNameFor(
  ref: ExecutionRef,
  installationId: string,
): string {
  return `${CONTAINER_NAME_PREFIX}${installationId}-${safeExecutionId(ref)}-g${ref.generation}`;
}

/**
 * The execution's own network, named after the same launch as its container.
 * A replacement of the same launch comes back to it; the next generation
 * gets another.
 */
export function networkNameFor(
  ref: ExecutionRef,
  installationId: string,
): string {
  return `${NETWORK_PREFIX}${installationId}-${safeExecutionId(ref)}-g${ref.generation}`;
}

function safeExecutionId(ref: ExecutionRef): string {
  if (!SAFE_NAME.test(ref.executionId)) {
    throw new Error(
      `Execution id ${ref.executionId} cannot be used as a Docker name`,
    );
  }
  return ref.executionId;
}

/**
 * The prefix every one of this session's workspace volumes carries.
 *
 * A workspace is found by its labels rather than by a name derived from the
 * session, because the `local` driver can retain stale quota metadata when a
 * removed volume name is reused without applying the quota to the new path.
 * The Docker API cannot distinguish that state, so a name is used once.
 */
export function workspaceVolumePrefixFor(
  sessionId: string,
  config: VolumeNaming,
): string {
  if (!SAFE_NAME.test(sessionId)) {
    throw new Error(`Session id ${sessionId} cannot be used as a volume name`);
  }
  return `${config.volumeNamePrefix}${config.installationId}-${sessionId}-`;
}

export type VolumeNaming = Pick<
  LocalDockerBackendConfig,
  "installationId" | "volumeLabelNamespace" | "volumeNamePrefix"
>;

/**
 * Where a session's workspace lived before names became single-use: the
 * derived name a mount spec made Docker conjure, unlabelled and unbounded.
 */
export function legacyWorkspaceVolumeName(
  sessionId: string,
  config: VolumeNaming,
): string {
  return `${config.volumeNamePrefix}${config.installationId}-${sessionId}`;
}

const SESSION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What the volume's quota label holds, and part of the isolation stamp. */
export function quotaStampOf(quota: WorkspaceQuota): string {
  return quota.mode === "off" ? "off" : `enforced:${quota.sizeBytes}`;
}

/**
 * The volume under this session's workspace name is not the one this host
 * would create — wrong ceiling, wrong owner, or wrong session. Reported
 * rather than fixed: the volume carries a session's working tree across
 * generations, a quota cannot be changed on an existing volume, and deleting
 * it to re-create it would throw that tree away. So the launch stops and
 * says which volume and what is wrong with it.
 */
export class WorkspaceQuotaError extends Error {
  constructor(
    readonly volume: string,
    readonly reason: string,
  ) {
    super(`Workspace volume ${volume} ${reason}`);
    this.name = "WorkspaceQuotaError";
  }
}

/**
 * The preflight's own name is taken by something it did not create. Deleting
 * it would destroy a volume this host has no claim on, and reusing it would
 * let a volume made elsewhere stand in for the proof the daemon owes.
 */
export class QuotaProbeNameTakenError extends Error {
  constructor(readonly volume: string) {
    super(
      `Volume ${volume} is not this host's quota probe. The preflight needs that name and will not remove a volume it did not create; rename or remove it deliberately.`,
    );
    this.name = "QuotaProbeNameTakenError";
  }
}

/**
 * The image declares a `VOLUME` of its own. Docker materializes one anonymous
 * volume per declared path on every container built from it: writable, no
 * ceiling, none of our labels. That is a hole straight through the workspace
 * quota, so the image is refused rather than launched around.
 */
export class ImageVolumeError extends Error {
  constructor(
    readonly image: string,
    readonly paths: string[],
  ) {
    super(
      `Image ${image} declares VOLUME ${paths.join(", ")}. Docker would give each one an ` +
        "unbounded, unlabelled anonymous volume that no quota covers and no GC reclaims. " +
        "Build the worker image without those declarations.",
    );
    this.name = "ImageVolumeError";
  }
}

/** The daemon's storage cannot carry a quota (no xfs `prjquota` behind it). */
export class WorkspaceQuotaUnsupportedError extends Error {
  constructor(cause: string) {
    super(
      `This Docker daemon cannot put a size and inode quota on a local volume (${cause}). ` +
        "An unbounded workspace lets one worker fill the daemon's disk and take " +
        "every other session on it down, so nothing is launched. Move the daemon's " +
        "storage onto xfs with prjquota, or opt out deliberately with " +
        "EXECUTION_WORKSPACE_QUOTA=off.",
    );
    this.name = "WorkspaceQuotaUnsupportedError";
  }
}

function isQuotaUnsupported(error: unknown): boolean {
  return (
    error instanceof DockerApiError && error.body.includes(NO_QUOTA_SUPPORT)
  );
}

/**
 * A worker network is not the one this host would create, or cannot be made
 * into it: routable, dual-stack, someone else's, or holding members other
 * than its worker and the egress proxy. Refused rather than repaired — every
 * one of those is a path from the worker to something it must not reach, and
 * a network whose members are unknown is not one to start a worker on.
 */
export class NetworkIsolationError extends Error {
  constructor(
    readonly network: string,
    readonly reason: string,
  ) {
    super(`Worker network ${network} ${reason}`);
    this.name = "NetworkIsolationError";
  }
}

/**
 * The daemon predates the gateway mode that keeps the host off a worker's
 * network. Refused rather than warned about: without it every host process
 * on a wildcard address is inside the worker's reach, and nothing here
 * could tell which of those matter. No opt-out yet — no supported target
 * runs Docker older than 28; one that has to is the trigger for adding it.
 */
export class GatewayModeUnsupportedError extends Error {
  constructor(readonly apiVersion: string) {
    super(
      `Docker API ${apiVersion} cannot give a worker network ${GATEWAY_MODE_OPTION}=${GATEWAY_MODE}; ` +
        `Docker 28 (API ${GATEWAY_MODE_MIN_API.join(".")}) or later is required`,
    );
    this.name = "GatewayModeUnsupportedError";
  }
}

export class ExecutionConflictError extends Error {
  constructor(
    readonly ref: ExecutionRef,
    readonly expectedOperationId: string,
    readonly foundOperationId: string | undefined,
  ) {
    super(
      `Container for execution ${ref.executionId} generation ${ref.generation} belongs to operation ${foundOperationId ?? "<none>"}, not ${expectedOperationId}`,
    );
    this.name = "ExecutionConflictError";
  }
}

/**
 * A container built under an isolation contract this host does not know.
 * Adopting it would trust a boundary we cannot check, replacing it would
 * swap it for a weaker one, so the pass refuses it and says so.
 */
export class IsolationContractError extends Error {
  constructor(
    readonly ref: ExecutionRef,
    readonly found: string,
  ) {
    super(
      `Container for execution ${ref.executionId} generation ${ref.generation} carries isolation ${found}, newer than this control host's ${ISOLATION_CONTRACT}; roll forward or remove it deliberately`,
    );
    this.name = "IsolationContractError";
  }
}

export class LocalDockerBackend implements ExecutionBackend {
  readonly kind = "local_docker" as const;
  private readonly client: DockerClient;
  private readonly config: LocalDockerBackendConfig;
  /**
   * The workspace `assertReplaceable` found, per session. Replacement takes
   * the old container away before it creates the new one, and for that
   * moment nothing mounts the volume — long enough for a `docker volume
   * prune` to take it. Creating a fresh one then would start the worker on
   * an empty tree and call it a launch, so what was validated is remembered
   * and its absence is an error instead. In memory on purpose: the only
   * reader is the `ensureExecution` that follows in the same pass, and a
   * session whose workspace is genuinely gone should be judged from scratch
   * by the next process rather than from a note this one left.
   */
  private readonly replacementWorkspaces = new Map<string, string>();

  constructor(config: LocalDockerBackendConfig, client?: DockerClient) {
    this.config = validateLocalDockerConfig(config);
    this.client =
      client ??
      new DockerClient(config.dockerHost, config.apiVersion, {
        timeoutMs: config.requestTimeoutMs,
      });
  }

  capabilities(): ExecutionBackendCapabilities {
    return { suspend: false };
  }

  /** The image id: content-addressed, and what a later create names. */
  async resolveImage(reference: string): Promise<string> {
    return this.inspectedImage(reference);
  }

  /**
   * Refuses to start without the egress proxy every worker network needs.
   * The networks themselves are this backend's own, created `internal` per
   * execution and checked each time one is created or reused; what the
   * daemon has to supply is the one proxy container to attach to them.
   * Checked once per process, before anything is launched.
   */
  async verifyNetworkIsolation(): Promise<void> {
    await this.egressProxy();
    const { ApiVersion } = await this.client.version();
    if (!apiAtLeast(ApiVersion, GATEWAY_MODE_MIN_API)) {
      throw new GatewayModeUnsupportedError(ApiVersion);
    }
  }

  /**
   * Refuses to launch onto a daemon that would give the workspace no
   * ceiling. The `local` driver only honours `size` when the storage behind
   * it can carry a project quota, and it says so at create time — so the
   * cheapest honest check is to create one and throw it away. The scheduler
   * runs it before a pass, and only when its loop has not already seen it
   * pass on the same settings.
   */
  async verifyWorkspaceQuota(): Promise<void> {
    const quota = this.config.workspaceQuota;
    if (quota.mode === "off") return;
    // Before the probe exists, so nothing but the helper's own create stands
    // between the probe and the helper that holds it; see
    // `STRAY_PROBE_MIN_AGE_MS`.
    const helperImage = await this.inodeHelperImage(quota);
    const name = `${QUOTA_PROBE_PREFIX}${this.config.installationId}-${crypto.randomUUID().slice(0, 8)}`;
    const keys = volumeLabelsOf(this.config);
    const labels = {
      [keys.installation]: this.config.installationId,
      [keys.quotaProbe]: "true",
    };
    // A probe under a name the daemon has already quota'd proves nothing —
    // see `workspaceVolumePrefixFor` — so each one takes a fresh name, and
    // what an interrupted probe left behind is cleaned up by its labels
    // instead. Only old ones are taken: the preflight runs outside the pass
    // lock, so a young one may be another preflight's, mid-run.
    // Failing to remove one is not worth refusing the launch over: the
    // volume is empty, and the probe below still has to pass.
    const cutoff =
      Date.now() -
      Math.max(
        STRAY_PROBE_MIN_AGE_MS,
        STRAY_PROBE_REQUEST_TIMEOUTS * this.config.requestTimeoutMs,
      );
    for (const stray of await this.client.listVolumes([
      `${keys.quotaProbe}=true`,
      `${keys.installation}=${this.config.installationId}`,
    ])) {
      if (Date.parse(stray.CreatedAt ?? "") < cutoff) {
        await this.client.removeVolume(stray.Name).catch(() => undefined);
      }
    }
    let volume: VolumeInspect;
    try {
      volume = await this.client.createVolume({
        Driver: "local",
        DriverOpts: { size: String(quota.sizeBytes) },
        Labels: labels,
        Name: name,
      });
    } catch (error) {
      if (isQuotaUnsupported(error)) {
        throw new WorkspaceQuotaUnsupportedError(messageOf(error));
      }
      throw error;
    }
    // Checked before the removal below, not inside it: a create onto a name
    // something else already holds answers with *that* volume, and deleting
    // it on the way out would destroy data this host has no claim on.
    if (
      volume.Labels?.[keys.quotaProbe] !== "true" ||
      volume.Labels?.[keys.installation] !== this.config.installationId
    ) {
      throw new QuotaProbeNameTakenError(name);
    }
    try {
      if (Number(volume.Options?.size) !== quota.sizeBytes) {
        throw new WorkspaceQuotaUnsupportedError(
          `the daemon accepted size=${quota.sizeBytes} but recorded ${volume.Options?.size ?? "no size option"}`,
        );
      }
      // The inode half has no create-time answer; the helper that sets it on
      // every workspace is run here once, on the probe, so a daemon that
      // refuses it fails now rather than one launch at a time.
      const problem = await this.applyInodeLimit(name, quota, helperImage);
      if (problem !== null) {
        throw new WorkspaceQuotaUnsupportedError(`inode limit: ${problem}`);
      }
    } finally {
      await this.client.removeVolume(name).catch(() => undefined);
    }
  }

  async listWorkspaces(): Promise<ManagedWorkspace[]> {
    const { installationId } = this.config;
    const keys = volumeLabelsOf(this.config);
    const [labelled, named] = await Promise.all([
      this.client.listVolumes([
        `${keys.managed}=true`,
        `${keys.installation}=${installationId}`,
      ]),
      this.client.listVolumes(
        [],
        `${this.config.volumeNamePrefix}${installationId}-`,
      ),
    ]);
    const youngerThan = Date.now() - this.config.workspaceGcMinAgeMs;
    const labelledNames = new Set(labelled.map((volume) => volume.Name));
    // A migration that has not removed its source yet: the copy is not
    // known to be whole and the source is the only tree that is, so neither
    // is anyone's to reclaim until `migrateWorkspace` finishes.
    const present = new Set([...labelledNames, ...named.map((v) => v.Name)]);
    const migrating = new Set<string>();
    for (const volume of labelled) {
      const source = volume.Labels?.[keys.migratedFrom];
      if (source !== undefined && present.has(source)) {
        migrating.add(volume.Name);
        migrating.add(source);
      }
    }
    const workspaces: ManagedWorkspace[] = [];
    const add = (
      volume: VolumeInspect,
      workspace: Omit<ManagedWorkspace, "createdAt">,
    ) => {
      if (migrating.has(volume.Name)) return;
      const createdAt = volume.CreatedAt ? new Date(volume.CreatedAt) : null;
      // The age gate is what keeps a launch in flight — volume created,
      // container not yet — from being reaped between the two calls. A
      // volume the daemon will not date cannot pass a gate it cannot be
      // measured against, so it is left alone.
      if (createdAt === null || Number.isNaN(createdAt.getTime())) return;
      if (createdAt.getTime() > youngerThan) return;
      workspaces.push({ createdAt, ...workspace });
    };
    for (const volume of labelled) {
      add(volume, {
        id: volume.Name,
        sessionId: volume.Labels?.[keys.sessionId] ?? null,
      });
    }
    for (const volume of named) {
      if (labelledNames.has(volume.Name)) continue;
      const sessionId = legacySessionOf(volume, this.config);
      if (sessionId === null) continue;
      add(volume, { id: volume.Name, sessionFrom: "name", sessionId });
    }
    return workspaces;
  }

  async removeWorkspace(
    id: string,
    owner?: { sessionId: string },
  ): Promise<WorkspaceRemovalResult> {
    // Re-checked against the daemon rather than trusted from the listing:
    // between the two calls the volume may have been remade for a new
    // session, and the id alone carries no proof of ownership.
    const volume = await this.client.inspectVolume(id);
    if (volume === null) return { outcome: "absent" };
    const labels = volume.Labels ?? {};
    const keys = volumeLabelsOf(this.config);
    const managed =
      labels[keys.managed] === "true" &&
      labels[keys.installation] === this.config.installationId &&
      (owner === undefined || labels[keys.sessionId] === owner.sessionId);
    // A legacy volume has no labels to prove it ours; only a session judged
    // by the caller, whose derived name this is exactly, can claim it.
    const legacy =
      owner !== undefined &&
      id === legacyWorkspaceVolumeName(owner.sessionId, this.config) &&
      legacySessionOf(volume, this.config) === owner.sessionId;
    if (!managed && !legacy) return { outcome: "not_ours" };
    try {
      await this.client.removeVolume(id);
    } catch (error) {
      // A container still holds it: the session it belongs to came back, or
      // a teardown is still in flight. Either way, not ours to force.
      if (error instanceof DockerApiError && error.status === 409) {
        return { outcome: "in_use" };
      }
      throw error;
    }
    return { outcome: "removed" };
  }

  async ensureExecution(intent: LaunchIntent): Promise<EnsureExecutionResult> {
    const name = containerNameFor(intent, this.config.installationId);
    const proxy = await this.egressProxy();
    // A tag is mutable: the image inspected here and the image a later create
    // resolves need not be the same one. Creating from the id that was
    // actually inspected closes that window.
    const image = await this.inspectedImage(intent.image);
    const volume = await this.ensureWorkspaceVolume(intent.sessionId);
    const network = await this.ensureWorkerNetwork(
      intent,
      proxy,
      await this.launchedContainer(intent),
    );
    // Two passes at most. The second is the one that follows a lost create
    // race, and it judges the winner by the same rules — a container that
    // appeared out of a race is not more trustworthy than one that was
    // already there. A second clash means another launcher is fighting for
    // the name, which is a conflict to report, not a loop to spin in.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = await this.client.inspectContainer(name);
      if (existing) {
        const verdict = contractVerdictOf(existing, this.config);
        try {
          if (verdict === "newer") {
            throw new IsolationContractError(
              intent,
              existing.Config.Labels?.[LABELS.isolation] ?? "<none>",
            );
          }
          // Ownership first: a container that is not this launch's is a
          // conflict whatever else is wrong with it, never ours to destroy.
          this.assertSameLaunch(intent, existing);
          if (verdict === "current") assertOnlyOn(existing, network);
        } catch (error) {
          // The proxy is on the network by now. A container that took the
          // name since `launchedContainer` looked, or one of ours that is
          // on another network besides, must not keep it through a refusal.
          // A detach that did not hold is said in the refusal; the next
          // `reconcileNetworks` tries again and fails the pass until it does.
          const detached = await this.detachProxies(
            network,
            new Set([proxy.Id]),
          );
          if (error instanceof Error) error.message += `; ${detached}`;
          throw error;
        }
        if (
          verdict === "current" &&
          (await this.holdsAcceptedCredential(intent, existing))
        ) {
          const spec = existing.Config.Labels?.[LABELS.launchSpec];
          if (
            intent.launchSpec !== null &&
            spec !== undefined &&
            spec !== intent.launchSpec
          ) {
            throw new LaunchSpecMismatchError(intent, spec);
          }
          return this.adopt(intent, existing);
        }
        // Same intent, but either older isolation or a credential the
        // registry no longer accepts — a create that lost the name race to
        // an earlier attempt, or landed late from a previous pass, after the
        // hash had already been rotated. Adopting either would carry a
        // container forward that can never bind, so it is removed and
        // created again; only the create path mints the replacement nonce.
        await this.client.stopAndRemoveContainer(
          existing.Id,
          this.config.stopTimeoutSeconds,
        );
      }
      const body = await this.createBody(intent, image, volume, network.Id);
      let created: { Id: string };
      try {
        // The credential is minted here and nowhere else: it lives in this
        // one request body, reaches the container as an env var, and is only
        // ever stored as a hash. Adopting an existing container skips this,
        // so a worker that is already running keeps the nonce it was given.
        created = await outcomeUnknownOnTimeout(intent, () =>
          this.client.createContainer(name, body),
        );
      } catch (error) {
        // Another launcher (or an earlier attempt whose reply was lost) won.
        if (!(error instanceof DockerApiError) || error.status !== 409) {
          throw withoutSecrets(error, body);
        }
        continue;
      }
      const { Id } = created;
      return outcomeUnknownOnTimeout(intent, async () => {
        // The volume was checked before the create; a prune in between would
        // have had Docker silently conjure an unlabelled, unbounded one for
        // the mount. Nothing has run in the container yet, so this is the
        // last moment the container can still be thrown away instead of
        // bounded.
        await this.assertWorkspaceStillBounded(name, intent.sessionId, volume);
        await this.startOrDiscard(Id);
        const started = await this.client.inspectContainer(name);
        return {
          created: true,
          providerRef: started?.Id ?? name,
          state: started ? stateOf(started.State.Status) : "pending",
        };
      });
    }
    throw new Error(
      `Container ${name} was taken by another launcher on every attempt`,
    );
  }

  async inspect(ref: ExecutionRef): Promise<ExecutionObservation> {
    const container = await this.client.inspectContainer(
      containerNameFor(ref, this.config.installationId),
    );
    const observedAt = new Date();
    if (!container) {
      return { found: false, observedAt, providerRef: null, state: "unknown" };
    }
    // Fail closed: a same-named container that is not ours (other
    // installation, other generation, other execution) must never be
    // reported as this execution's healthy resource.
    this.assertOwned(ref, container);
    const verdict = contractVerdictOf(container, this.config);
    if (verdict === "newer") {
      // Neither healthy nor ours to replace. Throwing leaves the row live and
      // the pass non-zero, which is the only honest answer.
      throw new IsolationContractError(
        ref,
        container.Config.Labels?.[LABELS.isolation] ?? "<none>",
      );
    }
    const state = stateOf(container.State.Status);
    const failed = state === "terminated" && container.State.ExitCode !== 0;
    const logTail = failed ? await this.logTailOf(container.Id) : undefined;
    return {
      ...(state === "terminated" ? { exitCode: container.State.ExitCode } : {}),
      ...(failed && container.State.OOMKilled === true
        ? { terminationReason: "OOMKilled" }
        : {}),
      ...(logTail === undefined ? {} : { logTail }),
      credentialFingerprint: credentialFingerprintOf(container),
      found: true,
      launchSpec: container.Config.Labels?.[LABELS.launchSpec] ?? null,
      observedAt,
      providerRef: container.Id,
      state,
      ...(verdict === "current" ? {} : { stale: true }),
    };
  }

  /**
   * The end of an exited worker's output, or undefined when there is none to
   * read; the container is removed later in the same pass, and its output
   * with it. A read that fails costs only the tail, never the inspect.
   */
  private async logTailOf(id: string): Promise<string | undefined> {
    let read: { output: Uint8Array; cut: boolean } | null = null;
    // A read cut at the limit holds the start of the lines asked for, not
    // their end: it is asked again for fewer lines.
    for (const tail of LOG_TAIL_LINES) {
      try {
        read = await this.client.containerLogs(id, tail, LOG_TAIL_READ_BYTES);
      } catch {
        return undefined;
      }
      if (read === null) return undefined;
      if (!read.cut) {
        if (read.output.length === 0) return undefined;
        return new TextDecoder().decode(read.output.subarray(-LOG_TAIL_BYTES));
      }
    }
    if (read === null) return undefined;
    return `${new TextDecoder().decode(read.output.subarray(0, LOG_TAIL_BYTES))}\n[log tail cut: the last line is longer than ${LOG_TAIL_READ_BYTES} bytes; its end was not read]\n`;
  }

  /**
   * Whether a replacement for this intent could be created, asked before the
   * teardown. A stale verdict is a demolition order: the container is
   * destroyed and then re-created, and everything the create can refuse on —
   * an image this daemon does not have, one that declares its own `VOLUME`,
   * a workspace `ensureWorkspaceVolume` would reject, a network that cannot
   * be made — would leave the session with neither worker, the old one gone
   * and nothing to retry into. Nothing is pinned here and `ensureExecution`
   * resolves the image again, so this narrows the window rather than closing
   * it; that is as much as a question asked before a teardown can do.
   *
   * The one thing it changes is the worker network, which it makes ready
   * rather than inspects: whether the daemon still has an address pool to
   * give is only answered by a create. The replacement is the same launch
   * and comes back to that network; if it never happens, the old container
   * still carries the name and `reconcileNetworks` leaves the network be
   * until it is gone.
   *
   * A refusal leaves the old container running — except one from before
   * contract 5, which sits on a network it shares with every other such
   * worker. That one is taken off all its networks: the session is stalled
   * either way until the replacement can launch, and left connected it
   * could keep reaching its neighbours for as long as that takes.
   */
  async assertReplaceable(intent: LaunchIntent): Promise<void> {
    try {
      const proxy = await this.egressProxy();
      await this.inspectedImage(intent.image);
      const workspace = await this.assertWorkspaceReplaceable(intent.sessionId);
      await this.ensureWorkerNetwork(
        intent,
        proxy,
        await this.launchedContainer(intent),
        { replacing: true },
      );
      if (workspace !== null) {
        this.replacementWorkspaces.set(intent.sessionId, workspace);
      }
    } catch (error) {
      const isolated = await this.isolateSharedNetworkWorker(intent).catch(
        (cause) => `could not be taken off its networks (${messageOf(cause)})`,
      );
      // Appended rather than wrapped: callers tell refusals apart by class.
      if (isolated !== null && error instanceof Error) {
        error.message += `; the old container ${isolated}`;
      }
      throw error;
    }
  }

  /**
   * Disconnects this launch's pre-contract-5 container from every network,
   * and says what happened; null when there is no such container. A
   * container that is not this launch's is left alone.
   */
  private async isolateSharedNetworkWorker(
    intent: LaunchIntent,
  ): Promise<string | null> {
    const existing = await this.client.inspectContainer(
      containerNameFor(intent, this.config.installationId),
    );
    if (existing === null) return null;
    const stamp = existing.Config.Labels?.[LABELS.isolation];
    const version = Number(stamp?.split(":")[0]);
    if (
      Number.isInteger(version) &&
      version >= PER_EXECUTION_NETWORK_CONTRACT
    ) {
      return null;
    }
    try {
      this.assertSameLaunch(intent, existing);
    } catch {
      return null;
    }
    // Only an unclaimed launch: a claimed one is torn down by the scheduler,
    // with a SIGTERM to drain on, without asking this at all.
    if ((await intent.bootstrapCredentialState()).claimed) return null;
    const networks = Object.keys(existing.NetworkSettings?.Networks ?? {});
    for (const network of networks) {
      await this.client
        .disconnectNetwork(network, existing.Id)
        .catch(() => undefined);
    }
    // No fence spans the read above and the disconnects, so the claim is
    // asked again: one that landed in between gets its networks back and is
    // left to the scheduler's teardown like any other claimed worker.
    if ((await intent.bootstrapCredentialState()).claimed) {
      for (const network of networks) {
        await this.client
          .connectNetwork(network, existing.Id, [])
          .catch(() => undefined);
      }
      const restored = await this.client.inspectContainer(existing.Id);
      const back = Object.keys(restored?.NetworkSettings?.Networks ?? {});
      const missing = networks.filter((network) => !back.includes(network));
      return missing.length === 0
        ? `(isolation ${stamp ?? "<none>"}) was claimed while being taken off its networks and was put back`
        : `(isolation ${stamp ?? "<none>"}) was claimed while being taken off its networks and could NOT be put back on ${missing.sort().join(", ")}`;
    }
    const after = await this.client.inspectContainer(existing.Id);
    const left = Object.keys(after?.NetworkSettings?.Networks ?? {});
    return left.length === 0
      ? `(isolation ${stamp ?? "<none>"}) was taken off its networks until the replacement can launch`
      : `(isolation ${stamp ?? "<none>"}) could NOT be taken off ${left.sort().join(", ")}`;
  }

  async listManaged(): Promise<ManagedExecution[]> {
    const containers = await this.client.listContainers([
      `${LABELS.managed}=true`,
      `${LABELS.installation}=${this.config.installationId}`,
    ]);
    const managed: ManagedExecution[] = [];
    for (const container of containers) {
      const labels = container.Labels ?? {};
      const executionId = labels[LABELS.executionId];
      const generation = Number(labels[LABELS.generation]);
      if (!executionId || !Number.isInteger(generation)) continue;
      managed.push({
        executionId,
        generation,
        providerRef: container.Id,
        sessionId: labels[LABELS.sessionId] ?? null,
        state: stateOf(container.State),
      });
    }
    return managed;
  }

  async terminate(
    ref: ExecutionRef,
    options: TerminateOptions = {},
  ): Promise<TerminateExecutionResult> {
    const name = containerNameFor(ref, this.config.installationId);
    const container = await this.client.inspectContainer(name);
    if (!container) {
      // The name encodes the generation, so a different generation of the
      // same execution lives under another name. Find it only to report it.
      const siblings = await this.client.listContainers([
        `${LABELS.executionId}=${ref.executionId}`,
        `${LABELS.installation}=${this.config.installationId}`,
      ]);
      const other = siblings
        .map((c) => Number(c.Labels?.[LABELS.generation]))
        .find((g) => Number.isInteger(g) && g !== ref.generation);
      return other === undefined
        ? { outcome: "absent" }
        : { foundGeneration: other, outcome: "generation_mismatch" };
    }
    const owner = container.Config.Labels?.[LABELS.installation];
    if (owner !== this.config.installationId) {
      throw new ExecutionConflictError(ref, this.config.installationId, owner);
    }
    const labelled = Number(container.Config.Labels?.[LABELS.generation]);
    if (labelled !== ref.generation) {
      return { foundGeneration: labelled, outcome: "generation_mismatch" };
    }
    if (
      options.providerRef !== undefined &&
      container.Id !== options.providerRef
    ) {
      return { foundProviderRef: container.Id, outcome: "provider_mismatch" };
    }
    if (options.waitForExit === false) {
      // Long enough for an idle worker to exit, so the usual kill still ends
      // in the call that asked for it; a busy one drains on without us.
      const stopped = await this.client.stopContainer(
        container.Id,
        this.config.stopTimeoutSeconds,
        Math.min(STOP_WAIT_MS, this.config.requestTimeoutMs),
      );
      if (!stopped) return { outcome: "stopping", providerRef: container.Id };
      await this.client.removeContainer(container.Id);
    } else {
      await this.client.stopAndRemoveContainer(
        container.Id,
        this.config.stopTimeoutSeconds,
      );
    }
    // Best effort: the container is what the caller asked to be rid of, and
    // it is. A network left behind here is found again by
    // `reconcileNetworks`, which reports it if it cannot be removed either.
    await this.removeWorkerNetwork(ref).catch(() => undefined);
    return { outcome: "terminated", providerRef: container.Id };
  }

  /**
   * Removes the worker networks whose container is gone and gives the proxy
   * back to the ones whose container is still there. The container, not a
   * launch row, is what a network is judged by: it exists for exactly one
   * container name, and a launch the scheduler still means to run has had its
   * container re-ensured by the time this runs. A proxy recreated by
   * `compose up` comes back attached to none of them, which is the repair.
   *
   * A live network is held to the same shape it was created with, every
   * pass: a stranger that joined, a same-named container that is not ours,
   * or a worker that also joined another network is reported, and a network
   * with a stranger on it loses the proxy — nothing unknown keeps this
   * installation's allowlist.
   */
  async reconcileNetworks(): Promise<NetworkReconcileResult> {
    const { installationId } = this.config;
    const networks = await this.client.listNetworks([
      `${LABELS.workerNetwork}=true`,
      `${LABELS.installation}=${installationId}`,
    ]);
    const result: NetworkReconcileResult = {
      failed: [],
      removed: [],
      repaired: [],
    };
    if (networks.length === 0) return result;
    const proxies = await this.client.listContainers([
      `${LABELS.egressProxy}=${installationId}`,
    ]);
    const proxyIds = new Set(proxies.map((proxy) => proxy.Id));
    // Settled once, before any network is judged: only the one running
    // proxy may stay on a live network. A stopped predecessor would rejoin
    // under the same alias the moment it started.
    let sole: ContainerSummary | null = null;
    let noSoleProxy = "";
    try {
      sole = soleRunningProxy(proxies, this.config);
    } catch (error) {
      noSoleProxy = messageOf(error);
    }
    const contested =
      proxies.filter((proxy) => proxy.State === "running").length > 1;
    for (const listed of networks) {
      try {
        // A listing leaves out the members; only an inspect has them.
        const network = await this.client.inspectNetwork(listed.Id);
        if (network === null) continue;
        const labels = network.Labels ?? {};
        const ref = {
          executionId: labels[LABELS.executionId] ?? "",
          generation: Number(labels[LABELS.generation]),
        };
        if (ref.executionId === "" || !Number.isInteger(ref.generation)) {
          throw new NetworkIsolationError(
            network.Name,
            `names no execution; ${await this.detachProxies(network, proxyIds)}`,
          );
        }
        const container = await this.client.inspectContainer(
          containerNameFor(ref, installationId),
        );
        if (container === null) {
          await this.removeUnusedNetwork(network, proxies);
          result.removed.push(network.Name);
          continue;
        }
        await this.assertLiveNetwork(network, ref, container, proxies);
        if (sole === null) {
          // More than one to choose from: every labelled proxy comes off
          // until the installation has exactly one again. None running is
          // left as it is — a proxy that starts alone is the one to trust.
          throw new NetworkIsolationError(
            network.Name,
            contested
              ? `${noSoleProxy}; ${await this.detachProxies(network, proxyIds)}`
              : noSoleProxy,
          );
        }
        const retired = await this.detachRetiredProxies(
          network,
          new Set([...proxyIds].filter((id) => id !== sole?.Id)),
        );
        if ((await this.attachProxy(network, sole)) || retired) {
          result.repaired.push(network.Name);
        }
      } catch (error) {
        result.failed.push({ error: messageOf(error), id: listed.Name });
      }
    }
    return result;
  }

  /**
   * What `reconcileNetworks` requires of a network whose container exists.
   * Only a stale worker may be off it — an old-contract container whose
   * replacement had its network made ready ahead of the teardown. The
   * verdict comes from labels, which a container cannot change after create.
   */
  private async assertLiveNetwork(
    network: NetworkInspect,
    ref: ExecutionRef,
    container: ContainerInspect,
    proxies: ContainerSummary[],
  ): Promise<void> {
    const labels = container.Config.Labels ?? {};
    const proxyIds = new Set(proxies.map((proxy) => proxy.Id));
    const strangers = strangersIn(
      await this.membersOf(network),
      new Set([container.Id, ...proxyIds]),
    );
    const joined = network.Name in (container.NetworkSettings?.Networks ?? {});
    const problem =
      workerNetworkProblem(network, ref, this.config.installationId, {
        // A contract-5 worker keeps what contract 5 gave it until it is
        // replaced or drained — including on a daemon the preflight
        // refused, where no pass runs to replace it. No operation id is
        // compared: the network never carried one, and a same-named worker
        // of another operation is refused by every launch path anyway.
        hostAddress: predatesHostIsolation(container, network)
          ? "tolerated"
          : "refused",
      }) ??
      (labels[LABELS.installation] !== this.config.installationId ||
      labels[LABELS.executionId] !== ref.executionId ||
      labels[LABELS.generation] !== String(ref.generation)
        ? `is named for ${container.Name}, which is not this installation's worker for it`
        : strangers.length > 0
          ? `has members other than its worker and the egress proxy (${strangers.join(", ")})`
          : joined || contractVerdictOf(container, this.config) === "current"
            ? onlyOnProblem(container, network)
            : null);
    if (problem !== null) {
      throw new NetworkIsolationError(
        network.Name,
        `${problem}; ${await this.detachProxies(network, proxyIds)}`,
      );
    }
  }

  /**
   * Takes labelled proxies other than the running one off a live network,
   * and answers whether there were any. One that will not come off fails
   * the network: it would serve the worker under the same alias.
   */
  private async detachRetiredProxies(
    network: NetworkInspect,
    retiredIds: Set<string>,
  ): Promise<boolean> {
    const attached = async (current: NetworkInspect) =>
      [...(await this.membersOf(current)).keys()].filter((id) =>
        retiredIds.has(id),
      );
    const before = await attached(network);
    if (before.length === 0) return false;
    for (const id of before) {
      await this.client
        .disconnectNetwork(network.Id, id)
        .catch(() => undefined);
    }
    const after = await this.client.inspectNetwork(network.Id);
    if (after !== null && (await attached(after)).length > 0) {
      throw new NetworkIsolationError(
        network.Name,
        "still has an egress proxy that is no longer the running one, and it could not be detached",
      );
    }
    return true;
  }

  /**
   * Everything attached to the network, id → name: the running endpoints
   * the inspect lists and the stopped or never-started containers it
   * leaves out, which rejoin the moment they start.
   */
  private async membersOf(
    network: NetworkInspect,
  ): Promise<Map<string, string>> {
    const members = new Map<string, string>();
    for (const [id, member] of Object.entries(network.Containers ?? {})) {
      members.set(id, member.Name);
    }
    for (const container of await this.client.listContainersOn(network)) {
      members.set(
        container.Id,
        container.Names[0]?.replace(/^\//, "") ?? container.Id,
      );
    }
    return members;
  }

  /**
   * Takes this installation's proxies off a network that is being left for
   * someone to look at, and says whether that held. Checked afterwards,
   * since a disconnect's status code says nothing reliable.
   */
  private async detachProxies(
    network: NetworkInspect,
    proxyIds: Set<string>,
  ): Promise<string> {
    const attached = async (current: NetworkInspect) =>
      [...(await this.membersOf(current)).keys()].filter((id) =>
        proxyIds.has(id),
      );
    for (const id of await attached(network)) {
      await this.client
        .disconnectNetwork(network.Id, id)
        .catch(() => undefined);
    }
    const after = await this.client.inspectNetwork(network.Id);
    const left = after === null ? [] : await attached(after);
    return left.length === 0
      ? "the egress proxy was detached and the network left in place"
      : "the egress proxy could NOT be detached; the network still reaches the allowlist";
  }

  /**
   * The container already under this launch's name, once it is known to be
   * this launch's — the one member besides the proxy a worker
   * network may have. Refuses a container that is not, before anything is
   * attached to the network it sits on.
   */
  private async launchedContainer(
    intent: LaunchIntent,
  ): Promise<ContainerInspect | null> {
    const existing = await this.client.inspectContainer(
      containerNameFor(intent, this.config.installationId),
    );
    if (existing === null) return null;
    if (contractVerdictOf(existing, this.config) === "newer") {
      throw new IsolationContractError(
        intent,
        existing.Config.Labels?.[LABELS.isolation] ?? "<none>",
      );
    }
    this.assertSameLaunch(intent, existing);
    return existing;
  }

  /**
   * The one running container labelled as this installation's egress proxy.
   * Asked of the daemon every time rather than remembered: a proxy recreated
   * under a running control host has a new id, and attaching the old one
   * would fail anyway.
   */
  private async egressProxy(): Promise<ContainerSummary> {
    return soleRunningProxy(
      await this.client.listContainers([
        `${LABELS.egressProxy}=${this.config.installationId}`,
      ]),
      this.config,
    );
  }

  /**
   * The execution's own network, created if it is not there yet and checked
   * either way, with the egress proxy on it under the name the worker
   * dials. Answers with the network as the daemon holds it; the container is
   * created against its id, so a network recreated under the same name in
   * between cannot stand in for it.
   *
   * A network from before contract 6 cannot be given the gateway mode in
   * place. With no worker left on it, it is removed and made again. With
   * this launch's contract-5 worker still on it, it is kept only for a
   * `replacing` caller, whose teardown takes it along with that worker;
   * anyone else is refused.
   */
  private async ensureWorkerNetwork(
    intent: LaunchIntent,
    proxy: ContainerSummary,
    worker: ContainerInspect | null,
    { replacing = false }: { replacing?: boolean } = {},
  ): Promise<NetworkInspect> {
    const { installationId } = this.config;
    const name = networkNameFor(intent, installationId);
    let network = await this.client.inspectNetwork(name);
    if (
      network !== null &&
      worker === null &&
      workerNetworkProblem(network, intent, installationId, {
        hostAddress: "tolerated",
      }) === null &&
      hostAddressProblem(network) !== null
    ) {
      // Left behind by a teardown whose removal did not hold. Anything but
      // the proxy still on it makes this refuse, as it would anywhere else.
      await this.removeUnusedNetwork(
        network,
        await this.client.listContainers([
          `${LABELS.egressProxy}=${installationId}`,
        ]),
      );
      network = null;
    }
    if (network === null) {
      try {
        await this.client.createNetwork({
          Driver: "bridge",
          // Explicit: a daemon configured for IPv6 by default would otherwise
          // give the network a second address family nothing here checks.
          EnableIPv6: false,
          Internal: true,
          Labels: {
            [LABELS.executionId]: intent.executionId,
            [LABELS.generation]: String(intent.generation),
            [LABELS.installation]: installationId,
            [LABELS.sessionId]: intent.sessionId,
            [LABELS.workerNetwork]: "true",
          },
          Name: name,
          Options: { [GATEWAY_MODE_OPTION]: GATEWAY_MODE },
        });
      } catch (error) {
        // Lost a create race; the winner is judged below like any network
        // that was already there.
        if (!(error instanceof DockerApiError) || error.status !== 409) {
          throw error;
        }
      }
      network = await this.client.inspectNetwork(name);
      if (network === null) {
        throw new NetworkIsolationError(name, "vanished as it was created");
      }
    }
    const problem = workerNetworkProblem(network, intent, installationId, {
      hostAddress:
        replacing && worker !== null && predatesHostIsolation(worker, network)
          ? "tolerated"
          : "refused",
    });
    if (problem !== null) throw new NetworkIsolationError(name, problem);
    // By id, not by name: a container under the worker's name that is not
    // this launch's was already refused by `launchedContainer`.
    const strangers = strangersIn(
      await this.membersOf(network),
      new Set(worker === null ? [proxy.Id] : [proxy.Id, worker.Id]),
    );
    if (strangers.length > 0) {
      throw new NetworkIsolationError(
        name,
        `has members other than its worker and the egress proxy (${strangers.join(", ")})`,
      );
    }
    await this.attachProxy(network, proxy);
    return network;
  }

  /**
   * Puts the proxy on the network under the alias the worker's `HTTP_PROXY`
   * names, and answers whether anything had to change. Judged by what the
   * proxy container reports afterwards, not by the status code: an attach
   * that already exists answers 403, and one made without the alias answers
   * nothing at all but leaves the worker unable to resolve the proxy.
   */
  private async attachProxy(
    network: NetworkInspect,
    proxy: ContainerSummary,
  ): Promise<boolean> {
    const alias = new URL(this.config.egressProxyUrl).hostname;
    const attachment = async (): Promise<"absent" | "ready" | "unaliased"> => {
      const inspected = await this.client.inspectContainer(proxy.Id);
      const endpoint = inspected?.NetworkSettings?.Networks?.[network.Name];
      if (!endpoint) return "absent";
      return endpoint.Aliases?.includes(alias) ? "ready" : "unaliased";
    };
    const before = await attachment();
    if (before === "ready") return false;
    if (before === "unaliased") {
      await this.client
        .disconnectNetwork(network.Id, proxy.Id)
        .catch(() => undefined);
    }
    try {
      await this.client.connectNetwork(network.Id, proxy.Id, [alias]);
    } catch (error) {
      if (!(error instanceof DockerApiError) || error.status !== 403) {
        throw error;
      }
    }
    if ((await attachment()) !== "ready") {
      throw new NetworkIsolationError(
        network.Name,
        `could not be given the egress proxy under the name ${alias}`,
      );
    }
    return true;
  }

  /** `terminate`'s half of the cleanup; see `removeUnusedNetwork`. */
  private async removeWorkerNetwork(ref: ExecutionRef): Promise<void> {
    const { installationId } = this.config;
    const network = await this.client.inspectNetwork(
      networkNameFor(ref, installationId),
    );
    if (network === null) return;
    const labels = network.Labels ?? {};
    if (
      labels[LABELS.workerNetwork] !== "true" ||
      labels[LABELS.installation] !== installationId
    ) {
      return;
    }
    await this.removeUnusedNetwork(
      network,
      await this.client.listContainers([
        `${LABELS.egressProxy}=${installationId}`,
      ]),
    );
  }

  /**
   * Detaches the proxy and removes the network, by id, when the proxy is all
   * that is left on it. Anything else still attached stays where it is —
   * forcing a stranger off would hide it — but the proxy comes off, so what
   * is left behind cannot use this installation's allowlist. A removal the
   * daemon refuses because something joined in between (403) is reported
   * as it is; nothing is put back for a member nobody vouched for.
   */
  private async removeUnusedNetwork(
    network: NetworkInspect,
    proxies: ContainerSummary[],
  ): Promise<void> {
    const proxyIds = new Set(proxies.map((proxy) => proxy.Id));
    const strangers = strangersIn(await this.membersOf(network), proxyIds);
    if (strangers.length > 0) {
      throw new NetworkIsolationError(
        network.Name,
        `still has members other than the egress proxy (${strangers.join(", ")}); ${await this.detachProxies(network, proxyIds)}`,
      );
    }
    await this.detachProxies(network, proxyIds);
    await this.client.removeNetwork(network.Id);
  }

  /**
   * The per-session workspace, created explicitly so it can carry both a
   * quota and the labels GC judges by.
   *
   * `POST /volumes/create` is not a create-or-fail: a name that already
   * exists comes back 201 with the *existing* volume, its original driver
   * options and labels intact and the ones just asked for silently dropped.
   * So the reply is the thing to check, not the status code.
   */
  private async ensureWorkspaceVolume(sessionId: string): Promise<string> {
    const { config } = this;
    const quota = config.workspaceQuota;
    const stamp = quotaStampOf(quota);
    // The session's own workspace, if it has one: resume must come back to
    // the tree it left, and only the labels say which volume that is.
    const existing = await this.findWorkspaceVolume(sessionId);
    if (existing !== null) {
      const problem = workspaceVolumeProblem(existing, sessionId, config);
      if (problem !== null)
        throw new WorkspaceQuotaError(existing.Name, problem);
      // A volume from before the inode ceiling gets it here, and one whose
      // project id the daemon handed out again after a restart gets it back.
      await this.requireInodeLimit(existing.Name);
      this.replacementWorkspaces.delete(sessionId);
      return existing.Name;
    }
    const promised = this.replacementWorkspaces.get(sessionId);
    if (promised !== undefined) {
      // Between the teardown and here, the workspace this replacement was
      // approved against stopped existing. A new one would look like a
      // successful launch and read as a session that lost its work.
      throw new WorkspaceQuotaError(
        promised,
        "the workspace this replacement was checked against is gone; a new one would start the session on an empty tree",
      );
    }
    const name = `${workspaceVolumePrefixFor(sessionId, config)}${crypto.randomUUID().slice(0, 8)}`;
    const keys = volumeLabelsOf(config);
    let volume: VolumeInspect;
    try {
      volume = await this.client.createVolume({
        Driver: "local",
        ...(quota.mode === "enforced"
          ? { DriverOpts: { size: String(quota.sizeBytes) } }
          : {}),
        Labels: {
          [keys.installation]: config.installationId,
          [keys.managed]: "true",
          [keys.sessionId]: sessionId,
          [keys.workspaceQuota]: stamp,
        },
        Name: name,
      });
    } catch (error) {
      // Preflight should have caught this; a daemon can lose the capability
      // under a running control host, so the launch has to fail too.
      if (isQuotaUnsupported(error)) {
        throw new WorkspaceQuotaUnsupportedError(messageOf(error));
      }
      throw error;
    }
    const problem = workspaceVolumeProblem(volume, sessionId, config);
    if (problem !== null) throw new WorkspaceQuotaError(name, problem);
    await this.requireInodeLimit(name);
    return name;
  }

  /**
   * Sets the workspace's inode ceiling, or says why it could not. On every
   * launch rather than once per volume: the limit lives in the filesystem,
   * not on anything Docker reports, so there is nothing cheaper to check it
   * against, and setting it again is idempotent.
   */
  async requireInodeLimit(volume: string): Promise<void> {
    const quota = this.config.workspaceQuota;
    if (quota.mode === "off") return;
    const problem = await this.applyInodeLimit(
      volume,
      quota,
      await this.inodeHelperImage(quota),
    );
    if (problem !== null) {
      throw new WorkspaceQuotaError(volume, `has no inode limit: ${problem}`);
    }
  }

  /** The helper's vetted image id, with old helpers cleared off the daemon. */
  private async inodeHelperImage(
    quota: Extract<WorkspaceQuota, { mode: "enforced" }>,
  ): Promise<string> {
    const image = await this.inspectedImage(quota.helperImage);
    await removeStrayInodeHelpers(this.client, this.config.installationId);
    return image;
  }

  private applyInodeLimit(
    volume: string,
    quota: Extract<WorkspaceQuota, { mode: "enforced" }>,
    image: string,
  ): Promise<string | null> {
    return applyInodeLimit(this.client, {
      image,
      inodes: quota.inodes,
      installationId: this.config.installationId,
      timeoutMs: this.config.requestTimeoutMs,
      volume,
      workspaceDir: this.config.workspaceDir,
    });
  }

  /**
   * The workspace half of `assertReplaceable`. Answers with the volume the
   * replacement must come back to, or null when the session has none and
   * the replacement is free to make one.
   *
   * It sets the inode ceiling too, rather than only reading labels: whether
   * the volume can carry one is only answered by setting it, and a volume
   * that cannot must fail here, while the old worker still runs, not in the
   * `ensureExecution` that follows its teardown. Setting it is idempotent,
   * and the launch sets it again.
   */
  private async assertWorkspaceReplaceable(
    sessionId: string,
  ): Promise<string | null> {
    const volume = await this.findWorkspaceVolume(sessionId);
    if (volume === null) return null;
    const problem = workspaceVolumeProblem(volume, sessionId, this.config);
    if (problem !== null) throw new WorkspaceQuotaError(volume.Name, problem);
    await this.requireInodeLimit(volume.Name);
    return volume.Name;
  }

  /**
   * This session's workspace volume, by the labels that name it. Two of them
   * is not a case to pick a winner in: each may hold a different half of the
   * session's work, and mounting one would bury the other. Reported instead,
   * which leaves both on disk for an operator to compare.
   */
  private async findWorkspaceVolume(
    sessionId: string,
  ): Promise<VolumeInspect | null> {
    const keys = volumeLabelsOf(this.config);
    const [found, legacy] = await Promise.all([
      this.client.listVolumes([
        `${keys.managed}=true`,
        `${keys.installation}=${this.config.installationId}`,
        `${keys.sessionId}=${sessionId}`,
      ]),
      // Before names became single-use, a workspace was whatever sat under
      // the session's derived name — including the unlabelled volume Docker
      // conjures out of a mount spec. Those are still looked for, because
      // creating a fresh one beside such a volume would hand the session an
      // empty tree and bury the one it had. What is wrong with it is left to
      // `workspaceVolumeProblem`, which rejects it for the ceiling it cannot
      // prove; `migrateWorkspace` is what moves it.
      this.client.inspectVolume(
        legacyWorkspaceVolumeName(sessionId, this.config),
      ),
    ]);
    if (found.length === 0) return legacy;
    if (legacy !== null && legacySessionOf(legacy, this.config) === sessionId) {
      // A labelled workspace beside the legacy one is a migration that has
      // not removed its source yet, so the copy is not known to be whole.
      throw new WorkspaceQuotaError(
        [legacy.Name, ...found.map((volume) => volume.Name)].sort().join(", "),
        `session ${sessionId} has a legacy workspace beside a labelled one; ` +
          "finish the migration (bun run migrate-workspace) before it can launch",
      );
    }
    if (found.length > 1) {
      // Reported, not resolved: choosing between two workspaces needs to
      // know which one a worker actually wrote to, which nothing here can
      // tell. Worth resolving if a launch race is ever seen to produce it.
      throw new WorkspaceQuotaError(
        found
          .map((volume) => volume.Name)
          .sort()
          .join(", "),
        `session ${sessionId} has ${found.length} workspace volumes; only one can be mounted`,
      );
    }
    return found[0] ?? null;
  }

  /**
   * The image to launch, named by its id, once it is known to declare no
   * volumes of its own. The read-only rootfs and the bounded mounts are the
   * whole of what a worker may write to — unless its image declares a
   * `VOLUME`, which Docker honours by attaching a writable anonymous volume
   * outside all of it. An image the daemon does not have is refused rather
   * than passed through: a pull landing between that 404 and the create
   * would launch an image nothing has looked at, and nothing else in the
   * launch would notice the anonymous volume it brought. Nothing here pulls,
   * so a missing image could not have launched anyway.
   */
  private async inspectedImage(reference: string): Promise<string> {
    let inspected: ImageInspect | null;
    try {
      inspected = await this.client.inspectImage(reference);
    } catch (error) {
      if (error instanceof DockerApiError && error.status === 404) {
        inspected = null;
      } else {
        throw error;
      }
    }
    if (inspected === null) {
      throw new Error(
        `Image ${reference} is not on this daemon; it cannot be inspected for declared volumes`,
      );
    }
    const declared = Object.keys(inspected.Config.Volumes ?? {});
    // The workspace path is ours; the image declaring it changes nothing,
    // because the mount spec names a volume for exactly that target.
    const extra = declared.filter((path) => path !== this.config.workspaceDir);
    if (extra.length > 0) throw new ImageVolumeError(reference, extra.sort());
    // The id is what a launch is pinned to; a reference passed through in
    // its place would be the mutable tag the pin exists to replace.
    if (!inspected.Id) {
      throw new Error(`Image ${reference} was inspected but carries no id`);
    }
    return inspected.Id;
  }

  /**
   * The workspace this container was created against is still the bounded one
   * it was checked as. Between the check and the create, a `docker volume
   * prune` removes it and the create silently conjures a replacement with no
   * labels and no ceiling; the container is removed rather than started.
   */
  private async assertWorkspaceStillBounded(
    container: string,
    sessionId: string,
    name: string,
  ): Promise<void> {
    const volume = await this.client.inspectVolume(name);
    const problem =
      volume === null
        ? "disappeared between the check and the container"
        : workspaceVolumeProblem(volume, sessionId, this.config);
    if (problem === null) return;
    await this.client
      .stopAndRemoveContainer(container, this.config.stopTimeoutSeconds)
      .catch(() => undefined);
    throw new WorkspaceQuotaError(name, problem);
  }

  /**
   * What is wrong with the workspace this container holds, or null. A
   * container's mounts are fixed when it is created, so this is the only way
   * to learn which volume it will write to: the name it was created against
   * may carry a different volume by now, or none at all.
   */
  private async mountedWorkspaceProblem(
    intent: LaunchIntent,
    container: ContainerInspect,
  ): Promise<{ name: string; reason: string } | null> {
    const mounted = container.Mounts.find(
      (mount) => mount.Destination === this.config.workspaceDir,
    );
    const name = mounted?.Name;
    if (name === undefined || name === "") {
      return {
        name: container.Name,
        reason: `nothing is mounted at ${this.config.workspaceDir}`,
      };
    }
    const volume = await this.client.inspectVolume(name);
    if (volume === null) {
      return { name, reason: "the container's workspace volume is gone" };
    }
    const reason = workspaceVolumeProblem(
      volume,
      intent.sessionId,
      this.config,
    );
    return reason === null ? null : { name, reason };
  }

  /** The container under this name has to be this very launch, or hands off. */
  private assertSameLaunch(
    intent: LaunchIntent,
    container: ContainerInspect,
  ): void {
    const operationId = container.Config.Labels?.[LABELS.operationId];
    const owner = container.Config.Labels?.[LABELS.installation];
    if (
      operationId !== intent.operationId ||
      owner !== this.config.installationId
    ) {
      throw new ExecutionConflictError(intent, intent.operationId, operationId);
    }
  }

  private assertOwned(ref: ExecutionRef, container: ContainerInspect): void {
    const labels = container.Config.Labels ?? {};
    if (
      labels[LABELS.installation] !== this.config.installationId ||
      labels[LABELS.executionId] !== ref.executionId ||
      Number(labels[LABELS.generation]) !== ref.generation
    ) {
      throw new ExecutionConflictError(
        ref,
        `${this.config.installationId}/${ref.executionId}/g${ref.generation}`,
        `${labels[LABELS.installation]}/${labels[LABELS.executionId]}/g${labels[LABELS.generation]}`,
      );
    }
  }

  /**
   * Whether the credential this container was created with is the one the
   * registry accepts for the launch right now. Judged by label against the
   * registry, never by reading the env. There is no window to lose on a
   * mismatch: a label that differs from the registry names a nonce that can
   * never claim, and once a worker has claimed the registry says so and the
   * label stops mattering. A registry with no credential to accept —
   * never issued, or revoked — accepts nothing, so nothing matches it.
   *
   * A container with no label predates the label. It cannot be judged, and
   * replacing it on that alone would race a worker that may be claiming
   * with a perfectly good nonce, so it is adopted the way it always was and
   * left to the expiry path if its credential is in fact wrong.
   */
  private async holdsAcceptedCredential(
    intent: LaunchIntent,
    container: ContainerInspect,
  ): Promise<boolean> {
    const held = credentialFingerprintOf(container);
    if (held === null) return true;
    const accepted = await intent.bootstrapCredentialState();
    if (accepted.claimed) return true;
    return accepted.fingerprint !== null && held === accepted.fingerprint;
  }

  private async adopt(
    intent: LaunchIntent,
    container: ContainerInspect,
  ): Promise<EnsureExecutionResult> {
    let state = stateOf(container.State.Status);
    if (state === "pending") {
      // Created and never started, which is also what a create leaves behind
      // when its workspace turned out to be unbounded and the cleanup that
      // should have removed the container did not manage it. Starting it on
      // the strength of its labels would put a worker on exactly that volume,
      // so what it holds is read from the container — the volume this call
      // ensured is a different one by then — and a bad answer takes the
      // container away instead of starting it.
      const problem = await this.mountedWorkspaceProblem(intent, container);
      if (problem !== null) {
        await this.client.stopAndRemoveContainer(
          container.Id,
          this.config.stopTimeoutSeconds,
        );
        throw new WorkspaceQuotaError(problem.name, problem.reason);
      }
      state = await outcomeUnknownOnTimeout(intent, async () => {
        await this.startOrDiscard(container.Id);
        const started = await this.client.inspectContainer(container.Id);
        return started ? stateOf(started.State.Status) : state;
      });
    }
    return { created: false, providerRef: container.Id, state };
  }

  /**
   * Starts a container nothing has run in yet. A start the daemon answered
   * with a refusal — an OCI runtime error, a mount it cannot make — leaves a
   * `created` container that every retry would adopt and be refused on the
   * same way, so it is removed, by id, and the next attempt creates afresh
   * . A start whose answer never came may have taken: that
   * container is left in place, and the caller's timeout surfaces as
   * `LaunchOutcomeUnknownError`, which the scheduler does not count as a
   * failure — the next pass inspects it and adopts or starts it.
   * A dropped connection is still a counted failure.
   */
  private async startOrDiscard(containerId: string): Promise<void> {
    try {
      await this.client.startContainer(containerId);
    } catch (error) {
      if (error instanceof DockerApiError) {
        error.message += await this.client
          .stopAndRemoveContainer(containerId, this.config.stopTimeoutSeconds)
          .then(
            () => "; the created container was removed",
            (cause: unknown) =>
              `; the created container could not be removed (${messageOf(cause)})`,
          );
      }
      throw error;
    }
  }

  private async createBody(
    intent: LaunchIntent,
    image: string,
    workspace: string,
    network: string,
  ): Promise<ContainerCreateBody> {
    const { config } = this;
    // Docker reads 0 (and for pids, -1) as "no limit"; the isolation contract
    // says every worker is bounded, so refuse anything that would drop one.
    const { cpus, memoryBytes, pidsLimit } = intent.resources;
    const nanoCpus = Math.round(cpus * 1_000_000_000);
    if (!Number.isFinite(cpus) || nanoCpus < 1) {
      throw new Error(`cpus ${cpus} rounds to no CPU limit`);
    }
    if (!Number.isInteger(memoryBytes) || memoryBytes < 1) {
      throw new Error(`memoryBytes ${memoryBytes} is not a positive limit`);
    }
    if (!Number.isInteger(pidsLimit) || pidsLimit < 1) {
      throw new Error(`pidsLimit ${pidsLimit} is not a positive limit`);
    }
    // tmpfs mounts are root-owned unless told otherwise; the worker is not
    // root, so hand both of its writable dirs to its uid/gid.
    const [uid, gid = uid] = config.user.split(":");
    const tmpfsOptions = `rw,nosuid,nodev,size=${config.tmpfsSizeBytes},uid=${uid},gid=${gid}`;
    // Last, so a limit this host refuses never costs the launch a nonce.
    const bootstrapNonce = await intent.issueBootstrapNonce();
    return {
      ...(config.command ? { Cmd: config.command } : {}),
      Env: workerEnvironmentFor(config, intent, bootstrapNonce),
      HostConfig: {
        CapDrop: ["ALL"],
        // No ExtraHosts: `host.docker.internal` would be a route to the
        // daemon host that bypasses the proxy, and on an internal network it
        // would not work anyway. The gateway is reached through the proxy.
        Memory: intent.resources.memoryBytes,
        Mounts: [
          {
            Source: workspace,
            Target: config.workspaceDir,
            Type: "volume",
          },
        ],
        NanoCpus: nanoCpus,
        NetworkMode: network,
        PidsLimit: intent.resources.pidsLimit,
        ReadonlyRootfs: true,
        RestartPolicy: { Name: "no" },
        SecurityOpt: ["no-new-privileges"],
        Tmpfs: {
          "/tmp": tmpfsOptions,
          [config.homeDir]: tmpfsOptions,
        },
      },
      Image: image,
      Labels: {
        [LABELS.bootstrapFingerprint]: launchNonceFingerprint(
          hashWorkerToken(bootstrapNonce),
        ),
        [LABELS.executionId]: intent.executionId,
        [LABELS.generation]: String(intent.generation),
        [LABELS.installation]: config.installationId,
        [LABELS.isolation]: isolationStampFor(config),
        ...(intent.launchSpec === null
          ? {}
          : { [LABELS.launchSpec]: intent.launchSpec }),
        [LABELS.managed]: "true",
        [LABELS.operationId]: intent.operationId,
        [LABELS.sessionId]: intent.sessionId,
      },
      User: config.user,
    };
  }
}

/**
 * The session a legacy workspace belongs to, read from its name, or null
 * when the volume is not one: it must sit exactly at a session's derived
 * name and carry no label that says otherwise. The name only nominates a
 * session; whether the volume may go is the database's call.
 */
export function legacySessionOf(
  volume: VolumeInspect,
  config: VolumeNaming,
): string | null {
  const { installationId } = config;
  const keys = volumeLabelsOf(config);
  const prefix = `${config.volumeNamePrefix}${installationId}-`;
  if (!volume.Name.startsWith(prefix)) return null;
  const sessionId = volume.Name.slice(prefix.length);
  if (!SESSION_UUID.test(sessionId)) return null;
  const labels = volume.Labels ?? {};
  if (labels[keys.managed] !== undefined) return null;
  const owner = labels[keys.installation];
  if (owner !== undefined && owner !== installationId) return null;
  const labelled = labels[keys.sessionId];
  if (labelled !== undefined && labelled !== sessionId) return null;
  return sessionId;
}

/**
 * What is wrong with an existing volume for `sessionId`, or null when it is
 * exactly the one this host would create. Shared by the launch path and the
 * pre-teardown check so the two can never disagree about what is acceptable.
 */
export function workspaceVolumeProblem(
  volume: VolumeInspect,
  sessionId: string,
  config: LocalDockerBackendConfig,
): string | null {
  const labels = volume.Labels ?? {};
  const keys = volumeLabelsOf(config);
  const owner = labels[keys.installation];
  const quota = config.workspaceQuota;
  const stamp = quotaStampOf(quota);
  // Only a volume that names a *different* owner is an ownership problem.
  // One that names none is the volume Docker used to conjure out of a mount
  // spec, and what is wrong with it is the missing ceiling, reported below.
  if (owner !== undefined && owner !== config.installationId) {
    return `belongs to installation ${owner}, not ${config.installationId}`;
  }
  if (labels[keys.workspaceQuota] !== stamp) {
    // Either it predates the quota (implicitly created, unlabelled and
    // unbounded) or it was created under a different ceiling.
    return (
      `was created under quota ${labels[keys.workspaceQuota] ?? "<none>"}, not ${stamp}; ` +
      "a volume's quota cannot be changed in place, so this session keeps whatever " +
      "worker it still has until the volume is retired deliberately (docker volume rm, " +
      "once its workspace is no longer needed) or the previous setting is restored"
    );
  }
  const size = volume.Options?.size;
  if (
    quota.mode === "enforced"
      ? Number(size) !== quota.sizeBytes
      : size !== undefined
  ) {
    return `carries the quota label ${stamp} but driver option size=${size ?? "<none>"}`;
  }
  // The ceiling is right, which says nothing about whose workspace this is.
  // A volume that carries the stamp but not the identity was made by hand or
  // for another session; mounting it would hand a session someone else's
  // working tree, and GC judges by these same labels, so one that is missing
  // them would never be reclaimed either.
  if (
    owner !== config.installationId ||
    labels[keys.managed] !== "true" ||
    labels[keys.sessionId] !== sessionId
  ) {
    return (
      `is not this session's workspace (managed=${labels[keys.managed] ?? "<none>"}, ` +
      `installation=${owner ?? "<none>"}, session=${labels[keys.sessionId] ?? "<none>"})`
    );
  }
  return null;
}

/**
 * What is wrong with a network under this execution's network name, or null
 * when it is exactly the one this host would create.
 */
function workerNetworkProblem(
  network: NetworkInspect,
  ref: ExecutionRef,
  installationId: string,
  { hostAddress }: { hostAddress: "refused" | "tolerated" } = {
    hostAddress: "refused",
  },
): string | null {
  const labels = network.Labels ?? {};
  const name = networkNameFor(ref, installationId);
  if (network.Name !== name) {
    return `carries this execution's labels under another name than ${name}`;
  }
  if (
    labels[LABELS.workerNetwork] !== "true" ||
    labels[LABELS.installation] !== installationId ||
    labels[LABELS.executionId] !== ref.executionId ||
    labels[LABELS.generation] !== String(ref.generation)
  ) {
    return (
      `is not this execution's (installation=${labels[LABELS.installation] ?? "<none>"}, ` +
      `execution=${labels[LABELS.executionId] ?? "<none>"}, generation=${labels[LABELS.generation] ?? "<none>"})`
    );
  }
  if (network.Driver !== "bridge")
    return `uses driver ${network.Driver}, not bridge`;
  if (!network.Internal) {
    return "is not internal; a worker on it could reach the host and the LAN directly";
  }
  if (network.EnableIPv6 === true) {
    return "has IPv6 enabled, an address family this host does not check";
  }
  return hostAddress === "refused" ? hostAddressProblem(network) : null;
}

/**
 * A contract-5 worker on the network it was created on — the one worker a
 * network that gives the host an address is left standing for, until it is
 * replaced or drained and the network goes with it. Only contract 5: an
 * older worker sits on the shared network, which is handled apart.
 */
function predatesHostIsolation(
  container: ContainerInspect,
  network: NetworkInspect,
): boolean {
  const stamp = container.Config.Labels?.[LABELS.isolation];
  const version = Number(stamp?.split(":")[0]);
  if (
    !Number.isInteger(version) ||
    version < PER_EXECUTION_NETWORK_CONTRACT ||
    version >= HOST_ISOLATED_NETWORK_CONTRACT
  ) {
    return false;
  }
  const endpoint = container.NetworkSettings?.Networks?.[network.Name];
  if (endpoint === undefined) return false;
  if (endpoint.NetworkID === network.Id) return true;
  // A container that never started records its network by name only; it
  // runs nothing, so the name is enough. One that ran carries the id, and
  // without this network's id it is on some other network of that name.
  return (
    (endpoint.NetworkID === undefined || endpoint.NetworkID === "") &&
    container.State.Status === "created"
  );
}

/**
 * Whether the host holds an address on the network. Both halves are asked:
 * the option is what was requested, and a daemon that does not know it
 * records it anyway; the missing gateway is what took effect.
 */
function hostAddressProblem(network: NetworkInspect): string | null {
  const mode = network.Options?.[GATEWAY_MODE_OPTION];
  const gateways = (network.IPAM?.Config ?? [])
    .map((entry) => entry.Gateway ?? "")
    .filter((gateway) => gateway !== "");
  if (mode !== GATEWAY_MODE || gateways.length > 0) {
    return (
      `gives the host an address on it (${GATEWAY_MODE_OPTION}=${mode ?? "<unset>"}, ` +
      `gateway ${gateways.join(", ") || "<none>"}); a worker on it reaches host processes on that address or a wildcard`
    );
  }
  return null;
}

/**
 * A container of this launch that is attached anywhere but its own network
 * — another network besides, or a network of the same name that has since
 * been recreated — reaches what that network reaches. It is never adopted.
 */
function assertOnlyOn(
  container: ContainerInspect,
  network: NetworkInspect,
): void {
  const problem = onlyOnProblem(container, network);
  if (problem !== null) {
    throw new NetworkIsolationError(
      network.Name,
      `${problem}; the container is not adopted`,
    );
  }
}

function onlyOnProblem(
  container: ContainerInspect,
  network: NetworkInspect,
): string | null {
  const attached = Object.entries(container.NetworkSettings?.Networks ?? {});
  const [only] = attached;
  if (
    attached.length === 1 &&
    only !== undefined &&
    only[0] === network.Name &&
    (only[1].NetworkID === undefined ||
      only[1].NetworkID === "" ||
      only[1].NetworkID === network.Id)
  ) {
    return null;
  }
  return `is not the only network ${container.Name} is attached to (${
    attached
      .map(([name]) => name)
      .sort()
      .join(", ") || "none"
  })`;
}

/** Members outside `allowed`, by name, sorted for a stable message. */
function strangersIn(
  members: Map<string, string>,
  allowed: Set<string>,
): string[] {
  return [...members]
    .filter(([id]) => !allowed.has(id))
    .map(([, name]) => name)
    .sort();
}

function soleRunningProxy(
  proxies: ContainerSummary[],
  config: LocalDockerBackendConfig,
): ContainerSummary {
  const running = proxies.filter((proxy) => proxy.State === "running");
  const [only] = running;
  if (running.length === 1 && only !== undefined) return only;
  const label = `${LABELS.egressProxy}=${config.installationId}`;
  throw new Error(
    running.length === 0
      ? `No running container carries ${label}. Label this installation's egress proxy ` +
          "and start it: every worker network is given that container and no other route off it."
      : `${running.length} running containers carry ${label}; exactly one proxy serves an installation`,
  );
}

/**
 * A Docker call that may have created or started the container and got no
 * answer: whether it took is for the next pass's inspect to say.
 */
async function outcomeUnknownOnTimeout<T>(
  ref: ExecutionRef,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof DockerTimeoutError) {
      throw new LaunchOutcomeUnknownError(ref, { cause: error });
    }
    throw error;
  }
}

/**
 * A daemon error carries the daemon's whole reply in its message, and a
 * reply to a refused create can quote the request. The scheduler logs that
 * message, so the one value in the body that must never reach a log — the
 * bootstrap nonce — is blanked out of it first.
 */
function withoutSecrets(error: unknown, body: ContainerCreateBody): unknown {
  if (!(error instanceof Error)) return error;
  const secrets = body.Env.filter((entry) =>
    entry.startsWith(`${ENV.bootstrapNonce}=`),
  ).map((entry) => entry.slice(entry.indexOf("=") + 1));
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    error.message = error.message.split(secret).join("[redacted]");
    if (error instanceof DockerApiError) {
      // `body` is a readonly field in the type, not in the object.
      Object.assign(error, {
        body: error.body.split(secret).join("[redacted]"),
      });
    }
  }
  return error;
}

/**
 * The whole of what a worker container is told. Exported so the integration
 * test can hand exactly this to a probe that runs the worker's object-store
 * module. Nothing here is logged: the nonce and the secret access key live
 * in this one request body and in the daemon's own inspect output.
 */
export function workerEnvironmentFor(
  config: LocalDockerBackendConfig,
  intent: Pick<LaunchIntent, "executionId" | "generation" | "sessionId">,
  bootstrapNonce: string,
): string[] {
  const { objectStore } = config;
  return [
    `${ENV.bootstrapNonce}=${bootstrapNonce}`,
    `${ENV.executionGeneration}=${intent.generation}`,
    `${ENV.executionId}=${intent.executionId}`,
    `${ENV.gatewayUrl}=${config.gatewayUrl}`,
    `${ENV.egressCredentialUrl}=${egressCredentialUrlOf(config)}`,
    `${ENV.home}=${config.homeDir}`,
    `${ENV.workspaceDir}=${config.workspaceDir}`,
    `${ENV.workspaceMountDir}=${config.workspaceDir}`,
    `${ENV.workspaceQuotaMode}=${config.workspaceQuota.mode}`,
    ...(config.workspaceQuota.mode === "enforced"
      ? [`${ENV.workspaceQuotaBytes}=${config.workspaceQuota.sizeBytes}`]
      : []),
    `${ENV.httpProxy}=${config.egressProxyUrl}`,
    `${ENV.httpProxyLower}=${config.egressProxyUrl}`,
    `${ENV.httpsProxy}=${config.egressProxyUrl}`,
    `${ENV.httpsProxyLower}=${config.egressProxyUrl}`,
    `${ENV.noProxy}=${noProxyValueFor(config)}`,
    `${ENV.noProxyLower}=${noProxyValueFor(config)}`,
    // No object store credential or endpoint: the worker reaches its
    // objects through the proxy's object store route.
    `${ENV.objectBucket}=${objectStore.bucket}`,
    `${ENV.objectPrefix}=${sessionObjectPrefix(intent.sessionId)}`,
    `${ENV.objectRegion}=${objectStore.region}`,
    `${ENV.stopGrace}=${config.stopTimeoutSeconds}`,
    ...(config.workerLimits === undefined
      ? []
      : [
          `${ENV.maxTurnSeconds}=${config.workerLimits.maxTurnSeconds}`,
          `${ENV.providerMaxRetries}=${config.workerLimits.providerMaxRetries}`,
        ]),
    ...(config.logLevel === undefined
      ? []
      : [`${ENV.logLevel}=${config.logLevel}`]),
  ];
}

/**
 * `newer` is neither: the label says a control host we do not know built it,
 * and nothing here can tell whether its network and proxy are the ones this
 * host would demand. Both adopting it and replacing it are wrong.
 */
function contractVerdictOf(
  container: ContainerInspect,
  config: LocalDockerBackendConfig,
): "current" | "newer" | "stale" {
  const stamp = container.Config.Labels?.[LABELS.isolation];
  if (stamp === undefined) return "stale";
  const version = Number(stamp.split(":")[0]);
  if (!Number.isInteger(version) || version < 1) return "stale";
  if (version > ISOLATION_CONTRACT) return "newer";
  return stamp === isolationStampFor(config) ? "current" : "stale";
}

/** The fingerprint label, or null on a container from before the label. */
function credentialFingerprintOf(container: ContainerInspect): string | null {
  return container.Config.Labels?.[LABELS.bootstrapFingerprint] ?? null;
}

/** `"1.48"` against `[1, 48]`; anything unparsable is not at least. */
function apiAtLeast(
  version: string,
  [major, minor]: readonly [number, number],
): boolean {
  const match = /^(\d+)\.(\d+)$/.exec(version ?? "");
  if (match === null) return false;
  const found = [Number(match[1]), Number(match[2])] as const;
  return found[0] > major || (found[0] === major && found[1] >= minor);
}

/** Docker container status → the platform's execution state. */
export function stateOf(status: string): ExecutionState {
  switch (status) {
    case "created":
      return "pending";
    case "running":
    case "restarting":
      return "running";
    case "paused":
      return "suspended";
    case "removing":
      return "terminating";
    case "exited":
    case "dead":
      return "terminated";
    default:
      return "unknown";
  }
}
