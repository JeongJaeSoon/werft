# 결정: 로그 레코드 계약과 에러 기록 규칙

- 상태: **제안.** 오너 방향(2026-11-02): "표준 logger·에러 처리 — 설계 문서 먼저(architect, 로그 소비자·필드, proxy 무의존), 단계 PR, 로그 필드 변경 명시."
- 기준 커밋: `origin/main` `799f9895f`. `파일:줄`은 모두 이 커밋 기준이다.
- 범위: API·scheduler·reconciler·slack·metrics 역할(`packages/observability`), worker(`apps/worker`), egress proxy(`apps/egress-proxy`)가 stdout에 쓰는 프로세스 로그. 세션 데이터(`events` 표)와 receipt는 다루지 않는다([관측 문서](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/session-data-flow/)).

## 무엇을 골랐나

1. **레코드 모양은 하나다.** 플랫폼 logger의 모양 `{timestamp, level, event?, message, <context>, fields?}`를 표준으로 삼는다. 운영 문서([Datadog 감시 기준](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/monitoring-datadog/))와 Datadog 정의가 이미 이 모양을 기대한다. proxy는 이미 이 모양이고, worker만 다르다(필드를 최상위에 펼친다).
2. **공통 구현이 아니라 계약 테스트로 맞춘다.** 세 logger는 각자 남는다. 저장소 테스트 하나가 세 logger를 같은 입력으로 돌려 나온 줄을 한 검사 함수로 확인한다. proxy 이미지는 지금처럼 workspace 의존성 없이 자기 디렉터리만 싣는다.
3. **worker 줄의 모양을 바꾼다.** 이미 있는 로그 줄의 필드가 바뀌는 단계는 이것뿐이다(6절 L4는 stderr 평문 대신 JSON 줄을 새로 쓴다). worker의 필드를 `fields` 아래로 옮기고 `message`를 더한다. 지금 Datadog의 worker checkpoint metric 열한 개 중 아홉은 `@fields.*` 값을 재는데 worker 줄에는 `fields`가 없어 값이 비어 있다(2절). 이 단계가 그것을 고친다.
4. **에러는 로그에 문자열로 남긴다.** `messageOf(error)`로 만든 문자열을 필드에 넣는다. `Error` 객체를 그대로 넣으면 `{}`로 찍힌다(3.3절 실측).
5. **`messageOf`는 `@werft-ai/contracts`로 옮긴다.** worker는 `@werft-ai/platform`에 의존하지 않아 같은 함수의 사본(`apps/worker/src/message-of.ts`)을 들고 있다. platform이 의존할 수 있는 패키지는 `@werft-ai/contracts`·`@werft-ai/runtime-core`·`zod`뿐이고(`tests/architecture.test.ts:999-1018`), worker도 `@werft-ai/contracts`에 의존한다. 그래서 `@werft-ai/contracts`의 공유 primitive로 두고 `@werft-ai/platform`은 같은 이름을 다시 내보낸다.
6. **오래 도는 역할의 실행 경로에서는 `console.*`를 직접 부르지 않는다.** 남은 한 곳(`apps/control-host/src/pass-loop/loop.ts:481`)을 구조화 로그로 바꾼다. CLI의 결과 출력은 로그가 아니므로 그대로 둔다(3.4절의 예외 목록).

## 1. 지금 logger와 에러 출력

### 1.1 logger 세 벌

| 프로세스 | 구현 | 한 줄의 모양 | 레벨 | `LOG_LEVEL`이 틀릴 때 | 마스킹 | 호출 수 |
|---|---|---|---|---|---|---|
| API·scheduler·reconciler·slack·metrics, DB migrate | `packages/observability/src/index.ts:93-178` `StructuredLogger` | `{timestamp, level, event?, message, session_id?·turn_id?·pod_id?·request_id?·trace_id?, fields?}`. `fields.event`가 문자열이면 최상위 `event`로 올린다(`:141-156`). context는 `withContext`로 최상위에 붙는다 | `debug` `info` `warn` `error` | 기동 시 `logLevelFromEnv`가 거부한다(`:68-77`) | `redaction.ts`. 메시지 본문 키(`message`·`body`·`input` 등)는 뺀다 | 260 |
| worker | `apps/worker/src/console-logger.ts:17-45` `createConsoleLogger` | `{timestamp, level, event, ...fields}`. 필드를 최상위에 펼치고, 그 뒤에 머리 세 칸을 다시 써서 필드가 덮지 못하게 한다(`:36-41`). `message`는 호출이 `message` 필드를 넘길 때만 최상위에 생긴다(`session-checkpoints.ts:819-820`의 `worker.checkpoint.result` 하나). `session_id`·`turn_id`도 호출이 넘긴 필드로 최상위에 놓인다 | `info` `warn` `error`(`debug` 메서드 없음, `worker-host.ts:104-108`) | `resolveLogLevel`이 `info`로 바꾼다(`packages/observability/src/index.ts:56-61`). scheduler가 검사한 값을 넘기므로 실제로는 틀린 값이 오지 않는다 | `redaction.ts` + `SecretScrubber`(`<redacted>`). 메시지 본문 키를 남긴다(`includeMessageBodies=true`) | 74 |
| egress proxy | `apps/egress-proxy/src/logger.ts:44-68` `createProxyLogger` | `{level, message, timestamp, fields?}`. `event`가 없고 `message`는 사람이 읽는 문장이다 | `debug` `info` `warn` `error` | 기동 시 거부한다(`:33-42`) | `redaction.ts`의 바이트 단위 사본. `logger.test.ts:8-15`가 두 파일이 같은지 본다 | 46 |

