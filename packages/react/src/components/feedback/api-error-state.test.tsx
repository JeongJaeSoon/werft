import { describe, expect, jest, test } from "bun:test";
import { API_ERROR_CODE_VALUES } from "@werft-ai/contracts";
import { setupDom } from "@werft-ai/ui/test-support/dom";
import {
  ERROR_GUIDANCE,
  ERROR_GUIDANCE_BY_LOCALE,
  guidanceFor,
} from "./error-guidance.ts";

const HANGUL = /[\u3131-\u318e\uac00-\ud7a3]/;

const { render } = await setupDom();
// After setupDom: these load @werft-ai/ui, whose Radix decides at import time
// whether a DOM exists, for every later file in the run too.
const { ErrorState } = await import("@werft-ai/ui");
const { ApiErrorState } = await import("./api-error-state.tsx");

describe("ApiErrorState", () => {
  test("코드별 할 일을 원문보다 먼저 보여준다", () => {
    const { container } = render(
      <ApiErrorState code="UNAUTHORIZED" message="token expired" />,
    );
    expect(container.querySelector(".werft-state__guidance")?.textContent).toBe(
      "로그인이 만료됐습니다 — 다시 로그인하세요.",
    );
    expect(
      container.querySelector(".werft-state__description")?.textContent,
    ).toBe("token expired");
  });

  test("화면이 준 안내가 코드의 일반 안내를 대신한다", () => {
    const { container } = render(
      <ApiErrorState
        code="BACKEND_UNAVAILABLE"
        guidance="저장소가 꺼져 있습니다."
      />,
    );
    expect(container.querySelector(".werft-state__guidance")?.textContent).toBe(
      "저장소가 꺼져 있습니다.",
    );
    expect(container.querySelector(".werft-state__code")?.textContent).toBe(
      "BACKEND_UNAVAILABLE",
    );
  });

  test("ErrorState에 그 코드의 할 일을 넘긴 것과 같은 마크업이다", () => {
    const api = render(
      <ApiErrorState
        code="SESSION_CLOSED"
        message="session is closed"
        retry={() => {}}
        evidenceLink={{ href: "/sessions/01J8Z5/journal" }}
      />,
    );
    const plain = render(
      <ErrorState
        guidance={ERROR_GUIDANCE.SESSION_CLOSED}
        code="SESSION_CLOSED"
        message="session is closed"
        retry={() => {}}
        evidenceLink={{ href: "/sessions/01J8Z5/journal" }}
      />,
    );
    expect(api.container.innerHTML).toBe(plain.container.innerHTML);
  });

  test("en·ja에서는 안내·제목·다시 시도·기록 링크가 그 언어이고 한국어가 없다", () => {
    const expected = {
      en: ["Something went wrong", "Try again", "View record"],
      ja: ["問題が発生しました", "再試行", "記録を見る"],
    } as const;
    for (const locale of ["en", "ja"] as const) {
      const retry = jest.fn();
      const { container, getByRole, unmount } = render(
        <ApiErrorState
          locale={locale}
          code="SESSION_CLOSED"
          retry={retry}
          evidenceLink={{ href: "/sessions/01J8Z5/journal" }}
        />,
      );
      const [title, retryLabel, evidence] = expected[locale];
      expect(container.querySelector(".werft-state__title")?.textContent).toBe(
        title,
      );
      expect(
        container.querySelector(".werft-state__guidance")?.textContent,
      ).toBe(ERROR_GUIDANCE_BY_LOCALE[locale].SESSION_CLOSED);
      expect(container.querySelector(".werft-state__code")?.textContent).toBe(
        "SESSION_CLOSED",
      );
      expect(getByRole("link", { name: evidence })).toBeTruthy();
      getByRole("button", { name: retryLabel }).click();
      expect(retry).toHaveBeenCalledTimes(1);
      expect(container.textContent).not.toMatch(HANGUL);
      unmount();
    }
  });

  test("호출한 쪽이 준 제목·버튼 이름은 언어 기본값보다 앞선다", () => {
    const { container, getByRole } = render(
      <ApiErrorState
        locale="en"
        code="NOT_FOUND"
        title="Couldn't load agents"
        retry={() => {}}
        retryLabel="Reload"
        evidenceLink={{ href: "/x", label: "Open log" }}
      />,
    );
    expect(container.querySelector(".werft-state__title")?.textContent).toBe(
      "Couldn't load agents",
    );
    expect(getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(getByRole("link", { name: "Open log" })).toBeTruthy();
  });

  test("코드가 없으면 안내 줄도 없다", () => {
    const { container } = render(<ApiErrorState message="boom" />);
    expect(container.querySelector(".werft-state__guidance")).toBeNull();
  });
});

describe("오류 문구", () => {
  test("contracts의 모든 error code에 할 일이 있다", () => {
    expect(Object.keys(ERROR_GUIDANCE).sort()).toEqual(
      [...API_ERROR_CODE_VALUES].sort(),
    );
  });

  test("세 언어 모두 모든 error code에 할 일이 있고 en·ja에는 한국어가 없다", () => {
    for (const locale of ["ko", "en", "ja"] as const) {
      const guidance = ERROR_GUIDANCE_BY_LOCALE[locale];
      expect(Object.keys(guidance).sort()).toEqual(
        [...API_ERROR_CODE_VALUES].sort(),
      );
      for (const code of API_ERROR_CODE_VALUES) {
        expect(guidance[code].trim().length).toBeGreaterThan(0);
        if (locale !== "ko") expect(guidance[code]).not.toMatch(HANGUL);
      }
    }
    expect(ERROR_GUIDANCE_BY_LOCALE.ko).toBe(ERROR_GUIDANCE);
  });

  test("모르는 locale은 오류 화면을 깨지 않고 한국어로 말한다", () => {
    expect(guidanceFor("NOT_FOUND", "zh" as never)).toBe(
      ERROR_GUIDANCE.NOT_FOUND,
    );
    expect(guidanceFor("NOT_FOUND", 0 as never)).toBe(ERROR_GUIDANCE.NOT_FOUND);
    const { container } = render(
      <ApiErrorState locale={"zh" as never} code="NOT_FOUND" />,
    );
    expect(container.querySelector(".werft-state__title")?.textContent).toBe(
      "문제가 생겼습니다",
    );
  });

  test("모르는 코드는 그 언어의 일반 안내로 말한다", () => {
    for (const locale of ["en", "ja"] as const) {
      const fallback = guidanceFor("SOMETHING_NEW", locale);
      expect(fallback).toBe(guidanceFor("__proto__", locale));
      expect(fallback).not.toMatch(HANGUL);
    }
    expect(guidanceFor("SOMETHING_NEW", "en")).toBe(
      "Something went wrong — try again shortly.",
    );
  });

  test("모르는 코드도 영문 원문 대신 할 일로 말한다", () => {
    expect(guidanceFor("SOMETHING_NEW")).toBe(
      "처리하지 못했습니다 — 잠시 뒤 다시 시도하세요.",
    );
    expect(guidanceFor(undefined)).toBeUndefined();
  });

  test("Object.prototype의 이름을 코드로 받아도 문자열만 돌려준다", () => {
    // A plain lookup hands these back as objects, and React throws on render.
    for (const code of [
      "__proto__",
      "constructor",
      "toString",
      "hasOwnProperty",
    ]) {
      expect(guidanceFor(code)).toBe(
        "처리하지 못했습니다 — 잠시 뒤 다시 시도하세요.",
      );
    }
  });

  test.each([
    [
      "ko",
      "연동 › Slack",
      "연동 › GitHub",
      ["Slack 연결 설정", "GitHub 연결 설정"],
    ],
    [
      "en",
      "Slack in Integrations",
      "Integrations › GitHub",
      ["Slack connection", "GitHub connection"],
    ],
    ["ja", "連携 › Slack", "連携 › GitHub", ["Slack 接続", "GitHub 接続"]],
  ] as const)(
    "%s 안내는 연동 메뉴 이름을 쓰고 옛 메뉴 이름은 없다",
    (locale, slack, github, old) => {
      const texts = [
        guidanceFor("SLACK_LINK_NOT_CONFIGURED", locale),
        guidanceFor("GITHUB_LINK_NOT_CONFIGURED", locale),
      ];
      expect(texts[0]?.includes(slack)).toBe(true);
      expect(texts[1]?.includes(github)).toBe(true);
      for (const label of old) {
        expect(texts.some((text) => text?.includes(label))).toBe(false);
      }
    },
  );
});
