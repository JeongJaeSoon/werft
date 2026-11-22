import { describe, expect, test } from "bun:test";
import type { SettingsConnection } from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { apiError, json, me } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { act, renderAt, screen, waitFor, within } = await appHarness();

const CONNECTIONS_PAGE = "/settings/workspace/model-connections";

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
  models: ["claude-sonnet-5"],
  model_families: null,
  created_at: AT,
  disabled_at: null,
  ...rest,
});

const CONNECTIONS = "/v1/installation/settings/connections";

const rowOf = (table: HTMLElement, id: string) => {
  const row = within(table)
    .getAllByRole("row")
    .find((item) => item.textContent?.startsWith(id));
  if (row === undefined) throw new Error(`no row ${id}`);
  return row;
};

/** Every call that changes something; reading a model list is a POST that does not. */
const writes = <C extends { readonly method: string; readonly path: string }>(
  calls: readonly C[],
) =>
  calls.filter(
    (call) => call.method !== "GET" && !call.path.endsWith("/models/discover"),
  );

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

/** Result lines mounted with nothing in them yet, so a later result is read out. */
const emptyLiveRegions = (scope: HTMLElement = screen.getByRole("main")) =>
  [...scope.querySelectorAll<HTMLElement>('output[data-slot="alert"]')].filter(
    (region) => region.textContent === "",
  );

type User = Awaited<ReturnType<typeof setupUser>>;

/**
 * The table's section has one result line, a status region above the table
 * that is there before anything happens; the notice is written into it.
 */
