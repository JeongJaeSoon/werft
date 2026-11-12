# 웹 로그인 선택·팀·연동 계정·API key·워크스페이스 설정

로그인 화면은 비밀번호와 켜진 로그인 공급자 중 고르게 한다(켜진 공급자가 있을 때만 그 버튼). 로그인한 사람은 구성원의 팀 탭에서 팀을, 사이드바에서 연동 계정, 내 key, 워크스페이스 설정(owner·admin)으로 간다. 화면 전체를 못 쓰는 메뉴는 `GET /v1/auth/me`의 `permissions`로 숨기고, 바꿀 권한이 없는 화면은 지금 값만 읽기 전용으로 보인다(admin처럼 일부만 바꿀 수 있으면 그 칸만 비활성+이유). 서버가 판정한다.

## Sub-features

- `login-choice` `/login`에 비밀번호 폼과 "또는" 아래 켜진 로그인 공급자마다 "<이름> 계정으로 로그인". `GET /v1/auth/login-methods`의 `providers`가 비면 "또는"과 버튼이 없다.
- `provider-callback` 공급자가 `/auth/callback/<공급자 id>?code&state`(공급자에 따라 `iss`도)로 돌려보내면 한 번만 교환하고 로그인 전 경로(없으면 `/`)로 간다. 401·403·409(`LOGIN_LINK_REQUIRED`)·취소는 각자의 문구.
- `menu-by-role` 사이드바. member: 홈·세션·에이전트·구성원·연동 계정·내 key·언어·테마. owner·admin은 워크스페이스 설정이 더 있다. 팀은 구성원의 팀 탭이다.
- `teams` `/members/teams` 만들기(같은 이름이면 "같은 이름의 팀이 이미 있습니다 — 다른 이름을 쓰세요.") → `/members/teams/{id}` 이름 바꾸기, "추가할 사람" select → "구성원 추가"(수락 없음, "<이름>님을 팀에 추가했습니다.")·빼기, "팀 삭제"(확인 대화상자). member는 홈과 `/teams`의 "내가 속한 팀"에서 자기 팀을 본다(`GET /v1/my-teams`, 홈은 팀이 없으면 섹션이 없다). 팀 이름을 누르면 그 팀 상세가 읽기 전용으로 열린다(이름·구성원 목록만, 이름 바꾸기·구성원 추가와 빼기·팀 삭제는 없음). 속하지 않은 팀의 상세는 `403`.
- `agent-admins` `/agents/{id}`의 "관리자" 탭(`?tab=admins`): "관리자로 추가할 사람"·"관리자로 추가할 팀" select와 "사람 추가"·"팀 추가" → "<이름>을(를) 관리자로 추가했습니다.", "빼기". 관리자가 아니면 이유만 보이고 관리자 목록을 묻지 않는다.
- `linked-slack` `/settings/linked-accounts`는 제공자 목록(GitHub "준비 중", Slack "연결 안 됨"/"연결됨", Google Workspace "준비 중")이다. Slack 행의 "연결"(`aria-label` "Slack 계정 연결") → Slack 동의 → `/settings/linked-accounts/slack` 콜백이 목록으로 돌아온다 → "연결 해제". 연결이 하나라도 있으면 "연결" 버튼은 없고 행마다 "연결 해제"만 있다. 연결 행은 Slack이 준 이름이 있으면 `표시 이름 · 워크스페이스 이름`과 그 아래 `사용자 ID … · 워크스페이스 ID …`, 이름이 없으면(이름을 저장하기 전에 만든 연결) `Slack 사용자 U… (워크스페이스 T…)`다. mock은 `MOCK_SLACK_TEAM_NAME`·`MOCK_SLACK_USER_NAME`(기본 빈 값)을 id_token에 싣고, `slack-consent … nameless`는 그 이름 없이 동의한다.
- `api-keys` 사이드바 "API key". 제목은 탭마다 "API key"이고 `aria-label` "key 목록" 탭이 "개인 key"(`/settings/api-keys`)·"에이전트 key"(`/settings/api-keys/agents`)·"조직 관리 key"(`/settings/api-keys/org`) 순서다. 에이전트 key 탭은 에이전트를 관리하는 사람(owner·admin·에이전트 관리자)에게, 조직 관리 key 탭은 `/v1/auth/me` `permissions`에 `api_key.manage`가 있는 사람에게만 보인다. 조직 관리 key는 "준비 중입니다" 안내뿐이고 "새 key"가 없으며, 권한 없이 주소로 오면 "이 화면을 볼 권한이 없습니다". 목록마다 "새 key" → `/settings/api-keys/new`·`/settings/api-keys/agents/new`. 폼은 "이름(필수 아님)"(64자)·권한 카드(세션 보기·세션 만들기·요청에 답하기·세션 제어, 글자로 `click`)·"만료일(필수 아님)"·"key 만들기"이고, 에이전트 key 폼에는 "에이전트" select가 앞에 있다("에이전트를 고르세요"와 고를 수 있는 에이전트. 워크스페이스 전체 선택지는 없다. 고르기 전에는 "key 만들기"가 비활성). 에이전트 key 폼에는 "요청에 답하기"가 없고 아래에 이유 문구가 있다. 목록 행 제목은 개인 key는 이름(없으면 "이름 없음"), 에이전트 key는 "<에이전트> · <이름>"이고 권한은 그 아래 줄이다. "승인 가능/불가" 배지는 개인 key에만 있다. 만들면 폼 자리에 `section[aria-label="새 key"]`("key를 만들었습니다", 읽기 전용 칸에 값 한 번, "복사"·"목록으로"). 관리하는 에이전트가 없는 member에게는 탭이 없다. 목록에서 폐기(확인).
- `audit-retention` `/settings/workspace` 감사 기록 보존 기간. owner만 저장, admin은 입력·저장이 비활성+이유. 29일은 서버 400 → "감사 기록은 30일보다 짧게 보존할 수 없습니다…".
- `slack-guest` `/settings/workspace/integrations/slack` "Slack 게스트" 섹션의 switch(`role="switch"`, 이름 "Slack 게스트도 에이전트를 쓸 수 있게 하기", 글자 "켜짐"/"꺼짐"). 지금 값은 `GET /v1/auth/me`의 `workspace.settings.slack_guest_enabled`(기본 false)이고, 누르면 반대 값을 `POST /v1/workspaces/{id}/slack-guest`로 보낸다. owner·admin(`workspace.manage`)만 바꾼다. member는 사이드바에 메뉴가 없고, 주소로 들어오면 switch 없이 읽기 전용 글("지금 설정입니다. 바꾸려면 워크스페이스 소유자나 관리자에게 요청하세요.", "감사 기록을 N일 보존합니다.", Slack 게스트 지금 값)만 본다. 켜도 게스트는 Slack 계정을 연결해야 쓴다는 안내가 아래에 있다.

