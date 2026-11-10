export const workspaceKo = {
  "workspace.title": "워크스페이스 설정",
  "workspace.description": "워크스페이스 전체에 적용되는 설정입니다.",
  "workspace.readOnlyMark": "읽기 전용",
  "workspace.name": "워크스페이스 이름",
  "workspace.nameHint": "콘솔과 알림에 보이는 이름입니다.",
  "workspace.nameFoot": "콘솔에서는 아직 바꿀 수 없습니다.",
  "workspace.id": "워크스페이스 ID",
  "workspace.idHint": "API와 CLI에서 이 워크스페이스를 가리킬 때 씁니다.",
  "workspace.idCopied": "워크스페이스 ID를 복사했습니다.",
  "workspace.models": "모델 허용 목록",
  "workspace.modelsHint":
    "에이전트 카드가 고를 수 있는 모델입니다. 설치 owner가 모델 연결마다 정합니다.",
  "workspace.modelsFoot": "설정의 모델 연결에서 관리합니다",
  "workspace.modelsEmpty": "이 설치에 등록된 모델이 없습니다.",
  "workspace.retention": "감사 기록 보존 기간",
  "workspace.retentionDays": "보존 기간(일)",
  "workspace.retentionUnit": "일",
  "workspace.retentionHint": "허용·거절한 요청 기록을 이 기간 동안 보관합니다.",
  "workspace.retentionFoot":
    "30일보다 짧게 할 수 없고, 소유자만 바꿀 수 있습니다.",
  "workspace.retentionFloor":
    "감사 기록은 30일보다 짧게 보존할 수 없습니다. 30일 이상(최대 3650일)으로 정하세요.",
  "workspace.retentionCeiling":
    "감사 기록은 최대 {max}일까지 보존할 수 있습니다. {max}일 이하로 정하세요.",
  "workspace.retentionSaved": "감사 기록을 {days}일 보존합니다.",
  "workspace.save": "저장",
  "workspace.guest": "Slack 게스트",
  "workspace.guestLabel": "Slack 게스트도 에이전트를 쓸 수 있게 하기",
  "workspace.guestOn": "켜짐",
  "workspace.guestOff": "꺼짐",
  "workspace.guestHint":
    "켜도 게스트는 먼저 웹에서 자기 Slack 계정을 연결해야 합니다. Slack Connect로 들어온 다른 조직 사람은 켜져 있어도 에이전트를 쓸 수 없습니다. 소유자나 관리자가 바꿀 수 있습니다.",
  "workspace.guestSavedOn": "이제 Slack 게스트도 에이전트를 쓸 수 있습니다.",
  "workspace.guestSavedOff": "이제 Slack 게스트는 에이전트를 쓸 수 없습니다.",
  "workspace.readOnly":
    "지금 설정입니다. 바꾸려면 워크스페이스 소유자나 관리자에게 요청하세요.",
  "workspace.retentionValue": "감사 기록을 {days}일 보존합니다.",
  "workspace.guestValueOn": "Slack 게스트도 에이전트를 쓸 수 있습니다.",
  "workspace.guestValueOff": "Slack 게스트는 에이전트를 쓸 수 없습니다.",
  "workspace.access": "에이전트 접근",
  "workspace.accessHint":
    "담당 팀 밖 구성원이 에이전트와 그 세션을 어디까지 다루는지 정합니다. 소유자·관리자, 에이전트 관리자, 담당 팀 구성원에게는 적용되지 않습니다.",
  "workspace.accessAgent": "담당 팀 밖 구성원의 에이전트 접근",
  "workspace.accessAgentFoot": "모든 에이전트에 적용됩니다.",
  "workspace.accessAgent.use": "보고 실행",
  "workspace.accessAgent.use.help":
    "에이전트 정보(이름·설명·담당 팀)를 보고 세션을 시작합니다. 설정은 보지 못합니다.",
  "workspace.accessAgent.view": "보기만",
  "workspace.accessAgent.view.help":
    "에이전트 정보를 보지만 세션을 시작하지 못합니다.",
  "workspace.accessAgent.none": "숨김",
  "workspace.accessAgent.none.help":
    "에이전트 목록에 보이지 않고 세션도 시작하지 못합니다.",
  "workspace.accessSessions": "워크스페이스 공개 세션",
  "workspace.accessSessionsFoot":
    "모든 에이전트의 세션에 적용됩니다. 다만 담당 팀이 필수가 되기 전에 팀이 없던 에이전트를 맡은 보관 팀에 아직 남아 있는 에이전트는 예외라, 실제 담당 팀으로 옮기기 전에는 이전처럼 모두에게 보입니다. 바꾸면 이미 있는 세션에도 바로 적용됩니다.",
  "workspace.accessSessions.managing_team": "담당 팀 안에만",
  "workspace.accessSessions.managing_team.help":
    "공유 범위가 워크스페이스인 세션을 소유자·관리자, 에이전트 관리자, 담당 팀 구성원만 봅니다. 담당 팀 밖 구성원은 자기 세션과 이름·팀으로 공유받은 세션만 봅니다.",
  "workspace.accessSessions.workspace": "모든 구성원",
  "workspace.accessSessions.workspace.help":
    "공유 범위가 워크스페이스인 세션을 모든 구성원이 봅니다.",
  "workspace.accessValue": "{setting}: {value}",
  "workspace.accessSaved": "에이전트 접근 설정을 저장했습니다.",
  "workspace.general": "일반",
  "integrations.nav": "연동",
  "integrations.title": "연동",
  "integrations.tabs": "연동 종류",
  "integrations.tab.slack": "Slack",
  "integrations.tab.github": "GitHub",
  "workspace.subnav": "워크스페이스 설정 메뉴",
  "workspace.basics": "기본 정보",
  "workspace.slackDescription":
    "에이전트를 Slack에서 쓸 수 있게 이 콘솔이 Slack 앱을 만들 때 쓰는 연결입니다. 에이전트마다 앱 설치와 채널은 에이전트의 Slack 탭에서 정합니다.",
  "workspace.slackCardHint":
    "이 콘솔이 계정 연결 앱과 에이전트마다 쓸 Slack 앱을 만듭니다. 앱을 만들려면 Slack의 App Configuration Token이 있어야 합니다.",
  "workspace.slackCount": "앱 {count}개",
  "workspace.slackNone": "연결 없음",
  "workspace.slackEmpty": "아직 등록된 토큰이 없습니다",
  "workspace.slackEmptyHint":
    "Slack에서 App Configuration Token을 만들어 등록하세요. 등록하면 에이전트의 Slack 탭에서 그 에이전트의 앱을 만들고 설치할 수 있습니다.",
  "workspace.tokenMenu": "App Configuration Token 메뉴",
  "workspace.slackApps": "자동으로 만든 Slack 앱",
  "workspace.slackAppsList": "앱 목록",
  "workspace.slackAppsHint":
    "여기서는 앱의 상태만 봅니다. 에이전트 앱의 설치, 연결 해제, 삭제는 그 에이전트의 Slack 탭에서 합니다.",
  "workspace.slackAppsNoSecret": "비밀값 없음",
  "workspace.slackAppsEmpty": "이 콘솔이 만든 Slack 앱이 아직 없습니다.",
  "workspace.slackAppsApp": "앱",
  "workspace.slackAppsAgent": "에이전트",
  "workspace.slackAppsState": "상태",
  "workspace.slackAppsUpdated": "갱신",
  "workspace.slackAppsMore": "자세히",
  "workspace.slackAppsLinkApp": "계정 연결 앱",
  "workspace.slackAppsAgentApp": "{name} 앱",
  "workspace.slackAppsNoId": "앱 ID 없음",
  "workspace.slackAppsNoAgent": "없음",
  "workspace.slackAppsConnected": "연결됨",
  "workspace.slackAppsNotInstalled": "설치 전",
  "workspace.slackAppsCreating": "만드는 중",
  "workspace.slackAppsDeleting": "삭제 중",
  "workspace.slackAppsSignIn": "Sign in with Slack",
  "workspace.tokenSubmit": "등록",
  "workspace.tokenStepPaste":
    "만들어진 두 값 중 Refresh Token(xoxe-1-로 시작)을 복사해 아래에 붙여 넣습니다. Access Token이 아닙니다.",
  "workspace.tokenStepGenerate":
    "Your App Configuration Tokens에서 이 Slack 워크스페이스의 Generate Token을 누릅니다.",
  "workspace.tokenStepOpen": "api.slack.com/apps를 엽니다.",
  "workspace.tokenReenter": "토큰 재등록",
  "workspace.tokenUnsetHint":
    "이미 만든 앱은 계속 동작합니다. 새 앱을 만들려면 토큰을 등록하세요.",
  "workspace.tokenSection": "Slack 앱 생성",
  "workspace.tokenSectionHint":
    "이 콘솔이 Slack 앱을 만들 때 쓰는 토큰입니다. 워크스페이스에 하나만 둡니다.",
  "workspace.token": "App Configuration Token",
  "workspace.tokenHint":
    "마지막 토큰 확인은 등록이나 자동 갱신 때 Slack이 토큰을 받은 시각입니다.",
  "workspace.tokenUnset": "등록 안 됨",
  "workspace.tokenActive": "토큰 확인됨",
  "workspace.tokenNeedsReentry": "재등록 필요",
  "workspace.tokenNeedsReentryHint":
    "저장된 토큰을 사용할 수 없습니다. 새 토큰을 등록해 주세요. 등록할 때까지 새 Slack 앱을 만들 수 없습니다. 이미 만든 앱은 계속 동작합니다.",
  "workspace.tokenAdd": "토큰 등록",
  "workspace.tokenReplace": "토큰 교체",
  "workspace.tokenNew": "Refresh Token",
  "workspace.tokenNewHint":
    "등록하면 Slack에서 바로 새 토큰으로 바꾸므로 붙여 넣은 값은 다시 쓸 수 없습니다. 값은 암호화해 저장하고 다시 보여 주지 않습니다. 이 토큰을 만든 Slack 사용자가 이 콘솔이 만드는 앱의 협업자가 됩니다.",
  "workspace.tokenMissing": "등록하려면 Refresh Token을 붙여 넣어 주세요.",
  "workspace.tokenStored": "App Configuration Token을 등록했습니다.",
  "workspace.tokenRejected":
    "Slack이 이 토큰을 받지 않았습니다. 방금 만든 Refresh Token인지, Access Token을 넣지 않았는지 확인하세요.",
  "workspace.danger": "위험 구역",
  "workspace.tokenDelete": "App Configuration Token 삭제",
  "workspace.tokenDeleteHint":
    "새 Slack 앱을 만들 수 없게 됩니다. 이미 만든 앱과 설치, 게스트 설정은 그대로입니다.",
  "workspace.tokenDeleteTitle": "App Configuration Token을 삭제할까요?",
  "workspace.delete": "삭제",
  "workspace.tokenIssuer": "발급자 {id}",
  "workspace.tokenTeam": "팀 {id}",
  "workspace.tokenCheckedAt": "마지막 토큰 확인 {at}",
  "workspace.tokenRegisteredBy": "마지막 등록자 {by}",
  "workspace.tokenVerified":
    "Slack이 토큰을 확인했습니다. 팀 {team}, 발급자 {user}.",
  "workspace.tokenIssuerChanged":
    "발급자가 바뀌어 앞으로 만드는 앱의 협업자도 바뀝니다.",
  "workspace.tokenStoreUnavailable":
    "비밀 저장소를 사용할 수 없습니다. 관리자에게 저장소 설정을 확인해 달라고 요청하세요.",
  "workspace.tokenDeleted": "App Configuration Token을 삭제했습니다.",
  "workspace.addressesTitle": "Slack 앱에 넣을 주소",
  "workspace.addressesHint":
    "콘솔의 공개 주소(CONSOLE_ORIGIN)에서 계산한 주소입니다. 콘솔이 만드는 앱에는 자동으로 들어가므로, Slack 앱을 직접 만들었을 때만 복사해서 넣으세요.",
  "workspace.addressRedirect": "Sign in with Slack 리디렉션 URL",
  "workspace.addressEvents": "이벤트 요청 URL",
  "workspace.addressEventsHint":
    "에이전트마다 다릅니다. {agent_id} 자리에 에이전트 ID를 넣으세요.",
  "workspace.addressCopy": "복사",
  "workspace.addressCopied": "주소를 복사했습니다.",
  "workspace.addressCopyFailed":
    "복사하지 못했습니다. 칸의 주소를 직접 선택해 복사하세요.",
  "workspace.addressNoConsole":
    "콘솔의 공개 주소(CONSOLE_ORIGIN)가 설정되지 않아 주소를 만들 수 없습니다. 운영자에게 설정을 요청하세요.",
  "workspace.addressNoHttps":
    "Slack은 https 주소만 부릅니다. 콘솔의 공개 주소가 https가 아니어서 이벤트 주소를 만들 수 없습니다.",
};