`message`를 기계용 이름으로 쓰는 곳은 거의 없다. 플랫폼 호출 260개 가운데 `event`를 따로 주는 것은 `api.request.completed`(`apps/control-host/src/api/app.ts:485`)와 `control.result`(`packages/db/src/control-observability.ts:22`) 둘이다. 나머지는 `"Execution launched"` 같은 문장이 곧 식별자다.

실측 명령:

```sh
git grep -n -E "createLogger\(|new StructuredLogger|createConsoleLogger\(|createProxyLogger\(" -- '*.ts' ':!*.test.ts'
git grep -n -E "logger\??\.(debug|info|warn|error)\(" -- 'apps/control-host/**/*.ts' 'packages/**/*.ts' ':!*.test.ts' | wc -l   # 260
git grep -n -E "logger\??\.(info|warn|error)\(" -- 'apps/worker/**/*.ts' ':!*.test.ts' | wc -l                                # 74
git grep -n -E "logger\??\.(debug|info|warn|error)\(" -- 'apps/egress-proxy/**/*.ts' ':!*.test.ts' | wc -l                    # 46
git grep -n -E "event: \"[a-z_.]+\"" -- 'apps/control-host/**/*.ts' 'packages/**/*.ts' ':!*.test.ts'
```

### 1.2 에러를 문자열로 바꾸는 곳

| 위치 | 하는 일 |
|---|---|
| `packages/platform/src/scheduler/pass-context.ts:141-143` `messageOf` | `Error`면 `message`, 아니면 `String(error)`. `packages/platform/src/index.ts:94`가 내보낸다. scheduler·launch·reconcile·replace·orphans·local-docker backend가 쓴다 |
| `apps/worker/src/message-of.ts:1-3` `messageOf` | 위와 같은 본문. worker가 `@werft-ai/platform`에 의존하지 않아서 둔 사본이다(`gateway-client.ts:44`, `session-checkpoints.ts:74`) |
| `apps/worker/src/heartbeat.ts:289-294` `message` | `WorkerGatewayRequestError`에 code가 있으면 `<code>: <message>`, 아니면 위와 같다. code를 붙이는 점이 달라 `messageOf`의 사본은 아니다 |
| `apps/control-host/src/api/forge-github.ts:1113-1126` `failure` | octokit 에러는 요청 헤더(JWT·token)를 품으므로 메시지 대신 클래스 이름과 status, GitHub가 준 이유(`github_reason`·`github_errors`, `:1141-1164`)만 남긴다. 요청에 호출자 값이 든 호출은 `quiet`(`:259-273`)로 클래스 이름·status·요청 id만 남긴다. PR 생성은 예외로 `failure`를 쓴다(3.3절 2) |
| `apps/worker/src/session-checkpoints.ts:334-338` | 거절 code는 `code`, 문장은 `reason`으로 나눠 남긴다 |
| 그 밖의 인라인 `error instanceof Error ? error.message : String(error)` | 46개 파일 56곳. 이 중 `examples/`(9곳)와 `apps/egress-proxy/`(6곳)는 공유 패키지를 들일 수 없는 곳이다. `packages/client/src/errors.ts:88-93`(API 오류 생성)과 `packages/contracts/src/shared/settings.ts:60-65`(설정 오류 수집)처럼 로그와 무관한 곳도 섞여 있다 |

실측 명령:

```sh
git grep -n "function messageOf" -- '*.ts'
git grep -c -E "instanceof Error \? [a-zA-Z]+\.message" -- '*.ts' ':!*.test.ts'
```

### 1.3 `console.*`를 직접 부르는 곳(테스트·bench·testkit·web 제외)

