import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * scripts/prepare-xfs.sh on a scratch root (PREPARE_XFS_ROOT) with the stub
 * commands of fixtures/prepare-xfs-bin for everything that touches Docker,
 * systemd, mounts or block devices. mv, rmdir, cp and rm are the real ones, so a rollback is checked
 * against the files it actually put back.
 */

const script = join(import.meta.dir, "../scripts/prepare-xfs.sh");
const ENTRY = "/var/lib/docker.xfs.img /var/lib/docker xfs loop,prjquota 0 0";
const FSTAB = "UUID=fixture / ext4 defaults 0 1\n";

const stubs = join(import.meta.dir, "fixtures/prepare-xfs-bin");

let work: string;
let root: string;
let state: string;

function tree(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      const rel = `${prefix}/${name}`;
      return statSync(path).isDirectory()
        ? [`${rel}/`, ...tree(path, rel)]
        : [`${rel}=${readFileSync(path, "utf8")}`];
    });
}

// What the host looks like: files under /var/lib and /etc, mounts, Docker.
function snapshot() {
  return {
    files: [...tree(join(root, "var/lib")), ...tree(join(root, "etc"))],
    mounts: readFileSync(join(state, "mounts"), "utf8"),
    running: existsSync(join(state, "running")),
  };
}

function run(args: string[] = [], env: Record<string, string> = {}) {
  const result = Bun.spawnSync(["bash", script, ...args], {
    env: {
      ...process.env,
      PATH: `${stubs}:${process.env.PATH}`,
      PREPARE_XFS_ROOT: root,
      STUB_STATE: state,
      ...env,
    },
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    calls: readFileSync(join(state, "calls"), "utf8"),
  };
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "prepare-xfs-"));
  root = join(work, "root");
  state = join(work, "state");
  for (const dir of [state, join(root, "etc"), join(root, "proc")])
    mkdirSync(dir, { recursive: true });
  mkdirSync(join(root, "var/lib/docker/volumes/data"), { recursive: true });
  writeFileSync(join(root, "var/lib/docker/volumes/data/file"), "original");
  writeFileSync(join(root, "etc/fstab"), FSTAB);
  writeFileSync(join(root, "proc/filesystems"), "nodev\tproc\n\txfs\n");
  writeFileSync(join(state, "mounts"), "");
  writeFileSync(join(state, "calls"), "");
  writeFileSync(join(state, "running"), "");
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

const mutated = (calls: string) =>
  /^(systemctl stop|mkfs\.xfs \S*docker\.xfs\.img|mount \S+ \S*docker\.xfs\.img)/m.test(
    calls,
  );

