import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPOSE_RENDER_TIMEOUT_MS } from "./compose-layers.ts";

/**
 * The single-server release bundle (.github/scripts/test-ops-bundle.sh) and
 * scripts/test-ops.sh run from it, in a directory that is not a checkout.
 * The archive is built with GNU tar (the CI runner); where it is missing the
 * archive cases are skipped.
 */

const root = join(import.meta.dir, "..");
const fixture = join(root, "tests/fixtures/test-ops-release-manifest.json");
const manifest = JSON.parse(readFileSync(fixture, "utf8")) as {
  tag: string;
  commit: string;
  images: Record<string, { image: string; digest: string }>;
};
const pinned = (app: string) =>
  `${manifest.images[app]?.image}@${manifest.images[app]?.digest}`;
const name = `werft-test-ops-${manifest.tag}`;

const hasGnuTar = Bun.spawnSync(["tar", "--version"])
  .stdout.toString()
  .includes("GNU tar");
const hasSha256 =
  Bun.spawnSync(["sh", "-c", "command -v sha256sum"]).exitCode === 0;
const bundleTest = test.skipIf(!hasGnuTar || !hasSha256);

const EXPECTED_FILES = [
  "BUNDLE",
  "SHA256SUMS",
  "infra/compose.core.yml",
  "infra/compose.localstack.yml",
  "infra/compose.test-ops.localstack.yml",
  "infra/compose.test-ops.s3.yml",
  "infra/compose.test-ops.yml",
  "infra/localstack/init/10-create-resources.sh",
  "infra/test-ops.env.example",
  "infra/test-ops.release.example.json",
  "packages/db/migrations/0000_gifted_morg.sql",
  "packages/db/migrations/0001_giant_sphinx.sql",
  "packages/db/migrations/0002_thin_victor_mancha.sql",
  "packages/db/migrations/0003_lethal_blue_blade.sql",
  "release-manifest.json",
  "scripts/lib/backup-lib.sh",
  "scripts/lib/test-ops.ts",
  "scripts/prepare-xfs.sh",
  "scripts/test-ops.sh",
];

function sh(
  cmd: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
) {
  const run = Bun.spawnSync(cmd, {
    cwd: options.cwd,
    env: { ...Bun.env, ...options.env },
  });
  return {
    exitCode: run.exitCode,
    stderr: run.stderr.toString(),
    stdout: run.stdout.toString(),
  };
}

// images.yml's main-push plan (test-ops-bundle-plan.sh) decides from
// `--inputs`, so that list has to be what the archive is made of.
test("--inputs lists every checkout path the bundle holds, and the script itself", () => {
  const run = sh(
    [join(root, ".github/scripts/test-ops-bundle.sh"), "--inputs"],
    {
      cwd: root,
    },
  );
  expect(run.exitCode).toBe(0);
  const generated = ["BUNDLE", "SHA256SUMS", "release-manifest.json"];
  expect(run.stdout.trim().split("\n").sort()).toEqual(
    [
      ".github/scripts/test-ops-bundle.sh",
      ...EXPECTED_FILES.filter((f) => !generated.includes(f)),
    ].sort(),
  );
});

