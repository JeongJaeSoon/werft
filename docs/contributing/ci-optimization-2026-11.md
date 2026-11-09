# 2026-11-06 CI 최적화 측정

## 2026-11-09 후속 재구성

아래 11월 6일 표는 당시 측정 기록이다. 현재 운영 정책은 이 절과 [실행 계약](ci.md), [경로 계획](ci-path-plan.md)을 따른다.

### 확인한 병목

- [CI 실행 42525813733](https://github.com/JeongJaeSoon/werft/actions/runs/42525813733)의 `check (static)`은 생성 21:33:37 UTC, 시작 21:47:16 UTC, 종료 21:50:19 UTC였다. 큐 13분 39초에 비해 실제 실행은 3분 3초였다. 같은 실행의 여러 제품 job도 약 14~16분 큐를 기다렸다. runner를 더 많이 요청하는 병렬화만으로 해결할 문제가 아니다.
- CI의 main 동시성 그룹은 `run_id`로 분리되어 후속 merge마다 전체 작업량이 누적됐다. 다만 자동 릴리스는 특정 커밋의 CI 성공을 요구하므로 이 동시성만 바꿔 과거 실행을 취소하면 릴리스가 깨진다.
- integration 도메인은 `package.json`의 전체 테스트 파일을 서로 겹치지 않게 실행한다. 일반 제품 계획에서 별도 unit 4개 runner가 같은 파일을 다시 실행했다.
- 문서 전용 생략은 PR에만 적용되어 main에 머지하면 제품 검증과 여섯 이미지 빌드, 이미지·차트 게시가 다시 실행됐다.
- UI consumer smoke가 CI `ui-pack`과 `ui-release`의 PR 실행에 중복됐다. Images의 모든 PR은 두 아키텍처 여섯 빌드를 요청했다.

### 적용한 정책

| 상황 | CI 검증 | 이미지·게시 |
| --- | --- | --- |
| 일반 제품 PR | static과 integration 7개 도메인 병렬, E2E·가이드·관련 제품 검사 | amd64 세 이미지 build·smoke·라이선스·취약점 검사, 게시 없음 |
| 웹 전용 변경 | surface와 기존 unit 4개로 저장소 정책까지 확인, E2E·접근성 유지 | amd64 세 이미지 검사, 게시 없음 |
| 문서 전용 PR·main | static·정책 검사, 바뀐 실행 가이드와 사이트 검사 | 이미지 빌드 생략, 의존성 audit은 유지, main 이미지·차트 게시 생략 |
| 제품 main | SHA별 검증 유지, 같은 SHA의 중복 대기 이벤트·중복 unit 4개 제거 | 양쪽 아키텍처 검사·게시와 기존 릴리스 승인 경계 유지 |
| 정기 검사 | 기존 D2 전체 스택 검사 유지, 중복 전체 CI cron 추가 없음 | 기존 매일 이미지 취약점 검사 유지 |
| 태그 릴리스 | 기존 승인·소스·digest 검증 유지 | 양쪽 아키텍처 검사와 승인 후 게시 |

일반 제품 PR에서 기존 대비 중복 unit 4개와 arm64 이미지 3개, 합계 7개 실행 job을 줄인다. 측정 비교군 대비 경로 계획용 Images job 1개가 포함된다. 작업 중 main에 추가된 기존 Images plan을 재사용하므로 최신 main 기준으로 별도 planner를 더 만들지 않는다. UI 패키지 PR은 별도의 중복 release build도 없어진다. 이는 구성상 job 차이이며 실제 대기시간 개선율은 배포 후 동일한 기간·이벤트 구성으로 다시 측정해야 한다.

기존 Bun 다운로드 캐시, 아키텍처별 BuildKit layer 캐시, 서비스 pull과 의존성 설치의 겹치기는 유지한다. Next.js는 `.next/cache`만 lockfile·소스 해시로 재사용하며 최종 산출물을 다른 실행에서 가져오지 않는다. 캐시는 main에서만 저장하고 PR은 읽기만 하여 PR별 컴파일 캐시가 저장소 한도를 채우지 않게 한다. quota 검사는 경로 계획 직후, SDK 호환성은 정적 검사 후 시작하여 전체 integration 집계를 기다리는 직렬 의존성을 없앤다. 문서 전용 main은 SDK 호환성 검사도 생략한다. 불필요한 matrix 동시성 제한은 추가하지 않는다. 작은 job 수를 늘리는 대신 중복 runner 요청을 줄인다.

### 실패와 운영 경계

`check`, `integration`, `e2e`, `quickstart`, `supply-chain`, `forbidden-terms` 필수 이름은 유지한다. classic 보호 설정에 다섯 개, 활성 ruleset에 금칙어까지 여섯 개가 있음을 함께 확인했다. `check`는 기존 job 수를 늘리지 않고 접근성·패키지·quota·Helm·Kubernetes·사이트 조립의 실패·취소까지 집계한다. 계획 실패·빈 출력·취소·예상하지 못한 skip·누락 이미지 결과는 실패한다. `CHANGELOG.md`는 릴리스 입력이어서 문서 전용 생략 대상에서 제외한다. main 이전 범위의 fetch 실패도 성공으로 바꾸지 않는다.

main 이미지 게시를 최신 ref 취소로 바꾸지 않는다. 각 merge의 이미지 digest와 차트, CHANGELOG 기반 릴리스를 중간에 잃지 않기 위해 커밋별로 실행한다. PR에서는 arm64 전용 회귀 발견이 main 검사까지 늦어지는 절충이 있으며 게시 전에는 두 아키텍처 검사·smoke가 모두 통과해야 한다. 아키텍처 관련 변경은 Images를 해당 브랜치에서 수동 실행해 merge 전에 두 아키텍처를 검증한다.

main 감시의 기존 취소·timeout·lookup 오류 보고를 유지한다. 자동 릴리스의 `release-auto.sh ci`가 정확한 SHA의 성공을 요구하므로 main CI와 이미지 게시의 커밋별 실행을 함께 보존한다. 향후 main 실행까지 합치려면 릴리스용 검증을 먼저 분리해야 한다. 현재 대기 중인 다른 PR의 실행이나 저장소 보호 설정은 변경하지 않는다. 이 변경은 merge 후 발생하는 이벤트부터 적용되므로 이미 큐에 있는 이전 workflow 실행은 별도 정리가 필요하다.

공식 동시성 동작은 [GitHub Actions concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)를 따른다.

D2 PR trigger에서 일반 `ci.yml` 편집은 제외한다. 이 파일의 D2 skip 계약은 필수 정책 시험과 worker의 JUnit 검증이 확인한다. gate 코드·테스트·판정기·D2 workflow와 실제 빌드 입력(Dockerfile·lockfile·Compose·mirror overlay·Bun setup)이 바뀌면 전체 스택을 계속 검증하며, 야간 실행도 유지한다.

### 실제 Actions 비교 기준

비교군은 CI·Images가 모두 성공하고, 두 workflow blob이 수정 전 정의와 일치하며, CI가 25개·Images가 8개 job을 실행한 PR 세 쌍이다. 다른 최적화가 섞인 PR과 웹 축소 계획을 제외했다. 각 쌍의 head SHA도 같다. 워크플로를 수정한 이번 PR에서만 추가되는 D2 검사와 별도 금칙어 검사, SDK/UI 릴리스는 이 표의 CI·Images 비교에 합산하지 않는다.

| 비교군 CI / Images 실행 | CI runner분 | Images runner분 | 합계 runner분 |
| --- | ---: | ---: | ---: |
| [42520754118](https://github.com/JeongJaeSoon/werft/actions/runs/42520754118) / [42520754108](https://github.com/JeongJaeSoon/werft/actions/runs/42520754108) | 94.67 | 18.08 | 112.75 |
| [42520748529](https://github.com/JeongJaeSoon/werft/actions/runs/42520748529) / [42520748403](https://github.com/JeongJaeSoon/werft/actions/runs/42520748403) | 91.75 | 17.00 | 108.75 |
| [42520740191](https://github.com/JeongJaeSoon/werft/actions/runs/42520740191) / [42520740208](https://github.com/JeongJaeSoon/werft/actions/runs/42520740208) | 93.78 | 18.08 | 111.87 |

중앙값은 CI **25 job·93.78 runner분·큐 p50 17.32분·전체 55.18분**, Images **8 job·18.08 runner분·큐 p50 5.78분·전체 25.60분**이다. 각 PR의 두 workflow 사용량을 합친 중앙값은 **111.87 runner분**이다. 제거한 unit 4개의 기존 점유 중앙값은 **20.25 runner분**, arm64 이미지 3개는 **9.68 runner분**이다. 이는 이전 실행의 점유이며 변경 후 절감 실측을 대신하지 않는다.

runner분은 skip이 아닌 job의 `completed_at - started_at` 합이다. 큐는 각 job의 `started_at - created_at`이며 의존성 대기를 섞지 않는다. 전체 시간은 run 생성부터 마지막 실행 job 종료까지다. p50은 중앙값, p95는 정렬 후 `ceil(n × 0.95)`번째 값이다. 표본별 수치를 계산한 뒤 세 표본의 중앙값을 비교한다. 공개 저장소의 무료 시간을 금액 절감으로 바꾸지 않는다.

변경 후에도 job 수뿐 아니라 integration의 실제 파일·테스트 수와 선언된 skip 검증, 이미지 smoke·취약점 판정, E2E·실행 가이드·접근성 출력을 확인한다. 테스트 대상 증가와 runner·계정 부하, 캐시 hit 여부도 함께 기록한다. 첫 PR의 Next.js 캐시는 main에 아직 저장되지 않아 miss일 수 있으므로 캐시 효과를 미리 주장하지 않는다. 단일 변경 후 표본의 wall time 차이를 동시성 한도나 캐시만의 인과 효과로 단정하지 않는다.

### 1차 정상 완주 실측

최적화 후 `e5070ddd0`에서 CI·Images가 같은 head로 모두 성공했다. [CI 실행](https://github.com/JeongJaeSoon/werft/actions/runs/42533329607), [Images 실행](https://github.com/JeongJaeSoon/werft/actions/runs/42533329609)의 실제 job 시간을 사용했다. 아래 수치는 제품 검증을 필수 `check`에 추가 연결하기 전의 정상 완주 표본이다. 최종 집계 강화 커밋의 확인 결과는 검토용 PR 본문과 실행 로그에 추가 기록한다.

| workflow | 실행 job 전 → 후 | runner분 전 → 후 | job 큐 p50 전 → 후 | 전체 소요 전 → 후 |
| --- | ---: | ---: | ---: | ---: |
| CI | 25 → 21 | 93.78 → 72.85 | 17.32 → 6.30분 | 55.18 → 23.47분 |
| Images | 8 → 6 | 18.08 → 7.30 | 5.78 → 4.89분 | 25.60 → 13.60분 |

일곱 integration 도메인의 실제 JUnit 검증 출력에서 **799개 파일·12,799개 사례·선언된 skip 32개**를 확인했다. 도메인별 파일 수 합계가 전체 catalog 799개와 일치하여 unit 샤드를 제거해도 테스트 파일이 빠지지 않았음을 확인했다.

두 workflow 합계는 **33 → 27 job**, **111.87 → 80.15 runner분(28.35% 감소)**이다. 소요시간·큐 개선에는 당시 공유 부하와 캐시 상태도 섞여 있으므로 전부 코드의 인과 효과로 단정하지 않는다. main에 아직 배포하지 않아 전체 계정 대기열 개선이 확정됐다는 의미도 아니다.

앞선 실행에서 권한 fixture가 담당 팀 lead를 기본으로 제공해 읽기 전용 테스트 한 개가 실패했다. 단일 파일로 재현하고 명시적인 팀 member 역할로 수정했으며, 기존 버튼·입력 비활성 검증과 쓰기 요청 0건 검증을 유지했다. 실패한 실행과 취소 실행은 위 성능 비교에서 제외했다. 이 실패가 `check`와 `integration`의 실제 종료 코드 1로 전파되는 것도 확인했다.

### 로컬 검증

CI와 같은 Bun 1.3.14로 `bun test --timeout 15000 ./tests`를 실행하여 **1257 pass / 97 skip / 0 fail**, 60개 파일·1354개 테스트를 확인했다. skip은 로컬에 서비스·D2 스택을 켜지 않은 테스트이며, CI integration의 서비스 활성화·허용 skip 검증을 대체하지 않는다. GNU `timeout`은 임시 경로에 준비했다. 서비스 정책 테스트 8개와 릴리스 manifest·게시 테스트 28개도 개별 재검사에서 모두 통과했다.

전체 workspace typecheck와 root TypeScript 검사, 라이선스 고지 대조(`251 packages`), actionlint 1.7.12·Bash 구문·diff 공백 검사를 통과했다. lint는 오류 없이 기존 경고 118개를 보고했다. 로컬 전체 검사는 자동 릴리스 경로를 보존한 최종 구성에서 다시 확인했다. GitHub 변경 후 실측은 완료한 실행의 로그와 검토용 PR 본문에 기록한다.

### 리뷰 반영과 최신 main 통합

아래 이전 측정과 위 1차 정상 완주의 수치는 당시 커밋의 기록이다. 최신 main의 Slack unit 분리(`control-slack`)와 다섯 부분, 12분 timeout을 유지했다. 일반 제품 계획에서는 이 다섯 부분을 중복 실행하지 않고 수동 `only=check`와 웹 축소 계획에서 사용한다.

집계는 이름 있는 `needs`와 계획을 함께 읽어 Helm·Kubernetes·사이트·제품·quota job마다 예정된 실행은 success, 생략은 skipped인지 검증한다. 계획이 true인데 job이 skipped이거나 결과가 누락되면 실패한다. 별도 Pages workflow로 옮긴 main 사이트 빌드는 `site=false` 계획으로 반영했다. Next 캐시의 main 저장도 `pages.yml`의 docs job으로 옮기고 PR CI는 복원만 한다. 이 후속 변경의 실제 실행 결과는 검토용 PR 코멘트에 기록하며, 과거 절감률을 새 head의 재측정으로 바꾸어 주장하지 않는다.

### 반복된 worker layer 실패의 입력 경로 수정

main `ca6ac15f2`의 성공 실행 42566966027과 PR `f8a6ac61d`의 실행 42567660208 attempt 3을 비교했다. 실패는 worker의 GitHub CLI·Git LFS release archive를 가져오는 원격 `ADD --checksum`에서 발생했다. 양쪽 베이스·frontend pin과 Images의 `images-앱-아키텍처` 캐시 scope는 같다. quickstart·kind 빌드는 해당 Images GHA cache나 공유 artifact를 입력으로 쓰지 않으며 Next 캐시는 docs만 대상으로 한다. 오류의 고정 digest는 92바이트 HTTP 504 HTML 본문의 해시이고, 뒤의 서로 다른 digest는 각 archive의 기대 pin이다.

같은 로컬 builder·베이스 pin·`--no-cache`에서 수정 전 gh stage의 실패를 재현했다. 수정 후에는 기존 `fetch-pinned.ts`가 브라우저 다운로드 경로 실패 뒤 공식 release asset API로 전환해 같은 SHA의 파일만 기록한다. 공개 API의 octet-stream 응답과 redirect를 지원하며 인증정보를 전달하지 않는다. 버전·archive pin·베이스·캐시 scope를 바꾸지 않고 cold gh·git-lfs stage와 실제 native 실행을 검증했다. Helm job은 helm archive 검증을 통과한 다음 kubeconform 다운로드에서 실패한 것이어서 그 입력에도 같은 대체 경로를 적용했다. Images의 Grype 설치도 같은 브라우저 경로에서 반복 실패해 공식 asset API로 전환하고, 두 경로 모두 원래 SHA를 검증한 다음에만 압축을 풀도록 했다. scanner를 설치·실행하지 못하면 기존처럼 error와 실패를 남긴다. 전체 Actions 결과는 PR 코멘트에 기록한다. 이전의 일시 오류 판단 대신 이 재현과 입력 경로 수정을 후속 결론으로 삼는다.

## 2026-11-06 당시 측정


측정 창은 2026-10-29 18:00 UTC 이상, 2026-11-05 18:00 UTC 미만의 168시간이다. workflow run 수는 전수 집계(3,421건), job·시간은 각 workflow의 창 안 최신 성공 실행 최대 3건을 표본으로 삼았다. Forbidden terms는 2건, CI image mirror는 창 안 실행이 2건이다. 취소·실패 실행의 runner 시간을 합산한 주간 사용량은 아니며, 최근 성공 표본이 한 시점의 계정 부하에 치우치는 한계가 있다.

`timing` API의 billable은 모든 표본에서 0이다. 공개 저장소의 무료 job이므로 청구 절감으로 해석하지 않는다. runner 분은 건너뛰지 않은 job의 `(completed_at - started_at) / 60` 합계, 큐 분은 `max(0, started_at - created_at) / 60`이다. 집계 job의 created_at은 선행 job 종료 뒤이므로 이 큐 수치에 의존성 대기는 포함하지 않는다. run elapsed는 timing API의 `run_duration_ms`이다.

| workflow | 7일 run 수 | 표본 수 | run당 전체/실행 job 중앙값 | runner 분 중앙값 | job 큐 분 p50 / p95 | billable 분 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| CI | 1240 | 3 | 28 / 26 | 92.07 | 15.10 / 27.25 | 0 |
| Images | 1245 | 3 | 21 / 7 | 19.15 | 4.40 / 10.72 | 0 |
| D2 gate | 85 | 3 | 2 / 1 | 8.55 | 0.72 / 1.87 | 0 |
| sdk-release | 360 | 3 | 4 / 1 | 1.37 | 7.18 / 13.02 | 0 |
| main push run (정기 감시) | 14 | 3 | 1 / 1 | 5.28 | 0.03 / 0.72 | 0 |
| ui-release | 74 | 3 | 2 / 1 | 1.03 | 1.03 / 1.30 | 0 |
| Forbidden terms | 401 | 2 | 1 / 1 | 0.43 | 1.65 / 4.62 | 0 |
| CI image mirror | 2 | 2 | 11 / 11 | 4.47 | 0.07 / 3.02 | 0 |

표본 run:

- CI: [42073017680](https://github.com/JeongJaeSoon/werft/actions/runs/42073017680) — 전체 28, 실행 26 job, runner 92.07분, run elapsed 47.87분
- CI: [42072600553](https://github.com/JeongJaeSoon/werft/actions/runs/42072600553) — 전체 28, 실행 26 job, runner 89.95분, run elapsed 43.68분
- CI: [42072555391](https://github.com/JeongJaeSoon/werft/actions/runs/42072555391) — 전체 28, 실행 26 job, runner 93.18분, run elapsed 41.77분
- Images: [42078084146](https://github.com/JeongJaeSoon/werft/actions/runs/42078084146) — 전체 21, 실행 7 job, runner 19.15분, run elapsed 12.57분
- Images: [42077171129](https://github.com/JeongJaeSoon/werft/actions/runs/42077171129) — 전체 21, 실행 7 job, runner 23.45분, run elapsed 20.93분
- Images: [42076817449](https://github.com/JeongJaeSoon/werft/actions/runs/42076817449) — 전체 21, 실행 7 job, runner 16.00분, run elapsed 17.07분
- D2 gate: [42047578375](https://github.com/JeongJaeSoon/werft/actions/runs/42047578375) — 전체 2, 실행 1 job, runner 9.45분, run elapsed 10.20분
- D2 gate: [42037065731](https://github.com/JeongJaeSoon/werft/actions/runs/42037065731) — 전체 2, 실행 1 job, runner 8.48분, run elapsed 8.55분
- D2 gate: [42029901304](https://github.com/JeongJaeSoon/werft/actions/runs/42029901304) — 전체 2, 실행 1 job, runner 8.55분, run elapsed 11.82분
- sdk-release: [42078150233](https://github.com/JeongJaeSoon/werft/actions/runs/42078150233) — 전체 4, 실행 1 job, runner 1.37분, run elapsed 8.57분
- sdk-release: [42078084278](https://github.com/JeongJaeSoon/werft/actions/runs/42078084278) — 전체 4, 실행 1 job, runner 1.47분, run elapsed 5.42분
- sdk-release: [42072600556](https://github.com/JeongJaeSoon/werft/actions/runs/42072600556) — 전체 4, 실행 1 job, runner 1.28분, run elapsed 14.33분
- main push run: [41623783452](https://github.com/JeongJaeSoon/werft/actions/runs/41623783452) — 전체 1, 실행 1 job, runner 6.30분, run elapsed 6.35분
- main push run: [41436383771](https://github.com/JeongJaeSoon/werft/actions/runs/41436383771) — 전체 1, 실행 1 job, runner 5.28분, run elapsed 6.02분
- main push run: [41343241645](https://github.com/JeongJaeSoon/werft/actions/runs/41343241645) — 전체 1, 실행 1 job, runner 1.62분, run elapsed 1.68분
- ui-release: [42012550594](https://github.com/JeongJaeSoon/werft/actions/runs/42012550594) — 전체 2, 실행 1 job, runner 1.10분, run elapsed 2.40분
- ui-release: [42006230120](https://github.com/JeongJaeSoon/werft/actions/runs/42006230120) — 전체 2, 실행 1 job, runner 0.85분, run elapsed 1.68분
- ui-release: [42002260169](https://github.com/JeongJaeSoon/werft/actions/runs/42002260169) — 전체 2, 실행 1 job, runner 1.03분, run elapsed 2.10분
- Forbidden terms: [42079829149](https://github.com/JeongJaeSoon/werft/actions/runs/42079829149) — 전체 1, 실행 1 job, runner 0.38분, run elapsed 2.05분
- Forbidden terms: [42079388639](https://github.com/JeongJaeSoon/werft/actions/runs/42079388639) — 전체 1, 실행 1 job, runner 0.47분, run elapsed 5.18분
- CI image mirror: [41938409203](https://github.com/JeongJaeSoon/werft/actions/runs/41938409203) — 전체 11, 실행 11 job, runner 6.73분, run elapsed 4.32분
- CI image mirror: [41767111207](https://github.com/JeongJaeSoon/werft/actions/runs/41767111207) — 전체 11, 실행 11 job, runner 2.22분, run elapsed 0.50분

## 선택한 변경

CI의 lint·라이선스 검사를 typecheck runner에 합친다. 표본 세 건에서 이 두 runner는 각각 합계 50·53·51초를 사용했고, 직접 확인한 run 42072555391의 검사 자체는 lint 4초·라이선스 0초였다. 네 unit 부분과 integration 도메인은 계속 병렬로 돈다. 새 required context는 만들지 않는다. branch protection API가 반환한 `check`, `integration`, `e2e`, `quickstart`, `supply-chain`은 그대로다.

PR concurrency와 Bun 캐시는 이미 적용돼 있어 반복 추가하지 않는다. main push의 run별 concurrency 분리, 수동 `only=check`, `allow_parallel`, Images·release·publish·배포 job은 유지한다. `check (typecheck)`·`check (lint)`·`check (licenses)`를 필수 체크가 아닌 `check (static)` job으로 모은다. 세 검사는 독립 step으로 남아 로그에서 원인을 구분한다.

문서 전용 감지는 [CI 경로 계획](ci-path-plan.md)에서 quickstart·API 가이드의 실행 검증, 사이트 조립, supply-chain을 함께 판단한다. draft의 무거운 job 생략은 적용하지 않는다.

## 재현

다음 읽기 전용 조회로 표를 다시 계산할 수 있다. GitHub의 created 필터 검색은 최대 1,000건이므로 날짜별로 조회하고, 11월 5일은 반일 두 구간으로 나눈 뒤 `created_at`이 위 측정 창 안인 run만 중복 id 없이 센다. 해당 날짜가 502를 반환한 조회는 네트워크 오류가 사라진 뒤 다시 읽었다.

```sh
gh api --paginate 'repos/JeongJaeSoon/werft/actions/runs?created=2026-11-04&per_page=100'
gh api --paginate 'repos/JeongJaeSoon/werft/actions/runs?created=2026-11-05T00:00:00Z..2026-11-05T11:59:59Z&per_page=100'
gh api --paginate 'repos/JeongJaeSoon/werft/actions/runs?created=2026-11-05T12:00:00Z..2026-11-05T23:59:59Z&per_page=100'
gh api --paginate 'repos/JeongJaeSoon/werft/actions/runs/42072555391/jobs?per_page=100'
gh api repos/JeongJaeSoon/werft/actions/runs/42072555391/timing
gh api repos/JeongJaeSoon/werft/branches/main/protection
```

## CI job별 변경 전 표본

위 CI 성공 실행 세 건에서 같은 job 이름을 묶었다. skipped job은 runner·큐 0으로 기록하며, 모든 job의 billable은 timing API에서 0이다.

| job | 표본 수 | runner 초 중앙값 | 큐 분 중앙값 | billable 분 |
| --- | ---: | ---: | ---: | ---: |
| storybook | 3 | 184 | 14.18 | 0 |
| integration (db) | 3 | 587 | 20.08 | 0 |
| helm-chart | 3 | 22 | 14.18 | 0 |
| docs | 3 | 136 | 12.23 | 0 |
| ui-pack | 3 | 53 | 12.68 | 0 |
| demo | 3 | 32 | 14.17 | 0 |
| integration (surface) | 3 | 603 | 14.52 | 0 |
| k8s-smoke | 3 | 436 | 17.82 | 0 |
| check (unit: packages) | 3 | 140 | 15.22 | 0 |
| e2e | 3 | 445 | 20.78 | 0 |
| integration (storage) | 3 | 111 | 18.65 | 0 |
| integration (docker) | 3 | 164 | 16.58 | 0 |
| integration (api) | 3 | 373 | 12.38 | 0 |
| quickstart | 3 | 458 | 19.85 | 0 |
| check (unit: worker, web) | 3 | 281 | 19.63 | 0 |
| integration (worker) | 3 | 246 | 23.32 | 0 |
| check (lint) | 3 | 28 | 14.37 | 0 |
| integration (egress) | 3 | 127 | 17.07 | 0 |
| check (typecheck) | 3 | 160 | 18.77 | 0 |
| check (unit: db) | 3 | 335 | 20.38 | 0 |
| check (unit: other apps, tests) | 3 | 460 | 22.18 | 0 |
| check (licenses) | 3 | 22 | 27.25 | 0 |
| pages | 3 | 18 | 11.03 | 0 |
| integration | 3 | 3 | 5.72 | 0 |
| storybook-pages | 3 | 0 | 0.00 | 0 |
| check | 3 | 3 | 7.60 | 0 |
| workspace-quota | 3 | 112 | 2.38 | 0 |
| agent-sdk-compat | 3 | 0 | 0.00 | 0 |

검증 상태와 변경 후 CI run의 전후 비교는 이 변경을 제출한 PR 본문·검증 기록에 남긴다. 다른 PR이나 과거 main run은 취소·재실행하지 않는다.


