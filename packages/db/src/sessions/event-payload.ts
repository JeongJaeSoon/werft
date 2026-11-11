import { type SQL, sql } from "drizzle-orm";

/**
 * An events row's payload with the neutral fields stored beside it
 * (`events.neutral`) that it lacks; jsonb `||` keeps the right side's keys.
 */
export function eventWithNeutralFields(row: SQL) {
  return sql`CASE WHEN ${row}.neutral IS NULL THEN ${row}.payload
    ELSE ${row}.neutral || ${row}.payload END`;
}
