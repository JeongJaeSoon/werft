import {
  slackSettingsSchema,
  updateSlackSettingsRequestSchema,
  updateSlackSettingsResponseSchema,
} from "@werft-ai/contracts";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../app.ts";
import type { SlackSettingsAdmin } from "../slack-settings.ts";
import { mapped } from "./errors.ts";

export function registerSlackSettingsRoutes(
  router: ApiRouter,
  admin: SlackSettingsAdmin,
) {
  apiRoute(router, "getSlackSettings", async (context) => {
    const read = await mapped(() => admin.read(context.get("caller")));
    return jsonWithSchema(context, slackSettingsSchema, read);
  });

  apiRoute(router, "updateSlackSettings", async (context) => {
    const body = await parseJsonBody(context, updateSlackSettingsRequestSchema);
    const changed = await mapped(() =>
      admin.change(context.get("caller"), body),
    );
    return jsonWithSchema(context, updateSlackSettingsResponseSchema, changed);
  });
}
