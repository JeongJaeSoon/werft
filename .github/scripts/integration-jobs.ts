#!/usr/bin/env bun
// The integration suite runs as one CI job per domain, each with
// only the services its tests need. Which files a job owns and which services
// it starts are declared once, in .github/integration-domains.yml; this script
// reads it from there, and gives ci.yml's `changes` job the matrix entries of
// the planned domains.
//
// A job never sees another's list, so the whole assignment is checked on every
// `files` and `verify` call before anything is printed: a file that belongs to no job would pass
// silently, which is the one failure this split must not have.
//
// usage:
// A domain declared with `shards: N` runs as N jobs of that matrix, each with
// its own runner and services (so its own database), and every file of the
// domain in exactly one of them: sorted, the i-th file goes to shard i mod N.
//
// usage:
//   integration-jobs.ts matrix <domains>                 the matrix entries of those domains (a
//                                                        JSON array of names), one per shard, as
//                                                        one line of JSON
//   integration-jobs.ts files <domain> <shard>           the files that shard runs, one ./path per line
//   integration-jobs.ts verify <domain> <shard> <junit>  fails unless the junit report ran exactly
//                                                        those files and skipped only what the
//                                                        domain declares for them
//   integration-jobs.ts select <paths>                   the domains a pull request's changed
//                                                        paths (a NUL-separated file, prose
//                                                        already left out) reach, as one line of
//                                                        JSON; each path's reason goes to stderr

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { suiteFiles, TEST_FILE } from "./test-files.ts";

export type DeclaredSkip = { file: string; test: string };

export type IntegrationJob = {
  domain: string;
  paths: string[];
  skips: DeclaredSkip[];
  shards: number;
};

type Services = {
  postgres: boolean;
  localstack: boolean;
  docker: boolean;
};

/** One job of the matrix: `name` is "db" alone, or "db 2/3" for a shard. */
export type MatrixEntry = Services & {
  domain: string;
  name: string;
  shard: number;
  shards: number;
};

const DECLARATION = ".github/integration-domains.yml";

function readEntries(declaration: string): (IntegrationJob & Services)[] {
  const parsed = Bun.YAML.parse(declaration) as {
    domains?: Record<string, unknown>[];
  } | null;
  const entries = parsed?.domains;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`${DECLARATION} has no domains list`);
  }
  return entries.map((entry, index) => {
    const { domain, paths, skips = [], shards = 1 } = entry;
    if (typeof domain !== "string" || domain === "") {
      throw new Error(`${DECLARATION} entry ${index + 1} has no domain`);
    }
    for (const flag of ["postgres", "localstack", "docker"]) {
      // The services and opt-in variables key off these; a missing one reads
      // as false in an expression and would drop a service without a word.
      if (typeof entry[flag] !== "boolean") {
        throw new Error(`${domain}: ${flag} must be true or false`);
      }
    }
    if (
      !Array.isArray(paths) ||
      paths.length === 0 ||
      !paths.every((path) => typeof path === "string" && path !== "")
    ) {
      throw new Error(`${domain}: paths must be a non-empty list of prefixes`);
    }
    if (
      !Array.isArray(skips) ||
      !skips.every(
        (skip) =>
          typeof skip?.file === "string" && typeof skip?.test === "string",
      )
    ) {
      throw new Error(`${domain}: skips must be a list of {file, test}`);
    }
    if (typeof shards !== "number" || !Number.isInteger(shards) || shards < 1) {
      throw new Error(`${domain}: shards must be a whole number of 1 or more`);
    }
    return {
      domain,
      postgres: entry.postgres as boolean,
      localstack: entry.localstack as boolean,
      docker: entry.docker as boolean,
      paths,
      skips: skips as DeclaredSkip[],
      shards,
    };
  });
}

/** The domains declared in .github/integration-domains.yml, in order. */
export function readJobs(declaration: string): IntegrationJob[] {
  return readEntries(declaration).map(({ domain, paths, skips, shards }) => ({
    domain,
    paths,
    skips,
    shards,
  }));
}

/**
 * The `integration-domain` matrix entries of the planned domains, in
 * declaration order. An empty, malformed or unknown plan throws: Actions would
 * start no job for an empty matrix, and a name no entry declares would drop
 * a domain without a word.
 */
