/**
 * Settings > Workspace > Login: the sign-in providers the owner sets up, and
 * what a test sign-in says when the provider sends the browser back.
 */
export const loginProvidersKo = {
  "loginProviders.nav": "로그인",
  "loginProviders.title": "로그인",
  "loginProviders.description":
    "워크스페이스에 로그인할 때 쓰는 OIDC 공급자입니다. 공급자는 꺼진 채로 만들어지고, 지금 설정으로 테스트 로그인이 통과해야 켤 수 있습니다.",
  "loginProviders.add": "공급자 추가",
  "loginProviders.empty": "등록된 공급자가 없습니다.",
  "loginProviders.noOrigin":
    "콘솔의 공개 주소(CONSOLE_ORIGIN)가 설정되지 않아 공급자를 만들 수 없습니다. 운영자에게 설정을 요청하세요.",
  "loginProviders.column.name": "공급자",
  "loginProviders.column.state": "상태",
  "loginProviders.column.tested": "마지막 테스트",
  "loginProviders.state.draft": "초안",
  "loginProviders.state.needs_test": "테스트 필요",
  "loginProviders.state.ready": "켤 수 있음",
  "loginProviders.state.enabled": "켜짐",
  "loginProviders.state.enabled_secret_pending": "켜짐 · 새 secret 대기",
  "loginProviders.neverTested": "테스트한 적 없음",
  "loginProviders.addDescription":
    "만들 때 서버가 issuer의 설정 문서를 바로 확인합니다. issuer는 만든 뒤에 바꿀 수 없습니다.",
  "loginProviders.name": "이름",
  "loginProviders.nameHint": "로그인 화면의 버튼에 나옵니다.",
  "loginProviders.issuer": "Issuer",
  "loginProviders.issuerHint":
    "공급자가 알려 주는 주소입니다. 예: https://accounts.google.com",
  "loginProviders.problem.issuer_mismatch":
    "설정 문서의 issuer가 넣은 주소와 다릅니다. 공급자가 알려 준 주소를 글자 그대로 넣으세요. Entra ID는 tenant별 issuer를 씁니다.",
  "loginProviders.problem.invalid_document":
    "이 주소의 설정 문서를 읽을 수 없습니다. issuer 주소를 확인하세요.",
  "loginProviders.problem.insecure_endpoint":
    "https가 아닌 주소는 쓸 수 없습니다.",
  "loginProviders.problem.unsupported_flow":
    "이 공급자는 authorization code 흐름을 지원하지 않습니다.",
  "loginProviders.problem.unsupported_algorithm":
    "이 공급자의 서명 알고리즘을 지원하지 않습니다.",
  "loginProviders.problem.unsupported_client_auth":
    "이 공급자의 client 인증 방식을 지원하지 않습니다. client secret을 쓰는 방식이 필요합니다.",
  "loginProviders.problem.pkce_unsupported":
    "이 공급자는 PKCE S256을 지원하지 않습니다.",
  "loginProviders.problem.unreachable":
    "이 주소에서 응답을 받지 못했습니다. 주소와 서버의 네트워크를 확인하세요.",
  "loginProviders.problem.address_not_allowed":
    "서버가 요청을 보낼 수 없는 주소입니다.",
  "loginProviders.problem.verified_email_required":
    "Google 공급자는 검증된 이메일 요구를 끌 수 없습니다.",
  "loginProviders.problem.jit_requires_domains":
    "Google 공급자는 허용 도메인 없이 자동 가입을 켤 수 없습니다.",
  "loginProviders.error.exists": "같은 issuer의 공급자가 이미 있습니다.",
  "loginProviders.error.enabled":
    "켜진 공급자에서는 할 수 없습니다. 먼저 끄세요.",
  "loginProviders.error.notTested":
    "지금 설정으로 테스트 로그인이 통과해야 켤 수 있습니다.",
  "loginProviders.error.clientMissing":
    "Client ID와 client secret을 먼저 넣으세요.",
  "loginProviders.error.stale":
    "다른 곳에서 설정이 바뀌었습니다. 새로 읽었으니 확인하고 다시 시도하세요.",
  "loginProviders.notFound": "이 공급자는 없습니다. 지워졌을 수 있습니다.",
  "loginProviders.section.general": "일반",
  "loginProviders.rename": "이름 바꾸기",
  "loginProviders.section.register": "공급자에 등록할 값",
  "loginProviders.section.registerHint":
    "공급자(IdP)에서 앱을 만들 때 이 redirect URI를 등록하세요.",
  "loginProviders.redirectUri": "Redirect URI",
  "loginProviders.redirectUriNone":
    "CONSOLE_ORIGIN이 설정되지 않아 주소를 만들 수 없습니다.",
  "loginProviders.copy": "복사",
  "loginProviders.copied": "복사했습니다.",
  "loginProviders.copyFailed": "복사하지 못했습니다. 직접 선택해 복사하세요.",
  "loginProviders.hosts": "서버가 요청을 보내는 곳",
  "loginProviders.hostsHint":
    "로그인할 때 이 서버가 이 host들로 요청을 보냅니다.",
  "loginProviders.discovery": "설정 문서",
  "loginProviders.discoveryChecked": "마지막으로 읽은 때",
  "loginProviders.refresh": "다시 읽기",
  "loginProviders.refreshing": "읽는 중…",
  "loginProviders.section.client": "Client",
  "loginProviders.section.clientHint": "공급자에서 앱을 만들면 받는 값입니다.",
  "loginProviders.clientId": "Client ID",
  "loginProviders.unset": "아직 없음",
  "loginProviders.clientEdit": "바꾸기",
  "loginProviders.clientEditTitle": "Client ID와 인증 방식",
  "loginProviders.clientEditDescription":
    "바꾸면 다시 테스트해야 켤 수 있습니다. 다른 앱 등록의 client ID로 바꾸면 공급자가 사용자를 구분하는 값이 달라져 기존 사용자의 연결이 끊길 수 있습니다(Entra ID 등).",
  "loginProviders.authMethod": "Client 인증 방식",
  "loginProviders.authMethod.client_secret_basic":
    "HTTP Basic (client_secret_basic)",
  "loginProviders.authMethod.client_secret_post":
    "POST 본문 (client_secret_post)",
  "loginProviders.lockedWhileOn":
    "켜진 동안에는 바꿀 수 없습니다. 끄고, 바꾸고, 테스트한 뒤 다시 켜세요.",
  "loginProviders.secret": "Client secret",
  "loginProviders.secretStored": "저장됨 ••••{last4}",
  "loginProviders.secretPending":
    "새 값 ••••{last4}이 테스트를 기다립니다. 테스트 로그인이 이 값으로 통과하면 바뀌고, 그때까지 로그인은 지금 값을 씁니다.",
  "loginProviders.secretSet": "값 넣기",
  "loginProviders.secretChange": "값 바꾸기",
  "loginProviders.secretTitle": "Client secret 넣기",
  "loginProviders.secretDescriptionOff":
    "저장하면 다시 테스트해야 켤 수 있습니다.",
  "loginProviders.secretDescriptionOn":
    "새 값은 바로 쓰이지 않고 테스트 로그인을 기다립니다. 지금 쓰는 값을 다시 넣으면 기다리는 값을 거둡니다.",
  "loginProviders.section.rules": "누가 들어올 수 있나",
  "loginProviders.section.rulesHint":
    "이 공급자의 계정 가운데 누구를 받을지 정합니다.",
  "loginProviders.rulesEdit": "규칙 바꾸기",
  "loginProviders.rulesEditDescription":
    "켜진 공급자에는 바로 적용됩니다. 꺼진 공급자는 바꾼 뒤 다시 테스트해야 켤 수 있습니다.",
  "loginProviders.domains": "허용 도메인",
  "loginProviders.domainsAny": "제한 없음",
  "loginProviders.domainsHint":
    "이메일 도메인이 여기 있는 계정만 로그인합니다. 쉼표나 공백으로 나눠 적고, 비우면 제한하지 않습니다.",
  "loginProviders.jit": "초대 없이 가입",
  "loginProviders.jit.off": "받지 않음",
  "loginProviders.jit.member": "member로 가입",
  "loginProviders.jitHint":
    "켜면 공급자가 이메일 주소를 보증한 사람은 초대 없이 member로 들어옵니다. 끄면 초대받은 사람만 가입합니다.",
  "loginProviders.verified": "검증된 이메일",
  "loginProviders.verified.required": "요구함",
  "loginProviders.verified.optional": "요구하지 않음",
  "loginProviders.verifiedHint":
    "요구하지 않으면 공급자가 이메일 검증 여부를 알려 주지 않는 계정도 로그인합니다. 그런 계정은 초대 링크로만 가입하고, 이메일 주소로 초대나 기존 계정을 찾지 않습니다.",
  "loginProviders.verifiedGoogle": "Google 공급자는 항상 요구합니다.",
  "loginProviders.section.test": "테스트와 켜기",
  "loginProviders.stateHint.draft":
    "Client ID와 client secret을 넣으면 테스트할 수 있습니다.",
  "loginProviders.stateHint.needs_test":
    "지금 설정으로 테스트 로그인이 통과해야 켤 수 있습니다.",
  "loginProviders.stateHint.ready":
    "테스트가 통과했습니다. 켜면 로그인 화면에 버튼이 나옵니다.",
  "loginProviders.stateHint.enabled": "로그인 화면에 버튼이 나옵니다.",
  "loginProviders.stateHint.enabled_secret_pending":
    "로그인은 지금 client secret으로 계속됩니다. 새 값은 테스트 로그인이 통과하면 쓰입니다.",
  "loginProviders.test": "테스트 로그인",
  "loginProviders.testStarting": "이동하는 중…",
  "loginProviders.testHint":
    "공급자의 로그인 화면으로 갑니다. 계정도 세션도 만들지 않습니다.",
  "loginProviders.testedAt": "마지막으로 통과한 테스트",
  "loginProviders.enable": "켜기",
  "loginProviders.enabling": "켜는 중…",
  "loginProviders.disable": "끄기",
  "loginProviders.disableDescription":
    "로그인 화면에서 빠지고, 이 공급자로 로그인한 세션이 모두 끊깁니다.",
  "loginProviders.disableTitle": "{name} 공급자를 끌까요?",
  "loginProviders.disableConsequence":
    "이 공급자로 로그인한 사람은 모두 로그아웃됩니다. 이 공급자로 로그인했다면 내 세션도 끊깁니다. 나중에 다시 켤 수 있습니다.",
  "loginProviders.disableReason": "이미 꺼져 있습니다.",
  "loginProviders.delete": "삭제",
  "loginProviders.deleteDescription":
    "설정과 client secret을 지웁니다. 이 공급자로 들어온 사람의 계정은 남습니다.",
  "loginProviders.deleteTitle": "{name} 공급자를 지울까요?",
  "loginProviders.deleteConsequence":
    "설정과 client secret이 지워지고 되돌릴 수 없습니다. 사람들의 계정은 남습니다.",
  "loginProviders.deleteReason": "켜진 공급자는 끈 뒤에 지울 수 있습니다.",
  "loginProviders.done.saved": "저장했습니다.",
  "loginProviders.done.secretPending":
    "새 값을 받았습니다. 테스트 로그인이 통과하면 쓰입니다.",
  "loginProviders.done.enabled": "켰습니다. 로그인 화면에 버튼이 나옵니다.",
  "loginProviders.done.disabled": "껐습니다. 세션 {count}개를 끊었습니다.",
  "loginProviders.done.refreshed":
    "설정 문서를 다시 읽었습니다. 다시 테스트해야 켤 수 있습니다.",
  "loginProviders.result.title": "테스트 로그인 결과",
  "loginProviders.result.passed": "테스트가 통과했습니다.",
  "loginProviders.result.unrecorded":
    "공급자는 응답했지만, 테스트하는 동안 설정이 바뀌어 통과로 기록하지 않았습니다. 다시 테스트하세요.",
  "loginProviders.result.failed":
    "테스트가 실패했습니다. 켜진 공급자의 로그인은 그대로입니다.",
  "loginProviders.result.reason": "이유 코드",
  "loginProviders.result.subject": "Subject (sub)",
  "loginProviders.result.email": "이메일",
  "loginProviders.result.emailVerified": "email_verified",
  "loginProviders.result.addressOwned": "주소 증명",
  "loginProviders.result.yes": "예",
  "loginProviders.result.no": "아니요",
  "loginProviders.result.unsaid": "보내지 않음",
  "loginProviders.result.addressOwned.yes":
    "공급자가 이 주소를 이 계정의 것으로 증명합니다.",
  "loginProviders.result.addressOwned.no":
    "공급자가 이 주소를 증명하지 않습니다. 이 주소로는 계정을 찾지도, 가입시키지도 않습니다.",
  "loginProviders.result.entry": "이 계정이 로그인하면",
  "loginProviders.result.entry.signs_in": "연결된 계정으로 로그인됩니다.",
  "loginProviders.result.entry.link_required":
    "같은 주소의 계정이 있지만 이 공급자와 연결되어 있지 않아 로그인되지 않습니다.",
  "loginProviders.result.entry.joins": "새 멤버로 가입됩니다.",
  "loginProviders.result.entry.invite_only":
    "이 주소로 온 초대가 있어야 들어옵니다.",
  "loginProviders.result.entry.domain_not_allowed":
    "허용 도메인 밖이라 거절됩니다.",
  "loginProviders.result.entry.refused":
    "거절됩니다. 연결된 계정이 꺼져 있거나, 공급자가 주소를 증명하지 않습니다.",
  "loginProviders.result.back": "공급자 설정으로",
} as const;

