import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { sqlLiterals } from "./sql-literals.ts";

describe("sqlLiterals", () => {
  test("writes the list as quoted literals, with no parameters", () => {
    const query = new PgDialect().sqlToQuery(
      sql`status IN (${sqlLiterals(["deferred", "it's"])})`,
    );
    expect(query).toEqual({
      sql: "status IN ('deferred', 'it''s')",
      params: [],
    });
  });
});