export function matrix(declaration: string, planned: string): MatrixEntry[] {
  let names: unknown;
  try {
    names = JSON.parse(planned);
  } catch {
    names = undefined;
  }
  if (
    !Array.isArray(names) ||
    names.length === 0 ||
    !names.every((name) => typeof name === "string")
  ) {
    throw new Error(
      `planned domains must be a non-empty JSON array of names: ${planned}`,
    );
  }
  const wanted: string[] = names;
  if (new Set(wanted).size !== wanted.length) {
    throw new Error(`planned domains name one twice: ${planned}`);
  }
  const entries = readEntries(declaration);
  const unknown = wanted.filter(
    (name) => !entries.some((entry) => entry.domain === name),
  );
  if (unknown.length > 0) {
    throw new Error(`no integration domain named ${unknown.join(", ")}`);
  }
  return entries
    .filter((entry) => wanted.includes(entry.domain))
    .flatMap(({ domain, postgres, localstack, docker, shards }) =>
      Array.from({ length: shards }, (_, index) => ({
        domain,
        name: shards === 1 ? domain : `${domain} ${index + 1}/${shards}`,
        shard: index + 1,
        shards,
        postgres,
        localstack,
        docker,
      })),
    );
}

/**
 * The files of one shard (1-based) of a domain's `owned` files: every
 * `shards`-th file from the shard's own position. Throws on a shard the
 * domain does not have.
 */
export function shardFiles(
  owned: string[],
  shards: number,
  shard: number,
): string[] {
  if (!Number.isInteger(shard) || shard < 1 || shard > shards) {
    throw new Error(`no shard ${shard} of ${shards}`);
  }
  return owned.filter((_, index) => index % shards === shard - 1);
}

/** The job one shard runs: a declared skip belongs to the shard that runs its file. */
export function forShard(job: IntegrationJob, owned: string[]): IntegrationJob {
  return {
    ...job,
    skips: job.skips.filter((skip) => owned.includes(skip.file)),
  };
}

/**
 * Each file goes to the job whose path prefix it starts with; when prefixes
 * nest, the longest one owns it, so a domain split off another (`sessions`
 * out of `db`'s `packages/db/`) names only what it takes. Throws unless that
 * is exactly one job for every file — two jobs with equally long prefixes for
 * it are a mistake — and unless every prefix and every job still owns
 * something: a stale entry means the matrix no longer says what the jobs run.
 */
