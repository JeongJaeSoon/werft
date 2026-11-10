import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MIGRATION_HELPER_IMAGE } from "@werft-ai/execution-local-docker";
import { suiteFiles } from "../.github/scripts/test-files.ts";
import { LOCAL_LAYERS, layeredServices } from "./compose-layers.ts";

// CI pulls third-party images from its ghcr.io mirror only, by digests the
// mirror workflow copies there. What ci.yml names must be on that
// list, and every image a suite pulls on its own must be pointed at it.

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const MIRROR = "ghcr.io/jeongjaesoon/werft-ci/";
const MIRROR_REF =
  /^ghcr\.io\/jeongjaesoon\/werft-ci\/([a-z0-9-]+)@(sha256:[0-9a-f]{64})$/;

type Entry = { name: string; source: string; tag: string; digest: string };
type Job = {
  env?: Record<string, unknown>;
  services?: Record<string, { image?: string }>;
  steps?: { env?: Record<string, unknown> }[];
  strategy?: { matrix?: { include?: Entry[] } };
};
type Workflow = { jobs: Record<string, Job> };

const mirrored =
  (Bun.YAML.parse(read(".github/workflows/ci-image-mirror.yml")) as Workflow)
    .jobs.mirror?.strategy?.matrix?.include ?? [];
/** The entry a `<name>@<digest>` mirror reference resolves to, if any. */
const entryOf = (name: string, digest: string | undefined) =>
  mirrored.find((entry) => entry.name === name && entry.digest === digest);
const ciText = read(".github/workflows/ci.yml");
const ci = Bun.YAML.parse(ciText) as Workflow;

/** `docker.io/library/busybox` → `busybox`, as a Docker Hub short name. */
const shortName = (source: string) =>
  source.replace(/^docker\.io\//, "").replace(/^library\//, "");

/** A service image, or the non-empty literal of `matrix.x && '<image>' || ''`. */
const serviceImages = Object.values(ci.jobs).flatMap((job) =>
  Object.values(job.services ?? {}).map(({ image = "" }) => {
    const literal = image.match(/'([^']+)'/)?.[1];
    return literal ?? image;
  }),
);

/** Every `*_IMAGE` variable ci.yml sets, job-level or per step. */
const imageVariables = Object.values(ci.jobs).flatMap((job) =>
  [job.env, ...(job.steps ?? []).map((step) => step.env)].flatMap((env) =>
    Object.entries(env ?? {}).filter(([key]) => key.endsWith("_IMAGE")),
  ),
);