export const workspaceEn: Record<keyof typeof workspaceKo, string> = {
  "workspace.title": "Workspace settings",
  "workspace.description": "Settings that apply to the whole workspace.",
  "workspace.readOnlyMark": "Read-only",
  "workspace.name": "Workspace name",
  "workspace.nameHint": "The name shown in the console and in notifications.",
  "workspace.nameFoot": "It can't be changed from the console yet.",
  "workspace.id": "Workspace ID",
  "workspace.idHint":
    "Use this ID to identify the workspace in the API and CLI.",
  "workspace.idCopied": "Copied the workspace ID.",
  "workspace.models": "Allowed models",
  "workspace.modelsHint":
    "Models an agent's card can pick. The installation owner sets them per model connection.",
  "workspace.modelsFoot": "Managed under Model connections in Settings",
  "workspace.modelsEmpty": "This installation has no models registered.",
  "workspace.retention": "Audit log retention",
  "workspace.retentionDays": "Keep for (days)",
  "workspace.retentionUnit": "days",
  "workspace.retentionHint":
    "Records of allowed and denied requests are kept this long.",
  "workspace.retentionFoot": "At least 30 days. Only an owner can change this.",
  "workspace.retentionFloor":
    "Audit records must be kept for at least 30 days. Choose a number from 30 to 3650.",
  "workspace.retentionCeiling":
    "Audit records can be kept for at most {max} days. Choose {max} or fewer.",
  "workspace.retentionSaved": "Audit records are kept for {days} days.",
  "workspace.save": "Save",
  "workspace.guest": "Slack guests",
  "workspace.guestLabel": "Let Slack guests use agents",
  "workspace.guestOn": "On",
  "workspace.guestOff": "Off",
  "workspace.guestHint":
    "Even when this is on, a guest must first link their Slack account on the web. People from other organizations joining through Slack Connect can never use agents. An owner or admin can change this.",
  "workspace.guestSavedOn": "Slack guests can now use agents.",
  "workspace.guestSavedOff": "Slack guests can no longer use agents.",
  "workspace.readOnly":
    "These are the current settings. To change them, ask a workspace owner or admin.",
  "workspace.retentionValue": "Audit records are kept for {days} days.",
  "workspace.guestValueOn": "Slack guests can use agents.",
  "workspace.guestValueOff": "Slack guests cannot use agents.",
  "workspace.access": "Agent access",
  "workspace.accessHint":
    "Sets how far members outside an agent's responsible team go with the agent and its sessions. It does not apply to owners, admins, the agent's admins or its responsible team's members.",
  "workspace.accessAgent":
    "Agent access for members outside the responsible team",
  "workspace.accessAgentFoot": "Applies to every agent.",
  "workspace.accessAgent.use": "View and run",
  "workspace.accessAgent.use.help":
    "They see the agent's details (name, description, responsible team) and start sessions with it. They do not see its settings.",
  "workspace.accessAgent.view": "View only",
  "workspace.accessAgent.view.help":
    "They see the agent's details but cannot start sessions with it.",
  "workspace.accessAgent.none": "Hidden",
  "workspace.accessAgent.none.help":
    "The agent is not in their agent list, and they cannot start sessions with it.",
  "workspace.accessSessions": "Workspace-shared sessions",
  "workspace.accessSessionsFoot":
    "Applies to the sessions of every agent, except agents still held by the holding team that took in agents that had no team before one became required: they stay visible to everyone until given a real responsible team. A change applies to existing sessions at once.",
  "workspace.accessSessions.managing_team": "Responsible team only",
  "workspace.accessSessions.managing_team.help":
    "Sessions shared with the workspace are seen only by owners, admins, the agent's admins and its responsible team's members. Members outside the responsible team see their own sessions and those shared with them by name or team.",
  "workspace.accessSessions.workspace": "Every member",
  "workspace.accessSessions.workspace.help":
    "Sessions shared with the workspace are seen by every member.",
  "workspace.accessValue": "{setting}: {value}",
  "workspace.accessSaved": "Saved the agent access settings.",
  "workspace.general": "General",
  "integrations.nav": "Integrations",
  "integrations.title": "Integrations",
  "integrations.tabs": "Integration types",
  "integrations.tab.slack": "Slack",
  "integrations.tab.github": "GitHub",
  "workspace.subnav": "Workspace settings menu",
  "workspace.basics": "Basics",
  "workspace.slackDescription":
    "The Slack connection this console uses to make Slack apps, so agents can be used from Slack. Each agent's app install and channels are set in its own Slack tab.",
  "workspace.slackCardHint":
    "This console makes the account linking app and a Slack app for each agent. Making them takes a Slack App Configuration Token.",
  "workspace.slackCount": "Apps: {count}",
  "workspace.slackNone": "Not connected",
  "workspace.slackEmpty": "No token registered yet",
  "workspace.slackEmptyHint":
    "Make an App Configuration Token in Slack and register it here. Then each agent's Slack tab can make and install that agent's app.",
  "workspace.tokenMenu": "App Configuration Token menu",
  "workspace.slackApps": "Slack apps made here",
  "workspace.slackAppsList": "Apps",
  "workspace.slackAppsHint":
    "This page only shows each app's state. Install, disconnect and delete an agent app in that agent's Slack tab.",
  "workspace.slackAppsNoSecret": "No secret",
  "workspace.slackAppsEmpty": "This console has not made a Slack app yet.",
  "workspace.slackAppsApp": "App",
  "workspace.slackAppsAgent": "Agent",
  "workspace.slackAppsState": "Status",
  "workspace.slackAppsUpdated": "Updated",
  "workspace.slackAppsMore": "Details",
  "workspace.slackAppsLinkApp": "Account linking app",
  "workspace.slackAppsAgentApp": "{name} app",
  "workspace.slackAppsNoId": "No app ID",
  "workspace.slackAppsNoAgent": "None",
  "workspace.slackAppsConnected": "Connected",
  "workspace.slackAppsNotInstalled": "Not installed",
  "workspace.slackAppsCreating": "Creating",
  "workspace.slackAppsDeleting": "Deleting",
  "workspace.slackAppsSignIn": "Sign in with Slack",
  "workspace.tokenSubmit": "Register",
  "workspace.tokenStepPaste":
    "Of the two values, copy the Refresh Token (starts with xoxe-1-) and paste it below. Not the Access Token.",
  "workspace.tokenStepGenerate":
    "Under Your App Configuration Tokens, click Generate Token for this Slack workspace.",
  "workspace.tokenStepOpen": "Open api.slack.com/apps.",
  "workspace.tokenReenter": "Re-register token",
  "workspace.tokenUnsetHint":
    "Apps already made keep working. Register a token to make new ones.",
  "workspace.tokenSection": "Slack app creation",
  "workspace.tokenSectionHint":
    "The token this console uses to create Slack apps. A workspace holds one.",
  "workspace.token": "App Configuration Token",
  "workspace.tokenHint":
    "Last token check is when Slack last accepted the token, on registering or an automatic refresh.",
  "workspace.tokenUnset": "Not registered",
  "workspace.tokenActive": "Token verified",
  "workspace.tokenNeedsReentry": "Re-register needed",
  "workspace.tokenNeedsReentryHint":
    "The stored token can no longer be used. Register a new token. No new Slack app can be made until then. Apps already made keep working.",
  "workspace.tokenAdd": "Register token",
  "workspace.tokenReplace": "Replace token",
  "workspace.tokenNew": "Refresh Token",
  "workspace.tokenNewHint":
    "Registering exchanges it with Slack at once, so the pasted value cannot be used again. It is stored encrypted and never shown again. The Slack user who made this token becomes a collaborator on the apps this console makes.",
  "workspace.tokenMissing": "Paste the Refresh Token to register.",
  "workspace.tokenStored": "Registered the App Configuration Token.",
  "workspace.tokenRejected":
    "Slack rejected this token. Check that it is a newly made Refresh Token, not the Access Token.",
  "workspace.danger": "Danger zone",
  "workspace.tokenDelete": "Delete App Configuration Token",
  "workspace.tokenDeleteHint":
    "No new Slack app can be made. Apps already made, their installs and the guest setting stay as they are.",
  "workspace.tokenDeleteTitle": "Delete the App Configuration Token?",
  "workspace.delete": "Delete",
  "workspace.tokenIssuer": "Issuer {id}",
  "workspace.tokenTeam": "Team {id}",
  "workspace.tokenCheckedAt": "Last token check {at}",
  "workspace.tokenRegisteredBy": "Last registered by {by}",
  "workspace.tokenVerified":
    "Slack verified the token. Team {team}, issuer {user}.",
  "workspace.tokenIssuerChanged":
    "The issuer changed, so apps made from now on get a new collaborator.",
  "workspace.tokenStoreUnavailable":
    "The secret store is unavailable. Ask an administrator to check its configuration.",
  "workspace.tokenDeleted": "Deleted the App Configuration Token.",
  "workspace.addressesTitle": "Addresses for a Slack app",
  "workspace.addressesHint":
    "Computed from the console's public address (CONSOLE_ORIGIN). Apps the console makes get them automatically; copy them only for a Slack app you made yourself.",
  "workspace.addressRedirect": "Sign in with Slack redirect URL",
  "workspace.addressEvents": "Events Request URL",
  "workspace.addressEventsHint":
    "One per agent. Put the agent's ID where {agent_id} stands.",
  "workspace.addressCopy": "Copy",
  "workspace.addressCopied": "Address copied.",
  "workspace.addressCopyFailed":
    "Could not copy. Select the address in the field and copy it yourself.",
  "workspace.addressNoConsole":
    "The console's public address (CONSOLE_ORIGIN) is not set, so no address can be made. Ask the operator to set it.",
  "workspace.addressNoHttps":
    "Slack only calls https addresses. The console's public address is not https, so no events address can be made.",
};

