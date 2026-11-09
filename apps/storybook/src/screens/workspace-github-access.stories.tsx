import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Badge,
  Button,
  DangerZone,
  DangerZoneRow,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  Heading,
  IconTile,
  LinkTab,
  LinkTabs,
  Page,
  RowList,
  SettingRow,
  Switch,
  Text,
} from "@werft-ai/ui";
import {
  ArrowUpRight,
  GitPullRequest,
  MoreHorizontal,
  Plus,
} from "lucide-react";
import { useId } from "react";

import { MOBILE, ScreenShell } from "./screen-kit.tsx";

/*
 * Settings > Workspace > Integrations > GitHub
 * (docs/contributing/decisions/github-agent.md
 * §7): one GitHub card with the App list, the installation table and the
 * repositories line, then the features agents may use, the member account
 * link and, last, the danger zone that disconnects each App. Values are what
 * GET /v1/workspaces/{id}/github-settings returns.
 */

type Viewer = "owner" | "admin" | "member";
type State = "ready" | "short" | "empty";
type Feature = "actions" | "workflows" | "review";

const CARD = "flex flex-col gap-4 rounded-card border bg-card p-4";
const MANAGER_COLUMNS =
  "minmax(0,1.2fr) 88px 96px minmax(0,1fr) minmax(0,1.2fr) 88px 32px";
const MEMBER_COLUMNS = "minmax(0,1.2fr) 88px minmax(0,1fr) 88px";
const MANAGER_NARROW = "minmax(0,1fr) 88px 32px";
const MEMBER_NARROW = "minmax(0,1fr) 88px";
const NARROW_ONLY = "[@container(min-width:761px)]:hidden";
const APP_COLUMNS = "minmax(0,1fr) 152px 44px";
const APP_COLUMNS_READ = "minmax(0,1fr) 152px";
const APP_NARROW = "minmax(0,1fr) 120px 44px";
const APP_NARROW_READ = "minmax(0,1fr) 120px";

// connections[]: name, role, app_id, installations[] with status and detail.
const APPS = [
  {
    name: "werft-agent",
    role: "작성용",
    id: 101,
    key: "2026. 10. 01. 김민지 저장",
  },
  {
    name: "werft-reviewer",
    role: "리뷰 승인용",
    id: 202,
    key: "2026. 10. 12. 저장",
  },
] as const;
const INSTALLATIONS = [
  {
    account: "acme",
    type: "조직",
    repos: "12개 선택",
    app: "werft-agent",
    by: "김민지 · 2026. 10. 01.",
    status: ["연결됨", "green"],
  },
  {
    account: "acme",
    type: "조직",
    repos: "전체 40개",
    app: "werft-reviewer",
    by: "설치 2026. 10. 12.",
    status: ["승인 대기", "amber"],
  },
  {
    account: "minji-kim",
    type: "개인 계정",
    repos: "3개 선택",
    app: "werft-agent",
    by: "설치 2026. 09. 20.",
    status: ["연결됨", "green"],
  },
] as const;
const FEATURES: readonly (readonly [Feature, string, string, number])[] = [
  [
    "actions",
    "Actions 실행",
    "에이전트 허용 목록의 워크플로를 실행하거나 다시 실행합니다.",
    2,
  ],
  [
    "workflows",
    "워크플로 파일 수정",
    ".github/workflows 아래 파일을 바꾼 commit도 push합니다.",
    0,
  ],
  [
    "review",
    "PR 리뷰 승인",
    "PR에 코멘트·변경 요청·승인 리뷰를 남깁니다. 리뷰 승인용 App이 있어야 켤 수 있습니다.",
    1,
  ],
];

function MenuButton({ label }: { readonly label: string }) {
  return (
    <Button type="button" variant="ghost" size="icon-sm" aria-label={label}>
      <MoreHorizontal aria-hidden="true" />
    </Button>
  );
}

