import { describe, expect, test } from "bun:test";
import type { ProfileSummary } from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { apiError, json, me, memberMe } from "../test-support/fake-api.ts";
import { ceiling, imported, version } from "../test-support/profiles.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const CODING = imported("coding-claude");
const GENERAL = imported("general-read", {
  model: "claude-haiku-5",
  models: ["claude-haiku-5"],
  tools: [],
  permission_mode: "default",
  // No catalog lists it, so the listing has no deny for it.
  runtime_version: "0.3.100",
  billing: "none",
  repository_mode: "none",
  repository_ids: [],
});

const rows = (table: HTMLElement) =>
  within(table)
    .getAllByRole("row")
    .map((row) =>
      Array.from(
        row.querySelectorAll('[role="cell"], [role="columnheader"]'),
        (cell) => cell.textContent,
      ),
    );

const NO_CONNECTIONS = {
  "GET /v1/installation/settings/connections": () =>
    json(200, { items: [], credential_hosts: null, endpoint_defaults: {} }),
};

function routes(items: ProfileSummary[], signedIn = me()) {
  return {
    "GET /v1/auth/me": () => json(200, signedIn),
    "GET /v1/profiles": () => json(200, { items }),
    ...NO_CONNECTIONS,
  };
}

const HEADER = [
  "이름",
  "버전",
  "바탕 프로필",
  "기본 모델",
  "권한 모드",
  "차단",
  "상태",
];