## How to get to it (user POV)

- 구성원의 "팀" 탭·"연동 계정"·"내 key"·"워크스페이스 설정", 에이전트 상세의 "관리자" 탭.
- member·admin은 [web-members-agents.md](./web-members-agents.md)의 초대·수락으로 만든다. 사람마다 cookie 파일을 둔다(`cp "$VERIFY_RUN/cookie" "$VERIFY_RUN/cookie.<이름>"`).

## Driving it with lib.sh

Preconditions: `up.sh infra/compose.mock-slack.yml`로 띄웠다(Orca에서는 `orch heavy <program> -- …`). 4(Slack)를 몰 run이면 같은 호출에서 버리는 master key도 넘긴다(4의 첫 줄). owner bootstrap 뒤 `ap_web POST /v1/auth/login`(bootstrap은 cookie를 주지 않는다), member 초대·수락. `orch hold browser --note "<what>"`.

1. **로그인 공급자 버튼.** 기본 스택에는 공급자가 없다(`login-methods` → `{"password":"on","providers":[]}`). 공급자를 만드는 관리 화면과 API는 아직 없어서, 버튼은 `login_providers` 행을 DB에 직접 넣어 확인한다. client secret은 `PLATFORM_SECRET_KEY`로 암호화해 저장하는 값이라 SQL로 넣을 수 없다. 그래서 이 행으로는 버튼까지만 확인되고, 누르면 시작 요청이 `503`이다. 끝까지 로그인하는 경로는 통합 시험 `apps/control-host/src/api/provider-login.integration.test.ts`가 mock IdP로 고정한다.

   ```sh
   docker compose exec -T postgres psql -U postgres -d sessions -c "INSERT INTO login_providers (id, display_name, issuer, authorization_endpoint, token_endpoint, jwks_uri, signing_algs, iss_parameter_required, pkce_advertised, discovery_checked_at, client_id, token_auth_method, enabled) VALUES (gen_random_uuid(), 'Google', 'https://accounts.google.com', 'https://accounts.google.com/o/oauth2/v2/auth', 'https://oauth2.googleapis.com/token', 'https://www.googleapis.com/oauth2/v3/certs', '{RS256}', false, true, now(), 'verify-client', 'client_secret_post', true)"
   curl -sS "$API/v1/auth/login-methods"     # {"password":"on","providers":[{"id":"…","display_name":"Google"}]}
   ```

   `/login`에 "또는" 아래 "Google 계정으로 로그인" 버튼이 보인다. 행을 `enabled = false`로 바꾸면 버튼이 사라지고 `POST /v1/auth/providers/<id>/start`가 `404`다.
