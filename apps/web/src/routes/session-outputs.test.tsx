import { describe, expect, test } from "bun:test";
import { notifyManager, type QueryClient } from "@tanstack/react-query";
import type {
  ListPushRequestsResponse,
  ListSessionOutputsResponse,
  SessionDetail,
  SessionGitHubAttribution,
  SessionGitHubRefusal,
  SessionOutcome,
  SessionUsageResponse,
} from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { apiError, json, me } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { act, renderAt, screen, waitFor, within } = await appHarness();

/**
 * Waits for the query cache to report `action` on the list whose key holds
 * `name`, then for React to draw it. The cache tells its listeners at once
 * but the screen's on the next notify tick, so this answers on that tick,
 * queued behind the screen's: what stays on screen after this has stayed.
 */
function reported(
  services: { readonly queryClient: QueryClient },
  name: string,
  action: "fetch" | "error",
) {
  const heard = new Promise<void>((resolve) => {
    const stop = services.queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type === "updated" &&
        event.action.type === action &&
        event.query.queryKey.includes(name)
      ) {
        stop();
        notifyManager.schedule(resolve);
      }
    });
  });
  return () =>
    act(async () => {
      await heard;
    });
}

async function openOutputs() {
  await (await setupUser()).click(
    await screen.findByRole("tab", { name: /^성과물/ }),
  );
  return screen.findByRole("tabpanel", { name: /^성과물/ });
}

const SESSION_ID = "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01";
const AT = "2026-10-11T08:14:02.000Z";
const SHA = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

const detail = {
  id: SESSION_ID,
  revision: 3,
  admission_state: "active",
  status: "idle",
  runtime: null,
  repository_id: "demo",
  current_turn_id: "1",
  queued_turn_count: 0,
  model: null,
  last_event_at: AT,
  created_at: AT,
  updated_at: AT,
  execution: null,
  checkpoint_revision: 2,
  pending_request_count: 0,
  attention: null,
  durability: {
    last_transcript_persisted_at: AT,
    checkpoint_committed_at: AT,
    checkpoint_revision: 2,
    last_completed_turn_id: "1",
    last_checkpointed_turn_id: "1",
    checkpoint_pending_reason: null,
    checkpoint_fallback_revision: null,
    context_reset_turn_id: null,
  },
} as SessionDetail;

const outputs: ListSessionOutputsResponse = {
  session_id: SESSION_ID,
  checkpoint_revision: 2,
  items: [
    { path: "out/report.md", bytes: 2048, sha256: SHA, omitted: null },
    {
      path: "out/sub/보고서 (최종).csv",
      bytes: 12,
      sha256: SHA,
      omitted: null,
    },
    {
      path: "out/video.mp4",
      bytes: 734_003_200,
      sha256: null,
      omitted: "too_large",
    },
  ],
};

function routes(answer: () => Response | Promise<Response>) {
  return {
    "GET /v1/auth/me": () => json(200, me()),
    "GET /v1/connections": () => json(200, { items: [] }),
    [`GET /v1/sessions/${SESSION_ID}`]: () => json(200, detail),
    [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
      json(200, { answerable: true, items: [] }),
    [`GET /v1/sessions/${SESSION_ID}/outputs`]: answer,
    // Held open until the screen lets go, so it does not reconnect.
    [`GET /v1/sessions/${SESSION_ID}/events`]: (request: Request) =>
      new Promise<Response>((_, reject) =>
        request.signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        ),
      ),
  };
}

