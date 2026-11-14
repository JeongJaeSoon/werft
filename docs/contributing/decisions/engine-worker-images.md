# 결정(설계): 한 배포에서 세션의 엔진에 맞는 worker 이미지를 고른다

- 상태: 2026-11-15에 정했다. 구현 단위 1(아래)을 이 문서와 함께 구현했다. 두 엔진 설정을 운영에 쓰는 것은 단위 3(업그레이드 검사)까지 들어간 뒤다.
- 결정한 사람: 작업자 설계이고 Codex 설계 반론을 두 번 거쳤다(1회차 OBJECT 1·AMEND 10·AGREE 4, 2회차 REQUEST_CHANGES: nullable kind, `checkpointRevision` 유지, 세션 지정·partition claim 거부 분리, `versionUnknownHere` 쌍 판정, 단위 1의 동작 범위). 두 지적 모두 이 판에 반영했다. Helm 기본값(열린 점 1)은 오케스트레이터가 정했고 오너가 나중에 검토한다.
- 전제: `WORKER_IMAGES` 목록과 목록을 판단하는 업그레이드 검사(main에 있음), Helm `images.workers`(이미지 목록 작업, 리뷰 중). 그 작업과 합의한 것: 엔진은 `runtime.engine`, 지원 창은 엔진마다 2개(현재 + 직전), 슬롯은 `EXECUTION_SLOT_LIMIT` 하나를 나눠 쓴다.

## 문제

worker 이미지 하나는 엔진 하나만 돌린다(`apps/worker/src/composition.ts`의 `installed.require`). 그런데 scheduler는 새 세션을 언제나 목록의 첫 이미지로 띄운다(`selectWorkerImage`: 포인터가 `recorded`가 아니면 `images[0]`). `workerImageListFromEnv`는 엔진이 둘 이상인 목록을 거부한다. 그래서 한 배포에서 Claude 에이전트와 Codex 에이전트를 같이 돌릴 수 없다.

## 코드에서 확인한 전제

- scheduler가 보는 세션에는 spec이 없을 수 있다. `sessions_pin_required` trigger는 `agent_release_id`가 null인 행을 통과시키고(`0270_remove_profiles.sql`), scheduler의 `awaitingLaunch`는 pin을 보지 않는다. claim은 그런 세션을 받지 않는다. 그래서 spec·kind가 없거나 모르는 kind인 세션은 첫 이미지로 짐작하지 않고 건너뛴다(API의 사유는 지금처럼 "This session has no spec to run").
- 세션의 `runtime.kind`는 만든 뒤 바뀌지 않는다(애플리케이션 쓰기 경로 기준. DB 제약은 아니다). pin은 만들 때 release에서 복사되고, claim의 모델 이동은 spec의 모델만 바꾼다(`worker-unit-of-work.ts`의 successor 이동). 고르기와 예약 사이에 세션의 엔진이 바뀌는 경로는 없다.
- scheduler는 catalog를 보지 않는다. demand(`inspectDemand`)는 세션 ID만 돌려준다. 이미지가 그 런타임을 싣지 않는 세션도 지금은 `images[0]`로 띄우고, claim SQL(`runnableCondition`)이 그 세션을 거른다. API는 그 세션에 catalog 불일치 사유("which the worker images no longer ship")를 보여 준다.
- `holdIncompatibleBeforeLaunch`는 restore point가 없는 세션에 `stale`을 돌려준다(`restore-failures.ts`). checkpoint가 없는 세션을 멈추는 데는 쓸 수 없다.
- `runtime_versions.current`는 catalog-config가 쓰기만 하고 읽는 곳이 없다. 새 release의 버전은 이미지가 아니라 codec descriptor에서 온다(`installedRuntimeVersions`).

## 정하는 것

