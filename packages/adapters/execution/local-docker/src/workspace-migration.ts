import { messageOf } from "@werft-ai/platform";
import {
  LABELS,
  LocalDockerBackend,
  legacySessionOf,
  legacyWorkspaceVolumeName,
  quotaStampOf,
  volumeLabelsOf,
  workspaceVolumePrefixFor,
  workspaceVolumeProblem,
} from "./backend.ts";
import type { LocalDockerBackendConfig } from "./config.ts";
import {
  DockerApiError,
  DockerClient,
  type VolumeInspect,
} from "./docker-client.ts";

/**
 * On the helper container, holding the installation id: what makes a
 * leftover helper this tool's to remove. Deliberately not `managed`, so the
 * scheduler never takes it for a worker.
 */
export const MIGRATION_HELPER_LABEL = "werft.workspace-migration";

/** busybox 1.36, by the digest of its multi-arch index. */
export const DEFAULT_MIGRATION_HELPER_IMAGE =
  "busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662";

const PINNED_IMAGE = /^[^@\s]+@sha256:[0-9a-f]{64}$/;

/** Exit codes of `COPY_AND_VERIFY`, named for the error an operator reads. */
const HELPER_EXIT: Record<number, string> = {
  3: "the new workspace was not empty before the copy",
  4: "the copy failed part-way (a full quota, or a file the helper cannot recreate)",
  5: "the copy does not match the original",
};

/**
 * Runs in the helper: copy, then compare a manifest of both trees. Directory
 * sizes and times are left out — they differ between two correct copies —
 * as are xattrs and ACLs, which a workspace does not carry and busybox
 * cannot read. Everything else a worker could depend on is compared: the
 * set of paths, each one's type, mode, owner and group, symlink targets, and
 * every regular file's size, mtime and SHA-256.
 */
const COPY_AND_VERIFY = `set -u -o pipefail
[ -z "$(ls -A /copy)" ] || exit 3
cp -a /source/. /copy/ || exit 4
manifest() {
  cd "$1" || return 1
  find . -type d -print0 | sort -z | xargs -0 -r stat -c 'd|%n|%a|%u|%g' || return 1
  find . -type l -print0 | sort -z | xargs -0 -r stat -c 'l|%n|%a|%u|%g|%N' || return 1
  find . ! -type d ! -type l -print0 | sort -z | xargs -0 -r stat -c 'o|%n|%F|%a|%u|%g|%s|%Y' || return 1
  find . -type f -print0 | sort -z | xargs -0 -r sha256sum || return 1
}
manifest /source > /tmp/source || exit 5
manifest /copy > /tmp/copy || exit 5
cmp -s /tmp/source /tmp/copy || exit 5
`;

export type WorkspaceMigrationResult =
  | { outcome: "migrated"; source: string; target: string }
  /** Nothing to move: the session's workspace, if any, is already current. */
  | { outcome: "current"; workspace: string | null };

export class WorkspaceMigrationError extends Error {
  constructor(
    readonly sessionId: string,
    reason: string,
  ) {
    super(`Workspace migration for session ${sessionId}: ${reason}`);
    this.name = "WorkspaceMigrationError";
  }
}

export type MigrationPlan =
  | { kind: "current"; workspace: string | null }
  | { kind: "migrate"; source: string; leftovers: string[] }
  | { kind: "refused"; reason: string };

/**
 * What to move, judged from the volumes alone. The source is either the
 * legacy volume under the session's derived name, or the one labelled
 * workspace made under another quota. `leftovers` are copies an earlier run
 * made of that very source and did not finish: while the source exists no
 * copy of it is known to be whole, so they are discarded and made again.
 * Anything else beside the source is not ours to guess about.
 */
