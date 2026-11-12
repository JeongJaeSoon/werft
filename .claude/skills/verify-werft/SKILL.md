---
name: verify-werft
description: Drive the Werft stack the way a user does — launch it locally with scripts/local.sh under a project of its own (fake model, ephemeral ports, optional mock Slack IdP), then exercise the web login API, the web console in a browser, members, teams, agents, scoped API keys, the key CLI, and the sessions API with curl, plus a real GitHub sandbox run (App registration, agent GitHub settings, push, pull request, workflow dispatch, gate receipts), and tear down only what it started. Use to prove a user-facing change in this repo (API route, auth, web screen, key CLI, session flow) in the running app, not only in tests.
---

# verify-werft

이 저장소의 사용자 표면을 실제로 띄워 사용자가 하듯 몬다. 지금 있는 표면은 넷이다.

| 표면 | 무엇 | 몰기 |
|---|---|---|
| web API (cookie) | `/v1/auth/**`(bootstrap·login-methods·login·me·logout, 로그인 공급자), 초대·구성원·팀·에이전트·권한별 key·연동 계정·공유·감사 열람·워크스페이스 설정 | `ap_web` (curl + CSRF 헤더 + cookie), 자격 값이 본문에 드는 요청은 `web-user.mjs` |
| 웹 콘솔 | `apps/web`을 API가 같은 origin에서 서빙: `/login`·`/bootstrap`·`/`·`/members`·`/invite/{token}`·`/sessions`·`/members/teams`·`/agents`·`/usage`·`/settings/*` | 이 run의 headless Chrome(`browser.mjs`: 폭·다크·오류·로딩 스크린샷), 서빙 헤더는 curl |
| API | `/v1/sessions/**`, `/v1/receipts/{id}`, `/v1/usage/summary`, `/v1/sessions/counts`, `/docs`, `/readyz` (`/v1/limits`는 owner cookie로 `ap_web`) | `ap_get`·`ap_post` (Bearer key) |
| CLI | key CLI(`apps/control-host/src/api/keys.ts`)의 `create`·`revoke` | `ap_key`·`ap_revoke` |
| 실제 GitHub | `JeongJaeSoon/werft-sandbox`와 App `werft-sandbox-agent`: App 등록, 상한, 에이전트 GitHub 설정, clone·push·PR, workflow dispatch·run·rerun, 게이트 receipt | `github-sandbox/overlay.yml`로 띄운 run에서 `web-user.mjs github-app`·`ap_web`·`ap_post`, GitHub 쪽은 `gh`. [github-sandbox.md](features/github-sandbox.md) |

기능 map은 [features/README.md](features/README.md), 한 스택에서 순서대로 실행할 절차는 [features/procedures.md](features/procedures.md)에 있다. 이 스킬을 수정할 때는 구현과 대조하고 실행 결과와 구분한다. 증명할 때는 map에 적힌 진입점을 모두 몬다. 실제 GitHub 표면만 fake가 아니다. 그 run은 따로 띄운다(아래 Launch).

## 확인 등급 (T0~T3)

PR마다 등급 하나를 정한다. 검증 sticky comment(`<!-- test-results -->`)의 **첫 줄**에 `등급: Tn — 이유`를 적는다(예: `등급: T0 — 스킬 문서만 바뀜`). 이 문서의 스택 절차(Launch~Cleanup)는 **T3만** 쓴다.

| 등급 | 해당하는 PR | sticky에 기록하는 것 | 스택 |
|---|---|---|---|
| T0 | 문서·CI 설정·스킬 문서·주석·번역만 바뀜 | CI 결과(문서 빌드 포함)와 바뀐 파일 목록 | 띄우지 않는다 |
| T1 | UI만 바뀜(`apps/web`, `packages/ui`, `packages/react`, `packages/core`의 표시 로직. API 계약·서버 변경 없음) | 목 데이터로 바뀐 화면을 채운 캡처(빈 상태·긴 텍스트·비활성 등 바뀐 경우 포함), 돌린 명령과 출력, CI 결과 | 띄우지 않는다 |
| T2 | 간단한 수정: diff가 작고 동작이 단위·통합 테스트로 덮인다 | 변경 전 실패·변경 후 통과하는 테스트(또는 기존 테스트가 그 경로를 덮는다는 근거), CI 결과 | 띄우지 않는다 |
| T3 | 그 외: 백엔드 동작, API 계약, 런타임·권한, DB 마이그레이션, Slack·GitHub 실연동, 여러 기능이 이어지는 흐름 | 이 스킬의 스택 절차로 실제 확인한 출력 | 띄운다 |

- 애매하면 한 등급 위로 정한다. 리뷰가 등급에 이의를 내면 그 등급으로 다시 확인하고 sticky 첫 줄을 고친다.
- 모든 등급이 같다: sticky에 head sha, 확인한 것, 확인하지 않은 것을 적는다. CI green, 독립 리뷰 Act-on 0. 비밀값·개인정보는 가린다.

### T1 절차: 목 데이터로 바뀐 화면 보기

