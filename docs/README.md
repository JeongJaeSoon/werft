# 문서 색인

문서를 읽는 사람별로 나눴다. 운영자 문서는 `operator/`에 있다. 사용자 문서는 `docs` 바로 아래에 둔다.

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
