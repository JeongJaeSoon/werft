# 결정(설계안): 에이전트가 PR 본문을 읽는 도구와 기존 PR 꼬리 교체의 실제 확인

- 상태: 결정, 구현함. 아래 [정한 것](#정한-것)은 오케스트레이터 결정이고 오너가 사후에 검토한다(2026-11-14). 되돌릴 수 있게 두었다.
- 배경 문서: [에이전트 행동 도구 카탈로그](action-broker.md) 5.6·5.9절, [에이전트 GitHub 설정](github-agent.md)의 "PR 본문 꼬리".
- 기준: 설계안은 `origin/main` `413500ad`에서 썼고, 아래 "문제"와 "제안"의 `파일:줄`은 그 커밋 기준이다. 그 뒤 패키지 구조가 바뀌어 파일이 옮겨졌다. 구현은 `df2524d0c` 위에서 했고, [구현에서 정한 것](#구현에서-정한-것)은 그 커밋의 경로로 적는다.

## 문제

1. **에이전트가 PR 본문을 읽지 못한다.** 내장 `github` MCP 서버의 PR 도구(`packages/contracts/src/api/github-mcp.ts:116` `GITHUB_MCP_TOOL_ARGUMENTS`) 가운데 PR 내용을 돌려주는 도구가 없다.
   - `get_push_request`는 push·PR 단계만 돌려준다(`packages/platform/src/sessions/github-mcp-server.ts:637-647`).
   - `update_pull_request`에 구조화 필드를 주면 본문을 그 필드로 처음부터 다시 쓴다. 빠진 필드는 빈칸이 된다(`github-mcp.ts:479`의 도구 설명).
   - `body`(legacy)를 주면 본문을 그 글로 바꾼다.
   - 그래서 사람이 PR 본문에 더한 글을 에이전트가 보존할 방법이 없다. 고치려는 쪽은 읽지 못한 글을 지우게 된다.
2. **기존 PR 꼬리 교체가 실제 GitHub에서 돈 적이 없다.** 같은 브랜치의 다음 push가 열린 PR을 다시 쓸 때, 플랫폼은 본문의 마지막 꼬리만 새 commit으로 바꾼다. 두 경로가 있다.
   - `opened`: `pull-request-service.ts:691-706`
   - `adopted`: `:884-890`
   - 이 동작은 `withPullRequestTail` 단위 시험(`packages/platform/src/sessions/git-attribution.test.ts`)과 fake forge로만 확인됐다. 실제 GitHub의 본문 정규화(CRLF, 끝 공백, HTML 주석 처리)를 지난 왕복은 확인되지 않았다.

## 제안

### A. 읽기 도구 `get_pull_request`

| 칸 | 내용 |
|---|---|
| 입력 | `push_request_id` (다른 PR 도구와 같은 식별자. 이 세션이 연 PR만 읽는다) |
| 출력 | `number`, `url`, `state`, `title`, `body`, `body_truncated`, `body_sha256`, `head_sha`, `base` |
| `body` | 플랫폼 꼬리(`<!-- werft:pr-tail -->` … `<!-- /werft:pr-tail -->`)를 뺀 사람·에이전트 부분. 길이 상한 64 KiB, 넘으면 앞부분과 `body_truncated: true`. 잘린 응답에는 `body_sha256`을 주지 않는다(null). 그래서 잘린 내용을 바탕으로 한 갱신은 B의 잠금을 지날 수 없다 |
| `body_sha256` | GitHub가 돌려준 본문 전체(꼬리 포함)의 해시. 아래 B의 낙관적 잠금에 쓴다 |
| 권한 | 행동 부류(`GITHUB_MCP_TOOL_CLASSES`, `github-mcp.ts:372`)는 `get_push_request`가 push의 부류를 따르듯 PR의 부류 `pull_request.write`를 따른다. 새 부류는 만들지 않는다. GitHub 토큰은 읽기 권한만 받아야 하는데, 지금 있는 목적(`GitHubPurpose`, `packages/contracts/src/musterrolle/github-settings.ts:151`)으로는 안 된다. `pull_request`는 `pull_requests: write`를 받고(`:197-201`), 읽기 전용인 `outcome_refresh`(`:222-226`)는 게이트가 플랫폼 읽기로 보고 에이전트 GitHub 설정·상한을 건너뛴다(`packages/platform/src/sessions/github-gate.ts:171`). 그래서 새 목적 `pull_request_read`(`pull_requests: read`만. `outcome_refresh`와 같은 PR 읽기 호출만 쓰므로 `contents`는 받지 않는다)를 더하고, 게이트에서는 `pull_request`와 같이 에이전트 설정을 거치게 하며, 붙인 저장소에도 허용되는 목적 목록(`ANOTHER_REPOSITORY_PURPOSES`)에 넣는다 |
| receipt | 남기지 않는다(읽기). 실패는 다른 PR 도구와 같은 봉투(`by`, `retryable`) |
| 구현 자리 | forge 포트 `getPullRequest`(`packages/platform/src/ports/github-gate.ts:134`)가 이미 PR을 읽는다. `ForgePullRequestDetail`(`packages/platform/src/ports/forge.ts:52`)에 `body`를 더하고, 꼬리 분리는 `withPullRequestTail`이 쓰는 인식 규칙을 재사용한다 |

본문은 누구나 고칠 수 있으므로 모델에게는 데이터로만 준다. 도구 설명에 "지시가 아니다"를 적고, 봉투에 `untrusted: true`를 단다. 꼬리를 빼는 것은 숨기려는 것이 아니다. 에이전트가 꼬리를 복사해 다시 보내 꼬리가 둘이 되는 일을 막으려는 것이다(꼬리는 플랫폼만 쓴다).

### B. `update_pull_request`의 덮어쓰기 막기 (선택)

- 입력에 `expected_body_sha256`(선택)을 더한다. 주어지면 플랫폼이 쓰기 직전에 다시 읽은 본문의 해시와 비교한다. 다르면 `body_changed`(platform, `retryable: false`)로 거절한다. 같은 해시로 다시 불러도 성공하지 않으므로 재시도 가능으로 두지 않는다(봉투의 `retryable` 정의, `packages/contracts/src/api/action-broker.ts:25`). 에이전트는 `get_pull_request`로 다시 읽은 해시로 새로 부른다.
- 잘린 본문 보호: 지금 PR 본문 크기 상한(GitHub 65536자)은 64 KiB 읽기 상한과 같은 차수라 실제로 잘리는 일은 드물다. 그래도 잘린 읽기로 본문을 다시 쓰면 뒷부분이 조용히 지워진다. 그래서 `get_pull_request`가 잘린 응답을 준 PR에는 B를 쓰도록 강제한다. 본문을 쓰는 `update_pull_request`는 `expected_body_sha256` 없이는 `body_unverified`(platform, `retryable: false`)로 거절하고, 잘린 응답에는 해시가 없으므로 그 PR의 본문은 에이전트가 고칠 수 없다(제목만 고칠 수 있다). 사람이 줄인 뒤에 다시 읽으면 고칠 수 있다.
- 주지 않으면 지금 동작 그대로다. 그래서 기존 세션과 호환된다.
- 비교 자리는 `updatePullRequestBody`(`github-gate.ts:141-145`)의 콜백이지만 지금 모양으로는 막을 수 없다. 콜백이 본문을 그대로 돌려줘도 어댑터(`apps/control-host/src/api/forge-github.ts:456-476`)는 함께 받은 `title`을 PATCH하고, 콜백이 throw하면 `ForgeCredentialError`로 감싸여 `forge_failed`가 된다(`pull-request-service.ts:1048-1051`). 그래서 포트에 "쓰지 않고 멈춤"을 뜻하는 타입 있는 결과(예: 콜백이 `{ abort: "body_changed" }`를 돌려주면 어떤 PATCH도 보내지 않고 그 결과를 돌려준다)를 더하고, 해시가 다르면 제목 PATCH도 나가지 않는 시험을 둔다.
- GitHub 쪽 조건부 쓰기가 없어 비교와 쓰기 사이의 경쟁은 남는다. 이 한계는 문서에 적는다.

### C. 기존 PR 꼬리 교체의 실제 확인 절차

verify-werft의 GitHub sandbox 절차([github-sandbox.md](../../../.claude/skills/verify-werft/features/github-sandbox.md))에 단계를 더한다.

1. 세션이 commit A를 push하고 PR을 연다.
2. 사람이 GitHub에서 본문 위쪽에 글을 더한다(`gh pr edit --body-file`). CRLF 줄과 HTML 주석 한 줄을 넣는다.
3. 같은 세션이 commit B를 push하고 `open_pull_request`를 다시 부른다.
4. 기대: `gh pr view --json body`에서 꼬리는 하나뿐이고 commit은 `B`다. 위쪽 사람 글은 바이트 그대로이고, 스레드 알림은 "갱신"이다(JeongJaeSoon/werft#1467과 함께).
5. A가 있으면 `get_pull_request`가 2의 사람 글을 꼬리 없이 돌려주는지, B가 있으면 2 뒤에 오래된 해시로 부른 `update_pull_request`가 `body_changed`인지 확인한다.

이 절차는 오너의 sandbox App 키가 필요해 오너 환경에서 돈다.

## 나눠 만들기

| 단위 | 내용 | 확인 |
|---|---|---|
| 1 | C의 절차만 먼저(코드 변경 없음). 지금 main의 꼬리 교체를 실제 GitHub로 확인한다 | sandbox E2E |
| 2 | A: 계약(`GITHUB_MCP_TOOL_ARGUMENTS`·응답 스키마·OpenAPI), MCP 서버, forge `body`, 꼬리 분리, 새 목적 `pull_request_read`(권한표·게이트 경로·붙인 저장소·`GITHUB_PURPOSE_VALUES`를 읽는 receipt 집계) | 단위(게이트가 설정이 꺼진 에이전트를 거절하는지, 토큰 권한이 `pull_requests: read` 하나뿐인지) + fake forge + sandbox |
| 3 | 플랫폼 프롬프트 리비전: 도구 목록과 "읽고 나서 고쳐라" 한 줄 | 프롬프트 골든 시험 |
| 4 | B(선택): 포트의 타입 있는 중단 결과, 어댑터가 중단 때 PATCH를 보내지 않음, `body_changed`·`body_unverified` 거절(둘 다 `retryable: false`) | 단위(해시 불일치 때 제목·본문 PATCH 0건, 잘린 읽기 뒤 본문 갱신 거절) + sandbox |

## 정한 것

오케스트레이터 결정, 오너 사후 검토(2026-11-14). 오너는 이 도구에 "필요하겟네"라고만 답했고, 아래 세 가지에는 따로 답하지 않았다. 그래서 설계안의 추천안으로 정했다.

1. **새 도구 `get_pull_request`를 만든다.** `get_push_request`는 넓히지 않는다. 설명과 권한이 분명하고, push 상태를 볼 때마다 GitHub를 부르지 않는다.
2. **B를 만든다.** `update_pull_request`가 `expected_body_sha256`을 받는다. 읽은 뒤 본문이 바뀌었으면 쓰지 않고 거절한다.
3. **본문 상한은 64 KiB(65536 UTF-8 bytes)다.** 넘으면 앞부분을 주되 `body_truncated: true`와 `body_sha256: null`로 잘렸음을 알린다. 잘린 읽기로는 본문을 고칠 수 없다(B의 `body_unverified`).

## 구현에서 정한 것

설계안을 따르되, 만들면서 아래를 정했다. 경로는 `df2524d0c` 기준이다.

- **한 PR로 만든다.** 단위 2(A)와 4(B)는 같은 해시를 주고받아 따로 머지할 이유가 없다. 단위 1(C)의 sandbox 실측도 같은 PR의 확인으로 돌렸다.
- **단위 3(플랫폼 프롬프트 리비전)은 하지 않는다.** 설계안 뒤에 [JeongJaeSoon/werft#1401](https://github.com/JeongJaeSoon/werft/pull/1401)이 엔진 입력에서 플랫폼 지시문을 걷어냈다. 이제 도구 설명은 사실만 적는다(`packages/contracts/src/action/github-mcp.ts`의 `description` 규칙과 시험). 그래서 "읽고 나서 고쳐라" 대신 `get_pull_request`와 `update_pull_request`의 설명에 해시를 주고받는 사실을 적었다. Claude auto mode의 허용 문구(`packages/adapters/runtimes/claude/src/settings/auto.json`)에도 PR 읽기를 더했다.
- **`get_pull_request`의 응답.**
  - 필드는 설계안 그대로다. `state`는 `open`·`closed`에 더해, 머지된 PR이면 `merged`다.
  - `untrusted: true`는 봉투가 아니라 `result` 안에 있다. 봉투(`actionResultSchema`)는 `ok`와 `result`(또는 `refusal`)만 받는 strict 스키마이기 때문이다.
  - 본문 처리 순서는 꼬리 빼기 → 줄마다 마스킹 → 64 KiB 자르기다. 마스킹은 PR 본문을 쓸 때 쓰는 규칙(`lineRedactor`와 `sanitizeText`)을 그대로 쓴다. 비밀값 모양의 줄과 private key 블록은 `[REDACTED]`가 된다. 제목도 같은 규칙으로 마스킹한다. 자르기는 문자 경계에서 한다.
  - `body_sha256`은 GitHub가 돌려준 본문 전체(꼬리 포함, 마스킹 전)의 SHA-256이다.
  - 꼬리 빼기는 `withPullRequestTail`과 같은 스캔(`withoutPullRequestTail`, `packages/platform/src/sessions/git-attribution.ts`)이다. 꼬리가 없거나 사람이 고친 꼬리면 본문을 그대로 준다.
- **권한.** 새 목적 `pull_request_read`는 `pull_requests: read` 하나만 받는다. 게이트에서는 `pull_request`와 같이 에이전트 스위치, 범위, 상한을 모두 거친다. 붙인 저장소에도 허용한다. 서비스는 `update`와 같은 순서로 판단한다: 세션 공유 권한 → push 요청 → 기록된 PR → (submitter는) `pushed` → 게이트 → GitHub 읽기 → head 비교.
- **receipt.** 읽기는 PR receipt를 남기지 않는다. 권한 거절도 receipt 없이 답한다. 게이트는 지금처럼 새로 발급한 토큰(`mint_github_token`)과 자기가 거절한 요청을 기록한다.
- **B의 판정은 쓰기 직전에 다시 읽은 본문으로 한다.**
  - 포트의 `updatePullRequestBody`는 `edit`이 `null`을 돌려주면 아무 PATCH도 보내지 않는다(제목 포함). 서비스는 그 콜백 안에서 해시를 비교한다.
  - `body_changed`: `expected_body_sha256`이 주어졌는데 다시 읽은 본문의 해시가 다르다. 제목만 고치는 호출도 해시를 주면 비교한다. API 오류 코드는 기존의 `REVISION_CONFLICT`(409)다.
  - `body_unverified`: 본문을 다시 쓰는 호출에 해시가 없는데, 다시 읽은 본문이 `get_pull_request`가 자를 크기다. API 오류 코드는 기존의 `PRECONDITION_REQUIRED`(428)다. 설계안은 "잘린 응답을 준 PR"이라고 했지만, 읽은 적이 있는지를 저장하지 않고 본문 크기로 판정한다. 결과는 같고 상태를 둘 곳이 필요 없다. 그래서 `get_pull_request`를 부르지 않은 세션도 이런 PR의 본문은 해시 없이 다시 쓰지 못한다. 제목만 고치는 것은 된다.
  - 잘린 읽기에는 해시가 없으므로, `body_unverified`가 나는 PR의 본문은 에이전트가 다시 쓸 수 없다. 설계안 B와 같다. 크기는 `get_pull_request`와 같이 꼬리를 빼고 마스킹한 뒤에 잰다. 그래서 긴 비밀값 줄이 `[REDACTED]`로 줄어 64 KiB 안에 들면 그 본문은 통째로 읽히고 해시도 나온다.
  - `body_too_long`: `expected_body_sha256`과 함께 보낸 legacy `body`가 플랫폼이 쓸 수 있는 길이(`maxBodyLength - 2000`자, GitHub는 63536자)를 넘어 잘리게 될 때다. API 오류 코드는 기존의 `PAYLOAD_TOO_LARGE`(413)다. 읽기 상한(64 KiB, UTF-8 bytes)과 쓰기 상한(UTF-16 문자 수)은 단위가 다르다. 그래서 통째로 읽힌 본문을 그대로 돌려보내도 쓰기에서 뒷부분이 잘릴 수 있다. 해시를 준 쓰기는 읽은 글을 고치는 것이므로 자르지 않고 거절한다. 해시 없는 쓰기는 지금처럼 `…(truncated)`를 붙여 자른다. 구조화 필드로 쓰는 본문은 새로 짜는 글이라 이 검사를 하지 않는다. Codex 리뷰가 찾았다.
  - 셋 다 `by: platform`, `retryable: false`이고, `update_pull_request` receipt에 `refusal`로 남는다.
  - 읽은 본문을 그대로 돌려보내도 바뀌는 것이 있다. 쓰기는 에이전트가 보낸 글에 PR 열기와 같은 정리(멘션·닫기 키워드·교차 참조 무력화, `<!--` 무력화)를 한다. 읽기에서 `[REDACTED]`가 된 줄은 그대로 `[REDACTED]`로 쓰인다. 에이전트가 보낸 글은 에이전트의 글로 다룬다는 기존 규칙을 따른 것이다.
  - 비교와 쓰기 사이에 사람이 고치면 막지 못한다. GitHub에 조건부 쓰기가 없기 때문이다. 이 한계는 도구 설명에도 적었다.
- **배포 전 checkpoint의 복원.** claim은 내장 서버의 도구 이름을 `runtime_config.tools`에 하나씩 넣고, Claude checkpoint 지문은 그 목록 전체를 해시한다(`packages/adapters/runtimes/claude/src/profile-fingerprint.ts`). 그래서 도구 하나가 늘면 배포 전에 만든 checkpoint의 지문이 지금 설정과 맞지 않는다. claim의 복원 후보(`restore_runtime_configs`, `packages/platform/src/workers/worker-gateway.ts`의 `restoreRuntimesOf`)에 "`get_pull_request`가 없는 github 서버" 설정을 더했다. 이미 있는 "github 서버가 붙기 전" 후보와 같은 자리다. Codex 리뷰가 찾았다. 앞서 `merge_pull_request`를 더할 때는 이런 후보를 두지 않았다. 그 일은 따로 티켓으로 남겼다.
- **시험.**
  - 서비스(`pull-request-service.test.ts`): 꼬리를 뺀 본문과 해시, 마스킹, 머지 상태, 보이지 않는 세션, 게이트 거절, PR 없음과 다른 head, 64 KiB 경계(정확히 65536 bytes는 통째로, 65537은 잘림, 3바이트 문자는 문자 경계), 해시 일치 쓰기, 해시 불일치 때 PATCH 0건, 해시 없는 긴 본문 거절과 제목만 고치기, 통째로 읽혔지만 쓰기에서 잘릴 본문의 `body_too_long`, 제목과 private key 블록의 마스킹, 4바이트 문자 경계, 따로 계산한 SHA-256과의 비교.
  - claim(`apps/control-host/src/api/github-mcp.test.ts`): 복원 후보에 `get_pull_request`가 없는 설정이 있다.
  - 게이트: `pull_request_read`의 권한이 `pull_requests: read` 하나뿐이다. 스위치를 끄면 `github_disabled`, 범위 밖이면 `repository_not_allowed`다. 붙인 저장소는 허용한다.
  - MCP 서버: 인자 검사, `body_changed` 봉투.
  - 어댑터와 forge 계약: `null` edit는 PATCH 0건, 읽기에 본문이 실린다.
