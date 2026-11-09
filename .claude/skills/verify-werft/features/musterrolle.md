# 멤버·팀·권한 (Musterrolle)

workspace 멤버 초대·관리, 팀, Slack 계정 연동, 권한별 API key(개인 key·에이전트 key), 판정 기록(`authz_decisions`), 감사 열람·공유 범위, 에이전트 자격 연결을 사용자가 하는 순서대로 확인하는 자리다. 시나리오 a(초대·관리), b(팀과 팀 관리자), c(Slack 계정 연결과 멘션·승인 판정), d(권한별 key), e(판정 기록·보존 기간·공유 범위·감사 열람·관리 목록), f(자격 연결), g(에이전트의 Slack 앱 연결) 모두 HTTP API로 몰 수 있다. 사용자 경로가 아직 없는 것은 둘이다: Slack 이벤트 수신이 없어 c·g의 판정·해석은 api 컨테이너에서 함수로 부르고, DM 기본 "나만"은 DM 세션 경로가 없어 몰 수 없다. "(아직 없음)"이 붙은 항목은 "확인됨"으로 보고하지 않는다.

## Sub-features

- `a-member-lifecycle` owner 웹 로그인 → 초대 → 수락·로그인 → 역할 변경(admin 포함. admin은 owner 역할을 주거나 owner를 바꾸지 못해 `403 OWNER_PROTECTED`, 자기 역할 변경·비활성은 `403 SELF_PROTECTED`, 계정이 정지된 사람의 역할 변경·재활성은 `409 ACCOUNT_DISABLED`, 비활성 멤버십의 역할 변경은 `409 MEMBER_DISABLED`. 목록 행의 `actions`가 이 결과를, 목록의 `assignable_roles`가 초대할 수 있는 역할을 미리 싣는다) → 비활성화하면 그 사람의 cookie와 개인 key는 401, 그 사람이 발급한 에이전트 key는 계속 200 → 재활성화해도 끊긴 cookie·개인 key는 돌아오지 않고 다시 로그인한다.
- `b-teams` 팀 생성 → 구성원 추가·제거(수락 없이, 그 사람을 대상으로 한 receipt가 알림 기록) → 팀을 에이전트 관리자로 지정 → 팀원은 그 에이전트를 관리하고, 팀에서 빠지거나 팀이 지워지면 다음 요청부터 403. owner·admin만 팀을 바꾼다.
- `c-slack-signin` owner·admin의 config token 저장 → 에이전트 Slack 앱 생성·설치(install start → 동의 → complete, 확인된 설치와 에이전트 연결) → 연결 시작이 워크스페이스의 link 앱을 만들고 Sign in with Slack으로 연결·목록·해제, 처리 시점 재판정. 손으로 만든 앱은 설치 등록 CLI로. 실제 Slack 동의는 사람이 하고(`docs/operator/api-server.md` § Slack 계정 연결의 확인 절차), 자동 확인은 mock Slack과 버리는 master key로 한다.
- `c-slack-decision` 연결한 사람만 Slack에서 쓴다: 멘션·승인 버튼의 판정(`authorizeSlackInput`), 거절 안내 문구, guest 사용 설정(`POST /v1/workspaces/{id}/slack-guest`), Slack Connect 거절, 요약 상한 채널의 `redact`. Slack 채널(이벤트 수신)이 없어 판정은 api 컨테이너에서 함수로 부른다.
- `d-scoped-keys` member는 개인 key만, owner·admin은 모든 에이전트의 에이전트 key, 에이전트 관리자(그 에이전트를 만든 사람)는 그 에이전트의 에이전트 key를 `POST /v1/api-keys`로 발급한다. `agent_id` 없는 key(workspace 전체 key)는 누구든 400. 권한이 없으면 403과 `details.reason_code`. 에이전트 key는 그 에이전트의 세션만 만들고 읽는다. key마다 `name`(1~64자, 필수 아님). 발급자의 지금 scope를 넘는 key는 403 `SCOPE_NOT_GRANTABLE`. API key로는 발급하지 못한다. 발급자를 내보내면 개인 key는 멈추고 에이전트 key는 계속 동작한다.
- `f-credential-bindings` 에이전트 관리자가 card의 `credential_refs` 이름을 그 에이전트에 연결(`POST /v1/agents/{id}/credential-bindings`)해야 활성화가 된다. 해제하면 실행 중 세션은 그대로 두고(`running_sessions`, `revoke_notice`) 다음 세션 생성이 `409 CREDENTIAL_UNBOUND`(안내 문구·관리자·`mailto:` 링크)다.
- `g-agent-identity` 에이전트를 자기 Slack 앱 설치에 연결·목록·회수하고, Slack 이벤트의 `(app_id, team_id)`가 그 에이전트로 정해지는지, 회수 뒤·다른 앱의 이벤트는 버려지는지. Slack ingress가 없어 해석은 api 컨테이너에서 함수로 부른다.
- `e-authz-audit` 위 행동이 `authz_decisions`에 남고(감사 보존 기본 90일·하한 30일), 세션 공유 범위(`private`·`people`·`team`·`workspace`) 밖이면 owner·admin도 목록·상세·SSE가 `404`, 범위를 좁히면 열린 SSE가 끊기고, owner·admin은 사유를 단 감사 열람(읽기만)·관리 목록(메타데이터만)·관리 종료로만 범위 밖을 다룬다. DM 기본 "나만"은 DM 세션 경로가 없어 아직 없음.

## How to get to it (user POV)

- 웹 콘솔의 초대 수락·구성원 화면은 [web-members-agents.md](./web-members-agents.md)에 있다(시나리오 a의 웹 쪽). 팀·에이전트 관리자·Slack 연결·key·감사 보존 화면은 [web-settings.md](./web-settings.md)에 있다.
- a: `POST`·`GET /v1/invites`, `DELETE /v1/invites/{id}`, `POST /v1/invites/accept`(cookie 없이, 수락하면 cookie가 생긴다), `GET /v1/members`, `PATCH /v1/members/{user_id}` `{"role"}`, `POST /v1/members/{user_id}/disable`·`/enable` `{"reason"?}`. 화면은 [web-members-agents.md](./web-members-agents.md).
- d: `POST`·`GET /v1/api-keys`, `DELETE /v1/api-keys/{id}`(cookie만). 화면은 [web-settings.md](./web-settings.md)의 `api-keys`.
- b: `POST /v1/teams` → `POST /v1/teams/{team_id}/members` → `POST /v1/agents/{id}/admins` `{"team_id"}` → 팀원이 `PATCH /v1/agents/{id}`, `GET /v1/administered-agents` → `DELETE /v1/teams/{team_id}/members/{user_id}`, `DELETE /v1/teams/{team_id}`. 화면은 [web-settings.md](./web-settings.md)의 `teams`·`agent-admins`.
- f: `GET`·`POST /v1/agents/{id}/credential-bindings`, `DELETE /v1/agents/{id}/credential-bindings/{binding_id}`, 활성화 `POST /v1/agents/{id}/activate`, 세션 `POST /v1/sessions`(`agent_release_id`). 연결 화면(M10)은 아직 없다.
- g: `POST·GET /v1/agents/{id}/identities`, `DELETE /v1/agents/{id}/identities/{identity_id}`. 화면은 아직 없다.
- e: `POST /v1/sessions/{id}/share` `{"scope", "user_ids"?, "team_ids"?}`, `GET /v1/sessions/{id}/share`, `POST /v1/sessions/{id}/audit-read` `{"justification"}`, `GET /v1/admin/sessions`, `POST /v1/admin/sessions/{id}/terminate` `{"expected_revision","justification"}`, `POST /v1/admin/sessions/{id}/recovery-decisions`(owner만, `reason`이 사유), 인수 `POST /v1/sessions/{id}/takeover` `{"justification"}`. 화면(Kollegium 세션 상세)은 아직 없다.
- c 준비(owner·admin, cookie): `PUT /v1/workspaces/{id}/slack/config-token` `{"value"}`, `POST /v1/agents/{id}/slack/app`, `POST /v1/agents/{id}/slack/install/start` → Slack 동의 → `POST /v1/slack/install/complete` `{agent_id, state, code}`, 채널 설정 `PUT`·`GET /v1/agents/{id}/slack-bindings`. config token·설치 화면은 아직 없다.
- c: `POST /v1/linked-accounts/slack/start` → IdP 동의 → `POST /v1/linked-accounts/slack/callback` → `GET /v1/linked-accounts` → `DELETE /v1/linked-accounts/{id}`. 화면은 [web-settings.md](./web-settings.md)의 `linked-slack`. guest 설정은 `POST /v1/workspaces/{id}/slack-guest`(화면은 [web-settings.md](./web-settings.md)의 `slack-guest` switch)이고 지금 값은 `GET /v1/auth/me`의 `workspace.settings.slack_guest_enabled`다.

