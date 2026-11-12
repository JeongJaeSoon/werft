/**
 * npm advisories against every bun.lock in `LOCKFILES`, split by whether a
 * fix exists: `bun .github/scripts/npm-audit.ts <result dir>`.
 *
 * `bun audit` names the advisories but not whether a patched version exists.
 * That comes from the GitHub advisory database, the source Grype uses for
 * the images' npm packages too, so both scans mean the same by "fixable":
 * the advisory's range that holds the locked version has a first patched
 * version. High and critical ones are reported; only the fixable ones count.
 *
 * Like image-scan.sh, findings never fail this script. The verdict goes to
 * `<result dir>/npm.txt` as `clean` or `found <n>`, every high or critical
 * finding to `<result dir>/npm.json`, and the caller decides. A run that got
 * no answer (advisory service, GitHub API) leaves `error` and exits 1.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Advisory = {
  url: string;
  title: string;
  severity: string;
  vulnerable_versions: string;
};
/** `bun audit --json`: advisories by package name. */
export type Audit = Record<string, Advisory[]>;

export type GhsaRange = {
  package: { ecosystem: string; name: string };
  vulnerable_version_range: string;
  first_patched_version: string | null;
};

export type Finding = {
  package: string;
  version: string;
  id: string;
  severity: string;
  url: string;
  /** The first patched version, null when there is none. */
  fix: string | null;
  /** Set when an entry of the exceptions file covers it. */
  excepted?: string;
  /** The `LOCKFILES` directory whose bun.lock holds it. */
  lockfile?: string;
};

export type Exception = {
  id: string;
  package: string;
  reason: string;
  /** YYYY-MM-DD, the last day it applies. */
  expires: string;
};

const BLOCKING = new Set(["high", "critical"]);

/**
 * Directories, from the repository root, of every bun.lock. The compat
 * harness installs on its own, outside the workspace, so its lockfile is
 * audited separately; tests/supply-chain.test.ts fails on one left out.
 */
export const LOCKFILES = [".", "scripts/agent-sdk-compat"];

/** name → every version bun.lock resolves it to. */
export function lockedVersions(lockText: string): Map<string, Set<string>> {
  const lock = Bun.JSONC.parse(lockText) as {
    packages: Record<string, [string, ...unknown[]]>;
  };
  const versions = new Map<string, Set<string>>();
  for (const [spec] of Object.values(lock.packages)) {
    const at = spec.lastIndexOf("@");
    const name = spec.slice(0, at);
    const version = spec.slice(at + 1);
    if (at <= 0 || !Bun.semver.satisfies(version, "*")) continue;
    versions.set(name, (versions.get(name) ?? new Set()).add(version));
  }
  return versions;
}

/** `>= 2.0.0, < 2.3.1` (GitHub's spelling) as a semver range. */
const semverRange = (range: string) => range.replaceAll(",", " ");

const ghsaOf = (url: string) => url.match(/\/(GHSA-[\w-]+)$/)?.[1] ?? url;

/**
 * One finding per locked version an advisory at `BLOCKING` severity applies
 * to. `ranges` gives each GHSA id's affected ranges; an id missing from it is
 * an error, since without it fixable and unfixed cannot be told apart.
 */
export function findings(
  audit: Audit,
  locked: Map<string, Set<string>>,
  ranges: Map<string, GhsaRange[]>,
): Finding[] {
  const out: Finding[] = [];
  for (const [name, advisories] of Object.entries(audit)) {
    for (const advisory of advisories) {
      if (!BLOCKING.has(advisory.severity)) continue;
      const id = ghsaOf(advisory.url);
      const known = ranges.get(id);
      if (!known) throw new Error(`no affected ranges for ${id}`);
      const own = known.filter(
        (range) =>
          range.package.ecosystem === "npm" && range.package.name === name,
      );
      const affected = [...(locked.get(name) ?? [])].filter((version) =>
        Bun.semver.satisfies(version, advisory.vulnerable_versions),
      );
      // bun audit found it, so something in the lockfile is affected even if
      // the version cannot be matched here; count it rather than drop it.
      for (const version of affected.length > 0 ? affected : ["?"]) {
        const holding = own.filter((range) =>
          Bun.semver.satisfies(
            version,
            semverRange(range.vulnerable_version_range),
          ),
        );
        // A version no range claims (a spelling semver does not read) takes
        // any patched version the package has: better a false block than a
        // missed fix.
        const fix =
          (holding.length > 0 ? holding : own).find(
            (range) => range.first_patched_version,
          )?.first_patched_version ?? null;
        out.push({
          package: name,
          version,
          id,
          severity: advisory.severity,
          url: advisory.url,
          fix,
        });
      }
    }
  }
  return out;
}

