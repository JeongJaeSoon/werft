# API 서버 — 카탈로그, 자격 증명, checkpoint 저장소, 인증과 권한

API 서버가 운영자 카탈로그(Agent Profile·repository)와 자격 증명을 다루는 방식, checkpoint object store, API 인증과 세션 실행 권한을 적는다. 설정값은 [설정 레퍼런스](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/configuration/)에, worker 실행과 격리는 [실행 기반과 worker 격리](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/execution/)에 있다.

## provider 키와 저장소 자격 증명은 worker에 가지 않는다

worker 컨테이너 env에도, claim 응답에도 provider 키와 저장소 로그인이 없다. claim은 attempt마다 새로 만든 **egress token** 세 개만 준다(`runtime_config.provider.auth = {kind: "egress_token", token}`, `workspace.repository.access`, `object_store.access`). 세 token은 session credential과 수명이 같다. claim 재생이면 폐기하고 다시 발급하며, heartbeat가 연장하고, attempt가 끝나면 폐기한다. 각 token은 claim 시점의 profile fingerprint, 저장소 binding, 세션 object prefix에 묶여 있다.

* **credential route:** egress proxy는 forward proxy(3128) 옆에 두 번째 listener `EGRESS_CREDENTIAL_PORT`(기본 3129)를 연다. 이 listener가 받는 요청은 아래 일곱 가지뿐이고, 나머지는 404다.
  * `POST /provider/v1/messages`
  * `POST /provider/v1/messages/count_tokens`(query는 없거나 `?beta=true`)
  * `GET /repository/info/refs?service=git-upload-pack`
  * `POST /repository/git-upload-pack`
  * `/object-store/<bucket>/<key>` 아래의 S3 요청(아래 object store route)
  * `POST`·`GET`·`DELETE /mcp/<name>`(아래 "원격 MCP 서버" 절)
  * `POST /decisions/v1/decisions`(query 없음). worker가 아니라 API의 성과 판정기가 판정 token(`wej_`)으로 부르는 경로다. 이 경로의 grant는 `session_id`·`attempt_id` 대신 `judgment_id`를 담고, proxy는 이 경로의 usage를 `{exchange_id, judgment_id, usage}`로 보고한다. API는 이를 세션 비용이 아니라 판정 호출 원장에 `exchange_id`마다 한 번 적고 그 판정 행(`calls`·`input_tokens`·`cost_usd`)에 더한다. 같은 exchange를 다시 보고하면 다시 더하지 않는다. 판정 grant를 다른 경로에서 받거나 세션 grant를 이 경로에서 받으면 proxy는 503으로 거절한다. 이 경로가 없는 앞 버전 proxy도 판정 grant를 거절하므로, 배포는 proxy를 먼저 올린다. 판정기 upstream은 아직 없어서 이 경로의 authorize는 지금 503이다.
* **요청 하나의 처리:** proxy는 요청마다 API의 authorizer에 token을 묻는다. authorizer는 API의 별도 listener로, `EGRESS_AUTHORIZER_PORT`의 `POST /authorize`에서 `EGRESS_AUTHORIZER_TOKEN` bearer를 요구한다. 같은 listener의 `POST /usage`는 proxy가 Messages 호출의 usage를 보고하는 곳이다([설치 상한](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/configuration/#설치-상한)). token이 지금 유효하면 authorizer는 upstream과 붙일 헤더를 돌려준다. 유효하다는 것은 lease가 DB 시계로 살아 있고 epoch가 맞으며 purpose가 일치한다는 뜻이다. proxy는 worker의 token을 떼고 카탈로그의 자격 증명을 붙여 upstream으로 보낸다.
* **fail-closed:** 긍정 응답은 캐시하지 않는다. 그래서 authorizer가 죽어 있으면 503이고, attempt를 잃은 token은 다음 요청부터 401·409다.
* **upstream 연결:** upstream은 forward proxy와 같은 allowlist·주소 규칙으로 판정한다. 연결은 판정한 주소에 하고, TLS 인증서는 카탈로그의 host 이름으로 요청을 보내기 전에 검증한다. redirect는 따라가지도 전달하지도 않는다(502, GitHub의 경우는 아래 "GitHub 저장소" 절). 오류 본문에 주입한 자격 증명이 되비쳐 있거나, 본문이 압축돼 있거나, 64 KiB를 넘으면 본문을 보류한다.
* **요청 본문 상한:** Bun은 handler가 읽지 않은 요청 본문도 소켓에서 곧바로 받아 메모리에 쌓는다. 그래서 proxy는 await 전에, 요청 head만 보고 받을지 정한다. provider·repository 본문은 요청당 32 MiB(Messages API 한도)이고, 넘게 선언하면 authorizer에 묻기 전에 413이다. chunked 본문은 32 MiB까지만 읽고 413이다. object store 본문은 길이를 선언해야 한다(chunked면 411). 받은 요청은 선언한 길이(chunked면 32 MiB)만큼 설치 전체 예산 512 MiB(`DEFAULT_MAX_BODY_BYTES_IN_FLIGHT`)에서 떼어 두고, 교환이 끝나면 돌려놓는다(upstream은 본문을 다 받기 전에 답할 수 있다). 받은 본문은 예약한 크기의 버퍼 하나에 모은다. 예산에 들어가지 않는 요청은 503 `too many request bytes in flight`다. authorizer도 요청 본문을 16 KiB까지만 읽고 413으로 끊는다.
* **proxy 컨테이너:** compose `egress-proxy`는 worker처럼 `read_only`·`cap_drop: [ALL]`·`no-new-privileges`로 돌고 `/tmp`만 tmpfs다. `mem_limit`은 3072 MiB다. 요청 본문 예산 512 MiB, 응답 큐 64 MiB, forward proxy 큐 2048 MiB(연결 256 × 2 × 4 MiB), Bun 256 MiB를 더한 상한이다. 측정값이 아니다. 이 상한들을 바꾸면 한도도 같이 바꾼다. 죽으면 `restart: unless-stopped`로 같은 컨테이너가 다시 뜨고, worker 네트워크 연결은 그대로 남는다.
* **object store route:** 워커의 S3 SDK는 `object_store` token을 SigV4 access key id로(secret은 아무 값이나) 삼아 `<route>/object-store`에 path-style로 보낸다. proxy는 `Authorization`의 `Credential=`에서 token을 꺼내 요청의 method·target·헤더와 함께 authorizer에 묻는다. authorizer는 token과 generation fence를 확인하고 요청이 세션 prefix 안의 허용된 연산인지 판정한 뒤, API 자신의 키로 서명한 target과 헤더를 돌려준다. 허용하는 연산은 넷이다: prefix 안 object의 GetObject·HeadObject(버전 지정 포함), 새 key를 만드는 PutObject(`If-None-Match: *` 필수라서 덮어쓰기가 없다. checksum 헤더 허용), 세션 prefix의 ListObjectsV2. Delete, legal hold·retention·ACL, governance 우회, copy, multipart, version 목록, `aws-chunked` 본문, 인코딩된 `/`·dot segment는 전부 403 `AccessDenied`다. 모르는 token은 401 `InvalidAccessKeyId`다. proxy는 서명된 헤더와 target만 upstream에 보내고, PUT 본문은 서명된 길이만큼 흘려 보낸다(서명은 `UNSIGNED-PAYLOAD`, 요청당 512 MiB 상한). 비밀 키는 API를 떠나지 않는다. 다음 generation이 claim하면 이전 token의 새 요청은 곧바로 거부되고, 이미 열린 교환은 regrant 주기(30초) 안에 끊긴다. 그 사이에 끝나는 늦은 PUT도 create-only라서 이미 있는 object를 바꾸지 못하고, 커밋된 checkpoint가 가리키지 않는 object를 하나 더할 뿐이다. API는 checkpoint object store 설정(아래)으로 서명하며, `CHECKPOINT_OBJECT_STORE=disabled`면 이 route는 503이다.
* **engine:** `ANTHROPIC_BASE_URL`이 `<route>/provider`다. checkpoint fingerprint에는 여전히 카탈로그 endpoint가 들어가고, `auth_kind`는 `egress_token`이 된다. 따라서 이전에 만든 checkpoint는 fingerprint 불일치로 재개가 거부된다(출시 전이라 옮기지 않는다).
* **engine의 token은 env에 없다:** worker는 token을 env가 아니라 engine의 fd 3에 붙인 socket으로 준다(`CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR=3`). engine은 첫 요청 전에 한 줄을 읽고 fd를 닫는다. 그래서 turn 안의 도구는 자기 env에서도, 같은 uid인 모든 프로세스의 `/proc/<pid>/environ`에서도 token을 찾지 못한다. socket이라 `/proc/<pid>/fd/3`으로 다시 열 수도 없다.
  * `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`은 쓰지 않는다. bubblewrap이 필요하고, 워커 격리(`cap_drop: ALL`, `no-new-privileges`)에서는 namespace를 만들지 못한다. permission mode도 `default`로 강제한다.
  * 남은 경로는 engine 메모리를 읽는 것(ptrace, `process_vm_readv`)이다. 도구는 engine의 자손이므로 host의 `kernel.yama.ptrace_scope`가 1 이상이면 막힌다. 0인 host에서는 막히지 않는다.
  * LiteLLM `bearer` 인증은 fd 경로가 없어 `ANTHROPIC_AUTH_TOKEN` env로 준다. worker는 늘 `egress_token`을 쓰므로 이 경우가 없다.
* **git:** `<route>/repository`로 clone하며 token은 git 자식 프로세스의 `http.extraHeader`로만 들어간다. `http.followRedirects=false`를 걸고, clone 직후 origin을 카탈로그 URL(userinfo 없음)로 되돌린다. push 경로는 없다. 대신 `GET …/info/refs?service=git-receive-pack`에는 authorizer에 묻지 않고 `ERR` pkt-line 하나로 고정 안내를 답하므로, 세션의 `git push`는 `fatal: remote error: git push does not reach GitHub here. Push and open pull requests with the platform's GitHub tools (…)`로 끝난다(`PUSH_NOTICE`). receive-pack POST와 그 밖의 경로는 여전히 404 `no such credential route`다.
* **이벤트에서 값 지우기:** engine의 도구는 worker 프로세스의 env를 읽을 수 있다. 그래서 worker는 자기가 가진 비밀을 값 그대로 찾아 `<redacted>`로 바꾼 뒤 이벤트·pending 요청을 내보낸다. 대상은 nonce, session credential, egress token 셋이다. base64처럼 다시 인코딩된 값은 걸러지지 않는다. token은 attempt 범위이고 worker 네트워크 밖에서는 쓸 수 없으므로 그 한계를 받아들인다.
* **이벤트·승인 요청의 가림:** worker는 그에 앞서 Claude adapter의 규칙(`packages/adapters/runtimes/claude/src/mapper.ts`)으로 tool event와 승인 요청의 `input`을 가린다. `authorization`·`cookie`·`secret`·`password`·`api_key` 같은 키의 값과 `Bearer …`·`sk-ant-…` 모양의 값은 `[REDACTED]`가 된다. 문자열 안의 `api_key=값`은 값이 끝나는 곳이 분명할 때만 값만 가린다. 값이 한 단어이고 뒤에 공백·`&`·`;`·`|`·`)`나 문자열 끝이 오거나, 값 전체가 펼칠 것 없는 따옴표 문자열 하나일 때다. 그 밖의 경우(`password: 값`, escape, `$'…'`, 이어 붙인 따옴표, 다음 줄에 오는 값)는 문자열 전체를 가린다. 경로(`file_path`·`path`·`notebook_path`·`cwd`)는 키 이름으로 가리지 않는다. 사용자가 어떤 파일을 쓰는 요청인지 보고 승인해야 하기 때문이다. 경로 안에 `api_key=…` 같은 조각이 있으면 다른 문자열처럼 그 값만 가린다. 승인 답을 맞춰 보는 `input_hash`는 가리기 전의 실제 인자로 계산한다.
* **로그 마스킹:** worker와 egress-proxy의 stdout 로그도 API와 같은 규칙(`packages/observability/src/redaction.ts`)으로 가린다. `authorization`·`token`·`secret`·`password`·`credential`·`api_key` 같은 키의 값, `Bearer …`·`sk-…`·`gh?_…`·`AKIA…` 모양의 값, `token=`·`password:` 같은 조각이 든 문자열은 `[REDACTED]`가 된다. URL의 login(`https://user:pass@host`)은 그 부분만 가린다. worker는 여기에 더해 위의 비밀 값을 `<redacted>`로 바꾼다. egress-proxy 이미지는 workspace 의존성을 싣지 않으므로 같은 파일의 사본(`apps/egress-proxy/src/redaction.ts`)을 쓰고, unit test가 두 파일이 같은지 확인한다. worker 로그 줄은 `{timestamp, level, event, ...fields}`이고, fields가 `timestamp`·`level`·`event`를 덮지 못한다. worker 로그 수준은 scheduler의 `LOG_LEVEL`을 따른다. scheduler가 worker 컨테이너를 만들 때 자기 값을 env로 넘긴다. 이 값은 격리 계약 stamp에 들어가지 않으므로, 값을 바꾼 뒤 scheduler가 재시작하면서 adopt한 컨테이너는 만들어질 때의 수준을 그대로 쓴다. 새 수준은 다음에 새로 뜨는 worker부터 적용된다.
* **compose:** `api`는 `EGRESS_AUTHORIZER_PORT=3100`을 publish하지 않는다. 어느 worker allowlist에도 없으므로 compose 네트워크의 `egress-proxy`만 부른다. `EGRESS_AUTHORIZER_TOKEN`의 compose 기본값은 로컬 스택 전용이므로 다른 곳에서는 `../.env`로 바꾼다. host에서 띄운 API를 쓸 때는 `EGRESS_AUTHORIZER_URL=http://host.docker.internal:3100`을 준다. 두 값 중 하나만 있으면 API와 proxy 모두 기동을 거부한다. 둘 다 없으면 경고만 내고 뜨지만, 그 상태의 worker는 provider에도 저장소에도 닿지 못한다.

## 운영자 카탈로그 (Agent Profile · repository)

API와 slack 역할은 설정 파일을 읽지 않는다. 연결·저장소·MCP 서버·설치 상한은 모두 DB 행이고, 콘솔이나 설정 문서로 넣는다([설계](../contributing/decisions/settings-replace-file-catalog.md)). 예전 변수 `PLATFORM_CONFIG_DIR`이나 `SESSION_CATALOG_JSON`이 남아 있으면 `finish the import ... then unset` 메시지와 함께 기동을 거부하고, `PLATFORM_SECRET_KEY`가 없어도 기동하지 않는다.

- **빈 설치에는 기본 프로필이 없다.** 새 DB에는 연결도 상한도 없다. 콘솔에서 연결을 더하고(설정 > 에이전트 연결 > **모델 연결**, `프로필` 화면에는 연결을 더하는 곳이 없고 이 화면으로 가는 링크만 있다) 그 연결로 상한을 만든 뒤 에이전트를 시작한다. 예시 스택(`scripts/local.sh up --fake-model`, E2E)은 `tests/fixtures/settings/`의 문서를 migrate 단계에서 가져와 미리 채운다(아래 "예시 설정 문서"). `SETTINGS_DOCUMENT=` 처럼 비워 띄우면 빈 설치를 그대로 볼 수 있다.
- **연결이 상한의 조건이다.** 설정의 연결 하나가 profile의 `provider` 값과 같은 모양이다. provider 자격 증명은 이 연결에서만 푼다. 상한은 provider가 연결 하나와 정확히 같을 때만 돌고, 아니면 `connection_missing`으로 빠진다. 연결을 사용 중지하면 그 위의 상한이 모두 멈춘다.
- **상한은 콘솔이나 `POST /v1/installation-profiles`로 만들고 바꾼다.** 설치 상한 profile(운영자 profile)의 정본은 DB의 `installation_profiles`다([설계](../contributing/decisions/profile-db.md)). `settings import`가 `installation_profiles`를 채우는 경우는 둘뿐이다. 표가 비어 있을 때 문서의 `profiles`(CLI 전용)나 옛 파일 시드를 넣고, 예전 행 중 `repository_ids`가 NULL인 것을 문서의 저장소 `profiles` 배열로 채운다. 문서를 고쳐 다시 가져와도 이미 행이 있는 표에는 상한이 더해지지 않는다.
- **기존 설치의 파일 출처 프로필은 그대로 남는다.** `origin = 'catalog'` 행은 지워지지도 새로 만들어지지도 않는다. 운영자가 차단한 상한은 차단된 채로, 연결이 없던 상한은 `connection_missing`인 채로 남고, 콘솔에서는 `설정 문서에서 가져옴`으로 보인다. 파일을 지우는 것만으로 이 행들이 사라지지 않으므로, 쓰지 않을 상한은 콘솔에서 차단하거나 은퇴시킨다.
- **시드의 `tools`는 일부러 허용목록이다.** 새 설치가 "제한 없음"이 아니라 좁게 시작하게 하려는 기본값이다. `POST /v1/installation-profiles`·`POST /v1/workspace-profiles`로 만드는 새 버전은 `tools` 대신 막을 내장 도구 `deny`를 보낼 수 있다(둘 중 정확히 하나). 서버가 쓰기 때 `tools`를 계산해(상한은 `지원 목록 − deny`, 워크스페이스 판은 `바탕 tools ∩ 지원 목록 − deny`이고 바탕이 같은 지원 목록의 deny 판이면 바탕 deny ⊆ deny가 아닐 때 400 `base_denies`) 정의(워크스페이스 판은 `workspace_profiles.tools`)에 저장하고, `deny`와 지원 목록 id는 정의 밖 열(`deny`·`tool_catalog_id`)과 receipt에만 남긴다. 그래서 내장 도구 쪽은 profile 지문과 checkpoint 복원이 지금처럼 `tools`만 본다. `mcp_deny`는 profile 뷰에 실려 지문에 들어간다. 지원 목록은 엔진 버전 조합마다 `packages/adapters/runtimes/claude-codec/src/tool-catalog.ts`에 있고(SDK 버전 상수 `versions.ts` 옆), `GET /v1/installation-profiles/options`의 `tool_catalogs`로 나간다. 목록이 없는 runtime 버전은 `tools` 요청만 받는다. `deny`는 내장 도구 이름과 도구 하나를 가리키는 `mcp__<server>__<tool>` 이름을 받고, 패턴(`Bash(rm:*)`, `mcp__*`)은 400이다. `mcp__` 이름은 DB의 `deny` 열에 내장 도구와 함께 저장되고 응답과 release에는 `mcp_deny`로 갈라져 나온다. 엔진이 아니라 MCP egress가 호출마다 deny 우선으로 집행한다(`packages/platform/src/sessions/mcp-tool-decision.ts`, `packages/platform/src/workers/mcp-egress.ts`). 사용자 쪽 규칙은 공개 문서 "프로필 고르기"의 도구 차단목록 절에 있다.
- **엔진을 올리면 새 도구는 막힌 채 이어진다.** SDK를 올리면 `runtime_version`도 올리므로([이미지와 공급망](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/images-and-supply-chain/)) 모든 상한에 새 버전이 필요하다. 새 버전의 `tools`에 들어갈 도구 중 이전 버전이 따져 보지 않은 것(새로 지원된 도구, 이전 버전이 허용목록이면 그 밖의 도구)은 `deny`에 두거나 `accept_added_tools`로 받아들여야 하고, 아니면 400 `added_tool_not_accepted`다. 기존 버전·release·세션은 새 도구를 얻지 않는다. provider 쪽에서 도는 도구(`WebSearch`, 목록의 `boundary: provider`)는 egress proxy가 막지 못하므로 새 이름의 첫 버전은 그 도구를 `deny`에 넣고 시작하기를 권한다.
- **저장소의 `profiles` 배열은 시드로만 읽는다.** 표가 빈 설치에 시드할 때 각 상한의 `repository_ids`가 이 배열에서 정해진다. 그 뒤 허용은 DB의 `repository_ids`만 본다(아래). 이 배열은 행의 내용이 아니므로 다시 가져올 때 충돌로 세지 않는다.

### 설정 문서 가져오기·내보내기

연결·저장소·MCP 서버는 DB 행(`provider_connections`, `catalog_repositories`, `mcp_servers`)이다. 콘솔에서 하나씩 다루거나 **설정 문서** 하나로 넣고 꺼낸다.

- **형식.** `{"version": 1, "connections": {…}, "repositories": {…}, "mcp_servers": {…}}`. 값을 DB에 두는 자격 증명은 `"auth": {"stored": true}`로 적고, 가져올 때 그 항목 자신의 참조(`connection:<id>` 등)가 된다. 내보내면 `{"stored": true, "last4": "…"}`로 나오고 값은 나오지 않는다. CLI는 예시 스택을 위해 최상위 `profiles`(상한 시드)도 받는다. API는 이 키를 거절하고, 내보내기에도 나오지 않는다. 상한은 콘솔·`POST /v1/installation-profiles`로 다루고, master key는 문서에 들어가지 않는다.
- **가져오기는 더하기만 한다.** 문서의 항목마다 새 행(`add`), DB와 같은 행(`unchanged`), 꺼진 행과 같은 id(`inactive`), 값이 아직 없는 stored 자격 증명(`needs_value`)으로 나눈다. 같은 id인데 내용이 다르거나 같은 GitHub 저장소(owner/name)를 다른 id로 적으면 `conflicts`이고, 그러면 아무것도 쓰지 않는다. 같은 문서를 다시 가져오면 모두 `unchanged`이고 `settings_generation`도 그대로다. 행을 고치거나 지우는 일은 하지 않는다.
- **API.** `GET /v1/installation/settings/export`는 `{document, digest}`를 준다. `POST /v1/installation/settings/import?dry_run=true|false`는 문서를 body로 받는다. 둘 다 설치 owner의 로그인 세션만 부를 수 있다(`installation.settings.manage`). API 키와 admin·member는 `403`이다. 충돌은 `409 REVISION_CONFLICT`(`reason_code: settings_conflict`, 충돌 항목 목록), 문서의 뼈대(`version`, 최상위 키)가 틀리면 `400 BAD_REQUEST`(`details.issues`에 틀린 칸)이고, 항목이 카탈로그 규칙에 맞지 않으면 `400 BAD_REQUEST`(`reason_code: invalid_document`)다. API는 `value_env`·`secret_id` 같은 바깥 참조를 새로 받지 않는다(`400 BAD_REQUEST`, `reason_code: external_reference`와 해당 항목 목록). 서버 프로세스 환경을 가리키는 참조는 운영자가 서버에서 CLI로만 넣는다. 더한 행마다 receipt(`import_connection`·`import_repository`·`import_mcp_server`)가 남는다. 워크스페이스가 아직 없으면 receipt는 남지 않는다.
- **CLI.** compose 설치에서는 `bun run settings export > settings.json`(문서는 stdout, `digest sha256:…`는 stderr), `bun run settings import --document - [--dry-run] < settings.json`을 쓴다. 명령은 api 컨테이너 안에서 돌므로 `--document`에 경로를 주면 컨테이너 안의 경로로 읽는다. host의 파일은 `-`(stdin)로 넘긴다. Kubernetes 설치는 `bun run settings:k8s …`로 api Pod 안에서 같은 CLI를 돌린다. CLI는 바깥 참조를 받는다. 거절되면(충돌·바깥 참조) 1로 끝난다.
- **콘솔.** 설치 owner는 설정 > 에이전트 연결의 **모델 연결**(`/settings/workspace/model-connections`)에서 연결을, 같은 그룹의 **MCP 서버**(`/settings/workspace/mcp-servers`)에서 MCP 서버를 보고 더하고 바꾼다. 옛 주소 `/settings/workspace/connections`는 없다(찾을 수 없음 화면, 리다이렉트 없음). 저장소는 **설정 > 워크스페이스 > 연동 > GitHub**에서 App 연동으로 등록한다. 연결·MCP 서버 콘솔이 하는 일은 여섯이다(저장형으로 옮기기와 다시 켜기는 연결만).
  - **만들기.** 값은 항상 DB에 저장한다(`stored`). 바깥 참조(`value_env`·`secret_id`)는 받지 않는다. endpoint·URL·자격 증명 출처는 만든 뒤 바꿀 수 없으므로 바꾸려면 새 id로 만든다(운영자 참조 연결의 키를 직접 입력한 저장값으로 옮기는 것만 아래 "저장형으로 옮기기"로 같은 id에서 된다). 연결의 `endpoint`는 비워도 된다(없음·`""`·공백). 비면 종류의 공식 주소(anthropic은 `https://api.anthropic.com`)를 만들 때 채워 저장하므로, 행은 늘 구체 URL을 갖고 지문·export·세션이 코드 상수 변경에 움직이지 않는다. 기본값이 없는 종류(litellm)는 `400 BAD_REQUEST`, `reason_code: invalid_entry`로 거절한다. 기본 주소에 `billing: none`은 공개 주소라 상한이 거절하므로 같이 만들 수 없다. 화면은 `GET …/connections`의 `endpoint_defaults`(종류 → URL)로 칸을 미리 채운다. 설정 문서 import도 endpoint가 빈 연결 항목을 같은 기본값으로 풀며(형식 v1 그대로), export는 구체 URL을 낸다. 기본 주소의 host(`api.anthropic.com:443`)는 `EGRESS_CREDENTIAL_ALLOWLIST` 기본값에 있어야 세션이 돈다. 한 번 쓴 id(사용 중지한 것 포함)는 다시 쓸 수 없다(`409 REVISION_CONFLICT`, `reason_code: already_exists`). 연결의 endpoint `host:port`가 proxy의 자격 증명 허용 목록(`EGRESS_CREDENTIAL_ALLOWLIST`·`EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST`, compose는 api에도 같은 값을 준다)에 없으면 화면이 경고만 한다. 저장은 되고, proxy가 그 목적지를 열지 않을 뿐이다. 저장소는 워크스페이스의 GitHub App 연동으로만 등록한다.
  - **값 바꾸기.** 저장된 값만 바꾼다. 연결의 fingerprint와 binding은 그대로이고 도는 세션은 멈추지 않는다. 운영자 참조(`value_env`·`secret_id`) 행은 `409`(`reason_code: not_stored`)다.
  - **저장형으로 옮기기(연결만).** 운영자 참조(`value_env`·`secret_id`) 연결은 owner가 콘솔에서 키를 입력하면 같은 id 아래 봉인되고 그 행은 이후 저장형이 된다. 서버는 참조한 값을 읽지 않는다. 이미 저장형이면 `409`(`reason_code: not_external`), 사용 중지한 행은 `409 disabled`, 다른 연결이 그 정의와 같거나 같았으면 `409 alias_taken`이다. 이전에 만든 상한은 저장한 키로 계속 돈다.
  - **사용 중지.** 아무것도 지우지 않는다. id는 계속 점유되고(새로 만들 때 `409 REVISION_CONFLICT`, `reason_code: already_exists`) 저장된 값은 봉인된 채 남는다. 그 연결을 쓰는 상한은 다시 켜기 전까지 `connection_missing`이 된다. MCP 서버는 다시 켜는 API가 없어 사용 중지를 되돌릴 수 없다. 운영자 참조 행도 사용 중지는 된다.
  - **다시 켜기(연결만).** 사용 중지한 연결을 되살린다. 그 연결 위의 상한은 설정을 다시 읽은 뒤 다시 그 연결을 찾는다. 이미 쓰는 행은 `409`(`reason_code: not_disabled`), 같은 정의(또는 그 옛 참조)를 다른 켜진 연결이 갖고 있으면 `409`(`reason_code: definition_active`, 그 연결을 먼저 사용 중지한다), 저장된 값이 없으면 `409`(`reason_code: needs_value`)다. 운영자 참조는 열어 보지 않으므로 풀리지 않으면 목록에 `unresolved`로 보인다. 연결의 주소는 바뀌지 않는다.
  - **좁은 변경.** MCP 서버의 워크스페이스 목록만 바꾼다. 운영자 참조 행에서는 `409 not_stored`다.
  API는 `GET|POST /v1/installation/settings/{connections|mcp-servers}`, `POST …/{id}/credential`, `POST …/{id}/disable`, `POST /v1/installation/settings/connections/{id}/convert`, `POST /v1/installation/settings/connections/{id}/enable`, `PATCH /v1/installation/settings/mcp-servers/{id}`다. 모두 로그인 세션만 받고 API 키는 `403`이다. 변경마다 receipt(`create_connection`·`create_mcp_server`·`set_settings_credential`·`disable_connection`·`enable_connection`·`disable_mcp_server`·`set_mcp_server_workspaces`)가 남는다. MCP 서버 화면은 도구 목록 대신 서버의 도구 이름 공간 `mcp__<id>__*`만 보인다. 도구 하나만 막으려면 에이전트 카드의 `capabilities.tool_policy.per_tool`에 `mcp__<id>__<도구>: deny`를 적는다. release 핀에 그대로 남고, 에이전트 설정이 같은 도구를 허용해도 deny가 이긴다. 그 도구는 세션의 도구 목록(claim)에서 빠지고, egress는 그 도구의 `tools/call`을 `403 FORBIDDEN`("The release does not allow this MCP tool")으로 거절하며 receipt는 남기지 않는다. `mcp__` 규칙은 내장 도구와 같은 워크스페이스·에이전트 엔진 설정의 `permissions.deny` 목록에도 쓸 수 있다. 병합할 때 `mcp__` 규칙만 따로 빠져(`packages/platform/src/sessions/engine-settings-merge.ts`의 `mcpDeny`) 엔진의 `disallowedTools`로는 가지 않고, MCP egress가 `tools/call`마다 위 release deny와 같은 판정에서 deny 우선으로 집행한다(`packages/db/src/mcp-egress.ts`의 `withoutSavedMcpDenies`). 엔진 규칙을 읽을 수 없으면 모든 도구를 거절한다.
- **롤백 하한.** 가져오기가 `auth_kind`가 `none`·`basic`·`bearer`·`github_app_explicit`인 저장소 행을 한 번이라도 쓴 DB는 migration 0225(commit `e1a26586`)보다 앞선 이미지로 되돌리지 않는다. 앞선 이미지는 `auth_kind`를 모르므로 그 행을 GitHub App 저장소로 읽는다. 파일을 읽지 않는 판으로 올린 설치의 되돌리기 하한도 같다. S1 앞 이미지는 올린 뒤 콘솔로 더한 행을 읽지 못한다.
- **`catalog_authority` 표.** 런타임과 CLI는 더 읽지 않지만 표는 이번 판에서 지우지 않는다. 한 판 앞 이미지로 되돌릴 수 있게 두고, 호환을 끊는 다음 판에서 지운다.

**URL 저장소 제거 판의 배포 전 조건.** `none`·`basic`·`bearer` 행은 원본을 보존한 채 invalid로 보고하고 실행 카탈로그에서 제외한다. 그 저장소의 대기 세션은 claim할 수 없고, 이미 claim한 세션의 다음 저장소 egress 요청은 `409 CATALOG_MISMATCH`, GitHub gate 작업은 저장소 이동 오류로 거부된다. 이미 실행 중인 프로세스를 즉시 종료하는 변경은 아니지만 저장소 작업과 재개는 계속될 수 없다.

이 판은 일반 설치에서 롤링 교체하지 않는다. 새 이미지를 먼저 준비한 뒤 `api`·`slack`의 모든 replica를 멈추고 프로세스가 남지 않았음을 확인한다. 그 창 안에서 아래 직접 검사의 후보가 0일 때만 모든 replica를 새 이미지로 다시 연다. 0이 아니면 이전 이미지로 다시 열고 결과를 보고한다. 세션을 대신 끝내거나 원본 행을 삭제하지 않는다.

후보는 주 저장소, 붙인 목록, 붙인 목록이 NULL일 때의 유효 정책 목록에서 레거시 행을 가리키는 값이다. NULL은 빈 목록이 아니라 정책 목록 전체라는 뜻이므로 정책 경로도 센다. 이전 이미지에서 실제 접근 가능한 확정 목록을 계산할 수 있지만 판정 기준은 더 넓은 **후보 0**이다. 새 이미지의 카탈로그에서 레거시 행이 빠진 것을 후보 0의 근거로 쓰지 않는다. 워크스페이스·세션·저장소·경로별 결과와 후보 수를 보고한다.

```sql
SELECT coalesce(a.workspace_id, s.workspace_id) AS workspace_id,
       s.id AS session_id, x.repository_id, x.via, c.auth_kind
FROM sessions s
LEFT JOIN agent_releases r ON r.id = s.agent_release_id
LEFT JOIN agents a ON a.id = r.agent_id
LEFT JOIN agent_github_settings g ON g.agent_id = r.agent_id
CROSS JOIN LATERAL (
  SELECT s.repository_id, 'primary'
  UNION ALL
  SELECT id, 'attached' FROM unnest(s.attached_repository_ids) AS id
  UNION ALL
  SELECT e, 'policy'
  FROM (SELECT CASE s.github_policy_source
                 WHEN 'release' THEN r.policy_pins #> '{github,repositories}'
                 WHEN 'agent' THEN g.repositories
               END AS list) p,
       jsonb_array_elements_text(
         CASE WHEN jsonb_typeof(p.list) = 'array' THEN p.list ELSE '[]' END
       ) AS e
  WHERE s.attached_repository_ids IS NULL
) AS x(repository_id, via)
JOIN catalog_repositories c ON c.id = x.repository_id
WHERE s.status NOT IN ('failed', 'stopped')
  AND c.auth_kind IN ('none', 'basic', 'bearer');
```

main을 자동으로 따라가는 설치는 머지가 곧 배포이므로, 위 직접 검사의 후보가 0임을 배포 전에 읽기 전용으로 확인한다. 배포가 끝날 때까지 URL 저장소 행을 더하지 않고, 끝난 뒤 검사를 다시 돌린다.

**파일 카탈로그에서 옮기기.** 파일 카탈로그로 돌던 설치는 옛 파일을 migrate 단계가 한 번 가져온다.

1. 올리기 전에 설정 디렉터리를 `PLATFORM_LEGACY_CONFIG_DIR`(compose) 또는 옛 chart의 ConfigMap(Kubernetes)으로 준다. compose는 `/legacy-config`에 읽기 전용으로 마운트한다.
2. 새 이미지로 올리면 migrate가 `settings import --from-dir /legacy-config --if-present`를 돌린다. 디렉터리가 없거나 비었으면 건너뛰고, 일부만 있거나 깨졌으면 실패해서 새 API가 뜨지 않는다. `repositories.yaml`에서 `auth`가 없거나 `basic`·`bearer`인 저장소는 실패하지 않고 빠진다. 가져오지 않은 항목마다 stderr에 `note: repository <id> is not imported`가 적히고, 나머지는 그대로 들어간다. 빠진 저장소는 콘솔에서 GitHub App으로 다시 등록한다. 상한의 `repository_ids`는 이 가져오기 때 한 번 채워지므로(`NULL`이던 행), 빠진 저장소를 다시 등록한 뒤에는 상한의 허용 저장소도 새 버전으로 고쳐 저장한다. 저장소가 모두 빠져도 상한은 가져온다. 그 상한은 허용 저장소가 비어 있어 어디서도 돌지 않고, 저장소를 다시 등록한 뒤 새 버전으로 허용 저장소를 채워야 돈다. 빠진 저장소를 가리키는 진행 중 세션(`failed`·`stopped`가 아닌 것)이 있으면 가져오기는 아무것도 쓰지 않고 1로 끝나며 stderr에 세션과 저장소 id를 적는다. 이 세션은 새 이미지에서 `failed`가 되기 때문이다. migrate가 실패하면 새 API가 뜨지 않아 콘솔로 저장소를 다시 등록할 수 없다. 이전 이미지로 다시 열고 그 세션을 끝낸 뒤 올린다. `--dry-run`도 같은 이유로 멈추므로 api·slack을 멈추는 창 안에서 먼저 돌려 본다. 세션이 정책 목록에 이름만 올라 있어도 걸린다. CLI의 `--document`는 같은 규칙으로 레거시 항목을 빼고 이 검사를 거친다. API import는 레거시 항목을 빼지 않고 `400 BAD_REQUEST`로 거절한다. `profiles.yaml`은 `installation_profiles`가 빌 때만 넣고, `repository_ids`가 NULL인 행은 저장소 `profiles` 배열로 채운다. 채울 저장소가 없는 행은 stderr에 `note: no repository names these ceilings`로 적히고, 그 상한은 어떤 저장소에서도 돌지 않는다. 미리 보려면 같은 명령에 `--dry-run`을 붙인다.
3. `platform.yaml`은 가져오지 않는다. master key는 올리기 전에 `PLATFORM_SECRET_KEY`로 옮긴다. 파일의 `secret_key`가 가리키던 값과 같은 값이어야 저장된 자격 증명을 읽는다. 이미 `PLATFORM_SECRET_KEY`를 쓰던 설치도 같은 값을 유지한다. master key 없이 돌던 설치는 새 키를 먼저 넣는다. 없으면 API와 slack 역할이 기동을 거부한다.
4. `PLATFORM_CONFIG_DIR`을 지운다. 남겨 두면 API와 slack 역할이 기동을 거부한다.
5. 가져온 뒤에는 파일과 `PLATFORM_LEGACY_CONFIG_DIR`을 지워도 된다. 다시 돌려도 더하기만 하므로, 같은 파일이면 모두 `unchanged`이고 고친 파일은 `conflicts`로 멈춘다. 저장소만은 예외다. 위의 GitHub App 없는 항목은 매번 `note:`만 남기고 빠진다. 콘솔이나 API로 브랜치를 바꾼 저장소와, 이미 행이 있는 GitHub 저장소를 다른 id로 적은 항목은 멈추지 않고 DB 행을 남긴 뒤 결과의 `kept`와 stderr의 `note:`로 알린다. 파일의 `profiles.yaml`은 표가 빌 때만 읽히므로, 표가 채워진 설치에서는 이 이미지가 싣지 않은 runtime이 적혀 있어도 멈추지 않는다. 그 뒤 변경은 콘솔에서 한다.

같은 id를 이미 DB 행으로 둔 설치도 같다. 파일의 값이 행과 같으면 `unchanged`이고 fingerprint·binding·release id는 바뀌지 않는다.

- profile의 `provider.auth`에는 값 대신 참조를 하나만 적는다: API 프로세스 환경 변수 `value_env`, 또는 Secrets Manager `secret_id`(`AWS_ENDPOINT_URL_SECRETS_MANAGER`로 endpoint 지정, `AWS_ENDPOINT_URL`은 따르지 않는다). 값은 기동 시 한 번 해석되고 worker에는 가지 않는다. egress proxy의 credential route가 요청마다 authorizer에 물어 upstream 요청에 붙인다(위 절).
- profile의 `models`는 세션이 `POST /v1/sessions`의 `model`로 고를 수 있는 모델 목록이다. `model`은 기본값이고 늘 고를 수 있다. 목록에 없는 모델로 만들면 `422 UNSUPPORTED_CAPABILITY`이고 세션은 생기지 않는다. `model`을 생략하면 `agent_release_id`가 있을 때는 release 카드의 모델, 없으면 profile의 `model`로 돈다. 세션은 고른 모델을 `sessions.model`에 적고(세션 응답의 `model`), profile 지문과 이 모델에 묶인다. 그래서 목록에 모델을 더하거나 기본 `model`을 바꿔도 기존 세션은 그대로 돈다. 세션이 쓰는 모델을 목록에서 빼면 그 세션은 아래와 같이 `CATALOG_MISMATCH`가 된다. provider·`billing`·tools는 profile 단위라 모델을 골라도 바뀌지 않고, 비용은 응답이 밝힌 모델 가격으로 매겨져 세션 상한에 그대로 걸린다.
- 세션 제목: 만들 때 `title`이 없으면 첫 메시지를 80자에서 자른 값이 제목이 된다. 첫 turn이 `completed`로 끝나면 API가 그 turn의 메시지와 답을 보여 주고 짧은 제목을 한 번 받아 바꾼다. 호출은 `SESSION_TITLE_EGRESS_URL`(compose 기본값 `http://egress-proxy:3129`)의 provider route로 가므로, proxy가 profile의 자격 증명을 붙이고 usage를 첫 turn의 attempt에 적는다. 그래서 비용은 세션 usage와 세션 상한에 들어간다. 모델은 profile의 선택 필드 `title_model`이고, 없으면 세션의 모델이다. `title_model`은 지문에 들어가지 않아 더하거나 바꿔도 기존 세션은 그대로 돈다. 사용자가 만들 때 준 제목이나 `PATCH /v1/sessions/{id}`로 바꾼 제목(`sessions.title_source = 'user'`)은 덮어쓰지 않는다. 생성 결과가 PATCH보다 늦게 와도 마찬가지다. 호출이 실패하거나 빈 답이면 첫 메시지 제목이 남는다. 변수를 비우면 이 기능은 꺼진다. 이 판보다 앞선 API replica와 함께 도는 rollout 동안에는 변수를 비워 둔다. 앞선 API에서 첫 메시지 제목과 같은 값으로 rename하면 DB에 아무것도 남지 않아, 그 세션의 첫 turn이 나중에(rollout 뒤라도) 끝날 때 생성 제목이 그 값을 덮을 수 있다. 변수를 비워도 그렇게 rename된 세션은 막지 못하고 새로 노출되는 범위만 줄인다.
- 상한 행의 `repository_ids`가 그 상한이 돌 수 있는 저장소 allowlist다. `(profile, repository)` 쌍이 신뢰 단위이며, 허용되지 않은 쌍이나 모르는 id로 `POST /v1/sessions`를 부르면 `422`다. 단 GitHub 설정 행이 있는 에이전트의 세션과 `repository_scope`가 `workspace`이거나 없는 profile은 쌍 대신 워크스페이스 상한이 저장소를 판정한다. 행은 바뀌지 않으므로 허용을 바꾸려면 새 상한 버전을 저장한다. 옛 버전과 그 위의 세션은 옛 허용 그대로 돈다.
- 이미 만든 세션의 상한이 차단되거나 연결을 잃었거나, id가 다른 URL·branch를 가리키게 되거나, 같은 profile id의 설정(tools·permission_mode·endpoint·runtime version·project_settings·자격 증명 참조 위치)이 세션을 만들 때와 달라지거나 세션의 모델이 `models`에서 빠지면, 세션 상세의 `attention`이 `CATALOG_MISMATCH`가 되고 그 세션으로 뜬 worker의 첫 claim이 `409 CATALOG_MISMATCH`를 받는다. 그 자리에서 대기 중이던 turn은 `failed`(`terminal_reason: catalog_mismatch`), 해당 receipt는 `CATALOG_MISMATCH`, 세션은 `failed`가 되고 status 이벤트에 같은 코드가 남는다. worker는 claim timeout을 기다리지 않고 바로 나가며, 다음 scheduler pass가 슬롯을 돌려받아 다른 세션을 띄운다. 메시지에는 저장소 id만 적히고 URL은 나오지 않는다. `resuming` 중인 세션이면 resume이 `CATALOG_MISMATCH`로 실패해 `recovery_required`로 가고, 대기 중인 입력은 복구 결정을 위해 남는다.
- **카탈로그를 되돌려도 저절로 다시 실행되지는 않는다.** 되돌리면 `attention`이 사라지고, 그 세션에 새 메시지를 보내면 새 generation으로 다시 뜬다. 실패한 turn은 재시도되지 않으므로 필요한 입력은 다시 보낸다. 되돌리지 않은 채 메시지를 보내면 그 입력도 첫 claim에서 곧바로 같은 코드로 실패한다(추가 메시지를 422로 막지는 않는다 — 받은 입력은 receipt로 결말을 알린다).
- **이 즉시 실패는 최신 설정을 읽은 replica만 쓴다.** 각 API는 자기가 읽은 DB 설정으로 판단한다. claim transaction 안에서 그 판단이 읽은 `settings_generation`과 지금 값을 비교해, 읽은 값이 뒤처졌으면 세션을 실패시키지 않고 claim에 `404 NOT_FOUND`(잡을 세션 없음)로 답한다. worker는 claim timeout 뒤 나가고 다음 launch가 새 설정으로 다시 판단한다. 운영자가 할 일은 없다.
  - **차단은 예외다.** 상한이 차단돼 있으면 claim이 그 transaction 안에서 상한 행을 다시 읽고, 읽은 설정이 뒤처졌어도 세션을 실패시킨다. 차단은 모든 replica에 같은 DB 행이기 때문이다.
  - **판단 기록:** 쌍을 빼는 일이 보안 경계라면(그 저장소에서 더는 돌면 안 되는 경우) 상한을 차단한다. 차단은 다음 claim부터 모든 replica에 바로 듣는다.
- 저장소는 GitHub App으로만 등록한다. `repositories.<id>.auth`는 필수이고 `kind: github_app`이다(아래 절). `auth`가 없거나 `basic`·`bearer`인 항목은 받지 않는다. worker는 자격 증명을 받지 않고 proxy의 저장소 route로 clone한다.
- 자격 증명은 8바이트보다 짧으면 쓰지 않는다. API는 그대로 뜨고 그 항목만 빠진다. proxy는 upstream 응답에 주입한 값이 되비치는지 검사하는데, 스트림 본문에서는 8바이트 이상인 값만 검사하기 때문이다.
- endpoint·저장소 URL은 `http://`·`https://`만 받는다(worker가 밖으로 나가는 길은 HTTP(S) egress proxy뿐이다). 자격 증명(userinfo, query string)이 들어 있으면 거절한다.
- profile마다 `sha256:` fingerprint(설정과 참조의 정규 JSON 해시, 값 제외)가 worker claim의 `profile_fingerprint`로 간다. 같은 참조 뒤의 값만 회전하면 fingerprint는 바뀌지 않는다.
- 세션은 만들 때의 profile fingerprint를 저장하고, claim은 카탈로그의 같은 id가 그 fingerprint로 해시될 때만 세션을 묶는다. 설정을 바꾸려면 **새 profile id**를 등록하고 새 세션을 그 id로 만든다. 기존 id를 고치면 그 id로 만든 세션은 모두 위의 `CATALOG_MISMATCH`가 되고, 되돌리면 다시 돈다. 자격 증명 값은 claim 때 카탈로그에서 읽으므로 같은 참조 뒤의 값 회전(그리고 API 재기동)은 기존 세션을 막지 않는다. 이 컬럼 전에 만든 세션은 fingerprint가 비어 있고 다음 claim이 그때의 fingerprint로 고정한다.
- fingerprint는 두 판이 있다. 지금 만드는 세션과 release는 **v2**를 적는다. v2는 `model`·`models`·`repository`를 빼고 해시하므로, 모델은 `sessions.model`(attempt·checkpoint 행에도 같은 값)이 정하고 저장소 모드는 세션의 `repository_mode`가 정한다. 0159 전에 만든 세션·checkpoint·release는 **v1**(고른 모델을 넣은 해시)을 그대로 갖고, claim·상세·restore·release 활성화는 v1 값도 그 모델의 v1과 같으면 받아들인다. 값을 다시 쓰지 않는다. API는 기동할 때 `model`이 빈 세션에 v1 지문이 가리키는 모델을 적고(`Session models backfilled` 로그), 찾지 못한 행은 null로 둔다. 저장소 binding(`repositoryBinding`)은 별도 버전이라 이 변경으로 값이 바뀌지 않으므로, 대기 중인 push·PR은 그대로 진행된다.
- 배포 순서: migration 0159(컬럼 추가만)를 먼저 적용하고 API를 올린다. worker 이미지는 바꿀 필요가 없다.
  - **옛 API와 섞어 돌리지 않는다.** 옛 API는 v2를 모른다. 새 API가 만든 세션을 claim하면 `CATALOG_MISMATCH`로 실패시키고, v2 provider token을 거절하고, v2 release의 활성화를 `PROFILE_DIGEST_MISMATCH`로 막는다. replica가 여럿이면 옛 replica를 모두 내린 뒤 새 replica를 올린다(helm: `kubectl scale deployment <api> --replicas=0` 뒤 `helm upgrade`). 그동안 API는 잠깐 멈춘다.
  - 업그레이드 전 세션은 v1 지문을 그대로 쓰고, 새 API가 그 세션에 주는 provider token도 v1이다. 그래서 옛 API에서도, 새 API에서도 claim되고 모델 호출이 통과한다.
  - **되돌리지 않는다.** 새 API가 v2로 만든 세션·release는 옛 API에서 위와 같이 실패한다. 문제가 생기면 앞으로 고쳐 다시 올린다.

### 설치 상한 차단

owner는 상한 하나를 실행 중에도 멈출 수 있다. 은퇴(`POST /v1/installation-profiles/{profile_id}/retire`)는 새 부착만 막고, 차단은 그 상한으로 도는 모든 것을 막는다.

- **API.** `POST /v1/installation-profiles/{profile_id}/block`과 `POST /v1/installation-profiles/{profile_id}/unblock`. 로그인한 owner만, cookie 세션으로만 한다. admin·member와 API key는 `403`이다. 저장할 때 역할을 다시 확인한다. 응답은 `{ profile, receipt_id }`이고 receipt는 `block_installation_profile`·`unblock_installation_profile`이다. 이미 그 상태면 아무것도 바뀌지 않고 `receipt_id`가 null이다. 없는 id는 `404`다.
- **차단하면.** 상한의 상태가 `blocked`가 되고(다른 어떤 상태보다 먼저 정한다), 그 위의 워크스페이스 판은 `base_blocked`가 된다. 차단은 DB 상태라 모든 replica가 같은 결과를 본다(프로필 snapshot을 다시 읽는 최대 1초 뒤).
  - 새 release, release가 있든 없든 새 세션, 그 상한을 바탕으로 한 새 판은 거절된다.
  - 다음 턴을 기다리는 세션은 다음 claim에서 `catalog_mismatch`로 실패하고 입력은 남는다.
  - 지금 도는 턴은 egress proxy의 다음 재허가에서 provider·저장소 요청이 끊긴다. 연결을 뺄 때와 같은 경로다.
- **해제하면** 상한이 원래 상태(`usable`·`retired` 등)로 돌아온다. 이미 실패한 세션과 턴은 저절로 다시 돌지 않는다. 필요한 입력을 다시 보내면 새 generation으로 뜬다.

### 저장소 모드 (`repository`)

profile의 `repository`는 그 profile로 만든 세션이 저장소를 갖는지 정한다. `GET /v1/profiles`는 이 값을 `repository_mode`로 보여 준다.

| 값 | `POST /v1/sessions`의 `repository_id` | 세션 |
|---|---|---|
| `required`(생략하면 이 값) | 꼭 보낸다. 빼면 `422 UNSUPPORTED_CAPABILITY`(`Profile <id> needs a repository: send repository_id`). 단 GitHub 설정 행이 있는 에이전트의 세션과 워크스페이스 상한이 정하는 profile은 저장소 없이 시작한다 | 시작 저장소가 있으면 카탈로그 저장소를 clone한 작업 디렉터리에서, 없으면 빈 작업 디렉터리에서 시작한다 |
| `none` | 보내지 않는다. 보내면 `422 UNSUPPORTED_CAPABILITY`(`Profile <id> runs without a repository: omit repository_id`) | 빈 작업 디렉터리에서 시작한다. 세션 상세의 `repository_id`는 `null`이고 push 요청은 `409 PUSH_SOURCE_MISSING`이다 |
| `optional` | 보내도 되고 빼도 된다 | 보내면 `required`처럼, 빼면 `none`처럼 돈다 |

- `repository_id`를 보냈으면 `optional`이어도 위의 쌍 allowlist를 지나야 한다. 없는 쌍은 `422`다. 단 GitHub 설정 행이 있는 에이전트의 세션과 워크스페이스 상한이 정하는 profile은 쌍 대신 상한이 판정한다.
- 빈 DB를 시드할 때 `none` profile이 `repositories.<id>.profiles`에 있거나 `project_settings.claude_md: true`를 가지면 API가 기동하지 않는다. 콘솔과 `POST /v1/installation-profiles`도 `none` 상한에 저장소나 `claude_md`를 주는 저장을 거절한다. 저장소가 없으니 읽을 CLAUDE.md도 없다. `optional` profile의 `claude_md`는 저장소 없이 만든 세션에서는 읽지 않는다.
- 모든 profile이 `required`일 때만 `repositories`에 저장소가 하나 이상 있어야 한다.
- 저장소 없이 만든 세션의 profile을 `required` profile로 바꾸는 요청(`POST /v1/sessions/{id}/profile`)은 `422 UNSUPPORTED_CAPABILITY`다. 단 워크스페이스 상한이 정하는 profile은 저장소 없이도 `required` profile로 바꿀 수 있다. release에 묶인 세션은 저장소와 무관하게 profile을 바꾸는 요청이 `409 RELEASE_PROFILE_MISMATCH`다.

### 워크스페이스 프로필 (콘솔에서 좁힌 profile)

워크스페이스 owner·admin은 콘솔(프로필 화면) 또는 `POST /v1/workspace-profiles`로 운영자 profile 하나를 골라 좁힌 판을 만든다. 규칙은 아래와 같다.

1. **두 층.** provider·endpoint·자격 증명·billing·runtime·저장소 신뢰 쌍은 설치 상한과 그 연결에만 있다. 워크스페이스 판은 그 위에서 `models`·`tools`를 부분 집합으로 고르고 `permission_mode`를 더 조심스럽게만 바꾼다. 기준보다 넓히는 요청(기준에 없는 모델·도구, 승인 없이 도는 쪽으로 바꾸는 모드)은 `400 BAD_REQUEST`이고 `details.field`가 그 칸을 적는다.
   - 기준 모드별로 고를 수 있는 모드: `bypassPermissions` → `bypassPermissions`·`auto`·`acceptEdits`·`default`·`plan`, `auto` → `auto`·`acceptEdits`·`default`·`plan`, `acceptEdits` → `acceptEdits`·`default`·`plan`, `default` → `default`·`plan`, `dontAsk` → `dontAsk`·`plan`, `plan` → `plan`.
2. **이름 공간.** 워크스페이스 판의 id는 `ws_<워크스페이스 slug>_<이름>_v<n>`이다(slug가 `[a-z0-9-]` 밖이면 slug 대신 워크스페이스 id). 상한 id는 `ws_`로 시작할 수 없으므로(시드에 있으면 가져오기가 거절하고, DB CHECK도 막는다) 두 출처가 한 id를 두고 다투지 않는다. `GET /v1/profiles`는 운영자 profile(`source: operator`)과 호출자 워크스페이스의 판(`source: workspace`)을 함께, 출처와 함께 보여 준다.
3. **판은 바뀌지 않는다.** 저장할 때마다 같은 이름의 다음 판(`v<n+1>`)이 새 id로 생긴다. 이미 만든 release·세션은 옛 판 id를 그대로 쓰며, 새 판으로 옮기려면 release를 새 판으로 다시 만든다. 같은 이름을 동시에 두 번 저장하면 뒤의 것은 `409 REVISION_CONFLICT`이고 다시 저장하면 그다음 판이 된다.
4. **기준이 바뀌면 멈춘다.** 판은 저장할 때 기준 profile의 지문을 적어 둔다. 운영자가 기준의 설정(tools·permission_mode·endpoint·runtime 등)을 바꾸거나 판이 고른 모델을 기준 `models`에서 빼면 그 판은 `base_changed`가 된다. 새 release·세션은 `422 UNSUPPORTED_CAPABILITY`로 거절되고, 이미 그 판으로 만든 세션은 운영자 profile을 고쳤을 때와 같이 `CATALOG_MISMATCH`로 끝난다. 운영자가 기준을 되돌리면 다시 돈다. 콘솔의 "다시 만들기"는 바뀐 기준 위에 다음 판을 만든다.
5. **기준이 사라지면** `base_missing`이다. 목록에는 판을 만들 때의 runtime·billing·저장소 모드로 남지만 아무것도 돌리지 않는다.
6. **은퇴는 새 부착만 막는다.** `POST /v1/workspace-profiles/{profile_id}/retire`(receipt `retire_workspace_profile`)로 은퇴한 판은 새 release와 release 없는 새 세션을 받지 않는다. 이미 그 판으로 만든 release의 새 세션과 진행 중인 세션은 계속 돈다. 이미 은퇴한 판을 다시 은퇴하면 아무것도 바뀌지 않고 `receipt_id`가 null이다.
7. **저장소 신뢰 쌍은 기준에서 물려받는다.** 기준 상한의 `repository_ids`에 있는 저장소에서 판도 돈다. 판에는 저장소 allowlist가 따로 없다.
8. **DB가 정본이다.** 판은 `workspace_profiles`(migration 0174)에 있다. replica는 세션 생성·release 생성·profile 변경 때 DB를 다시 읽고, worker claim과 provider egress 재허가 때는 1초 안에 읽은 것을 쓴다. 그 밖의 화면(세션 상세의 runtime 등)은 10초마다 다시 읽는다.
9. **누가.** 만들기·은퇴는 로그인한 owner·admin(`workspace.manage`)만, cookie 세션으로만 한다(workspace key로는 안 된다). 저장 시점에 역할을 다시 확인하므로 그사이 역할을 잃으면 `403`이다. 읽기(`GET /v1/profiles`)는 구성원과 read scope key 모두 한다. 다른 워크스페이스의 판은 목록에 나오지 않고, 그 id로 세션·release를 만들면 모르는 profile처럼 거절된다.
10. **auto 규칙·스크립트 상한은 아직 칸만 있다.** 콘솔에 자리와 안내만 있고 저장하지 않는다(확장 설계 v2 결론 뒤).

배포: migration 0174(테이블 추가만)을 먼저 적용하고 API를 올린다. worker 이미지는 바꿀 필요가 없다. 옛 API는 `ws_` id를 모른다. 그래서 옛 replica가 판 세션의 claim을 받으면 그 세션을 `catalog_mismatch`로 실패시킨다. 모든 replica가 새 판으로 바뀐 뒤에 판을 만들게 한다. 되돌릴 때도 같다: 판으로 만든 세션은 옛 API에서 첫 claim에 실패하고 입력은 남는다. 다시 올린 뒤 새 입력을 보내면 이어서 돈다.

### workspace volume을 잃었을 때 남는 것

worker의 작업 디렉터리는 세션의 workspace volume(Kubernetes backend에서는 PVC)에 있지만, 세션을 이어 가는 데 필요한 정본은 volume이 아니다. worker는 turn이 끝날 때마다 작업 디렉터리와 엔진 대화를 checkpoint로 object store(S3)에 올리고, DB의 checkpoint pointer가 그 revision을 가리킨다([checkpoint object store](#checkpoint-object-store)). volume이 없어진 세션을 resume하면 scheduler가 빈 volume을 새로 만들어 worker를 띄우고(Docker backend는 새 이름으로, Kubernetes backend는 같은 이름의 PVC를 다시 만든다), worker가 pointer의 checkpoint를 복원해 대화를 이어 간다. 저장소 모드와 상관없이 같은 경로다.

**보장 범위:** 마지막으로 commit된 checkpoint까지는 S3 + DB에 있다. 그 뒤의 작업, 추적되지 않은 ignored·exclude 파일, 작업 디렉터리 밖 상태는 volume을 잃으면 없다.

- 마지막 checkpoint가 어느 turn까지인지는 세션 상세의 `checkpoint_revision`과 `durability.last_checkpointed_turn_id`로 본다. `durability.last_checkpointed_turn_id`가 `durability.last_completed_turn_id`와 같으면 마지막으로 완료된 turn까지 checkpoint에 들었다. `durability.checkpoint_pending_reason`은 앞서 checkpoint가 거절된 사유이고, 뒤의 checkpoint가 그 turn을 덮은 뒤에도 남을 수 있으므로 이것만으로 마지막 turn이 빠졌다고 보지 않는다.
- 추적되지 않은 파일 중 `.gitignore`·`.git/info/exclude`에 걸린 것은 checkpoint에 들어가지 않는다. 빌드 결과, 의존성, ignore된 `.env`도 마찬가지다. 이미 추적되는 파일은 ignore 규칙에 걸려도 checkpoint에 든다. 남겨야 하는 성과물은 ignore되지 않은 경로(예: `out/`)에 쓴다.
- 작업 디렉터리 밖(tmpfs HOME의 `git config --global` 등)은 volume과 상관없이 worker가 바뀌면 사라진다.
- `tests/e2e/workspace-loss.e2e.ts`가 CI `e2e` job에서 Docker backend로 이 경로를 확인한다(Kubernetes backend는 이 e2e가 다루지 않는다). 저장소 없는 세션과 있는 세션 각각에서 파일을 쓰고 pause한 뒤 workspace volume을 지우고 resume한다. 그다음 turn이 파일 내용과 이전 대화를 읽는지, volume 이름이 바뀌었는지 본다.

### 원격 MCP 서버

설치 owner가 콘솔이나 설정 문서(`mcp_servers`)로 MCP 서버를 더하면 에이전트가 원격 MCP 서버 하나를 쓸 수 있다. 하나도 없으면 어떤 에이전트도 MCP 서버를 이름으로 가리키지 못한다. 서버는 streamable HTTP 하나뿐이고, 자격 증명은 에이전트의 서비스 계정 하나다(요청자 자격·OAuth는 없다). 이 문서의 항목 예시는 주석을 달려고 YAML로 적었다. 설정 문서에는 같은 모양을 JSON으로 넣는다.

```yaml
mcp_servers:
  notion:                       # id: 소문자·숫자·`-`·`_`(연속 `__` 불가), 32자까지
    url: https://mcp.example.com/mcp   # query 불가
    credential_ref: mcp/notion  # card의 credential_refs에도 있어야 한다
    auth:
      kind: bearer
      secret_id: prod/mcp/notion       # 또는 value_env
    workspaces: [acme]          # 이 서버를 쓸 수 있는 workspace slug
```

- 에이전트 card는 `capabilities.mcp: [{server: notion}]`로 서버를 고르고, 쓸 도구를 `tool_policy.per_tool`에 `mcp__notion__<도구>: allow`로 적는다. release는 `allow`인 도구만 고정한다(`effective_tools.mcp`). `allow` 도구가 없거나, 카탈로그에 없는 서버거나, card가 `credential_ref`를 적지 않았으면 release를 만들 때 거절한다. 실행에는 이 이름이 연결돼 있어야 한다(아래 자격 연결 절).
- worker는 서버 URL도 자격 증명도 받지 않는다. claim은 `runtime_config.mcp_servers[0]`에 이름·카탈로그 endpoint·binding(release·서버·URL·`credential_ref`의 해시)·`wem_` egress token을 주고, worker 프로세스 안의 relay가 engine 대신 proxy의 `/mcp/<name>` route로 부른다. 그래서 token은 engine의 argv·env에 없다. checkpoint fingerprint에는 binding만 들어간다.
- proxy는 POST 본문을 다 읽고 JSON-RPC 메시지 하나(배치 불가)의 `method`와 `tools/call`의 도구 이름을 authorizer에 넘긴다. authorizer는 요청마다 다시 판정한다: token의 attempt가 세션을 쥐고 있는지, 서버가 release의 서버인지, 카탈로그의 그 서버가 claim 때와 같은지, `credential_ref`가 지금 연결돼 있는지, 세션의 workspace가 `workspaces`에 있는지, method가 `initialize`·`ping`·`tools/list`·`tools/call`·`notifications/*` 중 하나인지, 도구가 release에 `allow`로 고정됐는지. 도구·method 거절은 `403 FORBIDDEN`이고 receipt가 없다. 자격 거절(해제, workspace, 카탈로그 변경)은 `403 CREDENTIAL_UNBOUND`와 `call_mcp` receipt(`status: failed`, 이미 열린 교환을 끊은 것이면 `unknown`)를 남기고, worker에는 `egress denied: credential_unbound (receipt <id>)`로 알린다. 같은 attempt·turn의 같은 거절은 receipt 하나다.
- upstream의 401은 worker에 403으로 가고 `WWW-Authenticate`는 떼어 낸다. 서비스 계정 자격은 운영자가 고칠 일이고, worker 쪽 MCP client가 로그인을 시도하면 안 된다.

**배포 순서:** worker 이미지를 먼저, control plane(API·egress proxy)을 나중에 올린다. 옛 worker는 `runtime_config.mcp_servers`를 모르는 schema로 claim을 거절하므로, MCP 서버를 쓰는 release가 생기기 전에 새 worker가 깔려 있어야 한다.

### GitHub 저장소

github.com과 GitHub Enterprise Server(GHES)의 저장소도 다른 host와 같은 저장소 route로 clone한다. 인증은 GitHub App만 쓴다. 그 자격 증명은 worker에 가지 않는다.

#### GitHub App

API가 App의 private key로 JWT를 서명해 설치 토큰을 받고, 그 토큰을 proxy의 저장소 route에 내준다. 토큰은 1시간짜리라 API가 갱신한다. App은 콘솔에서 등록한다. 한 워크스페이스에 작성용·리뷰 승인용 App을 여럿 둘 수 있고, 저장소마다 어느 App이 토큰을 발급할지 고정한다([github-agent.md 결정 11](../contributing/decisions/github-agent.md#결정-11-같은-역할에-app-여럿)).

- **App 만들기:** 조직(또는 계정) Settings → Developer settings → GitHub Apps → New GitHub App. Webhook은 끈다(플랫폼은 webhook을 받지 않는다). Repository permissions는 **Contents: Read and write**, **Pull requests: Read and write**, **Metadata: Read-only**(자동)다. clone은 Contents read만 쓰지만, push·PR(아래 절)이 같은 App을 쓰므로 처음부터 준다. 토큰을 발급할 때마다 그 요청이 쓰는 권한만 다시 좁히므로(아래) clone 토큰에는 쓰기 권한이 없다. 만든 뒤 페이지 위쪽의 **App ID**를 적어 두고, Private keys → Generate a private key로 PEM 파일을 받는다.
- **콘솔에 등록:** owner나 admin이 설정 > 워크스페이스 > 연동 > GitHub에서 App ID를 넣고 PEM 파일을 고른다. API는 키가 RSA private key인지 보고(`400 invalid_private_key`), 그 키로 서명한 JWT로 `GET {api_base}/app`을 불러 GitHub가 받아 주는지 확인한 뒤에만 저장한다(`400 github_app_rejected`, GitHub가 답하지 않으면 `503 github_unreachable`). 키는 `PLATFORM_SECRET_KEY`(master key)로 암호화해 `secret_values`에 두고, App 이름·주소와 함께 `github_apps` 표에 남는다. 등록·교체·삭제는 `set_github_app`·`delete_github_app` receipt로 남고, 키는 응답·receipt·로그 어디에도 나오지 않는다. 내려받은 PEM 파일은 등록한 뒤 지운다. 같은 App의 키를 바꾸려면 GitHub에서 새 키를 만들고, 그 App 행의 ⋯ 메뉴 "새 키 등록"으로 같은 연결에 저장한 뒤, 새 키로 동작하는 것을 확인하고 GitHub에서 옛 키를 지운다. API는 10초마다 DB를 다시 읽으므로 다른 replica도 곧 새 키를 쓴다(등록한 replica는 바로).
- **설치:** 화면의 **조직 추가**(App이 여럿이면 설치할 App을 고른다)로 GitHub의 설치 화면에 가서 저장소 owner를 고르고 **Only select repositories**로 쓸 저장소만 고른다. 콘솔에서 시작해 콘솔로 돌아온 설치는 연결한 사람을 남긴다. 화면은 App의 JWT로 GitHub에 물어 설치 표(계정 · 유형 · 저장소 · App · 연결한 사람 · 상태)를 보여 준다. installation id는 적지 않는다. API가 토큰을 받을 때 `GET /repos/{owner}/{repo}/installation`으로 찾는다.
- **저장소:** 콘솔의 App을 쓰는 저장소는 등록하지 않는다. 에이전트 관리자가 에이전트의 GitHub 탭에서 App 설치에 들어 있는 저장소를 고르면 카탈로그 행이 생긴다. URL과 기본 브랜치는 GitHub에서 읽는다. owner나 admin은 설정 > 워크스페이스 > 연동 > GitHub > **저장소 관리**에서 설치별 저장소를 보고, 행 메뉴로 기본 브랜치와 그 저장소를 맡을 App을 바꾼다. 바꾼 것은 `set_repository_branch`·`set_repository_github_app` receipt로 남는다. 저장소는 DB 표 `catalog_repositories`에 있고, 재배포나 재기동은 필요 없다(다른 replica는 10초 안에 읽는다). 결정 문서: [repository-catalog-db.md](../contributing/decisions/repository-catalog-db.md).
- **설정 문서:** `settings import`로도 같은 행을 더한다(`import_repository` receipt). 항목은 이렇게 적는다. 바깥 참조가 있는 저장소(아래 키를 직접 적는 방식, basic·bearer)는 CLI로 가져오고, 콘솔에는 운영자 참조로 보여 값을 바꿀 수 없다.

  ```json
  {
    "repositories": {
      "app": {
        "url": "https://github.com/<owner>/<repo>.git",
        "branch": "main",
        "profiles": ["claude-coding-real"],
        "auth": { "kind": "github_app" }
      }
    }
  }
  ```

  App이 등록되지 않았거나 그 저장소에 설치되지 않았으면 clone·push·PR이 `503`(아래 **실패**)으로 닫힌다. 콘솔 App은 지금 github.com(`https://api.github.com`)만 쓴다. 그래서 짧은 형식은 `url`이 `https://github.com/`으로 시작할 때만 받고, 다른 host나 `http`면 카탈로그를 읽지 못한다(토큰이 발급받은 곳이 아닌 서버로 가지 않게). GHES는 아래 키를 직접 적는 방식으로 둔다. 콘솔에서 App을 바꿔도 저장소의 binding은 그대로라 세션은 다음 토큰부터 새 App을 쓴다.
- **키를 직접 적는 방식(이전 방식, 계속 쓸 수 있다):** `app_id`·`installation_id`와 키 참조를 설정 문서에 적어 CLI로 가져오면 콘솔 App 대신 그 값을 쓴다. 값은 API가 환경 변수나 Secrets Manager에서 읽고 DB로 옮기지 않는다. 콘솔로 옮기려면 같은 App을 콘솔에 등록하고, 옛 행을 사용 중지한 뒤 콘솔에서 같은 저장소를 추가한다. 이때 binding이 한 번 바뀌므로 그 저장소의 기존 세션은 `CATALOG_MISMATCH`가 된다. 키 참조는 둘 중 하나로 둔다.
  - Secrets Manager: PEM 본문을 secret 값으로 넣고 카탈로그에 `secret_id`를 적는다(`aws secretsmanager create-secret --name <id> --secret-string file://<pem 파일>`).
  - 환경 변수: PEM 파일을 `chmod 600`으로 두고 API를 띄우는 셸에서 `export GITHUB_APP_KEY="$(cat <pem 파일>)"`로 넘긴다. 한 줄로 넣어야 하는 곳에서는 줄바꿈을 `\n`으로 적어도 된다. compose의 `api`에는 overlay로 `environment: { GITHUB_APP_KEY: ${GITHUB_APP_KEY:?} }`를 더한다.
  - 내려받은 PEM 파일은 위 둘 중 하나에 넣은 뒤 지운다. 키를 바꾸면 같은 참조 뒤의 값만 바꾸고 API를 재기동한다(binding·revision은 그대로다).
- **키를 직접 적는 카탈로그:**

  ```yaml
  repositories:
    app:
      url: https://github.com/<owner>/<repo>.git     # GHES: https://<ghes-host>/<owner>/<repo>.git
      branch: main
      profiles: [claude-coding-real]
      auth:
        kind: github_app
        app_id: 123456
        installation_id: 7890123
        secret_id: werft/github-app-key     # 또는 value_env: GITHUB_APP_KEY
        api_base: https://api.github.com             # 생략하면 이 값. GHES: https://<ghes-host>/api/v3
  ```

  URL은 `/<owner>/<repo>` 모양이어야 한다(토큰을 그 저장소 이름으로 좁히기 때문이다). `api_base`는 https만 받는다. 사설 이름·주소의 host(로컬 fake)만 http를 허용한다. API는 기동할 때 키를 RSA private key로 읽어 보고, 읽히지 않으면 `repositories.<id>.auth.<참조>: … is not an RSA private key PEM`으로 기동을 거부한다(값은 출력하지 않는다). `app_id`·`installation_id`·`api_base`·참조 위치를 바꾸면 그 저장소의 binding이 바뀌어 이미 만든 세션은 `CATALOG_MISMATCH`가 된다.
- **토큰:** 저장소 route가 요청마다 API에 물으면 API는 `POST {api_base}/app/installations/{installation_id}/access_tokens`에 `repositories: [<repo>]`, `permissions: { contents: read }`를 보내 그 저장소 하나·읽기 권한으로 좁힌 토큰을 받는다. 콘솔 App이면 그 앞에 `GET {api_base}/repos/{owner}/{repo}/installation`으로 installation id를 찾아 프로세스 메모리에 두고, 발급이 실패하면 다음에 다시 찾는다. 토큰은 저장소·권한별로 API 프로세스 메모리에 두고 `expires_at` 10분 전부터 새로 받는다. 같은 토큰을 동시에 묻는 요청은 발급 한 번을 같이 기다린다. 진행 중인 clone은 시작할 때의 토큰으로 끝까지 받는다. JWT는 `@octokit/auth-app`이 만든다(iat는 30초 앞당기고 수명은 10분).
- **실패:** 발급이 실패하면(키·installation이 틀림, GitHub 장애, App 설치 해제) 저장소 route는 `503`으로 닫힌다. 남은 토큰이 아직 유효해도 갱신 시점이 지났으면 쓰지 않는다. clone은 시작 단계에서 실패해 세션 attention이 `STARTUP_FAILED`다. API 로그에는 `GitHub request failed`(`request: installation token request`, `status`, `error`)와 egress authorizer의 `Egress authorization refused`(`status: 503`, `code: BACKEND_UNAVAILABLE`)가 남는다. 토큰·JWT·키는 로그와 오류 메시지에 나오지 않는다. status가 401이면 App ID·키 짝, 404면 installation id와 그 설치에 저장소가 들어 있는지, 422면 저장소 이름을 확인한다. 콘솔 App이 그 저장소에 설치되어 있지 않으면 `GitHub App is not installed on <owner>/<repo>`로 같은 `503`이 되고, 콘솔 App이 없으면 forge가 없어 `503`이다. 콘솔의 GitHub 화면이 두 경우를 모두 보여 준다.
- **allowlist:** 토큰 발급은 API가 직접 한다(`api.github.com:443` 또는 GHES의 `<ghes-host>:443`로 API 컨테이너의 outbound가 열려 있어야 한다). clone은 proxy의 `EGRESS_CREDENTIAL_ALLOWLIST`에 `github.com:443`(GHES는 `<ghes-host>:443`)을 더한다.

#### 저장소 route와 egress

- **allowlist:** `github.com:443`(GHES는 `<ghes-host>:443`)을 egress proxy의 `EGRESS_CREDENTIAL_ALLOWLIST`에 더한다. compose 기본값은 `api.anthropic.com:443`이므로 `EGRESS_CREDENTIAL_ALLOWLIST=api.anthropic.com:443,github.com:443`처럼 기존 값을 함께 적는다. 사설 주소의 GHES는 `EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST`에 둔다. forward 목록(`EGRESS_ALLOWLIST`)에는 넣지 않는다. 넣으면 proxy가 기동을 거부하고, 넣지 않았으므로 worker의 도구(Bash의 `git`·`curl`, npm의 git 의존성)는 GitHub에 직접 닿지 못한다. 2026-10-13 로컬 스택 실측에서 worker 안의 `git ls-remote https://github.com/octocat/Hello-World.git`은 `CONNECT tunnel failed, response 403`으로 끝났고, proxy에는 `Egress denied`(`destination is not allowlisted`)가 남았다.
- **redirect:** route는 3xx를 따라가지도 전달하지도 않고 502 `upstream redirected`로 끝낸다. clone은 `git clone failed (exit 128): remote: upstream redirected`로 실패하고 세션 attention은 `STARTUP_FAILED`다. GitHub가 git 요청에 301을 주는 경우로 확인한 것은 `http://` URL(→ `https://`)이다. 이름을 바꾼 저장소(`vuejs/vue-next` → `vuejs/core`)와 `.git`을 뺀 URL은 2026-10-13 실측에서 redirect 없이 200이었다. proxy 로그에 `Credential route`가 `status: 301`로 남으면 카탈로그 URL을 응답이 가리키는 주소로 고친다.
- **401:** 로그인 없이 읽을 수 없는 저장소(없는 저장소, 설치 토큰이 닿지 않는 비공개 저장소)에 GitHub는 401을 준다. proxy 로그는 `Credential route`의 `status: 401`이고, clone은 `fatal: could not read Username for 'http://egress-proxy:3129': terminal prompts disabled`로 실패한다(attention `STARTUP_FAILED`, 2026-10-13 실측). App 설치의 권한이 모자란 경우의 응답은 아직 재지 않았다. 아래 절차에서 status를 확인한다.
- **확인:** clone이 되면 proxy 로그에 세션 id와 함께 `"message":"Credential route"`, `"purpose":"repository"`, `"host":"github.com"`, `"status":200` 줄이 남는다(실측에서 clone 한 번에 세 줄). worker의 작업 트리에서 `git remote get-url origin`은 카탈로그 URL이고 로그인을 담지 않는다.
- **LFS·submodule·Go 모듈:** 엔진의 git은 세션이 시작 때 받은 저장소(있으면)와 부착 저장소 URL을 저장소 route로 돌린다(`insteadOf`, 엔진 HOME의 `.config/git/config`). 그래서 그 저장소들을 가리키는 submodule, git URL 의존성, 사설 Go 모듈(`GOPRIVATE`, github.com 저장소만)은 route로 받는다. 세션에 붙지 않은 저장소는 받지 않는다. `GOPRIVATE`에는 route가 있는 저장소의 모듈 경로(`github.com/<owner>/<repo>`, 하위 경로 포함)만 들어가고, route를 쓰지 못한 claim에서는 비운다. 그래서 세션에 붙지 않은 사설 저장소의 모듈은 공개 프록시로 가서 `proxy.golang.org`가 찾지 못하고 실패한다. 이때 그 모듈 경로가 `proxy.golang.org` 요청에 드러나고(받기가 실패하므로 checksum 조회까지는 가지 않는다), 저장소 허용 집합을 확인하는 게이트를 거치지 않으므로 거절 receipt도 남지 않는다. 세션이 그런 저장소를 route로 직접 요청하면 게이트가 `repository_not_allowed` receipt를 남기고 `403`으로 거절한다. Git LFS 객체는 route가 batch를 대신 부르고 저장 위치에서 받아 준다. GitHub는 객체를 `github-cloud.githubusercontent.com`에 두므로(2026-11-02 실측) 이 호스트를 `EGRESS_PACKAGES_REDIRECT_ALLOWLIST`에 `github-cloud.githubusercontent.com:443`으로 더한다. 더하지 않으면 객체 GET이 `502`다. worker 이미지에는 `git-lfs`가 있고(시스템 범위 filter, smudge 끔) Go 툴체인은 없다(파생 이미지는 [이미지와 공급망](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/images-and-supply-chain/)의 "worker 안의 패키지 도구"). `git-lfs`는 worker Dockerfile의 build stage가 upstream 소스 릴리스에서 직접 빌드한다. upstream 릴리스 바이너리가 링크한 `golang.org/x/net`·`github.com/klauspost/compress`에 취약점이 있어 그 모듈들을 올려 빌드하고, 소스·Go 툴체인·go.mod·go.sum을 모두 sha256으로 고정한다. 이 버전들은 매일의 Debian 보안 갱신으로 따라 올라가지 않으므로 worker Dockerfile의 `GIT_LFS_*` 값과 checksum을 손으로 올린다. 패치된 x/net과 compress(1.20.2 이상)를 쓰는 upstream 릴리스가 나오면 그 버전으로 올리고 모듈 변경을 뺄 수 있다. checkout은 pointer 파일을 남기므로 객체는 엔진이 `git lfs pull`로 받는다. 객체 호스트를 목록에 넣지 않은 배포에서 checkout이 실패하지 않게 하려는 것이다.

github.com의 비공개 저장소로 확인하는 절차다. `scripts/local.sh up --fake-model`로 띄운 스택에 저장소 예시 overlay를 겹친다.

1. 콘솔에서 GitHub App을 등록하고 대상 저장소에 설치한다(위 App 절).
2. `.claude/skills/verify-werft/github-sandbox/overlay.yml`을 `COMPOSE_FILE="compose.yaml:<그 파일>"`로 겹친다. 이 overlay는 `github.com:443`을 `EGRESS_CREDENTIAL_ALLOWLIST`에 더하고, 같은 폴더의 `settings.json`을 migrate에 준다. 다른 저장소를 쓰려면 그 파일을 복사해 `repositories`의 URL을 바꾼다. 저장소의 `profiles` 배열은 빈 표를 시드할 때만 읽으므로 새 스택(볼륨 없음)으로 띄운다.
3. `scripts/local.sh up --fake-model`.
4. API 기동 로그 `Session catalog loaded`의 `repositories` 수를 보고, quickstart 2·3장처럼 `repository_id`를 그 저장소로 바꿔 세션을 만든다.
5. 세션이 `needs_input`이나 `completed`에 닿으면 `docker compose logs egress-proxy | grep '"purpose":"repository"'`에서 `status: 200`을 확인한다. `STARTUP_FAILED`면 위의 401·redirect 항목을 본다.
6. `scripts/local.sh down`(같은 환경 변수로)으로 내린다.

### 세션 결과의 push 승인

세션의 결과는 worker가 아니라 플랫폼(API)이 push하고, 사람이 승인한 뒤에만 한다. 이 절은 요청과 승인이고, 승인된 요청의 push는 다음 절이다. API 사용법은 [api-guide 10절](https://jeongjaesoon.github.io/werft/ko/reference/api-guide/#10-세션-결과의-push-요청과-승인거부)에 있다.

- **고정하는 것:** 요청(`POST /v1/sessions/{id}/push-requests`, `sessions:write`)은 그때 세션의 checkpoint pointer가 가리키는 revision과, 검증된 manifest가 적은 `git_commit`을 고정한다. 저장소는 세션의 `repository_id`, 브랜치는 `agent/<session-id>`다. 요청자는 이 중 아무것도 고를 수 없다. 브랜치 규칙은 DB CHECK(`push_requests_target_branch_check`)도 지킨다. manifest가 검증되지 않으면 더 오래된 checkpoint로 대신하지 않고 거절한다.
- **승인·거부하는 사람:** 승인(`POST .../push-requests/{push_request_id}/approve`)과 거부(`.../reject`)에는 `sessions:approve`가 필요하다. 이 scope는 API의 scope 표가 아니라 push 서비스가 검사한다. 그래야 거절도 receipt로 남는다. 승인·거부할 수 있는 principal은 API key와 로그인한 사용자뿐이다. 다른 종류(chat installation 등)는 목록에 넣기 전까지 거절된다. API key는 사람과 묶여 있지 않으므로 `sessions:approve` key는 사람만 갖게 발급한다. 자동화(CI 등)에는 주지 않는다.
- **에이전트가 스스로 승인하지 못하는 이유:** worker가 가진 자격(launch nonce, session token)은 `/internal/worker` route에서만 통하고 `/v1`에서는 401이다. `AUTH_MODE=none`은 누구든 `X-Owner-Id`로 owner를 자칭할 수 있으므로, 이 모드에서는 push 요청 route가 모두 403(`refusal: unverified_principal`)이고 아무것도 기록하지 않는다.
- **승인하는 commit:** 승인 body의 `git_commit`이 고정된 commit과 같아야 승인된다. 요청 뒤에 세션이 다시 checkpoint를 남겼으면(pointer revision이 다르면) 승인을 거절하고 요청은 `requested`에 남는다. 그 요청은 거부하고 새로 요청한다. 거부에는 이 검사가 없다.
- **상태:** `requested` → `approved` | `rejected`(사람), `approved` → `pushing` → `pushed` | `failed`(플랫폼, 다음 절). 세션마다 열린 요청(`requested`·`approved`·`pushing`)은 하나다.
- **보존:** checkpoint GC는 열린 요청이 고정한 revision과 그 아래 fallback window를 지우지 않는다. 세션이 계속 checkpoint를 남겨 그 revision이 pointer의 window를 벗어나도, push할 manifest와 workspace bundle은 남는다.
- **감사:** 요청·결정·거절된 시도마다 receipt가 남는다. operation은 `request_push`·`resolve_push`이고 push 결과는 `push`다. `actor`는 누가 했는지, `result`는 `{push_request_id, action, verdict, refusal, repository_id, checkpoint_revision, git_commit, target_branch}`다. 이름을 바꾸기 전에 남은 receipt는 operation `decide_push`, 값 `result.decision`, refusal `already_decided`, 오류 `PUSH_REQUEST_DECIDED`이고 그대로 읽힌다. 거절이면 status가 `failed`이고 `error`에 코드가 있다. 비밀 값은 담지 않는다. 인증되지 않은 시도(401)와 `AUTH_MODE=none`의 시도는 receipt 없이 요청 로그에만 남는다.

### push 규칙: 모든 저장소에 하나

세션의 저장소가 무엇이든 push가 필요로 하는 승인은 규칙 하나로 정해진다. 에이전트의 `push_approval`(꺼져 있으면 `allow`, 아니면 `ask`)과 `push_attached` 중 더 엄격한 쪽이다. `deny`면 새 push 요청을 승인 요청 없이 거절한다. release의 pin에는 `push_attached`가 없어 `ask`로 읽으므로 release 세션은 정책 승인을 받지 못하고, 시작 스냅샷이 있는 세션은 이후 설정이 느슨해져도 스냅샷보다 느슨해지지 않는다. 설정이 없으면 최소 `ask`이고, 저장된 `deny`는 설정을 읽을 수 있는 한 그대로 `deny`다. 설정을 읽을 수 없으면(파싱 실패) 판정은 `ask`이고 자격 증명 gate가 따로 거절한다. 적용할 수 없는(unsupported) 설정도 gate가 거절한다. API, push intent runner, push 실행기, 자격 증명 gate는 모두 control-host 한 이미지에서 같은 함수로 계산한다. 설치 설정은 없다.

이전에는 세션 저장소의 push가 `push_approval`만, 그 밖의 저장소의 push가 `push_attached`만 따랐다. 바뀌는 것은 두 값이 다를 때뿐이고, 덜 엄격하던 저장소가 더 엄격한 쪽을 따른다. `push_approval`이 꺼져 있고 `push_attached`가 `ask`(기본)이면 세션 저장소의 push가 `allow`에서 `ask`로, `deny`면 `allow`에서 `deny`로 바뀐다. `push_approval`이 켜져 있고 `push_attached`가 `allow`면 그 밖의 저장소의 push가 `allow`에서 `ask`로, `deny`면 세션 저장소의 push가 `ask`에서 `deny`로 바뀐다.

세션에 저장소가 없으면 workflow·review 도구는 `409 workflow_review_need_session_repository`로 거절된다. 저장소가 없는 세션이 저장소를 직접 지정하는 작업(attach 등)의 거절 사유는 그대로다. 구버전 strict 응답 검증기는 새 enum을 `CLIENT_CONTRACT_MISMATCH`로 보고할 수 있고, 구버전 서버는 새 코드의 refusal receipt를 목록에서 걸러 기록이 안 보일 수 있다. 어느 쪽도 실행을 허용으로 바꾸지는 않는다.

이미 저장된 push intent의 분류(`push`·`push.primary`·`push.attached`)는 읽기만 하며 감사용이다. 실행 시점의 정책으로 다시 판정한다. 기존 행은 이렇게 바뀐다.

- `approval_basis`가 `policy`인 `approved` 행과, 같은 `policy`이면서 lease가 끝난 `pushing` 행은 새 규칙이 `allow`가 아니면 claim 때 `requested`로 돌아가 사람을 기다린다. 사람이 승인한 `pushing` 행은 규칙과 무관하게 다시 claim된다.
- 이미 `requested`인 행과 사람이 승인한 행은 그대로다. 새 규칙이 `deny`인 저장소는 자격 증명 gate가 막으므로, 승인한 뒤에 실패할 수 있다.
- lease가 살아 있는 `pushing`은 다시 검사하지 않는다.

**교체 절차.** 이 규칙은 설정으로 끌 수 없고, 되돌리려면 이전 이미지로 롤백한다. 롤링 교체 중에는 구 replica가 같은 요청을 이전 규칙으로 판정해 사람 승인 없이 push할 수 있다(위 표에서 `allow`가 `ask`·`deny`로 바뀌는 조합). 행 잠금은 중복 claim만 막고 정책 버전을 강제하지 않는다. 그래서 교체와 롤백 모두 구 replica의 push 요청 수락, intent 처리, push 실행을 먼저 멈추고 진행 중인 push가 끝난 뒤 새 이미지를 올린다.

- **Compose(API 컨테이너 하나):** `docker compose up -d`가 구 컨테이너를 먼저 멈추고 새 컨테이너를 만들므로 혼합 구간이 없다. 멈출 때 `stop_grace_period`(45초) 동안 진행 중인 push가 끝나기를 기다린다.
- **Helm(`api.replicas` 기본 2, 업데이트 전략을 따로 정하지 않아 기본 RollingUpdate):** 교체 중에 구·신 파드가 함께 돌아 혼합 구간이 실제로 생긴다. 업그레이드와 롤백 전에 API Deployment를 0개로 줄이고(`kubectl scale deployment <API Deployment 이름> --replicas=0`) 파드가 모두 사라진 것을 확인한 뒤 `helm upgrade`(또는 `helm rollback`)를 하고, 끝나면 같은 명령으로 replicas를 `api.replicas` 값으로 다시 올린다(매니페스트 값이 그대로면 Helm이 손으로 줄인 값을 되돌리지 않을 수 있다). 올라오는 파드는 새 이미지뿐이다. 파드가 멈출 때는 `api.terminationGracePeriodSeconds`(기본 45초) 동안 진행 중인 push가 끝나기를 기다린다. 이 동안 API가 내려가 있어 요청이 실패하므로 점검 시간에 한다.

### 에이전트 세션의 저장소 목록: 시작 뒤에 켠 저장소와 `revoked`

에이전트 설정에서 시작하는 세션(`github_policy_source = 'agent'`)은 시작할 때 저장소 목록의 스냅샷을 남긴다. 예전에는 판정이 스냅샷과 지금 저장된 목록의 교집합이어서, 에이전트가 세션이 시작된 뒤에 켠 저장소는 세션이 `attach_repository`로 붙일 수 없었다. 이제 세션이 자기 붙인 목록(`attached_repository_ids`)을 가진 경우에만(NULL이 아닌 배열이면, 빈 배열도 포함) 목록 칸에서 스냅샷 교집합을 뺀다. 지금 저장된 목록이 그대로 기준이 된다.

- 풀리는 것은 저장소 목록뿐이다. 기능 스위치, push 승인, 첨부 저장소 push 정책, Actions 허용 목록은 시작 스냅샷과 지금 값 중 더 엄격한 쪽 그대로다. 위 "push 규칙" 절도 그대로 모든 저장소에 적용된다.
- `attached_repository_ids`가 NULL인 세션(붙인 저장소가 없는 세션과, 빈 목록을 NULL로 저장하던 옛 행)과 release에서 시작한 세션은 이전과 같이 교집합 또는 pin을 따른다. 워크스페이스 상한, GitHub 스위치, 저장소 카탈로그 검사는 그대로다.
- 에이전트가 저장소를 목록에서 빼거나 스위치를 끄면 그 저장소는 attach·gate·push intent 실행에서 거절되고, 붙인 저장소의 push 요청도 거절된다(세션 주 저장소는 attach 호출이 정책 검사 없이 이미 붙은 것으로 답하고, push 요청도 요청 시점에 목록을 다시 보지 않는다. 주 저장소의 실제 GitHub 접근은 gate가 막는다. 이 부분은 이번에 바뀌지 않았다). `list_repositories`는 예전에 붙였지만 지금은 허용되지 않는 저장소를 `revoked`로 보이고, 세션의 주 저장소가 허용되지 않게 되면 그것도 `revoked`로 보인다. 작업 공간 디렉터리, 붙인 목록, 이미 만든 push 요청은 지우거나 회수하지 않는다. 다시 켜면 그대로 되살아난다. 끝나지 않은 fetch(`pending`·`failed`)는 자기 상태를 유지한다.
- 이행할 데이터는 없다. 영향을 받는 세션을 세려면 읽기 전용으로 `SELECT status, count(*) FROM sessions WHERE github_policy_source = 'agent' AND attached_repository_ids IS NOT NULL AND status NOT IN ('failed', 'stopped') GROUP BY status`를 쓴다. 이 세션들은 이후 에이전트가 새로 켠 저장소를 붙일 수 있게 된다.

**이전 이미지로 롤백해도 안전하다(fail-closed).** 이전 이미지의 `effectiveGitHubPolicy`(`packages/contracts/src/kollegium/agents.ts`)는 시작 스냅샷과 지금 저장된 설정을 `meetGitHubSettings`로 교차해서, 시작 뒤에 켠 저장소를 여전히 거절한다. 새로 켠 저장소가 열린 채 남는 일이 없다. 달라지는 것은 이전 이미지의 `list_repositories`가 `revoked`를 아예 내지 않는다는 것(이 상태는 이번에 처음 나온다)과, 시작 뒤에 켠 저장소를 붙일 수 없다는 것뿐이다. 혼합 구간에서도 새 replica가 연 저장소를 구 replica가 거절할 뿐 구 replica가 더 열어 주는 일은 없으므로, 위 "교체 절차"처럼 replica를 먼저 멈출 필요가 없다.

### 새 세션의 시작 저장소: 저장소 없이 시작하고 필요한 것만 붙인다

`POST /v1/sessions`가 `repository_id` 없이 만드는 세션은 설정 행이 있는 에이전트(`github_policy_source = 'agent'`)에서 저장소 없이 시작한다. 에이전트는 `list_repositories`로 허용된 저장소를 보고 작업에 필요한 것만 `attach_repository`로 붙인다. 이 동작을 켜고 끄는 설치 설정은 없다.

- `repository_id`를 보낸 요청은 그 저장소로 시작한다. 허용 목록·워크스페이스 상한 검사는 그대로다.
- 설정 행이 없는 에이전트(`github_policy_source = 'release'`)는 릴리스의 저장소로 시작한다. 저장소를 요구하는 profile은 저장소 없이 뜨지 못하기 때문이다(워크스페이스 상한을 쓰는 profile은 저장소 없이도 뜬다). GitHub 탭을 한 번 저장하면 행이 생겨 이 경로에서 벗어난다.
- 에이전트 설정의 `start_repository_id`는 열과 API 필드로 남지만 시작에 쓰이지 않는다. 열 삭제는 별도 변경이다.
- 이미 시작한 세션은 바뀌지 않는다. 시작 저장소는 세션을 만들 때 한 번 정해 `sessions.repository_id`에 남고, claim과 복원은 그 행을 읽는다.
- Slack 멘션·DM과 Slack 앱 연결 때의 경고(`releaseStartable`)도 같은 규칙을 쓴다. 이 판정이 거짓이 되는 경우는 설정 행이 있는 에이전트의 설정을 읽을 수 없을 때, 그리고 설정 행이 없는 에이전트의 릴리스가 저장소를 쓸 수 없을 때다.
- **배포 영향:** 새 이미지로 올린 순간부터 `start_repository_id`가 켜진 에이전트의 새 세션이 저장소 없이 시작한다. 세려면 읽기 전용으로 `SELECT count(*) FROM agent_github_settings WHERE start_repository_id IS NOT NULL`을 쓴다.
- **롤백:** 이전 이미지로 교체하면 그 에이전트들의 새 세션이 다시 시작 저장소로 시작한다. 데이터 이행이 없고 설정으로 되돌리는 길도 없다. 이전 이미지가 만든 세션과 새 이미지가 만든 세션은 모두 행의 값으로 돌아가므로 교체 중에 갈리는 것은 새 세션의 시작 저장소뿐이고, 어느 쪽이든 허용 범위 안이다.

### Workspace 소프트 상한 (`WORKSPACE_ENFORCE`)

API의 `WORKSPACE_ENFORCE`는 `warn`(기본)·`fail`·`off` 중 하나다. 다른 값이나 빈 값이면 API가 시작하지 않는다. Compose에서는 같은 이름의 변수로, Helm에서는 `api.workspaceEnforce`로 설정한다.

- `warn`: 소프트·미확인 축의 사용량이 상한을 넘으면 경고와 지표를 남기고 턴은 계속한다. 초과량에 제한이 없다.
- `fail`: 턴 입력 전 측정값보다 사용량이 늘었고 상한을 엄격히 초과한 축이 있으면 그 턴을 중단한다. 바이트와 inode를 따로 판정하며 하드 상한이 확인된 축은 관찰만 한다. 완전한 측정은 한 번, 불완전한 측정은 같은 축의 연속 확인 뒤에 중단한다. 측정 실패만으로 턴을 실패시키지는 않는다.
- `off`: 측정 결과를 턴 중단에 사용하지 않는다. 사용량 관찰은 계속한다.

신뢰할 엔진 terminal을 받은 턴은 `failed`, reason `workspace_quota_exceeded`가 되고 receipt의 공개 오류 코드는 `WORKSPACE_QUOTA_EXCEEDED`다. 세션과 파일은 남는다. 엔진이 중단에 답하지 않아 결과를 확인할 수 없으면 `outcome_unknown`을 유지하며, 사용자 interrupt·owner 상실·이미 닫힌 턴·진행 중인 deadline을 quota보다 우선한다. 새 성공 응답이나 라우트는 추가하지 않는다.

이미 초과한 세션도 정리할 수 있도록 시작 전 전면 거절은 하지 않는다. `fail`에서도 턴 시작보다 사용량이 줄거나 같은 측정값은 상한을 넘었어도 중단하지 않는다. 삭제 전용 모드는 아니며, 삭제만 허용하는 정리 모드와 90% 미만 복귀 시험을 갖추기 전에는 기본값을 `fail`로 올리지 않는다. `fail`의 입력 전 전체 스캔은 턴마다 비용이 들며, 짧은 턴이 이어질 때 관찰 스케줄러의 최소 간격과 같은 비용 목표를 보장하지 않는다. `workspace_quota_exceeded_total`은 초과를 발견한 표본 수이며 고유한 턴 수가 아니다.

정책은 gateway가 worker claim의 선택 필드 `workspace_enforce`로 전달하며 **새 attempt부터** 적용된다. 설정 변경으로 실행 중 attempt가 즉시 바뀌지는 않는다. 즉시 적용이 필요하면 API 설정을 바꾼 뒤 진행 중 worker를 정상 drain하고 새 attempt로 재기동한다. 구버전 worker는 새 claim 필드를 버리며, 필드가 없는 claim을 받은 새 worker는 `warn`으로 동작한다. 구버전 client는 기본 설정에서 새 오류 코드를 그대로 읽지만 구버전 strict 응답 검증기는 새 enum을 `CLIENT_CONTRACT_MISMATCH`로 보고할 수 있다.

소프트 상한은 사후 탐지이므로 측정과 interrupt 사이에 쓰기가 더 진행될 수 있고 유한한 초과량을 보장하지 않는다. 열린 채 unlink한 파일 같은 순회 측정의 한계도 있다. 큰 쓰기를 확실히 막아야 하면 스토리지의 하드 상한이 필요하다.

세션 상세의 workspace 상한 줄은 최신 attempt가 기록한 `system/workspace_limit_mode` 이벤트의 바이트·inode 판별을 읽는다. 기록이 없으면 두 축 모두 미확인이다. `workspace_limit_mode` 응답 필드는 선택이며, 사용량이나 초과 횟수가 아니다. `workspace_quota_exceeded_total`은 계속 초과 표본 수를 세며 이 화면에서 세션 수로 표시하지 않는다.

Kubernetes scheduler는 해당 PVC의 `status.capacity.storage`만 읽어 내부 전달값 `WORKER_WORKSPACE_PVC_CAPACITY_BYTES`를 만든다. 운영자가 직접 설정하는 값이 아니며 PVC가 아직 Bound가 아니거나 조회 권한이 없으면 생략한다. capacity가 요청과 같아도 강제의 증거는 아니므로 기본 판별은 미확인이다. StorageClass·PV 읽기와 ClusterRole은 추가하지 않는다.

### 턴이 끝날 때 push하기

실행 중인 턴 안의 `request_push`는 요청을 만들지 않고 "이 턴이 끝날 때의 결과를 push한다"는 의도(`push_intents`)만 남긴다. 이어 가는 턴은 없고, 턴 밖에서 부르면 `no_running_turn`으로 거절한다. 예전의 `AGENT_ACTION_FLOWS`와 `SESSION_PROMPT_REVISION` 설정은 없어졌고, 값을 줘도 읽지 않는다.

- **흐름:** 의도는 `deferred`로 시작한다. 턴이 끝나면 finalize가 그 턴의 마지막 checkpoint revision을 의도에 고정한다(`pinned`). API 안의 실행기가 3초마다 고정된 의도를 하나씩 잡아, 고정된 revision에서 `origin=intent`, `flow=actions`인 push 요청을 만든다(`requested`). 이후 승인과 push는 위 절들과 같다. 턴이 checkpoint 없이 끝나면 의도는 `cancelled`(`turn_ended_without_checkpoint`)다.
- **고정한 revision:** 이 요청은 pointer가 그 revision을 지나가도 승인할 수 있다. 대신 승인 때 그 revision이 아직 검증되고 요청의 commit을 담고 있는지 다시 본다. 아니면 `pinned_source_invalid`로 거절하고, Slack 카드는 Reject만 남긴다. 고정한 revision은 요청이 열려 있는 동안, 그리고 의도가 `deferred`·`pinned`인 동안 checkpoint GC와 세션 이벤트 보관이 지우지 않는다.
- **같은 대상은 순서대로:** 같은 세션·저장소·브랜치에 앞선 요청이 열려 있거나(`requested`·`approved`·`pushing`) 그 요청의 PR 단계가 `due`·`opening`이면 뒤의 의도는 `pinned`로 기다린다. 사람이 이미 거절한 commit이면 의도는 `failed`(`rejected_before`)다.
- **배포 순서:** 새 빌드보다 오래된 checkpoint GC와 세션 이벤트 보관은 `push_intents`를 모르므로 고정한 revision을 지울 수 있다. api, `maintenance`(compose), `checkpointGc`·`sessionArchive` CronJob(Kubernetes)을 이 빌드의 이미지로 먼저 올리고, 옛 이미지로 시작한 Job이 끝났는지 본 뒤에 worker 이미지를 올린다. worker가 체크포인트에 담는 로컬 브랜치(`workspace.sources`, `refs/checkpoint/source/*`)를 옛 API는 매니페스트에서, 옛 검증기는 ref에서 거절한다. 순서가 어긋나면 새 worker의 체크포인트가 거절되는 동안 push가 막힌다(데이터는 잃지 않는다).
- **엔진 입력:** 이 빌드는 시스템 프롬프트, 도구 설명, 도구 응답, 후속 턴 메시지에 행동 지시문을 넣지 않고 사실만 적는다. 엔진이 받는 플랫폼 문단은 없어졌다. 예전 문단은 체크포인트 지문에 들어 있었으므로, worker는 그 동결된 문구로 지문을 다시 계산해 복원 후보(`alternate_profile_sha256s`)에 더한다. 이미 있던 세션도 자기 체크포인트를 이어 받는다. 엔진이 저장한 옛 시스템 프롬프트는 압축(compaction) 전까지 SDK가 재사용할 수 있어, 그동안은 옛 문구를 따르는 모델이 다음 턴에 `request_push`를 다시 부를 수 있다. 그러면 의도가 하나 더 생길 뿐 데이터를 잃지는 않는다. 이 빌드의 worker는 모든 세션의 체크포인트에 로컬 브랜치를 담는다(`keepBranches`). 옛 API는 매니페스트의 `workspace.sources`를, 옛 검증기는 `refs/checkpoint/source/*`를 거절하므로, 이 빌드의 API와 검증기를 먼저 올리고 그 뒤에 worker 이미지를 올린다. 순서가 어긋나면 새 worker의 체크포인트가 거절되는 동안 push가 막힌다(데이터는 잃지 않는다). 승인은 고정한 revision의 `gitCommit`이나 담긴 브랜치 끝 commit 어느 쪽이든 받는다(`pinnedCarries`).
- **남은 의도 확인:** 의도는 실행기가 계속 처리한다. 모두 처리됐는지는 아래로 본다. 0행이면 끝이다.

```sql
SELECT status, count(*) FROM push_intents
WHERE status IN ('deferred', 'pinned') GROUP BY status;
```

- **보는 곳:** 세션의 성과물 탭 "GitHub 작업"과 `GET /v1/sessions/{id}/push-requests`(`items`의 `origin`·`flow`·`pr_state`, `intents`)에서 의도의 상태와 끝난 이유를 읽는다. 열려 있는 동안 웹은 10초마다, 아니면 1분마다 다시 읽는다.
- **아직 없는 것:** 실행기는 의도를 만든 사람의 세션 공유 권한을 다시 확인하지 않고, 릴리스 정책과 게이트만 다시 판정한다. `ceiling` 판정은 기존 push 실행기의 게이트가 맡는다. PR을 여는 단계는 다음 변경에서 붙는다.

### 승인된 요청의 push

API 프로세스가 3초마다 `approved` 요청을 하나씩 잡아 push한다. replica가 여럿이면 같은 행을 둘이 잡지 않는다(`FOR UPDATE SKIP LOCKED`). 승인 뒤 보통 몇 초 안에 요청이 `pushing`을 거쳐 `pushed`나 `failed`가 된다. `requested`·`rejected`·이미 끝난 요청은 잡지 않으므로 push되지 않는다.

- **무엇을 어디로:** 요청이 고정한 commit 하나를, 요청이 고정한 저장소의 `refs/heads/agent/<session-id>`에 push한다. 다른 ref나 tag는 보내지 않는다. force push는 없다. 원격 브랜치가 이미 있고 그 commit이 push할 commit의 조상이 아니면 `non_fast_forward`로 거절한다. 같은 commit이 이미 있으면 그대로 `pushed`다.
- **거절하는 대상:** 브랜치가 `agent/<session-id>`가 아니면 `target_refused`, 카탈로그 `branch`이거나 원격의 기본 브랜치(GitHub API의 `default_branch`, 원격 `HEAD`가 가리키는 브랜치)면 `default_branch`다.
- **고정한 저장소:** 요청은 카탈로그 항목의 binding(URL·branch·auth의 종류와 참조 위치의 해시, 비밀 값은 넣지 않음)을 함께 저장한다. push 때 다시 계산해 다르면(URL을 바꿈, auth를 바꿈, 항목을 지움) `catalog_changed`로 거절하고 원격에는 아무 요청도 보내지 않는다. 그 세션은 새로 요청해 다시 승인받는다. 같은 참조 뒤의 비밀 값만 바꾸는 키 교체는 binding을 바꾸지 않는다.
- **자격 증명:** `github_app`은 `contents: write`, 그 저장소 하나로 좁힌 설치 토큰을 새로 받는다(clone용 읽기 토큰과 따로 캐시한다). 토큰은 git 프로세스의 환경 변수(`GIT_CONFIG_COUNT`)로 `http.<저장소 URL>.extraHeader`에만 들어간다. 명령줄 인자, URL, 저장소 config, 디스크 어디에도 쓰지 않고, redirect는 따라가지 않는다.
- **checkpoint에서 꺼내기:** 고정한 revision의 manifest와 bundle 체인을 restore처럼 처음부터 다시 검증하고(digest와 git 검증기), `baseBundles` 순서로 임시 bare 저장소에 fsck를 켜고 fetch한다. 이 저장소는 template가 없어 hook이 없고, checkout이 없어 filter·attribute·submodule이 돌지 않으며, 사용자·시스템 git config를 읽지 않는다. 끝나면 임시 디렉터리를 지운다.
- **lease:** `pushing`은 15분 lease를 가진다. push의 git은 claim부터 12분(lease의 80%)이 지나면 끊기고, 그 뒤에는 새 git을 시작하지 않는다. 그래서 살아 있는 시도가 lease를 넘겨 다른 시도와 겹쳐 쓰지 않는다. git 프로세스마다 checkpoint 검증과 같은 메모리 상한(`CHECKPOINT_GIT_MEMORY_MB`)과 파일 크기·CPU 상한이 걸린다(Linux의 `prlimit`). API가 push 도중 죽으면 lease가 끝난 뒤 다른 replica(또는 재기동한 API)가 같은 요청을 다시 잡는다. 같은 commit이 이미 원격에 있으면 `pushed`로 끝난다. 세 번 잡혀도 끝나지 않으면 `lease_expired`로 `failed`가 되고, 세션은 새 요청을 만들 수 있다. 늦게 깨어난 이전 시도는 결과를 덮어쓰지 못한다.
- **결과:** `GET /v1/sessions/{id}/push-requests/{push_request_id}`의 `push_receipt_id`가 `push` receipt를 가리킨다. 그 `result`에는 위 필드에 더해 `remote_url`, `remote_ref`(`refs/heads/agent/<session-id>`), `previous_commit`(원격 ref가 전에 가리키던 commit, 새로 만들었으면 null), `approved_by`(결정한 actor)가 있다. 실패면 `refusal`과 `error.code`가 있다: `catalog_changed`(`CATALOG_MISMATCH`), `target_refused`·`default_branch`·`no_push_credential`(`FORBIDDEN`), `non_fast_forward`(`REVISION_CONFLICT`), `checkpoint_unavailable`(`CHECKPOINT_UNAVAILABLE`), `lease_expired`(`LEASE_EXPIRED`), `push_failed`(`BACKEND_UNAVAILABLE`, 토큰 발급 실패·원격 거절·네트워크). 원격이 보낸 메시지는 receipt에 넣지 않는다. API 로그의 `Push refused`·`Push failed`·`Push request finished` 줄에 `push_request_id`와 사유가 있다.
- **필요한 권한:** GitHub App은 Repository permissions **Contents: Read and write**(위 App 절). API 컨테이너에서 저장소 host로 나가는 outbound가 열려 있어야 한다(clone은 proxy를 거치지만 push는 API가 직접 한다).
- **기본 브랜치 보호(권장):** 코드가 기본 브랜치를 거부하지만 GitHub에서도 한 번 더 막는다. 저장소 Settings → Rules → Rulesets → New branch ruleset에서 Target을 `Include default branch`로 두고 **Restrict updates**, **Restrict deletions**, **Block force pushes**를 켠다. Bypass list에는 App을 넣지 않는다. 사람의 리뷰를 거친 머지만 받으려면 **Require a pull request before merging**도 켠다. `agent/*` 브랜치에는 force push 금지(**Block force pushes**)만 거는 ruleset을 따로 두면 플랫폼이 아닌 누군가가 그 브랜치를 되돌리는 일도 막는다.
- **push된 commit의 CI(주의):** push되는 commit의 내용은 에이전트가 쓴 것이다. 사람이 그 commit을 승인하지만, 저장소가 `agent/*` push에 CI를 돌리면 에이전트가 고친 `.github/workflows/` 파일도 그대로 실행된다. 그 workflow는 저장소의 Actions secret과 `GITHUB_TOKEN` 권한으로 돈다. 그래서 승인할 때 workflow 파일 변경을 따로 보고, 위 ruleset으로 기본 브랜치를 막으며, App에는 `Workflows` 권한을 주지 않는다. 이 권한이 없으면 GitHub이 workflow 파일을 바꾸는 push를 거절하므로 그런 commit은 `push_failed`로 끝난다. `agent/*` push에서 CI가 필요 없으면 기존 workflow의 `on.push.branches-ignore`에 `agent/**`를 넣는다. 이 설정은 바뀌지 않은 workflow에만 효과가 있으므로 `Workflows` 권한을 빼는 것과 함께 쓴다.

### push한 브랜치의 PR과 코멘트

`pushed`가 된 요청의 `agent/<session-id>` 브랜치로 PR을 열고, 그 PR에 코멘트를 달거나 고칠 수 있다. PR은 두 가지 길로 열린다. 하나는 사람이나 key가 API 호출로 한 번 여는 것이고, 다른 하나는 push 요청에 PR 요청이 붙어 있을 때 push가 끝나면 control-host 안의 action-broker가 여는 것이다. 뒤쪽 길은 control-host가 뜰 때 같이 시작하므로 다시 띄워도 이미 시작된 PR 단계는 끝까지 처리된다. 코멘트는 API 호출로 한 번씩 하며, 플랫폼이 세션 이벤트마다 스스로 코멘트를 달지는 않는다. PR 승인·머지·리뷰어 지정·라벨은 하지 않는다.

- **열기:** `POST /v1/sessions/{id}/push-requests/{push_request_id}/pull-request`, body `{title?, body?}`. head는 요청의 `agent/<session-id>`, base는 카탈로그 항목의 `branch`다. 요청이 `pushed`가 아니면 409 `PUSH_NOT_PUSHED`다. 다만 `?schedule=true`를 붙이면 409 대신 202와 `status: "scheduled"`를 받고, push가 끝나는 대로 action-broker가 PR을 연다(이미 `pushed`면 곧바로 열 차례가 된다). 카탈로그 항목의 binding이 요청 때와 다르면 push와 같이 409 `CATALOG_MISMATCH`다. 요청 하나에 PR은 하나다. 이미 기록된 PR이 있거나 GitHub에 그 브랜치의 열린 PR이 있으면 새로 열지 않고 그 PR을 200(`created: false`)으로 돌려준다. 같은 세션의 다음 push 요청은 같은 브랜치를 갱신하므로 열린 PR도 같고, 그 요청으로도 코멘트를 달 수 있다. PR 행은 그 PR을 연 push 요청에 묶인다. 그 요청의 호출은 PR이 닫혀도 기록된 PR을 그대로 돌려주고, 다른 push 요청의 호출은 GitHub에서 그 브랜치의 열린 PR을 다시 찾아 없으면(사람이 닫았으면) 새 PR을 연다.
- **코멘트:** `POST .../pull-request/comments`, body `{body, marker?}`(`marker` 기본값 `status`). 코멘트 끝에 `<!-- werft:<session-id>:<marker> -->`를 붙이고, 플랫폼이 쓴(App이 작성자인) 같은 marker의 코멘트가 이미 있으면(오래된 순 처음 1000개 안에서) 새로 달지 않고 그 코멘트를 고친다. 다른 사람이 marker를 복사해 둔 코멘트는 건드리지 않는다. PR을 먼저 열지 않았으면 409 `PULL_REQUEST_MISSING`이다.
- **누가:** push 결정과 같은 규칙이다. `sessions:approve`를 가진 API key나 로그인한 사용자만 부르고, scope는 서비스가 검사해 거절도 receipt로 남는다. worker 자격은 `/v1`에서 401이고 `AUTH_MODE=none`에서는 403(`unverified_principal`)이며 기록하지 않는다.
- **본문 정리:** 제목·본문·코멘트는 GitHub에 보내기 전에 정리한다. 각 줄을 로그 마스킹과 같은 규칙(`sanitizeText`)에 넣어 비밀처럼 보이는 줄(`ghp_…`, `token:` 같은 줄)은 `[REDACTED]` 한 줄로 바꾼다. `@멘션`, 다른 저장소 참조(`owner/repo#N`), closing keyword(`Closes #N`, `fixes owner/repo#N`, `resolves <URL>` 등), HTML 주석(`<!--`)은 zero-width space를 끼워 알림·링크·자동 닫기·숨김이 일어나지 않게 한다. 제목은 한 줄 256자, 본문과 코멘트는 GitHub의 65536자 안으로 자르고 `…(truncated)`를 붙인다. PR 본문 끝에는 `<!-- werft:pr-tail -->`로 시작해 `<!-- /werft:pr-tail -->`로 끝나는 꼬리가 붙는다. 세션 id·commit, 세션 URL(콘솔 origin이 있을 때), 에이전트·release, push 요청, 시작 경로(`web`·`slack`·`personal_key`·`agent_key`·`operator_key`), 시작자의 GitHub 연결 여부, 연결돼 있으면 `Co-authored-by:` 줄이다. 이미 있는 PR을 돌려줄 때(`created: false`)도 그 PR 본문의 꼬리를 지금 commit으로 바꾼다. 바꾸는 것은 마지막 꼬리(시작 표시 줄부터 다음 끝 표시 줄까지, 표시는 각자 한 줄에 들여쓰기 없이 홀로, 코드 블록과 `<details>` 같은 HTML 요소 밖에 있고, 사이가 플랫폼이 쓰는 줄을 그 순서로 한 번씩 담을 때만 센다. 사람이 그 안에 줄을 더하면 사람 글이다)뿐이고, 앞뒤에 사람이 쓴 글은 줄바꿈까지 쓴 그대로, 문장·코드 블록·HTML 블록에 인용하거나 사이를 고친 표시는 글로 둔다. 그런 짝이 없으면(옛 PR, 사람이 꼬리를 지운 PR) 아무것도 지우지 않고 끝에 붙인다. 본문이 코드 블록이나 HTML 요소를 연 채 끝나면 닫는 줄을 더한 뒤 붙인다. 꼬리 갱신이 실패해도 PR 응답은 그대로이고 API 로그에 경고만 남는다. 아래 "GitHub 계정 연결"도 본다.
- **자격 증명:** `github_app`은 그 저장소 하나와 `contents: read`·`pull_requests: write`로 좁힌 설치 토큰을 따로 받는다(clone의 `contents: read`, push의 `contents: write` 토큰과 캐시 key가 다르다). PR 조회·생성과 코멘트 목록·작성·수정 모두 이 토큰으로 된다. `contents: read`가 없으면 github.com은 PR 생성을 422 `not all refs are readable`로 거절한다(2026-10-29 실측). GitHub forge가 없는 저장소는 403 `FORBIDDEN`(`no_forge`)이다.
- **필요한 권한:** GitHub App은 Repository permissions **Pull requests: Read and write**(위 App 절, Contents와 함께). `Issues`·`Workflows` 권한은 필요 없으니 주지 않는다. API 컨테이너에서 `api_base` host로 나가는 outbound가 열려 있어야 한다.
- **rate limit:** REST 호출은 `@octokit/core`에 retry·throttling plugin을 붙여 한다. 429와 secondary rate limit 403은 GitHub가 준 `retry-after`(또는 `x-ratelimit-reset`)만큼 기다렸다 다시 보내고, 재시도는 2번까지, 기다릴 시간이 60초를 넘으면 기다리지 않는다. 5xx도 2번까지 다시 보낸다. 쓰기 호출 사이에는 plugin이 1~3초 간격을 둔다. 끝내 실패하면 503 `BACKEND_UNAVAILABLE`(`forge_failed`)이고 API 로그에 `GitHub rate limit`(`limit`, `request`, `retry_after_seconds`, `retrying`)과 `GitHub request failed`(`request`, `status`)가 남는다. 토큰과 응답 본문은 로그에 쓰지 않는다.
- **감사:** 열기·코멘트·거절된 시도마다 receipt가 남는다. operation은 `open_pull_request`·`comment_pull_request`, target은 `{session_id, request_id: <push_request_id>}`, `result`는 `{push_request_id, verdict, refusal, repository_id, number, url, head, base, created}`이고 코멘트는 `{comment_id, comment_url, marker}`를 더한다. 응답의 `receipt_id`, 거절이면 `error.details.receipt_id`로 `GET /v1/receipts/{id}`에서 읽는다. PR 번호·URL은 `pull_requests` 테이블에 push 요청과 함께 남는다.

### 자율 모드: `bypassPermissions`·`auto`

profile의 `permission_mode`는 `default`·`acceptEdits`·`dontAsk`·`plan`·`bypassPermissions`·`auto` 중 하나다. 뒤의 둘이 자율 모드로, 도구 호출을 사람의 승인 없이 실행한다.

- `bypassPermissions`: 파일 쓰기·Bash·`git commit`을 포함해 모든 도구 호출을 그대로 실행한다. 권한 pending-request를 만들지 않는다.
- `auto`: 엔진이 원래 물었을 도구 호출(예: Bash)마다 모델 분류기가 허용·거부를 정한다. 분류기 호출도 같은 provider route로 나가므로 세션 비용에 잡힌다(2026-10-13 실측: Bash 호출 하나에 분류기 요청 하나, 첫 요청 약 0.11달러, 이후 약 0.009달러). 분류기를 쓸 수 없으면 엔진은 그 호출을 거부한다(fail closed).
  - 플랫폼 기본 규칙: 이 모드에서만 worker가 엔진에 `autoMode`를 flag settings로 넘긴다(`packages/adapters/runtimes/claude/src/auto-mode.ts`). 규칙은 도구가 아니라 행동 부류 단위의 영어 문장이고, 칸마다 `$defaults` 뒤에 붙는다. worker가 `platform_tool_trust`를 알리고 control-host가 `trusted` 도구를 보낸 세션에서는 push·PR·저장소 읽기 도구가 분류기를 거치지 않으므로(아래 "분류기를 거치지 않는 도구") allow는 Git Work(세션 작업 공간의 commit. 비밀값 commit은 `Not covered:`)와 Pull Request Merge만 남는다. 리뷰 제출(승인·변경 요청 포함)과 workflow dispatch·재실행은 허용에 든 적이 없는 행동이라, 예전에는 allow의 `Not covered:` 한 줄만 있어 아무것도 막지 못했다. 지금은 soft_deny의 Reviews and Workflows 한 줄이 막고, 사용자가 이 대화에서 그 행동을 요청했으면 풀린다. 알리지 않는 옛 worker, 또는 `platform_tool_trust`를 알렸는데 `trusted`가 없는 설정을 받은 worker에서는 예전 세 줄이 그대로다: Git Work(commit과, 플랫폼 push 흐름으로 이 세션의 저장된 checkpoint를 세션 자기 저장소, 또는 세션에 붙인 저장소의 플랫폼이 만든 세션 작업 브랜치에 push. 모든 저장소에 서버가 push 승인과 첨부 저장소 push 정책 중 더 엄격한 쪽으로 거절하거나 사람 승인을 붙인다), Pull Requests(그 브랜치에서 PR 열기, 이 세션이 연 PR의 제목·본문 수정, 코멘트, 닫기와 다시 열기), Repository Reading(허용된 저장소 목록과 읽기용 붙이기). `platform_tool_trust`를 모르는 옛 control-host는 새 worker의 claim 본문을 400으로 거절하지만, worker는 그 키만 거절당한 것을 오류 본문의 `details.issues`에서 읽으면 키를 뺀 `capabilities`로 한 번 다시 보낸다(`/pending-control` poll도 같다). 그래서 배포 순서 제약은 없고, 그 claim에서는 `trusted`가 없어 위 폴백(예전 세 줄, 모든 도구가 엔진 권한 단계)으로 돈다. 그 밖의 400은 그대로 실패한다. 각 줄의 `Not covered:`에 기본·보호 브랜치나 플랫폼이 만들지 않은 브랜치 push, force push, 머지·승인·닫기·리뷰 제출, 플랫폼 push 흐름이 아닌 경로의 push, 비밀값을 적는다. soft_deny 한 줄: GitHub Administration(저장소 설정·브랜치 보호·webhook·deploy key·Actions secret 변경, GitHub의 브랜치·저장소 삭제, PR 머지, 경로 무관). 도구 이름은 environment에서만 행동과 잇는다(`request_push`는 push, `open_pull_request`·`update_pull_request`·`comment_pull_request`는 PR, `list_repositories`·`attach_repository`는 저장소 읽기). 엔진은 `autoMode`를 user·flag·policy settings에서만 읽으므로 저장소의 `.claude/settings.json`은 이 규칙을 넓히거나 지우지 못한다(엔진 2.1.270에서 `claude --settings … auto-mode config`로 네 칸 모두 기본값 뒤에 합쳐지는 것을 확인). 이 상수는 profile fingerprint에 들어가지 않으므로 바꿔도 기존 세션이 `CATALOG_MISMATCH`가 되지 않는다. 끄는 방법은 따로 두지 않았다. push마다 사람 승인을 받게 하려면 에이전트의 push 승인을 켜거나 첨부 저장소 push 정책을 `ask`로 둔다(어느 쪽이든 모든 저장소에 적용된다. `default`로 바꿔도 `trusted` 도구는 엔진이 묻지 않는다). push 승인은 모드와 별개라 `auto`여도 둘 중 하나가 그렇게 되어 있으면 모든 저장소의 push마다 묻는다(정책이 `deny`면 묻지 않고 거절한다). GitHub 탭 첫 저장은 꺼진 채로 시작하지만(서버 `legacy_defaults`, 저장소 없는 release는 콘솔 `NO_REPOSITORY_DEFAULTS`), `policy_pins.github`가 없는 release는 켜진 것으로 읽는다. push가 승인 없이 가는 것은 push 승인이 꺼져 있고 첨부 저장소 push 정책이 `allow`일 때뿐이며, 세션 주 저장소와 붙인 저장소에 똑같이 적용된다(위 "push 규칙" 절). 정책이 `deny`면 거절하고, 그 밖에 둘 중 하나라도 `ask`면 사람 승인이다.

- **분류기를 거치지 않는 도구.** 내장 `github` 서버의 push(`request_push`)·PR 쓰기(`open_pull_request`·`update_pull_request`·`comment_pull_request`·`close_pull_request`·`reopen_pull_request`)·저장소 읽기(`list_repositories`·`attach_repository`) 도구는 `trusted`다. 어댑터가 허용 목록 검사, checkpoint admission, 도구 시작 기록을 지난 뒤에 PreToolUse `allow`를 돌려주므로, 엔진의 권한 단계가 건너뛰어진다: `default`의 허용 카드도 `auto`의 분류기도 이 도구에는 없다. 판정은 서버 한 곳이 한다: 에이전트의 push 승인(`push_approval`)과 첨부 저장소 push 정책 중 더 엄격한 쪽(모든 저장소에 하나), release의 도구 노출 목록, 세션에 묶인 grant, GitHub 게이트의 권한 교집합. 그래서 push 승인을 끄고 첨부 저장소 push 정책도 `allow`로 둔 `auto` 세션은 어느 저장소로 가는 push든 분류기 판정 없이, 분류기를 쓸 수 없는 때에도 실행한다(정책이 `deny`면 거절하고, 그 밖에 둘 중 하나라도 `ask`면 사람 승인을 기다린다). 분류기가 막던 "PR 글의 비밀값" 판단도 이 도구에서는 서버의 redact(알려진 모양만)로 줄었다. 리뷰 제출과 workflow 도구는 `trusted`가 아니라 지금처럼 엔진 권한 단계를 지난다. `plan` 모드는 이 도구도 지금처럼 엔진이 묻는다. 새 worker(`platform_tool_trust`)가 아니면 이 구분이 없다: 옛 worker는 칸을 받지 않아 모든 도구가 엔진 권한 단계를 지난다. 옛 control-host가 새 worker의 `platform_tool_trust`를 거절해 worker가 키 없이 다시 claim한 세션도 같다. 배포 순서는 정하지 않아도 된다.
- **지정하는 곳은 카탈로그뿐이다.** 세션 생성 요청은 profile id만 고르고 모드를 바꿀 수 없다. 모드는 fingerprint에 들어가므로, 같은 id의 모드를 바꾸면 그 id로 만든 세션은 새 모드로 돌지 않고 `CATALOG_MISMATCH`가 된다. 자율 모드는 새 상한으로 저장하고(`POST /v1/installation-profiles`) 그 상한의 `repository_ids`에 저장소를 넣는다. 저장소의 예시 설정 문서 중 `real-model.json`의 `claude-coding-real`은 `auto`이고(2026-11 전에는 `default`였다. 그 전에 시드한 설치의 상한은 그대로 `default`다), `fake-model.json`에는 `claude-coding-auto`가 `auto` 바탕으로 있다(기존 id와 모드만 다르다). `local-model.json`에는 자율 모드 profile이 없다. `bypassPermissions` profile은 어느 기본 문서에도 없다.
- **워크스페이스 프로필로 쓰려면 바탕이 있어야 한다.** 워크스페이스 판은 바탕보다 좁게만 고르므로, 콘솔에서 `auto` 판을 만들려면 `auto`나 `bypassPermissions`, `bypassPermissions` 판을 만들려면 `bypassPermissions` 운영자 profile이 카탈로그에 있어야 한다. 콘솔의 새 프로필은 `auto`를 허용하는 바탕을 먼저 고르고 `auto`에서 시작한다. 콘솔의 새 설치 상한도 runtime이 `auto`를 열면 `auto`에서 시작하고, 이 설치에서 닫힌 모드(예: `PLATFORM_ALLOW_UNATTENDED_PERMISSIONS`가 꺼진 설치의 `bypassPermissions`)를 이어받는 새 버전도 `auto`로 바뀌며 검토 칸에 그 변경이 보인다. 이미 `default`로 저장한 profile은 자동으로 옮기지 않는다. 설치 상한은 owner가 상세의 **새 버전**에서 `auto`로 저장하고, 워크스페이스 판은 바탕이 `auto`를 허용하면 **수정**에서 `auto`로, 바탕이 `default`이면 `auto`를 허용하는 바탕 위에 새 판을 만든다. 어느 쪽이든 에이전트의 새 release가 그 버전을 써야 바뀐다. 바탕이 허용하지 않는 모드는 비활성 선택지로 보이고 이유를 한 줄 적는다. `bypassPermissions`를 고르면 판정 없이 모두 실행된다는 위험 안내가 뜬다. 판을 저장하는 것은 다른 판과 같이 owner·admin(`workspace.manage`)뿐이고 member의 저장은 `403 FORBIDDEN`(`reason_code: role`)이다. 그래서 `bypassPermissions` 판은 이 모드의 운영자 profile을 등록한(아래 설치 설정을 켠) 설치에서 owner·admin만 만들 수 있다. bypass opt-in 예시는 `tests/fixtures/settings/fake-model-unattended.json`(fake model 위에 `claude-coding-bypass`)과 그것을 가져오게 하는 overlay `infra/compose.fake-model-unattended.yml`(migrate가 그 문서를 읽고, API·slack 역할에 `PLATFORM_ALLOW_UNATTENDED_PERMISSIONS=true`)이다. 로컬에서는 `COMPOSE_FILE=compose.yaml:infra/compose.fake-model-unattended.yml scripts/local.sh up --fake-model`로 띄운다. 실제 provider 설치에서는 그 profile을 새 상한으로 저장하고, API와 slack 역할에 이 변수를 `true`로 준 뒤 다시 띄운다.
- **`bypassPermissions`는 설치가 허용해야 돈다.** API 환경 변수 `PLATFORM_ALLOW_UNATTENDED_PERMISSIONS=true`가 없으면 이 모드의 `installation_profiles` 행은 그 프로세스의 카탈로그에서 빠진다. API는 그대로 뜨고 기동 로그 `Profiles left out of this replica's catalog`에 id와 `unattended_off`를 적는다. 그 profile과 그 위의 워크스페이스 판으로는 release·세션·claim이 돌지 않는다. DB 행 하나 때문에 설치가 멈추지 않게 하려는 것이다. 값은 정확히 `true`만 받는다. `auto` profile은 이 변수 없이 뜬다: 엔진 도구는 분류기가 호출마다 판정하고, 분류기를 쓸 수 없으면 거부하기 때문이다. 내장 `github` 서버의 push·PR·저장소 읽기 도구만 예외로 분류기를 거치지 않고 서버 정책이 판정한다(위 "분류기를 거치지 않는 도구"). 둘 중 어느 모드든 profile이 있으면 기동 로그에 `Profiles run tools without asking for approval`(대상 profile id 목록) 경고가 남는다. 카탈로그는 설치 사이를 옮겨 다니므로, 이 설치의 격리를 보증하는 일은 카탈로그가 아니라 설치 설정이 맡는다. compose 설치(`infra/compose.local.yml`)는 셸이나 저장소 `.env`의 같은 이름 변수를 API에 넘기고, 없으면 `false`다.
- **남는 경계.** 사람 승인이 빠지면 남는 것은 세션마다 하나인 worker 컨테이너(root 아님), egress proxy 허용 목록(Messages API·저장소 route·object store route만), profile `tools` 목록, 세션 비용 상한(`SESSION_COST_LIMIT_USD`, turn의 `maxBudgetUsd`)이다. `tools` 목록은 이 모드에서도 PreToolUse hook이 강제하고, 비용 상한과 checkpoint 중 도구 차단도 그대로다. 이 넷 중 하나라도 없는 설치(예: worker를 host 네트워크로 띄우는 경우)에서는 켜지 않는다. 저장소 자격 증명은 worker에 가지 않으므로([위 절](#provider-키와-저장소-자격-증명은-worker에-가지-않는다)) 자율 세션도 push할 수 없고, 바뀐 내용은 checkpoint로만 나간다.
- **감사.** 세션 목록·상세의 `runtime.permission_mode`가 그 세션이 도는 모드다. worker의 claim 로그에도 `permission_mode`가 남는다. 모드는 세션에 고정되므로 receipt에는 따로 싣지 않는다.
- 실제 모델로 확인하는 방법은 [real-claude.md](../real-claude.md#자율-모드-세션)에 있다.

### 예시 설정 문서

`tests/fixtures/settings/`의 문서는 로컬 스택과 E2E가 migrate 단계에서 가져오는 예시다. 운영 설치는 이 문서를 쓰지 않는다. `real-model.json`은 `https://api.anthropic.com`을 endpoint로, API 프로세스의 `ANTHROPIC_API_KEY`를 `value_env`로, compose `fake-git` 서비스(읽기 전용)의 `sample-app`을 저장소로 쓴다. `fake-model.json`은 외부 계정 없이 도는 예시다: compose `fake-messages`(fake Messages API)를 endpoint로, compose `secrets`(API 전용 LocalStack Secrets Manager, worker egress allowlist에 없음, `infra/compose.fake-model.yml`을 얹을 때만 뜬다)에 심어 둔 placeholder 키를 `secret_id`로 쓴다. `agent/sample-app`은 fake-git이 기동할 때마다 같은 커밋으로 다시 만든다. URL은 `http://fake-git:3000/agent/sample-app.git`이다. 세션은 시작할 때의 `repo_url`을 간직하고 설정과 다르면 `CATALOG_MISMATCH`로 멈추므로, 이 URL을 바꾸면 그 전 세션은 이어지지 않는다.

```bash
docker compose -f infra/compose.yml up -d secrets
AWS_ENDPOINT_URL_SECRETS_MANAGER=http://127.0.0.1:4567 AWS_REGION=ap-northeast-1 \
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
PLATFORM_SECRET_KEY="$(openssl rand -hex 32)" \
AUTH_MODE=none PORT=3000 CHECKPOINT_OBJECT_STORE=disabled \
EXECUTION_SLOT_LIMIT=10 QUEUED_INPUT_LIMIT_PER_SESSION=20 STORAGE_LIMIT_BYTES=1073741824 \
MAX_TURN_SECONDS=3600 SESSION_COST_LIMIT_USD=25 PROVIDER_MAX_RETRIES=2 \
  bun run --cwd apps/control-host start
curl -H 'X-Owner-Id: local-owner' http://127.0.0.1:3000/v1
```

## 트레이스 내보내기 (OTLP)

API 서비스만 읽는 설정이다. 기본은 꺼짐이라 키를 하나도 주지 않으면 span을 만들지도, 요청을 보내지도 않는다. 로그의 `trace_id`·`span_id`는 활성 span 안에서만 찍힌다([로그 레코드 계약](../contributing/decisions/logging-contract.md)). 설계는 [관측(OTel) 방향과 도구 호출 감사](../contributing/decisions/observability-otel-and-tool-call-audit.md) 6절이다.

| 키 | 기본값 | 뜻 |
|---|---|---|
| `OTEL_TRACES_EXPORTER` | `none` | `none` 또는 `otlp` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | 없음 | 수집기 주소. 앞의 것은 뒤에 `/v1/traces`를 붙이고, 뒤의 것은 그대로 쓴다. `otlp`인데 둘 다 없으면 시작 시 멈춘다 |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | 이 값만 받는다 |
| `OTEL_EXPORTER_OTLP_HEADERS` / `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | 없음 | `키=값,키=값`(값은 퍼센트 인코딩, 출력 가능한 ASCII만). 뒤의 것이 같은 이름에서 이긴다. 시작 때 모양을 검사해 틀리면 멈춘다. 비밀이므로 env 파일로만 준다. 로그와 오류 메시지에 값을 쓰지 않는다 |
| `OTEL_SERVICE_NAME` | `werft-api` | |
| `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG` | `always_on` / `1.0` | `always_on`, `always_off`, `traceidratio`(비율 0~1) |
| `TRACE_TENANT_HEADER` | 없음 | `<헤더 이름>: <값 틀>`. 값 틀의 `{workspace_id}`를 워크스페이스 id로 바꿔 batch마다 붙인다 |
| `TRACE_INSTALL_TENANT` | 없음 | 워크스페이스가 없는 span의 테넌트 값 |
| `TRACE_TENANT_HEADERS_FILE` | 없음 | `{"<workspace_id>": {"<헤더>": "<값>"}}` JSON. 비밀이므로 mode 600 파일만 받는다. 같은 헤더 이름은 이 파일이 `TRACE_TENANT_HEADER`보다 이긴다 |
| `TRACE_INGEST_URL` | 없음 | worker가 닿는 ingest listener 주소(`http`·`https`). `otlp`인데 없으면 시작 시 멈춘다. claim의 `telemetry.ingest_url`로 나간다 |
| `TRACE_CONTENT_MODE` / `TRACE_CONTENT_MAX_BYTES` | `full` / `32768` | 내용 수집 상한(`full`·`metadata`)과 내용 속성 하나의 바이트 상한. 지금은 설치 상한만 적용된다 |
| `TRACE_INGEST_PORT` / `TRACE_INGEST_MAX_REQUEST_BYTES` / `TRACE_INGEST_MAX_BYTES_PER_MIN` / `TRACE_MAX_BYTES_PER_TRACE` / `TRACE_FENCED_GRACE_SEC` | `4319` / 4MiB / 32MiB / 20MiB / `300` | ingest listener의 포트와 상한. 0·음수·숫자가 아닌 값은 키 이름을 밝히고 시작 시 멈춘다 |

**켜는 최소 설정.** 특정 수집기가 필요 없다. OTLP/HTTP(protobuf)로 받는 수집기면 된다. 세 키를 api의 env에 준다. 1단계는 트레이스 신호만 내고 프롬프트·답변·도구 입출력은 span 속성(`gen_ai.*`)에 실리므로 로그 저장소가 필요 없다.

```bash
OTEL_TRACES_EXPORTER=otlp
OTEL_EXPORTER_OTLP_ENDPOINT=https://otel-collector.example.com:4318
TRACE_INGEST_URL=http://api:4319
EGRESS_PRIVATE_ALLOWLIST=api:3000,host.docker.internal:3000,api:4319
```

- **compose.** 위 값을 compose를 띄우는 셸이나 `.env`에 두면 `infra/compose.core.yml`이 api 컨테이너에 넘긴다(표의 모든 키가 같은 이름이다). `EGRESS_PRIVATE_ALLOWLIST`는 기본값 `api:3000,host.docker.internal:3000`에 `api:<TRACE_INGEST_PORT>`를 더해 준다. worker가 ingest에 가는 길이 egress proxy를 지나기 때문이다. 이 목록에 수집기 주소를 넣지 않는다.
- **Kubernetes(Helm).** 키는 `api.extraEnv`에 `이름: 값`으로 준다. 포트는 Service와 NetworkPolicy도 알아야 하므로 `config.tracing.ingestPort`(기본 `4319`)로만 바꾸고 `TRACE_INGEST_PORT`는 따로 주지 않는다. `TRACE_INGEST_URL`은 `http://<api Service 이름>:4319`이다. 기본값(`config.egress.privateAllowlist` 비움)은 `<api Service 이름>:3000`만 허용하므로, 켤 때는 `config.egress.privateAllowlist`를 `<api Service 이름>:3000,<api Service 이름>:4319`로 직접 지정한다.
- 수집기 주소 호스트를 `EGRESS_PRIVATE_ALLOWLIST`·`EGRESS_ALLOWLIST`에 넣으면 api가 시작할 때 경고를 남긴다. worker는 수집기로 직접 가지 않는다.

**업그레이드.** 이미 `OTEL_TRACES_EXPORTER=otlp`로 쓰던 설치는 `TRACE_INGEST_URL`을 더해야 api가 시작한다. 없으면 키 이름을 밝히고 멈춘다. worker가 span을 보낼 주소이므로 worker에서 api의 `TRACE_INGEST_PORT`(기본 `4319`)에 닿는 주소를 쓴다. 이 포트는 `otlp`일 때만 열린다.

**수집기가 맞춰야 할 조건.**

- 한 트레이스의 크기 상한을 `TRACE_MAX_BYTES_PER_TRACE`(20MiB)보다 크게 둔다. 작으면 수집기가 큰 트레이스를 버린다.
- 테넌트마다 credential이 다르면 `TRACE_TENANT_HEADERS_FILE`을 쓴다. mode 600인 JSON 파일이고(아니면 시작 시 거절), 같은 헤더 이름이 겹치면 `TRACE_TENANT_HEADER`와 `OTEL_EXPORTER_OTLP_HEADERS`보다 이 파일이 이긴다. 값은 비밀이므로 저장소에 두지 않는다. 형식만 보이면 다음과 같다.

```json
{ "<workspace_id>": { "<header name>": "<secret value>" } }
```

- 테넌트 헤더를 설정하지 않은 단일 테넌트 설치에서는 모든 워크스페이스의 트레이스가 한 곳에 모인다. 백엔드 UI 접근을 운영자에게만 준다.
- 내용(프롬프트·답변·도구 입출력)은 `TRACE_CONTENT_MODE=full`일 때 수집기로 간다. 워크스페이스별 content mode는 아직 없고 설치 상한만 적용된다(나중 단위에서 더한다). 내용을 내보내지 않으려면 `metadata`로 둔다.

데이터 흐름(무엇이 어떤 경로로 어디까지 가는지)을 따로 적은 `docs/observability.md`는 이 저장소에 아직 없다. 생기면 여기서 링크만 건다.

`OTEL_*` 키는 worker와 엔진에 넘어가지 않는다. worker는 bootstrap claim의 `telemetry`(`enabled`, `ingest_url`, `content_mode`, `content_max_bytes`, `sampler`, `sampler_arg`)와 `nextInput`의 `content_mode`로만 설정을 받는다. 수집기 호스트가 `EGRESS_PRIVATE_ALLOWLIST`나 `EGRESS_ALLOWLIST`에 있으면 api가 시작할 때 경고를 한 번 남긴다.

켜면 `/v1/**` 요청마다 `{METHOD} {route_template}` span(예: `POST /v1/sessions/:id/turns`)이 새 root로 생긴다. 클라이언트가 보낸 `traceparent`는 부모가 아니라 link로만 남고, 그 sampled 플래그는 따르지 않는다. 헬스·메트릭 경로와 worker gateway(`/internal/**`)는 span이 없고, gateway는 worker가 그 turn의 trace id로 `traceparent`를 보낸 호출만 그 trace의 자식 span을 만든다.

turn을 큐에 넣은 요청(세션 생성의 첫 turn, `POST /v1/sessions/{id}/messages`)의 span `traceparent`는 `turns.trace_context`(마이그레이션 0263, nullable)에 같은 트랜잭션으로 저장되고, worker의 `nextInput` 응답에 `trace_context`로 실린다. 꺼져 있거나 마이그레이션 이전의 turn은 null이라 필드가 빠진다.

## checkpoint object store

API는 checkpoint object store 설정을 기동 시 요구한다 — `S3_BUCKET`·`AWS_REGION`(+ 선택 `AWS_ENDPOINT_URL`)이 없으면 기동하지 않는다. `AWS_ACCESS_KEY_ID`·`AWS_SECRET_ACCESS_KEY`는 둘 다 주거나 둘 다 뺀다. 하나만 있으면 기동하지 않는다. 둘 다 빼면 AWS SDK 기본 credential chain이 서명한다. EKS에서는 api ServiceAccount의 IRSA role이 그 자리에 오고, chart는 `secrets.objectStoreKeys: false`로 이 경로를 쓴다. chain이 아무 credential도 찾지 못하면 요청은 서명 없이 나가지 않고 실패한다. 이 credential은 워커의 object store route 요청을 서명하는 데도 쓰인다. object store 없이 띄우려면 `CHECKPOINT_OBJECT_STORE=disabled`를 명시한다: 모든 checkpoint가 거절되고 워커 checkpoint 프로토콜은 409 `CHECKPOINT_UNAVAILABLE`로 답하며 기동 로그에 경고가 남는다. 빠진 bucket이 checkpoint 없는 finalize 뒤에 숨지 않도록 침묵 기본값을 두지 않았다. compose `apps` profile은 localstack 값을 기본으로 넣는다.

checkpoint 객체는 기본적으로 **version으로 고정되고 legal hold로 잠긴다**(`CHECKPOINT_OBJECT_PROTECTION=locked`). manifest의 모든 ref와 finalize의 `manifest_version`은 워커의 `putImmutable`이 돌려준 S3 VersionId를 싣는다. finalize는 그 version을 읽어 검증한 뒤 manifest·transcript part·bundle·untracked 파일의 각 version에 legal hold를 걸고 나서야 pointer를 올린다. 다음 checkpoint는 직전 committed manifest와 `path`·`sha256`·실행 비트가 모두 같은 untracked 파일이면 그 manifest가 이미 검증하고 hold한 version ref를 그대로 싣고 PUT하지 않는다. finalize는 직전 pointer가 증명한 정확한 artifact tuple만 다른 publish 디렉터리에서 가져오는 것을 허용하며, restore plan과 GC도 새 manifest가 가리키는 그 version을 그대로 따라간다. pointer(`checkpoints.manifest_version`)와 restore plan도 같은 version을 들고 간다. 그래서 커밋 뒤 같은 key를 덮어쓰거나 지우거나 delete marker 뒤에 다시 올려도 복원 대상은 바뀌지 않고, hold가 걸린 version은 hold를 푸는 권한 없이는 지울 수 없다. hold 해제는 아래 checkpoint GC의 몫이다. hold를 걸 수 있는 권한은 풀 수도 있으므로 워커에게 주면 안 된다. 워커는 object store 자격 증명을 받지 않고, proxy의 object store route는 legal hold·retention 요청을 403으로 거절한다([위 절](#provider-키와-저장소-자격-증명은-worker에-가지-않는다)). API는 기동 시 bucket의 versioning이 `Enabled`이고 Object Lock 설정이 있는지 확인하고, 아니면 기동하지 않는다. **versioning이 꺼진 bucket에서는 `CHECKPOINT_OBJECT_PROTECTION=unversioned`를 명시해야 한다. 이 저하된 모드는 key로만 읽고(manifest의 version은 무시하고 restore plan에서도 뺀다) hold를 걸지 않으므로, 커밋 뒤의 삭제·덮어쓰기를 막지 못하고 복원 때 digest 불일치로 발견할 뿐이다. 이 모드에서는 이전 untracked ref도 재사용하지 않고 다시 PUT한다.** 기동 로그에 경고가 남는다. `unversioned`에서 `locked`로 바꾸면, `unversioned`로 커밋된 checkpoint는 첫 restore 때 version 단위로 다시 해시하고 hold를 건 뒤에 내준다. pointer에 version이 없는 checkpoint는 `CHECKPOINT_UNAVAILABLE`이 된다. compose의 로컬 S3 초기화는 `claude-sessions`를 Object Lock으로 만들고, 예전 volume에 남은 bucket에는 versioning과 Object Lock 설정을 켠다(그 전에 올라간 객체는 version이 없어 locked API가 거부한다).

capture 성공 로그 `worker.checkpoint.published`는 `untracked`·`untracked_bytes`·`untracked_changed`·`untracked_unchanged`·`untracked_uploads`와 `manifest_bytes`를 남긴다. 성공·거절·실패마다 별도로 `worker.checkpoint.result` 하나가 `operation=checkpoint_capture`, `outcome`, `reason_code`, 전체 `duration_ms`, 단계별 `durations_ms`, 실제 PUT 호출 `put_count`, 새로 저장된 `uploaded_bytes`, `manifest_bytes`, 이전 ref나 duplicate를 쓴 `reused_count`, 다른 bytes와 맞선 `conflict_count`를 남긴다. 이 결과 event에는 manifest/object key나 body를 넣지 않는다. manifest delta나 packing은 없다. 현재 manifest는 복원에 필요한 전체 ref를 계속 싣기 때문에 untracked PUT과 저장량은 줄지만 manifest 크기는 줄지 않으며, `manifest_bytes` 계측으로 별도 변경의 효과와 필요성을 판단한다.

**checkpoint 객체의 저장 시 암호화**는 bucket 기본 암호화 SSE-S3(`AES256`)에 맡긴다. 워커의 checkpoint 쓰기는 암호화 헤더를 싣지 않으므로 bucket 기본값이 곧 모든 객체의 암호화다. API는 object store가 켜져 있으면 보호 모드와 무관하게 기동 시 `GetBucketEncryption`을 읽고, 기본 규칙이 `AES256`이 아니면(설정 없음, `aws:kms` 포함) 기동하지 않는다. SSE-KMS를 받지 않는 이유는 워커 credential마다 KMS 키 권한이 붙어야 하기 때문이다. 다른 설정으로 띄워야 하면 `CHECKPOINT_OBJECT_ENCRYPTION_CHECK=warn`을 명시한다. 그러면 기동 로그에 경고만 남는다. API credential에는 `s3:GetEncryptionConfiguration`이 필요하다. compose의 로컬 S3 초기화는 `claude-sessions`에 `AES256` 기본 암호화를 건다. `scripts/restore.sh`는 자기 로컬 S3에 bucket을 만들 때 같은 설정을 걸고, 그 밖의 대상 bucket은 `AES256`이 아니면 거부한다.

**비워진 bucket**. object store가 켜져 있으면 API는 기동 때 DB에 `collected_at IS NULL`인 checkpoint 행이 있는지 본다. 있으면 `ListObjectVersions`로 bucket에 object version이 하나라도 남았는지 확인하고, 하나도 없으면(delete marker만 남은 경우 포함) 원인과 복구 명령(`scripts/local.sh reset`)을 적은 오류로 기동하지 않는다. 로컬 S3는 SeaweedFS named volume에 객체와 암호화 키를 보존한다. 이 검사는 이전 휘발성 LocalStack 설치의 유실이나 S3 volume 누락으로 postgres의 행만 남은 경우를 잡는다. version별 무결성은 여전히 백업과 `scripts/verify-restore.sh`가 본다. API credential에는 `s3:ListBucketVersions`가 필요하다.

**checkpoint GC**는 `bun run apps/control-host/src/api/checkpoint-gc.ts`로 도는 one-shot이다. reconciler처럼 한 pass만 돌고 끝나며, api 이미지와 API의 object store 환경 변수에 `DATABASE_URL`을 더해 실행한다. `CHECKPOINT_GC_DRY_RUN=true`를 주면 지울 개수만 세고 아무것도 지우지 않는다.

compose 설치에서는 `maintenance` 서비스가 **주 1회**(`MAINTENANCE_INTERVAL_SEC`, 기본 604800초) GC를 돌고 이어서 [세션 이벤트 보관](data-retention.md#세션-이벤트-보관)을 돈다. Unix epoch부터 센 주기의 배수 시각에 돈다(기본값이면 매주 목요일 00:00 UTC). 그래서 재시작해도 바로 돌지 않고, 다음 실행이 뒤로 밀리지도 않는다. Kubernetes 설치에서는 chart의 CronJob(`checkpointGc.schedule`, 기본 `0 4 * * 0`, `concurrencyPolicy: Forbid`)이 api ServiceAccount로 돌고, `checkpointGc.dryRun: true`면 개수만 센다. 바로 한 번 돌리려면 `kubectl -n werft create job --from=cronjob/werft-checkpoint-gc checkpoint-gc-manual`을 쓴다. compose 설치에서는 떠 있는 api 컨테이너 안에서 실행한다. 이 컨테이너에는 필요한 환경 변수가 이미 들어 있다.

```bash
docker compose exec -T -e CHECKPOINT_GC_DRY_RUN=true api bun run apps/control-host/src/api/checkpoint-gc.ts   # 지울 개수만 본다
docker compose exec -T api bun run apps/control-host/src/api/checkpoint-gc.ts                                 # exit 0이면 끝
```

세션 하나라도 실패하면 exit 1이고, 로그에 `Checkpoint GC failed for a session`이 남는다. 백업과 겹치면 안 된다(아래). 백업은 api와 maintenance가 멈춰 있어야 시작하므로, 이 두 컨테이너에서 도는 GC는 백업 중에 시작될 수 없다. 다만 GC가 도는 도중에 컨테이너를 멈추고 백업을 시작하면 겹칠 수 있다. 백업은 GC가 끝난 뒤에 받는다. test-ops 설치의 명령은 [test-ops.md](test-ops.md)의 점검표에 있다.

**한계: checkpoint 바이트는 저장량에 세지 않는다.** `STORAGE_LIMIT_BYTES`는 보관한 입력 메시지 바이트만 센다([설치 상한](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/configuration/#설치-상한)). checkpoint가 S3에 쓰는 바이트와 legal hold가 걸린 version은 계측하지도 제한하지도 않는다. `locked`에서는 모든 version에 hold가 걸려 있어, GC가 hold를 풀고 지우기 전까지는 bucket lifecycle 규칙으로도 줄지 않는다. 저장량은 주 1회 GC와 bucket 크기 관찰로 관리한다.

회수 범위는 세션마다 두 곳이다. `sessions/<id>/checkpoints/<rev>/<attempt>/` 아래의 version(manifest·bundle·untracked 파일), 그리고 `sessions/<id>/transcripts/generation-<n>/` 아래의 transcript part version이다. 그 밖의 key는 건드리지 않는다. version 하나를 지우는 조건은 아래 두 가지가 모두 맞을 때다.

- 어떤 restore도 그 version을 읽지 않는다. pointer, pointer 아래 parent 체인의 `maxRestoreFallbacks`(3)개 revision, 세션이 마지막으로 폴백 복원한 base 가운데 어느 manifest도 그 version을 가리키지 않는다.
- 더 이상 finalize가 그 version을 커밋할 수 없다. checkpoint 디렉터리는 revision이 pointer 이하이거나, attempt가 fence를 잃었을 때다(`exited`/`lost` 상태이거나 epoch·generation·auth revision이 세션과 다르다). transcript part는 key의 generation이 세션의 `execution_generation`보다 작을 때다. 그 generation의 attempt는 모두 fence를 잃었다.

그래서 죽은 generation이 마지막 checkpoint 뒤에 쓴 tail, 폴백으로 버려진 history에만 있던 part, window 밖으로 밀려난 revision에만 있던 part가 회수된다. 살아 있는 generation의 part와, 보존 revision이 상속한 이전 generation의 part는 남는다. 병합으로 대체된 합본도 그 generation이 끝난 뒤 같은 규칙으로 회수된다.

finalize는 두 가지를 거부한다. 첫째, manifest가 자기 publish 디렉터리 밖의 checkpoint 디렉터리 객체를 가리키는 경우다. 둘째(`locked`만), 자기 attempt의 generation이 아닌 transcript part 중 후보가 딛고 선 checkpoint가 가리키지 않는 것을 가리키는 경우다. 딛고 선 checkpoint는 pointer(후보는 그다음 revision으로만 커밋된다)이거나, 폴백 복원한 attempt라면 pointer의 parent다. 둘 다 GC가 보존한다. 그래서 hold → GC → pointer CAS 순서로 경쟁해도, 커밋될 checkpoint의 version은 GC가 회수할 수 없는 곳에 있다. 지울 때는 legal hold를 먼저 풀고 그 version을 지운다. 지운 revision의 `checkpoints` 행에는 먼저 `collected_at`을 적는다. backup은 이 행을 건너뛰므로, GC를 backup과 동시에 돌리지 않는다.

**`versions_held=false`인 pointer**(`unversioned`로 커밋된 checkpoint)는 그 manifest가 가리키는 **key의 모든 version**을 보존한다. 이런 checkpoint는 restore가 key로 다시 해시하고 hold를 걸기 때문이다. 보존 대상 manifest를 읽지 못하거나 digest가 맞지 않는 세션은 통째로 건너뛴다.

**`unversioned`와 `CHECKPOINT_OBJECT_STORE=disabled` 배포**에서는 hold도 version 고정도 없으므로 GC가 아무것도 하지 않고, 로그만 남긴 뒤 0으로 끝난다.

## API 인증과 권한

API 키 모드는 migration을 적용한 전용 로컬 DB에서 키를 한 번 발급한 뒤 사용한다. CLI는 평문 키를 발급 순간 한 번만 출력하고 DB에는 SHA-256 digest와 scope만 저장한다. `--scopes`는 필수이며 `sessions:read`·`sessions:write`·`sessions:approve`·`sessions:control`·`sessions:recover` 중에서 고른다. `/v1` 요청은 `apps/control-host/src/api/openapi.ts`의 route 선언에서 파생된 `API_ROUTE_SCOPES`가 요구하는 scope를 검사하고, 없으면 body나 세션을 읽기 전에 `403 FORBIDDEN`이다. `sessions:recover`(recovery-decisions)는 별도 scope라 `sessions:write`나 `sessions:control`에 포함되지 않는다. cookie 사용자는 role로 scope를 받는다(owner 전부, member는 recover 제외). scope 도입 전에 발급된 키(scope NULL)는 아무 scope도 없으므로 다시 발급한다.

```bash
DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
  bun run --cwd apps/control-host keys create local-owner --scopes sessions:read,sessions:write
AUTH_MODE=api-key DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
AWS_ENDPOINT_URL=http://127.0.0.1:4566 AWS_REGION=ap-northeast-1 \
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test S3_BUCKET=claude-sessions \
EXECUTION_SLOT_LIMIT=10 QUEUED_INPUT_LIMIT_PER_SESSION=20 STORAGE_LIMIT_BYTES=1073741824 \
MAX_TURN_SECONDS=3600 SESSION_COST_LIMIT_USD=25 PROVIDER_MAX_RETRIES=2 \
  bun run --cwd apps/control-host start
curl -H 'Authorization: Bearer <issued-key>' http://127.0.0.1:3000/v1
```

웹 콘솔은 같은 `/v1`을 cookie 세션으로 호출한다. 처음 한 번 `POST /v1/auth/bootstrap`이 첫 owner와 기본 workspace를 만드는데, `BOOTSTRAP_TOKEN`이 일치하고 live owner가 없을 때만 통과한다. 토큰을 먼저 보므로 틀린 토큰은 owner 유무와 관계없이 `401`이고, 맞는 토큰인데 live owner가 있으면 `409 BOOTSTRAP_DONE`이다. `BOOTSTRAP_TOKEN`을 주지 않으면 API가 기동 시 하나를 생성하고, live owner가 없거나 owner 수를 셀 수 없을 때만 내놓는다. `BOOTSTRAP_TOKEN_FILE`이 있으면(test-ops 단일 서버 설치) 토큰은 그 owner 전용 파일에만 놓이고 로그로 되돌아가지 않으며, `scripts/test-ops.sh bootstrap-token`이 한 번 꺼내면서 지운다. `BOOTSTRAP_TOKEN_FILE`을 설정하지 않은 구성(`scripts/local.sh` 등)에서는 stderr에 `BOOTSTRAP_TOKEN=…` 한 줄로 출력한다(구조화 로그는 토큰 필드를 가리므로 거기엔 없다). 로그인은 `POST /v1/auth/login`(email·password, argon2id)이며 `__Host-werft_session` cookie(`HttpOnly; Secure; SameSite=Lax; Path=/`, Domain 없음, 14일 sliding)를 세운다. `__Host-` 접두사라 형제 서브도메인이 같은 이름의 cookie를 심어 가리지 못한다. 미들웨어는 `Authorization` 헤더가 있으면 그것만 평가하고(잘못되거나 비었거나 Bearer가 아닌 헤더를 cookie로 대체하지 않음) 헤더가 없을 때만 cookie를 본다. cookie principal의 상태 변경 요청은 `X-Requested-With: werft-web` 헤더가 없으면 `403`이다(bearer 경로에는 적용되지 않음). login은 cookie를 세우므로 호출자와 무관하게 같은 헤더가 필요하다(없거나 cross-site면 `403`, login CSRF로 피해자를 공격자 계정에 로그인시키는 것을 막는다). 사용자당 live 세션은 10개까지이고, login이 그 사용자의 만료·폐기된 row를 지우고 가장 오래된 세션부터 밀어낸다. 로그인 실패는 email당 5회/15분 뒤 `429`. 주소를 바꿔 가며 시도해도 비밀번호 검증(argon2id)은 프로세스당 동시 4개·대기 64개까지만 받고 넘치면 조회 전에 `429`(`Retry-After: 1`)로 끊는다. IP 단위·replica 공통 제한은 ingress가 맡는다. `GET /v1/auth/me`가 선택된 principal·user·workspace와, 그 역할이 지금 워크스페이스에서 가진 관리 action 목록(`permissions`, 역할 표 그대로. 웹은 이것으로 화면 전체를 못 쓰는 메뉴를 숨긴다. API key는 빈 목록)을 돌려준다. `AUTH_MODE=none`에서는 cookie 경로가 꺼지고 `X-Owner-Id`만 본다. 기동 로그(stderr)를 설치자가 아닌 사람도 읽는 배포에서는 `BOOTSTRAP_TOKEN`을 직접 넣어 자동 생성 경로를 쓰지 않는다 — `BOOTSTRAP_TOKEN_FILE` 없이 stderr로 출력된 자동 생성 토큰은 첫 owner가 생길 때까지 그 로그를 읽는 누구에게나 bootstrap 권한을 준다. 설정한 값은 32~256자여야 하며 벗어나면 API가 기동하지 않는다. 빈 값(`BOOTSTRAP_TOKEN=`)도 설정 실패로 보고 기동하지 않는다.

로컬 개발 스택의 데모 계정 CLI(`apps/control-host/src/api/demo-accounts.ts`)는 운영 설치에 쓰지 않는다. 게시 이미지(`ghcr.io/jeongjaesoon/werft-control-host`)에는 이 CLI와 `demo-data.ts`가 없다. 거기서 `DEMO_ACCOUNTS=local`로 부르면 `Module not found`로 실패한다. 두 CLI는 Dockerfile의 `local` target(`docker build --target local`)으로 빌드한 이미지에만 있고, `scripts/local.sh`와 `deploy/kind/up.sh`가 그 이미지를 쓴다. `scripts/local.sh up`이 자기 compose 스택의 api 컨테이너에서 `DEMO_ACCOUNTS=local`을 주고 부를 때만 공개된 비밀번호의 owner·member를 만들고, 그 값이 없거나 Kubernetes 안이거나 `DATABASE_URL`이 로컬 postgres가 아니면 아무것도 쓰지 않고 거부한다. Kubernetes에서는 chart `preview.enabled: true`로 설치한 미리보기 namespace(api 컨테이너가 자기 namespace를 `PREVIEW_NAMESPACE`로 받는다. values로 직접 넣으면 렌더가 실패한다)에서 `DATABASE_URL`이 그 namespace의 `postgres` Service일 때만 예외다. 운영 설치에서는 이 플래그를 켜지 않는다([quickstart § 웹 콘솔 데모 계정](../quickstart.md#웹-콘솔-데모-계정)). 데모 에이전트·세션 CLI(`apps/control-host/src/api/demo-data.ts`)도 같은 조건으로 거부하고, 쓰는 프로필이 fake Messages API를 부르지 않아도 거부한다.

```bash
curl -s -X POST http://127.0.0.1:3000/v1/auth/bootstrap -H 'Content-Type: application/json' \
  -d '{"bootstrap_token":"<token>","email":"owner@example.com","password":"<12+ chars>","display_name":"Owner","workspace_name":"Acme","workspace_slug":"acme"}'
curl -s -c jar -X POST http://127.0.0.1:3000/v1/auth/login -H 'Content-Type: application/json' \
  -H 'X-Requested-With: werft-web' \
  -d '{"email":"owner@example.com","password":"<12+ chars>"}'
curl -s -b jar http://127.0.0.1:3000/v1/auth/me
curl -s -b jar -X POST http://127.0.0.1:3000/v1/auth/logout -H 'X-Requested-With: werft-web' -i
```

### 계정 복구

이메일 발송은 없다. 비밀번호를 잃은 사용자는 owner에게 재설정 토큰을 받는다. owner가 cookie 세션으로 `POST /v1/workspaces/{id}/members/{userId}/password-reset`에 `{current_password}`를 보내면 1회용 토큰(`apr_…`, 만료 1시간)이 응답에 한 번만 온다(`Cache-Control: no-store`). 현재 비밀번호를 다시 받는 것은 owner cookie를 탈취한 사람이 그것만으로 다른 계정을 가져가지 못하게 하기 위해서다. 틀린 비밀번호는 `403`이고 login과 같은 email당 실패 창(5회/15분 뒤 `429`)에 쌓인다. owner는 자기 자신에게 발급할 수 없고(`403`), 다른 workspace의 owner를 겸하는 사용자에게도 발급하지 않는다(`403`). 발급마다 `issue_password_reset` receipt가 남고, `result.target_role`로 대상이 owner였는지 구분된다. DB(`password_resets`)에는 sha256만 남고, 같은 사용자에게 다시 발급하면 앞의 토큰은 폐기된다. 계정이나 membership이 비활성인 사용자에게는 발급하지 않는다(`404`). 발급 뒤 비활성이 되면 그 토큰도 쓸 수 없다. owner는 토큰을 직접 전달하고, 사용자는 `POST /v1/auth/password-reset`에 `{token, password}`로 새 비밀번호를 정한다. 토큰을 URL에 두지 않는 것은 access log나 프록시가 경로를 남기기 때문이다. 성공하면 같은 transaction에서 비밀번호가 바뀌고, 그 사용자의 live web session이 모두 폐기되며, `reset_password` receipt(`target_ref`는 `{user_id, workspace_id}`)가 남는다. 쓴 토큰, 만료된 토큰, 폐기된 토큰은 `401`이다.

유일한 owner를 잃었을 때(계정 `disabled_at` 또는 owner membership `disabled_at`, 둘 중 하나라도 있으면 live owner가 아니다)는 새 `BOOTSTRAP_TOKEN`으로 API를 재시작하고 같은 `POST /v1/auth/bootstrap`을 부른다. 이미 사용자가 있는 설치에서는 새 workspace를 만들지 않는다(`workspace_name`·`workspace_slug`는 무시). 대신 기존 workspace에 그 email의 owner를 추가하거나 복원한다. 기존 계정이면 비밀번호를 바꾸고 계정·membership 비활성을 풀고 role을 owner로 둔다. workspace의 live web session은 모두 폐기되고 `recover_owner` receipt(`target_ref`는 workspace resource)가 남는다. 한 번 쓴 `BOOTSTRAP_TOKEN`은 sha256으로 `bootstrap_token_uses`에 기록되어, 재시작해도 다시 통과하지 않는다(`401`). 설치 때 쓴 값이 env에 남아 있어도 복구 경로를 다시 열지 못한다. API는 기동할 때 live owner가 있으면 설정된 `BOOTSTRAP_TOKEN`도 쓴 것으로 기록한다. owner가 살아 있는 동안 설정된 값은 복구용 새 토큰이 아니기 때문이다. 이 기록이 생기기 전에 설치한 배포도 업그레이드 뒤 첫 기동에서 설치 토큰이 막힌다. 기동 때 DB에 닿지 못하면 경고 로그를 남기고 30초마다 다시 확인한다. live owner가 있는 동안 맞는 토큰으로 bootstrap을 부르면 그 토큰도 쓴 것으로 기록된다. 쓴 토큰은 틀린 토큰과 같은 `401`을 받고, 사유는 API 로그에만 남는다.

두 공개 route(`bootstrap`·`password-reset`)에는 실패 창이 없다. 토큰은 256bit(`BOOTSTRAP_TOKEN`은 32자 이상)라 실패 횟수 제한이 추측을 막는 효과는 거의 없다. 토큰은 주소처럼 사람에 묶이지 않으므로 창을 두면 설치 전체에 하나가 되고, 누구나 틀린 요청으로 그 창을 채워 정상 복구를 `429`로 막을 수 있다. 비밀번호 hash는 login과 같은 동시 4개·대기 64개 gate를 쓰고, 넘치면 `429`(`Retry-After: 1`)다. IP 단위·replica 공통 제한은 login처럼 ingress가 맡는다.

```bash
curl -s -b jar -X POST "http://127.0.0.1:3000/v1/workspaces/$WORKSPACE_ID/members/$USER_ID/password-reset" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: werft-web' \
  -d '{"current_password":"<owner password>"}'
curl -s -X POST http://127.0.0.1:3000/v1/auth/password-reset -H 'Content-Type: application/json' \
  -d '{"token":"<apr_…>","password":"<12+ chars>"}'
```

### Google 로그인

로그인 수단은 `login_methods` 테이블에 사용자별로 둔다. 비밀번호는 `kind=password` 행 하나이고(bootstrap과 migration 0138이 만든다), Google 계정은 `kind=google` 행의 (issuer, subject)로 찾는다. 이메일로는 찾지 않는다. Google로만 들어온 사용자는 `users.password_hash`가 NULL이고, 비밀번호 로그인은 틀린 비밀번호와 같은 `401`, owner의 재설정 링크 발급은 `404`다.

설정은 env 하나로 전역에 둔다. 셋 다 비어 있으면 Google 로그인은 꺼지고 두 route가 `404`다. 일부만 있거나 값이 틀리면 API가 기동하지 않고 `/readyz`도 `503`이다.

| env | 뜻 |
|---|---|
| `GOOGLE_OIDC_CLIENT_ID`·`GOOGLE_OIDC_CLIENT_SECRET` | Google Cloud의 OAuth client(웹 애플리케이션) |
| `GOOGLE_OIDC_REDIRECT_URI` | Google에 등록한 승인된 리디렉션 URI. 웹의 콜백 화면 주소다 |
| `GOOGLE_OIDC_ISSUER` | 기본 `https://accounts.google.com`. 시험용 IdP를 가리킬 때만 바꾼다 |
| `GOOGLE_OIDC_ALLOWED_DOMAINS` | 쉼표 목록. 있으면 id_token의 `hd`와 이메일 도메인이 목록에 있는 Google Workspace 계정만 받는다(`403`). 개인 Gmail은 `hd`가 없어 막힌다 |
| `GOOGLE_OIDC_JIT` | `off`(기본) 또는 `member`. `member`는 허용 도메인 계정을 초대 없이 member로 만든다. 허용 도메인 없이 켜면 기동하지 않는다 |

로그인 화면은 공개 `GET /v1/auth/login-methods`(`{"methods":["password","google"]}`, Google을 설정하지 않으면 `password`만)로 고를 수 있는 수단을 받는다. 흐름: 웹이 `POST /v1/auth/google/start`(`X-Requested-With` 필요)로 `authorization_url`을 받아 연다. 응답은 state·nonce·PKCE verifier를 담은 `__Host-werft_google_login` cookie(10분)를 세운다. Google이 리디렉션 URI로 `code`·`state`를 돌려주면 웹이 그대로 `POST /v1/auth/google/callback`에 보낸다. API가 code를 교환하고 id_token의 서명(JWKS)·iss·aud·exp·nonce·`email_verified`를 확인한 뒤 첫 진입 규칙을 위에서부터 적용한다.

1. 이미 연결된 (issuer, subject) → 그 사용자로 로그인. 계정이나 멤버십이 비활성이면 거절.
2. 그 이메일의 계정이 이미 있으면 → `409 LOGIN_LINK_REQUIRED`("기존 계정으로 로그인한 뒤 설정에서 Google을 연결"). 초대나 JIT가 있어도 이메일로 합치지 않는다. 이 응답은 Google이 지금 그 이메일의 주인임을 보증하는 계정(이메일 도메인이 `hd`와 같거나 `gmail.com`)만 받고, 그 밖의 계정과 비활성 계정은 5번과 같은 `401`을 받아 계정이 있는지 알 수 없다.
3. 그 이메일 앞으로 살아 있는 초대 → 비밀번호 없는 계정을 만들고 초대를 수락한다(초대의 workspace·role). 단, Google이 지금도 그 주소의 주인을 보증하는 계정만이다: 이메일 도메인이 계정의 Workspace 도메인(`hd`)과 같거나 `gmail.com`인 경우. 그 밖의 주소는 가입할 때 한 번 확인된 것이라 주소 주인이 바뀌었을 수 있어, 초대를 받지 못하고 5번으로 간다. 만료는 초대 행을 잠근 뒤 DB 시각으로 다시 본다.
4. JIT가 켜져 있으면 → 설치의 workspace에 member로 만든다.
5. 그 밖에는 `401 UNAUTHORIZED` "Google sign-in was not accepted". 토큰 검증 실패와 같은 응답이라 계정이 있는지 드러나지 않는다.

성공하면 비밀번호 login과 같은 `__Host-werft_session` cookie와 login 응답을 준다. 설계의 규칙 순서(초대·JIT가 같은 이메일 안내보다 앞)와 달리 2번을 먼저 보는 것은, 같은 이메일의 계정이 있으면 새 계정을 만들 수 없어 초대·JIT가 결국 이메일로 합치는 것이 되기 때문이다. 로그인한 사용자가 설정에서 Google을 연결하는 API와 콜백 화면은 아직 없다(웹 로그인 화면 작업에서 만든다).

실제 Google 연결 확인 절차(사람이 한다):

1. Google Cloud Console → API 및 서비스 → OAuth 동의 화면을 만들고(내부 또는 외부, 범위 `openid`·`email`·`profile`), 사용자 인증 정보 → OAuth 클라이언트 ID(웹 애플리케이션)를 만든다. 승인된 리디렉션 URI에 `GOOGLE_OIDC_REDIRECT_URI`로 쓸 주소(예: `https://<host>/auth/google/callback`)를 넣는다.
2. client id·secret을 위 env로 API에 준다(compose는 `infra/compose.core.yml`이 같은 이름으로 넘긴다). 값은 로그나 티켓에 붙이지 않는다.
3. 기동 뒤 `curl -s <api>/readyz`가 `200`인지 본다.
4. 콜백 화면이 생기기 전에는 아래로 확인한다. 받은 `authorization_url`을 브라우저로 열고 Google 계정으로 동의하면, 브라우저가 리디렉션 URI로 이동한다(화면이 없어도 주소창에 `code`·`state`가 남는다). 그 둘을 10분 안에 같은 cookie jar로 보낸다. 주소창의 `code`는 percent-encoding되어 있으므로(`4%2F0A…`) URL decode한 값(`4/0A…`)을 보낸다. 그대로 보내면 Google이 code를 거절해 `401`이 된다.

```bash
curl -s -c jar -b jar -X POST https://<host>/v1/auth/google/start -H 'X-Requested-With: werft-web'
# 브라우저로 authorization_url을 열고 동의한 뒤, 이동한 주소의 code(URL decode)·state를 옮긴다
curl -s -c jar -b jar -X POST https://<host>/v1/auth/google/callback -H 'X-Requested-With: werft-web' \
  -H 'Content-Type: application/json' -d '{"code":"<code>","state":"<state>"}'
curl -s -b jar https://<host>/v1/auth/me
```

   기대값: 허용 도메인 목록이 있고 그 밖의 계정이면 규칙보다 먼저 `403`. 그 밖에는 Google이 주소를 보증하는 계정(이메일 도메인이 `hd`와 같거나 `gmail.com`)일 때 초대한 이메일이면 `200`과 그 초대의 role, owner 이메일이면 `409 LOGIN_LINK_REQUIRED`이고, 보증되지 않는 주소는 둘 다 `401`이다. `__Host-` cookie는 `Secure`라 curl은 HTTPS나 `localhost`·`127.0.0.1`에서만 jar에 남긴다. 다른 호스트의 `http://` 주소로는 흐름이 이어지지 않는다.

시험용 IdP는 저장소 checkout(`packages/testkit`)이나 `local` target 이미지에서만 돈다. 게시 이미지에는 testkit이 없다. `bun packages/testkit/src/mock-oidc-main.ts`(`MOCK_OIDC_PORT`·`MOCK_OIDC_CLIENT_ID`·`MOCK_OIDC_CLIENT_SECRET`·`MOCK_OIDC_ISSUER`·`MOCK_OIDC_PUBLIC_URL`)가 Google 대신 discovery·JWKS·authorize·token을 낸다. authorize는 바로 동의하고, 로그인할 계정은 authorization URL에 붙인 `login_hint`(id_token claim JSON의 base64url)로 고른다. 통합 테스트(`google-login.integration.test.ts`)가 같은 IdP로 다섯 규칙을 고정한다. 테스트 이름의 규칙 번호(2 초대, 3 JIT, 4 같은 이메일)는 위 목록의 순서와 다르다. 위 목록이 실제 적용 순서다.

### workspace key, 개인 key, 오프보딩

`keys create <owner_id>`로 만든 key는 운영자 key(`kind: operator`)다. workspace 밖에서 그 owner를 partition으로 쓴다. `<owner_id>` 자리에 workspace id를 주면 거절한다. `keys create --workspace <workspace_id> --personal <user_id> --scopes …`는 그 멤버의 개인 key를 만든다. 그 workspace를 partition으로 쓰므로 웹에서 만든 세션을 API에서도 같은 목록으로 본다. `--workspace`는 `--personal` 없이 쓸 수 없다. workspace 전체에 닿는 key는 없다. 개인 key는 key scope와 만든 사람의 지금 역할이 허용하는 scope의 교집합만 갖는다(`/v1/auth/me`의 `scopes`도 그 교집합을 보여 준다). 만든 사람의 계정이나 그 workspace의 membership이 비활성이 되면 다음 요청부터 `401`을 받는다. 에이전트 key는 사람과 무관하게 계속 동작한다. 이 판정은 요청마다 DB를 다시 읽어서 한다. API key는 scope와 관계없이 관리 action(인수 목록·세션 인수·key 발급 등)을 할 수 없다(`403`). 관리 action은 사람의 cookie 세션으로만 한다. 누가 무엇을 하는지는 아래 역할 표를 따른다.

누가 했는지는 새로 쓰는 행에 남는다. cookie로 만든 세션은 `sessions.workspace_id`·`created_by_user_id`를, key로 만든 세션은 `created_by_api_key_id`를 기록한다(개인 key는 만든 사람도 함께 기록한다). turn은 `actor_id`를, receipt는 `actor`를 남긴다. 에이전트 key는 key만 기록하고 사람은 기록하지 않는다. 0136 migration은 사람을 추측하지 않는다. `owner_id`가 workspace id인 세션만 `workspace_id`를 채우고(채운 수는 migration NOTICE로 나온다), 나머지 actor 컬럼은 기존 행에서 비워 둔다.

멤버 목록은 owner나 admin의 cookie 세션으로 `GET /v1/members`다(`member.manage` 판정). 비활성 멤버도 포함해 오래된 membership부터 `limit`개씩(기본 50, 최대 100) 돌려준다. 응답 `next_cursor`를 다음 요청의 `cursor`로 넘기고, 마지막 페이지에서는 `null`이다. `q`(앞뒤 공백을 빼고 1–200자)는 이름이나 이메일에 그 글자가 들어 있는 멤버만 남긴다. 대소문자는 가리지 않고 `%`·`_`도 글자 그대로 찾는다. 길이를 벗어나거나 cursor가 틀리면 `400`이다.

각 행의 `administered_agents`는 그 멤버가 관리하는 에이전트다(보관된 에이전트는 빼고 이름순). 직접 관리자로 지정됐으면 `via: "user"`, 관리자로 지정된 팀의 구성원이라서 관리하면 `"team"`이다. 둘 다면 `"user"`로 한 번만 나온다. 보관된 팀과 이미 나간 팀은 세지 않는다. 비활성 멤버도 지정은 그대로 보이고, 되살리면 다시 효력이 생긴다. `last_active_at`은 웹 콘솔을 마지막으로 쓴 시각이다. 웹 로그인 때 기록하고, 그 뒤 웹 요청은 한 시간에 한 번까지만 갱신한다(그래서 최대 한 시간 늦다). API key 호출, Slack, 세션 활동은 세지 않는다. 웹에 로그인한 적이 없으면 `null`이다. 웹 세션이 만료되거나 로그아웃·폐기돼도 값은 남는다. 오래된 웹 세션 행은 그 사람이 다시 로그인할 때만 지워지고, 그 로그인이 더 새 값이 된다. 에이전트 관리자라도 `member.manage`가 없으면 이 목록은 `403`이다.

멤버를 내보내는 것은 owner나 admin의 cookie 세션으로 `POST /v1/members/{user_id}/disable`이다(`member.manage` 판정, member와 API key는 `403 FORBIDDEN`). 본문은 `{}` 또는 `{"reason": "…"}`(UTF-8 1KiB까지, 넘으면 `413`)이다. owner는 owner만 비활성으로 만들거나 되살린다. admin이 owner를 대상으로 하면 `403 OWNER_PROTECTED`이고 아무것도 바뀌지 않는다. 자기 자신과 마지막 live owner는 비활성으로 만들 수 없다(`409 LAST_OWNER`). 여러 규칙에 걸리면 앞의 것이 답한다: `member.manage`가 없으면 `403 FORBIDDEN`, 자기 자신이면 `409 LAST_OWNER`, 대상이 없으면 `404`, admin이 owner를 대상으로 하면 `403 OWNER_PROTECTED`, 마지막 live owner면 `409 LAST_OWNER`. 그래서 admin이 마지막 live owner를 비활성하면 `403 OWNER_PROTECTED`다. live owner인 호출자가 있는 한 마지막 live owner는 그 호출자 자신뿐이다. 한 transaction 안에서 membership을 비활성화하고, 그 사용자의 web session 전부와 그 workspace에서 만든 개인 key를 폐기하고, 그 workspace에 연결된 Slack 계정을 `revoked`로 바꾼다(열린 SSE는 keepalive 주기 안에 끊긴다). 에이전트 key는 건드리지 않는다. 그 사람이 요청한 닫히지 않은 세션에는 인수 대기 표시를 한다. 인수 대기 세션은 돌고 있던 turn까지만 마치고 다음 turn을 배정받지 않는다. 새 launch·claim도 받지 않고, 새 메시지는 `409 TAKEOVER_REQUIRED`로 거절된다. owner가 `GET /v1/takeovers`로 목록을 보고 `POST /v1/sessions/{id}/takeover`로 인수하면, 그 owner가 세션의 요청자가 되고 `takeover` receipt가 남는다. 세션이 인수하는 owner에게 보이지 않는 공유 범위면 `{"justification"}`이 필요하다(아래 세션 공유 범위 절).

`POST /v1/members/{user_id}/enable`은 membership을 되살린다. 폐기한 web session과 개인 key, 회수한 Slack 연결은 되살리지 않는다(Slack은 다시 연결한다). 사용자는 다시 로그인하고 key도 새로 받는다. 아직 아무도 인수하지 않은 세션은 인수 대기 표시를 지워 그 사람에게 돌려준다. Google로만 만든(비밀번호 없는) 계정도 이렇게 되살리면 연결된 Google 로그인으로 다시 들어온다. 이런 계정은 다시 초대하지 말고 enable한다. 초대 수락은 새 계정이거나 비밀번호로 확인한 계정만 받기 때문이다.

계정 정지는 `POST /v1/users/{user_id}/disable`·`/enable`이다. 대상의 live membership이 모두 호출한 사람이 owner나 admin인 workspace 안에 있을 때만 허용하고, 그 밖의 workspace에도 속한 계정은 `403 FORBIDDEN`이다. 대상이 owner인 workspace(그 membership이 비활성이어도) 중 하나에서라도 호출한 사람이 그 workspace의 live owner가 아니면 `403 OWNER_PROTECTED`이고, 이 판정이 앞의 `403 FORBIDDEN`보다 먼저다. 자기 자신을 정지하면 `409 LAST_OWNER`다. 정지된 계정은 어느 workspace로도 로그인하지 못하고, 정지할 때 멤버 비활성과 같은 폐기(web session, 모든 workspace의 개인 key와 Slack 연결, 인수 대기 표시)가 일어난다. 정지 해제도 cookie와 key를 되살리지 않는다.

네 동작은 모두 바뀐 경우에만 receipt를 남긴다(`disable_member`·`enable_member`·`disable_user`·`enable_user`). `target_ref`는 `{user_id, workspace_id}`, `actor`는 호출한 사람, `result`는 `reason`과 폐기·반환한 개수다. 이미 그 상태면 아무것도 쓰지 않고 응답의 `receipt_id`가 `null`이다. 외부 디렉터리(SCIM 등)와의 동기화는 없다. 사내 SSO에서 사람을 내보내도 여기에는 반영되지 않으므로 이 API를 따로 불러야 한다.

```bash
bun run keys create --workspace "$WORKSPACE_ID" --scopes sessions:read,sessions:write --personal "$USER_ID"
curl -s -b jar -X POST "http://127.0.0.1:3000/v1/members/$USER_ID/disable" -H 'X-Requested-With: werft-web' -H 'Content-Type: application/json' -d '{"reason":"left the team"}'
curl -s -b jar -X POST "http://127.0.0.1:3000/v1/members/$USER_ID/enable" -H 'X-Requested-With: werft-web' -H 'Content-Type: application/json' -d '{}'
curl -s -b jar http://127.0.0.1:3000/v1/takeovers
curl -s -b jar -X POST "http://127.0.0.1:3000/v1/sessions/$SESSION_ID/takeover" -H 'X-Requested-With: werft-web'
```

### Slack 계정 연결

웹에 로그인한 사람은 자기 Slack 계정을 Sign in with Slack(OpenID Connect)으로 연결한다. 연결은 `linked_accounts`에 `(provider, external_tenant, external_user_id) → user`로 남는다. Slack 쪽 입력은 처리 시점에 이 행을 다시 읽어 사람을 정한다. 연결·해제는 그 사람의 web session으로만 한다. API key는 개인 key라도 `403`이다(`account.link`, owner·admin·member).

| 변수 | 기본값 | 허용 범위 |
|---|---|---|
| `CONSOLE_ORIGIN` | 없음(연결을 끔. 시작 요청은 `503`. Slack 앱 생성도 꺼진다) | 절대 http(s) origin. 사람이 브라우저로 콘솔을 여는 공개 주소이고, 이 주소에서 모든 주소를 계산한다. Slack 연결의 redirect는 `<CONSOLE_ORIGIN>/settings/linked-accounts/slack`, 에이전트 앱의 redirect는 `<CONSOLE_ORIGIN>/agents/<agent_id>/slack/callback`이다. 설정 > 워크스페이스 > 연동 > Slack 화면이 이 주소들을 복사할 수 있게 보여 준다 |

`SLACK_OIDC_REDIRECT_URI`·`SLACK_OIDC_CLIENT_ID`·`SLACK_OIDC_CLIENT_SECRET`은 없어졌다. 옛 값이 남아 있으면 시작할 때 값 없이 경고만 남기고 무시한다(`CONSOLE_ORIGIN`이 없을 때만 옛 redirect의 origin을 이번 릴리스에 한해 쓴다). 지울 것과 되돌릴 때 남길 것은 `CHANGELOG.md`의 "운영자가 할 일"을 따른다.

연결에 쓰는 Slack 앱은 워크스페이스마다 하나인 계정 연결용 앱(link 앱, `slack_apps.kind=link`)뿐이다. env로 넣는 OIDC client는 없다. 요청마다 이렇게 정한다.

1. 상태가 `created`인 link 앱이 있으면 그 앱의 client id와, 서버가 저장소에 봉인한 client secret을 쓴다.
2. 없으면 연결 시작이 그 자리에서 link 앱을 만든다(워크스페이스의 App Configuration Token으로 `apps.manifest.create`). 자기 계정 연결을 시작할 수 있는 사람(member 포함)이면 누구의 시작이든 만든다. 동시에 여러 시작이 와도 앱은 하나다. 쓸 수 있는 config token이 없거나(`unset`·`needs_reentry`) API가 master key 없이 떴으면 `409 SLACK_LINK_NOT_CONFIGURED`이고, 화면은 "워크스페이스 관리자에게 연동 > Slack 설정을 요청하세요"를 보여 준다.

link 앱은 이름 "<워크스페이스 이름> 계정 연결"(Slack 한도 35자에 맞게 워크스페이스 이름을 자른다), 설명 "Werft 콘솔에서 Slack 계정을 연결합니다.", user scope `openid`·`profile`만 가진다. bot·bot scope·event 구독은 없고 redirect는 `<콘솔 origin>/settings/linked-accounts/slack`이다. 문구는 `packages/platform/src/musterrolle/slack-manifest.ts`의 `LINK_APP_COPY` 한 곳에 있다. config token을 저장할 때는 만들지 않는다. client secret·signing secret은 응답·로그·receipt에 나오지 않고, 그 앱의 per-app secret PUT은 `403`(`reason_code` `server_managed_secret`)이다. owner·admin이 `DELETE /v1/workspaces/{id}/slack/apps/{app_id}`로 지울 수 있고, 지운 뒤 다음 연결 시작이 새로 만든다.

연결 전에 미리 만들려면(운영자 CLI, 에이전트 앱 CLI와 같은 종료 코드. 아래 "Slack 비밀값과 master key"):

```bash
bun run apps/control-host/src/api/slack-app.ts create --kind link --workspace "$WORKSPACE_ID"
# {"outcome":"created","kind":"link","slack_app_id":"…","app_id":"A…","client_id":"…","redirect_url":"…/settings/linked-accounts/slack","created_by_token_user":"U…","warnings":[]}
```

다시 실행하면 `outcome: "exists"`로 같은 앱을 돌려준다. `4`는 워크스페이스가 없다는 뜻이다. 생성 응답이 유실돼 `6`(`SLACK_APP_CREATING`, `uncertain: true`)이면 api.slack.com/apps를 확인한 뒤 `--replace-uncertain`을 붙인다.

흐름은 다음과 같다.

1. `POST /v1/linked-accounts/slack/start`가 `authorize_url`을 돌려주고, state·nonce를 HttpOnly cookie `werft_slack_link`(path `/v1/linked-accounts/slack`, 10분)에 둔다. 워크스페이스에 확인된 Slack 설치(`slack_installations`)가 없으면 `409 SLACK_NOT_INSTALLED`다. 설치가 하나면 그 team을 `team` 파라미터로 고정한다. 위 순서로 OIDC 앱을 정하고, 필요하면 이때 link 앱을 만든다.
2. Slack이 그 앱의 redirect(`<CONSOLE_ORIGIN>/settings/linked-accounts/slack`)로 `code`·`state`를 붙여 돌려보낸다. 이 주소는 웹 화면이며, 화면이 둘을 `POST /v1/linked-accounts/slack/callback`에 `{code, state}`로 넘긴다. cookie는 이때 한 번 쓰고 지운다. 만료·불일치·IdP 거절은 모두 `400`(다시 시작 안내)이다.
3. API가 `code`를 id_token으로 바꾸고 서명(JWKS, RS256)·`iss`·`aud`·`nonce`를 검증한 뒤 `https://slack.com/team_id`·`https://slack.com/user_id`로 연결한다. 설치된 team이 아니면 `409 LINK_TEAM_MISMATCH`, 그 Slack 계정이 다른 사람에게 연결돼 있으면 `409 LINK_TAKEN`, 같은 team에 이미 내 연결이 있으면 `409 LINK_EXISTS`다. 성공하면 `201`과 `link_account` receipt가 남는다.
4. `GET /v1/linked-accounts`로 내 연결을 보고, `DELETE /v1/linked-accounts/{id}`로 해제한다(`unlink_account` receipt). 해제한 뒤에는 이미 대기 중인 입력도 처리 시점 재판정에서 거절된다. 목록 항목과 callback의 `linked_account`에 있는 `expires_at`은 provider 토큰의 만료 시각이다. 토큰을 보관하지 않거나 만료가 없으면 `null`이고, Slack 연결은 토큰을 보관하지 않으므로 늘 `null`이다. 1의 시작 응답에 있는 `expires_at`(연결 요청이 유효한 시각)과는 다른 값이다.

상태는 `active`·`stale`·`revoked`다. 해제와 오프보딩은 `revoked`(사유 `unlinked`·`offboarded`)로 바꾸고 `revision`을 올린다. Slack 비활성화 이벤트는 `stale`로 바꾼다(저장소 함수 `markStale`. 이벤트 수신은 Slack ingress가 붙인다). 같은 계정으로 다시 연결하면 `active`로 돌아오고 `revision`이 오른다. 대기 중인 입력의 `subject.linked_account`는 `{id, revision}`을 담는다. 재판정에서 행이 없거나 해제됐으면 `unlinked`, 오프보딩이면 `disabled`, `stale`이거나 revision이 다르면 `stale_link`로 거절한다. 사람 계정이 없는 Slack 사용자가 웹을 열면 `/v1/linked-accounts` 아래의 `401`이 "웹에 로그인한 뒤… owner·admin에게 초대를 요청하세요"를 안내한다.

Enterprise Grid: id_token의 `https://slack.com/team_id`가 workspace id인지 org id인지는 실제 Grid 설치로만 확인할 수 있다. 지금은 workspace id로 보고 `slack_installations.team_id`와 비교한다. Grid에서 org id가 오면 `LINK_TEAM_MISMATCH`로 거절된다(안전한 쪽). 아래 확인 순서 6에서 판정한다.

**실제 Slack으로 확인하는 절차** (사람이 한다. 자동 테스트와 로컬 확인은 mock IdP를 쓴다)

0. 콘솔을 https origin 하나로 연다. Slack은 https redirect URI만 받고, `werft_slack_link` cookie는 `Secure`라 시작(`/v1/linked-accounts/slack/start`)과 callback이 같은 https origin에서 불려야 cookie가 따라간다. 로컬 스택이면 API 포트를 tailnet 안에만 https로 내보낸다: `tailscale serve --bg --https=<port> http://127.0.0.1:<API_PORT>` → `<CONSOLE_URL>` = `https://<host>.ts.net:<port>`. 웹 콘솔은 API와 같은 origin에서 나오므로 이 주소 하나로 로그인·연결·callback이 모두 된다. funnel(인터넷 공개)은 쓰지 않는다. 끝나면 `tailscale serve --https=<port> off`. 콘솔의 POST는 `Origin`과 `Host`가 같아야 통과하므로(`auth.ts` `browserRequestViolation`), 앞단 프록시는 원래 `Host`를 그대로 넘겨야 한다.
1. 그 Slack 워크스페이스에 설치된 Slack 앱이 있어야 한다(설치 등록은 4). 설치 등록이 bot을 확인하므로 bot scope `users:read`가 있어야 한다. 계정 연결용 앱은 손으로 만들지 않는다. owner·admin이 설정 > 워크스페이스 > 연동 > Slack에 App Configuration Token을 넣어 두면 5의 첫 "Slack 연결"이 link 앱을 만든다. 미리 만들려면 위 CLI `--kind link`를 쓴다.
2. 손으로 만든 OIDC 앱은 더 쓰지 않는다. 연결은 link 앱으로만 한다. 설정 > 워크스페이스 > 연동 > Slack에서 App Configuration Token을 넣으면 첫 "Slack 연결"이 link 앱을 만든다.
3. `CONSOLE_ORIGIN=<CONSOLE_URL>` 한 줄을 repo 밖 파일 `~/.config/werft/slack-dev.env`(권한 `0600`)에 둔다. 띄우는 셸에서 `set -a; . ~/.config/werft/slack-dev.env; set +a`로 읽은 뒤 `scripts/local.sh up`(이미 떠 있으면 `docker compose --profile apps up -d --no-deps --force-recreate api`)을 실행한다. `SLACK_OIDC_ISSUER`·`SLACK_API_URL`은 비워 둔다(mock 시험 전용). mock overlay는 겹치지 않는다.
4. 설치를 등록한다. **OAuth & Permissions**의 Bot User OAuth Token을 셸 env `SLACK_BOT_TOKEN`에만 넣고(인자로 넘기지 않는다), **Basic Information**의 App ID로 CLI를 실행한다. CLI가 `auth.test`·`bots.info`로 team·bot 사용자·앱을 확인하고 `slack_installations`에 `verified` 행을 남긴다. 출력은 JSON 한 줄이고 token은 어디에도 쓰지 않는다.

   ```bash
   read -rs SLACK_BOT_TOKEN && export SLACK_BOT_TOKEN
   # The root script runs the CLI in the compose api container; -e passes only the variable's name.
   bun run slack-install register --workspace "$WORKSPACE_ID" --app-id <APP_ID>
   unset SLACK_BOT_TOKEN
   ```

   | 종료 코드 | 뜻 |
   |---|---|
   | `0` | `verified`. 다시 실행하면 같은 행을 다시 확인한다(`registration: existing`) |
   | `2` | 인자·env가 잘못됐다(`SLACK_BOT_TOKEN`·`DATABASE_URL` 없음) |
   | `3` | `slack_auth_failed`: token 거절(`invalid_auth` 등), bot token이 아님, Slack 불통, Slack id 모양이 아님 |
   | `4` | `workspace_conflict`: 그 앱·team이 다른 워크스페이스의 것이다(거기서 해제됐어도 같다) |
   | `5` | `revoked`: 등록과 확인 사이에 해제됐다. 다시 실행하면 같은 행을 다시 연다 |
   | `6` | `workspace_not_found`: `--workspace`의 워크스페이스가 없다 |
   | `7` | `app_mismatch`: token이 `--app-id`와 다른 앱의 것이다(`bots.info`로 대조) |
   | `1` | 그 밖의 오류(DB 등) |

   `4`에서 그 행이 다른 워크스페이스에서 해제(`revoked`)된 것이면 메시지가 그렇게 말한다. 해제된 행도 원래 워크스페이스만 다시 등록할 수 있다. Kubernetes에는 아직 `:k8s` 스크립트가 없다. `kubectl exec -it <api pod> -c api -- bash`로 들어가(`sh`는 `read -s`가 없다) 그 안에서 `read -rs SLACK_BOT_TOKEN`으로 넣고 `bun run apps/control-host/src/api/slack-install.ts register …`를 실행한다. token을 `kubectl` 인자(`env SLACK_BOT_TOKEN=…` 등)에 쓰지 않는다.
   설치가 `verified`가 되면 그 앱을 에이전트에 연결한다: 에이전트를 만든 뒤 `POST /v1/agents/{id}/identities`(`provider: slack_bot`, `app_id`, `team_id`, bot token의 `credential_ref`)를 보낸다(아래 "에이전트의 Slack 앱 연결"). 연결이 없으면 그 앱으로 온 이벤트는 `unidentified`로 버려진다. 계정 연결(5)에는 필요 없다.
5. owner로 `<CONSOLE_URL>`에 로그인하고 **연동 계정** 화면에서 Slack 연결 → Slack 동의 → 콜백 순으로 연결한다. `GET /v1/linked-accounts`에 `active` 행(`external_tenant` = 그 team id)과 `link_account` receipt가 보이는지 확인한다.
6. 다른 워크스페이스 계정으로 시도해 `LINK_TEAM_MISMATCH`, 다른 웹 사용자로 같은 Slack 계정을 시도해 `LINK_TAKEN`을 확인한다. Grid 설치라면 연결이 되는지 보고, 됐으면 `linked_accounts.external_tenant`를 `slack_installations.team_id`와 비교해 P5를 판정한다. `LINK_TEAM_MISMATCH`로 거절되면 id_token의 team이 org id라는 뜻이다.
7. 해제한 뒤 `GET /v1/linked-accounts`가 비고 `unlink_account` receipt가 남는지, 연결한 멤버를 `POST /v1/members/{user_id}/disable`로 비활성화하면 receipt `result.revoked_linked_accounts`가 1이고 목록에서 사라지는지 확인한다.

```bash
# Secure cookies only travel over https: use the console origin from step 0.
curl -s -b jar -c jar -X POST "$CONSOLE_URL/v1/linked-accounts/slack/start" -H 'X-Requested-With: werft-web'
curl -s -b jar -c jar -X POST "$CONSOLE_URL/v1/linked-accounts/slack/callback" \
  -H 'X-Requested-With: werft-web' -H 'Content-Type: application/json' -d '{"code":"<code>","state":"<state>"}'
curl -s -b jar "$CONSOLE_URL/v1/linked-accounts"
curl -s -b jar -X DELETE "$CONSOLE_URL/v1/linked-accounts/$LINKED_ACCOUNT_ID" -H 'X-Requested-With: werft-web'
```

로컬에서는 `infra/compose.mock-slack.yml`을 겹쳐 띄우면 Slack 앱 없이 같은 흐름을 돌릴 수 있다. overlay는 `CONSOLE_ORIGIN=http://127.0.0.1:3000`과, mock 시험 전용인 `SLACK_OIDC_ISSUER`·`SLACK_API_URL`을 api에 준다. `POST http://mock-slack:4020/fake/config-tokens`로 받은 token을 owner가 `PUT /v1/workspaces/{id}/slack/config-token`으로 넣은 뒤의 첫 연결 시작이 Web API 가짜로 link 앱을 만든다(master key가 있어야 한다). mock IdP는 그 앱의 client를 받는다. mock은 동의를 자동으로 하고 `MOCK_SLACK_TEAM_ID`·`MOCK_SLACK_USER_ID`(기본 `T0MOCK`·`U0MOCK`)를 돌려준다. `authorize_url`에 `mock_team`·`mock_user`를 붙이면 그 계정을 돌려준다. `MOCK_SLACK_TEAM_NAME`·`MOCK_SLACK_USER_NAME`(기본 빈 값)을 주면 id_token에 워크스페이스 이름(`https://slack.com/team_name`)과 표시 이름(`name`)을 싣고, `authorize_url`의 `mock_team_name`·`mock_user_name`이 그 값을 바꾼다(빈 값이면 이름 없음). 설치 등록 CLI가 부르는 `auth.test`·`bots.info`도 답한다: bot token `mock-bot-token`이면 team `MOCK_SLACK_TEAM_ID`, app `A0MOCK`, bot 사용자 `U0MOCKBOT`. 그때는 `SLACK_API_URL=http://mock-slack:4020/api`로 CLI를 실행한다. 실제 배포에는 절대 겹치지 않는다. API가 mock이 서명한 것을 믿게 된다.

### 역할, 에이전트 관리자, 권한별 API key

workspace 역할은 owner·admin·member 셋이다. admin은 owner와 같은 관리 권한을 갖되 세 가지가 다르다: 감사 보존 기간을 바꾸지 못하고, 보관한 에이전트를 되살리지 못하고, 세션 복구 결정(`sessions:recover`)을 하지 못한다. admin은 owner를 초대하거나 owner의 역할을 바꾸거나 누구를 owner로 올리지 못하고, owner를 비활성화·정지하거나 되살리지도 못한다(`403 OWNER_PROTECTED`).

에이전트 관리자는 `agent_admins`의 행이다. 에이전트를 만든 사람이 그 에이전트의 관리자가 된다. 0142 migration은 기존 에이전트의 `created_by`가 아직 그 workspace의 멤버이면 그 사람을 관리자로 채운다. 에이전트 관리자는 member여도 그 에이전트의 정의 수정·release·활성화·보관, 자격 참조 연결, 관리자 지정, Slack 설정, 그 에이전트의 에이전트 key 발급을 할 수 있다. 다른 에이전트와 workspace 전체 목록은 못 한다. 관리자 지정·해제와 팀을 관리자로 두는 방법은 아래 "팀과 에이전트 관리자 지정"에 있다.

key는 웹(cookie 세션)에서 `POST /v1/api-keys`로 발급한다.

| key | 누가 발급 | 무엇을 하나 |
|---|---|---|
| 개인 key (`kind: personal`) | 모든 멤버, 자기 것만 | 만든 사람의 지금 역할 안에서 그 사람으로 동작한다. 그 사람이 비활성화되면 `401` |
| 에이전트 key (`kind: agent` + `agent_id`) | owner·admin·그 에이전트 관리자 | key 자체로 동작하고 그 에이전트의 세션 생성·조회만 한다. 발급자가 떠나도 계속 동작한다. `sessions:approve`를 넣으면 그 에이전트의 세션에서 승인한다. 자기가 시작한 세션은 빼고 |

에이전트 없는 key(workspace 전체에 닿는 key)는 없다. `agent_id` 없는 `kind: agent`는 `400 BAD_REQUEST`다. 둘 다 `name`(앞뒤 공백을 뺀 1~64자, 필수 아님)을 받는다. 0163 migration은 기존 `service` key 가운데 `agent_id`가 있는 것은 `agent`로, workspace 밖 운영자 key는 `operator`로 바꾸고, workspace 전체 key(그리고 owner가 workspace id인 운영자 key)는 그 key가 만든 세션의 `created_by_api_key_id`를 비운 뒤 지운다. 지운 개수는 migration NOTICE로 나온다.

- 요청한 `scopes`가 발급자의 지금 scope를 넘으면 `403 SCOPE_NOT_GRANTABLE`이다. admin은 `sessions:recover`가 든 key를 만들 수 없다. 그 안에서는 개인 key와 에이전트 key가 같은 scope를 고른다(`sessions:approve` 포함). 이미 발급한 key의 scope는 바뀌지 않는다.
- 권한이 없으면 `403 FORBIDDEN`이고 `error.details.reason_code`에 판정 이유(`role`, `agent_ceiling` 등)가 있다.
- 에이전트 key로 세션을 만들려면 `POST /v1/sessions`에 그 에이전트의 `agent_release_id`를 넣는다. `profile_id`는 빼면 그 release의 프로필이고, 보내면 그 프로필이어야 한다(`409 RELEASE_PROFILE_MISMATCH`). `repository_id`를 빼면 GitHub 설정 행이 있는 에이전트는 저장소 없이 시작하고, 행이 없는 에이전트는 release의 `repository_id`로 시작한다(아래 "새 세션의 시작 저장소" 절). release의 프로필이 카탈로그에서 빠졌거나 release 뒤에 바뀌었으면 `409 PROFILE_DIGEST_MISMATCH`다. 에이전트가 일시중지·보관 상태이면 `409 AGENT_NOT_RUNNABLE`(`error.details.reason_code: agent_inactive`)이고, release가 한 번도 승인(활성화)되지 않았으면 같은 코드에 `reason_code: release_unapproved`다. 승인은 그 release의 `approved_at`이 정한다. 그래서 지금 활성이 아니어도 승인된 이전 release에 묶은 세션은 에이전트가 활성인 동안 그대로 시작한다. 이미 만들어진 세션을 다시 여는 요청은 이 검사를 받지 않는다. Slack에서 온 입력도 같은 검사를 받아 거절되고, 사용자에게는 일반 실패 안내가 가며 코드와 `reason_code`는 로그에 남는다. release를 넣지 않은 세션이나 다른 에이전트의 세션은 `403`(`agent_ceiling`)이다. 세션 목록과 receipt 조회도 에이전트를 가리지 못해 `403`이다. 실행은 아직 `profile_id`를 따르고, release의 지시문과 도구 정책은 세션에 고정만 된다.
- 목록(`GET /v1/api-keys`)은 자기 개인 key와 자기가 관리하는 에이전트의 key만 보인다. 비밀값은 발급 응답에서 한 번만 나온다.
- 폐기는 `DELETE /v1/api-keys/{id}`이고 발급과 같은 권한이 든다. 남의 개인 key는 `404`다. 이미 폐기한 key는 아무것도 바꾸지 않고 `receipt_id: null`을 돌려준다.
- 발급·폐기는 `create_api_key`·`revoke_api_key` receipt와 `api_key.manage`·`api_key.manage_own` 판정 행을 남긴다. receipt에는 key의 종류·에이전트·scope만 있고 비밀값은 없다.

```bash
curl -s -b jar -X POST http://127.0.0.1:3000/v1/api-keys \
  -H 'X-Requested-With: werft-web' -H 'Content-Type: application/json' \
  -d '{"kind":"agent","agent_id":"<agent_id>","name":"ci-deploy","scopes":["sessions:read","sessions:write"]}'
```

운영자 CLI(`keys create`)는 그대로 있고 이 판정을 거치지 않는다. 운영자가 쓰는 길이다.

### 팀과 에이전트 관리자 지정

팀은 workspace 안의 사람 묶음이다(`member_teams`, 구성원은 `member_team_members`). 팀을 에이전트 관리자로 지정하면(`agent_admin_teams`) 그 팀 구성원 모두가 그 에이전트의 관리자다. 팀(부서) 배치와는 별개이고 배치는 접근에 쓰이지 않는다.

- 팀을 만들고, 이름을 바꾸고, 지우고, 구성원을 넣고 빼는 것은 owner·admin만 한다(`team.manage`). 에이전트 관리자와 팀 구성원도 못 한다(`403`, `reason_code: role`). 팀 목록·상세도 같은 권한이다.
- 구성원 추가는 초대가 아니다. 수락 없이 바로 구성원이 된다. 비활성 멤버는 넣을 수 없다(`404`). 추가·제거마다 그 사람을 대상(`target_ref.user_id`)으로 한 `add_team_member`·`remove_team_member` receipt가 남고 `result`에 팀 id와 이름이 있다. 지금은 이 receipt가 추가 알림의 기록이고, 화면·Slack 알림은 아직 없다.
- 구성원은 판정 때마다 읽는다. 팀에서 빠지거나 팀이 지워지면 그 팀으로 얻은 관리 권한이 다음 요청부터 `403`이다. 비활성 멤버는 팀에 있어도 아무 권한이 없다. 다만 비활성화는 팀 구성원 자격과 에이전트 관리자 지정을 지우지 않으므로, 다시 초대해 활성화하면 그 권한이 그대로 돌아온다. 돌려주지 않으려면 비활성화할 때 팀에서도 빼고 관리자 지정도 해제한다. 팀을 지우면 그 팀의 에이전트 관리자 지정도 함께 지워진다.
- 에이전트 관리자 지정·해제는 owner·admin과 그 에이전트의 관리자가 한다(`agent.admin.manage`). 사람이나 팀 하나를 고른다. 관리자 팀은 구성원 모두를 관리자로 만들므로, 팀을 새로 넣는 것은 `team.manage`를 가진 owner·admin만 한다. 에이전트 관리자(member)가 팀을 넣으면 `403`(`reason_code: role`)이고, 팀을 빼는 것과 사람을 넣고 빼는 것은 그대로 에이전트 관리자도 한다. 판정 뒤 역할이 내려갔다면 쓰는 트랜잭션이 다시 읽어 거절한다. 그래도 그 에이전트의 관리자이면 `403`(`reason_code: team_not_allowed`), 아니면 `403`(`reason_code: role`)이다. 이미 들어가 있는 관리자 팀은 그대로 남는다.
- 팀 구성원에는 역할(`lead`·`member`)이 있다. 처음 넣으면 `member`이고, owner·admin이 `PATCH /v1/teams/{team_id}/members/{user_id}` `{"role"}`로 바꾼다. 바꿀 때마다 `set_team_member_role` receipt가 남는다. `GET /v1/my-teams`는 팀마다 내 `role`을 함께 준다.
- 에이전트에는 담당 팀(`managing_team_id`)이 하나 있다. 담당 팀의 `lead`는 그 에이전트의 관리자다. 담당 팀의 `member`는 관리 권한이 없고 설정을 읽기만 한다(아래). 담당 팀은 비울 수 없고 바꾸기만 한다(`PUT …/managing-team`). 열은 `NOT NULL`이다(0243). 담당 팀을 필수로 받기 전에 만든 에이전트는 마이그레이션이 채웠다. 담당 팀이 없던 에이전트는 모두 워크스페이스마다 하나씩 만든 구성원 없는 `Unassigned agents` 팀(`created_by` 없음)이 맡았다. 관리자 팀은 소유 조직의 근거가 아니라서 쓰지 않는다. 되돌릴 때 이 팀 하나가 이행 대상 목록이다. 이름이 겹치면 `Unassigned agents (<8자리 id>)`다. 이름은 영어 하나로 고정되어 있으니, 소유자·관리자는 팀 목록에서 이 이름으로 찾아 이름을 바꾸고 에이전트를 맞는 팀으로 옮긴다(`PUT …/managing-team`). 새로 얻는 구성원이나 `lead`가 없으므로 이 단계에서 아무도 권한을 더 얻지 않는다. 이 팀에는 `member_teams.holds_unassigned`가 켜져 있어, 그 에이전트들의 `workspace` 세션은 축 B가 `managing_team`이어도 이전처럼 멤버 모두에게 보인다. 에이전트를 다른 팀으로 옮기면 그 순간부터 그 팀의 규칙이 적용된다. 이 플래그는 마이그레이션만 켜고 API로는 바꾸지 못한다. 보관 팀에 구성원을 넣으면 `member`는 그 에이전트들의 설정을 읽고 사용할 수 있게 되고 `lead`는 설정을 바꾸는 관리까지 하게 되니, 에이전트를 옮기기 전에는 넣지 않는다. 이름을 바꾸거나 구성원을 넣어도 플래그는 그대로다.
- 에이전트 읽기는 두 단계다. **정보**(이름·slug·설명·담당 팀 id와 이름·상태·활성 릴리스 id, `GET /v1/agents`의 행)는 workspace의 모든 멤버가 읽는다(`agent.read`). 담당 팀 이름(`managing_team_name`)은 그 팀을 읽지 못하는 멤버에게도 행과 함께 간다. `GET /v1/agents`와 `GET /v1/agents/counts`는 행마다 이 판정으로 거른다. 담당 팀이 없는 에이전트는 없으므로 `managing_team=unassigned` 필터와 개수의 `unassigned`는 없다(쿼리는 엄격하지 않아 `managing_team` 값을 보내도 무시되고 전체가 온다). **설정**(카드·버전·릴리스, 관리자, 자격 증명 연결, GitHub, Slack 연결·앱·identity)은 owner·admin, 그 에이전트의 관리자, 담당 팀의 살아 있는 구성원만 읽는다(`agent.settings_read`). `GET /v1/agents/{id}`와 설정 조회가 여기에 든다. 그 밖의 멤버는 `403`(`reason_code: role`)이고, 그 에이전트는 목록의 `ids`로 행만 읽는다. `include=summary`의 요약은 설정을 읽을 수 있는 에이전트에만 붙는다. 설정을 바꾸는 요청은 지금처럼 owner·admin과 관리자만 한다. Slack 채널 이름 조회·검색(`…/slack-channels`, `…/slack/channels`)과 GitHub 저장소 후보(`…/github/repositories`)는 연결·고르기에 쓰는 것이라 바꾸는 사람만 쓴다. 허용된 읽기는 `authz_decisions`에 남지 않고 거절만 남는다.
- 에이전트 설정을 바꾼 receipt(`target_ref.resource`가 그 에이전트이거나 그 Slack 연결)는 설정을 읽을 수 있는 사람과 그 사람의 개인 key만 `GET /v1/receipts/{id}`로 읽는다. 자격 증명이 연결되지 않아 거절된 세션 시작(`create_session`)의 receipt는 지금처럼 workspace의 누구나 읽는다.
- 담당 팀은 만들 때(`POST /v1/agents`의 `managing_team_id`) 꼭 넣는다. 빠지면 `400 BAD_REQUEST`이고 `details.issues`에 `path: managing_team_id`, `message: managing_team_id is required`가 있다. 그래서 속한 팀이 없는 member는 에이전트를 만들지 못한다. 이 필드 없이 만들던 API 호출(SDK·스크립트)은 이 이미지부터 실패한다. 롤백 하한은 이 마이그레이션(0243)이다. 담당 팀을 이미 필수로 받던 직전 이미지로 내리면 생성은 계속 되지만 `holds_unassigned`를 모르므로, 보관 팀 에이전트의 `workspace` 세션이 축 B(`managing_team`)에서 바깥 멤버에게 다시 숨겨진다. 담당 팀 없이 INSERT하던 더 오래된 이미지는 `NOT NULL` 위반으로 생성이 실패한다(500). 그 아래로 내리려면 쓰기를 멈추고 `managing_team_id`의 `NOT NULL`을 풀어야 하며, 풀어도 백필과 이전 가시성은 되돌려지지 않는다. 보관 팀은 새로 담당 팀으로 고를 수 없다(`403`, `reason_code: team_holding`, 만들 때도 같다). 에이전트가 이미 거기 있는 채로 같은 팀을 다시 보내는 요청만 `unchanged`다. 담당 팀은 `PUT /v1/agents/{id}/managing-team` `{"team_id"}`로 바꾼다. 바꾸는 것은 owner·admin과 그 에이전트의 관리자다. owner·admin은 살아 있는 팀 아무것이나, 그 밖의 사람은 자기가 속한 팀만 고른다(아니면 `403`, `reason_code: team_not_allowed`). 담당 팀을 비우는 요청은 없다. 바꿀 때마다 `set_agent_managing_team` receipt가 남고 `result`에 바꾸기 전후 팀 id가 있다.
- 보관되지 않은 에이전트의 담당 팀인 팀은 지울 수 없다(`409 TEAM_MANAGES_AGENTS`, `details.agent_ids`). 먼저 그 에이전트들의 담당 팀을 옮기거나 에이전트를 보관한다.
- 담당 팀을 옮기거나 `lead`를 `member`로 내리면, 그 권한으로 진행 중이던 에이전트 설정 쓰기(수정·릴리스·켜기, GitHub 켜기, 저장소 고르기)도 저장 직전에 다시 판정되어 `403`(`reason_code: role`)으로 끝난다.
- 에이전트 관리자는 `GET /v1/administered-agents`로 자기가 지금 관리하는 에이전트(직접 지정과 팀 경유)를 본다. 여기서 얻은 `agent_id`로 그 에이전트의 에이전트 key를 발급한다.

| 요청 | 하는 일 |
|---|---|
| `POST /v1/teams` `{"name"}` | 팀 만들기. 살아 있는 팀 이름이 겹치면 `409 ALREADY_EXISTS` |
| `GET /v1/teams`, `GET /v1/teams/{team_id}` | 목록, 구성원을 포함한 상세 |
| `PATCH /v1/teams/{team_id}` `{"name"}` | 이름 변경 |
| `DELETE /v1/teams/{team_id}` | 팀 삭제. 담당하는 에이전트가 있으면 `409 TEAM_MANAGES_AGENTS` |
| `POST /v1/teams/{team_id}/members` `{"user_id"}` | 구성원 추가 |
| `PATCH /v1/teams/{team_id}/members/{user_id}` `{"role"}` | 구성원 역할 변경(`lead`·`member`) |
| `DELETE /v1/teams/{team_id}/members/{user_id}` | 구성원 제거 |
| `PUT /v1/agents/{id}/managing-team` `{"team_id"}` | 담당 팀 지정·변경 |
| `GET /v1/agents/{id}/usage`, `PUT /v1/agents/{id}/usage` `{"scope","teams":[{"id"}]}` | 에이전트를 쓸 수 있는 범위. `workspace`는 워크스페이스 전원, `private`은 나열한 팀의 구성원. PUT은 전체 교체이고 `If-Match: <revision>`이 필수다(어긋나면 `412 VERSION_MISMATCH`, 없으면 `428 PRECONDITION_REQUIRED`) |
| `GET /v1/agents/{id}/admins` | 에이전트의 관리자(사람·팀) |
| `POST /v1/agents/{id}/admins` `{"user_id"}` 또는 `{"team_id"}` | 관리자 지정 |
| `DELETE /v1/agents/{id}/admins/users/{user_id}`, `…/admins/teams/{team_id}` | 관리자 해제 |
| `GET /v1/administered-agents` | 내가 관리하는 에이전트 |

바꾼 것이 없으면(이미 구성원, 이미 관리자, 같은 이름, 같은 역할, 같은 담당 팀, 같은 사용 범위) `receipt_id`가 `null`이다. 판정은 `team.manage`·`agent.admin.manage`·`agent.usage.manage` 행으로 `authz_decisions`에 남는다.

사용 범위(`agent_usage`, 마이그레이션 0265)는 이 단계에서 세션 동작을 바꾸지 않는다. 설정과 편집 API만 있고, 세션을 만들거나 입력할 때 읽는 판정은 뒤 단계다.

- 마이그레이션이 기존 에이전트마다 `scope = workspace` 한 행을 넣고, `POST /v1/agents`도 같은 트랜잭션에서 넣는다. `limits_revision`은 호출자 한도(뒤 단계)가 쓰며 이 API는 읽지도 올리지도 않는다.
- `agent.usage.manage`는 owner·admin과 그 에이전트의 관리자(사람만, API key는 403)다. 읽기도 같은 사람만 한다(담당 팀의 일반 구성원은 설정은 읽어도 누가 쓰는지는 읽지 못한다).
- `private`은 팀이 1개 이상이고 `workspace`는 팀이 없다(아니면 `400`). 팀을 새로 넣는 사람은 owner·admin이거나 그 팀의 구성원이어야 한다(아니면 `403`, `reason_code: team_not_allowed`). 빼기, 이미 있는 팀을 유지하기는 `agent.usage.manage`면 된다.
- 팀을 삭제하면 그 팀을 나열한 모든 에이전트에서 팀이 빠지고 그 에이전트들의 `revision`이 오른다. 팀이 모두 빠진 `private` 에이전트는 `private`인 채로 남고, 에이전트를 관리하는 사람 말고는 쓸 수 없는 상태가 된다. 삭제와 겹치는 PUT 때문에 삭제가 3번 시도해도 정리되지 않으면 `409 REVISION_CONFLICT`이고 아무것도 쓰지 않으니 다시 보낸다.
- 롤백 하한은 0265다. 이전 이미지로 내리면 새 에이전트에 행이 생기지 않지만 이 단계에서는 어떤 판정도 행을 읽지 않는다. 두 테이블은 남는다.

```bash
curl -s -b jar -X POST http://127.0.0.1:3000/v1/teams \
  -H 'X-Requested-With: werft-web' -H 'Content-Type: application/json' -d '{"name":"리서치봇 관리팀"}'
curl -s -b jar -X POST "http://127.0.0.1:3000/v1/teams/$TEAM_ID/members" \
  -H 'X-Requested-With: werft-web' -H 'Content-Type: application/json' -d "{\"user_id\":\"$USER_ID\"}"
curl -s -b jar -X POST "http://127.0.0.1:3000/v1/agents/$AGENT_ID/admins" \
  -H 'X-Requested-With: werft-web' -H 'Content-Type: application/json' -d "{\"team_id\":\"$TEAM_ID\"}"
```

### 세션 공유 범위와 감사 열람

세션마다 누가 보는지(공유 범위)가 있다. 범위는 넷이다.

| 범위 | 보는 사람 |
|---|---|
| `private` | 만든 사람만 |
| `people` | 만든 사람과 지정한 멤버 |
| `team` | 만든 사람과 지정한 팀의 지금 구성원 |
| `workspace` | workspace 멤버 모두(기본값). 단 축 B가 `managing_team`이면 에이전트의 안쪽만(0243이 만든 보관 팀의 에이전트는 예외로 멤버 모두) |

- "안쪽"은 그 에이전트의 owner·admin, 에이전트 관리자(개인 관리자, 관리자 팀 구성원, 담당 팀 `lead`), 담당 팀 구성원이다. 나머지 멤버가 바깥쪽이다.
- 판정 순서는 workspace 일치 → 공유 범위 → key scope → agent_id → (`session.approve`·`session.rename`만) 답할 사람인가다. 범위 밖이면 owner·admin도 목록·검색(`?status=`)·상세·turn·SSE·usage·pending·receipt·메시지·응답·이름 바꾸기·interrupt·종료 어디서나 `404`다. 있는지조차 알리지 않는다.
- 팀 범위는 판정 때마다 지금 구성원을 읽는다. 팀에서 빠지거나 팀이 지워지면 다음 요청부터 `404`다.
- 에이전트 key는 멤버가 아니다. 그 에이전트의 세션 가운데 `workspace` 범위인 것과 자기가 만든 것만 본다. key가 만든 세션에서는 그 key가 만든 사람 자리에 선다. 축 B에서는 자기 에이전트의 안쪽이다.
- 범위를 좁히면 그 세션의 열린 SSE가 바로 깨어나 다시 판정되고, 더는 볼 수 없는 연결은 끊긴다(로그 `SSE stream closed`, `reason: not_visible`). 다시 연결하면 `404`다.
- 아직 한 번도 바꾸지 않은 세션은 `session_shares` 행 없이 `workspace`로 읽힌다(`revision` 0).

### 에이전트 접근 설정(축 A·B)

워크스페이스 설정 두 키가 담당 팀 밖 멤버(바깥쪽)가 에이전트와 그 세션에 닿는 범위를 정한다. owner·admin이 `PATCH /v1/workspaces/{id}/agent-access`로 바꾸고, 지금 값은 `GET /v1/auth/me`의 `workspace.settings`에 있다. 키가 저장되지 않았으면 기본값이다.

| 축 | 키 | 값 | 기본값 |
|---|---|---|---|
| A. 바깥쪽의 에이전트 접근 | `agent_outsider_access` | `use`: 정보를 보고 세션을 시작한다 / `view`: 정보만 본다(시작은 `403`, `reason_code: role`) / `none`: 목록에서 빠지고 읽기는 `404`, 시작은 `403` | `use` |
| B. `workspace` 범위 세션이 바깥쪽에 보이는가 | `agent_outsider_session_visibility` | `managing_team`: 안쪽에만 / `workspace`: 멤버 모두 | `managing_team` |

- 축 A는 모든 에이전트에 적용한다. 웹·API·Slack 세션 시작이 같은 판정을 거치고, 세션을 만드는 쓰기도 같은 트랜잭션에서 워크스페이스 행과 에이전트·팀·구성원 행을 잠근 채 다시 본다. 이미 있는 세션에 메시지를 보내는 것은 축 A를 보지 않는다.
- 축 B는 모든 에이전트의 세션에 적용한다. 목록·개수·상세·SSE·메시지·승인 쓰기의 재확인·사용량 최근 성과·도구 호출 목록이 같은 판정을 쓴다. 자기 세션(지금 그 세션을 가진 사람)과 `people`·`team` 공유는 그대로 닿는다. 사용량 최근 성과는 볼 수 없는 세션의 행을 통째로 빼고, 합계 수치는 그대로 센다.
- 판정 시점의 상한이라 공유 행을 쓰지 않는다. 담당 팀을 정하거나 바꾸는 순간, 설정을 바꾸는 순간, 팀 구성원이 빠지는 순간 기존 세션에도 다음 요청부터 적용된다. 열린 SSE는 다음 페이지를 읽을 때 다시 판정해 끊는다.
- `GET /v1/sessions/{id}/share`의 `audience_limited`는 이 세션을 `workspace`로 두면 안쪽에만 닿는지(축 B가 `managing_team`이고 보관 팀의 에이전트가 아님)를 지금 범위와 상관없이 알려 준다.
- 바꾼 키가 있을 때만 `set_agent_access_settings` receipt(`result.from`·`result.to`, 바뀐 키만)를 남기고, 없으면 `receipt_id`가 `null`이다.
- 사람이 없는 key(에이전트에 묶이지 않은 key)는 어느 에이전트의 안쪽도 아니다.
- 이 설정이 들어간 이미지는 롤백 하한이다. 그 아래로 롤백하면 축 B로 숨긴 세션이 바깥쪽에 다시 보이고 축 A가 사라진다. 이 설정을 한 번이라도 저장한 워크스페이스는 하한 아래 이미지의 `GET /v1/auth/me`가 응답 검증에서 실패한다.
- Slack 채널 세션의 답은 축 B와 상관없이 채널 스레드에 올라간다. 에이전트를 채널에 연결하는 것을 그 채널에 답을 보이겠다는 결정으로 본다.

```bash
curl -s -b jar -X PATCH "http://127.0.0.1:3000/v1/workspaces/$WORKSPACE_ID/agent-access" \
  -H 'X-Requested-With: werft-web' -H 'Content-Type: application/json' \
  -d '{"agent_outsider_access":"view"}'
```

보는 것과 대신 답하는 것은 다르다. 권한 요청·질문에 답하고 push·PR을 결정하는 것(`session.approve`)은 세션을 볼 수 있는 사람 가운데 만든 사람, 그 에이전트의 관리자, owner·admin, 그리고 `sessions:approve`를 가진 그 에이전트의 key만 한다. 어떤 key도 그 key가 시작한 세션은 승인하지 못한다(`403`, `reason_code: self_approval`, 실패 receipt). 같은 사람이 웹이나 다른 key로 승인하는 것은 막지 않는다. 공유로 보기만 하는 사람(member)은 `403`(`reason_code: role`, "holds sessions:approve but may not use it on this session")이고 요청은 열린 채 세션은 `needs_input`에 머문다. 볼 수 없는 사람은 지금처럼 `404`다. 개인 key는 만든 사람으로, 그 사람의 지금 역할로 판정한다. workspace가 없는 호출자(legacy key, `AUTH_MODE=none`)는 곁에 대신 답할 멤버가 없으므로 지금처럼 답한다. `GET /v1/sessions/{id}/pending-requests`의 `answerable`이 같은 판정을 미리 알려 준다. 이 미리보기는 판정 행을 남기지 않는다.

세션 이름을 바꾸는 것(`PATCH /v1/sessions/{id}`, `session.rename`)도 답하는 사람과 같은 사람만 한다. scope는 `sessions:write`이고, 응답이 세션 상세라 `sessions:read`도 함께 본다. 공유로 보기만 하는 사람은 `403`(`reason_code: role`, "holds sessions:write but may not use it on this session"), 볼 수 없는 사람은 `404`다. 거절은 판정 행으로 남고, 허용은 남지 않는다. 이름은 제어가 아니어서 세션 `revision`도 receipt도 바뀌지 않는다. 바뀐 이름은 `status` 이벤트의 `title`로 스트림에 실린다. 생성 때 `title`이 없으면 첫 메시지에서 결정적 규칙으로 만들고, 이 기능 전의 세션은 `sessions.title`이 `NULL`이다(backfill 없음, migration 0155).

세션 목록의 `relation`(`started`·`shared`·`administered`)과 `q`, 그리고 `GET /v1/sessions/counts`는 위의 공유 범위 판정과 AND로만 묶인다. 그래서 어느 값도 볼 수 있는 범위를 넓히지 않고, 공유 밖 세션은 목록에도 개수에도 잡히지 않는다. `administered`는 지금 `agent_admins`와 admin 팀의 살아 있는 구성원을 읽을 때마다 다시 본다. 에이전트 관리자라는 이유만으로 공유 밖 세션을 보게 하는 규칙은 아직 없다. 목록·상세의 `created_by`와 `relation=started`는 1번 턴의 `turns.actor_id`로 시작한 사람을 읽고, 그 값이 없으면(#427 전 세션) `created_by_user_id`로 대신한다. 인수는 `created_by_user_id`만 바꾸므로 인수 뒤에도 시작한 사람은 그대로다. 볼 수 있는지는 지금처럼 `created_by_user_id`로 판정하므로 이 규칙이 범위를 넓히지 않는다. 목록·상세의 `channel`은 세션을 만든 요청의 surface(`web`·`api`·`slack`)를 `sessions.channel`에 적은 값이다. migration 0158은 이 열 전의 세션을 행이 증명하는 만큼만 채운다. `created_by_api_key_id`가 있으면 `api`(API key 호출만 이 열을 쓴다), 없고 `created_by_user_id`가 있으면 `web`(사람은 웹 로그인으로만 들어온다)이고, 둘 다 없으면 `NULL`이다.

범위를 바꾸는 것(`session.share`)은 사람의 세션이면 만든 사람만, key가 만든 세션이면 owner·admin과 그 에이전트의 관리자만 한다. 세션을 볼 수 있지만 바꿀 수 없는 사람은 `403`, 볼 수 없는 사람은 `404`다. API key는 바꾸지 못한다. 바꾼 경우에만 `share_session` receipt(`result.scope`)와 판정 행이 남는다.

owner·admin은 범위 밖 세션을 두 길로만 다룬다. 둘 다 사유(`justification`, 1000자까지)가 필요하고, 사유는 `authz_decisions.justification`에 남는다.

- **감사 열람** `POST /v1/sessions/{id}/audit-read` `{"justification"}`: 세션 상세와 turn 한 페이지(`cursor`·`limit`)를 돌려준다. 읽을 때마다 `session.audit_read` 행이 하나씩 남는다. 읽기만 한다. 열람한 뒤에도 그 세션의 다른 표면(메시지·응답·종료 등)은 여전히 `404`다. 사유가 없으면 `400`, member는 `404`(범위 밖) 또는 `403`(`reason_code: role`)이다.
- **관리 종료** `POST /v1/admin/sessions/{id}/terminate` `{"expected_revision","justification"}`: 범위와 관계없이 세션을 멈춘다. 사유는 판정 행과 stop 이벤트의 reason에 남는다. 사유가 없으면 `400`이다. 같은 세션에 일반 `POST /v1/sessions/{id}/terminate`를 보내면 `404`이고 거절도 판정 행(`not_found`)으로 남는다.
- **관리 복구** `POST /v1/admin/sessions/{id}/recovery-decisions`: 결과를 모르는 세션의 복구 결정을 owner만 범위와 관계없이 내린다. 본문은 일반 복구 결정과 같고, 그 `reason`이 사유다. 공백뿐인 사유는 사유가 없는 것과 같아 `404`다.

세션 관리 목록 `GET /v1/admin/sessions`는 owner·admin이 범위와 관계없이 workspace의 세션을 최근 것부터 200개 본다. 항목은 메타데이터뿐이다: `session_id`, `created_by_user_id`, `created_by_api_key_id`, `agent_release_id`, `status`, `admission_state`, `share_scope`, `created_at`, `takeover_required_at`. 메시지·제목·요약은 없다.

나간 멤버의 세션 인수(`POST /v1/sessions/{id}/takeover`)도 그 세션이 인수하는 사람에게 보이지 않는 범위면 사유가 필요하다. 본문 없이 보내면 `403`(`reason_code: justification_required`)이고, `{"justification"}`을 보내면 인수되고 `takeover` receipt의 `result.justification`에 사유가 남는다. 인수한 사람은 만든 사람 자리에 서므로 그 세션을 보고 범위도 바꿀 수 있다.

```bash
curl -s -b jar -X POST "http://127.0.0.1:3000/v1/sessions/$SESSION_ID/share" \
  -H 'X-Requested-With: werft-web' -H 'Content-Type: application/json' \
  -d "{\"scope\":\"team\",\"team_ids\":[\"$TEAM_ID\"]}"
curl -s -b jar -X POST "http://127.0.0.1:3000/v1/sessions/$SESSION_ID/audit-read" \
  -H 'X-Requested-With: werft-web' -H 'Content-Type: application/json' \
  -d '{"justification":"장애 조사 INC-42"}'
curl -s -b jar http://127.0.0.1:3000/v1/admin/sessions
```

Slack DM이 만든 세션은 `private`로 시작한다(아래 "Slack 스레드와 세션"). 아직 없는 것: 웹에서 만든 `private` 세션을 Slack 채널에 잇는 것의 거절(웹 세션을 채널에 잇는 경로가 아직 없다), 세션 삭제.

### GitHub 계정 연결

웹에 로그인한 사람은 자기 GitHub 계정을 작성용 GitHub App의 user authorization으로 연결한다. 연결해 두면 그 사람이 시작한 세션의 commit과 PR 꼬리에 `Co-authored-by: <login> <<id>+<login>@users.noreply.github.com>`이 들어간다. commit 작성자는 그대로 App이다. 연결은 Slack과 같은 `linked_accounts`에 `provider=github`, `external_tenant=github.com`으로 남는다. GitHub 계정 하나는 모든 워크스페이스를 통틀어 한 사람에게만, 한 사람은 GitHub 연결을 하나만 가진다. 연결·해제는 그 사람의 web session으로만 한다(API key는 `403`).

| 변수 | 기본값 | 허용 범위 |
|---|---|---|
| `CONSOLE_ORIGIN` | 없음(옛 `SLACK_OIDC_REDIRECT_URI`가 있으면 이번 릴리스에 한해 그 origin을 쓰고 "폐기 예정" 경고를 낸다. 다음 릴리스에서 이 폴백은 없어진다) | 절대 http(s) origin. 공개 주소의 유일한 소스다. Slack 연결·이벤트 주소도 여기서 계산한다(위 "Slack 계정 연결"). GitHub 연결 콜백 `<콘솔 origin>/settings/linked-accounts/github`와 commit·PR의 세션 URL `<콘솔 origin>/sessions/<id>`에 쓴다. 둘 다 없으면 콜백 URL이 없어 연결을 시작할 수 없고(`409 GITHUB_LINK_NOT_CONFIGURED`), commit에 `Agent-Session` 트레일러가 들어가지 않으며 PR 꼬리는 세션 id만 싣는다 |

**준비(owner·admin, 사람이 한다).** 작성용 App이 콘솔에 등록돼 있어야 한다(위 "GitHub 저장소").

1. 콘솔 설정 > 워크스페이스 > 연동 > GitHub의 "사용자 계정 연결" 카드에서 콜백 URL을 복사한다. Client ID는 App을 다시 읽을 때 GitHub가 준 값이 보인다.
2. GitHub의 App 설정(Settings → Developer settings → GitHub Apps → 그 App → General)에서 **Callback URL**에 1의 주소를 그대로 넣고 저장한다. **Expire user authorization tokens**는 그대로 둔다(플랫폼은 token을 받자마자 버린다).
3. 같은 페이지의 **Client secrets → Generate a new client secret**으로 만든 값을 카드의 "입력"에 붙여 넣고 저장한다(`PUT /v1/workspaces/{id}/github-settings/oauth-client-secret`). 값은 App 키처럼 master key로 암호화해 그 App 행의 `secret_values`에 두고, 응답·receipt·로그 어디에도 나오지 않으며 다시 보여 주지 않는다. 같은 App의 키를 바꾸면 남고, 다른 App으로 바꾸거나 App을 지우면 함께 지워진다. 작성용 App이 없으면 본문을 읽기 전에 `409 GITHUB_LINK_NOT_CONFIGURED`, master key 없이 띄운 API는 `503`이다.

흐름은 다음과 같다.

1. `POST /v1/linked-accounts/github/start`가 `authorize_url`을 돌려주고, state를 HttpOnly cookie `werft_github_link`(path `/v1/linked-accounts/github`, 10분, 시작한 사람에 묶임)에 둔다. App·client secret·콜백 URL 가운데 하나라도 없으면 `409 GITHUB_LINK_NOT_CONFIGURED`다.
2. GitHub가 콜백 URL로 `code`·`state`를 붙여 돌려보낸다. 웹 화면이 둘을 `POST /v1/linked-accounts/github/callback`에 넘긴다. cookie는 이때 한 번 쓰고 지운다. 만료·재사용·다른 사람의 state·GitHub가 거절한 code는 모두 `400`이다.
3. API가 `code`를 user access token으로 바꿔 `GET /user`로 id·login만 읽고, token은 그 자리에서 버린다(저장하지 않는다). 그 GitHub 계정이 다른 사람에게 연결돼 있으면 `409 LINK_TAKEN`, 내게 이미 GitHub 연결이 있으면 `409 LINK_EXISTS`, GitHub가 답하지 않으면 `503`이다. 성공하면 `201`과 `link_account` receipt가 남는다. 해제는 Slack과 같은 `DELETE /v1/linked-accounts/{id}`다.

**commit 트레일러.** claim의 `git.co_author`(시작자가 연결했을 때만)와 `git.session_url`을 worker가 `$HOME/.werft/git-trailers`에 쓰고, worker 이미지의 system `core.hooksPath`(`/usr/local/share/werft/git-hooks`)에 있는 `commit-msg` hook이 `git interpret-trailers --if-exists addIfDifferent`로 `Co-authored-by:`·`Agent-Session:`을 붙인다. 같은 줄은 한 번만 붙고, 저장소의 원래 hook(`.git/hooks/<이름>`)은 먼저 돈다. 시작자는 첫 turn을 보낸 사람, 없으면 세션을 만든 사람이다. web·개인 key·Slack은 사람이고, 에이전트 key·운영자 key는 사람이 없어 `Agent-Session`만 붙는다. 콘솔 origin이 없으면 `Agent-Session:`에는 세션 URL 대신 세션 id가 들어간다(PR 꼬리와 같은 값). 세션 상세의 성과물 탭 위 한 줄이 이 판정(`GET /v1/sessions/{id}/github/attribution`)을 보여 준다.

**commit 작성자.** 세션 저장소가 콘솔에 등록한 작성용 App(`auth: { kind: github_app }`)을 쓰면, commit의 author와 committer는 그 App의 bot 계정 `<slug>[bot] <<bot user id>+<slug>[bot]@users.noreply.github.com>`이다. GitHub가 App bot의 noreply 주소로 정한 형식이다([actions/checkout README](https://github.com/actions/checkout#push-a-commit-using-the-built-in-token), [actions/create-github-app-token README](https://github.com/actions/create-github-app-token#configure-git-cli-for-an-apps-bot-user)). bot user id는 App id와 다른 값이라 control-host가 `GET https://api.github.com/users/<slug>[bot]`(인증 없음)으로 한 번 읽어 프로세스에 둔다. 실패하면 5분 동안 다시 묻지 않고, 그 사이 claim은 이미지 기본값 `Werft <noreply@werft.invalid>`로 commit한다. claim의 `git_author`를 worker가 `$HOME/.werft/git-identity`에 쓰고, 이미지의 system git 설정이 기본값 뒤에서 그 파일을 include한다. 카탈로그에 App id를 직접 적은 저장소와 GitHub Enterprise Server는 이미지 기본값 그대로다. 저장소에서 `git config user.*`로 정한 값은 여전히 이긴다.

한계: 저장소가 자기 `core.hooksPath`(husky 등)를 두거나 `git commit --no-verify`로 커밋하면 트레일러가 붙지 않는다. 그런 저장소에서는 `pre-commit install`이 `core.hooksPath`가 있다며 거절한다. hook은 client hook만 잇고 `reference-transaction`은 잇지 않는다.

### 자격 연결

에이전트 정의(card)는 쓸 자격 증명의 이름만 `capabilities.credential_refs`에 적는다(예: `["notion_token"]`, 소문자·숫자·`._:/-` 128자까지, 32개까지). 값은 플랫폼에 들어오지 않는다. 그 이름을 이 에이전트가 써도 된다는 연결은 `credential_bindings`의 행이고, owner·admin·그 에이전트 관리자가 cookie 세션으로만 만든다(`credential.bind`). API key와 그 에이전트를 관리하지 않는 member는 `403`(`reason_code: role`)이다.

| 요청 | 하는 일 |
|---|---|
| `GET /v1/agents/{id}/credential-bindings` | 살아 있는 연결과 각 이름을 쓰는 실행 중 세션 수(`running_sessions`, 닫히지 않은 세션) |
| `POST /v1/agents/{id}/credential-bindings` `{"credential_ref":"…"}` | 연결. 이미 있으면 같은 행과 `created: false`, `receipt_id: null` |
| `DELETE /v1/agents/{id}/credential-bindings/{binding_id}` | 해제. 응답의 `running_sessions`와 `revoke_notice` |

- 연결은 두 번 다시 검사한다. 활성화(`POST /v1/agents/{id}/activate`)는 release의 이름 중 연결되지 않은 것이 있으면 `409 CREDENTIAL_UNBOUND`이고 `error.details.missing`에 그 이름들이 있다. 새 세션(`POST /v1/sessions`에 `agent_release_id`)도 같은 검사를 판정(`session.submit`, `reason_code: credential_unbound`)에서 한 번 더 한다. 활성화 뒤에 해제했을 때를 막는 자리다. 세션을 받는 transaction은 그 에이전트의 살아 있는 연결 행을 잠그고 다시 읽는다. 그래서 동시에 온 해제는 세션이 들어간 뒤에 끝나고 실행 중 세션 수에 그 세션을 센다. 해제 전에 받은 세션을 같은 `Idempotency-Key`로 다시 보내면 원래 응답(`201`)이 돌아온다.
- 세션 거절은 요청자에게 이름을 보여 주지 않는다. `error.details`는 안내 문구(`guidance`), 그 에이전트의 관리자 목록(`admins`, 관리자가 없으면 owner·admin), 연락 링크(`admin_link`, `mailto:`)다.
- 해제는 지금 도는 turn을 멈추지 않지만, 실행 중인 세션도 다음 메시지부터 막힌다(`POST /v1/sessions/{id}/messages`가 `409 CREDENTIAL_UNBOUND`, `error.details.receipt_id`의 `append_message` receipt). 세션 시작 거절도 `create_session` receipt를 `receipt_id`로 준다. 원격 MCP 호출은 다음 요청부터, 이미 열린 교환은 regrant 주기(30초) 안에 끊긴다. 이미 upstream에 보낸 POST는 끝까지 실행된다. 바로 막으려면 외부 서비스에서 그 자격을 폐기한다. 해제 응답의 `revoke_notice`가 같은 말을 한다.
- 해제한 이름을 다시 연결하면, 해제 때문에 막혔던 실행 중 세션도 다음 메시지와 다음 MCP 호출부터 다시 돈다. 연결 상태는 요청마다 읽고 세션에 저장하지 않기 때문이다.
- 에이전트 신원에 묶인 이름은 다른 에이전트에 연결하지 못한다(`409 CREDENTIAL_REF_IN_USE`). 거꾸로도 같다. 한 이름에 대한 두 경로는 같은 advisory lock과 trigger(`credential_bindings_exclusive_target`)로 막는다.
- 연결·해제는 `bind_credential`·`unbind_credential` receipt와 `credential.bind` 판정 행을 남긴다. receipt `result`에는 이름(`credential_ref`)만 있다.

```bash
curl -s -b jar -X POST http://127.0.0.1:3000/v1/agents/<agent_id>/credential-bindings \
  -H 'X-Requested-With: werft-web' -H 'Content-Type: application/json' \
  -d '{"credential_ref":"notion_token"}'
```

### 에이전트의 Slack 앱 연결

에이전트마다 자기 Slack 앱(bot)을 갖는다. "이 Slack 앱은 이 에이전트다"는 `agent_identities`의 행이다. 행은 확인된 Slack 설치(`slack_installations`) 하나를 가리키고, 연결할 때 설치가 답한 bot user id와 bot token의 이름(`credential_ref`, 값이 아니다)을 담는다. 설치 하나에는 살아 있는 연결이 하나뿐이다. 그래서 Slack 이벤트의 `(api_app_id, team_id)`만으로 에이전트가 하나로 정해진다.

- 연결: `POST /v1/agents/{id}/identities` `{provider: "slack_bot", app_id, team_id, credential_ref}` → `201`과 `link_agent_identity` receipt. owner·admin·그 에이전트 관리자가 한다(`binding.manage`). 권한이 없으면 `403`이고 `details.reason_code`가 있다.
- 거절: 설치가 없거나 아직 확인 전이거나 회수됐으면 `409 SLACK_NOT_INSTALLED`, 그 앱이 다른 에이전트에 연결돼 있으면 `409 AGENT_IDENTITY_TAKEN`, 이미 이 에이전트에 연결돼 있으면 `409 ALREADY_EXISTS`. 보관된 에이전트는 `404`다.
- `credential_ref`는 그 신원만 쓴다. 에이전트에 연결된 이름이나 다른 신원의 이름이면 `409 CREDENTIAL_REF_IN_USE`다. 신원을 회수하면 이름이 풀린다(위 "자격 연결"과 같은 `credential_bindings` 행).
- 목록: `GET /v1/agents/{id}/identities`(살아 있는 것 먼저, 최근 것 먼저, 50개).
- 회수: `DELETE /v1/agents/{id}/identities/{identity_id}` → `revoked`, `revision` +1, `revoke_agent_identity` receipt. 이미 회수한 것은 아무것도 바꾸지 않고 `receipt_id: null`이다. 행은 지우거나 되살리지 않는다. 다시 연결하면 새 행이 생긴다. 그 설치에 있던 이 에이전트의 채널 설정(아래 "에이전트의 Slack 채널 설정")도 함께 회수된다. 같은 앱을 다른 에이전트에 연결하면 채널 설정은 빈 상태에서 시작한다.

Slack ingress는 이벤트를 받을 때 `agentForSlackEvent(store, {appId, teamId, agentId?})`(`@werft-ai/platform`, 저장소 쪽은 `resolveSlackEventAgent`)로 에이전트를 정한다. `resolved`면 `{workspaceId, agentId, identity: {id, revision}, botUserId, credentialRef}`이고, 아니면 `dropped`와 이유다. 버려진 이벤트는 받았다고만 답하고 아무것도 실행하지 않는다.

| 이유 | 뜻 |
|---|---|
| `not_installed` | 그 team에 그 앱의 설치가 없다(다른 앱으로 온 이벤트) |
| `installation_unverified` · `installation_revoked` | 설치가 확인 전이거나 해제됐다 |
| `unidentified` | 설치에 연결된 에이전트가 없다 |
| `identity_revoked` | 연결이 회수됐다 |
| `bot_mismatch` | 재설치로 bot이 바뀌었다. 다시 연결해야 한다 |
| `agent_mismatch` | 이벤트가 다른 에이전트 앞으로 왔다 |
| `agent_archived` | 에이전트가 보관됐다 |

플랫폼이 만든 앱은 아래 "에이전트의 Slack 앱 설치"가 설치 행과 연결을 함께 만든다. 손으로 만든 앱은 운영자가 설치한 뒤 설치 행을 `bun run slack-install register`(위 Slack 계정 연결 절차 4)로 만들고 이 route로 연결한다.

```bash
curl -s -b jar -X POST "http://127.0.0.1:3000/v1/agents/$AGENT_ID/identities" \
  -H 'X-Requested-With: werft-web' -H 'Content-Type: application/json' \
  -d '{"provider":"slack_bot","app_id":"A0APP","team_id":"T0TEAM","credential_ref":"slack/research-bot-token"}'
```

### Slack 비밀값과 master key

플랫폼이 Slack을 부를 때 쓰는 비밀값은 Postgres `secret_values`에 암호문으로만 둔다. App Configuration Token, 앱별 signing secret·client secret·bot token이 여기에 들어간다. 암호는 AES-256-GCM이고, 암호문은 `id|workspace_id|owner_ref|purpose|secret_version|key_version`에 묶인다. 그래서 다른 행, 다른 workspace, 다른 앱으로 옮긴 암호문은 복호화되지 않는다. 키(master key)는 API 프로세스만 갖는다.

**master key**

- 32바이트를 16진수 64자로 쓴다. `openssl rand -hex 32`로 만든다.
- `PLATFORM_SECRET_KEY` 환경 변수만 읽는다. 없으면 API와 slack 역할이 뜨지 않는다. 설정 문서에도 넣지 않는다.
- 64 hex가 아니어도 뜨지 않는다. 오류에는 변수 이름만 나오고 값은 나오지 않는다.
- `scripts/local.sh up`은 셸이나 `.env`에 값이 없으면 키를 만들어 `AGENT_PLATFORM_STATE_DIR`(기본 `~/.local/state/werft`)의 `<프로젝트>.secret-key`(권한 600)에 두고 다시 쓴다. 이 파일을 잃으면 저장한 자격 증명을 읽지 못한다.
- compose는 이 키를 `api`와 `slack` 서비스에만 넘긴다(`tests/images.test.ts`가 검사한다). Helm은 api Deployment와 slack Deployment(`slack.enabled`일 때)에 Secret의 `PLATFORM_SECRET_KEY`를 넘긴다. Secret에 이 키가 없으면 Pod가 뜨지 않는다. slack role도 기동할 때 같은 키를 검증하기 때문이다. scheduler와 worker는 받지 않는다(`deploy/helm/render-check.ts`가 검사한다).
- 키를 잃으면 저장된 값을 읽을 수 없다. 새 키로 띄운 뒤 config token을 다시 넣고, 자동 생성한 앱은 다시 만들고, GitHub App은 새 private key로 다시 등록한다. 키 회전 도구는 아직 없고 `key_version`은 1이다.

로컬 스택에서는 키를 macOS Keychain에 두고 기동할 때마다 꺼낸다. 처음 한 번만 1–3을 한다.

1. `openssl rand -hex 32 | pbcopy`
2. `security add-generic-password -a "$USER" -s werft-secret-key -w`를 실행하고 프롬프트에 붙여 넣는다.
3. `pbcopy </dev/null`로 클립보드를 비운다.
4. 기동할 때마다 `PLATFORM_SECRET_KEY`를 Keychain 항목 `werft-secret-key`에서 export한 뒤 `scripts/local.sh up`을 실행한다.

   ```bash
   export PLATFORM_SECRET_KEY="$(security find-generic-password -a "$USER" -s werft-secret-key -w)"
   scripts/local.sh up
   ```

**App Configuration Token API**

owner·admin이 콘솔 세션(cookie)으로만 쓴다. 값은 돌려주지 않는다.

| 요청 | 하는 일 |
|---|---|
| `GET /v1/workspaces/{id}/slack/config-token` | `{configured, last4, updated_at, updated_by, state, expires_at, issuer}`. 값은 없다 |
| `PUT /v1/workspaces/{id}/slack/config-token` `{"value":"…"}` | 붙여 넣은 refresh token을 바로 Slack에서 회전(`tooling.tokens.rotate`)하고, 받은 access·refresh token 한 쌍을 저장한다. 응답은 GET과 같은 요약, `receipt_id`, `warnings` |
| `DELETE /v1/workspaces/{id}/slack/config-token` | 지운다. 설정된 값이 없으면 `404` |
| `GET /v1/workspaces/{id}/github-app` | `{github_app, check, installations, repositories}`. 등록한 App(키는 없다)과, App의 JWT로 지금 GitHub에 물은 설치 목록·카탈로그 저장소별 installation id. GitHub가 답하지 않거나 App을 거절하면 `check.state: failed` |
| `PUT /v1/workspaces/{id}/github-app` `{"app_id":…,"private_key":"<PEM>"}` | GitHub가 그 키를 그 App ID로 받아 줄 때만 저장(없으면 등록, 있으면 교체). 응답은 `{github_app, receipt_id}` |
| `DELETE /v1/workspaces/{id}/github-app` | App과 키를 지운다. 없으면 `404` |

- 쓰기에는 `X-Requested-With` 헤더가 필요하다. 없거나 다른 사이트에서 온 요청은 `403`이다(`csrfViolation`).
- member는 `403`이다. API key는 역할과 관계없이 `403`이다(`reason_code: web_session_required` 또는 `role`). 다른 workspace의 경로는 `404`다.
- `value`는 공백 없는 출력 가능 ASCII 8–4096자다. 어긋나면 `400 Request body is invalid`이고, 응답에도 로그에도 값은 남지 않는다.
- 붙여 넣는 값은 api.slack.com/apps의 **Your App Configuration Tokens**에서 만든 refresh token이다. 붙여 넣은 값은 저장 즉시 회전으로 소모된다. Slack이 받지 않으면 `409 CONFIG_TOKEN_INVALID`(`reason_code: rejected`)이고 저장된 값은 그대로다. Slack에 닿지 못하면 `503`이고 역시 그대로다.
- 저장·교체는 `set_slack_secret`, 삭제는 `delete_slack_secret` receipt를 남긴다. `result`는 `{purpose, last4}`뿐이다. 쓰는 transaction 안에서 쓰는 사람의 역할을 다시 읽는다.
- `state`는 `unset`·`active`·`needs_reentry`다. access token은 12시간짜리이고, 만료 5분 전부터 다음 Slack 호출이 먼저 회전한다. 회전은 `slack_config_tokens` 행의 lease(30초)로 프로세스 사이에서 한 번만 일어나고, Slack 호출 중에는 transaction을 열어 두지 않는다. Slack이 refresh token을 거절하거나(`invalid_refresh_token`·`token_revoked` 등) 회전 응답을 받고도 저장에 세 번 실패하면, 또는 lease가 끝난 회전이 발견되면 저장된 쌍을 지우고 `needs_reentry`가 된다. 그때는 owner·admin이 새 token을 붙여 넣는다. refresh token의 수명과 일회성은 Slack 문서에 적혀 있지 않아 이렇게 다룬다.
- token을 만든 Slack 사용자가 바뀌면 `warnings`에 `config_token_issuer_changed`가 온다. 이후 만드는 앱의 collaborator가 그 사용자가 된다.

**에이전트의 Slack 앱 만들기**

활성 release가 있는 에이전트마다 Slack 앱을 하나 만든다. 앱 이름은 에이전트 이름, bot 이름은 slug, agent view 설명은 활성 release의 role이다. bot scope는 `assistant:write`·`app_mentions:read`·`chat:write`·`im:history`·`channels:history`·`groups:history`·`channels:read`·`groups:read`·`users:read`·`channels:join`·`groups:write`이고 user scope는 없다. `slack` 역할은 이 가운데 `users:read`(`users.info`), `assistant:write`(`agents.sessions.setStatus`)를, binding 설정은 `channels:read`·`groups:read`(`conversations.info`)를, 공개 채널 자동 참가는 `channels:join`(`conversations.join`)을 쓴다. 메시지는 `message.channels`·`message.groups`·`message.im` 구독(`*:history` scope)으로 받는다. 생성 manifest에는 event subscription이 없다. 설치가 끝날 때 마무리 ①이 manifest를 다시 보내 붙인다(아래 "Slack 이벤트 수신"). OAuth redirect는 `<콘솔 origin>/agents/{id}/slack/callback`이고, 콘솔 origin은 `CONSOLE_ORIGIN`이다. 이 값이 없으면 앱을 만들지 않는다(`503`).

| 요청 | 하는 일 |
|---|---|
| `GET /v1/agents/{id}/slack/app` | `{slack_app}`: 에이전트의 앱(`creating`·`created`·`deleting`). 없으면 `null` |
| `POST /v1/agents/{id}/slack/app` `{"replace_uncertain": false}` | 앱을 만들고 `{slack_app, created, warnings}`를 돌려준다. 이미 있으면 같은 앱을 `created: false`로 |
| `GET /v1/workspaces/{id}/slack/apps` | `{items}`: 콘솔이 만든 에이전트 앱과 계정 연결 앱 중 `creating`·`created`·`deleting`인 것. 계정 연결 앱이 먼저, 그다음 에이전트 이름순이다. 에이전트 앱은 `agent`(`id`·`name`·`slug`·봇 설치 여부 `installed`)를 함께 준다. 손으로 만든 앱은 빠진다. 소유자·관리자만, 콘솔 세션으로만 |
| `DELETE /v1/workspaces/{id}/slack/apps/{app_id}` | 그 workspace의 `slack_apps`에 있는 앱만 Slack에서 지우고(`apps.manifest.delete`) 비밀값을 지운다. 행은 `deleted`로 남는다 |
| `PUT /v1/workspaces/{id}/slack/apps/{app_id}/secrets/{purpose}` `{"value":"…"}` | 손으로 만든 앱(kind `manual`)의 값만 넣는다. 플랫폼이 만든 앱은 `403 server_managed_secret`. `purpose`가 셋(`slack_signing_secret`·`slack_client_secret`·`slack_bot_token`) 밖이거나 `app_id`가 UUID가 아니면 `400` |

- 만들기·조회는 owner·admin·그 에이전트의 관리자, 콘솔 세션(cookie)과 `X-Requested-With`로만 한다. API key는 `403`이다. 활성 release가 없으면 `409 AGENT_NOT_ACTIVE`, config token이 없거나 쓸 수 없으면 `409 CONFIG_TOKEN_INVALID`다.
- `slack_apps` 행은 Slack을 부르기 전에 `creating`으로 쓴다. Slack 응답에서 받은 signing secret·client secret은 서버가 `slack_app:<id>` 아래에 저장하고 응답·로그·receipt에는 남기지 않는다. 응답의 `secrets`는 저장 여부와 끝 네 글자뿐이다.
- Slack 응답을 잃으면(시간 초과, 연결 끊김, 저장 실패) 행이 `creating`으로 남고 `503`이다. 다음 요청은 `409 SLACK_APP_CREATING`이고, 60초가 지나면 `details.uncertain: true`가 붙는다. 그때 api.slack.com/apps에서 그 시각에 만들어진 앱을 지운 뒤 `replace_uncertain: true`로 다시 요청하면 옛 행을 `abandoned`로 두고 새로 만든다. Slack이 manifest를 거절하면 행은 `failed`가 되고 `503`(`details.slack_error`)이다.
- 만들기·지우기는 아직 receipt를 남기지 않는다.

운영자는 CLI로도 만든다. API 컨테이너 안에서(DB, master key, `CONSOLE_ORIGIN`이 이미 있다) 실행하고, 출력은 JSON 한 줄이다. 비밀값은 출력하지 않는다.

```bash
docker compose --profile apps exec -T api \
  bun run apps/control-host/src/api/slack-app.ts create --workspace "$WORKSPACE_ID" --agent "$AGENT_ID"
# {"outcome":"created","slack_app_id":"…","app_id":"A…","agent_id":"…","created_by_token_user":"U…","warnings":[],"next":"Install it from the agent's page in the console, or with a signed-in console session: POST /v1/agents/<agent_id>/slack/install/start"}
```

`--agent` 대신 `--kind link`를 주면 워크스페이스의 계정 연결용 link 앱을 만든다(위 "Slack 계정 연결").

| 종료 코드 | 뜻 |
|---|---|
| `0` | 만들었거나 이미 있다(`outcome: created`·`exists`). `--kind link`도 같다 |
| `1` | 예상하지 못한 오류 |
| `2` | 인자·env가 잘못됐다(`DATABASE_URL`·`CONSOLE_ORIGIN`·master key 없음) |
| `3` | config token이 없거나 Slack이 더는 받지 않는다. 콘솔에서 새로 붙여 넣는다 |
| `4` | 에이전트나 workspace가 없다 |
| `5` | 에이전트에 활성 release가 없다 |
| `6` | 앱이 아직 만들어지는 중이거나 지워지는 중이다. Slack에서 확인한 뒤 `--replace-uncertain`으로 잃어버린 생성을 포기한다 |
| `7` | Slack이 거절했거나 닿지 않는다 |

로컬 스택의 mock overlay(`infra/compose.mock-slack.yml`, `local` target으로 빌드한 control-host 이미지에서 돈다. 게시 이미지에는 testkit이 없어 쓸 수 없다)는 mock 시험 전용 `SLACK_API_URL=http://mock-slack:4020/api`로 Slack Web API의 가짜(`packages/testkit/src/fake-slack-api.ts`)를 가리킨다. `POST http://mock-slack:4020/fake/config-tokens`가 그 가짜가 받는 config token을 하나 돌려준다. `GET http://mock-slack:4020/fake/oauth/authorize?<설치 URL의 query>`는 동의 화면 대신 `{ok, code, state}`를 JSON으로 돌려준다(아래 설치 흐름을 curl로 돌릴 때). 실제 Slack은 부르지 않는다.

값은 repo 밖 파일에 두고 셸에서 읽어 보낸다. 값이 명령 인자나 셸 기록에 남지 않게 한다.

```bash
printf '{"value":"%s"}' "$(cat ~/.config/werft/slack-config-token)" |
  curl -s -b jar -X PUT "http://127.0.0.1:3000/v1/workspaces/$WORKSPACE_ID/slack/config-token" \
    -H 'X-Requested-With: werft-web' -H 'Content-Type: application/json' --data-binary @-
```

**에이전트의 Slack 앱 설치**

만든 앱(`created`)을 Slack workspace에 설치하고 에이전트에 연결한다. Slack이 돌아오는 곳은 콘솔의 `/agents/{id}/slack/callback` 화면이고, 그 화면이 받은 `code`·`state`를 API에 넘긴다. 공개 listener는 없다.

| 요청 | 하는 일 |
|---|---|
| `POST /v1/agents/{id}/slack/install/start` | `{authorize_url, expires_at}`. 부를 때마다 새 state를 만든다 |
| `POST /v1/slack/install/complete` `{agent_id, state, code}` 또는 `{agent_id, state, error}` | state를 쓰고 설치를 끝낸다. `{slack_app, installation, agent_identity, receipt_id, finalized, warnings}` |

- 둘 다 owner·admin·그 에이전트 관리자(`binding.manage`)가 콘솔 세션(cookie)과 `X-Requested-With`로만 한다. API key는 `403`(`reason_code: web_session_required`), member는 `403`이다. 앱이 없으면 `404`, 만드는 중이면 `409 SLACK_APP_CREATING`, 지우는 중이면 `409 REVISION_CONFLICT`, config token이 없으면 `409 CONFIG_TOKEN_INVALID`다. master key가 없으면 `503`이다.
- state는 무작위 32바이트이고 DB(`slack_install_states`)에는 sha256 해시만 둔다. 행은 workspace·에이전트·앱(`slack_app_id`)·시작한 사용자·config token의 team·redirect URL에 묶이고 600초 산다. complete는 권한을 확인한 뒤 state를 지우면서 읽는다. 그 뒤로는 결과와 관계없이 다시 쓸 수 없다. 만료된 행은 다음 start가 지운다.
- state 거절은 `409 SLACK_INSTALL_STATE_INVALID`이고 `details.reason_code`가 `not_found`(없거나 이미 씀)·`expired`·`workspace`·`actor`·`agent`·`app`(앱이 지워지거나 바뀜)이다. 사용자가 동의를 거절하면 `409 SLACK_INSTALL_DENIED`(`details.slack_error`)다.
- `oauth.v2.access` 답이 이 앱(`app_id`)·이 team·enterprise 아님·bot scope 전부를 만족하지 않으면 `409 SLACK_INSTALL_REJECTED`(`reason_code` `app`·`team`·`enterprise`·`scope`, scope는 `missing_scopes`)이고 아무것도 저장하지 않는다. Slack이 `ok:false`로 답하면 같은 코드에 `reason_code: slack_error`, 닿지 않으면 `503`이다.
- Slack 호출(`oauth.v2.access`·`auth.test`·`bots.info`)이 실패하면 응답 `details`에 `slack_method`, `failure`(`unreachable`·`timeout`·`http_status`·`unexpected_answer`·`slack_error`), 답이 왔으면 `http_status`, Slack이 `error`를 줬으면 `slack_error`가 붙는다. `ok:false`라도 5xx면 Slack이 무엇을 했는지 몰라 `503`이다. complete가 실패하면 api는 `Slack install failed` 한 줄(`agent_id`·`status`·`code`와 details 중 `reason_code`·`slack_method`·`failure`·`http_status`·`slack_error`만)을 `warn`으로 남긴다. state·code·token·secret과 Slack 답의 본문은 응답에도 로그에도 남지 않는다.
- 통과하면 이 순서다: bot token을 `slack_app:<id>/slack_bot_token`에 저장하고 `slack_apps.bot_token_ref`를 채운다 → 그 token으로 `auth.test`·`bots.info`를 불러 app·team을 다시 확인한다 → 설치 행을 등록·확인한다 → `agent_identities`에 연결한다(`credential_ref`는 bot token의 이름 `slack_app:<id>/slack_bot_token`, `link_agent_identity` receipt). 같은 설치가 다른 workspace에 있으면 `409 SLACK_INSTALL_CONFLICT`, 앱이 다른 에이전트에 연결돼 있으면 `409 AGENT_IDENTITY_TAKEN`이다.
- bot token을 저장한 뒤의 모든 거절(`auth.test`·`bots.info` 불일치나 무응답, `SLACK_INSTALL_CONFLICT`, `AGENT_IDENTITY_TAKEN`, `CREDENTIAL_REF_IN_USE`, `REVISION_CONFLICT`, 보관된 에이전트, 그 사이 권한을 잃은 사람의 `403` 등)에는 저장한 token이 남고, 설치를 등록한 뒤의 거절이면 확인된 설치 행도 남는다. 그래서 `secrets.slack_bot_token.configured`는 설치됐다는 뜻이 아니다. 설치됐는지는 에이전트의 `slack_bot` 신원으로 본다. 원인을 고친 뒤 start부터 다시 하면 token이 바뀐다.
- 다시 설치하면 bot token이 새 버전으로 바뀌고 설치 행·연결은 그대로 하나다(`receipt_id: null`).
- 끝나면 마무리 단계(`SlackInstallFinalize`)를 한 번 부른다. 지금은 ① 이벤트 연결뿐이다(아래 "Slack 이벤트 수신"). 환영 메시지는 뒤 티켓이다. 마무리가 실패하거나 https 이벤트 주소를 알 수 없으면(`CONSOLE_ORIGIN`이 없거나 https가 아니고 `SLACK_EVENTS_PUBLIC_URL`도 없음) 설치는 남고 `finalized: false`다. 이유는 `warnings`(`events_url_unset`, `reinstall_required`, 단계가 실패하면 `finalize_failed`)에 온다.
- complete 응답에는 `Referrer-Policy: no-referrer`가 붙는다. bot token·code·state는 응답·로그·오류·receipt에 나오지 않는다. 로그는 `Slack app installed`와 id만 남긴다.

**Slack 이벤트 수신**

Slack은 에이전트 앱의 이벤트를 `POST /v1/slack/events/{agent_id}`로 보낸다. 로그인이 없는 공개 route이고, Slack의 서명(`X-Slack-Signature` v0, `X-Slack-Request-Timestamp`)이 인증이다. 받은 이벤트는 `slack_inbound_events`에 한 행씩 쌓기만 한다. 세션은 이 route가 아니라 `slack` 역할이 만든다(아래 "Slack 스레드와 세션").

| 변수 | 기본값 | 허용 범위 |
|---|---|---|
| `SLACK_EVENTS_PUBLIC_URL` | 없음(`CONSOLE_ORIGIN`에서 계산한다. 계산할 수 없으면 마무리 ①을 건너뛴다. `finalized: false`, `warnings: [{code: "events_url_unset"}]`) | **이벤트 입구를 콘솔과 따로 둘 때만** 쓴다. query 없는 https URL. Slack이 닿는 공개 origin(path가 있으면 그 아래)이다. 있으면 `CONSOLE_ORIGIN`에서 계산한 주소 대신 이 값을 쓰고, 두 값이 다르면 시작할 때 값 없이 "불일치" 경고를 낸다. request URL은 `<주소>/v1/slack/events/<agent_id>`이다. 콘솔 주소가 https이면(로컬 loopback은 예외) 이 값 없이 `<CONSOLE_ORIGIN>/v1/slack/events/<agent_id>`가 request URL이다 |

- 검사 순서: 레이트 리미터(전체 분당 1000, 에이전트마다 분당 600. 넘으면 `429 RATE_LIMITED`와 `Retry-After`) → 본문 256 KiB(넘으면 서명을 보기 전에 `413`) → 서명(그 앱의 signing secret으로 HMAC-SHA256, 상수 시간 비교) → 시각(±300초) → JSON 파싱(`400`) → `event_id` 중복. 리미터는 DB를 읽기 전에 돈다.
- 모르는 에이전트, 앱이 없는 에이전트, signing secret이 없는 앱, 틀리거나 오래된 서명은 모두 같은 `401 UNAUTHORIZED`("Request signature is not valid")다. 응답으로 에이전트가 있는지 알 수 없다. signing secret은 성공한 조회만 60초 동안 프로세스에 둔다. 앱을 만들거나 지우면 그 프로세스의 캐시를 바로 지운다. 다른 replica는 60초 안에 따라온다.
- `url_verification`은 서명이 맞을 때만 `{challenge}`로 답한다. 나머지는 `{ok: true}`이고 3초 안에 답한다. Slack 재시도(`X-Slack-Retry-Num`)는 `(app_id, event_id)` unique로 한 행이 된다. 앱마다 따로 세므로, 한 team에 설치된 앱 둘이 같은 `event_id`를 받으면 두 행이 다 남는다. inbox 쓰기가 실패하면 `503`이라 Slack이 다시 보낸다.
- 행의 `status`는 `received`(처리할 것)·`dropped`(`drop_reason`이 있고 본문은 두지 않는다)·`processed`(앱 해제처럼 받을 때 끝냈거나 `slack` 역할이 처리한 것)·`failed`(`slack` 역할이 5번 시도하고 포기한 것)다. 본문(`payload`)은 Slack의 옛 `token` 칸을 뺀 이벤트 전체다.
- 채널 메시지에는 `conversation_key` `<slack_app_id>:<channel>:<thread_ts ?? ts>`가 붙는다. 스레드 밖 메시지는 자기 `ts`가 스레드다. DM도 channel id로 같다. 채널·`ts`가 없는 이벤트와 `dropped` 행에는 없다.
- 버리는 이유(`drop_reason`): `app_mismatch`(이벤트의 `api_app_id`가 URL 에이전트의 앱이 아님), `unsupported_event`(구독하지 않은 종류), `bot_message`(`bot_id`가 있음), `own_bot_user`(이 앱의 bot 사용자가 보냄), `message_subtype`(subtype이 없거나 `thread_broadcast`인 message만 받는다), `user_tokens_only`(bot token이 없는 `tokens_revoked`), 그리고 `agentForSlackEvent`의 이유(`unidentified`·`not_installed` 등. 위 "에이전트의 Slack 앱 연결"). `app_mention`은 bot이 보낸 것만 버린다. `member_joined_channel`과 `member_left_channel`은 bot 규칙 없이 저장하고, 들어오거나 나간 사람이 이 앱의 bot이면 `slack` 역할이 처리한다(아래 "채널 참가와 배포 환영").
- `app_uninstalled`와 bot token을 담은 `tokens_revoked`는 그 설치를 `revoked`로 바꾸고 `processed`로 남는다. 같은 트랜잭션에서 그 설치의 활성 에이전트 연결(identity)도 `revoked`(`revoked_at` 채움, 채널 binding과 자격 참조 이름 해제)가 된다. 이미 `revoked`인 설치에 이벤트가 다시 와도 활성 연결이 남아 있으면 해제한다. 재설치 뒤 `event_time`이 설치 확인 시각보다 1초 넘게 앞서는 늦은 이벤트는 건드리지 않는다. 이벤트 없이 제거된 앱은 bot token 호출이 `token_revoked`·`account_inactive`로 거절될 때 같은 경로로 해제한다(그때 저장된 token이 실패한 token과 같을 때만).
- 로그는 id·결과·`status`·`drop_reason`·재시도 번호만 남긴다. 본문·메시지 글·서명·헤더 값은 응답·로그·오류에 나오지 않는다.

버튼과 답변 창은 `POST /v1/slack/interactions/{agent_id}`로 온다. 리미터·256 KiB·서명·시각 검사와 같은 `401`은 이벤트와 같다. 본문은 `payload=<JSON>` form이고, 파싱할 수 없으면 `400`이다. inbox에 쌓지 않는다. Slack은 3초 안에 답을 받아야 하므로 버튼은 `{ok: true}`로 먼저 답하고 같은 프로세스에서 이어서 처리한다. 답하기 창을 여는 버튼은 `trigger_id`가 3초 안에만 유효하므로 질문이 없는 빈 창을 먼저 열고, 판정과 조회 뒤 `views.update`로 질문을 채운다. 창 제출은 판정과 입력 검사를 2.5초 안에 끝내야 답한다. 넘으면 창에 다시 보내 달라는 오류를 띄우고 답하지 않는다. 답하고 나서 실패하면 누른 사람에게 ephemeral로 알린다. 누른 Slack 사용자를 연결 계정으로 판정(`session.approve`)한 뒤 요청에 답하거나 push를 결정하고, `chat.update`로 카드를 결과로 바꾼다. push 결정 뒤에는 세션에 알리는 턴을 넣는다(`appendMessage`, idempotency key `slack-push:<push_request_id>`). 승인이면 먼저 세션 잠금 아래에서 본다(`push_follow_ups`, 0224): 그 push의 브랜치에 PR 기록이 있으면 넣지 않고, 세션에 `running` 턴이 있으면 행으로 남겨 두었다가 parked가 아닌 다음 턴 종료의 finalize에서 그때도 PR 기록이 없을 때만 플랫폼 턴(actor 없음)으로 넣는다. 세션이 active가 아니면 행은 다음 턴 종료까지 남는다. api 로그는 `Slack push follow-up turn not queued now`(`reason`: `held`·`pull_request`)다. 거절과 이미 처리된 요청은 누른 사람에게만 ephemeral로 알린다. 카드는 `slack` 역할이 outbox로 올린다(아래 "Slack 스레드와 세션").

마무리 ①은 설치가 끝날 때 앱 manifest 전체를 다시 보낸다(`apps.manifest.update`). 이름·bot 이름·설명·scope는 앱을 만들 때와 같고, `settings.interactivity`에 `<값>/v1/slack/interactions/<agent_id>`가, `settings.event_subscriptions`에 request URL과 bot event `app_mention`·`message.im`·`message.channels`·`message.groups`·`member_joined_channel`·`member_left_channel`·`app_uninstalled`·`tokens_revoked`가 붙는다. `member_left_channel`을 더하기 전에 만든 앱은 events 재확인(`recheckAgentAppEvents`가 manifest를 다시 보낸다)을 한 번 해야 이 이벤트를 받는다. 그 전에는 bot이 비공개 채널에서 나가도 승인이 그대로 남는다. Slack이 `permissions_updated: true`로 답하면(scope가 바뀌어 다시 설치해야 함) `warnings`에 `reinstall_required`가 오고 로그에 남는다. 아직 따로 저장하지는 않는다. 이어서 마무리 ②가 저장된 채널마다 참가를 확인하고 home에 환영을 넣는다(아래 "채널 참가와 배포 환영"). bot이 아직 없는 채널은 `warnings`에 `{code: "awaiting_invite" | "config_error" | "join_failed", channel_id, error?}`로 온다.

설치를 다시 하지 않고 manifest만 다시 보내려면(예: 공개 주소를 바꾼 뒤) API 컨테이너 안에서 실행한다. 같은 결과를 몇 번이고 보낸다.

```bash
bun run apps/control-host/src/api/slack-app.ts finalize --agent "$AGENT_ID"
# {"outcome":"finalized","slack_app_id":"…","app_id":"A…","agent_id":"…","request_url":"https://…/v1/slack/events/<agent_id>","warnings":[]}
```

종료 코드는 위 `create`와 같고, 더해서 `4`는 그 에이전트에 만든 앱이 없음, `8`은 https 이벤트 주소를 알 수 없어(`CONSOLE_ORIGIN`이 없거나 https가 아님) 아무것도 보내지 않음이다.

로컬 스택에서 실제 Slack이 이벤트와 버튼·답변 창을 보내게 하려면 Slack의 두 path(`/v1/slack/events`, `/v1/slack/interactions`)만 인터넷에 연다. 콘솔은 위 0처럼 tailnet 안(`tailscale serve`)에 둔다. Funnel은 path가 아니라 port 단위로 켜진다. 콘솔을 funnel과 같은 port(443·8443·10000)에 serve하면 콘솔과 `/v1` 전체가 인터넷에 열리니, 콘솔은 그 셋이 아닌 port에 둔다.

```bash
PORT=<API_PORT> scripts/slack-funnel.sh on   # https://<host>.ts.net/v1/slack/{events,interactions} → http://127.0.0.1:<API_PORT>/v1/slack/{events,interactions}
scripts/slack-funnel.sh status
scripts/slack-funnel.sh off                  # on과 같은 --https·--set-path로 내린다
```

공개 port는 `SLACK_FUNNEL_HTTPS_PORT`(443 기본, 8443, 10000)다. 그 뒤 API에 `SLACK_EVENTS_PUBLIC_URL=https://<host>.ts.net`(443이 아니면 `:<port>`)을 주고 다시 띄운 다음, 설치를 하거나 `slack-app finalize`를 실행한다. Helm chart의 Ingress는 사내 전용이라 Slack이 닿지 않는다. Slack용 입구는 `/v1/slack/events`와 `/v1/slack/interactions` Prefix만 넘기는 인터넷 쪽 Ingress·LB를 따로 두고, 그 주소를 `api.extraEnv.SLACK_EVENTS_PUBLIC_URL`에 준다(이벤트 입구가 콘솔과 다를 때만 필요한 값이다).

로컬 mock overlay의 가짜 Slack은 서명된 이벤트도 보낸다. `POST http://mock-slack:4020/fake/events` `{url, app_id, team_id, event, event_id?, age_seconds?, retry_num?}`는 그 앱의 signing secret으로 서명해 `url`로 보내고 `{ok, status, body, event_id}`를 돌려준다. `challenge`를 주면 `url_verification`을 보낸다. signing secret은 출력하지 않는다. 같은 가짜가 `slack` 역할의 bot 호출에도 답한다: `users.info`(모르는 사용자는 `MOCK_SLACK_TEAM_ID`의 정회원), `conversations.info`(id가 `D`로 시작하면 DM, `G`면 비공개, 나머지는 공개. `/fake/channels`로 만든 채널은 `is_member`·`is_archived`도 답하고, 그 밖의 채널은 bot이 이미 있는 것으로 답한다), `conversations.join`(`/fake/channels`로 만든 공개 채널만. 비공개는 `method_not_supported_for_channel_type`, 보관된 채널은 `is_archived`), `agents.sessions.setStatus`(받은 상태는 `GET http://mock-slack:4020/fake/statuses`가 돌려준다), `chat.postMessage`·`chat.postEphemeral`(받은 글과 요청 필드는 `GET http://mock-slack:4020/fake/messages`가 돌려준다). 모두 그 가짜가 발급한 bot token만 받는다. `POST http://mock-slack:4020/fake/rate-limits` `{method, retry_after_seconds, times?, after?}`는 그 method가 429와 `Retry-After`로 답하게 하고, `POST http://mock-slack:4020/fake/missing-ts` `{method}`(`chat.postMessage`·`chat.postEphemeral`)는 그 method의 다음 한 번을 ts 없는 `ok:true`로 답하게 한다. `POST http://mock-slack:4020/fake/answers` `{method, status, body}`는 그 method의 다음 한 번을 `status`와 `body`(문자열이면 text, 아니면 JSON)로 답하게 한다. install 실패(5xx, `ok:false`, 스키마가 다른 답)를 재현할 때 쓴다. `POST http://mock-slack:4020/fake/invites` `{app_id, channel_id}`는 그 앱의 bot을 채널에 넣고(`/invite`) `{ok, bot_user_id}`를 돌려준다. `POST http://mock-slack:4020/fake/removals` `{app_id, channel_id}`는 반대로 그 앱의 bot을 채널에서 빼고 `{ok, bot_user_id}`를 돌려준다(그 뒤 비공개 채널은 bot에게 `channel_not_found`로 보인다). `member_joined_channel`·`member_left_channel` 이벤트는 따로 `/fake/events`로 보낸다. 두 이벤트의 순서는 `event.event_ts`(마이크로초)로 가리므로, 순서를 시험할 때는 `event`에 `event_ts`를 직접 넣는다. `POST http://mock-slack:4020/fake/interactions` `{url, app_id, payload}`는 `payload`에 그 앱의 `api_app_id`를 넣어 Slack의 interactivity form(`payload=<JSON>`)으로 서명해 `url`로 보내고 `{ok, status, body}`를 돌려준다. bot의 `chat.update`·`views.open`·`views.update`는 `GET http://mock-slack:4020/fake/updates`가 `{updates, views, viewUpdates}`로 돌려준다.

**Slack inbox 처리 (`slack` 역할)**

`received` 행은 control host의 `slack` 역할(`main.ts slack`)이 비운다. reconciler와 같은 감독 루프로, pass 하나가 "claim → 처리 → 할 것이 없거나 pass 예산(pass 제한 시간의 절반)이 끝나면 종료"다. `main.ts slack --once`는 pass 하나, `--health`는 상태 파일을 본다. compose에서는 `slack` 서비스(profile `apps`와 `slack`)이고 api image를 쓴다. Helm은 `slack` Deployment다([Kubernetes 배포](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/kubernetes-deployment/)).

| 설정 | 기본 | 의미 |
|---|---|---|
| `SLACK_ROLE_INTERVAL_SEC` | 2 | pass가 끝난 뒤 다음 pass까지 쉬는 시간. 이벤트가 첫 claim까지 기다리는 시간이다 |
| `SLACK_ROLE_PASS_TIMEOUT_SEC` | 60 | 넘긴 pass는 SIGTERM, 10초 뒤 SIGKILL로 끝내고 실패로 센다 |
| `SLACK_ROLE_MAX_CONSECUTIVE_FAILURES` | 3 | 실패 pass가 이만큼 이어지면 루프가 exit 1 한다 |
| `SLACK_ROLE_HEALTH_STALE_SEC` | 90 | 이 시간 동안 성공한 pass가 없으면 unhealthy. interval + timeout보다 커야 기동한다 |
| `SLACK_ROLE_STATUS_FILE` | `/tmp/slack-status.json` | 루프 상태 파일. compose는 넘기지 않는다 |
| `SLACK_ROLE_BATCH_SIZE` | 10 | claim 한 번에 잡는 행 수 상한 |
| `SLACK_ROLE_LEASE_SEC` | 60 | claim한 행을 쥐는 시간. 역할이 죽으면 이 시간이 지난 뒤 다른 pass가 이어 잡는다 |

prefix가 `SLACK_`가 아니라 `SLACK_ROLE_`인 것은 `SLACK_EVENTS_PUBLIC_URL`이 api의 설정이기 때문이다.

- claim(한 transaction, advisory lock으로 claimer 하나씩): `received`이고, lease가 없거나 끝났고, `next_attempt_at`이 없거나 지났고, 같은 `conversation_key`에 더 이른 `received` 행도, lease가 살아 있는 행도 없는 행을 `(event_time, received_at, id)` 순서로 `FOR UPDATE SKIP LOCKED`로 잡는다. 잡으면 `claim_token`을 새로 쓰고 `lease_expires_at = now() + lease`, `attempts + 1`이다. 그래서 한 스레드에서는 앞 이벤트가 끝나야 다음 이벤트를 잡고(뒤늦게 온 더 이른 이벤트도 처리 중인 이벤트를 기다린다), 다른 스레드는 함께 처리한다.
- 끝내기·실패 쓰기는 `id`·`claim_token`이 같고 `lease_expires_at > now()`일 때만 쓴다. lease를 잃은 쪽은 아무것도 쓰지 않고 `Slack event lease lost` 한 줄만 남긴다. lease 판정은 모두 DB의 `now()`다(앱 해제의 superseded 판정과 같은 시계).
- 실패하면 lease를 풀고 `next_attempt_at = now() + backoff`(30초에서 두 배씩, 상한 5분)다. lease 만료로 다시 잡힌 것도 시도로 센다. 5번째 시도가 실패하거나 5번째 lease가 끝나면 `failed`다.
- 처리 전에 그 설치가 지금 `revoked`이면(이벤트가 기다리는 사이 앱이 해제됨) 처리하지 않고 `dropped`·`installation_revoked`로 끝내며 본문과 `conversation_key`를 지운다.
- 처리기는 채널 메시지를 세션에 잇는다(아래 "Slack 스레드와 세션"). 처리기가 끝나면 `processed`, 던지면 위 backoff로 다시 시도한다. 로그는 `Slack event claimed`(id·event_id·종류·시도 횟수)와 pass 요약 `Slack inbox pass`다.
- 기동할 때와 pass마다(`--once`로 손으로 돌린 pass도) api와 같은 DB 설정을 같은 규칙으로 읽는다. `PLATFORM_ALLOW_UNATTENDED_PERMISSIONS=true`가 없으면 api와 같은 규칙으로 `bypassPermissions` profile을 뺀다. credential은 풀지 않는다. 세션 생성은 credential이 어디서 오는지(`value_env`·`secret_id`의 이름)와 profile 설정만 읽는다(`SessionCatalogView`). provider key와 Secrets Manager 접근은 api에만 있다.
- 세션 한도는 api와 같은 설치 한도 변수(`EXECUTION_SLOT_LIMIT`·`QUEUED_INPUT_LIMIT_PER_SESSION`·`STORAGE_LIMIT_BYTES`·`MAX_TURN_SECONDS`·`SESSION_COST_LIMIT_USD`·`PROVIDER_MAX_RETRIES`)로 잰다. compose는 api와 같은 값을, Helm은 `config.limits`를 이 역할에도 준다. 빠지면 pass마다 실패한다.
- master key(`PLATFORM_SECRET_KEY`)는 api와 이 역할에만 간다(bot token으로 Slack에 보내는 일이 이 역할에 붙는다). 값이 없거나 64 hex가 아니면 기동하지 않는다. worker·scheduler·reconciler에는 없다(`tests/images.test.ts`, `deploy/helm/render-check.ts`가 검사한다).
- 0160 이전에 쌓인 `received`·`processed` 행은 migration이 같은 규칙으로 `conversation_key`를 채운다.

**Slack 스레드와 세션**

Slack 스레드 하나는 세션 하나다. 그 묶음이 `session_links`의 행이다(0161). 행은 `(installation_id, surface_ref)`로 하나뿐이고, `surface_ref`는 `<channel>:<thread_ts ?? ts>`다. 행은 그 스레드를 연 binding(`surface_binding_id`), 연 사람(`created_by`), 첫 메시지의 `ts`(`opened_by_ts`), 그때의 활성 release와 그 runtime profile을 담고, 둘은 행이 사는 동안 바뀌지 않는다.

이벤트 하나는 이 순서로 처리한다. 앞에서 끝나면 뒤는 하지 않고 행은 `processed`다.

1. 채널 메시지(`app_mention`·`message`)가 아니면 넘긴다(`member_joined_channel`은 아래 "채널 참가와 배포 환영"). `bot_id`가 있거나 subtype(`thread_broadcast` 말고)이 있거나(수정·삭제), 이 앱의 bot 사용자가 보낸 것이면 넘긴다. events route가 이미 버리는 것들이고, 그 전에 쌓인 행을 위한 이중 확인이다.
2. 에이전트를 다시 해석한다(`agentForSlackEvent`). 다른 team·앱·회수된 신원이면 로그 한 줄로 넘긴다.
3. 스레드에 연결이 없고, bot 멘션(`<@BOT>` 또는 `app_mention`)도 없고, DM도 아니면 넘긴다. 안내도 남기지 않는다. 연결된 스레드의 답글은 멘션 없이도 이어진다. 회수된 연결의 스레드는 새 세션을 만들지 않는다.
4. binding을 읽는다. 채널은 `PUT …/slack-bindings`로 저장한 행이고, DM은 설치의 DM 행이다. DM 행이 없으면 이때 만든다(`mode: mention`, 기본 상한. 동시에 와도 unique와 `ON CONFLICT DO NOTHING` 뒤 다시 읽어 하나다).
5. bot token(`slack_app:<id>/slack_bot_token`, master key로 연다)으로 `users.info`를 불러 보낸 사람을 읽는다. token이 없거나 master key가 없으면 던져서 나중에 다시 한다.
6. 이벤트의 `channel_type`(`channel`·`group`·`mpim`·`im`)이 binding의 `surface_kind`와 다르면(공개 채널이 비공개가 됐을 때) 거절하고 안내를 남긴다(`channel_kind_mismatch`). `app_mention`에는 `channel_type`이 없어 채널 binding이면 `conversations.info`로 Slack에 묻는다.
7. `authorizeSlackInput`(아래 "Slack 멘션·승인 판정")으로 판정한다. 새 스레드는 binding과 활성 release를, 연결된 스레드는 연결 행을 묻는다. release가 binding의 에이전트 것이 아니면 `agent_ceiling`이다. 활성 release가 없으면 경고 로그를 남기고 안내 "이 에이전트는 아직 활성화된 release가 없어요…"(notice 이유 `no_active_release`)를 남긴다. 거절이면 세션 없이 안내를 남긴다. 판정 자체가 실패한 것(`error`)은 그 사람의 거절이 아니라서 던져서 다시 한다.
8. 메시지에서 `<@BOT>`(Slack이 붙이는 `|이름`까지)을 지운다. 남은 글이 없으면 넘긴다.
9. lease를 다시 쥐고(`renew`: `id`·`claim_token`이 같고 lease가 살아 있을 때 `lease_expires_at = now() + lease`) 설치 상태를 같은 문장에서 읽는다. lease를 잃었으면 아무것도 쓰지 않고 던진다(다른 pass가 이미 잡았다). 그 사이 설치가 `revoked`가 됐으면 `dropped`·`installation_revoked`다.
10. 새 스레드면 연결 행을 잡는다: `INSERT … ON CONFLICT DO NOTHING RETURNING`, 없으면 `SELECT … FOR UPDATE`. 동시에 온 첫 메시지 둘도 행 하나를 같이 쓴다.
11. 연결에 세션이 없거나 이 메시지가 연 메시지(`opened_by_ts`)면 `createSession`(idempotency key = 연결 행 id, body `{profile_id, agent_release_id, message}`)으로 만들고 연결 행에 붙인다. 저장소는 GitHub 설정 행이 있는 에이전트에서는 없고, 행이 없는 에이전트에서는 release의 `repository_id`다. 아니면 `appendMessage`(idempotency key `<team>:<channel>:<ts>`, `mode: enqueue`)로 다음 턴을 넣는다. 둘 다 웹·API와 같은 session service 경로다. 세션 쪽 거절(`RATE_LIMITED`·`BACKEND_UNAVAILABLE` 말고)은 안내 "지금은 요청을 처리하지 못했어요"를 남기고 끝낸다. 그 둘은 던져서 다시 한다. 저장소 필수(`repository_mode: required`) 프로필에 저장소 없는 release는 release 단계에서 거절되므로(`422`, `repository_id: Profile <id> needs a repository…`) 이 경로에 오지 않는다. 0173 이전에 만든 release나 프로필이 나중에 저장소 필수로 바뀐 release는 `UNSUPPORTED_CAPABILITY`로, GitHub 설정을 읽을 수 없거나 저장소가 워크스페이스 상한 밖이면 `GITHUB_REFUSED`로 거절된다. 둘 다 `releaseStartable`이 거짓일 때만 안내가 "이 에이전트의 릴리스에 쓸 수 있는 저장소가 없거나(…) 에이전트의 GitHub 설정을 읽을 수 없어 시작하지 못했어요…"이고 notice 이유는 `repository_required`다. 거짓이 아니면 일반 실패 안내다. release의 프로필이 카탈로그에 없거나 바뀌어 `PROFILE_DIGEST_MISMATCH`면 안내는 "이 에이전트의 release가 쓰는 프로필이 지금 카탈로그에 없거나 바뀌어…"이고 notice 이유는 `profile_unavailable`이다. 웹의 에이전트 Slack 화면과 `GET /v1/agents/{id}/slack/app`의 `warnings`(`no_active_release`·`profile_unavailable`·`repository_required`)가 연결 전에 이를 알린다(연결은 막지 않는다).
12. Slack에 스레드 상태를 보낸다: `agents.sessions.setStatus` `{channel_id, thread_ts: <스레드 root>, status: "processing"}`. 세션 쓰기 뒤에 보내서 lease를 다시 쥔 때와 세션 쓰기 사이에 Slack 호출이 끼지 않는다. `not_authorized`·`feature_disabled`·`thread_ts_required`는 그 workspace가 상태를 보이지 않는다는 뜻이라 info 로그, 다른 실패는 warn 로그이고 어느 쪽도 처리를 막지 않는다. `active`로 되돌리는 것은 답을 보내는 outbox(아래 "Slack outbox")다.

- 같은 메시지가 두 번 오는 일(Slack은 채널의 멘션 하나에 `app_mention`과 `message`를 둘 다 보내고, 재시도도 있다)은 key로 막는다. 첫 메시지는 연결 행 id라 두 번째 이벤트가 같은 세션을 돌려받고, 답글은 `<team>:<channel>:<ts>`가 턴과 같은 transaction의 receipt에 남아 두 번째 이벤트가 같은 턴을 돌려받는다. 따로 dedupe 표를 두지 않은 것은 이 key가 세션 쓰기와 한 transaction이라 "기록은 됐는데 턴은 없다"가 생기지 않기 때문이다.
- pass가 연결 행을 잡은 뒤 `createSession` 전에 죽으면 lease가 끝난 뒤 다음 pass가 같은 key로 세션을 만든다. 연 메시지가 5번 다 실패한 채 연결 행에 세션이 없고 다음 답글이 오면, 그 key로 이미 만들어진 세션(receipt)이 있으면 그 세션을 붙이고 답글을 다음 턴으로 넣는다. 없으면 `opened_by_ts`를 그 답글로 넘기고 같은 연결 행 id key로 세션을 연다. 세션 key는 스레드마다 하나뿐이다.
- 세션은 Slack 사람의 연결된 계정(`linked_accounts`의 `(team, user)`)으로 만든다. `created_by_user_id`·1번 턴의 `actor_id`가 그 사람이고 `channel`은 `slack`이며, 판정 행(`authz_decisions`)에 `linked_account_id`가 남는다. DM 세션은 공유 범위 `private`로 시작한다(만든 사람만 본다. owner·admin은 위 "세션 공유 범위와 감사 열람"의 두 길로만 다룬다. `GET /v1/sessions/{id}/share`로 확인한다). 채널 세션은 웹과 같은 기본 범위다.
- 세션의 실행(worker claim·provider 호출)은 api와 worker가 한다. provider credential은 그때 api가 푼 catalog로 정해지므로, `slack` 역할이 만든 세션도 api의 key로 돈다.
- 거절 안내는 `SlackNoticeSink`가 받아 outbox에 `notice` 행으로 넣는다(아래 "Slack outbox"). 그 사람에게만 ephemeral로, 한 번만 보낼 key `<installation_id>:<surface_ref>:<slack_user_id>`로 스레드당 한 번 간다. 담는 것: workspace·에이전트·설치·`slack_app_id`·channel·스레드 root `thread_ts`·Slack user·문구(`SlackNotice`).

| 설정 | 기본 | 의미 |
|---|---|---|
| `CONSOLE_ORIGIN` | 없음 | 안내의 연결 링크(`<콘솔 origin>/settings/linked-accounts`)와 답의 세션 링크(`<콘솔 origin>/sessions/<id>`)를 이 값으로 만든다. 없으면 링크 없이 문구만 남는다 |

`SLACK_API_URL`과 `SLACK_OIDC_ISSUER`는 운영 설정이 아니다. Slack을 가짜로 바꾸는 mock Slack 시험 전용(`infra/compose.mock-slack.yml`)이라 운영 설정 목록에 싣지 않는다. 운영에서 Slack이 아닌 곳을 가리키면 시작할 때 경고를 남기고, 동작은 그대로다.

**Slack outbox**

`slack` 역할이 Slack에 보내는 글은 모두 `slack_outbox`(0164) 행 하나다. 같은 pass에서 inbox를 비운 뒤 같은 pass 예산 안에서 outbox를 비운다. inbox는 예산의 절반에서 멈추므로 멘션이 쉬지 않고 와도 답이 밀리지 않는다. 행 종류는 `reply`(턴의 답), `failure_notice`(모델이 끝내 실패한 턴, 또는 보냈는지 모르는 답), `input_notice`(세션이 기다리는 요청 하나의 카드: 도구 권한·질문·`requested` push), `notice`(거절 안내), `welcome`(배포 환영, 스레드 없이 home 채널에. 0165)이다. 행마다 `dedupe_key`가 unique라 같은 키는 한 번만 들어간다: `reply:<session_link_id>:<turn>`, `failure:…`, `prompt:<session_link_id>:<request_id>`, `push:<session_link_id>:<push_request_id>`, `notice:<onceKey>`, `deployment-welcome:<agent>:<home_binding>`(예전 행은 `deployment-welcome:<agent>:<release>:<home_binding>`).

- 답 찾기: pass마다 살아 있는(회수·mute 안 됨, `visibility=full`) 연결의 세션에서 끝난 턴(`completed`·`failed`·`outcome_unknown`) 중 행이 없는 것을 읽어 넣는다. 연결보다 먼저 만든 턴은 넣지 않는다. 연결마다 `session_links.answered_through`(표시)까지의 턴은 더 할 일이 없는 턴이라 다시 읽지 않는다. 표시는 행이 있는 턴, `interrupted`·`cancelled` 턴, 연결보다 먼저 끝난 턴을 이어서 넘기고, 아직 도는 턴이나 승인 대기 턴에서 멈춘다. 그래서 pass 비용은 쌓인 턴 수가 아니라 남은 턴 수와 연결 수를 따른다. 역할이 오래 멈췄어도 다시 뜨면 밀린 턴의 답을 각 스레드에 한 번씩 보낸다. 답 글은 마지막 attempt의 top-level(`parent_tool_use_id`가 없는) assistant 이벤트 중 마지막 tool 호출 뒤의 글이다. 지연은 pass 간격만큼이다. 세션 쪽 코드는 outbox를 모른다.
- 글: 792a의 `escapeSlackControls`로 `<!here>`·`<!channel>`·`<!everyone>`·`<!subteam^…>`·`<#C…>`·`<@U…>`·중첩 `<`·backtick이 든 control·짝 없는 `<`를 글자로 바꾼다. 그래서 Slack이 받는 글의 날 `<`는 허용한 control의 것뿐이다. Slack은 backtick 안의 `<!here>`도 멘션으로 읽으므로, 닫힌 code span·code block 안은 `&`·`<`·`>`를 모두 글자로 바꾸고 멘션 허용(요청자 멘션 포함)도 적용하지 않는다. 안전한 masked link `<url|label>`은 `label (url)`로 풀어 써서 label이 주소를 숨기지 못한다(`maskedLinks: "expand"`). 답은 그 턴을 요청한 사람의 연결된 Slack 계정 멘션만 남긴다. 끝에 콘솔 세션 링크 하나를 붙이고, 40,000자(Slack `chat.postMessage` `text` 한도)를 넘으면 잘라서 `…`와 링크를 붙인다. 한 턴은 메시지 하나다.
- 요청: `chat.postMessage` `{channel, thread_ts: <스레드 root>, text, link_names: false, unfurl_links: false, unfurl_media: false}`, 안내는 `chat.postEphemeral` `{channel, user, thread_ts, text, link_names: false}`. 보내기 직전(claim)에 설치가 회수되지 않았는지, 세션 행이면 그 스레드의 연결이 살아 있고 mute·`summary`가 아닌지, 카드면 그 요청에 아직 답할 수 있는지(push는 아직 `requested`인지) 다시 본다. 기다리는 사이 바뀌었으면 보내지 않고 `failed`(`not_addressed`)로 닫는다. bot token은 inbox와 같은 `slack_app:<id>/slack_bot_token`이다. master key가 없으면 행을 넣기만 하고 보내지 않는다.
- 상태: `pending` → claim(`FOR UPDATE SKIP LOCKED`, `claim_token`, `lease_expires_at = now() + SLACK_ROLE_LEASE_SEC`, 행은 아직 `pending`) → 요청 직전에 `sending`과 `attempts + 1` → 결과. 보내기 전에 lease가 끝난 claim은 시도로 세지 않는다. bot token을 읽지 못해 미룬 경우(`no_bot_token`)는 한 번으로 센다. 일시 실패와 같은 backoff를 쓰고 5번째 시도에서 `failed`다. 결과 판정은 792a `classifySlackSendResult`다. 성공은 `sent`(Slack `ts` 저장), 영구 오류는 `failed`(`error_code` 저장), 그 밖의 실패는 `pending`과 backoff(30초에서 두 배, 상한 5분, DB 시계)이고 5번째 시도에서 `failed`다. 429·`ratelimited`는 `Retry-After`만큼(5분으로 자름) 뒤로 미루고, 429도 시도로 세되 상한은 10번이다. 쓰기는 `id`·`claim_token`이 같을 때만 한다.
- `uncertain`: Slack이 그 글을 가졌을 수 있어 다시 보내지 않는 행이다. `sending`인 채 lease가 끝난 행(보내는 도중 역할이 죽음), 응답 없이 끊긴 요청, 2xx나 5xx인데 본문을 읽을 수 없는 응답(`unreadable_answer`)이 여기로 간다. 4xx는 본문을 읽지 못해도 status와 `Retry-After`로 판정한다. 그래서 429는 `pending`으로 돌아간다. ts 없는 `ok:true`는 `failed`(`missing_ts`)이고 역시 다시 보내지 않는다. lease가 끝난 행은 다음 pass가 `Slack send outlived its lease; marked uncertain` 한 줄을 남긴다. 어느 쪽이든 답이면 스레드에 "답을 보냈는지 확인하지 못했어요. 웹에서 확인해 주세요"와 세션 링크를 한 번 보낸다.
- 요청 카드: pass마다 살아 있는 연결의 세션에서 아직 답할 수 있는 권한·질문 요청과 `requested`인 push 요청 중 행이 없는 것을 넣는다. 카드는 요청자를 멘션하고, 모델이 쓴 글(도구 이름·입력, 질문, 브랜치)은 `plain_text`·preformatted 블록에만 넣어 멘션이나 링크가 되지 않는다. 버튼 값은 `{s: <session>, r: <request>, o?: <option index>}`이고 서버가 누를 때 다시 판정한다. 처리되면 interactivity route가 카드를 바꾼다.
- 답·실패 안내가 끝나면(`sent`·`failed`·`uncertain`) `agents.sessions.setStatus` `active`로 "생각 중" 표시를 지운다. 보내는 도중 lease가 끝난 실패 안내도 다음 pass가 상태를 지운다(lease가 끝난 답은 뒤따르는 안내가 지운다). 이 호출이 실패해도 행 상태는 그대로이고 warn 로그만 남는다. 요청 카드와 거절 안내는 상태를 바꾸지 않는다.
- 로그는 pass 요약 `Slack outbox pass`(넣은 수·claim·sent·retried·failed·uncertain)와 보내지 못한 행의 `Slack send not delivered`(id·종류·channel·시도·상태·오류 코드)다. 글·token은 로그와 행에 남지 않는다(행의 `body`는 escape 전 원문이다).
- 행 확인: `select kind, status, attempts, error_code, thread_ts from slack_outbox order by seq`. `seq`는 보내는 순서다. 같은 시각에 들어간 행도 들어간 순서대로 나간다.

### 에이전트의 Slack 채널 설정

에이전트가 어느 채널에서 답하는지는 `surface_bindings`의 행이다. 행은 에이전트 앱 설치의 채널 하나를 가리킨다. DM은 설치마다 행 하나가 모든 DM을 맡고, 채널 id가 없다(`surface_kind: dm`). 채널 이름은 저장하지 않는다.

- 설정: `PUT /v1/agents/{id}/slack-bindings` `{channel_id, mode, home?, ceiling?}` → `200`, 행 전체와 `set_surface_binding` receipt. 같은 채널의 행을 통째로 바꾸고, 처음이면 만든다. DM은 `{"channel_id": null, ...}`이다. DM 행은 첫 DM이 올 때 `slack` 역할이 기본값으로 만들기도 한다.
  - 채널의 종류(`surface_kind`)는 서버가 에이전트 앱의 bot token으로 `conversations.info`를 불러 정한다: `is_im`이면 DM, `is_private`·`is_mpim`이면 `private_channel`, 아니면 `public_channel`. 요청의 `channel_kind`는 받기는 하지만 쓰지 않는다. 채널 id가 DM이면 `400`, Slack이 모르는 채널이거나 scope가 모자라면 `400`(`details.slack_error`), Slack이 닿지 않으면 `503`, bot token·master key가 없으면 `409 SLACK_NOT_INSTALLED`다. 그룹 DM은 bot scope에 `mpim:read`가 없어 `400`(`missing_scope`)이다.
  - `mode`: `off`(그 채널은 아무것도 받지 않는다) 또는 `mention`. `ambient`는 `400`이다.
  - `home: true`: 이 채널이 에이전트의 home이 되고, 이전 home은 꺼진다. 에이전트당 home은 하나다. DM은 home이 될 수 없다(`400`).
  - `ceiling`: 채널 상한 `{actions, disclosure}`. 빠지면 기본값(Slack 동작 넷 전부, `full`)이다. 행마다 칸으로 저장한다.
  - 에이전트에 살아 있는 Slack 앱 연결이 없으면 `409 SLACK_NOT_INSTALLED`, 같은 채널이나 home을 동시에 바꿨으면 `409 REVISION_CONFLICT`다.
  - bot이 채널에 들어가지 않아도 행은 저장된다. 저장 뒤 서버가 참가를 확인하고 결과를 행의 `membership`에 남긴다(아래 "채널 참가와 배포 환영"). 채널이 나중에 비공개로 바뀌면 그 채널의 메시지는 `channel_kind_mismatch`로 거절된다. 다시 PUT하면 새 종류로 저장된다.
- 목록: `GET /v1/agents/{id}/slack-bindings`(home 먼저, 오래된 것 먼저, 500개). 각 행은 `external_surface_id`(채널 id), `surface_kind`, `mode`, `home`, `ceiling`, `status`, `membership`(확인한 적이 있을 때만), `revision`을 담는다.
- 권한: owner·admin·그 에이전트 관리자(`binding.manage`). member와 다른 에이전트의 관리자는 `403`이다. owner·admin이 없는 에이전트를 가리키면 `404`다. API key는 쓸 수 없다.

```bash
curl -s -b jar -X PUT "http://127.0.0.1:3000/v1/agents/$AGENT_ID/slack-bindings" \
  -H 'X-Requested-With: werft-web' -H 'Content-Type: application/json' \
  -d '{"channel_id":"C0OPS","mode":"mention","home":true}'
```

채널 고르기 화면은 `GET /v1/agents/{id}/slack/channels?q=&cursor=&limit=`로 채널을 찾는다. 서버가 에이전트 앱의 bot token으로 Slack `conversations.list`(Tier 2)를 200개씩 끝까지 읽어, 공개 채널 전부와 bot이 이미 들어간 비공개 채널을 이름순으로 api 프로세스 메모리에 60초 둔다. 앱당 10,000개까지 두고 넘으면 `truncated: true`, 앱은 500개까지 두고 가장 오래 안 쓴 것부터 버린다. 같은 프로세스에서 binding을 `PUT`하면 그 앱의 목록을 버리고, 다른 replica는 60초를 기다린다. `q`는 채널 이름의 접두어다(대소문자 무시, 앞의 `#`는 뗀다). `limit`은 기본 20, 최대 50이고 넘으면 `400`이다. 각 항목은 `{id, name, is_private, is_member}`다. 다음 페이지는 `next_cursor`를 같은 `q`와 함께 `cursor`로 넘긴다. 이 cursor는 서버의 것이라 Slack cursor가 아니고, 그 목록이 새로 읽혀 바뀌었으면 `400 CURSOR_EXPIRED`다. 처음부터 다시 검색한다. Slack이 `429`를 주면 `Retry-After`까지 Slack을 다시 부르지 않는다. 그동안 읽어 둔 목록이 있으면 그것을 `stale: true`로, 없으면 `503`과 Slack의 `Retry-After`를 돌려준다. 앱이 없거나 bot token이 없거나 Slack이 token을 거절하면 `409 SLACK_NOT_INSTALLED`, 다른 workspace의 에이전트는 `404`다. 권한은 위 binding과 같다. api 로그 `Slack channels searched`에는 `agent_id`·`slack_app_id`·`cache`(`hit`·`miss`·`stale`)·`count`만 남고 token은 남지 않는다.

```bash
curl -s -b jar "http://127.0.0.1:3000/v1/agents/$AGENT_ID/slack/channels?q=dev&limit=5"
# {"items":[{"id":"C…","name":"dev","is_private":false,"is_member":true},…],"next_cursor":"eyJ…","truncated":false,"stale":false}
```

### 채널 참가와 배포 환영

콘솔에서 고른 채널(home과 `mention` 채널)은 bot이 들어가도 된다는 뜻으로 본다. 서버가 bot을 그 채널에 넣고, 에이전트의 새 release가 배포되면 home 채널에 메시지를 한 번 보낸다.

- 참가: `conversations.info`의 `is_member`로 bot이 채널에 있는지 본다. 공개 채널이면 `conversations.join`(`channels:join`)으로 들어간다. 비공개 채널은 Slack이 bot의 자가 참가를 막으니 `/invite @<bot>`을 기다린다. `mode: off`인 채널과 DM 행은 건너뛴다. 참가는 binding 저장(`PUT …/slack-bindings`) 직후와 설치 마무리 ②에서 돈다. 다시 돌려도 결과가 같다.
- 결과는 binding 행의 `membership` `{state, error}`(0165)다. `joined`, `awaiting_invite`(비공개라 초대를 기다림, 또는 Slack이 채널을 보여 주지 않음: `channel_not_found`), `config_error`(`missing_scope`·`invalid_auth` 같은 token·scope 거절이라 초대 여부를 알 수 없음), `join_failed`(`is_archived`, 정책 거절 `restricted_action` 등)이고 `error`는 Slack 오류 코드다. Slack이 답하지 않거나 429면 아무것도 남기지 않는다. 이 값은 설정이 아니라 본 것이라 `revision`과 receipt를 바꾸지 않는다.
- 초대: bot이 채널에 들어오면 Slack이 `member_joined_channel`을 보낸다. `slack` 역할은 들어온 사람이 이 앱의 bot이고 그 채널에 binding이 있으면 `membership`을 `joined`로 바꾸고, home이면 환영을 넣는다. 다른 사람의 참가는 넘긴다.
- 퇴장: bot이 비공개 채널에서 나가거나 쫓겨나면 Slack이 `member_left_channel`을 보낸다(이 이벤트가 bot 자신의 퇴장에도 오는지는 실제 Slack으로 확인해야 한다). `slack` 역할은 나간 사람이 이 앱의 bot이고 그 채널의 binding이 `private_channel`이면 binding을 `left`("봇이 채널에서 나감")로 바꾼다. `left`는 비활성이다. 그 채널의 입력은 받지 않고, 그 채널로는 아무것도 보내지 않는다. 수신 쪽은 메시지·멘션을 본문 없이 `channel_left`로 버리고 알림도 보내지 않으며, 버튼과 모달도 조용히 끝난다. 송신 쪽은 outbox의 답장·알림·카드 갱신과 스레드 상태가 모두 막히고, 이미 쌓인 행은 `not_addressed`로 닫힌다(`pending_approval`은 알림 한 건만 통과시키지만 `left`는 bot이 채널에 없으니 알림도 막는다). 바뀌는 것은 home이 아니게 되고 `approved_at`과 승인 워터마크가 비며 `membership`이 `awaiting_invite`가 되는 것, `revision`이 오르는 것, 설치가 낸 `set_surface_binding` receipt(`reason: bot_left_channel`, `previous_status`, `lifecycle_us`)가 남는 것이다. `mode`와 한도는 그대로 둬서 다시 승인되면 이전처럼 동작한다. 승인 대기(`pending_approval`) 중이던 binding도 `left`가 되고, 같은 leave가 다시 와도 receipt는 한 번이다. API는 `GET …/slack-bindings`에서 `status: "left"`를 돌려준다(새 경로 없음). `left`는 승인·거절 대상이 아니라 `approve`·`reject`가 409 `REVISION_CONFLICT`로 답한다. 콘솔 저장(`PUT`)은 `left`를 유지하고(`mode`·한도만 바뀌며 `home: true`는 400), Slack이 공개 채널로 답한 채널이면 `ready`로 돌아간다. 다시 초대되면 마지막 leave보다 엄격히 새롭고 시각이 있는 join에서만 `pending_approval`로 가고(`reason: rejoined_channel`) owner·admin이 다시 승인해야 입력을 받는다. leave와 같은 시각이거나 시각이 없는 join은 순서를 가릴 수 없어 `left`로 둔다. 공개 채널의 binding과 binding이 없는 채널은 건드리지 않는다. 승인이 그 leave를 알고 있었는지는 서버 시계가 아니라 Slack 시각만으로 가린다. 승인할 때 그 채널에서 마지막으로 본 join·leave 시각을 `surface_bindings.approved_lifecycle_us`에 적어 두고(본 것이 없으면 0), leave가 그 값 이하이면 승인이 이미 알던 일이라 `ready`로 유지하고, 그보다 크면 승인을 무효로 한다. 채널에서 마지막으로 본 이벤트보다 새 leave는 `left`가 되고, 이미 본 join보다 오래된 늦은 leave(다시 초대를 먼저 처리한 뒤 도착해 bot이 지금 안에 있다)는 `left`가 아니라 `pending_approval`(`reason: bot_left_channel`)이 된다. 시각이 없는 leave는 보수적으로 무효로 해 `left`로 둔다. 이미 `left`인 binding에 오래된 leave가 늦게 와도 바뀌는 것은 없다. 같은 이유로 `membership`이 `joined`로 기록된 승인된 비공개 채널에 마지막으로 본 시각보다 새 join이 오면 놓친 leave가 있었다는 뜻이므로(Slack은 이미 있는 멤버에게 join을 보내지 않는다) leave를 기다리지 않고 바로 승인 대기로 되돌린다(`reason: rejoined_channel`). 이 판단은 Slack에 채널 종류를 묻기 전, join의 첫 확인(`observeLifecycle`)에서 한 트랜잭션으로 하므로 Slack 조회가 실패해도 그 사이 멘션은 답하지 않는다. 같은 시각의 join은 이미 본 이벤트의 재시도라 되돌리지 않고, 시각이 없는 join(Slack의 실제 이벤트에는 없는 경우)은 재시도와 구분할 수 없어 `membership`과 상관없이 되돌린다. bot이 채널에 있다고 보는 근거는 둘이다. 하나는 `slack_channel_lifecycle`에 적은 마지막 join·leave 시각(`last_join_us`·`last_leave_us`)으로, Slack 조회가 실패했어도 본 join은 남고 그 뒤 leave가 없으면 안에 있는 것이다. 다른 하나는 binding의 `membership`이 `joined`인 것이다. 둘 다 아니면 그 join은 첫 입장으로 본다. 승인 서비스가 Slack 조회로 `joined`를 먼저 기록한 뒤 첫 join 이벤트가 늦게 오면 승인이 한 번 취소될 수 있다. 안전한 쪽으로 틀리는 것이라 그대로 두었고, owner·admin이 다시 승인하면 된다.
- 이벤트 순서: join·leave 이벤트에는 `ts`가 없어 inbox의 순서 제어를 받지 못한다. 그래서 설치·채널마다 마지막으로 본 시각을 `slack_channel_lifecycle.last_event_us`(마이크로초 정수)에 둔다(binding이 회수돼도 남는다). 시각은 `event.event_ts`(`<초>.<마이크로초>`), 없으면 envelope의 `event_time`이고, 둘 다 없으면 순서를 가리지 않고 적용한다. 이미 본 시각보다 이른 join은 아무것도 바꾸지 않고 처리된 것으로 끝낸다. 이른 leave는 `membership`을 건드리지 않지만, 위처럼 승인이 알지 못한 leave면 승인은 무효로 한다. `event_ts`가 안전한 정수 범위(2^53 미만의 마이크로초)를 넘으면 envelope 시각을 쓴다. 같은 시각은 통과하므로 재시도된 이벤트는 효과를 다시 낸다. leave의 시각 확인과 binding 변경, join의 마지막 `membership` 기록(`recordJoin`)은 각각 한 트랜잭션이라, 확인과 기록 사이에 들어온 더 늦은 leave를 join이 덮어쓰지 못한다.
- 환영: outbox `welcome` 행 하나다. `chat.postMessage`를 스레드 없이(`thread_ts` 없음) home 채널에 보내고 스레드 상태는 건드리지 않는다. 글은 "안녕하세요, <에이전트 이름>입니다. 이 채널에 연결됐어요. 멘션하면 답할게요"이고, 이름도 outbox가 escape하니 멘션이 생기지 않는다. 에이전트마다 채널당 한 번이다. key는 `deployment-welcome:<agent>:<home_binding>`이라 새 release·같은 정의 재제출·rollback·home을 원래 채널로 되돌리기 모두 새 행이 없다. 넣기 전에 같은 에이전트·같은 Slack team(`slack_installations.team_id`)·같은 `channel_id`의 `welcome` 행이 상태와 상관없이 하나라도 있으면 `duplicate`다. 그래서 설치 연결을 끊었다 다시 이어 binding이 새로 생겨도, release마다 key가 달랐던 예전 행이 있어도 다시 보내지 않는다. `failed` 행도 센다: 끝내 보내지 못한 인사는 그 채널에 다시 가지 않는다. home을 아직 인사하지 않은 채널로 옮기면 그 채널에 한 번 간다.
- 언제 넣나: 새 release 활성화, home 지정(`home: true` 저장), 설치 마무리 ②, home 채널 초대. 활성화가 이전 release보다 먼저 만든 release로 돌아가는 rollback이면 그 release를 알린 적이 없어도 넣지 않는다. 같은 release를 다시 활성화하면(`receipt_id: null`) 아무 일도 없다.
- 넣는 조건: home이 있고 `mode`가 `off`가 아니며 `membership`이 `joined`일 때만이다. bot이 없는 채널에 넣은 행은 `not_in_channel`로 영구 실패해 같은 key를 다시 쓸 수 없기 때문이다.
- 활성화 응답은 Slack을 기다리지 않는다. home의 `membership`이 이미 `joined`면 활성화 응답 전에 행을 넣는다(DB 쓰기 하나). 아니면 응답을 돌려준 뒤 참가를 확인하고, 그 결과가 `joined`면 넣는다. 환영이나 참가가 실패해도 활성화·binding 저장·설치는 실패하지 않는다. 결과는 binding의 `membership`과 api 로그 `Deployment welcome not enqueued`·`Deployment welcome failed`(agent·release·상태·channel만)에 남는다.
- 이미 설치된 앱은 manifest를 다시 보내고 다시 설치해야 `channels:join`이 생긴다(`reinstall_required`). 그 전의 참가는 `config_error`(`missing_scope`)다.
- 행 확인: `select kind, status, channel_id, thread_ts, dedupe_key from slack_outbox where kind = 'welcome' order by seq`, `select external_surface_id, home, membership, membership_error from surface_bindings where agent_id = '<agent>' and revoked_at is null`.

### Slack 멘션·승인 판정과 guest 설정

Slack 채널은 멘션·스레드 답글·승인 버튼마다 `authorizeSlackInput(deps, input)`(`@werft-ai/platform`) 하나를 부른다. 이 함수가 판정을 끝까지 한다: 에이전트 해석(`agentForSlackEvent`), 말하거나 누른 Slack 계정의 연결 해석(`resolveLinkedSubject`), `authorize`, 거절 안내 문구. 승인 버튼은 요청자가 아니라 **누른 사람**의 Slack user로 같은 함수를 부른다(`action: "session.approve"`). 누른 사람이 그 세션에 답할 사람(만든 사람, 에이전트 관리자, owner·admin)이 아니면 `role`로 거절되고 "이 요청을 승인할 권한이 없어요" 안내가 간다.

- 입력: `event`(`appId`·`teamId`, URL이 가리키는 `agentId`), `user`(Slack user 객체의 `id`·`team_id`·`is_restricted`·`is_ultra_restricted`·`is_stranger`·`is_external`), `action`(`session.read`·`submit`·`control`·`approve`), `channel`(이벤트의 채널 `id`와 DM인지 `dm`), `resource`(새 대화는 `surface_binding`과 그 대화가 돌 `releaseId`, 연결된 스레드의 다음 메시지는 `session_link`와 연결 행 id, 버튼은 `session`), `connectUrl`(웹의 Slack 연결 화면). `releaseId`가 binding의 에이전트 release가 아니거나 없는 release면 `agent_ceiling`이다.
- 결과: `dropped`(이유는 위 표)이거나 `decided`와 `decision`·`actorUserId`(진행할 때만)·`notice`(그 사람에게만 스레드마다 한 번 보일 문구, 없으면 `null`).
- 채널 상한은 저장된 binding(위 "에이전트의 Slack 채널 설정")에서 읽는다. DM은 설치의 DM 행을 읽는다. 행이 없거나 `mode: off`이거나 회수됐으면 그 채널의 상한은 비어 있고 `surface_ceiling`으로 거절한다(버리지 않고 판정을 남긴다). 상한은 좁히기만 한다: 결과 권한은 사람의 역할, installation 상한(`session.read`·`submit`·`control`·`approve`), 채널 상한의 교집합이다. 복구·공유 범위 변경·감사 열람·관리 목록·삭제는 Slack에서 할 수 없다.

판정 순서와 안내 문구는 다음과 같다. 위에서 먼저 걸리는 것이 이유가 된다.

| 순서 | 이유 코드 | 사용자가 보는 것 |
|---|---|---|
| Slack Connect 외부 사용자(`is_stranger`·`is_external`, 또는 설치와 다른 `team_id`). guest 설정과 상관없다 | `external_user` | 이 에이전트는 이 워크스페이스 멤버만 쓸 수 있어요 |
| guest(`is_restricted`, 단일 채널 guest는 `is_ultra_restricted`도)인데 설정이 꺼져 있다 | `guest_disabled` | 이 워크스페이스는 guest의 에이전트 사용을 허용하지 않아요 |
| 연결이 없거나 해제됐다 | `unlinked` | 웹에서 Slack 계정을 연결해 주세요 + 연결 링크 |
| 연결이 stale이거나 해석 뒤 바뀌었다 | `stale_link` | 같은 문구와 연결 링크 |
| 사람이 비활성(오프보딩)이다 | `disabled` | 이 채널에서 이 에이전트에게 요청할 권한이 없어요 |
| 역할·installation·채널 상한에 없다 | `role` · `surface_ceiling` | 같은 문구. 승인 버튼이면 "이 요청을 승인할 권한이 없어요" |
| 세션이 이 앱의 에이전트 것이 아니다(같은 workspace의 다른 에이전트 세션, 또는 에이전트를 알 수 없는 대상) | `agent_ceiling` | 같은 문구 |
| 세션이 이 워크스페이스에 없다 | `not_found` | 이 세션은 공유 범위 밖이라 요청할 수 없어요. 세션을 만든 사람에게 공유를 요청하세요 |
| 새 세션의 자격 연결이 없다 | `credential_unbound` | 연결 설정이 바뀌어 시작하지 못했어요. 에이전트 관리자에게 문의하세요 |

공개 상한이 요약까지(`disclosure: "summary"`)인 채널의 읽기는 거절이 아니라 `redact`(`reason_code: surface_ceiling`, `redact: {view: "summary"}`)다. 채널은 본문 대신 요약과 웹 링크를 보이고, 웹은 링크를 연 사람을 다시 판정한다. 같은 채널의 요청·승인은 좁아지지 않는다. Slack 입력과 승인은 허용도 모두 `authz_decisions`에 남고, 거절과 redact도 남는다. 이 기록을 쓰지 못하면 허용과 redact 모두 `error`로 거절한다(안내는 "지금은 요청을 처리하지 못했어요. 잠시 뒤 다시 시도해 주세요"). 판정 행의 `policy_version`은 `m15`다.

guest 사용 설정은 `workspace.settings.slack_guest_enabled`(기본 `false`)다. owner·admin이 cookie 세션으로 바꾼다.

```bash
curl -s -b jar -X POST "http://127.0.0.1:3000/v1/workspaces/$WORKSPACE_ID/slack-guest" \
  -H 'X-Requested-With: werft-web' -H 'Content-Type: application/json' \
  -d '{"slack_guest_enabled":true}'
```

member는 `403`(`details.reason_code: role`), 다른 workspace는 `404`다. 켜도 guest는 Slack 계정을 연결해야 쓴다. Slack은 에이전트 기능(`agent_view`)을 켠 앱을 guest에게 막으므로, 이 설정은 그 기능을 끈 앱에만 의미가 있다. 이 경우 guest는 이 안내 대신 Slack의 차단 화면을 본다.

### 판정 감사와 보존 기간

권한 판정(`authorize`)은 기록할 것을 `authz_decisions`에 한 행씩 남긴다. 거절(`deny`)·`redact`·`require_approval`은 모두 남는다. 허용은 관리 action(`workspace.manage`·`audit_retention.manage`·`member.manage`·`team.manage`·`api_key.manage`·`api_key.manage_own`·`agent.create`·`agent.manage`·`agent.restore`·`agent.admin.manage`·`credential.bind`·`binding.manage`·`routine.manage`·`account.link`), 승인(`session.approve`), Slack 입력(Slack 표면의 `session.submit`)만 남는다. 에이전트 읽기(`agent.read`·`agent.settings_read`)의 허용은 남지 않는다. route edge의 scope 부족 403도 같은 판정을 거쳐 남는다. 행의 `request_id`는 응답의 `X-Request-Id`이고, 그 요청이 만든 receipt의 `receipts.request_id`와 같다. 그래서 "누가 시켰나"는 receipt에서 `request_id`로 판정 행을 찾아 답한다.

```sql
SELECT d.at, d.principal_kind, d.principal_id, d.actor_user_id, d.action, d.outcome, d.reason_code, r.id AS receipt_id, r.operation
FROM authz_decisions d LEFT JOIN receipts r ON r.request_id = d.request_id
WHERE d.request_id = '<X-Request-Id>';
```

행은 고칠 수 없다(UPDATE는 trigger가 거절한다). 기록해야 하는 허용을 기록하지 못하면(DB 오류) 그 요청은 거절된다. 거절은 기록에 실패해도 원래 사유(`404`·`403`)를 그대로 돌려준다.

보존 기간은 워크스페이스마다 `settings.audit_retention_days`이고 기본 90일이다. owner만 cookie 세션으로 바꾼다(`audit_retention.manage`). 30일 미만이나 3650일 초과는 `400`이고, admin·member·API key는 `403`이다. 지금 값은 `GET /v1/auth/me`의 `workspace.settings`에서 읽는다. 보존 기간이 지난 행은 reconciler pass마다 오래된 것부터 `RECONCILER_BATCH_SIZE`개씩 지운다(`RECONCILER_DRY_RUN=true`면 세기만 한다). 워크스페이스가 없는 행(workspace에 묶이지 않은 legacy key)은 기본 90일을 따른다.

```bash
curl -s -b jar -X POST "http://127.0.0.1:3000/v1/workspaces/$WORKSPACE_ID/audit-retention" \
  -H 'X-Requested-With: werft-web' -H 'Content-Type: application/json' \
  -d '{"audit_retention_days":60}'
```

### 세션 실행 권한 회수와 복구

API key 폐기(`keys revoke`)는 그 key로 오는 요청과 열려 있던 SSE만 끊고, 이미 돌고 있는 세션의 worker는 건드리지 않는다. 한 세션의 실행을 거두려면 grants CLI를 쓴다. Grant 관리 API나 UI는 없다. keys CLI와 같은 곳(API 이미지 안, 같은 DB)에서 실행하고, `--reason`은 필수다. 이유는 세션 이벤트(`execution_revoked`·`execution_restored`)에 운영자 행위로 남는다.

```bash
# compose(apps profile): api 컨테이너 안에서 실행한다
bun run grants revoke <session_id> --reason "leaked credential"
bun run grants restore <session_id> --reason "rotated; safe to resume"
# host에서 도는 API라면
DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
  bun run --cwd apps/control-host grants revoke <session_id> --reason "…"
```

**revoke**는 한 transaction에서 다음을 한다. 다른 세션과 owner 계정은 건드리지 않는다.
- 세션의 auth_revision과 epoch를 올린다. 현재 binding의 fenced write는 무엇으로 인증했든 여기서부터 실패한다.
- 세션의 worker token을 폐기한다. worker의 다음 요청은 401이다.
- 현재 generation의 kill intent를 terminate와 같은 방식으로 남긴다.
- dispatch를 막는다. owner의 resume과 start_fresh도 403이다.

receipt는 execution이 사라진 것이 관측될 때까지 `accepted`로 남고, terminate 기한을 넘기면 `unknown`이 된다. 기한을 넘긴 receipt가 밀려 있으면 scheduler와 reconciler pass가 오래된 것부터 한 batch씩 마감하므로 몇 pass 늦어질 수 있다.

**restore**는 차단만 푼다. 올라간 auth_revision, 폐기된 token, 세션이 도달한 admission 상태(stopped 또는 recovery_required)는 그대로다. 이어서 하려면 terminate 뒤처럼 owner가 resume하거나 운영자가 recovery를 결정한다. 회수한 execution이 아직 살아 있을 수 있으면 restore는 거부된다. scheduler가 kill을 끝내고 execution이 사라진 것이 관측된 뒤 다시 실행한다.

결과는 아래 표의 한 줄이다. 성공이면 stdout에 쓰고 exit 0, 거부면 stderr에 쓰고 exit 1이다. 같은 명령을 다시 실행해도 안전하다. 인자 오류나 DB 오류는 표에 없는 여러 줄 오류(stack 포함)로 stderr에 나오고 exit 1이다.

| 줄 | exit | 뜻 |
|---|---|---|
| `revoked <id> owner=… auth_revision=… execution=<id\|none> credentials_revoked=<n> receipt=… receipt_status=<accepted\|succeeded>` | 0 | 회수했다. `receipt_status`는 kill을 기다릴 execution이 있으면 `accepted`, 없으면 곧바로 `succeeded`다 |
| `already_revoked <id> revoked_at=… reason="…"` | 0 | 이미 회수된 세션이다. 아무것도 바꾸지 않는다 |
| `restored <id> owner=…` | 0 | 차단을 풀었다 |
| `not_revoked <id>` | 0 | 지금 회수된 상태가 아니다(이미 복구된 세션 포함). 아무것도 바꾸지 않는다 |
| `session <id>: execution <id> has not been observed gone; restore once it has` | 1 | restore 거부. 잠시 뒤 다시 실행한다 |
| `session <id> not found` | 1 | 그런 세션이 없다 |
| `session <id> is closed` | 1 | 닫힌 세션은 회수할 것이 없다 |
| `session <id> runs on a legacy pod binding with no kill path` | 1 | legacy binding이라 kill 경로가 없다 |

`session_id`는 UUID여야 한다. 인자가 틀리거나 `--reason`이 비어 있으면 DB에 연결하기 전에 사용법이 담긴 오류로 끝난다. `DATABASE_URL`이 없어도 인자 검사가 먼저다.

