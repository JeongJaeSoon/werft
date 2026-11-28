# 모듈 지도

## 층

층은 셋입니다.

- 1층: LLM API (Werft 밖, BYOK)
- 2층: Kiel (세션 실행: 격리된 run, 제어, 강제, 복구)
- 3층: Wache (상시)

| 층 | 하는 일 |
| --- | --- |
| LLM API | Werft가 부르는 모델 API. Werft 밖에 있고, 설치한 쪽이 자기 key로 잇는다(BYOK) |
| Kiel | 세션을 격리해 돌리고, 제어하고, 한도·권한을 강제하고, 끊겨도 되살리는 실행 기반 |
| Wache | 늘 켜져 있는 층. 듣기(Slack intake), 판단(attention loop, 대화 runtime), 말하기(outbox), 세션 띄우기(spawn_task)를 맡고, 앞으로 들어올 loop와 둘러보기도 여기에 둔다 |

## 곁 모듈

곁 모듈은 층이 아니고, 여러 층이 씁니다.

| 곁 모듈 | 하는 일 | 폴더 |
| --- | --- | --- |
| Kollegium | 에이전트 명부(정의, release, 관리 팀, 채널 연결 설정) | `agents` |
| Musterrolle | 누구인지 확인하고, 해도 되는지 판정하고, 그 판정을 기록 | `access-control` |
| Takelage | 에이전트에 달 것(skill, 원격 MCP 서버)을 들이고, 검사하고, 내줌 | `extensions/{skills,bundles,mcp,builtin}` |
| Logbuch | 에이전트 기억: 종류(agent, channel, person), 범위 판정, 세션에 넣기, 쓰기, 콘솔에서 보기와 고치기, 보존 | `memory` |
| Lotse | 세션과 세션 사이의 협업. 앞으로 올 모듈이고 아직 폴더가 없음 | 없음 |

Werft는 제품 전체의 이름이고, 바깥에 내놓는 유일한 이름입니다.

## 이름 규칙

코드의 폴더, 패키지, 파일 이름에는 기능 이름만 씁니다. 코드명은 도메인 폴더를 묶는 이름이고, 저장소에서는 이 문서가 정합니다. 바깥(API, SDK, 화면, 문서 사이트, Slack, 모델이 읽는 글)에는 Werft만 나옵니다. 옛 프로젝트를 출처로 적은 주석, 변경 기록, migration, 시험 자료에는 옛 이름이 남아 있습니다.

`tests/module-map.test.ts`가 아래 두 표를 실제 패키지와 폴더에 맞춥니다. 패키지나 도메인 폴더를 더하거나 옮기는 PR은 같은 PR에서 이 표를 고칩니다.

아래 두 표의 모듈 칸에는 층과 곁 모듈의 이름, 그리고 다음 넷을 씁니다.

- Werft: 제품 표면(화면, 문서 사이트, SDK, client)
- 걸침: 두 모듈 이상의 책임이 한 곳에 있음
- 미정: 소속을 아직 정하지 않음
- 공용: 모든 도메인이 쓰는 것

## 패키지

<!-- packages:begin -->
| 패키지 | 모듈 |
| --- | --- |
| `apps/egress-proxy` | Kiel |
| `apps/worker` | Kiel |
| `packages/adapters/execution/kubernetes` | Kiel |
| `packages/adapters/execution/local-docker` | Kiel |
| `packages/adapters/forge/github` | Kiel |
| `packages/adapters/runtimes/claude` | Kiel |
| `packages/adapters/runtimes/claude-codec` | Kiel |
| `packages/adapters/runtimes/codec-kit` | Kiel |
| `packages/adapters/runtimes/codecs` | Kiel |
| `packages/adapters/runtimes/codex` | Kiel |
| `packages/adapters/runtimes/codex-codec` | Kiel |
| `packages/adapters/runtimes/registry` | Kiel |
| `packages/runtime-core` | Kiel |
| `packages/storage` | Kiel |
| `apps/control-host` | 걸침 |
| `packages/adapters/chat/slack` | 걸침 |
| `packages/contracts` | 걸침 |
| `packages/db` | 걸침 |
| `packages/platform` | 걸침 |
| `apps/docs` | Werft |
| `apps/web` | Werft |
| `packages/client` | Werft |
| `packages/core` | Werft |
| `packages/react` | Werft |
| `packages/sdk` | Werft |
| `packages/ui` | Werft |
| `packages/observability` | 공용 |
| `packages/system` | 공용 |
| `packages/testkit` | 공용 |
<!-- packages:end -->

`contracts`, `platform`, `db`, `control-host` 네 패키지는 모듈이 아니라 코드 층(계약, 도메인, DB, 앱)입니다. 위의 세 층과는 다른 말입니다. 이 넷 안에서는 아래 도메인 폴더가 단위입니다.

