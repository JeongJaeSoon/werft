import { describe, expect, test } from "bun:test";
import type {
  CreateInstallationProfileRequest,
  InstallationProfileOptionsResponse,
  ProfileSummary,
} from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { json, me, memberMe } from "../test-support/fake-api.ts";
import {
  CATALOG_ID,
  CATALOG_TOOLS,
  ceiling,
  imported,
  OPTIONS,
  RECEIPT_ID,
  refusal,
  version,
} from "../test-support/profiles.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { act, renderAt, screen, waitFor, within } = await appHarness();

const CODING = imported("coding-claude");
const GENERAL = imported("general-read", {
  model: "claude-haiku-5",
  models: ["claude-haiku-5"],
  tools: [],
  permission_mode: "default",
  billing: "none",
  repository_mode: "none",
  repository_ids: [],
});

function catalog(
  start: ProfileSummary[] = [CODING, GENERAL],
  signedIn = me(),
  options: InstallationProfileOptionsResponse = OPTIONS,
) {
  const items = [...start];
  return {
    items,
    routes: {
      "GET /v1/auth/me": () => json(200, signedIn),
      "GET /v1/profiles": () => json(200, { items }),
      "GET /v1/agents": () => json(200, { items: [], next_cursor: null }),
      "GET /v1/installation-profiles/options": () => json(200, options),
      "POST /v1/installation-profiles": async (request: Request) => {
        const body = (await request.json()) as CreateInstallationProfileRequest;
        const denied = body.deny ?? [];
        const n =
          items.filter((item) => item.installation?.name === body.name).length +
          1;
        // An admin names no connection: the profile narrows a source.
        if (body.connection_id === undefined) {
          const source =
            body.derived_from ??
            items.find((item) => item.id === body.previous_id)?.installation
              ?.derived_from ??
            undefined;
          const from = items.find((item) => item.id === source);
          const narrowed = version(
            n,
            "usable",
            {
              model: body.model,
              models: body.models,
              permission_mode: body.permission_mode,
              tools: (from?.tools ?? []).filter(
                (tool) => !denied.includes(tool),
              ),
            },
            source,
            body.name,
          );
          items.push(narrowed);
          return json(201, { profile: narrowed, receipt_id: RECEIPT_ID });
        }
        const made = ceiling(
          body.name,
          n,
          {
            model: body.model,
            models: body.models,
            tools: CATALOG_TOOLS.map((tool) => tool.name).filter(
              (name) => !denied.includes(name),
            ),
            permission_mode: body.permission_mode,
          },
          { previous_id: body.previous_id ?? null },
        );
        items.push(made);
        return json(201, { profile: made, receipt_id: RECEIPT_ID });
      },
    },
  };
}

const posted = (api: { calls: { method: string; body?: unknown }[] }) =>
  api.calls.filter((call) => call.method === "POST").map((call) => call.body);

const form = () =>
  screen.getByRole("main").querySelector("form") as HTMLElement;

