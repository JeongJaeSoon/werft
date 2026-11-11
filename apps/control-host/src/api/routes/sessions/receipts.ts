import {
  getReceiptResponseSchema,
  receiptIdParamsSchema,
} from "@werft-ai/contracts";
import type { SessionService } from "@werft-ai/platform";
import { type ApiRouter, apiRoute, jsonWithSchema } from "../../app.ts";
import { mapped, requireParams } from "../errors.ts";

export function registerReceiptRoutes(
  router: ApiRouter,
  service: SessionService,
) {
  apiRoute(router, "getReceipt", async (context) => {
    const params = requireParams(context, receiptIdParamsSchema);
    const receipt = await mapped(() =>
      service.getReceipt(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, getReceiptResponseSchema, receipt);
  });
}
