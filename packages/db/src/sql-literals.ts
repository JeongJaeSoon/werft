import { type SQL, sql } from "drizzle-orm";

/**
 * A constant list written into the statement as SQL literals, so it reads
 * as it would spelled out and the planner can match it to a partial index's
 * predicate. Only for lists fixed in code, never for input.
 */
export function sqlLiterals(values: readonly string[]): SQL {
  return sql.raw(
    values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", "),
  );
}