export function planWorkspaceMigration(input: {
  config: LocalDockerBackendConfig;
  sessionId: string;
  /** This session's labelled workspaces. */
  labelled: VolumeInspect[];
  /** Whatever sits under the session's derived name, or null. */
  derived: VolumeInspect | null;
}): MigrationPlan {
  const { config, sessionId, labelled, derived } = input;
  const keys = volumeLabelsOf(config);
  const listed = new Set(labelled.map((volume) => volume.Name));
  let source: VolumeInspect | null = null;
  if (derived !== null && !listed.has(derived.Name)) {
    if (legacySessionOf(derived, config) !== sessionId) {
      return {
        kind: "refused",
        reason: `${derived.Name} carries labels that say it is not this session's`,
      };
    }
    source = derived;
  }
  if (source === null) {
    const stale = labelled.filter(
      (volume) => workspaceVolumeProblem(volume, sessionId, config) !== null,
    );
    if (stale.length === 0) {
      if (labelled.length > 1) {
        return {
          kind: "refused",
          reason: `${names(labelled)} are all current workspaces of this session; compare them by hand`,
        };
      }
      return { kind: "current", workspace: labelled[0]?.Name ?? null };
    }
    // The migration-source label marks an unfinished copy only while its source still
    // exists; once that is gone the label is history, and a volume a past
    // migration made can itself be moved when the quota changes again.
    const present = new Set(listed);
    if (derived !== null) present.add(derived.Name);
    const sources = stale.filter((volume) => {
      const from = volume.Labels?.[keys.migratedFrom];
      return from === undefined || !present.has(from);
    });
    if (sources.length !== 1) {
      return {
        kind: "refused",
        reason: `cannot tell which of ${names(stale)} holds the session's work`,
      };
    }
    source = sources[0] ?? null;
  }
  if (source === null) return { kind: "current", workspace: null };
  const from = source.Name;
  const copies = labelled.filter(
    (volume) => volume.Labels?.[keys.migratedFrom] === from,
  );
  // A copy of an earlier volume under the same name may be the only whole
  // workspace left; the one now under that name is not what it was made from.
  const foreign = copies.filter(
    (volume) =>
      source.CreatedAt === undefined ||
      volume.Labels?.[keys.migrationSourceCreatedAt] !== source.CreatedAt,
  );
  if (foreign.length > 0) {
    return {
      kind: "refused",
      reason: `${names(foreign)} were copied from an earlier volume named ${from}, not from the one there now (created ${source.CreatedAt ?? "at an unknown time"}); compare them by hand before removing either`,
    };
  }
  const leftovers = copies;
  const strangers = labelled.filter(
    (volume) => volume.Name !== from && !leftovers.includes(volume),
  );
  if (strangers.length > 0) {
    return {
      kind: "refused",
      reason: `${names(strangers)} sit beside ${from} and were not made from it; compare them by hand`,
    };
  }
  return {
    kind: "migrate",
    leftovers: leftovers.map((volume) => volume.Name),
    source: from,
  };
}

/**
 * Moves a session's workspace onto the current quota contract: a new
 * labelled volume under the quota, a copy made and checked inside a helper
 * container, and only then the old volume removed. Nothing is renamed —
 * workspaces are found by label, so the copy simply becomes the session's
 * workspace once the source is gone.
 *
 * Until then the backend refuses to launch the session: a labelled
 * workspace beside the legacy one, or two labelled ones, is exactly what
 * `findWorkspaceVolume` will not choose between. So a run that dies at any
 * step leaves a session that cannot start on a half-made copy, and running
 * it again picks up from whatever is left.
 *
 * The caller holds the scheduler's pass lock, but losing it is only noticed
 * after the fact, and a GC pass may by then hold a listing taken before the
 * copy existed. So the source is also pinned in Docker: a never-started
 * container mounts it from before the copy is made until just before it is
 * removed, and any other removal is refused as "in use" for that whole span.
 */
export class WorkspaceMigrator {
  private readonly client: DockerClient;

  constructor(
    private readonly config: LocalDockerBackendConfig,
    client?: DockerClient,
  ) {
    this.client =
      client ??
      new DockerClient(config.dockerHost, config.apiVersion, {
        timeoutMs: config.requestTimeoutMs,
      });
  }