전체 스택 없이 화면만 채운다. 웹 콘솔의 데모 모드를 쓴다. 아래 명령은 모두 이 저장소에서 실제로 돌려 확인했다.

0. 설치: worktree에서 `bun install --frozen-lockfile`(bun 1.3.14). 빌드가 남긴 `dist` 디렉터리(`apps/web/dist`, `packages/ui/dist` 등)와 `apps/web/dist-demo`는 `biome.json`의 `files.includes`가 검사에서 빼므로 `biome check` 전에 지우지 않아도 된다.
1. **web dev 서버의 데모 모드**: `cd apps/web && bun --bun vite --mode demo --port <port> --host 127.0.0.1`. GET은 `src/demo/fixtures.json`에서 답하고 쓰기는 `DEMO_READ_ONLY`로 거절하며, 기록 없는 GET은 `NOT_FOUND` 화면이 된다. 들어 있는 자리표시자는 `/v1/auth/me`뿐이라 홈은 요청함이 `NOT_FOUND`로 그려진다. 바뀐 화면을 채우려면 `src/demo/fixtures.json`을 scratch에 복사해 그 화면이 부르는 GET을 `responses`에 더하고 `DEMO_FIXTURES=<json 경로>`로 주고 띄운다(구조는 `{ recorded_at, responses: { "<경로>": { status, json } } }`, 같은 경로의 기록이 있으면 query가 달라도 그 응답으로 답한다. 복사본의 `/v1/auth/me`를 바꿔 지금 읽히는지 확인했다). 라우트는 해시에 있다. 캡처: `W=390 node .claude/skills/verify-werft/scripts/page-shot.mjs http://127.0.0.1:<port> '/#/members' <out.png> [full]`. `W`·`H`·`THEME=dark`·`LOCALE=ja|en`·`SETTLE=<ms>`(기본 1500)를 환경에서 받고, `scrollWidth/innerWidth`와 페이지 오류를 출력한다(수집한 페이지 오류는 종료 코드에 반영하지 않으니 출력을 읽는다). 두 값이 같으면 가로로 넘치지 않는다. 데이터가 늦게 오는 페이지는 `SETTLE`을 늘려 원하는 상태가 그려진 뒤 찍는다. 설치한 Chrome과 저장소의 `playwright-core`를 쓴다.
2. 캡처 규칙은 [features/web-console.md](features/web-console.md)와 같다. 390px·1280px을 light·dark로, 위 상태마다 찍고 `scrollWidth/innerWidth`를 적는다. 화면을 바꾼 PR은 [화면 구성 원칙](../../../packages/ui/README.md#화면-구성-원칙)으로 점검한다.
3. sticky에 돌린 명령과 출력, 어떤 상태를 채웠는지, 캡처를 적는다. 목은 응답 모양을 그대로 믿으므로 실제 API 연동·권한·서버 경로, 그리고 fixture가 `contracts`와 맞는지는 확인하지 못한 것으로 적는다. 요청·응답 모양을 바꾸는 PR이면 T1이 아니라 T3다.

## 원칙

- **자기 스택만.** `up.sh`가 새 compose project(`verify-ap-<run id>`)와 installation id를 만들고, 모든 단계가 그 project에만 compose를 건다. 기본 project `werft`이나 다른 사람의 스택은 몰지도 내리지도 않는다.
- **실제 모델 없이.** 항상 `--fake-model`이다. 세션은 프롬프트에 적은 GATE-SPEC 대본대로 돈다(`docs/quickstart.md` § 스크립트된 프롬프트). 실제 Claude(`local.sh up` 옵션 없음)는 유료라 이 스킬은 쓰지 않는다.
- **비밀값을 출력하지 않는다.** API key는 변수에만 담고 길이만 보인다. bootstrap token은 이 run이 만든 일회용 테스트 값이고 `state.env`(700 디렉터리)에만 있다.
- **자격 값을 명령에 쓰지 않는다.** 명령 텍스트에 비밀번호 JSON 리터럴이 있으면 agent-guard PreToolUse hook이 "secret-like value detected in shell command"로 그 호출을 거부한다. bootstrap·login·초대 수락·웹 key 발급은 `web-user.mjs`가 run 디렉터리의 값으로 보내고, 화면 로그인·수락은 `browser.mjs`가 같은 값을 칸에 넣는다.
- **프로세스는 PID·project로.** `pkill`·`killall`·이름 패턴 종료는 쓰지 않는다. 내릴 때는 `down.sh`가 이 run의 project와 installation label만 지운다.
- **run은 항상 이름으로.** 같은 머신의 여러 세션이 같은 root에 run을 만든다. 그래서 "마지막 run" 같은 기본값은 없다. `up.sh`가 출력한 run id를 기록해 두고 `lib.sh`·`doctor.sh`·`down.sh`에 매번 넘긴다. 인자 없이 부르면 사용법과 살아 있는 run 목록만 출력하고 exit 2로 끝난다(아무것도 내리지 않는다). 목록의 다른 run은 다른 세션의 것이니 넘기지 않는다.

## 상태 파일

Claude Code의 Bash 호출은 매번 새 셸이다. 그래서 `up.sh`가 run 디렉터리를 만들고 거기에 상태를 쓴다.

- run 디렉터리: `${VERIFY_AP_ROOT:-$TMPDIR/verify-werft}/<run id>/`
- `state.env`: `COMPOSE_PROJECT_NAME`, `EXECUTION_INSTALLATION_ID`, `COMPOSE_FILE`(compose.yaml + 이 run의 ports overlay), `API_IMAGE`·`WORKER_IMAGE`·`EGRESS_PROXY_IMAGE`(run별 태그), `VERIFY_API`, `VERIFY_BOOTSTRAP_TOKEN`
- `users/<who>`(이메일·무작위 비밀번호), `users/<who>.invite`(초대 token), `keys/<who>`(웹에서 발급한 key secret), `cookie.<who>`: `web-user.mjs`가 쓴다. 모두 0600이고 `rm-volumes.sh`가 지운다
- `browser/`: `browser.mjs`의 Chrome profile과 `pid`. `stop`(또는 `down.sh`)이 그 PID만 끝내고 profile을 지운다
- `evidence/`: 증거. 내린 뒤에도 남는다

드라이브하는 Bash 호출은 매번 이렇게 시작한다. `<run id>`는 `up.sh`가 출력한 값(예: `20261011-133324-76616`)이다. run 디렉터리 경로나 project 이름(`verify-ap-<run id>`)도 받는다.

```sh
. .claude/skills/verify-werft/scripts/lib.sh <run id>
```

## Launch

```sh
.claude/skills/verify-werft/scripts/up.sh
```

- 선택형 overlay는 인자로 더한다: `up.sh infra/compose.mock-slack.yml`. mock Slack 하나가 Sign in with Slack IdP와 Slack Web API의 가짜(config token 발급 `/fake/config-tokens`, 앱 생성, 설치 동의 `/fake/oauth/authorize`)를 맡고, api의 `CONSOLE_ORIGIN`을 `http://127.0.0.1:3000`으로 두고 mock 시험 전용 `SLACK_OIDC_ISSUER`·`SLACK_API_URL`을 그쪽으로 돌린다. 계정 연결은 워크스페이스의 link 앱으로 한다. `COMPOSE_FILE`에 이어 붙으므로 이후 `lib.sh`·`down.sh`도 같은 스택을 본다.
- Slack 비밀값(config token, 앱의 secret·bot token)은 master key가 있어야 저장된다. Slack 시나리오([musterrolle.md](features/musterrolle.md) c·g, [web-settings.md](features/web-settings.md) 4)는 run마다 `openssl rand -hex 32`로 만든 버리는 값을 `PLATFORM_SECRET_KEY`로 export하고 같은 Bash 호출에서 `up.sh`를 부른다(그 문서의 한 줄). 사람의 Keychain 항목은 읽지 않는다. 그 밖의 시나리오는 `scripts/local.sh`가 프로젝트별 key를 만들어 `~/.local/state/werft/<project>.secret-key`에 두고 쓴다. key 없는 api는 기동을 거부한다.
- 빈 설치 검증: `SETTINGS_DOCUMENT= up.sh`로 띄우면 migrate가 설정 문서를 넣지 않는다. 연결·저장소·MCP 서버·상한이 하나도 없는 설치를 콘솔에서 채우는 절차를 몰 때 쓴다.
- 실제 GitHub run은 `up.sh .claude/skills/verify-werft/github-sandbox/overlay.yml`이다. overlay는 migrate가 넣는 설정 문서를 sandbox 저장소(`auth: { kind: github_app }`)를 더한 `github-sandbox/settings.json`으로 바꾸고 egress proxy가 `github.com:443`에 자격을 붙이게 한다. App 키는 compose를 지나지 않는다. 스택이 뜬 뒤 `web-user.mjs github-app`이 키 파일을 읽어 API로 등록한다. App 등록은 master key가 있어야 저장되므로 Slack처럼 버리는 `PLATFORM_SECRET_KEY`를 같은 Bash 호출에서 넘긴다. 순서와 기대값은 [github-sandbox.md](features/github-sandbox.md). overlay 인자는 repo 기준 상대 경로라 repo 밖 overlay는 `../../…`로 넘긴다.
- Codex 엔진 run은 `SETTINGS_DOCUMENT=/settings/fake-model-codex.json up.sh infra/compose.codex-worker.yml`이다. overlay가 worker 이미지를 Codex 엔진으로 빌드하고 가짜 Responses API(`fake-responses`)를 띄운다. 설정 문서에는 연결 `fake-responses`(`openai_responses`, 모델 `gpt-5.5`) 하나만 있고 저장소는 없다. `SETTINGS_DOCUMENT`를 빼면 `--fake-model`이 Claude용 설정(연결 `fake-messages`)을 넣어, worker는 Codex인데 연결이 없는 스택이 된다(release가 `422 connection_unknown`). worker 이미지 하나는 엔진 하나라 Claude 세션과 Codex 세션은 다른 run에서 본다. 세션은 [sessions.md](features/sessions.md)의 Codex 절로 몬다.
- Orca 프로그램 안에서 돌면 무거운 작업 잠금으로 감싼다: `orch heavy <program> -- .claude/skills/verify-werft/scripts/up.sh`. 내릴 때도 같다.
- 하는 일: run 디렉터리와 `ports.yml`(postgres·localstack·fake-git·api 포트를 `127.0.0.1::<port>` ephemeral로, secrets는 비공개, api에 이 run의 `BOOTSTRAP_TOKEN`)을 만들고 `COMPOSE_PROJECT_NAME=verify-ap-… EXECUTION_INSTALLATION_ID=… COMPOSE_FILE=compose.yaml:ports.yml LOCAL_DEMO_ACCOUNTS=0 scripts/local.sh up --fake-model`을 돌린다(데모 계정 없이: 기능 절차가 bootstrap부터 한다). 끝나면 `docker compose port api 3000`으로 API 주소를 `state.env`에 적고 run 디렉터리를 stdout에, `run id: …`를 stderr에 출력한다. run id는 시작할 때도 stderr에 한 번 나온다. **이 run id를 기록한다.** 이후 모든 단계와 내릴 때 이것을 넘긴다. 빌드가 중간에 실패해도 시작할 때 나온 run id로 `down.sh`를 돌린다.
- worker 슬롯은 기본 3개, `VERIFY_DEMO_ACCOUNTS=1`이면 7개다. `up.sh`가 `state.env`에 `EXECUTION_SLOT_LIMIT`을 적어 scheduler가 그 수만큼만 worker를 띄운다. 데모 데이터는 worker를 쥔 채 끝나는 세션 6개(idle 2, 승인 뒤 idle 1, 권한 요청 1, 질문 1, 실행 중 1)에 terminate할 세션 하나를 더 몬다. 그보다 슬롯이 적으면 시드가 queued 세션을 기다리다 `timed out waiting for <session> to go idle`로 실패한다. 다른 값이 필요하면 `VERIFY_SLOT_LIMIT=5 up.sh`처럼 준다. 이 값이 언제나 우선한다(10000 미만의 양의 정수만). worker마다 `ap-net-*` 네트워크가 하나씩 생기므로 스택 하나가 쓰는 네트워크는 compose 기본 네트워크를 더해 최대 슬롯 + 1개다. 슬롯은 worker 컨테이너가 사라졌다고 scheduler가 확인할 때까지 풀리지 않는다(`slot_released_at`). 입력이 없는 worker도 `WORKER_IDLE_TIMEOUT_SEC`(1800초) 동안 슬롯을 쥔다. 그래서 세션이 슬롯보다 많으면 나머지는 queued로 기다리고, 앞 세션을 pause하거나 terminate하면 다음 pass에서 뜬다.
- 주소 풀 확인: Docker 네트워크 하나가 기본 주소 풀에서 항목 하나를 가져간다. 풀은 머신마다 다르므로 `docker info --format '{{json .DefaultAddressPools}}'`로 본다(풀 하나의 항목 수는 2^(Size − base prefix)). 데몬이 풀을 보고하지 않으면 Docker 내장 기본값(172.17–31.0.0/16 각 1개, 192.168.0.0/16의 /20 16개)으로 센다. `up.sh`는 run 디렉터리를 만들기 전에 `scripts/address-pool.sh <슬롯 + 1>`로 남은 풀을 읽기만 해서 센다. 모자라면 아무것도 만들지 않고 exit 1이다. Docker를 읽지 못해도(daemon 무응답 등) 아무것도 만들지 않고 exit 1이며, 이때는 `check that Docker answers`라고 따로 안내한다. 부족 메시지는 `address-pool.sh: Docker's address pools are short: 7 free of 30, 41 needed` 다음에 쥐고 있는 풀 항목 수를 compose project(scheduler가 만든 네트워크는 installation id)별로 적는다(보통 네트워크 하나가 한 항목). 이때는 자기가 띄운 스택을 `down.sh`로 내리거나 `VERIFY_SLOT_LIMIT`를 줄인다. 남의 스택은 지우지 않는다. 확인과 실제 생성 사이에 다른 스택이 풀을 가져갈 수는 있다.
- 준비 표시: stderr 끝에 `{"status":"ready","checks":{"database":"ok","schema":"ok","config":"ok"}}`. 로그는 `evidence/up.log`.
- 이미지 태그도 run마다 따로 둔다(`werft-*:verify-ap-…`, `tests/e2e/run.sh`와 같은 방식). 기본 `:dev` 태그를 덮어쓰면 다른 스택의 scheduler가 이 checkout의 worker를 띄우게 된다. `down.sh`가 이 태그만 지운다.
  - 공용 태그로 바꾸지 않는 이유: 빌드 캐시는 태그가 아니라 레이어 내용으로 맞춰지므로 새 태그로 빌드해도 같은 소스의 레이어를 재사용한다. 반면 scheduler가 `WORKER_IMAGE`로 worker를 띄우므로 공용 태그는 한 run의 빌드가 다른 run의 worker를 바꾼다. 비용은 태그가 남는 것이었고 `down.sh`가 푼다.
  - compose가 `image:` 없이 빌드하는 서비스의 이미지(`<project>-migrate`·`-fake-git`·`-gitea`, 태그 `latest`)도 이 project 이름이 붙는다. `down.sh`는 위 세 태그와 이 셋을 정확한 이름으로만 지운다.
- 시간: 첫 빌드는 5–10분. 이 checkout에서 이미지를 매번 다시 빌드한다. bash 도구의 timeout을 15분으로 주거나 background로 돌린다.
- 왜 ephemeral 포트인가: 기본 포트(3000·5432·4566·4567·3001)는 다른 스택이 쓰고 있을 수 있다. 이 머신에서는 3000을 다른 컨테이너가 쥐고 있어 기본값으로는 `local.sh`의 포트 점검에서 멈춘다. overlay는 `tests/e2e/compose.yml`과 같은 `ports: !override` 방식이다.

## Doctor

```sh
.claude/skills/verify-werft/scripts/doctor.sh <run id>
```

run, project, 이미지를 빌드한 소스(`up.sh` 때의 HEAD + 커밋하지 않은 변경 digest, `scripts/tree-id.sh`)와 지금 checkout, API 주소, 서비스별 상태, `/readyz`를 보여 준다. ready가 아니거나 `up.sh` 뒤 HEAD나 커밋하지 않은 변경(`.claude/` 밖)이 바뀌었으면 exit 1(바뀐 코드는 `down.sh` 뒤 `up.sh`로 다시 빌드한다). 이상해 보이면 먼저 이것을 돌린다. `api`·`scheduler`·`reconciler`·`postgres`·`localstack`·`fake-git`·`egress-proxy`·`fake-messages`·`secrets`가 모두 `running`(healthcheck가 있으면 `healthy`)이 아니면 exit 1이다. Codex 엔진 run처럼 이 run의 compose가 `fake-responses`를 정의하면 그것도 같은 조건으로 본다. `/readyz`는 database·schema·config만 보므로 scheduler가 죽어도 ready다. `up.sh` 직후에는 scheduler가 몇 초 `starting`일 수 있으니 잠시 뒤 다시 돌린다(`migrate`·`worker`는 한 번 돌고 끝나 목록에 없다).

## Drive

`lib.sh`가 주는 함수. 모든 응답은 본문 뒤 마지막 줄에 HTTP 상태 코드를 붙인다.

| 함수 | 용도 |
|---|---|
| `ap_web METHOD PATH [JSON]` | 브라우저처럼 부른다: `x-requested-with: werft-web` 헤더, `$VERIFY_RUN/cookie`의 세션 cookie를 보내고 응답의 `__Host-werft_session`을 저장한다. cookie 파일은 하나라 여러 사람을 몰 때는 사람마다 복사해 둔다([musterrolle.md](features/musterrolle.md) Preconditions). POST에는 새 `Idempotency-Key`를 붙인다(세션 POST에 필요하고 나머지 route는 보지 않는다) |
| `ap_key <owner> --scopes a,b` | key CLI로 운영자 key를 발급한다. stdout에 key, stderr에 `key_id …`. 운영자 key는 워크스페이스에 속하지 않아 세션을 만들지 못한다(`sessions:write`가 있어도 `POST /v1/sessions` → `404`, 그 scope가 없으면 먼저 `403`). 세션은 구성원의 개인 key(`web-user.mjs … key`)로 만든다 |
| `ap_revoke <key_id>` | key 폐기 |
| `ap_get PATH` / `ap_post PATH JSON` | `$KEY`로 Bearer 호출. `ap_post`는 `Idempotency-Key`를 새로 붙인다 |
| `ap_curl key\|cookie <curl 인자…>` | 위 셋의 바탕. `$KEY`(Bearer) 또는 cookie와 CSRF 헤더를 `-H @<(…)`로 넘기는 `curl -sS`. 스트림(`-N`)이나 key로 보내는 `PATCH`처럼 위 셋이 못 하는 호출에 쓴다. cookie 쪽은 `$AP_COOKIE_EXTRA`(따로 한 줄로 대입)를 세션 cookie 뒤에 붙인다 |
| `$VERIFY_RUN/headers` | `ap_get`·`ap_post`·`ap_web`이 남기는 마지막 응답 헤더(`X-Request-Id`, `Set-Cookie`) |
| `ap_compose …` | 이 run의 project에만 거는 `docker compose` (`logs api`, `ps` 등) |
| `ap_as <who>` | `web-user.mjs`가 로그인시킨 사람의 cookie로 바꾸고, 그 사람의 웹 key가 있으면 `$KEY`에 담는다(길이만 출력) |

자격 값이 드는 요청과 화면은 node 스크립트로 몬다(host의 `node`, 의존성 없음). 둘 다 첫 인자가 run id다.

| 스크립트 | 용도 |
|---|---|
| `node scripts/web-user.mjs <run id> <command> <who> …` | `bootstrap`·`bootstrap-bad-token`·`login`·`login-wrong`·`login-no-csrf`·`invite <inviter> <who> <role>`·`accept`·`key <who> <personal\|agent> <scopes> [agent id]`. 비밀번호·token·secret은 run 디렉터리에만 두고, 응답 본문(그 칸은 `(saved, N chars)`)과 상태 코드를 출력한다. [web-login.md](features/web-login.md) |
| `node scripts/web-user.mjs <run id> github-app <who> <workspace id> <app id>` | `<who>`의 cookie로 `PUT /v1/workspaces/{id}/github-app`. 키는 `VERIFY_GITHUB_APP_KEY_FILE`(기본 `~/.config/werft/github-app.pem`, 오너의 파일)에서 스크립트가 읽어 본문에만 넣는다. 경로도 명령에 쓰지 않는다(agent-guard가 키 파일 모양의 경로를 막는다). [github-sandbox.md](features/github-sandbox.md) |
| `node scripts/browser.mjs <run id> <command> …` | 이 run 전용 headless Chrome(CDP): `start`·`stop`, `open`, `login <who>`·`accept <who>`·`bootstrap <who>`, `shot`(`W`·`THEME` env), `blockshot`(오류 상태), `slowshot`(로딩 상태), `click`·`press`(포커스 후 키)·`type`·`select`·`key`·`eval`, `measure`(간격·폭·정렬 실측, `layout-report.mjs`가 v35 규칙 표로). 모든 페이지 명령은 끝에 4xx·5xx 응답의 본문을 가려서 stderr의 `! failed request:` 줄로 남긴다(`CAPTURE_URL` glob으로 성공 응답도). [web-console.md](features/web-console.md) |

기능별 명령과 기대 결과는 `features/*.md`에 있다. 가장 짧은 한 바퀴는 [web-login.md](features/web-login.md)다.

## Evidence

- 위치: `$VERIFY_RUN/evidence/`. `up.log`, `down.log`, `leftovers.txt`는 스크립트가 쓴다. 드라이브 출력은 기능 이름으로 `tee`한다(예: `| tee "$EVIDENCE/web-login.txt"`).
- 행동과 결과를 같이 남긴다: 요청(메서드·경로), 응답 본문, 상태 코드. 바뀐 상태는 다른 경로로 다시 읽어 확인한다(로그인 뒤 `GET /v1/auth/me`, key 폐기 뒤 같은 key로 401, 세션 생성 뒤 `GET /v1/sessions/{id}`).
- 사용자 경로만 쓴다. `/internal/**`나 DB 직접 쓰기로 상태를 만들지 않는다. DB는 읽기 확인에만 쓴다(`ap_compose exec -T postgres psql -U postgres -d sessions -c '…'`).
- 기본 mock은 fake model이다. Slack 절차는 명시적으로 `infra/compose.mock-slack.yml`을 더해 외부 Slack 경계도 대체한다.
- key·cookie 값은 증거에 넣지 않는다. 남기기 전에 `sed -E 's/(csp_[A-Za-z0-9_]{2})[A-Za-z0-9_-]+/\1…/g'`처럼 가린다.

## Cleanup

```sh
.claude/skills/verify-werft/scripts/down.sh <run id>         # 컨테이너·네트워크·이미지. volume은 남긴다
.claude/skills/verify-werft/scripts/rm-volumes.sh <run id>   # 별도 단계: 이 run의 volume을 정확한 이름으로 rm
```

- run id는 필수다. 인자 없이, 또는 없는 run으로 부르면 사용법과 살아 있는 run 목록(run id, project, 실행 중인 컨테이너 수)을 stderr에 보이고 exit 2로 끝난다. 이때 compose는 하나도 부르지 않는다.

- `down.sh`는 volume을 지우지 않는다(`-v`도 `docker volume rm`도 없다). volume을 지우는 일은 `rm-volumes.sh`가 따로 맡는다.
- `scripts/local.sh down --keep-volumes`를 같은 env로 돌린다(installation label이 붙은 worker 컨테이너·네트워크는 지우고 volume은 남긴다).
- 이어서 `--profile apps --profile fake-model`과 `-f compose.yaml -f ports.yml -f infra/compose.fake-model.yml`로 `down --remove-orphans --rmi local`(`-v` 없음. compose가 이름 붙인 `<project>-migrate` 이미지까지)을 한 번 더 한다. profile이나 fake-model overlay가 빠지면 api·scheduler·reconciler와 `fake-messages`, `<project>_default` 네트워크가 남는 일이 있었다.
- 지우기 전에 대상(컨테이너 수, 네트워크, 볼륨, 이미지)을 출력하고 `evidence/teardown-targets.txt`에 남긴다. 대상은 label 값이나 태그가 이 run과 정확히 같은 것뿐이다. 접두어·glob은 쓰지 않는다. 장기 실행 스택의 project 이름도 `verify-ap-`로 시작하기 때문이다. `COMPOSE_PROJECT_NAME`과 installation id가 `verify-ap-<run id>`와 정확히 같지 않으면 `down.sh`는 아무것도 지우지 않고 exit 1이다.
- 컴포즈가 모르는 것도 지운다. `werft-net-*-exec-*` 네트워크는 installation label로 지운다. worker의 익명 볼륨(`local.sh`가 worker를 `rm -f`로 지워 남는다)은 컨테이너의 마운트에서 미리 읽어 `teardown-targets.txt`에 남겨 둔다. 이미지는 `docker image rm`을 `-f` 없이 쓰므로 다른 곳에서 쓰는 이미지는 실패하고 건너뛴다. 레이어를 공유하는 다른 태그는 남는다.
- `up.sh`가 스택을 못 띄우고 실패하면 같은 `down.sh`로 그 run의 컨테이너·네트워크를 정리한다(`evidence/up.log`는 남는다). volume은 남으므로 이어서 `rm-volumes.sh <run id>`를 돌린다.
- 마지막에 `docker ps -a --filter label=com.docker.compose.project=<project>`와 installation label로 남은 컨테이너, 같은 두 label로 남은 네트워크, 일부러 남긴 volume 목록, 이 run의 이미지 태그를 보여 주고 `evidence/leftovers.txt`에 쓴다. 컨테이너·네트워크가 남았으면 exit 1.
- `ports.yml`과 run 목록의 항목은 `rm-volumes.sh`가 끝날 때까지 남는다. 스택을 `docker compose -p <project> down`으로 직접 내리지 않는다. scheduler가 만든 worker 컨테이너와 `ap-net-*` 네트워크는 compose label이 없어 그대로 남고, 네트워크마다 Docker 주소 풀 하나를 계속 쥔다.
- 처음에 `browser/pid`가 있으면 `browser.mjs stop`으로 그 Chrome만 끝낸다.
- `down.sh`가 실패하면(Docker daemon 응답 없음 등) `ports.yml`을 남기고 exit 1이다. Docker를 살린 뒤 `down.sh <run id>`를 다시 돌린다. 실패한 시도 뒤에도 매번 `down.sh`를 돌린다.

### rm-volumes.sh — volume 정리 단계

- `down.sh` 뒤에 돌린다. 컨테이너가 아직 떠 있으면 아무것도 지우지 않고 exit 1이다.
- 같은 가드(`COMPOSE_PROJECT_NAME`·installation id가 `verify-ap-<run id>`와 정확히 같음)를 통과해야 한다.
- 대상은 `evidence/teardown-targets.txt`의 volume과 project label이 붙은 volume 중 이름이 `verify-ap-<run id>_`로 시작하는 것뿐이다. 하나씩 `docker volume rm <정확한 이름>`을 한다. `-f`, glob, prune은 쓰지 않는다. 이름이 다른 volume(worker의 익명 volume, `werft-ws-*`)은 `left (…)`로 출력하고 지우지 않는다.
- 출력은 `evidence/rm-volumes.txt`에 남는다. 다 지워졌으면 `ports.yml`, cookie, `users/`·`keys/`를 지운다. 하나라도 실패하면 `ports.yml`을 남기고 exit 1이다. 성공하면 run은 목록에서 사라지므로 `left (…)`로 출력된 volume은 이 스킬이 더 추적하지 않는다. 그 이름은 `evidence/teardown-targets.txt`에만 남는다. `janitor.sh --apply`는 별도 도구라 오래된 run의 volume을 정확한 이름으로 `docker volume rm` 한다.
- `lib.sh`와 `down.sh`는 run 상태(`state.env`, `verify-ap-*` project)를 읽지 못하면 아무 helper도 정의하지 않거나 아무것도 지우지 않고 멈춘다. 기본 project나 다른 세션의 run으로 넘어가지 않게 하려는 것이다.
- 예전 판의 스킬은 공유 `latest` 파일을 따라가 인자 없는 `down.sh`가 다른 세션의 스택을 volume까지 지웠다. 지금 스크립트는 `latest`를 쓰지도 읽지도 않는다. root에 남은 `latest` 파일은 예전 판이 쓴 것이다.

## 오래 남은 run 정리 (janitor)

```sh
.claude/skills/verify-werft/scripts/janitor.sh                 # 드라이런: 목록만, 아무것도 지우지 않는다
.claude/skills/verify-werft/scripts/janitor.sh --hours 6 --exclude <run id>
.claude/skills/verify-werft/scripts/janitor.sh --apply         # 목록에 나온 것만 지운다
```

- 대상: 가장 새 자원(컨테이너·이미지·네트워크·볼륨)이 `--hours`(기본 24)보다 오래됐고 실행 중인 컨테이너가 없는 `verify-ap-<날짜>-<시각>-<pid>` project. 이미지·볼륨·네트워크를 project별로 출력한다.
- 제외 판별: 실행 중인 컨테이너가 있으면 건너뛴다(쓰는 중인 스택). `werft.keep` label이 붙은 컨테이너·볼륨·네트워크가 있어도 건너뛴다. 그 밖에는 `--exclude <run id>`(여러 번 가능)로 이름을 준다. 완전히 멈춘 장기 실행 스택은 오래된 run과 구별되지 않으므로 `--apply` 전에 드라이런 목록을 읽고 제외한다.
- 컨테이너가 이미 사라진 project의 익명 볼륨은 소유자를 알 수 없어 목록에 없다. 이것이 `down.sh`가 컨테이너를 지우기 전에 볼륨을 수집하는 이유다.
- 삭제는 `down.sh`와 같은 정확한 이름 삭제이고 `-f`가 없다. 시험: `bash .claude/skills/verify-werft/scripts/teardown.test.sh`(가짜 `docker`, 실제 Docker를 건드리지 않는다).

## 알려진 함정

- 절차는 zsh(Claude Code Bash 도구) 또는 bash 4 이상에서 실행한다. macOS `/bin/bash` 3.2는 중첩 command substitution의 GATE-SPEC JSON 인용을 깨뜨려 `unterminated GATE-SPEC`·`api_error`를 만들 수 있다.

- host bun이 `package.json`의 `packageManager`(bun 1.3.14)와 다르면 main에서도 실패하는 로컬 테스트가 있다. 이 스킬은 bun을 host에서 쓰지 않는다(key CLI도 api 컨테이너 안에서 돈다). 테스트 판정은 CI가 기준이다.
- `local.sh status`·`key`·`down`은 env의 `COMPOSE_PROJECT_NAME`·`COMPOSE_FILE`을 따른다. `lib.sh`를 source하지 않은 셸에서 부르면 기본 project `werft`을 건드린다.
- `__Host-` cookie는 `Secure`라 curl이 http에서 저장하지 않는다. `ap_web`이 `Set-Cookie`에서 직접 꺼내 보낸다.
- key·cookie·OAuth `state`/`code`·config 값은 명령줄 인자에 두지 않는다. `ps`로 같은 머신의 누구나 본다. curl은 `ap_curl`·`ap_get`·`ap_post`·`ap_web`으로만 부르고(헤더와 본문이 `<(…)`로 간다), 컨테이너 안 스크립트에는 stdin으로 넘긴다. `VAR=값 ap_web …`처럼 앞에 붙인 대입은 curl의 환경으로 export되니 쓰지 않는다. `<(…)`를 배열에 담아 두면 curl이 돌기 전에 닫힌다(exit 26).
- 로그인은 실패가 쌓이면 잠긴다(429 `RATE_LIMITED`, `Retry-After`). 틀린 비밀번호 시험은 한두 번만.
- bootstrap은 사용자가 0명일 때 한 번만 된다. 두 번째는 409 `BOOTSTRAP_DONE`. 처음부터 다시 하려면 `down.sh` 뒤 `up.sh`.
- macOS에는 `timeout`이 없다. 필요하면 `perl -e 'alarm N; exec @ARGV' <cmd>`.

## 유지

기능이 바뀌면 [features/](features/)를 고친다. 주기 점검은 `maintain-verification-skill`로 한다.

## 데모와 추가 드라이버

기본 `up.sh`는 `LOCAL_DEMO_ACCOUNTS=0`이다. bootstrap 검증과 데모 검증은 별도 run이다.

```sh
VERIFY_DEMO_ACCOUNTS=1 .claude/skills/verify-werft/scripts/up.sh
```

이 모드는 `local.sh`에 `LOCAL_DEMO_ACCOUNTS=1`을 넘긴다. `LOCAL_DEMO_DATA=0`을 함께 주면 계정만 만든다. 기본값은 fake model 데모 에이전트·세션도 만든다. 절차는 `P-DEMO-SEED`다. 기존 사용자·데이터를 덮어쓰지 않는다.

`web-user.mjs <run id> demo-login owner|member`는 소스의 데모 계정으로 로그인하고 `users/demo-owner|demo-member`와 cookie를 저장한다. 비밀번호를 명령에 적지 않는다.
`web-user.mjs <run id> slack-config owner <workspace id>`는 mock config token을 컨테이너 안에서 받아 저장한다.
`web-user.mjs <run id> slack-event <agent id> <challenge|event|duplicate|bad|stale|malformed|bot|mention|plain|reply|uninstall|uninstall-late>`는 이 run의 Slack 앱 signing secret을 컨테이너 안에서 읽어 HMAC을 계산한다. secret을 출력하지 않는다. `event`는 `EvVerify1`, `duplicate`는 같은 event id다. 새 overlay run에서 한 번 실행한다. mock overlay가 아니면 거절한다. 상세 전제는 `P-SLACK-INBOUND`다.
`web-user.mjs <run id> slack-cards <agent id>`는 mock이 기록한 카드(버튼이 있는 채널 글)를 한 줄씩 보인다: ts, 스레드, 버튼 id, 지금까지의 update 수와 마지막 update 본문. 끝에 `cards: N`.
`web-user.mjs <run id> slack-click <agent id> <allow|allow-session|deny|push-approve|push-reject>`는 그 버튼이 있는 가장 새 카드를 눌러, 서명된 interaction 요청을 `/v1/slack/interactions/{agent_id}`로 보낸다. 서명은 mock이 자기 앱 secret으로 만들므로 helper는 secret을 읽지 않고 컨테이너 환경도 보지 않는다. 앱 id는 owner cookie로 `GET /v1/agents/{id}/slack/app`에서 읽는다(owner 로그인이 먼저). 사람은 `U0MOCK`(연결된 계정)이다. `slack-click-bad`는 틀린 서명으로 보내 401을 확인한다. 절차는 `P-SLACK-APPROVAL-CLICK`이다.
