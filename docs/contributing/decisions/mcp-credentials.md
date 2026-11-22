# 결정: 워크스페이스가 원격 MCP 서버를 등록·인증하고 에이전트가 쓴다

- 상태: 결정. 구현 단위는 결정 8에 적었다.
- 배경 문서: [번들 stdio MCP 서버를 worker relay 뒤에 둔다](stdio-mcp-relay.md), [에이전트 행동 도구 카탈로그](action-broker.md), [설정을 파일에서 DB로](settings-replace-file-catalog.md), [OIDC 로그인 제공자](oidc-login-providers.md).
- 기준: `origin/main` `2da968643`. 파일 이름은 이 커밋에서 읽었다.
- 이 문서는 같은 이름의 옛 설계안(에이전트 주체 OAuth, 서버별 egress token, 설치 비밀 값 범위 이전)을 대신한다. 옛 안에서 버린 것은 "옛 설계안에서 바뀐 것"에 모았다.
- **[MCP 연결 세 단계](mcp-connection-tiers.md)가 이 문서의 일부를 대신한다.** 결정 1(자격 주체는 워크스페이스 하나)은 workspace · agent · personal 세 단계로, 결정 2와 "지금 있는 것"의 "설치 카탈로그는 그대로 둔다"는 카탈로그를 한 번에 옮기고 없애는 것으로, 결정 6의 "proxy는 바꾸지 않는다"는 upstream 401·403 보고로 바뀐다. LATER의 "에이전트별 외부 계정", "요청자 본인의 계정", "upstream 401을 연결 상태에 반영"은 그 문서가 연다. 결정 2의 "워크스페이스를 지우면 비밀 값이 같이 지워진다"는 코드와 다르다(그 문서 1절). 결정 5(allow 목록 없이 deny만)는 카탈로그에서 옮긴 켜기 행에만 예외를 둔다: 옮기기 전의 허용 도구를 `imported_allowed_tools`로 남겨 도구 다시 읽기로 넓어지지 않게 한다(그 문서 2절). 나머지 결정(등록 검사, OAuth 탐색·동의·갱신, 비밀 값 purpose, 도구 목록, 새 선택의 deny)은 세 단계에 그대로 쓴다.

## 요약

워크스페이스 admin이 원격 MCP 서버(예: `https://mcp.atlassian.com/v2/mcp`)의 URL을 등록하고 한 번 인증한다. 인증은 OAuth 2.1(authorization code + PKCE) 또는 정적 token이다. 자격은 워크스페이스에 하나 저장되고, 그 워크스페이스의 에이전트는 서버마다 켜거나 끌 수 있다. 에이전트의 호출은 egress proxy가 자격을 붙여 보내므로 worker와 engine은 token을 보지 못한다.

이 방식에서 외부 서비스의 호출은 **인증한 admin의 외부 계정으로** 기록되고 그 계정의 권한으로 실행된다. 워크스페이스의 모든 에이전트가 그 계정을 같이 쓴다. 연결 화면은 이것을 "이 계정으로 동작함"으로 보인다(결정 7). 에이전트마다 다른 계정을 쓰는 기능은 이번에 만들지 않지만, 자료 구조는 그것을 막지 않는다(결정 1).

## 지금 있는 것

- **설치 카탈로그.** 원격 서버는 DB 행 `mcp_servers`이고 설치 owner(`installation.settings.manage`)만 만든다. 행은 `url`, `credential_ref`, bearer 값, 허용 `workspaces`(slug)를 묶는다. 자격은 서비스 계정 bearer 하나다. 이 경로는 그대로 둔다.
- **에이전트 선택.** `agent_mcp_settings`가 설치 카탈로그 서버 하나, 허용 도구, `credential_refs`를 저장한다. 세션은 시작할 때 이 설정을 `sessions.mcp_start`에 snapshot으로 남긴다. 좁히는 변경은 진행 중 세션에 바로 걸리고, 넓히는 변경은 다음 세션부터다(`effectiveMcp`).
- **집행.** `packages/platform/src/workers/mcp-egress.ts`가 proxy의 `/mcp/<서버>` 요청마다 세션 상태를 다시 읽어 판정하고, 허용이면 upstream URL과 `Authorization` 헤더를 proxy에 돌려준다(`mcpUpstreamOf`). worker는 attempt 범위의 MCP egress token만 갖는다. token 하나가 카탈로그 서버와 내장 `github` 서버를 같이 쓴다.
- **proxy.** 자격 경로는 `EGRESS_CREDENTIAL_ALLOWLIST`·`EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST`에 있는 host로만 보낸다. upstream의 401을 403으로 바꾸고 `www-authenticate`를 지운다(engine이 스스로 OAuth를 시작하지 못하게 한다). 열린 스트림은 30초마다 다시 묻는다(`regrant`).
- **deny.** `mcp__서버__도구`가 워크스페이스·에이전트·설치 deny 목록에 Bash 규칙과 같은 목록으로 들어간다. 일치는 정확 이름뿐이다.
- **claim.** `runtime_config.mcp_servers`는 `max(2)`(카탈로그 서버 하나와 내장 `github`)다. worker는 항목마다 proxy의 `/mcp/<name>`으로 붙고, 항목의 `tools`만 engine에 보인다.
- **없는 것.** MCP OAuth, 워크스페이스가 소유하는 MCP 서버, 서버 통째 deny.

