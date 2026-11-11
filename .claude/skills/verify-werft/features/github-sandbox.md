# GitHub sandbox (실제 GitHub)

owner가 워크스페이스에 GitHub App을 등록하고 에이전트 상한을 정하면, 에이전트 릴리스의 GitHub 설정(저장소 범위·기능·Actions 허용 목록·push 승인) 안에서 세션이 실제 GitHub 저장소를 clone하고, 사람이 승인한 commit을 `agent/<session-id>`로 push하고, PR을 열고, 허용 목록의 workflow를 dispatch한다. 모든 토큰은 GitHub 게이트 한 곳이 발급하고, 발급과 거절은 receipt로 남는다. 계약은 `docs/contributing/decisions/github-agent.md`(8·9절이 werft-sandbox 실측 항목)다.

## Sub-features

- `app-register` `PUT /v1/workspaces/{id}/github-app`(owner·admin, cookie만, master key 필요) → `github_app`(`app_id`, `slug`, `permissions`, `warnings`)과 `set_github_app` receipt. `GET`은 `check.state: "ok"`와 sandbox 저장소의 `installation_id`.
- `ceiling` `GET`·`PUT /v1/workspaces/{id}/github-settings`: `ceiling`(workflows·actions·checks·issues·review), `revision`(처음 0, 쓸 때마다 +1, 다르면 `409 REVISION_CONFLICT`), `apps.author.permissions`. `set_github_ceiling` receipt.
- `agent-github` 설정(`repositories`, `push_approval`, `features`, `actions_allow`)은 `PUT /v1/agents/{id}/github/settings` `{expected_revision, settings, start_repository_id}`로 저장한다(웹 세션만, API key는 `403 web_session_required`, 어긋난 revision은 `409 REVISION_CONFLICT`). 읽기는 `GET /v1/agents/{id}/github`의 `github`·`settings_revision`·`start_repository_id`·`legacy_defaults`·`options`. 설정 행이 생긴 에이전트에 `github`가 든 릴리스 요청은 `409 github_settings_exist`다. 아래 3단계의 릴리스 본문 `github`는 행이 없는 에이전트의 첫 설정에만 쓴다. `start_repository_id`는 저장·읽기만 되고 세션 시작에는 쓰이지 않는다(`startRepositoryOf`).
- `clone` 세션 생성(`agent_release_id`) → worker가 egress proxy로 clone. 시작 저장소 규칙: 요청의 `repository_id`가 있으면 그 저장소, 없으면 설정 행이 있는 에이전트는 저장소 없이 시작해 `attach_repository`로 붙인 저장소를 받아 오고, 행이 없는 에이전트(아래 3단계의 릴리스 `github`로 설정한 경우)는 릴리스의 저장소로 시작한다. 게이트가 `mint_github_token`(`purpose: clone`)을 남긴다.
- `push` `POST …/push-requests` `{}` → `requested` → `POST …/approve` `{git_commit}` → `approved` → `pushing` → `pushed`. `git_commit`은 요청이 고정한 값이어야 한다.
- `pull-request` `POST …/push-requests/{id}/pull-request` → 201 `created: true`, 다시 부르면 200 `created: false`. GitHub 작성자는 `app/werft-sandbox-agent`.
- `dispatch` `POST /v1/sessions/{id}/github/workflow-dispatches` `{workflow, ref, inputs?}`. 게이트 순서대로 거절한다: 목록 밖 `403 workflow_not_allowed`, `agent/…` ref `403 agent_ref_refused`, App에 권한이 없으면 `409 app_permission_missing`(GitHub가 발급을 거절). 성공은 201 `{receipt_id, run}`.
- `runs` `GET …/github/workflow-runs/{run_id}`(`actions_read`), `POST …/workflow-runs/{run_id}/rerun` `{failed_only?}`(플랫폼이 dispatch한 run만, 아니면 `403 run_ref_unprovable`).
- `achievement` 바로 인정(`always`) 규칙이 있으면 PR 근거가 생긴 뒤 판정기 loop(마지막 trigger 2분 뒤, 30초마다)가 `GET /v1/sessions/{id}/achievements`에 성과를 남긴다: `title` `owner/repo#번호`, `judge: "always"`, `review_state: "auto"`, `payload`(PR 상태 복사), 판정 `trigger: "evidence"` `succeeded`, 비용 0. Luna 규칙은 연결 저장 전이라 `skipped`(`judge_unavailable`)다.
- `receipts` `GET /v1/receipts/{id}`(거절은 `error.details.receipt_id`), `GET /v1/agents/{id}/github/activity`(그 에이전트의 게이트 receipt 최근 20개).