describe("the mirror list", () => {
  test("names each digest once, from Docker Hub", () => {
    expect(mirrored.length).toBeGreaterThan(0);
    // A name may carry two digests while a bump is under way (docs/contributing/ci.md § 서드파티 이미지 미러).
    const keys = new Set(
      mirrored.map(({ name, digest }) => `${name}@${digest}`),
    );
    expect(keys.size).toBe(mirrored.length);
    for (const { name, source, tag, digest } of mirrored) {
      expect(name).toMatch(/^[a-z0-9-]+$/);
      expect(source).toMatch(/^docker\.io\/[a-z0-9._/-]+$/);
      expect(typeof tag).toBe("string");
      expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  test("busybox is the workspace-migration helper, bun the app base", () => {
    const [, helperDigest] = DEFAULT_MIGRATION_HELPER_IMAGE.split("@");
    expect(entryOf("busybox", helperDigest)?.source).toBe(
      "docker.io/library/busybox",
    );
    const dockerfiles = [...new Bun.Glob("apps/*/Dockerfile").scanSync(root)];
    expect(dockerfiles.length).toBeGreaterThan(0);
    for (const dockerfile of dockerfiles) {
      const base = read(dockerfile).match(/^ARG BUN_IMAGE=(\S+)$/m)?.[1];
      const bun = entryOf("bun", base?.split("@")[1]);
      expect({ dockerfile, base }).toEqual({
        dockerfile,
        base: `${shortName(bun?.source ?? "")}:${bun?.tag}@${bun?.digest}`,
      });
    }
  });

  test("the inode helper CI builds stands on the worker's base", () => {
    const worker = read("apps/worker/Dockerfile").match(
      /^ARG BUN_IMAGE=\S+@(sha256:[0-9a-f]{64})$/m,
    )?.[1];
    expect(ciText).toContain(`"FROM ${MIRROR}bun@${worker}"`);
  });
});

describe("images.yml", () => {
  // the app builds pull their base and BuildKit from the mirror too.
  type Step = { uses?: string; with?: Record<string, unknown> };
  const imagesText = read(".github/workflows/images.yml");
  const images = Bun.YAML.parse(imagesText) as {
    env: Record<string, string>;
    jobs: Record<string, { steps: Step[] }>;
  };
  const steps = (action: string) =>
    Object.values(images.jobs)
      .flatMap((job) => job.steps)
      .filter((step) => step.uses?.startsWith(`${action}@`));
  /** `${{ <body> }}`, spelled so the linter does not read a template slot. */
  const expression = (body: string) => `\${{ ${body} }}`;
  const pinned = (variable: string) => {
    const [, name = "", digest] =
      String(images.env[variable]).match(MIRROR_REF) ?? [];
    return { name, entry: entryOf(name, digest) };
  };

  test("builds every app on the Dockerfiles' base and frontend, from the mirror", () => {
    const base = pinned("BUN_IMAGE");
    const frontend = pinned("DOCKERFILE_FRONTEND_IMAGE");
    expect({
      base: [base.name, base.entry !== undefined],
      frontend: [frontend.name, frontend.entry !== undefined],
    }).toEqual({ base: ["bun", true], frontend: ["dockerfile", true] });
    for (const dockerfile of new Bun.Glob("apps/*/Dockerfile").scanSync(root)) {
      const source = read(dockerfile);
      expect(source).toContain(`@${base.entry?.digest}\n`);
      expect(source).toStartWith(
        `# syntax=docker/dockerfile:${frontend.entry?.tag}\n`,
      );
    }
    const builds = steps("docker/build-push-action");
    expect(builds.length).toBe(3);
    const common =
      `BUN_IMAGE=${expression("env.BUN_IMAGE")}\n` +
      `BUILDKIT_SYNTAX=${expression("env.DOCKERFILE_FRONTEND_IMAGE")}\n` +
      `APT_UPGRADE_KEY=${expression("steps.meta.outputs.apt-upgrade-key")}\n`;
    // Every job's matrix has the Codex worker image; its leg picks the engine
    // with the extra argument, which is empty on every other leg.
    const codex = `${expression("matrix.app == 'worker-codex' && 'WORKER_RUNTIME=codex_app_server' || ''")}\n`;
    const args = builds.map((build) => build.with?.["build-args"]);
    expect(args.filter((value) => value === common + codex).length).toBe(3);
  });

  test("runs BuildKit from the mirror wherever buildx is set up", () => {
    const { name, entry } = pinned("BUILDKIT_IMAGE");
    expect({ name, mirrored: entry !== undefined }).toEqual({
      name: "buildkit",
      mirrored: true,
    });
    const setups = steps("docker/setup-buildx-action");
    expect(setups.length).toBe(8);
    for (const setup of setups)
      expect(setup.with?.["driver-opts"]).toBe(
        `image=${expression("env.BUILDKIT_IMAGE")}`,
      );
  });

  test("names no Docker Hub image", () => {
    for (const { source, tag } of mirrored)
      expect(imagesText).not.toContain(`${shortName(source)}:${tag}`);
    for (const reference of imagesText.match(
      /ghcr\.io\/jeongjaesoon\/werft-ci\/[^\s'"]+/g,
    ) ?? [])
      expect(reference).toMatch(MIRROR_REF);
  });
});

describe("assert-no-docker-hub-images.sh", () => {
  const script = join(root, ".github/scripts/assert-no-docker-hub-images.sh");
  /**
   * Runs the check against a fake daemon: `images` lists one id, and
   * `image inspect` prints `listing` as the RepoDigests of what it holds.
   */
  const daemon =
    'case "$1" in images) echo sha256:1 ;; image) printf "%s" "$LISTING" ;; esac';
  const check = (listing: string, fake = daemon) => {
    const result = Bun.spawnSync(["bash", script, "bash", "-c", fake, "_"], {
      env: { ...process.env, LISTING: listing },
    });
    return { code: result.exitCode, out: result.stdout.toString() };
  };
  const at = `@sha256:${"a".repeat(64)}`;
  const digests = (...names: string[]) =>
    names.map((name) => `${name}${at}`).join("\n");

  test("passes the mirror and the runner's own images", () => {
    const listing = digests(
      `${MIRROR}busybox`,
      `${MIRROR}postgres`,
      "ghcr.io/github/gh-aw-firewall/squid",
      "localhost:5000/scratch",
    );
    expect(check(listing).code).toBe(0);
  });

  test("skips an image built on the daemon, which has no RepoDigests", () => {
    expect(check("").code).toBe(0);
  });

  test("fails on every Docker Hub name, naming it", () => {
    const { code, out } = check(
      digests(
        `${MIRROR}busybox`,
        "alpine",
        "localstack/localstack",
        "docker.io/library/postgres",
        // Looks like the mirror, but without a dot it is a Docker Hub user.
        "ghcr-io/jeongjaesoon/werft-ci/busybox",
      ),
    );
    expect(code).toBe(1);
    for (const name of [
      "alpine",
      "localstack/localstack",
      "docker.io/library/postgres",
      "ghcr-io/jeongjaesoon/werft-ci/busybox",
    ]) {
      expect(out).toContain(`::error::${name} came from Docker Hub`);
    }
    expect(out).not.toContain(`::error::${MIRROR}`);
  });

  test("fails when the daemon cannot be listed", () => {
    expect(check("", "exit 3").code).not.toBe(0);
  });

  test("runs after the tests in every Docker job", () => {
    const steps = (job: string) =>
      JSON.stringify(ci.jobs[job]?.steps ?? []).includes(
        "assert-no-docker-hub-images.sh",
      );
    expect(steps("integration-domain")).toBe(true);
    expect(steps("workspace-quota")).toBe(true);
    expect(steps("e2e")).toBe(true);
    expect(steps("quickstart")).toBe(true);
  });
});

describe("ci.yml", () => {
  test("names no image outside the mirror", () => {
    for (const image of serviceImages)
      expect(image.startsWith(MIRROR)).toBe(true);
    for (const [variable, value] of imageVariables) {
      const image = String(value);
      // Or an image a step builds on the daemon, which nothing pulls.
      const ok = image.startsWith(MIRROR) || ciText.includes(`-t ${image}`);
      expect({ variable, image, ok }).toEqual({ variable, image, ok: true });
    }
    // `docker run` arguments are not parsed; no Docker Hub tag may appear at all.
    for (const { source, tag } of mirrored) {
      expect(ciText).not.toContain(`${shortName(source)}:${tag}`);
    }
  });

  test("pins every mirror reference to the digest the mirror copies", () => {
    const references = ciText.match(/ghcr\.io\/[^\s'"\\]+/g) ?? [];
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      const [, name = "", digest] = reference.match(MIRROR_REF) ?? [];
      expect({
        reference,
        mirrored: entryOf(name, digest) !== undefined,
      }).toEqual({
        reference,
        mirrored: true,
      });
    }
  });

  test("hands no suite's migrator the Docker Hub helper directly", () => {
    // The migrator never pulls its helper, so a real daemon in CI has only
    // the mirror's copy. Unit suites with a fake daemon may name it.
    for (const file of suiteFiles(root).filter((file) =>
      file.endsWith(".integration.test.ts"),
    ))
      expect({
        file,
        direct: read(file).includes(
          "helperImage: DEFAULT_MIGRATION_HELPER_IMAGE",
        ),
      }).toEqual({ file, direct: false });
  });

  test("points every image a suite pulls itself at the mirror", () => {
    // variable → its string-literal fallback, if it has one
    const overrides = new Map<string, string | undefined>();
    for (const file of suiteFiles(root)) {
      for (const [, variable = "", fallback] of read(file).matchAll(
        /process\.env\.([A-Z_]+_IMAGE)\b(?:\s*(?:\?\?|\|\|)\s*"([^"]+)")?/g,
      )) {
        if (!overrides.get(variable)) overrides.set(variable, fallback);
      }
    }
    expect([...overrides.keys()]).toContain(
      "EXECUTION_WORKSPACE_MIGRATION_IMAGE",
    );
    const integrationEnv = ci.jobs["integration-domain"]?.env ?? {};
    for (const [variable, fallback] of overrides) {
      const image = String(integrationEnv[variable] ?? "");
      const [, name = "", digest] = image.match(MIRROR_REF) ?? [];
      const entry = entryOf(name, digest);
      expect({ variable, mirrored: entry !== undefined }).toEqual({
        variable,
        mirrored: true,
      });
      // The mirror carries the version the suite runs locally.
      if (fallback && entry) {
        expect(`${shortName(entry.source)}:${entry.tag}`).toBe(fallback);
      }
    }
  });
});

describe("the e2e compose overlay", () => {
  // `e2e` and `quickstart` start the product compose stack, whose
  // images stay on Docker Hub for local users; CI lays this over it.
  const OVERLAY = "tests/e2e/compose.ci-mirror.yml";
  type Service = {
    image?: string;
    build?: { dockerfile?: string; args?: Record<string, string> };
  };
  const services = (path: string) =>
    (Bun.YAML.parse(read(path)) as { services: Record<string, Service> })
      .services;
  const stack = layeredServices<Service>(LOCAL_LAYERS);
  const overlay = services(OVERLAY);
  /** The mirror entry a reference resolves to, or undefined. */
  const resolve = (reference: string | undefined) => {
    const [, name = "", digest] = (reference ?? "").match(MIRROR_REF) ?? [];
    return entryOf(name, digest);
  };

  test("local and CI use the same persistent S3 server and AWS CLI initializer", () => {
    expect(resolve(overlay.localstack?.image)?.source).toBe(
      "docker.io/chrislusf/seaweedfs",
    );
    expect(resolve(overlay["local-s3-init"]?.image)?.source).toBe(
      "docker.io/localstack/localstack",
    );
  });

  test("pulls every third-party image of the stack from the mirror, by the stack's digest", () => {
    // Any other image, a variable or not, is pulled and needs the overlay.
    const built = new Set(
      Object.values(stack).flatMap(({ build, image }) =>
        build && image ? [image] : [],
      ),
    );
    const pulled = Object.entries(stack).filter(
      ([, { image }]) => image !== undefined && !built.has(image),
    );
    expect(pulled.length).toBeGreaterThan(0);
    for (const [service, { image }] of pulled) {
      const entry = resolve(overlay[service]?.image);
      expect({ service, image }).toEqual({
        service,
        image:
          entry && `${shortName(entry.source)}:${entry.tag}@${entry.digest}`,
      });
    }
  });

  test("builds every app on the Dockerfile's base and frontend, from the mirror", () => {
    const built = Object.entries(stack).filter(([, { build }]) => build);
    expect(built.length).toBeGreaterThan(0);
    for (const [service, { build }] of built) {
      const dockerfile = read(build?.dockerfile ?? "");
      const base = dockerfile.match(/^ARG BUN_IMAGE=(\S+)$/m)?.[1];
      const syntax = dockerfile.match(/^# syntax=(\S+)$/m)?.[1];
      const args = overlay[service]?.build?.args ?? {};
      const bun = resolve(args.BUN_IMAGE);
      const frontend = resolve(args.BUILDKIT_SYNTAX);
      expect({ service, base, syntax }).toEqual({
        service,
        base: bun && `${shortName(bun.source)}:${bun.tag}@${bun.digest}`,
        syntax: frontend && `${shortName(frontend.source)}:${frontend.tag}`,
      });
    }
  });

  test("names only services the stack has", () => {
    for (const service of Object.keys(overlay))
      expect({ service, known: service in stack }).toEqual({
        service,
        known: true,
      });
  });

  test("is laid over the stack in both jobs, the guides left as written", () => {
    const stepValues = (job: string, variable: string) =>
      (ci.jobs[job]?.steps ?? []).flatMap(({ env = {} }) =>
        variable in env ? [env[variable]] : [],
      );
    expect(stepValues("e2e", "E2E_COMPOSE_OVERRIDE")).toEqual([OVERLAY]);
    expect(stepValues("quickstart", "COMPOSE_FILE")).toEqual([
      `compose.yaml:${OVERLAY}`,
      `compose.yaml:${OVERLAY}`,
    ]);
    expect(read("docs/quickstart.md")).not.toContain("ci-mirror");
    expect(
      read("apps/docs/content/docs/reference/api-guide.mdx"),
    ).not.toContain("ci-mirror");
  });
});

describe("the D2 gate workflow", () => {
  // d2-gate.yml runs scripts/d2-gate/run.sh on the product stack
  // with the e2e overlay, and the gate's own services with one of its own.
  const OVERLAY = "scripts/d2-gate/compose.ci-mirror.yml";
  type Step = { env?: Record<string, string>; run?: string };
  const text = read(".github/workflows/d2-gate.yml");
  const steps = (
    Bun.YAML.parse(text) as { jobs: Record<string, { steps: Step[] }> }
  ).jobs["d2-gate"]?.steps;
  const images = (path: string) =>
    Object.fromEntries(
      Object.entries(
        (
          Bun.YAML.parse(read(path)) as {
            services: Record<string, { image?: string }>;
          }
        ).services,
      ).flatMap(([service, { image }]) => (image ? [[service, image]] : [])),
    );

  test("pulls the gate's services from the mirror, by the gate's digest", () => {
    const gate: Record<string, string | undefined> = images(
      "scripts/d2-gate/compose.yml",
    );
    const overlay = images(OVERLAY);
    expect(Object.keys(overlay).sort()).toEqual(Object.keys(gate).sort());
    for (const [service, image] of Object.entries(overlay)) {
      const [, name = "", digest] = image.match(MIRROR_REF) ?? [];
      const entry = entryOf(name, digest);
      expect({ service, image: gate[service] }).toEqual({
        service,
        image:
          entry && `${shortName(entry.source)}:${entry.tag}@${entry.digest}`,
      });
    }
  });

  test("lays both overlays over the stack, and checks nothing came from Docker Hub", () => {
    const gate = steps?.find((step) => step.run === "scripts/d2-gate/run.sh");
    expect(gate?.env?.D2_GATE_COMPOSE_OVERRIDE).toBe(
      `tests/e2e/compose.ci-mirror.yml:${OVERLAY}`,
    );
    expect(text).toContain("assert-no-docker-hub-images.sh docker");
  });
});