| 위치 | 성격 |
|---|---|
| `apps/control-host/src/pass-loop/loop.ts:481` `console.error(error)` | **로그.** scheduler·reconciler pass 자식 프로세스가 pass 실패를 stack 그대로 stderr에 쓴다. 같은 역할의 다른 줄은 구조화 logger다 |
| `apps/control-host/src/main.ts:44` | 인자 오류를 쓰고 2로 끝난다(사용법 출력) |
| `apps/control-host/src/api/auth.ts:214` | `BOOTSTRAP_TOKEN_FILE`이 없을 때 bootstrap token을 운영자 터미널에 그대로 보인다(있으면 파일에만 쓴다). logger는 `*token*` 필드를 가리므로 일부러 logger를 쓰지 않는다(`:205-209` 주석) |
| `apps/control-host/src/api/{keys,grants,settings,forget-lost-checkpoints,demo-accounts,demo-data,slack-app,slack-install,upgrade-check}.ts`, `apps/control-host/src/scheduler/migrate-workspace.ts:174` | 운영자 CLI의 결과·거절 출력 |
| `apps/worker/src/image-runtime.ts:72` | 이미지 빌드 때 쓰는 CLI의 JSON 출력 |
| `apps/egress-proxy/src/healthcheck.ts:74` | Docker healthcheck의 실패 이유 |
| `packages/system/src/git-process.ts:50` | Linux가 아닌 호스트에서 git 자원 제한을 걸지 못한다는 경고를 한 번 쓴다(개발 환경 전용) |
| `packages/client/src/contract.ts:78`, `packages/core/src/schemas/validators.ts:95` | SDK 사용자에게 보이는 계약 불일치 경고 |

프로세스 수준의 `uncaughtException`·`unhandledRejection` 처리기는 없다. 잡히지 않은 예외는 Bun이 JSON이 아닌 stack으로 stderr에 쓴다.

실측 명령:

```sh
git grep -n -E "console\.(log|error|warn|info|debug)\(" -- 'apps/**/*.ts' 'packages/**/*.ts' ':!*.test.ts' ':!*.test.tsx' ':!**/bench/**' ':!packages/testkit/**' ':!apps/web/**' ':!apps/storybook/**' ':!apps/docs/**'
git grep -n -E "uncaughtException|unhandledRejection" -- 'apps/**/*.ts' 'packages/**/*.ts' ':!*.test.ts'
```

## 2. 로그를 읽는 곳