  async migrate(options: {
    sessionId: string;
    helperImage: string;
    /** How long the copy may run before the helper is stopped. */
    deadlineMs: number;
    /** The pass lock's: aborted once another pass may be running. */
    signal?: AbortSignal;
    pollMs?: number;
  }): Promise<WorkspaceMigrationResult> {
    const { sessionId, helperImage, signal } = options;
    const fail = (reason: string) =>
      new WorkspaceMigrationError(sessionId, reason);
    // Also what keeps the session id safe to put in a volume name.
    const prefix = workspaceVolumePrefixFor(sessionId, this.config);
    const keys = volumeLabelsOf(this.config);
    if (!PINNED_IMAGE.test(helperImage)) {
      throw fail(
        `helper image ${helperImage} must be pinned by digest (name@sha256:...), so the copy runs the tool that was reviewed`,
      );
    }
    if ((await this.client.inspectImage(helperImage)) === null) {
      throw fail(
        `helper image ${helperImage} is not on this daemon; docker pull it first`,
      );
    }
    // Named per attempt and removed by id: a run that lost its lock and
    // resumed late must not take down the pin or helper of the run after it.
    const attempt = crypto.randomUUID().slice(0, 8);
    const helper = `werft-ws-migrate-${this.config.installationId}-${sessionId}-${attempt}`;
    const pin = `werft-ws-migrate-pin-${this.config.installationId}-${sessionId}-${attempt}`;

    const [labelled, derived] = await Promise.all([
      this.client.listVolumes([
        `${keys.managed}=true`,
        `${keys.installation}=${this.config.installationId}`,
        `${keys.sessionId}=${sessionId}`,
      ]),
      this.client.inspectVolume(
        legacyWorkspaceVolumeName(sessionId, this.config),
      ),
    ]);
    const plan = planWorkspaceMigration({
      config: this.config,
      derived,
      labelled,
      sessionId,
    });
    if (plan.kind === "refused") throw fail(plan.reason);
    if (plan.kind === "current") {
      // No source is left for any attempt to pin or copy.
      for (const container of await this.toolContainers(sessionId)) {
        await this.client.stopAndRemoveContainer(container.Id, 1);
      }
      return { outcome: "current", workspace: plan.workspace };
    }
    const { source } = plan;

    // A copy of a tree something is writing to is not a copy of anything.
    // Stopped containers count too: starting one again would write to it.
    // An earlier attempt's pin or helper is set aside here and removed only
    // once this attempt's own pin holds the source. Only what was listed
    // before that pin counts as earlier: a later attempt's containers appear
    // after it, and a run that resumes late must leave them alone.
    await this.assertUnused(source, fail, sessionId);
    const earlier = await this.toolContainers(sessionId);
    const plannedCreatedAt = [...labelled, ...(derived ? [derived] : [])].find(
      (volume) => volume.Name === source,
    )?.CreatedAt;
    signal?.throwIfAborted();
    const pinId = await this.pinSource(
      pin,
      source,
      plannedCreatedAt,
      { helperImage, sessionId },
      fail,
    );
    for (const container of earlier) {
      await this.client.stopAndRemoveContainer(container.Id, 1);
    }
    for (const leftover of plan.leftovers) {
      signal?.throwIfAborted();
      await this.assertUnused(leftover, fail);
      await this.client.removeVolume(leftover);
    }

    signal?.throwIfAborted();
    const target = await this.createTarget(
      prefix,
      sessionId,
      { createdAt: plannedCreatedAt ?? "", name: source },
      fail,
    );
    // The whole ceiling before the copy, inodes included: a tree with more
    // files than a worker may hold fails the copy, as one too large does.
    try {
      await new LocalDockerBackend(this.config, this.client).requireInodeLimit(
        target,
      );
    } catch (error) {
      await this.client.removeVolume(target).catch(() => undefined);
      throw fail(`${messageOf(error)}; ${source} is untouched`);
    }

    signal?.throwIfAborted();
    await this.client.createContainer(helper, {
      Cmd: ["sh", "-c", COPY_AND_VERIFY],
      Env: [],
      HostConfig: {
        // Root, to recreate every owner the tree has, and nothing more than
        // what copying files takes.
        CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID"],
        CapDrop: ["ALL"],
        Memory: 512 * 1024 * 1024,
        Mounts: [
          {
            ReadOnly: true,
            Source: source,
            Target: "/source",
            Type: "volume",
            VolumeOptions: { NoCopy: true },
          },
          {
            Source: target,
            Target: "/copy",
            Type: "volume",
            VolumeOptions: { NoCopy: true },
          },
        ],
        NanoCpus: 1_000_000_000,
        NetworkMode: "none",
        PidsLimit: 64,
        ReadonlyRootfs: true,
        RestartPolicy: { Name: "no" },
        SecurityOpt: ["no-new-privileges"],
        Tmpfs: { "/tmp": "rw,noexec,nosuid,size=256m" },
      },
      Image: helperImage,
      Labels: {
        [MIGRATION_HELPER_LABEL]: this.config.installationId,
        [LABELS.sessionId]: sessionId,
      },
      User: "0:0",
    });
    await this.client.startContainer(helper);
    const exitCode = await this.waitForExit(helper, options, fail);
    if (exitCode !== 0) {
      // Left in place for `docker logs`; the next run removes it, and the
      // unfinished copy with it. The source is untouched.
      throw fail(
        `${HELPER_EXIT[exitCode] ?? `the helper exited ${exitCode}`}; ${source} is untouched, ` +
          `see docker logs ${helper}, then run again`,
      );
    }
    await this.client.stopAndRemoveContainer(helper, 1);

    // The copy is whole. From the moment the source goes, the copy is the
    // session's workspace; until then, launches keep refusing.
    signal?.throwIfAborted();
    const copy = await this.client.inspectVolume(target);
    if (copy === null || copy.Labels?.[keys.migratedFrom] !== source) {
      throw fail(
        `${target} disappeared after the copy; ${source} is untouched`,
      );
    }
    // A copy made by another attempt means another run is still at work on
    // this source: removing it now would leave that run copying nothing.
    const copies = await this.client.listVolumes([
      `${keys.managed}=true`,
      `${keys.installation}=${this.config.installationId}`,
      `${keys.sessionId}=${sessionId}`,
      `${keys.migratedFrom}=${source}`,
    ]);
    const others = copies.filter((volume) => volume.Name !== target);
    if (others.length > 0) {
      await this.client.removeVolume(target);
      throw fail(
        `another migration of ${source} is in progress (${names(others)}); this copy was discarded and ${source} is untouched`,
      );
    }
    await this.client.stopAndRemoveContainer(pinId, 1);
    try {
      await this.client.removeVolume(source);
    } catch (error) {
      if (error instanceof DockerApiError && error.status === 409) {
        // Another attempt's pin, or a container that mounted the source
        // since: either way this copy is not the one to keep.
        await this.client.removeVolume(target);
        throw fail(
          `${source} is held by another container after the copy; this copy was discarded and ${source} is untouched, run again once it is free`,
        );
      }
      throw error;
    }
    return { outcome: "migrated", source, target };
  }

