# 결정: GitHub App 저장소를 DB 카탈로그로 옮긴다

후속(2026-11-11): 실행 프로필은 통째로 지웠다(migration `0267_remove_profiles`, 기존 데이터는 이전하지 않고 지움). 이 문서의 프로필·상한·롤아웃 언급은 그때의 기록이다. 지금은 에이전트 release가 provider 연결과 카드 모델로 실행 spec(런타임·도구·권한 모드)을 고정하고, 묻기·막기 규칙은 워크스페이스와 에이전트의 실행 규칙(`workspace_engine_settings`, `agent_engine_settings`)이 정한다.

상태: 결정(2026-11-01). 운영자 파일 `repositories.yaml`을 읽는 것([4절](#4-시드)의 시드, 비밀값을 쓰는 저장소의 파일 보관)과 콘솔의 저장소 추가·제거([5절](#5-api))는 대체됨 → [settings-replace-file-catalog.md](settings-replace-file-catalog.md)([1절](settings-replace-file-catalog.md#1-데이터-모델), [1.1절](settings-replace-file-catalog.md#11-github-app-저장소-등록-없이-설치-목록이-정본), 2026-11-02).

출처: GitHub 연결 설정 재구성 시안 v2 G절, 오너가 정할 것 2(추천안 채택, 2026-11-01).

## 무엇을 골랐나

- `auth: { kind: github_app }`만 적은 저장소(콘솔에 등록한 App을 쓰는 저장소)는 DB 테이블 `catalog_repositories`가 정본이다.
- `repositories.yaml`은 이 테이블이 비어 있을 때 한 번 시드로만 읽는다. 그 뒤 yaml을 고쳐도 DB를 덮어쓰지 않는다. `profiles.yaml`과 같은 방식이다(profile-db.md §3).
- 비밀값 참조가 있는 저장소(basic, bearer, `app_id`·`installation_id`를 적은 App, 공개 저장소)는 지금처럼 운영자 파일에 둔다. 콘솔에는 '설정 파일'로 읽기 전용으로 보인다.
- 소유자와 관리자가 콘솔에서 추가, 기본 브랜치 변경, 제거를 한다. 추가할 수 있는 저장소는 등록한 작성용 App의 설치에 들어 있는 저장소뿐이다. URL은 받지 않는다.

## 지금 구조 (바뀌는 것의 출발점)

- `readCatalogConfig`(`apps/control-host/src/api/catalog-config.ts`)가 기동 때 yaml을 읽는다. `resolveSessionCatalog`가 `{ kind: github_app }`를 `{ kind: "github_app", registered: true }`로 바꾼다.
- API는 `catalog.repositories`를 기동 때 고정한 객체로 들고 있다(`profileCatalog`, `packages/platform/src/sessions/profile-registry.ts`). 세션 생성과 claim, 저장소 프록시, GitHub 게이트, 릴리스 검사, 프로필 상한 검사는 모두 요청마다 이 객체를 읽는다.
- 카탈로그는 설치 하나에 하나다. 워크스페이스별로 나뉘지 않는다(profile-db.md:105).
- GitHub 토큰 연결(`connectionsOf`, `forge-github.ts`)은 기동 때 저장소별 지도를 만든다.

## 1. 데이터 모델

`catalog_repositories` (migration 0204)

| 열 | 뜻 |
|---|---|
| `id` text PK | 카탈로그 id. 세션, 릴리스, 프로필 상한이 이 값으로 가리킨다. 행을 지우지 않으므로 다시 쓰이지 않는다 |
| `github_repository_id` bigint null | GitHub의 숫자 id. 콘솔 추가는 늘 채운다. 시드 행은 비어 있을 수 있다 |
| `owner`, `name` text | GitHub의 owner/name. 화면 표시와 중복 검사에 쓴다 |
| `url` text | clone URL. 콘솔 추가는 서버가 `https://github.com/{owner}/{name}.git`로 만든다. 시드는 yaml 값을 그대로 둔다 |
| `branch` text | 기본 브랜치. 추가할 때 GitHub에서 읽은 값으로 채운다. 바꿀 수 있다 |
| `profiles` jsonb null | 시드 행의 yaml `profiles`. 허용은 프로필 상한의 `repository_ids`가 정한다(PD-5). 이 값은 binding 해시를 yaml 때와 같게 두려고만 남긴다 |
| `app_role` text | 지금은 `author`뿐이다. 리뷰용 App은 같은 저장소에 따라붙는다 |
| `source` text | `seed` 또는 `console` |
| `version` int | 기본 브랜치를 바꿀 때마다 1씩 오른다 |
| `created_at/by`, `updated_at/by`, `removed_at/by` | 감사용. `removed_at`이 있으면 카탈로그에서 빠진다 |

- 워크스페이스 열은 두지 않는다. 카탈로그가 설치 단위이기 때문이다. API는 지금처럼 호출자의 워크스페이스를 확인한다.
- 같은 GitHub 저장소는 제거되지 않은 행으로 둘 이상 둘 수 없다(`github_repository_id`, `lower(owner)/lower(name)` 부분 unique).
- URL과 App 역할은 바꿀 수 없다. 바꾸려면 제거하고 새 id로 추가한다.

## 2. 카탈로그에 합치기

- 레지스트리(`createProfileRegistry`)가 프로필 행을 읽는 같은 주기에 저장소 행도 읽는다. 카탈로그의 `repositories`는 레지스트리를 따라가는 getter다. 레지스트리가 아직 읽지 못했을 때와, 테이블에 행이 한 번도 없었을 때(시드 전)는 지금처럼 yaml 전체를 쓴다. 첫 배포에서 시드가 커밋되기 전에 읽어도 등록 App 저장소가 빠지지 않는다.
- API와 Slack 프로세스가 같은 규칙으로 합친다. Slack이 세션을 만들 때도 콘솔에서 더하거나 바꾼 저장소를 본다.
- 첫 읽기 뒤에는 yaml 가운데 `{ kind: github_app }`만 적은 항목을 빼고, 제거되지 않은 DB 행을 더한다. DB 행은 `{ url, branch, profiles?, auth: { kind: "github_app", registered: true } }`로 만든다. yaml에서 시드한 행은 시드 전과 같은 객체가 되므로, 진행 중인 세션의 `repositoryBinding`과 `catalogRevision`이 이전 때문에 바뀌지 않는다.
- 같은 id가 운영자 파일(비밀값 저장소)과 DB에 함께 있으면 파일이 이긴다. 콘솔 추가는 파일의 id를 쓰지 못하게 막는다.
- worker gateway의 claim 캐시는 저장소 객체가 바뀔 때도 다시 만든다.
- GitHub 토큰 연결은 저장소 id를 볼 때마다 지금 카탈로그에서 '등록한 App 저장소'인지 판단한다. 기동 때 만든 지도에 없는 새 저장소도 토큰을 받는다.
- 다른 replica의 변경은 다음 주기(`WORKSPACE_PROFILE_REFRESH_MS`)에 들어온다. 쓰기를 처리한 replica는 커밋 직후 바로 다시 읽는다.
- 뒤처진 replica도 새 저장소의 세션을 실패시키지 않는다. 세션 생성은 지금도 프로필을 확인하면서 레지스트리를 다시 읽는다(`refreshWorkspaceProfilesFor`). 저장소 행도 같은 읽기로 들어온다. claim은 실행할 수 있는 (프로필, 저장소) 쌍에 없는 세션을 고르지 않고, 그 세션을 아는 replica가 가져가도록 남겨 둔다.

## 3. 바뀐 값과 진행 중 세션

- 기본 브랜치를 바꾸면 binding이 바뀐다. 이미 claim된 세션의 다음 프록시 요청은 지금처럼 `CATALOG_MISMATCH`로 거절된다. yaml을 고치고 재기동했을 때와 같다.
- 제거하면 새 세션과 릴리스에서 그 id를 고를 수 없다. 프로필 상한의 `repository_ids`나 활성 릴리스가 가리키는 저장소는 제거를 거절한다(409 `REPOSITORY_IN_USE`). 먼저 그 참조를 뺀다.

## 4. 시드

- API 기동 때 프로필 시드 바로 뒤에 같은 advisory lock 아래에서 돈다. 테이블에 행이 하나도 없을 때만 yaml의 `{ kind: github_app }` 항목을 id 그대로 넣는다(`source: seed`).
- 행이 하나라도 있으면 아무것도 하지 않는다. 그래서 여러 번 돌아도 결과가 같고, 콘솔에서 지운 저장소가 재기동으로 되살아나지 않는다.
- 한 GitHub 저장소에는 행이 하나다. yaml의 두 id가 같은 저장소를 가리키면 먼저 나온 id만 넣고 나머지는 경고 로그로 남긴다. 빠진 id를 쓰던 에이전트는 남은 id로 옮긴다.
- yaml에 그런 항목이 없으면 아무것도 넣지 않는다. 그 뒤 yaml에 항목을 더하면 테이블이 여전히 비어 있으므로 다음 기동에서 가져온다.
- 가져온 행마다 receipt `import_repository`를 남긴다(주체: 시스템).

## 5. API

모두 `workspace.manage`(소유자·관리자)이고, 콘솔 세션 cookie로만 부른다(GitHub App 등록과 같다).

| 경로 | 하는 일 |
|---|---|
| `GET /v1/workspaces/{id}/github-repositories` | 카탈로그의 GitHub 저장소. 행마다 `source`(`console`·`seed`·`file`), `editable`, 설치 상태 |
| `GET /v1/workspaces/{id}/github-repositories/candidates` | 작성용 App의 설치마다 `GET /installation/repositories`로 읽은 저장소. 이미 카탈로그에 있으면 `catalog_id`를 붙인다 |
| `POST /v1/workspaces/{id}/github-repositories` | `{ github_repository_id, id? }`. 서버가 후보 목록에서 그 저장소를 다시 찾아 URL과 기본 브랜치를 정한다. 후보에 없으면 400 `not_installed`, 이미 있거나 운영자 파일이 자격과 함께 가진 저장소면 400 `already_added`, `id`가 쓰였으면 400 `id_taken` |
| `PATCH /v1/workspaces/{id}/github-repositories/{repositoryId}` | `{ branch, version }`. `version`이 다르면 409 `REVISION_CONFLICT` |
| `DELETE /v1/workspaces/{id}/github-repositories/{repositoryId}` | 제거. 참조가 있으면 409 `REPOSITORY_IN_USE`(`details`에 프로필 상한 id와 에이전트 slug) |

- 운영자 파일의 항목에 PATCH·DELETE를 보내면 400 `file_repository`다. 응답 코드는 기존 400 `BAD_REQUEST` + `reason_code` 방식을 따른다(이 API에 422를 따로 두지 않는다).
- 브랜치 이름은 공백·제어 문자, git이 받지 않는 문자, `..`·`@{`·`//`, `.`로 시작하는 구성 요소, 앞의 `-`·`/`, 끝의 `/`·`.lock`을 막는다. 그 브랜치가 GitHub에 있는지는 묻지 않는다(LATER).

- `id`를 주지 않으면 서버가 저장소 이름을 소문자로 바꿔 쓰고, 이미 쓰인 id(제거된 것 포함)면 `-2`, `-3`을 붙인다. 형식은 지금 카탈로그 id 규칙을 따른다.
- `GET …/github-app`의 `repositories`는 그대로 둔다. 화면은 새 목록 API를 쓴다.

## 6. 감사

| 동작 | receipt `operation` |
|---|---|
| 콘솔 추가 | `add_repository` |
| 기본 브랜치 변경 | `set_repository_branch` |
| 제거 | `remove_repository` |
| 시드 가져오기 | `import_repository` |

receipt에는 id, owner/name, URL, 브랜치(바꾸기 전과 후)만 넣는다. 비밀값은 없다.

## 7. 보안 경계

- 저장소를 늘릴 수 있는 사람이 '설정 파일을 쓰는 운영자'에서 '워크스페이스 소유자·관리자'로 넓어진다.
- 그 대신 고를 수 있는 것은 GitHub 조직 관리자가 이미 App을 설치한 저장소뿐이다. URL, 호스트, 자격 참조는 콘솔에 열지 않는다. #897이 막은 위험(콘솔 쓰기로 임의 endpoint와 자격 참조를 묶음)은 그대로 막혀 있다.
- 추가만으로는 실행 권한이 생기지 않는다. 프로필 상한의 `repository_ids`와 에이전트의 저장소 범위를 따로 골라야 한다.

## 8. 롤백

- migration은 테이블 하나를 더할 뿐이다. 앞 버전으로 되돌리면 API가 이 테이블을 읽지 않고 yaml만 쓴다. 콘솔에서 더한 저장소는 그동안 보이지 않는다.
- 다시 이 버전으로 오면 테이블에 행이 있으므로 시드는 돌지 않고, 콘솔에서 더한 저장소가 돌아온다.

## 9. 운영 문서

`docs/operator/`의 GitHub 저장소 추가 안내를 콘솔(설정 > 워크스페이스 > 연동 > GitHub > 저장소 관리)로 옮긴다. yaml에는 비밀값이 필요한 저장소와 빈 설치의 시드만 남는다고 적는다.

## 대안

| 안 | 고르지 않은 이유 |
|---|---|
| 파일 유지 + 문구 개선 | 오너 질문에 답하지 못한다. 저장소 하나에 재배포가 하나씩 남는다 |
| 비밀값 저장소까지 전부 DB | #897이 막은 위험이 다시 열린다 |
| yaml을 늘 정본으로 두고 DB에 미러 | 두 곳을 고칠 수 있어 어느 쪽이 맞는지 헷갈린다 |
| 행을 지워서 제거 | id가 다시 쓰이면 예전 세션과 receipt가 다른 저장소를 가리키게 된다 |
| 워크스페이스 열 | 카탈로그는 설치 단위다. 열만 있고 나누는 데 쓰이지 않는다 |

## LATER

- yaml을 다시 가져오는 명시적 명령(IaC로 저장소를 관리하는 설치용).
- 기본 브랜치를 바꿀 때 GitHub에 그 브랜치가 있는지 확인.
- 리뷰용 App 전용 저장소(`app_role: reviewer`).
- GHES의 콘솔 App.