| 소비자 | 읽는 필드 | 근거 | 지금 맞는가 |
|---|---|---|---|
| Datadog log pipeline | JSON을 parse하고 `timestamp`·`level`을 날짜·상태로 쓴다. `event`가 없으면 `message`를 `event`로 복사한다 | `infra/datadog/definitions/log-pipeline.json`. sample은 `{timestamp, level, event, message, fields:{…}}` | 플랫폼·proxy 맞음. worker는 `message`가 없지만 `event`가 있어 맞음 |
| Datadog log-based metric 17개 | `@event`로 거르고 `@fields.*`로 묶거나 잰다 | `infra/datadog/definitions/log-metrics.json` | 플랫폼 이벤트(`api.request.completed`, `control.result`, launch·exit 문장) 6개는 맞음. **worker 이벤트 11개 중 10개가 빈 경로를 읽는다:** 9개는 `worker.checkpoint.result`·`worker.checkpoint.published`의 `@fields.duration_ms`·`@fields.bundle_bytes`·`@fields.untracked_bytes`·`@fields.manifest_bytes` 등을 재는 distribution인데, worker 줄에 없는 경로라 값이 비어 있다. `checkpoint.failed`는 개수는 맞고 `@fields.stage` 묶음만 비어 있다. `checkpoint.late`는 필드를 읽지 않는 count라 맞다 |
| Datadog monitor 20개 | 위 metric | `infra/datadog/definitions/monitors.json` | worker distribution을 읽는 monitor 8~11(capture latency, bundle·untracked·manifest 한도)은 값이 없어 울리지 않는다. 6·7(`checkpoint.failed`·`late`)은 개수를 세므로 울린다 |
| Datadog facet 목록 | `@event`, `@fields.*` facet, high-cardinality라 facet으로 만들지 않을 `@fields.session_id` 등 | `infra/datadog/definitions/log-facets.json` | worker 이벤트의 같은 이름 필드는 최상위에 있어 facet에 잡히지 않는다 |
| 운영 문서 | 로그 message·event 문자열과 필드 이름을 문제 진단의 근거로 인용한다. 예: `"message":"Credential route"`·`"status":200`(proxy), `Session catalog loaded`의 `revision`, `worker.checkpoint.failed`(`fields.stage`) | `docs/operator/*.md`. 코드의 message 문자열 309개 중 62개를 `docs/`나 `infra/datadog`가 인용한다 | `docs/operator/api-server.md:30`은 worker 줄을 `{timestamp, level, event, ...fields}`로 적는다(코드와 맞음). `monitoring-datadog.md:63`은 worker 이벤트를 `fields.stage`로 적는다(코드와 다름) |
| d2-gate e2e harness | worker 줄의 최상위 `event`, `turn_id`, `input_id`, `kind`, `retry_in_ms` | `tests/d2-gate/harness.ts:705-722`, `tests/d2-gate/gate.e2e.test.ts:167,567-568,687,1058` | 맞음(평평한 모양에 기대어 있다) |
| d2-gate reconciler sweep | 플랫폼 줄의 `message`와 `fields.fenced_session_ids`·`fields.session_ids` | `tests/d2-gate/reconciler-sweep.e2e.test.ts:72-88` | 맞음 |
| d2-gate control-host 역할 | worker 줄의 `event`, scheduler 줄의 문장 `stopping the scheduler loop`(문자열 포함 검사) | `tests/d2-gate/control-host-roles.e2e.test.ts:252-269` | 맞음. L2 영향 없음 |
| soak 스크립트와 그 테스트 | worker 줄의 최상위 `event`·`session_id`·`turn_id`·`timestamp`. 테스트는 평평한 fixture 줄을 만든다 | `scripts/soak/soak.ts:900-925`, `scripts/soak/campaigns.ts:1254`, `tests/soak/soak.test.ts:1006-1034` | 맞음(평평한 모양에 기대어 있다) |
| restore-resume e2e | worker 줄에서 `worker.checkpoint.restored`·`worker.resume.ready`를 grep하고, 그 줄에 `"revision":<n>`과 commit 문자열이 있는지 본다 | `tests/e2e/restore-resume.sh:320-325` | 맞음. 문자열 검색이라 `fields` 아래로 옮겨도 맞는다 |
| scheduler 통합 테스트 | proxy 로그에 `Egress proxy listening`·`Credential routes listening` 문장이 있는지 본다 | `tests/scheduler-launch-claim.integration.test.ts:444-448` | 맞음. L2 영향 없음 |
| 단위 테스트 | 각 logger의 출력 모양 | `apps/worker/src/console-logger.test.ts`, `apps/egress-proxy/src/logger.test.ts`, `packages/observability/src/index.test.ts` | 맞음 |
| Langfuse·OTel | 없음. 앱에는 OTel 의존성도 exporter도 없고 `trace_id`는 채우는 곳이 없다 | `apps/docs/content/docs/run-server/self-hosting/operate/session-data-flow.mdx`. `infra/observability/`는 예제 collector와 테스트 span 스크립트뿐이다 | 해당 없음 |
| Grafana(Loki) 예제 | `service_name` label만 | `apps/docs/content/docs/run-server/self-hosting/operate/session-data-flow.mdx` | 해당 없음 |

CI의 `docker logs … | tail -40` 단계(`.github/workflows/ci.yml:740`)는 로그를 job 출력에 보일 뿐 parse하지 않는다. 그래서 소비자로 세지 않는다.

worker 모양과 Datadog 정의가 어긋난 것은 처음부터다. worker 줄을 평평하게 만든 커밋 `cea4e3159`(2026-09-25)가 Datadog 정의를 더한 `54755d999`(2026-09-27)보다 앞선다.

실측 명령:

```sh
grep -o -E "@[a-z_.]+(:[^ \")]+)?" infra/datadog/definitions/log-metrics.json | sort | uniq -c
git grep -n -E "line\.[a-z_]+|record\.(event|message|session_id|turn_id)|JSON\.parse\(line" -- tests/d2-gate scripts/soak
git grep -h -o -E "logger\??\.(debug|info|warn|error)\(\s*\"[^\"]+\"" -- 'apps/**/*.ts' 'packages/**/*.ts' ':!*.test.ts' | sed -E 's/.*\("//; s/"$//' | sort -u   # 309개; 각 문자열을 grep -rlF로 docs/·infra/datadog에서 찾으면 62개
git log --format='%h %ad %s' --date=short -S'{timestamp, level, event, ...fields}'
```

## 3. 표준 계약

### 3.1 레코드

한 줄은 JSON 객체 하나다. stdout에 쓴다.

