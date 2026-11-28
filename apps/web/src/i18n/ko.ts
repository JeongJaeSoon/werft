import { flowKo, formsKo, sessionsKo } from "@werft-ai/react";
import { achievementRulesKo } from "./achievement-rules.ts";
import { achievementsKo } from "./achievements.ts";
import { agentAccessKo } from "./agent-access.ts";
import { agentConversationsKo } from "./agent-conversations.ts";
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
  "slack.reauthorize.needed": "Slack 재승인 필요",
  "slack.reauthorize.body":
    "이 앱에 새 권한({scopes})이 더해졌지만 지금 설치는 아직 승인하지 않았습니다. 다시 승인할 때까지 이 권한이 필요한 기능만 꺼져 있고, 나머지는 그대로 동작합니다. 다시 승인을 누르면 앱 설정을 Slack에 보낸 뒤 Slack의 승인 화면으로 이동합니다.",
  "slack.reauthorize.action": "다시 승인",
  "slack.manifestSync.needed": "갱신 필요",
  "slack.manifestSync.config_token_inactive":
    "App Configuration Token이 활성 상태가 아니어서 Werft가 이 앱의 Slack 설정을 확인하거나 갱신하지 못했습니다. 새로 더해진 이벤트를 받지 못할 수 있습니다. 토큰을 다시 넣은 뒤 다시 확인을 누르세요.",
  "slack.manifestSync.events_url_unset":
    "이벤트 주소를 알 수 없어 이 앱의 Slack 설정을 갱신하지 못했습니다. Slack 연동 설정에서 주소를 확인한 뒤 다시 확인을 누르세요.",
  "slack.manifestSync.slack_refused":
    "Slack이 이 앱의 설정 갱신을 거절했습니다. 새로 더해진 이벤트를 받지 못할 수 있습니다. 다시 확인을 누르세요. 누르지 않으면 서버가 다음에 시작할 때 다시 시도합니다.",
  "slack.manifestSync.no_answer":
    "Slack이 이 앱의 설정 갱신에 답하지 않았습니다. 새로 더해진 이벤트를 받지 못할 수 있습니다. 다시 확인을 누르세요. 누르지 않으면 서버가 다음에 시작할 때 다시 시도합니다.",
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
  "slack.deletedCleanupFailed":
    "Werft에서는 Slack 앱을 삭제했지만 Slack 쪽 정리에 실패했습니다. Slack 앱 관리 화면(api.slack.com/apps)에서 앱을 지워 주세요.",
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
  "slack.rolloutSection": "대화 스위치",
  "slack.rollout": "조용히 듣기 (shadow)",
  "slack.rolloutHint":
    "켜면 이 에이전트가 듣기 설정이 '모든 글'인 채널의 글을 모아 끼어들지 판단하고 그 기록만 남깁니다. 그 판단으로 Slack에 글을 올리지는 않습니다. 끄면 모아 둔 글을 지우고 새 판단을 멈춥니다. 판단 기록과 채널 요약은 남습니다.",
  "slack.rollout.adminOnly": "워크스페이스 owner·admin만 바꿀 수 있습니다.",
  "slack.rollout.savedOn": "조용히 듣기를 켰습니다.",
  "slack.rollout.savedOff": "조용히 듣기를 껐습니다.",
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
  "slack.reportColumn": "보고 방식",
  "slack.report.notify_only": "알림만",
  "slack.report.progress": "진행 메시지 하나",
  "slack.report.per_step": "단계마다 새 글",
  "slack.report.default": "기본 (지금: {mode})",
  "slack.report.defaultPlain": "기본",
  "slack.reportOf": "{channel} 보고 방식",
  "slack.reportSaved":
    "보고 방식을 저장했습니다. 따로 고르지 않은 진행 중인 작업에도 바로 쓰입니다.",
  "slack.reportFailed": "{channel}의 보고 방식을 저장하지 못했습니다. {reason}",
  "slack.capColumn": "시간당 판단",
  "slack.capOf": "{channel} 시간당 판단 상한",
  "slack.capRange": "1에서 {max} 사이의 정수로 정하세요.",
  "slack.capSaved":
    "시간당 판단 상한을 저장했습니다. 다음 묶음부터 적용됩니다.",
  "slack.capFailed":
    "{channel}의 시간당 판단 상한을 저장하지 못했습니다. {reason}",
  "slack.judgments": "판단 기록",
  "slack.judgments.hint":
    "최근 {days}일 동안 이 에이전트가 채널 글에 끼어들지 판단한 기록입니다(shadow: Slack에 글을 올리지 않습니다). 글 본문은 링크를 눌러 Slack에서 봅니다. 비공개 채널의 기록과 숫자도 보입니다.",
  "slack.judgments.knobs":
    "판단이 너무 잦거나 드물면 채널의 듣기 설정, 시간당 판단 상한, 저장소의 에이전트 지침(AGENTS.md)으로 맞춥니다.",
  "slack.judgments.forbidden":
    "판단 기록은 워크스페이스 owner·admin과 이 에이전트의 관리자만 봅니다.",
  "slack.judgments.loading": "판단 기록을 불러오는 중입니다",
  "slack.judgments.empty": "볼 수 있는 판단 기록이 없습니다",
  "slack.judgments.emptyHint":
    "조용히 듣기를 켜고 듣기가 '모든 글'인 채널에 글이 쌓이면 판단 기록이 생깁니다.",
  "slack.judgments.byChannel": "채널별 판단",
  "slack.judgments.count": "판단 수",
  "slack.judgments.speakRate": "끼어들기 비율",
  "slack.judgments.speakOf": "{percent}% ({speak}건)",
  "slack.judgments.reasons": "이유 코드",
  "slack.judgments.reasonCount": "{reason} {count}",
  "slack.judgments.recent": "최근 판단",
  "slack.judgments.when": "판단 시각",
  "slack.judgments.decision": "판단",
  "slack.judgments.reason": "이유",
  "slack.judgments.reasonFilter": "이유로 거르기",
  "slack.judgments.reasonAll": "모든 이유",
  "slack.judgments.recentNone": "고른 조건의 판단이 최근 목록에 없습니다",
  "slack.judgments.answerFilter": "결과로 거르기",
  "slack.judgments.answerAll": "모든 결과",
  "slack.judgments.answer": "결과",
  "slack.judgments.answerNone": "없음",
  "slack.judgments.answer.replied": "답하기로 정함",
  "slack.judgments.answer.no_reply": "답하지 않기로 정함",
  "slack.judgments.answer.no_decision": "정하지 못하고 끝남",
  "slack.judgments.answer.budget_refused": "예산 거절",
  "slack.judgments.answer.source_deleted": "원문이 지워짐",
  "slack.judgments.answer.channel_stopped": "채널이 멈춤",
  "slack.judgments.answer.not_started": "시작하지 못함",
  "slack.judgments.message": "Slack 글",
  "slack.judgments.speak": "끼어들기",
  "slack.judgments.quiet": "조용히",
  "slack.judgments.open": "Slack에서 보기",
  "slack.judgments.openOf": "{channel}의 글을 Slack에서 보기",
  "slack.judgments.noRelease":
    "활성 릴리스가 없어 판단에 쓰는 에이전트 지침이 없습니다.",
  "slack.judgments.noSnapshot":
    "활성 릴리스는 지침을 남기기 전에 만들어 판단은 고정 기준만 씁니다. 새 릴리스를 만들면 저장소의 지침이 반영됩니다.",
  "slack.judgments.noRepository":
    "판단 지침은 저장소의 AGENTS.md로 정합니다. 저장소를 연결하면 쓸 수 있습니다.",
  "slack.judgments.instructions": "M1 지침: 릴리스 {release}, commit {commit}",
  "slack.judgments.instructionsAbsent":
    "M1 지침: 릴리스 {release}, commit {commit}에 지침 파일이 없어 고정 기준만 씁니다.",
  "slack.judgments.instructionsNewer":
    "저장소에 더 새 지침이 있습니다. 새 릴리스를 만들면 반영됩니다.",
  "slack.judgments.reason.not_for_agent": "에이전트에게 한 말이 아님",
  "slack.judgments.reason.human_conversation": "사람끼리의 대화",
  "slack.judgments.reason.already_handled": "이미 처리됨",
  "slack.judgments.reason.out_of_scope": "맡은 일 밖",
  "slack.judgments.reason.needs_agent": "에이전트가 필요함",
  "slack.judgments.reason.unclear": "분명하지 않음",
  "slack.judgments.reason.invalid_target": "답할 글을 고르지 못함",
  "slack.judgments.reason.budget_refused": "예산 거절",
  "slack.judgments.reason.concurrency_limited": "동시 호출 상한",
  "slack.judgments.reason.rate_limited": "시간당 상한 넘김",
  "slack.judgments.reason.input_too_large": "입력이 너무 큼",
  "slack.judgments.reason.no_active_release": "활성 릴리스 없음",
  "slack.judgments.reason.model_unavailable": "모델을 쓸 수 없음",
  "slack.judgments.reason.timed_out": "시간 초과",
  "slack.judgments.reason.unreachable": "모델에 닿지 못함",
  "slack.judgments.reason.provider_error": "모델 제공자 오류",
  "slack.judgments.reason.malformed": "답을 읽지 못함",
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
  "slack.emergencyStop.action": "긴급 정지",
  "slack.emergencyStop.actionOf": "{channel}에서 긴급 정지",
  "slack.emergencyStop.badge": "긴급 정지됨",
  "slack.emergencyStop.by": "{who}님이 {at}에 멈췄습니다. 이유: {reason}",
  "slack.emergencyStop.byUnknown": "{at}에 멈췄습니다. 이유: {reason}",
  "slack.emergencyStop.title": "{channel}에서 긴급 정지",
  "slack.emergencyStop.description":
    "이 채널에서 에이전트가 하던 일을 바로 멈추고 채널 사용을 끕니다. 진행 중인 작업은 끊기고, 아직 보내지 않은 글은 취소됩니다. 채널에는 관리자가 에이전트를 멈췄다고 알립니다.",
  "slack.emergencyStop.reason": "이유",
  "slack.emergencyStop.reasonHint": "감사 기록에 남습니다.",
  "slack.emergencyStop.reasonRequired": "이유를 입력하세요.",
  "slack.emergencyStop.reasonTooLong": "이유는 {max}자 이하로 입력하세요.",
  "slack.emergencyStop.cancel": "취소",
  "slack.emergencyStop.submit": "긴급 정지",
  "slack.emergencyStop.submitting": "멈추는 중",
  "slack.emergencyStop.done":
    "{channel}: 세션 {sessions}개와 작업 {turns}개를 멈추고, 보내지 않은 글 {posts}개를 취소했습니다.",
  "slack.emergencyStop.resumeTitle": "{channel} 다시 켜기",
  "slack.emergencyStop.resumeDescription":
    "다시 켜면 이 채널에서 에이전트가 다시 답합니다. 멈춘 세션은 저절로 이어지지 않습니다. 세션에 쓸 수 있는 사람이 재개해야 합니다.",
  "slack.emergencyStop.resumeSubmit": "다시 켜기",
  "slack.emergencyStop.resumeSubmitting": "켜는 중",
  "slack.emergencyStop.resumed": "{channel} 사용을 다시 켰습니다.",
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
  ...agentConversationsKo,
  ...usageKo,
  ...achievementsKo,
  ...achievementRulesKo,
  ...preferencesKo,
  ...errorsKo,
  ...formsKo,
} as const;

export type MessageKey = keyof typeof ko;
