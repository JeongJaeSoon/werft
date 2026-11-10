import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONNECTION_ENDPOINT_DEFAULTS,
  DEFAULT_MAX_CONCURRENT_BUNDLE_VERIFICATIONS,
} from "@werft-ai/platform";
import { DEFAULT_MAX_GIT_MEMORY_BYTES } from "@werft-ai/storage";
import {
  bakeValues,
  chartVersion,
  publishedImages,
} from "../.github/scripts/chart-package.ts";
import {
  SHUTDOWN_CLOSE_MS,
  SHUTDOWN_DRAIN_MS,
} from "../apps/control-host/src/api/shutdown.ts";
import { PASS_LOOP_ROLES } from "../apps/control-host/src/pass-loop/loop.ts";
import { DEFAULT_MAX_BODY_BYTES_IN_FLIGHT } from "../apps/egress-proxy/src/credential.ts";
import {
  GH_VERSION,
  GIT_LFS_COMPRESS,
  GIT_LFS_GO,
  GIT_LFS_VERSION,
  GIT_LFS_X_NET,
  REMOVED_AFTER_INSTALL,
} from "../scripts/third-party-notices.ts";
import {
  COMPOSE_RENDER_TIMEOUT_MS,
  CORE,
  DATADOG_OVERLAY,
  FAKE_MODEL,
  LOCAL_LAYERS,
  layeredServices,
  REAL_MODEL,
  servicesOf,
  TEST_OPS_LAYERS,
  TEST_OPS_STORE_LAYERS,
} from "./compose-layers.ts";

// What the image definitions promise without a daemon: every app Dockerfile
// pins one and the same base digest, compose points at files that exist, and
// the images workflow builds every app compose runs. Building and smoking the
// images is images.yml's job.

type Row = Record<string, unknown>;

const root = join(import.meta.dir, "..");
const apps = ["control-host", "worker", "egress-proxy"] as const;
/** The apps with a workspace install; the egress proxy imports nothing. */
const installingApps = ["control-host", "worker"] as const;
const EXAMPLE_ENV_PATH = ".env.example";
const read = (path: string) => readFileSync(join(root, path), "utf8");
const CLAUDE_IMAGE_VERIFY =
  "packages/adapters/runtimes/claude/src/image-verify.ts";

const basePins = Object.fromEntries(
  apps.map((app) => {
    const source = read(`apps/${app}/Dockerfile`);
    const pin = source.match(/^ARG BUN_IMAGE=(\S+)$/m)?.[1];
    return [app, { pin, source }];
  }),
) as Record<(typeof apps)[number], { pin?: string; source: string }>;

// The `runtime` stage: what `release` (and, for the control host, `local`)
// ship, up to the next stage.
function shippedStage(source: string): string {
  const start = source.indexOf("\nFROM ${BUN_IMAGE} AS runtime");
  expect(start).toBeGreaterThan(-1);
  const next = source.indexOf("\nFROM ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe("app Dockerfiles", () => {
  test.each(apps)("%s pins its base image by digest", (app) => {
    const { pin, source } = basePins[app];
    expect(pin).toMatch(/^oven\/bun:1\.3\.14@sha256:[0-9a-f]{64}$/);
    // Every FROM goes through the ARG; a literal tag would silently float.
    const froms = source.match(/^FROM .*$/gm) ?? [];
    expect(froms.length).toBeGreaterThan(0);
    // The stages derived from one of ours (pruned, local, release) inherit
    // its base.
    for (const line of froms)
      expect(line).toMatch(
        /^FROM ((--platform=\$BUILDPLATFORM )?\$\{BUN_IMAGE\}|(deps|runtime) AS (pruned|local|release)$)/,
      );
  });

  // Published images are the default target and images.yml names it; the
  // local stack's extras live in a target nothing publishes.
  test.each(apps)("%s ends in a release stage", (app) => {
    const source = basePins[app].source;
    expect(source.trimEnd().split("\n").at(-1)).toBe("FROM runtime AS release");
    expect(source.match(/^FROM .* AS (local|release)$/gm)).toEqual(
      app === "control-host"
        ? ["FROM runtime AS local", "FROM runtime AS release"]
        : ["FROM runtime AS release"],
    );
  });

  test.each(installingApps)(
    "%s prunes test and demo sources before the shipped stage",
    (app) => {
      const source = basePins[app].source;
      expect(source).toMatch(
        /^FROM deps AS pruned\nRUN --mount=type=bind,source=scripts\/image-prune\.sh,target=\/tmp\/image-prune\.sh \\\n {2}sh \/tmp\/image-prune\.sh --delete \/app$/m,
      );
      expect(source).toContain(
        "COPY --from=pruned --chown=1000:1000 /app /app",
      );
      expect(source).not.toContain(
        "COPY --from=deps --chown=1000:1000 /app /app",
      );
    },
  );

  test("the control-host local target adds back only testkit and the demo tools", () => {
    const source = basePins["control-host"].source;
    const local = source.slice(
      source.indexOf("FROM runtime AS local"),
      source.indexOf("FROM runtime AS release"),
    );
    expect(local.match(/^(COPY|RUN) .*$/gm)).toEqual([
      "COPY --from=deps --chown=1000:1000 /app/packages/testkit /app/packages/testkit",
      "COPY --from=deps --chown=1000:1000 /app/apps/control-host/src/api/demo-accounts.ts /app/apps/control-host/src/api/demo-data.ts /app/apps/control-host/src/api/",
    ]);
  });

  test("images.yml builds the release target, and only the local stack builds local", () => {
    const workflow = read(".github/workflows/images.yml");
    expect(workflow.match(/^ {10}target: release$/gm)?.length).toBe(2);
    expect(workflow).not.toMatch(/target: local/);
    const local = read("infra/compose.local.yml");
    // api is also the image of scheduler, slack, reconciler and mock-slack.
    expect(local.match(/^ {6}target: local$/gm)?.length).toBe(3);
    expect(local).not.toMatch(/target: release/);
    expect(read("deploy/kind/up.sh")).toContain("--target local");
  });

  test("the image smoke counts test and demo files in every published image", () => {
    const smoke = read(".github/scripts/image-smoke.sh");
    expect(smoke).toContain('assert_published_tree "$image"');
    expect(smoke).toContain("image-prune.sh --list /app");
    expect(smoke).toContain("Module not found");
  });

  test("all of them share one base digest", () => {
    expect(new Set(apps.map((app) => basePins[app].pin)).size).toBe(1);
  });

  // Types newer than the runtime let a call typecheck that the images then
  // cannot run.
  test("packageManager and @types/bun name the Bun the images run", () => {
    const runtime =
      basePins["control-host"].pin?.match(/^oven\/bun:([^@]+)@/)?.[1];
    const manifest = JSON.parse(read("package.json")) as {
      packageManager: string;
      devDependencies: Record<string, string>;
    };
    expect(runtime).toBeDefined();
    expect(manifest.packageManager).toBe(`bun@${runtime}`);
    expect(manifest.devDependencies["@types/bun"]).toBe(runtime);
    const lock = read("bun.lock");
    expect(lock).toContain(`"@types/bun": "${runtime}"`);
    expect(lock).toContain(`"@types/bun": ["@types/bun@${runtime}"`);
    expect(lock).toContain(`"bun-types": ["bun-types@${runtime}"`);
  });

  test.each(installingApps)("%s installs from the frozen lockfile", (app) => {
    expect(basePins[app].source).toMatch(
      /bun install --frozen-lockfile --production/,
    );
  });

  test("the control-host image carries the generated API reference", () => {
    expect(basePins["control-host"].source).toContain(
      "COPY docs/api/index.html docs/api/scalar.js ./docs/api/",
    );
    const dockerignore = read(".dockerignore");
    expect(dockerignore).toContain("!docs/api/index.html");
    expect(dockerignore).toContain("!docs/api/scalar.js");
  });

  test("test helpers under an app's src/testing stay out of every image", () => {
    const ignored = read(".dockerignore").split("\n");
    expect(ignored).toContain("apps/*/src/testing");
  });

  test("the egress proxy image copies only its own code, which needs no install", () => {
    // The Dockerfile has no `bun install`; a dependency added to the proxy
    // must add one (and the deps stage the other apps have) with it.
    const manifest = JSON.parse(read("apps/egress-proxy/package.json"));
    expect(manifest.dependencies ?? {}).toEqual({});
    const source = basePins["egress-proxy"].source;
    expect(source.match(/^RUN .*$/gm)).toEqual([
      "RUN apt-get update --error-on=any \\",
      "RUN --mount=type=bind,source=scripts/third-party-notices.ts,target=/tmp/third-party-notices.ts \\",
    ]);
    expect(source.match(/^COPY .*$/gm)).toEqual([
      "COPY apps/egress-proxy/package.json ./",
      "COPY THIRD_PARTY_NOTICES.md ./",
      "COPY apps/egress-proxy/src ./src",
    ]);
    expect(source).toMatch(/^USER 1000:1000$/m);
  });

  // every image carries the notices of what it ships, at /app.
  test.each(apps)("%s copies THIRD_PARTY_NOTICES.md into /app", (app) => {
    expect(basePins[app].source).toMatch(
      /^COPY (?:[^\n]* )?THIRD_PARTY_NOTICES\.md \.\/$/m,
    );
    expect(basePins[app].source).toMatch(/^WORKDIR \/app$/m);
  });

  // The Bun pin freezes Debian too, so the stage that ships upgrades it,
  // under the key images.yml changes daily.
  test.each(apps)("%s upgrades Debian in the stage it ships", (app) => {
    const shipped = shippedStage(basePins[app].source);
    expect(shipped).toMatch(
      /^ARG APT_UPGRADE_KEY=\nRUN apt-get update --error-on=any \\\n {2}&& DEBIAN_FRONTEND=noninteractive apt-get upgrade -y --with-new-pkgs \\$/m,
    );
  });

  // the source list is written from the shipped stage's own dpkg
  // database, after the last step that installs; images.yml's --verify
  // catches a later one that changes the packages.
  test.each(apps)(
    "%s writes DEBIAN_SOURCES.md after its last apt-get, before dropping root",
    (app) => {
      const shipped = shippedStage(basePins[app].source);
      const write = shipped.indexOf(
        "bun /tmp/third-party-notices.ts --debian-sources >DEBIAN_SOURCES.md",
      );
      expect(write).toBeGreaterThan(shipped.lastIndexOf("apt-get"));
      expect(write).toBeLessThan(shipped.indexOf("\nUSER "));
      expect(shipped.slice(write)).not.toMatch(/^(RUN|COPY|ADD) /m);
    },
  );

  // The scheduler runs the worker image as the workspace inode helper
  // image-smoke.sh runs the tools themselves.
  test("the worker carries xfsprogs for the inode helper", () => {
    expect(basePins.worker.source).toMatch(/apt-get install .*\bxfsprogs\b/);
  });

  // A session's LFS objects come through the repository route (94S-1095).
  // Built from upstream's pinned source with a patched x/net (94S-1194); the
  // notices name the same versions, and no Go reaches the runtime stage.
  test("the worker carries git-lfs", () => {
    const source = basePins.worker.source;
    expect(source).toContain(`ARG GIT_LFS_VERSION=${GIT_LFS_VERSION}\n`);
    expect(source).toContain(`ARG GIT_LFS_X_NET=${GIT_LFS_X_NET}\n`);
    expect(source).toContain(`ARG GIT_LFS_COMPRESS=${GIT_LFS_COMPRESS}\n`);
    expect(source).toContain(`ARG GIT_LFS_GO=${GIT_LFS_GO}\n`);
    expect(source).toMatch(
      /bun \/tmp\/fetch-pinned\.ts \\\n {2}https:\/\/github\.com\/git-lfs\/git-lfs\/releases\/download\/v\$\{GIT_LFS_VERSION\}\/git-lfs-v\$\{GIT_LFS_VERSION\}\.tar\.gz \\\n {2}[0-9a-f]{64} \\\n {2}\/tmp\/git-lfs-src\.tar\.gz \\\n {2}https:\/\/api\.github\.com\/repos\/git-lfs\/git-lfs\/releases\/assets\/666389036/m,
    );
    for (const arch of ["amd64", "arm64"]) {
      expect(source).toMatch(
        new RegExp(
          `^ADD --checksum=sha256:[0-9a-f]{64} \\\\\\n {2}https://dl\\.google\\.com/go/go\\$\\{GIT_LFS_GO\\}\\.linux-${arch}\\.tar\\.gz \\\\$`,
          "m",
        ),
      );
    }
    for (const file of ["go.mod", "go.sum"])
      expect(source).toMatch(
        new RegExp(
          `echo "[0-9a-f]{64} {2}${file.replace(".", "\\.")}" \\| sha256sum -c -`,
        ),
      );
    // Unpinned packages would reach the build: every input there is pinned by
    // checksum, by ADD or, for the deb, by scripts/fetch-pinned.ts (retries).
    const start = source.indexOf(" AS git-lfs\n");
    const end = source.indexOf(" AS runtime\n");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const stage = source.slice(start, end);
    expect(stage).not.toContain("apt-get");
    expect(stage).toMatch(
      /^RUN --mount=type=bind,source=scripts\/fetch-pinned\.ts,target=\/tmp\/fetch-pinned\.ts \\\n {2}bun \/tmp\/fetch-pinned\.ts \\\n {2}https:\/\/snapshot\.debian\.org\/archive\/debian\/\d{8}T\d{6}Z\/pool\/main\/c\/ca-certificates\/ca-certificates_\S+_all\.deb \\\n {2}[0-9a-f]{64} \\\n {2}\/tmp\/ca-certificates\.deb \\\n {2}&& dpkg-deb -x /m,
    );
    expect(stage).not.toMatch(/ADD [^\n]*\n[^\n]*snapshot\.debian\.org/);
    expect(stage).toContain(
      "\nENV SSL_CERT_DIR=/tmp/ca-certificates/usr/share/ca-certificates/mozilla\n",
    );
    expect(source.match(/^COPY --from=git-lfs .*$/gm)).toEqual([
      "COPY --from=git-lfs /tmp/git-lfs /usr/local/bin/git-lfs",
      "COPY --from=git-lfs /tmp/git-lfs-LICENSE.md /usr/local/share/doc/git-lfs/LICENSE.md",
    ]);
    expect(source).toContain(
      "COPY --from=git-lfs /tmp/git-lfs /usr/local/bin/git-lfs\n",
    );
    expect(source).toContain(
      "COPY --from=git-lfs /tmp/git-lfs-LICENSE.md /usr/local/share/doc/git-lfs/LICENSE.md\n",
    );
    expect(source).not.toMatch(/apt-get install .*\bgit-lfs\b/);
    expect(source).toMatch(
      /^RUN git lfs install --system --skip-repo --skip-smudge$/m,
    );
  });

  test("the worker carries gh from the pinned release", () => {
    const source = basePins.worker.source;
    expect(source).toContain(`ARG GH_VERSION=${GH_VERSION}\n`);
    for (const [arch, asset] of [
      ["amd64", "679195621"],
      ["arm64", "679195636"],
    ]) {
      const lines = source.split("\n");
      const url = `https://github.com/cli/cli/releases/download/v\${GH_VERSION}/gh_\${GH_VERSION}_linux_${arch}.tar.gz`;
      const input = lines.findIndex((line) => line.trim() === `${url} \\`);
      expect(input).toBeGreaterThan(-1);
      expect(lines[input - 1]?.trim()).toBe("bun /tmp/fetch-pinned.ts \\");
      expect(lines[input + 1]?.trim()).toMatch(/^[0-9a-f]{64} \\$/);
      expect(lines[input + 2]?.trim()).toBe(`/tmp/gh-${arch}.tar.gz \\`);
      expect(lines[input + 3]?.trim()).toBe(
        `https://api.github.com/repos/cli/cli/releases/assets/${asset}`,
      );
    }
    expect(source).not.toMatch(/ADD --checksum[^\n]*\n[^\n]*github\.com/);
    expect(source.match(/bun \/tmp\/fetch-pinned\.ts/g)).toHaveLength(4);
    expect(source.match(/^COPY --from=gh .*$/gm)).toEqual([
      "COPY --from=gh /tmp/gh/bin/gh /usr/local/bin/gh",
      "COPY --from=gh /tmp/gh/LICENSE /usr/local/share/doc/gh/LICENSE",
    ]);
  });

  // The API pushes approved sessions over https with git, the worker clones
  // through the proxy's TLS tunnel; both verify the remote.
  test.each(["control-host", "worker"] as const)(
    "the %s image carries ca-certificates for git over https",
    (app) => {
      expect(basePins[app].source).toMatch(
        /apt-get install .*\bca-certificates\b/,
      );
    },
  );

  // The notices list what the image holds, so a package the image build
  // deletes after install (the Claude runtime's image:verify) is left out of them.
  test("the worker deletes exactly what the notices leave out", () => {
    const [pattern] = REMOVED_AFTER_INSTALL.worker;
    const verify = read(CLAUDE_IMAGE_VERIFY);
    expect(verify).toContain(`new Bun.Glob("${pattern}")`);
    expect(verify).toContain(
      "rmSync(join(nodeModules, name), { force: true, recursive: true });",
    );
    expect(REMOVED_AFTER_INSTALL["control-host"]).toEqual([]);
    expect(REMOVED_AFTER_INSTALL["egress-proxy"]).toEqual([]);
  });

  // the site page operate/images-and-supply-chain names this identity; image-smoke.sh commits with it.
  test("the worker gives Claude's commits a default author", () => {
    expect(basePins.worker.source).toContain(
      "git config --system user.name Werft \\\n" +
        "  && git config --system user.email noreply@werft.invalid \\\n" +
        "  && git config --system include.path '~/.werft/git-identity'\n",
    );
  });

  // writeGitTrailers fills the file the commit-msg hook reads; without the
  // system hooksPath no session commit gets its trailers.
  test("the worker runs every client hook through the trailer dispatcher", () => {
    const source = basePins.worker.source;
    expect(source).toContain(
      "COPY --chmod=0755 apps/worker/git-hooks/werft-hook /usr/local/share/werft/git-hooks/werft-hook\n",
    );
    // The hook sources it from its own directory.
    expect(source).toContain(
      "COPY --chmod=0644 apps/worker/git-hooks/werft-trailers.sh /usr/local/share/werft/git-hooks/werft-trailers.sh\n",
    );
    expect(source).toContain(
      "git config --system core.hooksPath /usr/local/share/werft/git-hooks\n",
    );
    expect(source).toMatch(
      /for hook in [^;]*\bcommit-msg\b[^;]*; do ln -s werft-hook "\$hook"; done/,
    );
  });

  test("WORKER_RUNTIME swaps the registry's import, closure and image:verify together", () => {
    const source = basePins.worker.source;
    expect(source).toContain("ARG WORKER_RUNTIME=\n");
    expect(source).toContain("unknown WORKER_RUNTIME");
    const dir = "packages/adapters/runtimes/registry";
    const base = JSON.parse(read(`${dir}/package.json`)) as {
      dependencies: Record<string, string>;
    };
    const variant = JSON.parse(
      read(`${dir}/variants/codex_app_server.package.json`),
    ) as { dependencies: Record<string, string> };
    // The swap must leave exactly one engine package in each registry.
    const engines = (deps: Record<string, string>) =>
      Object.keys(deps).filter((n) =>
        /^@werft-ai\/runtime-(claude|codex)$/.test(n),
      );
    expect(engines(base.dependencies)).toEqual(["@werft-ai/runtime-claude"]);
    expect(engines(variant.dependencies)).toEqual(["@werft-ai/runtime-codex"]);
    expect(read(`${dir}/variants/codex_app_server.ts`)).toContain(
      "installedRuntimes",
    );
  });

  test("only the worker carries the Agent SDK", () => {
    expect(basePins.worker.source).toContain(
      "bun run --filter @werft-ai/runtime-registry image:verify",
    );
    for (const app of ["control-host"] as const) {
      expect(basePins[app].source).toContain(
        "test ! -e node_modules/@anthropic-ai",
      );
    }
  });
});

