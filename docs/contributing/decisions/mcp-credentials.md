# 결정(설계안): MCP 서버의 자격 주체, OAuth, 토큰 단위, 비밀 값 범위, 서버 등록 권한

- 상태: 설계안. 오너 확인 전이다. 코드는 바꾸지 않았다.
- 배경 문서: [번들 stdio MCP 서버를 worker relay 뒤에 둔다](stdio-mcp-relay.md), [에이전트 행동 도구 카탈로그](action-broker.md), [surface·action 모듈](surface-action-modules.md), [패키지 구조](package-structure.md), [설정을 파일에서 DB로](settings-replace-file-catalog.md).
- 기준: `origin/main` `6494d6029`. 파일 이름은 이 커밋에서 읽었다.

## 오너 질문에 대한 답

질문: MCP 도구를 도구 단위로 막는 것이 Bash 같은 도구 제한처럼 정책으로 관리되는가, 조직·에이전트 단위로 지정할 수 있는가, MCP 추가·관리와 인증정보 활용은 설계됐는가.

1. **도구 단위 차단은 이미 정책이다.** `mcp__서버__도구`는 워크스페이스·에이전트·설치(관리자 deny)의 deny 목록에 Bash 규칙과 같은 목록으로 들어가고, egress가 호출마다 집행한다. 하나라도 deny하면 막힌다. MCP 도구의 허용은 "서버의 워크스페이스 허용(카탈로그) ∩ 세션 시작 때의 에이전트 도구 ∩ 지금 에이전트 설정 − deny"이다. 워크스페이스에는 MCP 도구 allow 목록이 없다(엔진 권한의 allow 교집합은 MCP 경로에 적용되지 않는다). 프로필 제거(이 문서의 기준 커밋 뒤에 머지됨)로 입력원이 옮겨졌어도 판정 함수는 그대로다.
2. **비어 있던 것은 "서버 통째" 차단이다.** 지금 deny는 도구 이름을 하나씩 적어야 한다. 이 문서가 `mcp__서버__*` 규칙을 더하기로 정한다(결정 5). 워크스페이스 도구 allow 목록은 만들지 않는다(deny로 좁히면 충분하고, 목록을 하나 더 두면 서버가 도구를 늘릴 때마다 막힌다).
3. **추가·관리는 지금 이렇게 나뉜다.** 서버 등록은 설치 owner만 한다. 에이전트 관리자는 그 워크스페이스에 허용된 서버 중에서 고르고 도구를 좁힌다. 이 문서는 워크스페이스 admin이 서버를 직접 등록하는 것은 이번에 열지 않고 열 조건을 적는다.
4. **인증정보는 설계가 없던 부분이다.** 지금은 서버마다 에이전트 서비스 계정 bearer 하나이고 값은 egress proxy만 본다. 이 문서가 정한다: 주체는 에이전트로 고정하고, OAuth는 에이전트 주체로 먼저 만들며, 요청자 본인의 자격은 조건이 오면 한다. 서버를 여러 개 쓸 때는 서버마다 egress token을 따로 낸다. 설치 단위 비밀 값은 워크스페이스에서 떼어 설치 범위로 옮긴다.

## 지금 있는 것

- **등록.** 원격 서버는 DB 행 `mcp_servers`이고 설치 owner(`installation.settings.manage`)만 만든다. 행은 `url`, `credential_ref`, bearer 값, 허용 `workspaces`(slug)를 묶고 url과 자격은 제자리에서 바꾸지 않는다. 값은 `secret_values`(owner_ref `mcp:<id>`) 또는 외부 참조(`secret_id`)다.
- **선택.** 에이전트 관리자가 에이전트 MCP 설정(`agent_mcp_settings`)에 서버 하나, 허용 도구, `credential_refs`를 저장한다. 고를 수 있는 서버는 워크스페이스 slug가 `workspaces`에 있는 것이다. 에이전트 카드의 `capabilities.mcp`는 서버 하나(`max(1)`)이고, 카드에서 이 필드를 빼는 일은 아직 하지 않았다.
- **집행.** `packages/platform/src/workers/mcp-egress.ts`가 egress마다 세션 상태를 다시 읽는다: 서버가 release의 것인지, 카탈로그 binding이 claim 때와 같은지, 에이전트에 자격 binding이 살아 있는지, 워크스페이스가 허용됐는지, JSON-RPC 메서드와 도구가 허용인지. 거절은 receipt를 남긴다. 값은 `mcpUpstreamOf`가 `Authorization: Bearer`로 만들어 proxy에 돌려준다. worker는 attempt 범위 token만 갖는다. worker 쪽 연결은 `apps/worker/src/composition.ts`의 `mcpServersOf`다.
- **deny.** `visibleMcpTools`(`packages/platform/src/sessions/mcp-tool-decision.ts`)가 원격 서버의 claim 도구 집합과 egress의 `tools/call` 판정을 같은 함수로 낸다. 일치는 정확 이름이다. 내장 `github` 서버는 이 함수가 아니라 `mcpCallDenied`(`engine-settings-merge.ts`)로 막고, 이것도 정확 일치다. 즉 deny 해석이 두 곳이다.
- **분기.** `authorizeMcpEgress`(`worker-gateway.ts`)는 요청의 서버 이름이 `github`인지로 분기하고, 내장 `github` 쪽은 token의 binding을 대조하지 않는다. 판정은 세션 상태로 하므로 지금은 세션이 가진 권한 밖으로 나가지 않지만, 서버별 token(결정 3)에서는 이 분기도 token의 서버와 맞춰야 한다.
- **claim 크기.** claim의 `mcp_servers` 배열은 `max(2)`(원격 하나와 내장 `github`)다(`packages/contracts/src/worker-protocol/index.ts`).
- **token.** egress token은 `(attempt_id, purpose)`마다 살아 있는 것이 하나다(`worker_credentials_live_purpose_idx`). MCP token은 세션의 서버 하나에 묶인다.
- **없는 것.** 요청자 자격, MCP OAuth, 사용자·워크스페이스 비밀 값 주입, 연동 계정의 토큰 보관(`linked_accounts`는 신원만 갖고 토큰을 보관하지 않는다)은 없다.

