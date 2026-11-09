import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Code,
  DangerZone,
  DangerZoneRow,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  Heading,
  IconTile,
  Link,
  RowAction,
  RowLines,
  SettingRow,
  SettingsSection,
  Switch,
  Text,
} from "@werft-ai/ui";
import { Ellipsis, Hash, Plus } from "lucide-react";
import { useId } from "react";
/*
 * apps/web routes/agent-detail/slack.tsx: an agent's Slack tab, built like
 * Integrations > Slack. The Slack card, the agent's own sections (channels,
 * basic), then the sections the workspace screen has, under its names and in
 * its order (Slack app creation, Addresses for a Slack app, Slack apps made
 * here), each saying what this agent uses, and last the danger zone.
 */

export type TabState = "connected" | "pending" | "none";

const APP_ID = "A07PLACEHLD";
const EVENTS_URL = "https://werft.example.test/v1/slack/events/7f3c";

function SlackCard({ state }: { readonly state: TabState }) {
  const connected = state !== "none";
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <IconTile icon={Hash} hue="slate" size="two-line" />
        <div className="flex min-w-0 flex-1 flex-col">
          <Heading id={titleId} level={2}>
            Slack
          </Heading>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-control text-muted-foreground">
            <span className="text-foreground">
              {connected ? "연결됨" : "만들기 전"}
            </span>
            <span className="flex items-center gap-1.5">
              <span>봇 ID</span>
              <Code>{connected ? "U07PLACEBOT" : "—"}</Code>
            </span>
            {connected ? (
              <>
                <span className="flex items-center gap-1.5">
                  <span>홈 채널</span>
                  <span className="text-foreground">#release-notes</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span>DM 받기</span>
                  <span className="text-foreground">켜짐</span>
                </span>
              </>
            ) : null}
          </div>
        </div>
      </div>
      <Text variant="sub">
        이 에이전트가 Slack에서 쓰는 앱, 주소, 채널입니다. 앱을 만드는 토큰은
        워크스페이스의 연동 {">"} Slack에 등록합니다.
      </Text>
      {state === "pending" ? (
        <Alert variant="amber">
          <AlertTitle>
            Slack이 Request URL을 아직 확인하지 않았습니다
          </AlertTitle>
          <AlertDescription>
            앱 설정의 Event Subscriptions에서 Request URL의 Verify(또는 Retry)를
            누르세요.{" "}
            <Link
              href={`https://api.slack.com/apps/${APP_ID}/event-subscriptions`}
              target="_blank"
              newTabLabel="(새 탭에서 열림)"
              underline="always"
            >
              Event Subscriptions 열기
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}

const CHANNELS = [
  { name: "release-notes", visibility: "공개", home: true },
  { name: "incident-room", visibility: "비공개", home: false },
  // Slack allows 80 characters and no break point inside a name.
  {
    name: "platform-quarterly-review-and-release-planning-for-the-whole-team",
    visibility: "공개",
    home: false,
  },
] as const;

function Channels({ locked }: { readonly locked: boolean }) {
  return (
    <SettingsSection
      titleAs="h3"
      title="연결된 채널"
      description="이 채널의 모든 사람이 답을 읽습니다. 담당 팀 밖 사람도 포함됩니다."
      actions={
        locked ? null : (
          <>
            <Button type="button" variant="outline" size="sm">
              홈 지정
            </Button>
            <Button type="button" variant="outline" size="sm">
              <Plus aria-hidden="true" strokeWidth={1.5} />
              채널 추가
            </Button>
          </>
        )
      }
      rows={
        <SettingRow
          title="채널에 초대"
          description="Slack 채널 입력창에 붙여 넣어 보내면 봇이 그 채널에 초대됩니다."
          meta={<Code>/invite @billing-agent</Code>}
          actions={
            <Button type="button" variant="outline" size="sm">
              복사
            </Button>
          }
        />
      }
    >
      <GridTable
        aria-label="연결된 채널"
        columns="minmax(0,1fr) 136px"
        framed
        inert={locked}
        className={locked ? "opacity-40" : undefined}
      >
        <GridTableHeader>
          <GridTableColumnHeader>채널</GridTableColumnHeader>
          <GridTableColumnHeader align="end">사용</GridTableColumnHeader>
        </GridTableHeader>
        {CHANNELS.map((channel) => (
          <GridTableRow key={channel.name}>
            <GridTableCell className="py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Text
                  as="span"
                  weight="medium"
                  className="[overflow-wrap:anywhere]"
                >
                  #{channel.name}
                </Text>
                <Badge
                  variant={channel.visibility === "공개" ? "green" : "gray"}
                >
                  {channel.visibility}
                </Badge>
                {channel.home ? <Badge variant="gray">홈 채널</Badge> : null}
              </div>
            </GridTableCell>
            <GridTableCell align="end">
              <Switch
                aria-label={`#${channel.name}에서 사용`}
                checked
                onCheckedChange={() => {}}
              />
            </GridTableCell>
          </GridTableRow>
        ))}
      </GridTable>
    </SettingsSection>
  );
}

function Basic() {
  return (
    <SettingsSection
      titleAs="h3"
      title="기본"
      description="이 에이전트가 DM과 멘션에 반응하는 방식입니다."
      rows={
        <>
          <SettingRow
            title="DM 받기"
            description="켜면 사람들이 이 에이전트에게 DM으로 일을 맡길 수 있습니다."
            control={
              <Switch aria-label="DM 받기" checked onCheckedChange={() => {}} />
            }
          />
          <SettingRow
            title="멘션했을 때만 반응"
            description="켜면 채널에서는 @멘션한 글에만 반응합니다."
            control={
              <Switch
                aria-label="멘션했을 때만 반응"
                checked
                onCheckedChange={() => {}}
              />
            }
          />
        </>
      }
    />
  );
}

function AppSections({
  state,
  active,
}: {
  readonly state: TabState;
  readonly active: boolean;
}) {
  const made = state !== "none";
  return (
    <>
      <SettingsSection
        titleAs="h3"
        title="Slack 앱 생성"
        description="이 에이전트의 Slack 앱을 만들 때 쓰는 워크스페이스의 토큰입니다. 등록과 교체는 연동 > Slack에서 합니다."
        rows={
          <SettingRow
            title="App Configuration Token"
            badge={<Badge variant="green">토큰 확인됨</Badge>}
            actions={<RowAction>{"연동 > Slack에서 관리"}</RowAction>}
          />
        }
      />
      <SettingsSection
        titleAs="h3"
        title="Slack 앱에 넣을 주소"
        description="이 에이전트의 앱이 쓰는 이벤트 요청 URL입니다. 콘솔이 앱을 만들 때 자동으로 넣고, Slack이 이 주소를 확인해야 채널 글을 받습니다."
        box={!made}
        rows={
          made ? (
            <SettingRow
              title="이벤트 요청 URL"
              meta={
                <Code className="[overflow-wrap:anywhere]">{EVENTS_URL}</Code>
              }
              badge={
                state === "pending" ? (
                  <Badge variant="amber">Slack 확인 대기</Badge>
                ) : (
                  <Badge variant="green">Slack 확인됨</Badge>
                )
              }
              actions={<RowAction>다시 확인</RowAction>}
            />
          ) : undefined
        }
      >
        {made ? null : (
          <Text variant="sub">
            앱을 만들면 이 에이전트의 주소가 정해집니다.
          </Text>
        )}
      </SettingsSection>
      <SettingsSection
        titleAs="h3"
        title="자동으로 만든 Slack 앱"
        description="이 콘솔이 이 에이전트를 위해 만든 Slack 앱입니다. 설치와 다시 설치는 여기서, 연결 해제와 삭제는 위험 구역에서 합니다."
        box={!made}
        foot={
          made ? (
            <Text variant="meta">
              권한이나 이벤트 설정이 바뀌었을 때 다시 설치합니다. Slack 동의
              화면으로 이동합니다.
            </Text>
          ) : undefined
        }
      >
        {made ? (
          <GridTable
            aria-label="앱 목록"
            columns="minmax(0,1.4fr) minmax(0,1fr) 120px 160px"
            narrowAt={640}
            narrowColumns="minmax(0,1fr) 160px"
            framed
          >
            <GridTableHeader>
              <GridTableColumnHeader>앱</GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>상태</GridTableColumnHeader>
              <GridTableColumnHeader align="end" hideNarrow>
                갱신
              </GridTableColumnHeader>
              <GridTableColumnHeader action>
                <span className="sr-only">Slack 앱 메뉴</span>
              </GridTableColumnHeader>
            </GridTableHeader>
            <GridTableRow>
              <GridTableCell>
                <RowLines>
                  <Text as="span" weight="medium">
                    결제 담당 앱
                  </Text>
                  <Code className="text-muted-foreground">{APP_ID}</Code>
                  <span className="hidden items-center gap-2 [@container(max-width:640px)]:flex">
                    <Badge variant="green">연결됨</Badge>
                    <Text as="span" variant="meta">
                      3일 전
                    </Text>
                  </span>
                </RowLines>
              </GridTableCell>
              <GridTableCell hideNarrow>
                <Badge variant="green">연결됨</Badge>
              </GridTableCell>
              <GridTableCell
                align="end"
                hideNarrow
                className="text-caption text-muted-foreground"
              >
                3일 전
              </GridTableCell>
              <GridTableCell align="end">
                <RowAction>다시 설치</RowAction>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Slack 앱 메뉴"
                >
                  <Ellipsis aria-hidden="true" />
                </Button>
              </GridTableCell>
            </GridTableRow>
          </GridTable>
        ) : (
          <div className="flex flex-col items-start gap-3">
            <Text variant="sub">이 에이전트의 Slack 앱이 아직 없습니다.</Text>
            {active ? null : (
              <Text variant="sub">
                에이전트를 먼저 켠 뒤 Slack 앱을 만들 수 있습니다.
              </Text>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={!active}>
                Slack 앱 만들고 설치
              </Button>
              <Button type="button" variant="outline">
                새로고침
              </Button>
            </div>
          </div>
        )}
      </SettingsSection>
      {made ? (
        <DangerZone title="위험 구역" titleAs="h3">
          <DangerZoneRow
            title="Slack 연결 해제"
            description="이 에이전트가 Slack에서 더 이상 메시지를 받지 않습니다."
            actionLabel="연결 해제"
            onAction={() => {}}
          />
          <DangerZoneRow
            title="Slack 앱 삭제"
            description="Slack에서 앱을 지웁니다. 되돌릴 수 없습니다."
            actionLabel="앱 삭제"
            onAction={() => {}}
          />
        </DangerZone>
      ) : null}
    </>
  );
}

export function AgentSlackTab({
  state,
  active = true,
}: {
  readonly state: TabState;
  /** The agent has an active release, so its app can be made. */
  readonly active?: boolean;
}) {
  return (
    <div className="flex flex-col gap-[var(--werft-space-section)] p-4">
      <SlackCard state={state} />
      {state === "none" ? null : (
        <>
          <Channels locked={state === "pending"} />
          <Basic />
        </>
      )}
      <AppSections state={state} active={active} />
    </div>
  );
}
