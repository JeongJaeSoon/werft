import { describe, expect, test } from "bun:test";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { AGENT_ID, agentServer, CARD } from "../../test-support/fake-agents.ts";
import { apiError, json, keys, me } from "../../test-support/fake-api.ts";
import { appHarness } from "../../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const meOk = { "GET /v1/auth/me": () => json(200, me()) };
const DETAIL = `/agents/${AGENT_ID}?tab=release`;
const PROFILE = "claude-coding-local";
const BINDINGS = `/v1/agents/${AGENT_ID}/credential-bindings`;

/** A server whose only version names these credentials. */
function serverNaming(...refs: string[]) {
  const server = agentServer();
  const first = server.versions[0];
  if (!first) throw new Error("agentServer starts with a version");
  server.versions[0] = {
    ...first,
    card: {
      ...CARD,
      capabilities: { ...CARD.capabilities, credential_refs: refs },
    },
  };
  return server;
}

const step = async () =>
  (await screen.findByRole("heading", { name: "자격 증명 연결" })).closest(
    "section",
  ) as HTMLElement;

const posted = (api: { calls: { method: string; path: string }[] }) =>
  api.calls.filter((c) => c.method === "POST" && c.path === BINDINGS);

describe("자격 연결 단계", () => {
  test("카드가 쓰는 이름을 연결하고 해제한다", async () => {
    const server = serverNaming("github/app");
    const { api, services } = renderAt(DETAIL, { ...meOk, ...server.routes });
    // The list's summaries say what is bound, so a change marks them stale;
    // the overview watches this agent's summary, so it may be read again at once.
    const summary = keys.agentSummaries([AGENT_ID]);
    const listReads = () =>
      api.calls.filter((c) => c.method === "GET" && c.path === "/v1/agents")
        .length;
    const listed = async () => {
      await waitFor(() =>
        expect(services.queryClient.getQueryState(summary)?.fetchStatus).toBe(
          "idle",
        ),
      );
      const reads = listReads();
      return () =>
        services.queryClient.getQueryState(summary)?.isInvalidated === true ||
        listReads() > reads;
    };
    const user = await setupUser();
    const section = await step();
    let list = await listed();

    const unbound = await within(section).findByRole("list", {
      name: "연결되지 않은 자격",
    });
    expect(unbound.textContent).toContain("github/app");
    expect(
      within(section).getByText("아직 연결된 자격이 없습니다."),
    ).toBeDefined();
    await user.click(
      within(section).getByRole("button", { name: "github/app 연결" }),
    );
    expect(
      await within(section).findByText("github/app을(를) 연결했습니다."),
    ).toBeDefined();
    expect(posted(api).map((c) => (c as { body?: unknown }).body)).toEqual([
      { credential_ref: "github/app" },
    ]);
    await waitFor(() => expect(list()).toBe(true));
    list = await listed();
    const bound = await within(section).findByRole("list", {
      name: "연결된 자격",
    });
    expect(bound.textContent).toContain("github/app");
    expect(bound.textContent).toContain("실행 중인 세션 0개");
    expect(
      within(section).queryByRole("list", { name: "연결되지 않은 자격" }),
    ).toBeNull();

    await user.click(
      within(section).getByRole("button", { name: "github/app 연결 해제" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("실행 중인 세션도 다음 메시지부터");
    await user.click(within(dialog).getByRole("button", { name: "연결 해제" }));
    const revoked = await within(section).findByText(
      "github/app의 연결을 해제했습니다.",
    );
    // The button that opened the dialog is gone; the keyboard lands on the result.
    await waitFor(() =>
      expect(document.activeElement?.contains(revoked)).toBe(true),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(list()).toBe(true));
    expect(
      api.calls.some(
        (c) =>
          c.method === "DELETE" &&
          c.path === `${BINDINGS}/${server.bindings[0]?.id}`,
      ),
    ).toBe(true);
    await waitFor(() =>
      expect(
        within(section).getByRole("list", { name: "연결되지 않은 자격" })
          .textContent,
      ).toContain("github/app"),
    );
  });

  test("카드가 자격을 쓰지 않으면 연결할 것이 없다고 하고, 자격을 적는 칸은 어디에도 없다", async () => {
    const server = agentServer();
    renderAt(DETAIL, { ...meOk, ...server.routes });
    const section = await step();
    expect(
      await within(section).findByText(
        "카드가 쓰는 자격이 없어 연결할 것이 없습니다.",
      ),
    ).toBeDefined();
    // A free-text field would let a pasted value through as a "name".
    expect(within(section).queryByRole("textbox")).toBeNull();
    expect(within(section).queryByRole("button")).toBeNull();
  });

  test("목록이 거절되면 권한 사유를 보인다", async () => {
    const server = agentServer();
    renderAt(DETAIL, {
      ...meOk,
      ...server.routes,
      [`GET ${BINDINGS}`]: () =>
        apiError(403, "FORBIDDEN", "This principal does not hold it"),
    });
    const section = await step();
    // A reason to read, not a failure to retry.
    const reason = await within(section).findByText(/에이전트 관리/);
    expect(reason.closest('[role="alert"]')).toBeNull();
    expect(within(section).queryByRole("button")).toBeNull();
  });

  test("query·mutation 캐시에는 계약의 이름 필드만 있고 console에는 자격이 나오지 않는다", async () => {
    const logged: unknown[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const originals = methods.map((name) => console[name]);
    for (const name of methods) {
      console[name] = (...args: unknown[]) => {
        logged.push(...args);
      };
    }
    try {
      const server = serverNaming("github/app");
      const { services } = renderAt(DETAIL, { ...meOk, ...server.routes });
      const user = await setupUser();
      const section = await step();
      await user.click(
        await within(section).findByRole("button", { name: "github/app 연결" }),
      );
      await user.click(
        await within(section).findByRole("button", {
          name: "github/app 연결 해제",
        }),
      );
      await user.click(
        within(await screen.findByRole("dialog")).getByRole("button", {
          name: "연결 해제",
        }),
      );
      await within(section).findByText("github/app의 연결을 해제했습니다.");

      const listed = services.queryClient.getQueryData<{
        items: Record<string, unknown>[];
      }>([...keys.agent(AGENT_ID), "credential-bindings"]);
      expect(listed?.items).toEqual([]);
      const variables = services.queryClient
        .getMutationCache()
        .getAll()
        .map((m) => m.state.variables)
        .filter((v) => v !== undefined);
      // The bind sends a name from the card; the unbind, the listed binding.
      expect(variables[0]).toBe("github/app");
      expect(Object.keys(variables[1] as object).sort()).toEqual([
        "agent_id",
        "bound_at",
        "bound_by",
        "credential_ref",
        "id",
        "revoked_at",
        "running_sessions",
      ]);
      expect(
        logged.some((arg) => /github\/app|credential/i.test(String(arg))),
      ).toBe(false);
    } finally {
      methods.forEach((name, index) => {
        console[name] = originals[index] as (typeof console)[typeof name];
      });
    }
  });
});

async function releasedTwice(server: ReturnType<typeof agentServer>) {
  const save = (card: unknown) =>
    server.routes[`PATCH /v1/agents/${AGENT_ID}`](
      new Request("http://test", {
        method: "PATCH",
        body: JSON.stringify({ card, runtime_profile_id: PROFILE }),
      }),
    );
  const first = server.versions[0];
  if (!first) throw new Error("agentServer starts with a version");
  await save(first.card);
  await save({ ...first.card, instructions: "환불도 맡는다." });
}

const FIRST = `릴리스 2026-10-11_10:00:00 · ${PROFILE}(으)로 되돌리기`;

async function rollBackToFirst(user: Awaited<ReturnType<typeof setupUser>>) {
  await user.click(await screen.findByRole("button", { name: FIRST }));
  await user.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: "되돌리기",
    }),
  );
}

describe("CREDENTIAL_UNBOUND 안내", () => {
  test("되돌리기가 거절되면 빠진 이름과 자격 연결로 가는 행동을 보이고, 연결 뒤 다시 되돌려진다", async () => {
    const server = serverNaming("github/app", "slack:bot");
    await releasedTwice(server);
    const { api } = renderAt(DETAIL, { ...meOk, ...server.routes });
    const user = await setupUser();
    await rollBackToFirst(user);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "연결되지 않은 자격이 있어 활성화하지 못했습니다",
    );
    expect(alert.textContent).toContain("github/app, slack:bot");
    // Shown in the releases section, where the button was pressed.
    const releases = screen
      .getByRole("heading", { name: "릴리스", level: 2 })
      .closest("section") as HTMLElement;
    expect(releases.contains(alert)).toBe(true);
    expect(document.activeElement?.contains(alert)).toBe(true);

    await user.click(
      within(alert).getByRole("button", { name: "자격 증명 연결로 가기" }),
    );
    const heading = screen.getByRole("heading", { name: "자격 증명 연결" });
    expect(heading.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement === heading).toBe(true);
    const section = await step();
    expect(
      within(section).getAllByText("활성화에 필요 · 연결 안 됨").length,
    ).toBe(2);

    await user.click(
      within(section).getByRole("button", { name: "github/app 연결" }),
    );
    await within(section).findByText("github/app을(를) 연결했습니다.");
    await user.click(
      within(section).getByRole("button", { name: "slack:bot 연결" }),
    );
    await within(section).findByText("slack:bot을(를) 연결했습니다.");

    await rollBackToFirst(user);
    expect(await screen.findByText(/되돌렸습니다/)).toBeDefined();
    expect(
      screen.queryByText("연결되지 않은 자격이 있어 활성화하지 못했습니다"),
    ).toBeNull();
    expect(api.calls.filter((c) => c.path.endsWith("/activate")).length).toBe(
      2,
    );
  });

  test("응답의 missing에 카드가 쓰지 않는 문자열이 섞여도 화면과 연결에 내보내지 않는다", async () => {
    const server = serverNaming("github/app");
    await releasedTwice(server);
    const stray = "NOT A NAME 0123456789abcdef";
    const { services } = renderAt(DETAIL, {
      ...meOk,
      ...server.routes,
      [`POST /v1/agents/${AGENT_ID}/activate`]: () =>
        json(409, {
          error: {
            code: "CREDENTIAL_UNBOUND",
            message: "unbound",
            retryable: false,
            request_id: "req-1",
            details: {
              reason_code: "credential_unbound",
              missing: [stray, "github/app"],
            },
          },
        }),
    });
    const user = await setupUser();
    await rollBackToFirst(user);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "이 릴리스가 쓰는 자격 증명 github/app이(가)",
    );
    const section = await step();
    await user.click(
      within(section).getByRole("button", { name: "github/app 연결" }),
    );
    await within(section).findByText("github/app을(를) 연결했습니다.");
    expect(document.body.textContent).not.toContain(stray);
    const variables = services.queryClient
      .getMutationCache()
      .getAll()
      .map((m) => m.state.variables);
    expect(JSON.stringify(variables)).not.toContain(stray);
  });

  test("details가 계약 모양이 아니어도 이름 없이 안내한다", async () => {
    const server = agentServer();
    await releasedTwice(server);
    renderAt(DETAIL, {
      ...meOk,
      ...server.routes,
      [`POST /v1/agents/${AGENT_ID}/activate`]: () =>
        apiError(409, "CREDENTIAL_UNBOUND", "unbound"),
    });
    const user = await setupUser();
    await rollBackToFirst(user);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "이 릴리스가 쓰는 자격 증명 중 연결되지 않은 것이 있습니다",
    );
    expect(
      within(alert).getByRole("button", { name: "자격 증명 연결로 가기" }),
    ).toBeDefined();
  });
});

describe("켜기까지", () => {
  test("자격 연결을 읽지 못하면 그 단계는 확인할 수 없다고 하고, 릴리스 단계가 릴리스 탭으로 잇는다", async () => {
    const server = serverNaming("github/app");
    renderAt(`/agents/${AGENT_ID}`, {
      ...meOk,
      ...server.routes,
      [`GET ${BINDINGS}`]: () =>
        apiError(403, "FORBIDDEN", "This principal does not hold it"),
    });
    const section = (
      await screen.findByRole("heading", { name: "켜기까지" })
    ).closest("section") as HTMLElement;
    const steps = () => within(section).getAllByRole("listitem");
    await waitFor(() =>
      expect(steps().map((item) => item.dataset.state)).toEqual([
        "unknown",
        "todo",
        "todo",
      ]),
    );
    const [credentials, release] = steps();
    expect(credentials?.textContent).toContain(
      "자격 증명 연결, 연결 상태를 불러오지 못했습니다.",
    );
    expect(
      within(release as HTMLElement).getByRole("button", {
        name: "릴리스 탭으로",
      }),
    ).toBeDefined();
    expect(within(section).getByText("할 일 있음")).toBeDefined();
  });
});
