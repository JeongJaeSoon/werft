import type { Meta, StoryObj } from "@storybook/react-vite";
import type {
  AgentGitHub,
  AgentGitHubResponse,
  ListAgentGitHubRepositoriesResponse,
  Receipt,
} from "@werft-ai/contracts";
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Code,
  cn,
  DangerZone,
  DangerZoneRow,
  Field,
  FieldError,
  FieldLabel,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  Heading,
  IconTile,
  Input,
  Link,
  NativeSelect,
  NativeSelectOption,
  RelativeTime,
  RowAction,
  RowList,
  SettingRow,
  SettingsSection,
  SideNav,
  SideNavGroup,
  SideNavLayout,
  SideNavLink,
  Skeleton,
  Switch,
  Text,
} from "@werft-ai/ui";
import { Plus } from "lucide-react";
import { expect } from "storybook/test";

import { AgentPage, DRAFT, RELEASE, RELEASED } from "./agent-detail-parts.tsx";
import { MOBILE, ScreenShell } from "./screen-kit.tsx";

/*
 * apps/web routes/agent-detail/github.tsx (with github-repositories.tsx,
 * github-pull-request.tsx and installed-repositories.tsx) inside the agent
 * page, laid out like the workspace's Integrations > GitHub: GET
 * /v1/agents/{id}/github, its activity, and the App repositories to pick.
 */

type Feature = "review" | "actions" | "workflows";
type AllowEntry = AgentGitHub["actions_allow"][number];
type ActivityReceipt = Pick<
  Receipt,
  "id" | "operation" | "status" | "result" | "created_at"
>;

const FEATURES: readonly Feature[] = ["review", "actions", "workflows"];
const FEATURE_TITLE: Record<Feature, string> = {
  review: "리뷰 승인",
  actions: "Actions 실행",
  workflows: "워크플로 파일 수정",
};
const FEATURE_HINT: Record<Feature, string> = {
  review:
    "리뷰용 App으로 PR에 승인 리뷰를 남깁니다. 권장 권한이면 GitHub는 이 승인을 필수 리뷰로 세지 않으므로, 브랜치 규칙이 리뷰를 요구하면 쓰기 권한이 있는 사람의 승인처럼 GitHub가 인정하는 승인이 따로 필요합니다. 필요한 권한: 리뷰용 App의 pull requests 쓰기",
  actions:
    "허용 목록의 워크플로만 실행(workflow_dispatch)하거나 다시 실행합니다. 필요한 권한: actions 쓰기",
  workflows:
    ".github/workflows 아래 파일을 바꾼 commit도 push합니다. 필요한 권한: workflows 쓰기",
};
type FeatureReason = NonNullable<
  AgentGitHubResponse["options"]["features"][Feature]["reason"]
>;
const FEATURE_REASON: Record<FeatureReason, string> = {
  app_permission_missing:
    "App에 이 권한이 없습니다. GitHub App 설정에서 더한 뒤 설치를 다시 승인하세요.",
  over_workspace_ceiling:
    "워크스페이스 상한 밖입니다. 소유자·관리자가 연동 > GitHub에서 켭니다.",
  no_reviewer_app:
    "워크스페이스에 리뷰용 App이 없습니다. PR을 만드는 App은 자기 PR을 승인할 수 없습니다.",
  github_host_unsupported:
    "고른 저장소가 모두 GitHub Enterprise에 있어 기본 작업만 할 수 있습니다.",
};
type RepositoryReason = NonNullable<
  AgentGitHubResponse["options"]["repositories"][number]["reason"]
>;
const REPOSITORY_REASON: Record<RepositoryReason, string> = {
  repository_not_allowed: "워크스페이스가 허용한 저장소 범위 밖입니다.",
  app_required:
    "PAT로 연결된 저장소라 권한을 좁힐 수 없습니다. GitHub App으로 옮겨야 고를 수 있습니다.",
};
const ACTIVITY_TITLE: Partial<Record<Receipt["operation"], string>> = {
  create_agent_release: "GitHub 설정을 바꾼 릴리스",
  activate_agent: "GitHub 설정을 바꾼 활성화",
  set_agent_github: "GitHub 설정 저장",
  mint_github_token: "토큰 발급",
  dispatch_workflow: "워크플로 실행",
  rerun_workflow: "워크플로 다시 실행",
  review_pull_request: "리뷰",
};
const ACTIVITY_FAILED: Partial<Record<Receipt["operation"], string>> = {
  mint_github_token: "토큰 거절",
  dispatch_workflow: "워크플로 실행 거절",
  rerun_workflow: "다시 실행 거절",
  review_pull_request: "리뷰 거절",
};
const PURPOSE: Record<string, string> = {
  clone: "clone",
  push: "push",
  pull_request: "PR",
  dispatch: "워크플로 실행",
};
const REFUSAL: Record<string, string> = {
  workflow_not_allowed: "허용 목록 밖",
  repository_not_allowed: "저장소 범위 밖",
  ambiguous_app: "App 선택 필요",
  pinned_app_removed: "고정된 App 삭제됨",
};

