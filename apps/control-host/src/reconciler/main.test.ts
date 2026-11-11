import { describe, expect, test } from "bun:test";
import { queueDatabaseUrl as reconcilerDatabaseUrl } from "../database-url.ts";

describe("reconcilerDatabaseUrl", () => {
  test("a blank DATABASE_URL does not hide QUEUE_DATABASE_URL", () => {
    expect(
      reconcilerDatabaseUrl({
        DATABASE_URL: "",
        QUEUE_DATABASE_URL: "postgresql://q",
      }),
    ).toBe("postgresql://q");
    expect(() => reconcilerDatabaseUrl({ DATABASE_URL: "" })).toThrow(
      "DATABASE_URL or QUEUE_DATABASE_URL is required",
    );
  });
});
