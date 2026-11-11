# 결정: 한 세션에서 여러 저장소에 여러 PR을 연다

- 후속(2026-11-11): 실행 프로필은 통째로 지웠다(migration `0270_remove_profiles`, 기존 데이터는 이전하지 않고 지움). 이 문서의 프로필·상한·롤아웃 언급은 그때의 기록이다. 지금은 에이전트 release가 provider 연결과 카드 모델로 실행 spec(런타임·도구·권한 모드)을 고정하고, 묻기·막기 규칙은 워크스페이스와 에이전트의 실행 규칙(`workspace_engine_settings`, `agent_engine_settings`)이 정한다.
- 상태: 설계. 구현은 이 문서를 계약으로 쓴다.
- 기준 커밋: `origin/main` `971d2fe34`. 아래 `파일:줄`은 이 커밋 기준이다.
- 오너 원문(2026-11-01): "한 세션에서 여러 repo, 여러 pr 도 대응가능하게 하고싶어. 특별히 갯수 제한도 두고 싶지 않아. 개선해줘".
- 오너가 정한 남용 방지: 개수 제한은 두지 않는다. 기존 push 승인과 감사 기록(receipt)으로 막는다.
- 후속(오너 승인 2026-11-02): [session-repository-attachment.md](session-repository-attachment.md)는 결정 1의 목록을 상한으로 두고, 세션이 쓰는 범위를 세션 행의 부착 목록으로 좁힌다. 그 문서 순서 5부터 `attached_repository_ids`를 생략한 새 세션은 NULL이 아니라 `[]`로 시작한다. 아래 "보내지 않으면 NULL"은 그 전에 만든 세션의 동작이다.

## 지금 구조

- **세션의 저장소는 하나다.** 세션 행에 `repository_id`·`repo_url`·`branch`가 하나씩 있다(`packages/db/src/schema.ts:986-1013`). 세션을 만들 때 이 저장소가 릴리스 `github.repositories` 안에 있고 프로필이 허용하는지 본다(`packages/platform/src/sessions/session-service.ts:632-690`).
- **작업 디렉터리에는 그 저장소 하나만 있다.** worker는 claim의 `workspace.repository` 하나를 egress proxy의 `/repository` 경로로 clone한다(`apps/worker/src/workspace.ts:437-508`, `850-865`). 이 경로는 저장소를 고르지 않는다. 인가는 토큰에 묶인 세션 저장소의 binding으로만 한다(`packages/platform/src/workers/worker-gateway.ts:1341-1387`). 에이전트는 토큰을 받지 않으므로 다른 저장소를 직접 clone할 수 없다.
- **checkpoint는 그 저장소 하나를 담는다.** HEAD 브랜치와 작업 트리 commit을 bundle로 남긴다. 중첩 저장소가 있으면 checkpoint를 거절한다(`apps/worker/src/workspace-capture.ts:558-565`). restore는 `origin` 하나만 다시 단다(`apps/worker/src/checkpoint-restore.ts:171-290`).
- **push 요청은 세션 저장소, 브랜치 `agent/<session-id>` 하나로 간다.** 요청 본문은 비어 있다(`packages/contracts/src/api/push-request.ts:81`). 브랜치는 `pushBranchFor(sessionId)`로 정하고(`packages/db/src/push-requests.ts:219`), DB check가 이 값만 받는다(`packages/db/src/schema.ts:2058-2061`). 열린 요청(`requested`·`approved`·`pushing`)은 세션에 하나뿐이다(`schema.ts:2066-2070`).
- **push 실행기는 bundle만으로 commit을 만든다.** 버리는 bare 저장소에 checkpoint bundle 사슬을 fetch하고 그 commit을 push한다(`apps/control-host/src/api/git-push.ts:116-206`). 저장소는 요청 행의 `repository_id`로 고르지만(`packages/platform/src/sessions/push-executor.ts:89-98`), 토큰은 게이트가 세션 행의 저장소로 발급한다(`push-executor.ts:113`, `packages/platform/src/sessions/github-gate.ts:113-124`).
- **PR은 push 요청의 브랜치에서 연다.** 브랜치가 `agent/<session-id>`가 아니면 거절한다(`packages/platform/src/sessions/pull-request-service.ts:271-274`). 같은 브랜치에 열린 PR이 있으면 그 PR을 답한다. 그래서 지금은 세션 하나에 저장소 하나, 열린 PR 하나다.
- **여러 저장소를 다룰 근거는 이미 있다.** 릴리스의 `github.repositories`(1~32개, `packages/contracts/src/kollegium/agents.ts:316`)는 오너가 에이전트에 허용한 저장소 목록이다. 지금은 게이트가 세션 저장소가 이 목록 안에 있는지 볼 때만 쓴다(`github-gate.ts:139-144`).

