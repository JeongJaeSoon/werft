import { describe, expect, test } from "bun:test";
import { appHarness } from "../../test-support/render-app.tsx";

const { act, renderHook } = await appHarness();
const { PLACE_TAB, agentSearch, useAgentTabs } = await import(
  "./navigation.ts"
);
type Tab = Parameters<ReturnType<typeof useAgentTabs>["open"]>[0];

function setup(initial: Tab = "overview") {
  const urls: Tab[] = [];
  const hook = renderHook(
    ({ url }: { url: Tab }) => useAgentTabs(url, (next) => urls.push(next)),
    { initialProps: { url: initial } },
  );
  return { urls, ...hook };
}

describe("agentSearch", () => {
  test("keeps a known tab and the created notice, drops the overview and unknown values", () => {
    expect(agentSearch({ tab: "release", notice: "created" })).toEqual({
      tab: "release",
      notice: "created",
    });
    expect(agentSearch({ tab: "overview" })).toEqual({});
    expect(agentSearch({ tab: "nope", notice: "other" })).toEqual({});
  });

  test("an old tab value is still a tab", () => {
    for (const tab of [
      "card",
      "release",
      "admins",
      "slack",
      "github",
    ] as const) {
      expect(agentSearch({ tab })).toEqual({ tab });
    }
  });
});

describe("useAgentTabs", () => {
  test("open shows the tab at once and writes the URL once", () => {
    const { result, urls } = setup();
    act(() => result.current.open("access"));
    expect(result.current.tab).toBe("access");
    expect(urls).toEqual(["access"]);
  });

  test("a result placed in a section opens the tab that holds it, and a page-level one opens none", () => {
    const { result, urls } = setup();
    act(() => result.current.openPlace("page"));
    expect(result.current.tab).toBe("overview");
    expect(urls).toEqual([]);
    for (const [at, tab] of Object.entries(PLACE_TAB)) {
      if (!tab) continue;
      act(() => result.current.openPlace(at as keyof typeof PLACE_TAB));
      expect(result.current.tab).toBe(tab);
    }
  });

  test("focus goes to the target only once its tab is showing", () => {
    const { result } = setup();
    const target = document.createElement("button");
    document.body.append(target);
    act(() => result.current.open("access", { current: target }));
    expect(document.activeElement).toBe(target);
    target.remove();
  });

  test("a landing is spent by the open that asked for it", () => {
    const { result } = setup();
    const target = document.createElement("button");
    document.body.append(target);
    act(() => result.current.open("release", { current: target }));
    target.blur();
    act(() => result.current.open("overview"));
    act(() => result.current.open("release"));
    expect(document.activeElement).not.toBe(target);
    target.remove();
  });

  test("a tab shown once stays mounted after leaving it", () => {
    const { result } = setup();
    expect(result.current.hasShown("slack")).toBe(false);
    act(() => result.current.open("slack"));
    act(() => result.current.open("overview"));
    expect(result.current.hasShown("slack")).toBe(true);
    expect(result.current.hasShown("github")).toBe(false);
  });

  test("a tab in the first URL counts as shown, and a later URL change moves the tab", () => {
    const { result, rerender } = setup("github");
    expect(result.current.hasShown("github")).toBe(true);
    rerender({ url: "admins" });
    expect(result.current.tab).toBe("admins");
  });
});