## 결정 1. 자격 주체: 에이전트로 고정한다 (a)

**결정.** 원격 MCP 호출의 자격 주체는 에이전트(서비스 계정)다. 세션이 시작할 때 주체가 정해지고 세션이 닫힐 때까지 바뀌지 않는다. 지금은 주체가 에이전트 하나뿐이므로 컬럼을 만들지 않는다(YAGNI). 요청자 주체를 만드는 단위가 `mcp_credential_subject`(`agent` | `requester`, 기본 `agent`, 만든 뒤 수정 불가)를 더하고 claim binding과 checkpoint fingerprint에 넣는다.

**요청자 주체의 조건(LATER).** 한 세션의 transcript는 여러 요청자의 턴이 같이 읽는다([action-broker.md](action-broker.md)의 요청자 귀속). 사람 A의 Drive에서 읽은 내용이 B의 턴에 그대로 나타날 수 있다. 그래서 요청자 주체는 "세션을 시작한 사람 한 명의 턴만 받는 세션"에서만 허용하고, 다른 주체의 턴이 오면 거절한다(fail closed). 턴마다 주체를 바꾸는 방식은 쓰지 않는다.

**버린 대안.**

- 턴마다 요청자 자격: attempt에 묶인 token과 binding이 턴마다 달라지고, 사람 사이에 데이터가 새며, 한 턴 안에서 자격이 섞인다.
- 에이전트·요청자 둘을 같은 서버에 같이 허용: receipt에 주체를 적으면 증명은 가능하다. 그래도 호출마다 어느 쪽 권한으로 갈지를 고르는 정책 표면이 생기고, 모델이 도구 인자로 그 선택을 흔들 수 있다. 세션 시작 때 하나로 고정하는 쪽이 작다.
- 지금 컬럼부터 만들기: 값이 하나뿐인 컬럼은 요청자 단위가 오기 전까지 죽은 코드다.

**계약 시험(요청자 단위가 정의한다).** 주체가 `requester`인 세션에 다른 사람의 턴이 오면 거절, 세션 중간에 주체를 바꾸는 쓰기 경로가 없음, 주체가 binding에 들어 있어 바뀌면 token이 거절됨.

## 결정 2. MCP OAuth (b)

**결정.** OAuth는 에이전트 주체로 먼저 만든다. 흐름은 전부 control-host가 하고 worker와 engine은 OAuth를 모른다.

