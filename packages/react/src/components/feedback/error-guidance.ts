import type { ApiErrorCode } from "@werft-ai/contracts";

import type { Locale } from "../../messages/index.ts";

/**
 * 오류는 원문 대신 "할 일"을 먼저 말한다 (02 UX 설계 §9). The server message is
 * kept as the secondary line; this is what the reader acts on.
 */
export const ERROR_GUIDANCE: Record<ApiErrorCode, string> = {
  BAD_REQUEST: "입력을 확인하고 다시 보내세요.",
  UNAUTHORIZED: "로그인이 만료됐습니다 — 다시 로그인하세요.",
  FORBIDDEN: "권한이 없습니다 — 관리자에게 요청하세요.",
  BOOTSTRAP_DONE: "이미 관리자가 만들어져 있습니다 — 로그인 화면으로 가세요.",
  NOT_FOUND: "대상을 찾을 수 없습니다 — 목록에서 다시 여세요.",
  PAYLOAD_TOO_LARGE: "내용이 너무 큽니다 — 나눠서 보내세요.",
  REQUEST_TIMEOUT:
    "전송이 제때 끝나지 않았습니다 — 연결을 확인하고 다시 보내세요.",
  UNSUPPORTED_CAPABILITY:
    "허용되지 않은 프로필·저장소이거나 이 세션에서는 할 수 없는 작업입니다 — 목록에서 다시 고르거나 새 세션을 만드세요.",
  RATE_LIMITED: "요청이 몰렸습니다 — 잠시 뒤 다시 시도하세요.",
  STORAGE_LIMIT_EXCEEDED:
    "저장 한도를 다 썼습니다 — 운영자에게 한도를 늘려 달라고 요청하세요.",
  BUDGET_EXCEEDED:
    "세션 비용 또는 토큰 한도를 다 썼습니다 — 운영자에게 한도를 늘려 달라고 요청하세요.",
  WORKSPACE_QUOTA_EXCEEDED:
    "작업 공간 한도를 넘었습니다 — 파일을 정리해 사용량을 줄인 뒤 다시 시도하세요.",
  INTERNAL_ERROR: "서버에서 처리하지 못했습니다 — 잠시 뒤 다시 시도하세요.",
  REVISION_CONFLICT: "다른 사람이 먼저 바꿨습니다 — 최신 내용을 확인하세요.",
  IDEMPOTENCY_CONFLICT:
    "같은 요청이 이미 접수됐습니다 — 접수 결과를 확인하세요.",
  REQUEST_EXPIRED: "요청이 만료됐습니다 — 다시 요청하세요.",
  REQUEST_STALE: "화면이 오래됐습니다 — 새로 고친 뒤 다시 시도하세요.",
  SESSION_PAUSED: "세션이 일시정지 상태입니다 — 재개한 뒤 보내세요.",
  SESSION_RESUMING: "세션을 복원하는 중입니다 — 잠시 뒤 다시 시도하세요.",
  SESSION_CLOSED: "보관된 세션입니다 — 새 세션으로 이어가세요.",
  SESSION_CLOSING: "세션을 보관하는 중입니다 — 끝날 때까지 기다리세요.",
  SESSION_STOPPED: "종료된 세션입니다 — 재개한 뒤 보내세요.",
  RECOVERY_REQUIRED: "결과를 확인해야 합니다 — 복구 결정을 내리세요.",
  CHECKPOINT_UNAVAILABLE:
    "이어갈 저장 지점이 없거나 저장이 멈춰 처리하지 못했습니다 — 세션 상세의 안내를 확인하세요.",
  PAUSE_COMMITTING: "일시정지를 마무리하는 중입니다 — 잠시 뒤 다시 시도하세요.",
  PAUSE_CANCELLED: "일시정지가 취소됐습니다 — 현재 상태를 확인하세요.",
  CONTROL_SUPERSEDED:
    "더 최근 제어가 먼저 적용됐습니다 — 현재 상태를 확인하세요.",
  TURN_NOT_STARTED:
    "아직 시작하지 않은 턴은 중단할 수 없습니다 — 실행이 시작된 뒤 다시 시도하세요.",
  BACKEND_UNAVAILABLE: "서버가 응답하지 않습니다 — 잠시 뒤 다시 시도하세요.",
  LAUNCH_FAILED:
    "작업 환경을 여러 번 띄우지 못해 입력이 처리되지 않았습니다 — 담당자에게 알린 뒤 다시 보내세요.",
  LOGIN_LINK_REQUIRED:
    "이 이메일로 만든 계정이 이미 있어요 — 기존 계정으로 로그인한 뒤 설정에서 Google을 연결하세요.",
  TAKEOVER_REQUIRED:
    "요청한 분이 떠나 관리자가 이어받을 때까지 멈춰요 — 워크스페이스 owner에게 인수를 요청하세요.",
  INVITE_EXPIRED:
    "초대가 회수됐거나 새 초대로 바뀌었거나 만료됐습니다 — 관리자에게 새 초대를 요청하세요.",
  INVITE_USED: "이미 사용한 초대입니다 — 로그인 화면으로 가세요.",
  LAST_OWNER:
    "워크스페이스에는 owner가 한 명 이상 있어야 합니다 — 다른 사람을 먼저 owner로 바꾸세요.",
  SCOPE_NOT_GRANTABLE:
    "발급하는 사람이 지금 가진 권한보다 넓은 key는 만들 수 없고, 에이전트 key는 승인 권한을 갖지 못합니다 — scope를 줄여 다시 발급하세요.",
  RELEASE_PROFILE_MISMATCH:
    "이 release는 다른 프로필로 만들어졌습니다 — release의 프로필로 세션을 만드세요.",
  CREDENTIAL_UNBOUND:
    "연결 설정이 바뀌어 시작하지 못했어요 — 에이전트 관리자에게 문의하세요.",
  CREDENTIAL_REF_IN_USE:
    "이 자격 이름은 이미 다른 곳(에이전트 또는 Slack 앱 연결)에 묶여 있어 쓸 수 없어요 — 다른 이름을 고르세요.",
  SELF_PROTECTED:
    "자기 역할이나 접근은 직접 바꿀 수 없습니다 — 다른 owner나 admin에게 요청하세요.",
  MEMBER_DISABLED:
    "비활성화된 구성원의 역할은 바꿀 수 없습니다 — 먼저 다시 활성화하세요.",
  ACCOUNT_DISABLED:
    "계정이 정지된 사람입니다 — 계정 정지를 먼저 풀어야 역할을 바꾸거나 다시 활성화할 수 있습니다.",
  OWNER_PROTECTED:
    "owner 역할을 주거나 owner의 역할을 바꾸는 일은 owner만 할 수 있습니다 — owner에게 요청하세요.",
  PROFILE_DIGEST_MISMATCH:
    "이 release를 만든 뒤 프로필 설정이 바뀌었습니다 — 같은 버전을 다시 release한 뒤 활성화하세요.",
  PROFILE_BLOCKED:
    "운영자가 이 프로필이나 그 바탕 설치 프로필을 차단했습니다 — 차단이 풀릴 때까지 기다리거나 다른 프로필을 고르세요.",
  ALREADY_EXISTS: "같은 이름이 이미 있습니다 — 다른 slug를 고르세요.",
  CATALOG_MISMATCH:
    "이 세션의 프로필·저장소 조합이 더 이상 허용되지 않아 입력이 처리되지 않았습니다 — 운영자가 카탈로그를 되돌린 뒤 다시 보내세요.",
  SLACK_NOT_INSTALLED:
    "Slack이 아직 설치되지 않았어요 — owner·admin에게 Slack 설치를 요청하세요.",
  LINK_TEAM_MISMATCH:
    "연결된 Slack 워크스페이스가 아니에요 — 안내된 워크스페이스 계정으로 다시 시도하세요.",
  LINK_TAKEN:
    "이 Slack 계정은 다른 사용자에게 연결돼 있어요 — owner·admin에게 문의하세요.",
  LINK_EXISTS: "이미 연결된 Slack 계정이 있어요 — 해제한 뒤 다시 연결하세요.",
  AGENT_IDENTITY_TAKEN:
    "이 Slack 앱은 다른 에이전트에 연결돼 있어요 — 그 연결을 회수한 뒤 다시 연결하세요.",
  NOT_READY: "아직 준비되지 않았습니다 — 잠시 뒤 다시 시도하세요.",
  CURSOR_EXPIRED: "이어보기 위치가 만료됐습니다 — 처음부터 다시 불러오세요.",
  LEASE_EXPIRED: "실행 점유가 만료됐습니다 — 현재 상태를 확인하세요.",
  STALE_EPOCH: "오래된 실행에서 온 응답입니다 — 현재 상태를 확인하세요.",
  PUSH_SOURCE_MISSING:
    "push할 저장소나 저장 지점이 없습니다 — 세션이 한 번 이상 저장된 뒤 다시 요청하세요.",
  PUSH_REQUEST_OPEN:
    "이미 열린 push 요청이 있습니다 — 그 요청을 먼저 결정하세요.",
  PUSH_REQUEST_DECIDED: "이미 결정된 push 요청입니다 — 목록을 새로 고치세요.",
  PUSH_REQUEST_RESOLVED: "이미 결정된 push 요청입니다 — 목록을 새로 고치세요.",
  CHECKPOINT_MOVED:
    "요청 뒤에 세션이 다시 저장됐습니다 — 요청을 거부하고 새로 요청하세요.",
  PUSH_NOT_PUSHED:
    "아직 push되지 않은 요청입니다 — push가 끝난 뒤 PR을 여세요.",
  PULL_REQUEST_MISSING: "이 요청으로 연 PR이 없습니다 — PR을 먼저 여세요.",
  PULL_REQUEST_MERGED: "머지된 PR은 닫거나 다시 열 수 없습니다.",
  PULL_REQUEST_MERGE_BLOCKED:
    "GitHub가 지금은 머지하지 않습니다 — 필수 check, 리뷰, 대화 해결을 확인하세요.",
  PULL_REQUEST_CLOSED: "닫힌 PR은 머지할 수 없습니다 — 먼저 다시 여세요.",
  GITHUB_REFUSED:
    "플랫폼이 이 GitHub 작업을 막았습니다 — 에이전트의 GitHub 설정을 확인하세요.",
  GITHUB_APP_CONFLICT:
    "다른 역할의 GitHub App과 겹칩니다 — 작성용 App을 먼저 등록하고, 리뷰용 App은 다른 App으로 고르세요.",
  GITHUB_UNAVAILABLE:
    "GitHub에서 App의 설치나 저장소를 받지 못했습니다 — 잠시 뒤 다시 시도하세요. 계속되면 App 키를 확인하세요.",
  INSTALLATION_SUSPENDED:
    "이 설치가 GitHub에서 중지됐습니다 — 그 계정의 GitHub 설치 설정에서 다시 켜세요.",
  PENDING_REQUESTS_OPEN:
    "아직 답하지 않은 승인·질문이 있습니다 — 모두 답하거나 만료된 뒤 재개하세요.",
  PERMISSION_WAIT_ABOVE_PROFILE:
    "대기 시간이 프로필 한도보다 깁니다 — 프로필 값 이하로 줄이세요.",
  TEAM_MANAGES_AGENTS:
    "이 팀이 담당 팀인 에이전트가 있습니다 — 그 에이전트들의 담당 팀을 먼저 옮기세요.",
  VARIABLE_NAME_INVALID:
    "변수 이름은 대문자·숫자·밑줄만 쓰고 대문자로 시작해야 해요 — 64자까지입니다.",
  VARIABLE_NAME_RESERVED:
    "플랫폼이 직접 쓰는 이름이라 변수로 등록할 수 없어요 — 다른 이름을 고르세요.",
  VARIABLE_VALUE_INVALID:
    "값에 쓸 수 없는 문자가 있어요 — NUL 문자와 잘못된 문자를 빼고 다시 저장하세요.",
  VARIABLE_VALUE_TOO_LARGE: "값이 너무 커요 — 48 KB 이하로 줄이세요.",
  VARIABLE_QUOTA_EXCEEDED:
    "변수를 더 만들 수 없어요 — 쓰지 않는 변수를 지운 뒤 다시 시도하세요.",
  VARIABLE_UNRESOLVED:
    "이 에이전트가 쓰는 변수를 지금 받을 수 없어요 — 워크스페이스 관리자에게 문의하세요.",
  SECRET_ACK_REQUIRED:
    "엔진에 시크릿을 전달하면 모든 요청자와 도구가 읽을 수 있어요 — 위험 안내를 확인한 뒤 다시 저장하세요.",
  SECRET_GRANT_ALL_FORBIDDEN:
    "시크릿은 모든 에이전트에게 줄 수 없어요 — 받을 에이전트를 하나씩 고르세요.",
  SECRET_ENV_UNSUPPORTED:
    "아직 시크릿을 엔진에 전달하는 런타임이 없어요 — 일반 변수만 저장할 수 있습니다.",
  VERSION_MISMATCH:
    "다른 사람이 먼저 바꿨어요 — 새로 고쳐 최신 내용을 확인한 뒤 다시 저장하세요.",
  PRECONDITION_REQUIRED:
    "저장하려면 읽은 버전이 필요해요 — 새로 고친 뒤 다시 시도하세요.",
  CONFIG_TOKEN_INVALID:
    "Slack App Configuration Token을 쓸 수 없어요 — owner·admin이 새 token을 붙여 넣으세요.",
  SLACK_APP_CREATING: "Slack 앱을 만드는 중이에요 — 잠시 뒤 다시 확인하세요.",
  SLACK_APP_GONE:
    "Slack에 이 앱이 없어요 — Slack 탭에서 앱을 삭제하고 다시 설치하세요.",
  SLACK_LINK_NOT_CONFIGURED:
    "Slack 계정 연결을 아직 쓸 수 없어요 — 워크스페이스 관리자에게 연동 › Slack 설정을 요청하세요.",
  GITHUB_LINK_NOT_CONFIGURED:
    "GitHub 계정 연결을 아직 쓸 수 없어요 — 워크스페이스 관리자에게 연동 › GitHub의 사용자 연결 설정을 요청하세요.",
  AGENT_NOT_ACTIVE:
    "활성 release가 없는 에이전트예요 — release를 활성화한 뒤 다시 시도하세요.",
  SLACK_INSTALL_STATE_INVALID:
    "설치 링크가 만료됐거나 이미 썼어요 — 설치를 처음부터 다시 시작하세요.",
  SLACK_INSTALL_DENIED:
    'Slack에서 설치를 허용하지 않았어요 — 다시 시작해 "Allow"를 누르세요.',
  SLACK_INSTALL_REJECTED:
    "Slack 응답이 이 에이전트의 앱·workspace와 맞지 않아 저장하지 않았어요 — 설치를 다시 시작하세요.",
  SLACK_INSTALL_CONFLICT:
    "이 Slack 앱은 다른 workspace에 이미 설치돼 있어요 — 그쪽 설치를 먼저 해제하세요.",
};

