import { expect, test } from "bun:test";
import { BUDGET_ROOT_KIND_VALUES, INITIATOR_ROOT_KINDS } from "./budget.ts";

test("every root kind is on exactly one side of the initiator split", () => {
  const sides = [...INITIATOR_ROOT_KINDS.person, ...INITIATOR_ROOT_KINDS.agent];
  expect([...sides].sort()).toEqual([...BUDGET_ROOT_KIND_VALUES].sort());
  expect(new Set(sides).size).toBe(sides.length);
});
