import type {
  ListAuditEventsQuery,
  ListAuditEventsResponse,
} from "@werft-ai/contracts";

export type AuditLogFilter = Omit<ListAuditEventsQuery, "cursor" | "limit">;

/** A page plus, for each item, the cursor that continues after it. */
export type AuditLogPage = ListAuditEventsResponse & { cursors: string[] };

export interface AuditLogReader {
  /**
   * One page of the owner's decision rows and receipts inside the
   * workspace's retention window, newest first. A cursor it did not mint is
   * InvalidCursorError.
   */
  page(
    ownerId: string,
    filter: AuditLogFilter,
    cursor: string | undefined,
    limit: number,
  ): Promise<AuditLogPage>;
  /**
   * How many of the rows page() would list for this filter come from each
   * table, each read no further than `stopAt`, so a count of `stopAt` means
   * at least that many.
   */
  count(
    ownerId: string,
    filter: AuditLogFilter,
    stopAt: number,
  ): Promise<{ decision: number; receipt: number }>;
}