- **무엇을 위임하는가.** 동의는 사람이 로그인한 외부 계정의 권한을 공유 에이전트에게 주는 일이다. 플랫폼은 그 계정이 서비스 계정인지 확인할 수 없다. 그래서 이 설계는 "개인 자격의 공유 위임"일 수 있음을 인정하고, 막는 장치를 셋 둔다: (1) 서버 행이 허용 tenant(있으면)와 요청할 scope 목록을 고정한다. 받은 scope가 그 목록보다 넓거나 tenant가 다르면 연결을 거절한다. (2) 연결 화면이 동의한 사람과 상대 시스템의 계정 식별자를 보이고 receipt에 남긴다. (3) 동의한 사람이 오프보딩되면 그 사람이 만든 연결은 철회하고(`revoked_reason: consenter_offboarded`) 다시 연결해야 한다. 에이전트가 멈추는 비용을 받아들이고 사람의 권한이 남는 쪽을 닫는다.
- **권한.** 연결·끊기는 `agent.manage`이고, 콜백이 끝날 때 현재 권한을 다시 검사한다. 쓰는 쪽은 사람이 아니라 세션의 egress다.
- **동의 흐름.** authorization code + PKCE(S256). 상태값은 (에이전트, 서버, 로그인 세션)에 묶고 redirect URI는 API 호스트 하나로 고정한다.
- **목적지.** 서버 행의 `auth`를 bearer 하나에서 `bearer` | `oauth`의 합집합으로 넓힌다. `oauth`는 issuer, authorization·token·(있으면) revocation endpoint, scope 목록, `resource`(RFC 8707)를 설치 owner가 행에 적고, url처럼 제자리에서 바꾸지 않는다. endpoint는 모두 https이고, control-host의 OAuth 요청도 proxy와 같은 검사를 지난다: DNS 해석 뒤 사설 주소 거부, redirect 금지, 짧은 timeout. 이 호출들은 `packages/platform`의 공용 검사 함수 하나로 모아 proxy와 control-host가 같은 규칙을 쓴다. 발급받은 token은 행의 `resource`에 묶인 것만 받는다.
- **클라이언트.** OAuth client id·secret은 설치 owner가 서버 행과 같이 등록한다(결정 4의 설치 범위). 동적 클라이언트 등록(DCR)은 쓰지 않는다. DCR은 신뢰할 수 없는 서버의 메타데이터를 따라가야 하므로 위의 고정 목적지 계약과 양립하지 않는다. 호환성 때문에 필요해지면 LATER의 별도 선택으로 둔다.
- **저장과 연결 상태.** refresh token과 access token은 `secret_values`에 암호화해 둔다(owner_ref `mcp-oauth:<server>:agent:<agentId>`, 결정 4의 범위). 따로 연결 행 `mcp_oauth_connections`(서버, 에이전트, `generation`, 상태 `pending` | `active` | `needs_reauth` | `revoked`, 동의한 사람, 외부 계정 식별자, 받은 scope)를 둔다. 로그·이벤트·receipt `result`에는 값이 없다.
- **갱신.** control-host만 갱신하고, 연결 행을 `FOR UPDATE`로 잠근 채 한 번에 하나만 한다. 보장 범위는 이렇다. 새 refresh token을 받은 뒤 commit 전에 프로세스가 죽거나 commit이 실패하면, IdP가 옛 token을 이미 무효화했다면 새 token을 잃는다(외부 IdP까지 원자화할 수 없다). 그 경우 다음 갱신이 `invalid_grant`를 받아 연결이 `needs_reauth`가 되고 사람이 다시 연결한다. 회전하지 않는 IdP에는 해당 없다. access token은 만료 60초 전까지, 최대 5분 authorizer 응답에 실어 proxy가 쓴다.
- **실패.** `invalid_grant`는 `needs_reauth`로 두고 거절한다(reason `oauth_needs_reauth`, receipt). 저장소·IdP 장애도 거절이다(`credential_unavailable`). 재시도 폭주를 막으려고 연결마다 backoff를 둔다.
- **연결 상태 전이.** 연결 행의 상태는 `pending` | `active` | `needs_reauth` | `revoked`이고 `generation`을 가진다. 연결·재인증을 시작하면 행을 잠그고(없으면 만들고) `generation`을 하나 올려 그 값을 이 시도에 예약하며 상태를 `pending`으로 둔다(토큰 없음, egress는 거절). 콜백은 상태값에 실린 예약 `generation`이 행의 현재 값과 같고 상태가 `pending`일 때만, 한 transaction에서 token 저장과 `active` 전환을 한다. 그러므로 새 시도가 이전 시도의 늦은 콜백을 무효로 만들고, 콜백 순서가 뒤바뀌어도 마지막 시도만 이긴다.
- **갱신 저장.** 갱신은 시작 때의 `generation`이 같고 상태가 `active`일 때만 값을 저장한다. `invalid_grant`는 같은 조건에서 `needs_reauth`로 바꾼다.
- **철회.** 연결 끊기·서버 비활성화·에이전트에서 자격 해제·동의한 사람의 오프보딩은 한 transaction에서 `generation`을 올리고 상태를 `revoked`로 바꾸고 비밀 행을 지운다. 철회 전에 시작한 콜백과 갱신은 `generation`이 달라 저장하지 못하므로 철회가 되살아나지 않는다. 그다음 RFC 7009 철회를 best-effort로 부른다. `revoked`나 `needs_reauth`에서 다시 연결하면 위의 새 시도가 된다.
- **차단 시간.** egress는 매 authorize마다 연결 행의 상태를 DB에서 읽는다(설정 snapshot이 아니다). 정상 철회는 그 연결의 다음 authorize에서 거절된다. 이미 열린 스트림은 proxy의 다음 재검사(`regrant`)에서 끊긴다. 재검사는 30초 주기의 timer가 돈 뒤 authorizer 응답을 기다리므로(`watchGrant`), 끊기는 시점은 "30초 + authorizer 응답 시간"이고 엄격한 상한이 아니다. authorizer가 답하지 못하면 proxy는 마지막으로 성공한 grant로부터 90초(`DEFAULT_REGRANT_GRACE_MS`)가 지난 뒤의 재검사에서 끊는다. 엄격한 상한이 필요해지면 proxy의 deadline 집행을 구현 범위에 추가해야 하고 이 설계는 그것을 약속하지 않는다. 이미 upstream으로 간 요청은 끝까지 실행된다.
- **engine.** proxy가 upstream 401을 403으로 바꾸고 `www-authenticate`를 지우는 규칙을 유지한다. engine이 OAuth 탐색을 하지 못하게 하는 장치다.

