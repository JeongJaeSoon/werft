# 화면·API 실행 절차

기본 run은 위에서 아래로 실행한다. Slack, 실제 GitHub, 데모는 아래 별도 run이다. 각 id에 요청·본문·마지막 상태 줄·화면 증거를 붙여 보고한다. 이 문서는 코드 대조 결과다. 라이브 실행 증거는 실행자가 채운다.

## P-SETUP — 공통 전제

zsh(Claude Code Bash 도구) 또는 bash 4 이상에서 실행한다. macOS `/bin/bash` 3.2는 중첩 command substitution 안의 GATE-SPEC JSON 인용을 깨뜨려 `unterminated GATE-SPEC`·`api_error`를 만들 수 있다.

`up.sh` 기본 모드로 시작한다. 출력된 id를 아래 `RUN`에 넣는다. 이후 셸 호출마다 아래 doctor 앞의 prelude를 다시 실행한다. ID는 설정 직후 `NAME=값` 줄로 출력되고, 그 줄을 Write 도구로 run의 `ids.sh`에 적는다(Bash의 `>>`·heredoc으로 파일을 만들지 않는다). Write는 파일 전체를 덮어쓰므로 지금까지 출력된 줄을 모두 적는다. 새 셸에서는 이 파일을 복원한다. 각 절차의 `ap_as <who>`는 cookie와 개인 key를 다시 로드한다. 각 `sh` 블록은 앞 절차의 서버·브라우저 상태와 `ids.sh`만 이어받으며, 새 셸에서 prelude만 실행한 뒤 그대로 실행할 수 있다. 인증 API를 호출하는 블록은 블록 안에서 해당 사용자의 `ap_as`를 실행한다. 원시 key와 요청 직전 revision은 사용하는 블록 안에서 준비한다. 자격 파일 내용은 출력하지 않는다.

```sh
RUN='<run-id>'
. scripts/verify/lib.sh "$RUN"
U=scripts/verify/web-user.mjs
B=scripts/verify/browser.mjs
[ ! -f "$VERIFY_RUN/ids.sh" ] || . "$VERIFY_RUN/ids.sh"
scripts/verify/doctor.sh "$RUN"
```

`ids.sh` 경로는 `echo "$VERIFY_RUN/ids.sh"`로 읽는다. ID 저장은 아래 `printf`처럼 값이 UUID인 ID에만 쓴다. key·cookie·OAuth 값은 `ids.sh`에 저장하지 않는다. 새 run에서는 그 run의 파일만 복원한다.

기대: doctor exit 0. 출력 SHA가 검사할 checkout이다. 이후 JSON은 `head -1` 뒤 jq, 상태는 원래 출력 마지막 줄로 판정한다. POST에는 `ap_post`·`ap_web`이 Idempotency-Key를 붙인다.

## P-API-READY — 공개 운영 표면

전제: P-SETUP.

```sh
# Actor: unauthenticated public probe.
curl -sS -w '\n%{http_code}\n' "$API/readyz"
curl -sS -w '\n%{http_code}\n' "$API/healthz"
curl -sS -o "$EVIDENCE/docs.html" -w '%{http_code} %{content_type}\n' "$API/docs"
curl -sS -w '\n%{http_code}\n' "$API/v1/nope"
```

기대: readyz 200, `status:"ready"`, `checks.database/schema/config:"ok"`. healthz 200 `status:"ok"`. docs 200 HTML. 인증 없는 v1/nope는 401 JSON이며 SPA HTML이 아니다.

## P-WEB-LOGIN — 로그인·bootstrap·공개 콜백

전제: 사용자가 없는 기본 run. 화면 locale은 한국어로 맞춘다(공개 화면 footer의 언어 select에서 `ko`).

```sh
# Actor: unauthenticated until owner login below.
node "$B" "$RUN" start
node "$B" "$RUN" open /
node "$B" "$RUN" select "footer select" ko
node "$B" "$RUN" eval 'document.querySelector("main").innerText'
node "$U" "$RUN" bootstrap-bad-token owner
node "$U" "$RUN" bootstrap owner
node "$U" "$RUN" bootstrap owner
node "$U" "$RUN" login-wrong owner
node "$U" "$RUN" login-no-csrf owner
node "$B" "$RUN" bootstrap owner
node "$B" "$RUN" login owner
node "$U" "$RUN" login owner
ap_as owner
ap_web GET /v1/auth/me
ap_web GET /v1/auth/login-methods
ap_web POST /v1/auth/providers/00000000-0000-4000-8000-000000000000/start '{}'
```

기대: 처음 `/login?redirect=%2F`, “로그인이 필요합니다”. 잘못된 bootstrap 401, 첫 bootstrap 201, 두 번째 401(쓴 링크). 잘못된 로그인 401, CSRF 없는 로그인 403. 이미 owner가 있는 화면 bootstrap은 폼 없이 “이 설정 링크는 쓸 수 없습니다”와 로그인 화면으로 가는 버튼. 화면 로그인은 `/`. API 로그인 200, me 200과 `principal`·`user`·`workspace`·`permissions`·`scopes`. login-methods는 `{"password":"on","providers":[]}`, 없는 공급자의 start는 404. 기본 run에서는 공급자 로그인의 성공 콜백을 검증하지 않는다. 공급자 버튼은 [web-settings.md](web-settings.md) 1로 띄운다.

```sh
# Actor: owner.
ap_as owner
WS=$(ap_web GET /v1/auth/me | head -1 | jq -r .workspace.id)
printf 'WS=%s\n' "$WS"   # ids.sh에 적는다(P-SETUP)
node "$B" "$RUN" open /auth/callback/00000000-0000-4000-8000-000000000000
node "$B" "$RUN" eval 'document.querySelector("main").innerText'
node "$B" "$RUN" open /login
node "$B" "$RUN" eval 'document.querySelector("main").innerText'
```

기대: code/state 없는 공급자 callback은 “SSO 로그인 / 로그인을 마치지 못했습니다 — 다시 시도하세요. / 로그인 화면으로”. 로그인 상태의 login은 “이미 owner@example.test 계정으로 로그인되어 있습니다”와 “워크스페이스로 가기”. 비밀번호·cookie·초대 링크는 eval로 읽지 않는다.

## P-API-MEMBERS — 초대·수락·목록

전제: owner cookie. member 수락은 화면으로 확인하고 API cookie도 만든다.

```sh
# Actor: owner.
ap_as owner
node "$U" "$RUN" invite owner member member
node "$B" "$RUN" open /
node "$B" "$RUN" click 'Verify Owner'
node "$B" "$RUN" click 로그아웃
node "$B" "$RUN" accept member
node "$U" "$RUN" login member
ap_as member
ap_web GET /v1/auth/me
ap_web GET /v1/members
ap_as owner
ap_web GET /v1/members
ap_web GET /v1/invites
MID=$(ap_web GET /v1/members | head -1 | jq -r '.items[] | select(.email=="member@example.test") | .user_id')
printf 'MID=%s\n' "$MID"
```

기대: invite 201 `invite_id`·`expires_at`(token은 helper가 저장). 브라우저 수락 `/`. member me의 역할 `member`, member 목록 API 403, owner 목록 200 `items`, API `/v1/invites`에는 수락한 초대도 `status:"accepted"`·`accepted_at`과 함께 남는다. UI 구성원 표는 pending과 만료된 초대만 “초대 중”·“만료” 행으로 보인다. `MID`가 비어 있으면 다음으로 가지 말고 실제 목록 키를 보고 실패로 보고한다.

## P-WEB-MEMBERS — 구성원·팀 화면

전제: member가 수락했고 owner로 브라우저 재로그인한다.

```sh
# Actor: owner.
ap_as owner
node "$B" "$RUN" open /
node "$B" "$RUN" click 'Verify Member'
node "$B" "$RUN" click 로그아웃
node "$B" "$RUN" login owner
node "$B" "$RUN" open /members
node "$B" "$RUN" eval 'document.querySelector("main").innerText'
node "$B" "$RUN" shot members
node "$B" "$RUN" eval '({table:document.querySelector("[role=table]")?.getAttribute("aria-label"),headers:[...document.querySelectorAll("[role=columnheader]")].map(x=>x.innerText),tr:document.querySelectorAll("tr").length})'
node "$B" "$RUN" click '구성원 초대'
node "$B" "$RUN" eval '({search:location.search,fields:[...document.querySelectorAll("[role=dialog] input,[role=dialog] select")].map(x=>({type:x.type,name:x.name})),buttons:[...document.querySelectorAll("[role=dialog] button")].map(x=>x.innerText)})'
node "$B" "$RUN" type '[role=dialog] input[type=email]' invitee@example.test
node "$B" "$RUN" click '[role=dialog] form button[type=submit]'
node "$B" "$RUN" click 닫기
node "$B" "$RUN" click '복사하지 않고 나가기'
node "$B" "$RUN" eval 'document.querySelector("main").innerText'
node "$B" "$RUN" open /members/teams
node "$B" "$RUN" eval 'document.querySelector("main").innerText'
```

기대: 구성원·팀 LinkTabs이고 탭 아래 구역 제목은 없다. 머리의 버튼은 구성원 탭에서 “구성원 초대”, 팀 탭에서 “팀 만들기”다. 표 위 SegmentedControl “역할로 보기”는 전체·오너·어드민·멤버와 개수이며 검색과 함께 거른다. 구성원 표는 `role=table`, 이름 “구성원 표”의 GridTable이며 tr/td가 아니다. 행을 누르면 편집이 열린다. “구성원 초대”로 `?invite.step=details`를 열고 제출 “초대 링크 만들기” 뒤 `?invite.step=link`로 간다. “닫기”의 확인에서 “복사하지 않고 나가기”를 고른다. 초대 완료 링크는 한 번만 보이며 snapshot/shot으로 남기지 않는다. 닫은 뒤 구성원 표에 invitee가 상태 “초대 중” 행으로 있고, 그 행 메뉴에 “회수”가 있다. 옛 주소 `/members/invites`는 `/members`로 옮겨지고, `/teams`는 없는 화면이다. 320px에서 표만 가로 스크롤하고 관리 버튼과 배지가 겹치지 않는다.

역할·비활성은 수락한 member에만 수행한다. owner를 비활성화하지 않는다.

```sh
# Actor: owner.
ap_as owner
ap_web PATCH "/v1/members/$MID" '{"role":"admin"}'
ap_web POST "/v1/members/$MID/disable" '{"reason":"verify"}'
ap_web POST "/v1/members/$MID/enable" '{}'
ap_web PATCH "/v1/members/$MID" '{"role":"member"}'
node "$U" "$RUN" login member
```

기대: 모두 200. PATCH는 member 객체 자체(`user_id`·`role`), disable/enable은 `member`·`receipt_id`. disable 뒤 `member.disabled_at`이 있고 enable 뒤 null. 마지막 role member. 비활성 때 기존 cookie는 무효가 되므로 다시 로그인한다. 보호된 owner·마지막 owner·사용자 단위 비활성·인수 시나리오는 [musterrolle.md](musterrolle.md) a의 별도 계정으로 수행한다.

## P-API-TEAMS — 팀·에이전트 관리자

전제: owner cookie와 MID.

```sh
# Actor: owner.
ap_as owner
TEAM=$(ap_web POST /v1/teams '{"name":"Verify team"}')
printf '%s\n' "$TEAM"
TID=$(printf '%s\n' "$TEAM" | head -1 | jq -r .team.id)
printf 'TID=%s\n' "$TID"
ap_web POST "/v1/teams/$TID/members" "$(jq -nc --arg u "$MID" '{user_id:$u}')"
ap_web GET "/v1/teams/$TID"
ap_web PATCH "/v1/teams/$TID" '{"name":"Verify renamed"}'
ap_web GET /v1/teams
ap_as member
ap_web GET /v1/my-teams
ap_as owner
```

기대: create 201, add·get·rename·list 200. team 이름 Verify renamed와 member가 보인다. my-teams에도 그 팀이 있다. 브라우저 `/members/teams/$TID`에서 이름과 “팀 구성원 N명” 표(구성원·역할·추가한 날·관리 열, 640px 이하에서 추가한 날이 빠진다), 검색 combobox “추가할 사람”(이름·이메일로 찾고 고르면 칩으로 쌓이며 버튼이 “추가”→“N명 추가”), 목록 검색 칸, 위험 영역의 “팀 삭제”를 확인한다. combobox는 native select가 아니므로 `select`가 아니라 `type '[role=combobox]' '<이름>'` → `key ArrowDown` → `key Enter`로 고른다. 팀 구성원(member)에게는 역할·관리 열과 추가 칸·위험 영역이 없고 `/v1/members`를 부르지 않는다. 삭제는 아래 마지막 정리에서 한다.

## P-API-AGENTS — 카드·release·활성화·관리자

전제: owner cookie. 모델과 연결은 fake-model 설정 문서 기준이다(연결 `fake-messages`).

```sh
# Actor: owner.
ap_as owner
ap_web GET /v1/connections
CARD='{"role":"verify helper","instructions":"Answer briefly.","language":"ko","model":"claude-sonnet-5","capabilities":{"tools":["Read"],"mcp":null,"forbidden":[]},"rules":[]}'
# Every new agent names a managing team (400 without one).
TEAM=$(ap_web POST /v1/teams '{"name":"verify"}' | head -1 | jq -r .team.id)
AGENT=$(ap_web POST /v1/agents "$(jq -nc --argjson c "$CARD" --arg t "$TEAM" '{slug:"verify-helper",name:"Verify Helper",managing_team_id:$t,card:$c}')")
printf '%s\n' "$AGENT"
AID=$(printf '%s\n' "$AGENT" | head -1 | jq -r .agent.id)
printf 'AID=%s\n' "$AID"
VID=$(printf '%s\n' "$AGENT" | head -1 | jq -r '.versions[0].id')
printf 'VID=%s\n' "$VID"
RELEASE=$(ap_web POST "/v1/agents/$AID/releases" "$(jq -nc --arg v "$VID" '{version_id:$v,connection_id:"fake-messages",repository_id:"sample-app"}')")
printf '%s\n' "$RELEASE"
REL=$(printf '%s\n' "$RELEASE" | head -1 | jq -r .release.id)
printf 'REL=%s\n' "$REL"
ap_web POST "/v1/agents/$AID/activate" "$(jq -nc --arg r "$REL" '{release_id:$r,expected_revision:-1}')"
ap_web GET "/v1/agents/$AID"
ap_web GET /v1/agents
ap_web GET /v1/administered-agents
ap_web POST "/v1/agents/$AID/admins" "$(jq -nc --arg t "$TID" '{team_id:$t}')"
ap_web GET "/v1/agents/$AID/admins"
ap_web GET "/v1/agents/$AID/credential-bindings"
```

