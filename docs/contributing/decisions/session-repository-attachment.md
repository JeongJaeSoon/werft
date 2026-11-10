# 결정: 세션은 저장소에 묶이지 않고, 저장소를 붙여 쓴다

- 후속(2026-11-11): 실행 프로필은 통째로 지웠다(migration `0264_remove_profiles`, 기존 데이터는 이전하지 않고 지움). 이 문서의 프로필·상한·롤아웃 언급은 그때의 기록이다. 지금은 에이전트 release가 provider 연결과 카드 모델로 실행 spec(런타임·도구·권한 모드)을 고정하고, 묻기·막기 규칙은 워크스페이스와 에이전트의 실행 규칙(`workspace_engine_settings`, `agent_engine_settings`)이 정한다.
- 상태: 확정. 오너 승인 2026-11-02(원문 "좋은거 같아"). 구현은 이 문서를 계약으로 쓴다.
- 기준 커밋: `origin/main` `d90b26731`. 아래 `파일:줄`은 이 커밋 기준이다.
- 오너 원문(2026-11-01): "세션에 저장소가 연결되어있다는 개념을 없애는건 좋지않으려나 … 여러 agents 들의 동작 방식을 조사해보고 검토해서 반영해올래? 필요하다면 세션 내에서 필요한 세션을 뭔가 바꿔서 clone 한다거나 그런게 필요할거 같기도하네".
- 앞 결정: [session-multi-repository.md](session-multi-repository.md)(#986). 이 문서는 그 결정 1의 "세션이 다룰 수 있는 저장소"를 상한과 사용 범위로 나눈다. 결정 2~5(원격 여러 개, push 대상 선택, PR, 게이트의 저장소 인자)는 그대로 쓴다.

> **후속(2026-11-10).** 아래의 "기본 저장소"는 이 결정을 내릴 당시의 동작이다. 지금은 설정 행이 있는 에이전트의 세션이 저장소 없이 시작하고, 필요한 저장소만 `attach_repository`로 붙인다. 명시한 `repository_id`와 설정 행이 없는 옛 에이전트의 릴리스 저장소만 시작 때 받아 온다. 현재 규칙은 [API 서버 운영 문서](../../operator/api-server.md)의 "새 세션의 시작 저장소"다.

## 요약

- 저장소 개념은 없애지 않는다. 세션이 저장소에 묶이지 않게 한다.
- 세션은 저장소 0개 이상으로 시작하고, 일하는 도중에 저장소를 붙인다.
- 지금의 "세션 저장소"는 **기본 저장소**가 된다. 처음에 받아 오고, push 대상을 생략하면 쓰는 저장소다. 실행·인가의 필수 축이 아니다.
- 붙일 수 있는 범위(**상한**)는 #986 그대로 릴리스 `github.repositories` ∩ 프로필 허용 ∩ 카탈로그다. 세션이 실제로 쓰는 범위는 세션 행의 **부착 목록**이다. 기본 저장소가 아닌 저장소 접근은 모두 "부착 목록 ∩ 지금의 상한"으로 다시 검사받는다.

## 다른 에이전트는 어떻게 하나

2026-11 공개 문서 기준. 자세한 비교와 출처는 오너 확인 보고서에 있다.

| 서비스 | 저장소 없이 시작 | 도중에 붙이기 | 토큰 위치 |
|---|---|---|---|
| Claude Tag(Claude in Slack) | 기본이 0개 | 요청에 이름이 나오면 clone. 채널에 grant된 저장소만([문서](https://claude.com/docs/claude-tag/admins/configure-github.md)) | proxy |
| Claude Code on the web | Projects만 | Projects thread가 필요할 때 붙인다. proxy는 붙은 저장소만 허용([문서](https://code.claude.com/docs/en/cloud-environments)) | proxy |
| Cursor cloud agents | 된다 | 다중 저장소 환경. 도중 추가는 미확인, 저장소마다 PR([문서](https://cursor.com/docs/cloud-agent)) | git만 proxy |
| OpenHands | 된다 | sandbox 안 토큰으로 직접 clone | sandbox 안 |
| GitHub Copilot cloud agent | 질문만 | 작업당 PR 하나 | 밖 |
| ChatGPT Codex cloud | 미확인 | 미확인(environment가 저장소 목록을 갖는다) | proxy(secret) |

흐름은 "저장소는 세션 안에서 붙이는 자원, 붙일 수 있는 범위는 미리 허용한 집합, 토큰은 sandbox 밖"이다. 우리 egress proxy·게이트·릴리스 목록이 이미 이 모양이라, 세션 행의 기본 저장소 의존만 풀면 된다.

## 지금 구조

- 프로필 `repository_mode`(required·optional·none, `packages/contracts/src/api/profiles.ts:15`)가 세션에 기본 저장소가 있는지를 정한다. 저장소 없는 세션은 `git init`한 빈 작업 디렉터리에서 시작하고 checkpoint도 지금처럼 된다(`apps/worker/src/workspace.ts:366-391`).
- claim은 저장소 없는 실행 쌍을 이미 만든다(`packages/platform/src/workers/worker-gateway.ts:696-705`).
- #986의 추가 저장소는 기본 저장소가 있어야 쓴다. 기본 저장소가 없으면 다음이 막는다.
  - 릴리스 `github` 설정: `packages/platform/src/agents/agent-service.ts:144` `repository_none`
  - push 요청: `packages/platform/src/sessions/push-request-service.ts:174` `no_repository`
  - claim의 `additional_repositories`: `worker-gateway.ts:1278-1284`
  - egress 인가: `worker-gateway.ts:1526`
  - worker의 원격 부착: `apps/worker/src/workspace.ts:274`
- #986은 상한 안의 저장소를 claim마다 모두 fetch한다. 세션이 어느 저장소를 실제로 썼는지는 push·PR receipt로만 남는다.

## 결정 1: 저장소 개념은 남기고, 기본 저장소는 선택이다

- 세션의 저장소는 0개 이상이다. 기본 저장소가 있는지는 지금처럼 프로필 `repository_mode`가 정한다.
- 기본 저장소의 의미는 셋뿐이다. ① 세션을 준비할 때 `origin`으로 받는다. ② push 요청에서 `repository_id`를 생략하면 이 저장소다. ③ 프로젝트 지시문(CLAUDE.md)을 이 저장소의 고정 commit에서 읽는다.
- 저장소 개념 자체를 없애고 모든 접근을 도구 호출로 하는 안은 택하지 않는다. 허용·push 승인·PR·receipt가 모두 "이 세션이 어느 저장소를 쓰는가"를 기준으로 하는데, 그 값이 없으면 같은 검사를 도구마다 따로 만들어야 하고 화면과 기록에서 범위가 보이지 않는다.

## 결정 2: 상한과 부착 목록

- **상한**은 #986 결정 1 그대로다. 오너가 릴리스에 고른 목록이고, 쓸 때마다 다시 읽는다. 새 승인 단위는 만들지 않는다.
- **부착 목록**은 세션 행에 둔다(`attached_repository_ids`). 시작할 때 고른 저장소와 도중에 붙인 저장소가 들어간다. 기본 저장소는 들어가지 않는다.
- egress `/repository/<id>`, push, PR은 모두 게이트에서 "기본 저장소이거나, 부착 목록에 있고 지금도 상한 안인가"를 본다. 부착 도구만 검사하면 다른 경로로 우회할 수 있기 때문이다. 어기면 `repository_not_allowed`(403)와 receipt다.
- 세션 안에서 엔진이 받는 git 의존(submodule, git URL 의존성, 사설 Go 모듈, Git LFS 객체)도 같은 허용 집합을 따른다. worker가 엔진 HOME의 git 설정에 기본 저장소와 부착 저장소마다 `https://github.com/<owner>/<repo>` → `/repository/<id>/.git` `insteadOf`를 쓰므로, 이 의존들은 모두 `/repository/<id>/…` 경로로 나가 위의 게이트 판단을 받는다. 따로 허용 목록을 두지 않는다. 부착하지 않은 저장소를 가리키는 submodule·Go 모듈은 `insteadOf`가 없어 proxy가 막고, `/repository/<id>`로 와도 `repository_not_allowed`와 receipt다. 의존 저장소는 시작할 때 붙이거나 도중에 `attach_repository`로 붙인다. NULL 세션은 상한에 넣어 두면 이미 붙은 것이다.
- 성과물 조회(`outcome_refresh`)는 부착 목록을 대지 않고 카탈로그만 본다. 플랫폼이 이미 기록한 PR을 읽는 일이고, 그 PR을 열 때 부착 목록 검사를 지났다.
- 호환: 순서 5 전에 목록을 생략해서 만든 행은 NULL이다. NULL은 #986 동작(상한 전체를 붙인 것으로 본다)이다. 순서 5부터 생략해서 만든 세션은 `[]`다. 릴리스가 없거나 `none` 프로필이라 붙일 수 없는 세션은 그대로 NULL이다. `[]`는 처음엔 아무것도 붙이지 않은 것, `[a, b]`는 a·b만 붙인 것이다. 어느 쪽이든 도중 부착으로 늘어난다.
- `attach_repository`가 들어간 뒤 생략의 의미를 "처음엔 없음"으로 바꾼다. 그 전까지는 NULL이 상한 전체를 미리 받아 온다([오너 결정](#오너-결정-2026-11-02) 2). 바꾼 뒤(순서 5)에는 생략을 `[]`로 저장하고, 이미 NULL인 행은 #986 동작을 유지한다.

## 결정 3: 일하는 도중에 붙인다

- 내장 MCP 도구 `attach_repository({ repository_id })`를 둔다. 순서: 게이트가 상한을 확인한다 → 부착 목록에 더한다 → worker가 #986 결정 2처럼 원격 `<id>`를 달고 기본 브랜치를 fetch한다. 에이전트는 토큰을 보지 않는다.
- 같은 저장소를 다시 붙이면 아무것도 바꾸지 않고 성공한다(멱등). 끝난 attempt의 요청은 거절한다.
- receipt: 요청한 actor·attempt, 저장소, 정책(릴리스) 버전, fetch한 commit, 거절 사유. fetch에는 시간·크기 상한을 둔다. 사람 승인은 받지 않는다([오너 결정](#오너-결정-2026-11-02) 3). 쓰기는 지금처럼 push 요청 승인이 막는다.
- restore 뒤에는 worker가 부착 목록으로 원격을 다시 단다.
- **붙일 수 있는 저장소를 에이전트가 본다(2026-11-03).** 이 결정은 상한을 정했지만 에이전트가 상한을 어떻게 아는지는 정하지 않았다. 4620에서 세션이 자기 기본 저장소도 말하지 못하고 `api.github.com`을 직접 부르다 egress에 막혔다. 읽기 전용 내장 MCP 도구 `list_repositories`를 둔다. 부를 때마다 게이트와 같은 세션 문맥을 다시 읽고, 상한은 부착 목록을 빼고(`attached: null`) 계산한 뒤 부착 상태를 따로 합친다. 부착 목록을 넣으면 아직 붙이지 않은 후보가 사라지기 때문이다. 항목은 `id`, `name`(URL 경로, 자격 증명 없음), `branch`, `status`(`primary`·`attached`·`pending`·`failed`·`available`)뿐이고 카탈로그 객체는 내보내지 않는다. receipt는 남기지 않는다(읽기만 한다).
- 에이전트가 터미널에서 직접 `git clone`한 결과는 보존하지 않는다. checkpoint가 추적되지 않는 중첩 저장소를 거절한다(`apps/worker/src/workspace-capture.ts:560-565`). 도구로 붙인 저장소만 세션의 저장소다.

## 결정 4: 저장소 없이 시작한 세션도 붙인다

- `optional` 프로필로 저장소 없이 시작한 세션은 저장소를 붙이고, push하고, PR을 연다. 위 "지금 구조"의 다섯 곳을 기본 저장소가 아니라 부착 목록 기준으로 바꾼다. 저장소 없는 작업 공간도 git 저장소라 원격 여러 개 방식이 그대로 맞는다.
- 저장소 없는 세션의 push 요청은 `repository_id`를 꼭 보낸다. 생략하면 지금처럼 `no_repository`다.
- `none` 프로필은 지금처럼 저장소를 쓰지 않는다. 기존 의미를 조용히 넓히지 않는다.

## 결정 5: 지켜야 할 한계

- **부착은 데이터 격리가 아니다.** 한 세션이 읽은 A 저장소의 내용을 B 저장소로 옮겨 쓸 수 있다. 관계없는 이력 검사(`apps/control-host/src/api/git-push.ts:204-212`)는 fork 사이의 이동을 막지 못한다. 그래서 대상(저장소·브랜치)과 commit별 push 승인을 유지한다. 승인 화면과 receipt에 대상 저장소를 보인다.
- **철회는 앞으로만 막는다.** 오너가 상한에서 저장소를 빼면 다음 fetch·push·PR부터 막힌다. 이미 받은 파일과 checkpoint는 지우지 않는다.
- **한 번에 한 checkout.** capture는 HEAD 브랜치와 작업 트리만 담는다(`workspace-capture.ts:572`). 다른 로컬 브랜치·stash는 restore를 보장하지 않는다. 다른 저장소로 옮기기 전에 push를 요청한다.
- **지시문 범위.** 프로젝트 지시문은 기본 저장소의 고정 commit에서만 읽는다. 붙인 저장소의 CLAUDE.md는 읽지 않는다. 부착이 지시문의 신뢰 범위를 넓히지 않는다.
- **신원.** PR 작성 App, git author·committer, 시작자 co-author(`packages/platform/src/sessions/git-attribution.ts:29` `coAuthorOf`), push 승인자를 따로 남긴다. 작성 App을 대상 저장소 기준으로 고르는지는 JeongJaeSoon/agent-platform#980과 맞춰 확인한다(미확인).

## 바뀌는 계약

| 계약 | 바뀌는 것 | 호환 |
|---|---|---|
| `POST /v1/sessions` | optional `attached_repository_ids: string[]`(상한 안, 중복 금지, 기본 저장소 제외) | 순서 5 전까지 생략은 지금과 같다(NULL). 순서 5부터 생략은 `[]` |
| 세션 조회 | `attached_repository_ids: string[] \| null` | 필드가 늘기만 한다 |
| 내장 MCP | `attach_repository({ repository_id })`, `list_repositories()` | 새 도구 |
| receipt | 부착 성공·거절 | 값이 늘기만 한다 |
| DB `sessions` | `attached_repository_ids text[] NULL` | 기존 행 NULL = #986 동작 |
| 릴리스 `github` | 기본 저장소 없는 `optional` 릴리스에도 허용 | 거절이 줄기만 한다. `none`은 그대로 `repository_none` |
| push 요청 | 기본 저장소 없는 세션은 `repository_id`를 꼭 보낸다 | 기본 저장소 있는 세션은 그대로 |

## 순서

1. 이 문서 확정(2026-11-02).
2. 부착 목록 저장과 모든 경로의 검사. 앞서 계획한 "추가 저장소를 read-only로 붙이기" 작업의 시작 때 목록·붙인 저장소에만 token 조건을 이 형태로 대체한다. `github-agent.md` `### GitHub 게이트`의 "The repository is never passed" 문장을 "저장소를 넘기되 게이트가 세션 행과 릴리스로 다시 검증한다"로 고친다.
3. 기본 저장소 없는 `optional` 세션의 차단 제거.
4. `attach_repository` 도구, worker 멱등 부착, restore 뒤 재부착, receipt.
5. 오너 결정 2에 따라 생략 시 기본 부착을 바꾼다.

검증: verify 스택과 실제 GitHub에서 "저장소 없이 시작 → 부착 → 편집 → 볼륨 손실 → restore → 대상별 push·PR", 상한에서 뺀 뒤 거절, 부착 도중 crash 뒤 재시도.

## 다른 작업에 주는 영향

- #986: 바꾸지 않는다. 그 문서에 이 문서 링크만 단다.
- 앞서 계획한 "추가 저장소를 read-only로 붙이기" 작업: 시작할 때 고르는 목록과 붙인 저장소에만 token을 붙이는 조건은 "시작 + 도중 부착 목록"으로 바뀌어 순서 2가 대체한다. 고정 위치 `.deps/<owner>/<repo>`에 clone하는 조건은 LATER로 미룬다.
- GitHub 게이트: 시그니처는 #986의 `repositoryId?` 그대로다. 게이트가 읽는 세션 문맥에 부착 목록 필드 하나가 늘어난다.
- GitHub Packages: 영향 없음. packages binding은 저장소와 상관없이 모든 세션에 붙는다.
- JeongJaeSoon/agent-platform#980(작성 App bot): 여러 저장소에서 작성 App을 대상 저장소 기준으로 고르는지 맞춰 볼 항목이다.

## 오너 결정 (2026-11-02)

오너가 이 방향과 아래 추천을 함께 승인했다(원문 "좋은거 같아").

1. 방향: 승인.
2. 생략한 세션의 기본 부착: `attach_repository`가 들어가기 전까지는 ① 상한 전체를 미리 받는다(#986 지금 동작). 도구가 들어가면 ② 처음엔 없음, 필요할 때 붙임으로 바꾼다. ②는 claim마다 하는 fetch를 줄이고 세션이 실제로 쓴 저장소를 남긴다.
3. 도중 부착에 사람 승인: 받지 않는다. 상한은 오너가 이미 고른 릴리스 목록이고 쓰기는 push 승인이 막는다.

## LATER

- 콘솔 세션 화면에 기본 저장소와 부착 목록 표시. 다시 볼 조건: API로 부착이 쓰이기 시작할 때.
- 저장소별 디렉터리와 여러 작업 트리의 동시 복구(`.deps/<owner>/<repo>` 고정 위치 clone 포함). 다시 볼 조건: 두 저장소를 동시에 열어 두고 일해야 하는 사례. 그 전에는 `git show <id>/<branch>:<path>`로 읽는다.
- 부착 해제. 다시 볼 조건: 진행 중인 세션의 범위를 줄여야 하는 사례.
- dispatch·rerun·리뷰를 붙인 저장소에 쓰기. #986 LATER와 같다.
- 터미널에서 직접 한 clone, worktree, submodule의 복구는 약속하지 않는다.