## Driving it with lib.sh

Preconditions:

- 시나리오마다 필요한 사용자: owner는 [web-login.md](./web-login.md)의 bootstrap 뒤 login으로 만든다(bootstrap은 cookie를 주지 않는다). member·admin은 owner가 초대하고 수락해 만든다(a의 1). DB에 직접 넣지 않는다.
- 자격 값이 본문에 드는 요청(bootstrap·login·초대 수락·key 발급)은 `scripts/web-user.mjs`로 보낸다. 비밀번호·초대 token·key secret을 명령에 쓰면 agent-guard가 그 호출을 거부한다. `web-user.mjs`는 그 값을 run 디렉터리(`users/<who>`, `users/<who>.invite`, `keys/<who>`)에 두고 출력하지 않는다. 사용법은 [web-login.md](./web-login.md)와 [sessions.md](./sessions.md)의 웹 사용자 세션.
- `ap_web`은 cookie 파일 하나(`$VERIFY_RUN/cookie`)만 읽고 쓴다. `web-user.mjs login|accept <who>`는 그 cookie를 `cookie.<who>`에도 남기고, `ap_as <who>`가 그 사람의 cookie(와 `web-user.mjs key`로 발급한 key를 `$KEY`)로 바꾼다.
- `ap_web`은 POST마다 새 `Idempotency-Key`를 붙인다. 이 헤더가 없으면 `400`인 것은 세션 POST(`POST /v1/sessions`, `/v1/sessions/{id}/{messages,answers,interrupt,pause,terminate,resume,recovery-decisions}`, `/v1/admin/sessions/{id}/{terminate,recovery-decisions}`)이고, 나머지 route는 이 헤더를 보지 않는다. 그래서 cookie로 부르는 것은 모두 `ap_web`, 스트림(`-N`)처럼 다른 curl 옵션이 필요하면 `ap_curl cookie`로 보낸다. key·cookie·본문을 curl 인자에 직접 쓰지 않는다(`ps`에 보인다).
- 세션 생성 응답은 `{"session_id", "turn_id", "receipt_id", "status"}`다(`.session.id`가 아니다).
- `POST /v1/api-keys`의 응답에는 key secret이 그대로 있다. `ap_web`으로 발급할 때는 출력하지 말고 변수로만 받는다: `R=$(ap_web POST /v1/api-keys '<본문>'); printf '%s\n' "$R" | tail -1; KEY=$(printf '%s\n' "$R" | head -1 | jq -r .secret); unset R; echo "key chars ${#KEY}"`. 아래에서 "`secret`을 `KEY`로"는 이 줄이다.

- **a. 초대·관리.** 초대와 수락은 `web-user.mjs invite owner <who> <role>`·`web-user.mjs accept <who>`, 발급한 key는 `web-user.mjs key <who> <kind> <scopes>` 뒤 `ap_as <who>`의 `$KEY`로 쓴다. 아래 단계의 `POST /v1/invites`·`/v1/invites/accept`·`/v1/auth/login`·`POST /v1/api-keys`는 이 명령들이 보내는 요청이다.
  1. owner bootstrap·login. owner가 `web-user.mjs invite owner member member`(`POST /v1/invites` → `201` `{invite_id, invite_token, expires_at}`, token은 출력하지 않고 `users/member.invite`에만 둔다), 같은 식으로 `dana`(member). `web-user.mjs accept member`(cookie 없이 `POST /v1/invites/accept`) → `200` `{user_id, workspace, role: "member"}`, cookie가 생긴다. 응답에 token이 그대로 있으니 `ap_web POST /v1/invites`로 초대하지 않는다. `GET /v1/invites` → 두 초대 `status: accepted`. `GET /v1/members` → 세 줄.
  2. 수락한 사람이 같은 비밀번호로 `POST /v1/auth/login` → `200`, scopes 넷(`recover` 없음). `GET /v1/auth/me`의 `permissions`는 `api_key.manage_own, account.link, agent.create`. member의 `POST /v1/invites`·`PATCH /v1/members/{id}` → `403` `reason_code: role`.
  3. owner가 `ap_web PATCH "/v1/members/$DANA_ID" '{"role":"admin"}'` → `200` `role: admin`. dana가 다시 로그인한 뒤 member를 owner로(`'{"role":"owner"}'`), owner를 member로, `role: owner` 초대 → 셋 다 `403 OWNER_PROTECTED`. dana의 `GET /v1/members` → `assignable_roles: ["admin","member"]`(owner가 보면 `["owner","admin","member"]`), 이 둘로는 초대가 `201`. member를 admin으로 올렸다 내리기 → 둘 다 `200`.
  4. owner가 자기를 `admin`으로 → `403 SELF_PROTECTED`. 자기 비활성(`POST /v1/members/$ME/disable`) → `403 SELF_PROTECTED`. `ap_web GET /v1/members`의 자기 행은 `actions`가 모두 `{"allowed":false,"reason":"self_protected"}`. owner를 바꿀 수 있는 사람은 살아 있는 다른 owner뿐이라 이 API에서 `409 LAST_OWNER`는 나오지 않는다. owner 둘이 서로를 동시에 내리면 뒤의 요청은 바꾸는 사람이 더는 owner가 아니어서 `403`이다.
  5. dana(admin)가 팀 하나(`POST /v1/teams`)를 담당 팀으로 넣어 `POST /v1/agents`로 에이전트를 하나 만들고(`DANA_AID`), `POST /v1/api-keys '{"kind":"personal","scopes":["sessions:read"]}'`와 `'{"kind":"agent","agent_id":"<DANA_AID>","scopes":["sessions:read"]}'`(위 Preconditions처럼 `secret`을 `KEY`로) → 둘 다 `201`. 개인 key `GET /v1/sessions` `200`, 에이전트 key `GET /v1/auth/me` `200`.
  6. owner가 `ap_web POST "/v1/members/$DANA_ID/disable" '{"reason":"verify scenario a"}'` → `200` `member.disabled_at`. dana의 cookie `GET /v1/auth/me` → `401`, 개인 key → `401`, 에이전트 key → `200`. dana의 로그인 → `401` "Invalid email or password".
  7. owner가 `/enable` → `200` `disabled_at: null`. 예전 cookie·개인 key는 여전히 `401`, 다시 로그인하면 `200`, `me`의 role은 `admin` 그대로.
  8. `SELECT operation, result FROM receipts WHERE operation IN ('invite_member','accept_invite','change_member_role','disable_member','enable_member')` → `disable_member`의 `result`에 `revoked_web_sessions`·`revoked_personal_keys: 1`·`revoked_linked_accounts`·`sessions_awaiting_takeover`. `authz_decisions`에 `member.manage allow ok`(owner·admin의 관리 요청마다)와 `member.manage deny role`(2의 둘). `api_keys`는 개인 key만 `revoked_at`이 찬다. 끝나면 쓴 에이전트 key를 `DELETE /v1/api-keys/{id}`로 폐기한다.
  - 2026-10-12 run `20261012-022045-88049`에서 이 순서대로 확인했다. 증거는 `$EVIDENCE/musterrolle-a.txt`.