**버린 대안.** worker가 OAuth를 하고 token을 들게 함(통과 기준 "worker 환경과 로그에 토큰 없음"을 깬다). proxy가 갱신함(proxy는 DB 쓰기가 없고, 회전하는 refresh token을 원자적으로 쓸 수 없다). DCR(위). 동의한 사람의 개인 연결을 에이전트가 공유함으로 두고 안내문만 붙임(확인할 수 없는 안내는 장치가 아니다. 위의 세 장치로 바꿨다).

**자격 해석 포트(DIP, ISP).** 소비자인 egress(`packages/platform/src/workers`)가 읽기 포트를 소유한다. 연결을 만들고 끊는 관리 쪽은 별도 포트(`McpConnectionAdmin`, 콘솔 라우트가 소비)로 나눈다. egress는 관리 권한 없이 값을 소비하므로 두 면을 한 인터페이스에 섞지 않는다.

```ts
// owned by the consumer (workers/mcp-egress); adapters implement it
export interface McpUpstreamCredential {
  resolve(input: {
    sessionId: string;
    server: string;
    /** From the fenced session state, never from the request. */
    agentId: string;
    workspaceId: string;
  }): Promise<
    | { kind: "bearer"; value: string }
    | { kind: "unavailable"; reason: McpRefusalReason }
  >;
}
```

구현은 정적 bearer(지금 `mcpUpstreamOf`가 하는 일을 옮긴 것)와 OAuth 둘이고, OAuth 구현은 OAuth 단위가 들어올 때 함께 만든다(구현 없는 어댑터를 미리 만들지 않는다). 설치 범위 비밀은 워크스페이스 기반 `SecretSlot` 포트로 읽지 않고, control-host 조립에서 설치 범위 읽기 전용 포트를 해석기에 주입한다. 둘이 같은 계약 시험을 지난다: 값을 못 구하면 `unavailable`이고 거절·receipt가 된다, 오류 메시지·receipt에 값이 없다, 저장소 오류는 fail closed다, 철회 뒤 시작한 resolve는 값을 주지 않는다. `McpRefusalReason`에 `oauth_needs_reauth`와 `credential_unavailable`을 더한다. 시험은 동시 갱신뿐 아니라 회전 응답 뒤 crash·commit 실패, 철회와 겹친 콜백·갱신을 포함한다.

## 결정 3. 서버가 여럿일 때 egress token 단위 (c)

**결정.** MCP egress token은 서버마다 하나 낸다. 유일 키를 `(attempt_id, purpose, scope_key)`로 넓히고 `scope_key`는 기본 빈 문자열이다(기존 행과 기존 purpose는 변하지 않는다). MCP는 서버 id, 비밀 값 주입(해당 티켓)은 비밀 이름을 `scope_key`로 쓴다. 한 에이전트의 서버는 최대 8개다. stdio 서버는 token이 없다([stdio-mcp-relay.md](stdio-mcp-relay.md)).

- binding은 서버마다 `mcpBinding`이다. 한 서버의 카탈로그가 바뀌어도 다른 서버의 호출은 영향받지 않는다.
- **token이 서버 경계다.** `authorizeEgressAtomic`의 결과에 `scope_key`를 담고, `authorizeMcpEgress`가 모든 분기(내장 `github` 포함)보다 앞에서 요청의 서버 이름을 token의 `scope_key`와 맞춘다. 내장 `github`의 token도 `scope_key = github`다. 다른 서버의 token으로 온 요청은 거절한다. 이것이 M3의 필수 시험이다: 서버 A의 token으로 `/mcp/B`와 `/mcp/github`, 그 반대를 모두 부르면 거절.
- egress 판정은 `state.server`(하나)를 `state.servers`(집합)로 바꾼다.
- checkpoint fingerprint는 서버별 binding을 쓴다(`identities.mcpServers[name]`이 이미 이 모양이다).
- **혼합 버전.** claim의 `mcp_servers` 배열은 지금 `max(2)`다. 원격 8개와 내장 `github` 하나를 합쳐 상한을 9로 올리되, 여러 서버 claim은 worker가 새 capability(`multi_mcp`, `platform_tool_trust`와 같은 방식)를 알렸을 때만 낸다. 알리지 않은 worker에는 서버가 하나인 세션만 시작하고, 여럿이면 세션 시작을 거절한다(backoff 없이 바로 멈춘다). 항목별 `access`는 이미 있어 항목 모양은 그대로다. 배포 순서는 worker 먼저다.
- **세션 스냅샷.** `sessions.mcp_start`(`mcpStartSchema`)는 non-strict이고 옛 reader는 단일 `server`를 읽는다. 새 스냅샷은 `server`에 첫 서버를 그대로 두고 `servers`를 더한다. 옛 reader는 첫 서버만 보므로 더 좁게 동작한다(fail closed). 옛 reader가 추가 필드를 무시하는 시험을 둔다.
- **DB.** `scope_key`는 NOT NULL DEFAULT ''이고 유일 인덱스를 `(attempt_id, purpose, scope_key)`로 바꾼다. 인덱스 교체는 새 인덱스를 먼저 만들고 옛 것을 지운다. 앞 이미지는 `scope_key` 열을 쓰지 않고 purpose당 하나를 가정하므로, 서버가 여럿인 세션이 생긴 뒤의 롤백은 지원하지 않는다(그 기능을 켜기 전까지만 되돌릴 수 있다).

