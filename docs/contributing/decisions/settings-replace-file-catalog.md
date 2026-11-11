# 결정: 파일 카탈로그를 없애고 설치 설정을 DB와 콘솔로 옮긴다

- 후속(2026-11-11): 실행 프로필은 통째로 지웠다(migration `0270_remove_profiles`, 기존 데이터는 이전하지 않고 지움). 이 문서의 프로필·상한·롤아웃 언급은 그때의 기록이다. 지금은 에이전트 release가 provider 연결과 카드 모델로 실행 spec(런타임·도구·권한 모드)을 고정하고, 묻기·막기 규칙은 워크스페이스와 에이전트의 실행 규칙(`workspace_engine_settings`, `agent_engine_settings`)이 정한다.
- 상태: **확정(2026-11-02).** 오너 원문: "카탈로그 변경은 추천대로 진행해줘". 끝의 "오너 결정" 1~6이 그 내용이다.
- 대체: [repository-catalog-db.md](repository-catalog-db.md)의 `repositories.yaml` 읽기(시드, 비밀값 저장소 파일 보관)와 콘솔 저장소 추가·제거(5절), [profile-db.md](profile-db.md)의 설정 파일(`profiles.yaml` 시드, `connections.yaml`) 읽기와 `repository_ids` 나열만으로 하는 저장소 허용(1.1절 `installed`).
- 기준 커밋: `origin/main` `d90b26731`. `파일:줄`은 모두 이 커밋 기준이다. JeongJaeSoon/agent-platform#992(이 문서를 쓴 뒤 `c0b27e605`로 land)의 내용은 그 브랜치 기준이라고 따로 적는다.
- 오너 원문(2026-11-02): "접속처(connections.yaml) 에 대한 내용도 제거해서 설정으로 옮기는거 어때 ? 그래서 최종적ㅡ로 파일로 제어하는 카탈로그 개ㅁ을 완전히삭제하는게 좋을거 같은데"
- 추가 오너 원문(2026-11-02): "github app 이 연동할수 있는 저장소 목록이 페이지 네이션 형태로 떠야하지않을까". GitHub App 저장소는 등록하지 않는다. 설치 저장소 API가 정본이고 DB에는 에이전트별 선택만 남는다(1.1절).
- 앞 결정: [profile-db.md](profile-db.md)(프로필은 DB만), #992의 `repository-catalog-db.md`(GitHub App 저장소는 DB 정본). 이 문서는 두 결정이 파일에 남긴 것을 마저 옮기고, GitHub App 저장소의 콘솔 등록(#992 5절의 추가·제거)을 1.1절의 선택 모델로 대체한다.

## 무엇을 골랐나

1. **API·slack 프로세스는 설정 파일을 읽지 않는다.** `PLATFORM_CONFIG_DIR`와 그 디렉터리의 다섯 파일(`connections.yaml`, `repositories.yaml`, `mcp-servers.yaml`, `profiles.yaml`, `platform.yaml`)을 읽는 코드를 지운다. 값이 남아 있으면 기동을 거부하고 가져오기 방법을 알려 준다(`SESSION_CATALOG_JSON`을 없앨 때와 같은 방식, `apps/control-host/src/api/catalog-config.ts:192-197`).
2. **연결·저장소·MCP 서버는 DB 행이고 콘솔에서 고친다.** 쓰기마다 receipt를 남긴다. 실행에 핀이 걸리는 칸(endpoint, URL, 자격 증명 출처)은 바꾸지 않고 새 id로 만든다. 바꿀 수 있는 것은 자격 증명 값의 회전, 저장소 기본 브랜치(버전이 오른다), 사용 중지뿐이다.
3. **자격 증명은 두 출처다.** 콘솔에서 입력해 `secret_values`(0151)에 암호화해 두는 **저장 값**이 기본이다. 배포가 들고 있는 env·Secrets Manager 참조(**외부 참조**)는 운영자 CLI로만 만들 수 있고, 콘솔은 그것을 보이고 사용 중지만 한다. 그래서 #897이 막은 "콘솔 쓰기로 운영자 키를 임의 endpoint에 묶기"는 계속 막힌다.
4. **설치 경계는 env에 남는다.** 카탈로그가 아니라 배포의 격리를 정하는 값이다: `PLATFORM_SECRET_KEY`(이제 필수), egress 허용 목록(`EGRESS_CREDENTIAL_ALLOWLIST` 등), `PLATFORM_ALLOW_UNATTENDED_PERMISSIONS`, 설치 한도, worker 이미지.
5. **GitOps·재해 복구·환경 복제는 설정 내보내기/가져오기로 한다.** 비밀 값이 없는 JSON 문서 하나를 API·CLI로 내보내고 가져온다. 개발·E2E·verify 스택의 fixture도 이 문서다. 서버는 파일을 열지 않고, 문서는 가져오기 명령의 입력일 뿐이다.
6. **`catalogRevision`과 `catalog_authority`를 지운다.** 둘은 replica마다 다른 파일을 읽을 수 있어서 생긴 장치다. 모든 replica가 같은 DB를 읽으면 차이는 새로 읽기 전의 지연뿐이고, 그것은 #992·PD-3이 이미 쓰는 "아직 모르면 실패시키지 않고 넘긴다" 규칙이 막는다.
7. **한 번에 옮긴다.** 기존 파일은 같은 릴리스의 가져오기 CLI가 한 번 DB로 옮기고(helm은 pre-upgrade migrate job, compose는 migrate 서비스), 서버의 파일 로더는 같은 릴리스에서 지운다. 단계 나눔은 PR(리뷰 크기)로만 하고 릴리스는 하나다.

## 지금 구조

