import { describe, expect, test } from "bun:test";
import type { ApiClient } from "@werft-ai/client";
import { setupDom, setupUser } from "@werft-ai/ui/test-support/dom";
import { type ReactNode, useState } from "react";

const { render, waitFor } = await setupDom();
// After setupDom: these load @werft-ai/ui, whose Radix decides at import time
// whether a DOM exists, for every later file in the run too.
const { WerftProvider } = await import("../../provider.tsx");
const { Findings } = await import("./findings.tsx");
const { SessionCounts } = await import("./session-counts.tsx");
const { ToolCalls } = await import("./tool-calls.tsx");
const { ToolTable } = await import("./tool-table.tsx");
const { ToolDetail } = await import("./tool-detail.tsx");
const { ToolsSummary } = await import("./tools-summary.tsx");
const { findTools, sortTools, TOOL_SEARCH_DEBOUNCE_MS, ToolsFilter } =
  await import("./tools-filter.tsx");
const { InstallationLimits } = await import("./installation-limits.tsx");
const { OperationsHead } = await import("./operations-head.tsx");
const { UsageFilters } = await import("./usage-filters.tsx");
const { UsageKpis } = await import("./usage-kpis.tsx");
const { UsageCostTable } = await import("./usage-cost-table.tsx");
const { UsageInitiatorSplit } = await import("./usage-initiator-split.tsx");
const { UsageOutcomes } = await import("./usage-outcomes.tsx");
const { UsageDailyCost } = await import("./usage-daily-cost.tsx");
const { UsageBasis } = await import("./usage-basis.tsx");
const { OPERATIONS_MESSAGES } = await import("./messages.ts");

const TOOLS = [
  {
    name: "Bash",
    calls: 1840,
    failed: 21,
    total_ms: 13320000,
    median_ms: 3100,
    max_ms: 298000,
    description: null,
  },
  {
    name: "Edit",
    calls: 702,
    failed: 12,
    total_ms: 1620000,
    median_ms: 900,
    max_ms: 14200,
    description: null,
  },
  {
    name: "WebFetch",
    calls: 214,
    failed: 1,
    total_ms: 3960000,
    median_ms: 12400,
    max_ms: 61000,
    description: null,
  },
];

function withPlatform(node: ReactNode, locale: "ko" | "en" = "ko") {
  return render(
    <WerftProvider
      client={{} as ApiClient}
      locale={locale}
      renderLink={({ to, id, children, className }) => (
        <a href={`/${to}/${id}`} className={className}>
          {children}
        </a>
      )}
    >
      {node}
    </WerftProvider>,
  );
}

describe("ToolTable", () => {
  function Picker() {
    const [selected, setSelected] = useState("Bash");
    return (
      <ToolTable
        tools={TOOLS}
        label="도구"
        selected={selected}
        onSelect={setSelected}
      />
    );
  }

  test("키보드만으로 행을 고르고, 고른 행의 opener만 aria-pressed=true다", async () => {
    const user = await setupUser();
    const { getByRole } = withPlatform(<Picker />);
    const opener = (name: string) =>
      getByRole("button", { name: `${name} 자세히 보기` });
    expect(opener("Bash").getAttribute("aria-pressed")).toBe("true");
    await user.tab();
    await user.tab();
    expect(document.activeElement === opener("Edit")).toBe(true);
    await user.keyboard("{Enter}");
    expect(opener("Edit").getAttribute("aria-pressed")).toBe("true");
    expect(opener("Bash").getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelectorAll("[aria-selected]").length).toBe(0);
  });

  test("opener는 여는 절을 aria-controls로 가리키고, 붙은 제목 위에서 멈추게 아래 여백을 둔다", () => {
    const { getAllByRole } = withPlatform(
      <ToolTable tools={TOOLS} label="도구" controls="picked-tool" />,
    );
    const openers = getAllByRole("button", { name: /자세히 보기$/ });
    expect(
      openers.map((opener) => opener.getAttribute("aria-controls")),
    ).toEqual(TOOLS.map(() => "picked-tool"));
    expect(openers[0]?.className).toContain("scroll-mb-18");
  });

  test("호출·총 시간·보통·실패를 locale 형식으로 쓴다", () => {
    const { getAllByRole } = withPlatform(
      <ToolTable tools={TOOLS} label="도구" />,
    );
    const cells = getAllByRole("row")[1]?.querySelectorAll("[role=cell]");
    expect([...(cells ?? [])].slice(1).map((cell) => cell.textContent)).toEqual(
      ["1,840", "3시간 42분", "3.1초", "21"],
    );
  });

  test("숫자 열은 머리글과 셀이 함께 끝에 붙고, 이름 열은 함께 시작에 붙는다", () => {
    const { getAllByRole } = withPlatform(
      <ToolTable tools={TOOLS} label="도구" />,
    );
    const ends = (element: Element) =>
      element.className.includes("justify-end");
    const heads = getAllByRole("columnheader");
    expect(heads.map(ends)).toEqual([false, true, true, true, true]);
    const cells = getAllByRole("row")[1]?.querySelectorAll("[role=cell]");
    expect([...(cells ?? [])].map(ends)).toEqual(heads.map(ends));
  });

  test("고른 행의 설명 줄은 muted 글자색이라 bg-active 위에서도 AA 대비를 지킨다", () => {
    const { getAllByText } = withPlatform(
      <ToolTable
        tools={TOOLS.slice(0, 2)}
        label="도구"
        selected="Bash"
        describe={() => "셸 명령"}
      />,
    );
    const [picked, other] = getAllByText("셸 명령");
    expect(picked?.className).toContain("text-muted-foreground");
    expect(other?.className).toContain("text-subtle-foreground");
  });
});

describe("Findings", () => {
  test("도구 이름을 문장 끝에 두고 같은 이름의 tools 행에서 숫자를 읽는다", () => {
    const { getAllByRole } = withPlatform(
      <Findings
        data={{
          tools: TOOLS,
          findings: [
            { kind: "most_time", name: "Bash" },
            { kind: "fails_often", name: "Edit" },
            { kind: "slowest", name: "WebFetch" },
          ],
        }}
      />,
    );
    expect(getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "가장 오래 걸리는 도구: Bash3시간 42분 · 전체 도구 시간의 70%",
      "자주 실패하는 도구: Edit702번 중 12번 실패 (1.7%)",
      "가장 느린 도구: WebFetch보통 12.4초 · 호출 214번",
    ]);
  });

  test("tools에 없는 이름의 finding은 그리지 않는다", () => {
    const { queryAllByRole } = withPlatform(
      <Findings
        data={{ tools: TOOLS, findings: [{ kind: "slowest", name: "Gone" }] }}
      />,
    );
    expect(queryAllByRole("listitem")).toHaveLength(0);
  });
});