2. **팀과 관리자.** owner로 `browser.mjs`: `open /teams` → `type @0 Verifiers` → `click "팀 만들기"` → `click Verifiers` → `select 'main select' <member user id>` → `click "구성원 추가"`. 에이전트 상세는 `open "/agents/<id>?tab=admins"` → "관리자로 추가할 팀" 칸의 `@N`(상세의 숨은 탭 칸까지 세므로 `eval`로 label을 찍어 찾는다. version 둘이면 @11) → `select @N <team id>` → `click "팀 추가"` → "Verifiers을(를) 관리자로 추가했습니다."
3. **에이전트 key.** member로 `/settings/api-keys/agents/new`(`agent_id` 없이 `ap_web POST /v1/api-keys '{"kind":"agent","scopes":["sessions:read"]}'`를 보내면 `400 BAD_REQUEST`, 관리하지 않는 에이전트의 `agent_id`로는 `403` `role`). "에이전트" select에는 "에이전트를 고르세요"와 관리하는 에이전트만. `select 'main select' <agent id>` → `click "세션 만들기"` → `click "key 만들기"` → `section[aria-label="새 key"]`. 값은 화면에 찍지 말고 `(umask 077; node $B <run id> eval "document.querySelector('section[aria-label=\"새 key\"] input').value" | tr -d '"\n' > "$VERIFY_RUN/keys/<who>-agent")`로 파일에만 받고 `click 목록으로`. 그 key로 `ap_post /v1/sessions` 본문에 그 에이전트 release(`agent_release_id`) → `201`, release 없이 → `403` `agent_ceiling`.
4. **Slack.** 이 단계는 mock overlay와 버리는 master key로 띄운 스택에서 한다. master key 한 줄: `export PLATFORM_SECRET_KEY="$(openssl rand -hex 32)"`를 `up.sh infra/compose.mock-slack.yml`과 같은 Bash 호출에서 부른다(값은 출력하지 않고 `${#PLATFORM_SECRET_KEY}`로 64만 확인, 사람의 Keychain 항목은 읽지 않는다. [musterrolle.md](./musterrolle.md) c). 연결 전에 [musterrolle.md](./musterrolle.md) c의 1–3을 API로 한다: owner의 config token PUT, 에이전트 앱 생성, install start → mock 동의 → complete로 확인된 설치. 설정 > 워크스페이스 > 연동 > Slack(config token)과 에이전트 설치 화면은 아직 없다. 이 준비 없이 "연결"을 누르면 목록 위에 "Slack 계정 연결을 아직 쓸 수 없습니다 — 워크스페이스 관리자에게 연동 > Slack 설정을 요청하세요."가 뜬다(`409 SLACK_LINK_NOT_CONFIGURED`).

   mock 발급자(`http://mock-slack:4020`)는 compose 안에서만 닿고, link 앱의 리디렉션 주소는 overlay의 `CONSOLE_ORIGIN`인 `127.0.0.1:3000`에서 계산한다. "연결"을 누르면 시작 요청이 link 앱을 만들고 화면이 동의 URL로 떠나 `chrome-error://`가 된다(시작 요청과 이동까지는 확인된다). 동의 URL에는 OAuth `state`가, 돌아오는 주소에는 `code`가 들어 있어 `orca goto`·`orca eval`·`bun -e`의 인자로 넘기면 `ps`에 보인다. 그래서 동의부터는 이 run의 headless Chrome으로 한다: `browser.mjs <run> login member` → `open /settings/linked-accounts` → `slack-consent`. `slack-consent`는 페이지 안에서 시작 요청을 보내고(브라우저 cookie 그대로), api 컨테이너의 bun에 stdin으로 동의 URL을 넘겨 mock 동의를 받은 뒤, 돌아온 주소를 `$API` 호스트:포트로 바꿔 그 탭에서 연다. 출력은 도착한 경로뿐이다. 다른 team으로 동의하려면 `slack-consent T0OTHER`. 콜백 화면이 목록으로 돌아와 Slack 행이 "연결됨"과 `Slack 사용자 U0MOCK (워크스페이스 T0MOCK)`, "연결 해제" → "Slack 계정 연결을 해제했습니다.", DB `revoked | unlinked | 2`.
