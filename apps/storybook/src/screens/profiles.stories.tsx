import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Checkbox,
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  Input,
  KeyValueList,
  NativeSelect,
  NativeSelectOption,
  Page,
  PageBreadcrumb,
  PageBreadcrumbCurrent,
  PageBreadcrumbLink,
  Section,
  Textarea,
} from "@werft-ai/ui";
import { expect } from "storybook/test";

import { MOBILE, ScreenShell } from "./screen-kit.tsx";

/*
 * Run profiles as apps/web draws them (routes/profiles.tsx, profile-detail.tsx,
 * profile-new.tsx, profile-ceiling-form.tsx): one list of profiles, a
 * profile's detail with its record, and the dedicated creation page. Every
 * value is a field of GET /v1/profiles or GET /v1/installation-profiles/options.
 */

type View =
  | "list"
  | "detail"
  | "detailNewTools"
  | "newCeiling"
  | "newVersion"
  | "newWorkspace"
  | "refused";
type Role = "owner" | "admin";

type Row = {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly base: string;
  readonly model: string;
  readonly mode: string;
  /** `deny.length`; null when no catalog lists the runtime version. */
  readonly blocked: number | null;
  readonly state: readonly [string, "green" | "red" | "gray"];
};

// tool_catalogs[] of GET /v1/installation-profiles/options: the pinned build's.
const CATALOG = "claude_agent_sdk@0.3.270+claude-code@2.1.270";
const CATALOG_TOOLS = [
  ["Read", "local"],
  ["Edit", "local"],
  ["Write", "local"],
  ["Glob", "local"],
  ["Grep", "local"],
  ["NotebookEdit", "local"],
  ["Bash", "local"],
  ["AskUserQuestion", "local"],
  ["WebFetch", "egress"],
  ["WebSearch", "provider"],
] as const;

const BOUNDARY = {
  local: ["worker 안", "gray"],
  egress: ["외부 접속", "blue"],
  provider: ["provider 쪽", "amber"],
} as const;

type Tool = {
  readonly name: string;
  readonly boundary?: keyof typeof BOUNDARY;
  readonly blocked: boolean;
  readonly fixed?: boolean;
  readonly fresh?: boolean;
};

/** routes/tool-names.tsx DenyChecklist: a ticked box blocks the tool. */
function ToolChecklist({
  tools,
  catalog,
  base,
  provider,
}: {
  readonly tools: readonly Tool[];
  readonly catalog?: string;
  /** A workspace form's bound: its base, as it cannot read the catalogs. */
  readonly base?: string;
  readonly provider: boolean;
}) {
  return (
    <FieldSet className="gap-3">
      <FieldLegend variant="label" className="mb-2">
        차단할 내장 도구
      </FieldLegend>
      <FieldDescription>
        체크한 도구는 이 프로필의 세션에서 돌지 않습니다. 내장 도구만 다룹니다.
        MCP 도구는 에이전트의 MCP 설정이 정합니다.
      </FieldDescription>
      <FieldDescription>
        {base === undefined
          ? `아무것도 체크하지 않으면 제한 없음입니다. 다만 플랫폼이 지원하는 내장 도구 카탈로그(${catalog}) 안에서입니다.`
          : `아무것도 더 체크하지 않으면 바탕 프로필 ${base}가 막지 않은 도구를 모두 씁니다. 그 범위는 플랫폼이 지원하는 내장 도구 카탈로그 안입니다.`}
      </FieldDescription>
      {provider ? (
        <FieldDescription className="nth-last-2:mt-0">
          provider 쪽 도구는 모델 공급자 쪽에서 돌아 외부 접속 proxy가 막지
          못합니다. 첫 버전은 이 도구를 차단한 채 시작합니다.
        </FieldDescription>
      ) : null}
      {tools.map((tool) => (
        <Field key={tool.name} orientation="horizontal">
          <Checkbox defaultChecked={tool.blocked} disabled={tool.fixed} />
          <FieldContent>
            <FieldLabel className="font-mono">{tool.name}</FieldLabel>
            {tool.boundary || tool.fixed || tool.fresh ? (
              <FieldDescription className="flex flex-wrap items-center gap-1">
                {tool.boundary ? (
                  <Badge variant={BOUNDARY[tool.boundary][1]}>
                    {BOUNDARY[tool.boundary][0]}
                  </Badge>
                ) : null}
                {tool.fresh ? <Badge variant="blue">새 도구</Badge> : null}
                {tool.fixed ? "바탕 프로필이 막은 도구입니다." : null}
              </FieldDescription>
            ) : null}
          </FieldContent>
        </Field>
      ))}
    </FieldSet>
  );
}

