# CI check 목록

이 저장소의 CI가 무엇을 지키는지, 언제 도는지, 얼마 안에 끝나야 하는지를 한 곳에 적는다. workflow를 더하거나 필수 check를 바꾸는 변경은 이 문서의 표를 함께 고친다.

용어: **필수 check**는 main의 ruleset이 merge 전에 green을 요구하는 이름이다. **집계 job**은 다른 job들의 결과를 읽어 한 이름으로 판정하는 job이다. **gate**는 필수가 아니지만 정해진 동작을 지키는 workflow다.

게시만 하는 workflow(`pages.yml`, `sdk-release.yml`, `ui-release.yml`, `ci-image-mirror.yml`)와 `images.yml`의 게시 job은 이 문서가 다루지 않는다.

## 단계

| 단계 | 도는 때 | 무엇 | 실행 시간 예산 (p90) |
| --- | --- | --- | --- |
| T0 빠른 필수 | 모든 PR과 main push | `gitleaks`, `forbidden-terms`, `supply-chain`, `changes`(계획) | 2분. `supply-chain`은 이미지를 빌드하면 10분 |
| T1 PR 필수 | 모든 PR. 네 이름은 늘 판정을 내고, 그 아래의 job은 바뀐 경로가 닿는 것만 돈다 | `check`, `integration`, `e2e`, `quickstart` | 아래 표 |
| T2 경로 한정 gate | 그 gate의 경로를 바꾼 PR | D2 gate, K8s 검사 셋, Keycloak login, Worker compatibility, Install rehearsal | 각 workflow의 한도 |
| T3 main | main push | CI(같은 트리를 시험한 PR run이 있으면 재사용), 계획된 이미지와 chart 게시, 제품을 바꾼 push의 `agent-sdk-compat`. 실패한 push run은 `main-failure.yml`이 이슈에 남긴다 | - |
| T4 릴리스와 야간 | 릴리스가 필요한 commit, schedule | conformance, 릴리스 gate, 야간 gate, 취약점 재검사 | - |

