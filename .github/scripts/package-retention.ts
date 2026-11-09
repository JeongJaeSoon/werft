import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

const APPS = ["control-host", "worker", "egress-proxy"] as const;
const PACKAGES = [...APPS.map((app) => `werft-${app}`), "werft"];
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const AGE_MS = 7 * 24 * 60 * 60 * 1000;
const KEEP_NEWEST = 20;

export type Version = {
  id: number;
  name: string;
  created_at: string;
  updated_at: string;
  metadata: { container: { tags: string[] } };
};
export type Row = {
  package: string;
  id: number;
  digest: string;
  tags: string[];
  action: "keep" | "would-delete";
  reason: string;
};
type Api = {
  json: (path: string) => unknown;
  list: (path: string) => unknown[];
  asset: (id: number) => unknown;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected an object");
  }
  return value as Record<string, unknown>;
}

function ephemeral(pkg: string, tag: string): boolean {
  return pkg === "werft"
    ? /^0\.1\.0-main-[0-9a-f]{12,40}$/.test(tag)
    : /^main-[0-9a-f]{12,40}$/.test(tag) ||
        /^staging-[0-9]+(?:-[0-9]+)?(?:-(?:amd64|arm64))?$/.test(tag);
}

export function planRetention(
  pkg: string,
  versions: Version[],
  protectedDigests: Set<string>,
  protectedTags: Set<string>,
  now: number,
): Row[] {
  if (!PACKAGES.includes(pkg) || !Number.isFinite(now))
    throw new Error("invalid retention scope or time");
  const seen = new Set<number>();
  for (const v of versions) {
    if (
      !Number.isSafeInteger(v.id) ||
      v.id <= 0 ||
      seen.has(v.id) ||
      !DIGEST.test(v.name) ||
      !Number.isFinite(Date.parse(v.created_at)) ||
      !Number.isFinite(Date.parse(v.updated_at)) ||
      !Array.isArray(v.metadata?.container?.tags) ||
      !v.metadata.container.tags.every(
        (tag) => typeof tag === "string" && tag.length > 0,
      )
    ) {
      throw new Error(`invalid or duplicate package version in ${pkg}`);
    }
    seen.add(v.id);
  }
  const eligible = versions.filter(
    (v) =>
      v.metadata.container.tags.length > 0 &&
      v.metadata.container.tags.every((tag) => ephemeral(pkg, tag)),
  );
  const newest = new Set(
    eligible
      .sort(
        (a, b) =>
          Date.parse(b.updated_at) - Date.parse(a.updated_at) || b.id - a.id,
      )
      .slice(0, KEEP_NEWEST)
      .map((v) => v.id),
  );
  return versions.map((v) => {
    const tags = v.metadata.container.tags;
    let reason = "expired";
    if (
      protectedDigests.has(v.name) ||
      tags.some((tag) => protectedTags.has(tag))
    )
      reason = "release-manifest";
    else if (tags.length === 0) reason = "untagged";
    else if (tags.some((tag) => !ephemeral(pkg, tag)))
      reason = tags.some(
        (tag) =>
          !ephemeral(pkg, tag) && /^v?\d+\.\d+\.\d+(?:[-+].*)?$/.test(tag),
      )
        ? "semver"
        : "unknown-tag";
    else if (
      now - Math.max(Date.parse(v.created_at), Date.parse(v.updated_at)) <
      AGE_MS
    )
      reason = "recent";
    else if (newest.has(v.id)) reason = "newest";
    return {
      package: pkg,
      id: v.id,
      digest: v.name,
      tags,
      action: reason === "expired" ? "would-delete" : "keep",
      reason,
    };
  });
}

