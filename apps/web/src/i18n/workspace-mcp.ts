export const workspaceMcpKo = {
  "settings.mcp.pageDescription":
    "에이전트가 부르는 원격 MCP 서버입니다. 어드민이 등록하고 인증합니다.",
  "workspaceMcp.title": "워크스페이스 서버",
  "workspaceMcp.description":
    "어드민이 등록하고 인증한 서버입니다. 서버를 켠 에이전트는 이 연결 하나로 부르고, token은 에이전트에게 보이지 않습니다.",
  "workspaceMcp.add": "서버 등록",
  "workspaceMcp.empty": "등록한 서버가 없습니다.",
  "workspaceMcp.readOnly":
    "보기만 할 수 있습니다. 등록과 연결은 오너와 어드민이 합니다.",
  "workspaceMcp.auth.oauth": "OAuth",
  "workspaceMcp.auth.bearer": "정적 token",
  "workspaceMcp.auth.none": "인증 없음",
  "workspaceMcp.auth.unsupported": "지원하지 않는 인증",
  "workspaceMcp.auth.unsupportedNotice":
    "이 판은 이 서버의 인증 방식({kind})을 지원하지 않습니다. 여기서는 token이나 OAuth를 바꾸거나 다시 연결할 수 없습니다. API를 새 판으로 올리거나 서버를 삭제하세요.",
  "workspaceMcp.state.none": "연결 안 됨",
  "workspaceMcp.state.active": "연결됨",
  "workspaceMcp.state.needs_reauth": "다시 연결 필요",
  "workspaceMcp.reauth.invalid_grant":
    "인가 서버가 저장된 token을 더 받지 않습니다. 다시 연결하세요.",
  "workspaceMcp.reauth.invalid_client":
    "인가 서버가 이 client를 더 받지 않습니다. 다시 연결하세요.",
  "workspaceMcp.reauth.invalid_client_manual":
    "인가 서버가 손으로 넣은 client를 더 받지 않습니다. client를 바꾼 뒤 다시 연결하세요.",
  "workspaceMcp.reauth.scope_widened":
    "갱신한 token의 권한이 받은 scope보다 넓어 저장하지 않았습니다. 다시 연결하세요.",
  "workspaceMcp.reauth.expired":
    "token이 만료됐고 갱신할 수 없습니다. 다시 연결하세요.",
  "workspaceMcp.tools": "도구 {count}개",
  "workspaceMcp.toolsSkipped": "{count}개 제외(이름이 맞지 않거나 상한 초과)",
  "workspaceMcp.toolsReadAt": "{at}에 읽음",
  "workspaceMcp.namespace": "도구 이름 {namespace}",
  "workspaceMcp.actingAs.title": "이 계정으로 동작함",
  "workspaceMcp.actingAs.noneTitle": "자격 없이 호출함",
  "workspaceMcp.actingAs.oauth":
    "에이전트의 호출은 {name}이(가) 동의 화면에서 로그인한 외부 계정으로 실행되고, 외부 서비스에 그 계정으로 기록됩니다.",
  "workspaceMcp.actingAs.bearer":
    "에이전트의 호출은 {name}이(가) 넣은 token을 발급한 계정으로 실행되고, 외부 서비스에 그 계정으로 기록됩니다.",
  "workspaceMcp.actingAs.none":
    "인증 없이 부르는 서버입니다. 에이전트의 호출에 누구의 계정이나 자격도 실리지 않습니다.",
  "workspaceMcp.actingAs.unknown": "알 수 없는 사용자",
  "workspaceMcp.connectedBy": "연결한 사람",
  "workspaceMcp.connectedAt": "연결 시각",
  "workspaceMcp.grantedScope": "받은 scope",
  "workspaceMcp.grantedScopeNone": "인가 서버가 알리지 않음",
  "workspaceMcp.lastFour": "token 끝 네 자리",
  "workspaceMcp.connect": "연결",
  "workspaceMcp.connectFor": "{name} 연결",
  "workspaceMcp.reconnect": "다시 연결",
  "workspaceMcp.reconnectFor": "{name} 다시 연결",
  "workspaceMcp.connecting": "인가 서버로 이동하는 중…",
  "workspaceMcp.connected": "{name}을(를) 연결했습니다.",
  "workspaceMcp.disconnect": "끊기",
  "workspaceMcp.disconnectFor": "{name} 연결 끊기",
  "workspaceMcp.disconnectTitle": "{name} 연결 끊기",
  "workspaceMcp.disconnectConsequence":
    "저장한 token을 지우고 인가 서버에 철회를 요청합니다. 이 서버를 켠 에이전트의 다음 호출은 거절됩니다. 다시 쓰려면 다시 연결하세요.",
  "workspaceMcp.disconnected": "{name}의 연결을 끊었습니다.",
  "workspaceMcp.disconnectedNotRevoked":
    "{name}의 연결을 끊었습니다. 인가 서버가 token 철회를 받아들이지 않았으니, 그 서비스의 연결된 앱 설정에서 권한을 직접 지우세요.",
  "workspaceMcp.refresh": "도구 다시 읽기",
  "workspaceMcp.refreshFor": "{name} 도구 다시 읽기",
  "workspaceMcp.refreshed": "{name}의 도구를 다시 읽었습니다. {count}개입니다.",
  "workspaceMcp.replaceToken": "token 바꾸기",
  "workspaceMcp.replaceTokenFor": "{name} token 바꾸기",
  "workspaceMcp.replaceTokenTitle": "{name} token 바꾸기",
  "workspaceMcp.replaceTokenBody":
    "새 token을 넣으면 연결한 사람이 나로 바뀝니다. 에이전트의 호출은 새 token을 발급한 계정으로 실행됩니다.",
  "workspaceMcp.tokenReplaced": "{name}의 token을 바꿨습니다.",
  "workspaceMcp.client": "client 설정",
  "workspaceMcp.clientFor": "{name} client 설정",
  "workspaceMcp.clientTitle": "{name}의 OAuth client",
  "workspaceMcp.clientBody":
    "인가 서버에 아래 redirect URI로 client를 등록한 뒤 client id(와 secret)를 넣으세요. 바꾸면 지금 연결은 끊기고 다시 연결해야 합니다.",
  "workspaceMcp.clientId": "client id",
  "workspaceMcp.clientSecret": "client secret",
  "workspaceMcp.clientSecretHint":
    "public client면 비워 두세요. 저장하면 다시 보이지 않습니다.",
  "workspaceMcp.clientSaved":
    "{name}의 client를 저장했습니다. 연결을 눌러 로그인하세요.",
  "workspaceMcp.redirectUri": "redirect URI",
  "workspaceMcp.delete": "삭제",
  "workspaceMcp.deleteFor": "{name} 삭제",
  "workspaceMcp.deleteTitle": "{name} 삭제",
  "workspaceMcp.deleteConsequence":
    "서버와 연결, 저장한 비밀 값을 모두 지우고 인가 서버에 token 철회를 요청합니다. 이 서버를 켠 에이전트에서도 빠집니다. 되돌릴 수 없습니다.",
  "workspaceMcp.deleted": "{name}을(를) 삭제했습니다.",
  "workspaceMcp.register.title": "원격 MCP 서버 등록",
  "workspaceMcp.register.description":
    "URL을 넣고 탐색하면 서버가 요구하는 인증을 보여 줍니다. 등록한 URL은 바꿀 수 없습니다.",
  "workspaceMcp.register.url": "서버 URL",
  "workspaceMcp.register.urlHint":
    "https 주소는 IP 주소가 아닌 호스트 이름이어야 하고, 풀린 주소가 모두 공개 주소여야 합니다. 예외는 운영자가 사설 목록에 둔 호스트 이름뿐이며, 이 호스트는 http와 사설 주소를 쓸 수 있습니다.",
  "workspaceMcp.register.discover": "탐색",
  "workspaceMcp.register.discovering": "탐색하는 중…",
  "workspaceMcp.register.found": "탐색 결과",
  "workspaceMcp.register.foundOauth": "OAuth를 요구합니다. 인가 서버: {issuer}",
  "workspaceMcp.register.foundDcr":
    "동적 client 등록을 받습니다. 연결할 때 client가 자동으로 만들어집니다.",
  "workspaceMcp.register.foundManual":
    "동적 client 등록을 받지 않습니다. 등록한 뒤 client를 손으로 넣어야 연결할 수 있습니다.",
  "workspaceMcp.register.foundNone":
    "OAuth를 요구하지 않습니다. 정적 token으로 등록하거나, 인증 없이 부르는 공개 서버면 인증 없음을 고르세요.",
  "workspaceMcp.register.name": "이름",
  "workspaceMcp.register.nameHint":
    "도구 이름 앞에 mcp__이름__으로 붙습니다. 소문자, 숫자, -, _로 32자까지 씁니다. github, browser, memory, werft는 쓸 수 없습니다.",
  "workspaceMcp.register.authKind": "인증 방식",
  "workspaceMcp.register.scope": "요청할 scope",
  "workspaceMcp.register.scopeHint":
    "공백으로 구분합니다. 서버가 알린 것보다 넓힐 수 없습니다. 비우면 기본값을 씁니다.",
  "workspaceMcp.register.token": "token",
  "workspaceMcp.register.tokenHint":
    "저장하면 다시 보이지 않고 끝 네 자리만 보입니다. 에이전트는 이 token을 발급한 계정으로 동작합니다.",
  "workspaceMcp.register.noneHint":
    "인증 없이 부를 수 있는 공개 서버에만 고르세요. 저장하는 자격이 없고, 에이전트의 호출에 Authorization 헤더도 다른 자격도 보내지 않습니다.",
  "workspaceMcp.register.submit": "등록",
  "workspaceMcp.register.submitting": "등록하는 중…",
  "workspaceMcp.registered.oauth":
    "{name}을(를) 등록했습니다. 연결을 눌러 인가 서버에 로그인하세요.",
  "workspaceMcp.registered.manual":
    "{name}을(를) 등록했습니다. client 설정에서 client를 넣은 뒤 연결하세요.",
  "workspaceMcp.registered.bearer": "{name}을(를) 등록하고 연결했습니다.",
  "workspaceMcp.registered.none": "{name}을(를) 인증 없이 등록했습니다.",
  "workspaceMcp.error.ALREADY_EXISTS":
    "이미 쓰는 이름입니다. 이 워크스페이스의 다른 서버가 쓰고 있습니다.",
  "workspaceMcp.error.MCP_SERVER_QUOTA_EXCEEDED":
    "워크스페이스가 등록할 수 있는 서버 수에 닿았습니다. 쓰지 않는 서버를 지운 뒤 등록하세요.",
  "workspaceMcp.error.name_reserved":
    "github, browser, memory, werft는 쓸 수 없는 이름입니다.",
  "workspaceMcp.error.url_invalid":
    "URL이 올바르지 않습니다. URL 형식이어야 하고, 계정 정보(user@)나 #이 없어야 하며, https 주소는 IP 주소가 아닌 호스트 이름이어야 합니다.",
  "workspaceMcp.error.address_not_allowed":
    "이 주소로는 연결할 수 없습니다. 공개 호스트는 풀린 주소가 모두 공개여야 하고(사설·loopback·link-local·metadata는 거절), 운영자가 사설 목록에 둔 호스트는 사설 주소로만 풀려야 합니다.",
  "workspaceMcp.error.endpoint_not_allowed":
    "서버나 인가 서버가 알려 준 주소를 부를 수 없습니다. https가 아니거나(http는 운영자가 사설 목록에 둔 호스트만 됩니다), 계정 정보나 #이 들어 있거나, URL 형식이 아닙니다.",
  // The next two stay one release: an API from before the address check still returns them.
  "workspaceMcp.error.credential_allowlist_unset":
    "이 설치는 자격을 보낼 호스트 목록(EGRESS_CREDENTIAL_ALLOWLIST)이 없어 서버를 등록할 수 없습니다. 운영자에게 설정을 요청하세요.",
  "workspaceMcp.error.host_not_allowed":
    "이 서버의 host:port가 자격을 보낼 수 있는 목록에 없습니다. 운영자에게 API와 egress proxy의 EGRESS_CREDENTIAL_ALLOWLIST에 넣어 달라고 요청하세요.",
  "workspaceMcp.error.url_insecure":
    "https 주소만 등록할 수 있습니다. http는 운영자가 사설 목록에 둔 호스트만 됩니다.",
  "workspaceMcp.error.discovery_failed":
    "서버가 요구하는 인증을 읽지 못했습니다. URL을 확인하세요.",
  "workspaceMcp.error.not_oauth":
    "이 서버는 OAuth가 아니라 정적 token으로 연결합니다.",
  "workspaceMcp.error.not_bearer":
    "이 서버는 정적 token이 아니라 OAuth로 연결합니다.",
  "workspaceMcp.error.no_credential":
    "이 서버는 인증 없이 부릅니다. 넣거나 끊을 token이나 OAuth가 없습니다.",
  "workspaceMcp.error.auth_kind_unsupported":
    "이 판은 이 서버의 인증 방식을 지원하지 않아 연결을 끊을 수 없습니다. API를 새 판으로 올리거나 서버를 삭제하세요.",
  "workspaceMcp.error.client_registration_required":
    "인가 서버가 동적 client 등록을 받지 않습니다. client 설정에서 client를 넣은 뒤 연결하세요.",
  "workspaceMcp.error.registration_failed":
    "인가 서버에 client를 등록하지 못했습니다.",
  "workspaceMcp.error.pkce_unsupported":
    "인가 서버가 PKCE(S256)를 지원하지 않아 연결할 수 없습니다.",
  "workspaceMcp.error.oauth_unavailable": "인가 서버 정보를 읽지 못했습니다.",
  "workspaceMcp.error.issuer_mismatch":
    "응답한 인가 서버가 등록할 때의 issuer와 달라 거절했습니다.",
  "workspaceMcp.error.resource_mismatch":
    "서버가 알린 resource가 등록한 URL과 다릅니다.",
  "workspaceMcp.error.oauth_flow_expired":
    "로그인 시간(10분)이 지났습니다. 다시 연결하세요.",
  "workspaceMcp.error.oauth_state_invalid":
    "로그인 응답이 이 연결의 것이 아닙니다. 다시 연결하세요.",
  "workspaceMcp.error.oauth_flow_other_user":
    "다른 사람이 시작한 로그인입니다. 연결을 시작한 사람이 끝내야 합니다.",
  "workspaceMcp.error.scope_widened":
    "인가 서버가 요청한 것보다 넓은 권한을 주어 연결을 거절했습니다.",
  "workspaceMcp.error.token_rejected":
    "인가 서버가 로그인 결과를 받지 않았습니다. 다시 연결하세요.",
  "workspaceMcp.error.token_invalid":
    "인가 서버가 올바른 token을 주지 않았습니다.",
  "workspaceMcp.error.unauthorized":
    "서버가 이 자격을 받지 않았습니다. token이나 연결을 확인하세요.",
  "workspaceMcp.error.credential_reflected":
    "서버가 자격 값을 응답에 그대로 돌려보내 거절했습니다.",
  "workspaceMcp.error.connection_changed":
    "그사이 연결이 바뀌었습니다. 다시 시도하세요.",
  "workspaceMcp.error.not_connected":
    "연결되지 않은 서버입니다. 먼저 연결하세요.",
  "workspaceMcp.error.console_origin_unset":
    "콘솔 주소(CONSOLE_ORIGIN)가 설정되지 않아 OAuth로 연결할 수 없습니다. 운영자에게 설정을 요청하세요.",
  "workspaceMcp.error.web_session_required":
    "콘솔에 로그인한 사람만 할 수 있습니다.",
  "workspaceMcp.error.mcp_unreachable":
    "서버에 닿지 못했습니다. 잠시 뒤 다시 시도하세요.",
  "workspaceMcp.error.mcp_failed":
    "서버가 MCP 요청에 제대로 답하지 않았습니다.",
  "workspaceMcp.callback.title": "MCP 서버 연결",
  "workspaceMcp.callback.working": "연결을 마치는 중…",
  "workspaceMcp.callback.denied":
    "인가 서버가 로그인을 허용하지 않았습니다(코드: {code}). MCP 서버 화면에서 다시 연결하세요.",
  "workspaceMcp.callback.missing":
    "로그인 응답에 code가 없습니다. MCP 서버 화면에서 다시 연결하세요.",
  "workspaceMcp.callback.signedOut":
    "그사이 콘솔 로그인이 끝나 연결을 마치지 못했습니다. 다시 로그인한 뒤 MCP 서버 화면에서 다시 연결하세요.",
  "workspaceMcp.callback.back": "MCP 서버로 돌아가기",
  "agentWorkspaceMcp.title": "워크스페이스 MCP 서버",
  "agentWorkspaceMcp.description":
    "켠 서버는 다음에 시작하는 세션부터 쓸 수 있습니다. 끈 서버는 실행 중인 세션에서도 다음 요청부터 거절됩니다. {limit}개까지 켤 수 있습니다.",
  "agentWorkspaceMcp.empty":
    "워크스페이스에 등록한 서버가 없습니다. 어드민이 설정 > MCP 서버에서 등록합니다.",
  "agentWorkspaceMcp.toggle": "{name} 켜기",
  "agentWorkspaceMcp.actingAs": "{name}의 외부 계정으로 동작",
  "agentWorkspaceMcp.notConnected": "연결 전에는 도구가 보이지 않습니다.",
  "agentWorkspaceMcp.needsReauth": "다시 연결해야 도구가 보입니다.",
  "agentWorkspaceMcp.limitReached":
    "{limit}개를 모두 켰습니다. 다른 서버를 끄면 켤 수 있습니다.",
  "agentWorkspaceMcp.denyHint":
    "켠 서버의 도구 하나를 막으려면 릴리스 deny에 mcp__서버__도구를, 서버를 통째로 막으려면 mcp__서버__*를 넣으세요.",
  "agentWorkspaceMcp.saved": "켠 서버를 저장했습니다.",
  "agentWorkspaceMcp.error.server_unknown":
    "워크스페이스에 없는 서버입니다. 새로고침하세요.",
} as const;