## 도메인 폴더

도메인 폴더는 네 코드 층의 첫 폴더입니다: `packages/contracts/src`, `packages/platform/src`, `packages/db/src`, `apps/control-host/src/api/routes`. 한 도메인의 폴더 이름은 모든 코드 층에서 같습니다. 그 바로 아래에 놓인 파일은 공용입니다.

<!-- domains:begin -->
| 도메인 폴더 | 모듈 | 있는 코드 층 | 비고 |
| --- | --- | --- | --- |
| `action` | Kiel | contracts · platform · db · route | 내장 github MCP 서버 코드(`action/github`)가 여기 있음 |
| `api` | Kiel | contracts | 공개 API 계약면 |
| `catalog` | Kiel | platform |  |
| `checkpoints` | Kiel | platform · db |  |
| `decision` | Kiel | platform | 답할 자격·승인 가능성 판단이 같이 있어 Musterrolle과 맞닿음 |
| `limits` | Kiel | platform · db · route | 호출마다 잡고 거절하는 집행 |
| `scheduler` | Kiel | platform · db |  |
| `secrets` | Kiel | platform · db |  |
| `sessions` | Kiel | platform · db · route | `sessions/achievements`는 걸침: 성과 규칙은 workspace 설정, 판정은 세션 결과 |
| `worker-protocol` | Kiel | contracts | worker gateway 계약면 |
| `workers` | Kiel | platform · route | `workers/mcp-egress`는 실행 중 MCP 호출 중계 |
| `access-control` | Musterrolle | contracts · platform · db · route | 안에 다른 모듈과 걸친 파일이 있음(Slack·GitHub 계약, 변수 부여, 알림) |
| `agents` | Kollegium | contracts · platform · db · route |  |
| `conversations` | Wache | platform · db | 결정·문맥은 대화 기능, 턴 큐·permit·호출 정산은 실행 책임(Kiel) |
| `surface` | Wache | contracts · platform · db · route | 채널 연결 설정(binding, Slack 앱)은 Kollegium과 맞닿음 |
| `extensions` | Takelage | platform · db · route | `skills` `bundles` `mcp` `builtin`. `builtin`(내장 werft MCP 서버와 그 안내)은 걸침: 제품 표면이고 호출 허가에 Kiel·Musterrolle이 관여 |
| `memory` | Logbuch | platform · db | 지금은 가시성 정책과 SQL만 있고 서비스·route가 없음 |
| `github` | 걸침 | platform · db · route | 토큰 발급·작업 실행은 Kiel, App·workspace·에이전트 설정은 관리 권한 |
| `usage` | 걸침 | platform · db · route | 집계는 Kiel, 사람별 열람 권한과 보고서는 Musterrolle·Kollegium |
| `domain` | 공용 | contracts | 소속을 정하지 않은 계약 |
| `ports` | 공용 | platform |  |
| `shared` | 공용 | contracts |  |
| `testing` | 공용 | platform · db |  |
<!-- domains:end -->

## `extensions` 안

`extensions` 바로 아래에는 다음 네 폴더와 진입점(`index.ts`, `ports/`)만 둡니다. 세 코드 층(platform, db, route)이 같은 이름을 씁니다.

| 폴더 | 담는 것 |
| --- | --- |
| `skills` | 사용자가 올린 skill을 등록하고, 검토하고, Git 저장소와 맞춘다 |
| `bundles` | 세션에 skill을 실어 나르는 꾸러미를 저장하고 검사한다. 꾸러미는 내용 digest로 고정되고, worker가 `.ext/<digest>`에 풀어 Claude plugin으로 붙인다 |
| `mcp` | workspace에 등록한 원격 MCP 서버와, 에이전트마다 그 가운데 무엇을 쓸지 정한 지정을 다룬다 |
| `builtin` | Werft가 스스로 붙이는 것. 모든 세션이 갖는 내장 werft MCP 서버와 그 안내를 담는다 |

Codex 엔진은 아직 꾸러미가 붙은 세션을 받지 않습니다.

이름이 `skill-`, `skills.`, `extension-bundle`, `workspace-mcp`, `agent-workspace-mcp`, `agent-mcp`, `werft-mcp`로 시작하는 파일은 세 코드 층에서 `extensions` 아래, 그 이름의 폴더에만 둡니다(port는 `extensions/ports`). 실행 중 MCP 호출을 중계하는 파일(이름이 `mcp-egress`로 끝남)은 Kiel 몫이라 예외이고, platform에서는 `workers/mcp-egress`(port는 `workers/ports`)에 모읍니다.
