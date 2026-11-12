# 결정(설계): Musterrolle 코드를 한 모듈 경계로 모으는 순서

- 후속(2026-11-12): `SessionServiceError`는 지금 `packages/platform/src/musterrolle/service-errors.ts`에, `requirePermitted`·`requireAllowed`는 `packages/platform/src/musterrolle/require-permitted.ts`에 있다. 아래 `파일:줄`은 기준 커밋의 기록이다.
- 상태: 일부만 이 문서대로 했다. 공개면 `packages/platform/src/musterrolle/index.ts`(단계 2)는 있다. 오류 class와 권한 helper(단계 4a)는 위 후속 줄의 경로에 있다. DB 구현(단계 6)은 신원·멤버·키·binding이 `packages/db/src/musterrolle/`에, GitHub·Slack 저장소 구현이 `packages/db/src/github/`·`surface/`에 있다. Musterrolle port를 `musterrolle/ports/`로 옮기는 단계 4b와 app 안의 DB 구현을 `packages/db`로 옮기는 단계 5는 하지 않았다. 지금 경계는 `tests/architecture.test.ts`의 A2([패키지 구조화](package-structure.md#5-의존-방향과-강제))와 A6이 지킨다.
- 기준 커밋: `origin/main` `ebe54b10a`. 아래 `파일:줄`과 수는 모두 이 커밋 기준이다.
- 오너 원문(2026-11-02, 오케스트레이터 전달): "8은 미리 먼저 해두는게 좋지 않을까". 같은 날 정한 진행 방식(요지): 단계별 PR 계획 설계 문서를 먼저 쓰고, 진행 중인 다른 작업의 파일을 만지는 단계는 그 작업이 land 된 뒤에 한다.
- 이 문서는 구조와 PR 순서만 정한다. 코드를 옮기는 PR은 아래 단계마다 따로 연다.

## 무엇을 골랐나

1. **새 패키지를 만들지 않는다.** Musterrolle은 지금 패키지 셋과 app 하나에 나뉘어 있고, 그 나눔(계약은 `packages/contracts`, 도메인과 port는 `packages/platform`, DB 구현은 `packages/db`, HTTP는 `apps/control-host`)은 다른 모듈과 같은 층 구조다. 흩어진 것은 층이 아니라 **각 층 안의 경계**다. 그래서 패키지마다 `musterrolle/` 디렉터리 하나를 경계로 삼고, 그 경계를 `tests/architecture.test.ts` 규칙으로 고정한다.
2. **platform 안에서 경계를 넘는 길은 `packages/platform/src/musterrolle/index.ts` 하나다.** Kiel·Kollegium 코드는 Musterrolle 이름을 이 파일에서만 import한다. Musterrolle 쪽은 Kiel·Kollegium 파일을 import하지 않는다. 지금 남은 반대 방향 import는 허용 목록(ratchet)에 적는다. 이 파일은 platform 안의 경계이고, 패키지 공개면인 `packages/platform/src/index.ts`는 지금처럼 파일마다 `export *`를 둔다.
3. **패키지 export 이름은 한 곳에서만 바뀐다.** `@werft-ai/platform`·`@werft-ai/contracts`의 export 이름 집합(type 포함)은 모든 단계에서 그대로다. `@werft-ai/db`는 단계 5에서 control-host에 있던 DB 구현 이름이 더해지는 것 말고는 그대로다(3절). 공개 API 명세(`docs/openapi.json`), SDK, DB 스키마는 어느 단계도 건드리지 않는다. 그래서 HUMAN ONLY 단계는 없다.
4. **순서는 규칙 먼저, 소비자 전환, 그다음 내부 이동.** 첫 PR이 지금 모양을 허용 목록으로 고정한다. 공개면을 먼저 만들고 Kiel·Kollegium의 import를 한 번에 그쪽으로 돌린 뒤 Musterrolle 안에서 파일을 옮기므로, 소비자 파일을 여러 번 고치는 일이 줄어든다. 중간에 멈춰도 그때까지 줄인 만큼은 테스트가 지킨다.

## 1. 지금 코드 위치

### 1.1 층별 위치와 책임

| 층 | 경로 | 책임 | 크기 | 누가 import하나 |
|---|---|---|---|---|
| 계약 | `packages/contracts/src/musterrolle/` (22파일, 테스트 제외) | 인증·권한·워크스페이스·팀·API 키·연동 계정·Slack·GitHub 연동의 Zod 계약 | 한 디렉터리에 모여 있음 | control-host api·routes, `apps/web`(type만), `packages/core`(값도 읽는다, 예: `packages/core/src/schemas/responses.ts:208` `authMeResponseSchema`), `packages/db`, `packages/platform`(musterrolle·ports·sessions·agents·workers), `packages/testkit`. `authorization.ts`는 56파일, `workspaces.ts`는 28파일 |
| 권한 판정 | `packages/platform/src/musterrolle/policy.ts` | `createAuthorizationPolicy`(`policy.ts:396`), `Principal`(`:43`), `Caller`(`:81`), `AuthorizationPolicy`(`:241`) | 744줄 | barrel로 control-host api·routes·slack, `packages/db` 21파일. 상대 경로로 platform `ports/` 17파일, `sessions/` 14파일(`achievements/` 포함), `agents/` 2파일, `usage/` 1파일 |
| 도메인 서비스 | `packages/platform/src/musterrolle/` (테스트 제외 37파일, 테스트 32파일) | 멤버·팀·초대·API 키·연동 계정·세션 공유·에이전트 신원·자격 증명 바인딩·GitHub App·Slack App과 Slack 채널 처리 | 테스트 포함 20,822줄 | control-host `api/`(조립)·`api/routes/`·`slack/`. 서비스마다 2~4파일 |
| 서비스 오류·권한 helper | `packages/platform/src/sessions/session-service.ts` | `SessionServiceError`(`:85`), `requirePermitted`(`:268`), `requireAllowed`(`:279`) | — | platform 62파일(테스트 포함). Musterrolle 24파일(테스트 제외)이 이 파일을 import한다. 패키지 공개는 `src/index.ts:118` `export * from "./sessions/session-service.ts"` |
| 신원 port | `packages/platform/src/ports/identity-store.ts` | `IdentityStore`(`:149`)·`InviteStore`(`:322`) | 352줄 | platform `musterrolle/invite-service.ts`, control-host `api/auth.ts`·`api/app.ts`·`api/routes/auth.ts`·`api/routes/invites.ts` |
| 그 밖의 Musterrolle port | `packages/platform/src/ports/`의 `api-key-store`·`member-store`·`team-store`·`linked-account-store`·`session-share-store`·`agent-identity-store`·`agent-admin-store`·`credential-binding-store`·`surface-binding-store`·`decision-log`·`github-app-store`·`github-settings`·`github-packages`·`workspace-settings`(`SlackGuestSettingStore`)·`slack-*`(6파일) | Musterrolle 서비스가 쓰는 저장 port | 다른 모듈 port와 한 디렉터리에 섞여 있음 | 구현은 `packages/db`. Kiel·Kollegium도 일부를 쓴다: `team-store`(sessions 4파일), `credential-binding-store`(agents·sessions), `github-settings`(agents 2파일), `github-packages`(workers 2파일), `session-share-store`·`api-key-store`(sessions·agents 각 1파일) |
| DB 구현 | `packages/db/src/`의 `identity`·`identity-reader`·`api-keys`·`invites`·`members`·`member-teams`·`linked-accounts`·`session-shares`·`agent-identities`·`agent-admins`·`administers`·`agent-authority`·`authz-decisions`·`credential-bindings`·`surface-bindings`·`slack-*`(6파일)·`github-apps`·`github-oauth`·`github-settings`·`github-packages`·`github-app-manifest-states`·`workspace-settings`, 그리고 `queries.ts:37-248`의 API 키 함수·타입(`createApiKey`·`ApiKeyKind`·`ApiKeyRecord`·`findApiKey`·`touchApiKey`·`ApiKeyRevocation`·`revokeApiKey` 등) | port 구현과 신원 쿼리 | 테스트 제외 27파일, 9,087줄(`queries.ts` 제외). 테이블 정의는 `schema.ts` 한 파일(4,080줄)에 다른 모듈과 함께 있음 | `packages/db/src/index.ts`가 `export *`로 내놓고 control-host `api/server.ts`가 조립한다. `postgres-unit-of-work.ts`가 `credential-bindings`·`session-shares`를 import한다 |
| app 안의 DB 구현 | `apps/control-host/src/api/auth.ts:58` `DatabaseIdentityStore`, `apps/control-host/src/api/keys.ts:25` `ApiKeyStore`·`:34` `NewApiKey`·`:44` `ApiKeyWriter`·`:57` `DatabaseApiKeyStore` | `IdentityStore` port의 DB 구현과, 인증기용 API 키 조회 interface·구현이 app에 있다. 이 interface는 db의 `ApiKeyRecord`·`ApiKeyKind`·`ApiKeyRevocation`을 쓴다 | — | `api/server.ts:1031`·`:1059`, `api/keys.ts:246`(키 CLI) |
| HTTP 경계 | `apps/control-host/src/api/`의 `auth.ts`·`keys.ts`·`google-login.ts`·`scope-policy.ts`·`grants.ts`·`demo-accounts.ts`, `api/routes/`의 `auth`·`api-keys`·`members`·`teams`·`invites`·`workspaces`·`linked-accounts`·`session-shares`·`agent-identities`·`credential-bindings`·`github-*`·`slack-*` | 인증기, 쿠키·CSRF, 로그인 잠금, Google 로그인, scope 판정, 운영자 CLI(`grants`·`keys`), route | — | `api/app.ts`·`api/server.ts`가 조립 |

Musterrolle 소유로 세지 않은 것: `packages/db/src/secret-values.ts`와 `packages/platform/src/ports/secret-store.ts`는 연결 자격 증명(`settings-replace-file-catalog.md`)과 Slack·GitHub 비밀이 함께 쓰는 공용 저장소라 제자리에 둔다.

### 1.2 경계를 거꾸로 넘는 import

Musterrolle이 Kiel·Kollegium 파일을 import하는 곳이다(`packages/platform/src/musterrolle`, 테스트 제외).

| 대상 | import 문 수 | 왜 거꾸로인가 |
|---|---|---|
| `../sessions/session-service.ts` | 24 | `SessionServiceError`·`requirePermitted`가 Kiel 서비스 파일에 있다. `musterrolle/service-errors.ts`도 여기서 오류 class를 가져온다 |
| `../ports/secret-store.ts` | 7 | 공용 비밀 값 port. `secrets/secret-cipher.ts`도 쓴다 |
| `../ports/agent-store.ts` | 3 | Kollegium의 에이전트 저장 port. Slack 채널 처리(`slack-session-handler`·`slack-welcome`)가 쓴다 |
| `../sessions/catalog.ts` | 1 | 카탈로그 타입 |
| `../ports/session-link-store.ts` | 1 | 세션 연결 port(`slack-session-handler`) |
| `../ports/forge.ts` | 1 | GitHub 호출 port(GitHub 저장소 서비스) |
| `../ports/catalog-repository-store.ts` | 1 | 카탈로그 저장소 port(GitHub 저장소 서비스) |

반대로 Kiel·Kollegium 쪽은 Musterrolle 파일을 직접 import한다. `musterrolle/` 밖 platform 36파일에 import 문 44개다(테스트 제외): `ports/` 18파일(17파일이 `policy.ts`의 `Principal`을, `slack-app-store.ts`·`slack-config-token-store.ts`가 `slack-config-api.ts`의 타입을), `sessions/` 14파일, `agents/` 2파일, `usage/`·`testing/` 각 1파일. 이 방향(Kiel → Musterrolle)은 목표 구조에서도 허용하고, 경로만 공개면 하나로 모은다(2.3절 규칙 2). 테스트 파일에도 같은 방향 import가 있다(예: `sessions/session-release-pin.test.ts:10`, `agents/agent-service.test.ts:8`). 테스트는 2.3절 규칙에서 뺀다.

### 1.3 실측 명령

모두 저장소 루트에서 `ebe54b10a`에 대해 돌렸다.

```sh
# 파일과 크기
git ls-files packages/contracts/src/musterrolle packages/platform/src/musterrolle packages/platform/src/ports/identity-store.ts | xargs wc -l
wc -l packages/db/src/{identity,identity-reader,api-keys,invites,members,member-teams,linked-accounts,session-shares,agent-identities,agent-admins,administers,agent-authority,authz-decisions,credential-bindings,surface-bindings,slack-apps,slack-installations,slack-install-states,slack-config-tokens,slack-outbox,slack-inbound-events,github-apps,github-oauth,github-settings,github-packages,github-app-manifest-states,workspace-settings}.ts
grep -n "^export" packages/db/src/queries.ts

# Musterrolle이 바깥 platform 파일을 import하는 곳(1.2 표)
git grep -h -o -E 'from "\.\./[a-z-]+/[a-z-]+\.ts"' -- 'packages/platform/src/musterrolle/*.ts' ':!*.test.ts' | sort | uniq -c | sort -rn

# Kiel·Kollegium이 Musterrolle을 import하는 곳(44줄, 36파일)
git grep -n -E 'from "(\.\./)+musterrolle/' -- packages/platform/src ':!packages/platform/src/musterrolle' ':!*.test.ts'

# Musterrolle port를 쓰는 바깥 platform 파일(port 하나씩)
git grep -l "ports/team-store" -- packages/platform/src ':!*.test.ts' ':!packages/platform/src/musterrolle' ':!packages/platform/src/index.ts'

# port를 구현하는 db 파일(타입 이름 하나씩)
git grep -l -w IdentityStore -- 'packages/db/src/*.ts' ':!*.test.ts'
git grep -l -w IdentityStore -- apps packages ':!*.test.ts'

# 오류 class·권한 helper를 쓰는 platform 파일
git grep -l -E 'SessionServiceError|requirePermitted|requireAllowed' -- packages/platform/src | wc -l

# barrel(@werft-ai/platform, @werft-ai/contracts)로 export를 import하는 파일
# 각 소스 파일의 export 이름을 모으고 `import { … } from "<패키지>"`의 이름과 맞춘다(테스트 제외)
python3 -I importers.py . @werft-ai/platform 'packages/platform/src/musterrolle/*.ts' 'packages/platform/src/ports/identity-store.ts'
python3 -I importers.py . @werft-ai/contracts 'packages/contracts/src/musterrolle/*.ts'
```

`importers.py`는 저장소 밖에서 쓴 일회용 스크립트다. 정규식으로 `export (class|function|const|type|interface|enum) <이름>`과 `import { … } from "<패키지>"`를 맞추므로 `export *`로 다시 내놓은 이름이나 namespace import는 세지 않는다. 그래서 1.1 표의 importer 수는 하한이다.

## 2. 목표 경계

### 2.1 소유와 공개면

| 층 | Musterrolle이 소유하는 곳 | 바깥이 보는 것 |
|---|---|---|
| 계약 | `packages/contracts/src/musterrolle/` (지금 그대로) | `@werft-ai/contracts` barrel. 바뀌지 않는다 |
| 도메인·port | `packages/platform/src/musterrolle/` 아래 `policy.ts`·`authorize.ts`(권한 helper)·서비스·`ports/`(1.1 표의 Musterrolle port) | platform 안: `musterrolle/index.ts`. 패키지 밖: `@werft-ai/platform` barrel(`src/index.ts`), export 이름 그대로 |
| DB 구현 | `packages/db/src/musterrolle/` (1.1 표의 DB 구현 파일, `queries.ts`의 API 키 부분, app 안의 DB 구현) | `@werft-ai/db` barrel. 단계 5에서 이름이 더해지는 것 말고는 그대로 |
| HTTP | `apps/control-host/src/api/` 인증기와 `api/routes/`의 Musterrolle route(위치 그대로) | route 등록과 transport 메타데이터는 control-host가 소유한다(`architecture.md` 패키지 표) |
| 테이블 | `packages/db/src/schema.ts`(위치 그대로) | migration은 이 계획 밖이다 |

`musterrolle/index.ts`는 platform 안의 Kiel·Kollegium 파일이 쓰는 이름만 내놓는다: `Principal`·`Caller`·`AuthorizationPolicy` 등 policy 타입, 권한 helper(`requirePermitted`·`requireAllowed`), `service-errors.ts`의 오류 생성자(`NOT_FOUND`·`ACTOR_INACTIVE`·`OUTRANKED`), Kiel이 읽는 port(`TeamStore`·`CredentialBindingStore`·`SessionShareStore`·`WorkspaceKeyStore`·GitHub 설정·GitHub Packages port), `SlackWelcome`(`agents/agent-service.ts:23`), Slack 타입(`ports/agent-store.ts` 등이 쓰는 `slack-config-api.ts`의 타입). 새 이름은 Kiel 쪽에서 필요할 때 더한다.

패키지 barrel `src/index.ts`는 이 파일을 다시 내놓지 않는다. 지금처럼 Musterrolle 파일마다 `export * from "./musterrolle/<파일>.ts"`를 두고, 파일을 옮기는 단계에서 그 경로만 고친다. 그래서 `service-errors.ts`처럼 패키지 밖에 내놓지 않던 이름이 공개면을 거쳐 새로 새지 않고, 공개면에 넣지 않은 서비스 export도 패키지 밖에서 사라지지 않는다.

### 2.2 의존 방향

```
contracts/musterrolle ◀── platform/musterrolle ◀── platform/{sessions,agents,workers,usage,ports,testing}
        ▲                        ▲  (musterrolle/index.ts만)
        │                        │
        └──── db/musterrolle ────┘ ◀── control-host api·routes·slack (패키지 barrel만)
```

- `platform/musterrolle`이 import할 수 있는 것: `@werft-ai/contracts`, `@werft-ai/runtime-core`, `zod`, 자기 디렉터리, 공용으로 남기는 platform 파일(`service-error.ts`, `ports/secret-store.ts`). 그 밖은 허용 목록에 있어야 한다.
- 공용으로 남기는 것: `SessionServiceError`는 Kiel·Kollegium·Musterrolle 모두의 오류 class라 `packages/platform/src/service-error.ts`로 옮긴다. `secret-store`는 1.1절 끝의 이유로 `ports/`에 둔다.
- 허용 목록에 남는 것: Kollegium의 `agent-store`, `session-link-store`, 카탈로그(`sessions/catalog.ts`·`catalog-repository-store`), `forge`. 모두 Slack 채널 처리나 GitHub 저장소 서비스에서 온다. 이 import를 없애려면 그 파일들이 어느 모듈 것인지부터 정해야 한다(4절).

### 2.3 `tests/architecture.test.ts`와 맞추기

지금 규칙 가운데 이 계획이 닿는 것은 둘이고, 어느 단계도 둘을 바꾸지 않는다.

- "platform depends on contracts, runtime-core and zod only"(`:999`): 새 패키지를 만들지 않고, platform으로 옮기는 코드는 db 타입을 import하지 않는다(단계 5가 API 키 interface를 platform이 아니라 db로 옮기는 이유). 그래서 그대로 성립한다.
- "routes know database-backed errors and records through platform ports"(`:1510`): route는 `@werft-ai/db`를 import하지 않는다. 단계 5가 app 안의 DB 구현을 `packages/db`로 옮기면 `api/` 쪽 DB 코드도 준다.

새로 더하는 규칙은 둘이다(단계 1). 둘 다 테스트 파일(`*.test.ts`)은 검사하지 않는다. 테스트는 검사 대상의 내부 파일을 직접 여는 것이 정상이기 때문이다. `testing/` 아래 helper는 테스트가 아니므로 검사한다.

1. **Musterrolle은 바깥 platform 파일을 허용 목록으로만 import한다.** `packages/platform/src/musterrolle/**`의 상대 import(재export 포함) 대상이 `musterrolle/` 밖이면 허용 목록에 있어야 한다. 목록이 코드보다 길어도 실패한다(`tests/web-ui-allowlist.ts`와 같은 ratchet).
2. **Kiel·Kollegium은 Musterrolle을 `musterrolle/index.ts`로만 import한다.** `packages/platform/src/` 아래 `musterrolle/` 밖 파일이 `musterrolle/<파일>`을 직접 import하면 실패한다. 예외는 패키지 barrel `src/index.ts`(2.1절)와 허용 목록이다. 허용 목록은 1.2절 끝의 import 44개로 시작한다.

검사는 import 지정자를 정규식이 아니라 이 파일의 `parse`(TypeScript AST, 주석·문자열을 코드로 읽지 않는다)로 읽는다. 규칙마다 위반 하나를 일부러 만든 fixture로 검사가 잡는지 확인하는 테스트를 함께 둔다.

## 검토한 다른 모양

- **`packages/musterrolle` 새 패키지.** platform의 Musterrolle 서비스·port를 새 패키지로 빼는 안이다. 고르지 않았다. policy 타입(`Principal`·`Caller`·`AuthorizationPolicy`)을 platform의 port 17파일과 Kiel·Kollegium 서비스 18파일이 쓰므로 platform이 새 패키지에 의존해야 하고, 그러면 `:999` 규칙과 `architecture.md`의 패키지 표를 바꿔야 한다. DB 구현은 `schema.ts` 한 파일과 migration 순서에 묶여 있어 같이 옮길 수 없으니 경계가 여전히 두 패키지에 걸친다. 바깥 import 지정자가 모두 바뀌어 control-host·db에서 수십 파일이 함께 바뀐다. 얻는 것(패키지 단위 의존 검사)은 디렉터리 규칙 둘로도 얻는다.
- **port를 `ports/`에 두고 이름 목록으로 분류.** 파일은 옮기지 않고 테스트에 Musterrolle port 이름 목록만 두는 안이다. 고르지 않았다. 파일 하나만 연 사람은 그 port가 어느 모듈 것인지 알 수 없고, 새 port를 `ports/`에 더하면 목록에 넣는 것을 잊어도 테스트가 통과한다.
- **공개면을 패키지 barrel로도 쓰기**(`src/index.ts`가 `export * from "./musterrolle/index.ts"`). 고르지 않았다. 공개면은 Kiel이 쓰는 이름만 담으므로, barrel로 쓰면 control-host가 쓰는 서비스 export가 빠지거나 `service-errors.ts` 이름이 새로 나간다.

## 3. 단계별 PR

모든 단계에 공통인 증명이다. 단계별 설명의 "증명"은 이것에 더하는 것만 적는다.

- **이동만 했다.** `git diff -M --name-status origin/main...HEAD`에서 옮긴 파일이 `R`로 잡히고, 리뷰어가 patch에서 경로 줄 말고 바뀐 줄이 없는지 본다. 경로 줄은 import·export 지정자와, 파일 위치를 기준으로 다른 파일을 찾는 상대 경로(`import.meta.dir`·`import.meta.url` 기준 경로, 예: `packages/db/src/api-keys.test.ts:20`·`identity.integration.test.ts:23`의 `../migrations`)다. 디렉터리가 한 단계 깊어지면 이 경로에 `../`가 하나 더 붙는다. 유사도 수치만으로는 본문 변경을 걸러내지 못하므로 patch를 직접 읽는다.
- **export 이름 집합이 같다(type 포함).** 단계 전후에 root `typescript`로 각 barrel(`packages/platform/src/index.ts`, `packages/db/src/index.ts`, `packages/contracts/src/index.ts`)을 열고 `checker.getExportsOfModule(checker.getSymbolAtLocation(sourceFile))`의 이름을 정렬해 파일로 받는다. 두 파일의 `diff`가 비어 있어야 한다(단계 5는 3절 표의 db 이름만 더해진다). 런타임 `Object.keys(await import(...))`는 type export를 보지 못하므로 쓰지 않는다. 시그니처가 같다는 것은 이 비교가 아니라 patch에 본문 변경이 없다는 것으로 보인다.
- **공개 API 명세가 같다.** `bun run --cwd apps/control-host openapi:generate` 뒤 `git diff --exit-code docs/openapi.json`이 0이다. 생성기는 route 선언에 빈 handler를 붙여 명세를 만들므로(`apps/control-host/src/api/openapi.ts:6412`), 이것은 명세가 같다는 증명일 뿐 동작 증명이 아니다.
- **테스트가 실제로 돌았다.** root `bun run typecheck`, `bun test tests/architecture.test.ts`, 바뀐 패키지의 `bun test`, `node_modules/.bin/biome check .`. DB를 쓰는 integration 테스트는 DB 설정이 없으면 `describe.skip`으로 건너뛴다(예: `apps/control-host/src/api/auth.integration.test.ts:44`). 그래서 PR CI의 integration domain job(`db`·`api`) 로그에서 실행 파일 수와 pass·skip 수를 단계 전 main 실행과 비교해 PR 본문에 적는다. 로컬에서는 PostgreSQL을 띄우고 migration을 적용한 뒤 돌린다.
- **핀이 되는 테스트.** 옮기는 코드는 본문이 그대로이므로 새 characterization 테스트를 이동 PR보다 먼저 쓰지는 않는다. 단, 단계에 적은 핀 테스트가 그 PR에서 skip 없이 돌았다는 것은 위 로그로 보인다.

| 단계 | 옮기거나 바꾸는 것 | 선행 | 크기 | 공개 API·SDK·DB 스키마 |
|---|---|---|---|---|
| 1. 경계 규칙과 허용 목록 | `tests/architecture.test.ts`에 2.3절 규칙 둘과 지금 import를 담은 허용 목록 | 없음 | S | 닿지 않음 |
| 2. Musterrolle 공개면 | `packages/platform/src/musterrolle/index.ts`를 만든다. 2.1절의 이름을 지금 위치에서 다시 내놓는다(`../sessions/session-service.ts`의 helper, `../ports/`의 Musterrolle port 포함). 소비자는 바꾸지 않는다 | 1 | S | 닿지 않음 |
| 3. 소비자 전환 | Kiel·Kollegium(`sessions/`·`agents/`·`workers/`·`usage/`·`testing/`, Kiel·Kollegium 소유 `ports/`)의 Musterrolle import를 공개면으로 바꾼다: `musterrolle/<파일>` 44개 가운데 Musterrolle port 파일의 것을 뺀 나머지, Musterrolle port import, `requirePermitted`·`requireAllowed` import. 이 단계 뒤에는 단계 4b가 Musterrolle 안에서 파일을 옮겨도 이 파일들의 import는 다시 바뀌지 않는다. 예외는 공개면을 거치지 않는 `SessionServiceError` import로, 단계 4a에서 한 번 더 바뀐다 | 2 | M | 닿지 않음 |
| 4a. 오류 class·권한 helper 제자리로 | `SessionServiceError` → `packages/platform/src/service-error.ts`, `requirePermitted`·`requireAllowed` → `packages/platform/src/musterrolle/authorize.ts`. barrel에 두 파일을 더하고 `session-service.ts`에서 뺀다 | 3 | M | 닿지 않음 |
| 4b. Musterrolle port를 경계 안으로 | 1.1 표의 Musterrolle port 파일(`identity-store`, `github-settings`·`github-packages`·`workspace-settings` 포함)을 `packages/platform/src/musterrolle/ports/`로. 공개면·barrel·Musterrolle 내부의 경로만 바뀐다. 공용 `secret-store`와 Kiel·Kollegium port는 `ports/`에 남는다 | 4a | M | 닿지 않음 |
| 5. app 안의 DB 구현을 db로 | `DatabaseIdentityStore`(`api/auth.ts:58`) → `packages/db/src/musterrolle/identity-store.ts`. `ApiKeyStore`·`NewApiKey`·`ApiKeyWriter`(`api/keys.ts:25-47`)와 `DatabaseApiKeyStore`(`:57-75`) → `packages/db/src/musterrolle/api-key-store.ts`. 키 생성·hash 함수(`:49-56`), 키 CLI 파서(`parseScopes` `:82` 이후), 인증기 본문은 control-host에 남긴다 | 4b | M | 닿지 않음 |
| 6a. 신원·멤버·키 DB 구현 이동 | `packages/db/src/`의 `identity`·`identity-reader`·`api-keys`·`invites`·`members`·`member-teams`·`linked-accounts`·`session-shares`·`administers`·`agent-authority`·`authz-decisions`·`workspace-settings`와 각 테스트 → `packages/db/src/musterrolle/`. `queries.ts:37-248`의 API 키 함수·타입(비공개 helper 포함)을 본문 그대로 `packages/db/src/musterrolle/api-key-queries.ts`로 자른다. `queries.ts:254` 이후의 세션 복구 코드는 남는다 | 5 | M | 닿지 않음 |
| 6b. 연동 DB 구현 이동 | `agent-identities`·`agent-admins`·`credential-bindings`·`surface-bindings`·`slack-*`·`github-apps`·`github-oauth`·`github-settings`·`github-packages`·`github-app-manifest-states`와 각 테스트 → `packages/db/src/musterrolle/` | 6a | M | 닿지 않음 |
| 7. 기여자 문서 | `docs/contributing/architecture.md`의 Musterrolle 줄(`:9`)을 새 경로와 2.3절 규칙으로 고친다 | 6b | S | 닿지 않음 |

단계마다 덧붙이는 내용:

- **단계 1.** 규칙만 더하고 코드는 옮기지 않는다. 증명: 허용 목록이 지금 import와 정확히 같아 테스트가 통과하고, fixture에 목록 밖 import 하나를 넣으면 실패한다. 이후 단계는 자기가 없앤 줄을 목록에서 지운다. 목록이 코드보다 길면 실패하므로 지우는 것을 잊을 수 없다.
- **단계 2.** 공개면이 지금 위치의 파일을 다시 내놓으므로 규칙 1의 허용 목록이 이 재export만큼(`../sessions/session-service.ts`, Musterrolle port 파일) 잠시 늘어난다. 단계 4a·4b가 그 줄을 지운다. Musterrolle port 파일은 `../musterrolle/policy.ts`를 직접 import하고 공개면은 그 port를 다시 내놓는다. 둘 다 `import type`이라 런타임 순환은 생기지 않지만, 이 port 파일들은 단계 4b까지 규칙 2의 허용 목록에 남는다. 증명: 공통 증명만(barrel은 바뀌지 않는다).
- **단계 3.** import 경로만 바뀐다. 증명: 규칙 2의 허용 목록에 Musterrolle port 파일의 직접 import 12개(`policy.ts` 10개, `slack-app-store.ts:10`·`slack-config-token-store.ts:1`의 `slack-config-api.ts` 2개)만 남는다. 핀: `bun test packages/platform`.
- **단계 4a.** 함수 본문은 그대로 옮긴다. 오류 class 이름과 `code` 값은 route 오류 매핑(`api/routes/errors.ts:84`, `instanceof SessionServiceError`)과 응답 본문이 쓰므로 바꾸지 않는다. `SessionServiceError`를 `session-service.ts`에서 import하던 Kiel 파일도 이 단계에서 한 번 더 바뀐다(오류 class는 공용이라 공개면을 거치지 않는다). 증명: barrel이 `./service-error.ts`·`./musterrolle/authorize.ts`를 내놓고 이름 집합이 같다. 핀: `bun test packages/platform apps/control-host`. 규칙 1의 허용 목록에서 `sessions/session-service.ts`가 빠진다.
- **단계 4b.** port 파일 이동과 경로만 바뀐다. 증명: 공통 증명만. 규칙 1·2의 허용 목록에서 Musterrolle port 줄이 빠진다. 옮기는 port가 제자리에 남는 port를 import하는 줄은 이 단계부터 규칙 1의 검사 대상이 된다. `secret-store.ts` import 5개는 공용이라 허용되고, `github-app-store.ts:7`의 `./forge.ts`(`RepoRef`)는 규칙 1의 허용 목록에 더한다(2.2절의 `forge`와 같은 줄기).
- **단계 5.** `@werft-ai/db` export에 `DatabaseIdentityStore`·`ApiKeyStore`·`NewApiKey`·`ApiKeyWriter`·`DatabaseApiKeyStore` 다섯 이름이 더해진다. 이것이 이 계획에서 패키지 export 이름이 바뀌는 유일한 곳이고, 지우는 이름은 없다. API 키 interface를 platform port로 옮기지 않는 이유: interface가 db 소유 타입(`ApiKeyRecord`·`ApiKeyKind`·`ApiKeyRevocation`)을 쓰므로 platform으로 옮기면 platform이 db를 import해 `:999` 규칙을 어기고 패키지 순환이 생긴다. 이 단계는 class 본문을 바꾸지 않는다. 옛 위치에 재export를 남기지 않고, 소비자 import를 모두 `@werft-ai/db`로 바꾼다: 소스 4파일(`api/server.ts`, `api/auth.ts:43`·`api/app.ts:43`의 `ApiKeyStore`, `api/keys.ts`의 키 CLI)과 테스트 22파일(예: `api/auth.integration.test.ts:34·39`, `api/keys.test.ts:3`, `api/app.test.ts:24`, `api/api-keys.integration.test.ts:48·52`). 목록은 `git grep -l -w -E 'ApiKeyStore|ApiKeyWriter|NewApiKey|DatabaseIdentityStore|DatabaseApiKeyStore' -- apps/control-host/src`로 다시 뽑는다. 핀: `apps/control-host/src/api/auth.test.ts`, `auth.integration.test.ts`·`auth-recovery.integration.test.ts`·`api-keys.integration.test.ts`(PostgreSQL에서 skip 없이 돈 것을 `api` domain 로그로 보인다).
- **단계 6a·6b.** 옮긴 파일은 `packages/db/src/index.ts`의 `export *` 경로만 바뀌고 이름은 그대로다. `queries.ts`는 나뉘므로 barrel의 `export * from "./queries.ts"`(`index.ts:50`)를 그대로 두고 `export * from "./musterrolle/api-key-queries.ts"` 한 줄을 더한다. 그래서 `queries.ts`에 남는 `Database`·`reconcileOrphanedSessions` 등과 옮긴 API 키 이름이 모두 barrel에 남는다. db 안에서 옮긴 이름을 `./queries.ts`로 import하던 파일은 새 경로로 고친다. 옮기는 테스트가 `import.meta.dir` 기준으로 여는 `../migrations` 같은 경로도 `../../migrations`로 고친다(`packages/db/src`에서 `git grep -l -E 'import\.meta\.(dir|url)'`로 뽑는다). migration·`schema.ts`는 건드리지 않는다. 테스트 파일도 함께 옮긴다. `.github/workflows/ci.yml`의 `db` integration domain은 `packages/db/` 접두어로 파일을 고르므로 하위 디렉터리도 그대로 돈다. 핀: `db` domain job의 실행 파일 수와 pass·skip 수가 단계 전과 같다. 파일이 많아 리뷰 크기로 둘로 나눴다.
- **단계 7.** 문서만. 증명: `bun test tests/docs-links.test.ts`.

크기는 리뷰할 diff 기준이다: S는 파일 몇 개, M은 바뀌는 파일이 많아도 각 diff가 import·export 경로 줄뿐인 것.

## 4. 하지 않는 것

- **계약을 옮기지 않는다.** `packages/contracts/src/musterrolle/`는 이미 한 디렉터리다. `apps/web`이 type으로, `packages/core`가 값으로 읽고 OpenAPI·SDK가 이 계약에서 나오므로, 옮기면 공개 표면 검토가 따라온다.
- **새 패키지를 만들지 않는다.** 이유는 "검토한 다른 모양"에 있다.
- **`schema.ts`를 나누지 않고 migration을 만들지 않는다.** 테이블 정의는 다른 모듈 테이블과 외래 키로 엮여 있고, 나누는 일은 DB 스키마 작업으로 따로 다룬다.
- **route 파일을 옮기지 않는다.** route와 transport 메타데이터는 control-host가 소유하고, `api/route-error-coverage.ts`가 테스트 파일 이름으로 route를 매핑한다. 경계는 route가 무엇을 import하는지로 지키고, Musterrolle route 목록은 `architecture.md`에 둔다.
- **API 키 record 타입을 db 밖으로 옮기지 않는다.** `ApiKeyRecord` 등을 contracts나 platform 소유로 바꾸면 인증기 interface를 platform port로 올릴 수 있지만, db·control-host·platform의 타입 경로가 함께 바뀐다. 단계 5는 interface를 db에 둔다.
- **Slack 채널 처리를 Kollegium으로 옮기지 않는다.** `packages/platform/src/musterrolle/`의 Slack 파일 가운데 `slack-session-handler`·`slack-outbox`·`slack-inbox`·`slack-decision`·`slack-welcome`·`slack-presentation`·`slack-send-result`·`slack-notice-log`·`slack-events-service`·`slack-channel-join`은 채널에서 받은 이벤트를 세션으로 잇고 결과를 보내는 일이라, `architecture.md`가 Kollegium에 둔 Slack 채널 쪽에 가깝다. 반면 `slack-app-service`·`slack-install-service`·`slack-secret-service`·`slack-config-*`·`slack-link-app-service`는 연동 계정 설정이라 Musterrolle이다. 두 묶음은 서로 import한다(`slack-welcome` → `slack-install-service`, `slack-events-finalize` → `slack-app-service`). 어디에 둘지는 Kollegium 경계를 정할 때 함께 정하고, 그때까지 이 파일들은 Musterrolle 경계 안에 두며 2.2절 허용 목록의 `agent-store`·`session-link-store`가 남는다.
- **이름을 바꾸지 않는다.** `SessionServiceError`처럼 모듈과 어긋난 이름도 이번에는 위치만 옮긴다. 이름을 바꾸면 export 이름 집합이 달라져 단계마다의 "이름 그대로" 증명을 쓸 수 없다.
- **동작을 바꾸지 않는다.** 어느 단계에서 동작 변경이 필요해 보이면 그 단계를 멈추고 따로 다룬다.