## Atlassian 원격 MCP의 클라이언트 등록(공개 자료, 2026-11-15 확인)

| 항목 | 확인한 값 | 출처 |
|---|---|---|
| 인증 시작 | `POST /v2/mcp`가 401과 `WWW-Authenticate: Bearer resource_metadata="https://mcp.atlassian.com/.well-known/oauth-protected-resource/v2/mcp"`를 준다. `scope` 파라미터는 없다 | 직접 요청 |
| 보호 자원 메타데이터(RFC 9728) | `resource`가 `https://mcp.atlassian.com/v2/mcp`, `authorization_servers`가 `auth.atlassian.com` 아래 경로 하나, bearer는 header. `scopes_supported`에 `offline_access`, `read:me`, 제품별 `*:agent-interface` scope가 있다 | 직접 요청 |
| 인가 서버 메타데이터(RFC 8414) | 경로 삽입 형식(`/.well-known/oauth-authorization-server/<경로>`)으로 읽힌다. OIDC discovery는 404다 | 직접 요청 |
| 동적 클라이언트 등록(RFC 7591) | `registration_endpoint`가 있다 | 직접 요청 |
| CIMD | `client_id_metadata_document_supported: true` | 직접 요청 |
| PKCE | `code_challenge_methods_supported`는 `S256`만 | 직접 요청 |
| 클라이언트 인증 | `none`, `client_secret_post`, `client_secret_basic`, `private_key_jwt` | 직접 요청 |
| 철회(RFC 7009) | `revocation_endpoint`가 있다 | 직접 요청 |
| 미리 등록한 클라이언트 | 공개 문서에 셀프서비스 사전 등록 절차가 없다 | Rovo MCP 개발자 문서, 지원 문서 |
| API token | 조직 admin이 켜야 쓴다. 개인 token은 `Basic base64(email:token)`, 서비스 계정 key는 `Bearer` | 지원 문서 |
| 권한 | 모든 동작이 인증한 사용자의 기존 접근 권한을 따른다. 조직 admin이 도메인·redirect 허용 목록을 둘 수 있다 | 지원 문서 |

**결론.** Atlassian에 OAuth로 붙으려면 DCR이 필요하다. 그래서 DCR을 기본으로 지원하고, 미리 받은 client id(와 secret)를 손으로 넣는 길도 둔다. CIMD는 콘솔이 공개 URL에 문서를 호스팅해야 하므로 이번에는 하지 않는다(LATER). 문서에 적히지 않은 동작(refresh token 회전 여부, access token 수명)은 가정하지 않고, 결정 3의 갱신 규칙이 어느 쪽이든 견디게 한다.

## 결정 1. 자격 주체는 워크스페이스 하나다

**결정.** 워크스페이스 서버의 자격은 워크스페이스에 하나다. 에이전트는 그 자격을 쓸지 말지(켜기·끄기)만 정한다. 자격은 서버 행이 아니라 별도 연결 행 `workspace_mcp_connections`에 둔다. 연결 행은 `(server_id, subject)`로 유일하고 `subject`는 지금 `'workspace'`만 허용한다(CHECK). 에이전트별 계정을 더하는 단위는 `subject = 'agent:<id>'` 행과 그 해석 규칙만 더하면 된다. 비밀 값의 owner_ref에도 subject가 들어간다(결정 4).

**버린 대안.**

- 에이전트마다 자격(옛 설계안의 에이전트 주체): admin이 에이전트 수만큼 인증해야 한다. 오너가 원한 "한 번 인증하면 각 에이전트가 쓴다"와 맞지 않는다.
- 자격을 서버 행의 컬럼으로 둠: 주체를 더할 때 행 모양이 바뀐다. 연결 행을 나누는 비용은 테이블 하나다.

## 결정 2. 서버 등록

**결정.** 새 테이블 `workspace_mcp_servers`에 둔다. 설치 카탈로그 `mcp_servers`는 넓히지 않는다. 카탈로그는 설치 설정 generation에 묶여 메모리에 올라가고 가져오기·내보내기 계약을 갖는데, 워크스페이스 행은 둘 다 필요 없다.

