import { describe, expect, test } from "bun:test";
import type { WorkspaceMcpServer } from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import {
  apiError,
  json,
  me,
  memberMe,
  USER_ID,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const PAGE = "/settings/workspace/mcp-servers";
const LIST = "/v1/workspace/mcp-servers";
const WIKI = "3f2b1c4d-0000-4000-8000-000000000001";
const TRACKER = "3f2b1c4d-0000-4000-8000-000000000002";
const AT = "2026-11-15T01:00:00.000Z";
const OWNER = { user_id: USER_ID, display_name: "Owner" };

function oauthServer(
  over: Partial<WorkspaceMcpServer> = {},
): WorkspaceMcpServer {
  return {
    id: WIKI,
    name: "wiki",
    url: "https://mcp.example.com/mcp",
    auth_kind: "oauth",
    redirect_uri: `https://console.test${PAGE}/${WIKI}/callback`,
    oauth: {
      issuer: "https://auth.example.com",
      scope: "read write",
      client_registration: "dcr",
      client_id: "client-1",
      has_client_secret: false,
      dcr_supported: true,
    },
    bearer: null,
    connection: {
      state: "active",
      reauth_reason: null,
      connected_by: OWNER,
      connected_at: AT,
      granted_scope: "read",
      access_expires_at: AT,
    },
    tools: [
      { name: "search", description: null },
      { name: "fetch", description: "Reads a page" },
    ],
    tools_skipped: 1,
    tools_read_at: AT,
    created_by: OWNER,
    created_at: AT,
    ...over,
  };
}

const UNCONNECTED = {
  state: "none",
  reauth_reason: null,
  connected_by: null,
  connected_at: null,
  granted_scope: null,
  access_expires_at: null,
} as const;

function bearerServer(): WorkspaceMcpServer {
  return oauthServer({
    id: TRACKER,
    name: "tracker",
    url: "https://tracker.example.com/mcp",
    auth_kind: "bearer",
    redirect_uri: null,
    oauth: null,
    bearer: { last4: "wxyz" },
    connection: {
      ...UNCONNECTED,
      state: "active",
      connected_by: { user_id: USER_ID, display_name: "Admin Kim" },
      connected_at: AT,
    },
    tools: [],
    tools_skipped: 0,
  });
}

/** A public server: connected from the start, by no one. */
function noneServer(): WorkspaceMcpServer {
  return oauthServer({
    id: TRACKER,
    name: "deepwiki",
    url: "https://mcp.example.com/mcp",
    auth_kind: "none",
    redirect_uri: null,
    oauth: null,
    bearer: null,
    connection: { ...UNCONNECTED, state: "active", connected_at: AT },
  });
}

const routes = (
  items: readonly WorkspaceMcpServer[],
  signedIn = me(),
): Record<string, () => Response> => ({
  "GET /v1/auth/me": () => json(200, signedIn),
  [`GET ${LIST}`]: () => json(200, { items, limit: 20 }),
});

const list = async () =>
  screen.findByRole("list", { name: "워크스페이스 서버" });
const rowOf = async (name: string) => {
  const rows = within(await list()).getAllByRole("listitem");
  const row = rows.find((item) => item.textContent?.includes(name));
  if (!row) throw new Error(`no row for ${name}`);
  return row;
};
const writes = <C extends { readonly method: string }>(calls: readonly C[]) =>
  calls.filter((call) => call.method !== "GET");

describe("워크스페이스 MCP 서버", () => {
  test("a row says whose external account the agents' calls run as", async () => {
    renderAt(PAGE, routes([oauthServer(), bearerServer()]));
    const wiki = await rowOf("wiki");
    expect(wiki.textContent).toContain("연결됨");
    expect(wiki.textContent).toContain("https://mcp.example.com/mcp");
    expect(wiki.textContent).toContain("도구 2개");
    expect(wiki.textContent).toContain("1개 제외");
    expect(wiki.textContent).toContain("mcp__wiki__*");
    const acting = within(wiki).getByRole("region", {
      name: "이 계정으로 동작함",
    });
    expect(acting.textContent).toContain(
      "Owner이(가) 동의 화면에서 로그인한 외부 계정으로 실행되고",
    );
    expect(acting.textContent).toContain("read");
    // Only what the console knows: the person, never an external identity.
    expect(acting.textContent).not.toContain("@");

    const tracker = within(await rowOf("tracker")).getByRole("region", {
      name: "이 계정으로 동작함",
    });
    expect(tracker.textContent).toContain("Admin Kim");
    expect(tracker.textContent).toContain("wxyz");
  });

  test("the result line is a live region before the first result arrives", async () => {
    renderAt(PAGE, routes([oauthServer()]));
    await rowOf("wiki");
    const section = screen.getByRole("region", { name: "워크스페이스 서버" });
    const empty = [
      ...section.querySelectorAll('output[data-slot="alert"]'),
    ].filter((region) => region.textContent === "");
    expect(empty).toHaveLength(1);
  });

  test("a server not yet connected shows no acting account", async () => {
    renderAt(PAGE, routes([oauthServer({ connection: UNCONNECTED })]));
    const wiki = await rowOf("wiki");
    expect(wiki.textContent).toContain("연결 안 됨");
    expect(
      within(wiki).queryByRole("region", { name: "이 계정으로 동작함" }) ===
        null,
    ).toBe(true);
    expect(
      within(wiki).getByRole("button", { name: "wiki 연결" }),
    ).toBeDefined();
    expect(
      within(wiki).queryByRole("button", { name: "wiki 연결 끊기" }) === null,
    ).toBe(true);
  });

  test("an expired sign-in says why and offers to connect again", async () => {
    renderAt(
      PAGE,
      routes([
        oauthServer({
          connection: {
            ...oauthServer().connection,
            state: "needs_reauth",
            reauth_reason: "invalid_grant",
          },
        }),
      ]),
    );
    const wiki = await rowOf("wiki");
    expect(wiki.textContent).toContain("다시 연결 필요");
    expect(wiki.textContent).toContain("다시 연결하세요");
    expect(
      within(wiki).getByRole("button", { name: "wiki 다시 연결" }),
    ).toBeDefined();
  });

  test("connect leaves for the authorization server the API names", async () => {
    const authorization = "https://auth.example.com/authorize?state=s1";
    const { api, left } = renderAt(PAGE, {
      ...routes([oauthServer({ connection: UNCONNECTED })]),
      [`POST ${LIST}/${WIKI}/oauth/start`]: () =>
        json(200, { authorization_url: authorization, expires_at: AT }),
    });
    const user = await setupUser();
    await user.click(
      within(await rowOf("wiki")).getByRole("button", { name: "wiki 연결" }),
    );
    await waitFor(() => expect(left).toEqual([authorization]));
    expect(writes(api.calls).map((call) => call.path)).toEqual([
      `${LIST}/${WIKI}/oauth/start`,
    ]);
  });

  test("a refused start says the server's reason", async () => {
    const { left } = renderAt(PAGE, {
      ...routes([oauthServer({ connection: UNCONNECTED })]),
      [`POST ${LIST}/${WIKI}/oauth/start`]: () =>
        apiError(400, "BAD_REQUEST", "refused", false, {
          reason_code: "console_origin_unset",
        }),
    });
    const user = await setupUser();
    await user.click(
      within(await rowOf("wiki")).getByRole("button", { name: "wiki 연결" }),
    );
    expect(
      await screen.findByText(/콘솔 주소\(CONSOLE_ORIGIN\)가 설정되지 않아/),
    ).toBeDefined();
    expect(left).toEqual([]);
  });

  test("register discovers first, then sends the name and scope", async () => {
    const { api } = renderAt(PAGE, {
      ...routes([]),
      [`POST ${LIST}/discover`]: () =>
        json(200, {
          url: "https://mcp.example.com/mcp",
          oauth: {
            issuer: "https://auth.example.com",
            scopes_supported: ["read", "write"],
            default_scope: "read",
            dcr_supported: true,
          },
        }),
      [`POST ${LIST}`]: () =>
        json(201, oauthServer({ connection: UNCONNECTED })),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "서버 등록" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(
      within(dialog).getByLabelText("서버 URL"),
      "https://mcp.example.com/mcp",
    );
    await user.click(within(dialog).getByRole("button", { name: "탐색" }));
    const found = await within(dialog).findByRole("region", {
      name: "탐색 결과",
    });
    expect(found.textContent).toContain("https://auth.example.com");
    expect(found.textContent).toContain("동적 client 등록을 받습니다");
    expect(
      (within(dialog).getByLabelText("요청할 scope") as HTMLInputElement).value,
    ).toBe("read");
    await user.type(within(dialog).getByLabelText("이름"), "wiki");
    await user.click(within(dialog).getByRole("button", { name: "등록" }));
    expect(
      await screen.findByText(
        "wiki을(를) 등록했습니다. 연결을 눌러 인가 서버에 로그인하세요.",
      ),
    ).toBeDefined();
    expect(
      writes(api.calls).map((call) => [call.path, call.body] as const),
    ).toEqual([
      [`${LIST}/discover`, { url: "https://mcp.example.com/mcp" }],
      [
        LIST,
        {
          name: "wiki",
          url: "https://mcp.example.com/mcp",
          auth_kind: "oauth",
          scope: "read",
        },
      ],
    ]);
  });

  test("a reserved name is refused in the dialog and nothing is registered", async () => {
    const { api } = renderAt(PAGE, {
      ...routes([]),
      [`POST ${LIST}/discover`]: () =>
        json(200, { url: "https://mcp.example.com/mcp", oauth: null }),
      [`POST ${LIST}`]: () => json(201, bearerServer()),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "서버 등록" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(
      within(dialog).getByLabelText("서버 URL"),
      "https://mcp.example.com/mcp",
    );
    await user.click(within(dialog).getByRole("button", { name: "탐색" }));
    await within(dialog).findByRole("region", { name: "탐색 결과" });
    await user.type(within(dialog).getByLabelText("이름"), "github");
    await user.type(
      dialog.querySelector('input[name="token"]') as HTMLInputElement,
      "example-static-value",
    );
    await user.click(within(dialog).getByRole("button", { name: "등록" }));
    expect(
      await within(dialog).findByText(
        "github, browser, memory, werft는 쓸 수 없는 이름입니다.",
      ),
    ).toBeDefined();
    expect(writes(api.calls).map((call) => call.path)).toEqual([
      `${LIST}/discover`,
    ]);
  });

  test("at the server's limit register is withheld with the reason and opens nothing", async () => {
    const { api } = renderAt(PAGE, {
      ...routes([]),
      [`GET ${LIST}`]: () =>
        json(200, { items: [oauthServer(), bearerServer()], limit: 2 }),
    });
    const user = await setupUser();
    await rowOf("tracker");
    const register = screen.getByRole("button", { name: "서버 등록" });
    expect(register.getAttribute("aria-disabled")).toBe("true");
    expect(
      (register.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent)
        .join(" "),
    ).toContain("워크스페이스가 등록할 수 있는 서버 수에 닿았습니다.");
    await user.click(register);
    expect(screen.queryByRole("dialog") === null).toBe(true);
    expect(writes(api.calls)).toEqual([]);
  });

  test("a server without OAuth registers with a static value by default", async () => {
    const { api } = renderAt(PAGE, {
      ...routes([]),
      [`POST ${LIST}/discover`]: () =>
        json(200, { url: "https://tracker.example.com/mcp", oauth: null }),
      [`POST ${LIST}`]: () => json(201, bearerServer()),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "서버 등록" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(
      within(dialog).getByLabelText("서버 URL"),
      "https://tracker.example.com/mcp",
    );
    await user.click(within(dialog).getByRole("button", { name: "탐색" }));
    await within(dialog).findByRole("region", { name: "탐색 결과" });
    const kind = within(dialog).getByLabelText(
      "인증 방식",
    ) as HTMLSelectElement;
    expect(kind.value).toBe("bearer");
    // No OAuth to offer: a static value, or none at all.
    expect([...kind.options].map((option) => option.value)).toEqual([
      "bearer",
      "none",
    ]);
    expect(within(dialog).queryByLabelText("요청할 scope") === null).toBe(true);
    const secret = dialog.querySelector(
      'input[name="token"]',
    ) as HTMLInputElement;
    expect(secret.type).toBe("password");
    await user.type(within(dialog).getByLabelText("이름"), "tracker");
    await user.type(secret, "example-static-value");
    await user.click(within(dialog).getByRole("button", { name: "등록" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog") === null).toBe(true),
    );
    expect(writes(api.calls).at(-1)?.body).toEqual({
      name: "tracker",
      url: "https://tracker.example.com/mcp",
      auth_kind: "bearer",
      token: "example-static-value",
    });
  });

  test("a public server registers with no authentication and sends no token", async () => {
    const { api } = renderAt(PAGE, {
      ...routes([]),
      [`POST ${LIST}/discover`]: () =>
        json(200, { url: "https://mcp.example.com/mcp", oauth: null }),
      [`POST ${LIST}`]: () => json(201, noneServer()),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "서버 등록" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(
      within(dialog).getByLabelText("서버 URL"),
      "https://mcp.example.com/mcp",
    );
    await user.click(within(dialog).getByRole("button", { name: "탐색" }));
    await within(dialog).findByRole("region", { name: "탐색 결과" });
    await user.selectOptions(
      within(dialog).getByLabelText("인증 방식"),
      "none",
    );
    expect(dialog.textContent).toContain(
      "인증 없이 부를 수 있는 공개 서버에만 고르세요.",
    );
    expect(dialog.querySelector('input[name="token"]') === null).toBe(true);
    await user.type(within(dialog).getByLabelText("이름"), "deepwiki");
    await user.click(within(dialog).getByRole("button", { name: "등록" }));
    expect(
      await screen.findByText("deepwiki을(를) 인증 없이 등록했습니다."),
    ).toBeDefined();
    expect(writes(api.calls).at(-1)?.body).toEqual({
      name: "deepwiki",
      url: "https://mcp.example.com/mcp",
      auth_kind: "none",
    });
  });

  test("the register dialog states the address rule, not an operator list", async () => {
    renderAt(PAGE, routes([]));
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "서버 등록" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/IP 주소가 아닌 호스트 이름이어야 하고/),
    ).toBeDefined();
    expect(
      within(dialog).getByText(/풀린 주소가 모두 공개 주소여야/),
    ).toBeDefined();
    expect(
      within(dialog).getByText(/예외는 운영자가 사설 목록에 둔 호스트 이름뿐/),
    ).toBeDefined();
    expect(within(dialog).queryByText(/허용 목록/) === null).toBe(true);
  });

  test("a refused discovery keeps the dialog and says why", async () => {
    renderAt(PAGE, {
      ...routes([]),
      [`POST ${LIST}/discover`]: () =>
        apiError(400, "BAD_REQUEST", "refused", false, {
          reason_code: "endpoint_not_allowed",
        }),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "서버 등록" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(
      within(dialog).getByLabelText("서버 URL"),
      "https://mcp.example.com/mcp",
    );
    await user.click(within(dialog).getByRole("button", { name: "탐색" }));
    expect(
      await within(dialog).findByText(/계정 정보나 #이 들어 있거나/),
    ).toBeDefined();
    expect(within(dialog).queryByLabelText("이름") === null).toBe(true);
  });

  test("an old API's host_not_allowed answer still says who can add the host", async () => {
    renderAt(PAGE, {
      ...routes([]),
      [`POST ${LIST}/discover`]: () =>
        apiError(400, "BAD_REQUEST", "refused", false, {
          reason_code: "host_not_allowed",
        }),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "서버 등록" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(
      within(dialog).getByLabelText("서버 URL"),
      "https://mcp.example.com/mcp",
    );
    await user.click(within(dialog).getByRole("button", { name: "탐색" }));
    expect(
      await within(dialog).findByText(
        /egress proxy의 EGRESS_CREDENTIAL_ALLOWLIST에 넣어 달라고/,
      ),
    ).toBeDefined();
  });

  test("a replaced static value leaves the cache and the keyboard goes back", async () => {
    const { api, services } = renderAt(PAGE, {
      ...routes([bearerServer()]),
      [`PUT ${LIST}/${TRACKER}/token`]: () => json(200, bearerServer()),
    });
    const user = await setupUser();
    const opener = within(await rowOf("tracker")).getByRole("button", {
      name: "tracker token 바꾸기",
    });
    await user.click(opener);
    const dialog = await screen.findByRole("dialog");
    await user.type(
      dialog.querySelector('input[name="token"]') as HTMLInputElement,
      "fake-value-0000",
    );
    await user.click(within(dialog).getByRole("button", { name: "저장" }));
    expect(
      await screen.findByText("tracker의 token을 바꿨습니다."),
    ).toBeDefined();
    expect(writes(api.calls).at(-1)?.body).toEqual({
      token: "fake-value-0000",
    });
    await waitFor(() =>
      expect(services.queryClient.getMutationCache().getAll()).toEqual([]),
    );
    await waitFor(() => expect(document.activeElement === opener).toBe(true));
  });

  test("closing the client and register dialogs gives the keyboard back", async () => {
    renderAt(
      PAGE,
      routes([
        oauthServer({
          oauth: {
            issuer: "https://auth.example.com",
            scope: "read",
            client_registration: "manual",
            client_id: "client-1",
            has_client_secret: false,
            dcr_supported: false,
          },
        }),
      ]),
    );
    const user = await setupUser();
    await list();
    for (const name of ["wiki client 설정", "서버 등록"]) {
      const opener = screen.getByRole("button", { name });
      await user.click(opener);
      await screen.findByRole("dialog");
      await user.keyboard("{Escape}");
      await waitFor(() =>
        expect(screen.queryByRole("dialog") === null).toBe(true),
      );
      await waitFor(() => expect(document.activeElement === opener).toBe(true));
    }
  });

  test("disconnect asks first and says when revocation was not accepted", async () => {
    const { api } = renderAt(PAGE, {
      ...routes([oauthServer()]),
      [`POST ${LIST}/${WIKI}/disconnect`]: () =>
        json(200, {
          server: oauthServer({ connection: UNCONNECTED }),
          revoked: false,
        }),
    });
    const user = await setupUser();
    await user.click(
      within(await rowOf("wiki")).getByRole("button", {
        name: "wiki 연결 끊기",
      }),
    );
    const confirm = await screen.findByRole("dialog");
    expect(writes(api.calls)).toEqual([]);
    await user.click(within(confirm).getByRole("button", { name: "끊기" }));
    expect(
      await screen.findByText(/wiki의 연결을 끊었습니다\. 인가 서버가/),
    ).toBeDefined();
    expect(writes(api.calls).map((call) => call.path)).toEqual([
      `${LIST}/${WIKI}/disconnect`,
    ]);
  });

  test("a member reads the list and gets no buttons", async () => {
    renderAt(PAGE, routes([oauthServer()], memberMe()));
    const wiki = await rowOf("wiki");
    expect(within(wiki).queryAllByRole("button")).toEqual([]);
    expect(screen.queryByRole("button", { name: "서버 등록" }) === null).toBe(
      true,
    );
    expect(
      screen.getByText("보기만 할 수 있습니다", { exact: false }),
    ).toBeDefined();
    expect(screen.queryByText("설치 카탈로그") === null).toBe(true);
  });

  test("a server with no authentication says so and offers only tools and delete", async () => {
    renderAt(PAGE, routes([noneServer()]));
    const row = await rowOf("deepwiki");
    expect(row.textContent).toContain("연결됨");
    expect(row.textContent).toContain("인증 없음");
    expect(row.textContent).not.toContain("지원하지 않는 인증");
    const acting = within(row).getByRole("region", {
      name: "자격 없이 호출함",
    });
    expect(acting.textContent).toContain("인증 없이 부르는 서버입니다.");
    expect(
      within(row).queryByRole("region", { name: "이 계정으로 동작함" }) ===
        null,
    ).toBe(true);
    expect(acting.textContent).not.toContain("알 수 없는 사용자");
    expect(
      within(row)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["deepwiki 도구 다시 읽기", "deepwiki 삭제"]);
  });

  test("a server of an auth kind this version does not know stays listed with delete only", async () => {
    const later = {
      ...bearerServer(),
      auth_kind: "mtls",
      bearer: null,
    } satisfies WorkspaceMcpServer;
    renderAt(PAGE, routes([oauthServer(), later]));
    const tracker = await rowOf("tracker");
    expect(tracker.textContent).toContain("지원하지 않는 인증");
    expect(tracker.textContent).toContain(
      "인증 방식(mtls)을 지원하지 않습니다",
    );
    expect(
      within(tracker).queryByRole("region", { name: "이 계정으로 동작함" }) ===
        null,
    ).toBe(true);
    expect(
      within(tracker)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["tracker 삭제"]);
    // The known row beside it keeps its actions.
    const wiki = await rowOf("wiki");
    expect(wiki.textContent).toContain("OAuth");
    expect(
      within(wiki).getByRole("button", { name: "wiki 다시 연결" }),
    ).toBeDefined();
    expect(
      within(wiki).getByRole("button", { name: "wiki 도구 다시 읽기" }),
    ).toBeDefined();
  });

  test("the owner sees the workspace servers and no installation catalog", async () => {
    renderAt(PAGE, routes([oauthServer()]));
    await list();
    const headings = screen
      .getAllByRole("heading")
      .map((heading) => heading.textContent);
    expect(headings).toContain("워크스페이스 서버");
    expect(headings).not.toContain("설치 카탈로그");
    // Not in any copy either, the page description included.
    expect(document.body.textContent).toContain("어드민이 등록하고 인증합니다");
    expect(document.body.textContent).not.toContain("카탈로그");
  });
});

describe("OAuth 콜백", () => {
  const CALLBACK = `${PAGE}/${WIKI}/callback`;

  test("it completes once with the code, state and iss, then returns with a notice", async () => {
    const { api, history } = renderAt(
      `${CALLBACK}?code=c1&state=s1&iss=https%3A%2F%2Fauth.example.com`,
      {
        ...routes([oauthServer()]),
        [`POST ${LIST}/${WIKI}/oauth/complete`]: () => json(200, oauthServer()),
      },
    );
    expect(await screen.findByText("wiki을(를) 연결했습니다.")).toBeDefined();
    expect(history.location.pathname).toBe(PAGE);
    expect(
      writes(api.calls).map((call) => [call.path, call.body] as const),
    ).toEqual([
      [
        `${LIST}/${WIKI}/oauth/complete`,
        { code: "c1", state: "s1", iss: "https://auth.example.com" },
      ],
    ]);
  });

  test("a refusal from the authorization server sends nothing", async () => {
    const { api } = renderAt(`${CALLBACK}?error=access_denied&state=s1`, {
      ...routes([]),
    });
    expect(
      await screen.findByText(
        /로그인을 허용하지 않았습니다\(코드: access_denied\)/,
      ),
    ).toBeDefined();
    expect(writes(api.calls)).toEqual([]);
    expect(
      screen.getByRole("link", { name: "MCP 서버로 돌아가기" }),
    ).toBeDefined();
  });

  test("a refused completion says the API's reason and keeps no code", async () => {
    const { history, services } = renderAt(
      `${CALLBACK}?code=code-once-1&state=s1`,
      {
        ...routes([]),
        [`POST ${LIST}/${WIKI}/oauth/complete`]: () =>
          apiError(400, "BAD_REQUEST", "refused", false, {
            reason_code: "oauth_flow_other_user",
          }),
      },
    );
    expect(
      await screen.findByText(/다른 사람이 시작한 로그인입니다/),
    ).toBeDefined();
    expect(history.location.pathname).toBe(CALLBACK);
    expect(history.location.href).not.toContain("code-once-1");
    await waitFor(() =>
      expect(services.queryClient.getMutationCache().getAll()).toEqual([]),
    );
  });

  test("an ended console sign-in stays here, out of the login address", async () => {
    const signedOut = () => apiError(401, "UNAUTHORIZED", "signed out", false);
    const { api, history } = renderAt(`${CALLBACK}?code=code-once-2&state=s1`, {
      ...routes([]),
      "GET /v1/auth/me": signedOut,
      [`POST ${LIST}/${WIKI}/oauth/complete`]: signedOut,
    });
    expect(
      await screen.findByText(
        /그사이 콘솔 로그인이 끝나 연결을 마치지 못했습니다/,
      ),
    ).toBeDefined();
    expect(history.location.pathname).toBe(CALLBACK);
    expect(history.location.href).not.toContain("code-once-2");
    expect(writes(api.calls).map((call) => call.path)).toEqual([
      `${LIST}/${WIKI}/oauth/complete`,
    ]);
  });
});