## How to get to it (user POV)

- 웹: 설정 > 워크스페이스 > 연동 > GitHub(`/settings/workspace/integrations/github`, App 등록·상한), 에이전트 상세 GitHub 탭. 이 파일은 같은 API를 cookie와 key로 몬다. 화면은 [web-settings.md](./web-settings.md)·[web-members-agents.md](./web-members-agents.md)의 `browser.mjs`로 본다.
- push·PR·dispatch는 콘솔에 화면이 없다. 세션 API로만 한다.
- GitHub 쪽 확인과 정리는 이 머신에 로그인된 `gh`로 한다.

## Driving it with lib.sh

Preconditions:

- 대상은 sandbox 저장소(`JeongJaeSoon/werft-sandbox`)와 작성용 App `werft-sandbox-agent`다. App ID는 환경 변수 `SANDBOX_APP_ID`로 준다(운영자가 따로 보관한다). App 키는 운영자가 둔 파일이고, 이 절차는 그 경로만 쓴다. 내용을 읽거나 출력하지 않는다. 키 파일과 그 디렉터리는 나열하지도 열지도 않는다. 키가 있는지는 2단계 App 등록 PUT 응답(`200`과 `github_app.app_id`)과 이어지는 `GET`의 `check.state`로 판단한다. 키가 없거나 읽히지 않으면 PUT이 실패하거나 `check.state`가 `ok`가 아니므로, 그 응답 본문의 `error`와 `check`만 보고 운영자에게 알린다. helper가 PUT 전에 멈춰 응답 본문이 없으면 helper의 오류 출력만 보고 알린다.
- master key는 이 run만 쓰는 버리는 값이다(값은 출력하지 않고 길이만). 사람의 Keychain 항목은 읽지 않는다.
- Orca 프로그램이면 `orch hold verify-stack --note "<card>"`를 먼저 잡고 끝나면 놓는다. 스택은 프로그램 전체에서 하나다.
- 열린 sandbox PR은 다른 카드의 증거일 수 있다. 자기가 연 PR만 닫는다.

```sh
# 1. 띄우기 (같은 Bash 호출)
export PLATFORM_SECRET_KEY="$(openssl rand -hex 32)"; echo "master key chars: ${#PLATFORM_SECRET_KEY}"   # 64
orch heavy <program> -- .claude/skills/verify-werft/scripts/up.sh .claude/skills/verify-werft/github-sandbox/overlay.yml
```

`run id`를 기록하고 `doctor.sh <run id>`가 exit 0인지 본다. 아래 블록은 모두 `. .claude/skills/verify-werft/scripts/lib.sh <run id>`로 시작하고, 블록 사이의 id는 블록이 `NAME=값` 줄로 출력하고, 그 줄을 Write 도구로 `$VERIFY_RUN/ids.sh`(이 run 디렉터리)에 적는다(Bash의 `>>`·heredoc으로 만들지 않는다. Write는 파일 전체를 덮어쓰므로 지금까지의 줄을 모두 적는다). 다음 블록에서 `. "$VERIFY_RUN/ids.sh"`로 읽는다.

```sh
# 2. owner와 App 등록
U=.claude/skills/verify-werft/scripts/web-user.mjs
node $U <run id> bootstrap owner; node $U <run id> login owner; ap_as owner
WS=$(ap_web GET /v1/auth/me | head -1 | jq -r .workspace.id); printf 'WS=%s\n' "$WS"
node $U <run id> github-app owner "$WS" "$SANDBOX_APP_ID" | tee "$EVIDENCE/gh-app-put.txt"
ap_web GET "/v1/workspaces/$WS/github-app" | tee "$EVIDENCE/gh-app-get.txt"
```

