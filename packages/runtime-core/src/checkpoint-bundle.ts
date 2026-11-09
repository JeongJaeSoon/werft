/** The refs a checkpoint bundle carries; the restorer reads them back. */
export const CHECKPOINT_HEAD_REF = "refs/checkpoint/head";
export const CHECKPOINT_WORKTREE_REF = "refs/checkpoint/worktree";
/**
 * Where a bundle built on an earlier one carries HEAD's branch when the
 * earlier one already has its commit: under `refs/heads/` git keeps
 * commits only, and the branch then needs a tag (`refs/checkpoint/branch/
 * heads/main` for `refs/heads/main`).
 */
export const CHECKPOINT_BRANCH_PREFIX = "refs/checkpoint/branch/";
/**
 * The commit the session's repository CLAUDE.md is read from: the
 * branch commit the first worker fetched, carried unchanged from checkpoint
 * to checkpoint so a resumed engine gets the instructions it started with.
 */
export const CHECKPOINT_INSTRUCTIONS_REF = "refs/checkpoint/instructions";
/**
 * Where a bundle carries the commit HEAD's branch tracks on origin, named
 * for origin's branch (`refs/checkpoint/upstream/heads/main` for
 * `origin/main`), so a restore sets the branch's upstream again.
 */
export const CHECKPOINT_UPSTREAM_PREFIX = "refs/checkpoint/upstream/";
/**
 * Where a bundle carries a local branch other than HEAD's so a push can name
 * it later (`refs/checkpoint/source/<branch>` for `refs/heads/<branch>`). A
 * restore does not check these out; they keep the commits reachable.
 */
export const CHECKPOINT_SOURCE_PREFIX = "refs/checkpoint/source/";
export const MAX_CHECKPOINT_SOURCES = 16;

/**
 * `git for-each-ref --format` for `peeledCommits`: each ref with what it
 * points at and, for a tag, what the tag points at.
 */
export const PEELED_REF_FORMAT =
  "%(refname) %(objecttype) %(objectname) %(*objecttype) %(*objectname)";

/**
 * Reads `PEELED_REF_FORMAT` output: every ref with the commit it is, or the
 * commit the annotated tag points at directly. A capture that changed nothing
 * may tag a commit its base carries. Returns null for anything else.
 */
export function peeledCommits(output: string): Map<string, string | null> {
  const commits = new Map<string, string | null>();
  for (const line of output.split("\n")) {
    if (line === "") continue;
    const [name, type, oid, peeledType, peeled] = line.split(" ");
    if (name === undefined) continue;
    commits.set(
      name,
      type === "commit"
        ? (oid ?? null)
        : type === "tag" && peeledType === "commit"
          ? (peeled ?? null)
          : null,
    );
  }
  return commits;
}

/**
 * The manifest's `workspace.sources` as a bundle proves them: its source
 * refs plus HEAD's branch, which the bundle carries under its own name.
 */