| 컬럼 | 뜻 |
|---|---|
| `id` uuid | 행 식별자. snapshot과 binding이 이것을 쓴다 |
| `workspace_id` | 소유 워크스페이스. 지우면 행·연결·비밀 값이 같이 지워진다 |
| `name` | 도구 이름공간(`mcp__<name>__<도구>`). `agent_mcp_settings.server`와 같은 정규식. 워크스페이스 안에서 유일 |
| `url` | MCP endpoint. 만든 뒤 바꾸지 않는다(바꾸려면 지우고 다시 등록) |
| `auth_kind` | `oauth` \| `bearer`. 만든 뒤 바꾸지 않는다 |
| `oauth` jsonb | 등록 때 고정한 OAuth 메타데이터(결정 3). `bearer`면 NULL |
| `tools` jsonb, `tools_read_at` | 마지막으로 읽은 도구 목록(결정 5) |
| `created_by_user_id`, `created_at` | 등록한 사람 |

- **이름 충돌.** `name`은 `github`, 설치 카탈로그 서버 id, [브라우저 도구 설계](worker-browser-tools.md)가 예약한 `browser`와 겹치면 안 된다. 카탈로그는 워크스페이스마다 보이는 범위가 달라 CHECK로 막을 수 없으므로, 두 쪽의 생성 경로가 같은 advisory lock(`mcp_server_name:<name>`)을 잡고 상대 테이블을 확인한다. 카탈로그 서버를 만들 때 같은 이름의 워크스페이스 서버가 어디든 있으면 거절한다. claim도 한 세션 안에서 이름이 겹치면 시작을 거절한다(쓰기 검사가 빠졌을 때의 마지막 방어).
- **목적지 검사.** URL은 https만 받는다. 예외는 `EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST`에 있는 host이고, 이때만 http를 받는다(로컬 스택의 시험 서버). host:port가 API가 가진 자격 허용 목록(`credentialHostsFromEnv`)에 없으면 등록을 거절한다. 지금 설치 카탈로그는 경고만 하지만, 워크스페이스 admin이 쓰는 면에서는 내부 host로 임의 bearer를 보내는 입구가 되므로 막는다. API에 목록이 없으면(env 미설정) 워크스페이스 서버 등록은 전부 거절한다(fail closed).
- **control-host가 직접 부르는 곳.** 탐색(보호 자원·인가 서버 메타데이터), DCR, authorization·token·revocation endpoint, 도구 목록 읽기는 control-host가 직접 보낸다. 이 호출에는 `provider-http.ts`보다 좁은 규칙을 둔다: https만, DNS 해석 뒤 사설·loopback·link-local·예약 주소 거부, 해석한 주소로 고정해 연결, redirect 따라가지 않음, 10초, 1MB. 예외는 `EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST`에 있는 host:port뿐이고, 그 host만 사설 주소와 http를 허용한다. 지금의 `provider-http.ts`는 사설 주소를 허용하므로(관리자가 고른 로그인 제공자용) 그대로 쓰지 않고 주소 분류 정책을 인자로 받게 넓힌다. OAuth endpoint host는 자격 허용 목록에 없어도 된다(proxy가 아니라 control-host가 부른다). 사설망 안으로 메타데이터가 control-host를 끌고 가는 길은 위 거부가 닫는다.
- **권한.** 등록·삭제·연결·끊기·도구 다시 읽기는 `workspace.manage`(owner·admin)이고 콘솔 세션(`surface.kind === "web"`, 사용자 주체)에서만 받는다. API key로는 할 수 없다. 읽기(목록, 연결 상태)는 `workspace.read`다.
- **개수.** 워크스페이스당 서버 20개.

## 결정 3. 인증

**정적 token(`bearer`).** admin이 token을 넣으면 `Authorization: Bearer <값>`으로 보낸다. 값은 등록 뒤 다시 보이지 않고 화면에는 끝 네 자리만 보인다. 교체는 새 값을 넣는 것이다. Atlassian 서비스 계정 key가 이 경우다. `Basic`(Atlassian 개인 API token)은 이번에 하지 않는다(LATER).

**OAuth 탐색(등록 때 한 번).**