describe("프로필 만들기 (관리자)", () => {
  test("an admin clones a profile, narrows it and lands on the new one", async () => {
    const server = catalog(undefined, me(undefined, "admin"));
    const { api, history } = renderAt("/profiles/new", server.routes);
    await screen.findByRole("heading", { level: 1, name: "프로필 만들기" });
    const base = (await screen.findByLabelText(
      "바탕 프로필",
    )) as HTMLSelectElement;
    expect(base.value).toBe("coding-claude");
    // The models it runs, then the built-in tools to block: what the base
    // runs open, what it blocks ticked and locked.
    expect(
      within(form())
        .getAllByRole("checkbox")
        .map((box) => [
          box.closest("[data-slot=field]")?.querySelector("label")?.textContent,
          box.getAttribute("aria-checked"),
          (box as HTMLButtonElement).disabled,
        ]),
    ).toEqual([
      ["claude-sonnet-5", "true", false],
      ["claude-haiku-5", "false", false],
      ["Read", "false", false],
      ["Edit", "false", false],
      ["Bash", "false", false],
      ["Write", "true", true],
      ["WebFetch", "true", true],
      ["WebSearch", "true", true],
    ]);
    const tools = screen.getByRole("group", { name: "차단할 내장 도구" });
    expect(
      within(tools).getAllByText("바탕 프로필이 막은 도구입니다."),
    ).toHaveLength(3);
    // No options here: an admin could not read them, so no boundary badges.
    expect(tools.querySelectorAll("[data-slot=badge]")).toHaveLength(0);
    // Its bound is the base, not a catalog it cannot name.
    expect(
      within(tools).getByText(/^아무것도 더 체크하지 않으면 바탕 프로필 \S+가/),
    ).toBeTruthy();
    expect(within(tools).queryByText(/카탈로그\(/) === null).toBe(true);
    const mode = screen.getByLabelText("권한 모드") as HTMLSelectElement;
    expect(
      [...mode.options].map((option) => [option.value, option.disabled]),
    ).toEqual([
      ["acceptEdits", false],
      ["default", false],
      ["plan", false],
      ["auto", true],
      ["bypassPermissions", true],
    ]);
    const review = screen.getByRole("group", { name: "검토" });
    const changes = () =>
      Array.from(review.querySelectorAll("dt"), (term) => [
        term.textContent,
        term.nextElementSibling?.textContent,
      ]);
    // A new profile starts on the base's default model alone.
    expect(changes()).toEqual([
      ["모델", "claude-sonnet-5, claude-haiku-5 → claude-sonnet-5"],
    ]);

    const user = await setupUser();
    await user.type(screen.getByLabelText("이름"), "strict");
    await user.click(screen.getByRole("checkbox", { name: "Bash" }));
    await user.selectOptions(mode, "plan");
    // The review lists only what changed.
    expect(changes()).toEqual([
      ["모델", "claude-sonnet-5, claude-haiku-5 → claude-sonnet-5"],
      [
        "차단한 도구",
        "Write, WebFetch, WebSearch → Bash, Write, WebFetch, WebSearch",
      ],
      ["권한 모드", "acceptEdits → plan"],
    ]);
    await user.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() =>
      expect(history.location.pathname).toBe("/profiles/op_wl_strict_v1"),
    );
    // A block list only, the base's blocks kept; no field the owner alone sets.
    expect(posted(api)).toEqual([
      {
        name: "strict",
        derived_from: "coding-claude",
        model: "claude-sonnet-5",
        models: ["claude-sonnet-5"],
        permission_mode: "plan",
        deny: ["Bash", "Write", "WebFetch", "WebSearch"],
      },
    ]);
  });

  test("an admin gets the clone form, never the owner's connection and runtime fields", async () => {
    const { api } = renderAt(
      "/profiles/new",
      catalog(undefined, me(undefined, "admin")).routes,
    );
    await screen.findByLabelText("바탕 프로필");
    expect(screen.queryAllByRole("radiogroup").length).toBe(0);
    expect(screen.queryAllByLabelText("연결").length).toBe(0);
    // It never asks for what only an owner may read.
    expect(
      api.calls.some((call) =>
        call.path.startsWith("/v1/installation-profiles"),
      ),
    ).toBe(false);
  });

  test("a member is told why there is no form", async () => {
    renderAt("/profiles/new", catalog(undefined, memberMe()).routes);
    await screen.findByText(/워크스페이스 설정 변경/);
    expect(screen.getByRole("main").querySelector("form")).toBeNull();
  });

  test("a new profile starts on a base that allows auto, at auto, and may pick bypassPermissions over a bypass base", async () => {
    const operator = (id: string, mode: "auto" | "bypassPermissions") =>
      imported(id, { permission_mode: mode });
    const server = catalog(
      [
        CODING,
        GENERAL,
        operator("coding-auto", "auto"),
        operator("coding-bypass", "bypassPermissions"),
      ],
      me(undefined, "admin"),
    );
    const { api } = renderAt("/profiles/new", server.routes);
    const base = (await screen.findByLabelText(
      "바탕 프로필",
    )) as HTMLSelectElement;
    expect(base.value).toBe("coding-auto");
    const mode = screen.getByLabelText("권한 모드") as HTMLSelectElement;
    expect(mode.value).toBe("auto");
    const user = await setupUser();
    await user.selectOptions(base, "coding-bypass");
    const risk = /^bypassPermissions는 모든 도구 호출을 아무 판정 없이/;
    expect(screen.queryAllByText(risk).length).toBe(0);
    await user.type(screen.getByLabelText("이름"), "free");
    await user.selectOptions(mode, "bypassPermissions");
    const warning = screen.getByText(risk).closest("[data-slot=alert]");
    expect(mode.getAttribute("aria-describedby")?.split(" ")).toContain(
      warning?.id,
    );
    await user.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(posted(api)).toHaveLength(1));
    expect(posted(api)[0]).toMatchObject({
      derived_from: "coding-bypass",
      permission_mode: "bypassPermissions",
    });
  });

  test("from=<profile> starts on that profile", async () => {
    renderAt(
      "/profiles/new?from=general-read",
      catalog(undefined, me(undefined, "admin")).routes,
    );
    const base = (await screen.findByLabelText(
      "바탕 프로필",
    )) as HTMLSelectElement;
    expect(base.value).toBe("general-read");
  });

  test("mode=version starts from the version it follows and keeps its name", async () => {
    const server = catalog(
      [
        CODING,
        version(1, "usable", {
          tools: ["Read", "Edit"],
          permission_mode: "plan",
        }),
      ],
      me(undefined, "admin"),
    );
    const { api } = renderAt(
      "/profiles/new?from=op_wl_strict_v1&mode=version",
      server.routes,
    );
    await screen.findByRole("heading", { level: 1, name: "strict 새 버전" });
    expect(screen.queryAllByRole("radiogroup").length).toBe(0);
    expect(screen.queryAllByLabelText("바탕 프로필").length).toBe(0);
    expect((screen.getByLabelText("이름") as HTMLInputElement).readOnly).toBe(
      true,
    );
    // It starts on what v1 blocked: Bash, and the base's blocks.
    const blocked = () =>
      within(screen.getByRole("group", { name: "차단할 내장 도구" }))
        .getAllByRole("checkbox")
        .filter((box) => box.getAttribute("aria-checked") === "true")
        .map(
          (box) =>
            box.closest("[data-slot=field]")?.querySelector("label")
              ?.textContent,
        );
    expect(blocked()).toEqual(["Bash", "Write", "WebFetch", "WebSearch"]);
    const user = await setupUser();
    await user.click(screen.getByRole("checkbox", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "새 버전으로 저장" }));
    await waitFor(() => expect(posted(api)).toHaveLength(1));
    expect(posted(api)).toEqual([
      {
        name: "strict",
        previous_id: "op_wl_strict_v1",
        model: "claude-sonnet-5",
        models: ["claude-sonnet-5"],
        permission_mode: "plan",
        deny: ["Edit", "Bash", "Write", "WebFetch", "WebSearch"],
      },
    ]);
  });

  test("a version over a ceiling that does not run here cannot be continued", async () => {
    renderAt(
      "/profiles/new?from=op_wl_strict_v1&mode=version",
      catalog(
        [imported("coding-claude", {}, "retired"), version(1, "usable")],
        me(undefined, "admin"),
      ).routes,
    );
    expect(await screen.findByText("지금은 만들 수 없습니다")).toBeDefined();
  });

  test("a name the server would refuse, too many tools or too long a name are caught before the request", async () => {
    // Blocks that a version keeps, more than a request holds.
    const wide = imported("coding-claude", {
      tools: [],
      deny: Array.from({ length: 65 }, (_, n) => `Tool${n}`),
    });
    const { api } = renderAt(
      "/profiles/new",
      catalog([wide], me(undefined, "admin")).routes,
    );
    const user = await setupUser();
    await user.type(await screen.findByLabelText("이름"), "Strict Review");
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect(
      await screen.findByText(
        "이름은 영문 소문자나 숫자로 시작하고, 영문 소문자·숫자·-로 40자까지 씁니다.",
      ),
    ).toBeDefined();
    await user.clear(screen.getByLabelText("이름"));
    await user.type(screen.getByLabelText("이름"), "wide");
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect(
      await screen.findByText(
        "한 프로필에는 모델 32개, 도구 64개까지 담습니다. 줄인 뒤 다시 저장하세요.",
      ),
    ).toBeDefined();
    expect(posted(api)).toEqual([]);
  });

  test("a save the base no longer allows, or over a base retired meanwhile, says so", async () => {
    let details: Record<string, unknown> = {
      reason_code: "widens_base",
      field: "tools",
    };
    renderAt("/profiles/new", {
      ...catalog(undefined, me(undefined, "admin")).routes,
      "POST /v1/installation-profiles": () =>
        refusal(400, "BAD_REQUEST", details),
    });
    const user = await setupUser();
    await user.type(await screen.findByLabelText("이름"), "strict");
    await user.click(screen.getByRole("button", { name: "저장" }));
    // Each beside the field the server named, not in a banner.
    const widens = await screen.findByText(
      "바탕 프로필이 허용하지 않는 값입니다. 목록을 다시 불러와 바탕 프로필을 확인하세요.",
    );
    expect(
      screen.getByRole("group", { name: "차단할 내장 도구" }).contains(widens),
    ).toBe(true);
    details = { reason_code: "retired", field: "base_profile_id" };
    await user.click(screen.getByRole("button", { name: "저장" }));
    const retired = await screen.findByText(
      "그 바탕 프로필은 지금 쓸 수 없습니다. 사용할 수 있는 바탕 프로필을 고르세요.",
    );
    expect(
      screen
        .getByLabelText("바탕 프로필")
        .closest("[data-slot=field]")
        ?.contains(retired),
    ).toBe(true);
    expect(
      form().querySelectorAll("[data-slot=alert][role=alert]"),
    ).toHaveLength(0);
  });

  test("a base the list read again as retired is refused before the request", async () => {
    const server = catalog(undefined, me(undefined, "admin"));
    const { api, services } = renderAt("/profiles/new", server.routes);
    const base = (await screen.findByLabelText(
      "바탕 프로필",
    )) as HTMLSelectElement;
    server.items[0] = imported("coding-claude", {}, "retired");
    await act(() => services.queryClient.invalidateQueries());
    await waitFor(() =>
      expect(
        Array.from(base.options).find(
          (option) => option.value === "coding-claude",
        )?.disabled,
      ).toBe(true),
    );
    const user = await setupUser();
    await user.type(screen.getByLabelText("이름"), "strict");
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect(
      await screen.findByText(
        "그 바탕 프로필은 지금 쓸 수 없습니다. 사용할 수 있는 바탕 프로필을 고르세요.",
      ),
    ).toBeDefined();
    expect(posted(api)).toEqual([]);
  });
});