export function manifestSourcesOf(
  refs: Pick<CheckpointBundleRefs, "branch" | "head" | "sources">,
): Array<{ name: string; commit: string }> {
  const all = [...refs.sources];
  if (refs.branch !== null) {
    all.push({
      name: refs.branch.slice("refs/heads/".length),
      commit: refs.head,
    });
  }
  return all.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** What a restore checks out of a checkpoint bundle. */
export type CheckpointBundleRefs = {
  /** `refs/heads/<name>` HEAD was on, or null for a detached HEAD. */
  branch: string | null;
  head: string;
  instructions: string | null;
  /** Local branches kept for push requests, by short name, sorted. */
  sources: Array<{ name: string; commit: string }>;
  /** origin's `refs/heads/<name>` the branch tracks, at the commit it had. */
  upstream: { commit: string; merge: string } | null;
  worktree: string;
};

/**
 * The one rule for a checkpoint bundle's refs: finalize applies it
 * before the pointer moves, and a restore before it touches the workspace,
 * so a checkpoint that commits is one a restore checks out. `refs` are the
 * refs the chain's last bundle lists, each with the commit it peels to
 * (`peeledCommits`), null when it peels to none. A bundle is what
 * `captureWorkspace` writes or it is refused: no ref it does not write, at
 * most one branch and one upstream of it, HEAD's and the worktree's commits
 * present, the worktree's
 * the manifest's `gitCommit`, and the branch at HEAD's commit.
 * `scripts/lib/backup-lib.sh` `unbundle_chain` checks the worktree part.
 */
export function checkpointBundleRefs(
  refs: ReadonlyArray<readonly [name: string, commit: string | null]>,
  gitCommit: string,
):
  | { status: "valid"; refs: CheckpointBundleRefs }
  | { status: "invalid"; reason: string } {
  const invalid = (reason: string) => ({ status: "invalid" as const, reason });
  const commits = new Map<string, string | null>();
  for (const [name, commit] of refs) {
    if (commits.has(name)) {
      return invalid(`Checkpoint bundle lists ${name} twice`);
    }
    commits.set(name, commit);
  }
  // As the bundle names them; one under `CHECKPOINT_BRANCH_PREFIX` stands
  // for the branch under `refs/heads/`.
  const branches = [...commits.keys()].filter(
    (name) =>
      name.startsWith("refs/heads/") ||
      name.startsWith(CHECKPOINT_BRANCH_PREFIX),
  );
  const upstreams = [...commits.keys()].filter((name) =>
    name.startsWith(CHECKPOINT_UPSTREAM_PREFIX),
  );
  const sourceRefs = [...commits.keys()].filter((name) =>
    name.startsWith(CHECKPOINT_SOURCE_PREFIX),
  );
  const unknown = [...commits.keys()].filter(
    (name) =>
      !branches.includes(name) &&
      !upstreams.includes(name) &&
      !sourceRefs.includes(name) &&
      name !== CHECKPOINT_HEAD_REF &&
      name !== CHECKPOINT_WORKTREE_REF &&
      name !== CHECKPOINT_INSTRUCTIONS_REF,
  );
  if (unknown.length > 0 || branches.length > 1 || upstreams.length > 1) {
    return invalid(
      `Checkpoint bundle carries refs a capture does not write: ${[...unknown, ...branches.slice(1), ...upstreams.slice(1)].join(", ")}`,
    );
  }
  const tracked = upstreams[0];
  const merge =
    tracked === undefined
      ? null
      : `refs/${tracked.slice(CHECKPOINT_UPSTREAM_PREFIX.length)}`;
  if (
    merge !== null &&
    (branches.length === 0 || !merge.startsWith("refs/heads/"))
  ) {
    return invalid(
      `Checkpoint bundle carries ${tracked}, which is no upstream of a branch`,
    );
  }
  if (sourceRefs.length > MAX_CHECKPOINT_SOURCES) {
    return invalid(
      `Checkpoint bundle carries ${sourceRefs.length} source branches, over the ${MAX_CHECKPOINT_SOURCES} a capture writes`,
    );
  }
  const notCommit = [...commits].find(([, commit]) => commit === null);
  if (notCommit !== undefined) {
    return invalid(`Checkpoint bundle's ${notCommit[0]} is not a commit`);
  }
  const head = commits.get(CHECKPOINT_HEAD_REF);
  const worktree = commits.get(CHECKPOINT_WORKTREE_REF);
  if (head == null || worktree == null) {
    return invalid(
      `Checkpoint bundle is missing ${CHECKPOINT_HEAD_REF} or ${CHECKPOINT_WORKTREE_REF}`,
    );
  }
  if (worktree !== gitCommit) {
    return invalid(
      `Checkpoint bundle pins worktree ${worktree}, not the manifest's ${gitCommit}`,
    );
  }
  const carried = branches[0];
  const branch =
    carried?.startsWith(CHECKPOINT_BRANCH_PREFIX) === true
      ? `refs/${carried.slice(CHECKPOINT_BRANCH_PREFIX.length)}`
      : (carried ?? null);
  if (carried !== undefined && commits.get(carried) !== head) {
    return invalid(`Checkpoint bundle's ${carried} is not at HEAD's commit`);
  }
  if (branch !== null && !branch.startsWith("refs/heads/")) {
    return invalid(`Checkpoint bundle carries ${carried}, which is no branch`);
  }
  // A real repository never holds `foo` beside `foo/bar`, or one name twice,
  // so a bundle that does would restore a branch at another commit than the
  // manifest's verified one.
  const branchNames = [
    ...sourceRefs.map((name) => name.slice(CHECKPOINT_SOURCE_PREFIX.length)),
    ...(branch === null ? [] : [branch.slice("refs/heads/".length)]),
  ];
  const clash = branchNames.find(
    (name, at) =>
      name === "" ||
      branchNames.some(
        (other, to) =>
          to !== at && (other === name || other.startsWith(`${name}/`)),
      ),
  );
  if (clash !== undefined) {
    return invalid(
      `Checkpoint bundle names the branch "${clash}" twice or as the parent of another branch`,
    );
  }
  const upstreamCommit = tracked === undefined ? null : commits.get(tracked);
  return {
    status: "valid",
    refs: {
      branch,
      head,
      instructions: commits.get(CHECKPOINT_INSTRUCTIONS_REF) ?? null,
      sources: sourceRefs
        .map((name) => ({
          name: name.slice(CHECKPOINT_SOURCE_PREFIX.length),
          commit: commits.get(name) as string,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      upstream:
        merge === null || upstreamCommit == null
          ? null
          : { commit: upstreamCommit, merge },
      worktree,
    },
  };
}
