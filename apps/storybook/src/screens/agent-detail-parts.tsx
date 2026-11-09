import type {
  AgentDetail,
  AgentRelease,
  SessionSummary,
} from "@werft-ai/contracts";
import {
  OPERATIONS_MESSAGES,
  SessionRowOpener,
  SessionStatusLabel,
  StatusLabel,
} from "@werft-ai/react/components";
import {
  Avatar,
  avatarInitials,
  avatarTone,
  Badge,
  Button,
  buttonVariants,
  Card,
  Code,
  CodeBlock,
  CopyButton,
  cn,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  ErrorState,
  Field,
  FieldLabel,
  formatTimestamp,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  Heading,
  KeyValueList,
  MoreLink,
  NativeSelect,
  NativeSelectOption,
  Page,
  RelativeTime,
  RowLines,
  RowList,
  RowListItem,
  Section,
  Skeleton,
  StatCard,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Text,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@werft-ai/ui";
import { ArrowLeft, Check, ChevronRight } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { VIEWER } from "./screen-kit.tsx";

/*
 * apps/web routes/agent-detail.tsx and its overview and card tab
 * (agent-detail/overview.tsx, version-history.tsx), shared with the GitHub
 * tab's story. Words are apps/web's Korean catalog.
 */

/** A Text that takes its parent's type, where the route had a bare span. */
export const INHERIT = "text-[length:inherit] leading-[inherit] text-inherit";
/** The page title's type, which a Text inside the h1 would otherwise reset. */
const TITLE = "font-semibold text-foreground text-title leading-7";

/** The release fields the screen reads; the rest are runtime snapshots. */
export type ReleaseFixture = Pick<
  AgentRelease,
  "id" | "version_id" | "label" | "runtime_profile_id" | "repository_id"
>;
export type DetailFixture = Pick<AgentDetail, "agent" | "versions"> & {
  readonly releases: readonly ReleaseFixture[];
  readonly active_release: ReleaseFixture | null;
};

/** An earlier card: role and instructions, never applied. */
const LEGACY_CARD: AgentDetail["versions"][number]["card"] = {
  role: "결제 문의 담당",
  instructions:
    "결제 실패·환불 문의를 받아 원인을 찾고, 필요한 경우 담당자에게 넘긴다.",
  language: "ko",
  model: "claude-sonnet-5",
  capabilities: {
    mcp: [{ server: "billing-db" }],
    forbidden: [],
    credential_refs: ["BILLING_DB"],
  },
  rules: [],
};

/** Edited in 상세 설정: the earlier fields ride along on the base. */
const CARD: AgentDetail["versions"][number]["card"] = { ...LEGACY_CARD };

const AGENT_ID = "9b1c2d3e-4f5a-4b6c-8d7e-0f1a2b3c4d5e";

const VERSIONS: AgentDetail["versions"] = [
  {
    id: "7c1e2d3f-4a5b-4c6d-8e9f-0a1b2c3d4e51",
    agent_id: AGENT_ID,
    version_no: 1,
    card: {
      ...LEGACY_CARD,
      capabilities: { ...LEGACY_CARD.capabilities, mcp: null },
    },
    content_sha256: "1".repeat(64),
    created_by: VIEWER.id,
    created_at: "2026-10-20T05:00:00Z",
  },
  {
    id: "7c1e2d3f-4a5b-4c6d-8e9f-0a1b2c3d4e52",
    agent_id: AGENT_ID,
    version_no: 2,
    card: CARD,
    content_sha256: "2".repeat(64),
    created_by: VIEWER.id,
    created_at: "2026-10-22T05:00:00Z",
  },
];

export const RELEASE: ReleaseFixture = {
  id: "sha256:9f2c4e6a8b0d1f3e5a7c9b1d3f5e7a9c0b2d4f6e8a1c3e5f7b9d0a2c4e6f8b1d",
  version_id: "7c1e2d3f-4a5b-4c6d-8e9f-0a1b2c3d4e52",
  label: "2026-10-22_14:00:00",
  runtime_profile_id: "claude-coding",
  repository_id: "werft-sandbox",
};

export const RELEASED: DetailFixture = {
  agent: {
    id: AGENT_ID,
    workspace_id: "3a9d5e7f-1b2c-4d3e-9f40-5a6b7c8d9e0f",
    slug: "billing",
    name: "결제 담당",
    // Copied from the earlier card's role when descriptions came in.
    description: "결제 문의 담당",
    managing_team_id: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
    managing_team_name: "재무",
    status: "active",
    active_release_id: RELEASE.id,
    activation_revision: 1,
    created_by: VIEWER.id,
    created_at: "2026-10-20T05:00:00Z",
    updated_at: "2026-10-22T05:00:00Z",
  },
  versions: VERSIONS,
  releases: [RELEASE],
  active_release: RELEASE,
};

export const DRAFT: DetailFixture = {
  ...RELEASED,
  agent: {
    ...RELEASED.agent,
    active_release_id: null,
    activation_revision: -1,
  },
  releases: [],
  active_release: null,
};

const latestVersion = (detail: DetailFixture) =>
  detail.versions.reduce<AgentDetail["versions"][number] | undefined>(
    (latest, version) =>
      latest && latest.version_no > version.version_no ? latest : version,
    undefined,
  );

const activeVersion = (detail: DetailFixture) =>
  detail.versions.find(
    (version) => version.id === detail.active_release?.version_id,
  );

export const AGENT_TABS = [
  ["overview", "개요"],
  ["card", "상세 설정"],
  ["release", "릴리스"],
  ["access", "접근"],
  ["admins", "관리자"],
  ["slack", "Slack"],
  ["github", "GitHub"],
] as const;
export type AgentTab = (typeof AGENT_TABS)[number][0];

const STATE = {
  draft: { variant: "blue", label: "초안" },
  active: { variant: "green", label: "릴리스" },
  paused: { variant: "amber", label: "일시정지" },
  archived: { variant: "gray", label: "보관됨" },
} as const;

/** components/agent-state.tsx AgentStateBadge. */
function AgentStateBadge({
  agent,
}: {
  readonly agent: DetailFixture["agent"];
}) {
  const state =
    agent.status === "archived"
      ? "archived"
      : agent.active_release_id === null
        ? "draft"
        : agent.status;
  return (
    <Badge
      variant={STATE[state].variant}
      data-state={state}
      className={state === "archived" ? "text-muted-foreground" : undefined}
    >
      {STATE[state].label}
    </Badge>
  );
}

function NewSessionButton({
  reason,
  repository,
}: {
  readonly reason: string | undefined;
  readonly repository: string | null | undefined;
}) {
  const label = "이 에이전트로 새 세션";
  const fieldId = useId();
  if (reason !== undefined) {
    return (
      <Tooltip>
        <TooltipTrigger asChild={true}>
          <button
            type="button"
            aria-disabled={true}
            className={cn(buttonVariants(), "aria-disabled:cursor-not-allowed")}
          >
            {label}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">{reason}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Dialog>
      <DialogTrigger asChild={true}>
        <Button type="button">{label}</Button>
      </DialogTrigger>
      <DialogContent>
        <form className="grid min-w-0 gap-4">
          <DialogHeader>
            <DialogTitle>새 세션 시작</DialogTitle>
            <DialogDescription>
              활성 릴리스로 세션을 시작하고 세션 화면으로 이동합니다.
            </DialogDescription>
          </DialogHeader>
          <Text variant="sub" className="wrap-anywhere">
            저장소:{" "}
            {repository ? (
              <Code className="wrap-anywhere">{repository}</Code>
            ) : (
              "저장소 없음"
            )}
          </Text>
          <Field>
            <FieldLabel htmlFor={fieldId}>첫 메시지</FieldLabel>
            <Textarea id={fieldId} rows={5} />
          </Field>
          <DialogFooter>
            <DialogClose asChild={true}>
              <Button type="button" variant="outline">
                취소
              </Button>
            </DialogClose>
            <Button type="button">세션 시작</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The agent page: its head, the six tabs, and the open tab's panel. */
export function AgentPage({
  detail,
  tab,
  notice,
  children,
}: {
  readonly detail: DetailFixture;
  readonly tab: AgentTab;
  readonly notice?: ReactNode;
  readonly children: ReactNode;
}) {
  const { agent } = detail;
  const description = agent.description ?? latestVersion(detail)?.card.role;
  const newSessionReason =
    agent.active_release_id === null
      ? "활성 릴리스가 없어 세션을 시작할 수 없습니다. 릴리스를 활성화하면 시작할 수 있습니다."
      : undefined;
  return (
    <Page
      stackBelow="lg"
      title={
        <Text
          as="span"
          className={cn("flex min-w-0 items-center gap-3", TITLE)}
        >
          <Avatar
            size="lg"
            shape="square"
            tone={avatarTone(agent.name)}
            initials={avatarInitials(agent.name)}
          />
          <Text
            as="span"
            className={cn("min-w-0 [overflow-wrap:anywhere]", TITLE)}
          >
            {agent.name}
          </Text>
        </Text>
      }
      titleAside={<AgentStateBadge agent={agent} />}
      description={
        description ? (
          <Text as="span" className={cn(INHERIT, "[overflow-wrap:anywhere]")}>
            {description}
          </Text>
        ) : undefined
      }
      actions={
        <div className="flex flex-1 flex-wrap items-start gap-2">
          <NewSessionButton
            reason={newSessionReason}
            repository={detail.active_release?.repository_id}
          />
          <a
            href="#agents"
            className={buttonVariants({
              variant: "outline",
              className: "ms-auto",
            })}
          >
            <ArrowLeft strokeWidth={1.5} aria-hidden="true" />
            에이전트 목록
          </a>
        </div>
      }
    >
      {newSessionReason === undefined ? null : (
        <Text variant="sub">{newSessionReason}</Text>
      )}
      {notice}
      <Tabs value={tab} className="min-w-0 gap-[var(--werft-space-block)]">
        <div className="border-b">
          <TabsList variant="line" aria-label="에이전트 상세">
            {AGENT_TABS.map(([name, label]) => (
              <TabsTrigger key={name} value={name}>
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {/* The route keeps every panel mounted and hides the others. */}
        {AGENT_TABS.map(([name]) => (
          <TabsContent
            key={name}
            value={name}
            forceMount={true}
            hidden={name !== tab}
            tabIndex={name === tab ? 0 : -1}
            className="@container flex flex-col gap-8 pt-2"
          >
            {name === tab ? children : null}
          </TabsContent>
        ))}
      </Tabs>
    </Page>
  );
}

/** routes/agent-detail.tsx AgentNotFound: one page for 403 and 404. */
export function AgentNotFound() {
  return (
    <Page
      title="에이전트를 찾을 수 없습니다"
      description="지워졌거나, 주소가 틀렸거나, 볼 수 없는 에이전트입니다."
    >
      <a
        href="#agents"
        className={buttonVariants({
          variant: "outline",
          className: "self-start",
        })}
      >
        에이전트 목록으로
      </a>
    </Page>
  );
}

/** Who reads the figures: counts need agent.manage, cost the owner. */
export type Viewer = "owner" | "admin" | "member";

function Figure({
  label,
  badge,
  value,
  note,
}: {
  readonly label: string;
  readonly badge?: ReactNode;
  readonly value: string | { readonly missing: string };
  readonly note: string;
}) {
  const missing = typeof value === "object" ? value.missing : null;
  return (
    <li className="min-w-0">
      <StatCard
        className="h-full"
        label={label}
        badge={badge}
        value={
          typeof value === "object" ? <div aria-hidden="true">—</div> : value
        }
        muted={missing !== null}
        description={missing ?? note}
      />
    </li>
  );
}

/** overview.tsx AgentGlance and WeekCost. */
export function AgentGlance({ viewer }: { readonly viewer: Viewer }) {
  const lists = viewer !== "member";
  const count = (value: number) =>
    lists ? String(value) : { missing: "소유자와 관리자만 볼 수 있음" };
  return (
    <ul
      aria-label="에이전트 현황"
      className="m-0 grid list-none grid-cols-1 items-stretch gap-4 p-0 @[720px]:grid-flow-col @[720px]:auto-cols-fr @[720px]:grid-cols-none"
    >
      <Figure label="답변 대기" value={count(1)} note="담당자가 답할 요청" />
      <Figure label="작업 중" value={count(2)} note="지금 실행 중인 세션" />
      <Figure
        label="최근 7일 비용"
        badge={<Badge variant="gray">추정</Badge>}
        value={
          viewer === "owner"
            ? OPERATIONS_MESSAGES.ko.format.usd("3.42")
            : { missing: "소유자만 볼 수 있음" }
        }
        note="제공업체 청구액과 다를 수 있음"
      />
    </ul>
  );
}

/** overview.tsx AgentReadiness: credentials, a release, the activation. */
export function AgentReadiness({
  detail,
  bound,
}: {
  readonly detail: DetailFixture;
  /**
   * Credential names with a live binding, or "unknown" when the bindings
   * read was refused (a member without credential.bind gets a 403).
   */
  readonly bound: readonly string[] | "unknown";
}) {
  const latest = latestVersion(detail);
  const active = activeVersion(detail);
  const refs = [
    ...new Set([
      ...(latest?.card.capabilities.credential_refs ?? []),
      ...(active?.card.capabilities.credential_refs ?? []),
    ]),
  ];
  const missing =
    bound === "unknown" ? [] : refs.filter((ref) => !bound.includes(ref));
  const released = detail.releases.length > 0;
  const upToDate =
    detail.agent.active_release_id !== null &&
    latest !== undefined &&
    active !== undefined &&
    latest.id === active.id;
  const runnable = detail.agent.status === "active";
  const steps = [
    {
      key: "credentials",
      title: "자격 증명 연결",
      state:
        refs.length > 0 && bound === "unknown"
          ? "unknown"
          : missing.length === 0
            ? "done"
            : "todo",
      desc:
        refs.length === 0
          ? "이 카드는 자격 증명이 필요 없습니다."
          : bound === "unknown"
            ? "연결 상태를 불러오지 못했습니다."
            : missing.length === 0
              ? `필요한 ${refs.length}개를 모두 연결했습니다.`
              : `연결이 필요합니다: ${missing.join(", ")}`,
    },
    {
      key: "release",
      title: "릴리스 만들기",
      state: released ? "done" : "todo",
      desc: released
        ? `릴리스 ${detail.releases.length}개가 있습니다.`
        : "릴리스 탭에서 버전과 프로필로 릴리스를 만듭니다.",
    },
    {
      key: "activate",
      title: "활성화",
      state: upToDate && runnable ? "done" : "todo",
      desc:
        detail.agent.active_release_id === null
          ? "아직 켜지지 않았습니다. 릴리스 탭에서 릴리스를 만들고 활성화하면 새 세션이 이 에이전트를 씁니다."
          : latest && active && latest.id !== active.id
            ? `최신 버전 ${latest.version_no}은(는) 아직 쓰이지 않습니다. 새 세션은 버전 ${active.version_no}(으)로 시작합니다.`
            : "새 세션은 최신 버전으로 시작합니다.",
    },
  ] as const;
  const firstOpen = steps.findIndex((step) => step.state === "todo");
  const ready = firstOpen === -1 && steps[0].state === "done";
  return (
    <Section
      className="min-w-0"
      title="켜기까지"
      actions={
        <Badge variant={ready ? "green" : "amber"}>
          {ready ? "켜짐" : "할 일 있음"}
        </Badge>
      }
    >
      <Card className="gap-0 p-4">
        <ol className="m-0 flex list-none flex-col p-0">
          {steps.map((step, index) => (
            <li
              key={step.key}
              data-state={step.state}
              className="flex min-w-0 items-center gap-3 border-t py-3 first:border-t-0 first:pt-0 last:pb-0"
            >
              <Text
                as="span"
                aria-hidden="true"
                className={cn(
                  "grid size-6 flex-none place-items-center rounded-full border font-semibold text-caption",
                  step.state === "done"
                    ? "border-[var(--werft-tone-success-border)] bg-[var(--werft-tone-success-bg)] text-[var(--werft-tone-success-fg)]"
                    : "border-[var(--werft-color-border-strong)] text-muted-foreground",
                )}
              >
                {step.state === "done" ? (
                  <Check className="size-3.5" />
                ) : (
                  index + 1
                )}
              </Text>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <Text as="span" weight="medium">
                  {step.title}
                  <Text as="span" className="sr-only">
                    {step.state === "done"
                      ? " (완료)"
                      : step.state === "todo"
                        ? " (할 일)"
                        : ""}
                  </Text>
                </Text>
                <Text as="span" variant="meta">
                  {step.desc}
                </Text>
              </div>
              {index === firstOpen ? (
                <Button type="button" variant="outline" className="self-start">
                  릴리스 탭으로
                </Button>
              ) : null}
            </li>
          ))}
        </ol>
      </Card>
    </Section>
  );
}

export type SessionFixture = Pick<
  SessionSummary,
  | "id"
  | "title"
  | "status"
  | "admission_state"
  | "agent"
  | "last_event_at"
  | "created_at"
>;

const SESSION_STATUS = {
  queued: "대기 중",
  running: "작업 중",
  needs_input: "답변 대기",
  idle: "쉬는 중",
  failed: "실패",
  stopped: "멈춤",
} as const satisfies Record<SessionSummary["status"], string>;
const ADMISSION = {
  active: "열림",
  pausing: "일시정지 중",
  paused: "일시정지됨",
  resuming: "복원 중",
  stopping: "종료 중",
  stopped: "종료됨",
  recovery_required: "복구 필요",
  closing: "보관 중",
  closed: "보관됨",
} as const satisfies Record<SessionSummary["admission_state"], string>;

export const SESSIONS: readonly SessionFixture[] = [
  {
    id: "d82440c2-6a1b-4c3d-8e5f-7a9b0c1d2e3f",
    title: "환불 요청 #4821 원인 확인",
    status: "needs_input",
    admission_state: "active",
    agent: {
      id: AGENT_ID,
      name: "결제 담당",
      release_version_no: 2,
      release_label: RELEASE.label,
      release_is_active: true,
    },
    last_event_at: "2026-11-02T01:40:00Z",
    created_at: "2026-11-02T01:10:00Z",
  },
  {
    id: "5f3a9c71-2b4d-4e6f-9a8b-1c2d3e4f5a6b",
    title: null,
    status: "idle",
    admission_state: "paused",
    agent: {
      id: AGENT_ID,
      name: "결제 담당",
      release_version_no: 2,
      release_label: RELEASE.label,
      release_is_active: true,
    },
    last_event_at: null,
    created_at: "2026-11-01T08:00:00Z",
  },
];

const RECENT_COLUMNS = "minmax(0,2fr) 136px 120px minmax(0,1fr) 96px";
const RECENT_NARROW_COLUMNS = "minmax(0,1fr) 116px 72px";

/** overview.tsx AgentRecentSessions. */
export function AgentRecentSessions({
  sessions,
}: {
  readonly sessions: readonly SessionFixture[] | "loading" | "error";
}) {
  return (
    <Section
      className="min-w-0"
      title="최근 세션"
      actions={
        <MoreLink href="#sessions" size="control">
          모든 세션
        </MoreLink>
      }
    >
      {sessions === "error" ? (
        <LoadFailure />
      ) : sessions === "loading" ? (
        <Card className="px-4 py-3">
          <Skeleton lines={3} label="불러오는 중입니다" />
        </Card>
      ) : sessions.length === 0 ? (
        <Card className="px-4 py-6 text-center text-control text-muted-foreground">
          이 에이전트로 만든 세션 중 볼 수 있는 세션이 없습니다.
        </Card>
      ) : (
        <div className="rounded-card border bg-card">
          <GridTable
            aria-label="최근 세션"
            columns={RECENT_COLUMNS}
            narrowAt={640}
            narrowColumns={RECENT_NARROW_COLUMNS}
          >
            <GridTableHeader>
              <GridTableColumnHeader>세션</GridTableColumnHeader>
              <GridTableColumnHeader>작업 상태</GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow={true}>
                세션 상태
              </GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow={true}>
                릴리스
              </GridTableColumnHeader>
              <GridTableColumnHeader align="end">
                최근 이벤트
              </GridTableColumnHeader>
            </GridTableHeader>
            {sessions.map((session) => (
              <AgentSessionRow key={session.id} session={session} />
            ))}
          </GridTable>
        </div>
      )}
    </Section>
  );
}

function AgentSessionRow({ session }: { readonly session: SessionFixture }) {
  const shortId = session.id.slice(0, 8);
  return (
    <GridTableRow data-status={session.status}>
      <GridTableCell lines={true}>
        <SessionRowOpener
          name={`세션 열기: ${session.title ?? shortId}`}
          title={session.id}
          renderLink={(link) => (
            <a href={`#sessions/${session.id}`} {...link} />
          )}
        />
        <Text
          as="span"
          className="max-w-full truncate font-medium text-link"
          title={session.title ?? session.id}
        >
          {session.title ?? shortId}
        </Text>
        {session.title ? (
          <Code className="text-muted-foreground">{shortId}</Code>
        ) : null}
      </GridTableCell>
      <GridTableCell>
        <SessionStatusLabel
          status={session.status}
          label={SESSION_STATUS[session.status]}
          axisLabel="작업 상태"
        />
      </GridTableCell>
      <GridTableCell hideNarrow={true}>
        <StatusLabel
          className="whitespace-nowrap"
          axis="admission"
          state={session.admission_state}
          label={ADMISSION[session.admission_state]}
          axisLabel="세션 상태"
        />
      </GridTableCell>
      <GridTableCell hideNarrow={true} className="text-muted-foreground">
        <Text as="span" className="sr-only">
          릴리스:{" "}
        </Text>
        {session.agent
          ? (session.agent.release_label ??
            `버전 ${session.agent.release_version_no}`)
          : "없음"}
      </GridTableCell>
      <GridTableCell
        align="end"
        className="overflow-hidden whitespace-nowrap text-caption text-muted-foreground"
      >
        <Text as="span" className="sr-only">
          {session.last_event_at ? "최근 이벤트" : "만든 시각"}{" "}
        </Text>
        <RelativeTime
          value={session.last_event_at ?? session.created_at}
          locale="ko"
          className="relative truncate focus-visible:-outline-offset-2!"
        />
      </GridTableCell>
    </GridTableRow>
  );
}

/** components/load-failure.tsx for a read that failed with no known code. */
export function LoadFailure() {
  return (
    <ErrorState
      title="불러오지 못했습니다"
      message="처리하지 못했습니다 — 잠시 뒤 다시 시도하세요."
      retry={() => undefined}
      retryLabel="다시 시도"
    />
  );
}

/** The overview tab's three parts, in the route's order. */
export function AgentOverview({
  detail,
  viewer,
  bound,
  sessions,
}: {
  readonly detail: DetailFixture;
  readonly viewer: Viewer;
  readonly bound: readonly string[] | "unknown";
  readonly sessions: readonly SessionFixture[] | "loading" | "error";
}) {
  return (
    <>
      <AgentGlance viewer={viewer} />
      <AgentReadiness detail={detail} bound={bound} />
      <AgentRecentSessions sessions={sessions} />
    </>
  );
}

const IDS = {
  summary: "agent-card-summary",
  raw: "agent-card-raw",
  versions: "agent-versions",
} as const;

const VALUE = "min-w-0 [overflow-wrap:anywhere]";

function Names({ items }: { readonly items: readonly string[] }) {
  if (items.length === 0) return "없음";
  return (
    <Text as="span" className={cn(INHERIT, "inline-flex flex-wrap gap-1")}>
      {items.map((item) => (
        <Badge key={item} variant="gray" className="font-mono font-normal">
          {item}
        </Badge>
      ))}
    </Text>
  );
}

function Value({
  mono,
  clamp,
  children,
}: {
  readonly mono?: boolean;
  readonly clamp?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <Text
      as="span"
      className={cn(
        VALUE,
        INHERIT,
        mono && "font-mono",
        clamp && "line-clamp-3",
      )}
    >
      {children}
    </Text>
  );
}

/** overview.tsx CardSummary: the card in words, and as sent. */
export function CardSummary({
  detail,
  manages = true,
}: {
  readonly detail: DetailFixture;
  readonly manages?: boolean;
}) {
  const version = activeVersion(detail) ?? latestVersion(detail);
  const card = version?.card;
  const live =
    version !== undefined && version.id === activeVersion(detail)?.id;
  const released =
    version !== undefined &&
    detail.releases.some((release) => release.version_id === version.id);
  const raw = card ? JSON.stringify(card, null, 2) : "";
  return (
    <div className="grid grid-cols-1 items-stretch gap-4 @[720px]:grid-cols-2">
      <Card
        role="region"
        className="min-w-0 px-4"
        aria-labelledby={IDS.summary}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <Heading id={IDS.summary}>에이전트 카드</Heading>
            <Text as="span" variant="meta">
              {!version
                ? "없음"
                : !live
                  ? released
                    ? "릴리스는 만들었지만 아직 켜지 않은 버전입니다. 읽기 전용."
                    : "아직 릴리스를 만들지 않은 최신 버전입니다. 읽기 전용."
                  : "새 세션에 쓰이는 버전입니다. 읽기 전용."}
            </Text>
          </div>
          <div className="flex flex-none items-center gap-2">
            {version ? (
              <Badge variant="gray" className="font-mono font-normal">
                v{version.version_no}
              </Badge>
            ) : null}
            {manages ? (
              <Button type="button" variant="outline" size="sm">
                상세 설정 편집
              </Button>
            ) : null}
          </div>
        </div>
        {card ? (
          <KeyValueList
            variant="grid"
            stack="sm"
            items={[
              { label: "이름", value: <Value>{detail.agent.name}</Value> },
              {
                label: "식별자",
                value: <Value mono={true}>{detail.agent.slug}</Value>,
              },
              {
                label: "설명",
                value: detail.agent.description ? (
                  <Value clamp={true}>{detail.agent.description}</Value>
                ) : (
                  "없음"
                ),
              },
              {
                label: "자격 증명",
                value: (
                  <Names items={card.capabilities.credential_refs ?? []} />
                ),
              },
              {
                label: "MCP",
                value: (
                  <Names
                    items={(card.capabilities.mcp ?? []).map((s) => s.server)}
                  />
                ),
              },
              { label: "모델", value: <Value mono={true}>{card.model}</Value> },
              { label: "답변 언어", value: <Value>한국어</Value> },
            ]}
          />
        ) : null}
      </Card>
      {card ? (
        <Card role="region" className="min-w-0 px-4" aria-labelledby={IDS.raw}>
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 flex-col gap-0.5">
              <Heading id={IDS.raw}>카드 원문</Heading>
              <Text as="span" variant="meta">
                {live
                  ? "릴리스된 버전 기준 · 읽기 전용"
                  : "최신 버전 기준 · 읽기 전용"}
              </Text>
            </div>
            <CopyButton
              value={raw}
              variant="outline"
              size="sm"
              label="복사"
              copiedLabel="복사했습니다"
              iconClassName="size-3.5"
            />
          </div>
          <CodeBlock className="flex-1 overflow-auto">{raw}</CodeBlock>
        </Card>
      ) : null}
    </div>
  );
}

/** version-history.tsx, folded as the card tab opens it. */
export function VersionHistory({ detail }: { readonly detail: DetailFixture }) {
  const ordered = [...detail.versions].sort(
    (a, b) => b.version_no - a.version_no,
  );
  const activeId = detail.active_release?.version_id;
  const [beforeId, setBeforeId] = useState(
    (activeId && activeId !== ordered[0]?.id ? activeId : ordered[1]?.id) ?? "",
  );
  const [afterId, setAfterId] = useState(ordered[0]?.id ?? "");
  const before = ordered.find((version) => version.id === beforeId);
  const after = ordered.find((version) => version.id === afterId);
  return (
    <details
      className="group flex flex-col gap-[var(--werft-space-block)]"
      aria-labelledby={IDS.versions}
    >
      <summary className="flex min-h-7 cursor-pointer list-none items-center gap-2 rounded-control [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="size-4 text-muted-foreground transition-transform group-open:rotate-90"
        />
        <Heading id={IDS.versions}>버전 기록</Heading>
        <Text as="span" variant="meta">
          {ordered.length}
        </Text>
      </summary>
      <RowList>
        {ordered.map((version) => (
          <RowListItem key={version.id}>
            <RowLines>
              <Text
                as="span"
                className="block break-words font-semibold text-body"
              >
                버전 {version.version_no}
              </Text>
              <Text
                as="span"
                variant="meta"
                className="block [overflow-wrap:anywhere]"
              >
                {formatTimestamp(version.created_at, "ko")}
                {version.id === activeId ? " · 활성" : ""}
              </Text>
            </RowLines>
          </RowListItem>
        ))}
      </RowList>
      {ordered.length > 1 ? (
        <div className="flex flex-wrap items-start gap-3">
          {(
            [
              ["비교 기준", beforeId, setBeforeId],
              ["비교 대상", afterId, setAfterId],
            ] as const
          ).map(([label, value, setValue]) => (
            <Field key={label} className="w-auto">
              <FieldLabel>{label}</FieldLabel>
              <NativeSelect
                value={value}
                onChange={(event) => setValue(event.target.value)}
              >
                {ordered.map((version) => (
                  <NativeSelectOption key={version.id} value={version.id}>
                    버전 {version.version_no}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          ))}
        </div>
      ) : null}
      {ordered.length > 1 && before && after ? (
        <RevisionDiff
          before={before.card}
          after={after.card}
          beforeLabel={`버전 ${before.version_no}`}
          afterLabel={`버전 ${after.version_no}`}
        />
      ) : null}
    </details>
  );
}

type DiffLine = {
  readonly kind: "same" | "added" | "removed";
  readonly text: string;
};

function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const width = b.length + 1;
  const lcs = new Int32Array((a.length + 1) * width);
  const at = (i: number, j: number) => lcs[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? at(i + 1, j + 1) + 1
          : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const left = a[i];
    const right = b[j];
    if (left !== undefined && left === right) {
      lines.push({ kind: "same", text: left });
      i++;
      j++;
    } else if (
      left !== undefined &&
      (right === undefined || at(i + 1, j) >= at(i, j + 1))
    ) {
      lines.push({ kind: "removed", text: left });
      i++;
    } else {
      lines.push({ kind: "added", text: right ?? "" });
      j++;
    }
  }
  return lines;
}

const MARK = { same: " ", added: "+", removed: "-" } as const;
const LINE = {
  same: "block",
  added: "block bg-[var(--werft-tone-progress-bg)]",
  removed: "block bg-[var(--werft-tone-danger-bg)] line-through",
} as const;

/** Stand-in for apps/web components/revision-diff.tsx, same markup. */
function RevisionDiff({
  before,
  after,
  beforeLabel,
  afterLabel,
}: {
  readonly before: unknown;
  readonly after: unknown;
  readonly beforeLabel: string;
  readonly afterLabel: string;
}) {
  const lines = diffLines(
    JSON.stringify(before, null, 2),
    JSON.stringify(after, null, 2),
  );
  const changed = lines.some((line) => line.kind !== "same");
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-2">
      <figcaption className="text-muted-foreground text-sm">
        {beforeLabel} → {afterLabel}
      </figcaption>
      {changed ? (
        <pre className="m-0 overflow-x-auto rounded-card border p-3 font-mono text-xs">
          {lines.map((line, index) => (
            <Text
              as="span"
              // biome-ignore lint/suspicious/noArrayIndexKey: lines repeat; position is their identity
              key={index}
              className={cn(INHERIT, LINE[line.kind])}
              data-kind={line.kind}
            >
              <Text
                as="span"
                className={cn(INHERIT, "inline-block w-[1.5ch]")}
                aria-hidden="true"
              >
                {MARK[line.kind]}
              </Text>
              {line.kind === "same" ? null : (
                <Text as="span" className="sr-only">
                  {line.kind === "added" ? "추가: " : "삭제: "}
                </Text>
              )}
              {line.text}
              {"\n"}
            </Text>
          ))}
        </pre>
      ) : (
        <Text variant="sub">두 버전의 카드가 같습니다.</Text>
      )}
    </figure>
  );
}
