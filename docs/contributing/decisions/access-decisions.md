# 결정(설계): 접근 판정 하나로 기억 범위, MCP 자격, 에이전트 답변을 정한다

- 상태: 설계. 코드는 바꾸지 않는다. 단계는 [11절](#11-단계별-구현-계획)에 있다.
- 기준 커밋: `origin/main` `f3c650f4e`. `파일:줄`은 이 커밋에서 읽었다.
- 오너 원문(2026-11-20, 터미널):
  - "결국 메모리 같은 경우에도 개인 메모리에 누가 접근해도 되냐 안되냐 이런개념으로 놓고 봣을때 mcp 와 동일하게 권한 접근에 대ㅏㄴ 추상활를 하고 각 단계별로 (개인,팀, 조직 - 메모리 / 개인, 에이전트 연동- mcp / private, dm, public 채널, 팀멤버인지 안니지 - 에이저느 호출 ) 이런식으로 agent 를 사용하고 agent 가 동작하는것의 권한 제어의 범위안에 놓고 설계해야할듯 ?"
  - "mcp 에 대해서 잇다면 mcp 가 아니라 각각의 요소를 연동할때 어떤 누구의 인증정보를 가져다 쓰는가나 그리고 agent 를 호출할때 답변하는 것의 권한 제어 이런식으로 가는게 맞을듯"
  - "idp 그룹도 팀으로쓰고 따로 지정할수도 잇게 하면되지"
- 관련 결정: [에이전트 담당 팀과 액션 RBAC](agent-rbac.md), [워크스페이스 원격 MCP 서버](mcp-credentials.md), [관측과 도구 호출 감사](observability-otel-and-tool-call-audit.md), [Musterrolle 모듈 경계](musterrolle-boundary.md), [범용 OIDC 로그인 공급자](oidc-login-providers.md).
- 검토 중인 설계 두 개와의 관계: 스킬·MCP 서버 설계([JeongJaeSoon/werft#1949](https://github.com/JeongJaeSoon/werft/pull/1949))의 6절 "데이터 접근 정책"과 기억 레이어 설계([JeongJaeSoon/werft#1952](https://github.com/JeongJaeSoon/werft/pull/1952))의 5절 "집행 순서"는 이 문서의 판정을 부르는 쪽이 된다([12절](#12-다른-설계-문서가-어떻게-바뀌나)). 두 문서는 아직 main에 없으므로 PR로 가리킨다.
- 조사: 공개 자료 조사(2026-11-20)의 요약과, 무엇을 따르고 무엇을 다르게 가는지, werft 안의 자리는 [14절](#14-조사-요약과-시장-동향), [15절](#15-따를-것과-다르게-갈-것), [16절](#16-werft-아키텍처-적용)에 있다. 단계와 끝난 조건은 [11절](#11-단계별-구현-계획)이다.
- 티켓 번호: 저장소의 마크다운은 티켓 번호를 적지 못한다(`tests/docs-links.test.ts`). 번호는 이 문서를 들인 PR 본문에 있다.

## 요약

| 항목 | 결론 |
|---|---|
| 한 줄 | 기억, MCP, 에이전트 호출의 권한을 따로 만들지 않는다. 지금 있는 판정 API(`AuthorizationPolicy.authorize`) 하나에 **축 셋**(기억 범위, MCP 자격, 답변 전달)을 더하고, 판정은 모두 지금의 판정 기록(`authz_decisions`)에 남긴다 |
| 진입점 | 서버 쪽 `authorize(request)` 하나. 요청에는 id만 싣고, 팀 소속·세션 공유·채널 종류·턴의 요청자는 판정기가 플랫폼 상태에서 직접 읽는다. 엔진·worker·클라이언트가 보낸 값은 판정 입력이 아니다 |
| 주체 | 사람, 에이전트 key, 위임 사슬(처음 요청한 사람 + 부른 에이전트들), 요청자 없음(루틴·webhook, 나중). 요청자가 없거나 확인되지 않으면 개인 기억과 개인 연결은 언제나 거절이다 |
| 대상 | 기억 범위(세션 / 개인 / 에이전트 / 워크스페이스, 나중에 공유 지식 공간), MCP 자격(에이전트 연결 / 요청자 개인 연결), 에이전트 답변 전달(전체 / 요약 / 거절) |
| 맥락 | 입구(콘솔, API, Slack 공개·비공개 채널, DM), 세션 공유 범위, 요청자가 에이전트 담당 팀 안인가, 요청자가 세션 소유자인가, 일정 실행인가 |
| 결과 | 허용이면 **무엇으로**까지 정한다: 쓸 수 있는 기억 범위 목록, 쓸 자격(연결 종류와 subject), 답변을 보일 정도. 거절이면 이유. 결과마다 `decision_id`, 규칙 revision, 맞은 규칙이 붙는다 |
| 규칙 | 워크스페이스마다 순서 있는 규칙 목록 하나(위에서 처음 맞는 것). 규칙이 없으면 **이행 모드**로 지금 동작과 같다. 규칙을 처음 저장하면 정책 모드이고 맞는 규칙이 없으면 거절이다 |
| 팀 | werft 팀(지금)과 IdP 그룹에서 오는 팀(새로)을 같은 팀 개념으로 쓴다. 팀마다 출처는 하나다. IdP 그룹 팀은 로그인 때마다 맞춘다 |
| 다른 검사 | 에이전트 RBAC(누가 이 에이전트를 쓰나)는 이 판정의 첫 관문으로 그대로 들어간다. 호출자 상한(caller limits)은 세션 시작 때 손이 닿는 범위를 좁히는 지금 검사로 두고 MCP 축의 입력이 된다. 실행 규칙(allow/deny/ask)은 자기 평가기로 남고 기록도 도구 호출 감사에 두되, MCP 호출 행은 이 판정의 id를 가리킨다 |
| 실패 | 닫힌다. 판정 중 예외, 저장소 오류, 정책을 읽지 못함, 기록을 쓰지 못함, 기록기가 없음은 모두 거절이다. 효력을 갖는 허용은 기록된 뒤에만 효력을 가진다. 이행 모드로 돌아가 허용하는 길은 없다 |
| 지금 할 것 | **최소 판정기**: 기억 축만, 워크스페이스 규칙 없이 새로 정한 고정 권한 표로 판정하고 기록한다. 개인 범위는 이 단계에서 꺼져 있다. 기억 도구는 이것이 들어오기 전에 열지 않는다. 같이 턴에 인증 근거를 남기고, MCP egress 판정을 `authorize`로 옮겨 이행 모드로 기록하고, 무엇을 켜기 전에 호환 릴리스와 DB 쪽 울타리를 낸다 |

## 1. 지금 있는 것

| 것 | 어디 | 이 설계에서 |
|---|---|---|
| 판정 API | `AuthorizationPolicy.authorize(request, { record?: false })` (`packages/platform/src/musterrolle/policy.ts:272-293`). 예외는 `error` 거절로 바꾼다(같은 파일 `:883-896`) | 진입점을 새로 만들지 않고 이것을 쓴다 |
| 판정 기록 | `authz_decisions` (`packages/db/migrations/0137_authz_decisions.sql`). append-only 트리거, 주체·actor·에이전트·release·surface·action·대상·결과·이유·`policy_version`·`request_id` | 축별 칸을 더한다([7절](#7-기록)) |
| 무엇을 기록하나 | `mustRecord` (`policy.ts:425-446`): 거절은 모두, 허용은 관리 동작과 `session.approve`·`session.share`·사유가 있는 요청·Slack 제출. 기록하지 못한 허용은 `error` 거절로 바꾼다(`policy.ts:913-942`) | 새 축의 동작을 기록 대상에 넣는다. 그러면 "모두 기록, 못 쓰면 거절"을 그대로 물려받는다 |
| 판정 계약 | 요청 `{subject, action, resource, request_id}`, 결과 `{outcome, reason_code, effective_scopes, redact?, approval?, policy_version, decision_id}` (`packages/contracts/src/musterrolle/authorization.ts:653-748`). 결과 종류는 `allow`·`deny`·`redact`·`require_approval` (`:542-548`) | 결과에 축별 허용 내용 칸을 더한다. 답변 요약은 지금의 `redact`(`view: "summary"`)를 쓴다 |
| 이미 있는 액션 | `memory.read`·`memory.write`·`delivery.send` (`authorization.ts:387-390`). 이 표는 grant가 **어떤 대상 종류에 붙을 수 있나**만 정한다: 기억은 `workspace`·`agent`·`memory`, 전달은 `session`·`session_link`·`surface_binding` (`packages/db/src/schema.ts:192-195`). `grants` 표(`schema.ts:1271`)는 있지만 지금 판정은 그것을 읽지 않고, 기억의 역할 기본값도 없다 | **정책 규칙이 아직 없어서** 지금 부르면 `error` 거절이다. 물려받을 기억 권한이 없으므로 최소 판정기가 권한 표를 새로 정한다([11절](#11-단계별-구현-계획)) |
| 요청자 없음 | 주체 `principal: null`은 언제나 `no_requester` 거절(`policy.ts:623`, 계약 주석 `authorization.ts:554-555`) | 루틴이 생길 때까지 그대로 둔다 |
| 입구 | Slack 채널 종류 `public_channel`·`private_channel`·`dm` (`packages/contracts/src/kollegium/surfaces.ts:45-49`), 채널 상한의 공개 정도 `full`·`summary` (`:116`), binding의 `memory_write_policy` (`:159`) | 맥락 입력 |
| 세션 공유 범위 | `private`·`people`·`team`·`workspace` (`packages/contracts/src/musterrolle/session-shares.ts:26-31`) | 맥락 입력이자 공개 범위 목록의 원본([2절](#대상과-범위-목록-둘)) |
| 팀 | `member_teams`는 werft 안에서 만든 팀뿐이고 출처 칸이 없다(`schema.ts:4175-4200`). OIDC 공급자는 그룹 claim을 읽지 않는다 | IdP 그룹 팀을 새로 더한다([3절](#3-팀-werft-팀과-idp-그룹)) |
| MCP 자격 | 연결 조회 열쇠가 `(workspaceId, serverId)`이고 서버를 켠 모든 에이전트가 같은 자격을 쓴다(`packages/platform/src/workers/workspace-mcp-egress.ts:130`, 계약 주석 `packages/contracts/src/api/workspace-mcp.ts:15-17`). egress 판정의 actor는 실행 중 턴의 요청자가 아니라 세션을 만든 사람이다(`packages/db/src/sessions/workspace-mcp-egress.ts:210-211`, `creatorOf`). **요청자 개인 연결은 아직 없다** | 개인 연결은 만들기·읽기·끊기가 먼저 있어야 해서 "다음"으로 미룬다 |
| 호출자 상한 | 에이전트마다 워크스페이스·팀·채널 대상 규칙으로 도구·저장소·MCP 서버·자격 이름을 좁힌다(`packages/platform/src/musterrolle/caller-limit.ts:64-100`). 세션 시작 때 넘으면 `session.submit` `caller_limited` 거절로 기록하고(`packages/db/src/postgres-unit-of-work.ts:470-485`, `caller-limit.ts:149-180`), 세션에 고정한 도구 deny는 실행 설정에서 뺀다(`packages/platform/src/workers/worker-gateway.ts:784`). 관리는 `agent.usage.manage` (`packages/platform/src/musterrolle/agent-caller-limits-service.ts:32-55`) | 그대로 둔다. MCP 축의 입력이다([6절](#6-다른-검사와의-자리)) |
| 도구 호출 감사 | `tool_call_audits`가 도구 호출마다 `decision`·`basis`를 남기고, 승인 답의 판정을 `answer_decision_id`로 가리킨다(`schema.ts:2297-2326`) | 실행 규칙 기록은 여기 남고, MCP 호출은 같은 방식으로 이 판정의 id를 가리킨다 |

## 2. 판정 하나의 모양

### 진입점

`authorize(request)` 하나를 서버 쪽에서만 부른다. 축은 action으로 가른다.

| 축 | action | resource | 지금 |
|---|---|---|---|
| 기억 | `memory.read`, `memory.write` | `memory` (id는 범위 열쇠, 검색처럼 여럿이면 null) | 액션은 있고 규칙이 없다 |
| MCP 자격 | `mcp.use` (새로) | `mcp_server` (새로, id는 서버 uuid) | 판정은 egress 안의 별도 코드다 |
| 답변 전달 | `delivery.send` | `session`, `surface_binding` | 액션은 있고 규칙이 없다 |

요청에 더하는 칸은 `access` 하나다. 무엇을 원하는지만 싣는다.

```ts
type AccessAsk =
  | { axis: "memory"; scopes: MemoryScope[]; session_id: string; turn_id: number }
  | { axis: "mcp"; server_id: string; tool: string | null; session_id: string; turn_id: number; attempt_id: string }
  | { axis: "delivery"; session_id: string; turn_id: number; audience: DeliveryAudience };
```

팀 소속, 세션 공유 범위, 세션 소유자, 턴의 요청자, 채널 종류, 개인 기억 표시(`personal_subjects`)는 요청에 싣지 않는다. 판정기가 세션·턴·binding·팀 행에서 직접 읽는다. 지금 egress가 세션 상태를 요청마다 다시 읽는 것과 같고, #1949 6절이 자기 신고 헤더를 받지 않기로 한 것과 같은 이유다.

**id도 부른 쪽이 고르지 않는다.** 서버 쪽 행을 읽는다고 해서 부른 쪽이 고른 id가 믿을 만해지지는 않는다. 그래서 `access`의 `session_id`·`turn_id`·`attempt_id`는 판정을 부르는 플랫폼 코드가 인증된 실행 자격에서 채운다.

- worker·relay에서 오는 요청(기억 도구, MCP, 답 게시)은 attempt 범위 relay token에서 세션·attempt를 얻는다. 그 attempt가 지금 lease를 쥔 attempt인지(fencing epoch), 턴이 그 attempt가 실행 중인 턴인지 본다. 본문이나 헤더에 다른 id가 실려 오면 거절(`error`)하고 기록한다.
- 콘솔 요청은 로그인 세션의 사용자와 경로의 세션 id를 쓰고, 그 세션에 대한 지금 권한(`session.read` 등)을 같은 판정 안에서 본다.
- 답 게시의 받는 쪽(`audience`)은 부른 쪽이 말하지 않는다. 세션의 출처 binding과 위임 기록에서 판정기가 정한다. 부른 쪽은 "이 턴의 답"만 가리킨다.

### 주체

| 주체 | 판정에서의 모양 | 개인 기억·개인 연결 |
|---|---|---|
| 사람(콘솔, 개인 key, 연결된 Slack 사용자) | `principal` = 그 사람. 턴의 작성 주체(`turn.actorId`)를 읽는다 | 아래 전제를 만족하면 가능 |
| 에이전트 key | `principal` = 에이전트. 그 에이전트의 안쪽으로 본다 | 언제나 거절 |
| 위임 사슬 | 사람 → 에이전트 A → 에이전트 B. `principal`은 처음 요청한 사람으로 두고, `subject.agent`는 지금 일하는 에이전트, 새 칸 `subject.via`에 앞선 에이전트들을 순서대로 둔다. 사슬의 에이전트마다 그 사람이 쓸 수 있어야 한다(에이전트 RBAC). 각 단계는 좁히기만 한다 | 첫 단계(사람이 직접 부른 에이전트)에서만. 그 뒤 단계는 기본 거절([13절](#13-열린-질문) 2) |
| 요청자 없음(루틴·webhook) | `principal: null`. 루틴이 생기면 루틴 주인을 기록 칸(`routine_owner`)에만 남기고 판정 주체로 쓰지 않는다 | 언제나 거절 |
| 확인되지 않음 | 인증 근거가 정말 **없는** 경우뿐이다: 근거 칸이 생기기 전의 옛 턴, 연결 계정이 없는 Slack 사용자. `none`과 다르다. 조회 실패는 여기 들지 않고 판정 전체가 `deny` `error`다 | 언제나 거절. 요청자 조건이 있는 규칙에도 맞지 않는다 |

**요청자는 사람 id가 아니라 인증 근거째로 읽는다.** 지금 턴 행은 `actorId`에 사람 id만 남기고, 개인 API key로 보낸 턴도 key를 만든 사람의 id를 싣는다(`packages/db/src/postgres-unit-of-work.ts:826`). 이것으로 사람 principal을 다시 만들면 key의 scope 상한과 폐기 확인이 사라진다. 그래서 정한다.

- 턴 행에 그 턴을 들인 인증 근거를 남긴다: principal 종류와 id(로그인 세션, 개인 key, 에이전트 key, Slack 연결), Slack이면 설치와 연결 계정 id·revision, 에이전트 key면 그 에이전트.
- 판정은 그 근거를 **지금 다시 확인**한다. key가 폐기·만료됐거나 scope가 줄었거나, Slack 연결 revision이 바뀌었거나, 사람이 비활성이면 그 판정은 축과 규칙에 상관없이 **무조건 `deny`**(`requester_revoked`)다. "확인되지 않음"으로 낮추지 않는다. 그러면 요청자를 보지 않는 넓은 규칙이나 이행 모드가 허용할 수 있기 때문이다.
- 판정의 주체는 그 근거의 principal 그대로다. key로 들어온 턴에는 key의 상한이 그대로 걸린다. 사람(개인 범위의 주인)은 근거에서 따로 푼다: 로그인 세션과 개인 key는 그 사람, Slack은 연결된 구성원, 에이전트 key와 요청자 없음은 사람 없음.
- 옛 턴처럼 근거가 없는 행은 사람 id가 있어도 "확인되지 않음"으로 본다. 그래서 개인 범위는 새 턴부터만 열린다. "확인되지 않음"은 근거가 **없는** 경우뿐이다. 근거나 그 재확인에 필요한 행(턴, key, 연결, 사람)을 읽지 못하면 판정 전체가 `deny` `error`이고, 근거가 있는데 무효이면 위처럼 `requester_revoked`다. 둘 다 넓은 규칙이나 이행 모드로 넘어가지 않는다. 이행 모드에서 근거 없는 옛 턴이 지금처럼 에이전트 연결을 쓰는 것은 지금 동작을 지키려는 의도된 예외이고, 정책 모드에서는 요청자 조건이 없는 규칙에만 맞는다.

**개인 기억·개인 연결의 전제**는 #1949 6절과 #1952 2절이 같은 내용을 따로 적었던 것을 여기 하나로 둔다. ① 요청자가 확인된 사람이고 대상 개인 범위의 주인이다. ② 요청자가 세션 소유자다. ③ 세션 공유 범위가 `private`다(Slack DM 세션은 이미 `private`, Slack 채널 세션은 언제나 아님). ④ **표시를 먼저 commit한다.** 개인 범위나 개인 연결을 허용하는 판정은 세션 행을 `FOR UPDATE`로 잡고, 공유 범위와 소유자를 그 잠금 안에서 확인하고, 세션 행에 그 사람을 표시(`personal_subjects`)하고, 판정을 기록한 뒤 commit한다. 데이터나 자격은 그 commit 뒤에만 내준다. 공유를 더하거나 소유자를 바꾸는 쓰기도 같은 행을 `FOR UPDATE`로 잡으므로, 판정이 본 "공유 없음"과 표시가 언제나 같이 보인다. ⑤ 표시가 있는 세션의 공유·이관은 그 사람만 확인을 받고 한다.

**개인 데이터를 넓은 범위로 옮기는 길을 막는다.** 표시만으로는 모자란다. 에이전트가 개인 기억이나 개인 연결로 읽은 내용을 에이전트·워크스페이스 기억에 써서, 표시 없는 다른 세션에서 꺼낼 수 있다. 그래서 정한다.

- 표시가 있는 세션에서 나온 세션 범위보다 넓은 쓰기(에이전트·워크스페이스·공간 기억)는 언제나 후보이고, 그 세션의 `personal_subjects`를 출처 표시로 이어받는다(#1952 4절의 taint와 같다). 표시된 사람 모두가 공개를 확인하기 전에는 채택할 수 없다. 규칙으로 넓힐 수 없다.
- 세션 요약과 정리(드리밍) 결과도 같은 출처 표시를 이어받는다.
- 표시가 있는 세션이 바깥으로 내보내는 일(답 게시, 다른 에이전트에 위임)은 답변 전달 축의 판정을 받는다([5절](#답변-전달)).
- 위 셋이 구현되기 전에는 개인 기억과 개인 연결을 켜지 않는다. 최소 판정기 단계에서 개인 범위는 꺼져 있다([11절](#11-단계별-구현-계획)).

### 대상과 범위 목록 둘

범위 목록은 둘뿐이고 둘 다 contracts 한 곳에 둔다. 이름을 축마다 다시 만들지 않는다.

| 목록 | 값 | 무엇에 쓰나 |
|---|---|---|
| 대상 범위(누구의 것인가) | `session`, `personal`, `agent`, `workspace`, 나중에 `space` | 기억 범위. MCP 자격의 연결 종류(`agent` = 워크스페이스 연결, `personal` = 요청자 개인 연결)도 이 이름을 쓴다 |
| 공개 범위(누구에게 보이나) | `private`, `people`, `team`, `workspace` (지금 `SESSION_SHARE_SCOPE_VALUES`) | 세션 공유, 스킬 공유 범위(비공개 / 특정 사람 / 팀 / 전사), 판정의 맥락 입력 |

오너가 말한 "개인, 팀, 조직"은 대상 범위의 `personal`, `space`, `workspace`이고, 공개 범위의 `private`, `team`, `workspace`에 대응한다. 오너가 말한 "팀"을 기억에서는 사람만의 팀이 아니라 에이전트와 사람이 구성원인 공유 지식 공간(`space`)으로 연다는 것은 #1952 3절의 결정을 따른다.

다른 개념과의 관계는 한 줄씩이다.

- **에이전트 RBAC**: 입력이다. "이 사람이 이 에이전트를 쓸 수 있나"(`agent_private`)를 판정의 첫 관문으로 그대로 평가하고, 통과하지 못하면 축과 상관없이 거절이다.
- **스킬 공유 범위**: 대상이 아니다. 카탈로그에서 누가 그 스킬을 보고 붙일 수 있나를 정하는 공개 범위다. 실행 중 판정은 "이 세션에 켜진 스킬"을 조건 칸으로만 본다.
- **화면 가시성**: 같은 판정을 `record: false`로 부른 결과다. 화면은 따로 규칙을 갖지 않는다. 행위는 반드시 기록하는 판정으로 다시 묻는다.
- **세션 공유 범위**: 맥락 입력이다. 개인 데이터 전제와 답변 전달이 읽는다.

### 맥락

| 맥락 | 어디서 읽나 |
|---|---|
| 입구 | `subject.surface.kind`와 Slack `channel_kind`(`public_channel`·`private_channel`·`dm`). 서버가 binding에서 채운다 |
| 세션 공유 범위 | 세션 공유 행. 행이 없으면 `workspace` |
| 담당 팀 안인가 | 요청자의 팀 소속([3절](#3-팀-werft-팀과-idp-그룹))과 에이전트 담당 팀·관리자 |
| 세션 소유자인가 | 세션 행의 만든 사람 |
| 일정 실행인가 | `principal: null`과 루틴 id(나중) |
| 입구의 기억 쓰기 정책 | binding의 `memory_write_policy`. binding 없는 콘솔·API 턴은 `allow_explicit` |

### 결과

계약의 결과에 `access` 칸 하나를 더한다. `effective_scopes`가 세션 동작의 허용 범위를 싣는 것과 같은 방식이다.

| 축 | `allow`의 내용 | 다른 결과 |
|---|---|---|
| 기억 | `memory_scopes`: 요청한 범위 가운데 쓸 수 있는 것(예: 개인 빠짐) | 하나도 없으면 `deny` |
| MCP 자격 | `credential`: `{ kind: "agent" }` 또는 `{ kind: "personal", user_id }`와 그 연결의 `generation`, `fallback` 여부 | `deny` |
| 답변 전달 | 전체 | `redact`(`view: "summary"`) 또는 `deny` |

모든 결과에 `rule`을 붙인다: `{ mode: "transition" }`, `{ mode: "fixed" }`(최소 판정기), `{ mode: "policy", revision, rule_id, position }` 가운데 하나. 거절 이유에는 `access_policy_denied`, `access_policy_unavailable`, `requester_unresolved`, `requester_revoked`, `membership_stale`, `personal_scope_unavailable`, `personal_connection_unavailable`, `delivery_audience_outside`를 더한다. 이유 목록은 contracts 한 곳이므로 #1949·#1952가 적은 이름(`personal_memory_unavailable` 등)은 이 이름으로 합친다.

### 규칙

#1949 6절의 규칙 모양을 그대로 일반화한다. 워크스페이스마다 정책 하나, 순서 있는 규칙 목록과 `revision`(저장마다 하나 오름). 규칙은 바뀌지 않는 `rule_id`를 가진다. 위에서부터 처음 맞는 규칙 하나로 정한다.

| 조건 칸 | 값 |
|---|---|
| 축 | `memory`, `mcp`, `delivery` (규칙 하나는 축 하나) |
| 요청자 | 구성원·팀·역할의 목록, 또는 `none` |
| 에이전트 | 에이전트 또는 담당 팀의 목록 |
| 대상 | 기억 범위 / MCP 서버(와 `deny` 전용 도구) / 전달 입구 |
| 맥락 | 입구 종류, 세션 공유 범위, 담당 팀 안·밖, 세션 소유자 여부 |
| 스킬 | 세션에 켜진 스킬 목록 중 하나라도 |

칸끼리는 AND, 한 칸 안은 OR, 빈 칸은 "아무것이나". 결과는 축의 허용 내용(위 표) 또는 `deny`. `personal`이 맞았는데 전제가 깨지면 `fallback: agent`를 명시한 규칙만 에이전트 쪽으로 가고, 아니면 최종 거절이다(다음 규칙으로 내려가지 않는다). 콘솔의 규칙 시험은 판정기와 같은 함수를 `record: false`로 부른다.

## 3. 팀: werft 팀과 IdP 그룹

오너 결정대로 IdP 그룹도 팀으로 쓰고, werft 안에서 따로 만든 팀도 둔다.

- `member_teams`에 출처 칸을 더한다: `manual`(지금 팀 전부) 또는 `idp_group`(로그인 공급자 id + 그룹 값). 팀마다 출처는 하나다.
- `idp_group` 팀의 구성원은 그 공급자로 로그인할 때 ID token의 그룹 claim으로 맞춘다. 그룹이 빠졌으면 그 팀에서 뺀다. 콘솔에서 손으로 넣고 빼지 않는다. 구성원 행에 `synced_at`을 둔다.
- 공급자 설정에 "그룹 claim 이름"과 "팀으로 쓸 그룹 목록"을 둔다. 목록에 없는 그룹은 팀이 되지 않는다(그룹이 수백 개인 IdP에서 팀이 넘치지 않게).
- **최신성.** IdP 그룹 팀은 로그인 때만 맞춰지므로 퇴사·이동이 늦게 반영될 수 있다. 웹 로그인 세션은 쓰는 동안 미끄러지며 늘어나므로(`apps/control-host/src/api/auth.ts:656-664`) 동기화 주기의 상한이 되지 못한다. Slack과 API key는 로그인 없이 계속 쓴다. 그래서 정한다.
  - 최신성은 소속 행이 아니라 **(사람, 공급자)마다의 그룹 스냅샷**에 둔다. 동기화는 그 사람이 그 공급자에서 가진 그룹 전체(빈 집합 포함)와 `synced_at`을 한 행으로 쓰고, 팀 소속 행은 그 스냅샷에서 만든다. 그래야 "팀 A에 없다"도 언제 본 사실인지 알 수 있다. 소속 행에만 시각을 두면, 마지막으로 팀 A 밖에서 본 사람이 IdP에서 A에 들어가도 지울 행이 없어 "아님"이 끝없이 이어진다.
  - 공급자 설정에 **최대 나이**(기본 24시간)를 둔다. 스냅샷이 최대 나이를 넘으면 그 사람의 그 공급자 팀들에 대해 소속과 비소속이 **모두** "모름"이다. 그 공급자로 로그인할 수단이 연결되지 않은 사람은 그 공급자 팀의 구성원이 아니다(IdP 그룹 팀은 "그 그룹에 있는 연결된 werft 구성원"으로 정의한다). 연결은 있는데 스냅샷이 아직 없으면 "모름"이다. "그 팀이 아님"으로 보지 않는 이유는, 그렇게 보면 "팀 A는 거절, 나머지는 허용" 같은 규칙에서 팀 A의 구성원이 거절을 피하기 때문이다. 그래서 판정이 그 팀 소속을 봐야 맞는지 정할 수 있는 순간(규칙의 팀 칸, 에이전트 RBAC의 담당 팀, 공간 구성원) 소속이 "모름"이면 그 판정은 `deny` `membership_stale`로 끝난다. 다시 맞춘 뒤에 다시 판정한다. 입구(웹, Slack, API key)와 상관없이 같다.
  - 다시 맞추는 길은 둘이다. 그 공급자로 다시 로그인하거나, 공급자가 서버 쪽 조회(예: 그룹 API, SCIM)를 지원하면 control-host가 주기적으로 당겨 온다. 당겨 오기는 "다음" 단계의 선택 기능이다.
  - 그래서 실제 회수 창은 "구성원 비활성·탈퇴는 즉시(지금처럼 모든 팀에서 뺀다), IdP 그룹에서만 빠진 경우는 최대 나이 안"이다. 콘솔의 공급자 설정 화면에 이 창을 적는다.
  - 판정 기록에 사용한 그룹 스냅샷의 `synced_at`을 남겨 나중에 설명할 수 있게 한다.
  - 수동 팀은 관리자가 잊으면 오래 묵는다는 위험이 더 크므로, 콘솔이 "90일 넘게 바뀌지 않은 수동 팀"을 보여 준다. IdP 그룹 동기화는 이 위험 때문에 "다음" 단계 앞쪽에 둔다.
- 판정은 출처를 보지 않는다. 규칙의 팀 칸은 두 출처의 팀을 같은 목록에서 고른다.

**공유 지식 공간의 구성원 스냅샷.** 공간(나중)은 구성원이 사람, 에이전트, 팀(두 출처 모두)이다. 판정은 공간의 `membership_revision`과 그때 해석한 구성원 집합으로 하고, 기록에 그 revision을 남긴다. 사람이 공간·팀을 떠나거나 에이전트가 빠지면 revision이 오르고, 다음 판정부터 바로 빠진다(캐시는 revision이 같을 때만 쓴다). IdP 그룹 팀을 통해 들어온 구성원은 다음 동기화 때 빠진다. 이 계약은 공간을 열 때 시험으로 고정한다.

## 4. 규칙이 없을 때의 기본 동작

규칙을 저장한 적 없는 워크스페이스(이행 모드)는 지금과 같게 움직인다.

| 축 | 이행 모드의 결과 | 지금과 같은가 |
|---|---|---|
| MCP 자격 | 지금 egress 검사를 모두 통과한 요청이면 `allow`, `agent` 연결. 개인 연결은 쓰지 않는다 | 거의 같다. 아래 두 가지가 바뀐다 |
| 답변 전달 | 요청이 들어온 곳으로. Slack 채널은 binding 상한의 공개 정도(`full`이면 전체, `summary`면 `redact`) | 같다 |
| 기억 | 기억은 지금 없다. 기억이 들어올 때는 최소 판정기의 고정 권한 표(11절)가 기본이다. 개인 범위는 그 단계에서 꺼져 있다 | 새 기능이므로 "지금"은 이 고정 표다 |

**MCP의 지금 검사는 판정 안으로 옮기지 않고 그대로 둔다.** 지금 egress는 세션 시작 때 고정한 서버 묶음, 등록된 엔드포인트와의 일치, 연결 상태(`needs_reauth` 등), 라우팅하는 JSON-RPC 방법 목록, 살아 있는 도구 목록과 release deny의 교집합, 연결 `generation` 재확인을 본다(`packages/platform/src/workers/workspace-mcp-egress.ts:109-156`, `packages/db/src/sessions/workspace-mcp-egress.ts:132-200`). 접근 판정은 이것들을 대신하지 않고 그 위에 더해진다. 이행 모드의 `allow`는 "이 검사들을 다 통과했고 판정도 막지 않았다"는 뜻이다.

**그래도 바뀌는 두 가지.** 이행 모드라도 지금과 다르게 막히는 경우가 생긴다. 릴리스 노트에 동작 변경으로 적는다.

1. 요청자가 세션을 만든 사람에서 턴의 인증 근거로 바뀐다. 그 근거가 지금 유효하지 않으면(개인 key 폐기 등) 지금은 통과하던 호출이 막힌다.
2. 에이전트 RBAC(그 사람이 지금 이 에이전트를 쓸 수 있나)를 호출마다 다시 본다. 세션 도중 담당 팀에서 빠진 사람의 턴은 다음 호출부터 막힌다. 지금 egress는 이것을 보지 않는다.

관리자가 규칙을 처음 저장하면 정책 모드로 들어가고 되돌아가지 않는다. 콘솔은 정책 모드로 들어갈 때 이행 모드와 같은 결과를 내는 규칙을 맨 아래에 미리 채워 보인다(#1949 6절과 같다).

## 5. 각 쪽이 판정을 부르는 법

### 기억 (#1952)

#1952 5절의 1–3단계(RBAC grant, `memoryWritePolicy`, 데이터 접근 정책)가 이 판정 한 번이다. 기억 서비스는 도구 호출·콘솔 동작마다 `memory.read` 또는 `memory.write`를 `access.scopes`와 함께 묻고, 받은 `memory_scopes` 밖은 검색·주입하지 않는다. 4단계(문서마다 상태·tombstone·revision 거름)는 권한이 아니라 문서 수명이므로 기억 서비스에 남는다. 쓰기는 commit하는 transaction 안에서 같은 판정을 다시 부르고, 판정 뒤 규칙 revision·grant·멤버십이 바뀌었으면 commit하지 않는다. 판정은 도구 호출마다 한 번이고 문서마다 하지 않는다.

### MCP 자격 (#1949 6절)

egress 판정(`workspace-mcp-egress.ts`)이 지금 자리에서 `mcp.use`를 묻는다. 결과의 `credential`로 연결 행(`(server_id, subject)`)을 골라 `Authorization`을 붙인다. 판정 입력의 요청자는 세션을 만든 사람이 아니라 실행 중 턴의 요청자로 바꾼다. 연결은 (서버, 턴) 단위로 고정하고 요청마다 다시 판정하는 것, upstream `Mcp-Session-Id`를 subject에 묶는 것은 #1949 6절의 "전송 세션"을 그대로 쓴다. 그것은 MCP 축에만 있는 일이므로 그 문서에 남는다.

**개인 연결은 먼저 있어야 하는 일이 있다.** 지금 연결 조회·잠금·비밀 저장·receipt의 `generation` 재확인은 subject를 워크스페이스 하나로 고정한다. 개인 연결을 결과로 내기 전에 사람별 연결 만들기(본인 OAuth), 읽기(본인 화면), 끊기(본인·관리자 보안 대응·탈퇴 때 자동)가 있어야 한다. 그래서 MCP 축의 결과는 "지금"은 `agent` 또는 `deny`뿐이고 `personal`은 "다음"에 연다.

**외부 게이트웨이와의 경계.** werft는 MCP 게이트웨이를 만들지 않는다(오너 결정). 나누면 이렇다.

| werft가 쥔다 | werft 밖이다 |
|---|---|
| 엔드포인트 등록·연결 설정, 자격 저장, egress에서 자격 붙이기, 어느 자격을 쓸지의 판정과 그 기록, 도구 이름 수준의 호출 감사 | 라우팅, 서버 호스팅, 호출 본문 로그, 게이트웨이 자체의 정책 |

- werft는 게이트웨이 없이도 동작한다. 등록한 엔드포인트가 MCP 서버 자체여도 되고 게이트웨이여도 된다. werft에게는 같은 원격 MCP 엔드포인트다.
- 요청자 신원을 게이트웨이에 넘기는 계약: 개인 연결이면 그 사람의 token이 곧 신원이다. werft는 따로 신원 헤더를 붙이지 않는다. 에이전트 연결이면 게이트웨이가 보는 것은 에이전트(워크스페이스) 자격이고, 요청자를 알려야 할 필요가 생기면 egress가 서명한 단언(요청자 id, `decision_id`, 짧은 만료)을 붙이는 안을 [13절](#13-열린-질문) 7에 둔다. 어느 쪽이든 엔진·worker가 보낸 같은 이름의 헤더는 egress가 지운다.

### 답변 전달

에이전트 답을 어디에 올릴 때(Slack 게시, 웹 세션 이벤트, 위임한 쪽으로 돌려주기) `delivery.send`를 `access.audience`와 함께 묻는다. 결과가 `redact`면 요약만, `deny`면 올리지 않고 요청자에게만 "이 자리에는 답할 수 없다"를 알린다.

**Slack 채널 구성원 대응이 필요하다.** "요청자가 담당 팀 안이 아니면 공개 채널에는 요약만"은 요청자 하나로 정할 수 있지만, "채널 구성원이 모두 담당 팀 안일 때만 전체"처럼 받는 쪽을 보는 규칙은 Slack 채널 구성원 → 연결된 werft 구성원 → 팀 대응이 있어야 한다. 이것은 지금 없다. 정한다.

- 채널 구성원 목록은 binding마다 캐시하고(최대 5분), 판정 경로 밖에서 채운다. 캐시가 없거나 낡으면 그 판정은 받는 쪽을 "알 수 없음"으로 보고 규칙이 그렇게 읽는다(기본: 바깥으로 본다).
- 연결되지 않은 Slack 사용자, 게스트, Slack Connect 사용자는 언제나 담당 팀 바깥이다.
- 개인 데이터 표시가 있는 세션의 답은 그 사람의 DM이나 비공개 세션 말고는 `deny`다. 규칙으로 넓힐 수 없다.

"지금"은 요청자 기준 규칙과 위 개인 데이터 고정 규칙만 둔다. 받는 쪽 기준 규칙은 채널 구성원 대응이 생기는 "다음"에 연다.

### 화면

콘솔이 "이 에이전트가 여기서 무엇을 쓸 수 있나", "이 규칙이면 누가 무엇을 받나"를 보일 때 같은 판정을 `record: false`로 부른다. 화면용 규칙 사본을 두지 않는다.

## 6. 다른 검사와의 자리

한 MCP 도구 호출이 지나는 순서다. 어느 단계든 거절이면 거기서 끝난다.

| 순서 | 검사 | 누가 | 기록 |
|---|---|---|---|
| 세션 시작 | 에이전트 RBAC, 호출자 상한 | 지금의 `session.submit` 판정 | `authz_decisions` (`caller_limited` 포함) |
| 도구가 보이나·실행 전에 묻나 | 실행 규칙 allow/deny/ask와 세션에 고정된 호출자 상한의 도구 deny | worker·엔진 쪽 평가기 | `tool_call_audits` (`decision`, `basis`) |
| 어느 자격으로, 데이터를 가져가도 되나 | 이 판정의 MCP 축 | control-host egress | `authz_decisions` + `tool_call_audits.access_decision_id` |

- **실행 규칙**은 자기 평가기로 남는다. 판정 시점(엔진이 도구를 부르기 전), 입력(도구 입력), 결과(ask)가 다르기 때문이다. 기록도 `authz_decisions`에 합치지 않는다. 대신 MCP 호출의 `tool_call_audits` 행에 `access_decision_id`를 더해 두 기록을 잇는다(승인 답의 `answer_decision_id`와 같은 방식).
- **호출자 상한**은 합치지 않는다. 세션 시작 때 한 번 손이 닿는 범위를 좁혀 세션에 고정하는 검사이고, 이 판정은 호출 때마다 자격과 범위를 고른다. MCP 축은 고정된 상한 안의 서버만 보며, 상한 밖 서버는 자격 선택까지 오지 않는다. 받는 사람 제어(답변 전달)와도 다른 것이다. 상한은 "부른 사람이 무엇에 손댈 수 있나", 답변 전달은 "답을 누가 보나"다.
- **에이전트 RBAC**는 판정 안의 첫 관문으로 평가한다(2절).

## 7. 기록

`authz_decisions`에 nullable 칸을 더한다. 지금 행은 모두 NULL이고 append-only 트리거와 보존 기간(`audit_retention_days`)은 그대로다.

| 칸 | 내용 |
|---|---|
| `access_axis` | `memory`, `mcp`, `delivery` |
| `session_id`, `turn_id` | 판정이 묶인 세션과 턴 |
| `via` | 위임 사슬(에이전트 id·release id 순서) |
| `granted` | 축별 허용 내용: 기억 범위 목록 / 연결 종류·subject·`generation`·`fallback` / 전달 정도 |
| `rule_mode`, `access_policy_revision`, `rule_id`, `rule_position` | 어떤 규칙으로 정했나. 이행·고정 모드면 revision과 규칙이 없다 |
| `team_snapshot` | 판정에 쓴 팀 id 목록, IdP 그룹 팀이면 그 공급자 그룹 스냅샷의 `synced_at`, 공간이면 `membership_revision` |

- 정책은 revision마다 불변 행으로 남겨, 지난 판정을 그때의 규칙으로 다시 설명할 수 있게 한다.
- 본문, 도구 입력, 기억 내용, 외부 계정 식별자는 남기지 않는다. 개인 연결의 subject는 werft 사용자 id다.
- 새 축의 동작은 `mustRecord`의 기록 대상에 넣는다. 그것만으로는 모자란다. 지금 `authorize`는 기록기(`decisions`)가 없으면 판정을 그대로 돌려준다(`policy.ts:914-920`). 그래서 축 셋의 행위 판정(`record: false`가 아닌 것)은 기록기가 없으면 `error` 거절로 한다. 판정기를 만들 때 기록기를 빼는 조립은 이 축들에 대해 시험이 막는다.
- 보장하는 것과 못 하는 것을 나눈다. **효력을 갖는 허용은 모두 기록된 뒤에만 효력을 가진다.** 거절은 기록을 시도하지만, DB 장애처럼 기록 자체를 쓸 수 없을 때의 거절은 남지 않을 수 있다(서버 로그 경고로만 남는다). 거절은 아무것도 내주지 않으므로 이것을 받아들인다.
- 무엇이 "판정 하나"인가: 기억 도구 호출 하나, 콘솔 기억 동작 하나, MCP (서버, 턴)의 첫 요청과 `tools/call` 하나하나, 답 게시 하나. 같은 턴 안의 `tools/list`·스트림 이어 받기·`regrant`는 다시 판정하되, 판정의 모든 입력과 출력이 첫 판정과 같을 때만 새 행을 쓰지 않고 그 판정의 id를 이어 쓴다. "같다"는 결과와 자격만이 아니라 정책 revision, 맞은 규칙, 인증 근거와 그 revision, 받는 쪽, 팀 소속 스냅샷, 연결 `generation`이 모두 같다는 뜻이다. 하나라도 다르면(거절 포함) 새 행이다([13절](#13-열린-질문) 1).

## 8. 실패 모드

닫힌다. 지금 `authorize`가 하는 것을 축 셋에 그대로 적용한다.

| 상황 | 결과 |
|---|---|
| 판정 중 예외, 저장소 오류, 잘못된 요청, 규칙이 없는 action·resource 쌍 | `deny` `error` |
| 정책 모드인데 정책을 읽지 못함, 판정기가 모르는 축·조건 | `deny` `access_policy_unavailable`. 이행 모드로 취급하지 않는다 |
| 기록을 쓰지 못함, 기록기가 조립되지 않음 | 허용이었어도 `deny` `error` |
| 인증 근거가 지금 유효하지 않음(key 폐기·만료, scope 줄어듦, 연결 revision 바뀜, 사람 비활성) | 무조건 `deny` `requester_revoked`. 넓은 규칙·이행 모드로 넘어가지 않는다 |
| attempt가 lease를 잃음, 부른 쪽 id가 실행 자격과 다름 | `deny` `error` |
| 판정에 필요한 IdP 그룹 팀 소속이 최대 나이를 넘음 | `deny` `membership_stale`(3절). "그 팀이 아님"으로 보지 않는다 |
| 인증 근거가 없음(옛 턴, 연결 없는 Slack 사용자) | "확인되지 않음": 개인 범위·개인 연결은 거절, 요청자 조건이 있는 규칙은 맞지 않음 |
| 인증 근거나 재확인에 필요한 행을 읽지 못함 | `deny` `error`. "확인되지 않음"으로 낮추지 않는다 |
| 팀 소속을 읽지 못함 | 그 판정 전체가 `error` 거절. "팀 밖"으로 계속 가지 않는다 |
| Slack 채널 구성원을 모름 | 받는 쪽 "알 수 없음"(바깥으로 본다) |
| 판정과 commit 사이에 규칙·grant·멤버십이 바뀜 | 쓰기는 commit하지 않는다. 읽기는 다음 호출부터 반영 |

엔진에는 지금처럼 도구 오류로만 보이고, 이유 코드는 기록과 콘솔에서 본다.

## 9. 성능 예산

판정은 MCP 요청마다 서고, 기억 검색 앞에 선다. 그래서 정한다.

- 판정 하나의 추가 지연: p95 5ms 이하, p99 20ms 이하(같은 리전 Postgres 기준). 네트워크 밖 호출은 판정 경로에 없다.
- DB 작업: 정책 규칙은 (워크스페이스, revision)으로 프로세스 안에 캐시하고, revision 확인은 egress가 이미 읽는 세션 상태 조회에 붙인다. 판정이 더하는 것은 인증 근거 재확인(key·연결 행), 에이전트 RBAC 읽기, 팀 소속 인덱스 조회, 세션 공유 조회, 기록 insert 하나다. 개인 범위를 허용하는 판정만 세션 행 `FOR UPDATE`와 표시 쓰기가 더해진다. 지금 egress가 쓰는 `call_mcp` receipt는 따로 그대로 있다. 이 예산은 이 더해지는 것 전체에 대한 것이다.
- 기준 부하: 워크스페이스 하나에 동시 세션 50, 세션마다 턴당 MCP `tools/call` 20, 기억 도구 호출 10, 답 게시 1(Slack 채널이면 받는 쪽 판정 1). 이 부하에서 위 지연 예산을 재고, 하루 기록 행 수와 보존 기간(기본 `audit_retention_days`)으로 저장량을 구현 PR에 적는다.
- Slack 채널 구성원은 판정 경로에서 부르지 않는다(5절).
- 기억은 도구 호출마다 판정 한 번이고 문서 수에 비례하지 않는다.
- 측정: 판정 지연과 축·결과·이유별 건수를 지표로 남긴다([관측과 도구 호출 감사](observability-otel-and-tool-call-audit.md)의 방향을 따른다). 예산을 넘으면 구현 PR이 머지되지 않는다(부하 시험 하나를 PR에 붙인다).
- 기록량: `tools/call` 수 + 기억 도구 호출 수 + 답 게시 수 + (서버, 턴)마다 하나 + 결과가 바뀐 전송 요청 수. 7절의 이어 쓰기 규칙은 마지막 항을 줄일 뿐이고, 거절이 이어지는 전송 요청은 줄이지 않는다.

## 10. 이행

- expand만 한다. 새 칸은 nullable, 새 표(`access_policies` revision 행, 팀 출처 칸)는 비어 시작한다. backfill은 없다.
- 모든 워크스페이스는 이행 모드로 시작하고 지금과 같게 움직인다(4절).
- **섞인 버전.** 옛 control-host는 정책도 개인 표시도 모르므로 `access_policy_unavailable`을 낼 수 없고, 옛 공유·이관·답 게시 경로는 개인 표시를 보지 않는다. 그래서 켜는 일(정책 모드 저장, 개인 기억·개인 연결 켜기)은 다음 순서로만 한다.
  1. **호환 릴리스.** 판정을 부르는 모든 경로(egress, 기억 서비스, 답 게시, 세션 공유·이관, 소유자 바꾸기)가 정책 모드와 개인 표시를 알되, 아직 아무것도 켜지 않은 릴리스를 먼저 낸다. 이 릴리스의 경로는 정책 모드나 개인 표시를 보면 그 의미대로 막는다.
  2. **DB 쪽 울타리.** 옛 host는 새 확인 코드가 없으므로, 코드 안의 버전 확인이나 heartbeat로는 막을 수 없다(heartbeat가 끊겼다 돌아온 host도 마찬가지다). 그래서 울타리를 DB에 둔다. 운영자가 호환 릴리스를 모든 host에 깐 뒤 설치의 "최소 control-host 버전"을 호환 버전으로 올린다. 그 올림은 옛 host의 egress·세션 공유·이관·답 게시 경로가 읽는 것을 contract하는 migration과 함께 간다([새 control-host와 옛 worker의 호환 계약](worker-compat.md)의 contract 규칙을 따른다). 그래서 옛 host는 그 경로에서 오류로 실패하고, 실패는 지금처럼 거절이다. 어느 열을 contract할지는 구현 PR에서 고른다. 켜는 저장은 최소 버전이 호환 버전 이상일 때만 받는다.
  3. **되돌리기 금지.** 최소 버전을 올린 뒤에는 호환 릴리스보다 아래로 되돌리는 것을 지원하지 않는다. 켠 것을 꺼도 마찬가지다. 이미 transcript에 남은 개인 데이터와 저장된 정책은 끈다고 사라지지 않고, 옛 host는 그 보호를 모르기 때문이다. 릴리스 노트와 운영 문서에 적는다.
- `POLICY_VERSION`을 올린다. 지난 판정 행은 그때의 버전을 가진다.
- egress의 actor를 세션 만든 사람에서 턴 요청자로 바꾸는 일은 지금 기록되는 값이 바뀌는 것이므로 릴리스 노트에 적는다.
- IdP 그룹 팀은 공급자마다 켤 때만 생긴다. 켜지 않은 워크스페이스는 바뀌지 않는다.

## 11. 단계별 구현 계획

단계 하나는 PR 한두 개이고, 단계마다 티켓 하나를 만든다. 구현은 오너가 시작을 정한 뒤 티켓 순서대로 한다. 아래 "앞선 단계"가 티켓의 blocked-by다.

### 지금

| 단계 | 내용 | PR | 끝난 조건 | 앞선 단계 |
|---|---|---|---|---|
| A1 계약과 기록 칸 | contracts에 `access` 요청·결과 칸, 범위 목록 둘, 새 이유 코드. `authz_decisions`에 7절 칸(nullable). 축 셋의 행위 판정은 기록기가 없으면 거절 | 1 | 계약 시험(스키마 왕복, 축별 결과 모양, 기록기 없는 조립 거절), migration 안전 시험. 동작 변경 없음 | — |
| A2 턴의 인증 근거 | 턴 행에 근거 칸, 턴을 넣는 모든 경로에서 채움, 재확인 함수(`requester_revoked`·"확인되지 않음"·`error` 구분) | 1 | 근거별(로그인 세션, 개인 key, 에이전트 key, Slack) 시험과 폐기·만료·연결 revision 변경·조회 실패 시험 | A1 |
| A3 최소 판정기(기억 축) | 아래 고정 권한 표, 부분 허용, 쓰기 순서, 기록 | 1–2 | 표의 칸마다 판정기 시험(사실 포트에 fixture를 넣는 순수 시험). 공개 채널 세션의 개인 기억 → 거절. 요청자 없음 → 개인 범위 없음. 기억 도구는 여전히 열지 않음 | A1, A2 |
| A4 MCP egress를 판정으로 | `mcp.use`, 지금 egress 검사 유지, 이행 모드 기록, 요청자 근거와 호출마다 RBAC, `tool_call_audits.access_decision_id` | 1–2 | egress 통합 시험: 규칙 없음 → 지금 통과하던 호출이 그대로 통과하고 기록이 남음, 4절 동작 변경 둘. 요청자 없음 fixture(에이전트 key 턴과 principal 없는 판정 요청) → 에이전트 연결만, 개인 연결 결과 없음. 9절 지연 예산 측정. 실제 일정 실행의 통합 시험은 C2 | A1, A2 |
| A5 호환 릴리스와 DB 울타리 | 10절 1–3. 정책 모드·개인 표시를 아는 경로, 최소 control-host 버전, contract migration | 1–2 | 옛 host가 울타리 뒤에서 거절로 실패하는 시험, 되돌리기 금지 운영 문서 | A3, A4 |

### 다음

| 단계 | 내용 | PR | 끝난 조건 | 앞선 단계 |
|---|---|---|---|---|
| B1 개인 범위 전제 | 2절의 표시 commit, 넓은 범위 쓰기의 출처 표시, 표시된 세션의 답변 전달 고정 규칙(`delivery.send`) | 2 | 경합 시험(공유 쓰기와 판정), 세탁 경로 시험(개인 → 에이전트 기억 채택 막힘). 이 뒤에 개인 기억을 켠다 | A5 |
| B2 워크스페이스 규칙과 정책 모드 | 규칙 표(revision 행), 첫 일치, 정책 모드 진입, 규칙 시험 API(`record: false`) | 2 | 규칙 판정 시험, 정책 모드에서 맞는 규칙 없음 → 거절, revision별 설명 | A5 |
| B3 콘솔 규칙 편집기 | 규칙 편집·순서·시험 화면, 정책 모드 진입 때 미리 채운 마지막 규칙 | 1–2 | 화면 시험과 실제 스택에서 규칙 저장 → 판정 확인 | B2 |
| B4 IdP 그룹 팀 | 공급자 설정(그룹 claim, 팀으로 쓸 그룹, 최대 나이), (사람, 공급자) 그룹 스냅샷, 팀 출처 칸, `membership_stale` | 2 | 스냅샷 시험(빈 집합 포함), 최대 나이 넘으면 소속·비소속 모두 모름, 실제 IdP로 로그인 → 팀 반영 | A5 |
| B5 개인 MCP 연결 | 사람별 연결 만들기·읽기·끊기, subject 관통(조회·잠금·비밀·receipt `generation`), MCP 축 `personal` 결과 | 2 | 본인 OAuth 흐름, 관리자 끊기, 탈퇴 때 자동 끊기. 요청자가 아닌 사람(세션 소유자가 아닌 요청자, 관리자가 남의 세션에 보낸 턴)의 개인 연결 → 거절 | B1, B2 |
| B6 Slack 채널 구성원과 받는 쪽 규칙 | binding별 구성원 캐시, 연결된 구성원 → 팀 대응, 받는 쪽 기준 전달 규칙 | 1–2 | 캐시 없음·낡음 → 바깥, 게스트·Slack Connect → 바깥 | B2 |
| B7 위임 사슬 | `subject.via`를 에이전트끼리 부르는 경로에 채움, 사슬마다 RBAC, 첫 단계 밖 개인 범위 거절 | 1 | 사슬 시험 | A3 |

### 나중

| 단계 | 내용 | 앞선 단계 |
|---|---|---|
| C1 공유 지식 공간 | 구성원 스냅샷 계약(3절), 공간 기억 범위 | B1, B4 |
| C2 루틴 | 요청자 없는 실행, 루틴 주인 기록 | A3 |
| C3 게이트웨이 단언 | 13절 7, 요구가 생기면 | B5 |
| C4 IdP 중심 MCP 인가 | 개인 연결의 token을 ID-JAG로 얻는 경로(15절) | B4, B5 |
| C5 기억 없는 세션 | 세션 옵션 하나로 모든 영속 범위(개인·에이전트·워크스페이스·공간)의 읽기, 쓰기, 후보, 정리 입력을 끈다(15절) | A3 |

### A3의 고정 권한 표

기억 축만. `memory.read`·`memory.write`에 아래 고정 권한 표(`rule_mode = fixed`)를 넣고, 판정 결과로 `memory_scopes`를 돌려주고, 기록 대상에 넣는다(기록기 없으면 거절, 7절). 물려받을 기억 권한은 없다. `grants` 표는 이 단계에서 읽지 않는다. 워크스페이스 규칙 표도 아직 없다. **기억 도구와 기억 주입은 이것이 머지되기 전에 열지 않는다.**

| 범위 | 실행 중 도구 호출(주체는 2절의 인증 근거) | 콘솔(로그인한 사람) | API key |
|---|---|---|---|
| 세션 | 그 attempt의 세션만. 읽기·쓰기 | 읽기 `session.read`, 쓰기 `session.submit`의 지금 판정 | 개인 key: 그 key의 scope로 `session.read`(읽기)·`session.submit`(쓰기)가 허용될 때. 에이전트 key: 그 에이전트 세션만 같은 조건 |
| 개인 | **이 단계에서 꺼짐**(2절의 표시 commit·출처 표시가 들어오기 전) | 본인만 읽기·편집·삭제 | 거절 |
| 에이전트 | 읽기: 에이전트 설정이 기억을 켰고, 사람 요청자면 그 사람이 그 에이전트의 안쪽(담당 팀 구성원, 에이전트 관리자, `owner`·`admin`). 요청자 없음·에이전트 key는 설정만. 쓰기: 후보만, binding `memory_write_policy`가 `allow_explicit`일 때(binding 없는 콘솔·API 턴은 `allow_explicit`) | 읽기: 그 에이전트의 안쪽. 채택·편집·삭제: 에이전트 관리자와 `owner`·`admin` | 거절(읽기 전용 key 접근은 "다음") |
| 워크스페이스 | 읽기: 에이전트 설정이 워크스페이스 기억 읽기를 켰고, 사람 요청자면 그 워크스페이스 구성원. 쓰기: 후보만, 위와 같은 `memory_write_policy` 조건 | 읽기: 구성원. 채택·편집·삭제: `owner`·`admin` | 거절 |

- 결과는 부분 허용이다. 검색이 범위 여럿을 물으면 위 표로 허용되는 범위만 `memory_scopes`에 넣고, 하나도 없을 때만 `deny`다.
- 쓰기 순서: 위 표의 권한 → `memory_write_policy`(영속 범위 후보만) → 2절 출처 표시. 앞 단계의 거절이 이긴다. key의 scope와 에이전트 상한은 언제나 좁히기만 한다.
- 이 표의 역할 기본값(구성원 = 워크스페이스 읽기, 관리자 = 쓰기, 에이전트 안쪽 = 읽기, 에이전트 관리자 = 쓰기)은 이 단계에서 처음 생기는 것이다. 사람·팀별 grant로 넓히거나 좁히는 일은 워크스페이스 규칙("다음")이 한다.

## 12. 다른 설계 문서가 어떻게 바뀌나

- **#1949 6절 "데이터 접근 정책"**: 이 문서를 가리키는 절로 줄인다. 남기는 것은 MCP 축에만 있는 것(엔진의 자체 MCP 연결·OAuth 막기, 전송 세션의 subject 고정과 `Mcp-Session-Id` 묶음, 개인 연결이 관통해야 하는 경로 표)이다. 규칙 모양, 모드와 기본값, 요청자 해석, 개인 데이터 전제, 감사 칸은 여기가 정본이다. 그 수정은 #1949의 보류가 풀린 뒤에 그 PR에서 한다. 이 PR은 #1949를 고치지 않는다.
- **#1952 5절 "집행 순서"**: 1–3단계를 "접근 판정의 기억 축"으로 바꾸고 이 문서를 가리킨다. 3단계 표의 이행 모드 예외(개인 기억은 전제만으로 허용)는 이 문서와 다르다. 이 문서는 표시 commit과 출처 표시가 들어오기 전까지 개인 기억을 꺼 둔다(2절, 11절). #1952는 그 순서를 따르게 고친다. 이유 이름 `personal_memory_unavailable`은 `personal_scope_unavailable`로 합친다.

## 13. 열린 질문

각 항목에 추천을 적었다. 답이 없으면 추천대로 간다.

1. **같은 결과의 전송 요청도 행을 쓸까.** 오너는 "판정 결과는 모두 감사에 남긴다"고 했다. 추천: `tools/call`과 (서버, 턴)의 첫 판정, 결과가 바뀐 판정은 모두 행을 쓰고, 같은 결과로 이어지는 `tools/list`·스트림·`regrant`는 첫 판정의 id를 이어 쓴다. 기록에서 빠지는 행위는 없고 행만 줄어든다.
2. **위임 사슬에서 개인 범위.** 추천: 사람이 직접 부른 첫 에이전트만 개인 기억·개인 연결을 쓴다. 그 에이전트가 다른 에이전트를 부르면 그쪽은 기본 거절이고, 규칙으로도 열지 않는다(개인 데이터가 사람이 고르지 않은 에이전트의 transcript에 남는다).
3. **관리자 감사 열람과 개인 데이터.** 추천: 지금 권한이므로 막지 않고, 개인 연결·개인 기억을 켜는 화면에 "워크스페이스 관리자는 사유를 남기고 대화를 볼 수 있다"를 적는다(#1949·#1952의 기본값과 같다).
4. **연결되지 않은 Slack 채널 구성원.** 추천: 담당 팀 바깥으로 본다. 그래서 받는 쪽 기준 규칙이 걸린 채널에서는 연결하지 않은 사람이 있으면 요약이 된다.
5. **IdP 그룹 팀에 손으로 구성원을 더할 수 있게 할까.** 오너 원문 "따로 지정할수도"는 수동 팀을 따로 두는 뜻으로 읽었다. 추천: 팀마다 출처 하나. IdP 그룹 팀에 손으로 더하지 않는다. 더 필요하면 수동 팀을 하나 더 만들어 규칙의 팀 칸에 같이 넣는다. 섞으면 동기화가 손으로 넣은 사람을 지울지 정할 수 없다.
6. **호출자 상한을 규칙 표로 합칠까.** 추천: 지금은 합치지 않는다(6절). 정책 모드가 자리 잡은 뒤 같은 콘솔 화면에 나란히 보이는 것까지만 한다.
7. **외부 게이트웨이에 요청자 신원을 알릴까.** 추천: 지금은 하지 않는다. 개인 연결의 token이 신원이고, 에이전트 연결은 에이전트로 보이는 것이 맞다. 게이트웨이 쪽 정책이 요청자를 꼭 알아야 한다는 요구가 생기면 egress가 서명한 짧은 단언 헤더(요청자 id, `decision_id`, 만료)를 더한다.
8. **정책 모드에서 이행 모드로 돌아갈 수 있게 할까.** 추천: 돌아가지 않는다(#1949와 같다). 같은 결과를 원하면 맨 아래 규칙으로 명시한다. 되돌리기는 "기록에 남지 않는 허용"을 다시 만들 뿐이다.

## 14. 조사 요약과 시장 동향

2026-11-20에 공개 자료로 조사했다. 이 판정에 닿는 것만 적는다. 기억·스킬 형식 자체는 기억 레이어 설계와 스킬·MCP 서버 설계가 다룬다.

### 표준

- **에이전트 권한·위임의 표준은 없다.** Linux Foundation의 Agentic AI Foundation(AAIF)은 MCP, AGENTS.md, Agent Skills, A2A, agentgateway 등 10개 프로젝트를 둔다. 위임과 권한 흐름은 "Identity & Trust" 작업 그룹의 주제일 뿐, 낸 명세가 없다([AAIF](https://aaif.io/), [LF 발표 2026-10-22](https://www.linuxfoundation.org/press/agentic-ai-foundation-announces-four-new-projects-agent-skills-open-responses-openenv-and-opensandbox)).
- **기억의 표준도 없다.** AAIF에는 기억 프로젝트가 없다. W3C AI Agent Memory Interoperability Community Group은 2026-06에 charter를 채택했지만 낸 명세가 없다([W3C CG](https://www.w3.org/community/ai-agent-memory-interop/)).
- **MCP 2026-07-28 개정**: 핵심을 stateless로 바꿨다(`initialize` 없이 요청 메타데이터에 버전과 능력을 싣는다). OAuth issuer 검증을 더했다([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)). 최종 GA 여부는 출처마다 다르게 적혀 있다.

### 제품들이 하는 것

| 제품 | 이 판정과 닿는 점 | 출처 |
|---|---|---|
| Claude Managed Agents 기억 저장소 | 워크스페이스 범위, 세션을 만들 때 붙이고 저장소마다 `read_write`(기본) 또는 `read_only`. 프롬프트 인젝션이 저장소에 쓴 내용을 나중 세션이 믿는 위험을 문서가 직접 경고한다 | [memory](https://platform.claude.com/docs/en/managed-agents/memory) |
| claude.ai Team/Enterprise 기억 | 소유자가 조직 전체 기억을 켜고 끄지만 개인 기억을 보거나 고칠 수는 없다. incognito 대화는 기억에 남지 않는다 | [도움말](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context) |
| Claude Plugins API | 설치 값(required / auto_install / available / not_available)을 조직과 그룹에 둔다. 여러 그룹에 든 사람은 **가장 넓은 값**을 받는다 | [Plugins API](https://platform.claude.com/docs/en/manage-claude/plugins-api) |
| Claude Skills API | 공유 단위가 워크스페이스다. 그 워크스페이스에 닿는 key는 모든 사용자 스킬을 읽고 지울 수 있다 | [skills guide](https://platform.claude.com/docs/en/build-with-claude/skills-guide) |
| Claude API memory tool | 저장, 범위, 경로 검사는 모두 통합하는 쪽이 맡는다 | [memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) |
| Mem0 | `user_id`·`agent_id`·`app_id`·`run_id` 범위 열쇠. 범위 없이 검색하면 사람 사이로 샌다고 문서가 적는다 | [entity-scoped memory](https://docs.mem0.ai/platform/features/entity-scoped-memory.md) |
| OpenAI Codex 기억 | 기계마다 따로 두는 로컬 저장소. `disable_on_external_context`로 MCP·웹 도구를 쓴 대화를 기억 추출에서 뺀다 | [memories](https://learn.chatgpt.com/docs/customization/memories.md?surface=app) |
| ChatGPT | Temporary Chat은 기억을 읽지도 쓰지도 않는다 | [FAQ](https://help.openai.com/en/articles/8590148-memory-in-chatgpt-faq) |
| Codex MCP 설정 | HTTP 서버 자격은 env var **이름**으로만 준다(`bearer_token_env_var`). 도구 allow/deny 목록이 있다 | [Codex MCP](https://developers.openai.com/codex/mcp) |

### 시장 동향 (대략 2026-05 ~ 2026-11)

| 흐름 | 무엇 | 출처 |
|---|---|---|
| 이중 신원 | 에이전트가 자기 신원을 갖고, 사람을 대신할 때는 on-behalf-of(OBO)로 움직이고, 감사는 둘을 함께 남긴다. Microsoft Entra Agent ID가 자율 실행, 대화형 OBO, 에이전트 사용자 계정의 세 흐름을 정의한다 | [Entra OBO 흐름](https://learn.microsoft.com/en-us/entra/agent-id/agent-on-behalf-of-oauth-flow) (2026-08 갱신) |
| IdP가 MCP 접근을 정함 | MCP Enterprise-Managed Authorization(ID-JAG / Cross App Access): IdP SSO로 받은 ID-JAG를 MCP 서버의 인가 서버에서 audience가 묶인 token으로 바꾼다. 서버마다 동의 화면이 없다. 성숙도는 출처마다 다르게 적혀 있다 | [MCP 확장](https://modelcontextprotocol.io/extensions/auth/enterprise-managed-authorization) |
| 도구 호출마다 정책 판정, 기본 거절 | AWS AgentCore Policy가 Gateway에서 도구 호출마다 Cedar로 판정하고 기본은 거절이다. 2026-08에는 기억 동작 12가지를 Cedar 액션으로 더했다. OpenFGA는 에이전트용 ReBAC 모델링 안내를 낸다 | [AgentCore Memory FGAC](https://aws.amazon.com/about-aws/whats-new/2026/08/agentcorememory-fine-grained-access-control) (2026-08-28), [OpenFGA agents](https://openfga.dev/docs/modeling/agents) |
| 권한 거울 검색 | 요청자가 볼 수 있는 것만 꺼낸다. Slack Real-Time Search API·MCP 서버, Glean 권한 인지 색인. 다만 공유 채널에 올라가는 **답**을 받는 쪽 기준으로 거르는 것은 대부분 "원본 권한을 따른다"로 남겨 둔 빈자리다 | [Slack MCP](https://docs.slack.dev/changelog/2026/02/17/slack-mcp) (2026-02-17) |
| 기억은 사람 × 에이전트가 기본 | 공유 기억은 드물고 명시적이다. Copilot Studio 기억은 사람·에이전트별이고 **그룹 채팅과 Teams 채널에서는 꺼진다**. Microsoft는 Work IQ MCP로 인증된 본인의 기억 프로필만, 관리자 정책이 허용한 에이전트에게 읽기 전용으로 주겠다고 2026-11-05에 공지했다(GA는 2026-12 예정) | [Copilot Studio memory](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/memory-overview), [MC1539004](https://mc.merill.net/message/MC1539004) (2026-11-05) |
| 공유 전 검토는 없다 | 제품들은 기억을 대개 자동 추출로 만들고, 사람이 보고 지우는 것과 관리자 켜고 끄기만 준다. 공유 기억은 드물고 명시적이며, 그 앞의 검토 대기열은 사실상 없다 | 위 제품 문서들의 비교 |
| 기억 오염 사고와 방어 | 메일·파일에 심은 지시가 연결 도구를 거쳐 기억에 남는 ZombieAgent(2026-01, Radware), "AI로 요약" 버튼으로 기억에 심는 AI Recommendation Poisoning(Microsoft, 2026-02-10). 연구는 내용 추정보다 **출처 기반 신뢰**가 강하다고 보고, 믿을 수 없는 입력이 들어온 뒤의 기억 쓰기를 막는 것이 방어로 나온다 | [Microsoft](https://www.microsoft.com/en-us/security/blog/2026/02/10/ai-recommendation-poisoning/), [arXiv 2606.04329](https://arxiv.org/pdf/2606.04329) |
| 범위 빠진 조회 | 사람 범위 없이 기억을 검색하면 모두의 기록이 나오는 버그 부류(Mem0 문서가 경고). 인프라 층의 테넌트 간 유출 사고도 같은 부류다(Cloudflare Workers AI, 2026-10 공개) | [Mem0](https://docs.mem0.ai/skill.md) |
| 원칙 | OWASP Top 10 for Agentic Applications 2026의 "Least Agency": 자율성, 도구, 기억 범위를 최소로 | [OWASP](https://genai.owasp.org/resource/2025-12-09/owasp-top-10-for-agentic-applications-for-2026) |

**흐름.** 범위는 사람 / 에이전트 / 프로젝트(워크스페이스) / 실행으로 모이고 있다. 격리 경계는 워크스페이스다. "기억 없는 대화"를 제공하고, 바깥 데이터를 만진 실행을 기억에서 뺀다. 신원은 IdP 중심의 이중 신원으로, 판정은 도구 호출마다 기본 거절로 모인다. 반면 기억, 자격, 답변 전달을 한 자리에서 판정하고 남기는 공통 층은 어느 제품에도 공개 형식으로 없다. 제품마다 관리 콘솔이나 게이트웨이 안의 자기 설정이다.

## 15. 따를 것과 다르게 갈 것

| 구분 | 무엇 | 이 문서에서 |
|---|---|---|
| 표준을 그대로 저장 | MCP: 서버가 알리는 도구 이름, OAuth | 규칙의 도구 칸은 서버가 `tools/list`로 알린 도구 이름을 그대로 쓴다. 서버 칸은 werft에 등록한 서버 이름이다. `mcp__<서버>__<도구>`는 werft와 엔진이 서버 이름을 붙여 만든 이름이고 MCP 규약이 아니다. 어댑터와 판정은 이 붙인 이름을 프로토콜 요구로 다루지 않는다. 개인 연결 OAuth(B5)는 2026-07-28의 issuer 검증을 따른다. 2026-07-28의 stateless 핵심은 판정에 영향이 없다. 판정은 요청마다 하기 때문이다. 다만 #1949 6절이 `initialize`와 `Mcp-Session-Id`에 묶은 (서버, 턴) subject 고정은 그 개정을 쓰는 서버에서 요청 메타데이터 기준으로 옮겨야 한다. 그 일은 그 문서에 남긴다 |
| 표준을 그대로 저장 | Agent Skills: 스킬 `name`(명세 필드) | 규칙의 스킬 칸이 그 이름을 쓴다. 선택으로 붙이는 내용 digest는 werft의 버전 규약이다. 명세에는 버전 필드가 없고 `metadata`만 있다 |
| 엔진별 어댑터 | 엔진이 도구를 부르는 모양, 자체 기억, 자체 MCP 연결 | 판정은 control-host에 있으므로 엔진마다 다르지 않다. 어댑터가 할 일은 엔진 자체 기억·자체 MCP·OAuth를 끄고(Claude 자동 기억, Codex memories), relay만 보이게 하는 것이다(#1949 6절 "자격"). Codex는 relay 비밀을 env var 이름으로 받는다 |
| 우리 모델, 포트 뒤 | 접근 판정, 규칙 형식, 판정 기록 | 표준이 없다. 판정 함수, 사실 읽기, 규칙 저장, 기록을 포트로 나눠([16절](#16-werft-아키텍처-적용)) 표준이 생기면 바깥 경계(게이트웨이 단언 C3, 위임 사슬)에서 맞춘다 |

**따르는 것.**

- 워크스페이스를 격리 경계로 둔다(Claude 스킬·기억 저장소, Mem0의 app).
- 범위를 사람 / 에이전트 / 워크스페이스 / 세션으로 둔다. 업계가 모인 모양과 같다.
- 바깥 데이터를 만진 실행을 넓은 범위에서 빼는 Codex의 방식을, 개인 데이터의 출처 표시(2절)로 일반화한다.
- 자격은 엔진에 값으로 주지 않는다(Codex `bearer_token_env_var`와 같은 생각, 우리는 relay 비밀만 준다).
- **이중 신원.** 판정 주체는 요청자(principal)와 지금 일하는 에이전트, 위임 사슬을 함께 갖고, 기록은 둘을 함께 남긴다(Entra OBO와 같은 모양). 요청자 없는 실행은 에이전트 신원만이다.
- **기억은 사람 × 에이전트가 기본이고 채널에서는 개인 범위를 끈다.** Copilot Studio가 그룹 채팅·채널에서 기억을 끄는 것, 2026-12 GA로 공지된 Work IQ MCP가 본인 기억만 주는 것과 같은 결론이다(2절 개인 데이터 전제).
- **범위 없는 조회를 막는다.** 기억 서비스는 판정이 돌려준 `memory_scopes` 없이 검색하지 못한다. 판정을 거치지 않은 호출은 범위가 비어 있으므로 아무것도 돌려주지 않는다(Mem0 부류의 버그를 구조로 막는다).
- **받는 쪽 기준 답변 판정.** 시장이 비워 둔 자리이고 오너가 명시한 축이다. Slack 채널 구성원 대응(B6)으로 채운다.
- **정책 모드는 기본 거절**이다. 맞는 규칙이 없으면 거절이다(AgentCore Policy와 같다).

**다르게 가는 것과 이유.**

- **여러 그룹이면 가장 넓은 값**(Claude Plugins API) 대신 **순서 있는 첫 일치 규칙**을 쓴다. 오너 결정이 "누가 호출했는지에 따라 막기"를 요구하고, 가장 넓은 값 합치기로는 거절을 표현할 수 없다.
- claude.ai는 소유자가 개인 기억을 보지 못한다. werft는 워크스페이스 관리자의 사유 있는 감사 열람이 이미 있다(`session.audit_read`). 업무 플랫폼의 감사 요구 때문에 그대로 두고, 개인 데이터를 켜는 화면에 알린다(13절 3).
- Claude Skills API처럼 워크스페이스 key 하나가 모든 것을 읽고 지우게 하지 않는다. key는 언제나 판정의 상한으로 좁히기만 한다(11절 A3 표).
- 엔진 자체 기억을 기록의 원본으로 쓰지 않는다. 판정과 기록 밖에 쌓이기 때문이다(기억 레이어 설계 10절과 같다).
- **"기억 없는 세션"은 지금 없다.** ChatGPT Temporary Chat은 기억을 읽지도 쓰지도 않는다. 이 설계의 비공개 세션과 개인 범위 끄기는 개인 범위만 막고, 에이전트·워크스페이스 기억 읽기는 남는다. `memory_write_policy`도 영속 범위 후보만 다룬다. 그래서 같은 효과를 낸다고 하지 않는다. 모든 영속 범위의 읽기·쓰기·후보·정리 입력을 끄는 세션 옵션은 "나중"의 C5로 둔다.
- **규칙이 없을 때는 기본 거절이 아니라 지금 동작이다.** AgentCore Policy는 처음부터 기본 거절이다. 하지만 이 설계는 규칙 없는 워크스페이스가 지금처럼 움직여야 한다는 조건을 진다. 그래서 이행 모드는 지금 동작을 기록과 함께 그대로 두고, 기본 거절은 관리자가 규칙을 저장해 정책 모드에 들어갈 때 시작한다.
- **판정을 별도 게이트웨이가 아니라 control-host에 둔다.** 시장은 게이트웨이와 런타임 중 어디가 판정 자리인지 다투고 있다. werft는 게이트웨이 없이도 동작해야 하고, 기억과 답변 전달은 게이트웨이를 지나지 않는다. werft의 egress가 MCP 축의 집행 자리(PEP)다.
- **공유 범위로 올리는 기억은 검토를 거친다.** 조사한 제품들은 기억을 대개 자동으로 추출하고, 공유 기억은 드물며 공유 프로젝트·공유 블록처럼 명시적으로 만든다. 그리고 공유 기억에 올리기 전의 검토 대기열은 대체로 없다. Claude Managed Agents 저장소도 기본이 `read_write`다. 공유 범위의 기억을 실행에서 읽기 전용으로 두는 것은 업계 관행이 아니라 werft의 선택이다. 이 설계는 세션보다 넓은 범위의 쓰기를 모두 후보로 두고, 개인 데이터 출처가 있으면 그 사람의 확인까지 받는다(2절). 기억 오염 사고(ZombieAgent, AI Recommendation Poisoning)와 출처 기반 신뢰를 지지하는 연구가 그 이유다. 한 번의 오염된 쓰기가 그 범위를 쓰는 모든 실행에 퍼지기 때문이다. 승격 흐름 자체는 기억 레이어 설계 4절이 정본이다.
- **IdP 중심의 MCP 인가(ID-JAG)는 지금 따르지 않고 지켜본다.** 개인 연결(B5)은 먼저 사람별 OAuth로 만든다. ID-JAG는 성숙도가 출처마다 다르고 IdP와 MCP 서버 양쪽의 지원이 있어야 한다. 개인 연결의 연결 행과 판정 결과(`credential: personal`)는 token을 얻는 방법과 무관하므로, ID-JAG가 자리 잡으면 token 얻기 경로만 더한다(C4).

## 16. werft 아키텍처 적용

### 누가 무엇을 갖나

| 무엇 | 어디 | 비고 |
|---|---|---|
| 판정 계약(`access` 요청·결과, 범위 목록 둘, 이유 코드) | `packages/contracts/src/musterrolle/authorization.ts` | 지금 판정 계약 옆 |
| 판정 진입점 | `packages/platform/src/musterrolle/policy.ts`의 `authorize` | action으로 축을 고른다 |
| 축별 판정과 규칙 평가 | 새 디렉터리 `packages/platform/src/musterrolle/access/`: 순수 규칙 평가(첫 일치), 축 셋, 요청자 근거 재확인 | 순수 함수. I/O는 포트로만 |
| 포트 | `packages/platform/src/musterrolle/ports/`: 판정 사실 읽기(세션, 턴 근거, 공유, 소유자, 에이전트 RBAC, 팀 스냅샷, 개인 표시), 규칙 저장(revision), 지금 `DecisionLog` | 사실은 판정기가 읽고, 부른 쪽이 싣지 않는다 |
| DB 어댑터 | `packages/db/src/musterrolle/`: `authz-decisions.ts`(칸), 새 규칙 저장, IdP 그룹 스냅샷. 턴 근거 칸과 세션의 개인 표시는 세션 저장소 쪽 | [Musterrolle 모듈 경계](musterrolle-boundary.md)를 따른다 |
| 부르는 쪽 | egress(`packages/platform/src/workers/workspace-mcp-egress.ts`), 기억 서비스(기억 레이어 설계의 `MemoryService`), 답 게시(surface 모듈), 콘솔 API | 모두 서버 쪽 |

**transaction.** 잠금이 필요한 판정(개인 표시 commit, 쓰기 재판정)은 부르는 쪽 unit of work 안에서 같은 판정 함수를 부르고, 기록도 그 transaction에 쓴다. 지금 `postgres-unit-of-work.ts`가 호출자 상한 거절을 transaction 안에서 기록하는 것(`recordCallerLimited`, `:474`)과 같은 모양이다. 잠금이 필요 없는 판정은 지금처럼 `authorize`가 기록기를 부른다.

**엔진 중립.** 판정은 control-host에만 있다. Claude, Codex, 나중의 다른 엔진은 relay 주소와 도구 오류만 본다. 그래서 엔진을 더해도 판정은 바뀌지 않고, 엔진 어댑터는 #1949 5·6절의 매핑(자체 기억·MCP 끄기, relay 주입)만 맡는다.

### 데이터 모델

| 표·칸 | 내용 | 단계 |
|---|---|---|
| `authz_decisions` + 7절 칸 | nullable 칸, append-only 그대로 | A1 |
| 턴의 인증 근거 | principal 종류·id, Slack 설치·연결 계정 id·revision, 에이전트 | A2 |
| 설치의 최소 control-host 버전 | 한 행 설정 | A5 |
| 세션의 `personal_subjects` | 개인 데이터를 쓴 사람 목록 | B1 |
| 워크스페이스 접근 정책 | (워크스페이스, revision) 불변 행, 규칙 목록, 저장한 사람·시각. 행이 있으면 정책 모드 | B2 |
| IdP 그룹 스냅샷 | (사람, 공급자) → 그룹 집합(빈 집합 포함), `synced_at` | B4 |
| `member_teams` 출처 칸 | `manual` 또는 `idp_group`(공급자 id, 그룹 값) | B4 |
| 개인 MCP 연결 | 연결 행 `subject = 'user:<id>'`, 비밀 owner_ref | B5 |

### 고른 것과 고르지 않은 것

- **범용 정책 엔진**([Cedar](https://www.cedarpolicy.com/), [OpenFGA](https://openfga.dev/) 같은 것)을 판정기로 쓰지 않는다. 시장에서는 AWS AgentCore가 Cedar를, Auth0 FGA가 OpenFGA를 에이전트 판정에 쓴다(14절). 그래도 고르지 않은 이유는 셋이다. 판정이 세션 행 잠금과 개인 표시 commit에 같은 transaction으로 묶여야 한다. 사실(팀 스냅샷, 인증 근거, 공유)을 엔진 쪽으로 동기화하면 그 사이의 어긋남이 새 실패 경로가 된다(OPA를 쓰는 곳이 배포 도구를 따로 두는 이유와 같다). 규칙 모양이 작다(칸 여섯, 첫 일치). 규칙 평가를 순수 함수 포트로 두었으므로, 규칙이 커지면 그 자리에 엔진을 끼울 수 있다.
- **엔진 쪽 훅에서 판정**하지 않는다. 엔진마다 훅의 모양이 다르고, 엔진 프로세스는 프롬프트 인젝션에 놓여 있어 판정 입력을 믿을 수 없다.
- **외부 게이트웨이에서 판정**하지 않는다. werft는 게이트웨이 없이도 동작해야 하고(5절), 기억과 답변 전달은 게이트웨이를 지나지 않는다.

## 범위 밖

- MCP 게이트웨이(라우팅, 서버 호스팅, 호출 본문 로그). werft는 엔드포인트 연동만 한다.
- 실행 규칙과 지시 파일의 설계. 이 판정과의 자리만 6절에 적었다.
- 스킬 공유의 자동 검사. 공개 범위 이름만 이 문서의 목록을 쓴다.
- 사용량·비용 귀속. 지금 장부를 그대로 쓴다.

## 대안 (고르지 않음)

- **축마다 따로 검사(기억 ACL, MCP 정책, 전달 정책).** 오너가 고르지 않았다. 같은 전제(요청자, 개인 데이터, 팀)를 셋이 따로 적게 되고, 이미 #1949와 #1952가 같은 전제를 두 번 적은 것이 그 비용을 보여 준다.
- **새 판정 서비스와 새 기록 표.** 지금 `authorize`가 이미 닫힌 실패, append-only 기록, 보존 기간, 화면용 `record: false`를 가진다. 새 서비스는 이것을 다시 만들고 두 기록을 맞춰야 한다.
- **실행 규칙까지 이 판정으로 합치기.** 실행 규칙은 엔진 쪽에서 도구 입력을 보고 ask까지 내는 다른 시점의 검사다. 합치면 엔진이 도구마다 control-host를 기다리게 된다. 기록을 잇는 것(`access_decision_id`)으로 충분하다.
- **팀 소속을 요청에 실어 보내기.** 빠르지만 부른 쪽이 소속을 말하게 된다. 판정 입력은 플랫폼 상태에서만 읽는다는 원칙에 어긋난다.
