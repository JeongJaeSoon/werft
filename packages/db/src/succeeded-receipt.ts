import { randomUUID } from "node:crypto";
import type { ReceiptOperation } from "@werft-ai/contracts";
import { type Principal, receiptActorOf } from "@werft-ai/platform";
import type { Database } from "./queries.ts";
import { receipts } from "./schema.ts";

/**
 * The receipt of a change a principal made to one resource of a workspace,
 * written in the change's own transaction. Returns the receipt id.
 */
export async function writeSucceededReceipt(
  tx: Database,
  principal: Principal,
  input: {
    id?: string;
    operation: ReceiptOperation;
    resource: { kind: string; id: string };
    workspaceId: string;
    result: unknown;
  },
): Promise<string> {
  const id = input.id ?? randomUUID();
  await tx.insert(receipts).values({
    id,
    ownerId: principal.ownerId,
    actor: receiptActorOf(principal),
    requestId: principal.requestId ?? null,
    operation: input.operation,
    targetRef: { resource: input.resource, workspace_id: input.workspaceId },
    status: "succeeded",
    result: input.result,
  });
  return id;
}
