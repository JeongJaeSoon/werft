import { describe, expect, test } from "bun:test";
import type { InstallationConfig } from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { apiError, json, me } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";
import {
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

const sectionOf = async (title: string) =>
  (await screen.findByRole("heading", { name: title })).closest(
    "section",
  ) as HTMLElement;
const section = () => sectionOf("사람 응답");
const field = (area: HTMLElement, label = LABEL) =>
  within(area).getByRole("spinbutton", { name: label }) as HTMLInputElement;

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
    await user.click(within(area).getByRole("button", { name: "저장" }));
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
    await user.click(within(area).getByRole("button", { name: "저장" }));
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
    await user.click(within(area).getByRole("button", { name: "저장" }));
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
    await user.click(within(area).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(area.textContent).toContain(INVALID));
    expect(document.activeElement === field(area)).toBe(true);
  });

  test("owner가 아닌 admin에게는 권한 없음 화면만 보이고 설정을 읽지 않는다", async () => {
    const { api } = renderAt(
      PAGE,
      routes(() => config(1800, false), "admin"),
    );
    await screen.findByRole("heading", { name: "실행 한도" });
    expect(screen.queryByRole("heading", { name: "사람 응답" }) === null).toBe(
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
    await user.click(within(area).getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(area.textContent).toContain(
        "0보다 크고 1,000,000 이하인 금액(USD)을 적으세요.",
      ),
    );
    expect(api.calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
    await user.clear(cost());
    await user.type(cost(), "12.5");
    await user.click(within(area).getByRole("button", { name: "저장" }));
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
    expect(
      within(area)
        .getByRole("button", { name: "저장" })
        .getAttribute("aria-disabled"),
    ).toBe(null);
    const queue = await sectionOf("대기 메시지");
    expect(within(queue).queryByRole("status") === null).toBe(true);
    expect(
      within(queue)
        .getByRole("button", { name: "저장" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
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
    await user.click(within(area).getByRole("button", { name: "저장" }));
    await screen.findByText("작업 공간 용량 설정을 저장했습니다.");
    expect(api.calls.find((call) => call.method === "PATCH")?.body).toEqual({
      workspace_enforce: "fail",
    });
    expect(select.value).toBe("fail");
    within(area).getByRole("button", { name: "기본값으로" });
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
      [...NUMBER_LIMITS.map((limit) => limit.key), "workspace_enforce"].sort(),
    ).toEqual([...INSTALLATION_CONFIG_KEYS].sort());
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
