# 문서 색인

문서를 읽는 사람별로 나눴다. 운영자 문서는 `operator/`, 기여자 문서는 `contributing/`에 있다. 사용자 문서는 `docs` 바로 아래에 둔다.

## 사용자

API로 세션을 만들고 쓰는 사람.

| 문서 | 내용 |
| --- | --- |
| [Quickstart](quickstart.md) | 로컬 스택을 띄우고 curl로 세션 한 바퀴 |
| [API 유즈케이스 가이드](https://jeongjaesoon.github.io/werft/ko/reference/api-guide/) | 유즈케이스별 API 호출 |
| [SDK 설치](https://jeongjaesoon.github.io/werft/ko/getting-started/install/) | 서버·스크립트에서 API key로 세션을 다루는 `@werft-ai/sdk` |
| [API 참조 페이지](api/index.html) | 배포 서버가 `GET /docs`로 서빙하는 읽기 전용 참조의 저장소 생성물. 페이지가 부르는 스크립트는 [api/scalar.js](api/scalar.js)다 |
| [OpenAPI 사양](openapi.json) | 서버가 `GET /v1/openapi.json`으로 내주는 사양의 저장소 생성물 |

## 운영자

서버나 Kubernetes에 설치하고 운영하는 사람.

| 문서 | 내용 |
| --- | --- |
| [단일 서버 배포](operator/server-deployment.md) | compose로 서버 한 대에 배포 |
| [Kubernetes 설치](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/kubernetes-deployment/) | Helm chart로 설치 |
| [실행 기반과 worker 격리](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/execution/) | reconciler·scheduler, 세션 실패 처리, workspace 상한과 회수, worker 네트워크 |
| [Kubernetes 실행 backend](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/kubernetes-backend/) | worker를 Pod로 띄울 때의 동작, chart가 넣는 env, probe |
| [API 서버](operator/api-server.md) | 운영자 카탈로그, 자격 증명, checkpoint 저장소, 인증과 권한 |
| [이미지와 공급망](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/images-and-supply-chain/) | 이미지와 Compose `apps` profile, 업그레이드·롤백, 취약점 정책 |
| [설정 레퍼런스](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/configuration/) | 설치 상한, API 설정, scheduler·worker·egress 설정 |
| [백업과 복원](operator/backup-restore.md) | compose 설치의 백업·복원 |
| [데이터베이스 연결과 느린 쿼리](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/database/) | 역할별 연결 수, 연결마다 거는 timeout, 느린 쿼리·잠금 대기 로그 켜고 보기 |
| [용량 관리](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/capacity/) | transcript 상한, worker 메모리, 노드당 세션 수 |
| [Datadog 감시 기준](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/monitoring-datadog/) | Datadog Agent와 monitor |
| [플랫폼 지표 (Kubernetes)](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/metrics/) | `/metrics` 지표 이름·라벨·뜻, 켜는 법, 수집기가 읽는 법 |
| [세션 데이터가 흐르는 길](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/session-data-flow/) | `events` 표, 비밀값 마스킹, 예제 OTLP 수집기 |
| [플랫폼이 보존하는 데이터](operator/data-retention.md) | 데이터별 저장 위치·보존 기간·삭제 조건, 내용과 마스킹, 세션 하나 따라가기 |
| [test-ops 운영 runbook](operator/test-ops.md) | test-ops 설치의 운영 절차 |

## 기여자

이 저장소의 코드를 고치는 사람.

| 문서 | 내용 |
| --- | --- |
| [개발 환경과 검증](contributing/development.md) | 로컬 개발 환경, 테스트·스크립트 배치 |
| [구성요소와 경계](contributing/architecture.md) | 저장소 구성, 앱과 패키지의 경계 |
| [CI에서 실행되는 것](contributing/ci.md) | CI job과 그 조건 |
| [변경 경로에 따른 CI 계획](contributing/ci-path-plan.md) | 바뀐 경로로 문서 전용·축소·전체 검증을 고르는 규칙과 required 판정 |
| [콘솔 데모](contributing/console-demo.md) | 서버 없이 예시 데이터로 콘솔 화면을 보는 데모 모드 |
| [로컬 모델로 확인하기](contributing/local-model.md) | Ollama·LiteLLM으로 확인 |
| [콘솔·Slack 용어집](contributing/i18n-glossary.md) | 화면·Slack 알림에서 쓰는 한국어·일본어·영어 용어 |
| [결정: transcript 저장](contributing/decisions/session-store.md) | SessionStore를 고른 이유, 실패 계약, 그 계약을 지키는 테스트 |
| [결정: Agent SDK 버전](contributing/decisions/agent-sdk.md) | SDK·LiteLLM 버전 고정 방식, 운영 제약, 호환 harness가 지키는 계약과 실행 방법 |
| [결정: 에이전트 GitHub 설정과 기능별 권한](contributing/decisions/github-agent.md) | 기능별 권한의 교집합, 토큰 발급 게이트, 리뷰 승인용 App, 같은 역할에 App 여럿과 저장소에 고정된 연결, 세션 성과물 |
| [결정(설계): 에이전트 행동 도구 카탈로그](contributing/decisions/action-broker.md) | 에이전트가 부르는 정형 도구(Slack 메시지·mrkdwn·의사결정 폼, commit, push, PR, `gh` 입구)의 입력·결과 봉투·실패 코드·멱등성, 그 뒤에서 일하는 control-host 모듈 action-broker의 실행 경로와 자격 증명 위치, 행동 부류 정책, 호출자 매핑, Slack 경계와 `pushApprovability` |
| [결정(설계): surface·action 모듈, 어댑터, 시험 피라미드](contributing/decisions/surface-action-modules.md) | 사람 쪽 채널(surface)과 에이전트의 바깥 작업(action)의 경계와 목표 트리, `-able` 능력 인터페이스(`Notifiable`·`Approvable` 포함)와 시스템별 능력 표, 예정 능력 표, 설계 원칙별 적용, 의존 방향 규칙, 시험 층 기준과 지울·옮길·남길 시험, 이행 순서 |
| [결정(설계): 번들 stdio MCP 서버를 worker relay 뒤에 둔다](contributing/decisions/stdio-mcp-relay.md) | 승인된 번들의 stdio MCP 서버를 worker가 턴 단위로 띄우고 `type: "sdk"` relay 뒤에 두는 방법, 도구 해석·이름 충돌·거절 능력·`ready()` 의미·이벤트, 구현 단위와 선행 티켓 |
| [결정(조사·설계): worker 브라우저·computer-use 도구](contributing/decisions/worker-browser-tools.md) | 브라우저 sidecar 추천, 같은 deny 우선 판정과 호출자 상한, egress·ECH·이미지 크기 실측, 턴 끝 상호작용, 구현 단위 표 |
| [결정(설계안): 에이전트의 PR 본문 읽기](contributing/decisions/pull-request-read.md) | 에이전트가 PR 본문을 읽는 도구(`get_pull_request`), 덮어쓰기 막기(`expected_body_sha256`), 기존 PR 꼬리 교체의 실제 GitHub 확인 절차. 오너 결정 전 |
| [결정: 워크스페이스 성과 규칙과 판정](contributing/decisions/achievement-rules.md) | 근거 사실과 성과 두 층, 구분·성과 type·규칙(1:1:1), 바로 인정과 Luna(OpenAI Decisions API) 판정, 판정 비용 원장, 성과당 비용 |
| [결정: GitHub Packages bot token](contributing/decisions/github-packages-bot-token.md) | 조직 bot classic PAT를 proxy가 붙이는 방식: 저장·scope 확인, 경로 기반 허용 목록, 실패하면 닫히는 감사, npm·Bundler 설정 |
| [결정: GitHub Packages와 App token](contributing/decisions/github-packages-app-token.md) | App installation token으로 사설 npm·gem을 읽을 수 없다는 실측과 근거, 대신 고른 bot PAT 주입 방식과 나머지 대안 |
| [결정: GitHub App manifest](contributing/decisions/github-app-manifest.md) | 콘솔에서 작성용 App을 manifest로 만드는 흐름, 일회용 state, 키·client secret을 한 트랜잭션에 저장, 교체 확인, 로그 마스킹 |
| [결정: 실행 프로필 DB 단일 관리(폐기)](contributing/decisions/profile-db.md) | 실행 프로필을 DB에서 관리하던 계약의 기록. 프로필은 migration 0270에서 지웠다 |
| [결정: GitHub App 저장소를 DB 카탈로그로](contributing/decisions/repository-catalog-db.md) | App 저장소의 정본을 `catalog_repositories`로 옮기는 결정과 한 번만 읽는 yaml 시드(일부는 파일 카탈로그를 설정으로 옮긴 결정이 대체) |
| [결정(설계): 한 세션에서 여러 저장소와 PR](contributing/decisions/session-multi-repository.md) | 개수 제한 없이 한 세션이 여러 저장소에 push하고 PR을 여는 설계, 원격 여러 개·push 대상·게이트의 저장소 인자 |
| [결정: 세션에 저장소를 붙여 쓰기](contributing/decisions/session-repository-attachment.md) | 세션을 저장소에 묶지 않고 0개 이상으로 시작해 도중에 붙이는 방식, 기본 저장소, 상한과 사용 범위 |
| [결정: 파일 카탈로그를 설정으로](contributing/decisions/settings-replace-file-catalog.md) | 연결·저장소·MCP 서버를 DB·콘솔로 옮기고 설정 파일 로더를 없애는 설계, 자격 증명 경계, 한 번에 옮기는 이전, 내보내기/가져오기, GitHub App 저장소는 설치 목록에서 고름 |
| [결정(설계): Musterrolle 모듈 경계](contributing/decisions/musterrolle-boundary.md) | 흩어진 신원·역할·권한 코드의 위치 실측, 패키지마다 `musterrolle/` 디렉터리와 공개면 하나로 닫는 목표 경계, architecture 테스트 규칙, 단계별 PR 순서와 증명 방법 |
| [결정(제안): 로그 레코드 계약과 에러 기록](contributing/decisions/logging-contract.md) | 세 logger의 출력 모양과 로그 소비자, 표준 레코드와 계약 테스트, proxy 무의존 유지, 에러를 문자열로 남기는 규칙, 로그 필드가 바뀌는 단계별 PR |
| [결정(설계): 관측(OTel) 방향과 도구 호출 감사](contributing/decisions/observability-otel-and-tool-call-audit.md) | OTel 채택 범위와 Langfuse와의 관계, tracer 포트, trace_id·로그 필드, API span 규칙, OTLP 설정 키, 도구 호출 감사 레코드(입력은 해시만, 판정·근거, 가림 목록, 보존, 담당 모듈), 후속 티켓 순서표 |
| [결정(제안): worker Pod를 누가 만드나](contributing/decisions/k8s-pull-execution.md) | 플랫폼 직접 생성 + 권한 축소(추천)와 KEDA ScaledJob pull의 비교, 두 안의 설계, PoC 실측, Codex 의견 |
| [결정(설계): 새 에이전트 마법사 재작업](contributing/decisions/agent-wizard-rework.md) | 마법사의 저장소 지정 제거, 역할·지시 사항을 이름·설명으로(에이전트 지시문 칸은 이후 없앴다), 도구 선택과 실행 적용, 담당 팀과 팀 역할 권한, 구현 단위와 순서 |
| [결정(설계): 에이전트 담당 팀과 액션 RBAC](contributing/decisions/agent-rbac.md) | 에이전트·세션 action별 지금 권한 실측, 담당 팀 안팎 주체별 RBAC 표, 워크스페이스 설정 두 축(바깥쪽의 에이전트 접근, 세션 열람 상한), 담당 팀 필수와 기존 에이전트 이행, 앞선 결정과의 차이, 구현 단위 R1~R5 |
| [결정(설계): 에이전트 지도 뷰 선택](contributing/decisions/agent-map-views.md) | 그래프를 두고 줌 캔버스를 두 번째 뷰로 고르게 하는 설계, 전환 UI와 공유 상태, 주소·설정으로 뷰 고정, 접근성, 단계 A1~D와 세션 사이 관계 데이터 의존, 열린 질문 (승인됨, 구현 미착수) |
| [실제 Claude로 확인하기](real-claude.md) | 실제 Claude로 스택 확인 |
