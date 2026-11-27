import {
  agentIdParamsSchema,
  getSlackNoticeResponseSchema,
  setConversationRolloutRequestSchema,
} from "@werft-ai/contracts";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import type { SlackNoticeService } from "../../slack-notice-service.ts";
import { mapped, requireParams } from "../errors.ts";

export function registerSlackNoticeRoutes(
  router: ApiRouter,
  notices: Pick<SlackNoticeService, "read" | "setRollout" | "retired">,
) {
  apiRoute(router, "getSlackNotice", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const read = await mapped(() =>
      notices.read(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, getSlackNoticeResponseSchema, read);
  });

  // Retired with the notice approval; 410 until the routes are removed.
  apiRoute(router, "approveSlackNotice", (context) =>
    mapped(async () => notices.retired(context.get("caller"))),
  );

  apiRoute(router, "setConversationRollout", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const body = await parseJsonBody(
      context,
      setConversationRolloutRequestSchema,
    );
    const set = await mapped(() =>
      notices.setRollout(context.get("caller"), params.id, body),
    );
    return jsonWithSchema(context, getSlackNoticeResponseSchema, set);
  });

  apiRoute(router, "revokeSlackNotice", (context) =>
    mapped(async () => notices.retired(context.get("caller"))),
  );
}