export function protectRelease(
  value: unknown,
  owner: string,
): { digests: Set<string>; chartTags: Set<string> } {
  const manifest = object(value);
  if (manifest.schema !== 1)
    throw new Error("unsupported release manifest schema");
  const images = object(manifest.images);
  const digests = new Set<string>();
  for (const app of APPS) {
    const image = object(images[app]);
    if (image.image !== `ghcr.io/${owner.toLowerCase()}/werft-${app}`)
      throw new Error(`unexpected manifest image for ${app}`);
    const platforms = object(image.platforms);
    for (const d of [image.digest, platforms.amd64, platforms.arm64]) {
      if (typeof d !== "string" || !DIGEST.test(d))
        throw new Error(`invalid release digest for ${app}`);
      digests.add(d);
    }
  }
  const chart = object(manifest.chart);
  if (
    chart.ref !== `oci://ghcr.io/${owner.toLowerCase()}/werft` ||
    typeof chart.version !== "string" ||
    chart.version.length === 0
  )
    throw new Error("invalid release chart");
  const collect = (value: unknown): void => {
    if (typeof value === "string" && value.startsWith("sha256:")) {
      if (!DIGEST.test(value))
        throw new Error("invalid digest in release manifest");
      digests.add(value);
    } else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object")
      Object.values(value).forEach(collect);
  };
  collect(manifest);
  return { digests, chartTags: new Set([chart.version]) };
}

// GHCR version deletion removes a whole digest, including its aliases. A kept
// multi-arch index must therefore protect its children before any proposal.
export async function retainDependencies(
  rows: Row[],
  readIndex: (digest: string) => Promise<string[]>,
): Promise<void> {
  if (!rows.some((row) => row.action === "would-delete")) return;
  const byDigest = new Map(rows.map((row) => [row.digest, row]));
  const queue = rows
    .filter((row) => row.action === "keep")
    .map((row) => row.digest);
  const seen = new Set<string>();
  while (queue.length > 0) {
    const batch = queue.splice(0, 4).filter((d) => {
      if (seen.has(d)) return false;
      seen.add(d);
      return true;
    });
    if (seen.size > 20000) throw new Error("unexpectedly large manifest graph");
    const children = (await Promise.all(batch.map(readIndex))).flat();
    for (const child of children) {
      if (!DIGEST.test(child)) throw new Error("invalid child manifest digest");
      const row = byDigest.get(child);
      if (row?.action === "would-delete") {
        row.action = "keep";
        row.reason = "kept-index";
      }
      if (!seen.has(child)) queue.push(child);
    }
  }
}

export function summarize(rows: Row[]): {
  would_delete: number;
  keep: number;
  exceptions: number;
} {
  return {
    would_delete: rows.filter((r) => r.action === "would-delete").length,
    keep: rows.filter((r) => r.action === "keep").length,
    exceptions: rows.filter(
      (r) => r.action === "keep" && !["recent", "newest"].includes(r.reason),
    ).length,
  };
}

export async function audit(
  repository: string,
  api: Api,
  index: (pkg: string, digest: string) => Promise<string[]>,
  now = Date.now(),
): Promise<Row[]> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new Error("invalid repository");
  const owner = repository.split("/")[0] as string;
  const repo = object(api.json(`repos/${repository}`));
  const ownerType = object(repo.owner).type;
  if (ownerType !== "User" && ownerType !== "Organization")
    throw new Error("unknown package owner type");
  const prefix = `${ownerType === "User" ? "users" : "orgs"}/${owner}/packages/container`;
  const protectedDigests = new Set<string>();
  const chartTags = new Set<string>();
  for (const value of api.list(`repos/${repository}/releases?per_page=100`)) {
    const release = object(value);
    if (
      !Number.isSafeInteger(release.id) ||
      typeof release.tag_name !== "string"
    )
      throw new Error("invalid release metadata");
    const assets = api
      .list(`repos/${repository}/releases/${release.id}/assets?per_page=100`)
      .map(object)
      .filter((asset) => asset.name === "release-manifest.json");
    if (assets.length === 0 && !/^v\d/.test(release.tag_name)) continue;
    if (assets.length !== 1 || !Number.isSafeInteger(assets[0]?.id))
      throw new Error(
        `missing or ambiguous release manifest for ${release.tag_name}`,
      );
    const manifest = object(api.asset(assets[0]?.id as number));
    if (manifest.tag !== release.tag_name)
      throw new Error("release manifest tag mismatch");
    const protection = protectRelease(manifest, owner);
    for (const d of protection.digests) protectedDigests.add(d);
    for (const tag of protection.chartTags) chartTags.add(tag);
  }
  const rows: Row[] = [];
  for (const pkg of PACKAGES) {
    const path = `${prefix}/${encodeURIComponent(pkg)}`;
    const metadata = object(api.json(path));
    if (object(metadata.repository).full_name !== repository)
      throw new Error(`${pkg} is not linked to the requested repository`);
    const versions = api.list(`${path}/versions?per_page=100`) as Version[];
    const planned = planRetention(
      pkg,
      versions,
      protectedDigests,
      pkg === "werft" ? chartTags : new Set(),
      now,
    );
    await retainDependencies(planned, (d) => index(pkg, d));
    rows.push(...planned);
  }
  return rows;
}

