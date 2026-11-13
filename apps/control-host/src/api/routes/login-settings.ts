import {
  loginSettingsResponseSchema,
  updateLoginSettingsRequestSchema,
  updateLoginSettingsResponseSchema,
} from "@werft-ai/contracts";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../app.ts";
import type { LoginSettingsAdmin } from "../login-settings.ts";
import { mapped } from "./errors.ts";

/** The owner's password switch and emergency admin (design 9). */
export function registerLoginSettingsRoutes(
  router: ApiRouter,
  admin: LoginSettingsAdmin,
) {
  apiRoute(router, "getLoginSettings", async (context) => {
    const read = await mapped(() => admin.read(context.get("caller")));
    return jsonWithSchema(context, loginSettingsResponseSchema, read);
  });

  apiRoute(router, "updateLoginSettings", async (context) => {
    const body = await parseJsonBody(context, updateLoginSettingsRequestSchema);
    const changed = await mapped(() =>
      admin.change(context.get("caller"), body),
    );
    return jsonWithSchema(context, updateLoginSettingsResponseSchema, changed);
  });
}