**버린 대안.**

- 집합 하나에 token 하나: 한 서버의 binding 변경이 전체를 거절하고, 서버 하나만 철회·교체하지 못한다.
- 요청마다 서명한 grant(내장 `github` 서버 방식): 철회를 보려면 어차피 요청마다 DB를 읽어야 하고, 서명 키를 쓰는 곳이 하나 더 는다.
- worker 안 relay마다 별도 프로세스·키: token은 같은 worker 메모리에 있으므로 경계가 늘지 않는다.

이 결정은 서비스 계정 설계에서 "나중에" 둔 서버 여러 개 문제를 닫고, 비밀 값 주입 티켓의 "token N개 vs 이름별 grant" 질문에도 같은 답을 준다.

## 결정 4. 설치 소유 비밀 값의 범위 (d)

**문제.** `secret_values.workspace_id`는 NOT NULL이다. 설치 단위 설정(`connection:`·`repository:`·`mcp:`)은 기본 워크스페이스 아래에 둔다. 이것은 워크스페이스가 하나라는 가정에 기댄 것이고, [설정 DB 결정](settings-replace-file-catalog.md)이 "둘 이상이 되는 날 설치 소유 범위를 따로 둔다"고 미뤘다.

**결정.** `secret_values`에 `scope`(`workspace` | `installation`)를 더하고 `workspace_id`를 nullable로 바꾼다. CHECK로 `scope = 'installation'`일 때만 `workspace_id`가 NULL이게 한다. 유일 키는 범위별 부분 인덱스 둘이다. 워크스페이스 API는 `workspace_id = $1`로만 읽으므로 설치 행은 기본으로 보이지 않는다. 설치 행을 관리하는 API는 `installation.settings.manage`만 접근하고, 값을 쓰는 쪽(egress의 자격 해석기, 설정 조립)은 사람의 권한이 아니라 검증된 세션 상태로 설치 범위 읽기 전용 포트를 통해 읽는다. 기존 `connection:`·`repository:`·`mcp:` 행은 설치 범위로 옮긴다.

- **암호문은 SQL로 옮길 수 없다.** 암호문의 AAD가 행 `id`, `workspace_id`, `owner_ref`, `purpose`, 버전을 묶고(`secretAad`), 복호화에 실패한 행은 읽기에서 조용히 빠진다(`openSecretsOf`). `workspace_id`를 NULL로 바꾸기만 하면 값은 열리지 않고 연결이 "값 필요"가 된다. 그래서 AAD에 범위를 넣은 v2를 만들고, 옮김은 앱 코드(재시작 가능하고 되풀이해도 같은 결과인 backfill)가 한다: v1 AAD로 풀어 v2 AAD로 새 행에 다시 암호화하고, 새 행을 다시 복호화해 맞는지 확인한 뒤에만 다음 단계로 간다. 이 작업은 마스터 키가 있는 control-host 프로세스만 한다.
- **세 단계, 단계마다 쓰기 위치와 롤백 가능 버전을 정한다.**