  /** Every pin and helper this tool has for the session, as of now. */
  private toolContainers(sessionId: string) {
    return this.client.listContainers([
      `${MIGRATION_HELPER_LABEL}=${this.config.installationId}`,
      `${LABELS.sessionId}=${sessionId}`,
    ]);
  }

  /**
   * Creates, and never starts, a container mounting `source`. Docker makes a
   * missing named volume on the spot, so the source is compared with the one
   * the plan saw: a different creation time means it went (a GC pass that
   * outran a lost lock) and what is pinned now is an empty stand-in.
   */
  private async pinSource(
    pin: string,
    source: string,
    plannedCreatedAt: string | undefined,
    owner: { helperImage: string; sessionId: string },
    fail: (reason: string) => WorkspaceMigrationError,
  ): Promise<string> {
    const { Id } = await this.client.createContainer(pin, {
      Cmd: ["true"],
      Env: [],
      HostConfig: {
        CapDrop: ["ALL"],
        Memory: 16 * 1024 * 1024,
        Mounts: [
          {
            ReadOnly: true,
            Source: source,
            Target: "/pinned",
            Type: "volume",
            VolumeOptions: { NoCopy: true },
          },
        ],
        NanoCpus: 100_000_000,
        NetworkMode: "none",
        PidsLimit: 1,
        ReadonlyRootfs: true,
        RestartPolicy: { Name: "no" },
        SecurityOpt: ["no-new-privileges"],
        Tmpfs: {},
      },
      Image: owner.helperImage,
      Labels: {
        [MIGRATION_HELPER_LABEL]: this.config.installationId,
        [LABELS.sessionId]: owner.sessionId,
      },
      User: "65534:65534",
    });
    const pinned = await this.client.inspectVolume(source);
    if (
      plannedCreatedAt === undefined ||
      pinned?.CreatedAt !== plannedCreatedAt
    ) {
      await this.client.stopAndRemoveContainer(Id, 1);
      throw fail(
        `${source} was removed and recreated empty while this run started; nothing was copied. Another run may have finished the migration: check the session's workspaces, and remove the empty ${source} by hand (docker volume rm) once you are sure`,
      );
    }
    return Id;
  }