```ts
// The one line every long-running process writes to stdout.
type LogRecord = {
  timestamp: string;            // Date#toISOString(), UTC with milliseconds
  level: "debug" | "info" | "warn" | "error";
  event?: string;               // dotted machine name, e.g. "worker.checkpoint.result"
  message: string;              // human sentence; the event when no sentence exists
  session_id?: string;          // context set by StructuredLogger#withContext only
  turn_id?: string | number;
  pod_id?: string;
  request_id?: string;
  trace_id?: string;
  fields?: Record<string, unknown>; // everything else; never an Error object
};
```

규칙:

- 최상위 키는 위 열 개뿐이다. 그 밖의 값은 모두 `fields` 아래에 둔다. `fields`가 최상위 키를 덮을 길이 없다.
- 최상위 context 다섯 키는 `StructuredLogger#withContext`만 쓴다. 호출이 `session_id`·`turn_id`를 필드로 넘기면 `fields.session_id`·`fields.turn_id`다. 플랫폼은 지금도 그렇게 찍고(`packages/observability/src/index.ts:138-161`), Datadog facet 목록도 `@fields.session_id`를 그 경로로 적는다. worker에는 context 장치가 없으므로 L2 뒤 worker의 `session_id`·`turn_id`는 `fields` 아래에 있다.
- `event`를 주는 로그는 그 이름을 바꾸지 않는다. `event`가 없는 로그는 `message` 문장이 식별자 노릇을 한다. Datadog pipeline이 그것을 `event`로 복사하고, 운영 문서와 metric이 그 문장을 인용한다(2절의 62개). 그래서 이 문장을 바꾸는 것도 로그 필드 변경이다.
- metric·monitor·테스트가 새로 읽을 로그에는 `event`를 준다.
- 마스킹은 `packages/observability/src/redaction.ts` 한 벌의 규칙을 따른다. proxy는 그 사본을 쓴다.
- 키 순서는 계약이 아니다.

### 3.2 계약을 지키는 방법

```ts
// packages/observability/src/record-contract.ts — no imports, like redaction.ts
export const LOG_RECORD_KEYS: readonly string[]; // the ten keys above
export function logRecordProblems(line: string): string[]; // [] when the line conforms
```

```ts
// tests/log-record-contract.test.ts
// Runs each process's logger with the same call and checks every line:
//   platform: createLogger({ sinks: [memory] })        -> JSON.stringify(record)
//   worker:   createConsoleLogger({ write })
//   proxy:    createProxyLogger("debug", write)
// Same input for all three, e.g.
//   warn("<name>", { stage: "finalize", bytes: 1, error: "boom", authorization: "Bearer x" })
// expects: logRecordProblems(line) is [], fields.stage/bytes/error under `fields`,
//          authorization masked.
```

- 검사 함수는 `packages/observability`에 두지만 import가 없는 파일이다. 테스트만 부른다. proxy 코드는 이 파일을 import하지 않는다.
- 테스트는 저장소 `tests/`에 둔다. proxy 이미지는 `apps/egress-proxy/src`만 실으므로(`tests/images.test.ts`) 테스트가 무엇을 import하든 이미지는 그대로다.
- 첫 단계에서는 worker가 계약에 맞지 않는다. 그 단계의 테스트는 worker를 알려진 예외로 적고, 예외가 사라지면 실패하게 둔다. worker 단계가 예외를 지운다.
- worker는 제품과 같은 조립으로 검사한다: `scrubbingLogger(createConsoleLogger({ write }), …)`. 이 경로로 다음을 확인한다. 들고 있는 비밀값이 `<redacted>`가 된다(`secret-scrubber.ts:134-147`가 필드를 먼저 scrub한다). `input_id`가 남는다(worker는 `sanitizeFields(…, true)`로 메시지 본문 키를 지우지 않는다, `console-logger.ts:12-15,40`). 최상위로 올린 `message`도 scrub과 마스킹을 거친 값이다.
- 테스트 항목에는 다음도 넣는다. worker `message`의 세 경우(없음, 문자열이면 올리고 `fields`에서 뺌, 문자열이 아니면 `fields.message`에 남음). 필드가 `timestamp`·`level`·`event`를 덮지 못함(지금 `console-logger.test.ts:71-86`이 보는 것). 플랫폼의 `withContext` context는 최상위, 필드로 넘긴 `session_id`는 `fields.session_id`.

### 3.3 에러 기록 규칙