describe("프로필 만들기 (설치 프로필)", () => {
  test("an owner gets one form with no kind to pick, and it reads its choices from options", async () => {
    renderAt("/profiles/new", catalog().routes);
    await screen.findByRole("heading", {
      level: 1,
      name: "프로필 만들기",
    });
    expect(screen.queryAllByRole("radiogroup").length).toBe(0);
    const connection = (await screen.findByLabelText(
      "연결",
    )) as HTMLSelectElement;
    expect(
      Array.from(connection.options, (option) => option.textContent),
    ).toEqual([
      "anthropic (anthropic · 비용 집계)",
      "local (litellm · 비용 집계 안 함)",
    ]);
    expect(
      Array.from(
        (screen.getByLabelText("런타임") as HTMLSelectElement).options,
        (option) => option.value,
      ),
    ).toEqual(["claude_agent_sdk"]);
    // A new ceiling takes the runtime version the installation already runs.
    expect(
      (screen.getByLabelText("런타임 버전") as HTMLInputElement).value,
    ).toBe("0.3.270");
    expect(
      Array.from(
        within(form()).getAllByRole("checkbox"),
        (box) =>
          box.closest("[data-slot=field]")?.querySelector("label")?.textContent,
      ),
    ).toEqual([
      "Read",
      "Edit",
      "Write",
      "Bash",
      "WebFetch",
      "WebSearch",
      "저장소의 CLAUDE.md 읽기",
    ]);
    // No repository is asked for: a session picks its own.
    expect(
      screen.queryAllByLabelText(/저장소 쓰지 않음|허용할 저장소/),
    ).toEqual([]);
  });

  test("with the unattended switch off, bypassPermissions is listed closed with its reason; on, it warns", async () => {
    renderAt("/profiles/new", catalog().routes);
    const mode = (await screen.findByLabelText(
      "권한 모드",
    )) as HTMLSelectElement;
    expect(
      [...mode.options].map((option) => [option.value, option.disabled]),
    ).toEqual([
      ["default", false],
      ["acceptEdits", false],
      ["plan", false],
      ["auto", false],
      ["bypassPermissions", true],
    ]);
    // A new ceiling starts on auto, so its sessions push and open pull
    // requests without asking a person.
    expect(mode.value).toBe("auto");
    expect(
      screen.getByText(
        "이 설치는 PLATFORM_ALLOW_UNATTENDED_PERMISSIONS가 꺼져 있어 bypassPermissions를 고를 수 없습니다.",
      ),
    ).toBeDefined();
  });

  test("with the unattended switch on, bypassPermissions may be picked and warns", async () => {
    renderAt(
      "/profiles/new",
      catalog(undefined, me(), { ...OPTIONS, unattended_allowed: true }).routes,
    );
    const mode = (await screen.findByLabelText(
      "권한 모드",
    )) as HTMLSelectElement;
    expect(
      [...mode.options].find((option) => option.value === "bypassPermissions")
        ?.disabled,
    ).toBe(false);
    expect(screen.queryAllByText(/를 고를 수 없습니다\.$/).length).toBe(0);
    const user = await setupUser();
    await user.selectOptions(mode, "bypassPermissions");
    const warning = screen
      .getByText(/^bypassPermissions는 모든 도구 호출을 아무 판정 없이/)
      .closest("[data-slot=alert]");
    expect(mode.getAttribute("aria-describedby")?.split(" ")).toContain(
      warning?.id,
    );
  });

  test("an owner saves a first version and lands on it", async () => {
    const { api, history } = renderAt("/profiles/new", catalog().routes);
    await screen.findByRole("heading", {
      level: 1,
      name: "프로필 만들기",
    });
    const user = await setupUser();
    await user.type(await screen.findByLabelText("이름"), "wide");
    expect(screen.getByText("wide v1으로 저장합니다.")).toBeDefined();
    await user.selectOptions(screen.getByLabelText("연결"), "local");
    await user.type(
      screen.getByLabelText("모델"),
      "claude-sonnet-5{Enter}claude-opus-5{Enter}claude-sonnet-5",
    );
    await user.selectOptions(
      screen.getByLabelText("기본 모델"),
      "claude-opus-5",
    );
    await user.click(screen.getByRole("checkbox", { name: "Bash" }));
    await user.selectOptions(screen.getByLabelText("권한 모드"), "auto");
    await user.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(history.location.pathname).toBe("/profiles/op_wide_v1"),
    );
    expect(posted(api)).toEqual([
      {
        name: "wide",
        connection_id: "local",
        runtime_kind: "claude_agent_sdk",
        runtime_version: "0.3.270",
        model: "claude-opus-5",
        models: ["claude-sonnet-5", "claude-opus-5"],
        // The provider-side tool a first version starts blocked, and Bash.
        deny: ["Bash", "WebSearch"],
        permission_mode: "auto",
        project_settings: { claude_md: false },
      },
    ]);
  });

  test("an empty form is caught before the request, each field saying what it needs", async () => {
    const { api } = renderAt("/profiles/new", catalog().routes);
    const user = await setupUser();
    await user.clear(await screen.findByLabelText("런타임 버전"));
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect(
      await screen.findByText(
        "이름은 영문 소문자나 숫자로 시작하고, 영문 소문자·숫자·-로 40자까지 씁니다.",
      ),
    ).toBeDefined();
    expect(
      screen.getByText("런타임 버전을 200자 이하로 적으세요."),
    ).toBeDefined();
    expect(screen.getByText("모델을 하나 이상 고르세요.")).toBeDefined();
    expect(
      (screen.getByLabelText("이름") as HTMLInputElement).getAttribute(
        "aria-invalid",
      ),
    ).toBe("true");
    expect(posted(api)).toEqual([]);
  });

  test("a new version of a console ceiling keeps its name, names it as previous, and reviews only what changed", async () => {
    const server = catalog([CODING, ceiling("wide", 1), ceiling("wide", 2)]);
    const { api } = renderAt(
      "/profiles/new?from=op_wide_v2&mode=version",
      server.routes,
    );
    await screen.findByRole("heading", { level: 1, name: "wide 새 버전" });
    expect(screen.queryAllByRole("radiogroup").length).toBe(0);
    const name = (await screen.findByLabelText("이름")) as HTMLInputElement;
    expect(name.value).toBe("wide");
    expect(name.readOnly).toBe(true);
    expect(screen.getByText("wide v3으로 저장합니다.")).toBeDefined();
    expect(
      screen.getByText("op_wide_v2와 달라진 칸이 없습니다."),
    ).toBeDefined();
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(posted(api)).toHaveLength(1));
    expect(posted(api)[0]).toEqual({
      name: "wide",
      connection_id: "anthropic",
      runtime_kind: "claude_agent_sdk",
      runtime_version: "0.3.270",
      model: "claude-sonnet-5",
      models: ["claude-sonnet-5", "claude-haiku-5"],
      title_model: "claude-haiku-5",
      // What v2 blocked, sent as a block list.
      deny: ["Write", "WebFetch", "WebSearch"],
      permission_mode: "acceptEdits",
      project_settings: { claude_md: true },
      previous_id: "op_wide_v2",
    });
  });

  test("what the installation no longer offers is reviewed as a change", async () => {
    renderAt(
      "/profiles/new?from=op_free_v1&mode=version",
      catalog([
        CODING,
        ceiling("free", 1, { permission_mode: "bypassPermissions" }),
      ]).routes,
    );
    const review = await screen.findByRole("group", { name: "검토" });
    expect(
      Array.from(review.querySelectorAll("dt"), (term) => [
        term.textContent,
        term.nextElementSibling?.textContent,
      ]),
    ).toEqual([["권한 모드", "bypassPermissions → auto"]]);
  });

  test("a new version of an imported ceiling takes a new name and names the import as previous", async () => {
    const { api } = renderAt(
      "/profiles/new?from=coding-claude&mode=version",
      catalog().routes,
    );
    const name = (await screen.findByLabelText("이름")) as HTMLInputElement;
    expect(name.value).toBe("");
    expect(name.readOnly).toBe(false);
    const user = await setupUser();
    await user.type(name, "coding");
    await user.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(posted(api)).toHaveLength(1));
    expect(posted(api)[0]).toMatchObject({
      name: "coding",
      previous_id: "coding-claude",
    });
  });

  const REFUSALS: readonly [string, Record<string, unknown>, string, string][] =
    [
      [
        "unknown_connection",
        { reason_code: "unknown_connection", field: "connection_id" },
        "연결",
        "그 연결이 이 설치에 없습니다. 다시 불러와 연결을 고르세요.",
      ],
      [
        "runtime_not_installed",
        { reason_code: "runtime_not_installed", field: "runtime_kind" },
        "런타임",
        "이 설치의 worker가 그 런타임이나 권한 모드를 받지 않습니다.",
      ],
      [
        "unattended_not_allowed",
        { reason_code: "unattended_not_allowed", field: "permission_mode" },
        "권한 모드",
        "이 설치는 PLATFORM_ALLOW_UNATTENDED_PERMISSIONS가 꺼져 있어 bypassPermissions 프로필을 저장하지 않습니다.",
      ],
      [
        "model_not_in_models",
        { reason_code: "model_not_in_models", field: "model" },
        "기본 모델",
        "기본 모델은 모델 목록에 있어야 합니다.",
      ],
      [
        "invalid_profile",
        { reason_code: "invalid_profile", field: "models.0" },
        "모델",
        "이 값은 프로필로 저장할 수 없습니다.",
      ],
    ];

  for (const [reason, details, label, text] of REFUSALS) {
    test(`a ${reason} refusal shows beside ${label}`, async () => {
      renderAt("/profiles/new?from=coding-claude", {
        ...catalog().routes,
        "POST /v1/installation-profiles": () =>
          refusal(400, "BAD_REQUEST", details),
      });
      const user = await setupUser();
      await user.type(await screen.findByLabelText("이름"), "wide");
      await user.click(screen.getByRole("button", { name: "저장" }));
      const message = await screen.findByText(text);
      const field = screen.getByLabelText(label).closest("[data-slot=field]");
      expect(field?.contains(message)).toBe(true);
      // Beside the field only, not again in a banner above the buttons.
      expect(form().querySelectorAll("[data-slot=alert]")).toHaveLength(0);
    });
  }

  test("a taken display name shows beside the name", async () => {
    renderAt("/profiles/new?from=coding-claude", {
      ...catalog().routes,
      "POST /v1/installation-profiles": () =>
        refusal(409, "REVISION_CONFLICT", {
          reason_code: "name_taken",
          field: "name",
        }),
    });
    const user = await setupUser();
    await user.type(await screen.findByLabelText("이름"), "wide");
    await user.click(screen.getByRole("button", { name: "저장" }));
    const message = await screen.findByText(
      "같은 이름의 프로필이 이미 있습니다.",
    );
    expect(
      screen
        .getByLabelText("이름")
        .closest("[data-slot=field]")
        ?.contains(message),
    ).toBe(true);
  });

  test("a form equal to the latest version says nothing changed and stays", async () => {
    const server = catalog([CODING, ceiling("wide", 1)]);
    const { history } = renderAt("/profiles/new?from=op_wide_v1&mode=version", {
      ...server.routes,
      // The server writes nothing and answers with the latest row.
      "POST /v1/installation-profiles": () =>
        json(200, {
          profile: ceiling("wide", 1),
          receipt_id: null,
        }),
    });
    const user = await setupUser();
    await screen.findByLabelText("이름");
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect(
      await screen.findByText("바뀐 내용이 없어 새 버전을 만들지 않았습니다."),
    ).toBeDefined();
    expect(history.location.pathname).toBe("/profiles/new");
  });

  test("a taken id shows beside the name; a stale previous offers the latest version", async () => {
    let answer = refusal(409, "REVISION_CONFLICT", {
      reason_code: "id_taken",
      field: "name",
    });
    const server = catalog([CODING, ceiling("wide", 1)]);
    const { history } = renderAt("/profiles/new?from=op_wide_v1&mode=version", {
      ...server.routes,
      "POST /v1/installation-profiles": () => answer,
    });
    const user = await setupUser();
    await screen.findByLabelText("이름");
    await user.click(screen.getByRole("button", { name: "저장" }));
    const taken = await screen.findByText(
      "이 이름으로 만들 ID가 이미 있습니다. 다른 이름을 고르세요.",
    );
    expect(
      screen
        .getByLabelText("이름")
        .closest("[data-slot=field]")
        ?.contains(taken),
    ).toBe(true);

    // Another owner saved v2 after this page read the list.
    server.items.push(ceiling("wide", 2));
    answer = refusal(409, "REVISION_CONFLICT", {
      reason_code: "stale_previous",
      latest_id: "op_wide_v2",
    });
    await user.click(screen.getByRole("button", { name: "저장" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "이 이름의 최신 버전은 op_wide_v2입니다. 새 버전은 최신 버전에서 만듭니다.",
    );
    await user.click(
      within(alert).getByRole("link", { name: "최신 버전에서 다시 만들기" }),
    );
    await waitFor(() =>
      expect(history.location.search).toContain("from=op_wide_v2"),
    );
    expect(
      await screen.findByText("op_wide_v2와 달라진 칸이 없습니다."),
    ).toBeDefined();
  });

  test("a refusal for the role says only an owner makes ceilings", async () => {
    renderAt("/profiles/new?from=coding-claude", {
      ...catalog().routes,
      "POST /v1/installation-profiles": () =>
        refusal(403, "FORBIDDEN", { reason_code: "role" }),
    });
    const user = await setupUser();
    await user.type(await screen.findByLabelText("이름"), "wide");
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "연결과 실행 방식을 직접 정하는 프로필은 워크스페이스 owner만 만들고 사용 중지할 수 있습니다.",
    );
  });

  test("with no connection there is no form, and the page says why", async () => {
    renderAt(
      "/profiles/new",
      catalog(undefined, me(), { ...OPTIONS, connections: [] }).routes,
    );
    expect(
      await screen.findByText(
        "이 설치에 연결이 없습니다. 모델 연결에서 연결을 더한 뒤 다시 여세요.",
      ),
    ).toBeDefined();
    expect(screen.getByRole("main").querySelector("form")).toBeNull();
  });

  test("English speaks the same refusals", async () => {
    renderAt(
      "/profiles/new?from=coding-claude",
      {
        ...catalog().routes,
        "POST /v1/installation-profiles": () =>
          refusal(400, "BAD_REQUEST", {
            reason_code: "unknown_connection",
            field: "connection_id",
          }),
      },
      "en",
    );
    const user = await setupUser();
    await user.type(await screen.findByLabelText("Name"), "wide");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText(
        "That connection is not on this installation. Reload and pick a connection.",
      ),
    ).toBeDefined();
  });
});