기대: PUT `200`, `github_app.app_id`(`$SANDBOX_APP_ID`), `slug: "werft-sandbox-agent"`, `permissions`(지금 App이 가진 권한), `receipt_id`. GET `200`, `check.state: "ok"`, `repositories`의 `sandbox`에 sandbox 설치의 `installation_id`. 키는 어느 응답에도 없다.

```sh
# 3. 상한(Actions)과 에이전트 릴리스
REV=$(ap_web GET "/v1/workspaces/$WS/github-settings" | head -1 | jq -r .revision)   # 모두 false. 새 설치도 revision이 0이 아니다
ap_web PUT "/v1/workspaces/$WS/github-settings" "$(jq -nc --argjson r "$REV" '{ceiling:{workflows:false,actions:true,checks:false,issues:false,review:false},revision:$r}')"
CARD='{"role":"sandbox","instructions":"Follow the script.","language":"ko","model":"claude-sonnet-5","capabilities":{"tools":["Read","Bash"],"mcp":null,"forbidden":[]},"rules":[]}'
TEAM=$(ap_web POST /v1/teams '{"name":"sandbox"}' | head -1 | jq -r .team.id)
A=$(ap_web POST /v1/agents "{\"slug\":\"sandbox\",\"name\":\"sandbox\",\"managing_team_id\":\"$TEAM\",\"card\":$CARD}" | head -1)
AID=$(echo "$A" | jq -r .agent.id); VID=$(echo "$A" | jq -r '.versions[0].id')
GH='{"repositories":["sandbox"],"push_approval":true,"features":{"workflows":false,"actions":true,"checks":false,"issues":false,"review":false},"actions_allow":[{"workflow":"sandbox-dispatch.yml"}]}'
REL=$(ap_web POST "/v1/agents/$AID/releases" "$(jq -nc --arg v "$VID" --argjson g "$GH" '{version_id:$v, connection_id:"fake-messages", repository_id:"sandbox", github:$g}')" | head -1 | jq -r .release.id)
ap_web POST "/v1/agents/$AID/activate" "$(jq -nc --arg r "$REL" '{release_id:$r, expected_revision:-1}')"
ap_web GET "/v1/agents/$AID/github" | tee "$EVIDENCE/gh-agent.txt"
printf 'AID=%s\nREL=%s\n' "$AID" "$REL"
```

```sh
# 3b. 성과 규칙: pull_request type에 바로 인정 규칙 (세션 전에)
. "$VERIFY_RUN/ids.sh"; ap_as owner
PRT=$(ap_web GET /v1/achievement-types | head -1 | jq -r '.items[] | select(.["key"]=="pull_request") | .id')
CAT=$(ap_web POST /v1/achievement-categories '{"name":"개발"}' | head -1 | jq -r .category.id)
ap_web POST /v1/achievement-rules "$(jq -nc --arg c "$CAT" --arg t "$PRT" '{category_id:$c,title:"PR 열기",type_id:$t,definition:"세션이 연 PR",judge:"always"}')" | head -1 | jq -c '.rule | {title, judge, version}'
ap_web GET "/v1/workspaces/$WS/achievement-judge" | head -1 | jq -c '.achievement_judge | {connection_id, on_evidence}'
```

기대: 규칙 `{"title":"PR 열기","judge":"always","version":1}`, 판정 설정 `connection_id: null`, `on_evidence: true`. type의 key 칸은 jq에서 `.["key"]`로 읽는다(점 표기는 agent-guard의 키 파일 경로 패턴에 걸린다).

기대: 상한 PUT `200` `revision`이 읽은 값 + 1. 상한 PUT이 실패하면 릴리스가 `actions_off`로 거절되어 아래 `REL`이 비므로 먼저 이 응답을 본다. 릴리스 `200` `release.id`(`sha256:…`), 활성화 `200`. `GET …/github`는 `enabled: true`, `github`가 보낸 값, `active_release_id`가 `REL`.

