import { describe, expect, test } from "bun:test";
import { appHarness } from "../test-support/render-app.tsx";
import { useKeptFailure } from "./kept-failure.ts";

const { renderHook } = await appHarness();

interface Read {
  readonly error: Error | null;
  readonly errorUpdatedAt: number;
  readonly dataUpdatedAt: number;
}

const FAILED = new Error("failed");

function kept(first: Read, key = "refusals:a") {
  return renderHook(
    ({ read, key }: { read: Read; key: string }) => useKeptFailure(read, key),
    { initialProps: { read: first, key } },
  );
}

describe("useKeptFailure", () => {
  test("다시 읽는 동안에는 지난 실패를 그대로 준다", () => {
    const hook = kept({ error: FAILED, errorUpdatedAt: 10, dataUpdatedAt: 0 });
    expect(hook.result.current).toBe(FAILED);
    // A refetch clears the query's error but not its time.
    hook.rerender({
      read: { error: null, errorUpdatedAt: 10, dataUpdatedAt: 0 },
      key: "refusals:a",
    });
    expect(hook.result.current).toBe(FAILED);
  });

  test("다시 읽기가 답하면 지난 실패를 버린다", () => {
    const hook = kept({ error: FAILED, errorUpdatedAt: 10, dataUpdatedAt: 0 });
    hook.rerender({
      read: { error: null, errorUpdatedAt: 10, dataUpdatedAt: 20 },
      key: "refusals:a",
    });
    expect(hook.result.current).toBeNull();
  });

  test("다른 것을 읽으면 앞의 것의 실패를 주지 않는다", () => {
    const hook = kept({ error: FAILED, errorUpdatedAt: 10, dataUpdatedAt: 0 });
    // Another session's refusals, failed once and now read again.
    hook.rerender({
      read: { error: null, errorUpdatedAt: 30, dataUpdatedAt: 0 },
      key: "refusals:b",
    });
    expect(hook.result.current).toBeNull();
  });
});
