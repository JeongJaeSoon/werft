# 결정(설계): 에이전트 소유·회수·승계

- 상태: 설계. 오너 승인 2026-11-20. 원문: "에이전트 소유, 회수, 승계 — 이미 권한 설정과 팀 지정이 있으니까 이걸 활용하면 좋을 것 같아."
- 회수 정책 오너 수락(2026-11-20, 원문): "응 ㅇ좋아 이건 팀 개념과함게 잘 정리해야겟ㅇ네". 받은 권장안은 "소유자가 없어지면 표시하고 관리자에게 알린다. 14일 안에 승계가 없으면 새 실행을 막는다"이다.
- 팀 출처 오너 결정(2026-11-20, 원문): "idp 그룹도 팀으로쓰고 따로 지정할수도 잇게 하면되지". IdP 그룹에서 온 팀과 werft에서 직접 만든 팀을 같이 쓴다. 이 문서는 둘을 똑같이 다룬다([결정 6](#결정-6-idp-그룹에서-온-팀도-똑같이-다룬다)).
- 기준 커밋: `origin/main` `f3c650f4e`. 아래 `파일:줄`은 이 커밋 기준이다.
- 관련 결정: [에이전트 담당 팀과 액션 RBAC](agent-rbac.md). 기억 레이어 설계(검토 중인 별도 PR)의 공유 지식 공간 멤버십과는 [결정 5](#결정-5-팀-개념과-기억-설계에-맞추기)에서 맞춘다.

## 요약

| 항목 | 결론 |
|---|---|
| 소유자 | 새 칸을 만들지 않는다. 담당 팀이 에이전트를 소유하고, 그 에이전트를 관리할 수 있는 살아 있는 사람(담당 팀 `lead`, 개인 관리자, 관리자 팀 구성원)이 소유자다 |
| 소유자 없음 | 위 사람이 한 명도 없는 상태. 워크스페이스 `owner`·`admin`은 세지 않는다. 그들은 승계를 맡는 쪽이다 |
| 회수 | 상태를 표시한다. reconciler가 `agents.ownerless_since`에 처음 본 시각을 적고, 소유자가 다시 생기면 지운다. 에이전트 쪽 승계 쓰기는 같은 transaction에서 바로 지운다 |
| 실행 정책 | 표시 후 14일 동안은 그대로 돈다. 14일이 지나도 소유자가 없으면 새 세션을 `409 AGENT_NOT_RUNNABLE`(`reason_code: agent_ownerless`)로 막는다. 진행 중인 세션은 막지 않는다. 차단은 콘솔 경고가 먼저 배포된 뒤에 켠다 |
| 승계 | 새 API를 만들지 않는다. 관리자 추가, 관리자 팀 추가, 담당 팀 변경, 담당 팀 `lead` 지정 중 하나로 소유자가 생기면 승계다. 모두 이미 판정 기록(`authz_decisions`)과 receipt를 남긴다. 세션 인계는 이것과 따로다 |
| 팀 출처 | IdP 그룹에서 온 팀과 직접 만든 팀을 소유 판정에서 똑같이 다룬다. 다만 IdP 팀은 관리자 팀으로 빌려주지 않는다(기본값). 동기화가 구성원을 빼면 팀 이탈과 같고, 그룹이 사라지면 그 팀을 보관한다 |
| 알림 | 콘솔: 워크스페이스 관리자에게 에이전트 목록의 "소유자 없음" 묶음과 상세 화면의 경고(차단 날짜 포함). API: 에이전트 행의 `ownerless_since`, `GET /v1/agents?ownerless=true`, counts의 `ownerless` |

## 조사 요약과 시장 동향

조사일 2026-11-20. 대상 기간은 2026년 5–11월이고, 기준이 되는 옛 자료만 그 전 것을 썼다. 제품 문서를 먼저 봤다. 2차 자료나 검색 요약에만 있는 것은 "(확인 안 됨)"으로 적었다.

| 제품 | 소유자 | 소유자가 떠나면 | 누가 넘기나 | 주인 없는 에이전트 |
|---|---|---|---|---|
| Microsoft Copilot Studio | 소유자 한 명과 개인 공동 작성자 | 에이전트는 남고 "소유자 없음"이 된다 | 관리자만. 이전 소유자는 접근을 모두 잃는다 | 관리 센터의 "Agents without owners" 카드와 필터. 자동 조치·유예 없음 |
| Microsoft 365 Agent Builder | 동등한 소유자 여럿(개인만). 마지막 소유자는 뺄 수 없다 | 만든 사람을 지우면 소유자 없음 | 소유자 누구나 소유자 추가. 관리자는 새 소유자 지정 | 위와 같은 목록 |
| Microsoft Entra Agent ID | 기술 소유자(선택)와 sponsor(필수, 그룹 가능) | sponsor가 떠나면 그 사람의 manager에게 자동으로 넘어간다 | 소유자·sponsor·관리자. 감사 로그에 남는다 | 소유자·sponsor 목록, 위험 에이전트 보고서 |
| Salesforce Agentforce | 사람 소유자가 없다. 조직 메타데이터이고 권한 집합으로 쓴다 | 찾지 못함 | 해당 없음 | 찾지 못함 |
| Google Gemini Enterprise | 소유자 정확히 한 명 | 에이전트는 그대로 남고 관리자가 직접 지워야 한다 | 관리자만(공유된 에이전트만). 넘기면 예약·이벤트 trigger가 꺼진다 | 찾지 못함 |
| ChatGPT custom GPT | 소유자 한 명과 편집 공유 | 워크스페이스 owner에게 자동으로 넘어가고 "unassigned"로 표시된다 | 워크스페이스 owner | "unassigned" 표시 |
| ChatGPT Workspace Agents | 소유자, 편집자, 사용자 | 찾지 못함(지원팀에 문의하라고 한다, 확인 안 됨) | 소유자만(확인 안 됨) | 찾지 못함 |
| Glean Agents | 소유자 한 명(공동 소유자 모델을 없애는 중) | 그 사람의 manager에게, 없으면 Agent Moderator에게 넘어가고 메일이 간다 | 소유자, moderator, 관리자. 이전 소유자는 편집자가 된다 | 비활성 에이전트 보고서(30/60/90일 실행 0) |
| Dust | 소유자 없이 편집자 집합 | 그 사람이 만든 trigger를 영구 삭제한다. 에이전트는 남는다 | 관리자가 "편집자 되기" | 관리자의 "숨은 에이전트" 거름 |

근거:

- Copilot Studio 소유자 재지정: [Reassign ownership of orphaned agents](https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-api-reassign-ownership-orphaned-agent)(2026-09-11), [Agent actions](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-actions)(2026-09-23), [Agent registry](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-registry)(2026-11-06).
- Agent Builder 소유자: [Share and manage agents](https://learn.microsoft.com/en-us/microsoft-365-copilot/extensibility/agent-builder-share-manage-agents)(2026-11-12).
- Entra sponsor: [Owners, sponsors, and managers](https://learn.microsoft.com/en-us/entra/agent-id/agent-owners-sponsors-managers)(2026-09-03), [Manage agent identities](https://learn.microsoft.com/en-us/entra/agent-id/manage-agent-identities-admin)(2026-11-06).
- Agentforce 권한: [Agentforce permissions explained](https://www.salesforceben.com/agentforce-permissions-explained-agent-users-access-and-security/)(2026-09-11, 2차 자료).
- Gemini Enterprise: [Release notes](https://docs.cloud.google.com/gemini/enterprise/docs/release-notes)(2026-09-21 항목), [Share custom agents](https://docs.cloud.google.com/gemini/enterprise/docs/share-custom-agents)(2026-11-20 확인), [사용자 제거 시](https://support.google.com/g/answer/17571220)(2025-08, Business edition).
- ChatGPT: [User lifecycle](https://learn.chatgpt.com/docs/enterprise/user-lifecycle)(2026-11-20 확인), [Workspace agents](https://help.openai.com/en/articles/20001143-chatgpt-workspace-agents-for-enterprise-and-business)(확인 안 됨, 문서를 열지 못해 검색 요약만 봤다).
- Glean: [Sharing and permissions](https://docs.glean.com/agents/concepts/sharing-permissions)(2026-11-17).
- Dust: [Agents management](https://docs.dust.tt/docs/user-documentation/admins/agents-management)(날짜 없음).

동향:

- **책임질 사람이 한 명 이상 있어야 한다**는 쪽으로 모인다. Entra는 sponsor를 필수로 두고, Google과 Glean은 소유자를 한 명으로 강제한다. 사람 소유자가 없는 곳은 Agentforce(조직 메타데이터)와 Dust(편집자 집합)다.
- **그룹은 소유자가 아니라 쓰는 대상이다.** IdP 그룹이 에이전트를 소유하게 하는 제품은 찾지 못했다. 그룹은 사용자나 보기 권한, 많아야 편집자(Glean)다. 예외는 Entra의 그룹 sponsor인데, 이것은 편집 권한이 아니라 책임 표시다.
- 소유자가 떠날 때 셋으로 갈린다. ① 다른 사람에게 자동으로 넘긴다(manager, 워크스페이스 owner). ② 에이전트를 "소유자 없음"으로 두고 관리자가 처리한다(Microsoft, Google). ③ 딸린 자동 실행을 없앤다(Dust는 trigger 삭제, Google은 넘길 때 trigger를 끈다).
- **유예 기간이나 자동 차단을 둔 제품은 찾지 못했다.** 정리는 관리자가 직접 한다(차단, 삭제, 재지정). 도구는 소유자 없음 목록(Microsoft)이나 비활성 보고서(Glean)다.
- 문서화된 위험은 떠난 사람의 권한과 자격 증명으로 에이전트가 계속 도는 것이다. Microsoft Defender 연구는 "소유자가 떠났거나 비활성화된 에이전트"를 숨은 공격면으로 꼽고 찾는 질의를 내놓았다([2026-02-12](https://www.microsoft.com/en-us/security/blog/?p=145270)). Delinea의 2026 보고서도 배포한 사람이 떠난 뒤에도 도는 에이전트를 짚었다([Redmond, 2026-10-29](https://redmondmag.com/articles/2026/10/29/delinea-finds-widespread-ai-problems.aspx)).
- 소유를 다루는 공통 형식은 없다. MCP, Agent Skills, AGENTS.md 모두 에이전트의 소유자나 승계를 정하지 않는다.

## 따를 것 / 다르게 갈 것

소유는 공통 형식이 없는 영역이다. 그래서 werft가 자기 모델을 갖는다. 소유는 control plane의 데이터이고 엔진이 읽지 않으므로 엔진별 어댑터도 없다.

| 따를 것 | 이 설계에서 |
|---|---|
| 책임질 사람이 있다(Entra, Google, Glean) | 소유자는 그 에이전트를 관리할 수 있는 살아 있는 사람이다([결정 1](#결정-1-소유자는-담당-팀과-관리자다-새-칸을-만들지-않는다)) |
| 그룹은 소유자가 아니다(Microsoft, Google, Glean) | IdP 팀은 관리자 팀으로 빌려주지 않는다. 담당 팀이어도 관리 권한은 werft가 정한 `lead`에게만 간다([결정 6](#결정-6-idp-그룹에서-온-팀도-똑같이-다룬다)) |
| 소유자 없음 목록과 거름(Microsoft) | 에이전트 목록의 알림, `?ownerless=true`, counts의 `ownerless` |
| 넘기는 일은 관리자가 하고 기록이 남는다(Microsoft, Google) | 워크스페이스 관리자가 지금의 관리자·담당 팀 변경으로 승계하고, 판정 기록과 receipt가 남는다([결정 4](#결정-4-승계는-지금-있는-변경으로-한다)) |
| 에이전트를 자동으로 지우거나 멈추지 않는다(모두) | 상태를 바꾸지 않는다. 막는 것은 14일 뒤의 새 세션뿐이다 |
| 떠난 사람에 딸린 자동 실행을 끊는다(Dust, Google) | 비활성화가 이미 그 사람의 개인 key, 웹 세션, 연결 계정을 끊는다(`members.ts:53-104`) |

| 다르게 갈 것 | 이유 |
|---|---|
| 소유자 칸 하나 대신 담당 팀과 관리자 목록으로 판정한다 | werft에는 이미 필수 담당 팀과 관리자 목록이 있다. 칸을 두면 같은 사실을 두 번 적고, 그 사람이 떠날 때 넘기는 절차가 또 필요하다. 오너 요청도 팀이 오래 가는 소유 단위가 되는 것이다 |
| manager나 워크스페이스 owner에게 자동으로 넘기지 않는다 | werft에는 조직도(manager)가 없다. 워크스페이스 owner에게 자동으로 넘기면(ChatGPT GPT) 받은 사람이 모르는 에이전트의 관리자가 되어, "아무도 모른다"는 문제가 이름만 바뀐다. 대신 표시하고 알린다 |
| 14일 뒤 새 실행을 막는다 | 시장에 없는 동작이다. 위 위험(떠난 사람이 묶어 둔 자격 증명과 설정으로 계속 도는 것)을 관리자의 손 정리에만 맡기지 않으려는 것이고, 오너가 수락한 정책이다. 진행 중인 세션은 끊지 않고 에이전트 상태도 바꾸지 않아, 되돌리기는 관리자 한 명 지정으로 끝난다 |
| 팀(IdP 그룹 포함)을 담당 팀으로 둔다 | 그룹을 소유자로 두지 않는다는 시장 원칙은 지키되, 사람이 바뀌어도 소유 단위가 남게 한다. 팀 구성원 전원이 아니라 `lead`만 소유자다 |

## 지금 구조 (실측)

- **담당 팀은 이미 필수다.** `agents.managing_team_id`는 `NOT NULL`이다(`packages/db/src/schema.ts:3673`). 맡은 에이전트가 있는 팀은 보관하지 못한다(`packages/db/src/musterrolle/member-teams.ts:402`, `409 TEAM_MANAGES_AGENTS`).
- **관리자 판정은 한 곳이다.** `administers()`(`packages/db/src/musterrolle/administers.ts:76-120`)가 셋 중 하나를 본다. 자기 `agent_admins` 행, 살아 있는 관리자 팀의 살아 있는 구성원, 살아 있는 담당 팀의 `lead`. `isAdmin`(`packages/db/src/musterrolle/agent-authority.ts:108-134`)은 여기에 계정과 멤버십이 살아 있는지를 더한다.
- **사용자를 비활성화하면** 웹 세션, 개인 key, 연결 계정을 끊고 그 사람의 세션을 인계 대기로 만든다(`packages/db/src/musterrolle/members.ts:53-104`). `agent_admins` 행은 남는다. 관리 권한은 `isAdmin`이 살아 있는 사람만 세기 때문에 끝난다. 그래서 다시 활성화하면 관리 권한도 돌아온다.
- **팀을 보관하면** 그 팀이 빌려준 관리 권한(`agent_admin_teams` 행)을 지운다(`member-teams.ts:409`). 팀 구성원의 이탈과 `lead` 강등은 다음 요청부터 판정에 반영된다(행을 캐시하지 않는다).
- **새 세션을 막는 이유**는 지금 둘이다. `agent_inactive`, `release_unapproved`(`packages/platform/src/agents/agent-service.ts:129-145`). 세션을 쓰는 transaction 안에서 에이전트 상태를 다시 본다(`packages/db/src/postgres-unit-of-work.ts:316-324`).
- **판정 기록.** `agent.admin.manage`와 `team.manage`는 `MANAGEMENT_ROLES`에 있어 허용도 `authz_decisions`에 남는다(`packages/platform/src/musterrolle/policy.ts:425-445`). 관리자 추가·삭제와 담당 팀 변경은 receipt도 남긴다(`packages/platform/src/musterrolle/agent-admin-service.ts:89-140`, `:157-188`).
- **빠진 것.** 관리할 사람이 아무도 남지 않은 에이전트를 알아보는 곳이 없다. 담당 팀에 `lead`가 없고 관리자 팀 구성원도 없는데 개인 관리자가 퇴사하면, 그 에이전트는 워크스페이스 관리자만 고칠 수 있는데 아무도 그 사실을 모른다. 그 사이에도 에이전트는 퇴사자가 묶어 둔 자격 증명과 설정으로 계속 돈다.

## 결정 1: 소유자는 담당 팀과 관리자다. 새 칸을 만들지 않는다

- 소유자가 있다는 것은 `isAdmin`이 참인 사람이 한 명 이상이라는 뜻이다. 판정식은 `administers()`를 그대로 쓰고, 계정·멤버십이 살아 있는지를 더한다.
- 워크스페이스 `owner`·`admin`은 세지 않는다. 그들은 늘 있으므로 세면 "소유자 없음"이 생기지 않는다. 그들은 승계를 맡는다.
- 단일 소유자 칸(`owner_user_id` 같은)은 두지 않는다. 관리자 목록과 같은 것을 두 번 적게 되고, 그 사람이 떠날 때 따로 넘기는 절차가 또 필요하다. 오너 요청대로 팀이 오래 가는 소유 단위이고, 사람은 팀과 관리자 목록으로 바뀐다.

## 결정 2: 회수는 표시다

- `agents.ownerless_since timestamptz NULL`을 더한다. 소유자가 없어진 것을 처음 본 시각이다.
- reconciler pass(`apps/control-host/src/reconciler/reconcile.ts`, 기본 10초마다 `infra/compose.core.yml:550`)가 적고 지운다. 보관·삭제되지 않은 에이전트 중 소유자가 없는데 값이 비었으면 지금 시각을, 소유자가 있는데 값이 있으면 `NULL`을 쓴다. 소유자 판정은 `administers()`의 세 갈래(개인 관리자, 관리자 팀 구성원, 담당 팀 `lead`)를 모두 OR로 본다. 한 갈래가 비어도 다른 갈래에 살아 있는 사람이 있으면 소유자 없음이 아니다. pass, 세션 시작 판정, 목록 필터, counts가 모두 같은 판정식 하나를 쓴다.
- 쓰기 경로마다 적지 않는 이유: 소유자를 없애는 경로가 일곱 곳(계정 비활성화, 멤버십 비활성화, 팀 이탈, `lead` 강등, 개인 관리자 삭제, 관리자 팀 삭제·보관, `lead` 없는 팀으로 담당 팀 변경)이고 하나를 빠뜨리면 표시가 영원히 생기지 않는다. 한 질의로 전체를 다시 맞추면 빠뜨릴 곳이 없다.
- 반대 방향(지우기)은 에이전트 쪽 승계 쓰기에서도 한다. 관리자 추가, 관리자 팀 추가, 담당 팀 변경(`packages/db/src/musterrolle/agent-admins.ts`)은 쓰기 뒤 소유자가 있으면 같은 transaction에서 `ownerless_since`를 `NULL`로 만든다. 그래서 승계 직후 다음 pass 전에 소유자가 다시 빠져도 새 14일이 시작된다. `lead` 지정처럼 팀 쪽에서 일어나는 승계는 다음 pass(10초 안)에 지워진다.
- **유예는 관찰한 기간을 따른다.** 성공한 두 pass 사이에 소유자가 생겼다가 다시 빠지고, 그 사이에 에이전트 쪽 승계 쓰기도 없었다면 같은 기간으로 이어 본다. pass 간격은 보통 10초지만, pass가 오래 걸리거나 실패하거나 reconciler가 멈춘 동안에는 더 길다. 그동안 팀 쪽에서만 일어난 승계는 관찰되지 않을 수 있다. 확실히 새 기간을 시작하려면 에이전트 쪽 승계(관리자 추가, 관리자 팀 추가, 담당 팀 변경)를 쓴다. 콘솔의 승계 버튼은 모두 이쪽이다.
- `agent_admins` 행은 지우지 않는다. 지금처럼 비활성화된 사람은 판정에서 빠지고, 다시 활성화하면 돌아온다. "회수"를 행 삭제로 하면 잘못 비활성화한 계정을 되돌릴 때 관리자 목록도 다시 만들어야 한다.
- 담당 팀 필수 전에 만들어져 보관 팀(구성원 없는 팀, migration `0243_agent_managing_team_required`)에 들어간 에이전트는 개인 관리자도 관리자 팀도 없으면 첫 pass에 표시된다. 이 경우가 정확히 찾아야 할 대상이다. 그래서 차단은 경고 화면보다 늦게 켠다([단계별 구현 계획](#단계별-구현-계획)).

## 결정 3: 14일 유예 뒤 새 실행을 막는다

- 새 세션을 만들 때 두 조건이 모두 참이면 막는다. ① 지금 소유자가 없다(그 자리에서 판정한다). ② `ownerless_since`가 14일보다 오래됐다. ①을 그 자리에서 보므로, 승계하면 reconciler를 기다리지 않고 바로 다시 실행된다.
- **판정은 세션을 쓰는 transaction 안에서 한 번만 한다.** 에이전트 행을 잠그는 자리(`packages/db/src/postgres-unit-of-work.ts:316-324`, `agent_inactive`를 보는 곳)에서 ①과 ②를 함께 읽는다. 서비스가 transaction 전에 미리 계산해 넘기는 이유(`notRunnableReason`, `postgres-unit-of-work.ts:419-423`)로는 넣지 않는다. 미리 계산하면 그 사이에 승계해도 이전 판정으로 거절되기 때문이다.
- **잠그지 않는 경합은 받아들인다.** 소유자를 없애는 쓰기는 사용자·멤버십·팀 구성원·관리자 행을 바꾸고, 세션 시작은 에이전트 행만 잠근다. 마지막 관리자를 빼는 쓰기가 commit되기 전에 소유자를 읽은 시작들은 동시에 여럿이어도 모두 시작된다(에이전트 행 잠금은 공유 잠금이다). 그 뒤의 시작은 두 조건(지금 소유자 없음, 표시가 14일보다 오래됨)이 모두 참일 때만 막힌다. 차단 경계가 14일 유예의 끝이라, 그 순간의 시작들을 막으려고 소유자를 바꾸는 모든 쓰기에 잠금 순서를 더하지 않는다. 반대로 판정 직후 승계된 경우는 다시 시도하면 시작된다.
- 막는 답은 `409 AGENT_NOT_RUNNABLE`, `details.reason_code`는 `agent_ownerless`다. 웹·API·Slack·에이전트 key 모두 같다. Slack 멘션과 DM은 지금 `agent_inactive`를 알리는 것과 같은 짧은 안내를 받는다.
- 진행 중인 세션과 그 다음 턴은 이 규칙으로 막지 않는다. `agent_inactive`와 같은 범위다. 이미 시작한 일을 소유자 공백만으로 끊으면 그 결과를 받을 사람이 피해를 본다. 다만 요청자가 비활성화된 세션은 지금처럼 인계 대기(`takeoverRequiredAt`, `packages/db/src/musterrolle/members.ts:84-95`)라 다음 입력이 `awaiting_takeover`로 멈춘다. 그것은 [결정 4](#결정-4-승계는-지금-있는-변경으로-한다)의 세션 인계로 푼다.
- 14일은 `AGENT_OWNERLESS_GRACE_DAYS`로 contracts에 상수로 둔다. 워크스페이스 설정으로 열지 않는다. 다른 값을 원하는 요청이 생기면 그때 연다.

## 결정 4: 승계는 지금 있는 변경으로 한다

- 승계는 소유자를 다시 만드는 변경이다. 넷 중 하나다.
  1. 사람을 관리자로 더한다(`POST /v1/agents/{id}/admins` `{"user_id"}`).
  2. 팀을 관리자로 더한다(`{"team_id"}`, `team.manage`가 필요하다).
  3. 담당 팀을 `lead`가 있는 팀으로 바꾼다(`PUT /v1/agents/{id}/managing-team`).
  4. 담당 팀의 구성원 한 명을 `lead`로 바꾼다(`PATCH /v1/teams/{team_id}/members/{user_id}`).
- 누가 하나: 소유자가 없으면 에이전트 관리자가 없으므로 워크스페이스 `owner`·`admin`이 한다. 담당 팀 쪽 승계는 4번이다. 팀 `lead` 지정은 지금처럼 워크스페이스 관리자가 한다. 담당 팀 구성원이 스스로 소유자가 되는 경로는 만들지 않는다. 팀에 들어온 것만으로 관리 권한(자격 증명 연결, key 발급)을 가져가게 되기 때문이다.
- 판정 기록과 감사: 넷 모두 `agent.admin.manage` 또는 `team.manage` 판정이고 허용도 `authz_decisions`에 남는다. 그리고 각자의 receipt가 남는다. 승계 전용 기록 종류는 만들지 않는다. 판정 기록의 의미를 바꾸는 작업(규칙 거절을 deny로 남기기)이 따로 진행 중이라, 이 설계는 그 판정 API(`requirePermitted`)를 부르기만 하고 판정 기록 쪽 파일은 고치지 않는다.
- 콘솔은 상세 화면의 경고에서 관리자 탭으로 바로 보낸다. 거기서 1~3을 한다. 4는 팀 화면에서 한다.
- **세션 인계는 따로다.** 에이전트 승계는 비활성화된 사람이 요청자였던 세션의 인계 대기를 풀지 않는다. 세션 인계(지금의 takeover, 그 권한과 사유 요구 그대로)는 요청자를 바꿀 뿐 에이전트 관리자를 정하지 않는다. 둘은 서로 독립된 복구 단계이고 어느 순서로 해도 된다. 승계 뒤에도 남은 인계 대기 세션 수를 상세 경고에 보이는 일은 O3으로 미룬다([단계별 구현 계획](#단계별-구현-계획)). 지금 인계 목록(`GET /v1/takeovers`) 행에는 에이전트가 없어 에이전트별로 셀 수 없고, 콘솔에는 인계 화면도 없다. 그 목록을 만드는 코드는 계정 쪽에서 고치는 중이라 그 변경이 끝난 뒤 행에 `agent_id`와 거름을 더한다. 인계 목록을 읽을 권한은 그대로 두고, 그 권한이 없는 사람에게는 수를 보여 주지 않는다. 그때까지 O1의 상세 경고는 승계 방법 옆에 "요청자가 비활성화된 기존 세션은 따로 인계해야 할 수 있습니다"를 늘 같은 문구로 보인다. 특정 세션이 있는지는 드러내지 않는다. 시험은 두 순서(승계 → 인계, 인계 → 승계)를 모두 본다.

## 결정 5: 팀 개념과 기억 설계에 맞추기

| 경우 | 동작 |
|---|---|
| 팀 소유 | 담당 팀이 소유 단위다. 그 팀의 `lead`가 소유자이고 `member`는 사용자다(agent-rbac 그대로). 관리자 팀은 구성원 전원이 소유자다 |
| 팀 해체(보관) | 담당 팀은 맡은 에이전트가 있으면 보관하지 못한다(지금 그대로). 관리자 팀을 보관하면 그 팀이 빌려준 권한이 끝나고, 그 결과 다른 관리자가 남지 않은 에이전트는 다음 pass에 표시된다 |
| 팀원 이동 | 담당 팀을 떠나거나 `lead`에서 내려오면 다음 요청부터 관리 권한이 끝난다(지금 그대로). 그 결과 다른 관리자가 남지 않으면 다음 pass에 표시된다. 새 팀으로 옮긴 사람이 그 팀 에이전트의 소유자가 되는 것도 다음 요청부터다 |
| 담당 팀 변경 | `lead`가 없는 팀으로 옮기면(`agent-admins.ts:205-254`가 허용한다) 다른 관리자가 없는 한 다음 pass에 표시된다 |
| 사용자 비활성화·탈퇴 | 그 사람만 소유자였던 에이전트가 표시된다. 다시 활성화하면 표시가 지워진다 |

- **소유는 지금 시점으로 판정한다.** 기억 설계의 공유 지식 공간은 멤버십을 스냅샷(멤버십 revision)으로 고정한다. 공간에 대한 공개 결정이 그 시점의 구성원에게만 유효해야 하기 때문이다. 소유는 공개 결정이 아니라 "지금 누가 관리하나"이므로 스냅샷을 두지 않는다. 담당 팀을 공간 구성원으로 펼쳐 넣은 뒤 팀이 바뀌는 것은 공간 관리자가 다시 맞추는 일이고, 소유자 판정과는 따로다.
- **기억 쓰기 권한.** 기억 설계에서 에이전트 기억의 채택(`memory.write`)은 에이전트 관리자의 몫이다. 소유자가 없는 에이전트는 워크스페이스 관리자만 채택할 수 있다. 그래서 소유자 없음 표시는 "기억 후보를 채택할 사람도 없다"는 신호이기도 하다. 콘솔 경고 문구에 이 점을 함께 적는다(기억 기능이 열린 뒤).
- **공간 구성원인 에이전트.** 소유자가 없어도 공간 구성원에서 빼지 않는다. 빼고 다시 넣는 일은 공개 결정이 되어 공간 관리자의 승인이 필요해지므로 피한다. 14일 뒤에는 새 세션이 막히지만, 이미 열린 세션의 다음 턴은 지금처럼 공간을 읽을 수 있다. 이 설계는 공간 읽기를 따로 막지 않는다. 소유자 없는 에이전트의 공간 읽기를 끊어야 한다면 기억 설계의 읽기 판정에 조건으로 더한다(그 설계에서 정한다).

## 결정 6: IdP 그룹에서 온 팀도 똑같이 다룬다

팀은 두 출처에서 온다. werft에서 직접 만든 팀과, IdP 그룹을 동기화해 만든 팀이다. 동기화 자체는 나중에 만든다. 이 설계는 그때 바꿀 것이 없도록 지금 규칙을 정한다.

- **소유 판정은 출처를 보지 않는다.** 소유자 판정(`administers()`)과 소유자 없음 표시는 팀 행과 구성원 행만 읽는다. 동기화로 생긴 팀도 같은 `member_teams`·`member_team_members` 행이다. 출처는 팀 행의 칸(예: `source`, `external_id`)으로 남긴다. 판정식에는 넣지 않고, 아래의 쓰기 규칙에서만 읽는다.
- **`lead`는 werft가 정한다.** IdP 그룹은 구성원만 알려 준다. `lead` 지정은 출처와 상관없이 워크스페이스 관리자가 werft에서 한다. 동기화는 구성원을 더하고 빼지만 남아 있는 사람의 역할은 바꾸지 않는다. 그래서 동기화된 팀의 승계(결정 4의 4번)도 같은 방법이다.
- **IdP 팀은 관리자 팀으로 빌려주지 않는다(기본값).** 관리자 팀은 구성원 전원을 에이전트 관리자로 만든다(`administers.ts:92-115`). 지금은 팀 구성원을 바꾸는 것도, 팀을 빌려주는 것도 werft의 워크스페이스 관리자만 한다(`member-teams.ts:136-145`, `agent-admin-service.ts:100-105`). IdP 팀을 빌려주면 IdP 그룹을 관리하는 사람이 werft 밖에서 자격 증명 연결과 key 발급 권한을 나눠 주게 된다. 그래서 IdP 팀은 담당 팀과 사용 범위 팀으로만 쓰고, 관리자 팀으로 더하는 요청은 거절한다. 담당 팀으로 쓸 때 관리 권한은 werft가 정한 `lead`에게만 간다. IdP에 그 위임을 맡길지는 오너 확인 항목이다.
- **동기화가 구성원을 빼면** 팀 이탈과 같다. 그 사람이 그 팀으로만 소유자였고 다른 관리자가 없는 에이전트는 다음 pass에 표시되고, 14일 규칙을 따른다. 빠진 사람이 `lead`였다면 그 역할 행도 함께 끝난다. 동기화가 사람을 더해도 `member`로 들어오므로 관리 권한은 생기지 않는다.
- **동기화가 그룹을 지우면 그 팀을 보관한다.** 관계마다 지금의 팀 보관(`member-teams.ts:395-438`)과 같이 처리한다. 한 팀이 여러 역할을 겸해도 각 관계를 따로 정리한다.
  - 사용 범위 대상과 호출자 상한 규칙: 지금 보관처럼 지운다.
  - 관리자 팀 관계: IdP 팀은 애초에 없다(위 규칙). 직접 만든 팀은 IdP가 지우지 못한다.
  - 담당 팀 관계: 동기화는 `409 TEAM_MANAGES_AGENTS`로 거절당할 수 없다. IdP가 정본이기 때문이다. 그래서 이 경우만 맡은 에이전트가 있어도 보관한다. 에이전트는 보관된 팀을 계속 가리킨다(칸은 비울 수 없다). 보관된 팀은 `lead`도 구성원도 판정에 들어가지 않으므로(`administers.ts:48`, `:99`의 `archived_at IS NULL`), 다른 관리자가 없는 에이전트는 소유자 없음으로 표시된다. 보관된 팀은 지금처럼 구성원 추가와 새 지정을 받지 않으므로 다시 살아나지 않는다. 워크스페이스 관리자가 담당 팀을 살아 있는 팀으로 바꾸거나 개인 관리자를 지정하면 승계다. 에이전트를 몰래 다른 팀으로 옮기지 않는다.
  - 보관된 담당 팀을 가리키는 에이전트의 안쪽은 관리자와 워크스페이스 관리자뿐이다(담당 팀 구성원이 없다). 콘솔은 상세 경고에 "담당 팀이 IdP에서 사라졌습니다"를 함께 보여 준다.
- **동기화로 직접 만든 팀을 덮어쓰지 않는다.** 같은 이름의 IdP 그룹이 들어와도 출처가 다른 별개의 팀이다. 둘을 합치는 것은 워크스페이스 관리자가 담당 팀을 옮겨서 한다.
- **기록.** 동기화가 바꾼 구성원과 그룹 삭제는 동기화 receipt에 남는다(동기화를 만들 때 정한다). 소유자 없음 표시는 그 결과를 reconciler가 읽어 적으므로, 사람의 변경과 동기화의 변경이 같은 표시 경로를 지난다.

## API와 콘솔

- 에이전트 목록·상세 행: `ownerless_since`(`null` 또는 시각). 차단 시각은 그 값 + 14일이고 contracts 상수로 화면이 계산한다.
- 에이전트 행에 지금 판정한 `ownerless`(참·거짓)를 더한다. `GET /v1/agents?ownerless=true`와 counts의 `ownerless`도 표시(`ownerless_since`)가 아니라 지금 판정을 쓴다. 표시는 차단 날짜의 기준으로만 쓴다. 화면은 `ownerless`가 참인데 표시가 아직 없으면 "관리자 없음"만 보이고 날짜 자리에 "곧 정해집니다"를, `ownerless`가 거짓이면 표시가 남아 있어도 아무것도 보이지 않는다. `GET /v1/agents/counts`에 `ownerless`를 더한다. 둘 다 지금 목록과 같은 권한으로 읽는다(안쪽만 보인다). 워크스페이스 관리자는 전부 본다.
- 에이전트 목록(워크스페이스 관리자): 소유자 없는 에이전트가 있으면 위에 "관리자가 없는 에이전트 N개" 알림과 그것만 보는 필터를 둔다. 행에는 "관리자 없음" 상태 표시를 둔다.
- 에이전트 상세: 경고 "이 에이전트를 관리할 사람이 없습니다. {날짜}부터 새 실행이 막힙니다." 관리자 탭으로 가는 버튼. 차단 뒤에는 "새 실행이 막혔습니다. 관리자를 지정하면 바로 다시 실행됩니다."
- 사용자 비활성화 결과(`effects`)에 "이 사람만 관리하던 에이전트 수"를 더하는 것은 구성원 접근 쪽 작업이 끝난 뒤의 후속으로 둔다. 같은 파일을 지금 다른 작업이 고치고 있다.

## 하지 않는 것

- 단일 소유자 칸, 소유권 이전 전용 API, 승계 전용 receipt 종류.
- 소유자 없는 에이전트를 자동으로 멈추거나(`paused`) 보관하는 것. 막는 것은 새 세션뿐이고 상태는 바꾸지 않는다.
- Slack DM이나 메일 알림. 워크스페이스 관리자에게 보내는 경로가 아직 없다. 필요하면 후속으로 연다.
- 유예 기간 설정.

## werft 아키텍처 적용

아래 파일 이름은 기준 커밋에 없는 새 파일을 포함한다. O1 구현 PR이 만든 위치다.

| 층 | 맡는 것 |
|---|---|
| contracts (`packages/contracts/src/kollegium/agents.ts`) | 에이전트 행의 `ownerless`, `ownerless_since`, 상수 `AGENT_OWNERLESS_GRACE_DAYS`. O2에서 `reason_code` `agent_ownerless` |
| db: 판정식 (`packages/db/src/musterrolle/administers.ts`) | 소유자 판정식 하나. `administers()`의 세 갈래에 계정·멤버십이 살아 있는지를 더한 SQL 조각이다. reconciler, 목록 거름, counts, O2의 세션 수락이 모두 이것을 쓴다 |
| db: 표시 (`packages/db/src/musterrolle/agent-ownership.ts`) | reconciler 한 번에 표시와 해제를 한 질의로 맞춘다 |
| db: 승계 쓰기 (`packages/db/src/musterrolle/agent-admins.ts`) | 관리자 추가, 관리자 팀 추가, 담당 팀 변경 뒤 같은 transaction에서 표시를 지운다 |
| db: 읽기 (`packages/db/src/agents.ts`, `packages/core/src/queries.ts`) | 목록 거름 `ownerless`와 counts |
| db: 세션 수락 (`packages/db/src/postgres-unit-of-work.ts`, O2) | 에이전트 행을 잠그는 자리에서 지금 판정과 표시 시각을 함께 읽는다 |
| control-host (`apps/control-host/src/reconciler/reconcile.ts`) | pass마다 db의 표시 단계를 부르고, 표시한 수를 로그로 남긴다 |
| platform (`packages/platform/src/agents/agent-service.ts`) | 행 필드를 그대로 넘긴다. 새 port는 없다 |
| web (`apps/web/src/components/agent-ownerless.tsx`, `routes/agents.tsx`, `routes/agent-detail.tsx`) | 목록 알림·거름·상태 표시, 상세 경고 |

- **port와 adapter.** 소유자 판정은 SQL이 필요한 곳(목록 거름, counts, 잠금 아래 판정)에서 똑같이 써야 하므로 db 패키지의 SQL 조각으로 둔다. platform은 AgentStore port가 돌려주는 행 필드로만 본다. 엔진 어댑터와는 관계가 없다.
- **데이터 모델.** `agents.ownerless_since timestamptz NULL` 하나를 더한다. 새 표는 없다. 소유자 자체는 지금의 `agents.managing_team_id`, `agent_admins`, `agent_admin_teams`, 팀 구성원 행에서 판정한다.
- **통합 접근 판정과의 관계.** 소유자 판정은 판정(`authorize`)이 아니다. 판정이 쓰는 관리자 판정식(`administers()`)을 같이 읽는 상태다. 승계 쓰기는 지금처럼 `requirePermitted`(`agent.admin.manage`, `team.manage`)를 지나고 허용도 기록된다. O2의 차단은 정책 거절이 아니라 `agent_inactive`와 같은 실행 가능성 이유(`AGENT_NOT_RUNNABLE`)다. 그래서 판정 기록 쪽 파일은 고치지 않는다.

검토한 대안:

| 대안 | 버린 이유 |
|---|---|
| 소유자 칸과 소유권 이전 API(시장 다수) | [따를 것 / 다르게 갈 것](#따를-것--다르게-갈-것)의 첫 줄 |
| 소유자를 없애는 쓰기마다 표시하기 | 경로가 일곱 곳이고 하나를 빠뜨리면 표시가 영원히 생기지 않는다([결정 2](#결정-2-회수는-표시다)) |
| DB trigger로 표시하기 | 판정식이 여러 표를 읽는다. 계정·멤버십·팀 변경마다 영향받는 에이전트를 다시 계산해야 하고, 그 계산이 쓰기 transaction을 길게 만든다. reconciler가 이미 10초마다 돈다 |
| 다른 사람에게 자동으로 넘기기(manager, 워크스페이스 owner) | 같은 표의 둘째 줄 |
| 소유자 없는 에이전트를 자동으로 멈추거나 보관하기 | 쓰던 사람의 Slack·API 경로가 한꺼번에 끊기고, 되돌릴 때 상태 복구가 따로 필요하다. 시장도 자동 정지를 하지 않는다 |

## 단계별 구현 계획

단계마다 PR 하나다. 다음 단계는 앞 단계가 병합된 뒤 시작한다.

| 단계 | 내용 | 끝나는 조건 |
|---|---|---|
| O1 표시 | migration(`ownerless_since`), 소유자 판정식 하나, reconciler pass, 에이전트 쪽 승계 쓰기의 즉시 해제, API 필드·거름·counts, 콘솔 목록 알림·거름·상태 표시와 상세 경고(차단 예정 날짜, 승계 방법, 인계 안내 고정 문구), OpenAPI·문서. **차단은 넣지 않는다** | CI의 db integration 시험이 통과한다: 일곱 가지 제거 경로 각각 → 표시, 다른 갈래 관리자가 남으면 표시 안 됨, 승계 네 가지 → 해제, 에이전트 쪽 승계 직후 다시 제거 → 새 기간, 관찰되지 않은 팀 쪽 승계 → 같은 기간. web 시험 통과. 실제 스택에서 비활성화 → 목록 알림·상세 경고 → 승계 → 해제를 화면으로 확인하고 스크린샷을 PR에 남긴다. 교차 리뷰 지적(ACT-ON) 0 |
| O2 차단 | 세션 시작 차단(`agent_ownerless`, 세션을 쓰는 transaction 안의 단일 판정), Slack 안내, 문서 | O1이 배포된 뒤 시작한다. db 시험: 14일 경계, transaction 전 판정과 승계가 엇갈리는 경우, 마지막 관리자 제거와 동시에 들어온 시작(받아들이는 동작을 기록하는 시험), 승계 → 인계 / 인계 → 승계 두 순서. 실제 스택에서 비활성화 → 표시 → (시각 조정) 차단 → 승계 → 실행 재개. ACT-ON 0 |
| O3 인계 대기 수 | 인계 목록 행에 `agent_id`와 `?agent_id` 거름, 상세 경고의 인계 대기 세션 수와 세션 목록 링크 | 계정 쪽 판정 기록 변경이 병합된 뒤 시작한다. 인계 목록 권한이 없는 사람에게 수가 보이지 않는 시험, 두 복구 순서 시험, 실제 스택 스크린샷. ACT-ON 0 |

- 배포 순서: O1이 먼저 나가 표시와 경고가 보이게 한 뒤 O2로 차단을 켠다. O1 배포 때 이미 소유자가 없는 에이전트(보관 팀의 옛 에이전트 포함)는 첫 pass 시각이 `ownerless_since`가 되므로, O2가 같은 날 나가도 실제 차단은 그로부터 14일 뒤다. O1의 pass는 표시한 에이전트 수를 로그로 남겨, 설치마다 영향받을 에이전트 수를 차단 전에 알 수 있게 한다.
- IdP 동기화 자체는 이 단위들에 없다. 동기화를 만들 때 [결정 6](#결정-6-idp-그룹에서-온-팀도-똑같이-다룬다)의 규칙(관리자 팀 거절, 그룹 삭제 = 보관, 담당 팀이어도 보관)을 지킨다.

## 오너 확인이 필요한 것

회수 정책(표시, 14일 뒤 새 실행 차단)은 위 원문으로 수락됐다. 아래는 이 문서가 정한 기본값이다. 바뀌면 후속 PR로 고친다.

- IdP 그룹 팀을 관리자 팀으로 빌려주지 않는다. 빌려주게 하면 IdP 그룹 관리자가 에이전트 관리 권한을 나눠 주게 된다.
- 담당 팀인 IdP 그룹이 사라지면 맡은 에이전트가 있어도 그 팀을 보관한다.
- 판정 직후 마지막 관리자가 빠지는 순간의 세션 하나는 막지 않는다.
- 워크스페이스 관리자는 소유자로 세지 않는다.
- 담당 팀 구성원이 스스로 소유자가 되는 경로는 없다(워크스페이스 관리자가 `lead`를 지정한다).
- 유예는 14일 고정이다.
- 소유자가 없어져도 다른 사람(워크스페이스 owner 등)에게 자동으로 넘기지 않는다.
- 유예 뒤 새 실행 차단은 조사한 제품 어디에도 없는 동작이다. 오너가 수락한 정책이라 그대로 두되, 이 점을 기록해 둔다.
