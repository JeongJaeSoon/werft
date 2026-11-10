# Werft

Werft는 공식 TypeScript Claude Agent SDK 세션을 격리된 worker에서 실행하고, HTTP API·이벤트·승인·제어·checkpoint 복구로 다루는 세션 런타임이다. provider key와 저장소·object store credential은 worker에 직접 전달하지 않지만, 살아 있는 attempt는 제한된 egress token으로 허용된 경로를 호출할 수 있다.

## 문서

설치, 운영, API, SDK 문서는 모두 문서 사이트에 있다: <https://jeongjaesoon.github.io/werft/ko/>

| 하려는 일 | 문서 |
| --- | --- |
| 서버를 설치하고 올린다 | [셀프 호스팅](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/), [업그레이드](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/upgrade/) |
| 게시된 이미지·Helm chart·SDK 주소와 버전을 찾는다 | [셀프 호스팅](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/)의 게시 패키지 |
| SDK로 세션을 다룬다 | [SDK 설치](https://jeongjaesoon.github.io/werft/ko/getting-started/install/), [SDK 동작 상세](https://jeongjaesoon.github.io/werft/ko/sdk/) |
| HTTP API를 부른다 | [API 유즈케이스 가이드](https://jeongjaesoon.github.io/werft/ko/reference/api-guide/) |
| 바뀐 점과 운영자가 할 일을 본다 | [변경 기록](CHANGELOG.md) |

## 기여

개발 환경, 구성요소와 경계, CI, 콘솔 데모는 [`docs/contributing/`](docs/contributing/)에 있다. 시작은 [개발 환경과 검증](docs/contributing/development.md)이고, 전체 색인은 [docs/README.md](docs/README.md)다.

## 라이선스

[PolyForm Small Business License 1.0.0](LICENSE)을 따르는 source-available 저장소다. 아래 두 디렉터리만 예외로 [Apache License 2.0](packages/sdk/LICENSE)을 따른다.

| 경로 | 라이선스 |
| --- | --- |
| `packages/sdk` (npm `@werft-ai/sdk`) | Apache-2.0. npm 배포본에는 빌드 때 함께 묶는 `packages/client`의 코드와 `packages/contracts`의 타입이 들어가며, 그 배포본 전체가 Apache-2.0이다([NOTICE](packages/sdk/NOTICE)) |
| `examples/` | Apache-2.0([examples/LICENSE](examples/LICENSE)) |
| 그 밖의 모든 경로 (서버, 웹 콘솔, `packages/client`·`packages/contracts`를 포함한 나머지 패키지) | PolyForm Small Business 1.0.0 |

UI 라이브러리 `packages/ui`(`@werft-ai/ui`)는 npm에 공개하지 않는 내부 패키지이고 PolyForm Small Business 1.0.0을 따른다.

PolyForm Small Business 1.0.0의 허용 범위는 `LICENSE`의 "Small Business" 절에 있고, 요약은 다음과 같다. 효력은 영문 원문에 따른다.

- 회사의 이익을 위한 사용은 그 회사가 직원과 독립 계약자를 합쳐 100명 미만이고 직전 과세연도 총매출이 100만 달러(2019년 기준, 미국 노동통계국 CPI로 물가 보정) 미만이면 허용된 목적이다. 회사에는 그 회사를 지배하거나, 그 회사가 지배하거나, 같은 지배를 받는 조직이 포함된다.
- 이 기준에 해당하지 않는 사용은 허용된 목적인지 `LICENSE` 원문으로 확인하고, 해당하지 않으면 별도 라이선스를 문의한다.
- 복사본을 다른 사람에게 넘길 때는 라이선스 전문(또는 URL)과 `LICENSE` 첫 줄의 `Required Notice:`를 함께 넘긴다.

평가·상용 라이선스 문의: jaesoon@94soon.dev