기대: connections 200 `items`(연결마다 모델 목록). agent create 201 `agent`·`versions`. release 200 `release.id`. activate 200. 관리 목록에 에이전트가 있고 관리자 목록에 만든 owner와 추가 팀이 있다. credential-bindings는 200 빈 목록. 소스: `apps/control-host/src/api/routes/agents/agents.ts`, `agent-identities.ts`, `credential-bindings.ts`, `teams.ts`와 contracts의 musterrolle 스키마.

## P-WEB-AGENTS — 목록·마법사·상세

전제: owner 브라우저, API로 만든 Verify Helper가 있다.

```sh
# Actor: owner.
ap_as owner
node "$B" "$RUN" open /agents
node "$B" "$RUN" eval 'document.querySelector("main").innerText'
node "$B" "$RUN" shot agents
node "$B" "$RUN" open "/agents/$AID"
node "$B" "$RUN" press 카드 Enter
node "$B" "$RUN" eval '({search:location.search,tabs:[...document.querySelectorAll("[role=tab]")].map(x=>({text:x.innerText,selected:x.getAttribute("aria-selected")}))})'
node "$B" "$RUN" eval 'document.querySelector("main").innerText'
node "$B" "$RUN" press 릴리스 Enter
node "$B" "$RUN" eval '({search:location.search,tabs:[...document.querySelectorAll("[role=tab]")].map(x=>({text:x.innerText,selected:x.getAttribute("aria-selected")}))})'
node "$B" "$RUN" eval 'document.querySelector("main").innerText'
node "$B" "$RUN" press 관리자 Enter
node "$B" "$RUN" eval '({search:location.search,tabs:[...document.querySelectorAll("[role=tab]")].map(x=>({text:x.innerText,selected:x.getAttribute("aria-selected")}))})'
node "$B" "$RUN" eval 'document.querySelector("main").innerText'
node "$B" "$RUN" open /agents/new
node "$B" "$RUN" eval 'document.querySelector("main").innerText'
```

기대: 목록 “전체”·“관리하는 에이전트” SegmentedControl과 개수, 카드/표 보기. 상세 탭은 개요·카드·릴리스·관리자. 릴리스 탭에는 자격 연결 단계가 있다. 각 탭의 `aria-selected`가 true인지 출력으로 확인한다. Radix 탭은 `el.click()`만으로 활성화되지 않으므로 `press … Enter`를 쓴다. 탭 주소 `?tab=card|release|admins`, 개요는 생략한다. 새 에이전트 마법사 이름 → 하는 일 → 릴리스 → 켜기. 아래 마법사를 한 번 실행한다(이름이 겹치면 실패).

```sh
node "$B" "$RUN" type @0 'Member Helper'
node "$B" "$RUN" click 다음
node "$B" "$RUN" type @0 'verify helper'
node "$B" "$RUN" type @1 'Answer briefly.'
node "$B" "$RUN" select @3 claude-sonnet-5
node "$B" "$RUN" click '초안 저장하고 다음'
node "$B" "$RUN" click '릴리스 만들기'
node "$B" "$RUN" click '에이전트 켜기'
node "$B" "$RUN" click '에이전트 보기'
node "$B" "$RUN" eval 'document.querySelector("main").innerText'
```

기대: 새 상세에 Member Helper가 활성화되어 있다. 상세에서 카드 저장 후 버전 증가, 릴리스 탭 release·활성화 후 활성 버전을 API로 재조회한다. API PATCH 카드·관리자 삭제·자격 연결/해제·활성화 충돌은 같은 파일의 상세 절차와 [musterrolle.md](musterrolle.md) f를 쓴다. f는 secret catalog 전제가 없으면 생략 사유를 기록한다.

## P-API-CREDENTIALS — 자격 이름 연결·해제

전제: AID, owner cookie. secret 값이 아니라 사용하지 않는 이름만 연결한다. 실제 외부 자격값의 유효성을 검사하는 절차가 아니다.

```sh
# Actor: owner.
ap_as owner
BOUND=$(ap_web POST "/v1/agents/$AID/credential-bindings" '{"credential_ref":"verify-reference"}')
printf '%s\n' "$BOUND"
BINDING=$(printf '%s\n' "$BOUND" | head -1 | jq -r .binding.id)
printf 'BINDING=%s\n' "$BINDING"
ap_web GET "/v1/agents/$AID/credential-bindings"
ap_web POST "/v1/agents/$AID/credential-bindings" '{"credential_ref":"verify-reference"}'
ap_web DELETE "/v1/agents/$AID/credential-bindings/$BINDING"
ap_web GET "/v1/agents/$AID/credential-bindings"
```

기대: 최초 연결 200 `created:true`, binding.credential_ref verify-reference, receipt_id. 중복 연결 200 `created:false`, receipt_id null. 목록에 해당 이름, 삭제 200 revoked_at·revoke_notice·receipt_id. 마지막 활성 목록에서 빠진다. source: `packages/contracts/src/musterrolle/credential-bindings.ts`, `packages/platform/src/musterrolle/credential-binding-service.ts`.

## P-API-KEYS — 개인 key·에이전트 key·CLI

전제: owner/member cookie. key secret은 helper만 받는다.

```sh
# Actor: owner.
ap_as owner
node "$U" "$RUN" key owner personal sessions:read,sessions:write,sessions:approve,sessions:control,sessions:recover
node "$U" "$RUN" key member personal sessions:read,sessions:write,sessions:approve,sessions:control
ap_as owner
ap_web GET /v1/api-keys
ap_get /v1/auth/me
OPKEY=$(ap_key verify --scopes sessions:read 2>"$VERIFY_RUN/operator-id.txt")
SAVED_KEY=$KEY
KEY=$OPKEY
ap_get /v1
ap_post /v1/sessions "$(jq -nc --arg r "$REL" '{agent_release_id:$r,repository_id:"sample-app",message:"scope probe"}')"
OKID=$(sed -n 's/.*key_id \([^ ]*\).*/\1/p' "$VERIFY_RUN/operator-id.txt" | head -1)
printf 'OKID=%s\n' "$OKID"
ap_revoke "$OKID"
KEY=$OPKEY
ap_get /v1
KEY=$SAVED_KEY
unset OPKEY SAVED_KEY
```

기대: 두 개인 key 201, 목록 200 `items`, key me 200 `principal.kind:"api_key"`. CLI key의 root는 200 `owner_id:"verify"`, read-only key POST는 403(scope 검사). 이어 revoked 출력과 같은 key로 401을 확인한다. 원시 CLI key는 이 블록의 변수로만 보관하고 마지막에 지운다. 사용자 개인 key는 뒤 절차에 쓰므로 아직 폐기하지 않는다. 에이전트 key 상한은 [musterrolle.md](musterrolle.md) d(별도 사용자 이름 사용).

## P-API-SESSIONS-CREATE — 모델 선택·턴·receipt

전제: owner 개인 key, REL. 이 세션은 뒤 절차 끝까지 유지한다.

```sh
# Actor: owner.
ap_as owner
CREATED=$(ap_post /v1/sessions "$(jq -nc --arg r "$REL" '{repository_id:"sample-app",agent_release_id:$r,model:"claude-sonnet-5",title:"Verify list target",message:"GATE-SPEC {\"id\":\"verify-list\",\"steps\":[],\"final\":\"hello from verify\"}"}')")
printf '%s\n' "$CREATED"
SID=$(printf '%s\n' "$CREATED" | head -1 | jq -r .session_id)
printf 'SID=%s\n' "$SID"
RCPT=$(printf '%s\n' "$CREATED" | head -1 | jq -r .receipt_id)
printf 'RCPT=%s\n' "$RCPT"
for i in $(seq 1 90); do
  [ "$(ap_get "/v1/sessions/$SID/turns/1" | head -1 | jq -r .status)" = completed ] && break
  sleep 2
done
ap_get "/v1/sessions/$SID/turns/1"
ap_get "/v1/sessions/$SID/turns"
ap_get "/v1/receipts/$RCPT"
ap_get "/v1/sessions/$SID"
```

기대: create 201 `status:"queued"`, `turn_id:"1"`. turn 200 `status:"completed"`, `result.subtype:"success"`. turns `items`. receipt 200. detail `model:"claude-sonnet-5"`, `runtime.model`도 동일, `agent.id==AID`, `agent.release_version_no:1`, `created_by.display_name:"Verify Owner"`, `channel:"api"`, `repository.id:"sample-app"`, `repository.full_name:"agent/sample-app"`, `repository.branch:"main"`이다.

`model`을 빼면 release 카드 모델이다. 선택은 POST body의 `model`, 가능한 값은 release 연결의 모델 목록(`/v1/connections`, `tests/fixtures/settings/fake-model.json`의 `connections.fake-messages.models`)이다. `agent_release_id`는 언제나 필요하다. `repository.branch`는 clone 기준이며 push 작업 브랜치는 `agent/$SID`다. 상세 정보 탭의 브랜치는 현재 “아직 볼 수 없습니다”이다. 소스: `packages/contracts/src/api/session.ts`, `packages/platform/src/sessions/session-service.ts`, `packages/react/src/blocks/session-detail.tsx`.

다음은 허용하지 않은 모델을 거절하는 경로다.

```sh
# Actor: owner.
ap_as owner
ap_post /v1/sessions "$(jq -nc --arg r "$REL" '{agent_release_id:$r,repository_id:"sample-app",model:"verify-unlisted-model",message:"model probe"}')"
```

기대: 422 `UNSUPPORTED_CAPABILITY`. fake-model 설정 문서의 `fake-messages` 연결은 모델 목록에 claude-sonnet-5 하나만 둔다. 서로 다른 허용 모델 사이의 선택까지 검증하려면 같은 fake provider를 쓰며 models 허용 목록에 두 모델을 둔 별도 설정 문서가 필요하다. 실제 provider로 바꾸지 않는다. source: `tests/fixtures/settings/fake-model.json`, `packages/platform/src/sessions/session-service.ts`, `apps/control-host/src/api/routes/errors.ts`.

## P-API-SESSIONS-LIST — 필터·개수·응답 필드

전제: P-API-SESSIONS-CREATE 완료, 생성한 SID가 idle. 새 기본 run에서 만든 유일한 세션의 제목이다.

```sh
# Actor: owner.
ap_as owner
ap_get '/v1/sessions?relation=started&q=Verify%20list%20target&status=idle'
ap_get '/v1/sessions/counts?relation=started&q=Verify%20list%20target'
ap_get '/v1/sessions?relation=shared&q=Verify%20list%20target'
ap_get '/v1/sessions?relation=administered&q=Verify%20list%20target'
ap_get '/v1/sessions?relation=all&q=Verify%20list%20target'
ap_get '/v1/sessions?relation=invalid'
ap_get '/v1/sessions?status=closed'
```

기대: 첫 목록 200 `items` 한 개, `next_cursor:null`; id=SID. counts 200 `total:1`, `counts.idle:1`, `queued/running/needs_input/failed/stopped:0`. shared는 자기 세션을 빼므로 빈 items. administered는 자신이 관리하는 AID의 세션을 포함한다. all도 포함. 잘못된 relation/status는 400. API q는 제목 대소문자 무시 부분 일치·ID prefix이며 최대 200자. 다른 사람의 private 세션은 목록·counts로 넓혀 볼 수 없다([musterrolle.md](musterrolle.md) e).

`channel`·`created_by`는 query가 아니다. 응답 필드다. 목록의 `agent`·`created_by`·`channel`·`model`·`repository`를 detail과 비교한다. `created_by`는 takeover 뒤에도 최초 시작한 사람이고 legacy·발급자 없는 key는 null일 수 있다. 소스: `packages/contracts/src/api/session.ts`, `packages/db/src/session-relations.integration.test.ts`.

## P-API-SHARE — 제목·공유·관리 열람

전제: SID·MID·TID와 owner/member cookie. owner가 만든 세션으로 공유를 바꿔 확인하고 원복한다.

```sh
# Actor: owner.
ap_as owner
ap_web PATCH "/v1/sessions/$SID" '{"title":"Verify renamed target"}'
ap_web GET "/v1/sessions/$SID/share"
ap_web POST "/v1/sessions/$SID/share" '{"scope":"private"}'
ap_as member
ap_web GET "/v1/sessions/$SID"
ap_web GET '/v1/sessions?relation=shared&q=Verify%20renamed%20target'
ap_as owner
ap_web POST "/v1/sessions/$SID/share" "$(jq -nc --arg u "$MID" '{scope:"people",user_ids:[$u]}')"
ap_as member
ap_web GET '/v1/sessions?relation=shared&q=Verify%20renamed%20target'
ap_web GET '/v1/sessions/counts?relation=shared&q=Verify%20renamed%20target'
ap_as owner
ap_web POST "/v1/sessions/$SID/share" "$(jq -nc --arg t "$TID" '{scope:"team",team_ids:[$t]}')"
ap_web POST "/v1/sessions/$SID/share" '{"scope":"workspace"}'
ap_web GET /v1/admin/sessions
ap_web POST "/v1/sessions/$SID/audit-read" '{"justification":"verify audit read"}'
ap_web GET /v1/takeovers
```

기대: rename 200 title 변경, share GET 200 `scope:"workspace"`, share 변경 200 `share`·`receipt_id`. private 뒤 member detail 404, shared 목록 items 빈 배열. people 뒤 shared 목록 SID 한 개와 counts total 1. team·workspace 변경 200. admin 목록 200 `items[].session_id`(내용 없는 메타데이터), audit-read 200 `session`·`turns`. 인수 대기는 현재 빈 items. source: `packages/contracts/src/musterrolle/session-shares.ts`, `takeovers.ts`, `apps/control-host/src/api/routes/musterrolle/session-shares.ts`.

## P-API-USAGE — 내 합계·설치 합계·한도

전제: owner key와 member cookie. UTC 오늘보다 앞선 기간을 쓴다.

```sh
# Actor: owner.
ap_as owner
SINCE=$(date -u +%Y-%m-01)
ap_get "/v1/usage/summary?scope=me&since=$SINCE"
ap_web GET "/v1/usage/summary?scope=me&since=$SINCE"
ap_web GET "/v1/usage/summary?scope=installation&since=$SINCE"
ap_web GET /v1/limits
ap_get /v1/limits
ap_get "/v1/usage/summary?scope=installation&since=$SINCE"
ap_get "/v1/sessions/$SID/usage"
ap_get '/v1/usage/summary?scope=me&since=2026-10-02&until=2026-10-01'
ap_as member
ap_web GET "/v1/usage/summary?scope=me&since=$SINCE"
ap_web GET "/v1/usage/summary?scope=installation&since=$SINCE"
ap_web GET /v1/limits
ap_as owner
```