describe("1분 미만 도구 시간", () => {
  const WRITE = {
    name: "Write",
    calls: 1,
    failed: 0,
    total_ms: 1700,
    median_ms: 1700,
    max_ms: 1700,
    description: null,
  };

  test("총 시간을 0분이 아니라 초로 쓴다", () => {
    const { container } = withPlatform(
      <>
        <Findings
          data={{
            tools: [WRITE],
            findings: [{ kind: "most_time", name: "Write" }],
          }}
        />
        <ToolTable tools={[WRITE]} label="도구" />
        <ToolsSummary tools={[WRITE]} period="최근 30일" />
        <ToolDetail
          name="Write"
          tool={WRITE}
          perDay={[]}
          calls={[]}
          callSort="recent"
          onCallSortChange={() => {}}
        />
      </>,
    );
    const text = (selector: string) =>
      container.querySelector(selector)?.textContent;
    expect(text("[data-slot=findings] li")).toBe(
      "가장 오래 걸리는 도구: Write1.7초 · 전체 도구 시간의 100%",
    );
    expect(
      [
        ...(container
          .querySelectorAll("[role=row]")[1]
          ?.querySelectorAll("[role=cell]") ?? []),
      ]
        .slice(2, 4)
        .map((cell) => cell.textContent),
    ).toEqual(["1.7초", "1.7초"]);
    expect(text("[data-slot=tools-summary]")).toBe(
      "최근 30일 동안 에이전트가 도구를 1번 불렀고 모두 1.7초 동안 실행했습니다. 0번 실패했습니다 (0.0%).",
    );
    expect(
      [...container.querySelectorAll("[data-slot=tool-detail] dd")].map(
        (dd) => dd.textContent,
      ),
    ).toEqual(["1번", "1.7초", "1.7초", "0번 (0.0%)"]);
  });
});

describe("ToolDetail loading", () => {
  test("도구 목록을 읽는 동안 절 제목이 비지 않고, 이름이 오면 읽는 중 안내가 빠진다", () => {
    const detail = (name: string | undefined) => (
      <ToolDetail
        name={name}
        tool={undefined}
        perDay={undefined}
        calls={undefined}
        callSort="recent"
        onCallSortChange={() => {}}
      />
    );
    const view = withPlatform(detail(undefined), "en");
    // The accessible name skips the aria-hidden skeleton.
    expect(
      view.getByRole("heading", {
        level: 2,
        name: "Selected tool Loading tools",
      }),
    ).toBeTruthy();
    view.rerender(
      <WerftProvider
        client={{} as ApiClient}
        locale="en"
        renderLink={() => null}
      >
        {detail("Bash")}
      </WerftProvider>,
    );
    expect(
      view.getByRole("heading", { level: 2, name: "Selected tool Bash" }),
    ).toBeTruthy();
    expect(
      view.container.querySelector("[data-slot=tool-detail-head] h2")
        ?.textContent,
    ).toBe("Selected tool Bash");
  });

  test("고른 때에만 제목 문구를 한 번 알리고, 열린 절을 가리킬 id를 받는다", () => {
    const SECTION_ID = "picked-tool";
    const detail = (announce: boolean) => (
      <ToolDetail
        id={SECTION_ID}
        announce={announce}
        name="Bash"
        tool={undefined}
        perDay={undefined}
        calls={undefined}
        callSort="recent"
        onCallSortChange={() => {}}
      />
    );
    const view = withPlatform(detail(false), "en");
    const said = () => view.container.querySelector("output")?.textContent;
    expect(said()).toBe("");
    view.rerender(
      <WerftProvider
        client={{} as ApiClient}
        locale="en"
        renderLink={() => null}
      >
        {detail(true)}
      </WerftProvider>,
    );
    expect(said()).toBe("Selected tool Bash");
    const section = view.getByRole("region", { name: "Selected tool Bash" });
    expect(section.id).toBe(SECTION_ID);
    // The section never reaches up under the stuck heading.
    expect(section.className).not.toMatch(/(^|\s)-m[ty]?-/);
  });
});

describe("SessionCounts", () => {
  const link = (
    status: string,
    props: { readonly className: string; readonly children: ReactNode },
  ) => (
    <a href={`/sessions?status=${status}`} className={props.className}>
      {props.children}
    </a>
  );

  test("상태마다 세션 목록 링크이고, slots가 없으면 slot 줄이 없다", () => {
    const counts = {
      queued: 2,
      running: 7,
      needs_input: 3,
      idle: 41,
      failed: 1,
      stopped: 12,
      cut_off: 0,
    };
    const member = withPlatform(
      <SessionCounts counts={counts} statusLink={link} />,
    );
    expect(
      member.getAllByRole("link").map((a) => a.getAttribute("href")),
    ).toEqual([
      "/sessions?status=queued",
      "/sessions?status=running",
      "/sessions?status=needs_input",
      "/sessions?status=idle",
      "/sessions?status=failed",
      "/sessions?status=stopped",
    ]);
    expect(member.queryByRole("meter")).toBeNull();
    member.unmount();
    const owner = withPlatform(
      <SessionCounts
        counts={counts}
        slots={{ used: 7, limit: 10 }}
        statusLink={link}
      />,
    );
    expect(owner.getByRole("meter").getAttribute("aria-valuenow")).toBe("7");
    expect(owner.getByRole("status").textContent).toBe("");
  });

  test("처음 읽는 동안 slot 줄은 자리를 지키고, 상태 알림은 하나다", () => {
    const { getAllByRole, queryByRole, getByText } = withPlatform(
      <SessionCounts counts={undefined} slots={null} statusLink={link} />,
    );
    expect(getByText("동시 실행 슬롯 · 설치 전체")).toBeTruthy();
    expect(queryByRole("meter")).toBeNull();
    expect(getAllByRole("status").map((s) => s.textContent)).toEqual([
      "세션 수를 읽는 중",
    ]);
  });

  test("화면이 알림을 맡으면 loading을 비워 상태 알림을 내지 않는다", () => {
    const { queryAllByRole } = withPlatform(
      <SessionCounts
        counts={undefined}
        slots={null}
        statusLink={link}
        messages={{ loading: "" }}
      />,
    );
    expect(queryAllByRole("status")).toHaveLength(0);
  });
});

