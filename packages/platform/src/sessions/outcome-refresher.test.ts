import { describe, expect, test } from "bun:test";
import { createOutcomeRefresher } from "./outcome-refresher.ts";
import type { SessionOutcomeStore } from "./ports/session-outcomes.ts";

function refresher(closeOnPullRequests: (limit: number) => Promise<number>) {
  const warned: string[] = [];
  const store = {
    fillMissing: async () => 0,
    dueRepositories: async () => [],
  } as unknown as SessionOutcomeStore;
  const unit = createOutcomeRefresher({
    store,
    tasks: { closeOnPullRequests },
    gate: {} as never,
    catalog: { connections: {}, repositories: {} },
    connections: () => null,
    logger: { info() {}, warn: (message) => warned.push(message) },
  });
  return { unit, warned };
}

describe("the outcome refresher's task closes", () => {
  test("each pass closes the tasks whose pull requests settled, a bounded batch", async () => {
    const limits: number[] = [];
    const { unit } = refresher(async (limit) => {
      limits.push(limit);
      return 1;
    });
    await unit.runOnce();
    await unit.runOnce();
    expect(limits).toEqual([100, 100]);
  });

  test("a failed close leaves the pass standing and is tried on the next", async () => {
    let calls = 0;
    const { unit, warned } = refresher(async () => {
      calls += 1;
      throw new Error("db down");
    });
    await unit.runOnce();
    await unit.runOnce();
    expect(calls).toBe(2);
    expect(warned).toEqual([
      "Closing tasks on their pull requests failed",
      "Closing tasks on their pull requests failed",
    ]);
  });
});