const ERROR_GUIDANCE_EN: Record<ApiErrorCode, string> = {
  BAD_REQUEST: "Check what you entered and send it again.",
  UNAUTHORIZED: "Your sign-in has expired — sign in again.",
  FORBIDDEN: "You don't have permission — ask an administrator.",
  BOOTSTRAP_DONE: "An administrator already exists — go to the sign-in page.",
  NOT_FOUND: "It can't be found — open it again from the list.",
  PAYLOAD_TOO_LARGE: "The content is too large — send it in parts.",
  REQUEST_TIMEOUT:
    "The request didn't finish in time — check your connection and send it again.",
  UNSUPPORTED_CAPABILITY:
    "This profile or repository isn't allowed, or this session can't do that — pick again from the list or start a new session.",
  RATE_LIMITED: "Too many requests at once — try again shortly.",
  STORAGE_LIMIT_EXCEEDED:
    "The storage limit is used up — ask an operator to raise it.",
  BUDGET_EXCEEDED:
    "The session's cost or token limit is used up — ask an operator to raise it.",
  WORKSPACE_QUOTA_EXCEEDED:
    "The workspace exceeded its quota — remove files to reduce usage, then try again.",
  INTERNAL_ERROR: "The server couldn't handle it — try again shortly.",
  REVISION_CONFLICT: "Someone changed it first — check the latest version.",
  IDEMPOTENCY_CONFLICT:
    "The same request was already received — check its result.",
  REQUEST_EXPIRED: "The request has expired — make it again.",
  REQUEST_STALE: "This page is out of date — refresh it and try again.",
  SESSION_PAUSED: "The session is paused — resume it, then send.",
  SESSION_RESUMING: "The session is being restored — try again shortly.",
  SESSION_CLOSED: "This session is archived — continue in a new session.",
  SESSION_CLOSING: "The session is being archived — wait until it finishes.",
  SESSION_STOPPED: "This session has stopped — resume it, then send.",
  RECOVERY_REQUIRED: "The result needs checking — make a recovery decision.",
  CHECKPOINT_UNAVAILABLE:
    "There's no save point to continue from, or saving stalled — see the guidance on the session's page.",
  PAUSE_COMMITTING: "The pause is being completed — try again shortly.",
  PAUSE_CANCELLED: "The pause was cancelled — check the current state.",
  CONTROL_SUPERSEDED:
    "A more recent control was applied first — check the current state.",
  TURN_NOT_STARTED:
    "A turn that hasn't started can't be interrupted — try again once it's running.",
  BACKEND_UNAVAILABLE: "The server is unavailable — try again shortly.",
  LAUNCH_FAILED:
    "The work environment failed to start several times, so the input wasn't processed — tell the person in charge, then send it again.",
  LOGIN_LINK_REQUIRED:
    "An account with this email already exists — sign in with it, then connect Google in settings.",
  TAKEOVER_REQUIRED:
    "The requester has left, so this waits until an administrator takes it over — ask a workspace owner to take it over.",
  INVITE_EXPIRED:
    "The invitation was revoked, replaced or has expired — ask an administrator for a new one.",
  INVITE_USED:
    "This invitation has already been used — go to the sign-in page.",
  LAST_OWNER:
    "A workspace needs at least one owner — make someone else an owner first.",
  SCOPE_NOT_GRANTABLE:
    "A key can't be broader than its issuer's current permissions, and agent keys can't approve — narrow the scope and issue it again.",
  RELEASE_PROFILE_MISMATCH:
    "This release was made with a different execution profile — create the session with the release's profile.",
  CREDENTIAL_UNBOUND:
    "The connection settings changed, so it couldn't start — contact the agent's administrator.",
  CREDENTIAL_REF_IN_USE:
    "This credential name is already bound elsewhere (an agent or a Slack app connection) — pick another name.",
  SELF_PROTECTED:
    "You can't change your own role or access — ask another owner or admin.",
  MEMBER_DISABLED:
    "A deactivated member's role can't be changed — reactivate them first.",
  ACCOUNT_DISABLED:
    "This person's account is suspended — lift the suspension before changing their role or reactivating them.",
  OWNER_PROTECTED:
    "Only an owner can make someone an owner or change an owner's role — ask an owner.",
  PROFILE_DIGEST_MISMATCH:
    "The execution profile changed after this release was made — release the same version again, then activate it.",
  PROFILE_BLOCKED:
    "An operator blocked this profile or the installation profile it builds on — wait until it's unblocked or pick another profile.",
  ALREADY_EXISTS: "That name is already taken — pick another slug.",
  CATALOG_MISMATCH:
    "This session's profile and repository are no longer allowed together, so the input wasn't processed — send it again after an operator restores the catalog.",
  SLACK_NOT_INSTALLED:
    "Slack isn't installed yet — ask an owner or admin to install it.",
  LINK_TEAM_MISMATCH:
    "That isn't the connected Slack workspace — try again with an account in the workspace shown.",
  LINK_TAKEN:
    "This Slack account is connected to another user — contact an owner or admin.",
  LINK_EXISTS:
    "A Slack account is already connected — disconnect it, then connect again.",
  AGENT_IDENTITY_TAKEN:
    "This Slack app is connected to another agent — revoke that connection, then connect again.",
  NOT_READY: "It isn't ready yet — try again shortly.",
  CURSOR_EXPIRED:
    "The resume position has expired — load it again from the start.",
  LEASE_EXPIRED: "The execution lease has expired — check the current state.",
  STALE_EPOCH: "This response came from an old run — check the current state.",
  PUSH_SOURCE_MISSING:
    "There's no repository or save point to push — request it again after the session has saved at least once.",
  PUSH_REQUEST_OPEN:
    "A push request is already open — decide on that one first.",
  PUSH_REQUEST_DECIDED:
    "This push request has already been decided — refresh the list.",
  PUSH_REQUEST_RESOLVED:
    "This push request has already been decided — refresh the list.",
  CHECKPOINT_MOVED:
    "The session saved again after the request — reject it and request again.",
  PUSH_NOT_PUSHED:
    "This request hasn't been pushed yet — open the PR after the push finishes.",
  PULL_REQUEST_MISSING:
    "No PR was opened from this request — open the PR first.",
  PULL_REQUEST_MERGED: "A merged PR can't be closed or reopened.",
  PULL_REQUEST_MERGE_BLOCKED:
    "GitHub won't merge it now — check required checks, reviews and open conversations.",
  PULL_REQUEST_CLOSED: "A closed PR can't be merged — reopen it first.",
  GITHUB_REFUSED:
    "The platform blocked this GitHub action — check the agent's GitHub settings.",
  GITHUB_APP_CONFLICT:
    "It overlaps with a GitHub App in another role — register the authoring App first, and pick a different App for reviews.",
  PENDING_REQUESTS_OPEN:
    "Approvals or questions are still unanswered — answer them all, or let them expire, then resume.",
  PERMISSION_WAIT_ABOVE_PROFILE:
    "The wait is longer than the profile's limit — lower it to the profile's value or less.",
  TEAM_MANAGES_AGENTS:
    "This team is still the managing team of some agents — move them to another team first.",
  VARIABLE_NAME_INVALID:
    "A variable name starts with a capital letter and uses only capitals, digits and underscores — up to 64 characters.",
  VARIABLE_NAME_RESERVED:
    "The platform sets this name itself, so it can't be a variable — pick another name.",
  VARIABLE_VALUE_INVALID:
    "The value has a character that can't be stored — remove NUL and invalid characters, then save again.",
  VARIABLE_VALUE_TOO_LARGE:
    "The value is too large — keep it to 48 KB or less.",
  VARIABLE_QUOTA_EXCEEDED:
    "No more variables can be added — delete one you don't use, then try again.",
  VARIABLE_UNRESOLVED:
    "A variable this agent uses can't be delivered right now — ask a workspace administrator.",
  SECRET_ACK_REQUIRED:
    "A secret sent to the engine can be read by every requester and tool — confirm the warning, then save again.",
  SECRET_GRANT_ALL_FORBIDDEN:
    "A secret can't go to every agent — pick the agents one by one.",
  SECRET_ENV_UNSUPPORTED:
    "No runtime can carry a secret to the engine yet — only plain variables can be saved.",
  VERSION_MISMATCH:
    "Someone changed this first — refresh, check the latest content, then save again.",
  PRECONDITION_REQUIRED:
    "Saving needs the version you read — refresh and try again.",
  CONFIG_TOKEN_INVALID:
    "The Slack App Configuration Token can't be used — an owner or admin should paste a new token.",
  SLACK_APP_CREATING: "The Slack app is being created — check again shortly.",
  SLACK_APP_GONE:
    "Slack no longer has this app — delete it on the Slack tab and install again.",
  SLACK_LINK_NOT_CONFIGURED:
    "Slack account linking isn't available yet — ask a workspace administrator to set up Slack in Integrations.",
  GITHUB_LINK_NOT_CONFIGURED:
    "GitHub account linking isn't available yet — ask a workspace administrator to set up user linking in Integrations › GitHub.",
  AGENT_NOT_ACTIVE:
    "This agent has no active release — activate a release, then try again.",
  SLACK_INSTALL_STATE_INVALID:
    "The install link has expired or was already used — start the install again.",
  SLACK_INSTALL_DENIED:
    'Slack didn\'t allow the install — start again and press "Allow".',
  SLACK_INSTALL_REJECTED:
    "Slack's response didn't match this agent's app or workspace, so nothing was saved — start the install again.",
  SLACK_INSTALL_CONFLICT:
    "This Slack app is already installed in another workspace — remove that install first.",
  GITHUB_UNAVAILABLE:
    "Couldn't get the App's installations or repositories from GitHub — try again shortly. If it keeps happening, check the App key.",
  INSTALLATION_SUSPENDED:
    "This installation is suspended on GitHub — turn it back on in that account's GitHub installation settings.",
};

