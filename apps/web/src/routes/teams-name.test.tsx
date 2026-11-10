import { describe, expect, test } from "bun:test";
import type { MemberView, TeamDetail } from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { teamsEn, teamsJa, teamsKo } from "../i18n/teams.ts";
import {
  json,
  me,
  memberPage,
  RECEIPT_ID,
  USER_ID,
  WORKSPACE_ID,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

// Team names often end in the word "team" themselves (개발팀, Dev team).
// The copy must not add a second one after the name.
const TEAM_ID = "5b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
const MATE_ID = "6c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const AT = "2026-10-11T00:00:00.000Z";
const NAME = "개발팀";
const DOUBLED = /팀\s+팀|\bteam\s+team\b/i;

const mate: MemberView = {
  user_id: MATE_ID,
  email: "mate@example.com",
  display_name: "Mate",
  role: "member",
  disabled_at: null,
  created_at: AT,
};

function server() {
  let team: TeamDetail | null = {
    id: TEAM_ID,
    workspace_id: WORKSPACE_ID,
    name: NAME,
    member_count: 1,
    created_by: USER_ID,
    created_at: AT,
    revision: 1,
    members: [
      {
        user_id: MATE_ID,
        email: mate.email,
        display_name: mate.display_name,
        role: "member",
        added_by: USER_ID,
        added_at: AT,
        disabled_at: null,
      },
    ],
  };
  const view = () => {
    if (!team) throw new Error("deleted");
    const { members: _members, ...rest } = team;
    return { ...rest, member_count: team.members.length };
  };
  const path = `/v1/teams/${TEAM_ID}`;
  return {
    "GET /v1/auth/me": () => json(200, me()),
    "GET /v1/members": () =>
      json(200, memberPage({ items: [mate], next_cursor: null })),
    "GET /v1/teams": () =>
      json(200, { items: team ? [view()] : [], next_cursor: null }),
    "POST /v1/teams": () => json(201, { team: view(), receipt_id: RECEIPT_ID }),
    [`GET ${path}`]: () => json(200, team),
    [`DELETE ${path}`]: () => {
      team = null;
      return json(200, { receipt_id: RECEIPT_ID });
    },
  };
}

async function toastSaid(): Promise<string> {
  const region = await waitFor(() => {
    const found = document.querySelector<HTMLElement>('[data-slot="toast"]');
    expect(found === null).toBe(false);
    return found as HTMLElement;
  });
  await waitFor(() => expect(region.textContent).not.toBe(""));
  return region.textContent ?? "";
}

describe("이름이 '팀'으로 끝나는 팀", () => {
  test("만들었다는 알림에 '팀'이 겹치지 않는다", async () => {
    renderAt("/members/teams", server());
    const user = await setupUser();
    const open = await waitFor(() => {
      const button = screen.getByRole("button", { name: "팀 만들기" });
      expect(button.hasAttribute("disabled")).toBe(false);
      return button;
    });
    await user.click(open);
    const dialog = await screen.findByRole("dialog", { name: "팀 만들기" });
    await user.type(within(dialog).getByLabelText("팀 이름"), `${NAME}{Enter}`);
    const toast = await toastSaid();
    expect(toast).toBe("팀을 만들었습니다: 개발팀");
    expect(toast).not.toMatch(DOUBLED);
  });

  test("구성원 제외·팀 삭제 확인과 삭제 알림에 '팀'이 겹치지 않는다", async () => {
    renderAt(`/members/teams/${TEAM_ID}`, server());
    const user = await setupUser();

    await user.click(
      await screen.findByRole("button", { name: "Mate님을 팀에서 제외" }),
    );
    const removeDialog = await screen.findByRole("dialog");
    expect(removeDialog.textContent).toContain(
      "Mate님을 다음 팀에서 제외할까요? 개발팀",
    );
    expect(removeDialog.textContent).not.toMatch(DOUBLED);
    await user.click(
      within(removeDialog).getByRole("button", { name: "취소" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const danger = screen.getByRole("region", { name: "위험 구역" });
    await user.click(within(danger).getByRole("button", { name: "팀 삭제" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("다음 팀을 삭제할까요? 개발팀");
    expect(dialog.textContent).not.toMatch(DOUBLED);
    await user.click(within(dialog).getByRole("button", { name: "팀 삭제" }));
    const toast = await toastSaid();
    expect(toast).toBe("팀을 삭제했습니다: 개발팀");
    expect(toast).not.toMatch(DOUBLED);
  });

  test("어느 언어의 팀 문구도 이름 뒤에 '팀'을 다시 붙이지 않는다", () => {
    const names = { ko: "개발팀", en: "Dev team", ja: "開発チーム" };
    const catalogs = { ko: teamsKo, en: teamsEn, ja: teamsJa };
    const doubled: string[] = [];
    for (const [locale, catalog] of Object.entries(catalogs)) {
      const name = names[locale as keyof typeof names];
      for (const [key, text] of Object.entries(catalog)) {
        const out = text.replace(/\{(name|team)\}/g, name);
        if (DOUBLED.test(out) || /チーム\s*チーム/.test(out))
          doubled.push(`${locale} ${key}: ${out}`);
      }
    }
    expect(doubled).toEqual([]);
  });
});
