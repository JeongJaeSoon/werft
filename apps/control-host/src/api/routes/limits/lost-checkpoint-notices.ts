import {
  closeLostCheckpointNoticesRequestSchema,
  lostCheckpointNoticesSchema,
} from "@werft-ai/contracts";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import type { LostCheckpointNoticesAdmin } from "../../lost-checkpoint-notices.ts";
import { mapped } from "../errors.ts";

/** The console's banner for checkpoints a test installation gave up at start. */
export function registerLostCheckpointNoticeRoutes(
  router: ApiRouter,
  admin: LostCheckpointNoticesAdmin,
) {
  apiRoute(router, "listLostCheckpointNotices", async (context) => {
    const read = await mapped(() => admin.read(context.get("caller")));
    return jsonWithSchema(context, lostCheckpointNoticesSchema, read);
  });

  apiRoute(router, "closeLostCheckpointNotices", async (context) => {
    const body = await parseJsonBody(
      context,
      closeLostCheckpointNoticesRequestSchema,
    );
    const left = await mapped(() => admin.close(context.get("caller"), body));
    return jsonWithSchema(context, lostCheckpointNoticesSchema, left);
  });
}