1. URL에 token 없이 `initialize`를 보낸다. 401의 `WWW-Authenticate`에 `resource_metadata`가 있으면 그것을, 없으면 RFC 9728의 well-known 경로(경로 삽입, 그다음 루트)를 읽는다.
2. 메타데이터의 `resource`는 등록 URL과 같아야 한다(끝 `/`만 무시). 다르면 거절한다.
3. `authorization_servers`의 첫 값으로 RFC 8414 메타데이터(경로 삽입, 그다음 OIDC discovery)를 읽는다. `issuer`가 같아야 하고, `code_challenge_methods_supported`에 `S256`이 있어야 한다. 없으면 거절한다.
4. 요청할 scope의 기본값은 `WWW-Authenticate`의 `scope`, 없으면 메타데이터의 `scopes_supported`다. admin이 등록 화면에서 줄일 수 있다.
5. 클라이언트: admin이 client id(와 선택으로 secret)를 넣었으면 그것을 쓴다(`manual`). 아니면 `registration_endpoint`로 DCR을 한다(`dcr`): `client_name` "Werft", `redirect_uris`는 그 서버의 콜백 URI 하나(아래), `grant_types`는 `authorization_code`·`refresh_token`, `token_endpoint_auth_method`는 `none`. 둘 다 안 되면 "이 서버는 client 등록이 필요하다"로 거절한다.
6. issuer, 네 endpoint(authorization, token, revocation, registration), `resource`, scope, client id, 등록 방식, 클라이언트 인증 방식을 행의 `oauth`에 고정한다. 인가 서버가 endpoint를 바꾸면 다시 등록한다. 신뢰할 수 없는 서버의 메타데이터를 매번 따라가지 않는다.

**redirect URI는 서버마다 다르다.** `CONSOLE_ORIGIN` 아래 `…/mcp-servers/<server uuid>/callback`이다. 서버 행을 먼저 만들고(uuid가 정해진다) 그 URI로 DCR을 하거나, 손으로 넣는 client면 화면이 이 URI를 보여 주고 admin이 인가 서버에 등록한 뒤 client id를 넣는다. 콜백이 어느 서버의 것인지 URI가 정하므로, code는 그 서버에 고정한 token endpoint로만 간다. 인가 서버가 RFC 9207 `iss`를 응답에 실으면 고정한 issuer와 같아야 하고, 메타데이터가 `authorization_response_iss_parameter_supported: true`인데 `iss`가 없으면 거절한다. 이 둘이 mix-up(한 인가 서버의 code를 다른 서버의 token endpoint로 보내게 하는 공격)을 막는다. Atlassian은 `iss`를 알리지 않으므로 서버별 URI가 방어다.

**동의 흐름.** authorization code + PKCE(S256)와 RFC 8707 `resource`. 시작 API는 흐름 id, `state`, PKCE verifier를 만들고 연결 행에 `pending_flow_id`, `pending_state_sha256`, `pending_started_by_user_id`, `pending_expires_at`(10분)을 적는다. verifier는 비밀 값(`mcp_pkce_verifier`)으로 둔다. 브라우저는 authorization endpoint로 간다. cookie는 쓰지 않는다: 흐름은 서버에 있고, 시작한 콘솔 사용자에 묶인다. 콜백은 콘솔 페이지가 받아 code와 state를 API에 POST한다(OIDC 로그인과 같은 모양). API는 state의 해시가 같고, 만료 전이며, 호출한 사람이 흐름을 시작한 사람이고, 지금도 `workspace.manage`를 가졌을 때만 code를 교환한다. 다른 admin이 연 흐름이나 다른 사람이 받은 code는 사용자가 달라 거절된다.

**콜백의 저장은 다시 검사한다.** code 교환은 외부 호출이라 그동안 끊기·새 인증·구성원 이탈이 끝날 수 있다. 그래서 저장 transaction은 연결 행을 `FOR UPDATE`로 잡고 `pending_flow_id`가 그 흐름이고 만료 전인지, 시작한 사람이 아직 워크스페이스 구성원이며 `workspace.manage`를 가졌는지 다시 본 뒤에만 token 저장, `pending_*` 지우기, 상태 `active`, `generation` 증가를 한다. 하나라도 어긋나면 저장하지 않고 받은 token을 best-effort로 철회한다. 끊기와 새 시작은 `pending_flow_id`를 지우거나 덮으므로 그 앞의 흐름은 늦게 와도 연결을 되살리지 못한다.

**연결 행.** `workspace_mcp_connections`: `server_id`, `subject`, `state`(`none` \| `active` \| `needs_reauth`), `generation`, `pending_*`(위 동의 흐름), `connected_by_user_id`, `connected_at`, `access_expires_at`, `granted_scope`, `refresh_failed_at`. 이미 `active`인 연결을 다시 인증해도 새 token이 저장될 때까지 옛 token이 계속 쓰인다.

