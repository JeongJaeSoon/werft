import { expect, test } from "bun:test";
import {
  getReceiptResponseSchema,
  receiptOperationSchema,
} from "@werft-ai/contracts";
import { createApiClient } from "./client.ts";
import { unwrap } from "./errors.ts";

const receipt = {
  id: "33333333-3333-4333-8333-333333333333",
  operation: "enable_connection",
  target_ref: {
    resource: { kind: "workspace", id: "44444444-4444-4444-8444-444444444444" },
    workspace_id: "44444444-4444-4444-8444-444444444444",
  },
  status: "succeeded",
  result: { connection_id: "console-key", source: "console" },
  error: null,
  created_at: "2026-11-09T00:00:00Z",
  updated_at: "2026-11-09T00:00:00Z",
} as const;

test("new clients validate the enable_connection receipt", () => {
  expect(getReceiptResponseSchema.safeParse(receipt).success).toBe(true);
});

// A web built before the operation existed: production runs `warn`, a dev
// build runs `strict` and is the only one that reports the new value.
test("a client from before the operation keeps the receipt in off and warn; only strict reports it", async () => {
  const oldSchema = getReceiptResponseSchema.extend({
    operation: receiptOperationSchema.exclude(["enable_connection"]),
  });
  const mismatches: unknown[] = [];
  for (const validate of ["off", "warn", "strict"] as const) {
    const client = createApiClient({
      baseUrl: "https://example.invalid",
      validate,
      fetch: async () => Response.json(receipt),
      validators: {
        responses: {
          "GET /v1/receipts/{id}": (body) => {
            const result = oldSchema.safeParse(body);
            return result.success
              ? []
              : result.error.issues.map((issue) => ({
                  path: issue.path.join("."),
                  message: issue.message,
                }));
          },
        },
      },
      onContractMismatch: (mismatch) => mismatches.push(mismatch),
    });
    const call = unwrap(
      client.GET("/v1/receipts/{id}", { params: { path: { id: receipt.id } } }),
    );
    if (validate === "strict") {
      await expect(call).rejects.toMatchObject({
        code: "CLIENT_CONTRACT_MISMATCH",
      });
    } else {
      expect(await call).toEqual(receipt);
    }
  }
  expect(mismatches).toHaveLength(1);
});