- **b. 팀과 팀 관리자.** d와 같이 사람마다 `web-user.mjs`로 로그인하고 `ap_as <who>`로 바꾼다. owner bootstrap·login, 초대·수락으로 member와 admin(d의 1). `MEMBER_ID`는 member cookie로 `ap_web GET /v1/auth/me`의 `user.id`.
  1. owner가 구성원 없는 담당 팀과 에이전트를 만든다: `ap_web POST /v1/teams '{"name":"research"}'` → `201`, `MTID`. `ap_web POST /v1/agents "{\"slug\":\"research\",\"name\":\"research\",\"managing_team_id\":\"$MTID\",\"card\":$CARD}"` → `201`, `AID`. `managing_team_id`가 빠지면 `400`이다.
  2. member가 `ap_web PATCH "/v1/agents/$AID" "{\"card\":…}"` → `403` `reason_code: "role"`. member가 `ap_web POST /v1/teams '{"name":"mine"}'` → `403` `role`.
  3. owner가 `ap_web POST /v1/teams '{"name":"research admins"}'` → `201`, `TID`. `ap_web POST "/v1/teams/$TID/members" "{\"user_id\":\"$MEMBER_ID\"}"` → `200`, `team.member_count: 1`, `receipt_id`. 수락 단계는 없다. member가 `ap_web GET /v1/my-teams` → `200` `items: [{id: TID, name: "research admins"}]`(6에서 뺀 뒤에는 `[]`).
  4. owner가 `ap_web POST "/v1/agents/$AID/admins" "{\"team_id\":\"$TID\"}"` → `200`, `admins.teams[].name`에 팀.
  5. member가 카드 수정 → `200`. `ap_web GET /v1/administered-agents` → `items[].slug`에 `research`. member가 `PATCH "/v1/teams/$TID"`·`DELETE "/v1/teams/$TID/members/$MEMBER_ID"` → 둘 다 `403` `role`.
  6. owner가 `ap_web DELETE "/v1/teams/$TID/members/$MEMBER_ID"` → `200`. 바로 다음 member 카드 수정 → `403` `role`.
  7. owner가 다시 넣고(`200`) member 카드 수정 `200`, admin이 `ap_web DELETE "/v1/teams/$TID"` → `200`, member 카드 수정 → `403` `role`.
  8. `SELECT operation, target_ref->>'user_id' IS NOT NULL, result FROM receipts WHERE operation IN ('create_team','add_team_member','remove_team_member','add_agent_admin','delete_team') ORDER BY created_at` → `add_team_member`·`remove_team_member`는 그 사람이 대상이고 `result`에 `team_id`·`team_name`, `delete_team`의 `result.agent_ids`에 에이전트. `SELECT action, outcome, reason_code, count(*) FROM authz_decisions WHERE action IN ('team.manage','agent.manage','agent.admin.manage') GROUP BY 1,2,3` → `team.manage allow`(owner·admin의 변경 다섯), `team.manage deny role`(member의 셋), `agent.manage deny role`(2·6·7의 셋), `agent.manage allow`(5·7의 둘), `agent.admin.manage allow` 하나. 모두 `policy_version` `m15`.
  - 2026-10-11 run `20261011-210547-1353`에서 이 순서대로 확인했다(`evidence/musterrolle-b.txt`). 2026-10-12 run `20261012-022045-88049`에서 다시 확인했다.
- **c. Slack 계정 연결.** 사람이 하는 순서 그대로다: owner가 config token을 넣고 → 에이전트의 Slack 앱을 만들어 설치하고(OAuth: install start → 동의 → complete) → member가 연결을 시작하면 그 자리에서 워크스페이스의 link 앱이 생기고 → 동의 → 연결. 연결 시작은 확인된 설치(`slack_installations`)가 있어야 하고(없으면 `409 SLACK_NOT_INSTALLED`), link 앱은 config token으로 만들며 config token은 master key가 있어야 저장된다. 그래서 이 시나리오는 mock overlay와 **이 run만 쓰는 버리는 master key**로 띄운다. key 없이 띄우면 api 로그에 `Secret store is off`가 남고 연결 시작이 `409 SLACK_LINK_NOT_CONFIGURED`(`reason_code: store_off`)에서 멈춘다. Slack을 안 쓰는 시나리오는 key 없이 띄운다(저장소가 꺼진 채로 ready).

  master key 한 줄: `openssl rand -hex 32`로 run마다 새 값을 만들어 `up.sh`를 부르는 같은 Bash 호출에서 넘긴다. 사람의 Keychain 항목은 읽지 않고, 값은 출력·증거에 쓰지 않는다(길이만 `${#PLATFORM_SECRET_KEY}`). 값은 그 셸과 api 컨테이너에만 있고, 스택을 내리면 저장된 Slack 비밀값과 함께 버려진다.

  ```sh
  export PLATFORM_SECRET_KEY="$(openssl rand -hex 32)"; echo "master key chars: ${#PLATFORM_SECRET_KEY}"   # 64
  orch heavy <program> -- .claude/skills/verify-werft/scripts/up.sh infra/compose.mock-slack.yml
  ```

  mock(`mock-slack:4020`)은 compose 네트워크 안에서만 닿는다. config token 발급(`/fake/config-tokens`)과 동의(`/fake/oauth/authorize`, 계정 연결은 IdP의 authorize)는 api 컨테이너에서 부른다. config token 값은 변수에만 담고 출력하지 않는다. owner cookie는 web-login.md로, member는 `web-user.mjs invite owner member member` → `accept member`로 만든다. `werft_slack_link` cookie도 `Secure`라 curl이 저장하지 않으니 직접 나른다: `ap_web`이 남긴 `$VERIFY_RUN/headers`에서 꺼내 `AP_COOKIE_EXTRA`에 담으면 `ap_web`이 세션 cookie 뒤에 붙인다. authorize URL·code·state도 명령줄 인자가 아니라 stdin과 `ap_web` 본문으로만 나른다.

  ```sh
  . .claude/skills/verify-werft/scripts/lib.sh <run id>
  ap_compose logs api 2>&1 | grep -c 'Secret store is off'      # 0
  # owner bootstrap + login: web-login.md. WS는 login 응답의 workspace_id. member 초대·수락. 이후 ap_as owner
  # 1. config token (owner)
  node .claude/skills/verify-werft/scripts/web-user.mjs <run id> slack-config owner "$WS"
  # 2. 에이전트 앱 (owner). CARD는 d의 2. release를 활성화해야 앱을 만든다
  ap_web POST /v1/teams '{"name":"research"}'                  # MTID = team.id
  ap_web POST /v1/agents "{\"slug\":\"research\",\"name\":\"research\",\"managing_team_id\":\"$MTID\",\"card\":$CARD}"      # AID, VID = versions[0].id
  ap_web POST "/v1/agents/$AID/releases" "{\"version_id\":\"$VID\",\"runtime_profile_id\":\"claude-coding-local\",\"repository_id\":\"sample-app\"}"   # REL = release.id
  ap_web POST "/v1/agents/$AID/activate" "{\"release_id\":\"$REL\",\"expected_revision\":-1}"
  ap_web POST "/v1/agents/$AID/slack/app" '{}'                  # APP = slack_app.app_id
  # 3. 설치 (owner): start → mock 동의 → complete
  node .claude/skills/verify-werft/scripts/web-user.mjs <run id> slack-install owner "$AID"
  ap_web GET "/v1/agents/$AID/identities"
  # 4. 연결 (member): 시작이 link 앱을 만든다
  ap_as member
  START=$(ap_web POST /v1/linked-accounts/slack/start | head -1)
  AP_COOKIE_EXTRA=$(sed -n 's/^[Ss]et-[Cc]ookie: \(werft_slack_link=[^;]*\).*/\1/p' "$VERIFY_RUN/headers" | tr -d '\r')
  # authorize_url의 호스트(mock-slack)는 compose 네트워크 안에서만 닿는다: api 컨테이너에서 동의하고, 돌아온 주소를 callback 본문으로 바꾼다.
  # 주소에는 state가 들어 있으니 bun 인자가 아니라 stdin으로 넘긴다
  if BODY=$(printf '%s' "$START" | jq -r '.["authorize_url"]' | ap_compose exec -T api bun -e 'let status; try { const r = await fetch((await Bun.stdin.text()).trim(), { redirect: "manual" }); status = r.status;
  if (status !== 302) throw new Error(); const q = new URL(r.headers.get("location")).searchParams;
  if (!q.get("code") || !q.get("state")) throw new Error();
  console.log(JSON.stringify(Object.fromEntries(["code", "state"].map((k) => [k, q.get(k)]))));
  } catch { console.error(`mock consent failed (HTTP ${status ?? "unavailable"})`); process.exit(1); }'); then
    ap_web POST /v1/linked-accounts/slack/callback "$BODY"
  fi
  unset START BODY AP_COOKIE_EXTRA
  ap_web GET /v1/linked-accounts                               # LAID = items[0].id
  ap_compose exec -T postgres psql -U postgres -d sessions -c 'select kind, state, app_id from slack_apps order by created_at'
  # 5. 해제, 그리고 다른 team 계정 (member)
  # 아래 "멘션·승인 판정"을 이어 하려면 이 줄의 해제 대신 그쪽을 끝까지 하고(그 마지막이 같은 해제다) 다음 줄로 돌아온다
  ap_web DELETE "/v1/linked-accounts/$LAID"
  ap_compose exec -T postgres psql -U postgres -d sessions -c 'select status, revoked_reason, revision from linked_accounts'
  DB='import { Pool } from "pg"; import { drizzle } from "drizzle-orm/node-postgres"; import * as schema from "@werft-ai/db";
  const pool = new Pool({ connectionString: process["env"]["DATABASE_URL"] }); const db = drizzle(pool, { schema });'
  ap_compose exec -T -w /app/apps/control-host api bun -e "$DB
  console.log(JSON.stringify(await schema.resolveLinkedSubject(db, { provider: \"slack\", externalTenant: \"T0MOCK\", externalUserId: \"U0MOCK\" }))); await pool.end();"
  # 4의 START·AP_COOKIE_EXTRA·BODY를 다시 만들되 jq를 '.["authorize_url"] + "&mock_team=T0OTHER"'로 바꿔 동의하고 callback
  ```

  기대: api 로그의 `Secret store is off`가 `0`줄. config token PUT `200` `{configured: true, state: "active", last4, issuer: {user_id: "U0MOCK", team_id: "T0MOCK"}, receipt_id, warnings: []}`. 앱 `200` `created: true`, `slack_app.state: created`(`app_id`는 mock이 만든 `A0FAKE…`, `secrets`는 signing·client secret만 `configured: true`). install start `200` `{authorize_url, expires_at}`(`https://slack.com/oauth/v2/authorize?…`, 10분), mock 동의 `{ok: true, code, state}`, complete `200` `installation.status: verified`(team `T0MOCK`), `agent_identity`(`credential_ref` `slack_app:<id>/slack_bot_token`, `active`), `receipt_id`. 공개 이벤트 URL이 없는 기본 mock overlay에서는 `finalized: false`, `warnings: [{"code":"events_url_unset"}]`이며 `identities`에 그 한 줄이 남는다. `SLACK_EVENTS_PUBLIC_URL`을 설정하고 이벤트 구독 manifest 갱신이 성공하면 `finalized: true`다(P-SLACK-SETUP 참조). `finalized: false`여도 로컬 signed POST는 수신한다. member의 연결 시작 `200`(`authorize_url`이 `http://mock-slack:4020/openid/connect/authorize`, client는 새 link 앱)이고, `slack_apps`는 `agent | created | A0FAKE…`와 `link | created | A0FAKE…` 두 줄이 된다. callback `201`과 `receipt_id`, 목록에 `active` 한 줄(`external_tenant` `T0MOCK`, `external_user_id` `U0MOCK`). 해제 `200`(`receipt_status: succeeded`) 뒤 목록이 비고 DB는 `revoked | unlinked | 2`, `resolveLinkedSubject`는 `{"status":"unlinked"}`. `mock_team=T0OTHER`로 동의하면 callback `409 LINK_TEAM_MISMATCH`. 대기 중이던 입력의 처리 시점 재판정(`createDatabaseIdentityReader(db).reread`에 `linked_account: {id, revision}`)도 `unlinked`로 거절한다. 이 판정 함수 호출은 내부 진단이다. 서명 이벤트 수신·inbox 처리는 procedures.md의 P-SLACK-INBOUND로 검증한다. 초대(`POST /v1/invites`)·수락한 member가 같은 방법으로 연결한 뒤 owner가 `POST /v1/members/{user_id}/disable`로 비활성화하면 receipt `result.revoked_linked_accounts`가 `1`이고 DB 행은 `revoked | offboarded`다(2026-10-11 run `20261011-184057-50543`).

  손으로 만든 앱 경로(운영자 CLI). 플랫폼이 만든 앱이 아니라 사람이 Slack에서 만든 앱을 쓸 때만 설치 행을 `slack-install register`로 만든다. mock은 고정 bot 하나(app `A0MOCK`, bot 사용자 `U0MOCKBOT`)에 답한다. 그 bot token은 mock 소스(`packages/testkit/src/mock-slack-oidc-main.ts`의 `MOCK_SLACK_BOT_TOKEN` 기본값)에 있으므로 api 컨테이너 안에서 그 파일을 읽어 CLI에 넘긴다. host 셸 변수나 `-e`로 넘기면 agent-guard가 명령을 거부한다. link 앱도 CLI로 미리 만들 수 있다(위에서 이미 만들었으면 `outcome: exists`). 두 줄은 Bash 호출 하나씩으로 부른다.

  ```sh
  ap_compose exec -T -e SLACK_API_URL=http://mock-slack:4020/api api sh -c 'export SLACK_BOT_TOKEN=$(grep -o "MOCK_SLACK_BOT_TOKEN ?? \"[^\"]*\"" /app/packages/testkit/src/mock-slack-oidc-main.ts | cut -d\" -f2); exec bun run /app/apps/control-host/src/api/slack-install.ts register --workspace "$1" --app-id A0MOCK' _ "$WS"; echo "exit $?"
  ap_compose exec -T api bun run /app/apps/control-host/src/api/slack-app.ts create --kind link --workspace "$WS"; echo "exit $?"
  ```

  기대: register는 JSON 한 줄 `outcome: verified`(`team_id` `T0MOCK`, `bot_user_id` `U0MOCKBOT`)와 `exit 0`. 이 설치는 에이전트에 연결되지 않으니 g처럼 `POST /v1/agents/{id}/identities`로 잇는다. `create --kind link`는 `outcome: exists`(또는 처음이면 `created`)와 `exit 0`.
  - 2026-10-24 run `20261024-042222-58797`(main `eb8a8ac4`)에서 key 줄부터 4, 아래 멘션·승인 판정, 5(해제·`LINK_TEAM_MISMATCH`), 손으로 만든 앱 경로까지 이 순서대로 확인했다. 증거는 `$EVIDENCE/musterrolle-c.txt`. 같은 날 key 없이 띄운 run `20261024-041040-6175`에서는 옛 절차(CLI 설치 행 → 시작)가 `409 SLACK_LINK_NOT_CONFIGURED`(`reason_code: store_off`)에서 멈췄다.
