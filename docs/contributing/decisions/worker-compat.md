# 결정(설계): 새 control-host와 지원 창 안 옛 worker의 호환 계약

- 상태: **제안.** 오너 방향(2026-11-13): "1090　을 그냥 이번에 진행해도 좋을거 같은데 어때?"
- 기준 커밋: `origin/main` `4fd9d19e7`. `파일:줄`은 모두 이 커밋 기준이다.
- 티켓: 94S-1090. 앞선 결정: 94S-1550 결정 (나)(프로필 제거 릴리스만 control-host와 worker를 함께 올린다).

## 무엇을 골랐나

1. **지원 창은 N=1이다.** 새 control-host는 현재 worker 이미지와 직전 릴리스의 worker 이미지 하나(`images.workerPrevious`, `WORKER_IMAGE_PREVIOUS`)와 함께 돈다. 허용 목록(94S-1089)이 들어오면 N은 그 설정값을 따른다. 매트릭스는 N을 한 곳(워크플로의 `SUPPORT_WINDOW`)에서 읽는다.
2. **지원 창의 하한은 프로필 제거 커밋 `ef3627954`(#1567)이다.** 이 커밋을 포함하지 않는 릴리스(`v0.1.3`까지)의 worker는 94S-1550 결정 (나)로 지원 창 밖이다. 지금 게시된 릴리스는 모두 하한 앞이라, 매트릭스는 첫 대상 릴리스가 나올 때까지 이유를 출력하고 건너뛴다.
3. **규칙은 하나다: 받는 쪽이 먼저 넓히고(expand), 보내는 쪽은 그 받는 쪽이 지원 창의 가장 옛 이미지가 된 뒤에 좁힌다(contract).** 요청(worker → control-host)과 응답(control-host → worker), DB 열·테이블에 같은 규칙을 쓴다(2절).
4. **싼 검사는 schema 비교, 비싼 검사는 실제 이미지다.** PR마다 도는 계약 시험은 직전 지원 릴리스의 worker protocol을 JSON Schema로 저장소에 고정하고 지금 schema와 두 방향으로 비교한다(3절). 릴리스 태그에서는 새 control-host와 직전 N개 릴리스의 실제 worker 이미지로 turn 1 완료와 재개를 확인하고, 실패하면 승격을 막는다(4절).
5. **DB의 열·테이블 삭제와 이름 바꾸기는 검사기로 막는다.** 지울 열을 마지막으로 쓴 릴리스를 migration에 적어야 하고, 그 릴리스가 가장 최근 릴리스면 거절한다(5절).

## 1. 지금 상태

| 항목 | 지금 | 근거 |
|---|---|---|
| worker protocol 경로 | `POST /internal/worker/*` 15개와 확장 번들 `GET` 1개 | `apps/control-host/src/api/routes/workers/worker.ts:111-236` |
| 요청 검사 | control-host가 `parseJsonBody(context, request)`로 읽는다. 요청 schema 대부분이 `.strict()`라 모르는 칸이 있으면 400 | `worker.ts:93`, `packages/contracts/src/worker-protocol/index.ts` |
| 응답 검사 | control-host가 `jsonWithSchema(context, response, result)`로 응답 schema를 통과시켜 보낸다. worker는 같은 응답 schema로 본문을 읽고, 맞지 않으면 재시도하지 않는 오류로 끝난다 | `worker.ts:106`, `apps/worker/src/gateway-client.ts:114-234` |
| 응답 안의 strict 객체 | bootstrap-claim 응답 54곳(`runtime_config`, `telemetry` 등), next-input 1곳, pending-control 4곳, protected-commits 1곳 | `z.toJSONSchema(schema, { io: "input" })`의 `additionalProperties: false` 개수 |
| 오류 본문 | worker가 `apiErrorResponseSchema`로 읽는다. 읽지 못하면 status만 남긴다 | `gateway-client.ts:390` |
| 호환 확인 | 업그레이드 문서의 사전 확인은 "API의 worker 요청 400 부재"다. 94S-1550은 API가 200을 주고 worker가 본문을 거절해서 이 확인으로 보이지 않았다 | 94S-1550 |
| DB migration 검사 | `packages/db/src/migration-safety.ts`가 0200 이후 migration의 잠금·재작성 위험을 거절한다. 열·테이블 삭제는 보지 않는다 | `migration-safety.ts:51,78-240` |

응답 안에 strict 객체가 있으므로, 응답에 칸을 **더하는 것**도 옛 worker를 멈출 수 있다. 예: `runtime_config`에 새 칸을 넣으면 그 칸을 모르는 worker는 bootstrap-claim 응답 전체를 거절한다.

## 2. expand → contract 규칙

"옛 쪽"은 지원 창 안의 가장 옛 이미지다. 새 control-host의 상대는 옛 worker이고, rolling update 동안의 새 schema의 상대는 옛 control-host다.

| 바꾸는 것 | 먼저(expand) | 나중(contract) |
|---|---|---|
| 요청에 칸 추가 | control-host가 그 칸을 선택(`optional`·`default`)으로 받는다 | worker가 보낸다. control-host가 그 칸을 필수로 바꾸는 것은 그 칸을 보내지 않는 worker가 지원 창을 벗어난 뒤다 |
| 요청에서 칸 제거 | worker가 보내지 않는다 | 보내던 worker가 지원 창을 벗어난 뒤 control-host의 strict schema에서 뺀다 |
| 응답에서 칸 제거·필수를 선택으로 | worker가 그 칸 없이도 읽는다 | 그 worker가 지원 창의 가장 옛 이미지가 된 뒤 control-host가 보내지 않는다(94S-1550이 어긴 것) |
| 응답의 strict 객체에 칸 추가, enum 값 추가, union 가지 추가 | worker가 그 칸·값을 읽는다(또는 모르는 값을 견딘다) | 그 worker가 지원 창의 가장 옛 이미지가 된 뒤 control-host가 보낸다 |
| 응답의 strict가 아닌 객체에 칸 추가 | 없음. 옛 worker는 모르는 칸을 버린다 | 바로 보낸다 |
| 경로 제거 | worker가 부르지 않는다 | 부르던 worker가 지원 창을 벗어난 뒤 control-host가 뺀다 |
| 값의 범위(길이, 최솟값, 형식) | 받는 쪽이 넓힌다 | 받는 쪽이 지원 창 전체에서 넓어진 뒤 보내는 쪽이 새 범위를 쓴다 |
| DB 열·테이블 | 더한다(null 허용·기본값) | 그 열을 쓰는 control-host·worker 코드가 지원 창을 벗어난 다음 릴리스에서 지운다 |

새 worker가 옛 control-host를 만나는 경우(롤백)는 이 규칙의 범위 밖이다. 지금처럼 control-host를 먼저 올린다(업그레이드 문서의 순서). 기존 `IsolationContractError`가 막는 경우도 그대로다.

이 표는 업그레이드 문서의 "worker protocol 필드를 걷어내는 순서"·"DB 스키마를 바꾸는 순서" 절이 이미 적은 것을 응답 방향과 strict 객체까지 넓힌 것이다. 운영자 문서는 그 두 절을 그대로 두고, 기여자 규칙은 이 문서가 기준이다.

## 3. 계약 시험(PR마다)

### 3.1 무엇을 고정하나

`packages/contracts/src/worker-protocol/compat/baseline.json` 하나에 직전 지원 릴리스의 worker protocol을 담는다.

- 경로마다 `request`와 `response`, 모든 경로에 공통인 `error`(`apiErrorResponseSchema`).
- 값은 `z.toJSONSchema(schema, { io: "input" })`다. 옛 worker가 보내는 요청의 모양과, 옛 worker가 응답을 읽을 때 받아들이는 모양이 둘 다 그 worker의 schema **입력** 쪽이기 때문이다.
- 머리에 `{ release, commit }`을 적는다. 지원 창 안의 릴리스가 아직 없으므로 처음 값은 `{ release: null, commit: "<이 PR의 main 기준 커밋>" }`이다. 이것은 다음 릴리스의 worker가 될 코드의 protocol이다.
- 경로 표를 계약 패키지로 옮긴다: `WORKER_PROTOCOL_ROUTES = { "/bootstrap-claim": { request, response }, … }`. `worker.ts`의 `call()`은 이 표에서 schema를 꺼낸다. 그래서 표에 없는 경로는 등록할 수 없고, 고정본과 실제 경로가 어긋나지 않는다.

고정본은 `bun scripts/worker-protocol-baseline.ts`가 만든다. 사람이 손으로 고치지 않는다.

### 3.2 무엇을 비교하나

현재 schema도 같은 방식으로 JSON Schema로 바꾼 뒤, "왼쪽이 받아들이는 값은 모두 오른쪽도 받아들인다"(왼쪽 ⊆ 오른쪽)를 구조로 확인한다.

| 방향 | 왼쪽(보내는 쪽) | 오른쪽(받는 쪽) | 잡는 것 |
|---|---|---|---|
| 응답 | 현재 응답 schema의 **출력**(`io: "output"`, control-host가 보내는 모양) | 고정본 응답(옛 worker가 읽는 모양) | 필수 칸 제거(94S-1550), strict 객체에 칸 추가, enum 값 추가, 범위 확장 |
| 요청 | 고정본 요청(옛 worker가 보내는 모양) | 현재 요청 schema의 입력(control-host가 받는 모양) | 새 필수 칸, strict schema에서 칸 제거, 범위 축소 |
| 오류 | 현재 오류 schema의 출력 | 고정본 오류 | 오류 본문 모양 변경 |
| 경로 | 고정본의 경로 | 현재 경로 표 | 경로 제거 |

비교기(`schema-subset.ts`)는 zod가 내보내는 키워드만 안다: `type`, `properties`, `required`, `additionalProperties`, `propertyNames`, `enum`, `const`, `anyOf`, `oneOf`, `items`, `minItems`·`maxItems`, `minLength`·`maxLength`, `minimum`·`maximum`·`exclusiveMinimum`, `pattern`, `format`. 모르는 키워드가 오른쪽에 있으면 양쪽 값이 같을 때만 통과한다. 그래서 비교기가 모르는 변화는 통과가 아니라 실패로 드러난다. `pattern`과 `format`도 글자가 같아야 통과한다(정규식의 포함 관계는 판정하지 않는다).

보내는 쪽 객체의 `additionalProperties`는 보지 않는다. 보내는 쪽은 타입이 정한 칸만 보낸다.

### 3.3 일부러 보지 않는 것

- `refine`·`superRefine`의 조건. JSON Schema로 나오지 않는다. 실제 이미지 매트릭스(4절)가 덮는다.
- 확장 번들 `GET`의 바이너리 본문, heartbeat 간격 같은 동작 상수, checkpoint manifest. manifest는 업그레이드 문서의 "읽는 쪽이 먼저" 규칙을 따르고 별도 시험(`checkpoint-pins`)이 있다.
- 롤백(새 worker × 옛 control-host).

### 3.4 고정본을 바꾸는 때

- 릴리스 태그를 찍으면 그 릴리스가 다음 main의 직전 지원 릴리스가 된다. 그때 고정본을 그 태그의 protocol로 바꾼다(`bun scripts/worker-protocol-baseline.ts --ref vX.Y.Z`가 그 태그를 임시 worktree에 꺼내 만든다).
- 계약 시험이 실패했을 때 고정본을 다시 만들어 통과시키지 않는다. 고정본의 `release`·`commit`이 바뀌는 diff는 위의 경우에만 나온다.
- 릴리스 workflow의 호환 job(4절)이 "고정본의 `release`가 직전 지원 릴리스와 같다"를 확인한다. 다르면 그 릴리스를 막는다. **이것은 릴리스 절차에 단계 하나(태그 뒤 고정본 갱신 PR)를 더한다.** 오케스트레이터 확인 대상이다(6절).

### 3.5 실패를 보이는 방법

PR 1에 94S-1550과 같은 변경(bootstrap-claim 응답의 필수 칸 하나 제거)을 넣은 실험 커밋과 그 시험 출력, 되돌린 커밋을 남긴다.

## 4. 실제 이미지 매트릭스(릴리스 gate)

### 4.1 구조

새 workflow `worker-compat.yml` 하나. `workflow_call`(릴리스), `workflow_dispatch`, `pull_request`(경로 한정), `schedule`(매일 1회)로 돈다.

1. `plan`(1분 이하): GitHub Release 목록에서 지금 ref 앞의 릴리스를 최신순으로 N개 고른다. 각 릴리스의 `release-manifest.json`에서 commit을 읽어, 지원 창 하한 커밋을 포함하지 않으면 뺀다. 남은 것이 없으면 `::warning::`과 step summary에 "지원 창 안 릴리스 없음: <이유>"를 쓰고 빈 매트릭스를 낸다. dispatch는 `worker_image`를 직접 받을 수 있다(실험·실패 확인용).
2. `compat`(릴리스 × 엔진 `worker`·`worker-codex`): compose 스택 하나로 두 단계를 돈다.
   - 1단계(옛 릴리스): 그 릴리스의 commit을 `old/`에 꺼내고, 릴리스 digest의 control-host·worker·egress-proxy로 그 commit의 compose 파일과 가짜 모델을 띄운다. 세션 A를 만들고 turn 1 완료를 기다린다. 세션 A는 checkpoint를 남기고 쉰다.
   - 2단계(업그레이드 1단계 재현): 같은 compose project와 volume에서, 이 checkout의 compose 파일과 이 checkout으로 빌드한 control-host·egress-proxy로 바꾼다. `WORKER_IMAGE`와 `WORKER_IMAGE_PREVIOUS`는 옛 릴리스의 worker 그대로다. migrate가 새 schema를 만든다. 그 위에서 (a) 새 세션 B의 turn 1 완료(새 control-host × 옛 worker), (b) 세션 A에 입력을 보내 turn 2 완료(옛 worker로 시작한 세션을 새 schema에서 재개)를 확인한다.
   - 성공 기준은 "turn 완료"다. 400 부재가 아니다. 실패하면 worker 컨테이너 로그를 artifact로 남긴다.
3. 같은 step의 `trap`이 compose project, 이 run의 installation id 라벨이 붙은 컨테이너·네트워크·volume을 지운다.

### 4.2 시간

같은 compose 스택을 쓰는 `e2e` job이 7분(빌드 포함, 2026-11-12 main 실행)이다. 호환 job은 control-host·egress-proxy 두 이미지만 빌드하고 worker는 받기만 하며, 스택을 한 번 올리고 한 번 교체한다. 예상 8~11분, `timeout-minutes: 20`. 엔진 둘은 병렬이라 벽시계 시간은 job 하나와 같다. 기존 job의 시간은 늘지 않는다.

### 4.3 릴리스를 막는 지점

`images.yml`의 태그 흐름에서 `promote`(staging digest를 릴리스 태그로 승격)가 `worker-compat`에 `needs`를 건다. 호환 job은 `build`가 끝나면 `publish`와 나란히 돈다. 실패하면 승격·chart·GitHub Release가 모두 멈춘다. 지원 창 안 릴리스가 없어서 건너뛴 경우는 성공으로 끝나되 이유를 summary에 남긴다. 3.4의 고정본 확인도 이 job의 첫 step이다.

PR 경로 필터: `packages/contracts/src/worker-protocol/**`, `apps/worker/**`, `apps/control-host/src/api/routes/workers/**`, `packages/platform/src/workers/**`, `packages/db/migrations/**`, workflow 자신. 필수 체크가 아니다.

## 5. DB migration 검사

`migration-safety.ts`에 규칙 하나를 더한다. 이 규칙은 0273 뒤의 migration에만 적용한다(0270의 프로필 제거는 결정 (나)로 이미 끝났다).

- 거절 대상: 같은 migration에서 만들지 않은 테이블의 `DROP TABLE`, `ALTER TABLE … DROP COLUMN`, `RENAME COLUMN`, `RENAME TO`.
- 통과 조건: migration 파일에 `-- contract: <대상> last used by vX.Y.Z` 줄이 있고, `vX.Y.Z`가 `CHANGELOG.md`의 릴리스 절 제목이며, 가장 최근 릴리스 절이 아니다. 지원 창 N=1에서 다음 릴리스가 이 migration을 실을 때, 그 직전 릴리스(가장 최근 릴리스)의 control-host·worker는 이 열을 쓰지 않는다는 뜻이다.
- 보지 않는 것: `DROP CONSTRAINT`·`DROP INDEX`(열 데이터를 지우지 않는다), 데이터 `UPDATE`. 이런 변경의 옛 코드 영향은 리뷰와 매트릭스가 본다.

SSO(94S-1556) 설계(#1660)의 migration은 새 테이블 둘, NULL 허용 칸 하나, 작은 테이블의 `UPDATE`와 CHECK 교체다. 이 규칙에 걸리지 않는다.

## 6. 오케스트레이터 확인이 필요한 것

| 항목 | 선택지와 비용 | 추천 | 답이 없을 때 |
|---|---|---|---|
| 고정본 갱신을 릴리스 절차에 넣는다(3.4) | (A) 태그 뒤 maintainer가 갱신 PR을 낸다. 다음 태그의 gate가 갱신을 확인한다. 릴리스마다 PR 하나. (B) gate는 실제 이미지만 보고, 고정본 갱신은 문서 규칙으로만 둔다. 잊으면 PR 단계 검사가 옛 기준으로 돌고 문제는 태그 때 드러난다. (C) 릴리스 workflow가 갱신 PR을 연다. `pull-requests: write` 권한이 릴리스 job에 늘어난다 | A | A |

CI 시간(4.2)은 job당 15분 안이고 기존 job은 늘지 않는다. 지원 창 약속(현재+직전)은 바꾸지 않는다.

## 7. 단계

| PR | 내용 | 확인 |
|---|---|---|
| 1 | 이 문서, 경로 표 이동, 고정본·생성 스크립트, 비교기와 계약 시험, 기여 문서 링크 | 계약 시험 통과, 94S-1550 재현 커밋에서 실패 출력 |
| 2 | `worker-compat.yml`, compose 두 단계 스크립트, `images.yml`의 `promote` gate, 고정본 확인 step | dispatch로 `v0.1.3` worker를 넣어 turn 1 실패를 보이고, main worker 이미지를 넣어 통과를 보인다. 지원 창 안 릴리스 없음으로 건너뛰는 출력 |
| 3 | `migration-safety.ts` 삭제 규칙과 시험, 업그레이드 문서의 DB 절에서 이 검사로 링크 | 검사 시험, 기존 migration 통과 |
