import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { setupDom } from "@werft-ai/ui/test-support/dom";
import { useKeptFailure } from "./kept-failure.ts";

const { renderHook } = await setupDom();

interface Read {
  readonly error: Error | null;
  readonly errorUpdatedAt: number;
  readonly dataUpdatedAt: number;
}

const FAILED = new Error("failed");
const FAILED_AGAIN = new Error("failed again");

function kept(first: Read, key = "a") {
  return renderHook(
    ({ read, key }: { read: Read; key: string }) => useKeptFailure(read, key),
    { initialProps: { read: first, key } },
  );
}

/** A hook file without the comment lines that open it. */
function body(path: URL): string {
  const lines = readFileSync(path, "utf8").split("\n");
  return lines
    .slice(lines.findIndex((line) => !line.startsWith("//")))
    .join("\n");
}

describe("useKeptFailure", () => {
  // A change to either file runs this test: the web app and packages/react
  // are one CI domain.
  test("packages/react의 같은 훅과 머리 주석 밖의 글자가 같다", () => {
    const web = body(new URL("./kept-failure.ts", import.meta.url));
    const react = body(
      new URL(
        "../../../../packages/react/src/kept-failure.ts",
        import.meta.url,
      ),
    );
    expect(web.length).toBeGreaterThan(0);
    expect(web).toBe(react);
  });

  test("다시 읽는 동안에는 지난 실패를 그대로 준다", () => {
    const hook = kept({ error: FAILED, errorUpdatedAt: 10, dataUpdatedAt: 0 });
    expect(hook.result.current).toBe(FAILED);
    // A refetch clears the query's error but not its time.
    hook.rerender({
      read: { error: null, errorUpdatedAt: 10, dataUpdatedAt: 0 },
      key: "a",
    });
    expect(hook.result.current).toBe(FAILED);
  });

  test("다시 읽기가 답하면 지난 실패를 버린다", () => {
    const hook = kept({ error: FAILED, errorUpdatedAt: 10, dataUpdatedAt: 0 });
    hook.rerender({
      read: { error: null, errorUpdatedAt: 10, dataUpdatedAt: 20 },
      key: "a",
    });
    expect(hook.result.current === null).toBe(true);
  });

  test("다른 것을 읽으면 앞의 것의 실패를 주지 않는다", () => {
    const hook = kept({ error: FAILED, errorUpdatedAt: 10, dataUpdatedAt: 0 });
    // Another session's list, failed once and now read again.
    hook.rerender({
      read: { error: null, errorUpdatedAt: 30, dataUpdatedAt: 0 },
      key: "b",
    });
    expect(hook.result.current === null).toBe(true);
  });

  test("같은 것을 다시 읽어 또 실패하면 새 실패를 붙든다", () => {
    const hook = kept({ error: FAILED, errorUpdatedAt: 10, dataUpdatedAt: 0 });
    hook.rerender({
      read: { error: null, errorUpdatedAt: 10, dataUpdatedAt: 0 },
      key: "a",
    });
    hook.rerender({
      read: { error: FAILED_AGAIN, errorUpdatedAt: 30, dataUpdatedAt: 0 },
      key: "a",
    });
    expect(hook.result.current).toBe(FAILED_AGAIN);
    hook.rerender({
      read: { error: null, errorUpdatedAt: 30, dataUpdatedAt: 0 },
      key: "a",
    });
    expect(hook.result.current).toBe(FAILED_AGAIN);
  });

  test("받은 답이 있어도 그 뒤의 실패를 주고, 다음 답이 오면 버린다", () => {
    const hook = kept({ error: null, errorUpdatedAt: 0, dataUpdatedAt: 5 });
    expect(hook.result.current === null).toBe(true);
    hook.rerender({
      read: { error: FAILED, errorUpdatedAt: 10, dataUpdatedAt: 5 },
      key: "a",
    });
    expect(hook.result.current).toBe(FAILED);
    hook.rerender({
      read: { error: null, errorUpdatedAt: 10, dataUpdatedAt: 5 },
      key: "a",
    });
    expect(hook.result.current).toBe(FAILED);
    hook.rerender({
      read: { error: null, errorUpdatedAt: 10, dataUpdatedAt: 20 },
      key: "a",
    });
    expect(hook.result.current === null).toBe(true);
  });
});