describe("the single-server release bundle", () => {
  let work: string;
  let archive: string;
  let unpacked: string;
  let calls: string;
  let bin: string;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "test-ops-bundle-"));
    if (!hasGnuTar || !hasSha256) return;
    const build = (out: string) =>
      sh([
        join(root, ".github/scripts/test-ops-bundle.sh"),
        manifest.tag,
        fixture,
        out,
      ]);
    expect(build(join(work, "a")).exitCode).toBe(0);
    archive = join(work, "a", `${name}.tar.gz`);
    unpacked = join(work, "unpacked");
    mkdirSync(unpacked);
    sh(["tar", "-xzf", archive, "-C", unpacked]);
    unpacked = join(unpacked, name);

    // `docker run … --entrypoint bun <image> run /app/scripts/lib/test-ops.ts`
    // is the bundle's helper; here the same file runs on the host's bun. Any
    // other docker call is recorded and fails.
    calls = join(work, "docker-calls");
    bin = join(work, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/bash
echo "$*" >> "${calls}"
if [ "$1" = run ]; then
  args=("$@")
  for i in "\${!args[@]}"; do
    if [ "\${args[i]}" = /app/scripts/lib/test-ops.ts ]; then
      exec bun run "${join(root, "scripts/lib/test-ops.ts")}" "\${args[@]:i+1}"
    fi
  done
fi
exit 1
`,
    );
    chmodSync(join(bin, "docker"), 0o755);
  });

  afterAll(() => rmSync(work, { force: true, recursive: true }));

  const env = (extra: Record<string, string> = {}) => {
    const settings = join(work, "settings");
    writeFileSync(settings, "EXECUTION_INSTALLATION_ID=t\n", { mode: 0o600 });
    return {
      PATH: `${bin}:${Bun.env.PATH ?? ""}`,
      TEST_OPS_ENV_FILE: settings,
      TEST_OPS_STATE_DIR: join(work, "state"),
      ...extra,
    };
  };
  const script = () => join(unpacked, "scripts/test-ops.sh");

  bundleTest("holds exactly the expected files", () => {
    const listing = sh(["tar", "-tzf", archive])
      .stdout.split("\n")
      .filter((line) => line !== "" && !line.endsWith("/"))
      .map((line) => line.slice(`${name}/`.length))
      .sort();
    expect(listing).toEqual([...EXPECTED_FILES].sort());
  });

  bundleTest("names its tag and commit and lists every file's sha256", () => {
    expect(JSON.parse(readFileSync(join(unpacked, "BUNDLE"), "utf8"))).toEqual({
      tag: manifest.tag,
      commit: manifest.commit,
    });
    const sums = readFileSync(join(unpacked, "SHA256SUMS"), "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split("  ")[1]);
    expect(sums.sort()).toEqual(
      EXPECTED_FILES.filter((file) => file !== "SHA256SUMS").sort(),
    );
    expect(
      sh(["sha256sum", "-c", "--quiet", "SHA256SUMS"], { cwd: unpacked })
        .exitCode,
    ).toBe(0);
  });

  bundleTest(
    "carries the release manifest unchanged and no image of its own",
    () => {
      expect(
        readFileSync(join(unpacked, "release-manifest.json"), "utf8"),
      ).toBe(readFileSync(fixture, "utf8"));
      const compose = readFileSync(
        join(unpacked, "infra/compose.test-ops.yml"),
        "utf8",
      );
      expect(compose).not.toMatch(/sha256:[0-9a-f]{64}/);
    },
  );

  bundleTest("is the same bytes when built again", () => {
    const again = sh([
      join(root, ".github/scripts/test-ops-bundle.sh"),
      manifest.tag,
      fixture,
      join(work, "b"),
    ]);
    expect(again.exitCode).toBe(0);
    expect(readFileSync(join(work, "b", `${name}.tar.gz`))).toEqual(
      readFileSync(archive),
    );
    expect(
      readFileSync(join(work, "b", `${name}.tar.gz.sha256`), "utf8"),
    ).toContain(`${name}.tar.gz`);
  });

  bundleTest("refuses a manifest of another tag", () => {
    const run = sh([
      join(root, ".github/scripts/test-ops-bundle.sh"),
      "v9.9.9",
      fixture,
      join(work, "c"),
    ]);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("not v9.9.9");
  });

  bundleTest(
    "turns the release manifest into the deploy manifest by digest",
    () => {
      const settings = join(work, "settings.json");
      writeFileSync(settings, '{"repositories":[]}\n');
      const run = sh(
        ["bash", script(), "manifest", "release-manifest.json", settings],
        {
          cwd: unpacked,
          env: env(),
        },
      );
      expect(run.exitCode).toBe(0);
      const out = JSON.parse(run.stdout) as {
        source_commit: string;
        images: Record<string, string>;
        settings_digest: string;
      };
      expect(out.source_commit).toBe(manifest.commit);
      expect(out.images).toEqual({
        control_host: pinned("control-host"),
        worker: pinned("worker"),
        egress_proxy: pinned("egress-proxy"),
      });
      expect(out.settings_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    },
  );

  bundleTest(
    "refuses upgrade, backup, reseed and restore-drill without touching docker",
    () => {
      for (const args of [
        ["upgrade", "release-manifest.json"],
        ["backup"],
        ["reseed", "somewhere"],
        ["restore-drill", "somewhere"],
      ]) {
        const run = sh(["bash", script(), ...args], { cwd: work, env: env() });
        expect(run.exitCode).toBe(1);
        expect(run.stderr).toContain("is not in the release bundle");
      }
      expect(existsSync(calls)).toBe(false);
    },
  );

  bundleTest(
    "checks the manifest against the bundle's release before docker",
    () => {
      const deploy = (patch: (m: Record<string, unknown>) => void) => {
        const file = join(work, "deploy.json");
        const m = {
          source_commit: manifest.commit,
          images: {
            control_host: pinned("control-host"),
            worker: pinned("worker"),
            egress_proxy: pinned("egress-proxy"),
          },
          settings_digest: `sha256:${"4".repeat(64)}`,
        };
        patch(m);
        writeFileSync(file, JSON.stringify(m));
        return sh(["bash", script(), "preflight", file], {
          cwd: work,
          env: env(),
        });
      };
      const other = deploy((m) => {
        (m.images as Record<string, string>).worker =
          `${manifest.images.worker?.image}@sha256:${"d".repeat(64)}`;
      });
      expect(other.exitCode).toBe(1);
      expect(other.stderr).toContain("this bundle's release names");
      const commit = deploy((m) => {
        m.source_commit = "f".repeat(40);
      });
      expect(commit.exitCode).toBe(1);
      expect(commit.stderr).toContain("this bundle is");
      // The matching manifest passes the bundle checks and the manifest
      // validation, run by the control-host image, and stops at the daemon.
      const same = deploy(() => {});
      expect(same.stderr).toContain("cannot reach the Docker daemon");
      const helper = readFileSync(calls, "utf8")
        .split("\n")
        .find((line) => line.startsWith("run "));
      expect(helper).toContain("--network none");
      expect(helper).toContain("--entrypoint bun");
      expect(helper).toContain(pinned("control-host"));
    },
  );

  bundleTest("refuses a changed or an extra file", () => {
    const copy = join(work, "copy");
    cpSync(unpacked, copy, { recursive: true });
    const file = join(work, "deploy-copy.json");
    writeFileSync(
      file,
      JSON.stringify({
        source_commit: manifest.commit,
        images: {
          control_host: pinned("control-host"),
          worker: pinned("worker"),
          egress_proxy: pinned("egress-proxy"),
        },
        settings_digest: `sha256:${"4".repeat(64)}`,
      }),
    );
    const preflight = () =>
      sh(["bash", join(copy, "scripts/test-ops.sh"), "preflight", file], {
        cwd: work,
        env: env(),
      });
    writeFileSync(join(copy, "infra/compose.test-ops.yml"), "services: {}\n");
    expect(preflight().stderr).toContain("differs from SHA256SUMS");
    cpSync(
      join(unpacked, "infra/compose.test-ops.yml"),
      join(copy, "infra/compose.test-ops.yml"),
    );
    writeFileSync(join(copy, "infra/compose.extra.yml"), "services: {}\n");
    expect(preflight().stderr).toContain("does not list");
  });

  bundleTest(
    "checks the files before any verb runs docker or the bundled helper",
    () => {
      const copy = join(work, "copy-all-verbs");
      cpSync(unpacked, copy, { recursive: true });
      // A changed helper and a changed sourced library (the bundle's own code):
      // the library's added line must never run, the check comes first.
      writeFileSync(
        join(copy, "scripts/lib/test-ops.ts"),
        "process.exit(0);\n",
      );
      const lib = join(copy, "scripts/lib/backup-lib.sh");
      writeFileSync(
        lib,
        `echo LIBRARY_RAN_BEFORE_CHECK >&2\n${readFileSync(lib, "utf8")}`,
      );
      const before = existsSync(calls) ? readFileSync(calls, "utf8") : "";
      const result = (verb: string[]) =>
        sh(["bash", join(copy, "scripts/test-ops.sh"), ...verb], {
          cwd: work,
          env: env(),
        });
      for (const verb of [
        ["stop"],
        ["start"],
        ["status"],
        ["key", "list"],
        ["preflight", join(work, "none.json")],
        ["deploy", join(work, "none.json")],
        ["reset", "--yes"],
      ]) {
        const run = result(verb);
        expect(run.exitCode).not.toBe(0);
        expect(run.stderr).toContain("differs from SHA256SUMS");
        expect(run.stderr).not.toContain("LIBRARY_RAN_BEFORE_CHECK");
      }
      cpSync(
        join(unpacked, "scripts/lib/test-ops.ts"),
        join(copy, "scripts/lib/test-ops.ts"),
      );
      cpSync(
        join(unpacked, "scripts/lib/backup-lib.sh"),
        join(copy, "scripts/lib/backup-lib.sh"),
      );
      // An unlisted file named SHA256SUMS below the root is still unlisted.
      symlinkSync("/etc/hosts", join(copy, "infra/SHA256SUMS"));
      expect(result(["stop"]).stderr).toContain("does not list");
      const after = existsSync(calls) ? readFileSync(calls, "utf8") : "";
      expect(after).toBe(before);
    },
  );

  bundleTest(
    "renders its compose layers with every bind source inside the bundle",
    () => {
      if (
        Bun.which("docker") === null ||
        sh(["docker", "compose", "version"]).exitCode !== 0
      )
        return;
      const run = sh(
        [
          "docker",
          "compose",
          "--project-name",
          "bundle-render",
          "--profile",
          "apps",
          "-f",
          join(unpacked, "infra/compose.core.yml"),
          "-f",
          join(unpacked, "infra/compose.test-ops.yml"),
          "-f",
          join(unpacked, "infra/compose.test-ops.localstack.yml"),
          "config",
          "--format",
          "json",
        ],
        {
          env: {
            API_IMAGE: pinned("control-host"),
            WORKER_IMAGE: pinned("worker"),
            EGRESS_PROXY_IMAGE: pinned("egress-proxy"),
            POSTGRES_PASSWORD: "x",
            PLATFORM_SETTINGS_DOCUMENT: join(work, "settings.json"),
            EGRESS_AUTHORIZER_TOKEN: "x",
            PLATFORM_SECRET_KEY: "x",
            EGRESS_CREDENTIAL_ALLOWLIST: "api.anthropic.com:443",
            EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST: "localstack:4566",
            EXECUTION_INSTALLATION_ID: "bundle-render",
            EXECUTION_WORKSPACE_QUOTA: "on",
          },
        },
      );
      expect(run.stderr).not.toContain("variable is not set");
      const rendered = JSON.parse(run.stdout) as {
        services: Record<
          string,
          { image?: string; volumes?: { type?: string; source?: string }[] }
        >;
      };
      const sources = Object.values(rendered.services)
        .flatMap((service) => service.volumes ?? [])
        .filter(
          (volume) =>
            volume.type === "bind" &&
            volume.source?.startsWith(unpacked) === true,
        )
        .map((volume) => volume.source as string);
      expect(sources.length).toBeGreaterThan(0);
      for (const source of sources) expect(existsSync(source)).toBe(true);
      // The images are the manifest's, by digest, and nothing is built.
      expect(rendered.services.api?.image).toBe(pinned("control-host"));
      expect(rendered.services.worker?.image).toBe(pinned("worker"));
      expect(rendered.services["egress-proxy"]?.image).toBe(
        pinned("egress-proxy"),
      );
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  bundleTest(
    "setup-link refuses an --out inside the bundle before any docker call",
    () => {
      rmSync(calls, { force: true });
      const out = join(unpacked, "owner-link.json");
      const result = sh(
        [script(), "setup-link", "--email", "owner@example.com", "--out", out],
        { env: env() },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("is inside the release bundle");
      expect(existsSync(out)).toBe(false);
      expect(existsSync(calls) ? readFileSync(calls, "utf8") : "").toBe("");
    },
  );
});

describe("a checkout is never a bundle", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { force: true, recursive: true });
  });
  const tree = (git: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), "test-ops-mode-"));
    dirs.push(dir);
    mkdirSync(join(dir, "scripts/lib"), { recursive: true });
    cpSync(join(root, "scripts/test-ops.sh"), join(dir, "scripts/test-ops.sh"));
    cpSync(
      join(root, "scripts/lib/backup-lib.sh"),
      join(dir, "scripts/lib/backup-lib.sh"),
    );
    writeFileSync(join(dir, "BUNDLE"), "{}\n");
    if (git) sh(["git", "init", "-q", dir]);
    return dir;
  };
  const upgrade = (dir: string) =>
    sh(["bash", join(dir, "scripts/test-ops.sh"), "upgrade", "m.json"], {
      env: { TEST_OPS_ENV_FILE: join(dir, "missing") },
    });

  test("a BUNDLE file in a git work tree does not turn the bundle checks on", () => {
    const stderr = upgrade(tree(true)).stderr;
    expect(stderr).not.toContain("is not in the release bundle");
    expect(stderr).not.toContain("the bundle is incomplete");
  });

  // The tree has no SHA256SUMS, so the bundle check refuses it before any verb.
  test("the same tree outside git is a bundle", () => {
    expect(upgrade(tree(false)).stderr).toContain("the bundle is incomplete");
  });
});