describe("ToolTable loading", () => {
  test("읽는 중 표는 상태 알림 없이 읽는 중이라는 말을 한 번만 둔다", () => {
    const { queryAllByRole, getAllByText, getByRole } = withPlatform(
      <ToolTable tools={undefined} label="도구와 명령" onSelect={() => {}} />,
    );
    expect(queryAllByRole("status")).toHaveLength(0);
    expect(getAllByText("도구 목록을 읽는 중")).toHaveLength(1);
    expect(getByRole("table").getAttribute("aria-busy")).toBe("true");
  });

  test("읽는 중 행 수는 loadingRows이고, 도구가 오면 같은 표에 그 행이 들어온다", () => {
    const table = (tools: typeof TOOLS | undefined) => (
      <WerftProvider
        client={{} as ApiClient}
        locale="ko"
        renderLink={() => null}
      >
        <ToolTable
          tools={tools}
          label="도구와 명령"
          loadingRows={TOOLS.length + 1}
          describe={() => "셸 명령"}
        />
      </WerftProvider>
    );
    const { getAllByRole, getByRole, queryByText, rerender } = render(
      table(undefined),
    );
    const before = getByRole("table");
    // One header row, then a placeholder per row.
    expect(getAllByRole("row")).toHaveLength(TOOLS.length + 2);
    rerender(table(TOOLS));
    // toBe on DOM nodes can pass on any element in bun; compare identity.
    expect(getByRole("table") === before).toBe(true);
    expect(before.getAttribute("aria-busy")).toBeNull();
    expect(getAllByRole("row")).toHaveLength(TOOLS.length + 1);
    expect(queryByText("도구 목록을 읽는 중")).toBeNull();
  });

  test("describe가 없으면 읽는 중 행도 설명 줄이 없어 도구 행과 줄 수가 같다", () => {
    const lines = (tools: typeof TOOLS | undefined) => {
      const { container, unmount } = withPlatform(
        <ToolTable tools={tools} label="도구와 명령" loadingRows={1} />,
      );
      const cell = container.querySelector(
        "[role=row]:nth-child(2) [role=cell]",
      );
      const count = [...(cell?.children ?? [])].filter(
        (child) =>
          !child.matches("button, .sr-only") &&
          !child.className.includes("sr-only"),
      ).length;
      unmount();
      return count;
    };
    expect(lines(undefined)).toBe(2);
    expect(lines(TOOLS)).toBe(2);
  });

  test("검색 결과가 없으면 '기간에 불린 도구 없음'이 아니라 '찾는 이름 없음'이다", () => {
    const { getByText, unmount } = withPlatform(
      <ToolTable tools={[]} label="도구와 명령" searched />,
    );
    expect(getByText("찾는 이름의 도구가 없습니다.")).toBeTruthy();
    unmount();
    expect(
      withPlatform(<ToolTable tools={[]} label="도구와 명령" />).getByText(
        "이 기간에 불린 도구가 없습니다.",
      ),
    ).toBeTruthy();
  });
});

describe("ToolsSummary", () => {
  test("실패 수는 실패가 있을 때만 위험 색이고, 0번이면 다른 숫자처럼 굵게만 보인다", () => {
    const summary = (tools: typeof TOOLS) =>
      withPlatform(
        <ToolsSummary tools={tools} period="최근 30일" />,
      ).container.querySelector("[data-slot=tools-summary]");
    expect(
      summary(TOOLS)?.querySelector("[class*=tone-danger]")?.textContent,
    ).toBe("34번 실패");
    const clean = summary(TOOLS.map((tool) => ({ ...tool, failed: 0 })));
    expect(clean?.querySelector("[class*=tone-danger]")).toBeNull();
    expect(
      [...(clean?.querySelectorAll("[data-slot=text]") ?? [])].map(
        (part) => part.textContent,
      ),
    ).toContain("0번 실패");
  });
});

describe("tools tab loading", () => {
  test("Findings와 ToolsSummary는 읽는 중에 숨긴 자리표시만 둔다", () => {
    const { container, queryAllByRole } = withPlatform(
      <>
        <Findings data={undefined} loadingRows={3} />
        <ToolsSummary tools={undefined} period="최근 30일" />
      </>,
    );
    expect(container.querySelectorAll("li")).toHaveLength(3);
    expect(queryAllByRole("listitem")).toHaveLength(0);
    expect(queryAllByRole("status")).toHaveLength(0);
    expect(container.querySelector("[data-slot=tools-summary]")).toBeNull();
  });

  test("ToolDetail은 이름도 모를 때 자리표시로 서고, 값이 오면 같은 자리에 그린다", () => {
    const detail = (ready: boolean) => (
      <WerftProvider
        client={{} as ApiClient}
        locale="ko"
        renderLink={({ id, children }) => <a href={`/s/${id}`}>{children}</a>}
      >
        <ToolDetail
          name={ready ? "Bash" : undefined}
          tool={ready ? TOOLS[0] : undefined}
          perDay={
            ready
              ? Array.from({ length: 20 }, (_, i) => ({
                  date: `2026-10-${String(5 + i).padStart(2, "0")}`,
                  calls: i,
                }))
              : undefined
          }
          calls={ready ? [] : undefined}
          callSort="recent"
          onCallSortChange={() => {}}
        />
      </WerftProvider>
    );
    const { getByRole, queryByRole, rerender, container } = render(
      detail(false),
    );
    const section = getByRole("region", {
      name: "선택한 도구 도구 목록을 읽는 중",
    });
    expect(queryByRole("img")).toBeNull();
    expect(
      [...container.querySelectorAll("dd")].map(
        (dd) => dd.querySelector("[aria-hidden=true]") !== null,
      ),
    ).toEqual([true, true, true, true]);
    rerender(detail(true));
    expect(getByRole("region", { name: "선택한 도구 Bash" }) === section).toBe(
      true,
    );
    expect(
      getByRole("heading", { level: 2, name: "선택한 도구 Bash" }),
    ).toBeTruthy();
    expect(
      [...container.querySelectorAll("dd")].map((dd) => dd.textContent),
    ).toEqual(["1,840번", "3시간 42분", "3.1초", "21번 (1.1%)"]);
    expect(getByRole("img").getAttribute("aria-label")).toBe(
      "Bash 일자별 호출, 최근 14일, 합계 175번, 가장 많은 날 10/24 19번",
    );
  });

  test("ToolDetail error는 차트 자리에 서고 최근 호출 칸은 두지 않는다", () => {
    const { getByText, queryByRole } = withPlatform(
      <ToolDetail
        name="Bash"
        tool={TOOLS[0]}
        perDay={undefined}
        calls={undefined}
        callSort="recent"
        onCallSortChange={() => {}}
        error={<p>읽지 못했습니다</p>}
      />,
    );
    expect(getByText("읽지 못했습니다")).toBeTruthy();
    expect(queryByRole("heading", { name: "최근 호출" })).toBeNull();
  });

  test("ToolDetail은 14일 내내 호출이 없어도 막대 높이를 숫자로 쓴다", () => {
    const { container } = withPlatform(
      <ToolDetail
        name="Bash"
        tool={TOOLS[0]}
        perDay={Array.from({ length: 14 }, (_, i) => ({
          date: `2026-10-${String(10 + i).padStart(2, "0")}`,
          calls: 0,
        }))}
        calls={[]}
        callSort="recent"
        onCallSortChange={() => {}}
      />,
    );
    const heights = [
      ...container.querySelectorAll<HTMLElement>("[role=img] > span > span"),
    ].map((bar) => bar.style.height);
    expect(heights).toEqual(Array(14).fill("0.0%"));
  });

  test("ToolDetail은 목록에 없는 도구의 수치 넷을 그리지 않고, 기간 낱말이 오면 부르지 않았다고 적어 절을 설명한다", () => {
    const detail = (quietPeriod?: string) => (
      <ToolDetail
        name="Edit"
        tool={undefined}
        listed={false}
        quietPeriod={quietPeriod}
        perDay={[{ date: "2026-10-24", calls: 0 }]}
        calls={[]}
        callSort="recent"
        onCallSortChange={() => {}}
      />
    );
    const view = withPlatform(detail());
    const section = view.getByRole("region", { name: "선택한 도구 Edit" });
    expect(section.querySelectorAll("dt")).toHaveLength(0);
    expect(section.hasAttribute("aria-describedby")).toBe(false);
    expect(
      view.container.querySelector("[data-slot=tool-detail-quiet]") === null,
    ).toBe(true);
    view.unmount();

    const quiet = withPlatform(detail("7일"));
    const line = quiet.getByText("최근 7일 동안 부르지 않았습니다.");
    expect(
      quiet
        .getByRole("region", { name: "선택한 도구 Edit" })
        .getAttribute("aria-describedby"),
    ).toBe(line.id);
  });
});

