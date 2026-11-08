import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Badge,
  Button,
  LinkTab,
  LinkTabs,
  SegmentedControl,
  SegmentedControlItem,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@werft-ai/ui";
import {
  type MouseEvent,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/*
 * Inner spacing of the small row parts, side by side and measured in the
 * browser. This page reads values; it changes none. A row whose measured
 * value differs from console v4 is a finding for the part's own ticket.
 */

type Row = {
  readonly part: string;
  readonly what: string;
  readonly measured: string;
  readonly v4: string;
};

const px = (value: number) => `${Math.round(value * 100) / 100}px`;

function box(element: Element) {
  return element.getBoundingClientRect();
}

function style(element: Element, pseudo?: string) {
  return getComputedStyle(element, pseudo);
}

// The track's padding as drawn: from its inner border edge to the items.
function trackPadding(track: Element): string {
  const outer = box(track);
  const s = style(track);
  const items = [...track.children].map(box);
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) return "—";
  const top =
    Math.min(...items.map((r) => r.top)) -
    outer.top -
    Number.parseFloat(s.borderTopWidth);
  const bottom =
    outer.bottom -
    Number.parseFloat(s.borderBottomWidth) -
    Math.max(...items.map((r) => r.bottom));
  const left = first.left - outer.left - Number.parseFloat(s.borderLeftWidth);
  const right =
    outer.right - Number.parseFloat(s.borderRightWidth) - last.right;
  return [top, right, bottom, left].map(px).join(" / ");
}

// From the end of the label's text to the count.
function labelCountGap(item: Element): string {
  const count = item.querySelector('[data-slot="item-count"]');
  const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
  let label: Text | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.trim()) {
      label = node as Text;
      break;
    }
  }
  if (!count || !label) return "—";
  const range = document.createRange();
  range.selectNodeContents(label);
  return px(box(count).left - range.getBoundingClientRect().right);
}

function gapBetween(a: Element | undefined, b: Element | undefined): string {
  return a && b ? px(box(b).left - box(a).right) : "—";
}

function sides(element: Element): string {
  const s = style(element);
  return `${s.paddingLeft} / ${s.paddingRight}`;
}

function underline(element: Element): string {
  const s = style(element, "::after");
  return `left ${s.left}, right ${s.right}, bottom ${s.bottom}, h ${s.height}, r ${s.borderTopLeftRadius}`;
}

