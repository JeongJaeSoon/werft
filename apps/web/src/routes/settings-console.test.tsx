import { describe, expect, test } from "bun:test";
import type {
  SettingsConnection,
  SettingsMcpServer,
} from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { json, me } from "../test-support/fake-api.ts";
import { imported } from "../test-support/profiles.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { act, renderAt, screen, waitFor, within } = await appHarness();

const CONNECTIONS_PAGE = "/settings/workspace/connections";

const CHANGE = (id: string) => ({
  id,
  receipt_id: "019a0000-0000-7000-8000-0000000000f1",
});

const AT = "2026-10-01T00:00:00.000Z";

const connection = (
  id: string,
  rest: Partial<SettingsConnection> = {},
): SettingsConnection => ({
  id,
  origin: "console",
  state: "active",
  kind: "anthropic",
  endpoint: "https://api.anthropic.com",
  billing: "per_token",
  auth_kind: "api_key",
  credential: { source: "stored", last4: "abcd" },
  created_at: AT,
  disabled_at: null,
  ...rest,
});

const mcp = (
  id: string,
  rest: Partial<SettingsMcpServer> = {},
): SettingsMcpServer => ({
  id,
  origin: "console",
  state: "active",
  url: "https://mcp.example.com/sse",
  credential_ref: "docs",
  workspaces: ["acme"],
  credential: { source: "stored", last4: "wxyz" },
  created_at: AT,
  disabled_at: null,
  ...rest,
});

const CONNECTIONS = "/v1/installation/settings/connections";
const MCP = "/v1/installation/settings/mcp-servers";

const rowOf = (table: HTMLElement, id: string) => {
  const row = within(table)
    .getAllByRole("row")
    .find((item) => item.textContent?.startsWith(id));
  if (row === undefined) throw new Error(`no row ${id}`);
  return row;
};

/** A dialog's field by its form name, for labels these tests do not spell. */
const named = (dialog: HTMLElement, name: string) => {
  const input = dialog.querySelector<HTMLElement>(`[name="${name}"]`);
  if (input === null) throw new Error(`no field ${name}`);
  return input;
};

const writes = <C extends { readonly method: string }>(calls: readonly C[]) =>
  calls.filter((call) => call.method !== "GET");

/** No row action sits in a cell the narrow layout hides. */
const expectNarrowActions = (table: HTMLElement) => {
  const buttons = within(table).getAllByRole("button");
  expect(buttons.length).toBeGreaterThan(0);
  for (const button of buttons) {
    expect(button.closest('[role="cell"]')?.className ?? "").not.toContain(
      ":hidden",
    );
  }
};