describe("tools sort and search", () => {
  test("정렬은 그 값이 큰 순이고 같으면 API 순서를 지킨다; 검색은 대소문자를 가리지 않는다", () => {
    const names = (tools: readonly { name: string }[]) =>
      tools.map((t) => t.name);
    expect(names(sortTools(TOOLS, "calls"))).toEqual([
      "Bash",
      "Edit",
      "WebFetch",
    ]);
    expect(names(sortTools(TOOLS, "time"))).toEqual([
      "Bash",
      "WebFetch",
      "Edit",
    ]);
    expect(names(sortTools(TOOLS, "slow"))).toEqual([
      "WebFetch",
      "Bash",
      "Edit",
    ]);
    expect(
      names(
        sortTools(
          [
            ...TOOLS,
            {
              name: "Z",
              calls: 1,
              failed: 21,
              total_ms: 0,
              median_ms: 0,
              max_ms: 0,
              description: null,
            },
          ],
          "failed",
        ),
      ),
    ).toEqual(["Bash", "Z", "Edit", "WebFetch"]);
    expect(names(findTools(TOOLS, " web "))).toEqual(["WebFetch"]);
    expect(names(findTools(TOOLS, ""))).toEqual(names(TOOLS));
  });

  test("검색어는 입력이 멈춘 뒤 한 번만 알린다", async () => {
    const seen: string[] = [];
    const { getByRole } = withPlatform(
      <ToolsFilter
        sort="calls"
        onSortChange={() => {}}
        onQueryChange={(query) => seen.push(query)}
      />,
    );
    const user = await setupUser();
    await user.type(getByRole("searchbox", { name: "도구 찾기" }), "bash");
    expect(seen).toEqual([]);
    await new Promise((resolve) =>
      setTimeout(resolve, TOOL_SEARCH_DEBOUNCE_MS + 50),
    );
    expect(seen).toEqual(["bash"]);
  });
});

describe("ToolCalls loading", () => {
  test("읽는 중에는 loadingRows만큼 숨긴 자리표시 행을 두고 상태 알림은 내지 않는다", () => {
    const { container, queryAllByRole } = withPlatform(
      <ToolCalls calls={undefined} loadingRows={5} />,
    );
    expect(container.querySelectorAll("li")).toHaveLength(5);
    expect(queryAllByRole("listitem")).toHaveLength(0);
    expect(queryAllByRole("status")).toHaveLength(0);
  });
});

describe("ToolCalls", () => {
  test("볼 수 없는 세션은 링크가 없고, 결과 모름은 성공으로 그리지 않는다", () => {
    const { getAllByRole, getAllByText, queryAllByRole } = withPlatform(
      <ToolCalls
        timeZone="Asia/Seoul"
        calls={[
          {
            occurred_at: "2026-10-24T12:39:10Z",
            agent: "리뷰 봇",
            session_id: "ses_05",
            title: "PR #813 리뷰",
            duration_ms: null,
            outcome: "unknown",
          },
          {
            occurred_at: "2026-10-24T12:36:41Z",
            agent: "배포 도우미",
            session_id: null,
            title: null,
            duration_ms: 41200,
            outcome: "ok",
          },
          {
            occurred_at: "2026-10-24T12:31:02Z",
            agent: null,
            session_id: "ses_06",
            title: "릴리스 노트 초안",
            duration_ms: 3400,
            outcome: "failed",
          },
        ]}
      />,
    );
    expect(queryAllByRole("link").map((a) => a.getAttribute("href"))).toEqual([
      "/session/ses_05",
      "/session/ses_06",
    ]);
    expect(getAllByText("볼 수 없는 세션")).toHaveLength(1);
    const rows = getAllByRole("listitem").map((item) => item.textContent);
    expect(rows).toEqual([
      "PR #813 리뷰리뷰 봇 · 21:39—결과 모름",
      "볼 수 없는 세션배포 도우미 · 21:3641.2초완료",
      "릴리스 노트 초안21:313.4초실패",
    ]);
  });
});

const LIMITS = {
  scope: "installation" as const,
  refreshed_at: "2026-10-24T12:40:00Z",
  limits: {
    execution_slot_limit: 10,
    queued_input_limit_per_session: 20,
    storage_limit_bytes: 10737418240,
    max_turn_seconds: 3600,
    session_cost_limit_usd: "25.00",
    session_token_limit: null,
    provider_max_retries: 3,
  },
  usage: {
    execution_slots_used: 7,
    queued_input_count: 4,
    storage: {
      used_bytes: 2147483648,
      accounted_content: ["input_messages" as const],
      updated_at: "2026-10-24T12:31:00Z",
    },
    outputs: {
      used_bytes: 536870912,
      updated_at: "2026-10-24T12:35:00Z",
      complete: true,
    },
    archived_events: { used_bytes: 0, updated_at: null },
  },
};