const ROWS: readonly Row[] = [
  {
    id: "claude-coding",
    name: "claude-coding",
    version: 1,
    base: "—",
    model: "claude-sonnet-5",
    mode: "acceptEdits",
    blocked: 7,
    state: ["사용 가능", "green"],
  },
  {
    id: "op_wide_v2",
    name: "wide",
    version: 2,
    base: "—",
    model: "claude-sonnet-5",
    mode: "auto",
    blocked: 1,
    state: ["사용 가능", "green"],
  },
  {
    id: "op_free_v1",
    name: "free",
    version: 1,
    base: "—",
    model: "claude-sonnet-5",
    mode: "bypassPermissions",
    blocked: null,
    state: ["이 설치에서 꺼짐", "red"],
  },
  {
    id: "op_strict_v3",
    name: "strict",
    version: 3,
    base: "op_wide_v2",
    model: "claude-sonnet-5",
    mode: "default",
    blocked: 4,
    state: ["사용 가능", "green"],
  },
];

const COLUMNS = [
  "minmax(0,1.6fr) 64px minmax(0,1fr) minmax(0,1fr) 128px 72px 152px",
  "minmax(0,1fr) 128px",
] as const;

function Crumbs({ current }: { readonly current: string }) {
  return (
    <PageBreadcrumb label="위치">
      <PageBreadcrumbLink href="#profiles">프로필</PageBreadcrumbLink>
      <PageBreadcrumbCurrent>{current}</PageBreadcrumbCurrent>
    </PageBreadcrumb>
  );
}

function List() {
  return (
    <Page
      title="프로필"
      description="에이전트가 쓸 모델과 도구를 정합니다. 소유자는 연결과 실행 방식까지 정하고, 관리자는 기존 프로필을 복제해 모델·지시·막을 도구를 정합니다."
      actions={<Button>프로필 만들기</Button>}
    >
      <div className="flex flex-col gap-[var(--werft-space-block)]">
        <div className="rounded-card border bg-card">
          <GridTable
            aria-label="프로필"
            columns={COLUMNS[0]}
            narrowAt={860}
            narrowColumns={COLUMNS[1]}
          >
            <GridTableHeader>
              <GridTableColumnHeader>이름</GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>버전</GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>
                바탕 프로필
              </GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>
                기본 모델
              </GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>
                권한 모드
              </GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>차단</GridTableColumnHeader>
              <GridTableColumnHeader>상태</GridTableColumnHeader>
            </GridTableHeader>
            {ROWS.map((row) => (
              <GridTableRow key={row.id}>
                <GridTableCell>
                  <div className="flex min-w-0 flex-col gap-[var(--werft-row-line-gap)]">
                    <div className="wrap-anywhere font-medium leading-5">
                      {row.name}
                    </div>
                    <div className="wrap-anywhere font-mono text-caption text-muted-foreground leading-4">
                      {row.id}
                    </div>
                    <div className="hidden wrap-anywhere text-caption text-muted-foreground leading-4 [@container(max-width:860px)]:block">
                      v{row.version}
                    </div>
                  </div>
                </GridTableCell>
                <GridTableCell hideNarrow>v{row.version}</GridTableCell>
                <GridTableCell hideNarrow>{row.base}</GridTableCell>
                <GridTableCell hideNarrow>{row.model}</GridTableCell>
                <GridTableCell hideNarrow>{row.mode}</GridTableCell>
                <GridTableCell hideNarrow>
                  {row.blocked === null ? "—" : `${row.blocked}개`}
                </GridTableCell>
                <GridTableCell>
                  <Badge variant={row.state[1]}>{row.state[0]}</Badge>
                </GridTableCell>
              </GridTableRow>
            ))}
          </GridTable>
        </div>
      </div>
    </Page>
  );
}

const badges = (names: readonly string[]) => (
  <div className="flex flex-wrap gap-1">
    {names.map((name) => (
      <Badge key={name} variant="mono">
        {name}
      </Badge>
    ))}
  </div>
);