export function assign(
  files: string[],
  jobs: IntegrationJob[],
): Map<string, string[]> {
  const byDomain = new Map<string, string[]>();
  for (const job of jobs) {
    if (byDomain.has(job.domain)) {
      throw new Error(`domain ${job.domain} is declared twice`);
    }
    byDomain.set(job.domain, []);
  }
  const problems: string[] = [];
  const usedPaths = new Set<string>();
  for (const file of files) {
    const matches = jobs.flatMap((job) =>
      job.paths
        .filter((path) => file.startsWith(path))
        .map((path) => ({ job, path })),
    );
    const longest = Math.max(0, ...matches.map(({ path }) => path.length));
    const owners = matches.filter(({ path }) => path.length === longest);
    const domains = [...new Set(owners.map(({ job }) => job.domain))];
    for (const { job, path } of owners) {
      usedPaths.add(`${job.domain}\0${path}`);
    }
    if (owners.length === 0) {
      problems.push(`${file} belongs to no integration job`);
    } else if (domains.length > 1) {
      problems.push(`${file} belongs to ${domains.join(" and ")}`);
    } else {
      byDomain.get(domains[0]!)!.push(file);
    }
  }
  for (const job of jobs) {
    for (const path of job.paths) {
      if (!usedPaths.has(`${job.domain}\0${path}`)) {
        problems.push(`${job.domain}: ${path} matches no test file`);
      }
    }
    // `bun test` with no path runs the whole suite, so an empty job would
    // quietly repeat every other job's work instead of doing nothing.
    const count = byDomain.get(job.domain)!.length;
    if (count === 0) {
      problems.push(`${job.domain} has no files`);
    } else if (count < job.shards) {
      // The same for an empty shard: it would run the whole suite.
      problems.push(
        `${job.domain} has ${count} files for ${job.shards} shards`,
      );
    }
    for (const skip of job.skips) {
      if (!byDomain.get(job.domain)!.includes(skip.file)) {
        problems.push(
          `${job.domain}: declared skip in ${skip.file}, which it does not run`,
        );
      }
    }
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return byDomain;
}

/**
 * Packages every domain builds on. Their computed reach is every domain
 * already; naming them keeps that true if an import moves.
 */
export const SHARED_PACKAGES = [
  "packages/contracts",
  "packages/db",
  "packages/observability",
  "packages/platform",
  "packages/runtime-core",
  "packages/system",
  "packages/testkit",
];

/**
 * What the selection follows through imports. Any other file (prose, JSON,
 * YAML, SQL, a Dockerfile, a snapshot, a stylesheet) may be read by a test
 * of any domain under a name it builds at run time, so it runs them all.
 */
const CODE_FILE = /\.[cm]?[jt]sx?$/;

/**
 * The domain that owns the suites that read every source file whatever
 * imports it (architecture, forbidden terms, copy checks), so a plan that
 * drops domains always keeps it.
 */
const POLICY_DOMAIN = "worker";

export type Workspace = {
  /** Package directory, e.g. "packages/db", and its package name. */
  packages: Map<string, string>;
  /** Package directory → the package directories it depends on, transitively, itself included. */
  closure: Map<string, Set<string>>;
};

export function readWorkspace(cwd: string): Workspace {
  const root = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  const dirs: string[] = [];
  for (const pattern of root.workspaces as string[]) {
    if (!pattern.endsWith("/*")) {
      throw new Error(`workspace pattern ${pattern} is not <dir>/*`);
    }
    const parent = pattern.slice(0, -2);
    for (const item of readdirSync(join(cwd, parent), {
      withFileTypes: true,
    })) {
      const dir = `${parent}/${item.name}`;
      if (item.isDirectory() && existsSync(join(cwd, dir, "package.json"))) {
        dirs.push(dir);
      }
    }
  }
  const byName = new Map<string, string>();
  const manifests = new Map<string, Record<string, unknown>>();
  for (const dir of dirs) {
    const manifest = JSON.parse(
      readFileSync(join(cwd, dir, "package.json"), "utf8"),
    );
    manifests.set(dir, manifest);
    if (typeof manifest.name === "string") byName.set(manifest.name, dir);
  }
  const direct = new Map<string, string[]>();
  for (const [dir, manifest] of manifests) {
    const names = ["dependencies", "devDependencies", "peerDependencies"]
      .flatMap((field) => Object.keys((manifest[field] as object) ?? {}))
      .filter((name) => byName.has(name));
    direct.set(
      dir,
      names.map((name) => byName.get(name)!),
    );
  }
  const closure = new Map<string, Set<string>>();
  for (const dir of dirs) {
    const seen = new Set([dir]);
    const stack = [dir];
    while (stack.length > 0) {
      for (const next of direct.get(stack.pop()!) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    closure.set(dir, seen);
  }
  return {
    packages: new Map([...byName].map(([name, dir]) => [dir, name])),
    closure,
  };
}

/** The package directory a path lies in (the longest one), if any. */
export function packageOf(
  path: string,
  workspace: Workspace,
): string | undefined {
  let best: string | undefined;
  for (const dir of workspace.packages.keys()) {
    if (path.startsWith(`${dir}/`) && (!best || dir.length > best.length)) {
      best = dir;
    }
  }
  return best;
}

const IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\(\s*)["']([^"']+)["']/g;
const EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  "/index.ts",
  "/index.tsx",
];

/**
 * The packages a test file can reach: the package of every file its imports
 * lead to (relative ones followed file by file, workspace ones by name), and
 * everything those packages depend on.
 */
export function reachedPackages(
  cwd: string,
  testFile: string,
  workspace: Workspace,
  read: (path: string) => string,
): Set<string> {
  const byName = new Map(
    [...workspace.packages].map(([dir, name]) => [name, dir]),
  );
  const packages = new Set<string>();
  const seen = new Set<string>();
  const stack = [testFile];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const own = packageOf(file, workspace);
    if (own) packages.add(own);
    for (const match of read(file).matchAll(IMPORT)) {
      const spec = match[1]!;
      if (spec.startsWith(".")) {
        const base = normalize(join(dirname(file), spec));
        const candidates = [
          ...EXTENSIONS.map((ext) => base + ext),
          base.replace(/\.js$/, ".ts"),
          base.replace(/\.js$/, ".tsx"),
        ];
        const found = candidates.find((candidate) =>
          statSync(join(cwd, candidate), { throwIfNoEntry: false })?.isFile(),
        );
        if (found && !seen.has(found)) stack.push(found);
        continue;
      }
      const parts = spec.split("/");
      const name = spec.startsWith("@")
        ? parts.slice(0, 2).join("/")
        : parts[0]!;
      const dir = byName.get(name);
      if (dir) packages.add(dir);
    }
  }
  const reached = new Set<string>();
  for (const dir of packages) {
    for (const dep of workspace.closure.get(dir) ?? [dir]) reached.add(dep);
  }
  return reached;
}

export type Selection = { domains: string[]; reasons: string[] };

/**
 * The integration domains a pull request's changed paths reach, in
 * declaration order. A plan that drops a domain keeps `worker`.
 */
export function selectDomains(
  cwd: string,
  declaration: string,
  paths: string[],
): Selection {
  const selector = domainSelector(cwd, declaration);
  const picked = new Set<string>();
  const reasons: string[] = [];
  for (const path of paths) {
    const { domains, why } = selector.forPath(path);
    for (const domain of domains) picked.add(domain);
    // JSON: a path is data, and a line break in it would start a workflow
    // command in the job's log.
    reasons.push(`${JSON.stringify(path)} -> ${domains.join(", ")} (${why})`);
  }
  if (picked.size < selector.all.length) picked.add(POLICY_DOMAIN);
  return {
    domains: selector.all.filter((domain) => picked.has(domain)),
    reasons,
  };
}

/**
 * The domains one changed path reaches. Whatever this cannot place runs every
 * domain:
 * - a test file runs the domain that owns it;
 * - a code file of a package runs the domains whose tests reach that
 *   package; a shared package, or one bunfig.toml preloads into every test,
 *   runs them all;
 * - anything else runs them all: prose and other files tests read by name,
 *   a package.json, the lockfile, the workflows and CI scripts, root
 *   configuration, scripts, charts and test helpers outside a package.
 */
export function domainSelector(
  cwd: string,
  declaration: string,
): {
  all: string[];
  forPath(path: string): { domains: string[]; why: string };
} {
  const jobs = readJobs(declaration);
  const all = jobs.map((job) => job.domain);
  if (!all.includes(POLICY_DOMAIN)) {
    throw new Error(`integration domains have no ${POLICY_DOMAIN} domain`);
  }
  const tests = suiteFiles(cwd);
  const owners = assign(tests, jobs);
  const ownerOf = new Map<string, string>();
  for (const [domain, files] of owners) {
    for (const file of files) ownerOf.set(file, domain);
  }
  const workspace = readWorkspace(cwd);
  // Every file read here exists (a suite file, or an import found on disk):
  // one that cannot be read fails the selection rather than drop its reach.
  const cache = new Map<string, string>();
  const read = (path: string) => {
    if (!cache.has(path))
      cache.set(path, readFileSync(join(cwd, path), "utf8"));
    return cache.get(path)!;
  };
  // A preload runs in every test process, whichever domain it belongs to.
  const bunfig = Bun.TOML.parse(
    readFileSync(join(cwd, "bunfig.toml"), "utf8"),
  ) as {
    test?: { preload?: string[] };
  };
  const preloaded = new Set<string>();
  for (const preload of bunfig.test?.preload ?? []) {
    for (const dir of reachedPackages(
      cwd,
      normalize(preload),
      workspace,
      read,
    )) {
      preloaded.add(dir);
    }
  }
  let reach: Map<string, Set<string>> | undefined;
  const domainsReaching = (dir: string) => {
    reach ??= new Map(
      [...owners].map(([domain, files]) => {
        const reached = new Set<string>();
        for (const file of files) {
          for (const pkg of reachedPackages(cwd, file, workspace, read)) {
            reached.add(pkg);
          }
        }
        return [domain, reached];
      }),
    );
    return all.filter((domain) => reach!.get(domain)!.has(dir));
  };

  const forPath = (path: string): { domains: string[]; why: string } => {
    const name = path.split("/").at(-1)!;
    if (TEST_FILE.test(name)) {
      // A test file of the suite runs its own domain; another one (a deleted
      // file, or one outside the suite's directories) is placed by prefix,
      // and runs everything when no domain owns it.
      const owner = ownerOf.get(path) ?? ownerByPrefix(path, jobs);
      if (owner) return { domains: [owner], why: "test file" };
    }
    const pkg = packageOf(path, workspace);
    if (!pkg) return { domains: all, why: "outside every package" };
    if (!CODE_FILE.test(name)) {
      return { domains: all, why: `not a code file of ${pkg}` };
    }
    if (SHARED_PACKAGES.includes(pkg)) {
      return { domains: all, why: `shared package ${pkg}` };
    }
    if (preloaded.has(pkg)) {
      return { domains: all, why: `${pkg} is preloaded into every test` };
    }
    const domains = domainsReaching(pkg);
    return domains.length > 0
      ? { domains, why: `package ${pkg}` }
      : { domains: all, why: `package ${pkg}, which no test reaches` };
  };
  return { all, forPath };
}

/** The domain whose longest path prefix a path starts with, if exactly one. */
function ownerByPrefix(
  path: string,
  jobs: IntegrationJob[],
): string | undefined {
  const matches = jobs.flatMap((job) =>
    job.paths.filter((p) => path.startsWith(p)).map((p) => ({ job, p })),
  );
  const longest = Math.max(0, ...matches.map(({ p }) => p.length));
  const owners = new Set(
    matches
      .filter(({ p }) => p.length === longest)
      .map(({ job }) => job.domain),
  );
  return owners.size === 1 ? [...owners][0] : undefined;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"',
};

function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    }
    if (name.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    }
    return ENTITIES[name] ?? whole;
  });
}

function attribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(attributes);
  return match ? unescapeXml(match[1]!) : undefined;
}

export type JunitCase = { file: string; test: string; skipped: boolean };
export type TimedCase = JunitCase & { seconds: number };

/** The test cases of a report written by `bun test --reporter=junit`. */
export function readJunit(xml: string): TimedCase[] {
  const cases: TimedCase[] = [];
  for (const match of xml.matchAll(
    /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g,
  )) {
    const attributes = match[1]!;
    const file = attribute(attributes, "file");
    const test = attribute(attributes, "name");
    if (file === undefined || test === undefined) {
      throw new Error(`a junit testcase has no file or name: ${match[0]}`);
    }
    cases.push({
      file,
      seconds: Number(attribute(attributes, "time") ?? 0),
      skipped: /<skipped\b/.test(match[2] ?? ""),
      test,
    });
  }
  return cases;
}

/**
 * bun's own limit for a test that sets none. The suite steps of ci.yml give
 * such a test a longer one, so past this it passes there and is cut on a
 * developer's machine.
 */
export const DEFAULT_TEST_SECONDS = 5;

/** The cases that ran longer than `seconds`, slowest first. */
export function slowCases(cases: TimedCase[], seconds: number): TimedCase[] {
  return cases
    .filter((c) => c.seconds > seconds)
    .sort((a, b) => b.seconds - a.seconds);
}

