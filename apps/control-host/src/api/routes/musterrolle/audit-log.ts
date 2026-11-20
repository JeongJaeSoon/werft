import {
  AUDIT_EXPORT_MAX_ROWS,
  AUDIT_EXPORT_MEDIA_TYPE,
  type AuditExportEnd,
  type AuditExportRow,
  listAuditEventsQuerySchema,
  listAuditEventsResponseSchema,
} from "@werft-ai/contracts";
import type { AuditLogPage, AuditLogService } from "@werft-ai/platform";
import { stream } from "hono/streaming";
import {
  ApiHttpError,
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
} from "../../app.ts";
import { mapped, requireQuery } from "../errors.ts";

// docs/contributing/decisions/audit-log-read.md §4, 내보내기.
const EXPORT_PAGE_ROWS = 500;
const EXPORT_MAX_MS = 10 * 60_000;
// As the session event stream: a credential check is good for this long,
// the next starts halfway through, and a write blocked longer is a dead peer.
const EXPORT_CHECK_MS = 15_000;

export interface AuditLogRouteOptions {
  maxRows?: number;
  pageRows?: number;
  maxMs?: number;
  checkMs?: number;
}

function wantsExport(accept: string | undefined): boolean {
  return (accept ?? "")
    .split(",")
    .some((part) => part.split(";")[0]?.trim() === AUDIT_EXPORT_MEDIA_TYPE);
}

export function registerAuditLogRoutes(
  router: ApiRouter,
  service: AuditLogService,
  options: AuditLogRouteOptions = {},
) {
  const maxRows = options.maxRows ?? AUDIT_EXPORT_MAX_ROWS;
  const pageRows = options.pageRows ?? EXPORT_PAGE_ROWS;
  const maxMs = options.maxMs ?? EXPORT_MAX_MS;
  const checkMs = options.checkMs ?? EXPORT_CHECK_MS;
  // One export per workspace in this process.
  const exporting = new Set<string>();

  apiRoute(router, "listAuditEvents", async (context) => {
    const query = requireQuery(context, listAuditEventsQuerySchema);
    const caller = context.get("caller");
    if (!wantsExport(context.req.header("Accept"))) {
      const page = await mapped(() => service.list(caller, query));
      return jsonWithSchema(context, listAuditEventsResponseSchema, page);
    }

    const { cursor: after, limit: _limit, ...filter } = query;
    // Decided (and recorded) before the slot check, so a refused caller's
    // attempt is on record whatever else is running.
    const exportPages = await mapped(() => service.startExport(caller, filter));
    if (exporting.has(caller.ownerId)) {
      context.header("Retry-After", "60");
      throw new ApiHttpError(
        429,
        "RATE_LIMITED",
        "An export of this workspace is already running",
        true,
      );
    }
    exporting.add(caller.ownerId);
    const reauthenticate = context.get("reauthenticate");
    const startedAt = Date.now();
    const closed = new AbortController();
    let onClose: (() => void) | undefined;
    const closeWith = (reason: string) => {
      if (closed.signal.aborted) return;
      closed.abort(reason);
      onClose?.();
    };

    let verifiedUntil = startedAt + checkMs;
    let inflight: Promise<boolean> | undefined;
    const verify = (): Promise<boolean> => {
      inflight ??= (async () => {
        const at = Date.now();
        let bound: ReturnType<typeof setTimeout> | undefined;
        try {
          const verdict = await Promise.race([
            reauthenticate(),
            new Promise<boolean>((resolve) => {
              bound = setTimeout(() => resolve(false), checkMs / 2);
            }),
          ]);
          if (verdict) verifiedUntil = at + checkMs;
          return verdict;
        } catch {
          return false;
        } finally {
          clearTimeout(bound);
          inflight = undefined;
        }
      })();
      return inflight;
    };
    // Runs whatever the export awaits: a slow page or a blocked write may
    // not stretch how long a signed-out owner keeps receiving rows.
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      watchdog = setTimeout(
        async () => {
          if (closed.signal.aborted || finished) return;
          const verdict = await verify();
          // The export may have ended while the check was out.
          if (closed.signal.aborted || finished) return;
          if (!verdict) return closeWith("credential_revoked");
          arm();
        },
        Math.max(0, verifiedUntil - Date.now() - checkMs / 2),
      );
    };
    const deadline = setTimeout(() => closeWith("deadline"), maxMs);
    let finished = false;
    const finish = () => {
      finished = true;
      clearTimeout(watchdog);
      clearTimeout(deadline);
      exporting.delete(caller.ownerId);
    };

    // The first page is read before the response commits, so a bad cursor
    // or a storage outage is still an ordinary error.
    let first: AuditLogPage;
    try {
      first = await mapped(() =>
        exportPages.page(after, Math.min(pageRows, maxRows)),
      );
    } catch (error) {
      closeWith("refused");
      finish();
      throw error;
    }
    arm();

    context.header("Content-Type", AUDIT_EXPORT_MEDIA_TYPE);
    context.header("X-Accel-Buffering", "no");
    return stream(context, async (out) => {
      onClose = () => out.abort();
      out.onAbort(() => closeWith("client_disconnected"));
      const write = async (line: unknown): Promise<boolean> => {
        if (closed.signal.aborted) return false;
        // Nothing goes out past the last good check.
        if (Date.now() > verifiedUntil && !(await verify())) {
          closeWith("credential_revoked");
          return false;
        }
        if (closed.signal.aborted) return false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const stalled = new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), checkMs);
        });
        try {
          const written = await Promise.race([
            out.write(`${JSON.stringify(line)}\n`).then(() => true),
            stalled,
          ]);
          if (!written) closeWith("write_stalled");
          return written && !closed.signal.aborted;
        } finally {
          clearTimeout(timer);
        }
      };
      try {
        let page = first;
        let rows = 0;
        for (;;) {
          for (const [index, item] of page.items.entries()) {
            const row: AuditExportRow = {
              ...item,
              cursor: page.cursors[index] ?? "",
            };
            if (!(await write(row))) return;
            rows += 1;
          }
          const remaining = maxRows - rows;
          if (page.next_cursor === null || remaining <= 0) {
            const end: AuditExportEnd = {
              kind: "end",
              rows,
              truncated: page.next_cursor !== null,
              next_cursor: page.next_cursor,
            };
            await write(end);
            return;
          }
          // A refusal (demoted, removed) or a storage error ends the export
          // without its end line, which is how the reader knows.
          page = await exportPages.page(
            page.next_cursor,
            Math.min(pageRows, remaining),
          );
          if (closed.signal.aborted) return;
        }
      } catch {
        closeWith("read_failed");
      } finally {
        finish();
      }
    });
  });
}