function gh(path: string, paginated = false, asset = false): unknown {
  const args = ["gh", "api", path];
  if (paginated) args.push("--paginate", "--slurp");
  if (asset) args.push("-H", "Accept: application/octet-stream");
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0)
    throw new Error(`GitHub read failed (${result.exitCode}): ${path}`);
  const data: unknown = JSON.parse(result.stdout.toString());
  if (!paginated) return data;
  if (!Array.isArray(data) || !data.every(Array.isArray))
    throw new Error("invalid paginated GitHub response");
  return data.flat();
}

async function checkedFetch(
  url: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(30000),
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(`registry read failed (HTTP ${response.status})`);
  return response;
}

export function registryReader(
  owner: string,
  get: typeof checkedFetch = checkedFetch,
): (pkg: string, digest: string) => Promise<string[]> {
  const tokens = new Map<string, Promise<string>>();
  return async (pkg, digest) => {
    if (!PACKAGES.includes(pkg) || !DIGEST.test(digest))
      throw new Error("invalid registry scope");
    const image = `${owner.toLowerCase()}/${pkg}`;
    if (!tokens.has(pkg))
      tokens.set(
        pkg,
        (async () => {
          const response = await get(
            `https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(`repository:${image}:pull`)}`,
          );
          const data = object(await response.json());
          if (typeof data.token !== "string")
            throw new Error("registry did not provide a read token");
          return data.token;
        })(),
      );
    const response = await get(
      `https://ghcr.io/v2/${image}/manifests/${digest}`,
      {
        Authorization: `Bearer ${await tokens.get(pkg)}`,
        Accept:
          "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
      },
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== digest)
      throw new Error("registry manifest digest mismatch");
    const manifest = object(JSON.parse(new TextDecoder().decode(bytes)));
    if (manifest.schemaVersion !== 2)
      throw new Error("unknown registry manifest schema");
    if (manifest.manifests !== undefined) {
      if (!Array.isArray(manifest.manifests))
        throw new Error("invalid registry index");
      return manifest.manifests.map((child) => {
        const d = object(child).digest;
        if (typeof d !== "string" || !DIGEST.test(d))
          throw new Error("invalid registry child digest");
        return d;
      });
    }
    if (!manifest.config || !Array.isArray(manifest.layers))
      throw new Error("unknown registry leaf manifest");
    return [];
  };
}

if (import.meta.main) {
  try {
    if (process.argv.slice(2).join(" ") !== "--dry-run")
      throw new Error(
        "only --dry-run is supported; deletion is not implemented",
      );
    const repository = process.env.GITHUB_REPOSITORY;
    if (!repository) throw new Error("GITHUB_REPOSITORY is required");
    const rows = await audit(
      repository,
      {
        json: (path) => gh(path),
        list: (path) => gh(path, true) as unknown[],
        asset: (id) =>
          gh(`repos/${repository}/releases/assets/${id}`, false, true),
      },
      registryReader(repository.split("/")[0] as string),
    );
    for (const row of rows) console.log(JSON.stringify(row));
    const summary = summarize(rows);
    console.log(
      JSON.stringify({
        mode: "dry-run",
        retention_days: 7,
        keep_newest_per_package: KEEP_NEWEST,
        summary,
        exceptions: rows.filter(
          (r) =>
            r.action === "keep" && !["recent", "newest"].includes(r.reason),
        ),
      }),
    );
    for (const pkg of PACKAGES) {
      console.log(
        JSON.stringify({
          package: pkg,
          summary: summarize(rows.filter((row) => row.package === pkg)),
        }),
      );
    }
    console.log(JSON.stringify({ mode: "dry-run", summary }));
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `## Package retention (dry run)\n\nWould delete: ${summary.would_delete}; keep: ${summary.keep}; exceptions: ${summary.exceptions}.\n\nNo deletion is implemented. The log lists every version and exception.\n`,
      );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "retention audit failed",
    );
    process.exitCode = 1;
  }
}