describe("모델 연결", () => {
  const listed = [
    connection("anthropic", {
      origin: "import",
      credential: { source: "external", value_env: "ANTHROPIC_API_KEY" },
    }),
    connection("console-key"),
    connection("ops-ref", {
      origin: "import",
      credential: { source: "external", secret_id: "ops/anthropic" },
    }),
    connection("fresh", {
      credential: { source: "stored", last4: null },
      state: "needs_value",
    }),
  ];

  const routes = (
    signedIn = me(),
    hosts: string[] | null = null,
    defaults: Record<string, string> = {},
  ) => ({
    "GET /v1/auth/me": () => json(200, signedIn),
    "GET /v1/profiles": () =>
      json(200, { items: [imported("coding-claude"), imported("general")] }),
    [`GET ${CONNECTIONS}`]: () =>
      json(200, {
        items: listed,
        credential_hosts: hosts,
        endpoint_defaults: defaults,
      }),
  });

  test("an untouched default is not sent, so the server's own checks on it still run", async () => {
    const { api } = renderAt(CONNECTIONS_PAGE, {
      ...routes(me(), null, { anthropic: "https://api.anthropic.com" }),
      [`POST ${CONNECTIONS}`]: () => json(201, CHANGE("free")),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "연결 추가" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("id"), "free");
    await user.selectOptions(
      within(dialog).getByLabelText("비용 집계"),
      "none",
    );
    await user.type(within(dialog).getByLabelText("키 값"), "example-key");
    await user.click(within(dialog).getByRole("button", { name: "만들기" }));
    await screen.findByText("free를 만들었습니다.");
    expect(writes(api.calls).map((call) => call.body)).toEqual([
      {
        id: "free",
        kind: "anthropic",
        billing: "none",
        auth_kind: "api_key",
        value: "example-key",
      },
    ]);
  });

  test("a kind with no default address refuses an empty endpoint at the field, without a request", async () => {
    const { api } = renderAt(CONNECTIONS_PAGE, {
      ...routes(me(), null, { anthropic: "https://api.anthropic.com" }),
      [`POST ${CONNECTIONS}`]: () => json(201, CHANGE("proxy")),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "연결 추가" }));
    const dialog = await screen.findByRole("dialog");
    await user.selectOptions(within(dialog).getByLabelText("종류"), "litellm");
    await user.type(within(dialog).getByLabelText("id"), "proxy");
    await user.type(within(dialog).getByLabelText("키 값"), "example-key");
    const endpoint =
      within(dialog).getByLabelText<HTMLInputElement>("엔드포인트");
    expect(endpoint.getAttribute("aria-invalid")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "만들기" }));
    expect(
      await within(dialog).findByText(
        "litellm에는 기본 주소가 없습니다. 엔드포인트를 입력하세요.",
      ),
    ).toBeTruthy();
    expect(endpoint.getAttribute("aria-invalid")).toBe("true");
    expect(writes(api.calls)).toEqual([]);

    // Typing clears the message.
    await user.type(endpoint, "https://llm.internal:8443/v1");
    expect(endpoint.getAttribute("aria-invalid")).toBeNull();
  });

  test("a kind with an official address starts with it filled in; what the person typed survives a kind change", async () => {
    const OFFICIAL = "https://api.anthropic.com";
    const { api } = renderAt(CONNECTIONS_PAGE, {
      ...routes(me(), null, { anthropic: OFFICIAL }),
      [`POST ${CONNECTIONS}`]: () => json(201, CHANGE("official")),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "연결 추가" }));
    const dialog = await screen.findByRole("dialog");
    const endpoint =
      within(dialog).getByLabelText<HTMLInputElement>("엔드포인트");
    const kind = within(dialog).getByLabelText("종류");
    expect(endpoint.value).toBe(OFFICIAL);
    expect(endpoint.required).toBe(false);

    // The default is not the person's: a kind without one empties the field.
    await user.selectOptions(kind, "litellm");
    expect(endpoint.value).toBe("");
    await user.selectOptions(kind, "anthropic");
    expect(endpoint.value).toBe(OFFICIAL);

    // A typed value stays when the kind changes, both ways.
    await user.clear(endpoint);
    await user.type(endpoint, "https://proxy.example.com");
    await user.selectOptions(kind, "litellm");
    expect(endpoint.value).toBe("https://proxy.example.com");
    await user.selectOptions(kind, "anthropic");
    expect(endpoint.value).toBe("https://proxy.example.com");

    // Typing the official address is still typing: it survives too.
    await user.clear(endpoint);
    await user.type(endpoint, OFFICIAL);
    await user.selectOptions(kind, "litellm");
    expect(endpoint.value).toBe(OFFICIAL);
    await user.selectOptions(kind, "anthropic");

    // Cleared, the request leaves the endpoint out for the server's default.
    await user.clear(endpoint);
    await user.type(within(dialog).getByLabelText("id"), "official");
    await user.type(within(dialog).getByLabelText("키 값"), "example-key");
    await user.click(within(dialog).getByRole("button", { name: "만들기" }));
    await screen.findByText("official를 만들었습니다.");
    expect(
      writes(api.calls).map((call) => [call.method, call.path, call.body]),
    ).toEqual([
      [
        "POST",
        CONNECTIONS,
        {
          id: "official",
          kind: "anthropic",
          billing: "per_token",
          auth_kind: "api_key",
          value: "example-key",
        },
      ],
    ]);
  });

  test("the owner sees imported and console connections alike, and what each may do", async () => {
    renderAt(CONNECTIONS_PAGE, routes());
    const table = await screen.findByRole("table", { name: "모델 연결" });
    const imported = rowOf(table, "anthropic");
    expect(imported.textContent).toContain("환경 변수 ANTHROPIC_API_KEY");
    // Both ceilings run over it.
    expect(imported.textContent).toContain("프로필 2개");
    expect(imported.textContent).not.toContain("파일");

    const stored = rowOf(table, "console-key");
    expect(stored.textContent).toContain("••••abcd");
    expect(
      within(stored)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["console-key 값 바꾸기", "console-key 사용 중지"]);

    // An operator reference: no replace, but it can move to a typed key.
    const ref = rowOf(table, "ops-ref");
    expect(
      within(ref)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["ops-ref 화면에서 키 넣기", "ops-ref 사용 중지"]);

    const fresh = rowOf(table, "fresh");
    expect(fresh.textContent).toContain("값 필요");
    expect(
      within(fresh).getByRole("button", { name: "fresh 값 바꾸기" })
        .textContent,
    ).toBe("값 넣기");
  });

  test("a narrow table keeps every row's actions and puts the state beside the id", async () => {
    renderAt(CONNECTIONS_PAGE, routes());
    const table = await screen.findByRole("table", { name: "모델 연결" });
    expectNarrowActions(table);
    const id = within(rowOf(table, "fresh")).getAllByRole("cell")[0];
    expect(id?.textContent).toContain("값 필요");
  });

  test("adding one stores the key, says the address cannot change, and warns when its host is off the egress allowlist", async () => {
    const { api } = renderAt(CONNECTIONS_PAGE, {
      ...routes(me(), ["api.anthropic.com:443"]),
      [`POST ${CONNECTIONS}`]: () => json(201, CHANGE("litellm-proxy")),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "연결 추가" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("바꾸려면 새 id로 만드세요");
    // Anthropic takes an API key only.
    expect(within(dialog).queryByLabelText("인증 방식")).toBeNull();
    await user.type(within(dialog).getByLabelText("id"), "litellm-proxy");
    await user.selectOptions(within(dialog).getByLabelText("종류"), "litellm");
    const endpoint = within(dialog).getByLabelText("엔드포인트");
    await user.type(endpoint, "https://api.anthropic.com");
    expect(within(dialog).queryByRole("status")).toBeNull();
    await user.clear(endpoint);
    await user.type(endpoint, "https://llm.internal:8443/v1");
    expect(within(dialog).getByRole("status").textContent).toContain(
      "llm.internal:8443는 egress",
    );
    await user.selectOptions(
      within(dialog).getByLabelText("인증 방식"),
      "bearer",
    );
    await user.type(within(dialog).getByLabelText("키 값"), "example-key");
    await user.click(within(dialog).getByRole("button", { name: "만들기" }));
    await screen.findByText("litellm-proxy를 만들었습니다.");
    expect(
      writes(api.calls).map((call) => [call.method, call.path, call.body]),
    ).toEqual([
      [
        "POST",
        CONNECTIONS,
        {
          id: "litellm-proxy",
          kind: "litellm",
          endpoint: "https://llm.internal:8443/v1",
          billing: "per_token",
          auth_kind: "bearer",
          value: "example-key",
        },
      ],
    ]);
  });

  test("without the allowlist known, nothing warns", async () => {
    renderAt(CONNECTIONS_PAGE, routes(me(), null));
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "연결 추가" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(
      within(dialog).getByLabelText("엔드포인트"),
      "https://elsewhere.example.com",
    );
    expect(within(dialog).queryByRole("status")).toBeNull();
  });

  test("a new value and a disable each go to their own route; disabling asks first", async () => {
    const { api } = renderAt(CONNECTIONS_PAGE, {
      ...routes(),
      [`POST ${CONNECTIONS}/console-key/credential`]: () =>
        json(200, CHANGE("console-key")),
      [`POST ${CONNECTIONS}/console-key/disable`]: () =>
        json(200, CHANGE("console-key")),
    });
    const user = await setupUser();
    const table = await screen.findByRole("table", { name: "모델 연결" });
    await user.click(
      within(table).getByRole("button", { name: "console-key 값 바꾸기" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("값"), "rotated-key");
    await user.click(within(dialog).getByRole("button", { name: "저장" }));
    await screen.findByText("console-key의 값을 바꿨습니다.");

    await user.click(
      within(table).getByRole("button", { name: "console-key 사용 중지" }),
    );
    const confirm = await screen.findByRole("dialog");
    expect(confirm.textContent).toContain(
      "지금은 사용 중지한 연결을 다시 켤 수 없습니다.",
    );
    expect(writes(api.calls).length).toBe(1);
    await user.click(
      within(confirm).getByRole("button", { name: "사용 중지" }),
    );
    await screen.findByText("console-key를 사용 중지했습니다.");
    expect(writes(api.calls).map((call) => [call.path, call.body])).toEqual([
      [`${CONNECTIONS}/console-key/credential`, { value: "rotated-key" }],
      [`${CONNECTIONS}/console-key/disable`, null],
    ]);
  });

  describe("disabling reads what it would leave without a model", () => {
    const IMPACT = `${CONNECTIONS}/console-key/impact`;
    const DISABLE = `${CONNECTIONS}/console-key/disable`;
    const counts = (over: Record<string, unknown> = {}) => ({
      id: "console-key",
      profile_count: 0,
      agent_count: 0,
      session_count: 0,
      judge_used: false,
      ...over,
    });
    const impactCalls = (calls: readonly { path: string }[]) =>
      calls.filter((call) => call.path.endsWith("/impact"));

    async function openDisable(
      impact: () => Response | Promise<Response>,
      validate: "strict" | "warn" = "strict",
    ) {
      const rendered = renderAt(
        CONNECTIONS_PAGE,
        {
          ...routes(),
          [`GET ${IMPACT}`]: impact,
          [`POST ${DISABLE}`]: () => json(200, CHANGE("console-key")),
        },
        "ko",
        validate,
      );
      const user = await setupUser();
      const table = await screen.findByRole("table", { name: "모델 연결" });
      // Nothing is read for a table nobody is disabling from.
      expect(impactCalls(rendered.api.calls)).toEqual([]);
      await user.click(
        within(table).getByRole("button", { name: "console-key 사용 중지" }),
      );
      const confirm = await screen.findByRole("dialog");
      return { ...rendered, user, table, confirm };
    }

    test("a count above zero warns with each number, and disabling still goes through", async () => {
      const { api, user, confirm } = await openDisable(() =>
        json(
          200,
          counts({ profile_count: 2, agent_count: 3, session_count: 1 }),
        ),
      );
      const warning = await within(confirm).findByRole("alert");
      expect(warning.textContent).toContain("거절되거나 끊길 수 있습니다");
      expect(warning.textContent).toContain("프로필: 2개");
      expect(warning.textContent).toContain("에이전트: 3개");
      expect(warning.textContent).toContain("끝나지 않은 세션: 1개");
      expect(warning.textContent).not.toContain("성과 판정");
      expect(impactCalls(api.calls).length).toBe(1);
      await user.click(
        within(confirm).getByRole("button", { name: "사용 중지" }),
      );
      await screen.findByText("console-key를 사용 중지했습니다.");
      expect(writes(api.calls).map((call) => call.path)).toEqual([DISABLE]);
    });

    // A retired version still runs what was started on it, so the profile
    // count alone cannot decide whether to warn.
    for (const [name, over, line] of [
      ["agents", { agent_count: 2 }, "에이전트: 2개"],
      ["sessions", { session_count: 1 }, "끝나지 않은 세션: 1개"],
    ] as const) {
      test(`${name} alone warn, with no profile counted`, async () => {
        const { confirm } = await openDisable(() => json(200, counts(over)));
        const warning = await within(confirm).findByRole("alert");
        expect(warning.textContent).not.toContain("프로필:");
        expect(warning.textContent).toContain(line);
      });
    }

    test("a refetch that fails is a failed check, not the numbers of the read before it", async () => {
      let reads = 0;
      const { api, confirm } = await openDisable(() => {
        reads += 1;
        return reads === 1
          ? json(200, counts({ profile_count: 4 }))
          : json(500, { code: "INTERNAL", message: "boom", details: null });
      });
      await within(confirm).findByRole("alert");
      // Back on the window: React Query reads the stale count again.
      await act(async () => {
        window.dispatchEvent(new Event("visibilitychange"));
      });
      await within(confirm).findByText(/확인하지 못했습니다/);
      expect(impactCalls(api.calls).length).toBe(2);
      expect(within(confirm).queryByText(/프로필: 4개/)).toBeNull();
    });

    test("a judge setting alone warns, without a word about a judgment stopping", async () => {
      const { confirm } = await openDisable(() =>
        json(200, counts({ judge_used: true })),
      );
      const warning = await within(confirm).findByRole("alert");
      expect(warning.textContent).toContain(
        "성과 판정 설정이 이 연결을 가리키고 있습니다.",
      );
      expect(warning.textContent).not.toContain("프로필:");
    });

    test("zero everywhere asks as before, with no warning and no failure line", async () => {
      const { api, confirm } = await openDisable(() => json(200, counts()));
      await waitFor(() => expect(impactCalls(api.calls).length).toBe(1));
      await waitFor(() =>
        expect(within(confirm).queryByText("영향을 확인하는 중…")).toBeNull(),
      );
      expect(within(confirm).queryByRole("alert")).toBeNull();
      expect(confirm.textContent).not.toContain("확인하지 못했습니다");
      expect(confirm.textContent).toContain(
        "지금은 사용 중지한 연결을 다시 켤 수 없습니다.",
      );
    });

    test("a failed read says so and does not stop the disable", async () => {
      const { api, user, confirm } = await openDisable(() =>
        json(500, { code: "INTERNAL", message: "boom", details: null }),
      );
      await within(confirm).findByText(
        "영향 수를 확인하지 못했습니다. 그래도 사용 중지할 수 있습니다.",
      );
      await user.click(
        within(confirm).getByRole("button", { name: "사용 중지" }),
      );
      await screen.findByText("console-key를 사용 중지했습니다.");
      expect(writes(api.calls).map((call) => call.path)).toEqual([DISABLE]);
    });

    test("a server without the route (404) reads as a failed check, not a crash", async () => {
      const { confirm } = await openDisable(() =>
        json(404, { code: "NOT_FOUND", message: "no", details: null }),
      );
      await within(confirm).findByText(/확인하지 못했습니다/);
    });

    test("a 200 of another shape is a failed check, never a number read from it", async () => {
      // Production does not validate a response, so the page has to.
      const { confirm } = await openDisable(
        () => json(200, counts({ profile_count: "2" })),
        "warn",
      );
      await within(confirm).findByText(/확인하지 못했습니다/);
      expect(within(confirm).queryByRole("alert")).toBeNull();
    });

    test("while the count loads, the button already works", async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { api, user, confirm } = await openDisable(async () => {
        await gate;
        return json(200, counts({ profile_count: 1 }));
      });
      within(confirm).getByText("영향을 확인하는 중…");
      const button = within(confirm).getByRole("button", {
        name: "사용 중지",
      }) as HTMLButtonElement;
      expect(button.disabled === false).toBe(true);
      await user.click(button);
      await screen.findByText("console-key를 사용 중지했습니다.");
      expect(writes(api.calls).map((call) => call.path)).toEqual([DISABLE]);
      release();
    });

    test("closing and opening again reads again", async () => {
      const { api, user, table, confirm } = await openDisable(() =>
        json(200, counts({ profile_count: 1 })),
      );
      await within(confirm).findByRole("alert");
      await user.click(within(confirm).getByRole("button", { name: "취소" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await user.click(
        within(table).getByRole("button", { name: "console-key 사용 중지" }),
      );
      await within(await screen.findByRole("dialog")).findByRole("alert");
      expect(impactCalls(api.calls).length).toBe(2);
    });

    test("an MCP server is disabled without reading any connection count", async () => {
      const { api } = renderAt("/settings/workspace/mcp-servers", {
        "GET /v1/auth/me": () => json(200, me()),
        [`GET ${MCP}`]: () => json(200, { items: [mcp("docs")] }),
        [`POST ${MCP}/docs/disable`]: () => json(200, CHANGE("docs")),
      });
      const user = await setupUser();
      const table = await screen.findByRole("table", { name: "MCP 서버" });
      await user.click(
        within(table).getByRole("button", { name: "docs 사용 중지" }),
      );
      const confirm = await screen.findByRole("dialog");
      expect(confirm.textContent).toContain("되돌릴 수 없습니다");
      expect(impactCalls(api.calls)).toEqual([]);
    });
  });

  test("an env-referenced connection moves to a typed key through its own route", async () => {
    const { api } = renderAt(CONNECTIONS_PAGE, {
      ...routes(),
      [`POST ${CONNECTIONS}/anthropic/convert`]: () =>
        json(200, CHANGE("anthropic")),
    });
    const user = await setupUser();
    const table = await screen.findByRole("table", { name: "모델 연결" });
    await user.click(
      within(table).getByRole("button", { name: "anthropic 화면에서 키 넣기" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("기존 값을 읽어 옮기지는 않습니다");
    await user.type(within(dialog).getByLabelText("값"), "typed-key-value");
    await user.click(within(dialog).getByRole("button", { name: "저장" }));
    await screen.findByText("anthropic의 키를 저장했습니다.");
    expect(writes(api.calls).map((call) => [call.path, call.body])).toEqual([
      [`${CONNECTIONS}/anthropic/convert`, { value: "typed-key-value" }],
    ]);
  });

  test("moving a key that another connection's old definition holds says why", async () => {
    renderAt(CONNECTIONS_PAGE, {
      ...routes(),
      [`POST ${CONNECTIONS}/anthropic/convert`]: () =>
        json(409, {
          error: {
            code: "REVISION_CONFLICT",
            message: "taken",
            details: { reason_code: "alias_taken" },
          },
        }),
    });
    const user = await setupUser();
    const table = await screen.findByRole("table", { name: "모델 연결" });
    await user.click(
      within(table).getByRole("button", { name: "anthropic 화면에서 키 넣기" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("값"), "typed-key-value");
    await user.click(within(dialog).getByRole("button", { name: "저장" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "옛 정의와 같아",
    );
  });

  test("a refusal names the server's reason", async () => {
    renderAt(CONNECTIONS_PAGE, {
      ...routes(),
      [`POST ${CONNECTIONS}`]: () =>
        json(409, {
          error: {
            code: "REVISION_CONFLICT",
            message: "taken",
            details: { reason_code: "already_exists" },
          },
        }),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "연결 추가" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("id"), "console-key");
    await user.type(
      within(dialog).getByLabelText("엔드포인트"),
      "https://api.anthropic.com",
    );
    await user.type(within(dialog).getByLabelText("키 값"), "example-key");
    await user.click(within(dialog).getByRole("button", { name: "만들기" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "이미 쓴 id입니다",
    );
  });

  test("an admin neither reads the connections nor gets a way to change them", async () => {
    const { api } = renderAt("/profiles", routes(me(undefined, "admin")));
    await screen.findByRole("table", { name: "프로필" });
    expect(screen.queryByRole("button", { name: "연결 추가" })).toBeNull();
    expect(screen.queryByRole("table", { name: "모델 연결" })).toBeNull();
    expect(api.calls.some((call) => call.path === CONNECTIONS)).toBe(false);
  });
});

describe("MCP 서버", () => {
  const routes = (signedIn = me()) => ({
    "GET /v1/auth/me": () => json(200, signedIn),
    [`GET ${MCP}`]: () =>
      json(200, {
        items: [
          mcp("docs"),
          mcp("ops", {
            origin: "import",
            credential: { source: "external", value_env: "OPS_MCP_TOKEN" },
          }),
          mcp("search", { origin: "import", credential: { source: "none" } }),
        ],
      }),
  });

  test("each server shows its tool namespace and nothing that blocks a tool", async () => {
    renderAt("/settings/workspace/mcp-servers", routes());
    const table = await screen.findByRole("table", { name: "MCP 서버" });
    expect(rowOf(table, "docs").textContent).toContain("mcp__docs__*");
    expect(rowOf(table, "search").textContent).toContain("mcp__search__*");
    expect(table.textContent).not.toMatch(/차단|block/i);
    expect(screen.queryAllByRole("checkbox")).toEqual([]);
    expect(screen.queryAllByRole("switch")).toEqual([]);
    expect(
      within(rowOf(table, "docs"))
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["docs 값 바꾸기", "docs 워크스페이스 바꾸기", "docs 사용 중지"]);
    // An operator's reference: view and disable only.
    expect(
      within(rowOf(table, "ops"))
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["ops 사용 중지"]);
    expect(
      within(rowOf(table, "search"))
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["search 사용 중지"]);
  });

  test("a narrow table keeps every row's actions", async () => {
    renderAt("/settings/workspace/mcp-servers", routes());
    expectNarrowActions(await screen.findByRole("table", { name: "MCP 서버" }));
  });

  test("adding one and changing its workspaces send the slugs as a list", async () => {
    const { api } = renderAt("/settings/workspace/mcp-servers", {
      ...routes(),
      [`POST ${MCP}`]: () => json(201, CHANGE("wiki")),
      [`PATCH ${MCP}/docs`]: () => json(200, CHANGE("docs")),
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "MCP 서버 추가" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("바꾸려면 새 id로 만드세요");
    await user.type(within(dialog).getByLabelText("id"), "wiki");
    await user.type(
      within(dialog).getByLabelText("URL"),
      "https://wiki.example.com/mcp",
    );
    await user.type(named(dialog, "credential_ref"), "wiki");
    await user.type(
      within(dialog).getByLabelText("워크스페이스"),
      "acme, acme-labs ,",
    );
    await user.type(named(dialog, "value"), "example-token");
    await user.click(within(dialog).getByRole("button", { name: "만들기" }));
    await screen.findByText("wiki를 만들었습니다.");

    const table = screen.getByRole("table", { name: "MCP 서버" });
    await user.click(
      within(table).getByRole("button", { name: "docs 워크스페이스 바꾸기" }),
    );
    const edit = await screen.findByRole("dialog");
    const field = within(edit).getByLabelText("워크스페이스");
    expect((field as HTMLInputElement).value).toBe("acme");
    await user.clear(field);
    await user.type(field, "acme,beta");
    await user.click(within(edit).getByRole("button", { name: "저장" }));
    await screen.findByText("docs를 바꿨습니다.");
    expect(
      writes(api.calls).map((call) => [call.method, call.path, call.body]),
    ).toEqual([
      [
        "POST",
        MCP,
        {
          id: "wiki",
          url: "https://wiki.example.com/mcp",
          credential_ref: "wiki",
          workspaces: ["acme", "acme-labs"],
          value: "example-token",
        },
      ],
      ["PATCH", `${MCP}/docs`, { workspaces: ["acme", "beta"] }],
    ]);
  });

  test("an admin gets the refusal screen and no read", async () => {
    const { api } = renderAt(
      "/settings/workspace/mcp-servers",
      routes(me(undefined, "admin")),
    );
    await screen.findByText("이 화면을 볼 권한이 없습니다");
    expect(api.calls.some((call) => call.path === MCP)).toBe(false);
  });
});

describe("설정의 모델 연결", () => {
  const routes = (signedIn = me()) => ({
    "GET /v1/auth/me": () => json(200, signedIn),
    "GET /v1/profiles": () =>
      json(200, { items: [imported("coding-claude"), imported("general")] }),
    [`GET ${CONNECTIONS}`]: () =>
      json(200, {
        items: [connection("anthropic"), connection("console-key")],
        credential_hosts: null,
        endpoint_defaults: { anthropic: "https://api.anthropic.com" },
      }),
    [`POST ${CONNECTIONS}`]: () => json(201, CHANGE("fresh")),
  });

  test("the owner reaches the list and the add dialog from the settings menu", async () => {
    const { api } = renderAt("/settings/workspace", routes());
    const user = await setupUser();
    const nav = await screen.findByRole("navigation", { name: "설정" });
    await user.click(within(nav).getByRole("link", { name: "모델 연결" }));

    const table = await screen.findByRole("table", { name: "모델 연결" });
    // One h1 for the page; the table's own head is not a second heading.
    expect(
      screen
        .getAllByRole("heading", { name: "모델 연결" })
        .map((h) => h.tagName),
    ).toEqual(["H1"]);
    expect(rowOf(table, "anthropic").textContent).toContain("프로필 2개");
    expect(
      within(screen.getByRole("navigation", { name: "설정" }))
        .getByRole("link", { name: "모델 연결" })
        .getAttribute("aria-current"),
    ).toBe("page");

    await user.click(screen.getByRole("button", { name: "연결 추가" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("id"), "fresh");
    await user.type(within(dialog).getByLabelText("키 값"), "example-key");
    await user.click(within(dialog).getByRole("button", { name: "만들기" }));
    await screen.findByText("fresh를 만들었습니다.");
    expect(writes(api.calls).map((call) => [call.method, call.path])).toEqual([
      ["POST", CONNECTIONS],
    ]);
  });

  test("the Profiles screen no longer manages connections", async () => {
    const { api } = renderAt("/profiles", routes());
    await screen.findByRole("table", { name: "프로필" });
    // The table would be on screen once its (independent) query has answered.
    await waitFor(() =>
      expect(api.calls.some((call) => call.path === CONNECTIONS)).toBe(true),
    );
    await act(async () => {});
    expect(screen.queryByRole("table", { name: "모델 연결" }) === null).toBe(
      true,
    );
    expect(screen.queryByRole("button", { name: "연결 추가" }) === null).toBe(
      true,
    );
  });

  describe("the empty-profiles hint", () => {
    const empty = (items: SettingsConnection[]) => ({
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/profiles": () => json(200, { items: [] }),
      [`GET ${CONNECTIONS}`]: () =>
        json(200, { items, credential_hosts: null, endpoint_defaults: {} }),
    });
    const HINT = "프로필을 만들려면 먼저 모델 연결이 필요합니다.";

    test("an owner with no active connection gets a link to the connections screen", async () => {
      renderAt(
        "/profiles",
        empty([connection("old", { state: "needs_value" })]),
      );
      const link = await screen.findByRole("link", {
        name: "모델 연결로 가기",
      });
      expect(
        link.getAttribute("href") === "/settings/workspace/connections",
      ).toBe(true);
      expect(screen.getByText(HINT) !== null).toBe(true);
    });

    test("an active connection means no hint", async () => {
      const { api } = renderAt("/profiles", empty([connection("live")]));
      await screen.findByText("이 설치에 프로필이 없습니다.");
      await waitFor(() =>
        expect(api.calls.some((call) => call.path === CONNECTIONS)).toBe(true),
      );
      await act(async () => {});
      expect(screen.queryByText(HINT) === null).toBe(true);
      expect(
        screen.queryByRole("link", { name: "모델 연결로 가기" }) === null,
      ).toBe(true);
    });

    for (const [state, answer] of [
      ["still loading", () => new Promise<Response>(() => {})],
      ["failed", () => json(500, { error: "boom" })],
    ] as const) {
      test(`a connections list that is ${state} is not read as none`, async () => {
        const { api } = renderAt("/profiles", {
          ...empty([]),
          [`GET ${CONNECTIONS}`]: answer,
        });
        await screen.findByText("이 설치에 프로필이 없습니다.");
        await waitFor(() =>
          expect(api.calls.some((call) => call.path === CONNECTIONS)).toBe(
            true,
          ),
        );
        await act(async () => {});
        expect(screen.queryByText(HINT) === null).toBe(true);
        expect(
          screen.queryByRole("link", { name: "모델 연결로 가기" }) === null,
        ).toBe(true);
      });
    }

    test("a refetch that fails takes the hint away instead of keeping the cached answer", async () => {
      let failing = false;
      const { services } = renderAt("/profiles", {
        ...empty([]),
        [`GET ${CONNECTIONS}`]: () =>
          failing
            ? json(500, { error: "boom" })
            : json(200, {
                items: [],
                credential_hosts: null,
                endpoint_defaults: {},
              }),
      });
      await screen.findByText(HINT);
      failing = true;
      await act(async () => {
        await services.queryClient.refetchQueries({
          predicate: (query) => query.state.status === "success",
        });
      });
      await waitFor(() => expect(screen.queryByText(HINT) === null).toBe(true));
    });

    test("an admin gets no hint and never asks for the connections", async () => {
      const { api } = renderAt("/profiles", {
        ...empty([]),
        "GET /v1/auth/me": () => json(200, me(undefined, "admin")),
      });
      await screen.findByText("이 설치에 프로필이 없습니다.");
      await act(async () => {});
      expect(screen.queryByText(HINT) === null).toBe(true);
      expect(api.calls.some((call) => call.path === CONNECTIONS)).toBe(false);
    });
  });

  for (const role of ["admin", "member"] as const) {
    test(`a ${role} gets no menu item, and a direct visit is refused without a request`, async () => {
      const { api } = renderAt(
        "/settings/workspace/connections",
        routes(me(undefined, role)),
      );
      await screen.findByText("이 화면을 볼 권한이 없습니다");
      const nav = screen.getByRole("navigation", { name: "설정" });
      expect(within(nav).queryByRole("link", { name: "모델 연결" })).toBeNull();
      expect(screen.queryByRole("button", { name: "연결 추가" })).toBeNull();
      expect(
        api.calls.some(
          (call) => call.path === CONNECTIONS || call.path === "/v1/profiles",
        ),
      ).toBe(false);
    });
  }
});