| 파일 | 담는 것 | 누가 언제 바꾸나 | 비밀값 | DB와 겹침 |
|---|---|---|---|---|
| `connections.yaml` (필수) | provider 연결: `kind`(anthropic·litellm), `endpoint`, `billing`, `auth` 참조 (`packages/platform/src/sessions/catalog.ts:119-143`) | 운영자, 파일 수정 + 재배포 | `value_env`·`secret_id` 참조. 기동 때 모두 풀려야 뜬다(`catalog-config.ts:267-325`, `loadProfileSources`) | 상한(`installation_profiles`)이 `connection_id`로 고르고 provider를 복사한다(`packages/platform/src/sessions/installation-profiles.ts:115-140`). 선택지는 파일에서 온다(`installation-profiles.ts:160-181`) |
| `repositories.yaml` (필수) | 저장소: `url`, `branch`, 시드용 `profiles`, `auth`(basic·bearer·github_app) (`catalog.ts:323`) | 운영자, 재배포 | basic·bearer는 참조, `github_app`은 등록 App | #992가 `{kind: github_app}` 항목을 `catalog_repositories`로 옮기는 중. 비밀 참조 저장소는 파일에 남긴다고 정했다 |
| `mcp-servers.yaml` (선택) | 원격 MCP 서버: `url`, `credential_ref`, bearer `secret_id`, 허용 `workspaces` (`catalog.ts:362-377`) | 운영자, 재배포 | `secret_id` 참조 | 없음. 저장소에 실린 것은 `config/fake-model/` 하나 |
| `profiles.yaml` (선택) | 빈 `installation_profiles` 시드 | 첫 기동 한 번 | provider 참조(연결과 같아야 돈다) | PD-5부터 DB가 정본. 시드만 남음 |
| `platform.yaml` (선택) | master key 참조(`catalog-config.ts:417-456`, `loadSecretKey`) | 운영자 | 참조 | 없으면 env `PLATFORM_SECRET_KEY`를 읽는다 |

파일을 읽거나 만드는 곳(조사 결과, `d90b26731`):

- 런타임: `apps/control-host/src/api/server.ts:262-378`(적재·시드), `:690`, `:734-747`; `apps/control-host/src/slack/main.ts:129-132`; `apps/control-host/src/api/slack-app.ts:58`, `:331`; `apps/control-host/src/api/demo-data.ts:761-764`; `apps/control-host/src/api/profiles.ts:8-29`(`connections-from-yaml` CLI); `scripts/lib/checkpoint-pins-cli.ts:68-87`; `scripts/lib/test-ops.ts:139-158`(디렉터리 전체를 해시해 배포 manifest에 넣음).
- 배포: helm `templates/catalog-configmap.yaml:8-13`, `values.yaml:89-125`, `api.yaml:17`, `:100-107`, `slack.yaml:20`, `:91-98`; `deploy/kind/up.sh:200-215`; `infra/compose.core.yml:320-340`, `:597-600`, `compose.fake-model.yml`, `compose.fake-model-unattended.yml`, `compose.local-model.yml`, `compose.test-ops.yml`; `.github/scripts/image-smoke.sh:50-113`; `scripts/d2-gate/compose.yml`.
- 테스트·검증: `tests/e2e/run.sh:80-84`(`config/local-model/profiles.yaml`을 읽음), `:222-231`(보고용으로 profiles.yaml을 `sed -n`으로 읽음), `tests/e2e/remote-mcp.e2e.ts:19`, `tests/images.test.ts`, `tests/test-ops.test.ts:361-456`, control-host 통합·단위 테스트, verify 스킬(`SKILL.md:53`, `github-sandbox/overlay.yml:10-11`이 자기 `repositories.yaml`을 덮어 mount).
- 문서: `docs/operator/api-server.md:35-60`, `:110`, `:137`, `:232-234`, `:737-746`, `:912`, `configuration.md:3`, `test-ops.md`, `kubernetes-deployment.md:90`, `backup-restore.md:134`, `docs/real-claude.md`, `docs/contributing/architecture.md:27`, `apps/docs`의 `integrations/github*.mdx:10`, `agents/run-profiles*.mdx:6`, 콘솔 문구 `apps/web/src/i18n/github.ts:65`, `:260`, `:456`.

`catalogRevision`(`catalog.ts:1295-1314`)은 파일에서 온 프로필·저장소를 해시하고, `catalog_authority`(`docs/operator/api-server.md:57`, `apps/control-host/src/api/catalog-authority.ts`)는 운영자가 활성화한 revision과 같은 replica만 세션을 `catalog_mismatch`로 실패시키게 한다(`packages/db/src/worker-unit-of-work.ts:1083-1135`). 콘솔 상한은 이미 이 해시에서 빠져 있다.

## 1. 데이터 모델

