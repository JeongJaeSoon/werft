import { describe, expect, test } from "bun:test";
import type { InstallationConfig } from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import {
  executionLimitsEn,
  executionLimitsKo,
} from "../i18n/execution-limits.ts";
import { apiError, json, me } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";
import {
  ARCHIVE_DAYS,
  ARCHIVE_DRY_RUN_ENV,
  archiveDaysOf,
  ENFORCE_ENV,
  ENFORCE_VALUES,
  limitValueOf,
  NUMBER_LIMITS,
  type NumberLimit,
} from "./execution-limits.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const PAGE = "/settings/workspace/limits";
const API = "/v1/installation-config";
const RECEIPT = "019a0000-0000-7000-8000-0000000000e1";
const LABEL = "응답 대기 시간 (초)";
const INVALID = "1부터 604,800까지의 정수(초)를 적으세요.";

const entry = <T,>(value: T, saved = false, blocked = false) => ({
  value,
  default: value,
  saved,
  blocked,
});

const DEFAULTS: InstallationConfig = {
  pending_request_ttl_sec: entry(1800),
  queued_input_limit_per_session: entry(20),
  storage_limit_bytes: entry(1_073_741_824),
  session_cost_limit_usd: entry(25),
  session_token_limit: entry(0),
  workspace_enforce: entry("warn" as const),
  max_turn_seconds: entry(3600),
  provider_max_retries: entry(2),
  session_archive_after_days: entry(180),
  session_archive_dry_run: entry(true),
  workspace_stopped_ttl_sec: entry(86_400),
  workspace_paused_ttl_sec: entry(86_400),
  session_archive: { available: true, reason: null },
};

const config = (
  value: number,
  saved: boolean,
  blocked = false,
): InstallationConfig => ({
  ...DEFAULTS,
  pending_request_ttl_sec: { value, default: 1800, saved, blocked },
});

const routes = (
  current: () => InstallationConfig,
  role: "owner" | "admin" = "owner",
) => ({
  "GET /v1/auth/me": () => json(200, me(undefined, role)),
  [`GET ${API}`]: () => json(200, current()),
});

// Each limit is a row of the one form, named by its title.
const sectionOf = (title: string) =>
  screen.findByRole("group", { name: title });
const section = () => sectionOf("사람 응답");
const field = (area: HTMLElement, label = LABEL) =>
  within(area).getByRole("spinbutton", { name: label }) as HTMLInputElement;
const saveButton = () => screen.getByRole("button", { name: "저장" });