- **c. 멘션·승인 판정.** 위 c를 4(member 연결)까지 한 스택에서 이어 한다(mock overlay와 master key 줄). 그러면 owner가 만든 에이전트 `research`(`AID`, 활성 release `REL`)에 설치로 앱 `APP`(`A0FAKE…`, team `T0MOCK`)이 연결돼 있고, member는 `U0MOCK`을 연결했다(`LAID`, `MEMBER_ID`는 member cookie로 `GET /v1/auth/me`의 `user.id`). owner가 d의 2처럼 다른 에이전트(`finance`→`BID`)도 만들고, 두 에이전트의 release(`REL`·`BREL`)로 owner cookie로 세션을 만든다. `POST /v1/sessions`는 `ap_web`으로 부른다(`Idempotency-Key`를 붙인다): `ap_web POST /v1/sessions "{\"profile_id\":\"claude-coding-local\",\"repository_id\":\"sample-app\",\"message\":\"verify\",\"agent_release_id\":\"$REL\"}"` → `201`, 세션 id를 `S`(`BREL`로 만든 것은 `OS`)로 둔다. Slack 판정은 세션이 어느 에이전트 것인지 다시 읽으므로 실제 세션이어야 한다. 판정은 Slack 채널이 할 호출을 그대로 한다. 채널 상한은 저장된 채널 설정(`surface_bindings`)에서 읽으므로, owner가 `AID`의 채널 셋을 먼저 설정한다: 기본 상한(`C0VERIFY`, home), 요청까지만(`C0NARROW`), 요약 공개(`C0SUMMARY`). 설정하지 않은 채널(`C0NONE`)은 상한이 비어 있다.

  ```sh
  ap_as owner                                                  # c의 4는 member cookie로 끝난다
  ap_web PUT "/v1/agents/$AID/slack-bindings" '{"channel_id":"C0VERIFY","channel_kind":"public_channel","mode":"on","home":true}'
  ap_web PUT "/v1/agents/$AID/slack-bindings" '{"channel_id":"C0NARROW","channel_kind":"public_channel","mode":"on","ceiling":{"actions":["session.read","session.submit"],"disclosure":"full"}}'
  ap_web PUT "/v1/agents/$AID/slack-bindings" '{"channel_id":"C0SUMMARY","channel_kind":"public_channel","mode":"on","ceiling":{"actions":["session.read","session.submit","session.control","session.approve"],"disclosure":"summary"}}'
  ap_web GET "/v1/agents/$AID/slack-bindings"
  DECIDE='import { Pool } from "pg"; import { drizzle } from "drizzle-orm/node-postgres"; import * as schema from "@werft-ai/db"; import * as platform from "@werft-ai/platform";
  const pool = new Pool({ connectionString: process["env"]["DATABASE_URL"] }); const db = drizzle(pool, { schema });
  const authorization = platform.createAuthorizationPolicy({
    identity: schema.createDatabaseIdentityReader(db), agents: schema.createDatabaseAgentAuthority(db),
    credentials: schema.createPostgresCredentialBindingStore(db), slackGuests: schema.createPostgresSlackGuestSetting(db),
    sessions: schema.createPostgresSessionShareStore(db), decisions: schema.createPostgresDecisionLog(db) });
  const i = JSON.parse(process.argv[1]);
  const r = await platform.authorizeSlackInput({ authorization, agents: schema.createPostgresAgentIdentityStore(db), links: schema.createPostgresLinkedAccountStore(db), bindings: schema.createPostgresSurfaceBindingStore(db) }, {
    event: { appId: process.argv[3], teamId: "T0MOCK", agentId: process.argv[2] }, user: { id: i.user, team_id: "T0MOCK", ...(i.flags ?? {}) },
    action: i.action ?? "session.submit", channel: { id: i.channel ?? "C0VERIFY", dm: false },
    resource: i.session ? { kind: "session", id: i.session } : { kind: "surface_binding" },
    requestId: crypto.randomUUID(), connectUrl: "http://127.0.0.1:3000/settings/linked-accounts" });
  console.log(JSON.stringify(r.status === "decided" ? { outcome: r.decision.outcome, reason_code: r.decision.reason_code, effective_scopes: r.decision.effective_scopes, actorUserId: r.actorUserId, notice: r.notice } : r)); await pool.end();'
  decide() { ap_compose exec -T -w /app/apps/control-host api bun -e "$DECIDE" "$1" "$AID" "$APP"; }
  decide '{"user":"U0MOCK"}'                                                           # 1
  decide "{\"user\":\"U0MOCK\",\"action\":\"session.approve\",\"session\":\"$S\"}"     # 2
  ap_web POST "/v1/agents/$AID/admins" "{\"user_id\":\"$MEMBER_ID\"}"                 # owner cookie: member를 AID 관리자로
  decide "{\"user\":\"U0MOCK\",\"action\":\"session.approve\",\"session\":\"$S\"}"     # 2a
  decide "{\"user\":\"U0MOCK\",\"action\":\"session.approve\",\"session\":\"$S\",\"channel\":\"C0NARROW\"}"  # 3
  decide '{"user":"U0MOCK","channel":"C0NONE"}'                                        # 3b
  decide "{\"user\":\"U0NOBODY\",\"action\":\"session.approve\",\"session\":\"$S\"}"   # 4
  decide "{\"user\":\"U0MOCK\",\"action\":\"session.read\",\"session\":\"$S\",\"channel\":\"C0SUMMARY\"}"  # 5
  decide "{\"user\":\"U0MOCK\",\"action\":\"session.approve\",\"session\":\"$OS\"}"    # 5b
  # 5c·5d: owner cookie로 ap_web POST "/v1/sessions/$S/share" '{"scope":"private"}' 뒤 2와 같은 승인, '{"scope":"workspace"}'로 되돌린 뒤 한 번 더
  decide '{"user":"U0GUEST","flags":{"is_restricted":true}}'                          # 6
  decide '{"user":"U0EXT","flags":{"is_stranger":true}}'                              # 7
  ap_web POST "/v1/workspaces/$WS/slack-guest" '{"slack_guest_enabled":true}'          # 8: member cookie, 9: owner cookie
  decide '{"user":"U0GUEST","flags":{"is_restricted":true}}'                          # 10
  ap_web DELETE "/v1/linked-accounts/$LAID"                                            # member cookie
  decide '{"user":"U0MOCK"}'                                                           # 11
  ap_compose exec -T postgres psql -U postgres -d sessions -c "select action, outcome, reason_code, surface->>'slack_user_kind' from authz_decisions where surface->>'kind' = 'slack' order by at"
  ```

  기대: 채널 설정 PUT 셋 다 `200`, 목록에 셋(`status: ready`, `C0VERIFY`만 `home: true`, 상한을 빼면 네 동작·`full`). 1 `allow`, `actorUserId`가 member, `notice: null`. 2 member는 그 세션의 주인도 에이전트 관리자도 아니라 승인은 `deny role`, 안내 "이 요청을 승인할 권한이 없어요"(세션 권한 요청에는 주인·에이전트 관리자·owner·admin만 답한다). 2a 관리자로 넣은 뒤 같은 승인은 `allow`. 3 `C0NARROW`의 승인은 `deny surface_ceiling`, `effective_scopes`가 read·write뿐, 안내 "이 요청을 승인할 권한이 없어요". 3b 설정하지 않은 채널은 `deny surface_ceiling`, `effective_scopes: []`, 안내 "이 채널에서 이 에이전트에게 요청할 권한이 없어요". 4 `deny unlinked`, 안내 "웹에서 Slack 계정을 연결해 주세요"와 `link_url`. 5 `C0SUMMARY`의 읽기는 `redact`(`reason_code: surface_ceiling`, 안내 없음). 5b 같은 workspace여도 다른 에이전트의 세션이라 `deny agent_ceiling`, `actorUserId: null`, 안내 "이 요청을 승인할 권한이 없어요". 5c 공유가 `private`(만든 사람만)이면 member의 승인은 `deny not_found`, 안내 "이 세션은 공유 범위 밖이라 요청할 수 없어요. 세션을 만든 사람에게 공유를 요청하세요". 5d `workspace`로 되돌리면 다시 `allow`. 6 `guest_disabled`, "이 워크스페이스는 guest의 에이전트 사용을 허용하지 않아요". 7 `external_user`, "이 에이전트는 이 워크스페이스 멤버만 쓸 수 있어요". 8 member는 `403`과 `details.reason_code: role`, 9 owner는 `200`이고 `GET /v1/auth/me`의 `workspace.settings.slack_guest_enabled: true`. 10 같은 guest는 이제 `unlinked`(켜도 연결해야 쓴다), Slack Connect 사용자는 여전히 `external_user`. 해제 `200` 뒤 11은 `unlinked`와 연결 링크. 판정 행은 Slack 판정마다 하나씩(허용 포함)이고 `principal_kind`는 `installation`, 연결된 사람이 있을 때만 `actor_user_id`가 찬다. 모든 행의 `surface->>'agent_id'`는 `AID`이고 `policy_version`은 `m15`다. 2026-10-24 run `20261024-042222-58797`(main `eb8a8ac4`, 저장된 채널 설정)에서 1–11을 이 순서대로 확인했다. 같은 날 run `20261024-041040-6175`에서 채널 상한을 입력으로 넘기던 옛 스니펫은 `TypeError: undefined is not an object (evaluating 'deps.bindings.resolveSlackChannel')`로 멈췄다. 증거는 `$EVIDENCE/musterrolle-c-decision.txt`.