/** Validates `.github/vulnerability-exceptions.json`; a bad entry throws. */
export function parseExceptions(text: string): Exception[] {
  const entries = JSON.parse(text) as unknown;
  if (!Array.isArray(entries)) throw new Error("exceptions: not an array");
  for (const entry of entries as Partial<Exception>[]) {
    for (const key of ["id", "package", "reason", "expires"] as const)
      if (typeof entry?.[key] !== "string" || entry[key] === "")
        throw new Error(`exceptions: ${JSON.stringify(entry)} has no ${key}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.expires as string))
      throw new Error(`exceptions: ${entry.id} expires is not YYYY-MM-DD`);
  }
  return entries as Exception[];
}

/** Marks each finding an unexpired exception covers; `today` is YYYY-MM-DD. */
export function applyExceptions(
  list: Finding[],
  exceptions: Exception[],
  today: string,
): Finding[] {
  return list.map((finding) => {
    const match = exceptions.find(
      (entry) =>
        entry.id === finding.id &&
        entry.package === finding.package &&
        entry.expires >= today,
    );
    return match ? { ...finding, excepted: match.reason } : finding;
  });
}

export const blocking = (list: Finding[]) =>
  list.filter((finding) => finding.fix !== null && !finding.excepted);

async function fetchRanges(id: string): Promise<GhsaRange[]> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
  };
  if (process.env.GH_TOKEN)
    headers.authorization = `Bearer ${process.env.GH_TOKEN}`;
  const response = await fetch(`https://api.github.com/advisories/${id}`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${id}: GitHub API ${response.status}`);
  return ((await response.json()) as { vulnerabilities: GhsaRange[] })
    .vulnerabilities;
}

const line = (finding: Finding) =>
  `${finding.lockfile ?? "."} ${finding.severity} ${finding.package} ${finding.version} → ${finding.fix ?? "no fix"} ${finding.id}${finding.excepted ? ` (excepted: ${finding.excepted})` : ""}`;

async function main(results: string) {
  const root = join(import.meta.dir, "..", "..");
  mkdirSync(results, { recursive: true });
  const resultFile = join(results, "npm.txt");
  writeFileSync(resultFile, "error\n");

  // Each whole bun.lock, dev dependencies included: a compromised build tool
  // is a supply-chain problem too. `bun audit` exits 1 both for advisories
  // and for a failed request, so only its JSON tells them apart.
  const audits = new Map<string, Audit>();
  for (const dir of LOCKFILES) {
    const run = Bun.spawnSync(["bun", "audit", "--json"], {
      cwd: join(root, dir),
    });
    try {
      const audit = JSON.parse(run.stdout.toString()) as Audit;
      if (typeof audit !== "object" || audit === null || Array.isArray(audit))
        throw new Error("not an object");
      audits.set(dir, audit);
    } catch {
      console.error(run.stderr.toString());
      console.error(
        `${dir}: bun audit got no answer from the advisory service`,
      );
      process.exit(1);
    }
  }

  const ids = new Set(
    [...audits.values()]
      .flatMap((audit) => Object.values(audit).flat())
      .filter((advisory) => BLOCKING.has(advisory.severity))
      .map((advisory) => ghsaOf(advisory.url)),
  );
  const ranges = new Map<string, GhsaRange[]>();
  for (const id of ids) ranges.set(id, await fetchRanges(id));

  const exceptions = parseExceptions(
    readFileSync(
      join(root, ".github", "vulnerability-exceptions.json"),
      "utf8",
    ),
  );
  const today = new Date().toISOString().slice(0, 10);
  const all = [...audits].flatMap(([dir, audit]) =>
    applyExceptions(
      findings(
        audit,
        lockedVersions(readFileSync(join(root, dir, "bun.lock"), "utf8")),
        ranges,
      ),
      exceptions,
      today,
    ).map((finding) => ({ ...finding, lockfile: dir })),
  );
  const count = blocking(all).length;
  const unfixed = all.filter((finding) => finding.fix === null);

  for (const [dir, audit] of audits)
    for (const [name, advisories] of Object.entries(audit))
      for (const advisory of advisories)
        console.log(
          `${dir}\t${advisory.severity}\t${name} ${advisory.vulnerable_versions}\t${advisory.url}`,
        );
  const summary = [
    "### npm: vulnerabilities",
    "",
    `${count} high or critical with a fix available, ${unfixed.length} without one (reported, not blocking). Every advisory in the step log.`,
    "",
    "```text",
    ...all.map(line),
    "```",
    "",
  ].join("\n");
  if (process.env.GITHUB_STEP_SUMMARY)
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: "a" });
  else console.log(summary);

  writeFileSync(join(results, "npm.json"), `${JSON.stringify(all, null, 2)}\n`);
  writeFileSync(resultFile, count > 0 ? `found ${count}\n` : "clean\n");
}

if (import.meta.main) {
  const [results] = process.argv.slice(2);
  if (!results) {
    console.error("usage: bun .github/scripts/npm-audit.ts <result dir>");
    process.exit(2);
  }
  await main(results);
}