const ERROR_GUIDANCE_JA: Record<ApiErrorCode, string> = {
  BAD_REQUEST: "入力内容を確認して、もう一度送ってください。",
  UNAUTHORIZED:
    "ログインの有効期限が切れました — もう一度ログインしてください。",
  FORBIDDEN: "権限がありません — 管理者に依頼してください。",
  BOOTSTRAP_DONE:
    "管理者はすでに作成されています — ログイン画面に進んでください。",
  NOT_FOUND: "対象が見つかりません — 一覧から開き直してください。",
  PAYLOAD_TOO_LARGE: "内容が大きすぎます — 分けて送ってください。",
  REQUEST_TIMEOUT:
    "送信が時間内に終わりませんでした — 接続を確認して、もう一度送ってください。",
  UNSUPPORTED_CAPABILITY:
    "許可されていないプロファイル・リポジトリか、このセッションではできない操作です — 一覧から選び直すか、新しいセッションを作成してください。",
  RATE_LIMITED:
    "リクエストが集中しています — しばらくしてからもう一度お試しください。",
  STORAGE_LIMIT_EXCEEDED:
    "保存容量の上限に達しました — 運用者に上限の引き上げを依頼してください。",
  BUDGET_EXCEEDED:
    "セッションの費用またはトークンの上限に達しました — 運用者に上限の引き上げを依頼してください。",
  WORKSPACE_QUOTA_EXCEEDED:
    "作業領域の上限を超えました — ファイルを整理して使用量を減らしてから、もう一度お試しください。",
  INTERNAL_ERROR:
    "サーバーで処理できませんでした — しばらくしてからもう一度お試しください。",
  REVISION_CONFLICT:
    "他の人が先に変更しました — 最新の内容を確認してください。",
  IDEMPOTENCY_CONFLICT:
    "同じリクエストがすでに受け付けられています — 受付結果を確認してください。",
  REQUEST_EXPIRED:
    "リクエストの期限が切れました — もう一度リクエストしてください。",
  REQUEST_STALE:
    "画面が古くなっています — 再読み込みしてからもう一度お試しください。",
  SESSION_PAUSED: "セッションは一時停止中です — 再開してから送ってください。",
  SESSION_RESUMING:
    "セッションを復元しています — しばらくしてからもう一度お試しください。",
  SESSION_CLOSED:
    "アーカイブ済みのセッションです — 新しいセッションで続けてください。",
  SESSION_CLOSING:
    "セッションをアーカイブしています — 終わるまでお待ちください。",
  SESSION_STOPPED: "停止したセッションです — 再開してから送ってください。",
  RECOVERY_REQUIRED: "結果の確認が必要です — 復旧の判断をしてください。",
  CHECKPOINT_UNAVAILABLE:
    "続けられる保存地点がないか、保存が止まって処理できませんでした — セッション詳細の案内を確認してください。",
  PAUSE_COMMITTING:
    "一時停止を完了させています — しばらくしてからもう一度お試しください。",
  PAUSE_CANCELLED:
    "一時停止は取り消されました — 現在の状態を確認してください。",
  CONTROL_SUPERSEDED:
    "より新しい操作が先に適用されました — 現在の状態を確認してください。",
  TURN_NOT_STARTED:
    "まだ始まっていないターンは中断できません — 実行が始まってからもう一度お試しください。",
  BACKEND_UNAVAILABLE:
    "サーバーを利用できません — しばらくしてからもう一度お試しください。",
  LAUNCH_FAILED:
    "作業環境を何度か起動できず、入力は処理されませんでした — 担当者に知らせてから、もう一度送ってください。",
  LOGIN_LINK_REQUIRED:
    "このメールアドレスのアカウントがすでにあります — 既存のアカウントでログインし、設定で Google を連携してください。",
  TAKEOVER_REQUIRED:
    "依頼者が離れたため、管理者が引き継ぐまで止まります — ワークスペースの owner に引き継ぎを依頼してください。",
  INVITE_EXPIRED:
    "招待は取り消された、新しい招待に置き換わった、または期限切れです — 管理者に新しい招待を依頼してください。",
  INVITE_USED: "すでに使われた招待です — ログイン画面に進んでください。",
  LAST_OWNER:
    "ワークスペースには owner が 1 人以上必要です — 先に他の人を owner にしてください。",
  SCOPE_NOT_GRANTABLE:
    "発行する人の現在の権限より広い key は作れず、エージェントの key は承認権限を持てません — scope を狭めて発行し直してください。",
  RELEASE_PROFILE_MISMATCH:
    "この release は別のプロファイルで作られました — release のプロファイルでセッションを作成してください。",
  CREDENTIAL_UNBOUND:
    "接続設定が変わったため開始できませんでした — エージェントの管理者に問い合わせてください。",
  CREDENTIAL_REF_IN_USE:
    "この認証情報の名前はすでに別の場所(エージェントまたは Slack アプリの接続)に紐づいていて使えません — 別の名前を選んでください。",
  SELF_PROTECTED:
    "自分のロールやアクセスは自分で変更できません — 他の owner か admin に依頼してください。",
  MEMBER_DISABLED:
    "無効化されたメンバーのロールは変更できません — 先に有効化し直してください。",
  ACCOUNT_DISABLED:
    "アカウントが停止されている人です — 先にアカウント停止を解除しないと、ロールの変更や再有効化はできません。",
  OWNER_PROTECTED:
    "owner ロールの付与や owner のロール変更は owner にしかできません — owner に依頼してください。",
  PROFILE_DIGEST_MISMATCH:
    "この release を作った後にプロファイルの設定が変わりました — 同じバージョンを release し直してから有効化してください。",
  PROFILE_BLOCKED:
    "運用者がこのプロファイルか、そのもとになるインストールプロファイルをブロックしました — ブロックが解除されるまで待つか、別のプロファイルを選んでください。",
  ALREADY_EXISTS: "同じ名前がすでにあります — 別の slug を選んでください。",
  CATALOG_MISMATCH:
    "このセッションのプロファイルとリポジトリの組み合わせが許可されなくなったため、入力は処理されませんでした — 運用者がカタログを戻してから、もう一度送ってください。",
  SLACK_NOT_INSTALLED:
    "Slack はまだインストールされていません — owner・admin に Slack のインストールを依頼してください。",
  LINK_TEAM_MISMATCH:
    "連携している Slack ワークスペースではありません — 案内されたワークスペースのアカウントでもう一度お試しください。",
  LINK_TAKEN:
    "この Slack アカウントは別のユーザーに連携されています — owner・admin に問い合わせてください。",
  LINK_EXISTS:
    "すでに連携している Slack アカウントがあります — 解除してから連携し直してください。",
  AGENT_IDENTITY_TAKEN:
    "この Slack アプリは別のエージェントに接続されています — その接続を取り消してから接続し直してください。",
  NOT_READY:
    "まだ準備ができていません — しばらくしてからもう一度お試しください。",
  CURSOR_EXPIRED:
    "続きの位置の期限が切れました — 最初から読み込み直してください。",
  LEASE_EXPIRED: "実行の占有期限が切れました — 現在の状態を確認してください。",
  STALE_EPOCH: "古い実行からの応答です — 現在の状態を確認してください。",
  PUSH_SOURCE_MISSING:
    "push するリポジトリか保存地点がありません — セッションが一度以上保存されてから、もう一度リクエストしてください。",
  PUSH_REQUEST_OPEN:
    "すでに開いている push リクエストがあります — 先にそのリクエストを判断してください。",
  PUSH_REQUEST_DECIDED:
    "すでに判断済みの push リクエストです — 一覧を再読み込みしてください。",
  PUSH_REQUEST_RESOLVED:
    "すでに判断済みの push リクエストです — 一覧を再読み込みしてください。",
  CHECKPOINT_MOVED:
    "リクエストの後にセッションがまた保存されました — リクエストを拒否して、新しくリクエストしてください。",
  PUSH_NOT_PUSHED:
    "まだ push されていないリクエストです — push が終わってから PR を開いてください。",
  PULL_REQUEST_MISSING:
    "このリクエストで開いた PR がありません — 先に PR を開いてください。",
  PULL_REQUEST_MERGED: "マージ済みの PR は閉じることも再オープンもできません。",
  PULL_REQUEST_MERGE_BLOCKED:
    "GitHub は今はマージしません — 必須チェック、レビュー、未解決の会話を確認してください。",
  PULL_REQUEST_CLOSED:
    "クローズ済みの PR はマージできません — 先に再オープンしてください。",
  GITHUB_REFUSED:
    "プラットフォームがこの GitHub 操作をブロックしました — エージェントの GitHub 設定を確認してください。",
  GITHUB_APP_CONFLICT:
    "別の役割の GitHub App と重なっています — 先に作成用 App を登録し、レビュー用には別の App を選んでください。",
  PENDING_REQUESTS_OPEN:
    "まだ答えていない承認・質問があります — すべてに答えるか、期限が切れてから再開してください。",
  PERMISSION_WAIT_ABOVE_PROFILE:
    "待ち時間がプロファイルの上限より長いです — プロファイルの値以下にしてください。",
  TEAM_MANAGES_AGENTS:
    "このチームが担当チームのエージェントがあります — 先にそのエージェントの担当チームを移してください。",
  VARIABLE_NAME_INVALID:
    "変数名は大文字で始め、大文字・数字・アンダースコアだけを使います — 64文字までです。",
  VARIABLE_NAME_RESERVED:
    "プラットフォームが使う名前なので変数にできません — 別の名前を選んでください。",
  VARIABLE_VALUE_INVALID:
    "保存できない文字が値に含まれています — NUL と不正な文字を取り除いてから保存してください。",
  VARIABLE_VALUE_TOO_LARGE: "値が大きすぎます — 48 KB 以下にしてください。",
  VARIABLE_QUOTA_EXCEEDED:
    "これ以上変数を追加できません — 使っていない変数を削除してからやり直してください。",
  VARIABLE_UNRESOLVED:
    "このエージェントが使う変数を今は渡せません — ワークスペースの管理者に連絡してください。",
  SECRET_ACK_REQUIRED:
    "エンジンに渡したシークレットは、すべての依頼者とツールが読めます — 注意書きを確認してから保存してください。",
  SECRET_GRANT_ALL_FORBIDDEN:
    "シークレットはすべてのエージェントには渡せません — 渡すエージェントを一つずつ選んでください。",
  SECRET_ENV_UNSUPPORTED:
    "シークレットをエンジンに渡せるランタイムはまだありません — 保存できるのは通常の変数だけです。",
  VERSION_MISMATCH:
    "先に他の人が変更しました — 再読み込みして最新の内容を確認し、もう一度保存してください。",
  PRECONDITION_REQUIRED:
    "保存するには読み込んだバージョンが必要です — 再読み込みしてやり直してください。",
  CONFIG_TOKEN_INVALID:
    "Slack App Configuration Token を使えません — owner・admin が新しい token を貼り付けてください。",
  SLACK_APP_CREATING:
    "Slack アプリを作成しています — しばらくしてからもう一度確認してください。",
  SLACK_APP_GONE:
    "Slack にこのアプリがありません — Slack タブでアプリを削除し、もう一度インストールしてください。",
  SLACK_LINK_NOT_CONFIGURED:
    "Slack アカウントの連携はまだ使えません — ワークスペースの管理者に 連携 › Slack の設定を依頼してください。",
  GITHUB_LINK_NOT_CONFIGURED:
    "GitHub アカウントの連携はまだ使えません — ワークスペースの管理者に 連携 › GitHub のユーザー連携の設定を依頼してください。",
  AGENT_NOT_ACTIVE:
    "有効な release がないエージェントです — release を有効化してからもう一度お試しください。",
  SLACK_INSTALL_STATE_INVALID:
    "インストールのリンクは期限切れか、すでに使われています — インストールを最初からやり直してください。",
  SLACK_INSTALL_DENIED:
    "Slack でインストールが許可されませんでした — もう一度始めて「Allow」を押してください。",
  SLACK_INSTALL_REJECTED:
    "Slack の応答がこのエージェントのアプリ・workspace と合わないため保存しませんでした — インストールをやり直してください。",
  SLACK_INSTALL_CONFLICT:
    "この Slack アプリはすでに別の workspace にインストールされています — 先にそちらのインストールを解除してください。",
  GITHUB_UNAVAILABLE:
    "GitHub から App のインストールやリポジトリを取得できませんでした — しばらくしてからもう一度お試しください。続く場合は App のキーを確認してください。",
  INSTALLATION_SUSPENDED:
    "このインストールは GitHub で停止されています — そのアカウントの GitHub インストール設定で再び有効にしてください。",
};