  /** `ownSession`: this tool's containers for that session do not count. */
  private async assertUnused(
    volume: string,
    fail: (reason: string) => WorkspaceMigrationError,
    ownSession?: string,
  ): Promise<void> {
    const users = (await this.client.listContainersUsingVolume(volume)).filter(
      (container) =>
        ownSession === undefined ||
        container.Labels?.[MIGRATION_HELPER_LABEL] !==
          this.config.installationId ||
        container.Labels?.[LABELS.sessionId] !== ownSession,
    );
    if (users.length > 0) {
      const which = users
        .map(
          (container) => container.Names[0]?.replace(/^\//, "") ?? container.Id,
        )
        .sort()
        .join(", ");
      throw fail(
        `${volume} is mounted by ${which}; stop and remove the container first (docker rm), then run again`,
      );
    }
  }

  private async createTarget(
    prefix: string,
    sessionId: string,
    source: { name: string; createdAt: string },
    fail: (reason: string) => WorkspaceMigrationError,
  ): Promise<string> {
    const { config } = this;
    const keys = volumeLabelsOf(config);
    const quota = config.workspaceQuota;
    const name = `${prefix}${crypto.randomUUID().slice(0, 8)}`;
    const volume = await this.client.createVolume({
      Driver: "local",
      ...(quota.mode === "enforced"
        ? { DriverOpts: { size: String(quota.sizeBytes) } }
        : {}),
      Labels: {
        [keys.installation]: config.installationId,
        [keys.managed]: "true",
        [keys.migratedFrom]: source.name,
        [keys.migrationSourceCreatedAt]: source.createdAt,
        [keys.sessionId]: sessionId,
        [keys.workspaceQuota]: quotaStampOf(quota),
      },
      Name: name,
    });
    // `POST /volumes/create` answers an existing name with that volume as it
    // is, so the reply is what shows whether this one was made here.
    const problem = workspaceVolumeProblem(volume, sessionId, config);
    if (
      problem !== null ||
      volume.Labels?.[keys.migratedFrom] !== source.name ||
      volume.Labels?.[keys.migrationSourceCreatedAt] !== source.createdAt
    ) {
      throw fail(
        `${name} is not the copy this run asked for: ${problem ?? "labels differ"}`,
      );
    }
    return name;
  }

  private async waitForExit(
    helper: string,
    options: { deadlineMs: number; signal?: AbortSignal; pollMs?: number },
    fail: (reason: string) => WorkspaceMigrationError,
  ): Promise<number> {
    const deadline = Date.now() + options.deadlineMs;
    const pollMs = options.pollMs ?? 1_000;
    for (;;) {
      const inspected = await this.client.inspectContainer(helper);
      if (inspected === null) throw fail(`helper ${helper} disappeared`);
      if (!inspected.State.Running && inspected.State.Status !== "created") {
        return inspected.State.ExitCode;
      }
      if (options.signal?.aborted || Date.now() >= deadline) {
        await this.client.stopAndRemoveContainer(helper, 1);
        throw fail(
          options.signal?.aborted
            ? "the scheduler pass lock was lost during the copy; nothing was removed, run again"
            : `the copy did not finish within ${options.deadlineMs}ms; nothing was removed, run again with a longer deadline`,
        );
      }
      await Bun.sleep(pollMs);
    }
  }
}

function names(volumes: VolumeInspect[]): string {
  return volumes
    .map((volume) => volume.Name)
    .sort()
    .join(", ");
}
