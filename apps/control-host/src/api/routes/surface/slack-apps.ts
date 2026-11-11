import {
  agentIdParamsSchema,
  createSlackAppRequestSchema,
  createSlackAppResponseSchema,
  deleteSlackAppResponseSchema,
  getSlackAppManifestResponseSchema,
  getSlackAppResponseSchema,
  listWorkspaceSlackAppsResponseSchema,
  putSlackSecretRequestSchema,
  putSlackSecretResponseSchema,
  slackAppParamsSchema,
  slackAppSecretParamsSchema,
  slackAppSettingsSchema,
  workspaceParamsSchema,
} from "@werft-ai/contracts";
import type { StructuredLogger } from "@werft-ai/observability";
import { stringify } from "yaml";
import type {
  SlackAppService,
  SlackSecretService,
} from "../../../wiring/chat-slack.ts";
import {
  ApiHttpError,
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import { mapped, requireParams } from "../errors.ts";

export function registerSlackAppRoutes(
  router: ApiRouter,
  deps: {
    apps: SlackAppService;
    secrets: SlackSecretService;
    logger?: StructuredLogger;
  },
) {
  const { apps, secrets, logger } = deps;

  apiRoute(router, "getSlackAppManifest", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const manifest = await mapped(() =>
      apps.getAgentAppManifest(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, getSlackAppManifestResponseSchema, {
      manifest_yaml: stringify(manifest),
    });
  });
  apiRoute(router, "getSlackAppSettings", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    return jsonWithSchema(
      context,
      slackAppSettingsSchema,
      await mapped(() =>
        apps.getAgentAppSettings(context.get("caller"), params.id),
      ),
    );
  });
  apiRoute(router, "putSlackAppSettings", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const settings = await parseJsonBody(context, slackAppSettingsSchema);
    return jsonWithSchema(
      context,
      slackAppSettingsSchema,
      await mapped(() =>
        apps.putAgentAppSettings(context.get("caller"), params.id, settings),
      ),
    );
  });

  apiRoute(router, "getSlackApp", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const found = await mapped(() =>
      apps.getAgentApp(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, getSlackAppResponseSchema, found);
  });

  apiRoute(router, "recheckSlackAppEvents", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const found = await mapped(() =>
      apps.recheckAgentAppEvents(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, getSlackAppResponseSchema, found);
  });

  apiRoute(router, "createSlackApp", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const body = await parseJsonBody(context, createSlackAppRequestSchema);
    const created = await mapped(() =>
      apps.createAgentApp(context.get("caller"), params.id, body),
    );
    logger?.info("Slack app created", {
      agent_id: params.id,
      slack_app_id: created.slack_app.id,
      app_id: created.slack_app.app_id,
      created: created.created,
    });
    return jsonWithSchema(context, createSlackAppResponseSchema, created);
  });

  apiRoute(router, "listWorkspaceSlackApps", async (context) => {
    const params = requireParams(context, workspaceParamsSchema);
    const listed = await mapped(() =>
      apps.listMadeApps(context.get("caller"), params.id.toLowerCase()),
    );
    return jsonWithSchema(
      context,
      listWorkspaceSlackAppsResponseSchema,
      listed,
    );
  });

  apiRoute(router, "deleteSlackApp", async (context) => {
    const params = requireParams(context, slackAppParamsSchema);
    const deleted = await mapped(() =>
      apps.deleteApp(
        context.get("caller"),
        params.id.toLowerCase(),
        params.app_id.toLowerCase(),
      ),
    );
    logger?.info("Slack app deleted", {
      slack_app_id: deleted.slack_app.id,
      app_id: deleted.slack_app.app_id,
      state: deleted.slack_app.state,
    });
    return jsonWithSchema(context, deleteSlackAppResponseSchema, deleted);
  });

  apiRoute(router, "putSlackAppSecret", async (context) => {
    const parsed = slackAppSecretParamsSchema.safeParse(context.req.param());
    if (!parsed.success) {
      throw new ApiHttpError(
        400,
        "BAD_REQUEST",
        "The app id must be a UUID and the purpose one of slack_signing_secret, slack_client_secret, slack_bot_token",
      );
    }
    const params = parsed.data;
    const set = await mapped(() =>
      secrets.setAppSecret(
        context.get("caller"),
        params.id.toLowerCase(),
        params.app_id.toLowerCase(),
        params.purpose,
        async () =>
          (await parseJsonBody(context, putSlackSecretRequestSchema)).value,
      ),
    );
    return jsonWithSchema(context, putSlackSecretResponseSchema, set);
  });
}
