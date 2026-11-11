# 결정(설계): 패키지 구조화 — 포트·내장 도구·큰 디렉터리

- 후속(2026-11-11): 실행 프로필은 통째로 지웠다(migration `0269_remove_profiles`, 기존 데이터는 이전하지 않고 지움). 이 문서의 프로필·상한·롤아웃 언급은 그때의 기록이다. 지금은 에이전트 release가 provider 연결과 카드 모델로 실행 spec(런타임·도구·권한 모드)을 고정하고, 묻기·막기 규칙은 워크스페이스와 에이전트의 실행 규칙(`workspace_engine_settings`, `agent_engine_settings`)이 정한다.
- 상태: 설계. 이 문서가 머지된 뒤 이행 단계 S0~S8([6절](#6-이행-순서))을 단계마다 별도 카드와 PR로 진행한다. 이 PR은 코드를 옮기지 않는다.
- 기준 커밋: `origin/main` `2d5e8fbbe`. 파일 수·줄 수는 이 커밋에서 직접 센 값이고(`*.ts`·`*.tsx`, 같은 디렉터리의 직속 파일만, 줄 수는 테스트를 뺀 소스), `파일:줄`도 이 커밋 기준이다.
- 오너 원문(2026-11-10): "github 같은 내장 도구를 구성하는게 점점 많아질거 같은데 어떻게 생각해? packages/platform/src/ports 안에 엄청 많은 도구가 있는데 제대로 구조화 해두는게 좋을거 같은데 / 애초에 한 디렉토리에 파일이 많은것들도 잘 검토해서 패키지 구조화 리팩토링을 진행하는게 좋을듯"
- 뒤를 잇는 문서: [surface·action 모듈, 어댑터, 시험 피라미드](surface-action-modules.md). 그 문서 11절이 이 문서의 다섯 곳(새 워크스페이스 패키지, `GitHubApi` 구현의 위치, S3의 Slack 이동, `change-request/`·`tools/`의 자리, `tools/`와 `action-broker/`를 합칠지)을 다르게 정한다. 그 다섯에서는 그 문서가 맞다. 능력 인터페이스 이름은 그 문서 6.5절이 `-able`로 정한다(`GitPusher`는 `Pushable`, `SlackNoticeSink`는 채널 중립 `Notifiable`). 아래 표의 이름은 이 문서를 쓴 때의 코드 이름이다.
- 겹치지 않을 일: impl lead가 먼저 하는 S0(`GITHUB_MCP_TOOLS` 한 표로 합치기, receipt operation 목록 단일화, 동작 불변)은 이 설계의 전제다. 이 문서는 S0 뒤를 그린다.

## 요약

| 항목 | 결론 |
|---|---|
| 문제 | 파일이 한 디렉터리에 가로로 쌓였다(`db/src` 직속 290개, `platform/src/ports` 64개). 도구 하나(GitHub)의 코드가 7개 패키지·디렉터리에 흩어져 있고, 도구를 하나 더하면 7곳 이상을 고친다 |
| 안 되는 것 | 포트를 어댑터 모양(`packages/adapters/<kind>/<provider>`)으로 통째로 옮기는 것. 포트 62개 중 대부분(50여 개)은 DB 저장소 포트라 구현이 `packages/db`에 하나뿐이다. 어댑터가 되는 것은 바깥 서비스를 부르는 포트(실행, GitHub API, Slack API)뿐이다 |
| 목표 | `platform/src`를 **도메인 디렉터리**로 나눈다(`github/`, `slack/`, `session/`…). 각 도메인이 자기 `ports/`·`service/`·`policy/`·`tools/`를 갖는다. `db/src`도 같은 도메인 이름으로 나눈다. 바깥 서비스 어댑터는 `packages/adapters/<kind>/<provider>` |
| 내장 도구 | 메타데이터(이름·입력·출력·행동 부류·기능·거절 코드)는 contracts의 **도구 정의 한 건**, 실행은 platform의 **handler 한 건**. 둘의 이름 집합은 컴파일 시점에 맞물린다. 도구 추가 = 정의 1 + handler 1 |
| 안전망 | 바깥 import는 패키지 index만 쓰므로(`platform` 소비자는 `@werft-ai/platform` 하나, [3절](#3-옮겨도-바깥이-안-깨지는-이유)) 패키지 안의 이동은 바깥 PR과 충돌하지 않는다. 의존 규칙은 `tests/architecture.test.ts`에 현재 위반을 기준선으로 박아 넣고 줄이기만 한다 |
| 순서 | 규칙·기준선 → platform 도메인 하나씩(GitHub 먼저) → db → control-host 라우트. 프로필 제거 3a·4 계열이 만지는 파일은 그 계열이 끝난 뒤에 옮긴다 |

## 1. 현황 지도

### 1.1 한 디렉터리에 파일이 많은 곳

직속 파일 25개 이상인 곳(같은 디렉터리에 하위 폴더가 없는 가로 확장):

| 디렉터리 | 파일(소스+테스트) | 소스 줄 수 | 메모 |
|---|---|---|---|
| `packages/db/src` | 290 (129+161) | 56,266 | 접두 묶음: `session-*` 12, `slack-*` 8, `github-*` 7, `agent-*` 7, `workspace-*` 4, `tool-*` 4, `push-*` 3, `pull-*` 3, `profile-*` 3 |
| `apps/control-host/src/api` | 135 (49+86) | 22,656 | 하위 `routes/`는 따로 43개(`slack-*` 7, `github-*` 5, `agent-*` 4) |
| `packages/platform/src/musterrolle` | 93 (48+45) | 16,762 | `slack-*`가 절반 가까이. 인가 정책·서비스·Slack 처리가 섞였다 |
| `apps/web/src/routes` | 91 (54+37) | 25,940 | `workspace-github-*` 7, `workspace-slack-*` 2 등 접두로 묶임 |
| `packages/platform/src/sessions` | 90 (44+46) | 16,852 | `pull-*` 6, `session-*` 5, `profile-*` 5, `push-*` 4, `github-*` 4 |
| `apps/worker/src` | 83 (35+48) | 14,287 | 이미 architecture 시험이 레이아웃을 고정한다(1209행) |
| `packages/platform/src/ports` | 64 (62+2) | 9,752 | [1.2절](#12-platformsrcports-62개) |
| `packages/ui/src/primitives`·`patterns` | 54·49 | 3,382·3,774 | UI 부품 목록. 도메인 문제가 아니라 이 설계 밖 |
| `packages/contracts/src/api` | 42 (27+15) | 7,686 | 요청·응답 계약. `github-mcp.ts` 681줄이 가장 크다 |
| `packages/runtime-core/src`·`testkit/src` | 35·32 | 3,529·5,114 | 작아서 지금은 건드리지 않는다 |

장기적으로 고를 대상은 `db/src`, `platform/src/{ports,sessions,musterrolle}`, `control-host/src/api(+routes)` 다섯이다. `web/routes`, `storybook`, `ui`는 화면 쪽 구조라 이 설계의 범위가 아니다([8절](#8-하지-않을-것)).

### 1.2 `platform/src/ports` 62개

`packages/platform/src/index.ts`가 `export *`로 전부 내보낸다. 도메인별로 묶으면 다음과 같다. 구현 열은 같은 이름의 타입을 `implements`·`satisfies`로 구현한 파일을 찾은 결과다.

| 도메인 | 포트(파일) | 구현 위치 |
|---|---|---|
| GitHub 연결·자격 (7) | `github-app-store`(421줄), `github-gate`(378), `github-settings`, `github-packages`, `github-mcp`, `mcp-egress`, `forge` | 저장소: `db/src/github-apps.ts`·`github-installations.ts`·`github-settings.ts`·`github-oauth.ts`·`github-packages.ts`·`mcp-egress.ts`. **GitHub REST 호출 `GitHubApi`는 `apps/control-host/src/api/forge-github.ts`** |
| 변경 요청(push·PR) (10) | `git-push`, `push-intents`, `push-requests`(371), `push-follow-ups`, `pull-requests`, `pull-request-drain`, `pull-request-settings`, `commit-attributions`, `session-attribution`, `agent-github-store` | 전부 `db/src/` 같은 이름 |
| 저장소 (2) | `catalog-repository-store`, `repository-attachments` | `db/src/` |
| Slack (7) | `slack-app-store`, `slack-config-token-store`, `slack-inbound-event-store`, `slack-install-store`, `slack-notice-sink`, `slack-outbox-store`(525), `surface-binding-store` | 저장소는 `db/src/slack-*.ts`. `SlackNoticeSink`는 `control-host/src/slack/main.ts`, `SlackAppStore`의 일부는 `control-host/src/api/slack-app.ts` |
| 세션 실행 (15) | `session-control`, `session-unit-of-work`, `worker-unit-of-work`(693), `pending-requests`, `turn-interrupts`, `session-outcomes`, `session-link-store`, `session-share-store`, `session-title-store`, `scheduler-store`(505), `execution-backend`(348), `checkpoint-store`, `checkpoint-collection`, `checkpoint-verifier`, `workspace-bundle-verifier` | 대부분 `db/src/`. **`ExecutionBackend`는 `packages/adapters/execution/{local-docker,kubernetes}`**, `CheckpointVerifier`는 `control-host/src/api/checkpoints.ts` |
| 에이전트 (5) | `agent-store`(387), `agent-admin-store`, `agent-identity-store`, `agent-mcp-store`, `extension-bundle-store` | `db/src/` |
| 자격·비밀 (3) | `credential-binding-store`, `env-variable-store`, `secret-store` | `db/src/` |
| 프로필·설정 (6) | `installation-profile-store`, `installation-settings-store`, `profile-rollout-store`, `workspace-profile-store`, `workspace-settings`, `settings-document-store` | `db/src/`. **프로필 제거 계열이 지금 줄이는 중** |
| 사람·접근 (6) | `identity-store`(352), `member-store`, `team-store`, `api-key-store`, `linked-account-store`, `decision-log` | `db/src/`, `IdentityStore`는 `control-host/src/api/app.ts`·`auth.ts`에도 |
| 사용량 (1) | `usage-reader`(332) | `db/src/usage-reader.ts` |

정정(Codex 반론, 2026-11-10): 위 표의 구현 열은 "같은 이름의 타입을 가진 파일"을 찾은 값이라 일부는 구현이 아니라 조립 위치다. 한 파일에 인터페이스가 여럿이므로 **분류 단위는 파일이 아니라 인터페이스**다. 비저장소 인터페이스와 실제 구현은 다음과 같다.

| 인터페이스 | 포트 파일 | 실제 구현 |
|---|---|---|
| `ExecutionBackend` | `ports/execution-backend.ts` | `packages/adapters/execution/{local-docker,kubernetes}` |
| `GitHubApi` | `ports/github-gate.ts` | `apps/control-host/src/api/forge-github.ts` |
| `GitPusher` | `ports/git-push.ts:66` | `apps/control-host/src/api/git-push.ts:34` |
| `CheckpointObjectCollector` | `ports/checkpoint-collection.ts:17` | S3, `packages/storage/src/checkpoint-objects.ts:307` |
| `CheckpointVerifier`·`WorkspaceBundleVerifier` | `ports/checkpoint-verifier.ts`·`workspace-bundle-verifier.ts` | `CheckpointVerifier`는 포트 파일 안(`ports/checkpoint-verifier.ts:107`), 운영용 `WorkspaceBundleVerifier`는 `packages/storage/src/git-workspace-bundle-verifier.ts:146`. `control-host/src/api/checkpoints.ts:72,293`은 이들을 연결하는 조립 위치다 |
| `GitHubPackagesTokenVerifier` | `ports/github-packages.ts:107` | HTTP 호출이 `platform/src/musterrolle/github-packages-service.ts:217`에 있다 |
| `SlackNoticeSink` | `ports/slack-notice-sink.ts` | `platform/src/musterrolle/slack-notice-log.ts:8`, `slack-outbox.ts:292`(`control-host/src/slack/main.ts`는 조립 위치) |

표의 `SlackAppStore`는 `db/src/slack-apps.ts:201`이 구현하고(`control-host/src/api/slack-app.ts`는 소비), `IdentityStore`의 구현 `DatabaseIdentityStore`는 `control-host/src/api/auth.ts:62`에 있다(`app.ts`는 조립). 이 정정은 아래 결론을 바꾸지 않는다.

읽을 점 두 가지:

1. **포트의 대부분이 저장소 포트다.** 바깥 서비스를 부르거나 바깥 저장소(S3, git)를 쓰는 인터페이스는 위 표의 8개 안팎이고, 나머지 50여 개는 `db` 패키지가 구현하며 구현 파일 이름이 포트 파일 이름과 같다(`ports/pull-requests.ts` ↔ `db/src/pull-requests.ts`). 그래서 "포트를 어댑터 패키지로 옮긴다"는 모델은 맞지 않고, **저장소 포트는 도메인 안에 두고 db도 같은 도메인으로 나눈다**가 맞다. 비저장소 구현은 세 곳(control-host, storage, platform 안)에 흩어져 있어 어댑터 패턴으로 모으는 일은 이번 범위가 아니다([4.3절](#43-어댑터)).
2. **`platform/src/index.ts`는 184줄의 `export *` 목록이다.** 맨 위 주석(`biome-ignore-all … Bun 1.3.14's bundler fails to resolve the sessions/*.ts exports that follow a sessions/ subdirectory export`)이 말하듯 export 순서가 Bun 번들러 버그를 피하려고 고정돼 있다. 폴더를 옮기면 이 순서가 깨질 수 있다([7절](#7-위험)).

### 1.3 GitHub 한 도구가 흩어진 곳

| 위치 | 파일 |
|---|---|
| contracts | `api/github-mcp.ts`(681줄), `api/agent-github.ts`, `api/github-work.ts`, `musterrolle/github-{app,packages,repository,settings}.ts` |
| db | `github-apps`, `github-installations`, `github-oauth`, `github-packages`, `github-pins`, `github-settings`, `github-app-manifest-states`, `agent-github`, `mcp-egress` |
| platform/ports | `github-app-store`, `github-gate`, `github-settings`, `github-packages`, `github-mcp`, `forge`, `agent-github-store` |
| platform/sessions | `github-gate`(461줄), `github-mcp-server`(734), `github-work-service`, `github-connection-resolver` |
| platform/musterrolle | `github-{app,packages,repository,settings}-service` |
| platform/workers | `github-mcp-egress`, `github-packages`, `github-packages-egress` |
| platform/agents | `agent-github-service` |
| control-host | `api/forge-github.ts`, `api/github-link.ts`, `api/github-packages-config.ts`, `api/routes/{agent-github,github-app,github-packages,github-repositories,github-settings,github-work}.ts` |
| web | `routes/workspace-github-*`(7), `routes/agent-detail/github*`(5), `routes/session-github-work.tsx`, `i18n/{github,agent-github,github-user-link}.ts` |

보안 경계는 양호하다. 자격 발급·허용 판정·receipt는 `platform/sessions/github-gate.ts` 한 곳에 모여 있고, 이 구조화는 그 경계를 옮기지 않는다.

확장성 문제는 둘이다.

- **도구 하나의 정의가 한 파일의 표 여섯 곳에 흩어졌다.** `contracts/api/github-mcp.ts`의 `GITHUB_MCP_TOOL_ARGUMENTS`(:116), `_FEATURES`(:179), `_CLASSES`(:372), `_DESCRIPTIONS`(:471), `_OUTPUTS`(:516), `_REFUSALS`(:573)가 같은 도구 이름 키를 각자 가진다. 실행은 `platform/sessions/github-mcp-server.ts:621-740`의 `switch`다. 새 `purpose`를 더하면 `github-settings.ts`와 `github-gate.ts`의 허용 목록도 고쳐야 한다(brief의 조사: `github-settings.ts:151,172-226`, `github-gate.ts:43-55,81-89`). receipt operation 목록은 contracts `receipt.ts`, `session-outcome.ts:115`, db `agent-github.ts`·`session-outcomes.ts`에 따로 있다. **이 문제는 S0이 해결한다.**
- **`GitHubApi`(메서드 17개) 포트가 `ports/github-gate.ts` 안에 섞여 있고**(`:91-176` 근처부터), `forge.ts`의 `ForgeKind`는 `"github"` 하나뿐이다. 구현은 `control-host/src/api/forge-github.ts`에 있다. 다른 forge를 더할 일은 지금 없으므로 **일반화하지 않고** 위치만 정리한다([4.3절](#43-어댑터)).

### 1.4 `action-broker`의 어긋남

`docs/contributing/decisions/action-broker.md:31-36` 근처(1절 "위치와 이름")는 코드 모듈을 `packages/platform/src/action-broker/`로 약속하지만, 실제로는 `refusal.ts`와 시험 하나뿐이다. 도구 실행 코드(dispatcher·handler)는 `sessions/github-mcp-server.ts`에 있다. 이 설계가 그 약속을 **도메인 모듈 `tools/`로 정정한다**([4.2절](#42-내장-도구-레지스트리)). action-broker라는 이름은 "정책 게이트·자격 사용·receipt를 맡는 모듈"이라는 뜻으로 남기되, 디렉터리 이름으로는 쓰지 않는다. 이 문서의 머지 PR이 `action-broker.md`의 해당 문장에 정정 링크를 단다(S1).

## 2. 원칙

1. **도메인이 디렉터리다.** 한 기능(GitHub, Slack, 세션, 에이전트…)의 코드는 같은 이름의 디렉터리에서 찾는다. 파일 이름 접두(`slack-*`)로 묶는 것을 디렉터리로 바꾸는 것이다.
2. **포트는 쓰는 쪽(도메인)이 소유한다.** 포트 인터페이스는 그 포트를 부르는 도메인의 `ports/`에 두고, 구현은 `db`의 같은 도메인 디렉터리나 어댑터 패키지에 둔다.
3. **contracts는 web과 공유하므로 데이터와 스키마만 둔다.** 실행 코드(handler, 서비스 로직, I/O)를 넣지 않는다. 이미 지키고 있는 규칙이고 [5절](#5-의존-방향과-강제)이 시험으로 고정한다.
4. **동작 불변 이동과 동작 변경을 한 PR에 섞지 않는다.**
5. **바깥 패키지의 import 경로를 이 작업이 바꾸지 않는다.** platform·db·contracts의 공개 표면은 `index.ts`(와 지금 있는 하위 경로 export)로 그대로 둔다.

## 3. 옮겨도 바깥이 안 깨지는 이유

패키지 소비 방식을 확인했다.

- `@werft-ai/platform`을 부르는 파일은 `apps/control-host` 190개, `packages/db` 201개, `packages/adapters` 13개, `packages/storage` 3개이고, 모두 패키지 이름만 쓴다. `package.json`의 `exports`는 `"."`와 `./testing/*` 넷뿐이라 `platform/src/ports/...` 같은 깊은 경로 import는 막혀 있다(바깥의 `ports/` 문자열 import 검색 결과 platform 안의 179개 파일뿐).
- `@werft-ai/db`의 하위 경로 export는 `./migrate`, `./pool`, `./testing/*`이고, 가장 많이 쓰이는 `@werft-ai/db/pool`(26곳)도 파일 하나다. `@werft-ai/contracts`도 `./settings`, `./execution`, `./agent-card` 셋뿐이다.

그러므로 **import 문은 패키지 안의 상대 import와 `index.ts`만 바꾸면 된다.** 실제 import에서 미공개 deep import나 이를 우회하는 tsconfig alias는 없다(Codex 반론이 같은 결론). 다만 import 아닌 **경로 고정 참조**가 있다. 이 파일들은 이동 목록에서 뺀다.

- 하위 경로 export가 가리키는 파일: `db/src/pool.ts`, `migrate.ts`, `contracts/src/shared/{settings,execution,agent-card}.ts`, testing 파일
- `bunfig.toml:5`가 preload하는 `packages/db/src/pglite-release.ts`, `scripts/image-prune.sh:43`이 같은 경로를 지정한다
- `tests/integration-jobs.test.ts:168`이 정확한 경로로 단언하는 `packages/db/src/migrate.integration.test.ts`

S1이 `git grep`으로 이런 경로 고정 참조를 전부 모아 "이동 금지 목록"으로 문서화하고, 이동 PR이 그 목록의 파일을 **옮기거나 지우면** 시험이 실패하게 한다. 파일 안의 import 경로를 고치는 수정은 허용한다(`platform/src/testing/slack-fakes.ts:20-21`은 S3에서 옮길 `musterrolle/slack-config-api.ts`를 직접 import한다). 이동 제외 목록에 없더라도 경로를 문자열로 가리키는 곳(설정, 스크립트, 시험)은 이동 PR이 `git grep <옛 경로>`로 확인한다.

## 4. 목표 구조

### 4.1 platform 도메인 모듈

```text
packages/platform/src/
  index.ts                  // 그대로: 공개 표면
  github/
    ports/                  // github-app-store, github-gate(자격 부분), github-settings, github-packages, github-mcp, forge, mcp-egress
    service/                // github-gate(쪼개지 않음), github-{app,packages,repository,settings}-service, github-work-service, connection-resolver
    tools/                  // 4.2절: github-mcp-server → handler들
  change-request/           // push-*, pull-request-*, commit-attributions (지금 ports 10개 + sessions의 push/pull 10여 개)
  slack/                    // slack-* 포트 7, musterrolle/slack-* 서비스, SlackNoticeSink
  session/                  // session-*, worker-unit-of-work, pending-requests, turn-interrupts
  scheduler/ checkpoint/ execution/ agent/ workspace/ access/ …
  action-broker/            // 현행 유지: refusal.ts. 4.2절에서 이름을 다시 정한다
  testing/                  // 현행 유지
```

**이동과 책임 분리는 별개 변경이다.** S2~S4는 기존 모듈을 **통째로** 도메인 폴더에 옮기기만 한다(Codex 반론 수용). 아래 `ports/service/policy/tools`는 옮긴 파일이 앉을 자리를 정하는 이름이고, 파일 안의 로직을 쪼개지 않는다. 지금도 `ports/forge.ts:90,97`에 함수가, `ports/checkpoint-verifier.ts:107`에 구현이, `musterrolle/github-packages-service.ts:227`에 HTTP 호출이 있고, `sessions/github-gate.ts`는 판정과 receipt 기록을 함께 한다(`:119`, `:149`, `:416`). 이런 파일은 가장 가까운 자리에 그대로 두고, 책임 분리가 필요하면 이 시리즈 밖의 별도 설계로 다룬다. 특히 **`github-gate`는 쪼개지 않고 `github/` 안에 한 모듈로 둔다**(`policy/`로 가르지 않는다).

디렉터리 안쪽 이름은 네 가지로 고정한다.

| 하위 | 두는 것 | 두지 않는 것 |
|---|---|---|
| `ports/` | 인터페이스, 입력·출력 타입, 포트가 던지는 오류 클래스, 이미 같은 파일에 있는 작은 순수 도우미 | 새 로직 |
| `service/` | 포트를 조합하는 유스케이스, 기존 gate | 새 HTTP·SQL·SDK |
| `policy/` | 순수 판정 함수(허용, 승인 가능 여부, 귀속). 이미 따로 있는 파일만 | 포트 호출 |
| `tools/` | 내장 도구 handler | 도구 메타데이터(contracts에 있다) |

`policy/`와 `tools/`는 도메인이 필요로 할 때만 만든다(YAGNI). 파일이 몇 개 안 되는 도메인은 하위 폴더 없이 시작해도 된다. `musterrolle/`는 이름을 바꾸지 않는다([8절](#8-하지-않을-것)). 인가 정책과 서비스는 `access/`가 아니라 `musterrolle/`에 남기고, 거기 섞인 `slack-*` 27개(시험 제외)만 `slack/`으로 나간다.

### 4.2 내장 도구 레지스트리

현재: 정의가 contracts의 표 여섯(위 1.3절)과 platform의 `switch`로 갈라져 있다. S0이 표를 한 표 `GITHUB_MCP_TOOLS`로 합친다. 그 뒤의 모양:

- **contracts**: `defineTool({ name, arguments, output, class, feature, description, refusals })`가 한 건을 만들고, 도메인별 목록(`GITHUB_MCP_TOOLS`)이 이름 → 정의 `Record`다. 실행 코드는 없다. web과 SDK도 이 목록을 읽는다.
- **platform**: `tools/`의 handler 표가 `satisfies Record<GitHubMcpToolName, ToolHandler>`로 정의 목록의 이름 집합과 맞물린다. 도구를 더하면 정의를 빼먹을 수도, handler를 빼먹을 수도 없다(컴파일 오류). 지금의 `switch`는 이 표로 바뀐다.
- **도구 공통 파이프라인**: 정의 조회 → 인수 검증 → handler 호출 → 결과 봉투까지만 `tools/dispatch.ts`에 둔다. **인가, 자격 발급, receipt 기록은 지금처럼 서비스와 gate가 소유한다.** receipt는 호출 뒤 후처리가 아니다: `github-work-service.ts:35`는 dispatch receipt와 workflow 행을, `:45`는 review receipt와 outcome을 한 트랜잭션으로 쓰고, `github-gate.ts:416`은 작업 실행 전에 토큰 발급 receipt를 남긴다(Codex 반론). 공통 dispatcher로 옮기면 원자성과 기록 시점이 바뀌고 기존 기록과 중복된다. 새 내장 서버(예: action-broker 문서의 `platform` 서버)는 같은 dispatch에 정의 목록과 handler 표를 꽂는다.
- **이름**: `action-broker/`는 현행 `refusal.ts`를 그대로 두고, `tools/dispatch.ts`는 도메인 밖 공통이므로 `platform/src/tools/`(도메인이 아닌 공통 레지스트리)에 둔다. `action-broker.md`의 약속 문장은 이 위치로 정정한다. (정정: [surface·action 모듈](surface-action-modules.md) 7.2절과 U6b가 `platform/src/action/tools/`로 정했고, `action-broker.md` 1절은 그 위치로 고쳤다.) 둘을 하나로 합칠지는 U6b가 정했다(9절).
- **receipt operation 목록**: S0이 단일화한 값을 그대로 쓰고, 이 설계는 더 건드리지 않는다.

### 4.3 어댑터

기존 패턴 `packages/adapters/<kind>/<provider>`는 이미 `execution/{local-docker,kubernetes}`, `runtimes/{claude,…}`가 쓴다. 이 패턴에 맞는 것은 **바깥 서비스를 부르는 포트**다.

| 포트 | 지금 구현 | 목표 |
|---|---|---|
| `ExecutionBackend` | `adapters/execution/*` | 그대로 |
| `GitHubApi` | `control-host/src/api/forge-github.ts` | **지금은 옮기지 않는다.** 루트 `package.json:6`의 workspace 목록에 `packages/adapters/forge/*`가 없어서, 옮기려면 workspace 등록·manifest·control-host 의존성·lockfile이 필요하고, 폴더만 만들어 앱이 상대 import하면 `tests/architecture.test.ts:808`에 걸린다. 두 번째 forge가 실제로 생길 때 패키지로 만들고 `ForgeKind`를 함께 넓힌다. 그 전에는 `control-host/src/api/` 안에서 위치만 정리한다 |
| Slack Web API 호출 | `control-host/src/slack/main.ts` 등에 흩어짐(S6 카드가 위치부터 조사한다) | 위와 같은 이유로 지금은 패키지로 만들지 않는다. 후보는 `packages/adapters/chat/slack` |
| 저장소 포트(50여 개) | `packages/db/src/` | 어댑터 패키지로 옮기지 않는다. `db/src/<도메인>/`으로 나눈다 |

어댑터 패키지가 platform의 포트 타입을 import하는 것은 `execution` 어댑터가 이미 하는 일이라 허용한다(architecture 시험에서 "Claude 어댑터는 platform·db·storage에 닿지 않는다"는 규칙은 `runtimes/claude`에만 걸려 있다). 새 어댑터는 `db`를 import하지 않는다.

### 4.4 db

`db/src`를 platform과 같은 도메인 이름으로 나눈다(`db/src/github/`, `slack/`, `session/`…). 마이그레이션(`packages/db/migrations`)과 `schema.ts`, `index.ts`는 옮기지 않는다. `db/src/index.ts`(97줄)가 하위 폴더 export를 받는다. db는 platform에 의존하므로(`platform`을 부르는 파일 201개) platform 이동이 끝난 뒤에 따라간다.

### 4.5 control-host

`apps/control-host/src/api/routes/`(43개)를 도메인별 하위 폴더(`slack/`, `github/`, `agent/`)로 묶는다. `api/` 직속 49개 소스는 라우트 등록과 서비스 연결 코드가 섞여 있어, S7에서 파일 이름 접두 묶음만 폴더로 옮기고 구조 변경은 하지 않는다.

## 5. 의존 방향과 강제

방향(위가 아래를 쓴다):

```text
apps/*  →  platform  →  contracts, runtime-core
              ▲
adapters/*  ──┘ (포트 타입만)         db  →  platform(포트), contracts
```

이미 시험이 지키는 것(`tests/architecture.test.ts`): platform은 contracts·runtime-core·zod만 의존(`:1057`), platform에 드라이버·ORM·SDK import 금지(`:1078`), 앱끼리 import 금지(`:1110`), 패키지 밖으로 나가는 상대 import 금지(`:808`).

이 설계가 시험에 **더하는 규칙**(S1):

| # | 규칙 | 비고 |
|---|---|---|
| A1 | `contracts`는 `platform`·`db`·어댑터·앱을 import하지 않는다 | 이미 지킨다(`contracts/src`에 `@werft-ai/platform`·`@werft-ai/db` import 0건). 기준선 없이 바로 막는다 |
| A2 | 도메인 디렉터리는 다른 도메인의 **`ports/`와 `index.ts`**만 import한다. `service/`·`policy/`·`tools/`는 도메인 안에서만 | 현재 위반을 **(소스 파일 → 대상 모듈) 쌍**으로 기준선에 박는다. 파일 전체를 예외로 두면 허용된 파일이 다른 도메인 내부 import를 더해도 통과한다(`musterrolle/slack-outbox.ts:22`는 정책 함수를, `:23`은 서비스 타입을 부른다). 쌍의 수는 **늘 수 없다**. 순수 이동은 쌍의 경로만 바꾸므로 감소를 강제하지 않는다 |
| A3 | `tools/`는 contracts의 정의를 import하고, `ports/`는 `tools/`를 import하지 않는다 | 의존 사이클 방지 |
| A4 | `contracts`에는 `class`·함수 본문 handler를 두지 않는다. `export const` 데이터와 zod 스키마, 순수 변환만 | 현재 `contracts/src`의 비테스트 `export class`는 0개다. 함수 본문 handler 여부는 S1에서 TS AST로 센다(정규식 스캔 금지, 시험이 이미 쓰는 `typescript` 파서). 위반이 있으면 목록으로 시작한다 |
| A5 | 모든 도구 이름은 정의와 handler 양쪽에 있다 | 타입(`satisfies`)과 시험으로 이중 |

기준선 방식을 쓰는 이유: 현재 `sessions/`와 `musterrolle/`가 서로 import한다(`sessions` 14개 파일이 `../musterrolle/`를, `musterrolle` 28개 파일이 `../sessions/`를 부른다, 시험 파일 제외). 이 상호 참조는 A2 도입을 막지 않는다: 쌍 단위 기준선에 남기면 된다(Codex 반론이 같은 결론). 한 번에 고치는 것은 이 작업의 범위가 아니다. 시험의 목표는 **새 위반을 막고, 위반이 사라지는 PR을 기준선 갱신으로 알아본다**이다.

## 6. 이행 순서

모든 단계는 동작 불변 이동만 한다(예외 S0, S5). 단계마다 별도 PR, 하나가 머지되기 전에 다음을 시작하지 않는다(같은 파일을 고치지 않는 단계는 병행 가능).

| 단계 | 내용 | 먼저 있어야 하는 것 |
|---|---|---|
| **S0** | (impl lead) `GITHUB_MCP_TOOLS` 한 표, receipt operation 단일화 | — |
| **S1** | 규칙·기준선: `tests/architecture.test.ts`에 A1~A4 추가, 현재 위반 목록 고정, `action-broker.md` 정정 링크. 코드 이동 없음 | 이 문서 머지 |
| **S2** | `platform/src/github/` 만들기: ports 7, sessions 4, musterrolle 4, workers 3, agents 1을 `git mv`하고 `index.ts` 갱신 | S0, S1, `github-gate`·`github-mcp-server`를 건드리는 열린 PR 없음 |
| | 상태: 19개 가운데 `forge`는 `action/ports/`로, `github-mcp-server`·`github-work-service`는 `action/github/`로 U6a에서 옮겨졌다. 나머지 14개는 `github/{ports,service,egress}/`로 옮겼다. `ports/github-mcp.ts`·`workers/github-mcp-egress.ts`는 프로필 제거 계열 목록에 있어 제자리에 두고, 계열이 끝나면 옮긴다 | |
| **S3** | `platform/src/slack/`: ports 7 + `musterrolle/slack-*` | S1 |
| **S4** | `change-request/`(push·PR 계열 ports 10 + sessions 10여 개), `session/`·`scheduler/`·`checkpoint/` | S2 |
| | 상태: 기존 이름 유지, 리드 결정 2026-11-11. 위 `change-request/`·`session/`·`checkpoint/`는 옛 표기다. push·PR 계열 ports 8개는 `action/ports/`로, `agent-github-store`는 `github/ports/`로, session 계열 ports 8개는 `sessions/ports/`로, checkpoint 계열 ports는 `checkpoints/ports/`로, scheduler 계열 ports 2개는 `scheduler/ports/`로 옮겼다. A2는 `<도메인>/ports/` 직속과 `index.ts`만 입구로 세므로 `action/change-request/ports/`는 쓰지 않았다. `ports/worker-unit-of-work.ts`는 프로필 제거 계열 목록에 있어 제자리에 둔다 | |
| **S5** | (동작 변경 없는 구조 변경) `tools/` 레지스트리: `switch` → handler 표, `dispatch.ts` 공통화, A5 시험 | S0, S2 |
| **S6** | `GitHubApi` 구현(`forge-github.ts`)과 Slack API 호출 코드의 위치를 `control-host/src/api/` 안에서 정리한다. 새 패키지는 만들지 않는다([4.3절](#43-어댑터)) | S2 |
| **S7** | `db/src/<도메인>/`(platform 이동 뒤), `control-host/routes/<도메인>/` | S2~S4 |
| | 상태: 도메인 이름은 platform을 따른다(`sessions/`·`checkpoints/` 복수). `db/src`의 파일 139개를 `action/`·`checkpoints/`·`decision/`·`extensions/`·`github/`·`limits/`·`musterrolle/`·`scheduler/`·`secrets/`·`sessions/`·`surface/`(Slack 저장소)·`usage/`·`agents/`로 옮겼다(U9a PR-1). `engine-settings-start.ts`·`mcp-egress.ts`와 프로필 제거 계열(#1567)이 고치는 파일은 제자리에 두고 S8에서 옮긴다. `apps/control-host/src/api/routes/`는 같은 이름으로 `action/ agents/ github/ musterrolle/ sessions/ surface/ usage/ workers/`에 파일 73개를 옮겼다(U9a PR-2). `auth`·`errors`와 #1567 계열(`agents`, `sessions`, `profiles`, `installation-settings.ts` 등 #1567이 고치는 파일)은 제자리에 두고 S8에서 옮긴다 | |
| **S8** | 남은 기준선 정리와 index 순서 점검, 이 문서 상태를 "완료"로 | 전부 |

### 6.1 프로필 제거 계열과의 충돌

프로필 제거 3a·4 계열(최근 머지: #1488, #1489, #1490)이 만지는 파일은 이름 패턴으로 잡히지 않는다. `*profile*`, `*engine-settings*`(`agent-engine-settings`, `workspace-engine-settings`, `claim-engine-settings`, `engine-settings-start`, `engine-settings-merge`), `installation-*`, `profile-rollout-*`뿐 아니라, 같은 계열 커밋 `2b1143d48`이 실제로 고친 `db/src/mcp-egress.ts`, `platform/src/ports/github-mcp.ts`, `platform/src/workers/github-mcp-egress.ts`, `sessions/github-mcp-server.ts`, `workers/worker-gateway.ts`, `ports/worker-unit-of-work.ts`, `db/src/worker-unit-of-work.ts`, `db/src/postgres-unit-of-work.ts`도 있다(이 중 `github-mcp*`·`mcp-egress`는 S2·S7의 이동 대상이다). 그래서 **제외 대상은 파일명 패턴이 아니라 그 계열 PR들의 실제 변경 파일 목록으로 관리한다.** S1이 `gh pr list --search`와 `git log --name-only`로 목록을 만들어 문서에 남기고, 각 이동 단계가 시작할 때 갱신한다. 목록의 파일은 계열이 끝날 때까지 이동에서 빼고, 끝난 뒤 S8에서 한 번에 정리한다. 이 때문에 S2의 GitHub 이동은 `github-mcp*`와 `mcp-egress` 계열을 마지막 묶음으로 미루거나, 계열이 먼저 끝나기를 기다린다. 이 시점에서 열린 PR은 이 문서를 쓰는 중에는 #1327(verify-werft 스크립트) 하나라 지금 부딪히는 PR은 없지만, 단계 시작 때마다 `gh pr list`로 이동 대상 파일을 건드리는 열린 PR을 다시 확인한다.

### 6.2 import 경로를 한꺼번에 바꾸지 않는 방법

- 한 PR은 한 도메인(S2 안에서도 `ports/` → `service/` → `tools/` 순으로 나눌 수 있다)만 옮긴다.
- `git mv`로 옮기고 같은 PR 안에서 상대 import를 고친다. 바깥 패키지는 안 바뀌므로 shim이 필요 없다.
- 옮기는 파일을 platform **안에서** 20곳 넘게 import하면, 옛 경로에 `export * from "<새 경로>"` 한 줄짜리 shim을 두고 다음 PR이 지운다(shim은 한 PR 주기까지, `index.ts`가 새 경로를 가리킨다). 20은 리뷰 가능한 diff 크기에서 정한 시작값이고 S2에서 실제 수치로 조정한다.
- `index.ts`의 export 순서를 바꾼 PR은 Bun 번들러 오류를 보려고 번들 시험([7절](#7-위험))을 돌린다.

### 6.3 단계별 검증

모든 이동 PR이 같은 검증을 낸다.

1. `bun run typecheck`(루트, 워크스페이스 전체).
2. `bun test packages/platform packages/db apps/control-host tests/architecture.test.ts`. 로컬 bun 1.4.2는 알려진 실패가 있어(고정은 1.3.14) main 기준 실패 목록과 비교한다.
3. **공개 표면 동일성**: 이동 전후 `@werft-ai/platform`·`@werft-ai/db`·`@werft-ai/contracts`의 export 이름 목록을 TS 컴파일러 API(`checker.getExportsOfModule`)로 뽑아 정렬 비교한다. 같아야 한다.
4. **이동 순도**: `git diff -M90% --stat main...HEAD`에서 이동한 파일이 rename으로 잡히고, 내용 변경은 import 경로 줄뿐이다.
5. **생성물 바이트 비교**: `docs/openapi.json`을 `apps/control-host/scripts/generate-openapi.ts`로 다시 만들어 `git diff --exit-code`. `packages/db/migrations/`는 diff가 비어야 한다.
6. Bun 번들러(S2 이후 매 단계): control-host가 번들되는지 확인한다([7절](#7-위험)).

S5만 동작 불변을 시험으로 증명한다: 이동 전 `github-mcp-server.test.ts`·`github-mcp-envelope.test.ts`를 고치지 않은 채 통과해야 하고, 도구별 응답 스냅샷이 같아야 한다.

## 7. 위험

| 위험 | 대응 |
|---|---|
| `index.ts` export 순서가 Bun 번들러 버그에 묶여 있다(`platform/src/index.ts` 1행) | 이동 PR마다 번들 확인. 버그가 Bun 갱신으로 풀렸는지는 S8에서 확인하고, 풀렸으면 주석과 순서 제약을 없앤다 |
| 열린 PR과의 충돌(큰 이동 PR은 오래 열려 있을수록 깨진다) | 한 PR 한 도메인, 이동 순수. 단계 시작 때 열린 PR 확인. 충돌이 나면 이동 PR을 다시 만든다(`git mv`라 재생산이 싸다) |
| `ports/`가 곧 platform의 공개 표면이라 도메인으로 나누면 이름이 겹친다(`github-settings`가 ports와 contracts에 둘) | 파일 이름은 바꾸지 않고 디렉터리만 옮긴다. 이름 충돌은 contracts와 platform이 다른 패키지라 지금도 없다 |
| 기준선(A2)이 형식적인 목록이 된다 | (파일→모듈) 쌍 단위라 새 의존은 막힌다. 순수 이동은 감소를 강제하지 않으므로 S8에서 남은 쌍을 사유와 함께 정리한다 |
| 폴더가 늘어 import가 길어진다 | 도메인 안에서는 짧게(`./ports/x.ts`), 도메인 사이에서는 `index.ts`를 경유 |
| 프로필 제거 계열의 후속 PR이 옮긴 파일을 건드린다 | 6.1절대로 해당 파일을 이동에서 뺀다 |

## 8. 하지 않을 것

- **새 워크스페이스 패키지를 만들지 않는다**(`packages/github`, `packages/adapters/forge/*` 같은 것). 이 시리즈에는 예외가 없다. 패키지를 쪼개면 `platform은 contracts·runtime-core·zod만 의존` 시험, 빌드, 버전 고정이 모두 걸린다. 도메인 디렉터리로 같은 효과를 낸다.
- **`musterrolle`이라는 이름을 바꾸지 않는다.** 인가 경계의 용어이고 [musterrolle-boundary.md](musterrolle-boundary.md)가 계약이다.
- **스키마와 마이그레이션을 바꾸지 않는다**(`schema.ts`, `migrations/`).
- **`ForgeKind`를 미리 일반화하지 않는다.** 두 번째 forge가 실제로 생길 때 한다.
- **저장소 포트를 어댑터 패키지로 옮기지 않는다.** [1.2절](#12-platformsrcports-62개)대로 db 하나가 구현한다.
- **`web/routes`, `storybook`, `ui`, `runtime-core`, `testkit` 구조는 이 설계에서 다루지 않는다.** `web/routes`(91개)는 라우터 규칙에 묶여 있을 수 있어 별도 설계가 필요하다.
- **보안 경계를 옮기지 않는다.** `github-gate`의 발급·판정·receipt는 한 모듈로 남고, 이동할 때도 쪼개지 않는다.
- **이 카드에서 코드를 옮기지 않는다.** 위 단계마다 별도 카드다.

## 9. 열린 질문

- A4(contracts에 실행 코드 금지)의 현재 위반 수는 S1에서 센다. 많으면 규칙을 목록으로 시작한다.
- ~~`tools/`(공통 레지스트리)와 `action-broker/`를 한 디렉터리로 합칠지는 S5에서 정한다.~~ U6b가 정했다: 둘 다 `platform/src/action/` 아래이고, `refusal.ts`는 `action/` 바로 아래에, dispatch와 handler 표는 `action/tools/`에 둔다([surface·action 모듈](surface-action-modules.md) 15절).
- Slack API 호출 코드의 위치는 S6 카드가 읽고 정한다(이 문서는 `control-host/src/slack/main.ts` 근방까지만 확인했다).