| 단계 | 쓰기 | 읽기 | 지원하는 롤백 |
|---|---|---|---|
| R1 컬럼·인덱스·이전 단계 값(`dual`) 추가, 읽기·쓰기 규칙 도입 | **기존 행은 읽은 곳에 쓴다**(설치 행이 있으면 거기). **새 행은 이전 단계 값이 정한 곳에 만든다**: `dual`이면 옛 위치, `installation`이면 설치 위치. 옛 위치에는 v1 AAD로 쓴다 | 설치 행 먼저, 없으면 옛 행. 두 AAD 모두 | R0(앞 이미지), 단계 값이 `dual`이고 설치 행이 없을 때만. 옛 위치는 v1이라 R0이 읽는다 |
| R2 이전 단계를 `installation`으로 바꾸고 backfill | 새 행은 설치 위치(v2). 기존 행은 위 규칙. backfill이 옛 행을 설치 행으로 복사한다(옛 행은 둔다) | 위와 같음 | R1까지. R0은 낡은 옛 행을 읽으므로 지원하지 않는다 |
| R3 옛 행 삭제 | 설치 행 | 설치 행 | R1까지(R1은 설치 행을 먼저 읽고 새 행도 이전 단계 값에 따라 설치 위치에 만든다) |

  - **롤백은 이미지만 되돌린다.** 영속 이전 단계 값은 이미지를 되돌려도 그대로다. R0 롤백은 단계 값이 `dual`이고 설치 행이 하나도 없을 때만 지원한다(표의 R1 행 설명은 이 조건 아래에서만 성립한다).
  - **전환과 쓰기의 직렬화.** 새 행을 만드는 writer는 같은 transaction 동안 이전 단계 행을 공유 잠금(`FOR SHARE`)으로 잡고 그 값으로 위치를 고른다. 단계 전환(`dual` → `installation`)은 같은 행을 배타 잠금(`FOR UPDATE`)으로 잡아 진행 중인 writer가 끝나기를 기다린 뒤 값을 바꾼다. backfill과 "옛 위치에만 있는 행 0건" 훑기는 전환이 commit된 뒤에 시작한다. 그래서 `dual`을 읽고 멈춘 writer가 전환 뒤에 옛 위치에 commit하는 순서가 없다. 시험: 전환 직전에 시작한 생성·재생성이 지연 commit하는 상황.
  - **이전 단계 값**은 DB에 하나만 있는 영속 값(`dual` | `installation`)이고 행의 존재와 무관하다. 그래서 backfill 뒤에 R1·R2 이미지가 새 자격을 만들거나 지운 자격을 다시 만들어도 `installation` 단계에서는 설치 위치에 생긴다. **R3 시작 조건:** (1) 배포 capability 기록이 모든 인스턴스의 R1 이상을 보임, (2) 이전 단계 값이 `installation`이고 그 뒤 옛 위치에만 있는 행을 찾는 훑기 결과가 0건(있으면 backfill을 다시 돌린다). 시험: 새 생성, 삭제 뒤 재생성, R3→R1 롤백 뒤 새 생성, R1 쓰기→R0 읽기.

  - **잠금.** 설치 범위에 올 수 있는 owner_ref(`connection:`·`repository:`·`mcp:`·`mcp-oauth:`)는 `lockSlot`의 키를 `workspace_id`와 무관하게 `(owner_ref, purpose)`로 잡는다. 두 위치에 쓰는 이미지들이 같은 잠금으로 직렬화된다. 삭제는 잠금 안에서 두 행을 다 지운다.
  - **A→B 시험.** 설치 행에 값 A가 있고 R1 이미지가 회전해 B를 쓰면 설치 행이 B가 된다(읽은 곳에 쓴다). R1·R2 혼합 배포에서도 같다. 삭제한 자격이 R1 이미지에서 되살아나지 않는다.
  - **R2 시작 조건.** 모든 살아 있는 control-host가 `secret_scope_v1` capability를 갖고 있음을 아래 배포 capability 기록으로 확인한다. R0 이미지가 R2 이후 다시 들어오는 일은 지원하지 않는다고 운영 문서에 적고, 기록이 그 위반을 화면에 드러낸다([설정 DB 결정](settings-replace-file-catalog.md)이 같은 범위의 파괴적 변경을 오너가 허용했다).
- **배포 capability 기록.** control-host 프로세스는 기동할 때와 주기적으로 (인스턴스 id, capability 목록, 마지막으로 본 시각)을 작은 테이블 `control_host_instances`에 쓴다. 쓰는 곳은 이것 하나이고 읽는 쪽은 "모든 인스턴스가 X를 갖고 있는가"를 묻는 포트 하나다. 설정 generation은 변경 순서일 뿐 실행 이미지의 능력을 증명하지 않으므로 쓰지 않는다. 기록하지 않는 구버전은 기록에 보이지 않으므로, gate는 기록된 인스턴스만이 아니라 **기대 개수**와 대조한다.
  - **기대 개수.** 배포 설정이 기대 replica 수를 주입한다(helm은 `api.replicas`, 비밀 값을 읽고 쓰는 다른 control-host 역할이 있으면 역할별로 따로, compose는 1). 기대 수는 배포 세대(릴리스 revision)와 함께 기록해 같은 세대의 값만 쓴다. gate는 그 세대에서 최근에 본 인스턴스의 수가 기대 개수와 정확히 같고 모두 capability를 가졌을 때만 참이다. 기록이 비었거나, 기대보다 적거나, 많거나(롤링 중), 세대가 다르거나, 읽을 수 없으면 거짓이다.
  - **증명할 수 없는 것.** 기록하지 않는 구버전이 기대 개수와 겹치는 경우(기대 1에 새 인스턴스 하나와 미등록 구버전 하나)는 앱 안의 기록으로 구별할 수 없다. 이 설계는 그것을 증명한다고 주장하지 않는다. 개수 대조는 필요조건이고, 되돌릴 수 없는 단계는 운영자 명령이 롤아웃 완료(구버전 종료)를 확인했다는 표시(`--rollout-complete`)와 함께 시작한다. 명령은 시작 전에 기록과 기대 수를 출력한다. 이 확인은 절차가 하는 일이며, 어긴 경우의 책임은 절차에 있고 시스템이 막지 못한다고 운영 문서에 적는다.
  - **부트스트랩.** 기록 기능을 가진 첫 이미지(M0b)가 모든 replica를 교체한 뒤에야 gate를 쓰는 단계를 시작할 수 있다.
  - **한계.** 이 기록은 되돌릴 수 없는 단계(R2, 와일드카드 저장)를 시작하는 순간의 확인이다. 그 뒤에 옛 이미지가 돌아오는 것은 막지 못하고 기대 개수 불일치로 드러낼 뿐이므로 해당 롤백은 지원하지 않는다고 명시한다.
