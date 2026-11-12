export type WorkspaceBundleVerdict =
  | { readonly status: "restorable" }
  | { readonly reason: string; readonly status: "unusable" };

/**
 * Decides whether a stored git bundle can put a workspace back on a commit.
 *
 * It is a port because the only answer worth trusting comes from git itself.
 * `git index-pack --strict` reconstructs every packed object through its delta
 * chain, which is what proves the commit is in there; nothing short of that
 * distinguishes a real pack from bytes shaped like one. The control plane does
 * not run git, so the implementation is injected.
 *
 * The service supplies a local file rather than the key so that the size
 * policy stays in one place: whatever a deployment plugs in, it never decides
 * on its own how much of the object store to pull in. A file rather than the
 * bytes because a bundle is sized by the workspace, not by what fits in
 * memory, and a git-backed verifier needs one on disk anyway. The file holds
 * exactly the bytes the manifest's digest names — the service checks that
 * before asking — and it exists only for the duration of the call: read it,
 * never move, modify or keep it.
 */
export interface WorkspaceBundleVerifier {
  /**
   * Names the limits verification runs under. A bundle whose verification
   * threw is not verified again for a while (`bundleRetryCooldownMs`) unless
   * this changes: a throw says as much about the limits as about the bundle.
   */
  readonly policy?: string;
  verify(input: {
    /**
     * The bundles this one builds on, oldest first, each spooled
     * and checked like it. `commit` must then be restorable from all of
     * them fetched in order: the first on its own, each later one needing
     * only commits an earlier one offers as a ref tip.
     */
    readonly bases?: readonly WorkspaceBundleFile[];
    /** The file's size, already checked against the manifest and the store. */
    readonly bytes: number;
    readonly commit: string;
    readonly key: string;
    readonly path: string;
    /**
     * The local branches the manifest names as push sources. A verifier that
     * reads the pack must find exactly these among the bundle's source refs,
     * each restorable.
     */
    readonly sources?: ReadonlyArray<{
      readonly name: string;
      readonly commit: string;
    }>;
  }): Promise<WorkspaceBundleVerdict>;
}

export type WorkspaceBundleFile = {
  readonly bytes: number;
  readonly key: string;
  readonly path: string;
};

/**
 * The default, and the only safe one: a checkpoint is refused until a
 * deployment says what verifies its workspace bundles.
 *
 * The alternative default would be to promote pointers on a check that git
 * does not have to agree with, and the damage only surfaces at the next
 * restore — when the execution that wrote the checkpoint is gone and the last
 * healthy revision has already been superseded. A composition root wires the
 * git-backed implementation here.
 */
export const rejectUnverifiedWorkspaceBundles: WorkspaceBundleVerifier = {
  async verify() {
    return {
      status: "unusable",
      reason: "no workspace bundle verifier configured",
    };
  },
};
