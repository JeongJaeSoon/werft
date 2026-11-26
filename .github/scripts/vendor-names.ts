#!/usr/bin/env bun
/**
 * Fails when AffectUI's names appear outside the folder its MIT files are
 * copied into. Our own components are written from our own specs, so one of
 * these names anywhere else means markup, styles or an asset were carried over.
 *
 *   bun .github/scripts/vendor-names.ts [repo-dir]
 *
 * Names come from PATTERNS below and from .github/vendor-identifiers.txt.
 * .md files are not scanned: documents have to be able to cite the source.
 * .mdx is, because it renders.
 */
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// `affect-` needs the hyphen and no letter before it, so "affected" and
// "unaffected" pass.
export const PATTERNS: readonly RegExp[] = [/affectui/i, /(?<![a-z])affect-/i];

const VENDOR = "apps/web/src/vendor/affectui/free/";
export const IDENTIFIERS = ".github/vendor-identifiers.txt";

/** The one line a file rewritten from a free AffectUI piece carries. */
export const NOTICE = `Adapted from AffectUI (MIT): ${VENDOR}LICENSE`;

// A path into the vendor folder is how its files are imported.
const REFERENCE = /vendor\/affectui(?![\w-])[^\s"'`)]*/g;

// The files that have to spell the names out.
const EXEMPT = new Set([
  IDENTIFIERS,
  ".github/scripts/vendor-names.ts",
  "scripts/third-party-notices.ts",
  "tests/ci-static-checks.vendor-names.test.ts",
]);

export function identifiers(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

function trackedFiles(root: string): string[] {
  const git = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (git.status !== 0) throw new Error(`git ls-files failed: ${git.stderr}`);
  return git.stdout.split("\0").filter(Boolean);
}

/** One `path[:line]: name` per hit. */
export function findNames(root: string): string[] {
  const list = join(root, IDENTIFIERS);
  const own = identifiers(readFileSync(list, "utf8")).map((name) =>
    name.toLowerCase(),
  );
  const hit = (text: string): string | undefined => {
    const rest = text.replaceAll(NOTICE, "").replace(REFERENCE, "");
    const lower = rest.toLowerCase();
    return (
      PATTERNS.map((pattern) => rest.match(pattern)?.[0]).find(Boolean) ??
      own.find((name) => lower.includes(name))
    );
  };

  const found: string[] = [];
  for (const path of trackedFiles(root)) {
    if (path.startsWith(VENDOR) || EXEMPT.has(path) || path.endsWith(".md")) {
      continue;
    }
    const file = join(root, path);
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat) continue; // deleted but not yet staged
    // The path as it is: a file named after a piece is a carried-over asset.
    const named =
      PATTERNS.map((pattern) => path.match(pattern)?.[0]).find(Boolean) ??
      own.find((name) => path.toLowerCase().includes(name));
    if (named) found.push(`${path}: ${named}`);
    // A symlink is only a name here: a target in the repository is listed itself.
    if (!stat.isFile()) continue;
    const text = readFileSync(file, "utf8");
    if (text.includes("\0")) continue;
    for (const [index, line] of text.split("\n").entries()) {
      const name = hit(line);
      if (name) found.push(`${path}:${index + 1}: ${name}`);
    }
  }
  return found;
}

if (import.meta.main) {
  const found = findNames(resolve(process.argv[2] ?? "."));
  if (found.length > 0) {
    console.error(found.join("\n"));
    console.error(
      `${found.length} AffectUI name(s) outside ${VENDOR}. Keep copied files in that folder; write our own components under our own names (see its README.md).`,
    );
    process.exit(1);
  }
}
