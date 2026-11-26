# 문서 색인

문서를 읽는 사람별로 나눴다. 운영자 문서는 문서 사이트에 있고, 이 표는 그 입구를 모은다.

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
| [단일 서버 배포](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/single-server/) | compose로 서버 한 대에 배포 |
| [Kubernetes 설치](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/kubernetes/) | Helm chart로 설치 |
| [실행 기반과 worker 격리](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/explanation/isolation/) | reconciler·scheduler, 세션 실패 처리, workspace 상한과 회수, worker 네트워크 |
| [Kubernetes 실행 backend](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/reference/configuration/) | worker를 Pod로 띄울 때의 동작, chart가 넣는 env, probe |
| [이미지와 공급망](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/reference/packages/) | 이미지와 Compose `apps` profile, 업그레이드·롤백, 취약점 정책 |
| [설정 레퍼런스](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/reference/configuration/) | 설치 상한, API 설정, scheduler·worker·egress 설정 |
| [백업과 복원](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/backup-and-restore/) | compose와 Kubernetes 설치의 백업·복원 |
| [데이터베이스 연결과 느린 쿼리](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/reference/database/) | 역할별 연결 수, 연결마다 거는 timeout, 느린 쿼리·잠금 대기 로그 켜고 보기 |
| [용량 관리](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/capacity/) | transcript 상한, worker 메모리, 노드당 세션 수 |
| [Datadog 감시 기준](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/monitoring-datadog/) | Datadog Agent와 monitor |
| [플랫폼 지표 (Kubernetes)](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/reference/metrics/) | `/metrics` 지표 이름·라벨·뜻, 켜는 법, 수집기가 읽는 법 |
| [세션 데이터가 흐르는 길](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/session-data-flow/) | `events` 표, 비밀값 마스킹, 예제 OTLP 수집기 |
| [저장소와 보존](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/reference/storage/) | 데이터별 저장 위치·보존 기간·삭제 조건, 세션 이벤트 보관 |

<!-- ci probe 1 -->
<!-- ci probe 2 -->