```sh
# 4. 세션: clone → commit(Bash 권한 허용)
. "$VERIFY_RUN/ids.sh"; U=.claude/skills/verify-werft/scripts/web-user.mjs
node $U <run id> key owner personal sessions:read,sessions:write,sessions:approve; ap_as owner
SPEC='GATE-SPEC {"id":"gh1","steps":[{"tool":"Bash","input":{"command":"mkdir -p notes && date -u +%FT%TZ > notes/verify-skill.txt && git add notes/verify-skill.txt && git commit -qm \"docs: verify-werft sandbox note\" && git log --oneline -1","description":"commit a note"}}],"final":"committed"}'
SID=$(ap_post /v1/sessions "$(jq -nc --arg r "$REL" --arg m "$SPEC" '{agent_release_id:$r, message:$m}')" | head -1 | jq -r .session_id)
printf 'SID=%s\n' "$SID"
for i in $(seq 1 90); do [ "$(ap_get "/v1/sessions/$SID" | head -1 | jq -r .status)" = needs_input ] && break; sleep 2; done
REQ=$(ap_get "/v1/sessions/$SID/pending-requests" | head -1 | jq -r '.items[0].request_id')
ap_web POST "/v1/sessions/$SID/answers" "$(jq -nc --arg r "$REQ" '{request_id:$r, kind:"permission", action:"allow"}')"
for i in $(seq 1 60); do [ "$(ap_get "/v1/sessions/$SID/turns/1" | head -1 | jq -r .status)" = completed ] && break; sleep 2; done
ap_get "/v1/sessions/$SID/turns/1" | tee "$EVIDENCE/gh-turn.txt"
```

기대: 세션 `201`(저장소 `sandbox`. 설정 행이 없는 에이전트라서이고, 행이 있는 에이전트는 `repository_id: null`로 시작한다), `needs_input`에 Bash 권한 요청 하나, answers `202`(사람의 cookie로 답한다. 웹에서 발급한 개인 key로 자기 세션에 답하면 `403 FORBIDDEN` `self_approval`), turn 1 `completed`. clone이 실패하면 세션이 `failed`이고 이유는 6의 `mint_github_token` 거절 receipt에 있다.

```sh
# 4b. push 거절 3종 (승인 전 push 요청이 없는 상태에서, 5보다 먼저)
. "$VERIFY_RUN/ids.sh"; ap_as owner
P=$(ap_post "/v1/sessions/$SID/push-requests" '{}' | head -1); P1=$(echo "$P" | jq -r .id); C1=$(echo "$P" | jq -r .git_commit)
ap_post "/v1/sessions/$SID/push-requests/$P1/pull-request" '{}'      # 승인 전: 409 PUSH_NOT_PUSHED
gh api "repos/JeongJaeSoon/werft-sandbox/branches/agent/$SID" --jq .name   # 404, 아직 원격에 브랜치가 없다
ap_web POST "/v1/sessions/$SID/push-requests/$P1/reject" "$(jq -nc --arg c "$C1" '{git_commit:$c, reason:"verify reject"}')"   # 200 rejected
ap_web POST "/v1/sessions/$SID/push-requests/$P1/approve" "$(jq -nc --arg c "$C1" '{git_commit:$c}')"   # 409 PUSH_REQUEST_RESOLVED
ap_post "/v1/sessions/$SID/push-requests/$P1/pull-request" '{}'      # 409 PUSH_NOT_PUSHED (push_request_state: rejected)
for B in refs/heads/main HEAD ../main main/x; do ap_post "/v1/sessions/$SID/push-requests" "$(jq -nc --arg b "$B" '{branch:$b}')"; done   # 모두 400 BAD_REQUEST
```