function AppRows({
  manage,
  state,
}: {
  readonly manage: boolean;
  readonly state: State;
}) {
  return (
    <GridTable
      aria-label="워크스페이스에 연결한 GitHub App"
      columns={manage ? APP_COLUMNS : APP_COLUMNS_READ}
      narrowAt={480}
      narrowColumns={manage ? APP_NARROW : APP_NARROW_READ}
      framed
    >
      <GridTableHeader>
        <GridTableColumnHeader>App</GridTableColumnHeader>
        <GridTableColumnHeader>상태</GridTableColumnHeader>
        {manage ? (
          <GridTableColumnHeader>
            <Text as="span" className="sr-only">
              메뉴
            </Text>
          </GridTableColumnHeader>
        ) : null}
      </GridTableHeader>
      {APPS.map((app) => {
        const short = state === "short" && app.role === "작성용";
        const pending = app.role === "리뷰 승인용";
        return (
          <GridTableRow key={app.id}>
            <GridTableCell {...{ role: "rowheader" }}>
              <div className="flex w-full min-w-0 flex-col gap-2">
                <div className="flex min-w-0 flex-col gap-(--werft-row-line-gap)">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Text as="span" weight="medium" truncate>
                      {app.name}
                    </Text>
                    <Badge>{app.role}</Badge>
                  </div>
                  <Text as="span" variant="meta">
                    {`App ID ${app.id} · 키 ${app.key}`}
                  </Text>
                </div>
                {short ? (
                  <div className="flex flex-col gap-2">
                    <Text className="text-(color:--werft-tone-caution-fg)">
                      Actions 실행을(를) 쓰려면 이 App에 Actions 쓰기 권한이
                      필요합니다. 더하면 GitHub가 설치한 계정마다 owner에게
                      승인을 요청합니다. 다시 설치하지 않아도 됩니다.
                    </Text>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button type="button" variant="outline" size="sm">
                        GitHub에서 권한 추가
                        <ArrowUpRight aria-hidden="true" className="size-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-link"
                      >
                        App 소유자에게 보낼 안내 복사
                      </Button>
                    </div>
                  </div>
                ) : pending ? (
                  <div className="flex flex-col gap-2">
                    <Text className="text-(color:--werft-tone-caution-fg)">
                      acme의 owner가 Pull requests 쓰기을(를) 승인하면 그 계정
                      저장소에서도 이 App의 권한이 모두 동작합니다.
                    </Text>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="w-fit text-link"
                    >
                      owner에게 보낼 안내 복사
                    </Button>
                  </div>
                ) : null}
              </div>
            </GridTableCell>
            <GridTableCell>
              {short ? (
                <Badge variant="amber">권한 추가 필요</Badge>
              ) : pending ? (
                <Badge variant="amber">승인 대기 1곳</Badge>
              ) : (
                <Badge variant="green">연결됨</Badge>
              )}
            </GridTableCell>
            {manage ? (
              <GridTableCell align="end">
                <MenuButton label={`${app.name} 메뉴`} />
              </GridTableCell>
            ) : null}
          </GridTableRow>
        );
      })}
    </GridTable>
  );
}

function Installations({ manage }: { readonly manage: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <GridTable
        aria-label="GitHub App을 설치한 조직과 개인 계정"
        columns={manage ? MANAGER_COLUMNS : MEMBER_COLUMNS}
        narrowAt={760}
        narrowColumns={manage ? MANAGER_NARROW : MEMBER_NARROW}
        framed
      >
        <GridTableHeader>
          <GridTableColumnHeader>이름</GridTableColumnHeader>
          <GridTableColumnHeader hideNarrow>유형</GridTableColumnHeader>
          {manage ? (
            <GridTableColumnHeader hideNarrow>저장소</GridTableColumnHeader>
          ) : null}
          <GridTableColumnHeader hideNarrow>App</GridTableColumnHeader>
          {manage ? (
            <GridTableColumnHeader hideNarrow>
              연결한 사람
            </GridTableColumnHeader>
          ) : null}
          <GridTableColumnHeader>상태</GridTableColumnHeader>
          {manage ? (
            <GridTableColumnHeader>
              <Text as="span" className="sr-only">
                메뉴
              </Text>
            </GridTableColumnHeader>
          ) : null}
        </GridTableHeader>
        {INSTALLATIONS.map((row) => {
          const moved = manage
            ? [row.type, row.repos, row.app]
            : [row.type, row.app];
          return (
            <GridTableRow key={`${row.account}:${row.app}`}>
              <GridTableCell {...{ role: "rowheader" }} lines>
                <Text as="span" weight="medium" truncate>
                  {row.account}
                </Text>
                <Text as="span" variant="meta" className={NARROW_ONLY}>
                  {moved.join(" · ")}
                </Text>
                {manage ? (
                  <Text as="span" variant="meta" className={NARROW_ONLY}>
                    {`연결: ${row.by}`}
                  </Text>
                ) : null}
              </GridTableCell>
              <GridTableCell hideNarrow>
                <Text as="span" variant="sub">
                  {row.type}
                </Text>
              </GridTableCell>
              {manage ? (
                <GridTableCell hideNarrow>{row.repos}</GridTableCell>
              ) : null}
              <GridTableCell hideNarrow>
                <Text as="span" truncate>
                  {row.app}
                </Text>
              </GridTableCell>
              {manage ? (
                <GridTableCell hideNarrow>
                  <Text as="span" truncate>
                    {row.by}
                  </Text>
                </GridTableCell>
              ) : null}
              <GridTableCell>
                <Badge variant={row.status[1]}>{row.status[0]}</Badge>
              </GridTableCell>
              {manage ? (
                <GridTableCell align="end">
                  <MenuButton label={`${row.account} · ${row.app} 메뉴`} />
                </GridTableCell>
              ) : null}
            </GridTableRow>
          );
        })}
      </GridTable>
      <Text variant="meta">GitHub에서 읽음 · 3분 전</Text>
    </div>
  );
}

