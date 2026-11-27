// Collects the changelog fragments (changelog.d/*.md) and CHANGELOG.md's
// `## 미출시` section into one `## vX.Y.Z` section, then deletes the fragments.
// A release pull request runs it: `bun .github/scripts/changelog-release.ts vX.Y.Z`
// from the repository root. Every input is checked before anything is written.
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The sections CHANGELOG.md's "쓰는 방식" allows, in the order a version lists them.
export const SECTIONS = ["보안", "운영자가 할 일"] as const;
type Sections = Map<string, string[]>;

export const FRAGMENT_DIR = "changelog.d";
const README = "README.md";
const UNRELEASED = "## 미출시";

// release-auto.sh's version_pattern: semver without build metadata.
const n = "(0|[1-9][0-9]*)";
const pre = `(${n}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const VERSION = new RegExp(`^v${n}\\.${n}\\.${n}(-${pre}(\\.${pre})*)?$`);

/** The `### <section>` bodies of a fragment or of the unreleased section. */
export function parseSections(
  text: string,
  where: string,
  allowEmpty = false,
  fragment = !allowEmpty,
): Sections {
  if (text.includes("\r"))
    throw new Error(`${where}: CRLF line ending; use LF`);
  const sections: Sections = new Map();
  let current: string[] | null = null;
  let fence: { indent: number; char: string; length: number } | null = null;
  text.split("\n").forEach((line, i) => {
    // A fence closes only at its own indent: a deeper marker is code text.
    const marker = /^( *)(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker?.[1] !== undefined && marker[2] !== undefined) {
      const indent = marker[1].length;
      const run = marker[2];
      if (fence === null) {
        fence = { indent, char: run.charAt(0), length: run.length };
      } else if (
        indent === fence.indent &&
        run.charAt(0) === fence.char &&
        run.length >= fence.length &&
        marker[3]?.trim() === ""
      ) {
        fence = null;
      }
    }
    // A fragment moves from changelog.d/ to the root: a relative link would
    // point elsewhere there.
    if (fragment) {
      for (const link of line.matchAll(
        /\]\(\s*<?([^)\s>]*)|^\s*\[[^\]]+\]:\s*<?([^\s>]*)/g,
      )) {
        const target = link[1] ?? link[2] ?? "";
        if (!/^(https?:|mailto:|#)/.test(target)) {
          throw new Error(
            `${where}:${i + 1}: link "${target}" is relative; use an absolute URL`,
          );
        }
      }
    }
    // A `#` line is refused inside a fence: release-auto.sh and
    // migration-safety.ts read `## vX.Y.Z` lines without seeing fences, and a
    // section heading there would split the fence.
    if (line.startsWith("#") && fence !== null) {
      throw new Error(`${where}:${i + 1}: "${line}" inside a code fence`);
    }
    if (line.startsWith("#")) {
      const name = /^### (.+)$/.exec(line)?.[1];
      if (
        name === undefined ||
        !(SECTIONS as readonly string[]).includes(name)
      ) {
        throw new Error(
          `${where}:${i + 1}: "${line}" is not one of ${SECTIONS.map((s) => `"### ${s}"`).join(", ")}`,
        );
      }
      if (sections.has(name))
        throw new Error(`${where}:${i + 1}: "### ${name}" appears twice`);
      current = [];
      sections.set(name, current);
    } else if (current === null) {
      if (line.trim() !== "")
        throw new Error(
          `${where}:${i + 1}: text before the first section heading`,
        );
    } else {
      current.push(line);
    }
  });
  for (const [name, lines] of sections) {
    while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();
    while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
    if (lines.length === 0)
      throw new Error(`${where}: "### ${name}" has no entries`);
  }
  if (fence) throw new Error(`${where}: a code fence is not closed`);
  if (sections.size === 0 && !allowEmpty)
    throw new Error(`${where}: no section`);
  return sections;
}