| 항목 | 정한 것 |
|---|---|
| 목록 검증 | 엔진마다 최대 2개. `released_at` 엄격 내림차순은 **엔진 안에서만** 건다. 두 엔진을 같은 릴리스로 낼 때 같은 시각을 쓸 수 있다. 엔진 하나에 셋 이상이면 지금처럼 거부한다. 단일 env(`WORKER_IMAGE` 네 개)와 목록을 같이 주면 지금처럼 거부한다 |
| 세션의 엔진 | spec의 `runtime.kind`를 descriptor의 `checkpointEngine`으로 바꾼 것. 대응표는 control-host 조립부가 넘긴다(platform은 adapter를 import하지 않는다). 표에 없는 kind의 세션은 고를 이미지가 없다(아래 "이미지 없음") |
| scheduler가 읽는 것 | 포인터 조회(`readPointerImageRuntime`)가 세션의 `runtime_spec -> runtime -> kind`를 같은 문장에서 함께 읽는다. 새 조회 계약은 `{ pointer, checkpointRevision, kind }`(kind는 null 가능). `checkpointRevision`은 지금처럼 hold가 잠금 아래에서 비교한다 |
| 고르기 | 후보는 세션 엔진의 이미지(목록 순서). `recorded` 포인터: 후보 가운데 `canRestoreCheckpoint`가 맞는 첫 이미지, 없으면 지금처럼 `incompatible_checkpoint`로 멈춘다. checkpoint 엔진이 세션 엔진과 다르면(손상) 후보 가운데 맞는 것이 없어 같은 멈춤이 된다. 포인터 없음·`unrecorded`: 후보의 첫 이미지 |
| 이미지 없음(checkpoint 없음) | 후보가 없으면 띄우지 않고 슬롯도 쓰지 않는다. 거절 이미지와 같이 건너뛰고 다음 페이지를 읽는다. 새 멈춤 상태·attention 코드는 두지 않는다. 세션은 지금의 catalog 불일치("worker images no longer ship")로 보이고, claim도 그 세션을 받지 않는다. 대기 입력과 receipt는 그대로 남는다. 돌아온 이미지가 세션의 `(kind, version)`을 싣고 세션의 연결·모델이 catalog에 남아 있으면 다시 뜬다. checkpoint가 있으면 위 "고르기"대로 멈춘다 |
| 런타임 허용 목록 | `runtime_versions.accepted`를 `(kind, version)` 쌍 목록으로 바꾼다. 이미지마다, `checkpointEngine`이 그 이미지 엔진인 kind에만 그 이미지의 SDK·CLI 버전(같은 kind 안의 동등 tool catalog 버전 포함)을 붙인다. `current`는 없앤다. 바꾸는 곳: `runtimeVersionAccepted`(catalog), session-service의 `catalogAllows`·`mismatchReason`·만들기 판정, `ClaimCatalog`, claim의 `runsHere`와 `runnableCondition` SQL(`(kind, version) IN (…)`), catalog-config의 동등 버전 확장 |
| claim의 엔진 검증 | 허용 쌍마다 그 쌍을 싣는 이미지의 엔진을 붙인다. claim 트랜잭션은 worker가 보고한 엔진(`image_runtime.engine`), 보고가 없으면(옛 worker) launch에 저장된 엔진으로 허용 쌍을 좁힌 뒤 후보 SQL·`runsHere`·잠금 뒤 재확인·catalog 불일치 판정에 같은 쌍을 쓴다. 세션을 정한 launch(`worker_launches.session_id`)의 세션이 다른 엔진이면 `no_session`이고, 그 launch를 다른 세션에 쓰지 않는다. 둘 다 없으면(runtime 없이 예약된 launch에 옛 worker) 좁히지 않는다. 엔진 하나인 배포만 그렇게 예약하므로 거기서는 같다. worker의 `installed.require`는 마지막 방어선으로 남는다 |
| 슬롯 | `EXECUTION_SLOT_LIMIT` 하나. 대기열은 `signaledAt` FIFO 하나. 엔진별 상한 없음 |
| 이미지 pin 실패 | 지금처럼 한 이미지라도 pin하지 못하면 그 pass는 아무것도 띄우지 않는다. 두 엔진 목록에서는 쓰지 않는 엔진의 이미지 해석 실패도 다른 엔진을 막는다. 문서에 적는다 |
| 거절 목록 | (이미지, runtime) 쌍 그대로. 한 엔진의 이미지가 거절돼도 그 세션만 건너뛰고, 뒤 페이지의 다른 엔진 세션은 뜬다. 최신 이미지가 거절됐을 때 직전 이미지로 넘어가지 않는 것도 그대로다 |
| quota helper | 목록의 첫 원소. 두 엔진의 이미지 모두 `xfsprogs`를 싣는다(`apps/worker/Dockerfile`) |
| 설정을 읽는 role | scheduler·API·Slack·일회성 database catalog 명령이 모두 같은 parser로 같은 목록을 읽는다. compose·Helm은 세 role에 같은 값을 준다 |
| 업그레이드 검사 | 엔진마다 판정한다(오케스트레이터 결정 (a), Codex 반론 AMEND 반영). 대상이 이미지를 하나라도 적은 엔진(철회만 적어도)은 남고, 그 엔진의 배포된 가장 새 이미지는 지금처럼 승인 없이 보호한다. 하나도 적지 않은 엔진은 뺀 것으로 보고 그 보호를 건너뛰는 대신, 닫히지 않은 그 엔진의 세션을 checkpoint가 없어도 `no_engine_image`로 고른다(조회는 미수거 checkpoint 세션과 닫히지 않은 세션의 합). slot을 쥔 launch는 엔진과 상관없이 거부한다. runtime 없이 배포된 이미지가 있으면 엔진을 모르므로 나누지 않는다. 검사와 rollout 사이에 예약된 뺀 엔진의 claim 전 launch는 scheduler가 다시 만들지 않고 돌려보낸다. 승인 규칙은 지금처럼 정확히 같은 목록 |
| Helm | `images.workers` 기본값에 Claude·Codex 이미지를 하나씩 둔다(오케스트레이터 결정). release manifest와 chart baker가 목록용 `released_at`을 낸다. 두 PR로 나눈다(오케스트레이터 결정 C). 첫 PR(v0.3.0 전)은 시각 계약과 목록 upgrade 절차를 넣고 기본값은 단일로 둔다. 둘째 PR(v0.3.0 뒤)이 기본값을 목록으로 뒤집는다. 기존 설치가 목록을 이해하는 릴리스를 한 번 거쳐야 첫 upgrade가 안전하기 때문이다 |
| 목록의 `released_at` | 이미지 소스 커밋의 committer 시각(UTC, 초, `Z`)이다. images.yml의 publish 기록에 한 번 적고 index·promotion·chart·manifest가 그대로 옮긴다. promotion 시각을 쓰지 않는 것은 main chart와 release chart가 같은 digest를 몇 시간 차이로 promote하고, promotion 재실행이 chart 재게시 비교에 걸리기 때문이다(Codex 반론으로 정함). 옛 릴리스의 시각은 manifest의 `commit`에서 같은 값으로 구한다. 게시 순서는 보장하지 않는다. 그래서 목록을 만드는 `files/next-workers.jq`는 배포된 같은 엔진의 어느 이미지보다도 늦지 않은 새 이미지를 거부한다 |
| 목록 upgrade 절차 | `files/next-workers.jq`를 chart에 싣고 문서와 kind가 같은 파일을 돌린다. control phase는 배포된 목록을 그대로 넘긴다. final은 대상 릴리스의 두 이미지(`files/release-images.json`)를 배포된 이미지(목록, 또는 단일 설치의 `images.worker`·`images.workerPrevious`)에 더하고 엔진마다 철회되지 않은 이미지 둘을 남긴다. 같은 digest는 한 번만 남기고 철회 상태를 풀지 않는다. 철회된 이미지는 남긴 것 가운데 가장 오래된 것보다 새로울 때만 남긴다(철회되지 않은 것이 없는 엔진은 모두 남긴다). 빠지는 이미지의 판정은 업그레이드 검사가 한다 |
| compose | 두 엔진 overlay(`infra/compose.two-engines.yml`)는 `WORKER_IMAGES`를 쓰지 않고 단일 env를 쓴다. `WORKER_IMAGE`가 Codex 이미지, `WORKER_IMAGE_PREVIOUS`가 Claude 이미지이고, 두 runtime은 빌드한 이미지에서 images.yml과 같은 명령으로 읽는다(두 이미지 빌드 → runtime 추출 → 스택 시작). `WORKER_IMAGES`는 `repository@sha256:<digest>`만 받는데 compose는 이미지를 로컬에서 빌드해 repository digest가 없기 때문이다. 목록의 digest 규칙은 그대로 둔다. compose 운영 업그레이드(test-ops `upgrade`)는 엔진 하나 그대로이고, previous를 교체되는 이미지로 다시 쓰므로 이 overlay에는 쓰지 않는다 |
| conformance | `tests/e2e/run.sh --conformance two_engines`가 두 엔진 overlay 스택에서 전용 시험(`tests/conformance/two-engines.e2e.ts`) 하나를 돌린다. 엔진 suite의 fixture 선택기는 스택마다 엔진 하나라서 suite를 다시 돌리지 않는다. Claude 세션과 Codex 세션의 turn이 동시에 model 호출에 머문 뒤 각자 끝나고, 세션마다 컨테이너의 Docker image id, launch에 pin된 이미지·엔진(claim이 그것에 묶인다), 첫 checkpoint에 적힌 엔진, 세션 kind가 맞는지 본다. 혼합 라우팅을 보이는 시험이고 `WORKER_IMAGES` 배포 경로 자체는 보지 않는다 |

