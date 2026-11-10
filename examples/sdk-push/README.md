# push 승인과 PR

`src/push.ts`는 에이전트가 만든 commit을 저장소로 내보내는 흐름을 돈다. 에이전트 key의 세션이 파일 하나를 commit하고(두 Bash 명령은 세션 작업 공간 안의 파일 쓰기와 로컬 git이라 기본 프로필에서 사전 허용되고, 승인 요청이 오면 승인자가 정확히 일치할 때만 허락한다), 에이전트 key가 push를 요청한다. 승인자는 첫 요청을 거부하고(다시 승인하면 409 `PUSH_REQUEST_RESOLVED`), 새 요청의 고정된 commit을 승인한다. push는 worker가 아니라 플랫폼이 승인 몇 초 뒤에 한다. 샘플은 `waitForPushRequest`로 결과를 기다려 push receipt를 읽고, push된 브랜치로 PR을 열고 코멘트를 단다. 공통 준비는 [SDK 샘플](https://jeongjaesoon.github.io/werft/ko/reference/examples/)에 있다.

## key와 실행

| 환경 변수 | 값 |
| --- | --- |
| `WERFT_API_KEY` | 에이전트 key(`sessions:read`, `sessions:write`, `sessions:control`) |
| `WERFT_AGENT_RELEASE_ID` | 그 에이전트 릴리스의 `sha256:…` ID. 필수 |
| `WERFT_APPROVER_API_KEY` | 같은 workspace의 개인 key(`sessions:read`, `sessions:approve`). 생략하면 `WERFT_API_KEY`로 답하고 결정한다. 그 key가 workspace의 key(개인·에이전트)이면 자기가 시작한 세션이라 403 `self_approval`로 거절되므로, 생략은 operator key에서만 동작한다 |

```sh
bun examples/sdk-push/src/push.ts
```

## 실행 결과

로컬 FAKE 스택의 `sample-app`은 스택 안의 fake-git에 GitHub App(`auth.kind: github_app`)으로 등록돼 있다. 그래서 승인된 push는 `pushed`로 끝나고 PR과 코멘트가 만들어진다. 자격이 없는 저장소의 `failed`(`no_push_credential`)와 push되지 않은 요청의 PR 409 `PUSH_NOT_PUSHED`는 샘플이 예상 결과로 출력하고 종료 코드 0으로 끝난다. 그 밖의 push 실패는 종료 코드 1이다.

```text
session …: created
turn 1: completed
push …: requested, 252d75fc3f29 -> agent/… (checkpoint 0)
push …: rejected, 252d75fc3f29 -> agent/… (checkpoint 0), reason "review the diff first"
approve after the reject: 409 PUSH_REQUEST_RESOLVED
push …: approved, 252d75fc3f29 -> agent/… (checkpoint 0)
push …: pushed, 252d75fc3f29 -> agent/… (checkpoint 0)
push receipt: succeeded, refs/heads/agent/…
push requests: pushed, rejected
get …: pushed
comment before a pull request: 409 PULL_REQUEST_MISSING no_pull_request
pull request: { … number: 1, base: "main", created: true … }
comment: { … marker: "sdk-sample", created: true … }
close: receipt succeeded
```

push 자격이 없는 저장소에서는 `push …: failed`, `push receipt: failed, no_push_credential`이 나오고 PR은 409 `PUSH_NOT_PUSHED`다. GitHub forge가 없는 저장소(GitHub가 아닌 호스트, GHES PAT)에 push된 브랜치면 PR은 403 `FORBIDDEN`(`no_forge`)이다. 이 두 경로는 가짜 API 테스트로만 확인했다.

- 승인은 요청이 고정한 `git_commit`을 그대로 보낸다. 다른 commit이거나 요청 뒤 세션이 새 checkpoint를 남겼으면 409 `CHECKPOINT_MOVED`다. SDK는 그때 다시 읽어 다시 승인하지 않는다. 검토한 commit만 승인한다.
- 한 세션에 열린 요청은 하나다. 거부한 뒤에 새로 요청한다.
- `openPullRequest`·`commentPullRequest`는 API에 Idempotency-Key가 없어 응답을 잃으면 SDK가 다시 보내지 않는다.

`bun test examples/sdk-push`가 가짜 API로 push된 경우(PR과 코멘트), 자격이 없는 경우, 그 밖의 실패(종료 코드 1)를 확인하고, 권한 답·결정·PR 호출이 승인자 key로 가는지 본다.