/** The fragment files, newest name first (ticket numbers compare as numbers). */
export function fragmentNames(root: string): string[] {
  let names: string[];
  try {
    names = readdirSync(join(root, FRAGMENT_DIR));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names
    .filter((name) => name !== README)
    .map((name) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(name)) {
        throw new Error(
          `${FRAGMENT_DIR}/${name}: a fragment is a .md file named after its ticket or PR`,
        );
      }
      return name;
    })
    .sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
}

/**
 * CHANGELOG.md with the fragments and the unreleased section made into
 * `## <version>`, or null when there is nothing to collect.
 */
export function collect(
  changelog: string,
  fragments: { name: string; text: string }[],
  version: string,
): string | null {
  // The same refusals as release-auto.sh check_version, before anything is written.
  if (!VERSION.test(version))
    throw new Error(
      `'${version}' is not v<major>.<minor>.<patch>[-<prerelease>]`,
    );
  if (
    /[0-9]{19}/.test(version) ||
    !/[0-9A-Za-z]$/.test(version) ||
    version.length > 58
  )
    throw new Error(
      `'${version}' cannot be a chart version (release-auto.sh check_version)`,
    );
  if (changelog.includes("\r"))
    throw new Error("CHANGELOG.md: CRLF line ending; use LF");
  const lines = changelog.split("\n");
  if (lines.includes(`## ${version}`))
    throw new Error(`CHANGELOG.md already has a section for ${version}`);
  const starts = lines.flatMap((line, i) => (line === UNRELEASED ? [i] : []));
  if (starts.length > 1)
    throw new Error(`CHANGELOG.md has more than one "${UNRELEASED}" section`);
  const start = starts[0];
  let end = lines.length;
  let unreleased: Sections = new Map();
  if (start !== undefined) {
    const next = lines.findIndex(
      (line, i) => i > start && line.startsWith("## "),
    );
    if (next !== -1) end = next;
    unreleased = parseSections(
      lines.slice(start + 1, end).join("\n"),
      `CHANGELOG.md "${UNRELEASED}"`,
      true,
    );
  }
  const parsed = fragments.map(({ name, text }) =>
    parseSections(text, `${FRAGMENT_DIR}/${name}`),
  );
  if (parsed.length === 0 && unreleased.size === 0) return null;

  // Fragments are newer than anything left in the unreleased section.
  const block = [`## ${version}`, ""];
  for (const section of SECTIONS) {
    const entries = [...parsed, unreleased].flatMap(
      (s) => s.get(section) ?? [],
    );
    if (entries.length > 0) block.push(`### ${section}`, "", ...entries, "");
  }
  if (start !== undefined) {
    lines.splice(start, end - start, ...block);
  } else {
    let at = lines.findIndex((line) => /^## v\d/.test(line));
    if (at === -1) {
      at = lines.length;
      block.unshift("");
    }
    lines.splice(at, 0, ...block);
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const version = process.argv[2];
  if (version === undefined || process.argv.length > 3) {
    console.error("usage: bun .github/scripts/changelog-release.ts vX.Y.Z");
    process.exit(2);
  }
  const root = process.cwd();
  try {
    const names = fragmentNames(root);
    const fragments = names.map((name) => ({
      name,
      text: readFileSync(join(root, FRAGMENT_DIR, name), "utf8"),
    }));
    const path = join(root, "CHANGELOG.md");
    const next = collect(readFileSync(path, "utf8"), fragments, version);
    if (next === null) {
      console.log(
        `nothing to collect: no fragment in ${FRAGMENT_DIR}/ and no entry under "${UNRELEASED}"`,
      );
    } else {
      writeFileSync(path, next);
      for (const name of names) rmSync(join(root, FRAGMENT_DIR, name));
      console.log(
        `CHANGELOG.md: ${version} collects ${names.length} fragment(s) and "${UNRELEASED}"`,
      );
    }
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