T2와 T4의 gate는 PR의 merge를 막지 않는다. 실패가 어디에 남는지는 [필수가 아닌 gate](#필수가-아닌-gate)의 표에 있다.

## 필수 check

ruleset의 필수 이름은 아래 일곱 개다. 이름은 그 job이 PR에서 내는 check 이름이다. `tests/ci-static-checks.test.ts`가 이 표의 이름이 표에 적힌 job의 이름과 같은지, PR에서 도는 workflow에 같은 이름의 job이 둘이 아닌지를 확인한다. 그 시험은 job의 `if`와 `paths`, matrix 값에서 오는 이름을 보지 않는다.

| 이름 | 내는 job | 지키는 것 | 도는 때 | 실행 시간 예산 (p90) / 한도 |
| --- | --- | --- | --- | --- |
| `gitleaks` | `gitleaks.yml` · `gitleaks` | 새 commit 범위에 secret이 없다. 범위 안 merge commit의 diff도 본다. 클라우드 agent의 commit처럼 로컬 hook을 거치지 않은 commit에는 이것이 유일한 secret 검사다 | 모든 PR, main push | 2분 / 10분 |
| `forbidden-terms` | `forbidden-terms.yml` · `forbidden-terms` | 트리, 그 run의 commit 메시지, PR의 제목·본문·댓글·리뷰 중 소유자·멤버·협력자가 쓴 것에 비공개 금지어가 없다. 금지어 목록이 없으면 실패한다 | 모든 PR(제목·본문을 고칠 때도), main push | 2분 / 5분 |
| `supply-chain` | `images.yml` · `supply-chain` | 이미지 빌드가 계획됐으면 그 빌드가 끝났다. 빌드한 이미지와 npm 의존성에 고칠 수 있는 high·critical 취약점이 없다. 예외 항목마다 이유와 만료일이 있다. 빌드나 scan이 실패하거나 결과가 없으면 실패다. scan이 돌았지만 advisory 쪽 장애로 답을 얻지 못한 것만 PR과 main push에서 경고로 지나간다 | 모든 PR, main push, 릴리스 tag, 매일 03:17 UTC. 이미지에 닿지 않는 변경은 npm 감사만 한다 | 10분 / 빌드 30분, 판정 10분 |
| `check` | `ci.yml` · `check` | 집계. 타입, lint, 정책 시험, 제품 산출물, chart ([구성원](#check의-구성원)) | 모든 PR, main push | 구성원 표 / 2분 |
| `integration` | `ci.yml` · `integration` | 집계. 서비스가 붙는 시험 전체와 `e2e`, `quickstart`, conformance ([구성원](#integration의-구성원)) | 모든 PR, main push | 구성원 표 / 2분 |
| `e2e` | `ci.yml` · `e2e-gate` | compose 스택에서 세션 한 바퀴가 돈다(`tests/e2e/run.sh`). 판정은 `e2e (scenario)` job의 결과다 | 판정은 모든 PR과 main push. 시나리오 job은 문서만 바꾼 것이 아닐 때 | 9분 / 시나리오 30분, 판정 2분 |
| `quickstart` | `ci.yml` · `quickstart-gate` | `docs/quickstart.md`와 API 가이드의 명령이 적힌 대로 돈다. 판정은 `quickstart (guides)` job의 결과다 | 판정은 모든 PR과 main push. 가이드 job은 두 가이드 중 하나를 바꿨거나, 문서나 web console만 바꾼 것이 아닐 때 | 8분 / 가이드 30분, 판정 2분 |

집계 job과 판정 job이 통과로 보는 것은 둘뿐이다. 계획된 job이 성공했거나, 계획에 없어서 생략됐다. 계획된 job이 skipped나 cancelled로 끝나면 실패다.

- 문서만 바꾼 PR은 시험과 제품 job을 계획하지 않는다. 가이드를 바꿨으면 `quickstart (guides)`가, 사이트 내용을 바꿨으면 `docs`와 `pages`가 돈다.
- main push가 같은 트리를 시험한 PR run을 찾으면 그 run을 재사용하고 아래 job들을 생략한다(`.github/scripts/ci-reuse.sh`). `helm-chart`, `k8s-smoke`, `sdk-pack-smoke`, `demo`, `ui-pack`은 하나씩 본다. PR run이 돌리지 않은 것은 main push가 돌린다.
- 각 `is_*_path` 목록은 `tests/ci-plan.test.ts`가 지킨다. job이 빌드하는 파일의 import와 상대 경로 문자열을 따라가서 닿은 경로가 목록에 없으면 실패한다.
- 수동 run(`workflow_dispatch`)은 `only` 입력으로 job 하나를 고른다. 아래 표의 "도는 때"는 PR과 main push 기준이다.

`e2e`와 `quickstart`는 이 workflow의 job이 낸다. API로 만든 check run은 그 commit의 가장 오래된 check suite에 붙어서, 다른 workflow가 다시 돌면 merge 판정에서 빠진다.

### check의 구성원

| job | 지키는 것 | 도는 때 | 실행 시간 예산 (p90) / 한도 |
| --- | --- | --- | --- |
| `changes` | 바뀐 경로로 이 run의 계획을 낸다. 읽을 수 없는 base는 PR을 실패시킨다 | 항상 | 1분 / 3분 |
| `check (static)` | `bun run typecheck`, `bun run lint`, 제3자 고지 파일이 lockfile과 맞는다, 가져온 UI의 이름이 제 폴더 밖에 없다 | 모든 PR. 재사용하지 않은 main push | 6분 / 9분 |
| `docs-checks` | `tests/`의 저장소 정책·문서 시험 | 문서만 바꾼 PR과 push | 6분 / 12분 |
| `check (<묶음>)` | `surface` domain이 맡지 않는 시험을 네 묶음으로(`unit: packages`, `unit: db`, `unit: worker, web`, `unit: other apps, tests`) | web console만 바꾼 PR과 push | 11분 / 12분 |
| `integration (<domain>)` | [integration의 구성원](#integration의-구성원)과 같은 job이다. `check`도 읽는다 | 아래 | 아래 |
| `docs` | 문서 사이트가 빌드되고 self-hosting URL 규칙을 지킨다 | PR에서만. 사이트가 빌드에 쓰는 경로(`ci-plan.sh`의 `is_site_path`)나 사이트 내용을 바꿨을 때 | 3분 / 10분 |
| `pages` | Pages에 올릴 사이트의 구조와 크기 예산 | `docs` 뒤 | 1분 / 5분 |
| `demo` | demo가 빌드된다 | demo가 빌드에 쓰는 경로(`is_demo_path`)를 바꾼 PR. 재사용하지 않은 main push | 2분 / 10분 |
| `ui-pack` | UI 패키지의 tarball 내용, 빈 앱에서의 설치·타입·빌드·렌더 | UI 패키지가 쓰는 경로(`is_ui_pack_path`)를 바꾼 PR. 재사용하지 않은 main push | 2분 / 10분 |
| `sdk-pack-smoke` | SDK 번들의 버전, 빈 프로젝트에서의 설치·타입·샘플 실행 | `packages/sdk`, `packages/client`, `packages/contracts`, `examples`, lockfile처럼 SDK를 받는 쪽에 닿는 것을 바꾼 PR과 push | 2분 / 15분 |
| `workspace-quota` | quota가 되는 daemon에서 workspace 시험 | `docker` domain이 계획된 때 | 3분 / 15분 |
| `helm-chart` | `helm lint`, render 검사, kubeconform | chart 검사가 쓰는 경로(`is_helm_path`)를 바꾼 PR. 재사용하지 않은 main push | 1분 / 10분 |
| `k8s-smoke` | kind에 chart를 설치하고 install, session, reclaim, egress, upgrade, contract 단계를 지난다 | `deploy/` 아래, 실행 backend, scheduler, kind가 쓰는 stand-in, Dockerfile, lockfile, CI 계획 파일을 바꾼 PR. main push는 게시물을 이루는 경로와 릴리스가 필요한 commit도. 목록은 `.github/scripts/ci-plan.sh`의 `is_k8s_path`, `is_publish_path` | 9분 / 30분 |

`pages`와 `k8s-smoke`도 실패하면 `check`가 빨갛다. 필수 이름은 아니지만 필수 check를 막는다.

### integration의 구성원

| job | 지키는 것 | 도는 때 | 실행 시간 예산 (p90) / 한도 |
| --- | --- | --- | --- |
| `integration (<domain>)` 또는 `integration (<domain> i/N)` | 그 domain의 시험 파일 전부. junit을 읽어, 맡은 파일이 모두 돌았고 선언된 skip만 건너뛰었는지 확인한다 | 문서만 바꾼 변경은 없음. web console만 바꾼 변경은 `surface`. 그 밖은 전부 | 6분 / 15분 |
| `e2e` (`e2e-gate`) | 위 표 | 위 표 | 위 표 |
| `quickstart` (`quickstart-gate`) | 위 표 | 위 표 | 위 표 |
| `conformance (<engine>)` | 엔진 셋의 conformance suite | PR에서는 돌지 않는다. 릴리스가 필요한 main push(릴리스 여부를 읽지 못한 push도)와 수동 run | - / 30분 |

domain과 그 서비스는 `.github/integration-domains.yml`에 한 번 적는다.

| domain | job 수 | 서비스 |
| --- | --- | --- |
| `db` | 3 | postgres |
| `sessions` | 1 | postgres |
| `api` | 2 | postgres, localstack |
| `surface` | 3 | postgres |
| `storage` | 1 | localstack |
| `docker` | 1 | postgres, docker |
| `egress` | 1 | docker |
| `worker` | 3 | 없음 |

## 필수가 아닌 gate

PR의 merge를 막지 않는다. 경로가 닿는 PR에서 돌고, 일부는 밤마다 main에서 돈다. 실패가 남는 곳은 gate마다 다르다. 이슈를 여는 gate는 label로 같은 신호를 열린 이슈 하나에 모은다. 빠진 push run만 commit마다 이슈를 하나씩 연다.

| workflow | 지키는 것 | PR에서 도는 경로 | 야간 (UTC) | 야간·수동 run이 실패하면 |
| --- | --- | --- | --- | --- |
| `d2-gate.yml` | 이 checkout으로 빌드한 이미지의 compose 스택 전체에서 D2 완료 gate 항목(A–E, R1–R2, H1–H5) | gate 자신의 파일과, worker를 끝내고 turn을 닫는 코드(scheduler, reconciler, pass-loop, sessions, workers, worker 앱, 로컬 Docker backend) | 매일 18:17 | 이슈 `ci-d2-gate-failure` |
| `keycloak-login.yml` | 실제 Keycloak을 상대로 provider 로그인이 끝까지 된다: 추가, 시험 로그인, 켜기, 연결, 첫 가입, 미확인 계정 거절, 끄면 세션 종료, 틀린 PKCE 거절, 로그에 secret 없음 | 로그인 API, web의 로그인 화면, Keycloak compose, verify 스크립트 | 매일 18:47 | 이슈 `ci-keycloak-login-failure` |
| `k8s-replicas.yml` | api replica 둘 중 어디에 닿아도 세션 흐름이 맞고 turn이 두 번 돌지 않는다 | chart, kind 스크립트 | 없음 | 빨간 run뿐 |
| `k8s-upgrade.yml` | 기다리는 세션과 멈춘 세션이 helm upgrade와 rollback을 지나도 그대로다 | chart, `upgrade-check.ts`, kind 스크립트 | 없음 | 빨간 run뿐 |
| `k8s-netpol.yml` | chart의 NetworkPolicy가 실제 cluster에서 지켜진다. 정책을 끄면 열리고 다시 켜면 닫힌다 | NetworkPolicy·metrics template, kind 스크립트, workflow 자신 | 없음 | 빨간 run뿐 |
| `worker-compat.yml` | 지원 기간 안 릴리스의 worker·proxy 이미지 위에 지금 control host를 올려도 turn이 끝나고 checkpoint에서 이어진다 | workflow 자신, `worker-compat-plan.sh`, `tests/compat/` | 매일 04:41. 릴리스 때 `images.yml`이 부르고, 실패하면 릴리스가 멈춘다 | 빨간 run뿐 |
| `install-rehearsal.yml` | 게시된 릴리스를 바깥 운영자처럼(로그인과 token 없이) compose와 kind에 설치하면 `/readyz`가 200을 낸다 | workflow 자신, `rehearsal-release.sh` | 없음. 수동(릴리스 tag를 줄 수 있다) | 빨간 run뿐 |
| `litellm-price-drift.yml` | 모델 가격표가 LiteLLM의 가격에서 벗어나지 않았다. 적어 둔 의도한 차이는 허용한다 | 가격표와 비교 스크립트 | 월요일 00:17 | 이슈 `litellm-price-drift` |
| `package-retention.yml` | 패키지 보존 규칙의 시험과 dry run | 스크립트, 그 시험, workflow 자신 | 일요일 20:41 | 빨간 run뿐 |
| `forbidden-terms-threads.yml` | 댓글·리뷰·이슈는 push 없이 바뀌므로, 소유자·멤버·협력자가 글을 쓰거나 고치면 그 PR이나 이슈의 글을 다시 본다 | 경로가 아니라 댓글·리뷰·이슈 이벤트 | 없음 | 빨간 run뿐. PR의 필수 `forbidden-terms`가 다음 run에서 다시 읽는다 |
| `images.yml`의 야간 run | checkout의 Dockerfile로 두 아키텍처의 이미지를 빌드해 취약점을 다시 본다(게시하지 않는다). npm 감사도 한다 | - | 매일 03:17 | 이슈 `ci-supply-chain` |
| `images.yml`의 릴리스 경로(`release-gate`, `worker-compat-release`) | 릴리스할 commit에서 `ci.yml`의 push run이 green이고, 세 엔진의 conformance가 통과했고, main의 게시 chain이 chart 게시까지 갔고, 이전 worker와 호환된다 | - | 릴리스가 필요한 main push | 릴리스가 멈춘다 |
| `main-failure.yml` | main의 CI나 Images push run이 실패하면 commit, 그 PR, 실패한 job을 댄다. 되돌리지는 않는다 | - | run이 끝날 때마다 | 이슈 `ci-main-failure` |
| `main-push-run.yml` | 최근 36시간의 main commit마다 CI push run이 있다(15분이 안 된 commit과, 다른 push에 실려 들어온 commit은 뺀다). 그 run의 `agent-sdk-compat`이 마지막 시도에서 실패했으면 이슈가 있다 | - | 매일 03:23, 15:23 | 이슈 `ci-missing-push-run`, `ci-agent-sdk-compat-failure` |

### filter 밖 경로는 야간만 본다

경로 filter는 선을 그은 것이지 증명이 아니다. gate가 지키는 동작은 filter 밖의 코드도 바꿀 수 있다. filter 밖 경로만 바꾼 PR에서는 그 gate가 돌지 않는다. 야간 run이 있는 gate는 그날 밤 run이 처음 본다. 야간이 없는 gate는 다음에 경로가 닿는 PR이나 수동 run까지 아무도 보지 않는다. 야간 이슈가 열리면, 마지막으로 성공한 야간 run 뒤에 merge된 PR 중 아래 경로를 바꾼 것부터 본다.

| gate | PR에서 보지 않는 경로 | 뒤를 받치는 것 |
| --- | --- | --- |
| D2 gate | API server·app·readiness, `packages/contracts`, `packages/db/src/schema.ts`, `pool.ts`, `control-*.ts`. checkpoint·transcript·storage·runtime(`packages/platform/src/checkpoints`, `packages/db/src/checkpoints`, `packages/storage`, `packages/adapters/runtimes`)과 egress proxy | 야간 run |
| K8s replicas | API의 세션·이벤트 경로, 세션 store | 다음에 경로가 닿는 PR이나 수동 run. 야간 없음 |
| K8s upgrade | migration, upgrade hook이 부르는 코드 중 `upgrade-check.ts` 밖의 것, 세션 정지와 복원 | 다음에 경로가 닿는 PR이나 수동 run. 야간 없음 |
| Keycloak login | 로그인 경로 밖의 API 공통 코드(app, 미들웨어, 설정) | 야간 run |
| K8s NetworkPolicy | worker Pod에 label을 붙이는 실행 backend, chart의 다른 template, kind와 CNI 버전 | `k8s-smoke`의 egress 단계(아래 표). 야간 없음 |
| Worker compatibility | protocol, worker, migration을 바꾸는 제품 코드 전부 | 야간 run, 릴리스 때의 run |
| Install rehearsal | 게시물 전부 | 수동 run뿐 |

`k8s-smoke`의 egress 단계가 NetworkPolicy에서 덮는 것과 덮지 않는 것:

| | `k8s-smoke` egress 단계 | `k8s-netpol` |
| --- | --- | --- |
| worker label의 Pod가 egress proxy(3128, 3129)에 닿는다 | 본다 | 본다. proxy를 지나는 HTTP 요청까지 |
| 그 Pod에서 api, postgres, localstack, DNS, authorizer, internal, cloud metadata가 막힌다 | 본다 | 본다 |
| label 없는 Pod는 proxy에 닿지 못하고 api, postgres 등에는 닿는다(network 자체는 살아 있다). authorizer와 internal은 그 Pod에서도 막힌다 | 본다 | 본다. 대상은 더 적다 |
| kube-apiserver(Service와 node의 6443)와 바깥 주소가 막힌다 | 보지 않는다 | 본다 |
| 막힌 것이 정책 때문이다(정책을 끄면 열리고, 켜면 다시 막힌다) | 보지 않는다 | 본다 |
| 정책 변경이 node에 닿을 때까지 기다렸다가 판정한다 | 한 번만 시도한다 | 기다린다 |

`k8s-smoke`는 필수 `check`의 구성원이고 chart와 실행 backend를 바꾼 PR에서 돈다. 그래서 worker Pod가 cluster 안의 api, DB, DNS에 닿게 되는 회귀는 PR에서 잡힌다. worker Pod가 바깥 주소나 kube-apiserver에 닿게 되는 회귀와, 막힌 것이 정책 덕분인지는 `k8s-netpol`만 본다.

## 시간 목표와 runner

| 지표 | 목표 | 2026-11-13 ~ 11-27 |
| --- | --- | --- |
| PR 한 라운드: push에서 필수 일곱 개 green까지 | p50 10분 이하, p90 20분 이하 | p50 12.6분, p90 29.8분 |
| main CI의 flaky·infra 실패 (최근 100 run) | 0 | 1 |

실측은 `gh api`로 받은 그 기간의 run과 job 시각에서 나왔다. 한 라운드는 성공한 PR run 208개(첫 시도)의 필수 판정 job이 끝난 시각이다. main 실패는 push run 최근 100개의 실패 job을 오류 문장으로 분류했다.

- 실행 시간 예산은 job이 runner를 잡은 뒤의 시간이다. 대기는 들어 있지 않다.
- 이 저장소는 job이 약 20개까지 동시에 돈다. 공유 코드를 바꾼 PR run 하나가 job 27개, 약 76 job-분을 쓴다. 그래서 시간당 약 16 run이 한계다. PR run은 시간당 p50 9개, p90 26개, 최대 60개가 생긴다. 바쁜 시간에는 대기가 실행보다 길다.
- job을 더 잘게 나누면 job 하나는 짧아지지만 총량은 줄지 않는다. shard마다 설치와 서비스 기동이 반복되어 조금 는다(나누기 전 약 71 job-분). 대기를 줄이는 것은 run의 수와 run당 job-분이다. job을 더할 때 이 두 수를 PR 본문에 적는다.

`ci.yml`의 성공한 PR run의 길이는 이렇게 본다. `check`, `integration`, `e2e`, `quickstart`가 이 run에 있다. `gitleaks`, `forbidden-terms`, `supply-chain`은 다른 workflow가 내고 보통 먼저 끝난다. 실패한 라운드는 들어 있지 않다.

```sh
gh run list --workflow ci.yml --event pull_request --status success --limit 100 \
  --json databaseId,createdAt,updatedAt \
  --jq '.[] | "\(.databaseId) \(((.updatedAt | fromdate) - (.createdAt | fromdate)) / 60 | floor)분"'
```

## push 전에

PR CI 실패의 절반은 로컬에서 몇 초면 잡히는 결정적 가드다. CI에서는 push하고 5~9분이 지나야 드러나고, 그때마다 한 라운드를 버린다. push 전에 이것을 돌린다. 15초쯤 걸린다.

```sh
bun run check:fast
```

| 도는 것 | 잡는 것 | 2026-11-13 ~ 11-27에 PR CI에서 실패한 run |
| --- | --- | --- |
| `biome check --diagnostic-level=error .` | 형식과 lint. `bun run lint`와 같은 검사이고 error만 보인다 | 14 |
| `integration-jobs.ts files` | 새 시험 파일이 어느 integration domain에도 속하지 않는다 | 8 |
| `packages/core/src/bundle-budget.test.ts` | core 번들이 크기 예산을 넘는다 | 26 |
| `tests/architecture.test.ts` | 패키지 사이의 금지된 import | 22 |
| `packages/client/src/schema.gen.test.ts` | 생성 파일이 OpenAPI 사양보다 낡았다 | 13 |
| `packages/db/src/schema.test.ts`, `migration-folder.test.ts` | migration이 적용되지 않거나 고른 기본값·키·제약이 다르다. `schema.ts`가 가장 새 snapshot보다 앞서 있다. journal과 파일이 어긋난다 | 13. 이 수에는 PostgreSQL이 필요한 `schema-drift.integration.test.ts`의 실패가 섞여 있다. 선언과 migration 결과 전체의 비교는 그 시험만 하고, 묶음에는 없다 |
| `tests/docs-self-hosting-facts.test.ts` | 운영 문서의 한국어 원문과 영어·일본어 번역이 구조, 코드, 명령, 수치, 링크에서 어긋난다 | 14 |

- 새 gate가 아니다. CI는 같은 시험을 그대로 돌린다.
- 타입을 바꿨으면 `bun run typecheck`도 돌린다(CI에서 약 3분, 같은 기간 실패 11 run). 묶음에는 넣지 않았다.
- `bun run lint`는 진단을 20개까지만 보인다. warning이 그보다 많아서, 실패해도 error의 위치가 "Diagnostics not shown"에 묻힌다. 묶음은 error만 보이게 돌린다.
- 로컬의 typecheck, lint, 시험 전체는 `bun run check`다.

## 규칙

### 필수 이름

- 필수 이름은 바꾸지 않는다. 바꿔야 하면 ruleset, 이 문서, 그 이름을 읽는 배포 자동화를 같은 날 바꾼다.
- 필수 이름은 그 workflow의 job이 낸다. API로 check run을 만들어 내지 않는다.
- 경로 filter로만 도는 workflow는 필수로 만들지 않는다. 돌지 않는 PR이 영원히 기다린다. 필수로 지켜야 하면 `ci.yml`의 계획에 넣고 집계 job이 읽게 한다.

### 재시도

- 새로 넣는 재시도는 infra 단계에만 둔다: 이미지 pull, 서비스 기동, registry에 올린 직후의 읽기, 배포 API.
- 오류 문장이 정해진 것과 같을 때만, 횟수와 간격의 상한을 두고 다시 한다. 다른 오류는 바로 실패한다. 오류를 가리지 않고 다시 하는 예전 것이 둘 있다: `pages.yml`의 deploy(한 번), `check-agent-sdk-compat-job.sh`의 API 호출(세 번까지). 새로 넣는 것은 이 규칙을 따른다.
- 시험 assertion은 다시 하지 않는다. 실패한 suite를 통과할 때까지 돌리는 step은 두지 않는다. 상태가 자리 잡기를 기다리는 probe(서비스 준비, NetworkPolicy가 node에 닿기)는 재시도가 아니라 그 검사의 일부다.

### timeout

- CI의 suite step(`integration (<domain>)`, `check (<묶음>)`, `docs-checks`)은 `bun test --timeout=15000`으로 돈다. 로컬의 기본값은 bun의 5초 그대로다. 바쁜 runner에서 평소 2~3초인 시험이 5~7초가 걸리기 때문이다.
- 시험이 직접 준 한도와 시간을 재는 assertion은 그대로다.
- 통과한 integration job은 5초를 넘긴 시험을 notice 하나에 이름으로 댄다. 거기 자주 나오는 시험은 고칠 대상이다.
- 한도는 hook에도 적용된다. `(unnamed)`라는 시험이 `a beforeEach/afterEach hook timed out`으로 실패하면 그 파일의 `beforeAll`이 한도를 넘긴 것이다. migration을 돌리는 `beforeAll`이 바쁜 runner에서 그렇게 잘린다.
- DB 시험이 시간 초과로 끝나면 `Cannot use a pool after calling end on the pool`이 뒤따라 나와 첫 원인을 가린다. bun은 시간이 지난 시험의 본문을 멈추지 않고, 그동안 `afterAll`이 pool을 닫는다. 로그에서 `timed out`을 먼저 찾는다.

### 흔들리는 시험

- 흔들리는 시험마다 티켓을 하나 낸다. run 링크, 실패 문장, 몇 번 중 몇 번 났는지를 적는다.
- 제품의 race를 드러내는 시험은 격리하지 않는다. 그 시험이 유일한 지킴일 수 있다. 제품을 고친다.
- 격리는 하루 안에 고칠 수 없고 다른 시험이 같은 동작을 지킬 때만 한다. 그 case 하나를 `.github/integration-domains.yml`의 `skips`에 선언하고 티켓을 건다. 선언 없는 skip은 `integration`이 실패시킨다.
- 시험을 조용히 지우지 않는다.

### 새 시험과 새 gate

- `bun run test`가 도는 폴더(`tests`, `packages`, `apps`, `examples`)의 새 시험 파일은 integration domain 하나에 속해야 한다. 어디에도 속하지 않으면 그 run에서 도는 모든 `integration (<domain>)` job이 실패한다.
- 경로 한정 gate를 새로 더할 때는 야간 schedule과 실패 이슈를 함께 넣고, 위 두 표에 줄을 더한다.
- secret, 보안, 타입, 시험 gate는 빠르게 하려고 약하게 하지 않는다.

## ruleset과 맞추기

ruleset의 필수 이름과 이 문서의 표가 같은지는 아래 명령으로 본다. bash나 zsh에서 돌린다. `같다`가 나오면 같다. 다르면 `diff`가 차이를 보인다. 둘 다 아니면 두 목록 중 하나를 읽지 못한 것이다.

```bash
(
  set -o pipefail
  want=$(gh api repos/JeongJaeSoon/werft/rules/branches/main \
    --jq '[.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context] | sort | .[]') &&
    have=$(sed -n '/^## 필수 check$/,/^### /p' docs/ci/checks.md | grep -oE '^\| `[a-z0-9-]+`' | tr -d '| `' | sort) &&
    [ -n "$want" ] && [ -n "$have" ] && diff <(echo "$want") <(echo "$have") && echo 같다
)
```

ruleset은 저장소 설정이라 시험이 읽지 못한다. 필수 이름을 바꾸는 PR은 이 명령의 출력을 본문에 붙인다.

## 할 일

- 야간 D2 gate의 실패 이슈에, 마지막으로 성공한 야간 run 뒤에 merge된 PR 중 [filter 밖 경로](#filter-밖-경로는-야간만-본다)를 바꾼 것의 목록을 붙인다.