export const loginProvidersEn: Record<keyof typeof loginProvidersKo, string> = {
  "loginProviders.nav": "Login",
  "loginProviders.title": "Login",
  "loginProviders.description":
    "The OIDC providers people sign in to this workspace with. A provider is made off, and can be turned on once a test sign-in passes with its settings as they are.",
  "loginProviders.add": "Add provider",
  "loginProviders.empty": "No providers yet.",
  "loginProviders.noOrigin":
    "The console's public address (CONSOLE_ORIGIN) is not set, so no provider can be made. Ask the operator to set it.",
  "loginProviders.column.name": "Provider",
  "loginProviders.column.state": "State",
  "loginProviders.column.tested": "Last test",
  "loginProviders.state.draft": "Draft",
  "loginProviders.state.needs_test": "Needs a test",
  "loginProviders.state.ready": "Ready to turn on",
  "loginProviders.state.enabled": "On",
  "loginProviders.state.enabled_secret_pending": "On · new secret waiting",
  "loginProviders.neverTested": "Never tested",
  "loginProviders.addDescription":
    "The server checks the issuer's configuration document as the provider is made. The issuer cannot be changed afterwards.",
  "loginProviders.name": "Name",
  "loginProviders.nameHint": "Shown on the button of the login page.",
  "loginProviders.issuer": "Issuer",
  "loginProviders.issuerHint":
    "The address the provider gives you, for example https://accounts.google.com",
  "loginProviders.problem.issuer_mismatch":
    "The configuration document names another issuer. Enter the address exactly as the provider gives it. Entra ID uses an issuer per tenant.",
  "loginProviders.problem.invalid_document":
    "The configuration document at this address cannot be read. Check the issuer address.",
  "loginProviders.problem.insecure_endpoint":
    "An address that is not https cannot be used.",
  "loginProviders.problem.unsupported_flow":
    "This provider does not support the authorization code flow.",
  "loginProviders.problem.unsupported_algorithm":
    "This provider's signing algorithms are not supported.",
  "loginProviders.problem.unsupported_client_auth":
    "This provider's client authentication is not supported. A method that uses a client secret is needed.",
  "loginProviders.problem.pkce_unsupported":
    "This provider does not support PKCE S256.",
  "loginProviders.problem.unreachable":
    "No answer came from this address. Check the address and the server's network.",
  "loginProviders.problem.address_not_allowed":
    "The server may not send requests to this address.",
  "loginProviders.problem.verified_email_required":
    "A Google provider always requires a verified email.",
  "loginProviders.problem.jit_requires_domains":
    "A Google provider cannot let people join by themselves without allowed domains.",
  "loginProviders.error.exists": "A provider with this issuer already exists.",
  "loginProviders.error.enabled":
    "This cannot be done while the provider is on. Turn it off first.",
  "loginProviders.error.notTested":
    "A test sign-in has to pass with the settings as they are before it can be turned on.",
  "loginProviders.error.clientMissing":
    "Enter the client ID and the client secret first.",
  "loginProviders.error.stale":
    "The settings changed somewhere else. They were read again; check them and retry.",
  "loginProviders.notFound":
    "This provider does not exist. It may have been deleted.",
  "loginProviders.section.general": "General",
  "loginProviders.rename": "Rename",
  "loginProviders.section.register": "Values to register at the provider",
  "loginProviders.section.registerHint":
    "Register this redirect URI when you create the app at the provider (IdP).",
  "loginProviders.redirectUri": "Redirect URI",
  "loginProviders.redirectUriNone":
    "CONSOLE_ORIGIN is not set, so the address cannot be built.",
  "loginProviders.copy": "Copy",
  "loginProviders.copied": "Copied.",
  "loginProviders.copyFailed": "Could not copy. Select the text and copy it.",
  "loginProviders.hosts": "Where the server sends requests",
  "loginProviders.hostsHint":
    "During a sign-in this server sends requests to these hosts.",
  "loginProviders.discovery": "Configuration document",
  "loginProviders.discoveryChecked": "Last read",
  "loginProviders.refresh": "Read again",
  "loginProviders.refreshing": "Reading…",
  "loginProviders.section.client": "Client",
  "loginProviders.section.clientHint":
    "The values the provider gives you when you create the app.",
  "loginProviders.clientId": "Client ID",
  "loginProviders.unset": "Not set yet",
  "loginProviders.clientEdit": "Change",
  "loginProviders.clientEditTitle": "Client ID and authentication",
  "loginProviders.clientEditDescription":
    "A change means another test before it can be turned on. A client ID from another app registration can change the value the provider tells users apart by, which disconnects existing users (Entra ID, for one).",
  "loginProviders.authMethod": "Client authentication",
  "loginProviders.authMethod.client_secret_basic":
    "HTTP Basic (client_secret_basic)",
  "loginProviders.authMethod.client_secret_post":
    "POST body (client_secret_post)",
  "loginProviders.lockedWhileOn":
    "This cannot change while the provider is on. Turn it off, change it, test, and turn it on again.",
  "loginProviders.secret": "Client secret",
  "loginProviders.secretStored": "Stored ••••{last4}",
  "loginProviders.secretPending":
    "A new value ••••{last4} is waiting for a test. It takes over once a test sign-in passes with it; until then sign-ins use the current one.",
  "loginProviders.secretSet": "Set value",
  "loginProviders.secretChange": "Change value",
  "loginProviders.secretTitle": "Set the client secret",
  "loginProviders.secretDescriptionOff":
    "Saving means another test before it can be turned on.",
  "loginProviders.secretDescriptionOn":
    "The new value is not used at once; it waits for a test sign-in. Entering the value in use again withdraws the one that waits.",
  "loginProviders.section.rules": "Who can come in",
  "loginProviders.section.rulesHint":
    "Which of this provider's accounts are let in.",
  "loginProviders.rulesEdit": "Change rules",
  "loginProviders.rulesEditDescription":
    "On a provider that is on, this applies at once. One that is off needs another test before it can be turned on.",
  "loginProviders.domains": "Allowed domains",
  "loginProviders.domainsAny": "Any",
  "loginProviders.domainsHint":
    "Only accounts whose email domain is listed sign in. Separate with commas or spaces; leave empty for no limit.",
  "loginProviders.jit": "Join without an invite",
  "loginProviders.jit.off": "Not accepted",
  "loginProviders.jit.member": "Join as a member",
  "loginProviders.jitHint":
    "When on, a person whose email address the provider vouches for joins as a member without an invite. When off, only invited people join.",
  "loginProviders.verified": "Verified email",
  "loginProviders.verified.required": "Required",
  "loginProviders.verified.optional": "Not required",
  "loginProviders.verifiedHint":
    "When not required, accounts the provider says nothing about verifying sign in too. They join by invite link only, and their email address is never used to find an invite or an existing account.",
  "loginProviders.verifiedGoogle": "A Google provider always requires it.",
  "loginProviders.section.test": "Test and turn on",
  "loginProviders.stateHint.draft":
    "Enter the client ID and the client secret to test it.",
  "loginProviders.stateHint.needs_test":
    "A test sign-in has to pass with the settings as they are before it can be turned on.",
  "loginProviders.stateHint.ready":
    "The test passed. Turning it on puts its button on the login page.",
  "loginProviders.stateHint.enabled": "Its button is on the login page.",
  "loginProviders.stateHint.enabled_secret_pending":
    "Sign-ins go on with the current client secret. The new one is used once a test sign-in passes.",
  "loginProviders.test": "Test sign-in",
  "loginProviders.testStarting": "Going…",
  "loginProviders.testHint":
    "Goes to the provider's sign-in page. No account and no session is made.",
  "loginProviders.testedAt": "Last test that passed",
  "loginProviders.enable": "Turn on",
  "loginProviders.enabling": "Turning on…",
  "loginProviders.disable": "Turn off",
  "loginProviders.disableDescription":
    "Leaves the login page and ends every session made through this provider.",
  "loginProviders.disableTitle": "Turn off {name}?",
  "loginProviders.disableConsequence":
    "Everyone who signed in through this provider is logged out. If you signed in through it, so are you. It can be turned on again later.",
  "loginProviders.disableReason": "It is already off.",
  "loginProviders.delete": "Delete",
  "loginProviders.deleteDescription":
    "Deletes the settings and the client secret. The accounts of the people who came through it stay.",
  "loginProviders.deleteTitle": "Delete {name}?",
  "loginProviders.deleteConsequence":
    "The settings and the client secret are deleted and cannot be brought back. People's accounts stay.",
  "loginProviders.deleteReason":
    "A provider that is on is turned off before it is deleted.",
  "loginProviders.done.saved": "Saved.",
  "loginProviders.done.secretPending":
    "The new value is kept. It is used once a test sign-in passes.",
  "loginProviders.done.enabled": "Turned on. Its button is on the login page.",
  "loginProviders.done.disabled": "Turned off. {count} sessions ended.",
  "loginProviders.done.refreshed":
    "The configuration document was read again. Test again before turning it on.",
  "loginProviders.result.title": "Test sign-in result",
  "loginProviders.result.passed": "The test passed.",
  "loginProviders.result.unrecorded":
    "The provider answered, but the settings changed while the test ran, so the pass was not written down. Test again.",
  "loginProviders.result.failed":
    "The test failed. Sign-ins of a provider that is on are unchanged.",
  "loginProviders.result.reason": "Reason code",
  "loginProviders.result.subject": "Subject (sub)",
  "loginProviders.result.email": "Email",
  "loginProviders.result.emailVerified": "email_verified",
  "loginProviders.result.addressOwned": "Address proof",
  "loginProviders.result.yes": "Yes",
  "loginProviders.result.no": "No",
  "loginProviders.result.unsaid": "Not sent",
  "loginProviders.result.addressOwned.yes":
    "The provider vouches that this address belongs to this account.",
  "loginProviders.result.addressOwned.no":
    "The provider does not vouch for this address. It finds no account and joins nobody.",
  "loginProviders.result.entry": "If this account signs in",
  "loginProviders.result.entry.signs_in":
    "It signs in as the account it is connected to.",
  "loginProviders.result.entry.link_required":
    "An account with this address exists but is not connected to this provider, so it does not sign in.",
  "loginProviders.result.entry.joins": "It joins as a new member.",
  "loginProviders.result.entry.invite_only":
    "It comes in only with an invite sent to this address.",
  "loginProviders.result.entry.domain_not_allowed":
    "It is refused: outside the allowed domains.",
  "loginProviders.result.entry.refused":
    "It is refused: the connected account is turned off, or the provider does not vouch for the address.",
  "loginProviders.result.back": "Back to the provider",
};

