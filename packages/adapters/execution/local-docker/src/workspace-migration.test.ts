import { describe, expect, test } from "bun:test";
import { LABELS, volumeLabelsOf } from "./backend.ts";
import type { LocalDockerBackendConfig } from "./config.ts";
import type { DockerClient, VolumeInspect } from "./docker-client.ts";
import {
  DEFAULT_MIGRATION_HELPER_IMAGE,
  planWorkspaceMigration,
  WorkspaceMigrator,
} from "./workspace-migration.ts";

const SESSION = "0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9";
const QUOTA = 64 * 1024 * 1024;
const config = {
  installationId: "inst",
  volumeLabelNamespace: "werft",
  volumeNamePrefix: "werft-ws-",
  workspaceQuota: { mode: "enforced", sizeBytes: QUOTA },
} as LocalDockerBackendConfig;
const VOLUME_LABELS = volumeLabelsOf(config);
/** A volume a finished migration removed. */
const GONE = `werft-ws-inst-${SESSION}-gone0000`;
const CREATED = "2026-01-01T00:00:00Z";

function volume(
  name: string,
  labels: Record<string, string> = {},
  options: Record<string, string> | null = null,
): VolumeInspect {
  return {
    CreatedAt: CREATED,
    Driver: "local",
    Labels: Object.keys(labels).length === 0 ? null : labels,
    Mountpoint: `/var/lib/docker/volumes/${name}/_data`,
    Name: name,
    Options: options,
  };
}

function labelled(
  suffix: string,
  stamp: string,
  extra: Record<string, string> = {},
): VolumeInspect {
  return volume(
    `werft-ws-inst-${SESSION}-${suffix}`,
    {
      [LABELS.installation]: "inst",
      [LABELS.managed]: "true",
      [LABELS.sessionId]: SESSION,
      [VOLUME_LABELS.workspaceQuota]: stamp,
      ...extra,
    },
    stamp.startsWith("enforced:") ? { size: stamp.slice(9) } : null,
  );
}

const plan = (labelledVolumes: VolumeInspect[]) =>
  planWorkspaceMigration({
    config,
    labelled: labelledVolumes,
    sessionId: SESSION,
  });
const OLD = labelled("aaaa0003", "off");

describe("planWorkspaceMigration", () => {
  test("a copy an earlier run made of that source is a leftover to redo", () => {
    const copy = labelled("aaaa0001", `enforced:${QUOTA}`, {
      [VOLUME_LABELS.migratedFrom]: OLD.Name,
      [VOLUME_LABELS.migrationSourceCreatedAt]: CREATED,
    });
    expect(plan([OLD, copy])).toEqual({
      kind: "migrate",
      leftovers: [copy.Name],
      source: OLD.Name,
    });
  });

  test("a copy of an earlier volume under the source's name is refused, not discarded", () => {
    const copy = labelled("aaaa0010", `enforced:${QUOTA}`, {
      [VOLUME_LABELS.migratedFrom]: OLD.Name,
      [VOLUME_LABELS.migrationSourceCreatedAt]: CREATED,
    });
    const recreated = { ...OLD, CreatedAt: "2026-09-23T00:00:00Z" };
    expect(plan([recreated, copy])).toEqual({
      kind: "refused",
      reason: expect.stringContaining("not from the one there now"),
    });
    // Nor is a copy that does not say which one it came from.
    const unmarked = labelled("aaaa0011", `enforced:${QUOTA}`, {
      [VOLUME_LABELS.migratedFrom]: OLD.Name,
    });
    expect(plan([OLD, unmarked])).toMatchObject({ kind: "refused" });
  });

  test("a workspace beside the source that is not its copy is refused", () => {
    const other = labelled("aaaa0002", `enforced:${QUOTA}`);
    expect(plan([OLD, other])).toMatchObject({ kind: "refused" });
  });

  test("a labelled workspace under another quota is the source", () => {
    const old = labelled("aaaa0003", "off");
    expect(plan([old])).toEqual({
      kind: "migrate",
      leftovers: [],
      source: old.Name,
    });
  });

  test("with its unfinished copy beside it, the old-quota one is still the source", () => {
    const old = labelled("aaaa0003", "off");
    const copy = labelled("aaaa0004", `enforced:${QUOTA}`, {
      [VOLUME_LABELS.migratedFrom]: old.Name,
      [VOLUME_LABELS.migrationSourceCreatedAt]: CREATED,
    });
    expect(plan([old, copy])).toEqual({
      kind: "migrate",
      leftovers: [copy.Name],
      source: old.Name,
    });
  });

  test("a finished copy is current: its source is gone", () => {
    const copy = labelled("aaaa0004", `enforced:${QUOTA}`, {
      [VOLUME_LABELS.migratedFrom]: GONE,
    });
    expect(plan([copy])).toEqual({
      kind: "current",
      workspace: copy.Name,
    });
  });

  test("a copy whose source is long gone can itself be moved again", () => {
    // Migrated once under the old quota; the quota has changed since.
    const earlier = labelled("aaaa0009", "off", {
      [VOLUME_LABELS.migratedFrom]: GONE,
    });
    expect(plan([earlier])).toEqual({
      kind: "migrate",
      leftovers: [],
      source: earlier.Name,
    });
  });

  test("no workspace at all is current, with nothing to move", () => {
    expect(plan([])).toEqual({ kind: "current", workspace: null });
  });

  test("two old-quota workspaces cannot be told apart", () => {
    expect(
      plan([labelled("aaaa0005", "off"), labelled("aaaa0006", "enforced:1")]),
    ).toMatchObject({ kind: "refused" });
  });

  test("two current workspaces are not ours to choose between", () => {
    expect(
      plan([
        labelled("aaaa0007", `enforced:${QUOTA}`),
        labelled("aaaa0008", `enforced:${QUOTA}`),
      ]),
    ).toMatchObject({ kind: "refused" });
  });
});

describe("WorkspaceMigrator", () => {
  test("a source recreated empty under the pin is not copied", async () => {
    // A GC pass that outran a lost pass lock removed the source between the
    // plan and the pin, and Docker made an empty one for the pin's mount.
    const calls: string[] = [];
    let created = "2026-01-01T00:00:00Z";
    const docker = {
      async createContainer(name: string) {
        calls.push(`create ${name}`);
        created = "2026-09-23T00:00:00Z";
        return { Id: name };
      },
      async createVolume() {
        throw new Error("no copy may be made");
      },
      async inspectContainer() {
        return null;
      },
      async inspectImage() {
        return {};
      },
      async inspectVolume(name: string) {
        return name === OLD.Name ? { ...OLD, CreatedAt: created } : null;
      },
      async listContainers() {
        return [];
      },
      async listContainersUsingVolume() {
        return [];
      },
      async listVolumes() {
        return [OLD];
      },
      async removeVolume(name: string) {
        calls.push(`remove volume ${name}`);
      },
      async stopAndRemoveContainer(name: string) {
        calls.push(`remove ${name}`);
      },
    } as unknown as DockerClient;

    await expect(
      new WorkspaceMigrator(config, docker).migrate({
        deadlineMs: 1_000,
        helperImage: DEFAULT_MIGRATION_HELPER_IMAGE,
        sessionId: SESSION,
      }),
    ).rejects.toThrow("was removed and recreated empty");
    const [pinned, unpinned, ...rest] = calls;
    expect(pinned).toStartWith(`create werft-ws-migrate-pin-inst-${SESSION}-`);
    expect(unpinned).toBe(pinned?.replace("create", "remove"));
    expect(rest).toEqual([]);
  });
});