**받은 token의 검사.** 처음 받을 때와 갱신할 때 모두 같다. `token_type`은 `Bearer`(대소문자 무시)여야 한다. 처음 응답의 `scope`가 요청한 것보다 넓으면 연결을 거절하고 token을 철회한다. 갱신 응답의 `scope`가 지금 `granted_scope`보다 넓으면 저장하지 않고 `needs_reauth`로 바꾼다. 좁으면 받고 `granted_scope`를 줄여 화면에 보인다. `scope`가 없으면 처음에는 요청한 scope를, 갱신에서는 지금 `granted_scope`를 그대로 둔다(RFC 6749 5.1).

**갱신.** control-host만 한다. egress 판정이 access token의 만료가 60초 안에 오는 것을 보면, 연결 행을 `FOR UPDATE`로 잡고 다시 확인한 뒤(다른 replica가 이미 갱신했을 수 있다) token endpoint를 부르고 같은 transaction에서 저장한다. 행을 잡은 동안 외부 호출을 하지만 호출은 10초로 끊기고 연결 하나에만 걸린다. 새 refresh token이 오면 바꾸고, 안 오면 옛 것을 둔다(회전하든 안 하든 맞다). 받은 뒤 commit 전에 프로세스가 죽어 회전한 token을 잃으면 다음 갱신이 `invalid_grant`가 된다. `invalid_grant`는 상태를 `needs_reauth`로 바꾸고 사용자 token(access·refresh)만 지운다. `invalid_client`도 `needs_reauth`이고, DCR client면 다음 연결 때 DCR을 다시 하며, 손으로 넣은 client면 admin이 client를 바꿔야 한다고 화면에 보인다. 망·5xx 실패는 상태를 두고 그 호출만 거절하며, 같은 연결의 다음 갱신 시도는 30초 뒤부터다(`refresh_failed_at`). refresh token이 없고 access token이 만료됐으면 `needs_reauth`다.

**끊기.** 한 transaction에서 상태를 `none`으로, `generation`을 하나 올리고, `pending_*`와 사용자 token(access·refresh·PKCE verifier)을 지운다. client 자격(client id, `mcp_client_secret`)은 서버의 것이라 남기고, 서버 삭제나 client 교체 때 지운다. 그다음 revocation endpoint가 있으면 refresh token(없으면 access token)을 best-effort로 철회한다. 철회 실패는 화면에 알리되 끊기는 성공이다. 서버를 지우는 것은 끊기 뒤 행 삭제다.

**연결한 사람이 떠날 때.** 연결한 사용자가 워크스페이스 구성원에서 빠지거나 계정이 비활성되면 그 사람이 연결한 연결을 끊는다(위 끊기와 같다). 사람이 떠났는데 그 사람의 외부 권한이 에이전트에 남는 쪽을 닫는다. 역할이 admin에서 member로 내려가는 것만으로는 끊지 않는다(연결은 그때 권한이 있던 사람의 결정이고, 외부 권한은 역할과 무관하다).

**버린 대안.** worker나 proxy가 OAuth를 함(proxy는 DB 쓰기가 없고 worker는 token을 보면 안 된다). DCR을 쓰지 않음(Atlassian에 붙을 수 없다). 등록 때 고정하지 않고 매번 메타데이터를 따라감(악의적이거나 탈취된 서버가 token endpoint를 바꿔 refresh token을 받아 갈 수 있다).

## 결정 4. 비밀 값 저장

`secret_values`(AES-256-GCM, AAD가 행·워크스페이스·owner_ref·purpose를 묶는다)의 워크스페이스 범위에 둔다. 새 owner kind `workspace_mcp`이고 id는 `<server uuid>:<subject>`다. purpose를 다섯 더한다. 사용자 token(끊기·재인증 때 지운다)은 `mcp_access_token`, `mcp_refresh_token`, `mcp_pkce_verifier`다. 서버의 자격(서버 삭제·교체 때 지운다)은 `mcp_client_secret`, `mcp_bearer_token`이다. OAuth access token은 JWT라 길 수 있으므로 이 다섯의 상한은 16KiB로 둔다(나머지 purpose의 4096은 그대로). 값은 API 응답, 로그, 이벤트, receipt에 나가지 않는다. `mcp_bearer_token`만 끝 네 자리를 응답에 싣는다.

## 결정 5. 도구 목록

control-host가 연결 직후와 admin이 "도구 다시 읽기"를 누를 때 서버에 `initialize`, `notifications/initialized`, `tools/list`(cursor를 따라 최대 10쪽)를 보내 도구 이름과 설명을 `tools`에 저장한다. 이름은 기존 MCP 도구 이름 검사를 지나는 것만 받고 최대 200개다. 지나지 못한 개수는 화면에 보인다. 설명은 1024자로 자른다. 호출은 결정 2의 목적지 규칙을 지난다.