describe("InstallationLimits", () => {
  // null means no token limit: every gate skips the token check
  // (budgetExceeded), and the settings screen saves it as 0, "no limit".
  test("한도 행마다 현재·한도를 쓰고, 토큰 한도가 null이면 성과물 저장처럼 '한도 없음'이다", () => {
    const { getByRole } = withPlatform(
      <InstallationLimits limits={LIMITS} timeZone="Asia/Seoul" />,
    );
    const rows = [
      ...getByRole("table", { name: "한도" }).querySelectorAll("[role=row]"),
    ]
      .slice(1)
      .map((row) =>
        [...row.querySelectorAll("[role=cell]")]
          .slice(0, 3)
          .map((cell) => cell.textContent),
      );
    expect(rows).toEqual([
      ["동시 실행 슬롯", "7 / 10", "10"],
      ["입력 보관", "2 GB", "10 GB"],
      ["성과물 저장", "512 MB", "한도 없음"],
      ["세션 비용", "세션마다 셉니다", "$25.00"],
      ["세션 토큰", "세션마다 셉니다", "한도 없음"],
      ["대기 메시지", "세션마다 셉니다", "20건"],
      ["턴 시간", "세션마다 셉니다", "1시간 0분"],
    ]);
    expect(document.body.textContent).toContain(
      "설치 전체에 적용됩니다 · 오후 9:40 기준",
    );
  });

  test("성과물 행은 받은 그대로 설명하고, 빠진 checkpoint가 있으면 값을 하한으로 쓰고 적게 셀 수 있다고 쓴다", () => {
    // Item, current and note of the storage and outputs rows.
    const rows = (limits: typeof LIMITS) => {
      const { getByRole, unmount } = withPlatform(
        <InstallationLimits limits={limits} timeZone="Asia/Seoul" />,
      );
      const cells = [
        ...getByRole("table", { name: "한도" }).querySelectorAll("[role=row]"),
      ]
        .slice(2, 4)
        .map((row) =>
          [...row.querySelectorAll("[role=cell]")]
            .filter((_, i) => i !== 2)
            .map((cell) => cell.textContent),
        );
      unmount();
      return cells;
    };
    expect(rows(LIMITS)).toEqual([
      [
        "입력 보관",
        "2 GB",
        "세션에 보낸 입력 메시지만 셉니다. 성과물은 따로 셉니다",
      ],
      [
        "성과물 저장",
        "512 MB",
        "세션 성과물이 차지한 용량. 보여 주기만 하고 막지 않습니다",
      ],
    ]);
    // The current cell stays on narrow screens, where the note column hides.
    expect(
      rows({
        ...LIMITS,
        usage: {
          ...LIMITS.usage,
          outputs: { ...LIMITS.usage.outputs, complete: false },
        },
      })[1],
    ).toEqual([
      "성과물 저장",
      "512 MB 이상",
      "성과물을 세기 전 체크포인트가 남아 있어 실제보다 적을 수 있습니다",
    ]);
  });

  test("읽는 동안 meter 없이 한 번만 알린다", () => {
    const { queryAllByRole, getAllByRole } = withPlatform(
      <InstallationLimits limits={undefined} />,
    );
    expect(queryAllByRole("meter")).toHaveLength(0);
    expect(getAllByRole("status").map((s) => s.textContent)).toEqual([
      "한도를 읽는 중",
    ]);
  });

  const MEMBER_LIMITS = {
    scope: "me" as const,
    refreshed_at: "2026-10-24T12:40:00Z",
    limits: {
      queued_input_limit_per_session: 20,
      max_turn_seconds: 3600,
      session_cost_limit_usd: "25.00",
      session_token_limit: 2_000_000,
    },
  };
  const tableRows = (getByRole: (role: string, o: object) => HTMLElement) =>
    [...getByRole("table", { name: "한도" }).querySelectorAll("[role=row]")]
      .slice(1)
      .map((row) =>
        [...row.querySelectorAll("[role=cell]")].map(
          (cell) => cell.textContent,
        ),
      );
  // The "—" is hidden from screen readers, which read the words after it.
  const STATIC_MEMBER_ROWS = [
    [
      "구성원당 동시 실행 슬롯",
      "—제공 안 됨",
      "설정 안 됨",
      "구성원별 상한은 없습니다. 설치 전체의 슬롯을 함께 씁니다",
    ],
    [
      "구성원당 월 비용",
      "—제공 안 됨",
      "설정 안 됨",
      "구성원별 월 비용 한도는 없습니다",
    ],
    [
      "구성원당 성과물 저장",
      "미계측",
      "한도 없음",
      "구성원별 성과물 용량은 세지 않습니다",
    ],
  ];

  test('scope="me": 세션 한도 4개와 값을 만들지 않는 정적 행만 보이고 설치 전체 용량은 없다', () => {
    const { getByRole, queryAllByRole, queryByText } = withPlatform(
      <InstallationLimits
        scope="me"
        limits={MEMBER_LIMITS}
        timeZone="Asia/Seoul"
      />,
    );
    expect(tableRows(getByRole).map((row) => row.slice(0, 3))).toEqual([
      ...STATIC_MEMBER_ROWS.map((row) => row.slice(0, 3)),
      ["세션 비용", "세션마다 셉니다", "$25.00"],
      ["세션 토큰", "세션마다 셉니다", "2,000,000"],
      ["대기 메시지", "세션마다 셉니다", "20건"],
      ["턴 시간", "세션마다 셉니다", "1시간 0분"],
    ]);
    expect(tableRows(getByRole).slice(0, 3)).toEqual(STATIC_MEMBER_ROWS);
    expect(
      [
        ...getByRole("table", { name: "한도" }).querySelectorAll(
          '[aria-hidden="true"]',
        ),
      ]
        .filter((el) => el.textContent === "—")
        .map((el) => el.nextElementSibling?.className),
    ).toEqual(["sr-only", "sr-only"]);
    expect(queryByText("실행 용량") === null).toBe(true);
    expect(queryAllByRole("meter")).toHaveLength(0);
    expect(document.body.textContent).toContain(
      "내 세션에 적용됩니다 · 오후 9:40 기준",
    );
    expect(document.body.textContent).not.toContain("/");
  });

  test('scope="me": 읽는 동안에도 정적 행은 보이고 받을 값 칸만 skeleton이다', () => {
    const { getByRole, getAllByRole } = withPlatform(
      <InstallationLimits scope="me" limits={undefined} />,
    );
    expect(tableRows(getByRole).slice(0, 3)).toEqual(STATIC_MEMBER_ROWS);
    // The value cell holds a decorative skeleton and no value yet; the one
    // status below is what a screen reader hears.
    const pending = [
      ...getByRole("table", { name: "한도" }).querySelectorAll("[role=row]"),
    ]
      .slice(4)
      .map((row) => {
        const cells = row.querySelectorAll("[role=cell]");
        return [
          cells[1]?.textContent,
          cells[2]?.querySelector(".werft-skeleton") !== null,
          cells[2]?.textContent,
        ];
      });
    expect(pending).toEqual([
      ["세션마다 셉니다", true, ""],
      ["세션마다 셉니다", true, ""],
      ["세션마다 셉니다", true, ""],
      ["세션마다 셉니다", true, ""],
    ]);
    expect(getAllByRole("status").map((s) => s.textContent)).toEqual([
      "한도를 읽는 중",
    ]);
  });

  test('scope="me": 읽기 실패는 받은 오류 하나만 한도 제목 아래에 보인다', () => {
    const { queryByRole, getByText } = withPlatform(
      <InstallationLimits
        scope="me"
        limits={undefined}
        error={<p>읽지 못했습니다</p>}
      />,
    );
    expect(getByText("읽지 못했습니다")).toBeTruthy();
    expect(queryByRole("table") === null).toBe(true);
    expect(queryByRole("heading", { name: "한도" }) === null).toBe(false);
  });
});

