# 결정(설계): 에이전트 담당 팀 필수와 에이전트·세션 액션 RBAC

- 상태: 설계. 오너 확인이 필요한 항목은 [(g) 오너 확인 필요](#g-오너-확인-필요)에 모았다. 각 항목에 추천과 답이 없을 때의 기본값을 적었고, 이 문서는 그 기본값으로 머지한다. 결정이 바뀌면 후속 PR로 고친다.
- 기준 커밋: `origin/main` `718c96c5c`. 아래 `파일:줄`은 이 커밋 기준이다.
- 오너 원문(2026-11-02): "에이전트는 무조건 담당 팀이 붙는게 좋을거 같아 / 관리팀으로 지정안되어잇으면 관리자의 설정에 따라 권한이 없다고 할수 잇는게 제한되거 / 에이전트 자체의 정보는 볼 수 잇더라도 설정에 따라서는 에이전트 내에서 세션의 상세내용을 모두 못보고 자기가 실행할수 잇는거지 / 음 관리팀인지 아닌지에 따라서 에이전트 정보를 열람하고 조회하고 사용할수 잇는지, 그리고 세션정보도 어덯게 열람하고 조회하거 사용할스 잇을지 등등의 액션에 대한 rbac 설계가 필요해보여"
- 오너 원문(같은 날, 앞선 결정에 대해): "나머지 d125 나 d126도 기본적 베이스가 되는 d124 설계따라 다를듯?"
- 앞선 설계: [agent-wizard-rework.md](agent-wizard-rework.md)(JeongJaeSoon/agent-platform#1067)의 항목 4와 U5a~U5c. 이 문서와 다르면 이 문서가 우선이다. 차이는 [(e)](#e-앞선-결정과의-차이)에 있다.
- "담당 팀"과 앞선 설계의 "관리 팀"은 같은 것(`agents.managing_team_id`)이다. 문서와 화면 문구는 '담당 팀'으로 통일한다.

## 요약

| 항목 | 결론 |
|---|---|
| 주체 | 워크스페이스 관리자(`owner`·`admin`), 에이전트 관리자(담당 팀 `lead`, 개인 관리자, 관리자 팀 구성원), 담당 팀 `member`, 담당 팀 밖 `member`. 앞의 셋을 이 에이전트의 **안쪽**, 마지막을 **바깥쪽**이라 부른다 |
| 안쪽 | 에이전트 정보·설정을 보고, 에이전트를 쓰고, 공유 범위 안의 세션을 지금처럼 본다. 설정을 고치는 것은 워크스페이스 관리자와 에이전트 관리자다 |
| 바깥쪽 | 기본값은 에이전트 정보(이름·설명·담당 팀)를 보고, 에이전트를 실행하고, 자기 세션과 이름이나 팀으로 공유받은 세션만 본다. 설정은 보지 못한다 |
| 워크스페이스 설정 두 축 | A. 바깥쪽의 에이전트 접근: `use`(보고 실행, 기본) / `view`(보기만) / `none`(숨김). B. `workspace` 공개 세션이 바깥쪽에 보이는지: `managing_team`(안 보임, 기본) / `workspace`(보임) |
| 담당 팀 필수 | 새 에이전트는 담당 팀이 있어야 한다. 기존 에이전트는 비어 있는 채로 두고 지금처럼 동작하게 한다. 관리 화면에서 담당 팀을 정하라고 안내한다. 담당 팀이 맡은 에이전트가 있으면 그 팀은 보관하지 못한다 |
| 앞선 결정 | d124(세션 공유 행의 기본값을 담당 팀으로)는 폐기하고 판정 시점의 열람 상한(축 B)으로 바꾼다. d125는 "자기가 속한 팀"으로 넓힌다. d126은 유지한다 |

## (a) 지금 구조 (실측)

### 판정이 이뤄지는 곳

- 대부분의 라우트는 요청을 읽어 서비스를 부를 뿐이다. 권한 판정은 서비스가 `requirePermitted`·`requireAllowed`(`packages/platform/src/sessions/session-service.ts:268-299`)로 `policy.authorize`를 불러서 한다. 워크스페이스 설정처럼 라우트가 직접 판정하는 곳도 있다(`apps/control-host/src/api/routes/workspaces.ts:84-93`). 판정 본체는 `decide()`(`packages/platform/src/musterrolle/policy.ts:501-690`)다. 정책은 API(`apps/control-host/src/api/server.ts:458-466`)와 Slack(`apps/control-host/src/slack/main.ts:218`)에서 따로 조립한다.
- action마다 필요한 것이 다르다.
  - 관리 action은 워크스페이스 역할 목록 `MANAGEMENT_ROLES`(`policy.ts:272-295`)로 판정한다. 역할이 모자라면 `AGENT_ADMIN_ACTIONS`(`policy.ts:309-317`)에 든 action만 그 에이전트의 관리자인지 다시 본다(`policy.ts:594-606`). 사람이 아니면(API key) 늘 거절이다(`policy.ts:595`).
  - 세션 action은 scope로 판정한다(`ACTION_SCOPES`, `policy.ts:254-261`). 사람의 scope는 역할에서 나온다. `owner`는 전부, `admin`·`member`는 `sessions:recover`를 뺀 전부다(`packages/contracts/src/musterrolle/authorization.ts:43-51`).
- 리소스가 워크스페이스면 에이전트 관리자 경로를 타지 못한다. `agentOf`가 워크스페이스 종류에 null을 돌려주기 때문이다(`packages/db/src/agent-authority.ts:81`).
- 에이전트 관리자 판정(`isAdmin`, `agent-authority.ts:101-127`)은 살아 있는 구성원인지 본 뒤 `administers()`(`packages/db/src/administers.ts:27-68`)를 부른다. 경로는 개인 관리자 행(`administers.ts:33-42`)과, 관리자 팀의 살아 있는 구성원(`administers.ts:43-66`) 둘이다. 쓰기 안의 재확인은 잠금을 거는 `lockedAdministers()`(`packages/db/src/agent-admins.ts:28`)다.
- 팀에는 구성원 역할이 없다(`packages/db/migrations/0145_member_teams.sql:10-18`). 팀을 만들고 구성원을 넣는 것은 `team.manage`(`owner`·`admin`, `policy.ts:278`)다. 에이전트에는 담당 팀 열이 없다(`packages/db/migrations/0139_agents.sql:48-62`).
- 워크스페이스 설정은 `workspaces.settings` jsonb의 키다. 지금 키는 Slack 게스트 허용 하나다(`packages/db/src/workspace-settings.ts:18`, 쓰기 `:26-50`). 바꾸는 사람은 `workspace.manage`(`apps/control-host/src/api/routes/workspaces.ts:84-93`)다.

### 에이전트 action

"관리자"는 워크스페이스 `owner`·`admin`, "에이전트 관리자"는 개인 관리자나 관리자 팀 구성원이다.

| action | 라우트 | 판정(서비스) | 지금 할 수 있는 사람 |
|---|---|---|---|
| 에이전트 목록·요약·개수 | `apps/control-host/src/api/routes/agents.ts:27`, `:36` | 워크스페이스에 `agent.manage`(`packages/platform/src/agents/agent-service.ts:276`, `:297`) | 사람은 관리자만. `member`는 에이전트 관리자여도 403이다. 화면은 "전체 에이전트 목록은 소유자와 관리자만 봅니다"(`apps/web/src/i18n/agents.ts:9-10`)를 보인다. 예외로 에이전트 key는 `session.submit` 판정으로 자기 에이전트 행 하나를 읽는다(`agent-service.ts:223-261`, `:273-275`) |
| 내가 관리하는 에이전트 | `apps/control-host/src/api/routes/teams.ts:144` | 판정 없음. `administers()`로 거른 목록(`packages/db/src/agent-admins.ts:282-292`) | 로그인한 누구나. `member`가 받는 에이전트 목록은 이것뿐이다 |
| 에이전트 상세(카드·버전·릴리스) | `routes/agents.ts:51` | 에이전트에 `agent.manage`(`agent-service.ts:301-306`) | 관리자, 에이전트 관리자 |
| 에이전트 만들기 | `routes/agents.ts:43` | 워크스페이스에 `agent.create`(`agent-service.ts:313`) | `owner`·`admin`·`member`. 만든 사람이 개인 관리자가 된다(`packages/db/src/agents.ts:422-428`). 만드는 경로는 이것 하나다(`agents.ts:401`) |
| 이름·카드 고치기, 릴리스 만들기·켜기 | `routes/agents.ts:59`, `:68`, `:77` | `agent.manage`(`agent-service.ts:341`, `:372`, `:488`) | 관리자, 에이전트 관리자 |
| 관리자 목록·추가·삭제(사람·팀) | `routes/teams.ts:105`, `:113`, `:131` | `agent.admin.manage`(`packages/platform/src/musterrolle/agent-admin-service.ts:67-71`, `:80`) | 관리자, 에이전트 관리자. 관리자 팀은 보관되지 않은 어느 팀이든 추가한다(`agent-admins.ts:208-231`). 마지막 관리자를 지우는 것도 막지 않는다 |
| 자격 증명 연결 목록·연결·해제 | `apps/control-host/src/api/routes/credential-bindings.ts:22`, `:34`, `:50` | 목록까지 `credential.bind`(`packages/platform/src/musterrolle/credential-binding-service.ts:51-66`) | 관리자, 에이전트 관리자 |
| 에이전트 key 발급·폐기 | `apps/control-host/src/api/routes/api-keys.ts:22`, `:39` | 에이전트에 `api_key.manage`(`packages/platform/src/musterrolle/api-key-service.ts:79-89`) | 관리자, 에이전트 관리자 |
| GitHub 설정·저장소·활동 | `apps/control-host/src/api/routes/agent-github.ts:21`, `:30`, `:45` | `agent.manage`(`packages/platform/src/agents/agent-github-service.ts:157-161`) | 관리자, 에이전트 관리자 |
| Slack 연결·앱·채널 | `apps/control-host/src/api/routes/slack-bindings.ts:23`, `:31` 외 | `binding.manage`(`packages/platform/src/musterrolle/surface-binding-service.ts:100-104`) | 관리자, 에이전트 관리자 |
| 에이전트 사용량·성과 | `apps/control-host/src/api/routes/usage.ts:39` 외 | `usage.agent_read`(`packages/platform/src/usage/usage-service.ts:164-179`) | 관리자, 에이전트 관리자 |
| 보관·복원 | 없음 | `agent.restore`(`policy.ts:284`)는 정의만 있고 부르는 곳이 없다 | — |
| **에이전트로 세션 시작(웹·API)** | `apps/control-host/src/api/routes/sessions.ts:42` | `session.submit`, 리소스 `{session, id: null, agent_id, release_id}`(`session-service.ts:623-646`) | `sessions:write`를 가진 누구나. **그 에이전트와의 관계는 보지 않는다.** 에이전트 key는 자기 에이전트만(`policy.ts:609-616`). 자격 증명이 연결되지 않았으면 거절(`policy.ts:682-686`) |
| **Slack으로 세션 시작** | `packages/platform/src/musterrolle/slack-session-handler.ts:249-279` | `session.submit`, surface binding과 활성 릴리스 | 살아 있는 구성원과 연결된 Slack 사용자. 게스트는 설정이 켜졌을 때만, 외부 사용자는 안 된다(`policy.ts:529-537`). 앱이 그 에이전트의 것이어야 한다(`policy.ts:643-647`). 사람과 에이전트의 관계는 보지 않는다 |

- 에이전트를 읽는 action이 따로 없다. 읽기도 쓰기 action(`agent.manage`·`credential.bind`·`binding.manage`)으로 판정하므로, 에이전트를 보는 사람은 관리자와 에이전트 관리자뿐이다(에이전트 key의 자기 행 읽기는 예외). 같은 판정 함수를 읽기와 쓰기가 같이 쓴다. 예를 들어 Slack 앱 조회(`packages/platform/src/musterrolle/slack-app-service.ts:320`)와 채널 조회(`packages/platform/src/musterrolle/slack-channel-search.ts:338`)가 그렇다.
- 에이전트를 대상으로 한 receipt도 세션 밖 읽기 경로다. receipt에 `session_id`가 없으면 `session.read`(`id: null`)만 본다(`session-service.ts:1461-1468`). 자격 증명 연결 receipt는 에이전트를 대상으로 하고 `credential_ref`를 싣는다(`packages/db/src/credential-bindings.ts:179-184`). 그래서 id를 아는 `member`면 설정의 일부를 읽는다.

### 세션 action

| action | 라우트 | 판정 | 지금 할 수 있는 사람 |
|---|---|---|---|
| 목록·개수 | `routes/sessions.ts:54`, `:63` | `session.read`, `id: null`(`session-service.ts:1336-1339`, `:1368`). SQL이 공유 범위로 거른다(`packages/db/src/postgres-unit-of-work.ts:950-971`, `:958`) | 볼 수 있는 세션만. `relation`·`agent_id`·`q`는 좁히기만 한다 |
| 상세·turn·SSE·결과물·사용량·pending·receipt | `routes/sessions.ts:71`, `:176`; `routes/events.ts:112`; `routes/outputs.ts:14` 외 | `session.read`(`session-service.ts:1376`, `:1411`, `:1443`) | 볼 수 있는 사람. SSE는 페이지를 읽을 때마다 다시 판정하고, 404면 `not_visible`로 끊는다(`apps/control-host/src/api/routes/events.ts:338-344`). 결과물은 `artifact.read`가 아니라 `session.read`로 판정한다(`packages/platform/src/sessions/output-service.ts:26-28`) |
| 메시지 보내기 | `routes/sessions.ts:88` | `session.submit`(`session-service.ts:825-828`) | 볼 수 있는 사람 |
| interrupt·pause·close·terminate·resume·profile | `apps/control-host/src/api/routes/interrupt.ts:19`, `pause.ts:19`, `close.ts:19`, `sessions.ts:106`, `:124`, `:142` | `session.control`(`session-service.ts:954`, `:998`, `:907-913`, `:1267`, `:1047`) | 볼 수 있는 사람(`sessions:control`은 `member`도 가진다) |
| 승인·질문 답·push 결정 | `apps/control-host/src/api/routes/pending.ts:28` 외 | `session.approve`, 이어서 `mayAnswer`(`policy.ts:451-497`) | 볼 수 있는 사람 가운데 만든 사람, 관리자, 에이전트 관리자, 그 에이전트의 key. 세션을 시작한 key는 승인하지 못한다(`policy.ts:465-470`) |
| 이름 바꾸기 | `routes/sessions.ts:79` | `session.rename`, `mayAnswer`(`policy.ts:651-662`) | 승인과 같은 사람 |
| 공유 범위 바꾸기 | `apps/control-host/src/api/routes/session-shares.ts:39` | `session.share`, `mayShare`(`policy.ts:425-445`) | 사람이 만든 세션은 만든 사람만. key가 만든 세션은 관리자와 에이전트 관리자 |
| 감사 열람·관리자 목록·관리자 종료 | `routes/session-shares.ts:48`, `:57`, `:62` | `session.audit_read`·`session.admin_list`(`policy.ts:288-289`), 공유 밖은 사유가 있을 때만(`policy.ts:566-576`) | 관리자. 관리자 목록은 메타데이터만 준다 |
| 복구 결정 | `routes/sessions.ts:158` | `session.recover` | `owner`만 |

- 공유 범위 판정은 `sessionVisibleTo`(`packages/db/src/session-shares.ts:95-101`)다. 공유 행이 없거나 범위가 `workspace`면 누구나(`:97`), 아니면 만든 사람, 이름으로 지정된 사람, 지정된 팀의 지금 구성원이 본다. 팀은 보관되지 않았고 구성원 행이 지워지지 않은 것만 센다. 잠금 아래에서 다시 보는 구현이 따로 있다(`lockSessionReach`, `packages/db/src/requester-locks.ts:167`). 공유 규칙을 바꾸면 두 곳을 같이 고친다.
- 공유 범위 바깥이면 관리자도 보통 화면에서는 404다. 볼 수 있는 길은 사유를 남기는 감사 열람뿐이다(`policy.ts:566-576`). 에이전트 관리자에게는 공유 밖 세션을 보는 길이 없다. 운영자 문서에도 그렇게 적혀 있다(`docs/operator/api-server.md:629`).
- 세션을 만들 때 공유 행을 쓰는 것은 `shareScope`가 있을 때뿐이다(`postgres-unit-of-work.ts:310-320`). 웹·API 라우트는 이 값을 넘기지 않는다(`routes/sessions.ts:42-50`). 그래서 웹·API 세션은 공유 행 없이 `workspace`로 시작한다. 이 값을 넘기는 곳은 Slack DM의 `private`(`slack-session-handler.ts:415`)뿐이다.
- 에이전트별 사용량은 공유와 상관없이 그 에이전트의 모든 세션을 합한 수치다(`packages/db/src/usage-reader.ts:101-105`). 최근 성과 항목은 볼 수 없는 세션의 `session_id`만 가린다(`usage-reader.ts:524`). 같은 행의 세션 제목(`:525`)과 성과 제목·링크(`:526`)는 그대로 돌려주고, 서비스도 그대로 싣는다(`packages/platform/src/usage/usage-service.ts:433-438`). 에이전트 관리자는 공유 밖 세션의 제목을 여기서 본다.
- Slack 채널 세션의 답은 채널 스레드에 올라간다. 보내기 전에 보는 것은 링크가 살아 있는지, 설치가 폐기되지 않았는지 정도다(`packages/db/src/slack-outbox.ts:100-112`). 받는 사람은 정하지 않는다(`packages/platform/src/musterrolle/slack-outbox.ts:270-272`). 채널에 있는 사람은 공유 범위와 상관없이 답을 읽는다.
- 세션을 만드는 쓰기 안의 재확인(`packages/db/src/postgres-unit-of-work.ts:248-252`의 `lockRequester`)은 요청자와 key의 에이전트 범위만 다시 본다. 승인 쓰기 안의 재확인(`lockSessionReach`, `packages/db/src/requester-locks.ts:215-337`, 호출 `packages/db/src/pending-requests.ts:670`)은 개인 관리자와 관리자 팀을 따로 구현한다. `administers()`를 부르지 않는다.

### 정리하면

- 에이전트는 관리자와 에이전트 관리자만 볼 수 있다. 그런데 실행에는 제한이 없어서, 에이전트를 볼 수 없는 `member`도 릴리스 id만 알면 그 에이전트로 세션을 시작한다.
- 세션을 볼 수 있는지는 세션마다 정하는 공유 범위 하나로 정한다. 그 세션이 어느 에이전트의 것인지는 판정에 들어가지 않는다.
- "담당 팀 안인지 밖인지"를 판정에 쓰는 곳이 아무 데도 없다.

## (b) RBAC 표

### 주체

| 주체 | 정의(판정 시점마다 다시 읽는다) |
|---|---|
| W. 워크스페이스 관리자 | 역할이 `owner`·`admin`인 사람 |
| L. 에이전트 관리자 | `administers()`가 참인 사람. 지금의 두 경로(개인 관리자, 관리자 팀 구성원)에 **담당 팀의 `lead`** 경로를 더한다 |
| T. 담당 팀 구성원 | 담당 팀(보관되지 않음)의 살아 있는 구성원 가운데 L이 아닌 사람. 팀 역할은 `member` |
| O. 바깥쪽 | 위 셋이 아닌 워크스페이스 `member` |

- W·L·T를 그 에이전트의 **안쪽**이라 한다. 판정 함수 하나(`insideAgent`)로 정의하고, 정책과 목록 SQL이 이 함수를 같이 쓴다.
- 담당 팀이 비어 있는 에이전트(이행 중)에는 T가 없다. 안쪽은 W·L뿐이다.
- 개인 key는 만든 사람으로, 그 사람의 지금 역할과 팀으로 판정한다(지금과 같다, `policy.ts:338-354`). 에이전트 key는 멤버가 아니다. 자기 에이전트의 안쪽으로 본다. 그러려면 열람 판정이 key의 에이전트를 알아야 하는데, 지금 `SessionViewer`에는 `userId`·`apiKeyId`뿐이다(`packages/platform/src/ports/session-share-store.ts:12`). 정책이 다시 읽은 key의 에이전트(`keyAgentId`)를 `SessionViewer`에 더하고, 목록 SQL과 잠금 재확인도 같은 값을 쓴다. 자기 에이전트 밖으로 나갈 수 없다는 상한(`policy.ts:609-616`)과 에이전트 key의 다른 권한은 그대로다.

### 대상과 액션의 기본값

✓ 할 수 있음, ✗ 못 함. "축 A"·"축 B"는 [(c)](#c-워크스페이스-설정-축)의 설정이다. 표의 값은 그 기본값(`use`, `managing_team`)일 때다.

| 대상 | 액션 | W | L | T | O |
|---|---|---|---|---|---|
| 에이전트 정보(이름·slug·설명·담당 팀·상태·활성 릴리스 id) | 목록에서 찾기, 열람 | ✓ | ✓ | ✓ | ✓ (축 A가 `none`이면 ✗, 404) |
| 에이전트 설정(카드·버전·릴리스·관리자 목록·자격 증명 연결 목록·GitHub·Slack 설정) | 열람 | ✓ | ✓ | ✓ | ✗ |
| 에이전트 설정 | 수정(카드·릴리스·GitHub·Slack·자격 증명) | ✓ | ✓ | ✗ | ✗ |
| 에이전트 관리자·담당 팀 | 수정 | ✓ | ✓ (아래 제한) | ✗ | ✗ |
| 에이전트 key | 발급·폐기 | ✓ | ✓ | ✗ | ✗ |
| 에이전트 사용량·성과 | 열람·성과 검토 | ✓ | ✓ | ✗ | ✗ |
| 에이전트 실행 | 세션 시작(웹·API·Slack) | ✓ | ✓ | ✓ | ✓ (축 A가 `use`일 때만) |
| 세션 목록 | 조회 | 볼 수 있는 세션 | 볼 수 있는 세션 | 볼 수 있는 세션 | 자기 세션과 이름·팀으로 공유받은 세션 |
| 세션 상세·로그·결과물 | 열람 | 공유 범위대로 | 공유 범위대로 | 공유 범위대로 | 자기 세션과 이름·팀으로 공유받은 세션(축 B) |
| 세션 | 메시지 보내기, interrupt·close 등 제어 | 볼 수 있으면 | 볼 수 있으면 | 볼 수 있으면 | 볼 수 있으면 |
| 세션 | 승인·이름 바꾸기 | ✓ (볼 수 있으면) | ✓ (볼 수 있으면) | 자기 세션만 | 자기 세션만 |
| 세션 | 공유 범위 바꾸기 | 지금처럼 | 지금처럼 | 지금처럼 | 지금처럼 |
| 세션 | 공유 밖 감사 열람·관리자 목록·관리자 종료 | ✓ (사유) | ✗ | ✗ | ✗ |

- **L과 T의 차이**: 둘 다 에이전트 정보와 설정을 보고, 에이전트를 쓰고, 안쪽 세션을 본다. 바꾸는 권한(설정·관리자·key)과 남의 세션에 답하는 권한(승인·이름 바꾸기)은 L만 있다. 앞선 설계(T는 관리 권한 없음)와 같고, 설정 열람과 세션 열람을 T에게 준다는 점이 새로 정해진 것이다.
- **O가 세션을 보는 범위**: 축 B가 `managing_team`이면 공유 범위가 `workspace`인 세션(공유 행이 없는 것 포함)이 O에게 닿지 않는다. 만든 사람이 일부러 고르는 `people`·`team` 범위는 지금처럼 O에게도 닿는다. 이 둘은 남에게 보이려고 고르는 것이고 receipt도 남는다(`docs/operator/api-server.md:631`). 오너가 말한 "자기가 실행한 것만"과는 이 예외만큼 다르다. 이 예외도 막을지는 [(g) G6](#g-오너-확인-필요)에 올렸다.
- **Slack 채널**: 에이전트를 채널에 연결하는 것(`binding.manage`, L·W)은 그 채널 사람들에게 답을 보이겠다는 명시적 결정으로 본다. 채널 세션의 답은 축 B와 상관없이 지금처럼 스레드에 올라간다. 바깥쪽이 채널에서 세션을 **시작**하는 것은 축 A를 따른다. 축 A가 `use`가 아니면 거절하고, 지금 거절과 같은 안내를 보낸다. 채널 연결 화면은 "이 채널의 모든 사람이 답을 읽습니다. 담당 팀 밖 사람도 포함됩니다"를 보인다. 채널에서도 답을 줄일지는 [(g) G10](#g-오너-확인-필요)에 올렸다. DM 세션은 지금처럼 `private`다.
- **세션 목록의 메타데이터**: 목록은 상세와 같은 기준으로 거른다. 제목만 따로 보이는 등급은 두지 않는다. 제목에도 내용이 들어가기 때문이다. 관리자가 메타데이터만 보는 관리자 목록은 지금처럼 둔다.
- **세션 제어**: 볼 수 있는 사람이 남의 세션에 메시지를 보내는 것은 그대로 둔다. Slack 채널 스레드에서 여러 사람이 한 세션에 말을 거는 것이 이 경로다(`SLACK_SURFACE_ACTION_VALUES`, `packages/contracts/src/kollegium/surfaces.ts:98-103`). interrupt·close 같은 제어를 만든 사람과 L만으로 좁힐지는 [(g) G7](#g-오너-확인-필요)에 올렸다. 기본값은 지금 그대로다.
- **L의 제한**
  - W가 아닌 L은 담당 팀을 **자기가 속한 팀**(`lead`·`member`)으로만 바꾼다. 비우는 것(null)은 누구도 못 한다([(d)](#d-담당-팀-필수)).
  - 관리자 팀(`agent_admin_teams`)을 새로 추가하는 것은 W(`team.manage`)만 한다(94S-837이 "자기가 `lead`인 팀" 예외를 걷었다). 관리자 팀은 구성원 모두에게 관리 권한을 주므로 담당 팀보다 좁게 막는다. 팀을 떼는 것은 에이전트 관리자도 한다. 이미 있는 행은 그대로 둔다.
- **바꾸지 않는 것**: 공유 범위 바꾸기(`mayShare`), 승인 판정(`mayAnswer`)의 구조, W의 감사 열람, `owner`만 하는 복구는 그대로 둔다. L이 늘어나는 것은 `administers()`에 담당 팀 `lead` 경로가 더해지기 때문이다. 정책의 `mayAnswer`·`mayShare`는 `isAdmin`을 거치므로 코드가 바뀌지 않는다. 하지만 승인 쓰기 안의 재확인(`requester-locks.ts:215-337`)은 관리자 경로를 따로 구현하므로, 같은 단위(R1)에서 담당 팀 `lead` 경로를 더한다. 그러지 않으면 담당 팀 `lead`가 정책은 지나고 승인 쓰기에서 거절된다.
- **receipt 읽기**: 에이전트를 대상으로 한 receipt는 `agent.settings_read`로, 세션 receipt는 지금처럼 `session.read`로 판정한다. 대상이 없는 receipt는 지금처럼 둔다.
- **사용량의 최근 항목**: 볼 수 없는 세션의 행은 `session_id`만 가리지 않고 행을 통째로 뺀다. 합계 수치는 지금처럼 모든 세션을 센다(L·W만 보는 수치다).

### 판정 구현

| 대상 | 바뀌는 것 |
|---|---|
| action | 읽기 action 둘을 새로 둔다. `agent.read`(에이전트 정보)와 `agent.settings_read`(설정 열람)이다. 지금 쓰기 action으로 판정하는 읽기를 이 둘로 옮긴다. 상세는 `agent-service.ts:301-306`, 자격 증명 연결 목록은 `credential-binding-service.ts:69-80`, GitHub 조회는 `agent-github-service.ts:164`, Slack 연결 목록은 `surface-binding-service.ts:167-178`, 관리자 목록은 `agent-admin-service.ts:116-124`다. 계약의 action 목록(`packages/contracts/src/musterrolle/authorization.ts:316-373`)과 리소스 표(`:387-424`)에 더한다 |
| `agent.read` | W는 통과. 그 밖에는 안쪽이거나 축 A가 `none`이 아니면 통과. 목록(`GET /v1/agents`)·개수(`/v1/agents/counts`)는 워크스페이스 단위 판정을 그만두고 행마다 같은 조건으로 거른다(SQL). 목록 항목은 지금처럼 에이전트 행(`agent`)이다. `include=summary`의 요약(관리자·자격 증명 연결을 싣는다)은 `agent.settings_read`가 되는 행에만 붙이고, 나머지 행은 요약 없이 준다. 에이전트 key의 자기 행 경로(`agent-service.ts:223-261`)는 그대로다 |
| `agent.settings_read` | W이거나 안쪽. 상세(`GET /v1/agents/{id}`, 응답은 `versions`·`releases`·`active_release`를 요구한다, `packages/contracts/src/kollegium/agents.ts:422-429`)는 이 action으로 판정한다. O는 상세 대신 목록의 `ids` 필터로 에이전트 행을 읽는다. 별도 정보 상세 엔드포인트는 만들지 않는다 |
| 읽기·쓰기 분리 | 읽기와 쓰기가 한 판정 함수를 같이 쓰는 서비스는 함수를 둘로 나눈다. 자격 증명 연결(`credential-binding-service.ts:51-66`), Slack 연결·앱·채널·identity(`surface-binding-service.ts:100-104`, `slack-app-service.ts:320`, `slack-channel-search.ts:338`, `packages/platform/src/musterrolle/agent-identity-service.ts:57-61`), GitHub(`agent-github-service.ts:157-161`, `packages/platform/src/musterrolle/github-repository-service.ts:213-217`)가 대상이다. T에게 읽기를 열면서 쓰기가 같이 열리지 않게 하려는 것이다 |
| `session.submit`(세션 시작) | 리소스에 `agent_id`가 있는 시작 판정에 축 A를 더한다. 바깥쪽이고 축 A가 `use`가 아니면 거절(`role`). 웹·API(`session-service.ts:623-646`)와 Slack(`slack-session-handler.ts:265-275`)이 같은 정책을 거치므로 한 곳(`policy.ts`의 `release_id` 분기 앞)에서 판정한다. 세션을 만드는 쓰기(`postgres-unit-of-work.ts:248-252`)도 같은 트랜잭션에서 축 A를 다시 본다. 이때 워크스페이스 행(설정)을 `FOR SHARE`로, 에이전트 행(담당 팀)과 판정 근거인 팀·구성원 행을 함께 잠근다. 설정 쓰기는 같은 워크스페이스 행을 UPDATE하므로(`workspace-settings.ts:47-53`) 둘이 엇갈리지 않는다. 잠그는 순서는 워크스페이스 → 에이전트 → 팀 → 구성원으로 정한다. 이미 있는 세션에 메시지를 보내는 것은 축 A를 보지 않는다 |
| 세션 열람 | `sessionVisibleTo`의 `workspace` 갈래(`session-shares.ts:97`)에 조건을 더한다. 세션의 에이전트에 담당 팀이 없거나, 축 B가 `workspace`이거나, 보는 사람이 안쪽이어야 한다. 에이전트 key는 `keyAgentId`가 세션의 에이전트와 같으면 안쪽이다. 잠금 쪽 재확인(`requester-locks.ts:167`)과 사용량 최근 항목(`usage-reader.ts:517-531`)도 같은 조건을 쓴다. 목록·개수·상세·SSE가 모두 이 판정을 지나므로 같이 바뀐다 |
| 안쪽 판정 | `insideAgent(db, workspaceId, userId, agentId)`를 SQL 하나로 만든다. W이거나 `administers()`이거나, 담당 팀이 보관되지 않았고 그 팀의 살아 있는 구성원이면 참이다. 팀 구성원은 판정 때마다 읽는다(`administers.ts:21-26`와 같은 원칙) |
| SSE | 설정이나 팀 구성원이 바뀌어도 바로 알리지 않는다. 다음 페이지를 읽을 때 다시 판정해 끊는다(`events.ts:338-344`). 지금 팀에서 빠질 때와 같다 |

## (c) 워크스페이스 설정 축

`workspaces.settings` jsonb에 키 둘을 더한다. 키가 없으면 기본값이다. Slack 게스트 설정과 같은 모양이다(`workspace-settings.ts:14-24`). 바꾸는 사람은 `workspace.manage`(W)이고, 바꿀 때 receipt를 남긴다.

| 축 | 키 | 값 | 기본값 | 적용 범위 |
|---|---|---|---|---|
| A. 바깥쪽의 에이전트 접근 | `agent_outsider_access` | `use`: 정보를 보고 실행한다 / `view`: 정보만 본다 / `none`: 목록에도 없고 실행도 못 한다 | `use` | 모든 에이전트. 담당 팀이 비어 있는 에이전트도 포함한다 |
| B. `workspace` 공개 세션이 바깥쪽에 보이는가 | `agent_outsider_session_visibility` | `managing_team`: 안쪽에만 보인다 / `workspace`: 모두에게 보인다(지금과 같다) | `managing_team` | 담당 팀이 있는 에이전트의 세션만 |

- 축 A 기본값 `use`: 오너 원문의 "자기가 실행할 수 있는 거지"를 따랐다. 지금도 바깥쪽은 실행할 수 있으므로 실행 쪽은 달라지는 것이 없다. 정보 열람은 지금 막혀 있던 것이 열린다.
- 축 B 기본값 `managing_team`: 오너 원문의 "세션의 상세 내용을 모두 못 보고"와 잠정 결정 d124(담당 팀 쪽)를 따랐다. 담당 팀이 없는 에이전트에는 적용하지 않으므로, 배포 직후에는 아무 세션의 공개 범위도 바뀌지 않는다. 에이전트에 담당 팀을 정하는 순간부터 그 에이전트의 `workspace` 공개 세션(이전 세션 포함)이 바깥쪽에서 사라진다. 담당 팀을 정하는 화면에서 이 결과를 알린다: "담당 팀을 정하면 팀 밖 사람은 이 에이전트의 세션 가운데 자기 세션과 공유받은 것만 봅니다(워크스페이스 설정)". 여기서 "자기 세션"은 지금 그 세션을 가진 사람(`created_by_user_id`, 열람 판정 `ownedBy`, `packages/db/src/session-shares.ts:43-46`)이다. 처음 시작한 사람(`startedBy`, `:71-74`)과는 인수 뒤 달라질 수 있다(`docs/operator/api-server.md:629`). 열람 판정은 지금처럼 가진 사람 기준이고, 이 설계는 그것을 바꾸지 않는다.
- 축 B는 판정 시점의 상한이다. 설정을 바꾸면 기존 세션에도 다음 요청부터 적용되고, 되돌리면 그대로 돌아온다. 공유 행은 하나도 쓰지 않는다.
- 축 B는 `workspace` 범위의 뜻을 바꾼다. 지금 계약은 "`workspace` = 멤버 모두"다(`docs/operator/api-server.md:617`). 이 계약을 직접 검증하는 시험도 있다(`packages/db/src/session-shares.integration.test.ts:154`). 저장된 범위(만든 사람이 고른 것)와 실제로 보는 사람이 달라지므로 다음을 같이 바꾼다.
  - 공유 조회 응답(`GET /v1/sessions/{id}/share`)에 `audience_limited: boolean`을 더한다. 축 B 때문에 `workspace`가 바깥쪽에 닿지 않으면 참이다. 공유 화면은 이때 `workspace`를 "워크스페이스(담당 팀 밖 사람은 보지 못함, 워크스페이스 설정)"로 보인다. 그래서 `people` → `workspace`로 바꾸면 보는 사람이 줄 수 있다는 것이 화면에 보인다.
  - 운영자 문서의 범위 표를 "`workspace`: 멤버 모두. 단 담당 팀이 있는 에이전트이고 축 B가 `managing_team`이면 안쪽만"으로 고친다.
  - 위 시험은 담당 팀 없는 에이전트의 세션으로 그대로 남긴다. 새 시험을 더한다. 담당 팀 지정·변경, 축 B 전환, 팀 구성원 빠짐이 기존 세션의 열람자를 바로 바꾸는지 본다. 담당 팀이 빈 에이전트(API로는 비울 수 없으므로 이행 전 상태를 fixture로 만든다)는 축 B가 적용되지 않는지 본다.
- 에이전트마다 따로 덮어쓰는 설정은 두지 않는다([(g) G5](#g-오너-확인-필요)).
- 화면: 워크스페이스 설정(`apps/web/src/routes/workspace-settings.tsx`)에 '에이전트 접근' 묶음을 두고, 두 축을 라디오로 보인다.

## (d) 담당 팀 필수

### 데이터 모델

| 대상 | 바뀌는 것 |
|---|---|
| `member_team_members` | `role text NOT NULL DEFAULT 'member' CHECK (role IN ('lead','member'))` |
| `agents` | `managing_team_id uuid NULL`, FK `(workspace_id, managing_team_id)` → `member_teams(workspace_id, id)` |
| 감사 | `set_agent_managing_team`, `set_team_member_role`, `set_agent_access_settings` receipt |

- 열은 nullable로 둔다. "필수"는 API·화면에서 강제한다. 기존 에이전트를 채울 값이 정해지지 않았고, 롤백한 옛 이미지가 만드는 에이전트도 넣을 수 있어야 하기 때문이다. 담당 팀이 비어 있는 에이전트가 0개가 된 뒤에 `CHECK (managing_team_id IS NOT NULL) NOT VALID`를 걸지는 그때 정한다. 걸려면 롤백 하한이 그 이미지 이상이어야 한다.

### 생성 API와 마법사

- `POST /v1/agents`에 `managing_team_id`를 더한다. 생성 요청 계약은 strict라(`packages/contracts/src/kollegium/agents.ts:537-543`) 옛 서버는 이 필드를 거절한다. 그래서 세 단계로 켠다.
  1. (R1) 서버가 선택값으로 받는다. 응답의 에이전트·팀에도 새 필드(`managing_team_id`, `role`)가 생긴다. 응답 계약도 strict다(`agents.ts:422-429`, `packages/contracts/src/musterrolle/teams.ts:50`). 그래서 R1 PR은 생성 클라이언트(`packages/client`)가 응답을 strict로 검증하는지 확인하고, 그렇다면 그 클라이언트를 먼저 내보낸다.
  2. (R4) R1 이미지가 모든 API 복제본에 나가 롤백 하한이 된 뒤 화면이 보내기 시작한다. 오래 열린 옛 화면은 필드 없이 보내고, 1단계라 받아들여진다.
  3. (R5) R4 화면이 배포된 뒤 필수로 바꾼다. 없으면 400이다. API를 직접 부르는 사용자(SDK)에게는 깨지는 변경이다. 사용자 문서와 변경 기록에 강제 시점을 먼저 적고, 그 시점이 지난 배포에서 켠다.
- 지정 자격: W는 보관되지 않은 아무 팀이나 고른다. W가 아니면 **자기가 속한 팀**(`lead`·`member`)만 고른다. 다른 팀을 고르면 403 `team_not_allowed`다. 자격은 쓰는 트랜잭션 안에서 팀 행과 구성원 행을 잠근 채 다시 본다.
- 만든 사람은 지금처럼 개인 관리자가 된다(`agents.ts:422-428`). 그래서 `member`인 담당 팀 구성원이 에이전트를 만들어도 자기 에이전트를 관리한다. 그 팀의 `lead`도 관리자가 된다.
- 속한 팀이 없는 `member`는 에이전트를 만들 수 없다. 담당 팀이 필수라서 생기는 결과다. 마법사는 첫 단계에서 "속한 팀이 없어 에이전트를 만들 수 없습니다. 워크스페이스 관리자에게 팀에 넣어 달라고 요청하세요."를 보이고 진행하지 않는다. 이를 받아들일지는 [(g) G3](#g-오너-확인-필요)에 올렸다.
- 마법사가 쓸 팀 목록: W는 `GET /v1/teams`, 그 밖에는 `GET /v1/my-teams`(`packages/platform/src/musterrolle/team-service.ts:137`)를 쓴다. `my-teams` 응답에 팀마다 호출자의 `role`을 더한다. 마법사 1단계의 '담당 팀'은 필수 칸이다.

### 생성 뒤 변경

- `PUT /v1/agents/{id}/managing-team` `{team_id: string}`. action은 `agent.admin.manage`다. 지정 자격은 생성 때와 같다(W가 아니면 자기가 속한 팀). null은 받지 않는다. 담당 팀이 비어 있는 기존 에이전트를 채우는 것도 이 API다.
- 담당 팀을 바꾸면 옛 팀의 `lead`는 다음 요청부터 관리 권한을 잃고, 옛 팀 구성원은 안쪽에서 빠진다. 공유 행은 쓰지 않으므로 세션은 새 팀 기준으로 바로 다시 판정된다(앞선 설계의 "이미 만든 세션의 공유는 바꾸지 않는다"는 필요 없어진다).
- 상세 '관리자' 탭 맨 위에 '담당 팀' 묶음을 둔다. 내용은 팀 이름, 바꾸기, "이 팀의 팀 관리자는 이 에이전트를 관리하고, 구성원은 설정을 보고 사용합니다"다.

### 팀 보관·구성원 변경

- **보관**: 팀을 보관하는 쓰기(`packages/db/src/member-teams.ts:299-331`)는 지금 관리자 팀 행을 지우고 팀을 보관한다. 보관되지 않은 에이전트 가운데 그 팀이 담당 팀인 것이 있으면 409 `team_manages_agents`로 거절하고, 그 에이전트 id를 응답에 싣는다. 먼저 담당 팀을 옮겨야 한다. 담당 팀은 필수인데 비울 길을 만들지 않으려는 것이다. 잠금은 팀 행에 이미 걸리므로(`member-teams.ts:305`), 담당 팀 지정 쓰기도 같은 팀 행을 잠가 둘이 엇갈리지 않게 한다.
- **구성원 빼기·역할 바꾸기**: 막지 않는다. `lead`가 하나도 없는 담당 팀이 될 수 있다. 그 에이전트는 W와 개인 관리자가 관리한다. 관리자 탭은 "이 담당 팀에는 팀 관리자가 없습니다"를 보인다.
- 팀 역할을 정하는 사람은 지금처럼 `team.manage`(W)다. 팀 `lead`가 자기 팀 구성원을 관리하는 권한은 이번에 만들지 않는다.

### 기존 에이전트 이행

담당 팀을 무엇으로 채울지 세 안을 견줬다.

| 안 | 내용 | 판단 |
|---|---|---|
| **1. 비워 두고 지정을 안내한다(추천)** | 마이그레이션은 열만 더한다. 담당 팀이 비어 있는 에이전트는 지금처럼 동작한다(축 B 미적용, T 없음). 에이전트 목록과 관리자 탭에 '담당 팀 미지정' 표시를 두고, W와 L이 지정한다. 목록에 '담당 팀 미지정' 거르기를 둔다 | 권한이 사람 확인 없이 바뀌지 않는다. 되돌릴 것이 없다 |
| 2. 관리자 팀이 정확히 하나면 그 팀으로 채운다 | 일회성 이행 쿼리 | 그 팀의 구성원은 이미 관리자라 권한은 줄지 않는다. 하지만 축 B가 바로 켜져 바깥쪽에게서 세션이 사라진다. 사람이 고른 것이 아니다 |
| 3. 워크스페이스마다 '기본 팀'을 만들어 모든 에이전트에 채운다 | 구성원 전원을 넣은 팀 | 모든 `member`가 모든 에이전트의 안쪽이 된다. 설정 열람이 모두에게 열린다. 담당 팀의 뜻이 사라진다 |

- 1을 고른다. 2는 지정 화면에서 "관리자 팀 ○○을 담당 팀으로" 추천 버튼으로만 쓴다. 누르는 것은 사람이다.
- 되돌리기(데이터): 앱을 롤백해도 두 열은 남긴다. 설정 키도 남긴다. 데이터는 깨지지 않는다.
- 되돌리기(권한): 데이터가 안전하다고 권한이 안전한 것은 아니다. R3 아래로 롤백하면 옛 `sessionVisibleTo`가 `workspace`를 무조건 허용해(`session-shares.ts:97`) 축 B로 숨긴 세션이 바깥쪽에 다시 보이고, 축 A도 사라진다. R1 아래로 롤백하면 옛 팀 보관 쓰기(`member-teams.ts:299-331`)가 담당 팀을 보관하게 둔다. 그래서 R1과 R3는 각각 모든 API·Slack 복제본에 나간 뒤 롤백 하한으로 선언한다. 하한 아래 롤백이 꼭 필요하면 그 전에 오너에게 "숨겼던 세션이 다시 워크스페이스에 보인다"를 알린다. 롤백 뒤 다시 올리면 설정과 열이 남아 있어 같은 상태로 돌아온다. 열이나 키를 지우는 정리는 배포 뒤 지정한 값을 잃는 되돌릴 수 없는 작업이다. 하려면 내보내기·복구 절차와 오너 확인이 먼저다. 지금 계획에는 넣지 않는다.

## (e) 앞선 결정과의 차이

| 앞선 결정 | 내용 | 이 설계 | 이유 |
|---|---|---|---|
| 항목 4 A | `agents.managing_team_id` + `member_team_members.role` | **유지** | 오너 질문("각 팀의 관리자인지 구성원인지의 권한을 따라가는 거지")의 답이 그대로다 |
| 항목 4 담당 팀 선택 | 선택값. 마법사 1단계에서 고를 팀이 없으면 나중에 | **변경**: 새 에이전트는 필수. 기존 에이전트만 비어 있을 수 있다 | 오너 원문 "에이전트는 무조건 담당 팀이 붙는 게 좋을 것 같아" |
| 항목 4 담당 팀 `member` | 관리 권한 없음. 세션 기본값이 담당 팀이면 세션을 본다 | **변경**: 관리 권한은 여전히 없고, 설정 열람·사용·안쪽 세션 열람이 정해졌다 | (b) 표 |
| d124 | 세션 공개 범위 기본값. 담당 팀이 있으면 세션을 만들 때 `team` 공유 행을 넣고, 없으면 `workspace` | **폐기, 축 B로 대체**: 공유 행은 지금처럼 쓰지 않고, 판정 때 `workspace` 범위가 바깥쪽에 닿지 않게 한다. "없으면 workspace" 갈래는 담당 팀이 비어 있는 이행 중 에이전트에만 남는다 | 관리자가 설정을 바꾸면 기존 세션에도 바로 적용된다(오너의 "관리자의 설정에 따라"). 공유 행을 이행하지 않으므로 되돌리기가 설정 하나다. 담당 팀을 바꿀 때 옛 세션이 옛 팀에 묶이는 문제가 없다. `team` 공유 행은 팀이 보관되면 만든 사람만 보게 되는데(`api-server.md:620`), 이 문제도 생기지 않는다 |
| d125 | `member` 관리자는 자기가 `lead`인 팀만 담당 팀·관리자 팀으로 지정 | **둘로 나눔**: 담당 팀은 자기가 속한 팀(`lead`·`member`), 관리자 팀은 지금 결정대로 `lead`인 팀만 | 담당 팀이 필수인데 `lead`인 팀만 허용하면 `lead`가 아닌 `member`는 에이전트를 만들 수 없다. 속한 팀으로 묶으면 관계없는 팀에 권한을 떠넘기는 문제(앞선 설계가 막으려던 것)는 그대로 막힌다. 관리자 팀은 구성원 모두를 관리자로 만들어 더 넓으므로 좁게 둔다 |
| d126 | 카드의 도구 좁힘을 실행에 켠다 | **유지** | RBAC와 관계없다. U2a(JeongJaeSoon/agent-platform#1072)가 이미 바탕을 깔았다 |
| 항목 4 보관된 담당 팀 | 열 값을 남기고 "보관된 팀"으로 보인다 | **변경**: 담당 팀이 맡은 에이전트가 있으면 보관을 거절한다 | 필수인 값이 효력 없는 채로 남지 않게 한다 |
| 항목 4 세션 공개 범위 기본값(오너 확인 필요) | 1 워크스페이스 / 2 담당 팀이 있으면 담당 팀 / 3 항상 담당 팀 | **질문을 바꿈**: 축 B의 기본값([(g) G2](#g-오너-확인-필요)) | 위 d124와 같다 |
| 기존 팀 권한 모델 | 팀에 역할이 없고, 관리자 팀이면 구성원 모두가 관리자 | **유지**(기존 행), 새 추가만 제한 | 기존 권한을 줄이지 않는다. 관리자 팀을 없앨지는 [(g) G8](#g-오너-확인-필요) |
| U5a·U5b·U5c | 팀 역할·담당 팀 계약, 화면, 세션 기본값 | **대체**: [(f)](#f-구현-단위)의 R1~R5 | — |

## (f) 구현 단위

| 단위 | 내용 | 쓰기 경로 | start-after | land-after |
|---|---|---|---|---|
| R1 | 팀 역할과 담당 팀의 데이터·계약·판정. `role` 열, `managing_team_id` 열, `administers()`·`lockedAdministers()`·승인 쓰기 재확인(`requester-locks.ts:215-337`)의 담당 팀 `lead` 경로, `insideAgent`, `PUT /v1/agents/{id}/managing-team`, `POST /v1/agents`의 선택값 `managing_team_id`와 지정 자격, 관리자 팀 새 추가 제한, 팀 보관 거절, 팀 구성원 역할 API, `my-teams`의 `role`, receipt. **에이전트 설정을 바꾸는 DB 쓰기 전부**가 에이전트 행을 잠근 뒤 역할 또는 `lockedAdministers()`를 다시 보게 하고, 담당 팀 변경과 같은 에이전트 행 잠금으로 줄 세운다(담당 팀을 옮기거나 `lead`를 내린 직후의 요청이 쓰기를 끝내지 않게). 지금 구성원인지만 보는 곳은 에이전트 수정·릴리스·켜기(`packages/db/src/agents.ts:442`, `:504`, `:578`)와 GitHub 켜기(`packages/db/src/agent-github.ts:42`)다. GitHub 저장소 고르기 쓰기(`packages/db/src/catalog-repositories.ts:169`)도 구성원인지만 본다. Slack 연결 쓰기는 이미 역할·관리자를 다시 본다(`packages/db/src/surface-bindings.ts:144`의 `callerHoldsRight()`). 여기에는 담당 팀 경로와 잠금 순서만 보강한다. 담당 팀 변경·`lead` 강등과 엇갈리는 시험을 쓰기마다 둔다 | `packages/db/migrations/<다음 번호>`, `packages/db/src/schema.ts`, `packages/db/src/administers.ts`, `packages/db/src/agent-admins.ts`, `packages/db/src/agents.ts`, `packages/db/src/agent-github.ts`, `packages/db/src/surface-bindings.ts`, `packages/db/src/catalog-repositories.ts`, `packages/db/src/member-teams.ts`, `packages/db/src/requester-locks.ts`, `packages/db/src/api-keys.ts`(시험만일 수 있음), `packages/platform/src/ports/agent-store.ts`(`create` 입력), `packages/platform/src/agents/agent-service.ts`, `packages/platform/src/musterrolle/agent-admin-service.ts`, `packages/platform/src/musterrolle/team-service.ts`, `packages/contracts/src/musterrolle/teams.ts`, `packages/contracts/src/kollegium/agents.ts`, `apps/control-host/src/api/routes/teams.ts`·`agents.ts`, `apps/control-host/src/api/openapi.ts`, `packages/client/src/schema.gen.ts`(응답 검증 확인), `docs/openapi.json`, `docs/operator/api-server.md`, 시험 | U4a 착지 | U4a |
| R2 | 에이전트 읽기 action 분리(`agent.read`·`agent.settings_read`), 행마다 거르는 에이전트 목록·개수·요약, 읽기·쓰기 판정 함수 분리, 에이전트 대상 receipt 읽기 판정 | `packages/contracts/src/musterrolle/authorization.ts`, `packages/platform/src/musterrolle/policy.ts`, `packages/db/src/agents.ts`(목록·개수 SQL), `packages/db/src/agent-authority.ts`, `packages/platform/src/agents/agent-service.ts`, `agent-github-service.ts`, `packages/platform/src/musterrolle/credential-binding-service.ts`, `surface-binding-service.ts`, `slack-app-service.ts`, `slack-channel-search.ts`, `agent-identity-service.ts`, `github-repository-service.ts`, `agent-admin-service.ts`, `packages/platform/src/sessions/session-service.ts`(receipt 읽기, `:1461-1468`), `openapi.ts`, `schema.gen.ts`, `docs/openapi.json`, `docs/operator/api-server.md`, 시험 | R1 착지 | R1 |
| R3 | 워크스페이스 설정 두 축. 설정 계약·API, 축 A를 세션 시작 판정과 생성 쓰기 재확인에, 축 B를 `sessionVisibleTo`·`lockSessionReach`·사용량 최근 항목에 넣기, `SessionViewer`의 `keyAgentId`, 공유 조회 응답의 `audience_limited`, 정책 조립(API·Slack)에 설정 읽기 연결, 운영자·사용자 문서 | `packages/db/src/workspace-settings.ts`, `apps/control-host/src/api/routes/workspaces.ts`, 워크스페이스 설정 계약(`packages/contracts/src/musterrolle/`), `packages/contracts/src/musterrolle/session-shares.ts`, `packages/platform/src/musterrolle/session-share-service.ts`(`shareView`·`getShare`, `:23`, `:44-51`, `audience_limited`), `packages/platform/src/musterrolle/policy.ts`, `packages/platform/src/ports/session-share-store.ts`, `packages/platform/src/sessions/session-service.ts`(서비스 쪽 viewer 생성, `:80`), `packages/db/src/session-shares.ts`, `packages/db/src/requester-locks.ts`, `packages/db/src/postgres-unit-of-work.ts`, `packages/db/src/usage-reader.ts`, `apps/control-host/src/api/server.ts`, `apps/control-host/src/slack/main.ts`, `openapi.ts`, `schema.gen.ts`, `docs/openapi.json`, `docs/operator/api-server.md`(`:610-631`), `apps/docs/content/docs/sessions/start*.mdx`(`:71`), 시험(`packages/db/src/session-shares.integration.test.ts` 포함) | R1 착지 | R2 |
| R4 | 화면. 마법사 1단계 '담당 팀'(필수), 관리자 탭의 '담당 팀', 팀 화면의 구성원 역할, `member`용 에이전트 목록(정보만), T가 보는 읽기 전용 설정 화면, 워크스페이스 설정의 두 축, '담당 팀 미지정' 표시와 거르기, 공유 화면의 `audience_limited` 문구, Slack 채널 연결 화면의 공개 안내, 바뀐 문구의 사용자 문서 | `apps/web/src/components/new-agent-flow.tsx`, 세션 공유 화면과 Slack 연결 화면 컴포넌트(`apps/web/src`), `apps/web/src/components/agent-admins.tsx`, `apps/web/src/routes/teams.tsx`, `apps/web/src/routes/agents.tsx`, `apps/web/src/routes/agent-detail*.tsx`, `apps/web/src/routes/workspace-settings.tsx`, `apps/web/src/i18n/agents.ts`·`teams.ts`와 설정 문구, `apps/storybook/src/screens/*`, `apps/docs/content/docs/agents/*` | R1(마법사·관리자 탭·팀 화면), R2(목록·읽기 전용 설정), R3(설정 화면) 착지 | U4c, R3 |
| R5 | 담당 팀 필수 켜기. `POST /v1/agents`에서 `managing_team_id`가 없으면 400, 사용자 문서와 변경 기록 | `packages/contracts/src/kollegium/agents.ts`, `packages/platform/src/agents/agent-service.ts`, `openapi.ts`, `schema.gen.ts`, `docs/openapi.json`, `apps/docs/content/docs/agents/*`, 시험 | R4 배포 | R4 |

- 앞선 단위와의 관계: R1은 U5a를, R4는 U5b를 대체한다. U5c(세션 공유 행 기본값)는 없애고 R3로 대체한다. R2와 R5는 새로 생긴 단위다.
- 진행 중인 단위와 겹치는 경로
  - **U4a(`agents.description`, JeongJaeSoon/agent-platform#1074, 이 문서의 기준 커밋 뒤에 착지함)**: `packages/contracts/src/kollegium/agents.ts`, `packages/db/src/schema.ts`, 마이그레이션 번호, `packages/db/src/agents.ts`, `packages/platform/src/agents/agent-service.ts`, `packages/platform/src/ports/agent-store.ts`, `openapi.ts`, `schema.gen.ts`, `docs/openapi.json`이 R1·R2·R5와 겹친다. R1은 U4a가 착지한 main에서 시작하고, 위 파일들의 `파일:줄`은 그 main에서 다시 확인한다. U4a의 계약은 바꾸지 않는다. 바깥쪽이 받는 에이전트 행(R2)에 `description`이 들어가는 것은 U4a 계약을 그대로 읽는 것이다.
  - **U2a(JeongJaeSoon/agent-platform#1072, 착지함)**: claim binding·`catalog.ts`·`worker-gateway.ts`는 이 설계와 겹치지 않는다.
  - **U4c·U1·U3**: `new-agent-flow.tsx`, `apps/web/src/i18n/agents.ts`가 R4와 겹친다. R4는 U4c 뒤에 착지한다(앞선 설계의 U5b와 같은 자리).
  - `policy.ts`·`openapi.ts`는 R2·R3가 같이 쓴다. R2 → R3 순서로 착지한다.
- 줄 세우기: 계약·DB 경로는 U4a → R1 → R2 → R3, 화면 경로는 U1 → U3 → U4c → R4, 마지막이 R5다. R2와 R3는 R1이 착지한 뒤 함께 시작할 수 있지만 착지는 R2가 먼저다.
- 배포 하한: R4의 '담당 팀' 보내기는 R1 이미지가 하한이 된 뒤 켠다. R5는 R4 화면이 운영에 나간 뒤 켠다. R1과 R3는 배포 뒤 롤백 하한으로 선언한다. 그 아래로 롤백하면 데이터는 그대로지만 숨긴 세션이 다시 보이고 담당 팀 보관 거절이 사라진다([(d) 되돌리기](#기존-에이전트-이행)).
- 티켓은 R1+R2, R3, R4+R5 셋으로 묶기를 제안한다. U5a·U5b·U5c를 맡은 기존 티켓은 이 묶음으로 다시 쓴다(티켓은 리드가 고친다).
- 고칠 문서: `docs/operator/api-server.md:610-631`(공유 범위 기본값과 바깥쪽 상한, R3), `apps/docs/content/docs/sessions/start.mdx:71`·`start.en.mdx:71`(R3), 에이전트 만들기 사용자 문서(R4·R5). PRD는 이 리포에 없다(`git grep -n -i -w prd`의 결과는 앞선 설계 문서 한 줄뿐이다). PRD의 세션 공개 기본값 문장('워크스페이스')은 리드가 PRD가 있는 곳에서 축 B의 설명으로 바꾼다.

## (g) 오너 확인 필요

각 항목의 기본값으로 머지한다. 오너가 다른 답을 고르면 후속 PR로 고친다.

| # | 질문 | 선택지 | 추천 | 답이 없을 때 |
|---|---|---|---|---|
| G1 | 축 A(바깥쪽의 에이전트 접근) 기본값 | `use` 보고 실행 / `view` 보기만 / `none` 숨김 | `use` | `use` |
| G2 | 축 B(`workspace` 공개 세션이 바깥쪽에 보이는가) 기본값. 앞선 d124를 대신하는 질문이다 | `managing_team` 안쪽에만 / `workspace` 모두 | `managing_team` | `managing_team` |
| G3 | 속한 팀이 없는 `member`의 에이전트 만들기 | 못 만든다(담당 팀 필수의 결과) / 담당 팀 없이 만들게 둔다(그 에이전트는 이행 중과 같다) | 못 만든다 | 못 만든다 |
| G4 | W가 아닌 사람이 담당 팀으로 고를 수 있는 팀(d125를 대신한다) | 자기가 속한 팀 / 자기가 `lead`인 팀만 / 아무 팀 | 자기가 속한 팀 | 자기가 속한 팀 |
| G5 | 설정 축의 단위 | 워크스페이스 하나 / 에이전트마다 덮어쓰기 허용 | 워크스페이스 하나 | 워크스페이스 하나 |
| G6 | 축 B가 `managing_team`일 때, 이름·팀으로 공유받은 남의 세션을 바깥쪽이 보는가 | 본다(만든 사람이 고른 공유) / 못 본다(자기 세션만) | 본다 | 본다 |
| G7 | 볼 수 있는 남의 세션을 interrupt·close·resume하는 사람 | 지금처럼 볼 수 있는 사람 모두 / 만든 사람·L·W만 | 지금처럼 | 지금처럼 |
| G8 | 관리자 팀(`agent_admin_teams`, 구성원 모두가 관리자) | 유지하고 새 추가만 `lead`인 팀으로 제한 / 새 추가를 막고 담당 팀 `lead`로 옮기게 한다 | 유지·제한 | 유지·제한 |
| G9 | 기존 에이전트의 담당 팀 이행 | 비워 두고 지정 안내 / 관리자 팀이 하나면 자동 채움 / 기본 팀 | 비워 두고 안내 | 비워 두고 안내 |
| G10 | 축 B가 `managing_team`인 에이전트의 Slack 채널 답 | 지금처럼 채널 스레드에 전문(채널 연결을 공개 결정으로 본다) / 채널에는 요약과 웹 링크만(채널 상한 `disclosure: summary`를 강제) | 지금처럼 | 지금처럼 |

- 되돌릴 수 없는 이행은 계획에 없다. 열과 설정 키를 지우는 정리를 하게 되면 그때 오너 확인을 받는다.
- 동작 변화(데이터 이행 아님)는 세 가지다. ① R2부터 `member`가 모든 에이전트의 정보를 본다(축 A `use`). ② R3부터 담당 팀이 정해진 에이전트의 `workspace` 공개 세션이 바깥쪽에서 사라진다(축 B `managing_team`). ③ R5부터 담당 팀 없는 `POST /v1/agents`는 400이다.

## 발견

| 발견 | 근거 | 제안 분류 |
|---|---|---|
| `member`는 에이전트를 볼 수 없는데 릴리스 id만 알면 그 에이전트로 세션을 시작한다 | `agent-service.ts:276`, `session-service.ts:623-646` | LATER(R2·R3가 정리한다. 다시 볼 때: R3 착지) |
| 마지막 에이전트 관리자를 지우는 것을 막지 않는다 | `agent-admins.ts:196-206`, `:233-243` | LATER(W는 늘 관리하므로 고아가 되지는 않는다. 다시 볼 때: 담당 팀 `lead`가 없는 에이전트가 생길 때) |
| 에이전트 수정·릴리스·켜기, GitHub 켜기, 저장소 고르기의 쓰기 재확인은 구성원인지만 본다. 역할·관리자인지는 보지 않는다 | `packages/db/src/agents.ts:442`, `:504`, `:578`, `packages/db/src/agent-github.ts:42`, `packages/db/src/catalog-repositories.ts:169` | R1 범위에 넣었다(담당 팀 변경으로 권한을 잃는 경로가 생기므로 미룰 수 없다, Codex 반론 4·R2-1) |
| 에이전트 사용량 최근 성과 항목이 볼 수 없는 세션의 제목과 성과 제목·링크를 돌려준다. `session_id`만 가린다 | `usage-reader.ts:524-526`, `usage-service.ts:433-438` | NOW 후보(지금 운영 중인 누출이다. 이 프로그램이 머지한 것은 아니므로 리드가 분류한다. R3가 고친다) |
| 에이전트를 대상으로 한 receipt(`credential_ref` 포함)를 id를 아는 `member`가 읽는다 | `session-service.ts:1461-1468`, `credential-bindings.ts:179-184` | LATER(id를 알아야 하고 비밀값은 아니다. R2가 고친다. 다시 볼 때: R2 착지) |
| `artifact.read` action은 정의만 있고 쓰는 곳이 없다. 결과물은 `session.read`로 판정한다 | `authorization.ts:371`, `:422`, `output-service.ts:26-28` | DROP(동작은 맞다. 이 설계는 결과물을 세션 상세와 같이 다룬다) |
| 세션 공유 판정이 정책 SQL과 잠금 재확인 두 곳에 따로 있다 | `session-shares.ts:95-101`, `requester-locks.ts:167` | LATER(R3가 두 곳을 같이 고친다. 다시 볼 때: R3 리뷰) |
| PRD가 이 리포에 없다. 세션 공개 기본값이 문서마다 다르다 | `git grep -n -i -w prd` | NOW 아님. 리드가 PRD 위치에서 축 B 설명으로 고친다 |

## (h) Codex 반론

2026-11-02 Codex(로컬 CLI, read-only)에게 첫 판(커밋 `3626464c0`)을 반론하게 했다. (a)의 인용, 우회 경로, 축 B의 타당성, 이행과 롤백, 구현 단위를 보라고 했다. 13건을 받았다. 근거 줄을 코드에서 다시 읽어 모두 확인했고, 모두 반영했다.

| # | 반론 | 처리 |
|---|---|---|
| 1 | Slack 채널 답은 받는 사람을 정하지 않고 스레드에 올라가 축 B를 우회한다 | 반영. 채널 연결을 L·W의 명시적 공개 결정으로 정의하고 연결 화면에 알린다. 채널에서 시작하는 것은 축 A로 막는다. 채널 답을 요약으로 줄일지는 G10 |
| 2 | 에이전트 대상 receipt를 `session.read(id: null)`만으로 읽어 설정이 샌다 | 반영. receipt 대상별로 판정한다(R2). (a)와 발견에 적음 |
| 3 | 축 A를 정책에만 넣으면 생성 쓰기와 설정 변경이 엇갈린다 | 반영. 생성 쓰기에서 잠그고 다시 본다. 잠금 순서를 정하고 `postgres-unit-of-work.ts`를 R3 필수 경로로 |
| 4 | 담당 팀 변경으로 권한을 잃은 뒤에도 진행 중인 수정·릴리스·켜기가 끝난다. LATER로 둘 수 없다 | 반영. R1에 쓰기 재확인과 줄 세우기를 넣음 |
| 5 | 승인 쓰기 재확인(`requester-locks.ts`)이 관리자 경로를 따로 구현해 담당 팀 `lead`가 정책은 지나고 쓰기에서 거절된다 | 반영. R1에서 같이 고친다 |
| 6 | 사용량 최근 항목은 세션 id만 가리고 제목·링크를 그대로 준다. (a)의 서술이 틀렸다 | 반영. (a)를 고치고 행을 통째로 빼게 했다(R3). 지금 있는 누출이라 발견에 NOW 후보로 |
| 7 | 에이전트 key를 안쪽으로 보려면 열람 판정이 key의 에이전트를 알아야 한다 | 반영. `SessionViewer`에 `keyAgentId`(R3) |
| 8 | 축 B는 `workspace = 멤버 모두` 계약과 그 시험을 바꾼다 | 반영. 공유 응답에 `audience_limited`, 화면 문구, 문서와 시험 계획 |
| 9 | 데이터 롤백 안전과 권한 롤백 안전을 섞었다. R3 아래 롤백은 숨긴 세션을 다시 보인다 | 반영. R1·R3를 롤백 하한으로 선언하고, 하한 아래 롤백 전 알림 절차를 적음 |
| 10 | 생성 요청·응답이 strict라 서버·화면·클라이언트가 섞이면 깨진다 | 반영. 세 단계(서버 수용 → 하한 뒤 화면 → 강제 시점 공지 뒤 필수), 클라이언트 응답 검증 확인 |
| 11 | O가 읽을 상세 응답, 개수, 요약의 규칙이 비었다 | 반영. 상세는 `agent.settings_read`, O는 목록 `ids`로 행을 읽고, 개수·요약도 행마다 거른다 |
| 12 | Slack 앱·채널·identity·GitHub 저장소 서비스, 정책 조립 두 곳, `AgentStore.create` 포트가 경로에서 빠졌다. 읽기·쓰기가 한 판정 함수를 쓴다 | 반영. R1·R2·R3 경로에 더하고 읽기·쓰기 분리를 R2에 넣음 |
| 13 | "라우트는 서비스를 부를 뿐", "에이전트 목록은 관리자만"이 일반화가 지나치다 | 반영. 라우트 직접 판정과 에이전트 key 예외를 (a)에 적음 |

기각한 반론은 없다.

PR head `6ad2c0cf7`(JeongJaeSoon/agent-platform#1076)에서 Codex가 고친 판을 다시 리뷰했다. 1차 반론 가운데 12건은 해결됐다고 확인했다. 4번은 같은 문제가 남은 쓰기 경로가 있다고 했다. 인용은 30곳 넘게 대조했고 틀린 것을 찾지 못했다. 새로 받은 4건을 모두 반영했다.

| # | 반론 | 처리 |
|---|---|---|
| R2-1 (BLOCKER) | GitHub 켜기 쓰기(`agent-github.ts:42`)도 구성원인지만 다시 본다(1차 4번의 나머지) | 반영. R1을 "에이전트 설정을 바꾸는 DB 쓰기 전부"로 넓히고, 알려진 경로(`agents.ts` 셋, `agent-github.ts`, Slack 연결, 저장소 고르기)를 적었다 |
| R2-2 | 담당 팀을 비울 API가 없는데 "해제" 시험을 적었다 | 반영. 이행 전 상태 fixture로 축 B 미적용을 보는 시험으로 고침 |
| R2-3 | "자기가 시작한 세션"과 열람 판정(지금 가진 사람, `ownedBy`)이 다르다 | 반영. "자기 세션" = 지금 가진 사람으로 정의하고 화면 문구를 고침 |
| R2-4 | `audience_limited`를 만드는 서비스와 공유 화면 작업이 구현 단위에 없다 | 반영. R3에 `session-share-service.ts`와 서비스 쪽 viewer, R4에 공유 화면·Slack 연결 화면 |

3차(head `d02a2845c`, 위 네 고침만): 넷 모두 해결, BLOCKER 없음. 새로 넣은 "Slack 연결 쓰기에는 재확인이 없다"가 틀렸다는 NOTE 1건(`surface-bindings.ts:144`가 `callerHoldsRight()`로 다시 본다)을 받았다. 반영해 그 서술을 지우고, 구성원인지만 보는 저장소 고르기 쓰기(`catalog-repositories.ts:169`)를 목록에 넣었다.
