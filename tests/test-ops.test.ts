import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PutBucketEncryptionCommand } from "@aws-sdk/client-s3";
import { bucketHoldsObjectVersion } from "@werft-ai/storage";
import {
  createMemoryCheckpointObjectStore,
  localstackEnabled,
  withLocalstackBucket,
} from "@werft-ai/testkit";
import { checkpointStorageConfigFromEnv } from "../apps/control-host/src/api/checkpoints.ts";
import {
  checkRender,
  decideUpgrade,
  notResumableOnPrevious,
  type ObjectStoreMode,
  parseReleaseManifest,
  probeRoundTrip,
  probeStore,
  type RenderedModel,
  renderRefusal,
  settingsDigest,
  upgradeImpact,
} from "../scripts/lib/test-ops.ts";
import {
  COMPOSE_RENDER_TIMEOUT_MS,
  TEST_OPS_LAYERS,
  TEST_OPS_STORE_LAYERS,
} from "./compose-layers.ts";

/**
 * scripts/test-ops.sh without a daemon: its argument and settings
 * refusals, and the checks of scripts/lib/test-ops.ts it runs — the release
 * manifest, the rendered installation, the bucket round trip and the
 * upgrade gate. Deploying, upgrading, backing up and reseeding a running
 * installation need a host with Docker.
 */

const repoRoot = join(import.meta.dir, "..");
const script = join(repoRoot, "scripts/test-ops.sh");
const EXAMPLE_MANIFEST = join(repoRoot, "infra/test-ops.release.example.json");

