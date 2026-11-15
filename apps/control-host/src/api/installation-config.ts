import type {
  InstallationConfig,
  UpdateInstallationConfigRequest,
  UpdateInstallationConfigResponse,
} from "@werft-ai/contracts";
import type { InstallationConfigStore } from "@werft-ai/db";
import type { AuthorizationPolicy, Caller } from "@werft-ai/platform";
import type { InstallationConfigSource } from "../wiring/installation-config.ts";
import { requireSignInOwner } from "./provider-admin.ts";

/** The owner's view of the installation settings, and saving them. */
export function createInstallationConfigAdmin(deps: {
  authorization: AuthorizationPolicy;
  source: InstallationConfigSource;
  store: Pick<InstallationConfigStore, "setValues">;
}) {
  return {
    async read(caller: Caller): Promise<InstallationConfig> {
      await requireSignInOwner(deps.authorization, caller);
      return deps.source.view();
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
        ...(changed ? { receipt_id: audit.receiptId } : {}),
      };
    },
  };
}

export type InstallationConfigAdmin = ReturnType<
  typeof createInstallationConfigAdmin
>;
