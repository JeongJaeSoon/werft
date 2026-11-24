import { z } from "zod";

/** What the console tells owners and admins about the installation itself. */
export const installationStatusSchema = z.object({
  /** INSTALLATION_PROFILE: `test` trades production guarantees for a trial. */
  profile: z.enum(["production", "test"]),
  /**
   * EXECUTION_WORKSPACE_QUOTA=off: worker workspaces have no kernel quota and
   * only the workers' measurement holds them.
   */
  no_disk_quota: z.boolean(),
});
export type InstallationStatus = z.infer<typeof installationStatusSchema>;