const OLD_CATALOG_ID = "claude_agent_sdk@0.3.260+claude-code@2.1.260";

/** An older engine's catalog beside the current one: Glob since gone, WebSearch not yet there. */
const TWO_CATALOGS: InstallationProfileOptionsResponse = {
  ...OPTIONS,
  tool_catalogs: [
    {
      id: OLD_CATALOG_ID,
      runtime_kind: "claude_agent_sdk",
      runtime_version: "0.3.260",
      tools: [
        { name: "Read", boundary: "local" },
        { name: "Edit", boundary: "local" },
        { name: "Write", boundary: "local" },
        { name: "Bash", boundary: "local" },
        { name: "Glob", boundary: "local" },
        { name: "WebFetch", boundary: "egress" },
      ],
    },
    ...(OPTIONS.tool_catalogs ?? []),
  ],
};

const blockedBoxes = () =>
  within(screen.getByRole("group", { name: "차단할 내장 도구" }))
    .getAllByRole("checkbox")
    .filter((box) => box.getAttribute("aria-checked") === "true")
    .map(
      (box) =>
        box.closest("[data-slot=field]")?.querySelector("label")?.textContent,
    );

describe("차단할 내장 도구", () => {
  test("a first ceiling lists the catalog to block, each with its boundary, the provider-side one ticked", async () => {
    renderAt("/profiles/new", catalog().routes);
    const tools = await screen.findByRole("group", {
      name: "차단할 내장 도구",
    });
    expect(tools.tagName).toBe("FIELDSET");
    expect(
      within(tools)
        .getAllByRole("checkbox")
        .map((box) => {
          const field = box.closest("[data-slot=field]");
          return [
            field?.querySelector("label")?.textContent,
            field?.querySelector("[data-slot=badge]")?.textContent,
            box.getAttribute("aria-checked"),
          ];
        }),
    ).toEqual([
      ["Read", "worker 안", "false"],
      ["Edit", "worker 안", "false"],
      ["Write", "worker 안", "false"],
      ["Bash", "worker 안", "false"],
      ["WebFetch", "외부 접속", "false"],
      ["WebSearch", "provider 쪽", "true"],
    ]);
    // The boundary is part of what a screen reader hears for the box.
    const search = screen.getByRole("checkbox", { name: "WebSearch" });
    const described = (search.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent);
    expect(described).toContain("provider 쪽");
    expect(
      within(tools).getByText(
        "체크한 도구는 이 프로필의 세션에서 돌지 않습니다. 내장 도구 이름과 mcp__서버__도구 이름을 차단할 수 있습니다.",
      ),
    ).toBeDefined();
    expect(
      within(tools).getByText(
        `아무것도 체크하지 않으면 제한 없음입니다. 다만 플랫폼이 지원하는 내장 도구 카탈로그(${CATALOG_ID}) 안에서입니다.`,
      ),
    ).toBeDefined();
    const user = await setupUser();
    search.focus();
    await user.keyboard(" ");
    expect(search.getAttribute("aria-checked")).toBe("false");
    await user.keyboard(" ");
    expect(search.getAttribute("aria-checked")).toBe("true");
  });

  test("a runtime version no catalog lists cannot be saved as a block list, and says which can", async () => {
    const { api } = renderAt("/profiles/new", catalog().routes);
    const user = await setupUser();
    await user.type(await screen.findByLabelText("이름"), "wide");
    await user.type(screen.getByLabelText("모델"), "claude-sonnet-5");
    await user.clear(screen.getByLabelText("런타임 버전"));
    await user.type(screen.getByLabelText("런타임 버전"), "0.3.999");
    expect(
      screen.getByText(
        "런타임 버전 0.3.999에는 지원 카탈로그가 없어 차단목록을 저장할 수 없습니다. 지원하는 버전: 0.3.270, 2.1.270",
      ),
    ).toBeDefined();
    expect(
      screen.queryAllByRole("group", { name: "차단할 내장 도구" }),
    ).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect(posted(api)).toEqual([]);
  });

  test("a next version on a newer catalog shows what it added and dropped; an added tool opens only once accepted", async () => {
    const previous = ceiling("wide", 1, {
      runtime_version: "0.3.260",
      tools: ["Read", "Edit", "Bash"],
      deny: ["Write", "Glob", "WebFetch"],
    });
    const { api } = renderAt(
      "/profiles/new?from=op_wide_v1&mode=version",
      catalog([CODING, previous], me(), TWO_CATALOGS).routes,
    );
    // On the version it follows, nothing differs.
    await screen.findByRole("group", { name: "차단할 내장 도구" });
    expect(blockedBoxes()).toEqual(["Write", "Glob", "WebFetch"]);
    expect(screen.queryAllByRole("group", { name: "카탈로그 차이" })).toEqual(
      [],
    );
    const user = await setupUser();
    await user.clear(screen.getByLabelText("런타임 버전"));
    await user.type(screen.getByLabelText("런타임 버전"), "0.3.270");
    // The new catalog's WebSearch starts blocked; what v1 blocked stays so.
    expect(blockedBoxes()).toEqual(["Write", "WebFetch", "WebSearch"]);
    const diff = screen.getByRole("group", { name: "카탈로그 차이" });
    expect(diff.textContent).toContain("지원이 끝난 도구:Glob");
    expect(
      within(screen.getByRole("group", { name: "차단할 내장 도구" }))
        .getByRole("checkbox", { name: "WebSearch" })
        .closest("[data-slot=field]")?.textContent,
    ).toContain("새 도구");
    const accept = within(diff).getByRole("checkbox", {
      name: "WebSearch 실행을 받아들이기",
    });
    expect(accept.getAttribute("aria-checked")).toBe("false");

    // Opened without accepting: caught before the request.
    await user.click(screen.getByRole("checkbox", { name: "WebSearch" }));
    await user.click(screen.getByRole("button", { name: "저장" }));
    const unaccepted = await screen.findByText(
      "이전 버전에 없던 도구 WebSearch를 열려면 받아들이기를 체크하거나 다시 차단하세요.",
    );
    expect(accept.getAttribute("aria-invalid")).toBe("true");
    expect(
      screen
        .getByRole("checkbox", { name: "WebSearch" })
        .getAttribute("aria-describedby")
        ?.split(" "),
    ).toContain(unaccepted.id);
    expect(posted(api)).toEqual([]);

    await user.click(accept);
    await user.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(posted(api)).toHaveLength(1));
    expect(posted(api)[0]).toMatchObject({
      runtime_version: "0.3.270",
      deny: ["Write", "WebFetch"],
      accept_added_tools: ["WebSearch"],
      previous_id: "op_wide_v1",
    });
  });

  test("a copy onto a newer catalog keeps what it copies blocked and blocks what it never had", async () => {
    const source = ceiling("wide", 1, {
      runtime_version: "0.3.260",
      tools: ["Read", "Edit", "Bash"],
      deny: ["Write", "Glob", "WebFetch"],
    });
    renderAt(
      "/profiles/new?from=op_wide_v1",
      catalog([CODING, source], me(), TWO_CATALOGS).routes,
    );
    await screen.findByRole("group", { name: "차단할 내장 도구" });
    const user = await setupUser();
    await user.clear(screen.getByLabelText("런타임 버전"));
    await user.type(screen.getByLabelText("런타임 버전"), "0.3.270");
    // A copy names no previous version, so nothing here is asked again.
    expect(blockedBoxes()).toEqual(["Write", "WebFetch", "WebSearch"]);
  });

  test("when the server names tools the previous version never weighed, the form asks for them and saves again", async () => {
    // An allow-list row reads like a block list: only the server knows.
    let refused = false;
    const server = catalog([CODING, ceiling("wide", 1)]);
    const { api } = renderAt("/profiles/new?from=op_wide_v1&mode=version", {
      ...server.routes,
      "POST /v1/installation-profiles": async (request: Request) => {
        if (!refused) {
          refused = true;
          return refusal(400, "BAD_REQUEST", {
            reason_code: "added_tool_not_accepted",
            field: "accept_added_tools",
          });
        }
        return server.routes["POST /v1/installation-profiles"](request);
      },
    });
    await screen.findByRole("group", { name: "차단할 내장 도구" });
    expect(screen.queryAllByRole("group", { name: "카탈로그 차이" })).toEqual(
      [],
    );
    const user = await setupUser();
    await user.click(screen.getByRole("checkbox", { name: "Write" }));
    await user.click(screen.getByRole("button", { name: "저장" }));
    const asked = await screen.findByText(
      "이전 버전에 없던 도구 Write를 열려면 받아들이기를 체크하거나 다시 차단하세요.",
    );
    expect(
      screen.getByRole("group", { name: "차단할 내장 도구" }).contains(asked),
    ).toBe(true);
    const diff = screen.getByRole("group", { name: "카탈로그 차이" });
    // Only what this save opens that v1 did not run.
    expect(
      within(diff)
        .getAllByRole("checkbox")
        .map(
          (box) =>
            box.closest("[data-slot=field]")?.querySelector("label")
              ?.textContent,
        ),
    ).toEqual(["Write 실행을 받아들이기"]);
    await user.click(
      within(diff).getByRole("checkbox", { name: "Write 실행을 받아들이기" }),
    );
    await user.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(posted(api)).toHaveLength(2));
    expect(posted(api)[0]).toMatchObject({ deny: ["WebFetch", "WebSearch"] });
    expect(posted(api)[0]).not.toHaveProperty("accept_added_tools");
    expect(posted(api)[1]).toMatchObject({
      deny: ["WebFetch", "WebSearch"],
      accept_added_tools: ["Write"],
    });
  });

  const TOOL_REFUSALS: readonly [string, string][] = [
    [
      "mcp_tool",
      "MCP 도구 이름은 차단할 도구에만 쓸 수 있습니다. 허용 목록에는 내장 도구만 넣으세요.",
    ],
    [
      "mcp_tool_name",
      "mcp__서버__도구 형식이 아닌 이름이 있습니다. 128자 이하, 공백과 제어 문자가 없어야 합니다.",
    ],
    [
      "github_server",
      "내장 GitHub 서버의 도구는 에이전트의 GitHub 설정이 정합니다. 프로필에서 막을 수 없습니다.",
    ],
    [
      "unknown_mcp_server",
      "이 설치의 MCP 서버 목록에 없는 서버의 도구입니다. 서버 이름을 확인하세요.",
    ],
    [
      "base_mcp_deny_dropped",
      "바탕 프로필이 막은 MCP 도구는 풀 수 없습니다. 목록을 다시 불러오세요.",
    ],
    [
      "mcp_unblock_unknown",
      "이전 버전이 막지 않은 MCP 도구를 풀려고 했습니다. 목록을 다시 불러오세요.",
    ],
    [
      "mcp_unblock_conflict",
      "같은 MCP 도구를 막으면서 풀 수는 없습니다. 하나만 고르세요.",
    ],
    [
      "mcp_unblock_no_previous",
      "첫 버전에는 풀 이전 차단이 없습니다. 목록을 다시 불러오세요.",
    ],
    ["tool_pattern", "패턴은 받지 않습니다. 내장 도구 이름 하나를 고르세요."],
    [
      "unknown_tool",
      "이 런타임 버전의 지원 카탈로그에 없는 도구가 있습니다. 목록을 다시 불러오세요.",
    ],
    [
      "no_tool_catalog",
      "이 런타임 버전에는 지원 카탈로그가 없어 차단목록을 저장할 수 없습니다.",
    ],
  ];

  for (const [reason, text] of TOOL_REFUSALS) {
    test(`a ${reason} refusal says so beside the checklist`, async () => {
      renderAt("/profiles/new?from=coding-claude", {
        ...catalog().routes,
        "POST /v1/installation-profiles": () =>
          refusal(400, "BAD_REQUEST", { reason_code: reason, field: "deny" }),
      });
      const user = await setupUser();
      await user.type(await screen.findByLabelText("이름"), "wide");
      await user.click(screen.getByRole("button", { name: "저장" }));
      const message = await screen.findByText(text);
      expect(
        screen
          .getByRole("group", { name: "차단할 내장 도구" })
          .contains(message),
      ).toBe(true);
    });
  }

  test("a base_denies refusal on an admin version says the base's blocks stay", async () => {
    renderAt("/profiles/new", {
      ...catalog(undefined, me(undefined, "admin")).routes,
      "POST /v1/installation-profiles": () =>
        refusal(400, "BAD_REQUEST", {
          reason_code: "base_denies",
          field: "deny",
        }),
    });
    const user = await setupUser();
    await user.type(await screen.findByLabelText("이름"), "strict");
    await user.click(screen.getByRole("button", { name: "저장" }));
    const message = await screen.findByText(
      "바탕 프로필이 막은 도구는 풀 수 없습니다. 목록을 다시 불러오세요.",
    );
    expect(
      screen.getByRole("group", { name: "차단할 내장 도구" }).contains(message),
    ).toBe(true);
  });

  test("an admin version from an older one is asked about against the latest, which the server checks", async () => {
    let refused = false;
    const server = catalog(
      [
        CODING,
        version(1, "usable", { tools: ["Read", "Edit"] }),
        version(2, "usable", { tools: ["Read"] }),
      ],
      me(undefined, "admin"),
    );
    const { api } = renderAt(
      "/profiles/new?from=op_wl_strict_v1&mode=version",
      {
        ...server.routes,
        "POST /v1/installation-profiles": async (request: Request) => {
          if (!refused) {
            refused = true;
            return refusal(400, "BAD_REQUEST", {
              reason_code: "added_tool_not_accepted",
              field: "accept_added_tools",
            });
          }
          return server.routes["POST /v1/installation-profiles"](request);
        },
      },
    );
    await screen.findByRole("group", { name: "차단할 내장 도구" });
    // It starts from v1, which ran Edit.
    expect(blockedBoxes()).toEqual(["Bash", "Write", "WebFetch", "WebSearch"]);
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "새 버전으로 저장" }));
    const diff = await screen.findByRole("group", { name: "카탈로그 차이" });
    // v2, the latest, never ran Edit.
    await user.click(
      within(diff).getByRole("checkbox", { name: "Edit 실행을 받아들이기" }),
    );
    await user.click(screen.getByRole("button", { name: "새 버전으로 저장" }));
    await waitFor(() => expect(posted(api)).toHaveLength(2));
    expect(posted(api)[1]).toMatchObject({
      deny: ["Bash", "Write", "WebFetch", "WebSearch"],
      accept_added_tools: ["Edit"],
    });
  });

  test("a latest version saved after the form opened is read again when the server refuses against it", async () => {
    let refused = false;
    const server = catalog(
      [CODING, version(1, "usable", { tools: ["Read", "Edit"] })],
      me(undefined, "admin"),
    );
    const { api } = renderAt(
      "/profiles/new?from=op_wl_strict_v1&mode=version",
      {
        ...server.routes,
        "POST /v1/installation-profiles": async (request: Request) => {
          if (!refused) {
            refused = true;
            // Someone else's v2, which never ran Edit, lands first.
            server.items.push(version(2, "usable", { tools: ["Read"] }));
            return refusal(400, "BAD_REQUEST", {
              reason_code: "added_tool_not_accepted",
              field: "accept_added_tools",
            });
          }
          return server.routes["POST /v1/installation-profiles"](request);
        },
      },
    );
    await screen.findByRole("group", { name: "차단할 내장 도구" });
    expect(screen.queryAllByRole("group", { name: "카탈로그 차이" })).toEqual(
      [],
    );
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "새 버전으로 저장" }));
    const diff = await screen.findByRole("group", { name: "카탈로그 차이" });
    await user.click(
      within(diff).getByRole("checkbox", { name: "Edit 실행을 받아들이기" }),
    );
    await user.click(screen.getByRole("button", { name: "새 버전으로 저장" }));
    await waitFor(() => expect(posted(api)).toHaveLength(2));
    expect(posted(api)[1]).toMatchObject({ accept_added_tools: ["Edit"] });
  });

  test("when the list cannot be read again after that refusal, the form and its message stay", async () => {
    let refused = false;
    const server = catalog(
      [CODING, version(1, "usable", { tools: ["Read", "Edit"] })],
      me(undefined, "admin"),
    );
    renderAt("/profiles/new?from=op_wl_strict_v1&mode=version", {
      ...server.routes,
      "GET /v1/profiles": () =>
        refused
          ? refusal(500, "INTERNAL", {})
          : server.routes["GET /v1/profiles"](),
      "POST /v1/installation-profiles": () => {
        refused = true;
        return refusal(400, "BAD_REQUEST", {
          reason_code: "added_tool_not_accepted",
          field: "accept_added_tools",
        });
      },
    });
    await screen.findByRole("group", { name: "차단할 내장 도구" });
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "새 버전으로 저장" }));
    await screen.findByText(
      "이전 버전이 다루지 않은 도구를 열려고 합니다. 아래 카탈로그 차이에서 받아들이거나 다시 차단하세요.",
    );
    expect(screen.getByLabelText("이름")).toBeTruthy();
  });

  test("a new admin profile under a name already taken starts with what its latest version never ran blocked", async () => {
    const { api } = renderAt(
      "/profiles/new",
      // An allow-list v1: it weighed nothing outside what it ran.
      catalog(
        [CODING, version(1, "usable", { tools: ["Read", "Edit"], deny: null })],
        me(undefined, "admin"),
      ).routes,
    );
    await screen.findByRole("group", { name: "차단할 내장 도구" });
    const user = await setupUser();
    await user.type(screen.getByLabelText("이름"), "strict");
    // v1, the latest, ran Read and Edit; the base also runs Bash.
    expect(blockedBoxes()).toContain("Bash");
    const diff = screen.getByRole("group", { name: "카탈로그 차이" });
    expect(
      within(diff).getByRole("checkbox", { name: "Bash 실행을 받아들이기" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(posted(api)).toHaveLength(1));
    expect(posted(api)[0]).toMatchObject({
      deny: expect.arrayContaining(["Bash"]),
    });
  });

  test("a refusal beside the checklist marks its open boxes invalid", async () => {
    renderAt("/profiles/new", {
      ...catalog(undefined, me(undefined, "admin")).routes,
      "POST /v1/installation-profiles": () =>
        refusal(400, "BAD_REQUEST", {
          reason_code: "unknown_tool",
          field: "deny",
        }),
    });
    const user = await setupUser();
    await user.type(await screen.findByLabelText("이름"), "strict");
    const tools = screen.getByRole("group", { name: "차단할 내장 도구" });
    const read = within(tools).getByRole("checkbox", { name: "Read" });
    expect(read.getAttribute("aria-invalid") === null).toBe(true);
    await user.click(screen.getByRole("button", { name: "저장" }));
    await screen.findByText(
      "이 런타임 버전의 지원 카탈로그에 없는 도구가 있습니다. 목록을 다시 불러오세요.",
    );
    expect(read.getAttribute("aria-invalid")).toBe("true");
    // A base's block cannot change, so it is not what the person fixes.
    const locked = within(tools)
      .getAllByRole("checkbox")
      .filter((box) => (box as HTMLButtonElement).disabled);
    expect(locked.length > 0).toBe(true);
    for (const box of locked)
      expect(box.getAttribute("aria-invalid") === null).toBe(true);
  });
});