describe("compose and workflow agree with the Dockerfiles", () => {
  const compose = read(CORE);

  test.each(apps)("compose builds %s from apps/%s/Dockerfile", (app) => {
    expect(read(LOCAL_LAYERS[1])).toContain(
      `dockerfile: apps/${app}/Dockerfile`,
    );
  });

  test("compose gives the API longer to stop than its drain takes", () => {
    const apiBlock = compose.slice(compose.indexOf("\n  api:"));
    const graceSeconds = Number(
      apiBlock.match(/^ {4}stop_grace_period: (\d+)s$/m)?.[1],
    );
    expect(graceSeconds * 1000).toBeGreaterThan(
      SHUTDOWN_DRAIN_MS + SHUTDOWN_CLOSE_MS,
    );
  });

  test("the workflow, the chart and compose name the same images", () => {
    // Not github.repository: renaming the repository must not rename images.
    expect(read(".github/workflows/images.yml")).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow text
      "IMAGE_PREFIX: ${{ github.repository_owner }}/werft\n",
    );
    expect(Bun.YAML.parse(read("deploy/helm/werft/Chart.yaml"))).toMatchObject({
      name: "werft",
    });
    const { images } = Bun.YAML.parse(
      read("deploy/helm/werft/values.yaml"),
    ) as {
      images: Record<
        "controlHost" | "egressProxy" | "worker" | "workerPrevious",
        { repository: string }
      >;
    };
    const owner = "ghcr.io/jeongjaesoon";
    expect(images.controlHost.repository).toBe(`${owner}/werft-control-host`);
    expect(images.egressProxy.repository).toBe(`${owner}/werft-egress-proxy`);
    expect(images.worker.repository).toBe(`${owner}/werft-worker`);
    expect(images.workerPrevious.repository).toBe(`${owner}/werft-worker`);
    for (const app of apps) {
      expect(compose).toContain(`:-werft-${app}:dev}`);
    }
  });

  test("no two services build the same image tag", () => {
    // Two builds exporting one tag race: "image ... already exists".
    const services = localStack();
    const built = Object.values(services)
      .filter((service) => service.build && service.image)
      .map((service) => service.image);
    expect(new Set(built).size).toBe(built.length);
    expect(services.scheduler?.build).toBeUndefined();
    expect(services.scheduler?.image).toBe(services.api?.image);
  });

  test.each(["scheduler", "reconciler", "slack"] as const)(
    "the %s runs as its role's supervised pass loop",
    (role) => {
      const service = localStack()[role];
      const loop = PASS_LOOP_ROLES[role];
      expect(service?.command).toEqual([
        "bun",
        "run",
        "apps/control-host/src/main.ts",
        role,
      ]);
      expect(service?.healthcheck?.test).toEqual([
        "CMD",
        "bun",
        "run",
        "apps/control-host/src/main.ts",
        role,
        "--health",
      ]);
      // Unhealthy alone never restarts a container; the loop exits instead.
      expect(service?.restart).toBe("unless-stopped");
      // Compose's defaults are the loop's own, so neither drifts alone.
      for (const [suffix, value] of [
        ["INTERVAL_SEC", loop.intervalSec],
        ["PASS_TIMEOUT_SEC", loop.passTimeoutSec],
        ["MAX_CONSECUTIVE_FAILURES", loop.maxConsecutiveFailures],
        ["HEALTH_STALE_SEC", loop.healthStaleSec],
      ] as const) {
        const name = `${loop.prefix}_${suffix}`;
        expect(service?.environment?.[name]).toBe(`$` + `{${name}:-${value}}`);
      }
      // Docker waits for the pass in flight to stop before killing the loop.
      const graceSeconds = Number(
        String(service?.stop_grace_period).match(/^(\d+)s$/)?.[1],
      );
      expect(graceSeconds).toBeGreaterThanOrEqual(loop.stopGraceSec + 5);
    },
  );

  test("env example names the variables the scheduler actually reads", () => {
    const example = read(EXAMPLE_ENV_PATH);
    expect(example).not.toContain("WORKER_MEM_LIMIT");
    expect(example).toContain("WORKER_MEMORY_MB=");
    expect(compose).toContain(
      "WORKER_MEMORY_MB: $" + "{WORKER_MEMORY_MB:-4608}",
    );
    // The local daemon has no project quota; the opt-out must be explicit.
    expect(compose).toContain(
      "EXECUTION_WORKSPACE_QUOTA: $" + "{EXECUTION_WORKSPACE_QUOTA:-off}",
    );
  });

  // A credential route's upstream on a forward list is a way round the
  // route: the provider outside cost accounting, the git host without a token,
  // LocalStack into every session's prefix.
  test("the example allowlists name the Codex provider beside the Claude one", () => {
    for (const path of [
      "deploy/helm/werft/values-aws.example.yaml",
      "infra/test-ops.env.example",
    ]) {
      const line = read(path)
        .split("\n")
        .find(
          (l) =>
            /^\s*(credentialAllowlist:|EGRESS_CREDENTIAL_ALLOWLIST=)/.test(l) &&
            !l.trim().startsWith("#"),
        );
      expect(line, path).toContain("api.anthropic.com:443");
      expect(line, path).toContain("api.openai.com:443");
    }
  });

  test("workers reach the provider, the git host and the object store only through the credential routes", () => {
    const forward = ["EGRESS_ALLOWLIST", "EGRESS_PRIVATE_ALLOWLIST"];
    const credential = [
      "EGRESS_CREDENTIAL_ALLOWLIST",
      "EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST",
    ];
    const upstreams = [
      "api.anthropic.com:443",
      "fake-git:3000",
      "fake-messages:4010",
      "fake-mcp:4020",
      "localstack:4566",
    ];
    const proxy = localStack()["egress-proxy"];
    const composeDefault = (name: string) =>
      proxy?.environment?.[name]?.match(
        new RegExp(`^\\$\\{${name}:-([^}]*)\\}$`),
      )?.[1];
    const example = Object.fromEntries(
      read(EXAMPLE_ENV_PATH)
        .split("\n")
        .map((line) => line.match(/^(EGRESS_[A-Z_]+)=(.*)$/)?.slice(1))
        .filter((entry) => entry !== undefined),
    );
    const listOf = (value: string | undefined) =>
      (value ?? "").split(",").filter((entry) => entry !== "");

    for (const name of [...forward, ...credential])
      expect(composeDefault(name)).toBeDefined();
    for (const name of [...forward, "EGRESS_CREDENTIAL_ALLOWLIST"])
      expect(example[name]).toBe(composeDefault(name));
    // The local layer's default stands unless a .env replaces it.
    expect(example.EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST).toBeUndefined();
    expect(servicesOf(CORE)["egress-proxy"]?.environment).toMatchObject({
      EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST:
        "$" + "{EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST:-}",
    });
    const forwarded = forward.flatMap((name) => listOf(composeDefault(name)));
    const routed = credential.flatMap((name) => listOf(composeDefault(name)));
    for (const upstream of upstreams) {
      expect(forwarded).not.toContain(upstream);
      expect(routed).toContain(upstream);
    }
    // The worker gateway alone.
    expect(
      forwarded.every((entry) =>
        /^(api|host\.docker\.internal):3000$/.test(entry),
      ),
    ).toBe(true);

    // The e2e overlays run the product's allowlists; the gate's own are held
    // to the same split.
    for (const overlay of [
      "tests/e2e/compose.yml",
      REAL_MODEL,
      "tests/e2e/compose.ci-mirror.yml",
    ]) {
      expect(
        composeServices(overlay)["egress-proxy"]?.environment,
      ).toBeUndefined();
    }
    const gate = composeServices("scripts/d2-gate/compose.yml")["egress-proxy"]
      ?.environment;
    const gateForward = forward.flatMap((name) => listOf(gate?.[name]));
    expect(gateForward).toEqual(["gate-gateway:3000"]);
  });

  test("no compose layer runs a Gitea, and only the local stack has a git host", () => {
    for (const file of readdirSync(join(root, "infra"))) {
      if (file.endsWith(".yml"))
        expect(read(`infra/${file}`)).not.toMatch(/gitea\/gitea|GITEA__/);
    }
    expect(servicesOf(CORE)["fake-git"]).toBeUndefined();
    expect(layeredServices(TEST_OPS_LAYERS)["fake-git"]).toBeUndefined();
    expect(localStack()["fake-git"]).toBeDefined();
  });

  // Session records keep the repo_url they started with, so the catalogs,
  // the service name and what fake-git serves have to go on agreeing.
  test("the local git host serves every repository the example catalogs name", () => {
    const local = localStack();
    const gitHost = local["fake-git"];
    expect(gitHost?.image).toBeUndefined();
    expect(gitHost?.build?.dockerfile).toBe("apps/control-host/Dockerfile");
    expect(gitHost?.command?.slice(0, 3)).toEqual([
      "bun",
      "run",
      "packages/testkit/src/local-github-main.ts",
    ]);
    expect(gitHost?.environment).toMatchObject({
      AWS_ENDPOINT_URL_SECRETS_MANAGER: "http://secrets:4566",
      AWS_ACCESS_KEY_ID: "test",
      AWS_SECRET_ACCESS_KEY: "test",
    });
    expect(gitHost?.depends_on).toEqual({
      secrets: { condition: "service_healthy" },
    });
    const served = gitHost?.command?.slice(3) ?? [];

    const documents: Record<string, string> = {
      "tests/fixtures/settings/real-model.json": "sample-app",
      "tests/fixtures/settings/fake-model.json": "sample-app",
      "tests/fixtures/settings/local-model.json": "sample-app",
      ".claude/skills/verify-werft/github-sandbox/settings.json": "sample-app",
      "scripts/d2-gate/settings.json": "gate-app",
    };
    for (const [path, repository] of Object.entries(documents)) {
      const { repositories } = JSON.parse(read(path)) as {
        repositories: Record<string, { url: string }>;
      };
      expect(repositories[repository]?.url).toBe(
        `http://fake-git:3000/agent/${repository}.git`,
      );
      expect(served).toContain(repository);
    }
  });

  test("the kind git host keeps the name, port and paths of the example catalogs", () => {
    type Manifest = {
      kind: string;
      metadata: { name: string };
      spec: {
        selector: { app?: string };
        ports: { port: number }[];
        template: {
          metadata: { labels: { app: string } };
          spec: {
            enableServiceLinks?: boolean;
            containers: {
              image: string;
              imagePullPolicy: string;
              command?: string[];
              args: string[];
              readinessProbe: { httpGet: { path: string; port: number } };
            }[];
          };
        };
      };
    };
    const session = read("deploy/kind/deps-session.yaml");
    const [deployment, service] = session
      .split(/^---$/m)
      .map((document) => Bun.YAML.parse(document) as Manifest);
    expect(deployment?.kind).toBe("Deployment");
    expect(deployment?.metadata.name).toBe("fake-git");
    expect(service?.kind).toBe("Service");
    expect(service?.metadata.name).toBe("fake-git");
    // The Service's link variable would overwrite FAKE_GIT_PORT.
    expect(deployment?.spec.template.spec.enableServiceLinks).toBe(false);
    expect(service?.spec.ports).toEqual([{ port: 3000 }]);
    expect(service?.spec.selector.app).toBe(
      deployment?.spec.template.metadata.labels.app,
    );

    const containers = deployment?.spec.template.spec.containers ?? [];
    expect(containers).toHaveLength(1);
    const [gitHost] = containers;
    expect(gitHost?.image).toBe("CONTROL_HOST_IMAGE");
    expect(gitHost?.imagePullPolicy).toBe(
      (
        Bun.YAML.parse(read("deploy/helm/werft/values.yaml")) as {
          images: { pullPolicy: string };
        }
      ).images.pullPolicy,
    );
    expect(gitHost?.command).toBeUndefined();
    expect(gitHost?.args).toEqual([
      "bun",
      "run",
      "packages/testkit/src/local-github-main.ts",
      "sample-app",
      "gate-app",
    ]);
    expect(gitHost?.readinessProbe.httpGet).toEqual({
      path: "/healthz",
      port: 3000,
    });
    expect(read("deploy/kind/up.sh")).toContain(
      "s#CONTROL_HOST_IMAGE#$" +
        "{image_repo}-control-host@$" +
        "{control_host_digest}#",
    );

    for (const model of ["fake", "real"]) {
      const { config } = Bun.YAML.parse(
        read(`deploy/kind/values-${model}-model.yaml`),
      ) as { config: { egress: { credentialPrivateAllowlist: string } } };
      expect(config.egress.credentialPrivateAllowlist.split(",")).toContain(
        "fake-git:3000",
      );
    }
  });

  const apiBlock = compose.slice(
    compose.indexOf("\n  api:"),
    compose.indexOf("\n  worker:"),
  );

  // The API for the git helpers its bundle verifier orphans, the
  // worker for those of a git killed as a group and for the tools Claude Code
  // leaves behind. In the image, not compose or HostConfig, so
  // `docker run` and a scheduler that overrides Cmd get it too; image-smoke.sh
  // checks the running container.
  test.each(["control-host", "worker"] as const)(
    "the %s image runs under an init that reaps the processes it orphans",
    (app) => {
      expect(basePins[app].source).toMatch(
        /^ENTRYPOINT \["\/usr\/bin\/tini", "-s", "--", "\/usr\/local\/bin\/docker-entrypoint\.sh"\]$/m,
      );
      expect(basePins[app].source).toMatch(/apt-get install .*\btini\b/);
    },
  );

  test("the API's memory limit and git cap are set side by side", () => {
    expect(apiBlock).toContain("mem_limit: $" + "{API_MEMORY_MB:-7168}m");
    expect(apiBlock).toContain(
      "CHECKPOINT_GIT_MEMORY_MB: $" + "{CHECKPOINT_GIT_MEMORY_MB:-1536}",
    );
    // The budget comment in compose is arithmetic over these two defaults.
    expect(DEFAULT_MAX_GIT_MEMORY_BYTES).toBe(1536 * 1024 * 1024);
    expect(DEFAULT_MAX_CONCURRENT_BUNDLE_VERIFICATIONS).toBe(2);
    const example = read(EXAMPLE_ENV_PATH);
    expect(example).toContain("API_MEMORY_MB=7168");
    expect(example).toContain("CHECKPOINT_GIT_MEMORY_MB=1536");
  });

  const reconcilerBlock = compose.slice(
    compose.indexOf("\n  reconciler:"),
    compose.indexOf("\n  slack:"),
  );
  const slackBlock = compose.slice(
    compose.indexOf("\n  slack:"),
    compose.indexOf("\nnetworks:"),
  );

  test("the scheduler alone mounts the Docker socket", () => {
    const mounts = compose.match(/\/var\/run\/docker\.sock:/g) ?? [];
    expect(mounts).toHaveLength(1);
    for (const layer of [
      LOCAL_LAYERS[1],
      TEST_OPS_LAYERS[1],
      ...Object.values(TEST_OPS_STORE_LAYERS),
    ])
      expect(read(layer)).not.toContain("docker.sock");
    const schedulerBlock = compose.slice(
      compose.indexOf("\n  scheduler:"),
      compose.indexOf("\n  reconciler:"),
    );
    expect(schedulerBlock).toContain("/var/run/docker.sock:");
    // The reconciler records intent in the database; the scheduler acts on
    // it. Neither a mount nor a DOCKER_HOST gives it the daemon.
    expect(reconcilerBlock).not.toContain("docker.sock");
    expect(reconcilerBlock).not.toContain("DOCKER_HOST");
    expect(reconcilerBlock).not.toMatch(/^ {4}volumes:/m);
  });

  test("the reconciler runs by default as a supervised loop in the apps profile", () => {
    expect(reconcilerBlock.length).toBeGreaterThan(0);
    expect(reconcilerBlock).toContain('profiles: ["apps"]');
    // It runs the image the api service builds rather than building the
    // same tag a second time, which races the api build on export.
    const { api, reconciler } = localStack();
    expect(api?.build?.dockerfile).toBe("apps/control-host/Dockerfile");
    expect(reconciler?.build).toBeUndefined();
    expect(reconciler?.image).toBe(api?.image);
    // It refuses to start with HEARTBEAT_TTL_SEC set, which an env file
    // shared with the API would hand it; nor does it listen on anything.
    expect(reconcilerBlock).not.toContain("env_file");
    expect(reconcilerBlock).not.toContain("HEARTBEAT_TTL_SEC:");
    expect(reconcilerBlock).not.toMatch(/^ {4}ports:/m);
  });

  test("maintenance runs checkpoint GC and a dry-run session archive on the api's image and env", () => {
    const { api, maintenance } = layeredServices<
      ComposeService & { profiles?: string[] }
    >(LOCAL_LAYERS);
    expect(maintenance?.build).toBeUndefined();
    expect(maintenance?.image).toBe(api?.image);
    expect(maintenance?.profiles).toEqual(["apps"]);
    expect(maintenance?.restart).toBe("unless-stopped");
    const script = maintenance?.command?.join(" ") ?? "";
    expect(script).toContain("apps/control-host/src/api/checkpoint-gc.ts");
    expect(script).toContain("apps/control-host/src/api/session-archive.ts");
    // A restart keeps the weekly slot instead of starting a fresh week.
    expect(script).toMatch(/% \$\$\{MAINTENANCE_INTERVAL_SEC\}/);
    for (const [key, fallback] of [
      ["MAINTENANCE_INTERVAL_SEC", "604800"],
      ["SESSION_ARCHIVE_AFTER_DAYS", "180"],
      ["SESSION_ARCHIVE_DRY_RUN", "true"],
    ] as const) {
      expect(maintenance?.environment?.[key]).toEndWith(`:-${fallback}}`);
    }
    // The bucket settings it reads are the api's, so both see one store.
    for (const key of [
      "AWS_ENDPOINT_URL",
      "AWS_REGION",
      "S3_BUCKET",
      "CHECKPOINT_OBJECT_PROTECTION",
      "DATABASE_URL",
    ]) {
      expect(maintenance?.environment?.[key]).toBe(api?.environment?.[key]);
    }
    expect(maintenance?.volumes).toBeUndefined();
    expect(maintenance?.ports).toBeUndefined();
    const testOps = layeredServices<ComposeService>(TEST_OPS_LAYERS);
    expect(testOps.maintenance?.image).toBe(testOps.api?.image);
  });

  // 94S-1422: after a host restart only services with a restart policy come
  // back. postgres, the API and LocalStack had none, so a rebooted single
  // server stayed down until `test-ops.sh start`.
  test("the test-ops stack restarts postgres, the API and LocalStack with the host, the local stack does not", () => {
    const testOps = layeredServices<ComposeService>([
      ...TEST_OPS_LAYERS,
      TEST_OPS_STORE_LAYERS.localstack,
    ]);
    for (const name of ["postgres", "api", "localstack"])
      expect({ name, restart: testOps[name]?.restart }).toEqual({
        name,
        restart: "unless-stopped",
      });
    const local = layeredServices<ComposeService>(LOCAL_LAYERS);
    for (const name of ["postgres", "api"])
      expect(local[name]?.restart).toBeUndefined();
  });

  test("every compose service rotates its json-file log at 50 MB × 5", () => {
    const services = layeredServices<
      ComposeService & {
        logging?: { driver?: string; options?: Record<string, string> };
      }
    >([CORE]);
    expect(Object.keys(services).length).toBeGreaterThan(8);
    for (const [name, service] of Object.entries(services)) {
      expect({ name, logging: service.logging }).toEqual({
        name,
        logging: {
          driver: "json-file",
          options: { "max-file": "5", "max-size": "50m" },
        },
      });
    }
  });

  test("the slack role runs with the apps, or alone in its own profile, on the api's image", () => {
    expect(slackBlock).toContain('profiles: ["apps", "slack"]');
    const { api, slack } = localStack();
    expect(slack?.build).toBeUndefined();
    expect(slack?.image).toBe(api?.image);
    // The developer's .env is the api's, HEARTBEAT_TTL_SEC and all.
    expect(slack?.env_file).toBeUndefined();
    for (const files of [LOCAL_LAYERS, [...LOCAL_LAYERS, FAKE_MODEL]])
      expect(
        Object.keys(
          layeredServices<ComposeService>(files).slack?.environment ?? {},
        ).filter((name) =>
          /^(ANTHROPIC_|AWS_ENDPOINT|AWS_ACCESS|AWS_SECRET)/.test(name),
        ),
      ).toEqual([]);
    expect(slackBlock).not.toContain("docker.sock");
    expect(slackBlock).not.toContain("DOCKER_HOST");
    expect(slackBlock).not.toContain("HEARTBEAT_TTL_SEC:");
    expect(slackBlock).not.toMatch(/^ {4}ports:/m);
  });

  test("the pass-loop roles, and only they, run Bun with --smol", () => {
    for (const files of [LOCAL_LAYERS, TEST_OPS_LAYERS]) {
      const services = layeredServices<ComposeService>(files);
      for (const role of Object.keys(PASS_LOOP_ROLES))
        expect(services[role]?.command?.slice(0, 4)).toEqual([
          "bun",
          "run",
          "apps/control-host/src/main.ts",
          role,
        ]);
      for (const [name, service] of Object.entries(services))
        expect([name, service.environment?.BUN_OPTIONS]).toEqual([
          name,
          name in PASS_LOOP_ROLES ? "--smol" : undefined,
        ]);
    }
  });

  describe("images.yml publishing", () => {
    type Step = {
      uses?: string;
      run?: string;
      env?: Record<string, string>;
      with?: Record<string, unknown>;
    };
    type Job = {
      if?: string;
      needs?: string | string[];
      environment?: string;
      concurrency?: { group: string; "cancel-in-progress": boolean };
      permissions?: Record<string, string>;
      "runs-on"?: string;
      "timeout-minutes"?: number;
      strategy?: { matrix: { app: string[]; arch: string[] | string } };
      steps: Step[];
    };
    const text = read(".github/workflows/images.yml");
    const { jobs, permissions, on, concurrency } = Bun.YAML.parse(text) as {
      jobs: Record<string, Job>;
      permissions: Record<string, string>;
      on: { push: { tags: string[] } };
      concurrency: { group: string; "cancel-in-progress": string };
    };
    const writers = Object.entries(jobs)
      .filter(([, job]) => job.permissions?.packages === "write")
      .map(([name]) => name);
    const runsOf = (job: Job | undefined) =>
      (job?.steps ?? []).map((step) => step.run ?? "").join("\n");
    /** `${{ <body> }}`, spelled so the linter does not read a template slot. */
    const expression = (body: string) => `\${{ ${body} }}`;

    /** A job `if` of plain context checks; any other term is refused. */
    const passes = (
      condition: string | undefined,
      run: { event: string; ref: string },
    ) =>
      (condition ?? "").split(" && ").every((term) => {
        const prefix = term.match(/^startsWith\(github\.ref, '([^']+)'\)$/);
        if (prefix) return run.ref.startsWith(prefix[1] ?? "");
        // The release jobs of a main run: they run only when release-detect
        // found a new version heading, which no row below models.
        if (term === "needs.release-detect.outputs.tag != ''") return false;
        const equal = term.match(/^github\.(event_name|ref) == '([^']+)'$/);
        if (!equal) throw new Error(`unexpected term: ${term}`);
        return (equal[1] === "ref" ? run.ref : run.event) === equal[2];
      });

    test("builds every app without package write", () => {
      expect(text).toContain("app: [control-host, worker, egress-proxy]");
      expect(on.push.tags).toEqual(["v*"]);
      expect(permissions).toEqual({ contents: "read" });
      expect(writers.sort()).toEqual([
        "chart-publish",
        "chart-publish-main",
        "chart-publish-release",
        "index",
        "index-main",
        "promote",
        "promote-main",
        "promote-release",
        "publish",
        "publish-main",
      ]);
      expect(jobs.build?.steps.map((step) => step.with?.push)).toContain(false);
      expect(runsOf(jobs.build)).toContain(".github/scripts/image-smoke.sh");
    });

    test("PRs build amd64 while main and release keep both native architectures", () => {
      const runner = expression(
        "matrix.arch == 'arm64' && 'ubuntu-24.04-arm' || 'ubuntu-24.04'",
      );
      for (const name of ["build", "publish", "publish-main"]) {
        const job = jobs[name];
        // `build` verifies the Codex worker image too; the jobs that publish
        // list only the images a release ships.
        expect(job?.strategy?.matrix).toEqual(
          name === "build"
            ? {
                app: ["control-host", "worker", "worker-codex", "egress-proxy"],
                arch: expression(
                  `github.event_name == 'pull_request' && fromJSON('["amd64"]') || fromJSON('["amd64","arm64"]')`,
                ),
              }
            : {
                app: ["control-host", "worker", "egress-proxy"],
                arch: ["amd64", "arm64"],
              },
        );
        expect(job?.["runs-on"]).toBe(runner);
        const build = job?.steps.find((step) =>
          step.uses?.startsWith("docker/build-push-action@"),
        );
        expect(build?.with?.platforms).toBe(
          `linux/${expression("matrix.arch")}`,
        );
        // One scope per arch, or each build evicts the other's layers.
        expect(build?.with?.["cache-from"]).toBe(
          `type=gha,scope=images-${expression("matrix.app")}-${expression("matrix.arch")}`,
        );
      }
    });

    test("only the build job writes the layer cache, and never for a pull request", () => {
      for (const name of ["publish", "publish-main"]) {
        const build = jobs[name]?.steps.find((step) =>
          step.uses?.startsWith("docker/build-push-action@"),
        );
        expect(build?.with?.["cache-to"]).toBeUndefined();
      }
      const build = jobs.build?.steps.find((step) =>
        step.uses?.startsWith("docker/build-push-action@"),
      );
      expect(build?.with?.["cache-to"]).toBe(
        expression(
          "github.event_name != 'pull_request' && format('type=gha,scope=images-{0}-{1},mode=min', matrix.app, matrix.arch) || ''",
        ),
      );
    });

    test("nothing of one arch overwrites the other's", () => {
      const perArch = `${expression("matrix.app")}-${expression("matrix.arch")}`;
      const uploads = (job: Job | undefined) =>
        (job?.steps ?? [])
          .filter((step) => step.uses?.startsWith("actions/upload-artifact@"))
          .map((step) => [step.with?.name, step.with?.path]);
      expect(uploads(jobs.build)).toEqual([
        [`vulnerabilities-${perArch}`, `vulnerabilities/${perArch}.*`],
        [`image-digest-${perArch}`, `digests/${perArch}.json`],
      ]);
      expect(uploads(jobs.publish)).toEqual([
        [`arch-digest-${perArch}`, `arch-staged/${perArch}.json`],
        [`debian-sources-${perArch}`, `debian-sources/${perArch}.md`],
      ]);
      expect(runsOf(jobs.publish)).toContain(
        "staging=$" +
          "{name}:staging-$" +
          "{GITHUB_RUN_ID}-$" +
          "{GITHUB_RUN_ATTEMPT}-$" +
          '{ARCH}"',
      );
    });

    test.each([
      [
        "push",
        "refs/heads/main",
        ["chart-publish-main", "index-main", "promote-main", "publish-main"],
      ],
      [
        "push",
        "refs/tags/v1.2.3",
        ["chart-publish", "index", "promote", "publish"],
      ],
      ["push", "refs/heads/feature", []],
      ["push", "refs/tags/sdk-v0.1.0", []],
      ["pull_request", "refs/pull/1/merge", []],
      ["schedule", "refs/heads/main", []],
      ["workflow_dispatch", "refs/heads/main", []],
      ["workflow_dispatch", "refs/tags/v1.2.3", []],
    ] as const)("%s of %s publishes through %j", (event, ref, expected) => {
      expect(
        writers.filter((name) => passes(jobs[name]?.if, { event, ref })).sort(),
      ).toEqual([...expected]);
    });

    test("the images follow the owner rather than a spelled namespace", () => {
      expect(text).toContain(
        "IMAGE_PREFIX: $" + "{{ github.repository_owner }}/werft\n",
      );
    });

    test("only the tag path waits for the release environment, once, at publish", () => {
      expect(jobs.publish?.environment).toBe("release");
      for (const name of ["index", "promote", "chart-publish"]) {
        expect(jobs[name]?.environment).toBeUndefined();
      }
      for (const name of ["publish", "index", "promote", "chart-publish"]) {
        expect(jobs[`${name}-main`]?.environment).toBeUndefined();
      }
    });

    test("every later tag-path writer is reachable only through the approved publish", () => {
      const needsOf = (name: string): string[] => {
        const needs = jobs[name]?.needs;
        return needs === undefined ? [] : [needs].flat();
      };
      const reaches = (
        name: string,
        target: string,
        seen = new Set<string>(),
      ) => {
        if (name === target) return true;
        if (seen.has(name)) return false;
        seen.add(name);
        return needsOf(name).some((next) => reaches(next, target, seen));
      };
      for (const name of ["index", "promote", "chart-publish"]) {
        expect(reaches(name, "publish")).toBe(true);
      }
    });

    test("the sources job holds no write, so it needs no approval", () => {
      for (const name of ["sources", "sources-main"]) {
        expect(jobs[name]?.permissions).toBeUndefined();
        expect(jobs[name]?.environment).toBeUndefined();
      }
      expect(jobs["sources-main"]?.if).toBe(jobs["publish-main"]?.if);
      expect(jobs.sources?.if).toBe(jobs.publish?.if);
    });

    test.each([
      ["main", "sources-main"],
      ["release", "sources"],
    ])("the %s budget leaves %s time to report an outage", (mode, name) => {
      const script = read(".github/scripts/image-sources.sh");
      const budget = Number(
        new RegExp(`${mode}\\) budget=(\\d+)`).exec(script)?.[1],
      );
      const timeout = jobs[name]?.["timeout-minutes"] ?? 0;
      expect(budget).toBeGreaterThan(0);
      expect(budget + 300).toBeLessThanOrEqual(timeout * 60);
    });

    test("the chart follows its own path's promotion, and installs before it is pushed", () => {
      expect(jobs.chart?.needs).toBe("promote");
      expect(jobs["chart-main"]?.needs).toBe("promote-main");
      expect(jobs["chart-publish"]?.needs).toBe("chart");
      expect(jobs["chart-publish-main"]?.needs).toBe("chart-main");
      for (const name of ["chart", "chart-main"]) {
        expect(jobs[name]?.permissions).toBeUndefined();
      }
      expect(jobs["chart-main"]?.if).toBe(jobs["publish-main"]?.if);
      expect(jobs.chart?.if).toBe(jobs.publish?.if);
      expect(jobs["chart-publish-main"]?.if).toBe(jobs["publish-main"]?.if);
      expect(jobs["chart-publish"]?.if).toBe(jobs.publish?.if);
      expect(jobs["chart-main"]?.steps).toEqual(jobs.chart?.steps ?? []);
      expect(jobs["chart-publish-main"]?.steps).toEqual(
        jobs["chart-publish"]?.steps ?? [],
      );

      const steps = jobs.chart?.steps ?? [];
      const index = (needle: string) =>
        steps.findIndex((step) => (step.run ?? "").includes(needle));
      const packageStep = index("chart-package.ts published chart-out");
      const read = index("docker manifest inspect");
      const install = index("deploy/kind/up.sh");
      // The suffix is empty on the main and pushed-tag paths, `-release` on
      // the release by merge, so its artifacts do not meet main's.
      const suffix = expression("env.ARTIFACT_SUFFIX");
      const upload = steps.findIndex(
        (step) => step.with?.name === `chart${suffix}`,
      );
      expect(packageStep).toBeGreaterThan(-1);
      expect(read).toBeGreaterThan(packageStep);
      expect(install).toBeGreaterThan(read);
      expect(upload).toBeGreaterThan(install);
      expect(steps[install]?.run).toContain("CHART_PACKAGE=");
      expect(
        steps.flatMap((step) => step.with?.name ?? []).slice(0, 1),
      ).toEqual([`image-digests-published${suffix}`]);
      expect(runsOf(jobs.chart)).not.toContain("docker login");
      expect(runsOf(jobs["chart-publish"])).toContain("chart-push.sh");
    });

    test("the chart's tools are the k8s-smoke job's", () => {
      const smoke = (
        Bun.YAML.parse(read(".github/workflows/ci.yml")) as {
          jobs: Record<string, { env: Record<string, string> }>;
        }
      ).jobs["k8s-smoke"]?.env;
      const { env } = Bun.YAML.parse(text) as { env: Record<string, string> };
      for (const key of [
        "HELM_VERSION",
        "HELM_SHA256",
        "KIND_VERSION",
        "KIND_SHA256",
        "KUBECTL_VERSION",
        "KUBECTL_SHA256",
      ]) {
        expect(env[key]).toBe(smoke?.[key] ?? "missing");
      }
    });

    test("both paths run one list of steps and promote after every image", () => {
      for (const name of ["publish", "sources", "index", "promote"]) {
        expect(jobs[`${name}-main`]?.steps).toEqual(jobs[name]?.steps ?? []);
      }
      // A chain per path: one job needing both would be skipped with the path
      // that did not run, and always() would pass a failed one.
      expect(jobs.sources?.needs).toBe("publish");
      expect(jobs.index?.needs).toBe("sources");
      expect(jobs.promote?.needs).toBe("index");
      expect(jobs["sources-main"]?.needs).toBe("publish-main");
      expect(jobs["index-main"]?.needs).toBe("sources-main");
      expect(jobs["promote-main"]?.needs).toBe("index-main");
      const publish = runsOf(jobs.publish);
      expect(publish).toContain("git merge-base --is-ancestor");
      expect(publish).toContain(
        'image-smoke.sh "$APP" "$' + "{NAME}@$" + '{DIGEST}"',
      );
      expect(publish).toContain(
        'image-licenses.sh "$APP" "$' + "{NAME}@$" + '{DIGEST}"',
      );
      expect(publish).toContain(
        'image-scan.sh "$' +
          "{APP}-$" +
          '{ARCH}" "$' +
          "{NAME}@$" +
          '{DIGEST}"',
      );
      expect(runsOf(jobs.build)).toContain(
        'image-licenses.sh "$APP" "$' + "{NAME}:sha-$" + '{GITHUB_SHA::12}"',
      );
      // Shared steps: the tag path stays strict by the ref, not by the job,
      // and the release by merge (RELEASE_REF set, run ref main) is strict too.
      expect(
        jobs.sources?.steps.flatMap((step) => step.env?.SOURCES_MODE ?? []),
      ).toEqual([
        expression(
          "env.RELEASE_REF == '' && github.ref == 'refs/heads/main' && 'main' || 'release'",
        ),
      ]);
      expect(runsOf(jobs.sources)).toContain(
        'image-sources.sh debian-sources unverified-sources "$SOURCES_MODE" held-sources-prior held-sources',
      );
      // A failed attempt hands its answers on, and the next one takes them
      // only from its own run and its own job.
      for (const name of ["sources", "sources-main"]) {
        const steps = jobs[name]?.steps ?? [];
        const upload = steps.find((step) =>
          String(step.with?.name).startsWith("held-sources-"),
        );
        expect(upload?.if).toBe("always()");
        expect(upload?.with?.name).toBe(
          `held-sources-${expression("github.job")}-${expression("github.run_attempt")}`,
        );
        const download = steps.find((step) =>
          String(step.with?.pattern).startsWith("held-sources-"),
        );
        expect(download?.if).toBe("github.run_attempt > 1");
        expect(download?.with?.pattern).toBe(
          `held-sources-${expression("github.job")}-*`,
        );
      }
      expect(
        jobs.publish?.steps.flatMap((step) => step.with?.push ?? []),
      ).toEqual([true]);
      expect(
        jobs.publish?.steps.flatMap((step) => step.with?.tags ?? []),
      ).toEqual([expression("steps.meta.outputs.staging")]);
      expect(runsOf(jobs.index)).toContain(
        "image-index.sh arch-staged unverified-sources staged",
      );
      expect(runsOf(jobs.promote)).toContain("image-promote.sh staged digests");
      // The digests of a run, for whatever reads them next.
      expect(
        jobs.index?.steps.flatMap((step) => step.with?.name ?? []),
      ).toEqual(["unverified-sources", "staged-digests"]);
      expect(
        jobs.promote?.steps.flatMap((step) => step.with?.name ?? []),
      ).toEqual(["staged-digests", "image-digests-published"]);
    });

    test("a later merge neither drops nor interrupts a main commit", () => {
      // A commit's own group, or the next merge replaces its pending run.
      const mainPush =
        "github.event_name == 'push' && github.ref == 'refs/heads/main'";
      expect(concurrency.group).toContain(`(${mainPush} && github.sha)`);
      expect(concurrency["cancel-in-progress"]).toBe(
        expression(`!(${mainPush})`),
      );
      // Tag promotions serialize repository-wide; two v* tags on one commit
      // share sha-<12>, and the tag check is not atomic.
      expect(jobs.promote?.concurrency).toEqual({
        group: "images-promote",
        "cancel-in-progress": false,
      });
      // In that group a queued entry would replace another merge's promotion.
      expect(jobs["promote-main"]?.concurrency).toBeUndefined();
    });
  });

  describe("chart-package.ts", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const repo = (app: string) => `ghcr.io/jeongjaesoon/werft-${app}`;
    const hex = (c: string) => `sha256:${c.repeat(64)}`;
    const runtime = {
      engine: "claude",
      sdkVersion: "0.3.280",
      cliVersion: "2.1.280",
      profileDigestScheme: 1,
    };
    const records = () => [
      {
        app: "control-host",
        image: repo("control-host"),
        digest: hex("a"),
        promoted: true,
        commit: sha,
        runtime: null,
      },
      {
        app: "egress-proxy",
        image: repo("egress-proxy"),
        digest: hex("b"),
        promoted: true,
        commit: sha,
        runtime: null,
      },
      {
        app: "worker",
        image: repo("worker"),
        digest: hex("c"),
        promoted: true,
        commit: sha,
        runtime,
      },
    ];
    const version = (ref: string, chartYamlVersion = "0.1.0") =>
      chartVersion({ ref, sha, chartYamlVersion, chartName: "werft" });

    test("main prereleases carry the commit in one hyphenated identifier", () => {
      expect(version("refs/heads/main")).toEqual({
        version: "0.1.0-main-0123456789ab",
        appVersion: "main-0123456789ab",
      });
    });

    test.each([
      ["refs/tags/v1.2.3", "1.2.3"],
      ["refs/tags/v1.2.3-rc.1", "1.2.3-rc.1"],
    ])("%s gives chart %s", (ref, expected) => {
      expect(version(ref)).toEqual({
        version: expected,
        appVersion: ref.slice("refs/tags/".length),
      });
    });

    test.each([
      ["refs/tags/v1", /is not v/],
      ["refs/tags/v1.2.3+build.1", /is not v/],
      ["refs/tags/v1.2.3-rc.", /is not v/],
      ["refs/tags/v1.2.3-01", /is not v/],
      ["refs/tags/v01.2.3", /is not v/],
      ["refs/tags/sdk-v0.1.0", /is not v/],
      ["refs/heads/feature", /no chart is published/],
      ["refs/pull/1/merge", /no chart is published/],
      [`refs/tags/v1.2.3-${"a".repeat(60)}`, /label/],
    ])("%s is refused", (ref, message) => {
      expect(() => version(ref)).toThrow(message);
    });

    test("main refuses a Chart.yaml version it cannot extend", () => {
      expect(() => version("refs/heads/main", "1.2.3-rc.1")).toThrow(
        "not X.Y.Z",
      );
    });

    test("takes one promoted image of this commit per app", () => {
      expect(publishedImages(records(), sha).worker).toEqual({
        repository: repo("worker"),
        digest: hex("c"),
        runtime,
      });
    });

    test.each([
      ["a missing app", (r: Row[]) => r.slice(1), /no image record/],
      ["a duplicate", (r: Row[]) => [...r, r[0]], /two image records/],
      ["an unknown app", (r: Row[]) => [{ ...r[0], app: "x" }], /unexpected/],
      [
        "an image never promoted",
        (r: Row[]) => [{ ...r[0], promoted: false }, r[1], r[2]],
        /not promoted/,
      ],
      [
        "another commit",
        (r: Row[]) => [{ ...r[0], commit: "f".repeat(40) }, r[1], r[2]],
        /is of/,
      ],
      [
        "a tag for a digest",
        (r: Row[]) => [{ ...r[0], digest: "main-1" }, r[1], r[2]],
        /has digest/,
      ],
      [
        "a worker without a runtime",
        (r: Row[]) => [r[0], r[1], { ...r[2], runtime: null }],
        /./,
      ],
      [
        "a runtime the readers refuse",
        (r: Row[]) => [r[0], r[1], { ...r[2], runtime: { engine: "e" } }],
        /./,
      ],
    ])("refuses %s", (_label, change, message) => {
      expect(() => publishedImages(change(records()) as Row[], sha)).toThrow(
        message,
      );
    });

    const chartValues = read("deploy/helm/werft/values.yaml");

    test("bakes the digests and runtime and changes nothing else", () => {
      const images = publishedImages(records(), sha);
      const baked = bakeValues(chartValues, images);
      const parsed = Bun.YAML.parse(baked) as {
        images: Record<string, Record<string, unknown>>;
      };
      expect(parsed.images.controlHost?.digest).toBe(hex("a"));
      expect(parsed.images.egressProxy?.digest).toBe(hex("b"));
      expect(parsed.images.worker?.digest).toBe(hex("c"));
      expect(parsed.images.worker?.runtime).toEqual(runtime);
      expect(parsed.images.workerPrevious?.digest).toBe("");
      expect(parsed.images.workerPrevious?.runtime).toEqual({});

      const original = chartValues.split("\n");
      const lines = baked.split("\n");
      expect(lines).toHaveLength(original.length);
      const changed = lines.filter((line, i) => line !== original[i]);
      expect(changed).toHaveLength(4);
      for (const line of changed)
        expect(line).toMatch(/^ {4}(digest|runtime):/);
    });

    test("stops on a repository the chart does not default to", () => {
      const images = publishedImages(records(), sha);
      expect(() =>
        bakeValues(chartValues, {
          ...images,
          worker: { ...images.worker, repository: "ghcr.io/x/werft-worker" },
        }),
      ).toThrow("images.worker.repository is");
    });

    test("stops when values.yaml is not in the form it edits", () => {
      const images = publishedImages(records(), sha);
      const filled = chartValues.replace(
        /^( {2}worker:\n {4}repository: \S+\n {4})digest: ""/m,
        `$1digest: ${hex("d")}`,
      );
      expect(filled).not.toBe(chartValues);
      expect(() => bakeValues(filled, images)).toThrow("known form");
      expect(() => bakeValues("other: 1\n", images)).toThrow("no images block");
    });
  });

  describe("chart-push.sh", () => {
    // A registry of one tgz per version. Anything but the logged-in client
    // sets HELM_REGISTRY_CONFIG, so the fake can tell the two apart.
    const fakeHelm = `#!/usr/bin/env bash
set -euo pipefail
if [ -n "\${HELM_REGISTRY_CONFIG:-}" ]; then who=anonymous; else who=login; fi
echo "$who $1 $2 docker=\${DOCKER_CONFIG:-unset}" >>"$FAKE/log"
case "$1" in
  registry) cat >"$FAKE/token" ;;
  pull)
    if [ "$who" = login ] && [ -n "\${FAKE_LOGIN_SAYS:-}" ]; then echo "$FAKE_LOGIN_SAYS" >&2; exit 1; fi
    if [ "$who" = anonymous ] && [ -n "\${FAKE_ANONYMOUS_BEFORE_PUSH_SAYS:-}" ] && [ ! -f "$FAKE/pushed" ]; then
      echo "$FAKE_ANONYMOUS_BEFORE_PUSH_SAYS" >&2; exit 1
    fi
    if [ "$who" = anonymous ] && [ -n "\${FAKE_ANONYMOUS_AFTER_PUSH_SAYS:-}" ] && [ -f "$FAKE/pushed" ]; then
      echo "$FAKE_ANONYMOUS_AFTER_PUSH_SAYS" >&2; exit 1
    fi
    shift 2
    version=""; dest=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --version) version="$2"; shift 2 ;;
        --destination) dest="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    stored="$FAKE/store/werft-$version.tgz"
    if [ ! -f "$stored" ]; then echo "failed to perform: not found" >&2; exit 1; fi
    cp "$stored" "$dest/"
    ;;
  push) touch "$FAKE/pushed"; cp "$2" "$FAKE/store/" ;;
  show) echo "name: werft" ;;
  *) exit 64 ;;
esac
`;
    const version = "0.1.0-main-0123456789ab";

    const fixture = () => {
      const directory = mkdtempSync(join(tmpdir(), "chart-push-"));
      for (const name of ["bin", "store", "out"])
        mkdirSync(join(directory, name));
      writeFileSync(join(directory, "bin/helm"), fakeHelm, { mode: 0o755 });
      const pack = (target: string, values: string, stamp: string) => {
        const chart = join(directory, `src-${stamp}`, "werft");
        mkdirSync(chart, { recursive: true });
        writeFileSync(join(chart, "values.yaml"), values);
        // A packaging time, as two runs' packages of one chart differ by.
        const packed = Bun.spawnSync([
          "tar",
          "-czf",
          target,
          "-C",
          join(directory, `src-${stamp}`),
          "werft",
        ]);
        expect(packed.exitCode).toBe(0);
      };
      const candidate = join(directory, "out", `werft-${version}.tgz`);
      const stored = join(directory, "store", `werft-${version}.tgz`);
      pack(candidate, "digest: a\n", "candidate");
      const push = (env: Record<string, string> = {}) => {
        const run = Bun.spawnSync(
          [
            "bash",
            join(root, ".github/scripts/chart-push.sh"),
            candidate,
            "ghcr.io/o",
          ],
          {
            env: {
              PATH: `${join(directory, "bin")}:${process.env.PATH ?? ""}`,
              FAKE: directory,
              REGISTRY_TOKEN: "token",
              GITHUB_ACTOR: "actor",
              ...env,
            },
          },
        );
        return {
          code: run.exitCode,
          out: `${run.stdout.toString()}${run.stderr.toString()}`,
        };
      };
      const log = () => readFileSync(join(directory, "log"), "utf8");
      const pushed = () => existsSync(join(directory, "pushed"));
      return { pack, candidate, stored, push, log, pushed };
    };

    test("a new version is pushed and read back with no login at all", () => {
      const repo = fixture();
      const run = repo.push();
      expect(run.code).toBe(0);
      expect(repo.pushed()).toBe(true);
      expect(run.out).toContain("name: werft");
      const lines = repo.log().trim().split("\n");
      expect(lines[0]).toStartWith("login registry login");
      const last = lines.filter((line) => line.startsWith("anonymous"));
      expect(last.map((line) => line.split(" ")[1])).toEqual(["pull", "show"]);
      // Helm falls back to Docker's credentials unless they are cleared too.
      for (const line of last) expect(line).toContain("/no-login");
    });

    test("the same files under a new package time are a rerun, not a write", () => {
      const repo = fixture();
      repo.pack(repo.stored, "digest: a\n", "stored");
      const run = repo.push();
      expect(run.code).toBe(0);
      expect(run.out).toContain("already published");
      expect(repo.pushed()).toBe(false);
    });

    test("other files under the version fail and overwrite nothing", () => {
      const repo = fixture();
      repo.pack(repo.stored, "digest: b\n", "stored");
      const before = readFileSync(repo.stored);
      const run = repo.push();
      expect(run.code).toBe(1);
      expect(run.out).toContain("differs");
      expect(repo.pushed()).toBe(false);
      expect(readFileSync(repo.stored).equals(before)).toBe(true);
    });

    test("denied both ways is the package's first publish", () => {
      const repo = fixture();
      const run = repo.push({
        FAKE_LOGIN_SAYS: "403: denied",
        FAKE_ANONYMOUS_BEFORE_PUSH_SAYS: "403: denied",
      });
      expect(run.code).toBe(0);
      expect(repo.pushed()).toBe(true);
    });

    test("denied to the login, then a broken anonymous lookup, writes nothing", () => {
      const repo = fixture();
      const run = repo.push({
        FAKE_LOGIN_SAYS: "403: denied",
        FAKE_ANONYMOUS_BEFORE_PUSH_SAYS: "500 upstream",
      });
      expect(run.code).toBe(1);
      expect(repo.pushed()).toBe(false);
    });

    test("denied to the login does not hide a public version", () => {
      const repo = fixture();
      repo.pack(repo.stored, "digest: b\n", "stored");
      const run = repo.push({ FAKE_LOGIN_SAYS: "403: denied" });
      expect(run.code).toBe(1);
      expect(repo.pushed()).toBe(false);
    });

    test("a lookup that fails for another reason does not read as absent", () => {
      const repo = fixture();
      const run = repo.push({ FAKE_LOGIN_SAYS: "500 upstream" });
      expect(run.code).toBe(1);
      expect(run.out).toContain("could not look up");
      expect(repo.pushed()).toBe(false);
    });

    test("a chart nobody can read without a login fails the run", () => {
      const repo = fixture();
      const run = repo.push({
        FAKE_ANONYMOUS_AFTER_PUSH_SAYS: "403: denied",
      });
      expect(run.code).toBe(1);
      expect(run.out).toContain("does not read back without a login");
    });
  });

  describe("image-scan.sh", () => {
    const script = join(root, ".github/scripts/image-scan.sh");

    test("a build whose scan got no answer fails the job", () => {
      const build = Bun.YAML.parse(read(".github/workflows/images.yml")) as {
        jobs: {
          build: { steps: { name?: string; "continue-on-error"?: boolean }[] };
        };
      };
      const scan = build.jobs.build.steps.find(
        (step) => step.name === "Vulnerability scan",
      );
      expect(scan).toBeDefined();
      expect(scan?.["continue-on-error"]).toBeUndefined();
    });

    test("a scanner download that keeps failing exits non-zero and leaves error", () => {
      const directory = mkdtempSync(join(tmpdir(), "image-scan-"));
      try {
        mkdirSync(join(directory, "bin"));
        // The pinned checksums are per architecture; pretend to be x86_64 so
        // the run reaches the download on any host.
        writeFileSync(
          join(directory, "bin/uname"),
          "#!/usr/bin/env bash\necho x86_64\n",
          { mode: 0o755 },
        );
        writeFileSync(
          join(directory, "bin/curl"),
          '#!/usr/bin/env bash\necho "$*" >>"$FAKE/curl"\nexit 22\n',
          { mode: 0o755 },
        );
        const result = Bun.spawnSync(
          ["bash", script, "app-amd64", "image:ref", join(directory, "out")],
          {
            env: {
              PATH: `${join(directory, "bin")}:${process.env.PATH ?? ""}`,
              FAKE: directory,
              GITHUB_STEP_SUMMARY: join(directory, "summary"),
            },
          },
        );
        expect(result.exitCode).toBe(22);
        expect(readFileSync(join(directory, "out/app-amd64.txt"), "utf8")).toBe(
          "error\n",
        );
        // A persistent browser failure switches to the independently pinned API.
        // Its bounded retries do not turn a missing scanner into a clean scan.
        const args = readFileSync(join(directory, "curl"), "utf8");
        expect(args).toContain("--retry-all-errors");
        expect(args).toContain(
          "https://api.github.com/repos/anchore/grype/releases/assets/570620608",
        );
        expect(args).toContain("Accept: application/octet-stream");
        expect(args).toMatch(/--retry-delay [1-9]\d*/);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    test.each(["http-error", "wrong-primary", "wrong-fallback"])(
      "the scanner pins both download routes for %s",
      (mode) => {
        const directory = mkdtempSync(join(tmpdir(), "scanner-route-"));
        try {
          for (const path of ["bin", "fixture", "work"])
            mkdirSync(join(directory, path));
          writeFileSync(
            join(directory, "fixture/grype"),
            "verified scanner archive",
          );
          const archive = join(directory, "archive.tgz");
          expect(
            Bun.spawnSync([
              "tar",
              "-czf",
              archive,
              "-C",
              join(directory, "fixture"),
              "grype",
            ]).exitCode,
          ).toBe(0);
          const pin = createHash("sha256")
            .update(readFileSync(archive))
            .digest("hex");
          writeFileSync(
            join(directory, "bin/curl"),
            `#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE/calls"
url="\${!#}"
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then out="$2"; shift 2; else shift; fi
done
if [[ "$url" == https://api.github.com/* ]] && [ "$FAKE_MODE" != wrong-fallback ]; then
  cp "$FAKE/archive.tgz" "$out"
elif [ "$FAKE_MODE" = http-error ]; then
  exit 22
else
  printf 'wrong bytes' >"$out"
fi
`,
            { mode: 0o755 },
          );
          if (!Bun.which("sha256sum"))
            writeFileSync(
              join(directory, "bin/sha256sum"),
              '#!/usr/bin/env bash\nexec shasum -a 256 "$@"\n',
              { mode: 0o755 },
            );
          const source = readFileSync(script, "utf8");
          const start = source.indexOf("if ! curl");
          const end = source.indexOf("# Grype refuses", start);
          expect(start).toBeGreaterThan(-1);
          expect(end).toBeGreaterThan(start);
          const run = Bun.spawnSync(
            ["bash", "-euo", "pipefail", "-c", source.slice(start, end)],
            {
              env: {
                ...process["env"],
                PATH: `${join(directory, "bin")}:${process["env"].PATH ?? ""}`,
                FAKE: directory,
                FAKE_MODE: mode,
                work: join(directory, "work"),
                GRYPE_VERSION: "0.119.0",
                GRYPE_ARCH: "amd64",
                GRYPE_ASSET: "570620608",
                GRYPE_SHA256: pin,
              },
            },
          );
          expect(run.exitCode === 0).toBe(mode !== "wrong-fallback");
          const dest = join(directory, "work/grype");
          if (mode === "wrong-fallback") expect(existsSync(dest)).toBe(false);
          else
            expect(readFileSync(dest, "utf8")).toBe("verified scanner archive");
          const calls = readFileSync(join(directory, "calls"), "utf8");
          expect(calls).toContain(
            "https://github.com/anchore/grype/releases/download/",
          );
          expect(calls).toContain(
            "https://api.github.com/repos/anchore/grype/releases/assets/570620608",
          );
          expect(calls).toContain("Accept: application/octet-stream");
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      },
    );
  });

  describe("image-sources.sh", () => {
    const shared = "https://snapshot.debian.org/package/acl/2.3.2-2/";
    const workerOnly = "https://snapshot.debian.org/package/gh/1/";
    const fakeBun = `#!/usr/bin/env bash
echo "$*" >"$FAKE/check"
printf '%b' "$FAKE_STDERR" >&2
exit "$FAKE_EXIT"
`;
    const lists = ["control-host", "worker", "egress-proxy"].flatMap((app) =>
      ["amd64", "arm64"].map((arch) => ({ app, arch })),
    );
    const run = (
      mode: string,
      exit: number,
      stderr = "",
      skip?: { app: string; arch: string },
    ) => {
      const directory = mkdtempSync(join(tmpdir(), "image-sources-"));
      mkdirSync(join(directory, "bin"));
      mkdirSync(join(directory, "lists"));
      writeFileSync(join(directory, "bin/bun"), fakeBun, { mode: 0o755 });
      for (const { app, arch } of lists) {
        if (skip?.app === app && skip.arch === arch) continue;
        writeFileSync(
          join(directory, "lists", `${app}-${arch}.md`),
          `| acl | 2.3.2-2 | acl |  | ${shared} |\n${
            app === "worker" && arch === "arm64"
              ? `| gh | 1 | gh |  | ${workerOnly} |\n`
              : ""
          }`,
        );
      }
      const result = Bun.spawnSync(
        [
          "bash",
          join(root, ".github/scripts/image-sources.sh"),
          "lists",
          "results",
          mode,
        ],
        {
          cwd: directory,
          env: {
            PATH: `${join(directory, "bin")}:${process.env.PATH ?? ""}`,
            FAKE: directory,
            FAKE_EXIT: String(exit),
            FAKE_STDERR: stderr,
            GITHUB_STEP_SUMMARY: join(directory, "summary"),
          },
        },
      );
      const textOf = (path: string) =>
        existsSync(path) ? readFileSync(path, "utf8") : undefined;
      const listed = (app: string) => {
        const text = textOf(join(directory, "results", `${app}.json`));
        return text === undefined ? undefined : JSON.parse(text);
      };
      return {
        code: result.exitCode,
        out: `${result.stdout.toString()}${result.stderr.toString()}`,
        listed,
        summary: textOf(join(directory, "summary")),
        check: textOf(join(directory, "check")),
      };
    };
    const unreachable = `unreachable: ${shared}\nunreachable: ${workerOnly}\n`;

    test("every image's list goes to one check", () => {
      const { check } = run("main", 0);
      expect(check).toStartWith(
        "scripts/third-party-notices.ts --snapshot-check 600 lists/control-host-amd64.md lists/control-host-arm64.md ",
      );
      expect(check).toEndWith("lists/egress-proxy-arm64.md\n");
      expect(check?.split(" ").filter((word) => word.endsWith(".md")).length)
        // The last word ends in a newline.
        .toBe(5);
    });

    test("a main build goes out without answers, each image with its own", () => {
      const result = run("main", 3, unreachable);
      expect(result.code).toBe(0);
      expect(result.listed("worker")).toEqual([shared, workerOnly]);
      expect(result.listed("control-host")).toEqual([shared]);
      expect(result.summary).toContain("### worker: 2 sources unverified");
      expect(result.summary).toContain(`- ${workerOnly}`);
      expect(result.out).toContain("::warning::worker");
    });

    test("a clean check leaves an empty list per image, not none", () => {
      const result = run("main", 0);
      expect(result.code).toBe(0);
      for (const { app } of lists) expect(result.listed(app)).toEqual([]);
    });

    test("a main build stops on a denied source, also among unanswered ones", () => {
      const result = run(
        "main",
        1,
        `missing: ${shared}\nunreachable: ${workerOnly}\n`,
      );
      expect(result.code).toBe(1);
      expect(result.out).toContain("::error::");
      expect(result.listed("worker")).toBeUndefined();
    });

    test("only exit 3 is forgiven, and only on main", () => {
      for (const exit of [2, 124, 137]) {
        expect(run("main", exit, unreachable).code).toBe(1);
      }
      const refused = run("release", 3, unreachable);
      expect(refused.code).toBe(1);
      expect(refused.listed("worker")).toBeUndefined();
      const clean = run("release", 0);
      expect(clean.code).toBe(0);
      expect(clean.check).toContain("--snapshot-check 1800 ");
      expect(clean.listed("worker")).toEqual([]);
    });

    test("exit 3 with no list stops instead of recording none", () => {
      expect(run("main", 3).code).toBe(1);
    });

    test("a list that did not arrive stops before anything is asked", () => {
      const result = run("main", 0, "", { app: "worker", arch: "arm64" });
      expect(result.code).toBe(1);
      expect(result.out).toContain("no source list for worker on arm64");
      expect(result.check).toBeUndefined();
    });

    test("an unknown mode is refused", () => {
      expect(run("relaese", 0).code).toBe(2);
    });

    test("earlier attempts' held files are joined and passed on, and this attempt's goes out", () => {
      const directory = mkdtempSync(join(tmpdir(), "image-sources-prior-"));
      mkdirSync(join(directory, "bin"));
      mkdirSync(join(directory, "lists"));
      mkdirSync(join(directory, "prior/held-sources-sources-1"), {
        recursive: true,
      });
      mkdirSync(join(directory, "prior/held-sources-sources-2"));
      // Copies what it was handed as --prior and writes a held set of its own
      // before failing, as the real check does.
      writeFileSync(
        join(directory, "bin/bun"),
        `#!/usr/bin/env bash
echo "$*" >"$FAKE/check"
while [ $# -gt 0 ]; do
  case "$1" in
    --prior) cp "$2" "$FAKE/prior-seen"; shift ;;
    --held-out) echo "acl 2.3.2-2" >"$2"; shift ;;
  esac
  shift
done
printf '%b' "$FAKE_STDERR" >&2
exit 3
`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(directory, "prior/held-sources-sources-1/held.txt"),
        "acl 2.3.2-2\n",
      );
      writeFileSync(
        join(directory, "prior/held-sources-sources-2/held.txt"),
        "gh 1\n",
      );
      for (const { app, arch } of lists) {
        writeFileSync(
          join(directory, "lists", `${app}-${arch}.md`),
          `| acl | 2.3.2-2 | acl |  | ${shared} |\n`,
        );
      }
      const result = Bun.spawnSync(
        [
          "bash",
          join(root, ".github/scripts/image-sources.sh"),
          "lists",
          "results",
          "release",
          "prior",
          "held",
        ],
        {
          cwd: directory,
          env: {
            PATH: `${join(directory, "bin")}:${process.env.PATH ?? ""}`,
            FAKE: directory,
            FAKE_EXIT: "3",
            FAKE_STDERR: unreachable,
          },
        },
      );
      // Strict as ever: the sources still unanswered stop a release.
      expect(result.exitCode).toBe(1);
      const check = readFileSync(join(directory, "check"), "utf8");
      expect(check).toContain("--snapshot-check 1800 --prior ");
      expect(check).toContain(`--held-out held/held.txt `);
      expect(
        readFileSync(join(directory, "prior-seen"), "utf8").split("\n").sort(),
      ).toEqual(["", "acl 2.3.2-2", "gh 1"]);
      // The failed check's own set is where the workflow uploads from.
      expect(readFileSync(join(directory, "held/held.txt"), "utf8")).toBe(
        "acl 2.3.2-2\n",
      );
    });

    test("with no earlier attempt the check gets no prior file", () => {
      const { check } = run("release", 0);
      expect(check).not.toContain("--prior");
      expect(check).not.toContain("--held-out");
    });
  });

  describe("image-index.sh", () => {
    const apps3 = ["control-host", "worker", "egress-proxy"];
    const imageOf = (app: string) => `ghcr.io/o/werft-${app}`;
    const child = (app: string, arch: string) => `sha256:${arch}-${app}`;
    const indexOf = (app: string) => `sha256:index-${app}`;

    // `create` logs its arguments; the index it writes names what it was given
    // unless FAKE_MANIFESTS says otherwise.
    const fakeDocker = `#!/usr/bin/env bash
set -euo pipefail
case "$3" in
  create)
    echo "\${*:4}" >>"$FAKE/creates"
    [ -z "\${FAKE_CREATE_FAILS:-}" ] || exit 1
    ;;
  inspect)
    case "$4" in
      --raw)
        app="$5"; app="\${app#*werft-}"; app="\${app%@*}"
        printf '%s' "\${FAKE_MANIFESTS:-[[\\"amd64\\",\\"sha256:amd64-$app\\"],[\\"arm64\\",\\"sha256:arm64-$app\\"]]}" |
          jq '{manifests: map({platform: {os: "linux", architecture: .[0]}, digest: .[1]})}'
        ;;
      *)
        app="$4"; app="\${app#*werft-}"; app="\${app%:*}"
        printf '"sha256:index-%s"\\n' "$app"
        ;;
    esac
    ;;
  *) exit 64 ;;
esac
`;
    const run = (
      env: Record<string, string> = {},
      change?: (directory: string) => void,
    ) => {
      const directory = mkdtempSync(join(tmpdir(), "image-index-"));
      mkdirSync(join(directory, "bin"));
      mkdirSync(join(directory, "arches"));
      mkdirSync(join(directory, "unverified"));
      writeFileSync(join(directory, "bin/docker"), fakeDocker, { mode: 0o755 });
      for (const app of apps3) {
        for (const arch of ["amd64", "arm64"]) {
          writeFileSync(
            join(directory, "arches", `${app}-${arch}.json`),
            JSON.stringify({
              app,
              arch,
              image: imageOf(app),
              base: "bun",
              commit: "abc",
              ref: "refs/heads/main",
              promoted: false,
              digest: child(app, arch),
              imageId: `sha256:config-${arch}`,
              runtime: app === "worker" ? { engine: "claude" } : null,
            }),
          );
        }
        writeFileSync(
          join(directory, "unverified", `${app}.json`),
          app === "worker" ? '["https://snapshot/a/"]' : "[]",
        );
      }
      change?.(directory);
      const result = Bun.spawnSync(
        [
          "bash",
          join(root, ".github/scripts/image-index.sh"),
          join(directory, "arches"),
          join(directory, "unverified"),
          join(directory, "staged"),
        ],
        {
          env: {
            PATH: `${join(directory, "bin")}:${process.env.PATH ?? ""}`,
            FAKE: directory,
            GITHUB_RUN_ID: "7",
            GITHUB_RUN_ATTEMPT: "1",
            ...env,
          },
        },
      );
      const stagedFile = (app: string) =>
        join(directory, "staged", `${app}.json`);
      const creates = join(directory, "creates");
      return {
        code: result.exitCode,
        out: `${result.stdout.toString()}${result.stderr.toString()}`,
        record: (app: string) =>
          JSON.parse(readFileSync(stagedFile(app), "utf8")),
        hasRecord: (app: string) => existsSync(stagedFile(app)),
        creates: existsSync(creates) ? readFileSync(creates, "utf8") : "",
      };
    };

    test("each image gets one index on its staging tag, amd64 first", () => {
      const result = run();
      expect(result.code).toBe(0);
      for (const app of apps3) {
        expect(result.creates).toContain(
          `-t ${imageOf(app)}:staging-7-1 ${imageOf(app)}@${child(app, "amd64")} ${imageOf(app)}@${child(app, "arm64")}\n`,
        );
      }
    });

    test("the record promote reads names the index and keeps each arch", () => {
      const record = run().record("worker");
      expect(record).toEqual({
        app: "worker",
        image: imageOf("worker"),
        base: "bun",
        commit: "abc",
        ref: "refs/heads/main",
        promoted: false,
        digest: indexOf("worker"),
        runtime: { engine: "claude" },
        platforms: {
          amd64: {
            digest: child("worker", "amd64"),
            imageId: "sha256:config-amd64",
          },
          arm64: {
            digest: child("worker", "arm64"),
            imageId: "sha256:config-arm64",
          },
        },
        unverifiedSources: ["https://snapshot/a/"],
      });
    });

    test.each([
      ["a digest that is not the smoked one", '[["amd64","sha256:other"]]'],
      [
        "a third platform",
        '[["amd64","sha256:amd64-control-host"],["arm64","sha256:arm64-control-host"],["riscv64","sha256:r"]]',
      ],
    ])("an index with %s is not staged", (_, manifests) => {
      const result = run({ FAKE_MANIFESTS: manifests });
      expect(result.code).toBe(1);
      expect(result.out).toContain("expected");
      expect(result.hasRecord("control-host")).toBe(false);
    });

    test("two arches of different builds are not joined", () => {
      const result = run({}, (directory) => {
        const path = join(directory, "arches/worker-arm64.json");
        const record = JSON.parse(readFileSync(path, "utf8"));
        writeFileSync(
          path,
          JSON.stringify({ ...record, runtime: { engine: "other" } }),
        );
      });
      expect(result.code).toBe(1);
      expect(result.out).toContain("worker: amd64 and arm64 differ in runtime");
      expect(result.creates).not.toContain("werft-worker");
    });

    test("a missing arch or source list stops it", () => {
      const noArch = run({}, (directory) =>
        rmSync(join(directory, "arches/egress-proxy-arm64.json")),
      );
      expect(noArch.code).not.toBe(0);
      expect(noArch.creates).toBe("");
      const noList = run({}, (directory) =>
        rmSync(join(directory, "unverified/worker.json")),
      );
      expect(noList.code).toBe(1);
      expect(noList.out).toContain("worker.json is missing");
    });

    test("a failed create stages nothing", () => {
      const result = run({ FAKE_CREATE_FAILS: "1" });
      expect(result.code).toBe(1);
      expect(result.hasRecord("control-host")).toBe(false);
    });
  });

  describe("image-promote.sh", () => {
    const apps3 = ["control-host", "egress-proxy", "worker"];
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const digest = (app: string, build = "a") => `sha256:${build}-${app}`;
    const imageOf = (app: string) => `ghcr.io/o/werft-${app}`;

    // A registry of one file per tag. `create` logs its arguments, and fails
    // for the image FAKE_CREATE_FAILS names.
    const fakeDocker = `#!/usr/bin/env bash
set -euo pipefail
file() { printf '%s/tags/%s' "$FAKE" "$(printf '%s' "$1" | tr '/:' '__')"; }
case "$3" in
  inspect)
    if [ -n "\${FAKE_LOOKUP_FAILS:-}" ]; then echo "$FAKE_LOOKUP_FAILS" >&2; exit 1; fi
    if [ -f "$(file "$4")" ]; then printf '"%s"\\n' "$(cat "$(file "$4")")"; exit 0; fi
    echo "$4: not found" >&2
    exit 1
    ;;
  create)
    shift 3
    echo "$*" >>"$FAKE/creates"
    prefer="$1"; shift
    [ "$prefer" = --prefer-index=false ]
    targets=()
    while [ "$1" = -t ]; do targets+=("$2"); shift 2; done
    source_digest="\${1#*@}"
    if [ -n "\${FAKE_CREATE_FAILS:-}" ] && [[ "$1" == *"$FAKE_CREATE_FAILS"* ]]; then exit 1; fi
    for target in "\${targets[@]}"; do
      printf '%s' "\${FAKE_WRITES:-$source_digest}" >"$(file "$target")"
    done
    ;;
  *) exit 64 ;;
esac
`;

    const registry = () => {
      const directory = mkdtempSync(join(tmpdir(), "image-promote-"));
      mkdirSync(join(directory, "bin"));
      mkdirSync(join(directory, "tags"));
      mkdirSync(join(directory, "staged"));
      writeFileSync(join(directory, "bin/docker"), fakeDocker, { mode: 0o755 });
      for (const app of apps3)
        writeFileSync(
          join(directory, "staged", `${app}.json`),
          JSON.stringify({ app, image: imageOf(app), digest: digest(app) }),
        );
      const tagFile = (app: string, tag: string) =>
        join(directory, "tags", `${imageOf(app)}:${tag}`.replace(/[/:]/g, "_"));
      const promote = (env: Record<string, string> = {}) => {
        const run = Bun.spawnSync(
          [
            "bash",
            join(root, ".github/scripts/image-promote.sh"),
            join(directory, "staged"),
            join(directory, "published"),
          ],
          {
            env: {
              PATH: `${join(directory, "bin")}:${process.env.PATH ?? ""}`,
              FAKE: directory,
              GITHUB_SHA: sha,
              GITHUB_REF: "refs/heads/main",
              GITHUB_REF_NAME: "main",
              ...env,
            },
          },
        );
        return {
          code: run.exitCode,
          out: `${run.stdout.toString()}${run.stderr.toString()}`,
        };
      };
      const tagged = () => readdirSync(join(directory, "tags")).sort();
      const published = () =>
        existsSync(join(directory, "published"))
          ? readdirSync(join(directory, "published")).sort()
          : [];
      const record = (app: string) =>
        JSON.parse(
          readFileSync(join(directory, "published", `${app}.json`), "utf8"),
        ) as { promoted: boolean; tags: string[]; digest: string };
      const creates = () => {
        const log = join(directory, "creates");
        return existsSync(log) ? readFileSync(log, "utf8") : "";
      };
      return { promote, tagFile, tagged, published, record, creates };
    };
    const main = `main-${sha.slice(0, 12)}`;

    test("a main run writes main-<12>, never a sha tag, and records the set", () => {
      const store = registry();
      expect(store.promote().code).toBe(0);
      expect(store.tagged()).toEqual(
        apps3.map((app) => `ghcr.io_o_werft-${app}_${main}`),
      );
      expect(store.published()).toEqual(apps3.map((app) => `${app}.json`));
      expect(store.record("worker")).toMatchObject({
        promoted: true,
        tags: [main],
        digest: digest("worker"),
      });
      expect(store.creates()).toContain("--prefer-index=false");
    });

    test("a v* run writes its version and sha tags, never main-<12>", () => {
      const store = registry();
      const run = store.promote({
        GITHUB_REF: "refs/tags/v1.2.3",
        GITHUB_REF_NAME: "v1.2.3",
      });
      expect(run.code).toBe(0);
      expect(store.record("worker").tags).toEqual([
        "v1.2.3",
        `sha-${sha.slice(0, 12)}`,
      ]);
      expect(store.tagged().filter((tag) => tag.includes("main-"))).toEqual([]);
    });

    test("a main run that releases promotes under the release tag, and main's own ref still writes nothing else", () => {
      const store = registry();
      const run = store.promote({ RELEASE_REF: "refs/tags/v1.2.3" });
      expect(run.code).toBe(0);
      expect(store.record("worker").tags).toEqual([
        "v1.2.3",
        `sha-${sha.slice(0, 12)}`,
      ]);
      expect(store.tagged().filter((tag) => tag.includes("main-"))).toEqual([]);
      const other = registry();
      const refused = other.promote({ RELEASE_REF: "refs/heads/feature" });
      expect(refused.code).toBe(1);
      expect(other.creates()).toBe("");
    });

    test("any other ref writes nothing", () => {
      const store = registry();
      const run = store.promote({
        GITHUB_REF: "refs/heads/feature",
        GITHUB_REF_NAME: "feature",
      });
      expect(run.code).toBe(1);
      expect(run.out).toContain("nothing is promoted");
      expect(store.creates()).toBe("");
    });

    test("a tag on another digest stops the promotion before any write", () => {
      const store = registry();
      writeFileSync(store.tagFile("worker", main), digest("worker", "older"));
      const run = store.promote();
      expect(run.code).toBe(1);
      expect(run.out).toContain("refusing to move it");
      expect(store.creates()).toBe("");
      expect(store.published()).toEqual([]);
      expect(readFileSync(store.tagFile("worker", main), "utf8")).toBe(
        digest("worker", "older"),
      );
    });

    test("a lookup that fails for another reason does not read as absent", () => {
      const store = registry();
      const run = store.promote({ FAKE_LOOKUP_FAILS: "500 upstream" });
      expect(run.code).toBe(1);
      expect(run.out).toContain("could not look up");
      expect(store.creates()).toBe("");
    });

    test("a half-promoted set completes on the same digests", () => {
      const store = registry();
      const first = store.promote({ FAKE_CREATE_FAILS: "werft-egress-proxy" });
      expect(first.code).toBe(1);
      expect(store.tagged()).toEqual([`ghcr.io_o_werft-control-host_${main}`]);
      expect(store.published()).toEqual([]);
      expect(store.promote().code).toBe(0);
      expect(store.tagged().length).toBe(3);
      expect(store.published().length).toBe(3);
    });

    test("a tag that reads back wrong is not published", () => {
      const store = registry();
      const run = store.promote({ FAKE_WRITES: "sha256:wrapped-index" });
      expect(run.code).toBe(1);
      expect(run.out).toContain("after promotion");
      expect(store.published()).toEqual([]);
    });
  });

  test("the API is bound to loopback and authenticated in compose", () => {
    expect(compose).toContain(
      '- "127.0.0.1:$' + '{TEST_OPS_API_PORT:-3000}:3000"',
    );
    // Workers reach api:3000 through the proxy; `none` would let them pick
    // any owner with X-Owner-Id.
    expect(compose).toContain("AUTH_MODE: $" + "{AUTH_MODE:-api-key}");
    // `up` runs migrate, so no service may take an ambient DATABASE_URL.
    for (const file of [
      CORE,
      LOCAL_LAYERS[1],
      TEST_OPS_LAYERS[1],
      ...Object.values(TEST_OPS_STORE_LAYERS),
    ])
      expect(read(file)).not.toMatch(/\$\{DATABASE_URL/);
  });
});

type ComposeService = {
  image?: string;
  build?: { dockerfile?: string };
  cgroup?: string;
  command?: string[];
  env_file?: string[];
  environment?: Record<string, string>;
  healthcheck?: { test?: string[] };
  labels?: Record<string, string>;
  pid?: string;
  ports?: (string | { host_ip?: string })[];
  restart?: string;
  stop_grace_period?: string;
  volumes?: string[];
  read_only?: boolean;
  cap_drop?: string[];
  security_opt?: string[];
  mem_limit?: string;
};

const composeServices = (path: string) =>
  servicesOf(path) as Record<string, ComposeService>;
/** The local stack's services as infra/compose.yml merges them. */
const localStack = () => layeredServices<ComposeService>(LOCAL_LAYERS);

describe("compose publishes nothing beyond loopback and runs pinned images", () => {
  const services = localStack();
  const restore = composeServices("infra/compose.restore.yml");

  test.each([
    ["the local stack", services],
    ["compose.restore.yml", restore],
  ] as const)("every published port in %s is bound to 127.0.0.1", (_, file) => {
    const published = Object.entries(file).flatMap(([name, service]) =>
      (service.ports ?? []).map((port) => [name, port] as const),
    );
    expect(published.length).toBeGreaterThan(0);
    for (const [name, port] of published) {
      // `a:b` and a bare `b` bind every interface, as does a long-syntax
      // entry without host_ip.
      const bound =
        typeof port === "string"
          ? port.startsWith("127.0.0.1:")
          : port.host_ip === "127.0.0.1";
      expect({ name, port, bound }).toEqual({ name, port, bound: true });
    }
  });

  test("only what a host-side process uses is published", () => {
    const published = Object.fromEntries(
      Object.entries(services)
        .filter(([, service]) => service.ports?.length)
        .map(([name, service]) => [name, service.ports]),
    );
    expect(published).toEqual({
      postgres: ["127.0.0.1:$" + "{TEST_OPS_POSTGRES_PORT:-5432}:5432"],
      localstack: ["127.0.0.1:4566:4566"],
      secrets: ["127.0.0.1:4567:4566"],
      "fake-git": ["127.0.0.1:3001:3000"],
      api: ["127.0.0.1:$" + "{TEST_OPS_API_PORT:-3000}:3000"],
    });
  });

  test("every image is built here or pinned by index digest", () => {
    const builtImages = new Set(
      Object.values(services)
        .filter((service) => service.build)
        .map((service) => service.image),
    );
    for (const [name, service] of Object.entries(services)) {
      if (service.build) {
        // Built images are released by digest through images.yml.
        const app = service.build.dockerfile?.match(
          /^apps\/([^/]+)\/Dockerfile$/,
        )?.[1];
        expect({ name, app }).toEqual({
          name,
          app: expect.stringMatching(/./),
        });
        expect(apps).toContain(app as (typeof apps)[number]);
        continue;
      }
      if (builtImages.has(service.image)) continue;
      expect({ name, image: service.image }).toEqual({
        name,
        image: expect.stringMatching(/^[^@\s]+@sha256:[0-9a-f]{64}$/),
      });
    }
  });

  test("compose runs Bun from the digest the Dockerfiles pin", () => {
    const bunImages = Object.values(services)
      .map((service) => service.image)
      .filter((image) => image?.startsWith("oven/bun:"));
    expect(bunImages.length).toBeGreaterThan(0);
    for (const image of bunImages)
      expect(image).toBe(basePins["control-host"].pin);
  });

  test("the egress proxy runs its released image, not a mounted source tree", () => {
    const proxy = services["egress-proxy"];
    expect(proxy?.build?.dockerfile).toBe("apps/egress-proxy/Dockerfile");
    expect(proxy?.image).toBe(
      "$" + "{EGRESS_PROXY_IMAGE:-werft-egress-proxy:dev}",
    );
    expect(proxy?.volumes).toBeUndefined();
  });

  test("the egress proxy is held to what a worker is, and its memory is bounded", () => {
    const proxy = services["egress-proxy"];
    expect(proxy?.read_only).toBe(true);
    expect(proxy?.cap_drop).toEqual(["ALL"]);
    expect(proxy?.security_opt).toEqual(["no-new-privileges:true"]);
    expect(proxy?.restart).toBe("unless-stopped");
    expect(proxy?.mem_limit).toBe("3072m");
    // The budget comment in compose is arithmetic over this default.
    expect(DEFAULT_MAX_BODY_BYTES_IN_FLIGHT).toBe(512 * 1024 * 1024);
  });
});

type Rendered = {
  name: string;
  services: Record<
    string,
    {
      image?: string;
      build?: { dockerfile?: string };
      profiles?: string[];
      environment?: Record<string, string | null>;
      ports?: { host_ip?: string; published?: string; target: number }[];
      volumes?: { source?: string; target: string; read_only?: boolean }[];
      depends_on?: Record<string, unknown>;
      command?: string[];
    }
  >;
  volumes?: Record<string, unknown>;
};

/**
 * `docker compose config` of these files with nothing but the given
 * variables set. Rendering reads the files only; no daemon is involved.
 */
function render(
  files: readonly string[],
  variables: Record<string, string> = {},
  options: { noEnvResolution?: boolean } = {},
) {
  const { PATH = "", HOME = "" } = Bun.env;
  const result = Bun.spawnSync(
    [
      "docker",
      "compose",
      // Interpolation from defaults alone, not a checkout's env file. An
      // `include` reads its own from the included file's directory, so the
      // tests render the layers with -f rather than through one.
      "--env-file",
      "/dev/null",
      "--profile",
      "apps",
      ...files.flatMap((file) => ["-f", join(root, file)]),
      "config",
      ...(options.noEnvResolution ? ["--no-env-resolution"] : []),
      "--format",
      "json",
    ],
    { env: { PATH, HOME, ...variables } },
  );
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    model: (result.exitCode === 0
      ? JSON.parse(result.stdout.toString())
      : undefined) as Rendered | undefined,
  };
}

// one definition of the product services, and a layer per
// installation that adds to it and loosens nothing.
describe("compose layers", () => {
  const core = servicesOf(CORE);
  const LOCAL_DEPENDENCIES = [
    "localstack",
    "local-s3-init",
    "secrets",
    "fake-messages",
  ];
  const APP_IMAGES = {
    API_IMAGE: `registry.invalid/control-host@sha256:${"a".repeat(64)}`,
    WORKER_IMAGE: `registry.invalid/worker@sha256:${"b".repeat(64)}`,
    EGRESS_PROXY_IMAGE: `registry.invalid/egress-proxy@sha256:${"c".repeat(64)}`,
  };
  // The secrets whose core defaults serve the local stack only.
  const TEST_OPS_SECRETS = {
    POSTGRES_PASSWORD: "test-ops-postgres-placeholder",
    EGRESS_AUTHORIZER_TOKEN: "test-ops-authorizer-placeholder",
  };
  // The rest of what the env file must give: the API alone holds
  // the S3 key (on s3) and the provider key.
  const API_KEYS = {
    AWS_ACCESS_KEY_ID: "test-ops-s3-key-id",
    AWS_SECRET_ACCESS_KEY: "test-ops-s3-key",
    ANTHROPIC_API_KEY: "test-ops-provider-key",
  };
  const TEST_OPS_SETTINGS = {
    ...API_KEYS,
    S3_BUCKET: "test-ops-bucket",
    EXECUTION_INSTALLATION_ID: "test-ops",
    PLATFORM_SETTINGS_DOCUMENT: "/etc/agent-platform/settings.json",
    PLATFORM_SECRET_KEY: "1".repeat(64),
    EXECUTION_WORKSPACE_QUOTA: "on",
    EGRESS_CREDENTIAL_ALLOWLIST:
      "api.anthropic.com:443,test-ops-bucket.s3.ap-northeast-1.amazonaws.com:443",
    EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST: "localstack:4566",
  };
  const TEST_OPS_REQUIRED = {
    ...APP_IMAGES,
    ...TEST_OPS_SECRETS,
    ...TEST_OPS_SETTINGS,
  };
  // What only the s3 store's layer requires; LocalStack needs none of it.
  const S3_ONLY = ["S3_BUCKET", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];
  // And what only LocalStack's does: on s3 no upstream is private.
  const LOCALSTACK_ONLY = ["EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST"];
  // The model key is entered on the console's model connections screen;
  // the env value only serves a connection that names it with `value_env`.
  const OPTIONAL = ["ANTHROPIC_API_KEY"];
  // The one value this layer fixes itself: the path the API writes a minted
  // bootstrap token to and `scripts/test-ops.sh bootstrap-token` reads from.
  // It is no operator setting, so it is not asked of the env file.
  const FIXED_PATH = "BOOTSTRAP_TOKEN_FILE";
  const holdsKey = (service: string, variable: string) =>
    service === "api" ||
    (service === "maintenance" && variable.startsWith("AWS_"));
  const S3_LAYERS = [...TEST_OPS_LAYERS, TEST_OPS_STORE_LAYERS.s3];
  const LOCALSTACK_LAYERS = [
    ...TEST_OPS_LAYERS,
    TEST_OPS_STORE_LAYERS.localstack,
  ];

  test("the Datadog Agent is opt-in and reads its API key only from the server env file", () => {
    const overlay = composeServices(DATADOG_OVERLAY);
    const agent = overlay["datadog-agent"];
    expect(localStack()["datadog-agent"]).toBeUndefined();
    expect(agent).toBeDefined();
    expect(agent?.image).toBe("gcr.io/datadoghq/agent:7.83.3");
    expect(agent?.pid).toBe("host");
    expect(agent?.cgroup).toBe("host");
    expect(agent?.env_file).toEqual([
      `\${DATADOG_ENV_FILE:-/etc/werft/datadog.env}`,
    ]);
    expect(agent?.environment?.DD_API_KEY).toBeUndefined();
    expect(read(DATADOG_OVERLAY)).not.toContain("${DD_API_KEY");
    expect(agent?.volumes).toContain(
      "/var/run/docker.sock:/var/run/docker.sock:ro",
    );
  });

  test("the Datadog overlay adds unified service tags without entering either default layer", () => {
    expect(LOCAL_LAYERS).not.toContain(DATADOG_OVERLAY);
    expect(TEST_OPS_LAYERS).not.toContain(DATADOG_OVERLAY);
    const overlay = composeServices(DATADOG_OVERLAY);
    for (const service of [
      "api",
      "scheduler",
      "reconciler",
      "egress-proxy",
      "postgres",
    ]) {
      expect(overlay[service]?.labels).toEqual(
        expect.objectContaining({
          "com.datadoghq.tags.service": service,
          "com.datadoghq.tags.env": expect.stringContaining("${DD_ENV:"),
          "com.datadoghq.tags.version":
            expect.stringContaining("${DD_VERSION:"),
        }),
      );
    }
  });

  test(
    "the Datadog overlay renders on top of the local stack and leaves the base render unchanged",
    () => {
      const base = render(LOCAL_LAYERS);
      const monitored = render(
        [...LOCAL_LAYERS, DATADOG_OVERLAY],
        {
          DD_ENV: "alpha",
          DATADOG_ENV_FILE: "/dev/null",
          DD_VERSION: "test-sha",
        },
        { noEnvResolution: true },
      );
      expect({ exitCode: base.exitCode, stderr: base.stderr }).toEqual({
        exitCode: 0,
        stderr: "",
      });
      expect({
        exitCode: monitored.exitCode,
        stderr: monitored.stderr,
      }).toEqual({ exitCode: 0, stderr: "" });
      expect(base.model?.services["datadog-agent"]).toBeUndefined();
      expect(monitored.model?.services["datadog-agent"]).toBeDefined();
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  test("the Datadog definitions are valid JSON and never tag a metric by session", () => {
    const definitionFiles = [
      "log-pipeline.json",
      "log-facets.json",
      "log-metrics.json",
      "monitors.json",
      "dashboard.json",
    ];
    const definitions = definitionFiles.map((name) =>
      JSON.parse(read(`infra/datadog/definitions/${name}`)),
    );
    expect(definitions).toHaveLength(definitionFiles.length);
    const metricDefinitions = definitions[2] as {
      requests: {
        data: {
          id: string;
          attributes: {
            compute: {
              aggregation_type: string;
              include_percentiles?: boolean;
            };
            filter: { query: string };
            group_by?: { path: string; tag_name?: string }[];
          };
        };
      }[];
    };
    for (const metric of metricDefinitions.requests) {
      for (const group of metric.data.attributes.group_by ?? []) {
        expect(group.path).not.toContain("session_id");
        expect(group.tag_name).not.toBe("session_id");
      }
    }
    expect(metricDefinitions.requests.map(({ data }) => data.id)).toEqual(
      expect.arrayContaining([
        "werft.checkpoint.capture.duration_ms",
        "werft.checkpoint.bundle_bytes",
        "werft.checkpoint.untracked_bytes",
        "werft.checkpoint.untracked_uploads",
        "werft.checkpoint.manifest_bytes",
        "werft.checkpoint.put_count",
        "werft.checkpoint.uploaded_bytes",
        "werft.checkpoint.reused_count",
        "werft.checkpoint.conflict_count",
        "werft.terminate.acceptance.duration_ms",
        "werft.session.create.duration_ms",
        "werft.control.effect.duration_ms",
      ]),
    );
    for (const id of [
      "werft.checkpoint.capture.duration_ms",
      "werft.terminate.acceptance.duration_ms",
      "werft.session.create.duration_ms",
      "werft.control.effect.duration_ms",
    ]) {
      expect(
        metricDefinitions.requests.find(({ data }) => data.id === id)?.data
          .attributes.compute,
      ).toMatchObject({
        aggregation_type: "distribution",
        include_percentiles: true,
      });
    }
    expect(
      metricDefinitions.requests.find(
        ({ data }) => data.id === "werft.terminate.acceptance.duration_ms",
      )?.data.attributes.filter.query,
    ).toContain("@event:api.request.completed");
    expect(
      metricDefinitions.requests.find(
        ({ data }) => data.id === "werft.control.effect.duration_ms",
      )?.data.attributes.group_by,
    ).toContainEqual({
      path: "@fields.operation",
      tag_name: "operation",
    });
    const facets = definitions[1] as {
      excluded_high_cardinality_attributes: string[];
    };
    expect(facets.excluded_high_cardinality_attributes).toContain(
      "@session_id",
    );
    const monitors = definitions[3] as {
      requests: { type: string; options: { thresholds?: unknown } }[];
    };
    expect(
      monitors.requests.find(({ type }) => type === "service check")?.options
        .thresholds,
    ).toBeDefined();
  });

  test("Datadog database checks are read-only SELECT queries", () => {
    const config = Bun.YAML.parse(
      read("infra/datadog/conf.d/postgres.d/conf.yaml"),
    ) as {
      instances: { custom_queries: { query: string }[] }[];
    };
    const queries = config.instances[0]?.custom_queries ?? [];
    expect(queries.length).toBeGreaterThanOrEqual(4);
    for (const { query } of queries) {
      expect(query.trim()).toMatch(/^SELECT\b/i);
      expect(query).not.toMatch(
        /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE)\b/i,
      );
      expect(query).not.toMatch(/\bsession_id\b/i);
    }
  });

  // What a layer may set on a service the core defines. Everything else —
  // users, capabilities, read-only roots, memory limits, mounts, ports,
  // networks, restart policies, allowlists — stays in the core. The exceptions
  // are EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST, whose entries are each
  // installation's own hosts (the core's default is empty), and the test-ops
  // layer's restart policy for postgres and the API: only a single-server
  // install must come back by itself after a host restart, and the core is
  // shared with the local and CI stacks, which must not.
  test.each([
    [
      LOCAL_LAYERS[1],
      [
        "build",
        "command",
        "env_file",
        "environment",
        "depends_on",
        "healthcheck",
        "volumes",
      ],
      [
        "AWS_ENDPOINT_URL",
        "AWS_ENDPOINT_URL_SECRETS_MANAGER",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "ANTHROPIC_API_KEY",
        "PLATFORM_SECRET_KEY",
        "SETTINGS_DOCUMENT",
        "EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST",
      ],
    ],
    [
      TEST_OPS_LAYERS[1],
      ["image", "environment", "volumes", "restart"],
      [
        "WORKER_IMAGE",
        "SETTINGS_DOCUMENT",
        FIXED_PATH,
        ...Object.keys(TEST_OPS_SECRETS),
        ...Object.keys(TEST_OPS_SETTINGS).filter(
          (name) =>
            name !== "PLATFORM_SETTINGS_DOCUMENT" &&
            !S3_ONLY.includes(name) &&
            !LOCALSTACK_ONLY.includes(name),
        ),
      ],
    ],
    [
      REAL_MODEL,
      ["environment"],
      ["SESSION_COST_LIMIT_USD", "MAX_TURN_SECONDS", "SETTINGS_DOCUMENT"],
    ],
    [
      FAKE_MODEL,
      ["environment", "depends_on"],
      ["ANTHROPIC_API_KEY", "SETTINGS_DOCUMENT"],
    ],
    [TEST_OPS_STORE_LAYERS.s3, ["environment"], S3_ONLY],
    [
      TEST_OPS_STORE_LAYERS.localstack,
      ["environment", "depends_on"],
      [
        "AWS_ENDPOINT_URL",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        ...LOCALSTACK_ONLY,
      ],
    ],
  ] as const)(
    "%s only adds to the core's services",
    (layer, fields, variables) => {
      const touched = Object.entries(servicesOf(layer)).filter(
        ([name]) => name in core,
      );
      expect(touched.length).toBeGreaterThan(0);
      for (const [name, service] of touched) {
        for (const field of Object.keys(service))
          expect({
            name,
            field,
            allowed: (fields as readonly string[]).includes(field),
          }).toEqual({
            name,
            field,
            allowed: true,
          });
        for (const variable of Object.keys(service.environment ?? {})) {
          expect({
            name,
            variable,
            allowed: (variables as readonly string[]).includes(variable),
          }).toEqual({
            name,
            variable,
            allowed: true,
          });
        }
      }
    },
  );

  test.each([TEST_OPS_LAYERS[1], TEST_OPS_STORE_LAYERS.s3])(
    "%s requires values and sets none",
    (layer) => {
      for (const [name, service] of Object.entries(servicesOf(layer))) {
        const values = Object.entries(
          (service.environment ?? {}) as Record<string, string>,
        ).filter(
          ([variable]) =>
            variable !== "SETTINGS_DOCUMENT" &&
            variable !== FIXED_PATH &&
            !OPTIONAL.includes(variable),
        );
        if (typeof service.image === "string") values.push(["", service.image]);
        for (const [variable, value] of values)
          expect({ name, value }).toEqual({
            name,
            value: expect.stringMatching(
              new RegExp(`^\\$\\{${variable || "[A-Z_]+"}:\\?[^}]+\\}$`),
            ),
          });
        for (const variable of OPTIONAL)
          if (service.environment?.[variable] !== undefined)
            expect({
              name,
              variable,
              value: service.environment[variable],
            }).toEqual({
              name,
              variable,
              value: `\${${variable}:-}`,
            });
        expect({ name, volumes: service.volumes }).toEqual({
          name,
          volumes:
            name === "migrate" && layer === TEST_OPS_LAYERS[1]
              ? [
                  expect.stringMatching(
                    /^\$\{PLATFORM_SETTINGS_DOCUMENT:\?[^}]+\}:\/settings\/installation\.json:ro$/,
                  ),
                ]
              : undefined,
        });
      }
    },
  );

  test("the core builds nothing and runs no local dependency", () => {
    for (const [name, service] of Object.entries(core))
      expect({ name, build: service.build }).toEqual({
        name,
        build: undefined,
      });
    for (const name of LOCAL_DEPENDENCIES) expect(core[name]).toBeUndefined();
    expect(read(CORE)).not.toMatch(
      /AWS_ENDPOINT_URL|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/,
    );
    // A checkout's env file is the local stack's alone.
    expect(read(CORE)).not.toMatch(/^ +env_file:/m);
  });

  test(
    "compose.yml is the core with the local layer, and renders as the tests merge them",
    () => {
      const entry = Bun.YAML.parse(read("infra/compose.yml")) as {
        name?: string;
        include?: { path?: string[] }[];
        services?: unknown;
      };
      expect(entry).toEqual({
        name: "werft",
        include: [
          { path: LOCAL_LAYERS.map((path) => path.replace(/^infra\//, "")) },
        ],
      });
      const { exitCode, stderr, model } = render(LOCAL_LAYERS);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      // Without their overlays, the fake Messages API and the fake Responses
      // API (infra/compose.codex-worker.yml) stay behind their profiles.
      const merged = Object.fromEntries(
        Object.entries(localStack()).filter(
          ([, service]) =>
            !service.profiles?.includes("fake-model") &&
            !service.profiles?.includes("fake-responses"),
        ),
      );
      const services = model?.services ?? {};
      expect(Object.keys(services).sort()).toEqual(Object.keys(merged).sort());
      /** A value as compose resolves it with nothing set. */
      const resolved = (value: string) =>
        value.replace(/\$\{[A-Z0-9_]+:?-([^}]*)\}/g, "$1");
      for (const [name, service] of Object.entries(services)) {
        const layered = merged[name];
        // Only the keys compose files set: a developer's ../.env adds more
        // through env_file, and never wins over these.
        const environment =
          layered?.environment &&
          Object.fromEntries(
            Object.keys(layered.environment).map((key) => [
              key,
              service.environment?.[key],
            ]),
          );
        expect({
          name,
          build: service.build?.dockerfile,
          image: service.image !== undefined,
          profiles: service.profiles,
          ports: service.ports?.map(
            (port) => `${port.host_ip}:${port.published}:${port.target}`,
          ),
          environment,
        }).toEqual({
          name,
          build: layered?.build?.dockerfile,
          image: layered?.image !== undefined,
          profiles: layered?.profiles,
          ports: layered?.ports?.map((port) => resolved(String(port))),
          environment:
            layered?.environment &&
            Object.fromEntries(
              // A variable passed through by name stays unset.
              Object.entries(layered.environment).map(([key, value]) => [
                key,
                value === null ? null : resolved(String(value)),
              ]),
            ),
        });
      }
      // Relative paths still resolve from infra/, as every overlay assumes.
      expect(
        services.migrate?.volumes?.find(
          (volume) => volume.target === "/settings",
        )?.source,
      ).toBe(join(root, "tests/fixtures/settings"));
      // The local S3 server and its encryption seed survive container replacement.
      expect(Object.keys(model?.volumes ?? {}).sort()).toEqual([
        "local-s3-data",
        "postgres-data",
      ]);
      expect(services.localstack?.volumes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: "local-s3-data", target: "/data" }),
        ]),
      );
      expect(services.api?.depends_on?.["local-s3-init"]?.condition).toBe(
        "service_completed_successfully",
      );
      // The backup helper reads the region from the object store container.
      expect(services.localstack?.environment?.AWS_DEFAULT_REGION).toBe(
        services.api?.environment?.AWS_REGION,
      );
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  test("api, slack and the scheduler read the same worker image runtimes, and only the scheduler the previous image", () => {
    const runtimes = {
      WORKER_IMAGE_RUNTIME:
        '{"engine":"claude","sdkVersion":"0.3.280","cliVersion":"2.1.280","profileDigestScheme":1}',
      WORKER_IMAGE_PREVIOUS_RUNTIME:
        '{"engine":"claude","sdkVersion":"0.3.270","cliVersion":"2.1.270","profileDigestScheme":1}',
    };
    const previous = `registry.invalid/worker@sha256:${"d".repeat(64)}`;
    const { exitCode, stderr, model } = render(LOCAL_LAYERS, {
      ...runtimes,
      WORKER_IMAGE_PREVIOUS: previous,
    });
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    for (const service of ["api", "slack", "scheduler"]) {
      const environment = model?.services[service]?.environment ?? {};
      expect([service, environment]).toEqual([
        service,
        expect.objectContaining(runtimes),
      ]);
      expect(environment.WORKER_IMAGE_PREVIOUS).toBe(
        service === "scheduler" ? previous : undefined,
      );
    }
    // Unset is empty, which every reader takes as not configured.
    const unset = render(LOCAL_LAYERS).model?.services.scheduler?.environment;
    expect(unset?.WORKER_IMAGE_RUNTIME).toBe("");
    expect(unset?.WORKER_IMAGE_PREVIOUS).toBe("");
  });

  test("the rendered services share the compose egress port set", () => {
    const { exitCode, stderr, model } = render(LOCAL_LAYERS);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    const proxy = model?.services["egress-proxy"]?.environment;
    const api = model?.services.api?.environment;
    const scheduler = model?.services.scheduler?.environment;
    const workerProxyUrl = new URL(
      String(scheduler?.EXECUTION_EGRESS_PROXY_URL),
    );
    const proxyAuthorizerUrl = new URL(String(proxy?.EGRESS_AUTHORIZER_URL));

    expect({
      forward: proxy?.EGRESS_PROXY_PORT,
      workerProxy: workerProxyUrl.port,
      credential: proxy?.EGRESS_CREDENTIAL_PORT,
      workerCredential: scheduler?.EXECUTION_EGRESS_CREDENTIAL_PORT,
      authorizer: api?.EGRESS_AUTHORIZER_PORT,
      proxyAuthorizer: proxyAuthorizerUrl.port,
    }).toEqual({
      forward: "3128",
      workerProxy: "3128",
      credential: "3129",
      workerCredential: "3129",
      authorizer: "3100",
      proxyAuthorizer: "3100",
    });
  });

  test.each([
    [
      "s3",
      S3_LAYERS,
      Object.keys(TEST_OPS_REQUIRED).filter(
        (name) => !LOCALSTACK_ONLY.includes(name) && !OPTIONAL.includes(name),
      ),
    ],
    [
      "localstack",
      LOCALSTACK_LAYERS,
      Object.keys(TEST_OPS_REQUIRED).filter(
        (name) => !S3_ONLY.includes(name) && !OPTIONAL.includes(name),
      ),
    ],
  ] as const)(
    "the test-ops layers on %s refuse to render without their required values",
    (_store, layers, required) => {
      for (const variable of required) {
        const { exitCode, stderr } = render(layers, {
          ...TEST_OPS_REQUIRED,
          [variable]: "",
        });
        expect({ variable, exitCode: exitCode === 0 }).toEqual({
          variable,
          exitCode: false,
        });
        expect(stderr).toContain(`${variable} must`);
      }
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  test.each([
    ["s3", S3_LAYERS],
    ["localstack", LOCALSTACK_LAYERS],
  ] as const)(
    "the test-ops layers on %s render and start without a model key",
    (_store, layers) => {
      const { ANTHROPIC_API_KEY: _key, ...withoutKey } = TEST_OPS_REQUIRED;
      const { exitCode, stderr, model } = render(layers, withoutKey);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(model?.services?.api?.environment?.ANTHROPIC_API_KEY).toBe("");
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  test(
    "the test-ops layers on s3 run the core's services only, on the values they were given",
    () => {
      const { exitCode, stderr, model } = render(S3_LAYERS, TEST_OPS_REQUIRED);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      const services = model?.services ?? {};
      expect(Object.keys(services).sort()).toEqual(Object.keys(core).sort());
      const expected: Record<string, string> = {
        migrate: APP_IMAGES.API_IMAGE,
        api: APP_IMAGES.API_IMAGE,
        scheduler: APP_IMAGES.API_IMAGE,
        reconciler: APP_IMAGES.API_IMAGE,
        slack: APP_IMAGES.API_IMAGE,
        "egress-proxy": APP_IMAGES.EGRESS_PROXY_IMAGE,
        worker: APP_IMAGES.WORKER_IMAGE,
      };
      for (const [name, service] of Object.entries(services)) {
        expect({ name, build: service.build }).toEqual({
          name,
          build: undefined,
        });
        if (name in expected)
          expect({ name, image: service.image }).toEqual({
            name,
            image: expected[name],
          });
        const databaseUrl = service.environment?.DATABASE_URL;
        if (databaseUrl)
          expect(databaseUrl).toContain(
            `:${TEST_OPS_SECRETS.POSTGRES_PASSWORD}@`,
          );
      }
      expect(services.scheduler?.environment?.WORKER_IMAGE).toBe(
        APP_IMAGES.WORKER_IMAGE,
      );
      expect(services.postgres?.environment?.POSTGRES_PASSWORD).toBe(
        TEST_OPS_SECRETS.POSTGRES_PASSWORD,
      );
      for (const name of ["api", "egress-proxy"])
        expect(services[name]?.environment?.EGRESS_AUTHORIZER_TOKEN).toBe(
          TEST_OPS_SECRETS.EGRESS_AUTHORIZER_TOKEN,
        );
      // The keys reach the API and nothing else, but for the bucket key the
      // maintenance jobs hold and delete objects with.
      for (const [name, service] of Object.entries(services))
        for (const [variable, value] of Object.entries(API_KEYS))
          expect({
            name,
            variable,
            value: service.environment?.[variable],
          }).toEqual({
            name,
            variable,
            value: holdsKey(name, variable) ? value : undefined,
          });
      expect(
        services.migrate?.volumes?.map(
          (volume) => `${volume.source}:${volume.target}`,
        ),
      ).toContain(
        `${TEST_OPS_SETTINGS.PLATFORM_SETTINGS_DOCUMENT}:/settings/installation.json`,
      );
      expect(services.api?.volumes ?? []).toEqual([]);
      expect(services.api?.environment?.AWS_ENDPOINT_URL).toBeUndefined();
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  // A null entry leaves the variable out of the container, so the API
  // generates its own token; an empty string would stop it from starting.
  test(
    "the test-ops env file's BOOTSTRAP_TOKEN reaches the API alone, and stays unset without one",
    () => {
      const token = `bootstrap-${crypto.randomUUID()}`;
      for (const [variables, expected] of [
        [{}, null],
        [{ BOOTSTRAP_TOKEN: token }, token],
      ] as const) {
        const { exitCode, stderr, model } = render(LOCALSTACK_LAYERS, {
          ...TEST_OPS_REQUIRED,
          ...variables,
        });
        expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
        for (const [name, service] of Object.entries(model?.services ?? {}))
          expect({
            name,
            value: service.environment?.BOOTSTRAP_TOKEN ?? null,
          }).toEqual({ name, value: name === "api" ? expected : null });
      }
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  test(
    "the test-ops API alone is told to leave a minted bootstrap token in a file",
    () => {
      const { exitCode, stderr, model } = render(
        LOCALSTACK_LAYERS,
        TEST_OPS_REQUIRED,
      );
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      for (const [name, service] of Object.entries(model?.services ?? {}))
        expect({
          name,
          value: service.environment?.BOOTSTRAP_TOKEN_FILE ?? null,
        }).toEqual({
          name,
          value: name === "api" ? "/tmp/werft-bootstrap-token" : null,
        });
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  test(
    "a command that names no mode imports no settings document",
    () => {
      const { exitCode, stderr, model } = render(["compose.yaml"], {});
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(model?.services?.migrate?.environment?.SETTINGS_DOCUMENT).toBe("");
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  // the files `scripts/local.sh up` and `tests/e2e/run.sh --real-model`
  // start with, each rendered with a key in the caller's environment.
  test.each([
    [["compose.yaml", REAL_MODEL]],
    [[...LOCAL_LAYERS, "tests/e2e/compose.yml", REAL_MODEL]],
  ])(
    "%p hands the key to the API alone, with the real-model settings and the e2e limits",
    (files) => {
      const probe = `key-probe-${crypto.randomUUID()}`;
      const { exitCode, stderr, model } = render(files, {
        ANTHROPIC_API_KEY: probe,
      });
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      const services = model?.services ?? {};
      const api = services.api;
      expect(api?.environment?.ANTHROPIC_API_KEY).toBe(probe);
      expect(services.migrate?.environment?.SETTINGS_DOCUMENT).toBe(
        "/settings/real-model.json",
      );
      expect(services["fake-messages"]).toBeUndefined();
      expect(services.secrets).toBeDefined();
      expect(Object.keys(api?.depends_on ?? {})).not.toContain("secrets");
      for (const [name, service] of Object.entries(services)) {
        if (name !== "api")
          expect({
            name,
            key: JSON.stringify(service).includes(probe),
          }).toEqual({
            name,
            key: false,
          });
      }
      for (const name of ["api", "scheduler"])
        expect({
          name,
          cost: services[name]?.environment?.SESSION_COST_LIMIT_USD,
          turn: services[name]?.environment?.MAX_TURN_SECONDS,
        }).toEqual({ name, cost: "1", turn: "600" });
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  test.each([
    ["the local stack", [...LOCAL_LAYERS]],
    ["the fake-model stack", [...LOCAL_LAYERS, FAKE_MODEL]],
    ["the mock-slack stack", [...LOCAL_LAYERS, "infra/compose.mock-slack.yml"]],
    ["test-ops on s3", [...TEST_OPS_LAYERS, TEST_OPS_STORE_LAYERS.s3]],
  ])(
    "%s hands PLATFORM_SECRET_KEY to the api and the slack role alone",
    (_, files) => {
      const masterKey = randomBytes(32).toString("hex");
      const { exitCode, stderr, model } = render(files, {
        ...(files.includes(TEST_OPS_LAYERS[1]) ? TEST_OPS_REQUIRED : {}),
        PLATFORM_SECRET_KEY: masterKey,
      });
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      const holders = Object.entries(model?.services ?? {})
        .filter(([, service]) => JSON.stringify(service).includes(masterKey))
        .map(([name]) => name)
        .sort();
      console.log(`${files.join(" + ")}: master key on ${holders.join(", ")}`);
      expect(holders).toEqual(["api", "slack"]);
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  // `scripts/local.sh dev`: the control host roles run the checkout's source
  // read-only under the restarter, and the stack without the overlay is the
  // same as before.
  test(
    "the dev overlay runs the control host roles on the mounted source and leaves the base render alone",
    () => {
      const base = render(["compose.yaml", FAKE_MODEL]);
      const dev = render(["compose.yaml", FAKE_MODEL, "infra/compose.dev.yml"]);
      expect({ exitCode: dev.exitCode, stderr: dev.stderr }).toEqual({
        exitCode: 0,
        stderr: "",
      });
      const services = dev.model?.services ?? {};
      const source = [
        { source: "apps/control-host", target: "/app/apps/control-host" },
        { source: "packages", target: "/app/packages" },
        { source: "scripts/dev", target: "/app/scripts/dev" },
      ];
      const mounted = (name: string) =>
        (services[name]?.volumes ?? [])
          .filter(({ source }) => source?.startsWith(`${root}/`))
          .map(({ source, target, read_only }) => ({
            source: source?.slice(root.length + 1),
            target,
            read_only,
          }));
      for (const role of ["api", "scheduler", "reconciler"]) {
        const command = services[role]?.command ?? [];
        expect({
          role,
          head: command.slice(0, 2),
          tail: command.slice(-4),
        }).toEqual({
          role,
          head: ["bun", "scripts/dev/hot-restart.ts"],
          tail: ["bun", "run", "apps/control-host/src/main.ts", role],
        });
        expect({ role, mounted: mounted(role) }).toEqual({
          role,
          mounted: expect.arrayContaining(
            source.map((mount) => ({ ...mount, read_only: true })),
          ),
        });
      }
      // What the layers already mount stays.
      expect(
        services.scheduler?.volumes?.map(({ target }) => target),
      ).toContain("/var/run/docker.sock");
      expect(Object.keys(services)).not.toContain("slack");
      expect(Object.keys(services)).not.toContain("maintenance");

      const baseServices = base.model?.services ?? {};
      expect(Object.keys(baseServices)).toEqual(
        expect.arrayContaining(["slack", "maintenance"]),
      );
      for (const [name, service] of Object.entries(baseServices))
        expect({
          name,
          source: (service.volumes ?? []).some(
            ({ target }) => target === "/app/apps/control-host",
          ),
        }).toEqual({ name, source: false });
      // The image's own CMD.
      expect(baseServices.api?.command ?? null).toBeNull();
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  // `scripts/local.sh up --fake-model` and the free runs: with no key the
  // migrate imports the fake settings and the API waits on the fake Messages
  // API, whose checkout mount resolves to the repository from either project
  // directory, and on the Secrets Manager holding their placeholder key.
  test.each([
    [["compose.yaml", FAKE_MODEL]],
    [[...LOCAL_LAYERS, FAKE_MODEL, "tests/e2e/compose.yml"]],
  ])(
    "%p runs the fake Messages API with the fake settings, and no key",
    (files) => {
      const probe = `key-probe-${crypto.randomUUID()}`;
      const { exitCode, stderr, model } = render(files, {
        ANTHROPIC_API_KEY: probe,
      });
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(JSON.stringify(model)).not.toContain(probe);
      const services = model?.services ?? {};
      expect(services.migrate?.environment?.SETTINGS_DOCUMENT).toBe(
        "/settings/fake-model.json",
      );
      for (const name of ["fake-messages", "secrets"])
        expect({ name, on: services.api?.depends_on?.[name] }).toMatchObject({
          name,
          on: { condition: "service_healthy" },
        });
      expect(
        services["fake-messages"]?.volumes?.map(
          (volume) => `${volume.source}:${volume.target}`,
        ),
      ).toEqual([`${root}:/app`]);
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  // where scripts/local.sh reads the ports to check and the worker
  // label to delete, also under the CI quickstart job's COMPOSE_FILE.
  const PORTS = ["3000", "3001", "4566", "4567", "5432"];
  const FAKE_PORTS = PORTS;
  test.each([
    [LOCAL_LAYERS, {}, "local", PORTS],
    [
      LOCAL_LAYERS,
      { EXECUTION_INSTALLATION_ID: "ap434local" },
      "ap434local",
      PORTS,
    ],
    [[...LOCAL_LAYERS, FAKE_MODEL], {}, "local", FAKE_PORTS],
    [
      ["compose.yaml", "tests/e2e/compose.ci-mirror.yml", FAKE_MODEL],
      {},
      "local",
      FAKE_PORTS,
    ],
  ] as const)(
    "%p rendered with %j names installation %p and its loopback ports",
    (files, variables, id, ports) => {
      const { exitCode, stderr, model } = render(files, variables);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      const services = model?.services ?? {};
      expect(services.scheduler?.environment?.EXECUTION_INSTALLATION_ID).toBe(
        id,
      );
      const proxy = services["egress-proxy"] as
        | { labels?: Record<string, string> }
        | undefined;
      expect(proxy?.labels?.["werft.egress-proxy"]).toBe(id);
      const published = Object.values(services).flatMap(
        (service) => service.ports?.map((port) => port.published) ?? [],
      );
      expect([...new Set(published)].sort()).toEqual([...ports]);
      expect(
        services.api?.ports?.map(({ host_ip, target }) => ({
          host_ip,
          target,
        })),
      ).toEqual([{ host_ip: "127.0.0.1", target: 3000 }]);
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  test(
    "the test-ops layers keep the independent volatile LocalStack and nothing else",
    () => {
      const required = Object.fromEntries(
        Object.entries(TEST_OPS_REQUIRED).filter(
          ([name]) => !S3_ONLY.includes(name),
        ),
      );
      const { exitCode, stderr, model } = render(LOCALSTACK_LAYERS, required);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      const services = model?.services ?? {};
      expect(Object.keys(services).sort()).toEqual(
        [...Object.keys(core), "localstack"].sort(),
      );
      expect(services.localstack?.image).toBe(
        "localstack/localstack:3@sha256:b279c01f4cfb8f985a482e4014cabc1e2697b9d7a6c8c8db2e40f4d9f93687c7",
      );
      expect(
        services.localstack?.ports?.map(
          (port) => `${port.host_ip}:${port.published}:${port.target}`,
        ),
      ).toEqual(["127.0.0.1:4566:4566"]);
      expect(services.api?.environment?.AWS_ENDPOINT_URL).toBe(
        "http://localstack:4566",
      );
      // The bucket infra/localstack/init creates.
      expect(services.api?.environment?.S3_BUCKET).toBe("claude-sessions");
      for (const name of ["api", "scheduler"])
        expect(Object.keys(services[name]?.depends_on ?? {})).toContain(
          "localstack",
        );
      // LocalStack's key signs for the API and the maintenance jobs alone;
      // the provider key for the API alone.
      for (const [name, service] of Object.entries(services)) {
        if (name === "localstack") continue;
        for (const variable of [...S3_ONLY.slice(1), "ANTHROPIC_API_KEY"])
          expect({
            name,
            variable,
            set: service.environment?.[variable] !== undefined,
          }).toEqual({ name, variable, set: holdsKey(name, variable) });
      }
      expect(services.api?.volumes ?? []).toEqual([]);
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );
});

describe("a connection kind's default endpoint", () => {
  // A kind that fills its endpoint in has to be reachable on a stock
  // install: the egress proxy opens only a credential allowlist host.
  const DEFAULTS = {
    "infra/compose.core.yml":
      /EGRESS_CREDENTIAL_ALLOWLIST:\s*\$\{[^:}]+:-([^}]+)\}/g,
    ".env.example": /^EGRESS_CREDENTIAL_ALLOWLIST=(.+)$/gm,
    "deploy/helm/werft/values.yaml": /credentialAllowlist:\s*"([^"]+)"/g,
  };

  for (const [file, pattern] of Object.entries(DEFAULTS)) {
    test(`${file} lets the proxy open every default host`, () => {
      const lists = [
        ...readFileSync(join(root, file), "utf8").matchAll(pattern),
      ];
      expect(lists.length).toBeGreaterThan(0);
      for (const [, list = ""] of lists) {
        const hosts = list.split(",").map((host) => host.trim());
        for (const endpoint of Object.values(CONNECTION_ENDPOINT_DEFAULTS)) {
          const url = new URL(endpoint ?? "");
          expect(hosts).toContain(`${url.hostname}:${url.port || "443"}`);
        }
      }
    });
  }
});
