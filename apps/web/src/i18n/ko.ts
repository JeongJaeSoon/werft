import { flowKo, formsKo, sessionsKo } from "@werft-ai/react";
import { achievementRulesKo } from "./achievement-rules.ts";
import { achievementsKo } from "./achievements.ts";
import { agentAccessKo } from "./agent-access.ts";
import { agentGitHubKo } from "./agent-github.ts";
import { agentsKo } from "./agents.ts";
import { apiKeysKo } from "./api-keys.ts";
import { auditLogKo } from "./audit-log.ts";
import { authKo } from "./auth.ts";
import { commonKo } from "./common.ts";
import { errorsKo } from "./errors.ts";
import { executionLimitsKo } from "./execution-limits.ts";
import { githubKo } from "./github.ts";
import { githubUserLinkKo } from "./github-user-link.ts";
import { homeKo } from "./home.ts";
import { linkedKo } from "./linked.ts";
import { loginMethodsKo } from "./login-methods.ts";
import { loginProvidersKo } from "./login-providers.ts";
import { membersKo } from "./members.ts";
import { modelsKo } from "./models.ts";
import { outputsKo } from "./outputs.ts";
import { preferencesKo } from "./preferences.ts";
import { sessionListKo } from "./session-list.ts";
import { settingsKo } from "./settings.ts";
import { shellKo } from "./shell.ts";
import { skillsKo } from "./skills.ts";
import { teamsKo } from "./teams.ts";
import { usageKo } from "./usage.ts";
import { workspaceKo } from "./workspace.ts";
import { workspaceMcpKo } from "./workspace-mcp.ts";

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
    "워크스페이스의 Slack 앱 생성 설정이 필요합니다. 오너나 어드민에게 설정을 요청하세요.",
  "slack.error.refused":
    "Slack이 요청을 거절했습니다(코드: {code}). 코드를 관리자에게 알려 주세요.",
  "slack.error.noAnswer":
    "Slack이 응답하지 않아 설치를 끝내지 못했습니다. Slack 탭에서 설치를 처음부터 다시 시작하세요.",
  "slack.error.unknown":
    "요청을 처리하지 못했습니다. 다시 시도해도 같을 수 있습니다(코드: {code}). 코드를 관리자에게 알려 주세요.",
  "slack.error.consoleOrigin":
    "콘솔의 공개 주소(CONSOLE_ORIGIN)가 설정되지 않아 Slack 앱을 만들 수 없습니다. 관리자에게 설정을 요청하세요.",
  "slack.error.eventsUrl":
    "Slack이 이벤트를 보낼 https 주소를 알 수 없습니다. 관리자에게 CONSOLE_ORIGIN 설정을 요청하거나, 이벤트를 콘솔과 따로 받으면 오너가 설정 > 연동 > Slack의 이벤트 입구 주소를 적으세요.",
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
  "slack.error.botUnknown":
    "이 Slack 워크스페이스의 활성 봇이 아닙니다. 지워졌거나 비활성이 된 봇, 또는 사람 계정입니다.",
  "slack.error.botOwn": "이 에이전트 자신의 봇은 고를 수 없습니다.",
  "slack.error.botWerftAgent":
    "이 Werft에 있는 다른 에이전트의 봇입니다. 에이전트끼리는 Slack으로 부를 수 없습니다.",
  "slack.error.botOtherTeam":
    "다른 Slack 워크스페이스의 봇입니다. Slack Connect로 들어온 봇은 고를 수 없습니다.",
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
  "slack.channelsLocked.title":
    "Request URL 확인 전에는 채널을 고를 수 없습니다",
  "slack.channelsLocked.bodyRecheck":
    "Slack이 이 앱의 Request URL을 확인하기 전에는 초대·멘션·DM·채널 이벤트가 오지 않습니다. '다시 확인'은 지금 주소를 Slack에 다시 보낼 뿐이고, 주소가 그대로면 Slack은 다시 확인하지 않을 수 있습니다. 확인 대기가 이어지면 앱 설정의 Event Subscriptions에서 Verify(또는 Retry)를 누르세요. 확인되면 이 안내는 저절로 사라집니다.",
  "slack.channelsLocked.body":
    "Slack이 이 앱의 Request URL을 확인하기 전에는 초대·멘션·DM·채널 이벤트가 오지 않습니다. 앱 설정의 Event Subscriptions에서 Verify(또는 Retry)를 누르세요. 확인되면 이 안내는 저절로 사라집니다.",
  "slack.channelsLocked.open": "Event Subscriptions 열기",
  "slack.eventsUrl.title": "이벤트 Request URL",
  "slack.eventsUrl.hint":
    "Slack이 초대·멘션·DM을 보낼 주소입니다. 다시 확인하면 앱 설정에 지금 주소를 다시 보냅니다. Slack이 확인 요청을 보내면 자동으로 답합니다.",
  "slack.eventsUrl.verified": "Slack 확인됨",
  "slack.eventsUrl.pending": "Slack 확인 대기",
  "slack.eventsUrl.failed": "등록 실패",
  "slack.eventsUrl.unsent": "아직 보내지 않음",
  "slack.eventsUrl.recheck": "다시 확인",
  "slack.eventsUrl.done": "Slack이 Request URL을 확인했습니다.",
  "slack.eventsUrl.reinstall":
    "manifest를 Slack에 다시 보냈습니다. 앱에 새 권한이 더해져, 앱을 다시 설치해야 적용됩니다.",
  "slack.eventsUrl.sent":
    "Request URL을 Slack에 다시 보냈습니다. 주소가 그대로면 Slack은 다시 확인하지 않을 수 있습니다. 확인 대기가 이어지면 앱 설정의 Event Subscriptions에서 Retry를 누르세요.",
  "slack.repositoryRequired.title": "Slack에서는 세션을 시작할 수 없습니다",
  "slack.repositoryRequired.body":
    "활성 릴리스({release})로는 Slack 세션이 시작되지 못합니다. 릴리스의 저장소가 카탈로그에서 빠졌거나 워크스페이스 상한이 허용하지 않거나, 에이전트의 GitHub 설정을 읽을 수 없기 때문입니다. Slack 멘션과 DM은 거절되고 스레드에 안내만 남습니다. 연결은 할 수 있습니다. GitHub 설정을 확인하고 상세 설정에서 다시 저장하면 새 릴리스가 만들어집니다.",
  "slack.issuerChanged.title": "다른 Slack 사용자가 만든 앱입니다",
  "slack.issuerChanged.body":
    "앱을 만든 Slack 사용자({previous})와 지금 App Configuration Token의 사용자({user})가 다릅니다. 이 토큰으로는 앱을 설치하거나 고치지 못할 수 있습니다. 설치가 실패하면 {previous}의 토큰을 다시 등록하거나 {user}를 앱 공동 작업자로 추가하세요. 앱을 Slack에서 이미 지웠다면 위험 구역에서 앱을 삭제하고 다시 설치하세요.",
  "slack.releaseUnavailable.title": "Slack에서는 세션을 시작할 수 없습니다",
  "slack.releaseUnavailable.body":
    "활성 릴리스({release})의 모델 연결이 꺼졌거나, 그 모델이 연결의 모델 목록에서 빠졌습니다. Slack 멘션과 DM은 거절되고 스레드에 안내만 남습니다. 상세 설정에서 쓸 수 있는 연결과 모델을 골라 저장하면 새 릴리스가 만들어집니다.",
  "slack.noActiveRelease.title": "활성 릴리스가 없습니다",
  "slack.noActiveRelease.body":
    "릴리스가 켜지기 전에는 Slack 멘션과 DM이 거절되고 스레드에 안내만 남습니다. 상세 설정에서 연결과 모델을 골라 저장하면 첫 릴리스가 만들어집니다.",
  "slack.state.error": "오류",
  "slack.createInstall": "Slack 앱 만들고 설치",
  "slack.configToken.unset":
    "워크스페이스에 App Configuration Token이 등록되지 않아 앱을 만들 수 없습니다.",
  "slack.configToken.needs_reentry":
    "워크스페이스에 저장된 토큰을 사용할 수 없어 앱을 만들 수 없습니다.",
  "slack.configToken.settings": "연동 > Slack에서 토큰 등록",
  "slack.configToken.askAdmin": "오너나 어드민에게 토큰 등록을 요청하세요.",
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
  "slack.cardHint": "이 에이전트가 Slack에서 쓰는 앱, 주소, 채널입니다.",
  "slack.tokenHint":
    "이 에이전트의 Slack 앱을 만들 때 쓰는 워크스페이스의 {token}입니다. 등록과 교체는 연동 > Slack에서 합니다.",
  "slack.tokenManage": "연동 > Slack에서 관리",
  "slack.addressesHint":
    "이 에이전트의 앱이 쓰는 이벤트 요청 URL입니다. 콘솔이 앱을 만들 때 자동으로 넣고, Slack이 이 주소를 확인해야 채널 글을 받습니다.",
  "slack.appsHint":
    "이 콘솔이 이 에이전트를 위해 만든 Slack 앱입니다. 설치와 다시 설치는 여기서, 연결 해제와 삭제는 위험 구역에서 합니다.",
  "slack.appsEmpty": "이 에이전트의 Slack 앱이 아직 없습니다.",
  "slack.appName": "{name} 앱",
  "slack.appMenu": "Slack 앱 메뉴",
  "slack.basicHint": "이 에이전트가 DM과 멘션에 반응하는 방식입니다.",
  "slack.notice": "고지 승인",
  "slack.noticeHint":
    "이 에이전트가 Slack 채널의 글을 듣기 전에 워크스페이스 owner·admin이 아래 고지를 읽고 승인합니다.",
  "slack.notice.state.no_notice": "고지 준비 중",
  "slack.notice.state.not_installed": "설치 전",
  "slack.notice.state.not_approved": "승인 전",
  "slack.notice.state.reapproval_required": "다시 승인 필요",
  "slack.notice.state.approved": "승인됨",
  "slack.notice.placeholder":
    "아직 게시된 고지가 없습니다. 고지가 게시되면 여기서 읽고 승인할 수 있습니다.",
  "slack.notice.notInstalled": "Slack 앱을 설치한 뒤 승인할 수 있습니다.",
  "slack.notice.reapprovalHint":
    "고지가 바뀌어 다시 승인해야 합니다. 다시 승인할 때까지 이 에이전트는 채널의 글을 듣지 않습니다.",
  "slack.notice.languageNote": "이 고지는 일본어와 한국어로 제공됩니다.",
  "slack.notice.language": "고지 언어",
  "slack.notice.version": "고지 {version}판",
  "slack.notice.approvals": "승인 기록",
  "slack.notice.team": "Slack 팀 {team}",
  "slack.notice.older": "이전 판",
  "slack.notice.approve": "승인",
  "slack.notice.reapprove": "다시 승인",
  "slack.notice.revoke": "승인 철회",
  "slack.notice.revokeConsequence":
    "이 에이전트는 다시 승인할 때까지 Slack 채널의 글을 듣지 않습니다.",
  "slack.notice.adminOnly": "워크스페이스 owner·admin만 승인할 수 있습니다.",
  "slack.notice.approvedNotice": "고지를 승인했습니다.",
  "slack.notice.revokedNotice": "고지 승인을 철회했습니다.",
  "slack.rollout": "조용히 듣기 (shadow)",
  "slack.rolloutHint":
    "켜면 이 에이전트가 듣기 설정이 '모든 글'인 채널의 글을 모아 끼어들지 판단하고 그 기록만 남깁니다. 그 판단으로 Slack에 글을 올리지는 않습니다. 끄면 모아 둔 글을 지우고 새 판단을 멈춥니다. 판단 기록과 채널 요약은 남습니다.",
  "slack.rollout.locked": "고지를 승인한 뒤 켤 수 있습니다.",
  "slack.rollout.adminOnly": "워크스페이스 owner·admin만 바꿀 수 있습니다.",
  "slack.rollout.savedOn": "조용히 듣기를 켰습니다.",
  "slack.rollout.savedOff": "조용히 듣기를 껐습니다.",
  "slack.notice.stale":
    "그사이 고지가 바뀌었습니다. 새 고지를 읽고 다시 승인하세요.",
  "slack.channelColumn": "채널",
  "slack.useColumn": "사용",
  "slack.listenColumn": "듣기",
  "slack.listen.free": "모든 글",
  "slack.listen.mention": "멘션에만",
  "slack.listen.off": "듣지 않음",
  "slack.listenOf": "{channel} 듣기",
  "slack.listenHint":
    "듣기 설정은 에이전트의 대화 스위치를 켠 뒤부터 적용됩니다.",
  "slack.listenSaved": "듣기 설정을 저장했습니다.",
  "slack.listenSavedDropped":
    "듣기 설정을 저장했습니다. 이 채널에 쌓인 판단 대기 글은 지웠습니다.",
  "slack.listenRefused": "저장 안 됨",
  "slack.listenFailed": "{channel}의 듣기 설정을 저장하지 못했습니다. {reason}",
  "slack.listenExternalShared":
    "{channel}: 외부 조직과 공유한 채널은 멘션으로만 들을 수 있습니다. 멘션에만이나 듣지 않음으로 정하세요.",
  "slack.basic": "기본",
  "slack.advanced": "고급",
  "slack.homeChannel": "홈 채널",
  "slack.homeUnset": "선택 안 됨",
  "slack.channelId": "채널 ID: {id}",
  "slack.channelsLoading": "채널을 불러오는 중입니다",
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
  "slack.inUseOf": "{channel}에서 사용",
  "slack.mentionOnly": "멘션했을 때만 반응",
  "slack.bots": "답할 봇",
  "slack.botsHint":
    "고른 봇이 이 에이전트를 직접 @멘션하면 답합니다. 한 스레드에서 사람 없이 봇끼리 5번 주고받으면 멈추고, 사람이 글을 쓰면 다시 셉니다. 봇이 연 대화는 개인 연결을 쓰지 않습니다.",
  "slack.botsNone": "없음",
  "slack.botsCount": "{count}개",
  "slack.botsEdit": "변경",
  "slack.botsTitle": "답할 봇 고르기",
  "slack.botsDialogHint":
    "이 Slack 워크스페이스에 있는 봇만 고를 수 있습니다. 이 Werft의 다른 에이전트 봇은 고를 수 없습니다.",
  "slack.botsEmpty": "고를 수 있는 봇이 없습니다.",
  "slack.botsSave": "저장",
  "slack.botsSaved": "답할 봇을 저장했습니다.",
  "slack.botGone": "Slack에서 사라짐",
  "slack.botsTruncated":
    "워크스페이스가 커서 Slack 목록을 끝까지 읽지 못했습니다. 위에 없는 봇은 Slack 사용자 ID로 추가하세요. 추가하면 바로 저장됩니다.",
  "slack.botAddById": "Slack 사용자 ID로 추가",
  "slack.botAdd": "추가",
  "slack.botAdded": "봇을 추가했습니다.",
  "slack.botIdInvalid": "U 또는 W로 시작하는 Slack 사용자 ID를 넣으세요.",
  "slack.search": "채널 찾기",
  "slack.privateInvite": "/invite 필요",
  "slack.pendingApproval": "승인 대기",
  "slack.pendingApprovalHint":
    "오너나 어드민이 승인하기 전에는 이 채널의 메시지에 답하지 않습니다.",
  "slack.approve": "승인",
  "slack.approveChannel": "채널 승인: {channel}",
  "slack.approved": "채널을 승인했습니다.",
  "slack.left": "나감",
  "slack.inactive": "비활성",
  "slack.gone": "삭제됨",
  "slack.goneHint":
    "Slack에서 채널이 삭제되어 메시지를 받지도 보내지도 않습니다.",
  "slack.leftHint":
    "봇이 채널에서 나가 메시지를 받지도 보내지도 않습니다. 채널에 다시 초대하면 승인 대기로 돌아옵니다.",
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
  "slack.inviteTitle": "채널에 초대",
  "slack.inviteHint":
    "Slack 채널 입력창에 붙여 넣어 보내면 봇이 그 채널에 초대됩니다.",
  "slack.openInSlack": "Slack에서 열기",
  "slack.newTab": "(새 탭에서 열림)",
  "slack.copyFailed":
    "클립보드에 복사하지 못했습니다. 선택된 명령을 직접 복사하세요.",
  "slack.copyInviteFailed":
    "클립보드에 복사하지 못했습니다. 명령 줄을 직접 선택해 복사하세요.",
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
  ...settingsKo,
  ...sessionsKo,
  ...sessionListKo,
  ...flowKo,
  ...linkedKo,
  ...loginMethodsKo,
  ...loginProvidersKo,
  ...executionLimitsKo,
  ...auditLogKo,
  ...outputsKo,
  ...apiKeysKo,
  ...workspaceKo,
  ...workspaceMcpKo,
  ...skillsKo,
  ...githubKo,
  ...githubUserLinkKo,
  ...agentGitHubKo,
  ...agentAccessKo,
  ...usageKo,
  ...achievementsKo,
  ...achievementRulesKo,
  ...preferencesKo,
  ...errorsKo,
  ...formsKo,
} as const;

export type MessageKey = keyof typeof ko;