/** Every locale's guidance; `ERROR_GUIDANCE` is the Korean one. */
export const ERROR_GUIDANCE_BY_LOCALE: Readonly<
  Record<Locale, Readonly<Record<ApiErrorCode, string>>>
> = {
  ko: ERROR_GUIDANCE,
  en: ERROR_GUIDANCE_EN,
  ja: ERROR_GUIDANCE_JA,
};

const UNKNOWN_GUIDANCE: Record<Locale, string> = {
  ko: "처리하지 못했습니다 — 잠시 뒤 다시 시도하세요.",
  en: "Something went wrong — try again shortly.",
  ja: "処理できませんでした — しばらくしてからもう一度お試しください。",
};

/** Unknown codes fall back to a neutral instruction rather than raw English. */
export function guidanceFor(
  code: string | undefined,
  locale: Locale = "ko",
): string | undefined {
  if (!code) return undefined;
  // A locale from untyped code would otherwise throw inside an error screen.
  const known = Object.hasOwn(ERROR_GUIDANCE_BY_LOCALE, locale) ? locale : "ko";
  const guidance = ERROR_GUIDANCE_BY_LOCALE[known];
  // `hasOwn`, not a plain lookup: the code arrives from the server, and
  // "__proto__" or "constructor" would otherwise hand React an object.
  if (!Object.hasOwn(guidance, code)) return UNKNOWN_GUIDANCE[known];
  return guidance[code as ApiErrorCode];
}
