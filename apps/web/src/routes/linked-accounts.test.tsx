import { describe, expect, test } from "bun:test";
import {
  LINK_MESSAGES,
  type LinkedAccount,
  linkedAccountSchema,
} from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import {
  apiError,
  GITHUB_SETTINGS,
  githubSettings,
  json,
  keys,
  me,
  RECEIPT_ID,
  USER_ID,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

// The GitHub row says "연결 안 됨" too; these look at Slack's alone.
const slackRow = () =>
  screen.getByRole("heading", { name: "Slack" }).closest("li") as HTMLElement;
const slackNotLinked = () =>
  waitFor(() =>
    expect(within(slackRow()).getByText("연결 안 됨")).toBeTruthy(),
  );

const LINK_ID = "4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b";
const AUTHORIZE = "http://mock-slack.test/openid/connect/authorize?state=s1";
const slack: LinkedAccount = {
  id: LINK_ID,
  user_id: USER_ID,
  provider: "slack",
  external_tenant: "T0MOCK",
  external_user_id: "U0MOCK",
  external_tenant_name: null,
  external_user_name: null,
  status: "active",
  verified_at: "2026-10-11T00:00:00.000Z",
  revision: 1,
  expires_at: null,
};
const meOk = { "GET /v1/auth/me": () => json(200, me()) };

/** Presses the focused 연결 해제 and confirms in the dialog it opens. */
async function unlinkFocused(user: Awaited<ReturnType<typeof setupUser>>) {
  await user.keyboard("{Enter}");
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: "연결 해제" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

describe("연동 계정", () => {
  test("픽스처는 서버가 보낼 수 있는 모양이다", () => {
    expect(linkedAccountSchema.safeParse(slack).success).toBe(true);
  });

  test("GitHub·Slack·Google Workspace 줄은 각 서비스의 마크를 보인다", async () => {
    renderAt("/settings/linked-accounts", {
      ...meOk,
      "GET /v1/linked-accounts": () => json(200, { items: [] }),
    });
    const github = await screen.findByRole("heading", { name: "GitHub" });
    const mark = (heading: HTMLElement) =>
      heading.closest("li")?.querySelector("[aria-hidden='true']");
    const githubMark = mark(github);
    // simple-icons 16.36.0 icons/github.svg, unmodified.
    expect(githubMark?.querySelector("svg")?.getAttribute("viewBox")).toBe(
      "0 0 24 24",
    );
    expect(
      githubMark?.querySelector("path")?.getAttribute("d")?.slice(0, 32),
    ).toBe("M12 .297c-6.63 0-12 5.373-12 12 ");
    expect(githubMark?.textContent).toBe("");
    // The mark is decoration: the row is named by its heading alone.
    expect(screen.getAllByText("GitHub").length).toBe(1);
    // Each service's own mark in its own colours (brand-marks.tsx sources).
    const marks: [string, string, string[]][] = [
      ["Slack", "0 0 54 54", ["#E3066A", "#00B3FF", "#41B658", "#FCC003"]],
      [
        "Google Workspace",
        "8 6 176 176",
        ["#EA4335", "#188038", "#1967D2", "#FBBC04", "#4285F4", "#34A853"],
      ],
    ];
    for (const [name, viewBox, fills] of marks) {
      const icon = mark(screen.getByRole("heading", { name }));
      expect(icon?.querySelector("svg")?.getAttribute("viewBox")).toBe(viewBox);
      expect(
        Array.from(icon?.querySelectorAll("path") ?? [], (path) =>
          path.getAttribute("fill"),
        ).filter((fill, index, all) => all.indexOf(fill) === index),
      ).toEqual(fills);
      expect(icon?.textContent).toBe("");
      expect(screen.getAllByText(name).length).toBe(1);
    }
  });

  test("연결이 없으면 연결 버튼이 Slack 동의 화면으로 보낸다", async () => {
    const { api, left } = renderAt("/settings/linked-accounts", {
      ...meOk,
      "GET /v1/linked-accounts": () => json(200, { items: [] }),
      "POST /v1/linked-accounts/slack/start": () =>
        json(200, {
          authorize_url: AUTHORIZE,
          expires_at: "2026-10-11T00:10:00.000Z",
        }),
    });
    await slackNotLinked();
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "Slack 계정 연결" }));
    await waitFor(() => expect(left).toEqual([AUTHORIZE]));
    expect(
      api.calls.some((c) => c.path === "/v1/linked-accounts/slack/start"),
    ).toBe(true);
  });

  test("설치가 없다는 거절은 서버의 안내 문구 그대로다", async () => {
    renderAt("/settings/linked-accounts", {
      ...meOk,
      "GET /v1/linked-accounts": () => json(200, { items: [] }),
      "POST /v1/linked-accounts/slack/start": () =>
        apiError(409, "SLACK_NOT_INSTALLED", LINK_MESSAGES.notInstalled),
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "Slack 계정 연결" }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      LINK_MESSAGES.notInstalled,
    );
  });

  test("연결된 계정을 보이고 해제한다", async () => {
    let items = [slack];
    const { api } = renderAt("/settings/linked-accounts", {
      ...meOk,
      "GET /v1/linked-accounts": () => json(200, { items }),
      [`DELETE /v1/linked-accounts/${LINK_ID}`]: () => {
        items = [{ ...slack, status: "revoked" }];
        return json(200, {
          receipt_id: RECEIPT_ID,
          receipt_status: "succeeded",
        });
      },
    });
    expect(
      await screen.findByText("Slack 사용자 U0MOCK (워크스페이스 T0MOCK)"),
    ).toBeDefined();
    // A linked row offers unlinking only.
    expect(
      screen.queryByRole("button", { name: "Slack 계정 연결" }),
    ).toBeNull();
    // The notice line is there, empty, before anything is announced on it.
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("");
    const user = await setupUser();
    screen.getByRole("button", { name: "연결 해제" }).focus();
    // Cancelling the dialog sends nothing and gives focus back.
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", {
      name: "Slack 계정 연결을 해제할까요?",
    });
    expect(
      within(dialog).getByText("Slack 사용자 U0MOCK (워크스페이스 T0MOCK)"),
    ).toBeDefined();
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() =>
      expect(
        document.activeElement ===
          screen.getByRole("button", { name: "연결 해제" }),
      ).toBe(true),
    );
    expect(api.calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    await unlinkFocused(user);
    await slackNotLinked();
    expect(screen.getByRole("status")).toBe(status);
    expect(status.textContent).toBe("Slack 계정 연결을 해제했습니다.");
    // No row is left, so focus goes to the list's heading.
    await waitFor(() =>
      expect(
        document.activeElement ===
          screen.getByRole("heading", { name: "Slack" }),
      ).toBe(true),
    );
  });

  test("연결 버튼에 있던 포커스는 다른 탭의 연결로 버튼이 사라지면 새 행의 해제 버튼으로 간다", async () => {
    let items: LinkedAccount[] = [];
    const { services } = renderAt("/settings/linked-accounts", {
      ...meOk,
      "GET /v1/linked-accounts": () => json(200, { items }),
    });
    const start = await screen.findByRole("button", {
      name: "Slack 계정 연결",
    });
    start.focus();
    items = [slack];
    await services.queryClient.invalidateQueries({
      queryKey: keys.linkedAccounts,
    });
    await waitFor(() =>
      expect(
        document.activeElement ===
          screen.getByRole("button", { name: "연결 해제" }),
      ).toBe(true),
    );
    expect(
      screen.queryByRole("button", { name: "Slack 계정 연결" }),
    ).toBeNull();
  });

  test("Slack이 준 이름을 보이고 ID는 그 아래에 둔다", async () => {
    renderAt("/settings/linked-accounts", {
      ...meOk,
      "GET /v1/linked-accounts": () =>
        json(200, {
          items: [
            {
              ...slack,
              external_tenant_name: "94soon-dev",
              external_user_name: "재순",
            },
          ],
        }),
    });
    expect(await screen.findByText("재순 · 94soon-dev")).toBeDefined();
    expect(
      screen.getByText("사용자 ID U0MOCK · 워크스페이스 ID T0MOCK"),
    ).toBeDefined();
    expect(screen.queryByText(/Slack 사용자 U0MOCK/)).toBeNull();
  });

  test("이름 하나만 있으면 빠진 쪽은 ID로 보인다", async () => {
    renderAt("/settings/linked-accounts", {
      ...meOk,
      "GET /v1/linked-accounts": () =>
        json(200, { items: [{ ...slack, external_user_name: "재순" }] }),
    });
    expect(await screen.findByText("재순 · T0MOCK")).toBeDefined();
  });

  const OTHER_ID = "5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c";
  const other: LinkedAccount = {
    ...slack,
    id: OTHER_ID,
    external_tenant: "T0OTHER",
    external_user_id: "U0OTHER",
  };

  function twoLinks() {
    let items = [slack, other];
    return {
      ...meOk,
      "GET /v1/linked-accounts": () => json(200, { items }),
      [`DELETE /v1/linked-accounts/${LINK_ID}`]: () => {
        items = items.map((a) =>
          a.id === LINK_ID ? { ...a, status: "revoked" as const } : a,
        );
        return json(200, {
          receipt_id: RECEIPT_ID,
          receipt_status: "succeeded",
        });
      },
      [`DELETE /v1/linked-accounts/${OTHER_ID}`]: () => {
        items = items.map((a) =>
          a.id === other.id ? { ...a, status: "revoked" as const } : a,
        );
        return json(200, {
          receipt_id: RECEIPT_ID,
          receipt_status: "succeeded",
        });
      },
    };
  }

  test("해제한 행 자리에 온 다음 행의 해제 버튼으로 포커스가 간다", async () => {
    renderAt("/settings/linked-accounts", twoLinks());
    await screen.findByText("Slack 사용자 U0OTHER (워크스페이스 T0OTHER)");
    const user = await setupUser();
    screen.getAllByRole("button", { name: "연결 해제" })[0]?.focus();
    await unlinkFocused(user);
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "연결 해제" }).length).toBe(
        1,
      ),
    );
    await waitFor(() =>
      expect(
        document.activeElement ===
          screen.getByRole("button", { name: "연결 해제" }),
      ).toBe(true),
    );
    expect(
      document.activeElement?.closest("li")?.textContent?.includes("U0OTHER"),
    ).toBe(true);
  });

  test("마지막 행을 해제하면 바로 위 행의 해제 버튼으로 포커스가 간다", async () => {
    renderAt("/settings/linked-accounts", twoLinks());
    await screen.findByText("Slack 사용자 U0OTHER (워크스페이스 T0OTHER)");
    const user = await setupUser();
    screen.getAllByRole("button", { name: "연결 해제" })[1]?.focus();
    await unlinkFocused(user);
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "연결 해제" }).length).toBe(
        1,
      ),
    );
    await waitFor(() =>
      expect(
        document.activeElement?.closest("li")?.textContent?.includes("U0MOCK"),
      ).toBe(true),
    );
  });

  /** Two links whose first unlink is applied at once and answered on release. */
  function heldUnlink() {
    const routes = twoLinks();
    const remove = routes[`DELETE /v1/linked-accounts/${LINK_ID}`];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      release,
      routes: {
        ...routes,
        [`DELETE /v1/linked-accounts/${LINK_ID}`]: async () => {
          const response = remove();
          await gate;
          return response;
        },
      },
    };
  }

  test("위 행과 함께 해제한 마지막 행에서는 그 사이 남은 행으로 간다", async () => {
    const THIRD_ID = "6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d";
    const third: LinkedAccount = {
      ...slack,
      id: THIRD_ID,
      external_tenant: "T0THIRD",
      external_user_id: "U0THIRD",
    };
    let items = [slack, other, third];
    const gates: Record<string, () => void> = {};
    const held = (id: string) => async () => {
      items = items.map((a) =>
        a.id === id ? { ...a, status: "revoked" as const } : a,
      );
      await new Promise<void>((resolve) => {
        gates[id] = resolve;
      });
      return json(200, { receipt_id: RECEIPT_ID, receipt_status: "succeeded" });
    };
    renderAt("/settings/linked-accounts", {
      ...meOk,
      "GET /v1/linked-accounts": () => json(200, { items }),
      [`DELETE /v1/linked-accounts/${LINK_ID}`]: held(LINK_ID),
      [`DELETE /v1/linked-accounts/${THIRD_ID}`]: held(THIRD_ID),
    });
    await screen.findByText("Slack 사용자 U0THIRD (워크스페이스 T0THIRD)");
    const user = await setupUser();
    screen.getAllByRole("button", { name: "연결 해제" })[0]?.focus();
    await unlinkFocused(user);
    screen.getAllByRole("button", { name: "연결 해제" })[2]?.focus();
    await unlinkFocused(user);
    await waitFor(() => expect(Object.keys(gates).length).toBe(2));
    // The first answer's reread already lacks both rows.
    gates[LINK_ID]?.();
    gates[THIRD_ID]?.();
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "연결 해제" }).length).toBe(
        1,
      ),
    );
    await waitFor(() =>
      expect(
        document.activeElement?.closest("li")?.textContent?.includes("U0OTHER"),
      ).toBe(true),
    );
  });

  test("포커스를 넘겨받은 행도 해제 중이었다면 그 행이 빠질 때 다시 옮긴다", async () => {
    let items = [slack, other];
    const revoke = (id: string) => {
      items = items.map((a) =>
        a.id === id ? { ...a, status: "revoked" as const } : a,
      );
    };
    const ok = () =>
      json(200, { receipt_id: RECEIPT_ID, receipt_status: "succeeded" });
    let releaseFirst: () => void = () => {};
    let releaseOther: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const otherGate = new Promise<void>((resolve) => {
      releaseOther = resolve;
    });
    renderAt("/settings/linked-accounts", {
      ...meOk,
      "GET /v1/linked-accounts": () => json(200, { items }),
      // Applied only when answered, so the other row leaves first.
      [`DELETE /v1/linked-accounts/${LINK_ID}`]: async () => {
        await firstGate;
        revoke(LINK_ID);
        return ok();
      },
      [`DELETE /v1/linked-accounts/${OTHER_ID}`]: async () => {
        await otherGate;
        revoke(OTHER_ID);
        return ok();
      },
    });
    await screen.findByText("Slack 사용자 U0OTHER (워크스페이스 T0OTHER)");
    const user = await setupUser();
    screen.getAllByRole("button", { name: "연결 해제" })[0]?.focus();
    await unlinkFocused(user);
    await user.tab();
    await unlinkFocused(user);
    releaseOther();
    await waitFor(() =>
      expect(
        document.activeElement?.closest("li")?.textContent?.includes("U0MOCK"),
      ).toBe(true),
    );
    releaseFirst();
    await slackNotLinked();
    await waitFor(() =>
      expect(
        document.activeElement ===
          screen.getByRole("heading", { name: "Slack" }),
      ).toBe(true),
    );
  });

  test("해제 뒤 목록을 다시 읽지 못해 목록이 사라지면 제목으로 간다", async () => {
    let reads = 0;
    renderAt("/settings/linked-accounts", {
      ...twoLinks(),
      "GET /v1/linked-accounts": () =>
        ++reads === 1
          ? json(200, { items: [slack, other] })
          : apiError(500, "INTERNAL", "boom"),
    });
    await screen.findByText("Slack 사용자 U0OTHER (워크스페이스 T0OTHER)");
    const user = await setupUser();
    screen.getAllByRole("button", { name: "연결 해제" })[0]?.focus();
    await unlinkFocused(user);
    expect(
      await screen.findByRole("button", { name: "다시 시도" }),
    ).toBeDefined();
    await waitFor(() =>
      expect(
        document.activeElement ===
          screen.getByRole("heading", { name: "Slack" }),
      ).toBe(true),
    );
  });

  test("해제를 기다리는 동안 같은 버튼을 다시 눌러도 다음 행으로 간다", async () => {
    const { release, routes } = heldUnlink();
    const { api } = renderAt("/settings/linked-accounts", routes);
    await screen.findByText("Slack 사용자 U0OTHER (워크스페이스 T0OTHER)");
    const user = await setupUser();
    const first = screen.getAllByRole("button", { name: "연결 해제" })[0];
    first?.focus();
    await unlinkFocused(user);
    if (first) await user.click(first);
    release();
    await waitFor(() =>
      expect(
        document.activeElement?.closest("li")?.textContent?.includes("U0OTHER"),
      ).toBe(true),
    );
    expect(
      api.calls.filter((c) => c.path === `/v1/linked-accounts/${LINK_ID}`)
        .length,
    ).toBe(1);
  });

  test("해제를 기다리는 동안 다른 곳을 누른 사람의 포커스는 옮기지 않는다", async () => {
    const { release, routes } = heldUnlink();
    renderAt("/settings/linked-accounts", routes);
    await screen.findByText("Slack 사용자 U0OTHER (워크스페이스 T0OTHER)");
    const user = await setupUser();
    screen.getAllByRole("button", { name: "연결 해제" })[0]?.focus();
    await unlinkFocused(user);
    // A click outside <main> (which would take focus itself) leaves it on
    // the page, just as the removed row will.
    await user.click(document.body);
    expect(document.activeElement === document.body).toBe(true);
    release();
    expect(
      await screen.findByText("Slack 계정 연결을 해제했습니다."),
    ).toBeDefined();
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "연결 해제" }).length).toBe(
        1,
      ),
    );
    expect(document.activeElement === document.body).toBe(true);
  });

  test("응답보다 먼저 다시 읽은 목록에서 행이 빠져도 그 자리의 다음 행으로 간다", async () => {
    const { release, routes } = heldUnlink();
    const { services } = renderAt("/settings/linked-accounts", routes);
    await screen.findByText("Slack 사용자 U0OTHER (워크스페이스 T0OTHER)");
    const user = await setupUser();
    screen.getAllByRole("button", { name: "연결 해제" })[0]?.focus();
    await unlinkFocused(user);
    await services.queryClient.invalidateQueries({
      queryKey: keys.linkedAccounts,
    });
    await waitFor(() =>
      expect(
        document.activeElement?.closest("li")?.textContent?.includes("U0OTHER"),
      ).toBe(true),
    );
    release();
    expect(
      await screen.findByText("Slack 계정 연결을 해제했습니다."),
    ).toBeDefined();
    expect(
      document.activeElement?.closest("li")?.textContent?.includes("U0OTHER"),
    ).toBe(true);
  });

  test("먼저 누른 해제가 나중에 거절돼도 이어서 누른 행의 해제는 포커스를 옮긴다", async () => {
    const routes = twoLinks();
    const removeOther = routes[`DELETE /v1/linked-accounts/${OTHER_ID}`];
    let refuse: () => void = () => {};
    let answer: () => void = () => {};
    const refused = new Promise<void>((resolve) => {
      refuse = resolve;
    });
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    renderAt("/settings/linked-accounts", {
      ...routes,
      [`DELETE /v1/linked-accounts/${LINK_ID}`]: async () => {
        await refused;
        return apiError(500, "INTERNAL", "boom");
      },
      [`DELETE /v1/linked-accounts/${OTHER_ID}`]: async () => {
        const response = removeOther();
        await answered;
        return response;
      },
    });
    await screen.findByText("Slack 사용자 U0OTHER (워크스페이스 T0OTHER)");
    const user = await setupUser();
    screen.getAllByRole("button", { name: "연결 해제" })[0]?.focus();
    await unlinkFocused(user);
    await user.tab();
    await unlinkFocused(user);
    refuse();
    await screen.findByRole("alert");
    answer();
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "연결 해제" }).length).toBe(
        1,
      ),
    );
    await waitFor(() =>
      expect(
        document.activeElement?.closest("li")?.textContent?.includes("U0MOCK"),
      ).toBe(true),
    );
  });

  test("해제가 거절되면 포커스는 누른 버튼에 남고 이유를 알린다", async () => {
    renderAt("/settings/linked-accounts", {
      ...meOk,
      "GET /v1/linked-accounts": () => json(200, { items: [slack] }),
      [`DELETE /v1/linked-accounts/${LINK_ID}`]: () =>
        apiError(500, "INTERNAL", "boom"),
    });
    const button = await screen.findByRole("button", { name: "연결 해제" });
    const user = await setupUser();
    button.focus();
    await unlinkFocused(user);
    await screen.findByRole("alert");
    expect(button.getAttribute("aria-disabled")).toBeNull();
    expect(document.activeElement === button).toBe(true);
  });

  test("Slack이 돌려보내면 code·state를 한 번 보내고 목록으로 간다", async () => {
    let items: LinkedAccount[] = [];
    const { api, history } = renderAt(
      "/settings/linked-accounts/slack?code=c1&state=s1",
      {
        ...meOk,
        "POST /v1/linked-accounts/slack/callback": () => {
          items = [slack];
          return json(201, { linked_account: slack, receipt_id: RECEIPT_ID });
        },
        "GET /v1/linked-accounts": () => json(200, { items }),
      },
    );
    await waitFor(() =>
      expect(history.location.pathname).toBe("/settings/linked-accounts"),
    );
    expect(
      await screen.findByText("Slack 사용자 U0MOCK (워크스페이스 T0MOCK)"),
    ).toBeDefined();
    expect(
      api.calls
        .filter((c) => c.path === "/v1/linked-accounts/slack/callback")
        .map((c) => c.body),
    ).toEqual([{ code: "c1", state: "s1" }]);
  });

  test("다른 사람에게 연결된 계정이면 서버 문구와 돌아갈 링크다", async () => {
    renderAt("/settings/linked-accounts/slack?code=c1&state=s1", {
      ...meOk,
      "POST /v1/linked-accounts/slack/callback": () =>
        apiError(409, "LINK_TAKEN", LINK_MESSAGES.taken),
    });
    expect((await screen.findByRole("alert")).textContent).toBe(
      LINK_MESSAGES.taken,
    );
    expect(
      screen.getByRole("link", { name: "연동 계정으로" }).getAttribute("href"),
    ).toBe("/settings/linked-accounts");
  });

  test("설정이 없는 설치에서 연결을 시작하면 운영자 문의를 안내한다", async () => {
    renderAt("/settings/linked-accounts", {
      ...meOk,
      "GET /v1/linked-accounts": () => json(200, { items: [] }),
      "POST /v1/linked-accounts/slack/start": () =>
        apiError(
          503,
          "BACKEND_UNAVAILABLE",
          "Sign in with Slack is not configured on this installation",
        ),
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "Slack 계정 연결" }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "이 설치에서는 Slack 계정 연결을 쓸 수 없습니다 — 운영자에게 문의하세요.",
    );
  });

  test("워크스페이스에 연동 › Slack 설정이 없으면 관리자에게 요청하라고 한다", async () => {
    renderAt("/settings/linked-accounts", {
      ...meOk,
      "GET /v1/linked-accounts": () => json(200, { items: [] }),
      "POST /v1/linked-accounts/slack/start": () =>
        apiError(
          409,
          "SLACK_LINK_NOT_CONFIGURED",
          "Slack account linking is not set up for this workspace",
        ),
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "Slack 계정 연결" }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Slack 계정 연결을 아직 쓸 수 없습니다 — 워크스페이스 관리자에게 연동 › Slack 설정을 요청하세요.",
    );
  });

  test("콜백 중 Slack에 닿지 못하면 다시 시도하라고 한다", async () => {
    renderAt("/settings/linked-accounts/slack?code=c1&state=s1", {
      ...meOk,
      "POST /v1/linked-accounts/slack/callback": () =>
        apiError(
          503,
          "BACKEND_UNAVAILABLE",
          "Slack could not be reached, try again later",
          true,
        ),
    });
    expect((await screen.findByRole("alert")).textContent).toBe(
      "서버가 응답하지 않습니다 — 잠시 뒤 다시 시도하세요.",
    );
  });

  test("이 설치에 Slack 연결이 설정되지 않았으면 콜백도 쓸 수 없다고 한다", async () => {
    renderAt("/settings/linked-accounts/slack?code=c1&state=s1", {
      ...meOk,
      "POST /v1/linked-accounts/slack/callback": () =>
        apiError(
          503,
          "BACKEND_UNAVAILABLE",
          "Sign in with Slack is not configured on this installation",
        ),
    });
    expect((await screen.findByRole("alert")).textContent).toBe(
      "이 설치에서는 Slack 계정 연결을 쓸 수 없습니다 — 운영자에게 문의하세요.",
    );
  });

  test("목록을 불러오지 못하면 다시 시도로 다시 묻는다", async () => {
    let calls = 0;
    renderAt("/settings/linked-accounts", {
      ...meOk,
      "GET /v1/linked-accounts": () =>
        ++calls === 1
          ? apiError(500, "INTERNAL", "boom")
          : json(200, { items: [] }),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "다시 시도" }));
    await slackNotLinked();
    expect(calls).toBe(2);
  });

  test("로그인이 끊겼으면 로그인 뒤 같은 콜백으로 돌아오게 한다", async () => {
    const { history } = renderAt(
      "/settings/linked-accounts/slack?code=c1&state=s1",
      {
        "GET /v1/auth/me": () =>
          apiError(401, "UNAUTHORIZED", "Authentication required"),
      },
    );
    await waitFor(() => expect(history.location.pathname).toBe("/login"));
    expect(history.location.search).toContain(
      encodeURIComponent("/settings/linked-accounts/slack?code=c1&state=s1"),
    );
  });
});