describe("session outputs", () => {
  test("lists each file with its size and a download link; a file too large to keep has none", async () => {
    renderAt(
      `/sessions/${SESSION_ID}`,
      routes(() => json(200, outputs)),
    );
    await openOutputs();
    const section = await screen.findByRole("region", { name: /^out\/ 파일/ });
    expect(section.textContent).toContain("report.md");
    expect(section.textContent).toContain("2kB");
    expect(section.textContent).toContain("video.mp4");
    expect(section.textContent).toContain("너무 커서 보관하지 않음");
    expect(screen.queryByText(/out\/ 폴더에 남긴 파일을 셉니다/)).toBeNull();

    const report = screen.getByRole("link", { name: "report.md 내려받기" });
    expect(report.getAttribute("href")).toBe(
      `/v1/sessions/${SESSION_ID}/outputs/out%2Freport.md`,
    );
    expect(report.getAttribute("download")).toBe("report.md");
    // The name a sighted user sees on hover or focus is the Tooltip's.
    expect(report.hasAttribute("title")).toBe(false);
    act(() => report.focus());
    await waitFor(() =>
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
        "report.md 내려받기",
      ),
    );
    const nested = screen.getByRole("link", {
      name: "sub/보고서 (최종).csv 내려받기",
    });
    expect(nested.getAttribute("href")).toBe(
      `/v1/sessions/${SESSION_ID}/outputs/${encodeURIComponent("out/sub/보고서 (최종).csv")}`,
    );
    expect(nested.getAttribute("download")).toBe("보고서 (최종).csv");
    expect(
      screen.queryByRole("link", { name: "video.mp4 내려받기" }),
    ).toBeNull();

    // A link, so the keyboard reaches it.
    report.focus();
    expect(document.activeElement === report).toBe(true);
  });

  test("shows no files section while the session has no outputs", async () => {
    const { api } = renderAt(
      `/sessions/${SESSION_ID}`,
      routes(() =>
        json(200, {
          session_id: SESSION_ID,
          checkpoint_revision: null,
          items: [],
        }),
      ),
    );
    await waitFor(() =>
      expect(
        api.calls.some(
          (call) => call.path === `/v1/sessions/${SESSION_ID}/outputs`,
        ),
      ).toBe(true),
    );
    await openOutputs();
    expect(screen.queryByRole("region", { name: /^out\/ 파일/ })).toBeNull();
  });

  test("a session that never checkpointed is not asked for outputs", async () => {
    const { api } = renderAt(`/sessions/${SESSION_ID}`, {
      ...routes(() => json(200, outputs)),
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        json(200, { ...detail, checkpoint_revision: null }),
    });
    await screen.findByRole("heading", {
      name: new RegExp(`^${SESSION_ID.slice(0, 8)}`),
    });
    expect(
      api.calls.some(
        (call) => call.path === `/v1/sessions/${SESSION_ID}/outputs`,
      ),
    ).toBe(false);
  });

  test("a list that cannot be read says so and offers to ask again", async () => {
    renderAt(
      `/sessions/${SESSION_ID}`,
      routes(() => apiError(409, "CHECKPOINT_UNAVAILABLE", "manifest damaged")),
    );
    const panel = await openOutputs();
    expect(
      await within(panel).findByRole("button", { name: "다시 시도" }),
    ).toBeTruthy();
    expect(screen.queryByText(/out\/ 폴더에 남긴 파일을 셉니다/)).toBeNull();
  });

  test("while a files list that failed is read again, the failure and its retry stay with the focus on it, and go once it answers", async () => {
    const user = await setupUser();
    let answer: (response: Response) => void = () => {};
    let reads = 0;
    const { services } = renderAt(
      `/sessions/${SESSION_ID}`,
      routes(() =>
        ++reads === 1
          ? apiError(409, "CHECKPOINT_UNAVAILABLE", "manifest damaged")
          : new Promise<Response>((resolve) => {
              answer = resolve;
            }),
      ),
    );
    const panel = await openOutputs();
    const retry = await within(panel).findByRole("button", {
      name: "다시 시도",
    });
    const reading = reported(services, "outputs", "fetch");
    await user.click(retry);
    await reading();
    expect(reads).toBe(2);
    expect(retry.isConnected).toBe(true);
    expect(document.activeElement === retry).toBe(true);
    act(() => answer(json(200, outputs)));
    expect(
      await within(panel).findByRole("region", { name: "out/ 파일 3개" }),
    ).toBeTruthy();
    expect(
      within(panel).queryByRole("button", { name: "다시 시도" }) === null,
    ).toBe(true);
  });
});

describe("session GitHub attribution", () => {
  const ATTRIBUTION = `/v1/sessions/${SESSION_ID}/github/attribution`;
  const withRepository = {
    ...detail,
    repository: { id: "demo", full_name: "acme/demo", branch: "main" },
  };
  function attributed(answer: SessionGitHubAttribution) {
    return {
      ...routes(() => json(200, outputs)),
      [`GET /v1/sessions/${SESSION_ID}`]: () => json(200, withRepository),
      [`GET ${ATTRIBUTION}`]: () => json(200, answer),
    };
  }

  test("names the linked requester as the commits' co-author", async () => {
    renderAt(
      `/sessions/${SESSION_ID}`,
      attributed({
        trigger: "web",
        attribution: "co_author",
        login: "octocat",
      }),
    );
    await openOutputs();
    expect(
      await screen.findByText("commit 공동 작성자: octocat"),
    ).toBeDefined();
  });

  test("an unlinked requester is pointed at linked accounts", async () => {
    renderAt(
      `/sessions/${SESSION_ID}`,
      attributed({ trigger: "slack", attribution: "unlinked", login: null }),
    );
    await openOutputs();
    expect(
      await screen.findByText(/GitHub 계정이 연결되지 않아/),
    ).toBeDefined();
    expect(
      screen.getByRole("link", { name: "연동 계정" }).getAttribute("href"),
    ).toBe("/settings/linked-accounts");
  });

  test("a request from no person says the App alone signs", async () => {
    renderAt(
      `/sessions/${SESSION_ID}`,
      attributed({
        trigger: "agent_key",
        attribution: "app_only",
        login: null,
      }),
    );
    await openOutputs();
    expect(
      await screen.findByText(
        "마지막 요청에 사람이 없어 commit은 App 이름으로만 남습니다.",
      ),
    ).toBeDefined();
  });

  test("a session without a repository is not asked", async () => {
    const { api } = renderAt(`/sessions/${SESSION_ID}`, {
      ...attributed({ trigger: "web", attribution: "co_author", login: "x" }),
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        json(200, { ...detail, repository: null, repository_id: null }),
    });
    await openOutputs();
    await screen.findByRole("region", { name: /^out\/ 파일/ });
    expect(api.calls.some((call) => call.path === ATTRIBUTION)).toBe(false);
    // Nor for pull requests or refusals: only a repository has them.
    expect(
      api.calls.some(
        (call) =>
          call.path === `/v1/sessions/${SESSION_ID}/outcomes` ||
          call.path === `/v1/sessions/${SESSION_ID}/github/refusals`,
      ),
    ).toBe(false);
  });
});

