import { expect, test } from "bun:test";
import {
  type WorkspaceLimitEvidence,
  workspaceLimitMode,
  workspaceMount,
} from "./workspace-limit-mode.ts";

const evidence = {
  mount: { mountPoint: "/workspace", filesystem: "ext4", options: ["rw"] },
  filesystem: {
    totalBytes: 1000,
    freeBytes: 500,
    totalInodes: 100,
    freeInodes: 50,
  },
  requestedBytes: 1000,
  pvcCapacityBytes: 1000,
} satisfies WorkspaceLimitEvidence;

test.each(["overlay", "nfs", "nfs4", "efs", "fuse.sshfs"])(
  "%s overrides declarations",
  (filesystem) => {
    expect(
      workspaceLimitMode({
        ...evidence,
        mount: { mountPoint: "/workspace", filesystem, options: [] },
        enforcedByStorage: true,
        localQuota: "enforced",
      }),
    ).toMatchObject({ bytes: "soft", inodes: "soft" });
  },
);

test("capacity, an exact mount and prjquota alone cannot establish enforcement", () => {
  expect(workspaceLimitMode(evidence).bytes).toBe("unknown");
  expect(
    workspaceLimitMode({
      ...evidence,
      mount: {
        mountPoint: "/workspace",
        filesystem: "xfs",
        options: ["prjquota"],
      },
    }).bytes,
  ).toBe("unknown");
  const { pvcCapacityBytes: _capacity, ...withoutCapacity } = evidence;
  expect(
    workspaceLimitMode({ ...withoutCapacity, enforcedByStorage: true }).bytes,
  ).toBe("unknown");
});

test.each([
  [949, "unknown"],
  [950, "hard"],
  [1050, "hard"],
  [1051, "unknown"],
  [1500, "unknown"],
  [1501, "soft"],
] as const)(
  "capacity %i is %s with an operator declaration",
  (totalBytes, bytes) => {
    expect(
      workspaceLimitMode({
        ...evidence,
        filesystem: { ...evidence.filesystem, totalBytes },
        enforcedByStorage: true,
      }),
    ).toMatchObject({ bytes, inodes: bytes === "soft" ? "soft" : "unknown" });
  },
);

test("missing filesystem and unavailable inodes remain conservative", () => {
  expect(workspaceLimitMode({})).toMatchObject({
    bytes: "unknown",
    inodes: "unknown",
  });
  const { mount: _mount, ...withoutMount } = evidence;
  expect(workspaceLimitMode(withoutMount)).toMatchObject({ bytes: "unknown" });
  expect(
    workspaceLimitMode({
      ...evidence,
      filesystem: { ...evidence.filesystem, totalInodes: 0 },
    }),
  ).toMatchObject({ bytes: "soft", inodes: "soft" });
});

test.each([
  { mountPoint: "/", options: ["rw"] },
  { mountPoint: "/workspace", options: ["ro"] },
  { mountPoint: "/workspace", options: ["rw", "ro"] },
  { mountPoint: "/workspace", options: [] },
])("a storage declaration needs a dedicated writable mount: %j", (mount) => {
  expect(
    workspaceLimitMode({
      ...evidence,
      mount: { ...evidence.mount, ...mount, options: [...mount.options] },
      enforcedByStorage: true,
    }),
  ).toEqual({
    bytes: "unknown",
    inodes: "unknown",
    reason: "storage_enforcement_unverified",
  });
});

test("declarations cannot replace capacity or filesystem evidence", () => {
  const { mount: _mount, ...withoutMount } = evidence;
  const { filesystem: _filesystem, ...withoutFilesystem } = evidence;
  for (const partial of [withoutMount, withoutFilesystem]) {
    expect(workspaceLimitMode({ ...partial, enforcedByStorage: true })).toEqual(
      {
        bytes: "unknown",
        inodes: "unknown",
        reason: "filesystem_evidence_unavailable",
      },
    );
  }
  expect(
    workspaceLimitMode({
      ...evidence,
      pvcCapacityBytes: 999,
      enforcedByStorage: true,
    }),
  ).toEqual({
    bytes: "unknown",
    inodes: "unknown",
    reason: "storage_enforcement_unverified",
  });
  expect(
    workspaceLimitMode({
      ...evidence,
      filesystem: { ...evidence.filesystem, totalInodes: 0 },
      enforcedByStorage: true,
    }),
  ).toMatchObject({ bytes: "soft", inodes: "soft" });
  expect(workspaceLimitMode({ ...evidence, enforcedByStorage: true })).toEqual({
    bytes: "hard",
    inodes: "unknown",
    reason: "storage_declaration_and_capacity",
  });
});

test("local preflight establishes both axes on XFS; explicit off is soft", () => {
  const mount = { mountPoint: "/workspace", filesystem: "xfs", options: [] };
  const { pvcCapacityBytes: _capacity, ...withoutCapacity } = evidence;
  expect(
    workspaceLimitMode({ ...withoutCapacity, localQuota: "enforced", mount }),
  ).toMatchObject({ bytes: "hard", inodes: "hard" });
  expect(
    workspaceLimitMode({
      ...evidence,
      localQuota: "off",
      enforcedByStorage: true,
    }),
  ).toMatchObject({ bytes: "soft", inodes: "soft" });
});

test("mountinfo finds the most specific mount on a path boundary and decodes octal escapes", () => {
  const lines = [
    "1 0 0:1 / / rw - overlay overlay rw",
    "2 1 8:1 / /workspace rw - ext4 /dev/sda rw",
    "3 1 8:2 / /workspace-other rw - nfs server rw",
    "4 1 8:3 / /workspace/a\\040b rw - xfs /dev/sdb rw,prjquota,username=fixture-user",
    "malformed",
  ].join("\n");
  expect(workspaceMount(lines, "/workspace/repo")?.filesystem).toBe("ext4");
  expect(workspaceMount(lines, "/workspace/a b")?.options).toContain(
    "prjquota",
  );
  expect(workspaceMount("", "/workspace")).toBeUndefined();
  expect(workspaceMount(lines, "/workspace/a b")?.options).not.toContain(
    "username=fixture-user",
  );
  expect(
    workspaceMount(
      `${lines}\n5 1 8:4 / /workspace rw - xfs /dev/sdc rw,pquota`,
      "/workspace",
    )?.filesystem,
  ).toBe("xfs");
});