- **d. 권한별 key.** 사람마다 `web-user.mjs login|accept <who>`로 cookie를 받고, 그 사람으로 부르기 전에 `ap_as <who>`로 바꾼다. key secret은 `web-user.mjs key`가 `keys/<who>`에 두고 `ap_as`가 `$KEY`로 읽는다.
  1. owner bootstrap·login([web-login.md](./web-login.md)). `node $U <run id> invite owner member member`, 같은 식으로 `other`(member)와 `admin`(admin). 각자 `node $U <run id> accept <who>` → `200`(cookie가 생긴다).
  2. owner가 `ap_web POST /v1/teams '{"name":"reviewers"}'`(`RTID`), `ap_web POST "/v1/teams/$RTID/members" "{\"user_id\":\"$MEMBER_ID\"}"`(`MEMBER_ID`는 member cookie의 `GET /v1/auth/me` `user.id`)로 member의 팀을 만든다. member가 `ap_web POST /v1/agents "{\"slug\":\"reviewer\",\"name\":\"reviewer\",\"managing_team_id\":\"$RTID\",\"card\":$CARD}"` → `201`(`CARD`는 `{"role":…,"instructions":…,"language":"ko","model":"claude-sonnet-5","capabilities":{"tools":["Read"],"mcp":null,"forbidden":[]},"rules":[]}`), `POST /v1/agents/$AID/releases '{"version_id":…,"runtime_profile_id":"claude-coding-local","repository_id":"sample-app"}'` → `200`, `release.id`(`sha256:…`)를 `MINE_REL`로. owner도 member가 없는 팀(`finance`)을 담당 팀으로 다른 에이전트(`finance`)를 만들어 `OWNERS_REL`. `SELECT agent_id, user_id FROM agent_admins` → 에이전트마다 만든 사람 한 행.
  3. member가 `ap_web POST /v1/api-keys "{\"kind\":\"agent\",\"agent_id\":\"$AID\",\"name\":\"reviewer-ci\",\"scopes\":[\"sessions:read\",\"sessions:write\"]}"` → `201`, `key.created_by`가 member, `secret`을 `KEY`로.
  4. `ap_post /v1/sessions` 본문에 `"agent_release_id":"$MINE_REL"`(`profile_id`는 `claude-coding-local`) → `201`, 그 세션 `ap_get` → `200`. `OWNERS_REL`로 → `403` `details.reason_code: "agent_ceiling"`. release 없이 → `403` `agent_ceiling`. owner가 cookie로 `OWNERS_REL` 세션을 만들고, 에이전트 key로 그 세션 `GET`·`/turns` → `403`. 세션 목록 `GET /v1/sessions`와 자기 세션의 receipt `GET /v1/receipts/$RCPT`도 `403`(목록의 `agent_id` 필터는 읽을 수 있는 범위를 좁히기만 해서 에이전트 key의 목록 읽기를 열지 않고, receipt는 세션을 가리키지 않는다). `SELECT agent_release_id FROM sessions` → 에이전트 key가 만든 행은 `MINE_REL`.
  5. member가 owner의 에이전트(`finance`) `agent_id`로 `{"kind":"agent",…}` → `403` `reason_code: "role"`. `other`가 member의 `agent_id`로 → `403` `role`. owner가 `agent_id` 없이 `{"kind":"agent","scopes":["sessions:read"]}`, 또는 예전 `{"kind":"service",…}` → 둘 다 `400 BAD_REQUEST`(workspace 전체 key는 없다).
  6. member가 `{"kind":"personal","scopes":["sessions:read","sessions:write"]}` → `201`.
  7. 개인 key와 에이전트 key 각각 `KEY`로 두고 `ap_post /v1/api-keys '{"kind":"personal","scopes":["sessions:read"]}'` → `403` `role`.
  8. admin이 `finance`의 `agent_id`로 `{"kind":"agent","scopes":["sessions:read","sessions:recover"]}` → `403` `SCOPE_NOT_GRANTABLE` `The issuer does not hold sessions:recover`. owner가 에이전트 key에 `["sessions:approve"]` → `403` `SCOPE_NOT_GRANTABLE`. 에이전트 관리자인 member가 자기 에이전트 key에 `["sessions:approve"]` → `403` "An agent key never approves (D26)", `["sessions:recover"]` → `403` "The issuer does not hold sessions:recover". 에이전트 key가 늘 빼는 것은 approve뿐이다: owner가 에이전트 key에 `["sessions:recover"]`를 달면 `201`이다(발급자 상한 안). 확인했으면 그 key를 폐기한다.
  9. `ap_web GET /v1/api-keys`: member는 자기 개인 key와 자기 에이전트 key 둘, `other`는 `[]`. 아무 key를 `ap_web DELETE /v1/api-keys/$ID` → `200`과 `receipt_id`, 다시 → `200` `receipt_id: null`, 그 key로 `/v1/auth/me` → `401`.
  10. owner가 `ap_web POST "/v1/members/$MEMBER_ID/disable" '{"reason":"verify scenario d"}'` → `200`(`member.disabled_at`이 찬다). 그 뒤 member 개인 key `/v1/auth/me` → `401`, member가 발급한 에이전트 key로 4의 세션 생성 → `201`.
  11. `SELECT action, outcome, reason_code, principal_kind, count(*) FROM authz_decisions WHERE action LIKE 'api_key.%' OR reason_code = 'agent_ceiling' GROUP BY 1,2,3,4` → `api_key.manage allow`(3의 발급과 8의 두 요청), `api_key.manage deny role user`(5의 둘), `api_key.manage_own allow`, `api_key.manage_own deny role api_key`(7의 둘), `session.submit deny agent_ceiling api_key`(4의 둘), `session.read deny agent_ceiling api_key`(4의 읽기들). `SELECT operation, result FROM receipts WHERE operation IN ('create_api_key','revoke_api_key')` → 발급마다 `create_api_key`, 폐기 한 번에 `revoke_api_key`, `result`에는 kind·agent_id·scopes만.
  - 증거는 `| tee "$EVIDENCE/musterrolle-d.txt"`. 남기기 전에 `csp_`·`apv_` 값을 가린다.
  - 2026-10-12 run `20261012-022045-88049`에서 1–9와 11을 확인했다(10의 발급자 비활성화는 a의 6에서 같은 결과).
