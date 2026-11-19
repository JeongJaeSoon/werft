# 결정(설계): 에이전트 기억 레이어 — 범위, 집행 순서, MCP 도구, MemoryService 포트

- 상태: 설계. 코드는 바꾸지 않는다. 구현 단계는 [14절](#14-단계별-구현-계획)에 있다.
- 기준 커밋: `origin/main` `f3c650f4e`. `파일:줄`은 이 커밋에서 읽었다.
- 관련 결정: [에이전트 담당 팀과 액션 RBAC](agent-rbac.md), [워크스페이스 원격 MCP 서버](mcp-credentials.md), [번들 stdio MCP 서버를 worker relay 뒤에 둔다](stdio-mcp-relay.md), [관측과 도구 호출 감사](observability-otel-and-tool-call-audit.md), [세션 사용량 장부](provider-usage-ledger.md). 데이터 접근 정책은 스킬·MCP 서버 설계 문서의 6절(별도 PR에서 검토 중)을 따른다. 이 문서에서는 "데이터 접근 정책"이라 부른다.
- 티켓 번호: 저장소의 마크다운은 티켓 번호를 적지 못한다(`tests/docs-links.test.ts`). 번호와 단위의 대응은 이 문서를 들인 PR 본문에 있다.

## 요약

| 항목 | 결론 |
|---|---|
| 범위 | **세션 / 개인 / 에이전트 / 워크스페이스** 넷. 개인은 "사람에 대한 것"(`subject_user_id`), 에이전트는 "일에 대한 것"(그 에이전트의 모든 실행), 워크스페이스는 승격으로만 들어오는 정리된 지식(KB)이다. 사람만의 팀 범위 대신, 에이전트와 사람이 구성원인 **공유 지식 공간**을 워크스페이스 다음에 연다([2절](#2-범위-모델)) |
| 오너 질문 | "개인 / 에이전트 / 조직" 세 층(세션은 별도)으로 간다. 개인 ≠ 에이전트다. 1:1 개인 에이전트에서는 화면이 둘을 한 목록으로 보여도 되지만 저장과 권한은 나눈다([3절](#3-개인-기억과-에이전트-기억은-다르다-오너-질문에-대한-답)) |
| 에이전트 팀의 공통 지식 | 엔지니어·PM·QA 에이전트가 같이 쓰는 것은 세 층으로 나눈다: 공간 KB(기억 저장소의 공간 범위), 조율 상태(기억이 아니라 세션 팀의 스레드와 작업 보드), 각 에이전트의 역할 기억(에이전트 범위)([3절](#에이전트-팀이-같이-쓰는-지식-오너-질문-2026-11-20)) |
| 승격 | 범위를 넓히는 것은 행의 범위를 바꾸는 것이 아니라 **새 문서 + 승격 기록**이다. 모델은 후보만 만들고, 출처 쪽 사람이 공개를 확인한 뒤 대상 쪽 사람이 채택한다. 채택·편집은 콘솔에 로그인한 사람만 한다([4절](#4-승격-흐름)) |
| 권한 판정 | 기억만의 ACL은 없다. 기억 읽기·쓰기 권한은 MCP 자격 선택, 에이전트 응답 권한과 같은 **공통 접근 판정** 하나로 묻는다(identity·권한 층의 지금 판정 API). 결과는 "허용 + 쓸 수 있는 기억 범위" 또는 거절이고, 언제나 감사에 남는다([5절](#5-집행-순서), 오너 결정 2026-11-20) |
| 집행 순서 | 모든 읽기·쓰기에서 ① RBAC grant(요청자 ∩ 에이전트 설정) → ② `memoryWritePolicy`(쓰기만) → ③ 데이터 접근 정책 규칙(요청자, 연결 종류, 스킬) → ④ 동작별 가시성·상태 거름 → ⑤ 감사. ①–③은 공통 접근 판정 한 번의 규칙이다. 판정 입력은 플랫폼 상태에서만 읽고, 쓰기는 transaction 안에서 다시 판정한다([5절](#5-집행-순서)) |
| 모양 | control-host의 기억 서비스가 정본을 갖고, 엔진은 플랫폼 relay 뒤의 내장 MCP 서버 `memory`의 도구 넷(`memory_search`·`memory_read`·`memory_write`·`memory_propose`)만 본다. 폴더 mount는 없다([6절](#6-mcp-도구)) |
| 저장소 | `MemoryService` 포트와 계약 시험을 지금 만들고 구현은 Postgres 하나다. 외부 백엔드(Mem0, Zep 등)는 tombstone·revision CAS·권한 재검사 계약 시험을 통과할 때만 붙인다([7절](#7-memoryservice-포트)) |
| 드리밍 | 따로 만들지 않고 증분 정리(consolidation)를 드리밍이라 부른다. 결과는 언제나 **새 후보 + 지금 문서와의 diff**이고 사람이 채택한다. 범위별 예산을 둔다. 정해진 시각에 도는 범위별 실행은 루틴이 생긴 뒤다([8절](#8-정리드리밍)) |
| 엔진 자체 기억 | Claude의 자동 기억, Codex의 Memories는 정책으로 끈다. ACL·tombstone·감사 밖에 기억이 쌓이기 때문이다. 이것은 기억을 켜는 조건의 하나다. 나머지는 공통 판정기와 판정 기록, 검사와 격리, tombstone 삭제와 삭제 장부, 비활성 사용자의 개인 기억 삭제다([10절](#10-엔진-자체-기억), [14절](#14-단계별-구현-계획)) |
| 표준과 다른 제품 | 엔진 사이에 채택된 기억 표준은 없다(AAIF에 기억 프로젝트가 없고, W3C CG는 명세가 없다). 그래서 기억은 우리 모델을 포트 뒤에 두고, 전달은 표준인 MCP로, 규칙은 AGENTS.md·스킬로 둔다. 불변 version, 새 결과를 만드는 정리, 승인 전 미적용은 다른 제품에서 가져오고, 모델이 영속 기억을 바로 쓰는 것은 따르지 않는다([11–12절](#11-조사-요약과-시장-동향)) |
| 아키텍처와 단계 | contracts·platform·db·testkit·control-host·adapter로 나누고(13절), P1 계약·스키마부터 P9 켜기까지 아홉 단계로 간다. 단계마다 PR 하나나 둘과 끝나는 조건이 있다([14절](#14-단계별-구현-계획)) |
| 순서 | 오너 방향(2026-10-28)대로 요청-응답 기반 위에 먼저 놓는다. 상시 실행과 워크플로우는 그 뒤다 |

## 1. 지금 있는 것

- **권한 액션.** `memory.read`·`memory.write`가 액션 목록에 있고(`packages/contracts/src/musterrolle/authorization.ts:387-388`), 대상 종류는 `workspace`·`agent`·`memory`다(`authorization.ts:439-440`, DB 쪽 `packages/db/src/schema.ts:192-193`). `grants`의 CHECK도 같은 짝을 허용한다(`packages/db/migrations/0245_slack_private_approval.sql:6`). `session` 대상은 없다. 이 액션을 확인하는 라우트나 서비스는 없다.
- **공통 판정 계약.** 권한 판정은 요청(`AuthorizationRequest`: 주체, 동작, 자원)을 받아 결정(`AuthorizationDecision`: 허용·거절, 이유, 정책 버전, `decision_id`)을 돌려주는 계약 하나다(`authorization.ts:653-747`). 주체에는 요청자(사람, key, 또는 자율 실행의 `null`), 대신 움직이는 에이전트, 입구(surface)가 들어 있고, 자원 종류에 `memory`가 이미 있다(`authorization.ts:296`).
- **표면 쓰기 정책.** `surface_bindings.memory_write_policy`가 `deny | allow_explicit`, 기본 `deny`로 저장된다(`packages/db/migrations/0152_surface_bindings.sql:13,25`, 계약 `packages/contracts/src/kollegium/surfaces.ts:59-60`). 저장만 하고 아무 경로도 읽지 않는다.
- **세션 열람.** 세션은 공유 범위(`sessionVisibleTo`)대로 읽힌다. 웹·API 세션은 공유 행 없이 시작하므로 `workspace` 범위, 곧 워크스페이스 구성원 누구나 읽는다. 공유 행을 넣는 곳은 Slack DM의 `private`뿐이다. 에이전트 관리자에게 공유 밖 세션을 보는 길은 없고, 워크스페이스 관리자는 사유를 남기는 감사 열람으로만 본다. Slack 채널 세션의 답은 공유 범위와 상관없이 채널 사람 모두가 읽는다. 근거와 줄 번호는 [agent-rbac.md](agent-rbac.md)의 "세션 action" 절에 있다.
- **저장소 없음.** 기억 테이블, 기억 서비스, 기억 MCP 서버가 없다.
- **엔진 설정.** Claude 어댑터는 `settingSources: []`로 사용자·프로젝트 설정을 읽지 않는다(`packages/adapters/runtimes/claude/src/contract.ts:122`). Codex 어댑터는 플랫폼이 승인 경로를 갖지 않는 기능을 `features.*` override로 끈다(`packages/adapters/runtimes/codex/src/config.ts:289-322`). 두 엔진 모두 기억 기능을 명시적으로 끄는 설정은 아직 없다([10절](#10-엔진-자체-기억)).
- **팀.** 담당 팀과 팀 구성원은 있다. 다만 "어느 시점의 팀 구성원에게 공개했는가"를 고정하는 멤버십 스냅샷 계약은 없다.

## 2. 범위 모델

| 범위 | 무엇에 대한 기억 | 행의 열쇠 | 실행에서 읽는 곳 | 콘솔에서 읽는 사람 | 쓰기·채택 |
|---|---|---|---|---|---|
| 세션 | 이 세션의 작업 메모, 요약 | `session_id` | 그 세션의 실행만 | 그 세션을 읽을 수 있는 사람(`session.read`) | 모델이 바로 쓴다(`memory_write`). 세션 보존 기간을 따른다 |
| 개인 | 사람: 선호, 역할, 말투, 반복되는 맥락 | `subject_user_id` | 그 사람이 요청자인 실행만, 아래 전제를 만족할 때 | 본인만 | 모델은 후보만. 본인이 채택 |
| 에이전트 | 일: 저장소 관례, 도메인 사실, 지난 결정 | `agent_id` | 그 에이전트의 모든 실행 | 그 에이전트에 `memory.read`가 있는 사람 | 모델은 후보만. 에이전트에 `memory.write`가 있는 사람이 채택 |
| 워크스페이스 | 정리된 공통 지식(KB) | `workspace_id` | 기억을 켠 그 워크스페이스 에이전트의 실행 | 워크스페이스에 `memory.read`가 있는 사람 | 활성 개인·에이전트 문서의 승격으로만 들어온다. 워크스페이스에 `memory.write`가 있는 사람이 승인 |
| 공유 지식 공간(나중) | 한 프로덕트·프로젝트를 같이 하는 에이전트와 사람의 정리된 지식 | `space_id` + 멤버십 revision | 지금 구성원인 에이전트의 실행. 요청자가 사람이면 그 사람도 구성원 | 공간 구성원 | 구성원 에이전트는 후보만. 공간에 `memory.write`가 있는 사람이 채택. 3절 끝에서 정한다. 열기 전에는 요청하면 `space_scope_unavailable`이다. "워크스페이스 전체 공유"로 대신하지 않는다 |

모든 문서는 `workspace_id`를 갖고, 범위마다 열쇠 하나만 채운다(CHECK로 XOR). 개인 문서는 `agent_id`를 갖지 않는다. 한 사람의 선호는 그 사람이 쓰는 모든 에이전트에 같게 쓰인다. 에이전트마다 따로 둘 필요가 생기면 그때 좁히는 칸을 더한다.

**개인 기억을 실행에서 읽는 전제.** 개인 기억의 내용은 transcript에 남아 세션을 읽는 사람에게 보인다. 그래서 데이터 접근 정책의 개인 연결과 같은 전제를 쓴다.

1. 실행 중 턴의 요청자가 확인된 사람이고 `subject_user_id`와 같다. 요청자가 없거나(`none`, 루틴·webhook) 확인되지 않으면 개인 기억은 없다. 에이전트 key의 턴도 개인 기억이 없다.
2. 요청자가 세션 소유자와 같다. 남의 세션에 보낸 턴은 자기 개인 기억을 쓰지 않는다.
3. 세션의 공유 범위가 `private`(소유자만)다. 공유 행이 없는 세션은 `workspace` 범위이므로 해당하지 않는다. 그래서 웹·API에서 세션을 `private`로 시작하는 선택을 더해야 개인 기억이 쓰인다(M6). Slack DM 세션은 이미 `private`이고, Slack 채널 세션은 답이 채널에 올라가므로 언제나 해당하지 않는다. 공유와 판정의 경합은 데이터 접근 정책과 같은 잠금 순서로 막는다(공유 쓰기는 세션 행 `FOR UPDATE`, 기억 판정은 `FOR SHARE`).
4. 개인 기억을 읽은 세션은 세션 행에 그 사람을 표시한다(`personal_subjects`). 그런 세션을 공유하거나 넘기는 것은 소유자 본인만 하고, 화면이 "개인 기억에서 가져온 내용이 함께 보인다"를 확인받는다. 이 표시는 그 세션에서 나온 요약·후보에도 이어진다(4절의 taint).
5. 워크스페이스 관리자의 감사 열람(사유를 남기는 공유 밖 열람)은 지금 권한이므로 막지 않는다. 개인 기억 화면과 켜기 확인에 "워크스페이스 관리자는 사유를 남기고 대화를 볼 수 있다"를 적는다. 에이전트 관리자에게는 공유 밖 세션을 보는 길이 없으므로 따로 알리지 않는다.

**에이전트·워크스페이스 기억은 비밀이 아니다.** 실행에 들어간 에이전트·워크스페이스 기억은 transcript에 남아, 그 세션을 읽는 사람(기본은 워크스페이스 구성원 누구나)에게 보인다. 콘솔의 `memory.read`는 기억 목록을 거르는 것이지 transcript 노출을 막지 못한다. 그래서 에이전트 기억은 "이 에이전트의 세션을 볼 수 있는 사람 누구에게 보여도 되는 일의 지식"으로 정의하고, 채택 화면이 그렇게 알린다. 더 좁게 지켜야 하는 지식은 개인 기억이나 (나중의) 공간 기억에 둔다.

**공유 범위 기억에 개인 정보가 들어가지 않게.** 에이전트 기억은 그 에이전트를 쓰는 모든 사람의 실행에 들어간다. 그래서 개인 → 에이전트·공간·워크스페이스 승격은 본인만 시작하고(4절), 에이전트·공간·워크스페이스 후보에서 scanner가 사람을 가리키는 정보(이름과 결합된 선호, 연락처 등)를 찾으면 "개인 기억으로 옮기기"를 제안하고 그대로는 채택하지 못하게 한다([9절](#9-주입-개인-정보-삭제)).

## 3. 개인 기억과 에이전트 기억은 다르다 (오너 질문에 대한 답)

> 개인의 메모리, 에이전트의 메모리, 조직의 메모리 이렇게 가야 하나, 아니면 개인의 메모리 == 에이전트의 메모리인가?

**추천: 세 층(개인 / 에이전트 / 조직=워크스페이스)으로 나누고 세션을 그 아래에 둔다. 개인 = 에이전트로 합치지 않는다.** 가르는 기준은 "누구 것인가"가 아니라 **"무엇에 대한 것인가"**다. 개인 기억은 한 사람(주체)에 대한 것이고, 에이전트 기억은 여러 사람이 같이 쓰는 일의 지식이다.

| 이유 | 설명 |
|---|---|
| 공개 대상이 다르다 | 에이전트는 담당 팀이 같이 쓴다. 에이전트 기억은 그 에이전트의 모든 실행에 들어가므로, 개인의 선호를 에이전트 기억에 두면 동료의 실행과 transcript에 그 사람의 정보가 들어간다 |
| 한 사람이 여러 에이전트를 쓴다 | "답은 한국어로, 표로" 같은 선호를 에이전트마다 따로 적으면 중복되고, 고칠 때 어긋난다 |
| 수명이 다르다 | 사람이 워크스페이스를 떠나면 개인 기억은 지워야 하고, 에이전트가 배운 일의 사실은 남아야 한다. 같은 행이면 둘을 가를 수 없다 |
| 채택 권한이 다르다 | 개인 기억의 채택은 본인, 에이전트 기억의 채택은 에이전트 관리자다. 합치면 관리자가 남의 선호를 고치거나, 사용자가 팀 지식을 혼자 바꾼다 |
| 1:1 개인 에이전트도 갈라 두는 것이 싸다 | 지금은 한 사람만 쓰는 에이전트라도 나중에 팀에 공유될 수 있다. 저장이 갈라져 있으면 공유할 때 옮길 것이 없다 |

1:1 개인 에이전트(그 사람만 실행할 수 있는 에이전트)에서는 콘솔이 개인 + 에이전트 기억을 "이 에이전트가 기억하는 것" 한 목록으로 보여도 된다. 각 줄에 범위 표시를 두고, 저장·권한·삭제는 범위대로 따로다.

**세 층의 비용.** 열쇠 칸 하나(`subject_user_id`)와 가시성 갈래 하나로 끝나지 않는다. 개인 기억이 요약·정리를 거쳐 다른 범위로 새지 않게 하는 출처 표시(taint, 4절), 개인 기억이 든 transcript의 공유 확인(2절 전제 4), 떠난 사람의 기억 삭제(9절)가 함께 든다. 그래도 합쳐 두면 같은 문제를 행 안의 칸으로 풀어야 하므로 더 비싸다. 판정은 데이터 접근 정책의 개인 연결과 같은 전제를 쓰므로 코드를 같이 쓴다.

### 에이전트 팀이 같이 쓰는 지식 (오너 질문, 2026-11-20)

> 지식베이스 같은 경우에는 에이전트끼리 공유되는 지식베이스 같은 것도 고려돼 있는 건가? 예를 들어서 어떤 프로덕트를 만든다고 했을 때 프로덕트의 엔지니어 에이전트, PM 에이전트, QA 에이전트 이런 것들이 공통의 노리지 베이스 아니면 메모리를 써야 할 때, 이때는 메모리를 쓰는 건가?

**답: 일부만 기억이다.** 에이전트 팀이 같이 쓰는 것은 성격이 다른 셋이고, 기억 저장소에 두는 것은 첫째뿐이다.

| 층 | 무엇 | 어디에 두나 | 왜 |
|---|---|---|---|
| 1. 공간 KB | 오래 가는 정리된 사실: 스펙, 결정, 용어집, 시험 정책 | 기억 저장소의 **공유 지식 공간** 범위 | 여러 실행에 걸쳐 읽히고, 사람이 채택한 본문만 써야 한다 |
| 2. 조율 상태 | 누가 무엇을 하나, 인계, 열린 질문 | 기억이 아니라 세션 팀의 공유 스레드와 계획·작업 보드 | 몇 분 단위로 바뀌고 작업이 끝나면 의미가 없다. 기억에 두면 낡은 상태가 다음 실행에 주입된다 |
| 3. 역할 기억 | 각 에이전트가 자기 역할에서 배운 것(QA 에이전트의 시험 관례 등) | 에이전트 범위 그대로 | 그 에이전트의 일에 대한 것이다 |

**공유 지식 공간.** 사람만의 "팀 범위" 대신 이 공간으로 연다. 공간은 워크스페이스 안의 이름 있는 묶음이고, 구성원은 에이전트와 사람이다.

- **구성원과 멤버십 revision.** 구성원을 더하거나 빼면 공간의 멤버십 revision이 하나 오른다. 담당 팀을 구성원으로 더하면 그때의 팀 구성원을 사람 구성원으로 펼쳐 넣는다(이후 팀 변경은 공간 관리자가 다시 맞춘다). 이것이 앞에서 미뤄 둔 "멤버십 스냅샷 계약"이다.
- **구성원 추가는 공개 결정이다.** 새 구성원(에이전트·사람)은 공간의 지금 KB 전체를 읽게 된다. 그래서 구성원 추가는 공간 관리자만 하고, receipt에 멤버십 revision과 "기존 지식 공개"를 남긴다. 빠진 구성원은 다음 판정부터 읽지 못한다.
- **읽기.** 실행에서는 세 조건을 모두 본다. (1) 세션의 에이전트가 지금 구성원이다. (2) 요청자가 사람이면 그 사람도 구성원이다(요청자 ∩ 에이전트, 5절과 같은 원칙). (3) **그 세션을 읽을 수 있는 사람 전체가 구성원이다.** 공간 기억은 transcript로 세션 독자에게 보이기 때문이다. 공유 범위가 `private`이거나, `people` 범위로 지정된 사람이 모두 구성원일 때만 맞다. `team` 범위는 팀 구성원이 공유 쓰기 없이 바뀌므로 맞지 않는다. `workspace` 범위 세션과 Slack 채널 세션도 맞지 않는다. 요청자가 `none`이어도 (1)과 (3)은 본다.
- **공간 기억을 읽은 세션.** 세션 행에 공간을 표시한다(`space_ids`). 그런 세션의 공유를 구성원 밖으로 넓히는 쓰기는 거절한다. 구성원이 빠져 (3)이 깨진 세션(빠진 사람이 소유자이거나 지정 독자인 세션)은 9절의 오염 삭제와 같이 다룬다: 진행 중인 턴을 멈추고, 공간 기억이 든 checkpoint로는 이어 가지 않으며, 새 문맥으로만 다시 시작한다. 빠진 사람이 이미 읽은 transcript는 세션 보존 기간을 따른다(9절의 삭제와 같은 한계).
- **쓰기.** 구성원 에이전트가 공간 후보를 만들고, 출처 확인(4절) 뒤 공간에 `memory.write`가 있는 사람이 채택한다. 개인 기억 taint가 있는 후보는 표시된 사람 전원의 출처 확인이 필요하고(4절), PII 검사(9절)도 같다. 공간 정리의 결과와 공간에서 워크스페이스로의 승격도 taint를 잇는다.
- **권한.** grant 대상 종류에 `space`를 더한다(`memory.read`·`memory.write`, `grants` CHECK 확장). 판정은 **멤버십 AND grant**다. grant가 있어도 구성원이 아니면 읽지 못한다. 기본값은 구성원 `memory.read`, 공간 관리자 `memory.write`. 공간 만들기·구성원 관리는 워크스페이스 관리자와 공간 관리자가 한다.
- **데이터 접근 정책.** 결과 `allow agent`가 공간 기억을 포함한다. 규칙 조건에 공간을 고르는 칸은 공간을 열 때 같이 더한다.
- **감사·삭제.** 도구 감사와 receipt에 공간 id와 멤버십 revision을 더한다. 공간을 지우면 공간 문서 전부를 tombstone하고 삭제 장부에 남긴다(9절). 공간 정리(드리밍)의 묶음은 공간 하나다.

**공간을 열 때 다른 절에 더할 것.** 공간은 아직 열지 않는다(`space_scope_unavailable`). 열 때 아래를 한 번에 더하고, 그 전에는 4–6절이 정한 그대로다.

| 절 | 더할 것 |
|---|---|
| 4절 | `memory_propose`의 대상에 `space`. 워크스페이스 승격의 원본에 활성 공간 문서 |
| 5절 범위별 권한 | 공간 행: 위 "읽기" 세 조건, 멤버십 AND grant |
| 5절 transaction 안 재판정 | 잠금 순서에서 대상 범위 주인 자리에 공간 구성원 행(`FOR SHARE`)과 공간 행의 멤버십 revision 비교. 판정 뒤 revision이 바뀌었으면 commit하지 않는다 |
| 6절 | `memory_propose`의 `target_scope`에 `space` |

## 4. 승격 흐름

```text
세션 ──후보──▶ (출처 확인) ──▶ 에이전트 / 개인 ──채택──▶ 활성
활성 개인·에이전트 문서 ──승격 요청──▶ 워크스페이스 ──승인──▶ 활성
```

**원칙.**

- 범위를 넓히는 것은 원본 행의 범위를 바꾸는 것이 아니다. **대상 범위에 새 문서**를 만들고 **승격 기록**(원본 문서·revision·본문 hash, 공개될 본문 hash, 대상 범위, 출처 확인자, 채택자, 시각)을 같은 transaction에 남긴다. 원본은 그대로 남는다.
- 채택 대상은 정확한 본문이다. 채택된 revision만 활성이 된다. 후보 본문이 바뀌면 다시 채택한다.
- 요약·번역·가림(redaction)을 거친 본문도 원본과의 계보(`derives_from`)를 남긴다.
- 후보에는 만료가 있다(기본 14일). 만료된 후보는 큐에서 빠지고 삭제 상태가 된다.

**누가 무엇을 하나.**

| 동작 | 누가 | 어디서 |
|---|---|---|
| 후보 만들기 | 모델(`memory_propose`, 대상은 `personal`·`agent`만), 또는 사람이 콘솔에서 직접 | 실행 중 도구, 콘솔 |
| 출처 확인(공개 동의) | 세션에서 나온 후보는 그 세션의 소유자. 출처 확인 전 후보는 소유자에게만 보인다 | 콘솔 |
| 채택 | 개인은 본인(`subject_user_id`), 에이전트는 그 에이전트에 `memory.write`가 있는 사람 | 콘솔 |
| 워크스페이스 승격 요청 | 원본 문서를 읽을 수 있는 사람. 원본이 개인 문서면 본인만 | 콘솔 |
| 워크스페이스 승인 | 워크스페이스에 `memory.write`가 있는 사람 | 콘솔 |
| 영속 문서 편집 | 그 범위의 채택 권한이 있는 사람. 사람이 쓴 revision은 쓴 사람이 본 그대로 활성이 된다 | 콘솔 |

- **채택·승인·편집·승격 요청은 콘솔 로그인 세션(사람 주체)에서만 받는다.** 개인 API key, 에이전트 key, worker의 relay token은 이 경로에서 거절한다. key는 사람이 그 자리에서 본문을 보았다는 증거가 아니기 때문이다. 모델은 후보만 만든다. `approved`·`origin_class`·`created_by_actor` 같은 서버 소유 칸은 모델이 정하지 못한다.
- **출처 확인을 거치는 이유.** 후보 본문, 근거(evidence), diff에는 비공개 세션의 내용이 그대로 들어 있을 수 있다. 원본을 읽을 수 있는 사람이 더 넓은 대상(에이전트 기억을 읽는 모든 사람)에게 공개해도 되는지를 먼저 정한다. 출처 확인자와 채택자가 같으면 한 번에 처리한다.
- **근거 재검사.** 채택 화면은 채택자가 읽을 수 있는 근거만 펼친다. 읽을 수 없는 근거는 "출처 비공개(확인자: 누구)"로만 표시한다. 채택 transaction은 근거 문서·세션이 아직 살아 있는지(지워지지 않았는지)와 출처 확인 뒤 본문이 바뀌지 않았는지를 다시 본다.
- **개인 정보 taint.** 개인 기억을 읽은 세션(2절 전제 4)에서 나온 요약·후보, 그것을 입력으로 쓴 정리 결과, 그 결과의 다음 승격은 `personal_subjects`를 이어받는다. taint가 있는 후보를 공유 범위(에이전트·공간·워크스페이스)에 채택하려면 표시된 사람 전원의 출처 확인이 필요하다. 후보의 명목상 출처 범위(세션, 에이전트)와 상관없이 그렇다. 개인 기억은 소유자 = 요청자 = 본인인 세션에서만 읽히므로, 보통은 세션 소유자의 출처 확인이 곧 본인 확인이다.
- **워크스페이스는 승격으로만.** 워크스페이스 문서는 활성 개인·에이전트 문서를 원본으로 한 승격 기록이 있어야 만들어진다. 도구로 워크스페이스 후보를 바로 만들 수 없다.
- 세션 → 에이전트 자동 채택(사람 없이)은 지금 하지 않는다. 필요해지면 에이전트별 설정으로, 채택 receipt에 "정책 자동"을 남기는 방식으로 연다([14절](#14-단계별-구현-계획) 나중).
- **개인 기억을 읽은 세션은 에이전트 기억에 후보로만 쓴다.** `personal_subjects`가 있는 세션(또는 그 taint를 이어받은 정리 결과)에서 나온 공유 범위 문서는 어떤 설정에서도 바로 활성이 되지 않는다. 나중에 여는 정책 자동 채택도 taint가 있는 후보에는 쓰지 않는다. 그렇지 않으면 A의 개인 기억이 승격 없이 에이전트 기억을 거쳐 B의 실행에 들어간다.

## 5. 집행 순서

읽기(`memory_search`·`memory_read`, 실행 시작 때 문맥 주입)와 쓰기(`memory_write`·`memory_propose`, 콘솔의 출처 확인·채택·편집·삭제)가 모두 같은 순서를 지난다. 어느 단계든 거절이면 그 자리에서 끝나고, 거절도 감사에 남는다.

| 단계 | 판정 | 입력을 어디서 읽나 | 거절 이유 |
|---|---|---|---|
| 0. 주체 해석 | 누가 부르는가 | 도구 호출: attempt 범위 relay token → 세션 → 실행 중 턴의 요청자. 콘솔: 로그인 사용자. API: key(읽기만, 4절) | `requester_unresolved`(개인 범위가 필요한데 확인되지 않음) |
| 1. RBAC grant | 대상에 대한 권한이 있는가 | 아래 "범위별 권한" | `memory_forbidden` |
| 2. `memoryWritePolicy` | 쓰기만. 이 턴이 들어온 입구가 영속 범위 후보를 허용하는가 | 턴의 출처 binding의 `memory_write_policy`. binding 없는 콘솔·API 턴은 `allow_explicit` | `memory_write_denied_by_surface` |
| 3. 데이터 접근 정책 | 이 요청자·에이전트·스킬 조합에 기억을 허용하는가, 개인 기억을 쓸 수 있는가 | 정책의 서버 칸에 내장 서버 이름 `memory`. 아래 "데이터 접근 정책과의 관계" | `access_policy_denied`, `personal_memory_unavailable`, `access_policy_unavailable` |
| 4. 가시성·상태 | 결과 문서 하나하나가 이 동작에 보이는가 | 아래 "동작별 거름". 제목·snippet·건수·링크에도 같은 거름 | 결과에서 빠질 뿐 오류가 아니다 |
| 5. 감사 | 모두 남긴다 | 아래 | — |

**공통 접근 판정(오너 결정 2026-11-20).** 기억, MCP, 에이전트 호출의 권한은 따로 만든 검사 셋이 아니라 identity·권한 층의 판정 모델 하나다. 기억 서비스는 자기 ACL 표를 갖지 않고, 1–3단계를 지금 판정 API(1절의 공통 판정 계약) 한 번의 호출로 묻는다. 이 절의 범위별 권한, 2절의 개인 기억 전제, `memoryWritePolicy`, 데이터 접근 정책은 모두 그 판정의 규칙이다.

| 판정 입력·결과 | 기억에서 쓰는 값 |
|---|---|
| 주체 | 요청자(사람 또는 `none`), 에이전트, 요청자의 팀 구성원 여부 |
| 자원 축 | 기억 범위(세션·개인·에이전트·워크스페이스, 나중에 공간. 오너가 말한 "개인·팀·조직"의 팀은 공간, 조직은 워크스페이스다). 같은 판정이 MCP 자격(개인 연결·에이전트 연결)과 에이전트 응답 여부도 다룬다 |
| 맥락 | 입구(비공개 세션, DM, 공개 채널), 세션 공유 범위, 요청자가 에이전트 담당 팀의 구성원인가, 출처 binding의 `memoryWritePolicy` |
| 결과 | 허용이면 쓸 수 있는 기억 범위 목록(예: 개인 제외), 거절이면 위 표의 이유. 결정마다 `decision_id`와 정책 버전을 남긴다 |

- 결과에 기억 범위 목록이 들어가야 하므로 판정 결과 계약에 그 칸을 더한다(M2). 지금의 세션 범위 목록(`effective_scopes`)과 같은 방식이다.
- 4단계(문서 하나하나의 상태·tombstone·revision 거름)는 권한이 아니라 문서 수명이므로 기억 서비스에 남는다. 서비스는 그 결과를 판정 대신 쓰지 않는다.
- transaction 안 재판정도 같은 판정 API를 다시 부르고, 판정 뒤 정책 버전이나 판정 입력의 revision이 바뀌었으면 commit하지 않는다.
- 데이터 접근 정책(아래 3단계 표)은 이 공통 모델의 규칙으로 들어간다. 기억 쪽 규칙(`memory` 서버, `allow personal`)은 그 모델 안의 기억 축으로 옮긴다.

**범위별 권한(1단계).**

| 범위 | 실행 중 도구 호출 | 콘솔·API |
|---|---|---|
| 세션 | 그 세션의 실행이면 읽기·쓰기. 다른 세션의 세션 기억은 없다 | 읽기는 `session.read`, 쓰기는 `session.submit`. `memory.*` grant와 상관없다 |
| 개인 | 2절 전제를 만족하는 요청자 본인 | 본인만. grant로 남에게 줄 수 없다 |
| 에이전트 | 에이전트 설정이 기억을 켰고, 요청자가 사람이면 그 사람이 그 에이전트에 `memory.read`(후보는 `memory.write` 없이도 만든다. 채택이 아니므로) | 그 에이전트에 `memory.read`/`memory.write` |
| 워크스페이스 | 에이전트 설정이 워크스페이스 기억 읽기를 켰고, 요청자가 사람이면 워크스페이스에 `memory.read` | 워크스페이스에 `memory.read`/`memory.write` |

- 요청자별: 콘솔 사용자와 개인 key는 그 사람의 grant로 본다(지금 정책과 같다). 에이전트 key는 그 에이전트의 안쪽으로 보고 개인 범위는 없다. `none`(루틴·webhook)은 에이전트 설정만 보고 개인 범위는 없다.
- 워크스페이스 grant는 에이전트 grant를 품지 않는다. 각 대상에 따로 준다.
- 기본 grant(역할 기본값): 워크스페이스 구성원은 워크스페이스 `memory.read`, 관리자(`owner`·`admin`)는 `memory.write`. 에이전트 안쪽(관리자, 담당 팀)은 그 에이전트 `memory.read`, 에이전트 관리자는 `memory.write`.

**`memoryWritePolicy`의 뜻(2단계).**

| 값 | 세션 범위 쓰기(`memory_write`) | 영속 범위 후보(`memory_propose`) |
|---|---|---|
| `deny`(기본) | 허용 | 거절 |
| `allow_explicit` | 허용 | 허용. 활성은 4절의 출처 확인·채택을 거친 것만. 채팅의 "기억해 줘"는 채택이 아니라 후보를 만드는 요청이다 |

Slack 채널 binding의 기본값 `deny`를 유지한다. 채널에는 여러 사람의 말과 외부에서 붙여 넣은 글이 섞이므로, 관리자가 binding마다 켜야 후보가 생긴다. 콘솔·API 턴은 요청자가 직접 인증한 입구라 `allow_explicit`로 본다.

**데이터 접근 정책과의 관계(3단계).**

| 워크스페이스 상태 | 기억 판정 |
|---|---|
| 정책을 저장한 적 없음(이행 모드) | 세션·에이전트·워크스페이스 기억 허용. **예외로** 개인 기억도 2절 전제만으로 허용한다. 이것은 개인 연결이 이행 모드에서 쓰이지 않는 것과 다르다는 점을 명시한 예외다 |
| 정책 모드, 맞는 규칙 `allow agent` | 세션·에이전트·워크스페이스 |
| 정책 모드, 맞는 규칙 `allow personal` | 여기에 개인 기억(2절 전제를 만족할 때). 불충족이면 `fallback: agent`가 있을 때만 개인을 빼고 진행, 없으면 `personal_memory_unavailable` |
| 정책 모드, 맞는 규칙 없음 또는 `deny` | 기억 도구 모두 거절 |
| 정책이 있는데 판정기를 쓸 수 없음(읽기 실패, `memory` 서버를 모르는 판정기) | 거절(`access_policy_unavailable`). 정책 없음으로 취급하지 않는다 |

데이터 접근 정책 구현이 들어올 때 `memory` 서버를 같이 넣는다. 그 전에 정책 모드에 들어간 워크스페이스가 생기면, 그 워크스페이스의 기억은 위 마지막 줄대로 거절된다.

**동작별 거름(4단계).**

| 동작 | 보이는 것 |
|---|---|
| 검색·읽기·주입 | `state = active`이고, 자기와 계보상 조상이 모두 tombstone·만료·격리가 아닌 문서 |
| 후보 큐 | 출처 확인 전: 출처 확인자에게만. 출처 확인 뒤: 대상 범위의 채택 권한자. 검색·주입에는 나오지 않는다 |
| revision 이력, `memory_read(revision)` | 문서를 읽을 수 있는 사람에게, revision마다 따로 본다. 한 번이라도 채택되어 활성이었고 그때 scanner가 `clean`이었던 revision만 보인다. 후보·격리·출처 확인 전 revision은 문서가 활성이어도 이력에 나오지 않고 위 후보 큐·격리 줄의 사람에게만 보인다. 지운 문서의 revision은 아무에게도 |
| 격리(quarantined) | 대상 범위의 채택 권한자의 검토 화면에만. 검색·주입에는 나오지 않는다. 원격 자원(이미지 등)을 자동으로 불러오지 않는다 |
| 근거 | 근거가 가리키는 세션·문서를 지금 읽을 수 있는 사람에게만 |

**transaction 안 재판정.** 쓰기(세션 쓰기, 후보, 출처 확인, 채택, 편집, 삭제)는 commit하는 transaction 안에서 1–4단계를 다시 본다. 잠금 순서는 세션 행(`FOR SHARE`) → 대상 범위 주인(에이전트·워크스페이스 구성원 행, `FOR SHARE`) → 후보 행(`FOR UPDATE`) → 원본·근거 문서(`FOR SHARE`) → 대상 문서(`FOR UPDATE`)다. 도구 호출의 쓰기는 attempt fencing(lease epoch)도 같은 transaction에서 다시 본다. 판정 뒤 grant·멤버십·binding·정책 revision이 바뀌었으면 commit하지 않는다.

**감사(5단계).**

- 도구 호출마다 지금의 도구 호출 감사 레코드([관측과 도구 호출 감사](observability-otel-and-tool-call-audit.md))에 칸을 더한다: 요청자(확인되지 않음 포함), 범위, 돌려준 문서 id와 revision, 정책 revision과 맞은 `rule_id`, 거절 이유. 본문은 남기지 않는다.
- 쓰기·출처 확인·채택·편집·삭제는 receipt를 같은 transaction에서 쓴다(`memory.write`, `memory.propose`, `memory.release`, `memory.adopt`, `memory.edit`, `memory.delete`).
- 실행 시작 때 넣은 문맥 묶음은 묶음 기록(문서 id·revision·hash, scanner 정책 버전)으로 남겨 "이 턴은 어떤 기억을 보고 돌았나"에 답한다.

## 6. MCP 도구

기억 서비스는 control-host 안에 있고, 엔진에는 내장 MCP 서버 `memory` 하나로 보인다. worker는 다른 MCP 서버처럼 relay → proxy의 `/mcp/memory`로 붙고, egress 판정이 그 요청을 control-host의 내부 기억 endpoint로 보낸다(바깥 자격은 붙이지 않는다). worker는 attempt 범위 token만 갖고 DB 자격은 없다. 서버는 요청마다 0–4단계를 다시 판정한다. 모델이 넘기는 `scopes`는 결과를 좁히는 필터일 뿐 권한 근거가 아니다.

| 도구 | 입력 | 결과 | 상한(초기) |
|---|---|---|---|
| `memory_search` | `query`, 선택 `scopes[]`, `kinds[]`, `limit`, `cursor` | 문서 id, revision, 범위, 제목, snippet, 일치 이유, stale 여부 | 결과 8개, snippet 합계 800 tokens |
| `memory_read` | `id`, 선택 `revision`, `cursor` | 본문 한 쪽, 출처, 다음 cursor | 한 쪽 2,000 tokens |
| `memory_write` | `title`, `body`, 선택 `id`+`expected_revision`(고칠 때), `idempotency_key` | 세션 범위 문서 id, revision | 문서당 32 KiB |
| `memory_propose` | `target_scope`(`personal`·`agent`만), `title`, `body`, `evidence_refs[]`, 선택 `supersedes_id`+`expected_revision`, `idempotency_key` | 후보 id. 채택되지 않았음을 결과에 적는다 | 같은 턴 후보 5개 |

- `memory_write`는 세션 범위만 쓴다. 영속 범위에 직접 쓰는 도구는 없다. 워크스페이스는 4절대로 콘솔의 승격으로만 간다.
- `evidence_refs`는 서버가 검사한다. 이 세션의 이벤트·문서가 아니거나 읽을 수 없는 참조면 거절한다.
- `idempotency_key`는 (워크스페이스, 호출 주체, 동작) 안에서 유일하다. 같은 key에 다른 입력(본문 hash가 다름)이면 `idempotency_conflict`다. 같은 key의 재요청은 저장된 결과를 돌려주기 전에 지금 권한과 tombstone을 다시 보고, 문서 id·revision만 돌려준다(본문은 다시 보내지 않는다).
- `expected_revision`이 맞지 않으면 `memory_revision_conflict`다.
- 기억 서비스가 응답하지 않으면 도구 오류만 내고 턴은 계속된다. 실행 시작 때의 문맥 주입이 실패하면 기억 없이 시작하고 그 사실을 묶음 기록에 남긴다(주입은 선택이다).
- Claude·Codex 모두 같은 relay 경로다. 엔진에 보이는 도구는 claim의 도구 목록으로 정하고, 에이전트 설정에서 기억을 끄면 claim에 `memory` 항목이 없다.

**이름 `memory` 예약.** [mcp-credentials.md](mcp-credentials.md) 결정 2의 이름 충돌 규칙에 `memory`를 `github`·`browser`처럼 예약 이름으로 더한다. 설치 카탈로그 서버와 워크스페이스 서버 등록이 이 이름을 거절한다. 구현 PR은 지금 같은 이름의 행이 있는지 두 테이블을 확인하고, 있으면 migration이 이유를 적고 멈춘다(운영자가 이름을 바꾼다). claim의 `memory` 항목은 binding `sha256(release_id, "memory")`를 갖고 내장 `github` 앞에 둔다. 기억 서버만 있는 세션도 이 binding으로 attempt token이 발급된다.

## 7. MemoryService 포트

```ts
interface MemoryService {
  search(caller: MemoryCaller, query: MemoryQuery): Promise<MemoryHits>;
  read(caller: MemoryCaller, ref: MemoryRef): Promise<MemoryPage>;
  writeSession(caller: MemoryCaller, input: SessionWrite): Promise<MemoryRevisionRef>;
  propose(caller: MemoryCaller, input: Proposal): Promise<CandidateRef>;
  release(caller: MemoryCaller, input: SourceRelease): Promise<CandidateRef>;
  adopt(caller: MemoryCaller, input: Adoption): Promise<MemoryRevisionRef>;
  promote(caller: MemoryCaller, input: Promotion): Promise<CandidateRef>;
  edit(caller: MemoryCaller, input: Edit): Promise<MemoryRevisionRef>;
  remove(caller: MemoryCaller, input: Removal): Promise<TombstoneRef>;
  revisions(caller: MemoryCaller, ref: MemoryRef): Promise<MemoryRevisionList>;
}
```

`MemoryCaller`는 0단계가 만든 값(요청자, 요청자 종류, 세션, 에이전트, 출처 binding, 정책 판정과 그 revision)이다. 포트 밖에서 만든 값을 그대로 믿지 않도록, 구현은 매 호출에서 4단계 거름을, 쓰기에서는 5절의 transaction 안 재판정을 직접 한다.

**계약 시험(모든 구현이 통과해야 하는 것).**

1. **tombstone.** 지운 문서와 그 계보상 자손은 삭제가 commit된 순간부터 검색·읽기·건수·링크·snippet·주입·후보 근거 어디에도 나오지 않는다. 색인 정리는 뒤에 해도 되지만, 거름은 commit 시점부터 조상 tombstone을 본다. 재색인·재정리·백업 복원으로 되살아나지 않는다(9절의 삭제 장부).
2. **revision CAS.** 같은 문서에 같은 `expected_revision`으로 두 편집이 오면 하나만 성공한다. 지난 revision은 바뀌지 않는다.
3. **권한 재검사.** 검색 결과는 반환 직전에 4단계 거름을 다시 지난다. 백엔드의 색인이나 캐시가 권한의 근거가 되지 않는다. 범위 권한은 언제나 공통 접근 판정(5절)이 정하고, 권한을 잃은 뒤의 호출에서 바로 빠진다. 쓰기는 transaction 안에서 다시 판정한다.
4. **멱등.** key는 (워크스페이스, 호출 주체, 동작) 범위이고, 입력이 다르면 충돌, 재요청은 재판정 뒤 참조만 돌려준다.
5. **범위 XOR와 워크스페이스 일치.** 다른 워크스페이스의 문서를 가리키는 쓰기·링크·승격은 거절된다.

**구현은 지금 Postgres 하나다.** 본문은 `text`(Markdown), revision은 불변 행, 검색은 FTS(`simple` 구성)와 `pg_trgm`부터 시작한다. 계보 조상의 tombstone 확인은 문서마다 조상 root id 목록을 두어(계보가 만들어질 때 채운다) 검색 SQL의 조건 하나로 한다. 벡터 검색은 다국어 평가에서 어휘 검색이 모자란 것이 보일 때 더한다.

**외부 백엔드(Mem0, Zep 등).** 정본이 아니라 `MemoryService` 구현의 하나로만 붙는다. 위 계약 시험 다섯을 모두 통과하고, 데이터가 워크스페이스 밖으로 나가는 것을 운영자가 승인할 때만 쓴다. 삭제가 색인에 남거나 권한을 백엔드 쪽 메타데이터로만 거르는 서비스는 쓰지 않는다.

## 8. 정리(드리밍)

드리밍을 새 기능으로 만들지 않는다. 앞선 설계의 **증분 정리**가 드리밍이다. 바꾸는 것은 결과의 모양과 예산이다.

- **입력.** 한 묶음(partition)은 범위 주인 하나다: 에이전트 하나, 개인 한 사람. 서로 다른 사람의 개인 기억이나 서로 다른 세션의 비공개 기록을 에이전트 이름으로 합치지 않는다. 지운 원본(삭제 장부에 있는 문서·세션 이벤트 범위)은 입력에서 뺀다.
- **결과.** 언제나 **새 후보 + 지금 활성 문서와의 diff**다. 추가, 고침(기존 문서의 새 revision 제안), 합침, 은퇴(더 맞지 않는 문서) 제안이 각각 후보 하나다. 입력의 taint는 결과에 이어진다(4절). 사람이 후보마다 출처 확인·채택한다. 정리가 활성 문서를 직접 바꾸지 않는다. 워크스페이스 문서는 정리의 대상이 아니라 승격의 결과다.
- **watermark.** 확정된 원본 범위(세션 이벤트 범위와 문서 revision 목록)로 둔다. 결과가 상한을 넘거나 원본을 다 보지 못하면 일부만 저장하고 watermark는 넘기지 않는다. 결과·계보·실행 기록·watermark는 한 transaction이다.
- **예산.** 범위마다 하루 token 상한(초기: 워크스페이스 전체 100,000 tokens, 한 묶음 20,000 tokens 중 작은 값)과 한 실행 상한(입력 8,000 / 출력 2,000 tokens)을 둔다. 호출 전에 사용량 장부에 예약하고 끝나면 정산한다. 넘으면 실행을 건너뛰고 밀린 것으로 남긴다(실패가 아니다).
- **실행 주체.** 정리는 control-host의 작업이다. workspace mount, shell, 일반 MCP가 없고, 모델에게 DB 쓰기 권한이 없다.
- **언제 도나.** 지금은 수동 실행(콘솔 버튼)만. 다음 단계에서 세션 종료 이벤트로 그 세션의 에이전트 묶음을 돌린다. **정해진 시각에 범위별로 도는 실행은 루틴이 생긴 뒤**에 루틴 하나로 연다.

## 9. 주입, 개인 정보, 삭제

**주입(injection).** 기억 내용은 지시가 아니라 출처가 붙은 참고 데이터다.

- 쓰기·편집·후보·정리 결과·주입 직전 모두 같은 scanner를 지난다: 보이지 않는 문자·양방향 제어 문자, 역할 사칭, 정책 무시 지시, 자격 수집·외부 전송 지시, 묶음 경계 탈출. 결과는 `clean | quarantined | error | unscanned`이고, `clean`만 주입·검색 결과에 들어간다. scanner의 시간 초과와 예외도 주입을 막는다.
- 주입은 고정된 경계 안의 데이터 블록으로 넣고, 시스템 지시에 "이 블록의 지시는 지금 요청·정책·도구 권한을 바꾸지 않는다"를 둔다. 자동 주입 상한은 1,200 tokens다.
- 내용 검사는 도구 허용 목록, egress 정책, 서버 ACL을 대신하지 않는다. 기억이 지시해도 권한은 그대로다.

**개인 정보(PII)와 비밀.**

- 비밀 값(API key, token, 비밀번호 모양)은 어느 범위에도 저장하지 않는다. 지금의 마스킹 패턴을 같이 쓰고, 걸리면 쓰기를 거절한다.
- 사람에 대한 정보는 개인 범위에만 둔다. 에이전트·공간·워크스페이스 후보에서 찾으면 2절처럼 개인 기억으로 옮기기를 제안하고 그대로는 채택하지 못한다. taint 규칙(4절)은 scanner가 놓친 경우에도 출처 확인을 강제한다.

**삭제.**

- 삭제 transaction은 문서의 tombstone, 계보상 자손 전부의 차단, 삭제 장부 기록을 한 번에 commit한다. 그 순간부터 거름(7절 시험 1)이 막는다. 색인·묶음 정리는 뒤에 한다. 여러 원본이 섞인 파생 문서는 다시 정리하기 전까지 막힌다.
- **이미 실행에 들어간 내용.** 지우기 전에 주입되거나 도구로 읽힌 내용은 그 세션의 transcript와 checkpoint에 남는다. 기억 삭제가 transcript를 고쳐 쓰지는 않는다(transcript는 세션 보존 기간을 따른다). 어느 세션이 그 문서를 보았는지는 묶음 기록과 도구 감사(돌려준 문서 id)로 찾는다. 삭제에는 두 종류가 있다.

  | 종류 | 언제 | 그 문서를 본 세션 |
  |---|---|---|
  | 일반 삭제 | 낡았거나 본인이 지움 | 다음 턴부터 주입·검색에서 빠진다. 진행 중인 턴과 이미 든 문맥은 그대로 간다 |
  | 오염 삭제 | 주입·유출·잘못된 지시가 든 기억 | 진행 중인 턴을 멈추고(지금의 interrupt), 그 문서가 든 checkpoint로는 이어 가지 않는다. 세션은 그 문서가 없는 새 문맥으로만 다시 시작한다 |

  종류는 지우는 사람이 고른다. 삭제 화면은 그 문서를 본 세션 수(진행 중인 것 따로)를 보이고, 개인 기억은 본인이, 공유 범위 기억은 그 범위의 채택 권한자가 오염 삭제를 고를 수 있다. 일반 삭제가 진행 중인 문맥을 그대로 두는 것은 고른 동작이다: 이미 모델에 보낸 내용은 되돌릴 수 없고, 낡은 사실 하나를 지울 때마다 그 문서를 본 모든 세션을 멈추면 삭제 자체를 꺼리게 된다. 계속 쓰이면 해로운 경우가 오염 삭제다.

  둘 다: (1) 그 문서를 담은 묶음 기록을 무효로 표시하고 다시 주입하지 않는다. (2) 정리는 삭제 장부의 원본 범위와, **지운 문서를 문맥에 넣었던 세션의 그 뒤 이벤트 범위**를 입력에서 빼고, 근거에 그 범위가 든 후보를 거절한다. 말을 바꿔 다시 만들어지는 길(transcript에 남은 내용의 재요약)을 계보로 막는 것이다. (3) 같은 본문 hash의 후보는 다시 만들어지지 않게 막는다. 삭제 화면은 "이미 대화에 남은 내용은 세션 보존 기간에 따라 지워진다"를 알린다.
- **삭제 장부.** 삭제는 DB 백업과 따로 보관하는 append-only 장부(문서 id, 계보 root, 원본 범위, 본문 hash, 시각)에도 쓴다. 백업에서 복원하면 기억 서비스는 장부를 다시 적용하기 전까지 모든 읽기·주입을 거절한다(`memory_restoring`). 장부 위치와 복원 절차는 [백업과 복원](../../operator/backup-restore.md)에 더한다.
- 개인 기억은 본인이 언제든 지운다. 워크스페이스를 떠나거나 비활성이 되면 그 사람의 개인 기억과 아직 채택되지 않은 개인 후보를 지운다.
- 보존 기간과 삭제 조건은 [플랫폼이 보존하는 데이터](../../operator/data-retention.md)에 행을 더한다.

## 10. 엔진 자체 기억

엔진이 스스로 쓰는 기억(Claude의 자동 기억 `MEMORY.md`, Claude API의 memory 도구와 memory store, Codex의 Memories)은 정책으로 끈다. 그 기억은 엔진 home 아래 파일이나 엔진 공급자 쪽에 쌓여 플랫폼의 ACL, tombstone, 감사, 범위 밖에 있다. 세션이 끝나면 home을 버리므로 남지 않더라도, 한 세션 안에서 승인 없는 "기억"이 생기는 것 자체를 막는다.

| 엔진 | 지금 | 할 것 |
|---|---|---|
| Claude | `settingSources: []`로 사용자 설정을 읽지 않는다. 자동 기억은 Claude Code의 기본값이 켜짐이다(공개 문서) | 엔진 환경에 자동 기억 끄기 설정을 넣고, memory 도구와 memory store를 도구 목록에 넣지 않는다 |
| Codex | Memories는 기본값이 꺼짐이다(공개 문서). override 목록에 명시는 없다 | `features.memories = false`를 override에 더한다. 고정 빌드가 그 설정을 아는지는 지금의 통합 시험(모르는 설정이면 실패)이 확인한다 |

시험: (1) 같은 세션 안에서 엔진이 기억 파일을 만들지 않는다. (2) checkpoint에서 이어 간 세션에 엔진 쪽 기억이 없다. (3) 같은 에이전트로 세션을 두 번 돌려, 첫 세션이 남긴 것이 두 번째 세션에 보이지 않는다.

## 11. 조사 요약과 시장 동향

2026-11-20에 공개 문서만 보고 조사했다. 공식 문서가 확인해 주지 않는 것은 쓰지 않았다.

**표준.**

- 에이전트 표준을 모으는 곳은 Linux Foundation 아래의 Agentic AI Foundation(AAIF)이다. MCP, AGENTS.md, goose로 시작했고([2025-12 발표](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation)), 2026-10에 Agent Skills 등 넷을 더해 열 개 프로젝트가 되었다([2026-10 발표](https://www.linuxfoundation.org/press/agentic-ai-foundation-announces-four-new-projects-agent-skills-open-responses-openenv-and-opensandbox)). **기억 프로젝트나 기억 작업 그룹은 없다**([aaif.io](https://aaif.io/)).
- W3C에 [AI Agent Memory Interoperability Community Group](https://www.w3.org/community/ai-agent-memory-interop/)이 있다(2026-06 charter). 아직 낸 명세가 없고, CG 보고서는 W3C 권고가 아니다.
- 그 밖의 "기억 표준"(OAMS, Engram, [Letta Agent File](https://github.com/letta-ai/agent-file))은 회사 하나의 초안이거나 에이전트 전체를 내보내는 형식이다.
- 결론: 2026-11 지금 엔진 사이에 채택된 기억 표준은 없다. 엔진에 기억을 전달하는 통로(MCP)와 규칙 파일(AGENTS.md), 절차의 형식(Agent Skills)은 표준이 있다.

**엔진과 제품이 기억을 다루는 방식.**

| 제품 | 저장과 범위 | 쓰기 | 삭제·개인 정보 |
|---|---|---|---|
| [Claude API memory 도구](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) | 클라이언트 쪽. `/memories` 경로를 앱이 저장소에 잇는다. 범위·색인·상한은 앱이 정한다 | 모델이 파일 명령(view, create, str_replace, insert, delete, rename)으로 직접 쓴다 | 경로 탈출 검사와 크기 상한을 앱이 한다 |
| [Claude Code](https://code.claude.com/docs/en/memory) | CLAUDE.md 계층(관리·프로젝트·사용자·로컬)과 자동 기억. 자동 기억은 git 저장소별이고 기계에만 있다. 색인 `MEMORY.md`의 앞 200줄 또는 25KB가 매 세션 들어간다 | 모델이 직접 쓴다 | 설정으로 끈다 |
| [Claude Managed Agents memory store](https://platform.claude.com/docs/en/managed-agents/memory)(beta) | 워크스페이스 범위 저장소를 세션에 붙인다(기본 read_write, read_only 선택). 기억 하나 100 kB, 저장소당 10,000개 | 모든 변경이 불변 version. `content_sha256` 선행 조건, redaction | 문서가 "주입이 성공하면 악성 내용이 저장소에 쓰이고, 다음 세션이 그것을 믿을 만한 기억으로 읽는다"고 경고한다 |
| [Claude Dreams](https://platform.claude.com/docs/en/managed-agents/dreams)(연구 미리보기) | 저장소 하나와 세션 1–100개를 입력으로 **새 저장소**를 만든다. 입력은 바꾸지 않는다 | — | — |
| [claude.ai](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context) | 개인 기억, 프로젝트마다 갈린 기억. incognito 대화는 저장하지 않는다. Team·Enterprise 소유자는 조직 단위로 켜고 끄지만 개인 기억을 읽지 못한다 | 자동 | 대화를 지워도 기억은 남는다 |
| [OpenAI Codex](https://learn.chatgpt.com/docs/customization/memories.md?surface=app) | 기계별 로컬 파일. 쉬는 대화에서 추출하고 비밀을 가린다. 외부 문맥(MCP·웹 도구) 대화를 추출에서 빼는 설정이 있다 | 자동 | 전체 초기화 |
| [OpenAI Agents SDK sandbox memory](https://openai.github.io/openai-agents-python/sandbox/memory/) | `memories/` 아래 요약(주입)·색인·`skills/` 파일. 추출 → 정리 두 단계 | 자동 | 삭제 API가 없고 오래된 것부터 버린다 |
| [ChatGPT](https://help.openai.com/en/articles/8590148-memory-in-chatgpt-faq) | 저장된 기억과 대화 기록 참조, 프로젝트 기억 | 자동 | Temporary Chat은 기억을 읽지도 쓰지도 않는다. 지운 기억은 로그에 최대 30일 남는다 |
| [Gemini CLI](https://geminicli.com/docs/cli/auto-memory.md) | `save_memory`가 `GEMINI.md`에 덧붙인다. 실험 기능 Auto Memory는 기억 고침과 SKILL.md 후보를 프로젝트별 inbox에 만든다 | **승인 전에는 적용하지 않는다** | inbox에서 버린다 |
| [Mem0](https://docs.mem0.ai/platform/features/entity-scoped-memory.md) | 범위 열쇠 `user_id`·`agent_id`·`app_id`·`run_id`(하나 이상 필수). 범위 없는 검색은 사용자 사이로 샌다고 문서가 적는다 | API | 필터 삭제, 묶음 삭제 |
| [LangGraph Store](https://docs.langchain.com/oss/python/concepts/memory.md) | namespace tuple + key. 기억 종류(semantic·episodic·procedural) | API | 저장소 삭제 |
| [MCP 참조 memory 서버](https://cdn.jsdelivr.net/npm/@modelcontextprotocol/server-memory@2026.1.26/README.md) | 로컬 JSON 지식 그래프(entity, relation, observation). 문서가 "교육용, 운영용 아님"이라 적는다 | 도구 | 삭제 도구 |

**흐름.**

- 범위는 사용자 / 에이전트 / 프로젝트·워크스페이스 / 실행·세션으로 모인다. 조직 범위는 기억이 아니라 관리 설정의 층으로 나타난다.
- 기억의 모양은 "정리된 Markdown과 작은 색인"으로 굳어 간다(Claude Code, Codex, Agents SDK, Gemini).
- 공급자 모두 "기억은 회상이지 규칙이 아니다"라고 적는다. 꼭 지켜야 할 규칙은 AGENTS.md·CLAUDE.md·스킬에 둔다.
- 쓰기를 사람이 승인하는 길(Gemini의 inbox)과 저장소 version, read_only 선택(Managed Agents)이 늘었다. 이유는 같다: 기억 오염이다.
- 정리(Dreams, Agents SDK의 정리 단계)는 원본을 고치지 않고 새 결과를 만든다.
- 기억과 스킬의 경계가 흐려진다. 추출된 절차가 SKILL.md 후보가 된다(Gemini, Agents SDK).

**기업용 에이전트 플랫폼의 흐름(2026-05–11).**

- 기본 범위는 **사용자 × 에이전트**다. 팀·조직이 같이 쓰는 기억은 드물고, 있으면 명시적인 그릇이다. 예: ChatGPT의 공유 프로젝트는 프로젝트 기억만 쓰고 구성원의 개인 기억을 보지 않는다. [Copilot Studio](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/memory-overview)는 사용자·에이전트별이고 그룹 대화와 Teams 채널에서는 꺼진다. [Letta](https://docs.letta.com/guides/core-concepts/memory/shared-memory/index.md)는 공유 블록을 붙인다.
- 쓰기는 거의 **자동 추출**이다. 공유 범위로 가기 전의 검토 큐를 둔 큰 제품은 찾지 못했다. 사용자 보기·삭제와 관리자 켜기·끄기, 비활성 기간 TTL이 통제의 전부다.
- **기억을 MCP로 내보낸다.** [Notion](https://www.notion.com/help/view-your-notion-agent-memories)은 MCP로 연결된 에이전트가 기억을 읽고 쓰게 하고, Microsoft는 [Work IQ MCP](https://mc.merill.net/message/MC1539004)로 사용자 자신의 기억 프로필을 허가된 에이전트에 읽기 전용으로 내준다(관리자 정책, 2026-11 공지). 기억이 엔진에서 떨어져 서비스가 된다.
- 권한은 **도구 호출마다 한 판정 지점**으로 모인다. AWS는 [AgentCore Memory의 기억 동작 12개를 Cedar 동작으로](https://aws.amazon.com/about-aws/whats-new/2026/08/agentcorememory-fine-grained-access-control) 판정한다(2026-08).
- "끄기는 지우기가 아니다"가 함정으로 지적된다. Copilot Studio에서 기억을 꺼도 지워지지 않는다(위 Copilot Studio 문서).

**사고와 그 뒤의 방어.**

- 기억 오염: 커넥터로 들어온 메일·파일이 ChatGPT 기억에 지시를 심고 뒤에 유출한 사례(ZombieAgent, 2026-01, [정리](https://www.akto.io/blog/memory-poisoning-ai-agents)), 숨은 지시를 단 "AI로 요약" 버튼이 비서 기억에 지속 지시를 심은 사례([Microsoft, 2026-02](https://www.microsoft.com/en-us/security/blog/2026/02/10/ai-recommendation-poisoning/)). 연구는 쓰기 한 번이면 충분하고, 내용으로 추론한 신뢰보다 출처 기반 신뢰가 강하다고 본다. OWASP의 [에이전트 앱 Top 10](https://genai.owasp.org/resource/2025-12-09/owasp-top-10-for-agentic-applications-for-2026)에 기억·문맥 오염이 있다.
- 범위 빠진 검색: 사용자 id 없이 검색하면 모든 사용자의 기억이 나오는 종류의 결함([Mem0 문서의 경고](https://docs.mem0.ai/skill.md)).
- 뒤따른 방어는 출처 추적, 믿을 수 있는 쓰기 경로와 아닌 경로의 분리, 저장소 version·감사, 기억 동작의 정책 판정이다.

## 12. 따를 것 / 다르게 갈 것

**형식과 통로.**

| 대상 | 결정 | 이유 |
|---|---|---|
| 기억의 저장 모델 | 표준이 없으므로 **우리 모델을 `MemoryService` 포트 뒤에** 둔다(2·7절). 엔진 자체 기억이나 외부 기억 서비스를 정본으로 쓰지 않는다 | 범위별 권한, tombstone, revision, 감사가 플랫폼의 계약이다. W3C CG, OAMS, Letta Agent File은 지켜보다가 명세가 나오면 내보내기·가져오기 adapter로 붙인다. 포트 안쪽은 바꾸지 않는다 |
| 엔진에 전달 | **MCP**(AAIF 표준)의 내장 서버 `memory`(6절)와 실행 시작 때의 데이터 블록 주입(9절). 둘 다 엔진 중립이다 | Claude와 Codex 모두 MCP를 읽는다. Codex에는 Claude API memory 도구 같은 것이 없다 |
| 규칙과 회상 | 기억은 회상이다. 꼭 지켜야 할 규칙은 AGENTS.md·스킬·에이전트 지시에 둔다. 기억은 정책과 도구 권한을 바꾸지 못한다(9절) | 공급자 모두 같은 선을 긋는다 |
| 절차 기억 | 반복되는 절차가 후보로 오면, 기억으로 채택하는 대신 **Agent Skills 형식의 스킬 후보**로 스킬 라이브러리에 넘기는 길을 둔다(14절 나중) | 표준 형식이 있는 것은 그 형식으로 둔다. 절차를 기억에 쌓으면 스킬의 version과 검사를 비켜 간다 |

**엔진별 adapter.**

| 엔진 | 할 일 |
|---|---|
| Claude | 자동 기억 끄기, `settingSources: []` 유지, API memory 도구와 Managed Agents memory store를 도구 목록에 넣지 않기, MCP 설정(JSON `mcpServers`)에 `memory` 넣기(10절) |
| Codex | Memories 기능과 그 생성·사용 설정 끄기(고정 빌드가 아는 키만. 모르는 키는 지금의 통합 시험이 실패로 잡는다), MCP 설정(TOML `[mcp_servers]`)에 `memory` 넣기(10절) |
| 공통 | 주입 블록의 모양은 엔진 중립 실행 계약에 두고, adapter는 그 블록을 엔진의 시스템 지시 자리에 넣기만 한다 |

**가져오는 것.**

- Managed Agents의 불변 version과 `content_sha256` 선행 조건 → 불변 revision과 `expected_revision` CAS(7절 시험 2).
- Managed Agents의 공유 저장소 read_only 선택 → 더 좁게 간다. 모델은 영속 범위에 후보만 만든다(4절).
- Dreams의 "입력을 고치지 않고 새 결과" → 정리 결과는 언제나 후보와 diff다(8절).
- Claude Code의 색인 상한, Agents SDK의 주입 요약 → 자동 주입 상한 1,200 tokens(9절).
- claude.ai incognito, ChatGPT Temporary Chat → 개인 기억은 `private` 세션에서만 쓰고, 에이전트 설정으로 기억을 끌 수 있다(2절, 오너 결정).
- claude.ai에서 조직 소유자가 개인 기억을 읽지 못하는 것 → 관리자의 남의 개인 기억 열람은 범위 밖이다.
- Gemini Auto Memory의 "승인 전 미적용" → 후보 큐(4절).
- Mem0 문서의 경고(범위 없는 검색이 샌다) → 범위 열쇠 XOR CHECK와 반환 직전 거름(2·7절). 주체 없는 기억 질의는 0단계에서 끝난다.
- 기본 범위가 사용자 × 에이전트이고 공유는 명시적인 그릇이라는 흐름 → 개인·에이전트가 기본이고, 워크스페이스와 나중의 공간은 승격과 구성원 판정으로만 채운다(2·3·4절).
- 기억을 MCP로 내보내는 흐름(Notion, Work IQ) → 내장 MCP 서버 `memory`(6절).
- 기억 동작을 정책 판정에 거는 것(AgentCore의 Cedar 동작) → 기억 동작을 공통 접근 판정의 동작으로 묻는다(5절).
- "끄기는 지우기가 아니다" 함정 → 끄기와 지우기를 나눈다. 에이전트의 기억을 끄면 실행에 쓰이지 않을 뿐 문서는 남고, 설정 화면이 그렇게 알리며 지우기(9절)로 가는 길을 같이 보인다(P8).

**다르게 가는 것.**

| 그들 | 우리 | 이유 |
|---|---|---|
| 모델이 기억을 직접 쓰고 다음 실행이 바로 쓴다(Claude Code 자동 기억, Claude API memory 도구, Managed Agents 기본 read_write, Codex, ChatGPT) | 모델은 세션 범위에만 쓴다. 영속 범위는 후보 → 출처 확인 → 사람 채택 | 여러 사람이 같이 쓰는 에이전트에서는 한 사람의 대화나 주입 공격이 다른 사람의 실행으로 번진다. Managed Agents 문서가 경고한 바로 그 길이다 |
| 파일·경로 모델(`/memories`, `/mnt/memory/<slug>/`, `MEMORY.md`) | 문서 id·revision과 MCP 도구 넷. 폴더 mount는 없다 | 문서마다 권한, tombstone, 감사를 붙여야 한다. 경로 탈출이라는 공격 종류가 아예 없다 |
| 기계·저장소별 로컬 기억(Claude Code, Codex) | control-host가 정본이고 worker에는 남지 않는다 | worker는 실행마다 버려진다. 기억이 기계에 남으면 지우거나 감사할 수 없다 |
| 외부 문맥 대화를 추출에서 뺀다(Codex) | 빼지 않는다. scanner, 출처 확인, 사람 채택으로 거른다. 근거 세션이 외부 도구(웹, MCP) 결과를 읽었으면 후보 화면이 그것을 보인다(도구 감사에서 읽는다, P8) | 외부 도구를 쓴 세션에서 나오는 일의 지식이 많다. 기억 오염 사례(11절)가 외부 입력에서 왔으므로 출처를 채택자에게 보인다. 자동 채택은 없다 |
| 공유 범위로 가기 전 검토가 없다(조사한 제품 모두) | 개인 → 에이전트·워크스페이스(나중에 공간)는 출처가 붙은 후보 → 출처 확인 → 채택으로만 간다(4절) | 시장의 기본은 사용자 × 에이전트라 한 사람의 기억이 남에게 가지 않는다. 우리 에이전트는 여러 사람이 같이 쓰고 워크스페이스 KB가 있으므로, 공유 범위에 들어간 것은 다른 사람의 실행에 들어간다. 그때 막아야 할 것이 둘이다: 한 사람의 개인 정보가 동의 없이 퍼지는 것(출처 확인과 taint), 외부 입력이 심은 지시가 모두의 기억이 되는 것(오염 사례, 11절). 연구가 말하는 출처 기반 신뢰를 사람 채택으로 구현한 것이다. 비용은 화면이므로, 1:1 개인 에이전트는 출처 확인과 채택을 한 번에 하고 세션 범위 쓰기는 검토 없이 둔다 |
| 지식 그래프(MCP 참조 서버) | 문서와 계보 링크 | 그래프가 필요한 질의가 보이지 않았다. 계보는 삭제 전파에 필요한 만큼만 둔다 |
| 조직 범위가 관리 설정으로만 있다 | 워크스페이스 범위를 승격으로만 채우는 정리된 KB로 둔다 | 오너 질문의 "개인·에이전트·조직" 세 층 |
| 지운 기억이 로그에 남거나(ChatGPT, 30일) 정리가 오래된 것을 버린다(Agents SDK) | tombstone이 commit 순간부터 막고, 삭제 장부가 복원 뒤에도 다시 적용된다(9절) | 개인 정보 삭제 요청에 답할 수 있어야 한다 |

## 13. werft 아키텍처 적용

**누가 무엇을 갖나.**

| 자리 | 맡는 것 |
|---|---|
| `packages/contracts` | 기억 계약: 범위, 상태, 문서, revision, 후보, 승격 기록, MCP 도구 입출력, 거절 이유. 판정 결과의 기억 범위 칸(5절)은 `musterrolle/authorization.ts`에 더한다 |
| `packages/platform` | `MemoryService` 포트와 영역 규칙(동작별 거름의 TS 함수, 승격·taint·삭제 규칙). 권한은 같은 패키지의 판정 정책(`musterrolle/policy.ts:454`의 `createAuthorizationPolicy`)에 기억 규칙을 더해 묻는다 |
| `packages/db` | Postgres 구현: 테이블, migration, 동작별 거름의 SQL 조건, 검색(FTS와 `pg_trgm`), 통합 시험 |
| `packages/testkit` | 계약 시험 다섯을 구현과 상관없는 묶음으로 둔다. Postgres 구현과 나중의 외부 백엔드가 같은 묶음을 돈다 |
| `apps/control-host` | 기억 서비스 조립, relay 뒤의 내부 기억 endpoint, 출처 확인·채택·편집·삭제 API, 정리 작업, 삭제 장부 재적용 |
| `apps/egress-proxy` | `/mcp/memory`를 control-host 내부 endpoint로 보낸다(6절) |
| `packages/runtime-core` | 주입 블록과 묶음 기록의 엔진 중립 계약 |
| `packages/adapters/runtimes/claude`, `codex` | 엔진 자체 기억 끄기, MCP 설정에 `memory` 넣기, 주입 블록을 엔진의 자리에 넣기 |
| `apps/web` | 후보 큐, 문서 목록·편집·삭제, 개인 기억 화면, `private` 시작 선택 |

**포트와 adapter.**

- 안쪽 포트는 둘이다: `MemoryService`(저장과 문서 거름, 7절)와 공통 접근 판정(5절). 기억 서비스는 권한을 스스로 정하지 않고 판정 포트를 부른다. 시험에서는 판정 포트를 가짜로 바꿔 끼운다.
- 바깥 adapter는 넷이다: 저장소(지금 Postgres, 나중에 외부 백엔드), 엔진(Claude, Codex), 전달(MCP 서버, 주입 블록), 나중의 내보내기·가져오기(표준이 생기면).

**데이터 모델.** 이름은 구현에서 정한다.

- 문서: 워크스페이스, 범위, 범위 열쇠 하나(CHECK XOR), 상태, 지금 revision, 조상 root 목록, `personal_subjects`, 만료.
- revision: 불변. 본문, 본문 hash, scanner 결과, 쓴 주체, 시각.
- 승격 기록: 원본과 대상, 본문 hash 둘, 출처 확인자, 채택자(4절).
- 계보 링크(`derives_from`), tombstone, 그리고 DB 밖의 append-only 삭제 장부(9절).
- 묶음 기록: 어느 세션이 주입이나 도구 결과로 어느 revision을 보았는가(9절의 "그 문서를 본 세션").
- 세션 행: `personal_subjects`, 나중에 `space_ids`.

**공통 접근 판정에 놓이는 자리.** 기억 동작은 `AuthorizationRequest`(주체: 요청자·에이전트·입구, 동작: `memory.read`·`memory.write`, 자원: `memory`와 범위)로 판정을 묻고, `AuthorizationDecision`의 기억 범위 목록만큼 검색과 쓰기를 좁힌다. 판정 기록은 지금의 판정 기록 경로에 남는다. MCP 자격 선택과 에이전트 응답 권한도 같은 판정을 쓰므로, 개인 연결과 개인 기억의 전제(요청자가 본인, 비공개 입구)는 한 규칙으로 적는다.

**고려한 대안.**

- Managed Agents memory store를 정본으로: Claude 전용이라 Codex 실행에 없다. 워크스페이스 데이터가 공급자 쪽에 쌓이고, 문서상 ZDR 대상이 아니다(자체 호스팅 제외).
- 파일 mount(경로 모델): 문서별 권한과 삭제 전파를 파일 시스템으로 지키기 어렵다.
- 기억 전용 ACL: 오너 결정으로 버렸다(5절).
- 엔진 자체 기억 수집, 외부 기억 서비스 정본: 대안 절.

## 14. 단계별 구현 계획

단계마다 티켓 하나, PR 하나나 둘이다. 단계의 "끝나는 조건"을 PR에 증거로 남긴다. M 번호는 앞선 판의 구현 단위와 같다.

| 단계 | 내용 | PR | 끝나는 조건 | 선행 |
|---|---|---|---|---|
| P1 계약·스키마(M2) | 범위 넷(`session`/`personal`/`agent`/`workspace`)과 열쇠 XOR, `subject_user_id`, 상태(`candidate`/`active`/`quarantined`/`superseded`/`deleted`), 불변 revision, tombstone, 승격 기록(출처 확인자 포함), 계보 링크와 조상 root 목록, `personal_subjects`, 세션 행의 개인 기억 표시. 동작별 거름(5절)을 TS 함수와 SQL 조건 두 형태로. 공간 범위는 `space_scope_unavailable` | 1 | CI의 DB 통합 시험에서 migration이 적용되고, XOR·상태 CHECK 위반이 거절되며, 거름의 TS와 SQL이 같은 결과를 낸다 | 이 문서 |
| P2 포트·Postgres·계약 시험(M3) | `MemoryService` 포트, Postgres 구현, 계약 시험 다섯(7절, testkit), FTS와 `pg_trgm`. 권한은 가짜 판정 포트 | 1–2 | 계약 시험 다섯이 CI의 DB 통합 시험에서 통과한다. 이 포트를 부르는 곳은 아직 없다 | P1 |
| P3 엔진 자체 기억 끄기(M5) | Claude·Codex adapter(10절, 12절) | 1 | 10절의 시험 셋이 통과한다 | 없음 |
| P4 검사와 격리(M7) | scanner 최소 집합(비밀 거절, 주입 패턴, PII를 개인 범위로 돌리기)을 포트의 모든 쓰기 경로와 주입 직전에. `quarantined` 거름 | 1 | 주입 패턴·비밀·PII 시험 문장이 각각 격리·거절·개인 범위 제안으로 가고, scanner 시간 초과도 막힌다 | P2 |
| P5 삭제 장부와 개인 기억 삭제(M8) | 삭제 장부, 복원 뒤 재적용(`memory_restoring`), 사용자 비활성·이탈 때 개인 기억과 개인 후보 삭제 | 1–2 | 복원 시험에서 재적용 전 읽기가 `memory_restoring`이고 재적용 뒤 지운 문서가 돌아오지 않는다. 비활성 시험에서 그 사람의 개인 문서와 후보가 tombstone이 된다 | P2 |
| P6 판정의 기억 축 | 공통 접근 판정에 기억 규칙과 결과의 기억 범위 칸(5절). 최소 판정기는 별도의 접근 판정 설계에서 먼저 들어온다 | 1 | 판정 시험: 공개 채널에서 개인 기억 거절, 요청자 없는 실행은 개인 기억 없음, `memoryWritePolicy: deny`면 후보 거절, 이행 모드 예외, 판정기를 쓸 수 없으면 거절. 판정마다 기록이 남는다 | P2, 최소 판정기 |
| P7 MCP 도구와 집행(M4) | 내장 서버 `memory`(이름 예약, claim 항목, token), 도구 넷, 0–5단계, transaction 안 재판정, 도구 감사 칸·receipt. 에이전트 설정은 꺼진 채로 | 1–2 | fake model 실행에서 도구 호출과 거절이 감사에 남고, 설정이 꺼진 에이전트에는 서버가 붙지 않는다 | P6 |
| P8 API와 최소 콘솔(M6) | 출처 확인·채택·승격·편집·삭제 API(콘솔 세션만), 후보 큐(본문·읽을 수 있는 근거·diff, 근거 세션이 외부 도구 결과를 읽었는지), 문서 목록·편집(CAS)·삭제, 개인 기억 화면, 1:1 개인 에이전트의 합친 목록, `private` 시작 선택, 일반·오염 삭제, 기억 끄기 화면의 "끄기는 지우기가 아니다" 안내 | 2(API, 화면) | API key와 relay token의 채택이 거절되고, 화면에서 후보 → 출처 확인 → 채택이 이어진다. 화면 기록을 PR에 남긴다 | P7 |
| P9 켜기 | 에이전트 설정의 기억 켜기를 드러낸다 | 1 | 아래 켜는 조건이 모두 들어갔다. 돌아가는 stack에서 `private` 세션에는 개인 기억이 쓰이고 `workspace` 세션에는 쓰이지 않는다 | P3, P4, P5, P8 |

**켜는 조건.** 사용자에게 기억을 드러내는 것(에이전트 설정의 기억 켜기, 실행 중 주입·도구, 개인 기억 화면)은 아래가 모두 들어간 뒤에만 연다.

- 공통 접근 판정(5절)의 최소 판정기와 판정 기록. 판정기는 별도의 접근 판정 설계를 따른다.
- 쓰기·주입 검사와 격리(M7, 9절의 `quarantined`).
- tombstone 삭제(7절 시험 1)와 삭제 장부(M8).
- 사용자가 비활성이 되거나 워크스페이스를 떠날 때 그 사람의 개인 기억과 개인 후보 삭제(9절, M8).
- 엔진 자체 기억 끄기(M5).

저장소·포트·계약 시험(M2·M3)은 먼저 들어가도 된다. M4·M6은 설정이 꺼진 채로 들어간다.

### 다음

- 세션 요약기: 끝난 턴의 요약과 기억 후보를 한 번의 모델 호출로(세션 digest와 같은 계약). taint를 잇는다.
- 실행 시작 때의 문맥 주입(1,200 tokens, 묶음 기록), 검색 순위 평가(한·일·영 골든셋).
- 정리(드리밍): 수동·세션 종료 이벤트, 후보 + diff, 범위별 예산.
- 기억 화면 확장(revision diff, 계보, 정리 실행 이력)과 순환 전체 e2e.

### 나중

- 공유 지식 공간(3절 끝): 사람만의 팀 범위를 대신한다. 워크스페이스 범위 다음에 연다. 조율 상태는 세션 팀의 스레드·작업 보드가 맡는다.
- 정해진 시각에 도는 범위별 정리(루틴 뒤).
- 세션 → 에이전트 정책 자동 채택(에이전트별 설정). taint가 있는 후보는 제외한다(4절).
- 벡터 검색, 외부 백엔드 구현, 내보내기·가져오기(기억 표준이 생기면 그 형식으로, 12절).
- 절차 기억 → 스킬 후보: 반복 절차 후보를 Agent Skills 형식의 스킬 후보로 스킬 라이브러리에 넘긴다(12절).
- 상시 실행·워크플로우가 기억을 쓰는 경로(오너 방향: 요청-응답 기반 뒤).

## 오너 결정 (2026-11-20)

- **개인 기억이 든 세션의 공유는 확인을 받는다.** 막지 않는다. 소유자 본인만 공유하고, 화면이 "개인 기억에서 가져온 내용이 함께 보인다"를 확인받는다(2절 전제 4).
- **개인 기억은 `private` 세션에서만 쓰인다.** 웹·API 세션의 기본 공유 범위(`workspace`)는 그대로 두고, 세션 시작 화면에 `private`로 시작하는 선택을 더한다(2절 전제 3, M6).
- **기억 권한은 공통 접근 판정 모델로 묻는다.** 기억만의 ACL을 만들지 않는다. 기억, MCP, 에이전트 호출은 identity·권한 층의 판정 하나를 쓴다(5절).

## 범위 밖

- 기억 폴더를 worker에 mount하는 방식, 엔진 home의 기억 파일을 플랫폼 기억으로 가져오는 일.
- 엔진 자체 기억을 켠 채 플랫폼 기억과 동기화하는 일.
- 이미 쓰인 transcript를 기억 삭제에 맞춰 고쳐 쓰는 일.
- 위키 그래프 화면, 외부 노트 도구 가져오기.
- 실시간 공동 편집.
- 교정 규칙(사람의 정정을 에이전트 규칙으로 바꾸는 것). 나중에 따로 본다.
- 관리자의 남의 개인 기억 열람. 관리자는 보안·법적 이유로 지우는 것만 하고, 그 삭제는 receipt에 남는다.

## 대안 (고르지 않음)

- **개인 = 에이전트 기억.** 3절의 다섯 이유로 버렸다. 화면에서만 합친다.
- **팀 범위를 지금 워크스페이스 공유로 대신 연다.** 공개 대상이 실제보다 넓어진다. 오너 결정(2026-11-20, "팀 범위는 workspace 먼저")대로 워크스페이스를 먼저 열고, 그 다음은 공유 지식 공간이다.
- **사람만의 팀 범위.** 에이전트 팀(엔지니어·PM·QA 에이전트)이 같이 쓰는 지식을 담지 못한다. 구성원에 에이전트를 넣는 공간으로 대신한다.
- **조율 상태(작업 배정, 인계, 열린 질문)를 공간 기억에 둔다.** 빨리 낡고, 낡은 상태가 주입된다. 세션 팀의 스레드와 작업 보드가 맡는다.
- **외부 기억 서비스를 정본으로.** 삭제·revision·권한 재검사를 우리가 증명할 수 없다. 계약 시험을 통과하는 구현으로만 붙인다.
- **엔진 자체 기억을 켜고 그 파일을 수집.** 엔진마다 형식과 수명이 다르고, 승인 없는 기억이 실행에 먼저 쓰인다.
- **모델이 영속 기억을 직접 쓰고 나중에 사람이 검토.** 검토 전에 다음 실행에 주입되므로 오염이 먼저 퍼진다. 후보 → 출처 확인 → 채택 순서를 지킨다.
- **API key로 채택.** 자동화가 자기 후보를 채택할 수 있다. 채택은 사람이 본문을 본 콘솔 세션에서만 받는다.
- **드리밍을 따로(가벼운·깊은 단계 여럿) 만든다.** 결과를 사람이 채택하는 한 단계 정리로 같은 효과를 얻고, 실행·비용 경로가 하나다.
