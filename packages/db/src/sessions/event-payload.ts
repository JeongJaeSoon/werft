import { type SQL, sql } from "drizzle-orm";

/**
 * An events row's payload with the neutral fields stored beside it
 * (`events.neutral`) that it lacks; jsonb `||` keeps the right side's keys.
 * A payload that is not an object takes none and reads as it is. The mark of
 * an event that came after its turn is the control plane's alone: the stored
 * one is what is read, and a key of that name the payload came with is not.
 */
export function eventWithNeutralFields(row: SQL) {
  return sql`CASE WHEN jsonb_typeof(${row}.payload) <> 'object' THEN ${row}.payload
    WHEN ${row}.neutral IS NULL THEN ${row}.payload - 'after_turn'
    WHEN ${row}.neutral -> 'after_turn' IS NOT NULL
      THEN ${row}.neutral || ${row}.payload
        || jsonb_build_object('after_turn', ${row}.neutral -> 'after_turn')
    ELSE (${row}.neutral || ${row}.payload) - 'after_turn' END`;
}
