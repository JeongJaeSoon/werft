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
  Field,
  FieldError,
  FieldLabel,
  Heading,
  Input,
  Link,
  RelativeTime,
  RowList,
  RowListItem,
  SettingRow,
  SideNav,
  SideNavGroup,
  SideNavLayout,
  SideNavLink,
  Skeleton,
  Switch,
  Text,
} from "@werft-ai/ui";
import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import { expect } from "storybook/test";

import {
  AgentPage,
  DRAFT,
  INHERIT,
  RELEASE,
  RELEASED,
} from "./agent-detail-parts.tsx";
import { MOBILE, ScreenShell } from "./screen-kit.tsx";

/*
 * apps/web routes/agent-detail/github.tsx (with github-app-repositories.tsx
 * and installed-repositories.tsx) inside the agent page: GET
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

const SECTION_BOX =
  "flex scroll-mt-4 flex-col gap-[var(--werft-space-block)] outline-none";
const SECTION_LABEL = {
  use: "사용",
  repositories: "저장소",
  permissions: "권한",
  allowlist: "Actions 허용 목록",
  push: "push 승인",
  activity: "최근 기록",
} as const;
type SectionKey = keyof typeof SECTION_LABEL;
const sectionId = (key: SectionKey) => `github-${key}`;
const PICK_TITLE = "github-pick-title";

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

function SectionHead({
  section,
  title,
  hint,
}: {
  readonly section: SectionKey;
  readonly title: string;
  readonly hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Heading id={`${sectionId(section)}-title`}>{title}</Heading>
        <Badge variant="blue">릴리스에 반영</Badge>
      </div>
      {hint ? (
        <Text as="span" variant="sub">
          {hint}
        </Text>
      ) : null}
    </div>
  );
}

function Box({
  section,
  children,
}: {
  readonly section: SectionKey;
  readonly children: ReactNode;
}) {
  return (
    <section
      id={sectionId(section)}
      tabIndex={-1}
      className={SECTION_BOX}
      aria-labelledby={`${sectionId(section)}-title`}
    >
      {children}
    </section>
  );
}

/** github-app-repositories.tsx AppRepositoryPicker with one page. */
function AppRepositoryPicker({
  page,
  chosen,
  disabled,
}: {
  readonly page: ListAgentGitHubRepositoriesResponse;
  readonly chosen: readonly string[];
  readonly disabled: boolean;
}) {
  return (
    <section
      aria-labelledby={PICK_TITLE}
      className="flex flex-col gap-2 rounded-md border p-3"
    >
      <Heading id={PICK_TITLE} level={3} className="font-medium text-control">
        App이 설치된 저장소에서 고르기
      </Heading>
      <Text variant="meta">
        워크스페이스가 App 저장소 전체를 허용합니다. 고른 저장소는 위 목록에
        켜진 채로 더해지고, 저장하면 반영됩니다.
      </Text>
      <div className="flex flex-col gap-2">
        <RowList variant="joined">
          {page.repositories.map((repository) => (
            <SettingRow
              key={repository.github_repository_id}
              title={repository.full_name}
              badge={repository.private ? <Badge>비공개</Badge> : null}
              description={`기본 브랜치 ${repository.default_branch}`}
              actions={
                repository.catalog_id !== null &&
                chosen.includes(repository.catalog_id) ? (
                  <Text as="span" variant="meta">
                    목록에 있음
                  </Text>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-label={`${repository.full_name} 고르기`}
                    aria-disabled={disabled || undefined}
                  >
                    고르기
                  </Button>
                )
              }
            />
          ))}
        </RowList>
      </div>
    </section>
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
    <SettingRow
      title={title}
      badge={failed ? <Badge variant="red">거절</Badge> : undefined}
      description={
        <>
          {parts.join(" · ")}
          {result.session_id ? (
            <>
              {parts.length > 0 ? " · " : null}
              <Link href={`#sessions/${result.session_id}`}>
                세션 <Code>{result.session_id.slice(0, 8)}</Code>
              </Link>
            </>
          ) : null}
        </>
      }
      status={
        <RelativeTime
          value={receipt.created_at}
          locale="ko"
          className="text-caption text-muted-foreground"
        />
      }
    />
  );
}

function Activity({
  activity,
}: {
  readonly activity: readonly ActivityReceipt[];
}) {
  return (
    <Box section="activity">
      <div className="flex flex-col gap-1">
        <Heading id={`${sectionId("activity")}-title`}>최근 기록</Heading>
        <Text as="span" variant="sub">
          토큰 발급과 거절, 설정 변경, 워크플로 실행은 감사 기록(receipt)에
          남습니다. 볼 수 있는 세션의 기록만 보입니다.
        </Text>
      </div>
      {activity.length === 0 ? (
        <Text as="span" variant="sub">
          아직 GitHub 기록이 없습니다.
        </Text>
      ) : (
        <RowList variant="joined" aria-label="최근 기록">
          {activity.map((receipt) => (
            <ReceiptRow key={receipt.id} receipt={receipt} />
          ))}
        </RowList>
      )}
    </Box>
  );
}

