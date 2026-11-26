import type { InstallationStatus } from "@werft-ai/contracts";
import {
  type AuthorizationPolicy,
  type Caller,
  requirePermitted,
  SessionServiceError,
} from "@werft-ai/platform";
import type { InstallationProfile } from "../installation-profile.ts";

/**
 * EXECUTION_WORKSPACE_QUOTA=off, as the scheduler reads it: worker workspaces
 * get no kernel quota and only the workers' own measurement holds them. The
 * API reads the same variable so readiness and the console can say so.
 */
export function noDiskQuotaFromEnv(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return environment.EXECUTION_WORKSPACE_QUOTA === "off";
}

/** The start-time warning for an installation without a disk quota. */
export function noDiskQuotaWarning(profile: InstallationProfile): string {
  return profile === "test"
    ? "Test mode: worker workspaces have no disk quota (EXECUTION_WORKSPACE_QUOTA=off); this installation is not for production. Each worker measures its workspace at most once a minute and stops a turn that outgrows the limit"
    : "Worker workspaces have no disk quota (EXECUTION_WORKSPACE_QUOTA=off): each worker measures its workspace at most once a minute and stops a turn that outgrows the limit, so a workspace can pass it between two measurements. Turn the XFS quota on for production";
}

/**
 * What the console's quota note says about the installation itself: owners and
 * admins read it, signed in, like the other installation notices.
 */
export function createInstallationStatusReader(deps: {
  authorization: AuthorizationPolicy;
  status: InstallationStatus;
}) {
  return {
    async read(caller: Caller): Promise<InstallationStatus> {
      await requirePermitted(deps.authorization, caller, "workspace.manage", {
        kind: "workspace",
        id: caller.ownerId,
      });
      if (caller.subject.principal?.kind !== "user" || !caller.actor?.userId) {
        throw new SessionServiceError(
          "FORBIDDEN",
          "Only a signed-in owner or admin reads the installation's notices",
          undefined,
          { reason_code: "role" },
        );
      }
      return deps.status;
    },
  };
}

export type InstallationStatusReader = ReturnType<
  typeof createInstallationStatusReader
>;