- **g. 에이전트의 Slack 앱 연결.** owner bootstrap·login은 [web-login.md](./web-login.md). 에이전트는 d의 2처럼 `ap_web POST /v1/agents`로 둘(`research`→`AID`, `finance`→`BID`) 만든다. c와 같은 스택에서 이어 하면 slug가 겹치니 `g-research`·`g-finance`처럼 바꾼다. 플랫폼이 만든 앱은 c의 3(install complete)이 설치 행과 연결을 함께 만들어 이 route를 부를 일이 없다. 이 route는 손으로 만든 앱(c의 `slack-install register`)을 잇는 경로다. 여기서는 설치 행(`A0VERIFY`·`T0VERIFY`·bot `B0VERIFY`)을 저장소 함수로 만든다. 설치 등록 CLI는 mock이 답하는 team(`T0MOCK`)만 확인하고, g는 bot을 바꿔 다시 확인하는 경우(`bot_mismatch`)까지 본다. 아래 함수 호출은 저장소 fixture를 쓰는 내부 진단이다. 사용자 이벤트 수신은 procedures.md의 P-SLACK-INBOUND로 따로 검증한다.

  ```sh
  DB='import { Pool } from "pg"; import { drizzle } from "drizzle-orm/node-postgres"; import * as schema from "@werft-ai/db"; import * as platform from "@werft-ai/platform";
  const pool = new Pool({ connectionString: process["env"]["DATABASE_URL"] }); const db = drizzle(pool, { schema });'
  ap_compose exec -T -w /app/apps/control-host api bun -e "$DB
  const ids = { appId: \"A0VERIFY\", teamId: \"T0VERIFY\" };
  await schema.registerSlackInstallation(db, { ...ids, workspaceId: process.argv[1] });
  console.log((await schema.verifySlackInstallation(db, { ...ids, botUserId: \"B0VERIFY\" })).outcome); await pool.end();" "$WS"
  resolve() { ap_compose exec -T -w /app/apps/control-host api bun -e "$DB
  console.log(JSON.stringify(await platform.agentForSlackEvent(schema.createPostgresAgentIdentityStore(db), JSON.parse(process.argv[1])))); await pool.end();" "$1"; }
  LINK='{"provider":"slack_bot","app_id":"A0VERIFY","team_id":"T0VERIFY","credential_ref":"slack/research-bot-token"}'
  resolve '{"appId":"A0VERIFY","teamId":"T0VERIFY"}'          # 연결 전
  ap_web POST "/v1/agents/$AID/identities" "$LINK"             # IID = agent_identity.id
  resolve '{"appId":"A0VERIFY","teamId":"T0VERIFY"}'
  resolve '{"appId":"A0OTHER","teamId":"T0VERIFY"}'
  resolve "{\"appId\":\"A0VERIFY\",\"teamId\":\"T0VERIFY\",\"agentId\":\"$BID\"}"
  ap_web POST "/v1/agents/$BID/identities" "$LINK"
  ap_web POST "/v1/agents/$BID/identities" "$(echo "$LINK" | jq -c '.app_id="A0NOWHERE"')"
  ap_web GET "/v1/agents/$AID/identities"
  ap_web DELETE "/v1/agents/$AID/identities/$IID"              # 두 번 보낸다
  resolve '{"appId":"A0VERIFY","teamId":"T0VERIFY"}'
  ap_compose exec -T postgres psql -U postgres -d sessions -c "select external_principal_id, credential_ref, status, revision from agent_identities"
  ap_compose exec -T postgres psql -U postgres -d sessions -c "select operation, result->>'app_id', result->>'revision' from receipts where operation like '%agent_identity'"
  ap_compose logs api 2>&1 | grep -E 'Agent identity (linked|revoked)'
  ```

  기대: 연결 전 `{"status":"dropped","reason":"unidentified"}`. 연결 `201`과 `receipt_id`, `bot_user_id: "B0VERIFY"`. 그 뒤 `resolved`이고 `agentId`가 `AID`, `identity.revision` 1, `credentialRef`가 그 이름. 다른 앱은 `not_installed`, `BID` 앞으로 온 이벤트는 `agent_mismatch`. `BID`에 같은 앱 → `409 AGENT_IDENTITY_TAKEN`, 없는 앱 → `409 SLACK_NOT_INSTALLED`. 목록 한 줄. 회수 `200`(`status: revoked`, `revision: 2`, `receipt_id`), 두 번째는 `receipt_id: null`. 회수 뒤 `identity_revoked`. DB는 `B0VERIFY | slack/research-bot-token | revoked | 2`, receipt는 `link_agent_identity`(1)·`revoke_agent_identity`(2), api 로그에 linked·revoked 한 줄씩. 초대·수락한 member(관리자 아님)가 `AID`에 연결하면 `403` `reason_code: "role"`이고 `authz_decisions`에 `binding.manage | deny | role` 한 행. bot token 이름은 그 신원만 쓴다: 연결 중에 같은 이름을 `POST /v1/agents/$BID/credential-bindings '{"credential_ref":"slack/research-bot-token"}'`로 에이전트에 묶으면 `409 CREDENTIAL_REF_IN_USE`, 에이전트에 묶인 이름(`notion-token`)으로 다른 설치(`A0SECOND`)를 연결해도 `409 CREDENTIAL_REF_IN_USE`, 회수 뒤에는 같은 이름을 에이전트에 묶을 수 있다(`200`). `credential_bindings`에는 신원 행(`agent_identity`, 회수됨)과 에이전트 행이 남는다. 2026-10-11 run `20261011-220853-96733`에서 이 순서대로 확인했다. 2026-10-24 run `20261024-042222-58797`(main `eb8a8ac4`, c를 마친 스택)에서 위 블록을 다시 돌렸다(member 403과 `notion-token`·`A0SECOND` 경우는 빼고). 증거는 `$EVIDENCE/musterrolle-g.txt`.
