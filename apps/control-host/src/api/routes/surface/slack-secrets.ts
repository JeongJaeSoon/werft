import {
  deleteSlackSecretResponseSchema,
  putSlackConfigTokenResponseSchema,
  putSlackSecretRequestSchema,
  slackConfigTokenSummarySchema,
  workspaceParamsSchema,
} from "@werft-ai/contracts";
import type { Context } from "hono";
import type { SlackSecretService } from "../../../wiring/chat-slack.ts";
import {
  type ApiEnvironment,
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import { mapped, requireParams } from "../errors.ts";

function lowercaseWorkspaceId(context: Context<ApiEnvironment>): string {
  return requireParams(context, workspaceParamsSchema).id.toLowerCase();
}

export function registerSlackSecretRoutes(
  router: ApiRouter,
  service: SlackSecretService,
) {
  apiRoute(router, "getSlackConfigToken", async (context) => {
    const summary = await mapped(() =>
      service.describeConfigToken(
        context.get("caller"),
        lowercaseWorkspaceId(context),
      ),
    );
    return jsonWithSchema(context, slackConfigTokenSummarySchema, summary);
  });

  apiRoute(router, "putSlackConfigToken", async (context) => {
    const set = await mapped(() =>
      service.setConfigToken(
        context.get("caller"),
        lowercaseWorkspaceId(context),
        async () =>
          (await parseJsonBody(context, putSlackSecretRequestSchema)).value,
      ),
    );
    return jsonWithSchema(context, putSlackConfigTokenResponseSchema, set);
  });

  apiRoute(router, "deleteSlackConfigToken", async (context) => {
    const deleted = await mapped(() =>
      service.deleteConfigToken(
        context.get("caller"),
        lowercaseWorkspaceId(context),
      ),
    );
    return jsonWithSchema(context, deleteSlackSecretResponseSchema, deleted);
  });
}