1. **로그의 에러는 문자열이다.** 새 로그는 `fields.error = messageOf(error)`로 쓴다. 이미 `reason` 같은 다른 이름으로 남기는 로그는 이름을 그대로 둔다. 이름을 바꾸는 것은 로그 필드 변경이다. `Error` 객체를 그대로 넣지 않는다. `sanitizeFields`는 객체의 열거 가능한 속성만 복사하는데 `Error`의 `message`·`stack`은 열거되지 않는다. 실측: `createLogger({sinks:[memory]}).error("Pass failed", { error: new Error("boom") })` → `"fields":{"error":{}}`.
2. **요청을 품는 외부 라이브러리 에러는 메시지를 남기지 않는다.** 클래스 이름(`error`)과 status, 있으면 요청 id(`github_request_id`)만 남긴다(`forge-github.ts:259-273`의 `quiet`). 메시지에 URL이나 헤더가 섞일 수 있어서다. 응답 본문의 이유(`github_reason`·`github_errors`, `:1130-1164`)는 요청에 호출자 값이 없는 호출에만 남긴다. 요청에 호출자 값이 들어가는 호출(workflow dispatch 입력 등)은 응답이 그 값을 되비칠 수 있으므로 `quiet` 경로로만 남긴다. 지금 예외가 하나 있다. PR 생성(`forge-github.ts:312-334`)은 세션이 정한 `title`·`body`를 보내면서도 실패를 `failure`로 남겨 응답 이유를 기록한다. 이 이유가 422 뒤 운영자가 원인을 읽는 유일한 단서이고(열린 PR과 경합하는 422는 `:328-331`이 먼저 복구한다), 값은 200자로 잘리고 마스킹을 거친다. 이 설계는 그 호출을 바꾸지 않는다. 바꾸면 던지는 에러가 `ForgeCredentialError`에서 `GitHubCallError`로 바뀌고 로그 필드도 바뀐다.
3. **code는 지금 있는 모양을 그대로 둔다.** `code`와 `reason`을 나눠 남기는 곳(`session-checkpoints.ts:334-338`)은 그대로다. worker heartbeat가 `<code>: <message>`로 붙이는 것(`heartbeat.ts:289-294`)도 그 호출에 한한 예외로 둔다. 어느 쪽이든 바꾸면 로그 필드가 바뀐다.
4. **stack은 프로세스나 자식 프로세스를 끝내는 마지막 catch에서만 남긴다.** `fields.stack = error instanceof Error ? error.stack : undefined`다. `Error`가 아닌 값을 throw했으면 stack이 없고 `fields.error`만 남는다. 마스킹 규칙이 stack 문자열에도 걸린다.
5. **`messageOf`는 한 곳에 둔다.** `@werft-ai/contracts`가 내보내고 `@werft-ai/platform`은 같은 이름으로 다시 내보낸다. 인라인 사본은 서버 프로세스가 로그나 에러 문장을 만드는 곳에서만 이것으로 바꾼다. `apps/egress-proxy`, `examples/`, `scripts/`, `packages/client`, `packages/contracts/src/shared/settings.ts`는 인라인으로 둔다.

### 3.4 `console.*` 직접 호출

오래 도는 역할(API, scheduler, reconciler, slack, metrics, worker, egress proxy)의 실행 경로에서는 `console.*`로 로그를 쓰지 않는다. 다음은 로그가 아니므로 예외다.

- 운영자 CLI의 결과와 거절 출력, 인자 오류(1.3절 표의 CLI 행)
- bootstrap token 출력(`auth.ts:214`). logger가 일부러 가리는 값이다
- Docker healthcheck의 실패 이유(`healthcheck.ts:74`)
- SDK가 사용자에게 보이는 경고(`packages/client`, `packages/core`)
- 개발 호스트에서만 나는 경고(`git-process.ts:50`)

## 4. proxy는 의존성 없는 이미지를 유지한다

proxy 이미지는 자기 디렉터리만 복사하고 아무것도 설치하지 않는다(`apps/egress-proxy/src/logger.ts:3-9`, `tests/images.test.ts`). 그래서 공통 logger를 import하지 않는다. 대신 두 가지로 맞춘다.

- **마스킹:** 지금처럼 `redaction.ts`의 바이트 단위 사본과 `apps/egress-proxy/src/logger.test.ts:8-15`의 비교 테스트.
- **레코드 모양:** 3.2절의 저장소 계약 테스트. proxy 쪽 코드는 바뀌지 않는다. proxy 줄은 이미 계약에 맞는다(`event`는 선택이고, `message`가 있다).

proxy 로그에 `event`를 더하는 일은 이 설계에 넣지 않는다. 지금 proxy 로그를 읽는 metric이 없고, 운영 문서는 proxy의 `message` 문장을 인용한다(예: `api-server.md:228`의 `"message":"Credential route"`).

## 5. 검토한 두 안