설치에 워크스페이스는 하나다(`profile-db.md` 운영자 절). 그래도 `secret_values`가 `workspace_id`를 요구하므로(`0151_secret_values.sql`) 비밀 값은 기본 워크스페이스 아래 둔다. 설정 행 자체는 설치 단위이고 워크스페이스 열을 두지 않는다(#992와 같다).

### `provider_connections` (새 테이블)

| 열 | 규칙 |
|---|---|
| `id` text PK | 연결 id. 가져온 것은 YAML id 그대로. 다시 쓰지 않는다 |
| `definition` jsonb | `catalogProviderSchema` 항목 그대로(`kind`, `endpoint`, `billing`, `auth`). 상한의 `definition.provider`와 canonical JSON으로 같아야 돈다(PD-5 규칙 유지) |
| `credential_source` text | `stored` 또는 `external`. `stored`면 `definition.auth`는 `{ kind, stored: "connection:<id>" }`이고 값은 `secret_values`(purpose `settings_credential`, owner_ref `connection:<id>`)에 있다. 참조가 자기 행을 가리키지 않으면 그 행은 읽지 않는다. `{ stored: true }`로 두면 kind·endpoint·billing이 같은 두 연결의 정의가 같아져, 상한이 provider의 canonical JSON으로 연결을 찾을 때(`installationProfileSnapshot`) 어느 값을 쓸지 가리지 못한다(S1에서 Codex와 정함). `external`이면 `value_env`·`secret_id` 하나. `origin = console`이면 `stored`만 된다(CHECK) |
| `origin` text | `import`·`console` |
| `disabled_at/by` | 사용 중지. 그 위 상한은 `connection_missing`과 같은 상태(`connection_disabled`)로 아무것도 돌리지 않는다. 회수 수단이다 |
| `created_at/by` | 감사 |

- 행은 바뀌지 않는다. endpoint·kind·billing·자격 증명 출처를 바꾸려면 새 연결을 만들고 상한 새 버전을 그 위에 만든다. 상한의 지문이 provider를 포함하므로(`profileFingerprint`, `catalog.ts:1078`) 제자리 수정은 그 위의 세션·release를 모두 멈춘다.
- 저장 값의 회전은 `secret_values.secret_version`만 올린다. 지문은 값을 빼고 계산하므로(`profile-db.md` 회수 절) 도는 세션은 멈추지 않는다.

### `catalog_repositories` (#992 테이블을 넓힌다)

- #992가 둔 `{ kind: github_app }` 행에 더해 `auth_kind`가 `none`(공개 저장소)·`basic`·`bearer`·`github_app_explicit`(아래 명시 App, 늘 `external`)인 행을 받는다. `basic`·`bearer`도 `stored`(값은 `secret_values`, owner_ref `repository:<id>`) 또는 `external`이다.
- `app_id`·`installation_id`(·`api_base`)를 적은 옛 `github_app` 항목(명시 App)은 객체를 그대로 둔 `external` 행으로 가져온다. 키 참조가 들어 있어 운영자 CLI만 만들 수 있다. `{ kind: github_app }`으로 바꾸면 `repositoryBinding`이 바뀌고(`withoutRepositorySecret`은 `value`만 뺀다, `catalog.ts:1042-1048`), 등록 App은 github.com만 받으므로(`catalog.ts:338-352`) GHES 항목은 갈 곳이 없어진다. 그래서 바꾸지 않는다.
- URL·자격 증명 출처는 바꾸지 않는다. 기본 브랜치는 #992처럼 버전을 올려 바꾼다. 저장소 객체의 모양은 YAML에서 읽은 것과 같게 만들어 `repositoryBinding`(`catalog.ts:1277`)이 가져오기로 바뀌지 않게 한다.
- URL을 받는 콘솔 추가는 `none`·`basic`·`bearer`에만 연다(GitHub App은 1.1절처럼 설치 목록에서 고르고 따로 추가하지 않는다). URL 규칙은 지금 스키마 그대로다(http(s), userinfo·query 없음).

### 1.1 GitHub App 저장소: 등록 없이 설치 목록이 정본

작성용 App이 닿는 저장소는 GitHub이 이미 안다(`GET /installation/repositories`). 이것을 콘솔에서 한 번 더 등록하게 하면 같은 목록을 두 곳에서 관리한다. 그래서:

- **상한이 먼저다:** 상한(`installation_profiles`)은 지금 `repository_ids`를 나열해야 에이전트가 그 저장소를 고를 수 있고(`allowedPair` → `profileAllowsRepository`, `catalog.ts:967-979`), 나열은 카탈로그에 이미 있는 id만 받는다(`installation-profiles.ts:206-215`). 그대로 두면 등록 없는 저장소는 영영 고를 수 없다. 그래서 상한 행에 열 `github_app_repositories`(`listed`·`installed`)를 더한다. `installed`는 "작성용 App이 닿는 GitHub App 저장소는 모두 허용"이다. 이 열은 `repository_ids`처럼 정의(`catalogProfileConfigSchema`) 밖의 열이라 지문(`definitionFingerprint`, `installation-profiles.ts:225-234`)에 들지 않고, 상한의 새 버전으로만 바뀐다. 기존 행은 `listed`로 채운다. 지문이 그대로인지는 S0의 테스트로 보인다. 콘솔에서 처음 만드는 상한의 기본값은 `installed`다(오너 결정 6을 따르는 기본값이다. 아래 "권한 경계가 넓어지는 곳"의 결과를 상한 폼의 그 선택지 옆에 적는다). 기존 상한의 새 버전은 앞 버전의 값을 그대로 이어받아, 상한을 고치는 것만으로 범위가 넓어지지 않는다.
- **`installed`가 허용하는 것:** `allowedPair`는 GitHub에 묻지 않는 동기 검사다. `installed`는 카탈로그에 있는 행 가운데 `auth`가 `{ kind: "github_app", registered: true }`인 것(해석 행·#992 행)만 허용한다. PAT·공개 저장소·명시 App 항목은 늘 `repository_ids` 나열로만 허용한다. 해석 행이 설치에서 빠지면 토큰 발급이 실패하는 지금 경로가 실행을 막으므로 claim에서 설치를 다시 묻지 않는다.
- **목록(관리 화면):** `GET /v1/workspaces/{id}/github-repositories?installation_id=&page=&per_page=`(`workspace.manage`)가 작성용 App 설치 하나의 저장소를 GitHub 페이지 그대로 준다(`per_page` 최대 100, GitHub의 `total_count`). `installation_id`가 없으면 account 이름순 첫 설치다. 행마다 GitHub id, `owner/name`, 기본 브랜치, 비공개 여부, 해석된 카탈로그 id(없으면 null), 쓰는 에이전트 수(활성 release의 `policy_pins.github.repositories`에 그 id가 있는 에이전트). `installations`를 함께 준다. 같은 화면에 "선택됐지만 설치 밖" 목록(해석 행 가운데 지금 설치가 닿지 않는 것)을 따로 보인다. 이것은 해석 행마다 `installationFor`를 한 번 불러 계산하고, 한 요청에 100행까지만 묻는다(넘는 행은 `installed: null`, "확인 안 됨"). 그리고 기본 브랜치 변경(#992 `PATCH`)은 해석 행 어디서나 된다. 이 응답은 #992의 같은 경로·operationId `listGitHubRepositories`의 모양을 바꾼다(아직 릴리스 전). 검색은 LATER.
- **목록(에이전트 화면):** 에이전트 GitHub 탭의 `options.repositories`는 지금 카탈로그 전체를 나열한다(`agent-github-service.ts:119-128`). 이것을 `GET /v1/agents/{id}/github/repositories?installation_id=&page=&per_page=`(`agent.manage`)로 바꾼다. 활성 release 상한이 `installed`면 설치 페이지를, `listed`면 그 상한이 나열한 저장소를 준다. 행마다 `available`·`reason`·역할별 `installed`는 지금 모양을 따른다.
- **고르기:** `POST /v1/agents/{id}/github/repositories`(`agent.manage`, 콘솔 세션 cookie만) `{ installation_id, github_repository_id }` → `{ catalog_id }`. 서버는 (1) 상한이 `installed`인지 먼저 확인하고(아니면 400 `repository_not_allowed`, 행을 만들지 않는다), (2) 그 설치의 토큰으로 `GET /repositories/{id}`를 불러 owner/name을 얻은 뒤, App JWT로 `GET /repos/{owner}/{repo}/installation`(`forge-github.ts`의 `installationFor`)을 불러 그 설치 id가 요청의 `installation_id`와 같은지 확인하고(설치 토큰은 공개 저장소를 설치 밖이어도 읽으므로 첫 호출만으로는 부족하다. 다르거나 404면 400 `not_installed`), (3) 해석 행을 찾거나 만든다. 콘솔은 받은 id를 지금처럼 release의 `github.repositories`(최대 32개)에 넣어 `POST /v1/agents/{id}/releases`로 저장한다. release 계약은 바뀌지 않는다.
- **해석 행:** 세션·release·상한은 카탈로그 id 문자열로 저장소를 가리키고 `repositoryBinding`은 url·branch로 계산되므로 객체가 고정돼야 한다. 그래서 처음 고를 때 `catalog_repositories`에 행 하나를 만든다: `source: selection`(CHECK에 값을 더하는 migration이 S0에 든다), id는 #992의 `repositoryIdBase` 규칙, URL `https://github.com/{owner}/{name}.git`, 브랜치는 그때의 GitHub 기본 브랜치. 찾기는 제거되지 않은 행(`removed_at IS NULL`)에서 `github_repository_id`, 없으면 `lower(owner)/lower(name)`로 한다. 이름으로 찾은 #992 시드 행의 `github_repository_id`가 비어 있으면 채운다. 같은 저장소를 동시에 처음 고르는 두 요청은 `INSERT … ON CONFLICT DO NOTHING` 뒤 다시 읽어 같은 행을 받는다. 다른 저장소가 같은 id를 먼저 가져가 PK가 부딪히면 다음 접미사(`-2`, `-3`, …)로 다시 넣는다. 행은 지우지 않는다. receipt `resolve_repository`(새로 만들 때만).
- **추가·제거 없음:** #992의 `POST`·`DELETE …/github-repositories`와 `…/candidates`를 지운다. `forge-github.ts`에서 없어지는 것은 `installationRepositories`의 전체 반복 읽기뿐이고 `GET /app/installations` 반복(`MAX_INSTALLATION_PAGES`)은 남는다. PAT·공개 저장소 추가(S3)만 URL을 받는다.
- **#992에서 넘어온 행:** `seed`·`console` 행은 그대로 해석 행으로 쓴다. id와 객체가 같으므로 진행 중 세션의 binding은 바뀌지 않는다.
- **권한 경계가 넓어지는 곳:** #992에서는 owner·admin만 카탈로그에 저장소를 더했다. 이제 에이전트 관리자(`agent.manage`, 에이전트별 관리자라면 member도)가 고르기로 해석 행을 만든다. 이것은 owner가 상한을 `installed`로 둔 경우에만 열리고, 만드는 행은 App이 이미 닿는 저장소를 고정한 기록일 뿐 상한 밖의 실행 권한을 주지 않는다. 대신 그 에이전트 관리자는 설치가 닿는 비공개 저장소 이름을 본다. owner가 이것을 원하지 않으면 상한을 `listed`로 둔다.
- **문구:** #992가 land한 저장소 화면 문구(`apps/web/src/i18n/github.ts`)는 S0가 페이지 목록·선택 모델에 맞게 바꾼다. #992 카드와 나눈 범위다.

### `mcp_servers` (새 테이블)

| 열 | 규칙 |
|---|---|
| `id` text PK | 서버 id(`mcpServerIdSchema`). `github`은 예약(`catalog.ts:398-401`) |
| `url` text | 바꾸지 않는다 |
| `credential_ref` text | 에이전트 카드의 `credential_refs`와 맞춰 보는 이름(`packages/platform/src/agents/release-ids.ts:175-200`). 바꾸지 않는다 |
| `credential_source` | `stored`(`secret_values`, owner_ref `mcp:<id>`) 또는 `external`(`secret_id`) |
| `workspaces` jsonb | 지금의 `workspaces`(slug) 그대로. 허용 검사가 slug로 맞춰 보고(`mcp-egress.ts`), slug는 바뀌지 않으며, 가져오기가 워크스페이스보다 먼저 돌 수 있어서 id로 바꾸지 않는다(S1에서 Codex와 정함). 이 칸만 제자리에서 고칠 수 있다 |
| `disabled_at/by`, `created_at/by`, `origin` | 연결과 같다 |

release id에는 MCP 서버가 들지 않는다(`deriveReleaseId`, `release-ids.ts:63-77`). release 생성은 카드가 이름으로 가리킨 서버가 있는지와 `credential_ref`만 검사하고(`release-ids.ts:175-200`), claim이 그때의 카탈로그에서 서버를 찾아 `mcpBinding`을 만든다(`packages/platform/src/workers/worker-gateway.ts:723-730`). 그래서 행을 제자리에서 고치면 진행 중 세션의 다음 claim이 다른 서버를 받는다. 이것을 막으려고:

- `url`·`credential_ref`·자격 출처는 바꾸지 않는다. 바꾸려면 새 id로 만들고 카드를 새 release로 옮긴다.
- `workspaces`는 `mcpBinding`에 들지 않는다(`release_id`·`server_id`·`url`·`credential_ref`만 해시한다, `catalog.ts:610-622`). 그래서 이 칸만 제자리에서 고친다.
- 가져온 행이 YAML과 같은 객체로 풀려 binding이 같은지 S1이 테스트로 보인다.
- release에 MCP 서버 버전을 명시적으로 고정할지는 LATER로 둔다(Codex 의견, 아래 합의·이견).

### 지우는 것

- `profiles.yaml` 시드: 빈 설치는 상한 0개로 뜬다. 첫 상한은 콘솔에서 만든다(아래 첫 기동).
- `platform.yaml`: master key는 env `PLATFORM_SECRET_KEY`만 읽는다. helm은 이미 ExternalSecret을 env로 넘길 수 있다(`deploy/helm/werft/templates/external-secret.yaml`). 저장 값이 생기므로 비밀 저장소는 꺼질 수 없다. 키가 없으면 기동을 거부한다(지금은 503으로 기능만 끈다, `docs/operator/api-server.md:745`).
- `catalogRevision`, `catalog_authority` 테이블과 CLI, `connections-from-yaml` CLI, `test-ops`의 디렉터리 해시(설정 내보내기 digest로 바꾼다).

## 2. 자격 증명과 보안 경계

#897과 profile-db.md가 연결을 파일에 둔 이유는 하나다: 콘솔 쓰기가 endpoint와 **운영자의 자격 증명 참조**를 묶을 수 있으면, 콘솔 권한을 가진 사람이 운영자 키를 자기 서버로 보낼 수 있다. 이 문서는 그 이유를 지키면서 파일을 없앤다.

| 경로 | 무엇을 만들 수 있나 | 왜 안전한가 |
|---|---|---|
| 콘솔·API(owner cookie) | `stored` 연결·저장소·MCP 서버. 값은 쓰는 사람이 입력한다 | 쓰는 사람이 가진 키만 쓴다. 다른 사람이 넣은 값을 새 endpoint로 옮길 길이 없다(값은 owner_ref로 행 하나에 묶이고, 행의 endpoint는 바뀌지 않는다) |
| 운영자 CLI(`settings import`, DB 접속 권한) | `external` 항목도 | env·Secrets Manager를 가진 사람은 배포 권한자다. 지금 파일을 고치는 사람과 같은 신뢰 주체 |
| 콘솔에서 `external` 항목 | 보기, 사용 중지 | 새 참조를 들이거나 endpoint를 바꾸지 못한다 |

이 경계의 본체는 **값과 목적지가 한 행에 묶이고 그 목적지가 바뀌지 않는 것**이다. egress 허용 목록은 보조 벽일 뿐이다. proxy의 자격 증명 route는 `EGRESS_CREDENTIAL_ALLOWLIST`와 일반 `EGRESS_ALLOWLIST`를 합친 host·port 목록으로 upstream을 연다(`apps/egress-proxy/src/config.ts:141-148`, `apps/egress-proxy/src/main.ts:44-45`). host 단위라 "이 키는 이 목적지에만"을 보장하지 못한다. 그래서 외부 참조를 콘솔에 열지 않는 규칙을 허용 목록으로 대신하지 않는다. 콘솔 저장 때 endpoint host가 자격 증명 허용 목록에 없으면 경고를 보인다(API는 proxy의 env를 모르므로 막지는 못한다. 같은 값을 API에도 주면 막을 수 있지만 오너 결정 4로 경고만 한다).

`secret_values`는 `workspace_id` FK를 요구한다(`0151_secret_values.sql`). 설치 단위 설정의 비밀 값을 기본 워크스페이스 아래 두는 것은 설치에 워크스페이스가 하나라는 지금 전제에 기댄다. S1은 owner_ref 접두(`connection:`·`repository:`·`mcp:`)를 워크스페이스 API가 읽거나 지우지 못하게 막고, 워크스페이스가 둘 이상이 되는 날 설치 소유 범위를 따로 둔다.

## 3. 권한

| 설정 | action | 역할 | API key |
|---|---|---|---|
| 연결 만들기·사용 중지·값 회전 | `installation.settings.manage`(새, `profile.installation.manage`와 같이 `["owner"]`) | owner | 불가 |
| MCP 서버 | 같음 | owner | 불가 |
| 저장소(PAT·공개 추가, 브랜치 변경, GitHub App 설치 목록 보기) | #992의 `workspace.manage` | owner·admin | 불가 |
| 에이전트 GitHub 탭의 저장소 목록·고르기(해석 행 생성) | `agent.manage`, 상한이 `installed`일 때만 | owner·admin·그 에이전트의 관리자 | 불가(콘솔 세션 cookie만) |
| 설정 내보내기 | `installation.settings.manage` | owner | 불가(LATER: 읽기 전용 scope) |
| 설정 가져오기(API) | 같음 | owner | 불가 |

- 관리 action은 API key가 가질 수 없다(`packages/platform/src/musterrolle/policy.ts:244-266`). 2026-11-01 오너 결정 (가)(에이전트 key도 발급 때 필요한 scope를 골라 받는다)는 세션·승인 scope에 관한 것이고 관리 action을 key에 여는 결정이 아니다. 이 문서도 관리 action을 key에 열지 않는다. CI에서 설정을 적용하는 GitOps용 key scope는 [대안](#대안)의 LATER로 둔다.

## 4. 첫 기동·개발·검증

- **빈 설치:** 연결 0, 상한 0, 저장소 0으로 뜬다. 콘솔 첫 화면(owner)에 "연결 추가 → 실행 상한 만들기 → 저장소 추가" 순서의 빈 상태 안내를 둔다. 세션 생성은 상한이 없으므로 지금의 `400`/선택지 없음과 같다.
- **개발 스택(`scripts/local.sh`)·E2E·verify·kind·image-smoke·d2-gate:** `config/**` YAML을 설정 문서 JSON(`tests/fixtures/settings/<stack>.json` 등)으로 바꾸고, compose `migrate` 서비스(`infra/compose.core.yml:106`) 뒤에 `settings import --document <file>`를 한 번 돌린다. 문서에는 비밀 값이 없다. fake-model 연결은 `external`(`value_env`)로 compose가 주는 가짜 값을 가리키고, 실모델 스택은 지금처럼 caller의 `ANTHROPIC_API_KEY`를 env로 넘긴다. `tests/e2e/run.sh`가 profiles.yaml에서 읽던 값은 설정 문서에서 읽는다.
- **verify 스킬의 GitHub sandbox:** 자기 `repositories.yaml`을 mount하던 overlay 대신, 상한을 `installed`로 두고 에이전트 GitHub 탭에서 `github_repository_id`로 고르거나(1.1절) 설정 문서로 가져온다.
- **빈 설치 안내의 순서:** "연결 → 상한 → 저장소"에서 콘솔이 만드는 상한은 `installed`가 기본이라 GitHub App 저장소는 상한을 다시 만들지 않고 고를 수 있다. PAT·공개 저장소는 `listed` 나열이 필요하므로 그것을 더한 뒤 상한의 새 버전을 낸다고 안내 문구에 적는다.

## 5. 이전(한 번에)

1. 같은 릴리스에 `bun run settings import --from-dir <옛 디렉터리>`를 둔다. 옛 다섯 파일을 지금 스키마로 읽어 설정 문서로 바꾼 뒤 DB에 넣는다. id를 그대로 쓰고 `ON CONFLICT DO NOTHING`이라 여러 번 돌아도 같다. 넣은 행마다 receipt `import_*`(주체: 시스템). 이미 있는 id의 내용이 다르면 멈추고 그 id를 보고한다(덮어쓰지 않는다).
2. helm: `migrate-job`은 이미 `pre-install,pre-upgrade` 훅이다(`deploy/helm/werft/templates/migrate-job.yaml:12`). 새 chart는 이 job이 옛 ConfigMap `<fullname>-catalog`을 `optional: true`로 mount해 가져오기를 돌린 뒤, 같은 릴리스의 템플릿에서 ConfigMap을 지운다. pre-upgrade 훅이 옛 리소스가 지워지기 전에 도는지는 구현 PR이 kind에서 실측한다(미확인).
3. compose: `migrate` 서비스가 옛 `config/` mount가 있으면 같은 가져오기를 돈다. 저장소의 `config/` 디렉터리는 지운다.
4. 새 API 이미지는 파일 로더가 없다. `PLATFORM_CONFIG_DIR`가 있으면 "가져오기를 끝내고 변수를 지운다"는 메시지로 기동을 거부한다.
5. 롤링 업데이트 중 옛 replica는 파일을, 새 replica는 DB를 읽는다. 가져오기가 같은 객체를 만들므로 지문·binding·release id가 같다. 이 창에서 파일이나 콘솔 설정을 바꾸지 않는다(운영 문서에 적는다).

### 되돌리기

- 마이그레이션은 테이블을 더할 뿐이다. 앞 이미지로 되돌리면 앞 이미지는 옛 ConfigMap·파일을 다시 읽어야 한다. helm 롤백은 옛 ConfigMap을 되살리므로 그대로 뜬다. 다만 콘솔에서 새로 만든 연결·저장소·MCP 서버와 그 위의 상한은 앞 이미지에 없으므로 `connection_missing`·`catalog_mismatch`가 된다. profile-db.md 5절처럼 오너가 파괴적 변경을 허용한 범위(2026-10-28)로 본다.
- 앞으로 돌아오면 테이블에 행이 있으므로 가져오기는 아무것도 하지 않는다.

## 6. 설정 내보내기/가져오기

- `GET /v1/installation/settings/export`: 연결·저장소·MCP 서버·실행 상한·워크스페이스 판의 정의. 비밀 값은 없고 `stored`는 `{ stored: true, last4 }`만, `external`은 참조 이름만. 문서 digest를 함께 낸다.
- `POST /v1/installation/settings/import`(owner cookie): 문서의 없는 id만 더한다. `external` 참조가 새로 나오면 거절한다(그것은 CLI만). `stored` 항목은 값이 없으므로 "값 필요" 상태로 들어가고 콘솔에서 값을 넣어야 돈다.
- CLI `settings import`·`settings export`: DB에 직접 붙는 운영자 도구. `external`을 받는다. `--dry-run`은 더할 것·충돌·값 필요 항목을 보인다.
- 이것으로 하는 일: 저장소에 문서를 두고 PR 리뷰 뒤 `settings import --dry-run`/적용(GitOps 비슷한 흐름), DB 백업과 별도로 설정만 복구, 스테이징→운영 복제.
- **S2 구현에서 좁힌 것.** 문서 v1에는 연결·저장소·MCP 서버만 있다. 실행 상한과 워크스페이스 판은 넣지 않았다. 상한의 도구 목록은 이제 deny로도 저장되므로 지금 모양을 새 계약으로 굳히지 않는다. 상한은 콘솔과 `POST /v1/installation-profiles`로 다룬다. 형식과 명령은 [운영 문서](../../operator/api-server.md#설정-문서-가져오기내보내기)에 있다.
- **S4 구현에서 정한 것.**
  - 예시 스택은 상한도 있어야 도므로 CLI 문서만 최상위 `profiles`를 받는다(`parseSeedDocument`). 빈 표에만 들어가고 API는 이 키를 거절하며 내보내기에도 나오지 않는다. 운영 설치의 빈 DB에는 기본 프로필이 없고 콘솔에서 만든다.
  - `catalog_authority` 표는 이번 릴리스에서 지우지 않는다. 코드 참조만 없애고, 롤링 중인 앞 이미지가 읽을 수 있게 호환을 끊는 다음 릴리스에서 DROP한다. 완료 조건의 "catalog_authority 제거"에서 벗어난 부분이다.
  - `--if-present`는 디렉터리가 없거나 빈 경우만 건너뛴다. 일부만 있거나 깨진 디렉터리는 실패한다.
  - `settings_generation`이 없는 claim(설정을 읽지 못한 호스트)은 상한이 차단됐을 때만 세션을 실패시킨다.
  - `value_env`·`secret_id` 참조는 파일이 없어져도 남는다. CLI로 가져온 운영자 참조다.
  - 기존 `origin = 'catalog'` 행은 그대로 둔다. 차단·`connection_missing` 상태가 유지되고, 옮기는 동안 사라지거나 살아나지 않는다.
- **S2 뒤 되돌리기 하한.** 가져오기는 GitHub App이 아닌 `catalog_repositories` 행을 쓴다. 이런 행이 생긴 DB는 S1(migration 0225) 앞 이미지로 되돌리지 않는다. 앞 이미지는 `auth_kind`를 모르므로 그 행을 GitHub App 저장소로 읽는다.

## 7. 위험

| 위험 | 크기 | 대응 |
|---|---|---|
| GitOps식 리뷰를 잃는다(파일 diff·PR이 설정 변경의 기록이었다) | 중 | 모든 쓰기에 receipt, 내보내기 문서를 저장소에 두고 diff로 리뷰할 수 있다. 다만 "PR이 머지돼야만 바뀐다"는 강제는 사라진다. 강제가 필요하면 콘솔 쓰기를 끄는 env(`PLATFORM_SETTINGS_READONLY`)를 LATER로 둔다 |
| 재해 복구: DB를 잃으면 설정도 잃는다 | 중 | DB 백업(`docs/operator/backup-restore.md`)에 포함된다. 저장 값은 master key로만 풀리므로 키 백업이 필수다(지금도 GitHub App 키·Slack 토큰이 같다). 내보내기 문서로 값 없는 설정은 따로 복구할 수 있다 |
| 여러 환경 복제 | 소 | 내보내기 → 가져오기. 저장 값은 환경마다 다시 넣는다 |
| owner 한 명이 연결을 지우면 모든 세션이 선다 | 중 | 지우기 없음, 사용 중지만. 위험 구역 확인(#979 패턴). receipt |
| 가져오기가 다른 객체를 만들어 진행 중 세션이 `CATALOG_MISMATCH` | 높음 | 지문·binding·release id 동일성 테스트를 이전 PR의 인수 조건으로. verify 스택에서 업그레이드 전후 덤프 diff |
| `catalog_authority` 삭제 뒤 replica 지연으로 세션 오판 | 중 | 설정 쓰기마다 오르는 DB generation 하나를 두고, claim은 자기 snapshot의 generation이 DB보다 낮으면 세션을 실패시키지 않고 넘긴다. #992·PD-3의 "모르는 행이면 넘긴다"를 연결·MCP까지 넓힌다. 실패시키는 것은 transaction 안에서 읽은 차단·사용 중지 상태뿐이다. 쓰기를 처리한 replica는 커밋 직후 다시 읽는다 |
| 비밀 저장소 필수화로 키 없는 설치가 안 뜬다 | 소 | 릴리스 노트와 기동 메시지. compose는 api·slack에 이 변수를 넘긴다(`infra/compose.core.yml:297`, `:596`). `scripts/local.sh`는 없으면 만들어 프로젝트별로 간직하고, 테스트 스택은 `compose.local.yml`의 개발용 값을 쓴다 |

## 8. PR 나눔 (같은 릴리스, 쌓아서 한 번에 land)

#992가 먼저 들어가야 한다(저장소 테이블을 넓힌다). #992의 결정 문서는 "비밀값을 쓰는 저장소는 운영자 파일에 둔다"와 "콘솔에서 추가·제거한다"고 적으므로, 이 문서가 그 두 문장을 대체한다고 #992 문서 머리에 한 줄 남긴다(S0에서).

| PR | 범위 | 크기 감 |
|---|---|---|
| 결정 문서 | 이 문서(#993) | 문서 |
| S0 | 1.1절: 상한 열 `github_app_repositories`와 `source: selection` migration, 관리·에이전트 화면의 설치 저장소 페이지 API, 고르기 API와 해석 행, `allowedPair`의 `installed`, 콘솔 등록·제거 제거, 저장소 화면·에이전트 GitHub 탭·상한 폼, 문구, OpenAPI·SDK·core 응답 표 | 큼 |
| S1 | DB: `provider_connections`, `mcp_servers`, `catalog_repositories` 확장, store, 레지스트리가 세 테이블을 읽음, 지연 replica 규칙, 지문·binding·release id 동일성 테스트. S4까지 레지스트리는 파일과 DB를 합쳐 읽고 같은 id는 파일이 이긴다(파일만 있는 스택은 그대로 돈다). DB 행의 자격 증명이 이 replica에서 풀리지 않으면 그 행만 빠지고, 그 저장소의 세션은 이 replica가 실패시키지 않는다 | 큼 |
| S2 | 가져오기/내보내기: 설정 문서 스키마, CLI `settings import/export`, API export/import, receipt | 중 |
| S3 | API·콘솔: 연결 화면, MCP 서버 화면, 저장소 화면에 PAT·공개 저장소, 빈 설치 안내, OpenAPI·SDK·core 응답 표 | 큼 |
| S4 | 파일 제거: 로더·`connections-from-yaml`·`catalog_authority`·`catalogRevision`·`platform.yaml`, `PLATFORM_CONFIG_DIR` 거부, helm(ConfigMap 삭제, migrate job 가져오기), compose·kind·image-smoke·d2-gate·test-ops, E2E·verify fixture를 설정 문서로, 문서(ko·en·ja)·콘솔 문구 | 큼 |

## 대안

| 안 | 고르지 않은 이유 |
|---|---|
| 지금처럼 연결·비밀 저장소는 파일 유지(profile-db.md·#992) | 오너 질문에 답하지 못한다. 연결 하나에 재배포 하나가 남는다 |
| 외부 참조도 콘솔에서 만들게 한다 | #897이 막은 위험이 다시 열린다. egress 허용 목록 하나만 벽으로 남는다 |
| 외부 참조를 아예 없애고 저장 값만 | Secrets Manager 회전을 쓰는 설치(EKS alpha)가 키를 DB에 다시 넣어야 한다. 오너 결정 2 |
| 파일을 늘 정본으로 두고 DB에 미러 | 두 곳을 고칠 수 있어 어느 쪽이 맞는지 모른다(#992 대안과 같다) |
| 첫 기동 자동 가져오기(서버가 파일을 한 번 읽음) | 서버에 파일 로더가 남는다. 오너가 원한 "개념 완전 삭제"가 아니다. 대신 migrate 단계의 CLI가 한다 |
| GitOps용 key scope(`settings:write`)로 CI가 적용 | 관리 action을 key에 여는 새 결정이다. LATER |

## Codex 독립 의견 (1회, 2026-11-02)

| 주제 | Codex | 이 문서 | 결과 |
|---|---|---|---|
| 자격 증명 | 기본은 콘솔 입력 값, 외부 비밀은 운영자가 미리 승인한 credential id만, 승인은 credential·용도·목적지를 묶는다 | 저장 값 기본, 외부 참조는 운영자 CLI만 | 합의. 목적지 불변으로 묶음을 표현한다 |
| egress 허용 목록 | host 단위이고 일반 목록과 합쳐지므로 부족 | 처음엔 두 번째 벽으로 적었다 | Codex 지적을 확인하고(`main.ts:44-45`) 보조 벽으로 고쳤다 |
| MCP와 release | release id에 MCP가 없고 claim이 지금 설정으로 binding을 만든다 | 처음엔 release id가 지켜진다고 적었다 | Codex 지적을 확인하고(`release-ids.ts:63-77`, `worker-gateway.ts:723-730`) 고쳤다. release에 MCP 버전 고정은 LATER |
| 수정 모델 | 불변 버전, 회전·차단은 별도 동작 | 같음 | 합의 |
| `catalog_authority` | 역할을 DB generation·불변 버전·transaction 안 차단 확인으로 바꾼 뒤 삭제. 배포 재현용 digest는 남긴다 | 삭제, generation 규칙 추가, test-ops는 내보내기 digest | 합의 |
| 첫 기동·fixture | bootstrap 뒤 같은 설정 API를 부르는 초기화 코드 | 비밀 값 없는 설정 문서를 CLI로 가져오기 | 이견(작음). 둘 다 같은 검증·receipt 경로를 지나면 된다. 문서 쪽이 DR·복제와 한 형식이라 유지한다 |
| 권한 | owner cookie만, `settings:write` key는 열지 않음 | 같음 | 합의 |
| 출시 | PR은 5개로 나누고 설치별 정본 전환은 한 번만, 파일 fallback·이중 쓰기 없음 | PR 4개를 쌓아 한 릴리스 | 합의(나누는 수만 다르다. Codex의 ①신뢰 경계 계약은 S0 이 문서다) |
| `secret_values` 범위 | workspace FK라 설치 소유 범위를 따로 설계해야 한다 | 기본 워크스페이스 아래, 접두로 막음 | 부분 합의. 워크스페이스가 둘이 되는 날 다시 본다 |
| #992 계약 | 비밀값 저장소를 파일에 둔다는 문장부터 고쳐야 한다 | 8절에 대체 문장을 남긴다 | 합의 |

## 오너 결정 (2026-11-02, 추천안 그대로)

1. **한 번에 옮기기**: 예. #992 뒤 S0~S4를 한 릴리스로.
2. **외부 참조(env·Secrets Manager)를 남기나**: 남긴다, 만들기는 운영자 CLI만. 콘솔은 보기·사용 중지.
3. **빈 설치의 시작**: 아무것도 없이 뜨고 콘솔이 안내한다.
4. **API에도 egress 자격 증명 허용 목록을 주어 저장 때 막을지**: 경고만.
5. **GitOps 강제(콘솔 쓰기 끄기 env)**: LATER.
6. **GitHub App 저장소**: 등록하지 않는다. 설치 저장소 API(페이지)가 정본이고 DB에는 에이전트별 선택만 남는다(1.1절).

## DD에 넣을 문장(초안)

- 설치 설정(LLM 연결, 저장소, 원격 MCP 서버, 실행 상한)은 DB에 두고 웹 콘솔에서 관리한다. 설정 파일을 읽지 않는다.
- GitHub App 저장소는 App 설치가 닿는 목록을 그대로 보여 주고, 에이전트마다 쓸 저장소를 고른다. 따로 등록하지 않는다.
- 자격 증명은 콘솔에서 입력해 암호화 저장하거나, 운영자가 배포의 비밀 저장소 참조로 등록한다. 콘솔은 참조를 새로 만들지 못한다.
- egress 허용 목록, master key, 위험 기능 스위치, 설치 한도는 배포 설정(env)이다.
- 설정은 비밀 값 없는 문서로 내보내고 가져올 수 있다. 환경 복제와 리뷰는 이 문서로 한다.
