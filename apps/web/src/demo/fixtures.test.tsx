import { describe, expect, test } from "bun:test";
import { json } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";
import fixtures from "./fixtures.json";

const { renderAt, screen, within } = await appHarness();

// The placeholder demo signs in as an owner; the sidebar shows 구성원 only
// for member.manage, and its 팀 tab lists teams only for team.manage.
describe("데모 자리표시 픽스처", () => {
  test("로그인 응답만으로 구성원 메뉴와 구성원·팀 탭이 보인다", async () => {
    const answer = fixtures.responses["/v1/auth/me"].json;
    renderAt("/members", { "GET /v1/auth/me": () => json(200, answer) });
    const nav = await screen.findByRole("navigation", { name: "주요 메뉴" });
    expect(
      await within(nav).findByRole("link", { name: "구성원" }),
    ).toBeDefined();
    const tabs = await screen.findByRole("navigation", { name: "구성원 보기" });
    expect(within(tabs).getByRole("link", { name: "구성원" })).toBeDefined();
    expect(within(tabs).getByRole("link", { name: "팀" })).toBeDefined();
  });
});
