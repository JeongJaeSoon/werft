# 구성요소와 경계

이 저장소만 받은 사람이 무엇이 어디 있고 서로 무엇을 넘지 않는지 알 수 있게 적는다. 작동 방식과 설정값은 [docs 색인의 운영자 문서](../README.md#운영자)에, 개발 명령은 [development.md](development.md)에 있다.

## 한눈에

이 저장소 코드의 중심은 Werft의 Kiel 모듈(세션 런타임)과 그 공개 `/v1` API다. 공식 TypeScript Claude Agent SDK 세션을 격리된 worker에서 실행하고, HTTP API·이벤트·승인·제어·checkpoint 복구로 다룬다.

Werft는 안에서 네 모듈로 나뉜다. 모듈 이름은 저장소 안에서만 쓰고, API나 SDK처럼 바깥에 보이는 곳에는 내놓지 않는다. Musterrolle은 사용자·로그인·워크스페이스·역할·연동 계정과 권한 판정, Kollegium은 에이전트 정의·버전·런치와 에이전트를 부르는 웹·Slack·API 채널, Lotse는 세션끼리의 연결과 협업, Kiel은 세션 런타임(격리 실행·제어·승인·복구)을 맡는다. `/v1` API는 control host가 서빙하고, 그 안의 인증 경로 `/v1/auth/*`는 Musterrolle 몫이다. 외부 도구는 Werft 안에 넣지 않고 Werft 밖의 remote MCP server에 연결해 쓰는 것이 설계 방향이다.

credential 경계: provider key와 저장소·object store credential은 worker에 직접 전달하지 않지만, 살아 있는 attempt는 제한된 egress token으로 허용된 경로를 호출할 수 있다.

`docs/openapi.json`과 `docs/api/` 아래 생성물은 손으로 고치지 않는다. `bun run --cwd apps/control-host openapi:generate`로 함께 다시 만든다. merge·rebase에서 이 생성물이 충돌하면 `openapi.ts`와 route 소스만 풀고 같은 명령으로 다시 만든다(생성물의 충돌 표시는 덮어써진다). 쓰지 않고 맞는지만 보려면 `openapi:generate --check`다.

이름 범위: 바깥에 내놓는 이름은 Werft다. TypeScript SDK는 `packages/sdk`에 있고 npm 패키지 이름은 `@werft-ai/sdk`, 클래스는 `Werft`, 환경 변수는 `WERFT_API_KEY`·`WERFT_BASE_URL`이다. 내부 패키지는 `@werft-ai/*` 스코프를 쓴다. 바꾸면 이미 설치된 곳이 깨지는 이름, 곧 compose project, 런타임 라벨, 설치 경로에는 옛 이름이 남아 있다.

아래는 모듈마다 코드가 어디 있는지다. 아래 control host·worker·egress proxy가 Kiel(세션 런타임)의 구성요소이고, 공개 `/v1` API는 control host의 api role이 서빙한다.

- **Musterrolle**: `packages/contracts/src/musterrolle`, `packages/platform/src/musterrolle`, control host의 인증 route(`/v1/auth/*`)와 API 키·멤버·팀 route, `packages/db`(사용자·워크스페이스·인증·권한 테이블과 그 쿼리), `packages/platform/src/ports/identity-store.ts`. Kiel의 계약과 port도 이 계약과 policy 타입을 import한다. 권한 판정은 `packages/platform/src/musterrolle/policy.ts`의 `createAuthorizationPolicy`가 맡는다. 요청 주체를 다시 읽은 뒤 action의 scope, 관리 action이면 역할, 세션이면 공유 범위와 에이전트 관리자 여부로 판정한다.
- **Kollegium**: `packages/contracts/src/kollegium`(에이전트 정의·채널 연결 surface·chat envelope), `packages/platform/src/agents`, control host의 에이전트 route와 `slack` role(`apps/control-host/src/slack`). 에이전트 release의 `policy_pins.tools`는 도구별 권한 정책(`allow`·`ask`·`deny`, 기본값은 내장 도구 allow·MCP 도구 ask)을 release를 만들 때 고정한 값이다. remote MCP server 경로는 이 값에서 `allow`인 MCP 도구만 세션에 주고, egress proxy가 중계하는 `tools/call`마다 호출한 도구가 그 목록에 있는지 검사한다(`packages/db/src/mcp-egress.ts`가 읽고 `packages/platform/src/workers/mcp-egress.ts`가 판정한다). worker의 `canUseTool` → `pending_requests` 경로는 이 값을 읽지 않는다.
- **웹 콘솔**: `apps/web`이 `packages/client`·`packages/core`·`packages/react`·`packages/ui`를 조립한 SPA이고, control host의 api role이 빌드 결과(`WEB_DIST_DIR`)를 서빙한다.
- 소속 모듈을 정하지 않은 코드는 `packages/contracts/src/domain`(기억·digest. digest의 비용 형식은 `/v1` 사용량 응답이 쓴다)이다.

- **control host**(`apps/control-host`)가 Kiel의 제어 영역이고, Musterrolle 인증 코드와 Kollegium의 Slack 채널도 여기서 돈다. 실행물 하나가 api·metrics·scheduler·reconciler·slack 다섯 role 가운데 하나를 인자로 받는다. api는 공개 `/v1` API(Musterrolle의 `/v1/auth/*` 포함)와 worker용 `/internal` Worker Gateway, 웹 콘솔을, metrics는 scrape 때 DB에서 계산하는 `GET /metrics`를, scheduler는 세션마다 worker 컨테이너(Docker)나 Pod(Kubernetes)를, reconciler는 lease가 만료된 세션의 회수를, slack은 Slack에서 받은 이벤트 처리와 Slack으로 보내는 outbox를 맡는다.
- **worker**(`apps/worker`)는 세션 하나당 컨테이너(Kubernetes에서는 Pod) 하나다. Gateway에서 세션을 claim하고 그 안에서 Claude Agent SDK와 번들된 Claude Code를 돌린다. DB driver와 Docker socket이 없고, object store는 `packages/storage`를 거쳐서만 부른다.
- **egress proxy**(`apps/egress-proxy`)가 worker 네트워크에서 바깥으로 나가는 유일한 길이다. provider key와 저장소·object store 자격 증명은 worker에 가지 않는다([api-server.md § provider 키와 저장소 자격 증명](../operator/api-server.md#provider-키와-저장소-자격-증명은-worker에-가지-않는다)).
- 상태는 PostgreSQL(세션·turn·lease·checkpoint pointer, Musterrolle의 사용자·워크스페이스·인증·권한 데이터)과 S3 호환 object store(transcript·workspace bundle·checkpoint manifest)에 있다. 저장소 원본은 카탈로그에 등록한 git 서버(GitHub·GHES 포함)다. 로컬 스택의 예시 저장소는 읽기 전용 fake-git이 내준다.

## 저장소 구성

최상위 디렉터리는 다음과 같다. 테스트와 스크립트를 어디에 두는지는 [development.md § 테스트·스크립트 배치](development.md#테스트스크립트-배치)에 있다.

| 경로 | 무엇이 있는가 |
|---|---|
| `apps` | 이미지가 되는 앱 셋(control-host·worker·egress-proxy, 앱마다 `Dockerfile` 하나)과 빌드 결과만 내는 앱 셋: 웹 콘솔 `web`(control-host 이미지에 들어간다), 개발자 문서 사이트 `docs`(GitHub Pages로 export), `packages/ui`의 `storybook`. 앱끼리는 import하지 않는다 |
| `packages` | 앱이 조립하는 workspace 라이브러리. 아래 표에 패키지마다 한 줄씩 있다 |
| `tests` | 패키지 하나로 닫히지 않는 테스트: 여러 앱·패키지를 엮는 흐름, 저장소·CI·`scripts`를 검사하는 테스트, 스택 전체 harness(`tests/e2e`, `tests/d2-gate`), `scripts/soak` 판정 함수의 단위 테스트(`tests/soak`) |
| `scripts` | 운영자와 개발자가 직접 실행하는 도구: 백업·복원(`backup.sh`·`restore.sh`·`verify-restore.sh`), 로컬 스택(`local.sh`), test-ops(`test-ops.sh`), Kubernetes 설치의 운영자 CLI(`k8s-api.sh`), gate와 soak 실행기(`scripts/d2-gate`·`scripts/soak`), 공용 구현(`scripts/lib`), 개발용 fixture(`scripts/dev`), `THIRD_PARTY_NOTICES.md` 생성기(`third-party-notices.ts`), 수동 재현기(`scripts/bun-http-stall`), Agent SDK·LiteLLM 호환 harness([`scripts/agent-sdk-compat`](../../scripts/agent-sdk-compat/README.md)). 호환 harness는 workspace 밖의 독립 설치 단위로 자기 lockfile에 SDK를 고정하고, 실제 LiteLLM proxy를 거친 SDK 왕복은 여기서만 확인한다. CI `agent-sdk-compat` job이 main push와 수동 실행에서만 돌리고 run을 막지 않는다([ci.md](ci.md)) |
| `.github` | CI 전용. workflow(`workflows`), composite action(`actions/bun-setup`), workflow만 부르는 helper(`.github/scripts`). 운영자가 부르는 도구는 여기가 아니라 `scripts`에 둔다 |
| `infra` | compose layer(`compose.core.yml`·`compose.local.yml`·`compose.test-ops*.yml`·`compose.real-model.yml`·`compose.fake-model.yml`·`compose.datadog.yml`)와 진입 파일 `compose.yml`, 복원용 layer `compose.restore.yml`, 컨테이너 초기화 스크립트(`infra/localstack`), Datadog 설정(`infra/datadog`) |
| `deploy` | Kubernetes 배포: Helm chart(`deploy/helm/werft`)와 그 렌더 검사(`deploy/helm/render-check.ts`), 로컬 kind 확인(`deploy/kind/up.sh`), PR 미리보기(`deploy/preview/preview.sh`, [development.md § PR 미리보기](development.md#pr-미리보기)). chart의 NetworkPolicy가 worker Pod의 바깥 연결을 egress proxy 하나로 묶는다. worker Pod는 DNS도 쓰지 않고 proxy 주소를 hosts 파일로 받는다. 설치 절차는 [kubernetes-deployment.md](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/kubernetes-deployment/) |
| `tests/fixtures/settings` | 로컬 스택·E2E가 migrate 단계에서 가져오는 설정 문서. `real-model.json`은 실제 Messages API를 부른다. key는 콘솔의 모델 연결 화면에서 넣는 것이 기본이고, 실행자의 `ANTHROPIC_API_KEY`가 있으면 `value_env`로 읽는다. `fake-model.json`은 compose `fake-messages`를 부른다. 뒤의 것은 `--fake-model` overlay(`infra/compose.fake-model.yml`)를 얹은 실행(quickstart, 무료 e2e·복원 확인)이 쓴다. API와 slack 역할은 파일을 읽지 않는다 |
| `docs` | 독자별 문서. 색인은 [docs/README.md](../README.md)다. 사용자 문서(quickstart·API 가이드)는 `docs` 바로 아래, 운영자 문서는 `docs/operator`, 기여자 문서는 `docs/contributing`에, 설계 결정 기록은 `docs/contributing/decisions`에 둔다. 생성된 `openapi.json`과 API가 `/docs`로 서빙하는 참조 페이지(`docs/api`)도 여기 있다 |

### 패키지와 앱

| 경로 | 맡는 일 |
|---|---|
| `packages/contracts` | 재사용 가능한 Zod payload 계약을 `api`(공개 REST·SSE)·`worker-protocol`(Gateway DTO)·`musterrolle`(auth·authorization·workspace)·`kollegium`(agent 정의, 채널 연결 surface, chat 표면 envelope)·`domain`(소속 미정인 기억·digest 계약)·`shared`(ID·error·canonical JSON·숫자 설정 parser)로 분리한다. HTTP method·path·인증·scope 같은 transport 메타데이터는 실행 어댑터인 `apps/control-host`가 소유한다 |
| `packages/db` | Drizzle 스키마·migration·세션 claim 및 상태 쿼리 |
| `packages/storage` | content-addressed checkpoint object store, 요청·body 읽기에 상한을 건 S3 client, worker가 egress proxy의 object route로 쓰는 client, scope 밖 key를 막는 object store, 자원 상한을 건 git 실행기, git workspace bundle 검증 |
| `packages/observability` | 구조화 로거(`createLogger`, `LOG_LEVEL`)와 로그 redaction 규칙. 메트릭은 이 패키지가 아니라 control host의 metrics role(`apps/control-host/src/metrics`)이 낸다. 세션 데이터가 `events` 표로 흐르는 길, 비밀값 마스킹, 예제 OTLP 수집기는 [세션 데이터가 흐르는 길](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/session-data-flow/)에 있다 |
| `packages/system` | 업무 의미가 없는 Bun·OS 도구: 캐시 없이 매번 묻는 DNS 조회(`lookupEveryTime`), 자원 상한을 건 git 실행(`gitCommand`)·process group 종료. db·storage·worker가 쓰고, 이 패키지는 아무것에도 의존하지 않는다 |
| `packages/platform` | 저장소·실행 backend를 port로만 아는 도메인 층. `SessionService`(접수·조회·권한), `WorkerGateway`(epoch/lease fencing), `runScheduler`(슬롯·launch intent·orphan 회수), `CheckpointService`(manifest·pointer CAS·복원 계획), catalog. 권한 policy는 `src/musterrolle`에 있다 |
| `apps/control-host` | 세션 런타임의 제어 영역 배포 단위. 실행물 하나(`src/main.ts <api\|metrics\|scheduler\|reconciler\|slack>`)가 role을 인자로 받고 기본값은 없다. scheduler·reconciler·slack은 pass를 반복하는 loop(`src/pass-loop`)로 돈다. `src/metrics`는 Prometheus 형식 `GET /metrics`, `src/slack`은 Slack inbox·outbox pass다. `src/api`는 `@hono/zod-openapi` route 선언에서 `/v1` handler와 OpenAPI를 함께 등록하고, `/internal` Worker Gateway·API 키·키 발급 CLI도 제공한다. `bun run --cwd apps/control-host openapi:generate`가 `docs/openapi.json`과 로컬 Scalar HTML을 함께 만들며 API는 인증 전 `GET /v1/openapi.json`과 읽기 전용 `GET /docs`를 제공한다. `/docs/scalar.js`는 외부 CDN 없이 같은 origin에서 서빙하고 두 문서 UI 경로는 OpenAPI operation에 넣지 않는다. `src/scheduler`는 launch intent를 커밋하고 `EXECUTION_BACKEND`가 고른 backend(기본 `local_docker`의 worker 컨테이너, `kubernetes`의 worker Pod)로 worker를 보장하는 pass, `src/reconciler`는 만료된 lease를 회수하는 pass다. Docker 전용 preflight(egress proxy 격리, workspace quota)는 `src/scheduler/backend.ts`가 Docker backend를 고를 때만 돈다. 두 backend 모두 scheduler role만 로드한다 |
| `packages/runtime-core` | 엔진 중립 실행 계약(`AgentRuntime.start(config, hooks)`, `AgentRun`, `RuntimeCapabilities`, checkpoint 준비 결과). `mode: "new" | "resume"`를 config가 들고 다니며 별도 open 진입점이 없다. worker와 control plane이 함께 지키는 checkpoint 상한(manifest 크기·object 수, bundle 크기·사슬 길이)도 여기 한 곳에서 export한다. worker가 쓰는 port(`WorkerGatewayClient`, workspace 준비 계획)도 여기 있다 |
| `packages/adapters/runtimes/claude` | Claude Agent SDK 0.3.270 adapter(`ClaudeSdkRuntime`·`ClaudeSdkRun`), 승인 profile·최소 환경, native envelope·SSE projection, 제어 가능한 fake |
| `packages/adapters/runtimes/claude-codec` | Claude checkpoint manifest codec(`claudeCheckpointCodec`)·transcript digest·pin된 SDK/CLI 버전 상수. SDK 의존이 없어 api 이미지와 운영 스크립트(`scripts/lib`)가 읽는다. `runtime-claude`는 worker와 테스트가 쓰는 codec·버전 상수만 이름으로 재수출한다 |
| `apps/worker` | worker 컨테이너의 진입점(`src/main.ts`). scheduler가 넘긴 bootstrap identity로 세션 하나를 claim하고 WorkerHost 루프(Gateway claim → runtime 실행 → 이벤트 발행 → pending 등록 → checkpoint publish·restore)를 돈다. 이미지에 설치된 runtime은 `src/composition.ts`만 `runtime-registry`에서 고르고, 나머지는 `runtime-core` 계약으로만 runtime을 부른다. SDK·DB driver·cloud SDK를 직접 의존하지 않는다(`tests/architecture.test.ts`가 검사) |
| `packages/adapters/runtimes/registry` | 이 이미지에 설치된 runtime 모듈 목록(`installedRuntimes`). worker의 composition root만 import한다 |
| `packages/adapters/runtimes/codecs` | 설치된 runtime의 checkpoint·이벤트 codec과 descriptor. engine SDK에 닿지 않아 control host가 이것만 import한다 |
| `packages/adapters/execution/local-docker` | `ExecutionBackend` port의 Docker Engine API 구현. 컨테이너 이름·label로 launch intent와 1:1, non-root·read-only rootfs·세션 전용 volume·자원 상한·전용 internal 네트워크 |
| `packages/adapters/execution/kubernetes` | `ExecutionBackend` port의 Kubernetes core/v1 API 구현. launch intent 하나에 worker Pod 하나, Pod가 소유한 nonce Secret, 세션별 workspace PVC. ServiceAccount token을 mount하지 않는 non-root·read-only rootfs Pod이고, 삭제는 Pod UID precondition을 건다. worker의 바깥 연결을 egress proxy로 좁히는 NetworkPolicy와 Role은 Helm chart가 만든다. scheduler가 `EXECUTION_BACKEND=kubernetes`일 때 고른다 |
| `apps/egress-proxy` | worker 네트워크에서 유일하게 바깥으로 나가는 forward proxy. CONNECT·absolute-form HTTP만 받고 목적지 allowlist를 DNS 해석 결과의 IP 대역까지 검사한다. runtime 의존이 없어(`dependencies` 없음, 테스트용 devDependency `testkit`뿐) `apps/egress-proxy/Dockerfile`이 install 없이 자기 `src`만 복사한 이미지로 기동한다 |
| `packages/testkit` | 테스트 fixture: fake Messages API(`fake-anthropic`·`scripted-messages`), PostgreSQL·LocalStack opt-in 헬퍼(`postgres`·`localstack`), 격리 workspace(`workspace`), 메모리 checkpoint object store(`checkpoint-objects`), git bundle·HTTP 저장소 헬퍼(`git-bundle`·`git-http`), 최소 TLS ClientHello 생성기(`tls-client-hello`). 각 패키지가 devDependency로만 참조한다. `fake-messages-main.ts`는 로컬 compose의 `fake-messages` 서비스가 실행하는 진입점이다 |
| `packages/ui` | 웹 콘솔 화면이 공유하는 표현 계층. 서버가 준 상태를 그리기만 하고 fetch하지 않는다. `apps/web`·`packages/react`·`apps/storybook`·`apps/docs`가 쓴다([packages/ui/README.md](../../packages/ui/README.md)) |
| `packages/client` | 공개 HTTP API의 typed client(`openapi-fetch`), `ApiError`, 세션 이벤트 스트림. UI 프레임워크에 의존하지 않는다 |
| `packages/core` | `packages/client` 위의 프레임워크 없는 상태 로직: `@tanstack/query-core` query key·option, contracts로 응답을 검사하는 `schemas` entry, 요청 schema로 만든 form 단계 |
| `packages/react` | `packages/core`의 React adapter: client·locale·문구·링크를 주입하는 provider, query option을 감싼 hook, contracts 타입을 `packages/ui`로 그리는 컴포넌트 |
| `packages/sdk` | 서버·스크립트용 TypeScript SDK(`@werft-ai/sdk`, 클래스 `Werft`). `packages/client` 위에서 API key로 세션·turn·이벤트·승인·push를 다룬다([packages/sdk/README.md](../../packages/sdk/README.md)) |
| `apps/web` | 웹 콘솔 SPA. control host api role이 `WEB_DIST_DIR`에서 서빙하고, 의존성은 빌드 때만 쓴다 |
| `apps/docs` | 개발자 문서 사이트(Fumadocs on Next.js). 정적 파일로 export해 GitHub Pages 루트에 올린다 |
| `apps/storybook` | `packages/ui`의 컴포넌트와 화면 상태를 라이트·다크, 390px까지 보여 주는 Storybook |
| `infra/compose.core.yml` | 모든 설치가 같이 쓰는 제품 서비스: Postgres, one-shot migration, egress proxy(worker 네트워크는 scheduler가 execution마다 만든다). `apps` profile은 control-host 이미지 하나로 api·scheduler(루프)·reconciler(루프)·slack(루프) role을 띄우고(Docker socket은 scheduler에만. metrics role은 Helm chart만 띄운다) worker 이미지를 smoke한다. 보안 설정은 이 파일에만 있다 |
| `infra/compose.yml` (+ 루트 `compose.yaml`) | 로컬 스택: core 위에 `infra/compose.local.yml`(named volume에 영속화하는 SeaweedFS S3, 샘플 저장소를 내주는 읽기 전용 fake-git, 앱 이미지 빌드, `fake-model` profile 뒤의 fake Messages API와 API 전용 Secrets Manager `secrets`)을 합친다. 기본은 실제 Messages API이고, `infra/compose.fake-model.yml`을 얹으면 fake Messages API·`secrets`와 `fake-model.json`으로 돈다. 루트 `compose.yaml`이 이 파일을 include하므로 루트에서 `docker compose`를 그대로 쓴다. test-ops는 core 위에 `infra/compose.test-ops.yml`, object store layer(기본 LocalStack, 또는 AWS S3)를 얹고 `scripts/test-ops.sh`로 운영한다([test-ops.md](../operator/test-ops.md)) |
| `apps/*/Dockerfile` | control-host(모든 role과 웹 콘솔 빌드 결과)·worker·egress-proxy 이미지. base는 `oven/bun:1.3.14` digest pin, `bun install --frozen-lockfile --production` multi-stage(egress-proxy는 install 없는 한 단계). `.github/workflows/images.yml`이 빌드·smoke·digest artifact, main push와 tag push만 ghcr push |

## 경계

`tests/architecture.test.ts`가 아래 규칙을 import와 package 의존성으로 검사한다. 규칙을 바꾸려면 그 테스트를 먼저 고친다.

- `@anthropic-ai/claude-agent-sdk`는 Claude adapter의 `runtime`·`run` 모듈만 import한다. 그 dependency를 선언하는 패키지도 adapter 하나다.
- `packages/runtime-core`는 `packages/contracts`에만 의존한다. `packages/platform`은 contracts·runtime-core·zod에만 의존하고, driver·ORM·SDK를 import하지 않는다.
- Claude adapter는 platform·db·storage에 닿지 않는다. Docker·Kubernetes backend는 platform·contracts에만 의존하고 db·pg·provider SDK(Docker SDK·Kubernetes client)에 닿지 않는다.
- 앱끼리는 import하지 않는다. control host는 실행물 하나이고 role마다 앱을 따로 두지 않는다. Docker·Kubernetes backend에 닿는 것은 scheduler role뿐이다. worker 컨테이너에는 Docker socket도 host bind mount도 없고, worker Pod에는 hostPath·hostNetwork·hostPID·hostIPC가 없다.
- worker는 runtime-core·runtime-registry·contracts·storage·system·observability만 import한다. runtime-registry는 composition root(`src/composition.ts`) 하나만, storage는 object store 모듈 하나만 import하고, Claude driver의 타입은 쓰지 않는다.
- `apps`·`packages`에서 engine 패키지 이름은 runtime adapter 밖에 나오지 않고(G1), runtime kind 값은 허용한 곳에서만 적으며(G2), engine 이벤트 모양은 adapter 밖에서 읽지 않는다(G3). control host는 codec과 descriptor를 `runtime-codecs`에서만 가져오고, `runtime-codecs`는 engine SDK에 닿지 않는다.
- DNS 조회와 git 실행 도구는 `packages/system`에 있고 runtime-core에는 없다. checkpoint 상한은 worker와 platform이 따로 선언하지 않고 runtime-core에서 가져온다.
- Claude adapter의 진입점은 export할 심볼을 이름으로 적는다(`export *` 없음). `scripts/lib`는 codec을 `runtime-claude-codec`에서 가져온다.
- `/v1` route는 DB-backed 오류와 row를 platform port(`InvalidCursorError`, `IdentityStore`)로만 알고, db 구현을 직접 import하지 않는다.
- `packages/testkit`은 devDependency로만 쓰고 runtime 코드가 import하지 않는다. 패키지의 testing helper(`testing` entry)도 runtime 코드가 import하지 않는다. 패키지 밖으로 나가는 상대 경로 import는 없다.
- 웹 콘솔: `apps/web`은 workspace에서 `packages/client`·`packages/core`·`packages/react`·`packages/ui`만 import하고 contracts는 타입으로만 import한다. `apps/web/package.json`의 `dependencies`는 비어 있다(devDependency만). 그래서 이미지의 `bun install --production`은 React·router 패키지를 설치하지 않는다. control-host 이미지는 웹 콘솔을 빌드한 번들(`apps/web/dist`)을 따로 복사한다. code split은 `lazyRouteComponent`로 하고 `React.lazy`는 쓰지 않는다. `packages/ui`·`packages/react`의 컴포넌트를 두고 자기 UI를 그리는 곳은 `tests/web-ui-allowlist.ts`에 적은 것뿐이다. 목록에 없는 새 위반도, 코드보다 큰 목록도 테스트가 실패시킨다. `packages/ui`는 fetch·WebSocket·EventSource를 부르지 않는다.

## 권한과 비활성

관리 action(`member.manage` 등)은 `packages/platform/src/musterrolle/policy.ts`가 역할로 판정하고, API key는 scope와 관계없이 거절한다. 판정을 통과한 쓰기는 저장소 transaction 안에서 actor가 아직 live owner인지 다시 확인한다. 이때 actor의 `users` 행을 membership보다 먼저 share 잠금한다. 잠금 순서는 login-email advisory → invite → user → membership → web session이다.

세션 생성·입력·승인 답변도 정책 판정 뒤에 저장 transaction이 따로 열리므로, 저장이 요청 주체(user·membership, Slack 연결, key 행)와 입력·답변이면 공유 행·공유 팀·팀 멤버, 답변이면 응답 근거(역할·만든 사람·에이전트 관리자·관리자 팀·담당 팀 `lead`)를 share 잠금하고 다시 본다. 그 사이 권한이 빠졌으면 요청 주체는 `FORBIDDEN`, 공유 밖은 `NOT_FOUND`, 응답자가 아니면 `FORBIDDEN`(`reason_code: role`)이다. 같은 `Idempotency-Key`의 재시도는 재판정 전에 저장된 결과를 받는다. 이 쓰기와 그 근거를 거두는 쓰기가 함께 따르는 잠금 순서는 `packages/db/src/requester-locks.ts` 주석에 있다.

계정 정지(`users.disabled_at`)와 membership 비활성(`memberships.disabled_at`)은 다른 것이다. 앞의 것은 모든 workspace에서, 뒤의 것은 그 workspace에서만 사람을 막는다. workspace의 API key는 두 종류다. 에이전트 key(`api_keys.kind = 'agent'`, `agent_id` 필수)는 사람과 무관하고 비활성의 영향을 받지 않는다. workspace 전체에 닿는 key는 없다(CHECK 제약). workspace 밖의 운영자 CLI key는 `kind = 'operator'`다. 개인 key(`kind = 'personal'`)는 `created_by_user_id`를 갖고, 만든 사람이 비활성이면 요청마다 거절되며, 비활성화하는 transaction이 함께 폐기한다. 그래서 재활성해도 되살아나지 않는다. 사용자가 key를 발급하는 경로를 새로 만들면 그 key에도 `created_by_user_id`를 두고 같은 폐기 대상에 넣는다.

## checkpoint 경로

immutable checkpoint manifest와 authoritative pointer는 `packages/platform`의 `CheckpointService`가 담당하고, `apps/control-host`의 api role이 이를 S3 object store·Postgres `CheckpointStore`·git bundle verifier로 조립해 Worker Gateway에 붙인다. Gateway의 finalize는 manifest ref가 `requestCheckpoint`가 발급한 `sessions/<sid>/checkpoints/<rev>/<attempt>/<publishId>/manifest.json`이고 본문 digest·bundle이 검증된 checkpoint만 받으며, pointer는 turn의 terminal과 같은 트랜잭션에서 `finalizeAtomic`만 "정확히 current+1"로 전진시킨다. turn 없이 pointer를 옮기는 경로는 없다. 워커용 `/internal/worker/checkpoint-request`·`/restore-plan`은 lease fence 안에서 읽은 pointer로 답한다. 워커는 turn 경계에 engine process tree의 descendant나 reparent 뒤에도 workspace 안을 cwd로 둔 process가 남아 있으면 `background_writer`로 checkpoint를 거절한다. 또한 경로·형태·크기·mtime·ctime으로 만든 workspace 지문을 capture 전후에 비교하고, 바뀌었으면 전체 capture를 한 번 다시 시도한 뒤 다시 바뀌면 publish를 거절한다. 워커 heartbeat의 `transcript` 보고는 세션의 `last_transcript_persisted_at`과 `checkpoint_pending_reason`이 되고, `mirror_error`가 기록된 세션은 새 입력과 checkpoint 없는 completed 종료를 409 `CHECKPOINT_UNAVAILABLE`로 거절한다 — 같은 attempt의 checkpoint는 이를 지우지 못하고 **다른** attempt가 커밋한 checkpoint만 지운다. 롤백한 빌드가 모르는 reason(새 빌드가 남긴 값)은 세션 상세에 `unknown`으로 보이고 경고 로그를 남기며, 새 입력은 `mirror_error`처럼 거절한다. transcript가 checkpoint 상한(`TRANSCRIPT_LIMITS`)을 넘으면 worker는 workspace를 올리기 전에, finalize는 part를 읽기 전에 `transcript_too_large`·`transcript_part_too_large`를 기록한다. 이 값은 새 입력과 queue에 있던 turn의 실행을 막지만, 상한을 넘긴 turn의 checkpoint 없는 completed 종료는 받고 마지막 pointer는 복원 지점으로 남긴다. 커밋된 checkpoint가 상한의 80%를 처음 넘으면 `transcript_near_limit` 이벤트를 남기고 세션 상세 `attention`은 `TRANSCRIPT_LIMIT`가 된다. completed turn에 checkpoint를 강제하지는 않는다: 세션 상세의 `durability`가 `last_completed_turn_id`와 `last_checkpointed_turn_id`의 차이로 드러낸다. 기존 storage primitive를 완성된 SDK checkpoint로 간주하지 않는다.

checkpoint 객체의 version 고정과 복원 뒤 재고정은 [backup-restore.md](../operator/backup-restore.md)에, GC는 [api-server.md § checkpoint object store](../operator/api-server.md#checkpoint-object-store)에, 복원이 계속 실패하는 세션의 처리는 [실행 기반과 worker 격리](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/execution/#checkpoint-복원이-계속-실패하는-세션)에 있다.

## SDK와 LiteLLM 방향

`@anthropic-ai/claude-agent-sdk`는 `packages/adapters/runtimes/claude/src/{runtime,run}.ts` 안에서만 직접 호출한다. provider는 Anthropic 직접 연결 또는 승인된 LiteLLM Anthropic Messages endpoint를 거쳐 **Claude 모델**로 연결하는 profile로 분리하며, endpoint와 model alias를 allowlist로 검증한다. LiteLLM은 필수 서비스가 아니며 non-Claude 모델 호환은 지원 범위가 아니다. profile의 endpoint·model 설정은 [api-server.md § 운영자 카탈로그](../operator/api-server.md#운영자-카탈로그-agent-profile--repository)에 있다.

검증은 adapter fake, 실제 SDK + local fake Messages API, 실제 LiteLLM proxy + local fake upstream, 별도 승인된 paid Claude smoke를 구분한다. 제품 adapter의 direct-local suite는 SDK 0.3.270과 번들 Claude Code 2.1.270을 확인한다. 호환 harness(`scripts/agent-sdk-compat`)의 transport suite는 LiteLLM 1.100.1의 header·cache·error·timeout·cancel 전달을 별도로 확인한다. 제품 경로(빌드한 이미지의 worker·scheduler·API)는 `tests/e2e`가 확인한다. 각 명령은 [development.md](development.md)에 있다.

## 설계 이력과 추가 참고

내부 package scope는 `@werft-ai/*`이다. 이 문서는 저장소 코드를 따라간다. 아래는 추가 참고이고, 이 문서를 읽는 데 필요하지 않다.

- SDK 버전: 채택 버전을 고정하는 방식, 운영 제약, 호환 harness가 지키는 계약은 [결정 기록](decisions/agent-sdk.md)에 있다.
- 저장 backend 선택: SessionStore를 채택한 이유와 그 계약을 지키는 제품 테스트는 [결정 기록](decisions/session-store.md)에 있다.
- 웹 콘솔과 Slack 채널은 Kiel 실행 경로를 바꾸지 않고, 같은 `/v1`·세션 서비스 위에서 세션을 다룬다.