기대: owner key/cookie `me` 모두 200, 같은 사용자 세션 집계. summary 키 `scope,period,refreshed_at,session_count,cost_usd,cost_complete,token_count,run_seconds,basis`. basis는 `sessions:"created_in_period"`, `cost:"provider_usage_estimate"`, `run_time:"turn_wall_clock"`. 기간은 since 포함·until 제외이며 생성 시각 기준이다. owner cookie installation·limits만 200. key의 installation·limits와 member의 installation·limits는 403. member me는 200(아직 만든 세션이 없으면 session_count 0). 역순 기간은 400.

limits는 `scope:"installation"`, `limits.execution_slot_limit`, `usage.execution_slots_used`, `usage.storage.accounted_content:["input_messages"]`. session usage는 200 `session_id==SID`, `period:"session_lifetime"`, `cost.source:"provider_usage"`, `cost.completeness_scope:"turn_reports"`, `token_count`, `queued_input_count`. 가변 비용·토큰에 고정 숫자를 기대하지 않는다. 소스: `packages/contracts/src/api/usage.ts`, `packages/platform/src/usage/usage-service.ts`.

## P-WEB-HOME — shell·요청함·상대 시각

전제: owner 브라우저. 완료된 SID가 있다.

```sh
# Actor: owner.
ap_as owner
node "$B" "$RUN" open /
node "$B" "$RUN" shot home
node "$B" "$RUN" eval '({links:[...document.querySelectorAll("[data-slot=app-sidebar] nav a")].map(x=>x.innerText),times:[...document.querySelectorAll("main time")].map(x=>({text:x.innerText,tabIndex:x.tabIndex}))})'
node "$B" "$RUN" key Tab 1
node "$B" "$RUN" eval '(async()=>{const t=document.querySelector("main time"); t.focus(); await new Promise(r=>setTimeout(r,800)); return [...document.querySelectorAll("[role=tooltip]")].map(x=>x.innerText).join()})()'
node "$B" "$RUN" eval 'document.querySelector("main").innerText'
```

`key Tab 1`로 키보드 입력 모드(focus-visible)를 활성화해야 focus 시 tooltip이 열린다.

기대: 업무(홈·세션·에이전트), 워크스페이스(구성원·설정), 내 설정의 sidebar. owner sidebar 링크는 홈·세션·에이전트·구성원·워크스페이스 설정·연동 계정·내 key·언어·테마다. member에는 워크스페이스 설정이 없으며 /usage와 팀 단독 sidebar 링크는 없다. 홈 최근 세션의 에이전트는 이 SID에서 “—”다. 홈 “답이 필요한 요청”·“최근 세션”, 요청이 없으면 “지금 답할 요청이 없습니다”. 세션의 최근 시각은 상대 시각이다. 시각에 hover 또는 키보드 focus하면 정확한 시각 tooltip. 제목 속성만 검사하지 않는다. 요청이 있는 경우는 다음 권한 대본을 만든 뒤 다시 온다. 소스: `apps/web/src/routes/home.tsx`, `components/app-sidebar.tsx`, `apps/web/src/i18n/home.ts`.

## P-API-PENDING — 권한 요청·응답·SSE

전제: owner key, REL. SID를 덮어쓰지 않고 QSID를 쓴다. fake 연결의 release는 `auto`로 돌고 fake가 안전 검사를 모두 허용하므로, 권한 요청은 묻기 규칙에 걸린 명령(`sed -n "w …"`)으로만 온다. `tee`는 묻지 않는다.

```sh
# Actor: owner.
ap_as owner
Q=$(ap_post /v1/sessions "$(jq -nc --arg r "$REL" --arg m 'GATE-SPEC {"id":"verify-permission","steps":[{"tool":"Bash","input":{"command":"echo alpha | sed -n \"w hello.txt\"","description":"write hello.txt"}}],"final":"wrote hello.txt"}' '{agent_release_id:$r,repository_id:"sample-app",message:$m}')")
printf '%s\n' "$Q"
QSID=$(printf '%s\n' "$Q" | head -1 | jq -r .session_id)
printf 'QSID=%s\n' "$QSID"
for i in $(seq 1 90); do
  [ "$(ap_get "/v1/sessions/$QSID" | head -1 | jq -r .status)" = needs_input ] && break
  sleep 2
done
ap_get "/v1/sessions/$QSID/pending-requests"
node "$B" "$RUN" open /
node "$B" "$RUN" shot home-request
REQ=$(ap_get "/v1/sessions/$QSID/pending-requests" | head -1 | jq -r '.items[0].request_id')
printf 'REQ=%s\n' "$REQ"
ap_post "/v1/sessions/$QSID/answers" "$(jq -nc --arg r "$REQ" '{request_id:$r,kind:"permission",action:"allow"}')"
ap_curl key -N --max-time 5 "$API/v1/sessions/$QSID/events" > "$EVIDENCE/pending-events.txt" || test "$?" = 28
```

기대: pending 200 `answerable:true`, items 한 개 `kind:"permission"`, `tool:"Bash"`. 홈 요청 카드와 세션 sidebar 대기 배지. 답 202. turn 1이 completed가 될 때까지 위 poll 방식으로 확인한다. 홈에서 카드가 사라지고 배지가 숨는다. SSE에 question/status/result 이벤트가 있고 curl timeout 28은 스트림 캡처 종료다.

## P-WEB-SESSIONS — 목록·검색·상세·결과물

전제: SID와 QSID. owner 브라우저.

```sh
# Actor: owner.
ap_as owner
node "$B" "$RUN" open /sessions
node "$B" "$RUN" type 'input[type=search]' 'Verify renamed target'
node "$B" "$RUN" eval 'document.querySelector("main").innerText'
node "$B" "$RUN" shot sessions-search
node "$B" "$RUN" type 'input[type=search]' 'no-such-verify-title'
node "$B" "$RUN" eval 'document.querySelector("main").innerText'
node "$B" "$RUN" click '필터 지우기'
node "$B" "$RUN" eval '({search:document.querySelector("input[type=search]")?.value,searchFocused:document.activeElement===document.querySelector("input[type=search]")})'
node "$B" "$RUN" open '/sessions?status=idle'
node "$B" "$RUN" open "/sessions/$SID"
node "$B" "$RUN" press 정보 Enter
node "$B" "$RUN" eval '({search:location.search,tabs:[...document.querySelectorAll("[role=tab]")].map(x=>({text:x.innerText,selected:x.getAttribute("aria-selected")}))})'
node "$B" "$RUN" eval 'document.querySelector("main").innerText'
node "$B" "$RUN" shot session-info
node "$B" "$RUN" press 결과물 Enter
node "$B" "$RUN" eval '({search:location.search,tabs:[...document.querySelectorAll("[role=tab]")].map(x=>({text:x.innerText,selected:x.getAttribute("aria-selected")}))})'
node "$B" "$RUN" eval 'document.querySelector("main").innerText'
node "$B" "$RUN" press 진행 Enter
node "$B" "$RUN" eval '({search:location.search,tabs:[...document.querySelectorAll("[role=tab]")].map(x=>({text:x.innerText,selected:x.getAttribute("aria-selected")}))})'
node "$B" "$RUN" eval 'document.querySelector("main").innerText'
```

기대: “전체”·답변 대기·작업 중·쉬는 중·멈춤·실패 상태 SegmentedControl(정확한 번역은 `packages/react/src/messages/sessions.ts`). 표 열 세션·상태·모델·저장소·최근. 없는 검색은 “조건에 맞는 세션이 없습니다”, 필터 지우기 뒤 검색칸에 focus. 이 SID 행의 모델은 `claude-sonnet-5`, 저장소는 `agent/sample-app · main`, footer는 “1개 표시 · 검색은 지금 불러온 세션 안에서만 찾습니다.”다. 검색은 현재 불러온 페이지 안에서만 적용된다. API q와 아직 연결되지 않았고 상태 개수도 UI에 없다. “새 세션”은 사용할 수 없는 이유를 보이며 웹에서 모델을 골라 세션을 만들 수 없다.

상세 탭 진행·결과물·정보. 모델은 runtime.model, 정보에는 “에이전트 정보 없음”·“시작한 사람·경로 정보 없음”이 보이고 브랜치는 “아직 볼 수 없습니다”다. API에 필드가 생겼다고 UI가 모두 표시한다고 판정하지 않는다. 제어·ID 복사는 28×28 버튼. 결과물을 만들지 않은 SID는 빈 상태이며 결과물 다운로드 검증에는 Write 대본이 필요하다.

```sh
# Actor: owner.
ap_as owner
ap_get "/v1/sessions/$SID/outputs"
```

기대: 200 빈 items.