describe("설정 › 실행 한도의 응답 대기 시간", () => {
  test("저장한 값이 없으면 기본값을 보여 주고 그렇다고 적는다", async () => {
    renderAt(
      PAGE,
      routes(() => config(1800, false)),
    );
    const area = await section();
    await waitFor(() => expect(field(area).value).toBe("1800"));
    expect(area.textContent).toContain(
      "저장한 값이 없어 기본값(1,800초)을 씁니다.",
    );
    expect(
      within(area).queryByRole("button", { name: "기본값으로" }) === null,
    ).toBe(true);
    expect(within(area).queryByRole("status") === null).toBe(true);
  });

  test("쓸 수 있는 값이 없으면 그렇다고 알리고, 보이는 기본값 그대로도 저장할 수 있다", async () => {
    let current = config(1800, false, true);
    const { api } = renderAt(PAGE, {
      ...routes(() => current),
      [`PATCH ${API}`]: () => {
        current = config(1800, true);
        return json(200, { ...current, receipt_id: RECEIPT });
      },
    });
    const user = await setupUser();
    const area = await section();
    await waitFor(() => expect(field(area).value).toBe("1800"));
    const status = within(area).getByRole("status").textContent ?? "";
    expect(status).toContain("PENDING_REQUEST_TTL_SEC");
    expect(status).toContain(
      "값을 저장할 때까지 세션의 권한 요청과 질문을 받지 않습니다.",
    );
    const described = (field(area).getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(described).toContain("값을 저장할 때까지");
    expect(area.textContent).not.toContain("기본값(1,800초)을 씁니다.");
    await user.click(saveButton());
    await screen.findByText("응답 대기 시간을 저장했습니다.");
    expect(api.calls.find((call) => call.method === "PATCH")?.body).toEqual({
      pending_request_ttl_sec: 1800,
    });
    await waitFor(() =>
      expect(within(area).queryByRole("status") === null).toBe(true),
    );
  });

  test("바꾼 값을 저장하면 그 키만 보내고, 기본값으로 되돌리기가 생긴다", async () => {
    let current = config(1800, false);
    const { api } = renderAt(PAGE, {
      ...routes(() => current),
      [`PATCH ${API}`]: () => {
        current = config(3600, true);
        return json(200, { ...current, receipt_id: RECEIPT });
      },
    });
    const user = await setupUser();
    const area = await section();
    await waitFor(() => expect(field(area).value).toBe("1800"));
    await user.clear(field(area));
    await user.type(field(area), "3600");
    await user.click(saveButton());
    await screen.findByText("응답 대기 시간을 저장했습니다.");
    expect(api.calls.find((call) => call.method === "PATCH")?.body).toEqual({
      pending_request_ttl_sec: 3600,
    });
    expect(field(area).value).toBe("3600");
    expect(area.textContent).toContain("기본값은 1,800초입니다.");
    within(area).getByRole("button", { name: "기본값으로" });
  });

  test("범위 밖이나 정수가 아닌 값은 보내지 않고 칸에 이유를 둔다", async () => {
    const { api } = renderAt(
      PAGE,
      routes(() => config(1800, false)),
    );
    const user = await setupUser();
    const area = await section();
    await waitFor(() => expect(field(area).value).toBe("1800"));
    await user.clear(field(area));
    await user.type(field(area), "0");
    await user.click(saveButton());
    await waitFor(() => expect(area.textContent).toContain(INVALID));
    expect(document.activeElement === field(area)).toBe(true);
    expect(api.calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
  });

  test("서버가 거절하면 칸에 이유를 두고 칸으로 돌아간다", async () => {
    renderAt(PAGE, {
      ...routes(() => config(1800, false)),
      [`PATCH ${API}`]: () => apiError(400, "BAD_REQUEST", "no", false),
    });
    const user = await setupUser();
    const area = await section();
    await waitFor(() => expect(field(area).value).toBe("1800"));
    await user.clear(field(area));
    await user.type(field(area), "60");
    await user.click(saveButton());
    await waitFor(() => expect(area.textContent).toContain(INVALID));
    expect(document.activeElement === field(area)).toBe(true);
  });

  test("owner가 아닌 admin에게는 권한 없음 화면만 보이고 설정을 읽지 않는다", async () => {
    const { api } = renderAt(
      PAGE,
      routes(() => config(1800, false), "admin"),
    );
    await screen.findByRole("heading", { name: "실행 한도" });
    expect(screen.queryByRole("group", { name: "사람 응답" }) === null).toBe(
      true,
    );
    expect(api.calls.some((call) => call.path === API)).toBe(false);
  });
});

describe("설정 › 실행 한도의 세션 한도", () => {
  test("비용 한도는 소수 금액을 그 키만 보내 저장하고, 0은 보내지 않는다", async () => {
    let current = DEFAULTS;
    const { api } = renderAt(PAGE, {
      ...routes(() => current),
      [`PATCH ${API}`]: () => {
        current = {
          ...DEFAULTS,
          session_cost_limit_usd: { ...entry(12.5, true), default: 25 },
        };
        return json(200, { ...current, receipt_id: RECEIPT });
      },
    });
    const user = await setupUser();
    const area = await sectionOf("세션 비용");
    const cost = () => field(area, "세션 비용 한도 (USD)");
    await waitFor(() => expect(cost().value).toBe("25"));
    expect(area.textContent).toContain(
      "저장한 값이 없어 기본값(25 USD)을 씁니다.",
    );
    await user.clear(cost());
    await user.type(cost(), "0");
    await user.click(saveButton());
    await waitFor(() =>
      expect(area.textContent).toContain(
        "0보다 크고 1,000,000 이하인 금액(USD)을 적으세요.",
      ),
    );
    expect(api.calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
    await user.clear(cost());
    await user.type(cost(), "12.5");
    await user.click(saveButton());
    await screen.findByText("세션 비용 한도를 저장했습니다.");
    expect(api.calls.find((call) => call.method === "PATCH")?.body).toEqual({
      session_cost_limit_usd: 12.5,
    });
    expect(area.textContent).toContain("기본값은 25 USD입니다.");
  });

  test("토큰 한도의 기본값 0은 한도 없음으로 읽힌다", async () => {
    renderAt(
      PAGE,
      routes(() => DEFAULTS),
    );
    const area = await sectionOf("세션 토큰");
    await waitFor(() => expect(field(area, "세션 토큰 한도").value).toBe("0"));
    expect(area.textContent).toContain(
      "저장한 값이 없어 기본값(한도 없음(0))을 씁니다.",
    );
  });

  test("입력 보관은 세는 것, 곧 입력 메시지만 말한다", async () => {
    renderAt(
      PAGE,
      routes(() => DEFAULTS),
    );
    const area = await sectionOf("입력 보관");
    expect(area.textContent).toContain(
      "이 설치 전체에 보관하는 입력 메시지의 합입니다.",
    );
    // The charge is octet_length(message) per turn; nothing else is counted.
    expect(area.textContent).not.toContain("첨부");
  });

  test("막힌 키만 그 변수 이름과 멈추는 일을 알리고, 다른 칸은 그대로 둔다", async () => {
    renderAt(
      PAGE,
      routes(() => ({
        ...DEFAULTS,
        storage_limit_bytes: entry(1_073_741_824, false, true),
      })),
    );
    const area = await sectionOf("입력 보관");
    const status = within(area).getByRole("status").textContent ?? "";
    expect(status).toContain("STORAGE_LIMIT_BYTES");
    expect(status).toContain(
      "값을 저장할 때까지 새 세션과 메시지를 받지 않습니다.",
    );
    // The blocked key is the one thing to save.
    expect(saveButton().getAttribute("aria-disabled")).toBe(null);
    screen.getByText("저장하지 않은 한도 1개");
    const queue = await sectionOf("대기 메시지");
    expect(within(queue).queryByRole("status") === null).toBe(true);
  });

  test("막힌 키가 없고 바꾼 값도 없으면 저장할 것이 없다고 적는다", async () => {
    renderAt(
      PAGE,
      routes(() => DEFAULTS),
    );
    await sectionOf("대기 메시지");
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");
    screen.getByText("저장하지 않은 변경이 없습니다.");
  });
});

describe("설정 › 실행 한도의 작업자 한도", () => {
  test("턴 시간과 재시도는 각각 그 키만 보내 저장하고, 재시도 0도 받는다", async () => {
    let current = DEFAULTS;
    const { api } = renderAt(PAGE, {
      ...routes(() => current),
      [`PATCH ${API}`]: async (request) => {
        const body = (await request.json()) as Partial<Record<string, number>>;
        current = {
          ...current,
          ...(body.max_turn_seconds === undefined
            ? {}
            : {
                max_turn_seconds: {
                  ...entry(body.max_turn_seconds, true),
                  default: 3600,
                },
              }),
          ...(body.provider_max_retries === undefined
            ? {}
            : {
                provider_max_retries: {
                  ...entry(body.provider_max_retries, true),
                  default: 2,
                },
              }),
        };
        return json(200, { ...current, receipt_id: RECEIPT });
      },
    });
    const user = await setupUser();
    const turn = await sectionOf("턴 시간");
    const turnField = () => field(turn, "턴 시간 상한 (초)");
    await waitFor(() => expect(turnField().value).toBe("3600"));
    expect(turn.textContent).toContain(
      "턴을 돌고 있는 작업자는 그 턴을 받을 때의 값으로 마친 뒤 내립니다.",
    );
    await user.clear(turnField());
    await user.type(turnField(), "604801");
    await user.click(saveButton());
    await waitFor(() =>
      expect(turn.textContent).toContain(
        "1부터 604,800까지의 정수(초)를 적으세요.",
      ),
    );
    await user.clear(turnField());
    await user.type(turnField(), "1200");
    await user.click(saveButton());
    await screen.findByText("턴 시간 상한을 저장했습니다.");

    const retries = await sectionOf("모델 요청 재시도");
    const retriesField = () => field(retries, "재시도 횟수");
    await user.clear(retriesField());
    await user.type(retriesField(), "11");
    await user.click(saveButton());
    await waitFor(() =>
      expect(retries.textContent).toContain("0부터 10까지의 정수를 적으세요."),
    );
    await user.clear(retriesField());
    await user.type(retriesField(), "0");
    await user.click(saveButton());
    await screen.findByText("재시도 횟수를 저장했습니다.");
    expect(
      api.calls
        .filter((call) => call.method === "PATCH")
        .map((call) => call.body),
    ).toEqual([{ max_turn_seconds: 1200 }, { provider_max_retries: 0 }]);
  });

  test("막힌 턴 시간은 옮겨 오지 못한 변수 이름과 새 작업자를 띄우지 않는다는 것을 알린다", async () => {
    renderAt(
      PAGE,
      routes(() => ({
        ...DEFAULTS,
        max_turn_seconds: entry(3600, false, true),
      })),
    );
    const area = await sectionOf("턴 시간");
    const status = within(area).getByRole("status").textContent ?? "";
    expect(status).toContain("MAX_TURN_SECONDS");
    expect(status).toContain("값을 저장할 때까지 새 작업자를 띄우지 않습니다.");
    const retries = await sectionOf("모델 요청 재시도");
    expect(within(retries).queryByRole("status") === null).toBe(true);
  });
});

describe("설정 › 실행 한도의 작업 공간 용량", () => {
  test("고른 동작을 그 키만 보내 저장한다", async () => {
    let current = DEFAULTS;
    const { api } = renderAt(PAGE, {
      ...routes(() => current),
      [`PATCH ${API}`]: () => {
        current = {
          ...DEFAULTS,
          workspace_enforce: {
            ...entry("fail" as const, true),
            default: "warn",
          },
        };
        return json(200, { ...current, receipt_id: RECEIPT });
      },
    });
    const user = await setupUser();
    const area = await sectionOf("작업 공간 용량");
    const select = within(area).getByRole("combobox", {
      name: "용량을 넘으면",
    }) as HTMLSelectElement;
    expect(select.value).toBe("warn");
    expect(area.textContent).toContain(
      "저장한 값이 없어 기본값(기록만 남김)을 씁니다.",
    );
    await user.selectOptions(select, "fail");
    await user.click(saveButton());
    await screen.findByText("작업 공간 용량 설정을 저장했습니다.");
    expect(api.calls.find((call) => call.method === "PATCH")?.body).toEqual({
      workspace_enforce: "fail",
    });
    expect(select.value).toBe("fail");
    within(area).getByRole("button", { name: "기본값으로" });
  });
});

describe("설정 › 실행 한도의 세션 기록 보관", () => {
  const archiveSection = () => sectionOf("세션 기록 보관");
  const days = (area: HTMLElement) =>
    within(area).getByRole("spinbutton", {
      name: "보관까지 쉰 기간 (일)",
    }) as HTMLInputElement;
  const mode = (area: HTMLElement) =>
    within(area).getByRole("combobox", {
      name: "보관 작업이 할 일",
    }) as HTMLSelectElement;

  test("기본값은 180일 세기만이고, 바꾼 키만 한 번에 보낸다", async () => {
    let current = DEFAULTS;
    const { api } = renderAt(PAGE, {
      ...routes(() => current),
      [`PATCH ${API}`]: () => {
        current = {
          ...DEFAULTS,
          session_archive_dry_run: { ...entry(false, true), default: true },
        };
        return json(200, { ...current, receipt_id: RECEIPT });
      },
    });
    const user = await setupUser();
    const area = await archiveSection();
    expect(days(area).value).toBe("180");
    expect(mode(area).value).toBe("count");
    expect(area.textContent).toContain(
      "저장한 값이 없어 기본값(180일)을 씁니다.",
    );
    expect(area.textContent).toContain(
      "저장한 값이 없어 기본값(세기만 함)을 씁니다.",
    );
    expect(within(area).queryByRole("status") === null).toBe(true);
    await user.selectOptions(mode(area), "move");
    await user.click(saveButton());
    await screen.findByText("세션 기록 보관 설정을 저장했습니다.");
    expect(api.calls.find((call) => call.method === "PATCH")?.body).toEqual({
      session_archive_dry_run: false,
    });
    expect(mode(area).value).toBe("move");
    within(area).getByRole("button", { name: "기본값으로" });
  });

  test("0은 보관하지 않음으로 저장하고, 29일은 보내지 않는다", async () => {
    let current = DEFAULTS;
    const { api } = renderAt(PAGE, {
      ...routes(() => current),
      [`PATCH ${API}`]: () => {
        current = {
          ...DEFAULTS,
          session_archive_after_days: { ...entry(0, true), default: 180 },
        };
        return json(200, { ...current, receipt_id: RECEIPT });
      },
    });
    const user = await setupUser();
    const area = await archiveSection();
    await user.clear(days(area));
    await user.type(days(area), "29");
    await user.click(saveButton());
    expect(area.textContent).toContain(
      "0(보관하지 않음) 또는 30부터 3,650까지의 정수(일)를 적으세요.",
    );
    expect(document.activeElement === days(area)).toBe(true);
    expect(api.calls.some((call) => call.method === "PATCH")).toBe(false);
    await user.clear(days(area));
    await user.type(days(area), "0");
    await user.click(saveButton());
    await screen.findByText("세션 기록 보관 설정을 저장했습니다.");
    expect(api.calls.find((call) => call.method === "PATCH")?.body).toEqual({
      session_archive_after_days: 0,
    });
    expect(days(area).value).toBe("0");
    screen.getByText("저장하지 않은 변경이 없습니다.");
  });

  test("서버가 보관 작업만 거절하면 그 선택에만 이유를 두고 포커스를 옮긴다", async () => {
    renderAt(PAGE, {
      ...routes(() => DEFAULTS),
      [`PATCH ${API}`]: () =>
        apiError(400, "BAD_REQUEST", "Request body is invalid", false, {
          issues: [{ path: "session_archive_dry_run", message: "no" }],
        }),
    });
    const user = await setupUser();
    const area = await archiveSection();
    await user.clear(days(area));
    await user.type(days(area), "90");
    await user.selectOptions(mode(area), "move");
    await user.click(saveButton());
    await waitFor(() =>
      expect(mode(area).getAttribute("aria-invalid")).toBe("true"),
    );
    expect(document.activeElement === mode(area)).toBe(true);
    expect(days(area).getAttribute("aria-invalid")).toBe(null);
    expect(area.textContent).not.toContain(
      "0(보관하지 않음) 또는 30부터 3,650까지의 정수(일)를 적으세요.",
    );
    const error = (mode(area).getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id))
      .find((element) => element?.getAttribute("role") === "alert");
    expect((error?.textContent ?? "").length).toBeGreaterThan(0);
    expect(days(area).value).toBe("90");
    expect(mode(area).value).toBe("move");
  });

  test("보관할 수 없는 설치는 이유를 알리고, 저장한 뒤에도 그 안내가 남는다", async () => {
    const unavailable: InstallationConfig = {
      ...DEFAULTS,
      session_archive: { available: false, reason: "object_store_disabled" },
    };
    let current = unavailable;
    renderAt(PAGE, {
      ...routes(() => current),
      [`PATCH ${API}`]: () => {
        current = {
          ...unavailable,
          session_archive_after_days: { ...entry(90, true), default: 180 },
        };
        return json(200, { ...current, receipt_id: RECEIPT });
      },
    });
    const user = await setupUser();
    const area = await archiveSection();
    const notice = "CHECKPOINT_OBJECT_STORE=disabled";
    expect(within(area).getByRole("status").textContent).toContain(notice);
    const described = (days(area).getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(described).toContain(notice);
    await user.clear(days(area));
    await user.type(days(area), "90");
    await user.click(saveButton());
    await screen.findByText("세션 기록 보관 설정을 저장했습니다.");
    expect(days(area).value).toBe("90");
    expect(within(area).getByRole("status").textContent).toContain(notice);
  });

  test("막힌 키는 그 변수 이름과 보관 작업이 실패로 끝난다는 것을 알리고, 보이는 값 그대로 저장할 수 있다", async () => {
    let current: InstallationConfig = {
      ...DEFAULTS,
      session_archive_after_days: entry(180, false, true),
    };
    const { api } = renderAt(PAGE, {
      ...routes(() => current),
      [`PATCH ${API}`]: () => {
        current = {
          ...DEFAULTS,
          session_archive_after_days: entry(180, true),
        };
        return json(200, { ...current, receipt_id: RECEIPT });
      },
    });
    const user = await setupUser();
    const area = await archiveSection();
    const status = within(area).getByRole("status").textContent ?? "";
    expect(status).toContain("SESSION_ARCHIVE_AFTER_DAYS");
    expect(status).toContain(
      "값을 저장할 때까지 보관 작업이 아무것도 옮기지 않고 실패로 끝납니다.",
    );
    await user.click(saveButton());
    await screen.findByText("세션 기록 보관 설정을 저장했습니다.");
    expect(api.calls.find((call) => call.method === "PATCH")?.body).toEqual({
      session_archive_after_days: 180,
    });
  });
});

describe("설정 › 실행 한도의 한 번 저장", () => {
  const COST = "세션 비용 한도 (USD)";
  const COST_INVALID = "0보다 크고 1,000,000 이하인 금액(USD)을 적으세요.";

  test("저장 버튼은 하나이고, 한 번 누르면 바꾼 칸만 한 요청에 모두 보낸다", async () => {
    let current = DEFAULTS;
    const { api } = renderAt(PAGE, {
      ...routes(() => current),
      [`PATCH ${API}`]: () => {
        current = {
          ...DEFAULTS,
          pending_request_ttl_sec: { ...entry(3600, true), default: 1800 },
          session_cost_limit_usd: { ...entry(12.5, true), default: 25 },
        };
        return json(200, { ...current, receipt_id: RECEIPT });
      },
    });
    const user = await setupUser();
    const wait = await section();
    const cost = await sectionOf("세션 비용");
    await waitFor(() => expect(field(wait).value).toBe("1800"));
    expect(screen.getAllByRole("button", { name: "저장" })).toHaveLength(1);
    await user.clear(field(wait));
    await user.type(field(wait), "3600");
    await user.clear(field(cost, COST));
    await user.type(field(cost, COST), "12.5");
    screen.getByText("저장하지 않은 한도 2개");
    await user.click(saveButton());
    await screen.findByText("한도 2개를 저장했습니다.");
    const patches = api.calls.filter((call) => call.method === "PATCH");
    expect(patches.map((call) => call.body)).toEqual([
      { pending_request_ttl_sec: 3600, session_cost_limit_usd: 12.5 },
    ]);
    expect(field(wait).value).toBe("3600");
    expect(field(cost, COST).value).toBe("12.5");
    screen.getByText("저장하지 않은 변경이 없습니다.");
  });

  test("한 칸이라도 틀리면 아무것도 보내지 않고, 그 칸에만 이유를 두고 다른 칸의 값은 남긴다", async () => {
    const { api } = renderAt(PAGE, {
      ...routes(() => DEFAULTS),
      [`PATCH ${API}`]: () => json(200, { ...DEFAULTS, receipt_id: RECEIPT }),
    });
    const user = await setupUser();
    const wait = await section();
    const cost = await sectionOf("세션 비용");
    await waitFor(() => expect(field(wait).value).toBe("1800"));
    await user.clear(field(cost, COST));
    await user.type(field(cost, COST), "12.5");
    await user.clear(field(wait));
    await user.type(field(wait), "0");
    await user.click(saveButton());
    await waitFor(() => expect(wait.textContent).toContain(INVALID));
    expect(field(wait).getAttribute("aria-invalid")).toBe("true");
    expect(cost.textContent).not.toContain(COST_INVALID);
    expect(field(cost, COST).getAttribute("aria-invalid")).toBe(null);
    expect(document.activeElement === field(wait)).toBe(true);
    expect(field(cost, COST).value).toBe("12.5");
    expect(api.calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  test("서버가 한 칸을 거절하면 그 칸에 이유를 두고, 아무것도 저장되지 않았다고 알리고, 모든 입력을 남긴다", async () => {
    let refuse = true;
    let current = DEFAULTS;
    const { api } = renderAt(PAGE, {
      ...routes(() => current),
      [`PATCH ${API}`]: () => {
        if (refuse) {
          return apiError(
            400,
            "BAD_REQUEST",
            "Request body is invalid",
            false,
            {
              issues: [{ path: "session_cost_limit_usd", message: "too big" }],
            },
          );
        }
        current = {
          ...DEFAULTS,
          pending_request_ttl_sec: { ...entry(60, true), default: 1800 },
          session_cost_limit_usd: { ...entry(30, true), default: 25 },
        };
        return json(200, { ...current, receipt_id: RECEIPT });
      },
    });
    const user = await setupUser();
    const wait = await section();
    const cost = await sectionOf("세션 비용");
    await waitFor(() => expect(field(wait).value).toBe("1800"));
    await user.clear(field(wait));
    await user.type(field(wait), "60");
    await user.clear(field(cost, COST));
    await user.type(field(cost, COST), "40");
    await user.click(saveButton());
    await waitFor(() => expect(cost.textContent).toContain(COST_INVALID));
    screen.getByText(
      "저장하지 못했습니다. 표시한 칸을 고친 뒤 다시 저장하세요. 다른 칸의 값도 아직 저장되지 않았습니다.",
    );
    expect(wait.textContent).not.toContain(INVALID);
    expect(document.activeElement === field(cost, COST)).toBe(true);
    expect(field(wait).value).toBe("60");
    expect(field(cost, COST).value).toBe("40");
    screen.getByText("저장하지 않은 한도 2개");

    refuse = false;
    await user.clear(field(cost, COST));
    await user.type(field(cost, COST), "30");
    expect(cost.textContent).not.toContain(COST_INVALID);
    await user.click(saveButton());
    await screen.findByText("한도 2개를 저장했습니다.");
    expect(
      api.calls
        .filter((call) => call.method === "PATCH")
        .map((call) => call.body),
    ).toEqual([
      { pending_request_ttl_sec: 60, session_cost_limit_usd: 40 },
      { pending_request_ttl_sec: 60, session_cost_limit_usd: 30 },
    ]);
  });

  test("권한 같은 다른 이유로 거절되면 그 이유를 알리고 입력을 남긴다", async () => {
    renderAt(PAGE, {
      ...routes(() => DEFAULTS),
      [`PATCH ${API}`]: () => apiError(403, "FORBIDDEN", "no", false),
    });
    const user = await setupUser();
    const wait = await section();
    await waitFor(() => expect(field(wait).value).toBe("1800"));
    await user.clear(field(wait));
    await user.type(field(wait), "60");
    await user.click(saveButton());
    await waitFor(() =>
      expect(screen.getAllByRole("alert").length).toBeGreaterThan(0),
    );
    expect(within(wait).queryByRole("alert") === null).toBe(true);
    expect(field(wait).value).toBe("60");
  });
});

describe("설정 › 실행 한도의 문구", () => {
  test("한국어 문구는 내부 이름이나 영어 용어 대신 우리말과 용어집의 말을 쓴다", () => {
    const english =
      /\b(control host|worker|scheduler|checkpoint|object store|object|restore|volume)\b/;
    const found = Object.entries(executionLimitsKo)
      .filter(([, text]) => english.test(text))
      .map(([key]) => key);
    expect(found).toEqual([]);
  });

  test("영어 부제는 두 문장으로, 무엇인지와 전에는 어디서 정했는지를 말한다", () => {
    expect(executionLimitsEn["limits.description"]).toBe(
      "These limits apply to every workspace of this installation. They used to be set with server environment variables.",
    );
  });
});

describe("archiveDaysOf", () => {
  test("takes 0 and whole days in the archive's range only", () => {
    expect(archiveDaysOf("0")).toBe(0);
    expect(archiveDaysOf(" 30 ")).toBe(30);
    expect(archiveDaysOf("3650")).toBe(3650);
    for (const refused of ["", "29", "3651", "45.5", "-30", "3e1", "abc"]) {
      expect(archiveDaysOf(refused)).toBe(null);
    }
  });
});

describe("limitValueOf", () => {
  const wait = NUMBER_LIMITS.find(
    (limit) => limit.key === "pending_request_ttl_sec",
  ) as NumberLimit;

  test("takes plain decimals in the server's range only", () => {
    expect(limitValueOf(wait, " 90 ")).toBe(90);
    expect(limitValueOf(wait, "604800")).toBe(604_800);
    for (const refused of ["", "0", "604801", "1.5", "-1", "1e3", "30m"]) {
      expect(limitValueOf(wait, refused)).toBe(null);
    }
  });

  test("each range and variable name equals the contract's", async () => {
    const { INSTALLATION_CONFIG, INSTALLATION_CONFIG_KEYS } = await import(
      "@werft-ai/contracts"
    );
    expect(
      [
        ...NUMBER_LIMITS.map((limit) => limit.key),
        "workspace_enforce",
        "session_archive_after_days",
        "session_archive_dry_run",
      ].sort(),
    ).toEqual([...INSTALLATION_CONFIG_KEYS].sort());
    const archive = INSTALLATION_CONFIG.session_archive_after_days;
    expect(ARCHIVE_DAYS.env).toBe(archive.env);
    expect(ARCHIVE_DRY_RUN_ENV).toBe(
      INSTALLATION_CONFIG.session_archive_dry_run.env,
    );
    for (const probe of [
      0,
      1,
      ARCHIVE_DAYS.min - 1,
      ARCHIVE_DAYS.min,
      ARCHIVE_DAYS.max,
      ARCHIVE_DAYS.max + 1,
    ]) {
      expect([probe, archiveDaysOf(`${probe}`) !== null]).toEqual([
        probe,
        archive.schema.safeParse(probe).success,
      ]);
    }
    for (const limit of NUMBER_LIMITS) {
      const rule = INSTALLATION_CONFIG[limit.key];
      expect(limit.env).toBe(rule.env);
      const probes = [
        limit.min - 1,
        limit.min,
        limit.min + 0.5,
        limit.min + 1,
        limit.max - 0.5,
        limit.max,
        limit.max + 1,
      ];
      for (const probe of probes) {
        const text = probe.toFixed(probe % 1 === 0 ? 0 : 1);
        if (text.startsWith("-")) continue;
        expect([limit.key, text, limitValueOf(limit, text) !== null]).toEqual([
          limit.key,
          text,
          rule.schema.safeParse(Number(text)).success,
        ]);
      }
    }
    const enforce = INSTALLATION_CONFIG.workspace_enforce;
    expect(ENFORCE_ENV).toBe(enforce.env);
    for (const value of ENFORCE_VALUES) {
      expect(enforce.schema.safeParse(value).success).toBe(true);
    }
    expect(enforce.schema.options).toEqual([...ENFORCE_VALUES]);
  });
});
