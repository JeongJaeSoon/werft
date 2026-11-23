import {
  installationConfigSchema,
  updateInstallationConfigRequestSchema,
  updateInstallationConfigResponseSchema,
} from "@werft-ai/contracts";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import type { InstallationConfigAdmin } from "../../installation-config.ts";
import { mapped } from "../errors.ts";

export function registerInstallationConfigRoutes(
  router: ApiRouter,
  admin: InstallationConfigAdmin,
) {
  apiRoute(router, "getInstallationConfig", async (context) => {
    const read = await mapped(() => admin.read(context.get("caller")));
    return jsonWithSchema(context, installationConfigSchema, read);
  });

  apiRoute(router, "updateInstallationConfig", async (context) => {
    const body = await parseJsonBody(
      context,
      updateInstallationConfigRequestSchema,
    );
    const changed = await mapped(() =>
      admin.change(context.get("caller"), body),
    );
    return jsonWithSchema(
      context,
      updateInstallationConfigResponseSchema,
      changed,
    );
  });
}