| | A. 한 모양으로 모으고 계약 테스트로 지킨다(고른 안) | B. 프로세스마다 모양을 두고 소비자를 맞춘다 |
|---|---|---|
| 하는 일 | worker 줄을 플랫폼 모양으로 바꾼다. 계약 테스트 하나가 세 logger를 지킨다 | worker 줄은 평평하게 둔다. Datadog 정의에서 worker 이벤트만 `@stage`·`@duration_ms`처럼 최상위 경로로 고친다. 프로세스별 모양을 문서에 적는다 |
| 바뀌는 로그 필드 | worker 줄 전부(필드가 `fields` 아래로, `message` 추가) | 없음 |
| 고칠 소비자 | d2-gate harness·테스트, soak 스크립트, `api-server.md:30` | Datadog metric 정의, `monitoring-datadog.md:63`, facet 목록 |
| 다음 사람이 한 파일만 보고 맞게 고치는가 | 맞다. 어느 프로세스든 `fields.<name>`이다(최상위는 `withContext`가 쓴 context 다섯 키뿐). 새 metric을 정의할 때 서비스를 확인할 필요가 없다 | 틀리기 쉽다. 같은 facet 이름이 서비스에 따라 `@fields.x`이거나 `@x`다. 이번 결함이 바로 이 모양에서 생겼다 |
| 크기 | 계약 S + worker M | S |

세 번째 안으로 **C. 수집할 때 고친다**(Datadog pipeline이 worker 줄의 최상위 필드를 `fields` 아래로 옮긴다)도 보았다. pipeline의 attribute remapper는 옮길 키를 이름으로 하나씩 받는다(`log-pipeline.json:38-49`). 그래서 worker가 새 필드를 찍을 때마다 pipeline 목록을 고쳐야 하고, 저장소 안 소비자(d2-gate, soak)는 여전히 평평한 줄을 읽는다. 옛 worker 줄을 살리는 것 말고는 얻는 것이 없다.

A를 고른다. B는 이번 결함을 고치지만 그 결함을 만든 갈림(서비스마다 다른 경로)을 남긴다. A의 소비자 수정은 저장소 안에서 끝나고, 저장소 밖 소비자는 Datadog뿐이다.

**롤아웃.** 저장소 안 소비자는 L2와 같은 PR에서 바뀐다. 다만 옛 모양의 줄을 읽는 경로가 둘 있다. soak의 `--judge <dir>`(`scripts/soak/soak.ts:2042-2090`)는 저장해 둔 실행의 worker 로그를 다시 읽고, d2-gate harness는 worker 이미지가 같은 커밋인지 강제하지 않는다(`tests/d2-gate/harness.ts:68-80`). 그래서 L2의 `readEngineStops`와 d2-gate의 worker 줄 읽기는 평평한 줄과 `fields` 줄을 모두 읽고, soak 테스트는 옛 fixture를 그대로 두고 새 모양·섞인 fixture를 더한다. Datadog은 다르다. 롤아웃 동안 옛 worker 이미지의 줄은 평평한 모양이고, 그 줄의 distribution 아홉은 지금처럼 비어 있다. 옛 worker가 다 내려간 뒤부터 값이 찬다. 지금 이미 비어 있으므로 롤아웃이 잃는 값은 없다.

## 6. 단계별 PR

