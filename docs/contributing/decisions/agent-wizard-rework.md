# 결정(설계): 새 에이전트 마법사 재작업 — 저장소 지정 제거·이름과 설명·도구 선택·담당 팀

- 후속(2026-11-11): 실행 프로필은 통째로 지웠다(migration `0267_remove_profiles`, 기존 데이터는 이전하지 않고 지움). 이 문서의 프로필·상한·롤아웃 언급은 그때의 기록이다. 지금은 에이전트 release가 provider 연결과 카드 모델로 실행 spec(런타임·도구·권한 모드)을 고정하고, 묻기·막기 규칙은 워크스페이스와 에이전트의 실행 규칙(`workspace_engine_settings`, `agent_engine_settings`)이 정한다.
- 후속(2026-11-09): 이 문서가 정한 카드의 에이전트 지시문 칸(`agent_instructions`)은 오너 결정으로 없앴다. 에이전트의 동작 지시는 저장소의 CLAUDE.md·AGENTS.md 하나로만 남는다. 아래 본문은 그때까지의 결정 기록이다.
- 후속(2026-11-10): 아래의 "기본 저장소"는 이 결정을 내릴 당시의 동작이다. 지금은 설정 행이 있는 에이전트의 세션이 저장소 없이 시작하고 필요한 저장소만 붙인다. 현재 규칙은 [API 서버 운영 문서](../../operator/api-server.md)의 "새 세션의 시작 저장소"다.
- 상태: 설계. 오너 확인이 필요한 항목은 [오너 확인 필요](#오너-확인-필요)에 모았다. 나머지는 오너 승인(2026-11-02, 아래 원문) 범위 안에서 추천 기본값으로 정했다.
- 기준 커밋: `origin/main` `093bfd5a1`. 아래 `파일:줄`은 이 커밋 기준이다.
- 오너 원문(2026-11-02, 마법사 스크린숏과 함께): "에이전트 만들때 저장소 지정하는건 없어 져야하지 않을까 / 그리고 에이전트 역할은 이름으로, 지시사항은 설명이 되어야하지 않을까 / 나중에 claude.md 나 agent.md 같은건 따로 상세 설정에서 넣도록 하고 이 이름이나 설명이 agent 의 동작에 영향을 끼치면 안될거같은데 넣더라도 아니면 가볍게 들어가도록 하거나 / [도구 칸] 이부분은 이게 아니지? 개선할거지?"
- 오너 원문(같은 날, 에이전트 상세 '관리자' 탭 스크린숏과 함께): "에이전트 생성할때 담당 팀을 지정하고 연결하는 기능이 없는거 같아 그리고 생성후에도 에이전트의 관리팀이 지정이 안되는데 그리고 에이전트의 관리팀이 지정되면 각팀의 관리자 인지 구성원인지의 권한을 따라가는거지 ?"
- 앞 결정: [session-repository-attachment.md](session-repository-attachment.md)(JeongJaeSoon/agent-platform#990). 저장소 항목은 이 결정을 따른다.

## 요약

| 항목 | 결론 |
|---|---|
| 1. 저장소 지정 | 마법사에서 뺀다. 마법사가 만드는 릴리스는 `repository_id` 없이 만든다. 기본 저장소는 에이전트 상세 '릴리스' 탭에서만 고른다. `required` 프로필은 마법사에서 고를 수 없게 하고 이유를 보인다 |
| 2. 이름·설명 | 카드의 `role`을 없애고 에이전트 행의 `name`이 그 자리를 맡는다. 에이전트 행에 `description`을 새로 둔다. 둘 다 시스템 프롬프트에 넣지 않는다. 동작 지시는 상세 설정의 새 칸 '에이전트 지시문'(카드 `agent_instructions`)에 둔다 |
| 3. 도구 선택 | 자유 입력 두 칸을 프로필의 도구 목록에서 고르는 체크 목록 하나로 바꾼다. 그 전에, 카드의 도구 제한이 실행에 적용되지 않는 지금의 결함을 먼저 고친다 |
| 4. 담당 팀 | 에이전트 행에 `managing_team_id`를 둔다. 팀 구성원 행에 역할(`lead`·`member`)을 더한다. 담당 팀의 `lead`는 에이전트 관리자 권한을, `member`는 관리 권한 없이 그 에이전트를 쓰는 사람이 된다. **담당 팀 필수, 담당 팀 안팎의 권한, 세션 열람 범위는 [agent-rbac.md](agent-rbac.md)가 대체한다** |

## 지금 구조 (실측)

### 마법사 단계와 저장 위치

- 단계는 `name` → `job` → `release` → `activate` → `channels` 다섯이다(`apps/web/src/components/new-agent-flow.tsx:118`).
- 1단계 이름은 `name`(1~120자)과 `slug`다. `job` 단계에서 저장할 때 `POST /v1/agents`의 `{slug, name, card}`로 보낸다(`new-agent-flow.tsx:379-385`, 계약 `packages/contracts/src/kollegium/agents.ts:537-543`). `name`은 카드가 아니라 에이전트 행에 있어서 이름을 바꿔도 새 버전이 생기지 않는다(`agents.ts:127-130`, 행 `packages/db/migrations/0139_agents.sql:48-62`).
- 2단계 '하는 일'의 필드는 모두 카드 하나에 들어간다. 폼 모양은 `CardDraft`(`apps/web/src/components/agent-card-form.tsx:37-46`), 보낼 카드는 `cardFromDraft`(`agent-card-form.tsx:84-99`)다.

| 화면 | 카드 필드 | 계약 |
|---|---|---|
| 역할 한 줄 | `role` | `z.string().min(1).max(200)` (`agents.ts:138`) |
| 지시 사항 | `instructions` | 1~20000자 (`agents.ts:139`, `packages/contracts/src/shared/agent-card.ts:1`) |
| 답변 언어 | `language` | `ko`·`en`, 기본 `ko` (`agents.ts:140`) |
| 모델 | `model` | 1~128자 (`agents.ts:141-142`). 프로필 모델 목록 안인지는 릴리스 때 본다(`packages/platform/src/agents/release-ids.ts:114`) |
| 쓸 수 있는 도구 | `capabilities.tools` | `null` = 프로필이 허용하는 전부, `[]` = 없음 (`agents.ts:96-97`) |
| 금지 도구 | `capabilities.forbidden` | 기본 `[]` (`agents.ts:104-105`) |

- 카드는 `agent_versions.card jsonb` 한 칸에 통째로 들어간다(`0139_agents.sql:35-46`). 버전 행은 insert만 된다. 같은 내용의 카드는 새 버전을 만들지 않는다.
- 3단계 릴리스는 프로필과 저장소를 받아 `POST /v1/agents/{id}/releases`에 `{version_id, runtime_profile_id, repository_id?}`를 보낸다(`new-agent-flow.tsx:707-715`). 저장소 선택은 프로필 `repository_mode`가 `required`면 첫 저장소, 아니면 '없음'으로 시작한다(`new-agent-flow.tsx:651-655`, 선택 칸 `:762-783`).

### 시스템 프롬프트는 어떻게 조립되나

- **카드의 `role`·`instructions`·`language`·`rules`는 실행에 들어가지 않는다.** 시험 파일을 빼면 이 필드를 읽는 코드는 `apps/web`·`apps/storybook`의 화면뿐이다(`git grep -n -E "card\.(instructions|role|language|rules)\b" -- ':!*.test.*' ':!*.stories.*'`에서 두 앱 밖의 결과는 0건). 아래 프롬프트 조립 경로에도 이 값이 없다.
- 프롬프트는 Claude Code preset에 `append`를 붙인 것이다(`packages/adapters/runtimes/claude/src/runtime.ts:246-251`). `append`는 `systemPromptAppend`가 만든다. 플랫폼 지시문과 저장소 CLAUDE.md를 잇는다(`packages/adapters/runtimes/claude/src/repository-instructions.ts:8-22`).
- 플랫폼 지시문은 저장소 없는 세션에 주는 `OUT_DIRECTORY_PROMPT` 한 줄뿐이다(`apps/worker/src/composition.ts:228`, `:258-262`). 이 문구는 checkpoint 지문에 들어가서 바꾸면 그 세션들의 checkpoint가 재개되지 않는다(`composition.ts:222-227` 주석). 지시문 조각의 타입은 `{ scope: "platform"; text }` 하나다(`packages/runtime-core/src/agent-runtime.ts:78`).
- 저장소 CLAUDE.md는 프로필 `project_settings.claude_md`가 `true`일 때만 읽는다(`composition.ts:263-267`). 기본값은 `false`다(`packages/platform/src/sessions/catalog.ts:204`). 파일 이름은 `CLAUDE.md` 하나다(`packages/adapters/runtimes/claude-codec/src/descriptor.ts:31`).
- 에이전트 단위의 지시문(에이전트별 CLAUDE.md·AGENTS.md)을 두는 자리는 지금 없다.

### 릴리스의 저장소는 세션 시작에 어떻게 쓰이나

- 릴리스 `repository_id`는 nullable이다(`agents.ts:400`, `packages/db/migrations/0176_agent_release_repository.sql:1`). 릴리스를 만들 때 `releaseRepositoryRefusal`이 프로필 `repository_mode`로 검사한다. `required`인데 없으면, `none`인데 있으면 422다(`packages/platform/src/agents/agent-service.ts:175-189`, `:404-415`).
- 세션을 만들 때 요청에 저장소가 없으면 릴리스의 저장소를 쓴다(`packages/platform/src/sessions/session-service.ts:649-650`). Slack은 저장소를 보내지 않는다(`packages/platform/src/musterrolle/slack-session-handler.ts:408-414`). 그래서 Slack 세션의 저장소는 늘 릴리스의 저장소다. 마법사 안내 문구 "Slack 세션과 저장소를 따로 보내지 않은 API 세션이 이 저장소에서 시작합니다"가 이 동작이다.
- 릴리스 `policy_pins.github.repositories`(상한)는 상세 'GitHub' 탭에서만 정한다. 릴리스 저장소는 그 목록 안에 있어야 한다(`agent-service.ts:159-161`).
- **어긋남:** 릴리스 생성 쪽은 저장소 없는 `optional` 릴리스에도 `github`를 허용한다(`agent-service.ts:143-149`, #990 결정 4). GitHub 탭 조회(`GET`, `packages/platform/src/agents/agent-github-service.ts:101`)는 릴리스 저장소가 없으면 프로필과 상관없이 응답의 `unsavable`을 `repository_none`으로 둔다(`agent-github-service.ts:146-153`). 처음 편집할 바탕(`legacyDefaults`)도 릴리스 저장소가 있을 때만 만든다(`agent-github-service.ts:154-156`). 바탕이 없으면 화면은 편집을 막는다(`apps/web/src/routes/agent-detail/github.tsx:564`). 즉 저장소 없는 릴리스는 GitHub 설정을 처음 만들 길이 없다.

### 도구는 실행에서 어떻게 강제되나

- 릴리스를 만들 때 `resolveReleaseContent`가 카드 도구를 검사하고 계산한다. 프로필 `tools` 밖의 이름이면 거절하고, `tools = 프로필 tools ∩ 고른 도구 − 금지 도구`를 만든다(`packages/platform/src/agents/release-ids.ts:124-144`). `tools: null`은 프로필 도구 전부다(`release-ids.ts:137-140`). 결과는 릴리스의 `runtime_config_snapshot.tools`와 `effective_tools`에 저장된다(`release-ids.ts:158-170`).
- **그런데 실행은 이 값을 쓰지 않는다.** claim이 worker에 주는 `runtime_config.tools`는 프로필의 `tools`다(`catalog.ts:733-747`, 호출 `packages/platform/src/workers/worker-gateway.ts:903`). worker는 이를 SDK `tools`로 넘기고(`composition.ts:255`, `runtime.ts:254`), 그 목록 밖의 호출만 막는다. `effective_tools`와 `capabilities.forbidden`을 실행 경로에서 읽는 코드는 없다. 시험과 문서를 뺀 `git grep -n "capabilities.forbidden"`의 결과는 화면 읽기(`apps/web/src/components/agent-card-form.tsx:75`, `apps/web/src/routes/agent-detail/overview.tsx:630`, `apps/storybook/src/screens/agent-detail-parts.tsx:876`)와 릴리스 계산(`release-ids.ts:141`, `:212`, `:218`)뿐이다. 카드의 MCP 도구 정책(`policy_pins.tools.per_tool`)만 egress proxy가 읽는다. 그래서 지금 '고른 도구만'과 '금지 도구'는 내장 도구에 효과가 없다. 화면은 "한 줄에 하나. 에이전트는 이 도구를 쓸 수 없습니다"라고 안내한다(`apps/web/src/i18n/agents.ts:99-100`).
- 도구 이름의 출처는 프로필 `tools`(자유 문자열)다. 설치 상한 프로필 스키마는 개수 제한이 없고(`packages/platform/src/sessions/catalog.ts:199`), 워크스페이스 프로필 생성 요청만 최대 64개다(`packages/contracts/src/api/profiles.ts:205`). `GET /v1/profiles`가 프로필마다 `tools`를 준다(`profiles.ts:119`). 내장 도구 전체 목록을 주는 API는 없다.
- 마법사는 카드를 프로필보다 먼저 정한다. 2단계에서는 아직 어느 프로필로 릴리스할지 모른다.

### 에이전트 관리자와 팀

- 사람 관리자는 `agent_admins`(`packages/db/migrations/0142_agent_admins.sql:1-8`), 팀 관리자는 `agent_admin_teams`(`packages/db/migrations/0145_member_teams.sql:1-8`)다. 에이전트를 만든 사람이 첫 관리자가 된다(`packages/db/src/agents.ts:422-428`).
- **팀을 관리자로 추가하면 그 팀의 살아 있는 구성원 모두가 관리자다.** `administers()`는 "자기 행이 있거나, 관리자 팀의 구성원"이면 참이다(`packages/db/src/administers.ts:27-68`). 화면도 그렇게 안내한다(`apps/web/src/i18n/teams.ts:4`).
- **팀 안에는 역할이 없다.** `member_team_members`에 역할 열이 없다(`0145_member_teams.sql:10-18`). '팀 관리자'와 '구성원'은 팀 단위로 나뉘지 않는다. 역할은 워크스페이스 단위의 `owner`·`admin`·`member`뿐이다.
- 권한 판정: 관리 action은 워크스페이스 역할로 판정한다(`packages/platform/src/musterrolle/policy.ts:272-295`). 역할이 모자라면 `AGENT_ADMIN_ACTIONS`(`policy.ts:309-317`)에 든 action에 한해 그 에이전트의 관리자인지 다시 본다(`policy.ts:594-606`). 즉 `member`는 에이전트를 만들 수 있고, 관리자인 에이전트만 관리한다. 팀을 만들고 구성원을 넣는 것은 `owner`·`admin`만 한다(`policy.ts:278`). 팀 목록 API도 `owner`·`admin`만 부른다(`apps/control-host/src/api/openapi.ts:4910-4914`).
- 에이전트에는 소유·담당 팀 열이 없다(`0139_agents.sql:48-62`). 마법사에도 팀 입력이 없다.

### 세션 공개 범위

- 범위는 `private`·`people`·`team`·`workspace`다(`packages/contracts/src/musterrolle/session-shares.ts:26-31`). 행이 없으면 `workspace`로 읽는다(`packages/db/src/session-shares.ts:97`). 세션을 만들 때 넣을 수 있는 값은 `private` 하나다(`session-service.ts:613`). Slack DM만 이를 쓴다(`slack-session-handler.ts:415`).
- 운영자 문서도 `workspace`를 기본값으로 적는다(`docs/operator/api-server.md:617`, `:623`). 에이전트 관리자라는 이유로 공유 밖 세션을 보지는 못한다(`api-server.md:629`).

## 항목 1: 저장소 지정 제거

### 후보

- **A. 마법사에서만 뺀다(추천).** 마법사가 만드는 릴리스는 `repository_id`를 보내지 않는다. 기본 저장소는 상세 '릴리스' 탭(`apps/web/src/routes/agent-detail/releases.tsx`)에서만 고른다. 계약·DB는 그대로다.
- B. 릴리스에서 `repository_id`를 없앤다. Slack 세션이 기본 저장소 없이 시작하게 되고, `required` 프로필과 기존 릴리스 id(`release-ids.ts`가 저장소를 해시에 넣는다)를 모두 다시 정의해야 한다. #990은 기본 저장소를 "선택"으로 남겼으므로 이 안은 그 결정을 넘는다. 택하지 않는다.

### 설계(A)

- 데이터 모델·API·마이그레이션: 바꾸지 않는다.
- 화면: 마법사 3단계에서 저장소 칸과 안내 문구를 지운다. 프로필 목록에서 `repository_mode = required` 프로필은 고를 수 없게 하고, "저장소가 꼭 필요한 프로필은 에이전트 상세의 릴리스 탭에서 기본 저장소와 함께 릴리스합니다"를 보인다. 고를 프로필이 하나도 없으면 다음 단계로 가지 않고 그 안내만 보인다.
- 런타임 영향: 마법사로 만든 에이전트의 Slack 세션은 기본 저장소 없이 시작한다. `optional` 프로필이면 #990 순서 3·4가 들어간 뒤 일하는 도중에 저장소를 붙인다. 그 전에는 `out/`에 결과를 둔다(`composition.ts:228`).
- 같이 고칠 것: 저장소 없는 `optional` 릴리스의 GitHub 탭. 조회의 `unsavable`(`agent-github-service.ts:146-153`)을 릴리스 생성 쪽 규칙(`agent-service.ts:143-149`)에 맞추고, 릴리스 저장소가 없을 때 쓸 빈 편집 바탕(`repositories: []`, 기능 꺼짐)을 정한다(`legacyDefaults`, `agent-github-service.ts:154-156`). 그러지 않으면 마법사로 만든 에이전트는 GitHub 설정을 처음 만들 수 없다. 검증은 "마법사로 생성 → GitHub 탭 설정 → 릴리스 → 켜기" 전체 흐름이다. 이 고침은 #990 순서 3("기본 저장소 없는 `optional` 세션의 차단 제거")과 겹친다. 그 작업이 이미 고쳤으면 이 단위에서는 빼고 시험만 더한다.

## 항목 2: 이름과 설명

### 후보

- **A. 행에 `description`, 카드에 `agent_instructions`(추천).** 이름·설명은 에이전트 행의 값이다. 바꿔도 새 버전·릴리스가 생기지 않는다. 동작 지시는 카드(버전·릴리스로 고정되는 값)에 둔다.
- B. 카드에 `name`·`description`을 두고 `role`·`instructions` 이름을 바꾼다. 설명 한 글자를 고쳐도 새 버전과 새 릴리스가 필요하다. 이름은 이미 행에 있어 두 곳이 생긴다(`agents.ts:127-130`가 피한 바로 그 모양). 택하지 않는다.

### 데이터 모델

| 대상 | 바뀌는 것 |
|---|---|
| `agents` | `description text NULL`, `CHECK (description IS NULL OR length(description) <= 2000)` |
| 카드 `role` | 선택값이 된다(`optional`). 새 카드는 보내지 않는다. 옛 버전 행의 값은 그대로 둔다 |
| 카드 `instructions` | 선택값이 된다. 새 카드는 보내지 않는다. 옛 값은 그대로 둔다 |
| 카드 `agent_instructions` | 새 선택값. 0~20000자(`AGENT_INSTRUCTIONS_MAX_LENGTH` 재사용). 비면 프롬프트에 아무것도 붙지 않는다 |

- 카드 스키마는 `.strict()`이고, 저장된 카드를 읽는 스키마도 옛 `tone`만 더 받는다(`agents.ts:136-146`, `:154-156`). 옛 이미지는 `role`·`instructions`가 없는 카드도, `agent_instructions`가 있는 카드도 거절한다. 그래서 순서는 ① 새 모양을 읽는 계약을 배포하고 ② 다음 배포에서 쓰는 쪽(마법사가 두 필드를 빼고 지시문을 쓰는 것)을 켠다. 새 모양의 카드가 하나라도 저장되면 ① 이미지가 롤백 하한이 된다. 옛 이미지에 맞추려고 저장된 카드를 고치지 않는다. 카드 해시와 릴리스 id가 저장된 내용에 달려 있다.
- 두 필드를 선택으로 바꾸는 단위(U4a)는 읽는 쪽을 모두 함께 고친다. 화면을 지우는 것과 새 카드를 쓰는 것만 U4c에 남긴다.
  - 에이전트 목록 요약: 카드 JSON에서 `role`·`instructions`를 꺼내고(`packages/db/src/agent-summaries.ts:81-82`) `clip()`이 문자열이라고 가정한다(`agent-summaries.ts:30`, `:254`). 값이 없으면 SQL `NULL`이 와서 깨진다. 요약 계약도 두 값을 1자 이상 문자열로 요구한다(`packages/contracts/src/kollegium/agents.ts:450-455`). 요약은 `role` 대신 `description`(행 값)을 싣고, 두 필드는 nullable로 바꾼다.
  - 목록 카드 어댑터: `factsOf`가 상세의 카드 `role`·`instructions`를 요약 모양(`AgentSummary["version"]`)으로 옮긴다(`apps/web/src/components/agent-cards.tsx:60`, `:128-136`). 요약 계약을 바꾸면 이 어댑터도 같은 단위에서 맞춘다. 보이는 모양을 바꾸는 것은 U4c다.
  - 폼: `CardDraft`가 두 값을 문자열로 받고(`agent-card-form.tsx:38-39`) `draftFromCard`가 카드 값을 그대로 넣는다(`agent-card-form.tsx:69-70`). 선택으로 바꾸면 타입 검사가 깨지므로 빈 문자열 대체를 같은 단위에 넣는다. `packages/core/src/forms/index.ts:68-70`의 초안 스키마도 같다.
  - 사용자 문서: `apps/docs/content/docs/agents/instructions-and-roles.mdx`(en·ja 포함)가 카드 필드를 설명한다. U4c와 U3에서 고친다.
- 카드 내용 해시와 릴리스 id는 카드 JSON 전체로 계산한다(`release-ids.ts:47-49`). 필드를 선택으로 바꿔도 기존 카드의 해시는 바뀌지 않는다. 기존 카드에 키를 더하거나 빼는 이행은 하지 않는다.

### API 계약

| 계약 | 바뀌는 것 |
|---|---|
| `POST /v1/agents` | `description?: string`(0~2000). 카드의 `role`·`instructions`는 선택 |
| `PATCH /v1/agents/{id}` | `description?: string \| null`. 카드 없이 보내면 새 버전을 만들지 않는다(`name`과 같다) |
| 에이전트 조회·목록 | `agent.description: string \| null` |
| 카드 | `agent_instructions?: string` |

### 기존 값 이행

- 마이그레이션은 `description`이 NULL인 에이전트에 한 번 채운다. 값은 활성 릴리스의 버전, 없으면 최신 버전의 카드 `role`이다. `role`은 지금 화면이 "한 줄로: 무엇을 맡는 에이전트인지"(`apps/web/src/i18n/agents.ts:87`)로 받은 값이라 설명의 뜻과 같다.
- 카드 `instructions`는 옮기지 않는다. 지금까지 실행에 한 번도 들어가지 않은 문장이다. `agent_instructions`로 자동으로 옮기면 기존 에이전트의 동작이 사람 확인 없이 바뀐다. 상세 설정에 "이전 지시 사항(적용된 적 없음)"으로 읽기 전용으로 보이고, '에이전트 지시문으로 가져오기'를 누르면 그 값으로 새 카드 버전을 만든다. 실행에 들어가는 것은 그 버전으로 릴리스한 뒤부터다.
- 되돌리기: 앱을 롤백해도 `description` 열은 남긴다. 옛 이미지는 모르는 열을 읽지 않으므로 그대로 둬도 된다. 카드 버전은 하나도 고치지 않는다. 열을 지우는 정리는 배포 뒤 사람이 고친 설명을 잃는 되돌릴 수 없는 작업이다. 하려면 내보내기와 복구 절차를 먼저 두고 오너 확인을 받는다.

### 시스템 프롬프트에 넣을지 (c)

- **추천 기본값: 이름·설명은 넣지 않는다.**
  1. 오너가 "이름이나 설명이 agent의 동작에 영향을 끼치면 안 된다"고 했다.
  2. 이름·설명은 행의 값이라 버전·릴리스 없이 바뀐다. 프롬프트에 넣으면 고정된 릴리스가 같은 내용으로 돈다는 성질이 깨진다. 릴리스 id는 카드와 실행 설정을 해시한 값이다(`release-ids.ts:63-79`).
  3. 플랫폼 지시문은 checkpoint 지문에 들어간다(`composition.ts:222-227`). 이름을 바꿀 때마다 진행 중인 세션의 checkpoint가 재개되지 않게 된다.
  4. 지금도 넣지 않는다. 넣지 않으면 기존 에이전트의 동작이 그대로다.
- "가볍게 한 줄"은 택하지 않는다. 에이전트가 자기 이름을 알아야 하는 경우(Slack에서 "너는 누구야")는 동작 지시의 일이고, 그것은 아래 에이전트 지시문에 쓴다.
- **동작 지시를 둘 자리:** 지금 상세의 탭은 개요·카드·릴리스·관리자·Slack·GitHub다(`AGENT_TABS`, `apps/web/src/routes/agent-detail.tsx:72-79`). '카드' 탭(카드 편집기 `apps/web/src/routes/agent-detail/card-editor.tsx`)의 이름을 '상세 설정'으로 바꾸고 그 안에 '에이전트 지시문' 칸을 둔다. 카드 `agent_instructions`에 저장되고, 버전·릴리스로 고정된다. 실행에서는 지시문 조각에 새 scope `agent`를 더해(`agent-runtime.ts:78`) 플랫폼 지시문 다음, 저장소 CLAUDE.md 앞에 붙인다. 머리말은 "Agent instructions set by this agent's administrators:"다. 이 값은 릴리스가 고정하므로 세션 안에서는 바뀌지 않고, checkpoint 지문이 달라지는 것도 새 릴리스로 시작한 세션뿐이다.
- **worker 호환:** claim의 `runtime_config`는 strict 계약이고(`packages/contracts/src/worker-protocol/index.ts:213`), 이전 이미지로 띄우는 launch도 있다(`worker-gateway.ts:1366-1370`). 그래서 지시문은 ① worker 계약과 조립에 선택 필드를 더한 이미지를 먼저 배포하고 ② 그 이미지가 하한이 된 뒤에 서버가 값이 있는 릴리스의 claim에 그 필드를 싣는다. 값이 없는 claim에는 필드를 싣지 않아 옛 worker와 지문이 그대로다. 복구 검증 도구(`scripts/lib/checkpoint-pins.ts:165`, `:226`)도 같은 지시문을 넣어 지문을 다시 만들게 한다. 그 호출자(`scripts/lib/checkpoint-pins-cli.ts:297-301`, `:340-351`)는 세션·프로필 열만 읽으므로, 세션의 릴리스와 카드 지시문을 읽어 넘기는 일도 같은 단위에 넣는다.
- 저장소의 AGENTS.md: 지금은 `CLAUDE.md`만 읽는다(`descriptor.ts:31`). AGENTS.md를 따로 읽는 것은 이 설계의 범위가 아니다. 에이전트 지시문 칸에 붙여 넣어 쓴다.

### 화면

- 마법사 1단계 '이름': 이름, slug, 설명(선택, 여러 줄), 담당 팀(필수, [agent-rbac.md (d)](agent-rbac.md#d-담당-팀-필수)).
- 마법사 2단계 '하는 일': 모델, 도구(항목 3), 답변 언어. 역할·지시 사항 칸은 없다.
- 목록 카드(`apps/web/src/components/agent-cards.tsx`)와 상세 머리(`apps/web/src/routes/agent-detail.tsx:527-548`)는 `role` 대신 `description`을 보인다. 둘 다 없으면 비운다.
- 상세 설정: 이름·설명(행 값, 바로 저장)과 카드 값(모델·도구·언어·에이전트 지시문, 새 버전)을 다른 묶음으로 나눈다. 행 값은 릴리스가 필요 없다는 것이 보여야 한다.

### 런타임 영향

- 이름·설명: 없다.
- 에이전트 지시문: 값이 있는 카드로 만든 릴리스의 세션부터 프롬프트에 붙는다. 기존 릴리스는 영향 없다.
- 답변 언어(`language`)도 지금 실행에 들어가지 않는다. 이 설계의 범위가 아니어서 [발견](#발견)에 적는다.

## 항목 3: 도구 선택

### 후보

- **A. 실행 적용부터, 그다음 체크 목록(추천).** 먼저 claim이 릴리스의 계산된 도구(`runtime_config_snapshot.tools`)를 쓰게 고친다. 그다음 화면을 프로필 도구의 체크 목록 하나로 바꾼다.
- B. 화면만 바꾼다. 고른 값이 실행에 들어가지 않는 상태에서 고르는 UI만 좋아진다. 오너 질문("이게 아니지? 개선할거지?")의 답이 될 수 없다. 택하지 않는다.
- C. 2단계에서 프로필 합집합이 아니라 '미리보기 프로필' 하나를 기준으로 도구를 고르게 한다. 프로필은 카드에 저장하지 않고 편집 문맥으로만 쓴다. 같은 카드로 다른 프로필에 릴리스하는 지금의 모델(`release-ids.ts:100-104`)은 그대로다. 3b가 이 방식을 쓴다(Codex 반론 11).

### 3a. 실행에 적용

- claim의 `runtime_config.tools`를 "세션에 릴리스가 있으면 릴리스의 `runtime_config_snapshot.tools`, 없으면 프로필 `tools`"로 바꾼다(`catalog.ts:733-747`, `worker-gateway.ts:903`). 릴리스 값은 이미 프로필 도구의 부분집합이다(`release-ids.ts:124-144`).
- claim이 릴리스 값을 알려면 worker binding이 그것을 실어야 한다. 지금 `WorkerBinding`에는 릴리스 id도 도구도 없다(`packages/platform/src/ports/worker-unit-of-work.ts:33`, 구현 `packages/db/src/worker-unit-of-work.ts:1386`). MCP 경로의 릴리스 조회는 MCP 서버가 없는 릴리스에서 null이라 대신 쓸 수 없다(`packages/db/src/mcp-egress.ts:77-79`). binding에 "릴리스의 도구 목록 또는 릴리스 없음"을 따로 싣는다. 빈 목록(`[]`, 도구 없음)과 릴리스 없음을 구분한다.
- checkpoint 호환: 도구는 지문에 들어간다(`packages/adapters/runtimes/claude/src/profile-fingerprint.ts:66`, `catalog.ts:727-732` 주석). 두 방향을 모두 지킨다.
  - 앞으로: 배포 전 checkpoint는 프로필 도구 전부로 만든 지문이다. claim의 `restore_runtime_configs`(`worker-gateway.ts:943`)에 "프로필 도구 전부" 설정을 대체로 넣는다. fallback checkpoint와 GitHub 서버를 붙이기 전·후 변형(`worker-gateway.ts:949-957`)에도 같이 넣는다. 첫 claim만의 일이 아니라, 옛 지문의 checkpoint가 남아 있는 동안 계속 넣는다.
  - 롤백: 좁힌 도구로 만든 checkpoint는 옛 이미지가 재개하지 못한다. 옛 대체 설정 생성은 같은 프로필·모델이면 건너뛴다(`worker-gateway.ts:926-931`). 그래서 ① 두 설정을 모두 대체로 넣을 줄 아는 이미지를 먼저 배포하고 ② 그 이미지가 롤백 하한이 된 뒤에 좁힘을 켠다(설정 플래그 또는 다음 배포).
  - 복구 검증 도구도 claim과 같은 규칙으로 도구를 정하게 한다. 지금은 카탈로그 프로필만으로 claim을 다시 만든다(`scripts/lib/checkpoint-pins.ts:165`, `:226`).
- 동작 변화: `tools`를 고르거나 `forbidden`을 적은 기존 에이전트는 다음 claim부터 그 값대로 좁혀진다. claim마다 실행 설정을 다시 만들므로(`worker-gateway.ts:903`) 이미 진행 중인 세션도 다음 claim부터(마지막 턴 뒤 30분 idle로 실행 환경이 내려간 다음의 메시지, 또는 일시 정지·재개 뒤) 좁혀진다. 턴마다가 아니다(U2b JeongJaeSoon/agent-platform#1087에서 실측). 화면이 약속한 동작이 되는 것이다. 배포 전에 그런 릴리스가 몇 개인지 세어 PR 본문에 적는다(`SELECT count(*) FROM agent_releases WHERE runtime_config_snapshot->'tools' <> …` 같은 읽기 쿼리, 운영 DB에서는 리드가 돌린다).
- MCP 도구는 지금처럼 `per_tool`이 `allow`인 것만 붙는다(`pinnedMcpTools` `catalog.ts:642-656`, `runtimeConfigWithMcp` `catalog.ts:693-708`). 바꾸지 않는다.

### 3b. 체크 목록

- 데이터 모델·API: 바꾸지 않는다. 카드 `capabilities.tools`(목록 또는 `null`)와 `forbidden`을 그대로 쓴다.
- 도구 목록의 출처: '미리보기 프로필' 하나의 `tools`. 고른 모델을 돌리는 프로필(`modelOptions`가 모델별 프로필 id를 모은다, `agent-card-form.tsx:111-128`) 중 마법사에서 고를 수 있는 것(항목 1에서 `required`를 뺀 것)만 후보다. 첫 후보가 기본이고, 릴리스 단계는 이 프로필을 미리 골라 둔다. 프로필 합집합에서 고르게 하면 어느 프로필로도 릴리스할 수 없는 조합(A의 `Bash` + B의 `Edit`)이 저장된다. 이 안을 버린 이유다. 고른 도구를 모두 허용하는 프로필 수를 목록 아래에 보이고, 0이면 저장하지 않는다.
- 화면: '쓸 수 있는 도구' 하나의 체크 목록.
  - 맨 위 '릴리스할 때 프로필이 허용하는 도구 전부' 스위치가 켜져 있으면 `tools: null`이다. 끄면 아래 체크 목록에서 고른 것이 `tools`다. `null`은 릴리스를 만들 때 풀려 고정되므로(`release-ids.ts:137-140`, `:158-170`) 프로필에 나중에 더한 도구는 새 릴리스부터 들어간다. 스위치 설명이 이를 말한다.
  - 금지 도구 칸은 없앤다. 체크를 끄는 것이 금지다. 새 카드는 `forbidden: []`이다.
  - 체크를 끈 내장 도구에 `tool_policy.per_tool` 항목이 남아 있으면 지운다. 폼은 이 값을 보존하고(`agent-card-form.tsx:80-82`), 릴리스는 실행 도구 밖의 내장 도구 항목을 거절한다(`release-ids.ts:253-255`). 남겨 두면 화면에서 고칠 수 없는 이유로 릴리스가 실패한다. MCP 도구 정책은 이 목록과 따로 붙으므로 건드리지 않는다.
  - 기존 카드에 `forbidden`이 있으면 읽기 전용 목록으로 보이고 '지우기'를 둔다. 프로필 목록에 없는 이름이 `tools`에 있으면 "프로필에 없는 도구"로 체크된 채 보이고 끌 수만 있다.
  - 도구 이름 옆 설명은 알려진 내장 도구(`Read`·`Edit`·`Bash` 등)만 i18n 문구로 보인다. 모르는 이름은 이름만 보인다.
- 기존 값 이행: 없다.

## 항목 4: 담당 팀

> **이 항목은 [agent-rbac.md](agent-rbac.md)로 바뀌었다.** 데이터 모델(`managing_team_id`, 팀 역할)은 그대로다. 담당 팀은 필수가 됐다. 담당 팀으로 고를 수 있는 팀은 "자기가 `lead`인 팀"에서 "자기가 속한 팀"으로 넓어졌다. 담당 팀 `member`의 권한도 정했다. 아래 "세션 공개 범위 기본값"은 폐기하고 워크스페이스 설정 축 B로 대체했다. 담당 팀이 맡은 에이전트가 있으면 팀을 보관하지 못한다. 구현 단위 U5a~U5c는 그 문서의 R1~R5로 대체했다. 아래 본문은 결정 기록으로 남기며, 그 문서와 다르면 그 문서를 따른다.

### 후보

- **A. 에이전트에 담당 팀 하나, 팀 구성원에 역할(추천).** `agents.managing_team_id`와 `member_team_members.role`(`lead`·`member`)을 더한다. 담당 팀의 `lead`는 그 에이전트의 관리자 권한을 받는다. `member`는 관리 권한이 없다. 기존 `agent_admin_teams`(구성원 모두 관리자)는 그대로 둔다.
- B. 기존 `agent_admin_teams`에 역할 조건만 더한다. 팀을 관리자로 추가한 기존 에이전트에서 지금 관리자인 구성원이 권한을 잃는다(팀 역할 행이 아직 없으므로). 되돌리기 어렵고, 담당 팀이라는 개념(에이전트 하나에 팀 하나)도 생기지 않는다. 택하지 않는다.
- C. 팀 역할 없이 담당 팀 구성원 모두를 관리자로 한다. 지금의 '팀을 관리자로 추가'와 같아서 새로 얻는 것이 없고, 오너 질문("팀의 관리자인지 구성원인지의 권한을 따라가는거지")에 답하지 못한다.

### 데이터 모델

| 대상 | 바뀌는 것 |
|---|---|
| `member_team_members` | `role text NOT NULL DEFAULT 'member' CHECK (role IN ('lead','member'))` |
| `agents` | `managing_team_id uuid NULL`, FK `(workspace_id, managing_team_id)` → `member_teams` |
| 감사 | `set_agent_managing_team`, `set_team_member_role` receipt |

- 담당 팀이 보관(archive)되면 그 팀에서 오는 권한은 없어진다. 열 값은 남기고 화면에 "보관된 팀"으로 보인다. `administers()`가 이미 보관된 팀을 거르는 방식(`administers.ts:44-51`)과 같다.

### 권한

| 사람 | 그 에이전트에 대해 |
|---|---|
| 워크스페이스 `owner`·`admin` | 지금처럼 모든 관리 |
| 사람 관리자(`agent_admins`) | 지금처럼 `AGENT_ADMIN_ACTIONS` |
| 관리자 팀(`agent_admin_teams`)의 구성원 | 지금처럼 `AGENT_ADMIN_ACTIONS`(역할 무관) |
| **담당 팀의 `lead`** | `AGENT_ADMIN_ACTIONS`. 관리자와 같다 |
| **담당 팀의 `member`** | 관리 권한 없음. 설정 열람·사용·세션 열람은 [agent-rbac.md (b)](agent-rbac.md#b-rbac-표)를 따른다 |

- 구현은 관리자 판정 두 곳에 세 번째 경로 "담당 팀이 보관되지 않았고, 그 팀의 살아 있는 구성원이며, 역할이 `lead`"를 더하는 것이다.
  - 읽기 판정: `administers()`(`administers.ts:27-68`). 판정 지점(`policy.ts:594-606`)이 이것을 쓴다.
  - 쓰기 안의 재확인: 잠금을 거는 별도 함수 `lockedAdministers()`(`packages/db/src/agent-admins.ts:28`). 관리자 변경(`agent-admins.ts:147`)과 API 키 쓰기(`packages/db/src/api-keys.ts:131`)가 이것을 쓴다. 여기에도 같은 경로를 더하고, 에이전트의 담당 팀 열·팀 행·구성원 행을 잠근 뒤 본다. 한쪽만 고치면 담당 팀 `lead`가 판정은 지나고 쓰기에서 거절된다.
  - 담당 팀을 지정·변경하는 쓰기도 같은 트랜잭션에서 팀이 살아 있는지, 지정하는 사람이 그 팀의 `lead`인지(아래 제한)를 잠근 채 다시 본다. 동시에 강등·보관되어도 낡은 권한으로 지정되지 않게 한다.
- 팀 역할을 정하는 사람: 지금처럼 `team.manage`(`owner`·`admin`). 팀의 `lead`가 자기 팀 구성원을 관리하는 권한은 이번에 만들지 않는다.
- 겹치는 권한: 한 팀이 담당 팀이면서 관리자 팀(`agent_admin_teams`)이기도 하면, 그 팀의 `member`도 관리자 팀 경로로 관리자다. `lead`를 `member`로 내려도 관리자 팀 경로의 권한은 남는다. 관리자 탭은 두 경로를 함께 보이고 "이 팀은 관리자 팀으로도 추가되어 있어 구성원 모두가 관리합니다"를 적는다.
- 기존 관리자 팀 추가 경로의 우회 막기: 지금은 `agent.admin.manage`만 있으면 어느 살아 있는 팀이든 관리자 팀으로 추가한다(`packages/platform/src/musterrolle/agent-admin-service.ts:80`, `packages/db/src/agent-admins.ts:209`). 담당 팀 지정만 제한하면 `member`인 관리자가 같은 팀을 관리자 팀으로 추가해 그 팀 구성원 모두에게 관리 권한을 준다. 그래서 새로 추가하는 관리자 팀에도 같은 제한(`owner`·`admin`이 아니면 자기가 `lead`인 팀만)을 건다. 이미 있는 관리자 팀 행은 그대로 둔다.

### 생성 때 지정과 생성 뒤 변경

- `POST /v1/agents`에 `managing_team_id?: string`. `owner`·`admin`은 아무 살아 있는 팀이나, `member`는 자기가 `lead`인 팀만 지정한다. 아니면 403 `team_not_allowed`. 이 제한이 없으면 `member`가 다른 팀을 담당 팀으로 지정해 그 팀 `lead`에게 관리 권한을 주게 된다(권한을 받는 쪽이 원하지 않는 부여).
- `PUT /v1/agents/{id}/managing-team` `{team_id: string | null}`. action은 `agent.admin.manage`. `member`인 에이전트 관리자는 자기가 `lead`인 팀으로만 바꾼다. 지우기(`null`)는 관리자면 된다.
- 마법사가 팀을 고르려면 목록이 필요하다. 전체 팀 목록은 `owner`·`admin`만 부른다(`openapi.ts:4910-4914`). 로그인한 사람 누구나 부르는 `GET /v1/my-teams`(`openapi.ts:4925-4931`, `packages/platform/src/musterrolle/team-service.ts:137`)가 이미 있다. 여기에 팀마다 호출자의 `role`을 더해 `member`는 `lead`인 팀만 고르게 한다. `owner`·`admin`은 지금의 `/v1/teams`를 쓴다. 목록이 무엇을 보이든 지정은 쓰기에서 따로 검사한다.
- 화면:
  - 마법사 1단계에 '담당 팀'(선택). 고를 팀이 없으면 칸 대신 "팀 관리자로 지정된 팀이 없어 담당 팀은 나중에 정할 수 있습니다"를 보인다.
  - 상세 '관리자' 탭(`apps/web/src/components/agent-admins.tsx`) 맨 위에 '담당 팀' 묶음. 팀 이름, 바꾸기·지우기, "이 팀의 팀 관리자는 이 에이전트를 관리하고, 구성원은 관리하지 않습니다". 그 아래 지금의 관리자 목록.
  - 팀 화면(`apps/web/src/routes/teams.tsx`)에 구성원별 역할 선택.
- 기존 값 이행: `member_team_members.role`은 모두 `member`로 시작한다. 담당 팀은 모든 에이전트가 NULL로 시작한다. 기존 권한은 하나도 줄지 않는다.
- 되돌리기: 앱을 롤백해도 두 열은 남긴다. 옛 이미지는 두 열을 모르므로 담당 팀 `lead`의 권한만 사라지고 다른 권한은 그대로다. 열을 지우는 정리는 배포 뒤의 지정과 승격을 잃는 되돌릴 수 없는 작업이라 내보내기·복구 절차와 오너 확인이 먼저다.

### 세션 공개 범위 기본값 (폐기: [agent-rbac.md](agent-rbac.md)의 축 B로 대체)

- 차이: 오너 답글 하나는 "세션 공개 범위 기본값은 Agent 관리 팀과 같다", 다른 답글과 PRD는 '워크스페이스'다. 코드와 운영자 문서는 '워크스페이스'다(`session-shares.ts:97`, `api-server.md:617`).
- 선택지:
  1. 워크스페이스 유지. 바뀌는 것 없음. 담당 팀은 권한에만 쓴다.
  2. **담당 팀이 있으면 담당 팀, 없으면 워크스페이스(추천).** 세션을 만들 때 그 에이전트에 담당 팀이 있으면 `team` 범위와 그 팀을 대상으로 공유 행을 넣는다. Slack DM은 지금처럼 `private`가 이긴다. 만든 사람은 늘 본다. 담당 팀이 없는 에이전트(이행 직후의 모든 에이전트)는 지금과 같다. 담당 팀을 바꿔도 이미 만든 세션의 공유는 바꾸지 않는다.
  3. 항상 담당 팀. 담당 팀이 없는 에이전트의 세션을 어떻게 할지(`private`?) 따로 정해야 하고, 기존 사용자에게 갑자기 세션이 안 보이게 된다.
- 2의 추가 계약: `session-service.ts:613`의 `shareScope`가 `"private" | {team_id}`를 받는다. 운영자 문서 `api-server.md:617`, `:623`의 기본값 설명을 고친다. 워크스페이스 `owner`·`admin`이 팀 밖 세션을 보는 것은 지금처럼 감사 열람(`OUT_OF_SHARE_ACTIONS`, `policy.ts:301-306`) 경로다.
- 이 질문과 U5c는 폐기했다. 공유 행을 쓰지 않고 판정 시점의 상한(워크스페이스 설정 축 B)으로 바꿨다. 이유는 [agent-rbac.md (e)](agent-rbac.md#e-앞선-결정과의-차이)에 있다.

## 구현 단위

| 단위 | 내용 | 쓰기 경로 | start-after | land-after |
|---|---|---|---|---|
| U1 | 저장소 지정 제거: 마법사 3단계, `required` 프로필 안내, GitHub 탭의 `repository_none` 어긋남 | `apps/web/src/components/new-agent-flow.tsx`, `apps/web/src/i18n/agents.ts`, `packages/platform/src/agents/agent-github-service.ts`와 시험, `apps/web` 시험·story | 없음(#990 순서 3이 GitHub 탭을 고쳤는지 먼저 확인) | 없음 |
| U2a | 도구 실행 적용의 바탕: binding에 릴리스 도구 싣기, 두 지문 모두 대체로 넣기, 복구 검증 도구. 좁힘은 아직 끈다 | `packages/platform/src/ports/worker-unit-of-work.ts`, `packages/db/src/worker-unit-of-work.ts`, `packages/platform/src/sessions/catalog.ts`, `packages/platform/src/workers/worker-gateway.ts`, `scripts/lib/checkpoint-pins.ts`, `scripts/lib/checkpoint-pins-cli.ts`, 시험 | 없음 | 없음 |
| U2b | 도구 좁힘 켜기(3a). U2a 이미지가 롤백 하한이 된 뒤 | `packages/platform/src/sessions/catalog.ts` 또는 설정 플래그, 시험 | U2a 배포 | U2a |
| U3 | 도구 체크 목록(3b) | `apps/web/src/components/agent-card-form.tsx`, `packages/core/src/forms/index.ts`, `apps/web/src/i18n/agents.ts`, `apps/web/src/routes/agent-detail/overview.tsx`, story, `apps/docs/content/docs/agents/instructions-and-roles*.mdx` | U2b | U2b, U1, U4a |
| U4a | 이름·설명 계약과 이행: `agents.description`, 카드 `role`·`instructions` 선택, `agent_instructions` 계약(읽기만), 두 필드를 읽는 쪽의 대체값 | `packages/db/migrations/<다음 번호>`, `packages/db/src/schema.ts`, `packages/db/src/agents.ts`, `packages/db/src/agent-summaries.ts`, `packages/contracts/src/kollegium/agents.ts`, `packages/platform/src/agents/agent-service.ts`, `apps/web/src/components/agent-card-form.tsx`(대체값만), `apps/web/src/components/agent-cards.tsx`(어댑터만), `packages/core/src/forms/index.ts`(대체값만), `apps/control-host/src/api/openapi.ts`, `packages/client/src/schema.gen.ts`, `docs/openapi.json` | 없음 | 없음 |
| U4b | worker가 에이전트 지시문을 받는 계약과 조립, 복구 검증 도구(아직 서버는 싣지 않는다) | `packages/contracts/src/worker-protocol/index.ts`, `packages/runtime-core/src/agent-runtime.ts`, `apps/worker/src/composition.ts`, `packages/adapters/runtimes/claude/src/repository-instructions.ts`, `scripts/lib/checkpoint-pins.ts`, `scripts/lib/checkpoint-pins-cli.ts` | U4a | U4a, U2a |
| U4c | 이름·설명 화면, 지시문 쓰기 켜기, claim에 지시문 싣기, 사용자 문서. U4a·U4b 이미지가 하한이 된 뒤 | `apps/web/src/components/new-agent-flow.tsx`, `agent-card-form.tsx`, `agent-cards.tsx`, `packages/core/src/forms/index.ts`, `apps/web/src/routes/agent-detail*.tsx`(개요 `overview.tsx:580-587` 포함), `apps/storybook/src/screens/agent-detail-parts.tsx`, `apps/web/src/i18n/agents.ts`, `packages/platform/src/workers/worker-gateway.ts`, claim binding, `apps/docs/content/docs/agents/instructions-and-roles*.mdx` | U4b 배포 | U4b, U3 |
| U5a~U5c | (대체됨) [agent-rbac.md (f)](agent-rbac.md#f-구현-단위)의 R1~R5를 따른다. U5a → R1, U5b → R4, U5c(세션 공유 행 기본값)는 없애고 R3(워크스페이스 설정 축)로 대체한다 | 그 문서 참조 | — | — |

- 같은 경로를 쓰는 단위:
  - `new-agent-flow.tsx`: U1, U4c, R4
  - `agent-card-form.tsx`·`packages/core/src/forms/index.ts`: U4a(대체값), U3, U4c
  - `apps/web/src/components/agent-cards.tsx`: U4a(어댑터), U4c
  - `apps/web/src/routes/agent-detail/overview.tsx`: U3, U4c
  - `apps/docs/content/docs/agents/instructions-and-roles*.mdx`: U3, U4c
  - `apps/web/src/i18n/agents.ts`: U1, U3, U4c, R4
  - `packages/contracts/src/kollegium/agents.ts`·`openapi.ts`·`schema.gen.ts`·`docs/openapi.json`·`packages/db/src/schema.ts`·마이그레이션 번호: U4a, R1, R2, R5
  - `worker-gateway.ts`·`catalog.ts`: U2a, U2b, U4c
  - `scripts/lib/checkpoint-pins.ts`·`checkpoint-pins-cli.ts`: U2a, U4b
  - `docs/operator/api-server.md`: R1, R2, R3
- 줄 세우기: 화면 경로는 U1 → U3 → U4c → R4, 계약·DB 경로는 U4a → R1 → R2 → R3, claim 경로는 U2a → U2b → U4c. R1은 U4a와 계약·DB 파일을 나눠 쓰므로 U4a가 착지한 뒤 시작한다. 처음에 같이 시작할 수 있는 것은 U1, U2a, U4a다. R 단위의 순서는 [agent-rbac.md (f)](agent-rbac.md#f-구현-단위)를 따른다.
- 배포 하한이 필요한 단위: U2b(U2a 이미지), U4c(U4a·U4b 이미지). "착지"가 아니라 "그 이미지가 운영에 나가 롤백 하한이 됨"을 start-after로 본다.
- 티켓은 U1, U2a+U2b+U3, U4a+U4b+U4c 셋과 agent-rbac.md의 R 단위 묶음으로 나누고, 각 티켓 안에서 위 단위대로 PR을 나눈다.

## 오너 확인 필요

1. ~~세션 공개 범위 기본값~~: 폐기. [agent-rbac.md (g)](agent-rbac.md#g-오너-확인-필요)의 G2(워크스페이스 설정 축 B의 기본값)로 바뀌었다.
2. 되돌릴 수 없는 이행: 설계가 정한 이행은 열을 더하고 채우는 것뿐이고, 기존 카드 버전은 고치지 않는다. 롤백 때 새 열(`agents.description`, `agents.managing_team_id`, `member_team_members.role`)은 남긴다. 그 열을 지우는 정리는 배포 뒤 입력한 값을 잃으므로 되돌릴 수 없다. 하려면 그때 오너 확인을 받는다. 지금 계획에는 넣지 않는다.
3. 동작 변화(데이터 이행 아님): U2b는 `tools`를 고르거나 `forbidden`을 적은 기존 에이전트를 다음 claim부터 실제로 좁힌다. 이미 진행 중인 세션도 다음 claim부터(마지막 턴 뒤 30분 idle 또는 일시 정지·재개 뒤) 좁혀진다. 화면이 약속한 대로 되는 것이지만 오너에게 알린다. 켜기 전에 해당 릴리스 수를 센다.

## 발견

- 카드의 '고른 도구만'·'금지 도구'가 내장 도구 실행에 적용되지 않는다(위 [도구는 실행에서 어떻게 강제되나](#도구는-실행에서-어떻게-강제되나)). U2a·U2b가 고친다.
- 카드의 '답변 언어'(`language`)와 `rules`도 실행에 들어가지 않는다. 화면은 이 값이 답변에 쓰이는 것처럼 보인다.
- 저장소 없는 `optional` 릴리스는 GitHub 설정을 처음 만들 수 없다(`agent-github-service.ts:146-156`, `github.tsx:564`). 릴리스 생성 쪽(`agent-service.ts:143-149`)은 허용한다. U1이 고친다(#990 순서 3과 겹침).
- `member`인 에이전트 관리자는 어느 팀이든 관리자 팀으로 추가해 그 팀 구성원 모두에게 관리 권한을 줄 수 있다(`agent-admin-service.ts:80`, `agent-admins.ts:209`). 지금도 있는 동작이다. agent-rbac.md의 R1이 새 추가를 `lead`인 팀으로 제한한다.

## Codex 반론

2026-11-02 Codex(로컬 CLI, read-only)에게 이 문서의 첫 판을 반론하게 했다. 15건을 받았다. 받은 근거를 코드에서 다시 확인했고 모두 반영했다.

| # | 반론 | 처리 |
|---|---|---|
| 1 | 담당 팀 지정만 제한하면 기존 관리자 팀 추가 경로로 우회한다. 강등해도 관리자 팀 권한은 남는다 | 반영. 새 관리자 팀 추가에도 같은 제한, 겹치는 권한을 화면에 표시([권한](#권한)) |
| 2 | 에이전트 지시문에 worker 호환 단계가 없다. claim `runtime_config`는 strict이고 이전 이미지 launch가 있다 | 반영. worker 먼저(U4b), 서버가 싣는 것은 하한 뒤(U4c) |
| 3 | 도구 좁힘에 롤백 호환이 없다 | 반영. 두 지문을 다 넣는 이미지(U2a)를 하한으로 만든 뒤 켠다(U2b). fallback·GitHub 변형까지 |
| 4 | 쓰기 재확인은 `administers()`가 아니라 `lockedAdministers()`다 | 반영. 두 함수 모두 고치고 지정 쓰기도 잠금 재확인 |
| 5 | `repository_none`은 GET 응답 값이다. 더 큰 문제는 `legacyDefaults`가 없어 처음 편집을 못 하는 것 | 반영. 인용 뜻을 고치고 빈 편집 바탕을 정함, 전체 흐름 검증 |
| 6 | 옛 이미지는 `agent_instructions`가 있는 카드도 거절한다 | 반영. 읽기 계약 이미지가 롤백 하한, 저장된 카드는 고치지 않음 |
| 7 | "열을 지우면 된다"는 파괴적 되돌리기다 | 반영. 롤백 때 열은 남기고, 열 삭제는 오너 확인 항목으로 |
| 8 | 복구 검증 도구가 카탈로그 프로필로만 claim을 다시 만든다 | 반영. U2a·U4b 경로에 `checkpoint-pins` 추가 |
| 9 | `WorkerBinding`에 릴리스 정보가 없다. MCP 경로 조회는 대신 못 쓴다 | 반영. binding에 릴리스 도구를 싣고 `[]`와 릴리스 없음을 구분 |
| 10 | 체크를 끈 도구의 `per_tool` 항목이 남으면 릴리스가 실패한다 | 반영. 끈 내장 도구의 항목을 지움 |
| 11 | 프로필 합집합은 어느 프로필로도 릴리스할 수 없는 조합을 허용한다 | 반영. 미리보기 프로필 하나 기준으로 바꿈(후보 C를 고쳐 채택) |
| 12 | U4a·U5a가 같은 파일을 쓰는데 같이 시작한다고 했다. U4b에 core forms가 빠졌다 | 반영. U5a는 U4a 뒤, core forms를 U4c에 |
| 13 | '나중에 추가되는 도구 포함'은 사실이 아니다. `null`은 릴리스 때 고정된다 | 반영. 문구와 설명을 고침 |
| 14 | `GET /v1/my-teams`가 이미 있다 | 반영. 새 쿼리 대신 이 API에 역할을 더함 |
| 15 | grep 결과가 시험 파일을 빼지 않았다. 모델 검사 위치, 도구 64개 상한의 범위, 탭 목록이 틀렸다 | 반영. 인용을 고침 |

기각한 반론은 없다.

PR head `0471cab9d`에서 Codex가 고친 판을 다시 리뷰했다. 1차 반론 중 13건은 해결됐고, 8·15번이 일부만 해결됐다. 새로 받은 것을 포함해 5건을 모두 반영했다.

| # | 반론 | 처리 |
|---|---|---|
| R2-1 | 두 필드가 없는 새 카드는 에이전트 목록 요약을 깨뜨린다(`agent-summaries.ts`, 요약 계약) | 반영. U4a에 요약 쿼리·계약을 넣음 |
| R2-2 | U4a만 착지하면 폼 타입 검사가 깨진다 | 반영. 읽는 쪽 대체값을 U4a로 옮김 |
| R2-3 | 복구 검증 CLI가 릴리스 지시문을 넘기지 않는다(1차 8번의 나머지) | 반영. `checkpoint-pins-cli.ts`를 U4b에 넣음 |
| R2-4 | 도구 좁힘은 "다음 세션"이 아니라 진행 중 세션을 포함한 다음 claim부터다 | 반영. 3a와 오너 확인 항목의 문구를 고침 |
| R2-5 | `capabilities.forbidden` grep 결과 설명이 여전히 틀렸다(1차 15번의 나머지) | 반영. 화면 읽기와 릴리스 계산을 나눠 다시 적음 |

3차(head `cd62c327c`, 위 다섯 고침만): R2-3·R2-4·R2-5는 해결, R2-1·R2-2에 읽는 쪽 하나(`agent-cards.tsx`의 `factsOf`)가 빠졌다는 반론 1건. 반영해 U4a 경로와 같은 경로 목록에 넣었다.
