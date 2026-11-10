/**
 * The checks behind scripts/test-ops.sh
 *
 *   bun run scripts/lib/test-ops.ts manifest <release.json>
 *   bun run scripts/lib/test-ops.ts settings-digest <file>
 *   bun run scripts/lib/test-ops.ts render-refusal <stderr-file>
 *   bun run scripts/lib/test-ops.ts check-render --store <localstack|s3> [--settings-digest <digest> [--localstack-port <running>]] < rendered.json
 *   bun run scripts/lib/test-ops.ts probe-store < rendered.json
 *   bun run scripts/lib/test-ops.ts upgrade-impact <verify-exit> <verify-output> <uncollected>
 *   bun run scripts/lib/test-ops.ts upgrade-previous <uncollected> <target-exit> <target-output> <previous-exit> <previous-output>
 *   bun run scripts/lib/test-ops.ts upgrade-gate <from-worker> <to-worker> <affected> [<approved>]
 *
 * rendered.json is `docker compose config --format json` of the test-ops
 * installation: what its containers get, read from the env file by compose
 * itself. Nothing here reads the env file.
 *
 * Exit 2 on usage, 3 when upgrade-gate refuses, 1 on anything else.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
  type CheckpointObjectCollector,
  parseSettingsDocument,
} from "@werft-ai/platform";
import type { CheckpointObjectStore } from "@werft-ai/runtime-core";
import {
  createCheckpointObjectCollector,
  createCheckpointObjectStore,
  createStorageS3Client,
} from "@werft-ai/storage";
import {
  assertCheckpointBucketEncryption,
  assertCheckpointBucketProtection,
  checkpointStorageConfigFromEnv,
} from "../../apps/control-host/src/api/checkpoints.ts";
import { withoutLegacyRepositories } from "../../apps/control-host/src/api/settings-from-dir.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const EXIT_REFUSED = 3;

/** A reference compose and the daemon resolve to one set of bytes. */
const PINNED_IMAGE = /^[^\s@]+@sha256:[0-9a-f]{64}$/;

/** What compose.local.yml runs and a test-ops installation must not. */
const LOCAL_ONLY = [
  "localstack",
  "local-s3-init",
  "secrets",
  "fake-messages",
  "fake-git",
];

/**
 * Where a test-ops installation keeps checkpoint objects: LocalStack, in
 * memory, while no AWS account is in use (2026-09-25), or AWS S3 itself.
 */
export type ObjectStoreMode = "localstack" | "s3";
const OBJECT_STORE_MODES: readonly ObjectStoreMode[] = ["localstack", "s3"];

/** The bucket infra/localstack/init creates, and the endpoint the API uses. */
const LOCALSTACK_BUCKET = "claude-sessions";
const LOCALSTACK_ENDPOINT = "http://localstack:4566";

const TEST_OPS_SETTINGS_DOCUMENT = "/settings/installation.json";

/** RFC 3986 unreserved: survives inside the compose-built DATABASE_URL. */
const URL_SAFE = /^[A-Za-z0-9._~-]+$/;