export const workspaceJa: Record<keyof typeof workspaceKo, string> = {
  "workspace.title": "ワークスペース設定",
  "workspace.description": "ワークスペース全体に適用される設定です。",
  "workspace.readOnlyMark": "読み取り専用",
  "workspace.name": "ワークスペース名",
  "workspace.nameHint": "コンソールと通知に表示される名前です。",
  "workspace.nameFoot": "コンソールからはまだ変更できません。",
  "workspace.id": "ワークスペース ID",
  "workspace.idHint": "API や CLI でこのワークスペースを指すときに使います。",
  "workspace.idCopied": "ワークスペース ID をコピーしました。",
  "workspace.models": "許可モデル一覧",
  "workspace.modelsHint":
    "エージェントのカードが選べるモデルです。インストールの owner がモデル接続ごとに決めます。",
  "workspace.modelsFoot": "設定のモデル接続で管理します",
  "workspace.modelsEmpty": "このインストールに登録されたモデルはありません。",
  "workspace.retention": "監査ログの保存期間",
  "workspace.retentionDays": "保存日数",
  "workspace.retentionUnit": "日",
  "workspace.retentionHint":
    "許可・拒否されたリクエストの記録をこの期間保存します。",
  "workspace.retentionFoot": "最短 30 日です。変更できるのはオーナーのみです。",
  "workspace.retentionFloor":
    "監査ログは 30 日以上保存する必要があります。30〜3650 の数値を入力してください。",
  "workspace.retentionCeiling":
    "監査ログの保存期間は最長 {max} 日です。{max} 以下の数値を入力してください。",
  "workspace.retentionSaved": "監査ログを {days} 日間保存します。",
  "workspace.save": "保存",
  "workspace.guest": "Slack ゲスト",
  "workspace.guestLabel": "Slack ゲストにエージェントの利用を許可",
  "workspace.guestOn": "オン",
  "workspace.guestOff": "オフ",
  "workspace.guestHint":
    "オンの場合でも、ゲストは先に Web で Slack アカウントを連携する必要があります。Slack コネクトで参加したほかの組織の人は、エージェントを利用できません。変更できるのはオーナーまたは管理者です。",
  "workspace.guestSavedOn":
    "Slack ゲストがエージェントを利用できるようになりました。",
  "workspace.guestSavedOff":
    "Slack ゲストはエージェントを利用できなくなりました。",
  "workspace.readOnly":
    "現在の設定です。変更するには、ワークスペースのオーナーまたは管理者に依頼してください。",
  "workspace.retentionValue": "監査ログを {days} 日間保存します。",
  "workspace.guestValueOn": "Slack ゲストはエージェントを利用できます。",
  "workspace.guestValueOff": "Slack ゲストはエージェントを利用できません。",
  "workspace.access": "エージェントへのアクセス",
  "workspace.accessHint":
    "担当チーム外のメンバーがエージェントとそのセッションをどこまで扱えるかを決めます。オーナー・管理者、エージェント管理者、担当チームのメンバーには適用されません。",
  "workspace.accessAgent": "担当チーム外のメンバーのエージェントへのアクセス",
  "workspace.accessAgentFoot": "すべてのエージェントに適用されます。",
  "workspace.accessAgent.use": "表示と実行",
  "workspace.accessAgent.use.help":
    "エージェントの情報(名前・説明・担当チーム)を見て、セッションを開始します。設定は見られません。",
  "workspace.accessAgent.view": "表示のみ",
  "workspace.accessAgent.view.help":
    "エージェントの情報は見られますが、セッションは開始できません。",
  "workspace.accessAgent.none": "非表示",
  "workspace.accessAgent.none.help":
    "エージェント一覧に表示されず、セッションも開始できません。",
  "workspace.accessSessions": "ワークスペース公開のセッション",
  "workspace.accessSessionsFoot":
    "すべてのエージェントのセッションに適用されます。ただし、担当チームが必須になる前にチームがなかったエージェントを引き受けた保管チームに残っているエージェントは例外で、実際の担当チームへ移すまで従来どおり全員に見えます。変更すると既存のセッションにもすぐ適用されます。",
  "workspace.accessSessions.managing_team": "担当チーム内のみ",
  "workspace.accessSessions.managing_team.help":
    "共有範囲がワークスペースのセッションは、オーナー・管理者、エージェント管理者、担当チームのメンバーだけが見られます。担当チーム外のメンバーは、自分のセッションと名前・チームで共有されたセッションだけを見ます。",
  "workspace.accessSessions.workspace": "すべてのメンバー",
  "workspace.accessSessions.workspace.help":
    "共有範囲がワークスペースのセッションを、すべてのメンバーが見られます。",
  "workspace.accessValue": "{setting}: {value}",
  "workspace.accessSaved": "エージェントへのアクセス設定を保存しました。",
  "workspace.general": "一般",
  "integrations.nav": "連携",
  "integrations.title": "連携",
  "integrations.tabs": "連携の種類",
  "integrations.tab.slack": "Slack",
  "integrations.tab.github": "GitHub",
  "workspace.subnav": "ワークスペース設定メニュー",
  "workspace.basics": "基本情報",
  "workspace.slackDescription":
    "エージェントを Slack で使えるように、このコンソールが Slack アプリを作るときに使う連携です。エージェントごとのアプリのインストールとチャンネルは、エージェントの Slack タブで設定します。",
  "workspace.slackCardHint":
    "このコンソールがアカウント連携アプリとエージェントごとの Slack アプリを作成します。作成には Slack の App Configuration Token が必要です。",
  "workspace.slackCount": "アプリ {count} 件",
  "workspace.slackNone": "未接続",
  "workspace.slackEmpty": "登録されたトークンはまだありません",
  "workspace.slackEmptyHint":
    "Slack で App Configuration Token を作成して登録してください。登録すると、各エージェントの Slack タブでそのエージェントのアプリを作成してインストールできます。",
  "workspace.tokenMenu": "App Configuration Token のメニュー",
  "workspace.slackApps": "自動で作った Slack アプリ",
  "workspace.slackAppsList": "アプリ一覧",
  "workspace.slackAppsHint":
    "ここではアプリの状態だけを確認します。エージェントのアプリのインストール・連携解除・削除は、そのエージェントの Slack タブで行います。",
  "workspace.slackAppsNoSecret": "シークレットなし",
  "workspace.slackAppsEmpty":
    "このコンソールが作った Slack アプリはまだありません。",
  "workspace.slackAppsApp": "アプリ",
  "workspace.slackAppsAgent": "エージェント",
  "workspace.slackAppsState": "状態",
  "workspace.slackAppsUpdated": "更新",
  "workspace.slackAppsMore": "詳細",
  "workspace.slackAppsLinkApp": "アカウント連携アプリ",
  "workspace.slackAppsAgentApp": "{name} アプリ",
  "workspace.slackAppsNoId": "アプリ ID なし",
  "workspace.slackAppsNoAgent": "なし",
  "workspace.slackAppsConnected": "接続済み",
  "workspace.slackAppsNotInstalled": "未インストール",
  "workspace.slackAppsCreating": "作成中",
  "workspace.slackAppsDeleting": "削除中",
  "workspace.slackAppsSignIn": "Sign in with Slack",
  "workspace.tokenSubmit": "登録",
  "workspace.tokenStepPaste":
    "表示された 2 つの値のうち Refresh Token(xoxe-1- で始まる)をコピーして下に貼り付けます。Access Token ではありません。",
  "workspace.tokenStepGenerate":
    "Your App Configuration Tokens で、この Slack ワークスペースの Generate Token を押します。",
  "workspace.tokenStepOpen": "api.slack.com/apps を開きます。",
  "workspace.tokenReenter": "トークンを再登録",
  "workspace.tokenUnsetHint":
    "作成済みのアプリはそのまま動作します。新しいアプリを作成するにはトークンを登録してください。",
  "workspace.tokenSection": "Slack アプリの作成",
  "workspace.tokenSectionHint":
    "このコンソールが Slack アプリを作るときに使うトークンです。ワークスペースに 1 つだけ置きます。",
  "workspace.token": "App Configuration Token",
  "workspace.tokenHint":
    "最終トークン確認は、登録または自動更新で Slack がトークンを受け付けた日時です。",
  "workspace.tokenUnset": "未登録",
  "workspace.tokenActive": "トークン確認済み",
  "workspace.tokenNeedsReentry": "再登録が必要",
  "workspace.tokenNeedsReentryHint":
    "保存済みのトークンは使用できません。新しいトークンを登録してください。登録するまで新しい Slack アプリは作成できません。作成済みのアプリはそのまま動作します。",
  "workspace.tokenAdd": "トークンを登録",
  "workspace.tokenReplace": "トークンを置き換え",
  "workspace.tokenNew": "Refresh Token",
  "workspace.tokenNewHint":
    "登録するとすぐに Slack で新しいトークンに交換されるため、貼り付けた値は再利用できません。暗号化して保存し、再表示しません。このトークンを作成した Slack ユーザーが、このコンソールが作成するアプリのコラボレーターになります。",
  "workspace.tokenMissing": "登録するには Refresh Token を貼り付けてください。",
  "workspace.tokenStored": "App Configuration Token を登録しました。",
  "workspace.tokenRejected":
    "Slack がこのトークンを受け付けませんでした。新しく作成した Refresh Token か、Access Token を入れていないか確認してください。",
  "workspace.danger": "危険な操作",
  "workspace.tokenDelete": "App Configuration Token を削除",
  "workspace.tokenDeleteHint":
    "新しい Slack アプリを作成できなくなります。作成済みのアプリ、インストール、ゲスト設定はそのままです。",
  "workspace.tokenDeleteTitle": "App Configuration Token を削除しますか?",
  "workspace.delete": "削除",
  "workspace.tokenIssuer": "発行者 {id}",
  "workspace.tokenTeam": "チーム {id}",
  "workspace.tokenCheckedAt": "最終トークン確認 {at}",
  "workspace.tokenRegisteredBy": "最終登録者 {by}",
  "workspace.tokenVerified":
    "Slack がトークンを確認しました。チーム {team}、発行者 {user}。",
  "workspace.tokenIssuerChanged":
    "発行者が変わったため、今後作成するアプリのコラボレーターも変わります。",
  "workspace.tokenStoreUnavailable":
    "秘密情報ストアを利用できません。管理者に設定の確認を依頼してください。",
  "workspace.tokenDeleted": "App Configuration Token を削除しました。",
  "workspace.addressesTitle": "Slack アプリに入れるアドレス",
  "workspace.addressesHint":
    "コンソールの公開アドレス(CONSOLE_ORIGIN)から計算したアドレスです。コンソールが作るアプリには自動で入ります。Slack アプリを自分で作った場合だけ、コピーして入れてください。",
  "workspace.addressRedirect": "Sign in with Slack のリダイレクト URL",
  "workspace.addressEvents": "イベントのリクエスト URL",
  "workspace.addressEventsHint":
    "エージェントごとに異なります。{agent_id} の部分にエージェント ID を入れてください。",
  "workspace.addressCopy": "コピー",
  "workspace.addressCopied": "アドレスをコピーしました。",
  "workspace.addressCopyFailed":
    "コピーできませんでした。欄のアドレスを選択して、自分でコピーしてください。",
  "workspace.addressNoConsole":
    "コンソールの公開アドレス(CONSOLE_ORIGIN)が設定されていないため、アドレスを作れません。運用者に設定を依頼してください。",
  "workspace.addressNoHttps":
    "Slack は https のアドレスにしか接続しません。コンソールの公開アドレスが https ではないため、イベントのアドレスを作れません。",
};
