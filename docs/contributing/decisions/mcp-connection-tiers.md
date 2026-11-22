# 결정(설계): MCP 연결을 workspace · agent · personal 세 단계로 나눈다

- 상태: 설계. 코드는 바꾸지 않는다. 구현 단위는 [10절](#10-구현-단위)에 있다.
- 기준 커밋: `origin/main` `8b15aa227`. `파일:줄`은 이 커밋에서 읽었다.
- 관련 결정: [워크스페이스 원격 MCP 서버](mcp-credentials.md), [접근 판정](access-decisions.md), [스킬과 MCP 서버](skills-and-mcp.md) 6절, [세션 저장소](session-store.md).
- 이 문서가 고치거나 대신하는 것은 [9절](#9-다른-문서에서-바뀌는-것)에 모았다. 각 문서에도 이 문서를 가리키는 줄을 넣었다.
- 티켓 번호: 저장소의 마크다운은 티켓 번호를 적지 못한다(`tests/docs-links.test.ts:324-330`). 사양, 조사, 구현 티켓의 번호는 이 문서를 들인 PR 본문에 있다.

## 요약

| 항목 | 결론 |
|---|---|
| 한 줄 | **쓸 수 있는 MCP 서버 목록**은 워크스페이스 어드민이 하나로 관리하고, **어느 계정으로 붙는지(연결)**는 workspace · agent · personal 세 단계로 나눈다 |
| 서버 목록 | 워크스페이스 서버(`workspace_mcp_servers`) 하나. 설치 카탈로그(`mcp_servers`)는 한 번에 옮기고 없앤다 |
| 연결 | 연결 행의 `subject`를 `workspace` · `agent:<id>` · `user:<id>`로 넓힌다. 비밀 값 owner_ref는 `<server>:workspace` · `<server>:agent:<id>` · `<server>:user:<id>` |
| 고르는 순서 | 에이전트가 그 서버를 켰을 때만. agent 연결 → workspace 연결 → (본인 호출이면) personal 연결 → 없으면 그 서버 도구 없이 실행 |
| personal로 넘어가는 때 | 앞 단계 연결이 없거나 끊겼을 때, 그리고 upstream이 **HTTP 401·403**으로 거절했을 때만. 같은 호출을 personal로 **한 번** 다시 보낸다 |
| 턴 안의 고정 | 서버마다 한 턴에 **한 번, 한 방향**(agent·workspace → personal)으로만 바꾼다. 바꾼 뒤 그 턴의 남은 호출도 personal이다 |
| 본인 확인 | ① 넘어가는 순간 요청자에게만 보이는 ephemeral 확인. ② personal 결과가 든 답은 본인이 동의해야만 게시 |
| 게시하지 않은 결과 | 세션 컨텍스트에서 뺀다. "보내지 않음"이면 개인 결과를 뺀 컨텍스트에서 다시 만든 답을 보낸다. 동의해 게시한 것만 스레드 컨텍스트로 남는다 |
| 누구의 personal | **그 턴을 보낸 본인** 것만. 같은 Slack 스레드의 다른 사람 턴은 계속 agent → workspace |
| 선행 작업 | egress proxy가 upstream 401·403과 challenge를 control-host에 알린다. MCP egress가 세션을 만든 사람이 아니라 턴의 요청자로 동작한다 |
| 범위 밖 | 세션 공개 범위(보류) |

## 1. 지금 있는 것

| 것 | 어디 | 이 설계에서 |
|---|---|---|
| 서버 목록 둘 | 설치 카탈로그 `mcp_servers`(설치 owner가 만들고, bearer 하나, 허용 워크스페이스 목록, 자격 출처 `stored`·`external`, `packages/db/migrations/0225_installation_settings.sql:1-16`)와 워크스페이스 서버 `workspace_mcp_servers`(`0286_workspace_mcp_servers.sql`). 카탈로그 선택은 `agent_mcp_settings`(`packages/db/src/schema.ts:3874`), 워크스페이스 서버 선택은 `agent_workspace_mcp_servers`. 세션은 둘을 따로 snapshot한다(`sessions.mcp_start`, `sessions.workspace_mcp_start`, `schema.ts:1612`, `:1617`) | 워크스페이스 서버 하나로 합친다([2절](#2-서버-목록-하나)) |
| 연결 subject | 연결 행은 `(server_id, subject)`가 열쇠이고 CHECK가 `subject = 'workspace'`만 받는다(`0286_workspace_mcp_servers.sql:16-17`). DB 코드는 subject를 상수로 둔다(`packages/db/src/musterrolle/workspace-mcp.ts:41`, `packages/db/src/sessions/workspace-mcp-egress.ts:27`). 비밀 값 owner id도 `<server>:workspace`로 고정이다(`workspace-mcp.ts:58`) | 세 단계로 넓힌다([3절](#3-연결-세-단계)) |
| egress 자격 조회 | 자격 조회 열쇠가 `(workspaceId, serverId)`뿐이다(`packages/platform/src/workers/workspace-mcp-egress.ts:130-133`). 연결 상태는 `active`인지만 본다(`:109-117`) | 판정이 고른 단계의 연결을 쓴다([4절](#4-연결을-고르는-순서)) |
| egress의 주체 | receipt와 판정의 actor가 턴의 요청자가 아니라 **세션을 만든 사람**이다(`workspace-mcp-egress.ts:211`의 `creatorOf`, 정의는 `packages/db/src/github/mcp-egress.ts:167-186`). 도구 호출 감사의 principal도 세션을 만든 사람이다(`packages/db/src/sessions/tool-call-audit.ts:245-250`) | 선행 작업 P2([8절](#8-선행-작업)) |
| 턴의 요청자 | 턴마다 요청자 종류·id, caller channel, caller limit digest를 남긴다(`schema.ts:1795-1799`). 세션은 첫 턴의 요청자와 그 caller limit을 고정한다(`schema.ts:1600-1603`). 입력마다 보낸 사람의 limit을 다시 본다(`packages/db/src/postgres-unit-of-work.ts:519`, `:819`). egress는 caller limit을 읽지 않는다(`workspace-mcp-egress.ts` 두 파일 모두 `callerLimit`을 읽지 않음) | personal을 포함한 모든 단계에 그 턴 요청자의 limit을 건다([4절](#4-연결을-고르는-순서)) |
| proxy의 401·403 | MCP 경로에서 upstream의 `www-authenticate`를 지우고 401을 403으로 바꿔 worker에 돌려준다(`apps/egress-proxy/src/credential.ts:1933-1948`). 상태와 challenge를 control-host에 알리지 않는다 | 선행 작업 P1([8절](#8-선행-작업)) |
| relay | Claude·Codex relay가 서버마다 upstream client 하나를 프로세스 안에서 다시 쓴다(`packages/adapters/runtimes/claude/src/remote-mcp.ts:65-79`, `packages/adapters/runtimes/codex/src/mcp-relay.ts:69-89`). 모든 실패를 `isError` 텍스트로 바꿔 엔진에 넘기고 재시도하지 않는다(`remote-mcp.ts:115-131`, `mcp-relay.ts:140-151`) | 단계를 바꿀 때 client를 새로 만들고, 권한 오류를 가른다([5절](#5-권한-오류와-넘어가기)) |
| receipt | `tools/call`은 upstream에 보내기 **전에** `accepted` receipt를 무작위 id로 쓴다(`workspace-mcp-egress.ts:137-155`). 거절 receipt는 결정적 id다(`:60-107`). upstream 결과는 receipt에 반영되지 않는다 | 실패 receipt와 재시도 receipt를 나눠 잇는다([7절](#7-receipt와-기록)) |
| 턴을 멈추고 묻기 | `pending_requests`가 세션·턴·attempt, 종류, 만료, 답한 사람(`answered_by`)과 그 판정, `tool_use_id`를 갖는다(`schema.ts:2432-2480`). Slack 버튼은 누른 사람을 `session.approve`로만 판정한다(`packages/adapters/chat/slack/src/slack-interactions.ts:157-162`, `:337-349`). Slack outbox는 ephemeral 게시를 이미 쓴다(`packages/adapters/chat/slack/src/outbox-delivery.ts`) | 확인 두 번에 다시 쓰되, 답할 수 있는 사람을 요청자로 좁힌다([6절](#6-본인-확인-두-번)) |
| checkpoint | 턴이 끝날 때 checkpoint revision을 commit하고, 세션 pointer가 마지막 commit을 가리킨다. resume은 pointer의 revision만 채택한다([세션 저장소](session-store.md)) | 개인 결과가 든 턴은 동의 전까지 pointer로 올리지 않는다([6절](#게시하지-않은-결과를-컨텍스트에서-빼기)) |
| 연결 끊기·탈퇴 | 탈퇴·비활성(`cutOff`, `packages/db/src/musterrolle/members.ts:57-101`)이 그 사람이 만든 워크스페이스 연결을 끊는다(`workspace-mcp.ts:327-410`의 `disconnectWorkspaceMcpOf`). transaction 안이라 외부 폐기는 하지 않는다(`:327-332` 주석) | personal 연결도 끊고, 폐기는 transaction 밖에서 한다([3절](#연결-끊기와-폐기)) |

**문서와 코드가 다른 곳 하나.** [mcp-credentials.md](mcp-credentials.md) 결정 2는 워크스페이스를 지우면 서버·연결·비밀 값이 같이 지워진다고 쓴다. 서버와 연결은 cascade다(`0286_workspace_mcp_servers.sql:43-44`). 하지만 `secret_values`의 워크스페이스 FK는 `no action`이고(`0151_secret_values.sql:19`), 워크스페이스를 지우는 경로도 아직 없다. 이 문서는 비밀 값을 서버 삭제·연결 끊기 경로에서 직접 지우는 규칙만 쓰고, 워크스페이스 삭제는 그 경로가 생길 때 정한다.

## 2. 서버 목록 하나

**결정.** 워크스페이스 어드민(`workspace.manage`)이 `workspace_mcp_servers`에 원격 MCP 서버를 등록한다. 이 목록에 없는 서버는 어느 단계에서도 연결할 수 없다. 등록 규칙(https, 자격 허용 목록에 없는 host 거절, 이름 충돌, 20개)은 [mcp-credentials.md](mcp-credentials.md) 결정 2를 그대로 쓴다. 설치 카탈로그 `mcp_servers`는 따로 두지 않는다.

**한 번에 옮긴다.** 카탈로그 행 하나를, 그 행이 허용한 워크스페이스마다 `workspace_mcp_servers` 행 하나로 만든다.

| 카탈로그 | 워크스페이스 서버 |
|---|---|
| `id` | `name`(같은 정규식, 도구 이름 `mcp__<name>__<도구>`가 바뀌지 않는다) |
| `url` | `url` |
| bearer 값(`credential_source = 'stored'`) | `auth_kind = 'bearer'`. workspace 연결 행을 `active`로 만들고 값은 `mcp_bearer_token`으로 **다시 암호화**한다(AAD가 owner와 워크스페이스를 묶어 복사할 수 없다) |
| `credential_source = 'external'` | 값이 werft 밖에 있어 옮길 수 없다. 서버 행만 만들고 연결은 `none`. 옮기기 화면에 "다시 연결 필요"로 보인다 |
| 호스트 허용 목록 밖 | 옮기지 않는다. 지금 카탈로그는 경고만 하지만 워크스페이스 서버는 거절한다. 옮기기 전에 운영자가 허용 목록을 고치거나 행을 지운다. 옮기기 명령은 이런 행이 남아 있으면 시작하지 않고 목록을 보인다 |
| `agent_mcp_settings`(서버 하나, 허용 도구) | `agent_workspace_mcp_servers` 켜기 한 행 + 에이전트 deny. 허용 목록 밖의 도구는 그 시점의 저장된 도구 목록에서 빼서 `mcp__<서버>__<도구>` deny로 바꾼다. 나중에 서버가 도구를 늘려도 다시 읽기 전에는 보이지 않으므로([mcp-credentials.md](mcp-credentials.md) 결정 5) 허용 목록의 뜻이 넓어지지 않는다 |

- **옛 세션.** 옮긴 뒤에도 `sessions.mcp_start`가 있는 진행 중 세션이 끝날 때까지 egress는 카탈로그 경로를 계속 받는다. 새 세션은 워크스페이스 서버만 snapshot한다. 카탈로그 경로를 받는 세션이 0이 된 뒤 카탈로그 테이블, `agent_mcp_settings`, claim의 카탈로그 항목, 릴리스 카드의 MCP 항목을 지운다(별도 단위 T5).
- **화면.** "워크스페이스 서버 / 설치 카탈로그" 구분을 없애고 **MCP 서버** 목록 하나와 **MCP 서버 추가** 버튼 하나를 둔다.

**버린 대안.** 카탈로그를 동결하고 새 서버만 워크스페이스 목록에 받기. 두 모델이 오래 남고, 카탈로그 경로에는 수락 receipt도 `generation`도 없어 세 단계 연결을 얹을 수 없다.

## 3. 연결 세 단계

| 단계 | `subject` | 누가 연결하나 | 언제 쓰나 |
|---|---|---|---|
| workspace | `workspace` | 워크스페이스 어드민(`workspace.manage`, 콘솔 세션) | 에이전트가 서버를 켜기만 했을 때의 기본 |
| agent | `agent:<agent id>` | 그 에이전트의 관리자(`agent.manage`, 콘솔 세션) | 그 에이전트에 연결이 있으면 workspace보다 먼저 |
| personal | `user:<user id>` | 사용자 본인(인증된 본인 + 지금 구성원, 콘솔 세션) | 본인이 부른 턴에서 agent·workspace로 안 될 때 마지막으로 |

- 세 단계 모두 OAuth(authorization code + PKCE) 또는 bearer다. 서버의 `auth_kind`가 정한다. 탐색·DCR·콜백 재검사·갱신·token 검사 규칙은 [mcp-credentials.md](mcp-credentials.md) 결정 3을 그대로 쓰고, 흐름 행과 콜백 재검사가 그 단계의 권한(위 표)을 본다.
- **비밀 값.** owner kind `workspace_mcp`, id `<server uuid>:workspace` · `<server uuid>:agent:<id>` · `<server uuid>:user:<id>`. purpose는 지금의 다섯을 그대로 쓴다. `mcp_client_secret`은 서버의 것이라 `:workspace` 쪽에만 둔다(DCR client는 서버마다 하나이고 단계가 같이 쓴다).
- **CHECK.** `subject = 'workspace' OR subject ~ '^agent:[0-9a-f-]{36}$' OR subject ~ '^user:[0-9a-f-]{36}$'`. 조회·잠금·비밀·receipt `generation` 재확인이 상수 대신 판정이 고른 subject를 쓴다.
- **누가 무엇을 보나.** 어드민과 에이전트 관리자는 남의 personal 연결을 만들거나 쓰지 못하고, 보안 대응으로 끊을 수만 있다. personal 연결의 목록은 본인에게만, 어드민에게는 "몇 명이 연결했나"와 끊기만 보인다.

### 연결 끊기와 폐기

| 때 | 무엇을 끊나 |
|---|---|
| 본인이 끊음, 어드민이 끊음 | 그 연결 하나 |
| 탈퇴·계정 비활성(`cutOff`) | 그 사람이 연결한 workspace·agent 연결(지금과 같다)과 그 사람의 personal 연결 모두 |
| 서버 삭제 | 그 서버의 모든 단계 연결 |
| 에이전트 삭제 | 그 에이전트의 agent 연결 |
| 역할이 내려감 | 끊지 않는다(지금 workspace 연결 규칙과 같다) |

끊기는 지금처럼 한 transaction에서 상태 `none`, `generation` 증가, 사용자 token 삭제다. 그 transaction이 commit된 **뒤** 인가 서버에 `revocation_endpoint`가 있으면 RFC 7009로 refresh token(없으면 access token)을 폐기한다. 그래서 transaction은 지우기 전에 폐기할 token을 읽어 둔다(지금 `revocationOf`, `workspace-mcp.ts:283-313`가 하는 것). `cutOff`는 transaction 안에서 외부 호출을 하지 않으므로(지금 주석 `:327-332`), 폐기할 token을 같은 transaction에서 `mcp_revocations` 대기 행(암호화한 token, 만료)으로 옮기고 commit 뒤 control-host가 보내고 지운다. 폐기 실패는 그 행을 만료까지 다시 시도하고, 끊기 자체는 이미 성공이다.

## 4. 연결을 고르는 순서

```text
에이전트가 그 서버를 켰나? ── 아니오 → 그 서버는 세션에 없다
        │ 예
        ▼
caller limit(그 턴 요청자의 limit)이 그 서버를 허용하나? ── 아니오 → 거절(모든 단계)
        │ 예
        ▼
agent 연결이 active → 쓴다
  없음·none·needs_reauth → workspace 연결이 active → 쓴다
    없음·none·needs_reauth → personal 단계를 쓸 수 있는 턴인가?
       예 → 그 턴 요청자의 personal 연결이 active → (확인 ①을 받고) 쓴다
       아니오 / personal 없음 → 그 서버 도구 없이 실행
```

- **personal 단계를 쓸 수 있는 턴.** 턴의 요청자가 콘솔 로그인 사용자이거나, werft 구성원에 연결된 Slack 사용자일 때뿐이다. 개인 API key, 에이전트 key, 요청자 없는 실행(일정·webhook)은 언제나 agent → workspace까지다. 요청자는 세션을 만든 사람이 아니라 **그 턴의 요청자**다(선행 작업 P2).
- **caller limit은 단계와 따로 본다.** limit은 "이 호출자가 어느 서버에 닿을 수 있나"를 정하고 어느 연결을 쓰는지와 무관하다. 에이전트에 걸린 규칙이 기준이고, personal에도 같이 걸린다. egress는 턴에 남은 caller limit digest로 그 턴의 limit을 읽는다(`schema.ts:1799`).
- **고르는 시점.** (서버, 턴)의 첫 upstream 요청에서 위 순서로 단계를 고르고 그 턴에 고정한다. 그 뒤는 5절의 넘어가기 하나만 있다.
- **접근 판정과의 관계.** 위 순서는 규칙이 아니라 고정된 기본이다. [접근 판정](access-decisions.md)의 MCP 축은 이 순서가 고른 단계를 결과 `credential`로 기록하고, 규칙(정책 모드)은 단계를 **좁히기만** 한다(예: "이 서버는 personal 금지"). 규칙이 고른 단계를 넓히거나 순서를 바꾸지는 않는다.

## 5. 권한 오류와 넘어가기

### 무엇이 권한 오류인가

upstream이 돌려준 **HTTP 401과 403만** 권한 오류다(`WWW-Authenticate`의 `error="insufficient_scope"` 포함). 도구 결과의 `isError`, JSON-RPC 오류, 본문의 "permission" 같은 말은 권한 오류가 아니다. MCP 사양이 권한 실패를 HTTP 층에서만 정하고, 도구 결과에는 표준 필드가 없기 때문이다.

- **401.** OAuth 연결이면 그 연결의 token을 한 번 갱신하고 같은 연결로 다시 보낸다. 그래도 401이면 그 연결을 `needs_reauth`로 바꾸고([mcp-credentials.md](mcp-credentials.md) LATER "upstream 401을 연결 상태에 반영"을 연다) 아래 넘어가기로 간다. bearer 연결이면 갱신 없이 넘어가기로 간다(상태는 그대로, 화면에 "최근 401" 표시).
- **403.** 연결은 그대로 두고 넘어가기로 간다.
- **타임아웃, 연결 끊김, 5xx, 결과를 모르는 실패.** 절대 다시 보내지 않는다. 지금처럼 엔진에 도구 오류로 준다.

### 넘어가기

1. proxy가 upstream 401·403을 받으면 그 상태와 challenge(`error`, `scope`)를 control-host에 알린다(선행 작업 P1). worker에는 지금처럼 `www-authenticate`를 지운 응답을 주되, 본문에 werft의 거절 코드를 싣는다.
2. control-host는 실패 receipt를 쓰고(7절), 그 턴이 personal 단계를 쓸 수 있고 요청자의 personal 연결이 `active`인지 본다. 아니면 거기서 끝이다. 원래 오류가 엔진에 간다. 그 사람에게 개인 연결이 없을 때 본인에게 안내를 보낼지는 **미정(질문 6)**.
3. 쓸 수 있으면 확인 ①이 필요한지 본다(6절). 필요하면 `pending_requests`에 확인 행을 만들고 그 id를 relay에 돌려준다. relay는 그 호출을 멈추고 답을 기다린다. 턴은 지금의 `awaiting_input`으로 멈춘다.
4. 허락이 오면 relay는 그 서버의 upstream client를 버리고 새로 만든 뒤 **같은 JSON-RPC 요청을 한 번** 다시 보낸다. 요청에는 실패 receipt id를 싣는다. egress는 그 receipt가 같은 attempt·턴·서버·도구·호출 id의 것이고, 허락이 그 턴의 요청자에게서 왔는지 확인한 뒤 (서버, 턴)의 단계를 personal로 바꾸고 재시도 receipt를 쓴다.
5. 거절이나 만료면 원래 오류를 엔진에 그대로 준다. 그 턴은 그 서버에서 다시 넘어가지 않는다.

**두 번 실행되지 않는 이유.** HTTP 401·403은 서버가 도구를 실행하기 **전에** 인가 단계에서 거절한 것이다. 그래서 다시 보내도 원래 호출은 실행되지 않았다. 도구 annotation(`readOnlyHint` 등)은 믿지 않는다. 재시도는 호출 id로 묶어 같은 호출을 한 번만 다시 보낸다. egress는 같은 실패 receipt를 가리키는 두 번째 재시도를 거절한다.

**호출 id.** relay가 엔진에서 받은 도구 호출마다 정하는 id다. 엔진이 tool-use id를 relay에 주면 그것을 쓰고, 아니면 relay가 attempt 안에서 유일한 id를 만든다. relay는 이 id를 upstream 요청의 werft 헤더로 싣고, proxy는 upstream에 보내기 전에 그 헤더를 떼어 인가 요청에 싣는다. 이 id는 묶기에만 쓰고 판정 입력이 아니다. 판정은 receipt 행과 그 턴의 실행 자격으로 한다.

### 턴 안의 고정

- 한 턴 안에서 서버마다 **agent·workspace → personal 한 방향으로 한 번만** 바꾼다. 바꾼 뒤 그 턴의 남은 호출(그 서버의 `tools/list` 포함)도 personal이다. personal에서 다시 내려가지 않고, personal이 401·403이면 그 오류가 엔진에 간다.
- 다음 턴은 다시 4절의 순서로 고른다. 확인 ①을 이미 받았다면 그 턴의 첫 요청부터 personal이 아니라, 다시 agent·workspace부터 시작하고 권한 오류에서 확인 없이 넘어간다(확인의 유효 범위는 **미정(질문 1)**).
- 고정 단위는 [스킬과 MCP 서버](skills-and-mcp.md) 6절 "전송 세션"의 (서버, 턴)이 아니라 **(서버, 턴, 단계)**다. 단계가 바뀌는 것은 그 문서의 `mcp_session_subject_changed`가 아니라 위 넘어가기 하나뿐이고, 그때 relay가 upstream client를 새로 만든다. 그 밖에 subject가 바뀌면(연결 끊김 등) 그 문서의 규칙대로 거절한다.
- **fingerprint에 subject를 넣는다.** (서버, 턴)의 전송 묶음 기록과 `call_mcp` receipt에 subject와 `generation`을 넣는다. 그래야 끊긴 턴을 이어갈 때 같은 subject로 이어가고, 다른 subject의 상태를 섞지 않는다. 세션 checkpoint의 프로필 fingerprint는 claim 항목(이름, endpoint, binding, 도구)만 담고 subject를 담지 않는다([mcp-credentials.md](mcp-credentials.md) 결정 6). subject는 턴마다 바뀌므로 거기에 넣으면 매 턴 resume이 checkpoint를 쓰지 못한다.
- worker가 죽은 턴은 지금도 자동으로 다시 돌지 않고 운영자 결정을 기다린다. 그래서 "넘어가는 도중에 죽음"도 자동으로 두 번 실행되지 않는다.

## 6. 본인 확인 두 번

목적: 개인 권한으로 읽은 데이터가 본인 확인 없이 채널이나 세션으로 나가지 않게 한다. 확인은 둘 다 **그 턴의 요청자 한 사람**만 볼 수 있고 답할 수 있다. 지금 Slack 버튼은 `session.approve`를 가진 사람이면 누구나 누를 수 있으므로(`slack-interactions.ts:337-349`), 이 두 종류는 판정에 "누른 사람이 요청 행의 요청자와 같다"를 더한다. 같지 않으면 `session.approve`가 있어도 거절이다.

### ① 사용 확인 ("개인 연결을 쓸까요")

- **언제.** 넘어가는 순간(5절 3단계). 턴을 시작할 때 미리 묻지 않는다. 권한 오류는 호출해 봐야 알기 때문이다.
- **어떻게.** Slack은 요청자에게만 보이는 ephemeral 카드(쓰기 / 쓰지 않기), 콘솔은 그 사람의 세션 화면 카드. `pending_requests` 새 종류 `personal_mcp_use`. 만료는 지금 권한 카드와 같다.
- **한 번만 묻는다.** 승인하면 계속 쓰고, 본인이 언제든 끌 수 있는 종료 수단을 둔다(오너 결정). 승인이 어디까지 유효한지는 **미정(질문 1)**, 종료 수단을 어디에 두는지는 **미정(질문 2)**.
- **콘솔 턴.** 콘솔에서 본인이 부른 턴도 이 확인을 받는지는 **미정(질문 3)**.

### ② 게시 확인 ("이 답을 보낼까요")

- personal 결과가 들어간 턴의 답은 바로 게시하지 않는다. 요청자에게만 보이는 미리보기(Slack ephemeral, 콘솔은 본인 화면)와 "보내기 / 보내지 않음"을 준다. `pending_requests` 새 종류 `personal_mcp_post`.
- **보내기.** 답을 채널(또는 세션)에 게시한다. 그 턴은 세션 컨텍스트로 남는다(아래 checkpoint 승격). 그 뒤 같은 스레드의 다른 사람 턴도 이 내용을 본다. 본인이 동의해 게시한 것이기 때문이다.
- **보내지 않음.** 개인 결과를 세션 컨텍스트에서 빼고, 뺀 컨텍스트에서 다시 만든 답을 보낸다(아래). 다시 만든 답에 "빠졌다"는 한 줄을 붙일지는 **미정(질문 5)**.
- **답하지 않음.** 처리와 기다리는 동안 같은 세션의 다른 사람 턴의 처리는 **미정(질문 4)**. 어느 쪽이든 다른 사람의 턴이 동의 전의 개인 결과를 보는 길은 없어야 한다. 그래서 동의 전의 턴은 아래처럼 세션 컨텍스트에 들어가지 않는다.
- 콘솔 턴도 이 확인을 받는지는 확인 ①과 같이 **미정(질문 3)**. 결과 표시는 Slack · 웹 모두 본인 동의가 있어야 보인다는 것은 오너 결정이다.

### 게시하지 않은 결과를 컨텍스트에서 빼기

checkpoint는 턴이 끝날 때 commit되고 세션 pointer가 그것을 가리킨다([세션 저장소](session-store.md)). 이것을 그대로 쓴다.

1. personal로 넘어간 턴(이하 "개인 턴")이 끝나면 worker는 checkpoint revision을 만들되 세션 pointer로 **올리지 않는다**. 세션 행에 "보류 revision"과 그 게시 확인 요청 id를 둔다. 보류가 있는 동안 그 세션의 다음 턴은 시작하지 않는다(다른 사람 턴의 처리는 질문 4).
2. **보내기**면 보류 revision을 pointer로 올리고 답을 게시한다. 한 transaction이다.
3. **보내지 않음**이면 보류 revision을 버린다(pointer는 개인 턴 앞의 revision에 남는다). 그리고 같은 턴 입력으로 **다시 만들기 턴**을 돌린다.
   - 다시 만들기 턴은 개인 턴 앞의 checkpoint에서 시작하고, personal 단계를 쓰지 않는다.
   - **도구를 다시 부르지 않는다.** 개인 턴에서 이미 실행된 쓰기를 두 번 실행하지 않기 위해 모든 도구 호출을 거절한다.
   - 대신 플랫폼이 만든 문단 하나를 입력에 붙인다. 개인 턴에서 **넘어가기 전에** 끝난 도구 호출(그 결과는 개인 데이터를 보지 않았다)의 이름과 결과, 넘어간 **뒤**의 호출은 서버·도구 이름만("실행됨, 결과 제외"). 넘어간 뒤 호출의 인자와 결과는 개인 결과를 담을 수 있으므로 싣지 않는다.
   - 다시 만든 답을 보내고 그 턴의 checkpoint를 pointer로 올린다. 다시 만들기가 실패하면 아무것도 게시하지 않고 본인에게만 알린다.
4. 세션 이벤트와 transcript mirror에도 개인 턴의 본문을 남기지 않는다. 개인 턴의 이벤트는 보류 revision과 같이 묶여, 보내기면 공개되고 보내지 않음이면 지운다. receipt와 `authz_decisions`에는 본문이 원래 없다(도구 이름, 단계, 상태만).

**개인 턴에서 나가는 다른 길.**

- 다른 에이전트에 위임: 개인 턴에서는 거절한다([접근 판정](access-decisions.md) 13절 2의 추천과 같다).
- 기억 쓰기: 기억은 아직 열리지 않았다. 열릴 때 개인 턴의 기억 후보는 보류 revision과 함께 묶여, 보내지 않음이면 버린다.
- 같은 턴의 다른 서버 호출(개인 연결이 아닌 MCP, GitHub 쓰기·push)이 개인 결과를 인자에 싣는 경우는 게시 확인으로 되돌릴 수 없다. 이것을 막을지, 기록만 할지, 호출마다 물을지는 **미정(질문 7)**.

## 7. receipt와 기록

실패한 호출과 다시 보낸 호출은 **receipt를 따로** 쓰고 서로를 가리킨다.

| receipt | 상태 | 담는 것 |
|---|---|---|
| 실패 | `failed` | 단계(`agent`·`workspace`), 그 연결의 subject·`generation`, upstream 상태(401·403), challenge의 `error`·`scope`, 호출 id, 재시도 receipt id(재시도가 생기면 나중에 이어 쓰는 칸 대신 재시도 쪽이 가리킨다) |
| 재시도 | `accepted` | 단계 `personal`, werft 사용자 id, `generation`, 실패 receipt id, 확인 ① 요청 id(허락한 사람과 시각), 호출 id |

- 모든 `call_mcp` receipt에 단계(`workspace`·`agent`·`personal`), subject, `generation`, 그 턴의 요청자(actor)를 남긴다. actor는 세션을 만든 사람이 아니라 턴의 요청자다(선행 작업 P2). personal의 subject는 werft 사용자 id이고 외부 계정 식별자는 남기지 않는다.
- 게시 확인 ②의 답(보내기·보내지 않음, 다시 만들기 성공 여부)은 그 요청 행과 receipt로 남는다.
- [접근 판정](access-decisions.md)의 `authz_decisions`가 생기면 그 `granted.credential`에 같은 단계·subject·`generation`·`fallback`(넘어갔는지)을 남기고, `tool_call_audits.access_decision_id`가 그것을 가리킨다. 이 문서의 receipt 규칙은 그것을 기다리지 않는다.

## 8. 선행 작업

세 단계와 넘어가기 앞에 둘이 먼저 있어야 한다. 둘은 서로 닿지 않는 경로라 같이 진행할 수 있다.

**P1. proxy가 upstream 401·403과 challenge를 control-host에 알린다.** 지금 proxy는 MCP 경로의 401을 403으로 바꾸고 `www-authenticate`를 지운 채 worker에만 돌려준다(`credential.ts:1933-1948`). control-host 판정은 upstream 호출 전에 끝나서 upstream이 무엇을 답했는지 모른다.

- proxy는 MCP 경로에서 upstream이 401·403을 주면, worker에 답하기 **전에** control-host의 인가 API에 보고한다: grant의 판정 id, 상태, `WWW-Authenticate`를 파싱한 `error`·`scope`(값의 길이 상한, 다른 파라미터는 버림), 호출 id. 지금 ledger 보고(`credential.ts:1387-1400`)와 같은 인증으로 보낸다.
- control-host는 실패 receipt를 쓰고 5절의 다음 걸음(확인 요청 id 또는 "넘어가지 않음")을 답한다. proxy는 그 답을 werft 거절 코드와 함께 worker 응답 본문에 싣는다. `www-authenticate`는 지금처럼 지운다(엔진이 스스로 OAuth를 시작하지 않게).
- 보고에 실패하면(control-host 불통) 넘어가기 없이 지금 동작(403)으로 답한다. 닫힌 쪽이다.
- 401→403 바꾸기는 남긴다. worker가 받는 것은 werft의 거절이고 upstream의 인증 요구가 아니기 때문이다.

**P2. MCP egress가 세션을 만든 사람이 아니라 턴의 요청자로 동작한다.** 지금 egress의 actor와 도구 호출 감사의 principal은 세션을 만든 사람이다(`workspace-mcp-egress.ts:211`, `tool-call-audit.ts:245-250`). 같은 Slack 스레드에서 B가 보낸 턴의 호출이 A의 이름으로 남는다.

- egress 상태 읽기가 실행 중 턴의 `requester_kind`·`requester_id`·`actor_id`·caller limit digest를 읽고(`schema.ts:1782-1799`), receipt actor와 감사 principal을 그것으로 쓴다. 카탈로그 경로와 내장 `github` 경로의 `creatorOf`(`mcp-egress.ts:221`, `:304`)도 같이 바꾼다.
- 턴이 없는 요청(첫 턴 전)은 actor를 세션을 만든 사람으로 두되 personal 단계를 쓰지 않는다. 첫 턴 전 요청을 upstream에 보내지 않는 일은 [스킬과 MCP 서버](skills-and-mcp.md) S11의 것이다.
- 기록되는 값이 바뀌므로 릴리스 노트에 적는다([접근 판정](access-decisions.md) 10절과 같다). 요청자의 인증 근거를 다시 확인하는 일(key 폐기 등)은 그 문서의 A2이고, 이 단계는 지금 턴에 남는 요청자 칸을 쓴다.

## 9. 다른 문서에서 바뀌는 것

| 문서 | 무엇이 바뀌나 |
|---|---|
| [mcp-credentials.md](mcp-credentials.md) | 결정 1(자격 주체는 워크스페이스 하나, `subject = 'workspace'`만): 세 단계로 대신한다(3절). 결정 2와 "지금 있는 것"의 "설치 카탈로그는 그대로 둔다": 한 번에 옮기고 없앤다(2절). 결정 6의 카탈로그 선택 유지·claim 순서·상한 `2 + 8`: 카탈로그를 지운 뒤 워크스페이스 서버와 `github`만 남는다. 결정 6의 "proxy는 바꾸지 않는다": P1로 바뀐다. LATER의 "에이전트별 외부 계정", "요청자 본인의 계정", "upstream 401을 연결 상태에 반영": 이 문서가 연다. 결정 2의 "지우면 비밀 값이 같이 지워진다": 1절의 다른 곳 |
| [access-decisions.md](access-decisions.md) | 2절 결과의 MCP `credential` 종류: `agent`(= 워크스페이스 연결)·`personal` 둘에서 `workspace`·`agent`·`personal` 셋으로. 2절 "개인 기억·개인 연결의 전제"와 **B1**: 개인 **연결**에는 ②세션 소유자, ③공유 범위 `private`, ④표시 commit을 걸지 않는다. 대신 그 턴의 요청자 본인, 확인 두 번, 게시하지 않은 결과를 컨텍스트에서 빼기(6절)가 전제다. 개인 **기억**의 전제와 B1은 그대로다. 4절 이행 모드의 "개인 연결은 쓰지 않는다": 이행 모드도 4절의 순서를 쓴다. **B5**(개인 MCP 연결): 이 문서의 단위 T6–T11로 대신한다 |
| [skills-and-mcp.md](skills-and-mcp.md) 6절 | "개인 연결의 전제": 위 B1 대신 이 문서 6절. "전송 세션"과 **S12**: 고정 단위가 (서버, 턴)에서 (서버, 턴, 단계)로, 넘어가기 한 번은 `mcp_session_subject_changed`가 아니다(5절). S12의 나머지(`Mcp-Session-Id` 묶음, 2026-07-28 개정, 목록 캐시 분리)는 그대로다 |

## 10. 구현 단위

단위 하나가 티켓 하나, PR 하나다. "앞선 단위"가 티켓의 blocked-by다. 티켓 번호는 PR 본문에 있다.

| 단위 | 내용 | 끝난 조건 | 앞선 단위 |
|---|---|---|---|
| T1 proxy의 401·403 보고 (P1) | `apps/egress-proxy`의 MCP 경로 보고, control-host 인가 API의 보고 받기와 실패 receipt, worker 응답 본문의 werft 거절 코드 | proxy 시험: upstream 401·403 → 보고와 본문 코드, `www-authenticate` 없음, 보고 실패 → 지금 동작. control-host 시험: 실패 receipt 모양 | — |
| T2 egress 주체를 턴 요청자로 (P2) | `creatorOf` 세 곳, 도구 호출 감사 principal, caller limit digest 읽기 | 같은 세션에서 두 사람의 턴 → receipt actor가 각자. 첫 턴 전 요청 → 세션을 만든 사람. 릴리스 노트 | — |
| T3 서버 목록 하나: 저장과 이전 | 옮기기 migration과 명령(다시 암호화, `external`·허용 목록 밖 처리, 허용 목록 → deny), egress가 옛 세션의 카탈로그 경로를 계속 받음 | 옮기기 시험(행·연결·비밀·deny), 진행 중 옛 세션이 계속 호출됨, 새 세션은 워크스페이스 서버만 | — |
| T4 서버 목록 하나: 콘솔 | 목록 하나·추가 버튼 하나, 옮기기 상태(다시 연결 필요) | 화면 시험과 실제 스택 확인 | T3 |
| T5 카탈로그 경로 제거 | 카탈로그 테이블, `agent_mcp_settings`, claim 카탈로그 항목, 카드 MCP 항목 지우기(contract) | 카탈로그 경로를 받는 세션 0 확인 뒤 migration. 옛 host 호환([새 control-host와 옛 worker의 호환 계약](worker-compat.md)) | T3, T4 |
| T6 연결 subject 넓히기 | CHECK, owner_ref, 조회·잠금·비밀·receipt `generation`이 subject를 관통 | 세 subject의 저장·읽기·끊기 시험, 기존 `workspace` 행 그대로 | T3 |
| T7 agent 연결과 고르는 순서 | 에이전트 관리자의 연결(콘솔 에이전트 설정), egress의 agent → workspace 순서와 단계 receipt, caller limit을 모든 단계에 | 순서 시험(agent 있음·없음·needs_reauth), limit 밖 서버 → 모든 단계 거절 | T2, T6 |
| T8 personal 연결 | 본인 OAuth·bearer 흐름, 내 연결 화면, 어드민 끊기, `cutOff`·서버 삭제·에이전트 삭제 때 끊기, RFC 7009 폐기(commit 뒤, 대기 행) | 본인 흐름, 남이 만들 수 없음, 탈퇴 → 모두 끊기고 폐기 요청 | T6 |
| T9 권한 오류와 넘어가기 | 5절 전체: 401 갱신 한 번, (서버, 턴, 단계) 고정과 한 번·한 방향, relay 멈춤·client 새로 만들기·한 번 재시도(Claude·Codex), 호출 id, 재시도 receipt와 실패 receipt 잇기, 전송 묶음 기록의 subject | 401·403 → 넘어감, 타임아웃·5xx·`isError` → 넘어가지 않음, 같은 실패에 두 번째 재시도 거절, 한 턴 두 번째 넘어가기 없음, 다음 턴 다시 agent·workspace부터 | T1, T7, T8, S12 |
| T10 확인 ① 사용 확인 | `personal_mcp_use` 요청, 요청자만 답함, Slack ephemeral 카드와 콘솔 카드, 유효 범위와 종료 수단(질문 1·2·3) | 요청자 아닌 승인자 → 거절, 만료 → 원래 오류 | T9 |
| T11 확인 ②와 컨텍스트에서 빼기 | `personal_mcp_post`, 보류 revision, 보내기·보내지 않음, 다시 만들기 턴(도구 없음, 넘어가기 전 결과만), 이벤트 묶음, 개인 턴의 위임 거절, 답하지 않음과 다른 사람 턴(질문 4·5), 개인 턴의 다른 서버 호출(질문 7) | 보내지 않음 → 다음 턴 컨텍스트에 개인 결과 없음(fake 모델로 확인), 다시 만들기 턴에서 도구 호출 0, 보내기 → 다음 턴이 봄 | T10 |
| T12 E2E | 시험용 MCP 서버가 401·403을 내게 하고 로컬 스택에서 workspace → personal 넘어가기, mock Slack의 두 확인, 보내지 않음 뒤 컨텍스트 | 로컬 스택에서 전 과정, token이 worker 환경·로그·API 응답에 없음 | T11 |

**같이 진행할 수 있는 것.** T1(`apps/egress-proxy`, control-host 인가 API), T2(`packages/db/src/sessions`·`github`의 egress 상태 읽기와 감사), T3(migration과 카탈로그 이전)은 경로가 겹치지 않아 동시에 할 수 있다. T3만 migration을 더한다. T6은 T3 뒤에 migration을 더하므로 T3 다음이다. T7(egress 순서, 에이전트 설정 화면)과 T8(OAuth 흐름, 내 연결 화면, 끊기)은 T6 뒤에 동시에 할 수 있다. 둘 다 migration이 필요하면 번호가 겹치지 않게 먼저 머지한 쪽 뒤로 다시 번호를 매긴다. T4는 T6과 동시에 할 수 있다(콘솔과 DB).

**밖의 단위와의 관계.** T9는 [스킬과 MCP 서버](skills-and-mcp.md)의 S12에 막힌다(목록 캐시를 subject마다 나누고, `Mcp-Session-Id`를 subject에 묶어야 다른 계정의 상태를 이어 쓰지 않는다). S12가 막혀 있던 [접근 판정](access-decisions.md) B2(규칙)는 이 문서의 순서가 규칙이 아니라 고정 기본이므로 T9 경로에는 필요 없다. [접근 판정](access-decisions.md) B5는 T6–T11로 대신하고, B5가 막혀 있던 B1은 개인 연결 경로에서 빠진다(9절).

## 11. 미정

오너 답을 기다린다. 답이 오면 이 절을 지우고 해당 자리에 쓴다.

| 질문 | 자리 |
|---|---|
| 1. 확인 ①의 승인은 어디까지 유효한가(그 세션 안 / 세션을 넘어 끌 때까지) | 5절 "턴 안의 고정", 6절 ①, T10 |
| 2. 종료 수단을 어디에 두나 | 6절 ①, T10 |
| 3. 콘솔에서 본인이 부른 턴도 두 확인을 받나 | 6절 ①·②, T10, T11 |
| 4. 게시 확인에 답하지 않을 때, 기다리는 동안 같은 세션의 다른 사람 턴 | 6절 ②와 "컨텍스트에서 빼기" 1단계, T11 |
| 5. 다시 만든 답에 "개인 결과가 빠졌다"는 한 줄을 붙이나 | 6절 ②, T11 |
| 6. 권한 오류인데 개인 연결이 없을 때 본인에게 안내하나 | 5절 "넘어가기" 2단계, T9 |
| 7. 개인 턴 안의 다른 서버 호출(개인 결과가 인자에 실릴 수 있음)을 막나, 기록만 하나, 묻나 | 6절 "개인 턴에서 나가는 다른 길", T11 |

## 범위 밖

- **세션 공개 범위.** 누가 세션을 볼 수 있나(공유 범위, 팀·이메일 단위 공유)는 이번에 다루지 않는다(보류). 이 문서는 지금의 세션 공유 규칙을 바꾸지 않는다.
- IdP 중심 MCP 인가(ID-JAG). personal 연결의 token을 얻는 다른 길로 [접근 판정](access-decisions.md) C4에 남는다.
- `Basic` 인증, CIMD([mcp-credentials.md](mcp-credentials.md) LATER 그대로).

## 대안 (고르지 않음)

- **`isError` 본문의 "permission" 같은 말도 권한 오류로 봄.** 서버마다 문구가 달라 믿을 수 없고, `isError`는 일부 실행 뒤에 나올 수 있어 다시 보내면 두 번 실행될 수 있다.
- **`readOnlyHint`가 있는 도구만 다시 보냄.** 믿을 수 없는 서버의 annotation으로 실행을 정하게 된다. 401·403은 실행 전 거절이라 annotation 없이도 안전하다.
- **호출마다 처음부터 다시 고름.** 호출마다 실패와 재시도가 반복되고, relay가 서버마다 client 하나를 쓰므로 오갈 때마다 다른 계정의 상태가 섞인다.
- **턴을 시작할 때 미리 확인.** 권한 오류는 호출해 봐야 알 수 있어 필요 없는 질문을 매번 던진다.
- **세션을 연 사람의 personal 연결을 씀.** 같은 스레드에서 B가 보낸 턴에 A의 권한으로 읽은 데이터가 나간다.
- **보내지 않음에서 같은 입력으로 도구까지 다시 실행.** 개인 턴에서 이미 실행된 쓰기가 두 번 실행된다.
- **보내지 않음에서 transcript를 개인 호출 지점에서 잘라 이어 감.** 엔진마다 중간 지점에서 transcript를 자르는 방법이 다르고(엔진 중립이 깨진다), 지금 checkpoint는 턴 단위다.
