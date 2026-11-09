# 결정(설계): 에이전트 행동 도구 카탈로그

- 상태: 설계. 에이전트 행동 단위 L1~L16, PR 템플릿 단위 PR 0~8, Slack 카드 단위 P1~P4가 이 문서를 계약으로 쓴다. 도구 이름, 노출 방식, 입력, 출력 봉투, 실패 코드, 멱등성, 허용 정책을 여기서 정한다.
- 정본 입력: 설계 기록 `ap-action-layer-20261103/tool-catalog.md`(오너 검토 폴더, 저장소 밖. 아래에서 **카탈로그**). 이 문서는 그 결정을 줄인 것이다. 스키마 전문, 명령별 출력, 테스트 목록은 각 항목이 가리키는 카탈로그 절에 있다. 둘이 다르면 이 문서가 맞고, 다른 점은 이 문서를 고치는 PR이 카탈로그 쪽에도 적는다.
- 기준 커밋: `origin/main` `777c78db2`. 아래 `파일:줄`은 모두 이 커밋에서 직접 읽은 것이다.
- 오너 원문(2026-11-04): "내가 말한 레이어는 플랫폼이 대신 맡아 처리하는게 아니야 / 내가 말하는건 일정한 정형화 된 툴 (예를 들어 슬랙 메시지 전송, slack 메시지의 마크다운 폼 ㅍ변경, slack 메시지 의사 결정 폼 전송, github commit 작성, pr 작성, push 등등) 의 처리 등등 정형화 되어서 동작되어야하는걸 안정적으로 사용할수 있도록 tools 을 제공하라른거야 내부 mcp 같은 거일수도 잇고 매번 고정되어잇는 스크립트일수도 잇고"
- 오너 원문(같은 날): "gh 는 gh app 의 권한을 사용해서 자동으로 사용할수 있게 하고 agent 의 호출한 사람을 맵핑해서 pr 이나 commit 에 반영해야하는거 아니야 ?", "그 내가 아까 추가하라고 말한 레이어의 대응 (슬랙 메시지 전송, git 과 github 조작 등등) 이 egress-proxy 의 구조와 적절히 연계 되어야할지도."
- 확정된 오너 결정: D1 a(commit에 엔진 이름 `Co-Authored-By: Claude`를 넣지 않음), D2 a, D3 b, D4 a, D5 a. 작성자 방향은 "PR과 commit 모두 작성자는 플랫폼 GitHub App bot이고, 요청한 사람은 Co-author"다. D6~D11은 [10절](#10-오너-결정-d1d11)의 도구 관점 재분류가 정본이다.

## 요약

| 항목 | 결론 |
|---|---|
| 무엇 | 에이전트가 바깥에 효과를 내는 일(Slack 메시지, mrkdwn 변환, 의사결정 폼, commit, push, PR)을 정해진 모양으로 처리하는 **도구 카탈로그**. 도구 여섯(T1~T6)과 셸 입구 둘(T7 `git push` 안내, T8 `gh`), 기존 내장 MCP 도구 |
| 원칙 | 바깥 효과는 모두 모델이 부른 도구 호출 하나, 또는 엔진이 돌려준 것 하나에서 나온다. 플랫폼은 그 호출을 늦게 끝낼 수 있지만(턴 끝 push, push 뒤 PR) 스스로 시작하지 않는다 |
| 자격 증명 | 샌드박스에는 GitHub·Slack 자격이 없다. GitHub 토큰은 control-host의 GitHub 게이트만 내주고, 쓰기 토큰은 control-host 안에서만 쓴다 |
| 쓰기 경로 | MCP든 `gh`든 같은 dispatcher, 같은 서비스, 같은 App bot 토큰, 같은 작업 기록(receipt)을 지난다. `git push`는 GitHub로 가지 않고 플랫폼 도구를 쓰라는 안내만 받는다 |
| 결과 | 모든 도구가 같은 봉투 `{ ok, result }` 또는 `{ ok: false, refusal: { code, by, retryable, details } }`를 낸다. 모델에게 쓰는 안내문(`message`)은 없다 |
| 허용 | 행동 부류(`message.thread`, `decision`, `commit`, `push.primary`, `push.attached`, `pull_request.write`, …)마다 서버 한 곳이 판정한다 |
| 귀속 | commit·PR 작성자는 App bot. 그 턴을 요청한 사람이 GitHub 계정을 연결했으면 `Co-authored-by`, 연결하지 않았으면 이름을 남기지 않는다 |
| push 승인 판정 | `pushApprovability`가 정본이다. Slack 카드와 웹은 판정하지 않고 이 함수를 읽는다 |

## 지금 구조

- **Slack 답.** 턴의 답은 `enqueueSlackTurnAnswers`(`packages/platform/src/musterrolle/slack-outbox.ts:247`)가 outbox에 넣고, 렌더할 때 `markdownToSlackMrkdwn`(`packages/platform/src/musterrolle/slack-mrkdwn.ts:370`)으로 바꾼다(`slack-outbox.ts:186`). outbox 종류는 `instruction`·`reply`·`notice`·`failure_notice`·`input_notice`·`welcome`이고(`packages/platform/src/ports/slack-outbox-store.ts:8-23`), 결과를 모르는 전송은 `uncertain`으로 남겨 다시 보내지 않는다(`:25-29`).
- **의사결정 카드.** 엔진의 승인 요청은 runtime-core `ApprovalRequested`(`packages/runtime-core/src/approval.ts:12`)로 나오고, 사람의 답은 `ApprovalAnswer`(`:49`), 끝나는 이유는 `CancelReason`(`:38`)이다. Slack은 이것을 `SlackPrompt`(`permission`·`question`·`push`, `packages/platform/src/musterrolle/slack-prompts.ts:16-43`)로 받아 `slackPromptMessage`(`:538`)로 그린다. 요약 한 줄은 `summarizeToolRequest`(`packages/platform/src/musterrolle/slack-prompt-summary.ts:170`), 최상위 `text`는 `slackCardText`(`slack-prompts.ts:460`)다.
- **GitHub 도구.** 내장 MCP 서버 `github`는 release에 GitHub 설정이 있을 때만 세션에 붙는다(`packages/platform/src/workers/worker-gateway.ts:873-902`). 첫 checkpoint 전의 `request_push`는 모델에게 영어 안내문을 담은 `deferred` 결과를 주고, 오류도 `message`를 싣는다(`packages/platform/src/sessions/github-mcp-server.ts:284-300`). 거절 코드는 push가 `PUSH_REFUSAL_VALUES`(`packages/contracts/src/api/push-request.ts:145`), PR이 `PULL_REQUEST_REFUSAL_VALUES`(`packages/contracts/src/api/pull-request.ts:95`)다. GitHub 토큰은 게이트가 내주고 새로 받을 때 `mint_github_token` receipt를 남긴다(`packages/platform/src/sessions/github-gate.ts:359`).
- **셸.** 이미지의 `gh`는 자격이 없고 `api.github.com`은 기본 allowlist 밖이다(`apps/worker/Dockerfile:135-137`). egress proxy에는 receive-pack 경로가 없어(`apps/egress-proxy/src/credential.ts:252`) `git push`는 404 "no such credential route"로 끝난다(`:1702`).
- **귀속.** `Co-authored-by`는 세션 시작자 한 사람이다(`coAuthorOf`, `packages/platform/src/sessions/git-attribution.ts:29`. PR 꼬리는 `Started by` 줄, `:147`).

## 1. 위치와 이름

- 계약 목록의 이름은 **에이전트 행동 도구 카탈로그**다. 그 뒤에서 일하는 control-host 안의 모듈은 **action-broker**다. action-broker가 dispatcher, 정책 게이트, 자격 사용, receipt를 맡는다. 화면 문구에서는 "에이전트 작업"이라 쓴다(예: "에이전트 작업 기록").
- 코드 모듈은 `packages/platform/src/action-broker/`, 계약(봉투, 코드표)은 `packages/contracts/src/api/action-broker.ts`다. 둘 다 아직 없고 L1이 만든다.
- action-broker는 모듈 이름이고 레이어 이름이 아니다. 레이어 이름을 묻던 D9를 폐기한 것([10절](#10-오너-결정-d1d11))과 부딪히지 않는다. 오너가 이름을 Codex와 정하라고 맡겼고(2026-11-04), `worker-gateway`와 헷갈리는 `action-gateway`는 쓰지 않는다.
- 정책 구현, 토큰 발급, 작업 기록은 control-host의 플랫폼 서비스에 둔다. 판정에 쓰는 사실(checkpoint, push 요청, release, 연결 계정)이 모두 그쪽 DB에 있기 때문이다. 엔진 어댑터는 계약을 엔진에 붙이는 일만 한다([9절](#9-어댑터-적합성-항목)). worker는 작업 공간 안의 일(commit hook, 턴 끝 귀속 복구, checkpoint, T4 스크립트)만 한다.
- 내장 MCP 서버 이름 `github`와 도구 이름 `mcp__github__<tool>`은 바꾸지 않는다. GitHub와 상관없는 모델 도구(2단계의 `ask_person`, `send_message`)가 생기면 두 번째 내장 서버 `platform`을 같은 경로로 더한다.
- "GitHub Actions workflow"는 늘 "workflow"라고 쓴다. 이름의 "행동(actions)"과 섞이지 않게 하려는 것이다.

## 2. 원칙

1. **플랫폼이 스스로 시작하는 바깥 효과는 없다.** Slack 메시지, commit, push, PR은 모두 모델이 부른 도구 호출 하나, 또는 엔진이 돌려준 것(턴의 답, 승인 요청) 하나에서 나온다. 플랫폼은 그 호출을 늦게 끝낼 수 있다(턴 끝 push, push 뒤 PR 예약). 예외는 [11절](#11-도구-위에-얹는-것)에 모두 적는다.
2. **모델은 내용, 플랫폼은 형식·시점·정책.** 모델이 넘기는 것은 무엇을, 왜, 어디에(저장소·브랜치 접미사·경로)다. 템플릿, 트레일러, 언어 틀, 링크 문법, 멘션, 시점, 허용은 플랫폼이 정한다. 입력 스키마는 모두 strict이고, 세션 id는 받지 않는다(MCP는 attempt token이, 스크립트는 그 worker의 claim이 세션을 정한다).
3. **자격 증명은 control-host에만 있다.** 샌드박스가 가진 것은 attempt마다 발급되는 용도별 대리 토큰뿐이다. 대리 토큰은 GitHub·Slack 자격이 아니고, 그 attempt 동안 그 용도의 프록시 경로만 연다.
4. **쓰기는 같은 dispatcher, 같은 서비스, 같은 App bot, 같은 작업 기록을 지난다.** 정책의 구현은 서비스와 게이트의 함수 하나이고, 경계(프록시 authorizer, 처리기, 게이트)마다 같은 함수를 다시 부른다. 입구가 여럿이어도 기록은 같고, 입구는 요청 단계 receipt의 `entry`(`mcp`·`gh`)로만 구별한다.
5. **도구 결과는 구조화 코드다.** 모델에게 "이렇게 말하라", "다시 불러라"를 쓰지 않는다. 도구 설명은 필드의 뜻만 쓴다.

## 3. 노출 방식과 실행 경로

카탈로그 0절(그림), 3.1절(노출 방식), 3.7절(실행 경로).

| 노출 방식 | 어디서 도나 | 에이전트의 입구 | 도구 |
|---|---|---|---|
| 내장 MCP 도구 | control-host. 모델은 egress proxy `/mcp/github`로 닿는다 | MCP `tools/call` | T5, T6, 기존 도구([5.9](#59-그-밖의-기존-도구)) |
| 고정 스크립트 | worker 이미지의 실행 파일. 엔진이 자기 셸 도구로 부른다 | 셸 명령 한 줄(stdin JSON, stdout JSON) | T4 |
| 플랫폼 함수 | control-host. 엔진이 돌려준 것과 지연 완료 결과를 사람 표면에 낸다 | 턴의 답(T1), 엔진의 승인 요청·질문(T3) | T1, T2, T3 |
| 셸 입구 | 샌드박스의 `gh` shim → egress proxy → control-host의 MCP와 같은 dispatcher | 정해진 `gh` 명령. `git push`는 안내만 | T7, T8 |

```text
 사람 (Slack 스레드 · 웹 콘솔)                                    GitHub / Slack
   │ 요청한 사람 = 호출자                                             ▲
   ▼                                                                  │ App 설치 토큰(단기, 저장소 하나) · Slack bot 토큰
 ┌──────────────────── control-host: 자격 증명은 여기에만 있다 ───────┴─────────┐
 │  T1 메시지 · T2 mrkdwn · T3 결정 폼 ───────────────────────────────▶ Slack   │
 │  도구 dispatcher ─▶ push·PR·저장소 서비스 ─▶ GitHub 게이트(토큰) ─▶ GitHub   │
 │        ▲          receipt(entry: mcp·gh)         mint receipt                │
 │   MCP 처리기   gh 처리기                                                      │
 └───────┼────────────┼──────────────────────────────────────────────────────────┘
         │ egress proxy: 대리 토큰이 지금 세션을 가리키는지 확인하고 길을 나눈다
         │ /mcp/github   /actions/github/<tool>   git fetch: 프록시가 읽기 토큰을 붙임
         │                                        git push: 고정 안내(GitHub로 가지 않음)
 ┌───────┼────────────┼──────────────────────────── 샌드박스(worker): 자격 없음 ┐
 │  mcp__github__*     gh pr create (shim)    werft-commit · git commit          │
 └───────────────────────────────────────────────────────────────────────────────┘
```

| 도구 | 샌드박스에서 나가는 길 | 정책 판정 | 자격 주입 | 기록 |
|---|---|---|---|---|
| T1·T2 | 없음(엔진은 턴 답을 돌려줄 뿐) | `message.thread` 고정 allow | Slack bot 토큰, control-host | outbox 행 |
| T3 | 없음(승인 요청은 worker 프로토콜) | `decision`: 답하는 사람의 `session.approve` | Slack bot 토큰 | pending 요청 행·push 요청 행 + 카드 outbox 행 |
| T4 | 없음(작업 공간 안) | 엔진의 셸 도구 판정 | 없음 | 없음. 보장은 push 직전 검증(PR 3) |
| T5·T6·기존 MCP 도구 | `/mcp/github` | 각 서비스(부류는 [6절](#6-행동-부류-정책)) | 게이트 토큰, control-host 안 | 요청 `request_push`, 판정 `resolve_push`, 실행 `push`, PR `open_pull_request` receipt + `mint_github_token` |
| T7 `git push` | receive-pack에 고정 안내 | 없음 | 없음 | 없음 |
| T8 `gh` | `/actions/github/<tool>`(새, `actions` 대리 토큰) | 명령이 부르는 도구의 서비스 | 그 도구의 게이트 토큰 | 그 도구의 receipt(`entry: "gh"`) |
| git fetch·LFS(지금 있음) | `/repository/<id>/…` upload-pack | 게이트 | **프록시가** 게이트의 `clone` 토큰을 붙인다 | `mint_github_token` |

- 프록시가 GitHub **쓰기** 요청에 토큰을 붙여 그대로 보내는 길은 만들지 않는다. 프록시는 TLS를 풀지 않고, PR 꼬리를 쓰거나 귀속을 검증하는 일은 서비스만 할 수 있다.
- Slack에는 샌드박스 경로가 없다. "egress-proxy와의 연계"는 Slack에서는 같은 원칙(자격은 control-host에만, 정책은 도구가 고정, 기록 한 줄)으로 맞춘다.
- release에 GitHub 설정이 없으면 MCP 도구가 붙지 않고, `gh` shim은 `github_settings_missing`, `git push`는 같은 고정 안내다. 세션 프롬프트가 먼저 "이 에이전트에는 GitHub 작업이 설정되지 않았다"고 알려 모델이 시도하지 않게 한다.
- 운영자가 forward proxy allowlist에 `api.github.com`을 열면 진짜 `gh`·`curl`이 플랫폼 밖에서 GitHub에 닿는다. 샌드박스에 토큰이 없으므로 공개 API 읽기만 된다. 사람이 샌드박스에 토큰을 넣는 배포는 이 문서의 보장 밖이다.

## 4. 결과 봉투와 공통 규칙

카탈로그 3.3~3.5절.

```ts
// packages/contracts/src/api/action-broker.ts (L1)
type ActionRefusal = {
  code: string;                                   // ^[a-z][a-z0-9_]{1,63}$
  by: "policy" | "person" | "platform" | "github";
  retryable: boolean;                             // true only when the same call can succeed later unchanged
  details?: Record<string, unknown>;              // ids, SHAs, limits, outside text as data; never prose for the model
};
type ActionResult<T> = { ok: true; result: T } | { ok: false; refusal: ActionRefusal };
```

- MCP는 `structuredContent`와 `outputSchema`로 내고 같은 JSON을 `text`에도 싣는다. 스크립트(T4)는 같은 JSON을 stdout 한 줄로 낸다.
- `isError: true`(스크립트는 종료 코드 2)는 호출이 잘못됐을 때(`validation_error`)뿐이다. 서버·스크립트 내부 오류는 `isError: true`(스크립트는 종료 코드 1)와 `internal_error`(platform, false)다. 정책 거절, 사람 거절, 미뤄짐은 정상 결과다(종료 코드 0).
- 바깥 글(GitHub 응답, 저장소 hook 출력, 사람이 쓴 거절 사유)은 `details` 안의 데이터로만 싣는다.
- 플랫폼 함수(T1~T3)는 모델에게 봉투로 답하지 않는다. 결과는 outbox 행, pending 요청 행, push 요청 행의 상태다.
- **실패 코드.** 도구마다 contracts에 열거하고 코드마다 `by`·`retryable`을 고정한다. 이 문서의 표와 스냅샷 테스트로 묶는다. 지금 쓰는 값(`PUSH_REFUSAL_VALUES`, `PULL_REQUEST_REFUSAL_VALUES`)은 이름을 바꾸지 않고 새 값만 더한다.
- **서비스 오류를 봉투로 옮기는 순서**(모든 내장 MCP 도구). ① 그 도구의 코드표에 있는 코드는 그 표의 `by`·`retryable`. ② `SessionServiceError`의 `details.refusal`이나 `details.reason_code`가 그 도구의 코드표에 있으면 그 값을 `code`로 쓰고 ①을 따른다. ③ 그 밖은 서비스 코드를 소문자로(`GITHUB_REFUSED` → `github_refused`(github, false), `BACKEND_UNAVAILABLE` → `backend_unavailable`(github, true), 나머지 platform·false).
- **재시도·멱등성.** `retryable: true`는 "같은 인자로 다시 부르면 나중에 성공할 수 있다"일 때만이다. 도구마다 멱등 여부를 정한다. 멱등하지 않은 도구(T4)는 결과를 모를 때 다시 부르지 말고 무엇을 볼지 적는다. 지연 완료(턴 끝 push, PR 예약)는 상태를 DB에 두고 lease로 집으며, 다시 집은 실행기는 먼저 "이미 했는지"를 찾는다. 사람 표면 전송은 outbox dedupe key로 행 하나를 보장한다.

## 5. 도구

| # | 이름 | 노출 | 모델이 넘기는 것 | 플랫폼이 정하는 것 | 단위 |
|---|---|---|---|---|---|
| T1 | 메시지 전송 `post_message` | 플랫폼 함수. 입구는 턴의 답 | 턴의 최종 답(markdown) | 스레드, 멘션, 변환, escape, 자르기, 링크, 로캘, 중복 방지 | 있음. 턴 중간 `send_message`는 L11(2단계) |
| T2 | mrkdwn 변환 `render_mrkdwn` | 플랫폼 함수(순수) | - | GitHub식 markdown → Slack mrkdwn | 있음. 코드 안 URL 경계는 T2-a |
| T3 | 의사결정 폼 `send_decision_form` | 플랫폼 함수. 입구는 엔진의 승인 요청·질문 | 도구 호출(권한), 질문·선택지 | 요약, 카드, 버튼, 만료, 답할 사람, 웹·Slack 두 표면, 처리 뒤 줄, 정리 | P1~P4. `ask_person`은 L9(2단계) |
| T4 | git commit `werft-commit` | 고정 스크립트 | 제목, 본문, 넣을 경로 | 메시지 틀, 엔진 co-author 줄 제거, 경로 검사, Git 대상 환경 정리 | L10 |
| T5 | push `request_push` | 내장 MCP 도구 | 저장소, 브랜치 접미사 | 대상 브랜치, 고정 commit, 승인 방식, 턴 끝 실행 | L1·L3·L4 |
| T6 | PR 작성 `open_pull_request` | 내장 MCP 도구 | 제목, 요약, 변경, 배경, 테스트, 참고, 관련 이슈 | base·head, 템플릿, 꼬리, `Co-authored-by`, 정리, push 뒤 예약 | PR 4~7, L5 |
| T7 | `git push` 안내 | 셸에 고정 거절 | - | 안내 문구 | L13a |
| T8 | `gh` 입구 | 셸 입구(`gh` shim) | 정해진 문법의 `gh` 인자 | T5·T6·`list_repositories`와 같음 | L14 |
| T9 | PR 닫기·다시 열기 `close_pull_request`·`reopen_pull_request` | 내장 MCP 도구 | push 요청 id | 대상 PR 찾기, 머지 거절, 멱등 | T9([5.9](#59-그-밖의-기존-도구)) |

오너가 예로 든 여섯(메시지 전송, mrkdwn 변환, 의사결정 폼, commit, PR, push)이 모두 있다. "Slack 메시지 전송"의 에이전트 입구는 턴의 답 하나다. 턴 중간에 모델이 따로 보내는 입구(L11)는 2단계다(2026-11-04 결정).

### 5.1 T1 메시지 전송

카탈로그 5.1절.

| 항목 | 내용 |
|---|---|
| 입력 | `{ session_id, kind: "reply" \| "action_notice", text_markdown, link_url?, mention_user_ids? }`. 모델이 정하는 것은 `reply`의 본문뿐이다. `action_notice`의 글은 플랫폼 문구(i18n)이고 그 안의 모델 글은 escape한다 |
| 출력 | outbox 행 하나(`pending` → `sent` \| `failed` \| `uncertain`) |
| 실패 | Slack 스레드가 없는 세션은 행을 만들지 않는다(웹만). `uncertain`은 다시 보내지 않고, `reply`면 미전달 안내를 낸다 |
| 멱등 | dedupe key. 턴 답은 `reply:<session_link>:<turn>`, 지연 완료 알림은 `action:<id>:<결과>` |
| 정책 | `message.thread` 고정 allow. 다른 채널·DM으로 보내는 도구는 만들지 않는다 |
| 카탈로그 밖 | 플랫폼이 스스로 내는 `notice`·`welcome`·`instruction`·`failure_notice`·`input_notice`(T3 카드)는 T1이 아니다 |

### 5.2 T2 mrkdwn 변환

카탈로그 5.2절.

- 모델 markdown을 Slack에 내는 **유일한 변환**이다. 부르는 곳은 T1 렌더 한 곳이고, 순서는 변환 → escape → 자르기다. 두 번 적용해도 같다는 보장은 없다.
- 실패가 없는 전체 함수다. 입력에 내부 토큰 문자가 있으면 바꾸지 않고 그대로 돌려준다.
- T3 카드의 모델 글에는 쓰지 않는다. 카드는 plain_text·rich_text에 넣는다.
- **T2-a(실사용 결함, 2026-11-04 오너 제보).** URL로 끝나는 인라인 코드의 닫는 백틱 바로 뒤에 글자가 붙으면 Slack이 백틱과 그 글자까지 링크로 읽어 코드가 깨진다. 변환기는 그 자리에 구분 문자(기본 zero-width space, Slack에서 안 되면 공백)를 넣는다. 입력·기대 출력 10개와 Slack 렌더 확인은 카탈로그 5.2절 표가 완료 조건이다. 두 문자 모두 렌더 조건을 채우지 못하면 머지하지 않는다.

### 5.3 T3 의사결정 폼

카탈로그 5.3절.

| 항목 | 내용 |
|---|---|
| 입력(폼 payload) | `permission`(도구 이름, 표시용 입력), `question`(질문·선택지), `push`(저장소, 대상 브랜치, commit). 지금 모양은 `SlackPrompt`(`slack-prompts.ts:16-43`)다 |
| 출력 | 권한·질문: pending 요청 행 하나, 사람의 답은 엔진에 `ApprovalAnswer`로 간다. push: push 요청 행(`requested`)의 결정이 push 실행으로 이어지고 엔진에는 답하지 않는다. 어느 쪽이든 카드 outbox 행 하나 |
| 실패 | 권한·질문은 `CancelReason`(`expired`·`park`·`shutdown`·`interrupt`·`refused`). push 결정의 거절(`checkpoint_moved`, `self_approval` 등)은 결정한 사람에게 돌아간다. 카드로 그릴 수 없는 요청은 "웹에서 답해 주세요" 카드 |
| 멱등 | 요청 하나에 카드 하나(`prompt:<session_link>:<요청>`, `push:<session_link>:<요청>`). 결정은 한 번 |
| 정책 | `decision`. push 폼은 `push.*`가 `ask`일 때만 생긴다. push에는 "이 세션 동안 허용"이 없다 |

웹과 Slack은 같은 DB 행을 읽으므로 어느 쪽에서 답해도 다른 쪽은 끝 상태를 보인다.

### 5.4 T4 git commit `werft-commit`

카탈로그 5.4절(입력·결과 스키마, 고정 동작 9단계, 코드표, 동시 실행, 턴 수명주기, fingerprint).

- **모양.** `git commit`을 감싸는 얇은 wrapper다. 입력 검사와 메시지 틀만 더하고, 잠금·HEAD 처리·identity·hook은 Git과 엔진 `git commit`과 같다. `--no-verify`를 쓰지 않으므로 저장소 hook이 모두 돈다.
- **입력.** `{ subject(1..200, 한 줄), body?(..20000), include: "all" | 경로 1..200개 }`, strict. author, 트레일러, `--no-verify`, `--amend`, `--allow-empty`, pathspec 문법은 받지 않는다.
- **출력.** `{ commit, parent, branch, files_changed, author, co_author, attribution: "expected" | "mismatch" | "unknown" }`. `attribution`은 `~/.werft/git-identity`와 `~/.werft/git-trailers`에 견준 값이다.
- **실패 코드.**

  | 코드 | by | retryable |
  |---|---|---|
  | `validation_error`(종료 코드 2) | platform | false |
  | `no_repository`, `operation_in_progress`, `path_rejected`, `nothing_to_commit` | platform | false |
  | `git_busy` | platform | true |
  | `commit_failed`(`head_changed`면 commit이 생겼을 수 있다) | platform | false |
  | `internal_error`(종료 코드 1, `after_commit`) | platform | false |

- **멱등.** 멱등하지 않다. 결과를 모르거나 `head_changed`·`after_commit`이 오면 다시 부르지 않고 `git reflog -n 5`, `git log -1 --stat`, `git status`로 확인한다. 확정할 수 없으면 결과 불명으로 두고 사람에게 알린다.
- **정책.** 플랫폼 정책 칸이 없다. 엔진의 셸 도구 판정을 엔진 `git commit`과 똑같이 지난다.
- **엔진 `git commit`도 그대로 허용한다.** 귀속의 보장은 hook(PR 2), 턴 끝 자동 복구(D5, PR 3), push 직전 검증(PR 3)이다. T4가 더하는 것은 메시지 틀, 경로 검사, Git 대상 환경 정리, 구조화 결과다.
- **모델이 아는 길.** 플랫폼 지시 조각 한 줄("commit할 때 `werft-commit`을 쓸 수 있다. 형식은 `werft-commit --help`"). 조각은 실행 fingerprint에 들어가므로 세션 `platform_tools` revision과 설치 설정 `PLATFORM_TOOLS_REVISION`(기본 0)으로 세션마다 고정한다. 모든 control-host replica와 worker 이미지가 L10 이상이 된 뒤에 켠다.

### 5.5 T5 push `request_push`

카탈로그 5.5절(입력·결과 스키마, `get_push_request`).

| 항목 | 내용 |
|---|---|
| 입력 | `repository_id?`, `branch?`, `source_ref?`(작업공간의 로컬 브랜치 짧은 이름). strict. `AGENT_ACTION_FLOWS`가 꺼져 있으면 `source_ref`는 `source_ref_unsupported` |
| 플랫폼이 정하는 것 | 대상 브랜치 `agent/<session-id>[-<branch>]`, 고정 commit(`source_ref`가 있으면 그 브랜치의 commit, 없으면 이 턴 끝 checkpoint의 HEAD), 승인 방식, 실행 시점(턴 끝) |
| 출력 | `AGENT_ACTION_FLOWS` on: `{ status: "deferred", push_intent_id, waits_for: "turn_end", repository_id, target_branch, pull_request, next }` (`waits_for`는 `reply_end`. `next`는 승인 대기여도 바로 `open_pull_request({ push_intent_id })`를 부르고, 사용자에게는 저장소·승인 대기·PR만 말하라고 알린다; 푸시 뒤 PR을 여는 후속 턴은 없다). off: 지금 결과를 봉투에 넣고 `message`만 뺀다 |
| 멱등 | 같은 턴에서 같은 대상을 다시 부르면 같은 의도. 한 턴에 의도가 둘 이상이 되면 모든 의도가 `source_ref`를 가져야 한다. 모든 의도가 같은 턴 끝 checkpoint를 가리키므로, 이름 없는 의도가 둘이면 같은 commit이 두 번 push되고 이름 없는 하나는 HEAD가 끝난 저장소의 commit을 받기 때문이다(D10). 빠진 쪽이 있으면 새 호출은 `source_ref_required`(`details.target_branch` = `source_ref`가 없는 대상)로 거절하고, 그 대상을 `source_ref`와 함께 다시 부르면 아직 `deferred`인 동안 값이 채워진다. 모델은 저장소마다 로컬 브랜치에 커밋하고 `source_ref`로 각각 요청한다. 같은 대상의 열린 push 요청은 하나(`request_open`). 사람이 거절한 commit의 재요청은 `rejected_before` |
| 정책 | `push.primary`·`push.attached`. `ask`면 T3 push 폼 |

턴 끝 뒤의 결과는 모델이 `get_push_request`(L5, 부류 `repository.read`)로 읽고, 사람에게는 T1 `action_notice`로 나간다.

| 코드 | by | retryable |
|---|---|---|
| `validation_error` | platform | false(`isError`) |
| `no_repository`, `repository_not_allowed`, `github_disabled`, `default_branch`, `target_refused`, `over_workspace_ceiling`, `self_approval` | policy | false |
| `source_ref_unsupported`, `no_running_turn`, `missing_scope`, `unverified_principal`, `not_found`, `session_closed`, `turn_ended_without_checkpoint`, `turn_finalized_without_pin`, `superseded_by_turn`, `source_missing`, `attribution_mismatch`, `uncommitted_changes`, `no_checkpoint`, `checkpoint_moved`, `commit_mismatch`, `catalog_changed`, `already_resolved`, `already_decided`, `unrelated_history`, `github_settings_unsupported`, `no_push_credential` | platform | false |
| `checkpoint_unavailable`, `lease_expired`, `push_failed`, `request_open`, `source_ref_required` | platform | true |
| `rejected_before` | person | false |
| `non_fast_forward`, `github_refused` | github | false |

턴 안에서 바로 push하지 않는다. push는 control-host가 검증된 checkpoint 번들에서 하므로, 턴 중간 push는 checkpoint lease·capture·검증을 턴 안으로 당겨야 한다.

### 5.6 T6 PR 작성 `open_pull_request`

카탈로그 5.6절(입력·결과 스키마).

| 항목 | 내용 |
|---|---|
| 입력 | PR 템플릿 설계의 구조화 필드(`pullRequestContentSchema`)에 `push_request_id`나 `push_intent_id` 가운데 정확히 하나 |
| 플랫폼이 정하는 것 | base(카탈로그 브랜치), head(push 요청의 브랜치), 템플릿(D2), legacy `body`는 다시 배치하지 않음(D4), 꼬리와 `Co-authored-by`, 세션 링크(D3), 엔진 서명 줄 제거, 길이, push가 아직이면 예약 |
| 출력 | `{ status: "scheduled", push_intent_id, push_request_id }` 또는 `{ status: "opened" \| "already_open", number, url, body_source }`. `scheduled`의 두 id는 nullable이다. 의도가 push 요청이 되기 전에는 `push_request_id`가 null, 된 뒤에는 `push_intent_id`가 null이고, 둘 다 null일 수는 없다 |
| 멱등 | push 요청 하나에 PR 행 하나. 다시 부르면 같은 행(`already_open`)이나 같은 예약(`scheduled`) |
| 정책 | `pull_request.write`(`allow`/`deny`) |

| 코드 | by | retryable |
|---|---|---|
| `validation_error` | platform | false(`isError`) |
| `missing_scope`, `unverified_principal`, `not_found`, `catalog_changed`, `no_forge`, `github_settings_unsupported`, `superseded`, `session_closed`, `push_failed` | platform | false |
| `github_disabled`, `over_workspace_ceiling` | policy | false |
| `push_rejected` | person | false |
| `forge_failed` | github | true |
| `github_refused`, `pull_request_closed`, `head_moved`, `closed_unrecorded` | github | false |

MCP에서 `not_pushed`는 flag on(actions 흐름)에서만 나오지 않는다(예약). flag off의 legacy 요청은 push 전이면 예전처럼 `not_pushed`로 거절한다. REST는 이행 기간 동안 기본이 지금처럼 `409 not_pushed`이고, `?schedule=true`일 때만 예약한다.

### 5.7 T7 `git push`: 안내만

카탈로그 5.8절.

- `git push`로 GitHub에 쓰는 길은 열지 않는다. 프록시가 `GET …/info/refs?service=git-receive-pack`에 고정 영어 안내 한 줄("git push does not reach GitHub here. Push and open pull requests with the platform's GitHub tools … or gh pr create …")을 답한다. 응답 방식(`ERR` pkt-line, 안 되면 HTTP 403 `text/plain`)은 L13a가 이미지의 git으로 확인해 하나로 정한다. 안내가 보이지 않으면 L13a는 머지하지 않는다.
- authorizer를 부르지 않고, 다른 경로의 404는 그대로다. `or gh pr create`는 L14가 머지된 뒤에 문구에 더한다.
- receive-pack을 받아 검증하고 push하는 입구는 LATER다([LATER](#later)).

### 5.8 T8 `gh` 입구

카탈로그 5.9절(명령별 문법, 출력, exit 코드, 예약 조회 순서표, `actions` 토큰, dispatcher).

- 이미지의 `/usr/local/bin/gh`를 얇은 shim으로 두고 진짜 `gh`는 다른 경로로 옮긴다. shim은 `gh auth status`, `gh repo list`, `gh repo view`, `gh pr create`, `gh pr view`, `gh pr list`, `gh pr edit`, `gh pr comment` 여덟 명령만 플랫폼 도구로 잇는다(`gh` 2.103.3 문법). 지원 명령에서 문법 밖의 인자는 효과를 내기 전에 `unsupported_flag`로 거절한다. 지원하지 않는 명령(`gh api` 포함)은 진짜 `gh`로 넘기고 종료 코드를 그대로 돌려준다.
- `gh pr create`는 `request_push` 뒤 `open_pull_request({ push_intent_id })`와 같다. 지금 commit을 push하지 않고, 이번 턴이 끝난 결과를 push한 뒤 PR을 연다. exit 0은 **예약 접수**이고, 결과는 `gh pr view <push_intent_id>`와 T1 `action_notice`로 본다. `AGENT_ACTION_FLOWS`가 꺼진 배포에서는 `flows_off`다.
- `--head`는 없거나 `agent/<session-id>[-<접미사>]`여야 한다. fork(`<owner>:<branch>`)나 다른 이름은 `head_not_allowed`, 카탈로그 기본 브랜치가 아닌 `--base`는 `base_not_allowed`다. PR 명령은 이 세션이 연 PR만 대상으로 한다.
- 멱등 키는 턴·저장소·대상 브랜치다. 같은 턴에 MCP `request_push`가 이미 있으면 그 의도를 다시 쓴다.
- `--body`는 T6의 legacy `body`다(D4 `verbatim`). 구조화 필드는 MCP로만 준다.
- 경로는 `POST /actions/github/<tool>`(새 credential 경로)이고 새 용도 `actions`의 대리 토큰을 쓴다. 프록시는 authorizer 확인 뒤 control-host 처리기로만 넘긴다. MCP 처리기의 단계(세션 상태 다시 읽기, 도구 노출, 입력 검사, 서비스 호출, 오류 옮기기)를 `dispatchGitHubTool(session, tool, args, entry)` 하나로 뽑고 두 경로가 같이 부른다.
- 새 코드: `unsupported_flag`(platform, false), `head_not_allowed`·`base_not_allowed`·`github_settings_missing`(policy, false), `flows_off`(platform, false). 거절이면 stderr에 코드와 고정 안내 한 줄, exit 1이다. `gh pr view`의 exit 3은 "결과 불명, 다시 만들지 말 것"이다.
- `gh`는 셸 명령이라 엔진 판정을 늘 지난다. D8의 "엔진 권한 단계에서 뺀다"는 MCP 도구에만 해당한다.

### 5.9 그 밖의 기존 도구

카탈로그 5.7절, 5.7.1절. 이름·입력은 그대로다. 봉투(L1)와 부류(L3)가 붙고, 출력은 지금 응답 스키마를 봉투의 `result`에 넣는다.

| 도구 | 부류 | 멱등 | 더하는 코드 | 바뀌는 것 | 단위 |
|---|---|---|---|---|---|
| `update_pull_request` | `pull_request.write` | 같은 내용이면 같은 본문 | `no_pull_request`(platform, false) | 구조화 필드로 본문 다시 렌더 | PR 4 |
| `comment_pull_request` | `pull_request.write` | 같은 marker는 같은 댓글 | `no_pull_request` | 엔진 서명 줄 제거, `replaced` | PR 4, L1 |
| T9 `close_pull_request`, `reopen_pull_request` | `pull_request.write` | 이미 그 상태면 쓰지 않고 `changed: false` | `pull_request_merged`(platform, false), `no_pull_request`, `forge_failed` | 새 도구(아래 T9) | T9 |
| `submit_review` | `review` | 아님 | `stale_commit`(github, false) | 본문 정리, head 확인 | L6 |
| `dispatch_workflow`, `rerun_workflow` | `workflow` | 아님 | - | 봉투만 | L1 |
| `get_workflow_run` | `workflow` | 읽기 | - | `wait_seconds`, `final` | L7 |
| `list_repositories` | `repository.read` | 읽기 | `github_disabled`(policy, false) | 저장소별 `push` 칸(실제 판정), release 밖 안내 한 줄 | L1, L16 |
| `attach_repository` | `repository.read` | 같은 저장소는 같은 첨부 | `repository_not_allowed`(policy, false) | `wait_seconds`, `final` | L7 |
| `get_push_request` | `repository.read` | 읽기 | `not_found`(platform, false) | 새 도구 | L5 |

**T9 PR 닫기·다시 열기(2026-11-04).** 오너가 "pr 닫는것도 가능하게 해줫으면좋겟어"라고 했다. 4620 세션에서 에이전트가 닫기 요청에 '도구가 없다'고 답한 일이 계기다.

- 입력은 `push_request_id` 하나다. 대상은 `update_pull_request`와 같다. 그 push 요청이 연 PR이고, 없으면 같은 저장소·브랜치에서 이 세션이 연 PR이다. push 요청은 owner와 세션으로 찾으므로 다른 세션이나 다른 에이전트의 PR은 `not_found`다. 다른 에이전트의 키로 이 세션을 부르면 `session.submit`에서 `FORBIDDEN`이다. 열기가 채택한 PR(이 세션의 `agent/<session-id>…` 브랜치에 이미 열려 있던 것)도 대상이다. 그 브랜치에는 플랫폼만 push한다.
- 정책은 `update_pull_request`와 같다. `pushed` 요청에서 `session.submit`이면 되고 사람 승인은 없다. 카탈로그 binding이 바뀐 저장소는 `catalog_changed`, release 목록 밖이나 꺼진 GitHub는 게이트의 `github_refused`(`reason_code`)다. 부류가 들어오면(L3) `pull_request.write` 칸을 따른다. auto mode 규칙은 "이 세션이 연 PR의 닫기·다시 열기"를 허용 줄로 옮겼다.
- 순서: GitHub에서 그 번호의 PR을 읽고(`404`면 `no_pull_request`, 그 밖의 실패는 `forge_failed`), head가 기록과 다르면 `no_pull_request`, 머지됐으면 `pull_request_merged`(`PULL_REQUEST_MERGED`, 409)다. 이미 바라는 상태면 PATCH 없이 `changed: false`로 답한다. 아니면 `PATCH /pulls/{n}`의 `state`로 바꾼다. 응답과 receipt의 `state`는 GitHub가 PATCH에 답한 상태이고, `changed`는 읽은 상태와 다른지다. 같은 브랜치에 다른 PR이 열려 있거나 브랜치가 없어 GitHub가 다시 열기를 거절하면 `forge_failed`다. 따로 코드를 두지 않았다. 422 원인을 확정할 수 없기 때문이다.
- 결과: 성공과 거절 모두 `close_pull_request`·`reopen_pull_request` receipt를 남긴다. 결과는 PR receipt 칸에 `state`·`changed`를 더한 것이다. Slack 승인 카드 요약 줄은 `update_pull_request`와 같이 "PR 닫기"·"PR 다시 열기"와 head를 쓴다. `github_pull_request` 결과(outcome)의 상태는 직접 쓰지 않는다. 상태를 바꾼 호출은 receipt와 같은 트랜잭션에서 그 outcome의 `state_checked_at`·`closed_at`을 비워, outcome refresher가 다음 pass에서 GitHub를 다시 읽게 한다. 상태 전이와 성과 재판정은 refresher가 한다. `closed_at`도 비우는 까닭은 refresher가 30일 넘게 닫혀 있던 PR을 다시 읽지 않기 때문이다. 비우지 않으면 오래 닫혀 있던 PR을 다시 열어도 outcome이 `closed`로 남는다. 같은 UPDATE에서 refresher의 lease도 푼다. 바꾸기 전에 시작한 읽기가 끝나며 옛 상태와 확인 시각을 다시 쓰지 못하게 하려는 것이다(Codex 코드 리뷰 1·2차 지적).
- `agent/*` 브랜치 삭제는 넣지 않는다(LATER). 지우면 다시 열기가 안 되고, GitHub Administration soft_deny 줄이 브랜치 삭제를 막는다. 에이전트 브랜치 정리 정책이 생기면 다시 본다. Codex 반론도 같은 결론이었다.
- `gh pr close`·`gh pr reopen`은 T8(L14)이 같은 서비스로 잇는다.

`list_repositories`는 "어떤 저장소에 접근할 수 있나"의 유일한 답 경로다. 범위는 세션 주 저장소와 release `github.repositories` ∩ 프로필 허용이고, GitHub App 설치가 볼 수 있는 나머지는 이름도 개수도 주지 않는다. `push` 칸은 정책 값이 아니라 지금 push하면 나는 판정이다(스위치 꺼짐, release 밖, 아직 붙지 않은 저장소는 `deny`).

## 6. 행동 부류 정책

카탈로그 3.6절. 판정은 서버 한 곳이다. 내장 MCP 도구 정의는 필수 `class` 칸을 가지고, 부류가 없는 도구는 타입 검사에서 실패하고 `tools/list`에 나오지 않는다(L3).

| 부류 | 도구 | 값 | 기본 | 엔진 권한 단계 |
|---|---|---|---|---|
| `message.thread` | T1 | 고정 `allow`(세션의 자기 스레드에만) | - | 해당 없음 |
| `decision` | T3 | 정책 칸 없음. 답할 수 있는 사람은 `session.approve` | - | 해당 없음 |
| `commit` | T4 | 정책 칸 없음(작업 공간 밖으로 나가지 않는다) | - | 엔진의 셸 도구 판정 그대로 |
| `push.primary` | T5(주 저장소) | `allow` / `ask` | `allow` | 뺀다(D8) |
| `push.attached` | T5(첨부 저장소) | `allow` / `ask` / `deny` | 새 release `allow`, 칸 없는 옛 release `ask`(D6) | 뺀다(D8) |
| `pull_request.write` | T6, `update_pull_request`, `comment_pull_request`, T9 | `allow` / `deny` | `allow` | 뺀다(D8) |
| `repository.read` | `list_repositories`, `attach_repository`, `get_push_request` | 지금 판정 그대로 | - | 뺀다(D8) |
| `review`, `workflow`, `administration` | `submit_review`, workflow 도구 | 지금 판정 그대로 | - | 남긴다 |

> **대체됨(2026-11-09).** 위 표의 `push.primary`·`push.attached` 구분은 현재 규칙이 아니다. push는 모든 저장소에 `push_approval`과 `push_attached` 중 더 엄격한 쪽 하나로 판정한다. 저장된 분류 값은 감사용으로만 읽는다. 현재 규칙은 [API 서버 운영 문서](../../operator/api-server.md)의 "push 규칙: 모든 저장소에 하나"다. 저장소 없는 세션의 workflow·review 거절 `workflow_review_need_session_repository`는 정책 거절(403)이 아니라 `repository_none`과 같은 "빠진 설정" 분류의 409다.

- T8 `gh`는 명령이 부르는 도구의 부류를 그대로 쓴다(`pr create`는 `push.*` + `pull_request.write`, `pr edit`·`pr comment`는 `pull_request.write`, 나머지는 `repository.read`).
- "엔진 권한 단계에서 뺀다"(D8, L2)는 오너가 (a)를 골랐다. L2는 **PR 8이 `uncommitted_changes` 거절을 고른 경우에만** 시작한다. PR 8이 작업 트리 snapshot을 commit으로 받기로 하면 D8을 다시 묻는다. 엔진을 빼면 auto 분류기가 PR 글의 비밀값을 막던 판단을 잃는다. 대신 같은 push에 허용 요청이 두 번 뜨는 일과 첨부 저장소 판정 불일치가 사라진다.

## 7. 호출자 매핑

카탈로그 5.10절. **호출자**는 그 도구 호출이나 commit이 일어난 턴을 보낸 사람이다. 지금은 세션 시작자 한 사람이다(`git-attribution.ts:29`).

| 턴의 출처 | 호출자 |
|---|---|
| Slack 메시지(연결된 Slack 사용자) | 그 플랫폼 사용자 |
| 웹 콘솔 | 로그인한 사용자 |
| 개인 API key | key를 만든 사람 |
| 에이전트 key, operator key, 스케줄 | 없음(App 단독) |
| 플랫폼 턴(이어 턴, push 승인 후속 턴) | 그 턴을 만든 원래 턴의 호출자 |

| 자리 | 계정 연결 있음 | 계정 연결 없음 | 호출자 없음 |
|---|---|---|---|
| commit author·committer | App bot `<slug>[bot]` | 같음 | 같음 |
| commit 트레일러 | `Co-authored-by: <login> <id+login@users.noreply.github.com>` + `Agent-Session` | `Agent-Session`만 | `Agent-Session`만 |
| PR 본문 꼬리 | `- Requested by: <login> (<surface>)`와 `Co-authored-by` | `- Requested by: a person without a linked GitHub account (<surface>)` | `- Requested by: none (App only)` |
| PR 작성자 | App bot | 같음 | 같음 |

- 연결하지 않은 요청자의 이름은 어디에도 넣지 않는다. 공개 저장소 PR에 사람 이름이 남고, 플랫폼 표시 이름은 GitHub에서 아무 계정도 가리키지 않기 때문이다.
- 꼬리는 `<!-- werft:pr-tail -->` 줄부터 `<!-- /werft:pr-tail -->` 줄까지이고 줄은 영어로 쓴다(`pullRequestTail`, `packages/platform/src/sessions/git-attribution.ts`). login 앞에 `@`를 붙이지 않는다. 꼬리가 사람에게 알림을 보내지 않게 하려는 것이다. 위 표의 값이 쓰는 그대로의 문구다.
- `<surface>`는 `Slack`·`web console`·`API key`·`platform`이다. 꼬리의 `Started by` 줄은 그대로 두고 `Requested by` 줄을 더한다. 꼬리 인식은 옛 꼬리와 새 꼬리를 둘 다 플랫폼 꼬리로 읽고, 다시 써도 두 번 붙지 않는다.
- 예약된 PR(L5)은 예약한 턴의 호출자이고, 예약 행에 그 값을 저장한다. 여러 턴의 commit이 든 PR은 commit마다 그 턴의 호출자가 트레일러에 남는다.
- 값이 가는 길: control-host가 턴 입력에 `co_author`와 `requester`를 싣고, worker가 그 턴을 시작할 때 `~/.werft/git-trailers`를 다시 쓴다. claim 하나에서 턴이 여럿 돌기 때문이다. PR 3의 세션별 발급값 기록에 턴마다 낸 값을 더해, 다른 사람 턴의 commit이 "발급되지 않은 공동 작성자"로 막히지 않게 한다. 트레일러는 귀속 표시이고 보안 경계가 아니다.

## 8. Slack 경계와 `pushApprovability`

### Slack 경계

무엇을 할지(행동), 할 수 있는지(판정), 끝났는지(상태)는 카탈로그의 도구와 서비스가 정한다. 그것을 Slack에 어떻게 보일지는 Slack 어댑터(`packages/platform/src/musterrolle/slack-*`)가 정한다. Slack 어댑터는 판정하지 않고 판정 함수를 읽는다. 모델은 카드를 만들지 않는다.

| 것 | 도구·서비스 쪽 | Slack 어댑터 |
|---|---|---|
| 도구 허용 요청(C1) | 엔진 권한 요청을 `ApprovalRequested`로 받는 것까지. D8이 적용되면 push·PR·저장소 읽기 부류는 요청 자체가 없다 | C1 카드, 요약(P1), "이 세션 동안 허용"(P4) |
| 질문(C2·C3) | 엔진 질문 도구의 runtime-core 질문 계약. 질문 도구가 없는 엔진은 `ask_person`(2단계) | 카드, 직접 입력 modal |
| push 승인(C4) | `push.primary`·`push.attached` 판정, `pushApprovability`, 결정 서비스 | 카드, 처리 뒤 줄, 승인 불가 카드(C5e) |
| push·PR 결과 알림 | `action_notice`의 종류와 데이터(push 요청 id, PR 번호·url, 거절 코드) | 문구 렌더(i18n), `slackCardText` escape, 스레드 게시 |
| 오래된 카드 정리(P2) | 요청의 끝 상태 | 정리 drain, `chat.update` |
| 스레드 상태(P3) | 상태 재료(답할 요청, 돌고 있는 턴, 의도·PR 단계) | 상태 계산, `setStatus` |
| 승인 뒤 후속 턴(C5c) | `flow = 'actions'` 요청에는 넣지 않는다. `legacy` 요청은 지금 그대로 | 후속 턴 실패 ephemeral |

- T3 렌더러의 세 규칙: 모델 글은 블록의 plain_text·rich_text에만 넣는다. 최상위 `text`는 `slackCardText` 하나로만 만든다. 렌더러는 판정하지 않는다.
- P1이 만든 카드 빌더의 입력(요약, 표시용 원본, 선택지, 만료, 링크, 로캘)이 T3의 **폼 payload**다. 웹 렌더를 이 타입으로 다시 쓰지는 않는다. 같은 DB 행을 읽으므로 이득이 없다.
- 턴이 끝난 뒤 도는 push·PR 단계(`pinned`·`pushing`·PR `opening`)는 스레드 상태를 `processing`으로 올리지 않고 `active`로 둔다. 진행은 `action_notice`와 웹 "GitHub 작업" 목록이 알린다.

### `pushApprovability`는 push 승인 판정의 정본이다

- push 요청을 지금 승인할 수 있는지는 `pushApprovability` 하나가 판정한다. Slack 카드(C4·C5e), 웹, 결정 서비스가 같은 답을 낸다. 위치는 Slack 카드 설계가 정한 `packages/platform/src/sessions/push-approvability.ts`이고, 기준 커밋에는 아직 없다(P2가 만든다).
- 판정 규칙은 서버의 결정 검사와 같아야 한다. 둘 중 하나를 고치는 PR은 다른 쪽과 테스트를 함께 고친다.
- L4가 `origin = 'intent'` 규칙을 여기에 더한다. 의도로 만든 push 요청은 고정 revision 기준으로 승인할 수 있으므로, 최신 checkpoint가 움직인 것만으로는 승인 불가가 되지 않는다. 고정 revision의 검증이 실패하면 거절 전용 카드가 된다. 그래서 `pushApprovability`는 사유(`checkpoint_moved` | `pinned_source_invalid`)를 돌려주고, 카드는 사유마다 다른 문구 키를 쓴다. `origin = 'direct'` 요청은 지금 규칙 그대로다.

## 9. 어댑터 적합성 항목

`packages/runtime-core`의 어댑터 적합성 테스트에 더한다. 다음 엔진 어댑터도 이것을 통과해야 설치 목록에 들어간다.

1. 엔진 자체의 commit·PR 귀속(서명)이 꺼져 있다(PR 1).
2. `gitEnvironment`가 엔진이 띄운 셸에 command line 수준으로 보인다(PR 2).
3. `platform: true` MCP 서버의 `trusted` 도구는 사람 판단·분류기 없이 실행되고, 나머지 도구는 엔진의 권한 단계를 지난다(L2). allow는 허용 목록 검사, checkpoint admission guard, 도구 시작 기록 **뒤에** 돌려준다. 건너뛰는 것은 권한 판정 하나뿐이고, 허용 목록 밖이면 deny가 이긴다.
4. 엔진의 사람 판단(도구 허용, 질문)은 runtime-core `ApprovalRequested`·`ApprovalAnswer`로만 나온다. 질문 도구가 없는 엔진은 기능 표에 그렇게 적는다.
5. 도구 거부를 엔진에 알릴 때 `ApprovalAnswer.message`를 그대로 쓴다(사람의 사유와 주체를 바꾸지 않는다).

T4·T8은 엔진의 셸 도구로 돌기 때문에 어댑터 계약이 따로 없다. 엔진이 셸 명령에 거는 판정을 그대로 받는다.

## 10. 오너 결정 D1~D11

카탈로그 7.1절. D1~D5와 작성자 방향은 확정된 계약이고, 그 도구의 명세로 옮겼다. D6~D11은 "플랫폼이 흐름을 대신 처리한다"는 틀에서 물은 것이라 도구 관점에서 다시 분류했다.

| # | 질문 | 판정 | 도구의 기본 동작 |
|---|---|---|---|
| D1 | commit의 `Co-Authored-By: Claude` | 확정 (a) | T4·commit hook·턴 끝 복구가 엔진 co-author 줄을 지우고, push 직전 검증이 남은 줄을 거절한다 |
| D2 | PR 템플릿이 여럿일 때 | 확정 (a) | T6: 설정이 고른 것, 설정이 없으면 플랫폼 기본 틀 |
| D3 | 세션 링크 | 확정 (b) | 워크스페이스 설정 `session_link: url \| id`, 기본 url. 모든 경로가 같은 값 |
| D4 | legacy `body` | 확정 (a) | T6·T8: 저장소 템플릿에 다시 배치하지 않는다(`verbatim`). 정리·서명 줄 제거·꼬리는 적용 |
| D5 | 귀속이 틀린 commit | 확정 (a) | T5: 턴 끝에 자동 복구, 못 고치면 `attribution_mismatch`. T4 commit도 같은 검증 |
| 작성자 | PR·commit 작성자 | 확정 | App bot. 요청한 사람은 `Co-authored-by`([7절](#7-호출자-매핑)) |
| D6 | 첨부 저장소 push에 사람 승인 | 도구 기본값. 뒤에 push 규칙 하나로 바뀌었다(아래) | T5 `push.attached`: 새 release `allow`, 칸 없는 옛 release `ask`. 대상은 release 목록 안 저장소의 `agent/<session-id>…` 브랜치뿐이고 force push 금지와 워크스페이스 상한은 그대로다. 첨부와 쓰기가 모두 사람 없이 열린다. **대체됨:** 지금은 모든 저장소(주 저장소 포함)에 에이전트의 push 승인과 첨부 저장소 push 정책 중 더 엄격한 쪽 하나가 적용된다. 정책이 `deny`면 거절하고, 그 밖에 둘 중 하나라도 `ask`면 사람 승인이다. "첨부 저장소는 기본 `allow`라 사람 없이 간다"는 이 행의 옛 규칙이다 |
| D7 | push 뒤 PR 자동 생성 | 폐기 | PR은 모델이 `open_pull_request`(또는 `gh pr create`)를 부를 때만 열린다 |
| D8 | push·PR·저장소 읽기를 엔진 권한 단계에서 빼기 | (a) 유지, PR 8 조건 | [6절](#6-행동-부류-정책) |
| D9 | 레이어 이름 | 폐기 | 이름은 "도구 카탈로그". 그 뒤의 control-host 모듈 이름 action-broker는 레이어 이름이 아니다([1절](#1-위치와-이름)) |
| D10 | 한 턴에 PR 여러 개 | 개정 | 처음에는 `request_push`의 소스가 턴 끝 HEAD 하나였다. 붙인 저장소는 한 git 저장소의 remote이고 checkpoint는 HEAD 하나(`workspace.gitCommit`)만 담아서, 저장소 둘째부터는 사용자에게 다음 입력을 요청하게 됐다. 바뀐 것: checkpoint가 로컬 브랜치를 모두(최대 16개) 담고 `request_push`가 `source_ref`로 브랜치를 고른다. 한 턴에 저장소마다 push와 PR이 끝난다. 남은 묶음을 플랫폼이 다음 턴으로 이어가는 안(F4)은 그대로 만들지 않는다: 이어 갈 브랜치의 commit이 checkpoint에 없으면 복구할 수 없고, 마지막 HEAD만 저장하면 첫 요청도 잘못된 HEAD를 받는다 |
| D11 | commit bot과 PR bot이 같은가 | 도구 기본값 | commit identity의 App은 주 저장소의 고정 연결 App이다(PR 2). 주 저장소가 콘솔에 등록한 App으로 연결되고, bot 조회가 성공하고, 연결이 바뀌지 않았을 때만 PR을 여는 App과 같은 bot이다. 예외: 첨부 저장소의 다른 App, `Werft` fallback, 연결 변경, PAT 연결 저장소, 이미 열린 PR을 이어 쓸 때. 개정(PR 0): 이전 결정은 PR 템플릿 설계 4.1절의 "App 선택은 지금 그대로"(이미 고정된 App만 따르고 없으면 `Werft`)였다. 바뀐 이유: commit과 PR의 bot이 갈라지지 않게 하려는 것이다. 주 저장소가 콘솔에 등록한 App으로 연결돼 있고 작성용 고정이 없으면, claim이 PR 경로와 같은 resolver로 App을 정해 고정을 남긴다. 닿는 작성용 연결이 정확히 하나일 때만이고, `ambiguous_app`·닿는 연결 없음·조회 실패면 고정하지 않는다. 출처는 `pinned_by = 'claim'`(`first_mint`가 아니다)이고, 같은 트랜잭션에서 감사 receipt `pinned_at_claim`(operation `set_repository_github_app`, actor null)을 쓴다. 고정을 만들지 못해도 claim은 막히지 않고 `Werft`로 계속 발급한다([github-agent 결정 11](github-agent.md#claim이-남기는-고정)) |

## 11. 도구 위에 얹는 것

카탈로그 6절.

| # | 것 | 판단 |
|---|---|---|
| F1 | push가 끝나면 PR 호출 없이 PR을 연다 | 만들지 않는다(D7) |
| F4 | 한 요청의 남은 PR 묶음을 플랫폼이 다음 턴으로 이어서 | 만들지 않는다(D10). 한 턴 안에서 `source_ref`로 끝낸다 |
| F2 | 이어 턴(`push_continuations`)과 Slack 승인 후속 턴 | 호환 경로. push 요청 행은 만들 때의 흐름 `flow`(`legacy` \| `actions`)를 적고, 이어 턴과 후속 턴은 `flow = 'legacy'` 요청에만 생긴다. `AGENT_ACTION_FLOWS`가 off인 동안 만든 직접 요청만 `legacy`다. 의도에서 바뀐 요청(`origin = 'intent'`)은 늘 `actions`이고, 이미 만든 요청은 설정을 바꿔도 동작이 바뀌지 않는다. 모든 배포에서 설정을 켜고 남은 `legacy` 요청이 0이 된 뒤 후속 PR이 지운다 |
| F3 | `request_push({ pull_request })` 한 번으로 push와 PR 예약 | 선택 복합 호출(L12). L12 전 replica는 strict 입력이라 이 칸을 `validation_error`로 거절한다. 그래서 설치 설정 `AGENT_ACTION_PR_IN_PUSH`(기본 off)는 모든 replica가 L12 이상일 때만 켜고, 꺼져 있으면 이 칸은 `validation_error`다. 켜져 있어도 PR 도구가 `trusted`가 아닌 세션은 `pull_request_needs_tool_call`(platform, false, 부작용 없음)이다 |
| F5 | 지연 완료 결과를 사람에게(`action_notice`) | 모델이 부른 push·PR 호출에 딸린 고정 알림. 바깥 효과를 새로 만들지 않는다 |

> **갱신(2026-11-09).** 이 절과 아래 표에서 말하는 `AGENT_ACTION_FLOWS`와 `SESSION_PROMPT_REVISION`은 없어졌다. 턴 안의 `request_push`는 언제나 의도(intent) 흐름이고, 턴 밖에서 부르면 `no_running_turn`으로 거절한다. 이어 턴(`push_continuations`)은 더 만들지 않으며, 엔진에 가는 프롬프트·도구 설명·응답·후속 턴 메시지에는 사실만 적는다. 아래는 당시 결정의 기록이다.

`AGENT_ACTION_FLOWS`는 "자동 흐름"을 켜는 설정이 아니라 T5·T6의 **지연 완료 계약**(턴 안 `request_push`의 의도, PR 예약)을 켜는 배포 장벽이다. 모든 replica가 L5 이상일 때 켠다. 이 설정은 새 직접 호출의 경로만 고르고, 이미 만든 요청은 행의 `flow`를 따른다.

## 12. 앞선 결정과의 차이

카탈로그 0절, 9.3절.

| 앞선 결정 | 바뀌는 것 | 고치는 단위 |
|---|---|---|
| [github-agent.md](github-agent.md) "입구는 둘(세션 API, 내장 MCP)" | `gh`가 같은 서비스의 셋째 입구가 된다. 서비스 한 곳은 그대로다 | L14 |
| [github-agent.md 결정 6](github-agent.md#결정-6-push-전-사람-승인)의 이어 턴 | `AGENT_ACTION_FLOWS` on에서는 턴 안 `request_push`가 의도가 되고 이어 턴이 없다. 이어 턴과 승인 후속 턴은 행의 `flow`가 `legacy`인 요청(설정 off 동안 만든 직접 요청)에만 남는다 | L4, L5 |
| github-agent.md 결정 6 "정책 승인은 세션의 주 저장소에만" | D6은 첨부 저장소 push도 새 release는 기본 `allow`라고 했으나 지금은 대체됐다: 모든 저장소에 push 승인과 첨부 저장소 push 정책 중 더 엄격한 쪽 하나가 적용된다 | L3 |
| [github-agent.md 결정 5](github-agent.md#결정-5-co-authored-by) "Co-authored-by = 세션 시작자" | 그 턴을 요청한 사람으로. 미연결 안내 문구도 "연결하지 않은 요청자의 commit에는…"으로 | L15 |
| `gh` 경로 차단(JeongJaeSoon/agent-platform#1113, `apps/worker/Dockerfile:135-137`) | 진짜 `gh`는 그대로 로그인이 없다. shim의 여덟 명령만 플랫폼 도구로 간다 | L14 |
| auto 분류기 allow 규칙이 첨부 저장소 쓰기를 뺌(`packages/adapters/runtimes/claude/src/auto-mode.ts:13`, `:15`) | D6(지금은 push 규칙 하나로 대체됐다)과 이미 어긋나 있다. `gh` 문구를 고칠 때 지금의 push 규칙에 맞춘다 | L14 |
| 행동 레이어 설계의 "commit은 도구가 아니다", PR 템플릿 설계의 A안(commit 도구) 기각 | hook·턴 끝 복구·push 직전 검증(B안)을 보장으로 유지하고, 고를 수 있는 고정 commit wrapper T4를 더한다. 엔진 `git commit`도 그대로 허용한다. 기각 이유("엔진의 `git commit` 습관을 막으려면 프롬프트가 필요하다")는 막지 않으므로 성립하지 않는다 | L10 |
| 행동 레이어 설계의 "push 뒤 PR까지 플랫폼이 직접 하는 흐름" | 중심은 도구 카탈로그. 플랫폼은 모델이 부른 호출을 늦게 끝낼 뿐이다 | L4, L5 |

## 13. 구현 단위와 순서

카탈로그 7.2~7.5절이 단위별 범위·의존·같은 파일 쌍을 가진다. 순서(머지 기준)만 적는다.

| 묶음 | 시작 조건 | 단위 |
|---|---|---|
| A | 없음 | L0(이 문서), PR 0, P1, P3, T2-a, L13a |
| B | PR 0 / L0 / P1 머지 | PR 1·2·5 / L1·L3 / P2·P4 |
| C | PR 0·L0 / PR 2 / L1 / PR 2·L1 머지 | PR 4 / PR 3 / L6·L7·L16 / L10 |
| D | L1·L3·(P2 또는 P3) / PR 4 / PR 3 머지 | L4 / PR 6 / PR 8 |
| E | L4·PR 4·P1 / PR 5·6 / L0·L3·P4·PR 8 머지 | L5 / PR 7 / L2 |
| F | L2·L5 / 각 조건 / L5·L16·PR 4 / L5·PR 3·PR 5 머지 | L12 / L4b·L8·L9·L11(2단계) / L14 / L15 |

L0 머지 전에는 L1~L16 가운데 L13a만 시작한다. L13a는 프록시의 receive-pack 분기와 그 테스트만 고치고 이 문서의 계약에 기대지 않는다. T2-a도 L0을 기다리지 않는다.

## 14. 책임 경계 추적표

설계 기록 `ap-action-layer-20261103/design.md` 5절 "경계: 29개 행동의 분류"(126–166행)를 이 문서의 계약에 대응시킨 표다. 29개는 도구 수가 아니라 **행동의 책임 경계 목록**이다. 원래 분류는 레이어 10개, 흐름 7개, 엔진 12개다. [6절](#6-행동-부류-정책)의 행동 부류 표는 "어떤 판정을 서버가 하는가"를 답하고, 이 표는 "그 행동의 책임이 모델·플랫폼·엔진 가운데 어디에 있고 지금 어떤 상태인가"를 답한다. 두 표는 서로를 대신하지 않는다.

- 기준 커밋: `origin/main` `355140707`. 아래 `파일:줄`은 이 커밋에서 직접 읽은 것이다. 위의 다른 절이 쓰는 기준 커밋(`777c78db2`)과 다른 것은 그 뒤에 L1·L3·L2·L4·L5·L6·L7이 머지됐기 때문이다.
- 설계 기록의 분류(레이어·흐름·엔진)는 복원하지 않고 "설계 분류" 칸에 그대로 적는다. 책임이 어디로 가는지는 이 문서의 계약이 정한다. 둘이 다르면 이 문서가 맞다.
- **상태** 칸은 넷 중 하나다.
  - **현재 계약**: 이 문서의 어느 절이, 어느 도구와 코드 경로가 맡는지 적는다.
  - **제외**: 이 문서나 설계가 도구·계약으로 만들지 않기로 한 것과 그 근거.
  - **후속**: 아직 main에 없고, 카탈로그의 단위(L 번호, 2단계)나 이 문서의 절이 맡는다.
  - **근거 없음**: main 코드와 문서에서 대응을 찾지 못했다. 추측하지 않고 표 아래에 따로 모은다.

### 14.1 표

설계 분류의 약어는 레이어 = L, 흐름 = F, 엔진 = E다.

| # | 행동 | 설계 분류 | 상태 | 지금의 대응 |
|---|---|---|---|---|
| G1 | PR 본문 형식·템플릿 | L | 현재 계약 | T6([5.6](#56-t6-pr-작성-open_pull_request)). 구조화 필드를 템플릿에 채운다: `renderPullRequestBody`(`packages/platform/src/sessions/pull-request-body.ts:249`), `fillTemplate`(`pull-request-template.ts:600`). 꼬리·`Co-authored-by`는 [7절](#7-호출자-매핑) |
| G2 | PR 제목 형식·언어 | L(언어는 E) | 현재 계약 | 한 줄·256자·redact는 `cleanTitle`(`pull-request-text.ts:107`, 상한 `:7`). 비었을 때 기본값 `Agent session <id>`는 `pull-request-service.ts:557`, `:866`. 제목 언어는 모델 글이라 바꾸지 않는다 |
| G3 | 엔진 서명 | E(어댑터가 끔) | 현재 계약 | [9절](#9-어댑터-적합성-항목) 1번. `ENGINE_ATTRIBUTION_OFF`(`packages/adapters/runtimes/claude/src/runtime.ts:38`, 적용 `:280`)와 적합성 시험(`packages/runtime-core/src/testing/adapter-conformance.ts:63`). 렌더러 쪽 안전망은 `stripEngineSignatures`(`pull-request-text.ts:46`) |
| G4 | commit 메시지 | E | 현재 계약 + 후속 | 메시지는 엔진에 둔다. hook이 메시지의 엔진 co-author 줄을 지우고 trailer를 더한다(`apps/worker/git-hooks/werft-hook:38-40`, `werft-trailers.sh:79-80`). author는 셸 환경으로 정하고(`gitEnvironmentFor`, `apps/worker/src/git-trailers.ts:85-100`) 이미 만든 commit의 author는 별도 복구 경로가 고친다(`apps/worker/git-hooks/werft-repair-attribution:14-16`). 고를 수 있는 wrapper T4 `werft-commit`([5.4](#54-t4-git-commit-werft-commit))은 main에 없다 → 후속 L10 |
| G5 | commit 시점과 push 브랜치 준비 | F | 현재 계약 | T5([5.5](#55-t5-push-request_push)). 턴 안 `request_push`가 의도를 만들고 `deferred`/`waits_for: "turn_end"`를 돌려준다(`packages/platform/src/sessions/github-mcp-server.ts:378-447`). 턴 끝 checkpoint를 고정한다. 모델 안내 문구는 [11절](#11-도구-위에-얹는-것) F2 |
| G6 | push 미뤄짐 처리(이어 턴) | F | 현재 계약 + 후속 | `AGENT_ACTION_FLOWS` on이면 이어 턴이 없다([12절](#12-앞선-결정과의-차이) 둘째 줄). `flow = 'legacy'` 요청에만 이어 턴이 남는다(`github-mcp-server.ts:464-470`, `packages/db/src/push-continuations.ts:6`). 지우는 일은 [11절](#11-도구-위에-얹는-것) F2의 후속 PR |
| G7 | push 뒤 PR 열기 | F | 현재 계약(D7로 바뀜) | 플랫폼이 스스로 열지 않는다. 모델이 `open_pull_request({ push_intent_id })`를 부르면(`gh pr create`는 후속 L14다. 이미지의 `gh`는 지금 자격 없는 원본이다, `apps/worker/Dockerfile:149-152`) 예약하고, push가 끝나면 PR drain이 연다(`packages/platform/src/sessions/pull-request-drain.ts`, [5.6](#56-t6-pr-작성-open_pull_request)). 설계 원문의 "push가 끝나면 PR을 연다"는 [10절](#10-오너-결정-d1d11) D7(폐기)로 대체됐다. `slackPushFollowUp`(`packages/platform/src/musterrolle/slack-interactions.ts:71`)은 `legacy` 요청에만 남는다 |
| G8 | PR 개수(브랜치 분할) | L | 현재 계약 | 한 턴에 의도가 여럿일 수 있다. 의도가 둘 이상이면 각자 `source_ref`가 있어야 하고 없으면 `source_ref_required`다(`packages/db/src/push-intents.ts`의 `createDeferred`). 브랜치의 commit은 pin된 revision의 매니페스트(`workspace.sources`)에서 고른다. [10절](#10-오너-결정-d1d11) D10 |
| G9 | PR 리뷰 | L | 현재 계약 | `submit_review`(`review` 부류). 본문은 `cleanBody`로 정리하고 `commit_id`가 PR head가 아니면 `stale_commit`이다(`packages/platform/src/sessions/github-work-service.ts:357-387`). [5.9](#59-그-밖의-기존-도구)의 L6 |
| G10 | workflow 입력·재실행·결과 확인 | L | 현재 계약 | `dispatch_workflow`·`rerun_workflow`·`get_workflow_run`(`workflow` 부류). `wait_seconds`와 `final`은 `packages/contracts/src/api/github-mcp.ts:151`, `:457`. [5.9](#59-그-밖의-기존-도구)의 L7 |
| G11 | GitHub 행동 허용 판단 | L(정책) | 현재 계약 | [6절](#6-행동-부류-정책). 부류 값과 도구별 부류는 `ACTION_CLASS_VALUES`·`GITHUB_MCP_TOOL_CLASSES`(`github-mcp.ts:329`, `:343`). 부류가 없는 도구는 노출되지 않는다 |
| G12 | PR 댓글 | L | 현재 계약 + 후속 | 같은 marker의 댓글을 갱신한다(`comment_pull_request`, `pull-request-service.ts:1117-1170`). 결과의 `replaced` 칸은 main의 응답 스키마(`packages/contracts/src/api/pull-request.ts:274`)에 없다 → [5.9](#59-그-밖의-기존-도구) 표의 "PR 4, L1" 항목 |
| G13 | push 거절 뒤 재요청·거절 답 | F | 현재 계약 + 후속 | 같은 commit의 재요청은 `rejected_before`(`packages/db/src/push-intents.ts:345`, `packages/contracts/src/api/push-request.ts:100`). 거절 알림은 Slack 카드의 처리 뒤 한 줄이다([8절](#8-slack-경계와-pushapprovability)). 거절 문장을 모델 세션에 넣는 `slackPushFollowUp`(`slack-interactions.ts:71-78`, 호출 `:493`)은 `legacy` 요청에만 남는다 → F2의 후속 PR |
| S2 | 질문과 선택지 | E(어댑터가 옮김) | 현재 계약 + 후속 | 엔진 질문은 runtime-core `ApprovalRequested{kind:"question"}`으로 나온다(`packages/runtime-core/src/approval.ts:39`). [5.3](#53-t3-의사결정-폼), [9절](#9-어댑터-적합성-항목) 4번. 질문 도구가 없는 엔진의 `ask_person`은 후속 L9(2단계) |
| S3 | 도구 허용 요청이 오는지·카드 | E(push·PR 도구는 뺌) | 현재 계약 | [6절](#6-행동-부류-정책)의 "엔진 권한 단계" 열과 [9절](#9-어댑터-적합성-항목) 3번. push·PR·저장소 읽기 도구는 `trusted`로 엔진이 묻지 않는다(L2, `apps/worker/src/gateway-client.ts`, `packages/runtime-core/src/agent-runtime.ts:111`). 리뷰·workflow 도구는 엔진이 묻는다 |
| S4 | 승인 요청 문구·상태 설명 | F | 현재 계약 | [8절](#8-slack-경계와-pushapprovability). 카드는 Slack 어댑터가 그린다(`slack-prompts.ts`), 스레드 상태는 `slackSessionStatus`(`packages/platform/src/musterrolle/slack-session-status.ts:58`), push·PR 결과 알림은 `action_notice`(`packages/platform/src/musterrolle/action-notice.ts:5-12`), 승인 판정은 `pushApprovability`(`packages/platform/src/sessions/push-approvability.ts`) |
| S5 | 답의 언어·내부 정보 | E | 현재 계약(부분) | 모델에게 "이렇게 말하라"를 쓰지 않는다는 [2절](#2-원칙) 5번과 [4절](#4-결과-봉투와-공통-규칙)의 봉투가 대응한다. 답 본문은 도구로 감쌀 수 없어 엔진에 둔다. 다만 `request_push`의 `next` 영어 한 줄(`github-mcp-server.ts:451`)과 `legacy` 안내문(`push-continuations.ts:6`, `slack-interactions.ts:76-77`)은 아직 모델에게 영어 문장을 준다 → F2의 후속 PR |
| A1 | 성과 의미 판정(Luna) | F(이미 엔진 밖) | 현재 계약 | 판정 모델이 엔진 밖에서 돈다: `createAchievementJudge`(`packages/platform/src/sessions/achievements/achievement-judge.ts:186`), 규칙 `achievement-rules.ts`, 정의는 `docs/contributing/decisions/achievement-rules.md`. 이 레이어는 판정을 바꾸지 않는다. 설계 원문이 판정기 연결과 재판정 범위를 별도 티켓 둘에 두었다(원문 인용, 이 표는 그 티켓의 상태를 확인하지 않았다) |
| A2 | 성과 근거의 자기 보고 | L(2단계) | 후속 | `declare_deliverable`은 main에 없다(코드·문서 전체에서 찾지 못했다). 카탈로그 7.2절이 **L8**(2단계, 선행은 판정기 연결 티켓)로 둔다. 설계 10.6절은 "판정기 연결 뒤에 만든다. 그 전에는 판정이 늘 `skipped`라 이득이 없다"며 만들기를 미룬다. 근거 등급은 `achievement-rules.md` 0절 그대로다. 이 도구가 생기기 전까지 모델이 넘기는 결과물 목록은 계약에 없다 |
| A3 | 결과물 위치(`out/`) | L(2단계) | 현재 계약 + 후속 | 지금은 `out/` 규칙이 맞다: 저장소 없는 세션의 안내 `OUT_DIRECTORY_PROMPT`(`apps/worker/src/composition.ts:265`), 색인 `apps/worker/src/workspace-outputs.ts`, 판정 쪽 목록 `achievement-judge.ts:311`. `declare_deliverable`(L8)이 대신할 수 있으나 호환을 위해 `out/` 안내는 남긴다(설계 5절 A3) |
| E1 | 엔진 기본 동작 그대로 씀 | E(어댑터가 끔) | 현재 계약 | G3과 같다. 끌 것의 목록은 서명 하나다([9절](#9-어댑터-적합성-항목) 1번) |
| E2 | 관리자 지시·저장소 `CLAUDE.md` | E | 현재 계약 | 형식·정책을 이 경로에 두지 않는다. worker가 저장소 루트의 `AGENTS.md`(없으면 `CLAUDE.md`)를 git 객체에서 읽어 세션 지시의 정본으로 쓴다(`apps/worker/src/workspace.ts:851`, `apps/worker/src/instruction-files.ts`) |
| E3 | 메모리 읽기 안내 | E | 현재 계약 | Claude 어댑터 안의 안내다: `MEMORY_READ_GUIDANCE`(`packages/adapters/runtimes/claude/src/memory-read.ts:11`), 적용 `runtime.ts:128`. 플랫폼 계약이 아니다 |
| E4 | 첨부 저장소 지시 파일 무시 | E | 현재 계약(문서 근거) | 사용자 문서가 "붙인 저장소의 CLAUDE.md는 지시문으로 읽지 않는다"고 적는다(`apps/docs/content/docs/integrations/github.mdx:124`, 영어·일본어판 같음). 설계가 근거로 든 문장(`github-mcp-server.ts:120`)은 main의 서버·계약 설명에 없고, worker는 주 저장소 루트의 지시 파일만 읽는다(E2). 첨부 저장소는 remote ref로만 fetch한다(`github-mcp.ts:463`) |
| E5 | 멈춘 턴 뒤 허용된 호출 다시 하기 | E | 현재 계약 + 후속 | [6절](#6-행동-부류-정책) 끝줄과 [9절](#9-어댑터-적합성-항목) 3번: L2가 뺀 세 부류는 park되지 않고, 리뷰·workflow는 park될 수 있다. park된 push 의도는 `carryPushIntents`(`packages/db/src/parked-group.ts:354`)가 잇고, 허용된 엔진 호출을 다시 하라는 재개 안내는 `continuationMessage`(같은 파일 `:396`, 허용된 호출을 다시 하라는 문장 `:408`)가 만든다. 이 재개 문구를 구조화하는 일은 main에 없고 카탈로그 단위도 정해지지 않았다. F2의 후속 PR은 push 이어 턴 제거라 이 문구를 다루지 않는다 |
| E6 | 도구 시작 기록 실패 뒤 재시도 | E | 현재 계약 | 어댑터 내부 문구다: `ADMISSION_GUARD_REFUSED`(`runtime.ts:42`, 사용 `:219`). 플랫폼 도구 봉투의 `retryable`과는 별개다 |
| E7 | 세션 제목 | F(이미 엔진 밖) | 현재 계약 | `createSessionTitler`(`packages/platform/src/sessions/session-titler.ts:32`)와 `deriveSessionTitle`(`session-title.ts:13`). 이 레이어의 도구가 아니다 |
| E8 | 첨부 fetch 완료 재조회 | L | 현재 계약 | `attach_repository`의 `wait_seconds`·`final`(`github-mcp.ts:172`, 설명 `:463`). [5.9](#59-그-밖의-기존-도구)의 L7 |
| E9 | 거부·만료·취소 뒤 대응 | E | 현재 계약 + 후속 | 엔진 도구의 거부 사유는 `ApprovalAnswer.message`에서 오지만 그대로 전하지는 않는다. 사람의 거부는 `personDenial`이 사유를 trim하고 `The user denied this request. Their reason: …`으로 감싼다(`packages/adapters/runtimes/claude/src/contract.ts:607`, `:639-643`). 취소는 명시 메시지를 그대로 쓴다(`:616`). [9절](#9-어댑터-적합성-항목) 5번의 "그대로 쓴다"와 구현이 다르므로 그 항목이나 코드 중 하나를 고치는 일이 후속이다. 플랫폼 도구의 거절은 봉투의 `by`([4절](#4-결과-봉투와-공통-규칙)) |

### 14.2 합계

- 설계 분류의 합계는 레이어 10(G1, G2, G8, G9, G10, G11, G12, A2, A3, E8), 흐름 7(G5, G6, G7, G13, S4, A1, E7), 엔진 12(G3, G4, S2, S3, S5, E1~E6, E9)다.
- 상태: 현재 계약만 있는 행 17, 현재 계약에 후속이 딸린 행 9(G4, G6, G8, G12, G13, S2, A3, E5, E9), 후속만 있는 행 1(A2), 현재 계약(부분)·설계와 다르게 대체된 행 2(S5, G7), 근거 없음 0이다. 설계가 E4의 근거로 든 코드 문장은 main에 없고 사용자 문서(`github.mdx:124`)가 같은 규칙을 적는다.
- 이 문서가 추적하던 도구 가운데 표에서 빠져 있던 것은 `declare_deliverable`(A2·A3, L8)뿐이다. `ask_person`(L9)과 `send_message`(L11)는 2단계로 이미 적혀 있다([5절](#5-도구), [LATER](#later)).

### 14.3 도구 밖 행동의 경계

다음 행동은 플랫폼 도구가 아니므로 [6절](#6-행동-부류-정책)에 부류가 없다. 이 절이 책임의 자리만 고정한다.

| 행동 | 책임 | 자리 |
|---|---|---|
| 성과 의미 판정(A1) | 플랫폼이 엔진 밖의 판정 모델을 부른다. 모델은 아무것도 넘기지 않는다 | `achievement-judge.ts`, `achievement-rules.md` |
| 관리자 지시·저장소 지시(E2) | 사람의 글이다. 레이어는 형식·정책을 더하지 않는다 | `instruction-files.ts` |
| 메모리 안내(E3) | Claude 어댑터의 안내다 | `memory-read.ts` |
| 세션 제목(E7) | 플랫폼이 엔진 밖에서 부른다 | `session-titler.ts` |

## 대안

카탈로그 5.4·5.8·5.9절의 "고른 경로".

- **commit 도구를 내장 MCP 도구 → worker 주문으로.** 주문은 엔진 밖에서 돌아 턴 끝 capture의 자손 관측에 들지 않고, MCP 호출 시한과 결과 기록, worker capability와 혼합 버전을 새로 설계해야 한다. 고르지 않았다.
- **commit 도구를 worker 안 stdio MCP 서버로.** runtime-core의 플랫폼 MCP 서버는 remote 서버만 받고, 세션 내내 사는 서버 프로세스가 턴 끝 capture의 자손 관측에 걸린다. 고르지 않았다.
- **프록시가 `api.github.com` 요청에 설치 토큰을 주입.** forward proxy는 TLS를 풀지 않으므로 MITM이나 새 TLS 경로가 필요하고, `gh pr create`는 GraphQL mutation이라 판정하려면 GraphQL을 해석해야 한다. PR 꼬리·요청자 줄·receipt는 결국 서비스가 써야 한다. 고르지 않았다. 대신 쓰기 토큰은 control-host가 쓰고, 프록시는 지금처럼 git fetch에만 읽기 토큰을 붙인다.
- **프록시가 receive-pack에 `push` 토큰을 붙여 GitHub로 그대로 보냄.** 프록시는 pack을 이해하지 않아 fast-forward와 귀속(PR 3)을 볼 수 없다. force push와 귀속이 틀린 commit을 막지 못하면 그 입구에서만 보장이 빠진다. 고르지 않았다.
- **`gh`를 빼거나 그대로 둠.** 모델의 `gh` 습관이 실패로 끝난다. 고르지 않았다.
- **미연결 요청자의 표시 이름을 꼬리에 넣음.** 공개 저장소에 사람 이름이 남고 GitHub 계정을 가리키지 않는다. 고르지 않았다(넣는 워크스페이스 설정은 LATER).

## LATER

- **`git push`를 받아 push하는 입구.** 필요한 것: git 서버 프로토콜(capability, report-status, sideband), thin pack과 지금 pusher가 받는 bundle의 맞춤, 클라이언트 old 값의 비교 교환, PR 3 검증 전체, 턴 안 push가 PR 3 복구의 보호 경계를 깨는 문제, 크기·시간 상한과 lease 상실. 다시 볼 조건: 실제 모델 E2E에서 L13a 안내 뒤에도 모델이 `git push`를 거듭 시도해 PR까지 가지 못하는 비율이 눈에 띌 때.
- **턴 중간 메시지 도구 `send_message`(L11).** 다시 볼 조건: 턴이 끝나기 전에 모델이 사람에게 따로 알려야 하는 사례가 나올 때. 계약(입력, dedupe key, 코드)은 카탈로그 5.1절 끝에 있다.
- **미연결 요청자의 이름을 넣는 워크스페이스 설정.** 다시 볼 조건: 비공개 저장소만 쓰는 워크스페이스가 PR에 요청자 이름을 남겨 달라고 할 때.
- **receipt 이름 불일치.** contracts의 receipt 목록은 `decide_push`, db는 `resolve_push`를 쓴다. 다시 볼 조건: receipt를 이름으로 읽는 화면이나 query를 만들 때.

## Codex 반론

카탈로그 자체는 Codex 리뷰를 r8(도구 카탈로그)과 path r5(실행 경로·`gh` 입구·호출자 매핑)까지 받아 둘 다 마지막 회차 Act-on 0이다. 이 문서(줄인 결정 문서)에 대한 Codex 리뷰는 PR 본문에 적는다.