| 단계 | 대상 | 바뀌는 로그 필드와 소비자 영향 | 선행 | 크기 |
|---|---|---|---|---|
| L1. 레코드 계약 테스트 | `packages/observability/src/record-contract.ts`(새 파일), `tests/log-record-contract.test.ts`(새 파일). worker는 알려진 예외로 적는다 | 없음 | 없음 | S |
| L2. worker 줄을 계약 모양으로 | `apps/worker/src/console-logger.ts`와 그 테스트, `tests/d2-gate/harness.ts`·`gate.e2e.test.ts`의 worker 필드 읽기(`event` 밖의 필드), `scripts/soak/soak.ts`의 `readEngineStops`와 `tests/soak/soak.test.ts:1006-1034`(옛 fixture는 두고 새 모양·섞인 fixture를 더한다. 두 파서는 두 모양을 모두 읽는다, 5절 롤아웃), `docs/operator/api-server.md:30`(`monitoring-datadog.md:63`의 `fields.stage`는 이 단계 뒤 코드와 맞는다). L1의 worker 예외를 지운다. L1 테스트에 3.2절의 worker 조건(scrub, `input_id`)을 더한다 | **바뀐다.** worker 줄의 최상위 필드(`session_id`, `turn_id`, `stage`, `duration_ms` 등 `timestamp`·`level`·`event`·`message` 밖의 모든 키)가 `fields.<같은 이름>`으로 옮겨 간다. `message`는 늘 생긴다: 호출이 넘긴 `message`가 문자열이면 scrub·마스킹을 거친 그 값을 최상위로 올리고 `fields`에서 뺀다(지금 하나, `worker.checkpoint.result`의 `"Checkpoint capture finished"`). 없거나 문자열이 아니면 최상위 `message`는 `event`와 같고, 문자열이 아닌 값은 `fields.message`에 남는다. 영향: Datadog worker metric 아홉과 monitor 8~11이 처음으로 값을 받는다(배포 공지에 적는다). 최상위 경로로 저장한 운영자 쿼리는 `@fields.`를 붙여야 한다. 롤아웃 동안 옛 worker 이미지의 줄은 옛 모양으로 남는다 | L1 | M |
| L3. `messageOf` 한 곳으로 | `packages/contracts/src/shared/`에 `messageOf`를 두고 `@werft-ai/contracts`가 내보낸다. `packages/platform/src/scheduler/pass-context.ts:141`은 그것을 다시 내보낸다. `apps/worker/src/message-of.ts`를 지우고 worker의 import를 `@werft-ai/contracts`로 바꾼다. 새 의존성은 없다(`tests/architecture.test.ts:999-1018` 그대로) | 없음(같은 문자열) | 없음 | S |
| L4. pass 자식의 실패를 구조화 로그로 | `apps/control-host/src/pass-loop/loop.ts:456-490` `servePasses`에 logger를 받게 하고(호출하는 `apps/control-host/src/main.ts:79-83`과 자식 fixture `pass-loop/loop.test.ts:424-434`도 고친다. 테스트는 자식 실패의 stdout JSON과 종료 코드를 본다) `console.error(error)`를 `logger.error("Pass child failed", { error: messageOf(error), stack: error instanceof Error ? error.stack : undefined })`로 | **바뀐다.** stderr의 평문 stack 대신 JSON 한 줄(`level: error`, `message: "Pass child failed"`, `fields.error`, `Error`일 때 `fields.stack`)이 생긴다. 이 출력을 읽는 소비자는 없다(2절) | L1, L3 | S |
| L5. 인라인 에러 문장을 `messageOf`로 | 서버 프로세스의 인라인 사본: `apps/control-host`, `apps/worker`, `packages/platform`, `packages/adapters`. 제외: `apps/egress-proxy`, `examples/`, `scripts/`, `packages/client`, `packages/contracts/src/shared/settings.ts`(3.3절 5) | 없음 | L3 | S |

L1과 L3은 서로 기다리지 않는다. L2는 Datadog을 쓰는 운영자에게 영향이 있으므로 PR 본문과 릴리스 노트에 바뀌는 경로를 적는다.

## 7. 하지 않는 것

- **공통 logger 패키지로 합치기.** proxy 이미지 경계(4절)를 깨고, worker의 `SecretScrubber` 같은 프로세스별 처리를 한 구현에 몰아넣는다.
- **플랫폼 로그 전부에 `event` 달기.** 260개 호출 중 metric이 읽는 것은 몇 개이고, 문장을 식별자로 쓰는 규칙(3.1절)과 Datadog fallback이 나머지를 받는다. 새 metric이 생길 때 그 로그에만 단다.
- **message 문장 바꾸기.** 62개를 문서·Datadog이 인용한다. 바꿀 때는 로그 필드 변경으로 다룬다.
- **proxy 로그 모양 바꾸기.** 이미 계약에 맞는다.
- **OTel·trace 연결.** `trace_id`를 채우는 일은 trace exporter를 들일 때 정한다([관측 문서](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/session-data-flow/)). 그 결정은 [관측(OTel) 방향과 도구 호출 감사](observability-otel-and-tool-call-audit.md)에 있다(`trace_id` 형식과 새 최상위 키 `span_id` 포함, 4.3절).
- **`uncaughtException`·`unhandledRejection` 처리기.** 잡히지 않은 예외는 지금 Bun의 기본 출력으로 남는다. 이것을 JSON으로 바꿀지는 그런 줄을 놓친 사고가 생길 때 다시 본다.
- **새 에러 타입·코드 체계.** API 오류 코드는 `packages/contracts/src/shared/error.ts`의 `API_ERROR_CODE_VALUES`가 정본이고, worker·proxy의 거절 코드도 각자의 계약에 있다. 이 문서는 그 에러를 로그에 남기는 방법만 정한다. 경계에서 에러를 바꾸는 규칙을 새로 만들 근거(같은 실패가 경계마다 다른 코드로 나가는 사례)는 이번 조사에서 찾지 않았다.
- **CLI 출력의 구조화.** 사람이 읽거나 다른 명령이 받는 출력이다(3.4절).
- **worker `LOG_LEVEL` 검사 통일.** worker는 틀린 값을 `info`로 받지만 scheduler가 검사한 값만 넘긴다(1.1절).
