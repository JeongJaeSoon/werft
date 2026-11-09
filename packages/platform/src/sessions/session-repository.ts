import type {
  SessionAttachedRepository,
  SessionRepository,
} from "@werft-ai/contracts";

const NAME_SEGMENT = /^[A-Za-z0-9._~-]+$/;

/**
 * An http(s) URL's path without host, userinfo, query or a trailing `.git`
 * (`owner/repo`, or `group/sub/repo` on a forge with groups), or null when a
 * segment is not a plain name.
 */
export function pathNameOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const path = parsed.pathname;
  const segments = path
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/")
    .slice(1);
  const plain =
    segments.length >= 2 &&
    segments.every(
      (segment) =>
        NAME_SEGMENT.test(segment) && segment !== "." && segment !== "..",
    );
  return plain ? segments.join("/") : null;
}

/**
 * The attached ids with a name each, in id order, from the catalog as it is
 * now. Absent for a list the session does not hold (`null`): its release's
 * repositories may be reachable, which no list says. An id the catalog no
 * longer has keeps its place with no name.
 */
export function attachedRepositoriesOf(
  ids: readonly string[] | null | undefined,
  repositories: Readonly<Record<string, { url: string }>>,
): SessionAttachedRepository[] | undefined {
  if (ids === null || ids === undefined) return undefined;
  return [...new Set(ids)]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((id) => {
      const listed = Object.hasOwn(repositories, id)
        ? repositories[id]
        : undefined;
      return {
        id,
        full_name: listed ? (pathNameOf(listed.url) ?? id) : null,
      };
    });
}

/**
 * The repository a session shows, from the session row alone, so a later
 * catalog change or removal never alters it. A row from before the catalog
 * refused credentials may hold one in its URL; only the path is read.
 */
export function sessionRepositoryOf(row: {
  repositoryMode: "repository" | "none";
  repositoryId: string | null;
  repoUrl: string | null;
  branch: string | null;
}): SessionRepository | null {
  if (row.repositoryMode === "none" || row.branch === null) return null;
  return {
    id: row.repositoryId,
    full_name:
      (row.repoUrl === null ? null : pathNameOf(row.repoUrl)) ??
      row.repositoryId,
    branch: row.branch,
  };
}