/** One line per slow case, as the notice shows it. */
function slowLines(slow: TimedCase[]): string[] {
  return slow.map((c) => `${c.seconds.toFixed(1)}s ${c.file} > ${c.test}`);
}

// What the runner unescapes in a workflow command: a test's name may hold any
// of these, and a raw line break would end the command there.
const commandData = (text: string) =>
  text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const commandProperty = (text: string) =>
  commandData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");

/** The workflow command that puts a job's slow cases on the run's page. */
export function slowNotice(name: string, slow: TimedCase[]): string {
  const title = `${name}: ${slow.length} tests over ${DEFAULT_TEST_SECONDS}s`;
  return `::notice title=${commandProperty(title)}::${slowLines(slow).map(commandData).join("%0A")}`;
}

/**
 * Problems with one job's run: a file it owns that did not run, a file it
 * does not own that did, a skip it did not declare, or a declared skip that
 * did not happen. An undeclared skip is how a test lands in a job without the
 * service it needs — its opt-in variable is unset there, so it skips instead
 * of failing.
 */
export function verifyRun(
  job: IntegrationJob,
  owned: string[],
  cases: JunitCase[],
): string[] {
  const problems: string[] = [];
  const ran = new Set(cases.map((c) => c.file));
  for (const file of owned) {
    if (!ran.has(file)) problems.push(`${file} did not run`);
  }
  for (const file of ran) {
    if (!owned.includes(file)) problems.push(`${file} ran but is not owned`);
  }
  const declared = new Set(job.skips.map((s) => `${s.file} > ${s.test}`));
  const skipped = new Set(
    cases.filter((c) => c.skipped).map((c) => `${c.file} > ${c.test}`),
  );
  for (const key of skipped) {
    if (!declared.has(key)) problems.push(`undeclared skip: ${key}`);
  }
  for (const key of declared) {
    if (!skipped.has(key)) problems.push(`declared skip did not skip: ${key}`);
  }
  return problems;
}

