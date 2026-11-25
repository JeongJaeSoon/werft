import {
  githubWebhookSettingsSchema,
  retryGitHubWebhookUpdatesRequestSchema,
  retryGitHubWebhookUpdatesResponseSchema,
  updateGitHubWebhookSettingsRequestSchema,
  updateGitHubWebhookSettingsResponseSchema,
} from "@werft-ai/contracts";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import type { GitHubWebhookSettingsAdmin } from "../../github-webhook-settings.ts";
import { mapped } from "../errors.ts";

export function registerGitHubWebhookSettingsRoutes(
  router: ApiRouter,
  admin: GitHubWebhookSettingsAdmin,
) {
  apiRoute(router, "getGitHubWebhookSettings", async (context) => {
    const read = await mapped(() => admin.read(context.get("caller")));
    return jsonWithSchema(context, githubWebhookSettingsSchema, read);
  });

  apiRoute(router, "updateGitHubWebhookSettings", async (context) => {
    const body = await parseJsonBody(
      context,
      updateGitHubWebhookSettingsRequestSchema,
    );
    const changed = await mapped(() =>
      admin.change(context.get("caller"), body),
    );
    return jsonWithSchema(
      context,
      updateGitHubWebhookSettingsResponseSchema,
      changed,
    );
  });

  apiRoute(router, "retryGitHubWebhookUpdates", async (context) => {
    const body = await parseJsonBody(
      context,
      retryGitHubWebhookUpdatesRequestSchema,
    );
    const retried = await mapped(() =>
      admin.retry(context.get("caller"), body),
    );
    return jsonWithSchema(
      context,
      retryGitHubWebhookUpdatesResponseSchema,
      retried,
    );
  });
}