## 결정 1: 세션이 다룰 수 있는 저장소

세션의 저장소 목록은 **세션 저장소 하나와 그 세션 릴리스의 `github.repositories`** 다. 이 목록은 상한이다. 세션 생성 때 `attached_repository_ids`를 보내면 세션 행에 그 부착 목록을 두고, 세션이 쓰는 추가 저장소는 부착 목록 ∩ 상한으로 좁혀진다. 보내지 않으면 열이 NULL이고 상한 전체를 쓴다. 목록은 쓸 때마다 다시 읽는다. 그래서 오너가 릴리스 설정에서 저장소를 빼면 진행 중인 세션도 다음 fetch·push·PR부터 그 저장소를 쓰지 못한다.

세션 저장소가 아닌 저장소(이하 **추가 저장소**)는 아래를 모두 만족해야 한다. 하나라도 어기면 쓰지 않는다.

- 카탈로그에 있다.
- 세션의 실행 프로필이 그 저장소를 허용한다(`allowedPair`).
- 에이전트의 GitHub 스위치가 켜져 있고, 릴리스 `github` 설정이 있으며, 그 목록에 들어 있다.
- 저장소 id가 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`에 맞고 `origin`이 아니다. 작업 디렉터리에서 git 원격 이름으로 쓰기 때문이다.

이유: 새 승인 단위를 만들지 않고 오너가 이미 고른 목록을 쓴다. 저장소 개수의 상한은 이 목록의 기존 상한(32)뿐이다. PR 개수에는 상한을 두지 않는다.

## 결정 2: 작업 저장소 하나에 원격 여러 개

추가 저장소는 하위 디렉터리에 따로 clone하지 않는다. **세션 저장소의 git 저장소에 원격으로 단다.**

- claim의 `workspace`에 `additional_repositories`를 더한다. 항목은 `{ id, url, branch, access }`다. 형태는 `repository`와 같고, `access`는 세션 저장소와 같은 egress 토큰이다. 추가 저장소가 없으면 이 키를 보내지 않는다.
- worker는 작업 디렉터리를 준비한 뒤(clone·재사용·restore 모두) 항목마다 원격 `<id>`를 실제 URL(자격 증명 없음)로 달고, 그 저장소의 기본 브랜치를 `refs/remotes/<id>/<branch>`로 fetch한다. fetch는 egress proxy의 `/repository/<id>/…` 경로로 한다.
- 에이전트는 `git switch -c <이름> <id>/<branch>`로 그 저장소 작업을 시작한다. commit하고 turn을 끝내면 checkpoint가 지금처럼 HEAD 브랜치를 담는다. 그 브랜치의 객체(추가 저장소의 이력 포함)가 bundle에 들어가므로 push 실행기는 지금 그대로 push할 수 있다.
- 추가 저장소 하나의 fetch가 실패하면 그 저장소만 건너뛰고 로그를 남긴다. 세션 저장소의 준비는 막지 않는다.

이유:
- checkpoint 형식, restore, push 실행기의 bundle 처리, egress 토큰 행(`(attempt_id, purpose)` 유일)을 바꾸지 않는다. 하위 디렉터리 clone은 checkpoint가 거절하거나(추적되지 않는 중첩 저장소) 잃는다(무시된 파일).
- 한 번에 한 저장소를 checkout한다. 다른 저장소로 옮기기 전에 push를 요청하면 된다. push된 브랜치는 원격에 남는다.

비용: claim마다 추가 저장소 수만큼 fetch한다. 처음 그 저장소 브랜치로 checkpoint할 때 bundle이 그 저장소 이력만큼 커진다. 기존 bundle 상한은 그대로 적용된다.

### egress 경로

- 경로: `GET /repository/<id>/info/refs?service=git-upload-pack`, `POST /repository/<id>/git-upload-pack`. `<id>`는 URL 인코딩한 저장소 id 한 조각이다. 읽기(upload-pack)만 있다. receive-pack 경로는 지금처럼 없다. 엔진의 `insteadOf`가 `.git`으로 끝나는 URL을 바꾼 `/repository/<id>/.git/…`도 같은 경로다.
- Git LFS: `POST /repository/<id>/.git/info/lfs/objects/batch`는 `operation: "download"`만 받는다. upload는 인가를 묻기 전에 400이다. proxy는 upstream 응답의 download 위치를 자기 경로 `GET …/info/lfs/objects/<oid>?size=<n>`로 바꿔 돌려준다. 그 GET이 오면 같은 인가로 batch를 다시 부르고, 응답이 가리킨 저장 위치를 `EGRESS_PACKAGES_REDIRECT_ALLOWLIST` 안의 호스트에서만 자격 없이 받는다. 저장소의 헤더와 오류 본문은 넘기지 않는다. 저장 위치(GitHub는 presigned URL)는 worker에 닿지 않는다.
- proxy는 인가 요청에 `repository_id`를 싣는다(`{ token, purpose: "repository", repository_id }`). 없으면 지금과 같다(세션 저장소).
- gateway는 `repository_id`가 세션 저장소와 같으면 지금 검사를 그대로 한다. 다르면 결정 1의 조건을 보고 게이트에서 그 저장소의 `clone` 토큰을 받는다. 추가 저장소는 claim 때 binding을 고정하지 않는다. 게이트가 요청마다 카탈로그와 릴리스를 다시 읽는다.
- GitHub 게이트가 없는 배포(카탈로그 PAT만 쓰는 배포)에서는 추가 저장소를 쓰지 않는다. claim에 싣지 않고, 인가도 거절한다.

## 결정 3: push 요청은 저장소와 브랜치를 고른다

`POST /v1/sessions/{id}/push-requests` 본문(지금은 빈 객체)에 둘을 더한다. 둘 다 생략할 수 있다.

```ts
{
  repository_id?: string;   // 생략하면 세션 저장소
  branch?: string;          // ^[a-z0-9][a-z0-9-]{0,39}$
}
```

- `target_branch`는 `branch`가 없으면 지금처럼 `agent/<session-id>`, 있으면 `agent/<session-id>-<branch>`다. `agent/<session-id>/<branch>`로 하지 않는 이유: git은 `agent/<id>`와 `agent/<id>/x`를 한 저장소에 함께 두지 못한다. `-`로 붙이면 세션 id(UUID) 뒤에 붙으므로 다른 세션의 브랜치와 겹치지 않는다. `agent/` 접두사는 그대로라 dispatch의 `agent_ref_refused`가 그대로 막는다.
- push할 commit은 지금처럼 세션의 마지막 checkpoint commit이다. 에이전트는 push하려는 브랜치를 checkout한 채로 turn을 끝낸다.
- **열린 요청은 (세션, 저장소, 브랜치)마다 하나다.** 다른 저장소나 다른 브랜치로 가는 요청은 동시에 열려 있을 수 있다. 같은 대상에 열린 요청이 있으면 지금처럼 `409 PUSH_REQUEST_OPEN`이다.
- 거절:
  - 카탈로그에 없는 저장소: 지금처럼 `no_repository`.
  - 결정 1의 조건을 어긴 추가 저장소: 새 refusal `repository_not_allowed`(`403`, `FORBIDDEN`). receipt를 남긴다.
  - 같은 대상의 열린 요청: `request_open`.
- receipt의 `repository_id`·`target_branch`는 고른 값이다. 오너가 한 세션의 모든 push를 `GET …/push-requests`와 receipt로 볼 수 있다.

### push 실행기

- 브랜치 검사는 "그 세션의 브랜치인가"(`agent/<id>` 또는 `agent/<id>-<branch>`, 형식 검사 포함)로 바꾼다.
- 토큰은 게이트에 요청 행의 저장소를 넘겨 받는다(결정 5).
- **관계없는 이력 거절.** 대상 브랜치가 원격에 아직 없으면, 원격의 기본 브랜치(`HEAD`)를 받아(이미 bundle에 있는 객체는 다시 받지 않는다) push할 commit과 공통 조상이 있는지 본다. 없으면 새 refusal `unrelated_history`로 push하지 않는다. 다른 저장소의 내용을 실수로(또는 승인 없이) 엉뚱한 저장소에 올리는 것을 막는다. 세션 저장소로 가는 push에도 똑같이 적용한다.

## 결정 4: PR과 코멘트

- PR은 지금처럼 push 요청 하나에서 연다. 저장소는 요청의 `repository_id`, head는 요청의 `target_branch`, base는 그 저장소 카탈로그 항목의 `branch`다.
- head 검사는 결정 3의 "그 세션의 브랜치인가"로 바꾼다.
- 같은 브랜치 이름이 저장소마다 있을 수 있으므로, 코멘트가 앞 요청의 PR을 찾을 때(`findBranchPullRequest`) 저장소까지 맞춘다.
- 그래서 브랜치마다, 저장소마다 PR이 하나씩 생긴다. 세션당 PR 수에는 상한이 없다.

## 결정 5: 게이트는 저장소를 받는다

`GitHubWork`에 `repositoryId?`를 더한다. 없으면 지금처럼 세션 저장소다.

- 세션 저장소와 같으면 지금 검사를 그대로 한다.
- 다르면 결정 1의 조건을 본다. 플랫폼의 읽기(`outcome_refresh`)는 카탈로그에 있는지만 본다. 지금도 이 읽기에는 스위치·목록을 적용하지 않는다.
- 거절은 지금의 `repository_not_allowed`(`403`)이고 receipt의 `repository_id`는 요청한 저장소다.
- 이번에 저장소를 넘기는 곳: egress clone 인가, push 실행기, PR 열기·코멘트, 성과물 상태 조회. dispatch·rerun·run 조회·리뷰는 지금처럼 세션 저장소만 쓴다([LATER](#later)). 게이트도 추가 저장소의 이 네 purpose(`dispatch`·`rerun`·`actions_read`·`review`)를 부착 여부와 관계없이 `repository_not_allowed`로 거절한다.
- 성과물 상태 조회(`outcome_refresh`)는 부착 목록을 대지 않는다. 플랫폼이 이미 기록한 PR을 읽는 일이고, 그 PR을 열 때 부착 목록 검사를 지났다.

## 바뀌는 계약

| 계약 | 바뀌는 것 | 호환 |
|---|---|---|
| `POST /v1/sessions` | optional `attached_repository_ids`(최대 32, 중복 금지, 원격 이름 규칙). 상한 밖·프로필 밖·주 저장소 id, 릴리스나 저장소가 없는 세션의 목록은 `403` `GITHUB_REFUSED`/`repository_not_allowed`. 세션 응답에 `attached_repository_ids`(`string[] \| null`) | 생략은 지금과 같다 |
| DB `sessions` | `attached_repository_ids text[] NULL`, CHECK: NULL이 아니면 `repository_mode = 'repository'`. backfill 없음 | 옛 이미지는 열을 읽지 않는다. 롤백하면 목록을 준 세션이 상한 전체로 넓어진다 |
| `POST /v1/sessions/{id}/push-requests` | 본문에 optional `repository_id`, `branch`. 새 refusal `repository_not_allowed`(403) | 빈 본문은 지금과 같다 |
| 내장 MCP `request_push` | 인자 `{ repository_id?, branch? }` | 인자 없이 부르면 지금과 같다 |
| push receipt·refusal 값 | `repository_not_allowed`, `unrelated_history` 추가 | 값이 늘기만 한다 |
| worker claim `workspace` | optional `additional_repositories` | 키는 추가 저장소가 있을 때만 보낸다. `workspace` 스키마가 strict라 이 키를 모르는 옛 worker는 그 claim을 거절한다. 그래서 control-host와 worker 이미지를 같이 올린다. 추가 저장소가 없는 세션은 영향이 없다 |
| egress 인가 요청(proxy→control-host) | `purpose: "repository"`에 optional `repository_id` | 옛 proxy는 키를 보내지 않으므로 지금과 같다. 새 proxy가 옛 control-host에 보내면 strict 스키마가 400으로 거절한다. 추가 저장소 fetch만 실패하고 세션 저장소는 영향이 없다 |
| DB `push_requests` | check를 `target_branch IN ('agent/'‖id) OR LIKE 'agent/'‖id‖'-%'`로 넓힌다. 열린 요청 유일 index를 `(session_id, repository_id, target_branch)`로 바꾼다 | 기존 행은 새 check를 만족한다. 옛 이미지는 계속 `agent/<id>`만 쓴다 |

## 검증

- 단위·route 테스트: 결정 1의 조건 각각(목록 밖·프로필 밖·스위치 꺼짐·이름 규칙), 브랜치 형식, 대상별 열린 요청, 다른 저장소 요청 동시 열림, 게이트의 저장소 인자, 관계없는 이력 거절, 코멘트의 저장소별 PR 찾기, egress `/repository/<id>` 경로와 인가, worker의 원격 추가와 fetch(restore 뒤 포함).
- E2E(verify 스택, 실제 GitHub): 세션 하나에서 같은 저장소에 브랜치를 달리해 PR 2개 이상, 다른 저장소에 PR 1개 이상을 연다.

## LATER

- dispatch·rerun·run 조회·리뷰를 추가 저장소에 쓰기. 다시 볼 조건: 추가 저장소에서 워크플로를 돌려야 하는 사용 사례가 나올 때.
- 콘솔에서 push 요청 목록과 저장소별 승인 화면. 지금 콘솔에는 push 요청 화면이 없다. 다시 볼 조건: API가 아닌 콘솔에서 승인하려는 요청이 나올 때.
- 추가 저장소를 claim마다 모두 fetch하지 않고 필요할 때만 받기. 다시 볼 조건: 저장소 수나 크기로 claim 시간이 문제 될 때.