type TabProps = {
  readonly data: AgentGitHubResponse;
  /** Unsaved settings on top of the active release's; absent: none. */
  readonly draft?: AgentGitHub | undefined;
  /** The App repositories page; absent where the ceiling lists them. */
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
  return (
    <>
      <section
        className="flex flex-col gap-[var(--werft-space-block)]"
        aria-label="상태"
      >
        <RowList variant="joined">
          <RowListItem className="flex flex-wrap items-center gap-x-4 gap-y-2 text-control">
            <Badge variant={data.enabled ? "green" : "gray"}>
              {data.enabled ? "사용 중" : "꺼짐"}
            </Badge>
            <Text as="span">
              {base === null || data.github === null
                ? "저장소: 릴리스 설정 그대로"
                : `저장소 ${data.github.repositories.length}개`}
            </Text>
            <Text as="span" className="flex items-center gap-2">
              <Text as="span" variant="sub">
                push 전 승인
              </Text>
              <Text as="span">
                {base
                  ? // github.tsx: a release without settings still asks a person.
                    data.github === null || base.push_approval
                    ? "켜짐"
                    : "꺼짐"
                  : "—"}
              </Text>
            </Text>
          </RowListItem>
        </RowList>
      </section>
      {pending > 0 || firstSave ? (
        <Alert variant="blue" role="region" aria-label={pendingTitle}>
          <AlertTitle>{pendingTitle}</AlertTitle>
          <AlertDescription>
            저장하면 다음에 시작하는 세션부터 적용됩니다. 저장소를 빼거나 권한을
            좁히는 변경은 진행 중인 세션에도 적용됩니다. 새 릴리스는 만들지
            않습니다.
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

      <Box section="use">
        <Heading id={`${sectionId("use")}-title`}>사용</Heading>
        <RowList variant="joined">
          <SettingRow
            title="GitHub 사용"
            badge={<Badge variant="gray">즉시 반영</Badge>}
            description="끄면 이 에이전트에 새 GitHub 토큰을 내주지 않습니다. 진행 중인 세션도 다음 GitHub 요청부터 거절됩니다. 릴리스를 거치지 않고 바로 반영됩니다."
            status={<On on={data.enabled} />}
            control={<Switch aria-label="GitHub 사용" checked={data.enabled} />}
          />
        </RowList>
        {data.enabled ? null : (
          <Text as="span" variant="sub">
            GitHub 사용이 꺼져 있어 아래 설정은 읽기만 할 수 있습니다.
          </Text>
        )}
      </Box>

      {settings ? (
        <div className="flex flex-col gap-8">
          <Box section="repositories">
            <SectionHead
              section="repositories"
              title="저장소"
              hint="GitHub App을 쓰는 카탈로그 저장소 가운데 고릅니다. 토큰은 고른 저장소 하나로만 좁혀 발급합니다."
            />
            <RowList variant="joined">
              {data.options.repositories.map((repository) => {
                const on = settings.repositories.includes(repository.id);
                const blocked = !repository.available && !on;
                return (
                  <SettingRow
                    key={repository.id}
                    title={repository.id}
                    badge={
                      repository.installed.author === false ? (
                        <Badge variant="amber">App 미설치</Badge>
                      ) : undefined
                    }
                    description={
                      <Text
                        as="span"
                        className={cn(INHERIT, "[overflow-wrap:anywhere]")}
                      >
                        {repository.url}
                        {repository.reason
                          ? ` · ${REPOSITORY_REASON[repository.reason]}`
                          : null}
                      </Text>
                    }
                    status={
                      <Text as="span" variant="sub">
                        {on ? "사용" : "안 씀"}
                      </Text>
                    }
                    control={
                      <Switch
                        aria-label={repository.id}
                        checked={on}
                        disabled={readOnly || blocked}
                      />
                    }
                  />
                );
              })}
            </RowList>
            {pick ? (
              <AppRepositoryPicker
                page={pick}
                chosen={settings.repositories}
                disabled={readOnly}
              />
            ) : null}
            <Text as="span" variant="meta">
              목록에 없는 저장소는 GitHub에서 App 설치에 더한 뒤 운영자가
              카탈로그에 추가합니다.
            </Text>
          </Box>

          <Box section="permissions">
            <SectionHead
              section="permissions"
              title="권한"
              hint="기본은 PR 작성·수정까지입니다. 브랜치 보호·필수 리뷰·CODEOWNERS처럼 GitHub가 막는 것은 저장소 설정을 따릅니다. merge 권한은 없습니다."
            />
            <RowList variant="joined">
              <SettingRow
                title="PR 작성·수정"
                badge={<Badge variant="gray">기본</Badge>}
                description="agent/<세션> 브랜치로 push하고, PR을 열고 고치고, 코멘트를 남깁니다. 필요한 권한: contents·pull requests 쓰기"
                status={
                  <Text as="span" variant="sub">
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
          </Box>

          {settings.features.actions ? (
            <Box section="allowlist">
              <SectionHead
                section="allowlist"
                title="Actions 허용 목록"
                hint="Actions 실행이 켜져 있을 때 이 목록의 워크플로만 실행하거나 다시 실행합니다. 목록 밖의 workflow_dispatch와 다시 실행은 거절합니다."
              />
              {settings.actions_allow.length === 0 ? (
                <Text as="span" variant="sub">
                  목록에 없는 워크플로는 실행하지 않습니다.
                </Text>
              ) : (
                <RowList variant="joined" aria-label="Actions 허용 목록">
                  {settings.actions_allow.map((entry) => (
                    <SettingRow
                      key={`${entry.workflow}@${entry.ref ?? ""}`}
                      title={
                        <Code className="font-medium text-control">
                          {entry.workflow}
                        </Code>
                      }
                      badge={
                        base?.actions_allow.some((held) =>
                          sameEntry(held, entry),
                        ) ? undefined : (
                          <Badge variant="blue">저장 전</Badge>
                        )
                      }
                      description={
                        entry.ref === undefined
                          ? "기본 브랜치만"
                          : `ref 패턴 ${entry.ref}`
                      }
                      actions={
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={readOnly}
                          aria-label={`${entry.workflow} 빼기`}
                        >
                          빼기
                        </Button>
                      }
                    />
                  ))}
                </RowList>
              )}
              <form
                className="flex flex-col gap-3 rounded-lg border p-4"
                noValidate={true}
                onSubmit={(event) => event.preventDefault()}
              >
                <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                  <Field>
                    <FieldLabel>워크플로 파일</FieldLabel>
                    <Input
                      placeholder="release.yml"
                      className="font-mono"
                      disabled={readOnly}
                    />
                  </Field>
                  <Field>
                    <FieldLabel>ref 패턴(선택)</FieldLabel>
                    <Input
                      placeholder="release/*"
                      className="font-mono"
                      disabled={readOnly}
                    />
                  </Field>
                  <Button type="submit" variant="outline" disabled={readOnly}>
                    <Plus aria-hidden="true" strokeWidth={1.5} />
                    워크플로 추가
                  </Button>
                </div>
                <Text as="span" variant="meta">
                  비우면 기본 브랜치만. * 는 / 를 넘지 않습니다.
                </Text>
              </form>
              <Alert>
                <AlertDescription>
                  push나 pull_request로 자동 실행되는 워크플로는 막지 않습니다.
                  저장소의 Actions 설정을 따릅니다. 허용 목록에 넣는 워크플로는
                  입력값으로 실행할 코드나 checkout ref를 고르지 않아야 합니다.
                </AlertDescription>
              </Alert>
            </Box>
          ) : null}

          <Box section="push">
            <SectionHead section="push" title="push 승인" />
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
            </RowList>
            {settings.push_approval ? null : (
              <Alert variant="amber">
                <AlertDescription>
                  승인 없이 agent/&lt;세션&gt; 브랜치로 push하고 PR을 엽니다.
                </AlertDescription>
              </Alert>
            )}
          </Box>
        </div>
      ) : null}
      <Activity activity={activity} />
    </>
  );
}

function GitHubTab(props: TabProps) {
  const settings = props.draft ?? baseOf(props.data);
  const keys: readonly SectionKey[] = [
    "use",
    ...(settings
      ? ([
          "repositories",
          "permissions",
          ...(settings.features.actions ? (["allowlist"] as const) : []),
          "push",
        ] as const)
      : []),
    "activity",
  ];
  const link = (key: SectionKey) => (
    <SideNavLink
      key={key}
      href={`#${sectionId(key)}`}
      current={key === "use" ? "location" : undefined}
    >
      {SECTION_LABEL[key]}
    </SideNavLink>
  );
  return (
    <SideNavLayout
      nav={
        <SideNav aria-label="GitHub 구역" current={SECTION_LABEL.use}>
          <SideNavGroup>
            {keys.filter((k) => k !== "push" && k !== "activity").map(link)}
          </SideNavGroup>
          <SideNavGroup label="관리">
            {keys.filter((k) => k === "push" || k === "activity").map(link)}
          </SideNavGroup>
        </SideNav>
      }
    >
      <div className="flex flex-col gap-8">
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
    await expect(
      canvas.getByRole("button", { name: "JeongJaeSoon/billing-web 고르기" }),
    ).toBeVisible();
    await expect(canvas.getByText("목록에 있음")).toBeVisible();
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
