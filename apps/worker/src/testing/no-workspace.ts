import type { WorkspacePreparer } from "../workspace.ts";

/** For hosts whose engine never touches a repository, like the fake. */
export const noWorkspace: WorkspacePreparer = {
  async prepare() {
    return "reuse";
  },
  committedInstructions: () => null,
  instructionsCommit: () => null,
};
