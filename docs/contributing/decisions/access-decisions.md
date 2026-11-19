# 결정(설계): 접근 판정 하나로 기억 범위, MCP 자격, 에이전트 답변을 정한다

- 상태: 설계. 코드는 바꾸지 않는다. 단계는 [11절](#11-단계-계획)에 있다.
- 기준 커밋: `origin/main` `f3c650f4e`. `파일:줄`은 이 커밋에서 읽었다.
- 오너 원문(2026-11-20, 터미널):
  - "결국 메모리 같은 경우에도 개인 메모리에 누가 접근해도 되냐 안되냐 이런개념으로 놓고 봣을때 mcp 와 동일하게 권한 접근에 대ㅏㄴ 추상활를 하고 각 단계별로 (개인,팀, 조직 - 메모리 / 개인, 에이전트 연동- mcp / private, dm, public 채널, 팀멤버인지 안니지 - 에이저느 호출 ) 이런식으로 agent 를 사용하고 agent 가 동작하는것의 권한 제어의 범위안에 놓고 설계해야할듯 ?"
  - "mcp 에 대해서 잇다면 mcp 가 아니라 각각의 요소를 연동할때 어떤 누구의 인증정보를 가져다 쓰는가나 그리고 agent 를 호출할때 답변하는 것의 권한 제어 이런식으로 가는게 맞을듯"
  - "idp 그룹도 팀으로쓰고 따로 지정할수도 잇게 하면되지"
- 관련 결정: [에이전트 담당 팀과 액션 RBAC](agent-rbac.md), [워크스페이스 원격 MCP 서버](mcp-credentials.md), [관측과 도구 호출 감사](observability-otel-and-tool-call-audit.md), [Musterrolle 모듈 경계](musterrolle-boundary.md), [범용 OIDC 로그인 공급자](oidc-login-providers.md).
- 검토 중인 설계 두 개와의 관계: 스킬·MCP 서버 설계([JeongJaeSoon/werft#1949](https://github.com/JeongJaeSoon/werft/pull/1949))의 6절 "데이터 접근 정책"과 기억 레이어 설계([JeongJaeSoon/werft#1952](https://github.com/JeongJaeSoon/werft/pull/1952))의 5절 "집행 순서"는 이 문서의 판정을 부르는 쪽이 된다([12절](#12-다른-설계-문서가-어떻게-바뀌나)). 두 문서는 아직 main에 없으므로 PR로 가리킨다.
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
| 실패 | 닫힌다. 판정 중 예외, 저장소 오류, 정책을 읽지 못함, 기록을 쓰지 못함은 모두 거절이다. 이행 모드로 돌아가 허용하는 길은 없다 |
| 지금 할 것 | **최소 판정기**: 기억 축만, 워크스페이스 규칙 없이 고정 규칙(지금 `memory.read`/`memory.write` grant + 개인 기억 전제)으로 판정하고 기록한다. 기억 도구는 이것이 들어오기 전에 열지 않는다. 같이 MCP egress 판정을 `authorize`로 옮겨 이행 모드 그대로 기록한다 |

## 1. 지금 있는 것

| 것 | 어디 | 이 설계에서 |
|---|---|---|
| 판정 API | `AuthorizationPolicy.authorize(request, { record?: false })` (`packages/platform/src/musterrolle/policy.ts:272-293`). 예외는 `error` 거절로 바꾼다(같은 파일 `:883-896`) | 진입점을 새로 만들지 않고 이것을 쓴다 |
| 판정 기록 | `authz_decisions` (`packages/db/migrations/0137_authz_decisions.sql`). append-only 트리거, 주체·actor·에이전트·release·surface·action·대상·결과·이유·`policy_version`·`request_id` | 축별 칸을 더한다([7절](#7-기록)) |
| 무엇을 기록하나 | `mustRecord` (`policy.ts:425-446`): 거절은 모두, 허용은 관리 동작과 `session.approve`·`session.share`·사유가 있는 요청·Slack 제출. 기록하지 못한 허용은 `error` 거절로 바꾼다(`policy.ts:913-942`) | 새 축의 동작을 기록 대상에 넣는다. 그러면 "모두 기록, 못 쓰면 거절"을 그대로 물려받는다 |
| 판정 계약 | 요청 `{subject, action, resource, request_id}`, 결과 `{outcome, reason_code, effective_scopes, redact?, approval?, policy_version, decision_id}` (`packages/contracts/src/musterrolle/authorization.ts:653-748`). 결과 종류는 `allow`·`deny`·`redact`·`require_approval` (`:542-548`) | 결과에 축별 허용 내용 칸을 더한다. 답변 요약은 지금의 `redact`(`view: "summary"`)를 쓴다 |
| 이미 있는 액션 | `memory.read`·`memory.write`·`delivery.send` (`authorization.ts:387-390`). grant 대상은 기억이 `workspace`·`agent`·`memory`, 전달이 `session`·`session_link`·`surface_binding` (`packages/db/src/schema.ts:192-195`) | **정책 규칙이 아직 없어서** 지금 부르면 `error` 거절이다. 최소 판정기가 이 자리를 채운다 |
| 요청자 없음 | 주체 `principal: null`은 언제나 `no_requester` 거절(`policy.ts:623`, 계약 주석 `authorization.ts:554-555`) | 루틴이 생길 때까지 그대로 둔다 |
| 입구 | Slack 채널 종류 `public_channel`·`private_channel`·`dm` (`packages/contracts/src/kollegium/surfaces.ts:45-49`), 채널 상한의 공개 정도 `full`·`summary` (`:116`), binding의 `memory_write_policy` (`:159`) | 맥락 입력 |
| 세션 공유 범위 | `private`·`people`·`team`·`workspace` (`packages/contracts/src/musterrolle/session-shares.ts:26-31`) | 맥락 입력이자 공개 범위 목록의 원본([2절](#범위-목록-둘)) |
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

### 주체

| 주체 | 판정에서의 모양 | 개인 기억·개인 연결 |
|---|---|---|
| 사람(콘솔, 개인 key, 연결된 Slack 사용자) | `principal` = 그 사람. 턴의 작성 주체(`turn.actorId`)를 읽는다 | 아래 전제를 만족하면 가능 |
| 에이전트 key | `principal` = 에이전트. 그 에이전트의 안쪽으로 본다 | 언제나 거절 |
| 위임 사슬 | 사람 → 에이전트 A → 에이전트 B. `principal`은 처음 요청한 사람으로 두고, `subject.agent`는 지금 일하는 에이전트, 새 칸 `subject.via`에 앞선 에이전트들을 순서대로 둔다. 사슬의 에이전트마다 그 사람이 쓸 수 있어야 한다(에이전트 RBAC). 각 단계는 좁히기만 한다 | 첫 단계(사람이 직접 부른 에이전트)에서만. 그 뒤 단계는 기본 거절([13절](#13-열린-질문) 2) |
| 요청자 없음(루틴·webhook) | `principal: null`. 루틴이 생기면 루틴 주인을 기록 칸(`routine_owner`)에만 남기고 판정 주체로 쓰지 않는다 | 언제나 거절 |
| 확인되지 않음 | 턴이 없음, 조회 실패, Slack 사용자의 연결 없음. `none`과 다르다 | 언제나 거절. 요청자 조건이 있는 규칙에도 맞지 않는다 |

**개인 기억·개인 연결의 전제**는 #1949 6절과 #1952 2절이 같은 내용을 따로 적었던 것을 여기 하나로 둔다. ① 요청자가 확인된 사람이고 대상 개인 범위의 주인이다. ② 요청자가 세션 소유자다. ③ 세션 공유 범위가 `private`다(Slack DM 세션은 이미 `private`, Slack 채널 세션은 언제나 아님). ④ 공유를 더하는 쓰기는 세션 행 `FOR UPDATE`, 판정은 `FOR SHARE`로 같은 행을 잡아 경합을 막는다. ⑤ 개인 데이터를 쓴 세션은 세션 행에 그 사람을 표시하고, 그 세션의 공유·이관은 그 사람만 확인을 받고 한다.

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

모든 결과에 `rule`을 붙인다: `{ mode: "transition" }`, `{ mode: "fixed" }`(최소 판정기), `{ mode: "policy", revision, rule_id, position }` 가운데 하나. 거절 이유에는 `access_policy_denied`, `access_policy_unavailable`, `requester_unresolved`, `personal_scope_unavailable`, `personal_connection_unavailable`, `delivery_audience_outside`를 더한다. 이유 목록은 contracts 한 곳이므로 #1949·#1952가 적은 이름(`personal_memory_unavailable` 등)은 이 이름으로 합친다.

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
- **최신성.** IdP 그룹 팀은 로그인 때만 맞춰지므로 퇴사·이동이 늦게 반영될 수 있다. 그래서 (a) 구성원 비활성·탈퇴는 지금처럼 즉시 모든 팀에서 뺀다, (b) 웹 로그인 세션 만료가 동기화 주기의 상한이다, (c) 판정 기록에 사용한 팀 소속의 `synced_at`을 남겨 나중에 설명할 수 있게 한다. 수동 팀은 관리자가 잊으면 오래 묵는다는 위험이 더 크므로, 콘솔이 "90일 넘게 바뀌지 않은 수동 팀"을 보여 준다. IdP 그룹 동기화는 이 위험 때문에 "다음" 단계 앞쪽에 둔다.
- 판정은 출처를 보지 않는다. 규칙의 팀 칸은 두 출처의 팀을 같은 목록에서 고른다.

**공유 지식 공간의 구성원 스냅샷.** 공간(나중)은 구성원이 사람, 에이전트, 팀(두 출처 모두)이다. 판정은 공간의 `membership_revision`과 그때 해석한 구성원 집합으로 하고, 기록에 그 revision을 남긴다. 사람이 공간·팀을 떠나거나 에이전트가 빠지면 revision이 오르고, 다음 판정부터 바로 빠진다(캐시는 revision이 같을 때만 쓴다). IdP 그룹 팀을 통해 들어온 구성원은 다음 동기화 때 빠진다. 이 계약은 공간을 열 때 시험으로 고정한다.

## 4. 규칙이 없을 때의 기본 동작

규칙을 저장한 적 없는 워크스페이스(이행 모드)는 지금과 같게 움직인다.

| 축 | 이행 모드의 결과 | 지금과 같은가 |
|---|---|---|
| MCP 자격 | 에이전트가 켠 서버면 `allow`, `agent` 연결. 개인 연결은 쓰지 않는다 | 같다. 바뀌는 것은 기록이 남는다는 것뿐이다 |
| 답변 전달 | 요청이 들어온 곳으로. Slack 채널은 binding 상한의 공개 정도(`full`이면 전체, `summary`면 `redact`) | 같다 |
| 기억 | 기억은 지금 없다. 기억이 들어올 때는 최소 판정기의 고정 규칙(11절)이 기본이다: 세션·에이전트·워크스페이스는 grant로, 개인은 전제를 만족할 때 | 새 기능이므로 "지금"은 이 고정 규칙이다 |

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
| `team_snapshot` | 판정에 쓴 팀 id 목록과 각 소속의 `synced_at`, 공간이면 `membership_revision` |

- 정책은 revision마다 불변 행으로 남겨, 지난 판정을 그때의 규칙으로 다시 설명할 수 있게 한다.
- 본문, 도구 입력, 기억 내용, 외부 계정 식별자는 남기지 않는다. 개인 연결의 subject는 werft 사용자 id다.
- 새 축의 동작은 `mustRecord`의 기록 대상에 넣는다. 그래서 허용도 모두 남고, 기록하지 못한 허용은 거절이 된다.
- 무엇이 "판정 하나"인가: 기억 도구 호출 하나, 콘솔 기억 동작 하나, MCP (서버, 턴)의 첫 요청과 `tools/call` 하나하나, 답 게시 하나. 같은 턴 안의 `tools/list`·스트림 이어 받기·`regrant`는 다시 판정하되, 결과가 고정한 것과 같으면 새 행을 쓰지 않고 그 판정의 id를 이어 쓴다. 결과가 달라지면(거절, subject 바뀜) 새 행이다([13절](#13-열린-질문) 1).

## 8. 실패 모드

닫힌다. 지금 `authorize`가 하는 것을 축 셋에 그대로 적용한다.

| 상황 | 결과 |
|---|---|
| 판정 중 예외, 저장소 오류, 잘못된 요청, 규칙이 없는 action·resource 쌍 | `deny` `error` |
| 정책 모드인데 정책을 읽지 못함, 판정기가 모르는 축·조건 | `deny` `access_policy_unavailable`. 이행 모드로 취급하지 않는다 |
| 기록을 쓰지 못함 | 허용이었어도 `deny` `error` |
| 요청자를 확인하지 못함 | 개인 범위·개인 연결은 거절, 요청자 조건이 있는 규칙은 맞지 않음 |
| 팀 소속을 읽지 못함 | 그 판정 전체가 `error` 거절. "팀 밖"으로 계속 가지 않는다 |
| Slack 채널 구성원을 모름 | 받는 쪽 "알 수 없음"(바깥으로 본다) |
| 판정과 commit 사이에 규칙·grant·멤버십이 바뀜 | 쓰기는 commit하지 않는다. 읽기는 다음 호출부터 반영 |

엔진에는 지금처럼 도구 오류로만 보이고, 이유 코드는 기록과 콘솔에서 본다.

## 9. 성능 예산

판정은 MCP 요청마다 서고, 기억 검색 앞에 선다. 그래서 정한다.

- 판정 하나의 추가 지연: p95 5ms 이하, p99 20ms 이하(같은 리전 Postgres 기준). 네트워크 밖 호출은 판정 경로에 없다.
- DB 읽기: 정책 규칙은 (워크스페이스, revision)으로 프로세스 안에 캐시하고, revision 확인은 egress가 이미 읽는 세션 상태 조회에 붙인다. 팀 소속은 인덱스 조회 하나. 위 둘에 기록 insert 하나.
- Slack 채널 구성원은 판정 경로에서 부르지 않는다(5절).
- 기억은 도구 호출마다 판정 한 번이고 문서 수에 비례하지 않는다.
- 측정: 판정 지연과 축·결과·이유별 건수를 지표로 남긴다([관측과 도구 호출 감사](observability-otel-and-tool-call-audit.md)의 방향을 따른다). 예산을 넘으면 구현 PR이 머지되지 않는다(부하 시험 하나를 PR에 붙인다).
- 기록량: MCP 호출 수만큼 늘어난다. 같은 결과의 전송 요청을 합치는 7절의 규칙이 늘어나는 양을 `tools/call` 수 정도로 묶는다.

## 10. 이행

- expand만 한다. 새 칸은 nullable, 새 표(`access_policies` revision 행, 팀 출처 칸)는 비어 시작한다. backfill은 없다.
- 모든 워크스페이스는 이행 모드로 시작하고 지금과 같게 움직인다(4절).
- 섞인 버전: 옛 control-host는 정책을 모른다. 그래서 정책 모드에 들어가는 저장은 모든 control-host가 새 판정기를 가진 뒤에만 연다(설정 하나로 막고, 배포 뒤 켠다). 정책 모드 워크스페이스를 옛 host가 판정하면 `access_policy_unavailable`로 닫힌다.
- `POLICY_VERSION`을 올린다. 지난 판정 행은 그때의 버전을 가진다.
- egress의 actor를 세션 만든 사람에서 턴 요청자로 바꾸는 일은 지금 기록되는 값이 바뀌는 것이므로 릴리스 노트에 적는다.
- IdP 그룹 팀은 공급자마다 켤 때만 생긴다. 켜지 않은 워크스페이스는 바뀌지 않는다.

## 11. 단계 계획

### 지금

1. **최소 판정기.** 기억 축만. `memory.read`·`memory.write`에 정책 규칙을 넣는다: 지금 grant(`schema.ts:192-193`)와 역할 기본값, 2절의 개인 데이터 전제, binding의 `memory_write_policy`를 코드의 고정 규칙(`rule_mode = fixed`)으로 판정하고 `memory_scopes`를 돌려준다. 기록 대상에 넣는다. 워크스페이스 규칙 표는 아직 없다. **기억 도구와 기억 주입은 이것이 머지되기 전에 열지 않는다.**
2. 판정 계약에 `access` 요청 칸과 결과 칸, 범위 목록 둘, 새 이유 코드를 더한다(contracts).
3. `authz_decisions`에 7절의 칸을 더한다.
4. MCP egress 판정을 `authorize`의 `mcp.use`로 옮긴다. 이행 모드 그대로(`agent` 연결) 기록만 새로 남기고, 요청자를 턴의 작성 주체로 바꾼다. `tool_call_audits`에 `access_decision_id`.
5. 답변 전달은 개인 데이터 고정 규칙만 `delivery.send`로 넣는다(개인 데이터가 생기는 기억 1과 같이).

### 다음

- 워크스페이스 규칙 표와 정책 모드, 콘솔 규칙 편집기와 규칙 시험.
- 요청자 개인 MCP 연결: 만들기·읽기·끊기, subject를 관통시키는 연결 조회·잠금·receipt, 그 뒤에 MCP 축의 `personal` 결과.
- IdP 그룹 → 팀 동기화(3절). 다음 단계의 앞쪽.
- Slack 채널 구성원 대응과 받는 쪽 기준 답변 규칙.
- 위임 사슬(`subject.via`)을 에이전트끼리 부르는 경로에 채운다.

### 나중

- 공유 지식 공간과 구성원 스냅샷 계약(3절).
- 루틴(요청자 없는 실행)과 루틴 주인 기록.
- 외부 게이트웨이용 서명 단언(13절 7, 필요가 생기면).

## 12. 다른 설계 문서가 어떻게 바뀌나

- **#1949 6절 "데이터 접근 정책"**: 이 문서를 가리키는 절로 줄인다. 남기는 것은 MCP 축에만 있는 것(엔진의 자체 MCP 연결·OAuth 막기, 전송 세션의 subject 고정과 `Mcp-Session-Id` 묶음, 개인 연결이 관통해야 하는 경로 표)이다. 규칙 모양, 모드와 기본값, 요청자 해석, 개인 데이터 전제, 감사 칸은 여기가 정본이다. 그 수정은 #1949의 보류가 풀린 뒤에 그 PR에서 한다. 이 PR은 #1949를 고치지 않는다.
- **#1952 5절 "집행 순서"**: 1–3단계를 "접근 판정의 기억 축"으로 바꾸고 이 문서를 가리킨다. 3단계 표의 이행 모드 예외(개인 기억은 전제만으로 허용)는 이 문서의 최소 판정기 고정 규칙과 같은 내용이다. 이유 이름 `personal_memory_unavailable`은 `personal_scope_unavailable`로 합친다.

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