export const workspaceMcpEn: Record<keyof typeof workspaceMcpKo, string> = {
  "settings.mcp.pageDescription":
    "Remote MCP servers agents call, registered and signed in to by the workspace's admins.",
  "workspaceMcp.title": "Workspace servers",
  "workspaceMcp.description":
    "Servers an admin registered and signed in to. Agents that turn one on call it through this one connection and never see its token.",
  "workspaceMcp.add": "Register server",
  "workspaceMcp.empty": "No servers registered.",
  "workspaceMcp.readOnly":
    "You can only view these. Owners and admins register and connect servers.",
  "workspaceMcp.auth.oauth": "OAuth",
  "workspaceMcp.auth.bearer": "Static token",
  "workspaceMcp.auth.none": "No authentication",
  "workspaceMcp.auth.unsupported": "Unsupported authentication",
  "workspaceMcp.auth.unsupportedNotice":
    "This version does not support this server's authentication ({kind}). You cannot change its token or OAuth or connect it again here. Upgrade the API, or delete the server.",
  "workspaceMcp.state.none": "Not connected",
  "workspaceMcp.state.active": "Connected",
  "workspaceMcp.state.needs_reauth": "Reconnect needed",
  "workspaceMcp.reauth.invalid_grant":
    "The authorization server no longer takes the stored token. Reconnect.",
  "workspaceMcp.reauth.invalid_client":
    "The authorization server no longer takes this client. Reconnect.",
  "workspaceMcp.reauth.invalid_client_manual":
    "The authorization server no longer takes the client entered by hand. Change the client, then reconnect.",
  "workspaceMcp.reauth.scope_widened":
    "A refreshed token carried more than the granted scope, so it was not kept. Reconnect.",
  "workspaceMcp.reauth.expired":
    "The token expired and cannot be refreshed. Reconnect.",
  "workspaceMcp.tools": "{count} tools",
  "workspaceMcp.toolsSkipped": "{count} left out (bad name or over the limit)",
  "workspaceMcp.toolsReadAt": "read {at}",
  "workspaceMcp.namespace": "Tool names {namespace}",
  "workspaceMcp.actingAs.title": "Runs as this account",
  "workspaceMcp.actingAs.noneTitle": "Called without a credential",
  "workspaceMcp.actingAs.oauth":
    "Agents' calls run as the external account {name} signed in with on the consent screen, and the remote service records them under it.",
  "workspaceMcp.actingAs.bearer":
    "Agents' calls run as the account that issued the token {name} entered, and the remote service records them under it.",
  "workspaceMcp.actingAs.none":
    "This server is called without a credential. No one's account or credential goes with agents' calls.",
  "workspaceMcp.actingAs.unknown": "Unknown user",
  "workspaceMcp.connectedBy": "Connected by",
  "workspaceMcp.connectedAt": "Connected at",
  "workspaceMcp.grantedScope": "Granted scope",
  "workspaceMcp.grantedScopeNone": "Not stated by the authorization server",
  "workspaceMcp.lastFour": "Token ends in",
  "workspaceMcp.connect": "Connect",
  "workspaceMcp.connectFor": "Connect {name}",
  "workspaceMcp.reconnect": "Reconnect",
  "workspaceMcp.reconnectFor": "Reconnect {name}",
  "workspaceMcp.connecting": "Going to the authorization server…",
  "workspaceMcp.connected": "Connected {name}.",
  "workspaceMcp.disconnect": "Disconnect",
  "workspaceMcp.disconnectFor": "Disconnect {name}",
  "workspaceMcp.disconnectTitle": "Disconnect {name}",
  "workspaceMcp.disconnectConsequence":
    "Deletes the stored tokens and asks the authorization server to revoke them. Agents with this server on are refused at their next call. Connect again to use it.",
  "workspaceMcp.disconnected": "Disconnected {name}.",
  "workspaceMcp.disconnectedNotRevoked":
    "Disconnected {name}. The authorization server did not accept the revocation; remove the access in that service's connected apps.",
  "workspaceMcp.refresh": "Read tools again",
  "workspaceMcp.refreshFor": "Read the tools of {name} again",
  "workspaceMcp.refreshed": "Read the tools of {name} again: {count}.",
  "workspaceMcp.replaceToken": "Replace token",
  "workspaceMcp.replaceTokenFor": "Replace the token of {name}",
  "workspaceMcp.replaceTokenTitle": "Replace the token of {name}",
  "workspaceMcp.replaceTokenBody":
    "With a new token the connection becomes yours: agents' calls run as the account that issued it.",
  "workspaceMcp.tokenReplaced": "Replaced the token of {name}.",
  "workspaceMcp.client": "Set client",
  "workspaceMcp.clientFor": "Set the client of {name}",
  "workspaceMcp.clientTitle": "OAuth client of {name}",
  "workspaceMcp.clientBody":
    "Register a client for the redirect URI below at the authorization server, then enter its id (and secret). Changing it ends the current connection; connect again afterwards.",
  "workspaceMcp.clientId": "Client id",
  "workspaceMcp.clientSecret": "Client secret",
  "workspaceMcp.clientSecretHint":
    "Leave empty for a public client. It is not shown again once saved.",
  "workspaceMcp.clientSaved": "Saved the client of {name}. Connect to sign in.",
  "workspaceMcp.redirectUri": "Redirect URI",
  "workspaceMcp.delete": "Delete",
  "workspaceMcp.deleteFor": "Delete {name}",
  "workspaceMcp.deleteTitle": "Delete {name}",
  "workspaceMcp.deleteConsequence":
    "Deletes the server, its connection and every stored secret, and asks the authorization server to revoke the token. Agents that have it on lose it. This cannot be undone.",
  "workspaceMcp.deleted": "Deleted {name}.",
  "workspaceMcp.register.title": "Register a remote MCP server",
  "workspaceMcp.register.description":
    "Enter the URL and discover what the server asks for. A registered URL cannot be changed.",
  "workspaceMcp.register.url": "Server URL",
  "workspaceMcp.register.urlHint":
    "An https address must be a host name, not an IP address, and every address it resolves to must be public. The only exception is a host name the operator put on the private allowlist, which may use http and private addresses.",
  "workspaceMcp.register.discover": "Discover",
  "workspaceMcp.register.discovering": "Discovering…",
  "workspaceMcp.register.found": "What the server asks for",
  "workspaceMcp.register.foundOauth": "OAuth. Authorization server: {issuer}",
  "workspaceMcp.register.foundDcr":
    "It takes dynamic client registration: a client is made when you connect.",
  "workspaceMcp.register.foundManual":
    "It takes no dynamic client registration: enter a client by hand after registering, then connect.",
  "workspaceMcp.register.foundNone":
    "It asks for no OAuth. Register it with a static token, or choose no authentication for a public server that takes none.",
  "workspaceMcp.register.name": "Name",
  "workspaceMcp.register.nameHint":
    "Tool names get mcp__name__ in front. Up to 32 lowercase letters, digits, - and _; github, browser, memory and werft are taken.",
  "workspaceMcp.register.authKind": "Authentication",
  "workspaceMcp.register.scope": "Scope to ask for",
  "workspaceMcp.register.scopeHint":
    "Space-separated, no wider than the server offers. Leave empty for its default.",
  "workspaceMcp.register.token": "Token",
  "workspaceMcp.register.tokenHint":
    "Not shown again once saved; only its last four characters are. Agents run as the account that issued it.",
  "workspaceMcp.register.noneHint":
    "Choose this only for a public server that takes no credential. Nothing is stored, and agents' calls send no Authorization header and no other credential.",
  "workspaceMcp.register.submit": "Register",
  "workspaceMcp.register.submitting": "Registering…",
  "workspaceMcp.registered.oauth":
    "Registered {name}. Connect to sign in at the authorization server.",
  "workspaceMcp.registered.manual":
    "Registered {name}. Set its client, then connect.",
  "workspaceMcp.registered.bearer": "Registered and connected {name}.",
  "workspaceMcp.registered.none": "Registered {name} without authentication.",
  "workspaceMcp.error.ALREADY_EXISTS":
    "That name is taken by another server of this workspace.",
  "workspaceMcp.error.MCP_SERVER_QUOTA_EXCEEDED":
    "The workspace holds as many servers as it may. Delete one it no longer uses first.",
  "workspaceMcp.error.name_reserved":
    "github, browser, memory and werft cannot be used as names.",
  "workspaceMcp.error.url_invalid":
    "That is not a valid URL. It must be a URL with no credentials (user@) and no #, and an https address must use a host name, not an IP address.",
  "workspaceMcp.error.address_not_allowed":
    "That address cannot be reached: a public host must resolve only to public addresses (private, loopback, link-local and metadata are refused), and a host the operator put on the private allowlist must resolve only to private addresses.",
  "workspaceMcp.error.endpoint_not_allowed":
    "The address the server or its authorization server gave cannot be called: it is not https (http works only for a host the operator put on the private allowlist), it carries credentials or a #, or it is not a URL.",
  // The next two stay one release: an API from before the address check still returns them.
  "workspaceMcp.error.credential_allowlist_unset":
    "This installation has no list of hosts credentials may go to (EGRESS_CREDENTIAL_ALLOWLIST), so no server can be registered. Ask the operator to set it.",
  "workspaceMcp.error.host_not_allowed":
    "This server's host:port is not on the list of hosts credentials may go to. Ask the operator to add it to EGRESS_CREDENTIAL_ALLOWLIST for the API and the egress proxy.",
  "workspaceMcp.error.url_insecure":
    "Only https addresses can be registered; http only for a host the operator put on the private allowlist.",
  "workspaceMcp.error.discovery_failed":
    "Could not read what the server asks for. Check the URL.",
  "workspaceMcp.error.not_oauth":
    "This server connects with a static token, not OAuth.",
  "workspaceMcp.error.not_bearer":
    "This server connects with OAuth, not a static token.",
  "workspaceMcp.error.no_credential":
    "This server is called without a credential. There is no token or OAuth to set or disconnect.",
  "workspaceMcp.error.auth_kind_unsupported":
    "This version does not support this server's authentication, so it cannot disconnect it. Upgrade the API, or delete the server.",
  "workspaceMcp.error.client_registration_required":
    "The authorization server takes no dynamic client registration. Set a client, then connect.",
  "workspaceMcp.error.registration_failed":
    "Could not register a client at the authorization server.",
  "workspaceMcp.error.pkce_unsupported":
    "The authorization server does not support PKCE (S256), so it cannot be connected.",
  "workspaceMcp.error.oauth_unavailable":
    "Could not read the authorization server's metadata.",
  "workspaceMcp.error.issuer_mismatch":
    "The authorization server that answered is not the issuer registered, so it was refused.",
  "workspaceMcp.error.resource_mismatch":
    "The resource the server states is not the URL registered.",
  "workspaceMcp.error.oauth_flow_expired":
    "The sign-in took longer than 10 minutes. Connect again.",
  "workspaceMcp.error.oauth_state_invalid":
    "This sign-in answer is not this connection's. Connect again.",
  "workspaceMcp.error.oauth_flow_other_user":
    "Someone else started this sign-in; the person who started it must finish it.",
  "workspaceMcp.error.scope_widened":
    "The authorization server granted more than was asked for, so the connection was refused.",
  "workspaceMcp.error.token_rejected":
    "The authorization server did not accept the sign-in result. Connect again.",
  "workspaceMcp.error.token_invalid":
    "The authorization server did not send a usable token.",
  "workspaceMcp.error.unauthorized":
    "The server did not accept this credential. Check the token or the connection.",
  "workspaceMcp.error.credential_reflected":
    "The server sent the credential back in its answer, so it was refused.",
  "workspaceMcp.error.connection_changed":
    "The connection changed meanwhile. Try again.",
  "workspaceMcp.error.not_connected":
    "The server is not connected. Connect it first.",
  "workspaceMcp.error.console_origin_unset":
    "The console address (CONSOLE_ORIGIN) is not set, so OAuth cannot be used. Ask the operator to set it.",
  "workspaceMcp.error.web_session_required":
    "Only a person signed in to the console can do this.",
  "workspaceMcp.error.mcp_unreachable":
    "Could not reach the server. Try again shortly.",
  "workspaceMcp.error.mcp_failed":
    "The server did not answer the MCP request properly.",
  "workspaceMcp.callback.title": "Connect MCP server",
  "workspaceMcp.callback.working": "Finishing the connection…",
  "workspaceMcp.callback.denied":
    "The authorization server did not allow the sign-in (code: {code}). Connect again from the MCP servers page.",
  "workspaceMcp.callback.missing":
    "The sign-in answer has no code. Connect again from the MCP servers page.",
  "workspaceMcp.callback.signedOut":
    "Your console sign-in ended meanwhile, so the connection was not finished. Sign in again, then connect again from the MCP servers page.",
  "workspaceMcp.callback.back": "Back to MCP servers",
  "agentWorkspaceMcp.title": "Workspace MCP servers",
  "agentWorkspaceMcp.description":
    "A server turned on is there from the next session that starts; one turned off is refused even to a running session at its next request. Up to {limit} can be on.",
  "agentWorkspaceMcp.empty":
    "The workspace has no servers. An admin registers them under Settings > MCP servers.",
  "agentWorkspaceMcp.toggle": "Turn on {name}",
  "agentWorkspaceMcp.actingAs": "Runs as {name}'s external account",
  "agentWorkspaceMcp.notConnected": "No tools are shown until it is connected.",
  "agentWorkspaceMcp.needsReauth":
    "Its tools are shown again once reconnected.",
  "agentWorkspaceMcp.limitReached":
    "All {limit} are on. Turn one off to turn on another.",
  "agentWorkspaceMcp.denyHint":
    "To block one tool of a server, put mcp__server__tool in the release's deny; to block the whole server, mcp__server__*.",
  "agentWorkspaceMcp.saved": "Saved the servers that are on.",
  "agentWorkspaceMcp.error.server_unknown":
    "That server is not the workspace's. Reload.",
};