describe("prepare-xfs.sh", () => {
  test("--dry-run runs the preflight and the trial mount, then changes nothing", () => {
    const before = snapshot();
    const result = run(["--dry-run"]);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--dry-run changes nothing");
    expect(result.stdout).toContain(
      `${root}/var/lib/docker.xfs.img (60G, sparse)`,
    );
    expect(result.calls).toMatch(
      /^mount -o loop,prjquota \S+xfs-trial\S+\/img /m,
    );
    expect(mutated(result.calls)).toBe(false);
    expect(snapshot()).toEqual(before);
  });

  test("moves the data-root onto the mounted image and keeps the original", () => {
    const result = run(["--size", "8G"]);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const data = join(root, "var/lib/docker");
    expect(readFileSync(join(state, "mounts"), "utf8")).toBe(
      `${data}|xfs rw,relatime,attr2,inode64,prjquota|${data}.xfs.img\n`,
    );
    expect(result.calls).toContain(`truncate -s 8G ${data}.xfs.img`);
    expect(readFileSync(join(data, "volumes/data/file"), "utf8")).toBe(
      "original",
    );
    expect(readFileSync(join(`${data}.old`, "volumes/data/file"), "utf8")).toBe(
      "original",
    );
    expect(readFileSync(join(root, "etc/fstab"), "utf8")).toBe(
      `${FSTAB}${ENTRY}\n`,
    );
    expect(
      readFileSync(join(root, "etc/fstab.before-prepare-xfs"), "utf8"),
    ).toBe(FSTAB);
    expect(existsSync(join(state, "running"))).toBe(true);
    expect(result.calls).toMatch(
      /^docker volume create --driver local --opt size=64m /m,
    );
    expect(
      tree(join(root, "var/lib")).some((p) => p.includes("xfs-trial")),
    ).toBe(false);
  });

  test("an already prepared data-root needs nothing", () => {
    const before = snapshot();
    const result = run([], { STUB_ROOT_FS: "xfs rw,relatime,prjquota" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("already prepared");
    expect(mutated(result.calls)).toBe(false);
    expect(snapshot()).toEqual(before);
  });

  test("a bad --size is a usage error", () => {
    expect(run(["--size", "60GB"]).exitCode).toBe(2);
    expect(run(["--size"]).exitCode).toBe(2);
    expect(run(["--force"]).exitCode).toBe(2);
  });

  const refusals: [string, () => Record<string, string>, string][] = [
    ["not root", () => ({ STUB_UID: "1000" }), "run it as root"],
    [
      "Docker not running",
      () => {
        rmSync(join(state, "running"));
        return {};
      },
      "docker info failed",
    ],
    [
      "a data-root elsewhere",
      () => ({ STUB_DOCKER_ROOT: "/srv/docker" }),
      "Docker's data-root is /srv/docker",
    ],
    [
      "an existing image",
      () => {
        writeFileSync(
          join(root, "var/lib/docker.xfs.img"),
          "original workspace data",
        );
        return {};
      },
      "docker.xfs.img already exists",
    ],
    [
      "an existing docker.old",
      () => {
        mkdirSync(join(root, "var/lib/docker.old"));
        return {};
      },
      "docker.old already exists",
    ],
    [
      "an fstab entry for the data-root",
      () => {
        writeFileSync(
          join(root, "etc/fstab"),
          `${FSTAB}/dev/sdb1 /var/lib/docker ext4 defaults 0 2\n`,
        );
        return {};
      },
      "already has an entry for /var/lib/docker",
    ],
    [
      "an fstab findmnt --verify already rejects",
      () => ({ STUB_FAIL: "findmnt ^--verify" }),
      "findmnt --verify finds errors",
    ],
    [
      "too little room",
      () => ({ STUB_AVAIL_KB: "1048576" }),
      "needs 62914560 KiB",
    ],
    [
      "a kernel without XFS",
      () => {
        writeFileSync(join(root, "proc/filesystems"), "nodev\tproc\n\text4\n");
        return { STUB_MODPROBE_RC: "1" };
      },
      "no XFS support",
    ],
    [
      "a host whose loop mount fails",
      () => ({ STUB_FAIL: "mount xfs-trial" }),
      "this host needs loop devices",
    ],
  ];
  for (const [name, setup, message] of refusals) {
    test(`the preflight refuses ${name} before touching anything`, () => {
      const env = setup();
      const before = snapshot();
      const result = run([], env);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(message);
      expect(result.stderr).toContain("nothing was changed");
      expect(mutated(result.calls)).toBe(false);
      expect(snapshot()).toEqual(before);
    });
  }

  // Each failing step, and the steps before it undone: the host is as it was,
  // Docker running on the original data-root.
  const failures: [string, Record<string, string>][] = [
    ["stopping Docker", { STUB_FAIL: "systemctl ^stop" }],
    ["sizing the image", { STUB_FAIL: "truncate docker\\.xfs\\.img$" }],
    ["formatting the image", { STUB_FAIL: "mkfs.xfs docker\\.xfs\\.img$" }],
    ["the mount", { STUB_FAIL: "mount docker$" }],
    ["a mount without prjquota", { STUB_MOUNT_OPTS: "rw,relatime" }],
    ["the copy", { STUB_FAIL: "rsync ." }],
    ["the fstab check", { STUB_VERIFY_REFUSES_ENTRY: "1" }],
    ["the systemd reload", { STUB_FAIL_ONCE: "systemctl ^daemon-reload" }],
  ];
  for (const [name, env] of failures) {
    test(`a failure at ${name} puts everything back`, () => {
      const before = snapshot();
      const result = run([], env);
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain("undone: Docker runs on the original");
      expect(snapshot()).toEqual(before);
    });
  }

  // Docker may have written to the image once it ran on it: the image stays,
  // everything else is put back.
  const afterStart: [string, Record<string, string>][] = [
    ["starting Docker", { STUB_FAIL_ONCE: "systemctl ^start" }],
    ["the quota probe", { STUB_FAIL: "docker ^volume create" }],
  ];
  for (const [name, env] of afterStart) {
    test(`a failure at ${name} puts everything back but keeps the image`, () => {
      const before = snapshot();
      const result = run([], env);
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain("kept ");
      const after = snapshot();
      expect({ ...after, files: after.files.sort() }).toEqual({
        ...before,
        files: [...before.files, "/docker.xfs.img=XFS"].sort(),
      });
    });
  }

  test("a failed fstab restore keeps the image fstab still mounts", () => {
    const result = run([], {
      STUB_VERIFY_REFUSES_ENTRY: "1",
      STUB_FAIL: "cp before-prepare-xfs .*fstab$",
    });
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("still mounts");
    expect(existsSync(join(root, "var/lib/docker.xfs.img"))).toBe(true);
    expect(
      readFileSync(join(root, "etc/fstab.before-prepare-xfs"), "utf8"),
    ).toBe(FSTAB);
    expect(
      readFileSync(join(root, "var/lib/docker/volumes/data/file"), "utf8"),
    ).toBe("original");
    expect(existsSync(join(root, "var/lib/docker.old"))).toBe(false);
    expect(existsSync(join(state, "running"))).toBe(true);
  });

  test("a trial mount that will not unmount is left in place, not deleted", () => {
    const result = run(["--dry-run"], { STUB_FAIL: "umount xfs-trial" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("is still mounted");
    const trials = readdirSync(join(root, "var/lib")).filter((name) =>
      name.includes("xfs-trial"),
    );
    expect(trials).toHaveLength(1);
    expect(existsSync(join(root, "var/lib", trials[0] ?? "", "img"))).toBe(
      true,
    );
    expect(mutated(result.calls)).toBe(false);
  });

  test("an undo that fails leaves Docker stopped rather than on an empty data-root", () => {
    const result = run([], { STUB_FAIL: "rsync .\numount docker$" });
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("undo failed: umount");
    expect(result.stderr).toContain("Docker stays stopped");
    expect(result.stderr).toContain(
      `the original data is in ${root}/var/lib/docker.old`,
    );
    expect(existsSync(join(state, "running"))).toBe(false);
    expect(
      readFileSync(join(root, "var/lib/docker.old/volumes/data/file"), "utf8"),
    ).toBe("original");
    expect(readFileSync(join(root, "etc/fstab"), "utf8")).toBe(FSTAB);
  });
});