describe("UsageKpis", () => {
  const BUCKETS = [
    {
      date: "2026-10-22",
      session_count: 150,
      cost_usd: "400.00",
      cost_complete: true,
      token_count: 18160000,
      run_seconds: 100000,
      conversation_cost_usd: "0",
      conversation_cost_complete: true,
    },
    {
      date: "2026-10-23",
      session_count: 250,
      cost_usd: "645.48",
      cost_complete: true,
      token_count: 20000000,
      run_seconds: 130580,
      conversation_cost_usd: "0",
      conversation_cost_complete: true,
    },
  ];

  test("버킷 합을 locale 단위로 쓰고 카드마다 자기 필드의 스파크라인을 둔다", () => {
    const { getAllByRole, queryByText } = withPlatform(
      <UsageKpis buckets={BUCKETS} />,
    );
    const text = document.body.textContent ?? "";
    for (const value of ["400", "64시간 3분", "$1,045.48", "3,816만"]) {
      expect(text).toContain(value);
    }
    expect(
      getAllByRole("img").map((img) => img.getAttribute("aria-label")),
    ).toEqual([
      "일자별 세션 수",
      "일자별 실행 시간",
      "일자별 비용",
      "일자별 토큰",
    ]);
    // The design's stacked cards at 390 keep no empty lines under the cost.
    expect(queryByText(/실제보다 적을 수 있음/)).toBeNull();
  });

  test("cost_complete=false인 날이 하나라도 있으면 비용 카드가 적을 수 있다고 말한다", () => {
    const { getByText } = withPlatform(
      <UsageKpis
        buckets={BUCKETS.map((b, i) => ({ ...b, cost_complete: i === 0 }))}
      />,
    );
    expect(
      getByText(/실제보다 적을 수 있음/).closest("[aria-hidden=true]"),
    ).toBeNull();
  });

  test("1센트에 못 미치는 비용은 $0.00이 아니라 <$0.01로 쓴다", () => {
    withPlatform(
      <UsageKpis
        buckets={BUCKETS.map((b) => ({ ...b, cost_usd: "0.000063" }))}
      />,
    );
    expect(document.body.textContent).toContain("<$0.01");
    expect(document.body.textContent).not.toContain("$0.00");
  });

  test("대화 비용이 있으면 비용 카드가 둘을 더해 쓰고 세션·대화로 나눠 적는다", () => {
    withPlatform(
      <UsageKpis
        buckets={BUCKETS.map((b, i) => ({
          ...b,
          conversation_cost_usd: i === 0 ? "4.52" : "0",
        }))}
      />,
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("$1,050.00");
    expect(text).toContain("세션 $1,045.48 · 대화 $4.52");
    expect(text).not.toContain("실제보다 적을 수 있음");
  });

  test("단가 미상 호출이 있으면 금액은 그대로 두고, 건수·토큰과 금액을 알 수 없다는 말을 따로 적는다", () => {
    withPlatform(
      <UsageKpis
        buckets={BUCKETS.map((b, i) => ({
          ...b,
          conversation_cost_usd: i === 0 ? "4.52" : "0",
        }))}
        unknownPrice={{ call_count: 12, token_count: 18160000 }}
      />,
    );
    const text = document.body.textContent ?? "";
    // The buckets' cost holds no amount for those calls: nothing is taken off.
    expect(text).toContain("$1,050.00");
    expect(text).toContain("세션 $1,045.48 · 대화 $4.52");
    expect(text).toContain(
      "+ 단가 미상 12건 · 토큰 1,816만. 금액을 알 수 없어 비용에 들어 있지 않습니다",
    );
  });

  test("단가 미상 호출이 없으면 비용 카드에 그 줄이 없다", () => {
    withPlatform(
      <UsageKpis
        buckets={BUCKETS}
        unknownPrice={{ call_count: 0, token_count: 0 }}
      />,
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("$1,045.48");
    expect(text).not.toContain("단가 미상");
  });

  test("대화 호출이 끝나지 않은 날이 있으면 비용 카드가 적을 수 있다고 말한다", () => {
    const { getByText } = withPlatform(
      <UsageKpis
        buckets={BUCKETS.map((b, i) => ({
          ...b,
          conversation_cost_usd: "0.10",
          conversation_cost_complete: i !== 0,
        }))}
      />,
    );
    expect(
      getByText(/실제보다 적을 수 있음/).closest("[aria-hidden=true]"),
    ).toBeNull();
  });

  test("영어는 백만 단위로 줄인다", () => {
    withPlatform(<UsageKpis buckets={BUCKETS} />, "en");
    expect(document.body.textContent).toContain("38.2M");
  });

  test("읽는 동안 값과 스파크라인 없이 한 번만 알린다", () => {
    const { queryAllByRole, getAllByRole } = withPlatform(
      <UsageKpis buckets={undefined} />,
    );
    expect(queryAllByRole("img")).toHaveLength(0);
    expect(getAllByRole("status").map((s) => s.textContent)).toEqual([
      "사용량을 읽는 중",
    ]);
  });
});

describe("UsageFilters", () => {
  test("scope가 없으면 범위 선택이 없고, 기간을 누르면 그 일수를 알린다", async () => {
    const user = await setupUser();
    const picked: number[] = [];
    const { getByRole, queryByRole } = withPlatform(
      <UsageFilters days={30} onDaysChange={(days) => picked.push(days)} />,
    );
    expect(queryByRole("group", { name: "집계 범위" })).toBeNull();
    expect(queryByRole("button", { name: "설치 전체" })).toBeNull();
    await user.click(getByRole("button", { name: "90일" }));
    expect(picked).toEqual([90]);
  });

  test("scope가 있으면 내 사용량·설치 전체를 고른다", async () => {
    const user = await setupUser();
    const picked: string[] = [];
    const { getByRole } = withPlatform(
      <UsageFilters
        scope="me"
        onScopeChange={(scope) => picked.push(scope)}
        days={30}
        onDaysChange={() => {}}
      />,
    );
    await user.click(getByRole("button", { name: "설치 전체" }));
    expect(picked).toEqual(["installation"]);
  });
});

describe("UsageCostTable", () => {
  const row = (key: string | null, label: string | null, cost: string) => ({
    key,
    label,
    session_count: 4,
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    token_count: 150,
    cost_usd: cost,
  });

  test("이름 없는 행은 에이전트 없음·호출 기록이 없는 비용으로 쓴다", () => {
    const agents = withPlatform(
      <UsageCostTable
        label="에이전트별"
        head="에이전트"
        by="agent"
        rows={[row("a1", "triage", "3.00"), row(null, null, "1.00")]}
      />,
    );
    expect(agents.getByText("에이전트 없음")).toBeTruthy();
    expect(agents.getByText("$3.00")).toBeTruthy();
    agents.unmount();
    const models = withPlatform(
      <UsageCostTable
        label="모델별"
        head="모델"
        by="model"
        rows={[row(null, null, "1.00")]}
      />,
    );
    expect(models.getByText("호출 기록이 없는 비용")).toBeTruthy();
  });

  test("세션·토큰·비용은 머리글과 셀이 함께 끝에 붙고 자릿수 폭이 같은 숫자로 쓴다", () => {
    for (const by of ["agent", "model"] as const) {
      const table = withPlatform(
        <UsageCostTable
          label="비용"
          head="이름"
          by={by}
          rows={[row("a1", "triage", "3.00")]}
        />,
      );
      const align = (element: HTMLElement) => [
        element.dataset.align,
        element.classList.contains("justify-end"),
        element.classList.contains("tabular-nums"),
      ];
      const heads = table.getAllByRole("columnheader");
      expect(heads.length).toBeGreaterThan(2);
      expect(heads.map(align)).toEqual(
        heads.map((_, i) =>
          i === 0 ? ["start", false, false] : ["end", true, true],
        ),
      );
      const cells = [
        ...(table
          .getAllByRole("row")[1]
          ?.querySelectorAll<HTMLElement>("[role=cell]") ?? []),
      ];
      expect(cells.map(align)).toEqual(heads.map(align));
      table.unmount();
    }
  });

  test("conversation이면 대화 열에 대화 비용과 판단·대화 턴·요약을, 기타는 0이 아닐 때만 쓴다", () => {
    const talk = (other: string) => ({
      call_count: 3,
      cost_usd: (0.07 + Number(other)).toFixed(6),
      cost_complete: true,
      by_class: {
        judgment_usd: "0.010000",
        turn_usd: "0.050000",
        summary_usd: "0.010000",
        other_usd: other,
      },
      by_requester: {
        person_usd: (0.06 + Number(other)).toFixed(6),
        agent_usd: "0.010000",
      },
    });
    const table = withPlatform(
      <UsageCostTable
        label="에이전트별"
        head="에이전트"
        by="agent"
        conversation
        rows={[
          { ...row("a1", "triage", "3.00"), conversation: talk("0.020000") },
          { ...row("a2", "docs", "1.00"), conversation: talk("0") },
          {
            ...row("a3", "quiet", "0.50"),
            conversation: { ...talk("0"), call_count: 0, cost_usd: "0" },
          },
        ]}
      />,
    );
    expect(
      table.getAllByRole("columnheader").map((h) => h.textContent),
    ).toEqual(["에이전트", "세션", "토큰", "대화", "비용"]);
    const cells = (i: number) =>
      [
        ...(table
          .getAllByRole("row")
          [i]?.querySelectorAll<HTMLElement>("[role=cell]") ?? []),
      ].map((cell) => cell.textContent);
    expect(cells(1)[3]).toBe(
      "$0.09판단 $0.01대화 턴 $0.05요약 $0.01기타 $0.02사람 $0.08에이전트 $0.01",
    );
    expect(cells(2)[3]).toBe(
      "$0.07판단 $0.01대화 턴 $0.05요약 $0.01사람 $0.06에이전트 $0.01",
    );
    expect(cells(3)[3]).toBe("$0.00");
    // The cost column stays the sessions'.
    expect(cells(1)[4]).toBe("$3.00");
    table.unmount();
    const plain = withPlatform(
      <UsageCostTable
        label="에이전트별"
        head="에이전트"
        by="agent"
        rows={[{ ...row("a1", "triage", "3.00"), conversation: talk("0") }]}
      />,
    );
    expect(plain.queryByText("대화")).toBeNull();
    plain.unmount();
    // The judgment line goes to the agent's M1 judgment records.
    const linked = withPlatform(
      <UsageCostTable
        label="에이전트별"
        head="에이전트"
        by="agent"
        conversation
        judgmentLink={(agentId, children) => (
          <a href={`/agents/${agentId}/slack#slack-judgments`}>{children}</a>
        )}
        rows={[{ ...row("a1", "triage", "3.00"), conversation: talk("0") }]}
      />,
    );
    expect(
      linked.getByRole("link", { name: "판단 $0.01" }).getAttribute("href"),
    ).toBe("/agents/a1/slack#slack-judgments");
    expect(linked.getAllByRole("link")).toHaveLength(1);
  });

  test("누가 시작했나: 사람·에이전트·작업 세션이 합계를 나누고, 사람 아래 사람별 줄을 둔다", () => {
    const totals = {
      session_count: 2,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      token_count: 0,
      cost_usd: "0.400000",
      conversation: {
        call_count: 4,
        cost_usd: "0.600000",
        cost_complete: true,
        by_class: {
          judgment_usd: "0.100000",
          turn_usd: "0.500000",
          summary_usd: "0",
          other_usd: "0",
        },
        by_requester: { person_usd: "0.500000", agent_usd: "0.100000" },
      },
    };
    const person = (label: string | null, usd: string) => ({
      user_id: label ? crypto.randomUUID() : null,
      label,
      call_count: 1,
      cost_usd: usd,
      cost_complete: true,
    });
    const view = withPlatform(
      <UsageInitiatorSplit
        totals={totals}
        people={[person("Alice", "0.450000"), person(null, "0.050000")]}
        sessionsLink={(children) => <a href="/sessions">{children}</a>}
      />,
    );
    const rows = view
      .getAllByRole("row")
      .map((r) =>
        [...r.querySelectorAll("[role=cell]")].map((c) => c.textContent),
      );
    expect(rows.map((cells) => [cells[0], cells[2], cells[3]])).toEqual([
      ["사람", "$0.50", "50%"],
      ["Alice", "$0.45", "45%"],
      ["사람 없는 key", "$0.05", "5%"],
      ["에이전트", "$0.10", "10%"],
      ["작업 세션", "$0.40", "40%"],
    ]);
    expect(
      view.getByRole("link", { name: "작업 세션" }).getAttribute("href"),
    ).toBe("/sessions");
    view.unmount();
    // Without people the parts stand alone.
    const bare = withPlatform(<UsageInitiatorSplit totals={totals} />);
    expect(bare.getAllByRole("row")).toHaveLength(3);
  });

  test("성과당 비용: 병합된 PR 수와 하나당 비용은 API 값 그대로, 병합된 PR이 없으면 빈 상태다", () => {
    const outcomes = {
      scope: "installation" as const,
      period: {
        since: "2026-09-25T00:00:00.000Z",
        until: "2026-10-25T00:00:00.000Z",
      },
      refreshed_at: "2026-10-24T12:40:00.000Z",
      session_count: 12,
      cost_usd: "10.000000",
      cost_complete: true,
      token_count: 1000,
      sessions_with_pr: 4,
      sessions_with_merged_pr: 3,
      pr_count: 5,
      merged_pr_count: 3,
      closed_pr_count: 1,
      cost_of_merged_sessions_usd: "6.000000",
      // Not cost_usd / merged_pr_count: the screen shows the API's figure.
      cost_per_merged_pr_usd: "2.500000",
    };
    const rows = (view: ReturnType<typeof withPlatform>) =>
      view
        .getAllByRole("row")
        .map((r) =>
          [...r.querySelectorAll("[role=cell],[role=columnheader]")].map(
            (c) => c.textContent,
          ),
        );
    const view = withPlatform(<UsageOutcomes data={outcomes} />);
    expect(view.getByRole("table", { name: "성과당 비용" })).toBeTruthy();
    expect(rows(view)).toEqual([
      ["성과", "수", "하나당 비용"],
      ["병합된 PR", "3", "$2.50"],
    ]);
    expect(
      view.getByText("나눈 비용은 작업 세션 12개의 $10.00입니다."),
    ).toBeTruthy();
    view.unmount();
    // A session whose cost is not reported yet makes the figure a floor.
    const partial = withPlatform(
      <UsageOutcomes data={{ ...outcomes, cost_complete: false }} />,
    );
    expect(
      partial.getByText(
        "나눈 비용은 작업 세션 12개의 $10.00입니다. 보고 안 된 비용이 있어 실제 비용은 더 많을 수 있습니다.",
      ),
    ).toBeTruthy();
    partial.unmount();
    const none = withPlatform(
      <UsageOutcomes
        data={{ ...outcomes, merged_pr_count: 0, cost_per_merged_pr_usd: null }}
      />,
    );
    expect(
      none.getByText("이 기간에 시작한 세션이 병합한 PR이 없습니다."),
    ).toBeTruthy();
    expect(none.queryByRole("table")).toBeNull();
    none.unmount();
    const loading = withPlatform(<UsageOutcomes data={undefined} />);
    expect(
      loading
        .getByRole("table", { name: "성과당 비용" })
        .getAttribute("aria-busy"),
    ).toBe("true");
    expect(
      loading.queryByText("이 기간에 시작한 세션이 병합한 PR이 없습니다."),
    ).toBeNull();
    loading.unmount();
    const en = withPlatform(<UsageOutcomes data={outcomes} />, "en");
    expect(rows(en)[1]).toEqual(["Merged PRs", "3", "$2.50"]);
    en.unmount();
  });

  test("빈 rows는 빈 상태, undefined는 자리 행을 placeholderRows만큼 둔다", () => {
    const empty = withPlatform(
      <UsageCostTable
        label="에이전트별"
        head="에이전트"
        by="agent"
        rows={[]}
      />,
    );
    expect(
      empty.getByText("이 기간에 비용을 쓴 에이전트가 없습니다."),
    ).toBeTruthy();
    expect(empty.queryByRole("table")).toBeNull();
    empty.unmount();
    const loading = withPlatform(
      <UsageCostTable
        label="에이전트별"
        head="에이전트"
        by="agent"
        rows={undefined}
        placeholderRows={3}
      />,
    );
    const table = loading.getByRole("table", { name: "에이전트별" });
    expect(table.getAttribute("aria-busy")).toBe("true");
    expect(loading.getAllByRole("row")).toHaveLength(4);
  });
});

describe("OperationsHead", () => {
  test("주어진 탭만 링크로 그리고 지금 탭에 aria-current=page를 단다", () => {
    const { getAllByRole } = withPlatform(
      <OperationsHead
        tabs={["overview", "limits"]}
        current="limits"
        tabLink={(tab, label) => <a href={`/operations/${tab}`}>{label}</a>}
      />,
    );
    expect(
      getAllByRole("link").map((a) => [
        a.textContent,
        a.getAttribute("aria-current"),
      ]),
    ).toEqual([
      ["개요", null],
      ["한도", "page"],
    ]);
  });

  test("아직 없는 탭은 제자리에 비활성으로 두고, 포커스하면 이유를 말한다", async () => {
    const { getAllByRole, getByRole } = withPlatform(
      <OperationsHead
        tabs={["overview", "usage", "tools", "limits"]}
        soon={["usage", "tools"]}
        current="overview"
        tabLink={(tab, label) => <a href={`/operations/${tab}`}>{label}</a>}
      />,
    );
    expect(
      getAllByRole("link").map((a) => [
        a.textContent,
        a.getAttribute("href"),
        a.getAttribute("aria-disabled"),
      ]),
    ).toEqual([
      ["개요", "/operations/overview", null],
      ["사용량", null, "true"],
      ["도구 활동", null, "true"],
      ["한도", "/operations/limits", null],
    ]);
    const usage = getByRole("link", { name: "사용량" });
    expect(usage.tabIndex).toBe(0);
    const reason = (usage.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent);
    expect(reason).toEqual(["아직 준비 중인 화면입니다."]);
    const user = await setupUser();
    await user.tab();
    await user.tab();
    expect(document.activeElement === usage).toBe(true);
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="popover-content"]')?.textContent,
      ).toBe("아직 준비 중인 화면입니다."),
    );
  });
});

