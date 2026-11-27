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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { suiteFiles } from "./test-files.ts";

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

/** The test cases of a report written by `bun test --reporter=junit`. */
export function readJunit(xml: string): JunitCase[] {
  const cases: JunitCase[] = [];
  for (const match of xml.matchAll(
    /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g,
  )) {
    const attributes = match[1]!;
    const file = attribute(attributes, "file");
    const test = attribute(attributes, "name");
    if (file === undefined || test === undefined) {
      throw new Error(`a junit testcase has no file or name: ${match[0]}`);
    }
    cases.push({ file, skipped: /<skipped\b/.test(match[2] ?? ""), test });
  }
  return cases;
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
      (command === "verify" && argv.length === 4)
    )
  ) {
    console.error(
      "usage: integration-jobs.ts matrix <domains> | files <domain> <shard> | verify <domain> <shard> <junit.xml>",
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
  const name = job.shards === 1 ? domain : `${domain} ${shard}/${job.shards}`;
  // A declared skip belongs to the shard that runs its file.
  const scoped = {
    ...job,
    skips: job.skips.filter((skip) => owned.includes(skip.file)),
  };

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
}

if (import.meta.main) main(process.argv.slice(2));
