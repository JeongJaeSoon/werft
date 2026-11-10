import type { RepositoryReadable } from "../action/ports/capabilities.ts";
import type { GitTreeEntry } from "../action/ports/github-api.ts";
import { GitHubCallError } from "../ports/github-gate.ts";

export type FakeFile =
  | string
  | Uint8Array
  | {
      mode: string;
      type?: GitTreeEntry["type"];
      content?: string | Uint8Array;
    };

type Snapshot = Map<string, GitTreeEntry[]>;

/**
 * The tree and blob reads of a repository's default branch, in memory. A tree
 * read after the branch moved still answers what it was when the branch head
 * was read, as GitHub's content-addressed objects do.
 */
export function fakeRepositoryReads(
  initial: Record<string, FakeFile>,
  options: {
    defaultBranch?: string;
    /** Directories ("" is the root) whose listing GitHub cuts short. */
    truncated?: readonly string[];
    /** Reads that fail with this status. */
    failing?: {
      repository?: number;
      branch?: number;
      tree?: number;
      blob?: number;
    };
  } = {},
) {
  const defaultBranch = options.defaultBranch ?? "main";
  const calls: string[] = [];
  const snapshots = new Map<
    string,
    { trees: Snapshot; blobs: Map<string, Uint8Array> }
  >();
  let commits = 0;
  let current = initial;

  function snapshot(files: Record<string, FakeFile>, commit: string) {
    const trees: Snapshot = new Map();
    const blobs = new Map<string, Uint8Array>();
    const directory = (path: string): GitTreeEntry[] => {
      const key = `${commit}:tree:${path}`;
      const known = trees.get(key);
      if (known !== undefined) return known;
      const entries: GitTreeEntry[] = [];
      trees.set(key, entries);
      const prefix = path === "" ? "" : `${path}/`;
      const seen = new Set<string>();
      for (const [full, file] of Object.entries(files)) {
        if (!full.startsWith(prefix)) continue;
        const rest = full.slice(prefix.length);
        const [head, ...tail] = rest.split("/");
        if (head === undefined || seen.has(head)) continue;
        if (tail.length > 0) {
          seen.add(head);
          entries.push({
            name: head,
            mode: "040000",
            type: "tree",
            sha: `${commit}:tree:${prefix}${head}`,
            size: null,
          });
          directory(`${prefix}${head}`);
          continue;
        }
        seen.add(head);
        const spec =
          typeof file === "string" || file instanceof Uint8Array
            ? { mode: "100644", type: "blob" as const, content: file }
            : { type: "blob" as const, ...file };
        const bytes =
          typeof spec.content === "string"
            ? new TextEncoder().encode(spec.content)
            : (spec.content ?? new Uint8Array());
        const sha = `${commit}:blob:${full}`;
        blobs.set(sha, bytes);
        entries.push({
          name: head,
          mode: spec.mode,
          type: spec.type,
          sha,
          size: spec.type === "blob" ? bytes.length : null,
        });
      }
      return entries;
    };
    directory("");
    return { trees, blobs };
  }

  function commit() {
    commits += 1;
    const id = `c${commits}`;
    snapshots.set(id, snapshot(current, id));
    return id;
  }

  const failure = (what: string, status: number | undefined) => {
    if (status !== undefined) throw new GitHubCallError(what, status, null);
  };

  const reads: RepositoryReadable = {
    async getRepository() {
      calls.push("repository");
      failure("repository lookup", options.failing?.repository);
      return { id: 1, defaultBranch, private: false };
    },
    async getBranchHead(branch) {
      calls.push(`branch ${branch}`);
      failure("branch read", options.failing?.branch);
      if (branch !== defaultBranch) {
        throw new GitHubCallError("branch read", 404, null);
      }
      const id = commit();
      return { commitSha: id, treeSha: `${id}:tree:` };
    },
    async readTree(treeSha) {
      calls.push(`tree ${treeSha}`);
      failure("tree read", options.failing?.tree);
      const [id, , ...path] = treeSha.split(":");
      const found = snapshots.get(id ?? "")?.trees.get(treeSha);
      if (found === undefined)
        throw new GitHubCallError("tree read", 404, null);
      const directoryPath = path.join(":");
      return {
        entries: found,
        truncated: options.truncated?.includes(directoryPath) ?? false,
      };
    },
    async readBlob(blobSha) {
      calls.push(`blob ${blobSha}`);
      failure("blob read", options.failing?.blob);
      const [id] = blobSha.split(":");
      const found = snapshots.get(id ?? "")?.blobs.get(blobSha);
      if (found === undefined)
        throw new GitHubCallError("blob read", 404, null);
      return found;
    },
  };

  return {
    reads,
    calls,
    move(files: Record<string, FakeFile>) {
      current = files;
    },
  };
}