function measure(root: HTMLElement): Row[] {
  const one = (selector: string) => root.querySelector(selector);
  const all = (selector: string) => [...root.querySelectorAll(selector)];
  const rows: Row[] = [];
  const seg = "SegmentedControl";
  for (const [index, track] of all('[data-audit="seg"]').entries()) {
    rows.push({
      part: seg,
      what: `트랙 안쪽 여백 위/오른쪽/아래/왼쪽 (${track.getAttribute("data-audit-name") ?? index})`,
      measured: trackPadding(track),
      v4: "2px / 2px / 2px / 2px",
    });
  }
  const segTrack = one('[data-audit="seg"]');
  const on = segTrack?.querySelector('[aria-pressed="true"]');
  const off = segTrack?.querySelector('[aria-pressed="false"]');
  if (segTrack && on && off) {
    rows.push(
      {
        part: seg,
        what: "트랙 테두리·모서리",
        measured: `${style(segTrack).borderTopWidth} ${style(segTrack).borderTopColor}, r ${style(segTrack).borderTopLeftRadius}`,
        v4: "1px --border, r 8px",
      },
      {
        part: seg,
        what: "선택 항목 높이 · 좌우 여백",
        measured: `${px(box(on).height)} · ${sides(on)}`,
        v4: "28px · 8px / 8px",
      },
      {
        part: seg,
        what: "비선택 항목 높이 · 좌우 여백",
        measured: `${px(box(off).height)} · ${sides(off)}`,
        v4: "28px · 8px / 8px",
      },
      {
        part: seg,
        what: "선택 배경",
        measured: style(on).backgroundColor,
        v4: "--active #ebebeb / 다크 #232323",
      },
      {
        part: seg,
        what: "글자↔개수 (선택 · 비선택)",
        measured: `${labelCountGap(on)} · ${labelCountGap(off)}`,
        v4: "8px",
      },
      {
        part: seg,
        what: "항목 사이",
        measured: gapBetween(segTrack.children[0], segTrack.children[1]),
        v4: "2px",
      },
    );
  }
  for (const [name, selector, itemSelector] of [
    ["Tabs line", '[data-audit="tabs"]', '[role="tab"]'],
    ["LinkTabs", '[data-audit="link-tabs"]', '[data-slot="link-tab"]'],
  ] as const) {
    const items = one(selector)?.querySelectorAll(itemSelector) ?? [];
    const active = [...items].find(
      (item) =>
        item.getAttribute("aria-selected") === "true" ||
        item.getAttribute("aria-current") === "page",
    );
    const idle = [...items].find((item) => item !== active);
    const counted = [...items].find((item) =>
      item.querySelector('[data-slot="item-count"]'),
    );
    if (!active || !idle) continue;
    rows.push(
      {
        part: name,
        what: "선택 · 비선택 높이",
        measured: `${px(box(active).height)} · ${px(box(idle).height)}`,
        v4: "36px · 36px",
      },
      {
        part: name,
        what: "선택 · 비선택 좌우 여백",
        measured: `${sides(active)} · ${sides(idle)}`,
        v4: "8px / 8px",
      },
      {
        part: name,
        what: "선택 · 비선택 굵기",
        measured: `${style(active).fontWeight} · ${style(idle).fontWeight}`,
        v4: "500 · 500",
      },
      {
        part: name,
        what: "탭 사이",
        measured: gapBetween(items[0], items[1]),
        v4: "4px",
      },
      {
        part: name,
        what: "글자↔개수",
        measured: counted ? labelCountGap(counted) : "—",
        v4: "8px",
      },
      {
        part: name,
        what: "선택 밑줄",
        measured: underline(active),
        v4: "left 8px, right 8px, bottom -1px, h 2px, r 1px",
      },
    );
  }
  const badges = all('[data-audit="badges"] [data-slot="badge"]');
  const badge = badges[0];
  if (badge) {
    rows.push(
      {
        part: "Badge",
        what: "높이 · 좌우 여백",
        measured: `${px(box(badge).height)} · ${sides(badge)}`,
        v4: "20px · 8px / 8px",
      },
      {
        part: "Badge",
        what: "글자 크기·굵기",
        measured: `${style(badge).fontSize} ${style(badge).fontWeight}`,
        v4: "12px 500",
      },
    );
  }
  const chips = all('[data-audit="chips"] [data-slot="badge"]');
  rows.push({
    part: "칩 줄",
    what: "칩 사이",
    measured: gapBetween(chips[0], chips[1]),
    v4: "4px (.chip-list)",
  });
  const buttons = all('[data-audit="buttons"] [data-slot="button"]');
  const [sm, regular] = [buttons[0], buttons[2]];
  rows.push({
    part: "버튼 묶음",
    what: "버튼 사이",
    measured: gapBetween(buttons[0], buttons[1]),
    v4: "8px (.toolbar)",
  });
  if (sm && regular) {
    rows.push(
      {
        part: "버튼 묶음",
        what: "sm 높이 · 좌우 여백",
        measured: `${px(box(sm).height)} · ${sides(sm)}`,
        v4: "28px · 8px / 8px",
      },
      {
        part: "버튼 묶음",
        what: "default 높이 · 좌우 여백",
        measured: `${px(box(regular).height)} · ${sides(regular)}`,
        v4: "32px · 12px / 12px",
      },
    );
  }
  return rows;
}

const STATUSES = [
  { id: "all", label: "전체", count: 128 },
  { id: "running", label: "실행 중", count: 3 },
  { id: "needs_input", label: "답변 대기", count: 0 },
  { id: "ended", label: "끝남" },
] as const;