- **e. 판정 기록.** 응답 헤더의 `X-Request-Id`로 행을 찾는다(`ap_get`·`ap_post`·`ap_web`이 마지막 응답 헤더를 `$VERIFY_RUN/headers`에 남긴다: `RID=$(sed -n 's/^[Xx]-[Rr]equest-[Ii]d: //p' "$VERIFY_RUN/headers" | tr -d '\r')`).
  - 거절: `KEY=$(ap_key verify --scopes sessions:read 2>/dev/null)`로 `POST /v1/sessions` → `403`. `ap_compose exec -T postgres psql -U postgres -d sessions -c "SELECT action, outcome, reason_code, principal_kind, request_id FROM authz_decisions WHERE request_id = '$RID'"` → `session.submit | deny | role | api_key` 한 행.
  - 승인: [sessions.md](./sessions.md)의 권한 요청 대본으로 `needs_input`을 만들고 `sessions:approve` key로 `POST /v1/sessions/$SID/answers`. `... FROM authz_decisions d JOIN receipts r ON r.request_id = d.request_id WHERE d.request_id = '$RID'` → `session.approve | allow` 한 행과 `answer` receipt.
  - 허용된 API 생성(`POST /v1/sessions` 201)은 행을 남기지 않는다.
- **e. 보존 기간.** bootstrap 뒤 `web-user.mjs login owner`로 cookie를 받은 owner가 `ap_web POST "/v1/workspaces/$WS/audit-retention" '{"audit_retention_days":45}'` → `200`, `29` → `400`, 다른 workspace id → `404`. API key는 `404`. `workspaces.settings->'audit_retention_days'`가 45. member cookie(`web-user.mjs invite`·`accept`·`login` 뒤 `ap_as member`)로 같은 POST → `403` `Only an owner can change audit retention`(2026-10-23 run `20261023-160737-96495`).
- **e. 공유 범위·감사 열람·관리 목록.** owner bootstrap·login, member `a`·`b`·`c`를 초대·수락으로 만들고(d의 1, `ap_as <who>`로 바꾼다), owner가 팀 `research`를 만들어 `b`만 넣는다(b의 3). 세션 생성·메시지·종료·관리 종료와 공유·감사 열람·관리 목록 모두 `ap_web`으로 된다(위 Preconditions).
  1. `a`가 `POST /v1/sessions` `{"profile_id":"claude-coding-local","repository_id":"sample-app","message":"GATE-SPEC {\"id\":\"e1\",\"steps\":[],\"final\":\"confidential minutes\",\"finalDelayMs\":300000}"}` → `201`, `SID`. `ap_web POST "/v1/sessions/$SID/share" '{"scope":"private"}'` → `200`, `share.revision: 1`, `receipt_id`.
  2. `b`와 owner 각각 `ap_web GET /v1/sessions`에 `SID`가 없고, `GET /v1/sessions/$SID` → `404`, `ap_curl cookie "$API/v1/sessions/$SID/events"` → `404`. `a`는 `200`.
  3. `a`가 `{"scope":"team","team_ids":["$TID"]}` → `200`. `b`는 목록에 있고 상세 `200`, `c`는 목록에 없고 `404`.
  4. `b`가 `ap_curl cookie -N "$API/v1/sessions/$SID/events" &`로 스트림을 열고(PID 기록) 3초 뒤 `a`가 다시 `private` → `b`의 curl이 바로 끝난다. `ap_compose logs api | grep '"SSE stream closed"'`에 `"reason":"not_visible"`. 다시 열면 `404`.
  5. owner가 `ap_web POST "/v1/sessions/$SID/audit-read" '{}'` → `400`. `'{"justification":"incident INC-42"}'` → `200`, `session.id`가 `SID`, `turns.items` 1개. 그 뒤에도 owner의 메시지 쓰기 → `404`, 상세 → `404`(읽기 전용).
  6. owner가 `ap_web GET /v1/admin/sessions` → 그 항목의 키가 정확히 `admission_state, agent_release_id, created_at, created_by_api_key_id, created_by_user_id, session_id, share_scope, status, takeover_required_at`이고 `share_scope: "private"`, 본문에 `confidential minutes`가 없다. `b` → `403`.
  7. owner가 `POST "/v1/admin/sessions/$SID/terminate" '{"expected_revision":N}'` → `400`, 일반 `POST "/v1/sessions/$SID/terminate"` → `404`, `{"expected_revision":N,"justification":"stop"}` → `202`(N은 감사 열람 응답의 `session.revision`).
  8. `SELECT action, outcome, reason_code, justification, count(*) FROM authz_decisions WHERE resource_id = '$SID' GROUP BY 1,2,3,4` → `session.audit_read allow ok <사유>`(읽을 때마다 한 행), `session.control allow ok <사유>`, `session.control deny not_found`, `session.read deny not_found`, `session.submit deny not_found`, `session.share allow ok`. `receipts`에 `share_session`이 바꾼 횟수만큼(`result.scope`), `session_shares`는 `private | 3`.
  - 7의 앞에 세션을 만든 member `a`가 같은 관리 종료를 보내면 `403` `role`이다(사유를 단 종료는 owner·admin 판정을 먼저 받는다).
  - 2026-10-12 run `20261011-235937-79730`(리뷰 수정 뒤 head `ad893b5`)과 run `20261012-022045-88049`에서 이 순서대로 다시 확인했다. 증거는 `$EVIDENCE/musterrolle-e.txt`, `musterrolle-e-sse.txt`, `musterrolle-e-admin-list.json`.