describe("프로필", () => {
  test("lists every profile in one table from the sidebar, with no kind or scope", async () => {
    const { api } = renderAt(
      "/",
      routes([version(1, "usable"), CODING, GENERAL]),
    );
    const nav = await screen.findByRole("navigation", { name: "주요 메뉴" });
    const user = await setupUser();
    await user.click(await within(nav).findByRole("link", { name: "프로필" }));
    await screen.findByRole("heading", { level: 1, name: "프로필" });
    expect(
      within(nav)
        .getByRole("link", { name: "프로필" })
        .getAttribute("aria-current"),
    ).toBe("page");
    const table = await screen.findByRole("table", { name: "프로필" });
    // Each name cell ends in the line a phone shows instead of the columns
    // it drops. A profile without a name shows its id once.
    expect(rows(table)).toEqual([
      HEADER,
      [
        "coding-claudev1",
        "v1",
        "—",
        "claude-sonnet-5",
        "acceptEdits",
        "3개",
        "사용 가능",
      ],
      [
        "general-readv1",
        "v1",
        "—",
        "claude-haiku-5",
        "default",
        // A version no catalog lists has no block count.
        "—",
        "사용 가능",
      ],
      [
        "strictop_wl_strict_v1v1",
        "v1",
        "coding-claude",
        "claude-sonnet-5",
        "default",
        "5개",
        "사용 가능",
      ],
    ]);
    // No cell truncates (GridTableCell `lines` cuts every line after the first).
    expect(table.querySelector("[data-lines], .truncate")).toBeNull();
    expect(screen.queryAllByText(/다시 배포|deploy again/).length).toBe(0);
    expect(api.calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  test("one create link opens the one form", async () => {
    const { history } = renderAt("/profiles", routes([CODING]));
    const user = await setupUser();
    await screen.findByRole("link", { name: "프로필 만들기" });
    expect(
      screen
        .queryAllByRole("link", { name: /만들기/ })
        .map((a) => a.textContent),
    ).toEqual(["프로필 만들기"]);
    await user.click(screen.getByRole("link", { name: "프로필 만들기" }));
    await screen.findByRole("heading", {
      level: 1,
      name: "프로필 만들기",
    });
    expect(history.location.pathname).toBe("/profiles/new");
    expect(history.location.search).toBe("");
  });

  test("an admin gets the same single create link", async () => {
    renderAt("/profiles", routes([CODING], me(undefined, "admin")));
    await screen.findByRole("link", { name: "프로필 만들기" });
    expect(screen.queryAllByRole("link", { name: /만들기/ }).length).toBe(1);
  });

  test("a member reads every profile but gets no way to change them", async () => {
    renderAt("/profiles", routes([CODING, version(1, "usable")], memberMe()));
    await screen.findByRole("table", { name: "프로필" });
    expect(
      screen.getByText("바꾸려면 워크스페이스 소유자나 관리자에게 요청하세요"),
    ).toBeDefined();
    expect(screen.queryAllByRole("link", { name: /만들기/ }).length).toBe(0);
  });

  test("one list without a kind filter or column", async () => {
    renderAt("/profiles", routes([CODING, GENERAL, version(1, "usable")]));
    const table = await screen.findByRole("table", { name: "프로필" });
    expect(screen.queryAllByRole("group", { name: "프로필 종류" }).length).toBe(
      0,
    );
    expect(
      within(table).queryAllByText(/설치 프로필|워크스페이스 프로필/),
    ).toEqual([]);
  });

  test("a name with several versions shows its latest, the earlier ones folded under it", async () => {
    renderAt(
      "/profiles",
      routes([
        ceiling("wide", 1, {}, { state: "retired" }),
        ceiling("wide", 2),
        version(1, "retired"),
        version(2, "usable"),
      ]),
    );
    const table = await screen.findByRole("table", { name: "프로필" });
    expect(
      rows(table)
        .slice(1)
        .map((row) => [row[0], row[6]]),
    ).toEqual([
      ["strict 이전 버전 1개op_wl_strict_v2v2", "사용 가능"],
      ["wide 이전 버전 1개op_wide_v2v2", "사용 가능"],
    ]);
    const user = await setupUser();
    const [, first] = within(table).getAllByRole("button", {
      name: "이전 버전 1개",
    });
    expect(first?.getAttribute("aria-expanded")).toBe("false");
    await user.click(first as HTMLElement);
    expect(first?.getAttribute("aria-expanded")).toBe("true");
    expect(
      rows(table)
        .slice(1)
        .map((row) => [row[0], row[6]]),
    ).toEqual([
      ["strict 이전 버전 1개op_wl_strict_v2v2", "사용 가능"],
      ["wide 이전 버전 1개op_wide_v2v2", "사용 가능"],
      ["wideop_wide_v1v1", "사용 중지됨"],
    ]);
    await user.click(first as HTMLElement);
    expect(rows(table)).toHaveLength(3);
  });

  test("a ceiling folds under the version that names it as previous, not under a name it shares", async () => {
    renderAt(
      "/profiles",
      routes([
        // A catalog import whose id is a console ceiling's name, unlinked.
        imported("wide", {}, "retired"),
        ceiling("wide", 1),
        // The import's next version took a name of its own.
        ceiling("coding", 1, {}, { previous_id: "coding-claude" }),
        CODING,
      ]),
    );
    const table = await screen.findByRole("table", { name: "프로필" });
    expect(
      rows(table)
        .slice(1)
        .map((row) => row[0]),
    ).toEqual([
      "coding 이전 버전 1개op_coding_v1v1",
      "wideop_wide_v1v1",
      "widev1",
    ]);
  });

  test("every state a profile can be in shows as its badge", async () => {
    renderAt(
      "/profiles",
      routes([
        imported("a-gone", {}, "connection_missing"),
        imported(
          "b-bypass",
          { permission_mode: "bypassPermissions" },
          "unattended_off",
        ),
        imported("c-drift", {}, "definition_drift"),
        imported("d-codex", {}, "runtime_unsupported"),
        imported("e-old", {}, "retired"),
        imported("f-stop", {}, "blocked"),
      ]),
    );
    const table = await screen.findByRole("table", { name: "프로필" });
    const badges = Array.from(
      table.querySelectorAll("[data-slot=badge]"),
      (badge) => [
        badge.textContent,
        badge.className.match(/--werft-tone-(\w+)-bg/)?.[1],
      ],
    );
    expect(badges).toEqual([
      ["연결 없음", "danger"],
      ["이 설치에서 꺼짐", "danger"],
      ["설정이 바뀜", "danger"],
      ["지원하지 않는 런타임", "danger"],
      ["사용 중지됨", "neutral"],
      ["차단됨", "danger"],
    ]);
  });

  test("a workspace profile lists as one more row and nothing warns about its base", async () => {
    renderAt("/profiles", routes([CODING, version(1, "usable")]));
    await screen.findByRole("table", { name: "프로필" });
    expect(screen.queryAllByText(/바탕 프로필이 (바뀌었|없어졌)/).length).toBe(
      0,
    );
  });

  test("a failed read says so and asks again", async () => {
    let failing = true;
    renderAt("/profiles", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/profiles": () =>
        failing
          ? apiError(500, "INTERNAL", "boom")
          : json(200, { items: [CODING] }),
      ...NO_CONNECTIONS,
    });
    const retry = await screen.findByRole("button", { name: "다시 시도" });
    failing = false;
    retry.click();
    await screen.findByRole("table", { name: "프로필" });
  });

  test("an installation without profiles says so; an owner can still make the first one", async () => {
    renderAt("/profiles", routes([]));
    await screen.findByText("이 설치에 프로필이 없습니다.");
    expect(screen.queryAllByRole("table", { name: "프로필" }).length).toBe(0);
    // An owner can still make the first profile.
    expect(screen.getByRole("link", { name: "프로필 만들기" })).toBeDefined();
  });

  test("a profile that runs nowhere here leaves an admin nothing to clone", async () => {
    renderAt(
      "/profiles",
      routes(
        [imported("coding-claude", {}, "connection_missing")],
        me(undefined, "admin"),
      ),
    );
    await screen.findByRole("table", { name: "프로필" });
    await waitFor(() =>
      expect(
        screen.queryAllByRole("link", { name: "프로필 만들기" }).length,
      ).toBe(0),
    );
  });
});