- **워크스페이스·에이전트 비밀 값**(비밀 값 주입 티켓)은 `scope = 'workspace'`, owner_ref `workspace:<이름>`·`agent:<id>:<이름>`이다.
- **같은 서버에 워크스페이스마다 다른 자격**이 필요하면 서버 id를 따로 만든다(`workspaces` 목록이 다른 두 행). 서버 행에 워크스페이스별 자격을 얹지 않는다(url·자격이 한 행에 묶여 바뀌지 않는 성질을 지킨다).

**버린 대안.** 기본 워크스페이스에 계속 둠(워크스페이스 삭제·보관, 소유 혼동, 워크스페이스 API에 새는 면). 별도 테이블 `installation_secret_values`: 암호 함수(`secret-cipher.ts`)는 재사용할 수 있으므로 암호화 코드가 둘이 되는 것은 이유가 아니다. 진짜 비용은 slot 잠금·last4·키 회전 훑기·reaper를 가진 저장소 코드(`secret-values.ts`)가 두 벌이 되는 것이다. nullable 범위 방식의 비용은 위의 AAD v2와 3단계 이전이다. 이전 비용은 한 번이고 저장소 코드 두 벌은 계속 남으므로 nullable을 고른다. 예약된 UUID를 가진 가짜 워크스페이스(FK는 맞추지만 "워크스페이스 목록"에 새는 경로가 생긴다).

## 결정 5. 서버 등록·선택 권한과 deny 정책 (e)

**결정.**

| 층 | 누가 | 무엇을 | 상태 |
|---|---|---|---|
| 등록 | 설치 owner | 서버 행(url, 자격, 허용 워크스페이스). url·자격은 새 id로만 바꾼다 | 그대로 |
| 보이는 범위 | 설치 owner | 행의 `workspaces` | 그대로 |
| 워크스페이스 정책 | 워크스페이스 admin | 워크스페이스 deny 목록: 도구(`mcp__서버__도구`)와 **서버 통째**(`mcp__서버__*`) | 서버 통째가 새로 생김 |
| 에이전트 선택 | 에이전트 관리자 | 에이전트 MCP 설정: 서버, 허용 도구, 에이전트 deny | 그대로(서버 여럿은 결정 3) |
| 집행 | egress | 위 전부를 합집합 deny, 교집합 allow로 호출마다 | 그대로 |

- **서버 통째 deny.** `mcp__<서버>__*`는 deny 쪽에서만 받는다. 원격 서버(`visibleMcpTools`), 내장 `github`(`mcpCallDenied`)가 deny 해석 하나(`packages/platform/src/sessions`의 공용 함수)를 쓰게 하고, 위 두 함수를 그 위로 옮긴다. allow 쪽의 와일드카드는 검증에서 거절한다(deny-first, 넓히는 방향은 열지 않는다). 해석하지 못하는 규칙은 닫는다.
- **배포 순서.** 옛 control-host는 와일드카드를 그냥 문자열로 보고 아무것도 막지 않는다. 그래서 M1을 둘로 나눈다. M1a는 집행(공용 해석)을 먼저 내보내고, 모든 집행 replica가 M1a 이상일 때만 M1b가 저장과 화면에서 와일드카드를 받는다. M1b의 저장 검증은 배포 capability 기록(결정 4)의 gate(기대 replica 수와 일치하는 모든 control-host가 `deny_wildcard` capability를 가짐)를 통과할 때만 허용하고, 기록을 읽을 수 없으면 거절한다. 저장 뒤에 M1a 미만 이미지가 돌아오면 와일드카드가 무시되므로 그 롤백은 지원하지 않는다고 운영 문서에 적고, 기록이 그 위반을 드러낸다.
- **워크스페이스 admin 등록은 이번에 열지 않는다.** url·자격이 한 행에 묶이므로 다른 사람의 값이 새 목적지로 가는 길은 없다. 막는 이유는 따로 있다. 워크스페이스 범위 비밀 값(결정 4)이 먼저 있어야 하고, 저장 때 host가 `EGRESS_CREDENTIAL_ALLOWLIST`에 있는지를 지금은 경고로만 알려 준다. 워크스페이스 admin이 쓰는 면에서는 경고가 아니라 막아야 하는데 API가 proxy의 env를 모른다. 이 둘이 없는 채로 열면 내부 허용 host로 임의 bearer를 보내는 입구가 된다.
- **열 때의 모양(LATER).** `mcp_servers`에 `owner_scope`(`installation` | `workspace`)와 워크스페이스 id를 더하고, id는 설치 서버와 겹치지 않는 이름공간을 쓴다. 저장 때 host가 허용 목록에 있는지 API가 확인하도록 목록을 API에도 준다.

**버린 대안.** 워크스페이스 admin 등록을 지금 연다(위). 에이전트 관리자 등록을 연다(등록이 에이전트 단위로 흩어져 감사가 어렵고, 같은 문제를 더 넓게 안고 간다). 서버 통째 차단을 `workspaces` 목록 편집으로만 한다(owner만 할 수 있어 워크스페이스 정책이 되지 못한다).

## 결정 6. 구현 단위와 순서 (f)

각 단위는 계약과 시험을 먼저 정의하고(포트는 소비자가 소유하고 작게 나눈다), 구현 없는 어댑터를 두지 않는다. 티켓은 제목으로 부른다.