기대: 위 주석대로다. 409 거절의 오류 본문에는 `details.refusal`(`not_pushed`·`already_resolved`)과 `receipt_id`가 있다. 400은 서비스를 부르기 전의 입력 검증이라 둘 다 없고 `details.issues`만 있다. 대상 브랜치는 계약상 항상 `agent/<SID>[-접미사]`라 기본 브랜치를 가리킬 수 없다. 접미사 칸에 `main`·`master`를 넣으면 거절이 아니라 각각 `agent/<SID>-main`·`agent/<SID>-master` 요청이 201로 만들어진다(기본 브랜치에는 닿지 않는다). 그 요청은 reject로 정리한다. worker의 직접 `git push`는 egress proxy에 receive-pack 경로가 없어 막힌다(`apps/egress-proxy/src/credential.ts`).

```sh
# 5. push 요청 → 승인 → push → PR
. "$VERIFY_RUN/ids.sh"; ap_as owner
P=$(ap_post "/v1/sessions/$SID/push-requests" '{}' | head -1); PRID=$(echo "$P" | jq -r .id); COMMIT=$(echo "$P" | jq -r .git_commit)
ap_web POST "/v1/sessions/$SID/push-requests/$PRID/approve" "$(jq -nc --arg c "$COMMIT" '{git_commit:$c}')"
for i in $(seq 1 30); do s=$(ap_get "/v1/sessions/$SID/push-requests/$PRID" | head -1 | jq -r .state); case $s in pushed|failed) break ;; esac; sleep 2; done; echo "$s"
ap_post "/v1/sessions/$SID/push-requests/$PRID/pull-request" '{"title":"verify-werft: GitHub sandbox flow"}' | tee "$EVIDENCE/gh-pr.txt"
ap_post "/v1/sessions/$SID/push-requests/$PRID/pull-request" '{}'      # 같은 PR, created: false
printf 'PRID=%s\n' "$PRID"
```

기대: push 요청 `201` `state: "requested"`, `target_branch: "agent/<SID>"`, 요청 id는 `.id`다(`push_request_id`가 아니다). 결정 `200`(cookie로. 다른 `git_commit`이면 `409 CHECKPOINT_MOVED`, `details.refusal: "commit_mismatch"`, 요청은 `requested`로 남는다). 상태 `pushed`. PR `201` `created: true`와 `pull_request.url`, 두 번째 `200` `created: false`. `gh pr view <n> -R JeongJaeSoon/werft-sandbox --json author,headRefName,state`는 `app/werft-sandbox-agent`, `agent/<SID>`, `OPEN`.

```sh
# 5b. 성과: PR 근거 → 바로 인정 성과
. "$VERIFY_RUN/ids.sh"; ap_as owner
for i in $(seq 1 60); do n=$(ap_get "/v1/sessions/$SID/achievements" | head -1 | jq '.items | length'); [ "$n" -gt 0 ] && break; sleep 5; done
ap_get "/v1/sessions/$SID/achievements" | head -1 | jq -c '.items[] | {title, judge, review_state, evidence_kind, probability, payload}' | tee "$EVIDENCE/gh-achievement.txt"
ap_get "/v1/sessions/$SID/achievements" | head -1 | jq -c '{judgment: (.judgment | {trigger, status}), judgment_count, judge_cost_usd}'
ap_get "/v1/usage/achievements?scope=me&since=$(date -u -v-1d +%FT%TZ)" | head -1 | jq -c '{achievement_count, needs_review_count, cost_usd, cost_per_achievement_usd, judge_cost_usd}'
ap_compose exec -T postgres psql -U postgres -d sessions -c "select trigger, status, backend, calls, cost_usd, error_code from achievement_judgments where session_id = '$SID'"
```

기대: PR 전 `items` 0, `judgment` null. PR 뒤 2~3분 안에 성과 하나: `title` `JeongJaeSoon/werft-sandbox#<n>`, `judge: "always"`, `review_state: "auto"`, `evidence_kind: "github_pull_request"`, `probability: null`, `payload.state: "open"`. 판정은 `trigger: "evidence"`, `status: "succeeded"`, `judge_cost_usd` 0. Luna를 부르지 않은 것은 DB 행의 `backend` 빈 값, `calls` 0, `cost_usd` 0으로 본다(API 판정에는 backend 칸이 없다). 사용량은 `achievement_count: 1`, `cost_per_achievement_usd`가 세션 비용과 같고 `judge_cost_usd`는 0.