describe("UsageDailyCost", () => {
  const day = (date: string, cost: string) => ({
    date,
    session_count: 1,
    cost_usd: cost,
    cost_complete: true,
    token_count: 10,
    run_seconds: 60,
    conversation_cost_usd: "0",
    conversation_cost_complete: true,
  });
  // The y ticks come before the plot and its x labels.
  const ticks = () =>
    [
      ...(document.querySelector('[data-slot="bar-chart"] .tabular-nums')
        ?.children ?? []),
    ].map((tick) => tick.textContent);

  test("비용이 $0.01보다 작아도 y축 눈금이 서로 다르다", () => {
    withPlatform(
      <UsageDailyCost
        buckets={[day("2026-10-24", "0.000084"), day("2026-10-25", "0.000336")]}
        days={2}
      />,
    );
    expect(ticks()).toEqual(["$0.0004", "$0.0003", "$0.0002", "$0.0001", "$0"]);
  });

  test("$0.01보다 작은 눈금은 유효숫자 한 자리라 축 칸에서 줄바꿈되지 않는다", () => {
    withPlatform(
      <UsageDailyCost
        buckets={[day("2026-10-24", "0.0001"), day("2026-10-25", "0.00056")]}
        days={2}
      />,
    );
    expect(ticks()).toEqual(["$0.0008", "$0.0006", "$0.0004", "$0.0002", "$0"]);
  });

  test("$0.01부터 $20 미만도 눈금이 서로 다르다", () => {
    for (const [cost, want] of [
      ["0.01", ["$0.04", "$0.03", "$0.02", "$0.01", "$0.00"]],
      ["0.03", ["$0.04", "$0.03", "$0.02", "$0.01", "$0.00"]],
      ["0.07", ["$0.08", "$0.06", "$0.04", "$0.02", "$0.00"]],
      ["5.10", ["$8.00", "$6.00", "$4.00", "$2.00", "$0.00"]],
    ] as const) {
      const { unmount } = withPlatform(
        <UsageDailyCost buckets={[day("2026-10-25", cost)]} days={1} />,
      );
      expect(ticks()).toEqual([...want]);
      unmount();
    }
  });

  test("$20 이상이면 시안처럼 $20 단위의 정수 눈금이다", () => {
    withPlatform(
      <UsageDailyCost
        buckets={[day("2026-10-24", "12.00"), day("2026-10-25", "57.10")]}
        days={2}
      />,
    );
    expect(ticks()).toEqual(["$60", "$45", "$30", "$15", "$0"]);
  });
});