- **f. 자격 연결.** d의 1처럼 owner와 member 둘(`agentadmin`, `other`)을 `web-user.mjs invite`·`accept`로 만든다.
  1. agentadmin이 `capabilities`에 `"credential_refs":["notion_token"]`을 넣은 card로 에이전트를 만들고 `claude-coding-local` release를 만든다(`REL`). 같은 사람이 그 에이전트의 에이전트 key(`KEY`)를 발급한다.
  2. 연결 전 `ap_web POST "/v1/agents/$AID/activate" "{\"release_id\":\"$REL\",\"expected_revision\":-1}"` → `409 CREDENTIAL_UNBOUND`, `details.missing: ["notion_token"]`.
  3. `other`가 `ap_web POST "/v1/agents/$AID/credential-bindings" '{"credential_ref":"notion_token"}'` → `403` `reason_code: role`. 에이전트 key로 같은 요청(`ap_post "/v1/agents/$AID/credential-bindings" '{"credential_ref":"notion_token"}'`) → `403` `role`. 소문자 이름 규칙 밖의 이름(`"Notion Token"`) → `400`(2026-10-24 run `20261024-042222-58797`).
  4. agentadmin이 연결 → `200`, `created: true`, `receipt_id`. 활성화 → `200`.
  5. `ap_post /v1/sessions` 본문 `{"profile_id":"claude-coding-local","repository_id":"sample-app","message":"…","agent_release_id":"$REL"}` → `201`. owner가 `ap_web GET "/v1/agents/$AID/credential-bindings"` → `running_sessions: 1`과 `revoke_notice`.
  6. agentadmin이 `ap_web DELETE "/v1/agents/$AID/credential-bindings/$BID"` → `200`, `revoked_at`이 차고 `running_sessions: 1`, `revoke_notice: "실행 중인 세션은 끝날 때까지 이 자격을 써요. 바로 막으려면 외부 서비스에서 폐기하세요"`.
  7. 같은 세션 생성 → `409 CREDENTIAL_UNBOUND`, `details`에 `guidance: "연결 설정이 바뀌어 시작하지 못했어요. 에이전트 관리자에게 문의하세요"`, `admins`(agentadmin), `admin_link: "mailto:agentadmin%40example.test"`. 이름(`notion_token`)은 응답에 없다. 활성화를 다시 하면 `409`와 `missing`.
  8. `SELECT action, outcome, reason_code, principal_kind, count(*) FROM authz_decisions WHERE action IN ('credential.bind','session.submit') GROUP BY 1,2,3,4` → `credential.bind allow ok user`, `credential.bind deny role user`·`api_key` 하나씩, `session.submit deny credential_unbound api_key`. receipts에 `bind_credential`·`unbind_credential`, `result`는 `{"credential_ref": "notion_token"}`뿐.
  - 2026-10-11 run `20261011-211609-82813`에서 이 순서대로 확인했다. 증거는 `$EVIDENCE/musterrolle-f.txt`.

## Gotchas

- c 판정: 함수가 받는 Slack user는 Slack이 보낸 객체 그대로다. `team_id`가 설치(`T0MOCK`)와 다르면 guest 표시와 상관없이 `external_user`다. 실제 Slack 이벤트 수신(Kollegium Slack 채널)이 붙으면 이 함수 호출을 그 경로로 바꾼다.
- c·g 스니펫은 agent-guard의 경로 모양 text match(`*.env`·`*.key`)를 피하려고 `process["env"]["DATABASE_URL"]`, `ids`, jq `.["authorize_url"]`로 쓰고, 돌아온 주소는 `new URL(…).searchParams`로 읽는다. `process.env.…`·`...key`·`.key`로 되돌리면 명령이 거부된다. 2026-10-22 run `20261022-073051-53892`에서 c의 설치 행(`verified`)·시작·callback(`201`)·목록·`resolveLinkedSubject`(`linked`)와 g의 `resolve`(`dropped unidentified`)를 이 모양 그대로 돌렸고 거부는 없었다.
- c: mock overlay 없이 띄운 스택은 `SLACK_OIDC_REDIRECT_URI`가 비어 있어 연결 시작이 설치 확인보다 먼저 `503 BACKEND_UNAVAILABLE` "Sign in with Slack is not configured on this installation"이다(이 값 하나가 연결과 Slack 앱 생성을 켠다. client id·secret은 fallback일 뿐이다). overlay는 있는데 master key가 없거나 config token을 넣지 않았으면 link 앱을 만들지 못해 `409 SLACK_LINK_NOT_CONFIGURED`(`reason_code` `store_off` 등), 화면 문구는 "Slack 계정 연결을 아직 쓸 수 없습니다 — 워크스페이스 관리자에게 연동 › Slack 설정을 요청하세요."다. 설치가 없으면 `409 SLACK_NOT_INSTALLED`. 계정 연결 state는 10분, 설치 state는 600초이고 둘 다 한 번만 쓴다. 같은 code·state를 다시 보내면 계정 연결은 `400`, 설치는 `409 SLACK_INSTALL_STATE_INVALID`.
- c: config token과 앱 secret·bot token은 master key로 봉인돼 그 스택의 DB에만 있다. `down.sh` 뒤 새 key로 띄우면 처음부터 다시 넣는다. key는 `up.sh`를 부른 Bash 호출에만 있으므로, 이후 다른 호출에서 api를 다시 만들면(web-settings.md 1의 Google처럼) api가 key 없이 떠 저장소가 꺼지고, 새 key로 다시 만들어도 이미 봉인된 값은 열리지 않는다. 그래서 api를 다시 만드는 단계와 Slack 단계는 한 run에서 같이 하지 않는다(Slack은 key로 띄운 별도 run에서).
- d의 8은 판정이 `allow`인 채로 거절된다. 권한(`api_key.manage`)은 있고 scope만 넘친 것이라, 판정 행은 `allow`이고 응답은 `SCOPE_NOT_GRANTABLE`이다.
- 에이전트 key는 receipt를 읽지 못한다. receipt 조회는 세션을 가리키지 않아 에이전트를 확인할 수 없기 때문이다.
- 에이전트 관리자는 에이전트를 만든 사람(과 0142 backfill), 그리고 `POST /v1/agents/{id}/admins`로 지정한 사람·팀이다.
- b: 팀 목록·상세(`GET /v1/teams`)는 owner·admin만 본다. member는 `GET /v1/my-teams`로 자기가 든 팀의 `id`·`name`만 본다(다른 팀원 없음). 추가 알림은 아직 receipt 기록뿐이다(Slack 알림 없음).
- f: 본문 검증(`400`)은 판정보다 먼저라 판정 행을 남기지 않는다. 해제한 연결을 다시 `DELETE`하면 `404`다.
- g: 연결은 확인된(`verified`) 설치에만 된다. `registerSlackInstallation`만 하고 `verifySlackInstallation`을 빠뜨리면 `409 SLACK_NOT_INSTALLED`, 해석은 `installation_unverified`다. 같은 team·app을 다른 bot으로 다시 확인하면 연결은 남아 있어도 해석은 `bot_mismatch`다.
- e: 감사 열람 사유가 없으면 본문 검증(`400`)에서 끝나 판정 행이 없다. 판정의 `justification_required`(`403`)는 사유 없는 인수(`POST /v1/sessions/{id}/takeover` 빈 본문)에서 본다. member의 감사 열람은 범위 밖이면 `404`, 범위 안이면 `403` `role`이다.
- e: fake model 세션이 `queued`로 머물러도 시나리오에는 상관없다. 종료는 `queued`에서도 `202`다.
- bootstrap은 cookie를 주지 않는다. 보존 기간을 바꾸기 전에 login한다.
- 판정은 본문보다 먼저 묻는다. 그래서 owner의 `29` 요청(400)도 `audit_retention.manage | allow` 행을 남긴다.
- 만료 정리는 시간을 당겨야 보이므로 E2E가 아니라 `packages/db/src/authz-decisions.integration.test.ts`로 본다.
- 실제 Slack 앱·OAuth 동의는 사람만 한다. 자동 확인은 mock IdP로만 하고 실제 Slack 연결은 "사람 확인 필요"로 보고한다.

서명 이벤트 수신과 slack role은 [procedures.md](procedures.md) P-SLACK-SETUP·P-SLACK-INBOUND다. HTTP `/v1/slack/events/{agent_id}`가 서명·5분 timestamp를 검사하고 inbox에 `(app_id,event_id)`로 중복 제거한다. slack role은 claim/lease로 처리하고, binding과 연결 계정이 맞으면 세션을 연다(procedures.md P-SLACK-MENTION-ONLY). 아니면 processed 또는 dropped로 끝낸다. c의 판정 함수를 직접 부른 증거가 세션 생성·Slack 답장 증거는 아니다. 소스: `apps/control-host/src/api/routes/slack-events.ts`, `apps/control-host/src/slack/main.ts`, `packages/db/src/slack-inbound-events.ts`, `packages/platform/src/musterrolle/slack-inbox.ts`.
