// The repository host behind a catalog repository, as the API talks to it:
// the credential the egress proxy logs in with, and the host's own API.
// Repositories authenticate through a GitHub App installation.

export type ForgeKind = "github";

/** A repository on its forge: the `<owner>/<name>` of the catalog URL. */
export type RepoRef = { owner: string; name: string };

/** A Basic login for git over HTTP, scoped to one repository and access. */
export type GitCredential = {
  username: string;
  password: string;
  /** Expiration reported by the GitHub App installation. */
  expiresAt?: Date;
};

export type ForgeRepository = {
  id: number;
  defaultBranch: string;
  private: boolean;
};

/** A pull request as the forge reports it; `head` and `base` are branch names. */
export type ForgePullRequest = {
  number: number;
  url: string;
  state: "open" | "closed";
  head: string;
  /** The commit the head branch points at when the forge answered. */
  headSha: string;
  base: string;
  /** GitHub's own times, as it reports them; null while open or unmerged. */
  mergedAt: string | null;
  closedAt: string | null;
};

/**
 * A list entry with what the drain compares: the body (it may hold the
 * platform's marker, which anyone can write) and the repository the head
 * branch lives in (`owner/name`, lower case; null when the fork was deleted).
 */
export type ForgePullRequestWithBody = ForgePullRequest & {
  body: string;
  headRepository: string | null;
};

/** One pull request read by number, with the figures its list entry lacks. */
export type ForgePullRequestDetail = ForgePullRequest & {
  title: string;
  mergeCommitSha: string | null;
  /** GitHub's `mergeable_state`; absent or null reads as not mergeable. */
  mergeableState?: string | null;
  /** GitHub's `mergeable`; null while it has not computed the answer. */
  mergeable?: boolean | null;
  draft?: boolean | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  commits: number | null;
};

export type ForgeComment = {
  id: number;
  url: string;
  /** False when a comment carrying the marker was edited instead. */
  created: boolean;
};

/**
 * A forge call that failed. The message names what failed and the status,
 * never a token, JWT, key or the forge's response body.
 */
export class ForgeCredentialError extends Error {
  override readonly name = "ForgeCredentialError";

  /** The gate's failed receipt, when the gate left one. */
  constructor(
    message: string,
    readonly receiptId: string | null = null,
  ) {
    super(message);
  }
}

/** GitHub names are case-insensitive, so a map over repositories keys on this. */
export const repoKeyOf = (repo: RepoRef): string =>
  `${repo.owner}/${repo.name}`.toLowerCase();

/**
 * `https://github.com/<owner>/<name>(.git)` → `{ owner, name }`; the same path
 * on a GHES host. Null for any other path shape.
 */
export function repoRefOf(url: string): RepoRef | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const match = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(
    path,
  );
  if (!match?.[1] || !match[2] || match[2] === "." || match[2] === "..") {
    return null;
  }
  return { owner: match[1], name: match[2] };
}