## 버전 조합과 배포 순서

- 새 control-host + 엔진 하나 목록 또는 단일 env: 지금과 같다. 단, 새 control-host의 descriptor가 pin하는 버전을 worker 이미지가 싣지 않으면 세션 만들기가 거절되는 것은 지금과 같다.
- 두 엔진 목록 + 옛 control-host: 옛 parser가 목록을 거부해 기동하지 않는다(fail closed). 두 엔진 목록은 scheduler·API·Slack이 모두 새 버전이 된 뒤에 준다. 되돌릴 때는 먼저 목록을 엔진 하나로 줄인 뒤 control-host를 되돌린다.
- **단일 env의 의미가 하나 바뀐다.** 엔진 바꾸기 설정(current = Codex, previous = Claude)에서 checkpoint 없는 Claude 세션은 지금 Codex 이미지로 떠서 claim되지 못한다. 이제는 previous(Claude) 이미지로 뜬다. 고치는 변경으로 보고 PR의 동작 변경에 적는다.
- worker 이미지는 바뀌지 않는다.

## 열린 점

1. (정함, 2026-11-15 오케스트레이터 결정) Helm 기본 `images.workers`에 두 엔진. 셀프호스팅 문서에 "쓰지 않는 엔진은 목록에서 빼도 된다", 업그레이드 검사가 두 이미지를 다 본다는 것, pin 실패가 두 엔진을 함께 막는다는 것을 적는다.
2. (정함) checkpoint 없는 세션이 자기 엔진의 이미지를 못 찾을 때: 멈추지 않는다. 지금의 catalog 불일치로 다룬다(위 표). 이미지 목록 작업이 들일 `runtime_retired`와는 겹치지 않는다. 그쪽은 checkpoint의 런타임이 물러난 경우다.
3. (정함) 연결을 다른 엔진으로 바꾼 에이전트의 기존 세션은 release가 고정한 엔진으로 이어 간다. 그 엔진의 이미지가 목록에 있고, 세션의 연결과 모델이 catalog에 남아 있는 동안만이다(claim이 둘 다 본다). 문서에 적는다.

