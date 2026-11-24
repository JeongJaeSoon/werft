import type { StructuredLogger } from "@werft-ai/observability";
import {
  type GitHubApi,
  GitHubCallError,
  type GitHubReleaseReadGate,
  type GitTreeEntry,
  type ReleaseInstructionsSource,
  type SessionCatalog,
} from "@werft-ai/platform";
import type { CommittedTree, RuntimeDescriptor } from "@werft-ai/runtime-core";

/**
 * A catalog repository's branch read through the GitHub gate, for the
 * instruction snapshot a new release takes. A repository not on GitHub, or
 * with no App that reaches it, is not read.
 */
export function wireReleaseInstructions(deps: {
  catalog: Pick<SessionCatalog, "repositories">;
  /** Read when a release is made: the gate is wired after the service. */
  gate: () => GitHubReleaseReadGate;
  descriptors: readonly RuntimeDescriptor[];
  logger: StructuredLogger;
}): ReleaseInstructionsSource {
  return {
    async open(repositoryId, runtime, release) {
      const entry = Object.hasOwn(deps.catalog.repositories, repositoryId)
        ? deps.catalog.repositories[repositoryId]
        : undefined;
      if (entry === undefined) {
        return { kind: "read_failed", reason: "not_on_github" };
      }
      const failed = (error: unknown) => {
        deps.logger.warn("release.instructions.read_failed", {
          repository_id: repositoryId,
          error: error instanceof Error ? error.message : String(error),
        });
        return error;
      };
      let api: GitHubApi;
      let head: { commitSha: string; treeSha: string };
      try {
        const granted = await deps
          .gate()
          .releaseRead({ ...release, repositoryId });
        if (granted === null) {
          return { kind: "read_failed", reason: "not_on_github" };
        }
        api = granted.api;
        head = await api.getBranchHead(entry.branch);
      } catch (error) {
        if (error instanceof GitHubCallError && error.status === 404) {
          return { kind: "read_failed", reason: "branch_missing" };
        }
        throw failed(error);
      }
      const levels = new Map<string, Promise<GitTreeEntry[]>>();
      const level = (sha: string) => {
        let entries = levels.get(sha);
        if (entries === undefined) {
          entries = api.readTree(sha).then((read) => {
            // A cut list may hide the file: not knowing is not "absent".
            if (read.truncated) throw new Error("GitHub cut the tree listing");
            return read.entries;
          });
          levels.set(sha, entries);
        }
        return entries;
      };
      const sizes = new Map<string, number | null>();
      const blobs = new Map<string, Promise<Uint8Array>>();
      const blob = async (object: string): Promise<Uint8Array> => {
        let bytes = blobs.get(object);
        if (bytes === undefined) {
          bytes = api.readBlob(object);
          blobs.set(object, bytes);
        }
        try {
          return await bytes;
        } catch (error) {
          throw failed(error);
        }
      };
      const tree: CommittedTree = {
        async entry(path) {
          try {
            let at = head.treeSha;
            const segments = path.split("/");
            for (const [index, name] of segments.entries()) {
              const found = (await level(at)).find((e) => e.name === name);
              if (found === undefined) return null;
              if (index === segments.length - 1) {
                sizes.set(found.sha, found.size);
                return {
                  mode: found.mode,
                  type: found.type,
                  object: found.sha,
                };
              }
              if (found.type !== "tree") return null;
              at = found.sha;
            }
            return null;
          } catch (error) {
            throw failed(error);
          }
        },
        async size(object) {
          const known = sizes.get(object);
          if (known !== undefined && known !== null) return known;
          return (await blob(object)).byteLength;
        },
        async read(object) {
          return new TextDecoder().decode(await blob(object));
        },
      };
      const files =
        deps.descriptors.find((descriptor) => descriptor.kind === runtime)
          ?.instructionFiles ?? [];
      return { kind: "tree", commit: head.commitSha, files, tree };
    },
  };
}
