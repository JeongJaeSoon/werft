# 결정(설계): 새 control-host와 지원 창 안 옛 worker의 호환 계약

- 상태: **승인(Codex 설계 리뷰 3회차).** 오너 방향(2026-11-13): "1090　을 그냥 이번에 진행해도 좋을거 같은데 어때?"
- 기준 커밋: `origin/main` `4fd9d19e7`. `파일:줄`은 모두 이 커밋 기준이다.
- 앞선 결정: 프로필 제거 릴리스만 control-host와 worker를 한 upgrade로 함께 올린다([프로필 제거 릴리스의 업그레이드 순서](../../../apps/docs/content/docs/run-server/self-hosting/upgrade-compose.mdx)).

## 무엇을 골랐나

1. **지원 창은 N=1이고, 이 설계는 N=1에 묶여 있다.** 새 control-host는 현재 worker 이미지와 직전 릴리스의 worker 이미지 하나(`images.workerPrevious`, `WORKER_IMAGE_PREVIOUS`)와 함께 돈다. 매트릭스는 N을 한 곳(워크플로의 `SUPPORT_WINDOW`)에서 읽고, 1이 아니면 실패한다. 허용 목록으로 N을 늘리는 변경은 고정본을 창 안 릴리스마다 하나씩 두고, DB 삭제 조건(5절)을 "더 새 릴리스 N+1개"로 바꾸는 것까지 함께 한다.
2. **지원 창의 하한은 프로필 제거 커밋 `ef3627954`(#1567)이다.** 이 커밋을 포함하지 않는 릴리스(`v0.1.3`까지)의 worker는 지원 창 밖이다. 지금 게시된 릴리스는 모두 하한 앞이라, 매트릭스는 첫 대상 릴리스가 나올 때까지 이유를 출력하고 건너뛴다.
3. **규칙은 하나다: 받는 쪽이 먼저 넓히고(expand), 보내는 쪽은 그 받는 쪽이 지원 창의 가장 옛 이미지가 된 뒤에 좁힌다(contract).** 요청(worker → control-host), 응답(control-host → worker), JSON 밖의 약속(상태 코드, 인증, 크기 한도), DB 열·테이블에 같은 규칙을 쓴다(2절).
4. **싼 검사는 schema 비교, 비싼 검사는 실제 이미지다.** PR마다 도는 계약 시험은 직전 지원 릴리스의 worker protocol을 JSON Schema로 저장소에 고정하고 지금 schema와 두 방향으로 비교한다(3절). 이 비교가 볼 수 없는 것(refine, transform, JSON 밖의 약속)은 목록으로 고정해 바뀌면 실패시키고, 실제 이미지 매트릭스가 덮는다. 릴리스 태그에서는 승격될 control-host 이미지와 직전 N개 릴리스의 실제 worker 이미지로 turn 완료와 checkpoint 재개를 확인하고, 실패하면 승격을 막는다(4절).
5. **DB의 열·테이블 삭제와 이름 바꾸기는 검사기로 막는다.** 지울 대상을 마지막으로 쓴 릴리스를 migration에 적어야 하고, 그 뒤로 릴리스가 둘 이상 있어야 통과한다(5절).

## 1. 지금 상태

| 항목 | 지금 | 근거 |
|---|---|---|
| worker protocol 경로 | `POST /internal/worker/*` 15개와 확장 번들 `GET` 1개 | `apps/control-host/src/api/routes/workers/worker.ts:111-236` |
| 요청 | worker는 요청을 schema로 파싱하지 않고 그대로 직렬화한다. control-host가 `parseJsonBody(context, request)`로 읽고, 요청 schema 대부분이 `.strict()`라 모르는 칸이 있으면 400 | `apps/worker/src/gateway-client.ts:323-339`, `worker.ts:93` |
| 응답 | control-host가 `jsonWithSchema`(`schema.parse(value)`)를 거쳐 보낸다. worker는 같은 응답 schema로 본문을 읽고, 맞지 않으면 재시도하지 않는 오류로 끝난다 | `apps/control-host/src/api/app.ts:326-333`, `gateway-client.ts:114-234` |
| 응답 안의 strict 객체 | bootstrap-claim 응답 54곳(`runtime_config`, `telemetry` 등), next-input 1곳, pending-control 4곳, protected-commits 1곳 | `z.toJSONSchema(schema, { io: "input" })`의 `additionalProperties: false` 개수 |
| capability 협상 | worker가 요청의 `capabilities`로 알린 능력이 있을 때만 control-host가 strict 객체에 칸을 더한다(예: `answer_surface`) | `packages/platform/src/workers/worker-gateway.ts:1491-1496,2454-2463` |
| 오류 본문 | worker가 `apiErrorResponseSchema`로 읽고 status·code·retryable로 재시도를 정한다 | `gateway-client.ts:380-407` |
| 호환 확인 | 업그레이드 문서의 사전 확인은 "API의 worker 요청 400 부재"다. 프로필 제거 때는 API가 200을 주고 worker가 본문을 거절해서 이 확인으로 보이지 않았다 | 업그레이드 문서 |
| DB migration 검사 | `packages/db/src/migration-safety.ts`가 0200 이후 migration의 잠금·재작성 위험을 거절한다. 열·테이블 삭제는 보지 않는다 | `migration-safety.ts:51,78-240` |

응답 안에 strict 객체가 있으므로, 응답에 칸을 **더하는 것**도 옛 worker를 멈출 수 있다. 예: `runtime_config`에 새 칸을 넣으면 그 칸을 모르는 worker는 bootstrap-claim 응답 전체를 거절한다.

## 2. expand → contract 규칙

"옛 쪽"은 지원 창 안의 가장 옛 이미지다. 새 control-host의 상대는 옛 worker와 옛 egress proxy이고(업그레이드 중간 단계는 control-host만 바꾼다), rolling update 동안 새 DB schema의 상대는 옛 control-host다.

| 바꾸는 것 | 1. 받는 쪽 | 2. 보내는 쪽 | 3. 정리 |
|---|---|---|---|
| 요청에 칸 추가 | control-host가 선택(`optional`·`default`)으로 받는다 | worker가 보낸다 | 필수로 바꾸는 것은 그 칸을 보내지 않는 worker가 지원 창을 벗어난 뒤 |
| 요청에서 칸 제거 | control-host가 그 칸을 선택으로 받는다(필수였다면) | worker가 보내지 않는다 | 보내던 worker가 지원 창을 벗어난 뒤 control-host의 strict schema에서 뺀다 |
| 요청 객체를 strict로 | — | — | 그 객체에 다른 칸을 실어 보낼 수 있는 worker가 지원 창을 벗어난 뒤. worker가 요청을 파싱하지 않으므로 타입에 없는 칸도 실릴 수 있다 |
| 응답에서 칸 제거·필수를 선택으로 | worker가 그 칸 없이도 읽는다 | 그 worker가 지원 창의 가장 옛 이미지가 된 뒤 control-host가 보내지 않는다(프로필 제거가 어긴 것) | — |
| 응답의 strict 객체에 칸 추가, enum 값·union 가지 추가 | worker가 그 칸·값을 읽는다 | 그 worker가 지원 창의 가장 옛 이미지가 된 뒤 control-host가 보낸다. 그 전에 보내려면 capability 협상으로 그 칸을 아는 worker에게만 보낸다 | — |
| 응답의 strict가 아닌 객체에 칸 추가 | 없음. 옛 worker는 모르는 칸을 버린다 | 바로 보낸다 | — |
| 값의 범위(길이, 최솟값, 형식, refine 조건) | 받는 쪽이 넓힌다 | 받는 쪽이 지원 창 전체에서 넓어진 뒤 보내는 쪽이 새 범위를 쓴다 | — |
| 경로 제거 | worker가 부르지 않는다 | — | 부르던 worker가 지원 창을 벗어난 뒤 control-host가 뺀다 |
| 상태 코드·오류 code·retryable의 뜻 | 옛 worker가 읽는 뜻을 바꾸지 않는다. 새 code는 그 code를 아는 worker의 새 요청에만 쓴다 | — | — |
| 인증(launch nonce → session token), 본문 크기 한도, long-poll 대기 시간 | 한도는 넓히기만 한다. 인증 방식을 바꿀 때는 control-host가 두 방식을 받는다 | worker가 새 방식을 쓴다 | 옛 방식을 쓰는 worker가 지원 창을 벗어난 뒤 control-host가 옛 방식을 뺀다 |
| egress proxy의 자격 증명 경로 | control-host가 옛 proxy가 부르는 경로와 응답을 유지한다 | — | 옛 proxy가 지원 창을 벗어난 뒤 |
| checkpoint manifest | 읽는 쪽이 먼저(업그레이드 문서의 기존 규칙) | — | — |
| DB 열·테이블 | 더한다(null 허용·기본값) | 새 코드가 쓰고 읽는다 | 그 열을 쓰는 control-host·worker 코드가 지원 창을 벗어난 다음 릴리스에서 지운다 |

새 worker가 옛 control-host를 만나는 경우(롤백)는 이 규칙의 범위 밖이다. 지금처럼 control-host를 먼저 올린다. 기존 `IsolationContractError`가 막는 경우도 그대로다.

이 표는 업그레이드 문서의 "worker protocol 필드를 걷어내는 순서"·"DB 스키마를 바꾸는 순서" 절을 응답 방향, strict 객체, JSON 밖의 약속까지 넓힌 것이다. 운영자 문서는 그 두 절을 그대로 두고, 기여자 규칙은 이 문서가 기준이다.

## 3. 계약 시험(PR마다)

### 3.1 무엇을 고정하나

`tests/fixtures/worker-protocol-baseline.json` 하나에 직전 지원 릴리스의 worker protocol을 담는다.

- 경로마다 `request`와 `response`, 모든 경로에 공통인 `error`(`apiErrorResponseSchema`). 값은 `z.toJSONSchema(schema, { io: "input" })`다. 옛 worker가 응답을 읽을 때 받아들이는 모양은 그 schema의 입력 쪽이다. 옛 worker가 보내는 요청은 파싱을 거치지 않으므로 요청 schema의 입력은 실제 전송값의 근사다(3.3).
- 경로·방향마다 JSON Schema가 담지 못하는 구성의 목록(`opaque`): `refine`·`superRefine`, `transform`·`preprocess`(pipe), `catch`, `custom`, `lazy`의 위치와 종류, 함수 본문을 알 수 있으면(`refine`) 그 본문의 sha256.
- 머리에 `{ release, commit }`을 적는다. 지원 창 안의 릴리스가 아직 없으므로 처음 값은 `{ release: null, commit: "<생성한 커밋>" }`이다. 이것은 다음 릴리스의 worker가 될 코드의 protocol이다.
- 경로 표를 계약 패키지로 옮긴다: `WORKER_PROTOCOL_ROUTES = { "/bootstrap-claim": { request, response }, … }`. `worker.ts`의 `call()`은 경로만 받고 이 표에서 schema를 꺼낸다. 그래서 표에 없는 POST 경로는 등록할 수 없고, 고정본과 실제 경로가 어긋나지 않는다. 확장 번들 `GET`은 `call()` 밖이라 이 표에 없고, 매트릭스가 덮는다.

고정본은 `bun scripts/worker-protocol-baseline.ts`가 만든다. 사람이 손으로 고치지 않는다.

### 3.2 무엇을 비교하나

현재 schema도 같은 방식으로 JSON Schema로 바꾼 뒤, "보내는 쪽이 낼 수 있는 값은 모두 받는 쪽이 받는다"(보내는 쪽 ⊆ 받는 쪽)를 구조로 확인한다.

| 방향 | 보내는 쪽 | 받는 쪽 | 잡는 것 |
|---|---|---|---|
| 응답 | 현재 응답 schema의 **출력**(`io: "output"`, control-host가 `parse`를 거쳐 보내는 모양) | 고정본 응답 | 필수 칸 제거, strict 객체에 칸 추가, enum 값·union 가지 추가, 범위 확장 |
| 요청 | 고정본 요청 | 현재 요청 schema의 입력 | 새 필수 칸, strict schema에서 칸 제거, 열린 객체를 strict로 바꿈, 범위 축소 |
| 오류 | 현재 오류 schema의 출력 | 고정본 오류 | 오류 본문 모양 변경 |
| 경로 | 고정본의 경로 | 현재 경로 표 | 경로 제거 |
| 손실 구성 | 고정본의 `opaque` | 현재의 `opaque` | refine 등의 추가·제거·본문 변경 |

비교기(`scripts/lib/schema-subset.ts`, 시험 `tests/schema-subset.test.ts`, 계약 시험 `tests/worker-protocol-compat.test.ts`)는 zod가 내보내는 키워드만 안다: `type`, `properties`, `required`, `additionalProperties`, `propertyNames`, `enum`, `const`, `anyOf`, `oneOf`, `items`, `prefixItems`, `minItems`·`maxItems`, `minLength`·`maxLength`, `minimum`·`maximum`·`exclusiveMinimum`·`exclusiveMaximum`, `pattern`, `format`.

- 받는 쪽에 모르는 키워드가 있으면 양쪽 값이 같을 때만 통과한다. `$ref`·`$defs`는 비교하지 않고 실패로 둔다(재귀 schema는 지금 없다).
- `pattern`과 `format`은 글자가 같아야 통과한다(정규식의 포함 관계는 판정하지 않는다).
- 보내는 쪽 객체가 열려 있으면(`additionalProperties`가 없거나 schema) 선언하지 않은 키에 아무 값이나 실릴 수 있다고 본다. 받는 쪽이 strict이거나, 그 키를 새로 타입과 함께 선언하거나, 나머지 키에 schema를 걸면 실패다. 응답의 보내는 쪽은 출력 모양이라 zod가 모르는 칸을 버린 뒤이고, 요청의 보내는 쪽은 파싱을 거치지 않아(engine event처럼 받은 값을 그대로 싣는 곳이 있다) 열린 객체에 무엇이 실릴지 모르기 때문이다. 옛 worker가 그 키를 보내지 않는다는 근거가 있으면 3.4의 인정 목록에 적는다.
- `oneOf`는 `anyOf`처럼 읽는다. zod는 discriminated union에만 `oneOf`를 쓰고, 그 가지들은 판별 칸으로 겹치지 않는다.
- 받는 쪽이 union이면 보내는 쪽의 union 가지·타입 목록(`nullable`)·literal 값 하나하나가 각자 받는 쪽의 어느 가지에 들어가면 된다.
- 배열은 보내는 쪽이 실제로 채울 수 있는 위치(`maxItems`, 닫힌 tuple)까지만 비교한다.
- JSON Schema로 쓸 수 없는 노드(`transform`의 출력, `custom`, `date`, `bigint` literal 등)가 있으면 zod의 대체 표현(대개 `{}`)으로 쓰고, 그 노드 하나하나를 손실 구성 목록에 "JSON Schema 없음"으로 남긴다. 대체 표현끼리는 실제 변경 앞에서도 같게 비교될 수 있어서(문자열이 `date`가 되어도 `{}`는 문자열을 받는다) 목록의 차이로 실패시킨다. 모든 노드를 쓸 수 있으면 이 과정은 돌지 않는다.

### 3.3 비교가 볼 수 없는 것과 덮는 곳

| 볼 수 없는 것 | 계약 시험이 하는 것 | 덮는 곳 |
|---|---|---|
| `refine`·`superRefine`·`transform`·`preprocess`·`catch`의 조건 | 위치·종류·(가능하면) 본문 해시를 고정해, 생기거나 없어지거나 `refine` 본문이 바뀌면 실패시킨다. `superRefine`·`transform`·`catch`의 본문 변경과, `refine` 본문이 부르는 상수·함수의 변경은 잡지 못한다 | 바꾼 PR이 그 조건의 옛·새 값을 실행으로 비교하는 시험을 더하고 3.4의 인정 목록에 적는다. 매트릭스 |
| 옛 worker가 타입 밖의 칸을 싣는 경우 | 열린 객체가 strict로 바뀌거나 선언하지 않던 키에 타입이 생기면 실패시킨다 | 매트릭스 |
| JSON 밖의 약속(상태 코드의 뜻, 인증 전환, 크기 한도, long-poll, 확장 번들 `GET`, egress proxy 경로) | 없음 | 매트릭스(실제 이미지로 turn과 재개를 돈다). 규칙은 2절 |
| checkpoint manifest | 없음 | 매트릭스 3단계: 옛 worker가 쓴 manifest를 새 control-host가 복원 계획으로 검사하고 옛 worker가 복원한다 |
| capability 협상 | 협상된 칸도 차이로 보고한다 | 3.4의 인정 목록 |

### 3.4 인정된 차이

`scripts/lib/worker-protocol-accepted.ts`의 목록에 든 차이만 통과한다. 항목은 `{ problem, why, proof }`다. `problem`은 시험이 낸 문구 그대로, `proof`는 그 차이가 옛 worker를 깨지 않음을 보이는 시험 파일이다(예: capability가 없는 worker에게는 그 칸을 보내지 않는다는 gateway 시험). 시험은 목록의 항목이 아직 실제 차이와 맞는지, `proof` 파일이 있는지도 확인한다. 고정본을 갱신하면 낡은 항목이 실패로 드러나 지워진다.

### 3.5 고정본을 바꾸는 때(결정 A, 오케스트레이터 2026-11-13)

- 릴리스 태그를 찍으면 그 릴리스가 다음 main의 직전 지원 릴리스가 된다. maintainer가 `bun scripts/worker-protocol-baseline.ts --ref vX.Y.Z`(그 태그를 임시 worktree에 꺼내 만든다)로 고정본을 갱신하는 PR을 낸다. 이 단계는 maintainer 릴리스 절차(`docs/contributing/ci.md`)에 적고, 운영자 문서와 CHANGELOG에는 적지 않는다.
- 다음 태그의 매트릭스 job 첫 step이 직전 지원 릴리스의 commit으로 고정본을 다시 만들어 저장소의 고정본과 **내용까지** 같은지 본다. 다르면 승격을 막고 갱신 명령을 그대로 출력한다.
- 계약 시험이 실패했을 때 고정본을 다시 만들어 통과시키지 않는다. 고정본의 `release`·`commit`이 바뀌는 diff는 위의 경우에만 나온다.

Codex의 반론(고정본을 CI에서 태그로 만들어 갱신 PR을 없애자)은 받지 않았다. PR마다 도는 `check`가 네트워크·두 번째 checkout 없이 돌고, protocol 변경이 PR diff로 보이는 것을 택했다. 대신 gate가 고정본의 내용을 태그에서 다시 만들어 대조한다.

### 3.6 실패를 보이는 방법

PR 1에 프로필 제거와 같은 변경(bootstrap-claim 응답의 필수 칸 하나 제거)을 넣은 실험 커밋과 그 시험 출력, 되돌린 커밋을 남긴다.

## 4. 실제 이미지 매트릭스(릴리스 gate)

### 4.1 구조

새 workflow `worker-compat.yml` 하나. `workflow_call`(릴리스), `workflow_dispatch`, `pull_request`(경로 한정), `schedule`(매일 1회)로 돈다.

1. `plan`: GitHub Release 목록에서 지금 ref 앞의 릴리스를 최신순으로 N개 고른다. 각 릴리스의 `release-manifest.json`에서 commit을 읽어, 지원 창 하한 커밋을 포함하지 않으면 뺀다. 남은 것이 없으면 `::warning::`과 step summary에 "지원 창 안 릴리스 없음: <이유>"를 쓰고 빈 매트릭스를 낸다. dispatch는 옛 릴리스 대신 이미지 묶음(control-host·worker·egress-proxy digest와 commit)을 직접 받을 수 있다(실험·실패 확인용).
2. `compat`(릴리스 × 엔진 `worker`·`worker-codex`): compose project 하나, DB·object store volume·installation id·비밀값을 끝까지 유지하며 세 단계를 돈다. 앱 이미지는 compat overlay가 digest로 지정하고 `build`를 지운다. 가짜 모델과 fake-git 같은 보조 서비스는 이 checkout의 것을 쓴다.
   - **1단계(옛 릴리스).** 옛 릴리스의 commit을 `old/`에 꺼내 그 compose 파일과 릴리스 digest(control-host·worker·egress-proxy)로 띄운다. 세션 A의 turn 1이 끝나고 checkpoint가 확정될 때까지 기다린다.
   - **2단계(rolling update 동안: 새 schema 위의 옛 control-host).** 새 control-host 이미지의 migrate만 돌려 DB를 새 schema로 올린다. 옛 control-host·worker가 그대로 도는 채로 세션 A의 turn 2가 끝나는지 본다. DB 규칙(5절)을 실제로 확인하는 단계다. 끝나면 세션 A를 pause하고 그 worker 컨테이너가 사라질 때까지 기다린다.
   - **3단계(업그레이드 중간 단계: control-host만 새것).** control-host의 모든 역할(api, scheduler 등)을 새 이미지로 바꾼다. egress proxy와 worker는 옛 릴리스 그대로이고 `WORKER_IMAGE`·`WORKER_IMAGE_PREVIOUS`도 옛 worker다. (a) 새 세션 B의 turn 1 완료(새 control-host × 옛 worker·proxy). (b) 세션 A를 resume해 turn 3 완료: worker generation이 늘었고, 띄운 worker 이미지가 옛 digest이며, 가짜 모델이 받은 대화 이력에 turn 1·2가 있다(checkpoint에서 복원했다는 증거, conformance `resume` 시험과 같은 확인).
   - 성공 기준은 "turn 완료"다. 400 부재가 아니다. 실패하면 compose·worker 로그를 artifact로 남긴다.
3. 같은 step의 `trap`이 compose project와 이 run의 installation id 라벨이 붙은 컨테이너·네트워크·volume을 지운다.

scheduler가 checkpoint의 runtime 조합으로 현재·직전 이미지 중 하나를 고르는 것은 이 job이 보지 않는다(3단계는 두 칸이 같은 이미지다). 그 선택은 scheduler 단위 시험(`packages/platform/src/scheduler/worker-images.test.ts`)이 본다.

이 job은 보통의 turn과 checkpoint 재개 경로만 실제로 돈다. 오류 응답의 재시도, 본문 크기 경계, long-poll 대기 시간의 끝, 확장 번들 `GET`(런타임 확장이 있는 에이전트)은 실행하지 않는다. 이것들은 2절의 규칙과 리뷰로만 지킨다. 남은 위험으로 적어 둔다.

### 4.2 시간

같은 compose 스택을 쓰는 `e2e` job이 7분(빌드 포함, 2026-11-12 main 실행)이다. 호환 job은 두 checkout, 옛 이미지 pull, 스택 한 번 기동과 두 번 교체, turn 넷을 돈다. 8~12분으로 **추정**하고 PR 2에서 실측한다. job당 15분을 넘으면 구현 전에 오케스트레이터에게 알린다. `timeout-minutes: 20`. 엔진 둘은 병렬이다. 기존 job의 시간은 늘지 않는다.

### 4.3 릴리스를 막는 지점

`images.yml`에는 릴리스로 가는 길이 둘 있고, 둘 다 **승격될 그 control-host digest**로 호환 job을 돌린 뒤에야 승격한다.

| 길 | 시작 | 호환 job의 입력 | 호환 job을 기다리는 job |
|---|---|---|---|
| 자동 릴리스 | main에 CHANGELOG 릴리스 절이 병합된 push(`release-detect`가 태그 이름을 낸다). 태그는 승격 뒤 맨 끝에 만든다 | `index-main`이 만든 main의 staging digest(`promote-release`가 그대로 릴리스 태그로 승격하는 것) | `release-approve`(승인 환경 앞, `promote-release`의 선행) |
| 수동 태그 push | `refs/tags/v*` push | `index`가 만든 staging digest | `promote` |

실패하면 승격·chart·태그·GitHub Release가 모두 멈춘다. 지원 창 안 릴리스가 없어 건너뛴 경우는 성공으로 끝나되 이유를 summary에 남긴다. 3.5의 고정본 대조도 이 job의 첫 step이다. "직전 릴리스"는 두 길 모두 지금 만드는 태그를 뺀 게시 릴리스 중 최신이다. PR·dispatch·schedule 실행은 이 checkout으로 control-host를 빌드한다.

PR 경로 필터: `packages/contracts/src/worker-protocol/**`, `apps/worker/**`, `apps/control-host/src/api/routes/workers/**`, `packages/platform/src/workers/**`, `packages/db/migrations/**`, workflow와 compat 스크립트 자신. 필수 체크가 아니다.

## 5. DB migration 검사

`migration-safety.ts`에 규칙 하나를 더한다. 이 규칙은 0273 뒤의 migration에만 적용한다(0270의 프로필 제거는 앞선 결정으로 끝났다).

- 거절 대상: 같은 migration에서 만들지 않은 테이블의 `DROP TABLE`, `ALTER TABLE … DROP COLUMN`, `RENAME COLUMN`, `RENAME TO`.
- 통과 조건: migration 파일에 `-- contract: <대상> last used by vX.Y.Z` 줄이 있고, `vX.Y.Z`가 `CHANGELOG.md`의 릴리스 절 제목이며, 그보다 새 릴리스 절이 **둘 이상** 있다.
  - 왜 둘인가: 릴리스 준비 PR이 "미출시" 절을 새 태그 제목으로 바꾼 뒤 태그 전에 머지된 migration은 그 릴리스에 실린다. 가장 최근 제목 L이 곧 나갈 릴리스일 수 있으므로, rolling update 중 도는 옛 control-host는 L-1일 수 있다. vX ≤ L-2여야 안전하다. 보통의 경우 한 릴리스 더 늦게 지우게 되지만, 정리를 늦추는 것은 언제나 안전하다.
- "마지막으로 썼다"는 주장 자체는 검사기가 증명하지 못한다. 리뷰가 보고, 매트릭스 2단계(새 schema 위의 옛 control-host)가 태그에서 확인한다.
- 보지 않는 것: `DROP CONSTRAINT`·`DROP INDEX`(열 데이터를 지우지 않는다), 데이터 `UPDATE`. 이런 변경의 옛 코드 영향은 리뷰와 매트릭스 2단계가 본다.

SSO 설계(#1660)의 migration은 새 테이블 둘, NULL 허용 칸 하나, 작은 테이블의 `UPDATE`와 CHECK 교체다. 이 규칙에 걸리지 않는다.

## 6. 오케스트레이터 결정

| 항목 | 결정 |
|---|---|
| 고정본 갱신을 maintainer 릴리스 절차에 넣는다(3.5) | A(2026-11-13): 태그 뒤 갱신 PR, 다음 태그의 gate가 대조하고 막을 때 갱신 명령을 출력한다. 오너 아침 검토 목록에 올라 있다 |

CI 시간은 4.2의 실측 뒤 다시 본다. 지원 창 약속(현재+직전)은 바꾸지 않는다.

## 7. 단계

| PR | 내용 | 확인 |
|---|---|---|
| 1 | 이 문서, 경로 표 이동, 고정본·생성 스크립트, 비교기·손실 구성 목록·인정 목록과 계약 시험, 기여 문서 링크, maintainer 릴리스 절차 | 계약 시험 통과, 프로필 제거와 같은 변경의 실험 커밋에서 실패 출력 |
| 2 | `worker-compat.yml`, compose 세 단계 스크립트와 compat overlay, `images.yml`의 `promote` gate, 고정본 대조 step | dispatch로 `v0.1.3` 이미지 묶음을 넣어 실패를, main 이미지 묶음을 넣어 통과를 보인다. 지원 창 안 릴리스 없음으로 건너뛰는 출력. 실측 시간 |
| 3 | `migration-safety.ts` 삭제 규칙과 시험, 업그레이드 문서의 DB 절에서 이 검사로 링크 | 검사 시험, 기존 migration 통과 |

## 8. 리뷰 기록

- Codex 설계 리뷰 1회차(2026-11-13): REJECT, 11건. 반영: 요청 비파싱과 열린 객체(1), 손실 구성 목록(2), capability 협상과 인정 목록(3), pause·generation·이력으로 재개 확인(4), 현재·직전 선택은 범위 밖으로 명시(5), compat overlay와 시간 추정 표시(6), staging digest 시험(7), migration 조건 두 릴리스(8), JSON 밖의 약속(9), manifest 근거 수정(10), 요청 제거 순서(11 앞부분). 받지 않음: 11 뒷부분(3.5).
- Codex 설계 리뷰 2회차: REJECT. 1·3·4·5·6·8·10·11 해결, 2·7·9 부분. 새 지적 2건. 반영: 자동 릴리스 길(`release-approve`)에도 gate를 건다(4.3), 설계를 N=1에 묶고 N을 늘릴 때 함께 바꿀 것을 적는다(무엇을 골랐나 1), 잡지 못하는 손실 구성을 구체적으로 적는다(3.3), 매트릭스가 실행하지 않는 경로를 남은 위험으로 적는다(4.1), 현재·직전 선택의 근거를 scheduler 단위 시험으로 고친다. 3.5 반론(결정 A)은 Codex가 동의했다.
- Codex 설계 리뷰 3회차: **APPROVE.** 2회차 지적이 모두 해결됐고 새 BLOCKER·MAJOR가 없다. 자동 릴리스 gate를 `index-main`·`release-detect` 뒤, `release-approve` 앞에 두어도 순환이 없고, `index-main`의 digest가 `promote-release`가 승격하는 digest임을 확인했다.
- Codex 구현 리뷰 1회차(1단계 PR): REJECT, 5건. 모두 반영(3.2): 열린 보내는 쪽 객체의 선언 안 된 키(1), JSON Schema로 쓸 수 없는 노드가 고정본 생성을 멈추던 것(2), 받는 쪽 union에 보내는 쪽의 타입·literal을 나눠 맞춤(3), 배열의 닿지 않는 위치(4), 고정본 경로는 표에 포함되면 충분(5).
- Codex 구현 리뷰 2회차: REJECT. 1회차 5건은 해결. 새 지적 1건: `unrepresentable: "any"`가 손실 구성 목록에 없는 타입(`date` 등)까지 `{}`로 바꿔 요청 `string → date`를 통과시켰다. 반영: 엄격 변환이 실패할 때만 대체 표현을 쓰고, 엄격 변환이 실패하는 가장 깊은 노드를 목록에 남긴다(3.2).
- Codex 구현 리뷰 3회차: **APPROVE.** `string → date`가 이제 실패하고, 지금 트리는 고정본과 차이가 없으며, 다시 만든 고정본은 내용이 같다.