function StatusSeg({
  initial,
  name,
  counts = true,
}: {
  readonly initial: string;
  readonly name: string;
  readonly counts?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <SegmentedControl
      aria-label={`세션 상태 (${name})`}
      value={value}
      onValueChange={setValue}
      data-audit="seg"
      data-audit-name={name}
    >
      {STATUSES.map((status) => (
        <SegmentedControlItem
          key={status.id}
          value={status.id}
          count={counts && "count" in status ? status.count : undefined}
        >
          {status.label}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}

function Specimen({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="m-0 font-medium text-caption text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

function SpacingAudit() {
  const root = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [current, setCurrent] = useState("running");
  const go = (id: string) => (event: MouseEvent) => {
    event.preventDefault();
    setCurrent(id);
  };
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const update = () => setRows(measure(element));
    update();
    // Fonts and the theme switch change the boxes after the first paint.
    void document.fonts.ready.then(update);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    const themes = new MutationObserver(update);
    themes.observe(document.documentElement, { attributes: true });
    element.addEventListener("click", update);
    return () => {
      observer.disconnect();
      themes.disconnect();
      element.removeEventListener("click", update);
    };
  }, []);
  return (
    <div ref={root} className="flex min-w-0 flex-col gap-6">
      <Specimen title="SegmentedControl — 개수 있음, 선택 처음 · 가운데 · 끝">
        <div className="flex flex-col items-start gap-2">
          <StatusSeg initial="all" name="선택 처음" />
          <StatusSeg initial="running" name="선택 가운데" />
          <StatusSeg initial="ended" name="선택 끝" />
        </div>
      </Specimen>
      <Specimen title="SegmentedControl — 개수 없음">
        <div className="flex">
          <StatusSeg initial="running" name="개수 없음" counts={false} />
        </div>
      </Specimen>
      <Specimen title="Tabs line">
        <Tabs defaultValue="timeline">
          <div className="border-b">
            <TabsList variant="line" aria-label="세션 보기" data-audit="tabs">
              <TabsTrigger value="timeline">타임라인</TabsTrigger>
              <TabsTrigger value="artifacts" count={4}>
                성과물
              </TabsTrigger>
              <TabsTrigger value="info">정보</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="timeline">이벤트 목록</TabsContent>
          <TabsContent value="artifacts">성과물 목록</TabsContent>
          <TabsContent value="info">세션 정보</TabsContent>
        </Tabs>
      </Specimen>
      <Specimen title="LinkTabs">
        <LinkTabs aria-label="세션 상태 링크" data-audit="link-tabs">
          {STATUSES.map((status) => (
            <LinkTab
              key={status.id}
              href={`#${status.id}`}
              current={current === status.id}
              count={"count" in status ? status.count : undefined}
              onClick={go(status.id)}
            >
              {status.label}
            </LinkTab>
          ))}
        </LinkTabs>
      </Specimen>
      <Specimen title="Badge — 기본 · tone · 개수">
        <div className="flex flex-wrap items-center gap-2" data-audit="badges">
          <Badge>기본</Badge>
          <Badge variant="blue">진행</Badge>
          <Badge variant="green">완료</Badge>
          <Badge variant="amber">대기</Badge>
          <Badge variant="red">실패</Badge>
          <Badge>12</Badge>
        </div>
      </Specimen>
      <Specimen title="칩 줄 (v4 .chip-list gap 4)">
        <div className="flex flex-wrap gap-1" data-audit="chips">
          <Badge>github</Badge>
          <Badge>slack</Badge>
          <Badge>linear</Badge>
          <Badge>notion</Badge>
        </div>
      </Specimen>
      <Specimen title="버튼 묶음 (v4 .toolbar gap 8)">
        <div className="flex flex-wrap items-center gap-2" data-audit="buttons">
          <Button size="sm" variant="outline">
            새로고침
          </Button>
          <Button size="sm">새 세션</Button>
          <Button variant="outline">세션 목록</Button>
          <Button>새 세션</Button>
        </div>
      </Specimen>
      <table className="w-full border-collapse text-caption">
        <caption className="mb-2 text-left font-medium text-body">
          측정값과 v4
        </caption>
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th scope="col" className="py-1 pr-3 font-medium">
              부품
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              잰 것
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              측정
            </th>
            <th scope="col" className="py-1 font-medium">
              v4
            </th>
          </tr>
        </thead>
        <tbody data-audit="results">
          {rows.map((row) => (
            <tr key={`${row.part}-${row.what}`} className="border-b align-top">
              <td className="py-1 pr-3">{row.part}</td>
              <td className="py-1 pr-3">{row.what}</td>
              <td className="py-1 pr-3 tabular-nums [overflow-wrap:anywhere]">
                {row.measured}
              </td>
              <td className="py-1 [overflow-wrap:anywhere]">{row.v4}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const meta = {
  title: "Foundations/Spacing audit",
  render: () => <SpacingAudit />,
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Dark: Story = {
  name: "Default (dark)",
  globals: { theme: "dark" },
};

export const Mobile: Story = {
  name: "Default (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

export const MobileDark: Story = {
  name: "Default (390px, dark)",
  globals: {
    theme: "dark",
    viewport: { value: "mobile390", isRotated: false },
  },
};