describe("the session's GitHub pull requests", () => {
  const withRepository = {
    ...detail,
    repository: { id: "demo", full_name: "acme/demo", branch: "main" },
  };
  type PullOutcome = Extract<SessionOutcome, { type: "github_pull_request" }>;
  const pull = (number: number, fields: Partial<PullOutcome>): PullOutcome => ({
    id: `019a0000-0000-7000-8000-00000000000${number}`,
    type: "github_pull_request",
    url: `https://github.com/acme/demo/pull/${number}`,
    repository_id: "demo",
    external_id: String(number),
    state: "open",
    state_changed_at: AT,
    merged_at: null,
    closed_at: null,
    state_checked_at: AT,
    check_error: null,
    metadata: {
      title: "Retry failed payments",
      head: `agent/${SESSION_ID}`,
      base: "main",
      adopted: false,
      merge_commit_sha: null,
      additions: null,
      deletions: null,
      changed_files: null,
      commits: null,
    },
    created_at: AT,
    ...fields,
  });
  const pulls = [
    pull(1, {}),
    pull(2, {
      state: "merged",
      merged_at: AT,
      closed_at: AT,
      metadata: {
        title: "Retry failed payments",
        head: `agent/${SESSION_ID}`,
        base: "main",
        adopted: false,
        merge_commit_sha: "d".repeat(40),
        additions: 84,
        deletions: 12,
        changed_files: 3,
        commits: 2,
      },
    }),
    pull(3, { state: "closed", closed_at: AT, check_error: "not_found" }),
  ];
  const usage: SessionUsageResponse = {
    session_id: SESSION_ID,
    period: "session_lifetime",
    refreshed_at: AT,
    cost: {
      amount_usd: "0.250000",
      kind: "estimated",
      source: "provider_usage",
      completeness_scope: "turn_reports",
      complete: true,
      reported_turn_count: 1,
      unreported_turn_count: 0,
      open_turn_count: 0,
    },
    cost_limit_usd: "25",
    token_count: 12345,
    token_limit: null,
    budget_exceeded: false,
    queued_input_count: 0,
    queued_input_limit: 10,
  };
  function pulled(
    items: SessionOutcome[],
    files: ListSessionOutputsResponse = outputs,
    refusals: SessionGitHubRefusal[] = [],
  ) {
    return {
      ...routes(() => json(200, files)),
      [`GET /v1/sessions/${SESSION_ID}`]: () => json(200, withRepository),
      [`GET /v1/sessions/${SESSION_ID}/outcomes`]: () => json(200, { items }),
      [`GET /v1/sessions/${SESSION_ID}/usage`]: () => json(200, usage),
      [`GET /v1/sessions/${SESSION_ID}/github/refusals`]: () =>
        json(200, { items: refusals }),
    };
  }
  const noFiles = { session_id: SESSION_ID, checkpoint_revision: 2, items: [] };

  test("each pull request is one row: title, number and lines, state, and a menu to open it on GitHub", async () => {
    renderAt(`/sessions/${SESSION_ID}`, pulled(pulls));
    await openOutputs();
    const area = await screen.findByRole("region", { name: "변경 사항" });
    const rows = within(area).getAllByRole("listitem");
    // The title links out; with no title kept, the name stands in.
    expect(rows.map((row) => row.querySelector("a")?.textContent)).toEqual([
      "Retry failed payments",
      "Retry failed payments",
      "Retry failed payments",
    ]);
    expect(rows[1]?.querySelector("a")?.getAttribute("href")).toBe(
      "https://github.com/acme/demo/pull/2",
    );
    expect(rows[1]?.querySelector("a")?.getAttribute("target")).toBe("_blank");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/acme\/demo#1열림$/),
      expect.stringMatching(/acme\/demo#2\+84−12머지됨$/),
      expect.stringMatching(/acme\/demo#3닫힘/),
    ]);
    // The files themselves are not listed: the API counts them only.
    expect(area.textContent).not.toContain("파일 3개");
    expect(rows[2]?.textContent).toContain(
      "마지막 확인에서 GitHub가 이 PR을 찾지 못했습니다. 상태는 그 전에 확인한 값입니다.",
    );
    // The ⋯ menu opens the pull request on GitHub.
    const user = await setupUser();
    await user.click(
      within(rows[1] as HTMLElement).getByRole("button", {
        name: "Retry failed payments 메뉴",
      }),
    );
    const open = await screen.findByRole("menuitem", {
      name: /GitHub에서 열기/,
    });
    expect(open.getAttribute("href")).toBe(
      "https://github.com/acme/demo/pull/2",
    );
    // The card folds to its title.
    await user.keyboard("{Escape}");
    await user.click(
      within(area).getByRole("button", { name: "변경 사항 접기" }),
    );
    expect(within(area).queryByRole("listitem")).toBeNull();
    // The session's tokens and cost are in the head's meta line.
    const meta = document.querySelector("[data-slot='session-meta']");
    expect(meta?.textContent).toContain("$0.25 · 토큰 12,345");
  });

  test("a session with only attached repositories still lists its pull requests", async () => {
    const { api } = renderAt(`/sessions/${SESSION_ID}`, {
      ...pulled(pulls),
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        json(200, {
          ...detail,
          repository: null,
          repository_id: null,
          attached_repository_ids: ["demo"],
          attached_repositories: [{ id: "demo", full_name: "acme/demo" }],
        }),
    });
    await openOutputs();
    const area = await screen.findByRole("region", { name: "변경 사항" });
    expect(
      within(area)
        .getAllByRole("listitem")
        .map((row) => row.querySelector("a")?.textContent),
    ).toEqual([
      "Retry failed payments",
      "Retry failed payments",
      "Retry failed payments",
    ]);
    expect(api.calls.some((call) => call.path.endsWith("/outcomes"))).toBe(
      true,
    );
  });

  test("a review the session submitted shows its pull request, its event and who opened that pull request", async () => {
    const review = (
      id: string,
      number: number,
      event: "APPROVE" | "COMMENT",
      openedBy: string | null,
    ): SessionOutcome => ({
      id,
      type: "github_review",
      url: `https://github.com/acme/shop/pull/${number}#pullrequestreview-${id.slice(-2)}`,
      repository_id: "shop",
      external_id: id.slice(-2),
      state: "submitted",
      state_changed_at: AT,
      merged_at: null,
      closed_at: null,
      state_checked_at: null,
      check_error: null,
      metadata: {
        number,
        event,
        commit_id: "e".repeat(40),
        opened_by_session_id: openedBy,
      },
      created_at: AT,
    });
    renderAt(
      `/sessions/${SESSION_ID}`,
      pulled(
        [
          review(
            "019a0000-0000-7000-8000-000000000071",
            398,
            "APPROVE",
            "33333333-3333-4333-8333-333333333333",
          ),
          review(
            "019a0000-0000-7000-8000-000000000072",
            399,
            "COMMENT",
            SESSION_ID,
          ),
        ],
        noFiles,
      ),
    );
    await openOutputs();
    const area = await screen.findByRole("region", { name: "변경 사항" });
    const rows = within(area).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/^acme\/shop#398 리뷰.*승인 · 다른 세션이 연 PR$/),
      expect.stringMatching(/^acme\/shop#399 리뷰.*코멘트$/),
    ]);
    expect(rows[1]?.textContent).not.toContain("다른 세션");
    expect(
      within(area)
        .getByRole("link", { name: "acme/shop#398 리뷰" })
        .getAttribute("href"),
    ).toBe("https://github.com/acme/shop/pull/398#pullrequestreview-71");
  });

  // GitHub merges a pull request after the session stopped and no session
  // event says so: an open screen reads both lists again each refresher minute.
  test("an open screen reads its pull requests and refusals again every minute", async () => {
    const { services } = renderAt(`/sessions/${SESSION_ID}`, pulled(pulls));
    await openOutputs();
    await screen.findByRole("region", { name: "변경 사항" });
    const intervals = (path: string) =>
      services.queryClient
        .getQueryCache()
        .findAll()
        .filter((query) => query.queryKey.at(-1) === path)
        .flatMap((query) =>
          query.observers.map((observer) => observer.options.refetchInterval),
        );
    expect(intervals("outcomes")).not.toHaveLength(0);
    expect(new Set(intervals("outcomes"))).toEqual(new Set([60_000]));
    expect(intervals("github-refusals")).not.toHaveLength(0);
    expect(new Set(intervals("github-refusals"))).toEqual(new Set([60_000]));
  });

  test("pull requests without files show no files section", async () => {
    renderAt(
      `/sessions/${SESSION_ID}`,
      pulled([pulls[0] as SessionOutcome], noFiles),
    );
    await openOutputs();
    expect(
      await screen.findByRole("region", { name: "변경 사항" }),
    ).toBeTruthy();
    expect(
      screen.queryAllByRole("region", { name: /^out\/ 파일/ }),
    ).toHaveLength(0);
  });

  test("with no pull requests the changes section says so", async () => {
    renderAt(`/sessions/${SESSION_ID}`, pulled([], noFiles));
    await openOutputs();
    const area = await screen.findByRole("region", { name: "변경 사항" });
    expect(
      await within(area).findByText("아직 변경한 PR이 없습니다."),
    ).toBeTruthy();
  });

  test("pull requests that cannot be read are not taken for none", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...pulled([], noFiles),
      [`GET /v1/sessions/${SESSION_ID}/outcomes`]: () =>
        apiError(500, "INTERNAL", "boom"),
    });
    await openOutputs();
    expect(
      await screen.findByRole("button", { name: "다시 시도" }),
    ).toBeTruthy();
    expect(screen.queryAllByText("아직 변경한 PR이 없습니다.")).toHaveLength(0);
  });

  test("a read that fails after an empty one is not taken for none either", async () => {
    let failing = false;
    const { services } = renderAt(`/sessions/${SESSION_ID}`, {
      ...pulled([], noFiles),
      [`GET /v1/sessions/${SESSION_ID}/outcomes`]: () =>
        failing ? apiError(500, "INTERNAL", "boom") : json(200, { items: [] }),
    });
    await openOutputs();
    expect(await screen.findByText("아직 변경한 PR이 없습니다.")).toBeTruthy();
    failing = true;
    await act(() =>
      services.queryClient.refetchQueries({
        predicate: (query) => query.queryKey.at(-1) === "outcomes",
      }),
    );
    expect(
      await screen.findByRole("button", { name: "다시 시도" }),
    ).toBeTruthy();
    expect(screen.queryAllByText("아직 변경한 PR이 없습니다.")).toHaveLength(0);
  });

  test("while pull requests that failed are read again, the failure and its retry stay with the focus on it, and go once they answer", async () => {
    const user = await setupUser();
    let answer: (response: Response) => void = () => {};
    let reads = 0;
    const { services } = renderAt(`/sessions/${SESSION_ID}`, {
      ...pulled([], noFiles),
      [`GET /v1/sessions/${SESSION_ID}/outcomes`]: () =>
        ++reads === 1
          ? apiError(500, "INTERNAL", "boom")
          : new Promise<Response>((resolve) => {
              answer = resolve;
            }),
    });
    await openOutputs();
    const area = await screen.findByRole("region", { name: "변경 사항" });
    const retry = await within(area).findByRole("button", {
      name: "다시 시도",
    });
    const reading = reported(services, "outcomes", "fetch");
    await user.click(retry);
    await reading();
    expect(reads).toBe(2);
    expect(retry.isConnected).toBe(true);
    expect(document.activeElement === retry).toBe(true);
    expect(within(area).getByText("불러오지 못했습니다")).toBeTruthy();
    expect(
      within(area).queryAllByText("아직 변경한 PR이 없습니다."),
    ).toHaveLength(0);
    act(() => answer(json(200, { items: [] })));
    expect(
      await within(area).findByText("아직 변경한 PR이 없습니다."),
    ).toBeTruthy();
    expect(
      within(area).queryByRole("button", { name: "다시 시도" }) === null,
    ).toBe(true);
  });

  test("the minute's own read of pull requests that failed leaves the failure and the focus where they are", async () => {
    let answer: (response: Response) => void = () => {};
    let reads = 0;
    const { services } = renderAt(`/sessions/${SESSION_ID}`, {
      ...pulled([], noFiles),
      [`GET /v1/sessions/${SESSION_ID}/outcomes`]: () =>
        ++reads === 1
          ? apiError(500, "INTERNAL", "boom")
          : new Promise<Response>((resolve) => {
              answer = resolve;
            }),
    });
    await openOutputs();
    const area = await screen.findByRole("region", { name: "변경 사항" });
    const retry = await within(area).findByRole("button", {
      name: "다시 시도",
    });
    act(() => retry.focus());
    const reading = reported(services, "outcomes", "fetch");
    // What the minute's interval does: a read nobody asked for.
    act(() => {
      void services.queryClient.refetchQueries({
        predicate: (query) => query.queryKey.at(-1) === "outcomes",
      });
    });
    await reading();
    expect(reads).toBe(2);
    expect(retry.isConnected).toBe(true);
    expect(document.activeElement === retry).toBe(true);
    const failedAgain = reported(services, "outcomes", "error");
    act(() => answer(apiError(500, "INTERNAL", "boom")));
    await failedAgain();
    expect(retry.isConnected).toBe(true);
    expect(document.activeElement === retry).toBe(true);
  });

  const STALE = "아래는 앞서 받은 목록입니다. 지금과 다를 수 있습니다.";
  const refusal: SessionGitHubRefusal = {
    receipt_id: "019a0000-0000-7000-8000-0000000000b1",
    operation: "mint_github_token",
    purpose: "push",
    reason_code: "github_disabled",
    created_at: AT,
  };
  /** Reads the lists whose key holds `name` again, as the minute does. */
  const readAgain = (services: { queryClient: QueryClient }, name: string) =>
    act(() =>
      services.queryClient.refetchQueries({
        predicate: (query) => query.queryKey.includes(name),
      }),
    );
  /** Whether `first` comes before `second` in the page. */
  const above = (first: Element, second: Element) =>
    (first.compareDocumentPosition(second) & 4) !== 0;

  test("pull requests already shown stay when a later read fails, under an alert that says they are from before", async () => {
    let failing = false;
    const { services } = renderAt(`/sessions/${SESSION_ID}`, {
      ...pulled(pulls, noFiles),
      [`GET /v1/sessions/${SESSION_ID}/outcomes`]: () =>
        failing
          ? apiError(500, "INTERNAL", "boom")
          : json(200, { items: pulls }),
    });
    await openOutputs();
    const area = await screen.findByRole("region", { name: "변경 사항" });
    expect(await within(area).findAllByRole("listitem")).toHaveLength(3);
    failing = true;
    await readAgain(services, "outcomes");
    const alert = await within(area).findByRole("alert");
    expect(alert.textContent).toContain("불러오지 못했습니다");
    expect(alert.textContent).toContain(STALE);
    expect(within(area).getAllByRole("listitem")).toHaveLength(3);
    expect(above(alert, within(area).getByRole("list"))).toBe(true);
    // Said once, inside the one alert; the rows' links still reachable.
    expect(within(area).getAllByRole("alert")).toHaveLength(1);
    expect(screen.getAllByText(STALE)).toHaveLength(1);
    expect(
      within(area).getAllByRole("link", { name: "Retry failed payments" }),
    ).toHaveLength(3);
    failing = false;
    await (await setupUser()).click(
      within(alert).getByRole("button", { name: "다시 시도" }),
    );
    await waitFor(() =>
      expect(within(area).queryByRole("alert") === null).toBe(true),
    );
    expect(within(area).getAllByRole("listitem")).toHaveLength(3);
  });

  test("out/ files already shown stay when a later read fails, under an alert that says they are from before", async () => {
    let failing = false;
    const { services } = renderAt(`/sessions/${SESSION_ID}`, {
      ...pulled([]),
      [`GET /v1/sessions/${SESSION_ID}/outputs`]: () =>
        failing ? apiError(500, "INTERNAL", "boom") : json(200, outputs),
    });
    const panel = await openOutputs();
    const files = await within(panel).findByRole("region", {
      name: "out/ 파일 3개",
    });
    failing = true;
    await readAgain(services, "outputs");
    const alert = await within(files).findByRole("alert");
    expect(alert.textContent).toContain("불러오지 못했습니다");
    expect(alert.textContent).toContain(STALE);
    expect(files.isConnected).toBe(true);
    const list = files.querySelector("details");
    expect(list === null).toBe(false);
    expect(above(alert, list as Element)).toBe(true);
    failing = false;
    await (await setupUser()).click(
      within(alert).getByRole("button", { name: "다시 시도" }),
    );
    await waitFor(() =>
      expect(within(panel).queryByRole("alert") === null).toBe(true),
    );
    expect(files.isConnected).toBe(true);
  });

  test("refusals already shown stay when a later read fails, under an alert that says they are from before", async () => {
    let failing = false;
    const { services } = renderAt(`/sessions/${SESSION_ID}`, {
      ...pulled([], noFiles),
      [`GET /v1/sessions/${SESSION_ID}/github/refusals`]: () =>
        failing
          ? apiError(500, "INTERNAL", "boom")
          : json(200, { items: [refusal] }),
    });
    await openOutputs();
    const refusals = await screen.findByRole("region", {
      name: "최근 GitHub 거절",
    });
    failing = true;
    await readAgain(services, "github-refusals");
    const alert = await within(refusals).findByRole("alert");
    expect(alert.textContent).toContain("불러오지 못했습니다");
    expect(alert.textContent).toContain(STALE);
    expect(within(refusals).getAllByRole("listitem")).toHaveLength(1);
    expect(above(alert, within(refusals).getByRole("list"))).toBe(true);
    failing = false;
    await (await setupUser()).click(
      within(alert).getByRole("button", { name: "다시 시도" }),
    );
    await waitFor(() =>
      expect(within(refusals).queryByRole("alert") === null).toBe(true),
    );
    expect(within(refusals).getAllByRole("listitem")).toHaveLength(1);
  });

  test("recent GitHub refusals name the reason, the work and when", async () => {
    renderAt(
      `/sessions/${SESSION_ID}`,
      pulled([], outputs, [
        {
          receipt_id: "019a0000-0000-7000-8000-0000000000b1",
          operation: "mint_github_token",
          purpose: "push",
          reason_code: "github_disabled",
          created_at: AT,
        },
        {
          receipt_id: "019a0000-0000-7000-8000-0000000000b2",
          operation: "dispatch_workflow",
          purpose: "dispatch",
          reason_code: "workflow_not_allowed",
          created_at: AT,
        },
      ]),
    );
    await openOutputs();
    const refusals = await screen.findByRole("region", {
      name: "최근 GitHub 거절",
    });
    const rows = within(refusals).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/^GitHub 사용 꺼짐push · /),
      expect.stringMatching(/^허용 목록 밖워크플로 실행 · /),
    ]);
    expect(rows[0]?.querySelector("time")?.getAttribute("datetime")).toBe(AT);
  });

  test("a refused merge reads as words, not as its keys", async () => {
    renderAt(
      `/sessions/${SESSION_ID}`,
      pulled([], outputs, [
        {
          receipt_id: "019a0000-0000-7000-8000-0000000000b3",
          operation: "merge_pull_request",
          purpose: "merge",
          reason_code: "merge_off",
          created_at: AT,
        },
      ]),
    );
    await openOutputs();
    const refusals = await screen.findByRole("region", {
      name: "최근 GitHub 거절",
    });
    const rows = within(refusals).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/^워크스페이스가 머지를 허용하지 않음PR 머지 · /),
    ]);
    expect(refusals.textContent).not.toMatch(/merge_off|agentGitHub/);
  });
});