| 단위 | 내용 | 대응 티켓 | 선행 |
|---|---|---|---|
| M0 | 이 결정 문서 | 이 티켓 | 없음 |
| M0b | 배포 capability 기록: `control_host_instances` 테이블, 쓰는 곳 하나, 읽기 포트 하나. 기대 replica 수와 배포 세대 주입, `--rollout-complete` 없이는 되돌릴 수 없는 단계를 시작하지 않는 명령. 시험: 세대가 다를 때, 기록이 비었을 때, 인스턴스가 하나 빠졌을 때(기록하지 않는 구버전), 기대보다 많을 때, capability가 없는 인스턴스가 하나 있을 때, 기록을 못 읽을 때 모두 거짓 | 새 단위 | 없음 |
| M1a | 서버 통째 deny의 집행: 지금 있는 원격·내장 `github`이 deny 해석 하나를 쓰게 옮김(동작 불변을 시험으로 먼저 고정). 시험: 같은 입력에서 egress와 claim의 집합이 같음, `mcp__github__*`가 GitHub 도구를 막음. stdio 서버의 호출 시점 판정은 [stdio 결정](stdio-mcp-relay.md)의 U2b가 이 공용 해석을 쓰게 한다(M1a의 완료 조건이 아니다) | 새 단위 | 없음 |
| M1b | 와일드카드의 저장·검증(allow 쪽 거절)과 콘솔 입력 | 새 단위 | M0b, M1a(기록이 모든 replica의 `deny_wildcard`를 보임) |
| M2 | 자격 해석 포트 `McpUpstreamCredential`과 정적 구현 추출. 동작을 시험으로 먼저 고정 | 새 단위 | 없음 |
| M3 | 서버 여러 개: 유일 키에 `scope_key`, token이 서버 경계(내장 `github` 분기 포함, 서버 간 token 교환 거절 시험), 에이전트 설정이 서버 여럿을 받음, claim 상한과 `multi_mcp` capability, `mcp_start`의 `servers`, egress 상태가 집합, fingerprint 서버별 | 에이전트 하나가 원격 MCP 서버를 여러 개 쓸 수 있게 한다 | M2, 카드의 `mcp`를 설정으로 옮기는 작업 |
| M4 | 비밀 값 범위(결정 4): R1 → R2 → R3, AAD v2, backfill, 잠금 키 변경 | 새 단위 | M0b |
| M5 | 워크스페이스·에이전트 비밀 값을 proxy가 붙임: 이름별 token은 M3의 `scope_key` | 워크스페이스·에이전트 시크릿을 egress proxy가 요청 헤더에 붙여 주게 한다 | M3, M4 |
| M6 | MCP OAuth(에이전트 주체): 서버 행의 `auth` 합집합(`bearer` \| `oauth`)과 그 저장·내보내기·가져오기 계약, 연결 행과 generation, 동의·콜백, 갱신, 철회, 오프보딩 처리, OAuth 해석기, 목적지 검사 공용 함수 | 새 단위 | M2, M4 |
| M7 | 요청자 주체와 Google Workspace 연동. 연동 계정이 토큰을 보관하게 되므로 "토큰을 보관하지 않는다"는 전제가 바뀐다 | 구성원이 Google Workspace 계정을 연동 계정에 연결해 세션에서 Drive·Docs·Calendar를 쓸 수 있다 | M6, 단일 요청자 세션 규칙. 오너 승인 |

**기존 티켓 조정.** 서버 여러 개 티켓의 인수 조건은 "에이전트 release 계약이 서버를 여럿 선언"이라고 적었지만, 카드의 `mcp`는 에이전트 설정으로 옮겨지는 중이다. 그러므로 여러 서버는 카드가 아니라 에이전트 설정에 들어가야 하고, 티켓의 범위를 그에 맞춘다. 비밀 값 주입 티켓은 token 단위 질문(M3)과 설치·워크스페이스 비밀 값 범위(M4)에 막혀 있으므로 그 둘 뒤에 둔다.

## 나중에 다시 볼 것 (LATER)

| 항목 | 다시 볼 조건 |
|---|---|
| 요청자 주체(결정 1) | Google Workspace 연동 단위를 오너가 승인할 때 |
| 워크스페이스 admin의 서버 등록(결정 5) | 한 설치에 워크스페이스가 둘이 되고 둘째가 자기 서버를 요구할 때 |
| 동적 클라이언트 등록(결정 2) | 설치 owner가 등록하지 않은 서버에 사용자가 연결해야 하는 요구가 생길 때 |
| 서버별 워크스페이스 자격 덮어쓰기 | 자격만 다른 서버 행이 여덟 개를 넘게 늘 때 |
| 서비스 계정 여부의 검증(결정 2) | 상대 시스템이 서비스 계정 여부를 알려 주는 API를 제공할 때 |
| release에 MCP 서버 버전 고정 | 서버 행의 `workspaces` 수정이 진행 중 세션에 문제를 일으킬 때([설정 DB 결정](settings-replace-file-catalog.md)에서 미뤘다) |
