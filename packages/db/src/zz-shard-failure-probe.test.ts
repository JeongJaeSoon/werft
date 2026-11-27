import { expect, test } from "bun:test";

// Deliberate failure: one shard of integration (db) must fail the gate.
test("shard failure probe", () => {
  expect(1).toBe(2);
});
