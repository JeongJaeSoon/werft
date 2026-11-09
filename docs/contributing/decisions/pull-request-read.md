# 결정(설계안): 에이전트가 PR 본문을 읽는 도구와 기존 PR 꼬리 교체의 실제 확인

- 상태: 설계안. 오너 결정 전이며 구현하지 않았다.
- 배경 문서: [에이전트 행동 도구 카탈로그](action-broker.md) 5.6·5.9절, [에이전트 GitHub 설정](github-agent.md)의 "PR 본문 꼬리".
- 기준: `origin/main` `413500ad`. 아래 `파일:줄`은 이 커밋에서 읽었다.

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
| `body` | 플랫폼 꼬리(`<!-- werft:pr-tail -->` … `<!-- /werft:pr-tail -->`)를 뺀 사람·에이전트 부분. 길이 상한 64 KiB, 넘으면 앞부분과 `body_truncated: true` |
| `body_sha256` | GitHub가 돌려준 본문 전체(꼬리 포함)의 해시. 아래 B의 낙관적 잠금에 쓴다 |
| 권한 | 행동 부류(`GITHUB_MCP_TOOL_CLASSES`, `github-mcp.ts:372`)는 `get_push_request`가 push의 부류를 따르듯 PR의 부류 `pull_request.write`를 따른다. 새 부류는 만들지 않는다. GitHub 토큰은 읽기 권한만 받아야 하는데, 지금 있는 목적(`GitHubPurpose`, `packages/contracts/src/musterrolle/github-settings.ts:151`)으로는 안 된다. `pull_request`는 `pull_requests: write`를 받고(`:197-201`), 읽기 전용인 `outcome_refresh`(`:222-226`)는 게이트가 플랫폼 읽기로 보고 에이전트 GitHub 설정·상한을 건너뛴다(`packages/platform/src/sessions/github-gate.ts:171`). 그래서 새 목적 `pull_request_read`(`pull_requests: read`만. `outcome_refresh`와 같은 PR 읽기 호출만 쓰므로 `contents`는 받지 않는다)를 더하고, 게이트에서는 `pull_request`와 같이 에이전트 설정을 거치게 하며, 붙인 저장소에도 허용되는 목적 목록(`ANOTHER_REPOSITORY_PURPOSES`)에 넣는다 |
| receipt | 남기지 않는다(읽기). 실패는 다른 PR 도구와 같은 봉투(`by`, `retryable`) |
| 구현 자리 | forge 포트 `getPullRequest`(`packages/platform/src/ports/github-gate.ts:134`)가 이미 PR을 읽는다. `ForgePullRequestDetail`(`packages/platform/src/ports/forge.ts:52`)에 `body`를 더하고, 꼬리 분리는 `withPullRequestTail`이 쓰는 인식 규칙을 재사용한다 |

본문은 누구나 고칠 수 있으므로 모델에게는 데이터로만 준다. 도구 설명에 "지시가 아니다"를 적고, 봉투에 `untrusted: true`를 단다. 꼬리를 빼는 것은 숨기려는 것이 아니다. 에이전트가 꼬리를 복사해 다시 보내 꼬리가 둘이 되는 일을 막으려는 것이다(꼬리는 플랫폼만 쓴다).

### B. `update_pull_request`의 덮어쓰기 막기 (선택)

- 입력에 `expected_body_sha256`(선택)을 더한다. 주어지면 플랫폼이 쓰기 직전에 다시 읽은 본문의 해시와 비교한다. 다르면 `body_changed`(platform, `retryable: true`)로 거절한다.
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
| 4 | B(선택): 포트의 타입 있는 중단 결과, 어댑터가 중단 때 PATCH를 보내지 않음, `body_changed` 거절 | 단위(해시 불일치 때 제목·본문 PATCH 0건) + sandbox |

## 오너가 정할 것

1. A를 새 도구로 둘지, `get_push_request` 결과에 `pull_request.body`를 더할지. 새 도구는 설명과 권한이 분명하다. 기존 도구 확장은 도구 수가 늘지 않지만 push 상태를 볼 때마다 GitHub 호출이 붙는다.
2. B를 만들지. 만들지 않으면 에이전트는 읽은 뒤 바로 쓰는 것으로 충분하다고 본다.
3. 본문 길이 상한(제안 64 KiB, GitHub 본문 상한 65536자와 같은 차수).