describe("차단할 MCP 도구", () => {
  const group = () => screen.getByRole("group", { name: "차단할 MCP 도구" });
  const rows = () =>
    within(group())
      .queryAllByRole("checkbox")
      .map((box) => [
        box.closest("[data-slot=field]")?.querySelector("label")?.textContent,
        box.getAttribute("aria-checked"),
        (box as HTMLButtonElement).disabled ? "locked" : "open",
      ]);
  const BASE_DENY = ["mcp__docs__delete"];

  test("a next version of a workspace profile shows the base's block locked and the earlier one liftable, and sends the lift apart from deny", async () => {
    const base = imported("coding-claude", { mcp_deny: BASE_DENY });
    const strict = version(1, "usable", {
      tools: ["Read", "Edit"],
      mcp_deny: [...BASE_DENY, "mcp__wiki__write"],
    });
    const { api } = renderAt(
      "/profiles/new?from=op_wl_strict_v1&mode=version",
      catalog([base, strict], me(undefined, "admin")).routes,
    );
    await screen.findByRole("heading", { level: 1, name: "strict 새 버전" });
    expect(rows()).toEqual([
      ["mcp__docs__delete", "true", "locked"],
      ["mcp__wiki__write", "true", "open"],
    ]);
    expect(group().textContent).toContain("이어받은 차단입니다.");
    const user = await setupUser();
    await user.type(
      within(group()).getByRole("textbox", { name: "MCP 도구 이름" }),
      "mcp__docs__read",
    );
    await user.click(
      within(group()).getByRole("button", { name: "차단 추가" }),
    );
    await user.click(
      within(group()).getByRole("checkbox", { name: "mcp__wiki__write" }),
    );
    await user.click(screen.getByRole("button", { name: "새 버전으로 저장" }));
    await waitFor(() => expect(posted(api)).toHaveLength(1));
    const sent = posted(api)[0] as {
      deny: string[];
      unblock_mcp_tools?: string[];
      previous_id: string;
    };
    expect(sent.previous_id).toBe("op_wl_strict_v1");
    // The base's block and the new one are named; the lifted one is not.
    expect(sent.deny.filter((name) => name.startsWith("mcp__"))).toEqual([
      "mcp__docs__delete",
      "mcp__docs__read",
    ]);
    expect(sent.unblock_mcp_tools).toEqual(["mcp__wiki__write"]);
  });

  test("a name that is not a whole mcp__server__tool name, or is already blocked, is refused beside the field and sends nothing", async () => {
    const base = imported("coding-claude", { mcp_deny: BASE_DENY });
    const { api } = renderAt(
      "/profiles/new?from=coding-claude",
      catalog([base], me(undefined, "admin")).routes,
    );
    await screen.findByRole("group", { name: "차단할 MCP 도구" });
    const user = await setupUser();
    const input = () =>
      within(group()).getByRole("textbox", { name: "MCP 도구 이름" });
    for (const [typed, text] of [
      ["docs", "mcp__서버__도구 형식이 아닙니다."],
      ["mcp__docs", "mcp__서버__도구 형식이 아닙니다."],
      ["mcp__docs__delete", "이미 차단한 이름입니다."],
    ] as const) {
      await user.clear(input());
      await user.type(input(), typed);
      await user.click(
        within(group()).getByRole("button", { name: "차단 추가" }),
      );
      expect(within(group()).getByText(new RegExp(text))).toBeDefined();
    }
    expect(rows()).toEqual([["mcp__docs__delete", "true", "locked"]]);
    expect(posted(api)).toEqual([]);
  });

  test("Enter in the name field adds the block and does not submit the page's form", async () => {
    const { api } = renderAt(
      "/profiles/new?from=coding-claude",
      catalog(undefined, me(undefined, "admin")).routes,
    );
    await screen.findByRole("group", { name: "차단할 MCP 도구" });
    const user = await setupUser();
    await user.type(
      within(group()).getByRole("textbox", { name: "MCP 도구 이름" }),
      "mcp__docs__read{Enter}",
    );
    expect(rows()).toEqual([["mcp__docs__read", "true", "open"]]);
    expect(posted(api)).toEqual([]);
  });

  test("a ceiling's next version sends a lift, a copy of it only leaves the name out", async () => {
    const earlier = ceiling("wide", 1, {
      tools: ["Read", "Edit", "Bash"],
      deny: ["Write", "Glob", "WebFetch"],
      mcp_deny: ["mcp__docs__delete"],
    });
    const next = renderAt(
      "/profiles/new?from=op_wide_v1&mode=version",
      catalog([CODING, earlier], me()).routes,
    );
    await screen.findByRole("group", { name: "차단할 MCP 도구" });
    expect(rows()).toEqual([["mcp__docs__delete", "true", "open"]]);
    const user = await setupUser();
    await user.click(
      within(group()).getByRole("checkbox", { name: "mcp__docs__delete" }),
    );
    await user.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(posted(next.api)).toHaveLength(1));
    expect(posted(next.api)[0]).toMatchObject({
      previous_id: "op_wide_v1",
      unblock_mcp_tools: ["mcp__docs__delete"],
    });
    expect((posted(next.api)[0] as { deny: string[] }).deny).not.toContain(
      "mcp__docs__delete",
    );
  });

  test("a copy has no earlier block to lift, so clearing a name only leaves it out", async () => {
    const earlier = ceiling("wide", 1, {
      tools: ["Read", "Edit", "Bash"],
      deny: ["Write", "Glob", "WebFetch"],
      mcp_deny: ["mcp__docs__delete"],
    });
    const { api } = renderAt(
      "/profiles/new?from=op_wide_v1",
      catalog([CODING, earlier], me()).routes,
    );
    await screen.findByRole("group", { name: "차단할 MCP 도구" });
    expect(rows()).toEqual([["mcp__docs__delete", "true", "open"]]);
    const user = await setupUser();
    await user.type(screen.getByLabelText("이름"), "wide-copy");
    await user.click(
      within(group()).getByRole("checkbox", { name: "mcp__docs__delete" }),
    );
    await user.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(posted(api)).toHaveLength(1));
    const sent = posted(api)[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty("unblock_mcp_tools");
    expect(sent).not.toHaveProperty("previous_id");
    expect(sent.deny).not.toContain("mcp__docs__delete");
  });

  test("an mcp__ name never shows up in the built-in checklist", async () => {
    const base = imported("coding-claude", { mcp_deny: BASE_DENY });
    renderAt(
      "/profiles/new?from=coding-claude",
      catalog([base], me(undefined, "admin")).routes,
    );
    const builtIn = await screen.findByRole("group", {
      name: "차단할 내장 도구",
    });
    // The guidance names the form; no box is an mcp__ name.
    expect(
      within(builtIn)
        .getAllByRole("checkbox")
        .map(
          (box) =>
            box.closest("[data-slot=field]")?.querySelector("label")
              ?.textContent,
        )
        .filter((label) => label?.startsWith("mcp__")),
    ).toEqual([]);
  });
});