- 세션에 보이는 도구는 **저장된 목록 − deny**다. 저장된 목록은 이름의 허용 집합으로만 쓴다. 서버가 도구를 늘려도 다시 읽기 전에는 에이전트에 보이지 않는다(명시적으로 넓힌다).
- 에이전트별 도구 allow 목록은 두지 않는다. 좁히려면 deny를 쓴다(아래 결정 6).
- worker relay는 바꾸지 않는다. 두 relay(`claude/src/remote-mcp.ts`, `codex/src/mcp-relay.ts`)는 지금도 proxy를 거쳐 upstream의 `tools/list`를 읽고 claim의 `tools` 이름으로 거른다. 그래서 도구 정의(`inputSchema`)는 저장하지도 claim에 싣지도 않는다.
- **비밀 값 반사 검사.** control-host가 직접 받은 응답(도구 이름·설명, 탐색·DCR·token endpoint의 오류)은 저장·응답·로그 전에 이 서버에 보낸 비밀 값(access token, 정적 token, client secret)이 들어 있는지 본다. 들어 있으면 그 응답을 버리고 "서버가 자격을 되돌려 보냈다"로 거절한다. upstream 오류 본문은 로그에 싣지 않고 상태 코드와 OAuth `error` 코드만 싣는다. proxy 경로의 응답 가리기는 지금처럼 proxy가 한다.

**버린 대안.** 세션마다 worker가 받은 `tools/list`를 거르지 않고 보임(deny를 claim 때 계산할 수 없고, 서버가 바꾼 도구가 묻지 않고 열린다). 도구 정의 전체를 저장해 claim에 실음(두 adapter를 바꿔야 하고 지금 relay가 이미 하는 일이다).

## 결정 6. 에이전트 선택, 세션, egress, deny