describe("the session's GitHub work", () => {
  const withRepository = {
    ...detail,
    repository: { id: "demo", full_name: "acme/demo", branch: "main" },
  };
  const actor = {
    principal: { kind: "api_key" as const, id: "key-1" },
    actor_user_id: null,
    agent_id: null,
  };
  const request = {
    id: "019a0000-0000-7000-8000-0000000000a1",
    session_id: SESSION_ID,
    repository_id: "demo",
    checkpoint_revision: 2,
    git_commit: "a".repeat(40),
    target_branch: `agent/${SESSION_ID}`,
    state: "pushed" as const,
    requested_by: actor,
    requested_at: AT,
    resolved_by: null,
    resolved_at: null,
    resolution_reason: null,
    request_receipt_id: "019a0000-0000-7000-8000-0000000000b1",
    resolution_receipt_id: null,
    finished_at: AT,
    push_receipt_id: null,
    origin: "intent" as const,
    flow: "actions" as const,
    pr_state: "opening" as const,
    pr_error: null,
    pr_number: null,
    pr_url: null,
  };
  const intent = (
    id: string,
    fields: Partial<ListPushRequestsResponse["intents"][number]>,
  ) => ({
    id: `019a0000-0000-7000-8000-0000000000${id}`,
    session_id: SESSION_ID,
    repository_id: "demo",
    target_branch: `agent/${SESSION_ID}`,
    status: "deferred" as const,
    refusal_code: null,
    push_request_id: null,
    source_ref: null,
    created_at: AT,
    ...fields,
  });
  function working(answer: ListPushRequestsResponse) {
    return {
      ...routes(() => json(200, outputs)),
      [`GET /v1/sessions/${SESSION_ID}`]: () => json(200, withRepository),
      [`GET /v1/sessions/${SESSION_ID}/push-requests`]: () => json(200, answer),
    };
  }

  test("lists a request with its PR stage, a waiting intent, and why an ended one ended; an intent that became a request is not listed twice", async () => {
    renderAt(
      `/sessions/${SESSION_ID}`,
      working({
        items: [request],
        intents: [
          intent("c1", { status: "deferred" }),
          intent("c2", {
            status: "failed",
            refusal_code: "pinned_source_invalid",
          }),
          intent("c3", { status: "cancelled", refusal_code: "session_closed" }),
          intent("c4", { status: "requested", push_request_id: request.id }),
        ],
      }),
    );
    const area = await screen.findByRole("region", { name: "GitHub 작업" });
    // Same branch: the newest row shows and the rest sit behind one toggle.
    expect(within(area).getAllByRole("listitem")).toHaveLength(2);
    await (await setupUser()).click(
      within(area).getByRole("button", {
        name: "같은 브랜치의 이전 push 3건 보기",
      }),
    );
    const rows = within(area).getAllByRole("listitem");
    expect(rows).toHaveLength(5);
    expect(within(area).getByText("push됨")).toBeDefined();
    expect(within(area).getByText("PR 여는 중")).toBeDefined();
    expect(within(area).getByText("작업이 끝나기를 기다리는 중")).toBeDefined();
    expect(
      within(area).getByText(/고정한 체크포인트를 더는 확인할 수 없습니다/),
    ).toBeDefined();
    expect(within(area).getByText(/세션이 닫혔습니다/)).toBeDefined();
  });

  test("an opened PR links to its number; a failed stage says why; a PR address that is not https is not a link", async () => {
    renderAt(
      `/sessions/${SESSION_ID}`,
      working({
        items: [
          {
            ...request,
            id: "019a0000-0000-7000-8000-0000000000a2",
            pr_state: "opened",
            pr_number: 7,
            pr_url: "https://github.com/acme/demo/pull/7",
          },
          {
            ...request,
            id: "019a0000-0000-7000-8000-0000000000a3",
            pr_state: "failed",
            pr_error: "head_moved",
          },
          {
            ...request,
            id: "019a0000-0000-7000-8000-0000000000a4",
            pr_state: "opened",
            pr_number: 8,
            pr_url: "javascript:alert(1)",
          },
          {
            ...request,
            id: "019a0000-0000-7000-8000-0000000000a5",
            pr_state: "cancelled",
            pr_error: "push_failed",
          },
        ],
        intents: [],
      }),
    );
    const area = await screen.findByRole("region", { name: "GitHub 작업" });
    await (await setupUser()).click(
      within(area).getByRole("button", {
        name: "같은 브랜치의 이전 push 3건 보기",
      }),
    );
    const link = within(area).getByRole("link", { name: "PR #7" });
    expect(link.getAttribute("href")).toBe(
      "https://github.com/acme/demo/pull/7",
    );
    expect(link.getAttribute("rel")).toContain("noreferrer");
    expect(within(area).queryByRole("link", { name: "PR #8" })).toBeNull();
    expect(
      within(area).getByText(/브랜치가 push한 commit이 아닌 곳을 가리켜/),
    ).toBeDefined();
    // A push-stage refusal code has no PR wording: nothing is invented.
    expect(within(area).queryByText(/push_failed/)).toBeNull();
    expect(within(area).getByText("PR 실패")).toBeDefined();
    expect(within(area).getByText("PR 취소됨")).toBeDefined();
  });

  test("a session branch shows its first block with the whole name as the title; another branch is its own group", async () => {
    renderAt(
      `/sessions/${SESSION_ID}`,
      working({
        items: [
          request,
          {
            ...request,
            id: "019a0000-0000-7000-8000-0000000000a9",
            target_branch: "feature/login",
          },
        ],
        intents: [],
      }),
    );
    const area = await screen.findByRole("region", { name: "GitHub 작업" });
    expect(within(area).getAllByRole("listitem")).toHaveLength(2);
    expect(within(area).queryByRole("button")).toBeNull();
    const short = within(area).getByText("acme/demo ← agent/0f8b6a52…");
    expect(short.getAttribute("title")).toBe(`agent/${SESSION_ID}`);
    expect(within(area).getByText("acme/demo ← feature/login")).toBeDefined();
  });

  test("a session with only attached repositories is asked and shows each push under its owner/repo name", async () => {
    const { api } = renderAt(`/sessions/${SESSION_ID}`, {
      ...working({
        items: [{ ...request, repository_id: "shop" }],
        intents: [],
      }),
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        json(200, {
          ...detail,
          repository: null,
          repository_id: null,
          attached_repository_ids: ["shop"],
          attached_repositories: [{ id: "shop", full_name: "acme/shop" }],
        }),
    });
    const area = await screen.findByRole("region", { name: "GitHub 작업" });
    expect(within(area).getByText("acme/shop ← agent/0f8b6a52…")).toBeDefined();
    expect(api.calls.some((call) => call.path.endsWith("/push-requests"))).toBe(
      true,
    );
  });

  test("a push waiting for approval can be approved or rejected from the timeline, naming the commit the reader saw", async () => {
    const waiting = {
      ...request,
      state: "requested" as const,
      finished_at: null,
      pr_state: null,
    };
    const { api } = renderAt(`/sessions/${SESSION_ID}`, {
      ...working({ items: [waiting], intents: [] }),
      [`POST /v1/sessions/${SESSION_ID}/push-requests/${waiting.id}/approve`]:
        () => json(200, { ...waiting, state: "approved" }),
      [`POST /v1/sessions/${SESSION_ID}/push-requests/${waiting.id}/reject`]:
        () => json(200, { ...waiting, state: "rejected" }),
    });
    const area = await screen.findByRole("region", { name: "GitHub 작업" });
    expect(within(area).getByText("승인 대기")).toBeDefined();
    const user = await setupUser();
    await user.click(within(area).getByRole("button", { name: "push 승인" }));
    await waitFor(() =>
      expect(api.calls.find((call) => call.method === "POST")?.body).toEqual({
        git_commit: waiting.git_commit,
      }),
    );
    expect(
      api.calls
        .find((call) => call.method === "POST")
        ?.path.endsWith("/approve"),
    ).toBe(true);
    await user.click(within(area).getByRole("button", { name: "거절" }));
    await waitFor(() =>
      expect(
        api.calls.filter(
          (call) => call.method === "POST" && call.path.endsWith("/reject"),
        ),
      ).toHaveLength(1),
    );
  });

  test("a decision the server refuses says so in words next to the buttons", async () => {
    const waiting = {
      ...request,
      state: "requested" as const,
      finished_at: null,
      pr_state: null,
    };
    renderAt(`/sessions/${SESSION_ID}`, {
      ...working({ items: [waiting], intents: [] }),
      [`POST /v1/sessions/${SESSION_ID}/push-requests/${waiting.id}/approve`]:
        () => apiError(409, "CHECKPOINT_MOVED", "A newer checkpoint was saved"),
    });
    const area = await screen.findByRole("region", { name: "GitHub 작업" });
    await (await setupUser()).click(
      within(area).getByRole("button", { name: "push 승인" }),
    );
    // Waiting does not heal a moved checkpoint, so the sentence says to reject
    // and ask again instead of the generic "try again later".
    expect((await within(area).findByRole("alert")).textContent).toContain(
      "거절하고 새 push를 요청하세요",
    );
    // The buttons stay: the request is still open.
    expect(
      within(area).getByRole("button", { name: "push 승인" }),
    ).toBeDefined();
  });

  test("an approved push leaves the waiting row once the list is read again, and the decision is sent once", async () => {
    let state: "requested" | "approved" = "requested";
    const waiting = {
      ...request,
      state: "requested" as const,
      finished_at: null,
      pr_state: null,
    };
    const { api } = renderAt(`/sessions/${SESSION_ID}`, {
      ...working({ items: [waiting], intents: [] }),
      [`GET /v1/sessions/${SESSION_ID}/push-requests`]: () =>
        json(200, { items: [{ ...waiting, state }], intents: [] }),
      [`POST /v1/sessions/${SESSION_ID}/push-requests/${waiting.id}/approve`]:
        () => {
          state = "approved";
          return json(200, { ...waiting, state });
        },
    });
    const area = await screen.findByRole("region", { name: "GitHub 작업" });
    const approve = within(area).getByRole("button", { name: "push 승인" });
    expect(
      within(area).getByText(waiting.git_commit.slice(0, 7)),
    ).toBeDefined();
    await (await setupUser()).click(approve);
    await waitFor(() =>
      expect(
        within(area).queryByRole("button", { name: "push 승인" }),
      ).toBeNull(),
    );
    expect(within(area).getByText("승인됨")).toBeDefined();
    expect(
      api.calls.filter(
        (call) => call.method === "POST" && call.path.endsWith("/approve"),
      ),
    ).toHaveLength(1);
  });

  test("a push that failed says in plain words what to check, and a pushed one has no approve button", async () => {
    renderAt(
      `/sessions/${SESSION_ID}`,
      working({
        items: [
          {
            ...request,
            id: "019a0000-0000-7000-8000-0000000000b2",
            state: "failed",
            pr_state: null,
          },
          {
            ...request,
            id: "019a0000-0000-7000-8000-0000000000b3",
            target_branch: "feature/ok",
          },
        ],
        intents: [],
      }),
    );
    const area = await screen.findByRole("region", { name: "GitHub 작업" });
    expect(within(area).getByText("push 실패")).toBeDefined();
    expect(
      within(area).getByText(/원격 저장소가 push를 받지 않았습니다/),
    ).toBeDefined();
    expect(
      within(area).queryByRole("button", { name: "push 승인" }),
    ).toBeNull();
  });

  test("an older server's answer, with no intents and no pr_state, still lists the request without a stage", async () => {
    const {
      flow: _flow,
      origin: _origin,
      pr_state: _stage,
      ...older
    } = request;
    renderAt(
      `/sessions/${SESSION_ID}`,
      working({ items: [older] } as unknown as ListPushRequestsResponse),
    );
    const area = await screen.findByRole("region", { name: "GitHub 작업" });
    expect(within(area).getAllByRole("listitem")).toHaveLength(1);
    expect(within(area).getByText("push됨")).toBeDefined();
    expect(within(area).queryByText("PR 여는 중")).toBeNull();
  });

  test("nothing is shown for a session with no push work, and a session without a repository is not asked", async () => {
    const { api } = renderAt(`/sessions/${SESSION_ID}`, {
      ...working({ items: [], intents: [] }),
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        json(200, { ...detail, repository: null, repository_id: null }),
    });
    await openOutputs();
    await screen.findByRole("region", { name: /^out\/ 파일/ });
    expect(
      screen.queryByRole("region", { name: "GitHub 작업", hidden: true }),
    ).toBeNull();
    expect(api.calls.some((call) => call.path.endsWith("/push-requests"))).toBe(
      false,
    );
  });
});