// github.tsx SECTION: the workspace's Integrations > GitHub names and order,
// then what only an agent has.
const SECTION_LABEL = {
  overview: "GitHub",
  repositories: "에이전트가 쓰는 저장소",
  features: "에이전트가 쓸 수 있는 기능",
  "pull-request": "Pull request",
  push: "push 승인",
  activity: "최근 기록",
  danger: "위험 구역",
} as const;
type SectionKey = keyof typeof SECTION_LABEL;
const sectionId = (key: SectionKey) => `github-${key}`;
const MANAGE_KEYS: readonly SectionKey[] = ["activity", "danger"];
const FOCUS_TARGET = "scroll-mt-4 outline-none";
const ALLOW_COLUMNS = "minmax(0,1fr) minmax(0,1fr) 88px";
const ALLOW_NARROW = "minmax(0,1fr) 88px";
const WIDE_ONLY_480 = "[@container(min-width:480px)]:hidden";

const SETTINGS: AgentGitHub = {
  repositories: ["werft-sandbox"],
  push_approval: true,
  features: {
    review: true,
    actions: true,
    workflows: false,
    checks: false,
    issues: false,
  },
  actions_allow: [{ workflow: "ci.yml" }],
};

const OPEN = { available: true, reason: null } as const;
const DATA: AgentGitHubResponse = {
  enabled: true,
  active_release_id: RELEASE.id,
  github: SETTINGS,
  settings_revision: 3,
  push_attached: "ask",
  start_repository_id: null,
  legacy_defaults: null,
  options: {
    repository_ceiling_unset: false,
    repositories: [
      {
        id: "werft-sandbox",
        url: "https://github.com/JeongJaeSoon/werft-sandbox",
        available: true,
        reason: null,
        installed: { author: true, reviewer: true },
      },
      {
        id: "billing-api",
        url: "https://github.com/JeongJaeSoon/billing-api",
        available: true,
        reason: null,
        installed: { author: true, reviewer: false },
      },
      {
        id: "legacy-tools",
        url: "https://github.com/JeongJaeSoon/legacy-tools",
        available: false,
        reason: "app_required",
        installed: { author: null, reviewer: null },
      },
    ],
    features: {
      review: OPEN,
      actions: OPEN,
      workflows: OPEN,
      checks: OPEN,
      issues: OPEN,
    },
  },
};

const PICK_PAGE: ListAgentGitHubRepositoriesResponse = {
  installations: [
    {
      id: 51234567,
      account: "JeongJaeSoon",
      connection_id: "6e8f0a2b-4c5d-4e6f-8a9b-0c1d2e3f4a5b",
      role: "author",
      permissions: {},
      repository_count: 2,
    },
  ],
  installation_id: 51234567,
  page: 1,
  per_page: 30,
  total_count: 2,
  repositories: [
    {
      github_repository_id: 880001,
      full_name: "JeongJaeSoon/werft-sandbox",
      default_branch: "main",
      private: false,
      catalog_id: "werft-sandbox",
    },
    {
      github_repository_id: 880002,
      full_name: "JeongJaeSoon/billing-web",
      default_branch: "main",
      private: true,
      catalog_id: null,
    },
  ],
  unavailable: null,
};

const ACTIVITY: readonly ActivityReceipt[] = [
  {
    id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c01",
    operation: "dispatch_workflow",
    status: "failed",
    result: {
      session_id: "d82440c2-6a1b-4c3d-8e5f-7a9b0c1d2e3f",
      repository_id: "werft-sandbox",
      workflow: "release.yml",
      ref: "main",
      reason_code: "workflow_not_allowed",
    },
    created_at: "2026-11-02T01:30:00Z",
  },
  {
    id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c02",
    operation: "mint_github_token",
    status: "succeeded",
    result: {
      session_id: "d82440c2-6a1b-4c3d-8e5f-7a9b0c1d2e3f",
      repository_id: "werft-sandbox",
      purpose: "push",
    },
    created_at: "2026-11-02T01:20:00Z",
  },
  {
    id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c03",
    operation: "create_agent_release",
    status: "succeeded",
    result: { release_id: RELEASE.id },
    created_at: "2026-10-22T05:00:00Z",
  },
];

const sameEntry = (a: AllowEntry, b: AllowEntry) =>
  a.workflow === b.workflow && (a.ref ?? null) === (b.ref ?? null);

/** github.tsx pendingCount: what the draft changes from the active release. */
function pendingCount(base: AgentGitHub, draft: AgentGitHub) {
  return (
    draft.repositories.filter((id) => !base.repositories.includes(id)).length +
    base.repositories.filter((id) => !draft.repositories.includes(id)).length +
    Number(base.push_approval !== draft.push_approval) +
    FEATURES.filter((f) => base.features[f] !== draft.features[f]).length +
    draft.actions_allow.filter(
      (entry) => !base.actions_allow.some((held) => sameEntry(held, entry)),
    ).length +
    base.actions_allow.filter(
      (entry) => !draft.actions_allow.some((held) => sameEntry(held, entry)),
    ).length
  );
}

