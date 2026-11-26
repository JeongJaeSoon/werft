import { z } from "zod";
import {
  opaqueCursorSchema,
  timestampSchema,
  userIdSchema,
} from "../shared/index.ts";
import { principalKindSchema } from "./authorization.ts";

export const AUDIT_EVENT_KIND_VALUES = ["decision", "receipt"] as const;
export const auditEventKindSchema = z.enum(AUDIT_EVENT_KIND_VALUES);

export const AUDIT_EVENTS_LIMIT_DEFAULT = 50;
export const AUDIT_EVENTS_LIMIT_MAX = 200;
export const AUDIT_EXPORT_MAX_ROWS = 100_000;

export const AUDIT_EXPORT_MEDIA_TYPE = "application/x-ndjson";

const optionalText = (max: number) => z.string().min(1).max(max).optional();

export const listAuditEventsQuerySchema = z
  .object({
    from: timestampSchema.optional().meta({
      description:
        "Keeps rows at or after this time. A time before the retention window reads as the window's start (`retention_start`).",
    }),
    to: timestampSchema.optional().meta({
      description: "Keeps rows before this time.",
    }),
    kind: auditEventKindSchema.optional().meta({
      description:
        "`decision` keeps the access decisions, `receipt` the commands. Both without it.",
    }),
    actor_user_id: userIdSchema.optional().meta({
      description: "Keeps the rows of what this person did or tried to do.",
    }),
    action: optionalText(128).meta({
      description:
        "Keeps one action: a decision's `action` or a receipt's operation.",
    }),
    outcome: optionalText(64).meta({
      description:
        "Keeps one outcome: a decision's (`allow`, `deny`, `redact`, `require_approval`) or a receipt's status.",
    }),
    cursor: opaqueCursorSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(AUDIT_EVENTS_LIMIT_MAX)
      .default(AUDIT_EVENTS_LIMIT_DEFAULT),
  })
  .strict();

export const auditEventSchema = z
  .object({
    kind: auditEventKindSchema,
    id: z.uuid(),
    at: timestampSchema,
    // Null on receipts written before requests carried one.
    request_id: z.string().nullable(),
    actor: z
      .object({
        principal_kind: principalKindSchema.nullable(),
        principal_id: z.string().nullable(),
        user_id: z.string().nullable(),
        agent_id: z.string().nullable(),
      })
      .strict(),
    action: z.string().meta({
      description: "A decision's action, or a receipt's operation.",
    }),
    target: z
      .object({ kind: z.string(), id: z.string().nullable() })
      .strict()
      .meta({
        description:
          "What the row is about: a decision's resource, or what a receipt's `target_ref` names (`session`, a resource kind, or `user`).",
      }),
    outcome: z.string().meta({
      description: "A decision's outcome, or a receipt's status.",
    }),
    // Receipts carry no reason; read GET /v1/receipts/{id} for their error.
    reason_code: z.string().nullable(),
    // Free text like `action`: rows outlive the vocabulary that wrote them.
    surface: z.string().nullable().meta({
      description:
        "Where a decision's request came from (`web`, `api`, `slack`, …); null on receipts.",
    }),
  })
  .strict();

export const listAuditEventsResponseSchema = z
  .object({
    items: z.array(auditEventSchema),
    next_cursor: opaqueCursorSchema.nullable(),
    retention_start: timestampSchema.meta({
      description:
        "The start of the workspace's retention window: nothing older is listed or exported.",
    }),
  })
  .strict();

/** Each audit count stops here; a count past it reads as `more`. */
export const AUDIT_COUNT_CAP = 1000;

export const countAuditEventsQuerySchema = listAuditEventsQuerySchema
  .omit({ cursor: true, limit: true })
  .strict();

const auditCountSchema = z
  .object({
    count: z.number().int().nonnegative().max(AUDIT_COUNT_CAP),
    more: z.boolean().meta({
      description: `True when more than ${AUDIT_COUNT_CAP} rows match: \`count\` is then ${AUDIT_COUNT_CAP}.`,
    }),
  })
  .strict();

export const countAuditEventsResponseSchema = z
  .object({
    counts: z
      .object({ decision: auditCountSchema, receipt: auditCountSchema })
      .strict()
      .meta({
        description:
          "For each `kind`, how many rows GET /v1/audit/events would list with the same filters and that `kind`, read to the last page. A `kind` in the query leaves the other at 0.",
      }),
    total: auditCountSchema,
  })
  .strict();

// The export's last line; a stream that ends without it was cut short.
export const auditExportEndSchema = z
  .object({
    kind: z.literal("end"),
    rows: z.number().int().nonnegative(),
    truncated: z.boolean(),
    next_cursor: opaqueCursorSchema.nullable(),
  })
  .strict();

// An exported row carries its own position, so a cut export resumes exactly
// after the last row it delivered.
export const auditExportRowSchema = auditEventSchema
  .extend({
    cursor: opaqueCursorSchema.meta({
      description: "Send as `cursor` to continue after this row.",
    }),
  })
  .strict();

export const auditExportLineSchema = z.union([
  auditExportRowSchema,
  auditExportEndSchema,
]);

export type AuditEventKind = z.infer<typeof auditEventKindSchema>;
export type ListAuditEventsQuery = z.infer<typeof listAuditEventsQuerySchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
export type ListAuditEventsResponse = z.infer<
  typeof listAuditEventsResponseSchema
>;
export type AuditExportRow = z.infer<typeof auditExportRowSchema>;
export type CountAuditEventsQuery = z.infer<typeof countAuditEventsQuerySchema>;
export type CountAuditEventsResponse = z.infer<
  typeof countAuditEventsResponseSchema
>;
export type AuditExportEnd = z.infer<typeof auditExportEndSchema>;
