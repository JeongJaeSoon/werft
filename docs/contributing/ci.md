# CI에서 실행되는 것

`.github/workflows/images.yml`은 ci.yml과 별도 workflow로 세 앱 이미지를 빌드·smoke하고 digest artifact를 남긴다([이미지와 공급망 § 이미지와 Compose `apps` profile](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/images-and-supply-chain/#이미지와-compose-apps-profile)). 아래는 ci.yml이다.

`.github/workflows/ci.yml`은 먼저 `changes` job으로 검증 경로를 계획한다. 일반 제품 변경은 정적 검사 한 job·integration 일곱 도메인과 제품 검증을 실행하며, PR·수동 실행에서는 사이트도 검증한다. integration이 전체 unit도 실행하므로 unit 다섯 부분은 수동 `only=check`와 축소된 웹 계획에서만 실행한다. 알려진 문서 경로만 바뀐 PR과 main push는 문서·저장소 정책 검사를 남기고 제품 검증을 생략한다([경로와 required 판정](ci-path-plan.md)). push는 `main`으로 제한해 PR 커밋을 push와 pull_request로 중복 실행하지 않는다.

integration 스위트는 숫자 샤드가 아니라 도메인별 job 7개(`integration (db)`·`(api)`·`(surface)`·`(storage)`·`(docker)`·`(egress)`·`(worker)`)로 나뉘어 각자의 runner에서 돈다. job마다 **자기 파일이 요구하는 서비스만** 띄운다 — PostgreSQL만 쓰는 `db`는 LocalStack을 기다리지 않고, 서비스가 필요 없는 `worker`는 컨테이너 없이 곧바로 테스트에 들어간다. job끼리는 DB·컨테이너·네트워크를 공유하지 않고, 한 job 안에서는 파일들이 한 `bun test` 프로세스에서 순서대로 돈다. 어느 파일이 어느 job인지는 ci.yml의 `integration-domain` matrix에 있는 `paths`(저장소 기준 상대 경로의 접두어)가 유일한 기록이다. `.github/scripts/integration-jobs.ts`가 그것을 읽어 `package.json`의 `test` 스크립트가 도는 파일 전부를 나누고(파일 찾기는 `.github/scripts/test-files.ts` — Bun과 같은 규칙이며 Bun은 `tests packages apps` 인자를 디렉터리가 아니라 부분 문자열로 맞춘다), **어느 job에도 속하지 않는 파일, 두 job에 걸리는 파일, 아무 파일도 잡지 않는 접두어, 빈 job**이 하나라도 있으면 모든 integration job이 테스트 전에 실패한다. 같은 검사가 `tests/integration-jobs.test.ts`로 `check`에서도 돈다. 새 테스트 파일을 기존 접두어 밖에 만들면 matrix에 한 줄 넣어야 한다. 특정 도메인의 실행 시간이 지속적으로 길어지면 그 도메인을 의미 단위로 다시 나눈다 — `egress`(egress proxy와 worker 네트워크 격리, suite가 LocalStack 이미지를 직접 받아 혼자 70초 남짓)를 `docker`와 따로 두는 이유다.

서비스를 job마다 나누면 새 구멍이 하나 생긴다: 필요한 서비스가 없는 job에 들어간 파일은 opt-in 변수가 꺼져 있어 테스트가 실패하지 않고 **skip된다**. 그래서 각 job은 `bun test --reporter=junit`의 보고서를 같은 스크립트로 다시 읽어, 자기 파일이 전부 돌았는지, 다른 파일이 끼지 않았는지, matrix에 선언하지 않은 skip이 없는지 확인하고 하나라도 어긋나면 실패한다. 선언된 skip은 두 종류다. `integration (storage)`의 `packages/storage/src/git-runner.test.ts` 1건(Linux에서 의도적으로 skip)과, `integration (worker)`의 D2 gate 테스트(`tests/d2-gate/*.e2e.test.ts`, 스택 전체가 필요해 [D2 gate](#d2-gate-nightly)만 돌린다)다. 선언했는데 skip되지 않아도 실패한다. skip을 세지 못하는 유일한 형태 — opt-in이 꺼지면 테스트를 아예 선언하지 않는 것 — 는 쓰지 않는다(`tests/checkpoint-flow.test.ts`의 LocalStack 변형도 `describe.skip`으로 선언한다).

정적 검사 `check (static)`은 항상 실행한다. 수동 `only=check`와 웹 경로에서 실행하는 unit 다섯 부분(`check (unit: packages)`, `check (unit: db)`, `check (unit: worker, web)`, `check (unit: control Slack)`, `check (unit: other apps, tests)`)은 별도 job이다. `static`은 typecheck → lint → `THIRD_PARTY_NOTICES.md` 대조를 각각 별도 step으로 실행한다. 설치가 성공하면 typecheck가 실패해도 lint·라이선스는 취소 전까지 실행돼 한 번에 결과를 보고한다. unit은 `.github/scripts/unit-part.ts`가 `packages/db/`를 `packages-db`로, 나머지 `packages/`를 `packages`로, `apps/worker/`·`apps/web/`를 `worker-web`으로, `apps/control-host/src/slack/`를 `control-slack`으로, 나머지 전부를 `rest`로 나눈다. 기존 `rest`는 main 실행에서 8분42초·8분51초였고, [후자 실행](https://github.com/JeongJaeSoon/werft/actions/runs/42527182111)의 파일 경계 시각 기준 Slack 약 262초·나머지 약 241초로 나뉜다. 정상 job 실행을 6분 아래로 낮추기 위한 분할이며 기존 timeout 값은 바꾸지 않는다. 빈 부분은 전체 suite로 읽히므로 출력 전에 실패한다. 로컬 `bun run check`는 그대로 typecheck·lint·전체 테스트를 직렬로 돈다.

브랜치 보호의 필수 체크는 `check`·`integration`·`e2e`·`quickstart`, Images의 `supply-chain`, `forbidden-terms` 여섯 개다(2026-11-09 classic 보호 설정과 활성 ruleset을 함께 조회). `check`와 `integration`은 `always()`로 실행해 계획 성공과 실제 선행 결과를 판정한다. 제품 계획에서 실패·취소·timeout·skip은 성공이 아니며, 문서 계획의 명시적 생략은 문서 검사 성공 등 정해진 조합만 허용한다. `e2e`·`quickstart`는 계획을 먼저 검사한 뒤 무거운 step을 실행하거나 생략 이유를 남겨 success를 낸다. 두 job은 `!cancelled()`로 대체된 run에서 취소 가능하게 유지하고, required `integration`이 두 결과까지 기다려 취소·예상 밖 skip을 실패로 판정한다. 수동 `only=integration`에서만 두 job의 의도한 skip을 허용한다. 경로 감지 실패나 출력 누락은 required 실패다. `check`는 Storybook 접근성·문서 빌드·demo·UI 패키지 consumer·quota·Helm·Kubernetes·사이트 조립의 결과를 각 계획 값과 짝지어 판정한다. 계획이 켜진 job은 success, 꺼진 job은 skipped여야 하며 예정된 skip·실패·취소·누락을 거부한다. 수동 `only=check`에서만 선택 밖 소비자의 skip을 허용한다. main push의 `site=false`는 별도 `pages.yml` 빌드·배포를 보존한다. main Pages 배포와 비차단 SDK 호환성은 집계에서 제외한다. matrix의 `fail-fast: false`는 그대로다. main·제품 PR에서 정적 검사 1개와 integration 7개 외에도 제품·사이트 job들이 runner를 요청하므로 계정 동시성 한도에 닿으면 큐를 기다린다. 실제 job 수·점유·큐 산식은 [측정 기록](ci-optimization-2026-11.md)에 있다.

`agent-sdk-compat`는 **pull request에서는 돌지 않는다.** 결과가 어차피 run을 막지 않으므로(아래 참고) PR 커밋마다 돌려도 `main` push가 주는 신호 이상을 얻지 못한다. `main`의 제품 변경과 수동 실행에서 돈다. 정적 검사 후 시작하여 전체 integration 집계를 기다리지 않으며, 문서 전용 main에서는 생략한다. `scripts/agent-sdk-compat`을 건드리거나 SDK·LiteLLM 버전을 올리는 PR은 `-f only=agent-sdk-compat`로 직접 확인한다.

제품·정적 검사의 OS는 `ubuntu-24.04`로, Git·Bash 경로 계획은 `ubuntu-24.04-arm`으로 고정한다. `ubuntu-latest`의 자동 major-version 변경을 피하기 위한 것이며, runner 이미지의 패치 업데이트까지 고정하는 것은 아니다. `timeout-minutes`는 `check (static)` 9분, `check` unit 각 부분 12분(`other apps, tests`가 main에서 7분24초~8분41초 걸렸고 실패한 테스트 없이 9분 제한에 취소됐다), integration 도메인 job 15분, `workspace-quota`·`agent-sdk-compat` 15분이며, 계획과 결과를 판정하는 집계 job `check`·`integration`은 2분이다. integration에서 가장 긴 `surface`·`db` 도메인은 성공한 실행에서 최대 9분53초·9분52초였고, 느린 runner에서는 같은 커밋 재실행으로 추정한 소요가 10분30초~11분이어서 실패한 테스트 없이 10분 제한에 취소되기도 했으므로 15분을 허용한다. 두 도메인 모두 위의 분할 기준을 넘었지만, `surface`만 나누면 `db`의 취소 위험이 남아 제한을 먼저 올렸다. HTTP 경로와 제어 흐름은 `api`, Slack·계약·클라이언트·화면은 `surface`로 나눠 한 프로세스에 쌓이지 않게 한다. 한 번 멈춘 job이 태우는 분의 상한이지 정상 실행에 거는 제약이 아니다. 경로 계획은 3분, 문서 전용 `docs-checks`는 12분을 상한으로 둔다.

그 대가로 **pull request가 없는 브랜치에 push하면 CI가 돌지 않는다.** PR을 열기 전에 확인하고 싶으면 `workflow_dispatch`로 수동 실행한다(`gh workflow run CI --ref <branch>`). tag push도 빌드하지 않는다 — 태그가 가리키는 트리는 이미 main push에서 돌았다. merge queue를 켜려면 `merge_group` 이벤트를 따로 추가해야 한다.

`concurrency`는 PR이면 PR 번호로 묶어 새 push가 이전 run을 취소한다. `main` push는 SHA별로 묶고 진행 중인 실행은 취소하지 않는다. 같은 커밋의 중복 대기 이벤트만 합친다. 자동 릴리스가 해당 커밋의 CI 성공을 기다리므로 최신 main만 남기는 취소는 적용하지 않는다. 이미지 게시도 커밋별 그룹을 유지하여 릴리스 승격 중 취소하지 않는다. 중복 unit과 문서 전용 제품 검증을 제거하여 main의 작업량을 줄인다. 수동 실행은 기본적으로 workflow·이벤트·ref·SHA·only 선택이 같은 진행 중 run을 대체해 실수로 여러 번 실행한 작업의 중첩을 줄인다. 다른 브랜치·다른 SHA·PR·main push를 취소하지 않고, 이미 끝난 run의 재실행까지 막는 것은 아니다. 식이 `inputs.*`가 아니라 `github.event.inputs.*`를 읽는 이유는 API 경유 dispatch가 입력을 문자열로 보내기 때문이다 — 문자열 `"false"`는 truthy라 `!inputs.allow_parallel`이면 기본값이 조용히 "병렬 허용"으로 뒤집힌다.

## 금칙어 검사

`.github/workflows/forbidden-terms.yml`의 job `forbidden-terms`가 현재 트리, 이번 run이 더한 커밋 메시지(PR이면 PR 커밋, push면 push된 커밋), PR 제목·본문에서 공개하면 안 되는 표현을 찾는다. 목록은 저장소 secret `FORBIDDEN_TERMS`(줄마다 확장 정규식 하나)에만 있고 어떤 공개 파일에도 없다. 저장소가 public이라 Actions 로그도 공개이므로 `.github/scripts/forbidden-terms.ts`는 위치별 **건수만** 찍고 값·경로·줄·sha는 찍지 않는다. 어디에 있는지는 목록을 가진 사람이 로컬 `git grep -i -E -f`로 찾는다. 대소문자는 구분하지 않고, 경계는 목록의 각 정규식이 스스로 정한다.

ci.yml의 job이 아니라 별도 workflow인 이유는 PR 제목·본문을 고칠 때(`edited`)도 다시 검사해야 하는데, ci.yml의 `concurrency`는 같은 PR의 진행 중 run 전체를 취소하기 때문이다.

secret이 없거나 비어 있으면 **실패한다.** 검사하지 못한 것을 통과로 읽으면 안 된다. fork PR과 Dependabot PR은 `pull_request`에서 secret을 받지 못하므로 같은 이유로 실패하고, 실패 문구만 fork일 때 따로 나온다. fork PR은 메인테이너가 브랜치를 이 저장소로 옮겨 검사한다. Dependabot PR을 통과시키려면 Dependabot secret에도 같은 이름으로 등록해야 한다.

합성 목록으로 하는 시험은 `tests/forbidden-terms.test.ts`다. 실제 목록으로 시험하지 않는다.

## 수동 실행 옵션

```bash
gh workflow run CI --ref <branch>                               # 모든 job (agent-sdk-compat 포함)
gh workflow run CI --ref <branch> -f only=agent-sdk-compat      # agent-sdk-compat만
gh workflow run CI --ref <branch> -f allow_parallel=true        # 진행 중 수동 run을 취소하지 않음
```

`only`는 그 job 하나만 남기고 나머지를 건너뛴다. flaky 추적처럼 한 job의 결과만 필요한 수동 실행에서 나머지 job 값을 내지 않기 위한 것이다.

`allow_parallel=true`는 수동 실행을 run별로 분리하므로 같은 SHA를 반복 실행해도 서로 취소되지 않는다. flaky 표본은 이것으로 모은다 — `only=agent-sdk-compat`와 함께 N번 dispatch한다. 기존 브랜치는 변경된 workflow를 가져와야 이 기본값들이 적용된다.

예산 `$0`과 사용 중지를 유지한다. 포함 분이 소진되어 GitHub가 job을 시작하지 않으면 재시도해도 복구되지 않는다. 한도 초기화 또는 별도로 승인된 runner 대안이 필요하며, CI 최적화는 이미 사용한 분을 되돌리지 않는다.

외부 action은 태그가 아니라 **커밋 SHA로 고정하고 버전은 뒤 주석에 적는다.** 태그는 움직인다 — 메인테이너(혹은 탈취된 계정)가 `v7`을 임의 커밋으로 다시 가리키면 다음 run이 그 코드를 받는다. 릴리스 태그를 악성 커밋으로 옮기는 것이 tj-actions/changed-files 공급망 공격이 수천 개 저장소에 닿은 경로였다. 고정만 하고 방치하면 그 자체가 문제이므로 `.github/dependabot.yml`이 주 1회 올린다(composite action은 `directory`를 따로 잡아야 스캔된다). 올라온 PR에서는 새 버전이 요구하는 러너 버전도 같이 본다.

bun 버전 고정과 `~/.bun/install/cache` 캐시는 `.github/actions/bun-setup`에 모여 있다. 캐시 키는 **그 job이 실제로 설치하는 lockfile만** 해시한다 — `check (static)`이 쓰는 `bun-root-*`는 root lockfile만(unit 부분·문서 검사·integration 도메인 job은 읽기만 한다), `agent-sdk-compat`가 쓰는 `bun-agent-sdk-compat-*`는 root와 harness lockfile을 함께 해시한다. 키가 두 lockfile을 약속하면서 root만 설치한 job이 저장하면, harness 전용 의존성은 exact hit인데도 매번 다시 받게 된다. scope마다 쓰기 job은 하나뿐이라 같은 키에 동시 저장하는 레이스도 없다. 의존성을 설치하지 않는 job(`forbidden-terms`, `helm-chart`, `supply-chain`)은 `restore-cache: "false"`로 복원을 건너뛴다. 이 입력은 복원과 저장을 한 번에 하는 단계를 건너뛰므로 `save-cache: "true"`와 함께 쓰면 job이 실패한다. 스크립트가 `node:` 내장과 이 repo의 파일만 import한다는 것이 소스로 확인된 job에만 쓴다. 그 밖의 import는 Bun이 이 캐시로 내려받는다.

PR 이벤트에서는 `save-cache: "true"`를 요청해도 Bun 의존성 캐시를 복원만 하고 저장하지 않는다. setup-bun의 실행 파일 캐시는 PR에서 `no-cache`로 끈다. main·수동·예약 실행의 지정된 writer만 의존성 캐시를 저장한다. `Cache restore result`는 요청 키와 `exact-hit=true/false`, 실행 파일 캐시 hit를 출력한다. exact-hit=false는 완전한 cache miss 또는 prefix 복원이며, 설치 성공 여부를 뜻하지 않는다. 이미지 캐시는 기존 앱·아키텍처별 `cache-from`을 유지하고, PR은 읽기만 한다. main·태그·예약·수동 실행의 export는 `mode=min`으로 최종 release stage의 레이어만 보존한다. 중간 빌드 stage까지 저장하던 `mode=max`보다 보존 범위가 작으며, 공용 캐시 한도 안에서 최종 이미지 재사용을 우선한다. 실제 hit는 BuildKit의 `CACHED` 로그로, 공용 사용량은 `gh api repos/JeongJaeSoon/werft/actions/cache/usage`로 확인한다.

서비스 이미지 이름은 upstream tag로 적었다. 실제로는 ghcr.io 미러에서 digest로 받는다([§ 서드파티 이미지 미러](#서드파티-이미지-미러)).

| job | 서비스 컨테이너 | 켜지는 opt-in 변수 | 실행 명령 | 머지 차단 |
|---|---|---|---|---|
| `changes` | 없음 | 없음 | PR 전체 diff로 경로 계획; main·수동은 전체 계획 | required 판정으로 |
| `check (static)` | 없음 | 없음 | `bun run typecheck`, `bun run lint`, `bun scripts/third-party-notices.ts --check` | 집계로 |
| `docs-checks` | 없음 | 없음 | 문서 전용 PR에서 `bun test ./tests` | 집계로 |
| `check (unit: packages)`, `check (unit: db)`, `check (unit: worker, web)`, `check (unit: control Slack)`, `check (unit: other apps, tests)` | 없음 | 없음 | `bun test <unit-part.ts가 고른 파일>` (`packages/db/` / 나머지 `packages/` / `apps/worker/`·`apps/web/` 아래 / `apps/control-host/src/slack/` / 그 나머지) | 집계로 |
| `check` | 없음 | 없음 | 계획·정적·unit 또는 문서 검사 결과의 허용 조합 확인 | ✅ |
| `integration (db)` | `postgres:16` | `QUEUE_DATABASE_URL` | `bun test <db 파일>` | 집계로 |
| `integration (api)` | `postgres:16`, `localstack/localstack:3` | `QUEUE_DATABASE_URL`, `STORAGE_LOCALSTACK_TEST=1` | `bun test <api 파일>` | 집계로 |
| `integration (surface)` | `postgres:16`, `localstack/localstack:3` | `QUEUE_DATABASE_URL`, `STORAGE_LOCALSTACK_TEST=1` | `bun test <surface 파일>` | 집계로 |
| `integration (storage)` | `localstack/localstack:3` | `STORAGE_LOCALSTACK_TEST=1` | `bun test <storage 파일>` | 집계로 |
| `integration (docker)` | `postgres:16` (+ runner의 Docker daemon) | `QUEUE_DATABASE_URL`, `DOCKER_BACKEND_TEST=1` | `bun test <docker 파일>` | 집계로 |
| `integration (egress)` | 없음 (runner의 Docker daemon, suite가 LocalStack을 컨테이너로 직접 띄움) | `DOCKER_BACKEND_TEST=1` | `bun test <egress 파일>` | 집계로 |
| `integration (worker)` | 없음 | 없음 | `bun test <worker 파일>` | 집계로 |
| `integration` | 없음 | 없음 | 계획·도메인·E2E·quickstart 결과의 허용 조합 확인 | ✅ |
| `workspace-quota` | 없음 — xfs+prjquota loop 파일을 data root로 쓰는 dind daemon을 job이 직접 띄운다 | `DOCKER_BACKEND_TEST=1`, `DOCKER_HOST` | `bun test packages/adapters/execution/local-docker/src/workspace.integration.test.ts` | ❌ (아래 참고) |
| `e2e` | 없음 — compose `apps` profile 전체를 job이 직접 띄운다(runner의 Docker daemon, 28 이상) | `E2E_API_URL`·`E2E_API_KEY`(run.sh가 설정) | 제품 계획이면 `tests/e2e/run.sh`, 문서 전용이면 계획 검사와 생략 이유 기록 — 이미지 빌드 → 스택 → key → `bun test ./tests/e2e/remote-mcp.e2e.ts ./tests/e2e/operator-profiles.e2e.ts ./tests/e2e/alpha-path.e2e.ts ./tests/e2e/pause-coverage.e2e.ts ./tests/e2e/workspace-loss.e2e.ts` | ✅ |
| `quickstart` | 없음 — `docs/quickstart.md`와 `apps/docs/content/docs/reference/api-guide.mdx`가 차례로 띄우는 기본 project·포트 그대로 | 없음 | 제품·가이드 변경이면 `tests/e2e/quickstart.sh [문서]`, 그 외 문서 전용이면 계획 검사와 생략 이유 기록 — 두 문서의 `bash` 블록을 각각 한 셸(`bash -euo pipefail`)에서 실행. runner에 Bun을 설치하지 않는다 | ✅ |
| `agent-sdk-compat` | 없음 | 없음 | `scripts/agent-sdk-compat`의 `probe:version`·`check` (uv로 `litellm[proxy]==1.100.1` 설치) | ❌ |

전체 제품 계획의 unit 부분은 opt-in 변수를 하나도 켜지 않으므로 PostgreSQL·LocalStack·Docker를 요구하는 테스트가 **의도적으로 skip된다**. 반대로 외부 의존이 없는 테스트는 파일 이름에 `integration`이 들어 있어도 여기서 그대로 돈다 — 로컬 fake Messages API를 쓰는 SDK adapter suite가 그렇다. 같은 스위트를 integration 도메인 job들이 각자 필요한 변수를 켠 채 다시 돌려 opt-in 때문에 생기는 skip을 없앤다(ci.yml `skips`에 선언된 것 — `git-runner.test.ts` 1건과 D2 gate 테스트 — 만 남고, 그 외의 skip은 job을 실패시킨다). 파일 이름으로 integration만 골라 돌리지 않는 이유는 `packages/storage/src/checkpoint-objects.localstack.test.ts`처럼 `*.integration.test.ts` 규칙을 따르지 않으면서 opt-in에 걸린 테스트가 있어서다 — 이름 필터는 테스트를 조용히 빠뜨린다. 로그에서 pass 숫자만 보지 말고 `check` unit 부분들의 skip 합과 integration 도메인 job들의 skip 합을 같이 확인한다. 나뉜 뒤에는 네 unit 부분(또는 일곱 도메인 job)의 `N pass`·`N skip`·`across N files`를 더한 값이 단일 job으로 돌릴 때의 숫자다. 합계는 이렇게 낸다(정규식은 도메인별로 나누기 전의 숫자 샤드 run도 잡는다):

```bash
gh run view <run-id> --log | grep -E '^integration \([^)]+\)' | grep -oE '\s[0-9]+ (pass|fail)$' \
  | awk '{s[$2]+=$1} END {printf "pass=%d fail=%d\n", s["pass"], s["fail"]}'
gh run view <run-id> --log | grep -E '^check \(unit: ' | grep -oE '\s[0-9]+ (pass|skip|fail)$' \
  | awk '{s[$2]+=$1} END {printf "pass=%d skip=%d fail=%d\n", s["pass"], s["skip"], s["fail"]}'
```

`DOCKER_BACKEND_TEST=1`은 runner에 딸린 Docker daemon으로 `LocalDockerBackend` 테스트를 돌리게 한다.

`workspace-quota` job은 runner의 daemon으로는 확인할 수 없는 절 하나만을 위해 있다. workspace volume의 byte 상한은 daemon 저장소가 project quota를 감당할 때만 서는데(xfs + `prjquota`) runner의 data root는 ext4다. 그래서 이 job은 loop 파일에 xfs를 만들어 `prjquota`로 mount하고 그것을 data root로 쓰는 dind daemon을 띄운 뒤 workspace suite를 그쪽에 붙인다 — 상한을 넘는 `dd`가 실제로 `No space left on device`로 끝나는지, 그리고 volume을 지운 뒤 만든 다음 workspace에도 상한이 서는지 확인하는 곳은 여기뿐이다. 같은 suite가 `integration (docker)`에서는 반대쪽 절을 확인한다: 상한을 걸 수 없는 daemon에서 scheduler가 기동을 거절하는지.

`agent-sdk-compat` job은 제품 테스트가 보지 않는 SDK 계약을 확인한다. `scripts/agent-sdk-compat`은 SDK·LiteLLM 버전을 올릴 때 돌리는 호환 harness로, 실제 LiteLLM proxy를 거친 왕복을 여기서만 확인한다([결정 기록](decisions/agent-sdk.md)). 지금까지 CI 실패가 전부 flaky였다(제품 회귀 0건). 그래서 `agent-sdk-compat` job은 `continue-on-error: true`로 workflow run을 실패시키지 않는다. 저장 backend(SessionStore)의 계약은 이 job이 아니라 제품 테스트가 지킨다([결정 기록](decisions/session-store.md#지금-이-계약을-지키는-테스트)).

**이 설정이 무엇을 숨기는지 분명히 해둔다.** `agent-sdk-compat` check-run 자체는 실패로 남아 checks 목록에 빨갛게 보이지만(실측: 커밋 `2640693`에서 이 job이 `failure`, run `conclusion=success`), run 결론만 읽는 소비자 — 알림, 대시보드, release automation — 에게는 harness 회귀가 보이지 않는다. 그래서 job 마지막에 suite의 outcome을 run summary에 적는다(취소되지 않은 run이면 언제나 — 취소·timeout으로 job이 끊기면 이 표도 남지 않는다). 여기에 더해 **suite의 outcome이 `success`가 아니면 GitHub 이슈를 연다**(setup이 깨져 suite가 돌지 못한 경우 포함; job timeout·cancel과 이슈 호출 자체의 실패는 이 스텝이 못 잡고 아래 `main-push-run.yml`이 job 결론으로 잡는다)(이 job은 PR에서 돌지 않으므로 `main` push와 수동 실행이 대상이고, 이슈 본문에 ref·SHA·run이 적힌다)(label `ci-agent-sdk-compat-failure`). 같은 label로 열린 이슈가 있으면 새로 만들지 않고 그 이슈에 코멘트를 붙이므로 반복 실패가 이슈로 쌓이지 않는다. 사람이 닫으면 다음 실패는 새 이슈가 된다. `.github/scripts/upsert-ci-issue.sh`가 이 upsert를 맡고, 이슈 조회는 search API가 아니라 list API로 한다 — search는 인덱싱이 늦어 몇 분 간격의 두 run이 각자 이슈를 만든다. 같은 순간에 두 run이 실패하면 둘 다 빈 목록을 보고 각자 만들 수 있으므로, 만든 뒤 다시 조회해 자기 것이 가장 오래된 열린 이슈가 아니면 중복으로 닫고 본문을 그쪽에 붙인다.

**`agent-sdk-compat`를 required로 올리지 않는 이유**도 여기 적어 둔다(`ci.yml`의 job 주석과 같다). (1) PR에서 돌지 않는 context를 required로 걸면 모든 PR이 `Expected — Waiting for status`로 멈춘다. (2) PR에서 다시 돌리면 PR에서 빼서 아낀 비용이 되살아난다 — 세 job 중 가장 비싼 job이다. (3) 모든 `main` push에서 이미 돌아 회귀가 한 커밋 안에 잡히므로 PR 게이팅이 더해 주는 것이 없다. 남는 위험은 "회귀가 들어간다"가 아니라 "들어간 걸 아무도 모른다"였고, 그것을 위 이슈가 메운다.

**push run 자체가 누락되는 경우**는 `ci.yml`이 감지할 수 없다 — run이 없으니 아무것도 돌지 않는다(실측: `70139eb`에 `event=push` run 0건). `.github/workflows/main-push-run.yml`이 하루 두 번 최근 36시간의 `main` 커밋 각각에 `ci.yml`의 `event=push` run이 있는지 `.github/scripts/check-main-push-run.sh`로 확인하고(tip만 보면 누락 커밋 뒤에 정상 push가 오는 순간 영영 못 본다), 없으면 label `ci-missing-push-run`으로 **커밋마다** 이슈를 연다(같은 upsert의 `--by-title` 모드: label + 정확한 제목이 식별자이고 제목에 커밋 SHA가 있다). 커밋은 나중에 push run이 생기지 않으므로 사람이 닫은 이슈는 그 커밋의 확인으로 간주해 다시 열지 않고, 다른 커밋의 누락을 거기에 덧붙이지도 않는다. 조회 실패(API 오류)는 `missing`과 exit code가 달라(2 vs 1) 워크플로가 실패로 남는다 — 일부만 판정한 목록을 답으로 치지 않는다. 갓 push된 커밋은 run이 생기기까지 시간이 걸리므로 15분 미만은 판정하지 않는다. `gh workflow run 'main push run' -f sha=<commit>`으로 특정 커밋을 검사할 수 있다.

**한 push에 합쳐진 커밋은 누락이 아니다.** 두 PR이 1초 안에 squash 머지되면 GitHub는 main ref 갱신을 한 번만 기록한다(`654a3388 → 95b0e7b5`). 가운데 커밋(`1583f5d`, `6e7badf`)은 tip이 된 적이 없어 push 이벤트도 run도 없다. 그 변경은 합쳐진 push의 run이 자기 트리에서 검증하고, 그 run은 tip 커밋의 run으로서 같은 점검(`agent-sdk-compat` 결론 포함)을 따로 받는다. 그래서 run이 없는 커밋이 나오면 main ref activity(`repos/{repo}/activity?ref=refs/heads/main`)를 한 번 읽어 둘을 가린다.

- 커밋이 어떤 갱신의 `before`나 `after`로 나오면 tip이었던 것이므로 `missing`이다. `70139eb`은 다음 갱신이 그 커밋에서 출발했다.
- 나오지 않으면 부모를 따라 올라간다. 처음 만나는 tip에서 출발한 갱신 중 `after`가 그 커밋을 포함하는 것(compare API `ahead`)이 있으면 `coalesced <커밋> <그 갱신의 after>`로 적고 이슈를 열지 않는다. tip은 force push로 되돌아와 여러 번 출발점이 될 수 있으므로 출발점만 보고 판정하지 않는다.
- activity에 흔적이 없거나(한 달치만 읽는다), 그런 갱신이 없거나, 10단계 안에 tip에 닿지 않으면 `missing`으로 남긴다.

같은 워크플로가 push run이 있는 커밋마다 그 run의 **`agent-sdk-compat` job 결론**을 `.github/scripts/check-agent-sdk-compat-job.sh`로 읽는다. job 안의 이슈 스텝은 자기를 멈추게 한 실패 — job timeout·cancel, `continue-on-error`에 가려진 `gh` 호출 실패 — 를 보고할 수 없기 때문이다. 결론이 `success`·`skipped`가 아닌데(run에 job이 하나도 없으면 `missing`) `ci-agent-sdk-compat-failure` 이슈 중 어느 것도(닫힌 것 포함) 본문이나 코멘트에 그 run URL을 담고 있지 않으면, run URL을 담아 같은 upsert로 보고한다. 그래서 in-run 스텝이 이미 보고한 실패나 사람이 닫아 확인한 실패는 다시 보고하지 않는다. 조회는 search API 대신 list API로 run 생성 시각 이후 바뀐 이슈·코멘트만 읽는다. job이 아직 끝나지 않았으면 `pending`으로 넘기고 36시간 창 안의 다음 확인이 다시 본다. run은 오래된 것부터 판정한다 — 워크플로가 제한 시간에 잘려도 곧 창을 벗어날 run이 먼저 끝나고, 새 run은 다음 확인이 다시 본다. 한 run의 조회 실패는 나머지 판정을 막지 않지만 워크플로를 실패로 남긴다. `gh workflow run 'main push run' -f run_id=<ci.yml run id>`로 run 하나(push가 아니어도)만 판정할 수 있다.

**재시도 wrapper는 쓰지 않는다.** 이 job은 `continue-on-error`라 실패가 머지를 막지 않으므로 재시도가 사는 것은 안전이 아니라 flaky가 보일 확률의 감소뿐이다 — 재현율 14%가 2%가 된다. 실패는 첫 발생에서 바로 보여야 원인을 찾을 수 있다.

`e2e`와 `quickstart`는 세션 경로 전체를 제품 그대로 확인한다. 둘 다 이 커밋에서 api·scheduler·worker·egress-proxy 이미지를 빌드하고, worker 안에서는 실제 Claude Code가 compose의 fake Messages API(프롬프트의 `GATE-SPEC` 대본을 재생)와 이야기한다. 로컬 스택의 기본은 실제 Messages API이므로 둘 다 `--fake-model` overlay(`infra/compose.fake-model.yml`)를 명시해 띄우고, 모델 계정은 쓰지 않는다. `e2e`는 별도 compose project·임시 루프백 포트에서 공개 HTTP만으로 생성→이벤트→권한 응답→후속 메시지→interrupt→pause→resume(복원)→terminate→복구 결정→resume과 동시성 회귀 4종을 돌고, 첫 줄에 command·tested SHA·docker engine·이미지 id 네 개·SDK와 Claude Code 버전을, 끝에 skip 목록을 남긴다. compose·worker 컨테이너·테스트 로그는 `e2e-record` artifact에 있다(worker 컨테이너는 끝나면 지워지므로 `docker events`로 시작마다 로그를 따라가 저장한다). `quickstart`는 새 clone에서 `docs/quickstart.md`와 `docs/api-guide.md`의 `bash` 블록을 문서별 한 `bash -euo pipefail`로 실행한다. 문서를 고쳐 명령이 깨지거나 `jq -e`·`test` 검증이 실패하면 그 자리에서 red가 된다. 실행하지 말아야 할 블록은 문서에서 `sh`나 `text`로 적는다. `quickstart` job은 runner에 Bun을 설치하지 않으므로, 문서의 `bash` 블록이 host의 Bun을 부르면 여기서 실패한다(key 발급은 `scripts/local.sh key`가 api 컨테이너 안에서 한다).

`main` branch protection은 **`check`와 `integration`을 둘 다 required로** 켜 두었다. `e2e`와 `quickstart`도 required다. PostgreSQL·LocalStack 검증은 `check`가 아니라 `integration`에 있으므로, `check`만 required로 두면 `integration`이 실패한 PR도 머지된다. `agent-sdk-compat`는 required에서 제외한다. images.yml의 `supply-chain`도 required다(아래 § 제3자 라이선스와 취약점). **`workspace-quota`는 아직 required가 아니다** — 켤 때 함께 넣는다. 이 job이 확인하는 것(상한이 실제로 무는지)은 다른 어떤 job도 확인하지 못하므로, required가 아닌 동안에는 빨간 `workspace-quota`를 사람이 직접 봐야 머지를 막을 수 있다.

**건너뛴 job은 GitHub의 required-check 판정에서 성공으로 센다** — 성공 상태는 `success`·`skipped`·`neutral` 셋이다([Status checks](https://docs.github.com/en/pull-requests/reference/status-checks)). 비용 절감을 위해 job을 건너뛰게 한 설정은 그래서 두 가지 주의를 남긴다.

1. `needs`로 건너뛴 `integration`도 통과로 보이므로 `integration`만 required로 두면 안 된다. `check`도 함께 required여야 `check` 실패가 머지를 막는다.
2. `only=`를 쓴 수동 실행은 건너뛴 job을 **그 커밋에 성공으로 기록한다.** branch protection을 켠 뒤에는 PR head SHA에 대고 `only=`를 쓰지 않는다. 필요하면 PR을 열기 전 브랜치에서 쓰거나, 검증은 PR 자동 실행에 맡긴다.

반대로 **workflow 전체가 건너뛰어지면**(path·branch 필터, commit message) 체크는 `pending`으로 남아 머지를 막는다. 그래서 비용을 줄이려고 `on:`에 `paths` 필터를 거는 방식은 여기서 쓰지 않았고, 건너뛰기는 전부 job 단위 `if:`로만 한다.

## D2 gate (nightly)

D2 gate는 정상 경로와 장애 뒤 복원(A–E), reconciler sweep(R1–R2), control-host role 수명주기(H1–H5)를 스택 밖에서 확인한다. 이 테스트들은 이 커밋에서 빌드한 이미지로 compose 스택 전체를 띄워야 돈다. 그래서 ci.yml은 이 테스트들을 `integration (worker)`의 선언된 skip으로 두고, 실제로는 `scripts/d2-gate/run.sh`만 이 테스트들을 돌린다. 사람이 손으로만 돌리면 harness가 조용히 낡는다. harness가 incremental bundle을 chain 없이 unbundle해 main `33a9c99c`에서 gate A가 깨졌는데, 누군가 돌려 보기 전까지 아무도 몰랐다.

`.github/workflows/d2-gate.yml`이 이 틈을 메운다.

- **언제 도는가:** 매일 03:17 KST(`schedule`, main), 수동 실행(`gh workflow run 'D2 gate' --ref <branch>`), 그리고 gate 자신(`scripts/d2-gate/`, `tests/d2-gate/`, `.github/scripts/d2-gate-verdict.ts`, 이 workflow)을 바꾼 pull request. 이미지 Dockerfile·lockfile·Compose·CI mirror overlay·Bun setup 변경도 실행한다. 일반 `ci.yml` 편집은 필수 정책 시험과 worker JUnit 검증으로 skip 계약을 확인하므로 gate 전체를 추가로 실행하지 않는다.
- **무엇을 하는가:** runner의 Docker daemon에서 `scripts/d2-gate/run.sh`를 돈다. `D2_GATE_COMPOSE_OVERRIDE`로 `tests/e2e/compose.ci-mirror.yml`과 `scripts/d2-gate/compose.ci-mirror.yml`을 얹어 서드파티 이미지를 모두 미러에서 받는다. 끝나면 `.github/scripts/d2-gate-verdict.ts`가 테스트마다 이름과 결과(PASS·FAIL·SKIP·MISSING)를 로그와 run summary에 찍고, A–E의 기준표(`report.md`)도 summary에 붙인다. A는 복원 중 S3 5xx를 해제한 뒤 같은 worker가 진행하는지, D는 사라진 execution의 `outcome_unknown`을 운영 결정으로만 정리하는지도 포함한다. 검사 대상은 ci.yml이 d2-gate 테스트로 선언한 skip 목록이다. 그중 하나라도 PASS가 아니면 gate가 실패한다. bun의 종료 코드만으로는 skip됐거나 아예 돌지 않은 테스트가 실패로 잡히지 않기 때문이다. build·compose·worker·suite 로그는 `d2-gate-record` artifact에 있다. run의 API key가 든 `vars.sh`는 올리지 않는다.
- **실패하면:** schedule이나 수동 실행에서 gate job이 `success`로 끝나지 않으면 별도 job `report-failure`가 label `ci-d2-gate-failure`로 이슈를 연다. 같은 job의 마지막 step이 아니라 별도 job인 이유는 job timeout이 남은 step을 모두 취소하기 때문이다. 멈춘 gate는 다른 job에서만 보인다. 이미 열린 이슈가 있으면 거기에 코멘트를 붙인다(`agent-sdk-compat`와 같은 upsert). pull request에서는 빨간 check가 곧 신호이므로 이슈를 열지 않는다.
- **required가 아니다.** 대부분의 PR에서 돌지 않으므로 required로 걸면 그 PR들이 `Expected — Waiting for status`로 멈춘다. 이 workflow에만 `paths` 필터를 쓰는 것도 required가 아니어서 가능하다. pending이 머지를 막지 않는다. required로 올리는 것은 branch protection 변경이라 사용자 승인 사항이다.

## 서드파티 이미지 미러

`integration` 도메인 job, `workspace-quota`, `e2e`·`quickstart`가 받는 서드파티 이미지는 Docker Hub가 아니라 `ghcr.io/jeongjaesoon/werft-ci/<name>`에서 **upstream digest 그대로** 받는다. 대상은 서비스 컨테이너(PostgreSQL·LocalStack), Docker suite가 Engine API로 직접 받는 이미지(busybox·`oven/bun`·curl·LocalStack, workspace-migration helper), `workspace-quota`의 dind와 inode helper의 base, `e2e`·`quickstart`가 띄우는 compose 스택의 이미지(PostgreSQL·LocalStack·`oven/bun`)와 앱 이미지 빌드의 base·Dockerfile frontend다. 위 표의 이름(`postgres:16` 등)은 upstream tag이고, ci.yml은 그 tag가 가리키던 digest를 고정한다. `.github/workflows/ci-image-mirror.yml`이 `skopeo copy --all --preserve-digests`로 index 전체(모든 플랫폼과 attestation)를 바이트 그대로 옮긴다. 그래서 ghcr의 digest가 Docker Hub의 digest와 같고, `docker buildx imagetools inspect postgres:16`이 보여 주는 digest를 ci.yml의 값과 바로 비교할 수 있다. suite 코드의 기본값(`busybox:1.36` 등)은 로컬 실행용으로 그대로 두고, CI만 `BUN_TEST_IMAGE`·`DOCKER_BACKEND_TEST_IMAGE`·`EGRESS_CURL_TEST_IMAGE`·`EGRESS_PROXY_TEST_IMAGE`·`EXECUTION_WORKSPACE_MIGRATION_IMAGE`·`LOCALSTACK_TEST_IMAGE`로 mirror를 가리킨다.

compose 스택도 같은 원칙이다. `infra/compose.core.yml`·`infra/compose.local.yml`의 `image:`와 앱 Dockerfile의 `ARG BUN_IMAGE` 기본값은 로컬 사용자용으로 Docker Hub 이름 그대로 두고, CI만 `tests/e2e/compose.ci-mirror.yml` overlay를 얹는다. overlay는 서드파티 서비스의 `image:`를 같은 digest의 미러 참조로 바꾸고, 빌드하는 서비스에 `BUN_IMAGE`·`BUILDKIT_SYNTAX` build-arg를 넘긴다(`images.yml`과 같은 방식). `e2e`는 `E2E_COMPOSE_OVERRIDE`로 `tests/e2e/run.sh`에 넘기고, `quickstart`는 `COMPOSE_FILE=compose.yaml:tests/e2e/compose.ci-mirror.yml`로 넘긴다. 그래서 `docs/quickstart.md`의 명령은 CI 전용 줄 없이 쓰인 그대로 돈다. D2 gate workflow는 여기에 gate 전용 서비스(`gate-chaos`·`gate-messages`)의 `oven/bun`을 미러로 바꾸는 `scripts/d2-gate/compose.ci-mirror.yml`을 하나 더 얹는다([§ D2 gate](#d2-gate-nightly)).

`images.yml`의 앱 이미지 빌드도 같은 미러에서 받는다. `build`·`publish`·`publish-main`은 `BUN_IMAGE` build-arg로 Dockerfile 기본값과 **같은 digest**의 미러 참조를 넘긴다. base 바이트가 같으므로 빌드 결과도 같다. 다섯 `setup-buildx-action`은 `driver-opts: image=`로 미러의 BuildKit(`moby/buildkit:v0.32.2`, 고정 당시 `buildx-stable-1`)을 띄운다. Dockerfile 첫 줄 `# syntax=docker/dockerfile:1.7`의 frontend도 BuildKit이 Docker Hub에서 받으므로 `BUILDKIT_SYNTAX` build-arg로 같은 tag의 미러 digest를 넘긴다. Dockerfile의 `ARG BUN_IMAGE` 기본값은 로컬 빌드용으로 Docker Hub 이름 그대로 둔다. `tests/ci-images.test.ts`가 세 참조를 미러 목록과, `BUN_IMAGE`의 digest와 frontend tag를 모든 앱 Dockerfile과 대조한다.

`build` job의 buildkit layer cache(`type=gha`)는 읽기는 모든 이벤트에서, 쓰기는 `pull_request`를 뺀 이벤트(main·태그 push, schedule, dispatch)에서만 한다. PR의 코드가 쓰는 캐시는 그 PR만 읽어서 저장소 캐시 한도만 채우고, 쓰는 쪽을 main 쪽으로 좁히면 PR이 main이 읽는 캐시를 오염시킬 길이 없다. 대가로 PR의 이어 push는 앞선 push의 layer가 아니라 main의 캐시에서 읽는다.

**실측에서 미러는 준비 시간을 줄이지 못했다.** ghcr의 LocalStack pull은 약 24초로 Docker Hub(약 25초)와 같았다. pull 시간은 받는 곳이 아니라 약 1 GB layer를 푸는 데 든다. `Initialize containers`의 나머지는 서비스 health 대기(LocalStack 약 14초)다. 이 미러가 주는 것은 rate limit 제거와 digest 재현성이다.

그래서 준비 시간은 기동 방식으로 줄인다. `integration` 도메인 job은 `services:`를 쓰지 않는다. runner는 `services:`를 첫 step보다 먼저, 서비스마다 차례로 pull·기동하고 health를 2·4·8초 backoff로 기다린다. 그래서 `services:`를 쓰면 `integration (api)`의 `Initialize containers`가 PostgreSQL pull·LocalStack pull·health 대기의 직렬 합이 된다(실측 46초). 대신 checkout 바로 뒤 step이 `.github/scripts/ci-services.sh start`로 필요한 서비스를 백그라운드에서 `docker run`한다. pull이 서로, 그리고 bun 설정·설치와 겹친다. 테스트 직전 `ci-services.sh wait`가 1초 간격으로 `pg_isready`·`/_localstack/health`를 컨테이너 안에서 확인한다(기동이 끝나지 않았으면 먼저 기다린다). docker 호출 하나는 10초로 끊으므로 daemon이 멈춰도 기한을 크게 넘기지 않는다. 180초 안에 준비되지 않거나, `docker run`이 실패하거나, 컨테이너가 멈추면 `::error::`와 함께 `docker run` 출력과 컨테이너 로그 끝 200줄을 남기고 테스트 전에 실패한다. 포트(5432·4566)·환경 변수·probe는 `services:`를 쓸 때와 같고, 컨테이너(`ci-postgres`·`ci-localstack`)는 `always()` step이 지운다. checkout 뒤에 두는 이유는 스크립트가 저장소에 있어서다. checkout은 1~2초라 잃는 겹침이 작다. `agent-sdk-compat`는 서비스 컨테이너를 쓰지 않는다.

미러를 고른 이유는 Docker Hub를 CI 경로에서 **아예 빼는** 유일한 방식이어서다. 익명 pull 한도(`toomanyrequests`)로 integration run이 실패한 적이 있고, 서비스 컨테이너만이 아니라 suite 안의 pull도 한도를 먹는다. 버린 두 방식과 그 이유는 이렇다.

- **actions cache**(`docker save` tar를 캐시하고 `docker load`): 서비스 컨테이너는 첫 step보다 먼저 뜨므로 캐시를 쓰려면 `services:`를 step으로 다시 짜야 한다. LocalStack tar만 1 GB를 넘어 저장소 캐시 10 GB를 bun 캐시와 나눠 쓰게 되고, 캐시가 밀려나면 조용히 Docker Hub로 돌아간다. `docker load`도 layer를 푸는 시간은 pull과 같다.
- **digest 고정 + 사전 pull만**: 재현성은 얻지만 받는 곳이 여전히 Docker Hub라 rate limit 위험이 그대로다. digest 고정은 미러와 함께 가져왔다.

**`tests/ci-images.test.ts`**(`integration (worker)`와 수동·웹 unit 검사에서 돈다)가 지키는 것:

- ci.yml의 서비스 이미지와 `*_IMAGE` 변수가 전부 mirror 참조다. mirror 목록에 있는 upstream `name:tag`는 ci.yml 어디에도 나오지 않는다.
- ci.yml의 mirror 참조는 전부 `<name>@sha256:…`이고, 그 `name`·digest 쌍이 mirror 목록에 있다.
- suite 파일이 읽는 `process.env.*_IMAGE`는 전부 `integration-domain`의 `env`에서 mirror로 설정돼 있다. 기본값이 문자열이면 mirror 항목의 upstream `name:tag`와 같아야 한다(로컬과 CI가 같은 버전을 돈다).
- busybox 항목에 `DEFAULT_MIGRATION_HELPER_IMAGE`의 digest가, bun 항목에 모든 앱 Dockerfile `BUN_IMAGE`의 digest가 있다. `workspace-quota`가 빌드하는 inode helper의 `FROM`은 worker Dockerfile과 같은 digest의 미러 참조다.
- compose overlay가 로컬 스택(`infra/compose.yml`이 합치는 core와 로컬 layer)의 서드파티 이미지마다 같은 `name:tag@digest`의 미러 참조를 두고, 빌드하는 서비스마다 그 Dockerfile의 `BUN_IMAGE` digest와 frontend tag에 맞는 미러 참조를 build-arg로 넘긴다. `e2e`·`quickstart` job이 overlay를 얹는다.

정적 검사는 코드가 이미지를 부르는 모양을 다 알 수 없다. 그래서 Docker를 쓰는 job은 마지막에 **daemon이 실제로 가진 이미지**를 본다. `integration-domain`의 모든 job, `workspace-quota`(runner daemon과 중첩 daemon 둘 다), `e2e`·`quickstart`가 그렇다. `.github/scripts/assert-no-docker-hub-images.sh`가 `docker images`에 Docker Hub 이미지가 하나라도 있으면 그 이름을 `::error::`로 찍고 job을 실패시킨다. 판정은 Docker의 이름 규칙 그대로다. 첫 경로 성분에 `.`·`:`가 없거나 `localhost`가 아니면, 또는 `docker.io`면 Docker Hub다. "미러만"이 아니라 "Docker Hub 아님"으로 거는 이유는 runner 이미지에 원래 들어 있는 이미지(`ghcr.io/github/…`, `ghcr.io/dependabot/…`) 때문이다. 아무 step도 받지 않았는데 daemon에 있다. 판정 대상은 각 이미지의 `RepoDigests`, 곧 어디서 pull했는지다. daemon에서 직접 빌드한 이미지는 `RepoDigests`가 없어 건너뛴다. 빌드의 `FROM` 이미지는 image 목록에 남는다는 보장이 없으므로, 빌드 step은 base를 미러 참조로 직접 적어야 한다. 정적 가드는 ci.yml의 `*_IMAGE` 값 중 미러가 아닌 것을 같은 workflow 안의 `-t <값>` 빌드로만 허용한다. 테스트가 실패한 job에서도 돈다. 새 `docker run alpine`이든, 환경 변수 없이 Engine API로 받는 suite든, 받은 경로와 상관없이 잡힌다.

**미러 갱신 절차**(digest를 올리거나 이미지를 더할 때). mirror job은 `main`에서만 돌므로 PR 두 개로 나뉜다.

1. 새 digest를 확인한다: `docker buildx imagetools inspect <upstream>:<tag> --format '{{json .Manifest}}' | jq -r .digest`
2. **PR 1**: `ci-image-mirror.yml` matrix에 새 항목을 **더한다**. 기존 digest 항목은 지우지 않는다. 같은 `name`에 digest 두 개가 있어도 된다. 머지하면 `main` push의 `CI image mirror` run이 새 digest를 ghcr에 올린다. run의 `mirror (<name>:<tag>)` job이 초록인지 확인한다.
3. **PR 2**: ci.yml의 참조를 새 digest로 바꾸고, 더는 쓰지 않는 옛 항목을 목록에서 지운다. suite가 직접 받는 새 이미지는 `integration-domain`의 `env`에도 넣는다. compose 스택의 이미지(`infra/compose.core.yml`·`infra/compose.local.yml`, 앱 Dockerfile의 `BUN_IMAGE`)를 올렸으면 `tests/e2e/compose.ci-mirror.yml`도 같은 digest로 바꾼다. `scripts/d2-gate/compose.yml`의 `oven/bun`을 올렸으면 `scripts/d2-gate/compose.ci-mirror.yml`도 바꾼다. 어긋나면 `tests/ci-images.test.ts`가, 빠뜨린 pull은 `Nothing pulled from Docker Hub` step이 실패한다.
4. 새 이미지의 ghcr package는 이 public 저장소에 연결되어 public으로 생긴다(첫 mirror run의 여섯 package가 모두 그랬다). 서비스 컨테이너와 Engine API로 받는 suite는 인증 없이 받으므로 public이어야 한다. private으로 생기면 mirror job이 로그아웃 뒤 익명 조회에서 실패한다. 그때는 GitHub의 package 설정(Package settings → Danger Zone → Change visibility)에서 public으로 바꾸고 그 job을 다시 돌린다.
5. 목록을 바꾸지 않고 다시 복사하려면 `gh workflow run 'CI image mirror'`를 쓴다(`main`에서만 돈다). 이미 있는 blob은 건너뛴다.

목록에서 지운 digest도 ghcr에는 untagged로 남는다. 이전 커밋의 CI를 다시 돌려도 받을 수 있도록 지우지 않는다.

mirror job은 `images.yml`의 게시 job처럼 **리뷰를 거친 코드에서만** package write를 쥔다. 그 token은 이 저장소가 쓸 수 있는 모든 package, 곧 앱 릴리스 이미지까지 쓸 수 있다. 그래서 pull request trigger가 없고, `main`이 아닌 ref에서 dispatch하면 job을 건너뛴다. digest를 올리는 PR이 자기 run에서 미러하게 하면 PR이 고칠 수 있는 workflow에 package write를 주게 되어 `images.yml`의 게시 경계를 우회하므로, 두 단계로 나눈다.

## 제3자 라이선스와 취약점

배포 이미지에 들어가는 제3자 구성요소의 목록과 고지는 저장소 루트의 `THIRD_PARTY_NOTICES.md`다. 세 이미지 모두 이 파일을 `/app`에 싣는다.

```bash
bun scripts/third-party-notices.ts            # bun.lock과 node_modules에서 다시 만든다
bun scripts/third-party-notices.ts --check    # 최신이 아니거나 검토 안 된 라이선스가 있으면 실패
bun scripts/third-party-notices.ts --debian-sources   # Debian 시스템 안에서: 설치된 패키지의 대응 소스 목록(DEBIAN_SOURCES.md)
```

- **목록의 범위.** 이미지마다 Dockerfile이 설치하는 production closure를 `bun.lock`에서 계산한다. control-host는 `--filter ./apps/control-host`에 더해 이미지가 싣는 웹 콘솔 번들(`apps/web/dist`)이 담는 `packages/ui`·`packages/client`의 의존성, worker는 `--filter ./apps/worker`, egress-proxy는 설치가 없다. optional 의존성은 이미지를 빌드하는 linux x64·arm64 둘 다 센다. 그래서 어느 머신에서 돌려도 같은 파일이 나온다. 라이선스와 NOTICE는 설치된 패키지에서 읽는다. 이 머신에 설치되지 않은 다른 arch 빌드는 생성할 때만 npm registry에서 라이선스를 읽고, `--check`는 커밋된 파일의 값을 쓴다. 그래서 `--check`는 네트워크가 필요 없다.
- **라이선스 정책.** MIT·Apache-2.0·BSD 계열·ISC 같은 허용 목록 밖의 라이선스는 스크립트의 `REVIEWED`에 검토한 라이선스 문자열과 이유를 함께 적어야 통과한다. 같은 패키지라도 라이선스가 바뀌면 다시 검토해야 한다. SPDX 식은 괄호·AND·OR 우선순위대로 읽는다. 지금은 `@anthropic-ai/claude-agent-sdk`와 그 플랫폼 빌드(Anthropic 상용 약관)뿐이다. Apache-2.0 패키지가 NOTICE 파일을 싣고 있으면 그 전문을 고지 파일에 옮긴다(현재 closure에는 없다). 베이스 이미지(Bun이 정적 링크한 LGPL JavaScriptCore·TinyCC, Debian 패키지)와 worker의 Claude Code 실행 파일은 고지 파일의 첫 절에 적는다.
- **버전에 묶인 고지.** 스크립트의 `BUN_BUILDS`는 Dockerfile이 고정한 Bun 버전마다 commit(`bun --revision`)과 정적 링크한 WebKit·TinyCC commit을 적는다. `CLAUDE_CODE_BUN`은 Agent SDK 버전마다 번들 Claude Code가 내장한 Bun 버전을 적는다. Bun이나 SDK를 올리면 두 표에 새 항목을 넣을 때까지 `--check`가 실패한다. 값은 oven-sh/bun의 해당 tag(1.3.14부터 `scripts/build/deps/webkit.ts`의 `WEBKIT_VERSION`과 `scripts/build/deps/tinycc.ts`의 `TINYCC_COMMIT`, 그 전에는 `cmake/tools/SetupWebKit.cmake`·`cmake/targets/BuildTinyCC.cmake`)와 실행 파일 안의 `Bun v<버전>` 문자열에서 읽는다.
- **Debian 대응 소스.** 세 Dockerfile은 마지막 `apt-get` 뒤에 `--debian-sources`를 돌려 `/app/DEBIAN_SOURCES.md`를 쓴다. 이 파일은 설치된 모든 Debian 패키지의 source package·버전과 snapshot.debian.org 주소다. `apt-get upgrade` 때문에 버전이 빌드마다 달라서 저장소에 커밋하지 않고 이미지에서 만든다.
- **핀한 deb 내려받기.** worker Dockerfile의 git-lfs 단계가 받는 ca-certificates deb은 `ADD --checksum`이 아니라 `scripts/fetch-pinned.ts`로 받는다. `ADD`에는 재시도가 없어서, snapshot.debian.org가 핀과 다른 body를 한 번 돌려준 것만으로 빌드가 실패했기 때문이다. 이 스크립트는 틀린 body를 요청 실패처럼 보고 최대 4번(5·10·15초 간격) 다시 받으며, 핀(sha256)과 같은 bytes만 파일로 쓴다. 네 번 모두 틀리면 빌드가 실패한다. 핀은 풀지 않는다. 시도마다 받은 digest가 빌드 로그에 남는다. 이 스크립트는 git-lfs 단계에서 bind mount로만 읽어 이미지에 들어가지 않는다. 검증은 `tests/fetch-pinned.test.ts`(틀린 bytes를 주는 로컬 서버)다.
- **required 경로.** `check (static)`의 라이선스 step이 `--check`를 돈다. 의존성을 추가하고 파일을 다시 만들지 않거나 검토되지 않은 라이선스가 들어오면 필수 체크 `check`가 실패한다.
- **실제 이미지와 대조.** images.yml의 build job이 빌드한 이미지 안에서 `--verify <image> /app`을 돌린다. 확인하는 것은 다음과 같다. 하나라도 어긋나면 build job이 실패한다.
  - `/app/node_modules`의 모든 패키지가 그 이미지 몫으로 목록에 있다.
  - 라이선스 파일(LICENSE·COPYING 등)을 싣지 않은 패키지는 모두 고지의 "라이선스 파일이 없는 npm 패키지" 절에 있다. 고지는 그 패키지들의 저작권자와 라이선스 전문(MIT 전문, Apache-2.0은 이미지 안 사본)을 대신 싣는다. 전문을 싣지 않는 라이선스의 패키지가 파일 없이 들어오면 `--check`가 실패한다.
  - 이미지의 Bun이 `BUN_BUILDS`의 commit이다. worker에서는 Claude Code 실행 파일이 `CLAUDE_CODE_BUN`의 Bun을 내장한다.
  - 고지가 가리키는 GPL-2·GPL-3·LGPL-2.1 전문이 `/usr/share/common-licenses/`에 있다.
  - `/app/DEBIAN_SOURCES.md`가 그 이미지의 dpkg 데이터베이스와 같다. 파일을 쓴 뒤의 단계가 패키지를 바꾸면 여기서 걸린다.
  - 설치된 Debian 패키지마다 `/usr/share/doc/<패키지>/copyright`가 있다(`.github/scripts/image-licenses.sh`).
- **Debian 소스 보관 확인.** 게시 경로의 `sources`·`sources-main` job이 `.github/scripts/image-sources.sh`로 snapshot.debian.org가 여섯 이미지의 `DEBIAN_SOURCES.md`에 적힌 소스를 실제로 갖고 있는지 본다(`--snapshot-check`, `/mr/package/<소스>/<버전>/srcfiles`). PR·매일 실행의 `build`는 묻지 않는다. 자원봉사 서비스이고 부하가 높으면 503·504를 돌려준다. 그래서 목록을 합쳐 소스마다 한 번만 묻는다(이미지별로 494건이던 것이 약 100건이다). 답을 못 받은 소스는 간격을 두고 라운드로 다시 묻는다. 요청 하나는 30초까지, 전체는 main 10분, 태그 30분까지다. 이 시간이 지나면 남은 소스를 응답 없음으로 친다. 없다는 답은 장애 중의 오답일 수 있어 두 번 받아야 믿고, 뒤에 `held`를 받으면 그것을 따른다. 한 번 없다고 답한 뒤 시간이 끝날 때까지 답이 없으면 없는 것으로 친다. 태그는 응답 없음이면 실패한다. main은 경고하고 그 소스를 이미지별 `unverifiedSources`에 적는다. snapshot은 몇 시간마다 archive를 들여오므로 Debian 보안 수정 직후의 빌드는 아직 없는 버전을 적을 수 있고, "없음"이 확정되면 main도 실패한다. 각 시도는 확인한 소스를 `held-sources-<job>-<시도>` artifact(`if: always()`)로 올리고, 같은 run의 재실행은 그 합집합을 받아 남은 소스만 다시 묻는다(`--prior`·`--held-out`). artifact 저장·복원에 실패하면(업로드 실패, 만료) 전체를 다시 묻는다. 판정은 합집합 위에서도 같다. 끝에는 HTTP 상태별 응답 수(`responses: 200=… 504=… timeout=…`)를 로그에 남겨 서비스 쪽 부하와 러너 쪽 문제를 가린다.
- **판정: required `supply-chain`**. images.yml의 `supply-chain` job이 아래 두 검사의 결과 파일(`clean`·`found <n>`·`error`)을 모아 `.github/scripts/supply-chain-verdict.sh`로 판정한다. **수정판이 있는** high·critical이 하나라도 있으면 실패하고, 수정판 없는 것은 summary와 `supply-chain-results` artifact에만 남는다. 검사가 답을 받지 못한 `error`는 PR·main push에서 경고, 매일 실행·수동 실행·tag에서 실패다. 결과 파일이 없으면(build 실패, run 취소) 어디서든 실패한다. 건너뛴 required check는 통과로 세므로 조건은 `always()`다. 정책과 예외 파일은 [이미지와 공급망 § 공급망 취약점 정책](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/images-and-supply-chain/#공급망-취약점-정책)에 있다. 매일 03:17 UTC 실행과 수동 실행이 실패하면 `vulnerability-report` job이 `ci-supply-chain` 라벨 이슈를 연다.
- **npm 취약점.** `.github/scripts/npm-audit.ts`가 `bun audit --json`으로 lockfile 전체(dev 의존성 포함)의 advisory를 받는다. `bun audit`은 advisory가 있을 때와 요청이 실패했을 때 모두 exit 1이라, 판정은 JSON으로 한다. `bun audit`은 수정판 유무를 주지 않으므로, high·critical마다 GitHub advisory API(`/advisories/<GHSA>`)에서 잠긴 버전을 포함하는 범위의 `first_patched_version`을 읽는다. JSON이나 API 응답이 없으면 `error`다.
- **이미지 취약점.** images.yml의 build job이 이미지·아키텍처마다 Grype(릴리스 바이너리를 아키텍처별 버전과 sha256으로 고정)로 Debian 패키지와 `/app`의 npm 패키지를 검사한다(`.github/scripts/image-scan.sh`). `supply-chain`은 `<app>-<arch>` 여섯 결과와 npm을 모두 요구하므로, arm64 빌드가 실패하거나 runner가 없으면 PR의 required check도 실패한다. 로그에는 전체 표가 남는다. summary에는 수정판 있는 high·critical과 접힌 수정판 없는 목록이, artifact에는 이미지별 JSON이 남는다. build job 자체는 발견으로 실패하지 않는다. 판정은 `supply-chain`의 몫이다. Debian 패키지는 각 Dockerfile의 배포 stage가 `apt-get upgrade`로 올린다. build job은 UTC 날짜를 `APT_UPGRADE_KEY` build arg로 넘겨, 날이 바뀌면 gha cache의 upgrade layer를 다시 만든다. 그래서 매일 실행은 그날 나온 Debian 수정까지 반영한 이미지를 검사한다. 패키지 제거가 필요한 수정은 `upgrade`가 보류하므로(이미지에서 full-upgrade는 하지 않는다) 이 검사에 그대로 남는다. 색인을 받지 못한 source가 있으면 `apt-get update --error-on=any`가 빌드를 실패시킨다. tag의 `publish` job은 `supply-chain`을 기다린다. 또 이미지를 다시 빌드하므로 승격될 digest에 라이선스 대조와 검사를 한 번 더 돌린다. 거기서는 검사가 돌지 못하거나 수정판 있는 high·critical이 있으면 실패한다.
- **도구를 고른 이유.** `bun audit`은 Bun에 들어 있어 새 설치가 없고 bun.lock을 그대로 읽는다. OSV-Scanner도 bun.lock을 읽지만 바이너리를 하나 더 고정해야 한다. 이미지 검사는 Grype다. Trivy는 action 태그가 탈취된 적이 있고, DB를 ghcr에서 받다가 rate limit에 걸리는 일이 잦다. Grype는 action 없이 릴리스 바이너리 하나로 돈다.
