import { describe, expect, test } from "bun:test";
import type { InstallationConfig } from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { apiError, json, me } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";
import {
  PENDING_REQUEST_TTL_SEC_MAX,
  waitSecondsOf,
} from "./execution-limits.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const PAGE = "/settings/workspace/limits";
const API = "/v1/installation-config";
const RECEIPT = "019a0000-0000-7000-8000-0000000000e1";
const LABEL = "응답 대기 시간 (초)";
const INVALID = `1부터 ${PENDING_REQUEST_TTL_SEC_MAX}까지의 정수(초)를 적으세요.`;

const config = (value: number, saved: boolean): InstallationConfig => ({
  pending_request_ttl_sec: { value, default: 1800, saved },
});

const routes = (
  current: () => InstallationConfig,
  role: "owner" | "admin" = "owner",
) => ({
  "GET /v1/auth/me": () => json(200, me(undefined, role)),
  [`GET ${API}`]: () => json(200, current()),
});

const section = async () =>
  (await screen.findByRole("heading", { name: "사람 응답" })).closest(
    "section",
  ) as HTMLElement;
const field = (area: HTMLElement) =>
  within(area).getByRole("spinbutton", { name: LABEL }) as HTMLInputElement;

describe("설정 › 실행 한도의 응답 대기 시간", () => {
  test("저장한 값이 없으면 기본값을 보여 주고 그렇다고 적는다", async () => {
    renderAt(
      PAGE,
      routes(() => config(1800, false)),
    );
    const area = await section();
    await waitFor(() => expect(field(area).value).toBe("1800"));
    expect(area.textContent).toContain(
      "저장한 값이 없어 기본값 1800초를 씁니다.",
    );
    expect(
      within(area).queryByRole("button", { name: "기본값으로" }) === null,
    ).toBe(true);
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
    expect(area.textContent).toContain("기본값은 1800초입니다.");
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

describe("waitSecondsOf", () => {
  test("takes whole seconds in the server's range only", () => {
    expect(waitSecondsOf(" 90 ")).toBe(90);
    expect(waitSecondsOf("604800")).toBe(604_800);
    for (const refused of ["", "0", "604801", "1.5", "-1", "1e3", "30m"]) {
      expect(waitSecondsOf(refused)).toBe(null);
    }
  });

  test("the range equals the contract's", async () => {
    const { PENDING_REQUEST_TTL_SEC_MAX: contract } = await import(
      "@werft-ai/contracts"
    );
    expect(PENDING_REQUEST_TTL_SEC_MAX).toBe(contract);
  });
});
