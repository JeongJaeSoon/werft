import type {
  AuthorizationRequest,
  ListAuditEventsQuery,
  ListAuditEventsResponse,
} from "@werft-ai/contracts";
import type { AuthorizationPolicy, Caller } from "./policy.ts";
import type {
  AuditLogFilter,
  AuditLogPage,
  AuditLogReader,
} from "./ports/audit-log-reader.ts";
import { requirePermitted } from "./require-permitted.ts";
import { SessionServiceError } from "./service-errors.ts";

export interface AuditExport {
  /**
   * The next page, read only while the caller still holds `audit_log.read`:
   * a demotion or removal mid-export refuses it.
   */
  page(cursor: string | undefined, limit: number): Promise<AuditLogPage>;
}

export interface AuditLogService {
  list(
    caller: Caller,
    query: ListAuditEventsQuery,
  ): Promise<ListAuditEventsResponse>;
  startExport(caller: Caller, filter: AuditLogFilter): Promise<AuditExport>;
}

export function createAuditLogService(deps: {
  authorization: AuthorizationPolicy;
  reader: AuditLogReader;
}): AuditLogService {
  const { authorization, reader } = deps;
  // A management action: the decision, allow included, is on record, so
  // reading the audit log is itself in it.
  const requireReader = (caller: Caller) =>
    requirePermitted(authorization, caller, "audit_log.read", {
      kind: "workspace",
      id: caller.ownerId,
    });
  return {
    async list(caller, query) {
      await requireReader(caller);
      const { cursor, limit, ...filter } = query;
      const { cursors: _cursors, ...page } = await reader.page(
        caller.ownerId,
        filter,
        cursor,
        limit,
      );
      return page;
    },

    async startExport(caller, filter) {
      await requireReader(caller);
      const request: AuthorizationRequest = {
        subject: caller.subject,
        action: "audit_log.read",
        resource: {
          kind: "workspace",
          id: caller.ownerId,
          owner_scope: caller.ownerId,
        },
        request_id: caller.requestId,
      };
      return {
        async page(cursor, limit) {
          // Asked again per page and kept off the record: the export's one
          // row is the allow above.
          const decision = await authorization
            .authorize(request, { record: false })
            .catch(() => null);
          if (decision?.outcome !== "allow") {
            throw new SessionServiceError(
              "FORBIDDEN",
              "This principal no longer holds audit_log.read",
              undefined,
              { reason_code: decision?.reason_code ?? "error" },
            );
          }
          return reader.page(caller.ownerId, filter, cursor, limit);
        },
      };
    },
  };
}