async function run(args: string[], env: Record<string, string>) {
  const handle = Bun.spawn(["bash", script, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    handle.exited,
    new Response(handle.stderr).text(),
    new Response(handle.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
}

describe("scripts/test-ops.sh", () => {
  let dir: string;
  let env: Record<string, string>;
  let calls: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "test-ops-"));
    calls = join(dir, "docker-calls");
    await mkdir(join(dir, "bin"));
    // Any docker call is recorded and fails: none of these cases may reach it.
    await writeFile(
      join(dir, "bin", "docker"),
      `#!/bin/sh\necho "$*" >> "${calls}"\nexit 1\n`,
      { mode: 0o755 },
    );
    await writeFile(join(dir, "settings"), "EXECUTION_INSTALLATION_ID=t\n", {
      mode: 0o600,
    });
    env = {
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
      TEST_OPS_ENV_FILE: join(dir, "settings"),
      TEST_OPS_STATE_DIR: join(dir, "state"),
    };
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  const dockerCalls = () => readFile(calls, "utf8").catch(() => "");

  test("parses as bash", () => {
    expect(Bun.spawnSync(["bash", "-n", script]).exitCode).toBe(0);
  });

  test.each([
    [[]],
    [["launch"]],
    [["deploy"]],
    [["deploy", "a.json", "b.json"]],
    [["upgrade"]],
    [["upgrade", "a.json", "--approve"]],
    [["upgrade", "a.json", "--approve-sessions"]],
    [["status", "extra"]],
    [["start", "release.json"]],
    [["stop", "-v"]],
    [["backup", "--now"]],
    [["backup", "--stop", "--now"]],
    [["key"]],
    [["setup-link"]],
    [["setup-link", "--email", "owner@example.com"]],
    [["setup-link", "--out", "owner-link.json"]],
    [["setup-link", "--email", "owner@example.com", "--out"]],
    [["setup-link", "--email", "owner@example.com", "--out", "f", "x"]],
    [["reseed"]],
    [["reseed", "backups/b", "backups/c"]],
    [["reset"]],
    [["reset", "--force"]],
    [["restore-drill", "--bucket", "drill"]],
    [["restore-drill", "backups/b", "--bucket", "drill", "--port-base", "x"]],
    [["restore-drill", "backups/b", "backups/c", "--bucket", "drill"]],
    [["init-config"]],
    [["init-config", "--console-origin"]],
    [["init-config", "--api-port", "3100"]],
    [
      [
        "init-config",
        "--console-origin",
        "https://werft.example.com",
        "--force",
        "x",
      ],
    ],
  ])("refuses %j with usage, touching nothing", async (args) => {
    const result = await run(args, env);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("scripts/test-ops.sh preflight");
    expect(await dockerCalls()).toBe("");
  });

  describe("init-config", () => {
    const ORIGIN = "https://werft.example.com";
    const SECRETS = [
      "POSTGRES_PASSWORD",
      "EGRESS_AUTHORIZER_TOKEN",
      "PLATFORM_SECRET_KEY",
    ] as const;
    const target = () => join(dir, "init");
    const initEnv = (extra: Record<string, string> = {}) => ({
      ...env,
      TEST_OPS_ENV_FILE: target(),
      AWS_ACCESS_KEY_ID: "",
      AWS_SECRET_ACCESS_KEY: "",
      ...extra,
    });
    const settingsOf = async (file: string) =>
      Object.fromEntries(
        (await readFile(file, "utf8"))
          .split("\n")
          .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
          .map((line) => [
            line.slice(0, line.indexOf("=")),
            line.slice(line.indexOf("=") + 1),
          ]),
      ) as Record<string, string | undefined>;
    const exists = (file: string) =>
      stat(file).then(
        () => true,
        () => false,
      );

    test("writes a new 0600 file with random secrets and prints none", async () => {
      const result = await run(
        [
          "init-config",
          "--console-origin",
          ORIGIN,
          "--api-port",
          "3100",
          "--postgres-port",
          "15432",
          "--localstack-port",
          "14566",
        ],
        initEnv(),
      );
      expect(result.exitCode).toBe(0);
      expect((await stat(target())).mode & 0o777).toBe(0o600);
      const settings = await settingsOf(target());
      expect(settings.POSTGRES_PASSWORD).toMatch(/^[0-9a-f]{32}$/);
      expect(settings.EGRESS_AUTHORIZER_TOKEN).toMatch(/^[0-9a-f]{48}$/);
      expect(settings.PLATFORM_SECRET_KEY).toMatch(/^[0-9a-f]{64}$/);
      for (const name of SECRETS) {
        expect(result.stderr).not.toContain(settings[name] ?? "-");
        expect(result.stdout).not.toContain(settings[name] ?? "-");
      }
      expect(settings).toMatchObject({
        CONSOLE_ORIGIN: ORIGIN,
        EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST: "localstack:4566",
        EXECUTION_INSTALLATION_ID: "test-ops",
        PLATFORM_SETTINGS_DOCUMENT: "/etc/werft/settings.json",
        TEST_OPS_API_PORT: "3100",
        TEST_OPS_LOCALSTACK_PORT: "14566",
        TEST_OPS_POSTGRES_PORT: "15432",
      });
      expect(settings.AWS_ACCESS_KEY_ID).toBeUndefined();
      expect(settings.BOOTSTRAP_TOKEN).toBeUndefined();
      // No temporary file is left beside it.
      expect(
        (await readdir(dir)).filter((name) => name.startsWith(".")),
      ).toEqual([]);

      const second = join(dir, "init-second");
      expect(
        (
          await run(
            ["init-config", "--console-origin", ORIGIN],
            initEnv({ TEST_OPS_ENV_FILE: second }),
          )
        ).exitCode,
      ).toBe(0);
      const other = await settingsOf(second);
      for (const name of SECRETS) expect(other[name]).not.toBe(settings[name]);
      expect(other.TEST_OPS_API_PORT).toBeUndefined();
      expect(await dockerCalls()).toBe("");
    });

    test("never replaces a file that is there", async () => {
      const result = await run(
        ["init-config", "--console-origin", ORIGIN],
        initEnv({ TEST_OPS_ENV_FILE: join(dir, "settings") }),
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("is never replaced");
      expect(await readFile(join(dir, "settings"), "utf8")).toBe(
        "EXECUTION_INSTALLATION_ID=t\n",
      );
    });

    test("refuses a directory it cannot write, naming the command that fixes it", async () => {
      // root writes anywhere.
      if (process.getuid?.() === 0) return;
      await mkdir(join(dir, "closed"), { mode: 0o500 });
      const result = await run(
        ["init-config", "--console-origin", ORIGIN],
        initEnv({ TEST_OPS_ENV_FILE: join(dir, "closed", "settings") }),
      );
      await chmod(join(dir, "closed"), 0o700);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('sudo install -d -m 755 -o "$USER"');
      expect(await exists(join(dir, "closed", "settings"))).toBe(false);
    });

    test("leaves nothing inside a directory that appears at the path meanwhile", async () => {
      // ln finds a directory where init-config found nothing.
      await writeFile(
        join(dir, "bin", "ln"),
        `#!/bin/sh\nmkdir "$2"\nexec /bin/ln "$@"\n`,
        { mode: 0o755 },
      );
      const result = await run(
        ["init-config", "--console-origin", ORIGIN],
        initEnv(),
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("appeared meanwhile");
      expect(await readdir(target())).toEqual([]);
      expect(
        (await readdir(dir)).filter((name) => name.startsWith(".")),
      ).toEqual([]);
    });

    test("removes its copy of the secrets when it is stopped", async () => {
      // awk writes the secrets and is still at it when the signal comes;
      // bash takes the trap once it returns.
      await writeFile(
        join(dir, "bin", "awk"),
        "#!/bin/sh\necho POSTGRES_PASSWORD=x\nsleep 2\n",
        { mode: 0o755 },
      );
      const handle = Bun.spawn(
        ["bash", script, "init-config", "--console-origin", ORIGIN],
        {
          cwd: repoRoot,
          env: { ...process.env, ...initEnv() },
          stderr: "pipe",
        },
      );
      const temporary = async () =>
        (await readdir(dir)).filter((name) =>
          name.startsWith(".test-ops-init"),
        );
      for (let i = 0; i < 100 && (await temporary()).length === 0; i++)
        await Bun.sleep(50);
      expect(await temporary()).toHaveLength(1);
      handle.kill("SIGTERM");
      expect(await handle.exited).not.toBe(0);
      expect(await temporary()).toEqual([]);
      expect(await exists(target())).toBe(false);
    });

    test.each([
      "http://127.0.0.1:8443",
      "http://localhost:8443",
      "http://[::1]:8443",
      "https://console.example.com:8443",
    ])("takes %s as the console origin", async (origin) => {
      const result = await run(
        ["init-config", "--console-origin", origin],
        initEnv(),
      );
      expect(result.exitCode).toBe(0);
      expect((await settingsOf(target())).CONSOLE_ORIGIN).toBe(origin);
    });

    test.each([
      [["--console-origin", "http://werft.example.com"]],
      [["--console-origin", "https://werft.example.com/"]],
      [["--console-origin", "https://werft.example.com/console"]],
      [["--console-origin", "werft.example.com"]],
      [["--console-origin", "https://werft.example.com:0"]],
      [["--console-origin", "https://werft.example.com:65536"]],
      [["--console-origin", ORIGIN, "--api-port", "0"]],
      [["--console-origin", ORIGIN, "--postgres-port", "05432"]],
      [["--console-origin", ORIGIN, "--installation-id", "local"]],
      [["--console-origin", ORIGIN, "--installation-id", "a b"]],
      [["--console-origin", ORIGIN, "--settings-document", "settings.json"]],
      [["--console-origin", ORIGIN, "--s3-bucket", "ops-bucket"]],
    ])("refuses %j, writing nothing", async (args) => {
      const result = await run(["init-config", ...args], initEnv());
      expect(result.exitCode).toBe(1);
      expect(await exists(target())).toBe(false);
      expect(await readdir(dir)).not.toContain("init");
    });

    describe("on s3", () => {
      const S3 = [
        "init-config",
        "--console-origin",
        ORIGIN,
        "--aws-region",
        "ap-northeast-1",
        "--s3-bucket",
      ];
      // Placeholders, not keys.
      const keyId = "IDPLACEHOLDER0000000";
      const key = "placeholder/secret+value=".repeat(2);

      test("takes the API's key from the environment alone", async () => {
        const refused = await run(
          [...S3, "ops-bucket"],
          initEnv({ TEST_OPS_OBJECT_STORE: "s3" }),
        );
        expect(refused.exitCode).toBe(1);
        expect(refused.stderr).toContain(
          "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY",
        );
        expect(await exists(target())).toBe(false);

        const result = await run(
          [...S3, "ops-bucket"],
          initEnv({
            AWS_ACCESS_KEY_ID: keyId,
            AWS_SECRET_ACCESS_KEY: key,
            TEST_OPS_OBJECT_STORE: "s3",
          }),
        );
        expect(result.exitCode).toBe(0);
        expect(result.stderr).not.toContain(key);
        expect(result.stderr).not.toContain(keyId);
        expect(await settingsOf(target())).toMatchObject({
          AWS_ACCESS_KEY_ID: keyId,
          AWS_REGION: "ap-northeast-1",
          AWS_SECRET_ACCESS_KEY: key,
          EGRESS_CREDENTIAL_ALLOWLIST:
            "api.anthropic.com:443,api.openai.com:443,github.com:443,ops-bucket.s3.ap-northeast-1.amazonaws.com:443",
          EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST: "",
          S3_BUCKET: "ops-bucket",
        });
      });

      test("routes a dotted bucket through the regional host", async () => {
        const result = await run(
          [...S3, "ops.bucket"],
          initEnv({
            AWS_ACCESS_KEY_ID: keyId,
            AWS_SECRET_ACCESS_KEY: key,
            TEST_OPS_OBJECT_STORE: "s3",
          }),
        );
        expect(result.exitCode).toBe(0);
        expect(
          (await settingsOf(target())).EGRESS_CREDENTIAL_ALLOWLIST?.split(
            ",",
          ).at(-1),
        ).toBe("s3.ap-northeast-1.amazonaws.com:443");
      });

      test("refuses a key with characters an AWS key has not", async () => {
        const result = await run(
          [...S3, "ops-bucket"],
          initEnv({
            AWS_ACCESS_KEY_ID: keyId,
            AWS_SECRET_ACCESS_KEY: "has space$",
            TEST_OPS_OBJECT_STORE: "s3",
          }),
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr).not.toContain("has space");
        expect(await exists(target())).toBe(false);
      });
    });
  });

  test("setup-link never replaces a file the operator has, touching nothing", async () => {
    const out = join(dir, "owner-link.json");
    await writeFile(out, "keep");
    const result = await run(
      ["setup-link", "--email", "owner@example.com", "--out", out],
      env,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`setup-link: ${out} exists`);
    expect(await readFile(out, "utf8")).toBe("keep");
    expect(await dockerCalls()).toBe("");
  });

  test("refuses the local stack's project name", async () => {
    const result = await run(["status"], {
      ...env,
      TEST_OPS_PROJECT: "werft",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("is the local stack's project");
    expect(await dockerCalls()).toBe("");
  });

  test("needs its env file", async () => {
    const result = await run(["status"], {
      ...env,
      TEST_OPS_ENV_FILE: join(dir, "missing"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      `env file ${join(dir, "missing")} not found`,
    );
    expect(await dockerCalls()).toBe("");
  });

  test.each([0o640, 0o604, 0o620])(
    "refuses an env file with mode %o",
    async (mode) => {
      await chmod(join(dir, "settings"), mode);
      const result = await run(["status"], env);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("open to group or others; chmod 600 it");
      expect(await dockerCalls()).toBe("");
    },
  );

  test("hands the env file to compose and never sources it", async () => {
    const source = await readFile(script, "utf8");
    expect(source).toContain('--env-file "$ENV_FILE"');
    expect(source).not.toMatch(/^\s*(source|\.)\s+"?\$\{?ENV_FILE/m);
  });

  test("refuses a manifest naming an image by tag", async () => {
    const manifest = JSON.parse(await readFile(EXAMPLE_MANIFEST, "utf8"));
    manifest.images.worker = "ghcr.io/jeongjaesoon/werft-worker:v1";
    await writeFile(join(dir, "release.json"), JSON.stringify(manifest));
    const result = await run(["preflight", join(dir, "release.json")], env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "images.worker must be <name>@sha256:<64 hex>",
    );
    expect(await dockerCalls()).toBe("");
  });

  test("preflight refuses a checkout that is not the manifest's source commit", async () => {
    const result = await run(["preflight", EXAMPLE_MANIFEST], env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "the manifest's source_commit is 0123456789abcdef0123456789abcdef01234567; check that commit out first",
    );
    expect(await dockerCalls()).toBe("");
  });

  test("preflight refuses a Docker Engine older than 28", async () => {
    const head = Bun.spawnSync(["git", "-C", repoRoot, "rev-parse", "HEAD"])
      .stdout.toString()
      .trim();
    const dirty = Bun.spawnSync([
      "git",
      "-C",
      repoRoot,
      "status",
      "--porcelain",
      "--untracked-files=no",
    ]).stdout.toString();
    // The checkout check comes first; a working tree with edits stops there.
    if (dirty !== "") return;
    const manifest = JSON.parse(await readFile(EXAMPLE_MANIFEST, "utf8"));
    manifest.source_commit = head;
    await writeFile(join(dir, "release.json"), JSON.stringify(manifest));
    await writeFile(
      join(dir, "bin", "docker"),
      `#!/bin/sh\necho "$*" >> "${calls}"\n[ "$1" = version ] && { echo 27.5.1; exit 0; }\nexit 1\n`,
      { mode: 0o755 },
    );
    const result = await run(["preflight", join(dir, "release.json")], env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Docker Engine 27.5.1 is too old");
  });

  describe("preflight and the modes of what the containers mount", () => {
    // The checkout check comes first; a working tree with edits stops there.
    const dirty =
      Bun.spawnSync([
        "git",
        "-C",
        repoRoot,
        "status",
        "--porcelain",
        "--untracked-files=no",
      ]).stdout.toString() !== "";
    const me = process.getuid?.() ?? 0;
    const cleanTest = test.skipIf(dirty);
    // root walks any directory.
    const unprivilegedTest = test.skipIf(dirty || me === 0);
    // A uid that owns nothing here and is none of the ones the script knows.
    const other = me + 1;
    const refusal = "path(s) the containers mount cannot be read by the user";

    async function file(name: string, mode: number) {
      const path = join(dir, name);
      await writeFile(path, "x\n");
      await chmod(path, mode);
      return path;
    }

    async function directory(name: string, mode: number) {
      const path = join(dir, name);
      await mkdir(path);
      await chmod(path, mode);
      return path;
    }

    // A daemon new enough, and a render of these services and bind sources.
    // `volume` is the daemon's answer to the quota probe's volume calls.
    async function preflightWith(
      services: Record<
        string,
        { binds: string[]; groupAdd?: number[]; image?: string; user?: string }
      >,
      volume = "exit 0",
    ) {
      const head = Bun.spawnSync(["git", "-C", repoRoot, "rev-parse", "HEAD"])
        .stdout.toString()
        .trim();
      const manifest = JSON.parse(await readFile(EXAMPLE_MANIFEST, "utf8"));
      manifest.source_commit = head;
      await writeFile(join(dir, "release.json"), JSON.stringify(manifest));
      const rendered = Object.fromEntries(
        Object.entries(services).map(
          ([name, { binds, groupAdd, image, user }]) => [
            name,
            {
              ...(groupAdd ? { group_add: groupAdd } : {}),
              ...(image ? { image } : {}),
              ...(user ? { user } : {}),
              volumes: [
                { source: "data", target: "/data", type: "volume" },
                ...binds.map((source, i) => ({
                  source,
                  target: `/mount/${i}`,
                  type: "bind",
                })),
              ],
            },
          ],
        ),
      );
      await writeFile(
        join(dir, "render.json"),
        JSON.stringify({ services: rendered }),
      );
      await writeFile(
        join(dir, "bin", "docker"),
        [
          "#!/bin/sh",
          `echo "$*" >> "${calls}"`,
          '[ "$1" = version ] && { echo 29.0.0; exit 0; }',
          '[ "$1 $2" = "compose version" ] && { echo 2.30.0; exit 0; }',
          `[ "$1" = volume ] && { ${volume}; }`,
          `case " $* " in *" config --format json "*) cat "${join(dir, "render.json")}"; exit 0;; esac`,
          "exit 1",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      return run(["preflight", join(dir, "release.json")], env);
    }

    // Past this check, preflight asks the daemon about LocalStack, which the
    // fake docker refuses.
    const passed = "cannot tell whether LocalStack runs";

    cleanTest(
      "refuses what a checkout made under umask 077 holds",
      async () => {
        const sql = await file("0000_m0.sql", 0o600);
        const settings = await file("installation.json", 0o600);
        const unknown = await file("other.conf", 0o640);
        // In the file's group, so its group bits decide, not the others'.
        const grouped = await file("grouped.conf", 0o604);
        const { gid } = await stat(grouped);
        const result = await preflightWith({
          migrate: { binds: [settings], user: `${other}:${other}` },
          postgres: { binds: [sql], image: "postgres:16" },
          slack: {
            binds: [grouped],
            groupAdd: [gid],
            user: `${other}:${other}`,
          },
          tool: { binds: [unknown], image: "example/tool:1" },
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(`  ${sql} (postgres, uid 999)\n`);
        expect(result.stderr).toContain(
          `  ${settings} (migrate, uid ${other})\n`,
        );
        expect(result.stderr).toContain(`  ${grouped} (slack, uid ${other})\n`);
        expect(result.stderr).toContain(`  ${unknown} (tool, uid unknown)\n`);
        expect(result.stderr).toContain(`4 ${refusal}`);
        expect(result.stderr).not.toContain(passed);
      },
    );

    cleanTest(
      "passes a file its reader owns or shares a group with",
      async () => {
        const owned = await file("installation.json", 0o600);
        const shared = await file("shared.conf", 0o640);
        const added = await file("added.conf", 0o640);
        // A new file's group is its directory's on BSD, the creator's on Linux.
        const { gid } = await stat(shared);
        const result = await preflightWith({
          api: { binds: [shared], user: `${other}:${gid}` },
          migrate: { binds: [owned], user: `${me}:${other}` },
          slack: {
            binds: [added],
            groupAdd: [gid],
            user: `${other}:${other}`,
          },
        });
        expect(result.stderr).not.toContain(refusal);
        expect(result.stderr).toContain(passed);
      },
    );

    cleanTest("passes root readers", async () => {
      const script = await file("10-create-resources.sh", 0o700);
      const owned = await file("only-root.conf", 0o600);
      const result = await preflightWith({
        localstack: {
          binds: [script],
          image: "localstack/localstack:3",
        },
        scheduler: { binds: [owned], user: "0:0" },
      });
      expect(result.stderr).not.toContain(refusal);
      expect(result.stderr).toContain(passed);
    });

    // The legacy import skipped dot entries, so the check once did too.
    cleanTest("checks dot entries like any other", async () => {
      const mounted = await directory("mounted", 0o755);
      const hidden = await file(join("mounted", ".hidden"), 0o600);
      const result = await preflightWith({
        migrate: { binds: [mounted], user: `${other}:${other}` },
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`  ${hidden} (migrate, uid ${other})\n`);
      expect(result.stderr).toContain(`1 ${refusal}`);
    });

    cleanTest("refuses a directory its reader cannot search", async () => {
      const mounted = await directory("mounted", 0o700);
      const result = await preflightWith({
        migrate: { binds: [mounted], user: `${other}:${other}` },
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`  ${mounted} (migrate, uid ${other})\n`);
      expect(result.stderr).toContain(`1 ${refusal}`);
    });

    cleanTest("keeps a source with a newline in its name whole", async () => {
      const odd = await file("settings\nnext.json", 0o600);
      const result = await preflightWith({
        migrate: { binds: [odd], user: `${other}:${other}` },
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`  ${odd} (migrate, uid ${other})\n`);
      expect(result.stderr).toContain(`1 ${refusal}`);
    });

    unprivilegedTest("stops when it cannot walk a source", async () => {
      const mounted = await directory("mounted", 0o755);
      await mkdir(join(mounted, "closed"), { mode: 0o000 });
      const result = await preflightWith({
        migrate: { binds: [mounted], user: `${other}:${other}` },
      });
      await chmod(join(mounted, "closed"), 0o755);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        `cannot check the modes under ${mounted}`,
      );
      expect(result.stderr).not.toContain(passed);
    });

    cleanTest(
      "probes the workspace quota with a sized volume and removes it",
      async () => {
        const result = await preflightWith({});
        expect(result.stderr).toContain(passed);
        const volumeCalls = (await dockerCalls())
          .split("\n")
          .filter((line) => line.startsWith("volume "));
        expect(volumeCalls).toHaveLength(2);
        const [create, remove] = volumeCalls;
        const probe = create?.match(
          /^volume create --driver local --opt size=64m (werft-test-ops-quota-probe-\S+)$/,
        )?.[1];
        expect(probe).toBeDefined();
        expect(remove).toBe(`volume rm ${probe}`);
      },
    );

    cleanTest(
      "stops before the render when the data-root has no prjquota",
      async () => {
        const result = await preflightWith(
          {},
          'echo "Error response from daemon: quota size requested but no quota support" >&2; exit 1',
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("no quota support");
        expect(result.stderr).toContain(
          "the workspace quota probe failed (above): Docker's data-root must be on XFS mounted with prjquota",
        );
        expect(result.stderr).toContain(
          "https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/prepare-xfs/",
        );
        expect(await dockerCalls()).not.toContain("config --format json");
        expect(await dockerCalls()).not.toContain("volume rm");
      },
    );

    cleanTest("passes sources made under umask 022", async () => {
      const sql = await file("0000_m0.sql", 0o644);
      const settings = await file("installation.json", 0o644);
      const unknown = await file("other.conf", 0o644);
      const mounted = await directory("mounted", 0o755);
      const result = await preflightWith({
        migrate: { binds: [settings, mounted], user: `${other}:${other}` },
        postgres: { binds: [sql], image: "postgres:16" },
        tool: {
          binds: [unknown, join(dir, "missing")],
          image: "example/tool:1",
        },
      });
      expect(result.stderr).not.toContain(refusal);
      expect(result.stderr).toContain(passed);
    });
  });

  test("refuses an object store it does not know", async () => {
    const result = await run(["status"], {
      ...env,
      TEST_OPS_OBJECT_STORE: "gcs",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "TEST_OPS_OBJECT_STORE must be localstack or s3, not 'gcs'",
    );
    expect(await dockerCalls()).toBe("");
  });

  test("keeps the object store deploy recorded", async () => {
    await mkdir(join(dir, "state"));
    await writeFile(
      join(dir, "state", "installation"),
      "project=werft-test-ops\ninstallation=test-ops\nobject_store=localstack",
    );
    const result = await run(["status"], {
      ...env,
      TEST_OPS_OBJECT_STORE: "s3",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "the installation was deployed on localstack; moving it to s3 is a reset and a new deploy",
    );
    expect(await dockerCalls()).toBe("");
  });

  test.each([
    ["localstack", ["--bucket", "drill"], "drop --bucket"],
    ["s3", [], "restore-drill on s3 needs --bucket"],
  ])("restore-drill on %s refuses %j", async (store, extra, message) => {
    const result = await run(["restore-drill", "backups/b", ...extra], {
      ...env,
      TEST_OPS_OBJECT_STORE: store,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(message);
    expect(await dockerCalls()).toBe("");
  });

  test("status needs a deployed release", async () => {
    const result = await run(["status"], env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no release is deployed");
  });

  // An empty value counts as unset in the script's defaults.
  const noOverrides = {
    TEST_OPS_ENV_FILE: "",
    TEST_OPS_STATE_DIR: "",
    TEST_OPS_PROJECT: "",
  };

  test("defaults the settings file to /etc/werft/test-ops.env", async () => {
    const result = await run(["status"], { ...env, ...noOverrides });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "env file /etc/werft/test-ops.env not found",
    );
    expect(await dockerCalls()).toBe("");
  });

  test("defaults the state directory to /var/lib/werft/test-ops", async () => {
    const result = await run(["status"], {
      ...env,
      ...noOverrides,
      TEST_OPS_ENV_FILE: join(dir, "settings"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "no release is deployed (/var/lib/werft/test-ops/current.json)",
    );
  });

  // A host whose state directory holds no release, but whose project already
  // has data (the state moved or was never written), must not get a second,
  // empty installation started over it.
  test("deploy stops without starting anything when the default project already has data", async () => {
    await writeFile(
      join(dir, "bin", "docker"),
      `#!/bin/sh
echo "$*" >> "${calls}"
case "$*" in
  "volume ls -q --filter label=com.docker.compose.project=werft-test-ops") echo werft-test-ops_postgres-data ;;
esac
exit 0
`,
      { mode: 0o755 },
    );
    const result = await run(["deploy", EXAMPLE_MANIFEST], {
      ...env,
      TEST_OPS_PROJECT: "",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("project 'werft-test-ops' already has");
    expect(result.stderr).toContain("TEST_OPS_PROJECT, TEST_OPS_STATE_DIR");
    const issued = (await dockerCalls()).trim().split("\n");
    expect(issued.some((call) => call.startsWith("compose"))).toBe(false);
    expect(issued).toContain(
      "volume ls -q --filter label=com.docker.compose.project=werft-test-ops",
    );
    await expect(
      readFile(join(dir, "state", "current.json")),
    ).rejects.toThrow();
  });

  // A provider key rotation: the deployed release again,
  // worker unchanged, so nothing is approved ( found it dying under
  // `set -u` and leaving pending.json behind).
  // Each `upgrade` run costs about a second under CI load, so the three cases
  // live in separate tests: one test running all three sat at the 5 s bun limit.
  async function deployedSameWorker() {
    const manifest = JSON.parse(await readFile(EXAMPLE_MANIFEST, "utf8"));
    await mkdir(join(dir, "state"));
    await writeFile(
      join(dir, "state", "current.json"),
      JSON.stringify(manifest),
    );
    await writeFile(join(dir, "release.json"), JSON.stringify(manifest));
    await writeFile(
      join(dir, "state", "installation"),
      "project=werft-test-ops\ninstallation=t\nobject_store=localstack",
    );
    const render = JSON.stringify({
      services: {
        postgres: {
          environment: { POSTGRES_DB: "sessions", POSTGRES_USER: "postgres" },
        },
        scheduler: { environment: { EXECUTION_INSTALLATION_ID: "t" } },
      },
    });
    const stubs: Record<string, string> = {
      // No uncollected checkpoint; every compose call but config succeeds.
      docker: `#!/bin/sh
echo "$*" >> "${calls}"
case "$*" in
  version*) echo 28.0.4 ;;
  "compose version --short") echo 2.38.2 ;;
  *" config --format json") echo '${render}' ;;
  *" --dry-run") echo '{"add":[]}' ;;
esac
exit 0
`,
      git: `#!/bin/sh\ncase "$*" in *rev-parse*) echo ${manifest.source_commit} ;; esac\nexit 0\n`,
      curl: `#!/bin/sh\necho '{"status":"ready"}'\n`,
      // check-render needs the whole installation; the rest is the real helper.
      bun: `#!/bin/sh\ncase "$*" in *check-render*) exit 0 ;; esac\nexec "${process.execPath}" "$@"\n`,
    };
    for (const [name, body] of Object.entries(stubs))
      await writeFile(join(dir, "bin", name), body, { mode: 0o755 });
    return stubs.docker as string;
  }

  test("upgrade to the same worker image needs no approval", async () => {
    await deployedSameWorker();
    const result = await run(["upgrade", join(dir, "release.json")], env);
    expect(result.stderr).not.toContain("unbound variable");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("upgrade: done");
    expect(await dockerCalls()).toContain("up -d --wait");
    expect(
      await readFile(join(dir, "state", "pending.json"), "utf8").catch(
        () => null,
      ),
    ).toBeNull();
  });

  // A stack a compose down or a host restart left down. deploy refuses it (a
  // release is recorded) and upgrade needs a running postgres; start is the one
  // way back, on the volumes that stayed.
  test.each(["start", "stop"])(
    "%s needs a deployed release and touches no container without one",
    async (verb) => {
      const result = await run([verb], env);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/no release is deployed/);
      expect(await dockerCalls()).toBe("");
      expect(
        await readFile(join(dir, "state", "history.log"), "utf8").catch(
          () => null,
        ),
      ).toBeNull();
    },
  );

  // A full disk fails the quota probe too; the scheduler that start and
  // upgrade bring up is what reclaims finished workspaces then.
  test.each(["start", "upgrade"])(
    "%s does not run the quota probe",
    async (verb) => {
      const docker = await deployedSameWorker();
      await writeFile(
        join(dir, "bin", "docker"),
        docker.replace(
          "esac\nexit 0",
          'esac\ncase "$*" in "volume create"*) exit 1 ;; esac\nexit 0',
        ),
        { mode: 0o755 },
      );
      const args =
        verb === "start" ? [verb] : [verb, join(dir, "release.json")];
      const result = await run(args, env);
      expect(result.exitCode).toBe(0);
      expect(await dockerCalls()).not.toContain("volume create");
    },
  );

  test("deploy still refuses a host with a recorded release", async () => {
    await deployedSameWorker();
    const result = await run(["deploy", join(dir, "release.json")], env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("a release is already deployed");
  });

  test("start brings the deployed release up again on the kept volumes", async () => {
    await deployedSameWorker();
    const result = await run(["start"], env);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("start: done");
    const called = await dockerCalls();
    expect(called).toContain("up -d --wait");
    expect(called).not.toContain(" down");
    expect(called).not.toContain(" -v");
    expect(await readFile(join(dir, "state", "history.log"), "utf8")).toContain(
      " start by ",
    );
    expect(
      await readFile(join(dir, "state", "pending.json"), "utf8").catch(
        () => null,
      ),
    ).toBeNull();
  });

  test("a start that fails names a cleanup that needs neither current.json nor a compose file", async () => {
    const docker = await deployedSameWorker();
    await writeFile(
      join(dir, "bin", "docker"),
      docker.replace(
        "esac\nexit 0",
        'esac\ncase "$*" in *" up -d"*) exit 1 ;; esac\nexit 0',
      ),
      { mode: 0o755 },
    );
    const result = await run(["start"], env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      `echo '{"services":{"x":{"image":"alpine:3"}},"networks":{"default":{}}}' | docker compose --project-name werft-test-ops -f - down --remove-orphans`,
    );
    expect(result.stderr).not.toMatch(/ -v( |$)|--volumes/);
  });

  test("start refuses while an upgrade has not finished", async () => {
    await deployedSameWorker();
    await writeFile(join(dir, "state", "pending.json"), "{}");
    const result = await run(["start"], env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("an upgrade to");
    expect(await dockerCalls()).not.toContain(" up ");
  });

  test("start refuses an installation deploy never recorded", async () => {
    await deployedSameWorker();
    await rm(join(dir, "state", "installation"));
    const result = await run(["start"], env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("installation is missing");
    expect(await dockerCalls()).not.toContain(" up ");
  });

  test("start refuses compose files that are not the release's", async () => {
    await deployedSameWorker();
    const manifest = JSON.parse(await readFile(EXAMPLE_MANIFEST, "utf8"));
    // HEAD is not the source commit, and infra/ differs between the two.
    await writeFile(
      join(dir, "bin", "git"),
      `#!/bin/sh\ncase "$*" in *rev-parse*) echo not-${manifest.source_commit} ;; *diff*) exit 1 ;; esac\nexit 0\n`,
      { mode: 0o755 },
    );
    const result = await run(["start"], env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("its infra/ differs");
    expect(await dockerCalls()).not.toContain(" up ");
  });

  test("start accepts another commit whose infra/ is the release's", async () => {
    await deployedSameWorker();
    const manifest = JSON.parse(await readFile(EXAMPLE_MANIFEST, "utf8"));
    await writeFile(
      join(dir, "bin", "git"),
      `#!/bin/sh\ncase "$*" in *rev-parse*) echo not-${manifest.source_commit} ;; esac\nexit 0\n`,
      { mode: 0o755 },
    );
    const result = await run(["start"], env);
    expect(result.exitCode).toBe(0);
    expect(await dockerCalls()).toContain("up -d --wait");
  });

  test("stop takes the containers down and never the volumes", async () => {
    await deployedSameWorker();
    const result = await run(["stop"], env);
    expect(result.exitCode).toBe(0);
    const called = await dockerCalls();
    expect(called).toContain("down --remove-orphans");
    expect(called).not.toMatch(/(^| )-v( |$)|--volumes/m);
    expect(await readFile(join(dir, "state", "history.log"), "utf8")).toContain(
      " stop by ",
    );
  });

  // A host with nothing deployed, on the same stubs.
  async function freshHost(dryRun = `echo '{"add":[]}'`) {
    const docker = await deployedSameWorker();
    await rm(join(dir, "state"), { recursive: true });
    await writeFile(
      join(dir, "bin", "docker"),
      docker.replace(`echo '{"add":[]}'`, dryRun),
      { mode: 0o755 },
    );
  }

  test("deploy refuses when the database lacks the settings document", async () => {
    await freshHost(`echo '{"add":[{"id":"gone"}]}'`);
    const missing = await run(["deploy", join(dir, "release.json")], env);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain(
      "the database does not hold the settings document",
    );
  });

  test("deploy stops at the quota probe before anything starts", async () => {
    await freshHost();
    const docker = await readFile(join(dir, "bin", "docker"), "utf8");
    await writeFile(
      join(dir, "bin", "docker"),
      docker.replace(
        "esac\nexit 0",
        'esac\ncase "$*" in "volume create"*) exit 1 ;; esac\nexit 0',
      ),
      { mode: 0o755 },
    );
    const result = await run(["deploy", join(dir, "release.json")], env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("the workspace quota probe failed");
    expect(await dockerCalls()).not.toContain(" up ");
  });

  test("deploy with the document in the database records the release", async () => {
    await freshHost();
    const result = await run(["deploy", join(dir, "release.json")], env);
    expect(result.stderr).toContain("deploy: done");
    expect(result.exitCode).toBe(0);
    expect(await dockerCalls()).toContain("--dry-run");
  });

  // The console keeps the settings after deploy: what the document says
  // no longer has to be in the database, and a changed one is not imported.
  test("upgrade neither compares the database with the document nor imports a changed one", async () => {
    const docker = await deployedSameWorker();
    await writeFile(
      join(dir, "bin", "docker"),
      docker.replace(`echo '{"add":[]}'`, `echo '{"add":[{"id":"gone"}]}'`),
      { mode: 0o755 },
    );
    const manifest = JSON.parse(
      await readFile(join(dir, "release.json"), "utf8"),
    );
    await writeFile(
      join(dir, "release.json"),
      JSON.stringify({
        ...manifest,
        settings_digest: `sha256:${"b".repeat(64)}`,
      }),
    );
    const result = await run(["upgrade", join(dir, "release.json")], env);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      "the settings document changed; it is not imported into a deployed installation",
    );
    const called = await dockerCalls();
    expect(called).not.toContain("--dry-run");
    expect(called).not.toContain("run --rm --no-deps -T migrate");
  });

  // A settings document the render check refuses (a repository with no GitHub
  // App) stops deploy and upgrade in preflight: no container starts, no
  // pending.json, and the recorded release stays.
  test.each(["deploy", "upgrade"])(
    "%s refuses a settings document the render check rejects before starting anything",
    async (verb) => {
      const manifest = JSON.parse(await readFile(EXAMPLE_MANIFEST, "utf8"));
      await mkdir(join(dir, "state"));
      await writeFile(join(dir, "release.json"), JSON.stringify(manifest));
      await writeFile(
        join(dir, "state", "installation"),
        "project=werft-test-ops\ninstallation=t\nobject_store=localstack",
      );
      if (verb === "upgrade") {
        await writeFile(
          join(dir, "state", "current.json"),
          JSON.stringify(manifest),
        );
        await writeFile(join(dir, "state", "identity"), "installation=t\n");
      }
      const render = JSON.stringify({
        services: {
          postgres: { environment: { POSTGRES_DB: "s", POSTGRES_USER: "p" } },
          scheduler: { environment: { EXECUTION_INSTALLATION_ID: "t" } },
        },
      });
      const stubs: Record<string, string> = {
        docker: `#!/bin/sh
echo "$*" >> "${calls}"
case "$*" in
  version*) echo 28.0.4 ;;
  "compose version --short") echo 2.38.2 ;;
  *" config --format json") echo '${render}' ;;
esac
exit 0
`,
        git: `#!/bin/sh\ncase "$*" in *rev-parse*) echo ${manifest.source_commit} ;; esac\nexit 0\n`,
        curl: `#!/bin/sh\nexit 0\n`,
        bun: `#!/bin/sh\ncase "$*" in *check-render*) echo 'repository sample names no GitHub App' >&2; exit 1 ;; esac\nexec "${process.execPath}" "$@"\n`,
      };
      for (const [name, body] of Object.entries(stubs))
        await writeFile(join(dir, "bin", name), body, { mode: 0o755 });

      const result = await run([verb, join(dir, "release.json")], env);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("repository sample names no GitHub App");
      const called = await dockerCalls();
      expect(called).not.toContain(" up ");
      expect(called).not.toContain(" migrate");
      expect(called).not.toContain(" stop");
      expect(
        await readFile(join(dir, "state", "pending.json"), "utf8").catch(
          () => null,
        ),
      ).toBeNull();
      expect(
        await readFile(join(dir, "state", "current.json"), "utf8").catch(
          () => null,
        ),
      ).toBe(verb === "upgrade" ? JSON.stringify(manifest) : null);
    },
  );

  test("a port compose refuses reaches the operator without its value", async () => {
    await writeFile(
      join(dir, "bin", "docker"),
      `#!/bin/sh\necho 'invalid hostPort: bad-port-marker' >&2\nexit 1\n`,
      { mode: 0o755 },
    );
    const manifest = JSON.parse(await readFile(EXAMPLE_MANIFEST, "utf8"));
    await mkdir(join(dir, "state"));
    await writeFile(
      join(dir, "state", "current.json"),
      JSON.stringify(manifest),
    );
    await writeFile(
      join(dir, "state", "installation"),
      "project=werft-test-ops\ninstallation=t\nobject_store=localstack",
    );
    const result = await run(["status"], env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("one port from 1 to 65535");
    expect(result.stderr).toContain("compose refused the installation");
    expect(result.stderr).not.toContain("bad-port-marker");
  });

  test("reseed checks the render before it stops anything", async () => {
    const source = await readFile(script, "utf8");
    const reseed = source.slice(source.indexOf("\nreseed() {"));
    expect(reseed.indexOf("check_render")).toBeGreaterThan(-1);
    expect(reseed.indexOf("check_render")).toBeLessThan(
      reseed.indexOf("stop_writers"),
    );
  });

  test("checks /readyz at the URL the render names", async () => {
    const manifest = JSON.parse(await readFile(EXAMPLE_MANIFEST, "utf8"));
    await mkdir(join(dir, "state"));
    await writeFile(
      join(dir, "state", "current.json"),
      JSON.stringify(manifest),
    );
    await writeFile(
      join(dir, "state", "installation"),
      "project=werft-test-ops\ninstallation=t\nobject_store=localstack",
    );
    const render = JSON.stringify({
      "x-test-ops-api-url": "http://127.0.0.1:13000",
      services: {
        scheduler: { environment: { EXECUTION_INSTALLATION_ID: "t" } },
      },
    });
    const requests = join(dir, "curl-calls");
    await writeFile(
      join(dir, "bin", "docker"),
      `#!/bin/sh\ncase "$*" in *" config --format json") echo '${render}' ;; esac\nexit 0\n`,
      { mode: 0o755 },
    );
    await writeFile(
      join(dir, "bin", "curl"),
      `#!/bin/sh\necho "$*" >> "${requests}"\necho '{"status":"ready"}'\n`,
      { mode: 0o755 },
    );
    const result = await run(["status"], env);
    expect(result.stdout).toContain('readyz: {"status":"ready"}');
    expect(await readFile(requests, "utf8")).toContain(
      "http://127.0.0.1:13000/readyz",
    );
  });
});

describe("compose's refusal of a render", () => {
  test("drops the port it quotes, on every line, and keeps anything else", () => {
    const refusal =
      "a TEST_OPS_*_PORT setting must be one port from 1 to 65535\n";
    expect(renderRefusal("invalid hostPort: bad-port-marker\n")).toBe(refusal);
    expect(renderRefusal("invalid IP address: 127.0.0.1:bad\n")).toBe(refusal);
    expect(renderRefusal("invalid hostPort: 4566\nsecond-line-marker\n")).toBe(
      refusal,
    );
    const required =
      "error while interpolating services.api: required variable API_IMAGE is missing a value: API_IMAGE must name the released control-host image\n";
    expect(renderRefusal(required)).toBe(required);
  });
});

describe("release manifest", () => {
  test("the example parses", async () => {
    const manifest = parseReleaseManifest(
      JSON.parse(await readFile(EXAMPLE_MANIFEST, "utf8")),
    );
    expect(manifest.images.worker).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  const base = async () =>
    JSON.parse(await readFile(EXAMPLE_MANIFEST, "utf8")) as {
      images: Record<string, unknown>;
      [key: string]: unknown;
    };

  // The running release's manifest was once read with `catalog_revision`
  // in place of the digest; no release since wrote one.
  test("a manifest from before settings documents is refused, running or not", async () => {
    const { settings_digest: _digest, ...rest } = await base();
    const old = { ...rest, catalog_revision: "sha256:abc" };
    expect(() => parseReleaseManifest(old)).toThrow(
      "manifest has unknown key catalog_revision",
    );
    expect(() => parseReleaseManifest(rest)).toThrow(
      "settings_digest must be sha256:<64 hex>",
    );
  });

  test.each([
    ["control_host", "ghcr.io/jeongjaesoon/werft-control-host:latest"],
    ["worker", "ghcr.io/jeongjaesoon/werft-worker"],
    ["egress_proxy", `ghcr.io/x/egress-proxy@sha256:${"a".repeat(63)}`],
    ["worker", `ghcr.io/x/worker@sha512:${"a".repeat(64)}`],
    ["worker", 7],
  ])("refuses images.%s = %p", async (key, value) => {
    const manifest = await base();
    manifest.images[key] = value;
    expect(() => parseReleaseManifest(manifest)).toThrow(
      `images.${key} must be <name>@sha256:<64 hex>`,
    );
  });

  test.each([
    ["source_commit", "main", "source_commit must be a full 40-hex commit"],
    ["source_commit", "0123456", "source_commit must be a full 40-hex commit"],
    ["settings_digest", "v3", "settings_digest must be sha256:<64 hex>"],
    ["tag", "v1", "manifest has unknown key tag"],
  ])("refuses %s = %p", async (key, value, message) => {
    const manifest = await base();
    manifest[key] = value;
    expect(() => parseReleaseManifest(manifest)).toThrow(message);
  });
});

describe("rendered installation", () => {
  let scratch: string;
  let document: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "test-ops-settings-"));
    document = join(scratch, "installation.json");
    await writeFile(document, '{"version":1}\n');
  });

  afterEach(async () => {
    await rm(scratch, { force: true, recursive: true });
  });

  // Placeholders only: the render never leaves this process.
  const filler = (c: string) => c.repeat(16);

  /** The real layers rendered as scripts/test-ops.sh renders them. */
  function compose(store: ObjectStoreMode, settings: Record<string, string>) {
    const { PATH = "", HOME = "" } = Bun.env;
    const digest = (c: string) => `@sha256:${c.repeat(64)}`;
    return Bun.spawnSync(
      [
        "docker",
        "compose",
        "--env-file",
        "/dev/null",
        "--profile",
        "apps",
        ...[...TEST_OPS_LAYERS, TEST_OPS_STORE_LAYERS[store]].flatMap(
          (file) => ["-f", join(repoRoot, file)],
        ),
        "config",
        "--format",
        "json",
      ],
      {
        env: {
          PATH,
          HOME,
          API_IMAGE: `ghcr.io/x/control-host${digest("a")}`,
          WORKER_IMAGE: `ghcr.io/x/worker${digest("b")}`,
          EGRESS_PROXY_IMAGE: `ghcr.io/x/egress-proxy${digest("c")}`,
          POSTGRES_PASSWORD: filler("p"),
          EGRESS_AUTHORIZER_TOKEN: "t".repeat(32),
          ...(store === "s3" ? { S3_BUCKET: "ops-bucket" } : {}),
          AWS_ACCESS_KEY_ID: filler("i"),
          AWS_SECRET_ACCESS_KEY: filler("s"),
          PLATFORM_SETTINGS_DOCUMENT: document,
          PLATFORM_SECRET_KEY: filler("m"),
          EXECUTION_WORKSPACE_QUOTA: "on",
          EXECUTION_INSTALLATION_ID: "test-ops",
          ...(store === "s3"
            ? {
                EGRESS_CREDENTIAL_ALLOWLIST:
                  "api.anthropic.com:443,ops-bucket.s3.ap-northeast-1.amazonaws.com:443",
              }
            : {
                EGRESS_CREDENTIAL_ALLOWLIST: "api.anthropic.com:443",
                EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST: "localstack:4566",
              }),
          ...settings,
        },
      },
    );
  }

  /** The layers on an env file alone, as scripts/test-ops.sh hands it to compose. */
  function composeEnvFile(store: ObjectStoreMode, envFile: string) {
    const { PATH = "", HOME = "" } = Bun.env;
    const digest = (c: string) => `@sha256:${c.repeat(64)}`;
    return Bun.spawnSync(
      [
        "docker",
        "compose",
        "--env-file",
        envFile,
        "--profile",
        "apps",
        ...[...TEST_OPS_LAYERS, TEST_OPS_STORE_LAYERS[store]].flatMap(
          (file) => ["-f", join(repoRoot, file)],
        ),
        "config",
        "--format",
        "json",
      ],
      {
        env: {
          PATH,
          HOME,
          API_IMAGE: `ghcr.io/x/control-host${digest("a")}`,
          WORKER_IMAGE: `ghcr.io/x/worker${digest("b")}`,
          EGRESS_PROXY_IMAGE: `ghcr.io/x/egress-proxy${digest("c")}`,
        },
      },
    );
  }

  test.each(["localstack", "s3"] as const)(
    "an init-config file on %s renders as preflight wants it",
    async (store) => {
      const file = join(scratch, "settings");
      const made = Bun.spawnSync(
        [
          "bash",
          join(repoRoot, "scripts/test-ops.sh"),
          "init-config",
          "--console-origin",
          "https://werft.example.com",
          "--settings-document",
          document,
          ...(store === "s3"
            ? ["--aws-region", "ap-northeast-1", "--s3-bucket", "ops-bucket"]
            : []),
        ],
        {
          env: {
            PATH: Bun.env.PATH ?? "",
            HOME: Bun.env.HOME ?? "",
            TEST_OPS_ENV_FILE: file,
            TEST_OPS_OBJECT_STORE: store,
            // Placeholders, not keys.
            AWS_ACCESS_KEY_ID: "IDPLACEHOLDER0000000",
            AWS_SECRET_ACCESS_KEY: "placeholder/secret+value",
          },
        },
      );
      expect(made.stderr.toString()).toContain("init-config: wrote");
      expect(made.exitCode).toBe(0);
      const result = composeEnvFile(store, file);
      expect(result.stderr.toString()).toBe("");
      const model = JSON.parse(result.stdout.toString()) as RenderedModel;
      await checkRender(model, { store });
      expect(model.services?.api?.environment?.CONSOLE_ORIGIN).toBe(
        "https://werft.example.com",
      );
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  function render(
    store: ObjectStoreMode,
    settings: Record<string, string> = {},
  ): RenderedModel {
    const result = compose(store, settings);
    expect(result.stderr.toString()).toBe("");
    return JSON.parse(result.stdout.toString()) as RenderedModel;
  }

  const published = (model: RenderedModel, service: string) =>
    model.services?.[service]?.ports?.map((port) => ({
      host_ip: port.host_ip,
      published: port.published,
      target: port.target,
    }));

  test(
    "without settings the API, postgres and LocalStack keep their loopback ports",
    () => {
      const model = render("localstack");
      expect(published(model, "api")).toEqual([
        { host_ip: "127.0.0.1", published: "3000", target: 3000 },
      ]);
      expect(published(model, "postgres")).toEqual([
        { host_ip: "127.0.0.1", published: "5432", target: 5432 },
      ]);
      expect(published(model, "localstack")).toEqual([
        { host_ip: "127.0.0.1", published: "4566", target: 4566 },
      ]);
      expect(model["x-test-ops-api-url"]).toBe("http://127.0.0.1:3000");
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  test(
    "the LocalStack port moves only the host side, on loopback",
    async () => {
      const model = render("localstack", {
        TEST_OPS_LOCALSTACK_PORT: "14566",
      });
      expect(published(model, "localstack")).toEqual([
        { host_ip: "127.0.0.1", published: "14566", target: 4566 },
      ]);
      // Services still reach it on the compose network's own port.
      expect(model.services?.api?.environment?.AWS_ENDPOINT_URL).toBe(
        "http://localstack:4566",
      );
      await checkRender(model, { store: "localstack" });
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  test(
    "on LocalStack the API is a test installation that gives lost checkpoints up at start; on S3 neither is set",
    () => {
      const trial = render("localstack").services?.api?.environment ?? {};
      expect(trial.INSTALLATION_PROFILE).toBe("test");
      expect(trial.CHECKPOINT_OBJECTS_LOST).toBe("forget");
      // The API's own reading of what the layer hands it: it accepts forget
      // only on a test installation whose object store is LocalStack.
      expect(checkpointStorageConfigFromEnv(trial)).toMatchObject({
        objectsLost: "forget",
      });
      const s3 = render("s3").services?.api?.environment ?? {};
      expect(s3).not.toHaveProperty("INSTALLATION_PROFILE");
      expect(s3).not.toHaveProperty("CHECKPOINT_OBJECTS_LOST");
      expect(checkpointStorageConfigFromEnv(s3)).not.toHaveProperty(
        "objectsLost",
      );
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  test(
    "preflight refuses to move the port of a running LocalStack, not to keep it",
    async () => {
      const model = render("localstack", {
        TEST_OPS_LOCALSTACK_PORT: "14566",
      });
      await checkRender(model, {
        runningLocalstackPort: "14566",
        store: "localstack",
      });
      await expect(
        checkRender(model, {
          runningLocalstackPort: "4566",
          store: "localstack",
        }),
      ).rejects.toThrow("LocalStack runs on port 4566");
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  test(
    "the shell's preflight compares the running port with the render",
    async () => {
      const head = Bun.spawnSync(["git", "-C", repoRoot, "rev-parse", "HEAD"])
        .stdout.toString()
        .trim();
      const dirty = Bun.spawnSync([
        "git",
        "-C",
        repoRoot,
        "status",
        "--porcelain",
        "--untracked-files=no",
      ]).stdout.toString();
      // The checkout check comes first; a working tree with edits stops there.
      if (dirty !== "") return;
      const dir = await mkdtemp(join(tmpdir(), "test-ops-"));
      const manifest = JSON.parse(await readFile(EXAMPLE_MANIFEST, "utf8"));
      manifest.source_commit = head;
      manifest.settings_digest = await settingsDigest(document);
      await writeFile(join(dir, "release.json"), JSON.stringify(manifest));
      await writeFile(join(dir, "settings"), "EXECUTION_INSTALLATION_ID=t\n", {
        mode: 0o600,
      });
      await writeFile(
        join(dir, "render.json"),
        JSON.stringify(
          render("localstack", { TEST_OPS_LOCALSTACK_PORT: "14566" }),
        ),
      );
      await mkdir(join(dir, "bin"));
      await writeFile(
        join(dir, "bin", "docker"),
        `#!/bin/sh
case "$*" in
  version*) echo 29.0.0 ;;
  "compose version"*) echo 2.30.0 ;;
  *" config --format json") cat "${join(dir, "render.json")}" ;;
  *" ps -q localstack") echo running-container ;;
  *" port localstack 4566") echo 127.0.0.1:4566 ;;
esac
exit 0
`,
        { mode: 0o755 },
      );
      const result = await run(["preflight", join(dir, "release.json")], {
        PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
        TEST_OPS_ENV_FILE: join(dir, "settings"),
        TEST_OPS_STATE_DIR: join(dir, "state"),
      });
      await rm(dir, { force: true, recursive: true });
      expect(result.stderr).toContain("LocalStack runs on port 4566");
      expect(result.exitCode).toBe(1);
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  test(
    "the s3 store has no LocalStack, so its port setting changes nothing",
    async () => {
      const model = render("s3", { TEST_OPS_LOCALSTACK_PORT: "14566" });
      expect(model).toEqual(render("s3"));
      await checkRender(model, { store: "s3" });
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  test(
    "the API port moves the published port and the URL together, on loopback",
    async () => {
      const model = render("localstack", {
        TEST_OPS_API_PORT: "13000",
        TEST_OPS_POSTGRES_PORT: "15432",
      });
      expect(published(model, "api")).toEqual([
        { host_ip: "127.0.0.1", published: "13000", target: 3000 },
      ]);
      expect(published(model, "postgres")).toEqual([
        { host_ip: "127.0.0.1", published: "15432", target: 5432 },
      ]);
      expect(model["x-test-ops-api-url"]).toBe("http://127.0.0.1:13000");
      await checkRender(model, { store: "localstack" });
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  test.each(["https://ops.example.test", "https://ops.example.test:443"])(
    "the API URL may name a proxy in front of the installation: %p",
    async (url) => {
      const model = render("localstack", { TEST_OPS_API_URL: url });
      expect(model["x-test-ops-api-url"]).toBe(url);
      await checkRender(model, { store: "localstack" });
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  test(
    "an API port that is its scheme's default passes",
    async () => {
      const model = render("localstack", { TEST_OPS_API_PORT: "80" });
      expect(model["x-test-ops-api-url"]).toBe("http://127.0.0.1:80");
      await checkRender(model, { store: "localstack" });
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  test.each([
    "0",
    "65536",
    "70000",
    "abc",
    "3000-3001",
    "3000:3000",
    "3000/udp",
    "bad:port:marker",
    "4566\nsecond-line-marker",
  ])(
    "preflight refuses the port %p without showing it or a secret",
    async (value) => {
      for (const name of [
        "TEST_OPS_API_PORT",
        "TEST_OPS_POSTGRES_PORT",
        "TEST_OPS_LOCALSTACK_PORT",
      ]) {
        const result = compose("localstack", { [name]: value });
        let refusal = renderRefusal(result.stderr.toString());
        if (result.exitCode === 0) {
          const model = JSON.parse(result.stdout.toString()) as RenderedModel;
          refusal = await checkRender(model, { store: "localstack" }).then(
            () => "",
            (error: Error) => error.message,
          );
        }
        expect({ name, refusal }).toEqual({
          name,
          refusal: expect.stringContaining("one port from 1 to 65535"),
        });
        expect(refusal).not.toContain(value);
        expect(refusal).not.toContain(filler("p"));
        expect(refusal).not.toContain(filler("t"));
        expect(refusal).not.toContain(filler("s"));
      }
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  test.each([
    [
      { TEST_OPS_API_PORT: "15432", TEST_OPS_POSTGRES_PORT: "15432" },
      "services api and postgres both publish port 15432",
    ],
    [
      { TEST_OPS_API_PORT: "14566", TEST_OPS_LOCALSTACK_PORT: "14566" },
      "services api and localstack both publish port 14566",
    ],
    [
      { TEST_OPS_POSTGRES_PORT: "4566" },
      "services localstack and postgres both publish port 4566",
    ],
    [
      { TEST_OPS_LOCALSTACK_PORT: "3000" },
      "services api and localstack both publish port 3000",
    ],
  ])(
    "preflight refuses one port for two services: %j",
    async (settings, message) => {
      const model = render("localstack", settings);
      await expect(checkRender(model, { store: "localstack" })).rejects.toThrow(
        message,
      );
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  test.each([
    ["not a url", "must be scheme://host[:port]"],
    ["ftp://127.0.0.1:3000", "must be http or https"],
    ["http://127.0.0.1:3000/", "must be scheme://host[:port]"],
    ["http://127.0.0.1:3000/api", "must be scheme://host[:port]"],
    ["http://127.0.0.1:3000?x=1", "must be scheme://host[:port]"],
    ["http://127.0.0.1:3000#x", "must be scheme://host[:port]"],
    ["http://ops.example.test:0", "must be scheme://host[:port]"],
    ["http://127.0.0.1:13000", "must use the published API port 3000"],
    ["http://localhost:13000", "must use the published API port 3000"],
    ["http://[::1]:13000", "must use the published API port 3000"],
    ["http://[::ffff:127.0.0.1]:13000", "must use the published API port 3000"],
    ["http://127.0.0.2:13000", "must use the published API port 3000"],
    ["http://localhost.:13000", "must use the published API port 3000"],
    ["http://app.localhost:13000", "must use the published API port 3000"],
    ["http://0.0.0.0:13000", "must use the published API port 3000"],
    ["http://ops{.example.test", "must be scheme://host[:port]"],
  ])(
    "preflight refuses the API URL %p",
    async (url, message) => {
      await expect(
        checkRender(render("localstack", { TEST_OPS_API_URL: url }), {
          store: "localstack",
        }),
      ).rejects.toThrow(message);
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  test(
    "preflight never quotes the API URL, which can carry a credential",
    async () => {
      const url = `http://operator:${filler("p")}@127.0.0.1:3000`;
      const message = await checkRender(
        render("localstack", { TEST_OPS_API_URL: url }),
        { store: "localstack" },
      ).then(
        () => "",
        (error: Error) => error.message,
      );
      expect(message).toContain("must be scheme://host[:port]");
      expect(message).not.toContain(filler("p"));
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  test.each(["localstack", "s3"] as const)(
    "the test-ops layers on %s pass, and the mounted settings document is what the manifest names",
    async (store) => {
      const digest = await settingsDigest(document);
      expect(
        await checkRender(render(store), { settingsDigest: digest, store }),
      ).toBe(digest);
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  test(
    "a render is checked against the store it is meant for",
    async () => {
      await expect(
        checkRender(render("localstack"), { store: "s3" }),
      ).rejects.toThrow("service localstack is local-only");
      await expect(
        checkRender(render("s3"), { store: "localstack" }),
      ).rejects.toThrow("service localstack is missing");
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  test("the settings digest follows the document's bytes", async () => {
    const before = await settingsDigest(document);
    expect(await settingsDigest(document)).toBe(before);
    await writeFile(document, '{"version": 1}\n');
    expect(await settingsDigest(document)).not.toBe(before);
  });

  test(
    "reports every way a render is not a test-ops installation",
    async () => {
      const model = render("s3");
      const services = model.services ?? {};
      const env = (name: string) => {
        const found = services[name]?.environment;
        if (found === undefined) throw new Error(`${name} has no environment`);
        return found;
      };
      services.localstack = { image: "localstack/localstack:3" };
      services["local-s3-init"] = { image: "localstack/localstack:3" };
      services.migrate = { ...services.migrate, build: { context: ".." } };
      services.worker = { ...services.worker, image: "ghcr.io/x/worker:v1" };
      services.postgres = {
        ...services.postgres,
        ports: [{ host_ip: "0.0.0.0", published: "5432", target: 5432 }],
      };
      services["fake-git"] = { image: "ghcr.io/x/control-host:v1" };
      env("api").AUTH_MODE = "none";
      env("api").CHECKPOINT_OBJECT_PROTECTION = "unversioned";
      env("postgres").POSTGRES_PASSWORD = "a/b@c";
      env("scheduler").EXECUTION_WORKSPACE_QUOTA = "off";
      env("scheduler").EXECUTION_INSTALLATION_ID = "local";
      env("egress-proxy").EGRESS_CREDENTIAL_ALLOWLIST = "api.anthropic.com:443";
      env("egress-proxy").EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST =
        "fake-git:3000,fake-messages:4010";
      env("api").AWS_ENDPOINT_URL = "http://localstack:4566";
      const found = await checkRender(model, {
        settingsDigest: `sha256:${"0".repeat(64)}`,
        store: "s3",
      }).then(
        () => "",
        (error: Error) => error.message,
      );
      for (const expected of [
        "service localstack is local-only",
        "service local-s3-init is local-only",
        "service migrate builds its image",
        "service worker runs ghcr.io/x/worker:v1, not an image by digest",
        "service postgres publishes 5432 on 0.0.0.0",
        "service fake-git is local-only",
        "EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST names fake-git:3000, a local-only service",
        "api AUTH_MODE must be api-key",
        "api CHECKPOINT_OBJECT_PROTECTION must be locked",
        "POSTGRES_PASSWORD may hold only letters, digits and . _ ~ -",
        "EXECUTION_WORKSPACE_QUOTA must be on",
        'EXECUTION_INSTALLATION_ID must name this installation, not "local"',
        "EGRESS_CREDENTIAL_ALLOWLIST must name ops-bucket.s3.ap-northeast-1.amazonaws.com:443",
        "EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST names fake-messages:4010, a local-only service",
        "api AWS_ENDPOINT_URL must be unset: the store is AWS S3",
        `the manifest says sha256:${"0".repeat(64)}`,
      ])
        expect(found).toContain(expected);
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  test(
    "reports every way a render is not a LocalStack test-ops installation",
    async () => {
      const model = render("localstack");
      const services = model.services ?? {};
      const api = services.api?.environment;
      const proxy = services["egress-proxy"]?.environment;
      if (api === undefined || proxy === undefined)
        throw new Error("api or egress-proxy has no environment");
      services["fake-messages"] = {
        image: `registry.invalid/fake-messages@sha256:${"d".repeat(64)}`,
      };
      api.AWS_ENDPOINT_URL = "http://127.0.0.1:4566";
      api.S3_BUCKET = "ops-bucket";
      proxy.EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST = "fake-messages:4010";
      const found = await checkRender(model, { store: "localstack" }).then(
        () => "",
        (error: Error) => error.message,
      );
      for (const expected of [
        "service fake-messages is local-only",
        "api AWS_ENDPOINT_URL must be http://localstack:4566",
        "S3_BUCKET must be claude-sessions",
        "EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST must name localstack:4566",
        "EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST names fake-messages:4010, a local-only service",
      ])
        expect(found).toContain(expected);
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  test(
    "refuses a repository without a GitHub App before anything starts, naming the field",
    async () => {
      const model = render("localstack");
      for (const repositories of [
        { sample: { url: "https://github.com/o/r" } },
        { sample: { auth: { kind: "basic" } } },
        { sample: { auth: { kind: "bearer" } } },
      ]) {
        await writeFile(document, JSON.stringify({ version: 1, repositories }));
        const found = await checkRender(model, { store: "localstack" }).then(
          () => "",
          (error: Error) => error.message,
        );
        // Once skipped with a note and a fix to copy; now the import's own
        // refusal, as migrate would give it.
        expect(found).toContain(`settings document ${document}`);
        expect(found).toMatch(/repositories\.sample\.(auth|branch)/);
        expect(found).not.toContain("copy the fixed manifest over it");
      }
      await writeFile(
        document,
        JSON.stringify({
          version: 1,
          repositories: {
            sample: {
              url: "https://github.com/o/r",
              branch: "main",
              auth: { kind: "github_app" },
            },
          },
        }),
      );
      await checkRender(model, { store: "localstack" });
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  test(
    "refuses a settings document migrate would refuse, with migrate's own message",
    async () => {
      const model = render("localstack");
      // An owner run: ids with no credential source.
      await writeFile(
        document,
        JSON.stringify({
          version: 1,
          repositories: {
            sample: {
              url: "https://github.com/o/r",
              branch: "main",
              auth: { kind: "github_app", app_id: 1, installation_id: 1 },
            },
          },
        }),
      );
      await expect(checkRender(model, { store: "localstack" })).rejects.toThrow(
        "repositories.sample.auth: name app_id, installation_id and stored, or none of them to use the App registered in the console",
      );
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  test(
    "refuses an egress authorizer token the egress proxy would not start with",
    async () => {
      const model = render("localstack");
      for (const service of ["api", "egress-proxy"]) {
        const environment = model.services?.[service]?.environment;
        if (environment === undefined) throw new Error(`${service} has no env`);
        environment.EGRESS_AUTHORIZER_TOKEN = "t".repeat(31);
      }
      const found = await checkRender(model, { store: "localstack" }).then(
        () => "",
        (error: Error) => error.message,
      );
      expect(found).toContain(
        "api EGRESS_AUTHORIZER_TOKEN must be at least 32",
      );
      expect(found).toContain(
        "egress-proxy EGRESS_AUTHORIZER_TOKEN must be at least 32",
      );
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  test(
    "refuses the checkout's own settings document",
    async () => {
      const model = render("localstack");
      const volume = model.services?.migrate?.volumes?.find(
        ({ target }) => target === "/settings/installation.json",
      );
      if (volume === undefined) throw new Error("migrate mounts no document");
      volume.source = join(repoRoot, "tests/fixtures/settings/real-model.json");
      await expect(checkRender(model, { store: "localstack" })).rejects.toThrow(
        "is inside the checkout",
      );
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );
});

describe("bucket round trip", () => {
  test("puts, holds, reads back, releases and deletes, leaving nothing", async () => {
    const store = createMemoryCheckpointObjectStore({ versioned: true });
    await probeRoundTrip({
      collector: store,
      key: "test-ops-preflight/probe",
      objects: store,
    });
    expect(await store.listVersions("test-ops-preflight/")).toEqual([]);
  });

  test("names the permission of the step that failed", async () => {
    const store = createMemoryCheckpointObjectStore({ versioned: true });
    await expect(
      probeRoundTrip({
        collector: store,
        key: "test-ops-preflight/probe",
        objects: {
          ...store,
          hold: async () => {
            throw new Error("Access Denied");
          },
        },
      }),
    ).rejects.toThrow(
      "s3:PutObjectLegalHold on test-ops-preflight/probe failed: Access Denied",
    );
  });

  test("refuses a store that gives no versions", async () => {
    const store = createMemoryCheckpointObjectStore();
    await expect(
      probeRoundTrip({ collector: store, key: "k", objects: store }),
    ).rejects.toThrow("the bucket must be versioned");
  });

  // Off rather than skipped where LocalStack is not configured: an
  // undeclared skip fails the integration job.
  (localstackEnabled() ? describe : describe.skip)("on LocalStack", () => {
    const model = (bucket: {
      bucket: string;
      env: { [key: string]: string };
    }): RenderedModel => ({
      services: {
        api: {
          environment: {
            AWS_ACCESS_KEY_ID: bucket.env.accessKeyId ?? null,
            AWS_ENDPOINT_URL: bucket.env.endpoint ?? null,
            AWS_REGION: bucket.env.region ?? null,
            AWS_SECRET_ACCESS_KEY: bucket.env.secretAccessKey ?? null,
            CHECKPOINT_OBJECT_PROTECTION: "locked",
            S3_BUCKET: bucket.bucket,
          },
        },
      },
    });

    test("passes on a locked SSE-S3 bucket and leaves it empty", async () => {
      await withLocalstackBucket(
        async (bucket) => {
          await bucket.s3.send(
            new PutBucketEncryptionCommand({
              Bucket: bucket.bucket,
              ServerSideEncryptionConfiguration: {
                Rules: [
                  {
                    ApplyServerSideEncryptionByDefault: {
                      SSEAlgorithm: "AES256",
                    },
                  },
                ],
              },
            }),
          );
          expect(await probeStore(model(bucket))).toBe(bucket.bucket);
          expect(await bucketHoldsObjectVersion(bucket.s3, bucket.bucket)).toBe(
            false,
          );
        },
        { objectLock: true, prefix: "test-ops-it" },
      );
    });

    test("refuses a bucket without Object Lock", async () => {
      await withLocalstackBucket(
        async (bucket) => {
          await expect(probeStore(model(bucket))).rejects.toThrow(
            "Object Lock not configured",
          );
        },
        { prefix: "test-ops-it" },
      );
    });
  });
});

describe("upgrade gate", () => {
  const from = `ghcr.io/x/worker@sha256:${"a".repeat(64)}`;
  const to = `ghcr.io/x/worker@sha256:${"b".repeat(64)}`;

  test("the same worker image affects nothing", () => {
    expect(
      decideUpgrade({ affected: ["s1"], fromWorker: from, toWorker: from }),
    ).toEqual({ approved: [], proceed: true });
  });

  test("a new worker image with no uncollected checkpoint goes ahead", () => {
    expect(
      decideUpgrade({ affected: [], fromWorker: from, toWorker: to }),
    ).toEqual({ approved: [], proceed: true });
  });

  test("refuses without approval, listing every affected session", () => {
    const verdict = decideUpgrade({
      affected: ["s2", "s1"],
      fromWorker: from,
      toWorker: to,
    });
    expect(verdict.proceed).toBe(false);
    if (verdict.proceed) return;
    expect(verdict.reason).toContain("2 session(s)");
    expect(verdict.reason).toContain("s1\ns2");
  });

  test("goes ahead on exactly the affected sessions, in any order", () => {
    expect(
      decideUpgrade({
        affected: ["s2", "s1"],
        approved: ["s1", "s2", "s1"],
        fromWorker: from,
        toWorker: to,
      }),
    ).toEqual({ approved: ["s1", "s2"], proceed: true });
  });

  test.each([
    [["s1"], "not approved: s2"],
    [["s1", "s2", "s3"], "no longer affected: s3"],
  ])("refuses an approval of %j", (approved, message) => {
    const verdict = decideUpgrade({
      affected: ["s1", "s2"],
      approved,
      fromWorker: from,
      toWorker: to,
    });
    expect(verdict.proceed).toBe(false);
    if (!verdict.proceed) expect(verdict.reason).toContain(message);
  });

  test("the CLI exits 3 on a refusal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "test-ops-gate-"));
    try {
      await writeFile(join(dir, "affected"), "s1\n");
      const result = Bun.spawnSync([
        "bun",
        "run",
        join(repoRoot, "scripts/lib/test-ops.ts"),
        "upgrade-gate",
        from,
        to,
        join(dir, "affected"),
      ]);
      expect(result.exitCode).toBe(3);
      expect(result.stderr.toString()).toContain("upgrade refused");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

describe("worker image upgrade impact", () => {
  const uncollected = ["s1", "s2"];

  test("needs no approval when the target runtime and profile stay compatible", () => {
    expect(
      upgradeImpact({
        exitCode: 0,
        output: [
          "PASS s1@1 plan: ready under locked",
          "PASS s2@2 plan: ready under locked",
          "checkpoints=2 passed=2 failed=0",
        ].join("\n"),
        uncollected,
      }),
    ).toEqual({ affected: [], failClosed: false });
  });

  test("lists only sessions incompatible with the target runtime", () => {
    expect(
      upgradeImpact({
        exitCode: 5,
        output: [
          "PASS s1@1 plan: ready under locked",
          "FAIL s2@2 plan: incompatible with the target image (checkpoint → image): cliVersion 2.1.270 → 2.1.271",
          "checkpoints=2 passed=2 failed=1",
        ].join("\n"),
        uncollected,
      }),
    ).toEqual({ affected: ["s2"], failClosed: false });
  });

  test.each([
    [
      5,
      "FAIL bucket b: Object Lock not configured\ncheckpoints=2 passed=0 failed=1",
    ],
    [1, "verify stopped before plans"],
  ])(
    "falls back to every uncollected session when verification fails",
    (exitCode, output) => {
      expect(upgradeImpact({ exitCode, output, uncollected })).toMatchObject({
        affected: uncollected,
        failClosed: true,
      });
    },
  );

  test("leaves out sessions the replaced image, kept as the previous one, restores", () => {
    // s1 and s2 cannot move to the target; s1 resumes on the image it ran on.
    const target = upgradeImpact({
      exitCode: 5,
      output: [
        "FAIL s1@1 plan: incompatible with the target image (checkpoint → image): sdkVersion 0.3.270 → 0.3.280",
        "FAIL s2@2 plan: incompatible with the target image (checkpoint → image): sdkVersion 0.3.260 → 0.3.280",
        "checkpoints=2 passed=0 failed=2",
      ].join("\n"),
      uncollected,
    });
    const previous = upgradeImpact({
      exitCode: 5,
      output: [
        "PASS s1@1 plan: ready under locked",
        "FAIL s2@2 plan: incompatible with the target image (checkpoint → image): sdkVersion 0.3.260 → 0.3.270",
        "checkpoints=2 passed=1 failed=1",
      ].join("\n"),
      uncollected,
    });
    expect(notResumableOnPrevious({ target, previous })).toEqual(["s2"]);
  });

  test("a check of the previous image that could not finish leaves the target's list whole", () => {
    const previous = upgradeImpact({
      exitCode: 1,
      output: "verify stopped before plans",
      uncollected,
    });
    expect(previous.failClosed).toBe(true);
    expect(
      notResumableOnPrevious({
        target: { affected: ["s2"], failClosed: false },
        previous,
      }),
    ).toEqual(["s2"]);
  });

  test("a target check that failed closed stays whole even where the previous image restores", () => {
    // A same-combination rebuild launches on the target, so a session the
    // target could not be shown to restore must stay on the list.
    const target = upgradeImpact({
      exitCode: 5,
      output: [
        "FAIL s1@1 plan: profile digest could not be computed",
        "checkpoints=1 passed=0 failed=1",
      ].join("\n"),
      uncollected: ["s1"],
    });
    expect(target.failClosed).toBe(true);
    const previous = upgradeImpact({
      exitCode: 0,
      output: [
        "PASS s1@1 plan: ready under locked",
        "checkpoints=1 passed=1 failed=0",
      ].join("\n"),
      uncollected: ["s1"],
    });
    expect(previous.failClosed).toBe(false);
    expect(notResumableOnPrevious({ target, previous })).toEqual(["s1"]);
  });
});