```sh
# 6. dispatch·run·rerun과 게이트 receipt
. "$VERIFY_RUN/ids.sh"; ap_as owner
ap_post "/v1/sessions/$SID/github/workflow-dispatches" '{"workflow":"sandbox-dispatch.yml","ref":"main"}' | tee "$EVIDENCE/gh-dispatch.txt"
ap_post "/v1/sessions/$SID/github/workflow-dispatches" '{"workflow":"sandbox-other.yml","ref":"main"}'        # 403 workflow_not_allowed
ap_post "/v1/sessions/$SID/github/workflow-dispatches" "$(jq -nc --arg r "agent/$SID" '{workflow:"sandbox-dispatch.yml", ref:$r}')"   # 403 agent_ref_refused
ap_post "/v1/sessions/$SID/github/workflow-runs/1/rerun" '{}'                                                  # 403 run_ref_unprovable
ap_get "/v1/sessions/$SID/github/workflow-runs/1"                                                              # actions_read: App에 Actions가 없으면 409 app_permission_missing
RC=$(ap_post "/v1/sessions/$SID/github/workflow-dispatches" '{"workflow":"sandbox-other.yml","ref":"main"}' | head -1 | jq -r .error.details.receipt_id)
ap_get "/v1/receipts/$RC" | head -1 | jq -c '{operation, status, result}'                                     # 거절을 다른 경로로 다시 읽는다
ap_web GET "/v1/agents/$AID/github/activity" | head -1 | jq -c '[.items[] | {operation, status, reason_code: .result.reason_code, purpose: .result.purpose}]'
ap_compose exec -T postgres psql -U postgres -d sessions -c "select operation, status, result->>'purpose' purpose, result->>'reason_code' reason from receipts where target_ref->>'session_id' = '$SID' order by created_at"
```

기대: 오류는 모두 `error.code: "GITHUB_REFUSED"`와 `details.reason_code`·`details.receipt_id`다. 목록 밖 `403 workflow_not_allowed`, `agent/` ref `403 agent_ref_refused`, 기록 없는 run의 rerun `403 run_ref_unprovable`은 GitHub를 부르지 않고 `dispatch_workflow`·`rerun_workflow` failed receipt를 남긴다. receipt `result`에는 `workflow`·`ref`·`purpose`·`agent_id`·`agent_release_id`·`repository_id`·`reason_code`가 있고 `inputs` 값은 없다. 목록 안 dispatch와 run 조회는 App 권한과 sandbox 워크플로에 달렸다(Gotchas). activity(최근 순)와 DB에 `mint_github_token`(`clone`·`push`·`pull_request`)이 succeeded, `create_agent_release`·`activate_agent`가 있다.

```sh
# 7. 정리: 자기 PR 닫기, 스택 내리기(volume 유지), 잠금 놓기
gh pr close <n> -R JeongJaeSoon/werft-sandbox --delete-branch
orch heavy <program> -- .claude/skills/verify-werft/scripts/down.sh <run id>
orch release verify-stack
```

## 머지 허용 측정 (`merge_pull_request`)

워크스페이스 상한 `ceiling.merge`(기본 off)가 켜져 있을 때만 에이전트의 MCP 도구 `merge_pull_request(push_request_id)`가 PR을 squash 머지한다. 꺼져 있으면 resolver와 토큰 발급 전에 `GITHUB_REFUSED` 409 `merge_off`로 거부한다. 머지에 관한 거부 사유는 `merge_off`·`merge_blocked`·`head_moved`·`pull_request_closed`·`no_pull_request`다(PR 공통 거부 `not_pushed`·`not_found` 등도 같은 도구에서 나올 수 있다). fake 모델은 GATE-SPEC 단계의 `tool`을 그대로 내보내므로 실제 모델 키 없이 사용자 메시지 "머지해"를 도구 호출로 바꿀 수 있다(`tool: "mcp__github__merge_pull_request"`, `input: {push_request_id}`). 위 1–3단계(App 등록·릴리스)와 5단계(push·PR)를 먼저 한다. 릴리스의 `features`는 모두 false여도 된다. 머지는 워크스페이스 상한만 본다.