- **선택.** 새 테이블 `agent_workspace_mcp_servers(agent_id, server_id)`. 에이전트당 8개, `agent.manage`이고 콘솔 세션에서만 쓴다. 같은 워크스페이스의 서버만 고를 수 있다. 연결되지 않은 서버도 켤 수 있고, 그 서버의 도구는 연결될 때까지 세션에 보이지 않는다. 설치 카탈로그 서버 선택(`agent_mcp_settings`)은 그대로 둔다.
- **세션 snapshot.** 세션 시작 때 켜진 서버의 `(id, name, url, tools)`를 새 열 `sessions.workspace_mcp_start`에 넣는다. 옛 reader는 이 열을 읽지 않는다.
- **claim.** snapshot의 서버마다 항목을 하나 더한다: `endpoint`는 snapshot의 URL, `binding`은 `sha256(release_id, server uuid, url)`, `tools`는 snapshot의 도구에서 release의 deny(`mcp_deny`, deny 핀)를 뺀 것이다. 도구가 하나도 남지 않은 서버는 빠진다. 항목은 snapshot과 release로만 만들어 세션 동안 고정한다. checkpoint fingerprint가 항목의 이름·`endpoint`·`binding`·`tools`를 담으므로, claim마다 바뀌면 resume이 checkpoint를 쓰지 못한다. 그래서 시작 뒤에 지워지거나 URL이 바뀐 서버도 항목에 남고, 아래 egress 판정이 거절한다(카탈로그 서버가 바뀌면 경로를 거절하는 것과 같다). URL을 담기 전의 snapshot은 행의 URL을 쓰고, 그 사이 지워진 서버는 뺀다. 연결 상태, 에이전트의 켜기·끄기, 지금 저장된 도구 목록, 저장된 엔진 설정의 `mcp__` deny는 claim이 아니라 아래 egress 판정이 호출마다 지킨다. 연결되지 않은 서버는 항목에 남지만 relay의 `initialize`·`tools/list`가 `credential_unavailable`로 거절되어, 연결될 때까지 engine에 도구가 보이지 않는다. 한 세션의 항목 이름이 겹치면(카탈로그 서버나 `github`과 같은 이름) claim의 transaction 안에서 재시도 가능한 503으로 거절해 아무것도 묶지 않는다. resume에는 워크스페이스 항목을 뺀 config도 후보로 준다. 워크스페이스 서버를 claim하지 않던 control-host가 만든 checkpoint를 위해서다. `mcp_servers` 상한을 `2 + 8`로 올린다. 워크스페이스 서버 항목은 새 capability `workspace_mcp`를 알린 worker에만 보낸다. 알리지 않은 worker가 그런 세션을 claim하면 `user_env`처럼 재시도 가능한 거절로 답하고 아무것도 소비하지 않는다. MCP egress token은 지금처럼 attempt마다 하나다. 지금은 claim의 첫 MCP 항목의 binding이 token의 `mcp` binding이 되고, binding이 없으면 token 행을 만들지 않는다(`worker-unit-of-work.ts`). claim 항목의 순서를 카탈로그 서버 → 워크스페이스 서버 → 내장 `github`으로 두면 이 규칙을 바꾸지 않아도 된다: 카탈로그 서버가 있으면 지금과 같고, 없으면 첫 워크스페이스 서버의 binding으로 token이 발급된다. 카탈로그 경로는 지금처럼 token의 binding을 카탈로그 binding과 대조한다. 워크스페이스 서버 경로는 token binding에 기대지 않고 아래 판정이 호출마다 지킨다.
- **egress 판정.** 요청의 서버 이름이 세션 snapshot의 워크스페이스 서버면 새 판정 경로로 간다. 판정은 매 요청 DB에서: snapshot의 uuid와 같은 행이 세션의 워크스페이스에 snapshot의 이름과 URL로 있다, 에이전트가 지금도 그 서버를 켜 두었다, 연결이 `active`다, JSON-RPC 메서드가 허용 목록(`initialize`, `ping`, `tools/list`, `tools/call`, `notifications/*`)에 있다, `tools/call`의 도구가 지금의 "저장된 목록 − deny"에 있다. 지우고 같은 이름으로 다시 등록한 서버는 uuid가 달라 거절된다. 허용이면 upstream은 행의 URL과 `Authorization: Bearer <access token 또는 정적 token>`이다. 요청 줄은 등록한 경로와 query 그대로다(grant의 `target`). proxy는 `url`의 끝 `/`를 떼고 query를 받지 않으므로, 그것에 맡기면 `/mcp/`에 등록한 token이 `/mcp`로 간다. 거절은 지금처럼 receipt를 남기고, 이유에 `workspace_server_unavailable`(행 없음·꺼짐·이름이나 URL이 바뀜), `oauth_needs_reauth`, `credential_unavailable`을 더한다. 끊기·끄기·서버 삭제는 다음 요청에서 거절되고, 열린 스트림은 proxy의 다음 `regrant`(30초 주기 + 응답 시간)에서 끊긴다.
- **proxy.** 바꾸지 않는다. 허용 목록, 401→403, `www-authenticate` 삭제, 응답의 비밀 값 가리기가 그대로 적용된다. 운영자가 서버 host를 proxy와 API의 자격 허용 목록에 넣어야 한다.
- **deny와 서버 통째 차단.** `mcp__<서버>__*`를 deny 쪽에서만 받는다. 원격 서버(`visibleMcpTools`)와 내장 `github`(옛 `mcpCallDenied`)의 deny 판정을 `packages/platform/src/sessions/mcp-tool-decision.ts`의 `mcpToolDenied` 하나로 모으고(에이전트 MCP 설정 저장의 release `mcp_deny` 검사도 같다), 워크스페이스 서버도 그것을 쓴다. allow 쪽의 와일드카드와 `*` 하나는 검증에서 거절한다. 롤링 배포 중 옛 control-host replica는 와일드카드를 그냥 문자열로 보아 막지 않으므로, 와일드카드 deny는 모든 replica가 새 이미지가 된 뒤에 효과가 있다고 운영 문서에 적는다(옛 안의 배포 capability 기록은 만들지 않는다).

## 결정 7. 화면과 "이 계정으로 동작함"

- **워크스페이스 설정 > MCP 서버.** 목록(이름, URL, 인증 방식, 상태, 도구 수), 등록(URL을 넣으면 탐색 결과로 인증 방식·scope·client 등록 방식을 보이고, 정적 token이면 값을 받는다), 연결·다시 연결·끊기, 도구 다시 읽기, 삭제.
- **이 계정으로 동작함.** 연결된 서버마다 "에이전트의 호출은 이 계정으로 실행되고 기록된다"는 문구와 함께 연결한 콘솔 사용자, 연결 시각, 받은 scope를 보인다. MCP OAuth는 외부 계정 식별자를 표준으로 주지 않으므로(Atlassian도 OIDC discovery가 없다) 외부 계정은 "연결한 사람이 동의 화면에서 로그인한 계정"이라고 적고, 확인하지 못한 식별자를 꾸며 보이지 않는다. 정적 token은 "token을 넣은 사람이 발급한 계정"과 끝 네 자리다.
- **에이전트 설정 > MCP.** 워크스페이스 서버 목록에 켜기·끄기, 서버마다 상태와 도구 수, 서버 통째 끄기를 위한 deny 안내.
- **receipt.** `call_mcp` receipt의 대상에 워크스페이스 서버 이름과 연결 `generation`을 남겨, 어느 연결(누가 연결한 것)로 호출했는지 추적할 수 있게 한다. 거절은 `failed`(cut된 교환은 `unknown`)로, upstream에 보내는 `tools/call`은 보내기 전에 `accepted`로 남긴다. `accepted`는 연결이 아직 `active`이고 그 `generation`일 때만 쓰고(연결 행을 `FOR SHARE`로 잡는다), 그사이 다시 연결됐으면 `credential_unavailable`로 거절한다. 쓰지 못하면 보내지 않는다. 진행 중인 교환의 `regrant`는 새 호출이 아니라 쓰지 않는다.