describe("UsageBasis", () => {
  test("읽은 뒤에는 기준 줄이 시안처럼 텍스트 노드 하나다", () => {
    const { container } = withPlatform(
      <UsageBasis
        scope="installation"
        period={{
          since: "2026-09-24T00:00:00Z",
          until: "2026-10-24T00:00:00Z",
        }}
        refreshedAt="2026-10-23T12:40:00Z"
        timeZone="Asia/Seoul"
      />,
    );
    const line = container.querySelector("p, span, div");
    expect([...(line?.childNodes ?? [])].map((n) => n.nodeType)).toEqual([
      Node.TEXT_NODE,
    ]);
    expect(line?.textContent).toBe(
      "설치 전체 · 2026-09-24 – 2026-10-23 (UTC) · 세션의 비용·토큰·실행 시간은 세션을 시작한 날에, 대화 비용은 호출한 날에 붙습니다 · 오후 9:40에 읽은 값",
    );
  });
});

describe("OPERATIONS_MESSAGES format", () => {
  test("토큰은 ko 억·만, ja 億·万, en compact로 쓴다", () => {
    expect(OPERATIONS_MESSAGES.ko.format.tokens(123_456_789)).toBe("1.2억");
    expect(OPERATIONS_MESSAGES.ja.format.tokens(38_160_000)).toBe("3,816万");
    expect(OPERATIONS_MESSAGES.en.format.tokens(9_999)).toBe("9,999");
  });
});