```sh
# M0. 기본값(C): 상한을 한 번도 바꾸지 않은 새 워크스페이스
. "$VERIFY_RUN/ids.sh"; ap_as owner
ap_web GET "/v1/workspaces/$WS/github-settings" | head -1 | jq -c '{revision, ceiling}'      # ceiling.merge: false

# M1. 켜기(A): 웹 GitHub 연동의 머지 허용 스위치와 같은 API
REV=$(ap_web GET "/v1/workspaces/$WS/github-settings" | head -1 | jq -r .revision)
ap_web PUT "/v1/workspaces/$WS/github-settings" "$(jq -nc --argjson r "$REV" '{ceiling:{workflows:false,actions:false,checks:false,issues:false,review:false,merge:true},revision:$r}')"

# M2. 측정 전 에이전트 값
ap_web GET "/v1/agents/$AID" | head -1 | jq -c '{behavior_revision, active_release: {id: .active_release.id}}' | tee "$EVIDENCE/before-agent.json"

# M3. 5단계로 push·PR을 만든 뒤(그 세션이 SID, push 요청이 PRID) 같은 세션에 "머지해"
M=$(jq -nc --arg p "$PRID" '"머지해 GATE-SPEC " + ({id:"m2",steps:[{tool:"mcp__github__merge_pull_request",input:{push_request_id:$p}}],final:"done"}|tojson)' -r)
T=$(ap_post "/v1/sessions/$SID/messages" "$(jq -nc --arg m "$M" '{message:$m}')" | head -1 | jq -r .turn_id)
# 도구 호출이 Bash 권한과 같은 방식으로 needs_input에 권한 요청을 하나 올린다: 4단계의 answers로 allow
ap_compose exec -T postgres psql -U postgres -d sessions -c "select operation, status, result->>'purpose' purpose from receipts where target_ref->>'session_id' = '$SID' order by created_at"
gh pr view <n> -R JeongJaeSoon/werft-sandbox --json state,mergedAt,mergeCommit
ap_web GET "/v1/agents/$AID" | head -1 | jq -c '{behavior_revision, active_release: {id: .active_release.id}}' | tee "$EVIDENCE/after-agent.json"   # M2와 같다

# M4. 끄기(B): 4·5단계를 새 세션으로 되풀이해 새 PR을 열고(SID2, PRID2), 요청 직전 시각을 잡은 뒤 "머지해"
REV2=$(ap_web GET "/v1/workspaces/$WS/github-settings" | head -1 | jq -r .revision)
ap_web PUT "/v1/workspaces/$WS/github-settings" "$(jq -nc --argjson r "$REV2" '{ceiling:{workflows:false,actions:false,checks:false,issues:false,review:false,merge:false},revision:$r}')"
T0=$(ap_compose exec -T postgres psql -U postgres -d sessions -At -c "select now()")
# M3와 같은 메시지를 SID2·PRID2로 보내고 권한 요청에 allow로 답한 뒤 turn이 끝나기를 기다린다
ap_compose exec -T postgres psql -U postgres -d sessions -c "select operation, status, result->>'purpose' purpose from receipts where target_ref->>'session_id' = '$SID2' and created_at > '$T0' order by created_at"
ap_compose exec -T postgres psql -U postgres -d sessions -At -c "select result::text from receipts where operation='merge_pull_request' and target_ref->>'session_id'='$SID2'"
```

기대:

