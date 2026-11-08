# 세션

호출자는 profile과 저장소를 골라 세션을 만들고 메시지를 보낸다. scheduler가 세션마다 worker 컨테이너를 띄워 진짜 Claude Code를 돌리고, 호출자는 turn 상태·이벤트 스트림·권한 요청으로 진행을 보고 답한다. fake model에서는 프롬프트의 GATE-SPEC 대본대로 답한다.

## Sub-features

- `list` `GET /v1/sessions`: `relation=all|started|shared|administered`, `q`(제목 부분 일치·ID prefix), `status`, pagination. `GET /v1/sessions/counts`는 같은 relation·q의 `counts`(queued·running·needs_input·idle·failed·stopped)와 `total`을 반환한다. channel·created_by는 query가 아니라 응답 필드다.
- `identity` 목록·상세의 `agent`(id·name·release_version_no), `created_by`(user_id·display_name), `channel`, `repository`(id·full_name·branch). legacy 또는 해당 정보 없는 세션은 null이다. repository.branch는 clone 기준이고 push 작업 브랜치는 `agent/<session-id>`다.
- `model` 생성 body의 선택 model은 profile 허용 목록 안에서 고른다. 생략하면 release 카드 모델, release도 없으면 profile 기본값. 목록·상세의 model과 runtime.model로 확인한다. profile 변경은 새 profile 기본 모델을 쓴다. 웹 생성 버튼은 아직 사용할 수 없고 상세·목록은 runtime.model을 표시한다.
- `session-create` `POST /v1/sessions` → 201 `queued`, turn 1.
- `title` 생성 body의 선택 `title`, 없으면 첫 메시지에서 만든 제목이 목록·상세의 `title`에 있다. `PATCH /v1/sessions/{id}` `{title}`(Idempotency-Key 없음, `sessions:write`와 `sessions:read`)로 바꾸면 200 상세가 오고 SSE에 `title`을 실은 `status` 이벤트가 생긴다. curl: `ap_curl key -X PATCH "$API/v1/sessions/$SID" -H 'Content-Type: application/json' -d '{"title":"renamed"}'`.
- `turn-complete` turn이 `completed`가 된다.
- `events` `GET /v1/sessions/{id}/events` SSE.
- `permission` 파일을 바꾸는 도구는 `needs_input`과 pending request를 만들고 `POST …/answers`로 허용·거절한다.
- `follow-up` `POST …/messages`로 turn 2.
- `interrupt`·`pause`·`resume`·`terminate`·`recovery` 세션 제어(`docs/quickstart.md` 3장 ⑥–⑨).
- `close` 일을 마친 세션을 `POST …/close`(`sessions:control`, `{expected_revision, reason?}`)로 닫는다. 아무것도 죽이지 않고 `admission_state`가 `closed`가 되며, 그 뒤 메시지·제어는 `409 SESSION_CLOSED`. terminate·recovery close와의 차이는 `apps/docs/content/docs/reference/api-guide.mdx`.

## How to get to it (user POV)

- HTTP API(`apps/docs/content/docs/reference/api-guide.mdx`). 세션 POST는 모두 `Idempotency-Key`가 필요하다.
- 같은 흐름을 사람이 손으로 도는 문서: `docs/quickstart.md` 3장. 자동판: `tests/e2e/alpha-path.e2e.ts`.

## Driving it with lib.sh

Preconditions:

- `KEY`가 `sessions:read,sessions:write`(권한 응답에는 `sessions:approve`, 제어에는 `sessions:control`, 복구에는 `sessions:recover`)를 가진다. [api-keys.md](./api-keys.md)로 발급한다.

```sh
. .claude/skills/verify-werft/scripts/lib.sh <run id>
KEY=$(ap_key verify --scopes sessions:read,sessions:write,sessions:approve,sessions:control,sessions:recover 2>/dev/null)
body() { jq -nc --arg m "$1" '{profile_id:"claude-coding-local", repository_id:"sample-app", message:$m}'; }
```

