/**
 * Packages the chart a run publishes, with that run's images in its
 * values.yaml: `bun .github/scripts/chart-package.ts <published dir> <out dir>`.
 *
 * <published dir> is `image-digests-published`. <out dir> gets
 * `werft-<version>.tgz` and `werft-<version>.values.yaml`, the same values
 * alone. The repository's values.yaml stays without digests: only a package
 * names images, and a checkout still has to pin its own.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseImageRuntime } from "../../packages/runtime-core/src/image-runtime.ts";

export type ChartImages = {
  controlHost: { repository: string; digest: string };
  egressProxy: { repository: string; digest: string };
  worker: {
    repository: string;
    digest: string;
    runtime: Record<string, unknown>;
  };
  /**
   * The Codex worker image: a catalog entry the chart does not deploy. One
   * worker image holds one engine, so a deployment that runs Codex copies this
   * repository, digest and runtime into `worker`.
   */
  workerCodex: {
    repository: string;
    digest: string;
    runtime: Record<string, unknown>;
  };
};

const APPS = {
  "control-host": "controlHost",
  "egress-proxy": "egressProxy",
  worker: "worker",
  "worker-codex": "workerCodex",
} as const;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const NUMBER = "(?:0|[1-9]\\d*)";
const PRERELEASE = `(?:${NUMBER}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
// Semver's grammar, less build metadata: `+` cannot go in the helm.sh/chart
// label. Checked here because the images are already promoted when helm runs.
const RELEASE_TAG = new RegExp(
  `^v(${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-${PRERELEASE}(?:\\.${PRERELEASE})*)?)$`,
);
const LABEL_LIMIT = 63;

/**
 * The ref the publish scripts act on. The release jobs of a main run set
 * RELEASE_REF to the tag they release, because the run's own ref is main.
 */
export function effectiveRef(
  env: Record<string, string | undefined>,
): string | undefined {
  return env.RELEASE_REF || env.GITHUB_REF;
}

/**
 * The version a run's chart gets. On main the prerelease is one hyphenated
 * identifier, not `main.<12>`: twelve digits with a leading zero are not
 * valid semver, and helm refuses them.
 */
export function chartVersion(input: {
  ref: string;
  sha: string;
  chartYamlVersion: string;
  chartName: string;
}): { version: string; appVersion: string } {
  const { ref, sha, chartYamlVersion, chartName } = input;
  let result: { version: string; appVersion: string };
  if (ref === "refs/heads/main") {
    if (!/^\d+\.\d+\.\d+$/.test(chartYamlVersion)) {
      throw new Error(`Chart.yaml version ${chartYamlVersion} is not X.Y.Z`);
    }
    const short = sha.slice(0, 12);
    if (!/^[0-9a-f]{12}$/.test(short)) throw new Error(`bad commit ${sha}`);
    result = {
      version: `${chartYamlVersion}-main-${short}`,
      appVersion: `main-${short}`,
    };
  } else if (ref.startsWith("refs/tags/")) {
    const tag = ref.slice("refs/tags/".length);
    const version = tag.match(RELEASE_TAG)?.[1];
    if (version === undefined) {
      throw new Error(`tag ${tag} is not v<major>.<minor>.<patch>[-<pre>]`);
    }
    result = { version, appVersion: tag };
  } else {
    throw new Error(`no chart is published from ${ref}`);
  }
  const label = `${chartName}-${result.version}`;
  if (label.length > LABEL_LIMIT) {
    throw new Error(`the helm.sh/chart label ${label} is over ${LABEL_LIMIT}`);
  }
  return result;
}

export function publishedImages(
  records: readonly unknown[],
  commit: string,
): ChartImages {
  const seen = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    const { app } = record as { app?: unknown };
    if (typeof app !== "string" || !(app in APPS)) {
      throw new Error(`unexpected image record ${JSON.stringify(record)}`);
    }
    if (seen.has(app)) throw new Error(`two image records for ${app}`);
    seen.set(app, record as Record<string, unknown>);
  }
  const image = (app: keyof typeof APPS) => {
    const record = seen.get(app);
    if (record === undefined) throw new Error(`no image record for ${app}`);
    if (record.promoted !== true) throw new Error(`${app} was not promoted`);
    if (record.commit !== commit) {
      throw new Error(`${app} is of ${record.commit}, not ${commit}`);
    }
    if (typeof record.digest !== "string" || !DIGEST.test(record.digest)) {
      throw new Error(`${app} has digest ${record.digest}`);
    }
    if (typeof record.image !== "string" || record.image === "") {
      throw new Error(`${app} has image ${record.image}`);
    }
    return { repository: record.image, digest: record.digest };
  };
  const images = {
    controlHost: image("control-host"),
    egressProxy: image("egress-proxy"),
    worker: image("worker"),
    workerCodex: image("worker-codex"),
  };
  const runtimeOf = (app: "worker" | "worker-codex", engine: string) => {
    const { runtime } = seen.get(app) as { runtime?: unknown };
    parseImageRuntime(JSON.stringify(runtime ?? null));
    // An image built with the wrong engine would otherwise be released under
    // the other one's name.
    if ((runtime as { engine?: unknown }).engine !== engine) {
      throw new Error(
        `${app} runs the engine ${(runtime as { engine?: unknown }).engine}, not ${engine}`,
      );
    }
    return runtime as Record<string, unknown>;
  };
  return {
    ...images,
    worker: { ...images.worker, runtime: runtimeOf("worker", "claude") },
    workerCodex: {
      ...images.workerCodex,
      runtime: runtimeOf("worker-codex", "codex"),
    },
  };
}

/**
 * values.yaml with the images set, comments kept: operators read this file
 * through `helm show values`. Each edit must match exactly once, and a
 * repository other than the chart's default stops the package rather than
 * publish values whose comments name another location.
 */
export function bakeValues(text: string, images: ChartImages): string {
  const heading = "images:\n";
  const start = text.search(/^images:\n/m);
  if (start < 0) throw new Error("values.yaml has no images block");
  const body = start + heading.length;
  const next = text.slice(body).search(/^\S/m);
  if (next < 0) throw new Error("values.yaml ends inside the images block");
  const end = body + next;
  let block = text.slice(start, end);
  const edit = (key: string, tail: string, write: (kept: string) => string) => {
    const head = new RegExp(
      `^  ${key}:\\n    repository: (\\S+)\\n    digest: ""\\n${tail}`,
      "gm",
    );
    const matches = [...block.matchAll(head)];
    const [match] = matches;
    if (matches.length !== 1 || match === undefined) {
      throw new Error(`images.${key} in values.yaml is not in the known form`);
    }
    const image = images[key as keyof ChartImages];
    if (match[1] !== image.repository) {
      throw new Error(
        `images.${key}.repository is ${match[1]}, but the run published ${image.repository}`,
      );
    }
    const digest = `  ${key}:\n    repository: ${image.repository}\n    digest: ${image.digest}\n`;
    block = block.replace(match[0], () => digest + write(match[2] ?? ""));
  };
  edit("controlHost", "", () => "");
  edit("egressProxy", "", () => "");
  for (const key of ["worker", "workerCodex"] as const) {
    edit(
      key,
      "((?:    #.*\\n)*)    runtime: \\{\\}\\n",
      (comments) =>
        `${comments}    runtime: ${JSON.stringify(images[key].runtime)}\n`,
    );
  }
  return text.slice(0, start) + block + text.slice(end);
}

export function packageChart(input: {
  chartDir: string;
  outDir: string;
  version: string;
  appVersion: string;
  images: ChartImages;
}): { chart: string; values: string } {
  const { chartDir, outDir, version, appVersion, images } = input;
  const copy = join(mkdtempSync(join(tmpdir(), "chart-package-")), "chart");
  cpSync(chartDir, copy, { recursive: true });
  const valuesPath = join(copy, "values.yaml");
  writeFileSync(
    valuesPath,
    bakeValues(readFileSync(valuesPath, "utf8"), images),
  );
  mkdirSync(outDir, { recursive: true });
  const result = spawnSync(
    "helm",
    [
      "package",
      copy,
      "--version",
      version,
      "--app-version",
      appVersion,
      "--destination",
      outDir,
    ],
    { encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`helm package failed:\n${result.stdout}${result.stderr}`);
  }
  const name = chartField(chartDir, "name");
  const values = join(outDir, `${name}-${version}.values.yaml`);
  writeFileSync(values, `${JSON.stringify({ images }, null, 2)}\n`);
  return { chart: join(outDir, `${name}-${version}.tgz`), values };
}

function chartField(chartDir: string, field: string): string {
  const text = readFileSync(join(chartDir, "Chart.yaml"), "utf8");
  const value = text.match(new RegExp(`^${field}: (\\S+)$`, "m"))?.[1];
  if (value === undefined) throw new Error(`Chart.yaml has no ${field}`);
  return value;
}

if (import.meta.main) {
  const [publishedDir, outDir] = process.argv.slice(2);
  const { GITHUB_SHA: sha } = process.env;
  const ref = effectiveRef(process.env);
  if (!publishedDir || !outDir || !ref || !sha) {
    console.error(
      "usage: chart-package.ts <published dir> <out dir>, with GITHUB_REF and GITHUB_SHA set",
    );
    process.exit(1);
  }
  const chartDir = join(import.meta.dir, "../../deploy/helm/werft");
  const { version, appVersion } = chartVersion({
    ref,
    sha,
    chartYamlVersion: chartField(chartDir, "version"),
    chartName: chartField(chartDir, "name"),
  });
  const records = readdirSync(publishedDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) =>
      JSON.parse(readFileSync(join(publishedDir, file), "utf8")),
    ) as unknown[];
  const { chart, values } = packageChart({
    chartDir,
    outDir,
    version,
    appVersion,
    images: publishedImages(records, sha),
  });
  console.log(`${chart}\n${values}`);
}
