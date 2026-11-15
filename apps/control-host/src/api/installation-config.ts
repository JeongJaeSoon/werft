import type {
  InstallationConfig,
  SessionArchiveStatus,
  UpdateInstallationConfigRequest,
  UpdateInstallationConfigResponse,
} from "@werft-ai/contracts";
import type { InstallationConfigStore } from "@werft-ai/db";
import type { AuthorizationPolicy, Caller } from "@werft-ai/platform";
import type { InstallationConfigSource } from "../wiring/installation-config.ts";
import type { CheckpointStorageConfig } from "./checkpoints.ts";
import { requireSignInOwner } from "./provider-admin.ts";

/** Whether this API's object store could hold archived events. */
export function sessionArchiveStatusOf(
  storage: CheckpointStorageConfig | "disabled",
): SessionArchiveStatus {
  if (storage === "disabled") {
    return { available: false, reason: "object_store_disabled" };
  }
  return storage.protection === "locked"
    ? { available: true, reason: null }
    : { available: false, reason: "unversioned" };
}

/** The owner's view of the installation settings, and saving them. */
export function createInstallationConfigAdmin(deps: {
  authorization: AuthorizationPolicy;
  source: InstallationConfigSource;
  store: Pick<InstallationConfigStore, "setValues">;
  sessionArchive: SessionArchiveStatus;
}) {
  return {
    async read(caller: Caller): Promise<InstallationConfig> {
      await requireSignInOwner(deps.authorization, caller);
      return {
        ...(await deps.source.view()),
        session_archive: deps.sessionArchive,
      };
    },

    async change(
      caller: Caller,
      body: UpdateInstallationConfigRequest,
    ): Promise<UpdateInstallationConfigResponse> {
      const audit = await requireSignInOwner(deps.authorization, caller);
      const values = Object.fromEntries(
        Object.entries(body).filter(([, value]) => value !== undefined),
      );
      const { changed } = await deps.store.setValues({ values, audit });
      return {
        ...(await deps.source.view()),
        session_archive: deps.sessionArchive,
        ...(changed ? { receipt_id: audit.receiptId } : {}),
      };
    },
  };
}

export type InstallationConfigAdmin = ReturnType<
  typeof createInstallationConfigAdmin
>;
