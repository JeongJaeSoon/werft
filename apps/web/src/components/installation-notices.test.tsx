import { describe, expect, test } from "bun:test";
import { focusManager } from "@tanstack/react-query";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { apiError, json, me, memberMe } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const ME = "GET /v1/auth/me";
const NOTICES = "GET /v1/lost-checkpoint-notices";
const CLOSE = "POST /v1/lost-checkpoint-notices/close";
const FIRST = "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01";
const SECOND = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const LATER = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";

const notice = (id: string, sessions: number) => ({
  id,
  forgotten_at: "2026-11-24T09:12:44.000Z",
  sessions,
});
const twoStarts = { notices: [notice(FIRST, 2), notice(SECOND, 1)] };
const TEXT = "시험 설치: 다시 켜서 세션 3개의 맥락을 잃었습니다";

const banner = () =>
  document.querySelector<HTMLElement>("[data-slot=installation-notice]");
const shell = () => screen.findByRole("navigation", { name: "주요 메뉴" });

describe("the banner for checkpoints a test installation gave up at start", () => {
  for (const [role, signedInAs] of [
    ["owner", me()],
    ["admin", me(undefined, "admin")],
  ] as const) {
    for (const path of ["/", "/agents", "/settings/preferences"]) {
      test(`an ${role} sees it at the top of ${path}, counting the sessions of every start`, async () => {
        renderAt(path, {
          [ME]: () => json(200, signedInAs),
          [NOTICES]: () => json(200, twoStarts),
        });
        expect(await screen.findByText(TEXT)).toBeDefined();
        const main = document.getElementById("main");
        expect(main?.firstElementChild === banner()).toBe(true);
        expect(
          within(banner() as HTMLElement).getByRole("button", { name: "닫기" }),
        ).toBeDefined();
      });
    }
  }

  test("a member is shown nothing and the notices are not asked for", async () => {
    const { api } = renderAt("/", {
      [ME]: () => json(200, memberMe()),
      [NOTICES]: () => json(200, twoStarts),
    });
    await shell();
    await waitFor(() =>
      expect(api.calls.some((call) => call.path === "/v1/sessions")).toBe(true),
    );
    expect(banner() === null).toBe(true);
    expect(
      api.calls.filter((call) => call.path === "/v1/lost-checkpoint-notices"),
    ).toEqual([]);
  });

  test("nothing shows while no start gave anything up, or on a server from before the notices", async () => {
    for (const answer of [
      () => json(200, { notices: [] }),
      () => apiError(404, "NOT_FOUND", "no such route"),
    ]) {
      const { api } = renderAt("/", {
        [ME]: () => json(200, me()),
        [NOTICES]: answer,
      });
      await shell();
      await waitFor(() =>
        expect(
          api.calls.some((call) => call.path === "/v1/lost-checkpoint-notices"),
        ).toBe(true),
      );
      expect(banner() === null).toBe(true);
      // The page keeps its place as the first thing in <main>.
      expect(
        document.getElementById("main")?.querySelector("[data-slot]") != null,
      ).toBe(true);
    }
  });

  test("closing sends the ids that were read and the banner goes", async () => {
    const { api } = renderAt("/", {
      [ME]: () => json(200, me()),
      [NOTICES]: () => json(200, twoStarts),
      [CLOSE]: () => json(200, { notices: [] }),
    });
    await screen.findByText(TEXT);
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(banner() === null).toBe(true));
    expect(
      api.calls
        .filter((call) => call.method === "POST")
        .map((call) => [call.path, call.body]),
    ).toEqual([
      ["/v1/lost-checkpoint-notices/close", { ids: [FIRST, SECOND] }],
    ]);
  });

  test("more notices than one close takes go in several, and all that were read close", async () => {
    const many = Array.from({ length: 101 }, (_, index) =>
      notice(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, 1),
    );
    let open = many;
    const { api } = renderAt("/", {
      [ME]: () => json(200, me()),
      [NOTICES]: () => json(200, { notices: open }),
      [CLOSE]: async (request) => {
        const { ids } = (await request.json()) as { ids: string[] };
        open = open.filter((each) => !ids.includes(each.id));
        return json(200, { notices: open });
      },
    });
    // The count is of every open notice, as /readyz counts them.
    await screen.findByText(
      "시험 설치: 다시 켜서 세션 101개의 맥락을 잃었습니다",
    );
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(banner() === null).toBe(true));
    expect(
      api.calls
        .filter((call) => call.method === "POST")
        .map((call) => (call.body as { ids: string[] }).ids.length),
    ).toEqual([100, 1]);
  });

  test("a start that gave up more after the read stays on screen", async () => {
    renderAt("/", {
      [ME]: () => json(200, me()),
      [NOTICES]: () => json(200, twoStarts),
      [CLOSE]: () => json(200, { notices: [notice(LATER, 4)] }),
    });
    await screen.findByText(TEXT);
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "닫기" }));
    expect(
      await screen.findByText(
        "시험 설치: 다시 켜서 세션 4개의 맥락을 잃었습니다",
      ),
    ).toBeDefined();
  });

  test("closed by another administrator, it goes when this one comes back to the page", async () => {
    let open = true;
    renderAt("/", {
      [ME]: () => json(200, me()),
      [NOTICES]: () => json(200, open ? twoStarts : { notices: [] }),
    });
    await screen.findByText(TEXT);
    open = false;
    // Away and back: the tab's queries read again.
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await waitFor(() => expect(banner() === null).toBe(true));
    focusManager.setFocused(undefined);
  });

  test("the shell is told how tall it is while it shows, for the pages that fill the screen", async () => {
    renderAt("/", {
      [ME]: () => json(200, me()),
      [NOTICES]: () => json(200, twoStarts),
      [CLOSE]: () => json(200, { notices: [] }),
    });
    await screen.findByText(TEXT);
    const main = document.getElementById("main") as HTMLElement;
    expect(main.style.getPropertyValue("--werft-shell-notice-h")).toBe(
      `${(banner() as HTMLElement).offsetHeight}px`,
    );
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(banner() === null).toBe(true));
    expect(main.style.getPropertyValue("--werft-shell-notice-h")).toBe("");
  });

  test("a close the server refuses keeps the banner and says so", async () => {
    renderAt("/", {
      [ME]: () => json(200, me()),
      [NOTICES]: () => json(200, twoStarts),
      [CLOSE]: () => apiError(503, "SERVICE_UNAVAILABLE", "down"),
    });
    await screen.findByText(TEXT);
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "닫기" }));
    const failed = await within(banner() as HTMLElement).findByRole("alert");
    expect(failed.textContent).toStartWith("닫지 못했습니다.");
    expect(screen.getByText(TEXT)).toBeDefined();
    expect(
      (screen.getByRole("button", { name: "닫기" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  for (const [locale, text, button] of [
    [
      "en",
      "Test installation: a restart lost the context of 3 sessions",
      "Close",
    ],
    [
      "ja",
      "試験インストール: 再起動でセッション3件のコンテキストを失いました",
      "閉じる",
    ],
  ] as const) {
    test(`it reads in ${locale}`, async () => {
      renderAt(
        "/",
        { [ME]: () => json(200, me()), [NOTICES]: () => json(200, twoStarts) },
        locale,
      );
      expect(await screen.findByText(text)).toBeDefined();
      expect(
        within(banner() as HTMLElement).getByRole("button", { name: button }),
      ).toBeDefined();
    });
  }
});
const STATUS = "GET /v1/installation-status";
const quotaBanner = () =>
  document.querySelector<HTMLElement>("[data-slot=no-disk-quota]");
const TEST_MODE = "시험 모드: 디스크 quota 없음, 운영 불가";
const QUOTA_OFF =
  "디스크 quota가 꺼져 있습니다. 측정으로만 막아서 한도를 잠깐 넘을 수 있습니다. 운영에서는 XFS quota를 켜세요.";

describe("the banner for an installation without a disk quota", () => {
  for (const [profile, text] of [
    ["test", TEST_MODE],
    ["production", QUOTA_OFF],
  ] as const) {
    test(`a ${profile} installation says so at the top, with nothing to close`, async () => {
      renderAt("/agents", {
        [ME]: () => json(200, me()),
        [NOTICES]: () => json(200, { notices: [] }),
        [STATUS]: () => json(200, { profile, no_disk_quota: true }),
      });
      expect(await screen.findByText(text)).toBeDefined();
      expect(
        document.getElementById("main")?.firstElementChild === banner(),
      ).toBe(true);
      expect(
        within(banner() as HTMLElement).queryByRole("button") === null,
      ).toBe(true);
    });
  }

  test("it stands above the lost checkpoints, and closing those leaves it", async () => {
    renderAt("/", {
      [ME]: () => json(200, me(undefined, "admin")),
      [NOTICES]: () => json(200, twoStarts),
      [STATUS]: () => json(200, { profile: "test", no_disk_quota: true }),
      [CLOSE]: () => json(200, { notices: [] }),
    });
    await screen.findByText(TEXT);
    expect(await screen.findByText(TEST_MODE)).toBeDefined();
    expect((banner() as HTMLElement).firstElementChild === quotaBanner()).toBe(
      true,
    );
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByText(TEXT) === null).toBe(true));
    expect(screen.getByText(TEST_MODE)).toBeDefined();
  });

  test("nothing shows with the quota on or on a server from before the status", async () => {
    for (const answer of [
      () => json(200, { profile: "test", no_disk_quota: false }),
      () => apiError(404, "NOT_FOUND", "no such route"),
    ]) {
      const { api } = renderAt("/", {
        [ME]: () => json(200, me()),
        [NOTICES]: () => json(200, { notices: [] }),
        [STATUS]: answer,
      });
      await shell();
      await waitFor(() =>
        expect(
          api.calls.some((call) => call.path === "/v1/installation-status"),
        ).toBe(true),
      );
      expect(banner() === null).toBe(true);
    }
  });

  test("a member is shown nothing and the status is not asked for", async () => {
    const { api } = renderAt("/", {
      [ME]: () => json(200, memberMe()),
      [STATUS]: () => json(200, { profile: "test", no_disk_quota: true }),
    });
    await shell();
    await waitFor(() =>
      expect(api.calls.some((call) => call.path === "/v1/sessions")).toBe(true),
    );
    expect(banner() === null).toBe(true);
    expect(
      api.calls.filter((call) => call.path === "/v1/installation-status"),
    ).toEqual([]);
  });

  for (const [locale, test_, production] of [
    [
      "en",
      "Test mode: no disk quota, not for production",
      "The disk quota is off. Only measurement holds the limit, so a workspace can briefly pass it. Turn the XFS quota on for production.",
    ],
    [
      "ja",
      "試験モード: ディスク quota なし、運用不可",
      "ディスク quota がオフです。測定だけで抑えるため、一時的に上限を超えることがあります。運用では XFS quota をオンにしてください。",
    ],
  ] as const) {
    for (const [profile, text] of [
      ["test", test_],
      ["production", production],
    ] as const) {
      test(`it reads in ${locale} on a ${profile} installation`, async () => {
        renderAt(
          "/",
          {
            [ME]: () => json(200, me()),
            [NOTICES]: () => json(200, { notices: [] }),
            [STATUS]: () => json(200, { profile, no_disk_quota: true }),
          },
          locale,
        );
        expect(await screen.findByText(text)).toBeDefined();
      });
    }
  }
});