export const loginProvidersJa: Record<keyof typeof loginProvidersKo, string> = {
  "loginProviders.nav": "ログイン",
  "loginProviders.title": "ログイン",
  "loginProviders.description":
    "ワークスペースへのログインに使う OIDC プロバイダーです。プロバイダーはオフの状態で作成され、現在の設定でテストログインが通るとオンにできます。",
  "loginProviders.add": "プロバイダーを追加",
  "loginProviders.empty": "登録されたプロバイダーはありません。",
  "loginProviders.noOrigin":
    "コンソールの公開アドレス（CONSOLE_ORIGIN）が設定されていないため、プロバイダーを作成できません。運用者に設定を依頼してください。",
  "loginProviders.column.name": "プロバイダー",
  "loginProviders.column.state": "状態",
  "loginProviders.column.tested": "最後のテスト",
  "loginProviders.state.draft": "下書き",
  "loginProviders.state.needs_test": "テストが必要",
  "loginProviders.state.ready": "オンにできます",
  "loginProviders.state.enabled": "オン",
  "loginProviders.state.enabled_secret_pending": "オン · 新しい secret 待ち",
  "loginProviders.neverTested": "テストしていません",
  "loginProviders.addDescription":
    "作成時にサーバーが issuer の設定ドキュメントをその場で確認します。issuer は作成後に変更できません。",
  "loginProviders.name": "名前",
  "loginProviders.nameHint": "ログイン画面のボタンに表示されます。",
  "loginProviders.issuer": "Issuer",
  "loginProviders.issuerHint":
    "プロバイダーが示すアドレスです。例: https://accounts.google.com",
  "loginProviders.problem.issuer_mismatch":
    "設定ドキュメントの issuer が入力したアドレスと異なります。プロバイダーが示すアドレスをそのまま入力してください。Entra ID はテナントごとの issuer を使います。",
  "loginProviders.problem.invalid_document":
    "このアドレスの設定ドキュメントを読めません。issuer のアドレスを確認してください。",
  "loginProviders.problem.insecure_endpoint":
    "https ではないアドレスは使えません。",
  "loginProviders.problem.unsupported_flow":
    "このプロバイダーは authorization code フローに対応していません。",
  "loginProviders.problem.unsupported_algorithm":
    "このプロバイダーの署名アルゴリズムには対応していません。",
  "loginProviders.problem.unsupported_client_auth":
    "このプロバイダーの client 認証方式には対応していません。client secret を使う方式が必要です。",
  "loginProviders.problem.pkce_unsupported":
    "このプロバイダーは PKCE S256 に対応していません。",
  "loginProviders.problem.unreachable":
    "このアドレスから応答がありません。アドレスとサーバーのネットワークを確認してください。",
  "loginProviders.problem.address_not_allowed":
    "サーバーがリクエストを送れないアドレスです。",
  "loginProviders.problem.verified_email_required":
    "Google プロバイダーでは検証済みメールの要求をオフにできません。",
  "loginProviders.problem.jit_requires_domains":
    "Google プロバイダーでは許可ドメインなしで自動参加をオンにできません。",
  "loginProviders.error.exists": "同じ issuer のプロバイダーがすでにあります。",
  "loginProviders.error.enabled":
    "オンのプロバイダーではできません。先にオフにしてください。",
  "loginProviders.error.notTested":
    "現在の設定でテストログインが通るとオンにできます。",
  "loginProviders.error.clientMissing":
    "先に Client ID と client secret を入力してください。",
  "loginProviders.error.stale":
    "ほかの場所で設定が変更されました。読み直したので、確認してもう一度お試しください。",
  "loginProviders.notFound":
    "このプロバイダーはありません。削除された可能性があります。",
  "loginProviders.section.general": "一般",
  "loginProviders.rename": "名前を変更",
  "loginProviders.section.register": "プロバイダーに登録する値",
  "loginProviders.section.registerHint":
    "プロバイダー（IdP）でアプリを作成するとき、この redirect URI を登録してください。",
  "loginProviders.redirectUri": "Redirect URI",
  "loginProviders.redirectUriNone":
    "CONSOLE_ORIGIN が設定されていないため、アドレスを作れません。",
  "loginProviders.copy": "コピー",
  "loginProviders.copied": "コピーしました。",
  "loginProviders.copyFailed":
    "コピーできませんでした。選択してコピーしてください。",
  "loginProviders.hosts": "サーバーのリクエスト先",
  "loginProviders.hostsHint":
    "ログイン時に、このサーバーがこれらの host にリクエストを送ります。",
  "loginProviders.discovery": "設定ドキュメント",
  "loginProviders.discoveryChecked": "最後に読んだ日時",
  "loginProviders.refresh": "読み直す",
  "loginProviders.refreshing": "読み込み中…",
  "loginProviders.section.client": "Client",
  "loginProviders.section.clientHint":
    "プロバイダーでアプリを作成すると発行される値です。",
  "loginProviders.clientId": "Client ID",
  "loginProviders.unset": "未設定",
  "loginProviders.clientEdit": "変更",
  "loginProviders.clientEditTitle": "Client ID と認証方式",
  "loginProviders.clientEditDescription":
    "変更すると、オンにする前にもう一度テストが必要です。別のアプリ登録の client ID に変えると、プロバイダーがユーザーを区別する値が変わり、既存ユーザーの連携が切れることがあります（Entra ID など）。",
  "loginProviders.authMethod": "Client 認証方式",
  "loginProviders.authMethod.client_secret_basic":
    "HTTP Basic (client_secret_basic)",
  "loginProviders.authMethod.client_secret_post":
    "POST ボディ (client_secret_post)",
  "loginProviders.lockedWhileOn":
    "オンの間は変更できません。オフにして変更し、テストしてからもう一度オンにしてください。",
  "loginProviders.secret": "Client secret",
  "loginProviders.secretStored": "保存済み ••••{last4}",
  "loginProviders.secretPending":
    "新しい値 ••••{last4} がテストを待っています。この値でテストログインが通ると切り替わり、それまでログインは現在の値を使います。",
  "loginProviders.secretSet": "値を入力",
  "loginProviders.secretChange": "値を変更",
  "loginProviders.secretTitle": "Client secret を入力",
  "loginProviders.secretDescriptionOff":
    "保存すると、オンにする前にもう一度テストが必要です。",
  "loginProviders.secretDescriptionOn":
    "新しい値はすぐには使われず、テストログインを待ちます。現在使っている値をもう一度入力すると、待っている値を取り下げます。",
  "loginProviders.section.rules": "誰が入れるか",
  "loginProviders.section.rulesHint":
    "このプロバイダーのアカウントのうち、誰を受け入れるかを決めます。",
  "loginProviders.rulesEdit": "ルールを変更",
  "loginProviders.rulesEditDescription":
    "オンのプロバイダーにはすぐに適用されます。オフのプロバイダーは、変更後にもう一度テストしないとオンにできません。",
  "loginProviders.domains": "許可ドメイン",
  "loginProviders.domainsAny": "制限なし",
  "loginProviders.domainsHint":
    "メールのドメインがここにあるアカウントだけがログインできます。カンマか空白で区切り、空にすると制限しません。",
  "loginProviders.jit": "招待なしで参加",
  "loginProviders.jit.off": "受け入れない",
  "loginProviders.jit.member": "member として参加",
  "loginProviders.jitHint":
    "オンにすると、プロバイダーがメールアドレスを保証した人は招待なしで member として参加します。オフにすると、招待された人だけが参加します。",
  "loginProviders.verified": "検証済みメール",
  "loginProviders.verified.required": "要求する",
  "loginProviders.verified.optional": "要求しない",
  "loginProviders.verifiedHint":
    "要求しない場合、プロバイダーがメールの検証状態を知らせないアカウントもログインできます。そのアカウントは招待リンクでのみ参加し、メールアドレスで招待や既存のアカウントを探すことはありません。",
  "loginProviders.verifiedGoogle": "Google プロバイダーは常に要求します。",
  "loginProviders.section.test": "テストとオン",
  "loginProviders.stateHint.draft":
    "Client ID と client secret を入力するとテストできます。",
  "loginProviders.stateHint.needs_test":
    "現在の設定でテストログインが通るとオンにできます。",
  "loginProviders.stateHint.ready":
    "テストが通りました。オンにするとログイン画面にボタンが表示されます。",
  "loginProviders.stateHint.enabled":
    "ログイン画面にボタンが表示されています。",
  "loginProviders.stateHint.enabled_secret_pending":
    "ログインは現在の client secret で続きます。新しい値はテストログインが通ると使われます。",
  "loginProviders.test": "テストログイン",
  "loginProviders.testStarting": "移動しています…",
  "loginProviders.testHint":
    "プロバイダーのログイン画面に移動します。アカウントもセッションも作成しません。",
  "loginProviders.testedAt": "最後に通ったテスト",
  "loginProviders.enable": "オンにする",
  "loginProviders.enabling": "オンにしています…",
  "loginProviders.disable": "オフにする",
  "loginProviders.disableDescription":
    "ログイン画面から外れ、このプロバイダーでログインしたセッションがすべて終了します。",
  "loginProviders.disableTitle": "{name} をオフにしますか？",
  "loginProviders.disableConsequence":
    "このプロバイダーでログインした人は全員ログアウトされます。自分がこのプロバイダーでログインしている場合、自分のセッションも終了します。あとでもう一度オンにできます。",
  "loginProviders.disableReason": "すでにオフです。",
  "loginProviders.delete": "削除",
  "loginProviders.deleteDescription":
    "設定と client secret を削除します。このプロバイダーで入った人のアカウントは残ります。",
  "loginProviders.deleteTitle": "{name} を削除しますか？",
  "loginProviders.deleteConsequence":
    "設定と client secret が削除され、元に戻せません。人々のアカウントは残ります。",
  "loginProviders.deleteReason":
    "オンのプロバイダーは、オフにしてから削除できます。",
  "loginProviders.done.saved": "保存しました。",
  "loginProviders.done.secretPending":
    "新しい値を受け取りました。テストログインが通ると使われます。",
  "loginProviders.done.enabled":
    "オンにしました。ログイン画面にボタンが表示されます。",
  "loginProviders.done.disabled":
    "オフにしました。セッションを {count} 件終了しました。",
  "loginProviders.done.refreshed":
    "設定ドキュメントを読み直しました。オンにする前にもう一度テストが必要です。",
  "loginProviders.result.title": "テストログインの結果",
  "loginProviders.result.passed": "テストが通りました。",
  "loginProviders.result.unrecorded":
    "プロバイダーは応答しましたが、テスト中に設定が変更されたため、合格として記録しませんでした。もう一度テストしてください。",
  "loginProviders.result.failed":
    "テストに失敗しました。オンのプロバイダーのログインはそのままです。",
  "loginProviders.result.reason": "理由コード",
  "loginProviders.result.subject": "Subject (sub)",
  "loginProviders.result.email": "メール",
  "loginProviders.result.emailVerified": "email_verified",
  "loginProviders.result.addressOwned": "アドレスの証明",
  "loginProviders.result.yes": "はい",
  "loginProviders.result.no": "いいえ",
  "loginProviders.result.unsaid": "送信なし",
  "loginProviders.result.addressOwned.yes":
    "プロバイダーは、このアドレスがこのアカウントのものだと証明しています。",
  "loginProviders.result.addressOwned.no":
    "プロバイダーはこのアドレスを証明していません。このアドレスではアカウントを探さず、参加もさせません。",
  "loginProviders.result.entry": "このアカウントがログインすると",
  "loginProviders.result.entry.signs_in":
    "連携済みのアカウントでログインします。",
  "loginProviders.result.entry.link_required":
    "同じアドレスのアカウントがありますが、このプロバイダーと連携していないためログインできません。",
  "loginProviders.result.entry.joins": "新しいメンバーとして参加します。",
  "loginProviders.result.entry.invite_only":
    "このアドレス宛ての招待がある場合のみ入れます。",
  "loginProviders.result.entry.domain_not_allowed":
    "許可ドメイン外のため拒否されます。",
  "loginProviders.result.entry.refused":
    "拒否されます。連携先のアカウントがオフになっているか、プロバイダーがアドレスを証明していません。",
  "loginProviders.result.back": "プロバイダーの設定へ",
};
