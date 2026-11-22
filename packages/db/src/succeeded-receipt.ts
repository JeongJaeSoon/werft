import { randomUUID } from "node:crypto";
import type { ReceiptOperation } from "@werft-ai/contracts";
import {
  type Principal,
  receiptActorOf,
  type SecretAudit,
} from "@werft-ai/platform";
import type { Database } from "./queries.ts";
import { receipts } from "./schema.ts";

/**
 * The receipt row of a change to a workspace's own settings, for a write that
 * inserts it with its other rows: the workspace is its owner and its target.
 */
export function workspaceReceiptRow(
  audit: SecretAudit,
  workspaceId: string,
  operation: ReceiptOperation,
  result: Record<string, unknown>,
) {
  return {
    id: audit.receiptId,
    ownerId: workspaceId,
    actor: receiptActorOf(audit.principal),
    operation,
    targetRef: {
      resource: { kind: "workspace", id: workspaceId },
      workspace_id: workspaceId,
    },
    status: "succeeded" as const,
    result,
  };
}

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