## 결정 8. 구현 단위

| 단위 | 내용 | 선행 |
|---|---|---|
| P1 | 이 문서 | 없음 |
| P2 | 저장과 API: migration(두 서버·연결 테이블, 비밀 purpose), 사설 주소를 거부하는 outbound 정책, 등록·탐색·DCR·정적 token, 서버별 redirect URI와 `iss` 검사, OAuth 시작·콜백(저장 때 재검사)·갱신·끊기, 도구 다시 읽기, 비밀 값 반사 검사, 구성원 이탈 때 끊기, 이름 충돌 잠금, `packages/core` 응답 표 | P1 |
| P3 | 에이전트 선택과 실행: `agent_workspace_mcp_servers`, `sessions.workspace_mcp_start`, claim 항목의 순서와 상한(워크스페이스 서버만 있는 세션의 token 발급 포함), `workspace_mcp` capability(worker 포함), egress 판정과 갱신 호출, deny 공용 해석과 `mcp__서버__*` | P2 |
| P4 | 콘솔: 워크스페이스 MCP 서버 화면, OAuth 콜백 페이지, 에이전트 MCP 켜기·끄기 | P2, P3 |
| P5 | E2E: 시험용 MCP 서버를 OAuth(PRM·AS 메타데이터·DCR·PKCE·refresh)와 정적 token 둘로 넓히고, 로컬 스택에서 등록·인증·에이전트 도구 호출과 token이 worker 환경·로그·API 응답에 없음을 확인 | P4 |

## 옛 설계안에서 바뀐 것

| 옛 설계안 | 이 문서 | 이유 |
|---|---|---|
| 자격 주체는 에이전트, OAuth도 에이전트 주체 | 워크스페이스 주체 하나, 연결 행의 `subject`로 확장 여지 | 오너 요구: admin이 한 번 인증하면 각 에이전트가 쓴다 |
| DCR을 쓰지 않고 설치 owner가 client를 등록 | DCR 기본, 손으로 넣은 client도 받음, 메타데이터는 등록 때 고정 | Atlassian은 DCR로만 붙는다. 고정으로 "매번 따라가는" 위험을 닫는다 |
| 서버마다 egress token(`scope_key`) | attempt당 token 하나 유지, 워크스페이스 서버는 매 요청 DB 판정 | 판정이 이미 매 요청 세션 상태를 읽으므로 token을 나눠 얻는 경계가 없다 |
| 설치 비밀 값 범위 이전(R1–R3, AAD v2) | 하지 않음. 워크스페이스 비밀 값은 지금 저장소로 충분 | 워크스페이스 소유 자격은 이미 워크스페이스 범위다 |
| 배포 capability 기록(M0b), 와일드카드 2단계(M1a/M1b) | 만들지 않음. 롤링 중 효과 지연을 운영 문서에 적음 | 범위 밖. worker 쪽 혼합 버전만 기존 capability 방식으로 막는다 |
| 워크스페이스 admin 등록은 열지 않음 | 연다. 허용 목록 밖 host는 API가 거절(fail closed) | 막던 이유(워크스페이스 비밀 값 없음, 경고만 하는 허용 목록)를 둘 다 닫았다 |

## 나중에 다시 볼 것 (LATER)

| 항목 | 다시 볼 조건 |
|---|---|
| 에이전트별 외부 계정(연결 행 `subject = agent:<id>`) | 에이전트마다 다른 권한의 계정이 필요할 때 |
| 요청자 본인의 계정 | 한 세션을 한 사람만 쓰는 규칙이 생길 때(여러 사람의 턴이 같은 transcript를 읽기 때문) |
| `Basic` 인증(Atlassian 개인 API token) | 서비스 계정 key나 OAuth로 붙을 수 없는 서버가 요구될 때 |
| CIMD | 콘솔이 공개 URL에 client 문서를 둘 수 있고 DCR이 막힌 서버가 생길 때 |
| upstream 401을 연결 상태에 반영 | 만료 전 철회된 token 때문에 호출이 계속 403이 되는 사례가 보일 때 |
| 인가 서버 메타데이터 다시 탐색 | endpoint를 바꾸는 서버가 실제로 생길 때 |