- **생성.** `created=$(ap_post /v1/sessions "$(body 'GATE-SPEC {"id":"v1","steps":[],"final":"hello from verify"}')"); SID=$(echo "$created" | head -1 | jq -r .session_id)` → `201`, `status: "queued"`, `turn_id: "1"`.
- **완료.** `for i in $(seq 1 90); do [ "$(ap_get "/v1/sessions/$SID/turns/1" | head -1 | jq -r .status)" = completed ] && break; sleep 2; done; ap_get "/v1/sessions/$SID/turns/1"` → `200`, `status: "completed"`, `result.subtype: "success"`. 첫 turn은 worker 기동·clone 때문에 수 초–수십 초.
- **권한 요청.** 대본 `GATE-SPEC {"id":"q1","steps":[{"tool":"Bash","input":{"command":"echo alpha | tee hello.txt","description":"write hello.txt"}}],"final":"wrote hello.txt"}`로 만들면 세션이 `needs_input`이 되고 `ap_get "/v1/sessions/$SID/pending-requests"`에 `kind: "permission"`이 하나 있다. `REQ=$(ap_get "/v1/sessions/$SID/pending-requests" | head -1 | jq -r '.items[0].request_id')`로 id를 받고 `ap_post "/v1/sessions/$SID/answers" "$(jq -nc --arg r "$REQ" '{request_id:$r, kind:"permission", action:"allow"}')"` 뒤 turn 1이 `completed`.
- **이벤트.** `ap_curl key -N --max-time 5 "$API/v1/sessions/$SID/events" > "$EVIDENCE/events.txt" || true` → `event: result` 블록이 있다. timeout 메시지(28)는 정상.
- **제어.** pause·resume·terminate·recovery는 `docs/quickstart.md` 3장 ⑥–⑨의 명령을 `get`/`post` 대신 `ap_get`/`ap_post`로 바꿔 그대로 쓴다(응답 마지막 줄의 상태 코드를 jq에 넘기지 않도록 `| head -1`).
- **닫기.** 닫힌 세션은 다시 열리지 않고 제어도 `409 SESSION_CLOSED`라, 위 제어(⑨는 terminate 뒤 `abandon`·resume으로 같은 세션을 다시 쓴다)에 쓴 세션과 따로 한다. 위 생성 명령으로 새 세션을 만들고 turn 1이 `completed`가 된 뒤 그 `SID`로 `REV=$(ap_get "/v1/sessions/$SID" | head -1 | jq -r .revision)` → `ap_post "/v1/sessions/$SID/close" "$(jq -nc --argjson r "$REV" '{expected_revision:$r, reason:"verify close"}')"` → `202` `receipt_status: "accepted"`. 바로 읽으면 `admission_state: "closing"`(이때 메시지는 `409 SESSION_CLOSING`)이고, worker가 내려가면 몇 초 안에 `admission_state: "closed"`, `status: "stopped"`가 된다(`status`는 `closed`가 되지 않는다. `for i in $(seq 1 45); do [ "$(ap_get "/v1/sessions/$SID" | head -1 | jq -r .admission_state)" = closed ] && break; sleep 2; done`). 그 뒤 `ap_post "/v1/sessions/$SID/messages" '{"message":"again"}'` → `409 SESSION_CLOSED`.
- **증거.** `| tee "$EVIDENCE/sessions.txt"`.

웹 사용자의 세션. 웹 `/sessions`는 로그인한 사람이 볼 수 있는 세션을 보여 준다. 운영자 key(`ap_key`)로 만든 세션은 웹 사용자의 것이 아니다. 웹 사용자가 만든 세션이 필요하면 그 사람의 개인 key로 만든다. 웹 `/settings/api-keys`의 "개인 key 발급"이 보내는 것과 같은 `POST /v1/api-keys`를 `web-user.mjs key`가 그 사람의 cookie로 보내고, secret은 run 디렉터리의 `keys/<who>`(0600)에만 둔다.

