import {
  agentIdParamsSchema,
  approveSlackNoticeRequestSchema,
  getSlackNoticeResponseSchema,
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
  notices: Pick<SlackNoticeService, "read" | "approve" | "revoke">,
) {
  apiRoute(router, "getSlackNotice", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const read = await mapped(() =>
      notices.read(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, getSlackNoticeResponseSchema, read);
  });

  apiRoute(router, "approveSlackNotice", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const body = await parseJsonBody(context, approveSlackNoticeRequestSchema);
    const approved = await mapped(() =>
      notices.approve(context.get("caller"), params.id, body),
    );
    return jsonWithSchema(context, getSlackNoticeResponseSchema, approved);
  });

  apiRoute(router, "revokeSlackNotice", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const revoked = await mapped(() =>
      notices.revoke(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, getSlackNoticeResponseSchema, revoked);
  });
}