function main(argv: string[]): void {
  const [command, domain, shardArg, junitPath] = argv;
  if (
    !(
      (command === "matrix" && argv.length === 2) ||
      (command === "files" && argv.length === 3) ||
      (command === "verify" && argv.length === 4) ||
      (command === "select" && argv.length === 2)
    )
  ) {
    console.error(
      "usage: integration-jobs.ts matrix <domains> | files <domain> <shard> | verify <domain> <shard> <junit.xml> | select <paths>",
    );
    process.exit(2);
  }

  const cwd = join(import.meta.dir, "..", "..");
  const declaration = readFileSync(join(cwd, DECLARATION), "utf8");
  if (command === "matrix") {
    try {
      console.log(JSON.stringify(matrix(declaration, domain!)));
    } catch (error) {
      console.error((error as Error).message);
      process.exit(1);
    }
    return;
  }
  if (command === "select") {
    try {
      const paths = readFileSync(domain!, "utf8").split("\0").filter(Boolean);
      const { domains, reasons } = selectDomains(cwd, declaration, paths);
      for (const reason of reasons)
        console.error(`integration domains: ${reason}`);
      console.log(JSON.stringify(domains));
    } catch (error) {
      console.error((error as Error).message);
      process.exit(1);
    }
    return;
  }
  const jobs = readJobs(declaration);
  const files = suiteFiles(cwd);
  let assigned: Map<string, string[]>;
  try {
    assigned = assign(files, jobs);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
  const job = jobs.find((candidate) => candidate.domain === domain);
  if (!job) {
    console.error(`no integration job named ${domain}`);
    process.exit(2);
  }
  const shard = /^[1-9]\d*$/.test(shardArg!) ? Number(shardArg) : Number.NaN;
  let owned: string[];
  try {
    owned = shardFiles(assigned.get(job.domain)!, job.shards, shard);
  } catch (error) {
    console.error(`${domain}: ${(error as Error).message}`);
    process.exit(2);
  }
  const name =
    job.shards === 1 ? job.domain : `${job.domain} ${shard}/${job.shards}`;
  const scoped = forShard(job, owned);

  if (command === "files") {
    console.error(`${name}: ${owned.length} of ${files.length} files`);
    for (const path of owned) console.log(`./${path}`);
    return;
  }

  const cases = readJunit(readFileSync(junitPath!, "utf8"));
  const problems = verifyRun(scoped, owned, cases);
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.error(
    `${name}: ${owned.length} files ran, ${cases.length} tests, ${scoped.skips.length} declared skips`,
  );
  // Named by every job that passes, so that the longer limit hides no slow
  // test. One escaped workflow command and no plain copy beside it: a test's
  // name may hold a line break, which would let a log line start a command.
  const slow = slowCases(cases, DEFAULT_TEST_SECONDS);
  if (slow.length > 0) console.log(slowNotice(name, slow));
}

if (import.meta.main) main(process.argv.slice(2));
