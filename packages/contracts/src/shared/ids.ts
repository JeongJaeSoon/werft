import { z } from "zod";

export const sessionIdSchema = z.uuid();
export const turnIdSchema = z.string().min(1);
export const attemptIdSchema = z.string().min(1);
export const executionIdSchema = z.string().min(1);
export const receiptIdSchema = z.uuid();
export const requestIdSchema = z.string().min(1);
export const timestampSchema = z.iso.datetime();
// These land in PostgreSQL `integer` columns, so a larger value is a bad
// request rather than a failed insert.
export const INT4_MAX = 2_147_483_647;
export const revisionSchema = z.number().int().nonnegative().max(INT4_MAX);
export const epochSchema = z.number().int().nonnegative().max(INT4_MAX);
export const opaqueCursorSchema = z.string().min(1);
export const idempotencyKeySchema = z.string().min(1).max(255);
// `unknown` accepts undefined; use this where the key must be present.
export const requiredUnknownSchema = z
  .unknown()
  .refine((value) => value !== undefined, "Required");

// Interface track identifiers (I0). Rows the platform creates are uuids;
// `opaqueIdSchema` covers identifiers minted elsewhere — API key ids, owner
// partitions, external surface ids — which are not uuids.
export const OPAQUE_ID_MAX_LENGTH = 128;
export const opaqueIdSchema = z.string().min(1).max(OPAQUE_ID_MAX_LENGTH);
/**
 * The alpha owner partition. `owner_id` is an unconstrained `text` column and
 * `findOwner()` accepts any non-empty string, so capping it here would lock
 * out a tenant that already exists — a contract may not be narrower than the
 * data it is describing.
 */
export const ownerScopeSchema = z.string().min(1);
export const workspaceIdSchema = z.uuid();
export const userIdSchema = z.uuid();
export const inviteIdSchema = z.uuid();
export const grantIdSchema = z.uuid();
export const agentIdSchema = z.uuid();
export const agentVersionIdSchema = z.uuid();
// Derived: sha256 over the canonical release tuple, not a generated uuid
// (`deriveReleaseId`).
export const agentReleaseIdSchema = opaqueIdSchema;
export const surfaceBindingIdSchema = z.uuid();
export const sessionLinkIdSchema = z.uuid();
export const installationIdSchema = z.uuid();
export const memoryIdSchema = z.uuid();
export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const sessionIdParamsSchema = z.object({ id: sessionIdSchema });
export const turnIdParamsSchema = sessionIdParamsSchema.extend({
  turn_id: turnIdSchema,
});
export const receiptIdParamsSchema = z.object({ id: receiptIdSchema });
export const idempotencyKeyHeadersSchema = z.object({
  "idempotency-key": idempotencyKeySchema,
});
export const lastEventIdHeadersSchema = z.object({
  "last-event-id": opaqueCursorSchema.optional(),
});

export const PAGE_LIMIT_DEFAULT = 50;
export const PAGE_LIMIT_MAX = 100;
export const paginationQuerySchema = z.object({
  cursor: opaqueCursorSchema.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGE_LIMIT_MAX)
    .default(PAGE_LIMIT_DEFAULT),
});

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    next_cursor: opaqueCursorSchema.nullable(),
  });
}

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
