import {
  type BundleLimits,
  DEFAULT_BUNDLE_LIMITS,
  isDocument,
  readSkillFile,
  skillPathIssues,
} from "./bundle-validator.ts";
import type { SkillSyncIssue } from "./ports/skill-git-source-store.ts";
import type { SkillListingEntry } from "./ports/skill-repository-store.ts";
import type { GitHubRepositoryTree } from "./skill-git-sync.ts";

// The listing check of a skill repository: every directory holding a SKILL.md
// is one entry. It reads the tree once and, of the contents, only the
// SKILL.md files. What paths, modes and sizes can refuse is judged on the
// tree, before anything is fetched; the full check runs when a skill is
// switched on.

export const SKILL_REPOSITORY_LIMITS = {
  /** Skill directories in one repository. */
  maxSkills: 200,
  /** One SKILL.md a listing reads. */
  maxSkillFileBytes: 64 * 1024,
  /** Every SKILL.md of one listing together. */
  maxListingBytes: 4 * 1024 * 1024,
} as const;

const MAX_ISSUES = 20;
const SYMLINK = "120000";
const EXECUTABLE = "100755";

export type SkillListing =
  | { kind: "listed"; entries: SkillListingEntry[] }
  /** The repository as a whole is past what a listing reads. */
  | { kind: "refused"; issues: SkillSyncIssue[] };

/**
 * File names at the root of the tree, the gate's `repositoryRootFiles`: it
 * looks there for a notice file the skill itself does not carry.
 */
export function repositoryRootFiles(
  tree: Pick<GitHubRepositoryTree, "entries">,
): string[] {
  return tree.entries
    .filter((entry) => entry.type === "blob" && !entry.path.includes("/"))
    .map((entry) => entry.path)
    .sort();
}

const refused = (code: string, message: string): SkillListing => ({
  kind: "refused",
  issues: [{ path: "", code, message }],
});

export async function listSkillRepository(
  tree: GitHubRepositoryTree,
  readBlobs: (shas: string[]) => Promise<Map<string, Uint8Array>>,
  limits: BundleLimits = DEFAULT_BUNDLE_LIMITS,
): Promise<SkillListing> {
  if (tree.truncated) {
    return refused(
      "tree_truncated",
      "GitHub cut the repository's tree short; a listing needs all of it",
    );
  }
  const skillFiles = tree.entries.filter(
    (entry) =>
      entry.type === "blob" &&
      (entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md")),
  );
  if (skillFiles.length > SKILL_REPOSITORY_LIMITS.maxSkills) {
    return refused(
      "too_many_skills",
      `A repository lists at most ${SKILL_REPOSITORY_LIMITS.maxSkills} skill directories`,
    );
  }
  const trees = new Map(
    tree.entries
      .filter((entry) => entry.type === "tree")
      .map((entry) => [entry.path, entry.sha]),
  );
  const files = tree.entries.filter((entry) => entry.type !== "tree");

  const candidates = skillFiles.map((file) => {
    const path = file.path.slice(0, -"SKILL.md".length).replace(/\/$/, "");
    const prefix = path === "" ? "" : `${path}/`;
    const inside = files
      .filter((entry) => entry.path.startsWith(prefix))
      .map((entry) => ({ ...entry, rest: entry.path.slice(prefix.length) }));
    const issues: SkillSyncIssue[] = [];
    let totalBytes = 0;
    for (const entry of inside) {
      totalBytes += entry.size;
      if (entry.mode === SYMLINK) {
        issues.push({
          path: entry.rest,
          code: "unsupported_entry_kind",
          message: "A symlink entry is not allowed.",
        });
      } else if (entry.type === "commit") {
        issues.push({
          path: entry.rest,
          code: "unsupported_entry_kind",
          message: "A submodule is not a file",
        });
      } else if (entry.size > limits.maxFileBytes) {
        issues.push({
          path: entry.rest,
          code: "file_too_large",
          message: `A file is at most ${limits.maxFileBytes} bytes`,
        });
      }
    }
    // The stored tree adds a manifest of its own.
    if (inside.length > limits.maxFiles - 1) {
      issues.push({
        path: "",
        code: "too_many_files",
        message: `A skill holds at most ${limits.maxFiles - 1} files`,
      });
    }
    if (totalBytes > limits.maxTotalBytes) {
      issues.push({
        path: "",
        code: "bundle_too_large",
        message: `A skill is at most ${limits.maxTotalBytes} bytes`,
      });
    }
    issues.push(...skillPathIssues(inside.map((entry) => entry.rest)));
    // A symlink is never followed and a large SKILL.md never fetched.
    const readable =
      file.mode !== SYMLINK &&
      file.size <= SKILL_REPOSITORY_LIMITS.maxSkillFileBytes;
    if (file.mode !== SYMLINK && !readable) {
      issues.push({
        path: "SKILL.md",
        code: "file_too_large",
        message: `A listing reads a SKILL.md of at most ${SKILL_REPOSITORY_LIMITS.maxSkillFileBytes} bytes`,
      });
    }
    return {
      file,
      readable,
      issues,
      entry: {
        path,
        treeSha: path === "" ? tree.sha : (trees.get(path) ?? ""),
        fileCount: inside.length,
        totalBytes,
        hasScripts: inside.some(
          (entry) => entry.mode === EXECUTABLE || !isDocument(entry.rest),
        ),
      },
    };
  });

  const wanted = candidates.filter((candidate) => candidate.readable);
  const listingBytes = wanted.reduce((sum, { file }) => sum + file.size, 0);
  if (listingBytes > SKILL_REPOSITORY_LIMITS.maxListingBytes) {
    return refused(
      "listing_too_large",
      `The SKILL.md files of one repository are at most ${SKILL_REPOSITORY_LIMITS.maxListingBytes} bytes together`,
    );
  }
  const blobs =
    wanted.length === 0
      ? new Map<string, Uint8Array>()
      : await readBlobs([...new Set(wanted.map(({ file }) => file.sha))]);

  const entries = candidates.map(({ file, readable, issues, entry }) => {
    let read: ReturnType<typeof readSkillFile> | null = null;
    if (readable) {
      const bytes = blobs.get(file.sha);
      if (
        bytes === undefined ||
        bytes.byteLength > SKILL_REPOSITORY_LIMITS.maxSkillFileBytes
      ) {
        issues.push({
          path: "SKILL.md",
          code: "missing_skill_file",
          message: "SKILL.md could not be read.",
        });
      } else {
        read = readSkillFile(bytes);
        issues.unshift(...read.issues);
      }
    }
    return {
      ...entry,
      name: read?.name ?? null,
      description: read?.description ?? null,
      license: read?.license ?? null,
      issues: issues.slice(0, MAX_ISSUES),
    };
  });
  return {
    kind: "listed",
    entries: entries.sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ),
  };
}