function GitHubCard({
  manage,
  state,
}: {
  readonly manage: boolean;
  readonly state: State;
}) {
  const titleId = useId();
  const empty = state === "empty";
  return (
    <section aria-labelledby={titleId} className={CARD}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-3">
        <IconTile icon={GitPullRequest} hue="slate" size="two-line" />
        <div className="flex min-w-0 flex-1 flex-col">
          <Heading id={titleId} level={2}>
            GitHub
          </Heading>
          <Text variant="sub">
            {empty ? "연결 없음" : "App 2개 · 계정 2곳"}
          </Text>
        </div>
        {manage && !empty ? (
          <div className="max-sm:basis-full max-sm:pl-[calc(var(--werft-size-tile-two-line)+0.75rem)]">
            <Button type="button">
              <Plus aria-hidden="true" />
              조직 추가
            </Button>
          </div>
        ) : null}
      </div>
      <Text variant="sub">
        에이전트가 작업할 조직과 개인 계정에 GitHub App을 설치합니다. 어느
        저장소까지 열지는 설치할 때 GitHub에서 정합니다.
      </Text>
      {empty ? (
        <div className="flex flex-col items-start gap-3 rounded-card border border-dashed p-4">
          <Text weight="medium">아직 연결된 GitHub App이 없습니다</Text>
          <Text variant="sub">
            GitHub에서 App을 만들면 콘솔이 키를 받아 보관합니다. 만든 뒤 조직에
            설치하면 여기 표에 나옵니다.
          </Text>
          {manage ? (
            <div className="flex flex-wrap gap-2">
              <Button type="button">GitHub App 만들기</Button>
              <Button type="button" variant="outline">
                이미 있는 App 연결
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <Heading level={3}>GitHub App</Heading>
            <AppRows manage={manage} state={state} />
            {manage ? (
              <Button type="button" variant="ghost" className="w-fit text-link">
                <Plus aria-hidden="true" />
                App 추가
              </Button>
            ) : null}
          </div>
          <Installations manage={manage} />
          {manage ? (
            <div className="flex flex-wrap items-center gap-3 border-t pt-4">
              <div className="flex min-w-0 flex-1 flex-col">
                <Text weight="medium">에이전트가 쓰는 저장소</Text>
                <Text variant="sub">
                  에이전트가 고른 저장소 8개 · 설치 밖 1개
                </Text>
              </div>
              <Button type="button" variant="outline">
                저장소 관리
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function FeaturesCard({
  manage,
  state,
}: {
  readonly manage: boolean;
  readonly state: State;
}) {
  const titleId = useId();
  const hintId = useId();
  return (
    <section aria-labelledby={titleId} className={CARD}>
      <div className="flex flex-col gap-1">
        <Heading id={titleId} level={2}>
          에이전트가 쓸 수 있는 기능
        </Heading>
        <Text variant="sub">
          워크스페이스 전체의 상한입니다. 에이전트마다 켜는 것은 에이전트의
          GitHub 탭에서 합니다. 스위치를 바꾸면 바로 저장되고, 앞 릴리스로 도는
          세션도 다음 GitHub 요청부터 따릅니다.
        </Text>
      </div>
      <RowList variant="joined">
        <SettingRow
          title="PR 작성·수정"
          description="clone, push, PR 열기·코멘트. GitHub를 쓰는 에이전트는 늘 씁니다."
          actions={
            <Text as="div" variant="meta">
              항상 켜짐
            </Text>
          }
        />
        {FEATURES.map(([feature, title, hint, using]) => {
          const on = feature !== "workflows";
          const badge =
            feature === "actions" && state === "short" ? (
              <Badge variant="amber">App 권한 필요</Badge>
            ) : feature === "review" ? (
              <Badge variant="amber">일부 계정 승인 대기</Badge>
            ) : null;
          const meta = `활성 릴리스에서 켠 에이전트 ${using}개`;
          return (
            <SettingRow
              key={feature}
              title={title}
              badge={badge}
              description={hint}
              meta={
                <Text as="div" variant="meta">
                  {feature === "review"
                    ? `werft-reviewer(으)로 · ${meta}`
                    : meta}
                </Text>
              }
              control={
                <Switch
                  checked={on}
                  disabled={!manage}
                  aria-describedby={manage ? undefined : hintId}
                />
              }
            />
          );
        })}
      </RowList>
      {manage ? null : (
        <Text id={hintId} variant="meta">
          워크스페이스 설정 변경 권한이 있어야 할 수 있습니다. 지금 역할:
          구성원.
        </Text>
      )}
    </section>
  );
}

function UserLinkRow({ manage }: { readonly manage: boolean }) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-card border bg-card p-4"
    >
      <div className="flex min-w-0 flex-1 basis-80 flex-col gap-1">
        <Heading id={titleId} level={2}>
          구성원 GitHub 계정 연결
        </Heading>
        <Text variant="sub">werft-agent(으)로 연결합니다.</Text>
      </div>
      <Badge variant="green">켜짐</Badge>
      {manage ? <MenuButton label="구성원 GitHub 계정 연결 메뉴" /> : null}
    </section>
  );
}

function GitHubScreen({
  viewer,
  state,
}: {
  readonly viewer: Viewer;
  readonly state: State;
}) {
  const manage = viewer !== "member";
  return (
    <ScreenShell
      current="settings"
      crumb={["워크스페이스", "연동"]}
      role={viewer}
    >
      <Page
        title="연동"
        description="에이전트가 저장소를 clone하고, 승인된 결과를 push하고, PR을 열 때 쓰는 GitHub 연결입니다. 에이전트마다 쓸 저장소는 에이전트의 GitHub 탭에서 고릅니다."
      >
        <LinkTabs aria-label="연동 종류">
          <LinkTab href="#slack">Slack</LinkTab>
          <LinkTab href="#github" current>
            GitHub
          </LinkTab>
        </LinkTabs>
        <div className="flex flex-col gap-10">
          <GitHubCard manage={manage} state={state} />
          {state === "empty" ? null : (
            <>
              <FeaturesCard manage={manage} state={state} />
              <UserLinkRow manage={manage} />
              {manage ? (
                <DangerZone title="위험 구역">
                  {APPS.map((app) => (
                    <DangerZoneRow
                      key={app.id}
                      title={`${app.name} 연결 해제`}
                      description="이 워크스페이스에서 App을 뗍니다. GitHub의 App과 설치는 그대로 남습니다."
                      actionLabel="연결 해제"
                      actionName={`${app.name} 연결 해제`}
                      onAction={() => undefined}
                    />
                  ))}
                </DangerZone>
              ) : null}
            </>
          )}
        </div>
      </Page>
    </ScreenShell>
  );
}

const meta = {
  title: "Screens/Workspace GitHub connection",
  component: GitHubScreen,
  parameters: { layout: "fullscreen" },
  args: { viewer: "owner", state: "ready" },
  argTypes: {
    viewer: { control: "inline-radio", options: ["owner", "admin", "member"] },
    state: {
      control: "inline-radio",
      options: ["ready", "short", "empty"],
    },
  },
} satisfies Meta<typeof GitHubScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WorkspaceGitHub: Story = { name: "Owner" };
export const WorkspaceGitHubShort: Story = {
  name: "Owner, App permission short",
  args: { state: "short" },
};
export const WorkspaceGitHubEmpty: Story = {
  name: "No App yet",
  args: { state: "empty" },
};
export const WorkspaceGitHubMember: Story = {
  name: "Member (read-only)",
  args: { viewer: "member" },
};
export const WorkspaceGitHubDark: Story = {
  name: "Owner (dark)",
  globals: { theme: "dark" },
};
export const WorkspaceGitHubMobile: Story = {
  name: "Owner, short (390px)",
  args: { state: "short" },
  globals: MOBILE,
};
export const WorkspaceGitHubMemberMobile: Story = {
  name: "Member (390px)",
  args: { viewer: "member" },
  globals: MOBILE,
};