데모 결과물 조회·다운로드 검증은 별도 demo run의 [P-DEMO-SEED](#p-demo-seed--데모-별도-run)를 따른다.

## P-WEB-USAGE — 사용량·한도 화면

전제: owner 브라우저와 SID.

```sh
# Actor: owner.
ap_as owner
node "$B" "$RUN" open /operations/usage
node "$B" "$RUN" shot usage-installation
node "$B" "$RUN" click '내 사용량'
node "$B" "$RUN" shot usage-owner
node "$B" "$RUN" open /operations/limits
node "$B" "$RUN" shot limits-owner
node "$B" "$RUN" open /
node "$B" "$RUN" click 'Verify Owner'
node "$B" "$RUN" click 로그아웃
node "$B" "$RUN" login member
node "$B" "$RUN" open /operations/usage
node "$B" "$RUN" shot usage-member
node "$B" "$RUN" open /operations/limits
node "$B" "$RUN" shot limits-member
```

기대: 제목 “사용량·한도”, 탭은 개요·사용량·도구 활동·한도(`/operations`, `/operations/usage`, `/operations/tools`, `/operations/limits`). 사용량 탭은 세션·실행 시간·비용(추정)·토큰 KPI와 기간(7일·30일·90일)이다. KPI 아래 줄은 “<범위> · <시작일> – <끝일> (UTC) · 비용·토큰·실행 시간은 세션을 시작한 날에 붙습니다 · <시각>에 읽은 값”이다. 그 기간에 시작한 세션이 하나도 없으면 이 줄 대신 “이 기간에 시작한 세션이 없습니다.”가 보인다(세션을 만든 적 없는 member가 그렇다). owner에게는 집계 범위 “내 사용량”·“설치 전체”가 있고 처음은 “설치 전체”다. member에게는 집계 범위 선택이 없고 범위는 “내 사용량”이다. 한도 탭은 owner에게 “실행 용량” 카드(“사용 중인 슬롯”, “입력 보관”)와 한도 표를 보인다. 표는 설치 행 셋(“동시 실행 슬롯”·“입력 보관”·“성과물 저장”)과 세션 행 넷(“세션 비용”·“세션 토큰”·“대기 메시지”·“턴 시간”)이다. member에게는 용량 카드가 없고 “내 세션에 적용됩니다”가 붙은 표만 있다. 그 표는 구성원 행 셋(“구성원당 동시 실행 슬롯”·“구성원당 월 비용”·“구성원당 성과물 저장”)과 같은 세션 행 넷이다. 구성원 행의 현재 칸은 슬롯·비용이 값 없음(—), 성과물이 “미계측”이고, 한도 칸은 슬롯·비용이 “설정 안 됨”, 성과물이 “한도 없음”이다. 문구의 출처는 `packages/react/src/components/operations/messages.ts`의 `installationLimits`다. API 수치와 같은 범위·기간으로 비교한다. 소스: `apps/web/src/routes/operations.tsx`, `packages/react/src/components/operations/installation-limits.tsx`.

## P-WEB-SETTINGS — 연동·key·언어·워크스페이스

전제: member 브라우저. 기본 stack은 Slack 설정을 하지 않았다.

```sh
# Actor: member.
ap_as member
node "$B" "$RUN" open /settings/linked-accounts
node "$B" "$RUN" eval 'document.querySelector("main").innerText'
node "$B" "$RUN" shot linked
node "$B" "$RUN" open /settings/api-keys
node "$B" "$RUN" eval 'document.querySelector("main").innerText'
node "$B" "$RUN" open /settings/api-keys/new
node "$B" "$RUN" eval 'document.querySelector("main").innerText'
node "$B" "$RUN" open /settings/api-keys/agents
node "$B" "$RUN" eval 'document.querySelector("main").innerText'
node "$B" "$RUN" open /settings/api-keys/agents/new
node "$B" "$RUN" eval 'document.querySelector("main").innerText'
node "$B" "$RUN" eval '({targets:[...document.querySelectorAll("main select option")].map(x=>x.textContent),submit:[...document.querySelectorAll("main button[type=submit]")].map(x=>({text:x.innerText,disabled:x.disabled,ariaDisabled:x.getAttribute("aria-disabled")}))})'
node "$B" "$RUN" open /settings/preferences
node "$B" "$RUN" eval 'document.querySelector("main").innerText'
node "$B" "$RUN" open /settings/workspace
node "$B" "$RUN" eval 'document.querySelector("main").innerText'
node "$B" "$RUN" eval '({switches:document.querySelectorAll("main [role=switch]").length,links:[...document.querySelectorAll("[data-slot=app-sidebar] nav a")].map(x=>x.innerText)})'
```

기대: 연동 목록 Slack “연결 안 됨”, GitHub·Google Workspace “준비 중”. key는 개인/에이전트 LinkTabs와 로드 후 개수(관리하는 에이전트가 없는 member는 탭이 없다). member에게 “조직 관리 key” 탭은 없다. 폼은 이름·권한 카드·만료일(필수 아님), 에이전트 폼은 에이전트 선택. 이 member는 P-API-TEAMS·AGENTS에서 Verify Helper 관리 팀에 속했으므로 그 에이전트의 에이전트 key를 발급할 수 있다. 폼의 에이전트 칸은 “에이전트를 고르세요 / Verify Helper”이며 선택 전 제출은 비활성이다. owner/admin은 모든 에이전트, 에이전트 관리자는 그 에이전트의 key를 발급한다(`api-key-service.ts`의 `rightFor`, `api-keys.tsx`의 `AgentKeyForm`). 역할 member만으로 발급 불가라고 판정하지 않는다. key를 화면에서 발급하면 “새 key”에 값이 한 번 보이므로 shot/eval을 하지 않고 “목록으로”를 누른다. 발급·폐기 API는 P-API-KEYS와 마지막 정리로 확인한다.

언어·테마 화면에서 한국어·日本語·English와 테마를 고른다. member workspace는 switch 없이 읽기 전용. owner로 다시 로그인한다.

```sh
# Actor: owner.
ap_as owner
node "$B" "$RUN" open /
node "$B" "$RUN" click 'Verify Member'
node "$B" "$RUN" click 로그아웃
node "$B" "$RUN" login owner
node "$B" "$RUN" open /settings/workspace
node "$B" "$RUN" eval 'document.querySelector("main").innerText'
node "$B" "$RUN" shot workspace
ap_web POST "/v1/workspaces/$WS/audit-retention" '{"audit_retention_days":29}'
ap_web POST "/v1/workspaces/$WS/audit-retention" '{"audit_retention_days":30}'
ap_web POST "/v1/workspaces/$WS/audit-retention" '{"audit_retention_days":90}'
ap_web POST "/v1/workspaces/$WS/slack-guest" '{"slack_guest_enabled":true}'
node "$B" "$RUN" open /settings/workspace
node "$B" "$RUN" eval 'document.querySelector("main").innerText'
node "$B" "$RUN" eval '[...document.querySelectorAll("[role=switch]")].map(x=>({label:x.getAttribute("aria-label"),checked:x.getAttribute("aria-checked")}))'
ap_web GET /v1/auth/me
ap_as member
ap_web POST "/v1/workspaces/$WS/slack-guest" '{"slack_guest_enabled":false}'
ap_as owner
```

기대: workspace는 이름·ID·모델·감사 보존·Slack 게스트 Card. ID는 SecretField 복사, 모델은 mono Badge. 보존 29일은 400 `BAD_REQUEST` “Request body is invalid”, 30일은 200 `audit_retention_days:30`, 90일 복원도 200이다. 허용 범위 30–3650일. guest owner 200 뒤 me.settings 값 true, member 403 `details.reason_code:"role"`. 화면 switch도 true. 소스: `apps/web/src/routes/workspace-settings.tsx`, `apps/control-host/src/api/routes/musterrolle/workspaces.ts`. 다른 JSON 키로 보내 생긴 400을 보존 기간 경계 검증 성공으로 세지 않는다.

## P-API-SESSION-CONTROL — 후속 메시지·pause·resume·close

전제: SID 완료, QSID가 idle이며 닫히지 않았음, owner key. 각 변경 직전 revision을 읽는다.

```sh
# Actor: owner.
ap_as owner
ap_post "/v1/sessions/$SID/messages" '{"message":"GATE-SPEC {\"id\":\"verify-follow\",\"steps\":[],\"final\":\"second\"}"}'
for i in $(seq 1 90); do
  [ "$(ap_get "/v1/sessions/$SID/turns/2" | head -1 | jq -r .status)" = completed ] && break
  sleep 2
done
ap_post "/v1/sessions/$SID/interrupt" '{"target_turn_id":"2"}'
for i in $(seq 1 90); do
  [ "$(ap_get "/v1/sessions/$QSID" | head -1 | jq -r .status)" = idle ] && break
  sleep 2
done
ap_get "/v1/sessions/$QSID"
REV=$(ap_get "/v1/sessions/$SID" | head -1 | jq -r .revision)
ap_post "/v1/sessions/$SID/pause" "$(jq -nc --argjson r "$REV" '{expected_revision:$r,reason:"verify"}')"
```

기대: message 202 turn_id 2, turn completed. 이미 완료된 turn의 interrupt는 202(no-op receipt), QSID는 idle이 된다(세션의 profile 변경 경로는 없어졌다). pause 202. 아래 poll의 마지막 출력에서 paused를 확인한다.

```sh
# Actor: owner.
ap_as owner
for i in $(seq 1 90); do
  [ "$(ap_get "/v1/sessions/$SID" | head -1 | jq -r .admission_state)" = paused ] && break
  sleep 2
done
ap_get "/v1/sessions/$SID"
```

 이후 최신 revision으로 resume 202, idle/active으로 돌아오면 close한다.

```sh
# Actor: owner.
ap_as owner
REV=$(ap_get "/v1/sessions/$SID" | head -1 | jq -r .revision)
ap_post "/v1/sessions/$SID/resume" "$(jq -nc --argjson r "$REV" '{expected_revision:$r}')"
```

resume 정착을 읽어 확인한 뒤:

```sh
# Actor: owner.
ap_as owner
for i in $(seq 1 90); do
  [ "$(ap_get "/v1/sessions/$SID" | head -1 | jq -r .admission_state)" = active ] && break
  sleep 2
done
ap_get "/v1/sessions/$SID"
```

기대: admission_state active. 이어 turn 3을 느리게 만들고 terminate·복구·resume을 확인한다. turn 2의 checkpoint가 있으므로 abandon 뒤 복원할 수 있다.

```sh
# Actor: owner.
ap_as owner
ap_post "/v1/sessions/$SID/messages" '{"message":"GATE-SPEC {\"id\":\"verify-kill\",\"steps\":[],\"final\":\"never\",\"finalDelayMs\":300000}"}'
for i in $(seq 1 90); do
  CURRENT=$(ap_get "/v1/sessions/$SID" | head -1)
  [ "$(printf '%s\n' "$CURRENT" | jq -r '[.current_turn_id,.status]|join(":")')" = '3:running' ] && break
  sleep 2
done
ap_get "/v1/sessions/$SID/turns/3"
REV=$(ap_get "/v1/sessions/$SID" | head -1 | jq -r .revision)
ap_post "/v1/sessions/$SID/terminate" "$(jq -nc --argjson r "$REV" '{expected_revision:$r,reason:"verify terminate"}')"
for i in $(seq 1 90); do
  [ "$(ap_get "/v1/sessions/$SID" | head -1 | jq -r .admission_state)" = recovery_required ] && break
  sleep 2
done
ap_get "/v1/sessions/$SID/turns/3"
REV=$(ap_get "/v1/sessions/$SID" | head -1 | jq -r .revision)
DECISION=$(ap_post "/v1/sessions/$SID/recovery-decisions" "$(jq -nc --argjson r "$REV" '{expected_revision:$r,decision:"abandon",target_turn_id:"3",reason:"slow fake call had no effect"}')")
printf '%s\n' "$DECISION"
DRCPT=$(printf '%s\n' "$DECISION" | head -1 | jq -r .receipt_id)
printf 'DRCPT=%s\n' "$DRCPT"
for i in $(seq 1 90); do
  [ "$(ap_get "/v1/receipts/$DRCPT" | head -1 | jq -r .status)" = succeeded ] && break
  sleep 2
done
ap_get "/v1/receipts/$DRCPT"
REV=$(ap_get "/v1/sessions/$SID" | head -1 | jq -r .revision)
ap_post "/v1/sessions/$SID/resume" "$(jq -nc --argjson r "$REV" '{expected_revision:$r}')"
for i in $(seq 1 90); do
  [ "$(ap_get "/v1/sessions/$SID" | head -1 | jq -r .admission_state)" = active ] && break
  sleep 2
done
ap_get "/v1/sessions/$SID"
```

기대: message 202 turn_id 3, 실행 중 turn running. terminate 202 `external_effects_reverted:false`. 종료 관측 뒤 turn outcome_unknown, 세션 recovery_required. abandon 202, receipt succeeded와 result.resumable true, turn cancelled. resume 202 뒤 admission_state active. poll 기한이 끝나면 다음 단계로 넘기지 말고 마지막 출력으로 실패를 보고한다. source: `packages/contracts/src/api/control.ts`, `packages/platform/src/sessions/session-service.ts`, `docs/quickstart.md` 3장 ⑨. 이제 close한다:

```sh
# Actor: owner.
ap_as owner
REV=$(ap_get "/v1/sessions/$SID" | head -1 | jq -r .revision)
ap_post "/v1/sessions/$SID/close" "$(jq -nc --argjson r "$REV" '{expected_revision:$r,reason:"verify close"}')"
for i in $(seq 1 45); do
  [ "$(ap_get "/v1/sessions/$SID" | head -1 | jq -r .admission_state)" = closed ] && break
  sleep 2
done
ap_get "/v1/sessions/$SID"
ap_post "/v1/sessions/$SID/messages" '{"message":"closed probe"}'
```

기대: close 202, 최종 detail `admission_state:"closed"`, `status:"stopped"`, message 409 `SESSION_CLOSED`. 중간 closing일 때만 `SESSION_CLOSING`. 복구가 필요한 상태 없이 recovery 성공을 기대하지 않는다. retry_restore는 실제 checkpoint 복원 실패를 만든 별도 fixture가 필요하다.

## P-WEB-LAYOUT — 좁은 화면·다크·오류·로딩

전제: owner 브라우저. 세션 화면을 다시 연다.

```sh
# Actor: owner.
ap_as owner
node "$B" "$RUN" open /sessions
W=390 THEME=dark node "$B" "$RUN" shot sessions-390-dark
W=320 THEME=light node "$B" "$RUN" open /members
node "$B" "$RUN" eval 'document.querySelector("main").innerText'
W=320 THEME=light node "$B" "$RUN" shot members-320
node "$B" "$RUN" blockshot /sessions '*v1/sessions*' sessions-error
node "$B" "$RUN" slowshot /sessions sessions-loading 6000
node "$B" "$RUN" open /sessions
```

기대: 390px에서 sidebar가 “메뉴 열기” 뒤에 숨고 내용이 viewport보다 넓어지지 않는다. 구성원 320px은 표 내부만 스크롤된다. blockshot은 오류 안내·재시도, slowshot은 로딩 상태이며 빈 목록 성공으로 보이지 않는다. 마지막 open 뒤 실제 목록이 돌아온다. source: `apps/web/src/routes/layout.tsx`, `members.tsx`, `scripts/verify/browser.mjs`.

## P-API-CLEANUP — key·팀·로그아웃

전제: 본문 앞 절차를 마쳤다. key 폐기를 마지막에 한다.

```sh
# Actor: owner.
ap_as owner
ap_web DELETE "/v1/agents/$AID/admins/teams/$TID"
ap_web DELETE "/v1/teams/$TID/members/$MID"
ap_web DELETE "/v1/teams/$TID"
ap_web GET /v1/teams
ap_web GET /v1/api-keys
```

기대: 삭제 200, 팀 목록에서 TID가 없다. 다음 블록은 owner 개인 key로 먼저 me 200과 key ID를 확인하고, 그 key 자체를 폐기한 뒤 같은 값으로 401을 확인한다.

```sh
# Actor: owner.
ap_as owner
REVOKED_KEY=$KEY
KEY_ME=$(ap_get /v1/auth/me)
printf '%s\n' "$KEY_ME"
KID=$(printf '%s\n' "$KEY_ME" | head -1 | jq -er '.principal | select(.kind=="api_key") | .id')
printf 'KID=%s\n' "$KID"
ap_web DELETE "/v1/api-keys/$KID"
KEY=$REVOKED_KEY
ap_get /v1/auth/me
unset KEY REVOKED_KEY KEY_ME
ap_web POST /v1/auth/logout '{}'
ap_web GET /v1/auth/me
node "$B" "$RUN" open /
node "$B" "$RUN" click 'Verify Owner'
node "$B" "$RUN" click 로그아웃
node "$B" "$RUN" open /
```

기대: revoke 200 receipt_id, key me 401, logout 204, cookie me 401. 브라우저는 `/login?redirect=%2F`. 종료는 `down.sh "$RUN"`이며 다른 project를 내리지 않는다.

## P-SLACK-SETUP — mock Slack 별도 run

전제: 기본 run과 다른 id. master key를 api와 slack role에 전달한다. 값은 출력하지 않는다.

```sh
# Actor: stack operator; select owner after login below.
export PLATFORM_SECRET_KEY=$(openssl rand -hex 32)
scripts/verify/up.sh infra/compose.mock-slack.yml
```

새 RUN으로 P-SETUP·P-WEB-LOGIN의 owner 생성/로그인, P-API-AGENTS의 agent 생성·release·활성화까지만 실행한다(팀·관리자 부분 제외). WS·AID를 기록한다. config token은 helper로 저장한다.

```sh
# Actor: owner.
ap_as owner
node "$U" "$RUN" slack-config owner "$WS"
ap_web GET "/v1/workspaces/$WS/slack/config-token"
ap_web POST "/v1/agents/$AID/slack/app" '{}'
ap_web GET "/v1/agents/$AID/slack/app"
node "$U" "$RUN" slack-install owner "$AID"
ap_web GET "/v1/agents/$AID/identities"
```

기대: config 200 `configured:true`, app 200 `created:true`, `slack_app.app_id`가 A0FAKE로 시작한다. helper 내부 install start 200 authorize_url·expires_at(출력하지 않음). complete 200 `installation.status:"verified"`, `agent_identity`. mock overlay의 `CONSOLE_ORIGIN`(`http://127.0.0.1:3000`, 로컬 호스트라 http 허용)에서 이벤트 주소를 계산하므로 `GET /v1/agents/{id}/slack/app`의 `event_url`이 `http://127.0.0.1:3000/v1/slack/events/<agent_id>`이고 `warnings:[]`, `events.state:"pending"`이다(`events_url_unset`은 콘솔 주소가 없거나 https가 아닌 비로컬 주소일 때만 온다). config token GET·PUT의 `urls`는 `redirect_url`(`http://127.0.0.1:3000/settings/linked-accounts/slack`)과 `events_url_template`(`…/v1/slack/events/{agent_id}`)이다. identities에는 active `slack_bot` 한 행이 남고 P-SLACK-INBOUND의 로컬 signed POST도 동작한다. `finalized:true`는 이벤트 주소(`CONSOLE_ORIGIN`에서 계산한 값, 이벤트 입구를 콘솔과 따로 둘 때만 owner가 설정 > 연동 > Slack의 "이벤트 입구 주소"에 저장한 값, `PUT /v1/slack-settings`)가 있고 이벤트 구독 URL을 포함한 앱 manifest 갱신이 성공할 때 반환된다(권한이 변경되면 `reinstall_required` warning이 함께 올 수 있다). 소스: `packages/adapters/chat/slack/src/slack-events-finalize.ts`. 실제 Slack 배달에는 Slack이 닿는 HTTPS 콘솔 주소(`CONSOLE_ORIGIN`, 이벤트 입구가 따로면 그 저장한 주소)와 설치 finalize가 필요하다.

`mock-slack`은 앱·토큰·사용자를 메모리에만 둔다(`packages/testkit/src/fake-slack-api.ts`). 그래서 재시작하면 앞서 만든 앱, bot token, config token이 모두 사라진다. DB에는 옛 기록이 남는다. 그 뒤 이벤트는 `users.info: invalid_auth`로 실패한다. 저장된 config token도 mock이 모르는 값이 되지만, 재시작만으로는 DB 상태가 바뀌지 않아 `GET …/slack/config-token`은 아직 `configured:true`, `state:"active"`다. config token을 쓰는 첫 호출이 mock에 거절되면서 상태가 바뀐다. 첫 설치 시작(`POST /v1/agents/$AID/slack/install/start`)은 그 거절을 삼키고 200 `authorize_url`을 준다. 그 뒤 GET은 `configured:false`, `state:"needs_reentry"`이고, 설치 시작은 몇 번을 불러도 409 `CONFIG_TOKEN_INVALID`("No Slack App Configuration Token is set…"), 앱 지우기도 409 `CONFIG_TOKEN_INVALID`다. 되살리는 순서는 다음과 같다.

1. `node "$U" "$RUN" slack-config owner "$WS"`로 config token을 다시 저장한다. 이때부터 설치 시작은 409 `SLACK_APP_GONE`이다.
2. `ap_web DELETE "/v1/workspaces/$WS/slack/apps/<slack_app.id>"`로 옛 앱을 지운다. 경로에 넣는 값은 플랫폼의 `slack_app.id`(UUID, `GET /v1/workspaces/$WS/slack/apps`의 `id`)이고 Slack의 `app_id`(`A0FAKE…`)가 아니다.
3. 위 블록의 `POST /v1/agents/$AID/slack/app`부터 다시 돌린다.

같은 AID에 옛 앱 기록이 남은 채 2를 건너뛰면 POST는 `created:false`를 돌려주고 설치는 `SLACK_APP_GONE`이 된다. 새 에이전트로 이 절을 처음부터 돌려도 된다. 1보다 먼저 앱을 지우려 하면(409 `CONFIG_TOKEN_INVALID`) 그 앱은 지우는 중으로 남아, 설치 시작이 409 `REVISION_CONFLICT`("This agent's Slack app is being deleted…")가 된다. 1 뒤에 2를 하면 풀린다. 이 순서와 응답은 mock Slack run에서 `ap_compose restart mock-slack`으로 확인했다.

## P-SLACK-INBOUND — 서명·inbox·중복·claim/lease

전제: P-SLACK-SETUP. helper는 mock이 생성한 일회용 signing secret을 DB에서 읽기만 하고 컨테이너 안에서 서명한다. 비밀값을 host 명령 인자나 출력으로 옮기지 않는다. inbox를 DB 쓰기로 만들지 않는다.

```sh
# Actor: owner.
ap_as owner
node "$U" "$RUN" slack-event "$AID" challenge
node "$U" "$RUN" slack-event "$AID" bad
node "$U" "$RUN" slack-event "$AID" stale
node "$U" "$RUN" slack-event "$AID" malformed
node "$U" "$RUN" slack-event "$AID" event
node "$U" "$RUN" slack-event "$AID" duplicate
node "$U" "$RUN" slack-event "$AID" bot
ap_compose exec -T postgres psql -U postgres -d sessions -c "select event_id,status,drop_reason,attempts,claim_token is null as claim_clear,lease_expires_at is null as lease_clear from slack_inbound_events where event_id in ('EvVerify1','EvVerifyBot') order by event_id"
ap_compose logs slack | grep -E 'Slack event claimed|Slack inbox pass'
```

기대: challenge 200 `challenge:"verify-challenge"`; bad/stale 401 `UNAUTHORIZED`; 서명은 맞지만 JSON이 틀리면 400 `BAD_REQUEST`. event/duplicate/bot 모두 200 `ok:true`. EvVerify1은 한 행뿐이다. slack loop가 처리하면 status processed, attempts 1, claim_clear·lease_clear true. EvVerifyBot은 dropped, drop_reason bot_message, attempts 0. SQL이 received를 보여도 완료로 보고하지 않는다. 다음 pass 뒤 재조회한다. 로그 “Slack event claimed”와 “Slack inbox pass”의 claimed/processed를 실제 출력으로 확인한다.

claim은 thread head를 DB advisory lock·SKIP LOCKED로 직렬화하고 lease가 살아 있는 thread 뒤 이벤트를 막는다. complete/fail은 claim_token과 DB now()로 fence하며 만료 claim은 재시도, 최대 5회 뒤 failed다. handler의 성공 경로만으로 lease 만료·경합·실패 복구를 검증했다고 보고하지 않는다. 전제는 handler를 지연/실패시키는 제어 가능한 실행 환경이다. 해당 경합 증거는 `packages/db/src/surface/slack-inbound-claims.test.ts`의 실제 PostgreSQL 테스트로 따로 수집한다. slack role의 handler는 더 이상 no-op이 아니다. 채널 binding과 연결된 계정이 맞으면 멘션이 세션을 열고(P-SLACK-MENTION-ONLY), 세션이 기다리는 요청은 카드로 게시되며 그 카드의 버튼은 서명된 interaction으로 처리된다(P-SLACK-APPROVAL-CLICK). 이 절차는 서명·inbox·claim 상태만 본다.

## P-SLACK-REVOKED — 앱 제거 뒤 연결 해제와 재설치

전제: P-SLACK-SETUP로 설치까지 끝난 run(active identity 한 행). `slack-event`의 `uninstall`은 지금 보낸 `app_uninstalled`, `uninstall-late`는 한 시간 전에 보낸 것이다(seq가 같으면 같은 event id, 즉 재전송).

```sh
# Actor: owner.
ap_as owner
Q="select i.status inst, a.status ident, a.revision, a.revoked_at is not null as revoked_at_set from agent_identities a join slack_installations i on i.id=a.installation_id where a.agent_id='$AID' order by a.created_at"
node "$U" "$RUN" slack-event "$AID" uninstall C0VERIFY 1
node "$U" "$RUN" slack-event "$AID" uninstall C0VERIFY 1          # 재전송
ap_compose exec -T postgres psql -U postgres -d sessions -c "$Q"
ap_web GET "/v1/agents/$AID/identities"
node "$B" "$RUN" open "/agents/$AID?tab=slack"
node "$U" "$RUN" slack-install owner "$AID"                       # 재설치
node "$U" "$RUN" slack-event "$AID" uninstall-late C0VERIFY 2    # 재설치 뒤 늦게 온 옛 이벤트
ap_compose exec -T postgres psql -U postgres -d sessions -c "$Q"
# 이벤트 없는 제거: mock이 bot token을 token_revoked로 답하게 한다.
ap_compose exec -T api bun -e "await fetch('http://mock-slack:4020/fake/revoked-tokens',{method:'POST',body:JSON.stringify({app_id:'<slack_app.app_id>'})})"
ap_web GET "/v1/agents/$AID/slack-channels?ids=C0A"
ap_compose exec -T postgres psql -U postgres -d sessions -c "$Q"
```

기대: 첫 이벤트 뒤 install `revoked`, identity `revoked`·revision 2·`revoked_at` 채움, 재전송은 변화 없음. 콘솔 Slack 탭 상단은 "재설치 필요". 재설치하면 새 active 행이 하나 더 생기고 상단이 "연결됨". 늦은 이벤트는 `processed`로 받되 새 행은 active 그대로. 이벤트 없는 제거는 channels가 409 `SLACK_NOT_INSTALLED`이고 같은 호출로 identity가 `revoked`가 된다. `invalid_auth`는 이 경로를 타지 않는다(상태 불변).

Slack 연결 콜백 화면·연결 해제는 [musterrolle.md](musterrolle.md) c의 4와 [web-settings.md](web-settings.md) 4를 이어서 실행한다. 에이전트 신원 수동 연결/회수·Slack 채널 binding·처리 시점 권한 판정은 c·g의 진단 블록이다. 함수 직접 호출 결과와 HTTP inbound 증거를 구분한다.

## P-SLACK-MENTION-ONLY — 채널 사용과 에이전트 멘션 설정

전제: P-SLACK-SETUP, 그리고 owner가 [musterrolle.md](musterrolle.md) c의 4로 Slack 계정(`U0MOCK`)을 연결한 상태. mock의 채널 목록은 비어 있어 이름을 모르는 채널은 화면에 "채널 ID: …"로 보인다. 이름이 보여야 하면 api 컨테이너에서 `http://mock-slack:4020/fake/channels`에 `{app_id, channels:[{name}]}`를 POST하고, 돌아온 id로 binding을 만든다(목록이 고른 채널처럼).

```sh
# Actor: owner.
ap_as owner
ap_web PUT "/v1/agents/$AID/slack-bindings" "{\"channel_id\":\"$SUP\",\"mode\":\"on\",\"home\":true}"
ap_web PUT "/v1/agents/$AID/slack-bindings" "{\"channel_id\":\"$ALR\",\"mode\":\"off\"}"
ap_web PUT "/v1/agents/$AID/slack-bindings" "{\"channel_id\":\"$ALR\",\"mode\":\"mention\"}"   # 400
ap_web GET "/v1/agents/$AID/slack/app/settings"                                            # mention_only:true
node "$U" "$RUN" slack-event "$AID" plain "$SUP" 1
node "$U" "$RUN" slack-event "$AID" mention "$SUP" 2
node "$U" "$RUN" slack-event "$AID" mention "$ALR" 3
ap_web PUT "/v1/agents/$AID/slack/app/settings" '{"mention_only":false}'
node "$U" "$RUN" slack-event "$AID" plain "$SUP" 4
node "$U" "$RUN" slack-event "$AID" plain "$ALR" 5
ap_compose exec -T postgres psql -U postgres -d sessions -c "select surface_ref from session_links order by created_at"
```

기대: binding PUT 200, 옛 값 `mention`은 400(`expected one of "off"|"on"`). 이벤트는 모두 200 `ok:true`이고 `slack_inbound_events`는 processed. session_links는 `<SUP>:1792800002.000001`(멘션)과 `<SUP>:1792800004.000001`(꺼진 뒤 멘션 없는 글) 둘뿐이다. 1(켜짐인데 멘션 없음), 3·5(사용 꺼진 채널)는 세션을 열지 않는다. `slack-event`의 `mention`·`plain`은 `[channel seq]`를 받아 seq마다 새 event id와 thread를 만든다. `plain`은 `channel_type: channel`이라 비공개 채널(G…)에 보내면 채널 종류 불일치로 거절된다. `D…` 채널에 보낸 `plain`은 `U0MOCK`이 bot에게 보낸 DM(`channel_type: im`)이다.

스레드 답글은 `reply <channel> <seq> <parent seq>`로 보낸다(멘션 없는 `message`, `thread_ts`는 parent seq의 글). 위 2(멘션)의 스레드에 `reply "$SUP" 3 2`를 보내면 `mention_only`가 켜져 있어도 그 세션의 turn 2가 된다(대화 중인 스레드는 멘션 없이 잇는다). 세션이 없는 1의 스레드에 `reply "$SUP" 4 1`은 켜짐·꺼짐 모두 무시된다. turn 수는 `select l.thread_id, (select count(*) from turns t where t.session_id=l.session_id) from session_links l`로 읽는다.

## P-SLACK-APPROVAL-CLICK — Slack 스레드 세션의 승인 카드를 눌러 처리

전제: P-SLACK-SETUP과 owner의 Slack 계정(`U0MOCK`) 연결([musterrolle.md](musterrolle.md) c의 4를 owner로), 에이전트 활성화, `C0SUP`에 `home` binding(P-SLACK-MENTION-ONLY의 첫 PUT). worker 슬롯이 기본 3개이고 idle 세션도 슬롯을 쥔다. 세션이 `queued`에 머물면 이미 끝난 세션을 `POST /v1/sessions/{id}/terminate`(`expected_revision`)로 닫는다. mock의 카드 기록에는 앱 표시가 없으므로 한 run에는 Slack 에이전트를 하나만 둔다(`slack-cards`·`slack-click`은 모든 카드를 본다). 이미 update된 카드는 답한 카드로 보고 건너뛴다. 서명은 mock이 자기 앱 secret으로 만든다. helper는 secret도 컨테이너 환경도 읽지 않는다.

```sh
# Actor: owner. 묻기 규칙에 걸리는 같은 호출 두 번: 허용한 뒤에도 두 번째 호출에 카드가 다시 온다.
ap_as owner
SPEC='GATE-SPEC {"id":"s2","steps":[{"tool":"Bash","input":{"command":"sed -n \"w a.txt\" README.md","description":"write a"}},{"tool":"Bash","input":{"command":"sed -n \"w a.txt\" README.md","description":"write a"}}],"final":"done"}'
node "$U" "$RUN" slack-event "$AID" mention C0SUP 11 "" "run $SPEC"
node "$U" "$RUN" slack-cards "$AID"                      # 카드 한 장: permission.allow·permission.deny
node "$U" "$RUN" slack-click "$AID" allow
node "$U" "$RUN" slack-cards "$AID"                      # 첫 카드의 last_update가 "허용됨", 같은 스레드에 두 번째 카드
node "$U" "$RUN" slack-click "$AID" deny
node "$U" "$RUN" slack-cards "$AID"                      # 두 번째 카드의 last_update가 "거부됨"
ap_compose exec -T postgres psql -U postgres -d sessions -c "select answer->>'decision' decision, answer->>'remember' remember, settled_answer_result, payload->'remember_offer' from pending_requests where tool='Bash' order by created_at"
# push 승인: 도구 허용과 따로 push 카드가 온다. push 전 사람 승인을 켠 에이전트만이다(기본 mock run은 아래 주의).
node "$U" "$RUN" key owner personal sessions:read,sessions:write,sessions:approve; ap_as owner
ap_post "/v1/sessions/$SID/push-requests" '{}'            # SID는 commit 대본(P-GITHUB-SANDBOX 4의 SPEC)이 끝난 Slack 세션
node "$U" "$RUN" slack-cards "$AID"                      # push.approve·push.reject 카드
node "$U" "$RUN" slack-click "$AID" push-approve
node "$U" "$RUN" slack-cards "$AID"                      # last_update가 "push 승인됨"
# 거절: 같은 스레드에 commit 대본을 한 번 더(reply) 보내고, 그 턴의 체크포인트가 저장된 뒤 다시 요청한다.
ap_post "/v1/sessions/$SID/push-requests" '{}'
node "$U" "$RUN" slack-click "$AID" push-reject
node "$U" "$RUN" slack-cards "$AID"                      # last_update가 "push 거절됨"
node "$U" "$RUN" slack-click-bad "$AID"                  # 401 UNAUTHORIZED
```

기대: `slack-event`는 200 `ok:true`, 카드는 스레드마다 새로 온다(몇 초 걸린다. 필요하면 `slack-cards`를 다시). `slack-click`은 `{"ok":true,"status":200,"body":{"ok":true}}`. 두 카드의 `last_update`는 각각 `*허용됨* · <@U0MOCK>`, `*거부됨* · <@U0MOCK>`으로 시작한다(뒤에 카드 요약이 붙는다). `pending_requests`에는 두 행이 생긴다. 하나는 `allow`이고 다른 하나는 `deny`이며, 둘 다 `remember`는 비어 있고 `settled_answer_result`는 `applied`, `remember_offer`는 비어 있다. 세션은 idle이 된다. push 카드를 누르면 카드가 `push 승인됨`으로 바뀌고 push 요청은 `approved`를 지나 처리된다. 기본 run에서는 fake-git이 받아 `pushed`가 되고 `agent/<SID>` 브랜치가 생긴다. push 자격이 없는 저장소면 `failed`(`no_push_credential`)로 끝난다. 거절 카드는 `push 거절됨`이 되고 요청은 `rejected`다. 틀린 서명은 401 `UNAUTHORIZED`.

주의: "이 세션 동안 허용" 버튼(`permission.allow_session`)은 엔진이 그 호출을 덮는 규칙을 제안할 때(`remember_offer`)만 붙고, 그 규칙 문장이 너무 길면 빠진다. fake 연결의 release는 `auto`로 돌아서 묻기 규칙에 걸린 명령만 카드가 된다. 기본 mock run의 묻기 규칙 카드에는 제안이 없어 이 버튼이 붙지 않는다. 코드는 버튼이 없음을 보장하지 않는다: `offerableRules`는 호출이 묻기 규칙에 걸렸는지 보지 않으므로 엔진이 제안을 주면 붙는다. 버튼이 나올 수 있는 곳은 `default` 모드에서 규칙 밖 호출을 물을 때다. 그래서 기본 mock run에서 `slack-click allow-session`은 `no open card offers permission.allow_session`으로 끝난다. 세션 허용은 단계마다 시험이 지킨다. 제안 거르기는 `packages/adapters/runtimes/claude/src/runtime.test.ts`의 "canUseTool hands the host only the allow rules it may offer…"가 맡는다. 버튼은 `packages/adapters/chat/slack/src/slack-prompts.test.ts`의 "an offered rule adds a button…"과 "an allow kept for the session says so…"가 맡는다. 저장과 전달은 `packages/db/src/pending-requests.integration.test.ts`의 "a request that offered rules takes the answer…"가, worker가 엔진에 넘기는 일은 `apps/worker/src/pending-requests.test.ts`의 "hands the run the registered rules with an allow that asked to remember"가 맡는다. 클릭 처리 중 Slack 호출이 실패하면(예: `users.info` 429) 클릭은 200을 받지만 답은 반영되지 않는다. 그때 누른 사람에게 "지금은 요청을 처리하지 못했어요. 잠시 뒤 다시 시도해 주세요" ephemeral이 가고 카드는 그대로다. release에 `github` 설정(`push_approval`)을 넣으려면 GitHub App 등록이 필요해(`app_required`) 기본 mock run은 설정 없는 release로 본다. 설정 없는 release와 GitHub 설정을 저장하지 않은 에이전트는 승인 없이 push하므로(요청이 바로 `approved`, `approval_basis: policy`) 이 run에서는 push 카드가 오지 않는다. 승인을 켜려면 GitHub 설정을 저장해야 하는데, 저장한 에이전트는 App 저장소만 쓸 수 있어 이 run의 `sample-app`으로 세션을 시작하지 못한다(`403 repository_not_allowed`). push 카드는 GitHub sandbox run([github-sandbox.md](github-sandbox.md))에서 **push 전 사람 승인**을 켠 에이전트로 본다.

## P-A0 — a0 완료 조건 실제 출력

a0(대화 단위 기록·비공개 채널·삭제) 완료 조건을 mock Slack run에서 다시 내는 절차다. P-SLACK-SETUP으로 설치를 끝낸 별도 run에서 위에서 아래로 실행한다(ids.sh의 `$AID`·`$APP`). 사람은 owner(`U0MOCK`), member `mem`(`U0MEM1`), 채널 밖 member `out`(`U0OUT`), 연결을 끊을 member `unl`(`U0UNL`) 넷이다. 모두 P-API-MEMBERS로 초대·수락한 뒤 아래 `a0_link`로 각자의 Slack 사람을 잇는다. 이벤트는 api 컨테이너 안에서 보낸다(`a0_event`). seq가 6자리를 넘으므로 `web-user.mjs`를 거치지 않는다. 글의 ts는 `1792800000+seq`이다. 비공개 채널은 승인한 시각보다 앞선 ts의 글을 받지 않으므로, seq는 지금 시각보다 20분 뒤를 기준(`S`)으로 잡고 그 위의 오프셋으로 쓴다. 이벤트마다 `{"ok":true}`와 200이 나와야 한다. 빈 출력이면 같은 줄을 다시 보낸다.

```sh
# Actor: stack operator. 이후 블록은 새 셸이면 이 함수들을 다시 정의하고 시작한다.
a0_event() { ap_compose exec -T -w /app api bun -e "$(cat scripts/verify/slack-event.ts)" "$@"; }
a0_mock() { ap_compose exec -T api bun -e 'const [path, body] = process.argv.slice(1); const r = await fetch("http://mock-slack:4020" + path, body ? { method: "POST", body } : {}); console.log(await r.text())' "$@"; }
a0_sql() { ap_compose exec -T postgres psql -U postgres -d sessions -c "$1"; }
a0_val() { ap_compose exec -T postgres psql -U postgres -d sessions -tA -c "$1"; }
a0_settle() { # 받은 이벤트를 worker가 모두 처리할 때까지(최대 60초)
  for i in $(seq 1 60); do
    [ "$(a0_val "select count(*) from slack_inbound_events where status='received'")" = 0 ] && return 0
    sleep 1
  done
  echo "inbox not settled"; return 1
}
a0_link() { # <who> <slack user>: mock IdP의 mock_user로 다른 Slack 사람을 잇는다
  ap_as "$1"
  START=$(ap_web POST /v1/linked-accounts/slack/start | head -1)
  AP_COOKIE_EXTRA=$(sed -n 's/^[Ss]et-[Cc]ookie: \(werft_slack_link=[^;]*\).*/\1/p' "$VERIFY_RUN/headers" | tr -d '\r')
  BODY=$(printf '%s' "$START" | jq -r --arg u "$2" '.authorize_url + "&mock_user=" + $u' | ap_compose exec -T api bun -e 'const r = await fetch((await Bun.stdin.text()).trim(), { redirect: "manual" }); const q = new URL(r.headers.get("location")).searchParams; console.log(JSON.stringify({code: q.get("code"), state: q.get("state")}));')
  ap_web POST /v1/linked-accounts/slack/callback "$BODY" | tail -1
  unset START BODY AP_COOKIE_EXTRA
}
a0_session() { # <channel> <seq>: 그 글이 연 세션 id
  a0_val "select session_id from session_links where surface_ref='$1:$((1792800000 + $2)).000001'"
}
a0_matrix() { # <label> <session>: 사람마다 상세 상태 코드와 목록 포함 여부
  for w in owner mem out unl; do
    ap_as "$w" >/dev/null
    printf '%s %s detail=%s list_has=%s\n' "$1" "$w" "$(ap_web GET "/v1/sessions/$2" | tail -1)" \
      "$(ap_web GET '/v1/sessions?limit=50' | head -1 | jq --arg s "$2" '[.items[]?|select(.id==$s)]|length')"
  done
}
S=$(( $(date +%s) - 1792800000 + 1200 ))
printf 'S=%s\n' "$S"   # ids.sh에 적는다
a0_link owner U0MOCK
a0_link mem U0MEM1
a0_link out U0OUT
a0_link unl U0UNL
a0_mock /fake/channels "$(jq -nc --arg app "$APP" '{app_id:$app, channels:[
  {name:"a0-private", is_private:true, bot_member:true, user_ids:["U0MOCK","U0MEM1","U0UNL"]},
  {name:"a0-public", bot_member:true, user_ids:["U0MOCK","U0MEM1","U0OUT","U0UNL"]},
  {name:"a0-old", bot_member:true, user_ids:["U0MOCK","U0MEM1","U0UNL"]}]}')"
```

기대: `a0_link` callback 201 넷. 채널 응답의 id를 `PRIV`(G…)·`PUB`·`OLD`(C…)로 ids.sh에 적는다. 공개 두 채널은 P-SLACK-MENTION-ONLY처럼 `PUT` binding `mode:"on"`으로 켠다. `OLD`는 P-A0-PRIVATE-MOVE에서 비공개로 바꾸므로 다른 절차는 `PUB`을 쓴다.

## P-A0-PRIVATE — 비공개 채널 세션의 열람 범위(조건 2)

```sh
# Actor: stack operator, then owner.
a0_event "$AID" join "$PRIV" $((S + 1))
a0_settle
ap_as owner
BIND=$(ap_web GET "/v1/agents/$AID/slack-bindings" | head -1 | jq -c --arg c "$PRIV" '.items[]|select(.external_surface_id==$c)|{id,revision,status}')
echo "$BIND"
ap_web POST "/v1/agents/$AID/slack-bindings/$(printf '%s' "$BIND" | jq -r .id)/approve" "$(printf '%s' "$BIND" | jq -c '{revision}')" | tail -1
a0_event "$AID" mention "$PRIV" $((S + 100))
a0_settle
PS=$(a0_session "$PRIV" $((S + 100)))
a0_sql "select scope from session_shares where session_id='$PS'"
a0_matrix A1 "$PS"
```

기대: binding `status:"pending_approval"` → approve 200 `ready`. `PS`(ids.sh에 적는다)의 scope는 `private_channel`. A1: owner·mem·unl 200·`list_has=1`, out 404·`list_has=0`.

에이전트 key와 owner의 개인 key(`sessions:read,sessions:write,sessions:approve`)는 사람의 채널 자격이 없으므로 `PS`를 읽지 못한다. P-API-KEYS로 두 key를 만들고, 각 key를 `ap_get`·`ap_post`가 쓰도록 실린 셸에서 아래를 돌린다. 대조로 같은 개인 key로 만든 웹 세션(`ap_post /v1/sessions …`의 `session_id`)은 200이다. 대조 세션도 워커 슬롯을 쓰므로 확인한 뒤 닫는다(P-A0-DELETE의 close).

```sh
# Actor: owner's personal key, then the agent key.
for p in "" /turns /pending-requests /outputs /usage; do printf '%s %s\n' "$p" "$(ap_get "/v1/sessions/$PS$p" | tail -1)"; done
ap_post "/v1/sessions/$PS/messages" '{"message":"key write"}' | tail -1
ap_post "/v1/sessions/$PS/answers" '{"request_id":"00000000-0000-4000-8000-000000000000","kind":"permission","action":"allow"}' | tail -1
ap_post "/v1/sessions/$PS/push-requests" '{}' | tail -1
ap_curl key -o /dev/null -w '%{http_code}\n' --max-time 3 "$API/v1/sessions/$PS/events"
ap_get '/v1/sessions?limit=50' | head -1 | jq --arg s "$PS" '[.items[]|select(.id==$s)]|length'
```

기대: 모두 404. 개인 key의 목록에는 없다(0). 에이전트 key의 목록은 403 `agent_ceiling`이다(사람의 자격 없이 세션 목록을 읽지 못한다).

```sh
# A2: Slack 연결을 끊은 사람. Actor: unl.
ap_as unl
LAID=$(ap_web GET /v1/linked-accounts | head -1 | jq -r '.items[0].id')
ap_web DELETE "/v1/linked-accounts/$LAID" | tail -1
a0_matrix A2 "$PS"
# A3: 요청자(U0MOCK)가 채널을 나간다. member cache는 person-leave 이벤트로 무효가 된다.
a0_mock /fake/channel-members "$(jq -nc --arg c "$PRIV" '{channel_id:$c, remove:["U0MOCK"]}')"
a0_event "$AID" person-leave "$PRIV" $((S + 200)) "" U0MOCK
a0_settle
a0_matrix A3 "$PS"
ap_as owner
ap_web POST "/v1/sessions/$PS/messages" '{"message":"after leave"}' | tail -1
# A4: Slack이 멤버를 답하지 못하면 닫힌다. A5: 돌아오면 다시 열린다.
a0_mock /fake/channel-members "$(jq -nc --arg c "$PRIV" '{channel_id:$c, add:["U0MOCK"]}')"
a0_event "$AID" person-join "$PRIV" $((S + 300)) "" U0MOCK
a0_settle
ap_compose pause mock-slack
a0_matrix A4 "$PS"
ap_compose unpause mock-slack
a0_matrix A5 "$PS"
a0_sql "select channel_id, status from slack_outbox where session_id='$PS'"
```

기대: A2 unl 404(다른 사람은 그대로). A3 owner 404·목록 0, owner messages 404, mem 200. A4 모두 404(fail closed). A5 owner·mem 200. mem의 answers는 403이다(mem에게 `session.approve`가 없다. 범위 실패가 아니다). outbox는 `$PRIV` 한 행 `sent`, DM(U…/D…) 행 없음. `person-join`·`person-leave`는 `member_joined_channel`·`member_left_channel`에 bot 대신 `text`의 사람(비면 `U0MOCK`)을 넣는다.

## P-A0-PRIVATE-MOVE — 공개였다 비공개가 된 채널의 옛 세션(조건 2, A7)

```sh
# Actor: stack operator. 운영자 명령은 api 컨테이너에서만 돈다.
a0_event "$AID" mention "$OLD" $((S + 400))
a0_settle
OS=$(a0_session "$OLD" $((S + 400)))
a0_mock /fake/conversions "$(jq -nc --arg c "$OLD" '{channel_id:$c, is_private:true}')"
ap_compose exec -T -w /app api bun run apps/control-host/src/api/private-channel-sessions.ts plan --agent "$AID"; echo "exit=$?"
ap_compose exec -T -w /app api bun run apps/control-host/src/api/private-channel-sessions.ts apply --agent "$AID"; echo "exit=$?"
ap_compose exec -T -w /app api bun run apps/control-host/src/api/private-channel-sessions.ts apply --agent "$AID"; echo "exit=$?"
a0_sql "select scope from session_shares where session_id='$OS'"
a0_sql "select surface_kind, status from surface_bindings where external_surface_id='$OLD'"
a0_matrix A7 "$OS"
```

기대: plan `{"outcome":"planned",…"from":"workspace","to":"private_channel","people_losing":0,…}` exit 0. 첫 apply는 `outcome:"moved"`·`sessions_moved:1`로 그 세션을 `moved`에 넣고 exit 0, 두 번째는 `outcome:"unchanged"`·`moved:[]`로 exit 0. 첫 apply의 `run_id`로 `a0_sql "select result from receipts where operation='share_session' and target_ref->>'session_id'='$OS'"`를 보면 `previous_scope:"workspace"`·`scope:"private_channel"`·`reason:"operator_private_channel_migration"`·같은 `run_id`가 한 줄 나온다. scope `private_channel`, binding `private_channel`·`pending_approval`. A7: owner·mem 200, out(채널 밖)·unl(연결 끊음) 404, owner 개인 key(`ap_get`) 404. 옮기기 전에도 mem·out은 404다. share 행이 없는 공개 채널 세션은 만든 사람만 읽는다(plan의 `from:"workspace"`는 채널 종류를 말한다). Slack에서 채널 종류를 읽지 못한 채널은 `unconfirmed_channels`에 들고 exit 3으로 끝난다. 실제 Slack 설치에서 모든 채널이 `reason:"failed"`로 나오면 명령의 Slack 읽기 경로 문제다(mock run에서는 재현되지 않는다).

Slack이 채널을 바꿨다고 알리는 경로는 `convert-private`·`convert-public` 이벤트로 본다. 세션이 열린 공개 채널 `CONV`(binding `on`)를 mock에서 먼저 바꾸고 이벤트를 보낸다. 핸들러는 메시지가 아니라 mock이 지금 답하는 종류를 쓴다.

```sh
# Actor: stack operator.
a0_mock /fake/conversions "$(jq -nc --arg c "$CONV" '{channel_id:$c, is_private:true}')"
a0_event "$AID" convert-private "$CONV" $((S + 500))
a0_settle
a0_mock /fake/conversions "$(jq -nc --arg c "$CONV" '{channel_id:$c, is_private:false}')"
a0_event "$AID" convert-public "$CONV" $((S + 600))
a0_settle
a0_sql "select operation, target_ref->>'session_id' as session, result from receipts where result ? 'event_id' order by created_at"
```

기대: 이벤트마다 binding receipt(`request_surface_binding` `channel_now_private`, 그다음 `set_surface_binding` `channel_now_public`) 한 줄과 세션마다 `share_session` 한 줄. 세션 receipt는 `reason:"slack_channel_converted"`·`by:"slack_event"`·`people_losing:null`이고, 같은 이벤트의 binding receipt와 같은 `event_id`(`EvVerifyconvert…`)를 단다. 범위는 `workspace` → `private_channel` → `workspace`.

## P-A0-DELETE — 근거 메시지 삭제(조건 3)

워커 슬롯이 차 있으면 턴이 줄에 선다. 앞 절차의 세션을 닫고 시작한다.

```sh
# Actor: owner, then stack operator. 턴이 40초 걸리게 해서 도는 중에 지운다.
ap_as owner
for s in "$PS" "$OS"; do
  ap_web POST "/v1/sessions/$s/close" "$(ap_web GET "/v1/sessions/$s" | head -1 | jq -c '{expected_revision:.revision}')" | tail -1
done
SPEC='GATE-SPEC {"id":"a0-del","steps":[],"final":"deleted-answer","finalDelayMs":40000}'
a0_event "$AID" mention "$PUB" $((S + 500)) "" "run $SPEC"
a0_settle
DS=$(a0_session "$PUB" $((S + 500)))
sleep 10
a0_event "$AID" delete "$PUB" $((S + 500)) 0
sleep 45
a0_sql "select channel_id, ts, reason from deleted_sources order by marked_at desc limit 1"
a0_sql "select status, sources_turn from slack_outbox where session_id='$DS'"
a0_mock /fake/messages | jq '[.messages[]|select((.text//"")|contains("deleted-answer"))]|length'
ap_web GET "/v1/sessions/$DS" | head -1 | jq -c '{status,title,title_deleted_at,attention}'
ap_web GET "/v1/sessions/$DS/turns" | head -1 | jq -c '[.items[]|{message,source_deleted_at}]'
ap_web POST "/v1/sessions/$DS/resume" "$(ap_web GET "/v1/sessions/$DS" | head -1 | jq -c '{expected_revision:.revision}')" | tail -2
ap_web POST "/v1/sessions/$DS/messages" '{"message":"after delete"}' | tail -2
```

기대: deleted_sources에 `$PUB`·`$((1792800000 + S + 500)).000001` 한 행. outbox `voided_by_delete`(sources_turn 1), mock에 `deleted-answer` 글 0. 세션 `status:"idle"`, title null·`title_deleted_at` 있음, `attention.code:"SOURCE_DELETED"`. turn message `""`·`source_deleted_at` 있음. resume·messages 409 `SOURCE_DELETED`. `delete`의 셋째 인자는 지울 글의 seq, 넷째는 그 글이 답글일 때의 부모 seq(최상위면 `0`)다. 턴이 줄에 선 채 지우면 세션은 queued·paused로 끝난다. 채널 요약 줄 제거는 a0에 요약을 쓰는 경로가 없어 P-A0-DEFERRED로 본다.

## P-A0-INPUT — 같은 글의 재전송과 같은 ts(조건 5, Slack 쪽)

```sh
# Actor: stack operator.
a0_event "$AID" plain "$PUB" $((S + 700))
a0_event "$AID" mention "$PUB" $((S + 700))
a0_event "$AID" mention "$PUB" $((S + 700))
a0_settle
T=$((1792800000 + S + 700)).000001
a0_sql "select event_type, status, count(*) from slack_inbound_events where received_at > now() - interval '1 minute' group by 1, 2"
a0_sql "select slack_ts, count(*) from conversation_inputs where slack_ts='$T' group by 1"
a0_sql "select count(*) from session_links where surface_ref='$PUB:$T'"
```

기대: 같은 ts의 `message`·`app_mention`과 재전송(같은 event id라 inbox 중복)이 processed 두 행·input 한 행·세션 하나를 남긴다. 웹 입력의 재시도와 echo는 공개 route가 없어 P-A0-DEFERRED로 본다.

## P-A0-TTL — inbox payload와 판정 버퍼(조건 6)

```sh
# Actor: stack operator.
a0_sql "select status, count(*), count(payload) from slack_inbound_events group by 1"
ap_compose exec -T -w /app api bun run apps/control-host/src/api/slack-inbound-payloads.ts; echo "exit=$?"
a0_sql "select count(buffer_expires_at) as buffered, count(*) from conversation_inputs"
a0_sql "select conversation_rollout from agents where id='$AID'"
```

기대: processed·dropped 행의 payload 0. 명령은 `{"outcome":"cleared",…,"cleared":0,…}` exit 0. buffered 0, `conversation_rollout`은 `off`(올린 적이 없을 때). 스위치를 올리고 버퍼의 10분 TTL을 보는 것은 P-A0-ROLLOUT이다.

## P-A0-ROLLOUT — 대화 스위치와 판정 버퍼 TTL

전제: mock Slack run(P-SLACK-SETUP), owner의 Slack 계정 `U0MOCK` 연결(`a0_link owner U0MOCK`), P-A0 helper. 고지 문구가 아직 게시되지 않았으면(`SLACK_NOTICE_VERSIONS`가 빈 목록) 아무도 승인할 수 없다. 그때는 `up.sh` 전에 `packages/contracts/src/domain/slack-notice.ts`의 목록에 검증용 1판(`requiresReapproval: true`, ko·ja 문구)을 커밋하지 않고 넣고, 끝나면 `git checkout --`으로 되돌린다. 그 run의 doctor는 커밋하지 않은 변경을 보고한다.

```sh
# Actor: owner, then stack operator.
a0_mock /fake/channels "$(jq -nc --arg app "$APP" '{app_id:$app, channels:[{name:"rollout-public", bot_member:true, user_ids:["U0MOCK"]}]}')"   # PUB
ap_as owner
ap_web PUT "/v1/agents/$AID/slack-bindings" "{\"channel_id\":\"$PUB\",\"mode\":\"on\",\"home\":true,\"listen\":\"free\"}"
node "$B" "$RUN" open "/agents/$AID?tab=slack"
node "$B" "$RUN" click '승인'
node "$B" "$RUN" click '[aria-label="조용히 듣기 (shadow)"]'     # 1. 웹에서 shadow로
a0_event "$AID" plain "$PUB" $((S + 2)); a0_settle
a0_sql "select count(buffer_expires_at) as buffered from conversation_inputs where agent_id='$AID'"
node "$B" "$RUN" click '[aria-label="조용히 듣기 (shadow)"]'     # 2. 웹에서 off로
a0_event "$AID" plain "$PUB" $((S + 3)); a0_settle
a0_sql "select count(buffer_expires_at) as buffered from conversation_inputs where agent_id='$AID'"
CLI="ap_compose exec -T -w /app api bun run apps/control-host/src/api/slack-notice.ts"
$CLI set-rollout --agent "$AID" --rollout on; echo "exit=$?"     # 3. 운영자 명령
$CLI set-rollout --agent "$AID" --rollout shadow; echo "exit=$?"
a0_event "$AID" plain "$PUB" $((S + 4)); a0_settle
$CLI set-rollout --agent "$AID" --rollout off; echo "exit=$?"
a0_sql "select actor, result from receipts where operation='set_conversation_rollout' order by created_at"
```

기대: 승인 전에는 스위치가 `aria-disabled="true"`이고 "고지를 승인한 뒤 켤 수 있습니다."가 보인다. 1 뒤 buffered 1, slack 로그 `Slack message held for the judgment`(`rollout:"shadow"`). 2 뒤 buffered 0이고, 그 뒤의 글도 0이다. 3의 `on`은 `{"outcome":"refused",…,"reason_code":"rollout_on_unavailable"}` exit 4, `shadow`·`off`는 `{"outcome":"changed",…}` exit 0이고 off의 `buffered_dropped`는 1이다. 같은 값을 다시 주면 `unchanged`이고 receipt는 늘지 않는다. receipt의 `result.by`는 웹이 `web`(actor는 그 사용자), 명령이 `operator_cli`(actor 없음)다. 워크스페이스 owner·admin이 아닌 사람은 에이전트 관리자여도 화면에 스위치가 없고("워크스페이스 owner·admin만 바꿀 수 있습니다."), API는 403 `workspace_admin_required`다. shadow에서 owner가 `POST /v1/agents/$AID/slack/notice/revoke`를 하면 `rollout:"off"`, buffered 0이고 receipt `reason:"notice_revoked"`다. 그 뒤 다시 올리면 409 `notice_not_approved`다.

4. 10분 TTL: shadow로 올리고 글 하나를 담은 뒤 아무것도 하지 않는다. reconciler가 10초마다 `Judgment buffer purged`를 남긴다.

```sh
a0_sql "select id, buffer_expires_at, now(), buffer_expires_at - now() as remaining from conversation_inputs where agent_id='$AID' and buffer_expires_at is not null"
# 만료 60초 전에 한 번, 만료 뒤에 한 번 더 읽는다.
ap_compose logs reconciler | grep '"Judgment buffer purged"' | grep -v '"expired_count":0'
```

기대: `buffer_expires_at`은 받은 시각 + 10분. 만료 60초 전에는 행이 남는다. 만료 뒤 첫 pass(10초 이내)에서 `expired_count:1`이 찍히고 행이 사라진다. 한 run에서 확인한 값: 만료 12:06:33.17, 12:05:35에 남은 시간 00:00:57, 12:06:34.19 pass의 `expired_count:1`, 12:06:35에 행 0.


## P-A0-MODEL-CALLS — 예약과 대화 호출(조건 8)

```sh
# Actor: stack operator. 위 절차를 모두 돈 뒤.
a0_sql "select count(*) from conversation_calls"
a0_sql "select root_kind, state, count(*) from budget_reservations group by 1, 2"
a0_sql "select count(*) from turns where started_at is not null"
a0_sql "select count(*) from provider_exchanges"
```

기대: conversation_calls 0(세션 없는 호출 경로가 없다). 예약은 모두 `state` `settled`이고(`reserved`·`unknown` 없음) `root_kind`는 key·user다. 한 turn이 예약을 여러 개 남길 수 있어 turn 수와 같지 않다. fake model run이라 provider_exchanges 0.

## P-A0-CHANNEL-DELETE — 채널 삭제(조건 10)

```sh
# Actor: stack operator.
a0_event "$AID" channel-delete "$PUB" $((S + 800))
a0_settle
a0_sql "select status from surface_bindings where external_surface_id='$PUB'"
a0_sql "select channel_state from conversations where channel_id='$PUB'"
a0_sql "select (select count(*) from channel_summaries) as summaries, (select count(*) from channel_summary_lines) as lines"
```

기대: binding `gone`, `channel_state` `deleted`, 요약 0·줄 0(a0에서는 쓴 적이 없다). 요약이 있던 채널의 삭제는 P-A0-DEFERRED로 본다.

## P-A0-DEFERRED — 실행 경로가 없는 a0 경로

route·운영자 명령·런타임 호출자가 없는 경로는 실제 postgres에서 돈 통합 시험 출력으로 실제 출력을 대신한다. mock DB 시험은 해당하지 않는다. 에이전트 lead 아래에서는 로컬 통합 시험이 막혀 있으므로 main CI의 integration job 로그를 쓴다. 그 run의 `headSha`가 확인할 커밋이고, integration job이 `success`로 실제로 돌았는지(건너뛴 job이 아닌지) 본다.

```sh
# Actor: anyone with gh. 호출자가 없다는 증거.
bun test tests/a0-deferred-paths.test.ts
gh run list --workflow ci.yml --branch main --commit <sha> --json databaseId,headSha,conclusion
gh run view <run> --json jobs --jq '.jobs[]|select(.name|test("integration"))|{name,databaseId,conclusion}'
gh run view --job <job> --log > "$EVIDENCE/ci-<job>.log"
grep -E '\((pass|fail|skip)\)' "$EVIDENCE/ci-<job>.log" | grep -F '<test name>'
```

기대: `tests/a0-deferred-paths.test.ts` 2 pass(호출자 `[]`). 아래 파일마다 fail 0·skip 0이다.

| 경로 | 시험 파일(job) | 대표 줄 | 실제 출력을 처음 낼 epic |
|---|---|---|---|
| context 조립(`assembleContext`) | context-assembler(db) | 9-2 1–9행, "a fragment with a deleted source is left out" | a1 |
| 세션 없는 대화 호출(`createConversationCalls`) | conversation-calls(db), budget-accounts(db) | "two issues at once on an account that holds one: one token, one refusal, no stray row" | a1(a1/J5의 M1 판단기가 낸다. 실행기와 배선은 a1/J2에서 들어왔고, `tests/a0-deferred-paths.test.ts`의 목록에서 빠졌다) |
| 웹 입력(`createWebInputService`) | conversation-inputs(db), slack/outbox(surface) | "a retry with the same key and text gets the same input id and number back", "the post's record and its echo arriving at once leave one input and one alias" | 웹 입력 route를 여는 epic(실제 Slack에서 mirror 왕복) |
| 요약 줄 삭제 | channel-summaries(db) | "deleting one of three sources takes its line out of every version…", "a deletion deletes the channel's summary with every version…" | 요약을 쓰는 epic |

`tests/a0-deferred-paths.test.ts`는 선언한 파일 밖의 제품 코드·`scripts/`에서 그 이름(식별자나 문자열)이 나오면 실패한다. 실패하면 그 경로에 호출자가 생긴 것이다. 그 epic에서 위 행의 실제 출력을 verify stack으로 내고 시험의 목록에서 뺀다.

실제 Slack(개발 워크스페이스)에서만 보이는 것은 mock으로 대신하지 않는다. `conversations.members`의 실제 응답, metadata가 붙은 mirror 왕복, tombstone 원본 필드는 bot token을 여는 단계가 필요하므로 오너가 직접 돌린다.

## P-CONVERSATION-RUNTIME — 대화 런타임의 턴 하나

전제: mock Slack run에 런타임 overlay를 더해 띄운다. `up.sh infra/compose.mock-slack.yml infra/compose.conversation-runtime.yml`(P-SLACK-SETUP처럼 버리는 `PLATFORM_SECRET_KEY`를 같은 호출에서 준다). doctor 목록에 `conversation-runtime running healthy`가 있어야 한다. P-SLACK-SETUP까지 끝낸 뒤, owner의 Slack 사람(`U0MOCK`)을 잇고(P-A0의 `a0_link owner U0MOCK`), 채널 하나를 만들어 binding `on`으로 켜고, 멘션 하나를 보낸다. 그 멘션이 대화와 주제 행을 만든다. 운영자 명령은 그 둘의 id를 받는다. DB는 읽기만 한다. 런타임 컨테이너의 환경을 읽는 probe는 쓰지 않는다(agent-guard가 막는다).

```sh
# Actor: stack operator. a0_mock·a0_val·a0_sql은 P-A0의 것.
PUB=$(a0_mock /fake/channels "$(jq -nc --arg app "$APP" '{app_id:$app, channels:[{name:"t2-runtime", bot_member:true, user_ids:["U0MOCK"]}]}')" | jq -r '.channels[0].id')
ap_as owner
ap_web PUT "/v1/agents/$AID/slack-bindings" "{\"channel_id\":\"$PUB\",\"mode\":\"on\",\"home\":true}"
node "$U" "$RUN" slack-event "$AID" mention "$PUB" 2
a0_val "select c.id, t.id from conversations c join conversation_topics t on t.conversation_id=c.id where c.agent_id='$AID'"   # CID|TOPIC을 ids.sh에 적는다
ap_compose exec -T api bun run apps/control-host/src/api/conversation-turn.ts --workspace "$WS" --agent "$AID" --conversation "$CID" --topic "$TOPIC" --text 'CALL-SPEC {"id":"t2-verify","reply":"conversation runtime verify"}'; echo "exit=$?"
ap_compose logs --no-log-prefix conversation-runtime | grep conversation_turn
ap_compose logs --no-log-prefix api | grep "Operator conversation turn"
a0_sql "select root_kind, requester_user_id, call_class, call_key, attempt, state, tokens, conversation_turn_id from conversation_calls"
a0_sql "select origin, state, requester_kind from conversation_turns where origin = 'm2'"
a0_sql "select calls, refusal, expires_at > now() as live from conversation_turn_permits"
ap_compose exec -T api bun -e 'const r = await fetch("http://fake-messages:4011/requests?spec=t2-verify"); console.log(await r.text())'
ap_compose logs --no-log-prefix egress-proxy | grep conversation_call_id
docker inspect "$(ap_compose ps -q conversation-runtime)" --format 'readonly={{.HostConfig.ReadonlyRootfs}} mounts={{len .Mounts}} networks={{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}'
ap_compose exec -T conversation-runtime sh -c 'ls -A /conversation | wc -l'
```

기대: 명령은 `{"outcome":"ended",…,"turn":{"outcome":"completed","text":"conversation runtime verify"}}`와 exit 0. 런타임 로그는 `conversation_turn.started`·`ended`(`outcome:"completed"`)·`reported`(`reported:"recorded"`) 세 줄이고 id만 있다(입력·답·토큰 없음). API 로그 한 줄에 `operator_user`·`operator_host`와 `turn_outcome:"completed"`. 원장은 턴의 provider 호출마다 한 줄이고(fake 모델 턴은 한 줄), 줄마다 proxy가 그 요청을 물을 때 예약되어 따로 정산된다: `root_kind` `key`, `requester_user_id` 비어 있음, `call_class` `m2`, `call_key` `operator-<turn id>:m2`, `attempt`는 턴 안 호출 순번(1부터), `state` `settled`, `conversation_turn_id`는 명령이 출력한 `turn_id`. 턴 줄은 `m2`·`no_decision`·`operator`, 허가 줄은 `calls`가 원장 줄 수와 같고 `refusal` 비어 있음. 운영자 턴은 `call_key`의 `operator-` 접두어로 다른 호출과 갈린다. fake 모델 기록은 `spec_id:"t2-verify"`, `tools:[]` 한 건. proxy 로그는 `purpose:"provider"`와 그 호출 id, status 200. inspect는 `readonly=true mounts=0`이고 network는 `…_conversation-runtime` 하나다. 주제 디렉터리는 1개다. 주제 세션이 10분 동안 살아 있기 때문이다.

같은 주제로 10분 안에 턴을 더 보내면 같은 엔진에서 이어진다. 런타임 안 `/proc/*/status`의 `claude` pid가 턴 사이에 그대로이고, proxy 로그에는 턴마다 자기 호출 id로 status 200이 한 줄씩 남는다. 세션이 본 멘션을 지우고(`slack-event "$AID" delete "$PUB" 2 0`) 턴을 보내면 새 pid로 시작한다. `ap_compose restart conversation-runtime` 뒤에는 주제 디렉터리 0개, `claude` 프로세스 없음이고 다음 턴은 `completed`다. fake 모델 기록(`/requests`)에는 메시지 본문이 없어서 새 세션의 첫 요청 내용은 여기서 보지 못한다. 그것은 `tests/conversation-runtime-flow.test.ts`가 본다.

런타임을 끄면 거절된다. `ap_compose stop conversation-runtime` 뒤 45초(런타임이 묻는 간격의 두 배)를 기다려 같은 명령을 돌리면 `{"outcome":"no_runtime"}`와 exit 3이고 원장 줄 수는 그대로다. overlay 없이 띄운 run에서는 exit 4("The conversation runtime is off for this API")다. 런타임 안에서 다른 서비스로 직접 가는 길이 없는 것은 `ap_compose exec -T conversation-runtime bun -e`로 `node:net` 연결을 시도해 본다: `egress-proxy:3128`·`3129`만 열리고 `api`·`postgres`·`fake-messages`는 이름이 풀리지 않는다. 소스: `apps/control-host/src/api/conversation-runtime.ts`, `conversation-turn.ts`, `apps/worker/src/conversation/`.

## P-GITHUB-SANDBOX — 실제 GitHub 별도 run

전제: 새 run. 기본 run·Slack run과 같이 띄우지 않는다. `up.sh scripts/verify/github-sandbox/overlay.yml`과 버리는 master key로 띄우고, [github-sandbox.md](github-sandbox.md)의 1–7을 순서대로 실행한다(App 등록 → 상한 → 에이전트 릴리스 → 세션 clone·commit → push·PR → dispatch·rerun 거절과 receipt → 자기 PR 닫기·`down.sh`). 실제 GitHub에 브랜치와 PR이 생기므로 7의 정리까지가 한 절차다.

## P-DEMO-SEED — 데모 별도 run

전제: 새 run. 기본 bootstrap 절차를 같이 실행하지 않는다.

```sh
# Actor: stack operator; select demo-owner after login below.
VERIFY_DEMO_ACCOUNTS=1 scripts/verify/up.sh
```

출력 id로 P-SETUP 후:

```sh
# Actor: demo-owner after login; switch to demo-member below.
node "$U" "$RUN" demo-login owner
ap_as demo-owner
ap_web GET /v1/auth/me
ap_web GET /v1/agents
ap_web GET /v1/sessions
ap_web GET /v1/sessions | head -1 | jq -r '.items[] | [.status, (.title//"null")] | @tsv'
RS=$(ap_web GET /v1/sessions | head -1 | jq -r '.items[] | select(.title=="결제 모듈 릴리스 노트 초안") | .id')
printf 'RS=%s\n' "$RS"
ap_web GET "/v1/sessions/$RS/outputs"
ap_web GET "/v1/sessions/$RS/outputs/out%2Frelease-notes.md"
node "$U" "$RUN" demo-login member
ap_as demo-member
ap_web GET /v1/auth/me
ap_web GET /v1/sessions
ap_web GET /v1/sessions | head -1 | jq -r '.items[] | [.status, (.title//"null")] | @tsv'
node "$B" "$RUN" start
node "$B" "$RUN" login demo-owner
node "$B" "$RUN" open /
node "$B" "$RUN" eval 'document.querySelector("main").innerText'
node "$B" "$RUN" shot demo-home
node "$B" "$RUN" open /agents
node "$B" "$RUN" eval 'document.querySelector("main").innerText'
node "$B" "$RUN" open /sessions
node "$B" "$RUN" eval 'document.querySelector("main").innerText'
```

기대: 두 login 200. 이메일 demo-owner@example.test·demo-member@example.test, 역할 owner·member. 에이전트 release-notes(릴리스 노트 작성)·code-review(코드 리뷰)·support-triage(문의 분류). 새 seed의 목록은 아래와 같다(정렬 순서는 고정하지 않는다). jq 출력의 `null`은 제목 없는 세션이다.

| 상태 | 제목 | demo-owner | demo-member |
|---|---|---|---|
| idle | null | 보임 | 보임 |
| idle | README 오타 수정 | 보임 | 보임 |
| needs_input | 온보딩 문서 번역 범위 확인 | 보임 | 보임 |
| stopped | 지난주 문의 분류 | 보임 | 보임 |
| needs_input | 의존성 업데이트 영향 확인 | 보임 | 안 보임 |
| running | API 응답 시간 회귀 원인 찾기 | 보임 | 안 보임 |
| idle | 결제 모듈 릴리스 노트 초안 | 보임 | 보임 |

제목 없는 행은 `demo-data.ts`의 `DEMO_SESSIONS` 마지막 항목으로 의도적으로 seed된다. Demo Member가 공백 메시지로 만든 web 세션이며 저장소 없이 데모 에이전트 release로 돈다. `demo-accounts.ts`의 계정 생성용 인증 세션과 구분한다. 두 코드 리뷰 세션은 Demo Owner의 private 세션이므로 member 목록에서 빠진다. 실행·대기 상태는 이후 진행이나 사용자 조작으로 바뀔 수 있어 상태별 숫자는 고정하지 않는다.

결과물 조회는 위의 `ap_as demo-owner` 상태에서 수행한다. 목록 200 객체의 `session_id`는 RS, `checkpoint_revision:0`, `items`는 `path:"out/release-notes.md"`·`bytes:146`·`sha256`(해시 문자열, 값은 고정하지 않음)·`omitted:null`인 항목 한 개다(`packages/contracts/src/api/output.ts`). 다운로드 200이며 본문에 `# 결제 모듈 릴리스 노트`, “카드 결제 실패 시 재시도 안내를 보여 준다.”, “영수증 메일에 주문 번호를 넣는다.”가 나온다. 브라우저 로그인은 `/`로 이동한다. `/`의 innerText에는 “답이 필요한 요청”과 대기 요청이, `/sessions`에는 상태 필터와 owner에게 보이는 위 세션 제목들이 나온다. source: `scripts/local.sh`, `apps/control-host/src/api/demo-accounts.ts`, `demo-data.ts`. seed 재실행은 기존 행을 덮어쓰지 않는다. `LOCAL_DEMO_DATA=0`은 이 데이터 검증의 전제를 충족하지 않는다.

## P-LIST-SCALE — 큰 목록 시드와 응답 시간

전제: 별도 run. owner bootstrap, member 초대·수락, `P-API-AGENTS`의 에이전트 생성·release·활성화, 팀 하나(`POST /v1/teams`), owner 웹 key(`web-user.mjs … key owner personal sessions:read,sessions:write`)와 그 key로 만든 세션 하나까지 API로 만든다. 시드는 그 행들을 복제하므로 API가 지키는 제약이 그대로 맞는다. DB 쓰기로 상태를 만드는 유일한 절차이며, 화면·API 동작이 아니라 규모만 만든다.

```sh
# Actor: owner. 그 run의 postgres에서만 돈다. 두 번째 실행은 아무것도 더하지 않는다.
ap_compose exec -T postgres psql -U postgres -d sessions -v ON_ERROR_STOP=1 \
  -v sessions=50000 -v agents=2000 -v members=2000 -v teams=300 \
  -v team_members=500 -v keys=1000 < scripts/verify/seed-scale.sql
. scripts/verify/bench-lists.sh
ap_as owner
ap_bench 15 '/v1/sessions?limit=50'
ap_bench 15 '/v1/sessions?limit=50&q=zzznomatch'
ap_bench 15 /v1/sessions/counts
ap_bench 15 '/v1/agents?limit=50&include=summary'
ap_bench_pages '/v1/agents?include=summary'
```

기대: 시드 끝에 행 수 표(세션 50,001 등). `ap_bench`는 경로마다 200이 아닌 응답 수(`failed=`)·마지막 응답의 항목 수·200 응답만의 p50·p95를, `ap_bench_pages`는 limit=100으로 끝까지 읽은 페이지 수·항목 수·합계 시간을 한 줄씩 낸다. 200이 아닌 응답이 하나라도 있으면 둘 다 1로 끝난다(member로 `/v1/agents`는 403이라 `failed=3 of 3`). 시드는 sessions·agents·memberships·member_teams·api_keys만 키우고 events·pending_requests·session_shares는 늘리지 않으므로, 그 표에 기대는 서브쿼리 비용은 운영보다 작게 나온다.

계획을 보려면 이 run의 postgres에서만 `LOAD 'auto_explain'` 뒤 `ALTER SYSTEM SET auto_explain.log_min_duration = 40`·`auto_explain.log_analyze = on`, `pg_reload_conf()`, `ap_compose restart api` 하고 `ap_compose logs postgres`를 읽는다. api를 재시작하면 ephemeral 포트가 바뀐다. `ap_compose`가 재시작 뒤 `$API`와 `state.json`·`VERIFY_API`를 새 포트로 고친다(`ap_urls`로 확인). source: `scripts/verify/seed-scale.sql`, `scripts/verify/bench-lists.sh`.