function On({ on }: { readonly on: boolean }) {
  return (
    <Text as="span" variant="sub">
      {on ? "켜짐" : "꺼짐"}
    </Text>
  );
}

function SettingsLink() {
  return <Link href="#settings-workspace-github">연동 &gt; GitHub</Link>;
}

function TileMark({ className }: { readonly className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={cn(
        className,
        "fill-current text-(--werft-color-tile-foreground)",
      )}
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function ReceiptRow({ receipt }: { readonly receipt: ActivityReceipt }) {
  const result = (receipt.result ?? {}) as {
    session_id?: string;
    release_id?: string;
    repository_id?: string;
    purpose?: string;
    workflow?: string;
    ref?: string;
    reason_code?: string;
  };
  const failed = receipt.status === "failed";
  const title =
    (failed ? ACTIVITY_FAILED[receipt.operation] : undefined) ??
    ACTIVITY_TITLE[receipt.operation] ??
    receipt.operation;
  const parts = [
    result.workflow
      ? result.ref
        ? `${result.workflow} @ ${result.ref}`
        : result.workflow
      : null,
    result.repository_id ?? null,
    result.purpose && receipt.operation === "mint_github_token"
      ? (PURPOSE[result.purpose] ?? null)
      : null,
    result.reason_code ? (REFUSAL[result.reason_code] ?? null) : null,
    result.release_id === RELEASE.id ? `릴리스 ${RELEASE.label}` : null,
  ].filter((part): part is string => part !== null);
  return (
    <GridTableRow>
      <GridTableCell>
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Text as="span" weight="medium">
              {title}
            </Text>
            {failed ? <Badge variant="red">거절</Badge> : null}
          </div>
          <Text as="span" variant="sub" className="[overflow-wrap:anywhere]">
            {parts.join(" · ")}
            {result.session_id ? (
              <>
                {parts.length > 0 ? " · " : null}
                <Link href={`#sessions/${result.session_id}`}>
                  세션 <Code>{result.session_id.slice(0, 8)}</Code>
                </Link>
              </>
            ) : null}
          </Text>
        </div>
      </GridTableCell>
      <GridTableCell align="end">
        <RelativeTime
          value={receipt.created_at}
          locale="ko"
          className="text-caption text-muted-foreground"
        />
      </GridTableCell>
    </GridTableRow>
  );
}

function Activity({
  activity,
}: {
  readonly activity: readonly ActivityReceipt[];
}) {
  return (
    <div id={sectionId("activity")} tabIndex={-1} className={FOCUS_TARGET}>
      <SettingsSection
        title="최근 기록"
        description="토큰 발급과 거절, 설정 변경, 워크플로 실행은 감사 기록(receipt)에 남습니다. 볼 수 있는 세션의 기록만 보입니다."
      >
        {activity.length === 0 ? (
          <div className="rounded-card border bg-card p-4">
            <Text as="span" variant="sub">
              아직 GitHub 기록이 없습니다.
            </Text>
          </div>
        ) : (
          <GridTable
            aria-label="최근 기록"
            columns="minmax(0,1fr) 112px"
            framed
          >
            <GridTableHeader>
              <GridTableColumnHeader>기록</GridTableColumnHeader>
              <GridTableColumnHeader align="end">시각</GridTableColumnHeader>
            </GridTableHeader>
            {activity.map((receipt) => (
              <ReceiptRow key={receipt.id} receipt={receipt} />
            ))}
          </GridTable>
        )}
      </SettingsSection>
    </div>
  );
}

type TabProps = {
  readonly data: AgentGitHubResponse;
  /** Unsaved settings on top of the active release's; absent: none. */
  readonly draft?: AgentGitHub | undefined;
  /** The App installation's repositories, merged into the one table. */
  readonly pick?: ListAgentGitHubRepositoriesResponse | undefined;
  readonly activity: readonly ActivityReceipt[];
};

// What a first save starts from when the release names no repository.
const NO_REPOSITORY_DEFAULTS: AgentGitHub = {
  repositories: [],
  push_approval: false,
  features: {
    review: false,
    actions: false,
    workflows: false,
    checks: false,
    issues: false,
  },
  actions_allow: [],
};
const baseOf = (data: AgentGitHubResponse) =>
  data.github ?? data.legacy_defaults;

type RepositoryRow = {
  readonly key: string;
  readonly name: string;
  readonly private: boolean;
  readonly on: boolean;
  readonly reason: RepositoryReason | null;
  readonly appMissing: boolean;
};

/** github-repositories.tsx repositoryRows, without the switch state. */
function repositoryRows(
  data: AgentGitHubResponse,
  chosen: readonly string[],
  pick: ListAgentGitHubRepositoriesResponse | undefined,
): RepositoryRow[] {
  const rows = new Map<string, RepositoryRow>();
  for (const option of data.options.repositories) {
    const on = chosen.includes(option.id);
    rows.set(option.id, {
      key: option.id,
      name: option.url.replace("https://github.com/", ""),
      private: option.private === true,
      on,
      reason: !option.available && !on ? option.reason : null,
      appMissing: option.installed.author === false,
    });
  }
  const names = new Set([...rows.values()].map((row) => row.name));
  for (const listed of pick?.repositories ?? []) {
    if (names.has(listed.full_name)) continue;
    rows.set(`gh:${listed.github_repository_id}`, {
      key: `gh:${listed.github_repository_id}`,
      name: listed.full_name,
      private: listed.private,
      on: listed.catalog_id !== null && chosen.includes(listed.catalog_id),
      reason: null,
      appMissing: false,
    });
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function GitHubSettings({ data, draft, pick, activity }: TabProps) {
  const base = baseOf(data);
  const settings = draft ?? base;
  const readOnly = !data.enabled || base === null;
  const pending = base && draft ? pendingCount(base, draft) : 0;
  // github.tsx firstSave: the defaults alone are worth a save.
  const firstSave = !readOnly && data.github === null;
  const pendingTitle = firstSave
    ? "GitHub 설정을 아직 저장하지 않았습니다"
    : `저장하지 않은 변경 ${pending}건`;
  const chosen = (data.github ?? data.legacy_defaults)?.repositories ?? [];
  const rows = repositoryRows(data, chosen, pick);
  return (
    <>
      <section
        id={sectionId("overview")}
        tabIndex={-1}
        aria-labelledby={`${sectionId("overview")}-title`}
        className={cn(
          "flex flex-col gap-[var(--werft-space-section)]",
          FOCUS_TARGET,
        )}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-3">
            <IconTile icon={TileMark} hue="slate" size="two-line" />
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex flex-wrap items-center gap-2">
                <Heading id={`${sectionId("overview")}-title`} level={2}>
                  GitHub
                </Heading>
                <Badge variant={data.enabled ? "green" : "gray"}>
                  {data.enabled ? "사용 중" : "꺼짐"}
                </Badge>
              </div>
              <Text variant="sub">
                {base === null || data.github === null
                  ? "저장소 릴리스 설정대로"
                  : `저장소 ${data.github.repositories.length}개`}
                {" · "}push 전 승인{" "}
                {base
                  ? // github.tsx: a release without settings still asks a person.
                    data.github === null || base.push_approval
                    ? "켜짐"
                    : "꺼짐"
                  : "—"}
              </Text>
            </div>
            {data.enabled ? null : (
              <Button type="button" size="sm">
                GitHub 켜기
              </Button>
            )}
          </div>
          <Text variant="sub">
            {
              "이 에이전트가 GitHub에서 쓰는 저장소와 기능입니다. 워크스페이스가 정한 상한 안에서 고릅니다. App과 설치는 워크스페이스의 연동 > GitHub에서 관리합니다."
            }
          </Text>
          {data.enabled ? null : (
            <Text as="span" variant="sub">
              GitHub 사용이 꺼져 있어 아래 설정은 읽기만 할 수 있습니다.
            </Text>
          )}
        </div>
        {pending > 0 || firstSave ? (
          <Alert variant="blue" role="region" aria-label={pendingTitle}>
            <AlertTitle>{pendingTitle}</AlertTitle>
            <AlertDescription>
              저장하면 다음에 시작하는 세션부터 적용됩니다. 권한을 줄이는 변경은
              진행 중인 세션에도 바로 적용됩니다. 새 릴리스는 만들지 않습니다.
            </AlertDescription>
            <AlertActions>
              <Button type="button" size="sm">
                저장
              </Button>
              {draft !== undefined ? (
                <Button type="button" size="sm" variant="ghost">
                  되돌리기
                </Button>
              ) : null}
            </AlertActions>
          </Alert>
        ) : null}
        {data.github === null && base ? (
          <Alert>
            <AlertDescription>
              이 에이전트에는 저장한 GitHub 설정이 아직 없습니다. 지금은 활성
              릴리스의 설정(없으면 프로필이 허용하는 저장소 전체)으로 동작하고,
              저장하면 이후 세션부터 아래 설정을 씁니다.
            </AlertDescription>
          </Alert>
        ) : null}
        {settings ? (
          <div
            id={sectionId("repositories")}
            tabIndex={-1}
            className={FOCUS_TARGET}
          >
            <SettingsSection
              titleAs="h3"
              title="에이전트가 쓰는 저장소"
              description="이 에이전트가 쓸 GitHub 저장소를 켭니다. 켜고 끄는 즉시 저장됩니다. 켠 저장소는 새로 시작하는 세션부터 쓰고, 끈 저장소는 진행 중인 세션에서도 바로 쓸 수 없습니다. 토큰은 켠 저장소 하나로만 좁혀 발급합니다."
            >
              <GridTable
                aria-label="에이전트가 쓰는 저장소"
                columns="minmax(0,1fr) 64px"
                framed
              >
                <GridTableHeader>
                  <GridTableColumnHeader>저장소</GridTableColumnHeader>
                  <GridTableColumnHeader align="end">
                    사용
                  </GridTableColumnHeader>
                </GridTableHeader>
                {rows.map((row) => (
                  <GridTableRow key={row.key}>
                    <GridTableCell>
                      <div className="flex min-w-0 flex-col gap-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <Link
                            href={`https://github.com/${row.name}`}
                            className="font-medium [overflow-wrap:anywhere]"
                          >
                            {row.name}
                          </Link>
                          {row.private ? (
                            <Badge variant="gray">비공개</Badge>
                          ) : null}
                          {row.appMissing ? (
                            <Badge variant="amber">App 미설치</Badge>
                          ) : null}
                        </div>
                        {row.reason ? (
                          <Text as="span" variant="meta">
                            {REPOSITORY_REASON[row.reason]}
                          </Text>
                        ) : null}
                      </div>
                    </GridTableCell>
                    <GridTableCell align="end">
                      <Switch
                        aria-label={`${row.name} 사용`}
                        checked={row.on}
                        disabled={readOnly || row.reason !== null}
                      />
                    </GridTableCell>
                  </GridTableRow>
                ))}
              </GridTable>
              <Text as="span" variant="meta">
                목록에 없는 저장소는 GitHub에서 App 설치에 더하면 나타납니다.
              </Text>
            </SettingsSection>
          </div>
        ) : null}
      </section>

      {settings ? (
        <div id={sectionId("features")} tabIndex={-1} className={FOCUS_TARGET}>
          <SettingsSection
            title="에이전트가 쓸 수 있는 기능"
            description="이 에이전트가 쓰는 기능입니다. 기본은 PR 작성·수정까지입니다. 브랜치 보호·필수 리뷰·CODEOWNERS처럼 GitHub가 막는 것은 저장소 설정을 따릅니다. 머지는 이 에이전트 설정에 없고, 워크스페이스의 연동 > GitHub에서 머지를 허용했을 때만 에이전트가 PR을 머지합니다."
          >
            <RowList variant="joined">
              <SettingRow
                title="PR 작성·수정"
                badge={<Badge variant="gray">기본</Badge>}
                description="agent/<세션> 브랜치로 push하고, PR을 열고 고치고, 코멘트를 남깁니다. 필요한 권한: contents·pull requests 쓰기"
                actions={
                  <Text as="div" variant="meta">
                    항상 켜짐
                  </Text>
                }
              />
              {FEATURES.map((feature) => {
                const option = data.options.features[feature];
                const on = settings.features[feature];
                const uninstalled =
                  feature === "review" && option.available
                    ? settings.repositories.filter(
                        (id) =>
                          data.options.repositories.find(
                            (repository) => repository.id === id,
                          )?.installed.reviewer === false,
                      )
                    : [];
                return (
                  <SettingRow
                    key={feature}
                    title={FEATURE_TITLE[feature]}
                    badge={
                      uninstalled.length > 0 ? (
                        <Badge variant="amber">App 미설치</Badge>
                      ) : undefined
                    }
                    description={
                      option.reason ? (
                        <>
                          {FEATURE_REASON[option.reason]}{" "}
                          {option.reason ===
                          "github_host_unsupported" ? null : (
                            <SettingsLink />
                          )}
                        </>
                      ) : uninstalled.length > 0 ? (
                        <>
                          리뷰용 App이 설치되지 않은 저장소:{" "}
                          {uninstalled.join(", ")}. 그 저장소의 리뷰는 GitHub가
                          거절합니다. <SettingsLink />
                        </>
                      ) : (
                        FEATURE_HINT[feature]
                      )
                    }
                    status={<On on={on} />}
                    control={
                      <Switch
                        aria-label={FEATURE_TITLE[feature]}
                        checked={on}
                        disabled={readOnly || (!option.available && !on)}
                      />
                    }
                  />
                );
              })}
            </RowList>
            {settings.features.workflows && settings.features.actions ? (
              <Alert variant="amber">
                <AlertDescription>
                  워크플로 파일 수정과 Actions 실행을 같이 켜면, 에이전트가 허용
                  목록의 워크플로 파일을 자기 브랜치에서 고칠 수 있습니다.
                  사람이 그 브랜치를 머지하면 고친 파일이 실행 대상이 됩니다.
                </AlertDescription>
              </Alert>
            ) : null}
            <Text as="span" variant="meta">
              워크스페이스 상한은 소유자·관리자가 연동 &gt; GitHub에서 정합니다.{" "}
              <SettingsLink />
            </Text>
            {settings.features.actions ? (
              <SettingsSection
                titleAs="h3"
                title="Actions 허용 목록"
                description="Actions 실행이 켜져 있을 때 이 목록의 워크플로만 실행하거나 다시 실행합니다. 목록 밖의 workflow_dispatch와 다시 실행은 거절합니다."
                actions={
                  <Button
                    type="button"
                    size="sm"
                    aria-haspopup="dialog"
                    disabled={readOnly}
                  >
                    <Plus aria-hidden="true" strokeWidth={1.5} />
                    워크플로 추가
                  </Button>
                }
              >
                {settings.actions_allow.length === 0 ? (
                  <div className="rounded-card border bg-card p-4">
                    <Text as="span" variant="sub">
                      목록에 없는 워크플로는 실행하지 않습니다.
                    </Text>
                  </div>
                ) : (
                  <GridTable
                    aria-label="Actions 허용 목록"
                    columns={ALLOW_COLUMNS}
                    narrowAt={480}
                    narrowColumns={ALLOW_NARROW}
                    framed
                  >
                    <GridTableHeader>
                      <GridTableColumnHeader>워크플로</GridTableColumnHeader>
                      <GridTableColumnHeader hideNarrow>
                        ref
                      </GridTableColumnHeader>
                      <GridTableColumnHeader action>
                        <span className="sr-only">빼기</span>
                      </GridTableColumnHeader>
                    </GridTableHeader>
                    {settings.actions_allow.map((entry) => {
                      const ref =
                        entry.ref === undefined
                          ? "기본 브랜치만"
                          : `ref 패턴 ${entry.ref}`;
                      return (
                        <GridTableRow
                          key={`${entry.workflow}@${entry.ref ?? ""}`}
                        >
                          <GridTableCell>
                            <div className="flex min-w-0 flex-col gap-1">
                              <div className="flex min-w-0 flex-wrap items-center gap-2">
                                <Code className="font-medium text-control">
                                  {entry.workflow}
                                </Code>
                                {base?.actions_allow.some((held) =>
                                  sameEntry(held, entry),
                                ) ? null : (
                                  <Badge variant="blue">저장 전</Badge>
                                )}
                              </div>
                              <Text
                                as="span"
                                variant="meta"
                                className={WIDE_ONLY_480}
                              >
                                {ref}
                              </Text>
                            </div>
                          </GridTableCell>
                          <GridTableCell hideNarrow>
                            <Text as="span" variant="sub">
                              {ref}
                            </Text>
                          </GridTableCell>
                          <GridTableCell align="end">
                            <RowAction
                              disabled={readOnly}
                              aria-label={`${entry.workflow} 빼기`}
                            >
                              빼기
                            </RowAction>
                          </GridTableCell>
                        </GridTableRow>
                      );
                    })}
                  </GridTable>
                )}
                <Alert>
                  <AlertDescription>
                    push나 pull_request로 자동 실행되는 워크플로는 막지
                    않습니다. 저장소의 Actions 설정을 따릅니다. 허용 목록에 넣는
                    워크플로는 입력값으로 실행할 코드나 checkout ref를 고르지
                    않아야 합니다.
                  </AlertDescription>
                </Alert>
              </SettingsSection>
            ) : null}
          </SettingsSection>
        </div>
      ) : null}

      <div
        id={sectionId("pull-request")}
        tabIndex={-1}
        className={FOCUS_TARGET}
      >
        <SettingsSection
          title="Pull request"
          description="이 에이전트가 여는 Pull request의 본문을 워크스페이스 설정 위에 덮어씁니다. 위의 기능 설정과 따로 저장하며, 릴리스를 만들지 않습니다. 이후에 여는·갱신하는 PR부터 적용됩니다."
          box
          foot={
            <Button type="button" size="sm" disabled>
              저장
            </Button>
          }
        >
          <Field>
            <FieldLabel>서식</FieldLabel>
            <NativeSelect className="w-auto max-w-full" defaultValue="inherit">
              <NativeSelectOption value="inherit">
                워크스페이스 설정 따르기
              </NativeSelectOption>
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel>템플릿 이름</FieldLabel>
            <Input className="max-w-80" />
          </Field>
        </SettingsSection>
      </div>

      {settings ? (
        <div id={sectionId("push")} tabIndex={-1} className={FOCUS_TARGET}>
          <SettingsSection
            title="push 승인"
            description="이 에이전트가 만든 commit을 push하기 전에 사람 승인을 받을지 정합니다. 바꾼 것은 위의 저장 상자에서 함께 저장합니다."
          >
            <RowList variant="joined">
              <SettingRow
                title="push 전 사람 승인"
                description="켜면 에이전트가 만든 commit을 sessions:approve 권한이 있는 사람이 승인해야 push합니다. 기존 에이전트는 켜진 채로 옮겨졌습니다."
                status={<On on={settings.push_approval} />}
                control={
                  <Switch
                    aria-label="push 전 사람 승인"
                    checked={settings.push_approval}
                    disabled={readOnly}
                  />
                }
              />
              <SettingRow
                title="첨부 저장소 push"
                description="모든 저장소의 agent/<세션> 브랜치로 push할 때의 한도입니다. 위의 승인 설정과 이 값 중 더 엄격한 쪽을 따릅니다."
                control={
                  <NativeSelect
                    size="sm"
                    aria-label="첨부 저장소 push"
                    defaultValue={data.push_attached}
                    disabled={readOnly}
                  >
                    <NativeSelectOption value="allow">
                      승인 없이 허용
                    </NativeSelectOption>
                    <NativeSelectOption value="ask">
                      사람 승인 필요
                    </NativeSelectOption>
                    <NativeSelectOption value="deny">
                      허용하지 않음
                    </NativeSelectOption>
                  </NativeSelect>
                }
              />
            </RowList>
            {settings.push_approval ? null : (
              <Alert variant="amber">
                <AlertDescription>
                  이 설정만으로는 승인 없이 agent/&lt;세션&gt; 브랜치로 push하고
                  PR을 엽니다. 아래 push 규칙이 사람 승인이거나 허용하지
                  않음이면 그쪽을 따릅니다.
                </AlertDescription>
              </Alert>
            )}
          </SettingsSection>
        </div>
      ) : null}

      <Activity activity={activity} />

      {data.enabled ? (
        <DangerZone
          id={sectionId("danger")}
          tabIndex={-1}
          className={FOCUS_TARGET}
          title="위험 구역"
        >
          <DangerZoneRow
            title="GitHub 사용 끄기"
            description="끄면 이 에이전트에 새 GitHub 토큰을 내주지 않습니다. 진행 중인 세션도 다음 GitHub 요청부터 거절됩니다. 릴리스를 거치지 않고 바로 반영됩니다."
            actionLabel="끄기"
            actionName="GitHub 사용 끄기"
            onAction={() => {}}
          />
        </DangerZone>
      ) : null}
    </>
  );
}

function GitHubTab(props: TabProps) {
  const settings = props.draft ?? baseOf(props.data);
  const keys: readonly SectionKey[] = [
    "overview",
    ...(settings ? (["repositories", "features"] as const) : []),
    "pull-request",
    ...(settings ? (["push"] as const) : []),
    "activity",
    ...(props.data.enabled ? (["danger"] as const) : []),
  ];
  const link = (key: SectionKey) => (
    <SideNavLink
      key={key}
      href={`#${sectionId(key)}`}
      current={key === "overview" ? "location" : undefined}
    >
      {SECTION_LABEL[key]}
    </SideNavLink>
  );
  return (
    <SideNavLayout
      nav={
        <SideNav aria-label="GitHub 구역" current={SECTION_LABEL.overview}>
          <SideNavGroup>
            {keys.filter((k) => !MANAGE_KEYS.includes(k)).map(link)}
          </SideNavGroup>
          <SideNavGroup label="관리">
            {keys.filter((k) => MANAGE_KEYS.includes(k)).map(link)}
          </SideNavGroup>
        </SideNav>
      }
    >
      <div className="flex flex-col gap-[var(--werft-space-section)]">
        <GitHubSettings {...props} />
      </div>
    </SideNavLayout>
  );
}

function AgentGitHubScreen({
  state = "ready",
  ...props
}: TabProps & { readonly state?: "ready" | "loading" | "error" }) {
  const detail = props.data.active_release_id === null ? DRAFT : RELEASED;
  return (
    <ScreenShell current="agents" crumb={["에이전트", detail.agent.name]}>
      <AgentPage detail={detail} tab="github">
        {state === "loading" ? (
          <div className="flex min-h-96 flex-col gap-6" aria-busy="true">
            <Skeleton className="h-10 w-64" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : state === "error" ? (
          <FieldError>
            처리하지 못했습니다 — 잠시 뒤 다시 시도하세요.
          </FieldError>
        ) : (
          <GitHubTab {...props} />
        )}
      </AgentPage>
    </ScreenShell>
  );
}

const meta = {
  title: "Screens/Agent GitHub tab",
  component: AgentGitHubScreen,
  parameters: { layout: "fullscreen" },
  args: { data: DATA, pick: PICK_PAGE, activity: ACTIVITY },
} satisfies Meta<typeof AgentGitHubScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

const DARK = { theme: "dark" };
const withFeatures = (
  features: Partial<AgentGitHubResponse["options"]["features"]>,
): AgentGitHubResponse => ({
  ...DATA,
  options: {
    ...DATA.options,
    features: { ...DATA.options.features, ...features },
  },
});

export const AgentGitHubDefault: Story = {
  name: "기본",
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("tab", { name: "GitHub" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // The workspace screen's section names, lists as tables, the add button
    // on its section's title row and turning off in the danger zone.
    await expect(
      canvas.getByRole("table", { name: "에이전트가 쓰는 저장소" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("switch", { name: "JeongJaeSoon/billing-web 사용" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("heading", { name: "에이전트가 쓸 수 있는 기능" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "워크플로 추가" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "GitHub 사용 끄기" }),
    ).toBeVisible();
  },
};
export const AgentGitHubDefaultDark: Story = {
  name: "기본 (dark)",
  globals: DARK,
};
export const AgentGitHubDefaultMobile: Story = {
  name: "기본 (390px)",
  globals: MOBILE,
};
const CONNECTION_REFUSALS: readonly ActivityReceipt[] = [
  {
    id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c11",
    operation: "mint_github_token",
    status: "failed",
    result: {
      session_id: "d82440c2-6a1b-4c3d-8e5f-7a9b0c1d2e3f",
      repository_id: "werft-sandbox",
      purpose: "clone",
      role: "author",
      reason_code: "pinned_app_removed",
    },
    created_at: "2026-11-02T02:10:00Z",
  },
  {
    id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c12",
    operation: "mint_github_token",
    status: "failed",
    result: {
      session_id: "d82440c2-6a1b-4c3d-8e5f-7a9b0c1d2e3f",
      repository_id: "werft-sandbox",
      purpose: "push",
      role: "author",
      reason_code: "ambiguous_app",
      candidate_connection_ids: [
        "0193a000-0000-7000-8000-00000000000a",
        "0193a000-0000-7000-8000-00000000000b",
      ],
    },
    created_at: "2026-11-02T02:00:00Z",
  },
  ...ACTIVITY,
];
export const AgentGitHubConnectionRefusals: Story = {
  name: "App 연결 거절 기록",
  args: { activity: CONNECTION_REFUSALS },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText(/고정된 App 삭제됨/)).toBeVisible();
    await expect(await canvas.findByText(/App 선택 필요/)).toBeVisible();
  },
};
export const AgentGitHubConnectionRefusalsDark: Story = {
  ...AgentGitHubConnectionRefusals,
  name: "App 연결 거절 기록 (dark)",
  globals: DARK,
};
export const AgentGitHubConnectionRefusalsMobile: Story = {
  ...AgentGitHubConnectionRefusals,
  name: "App 연결 거절 기록 (390px)",
  globals: MOBILE,
};
export const AgentGitHubUnsaved: Story = {
  name: "저장 전 변경",
  args: {
    draft: {
      ...SETTINGS,
      repositories: ["werft-sandbox", "billing-api"],
      actions_allow: [
        { workflow: "ci.yml" },
        { workflow: "release.yml", ref: "release/*" },
      ],
    },
  },
};
export const AgentGitHubOff: Story = {
  name: "사용 꺼짐",
  args: { data: { ...DATA, enabled: false } },
};
export const AgentGitHubNoReviewer: Story = {
  name: "리뷰용 App 없음",
  args: {
    data: withFeatures({
      review: { available: false, reason: "no_reviewer_app" },
    }),
  },
};
export const AgentGitHubCeiling: Story = {
  name: "상한·App 권한 밖",
  args: {
    data: withFeatures({
      actions: { available: false, reason: "over_workspace_ceiling" },
      workflows: { available: false, reason: "app_permission_missing" },
    }),
    pick: undefined,
  },
};
export const AgentGitHubCeilingMobile: Story = {
  ...AgentGitHubCeiling,
  name: "상한·App 권한 밖 (390px)",
  globals: MOBILE,
};
export const AgentGitHubLegacy: Story = {
  name: "GitHub 설정 없는 릴리스",
  args: {
    data: {
      ...DATA,
      github: null,
      legacy_defaults: {
        repositories: ["werft-sandbox"],
        push_approval: true,
        features: {
          review: false,
          actions: false,
          workflows: false,
          checks: false,
          issues: false,
        },
        actions_allow: [],
      },
    },
  },
  play: async ({ canvas }) => {
    await expect(
      await canvas.findByRole("region", {
        name: "GitHub 설정을 아직 저장하지 않았습니다",
      }),
    ).toBeVisible();
    await expect(canvas.getByRole("button", { name: "저장" })).toBeEnabled();
    await expect(canvas.queryByRole("button", { name: "되돌리기" })).toBeNull();
  },
};
const NO_REPOSITORY_DATA: AgentGitHubResponse = {
  ...DATA,
  github: null,
  settings_revision: null,
  legacy_defaults: NO_REPOSITORY_DEFAULTS,
};
export const AgentGitHubNoRepository: Story = {
  name: "저장소 없이 시작한 설정",
  args: { data: NO_REPOSITORY_DATA, activity: [] },
};
export const AgentGitHubNoRepositoryUnpicked: Story = {
  name: "저장소 없이 시작한 설정: 저장소를 고르기 전",
  args: {
    data: NO_REPOSITORY_DATA,
    draft: { ...NO_REPOSITORY_DEFAULTS, push_approval: true },
    activity: [],
  },
  play: async ({ canvas }) => {
    await expect(
      await canvas.findByRole("button", { name: "저장" }),
    ).toBeEnabled();
  },
};
export const AgentGitHubNoRepositoryUnpickedMobile: Story = {
  ...AgentGitHubNoRepositoryUnpicked,
  name: "저장소 없이 시작한 설정: 저장소를 고르기 전 (390px)",
  globals: MOBILE,
};
export const AgentGitHubLoading: Story = {
  name: "불러오는 중",
  args: { state: "loading" },
};
export const AgentGitHubError: Story = {
  name: "읽기 실패",
  args: { state: "error" },
};