function Detail({
  role,
  newTools,
}: {
  readonly role: Role;
  /** On an older build's catalog: a tool the current one added is blocked. */
  readonly newTools: boolean;
}) {
  const running = CATALOG_TOOLS.map(([name]) => name).filter(
    (name) => name !== "WebSearch" && !(newTools && name === "AskUserQuestion"),
  );
  return (
    <Page
      breadcrumb={<Crumbs current="op_wide_v2" />}
      title="wide"
      titleAside={<Badge variant="green">사용 가능</Badge>}
      description="저장한 버전은 바뀌지 않고, 고치면 새 버전이 됩니다. 이전 버전을 쓰던 릴리스는 그대로 동작합니다."
      actions={
        <div className="flex flex-wrap gap-2">
          <Button variant="outline">이 프로필을 복제해 만들기</Button>
          {role === "owner" ? (
            <>
              <Button>새 버전</Button>
              <Button variant="outline">사용 중지</Button>
            </>
          ) : null}
        </div>
      }
    >
      {newTools && role === "owner" ? (
        <Alert variant="amber">
          <AlertTitle>이 버전에서 막힌 새 도구 1개</AlertTitle>
          <AlertDescription>
            이 버전이 차단 여부를 정한 적 없는 도구라 돌지 않습니다:
            AskUserQuestion. 열려면 지원 카탈로그 {CATALOG}로 새 버전을 만들어
            받아들입니다.{" "}
            <a
              className="font-medium underline underline-offset-4"
              href="#new-version"
            >
              새 버전 만들기
            </a>
          </AlertDescription>
        </Alert>
      ) : null}
      <Section title="설정">
        <div className="rounded-card border bg-card p-4">
          <KeyValueList
            items={[
              { id: "id", label: "id", value: "op_wide_v2" },
              { id: "connection", label: "연결", value: "anthropic" },
              {
                id: "runtime",
                label: "런타임",
                value: `claude_agent_sdk ${newTools ? "0.3.260" : "0.3.270"}`,
              },
              { id: "model", label: "기본 모델", value: "claude-sonnet-5" },
              {
                id: "models",
                label: "고를 수 있는 모델",
                value: (
                  <div className="flex flex-wrap gap-1">
                    <Badge variant="mono">claude-sonnet-5</Badge>
                    <Badge variant="mono">claude-haiku-5</Badge>
                  </div>
                ),
              },
              { id: "title", label: "제목 모델", value: "claude-haiku-5" },
              {
                id: "deny",
                label: "차단한 도구",
                value: badges(["WebSearch"]),
              },
              { id: "tools", label: "실행하는 도구", value: badges(running) },
              { id: "mode", label: "권한 모드", value: "auto" },
              { id: "repository", label: "저장소", value: "저장소 필요" },
              { id: "repositories", label: "허용할 저장소", value: "platform" },
              { id: "billing", label: "비용", value: "비용 집계" },
              {
                id: "claude-md",
                label: "저장소의 CLAUDE.md 읽기",
                value: "켬",
              },
            ]}
          />
        </div>
      </Section>
      <Section title="기록">
        <div className="rounded-card border bg-card p-4">
          <KeyValueList
            items={[
              { id: "origin", label: "출처", value: "콘솔에서 만듦" },
              {
                id: "by",
                label: "만든 사람",
                value: "0b1d0c7e-1f27-4a3e-8a8e-9c1b2d3e4f50 (나)",
              },
              { id: "at", label: "만든 때", value: "2026. 10. 28. 오후 8:15" },
              { id: "previous", label: "앞 버전", value: "op_wide_v1" },
            ]}
          />
        </div>
      </Section>
    </Page>
  );
}

