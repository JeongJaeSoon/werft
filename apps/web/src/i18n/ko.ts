import { flowKo, formsKo, sessionsKo } from "@werft-ai/react";
import { achievementRulesKo } from "./achievement-rules.ts";
import { achievementsKo } from "./achievements.ts";
import { agentGitHubKo } from "./agent-github.ts";
import { agentsKo } from "./agents.ts";
import { apiKeysKo } from "./api-keys.ts";
import { authKo } from "./auth.ts";
import { commonKo } from "./common.ts";
import { errorsKo } from "./errors.ts";
import { githubKo } from "./github.ts";
import { githubUserLinkKo } from "./github-user-link.ts";
import { homeKo } from "./home.ts";
import { linkedKo } from "./linked.ts";
import { membersKo } from "./members.ts";
import { modelsKo } from "./models.ts";
import { outputsKo } from "./outputs.ts";
import { preferencesKo } from "./preferences.ts";
import { profilesKo } from "./profiles.ts";
import { sessionListKo } from "./session-list.ts";
import { settingsKo } from "./settings.ts";
import { shellKo } from "./shell.ts";
import { teamsKo } from "./teams.ts";
import { usageKo } from "./usage.ts";
import { workspaceKo } from "./workspace.ts";

/**
 * The message catalog's source of truth, spread together from one file per
 * area; a new key goes in its area's file, never here. Keys are
 * `<screen>.<element>`; shared words live under `common.*`, status screens
 * under `status.<kind>.*` and error guidance under `error.<API error code>`.
 * `{name}` is a variable. Every other locale is typed against these keys, so
 * a key added to an area's Korean object and not translated fails the
 * typecheck.
 */