const API_TARGET_PORT = 3000;
/** A host name, as URL normalizes it; never an IP literal or `localhost`. */
const NAMED_PROXY = /^(?!.*(^|\.)localhost\.?$)(?![\d.]+$)[^[]/i;

export type ReleaseManifest = {
  readonly settingsDigest: string;
  readonly images: {
    readonly controlHost: string;
    readonly egressProxy: string;
    readonly worker: string;
  };
  readonly sourceCommit: string;
};

/**
 * A release as test-ops deploys it: the commit its compose files come from,
 * the three app images by digest, and the settings by content. A tag can be
 * moved after the fact; none of these can.
 *
 * `deployed` reads the manifest of the running release, which an installation
 * from before settings documents wrote with `catalog_revision`. That release
 * has no digest: `settingsDigest` is empty, and an upgrade off it migrates.
 */
export function parseReleaseManifest(
  value: unknown,
  { deployed = false }: { deployed?: boolean } = {},
): ReleaseManifest {
  const problems: string[] = [];
  const object = (found: unknown, where: string, keys: readonly string[]) => {
    if (typeof found !== "object" || found === null || Array.isArray(found)) {
      problems.push(`${where} must be an object`);
      return {} as Record<string, unknown>;
    }
    for (const key of Object.keys(found))
      if (!keys.includes(key)) problems.push(`${where} has unknown key ${key}`);
    return found as Record<string, unknown>;
  };
  const text = (
    found: unknown,
    where: string,
    pattern: RegExp,
    what: string,
  ) => {
    if (typeof found === "string" && pattern.test(found)) return found;
    problems.push(`${where} must be ${what}, not ${JSON.stringify(found)}`);
    return "";
  };
  const top = object(value, "manifest", [
    "source_commit",
    "images",
    "settings_digest",
    ...(deployed ? ["catalog_revision"] : []),
  ]);
  const beforeSettings =
    deployed &&
    top.settings_digest === undefined &&
    typeof top.catalog_revision === "string";
  const images = object(top.images, "images", [
    "control_host",
    "worker",
    "egress_proxy",
  ]);
  const image = (key: string) =>
    text(images[key], `images.${key}`, PINNED_IMAGE, "<name>@sha256:<64 hex>");
  const manifest = {
    settingsDigest: beforeSettings
      ? ""
      : text(
          top.settings_digest,
          "settings_digest",
          /^sha256:[0-9a-f]{64}$/,
          "sha256:<64 hex>",
        ),
    images: {
      controlHost: image("control_host"),
      egressProxy: image("egress_proxy"),
      worker: image("worker"),
    },
    sourceCommit: text(
      top.source_commit,
      "source_commit",
      /^[0-9a-f]{40}$/,
      "a full 40-hex commit",
    ),
  };
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return manifest;
}

/**
 * The import leaves out a repository with no GitHub App and adds nothing for
 * it, so the run would end with no repository after the images are up. This
 * is the import's own rule applied before anything starts. A document that is
 * not JSON is the import's to refuse.
 */
async function repositoriesWithoutGitHubApp(file: string): Promise<string[]> {
  let document: unknown;
  try {
    document = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return [];
  }
  if (document === null || typeof document !== "object") return [];
  const skipped: string[] = [];
  const notes: string[] = [];
  const repositories = withoutLegacyRepositories(
    (document as { repositories?: unknown }).repositories,
    notes,
    skipped,
  );
  // migrate parses the document the same way; a refusal there only shows up
  // after the images are pulled and the stack is half up.
  try {
    parseSettingsDocument(
      Array.isArray(document) || !("repositories" in document)
        ? document
        : { ...document, repositories },
    );
  } catch (error) {
    return [
      `settings document ${file}: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  return skipped.map(
    (id) =>
      `settings document ${file}: repository ${id} names no GitHub App, so the import would leave it out; add "auth": {"kind": "github_app"}. If the database already holds a repository ${id}, that edit conflicts with the row: remove the entry or give it a new id. If a run already stopped with pending.json left behind, copy the fixed manifest over it (docs/operator/test-ops.md)`,
  );
}

export async function settingsDigest(file: string): Promise<string> {
  const digest = createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
  return `sha256:${digest}`;
}

type RenderedService = {
  build?: unknown;
  environment?: Record<string, string | null>;
  image?: string;
  ports?: { host_ip?: string; published?: string; target?: number }[];
  volumes?: { source?: string; target?: string }[];
};
export type RenderedModel = {
  services?: Record<string, RenderedService>;
  "x-test-ops-api-url"?: string;
};

const isPort = (value: string) =>
  /^[1-9][0-9]{0,4}$/.test(value) && Number(value) <= 65535;

/**
 * What the script's health checks call: the port the API publishes, or they
 * would read whatever else listens there, unless a host name says it is a
 * proxy. Problems never quote the value: a URL can carry a credential.
 */
function apiUrlProblems(value: string, apiPort: string | undefined): string[] {
  const form = ["TEST_OPS_API_URL must be scheme://host[:port]"];
  if (!URL.canParse(value)) return form;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return ["TEST_OPS_API_URL must be http or https"];
  const port = url.port || (url.protocol === "http:" ? "80" : "443");
  if (!/^[a-z]+:\/\/[\w.:[\]-]+$/i.test(value) || !isPort(port)) return form;
  return !NAMED_PROXY.test(url.hostname) && port !== apiPort
    ? [`TEST_OPS_API_URL must use the published API port ${apiPort}`]
    : [];
}

const PORT_REFUSAL =
  /invalid (?:hostPort|containerPort|proto|IP address)|no port specified/i;

/**
 * Compose's stderr, unless it refused a port: it quotes the value, which can
 * run over several lines, so nothing of that message stays.
 */
export function renderRefusal(stderr: string): string {
  return PORT_REFUSAL.test(stderr)
    ? "a TEST_OPS_*_PORT setting must be one port from 1 to 65535\n"
    : stderr;
}

/**
 * Refuses a render that is not a test-ops installation: one that runs or
 * builds a local dependency, names an image by tag, publishes beyond
 * loopback or anything but one free port per service, moves the port of the
 * running LocalStack, whose recreation loses every object, checks the API
 * anywhere but the port it publishes, loosens the API's modes, builds a DSN a
 * password breaks, points the API at another object store than `store`,
 * leaves workers without a route to it, runs workspaces without quota, or
 * mounts a settings document other than the manifest's. Every problem is
 * reported at once. Returns the mounted document's digest.
 */
export async function checkRender(
  model: RenderedModel,
  options: {
    readonly settingsDigest?: string;
    readonly runningLocalstackPort?: string;
    readonly store: ObjectStoreMode;
  },
): Promise<string> {
  const services = model.services ?? {};
  const problems: string[] = [];
  const env = (service: string, name: string) =>
    services[service]?.environment?.[name] ?? undefined;
  const localOnly = LOCAL_ONLY.filter(
    (name) => !(options.store === "localstack" && name === "localstack"),
  );
  for (const name of localOnly)
    if (name in services) problems.push(`service ${name} is local-only`);
  const publishers = new Map<string, string>();
  for (const [name, service] of Object.entries(services)) {
    if (service.build !== undefined)
      problems.push(`service ${name} builds its image`);
    if (!PINNED_IMAGE.test(service.image ?? ""))
      problems.push(
        `service ${name} runs ${service.image ?? "no image"}, not an image by digest`,
      );
    for (const port of service.ports ?? []) {
      if (port.host_ip !== "127.0.0.1")
        problems.push(
          `service ${name} publishes ${port.published} on ${port.host_ip ?? "every interface"}`,
        );
      const published = port.published ?? "";
      const publisher = publishers.get(published);
      if (!isPort(published))
        problems.push(`service ${name} must publish one port from 1 to 65535`);
      else if (publisher !== undefined)
        problems.push(
          `services ${publisher} and ${name} both publish port ${published}`,
        );
      publishers.set(published, name);
    }
  }
  const running = options.runningLocalstackPort;
  if (
    running !== undefined &&
    services.localstack?.ports?.[0]?.published !== running
  )
    problems.push(
      `LocalStack runs on port ${running}, and moving it loses every object: keep the port, or take backup --stop and reseed (docs/operator/test-ops.md)`,
    );
  for (const required of ["api", "scheduler", "egress-proxy", "postgres"])
    if (!(required in services))
      problems.push(`service ${required} is missing`);
  problems.push(
    ...apiUrlProblems(
      model["x-test-ops-api-url"] ?? "",
      services.api?.ports?.find((port) => port.target === API_TARGET_PORT)
        ?.published,
    ),
  );

  if (env("api", "AUTH_MODE") !== "api-key")
    problems.push("api AUTH_MODE must be api-key");
  if (env("api", "CHECKPOINT_OBJECT_PROTECTION") !== "locked")
    problems.push("api CHECKPOINT_OBJECT_PROTECTION must be locked");
  for (const name of ["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"])
    if (!URL_SAFE.test(env("postgres", name) ?? ""))
      problems.push(
        `${name} may hold only letters, digits and . _ ~ - (it goes into DATABASE_URL unescaped)`,
      );
  // The egress proxy exits on a shorter token and restarts forever.
  for (const service of ["api", "egress-proxy"])
    if ((env(service, "EGRESS_AUTHORIZER_TOKEN") ?? "").length < 32)
      problems.push(
        `${service} EGRESS_AUTHORIZER_TOKEN must be at least 32 characters (the egress proxy refuses to start)`,
      );
  const installation = env("scheduler", "EXECUTION_INSTALLATION_ID") ?? "";
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(installation) || installation === "local")
    problems.push(
      `EXECUTION_INSTALLATION_ID must name this installation, not ${JSON.stringify(installation)} (local is the local stack's)`,
    );
  if (env("scheduler", "EXECUTION_WORKSPACE_QUOTA") !== "on")
    problems.push("EXECUTION_WORKSPACE_QUOTA must be on (xfs with prjquota)");

  const bucket = env("api", "S3_BUCKET") ?? "";
  const region = env("api", "AWS_REGION") ?? "";
  const endpoint = env("api", "AWS_ENDPOINT_URL");
  const list = (name: string) =>
    (env("egress-proxy", name) ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  if (options.store === "localstack") {
    if (!("localstack" in services))
      problems.push("service localstack is missing (store localstack)");
    if (endpoint !== LOCALSTACK_ENDPOINT)
      problems.push(`api AWS_ENDPOINT_URL must be ${LOCALSTACK_ENDPOINT}`);
    if (bucket !== LOCALSTACK_BUCKET)
      problems.push(
        `S3_BUCKET must be ${LOCALSTACK_BUCKET}, the bucket LocalStack creates`,
      );
    if (
      !list("EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST").includes("localstack:4566")
    )
      problems.push(
        "EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST must name localstack:4566, or workers cannot write checkpoints",
      );
  } else {
    if (endpoint !== undefined)
      problems.push("api AWS_ENDPOINT_URL must be unset: the store is AWS S3");
    // The object store route calls the virtual-hosted name, or the regional
    // one for a bucket name with a dot (the execution page of the operations docs).
    const s3Host = bucket.includes(".")
      ? `s3.${region}.amazonaws.com:443`
      : `${bucket}.s3.${region}.amazonaws.com:443`;
    if (!list("EGRESS_CREDENTIAL_ALLOWLIST").includes(s3Host))
      problems.push(
        `EGRESS_CREDENTIAL_ALLOWLIST must name ${s3Host}, or workers cannot write checkpoints`,
      );
  }
  for (const entry of list("EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST"))
    if (localOnly.includes(entry.split(":")[0] ?? ""))
      problems.push(
        `EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST names ${entry}, a local-only service`,
      );

  if (!env("api", "PLATFORM_SECRET_KEY"))
    problems.push("api has no PLATFORM_SECRET_KEY");

  let digest = "";
  const document = services.migrate?.volumes?.find(
    (volume) => volume.target === TEST_OPS_SETTINGS_DOCUMENT,
  )?.source;
  if (document === undefined)
    problems.push(
      `migrate mounts no document at ${TEST_OPS_SETTINGS_DOCUMENT}`,
    );
  else if (document.startsWith(REPO_ROOT + sep))
    problems.push(
      `settings document ${document} is inside the checkout; keep it outside`,
    );
  else if (!(await stat(document).catch(() => undefined))?.isFile())
    problems.push(`settings document ${document} is not a file`);
  else {
    digest = await settingsDigest(document);
    if (
      options.settingsDigest !== undefined &&
      options.settingsDigest !== digest
    )
      problems.push(
        `settings document ${document} is ${digest}, the manifest says ${options.settingsDigest}`,
      );
    problems.push(...(await repositoriesWithoutGitHubApp(document)));
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return digest;
}

/**
 * The API's own first write, hold and collection on a scratch key: create-
 * only put, legal hold, read back by version, then what checkpoint GC does —
 * lift the hold and delete the version. The API's startup check reads the
 * bucket's settings only, so this is what proves the credentials may write,
 * hold and collect. Each failure names the S3 permission of its step.
 */
export async function probeRoundTrip(input: {
  readonly collector: CheckpointObjectCollector;
  readonly key: string;
  readonly objects: CheckpointObjectStore;
}): Promise<void> {
  const { collector, key, objects } = input;
  const step = async <T>(action: string, run: () => Promise<T>) => {
    try {
      return await run();
    } catch (error) {
      throw new Error(
        `${action} on ${key} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const body = new TextEncoder().encode(`test-ops preflight ${key}\n`);
  const put = await step("s3:PutObject (If-None-Match)", () =>
    objects.putImmutable(key, body),
  );
  if (put.outcome !== "created" || put.version === undefined)
    throw new Error(
      `s3:PutObject on ${key} answered ${put.outcome} without a version; the bucket must be versioned`,
    );
  const { version } = put;
  await step("s3:PutObjectLegalHold", async () => {
    if (objects.hold === undefined)
      throw new Error("the store places no legal holds");
    await objects.hold(key, version);
  });
  const head = await step("s3:GetObjectLegalHold", () =>
    objects.head(key, version),
  );
  if (head?.held !== true)
    throw new Error(
      `${key} (version ${version}) reads back without its legal hold`,
    );
  const read = await step("s3:GetObjectVersion", () =>
    objects.get(key, version),
  );
  if (
    read === undefined ||
    Buffer.compare(Buffer.from(read), Buffer.from(body)) !== 0
  )
    throw new Error(`${key} (version ${version}) reads back different bytes`);
  await step("s3:PutObjectLegalHold (release) and s3:DeleteObjectVersion", () =>
    collector.purge({ deleteMarker: false, key, version }),
  );
  const left = await step("s3:ListBucketVersions", () =>
    collector.listVersions(key),
  );
  const remaining = left.filter((entry) => entry.key === key).length;
  if (remaining > 0)
    throw new Error(
      `${key} still has ${remaining} version(s) after the delete`,
    );
}

/** The API's startup bucket checks, then the round trip, with its settings. */
export async function probeStore(model: RenderedModel): Promise<string> {
  const environment = model.services?.api?.environment ?? {};
  const config = checkpointStorageConfigFromEnv(
    Object.fromEntries(
      Object.entries(environment).map(([name, value]) => [
        name,
        value ?? undefined,
      ]),
    ),
  );
  if (config === "disabled" || config.protection !== "locked")
    throw new Error("api must run the object store locked");
  await assertCheckpointBucketProtection(config);
  await assertCheckpointBucketEncryption(config, {
    warn: (message) => {
      throw new Error(message);
    },
  });
  const client = createStorageS3Client({ s3: config });
  try {
    await probeRoundTrip({
      collector: createCheckpointObjectCollector({
        bucket: config.bucket,
        client,
      }),
      key: `test-ops-preflight/${new Date().toISOString()}-${randomUUID()}`,
      objects: createCheckpointObjectStore({ bucket: config.bucket, client }),
    });
  } finally {
    client.destroy();
  }
  return config.bucket;
}

export type UpgradeVerdict =
  | { readonly proceed: true; readonly approved: readonly string[] }
  | { readonly proceed: false; readonly reason: string };

export type UpgradeImpact = {
  readonly affected: readonly string[];
  readonly failClosed: boolean;
  readonly reason?: string;
};

/**
 * Reads verify-restore's complete run, accepting exit 5 only when every
 * failure is a target-image incompatibility. Any incomplete or mixed result
 * falls back to all uncollected sessions.
 */
export function upgradeImpact(input: {
  readonly exitCode: number;
  readonly output: string;
  readonly uncollected: readonly string[];
}): UpgradeImpact {
  const sorted = (ids: readonly string[]) => [...new Set(ids)].sort();
  const fallback = sorted(input.uncollected);
  const failClosed = (reason: string): UpgradeImpact => ({
    affected: fallback,
    failClosed: true,
    reason,
  });
  const lines = input.output.split("\n").map((line) => line.trim());
  const failures = lines.filter((line) => line.startsWith("FAIL "));
  const summaries = lines.flatMap((line) => {
    const match = /^checkpoints=\d+ passed=\d+ failed=(\d+)$/.exec(line);
    return match === null ? [] : [Number(match[1])];
  });
  if (summaries.length !== 1)
    return failClosed("verify-restore did not produce one complete summary");
  if (summaries[0] !== failures.length)
    return failClosed("verify-restore's summary does not match its failures");
  if (
    (failures.length === 0 && input.exitCode !== 0) ||
    (failures.length > 0 && input.exitCode !== 5)
  )
    return failClosed(
      `verify-restore exited ${input.exitCode} for ${failures.length} failure(s)`,
    );

  const incompatible: string[] = [];
  for (const failure of failures) {
    const match =
      /^FAIL (.+)@[0-9]+ plan: incompatible with the target image \(checkpoint → image\): /.exec(
        failure,
      );
    if (match === null)
      return failClosed(
        "verify-restore found a failure other than incompatibility",
      );
    incompatible.push(match[1] as string);
  }
  const affected = sorted(incompatible);
  const uncollected = new Set(fallback);
  if (affected.some((sessionId) => !uncollected.has(sessionId)))
    return failClosed(
      "verify-restore named an incompatible session outside the uncollected set",
    );
  return { affected, failClosed: false };
}

/**
 * After an upgrade the scheduler keeps the image it replaces as the previous
 * one and resumes on it every session whose checkpoint it restores, so only
 * a session neither image can restore is affected. When either check failed
 * closed the target's list stays whole: a session the target cannot be shown
 * to restore may still launch on it when both images share a combination.
 */
export function notResumableOnPrevious(input: {
  readonly target: UpgradeImpact;
  readonly previous: UpgradeImpact;
}): string[] {
  const target = [...new Set(input.target.affected)].sort();
  if (input.target.failClosed || input.previous.failClosed) return target;
  const previous = new Set(input.previous.affected);
  return target.filter((id) => previous.has(id));
}

/**
 * The upgrade goes ahead only when no session is incompatible with the target
 * worker image, or when the operator approved exactly the sessions that are:
 * one more or one fewer means the list they read is not the one that would
 * break.
 */
export function decideUpgrade(input: {
  readonly affected: readonly string[];
  readonly approved?: readonly string[];
  readonly fromWorker: string;
  readonly toWorker: string;
}): UpgradeVerdict {
  const sorted = (ids: readonly string[]) => [...new Set(ids)].sort();
  const affected = sorted(input.affected);
  if (input.fromWorker === input.toWorker || affected.length === 0)
    return { approved: [], proceed: true };
  const header = `the worker image changes (${input.fromWorker} -> ${input.toWorker}) and ${affected.length} session(s) have checkpoints it cannot restore:\n${affected.join("\n")}`;
  if (input.approved === undefined)
    return {
      proceed: false,
      reason: `${header}\napprove exactly this list to go ahead`,
    };
  const approved = sorted(input.approved);
  if (approved.join("\n") !== affected.join("\n")) {
    const missing = affected.filter((id) => !approved.includes(id));
    const extra = approved.filter((id) => !affected.includes(id));
    return {
      proceed: false,
      reason: `${header}\nthe approved list differs — not approved: ${missing.join(" ") || "none"}; no longer affected: ${extra.join(" ") || "none"}`,
    };
  }
  return { approved: affected, proceed: true };
}

const lines = async (path: string) =>
  (await readFile(path, "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

async function stdinModel(): Promise<RenderedModel> {
  return JSON.parse(await Bun.stdin.text()) as RenderedModel;
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...args] = argv;
  switch (command) {
    case "manifest": {
      const [file, mode] = args;
      if (
        !file ||
        args.length > 2 ||
        (mode !== undefined && mode !== "--deployed")
      )
        return usage();
      const manifest = parseReleaseManifest(
        JSON.parse(await readFile(file, "utf8")),
        { deployed: mode === "--deployed" },
      );
      console.log(
        [
          `SOURCE_COMMIT=${manifest.sourceCommit}`,
          `API_IMAGE=${manifest.images.controlHost}`,
          `WORKER_IMAGE=${manifest.images.worker}`,
          `EGRESS_PROXY_IMAGE=${manifest.images.egressProxy}`,
          `SETTINGS_DIGEST=${manifest.settingsDigest}`,
        ].join("\n"),
      );
      return 0;
    }
    case "settings-digest": {
      const [file] = args;
      if (!file || args.length > 1) return usage();
      console.log(await settingsDigest(file));
      return 0;
    }
    case "render-refusal": {
      const [file] = args;
      if (!file || args.length > 1) return usage();
      process.stdout.write(renderRefusal(await readFile(file, "utf8")));
      return 0;
    }
    case "check-render": {
      const [storeFlag, store, digestFlag, digest, portFlag, port, ...rest] =
        args;
      if (
        storeFlag !== "--store" ||
        !OBJECT_STORE_MODES.includes(store as ObjectStoreMode) ||
        rest.length > 0 ||
        (digestFlag !== undefined &&
          (digestFlag !== "--settings-digest" || digest === undefined)) ||
        (portFlag !== undefined &&
          (portFlag !== "--localstack-port" || port === undefined))
      )
        return usage();
      console.log(
        await checkRender(await stdinModel(), {
          ...(digest === undefined ? {} : { settingsDigest: digest }),
          ...(port === undefined ? {} : { runningLocalstackPort: port }),
          store: store as ObjectStoreMode,
        }),
      );
      return 0;
    }
    case "probe-store": {
      if (args.length !== 0) return usage();
      const bucket = await probeStore(await stdinModel());
      console.error(
        `probe-store: ${bucket} is versioned, Object Lock and SSE-S3; put, hold, read, release and delete passed`,
      );
      return 0;
    }
    case "upgrade-impact": {
      const [exitCodeText, output, uncollected] = args;
      if (!exitCodeText || !output || !uncollected || args.length !== 3)
        return usage();
      const exitCode = Number(exitCodeText);
      if (!Number.isSafeInteger(exitCode) || exitCode < 0) return usage();
      const impact = upgradeImpact({
        exitCode,
        output: await readFile(output, "utf8"),
        uncollected: await lines(uncollected),
      });
      if (impact.failClosed)
        console.error(
          `upgrade impact: ${impact.reason}; fail-closed to all ${impact.affected.length} uncollected session(s)`,
        );
      console.log(impact.affected.join("\n"));
      return 0;
    }
    case "upgrade-previous": {
      const [
        uncollected,
        targetExit,
        targetOutput,
        previousExit,
        previousOutput,
      ] = args;
      if (
        !uncollected ||
        !targetExit ||
        !targetOutput ||
        !previousExit ||
        !previousOutput ||
        args.length !== 5
      )
        return usage();
      const ids = await lines(uncollected);
      const impactOf = async (exitText: string, output: string) => {
        const exitCode = Number(exitText);
        if (!Number.isSafeInteger(exitCode) || exitCode < 0) return null;
        return upgradeImpact({
          exitCode,
          output: await readFile(output, "utf8"),
          uncollected: ids,
        });
      };
      const target = await impactOf(targetExit, targetOutput);
      const previous = await impactOf(previousExit, previousOutput);
      if (!target || !previous) return usage();
      for (const [image, impact] of [
        ["target", target],
        ["previous", previous],
      ] as const)
        if (impact.failClosed)
          console.error(
            `upgrade previous: the ${image} image's check failed closed (${impact.reason}); the target's list stays whole`,
          );
      console.log(notResumableOnPrevious({ target, previous }).join("\n"));
      return 0;
    }
    case "upgrade-gate": {
      const [fromWorker, toWorker, affected, approved] = args;
      if (!fromWorker || !toWorker || !affected || args.length > 4)
        return usage();
      const verdict = decideUpgrade({
        affected: await lines(affected),
        ...(approved === undefined ? {} : { approved: await lines(approved) }),
        fromWorker,
        toWorker,
      });
      if (!verdict.proceed) {
        console.error(`upgrade refused: ${verdict.reason}`);
        return EXIT_REFUSED;
      }
      console.log(verdict.approved.join("\n"));
      return 0;
    }
    default:
      return usage();
  }
}

function usage(): number {
  console.error(
    "usage: test-ops.ts manifest <file> [--deployed] | settings-digest <file> | render-refusal <stderr-file> | check-render --store <localstack|s3> [--settings-digest <digest> [--localstack-port <running>]] | probe-store | upgrade-impact <verify-exit> <verify-output> <uncollected> | upgrade-previous <uncollected> <target-exit> <target-output> <previous-exit> <previous-output> | upgrade-gate <from-worker> <to-worker> <affected> [<approved>]",
  );
  return 2;
}

if (import.meta.main) {
  let code: number;
  try {
    code = await main(process.argv.slice(2));
  } catch (error) {
    console.error(
      `${process.argv[2]}: ${error instanceof Error ? error.message : String(error)}`,
    );
    code = 1;
  }
  process.exit(code);
}
