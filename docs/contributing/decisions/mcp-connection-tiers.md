# 결정(설계): MCP 연결을 workspace · agent · personal 세 단계로 나눈다

- 상태: 설계. 코드는 바꾸지 않는다. 구현 단위는 [10절](#10-구현-단위)에 있다.
- 기준 커밋: `origin/main` `8b15aa227`. `파일:줄`은 이 커밋에서 읽었다.
- 관련 결정: [워크스페이스 원격 MCP 서버](mcp-credentials.md), [접근 판정](access-decisions.md), [스킬과 MCP 서버](skills-and-mcp.md) 6절, [세션 저장소](session-store.md).
- 이 문서가 고치거나 대신하는 것은 [9절](#9-다른-문서에서-바뀌는-것)에 모았다. 각 문서에도 이 문서를 가리키는 줄을 넣었다.
- 티켓 번호: 저장소의 마크다운은 티켓 번호를 적지 못한다(`tests/docs-links.test.ts:324-330`). 사양, 조사, 구현 티켓의 번호는 이 문서를 들인 PR 본문에 있다.
- 오너 결정: 사양 1차·2차(2026-11-22)와, 이 설계 중에 물은 질문 일곱에 대한 답(2026-11-22)이다. 답은 [11절](#11-설계-중-오너-결정-2026-11-22)에 모았고 본문의 해당 자리에 썼다.

## 요약

| 항목 | 결론 |
|---|---|
| 한 줄 | **쓸 수 있는 MCP 서버 목록**은 워크스페이스 어드민이 하나로 관리하고, **어느 계정으로 붙는지(연결)**는 workspace · agent · personal 세 단계로 나눈다 |
| 서버 목록 | 워크스페이스 서버(`workspace_mcp_servers`) 하나. 설치 카탈로그(`mcp_servers`)는 한 번에 옮기고 없앤다 |
| 연결 | 연결 행의 `subject`를 `workspace` · `agent:<id>` · `user:<id>`로 넓힌다. 비밀 값 owner_ref는 `<server>:workspace` · `<server>:agent:<id>` · `<server>:user:<id>` |
| 고르는 순서 | 에이전트가 그 서버를 켰을 때만. agent 연결 → workspace 연결 → (본인 호출이면) personal 연결 → 없으면 그 서버 도구 없이 실행 |
| personal로 넘어가는 때 | 앞 단계 연결이 없거나 끊겼을 때, 그리고 upstream이 **HTTP 401·403**으로 거절했을 때만. 같은 호출을 personal로 **한 번** 다시 보낸다 |
| 턴 안의 고정 | 서버마다 한 턴에 **한 번, 한 방향**(agent·workspace → personal)으로만 바꾼다. 바꾼 뒤 그 턴의 남은 호출도 personal이다 |
| 본인 확인 | ① 넘어가는 순간 요청자에게만 보이는 ephemeral 확인(그 세션 안에서 한 번). ② personal 결과가 든 턴이 다른 서버를 처음 부를 때 한 번. ③ personal 결과가 든 답은 본인이 동의해야만 게시. 콘솔도 같다 |
| 게시하지 않은 결과 | 세션 컨텍스트와 기록에서 뺀다(엔진 상태, transcript, 세션 이벤트, 작업 공간을 턴 앞으로 되돌림). "보내지 않음"이면 개인 결과를 뺀 컨텍스트에서 다시 만든 답을 보낸다. 동의해 게시한 것만 스레드 컨텍스트로 남는다 |
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
| 턴을 멈추고 묻기 | `pending_requests`가 세션·턴·attempt, 종류, 만료, 답한 사람(`answered_by`)과 그 판정, `tool_use_id`를 갖는다(`schema.ts:2432-2480`). Slack 버튼은 누른 사람을 `session.approve`로만 판정한다(`packages/adapters/chat/slack/src/slack-interactions.ts:157-162`, `:337-349`). Slack outbox는 ephemeral 게시를 이미 쓴다(`packages/adapters/chat/slack/src/outbox-delivery.ts`) | 확인 세 가지에 다시 쓰되, 답할 수 있는 사람을 요청자로 좁힌다([6절](#6-본인-확인과-게시하지-않은-결과)) |
| checkpoint | 턴이 끝날 때 checkpoint revision을 commit하고, 세션 pointer가 마지막 commit을 가리킨다. resume은 pointer의 revision만 채택한다([세션 저장소](session-store.md)) | 개인 결과가 든 턴은 동의 전까지 pointer로 올리지 않는다([6절](#게시하지-않은-결과를-컨텍스트와-기록에서-빼기)) |
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
| 꺼진 행(`disabled_at`이 있음, `0225_installation_settings.sql:10-11`) | 옮기지 않는다. 지금 카탈로그를 읽는 경로도 꺼진 행을 빼므로(`packages/db/src/installation-settings.ts:253-257`) 쓰이지 않는 서버다. 옮기면 운영자가 끈 자격이 `active`로 되살아난다. 그 행을 가리키던 에이전트 선택도 옮기지 않고, 옮기기 보고에 목록으로 보인다 |
| 호스트 허용 목록 밖 | 옮기지 않는다. 지금 카탈로그는 경고만 하지만 워크스페이스 서버는 거절한다. 옮기기 전에 운영자가 허용 목록을 고치거나 행을 지운다. 옮기기 명령은 이런 행이 남아 있으면 시작하지 않고 목록을 보인다 |
| `agent_mcp_settings`(서버 하나, 허용 도구) | `agent_workspace_mcp_servers` 켜기 한 행 + **가져온 허용 목록**. 지금 카탈로그 판정은 호출을 에이전트의 `allowedTools`와 교집합한다(`packages/platform/src/sessions/mcp-settings.ts:63-68`, `:79-84`). 이것을 deny로 바꾸면 안 된다. 어드민이 "도구 다시 읽기"를 하면 서버의 저장된 도구 목록이 통째로 바뀌고 에이전트 deny는 그대로라(`packages/db/src/musterrolle/workspace-mcp.ts:1049-1056`), 새로 생긴 도구가 그 에이전트에 열린다. 그래서 옮긴 켜기 행에만 `imported_allowed_tools`(null이면 제한 없음)를 두고, 세션에 보이는 도구를 "저장된 목록 ∩ 가져온 허용 목록 − deny"로 계산한다. 이 칸은 넓어지지 않는다. 에이전트 관리자가 콘솔에서 "가져온 허용 목록 없애기"를 명시적으로 눌러야만 null이 된다(receipt를 남긴다). 새로 켜는 행은 이 칸이 언제나 null이다([mcp-credentials.md](mcp-credentials.md) 결정 5의 "allow 목록을 두지 않는다"는 새 선택에 그대로다) |
| 설정 행이 없고(또는 사람이 저장한 적 없고) 릴리스 카드가 카탈로그 서버를 지정 | 지금은 카드의 서버와 release 핀의 도구가 그대로 쓰인다(`packages/platform/src/sessions/mcp-settings.ts:73-76`). 이것도 켜기 한 행 + 가져온 허용 목록으로 옮긴다. 허용 목록은 카드의 서버와 release 도구 핀의 교집합(지금 `within`이 계산하는 것)이다 |

- **옛 세션.** 옮긴 뒤에도 카탈로그 경로를 받는 진행 중 세션이 끝날 때까지 egress는 그 경로를 계속 받는다. "카탈로그 경로를 받는 세션"은 `sessions.mcp_start`가 있는 세션만이 아니다. snapshot이 없는 세션도 release 카드와 핀으로 카탈로그 서버를 쓴다(`packages/db/src/github/mcp-egress.ts:70-103`). 그래서 닫히지 않은 세션 가운데 실제 판정 경로(`effectiveMcp`)가 카탈로그 서버를 내는 세션을 센다. 새 세션은 워크스페이스 서버만 snapshot한다. 그 수가 0이 된 뒤 카탈로그 테이블, `agent_mcp_settings`, claim의 카탈로그 항목, 릴리스 카드의 MCP 항목을 지운다(별도 단위 T5).
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
- **client는 서버에 하나, 모든 subject가 같이 쓴다.** 그래서 client가 바뀌면 그 client로 받은 모든 subject의 token이 무효다. 지금 client 교체는 그 서버의 연결 행 전부를 끊지만(`workspace-mcp.ts:606-640`, 연결 행이 서버마다 하나라서 맞았다), `invalid_client` 뒤의 DCR 재등록은 서버의 client를 지우면서 한 연결의 token만 지운다(`:1000-1013`). subject가 여럿이 되면 이렇게 정한다. 서버 행에 `client_revision`을 두고, client 교체·DCR 재등록·client 삭제마다 올린다. 연결 행과 진행 중 동의 흐름은 token(또는 흐름)을 받을 때의 `client_revision`을 적는다. 올리는 transaction이 그 서버의 모든 연결 행을 잠그고, 옛 revision의 연결을 모두 `needs_reauth`로 바꿔 사용자 token을 지우고 `generation`을 올리며, 진행 중 흐름을 지운다. 콜백 저장은 흐름의 revision이 지금과 같을 때만 받는다. egress도 연결의 revision이 서버의 것과 다르면 `oauth_needs_reauth`로 거절한다.
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

끊기는 지금처럼 한 transaction에서 상태 `none`, `generation` 증가, 사용자 token 삭제다. 그 transaction이 commit된 **뒤** 인가 서버에 `revocation_endpoint`가 있으면 RFC 7009로 refresh token(없으면 access token)을 폐기한다. 그래서 transaction은 지우기 전에 폐기할 token을 읽어 둔다(지금 `revocationOf`, `workspace-mcp.ts:283-313`가 하는 것). `cutOff`는 transaction 안에서 외부 호출을 하지 않으므로(지금 주석 `:327-332`), 폐기할 것을 같은 transaction에서 `mcp_revocations` 대기 행으로 옮기고 commit 뒤 control-host가 보내고 지운다. 대기 행은 **그것만으로 폐기를 보낼 수 있어야 한다.** 서버 삭제나 client 교체가 그 뒤에 서버 행의 메타데이터와 client 비밀을 지우기 때문이다. 그래서 행은 지금 `revocationOf`가 모으는 것(고정한 OAuth 메타데이터의 revocation endpoint·issuer·client id·클라이언트 인증 방식, token 종류 힌트)을 값으로 담고, token과 client secret은 owner kind `mcp_revocation`, id = 대기 행 id의 비밀 값으로 다시 암호화해 둔다. 서버 행을 가리키지 않는다. 폐기 실패는 그 행을 만료(그 token의 남은 수명, 상한 30일)까지 다시 시도하고, 보내거나 만료되면 행과 비밀 값을 지운다. 끊기 자체는 이미 성공이다. 폐기 endpoint는 control-host가 직접 부르는 곳이므로 [mcp-credentials.md](mcp-credentials.md) 결정 2의 outbound 규칙을 지난다.

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
- **caller limit은 단계와 따로 본다.** limit은 "이 호출자가 어느 서버에 닿을 수 있나"를 정하고 어느 연결을 쓰는지와 무관하다. 에이전트에 걸린 규칙이 기준이고, personal에도 같이 걸린다. 턴에는 limit의 digest만 남고(`schema.ts:1799`, digest는 SHA-256이라 limit을 되살릴 수 없다, `packages/platform/src/musterrolle/caller-limit.ts:103-110`), 세션의 limit은 첫 요청자의 것이다(`schema.ts:1602`). 그래서 T2가 턴에 그 입력을 받아들일 때 쓴 limit 자체(`turns.caller_limit`, 세션의 칸과 같은 모양, 바뀌지 않음)를 남기고, egress는 그것을 읽는다. 이 칸이 없는 옛 턴은 세션의 limit을 쓰고 personal 단계를 쓰지 않는다.
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
2. control-host는 실패 receipt를 쓰고(7절), 그 턴이 personal 단계를 쓸 수 있고 요청자의 personal 연결이 `active`인지 본다. 아니면 거기서 끝이다. 원래 오류가 엔진에 간다. 쓸 수 있는 턴인데 그 사람에게 그 서버의 personal 연결이 없으면(없음·`none`·`needs_reauth`), 본인에게만 "개인 연결을 만들면 쓸 수 있다"는 안내와 콘솔의 연결 화면 링크를 **한 번** 보낸다(오너 결정 6). "한 번"은 (세션, 서버, 사람)마다 한 번이고 세션 행에 보낸 것을 표시한다.
3. 쓸 수 있으면 확인 ①이 필요한지 본다(6절). 필요하면 `pending_requests`에 확인 행을 만들고 그 id를 relay에 돌려준다. relay는 그 호출을 멈추고 답을 기다린다. 턴은 지금의 `awaiting_input`으로 멈춘다.
4. 허락이 오면 relay는 그 서버의 upstream client를 버리고 새로 만든 뒤 **같은 JSON-RPC 요청을 한 번** 다시 보낸다. 요청에는 실패 receipt id를 싣는다. egress는 그 receipt가 같은 attempt·턴·서버·도구·호출 id의 것이고, 허락이 그 턴의 요청자에게서 왔는지 확인한 뒤 (서버, 턴)의 단계를 personal로 바꾸고 재시도 receipt를 쓴다.
5. 거절이나 만료면 원래 오류를 엔진에 그대로 준다. 그 턴은 그 서버에서 다시 넘어가지 않는다.

### 처음부터 personal인 경우

agent·workspace 연결이 모두 `active`가 아니면 upstream 실패 없이 처음부터 personal이 후보다(4절). 이때는 실패 receipt가 없으므로 위 4단계 대신 이렇게 한다.

1. (서버, 턴)의 첫 upstream 요청(메서드가 `tools/call`이 아니어도)에서 egress가 단계를 고르다 personal에 닿으면, 그 세션에서 그 사람의 사용 확인 승인이 있는지 본다.
2. 승인이 없으면 그 요청을 보내지 않고 **선택 receipt**(`failed`, 이유 `personal_consent_required`, 단계 personal, 서버, 메서드, 도구가 있으면 도구, 호출 id)를 쓰고 확인 ① 요청을 만들어 그 id를 돌려준다. relay는 그 요청을 멈추고 기다린다.
3. 허락이 오면 relay는 같은 요청을 한 번 다시 보내며 선택 receipt id를 싣는다. egress는 그 receipt가 같은 attempt·턴·서버·호출 id의 것이고 허락이 요청자에게서 왔는지 확인한 뒤, 연결 행을 `FOR SHARE`로 잡은 transaction에서 (서버, 턴)의 단계를 personal로 고정하고 그 요청의 receipt(`tools/call`이면 `accepted`)를 쓴다. 고정과 receipt가 같은 transaction이라, 고정만 되고 기록이 없는 상태가 없다.
4. 승인이 이미 있으면 1단계에서 바로 3단계의 고정과 receipt로 간다.
5. 거절·만료면 그 요청은 `credential_unavailable`로 거절되고, 그 턴에서 그 서버는 도구 없이 간다.

이 경로는 "넘어가기"가 아니다(앞 단계에서 실패한 호출이 없다). 그래서 실패 receipt와 재시도 receipt의 쌍 대신 선택 receipt와 그 다음 receipt의 쌍이 남고, 둘 다 확인 ① 요청 id를 담는다. 개인 턴인 것은 같다(6절).

**두 번 실행되지 않는 이유.** HTTP 401·403은 서버가 도구를 실행하기 **전에** 인가 단계에서 거절한 것이다. 그래서 다시 보내도 원래 호출은 실행되지 않았다. 도구 annotation(`readOnlyHint` 등)은 믿지 않는다. 재시도는 호출 id로 묶어 같은 호출을 한 번만 다시 보낸다. egress는 같은 실패 receipt를 가리키는 두 번째 재시도를 거절한다.

**호출 id.** relay가 엔진에서 받은 도구 호출마다 정하는 id다. 엔진이 tool-use id를 relay에 주면 그것을 쓰고, 아니면 relay가 attempt 안에서 유일한 id를 만든다. relay는 이 id를 upstream 요청의 werft 헤더로 싣고, proxy는 upstream에 보내기 전에 그 헤더를 떼어 인가 요청에 싣는다. 이 id는 묶기에만 쓰고 판정 입력이 아니다. 판정은 receipt 행과 그 턴의 실행 자격으로 한다.

### 턴 안의 고정

- 한 턴 안에서 서버마다 **agent·workspace → personal 한 방향으로 한 번만** 바꾼다. 바꾼 뒤 그 턴의 남은 호출(그 서버의 `tools/list` 포함)도 personal이다. personal에서 다시 내려가지 않고, personal이 401·403이면 그 오류가 엔진에 간다.
- 다음 턴은 다시 4절의 순서로 고른다. 같은 세션에서 그 사람이 확인 ①을 이미 승인했다면 그 턴의 첫 요청부터 personal이 아니라, 다시 agent·workspace부터 시작하고 권한 오류에서 확인 없이 넘어간다(승인은 그 세션 안에서만 유효하다, 오너 결정 1).
- 고정 단위는 [스킬과 MCP 서버](skills-and-mcp.md) 6절 "전송 세션"의 (서버, 턴)이 아니라 **(서버, 턴, 단계)**다. 단계가 바뀌는 것은 그 문서의 `mcp_session_subject_changed`가 아니라 위 넘어가기 하나뿐이고, 그때 relay가 upstream client를 새로 만든다. 그 밖에 subject가 바뀌면(연결 끊김 등) 그 문서의 규칙대로 거절한다.
- **fingerprint에 subject를 넣는다.** (서버, 턴)의 전송 묶음 기록과 `call_mcp` receipt에 subject와 `generation`을 넣는다. 그래야 끊긴 턴을 이어갈 때 같은 subject로 이어가고, 다른 subject의 상태를 섞지 않는다. 세션 checkpoint의 프로필 fingerprint는 claim 항목(이름, endpoint, binding, 도구)만 담고 subject를 담지 않는다([mcp-credentials.md](mcp-credentials.md) 결정 6). subject는 턴마다 바뀌므로 거기에 넣으면 매 턴 resume이 checkpoint를 쓰지 못한다.
- worker가 죽은 턴은 지금도 자동으로 다시 돌지 않고 운영자 결정을 기다린다. 그래서 "넘어가는 도중에 죽음"도 자동으로 두 번 실행되지 않는다.

## 6. 본인 확인과 게시하지 않은 결과

목적: 개인 권한으로 읽은 데이터가 본인 확인 없이 채널, 세션, 다른 서버로 나가지 않게 한다. 확인은 셋이고 모두 **그 턴의 요청자 한 사람**만 볼 수 있고 답할 수 있다. 지금 Slack 버튼은 `session.approve`를 가진 사람이면 누구나 누를 수 있으므로(`slack-interactions.ts:337-349`), 이 세 종류는 판정에 "누른 사람이 요청 행의 요청자와 같다"를 더한다. 같지 않으면 `session.approve`가 있어도 거절이다.

**콘솔도 같다.** 콘솔에서 본인이 부른 턴도 세 확인을 같은 카드로 받는다(오너 결정 3). Slack은 요청자에게만 보이는 ephemeral 카드, 콘솔은 그 사람의 세션 화면에만 보이는 카드다. 카드는 세션 이벤트가 아니라 요청 행에서 그리므로, 같은 세션을 보는 다른 사람의 화면에는 나오지 않는다.

| 확인 | 언제 | `pending_requests` 종류 | 답이 없으면 |
|---|---|---|---|
| ① 사용 확인 | personal로 넘어가는 순간(5절 3단계) | `personal_mcp_use` | 지금 권한 카드의 만료와 같다. 만료는 "쓰지 않기"다 |
| ② 다른 서버 호출 확인 | 개인 턴이 다른 서버를 처음 부를 때 | `personal_mcp_outbound` | 24시간 뒤 거절(오너 결정 7) |
| ③ 게시 확인 | 개인 턴의 답이 나왔을 때 | `personal_mcp_post` | 24시간 뒤 "보내지 않음"(오너 결정 4) |

이 문서에서 **개인 턴**은 어느 서버에서든 personal로 넘어간 턴이다.

### ① 사용 확인 ("개인 연결을 쓸까요")

- 넘어가는 순간 묻는다. 턴을 시작할 때 미리 묻지 않는다. 권한 오류는 호출해 봐야 알기 때문이다. 카드: 쓰기 / 쓰지 않기.
- **그 세션 안에서 한 번.** 승인하면 같은 세션의 그 사람 턴은 다시 묻지 않는다. 새 세션에서는 다시 묻는다(오너 결정 1). 승인은 (세션, 사람)마다 세션 행 옆의 승인 행에 둔다. 서버마다가 아니다.
- **끄는 곳은 둘이다.** 확인 카드의 "개인 연결 그만 쓰기" 버튼과 콘솔 세션 화면이다(오너 결정 2). 끄면 그 승인 행을 지우고, 그 세션에서 그 사람의 다음 호출부터 agent → workspace만 쓴다. 진행 중인 턴에서 이미 personal로 넘어간 서버는 그 턴의 다음 요청부터 거절된다(5절의 고정은 단계가 바뀌지 않게 할 뿐 허용을 고정하지 않는다). 다시 쓰려면 다음 권한 오류에서 다시 묻는다.

### ② 다른 서버 호출 확인 (오너 결정 7)

개인 턴에서 에이전트가 **다른 서버**를 부르면, 그 호출의 인자에 개인 결과가 실릴 수 있고 게시 확인으로는 되돌릴 수 없다. 그래서 묻는다.

- **대상.** 그 턴에서 처음 personal로 넘어간 서버(시작 서버) 밖으로 나가는 모든 호출이다. 자격 단계를 가리지 않는다: 다른 MCP 서버의 agent·workspace 연결, 내장 `github` MCP, git push, 그리고 **다른 서버가 뒤이어 personal로 넘어간 경우의 그 서버 호출**도 대상이다. 요청자 본인의 다른 서비스라도 그 서비스의 다른 독자(공유 문서, 팀 채널 등)에게 개인 결과가 실릴 수 있기 때문이다. 다른 서버가 personal로 넘어갈 때는 5절의 재시도가 그 서버로 가는 첫 호출이므로, 그 재시도를 ②로 멈춘다. relay는 서버마다 upstream client를 따로 두므로(`packages/adapters/runtimes/codex/src/mcp-relay.ts:118-146`, `packages/adapters/runtimes/claude/src/remote-mcp.ts:115-122`) 서버를 가르는 것은 egress 판정의 (서버, 턴) 단위로 충분하다. 시작 서버 자체의 호출만 대상이 아니다. 도구 annotation을 믿지 않으므로 읽기·쓰기를 가르지 않는다. 넘어가기 **전에** 시작된 호출은 대상이 아니다.
- **처음 한 번만 멈춘다.** 그 턴에서 그 서버로 가는 첫 호출을 멈추고, 본인에게만 보이는 카드를 보낸다. 카드에는 서버 이름, 도구 이름, 인자의 첫 몇 줄 미리보기(줄 수와 글자 수 상한, 비밀 값 가리기를 지난 것)가 있다.
- **"이 턴에서 허락"**이면 그 턴 동안 그 서버는 다시 묻지 않는다. 새 서버가 나올 때만 다시 묻는다.
- **거절이나 24시간 동안 답 없음**이면 그 호출은 도구 오류로 돌아가고, 에이전트는 그것 없이 계속한다.
- 허락한 호출이 있으면 그 턴의 게시 확인 카드에 "이미 외부로 나간 것: <서버·도구 목록>" 한 줄을 붙인다. 보내지 않음을 골라도 이 호출은 되돌릴 수 없다는 뜻이다.
- **집행 자리.** egress가 판정에서 그 턴이 개인 턴인지 보고(5절 4단계가 (서버, 턴)에 남긴 personal 단계 행), 허락 행이 없으면 실패 receipt를 쓰고 확인 요청 id를 돌려준다. relay는 5절의 멈춤과 같은 길로 기다린다. git push는 지금 push 경로의 egress 판정에서 같은 검사를 한다.
- 미리보기는 개인 결과를 담을 수 있다. 그래서 요청 행의 `payload`에서 미리보기는 답이 나는 즉시 지우고 해시만 남긴다.

### ③ 게시 확인 ("이 답을 보낼까요")

- 개인 턴의 답은 바로 게시하지 않는다. 요청자에게만 보이는 미리보기와 "보내기 / 보내지 않음"을 준다.
- **보내기.** 답을 채널(또는 세션)에 게시한다. 그 턴은 세션 컨텍스트로 남는다(아래 checkpoint 승격). 그 뒤 같은 스레드의 다른 사람 턴도 이 내용을 본다. 본인이 동의해 게시한 것이기 때문이다.
- **보내지 않음.** 개인 결과를 세션 컨텍스트와 기록에서 빼고(아래), 뺀 컨텍스트에서 다시 만든 답을 보낸다. 다시 만든 답에는 내용 없이 "요청자의 개인 연결 결과는 빠졌습니다" 한 줄을 붙인다(오너 결정 5).
- **답하지 않음.** 24시간 뒤 "보내지 않음"으로 처리한다. 기다리는 동안 같은 세션의 다른 사람 턴은 그 결정 뒤로 줄을 선다(오너 결정 4). 그래서 다른 사람의 턴이 동의 전의 개인 결과를 보는 길이 없다. 줄을 선 턴의 보낸 사람에게는 "앞 턴의 확인을 기다리는 중"이 보인다.

### 게시하지 않은 결과를 컨텍스트와 기록에서 빼기

checkpoint는 턴이 끝날 때 commit되고 세션 pointer가 그것을 가리킨다. resume은 pointer의 revision만 채택하고, 그 revision은 transcript part, 작업 공간, 엔진 프로필을 함께 고정한다([세션 저장소](session-store.md), 작업 공간 capture는 `apps/worker/src/session-checkpoints.ts:90-95`). 이것을 그대로 쓴다.

1. **보류.** 개인 턴이 끝나면 worker는 checkpoint revision을 만들되 세션 pointer로 **올리지 않는다**. 세션 행에 "보류 revision"과 게시 확인 요청 id를 둔다. 보류가 있는 동안 그 세션의 다음 턴은 시작하지 않는다(위 줄 서기).
   - **턴 중간의 checkpoint도 같다.** 지금은 승인을 기다리는 동안에도 checkpoint를 잡고(`apps/worker/src/worker-host.ts:3108-3149`, point `approval_wait`), worker가 그 자리에서 멈추면 그 checkpoint를 세션 pointer로 올린다(`packages/db/src/worker-unit-of-work.ts:702`의 `parkOnApprovalCheckpoint`가 `:814-832`에서 `advanceCheckpointPointer`를 부른다). 개인 턴에서 이 길을 그대로 두면 ②·③을 기다리는 사이 worker가 죽었을 때 개인 결과가 든 revision이 동의 없이 pointer가 되고, 다음 실행이 그것을 이어 쓴다. 그래서 personal로 넘어간 뒤 그 턴에서 잡는 checkpoint는 모두 보류 revision이다. `parkOnApprovalCheckpoint`와 턴 끝의 승격은 그 턴에 personal 단계 행(5절 4단계)이 있으면 pointer를 올리지 않고 세션 행의 보류 칸만 갱신한다. 이어 가기는 보류 revision에서만 하고, 그 실행의 답도 ③을 다시 거친다. 공개 pointer는 개인 턴 앞의 revision에 남는다.
2. **보내기**면 보류 revision을 pointer로 올리고 답을 게시한다. 한 transaction이다.
3. **보내지 않음**이면 보류 revision을 버리고(pointer는 개인 턴 앞의 revision에 남는다), 아래 "기록에서 지우기"를 한 뒤 **다시 만들기 턴**을 돌린다.
   - 다시 만들기 턴은 개인 턴 앞의 checkpoint에서 **새 엔진 실행으로** 시작한다. 개인 턴을 돌린 엔진 프로세스는 그 메모리에 개인 결과를 갖고 있으므로 이어 쓰지 않는다. 작업 공간도 그 checkpoint의 것으로 되돌린다(개인 턴이 파일에 쓴 것이 남지 않게).
   - personal 단계를 쓰지 않는다. **도구를 다시 부르지 않는다**(개인 턴에서 이미 실행된 쓰기를 두 번 실행하지 않기 위해 모든 도구 호출을 거절한다).
   - 플랫폼이 만든 문단 하나를 입력에 붙인다. 개인 턴에서 **넘어가기 전에** 끝난 도구 호출(그 결과는 개인 데이터를 보지 않았다)의 이름과 결과, 넘어간 **뒤**의 호출은 서버·도구 이름만("실행됨, 결과 제외"). 넘어가기 전 호출의 결과는 개인 턴이 끝날 때 worker가 보류 revision 옆에 따로 둔 것을 쓴다. 넘어간 뒤 호출의 인자와 결과는 싣지 않는다.
   - 다시 만든 답을 보내고 그 턴의 checkpoint를 pointer로 올린다. 다시 만들기가 실패하면 아무것도 게시하지 않고 본인에게만 알린다. 이때도 개인 턴은 이미 지워졌으므로 다음 턴은 개인 턴 앞의 컨텍스트에서 시작한다.

**기록에서 지우기.** 보내지 않음(답하지 않음 포함) 뒤 개인 결과가 남을 수 있는 곳과 처리다. 본문이 남는 곳은 지우고, 본문이 없는 곳은 그대로 둔다.

| 곳 | 무엇이 있나 | 처리 |
|---|---|---|
| 엔진 프로세스와 엔진 로컬 상태(Claude config dir의 transcript, Codex `CODEX_HOME`의 rollout) | 개인 턴 전체 | 위 3단계: 그 실행을 끝내고 앞 checkpoint에서 새 실행으로 시작한다. 로컬 상태는 실행마다 새로 만들고 버리는 디렉터리라([스킬과 MCP 서버](skills-and-mcp.md) 6절 "자격") 같이 버려진다 |
| transcript mirror(object store part) | 개인 턴의 part | 보류 revision만 가리키는 part를 **모든 version까지** 지운다(아래 "object store의 version"). 다음 실행은 pointer의 revision만 채택하므로 지우기 전에도 읽히지 않지만, 남겨 두지 않는다. 지우기는 checkpoint 수집 경로에서 하고, 실패하면 다시 시도한다 |
| 보류 checkpoint의 manifest와 작업 공간 capture | 개인 턴의 상태와 개인 턴이 쓴 파일 | 보류 revision과 함께 모든 version까지 지운다 |
| 세션 이벤트(`events`, `packages/db/src/schema.ts:1927`) | 개인 턴의 답·도구 호출 이벤트 | 개인 턴의 이벤트는 처음부터 보류 표시와 함께 쓰고, 세션 화면과 이벤트 스트림은 요청자에게만 보인다. 보내기면 표시를 풀고, 보내지 않음이면 지운다. 다시 만들기 턴의 이벤트가 그 자리에 온다 |
| Slack | 요청자에게 보낸 ephemeral 미리보기와 카드 | ephemeral은 다른 사람에게 보이지 않는다. 확인이 끝나면 카드를 "끝남"으로 바꿔 미리보기를 없앤다 |
| `pending_requests` | ②·③의 미리보기 | 답이 나면 `payload`의 미리보기를 지우고 해시만 남긴다 |
| receipt(`call_mcp`), `tool_call_audits`, `authz_decisions` | 서버·도구 이름, 단계, 상태, 입력 해시(`tool_call_audits.input_sha256`). 본문은 없다 | 그대로 둔다. 감사 기록이고 본문이 없다 |
| 로그·지표 | 본문 키는 로그에서 빠진다([로그 계약](logging-contract.md)) | 그대로 둔다 |
| tracing span | 설치가 content mode `full`이면 답과 도구 결과가 span 속성으로 밖의 collector에 나간다(`apps/worker/src/worker-host.ts:1788-1799`가 턴의 mode를 정하고, `apps/worker/src/telemetry/turn-spans.ts:362-365`, `:410-414`가 `setContentAttribute`로 싣는다. `apps/worker/src/telemetry/content.ts:61-74`) | 나간 뒤에는 werft가 지울 수 없으므로 **싣지 않는다**. personal로 넘어간 순간부터 그 턴의 span emitter는 content 속성을 쓰지 않는다(mode를 그 턴만 `off`로 내린다). 넘어가기 전에 이미 실은 것은 개인 데이터를 보지 않은 결과다. span의 이름, 시간, 상태와 personal 단계 표시는 남는다. 보내기를 골라도 그 턴의 content는 다시 싣지 않는다 |
| 다시 만들기 턴의 입력 문단 | 넘어가기 전 결과와, 넘어간 뒤 호출의 이름 | 개인 결과가 없다 |
| ②에서 허락해 이미 나간 호출 | 다른 서버에 실린 인자 | 되돌릴 수 없다. 게시 확인 카드의 "이미 외부로 나간 것" 줄이 이것을 알린다 |

- **본인도 다시 볼 수 없다**(오너 결정 8). 위 표의 "지운다"는 요청자 본인에게서도 지우는 것이다. 남는 것은 본문 없는 감사 기록(서버·도구 이름, 단계, 상태, 입력 해시)뿐이다. 본인의 세션 화면에는 그 자리에 "개인 연결 결과 N건은 보내지 않아 지웠습니다" 한 줄만 보인다(N은 그 턴에서 personal로 보낸 `tools/call` 수, receipt에서 센다). 어드민의 사유 있는 감사 열람도 같은 것만 본다.

**object store의 version.** 커밋된 checkpoint는 S3 versioning과 Object Lock legal hold로 고정되어, 같은 key를 덮어쓰거나 지워도 그 version이 남는다([백업과 복원](../../operator/backup-restore.md) "checkpoint 객체"). 그래서 정한다.

- 보류 revision의 object(manifest, transcript part, 작업 공간 capture)에는 legal hold를 걸지 않는다. hold는 보내기로 pointer에 올릴 때 건다. 보내지 않음이면 hold 없는 그 object의 **모든 version과 delete marker**를 version id로 지운다(`s3:DeleteObjectVersion`, 그 문서의 권한 목록에 이미 있다). 보류 중에 worker가 죽거나 lease를 잃어 hold 없는 object가 남는 경우도 아래 장부가 다시 지운다.
- 보류 revision의 object는 다른 revision과 key prefix를 나눠, 지울 때 다른 revision의 part를 건드리지 않는다.

**백업.** werft는 운영자가 가진 DB 스냅샷과 백업 묶음(`scripts/backup.sh`)을 고쳐 쓸 수 없다. 그래서 지운 본문이 백업 복원으로 되살아나지 않게 하는 쪽으로 막는다. [기억 레이어](memory-layer.md) 9절의 삭제 장부와 같은 방식이다.

- **지우기 장부.** 보내지 않음으로 지운 개인 턴마다 DB 백업과 따로 보관하는 append-only 장부에 한 줄을 쓴다: 세션 id, 턴 id, 보류 revision, 지운 object key와 version id, 지운 이벤트 범위, 시각. 본문은 없다. 장부는 checkpoint object store의 별도 prefix(Object Lock 보존, 덮어쓰기 불가)에 둔다. 기억 레이어의 삭제 장부가 생기면 같은 장부에 종류 칸으로 합친다.
- **복원 뒤 다시 지우기.** 백업에서 복원한 설치의 control-host는 장부를 다시 적용하기 전까지 장부에 있는 세션의 이벤트 읽기, 세션 resume, checkpoint 복원을 거절한다(`personal_erasure_restoring`). 다시 적용은 장부의 줄마다 이벤트 범위를 지우고, 그 object version이 복원본에서 다시 보이면 지운다. 보류 중이던 턴(백업 시점에 아직 답이 없던 것)은 복원본에서 "보내지 않음"으로 처리한다. 답을 기다리던 사람이 복원 뒤의 카드를 믿을 수 없기 때문이다.
- **백업 안의 본문.** 백업 묶음과 DB 스냅샷에는 그 백업을 만든 시점의 보류 중 본문이 남을 수 있다. 이것은 백업 보존 기간이 끝나야 사라진다. [백업과 복원](../../operator/backup-restore.md)과 [데이터 보존](../../operator/data-retention.md)에 이 사실과 장부 재적용 절차를 적고, 개인 연결을 켜는 화면(T14)의 안내에도 적는다.
- 보내기를 고른 턴은 지우지 않는다. 본인이 동의해 스레드 컨텍스트로 남긴 것이다.
- 개인 턴이 끝나기 전에 worker가 죽으면 그 턴에서 잡은 checkpoint는 위 1단계대로 보류 revision으로만 남는다. 그 턴의 이벤트는 보류 표시가 있으므로 운영자 결정(이어 가기 / 버리기)까지 요청자에게만 보인다. 이어 가기는 보류 revision에서 하고 답은 ③을 거친다. 버리면 "보내지 않음"과 같이 위 표대로 지운다.

**개인 턴에서 나가는 다른 길.**

- 다른 에이전트에 위임: 개인 턴에서는 거절한다([접근 판정](access-decisions.md) 13절 2의 추천과 같다).
- 기억 쓰기: 기억은 아직 열리지 않았다. 열릴 때 개인 턴의 기억 후보는 보류 revision과 함께 묶여, 보내지 않음이면 버린다.
- 다른 서버 호출: 위 ②.
## 7. receipt와 기록

실패한 호출과 다시 보낸 호출은 **receipt를 따로** 쓰고 서로를 가리킨다.

| receipt | 상태 | 담는 것 |
|---|---|---|
| 실패 | `failed` | 단계(`agent`·`workspace`), 그 연결의 subject·`generation`, upstream 상태(401·403), challenge의 `error`·`scope`, 호출 id, 재시도 receipt id(재시도가 생기면 나중에 이어 쓰는 칸 대신 재시도 쪽이 가리킨다) |
| 재시도 | `accepted` | 단계 `personal`, werft 사용자 id, `generation`, 실패 receipt id, 확인 ① 요청 id(허락한 사람과 시각), 호출 id |
| 선택(처음부터 personal, 5절) | `failed`, 이유 `personal_consent_required` | 단계 personal, 서버, 메서드, 도구, 호출 id, 확인 ① 요청 id. 허락 뒤의 receipt가 이것을 가리킨다 |

- 모든 `call_mcp` receipt에 단계(`workspace`·`agent`·`personal`), subject, `generation`, 그 턴의 요청자(actor)를 남긴다. actor는 세션을 만든 사람이 아니라 턴의 요청자다(선행 작업 P2). personal의 subject는 werft 사용자 id이고 외부 계정 식별자는 남기지 않는다.
- 확인 ②(다른 서버 호출)와 ③(게시)의 답은 그 요청 행과 receipt로 남는다. ②는 서버·도구 이름과 허락·거절, ③은 보내기·보내지 않음·다시 만들기 성공 여부다. 미리보기 본문은 남기지 않는다(6절 "기록에서 지우기").
- [접근 판정](access-decisions.md)의 `authz_decisions`가 생기면 그 `granted.credential`에 같은 단계·subject·`generation`·`fallback`(넘어갔는지)을 남기고, `tool_call_audits.access_decision_id`가 그것을 가리킨다. 이 문서의 receipt 규칙은 그것을 기다리지 않는다.

## 8. 선행 작업

세 단계와 넘어가기 앞에 둘이 먼저 있어야 한다. 둘은 서로 닿지 않는 경로라 같이 진행할 수 있다.

**P1. proxy가 upstream 401·403과 challenge를 control-host에 알린다.** 지금 proxy는 MCP 경로의 401을 403으로 바꾸고 `www-authenticate`를 지운 채 worker에만 돌려준다(`credential.ts:1933-1948`). control-host 판정은 upstream 호출 전에 끝나서 upstream이 무엇을 답했는지 모른다.

- proxy는 MCP 경로에서 upstream이 401·403을 주면, worker에 답하기 **전에** control-host의 인가 API에 보고한다: grant의 판정 id, 상태, `WWW-Authenticate`를 파싱한 `error`·`scope`(값의 길이 상한, 다른 파라미터는 버림), 호출 id. 지금 ledger 보고(`credential.ts:1387-1400`)와 같은 인증으로 보낸다.
- control-host는 실패 receipt를 쓰고 5절의 다음 걸음(확인 요청 id 또는 "넘어가지 않음")을 답한다. proxy는 그 답을 werft 거절 코드와 함께 worker 응답 본문에 싣는다. `www-authenticate`는 지금처럼 지운다(엔진이 스스로 OAuth를 시작하지 않게).
- 보고에 실패하면(control-host 불통) 넘어가기 없이 지금 동작(403)으로 답한다. 닫힌 쪽이다.
- 401→403 바꾸기는 남긴다. worker가 받는 것은 werft의 거절이고 upstream의 인증 요구가 아니기 때문이다.

**P2. MCP egress가 세션을 만든 사람이 아니라 턴의 요청자로 동작한다.** 지금 egress의 actor와 도구 호출 감사의 principal은 세션을 만든 사람이다(`workspace-mcp-egress.ts:211`, `tool-call-audit.ts:245-250`). 같은 Slack 스레드에서 B가 보낸 턴의 호출이 A의 이름으로 남는다.

- egress 상태 읽기가 실행 중 턴의 `requester_kind`·`requester_id`·`actor_id`를 읽고(`schema.ts:1782-1799`), receipt actor와 감사 principal을 그것으로 쓴다. 턴을 넣을 때 그 입력에 쓴 caller limit 자체를 `turns.caller_limit`에 남기고(지금은 digest뿐이다, 4절), egress가 그것을 읽는다. 카탈로그 경로와 내장 `github` 경로의 `creatorOf`(`mcp-egress.ts:221`, `:304`)도 같이 바꾼다.
- 턴이 없는 요청(첫 턴 전)은 actor를 세션을 만든 사람으로 두되 personal 단계를 쓰지 않는다. 첫 턴 전 요청을 upstream에 보내지 않는 일은 [스킬과 MCP 서버](skills-and-mcp.md) S11의 것이다.
- 기록되는 값이 바뀌므로 릴리스 노트에 적는다([접근 판정](access-decisions.md) 10절과 같다). 요청자의 인증 근거를 다시 확인하는 일(key 폐기 등)은 그 문서의 A2이고, 이 단계는 지금 턴에 남는 요청자 칸을 쓴다.

## 9. 다른 문서에서 바뀌는 것

| 문서 | 무엇이 바뀌나 |
|---|---|
| [mcp-credentials.md](mcp-credentials.md) | 결정 1(자격 주체는 워크스페이스 하나, `subject = 'workspace'`만): 세 단계로 대신한다(3절). 결정 2와 "지금 있는 것"의 "설치 카탈로그는 그대로 둔다": 한 번에 옮기고 없앤다(2절). 결정 6의 카탈로그 선택 유지·claim 순서·상한 `2 + 8`: 카탈로그를 지운 뒤 워크스페이스 서버와 `github`만 남는다. 결정 6의 "proxy는 바꾸지 않는다": P1로 바뀐다. LATER의 "에이전트별 외부 계정", "요청자 본인의 계정", "upstream 401을 연결 상태에 반영": 이 문서가 연다. 결정 2의 "지우면 비밀 값이 같이 지워진다": 1절의 다른 곳 |
| [access-decisions.md](access-decisions.md) | 2절 결과의 MCP `credential` 종류: `agent`(= 워크스페이스 연결)·`personal` 둘에서 `workspace`·`agent`·`personal` 셋으로. 2절 "개인 기억·개인 연결의 전제"와 **B1**: 개인 **연결**에는 ②세션 소유자, ③공유 범위 `private`, ④표시 commit을 걸지 않는다. 대신 그 턴의 요청자 본인, 확인 세 가지, 게시하지 않은 결과를 컨텍스트에서 빼기(6절)가 전제다. 개인 **기억**의 전제와 B1은 그대로다. 4절 이행 모드의 "개인 연결은 쓰지 않는다": 이행 모드도 4절의 순서를 쓴다. **B5**(개인 MCP 연결): 이 문서의 단위 T6–T14로 대신한다 |
| [skills-and-mcp.md](skills-and-mcp.md) 6절 | "개인 연결의 전제": 위 B1 대신 이 문서 6절. "전송 세션"과 **S12**: 고정 단위가 (서버, 턴)에서 (서버, 턴, 단계)로, 넘어가기 한 번은 `mcp_session_subject_changed`가 아니다(5절). S12는 전송 격리(S12a)와 정책 재판정(S12b)으로 나눈다(10절). T9는 S12a에만 막힌다 |

## 10. 구현 단위

단위 하나가 티켓 하나, PR 하나다. "앞선 단위"가 티켓의 blocked-by다. 티켓 번호는 PR 본문에 있다.

| 단위 | 내용 | 끝난 조건 | 앞선 단위 |
|---|---|---|---|
| T1 proxy의 401·403 보고 (P1) | `apps/egress-proxy`의 MCP 경로 보고, control-host 인가 API의 보고 받기와 실패 receipt, worker 응답 본문의 werft 거절 코드 | proxy 시험: upstream 401·403 → 보고와 본문 코드, `www-authenticate` 없음, 보고 실패 → 지금 동작. control-host 시험: 실패 receipt 모양 | — |
| T2 egress 주체를 턴 요청자로 (P2) | `creatorOf` 세 곳, 도구 호출 감사 principal, `turns.caller_limit` 칸(migration)과 턴을 넣는 모든 경로에서 채우기, egress가 그것을 읽기 | 같은 세션에서 두 사람의 턴 → receipt actor가 각자. 첫 턴 전 요청 → 세션을 만든 사람. 릴리스 노트 | — |
| T3 서버 목록 하나: 저장과 이전 | 옮기기 migration과 명령(다시 암호화, `external`·허용 목록 밖·꺼진 행 처리, 가져온 허용 목록 칸 `imported_allowed_tools`와 그것을 없애는 콘솔 동작), egress가 옛 세션의 카탈로그 경로를 계속 받음 | 옮기기 시험(행·연결·비밀·가져온 허용 목록), 꺼진 행 → 옮기지 않고 보고, 옮긴 뒤 도구 다시 읽기로 새 도구가 생겨도 그 에이전트에 보이지 않음, 진행 중 옛 세션이 계속 호출됨, 새 세션은 워크스페이스 서버만 | — |
| T4 서버 목록 하나: 콘솔 | 목록 하나·추가 버튼 하나, 옮기기 상태(다시 연결 필요) | 화면 시험과 실제 스택 확인 | T3 |
| T5 카탈로그 경로 제거 | 카탈로그 테이블, `agent_mcp_settings`, claim 카탈로그 항목, 카드 MCP 항목 지우기(contract) | 카탈로그 경로를 받는 세션 0 확인 뒤 migration. 옛 host 호환([새 control-host와 옛 worker의 호환 계약](worker-compat.md)) | T3, T4 |
| T6 연결 subject 넓히기 | CHECK, owner_ref, 조회·잠금·비밀·receipt `generation`이 subject를 관통 | 세 subject의 저장·읽기·끊기 시험, 기존 `workspace` 행 그대로 | T3 |
| T7 agent 연결과 고르는 순서 | 에이전트 관리자의 연결(콘솔 에이전트 설정), egress의 agent → workspace 순서와 단계 receipt, caller limit을 모든 단계에 | 순서 시험(agent 있음·없음·needs_reauth), limit 밖 서버 → 모든 단계 거절 | T2, T6 |
| T8 personal 연결 | 본인 OAuth·bearer 흐름, 내 연결 화면, 어드민 끊기, `cutOff`·서버 삭제·에이전트 삭제 때 끊기, RFC 7009 폐기(commit 뒤, 대기 행) | 본인 흐름, 남이 만들 수 없음, 탈퇴 → 모두 끊기고 폐기 요청 | T6 |
| T9 권한 오류와 넘어가기 | 5절 전체(처음부터 personal인 경우 포함): 401 갱신 한 번, (서버, 턴, 단계) 고정과 한 번·한 방향, relay 멈춤·client 새로 만들기·한 번 재시도(Claude·Codex), 호출 id, 재시도 receipt와 실패 receipt 잇기, 전송 묶음 기록의 subject | 401·403 → 넘어감, 타임아웃·5xx·`isError` → 넘어가지 않음, 같은 실패에 두 번째 재시도 거절, 한 턴 두 번째 넘어가기 없음, 다음 턴 다시 agent·workspace부터 | T1, T7, T8, S12a |
| T10 확인 ① 사용 확인 | `personal_mcp_use` 요청, 요청자만 답함, Slack ephemeral 카드와 콘솔 카드, (세션, 사람) 승인 행, 끄기 두 곳(카드 버튼, 콘솔 세션 화면), 개인 연결이 없을 때 한 번 안내 | 요청자 아닌 승인자 → 거절, 만료 → 원래 오류, 같은 세션 두 번째 넘어가기 → 묻지 않음, 새 세션 → 다시 물음, 끈 뒤 다음 호출 → agent·workspace만 | T9 |
| T11 확인 ③과 컨텍스트·기록에서 빼기 | `personal_mcp_post`, 보류 revision(승인 대기 checkpoint와 멈춘 worker의 승격 포함), 넘어간 뒤 그 턴의 span content 끄기, 보내기·보내지 않음·24시간, 다른 사람 턴 줄 서기, 다시 만들기 턴(새 엔진 실행, 작업 공간 되돌림, 도구 없음, 넘어가기 전 결과만, 빠졌다는 한 줄), 6절 "기록에서 지우기" 표, 보류 이벤트, 개인 턴의 위임 거절 | 보내지 않음 → 다음 턴 컨텍스트·세션 이벤트·mirror·작업 공간에 개인 결과 없음(fake 모델로 확인), 다시 만들기 턴에서 도구 호출 0, 보내기 → 다음 턴이 봄, 기다리는 동안 다른 사람 턴이 시작하지 않음, ③을 기다리는 중 worker를 죽임 → pointer가 개인 턴 앞에 남음, content mode `full`에서 넘어간 뒤 span에 답·도구 결과 속성 없음 | T10 |
| T12 확인 ② 다른 서버 호출 | `personal_mcp_outbound`, egress와 push 경로의 개인 턴 검사, (턴, 서버) 허락, 인자 미리보기와 답 뒤 지우기, 게시 확인의 "이미 외부로 나간 것" 줄 | 개인 턴의 다른 서버 첫 호출 → 멈춤(agent·workspace 연결, 다른 서버의 personal 재시도 모두), 허락 → 같은 서버 다시 묻지 않음·새 서버는 물음, 거절·24시간 → 도구 오류, 넘어가기 전 호출 → 묻지 않음 | T11 |
| T15 지우기 장부와 복원 | 보류 object에 hold를 늦게 걸기와 모든 version 지우기, 지우기 장부(object store 별도 prefix), 복원 뒤 다시 적용(`personal_erasure_restoring`), 본인 화면의 "N건 지웠습니다" 줄, 운영 문서(백업과 복원, 데이터 보존) | 복원 훈련 시험: 보내지 않음 → 백업 → 복원 → 재적용 전 그 세션 읽기 거절, 재적용 뒤 이벤트·object version 없음. 보류 중 백업 → 복원본에서 보내지 않음 | T11 |
| T13 E2E | 시험용 MCP 서버가 401·403을 내게 하고 로컬 스택에서 workspace → personal 넘어가기, mock Slack의 세 확인, 보내지 않음 뒤 컨텍스트와 기록, 시험 collector의 span에 개인 결과 없음 | 로컬 스택에서 전 과정, token이 worker 환경·로그·API 응답에 없음 | T12, T15 |
| T14 personal 켜기 | 아래 "켜기 울타리": 설치 설정의 최소 control-host 버전과 contract migration, worker capability `personal_mcp`, 켜기 설정 | 울타리 앞의 옛 host가 보류 revision을 pointer로 올리는 경로에서 오류로 실패하는 시험, capability 없는 worker가 claim한 세션 → personal 단계 없음, 켜기 전 → T8의 연결은 만들 수 있어도 egress가 personal을 고르지 않음 | T13, T15 |

**켜기 울타리.** T8–T12는 personal을 쓰는 길을 하나씩 만든다. 그 사이의 배포에서 personal이 고객 요청에 쓰이면, 확인과 컨텍스트 빼기가 없는 채로 개인 결과가 채널에 나간다. 그래서 정한다.

- T8–T13 동안 egress의 personal 단계는 코드로 꺼져 있다. 연결 화면(T8)은 열려도 egress가 personal을 고르지 않는다. 켜기는 T14 하나다.
- **섞인 버전.** 옛 control-host replica는 보류 revision을 모르고 checkpoint를 그대로 pointer로 올리며, 옛 Slack 경로는 요청자 확인을 모른다. 코드 안의 버전 확인으로는 옛 host를 막을 수 없으므로 [접근 판정](access-decisions.md) 10절과 같은 DB 울타리를 쓴다. 운영자가 모든 host를 호환 릴리스로 올린 뒤 설치의 최소 control-host 버전을 올리고, 그 올림이 옛 host의 checkpoint 승격·확인 답 경로가 읽는 것을 contract하는 migration과 함께 간다. 켜기 설정은 최소 버전이 호환 버전 이상일 때만 저장된다.
- **worker.** relay의 멈춤·다시 보내기·client 새로 만들기, 보류 revision, 다시 만들기 턴은 worker 쪽 일이다. 이것을 모두 하는 worker는 capability `personal_mcp`를 알린다. 알리지 않은 worker가 claim한 attempt에서는 egress가 personal 단계를 고르지 않는다(닫힌 쪽, agent → workspace까지). [새 control-host와 옛 worker의 호환 계약](worker-compat.md)의 capability 방식이다.
- 켠 뒤 되돌리기(최소 버전 아래로 내리기)는 지원하지 않는다. 보류 중인 revision과 이벤트의 보호를 옛 host가 모르기 때문이다.

**같이 진행할 수 있는 것.** T1(`apps/egress-proxy`, control-host 인가 API), T2(`packages/db/src/sessions`·`github`의 egress 상태 읽기와 감사, `turns`의 칸 하나), T3(MCP 테이블 migration과 카탈로그 이전)은 경로가 겹치지 않아 동시에 할 수 있다. T2와 T3은 서로 다른 테이블의 migration을 하나씩 더하므로, 늦게 머지하는 쪽이 migration 번호만 다시 매긴다. T6은 T3 뒤에 migration을 더하므로 T3 다음이다. T7(egress 순서, 에이전트 설정 화면)과 T8(OAuth 흐름, 내 연결 화면, 끊기)은 T6 뒤에 동시에 할 수 있다. 둘 다 migration이 필요하면 번호가 겹치지 않게 먼저 머지한 쪽 뒤로 다시 번호를 매긴다. T4는 T6과 동시에 할 수 있다(콘솔과 DB). T10–T12는 같은 요청 종류·카드·egress 판정을 차례로 넓히므로 순서대로 한다.

**밖의 단위와의 관계.** T9는 다른 계정의 MCP 상태를 이어 쓰지 않게 하는 전송 격리가 먼저 있어야 한다. 지금 relay는 프로세스 안에서 서버마다 upstream client 하나를 계속 쓰기 때문이다(`remote-mcp.ts:65-79`, `mcp-relay.ts:69-89`). 그 일은 [스킬과 MCP 서버](skills-and-mcp.md)의 S12에 있는데, S12는 정책 규칙의 재판정까지 묶어 [접근 판정](access-decisions.md) A4·B2에 막혀 있다. 이 문서의 순서는 규칙이 아니라 고정 기본이므로 T9에 규칙은 필요 없다. 그래서 S12를 둘로 나눈다.

| 단위 | 내용 | 앞선 단계 |
|---|---|---|
| S12a 전송 격리 | (서버, 턴, 단계)의 subject·`generation` 고정과 요청·`regrant`마다 비교, `Mcp-Session-Id`를 연 subject에 묶기(proxy가 upstream이 준 id와 요청의 id를 인가 요청에 싣는다), 2026-07-28 개정의 요청별 비교와 `subscriptions/listen` 묶음, 목록 캐시를 (subject, `generation`)마다 나누기, relay 재시작(Claude·Codex) | S5, S11 |
| S12b 정책 재판정 | 고정한 subject를 정책 규칙의 매 요청 재판정과 맞추기: 규칙이 다른 subject를 요구하면 `mcp_session_subject_changed`, 턴 도중 규칙 삭제 → 다음 요청 거절 | S12a, A4, B2 |

T9는 S12a에 막힌다. [접근 판정](access-decisions.md) B5는 T6–T14로 대신하고, B5가 막혀 있던 B1은 개인 연결 경로에서 빠진다(9절).

## 11. 설계 중 오너 결정 (2026-11-22)

사양이 정하지 않은 제품 동작을 물었고, 오너가 1–6은 추천대로, 7은 "턴당 한 번 묶어 묻기", 8은 "지우고 본문 없는 기록만"으로 정했다.

| 질문 | 결정 | 자리 |
|---|---|---|
| 1. 사용 확인 승인은 어디까지 유효한가 | 그 세션 안에서만. 같은 세션의 본인 턴은 다시 묻지 않고, 새 세션에서는 다시 묻는다 | 5절 "턴 안의 고정", 6절 ①, T10 |
| 2. 끄는 곳 | 확인 카드의 "개인 연결 그만 쓰기" 버튼과 콘솔 세션 화면. 끄면 다음 호출부터 agent → workspace만 | 6절 ①, T10 |
| 3. 콘솔 턴도 확인을 받나 | 받는다. 같은 카드 | 6절, T10–T12 |
| 4. 게시 확인에 답이 없으면 | 24시간 뒤 "보내지 않음". 기다리는 동안 같은 세션의 다른 사람 턴은 뒤로 줄을 선다 | 6절 ③과 "컨텍스트와 기록에서 빼기", T11 |
| 5. 다시 만든 답에 알리나 | 내용 없이 한 줄: "요청자의 개인 연결 결과는 빠졌습니다" | 6절 ③, T11 |
| 6. 권한 오류인데 개인 연결이 없으면 | 원래 오류를 에이전트에 그대로 주고, 본인에게만 "개인 연결을 만들면 쓸 수 있다"는 안내(콘솔 링크)를 한 번 | 5절 "넘어가기" 2단계, T10 |
| 7. 개인 턴의 다른 서버 호출 | 처음 한 번 멈추고 본인에게만 카드(서버, 도구, 인자 첫 몇 줄). "이 턴에서 허락"이면 그 턴 동안 같은 서버는 다시 묻지 않고 새 서버만 묻는다. 거절·24시간 무응답이면 도구 오류, 에이전트는 그것 없이 계속. 허락했으면 게시 확인에 "이미 외부로 나간 것" 한 줄 | 6절 ②, T12 |
| 8. "보내지 않음" 뒤 본인이 그 개인 턴을 다시 볼 수 있나 | 못 본다. werft의 모든 저장 위치에서 본문을 지우고 본문 없는 감사 기록만 남긴다. 본인 화면에는 "개인 연결 결과 N건은 보내지 않아 지웠습니다" 한 줄. 백업은 지우기 장부로 복원 뒤 다시 지운다 | 6절 "기록에서 지우기", T11 |

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