describe("연동 계정 — GitHub", () => {
  const GITHUB_LINK_ID = "6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d";
  const github: LinkedAccount = {
    ...slack,
    id: GITHUB_LINK_ID,
    provider: "github",
    external_tenant: "github.com",
    external_user_id: "583231",
    external_user_name: "octocat",
  };
  const AUTHORIZE_GITHUB =
    "https://github.com/login/oauth/authorize?client_id=Iv23lifake&state=s1";
  const ready = {
    [`GET ${GITHUB_SETTINGS}`]: () => json(200, githubSettings()),
  };
  const githubRow = () =>
    screen
      .getByRole("heading", { name: "GitHub" })
      .closest("li") as HTMLElement;

  test("픽스처는 서버가 보낼 수 있는 모양이다", () => {
    expect(linkedAccountSchema.safeParse(github).success).toBe(true);
  });

  test("사용자 연결이 준비됐으면 연결 버튼이 GitHub 동의 화면으로 보낸다", async () => {
    const { api, left } = renderAt("/settings/linked-accounts", {
      ...meOk,
      ...ready,
      "GET /v1/linked-accounts": () => json(200, { items: [] }),
      "POST /v1/linked-accounts/github/start": () =>
        json(200, {
          authorize_url: AUTHORIZE_GITHUB,
          expires_at: "2026-10-11T00:10:00.000Z",
        }),
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "GitHub 계정 연결" }),
    );
    await waitFor(() => expect(left).toEqual([AUTHORIZE_GITHUB]));
    expect(
      api.calls.filter((c) => c.path === "/v1/linked-accounts/github/start")
        .length,
    ).toBe(1);
  });

  test("client secret이 없으면 버튼을 막고 관리자에게 맡긴다는 안내를 보인다", async () => {
    renderAt("/settings/linked-accounts", {
      ...meOk,
      [`GET ${GITHUB_SETTINGS}`]: () =>
        json(200, githubSettings({ client_secret_set: false })),
      "GET /v1/linked-accounts": () => json(200, { items: [] }),
    });
    expect(
      await screen.findByText("관리자가 사용자 연결을 켜야 해요"),
    ).toBeDefined();
    const button = within(githubRow()).getByRole("button", { name: "연결" });
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  test("설정이 안 됐다는 시작 거절은 서버의 안내 문구 그대로다", async () => {
    renderAt("/settings/linked-accounts", {
      ...meOk,
      "GET /v1/linked-accounts": () => json(200, { items: [] }),
      "POST /v1/linked-accounts/github/start": () =>
        apiError(409, "GITHUB_LINK_NOT_CONFIGURED", LINK_MESSAGES.githubUnset),
    });
    const user = await setupUser();
    // Unread settings leave the button; the start says why it cannot.
    await user.click(
      await screen.findByRole("button", { name: "GitHub 계정 연결" }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      LINK_MESSAGES.githubUnset,
    );
  });

  test("연결된 GitHub 계정은 login과 commit에 들어갈 줄을 보이고 해제한다", async () => {
    let items = [github];
    renderAt("/settings/linked-accounts", {
      ...meOk,
      ...ready,
      "GET /v1/linked-accounts": () => json(200, { items }),
      [`DELETE /v1/linked-accounts/${GITHUB_LINK_ID}`]: () => {
        items = [{ ...github, status: "revoked" }];
        return json(200, {
          receipt_id: RECEIPT_ID,
          receipt_status: "succeeded",
        });
      },
    });
    expect(
      await screen.findByText(
        "commit에 들어가는 줄: Co-authored-by: octocat <583231+octocat@users.noreply.github.com>",
      ),
    ).toBeDefined();
    const row = within(githubRow());
    expect(row.getByText("octocat")).toBeDefined();
    expect(row.queryByRole("button", { name: "GitHub 계정 연결" })).toBeNull();
    // Slack's row is untouched by a GitHub link.
    await slackNotLinked();
    const user = await setupUser();
    await user.click(row.getByRole("button", { name: "연결 해제" }));
    // Nothing is sent until the dialog naming the account is confirmed.
    const dialog = await screen.findByRole("dialog", {
      name: "GitHub 계정 연결을 해제할까요?",
    });
    expect(within(dialog).getByText("octocat")).toBeDefined();
    await user.click(within(dialog).getByRole("button", { name: "연결 해제" }));
    expect(
      await screen.findByText("GitHub 계정 연결을 해제했습니다."),
    ).toBeDefined();
    await waitFor(() =>
      expect(
        within(githubRow()).getByRole("button", { name: "GitHub 계정 연결" }),
      ).toBeDefined(),
    );
  });

  test("GitHub가 돌려보내면 code·state를 GitHub 콜백에 한 번 보내고 목록으로 간다", async () => {
    let items: LinkedAccount[] = [];
    const { api, history } = renderAt(
      "/settings/linked-accounts/github?code=c1&state=s1",
      {
        ...meOk,
        ...ready,
        "POST /v1/linked-accounts/github/callback": () => {
          items = [github];
          return json(201, { linked_account: github, receipt_id: RECEIPT_ID });
        },
        "GET /v1/linked-accounts": () => json(200, { items }),
      },
    );
    await waitFor(() =>
      expect(history.location.pathname).toBe("/settings/linked-accounts"),
    );
    expect(await within(githubRow()).findByText("octocat")).toBeDefined();
    expect(
      api.calls
        .filter((c) => c.path.startsWith("/v1/linked-accounts/"))
        .filter((c) => c.method === "POST")
        .map((c) => [c.path, c.body]),
    ).toEqual([
      ["/v1/linked-accounts/github/callback", { code: "c1", state: "s1" }],
    ]);
  });

  test("이미 다른 사람에게 연결된 GitHub 계정이면 서버 문구와 돌아갈 링크다", async () => {
    renderAt("/settings/linked-accounts/github?code=c1&state=s1", {
      ...meOk,
      "POST /v1/linked-accounts/github/callback": () =>
        apiError(409, "LINK_TAKEN", LINK_MESSAGES.githubTaken),
    });
    expect((await screen.findByRole("alert")).textContent).toBe(
      LINK_MESSAGES.githubTaken,
    );
    expect(
      screen.getByRole("link", { name: "연동 계정으로" }).getAttribute("href"),
    ).toBe("/settings/linked-accounts");
  });

  test("code 없이 돌아오면(동의 취소) 서버에 묻지 않고 다시 하라고 한다", async () => {
    const { api } = renderAt(
      "/settings/linked-accounts/github?error=access_denied&state=s1",
      meOk,
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "GitHub 계정 연결을 마치지 못했습니다 — 다시 시도하세요.",
    );
    expect(api.calls.some((c) => c.path.endsWith("/callback"))).toBe(false);
  });
});
