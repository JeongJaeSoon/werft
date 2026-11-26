import { installationStatusSchema } from "@werft-ai/contracts";
import { type ApiRouter, apiRoute, jsonWithSchema } from "../../app.ts";
import type { InstallationStatusReader } from "../../installation-status.ts";
import { mapped } from "../errors.ts";

/** The console's note for an installation without a disk quota. */
export function registerInstallationStatusRoutes(
  router: ApiRouter,
  reader: InstallationStatusReader,
) {
  apiRoute(router, "getInstallationStatus", async (context) => {
    const status = await mapped(() => reader.read(context.get("caller")));
    return jsonWithSchema(context, installationStatusSchema, status);
  });
}
