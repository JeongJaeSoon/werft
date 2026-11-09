import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  exitCodeFor,
  verifyWorkspace,
  workspaceEvidenceFromEnv,
} from "./main.ts";
import { workspaceLimitMode } from "./workspace-limit-mode.ts";

test.each([
  undefined,
  "false",
  "",
  "TRUE",
  " true",
  "true ",
  "1",
  "on",
  "yes",
  "true",
])(
  "only the exact true storage declaration becomes worker evidence: %j",
  (value) => {
    const evidence = workspaceEvidenceFromEnv({
      WORKER_WORKSPACE_ENFORCED_BY_STORAGE: value,
      WORKER_WORKSPACE_QUOTA_BYTES: "1000",
      WORKER_WORKSPACE_PVC_CAPACITY_BYTES: "1000",
      WORKER_WORKSPACE_QUOTA_MODE: "off",
    });
    expect(evidence).toEqual({
      requestedBytes: 1000,
      pvcCapacityBytes: 1000,
      localQuota: "off",
      ...(value === "true" ? { enforcedByStorage: true } : {}),
    });
  },
);

test.each([
  ["yes", "unknown"],
  ["1", "unknown"],
  ["TRUE", "unknown"],
  ["true", "hard"],
] as const)(
  "a storage declaration env value %j classifies bytes as %s",
  (value, bytes) => {
    const evidence = workspaceEvidenceFromEnv({
      WORKER_WORKSPACE_ENFORCED_BY_STORAGE: value,
      WORKER_WORKSPACE_QUOTA_BYTES: "1000",
      WORKER_WORKSPACE_PVC_CAPACITY_BYTES: "2000",
    });
    expect(
      workspaceLimitMode({
        ...evidence,
        mount: {
          mountPoint: "/workspace",
          filesystem: "ext4",
          options: ["rw"],
        },
        filesystem: {
          totalBytes: 1000,
          freeBytes: 500,
          totalInodes: 100,
          freeInodes: 50,
        },
      }),
    ).toMatchObject({ bytes, inodes: "unknown" });
  },
);

describe("exitCodeFor", () => {
  test.each([
    ["drained", 0],
    ["idle", 0],
    ["paused", 0],
    ["unclaimed", 0],
    ["lease_lost", 75],
    ["failed", 1],
  ] as const)("reports %s as exit code %d", (outcome, code) => {
    expect(exitCodeFor({ outcome, reason: "because", turns: [] })).toBe(code);
  });
});

describe("verifyWorkspace", () => {
  test("accepts the directory the execution backend mounted, empty or not", async () => {
    const directory = await mkdtemp(join(tmpdir(), "94s-122-"));
    try {
      // What belongs in it is the claim's to say, so an empty mount passes.
      await expect(verifyWorkspace(directory)).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("makes the checkout directory in the mount above it", async () => {
    const mount = await mkdtemp(join(tmpdir(), "94s-634-"));
    try {
      await expect(
        verifyWorkspace(join(mount, "repo")),
      ).resolves.toBeUndefined();
      expect((await stat(join(mount, "repo"))).isDirectory()).toBe(true);
    } finally {
      await rm(mount, { recursive: true, force: true });
    }
  });

  test("refuses a link where the checkout directory goes", async () => {
    // A link the last engine left on the volume would move the checkout off it.
    const mount = await mkdtemp(join(tmpdir(), "94s-634-"));
    try {
      await mkdir(join(mount, "elsewhere"));
      await symlink(join(mount, "elsewhere"), join(mount, "repo"));
      await expect(verifyWorkspace(join(mount, "repo"))).rejects.toThrow(
        "WORKER_WORKSPACE_DIR",
      );
    } finally {
      await rm(mount, { recursive: true, force: true });
    }
  });

  test("refuses to claim a session it has nowhere to run", async () => {
    await expect(
      verifyWorkspace(join(tmpdir(), "94s-122-does-not-exist", "repo")),
    ).rejects.toThrow("WORKER_WORKSPACE_DIR");
  });

  test("refuses a path that is not a directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "94s-122-"));
    const file = join(directory, "workspace");
    try {
      await writeFile(file, "not a directory");
      await expect(verifyWorkspace(file)).rejects.toThrow("does not exist");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