```sh
. .claude/skills/verify-werft/scripts/lib.sh <run id>
U=.claude/skills/verify-werft/scripts/web-user.mjs
node $U <run id> invite owner member member && node $U <run id> accept member   # owner는 web-login.md로 login했다
node $U <run id> key member personal sessions:read,sessions:write   # 201, secret: (saved, N chars)
ap_as member                                  # acting as member (cookie, key of N chars). KEY와 cookie가 member 것
created=$(ap_post /v1/sessions "$(body 'GATE-SPEC {"id":"v1","steps":[],"final":"hello from member"}')"); SID=$(echo "$created" | head -1 | jq -r .session_id)
ap_web GET /v1/sessions | head -1 | jq -c '[.items[] | {id, status}]'   # member cookie로 SID가 보인다
```

- 화면은 member로 로그인한 브라우저에서 `node .claude/skills/verify-werft/scripts/browser.mjs <run id> login member` 뒤 `open /sessions`. 제목 "세션" 아래 "답변 대기" 영역(없으면 "답을 기다리는 세션이 없습니다."), 그 아래 세션·상태·모델·저장소·최근 열의 행에 제목과 모델·저장소가 보인다. 완료된 행 상태는 "쉬는 중"이다. 권한 요청 대본으로 만든 세션이면 "답변 대기"에 "답을 기다리는 세션 1개", "권한 요청: Bash"와 "요청 내용 보기"·"허용"·"거부"가 있고, 표의 작업 상태는 "답변 대기"다. `click 허용` 뒤 turn 1이 `completed`, 영역은 다시 비고 행은 "쉬는 중"이 된다. 사이드바 세션 항목의 답변 대기 배지은 없을 때 `aria-label` "답변 대기 없음"이다.
- 개인 key의 scope는 그 사람의 지금 scope 안에서만 된다(member는 `recover` 없음, 넘으면 `403 SCOPE_NOT_GRANTABLE`).
- 2026-10-21 run `20261021-031642-23898`에서 이 순서로 member 세션을 만들었고(turn 1 `completed`), member cookie의 `GET /v1/sessions`와 브라우저 `/sessions`에 그 세션이 보였다. 같은 workspace의 owner cookie 목록에도 보였다.
- 2026-10-23 run `20261023-155226-40022`(main `6971cdf0`)에서 생성 → 완료 → 닫기 → 권한 요청(answers 202 → completed)을, run `20261023-160737-96495`(main `e7490124`, JeongJaeSoon/agent-platform#568 포함)에서 닫기(202 → `closing`·메시지 `409 SESSION_CLOSING` → 네 번째 조회에 `closed`/`stopped` → 메시지 `409 SESSION_CLOSED`)와 member 개인 key 세션의 `/sessions` "답변 대기" → "허용" → completed를 확인했다.

## Gotchas

- 응답 마지막 줄이 상태 코드다. jq에 넘길 때는 `| head -1`.
- worker 컨테이너는 끝나면 scheduler가 지운다. 로그가 필요하면 `docs/quickstart.md`의 "로그 보기" 루프에서 label을 `werft.installation=$EXECUTION_INSTALLATION_ID`로 바꿔 건다.
- `finalDelayMs`로 느린 turn을 만들 수 있다(interrupt·terminate 시험용).
- 본문에 `agent_release_id`를 넣으면 세션이 그 에이전트 release에 묶인다(`profile_id`가 release와 다르면 `409 RELEASE_PROFILE_MISMATCH`). 에이전트 key는 자기 에이전트 release로만 만들고 읽는다(나머지는 `403` `agent_ceiling`, [musterrolle.md](./musterrolle.md) d). 운영자 key·개인 key는 release 없이 만든다.
- 세션 POST는 인증 방식과 상관없이 `Idempotency-Key`가 없으면 `400`, 같은 key에 다른 본문이면 `409 IDEMPOTENCY_CONFLICT`다.

현재 화면·필터·모델 검증은 [procedures.md](procedures.md)의 P-API-SESSIONS-LIST·P-WEB-SESSIONS를 따른다. 소스: `packages/contracts/src/api/session.ts`, `apps/web/src/routes/sessions.tsx`, `packages/react/src/blocks/session-detail.tsx`.