export const workspaceMcpJa: Record<keyof typeof workspaceMcpKo, string> = {
  "settings.mcp.pageDescription":
    "エージェントが呼ぶリモート MCP サーバーです。アドミンが登録して認証します。",
  "workspaceMcp.title": "ワークスペースのサーバー",
  "workspaceMcp.description":
    "アドミンが登録して認証したサーバーです。サーバーをオンにしたエージェントはこの接続ひとつで呼び、token はエージェントに見えません。",
  "workspaceMcp.add": "サーバーを登録",
  "workspaceMcp.empty": "登録したサーバーはありません。",
  "workspaceMcp.readOnly":
    "表示のみできます。登録と接続はオーナーとアドミンが行います。",
  "workspaceMcp.auth.oauth": "OAuth",
  "workspaceMcp.auth.bearer": "静的 token",
  "workspaceMcp.auth.none": "認証なし",
  "workspaceMcp.auth.unsupported": "未対応の認証",
  "workspaceMcp.auth.unsupportedNotice":
    "この版はこのサーバーの認証方式（{kind}）に対応していません。ここでは token や OAuth の変更、再接続はできません。API を新しい版に上げるか、サーバーを削除してください。",
  "workspaceMcp.state.none": "未接続",
  "workspaceMcp.state.active": "接続済み",
  "workspaceMcp.state.needs_reauth": "再接続が必要",
  "workspaceMcp.reauth.invalid_grant":
    "認可サーバーが保存した token を受け付けなくなりました。再接続してください。",
  "workspaceMcp.reauth.invalid_client":
    "認可サーバーがこの client を受け付けなくなりました。再接続してください。",
  "workspaceMcp.reauth.invalid_client_manual":
    "認可サーバーが手入力の client を受け付けなくなりました。client を変えてから再接続してください。",
  "workspaceMcp.reauth.scope_widened":
    "更新した token の権限が付与済みの scope より広いため保存しませんでした。再接続してください。",
  "workspaceMcp.reauth.expired":
    "token の期限が切れ、更新できません。再接続してください。",
  "workspaceMcp.tools": "ツール {count} 個",
  "workspaceMcp.toolsSkipped": "{count} 個を除外（名前が不正か上限超過）",
  "workspaceMcp.toolsReadAt": "{at} に読み込み",
  "workspaceMcp.namespace": "ツール名 {namespace}",
  "workspaceMcp.actingAs.title": "このアカウントで動作",
  "workspaceMcp.actingAs.noneTitle": "資格情報なしで呼び出し",
  "workspaceMcp.actingAs.oauth":
    "エージェントの呼び出しは {name} が同意画面でログインした外部アカウントで実行され、外部サービスにそのアカウントで記録されます。",
  "workspaceMcp.actingAs.bearer":
    "エージェントの呼び出しは {name} が入れた token を発行したアカウントで実行され、外部サービスにそのアカウントで記録されます。",
  "workspaceMcp.actingAs.none":
    "認証なしで呼び出すサーバーです。エージェントの呼び出しには誰のアカウントや資格情報も付きません。",
  "workspaceMcp.actingAs.unknown": "不明なユーザー",
  "workspaceMcp.connectedBy": "接続した人",
  "workspaceMcp.connectedAt": "接続日時",
  "workspaceMcp.grantedScope": "付与された scope",
  "workspaceMcp.grantedScopeNone": "認可サーバーが示していません",
  "workspaceMcp.lastFour": "token の末尾 4 文字",
  "workspaceMcp.connect": "接続",
  "workspaceMcp.connectFor": "{name} を接続",
  "workspaceMcp.reconnect": "再接続",
  "workspaceMcp.reconnectFor": "{name} を再接続",
  "workspaceMcp.connecting": "認可サーバーへ移動しています…",
  "workspaceMcp.connected": "{name} を接続しました。",
  "workspaceMcp.disconnect": "切断",
  "workspaceMcp.disconnectFor": "{name} の接続を切る",
  "workspaceMcp.disconnectTitle": "{name} の接続を切る",
  "workspaceMcp.disconnectConsequence":
    "保存した token を削除し、認可サーバーに失効を依頼します。このサーバーをオンにしたエージェントの次の呼び出しは拒否されます。使うには再接続してください。",
  "workspaceMcp.disconnected": "{name} の接続を切りました。",
  "workspaceMcp.disconnectedNotRevoked":
    "{name} の接続を切りました。認可サーバーが token の失効を受け付けなかったため、そのサービスの連携アプリ設定で権限を直接削除してください。",
  "workspaceMcp.refresh": "ツールを再読み込み",
  "workspaceMcp.refreshFor": "{name} のツールを再読み込み",
  "workspaceMcp.refreshed":
    "{name} のツールを再読み込みしました。{count} 個です。",
  "workspaceMcp.replaceToken": "token を変更",
  "workspaceMcp.replaceTokenFor": "{name} の token を変更",
  "workspaceMcp.replaceTokenTitle": "{name} の token を変更",
  "workspaceMcp.replaceTokenBody":
    "新しい token を入れると接続した人があなたに変わります。エージェントの呼び出しは新しい token を発行したアカウントで実行されます。",
  "workspaceMcp.tokenReplaced": "{name} の token を変更しました。",
  "workspaceMcp.client": "client を設定",
  "workspaceMcp.clientFor": "{name} の client を設定",
  "workspaceMcp.clientTitle": "{name} の OAuth client",
  "workspaceMcp.clientBody":
    "認可サーバーに下の redirect URI で client を登録し、client id（と secret）を入れてください。変更すると今の接続は切れ、再接続が必要です。",
  "workspaceMcp.clientId": "client id",
  "workspaceMcp.clientSecret": "client secret",
  "workspaceMcp.clientSecretHint":
    "public client なら空のままにします。保存後は再表示されません。",
  "workspaceMcp.clientSaved":
    "{name} の client を保存しました。接続を押してログインしてください。",
  "workspaceMcp.redirectUri": "redirect URI",
  "workspaceMcp.delete": "削除",
  "workspaceMcp.deleteFor": "{name} を削除",
  "workspaceMcp.deleteTitle": "{name} を削除",
  "workspaceMcp.deleteConsequence":
    "サーバーと接続、保存した秘密の値をすべて削除し、認可サーバーに token の失効を依頼します。オンにしたエージェントからも外れます。元に戻せません。",
  "workspaceMcp.deleted": "{name} を削除しました。",
  "workspaceMcp.register.title": "リモート MCP サーバーを登録",
  "workspaceMcp.register.description":
    "URL を入れて探索すると、サーバーが求める認証を表示します。登録した URL は変更できません。",
  "workspaceMcp.register.url": "サーバー URL",
  "workspaceMcp.register.urlHint":
    "https のアドレスは IP アドレスではなくホスト名で、解決されるアドレスがすべて公開アドレスである必要があります。例外は運用者がプライベート許可リストに入れたホスト名だけで、このホストは http とプライベートアドレスを使えます。",
  "workspaceMcp.register.discover": "探索",
  "workspaceMcp.register.discovering": "探索しています…",
  "workspaceMcp.register.found": "探索結果",
  "workspaceMcp.register.foundOauth":
    "OAuth を求めます。認可サーバー: {issuer}",
  "workspaceMcp.register.foundDcr":
    "動的 client 登録を受け付けます。接続時に client が自動で作られます。",
  "workspaceMcp.register.foundManual":
    "動的 client 登録を受け付けません。登録後に client を手入力してから接続します。",
  "workspaceMcp.register.foundNone":
    "OAuth を求めません。静的 token で登録するか、認証なしで呼び出す公開サーバーなら認証なしを選んでください。",
  "workspaceMcp.register.name": "名前",
  "workspaceMcp.register.nameHint":
    "ツール名の前に mcp__名前__ が付きます。小文字・数字・-・_ で 32 文字まで。github、browser、memory、werft は使えません。",
  "workspaceMcp.register.authKind": "認証方式",
  "workspaceMcp.register.scope": "要求する scope",
  "workspaceMcp.register.scopeHint":
    "空白区切りです。サーバーが示したものより広げられません。空ならデフォルトを使います。",
  "workspaceMcp.register.token": "token",
  "workspaceMcp.register.tokenHint":
    "保存後は再表示されず、末尾 4 文字だけが見えます。エージェントはこの token を発行したアカウントで動作します。",
  "workspaceMcp.register.noneHint":
    "資格情報なしで呼び出せる公開サーバーにだけ選んでください。何も保存されず、エージェントの呼び出しには Authorization ヘッダーもほかの資格情報も送りません。",
  "workspaceMcp.register.submit": "登録",
  "workspaceMcp.register.submitting": "登録しています…",
  "workspaceMcp.registered.oauth":
    "{name} を登録しました。接続を押して認可サーバーにログインしてください。",
  "workspaceMcp.registered.manual":
    "{name} を登録しました。client を設定してから接続してください。",
  "workspaceMcp.registered.bearer": "{name} を登録して接続しました。",
  "workspaceMcp.registered.none": "{name} を認証なしで登録しました。",
  "workspaceMcp.error.ALREADY_EXISTS":
    "この名前はこのワークスペースの別のサーバーが使っています。",
  "workspaceMcp.error.MCP_SERVER_QUOTA_EXCEEDED":
    "ワークスペースが登録できるサーバー数に達しました。使わないサーバーを削除してから登録してください。",
  "workspaceMcp.error.name_reserved":
    "github、browser、memory、werft は名前に使えません。",
  "workspaceMcp.error.url_invalid":
    "URL が正しくありません。URL の形式で、認証情報（user@）や # を含まず、https のアドレスは IP アドレスではなくホスト名である必要があります。",
  "workspaceMcp.error.address_not_allowed":
    "このアドレスには接続できません。公開ホストは解決されたアドレスがすべて公開である必要があり（プライベート・loopback・link-local・metadata は拒否）、運用者がプライベート許可リストに入れたホストはプライベートアドレスにだけ解決される必要があります。",
  "workspaceMcp.error.endpoint_not_allowed":
    "サーバーか認可サーバーが示したアドレスを呼び出せません。https ではない（http は運用者がプライベート許可リストに入れたホストに限られます）、認証情報や # を含む、または URL ではありません。",
  // The next two stay one release: an API from before the address check still returns them.
  "workspaceMcp.error.credential_allowlist_unset":
    "このインストールには資格情報を送れるホストのリスト（EGRESS_CREDENTIAL_ALLOWLIST）がないため、サーバーを登録できません。運用者に設定を依頼してください。",
  "workspaceMcp.error.host_not_allowed":
    "このサーバーの host:port が資格情報を送れるリストにありません。運用者に API と egress proxy の EGRESS_CREDENTIAL_ALLOWLIST への追加を依頼してください。",
  "workspaceMcp.error.url_insecure":
    "登録できるのは https のアドレスだけです。http は運用者がプライベート許可リストに入れたホストに限られます。",
  "workspaceMcp.error.discovery_failed":
    "サーバーが求める認証を読み取れませんでした。URL を確認してください。",
  "workspaceMcp.error.not_oauth":
    "このサーバーは OAuth ではなく静的 token で接続します。",
  "workspaceMcp.error.not_bearer":
    "このサーバーは静的 token ではなく OAuth で接続します。",
  "workspaceMcp.error.no_credential":
    "このサーバーは認証なしで呼び出します。設定や切断をする token や OAuth はありません。",
  "workspaceMcp.error.auth_kind_unsupported":
    "この版はこのサーバーの認証方式に対応していないため、接続を切れません。API を新しい版に上げるか、サーバーを削除してください。",
  "workspaceMcp.error.client_registration_required":
    "認可サーバーが動的 client 登録を受け付けません。client を設定してから接続してください。",
  "workspaceMcp.error.registration_failed":
    "認可サーバーに client を登録できませんでした。",
  "workspaceMcp.error.pkce_unsupported":
    "認可サーバーが PKCE（S256）に対応していないため接続できません。",
  "workspaceMcp.error.oauth_unavailable":
    "認可サーバーの情報を読み取れませんでした。",
  "workspaceMcp.error.issuer_mismatch":
    "応答した認可サーバーが登録時の issuer と異なるため拒否しました。",
  "workspaceMcp.error.resource_mismatch":
    "サーバーが示した resource が登録した URL と異なります。",
  "workspaceMcp.error.oauth_flow_expired":
    "ログインの制限時間（10 分）を過ぎました。再接続してください。",
  "workspaceMcp.error.oauth_state_invalid":
    "このログイン応答はこの接続のものではありません。再接続してください。",
  "workspaceMcp.error.oauth_flow_other_user":
    "別の人が始めたログインです。接続を始めた人が完了する必要があります。",
  "workspaceMcp.error.scope_widened":
    "認可サーバーが要求より広い権限を与えたため接続を拒否しました。",
  "workspaceMcp.error.token_rejected":
    "認可サーバーがログイン結果を受け付けませんでした。再接続してください。",
  "workspaceMcp.error.token_invalid":
    "認可サーバーが正しい token を返しませんでした。",
  "workspaceMcp.error.unauthorized":
    "サーバーがこの資格情報を受け付けませんでした。token か接続を確認してください。",
  "workspaceMcp.error.credential_reflected":
    "サーバーが資格情報を応答にそのまま返したため拒否しました。",
  "workspaceMcp.error.connection_changed":
    "その間に接続が変わりました。もう一度お試しください。",
  "workspaceMcp.error.not_connected":
    "接続されていないサーバーです。先に接続してください。",
  "workspaceMcp.error.console_origin_unset":
    "コンソールのアドレス（CONSOLE_ORIGIN）が未設定のため OAuth で接続できません。運用者に設定を依頼してください。",
  "workspaceMcp.error.web_session_required":
    "コンソールにログインした人だけが行えます。",
  "workspaceMcp.error.mcp_unreachable":
    "サーバーに到達できませんでした。しばらくしてからお試しください。",
  "workspaceMcp.error.mcp_failed":
    "サーバーが MCP リクエストに正しく応答しませんでした。",
  "workspaceMcp.callback.title": "MCP サーバーの接続",
  "workspaceMcp.callback.working": "接続を完了しています…",
  "workspaceMcp.callback.denied":
    "認可サーバーがログインを許可しませんでした（コード: {code}）。MCP サーバー画面から再接続してください。",
  "workspaceMcp.callback.missing":
    "ログイン応答に code がありません。MCP サーバー画面から再接続してください。",
  "workspaceMcp.callback.signedOut":
    "その間にコンソールのログインが終わったため、接続を完了できませんでした。ログインし直してから MCP サーバー画面で再接続してください。",
  "workspaceMcp.callback.back": "MCP サーバーに戻る",
  "agentWorkspaceMcp.title": "ワークスペースの MCP サーバー",
  "agentWorkspaceMcp.description":
    "オンにしたサーバーは次に始まるセッションから使えます。オフにしたサーバーは実行中のセッションでも次のリクエストから拒否されます。{limit} 個までオンにできます。",
  "agentWorkspaceMcp.empty":
    "ワークスペースに登録したサーバーはありません。アドミンが設定 > MCP サーバーで登録します。",
  "agentWorkspaceMcp.toggle": "{name} をオン",
  "agentWorkspaceMcp.actingAs": "{name} の外部アカウントで動作",
  "agentWorkspaceMcp.notConnected": "接続するまでツールは表示されません。",
  "agentWorkspaceMcp.needsReauth": "再接続するとツールが表示されます。",
  "agentWorkspaceMcp.limitReached":
    "{limit} 個すべてがオンです。別のサーバーをオフにするとオンにできます。",
  "agentWorkspaceMcp.denyHint":
    "オンにしたサーバーのツールをひとつ止めるにはリリースの deny に mcp__サーバー__ツール を、サーバーごと止めるには mcp__サーバー__* を入れてください。",
  "agentWorkspaceMcp.saved": "オンにしたサーバーを保存しました。",
  "agentWorkspaceMcp.error.server_unknown":
    "ワークスペースにないサーバーです。再読み込みしてください。",
};