function NewCeiling({
  refused,
  next,
}: {
  readonly refused: boolean;
  /** wide v3 after v2, which ran on an older build's catalog. */
  readonly next: boolean;
}) {
  const tools: Tool[] = CATALOG_TOOLS.map(([name, boundary]) => ({
    name,
    boundary,
    blocked: name === "WebSearch" || (next && name === "AskUserQuestion"),
    fresh: next && name === "AskUserQuestion",
  }));
  return (
    <Page
      breadcrumb={<Crumbs current={next ? "wide 새 버전" : "프로필 만들기"} />}
      title={next ? "wide 새 버전" : "프로필 만들기"}
      description="에이전트가 쓸 모델·도구·실행 방식을 정합니다. 연결과 자격 증명은 모델 연결에서, 비용 한도는 서버 설정에서 정합니다."
    >
      <div className="flex flex-col gap-[var(--werft-space-block)]">
        <form className="flex flex-col gap-[var(--werft-space-block)] rounded-card border bg-card p-4">
          <Field>
            <FieldLabel>이름</FieldLabel>
            <Input
              defaultValue="wide"
              readOnly={next}
              aria-invalid={refused || undefined}
            />
            <FieldDescription>
              {next ? "wide v3으로 저장합니다." : "wide v1으로 저장합니다."}
            </FieldDescription>
            <FieldError>
              {refused
                ? "이 이름으로 만들 ID가 이미 있습니다. 다른 이름을 고르세요."
                : undefined}
            </FieldError>
          </Field>
          <Field className="w-auto max-w-full">
            <FieldLabel>연결</FieldLabel>
            <NativeSelect defaultValue="anthropic">
              <NativeSelectOption value="anthropic">
                anthropic (anthropic · 비용 집계)
              </NativeSelectOption>
              <NativeSelectOption value="local">
                local (litellm · 비용 집계 안 함)
              </NativeSelectOption>
            </NativeSelect>
            <FieldDescription>
              모델 공급자와 자격 증명은 연결이 정합니다. 연결은 모델 연결에서
              바꿉니다.
            </FieldDescription>
          </Field>
          <div className="flex flex-wrap gap-4">
            <Field className="w-auto max-w-full">
              <FieldLabel>런타임</FieldLabel>
              <NativeSelect defaultValue="claude_agent_sdk">
                <NativeSelectOption value="claude_agent_sdk">
                  claude_agent_sdk
                </NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field className="w-auto max-w-full">
              <FieldLabel>런타임 버전</FieldLabel>
              <Input className="font-mono" defaultValue="0.3.270" />
            </Field>
          </div>
          <Field>
            <FieldLabel>모델</FieldLabel>
            <Textarea
              className="font-mono"
              rows={3}
              defaultValue={"claude-sonnet-5\nclaude-haiku-5"}
            />
            <FieldDescription>
              한 줄에 모델 하나씩 적습니다. 세션은 이 가운데에서 모델을
              고릅니다.
            </FieldDescription>
          </Field>
          <ToolChecklist tools={tools} catalog={CATALOG} provider />
          {next ? (
            <FieldSet className="gap-3 rounded-card border bg-muted/40 p-3">
              <FieldLegend variant="label" className="mb-0">
                카탈로그 차이
              </FieldLegend>
              <FieldDescription>
                op_wide_v2에 없던 도구는 차단한 채 시작합니다. 열려면
                받아들이기를 체크하고 위 목록에서 체크를 풉니다.
              </FieldDescription>
              <Field orientation="horizontal">
                <Checkbox />
                <FieldContent>
                  <FieldLabel>AskUserQuestion 실행을 받아들이기</FieldLabel>
                  <FieldDescription>지금은 차단돼 있습니다.</FieldDescription>
                </FieldContent>
              </Field>
            </FieldSet>
          ) : null}
          <Field className="w-auto max-w-full">
            <FieldLabel>권한 모드</FieldLabel>
            <NativeSelect defaultValue="auto">
              <NativeSelectOption value="default">default</NativeSelectOption>
              <NativeSelectOption value="acceptEdits">
                acceptEdits
              </NativeSelectOption>
              <NativeSelectOption value="plan">plan</NativeSelectOption>
              <NativeSelectOption value="auto">auto</NativeSelectOption>
              <NativeSelectOption value="bypassPermissions" disabled>
                bypassPermissions
              </NativeSelectOption>
            </NativeSelect>
            <FieldDescription>
              이 설치는 PLATFORM_ALLOW_UNATTENDED_PERMISSIONS가 꺼져 있어
              bypassPermissions를 고를 수 없습니다.
            </FieldDescription>
          </Field>
          <FieldSet className="gap-3">
            <FieldLegend variant="label" className="mb-2">
              허용할 저장소
            </FieldLegend>
            <FieldDescription className="nth-last-2:mt-0">
              이 프로필의 세션과 릴리스가 쓸 수 있는 저장소입니다.
            </FieldDescription>
            <Field orientation="horizontal">
              <Checkbox />
              <FieldContent>
                <FieldLabel className="font-mono">docs</FieldLabel>
              </FieldContent>
            </Field>
            <Field orientation="horizontal">
              <Checkbox defaultChecked />
              <FieldContent>
                <FieldLabel className="font-mono">platform</FieldLabel>
              </FieldContent>
            </Field>
          </FieldSet>
          {refused ? (
            <Alert variant="red" role="alert">
              <AlertDescription>
                이 이름의 최신 버전은 op_wide_v2입니다. 새 버전은 최신 버전에서
                만듭니다.
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <FieldDescription>
              저장한 버전은 바뀌지 않습니다. 고치려면 새 버전을 만듭니다.
            </FieldDescription>
            <div className="flex gap-2">
              <Button variant="outline">취소</Button>
              <Button>저장</Button>
            </div>
          </div>
        </form>
      </div>
    </Page>
  );
}

function NewWorkspace() {
  return (
    <Page
      breadcrumb={<Crumbs current="프로필 만들기" />}
      title="프로필 만들기"
      description="바탕 프로필에서 모델·도구를 줄이거나 권한 모드를 더 엄격하게만 바꿀 수 있습니다."
    >
      <div className="flex flex-col gap-[var(--werft-space-block)]">
        <form className="flex flex-col gap-[var(--werft-space-block)] rounded-card border bg-card p-4">
          <Field className="w-auto max-w-full">
            <FieldLabel>바탕 프로필</FieldLabel>
            <NativeSelect defaultValue="op_wide_v2">
              <NativeSelectOption value="claude-coding">
                claude-coding
              </NativeSelectOption>
              <NativeSelectOption value="op_wide_v2">
                op_wide_v2
              </NativeSelectOption>
              <NativeSelectOption value="op_free_v1" disabled>
                op_free_v1 · 이 설치에서 꺼짐
              </NativeSelectOption>
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel>이름</FieldLabel>
            <Input defaultValue="strict" />
            <FieldDescription>저장할 버전의 id: op_strict_v4</FieldDescription>
          </Field>
          <FieldSet className="gap-3">
            <FieldLegend variant="label" className="mb-2">
              모델
            </FieldLegend>
            <FieldDescription className="nth-last-2:mt-0">
              세션이 고를 수 있는 모델입니다. 바탕 프로필에 있는 모델만
              고릅니다.
            </FieldDescription>
            <Field orientation="horizontal">
              <Checkbox defaultChecked />
              <FieldContent>
                <FieldLabel className="font-mono">claude-sonnet-5</FieldLabel>
              </FieldContent>
            </Field>
          </FieldSet>
          {/* The base's tools, then what it blocks: no boundaries without the options. */}
          <ToolChecklist
            tools={[
              ...CATALOG_TOOLS.filter(([name]) => name !== "WebSearch").map(
                ([name]) => ({ name, blocked: false }),
              ),
              { name: "WebSearch", blocked: true, fixed: true },
            ]}
            base="op_wide_v2"
            provider={false}
          />
          <FieldSet className="gap-2 rounded-card border bg-muted/40 p-3">
            <FieldLegend variant="label" className="mb-0">
              검토
            </FieldLegend>
            <FieldDescription>op_wide_v2와 달라진 칸입니다.</FieldDescription>
            <KeyValueList
              items={[
                {
                  id: "models",
                  label: "모델",
                  value: "claude-sonnet-5, claude-haiku-5 → claude-sonnet-5",
                },
                { id: "mode", label: "권한 모드", value: "auto → default" },
              ]}
            />
          </FieldSet>
          <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
            <Button variant="outline">취소</Button>
            <Button>저장</Button>
          </div>
        </form>
      </div>
    </Page>
  );
}

function ProfilesScreen({
  view,
  role,
}: {
  readonly view: View;
  readonly role: Role;
}) {
  return (
    <ScreenShell current="profiles" crumb={["프로필"]} role={role}>
      {view === "list" ? (
        <List />
      ) : view === "detail" || view === "detailNewTools" ? (
        <Detail role={role} newTools={view === "detailNewTools"} />
      ) : view === "newWorkspace" ? (
        <NewWorkspace />
      ) : (
        <NewCeiling refused={view === "refused"} next={view === "newVersion"} />
      )}
    </ScreenShell>
  );
}

const meta = {
  title: "Screens/Run profiles",
  component: ProfilesScreen,
  parameters: { layout: "fullscreen" },
  args: { view: "list", role: "owner" },
  argTypes: {
    view: {
      control: "inline-radio",
      options: [
        "list",
        "detail",
        "detailNewTools",
        "newCeiling",
        "newVersion",
        "newWorkspace",
        "refused",
      ],
    },
    role: { control: "inline-radio", options: ["owner", "admin"] },
  },
} satisfies Meta<typeof ProfilesScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ProfilesList: Story = { name: "Owner · list" };
export const ProfilesListAdmin: Story = {
  name: "Admin · list",
  args: { role: "admin" },
};
export const ProfilesListMobile: Story = {
  name: "Owner · list (390px)",
  globals: MOBILE,
};
export const ProfileCeilingDetail: Story = {
  name: "Owner · detail",
  args: { view: "detail" },
};
export const ProfileCeilingDetailAdmin: Story = {
  name: "Admin · detail (clone only)",
  args: { view: "detail", role: "admin" },
};
export const ProfileCeilingDetailNewTools: Story = {
  name: "Owner · detail (blocked new tools)",
  args: { view: "detailNewTools" },
};
export const ProfileCeilingDetailNewToolsDark: Story = {
  name: "Owner · detail (blocked new tools, dark)",
  args: { view: "detailNewTools" },
  globals: { theme: "dark" },
};
export const ProfileCeilingDetailNewToolsMobile: Story = {
  name: "Owner · detail (blocked new tools, 390px)",
  args: { view: "detailNewTools" },
  globals: MOBILE,
};
/** From the bottom of a label to the top of whatever follows it. */
const spaceBelow = (label: Element): number => {
  const next = label.nextElementSibling;
  if (next === null) throw new Error("nothing follows the label");
  return (
    next.getBoundingClientRect().top - label.getBoundingClientRect().bottom
  );
};

/**
 * A fieldset's flex gap skips its rendered legend, so only the legend's own
 * margin keeps a group label off what it labels. Each unboxed group label
 * sits as far above its content as the name label above its input.
 */
const groupLabelsSitLikeFieldLabels =
  (legendCount: number) =>
  async ({ canvasElement }: { readonly canvasElement: HTMLElement }) => {
    const name = [
      ...canvasElement.querySelectorAll("form [data-slot=field-label]"),
    ].find((label) => label.textContent === "이름");
    if (name === undefined) throw new Error("no name label");
    const legends = canvasElement.querySelectorAll(
      "fieldset:not(.border) > [data-slot=field-legend]",
    );
    await expect(legends.length).toBe(legendCount);
    for (const legend of legends) {
      await expect(spaceBelow(legend)).toBe(spaceBelow(name));
    }
    await expect(spaceBelow(name)).toBeGreaterThan(0);
  };

export const ProfileNewCeiling: Story = {
  name: "Owner · new profile",
  args: { view: "newCeiling" },
  // The built-in tool and allowed-repository groups.
  play: groupLabelsSitLikeFieldLabels(2),
};
export const ProfileNewCeilingVersion: Story = {
  name: "Owner · new version (catalog diff)",
  args: { view: "newVersion" },
};
export const ProfileNewCeilingVersionDark: Story = {
  name: "Owner · new version (catalog diff, dark)",
  args: { view: "newVersion" },
  globals: { theme: "dark" },
};
export const ProfileNewCeilingVersionMobile: Story = {
  name: "Owner · new version (catalog diff, 390px)",
  args: { view: "newVersion" },
  globals: MOBILE,
};
export const ProfileNewCeilingRefused: Story = {
  name: "Owner · new profile refused",
  args: { view: "refused" },
};
export const ProfileNewCeilingDark: Story = {
  name: "Owner · new profile (dark)",
  args: { view: "newCeiling" },
  globals: { theme: "dark" },
};
export const ProfileNewWorkspaceAdmin: Story = {
  name: "Admin · clone to narrow",
  args: { view: "newWorkspace", role: "admin" },
};
export const ProfileNewWorkspaceMobile: Story = {
  name: "Owner · clone to narrow (390px)",
  args: { view: "newWorkspace" },
  globals: MOBILE,
  // The model group with its one choice, and the tool group.
  play: groupLabelsSitLikeFieldLabels(2),
};