- 켜기(A): 영수증 `mint_github_token`(`purpose: merge`) 성공(캐시된 토큰을 쓰면 새로 남지 않을 수 있다) 뒤 `merge_pull_request` 성공, PR `MERGED`와 `mergeCommit`. 측정 전후 `behavior_revision`과 `active_release.id`가 같다.
- 승인 리뷰: sandbox `main`의 ruleset이 승인 리뷰 1개를 요구하고 에이전트의 머지는 `bypass_rules: false`다. 승인 없이 켠 상태로 부르면 GitHub가 거절해 영수증 `merge_pull_request` `failed`, `result.refusal: "merge_blocked"`, PR은 OPEN으로 남는다(`mint_github_token` `merge`는 성공으로 남는다). 성공 측정에는 사람의 승인이 필요하다. 에이전트나 이 절차가 승인하지 않는다. 승인 계정은 PR 작성 App과 달라야 한다.
- 끄기(B): 구간 안 영수증은 `append_message`·`answer`와 `merge_pull_request` failed 둘뿐이고 `mint_github_token`은 없다. 둘 중 하나는 게이트가 남긴 것이고(`purpose: merge`), 다른 하나는 서비스가 거부를 잡아 남긴 것이다. 게이트 쪽 `result`는 `reason_code: "merge_off"`·`purpose`·`agent_id`·`agent_release_id`·`repository_id`·`workspace_ceiling_revision`·`policy_source`이고, 서비스 쪽은 `refusal: "github_refused"`·`reason_code: "merge_off"`·`push_request_id`와 PR 정보다. 어느 쪽에도 `connection_id`·`app_id`·`role`은 없다. PR은 OPEN이다.
- 기본값(C): `ceiling.merge: false`.

## Gotchas

- **api만 재시작하면 주소가 바뀐다.** `ap_compose restart api`는 ephemeral 포트를 새로 받아 `state.env`의 주소와 어긋난다. `lib.sh`를 source한 뒤 `ap_as` 다음 줄에 `API=http://127.0.0.1:$(ap_compose port api 3000 | cut -d: -f2)`로 바꿔야 `ap_*`가 닿는다(`VERIFY_API`가 아니라 `API`를 읽는다). `state.env`는 agent-guard가 막으므로 열지 않는다.

- **운영자 단계에 달린 항목.** 설계 문서 9절의 운영자 단계 1(App의 Actions 권한)·4(werft-sandbox `main`의 `.github/workflows/`)가 끝나지 않았으면 목록 안 dispatch는 `409 app_permission_missing`(GitHub가 `actions: write` 발급을 거절)에서 멈추고, run 조회(`actions_read`)도 같은 이유로 거절된다. 성공·run 조회·rerun 성공은 운영자 단계 뒤에 같은 명령으로 확인한다. 워크플로만 없으면 GitHub가 dispatch를 404로 답한다.
- **릴리스 없는 세션은 GitHub 설정이 없다.** 개인 key로 `repository_id: "sandbox"`만 주고 만든 세션은 기본 설정(Actions 꺼짐)이라 dispatch가 `403 feature_off`다(코드 기준: `packages/platform/src/github/service/github-gate.ts`의 `settings === null`). dispatch를 보려면 위처럼 `agent_release_id`로 만든다.
- **키 경로를 명령에 쓰지 않는다.** agent-guard가 키 파일 모양의 경로가 든 명령을 막는다. 다른 파일이면 `VERIFY_GITHUB_APP_KEY_FILE`을 따로 export하는 줄도 같은 이유로 막힐 수 있으니, 기본 경로에 둔다.
- **머지는 사람의 리뷰가 있어야 한다.** werft-sandbox `main`의 ruleset이 승인 리뷰 1개를 요구해 `gh pr merge`가 거절된다. `--admin`으로 넘지 않는다. 그래서 머지 뒤 근거 상태(`merged`)와 Luna 규칙의 다시 판정은 이 절차로 보지 못한다(연결 저장 뒤 후속 검증).
- **sandbox 저장소는 공유 상태다.** 다른 카드가 연 PR·브랜치가 있다. `gh pr list -R JeongJaeSoon/werft-sandbox`로 자기 `agent/<SID>`만 골라 닫는다. 머지는 하지 않는다(auto mode가 [Merge Without Review]로 막는다. 필요하면 사람에게 명령 한 줄로 넘긴다).
- **다른 run의 파일을 읽지 않는다.** 남겨 둔 run의 `state.env`는 agent-guard가 막는다. 자기 run을 새로 띄운다.
- **repo 밖 overlay**(예: 저장소 밖 디렉터리의 카탈로그 App overlay)는 `up.sh`가 repo 기준으로 붙이므로 `../../…` 상대 경로로 넘긴다.
