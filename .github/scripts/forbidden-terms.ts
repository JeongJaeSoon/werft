/**
 * Scan the tree, the commit messages of this run, and the title, body, comments and reviews
 * of a PR or issue for private lists of forbidden terms.
 *
 * FORBIDDEN_TERMS=<one ERE per line> [FORBIDDEN_HOST_TERMS=<one ERE per line>]
 *   [PR_NUMBER=n | ISSUE_NUMBER=n] [TEXT_ONLY=true] [BASE_SHA=s BASE_REF=b HEAD_SHA=s]
 *   bun .github/scripts/forbidden-terms.ts
 *
 * The lists stay out of the repository and this repository's Actions logs are public, so the
 * output is fixed text and counts only: no term, no path, line or sha (any of them would point
 * at the public sentence that holds a term). Find the place with a local grep. Child stderr is
 * dropped because a bad pattern's error quotes the pattern. Texts come from the API because a
 * re-run reuses the old event payload.
 *
 * Only texts by OWNER, MEMBER or COLLABORATOR are scanned. Anyone can comment here, and a
 * pass or fail on a stranger's text would let them test guesses against the private lists.
 *
 * A missing FORBIDDEN_TERMS fails the job: a scan that cannot run is not a scan that found
 * nothing. FORBIDDEN_HOST_TERMS is optional; without it the log says those terms were skipped.
 * TEXT_ONLY (comment and issue events) skips the tree and commit messages.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

class Failed extends Error {}

const HIT = 0;
const MISS = 1;

const env = process.env;

function child(
  cmd: [string, ...string[]],
  input?: string,
): { status: number | null; stdout: string } {
  // The lists never reach a child: patterns go through a file, and the variables are dropped.
  const {
    FORBIDDEN_TERMS: _dropped,
    FORBIDDEN_HOST_TERMS: _droppedHost,
    ...rest
  } = env;
  const [file, ...args] = cmd;
  const p = spawnSync(file, args, {
    input,
    env: rest,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "ignore"],
  });
  return { status: p.status, stdout: p.stdout ?? "" };
}

function countText(text: string, terms: string): number {
  const p = child(["grep", "-c", "-i", "-E", "-f", terms], text);
  if (p.status !== HIT && p.status !== MISS) {
    throw new Failed(
      "a pattern in FORBIDDEN_TERMS is invalid; check the list locally",
    );
  }
  return Number.parseInt(p.stdout.trim() || "0", 10);
}

function countTree(terms: string): number {
  const p = child(["git", "grep", "-l", "-I", "-i", "-E", "-f", terms]);
  if (p.status !== HIT && p.status !== MISS) {
    throw new Failed(
      "git grep failed; check the patterns in FORBIDDEN_TERMS locally",
    );
  }
  return p.stdout.split("\n").filter(Boolean).length;
}

const ZERO_SHA = /^0+$/;

// Only the commits this run adds: a PR's own commits, or the commits of a push. Older history
// is not rewritten, so it is not scanned. A push that has no usable "before" scans its head only.
function commitMessages(): string {
  const base = env.BASE_SHA ?? "";
  const head = env.HEAD_SHA || "HEAD";
  const args: [string, ...string[]] = ["git", "log", "--format=%B"];
  if (!base || ZERO_SHA.test(base)) {
    args.push("-1", head);
  } else {
    args.push(head, "--not", base);
    // A PR branch that merged newer main commits must not be charged for them.
    if (
      env.BASE_REF &&
      child([
        "git",
        "rev-parse",
        "--verify",
        "--quiet",
        `origin/${env.BASE_REF}`,
      ]).status === 0
    ) {
      args.push(`origin/${env.BASE_REF}`);
    }
  }
  const p = child(args);
  if (p.status !== 0) throw new Failed("could not read the commit range");
  return p.stdout;
}

const TRUSTED =
  'select(.author_association == "OWNER" or .author_association == "MEMBER" or .author_association == "COLLABORATOR")';

function api(path: string, jq: string, failure: string): string {
  const p = child(["gh", "api", "--paginate", path, "--jq", jq]);
  if (p.status !== 0) throw new Failed(failure);
  return p.stdout;
}

// The title and body, then every comment and review, of one PR or issue.
function threadText(
  kind: "PR" | "issue",
  number: string,
): Record<string, string> {
  const repo = `repos/${env.GITHUB_REPOSITORY ?? ""}`;
  const body = `${TRUSTED} | .title + "\\n" + (.body // "")`;
  const each = `.[] | ${TRUSTED} | .body // ""`;
  const title = api(
    `${repo}/${kind === "PR" ? "pulls" : "issues"}/${number}`,
    body,
    `could not read the ${kind} title and body`,
  );
  const fail = `could not read the ${kind} comments and reviews`;
  const comments = [api(`${repo}/issues/${number}/comments`, each, fail)];
  if (kind === "PR")
    comments.push(
      api(`${repo}/pulls/${number}/comments`, each, fail),
      api(`${repo}/pulls/${number}/reviews`, each, fail),
    );
  return {
    [`${kind} title and body`]: title,
    [`${kind} comments and reviews`]: comments.join("\n"),
  };
}

function lines(value: string | undefined): string[] {
  return (value ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function main(): number {
  const patterns = lines(env.FORBIDDEN_TERMS);
  if (patterns.length === 0) {
    const fork = env.FORK_PR === "true";
    throw new Failed(
      fork
        ? "FORBIDDEN_TERMS is not available to a pull request from a fork; a maintainer pushes the branch to this repository to scan it"
        : "FORBIDDEN_TERMS is empty or not set; the forbidden-term scan cannot run",
    );
  }
  const hostPatterns = lines(env.FORBIDDEN_HOST_TERMS);
  if (hostPatterns.length === 0)
    console.log("FORBIDDEN_HOST_TERMS is not set; host terms were not scanned");
  const dir = mkdtempSync(
    join(env.RUNNER_TEMP || tmpdir(), "forbidden-terms-"),
  ); // mode 700
  try {
    const terms = join(dir, "terms.tmp");
    writeFileSync(terms, `${[...patterns, ...hostPatterns].join("\n")}\n`, {
      mode: 0o600,
    });
    const hits: Record<string, number> = {};
    if (env.TEXT_ONLY !== "true") {
      hits.tree = countTree(terms);
      hits["commit messages"] = countText(commitMessages(), terms);
    }
    const texts = env.PR_NUMBER
      ? threadText("PR", env.PR_NUMBER)
      : env.ISSUE_NUMBER
        ? threadText("issue", env.ISSUE_NUMBER)
        : {};
    for (const [where, text] of Object.entries(texts))
      hits[where] = countText(text, terms);
    for (const [where, n] of Object.entries(hits))
      console.log(`${where}: ${n}`);
    if (Object.values(hits).some((n) => n > 0)) {
      console.log(
        "::error::forbidden terms found; find them with a local grep of the private list",
      );
      return 1;
    }
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  process.exit(main());
} catch (e) {
  // Only fixed text: an unexpected error's message or stack could quote input.
  console.log(
    `::error::${e instanceof Failed ? e.message : "the forbidden-term scan failed unexpectedly"}`,
  );
  process.exit(1);
}
