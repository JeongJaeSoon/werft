import { type SQL, sql } from "drizzle-orm";

/**
 * An events row's payload with the neutral fields stored beside it
 * (`events.neutral`) that it lacks; jsonb `||` keeps the right side's keys.
 * The mark of an event that came after its turn is the control plane's alone,
 * so there the stored field wins over a key of that name in the payload.
 */
export function eventWithNeutralFields(row: SQL) {
  return sql`CASE WHEN ${row}.neutral IS NULL THEN ${row}.payload
    WHEN ${row}.neutral -> 'after_turn' IS NOT NULL
      THEN ${row}.neutral || ${row}.payload
        || jsonb_build_object('after_turn', ${row}.neutral -> 'after_turn')
    ELSE ${row}.neutral || ${row}.payload END`;
}
