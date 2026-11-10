import { describe, expect, test } from "bun:test";
import type { ProfileSummary } from "@werft-ai/contracts";
import {
  AGENT_ID,
  agentServer,
  seedRelease,
  settingsSection,
} from "../../test-support/fake-agents.ts";
import { apiError, json, me } from "../../test-support/fake-api.ts";
import { version } from "../../test-support/profiles.ts";
import { appHarness } from "../../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const meOk = { "GET /v1/auth/me": () => json(200, me()) };
const DETAIL = `/agents/${AGENT_ID}`;
const LINEAGE = "d970266b-dcf2-405e-abad-46f060d0c4e7";
const COPY_ID = `op_wl_${LINEAGE}_v1`;

/** What the U5 move leaves: a lineage row whose lineage id is a uuid. */
const copy = (name: string | null): ProfileSummary => {
  const base = version(1, "usable", {}, "coding-claude", LINEAGE);
  return {
    ...base,
    installation: {
      ...(base.installation as NonNullable<ProfileSummary["installation"]>),
      name,
    },
  };
};

/** An agent whose active release runs on `profile`, with the list `listed`. */
function agentOn(
  profile: string,
  listed: Response | (() => Response | Promise<Response>),
  releases = [seedRelease(1, { profile })],
) {
  const server = agentServer();
  const active = releases.at(-1);
  const detail = () => {
    const base = server.detail();
    return {
      ...base,
      agent: { ...base.agent, active_release_id: active?.id ?? null },
      releases,
      active_release: active ?? null,
      effective_behavior: {
        applied: {
          runtime_profile_id: profile,
          model: "claude-sonnet-5",
          model_source: "fixed" as const,
          title_model: null,
        },
        draft: null,
      },
    };
  };
  return {
    ...meOk,
    ...server.routes,
    [`GET /v1/agents/${AGENT_ID}`]: () => json(200, detail()),
    "GET /v1/profiles": () =>
      typeof listed === "function" ? listed() : listed.clone(),
  };
}

const listing = (...items: ProfileSummary[]) => json(200, { items });

/** The value beside the "프로필" term in the panel that is open. */
async function profileValue() {
  const panel = await screen.findByRole("tabpanel");
  const term = await within(panel).findByText("프로필", { selector: "dt" });
  return term.nextElementSibling as HTMLElement;
}

describe("에이전트 상세의 프로필 이름", () => {
  test("상세 설정이 계보 id 대신 표시 이름과 버전을 보이고, id는 툴팁에 둔다", async () => {
    renderAt(
      `${DETAIL}?tab=settings&section=card`,
      agentOn(COPY_ID, listing(copy("readonly-review"))),
    );
    const value = await profileValue();
    await waitFor(() => expect(value.textContent).toBe("readonly-review v1"));
    expect(value.querySelector("[title]")?.getAttribute("title")).toBe(COPY_ID);
    expect(screen.queryByText(COPY_ID)).toBeNull();
  });

  test("영어 화면도 같은 이름과 버전을 보인다", async () => {
    renderAt(
      `${DETAIL}?tab=settings&section=card`,
      agentOn(COPY_ID, listing(copy("readonly-review"))),
      "en",
    );
    const panel = await screen.findByRole("tabpanel");
    const term = await within(panel).findByText("Profile", { selector: "dt" });
    await waitFor(() =>
      expect(term.nextElementSibling?.textContent).toBe("readonly-review v1"),
    );
  });

  test("표시 이름이 없는 프로필(옛 데이터)은 지금처럼 id를 보인다", async () => {
    renderAt(
      `${DETAIL}?tab=settings&section=card`,
      agentOn(COPY_ID, listing(copy(null))),
    );
    const value = await profileValue();
    await waitFor(() => expect(value.textContent).toBe(COPY_ID));
  });

  test("프로필 목록을 읽을 수 없는 역할은 id를 보이고 오류 알림은 없다", async () => {
    let refused = 0;
    renderAt(
      `${DETAIL}?tab=settings&section=card`,
      agentOn(COPY_ID, () => {
        refused += 1;
        return apiError(403, "FORBIDDEN", "profile.read is required");
      }),
    );
    const value = await profileValue();
    // The refusal has been answered before the value and the screen are read.
    await waitFor(() => expect(refused).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(value.textContent).toBe(COPY_ID);
    // Slack and GitHub share the tab and answer unmocked routes with alerts.
    expect(within(settingsSection("card")).queryByRole("alert")).toBeNull();
  });

  test("프로필 목록이 아직 오지 않아도 id를 보이고, 이름이 오면 같은 칸이 바뀐다", async () => {
    let answer: (response: Response) => void = () => {};
    const held = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    renderAt(
      `${DETAIL}?tab=settings&section=card`,
      agentOn(COPY_ID, () => held),
    );
    const value = await profileValue();
    expect(value.textContent).toBe(COPY_ID);
    answer(listing(copy("readonly-review")));
    await waitFor(() => expect(value.textContent).toBe("readonly-review v1"));
  });

  test("릴리스 섹션의 되돌리기 버튼 이름이 표시 이름을 쓴다", async () => {
    const older = seedRelease(1, { profile: COPY_ID });
    const newer = seedRelease(2, { profile: COPY_ID });
    renderAt(
      `${DETAIL}?tab=settings&section=release`,
      agentOn(COPY_ID, listing(copy("readonly-review")), [older, newer]),
    );
    const button = await screen.findByRole("button", {
      name: new RegExp(`${older.label}.*readonly-review v1`),
    });
    expect(button.getAttribute("aria-label")).not.toContain(COPY_ID);
  });

  test("릴리스 비교는 계보가 바뀐 프로필을 이름으로 보이고, 목록에 없는 옛 버전은 id로 둔다", async () => {
    const before = seedRelease(1, { profile: "ws_old_v1" });
    const after = seedRelease(2, { profile: COPY_ID });
    const user = await (
      await import("@werft-ai/ui/test-support/dom")
    ).setupUser();
    renderAt(
      `${DETAIL}?tab=settings&section=release`,
      agentOn(COPY_ID, listing(copy("readonly-review")), [before, after]),
    );
    await user.click(await screen.findByRole("button", { name: /바뀐 것/ }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(dialog.textContent).toContain("readonly-review v1"),
    );
    expect(dialog.textContent).toContain("ws_old_v1");
    expect(dialog.textContent).not.toContain(COPY_ID);
  });
});
