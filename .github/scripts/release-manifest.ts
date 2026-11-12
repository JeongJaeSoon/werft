/**
 * Writes the manifest a GitHub Release carries:
 * `bun .github/scripts/release-manifest.ts <published dir> <chart dir> <out file>`
 * with GITHUB_REF, GITHUB_SHA and GITHUB_REPOSITORY_OWNER set.
 *
 * <published dir> is `image-digests-published`, <chart dir> the `chart`
 * artifact. One JSON file holds the four image digests, the runtime of each
 * worker image and the chart version, so an operator reads a release without a run artifact.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  chartVersion,
  effectiveRef,
  publishedImages,
} from "./chart-package.ts";

const MANIFEST_SCHEMA = 1;
export const MANIFEST_ASSET = "release-manifest.json";

const APPS = [
  "control-host",
  "worker",
  "worker-codex",
  "egress-proxy",
] as const;
const ARCHES = ["amd64", "arm64"] as const;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const CHART_NAME = "werft";

export type ReleaseManifest = {
  schema: typeof MANIFEST_SCHEMA;
  tag: string;
  commit: string;
  images: Record<
    (typeof APPS)[number],
    {
      image: string;
      /** The multi-arch index, what a deployment pins. */
      digest: string;
      platforms: Record<(typeof ARCHES)[number], string>;
    }
  >;
  workerRuntime: Record<string, unknown>;
  /** The Codex worker image's runtime; `images["worker-codex"]` is that image. */
  workerCodexRuntime: Record<string, unknown>;
  chart: {
    name: string;
    version: string;
    appVersion: string;
    ref: string;
  };
};

export type ChartFiles = {
  /** Name of the `werft-<version>.tgz` file. */
  tgzName: string;
  /** Chart.yaml and values.yaml of the package, read from inside it. */
  chartYaml: string;
  valuesYaml: string;
};

export function buildManifest(input: {
  ref: string;
  sha: string;
  owner: string;
  records: readonly unknown[];
  chart: ChartFiles;
}): ReleaseManifest {
  const { ref, sha, owner, records, chart } = input;
  if (!ref.startsWith("refs/tags/")) {
    throw new Error(`a release manifest is made from a tag, not ${ref}`);
  }
  const tag = ref.slice("refs/tags/".length);
  const expected = chartVersion({
    ref,
    sha,
    chartYamlVersion: "0.0.0",
    chartName: CHART_NAME,
  });
  // The package name is what chart-publish pushed.
  if (chart.tgzName !== `${CHART_NAME}-${expected.version}.tgz`) {
    throw new Error(
      `chart package ${chart.tgzName}, expected ${CHART_NAME}-${expected.version}.tgz`,
    );
  }
  const field = (name: string) =>
    chart.chartYaml.match(new RegExp(`^${name}: "?([^"\\s]+)"?$`, "m"))?.[1];
  if (field("version") !== expected.version) {
    throw new Error(`Chart.yaml version is ${field("version")}`);
  }
  if (field("appVersion") !== expected.appVersion) {
    throw new Error(`Chart.yaml appVersion is ${field("appVersion")}`);
  }

  const baked = publishedImages(records, sha);
  const byApp = new Map(
    records.map((record) => [(record as { app: string }).app, record]),
  );
  const images = {} as ReleaseManifest["images"];
  for (const app of APPS) {
    const record = byApp.get(app) as {
      ref?: unknown;
      platforms?: Record<string, { digest?: unknown }>;
    };
    if (record.ref !== ref) {
      throw new Error(`${app} was published from ${record.ref}, not ${ref}`);
    }
    const key =
      app === "control-host"
        ? "controlHost"
        : app === "worker"
          ? "worker"
          : app === "worker-codex"
            ? "workerCodex"
            : "egressProxy";
    const { repository, digest } = baked[key];
    const platforms = {} as Record<(typeof ARCHES)[number], string>;
    if (
      Object.keys(record.platforms ?? {})
        .sort()
        .join() !== [...ARCHES].join()
    ) {
      throw new Error(`${app} platforms are not exactly ${ARCHES.join(", ")}`);
    }
    for (const arch of ARCHES) {
      const platformDigest = record.platforms?.[arch]?.digest;
      if (typeof platformDigest !== "string" || !DIGEST.test(platformDigest)) {
        throw new Error(`${app} ${arch} has digest ${platformDigest}`);
      }
      platforms[arch] = platformDigest;
    }
    // The package must name the digest this manifest does.
    if (!chart.valuesYaml.includes(`digest: ${digest}\n`)) {
      throw new Error(`the chart's values.yaml does not hold ${app} ${digest}`);
    }
    images[app] = { image: repository, digest, platforms };
  }
  return {
    schema: MANIFEST_SCHEMA,
    tag,
    commit: sha,
    images,
    workerRuntime: baked.worker.runtime,
    workerCodexRuntime: baked.workerCodex.runtime,
    chart: {
      name: CHART_NAME,
      version: expected.version,
      appVersion: expected.appVersion,
      ref: `oci://ghcr.io/${owner.toLowerCase()}/${CHART_NAME}`,
    },
  };
}

function readChart(dir: string): ChartFiles {
  const tgzs = readdirSync(dir).filter((file) => file.endsWith(".tgz"));
  const [tgzName] = tgzs;
  if (tgzs.length !== 1 || tgzName === undefined) {
    throw new Error(`${dir} holds ${tgzs.length} chart packages, not one`);
  }
  const inside = (file: string) => {
    const result = spawnSync(
      "tar",
      ["-xzOf", join(dir, tgzName), `${CHART_NAME}/${file}`],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(`cannot read ${file} in ${tgzName}: ${result.stderr}`);
    }
    return result.stdout;
  };
  return {
    tgzName,
    chartYaml: inside("Chart.yaml"),
    valuesYaml: inside("values.yaml"),
  };
}

if (import.meta.main) {
  const [publishedDir, chartDir, outFile] = process.argv.slice(2);
  const { GITHUB_SHA: sha, GITHUB_REPOSITORY_OWNER: owner } = process.env;
  const ref = effectiveRef(process.env);
  if (!publishedDir || !chartDir || !outFile || !ref || !sha || !owner) {
    console.error(
      "usage: release-manifest.ts <published dir> <chart dir> <out file>, with GITHUB_REF, GITHUB_SHA and GITHUB_REPOSITORY_OWNER set",
    );
    process.exit(1);
  }
  const records = readdirSync(publishedDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) =>
      JSON.parse(readFileSync(join(publishedDir, file), "utf8")),
    ) as unknown[];
  const manifest = buildManifest({
    ref,
    sha,
    owner,
    records,
    chart: readChart(chartDir),
  });
  writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${outFile}`);
}