export const slackKo = {
  "slack.error.config":
    "워크스페이스의 Slack 앱 생성 설정이 필요합니다. 관리자에게 설정을 요청하세요.",
  "slack.error.creating":
    "앱 생성 결과를 확인 중입니다. Slack에 앱이 있는지 관리자에게 확인한 뒤 새로고침하세요.",
  "slack.error.notInstalled": "Slack 앱을 설치한 뒤 채널을 연결하세요.",
  "slack.error.denied":
    "Slack에서 설치를 허용하지 않았습니다. Slack 탭에서 다시 설치할 수 있습니다.",
  "slack.error.expired":
    "설치 링크가 만료됐거나 이미 사용됐습니다. Slack 탭에서 다시 설치하세요.",
  "slack.error.gone":
    "Slack에 이 앱이 더 이상 없습니다. 위험 구역에서 앱을 삭제한 뒤 다시 설치하면 새 앱이 만들어집니다.",
  "slack.error.rejected":
    "Slack 앱이나 워크스페이스가 일치하지 않아 설치하지 못했습니다. Slack 탭에서 다시 시작하세요.",
  "slack.error.cursor":
    "채널 목록이 바뀌었습니다. 새로고침하여 처음부터 검색하세요.",
  "agent.tabs.slack": "Slack",
  "agents.flow.channels": "채널 연결",
  "slack.app": "Slack 앱",
  "slack.verifyNeeded":
    "앱은 설치했지만 이벤트 등록 확인이 필요합니다. 관리자에게 확인을 요청하세요.",
  "slack.joinHintAuto":
    "공개 채널은 반응을 켜면 봇이 자동으로 참여합니다. 비공개 채널은 /invite로 봇을 초대하세요.",
  "slack.appId": "앱 ID",
  "slack.state.none": "만들기 전",
  "slack.state.pending": "설치 대기",
  "slack.state.connected": "연결됨",
  "slack.state.reinstall": "재설치 필요",
  "slack.eventsPending.title": "Slack이 Request URL을 아직 확인하지 않았습니다",
  "slack.eventsPending.body":
    "Slack이 이 앱의 Request URL을 확인하기 전에는 초대·멘션·DM 이벤트가 오지 않습니다. 고급의 '다시 확인'으로 URL을 다시 보내세요. 그래도 남으면 앱 설정의 Event Subscriptions에서 Request URL의 Verify(또는 Retry)를 누르세요. 확인 요청이 도착하면 이 안내는 사라집니다.",
  "slack.eventsPending.open": "Event Subscriptions 열기",
  "slack.channelsLocked.title":
    "Request URL 확인 전에는 채널을 고를 수 없습니다",
  "slack.channelsLocked.body":
    "Slack이 이 앱의 Request URL을 확인해야 채널에서 이벤트가 옵니다. 고급의 '다시 확인'으로 URL을 다시 보내세요. 확인되면 바로 풀립니다.",
  "slack.channelsLocked.action": "다시 확인으로 이동",
  "slack.eventsUrl.title": "이벤트 Request URL",
  "slack.eventsUrl.hint":
    "Slack이 초대·멘션·DM을 보낼 주소입니다. 다시 확인하면 앱 설정에 URL을 다시 보내고 Slack의 확인 요청에 자동으로 답합니다.",
  "slack.eventsUrl.verified": "Slack 확인됨",
  "slack.eventsUrl.pending": "Slack 확인 대기",
  "slack.eventsUrl.failed": "등록 실패",
  "slack.eventsUrl.unsent": "아직 보내지 않음",
  "slack.eventsUrl.recheck": "다시 확인",
  "slack.eventsUrl.done": "Slack이 Request URL을 확인했습니다.",
  "slack.eventsUrl.sent":
    "Request URL을 Slack에 다시 보냈습니다. Slack이 확인하면 상태가 바뀝니다.",
  "slack.repositoryRequired.title": "Slack에서는 세션을 시작할 수 없습니다",
  "slack.repositoryRequired.body":
    "활성 릴리스의 프로필({profile})은 세션마다 저장소가 필요한데 릴리스에 쓸 수 있는 저장소가 없습니다(고르지 않았거나 카탈로그에서 빠졌습니다). Slack 멘션과 DM은 거절되고 스레드에 안내만 남습니다. 연결은 할 수 있습니다. 상세 설정에서 저장소를 쓸 수 있는 프로필로 저장하면 새 릴리스가 만들어집니다.",
  "slack.issuerChanged.title": "다른 Slack 사용자가 만든 앱입니다",
  "slack.issuerChanged.body":
    "앱을 만든 Slack 사용자({previous})와 지금 App Configuration Token의 사용자({user})가 다릅니다. 이 토큰으로는 앱을 설치하거나 고치지 못할 수 있습니다. 설치가 실패하면 {previous}의 토큰을 다시 등록하거나 {user}를 앱 공동 작업자로 추가하세요. 앱을 Slack에서 이미 지웠다면 위험 구역에서 앱을 삭제하고 다시 설치하세요.",
  "slack.profileUnavailable.title": "Slack에서는 세션을 시작할 수 없습니다",
  "slack.profileUnavailable.body":
    "활성 릴리스의 프로필({profile})이 지금 카탈로그에 없거나, 릴리스 뒤에 바뀌었거나, 운영자가 차단했습니다. Slack 멘션과 DM은 거절되고 스레드에 안내만 남습니다. 상세 설정에서 쓸 수 있는 프로필을 골라 저장하면 새 릴리스가 만들어집니다.",
  "slack.noActiveRelease.title": "활성 릴리스가 없습니다",
  "slack.noActiveRelease.body":
    "릴리스가 켜지기 전에는 Slack 멘션과 DM이 거절되고 스레드에 안내만 남습니다. 상세 설정에서 프로필을 골라 저장하면 첫 릴리스가 만들어집니다.",
  "slack.state.error": "오류",
  "slack.createInstall": "Slack 앱 만들고 설치",
  "slack.configToken.unset":
    "워크스페이스에 App Configuration Token이 등록되지 않아 앱을 만들 수 없습니다.",
  "slack.configToken.needs_reentry":
    "워크스페이스에 저장된 토큰을 사용할 수 없어 앱을 만들 수 없습니다.",
  "slack.configToken.settings": "Slack 연결 설정에서 토큰 등록",
  "slack.configToken.askAdmin": "소유자나 관리자에게 토큰 등록을 요청하세요.",
  "slack.install": "Slack 앱 설치",
  "slack.reinstall": "다시 설치",
  "slack.working": "준비 중…",
  "slack.refresh": "새로고침",
  "slack.delete": "앱 삭제",
  "slack.deleteTitle": "Slack 앱 삭제",
  "slack.deleteWarning":
    "Slack에서 앱을 지우고 저장한 자격도 삭제합니다. 되돌릴 수 없고, 다시 연결하면 새 앱이 생깁니다.",
  "slack.deleted": "Slack 앱을 삭제했습니다.",
  "slack.revoke": "연결 해제",
  "slack.revokeTitle": "Slack 연결 해제",
  "slack.revokeWarning":
    "이 에이전트의 Slack 신원과 채널 연결을 해제합니다. 이후 이벤트는 받지 않고, Slack 앱은 남아 다시 설치할 수 있습니다.",
  "slack.revoked": "Slack 연결을 해제했습니다.",
  "slack.activateFirst": "에이전트를 먼저 켠 뒤 Slack 앱을 만들 수 있습니다.",
  "slack.channels": "채널",
  "slack.sectionNav": "Slack 구역",
  "slack.manage": "관리",
  "slack.saved": "채널 사용 설정을 저장했습니다.",
  "slack.homeSaved": "홈 채널을 지정했습니다.",
  "slack.channelConnected": "채널을 연결했습니다.",
  "slack.dmSaved": "DM 받기 설정을 저장했습니다.",
  "slack.mentionOnlySavedOn": "@멘션했을 때만 반응합니다.",
  "slack.mentionOnlySavedOff": "멘션 없이도 반응합니다.",
  "slack.home": "홈 채널",
  "slack.setHome": "홈 지정",
  "slack.homeStep": "홈 채널 지정",
  "slack.pickHome": "홈 채널 고르기",
  "slack.homeStepHint":
    "에이전트가 소개와 알림을 올릴 홈 채널을 먼저 고르세요. 고른 채널은 바로 사용으로 켜집니다. 비공개 채널은 채널에서 /invite로 봇을 초대해야 합니다.",
  "slack.channelHome": "{channel} 홈 지정",
  "slack.channelConnect": "{channel} 연결",
  "slack.connectedChannels": "연결된 채널",
  "slack.channelsAudience":
    "이 채널의 모든 사람이 답을 읽습니다. 담당 팀 밖 사람도 포함됩니다.",
  "slack.noConnectedChannels": "연결된 채널이 없습니다",
  "slack.addChannelHint": "채널 추가에서 이 에이전트가 반응할 채널을 고르세요.",
  "slack.addChannel": "채널 추가",
  "slack.basic": "기본",
  "slack.advanced": "고급",
  "slack.connection": "연결",
  "slack.status": "상태",
  "slack.homeChannel": "홈 채널",
  "slack.homeUnset": "선택 안 됨",
  "slack.channelId": "채널 ID: {id}",
  "slack.channelsLoading": "채널을 불러오는 중입니다",
  "slack.danger": "위험 구역",
  "slack.botId": "봇 ID",
  "slack.mentionOnlyHint":
    "켜면 @멘션했을 때만, 끄면 멘션 없이 채널에 쓴 글에도 반응합니다. 어느 쪽이든 이미 대화 중인 스레드의 답글에는 멘션 없이도 답합니다.",
  "slack.dm": "다이렉트 메시지",
  "slack.dmSetting": "DM 받기",
  "slack.dmHint":
    "Slack 앱의 메시지 탭에서 1:1 대화를 받습니다. Slack 계정을 연동한 구성원만 쓸 수 있습니다.",
  "slack.public": "공개",
  "slack.private": "비공개",
  "slack.off": "꺼짐",
  "slack.on": "켜짐",
  "slack.inUse": "이 채널에서 사용",
  "slack.inUseOf": "{channel}에서 사용",
  "slack.mentionOnly": "멘션했을 때만 반응",
  "slack.search": "채널 찾기",
  "slack.invite": "참여 대기",
  "slack.privateInvite": "/invite 필요",
  "slack.add": "연결",
  "slack.noChannels":
    "찾은 채널이 없습니다. 비공개 채널은 먼저 /invite로 초대하세요.",
  "slack.partial": "일부 채널이 없거나 이전 검색 결과일 수 있습니다.",
  "slack.more": "더 보기",
  "slack.reinstallTitle": "Slack 앱 다시 설치",
  "slack.reinstallHint":
    "권한이나 이벤트 설정이 바뀌었을 때 다시 설치합니다. Slack 동의 화면으로 이동합니다.",
  "slack.installHint":
    "Slack 동의 화면으로 이동해 이 워크스페이스에 앱을 설치합니다.",
  "slack.installed": "Slack에 앱을 설치했습니다.",
  "slack.copyInvite": "/invite 명령 복사",
  "slack.inviteCommand": "/invite 명령",
  "slack.copied": "복사됨",
  "slack.copy": "복사",
  "slack.copyAppId": "앱 ID 복사",
  "slack.copyAppIdFailed":
    "클립보드에 복사하지 못했습니다. 앱 ID를 직접 선택해 복사하세요.",
  "slack.openInSlack": "Slack에서 열기",
  "slack.newTab": "(새 탭에서 열림)",
  "slack.copyFailed":
    "클립보드에 복사하지 못했습니다. 선택된 명령을 직접 복사하세요.",
} as const;

export const ko = {
  ...slackKo,
  ...commonKo,
  ...shellKo,
  ...authKo,
  ...homeKo,
  ...membersKo,
  ...teamsKo,
  ...agentsKo,
  ...modelsKo,
  ...profilesKo,
  ...settingsKo,
  ...sessionsKo,
  ...sessionListKo,
  ...flowKo,
  ...linkedKo,
  ...outputsKo,
  ...apiKeysKo,
  ...workspaceKo,
  ...githubKo,
  ...githubUserLinkKo,
  ...agentGitHubKo,
  ...usageKo,
  ...achievementsKo,
  ...achievementRulesKo,
  ...preferencesKo,
  ...errorsKo,
  ...formsKo,
} as const;

export type MessageKey = keyof typeof ko;