5. **감사 보존.** owner로 `/settings/workspace`, 값 `29` → 저장 → alert "감사 기록은 30일보다 짧게 보존할 수 없습니다. 30일 이상(최대 3650일)으로 정하세요."와 api 로그 `POST … audit-retention 400`. member가 같은 API를 부르면 `403` `Only an owner can change audit retention`, member 메뉴에는 "워크스페이스 설정"이 없다.
6. **Slack 게스트.** owner 탭으로 `/settings/workspace/integrations/slack`의 switch(처음 `checked=false`, "꺼짐")를 누른다 → status "이제 Slack 게스트도 에이전트를 쓸 수 있습니다.", switch `checked=true` "켜짐". `ap_web GET /v1/auth/me | head -1 | jq .workspace.settings.slack_guest_enabled` → `true`. member cookie로 `ap_web POST "/v1/workspaces/$WS/slack-guest" '{"slack_guest_enabled":false}'` → `403` `Only an owner or admin can change the Slack guest setting`(`reason_code: role`). member로 로그인한 브라우저에서 `/settings/workspace/integrations/slack`을 주소로 열면 `[role=switch]`가 없고 읽기 전용 글만 있다. member는 API로 초대·수락해도 된다: `node $U <run id> invite owner member member` → `node $U <run id> accept member`(token과 비밀번호는 run 디렉터리에만 있다. `ap_web POST /v1/invites`는 응답에 token을 그대로 출력하므로 쓰지 않는다).

## Gotchas

- `orca click`은 화면 밖 요소를 스크롤하지 않고 그 좌표의 `<html>`을 누른다. 아무 일도 안 일어나면 `orca eval --expression '<요소>.scrollIntoView({block:"center"})'` 뒤 다시 누른다. 같은 탭에서 이런 일이 쌓이면 `orca tab close` 뒤 새 탭을 연다(cookie는 남는다).
- 입력은 `orca click`으로 포커스한 뒤 `orca type`이 확실하다. `fill`은 값을 바꾸고도 React가 못 보는 일이 있었다. select는 `orca select`(label이 아니라 option의 value).
- select를 바꾼 직후 버튼이 아직 비활성일 수 있다. 다시 snapshot해 `disabled`가 빠진 것을 보고 누른다.
- macOS `head`는 `-n -1`을 받지 않는다. `ap_web` 출력에서 마지막 상태 줄을 뗄 때는 `head -1`.
- 비밀값(key `csp_…`, invite token, bootstrap token)이 snapshot·state 출력에 섞인다. 화면에 key가 떠 있는 동안 snapshot을 출력하지 말고, 그 상태로 스크린샷을 남기지 않는다. 노출했으면 확인이 끝난 뒤 그 key를 폐기한다.
- host에서 mock IdP(`packages/testkit/src/mock-oidc-main.ts`)를 띄웠으면 `down.sh`가 모르므로 적어 둔 PID로 끈다.

key 화면 제목은 “API key”이고 LinkTabs “개인 key”·“에이전트 key”는 로드 후 각 개수를, “조직 관리 key”는 개수 없이 보인다. API key 마지막 사용 시각·발급자 이름은 아직 main에 없다. workspace는 이름·ID·모델 허용 목록·감사 보존·Slack 게스트 Card로 나뉜다. ID는 SecretField 복사, 모델은 mono Badge, 저장은 CardFooter다. 소스: `apps/web/src/routes/api-keys.tsx`, `workspace-settings.tsx`, `i18n/api-keys.ts`. 절차: [procedures.md](procedures.md) P-WEB-SETTINGS.