async function expectNoticeInStandingRegion(
  table: HTMLElement,
  act: () => Promise<void>,
  text: string,
) {
  const section = table.closest("section") ?? screen.getByRole("main");
  const [region] = emptyLiveRegions(section);
  if (!region) throw new Error("no empty live region");
  expect(within(section).getAllByRole("status").includes(region)).toBe(true);
  expect(
    region.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  await act();
  await waitFor(() => expect(region.textContent).toBe(text));
  expect(region.isConnected).toBe(true);
}

/** Opens a connection's row menu and returns it. */
const openMenu = async (user: User, table: HTMLElement, id: string) => {
  await user.click(within(table).getByRole("button", { name: `${id} 메뉴` }));
  return screen.findByRole("menu", { name: `${id} 메뉴` });
};

const menuLabels = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole("menuitem")
    .map((item) => item.getAttribute("aria-label"));

/** Chooses an item from a connection's row menu. */
const choose = async (
  user: User,
  table: HTMLElement,
  id: string,
  item: string,
) => {
  const menu = await openMenu(user, table, id);
  await user.click(within(menu).getByRole("menuitem", { name: item }));
};

describe("모델 연결", () => {
  const listed = [
    connection("anthropic", {
      origin: "import",
      credential: { source: "stored", last4: "wxyz" },
    }),
    connection("console-key"),
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
    const user = await setupUser();
    const table = await screen.findByRole("table", { name: "모델 연결" });
    const imported = rowOf(table, "anthropic");
    expect(imported.textContent).toContain("••••wxyz");
    expect(imported.textContent).toContain("claude-sonnet-5");
    expect(imported.textContent).not.toContain("파일");

    // As in the members table: the ⋯ menu is the row's only button, and
    // disabling is its last item, in red.
    const stored = rowOf(table, "console-key");
    expect(stored.textContent).toContain("••••abcd");
    // Every Claude release runs auto, so no row offers or shows a judgement.
    expect(stored.textContent).not.toContain("자동 모드");
    expect(
      within(stored)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["console-key 메뉴"]);
    const storedMenu = await openMenu(user, table, "console-key");
    expect(menuLabels(storedMenu)).toEqual([
      "console-key의 API 키 설정",
      "console-key의 모델 목록",
      "console-key 사용 중지",
    ]);
    expect(
      within(storedMenu).getByRole("menuitem", {
        name: "console-key의 API 키 설정",
      }).textContent,
    ).toBe("API 키 설정");
    const disable = within(storedMenu).getByRole("menuitem", {
      name: "console-key 사용 중지",
    });
    expect(disable.textContent).toBe("사용 중지");
    expect(disable.getAttribute("data-tone")).toBe("danger");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    const fresh = rowOf(table, "fresh");
    expect(fresh.textContent).toContain("값 필요");
    // The state column says it as the members table does: a dot and a name,
    // not a badge.
    const states = [stored, fresh].map((row) => {
      const cell = within(row).getAllByRole("cell")[5] as HTMLElement;
      expect(cell.querySelector('[data-slot="badge"]') === null).toBe(true);
      const text = cell.querySelector('[data-slot="status-text"]');
      const dot = text?.querySelector('[data-slot="status-dot"]');
      expect(dot?.getAttribute("aria-hidden")).toBe("true");
      return [text?.getAttribute("data-status"), text?.textContent];
    });
    expect(states).toEqual([
      ["done", "사용 중"],
      ["wait", "값 필요"],
    ]);
    expect(
      within(await openMenu(user, table, "fresh")).getByRole("menuitem", {
        name: "fresh의 API 키 설정",
      }).textContent,
    ).toBe("API 키 설정");
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
    expect(within(dialog).queryByLabelText("인증 방식") === null).toBe(true);
    await user.type(within(dialog).getByLabelText("id"), "litellm-proxy");
    await user.selectOptions(within(dialog).getByLabelText("종류"), "litellm");
    const endpoint = within(dialog).getByLabelText("엔드포인트");
    await user.type(endpoint, "https://api.anthropic.com");
    expect(within(dialog).queryByRole("status") === null).toBe(true);
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

  test("an openai_responses connection takes OpenAI's address, says which engine runs it, and is created with an API key", async () => {
    const OPENAI = "https://api.openai.com";
    const HINT =
      "OpenAI Responses API로 부르는 연결입니다. 이 연결을 쓰는 에이전트는 Codex 엔진으로 실행됩니다.";
    const { api } = renderAt(CONNECTIONS_PAGE, {
      ...routes(me(), null, {
        anthropic: "https://api.anthropic.com",
        openai_responses: OPENAI,
      }),
      [`POST ${CONNECTIONS}`]: () => json(201, CHANGE("openai")),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "연결 추가" }));
    const dialog = await screen.findByRole("dialog");
    const kind = within(dialog).getByLabelText<HTMLSelectElement>("종류");
    // The judge's kind is set up on the achievement rules screen.
    expect([...kind.options].map((option) => option.value)).toEqual([
      "anthropic",
      "litellm",
      "openai_responses",
    ]);
    // The hint belongs to this kind only.
    expect(within(dialog).queryByText(HINT) === null).toBe(true);
    await user.selectOptions(kind, "openai_responses");
    expect(within(dialog).queryByText(HINT) === null).toBe(false);
    expect(
      within(dialog).getByLabelText<HTMLInputElement>("엔드포인트").value,
    ).toBe(OPENAI);
    // Only litellm has a second way to authenticate.
    expect(dialog.querySelector('[name="auth_kind"]') === null).toBe(true);

    await user.type(within(dialog).getByLabelText("id"), "openai");
    await user.type(within(dialog).getByLabelText("키 값"), "example-key");
    await user.click(within(dialog).getByRole("button", { name: "만들기" }));
    await screen.findByText("openai를 만들었습니다.");
    expect(writes(api.calls).map((call) => call.body)).toEqual([
      {
        id: "openai",
        kind: "openai_responses",
        billing: "per_token",
        auth_kind: "api_key",
        value: "example-key",
      },
    ]);
  });

  test("an openai_decisions connection is not listed here: the achievement rules screen manages it", async () => {
    renderAt(CONNECTIONS_PAGE, {
      ...routes(),
      [`GET ${CONNECTIONS}`]: () =>
        json(200, {
          items: [
            connection("anthropic"),
            connection("luna", {
              kind: "openai_decisions",
              endpoint: "https://api.openai.com",
              models: [],
            }),
          ],
          credential_hosts: null,
          endpoint_defaults: {},
        }),
    });
    const table = await screen.findByRole("table", { name: "모델 연결" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.length).toBe(1);
    expect(rows[0]?.textContent?.startsWith("anthropic")).toBe(true);
    expect(table.textContent).not.toContain("luna");
  });

  test("an IPv6 or trailing-dot endpoint matches the allowlist entry the API sends", async () => {
    renderAt(
      CONNECTIONS_PAGE,
      routes(me(), ["fd00::1:8443", "llm.internal:443"]),
    );
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "연결 추가" }));
    const dialog = await screen.findByRole("dialog");
    const endpoint = within(dialog).getByLabelText("엔드포인트");
    // user-event reads "[" as a key name; "[[" types one.
    await user.type(endpoint, "https://[[fd00::1]:8443/v1");
    expect(within(dialog).queryByRole("status") === null).toBe(true);
    await user.clear(endpoint);
    await user.type(endpoint, "https://llm.internal./v1");
    expect(within(dialog).queryByRole("status") === null).toBe(true);
    await user.clear(endpoint);
    await user.type(endpoint, "https://[[fd00::2]:8443/v1");
    expect(within(dialog).getByRole("status").textContent).toContain(
      "fd00::2:8443는 egress",
    );
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
    expect(within(dialog).queryByRole("status") === null).toBe(true);
  });

  test("while the list reloads after a save, the menu button takes the focus back but does not open", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let loads = 0;
    const list = routes()[`GET ${CONNECTIONS}`];
    renderAt(CONNECTIONS_PAGE, {
      ...routes(),
      [`GET ${CONNECTIONS}`]: async () => {
        loads += 1;
        if (loads > 1) await gate;
        return list();
      },
      [`POST ${CONNECTIONS}/console-key/credential`]: () =>
        json(200, CHANGE("console-key")),
    });
    const user = await setupUser();
    const table = await screen.findByRole("table", { name: "모델 연결" });
    await choose(user, table, "console-key", "console-key의 API 키 설정");
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("값"), "rotated-key");
    await user.click(within(dialog).getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog") === null).toBe(true),
    );

    const menuButton = within(table).getByRole("button", {
      name: "console-key 메뉴",
    });
    expect(menuButton.getAttribute("aria-disabled")).toBe("true");
    await waitFor(() =>
      expect(document.activeElement === menuButton).toBe(true),
    );
    await user.click(menuButton);
    expect(screen.queryByRole("menu") === null).toBe(true);

    release();
    await waitFor(() =>
      expect(menuButton.getAttribute("aria-disabled") === null).toBe(true),
    );
    await openMenu(user, table, "console-key");
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
    await choose(user, table, "console-key", "console-key의 API 키 설정");
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("값"), "rotated-key");
    await user.click(within(dialog).getByRole("button", { name: "저장" }));
    await screen.findByText("console-key의 값을 바꿨습니다.");
    // The dialog came from the menu, so the keyboard goes back to its button.
    const menuButton = within(table).getByRole("button", {
      name: "console-key 메뉴",
    });
    await waitFor(() =>
      expect(document.activeElement === menuButton).toBe(true),
    );

    await choose(user, table, "console-key", "console-key 사용 중지");
    const confirm = await screen.findByRole("dialog");
    expect(confirm.textContent).toContain(
      "나중에 같은 화면에서 다시 켤 수 있습니다.",
    );
    expect(confirm.textContent).not.toContain("다시 켤 수 없습니다");
    // A disabled id is turned back on, so it stays taken: it is not "gone for
    // good", and the stop lasts only until it is turned on again.
    expect(confirm.textContent).toContain(
      "이 id는 다른 연결에 쓸 수 없습니다.",
    );
    expect(confirm.textContent).toContain("다시 켤 때까지 실행되지 않습니다.");
    expect(confirm.textContent).not.toContain("이 id는 다시 쓸 수 없습니다");
    expect(confirm.textContent).not.toContain("더 이상 실행되지 않습니다");
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

  describe("a connection's models are picked from what its provider lists", () => {
    const DISCOVER = (id: string) => `${CONNECTIONS}/${id}/models/discover`;
    const DEFAULTS = {
      anthropic: "https://api.anthropic.com",
      openai_decisions: "https://api.openai.com",
    };
    const discovered = (
      models: Array<{ id: string; display_name?: string | null }>,
      rest: { missing?: string[]; skipped?: number; truncated?: boolean } = {},
    ) => ({
      models: models.map((model) => ({
        id: model.id,
        display_name: model.display_name ?? null,
        selected: false,
      })),
      missing: rest.missing ?? [],
      skipped: rest.skipped ?? 0,
      truncated: rest.truncated ?? false,
    });
    const checkbox = (dialog: HTMLElement, id: string) =>
      within(dialog).getByRole("checkbox", { name: new RegExp(id) });
    const openModels = async (id = "console-key") => {
      const user = await setupUser();
      const table = await screen.findByRole("table", { name: "모델 연결" });
      await choose(user, table, id, `${id}의 모델 목록`);
      return { user, dialog: await screen.findByRole("dialog") };
    };
    const discoverCalls = (calls: readonly { path: string }[], id: string) =>
      calls.filter((call) => call.path === DISCOVER(id)).length;

    test("creating one opens its models at once, read from the provider, and saves the checked ones in the provider's order", async () => {
      const { api } = renderAt(CONNECTIONS_PAGE, {
        ...routes(me(), null, DEFAULTS),
        [`POST ${CONNECTIONS}`]: () => json(201, CHANGE("fresh-a")),
        [`POST ${DISCOVER("fresh-a")}`]: () =>
          json(
            200,
            discovered([
              { id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
              { id: "claude-opus-5", display_name: "Claude Opus 5" },
            ]),
          ),
        [`POST ${CONNECTIONS}/fresh-a/models`]: () =>
          json(200, CHANGE("fresh-a")),
      });
      const user = await setupUser();
      await user.click(
        await screen.findByRole("button", { name: "연결 추가" }),
      );
      const adding = await screen.findByRole("dialog");
      await user.type(within(adding).getByLabelText("id"), "fresh-a");
      await user.type(within(adding).getByLabelText("키 값"), "example-key");
      await user.click(within(adding).getByRole("button", { name: "만들기" }));
      const dialog = await screen.findByRole("dialog", { name: "사용할 모델" });
      const opus = await within(dialog).findByRole("checkbox", {
        name: /claude-opus-5/,
      });
      expect(discoverCalls(api.calls, "fresh-a")).toBe(1);
      expect(dialog.querySelector("textarea") === null).toBe(true);
      expect(within(dialog).getByText("fresh-a") !== null).toBe(true);
      expect(
        checkbox(dialog, "claude-sonnet-5").getAttribute("aria-checked"),
      ).toBe("false");
      await user.click(opus);
      await user.click(checkbox(dialog, "claude-sonnet-5"));
      expect(within(dialog).getByText("2개 선택 (최대 64개)") !== null).toBe(
        true,
      );
      await user.click(
        within(dialog).getByRole("button", { name: "모델 저장" }),
      );
      await screen.findByText("fresh-a의 모델 2개를 저장했습니다.");
      expect(writes(api.calls).map((call) => [call.path, call.body])).toEqual([
        [
          CONNECTIONS,
          {
            id: "fresh-a",
            kind: "anthropic",
            billing: "per_token",
            auth_kind: "api_key",
            value: "example-key",
          },
        ],
        [
          `${CONNECTIONS}/fresh-a/models`,
          { models: ["claude-sonnet-5", "claude-opus-5"] },
        ],
      ]);
    });

    test("the row's dialog shows the connection's id and endpoint, keeps a model the provider dropped checked and marked, and saves only on save", async () => {
      const { api } = renderAt(CONNECTIONS_PAGE, {
        ...routes(),
        [`POST ${DISCOVER("console-key")}`]: () =>
          json(
            200,
            discovered([{ id: "claude-opus-5" }, { id: "claude-haiku-5" }], {
              missing: ["claude-sonnet-5"],
              skipped: 2,
            }),
          ),
        [`POST ${CONNECTIONS}/console-key/models`]: () =>
          json(200, CHANGE("console-key")),
      });
      const { user, dialog } = await openModels();
      await within(dialog).findByRole("checkbox", { name: /claude-opus-5/ });
      expect(within(dialog).getByText("console-key") !== null).toBe(true);
      expect(
        within(dialog).getByText("https://api.anthropic.com") !== null,
      ).toBe(true);
      expect(within(dialog).queryByRole("textbox") === null).toBe(true);
      const dropped = checkbox(dialog, "claude-sonnet-5");
      expect(dropped.getAttribute("aria-checked")).toBe("true");
      expect(
        dropped
          .closest('[data-slot="field"]')
          ?.textContent?.includes("목록에 없음"),
      ).toBe(true);
      expect(
        checkbox(dialog, "claude-opus-5")
          .closest('[data-slot="field"]')
          ?.textContent?.includes("목록에 없음"),
      ).toBe(false);
      expect(
        within(dialog).getByText(
          "에이전트가 쓰지 않는 모델 2개(임베딩·음성·이미지 등)는 목록에서 뺐습니다.",
        ) !== null,
      ).toBe(true);
      // Reading the list changed nothing.
      expect(writes(api.calls)).toEqual([]);
      await user.click(checkbox(dialog, "claude-haiku-5"));
      await user.click(
        within(dialog).getByRole("button", { name: "모델 저장" }),
      );
      await screen.findByText("console-key의 모델 2개를 저장했습니다.");
      expect(writes(api.calls).map((call) => [call.path, call.body])).toEqual([
        [
          `${CONNECTIONS}/console-key/models`,
          { models: ["claude-sonnet-5", "claude-haiku-5"] },
        ],
      ]);
    });

    test("a failed load says why, the saved list can still be saved, and refresh reads again", async () => {
      let reads = 0;
      const { api } = renderAt(CONNECTIONS_PAGE, {
        ...routes(),
        [`POST ${DISCOVER("console-key")}`]: () => {
          reads += 1;
          return reads === 1
            ? apiError(400, "BAD_REQUEST", "refused", false, {
                reason_code: "host_not_allowed",
              })
            : json(200, discovered([{ id: "claude-opus-5" }]));
        },
        [`POST ${CONNECTIONS}/console-key/models`]: () =>
          json(200, CHANGE("console-key")),
      });
      const { user, dialog } = await openModels();
      await within(dialog).findByText(
        "엔드포인트의 호스트가 egress 자격 증명 허용 목록에 없어 키를 보낼 수 없습니다.",
      );
      const kept = checkbox(dialog, "claude-sonnet-5");
      expect(kept.getAttribute("aria-checked")).toBe("true");
      // Not marked: an unread list says nothing about what the provider has.
      expect(within(dialog).queryByText("목록에 없음") === null).toBe(true);
      await user.click(
        within(dialog).getByRole("button", { name: "목록 새로고침" }),
      );
      await within(dialog).findByRole("checkbox", { name: /claude-opus-5/ });
      expect(reads).toBe(2);
      await user.click(
        within(dialog).getByRole("button", { name: "모델 저장" }),
      );
      await screen.findByText("console-key의 모델 1개를 저장했습니다.");
      expect(writes(api.calls).map((call) => call.body)).toEqual([
        { models: ["claude-sonnet-5"] },
      ]);
    });

    test("a new pick the provider stops listing on refresh stays checked, marked and saved", async () => {
      let reads = 0;
      const { api } = renderAt(CONNECTIONS_PAGE, {
        ...routes(),
        [`POST ${DISCOVER("console-key")}`]: () => {
          reads += 1;
          return json(
            200,
            discovered(
              reads === 1
                ? [{ id: "claude-sonnet-5" }, { id: "claude-opus-5" }]
                : [{ id: "claude-sonnet-5" }],
            ),
          );
        },
        [`POST ${CONNECTIONS}/console-key/models`]: () =>
          json(200, CHANGE("console-key")),
      });
      const { user, dialog } = await openModels();
      await user.click(
        await within(dialog).findByRole("checkbox", { name: /claude-opus-5/ }),
      );
      await user.click(
        within(dialog).getByRole("button", { name: "목록 새로고침" }),
      );
      await waitFor(() => expect(reads).toBe(2));
      await within(dialog).findByText("목록에 없음");
      const gone = checkbox(dialog, "claude-opus-5");
      expect(gone.getAttribute("aria-checked")).toBe("true");
      expect(
        gone
          .closest('[data-slot="field"]')
          ?.textContent?.includes("목록에 없음"),
      ).toBe(true);
      await user.click(
        within(dialog).getByRole("button", { name: "모델 저장" }),
      );
      await screen.findByText("console-key의 모델 2개를 저장했습니다.");
      expect(writes(api.calls).map((call) => call.body)).toEqual([
        { models: ["claude-sonnet-5", "claude-opus-5"] },
      ]);
    });

    const failures: [string, Response, string][] = [
      [
        "a provider's own status",
        apiError(400, "BAD_REQUEST", "x", false, {
          reason_code: "provider_answered",
          provider_status: 429,
        }),
        "공급자가 모델 목록 요청에 HTTP 429로 답했습니다.",
      ],
      [
        "a refused key",
        apiError(400, "BAD_REQUEST", "x", false, {
          reason_code: "provider_unauthorized",
          provider_status: 401,
        }),
        "공급자가 이 키를 거절했습니다. 키 값을 확인하세요.",
      ],
      [
        "an unreachable provider",
        apiError(503, "BACKEND_UNAVAILABLE", "x", true, {
          reason_code: "provider_unreachable",
        }),
        "공급자에 닿지 못했습니다. 잠시 뒤 목록을 새로고침하세요.",
      ],
      [
        "an unset allowlist",
        apiError(400, "BAD_REQUEST", "x", false, {
          reason_code: "credential_allowlist_unset",
        }),
        "egress 자격 증명 허용 목록이 비어 있어 키를 보내 목록을 읽을 수 없습니다. 운영자가 EGRESS_CREDENTIAL_ALLOWLIST를 정해야 합니다.",
      ],
      [
        "a server without the route (404)",
        apiError(404, "NOT_FOUND", "no route"),
        "모델 목록을 불러오지 못했습니다. 저장된 모델은 그대로 저장할 수 있습니다.",
      ],
      [
        "a 200 of another shape",
        json(200, { data: [] }),
        "모델 목록을 불러오지 못했습니다. 저장된 모델은 그대로 저장할 수 있습니다.",
      ],
    ];
    for (const [what, answer, text] of failures) {
      test(`${what} is said in the page's words`, async () => {
        renderAt(CONNECTIONS_PAGE, {
          ...routes(),
          [`POST ${DISCOVER("console-key")}`]: () => answer.clone(),
        });
        const { dialog } = await openModels();
        await within(dialog).findByText(text);
      });
    }

    test("more than 64 models is refused at the dialog, without a request", async () => {
      const saved = Array.from({ length: 64 }, (_, index) => `model-${index}`);
      const { api } = renderAt(CONNECTIONS_PAGE, {
        "GET /v1/auth/me": () => json(200, me()),
        [`GET ${CONNECTIONS}`]: () =>
          json(200, {
            items: [connection("console-key", { models: saved })],
            credential_hosts: null,
            endpoint_defaults: {},
          }),
        [`POST ${DISCOVER("console-key")}`]: () =>
          json(
            200,
            discovered([...saved, "model-extra"].map((id) => ({ id }))),
          ),
      });
      const { user, dialog } = await openModels();
      await user.click(
        await within(dialog).findByRole("checkbox", { name: /model-extra/ }),
      );
      await user.click(
        within(dialog).getByRole("button", { name: "모델 저장" }),
      );
      await within(dialog).findByText(
        "모델은 64개까지 저장할 수 있습니다. 65개가 선택되어 있습니다.",
      );
      expect(writes(api.calls)).toEqual([]);
    });
  });

  describe("disabling reads what it would leave without a model", () => {
    const IMPACT = `${CONNECTIONS}/console-key/impact`;
    const DISABLE = `${CONNECTIONS}/console-key/disable`;
    const counts = (over: Record<string, unknown> = {}) => ({
      id: "console-key",
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
      await choose(user, table, "console-key", "console-key 사용 중지");
      const confirm = await screen.findByRole("dialog");
      return { ...rendered, user, table, confirm };
    }

    test("a count above zero warns with each number, and disabling still goes through", async () => {
      const { api, user, confirm } = await openDisable(() =>
        json(200, counts({ agent_count: 3, session_count: 1 })),
      );
      const warning = await within(confirm).findByRole("alert");
      expect(warning.textContent).toContain("거절되거나 끊길 수 있습니다");
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

    // Each count warns on its own.
    for (const [name, over, line] of [
      ["agents", { agent_count: 2 }, "에이전트: 2개"],
      ["sessions", { session_count: 1 }, "끝나지 않은 세션: 1개"],
    ] as const) {
      test(`${name} alone warn`, async () => {
        const { confirm } = await openDisable(() => json(200, counts(over)));
        const warning = await within(confirm).findByRole("alert");
        expect(warning.textContent).toContain(line);
      });
    }

    test("a refetch that fails is a failed check, not the numbers of the read before it", async () => {
      let reads = 0;
      const { api, confirm } = await openDisable(() => {
        reads += 1;
        return reads === 1
          ? json(200, counts({ agent_count: 4 }))
          : json(500, { code: "INTERNAL", message: "boom", details: null });
      });
      await within(confirm).findByRole("alert");
      // Back on the window: React Query reads the stale count again.
      await act(async () => {
        window.dispatchEvent(new Event("visibilitychange"));
      });
      await within(confirm).findByText(/확인하지 못했습니다/);
      expect(impactCalls(api.calls).length).toBe(2);
      expect(within(confirm).queryByText(/에이전트: 4개/) === null).toBe(true);
    });

    test("a judge setting alone warns, without a word about a judgment stopping", async () => {
      const { confirm } = await openDisable(() =>
        json(200, counts({ judge_used: true })),
      );
      const warning = await within(confirm).findByRole("alert");
      expect(warning.textContent).toContain(
        "성과 판정 설정이 이 연결을 가리키고 있습니다.",
      );
      expect(warning.textContent).not.toContain("에이전트:");
      expect(warning.textContent).not.toContain("모델 호출이 거절되거나");
    });

    test("a judge setting beside affected agents keeps both lines", async () => {
      const { confirm } = await openDisable(() =>
        json(200, counts({ agent_count: 2, judge_used: true })),
      );
      const warning = await within(confirm).findByRole("alert");
      expect(warning.textContent).toContain("모델 호출이 거절되거나");
      expect(warning.textContent).toContain("에이전트: 2개");
      expect(warning.textContent).toContain(
        "성과 판정 설정이 이 연결을 가리키고 있습니다.",
      );
    });

    test("zero everywhere asks as before, with no warning and no failure line", async () => {
      const { api, confirm } = await openDisable(() => json(200, counts()));
      await waitFor(() => expect(impactCalls(api.calls).length).toBe(1));
      await waitFor(() =>
        expect(
          within(confirm).queryByText("영향을 확인하는 중…") === null,
        ).toBe(true),
      );
      expect(within(confirm).queryByRole("alert") === null).toBe(true);
      expect(confirm.textContent).not.toContain("확인하지 못했습니다");
      expect(confirm.textContent).toContain(
        "나중에 같은 화면에서 다시 켤 수 있습니다.",
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
        () => json(200, counts({ agent_count: "2" })),
        "warn",
      );
      await within(confirm).findByText(/확인하지 못했습니다/);
      expect(within(confirm).queryByRole("alert") === null).toBe(true);
    });

    test("while the count loads, the button already works", async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { api, user, confirm } = await openDisable(async () => {
        await gate;
        return json(200, counts({ agent_count: 1 }));
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
        json(200, counts({ agent_count: 1 })),
      );
      await within(confirm).findByRole("alert");
      await user.click(within(confirm).getByRole("button", { name: "취소" }));
      await waitFor(() =>
        expect(screen.queryByRole("dialog") === null).toBe(true),
      );
      await choose(user, table, "console-key", "console-key 사용 중지");
      await within(await screen.findByRole("dialog")).findByRole("alert");
      expect(impactCalls(api.calls).length).toBe(2);
    });
  });

  describe("a disabled connection is enabled again from its row", () => {
    const ENABLE = `${CONNECTIONS}/off-key/enable`;
    const withDisabled = (extra: Record<string, () => Response> = {}) => ({
      ...routes(),
      [`GET ${CONNECTIONS}`]: () =>
        json(200, {
          items: [
            connection("off-key", {
              state: "disabled",
              disabled_at: AT,
            }),
            connection("on-key"),
          ],
          credential_hosts: null,
          endpoint_defaults: {},
        }),
      ...extra,
    });

    test("only the disabled row's menu offers it, and it offers nothing else", async () => {
      renderAt(CONNECTIONS_PAGE, withDisabled());
      const user = await setupUser();
      const table = await screen.findByRole("table", { name: "모델 연결" });
      const off = within(rowOf(table, "off-key"));
      // As in the members table: no row button beside the ⋯ menu.
      expect(
        off
          .getAllByRole("button")
          .map((button) => [
            button.getAttribute("aria-label"),
            button.getAttribute("aria-disabled"),
          ]),
      ).toEqual([["off-key 메뉴", null]]);
      const menu = await openMenu(user, table, "off-key");
      expect(menuLabels(menu)).toEqual(["off-key 다시 켜기"]);
      const enable = within(menu).getByRole("menuitem", {
        name: "off-key 다시 켜기",
      });
      expect(enable.textContent).toBe("다시 켜기");
      expect(enable.getAttribute("data-tone")).toBe("default");
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      expect(menuLabels(await openMenu(user, table, "on-key"))).not.toContain(
        "on-key 다시 켜기",
      );
      expectNarrowActions(table);
    });

    test("a disabled row with no value offers its first value before enabling it again", async () => {
      renderAt(CONNECTIONS_PAGE, {
        ...routes(),
        [`GET ${CONNECTIONS}`]: () =>
          json(200, {
            items: [
              connection("off-empty", {
                state: "disabled",
                disabled_at: AT,
                credential: { source: "stored", last4: null },
              }),
            ],
            credential_hosts: null,
            endpoint_defaults: {},
          }),
      });
      const user = await setupUser();
      const table = await screen.findByRole("table", { name: "모델 연결" });
      const menu = await openMenu(user, table, "off-empty");
      expect(menuLabels(menu)).toEqual([
        "off-empty의 API 키 설정",
        "off-empty 다시 켜기",
      ]);
    });

    test("every cell holds one line, as the members table's do, and the credential kind sits in its column", async () => {
      renderAt(CONNECTIONS_PAGE, withDisabled());
      const table = await screen.findByRole("table", { name: "모델 연결" });
      expect(
        within(table)
          .getAllByRole("columnheader")
          .map((header) => header.textContent),
      ).toEqual([
        "id",
        "엔드포인트",
        "종류",
        "자격 증명",
        "모델",
        "상태",
        // The ⋯ column's name is for screen readers only, as in members.
        "동작",
      ]);
      const last = within(table).getAllByRole("columnheader")[6];
      expect(last?.firstElementChild?.className).toBe("sr-only");
      const cells = within(rowOf(table, "on-key")).getAllByRole("cell");
      expect(cells.length).toBe(7);
      expect(cells.filter((cell) => cell.hasAttribute("data-lines"))).toEqual(
        [],
      );
      expect(cells[3]?.textContent?.startsWith("API 키 · ")).toBe(true);
    });

    test("only the disabled row takes the muted fill", async () => {
      renderAt(CONNECTIONS_PAGE, withDisabled());
      const table = await screen.findByRole("table", { name: "모델 연결" });
      const classes = (id: string) => rowOf(table, id).className.split(" ");
      expect(classes("off-key").includes("bg-hover")).toBe(true);
      expect(classes("on-key").includes("bg-hover")).toBe(false);
    });

    test("asks first, then posts to its route and says it is on again", async () => {
      const { api } = renderAt(
        CONNECTIONS_PAGE,
        withDisabled({
          [`POST ${ENABLE}`]: () => json(200, CHANGE("off-key")),
        }),
      );
      const user = await setupUser();
      const table = await screen.findByRole("table", { name: "모델 연결" });
      await choose(user, table, "off-key", "off-key 다시 켜기");
      const confirm = await screen.findByRole("dialog");
      expect(confirm.textContent).toContain("off-key를 다시 켤까요?");
      expect(writes(api.calls)).toEqual([]);

      await user.click(within(confirm).getByRole("button", { name: "취소" }));
      await waitFor(() =>
        expect(screen.queryByRole("dialog") === null).toBe(true),
      );
      expect(writes(api.calls)).toEqual([]);

      await choose(user, table, "off-key", "off-key 다시 켜기");
      await user.click(
        within(await screen.findByRole("dialog")).getByRole("button", {
          name: "다시 켜기",
        }),
      );
      await screen.findByText("off-key를 다시 켰습니다.");
      expect(writes(api.calls).map((call) => [call.path, call.body])).toEqual([
        [ENABLE, null],
      ]);
    });

    test("the row comes back active and keyboard focus lands on its ⋯ button", async () => {
      let on = false;
      renderAt(CONNECTIONS_PAGE, {
        ...routes(),
        [`GET ${CONNECTIONS}`]: () =>
          json(200, {
            items: [
              connection(
                "off-key",
                on ? {} : { state: "disabled", disabled_at: AT },
              ),
            ],
            credential_hosts: null,
            endpoint_defaults: {},
          }),
        [`POST ${ENABLE}`]: () => {
          on = true;
          return json(200, CHANGE("off-key"));
        },
      });
      const user = await setupUser();
      const table = await screen.findByRole("table", { name: "모델 연결" });
      await choose(user, table, "off-key", "off-key 다시 켜기");
      await user.click(
        within(await screen.findByRole("dialog")).getByRole("button", {
          name: "다시 켜기",
        }),
      );
      await screen.findByText("off-key를 다시 켰습니다.");
      await waitFor(() =>
        expect(rowOf(table, "off-key").textContent).toContain("사용 중"),
      );
      const menuButton = within(table).getByRole("button", {
        name: "off-key 메뉴",
      });
      await waitFor(() =>
        expect(document.activeElement === menuButton).toBe(true),
      );
      expect(menuLabels(await openMenu(user, table, "off-key"))).toContain(
        "off-key 사용 중지",
      );
    });

    for (const [reason, words] of [
      [
        "definition_active",
        "같은 정의의 다른 연결이 사용 중이라 켤 수 없습니다",
      ],
      ["needs_value", "저장된 키가 없어 다시 켤 수 없습니다"],
      ["not_disabled", "이미 사용 중인 연결입니다"],
    ] as const) {
      test(`a refusal for ${reason} is said in the page's words, not the server's`, async () => {
        renderAt(
          CONNECTIONS_PAGE,
          withDisabled({
            [`POST ${ENABLE}`]: () =>
              json(409, {
                error: {
                  code: "REVISION_CONFLICT",
                  message: "server words",
                  details: { reason_code: reason },
                },
              }),
          }),
        );
        const user = await setupUser();
        const table = await screen.findByRole("table", { name: "모델 연결" });
        await choose(user, table, "off-key", "off-key 다시 켜기");
        await user.click(
          within(await screen.findByRole("dialog")).getByRole("button", {
            name: "다시 켜기",
          }),
        );
        const alert = await screen.findByRole("alert");
        expect(alert.textContent).toContain(words);
        expect(alert.textContent).not.toContain("server words");
        // The dialog is closed and the row is still there to try again.
        expect(screen.queryByRole("dialog") === null).toBe(true);
        expect(menuLabels(await openMenu(user, table, "off-key"))).toEqual([
          "off-key 다시 켜기",
        ]);
      });
    }

    test("a server without the route (404) is a failure line, not a crash", async () => {
      renderAt(
        CONNECTIONS_PAGE,
        withDisabled({
          [`POST ${ENABLE}`]: () =>
            json(404, { code: "NOT_FOUND", message: "no", details: null }),
        }),
      );
      const user = await setupUser();
      const table = await screen.findByRole("table", { name: "모델 연결" });
      await choose(user, table, "off-key", "off-key 다시 켜기");
      await user.click(
        within(await screen.findByRole("dialog")).getByRole("button", {
          name: "다시 켜기",
        }),
      );
      await screen.findByRole("alert");
      expect(menuLabels(await openMenu(user, table, "off-key"))).toEqual([
        "off-key 다시 켜기",
      ]);
    });
  });

  test("a connection cannot be made without a key: create stays off until one of 8 characters is typed", async () => {
    const { api } = renderAt(CONNECTIONS_PAGE, {
      ...routes(me(), null, { anthropic: "https://api.anthropic.com" }),
      [`POST ${CONNECTIONS}`]: () => json(201, CHANGE("keyed")),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "연결 추가" }));
    const dialog = await screen.findByRole("dialog");
    const create = within(dialog).getByRole("button", { name: "만들기" });
    expect(create.getAttribute("aria-disabled")).toBe("true");
    await user.type(within(dialog).getByLabelText("id"), "keyed");
    expect(create.getAttribute("aria-disabled")).toBe("true");
    const key = within(dialog).getByLabelText("키 값");
    await user.type(key, "1234567");
    expect(create.getAttribute("aria-disabled")).toBe("true");
    await user.click(create);
    expect(writes(api.calls)).toEqual([]);

    await user.type(key, "8");
    expect(create.getAttribute("aria-disabled")).toBeNull();
    await user.click(create);
    await screen.findByText("keyed를 만들었습니다.");
    expect(writes(api.calls).map((call) => call.body)).toEqual([
      {
        id: "keyed",
        kind: "anthropic",
        billing: "per_token",
        auth_kind: "api_key",
        value: "12345678",
      },
    ]);
  });

  test("replacing a key stays off while the field is empty", async () => {
    const { api } = renderAt(CONNECTIONS_PAGE, routes());
    const user = await setupUser();
    const table = await screen.findByRole("table", { name: "모델 연결" });
    await choose(user, table, "console-key", "console-key의 API 키 설정");
    const dialog = await screen.findByRole("dialog");
    const save = within(dialog).getByRole("button", { name: "저장" });
    expect(save.getAttribute("aria-disabled")).toBe("true");
    await user.click(save);
    expect(writes(api.calls)).toEqual([]);
  });

  test("the result line is a live region before the first result arrives", async () => {
    renderAt(CONNECTIONS_PAGE, routes());
    await screen.findByRole("table", { name: "모델 연결" });
    expect(emptyLiveRegions()).toHaveLength(1);
  });

  test("the result line sits above the table and the notice lands in the region already there", async () => {
    renderAt(CONNECTIONS_PAGE, {
      ...routes(),
      [`POST ${CONNECTIONS}/console-key/disable`]: () =>
        json(200, CHANGE("console-key")),
    });
    const user = await setupUser();
    const table = await screen.findByRole("table", { name: "모델 연결" });
    await expectNoticeInStandingRegion(
      table,
      async () => {
        await choose(user, table, "console-key", "console-key 사용 중지");
        const confirm = await screen.findByRole("dialog");
        await user.click(
          within(confirm).getByRole("button", { name: "사용 중지" }),
        );
      },
      "console-key를 사용 중지했습니다.",
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
    const { api } = renderAt(CONNECTIONS_PAGE, routes(me(undefined, "admin")));
    await screen.findByText("이 화면을 볼 권한이 없습니다");
    expect(screen.queryByRole("button", { name: "연결 추가" }) === null).toBe(
      true,
    );
    expect(screen.queryByRole("table", { name: "모델 연결" }) === null).toBe(
      true,
    );
    expect(api.calls.some((call) => call.path === CONNECTIONS)).toBe(false);
  });
});

describe("MCP 서버", () => {
  // The installation catalog is retired: only the workspace list is left.
  for (const role of ["owner", "admin"] as const) {
    test(`the ${role} gets the workspace servers and no catalog`, async () => {
      const { api } = renderAt("/settings/workspace/mcp-servers", {
        "GET /v1/auth/me": () => json(200, me(undefined, role)),
        "GET /v1/workspace/mcp-servers": () =>
          json(200, { items: [], limit: 20 }),
      });
      await screen.findByText("등록한 서버가 없습니다.", { exact: false });
      expect(screen.queryByText("설치 카탈로그") === null).toBe(true);
      expect(
        api.calls.some((call) => call.path.startsWith("/v1/installation")),
      ).toBe(false);
    });
  }
});

describe("설정의 모델 연결", () => {
  const routes = (signedIn = me()) => ({
    "GET /v1/auth/me": () => json(200, signedIn),
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
    const nav = await screen.findByRole("navigation", {
      name: "워크스페이스 설정",
    });
    await user.click(within(nav).getByRole("link", { name: "모델 연결" }));

    const table = await screen.findByRole("table", { name: "모델 연결" });
    // One h1 for the page; the table's own head is not a second heading.
    expect(
      screen
        .getAllByRole("heading", { name: "모델 연결" })
        .map((h) => h.tagName),
    ).toEqual(["H1"]);
    expect(rowOf(table, "anthropic").textContent).toContain("claude-sonnet-5");
    expect(
      within(screen.getByRole("navigation", { name: "워크스페이스 설정" }))
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

  for (const role of ["admin", "member"] as const) {
    test(`a ${role} gets no menu item, and a direct visit is refused without a request`, async () => {
      const { api } = renderAt(CONNECTIONS_PAGE, routes(me(undefined, role)));
      await screen.findByText("이 화면을 볼 권한이 없습니다");
      const nav = screen.getByRole("navigation", { name: "워크스페이스 설정" });
      expect(
        within(nav).queryByRole("link", { name: "모델 연결" }) === null,
      ).toBe(true);
      expect(screen.queryByRole("button", { name: "연결 추가" }) === null).toBe(
        true,
      );
      expect(api.calls.some((call) => call.path === CONNECTIONS)).toBe(false);
    });
  }
});
