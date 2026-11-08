import { posix } from "node:path";
import type { WorkspaceLimitMode } from "@werft-ai/contracts";

export type { WorkspaceLimitMode } from "@werft-ai/contracts";

export type LimitMode = "hard" | "soft" | "unknown";
export type MountInfo = {
  mountPoint: string;
  filesystem: string;
  options: string[];
};
export type FilesystemUsage = {
  totalBytes: number;
  freeBytes: number;
  totalInodes: number;
  freeInodes: number;
};
export type WorkspaceLimitEvidence = {
  mount?: MountInfo;
  filesystem?: FilesystemUsage;
  requestedBytes?: number;
  pvcCapacityBytes?: number;
  localQuota?: "enforced" | "off";
  // An operator declaration; this path leaves inode enforcement unknown.
  enforcedByStorage?: boolean;
};

export function workspaceMount(
  text: string,
  root: string,
): MountInfo | undefined {
  const directory = posix.resolve(root);
  let selected: MountInfo | undefined;
  for (const line of text.split("\n")) {
    const [left, right] = line.split(" - ");
    if (left === undefined || right === undefined) continue;
    const fields = left.split(" ");
    const tail = right.split(" ");
    if (fields.length < 6 || tail.length < 3) continue;
    const point = fields[4];
    const filesystem = tail[0];
    if (point === undefined || filesystem === undefined) continue;
    const mountPoint = point.replace(/\\([0-7]{3})/g, (_, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)),
    );
    if (
      directory !== mountPoint &&
      !directory.startsWith(mountPoint === "/" ? "/" : `${mountPoint}/`)
    )
      continue;
    const mount = {
      mountPoint,
      filesystem,
      options: `${fields[5]},${tail[2]}`
        .split(",")
        .filter((option) =>
          ["rw", "ro", "prjquota", "pquota"].includes(option),
        ),
    };
    if (
      selected === undefined ||
      mountPoint.length >= selected.mountPoint.length
    )
      selected = mount;
  }
  return selected;
}

export function workspaceLimitMode(
  evidence: WorkspaceLimitEvidence,
): WorkspaceLimitMode {
  const mode = (bytes: LimitMode, inodes: LimitMode, reason: string) => ({
    bytes,
    inodes,
    reason,
  });
  const { mount, filesystem, requestedBytes, pvcCapacityBytes } = evidence;
  if (mount === undefined || filesystem === undefined) {
    return mode("unknown", "unknown", "filesystem_evidence_unavailable");
  }
  if (
    /^(nfs|efs|fuse|overlay)/.test(mount.filesystem) ||
    filesystem.totalInodes === 0
  ) {
    return mode("soft", "soft", "shared_or_unaccounted_filesystem");
  }
  if (evidence.localQuota === "off")
    return mode("soft", "soft", "local_quota_disabled");
  if (evidence.localQuota === "enforced" && mount.filesystem === "xfs") {
    return mode("hard", "hard", "local_quota_preflight");
  }
  if (requestedBytes === undefined || pvcCapacityBytes === undefined) {
    return mode("unknown", "unknown", "storage_capacity_unavailable");
  }
  const ratio = filesystem.totalBytes / requestedBytes;
  if (ratio > 1.5)
    return mode("soft", "soft", "filesystem_larger_than_request");
  if (
    ratio >= 0.95 &&
    ratio <= 1.05 &&
    evidence.enforcedByStorage === true &&
    mount.mountPoint !== "/" &&
    mount.options.includes("rw") &&
    !mount.options.includes("ro") &&
    pvcCapacityBytes >= requestedBytes
  ) {
    return mode("hard", "unknown", "storage_declaration_and_capacity");
  }
  return mode("unknown", "unknown", "storage_enforcement_unverified");
}
