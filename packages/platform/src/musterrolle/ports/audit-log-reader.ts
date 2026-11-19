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
}