## Slack·콘솔

- Slack: 세션 만들기 거절은 지금처럼 `422 UNSUPPORTED_CAPABILITY`의 일반 안내다. 문구에 엔진 이름을 넣는다. 새 `reason_code`는 두지 않는다. 지금 "런타임이 이미지에 없음"도 같은 일반 안내다.
- 콘솔: 새 attention 코드가 없으므로 계약 변경은 없다. catalog 불일치 문구가 `(kind, version)` 판정을 따른다.

## 구현 단위

1. **허용 목록을 (kind, version) 쌍으로**(platform·db·control-host): catalog, session-service, `ClaimCatalog`, `runsHere`·`versionUnknownHere`·SQL, catalog-config, `current` 제거. **동작 변경 하나**: 이미지 엔진의 kind가 아닌 세션은 버전 문자열이 같아도 받지 않는다. 그런 세션은 지금도 그 이미지에서 돌지 못한다(worker의 `installed.require`). 시험: 같은 버전 문자열의 다른 kind 거부(만들기·불일치 사유·claim), SQL과 `runsHere`가 같은 답, 엔진 바꾸기 단일 env가 두 kind를 다 받는다.
2. **scheduler가 세션 엔진으로 고르기**: 목록 검증(엔진마다 철회되지 않은 항목 2개, 엔진 안 순서. 철회 작업과 맞춘다), 포인터 조회에 kind, 후보 필터, 이미지 없음 건너뛰기, claim의 엔진 검증. 시험: 2+2 허용, 엔진별 셋째 거부, 목록 순서별 고르기, checkpoint/spec 엔진 충돌, spec 없음·모르는 kind, 한 엔진 거절 뒤 다음 페이지의 다른 엔진, 엔진 바꾸기 단일 env, 세션 지정 launch의 엔진 불일치 `no_session`, partition claim의 엔진 필터, 낡은 `checkpointRevision`의 hold `stale`, 이미지가 돌아온 뒤 다시 뜸.
3. **업그레이드 검사**: 엔진마다 판정하고, 엔진 이미지가 없는 세션을 영향 세션으로. 이미지 목록 작업의 검사 위에. 다음 릴리스(v0.3.0. 처음에는 v0.2.1로 잡았다가 호환이 깨지는 변경 때문에 minor로 정했다) 전에 들어가야 한다.
4. **compose overlay와 두 엔진 conformance**: 위 표의 compose·conformance 행. 설계 반론(Codex AMEND)의 지적을 반영했다. runtime 추출 명령은 images.yml 그대로(`jq -c 'del(.profiles)'`까지)이고, 두 엔진 overlay에는 test-ops `upgrade`를 쓰지 않으며, 한 엔진의 유일한 이미지를 바꾸는 upgrade는 승인만으로 통과하지 않는다.
5. **Helm 기본값·release manifest·render-check·문서**(설정 레퍼런스, 복구·업그레이드 문서, `compose.codex-worker.yml` 설명, ko·en·ja). 첫 PR: 위 표의 `released_at`·목록 upgrade 절차 행, render-check의 package 위 목록 render, kind의 단일 → 목록 → 다음 목록. 둘째 PR(v0.3.0 뒤): 기본값 뒤집기와 CHANGELOG "운영자가 할 일"의 단일 → 목록 전환.
