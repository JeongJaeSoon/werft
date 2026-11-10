import { describe, expect, test } from "bun:test";
import { appHarness } from "../../test-support/render-app.tsx";

const { act, renderHook } = await appHarness();
const { PLACE_TAB, SETTINGS_SECTIONS, agentSearch, sectionId, useAgentTabs } =
  await import("./navigation.ts");
type Place = Parameters<typeof useAgentTabs>[0];

function setup(initial: Place = { tab: "overview" }) {
  const urls: Place[] = [];
  const hook = renderHook(
    ({ url }: { url: Place }) => useAgentTabs(url, (next) => urls.push(next)),
    { initialProps: { url: initial } },
  );
  return { urls, ...hook };
}

/** A settings section on the page, as the settings tab draws it. */
function mountSections() {
  const sections = SETTINGS_SECTIONS.map((name) => {
    const element = document.createElement("section");
    element.id = sectionId(name);
    element.tabIndex = -1;
    document.body.append(element);
    return element;
  });
  return () => {
    for (const element of sections) element.remove();
  };
}

describe("agentSearch", () => {
  test("keeps a known tab and the created notice, drops the overview and unknown values", () => {
    expect(agentSearch({ tab: "sessions", notice: "created" })).toEqual({
      tab: "sessions",
      notice: "created",
    });
    expect(agentSearch({ tab: "overview" })).toEqual({});
    expect(agentSearch({ tab: "nope", notice: "other" })).toEqual({});
  });

  test("an old tab value opens the settings tab at that section", () => {
    for (const tab of SETTINGS_SECTIONS) {
      expect(agentSearch({ tab })).toEqual({ tab: "settings", section: tab });
    }
  });

  test("a section is kept only on the settings tab", () => {
    expect(agentSearch({ tab: "settings", section: "slack" })).toEqual({
      tab: "settings",
      section: "slack",
    });
    expect(agentSearch({ tab: "settings", section: "nope" })).toEqual({
      tab: "settings",
    });
    expect(agentSearch({ tab: "access", section: "slack" })).toEqual({
      tab: "access",
    });
  });
});

describe("useAgentTabs", () => {
  test("open shows the tab at once and writes the URL once", () => {
    const { result, urls } = setup();
    act(() => result.current.open("access"));
    expect(result.current.tab).toBe("access");
    expect(urls).toEqual([{ tab: "access" }]);
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
    act(() => result.current.open("settings", { current: target }));
    target.blur();
    act(() => result.current.open("overview"));
    act(() => result.current.open("settings"));
    expect(document.activeElement).not.toBe(target);
    target.remove();
  });

  test("a tab shown once stays mounted after leaving it", () => {
    const { result } = setup();
    expect(result.current.hasShown("settings")).toBe(false);
    act(() => result.current.open("settings"));
    act(() => result.current.open("overview"));
    expect(result.current.hasShown("settings")).toBe(true);
    expect(result.current.hasShown("sessions")).toBe(false);
  });

  test("a tab in the first URL counts as shown, and a later URL change moves the tab", () => {
    const { result, rerender } = setup({ tab: "settings" });
    expect(result.current.hasShown("settings")).toBe(true);
    rerender({ url: { tab: "sessions" } });
    expect(result.current.tab).toBe("sessions");
  });

  test("openSection shows the settings tab in the same render and focuses the section", () => {
    const unmount = mountSections();
    const { result, urls } = setup();
    act(() => result.current.openSection("release"));
    expect(result.current.tab).toBe("settings");
    expect(urls).toEqual([{ tab: "settings", section: "release" }]);
    expect(document.activeElement?.id).toBe(sectionId("release"));
    unmount();
  });

  test("the URL echoing an openSection does not move the focus a second time", () => {
    const unmount = mountSections();
    const { result, rerender } = setup();
    act(() => result.current.openSection("release"));
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.focus();
    rerender({ url: { tab: "settings", section: "release" } });
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
    unmount();
  });

  test("a section in the first URL is focused once the page is up", () => {
    const unmount = mountSections();
    setup({ tab: "settings", section: "slack" });
    expect(document.activeElement?.id).toBe(sectionId("slack"));
    unmount();
  });

  test("a later URL that names another section moves the focus there", () => {
    const unmount = mountSections();
    const { rerender } = setup({ tab: "settings", section: "slack" });
    rerender({ url: { tab: "settings", section: "github" } });
    expect(document.activeElement?.id).toBe(sectionId("github"));
    unmount();
  });

  test("opening a tab clears the section, so coming back does not refocus it", () => {
    const unmount = mountSections();
    const { result, urls } = setup({ tab: "settings", section: "admins" });
    act(() => result.current.open("access"));
    expect(urls.at(-1)).toEqual({ tab: "access" });
    document.body.focus();
    act(() => result.current.open("settings"));
    expect(document.activeElement?.id).not.toBe(sectionId("admins"));
    unmount();
  });
});
