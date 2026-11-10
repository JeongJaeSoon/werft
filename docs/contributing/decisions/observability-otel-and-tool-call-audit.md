# 결정(설계): 관측(OTel) 방향과 도구 호출 감사

- 상태: **설계.** 세션 관측 방향 결정 티켓의 결정 문서다. 이 문서가 머지되면 T1(tracer·trace_id)과 T2(API span)의 구현 계약이 된다. T번호는 이 결정을 낸 Linear 티켓(제목: 세션 관측(OTel) 방향 결정)의 구현 후보 번호이고, 8절이 각 티켓의 제목과 수용 기준을 옮겨 적는다. 저장소 시험(`tests/docs-links.test.ts`)이 문서에 티켓 키를 쓰지 못하게 하므로 키 대신 T번호와 제목으로 가리킨다. 코드, 마이그레이션, CI는 바꾸지 않는다.
- 기준 커밋: `origin/main` `3edfe7f78`. `파일:줄`은 모두 이 커밋 기준이다.
- 이어받는 결정: 티켓 본문에 옮겨 적힌 세션 관측 설계안의 D1(혼합: 이벤트는 DB 정본, 트레이스는 관측 신호), D2(내용 수집 기본 full), D6(1단계 span은 worker가 직접 만든다), D11(플랫폼은 OTLP 내보내기까지). 이 문서는 그 결정을 다시 열지 않고, 구현이 기댈 계약(포트, 이름, 설정 키, 감사 레코드)을 정한다. 설계안과 이 문서가 다르면 이 문서가 이긴다.
- 범위 밖: 외부 관측 백엔드의 운영(수집기 선택, 수집기 안의 보존 기간, 대시보드)은 운영자 몫이다. 이 문서는 exporter 계약(엔드포인트, 헤더, 샘플링 설정 키)까지만 정한다.

## 요약

| 항목 | 결정 |
|---|---|
| 신호 | 트레이스만 낸다(1단계). OTLP 로그·메트릭 신호는 내지 않는다. 로그는 지금처럼 stdout JSON이고 `trace_id`·`span_id`만 채운다 |
| 기본값 | 꺼짐. `OTEL_TRACES_EXPORTER`가 없거나 `none`이면 exporter를 만들지 않고 요청도 나가지 않는다 |
| 프로토콜 | `http/protobuf` 기본. gRPC는 1단계에서 받지 않는다 |
| tracer 포트 | `packages/observability`가 `Tracer` 인터페이스를 소유하고, `@opentelemetry/*`는 그 패키지의 어댑터 한 곳만 import한다. 꺼져 있으면 `noopTracer`가 들어간다 |
| trace_id | 요청 트레이스는 요청마다 새 root. turn 트레이스의 `trace_id`는 `session_id`와 공개 `turn_id`에서 계산한다. 로그에는 최상위 `trace_id`·`span_id`로 찍는다 |
| API span | 이름은 `{METHOD} {route_template}`. 클라이언트의 `traceparent`는 부모가 아니라 link다 |
| Langfuse | 대체하지 않고 **병행**한다. 앱 안에 Langfuse 전용 코드는 없고, Langfuse는 OTLP를 받는 수집기 한 종류다 |
| 도구 호출 감사 | 새 append-only 표 `tool_call_audits`. 호출 하나의 **주체·판정·근거**와 입력의 **sha256과 바이트 수**를 남긴다. **입력 원문과 요약은 이 표에 쓰지 않는다** |
| 보존 | 기존 `settings.audit_retention_days`(기본 90일, 30~3650일)를 그대로 쓴다. 새 설정 키는 없다 |
| 담당 모듈 | 새 포트 없이 platform의 `WorkerUnitOfWork.commitEventsAtomic` 입력에 감사 보고를 얹고(같은 트랜잭션), 표와 쓰기는 `packages/db`, 판정을 보고하는 쪽은 worker와 Claude adapter(`ToolDecisionObserver`)다 |

## 1. 지금 있는 것

### 1.1 OTel과 Langfuse

- **OTel은 없다.** 앱에는 `@opentelemetry/*` 직접 의존도 exporter도 없다. 로그 레코드의 `trace_id` 필드는 있지만(`packages/observability/src/index.ts:16-22`, `trace_id`는 `:21`) 채우는 곳이 없다. 이 사실은 [로그 레코드 계약](logging-contract.md)의 소비자 표가 이미 적고 있다.
- **Tracer는 한 번 있었다가 지워졌다.** 쓰이지 않던 observability `Tracer`는 "운영 호출처가 없는 코드와 스키마를 걷어낸다" 정리 티켓에서 걷어냈다. 지금 다시 넣는 이유는 이 문서의 계약이다.
- **앱에 Langfuse 연동 코드는 없다.** 저장소에서 Langfuse가 나오는 곳은 예제 수집기 compose(`infra/observability/langfuse/compose.yml`, `collector.yaml`)와 그것을 설명하는 문서(`apps/docs/content/docs/observability.mdx`, `…/operate/session-data-flow.mdx`)다. 예제는 werft와 따로 뜨고 운영 구성이 아니다. 앱은 Langfuse SDK를 import하지도 부르지도 않는다.
- **테스트 span 스크립트.** `infra/observability/send-test-span.sh`가 "앞으로 werft가 보낼 모양"의 가짜 트레이스(`werft.turn` 아래 `werft.llm_request`, `werft.tool`)를 보낸다. 5절의 span 이름은 이 모양과 같게 둔다.

### 1.2 도구 호출을 기록하는 곳 넷

| 기록 | 무엇을 담나 | 도구 호출 감사로 쓸 수 있나 |
|---|---|---|
| `events` 표(`tool_use`·`tool_result`) | 도구 이름, 입력과 결과 본문(마스킹 뒤). 세션을 볼 수 있는 주체만 읽는다. 무기한 보존이고 오래 쉰 세션은 object로 옮긴다([data-retention.md](../../operator/data-retention.md#내용이-남는-곳과-마스킹)) | **내용**의 정본이다. 판정과 근거가 없다. 도구가 허용돼서 돌았는지 거절됐는지 이벤트만으로는 가를 수 없다 |
| `tool_calls` 표(`packages/db/src/schema.ts:1764`) | 이름, 시각, `ok`·`failed`·`unknown`, 소요 시간. reconciler가 events에서 투영한다 | **아니다.** 집계용 투영이라 events에서 다시 만들 수 있다. 입력도 주체도 판정도 없다 |
| `authz_decisions` 표(`schema.ts:2036`) | API action(`session.approve`, `agent.manage` 등)에 대한 `allow`·`deny`·`redact`·`require_approval`, 주체, 근거(`reason_code`), `policy_version`. 90일 기본 보존([api-server.md](../../operator/api-server.md#판정-감사와-보존-기간)) | **아니다.** 한 행은 기록 대상으로 고른 `AuthorizationRequest`(API·Slack 입구의 action)에 대한 정책 판정이다. 주체는 사람, API key, 에이전트를 표현하지만 엔진 안에서 에이전트가 부른 도구는 `AuthorizationRequest`를 거치지 않는다 |
| `pending_requests` 표(`schema.ts:2096`) | 사람에게 물은 권한 요청과 질문. 묻는 데 쓴 `tool`·`tool_use_id`, 답한 사람 `answered_by`, 답한 곳 `answer_surface`, 그 판정 `answer_decision_id` | **일부.** 사람에게 **물은** 호출만 남는다. 묻지 않고 허용·거절된 호출은 남지 않는다 |

빈 곳은 이렇다. 신뢰된 도구(`trustedTools`)나 `bypassPermissions`·`auto` 모드로 **묻지 않고 허용된** 호출, 허용 목록 밖이거나 `disallowedTools`·hook으로 **거절된** 호출, 그리고 이 둘의 근거를 남기는 곳이 없다. 이 판정의 대부분은 worker 안의 Claude adapter가 내리고, 관찰할 수 있는 자리는 `canUseTool`(`packages/adapters/runtimes/claude/src/runtime.ts:176`)과 `PreToolUse` hook(`:230`)이다. 하지만 전부는 아니다. `auto`·`bypassPermissions` 모드는 허용한 호출에서 `canUseTool`을 부르지 않고(`:148`), 세션 규칙이 통과시킨 호출도 마찬가지이며, 메모리만 읽는 호출은 사람에게 묻지 않고 허용한다(`:192`). 엔진 안에서 일어나 adapter가 보지 못하는 판정은 7.3.2절에서 추측하지 않는 값(`unknown`)으로 기록한다. 도구 호출 감사는 담당 모듈도 티켓도 없었다.

### 1.3 원격 MCP

`mcp_servers`(DB 행)와 MCP egress가 있다([api-server.md](../../operator/api-server.md#원격-mcp-서버)). 서버는 streamable HTTP 하나이고, worker는 서버 URL도 자격 증명도 받지 않고 proxy의 `/mcp/<name>` route로 부른다. 도구 단위 차단은 없다. 엔진은 이 도구를 `mcp__<server>__<tool>` 이름으로 부르고(`packages/adapters/runtimes/claude/src/config.ts:114`), 그 호출은 다른 도구와 똑같이 `tool_use` 이벤트로 남는다. 그래서 감사 레코드는 MCP 호출을 따로 다루지 않고 이름으로 구분한다(7.4절).

## 2. OTel 채택 범위

### 2.1 무엇을 trace하고 무엇을 안 하나

| 대상 | trace | 이유 |
|---|---|---|
| API 요청(`/v1/**`) | **한다.** HTTP span | 5절 |
| worker gateway 요청(`/internal/**`) | **부모가 올바를 때만 한다.** 5.3절 | 빈도가 높다 |
| turn 하나 | **한다.** worker가 만드는 `werft.turn` 트레이스 | D6 |
| 모델 호출, 도구 실행, 권한 대기, 질문 대기, checkpoint | **한다.** `werft.turn` 아래 span | T3 |
| DB 쿼리 | 안 한다 | 건수가 많고, 요청 span의 소요 시간으로 충분하다 |
| scheduler·reconciler pass | 안 한다 | 장기 실행 loop라 한 trace가 끝나지 않는다. 구조화 로그와 Datadog metric이 이미 읽는다 |
| egress proxy | 안 한다 | 이미지가 의존성 없이 뜨는 경계를 지킨다([로그 계약 4절](logging-contract.md#4-proxy는-의존성-없는-이미지를-유지한다)) |
| 엔진 CLI 자체 telemetry | 안 한다(2단계 T11에서 선택) | 스파이크에서 CLI의 OTLP 전송이 egress proxy에 막혔고, 권한 결정이 `unknown`으로 찍혔고, 답변이 로그 신호로만 나갔다 |
| OTLP 로그·메트릭 | 안 한다 | 내용은 span 속성(`gen_ai.*`)에 실리므로 로그 저장소가 필요 없다. 지표는 에픽의 지표 티켓이 따로 낸다 |

### 2.2 트레이스가 하지 않는 일

트레이스는 best effort 관측 신호다. 세션 화면, SSE 재연결, turn 종료 판정, 질문 알림, 복구 판정은 계속 DB `events`가 정본이다. 트레이스가 빠져도 플랫폼의 기록과 동작은 그대로여야 하고, 트레이스를 복구 판단의 근거로 쓰지 않는다. 도구 코드도 세션 credential로 ingest를 직접 부를 수 있으므로 같은 세션 안의 위조는 트레이스로 막지 못한다(T4 보안 절).

### 2.3 Langfuse와의 관계: 병행

| 안 | 결정 | 이유 |
|---|---|---|
| A. 앱에 Langfuse SDK를 넣고 Langfuse 전용 span을 낸다 | **기각** | 벤더 종속이고, 수집기별 변환(`TRACE_BACKEND_PROFILE`)을 뺀 D11과 어긋난다 |
| B. Langfuse를 OTLP 수신기 하나로 취급한다(병행) | **채택** | 표준 OTLP로 내보내므로 Langfuse, Grafana Tempo, Datadog(OTLP 수신)이 같은 경로다. Langfuse에서 쓸 속성이 더 필요하면 운영자가 수집기 앞단에서 바꾼다 |
| C. 지금의 예제 compose를 지우고 Langfuse로 통일 | **기각** | 예제는 수집기를 띄워 보는 용도이고, 지우면 "OTLP를 받는 쪽을 미리 띄워 본다"는 확인 수단이 사라진다 |

"대체"가 아니라 병행인 이유는, 지금 Langfuse를 쓰는 앱 코드가 없어서 바꿀 것이 없다는 점이다. 콘솔에서 Langfuse 주소·key를 입력하는 화면은 OTLP 엔드포인트·헤더 설정의 한 종류로 X1이 맡는다. 이 문서의 설정 키가 그 화면의 서버 쪽 계약이다.

## 3. tracer 포트

### 3.1 위치와 방향

```text
packages/observability/src/
  tracing/
    tracer.ts        // Tracer, Span, SpanContext, noopTracer, currentSpanContext, traceparent 함수  (import 없음)
    otel-tracer.ts   // @opentelemetry/* 를 import하는 유일한 파일. Tracer를 구현한다
  index.ts           // Tracer 타입과 noopTracer를 내보낸다. otel-tracer는 내보내지 않는다
```

`packages/observability/package.json`의 `exports`는 지금 `"./src/index.ts"` 하나다. T1가 이것을 맵으로 바꿔 `"."`(위 index)와 `"./otel"`(= `src/tracing/otel-tracer.ts`) 두 입구를 낸다. `./otel`이 `createOtelTracer(config: OtelTracerConfig): Tracer & { shutdown(): Promise<void> }`를 내보내고, 조립 지점(control-host 기동, worker 기동)만 이 입구를 import한다. `OtelTracerConfig`는 6절 키를 파싱한 값(엔드포인트, 프로토콜, 헤더, 테넌트 해석 함수, sampler)이고, exporter를 바꿔 끼울 수 있도록 `exporter?: SpanExporterLike`(SDK의 `SpanExporter`와 구조가 같은 최소 인터페이스)를 받는다. worker는 이 자리에 ingest로 보내는 exporter를 넣는다.

- **쓰는 쪽이 여럿이라 소유자는 가장 낮은 공용 패키지다.** tracer를 직접 부르는 곳은 control-host(요청 미들웨어), worker, Claude adapter다. `packages/db`는 이미 `observability`에 의존하고(`packages/db/package.json`), 어댑터에도 허용된다(열린 PR JeongJaeSoon/werft#1498의 규칙 R2: 어댑터는 `platform`, `contracts`, `observability`, `storage`에 의존할 수 있다). `observability`는 workspace 의존이 없는 말단이다. 그래서 인터페이스를 `platform`에 두지 않고 `observability`에 둔다.
- **platform은 `Tracer`를 import하지 않는다.** `tests/architecture.test.ts`의 "platform depends on contracts, runtime-core and zod only"(`:1057`)는 그대로 둔다. turn을 큐에 넣을 때 필요한 것은 tracer가 아니라 저장할 문자열이므로, control-host가 요청 span의 `traceparent` 문자열을 turn 큐 입력(`enqueueWithin`, `packages/db/src/enqueue.ts`)에 데이터로 넘기고 platform은 이를 통과시키기만 한다. 이 규칙을 바꾸는 PR은 이 설계에 없다.
- **SDK는 어댑터 뒤에 가둔다(의존성 역전).** `@opentelemetry/*`를 import하는 파일은 `otel-tracer.ts` 하나다. 서비스 코드는 `Tracer`만 안다. 조립 지점이 `OTEL_TRACES_EXPORTER`에 따라 `createOtelTracer(...)` 또는 `noopTracer`를 넘긴다.
- **새 의존성은 필요한 만큼만.** `@opentelemetry/api@1.9.0`은 이미 전이 의존이다. 어댑터는 공식 SDK(`sdk-trace-base`와 `exporter-trace-otlp-proto`)를 쓰고, OTLP protobuf 직렬화를 직접 쓰지 않는다. 직접 쓰는 안은 기각한다. 프로토콜 기본값이 `http/protobuf`이고 재시도·배치·압축을 다시 만드는 비용이 의존성 하나보다 크다.

### 3.2 인터페이스 (T1가 구현)

```ts
// packages/observability/src/tracing/tracer.ts — no imports, like redaction.ts
export interface SpanContext {
  readonly traceId: string; // 32 lowercase hex
  readonly spanId: string; // 16 lowercase hex
  readonly sampled: boolean;
}

export type SpanAttributeValue = string | number | boolean;

export interface Span {
  readonly context: SpanContext;
  setAttribute(key: string, value: SpanAttributeValue): void;
  /** Marks the span failed. `message` is a redacted string, never an Error object. */
  setError(message: string): void;
  end(): void;
}

export interface StartSpanOptions {
  readonly kind?: "server" | "client" | "internal";
  readonly attributes?: Readonly<Record<string, SpanAttributeValue>>;
  /** Spans this one is related to without being their child. */
  readonly links?: readonly SpanContext[];
  /** Parent given explicitly; omitted means the active span, "root" forces a new root. */
  readonly parent?: SpanContext | "root";
  /** A trace id chosen by the caller, for `werft.turn` only (4.2절). */
  readonly traceId?: string;
}

export interface Tracer {
  /** Runs `fn` with the new span active; ends it, and marks it failed if `fn` throws. */
  withSpan<T>(name: string, options: StartSpanOptions, fn: (span: Span) => Promise<T>): Promise<T>;
}

/** The span active in the current async context, if any. Logger reads this. */
export function currentSpanContext(): SpanContext | undefined;
export function formatTraceparent(context: SpanContext): string; // 00-<trace>-<span>-01|00
export function parseTraceparent(value: string): SpanContext | undefined;
export const noopTracer: Tracer;
```

- `noopTracer`는 span을 만들지 않고 `fn`을 그대로 부르는 **진짜 구현**이다. 꺼진 상태의 동작이고, 던지는 빈 구현이 아니다. `currentSpanContext()`는 꺼져 있으면 `undefined`다.
- 인터페이스는 작게 둔다(ISP). 시작 방식은 `withSpan` 하나다. 호출자가 `end()`를 빠뜨려 span이 새는 길을 `withSpan`이 막는다. worker의 권한 대기처럼 시작과 끝이 다른 콜백에 있는 span이 생기면 그때 `startSpan`을 더한다(YAGNI). 샘플링, 배치, exporter는 인터페이스에 없고 어댑터의 일이다.
- Bun에서 `AsyncLocalStorage` 기반 context가 `await`·`setTimeout`을 지나도 유지되는지는 T1의 인수 조건이다. 유지되지 않으면 `currentSpanContext()`를 쓰는 로그가 틀리므로 이 인터페이스가 의존하는 전제다.

### 3.3 exporter와 테넌트 분리

- API의 어댑터는 span 종료 때 워크스페이스별로 batch를 나눠 OTLP/HTTP로 보낸다. 테넌트 헤더나 키는 batch 단위로 붙인다. 워크스페이스가 없는 span(인증 전 요청)은 `TRACE_INSTALL_TENANT`로 보낸다.
- worker의 어댑터는 같은 `Tracer`를 구현하되 exporter가 다르다. worker는 수집기 credential을 갖지 않으므로(엔진의 도구가 worker 프로세스 환경을 읽을 수 있다는 `apps/worker/src/secret-scrubber.ts:15-47`의 전제) API 안의 telemetry ingest(T4)로 보낸다.
- 속성 필터는 테넌트 분리 수단이 아니다. 분리는 batch 단위 헤더가 한다.

### 3.4 도구 호출 감사는 새 포트 없이 기존 unit-of-work에 얹는다

감사 행은 worker의 이벤트 append와 같은 트랜잭션에 있어야 하므로 별도로 조립한 sink를 부르는 방식은 쓰지 않는다. 쓰는 레이어가 platform 하나이고 트랜잭션은 이미 platform이 소유한 `WorkerUnitOfWork`의 `commitEventsAtomic`이 연다. 감사 입력은 그 포트의 입력에 데이터로 실린다. 7.6절.

## 4. trace_id와 로그 필드

### 4.1 트레이스 두 종류

| | 요청 트레이스 R | turn 트레이스 T |
|---|---|---|
| 만드는 곳 | API 요청 미들웨어 | worker(T3) |
| trace_id | 요청마다 새로 뽑는다 | `SHA-256("werft.turn:" + session_id + ":" + turn_id)`의 앞 16바이트(소문자 hex 32자) |
| 부모 | 없다(항상 새 root) | 없다. root `werft.turn`이 R의 span과 같은 attempt의 이전 turn에 link한다 |

turn의 `trace_id`를 계산해서 얻는 이유는 API, worker, ingest가 서로 값을 주고받지 않고도 같은 값을 얻고, ingest가 "이 attempt가 받은 turn에서 나온 trace_id가 아니면 버린다"는 검사를 상태 없이 할 수 있어서다(T4).

**입력은 `session_id`와 공개 `turn_id`를 함께 쓴다.** 공개 `turn_id`는 DB 전역 id가 아니라 **세션 안의 1부터 시작하는 순번**이다(`packages/db/src/schema.ts:1531` 주석). 티켓 본문(T4, T3)의 `SHA-256("werft.turn:" + turn_id)`는 모든 세션의 첫 turn을 같은 `trace_id`로 만든다. 이 문서가 식을 바로잡는다. 구현은 `turnTraceId(sessionId: string, turnId: number): string` 한 함수를 `packages/observability`(import 없음)에 두고 API·worker·ingest가 같은 함수를 쓴다. `session_id`는 소문자 UUID 문자열이다. 계약 시험 벡터:

```text
turnTraceId("00000000-0000-4000-8000-000000000001", 1) = "49195af5635b4ac7af24c52c73de7491"
```

### 4.2 전파

1. 클라이언트의 `traceparent`는 **부모로 삼지 않고 link로만 남긴다.** link는 `trace_id`·`span_id`만 싣는다. `tracestate`는 버린다(`SpanContext`가 담지 않고, 벤더 상태를 우리 트레이스에 옮길 이유가 없다). 들어온 sampled 플래그도 따르지 않는다. 클라이언트가 `trace_id`를 골라 다른 세션 트레이스에 섞거나 `-00`으로 API span을 끄는 일을 막기 위해서다.
2. `POST /v1/sessions/{id}/turns`가 turn을 큐에 넣을 때 그 요청 span의 `traceparent`를 `turns.trace_context`(nullable text)에 같은 트랜잭션으로 쓴다(T2).
3. `nextInput` 응답의 `input`에 선택 필드 `trace_context`와 `content_mode`가 실린다. worker는 `trace_context`를 `werft.turn`의 link로 쓰고 `content_mode`는 turn마다 다시 읽는다. 필드가 없는 예전 worker는 그대로 동작한다(`packages/contracts/src/worker-protocol/index.ts:685`의 `nextInputResponseSchema`). T5의 claim telemetry와 같은 필드를 정의하므로 **먼저 머지되는 쪽이 contracts에 정의하고 다른 쪽이 그것을 쓴다.**
4. worker가 gateway를 부를 때 `traceparent`를 붙인다. API는 그 값의 `trace_id`가 이 attempt의 turn `trace_id`(`turnTraceId(session_id, turn_id)`)일 때만 그 span을 부모로 삼고, 아니면 **span을 만들지 않는다**(5.3절). 새 root를 만들지 않는다.

### 4.3 로그 필드

`trace_id`는 [로그 레코드 계약](logging-contract.md) 3.1절 레코드의 최상위 키로 이미 있다. 이 문서가 정하는 것은 다음이다.

| 필드 | 형식 | 채우는 방법 |
|---|---|---|
| `trace_id` | 소문자 hex 32자 | `currentSpanContext()`의 `traceId` |
| `span_id` | 소문자 hex 16자. **새 최상위 키** | `currentSpanContext()`의 `spanId` |

- 활성 span 안에서 남긴 로그에만 채운다. span 밖이거나 꺼져 있으면 **키를 쓰지 않는다**(`"0000…"`을 채우지 않는다).
- `StructuredLogger#withContext`로 한 번 박아 두지 않는다. context는 요청 시작 때 정해지지만 span은 요청 안에서 바뀌므로, 로그를 쓰는 순간 `currentSpanContext()`를 읽는다.
- 이것은 **로그 필드 변경**이다. 로그 계약의 최상위 키가 열 개에서 열한 개가 되고, 계약 검사(`LOG_RECORD_KEYS`)와 계약 표에 `span_id`가 들어간다. 이 갱신은 T1 PR이 로그 계약 문서와 함께 한다. 기존 소비자(Datadog pipeline, d2-gate, soak)는 최상위 키를 이름으로 읽으므로 새 키가 있어도 깨지지 않는다.
- Datadog의 로그-트레이스 연결에는 pipeline 쪽 attribute 매핑이 따로 필요하다. 이 문서의 범위가 아니고, 필요하면 운영 쪽 변경으로 다룬다.
- worker 줄은 [로그 계약](logging-contract.md) L2(worker 줄을 계약 모양으로) 뒤에 같은 최상위 키를 쓴다. L2 전에는 worker의 `trace_id`·`span_id` 채우기를 하지 않는다. proxy는 채우지 않는다.
- 응답 헤더로 `trace_id`를 돌려주지 않는다. 사람이 요청에서 트레이스를 찾을 길은 span 속성 `werft.request_id`(= `X-Request-Id`, `apps/control-host/src/api/app.ts:471`)다.

## 5. API span 규칙 (T2이 구현)

### 5.1 이름과 속성

| 항목 | 규칙 |
|---|---|
| 이름 | `{METHOD} {route_template}`. 예: `POST /v1/sessions/:id/turns`. 라우트가 맞지 않은 요청은 `{METHOD}`만 쓴다. 경로의 실제 값(세션 id 등)은 이름에 넣지 않는다 |
| kind | `server` |
| 항상 붙이는 속성 | `http.request.method`, `http.route`(= route template), `http.response.status_code`, `werft.request_id` |
| 알게 된 뒤 붙이는 속성 | `werft.workspace_id`, `werft.session_id`(인증·경로 해석 뒤) |
| 상태 | 5xx면 error, 4xx는 error로 표시하지 않는다(서버 span 관례). `error.type`에 `http_<status>` |
| 부모 | 항상 새 root. 들어온 `traceparent`는 link |
| sampler | 들어온 sampled 플래그를 따르지 않는다. 설정이 정한다(6절) |

**절대 붙이지 않는 속성:** `url.full`, `url.query`, 요청·응답 헤더(`Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key` 포함), 요청·응답 본문, 클라이언트 IP, `user_agent.original`. 세션 id 같은 값은 경로가 아니라 위의 `werft.*` 속성으로만 싣는다.

### 5.2 span 이름의 turn 쪽 계약

worker가 만드는 span의 이름은 T3가 정한다. 이 문서는 예제 스크립트(`infra/observability/send-test-span.sh`)가 이미 보내는 이름 `werft.turn`, `werft.llm_request`, `werft.tool`을 바꾸지 않는다는 것과, 모든 span에 `werft.attempt_id`를 붙이고 resource에 `werft.execution_id`·`werft.attempt_id`·`werft.execution_generation`을 찍는다는 것만 정한다.

### 5.3 어떤 요청을 trace하나

- `/v1/**`는 모두 trace한다.
- `/healthz`, `/readyz`, `/metrics`는 trace하지 않는다.
- worker gateway(`/internal/**`)는 이미 요청 완료 로그가 빈도 때문에 5xx만 남긴다(`apps/control-host/src/api/app.ts:477`의 주석). 같은 이유로 **gateway 요청에는 하나의 규칙만 쓴다: 이 attempt의 turn `trace_id`를 가진 `traceparent`가 있으면 그 span의 자식 span을 만들고, 없거나 다른 `trace_id`면 span을 만들지 않는다.** 새 root를 만드는 경우는 없다(4.2절 4항과 같은 규칙). 이 규칙은 응답이 5xx여도 같다. 실패한 gateway 호출은 구조화 로그(`api.request.completed`가 5xx를 남긴다)와 worker 쪽 span이 이미 보여 준다.
  - 이것은 T2 본문과 다른 결정이다. 본문의 인수 조건 "이 attempt의 turn trace_id가 아닌 `traceparent`를 단 gateway 요청은 새 root가 된다"와 "API가 요청마다 HTTP span"은 이 규칙으로 바꾼다(8절의 T2). heartbeat와 next-input long-poll이 요청마다 root를 만들면 수집기로 가는 span의 대부분이 가치 없는 span이 되기 때문이다. 이 빈도 판단은 측정이 아니라 로그 정책(`apps/control-host/src/api/app.ts:477`의 주석)에서 온 추정이므로, T2 PR이 한 번 측정해 틀렸으면 이 절을 고친다.

## 6. 설정 키

api 서비스만 읽는다. **worker와 엔진의 환경에는 표준 `OTEL_*` 키를 넘기지 않는다.** 표준 키를 다른 뜻으로 쓰면 자동 설정 라이브러리가 `localhost:4318`로 내보내는 식으로 오작동한다. worker는 bootstrap claim의 `telemetry`와 `nextInput`으로만 설정을 받는다.

| 키 | 기본값 | 뜻 |
|---|---|---|
| `OTEL_TRACES_EXPORTER` | `none` | `none` 또는 `otlp`. `none`이면 claim의 `telemetry.enabled`도 false |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | 없음 | 수집기 주소. `otlp`인데 둘 다 없으면 시작 시 이름을 밝힌 오류로 멈춘다 |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | 1단계는 이 값과 `http/json`만 받는다. gRPC 값은 시작 시 거절한다 |
| `OTEL_EXPORTER_OTLP_HEADERS` | 없음 | **비밀.** env 파일로만 준다. 로그·오류 메시지에 값을 쓰지 않는다 |
| `OTEL_SERVICE_NAME` | `werft-api` | `service.namespace=werft`를 함께 찍는다 |
| `OTEL_RESOURCE_ATTRIBUTES` | 없음 | 운영자가 더하는 resource 속성 |
| `OTEL_TRACES_SAMPLER` | `always_on` | `always_on`, `always_off`, `traceidratio`만 받는다 |
| `OTEL_TRACES_SAMPLER_ARG` | `1.0` | `traceidratio`의 비율(0~1) |
| `TRACE_CONTENT_MODE` | `full` | 설치 상한: `full` 또는 `metadata`. 워크스페이스 설정은 이 상한 **안에서 낮추기만** 한다 |
| `TRACE_CONTENT_MAX_BYTES` | `32768` | 내용 속성 하나의 UTF-8 바이트 상한. 넘으면 자르고 `werft.truncated.<키>`에 원래 바이트 수를 붙인다 |
| `TRACE_TENANT_HEADER` | 없음 | 예: `X-Scope-OrgID: <workspace id>` |
| `TRACE_TENANT_HEADERS_FILE` | 없음 | 워크스페이스별 헤더 맵. 비밀을 담으므로 mode 600 파일만 받는다 |
| `TRACE_INSTALL_TENANT` | 없음 | 워크스페이스가 없는 span의 테넌트 |
| `TRACE_INGEST_PORT` | `4319` | worker용 ingest listener 포트 |
| `TRACE_INGEST_MAX_REQUEST_BYTES` | `4194304` (4MiB) | ingest 요청 본문 상한. 공개 API의 상한(`REQUEST_BODY_MAX_BYTES * 2`, `apps/control-host/src/api/server.ts:1443`)은 바뀌지 않는다 |
| `TRACE_INGEST_MAX_BYTES_PER_MIN` | `33554432` (32MiB) | attempt당 분당 상한 |
| `TRACE_MAX_BYTES_PER_TRACE` | `20971520` (20MiB) | 트레이스당 상한 |
| `TRACE_FENCED_GRACE_SEC` | `300` | fence를 막 잃은 attempt의 데이터를 받는 시간 |

- **꺼진 기본 설치에서는 아무것도 바뀌지 않는다.** 세션 화면, SSE, finalize 동작과 외부로 나가는 요청이 그대로다.
- 이름은 표준 `OTEL_*`와 플랫폼 키(`TRACE_*`)로 나눈다. 수집기별 변환 키(`TRACE_BACKEND_PROFILE`)는 두지 않는다(D11).
- 위 표에서 설계안과 다른 것은 **샘플링 쪽 둘**이다. `traceidratio`와 `OTEL_TRACES_SAMPLER_ARG`를 받는다. turn 트레이스의 `trace_id`가 결정적이므로 비율 판정을 API와 worker가 같은 값으로 내릴 수 있어서, 한 turn의 span이 일부만 사라지지 않는다. 판정은 `trace_id`의 뒤 8바이트를 big-endian 부호 없는 64비트 정수 `x`로 읽어 `x < floor(ratio × 2^64)`이면 기록한다(`ratio=1`이면 항상, `0`이면 항상 아님). 시험 벡터: `trace_id=00000000000000000000000000000000`은 `ratio=0.5`에서 기록, `ffffffffffffffffffffffffffffffff`는 `ratio=0.5`에서 기록하지 않는다. worker가 같은 판정을 하도록 claim의 `telemetry`에 `sampler`(`always_on`|`always_off`|`traceidratio`)·`sampler_arg`(number, 0~1)가 실린다(T5 범위에 더한다). 이 두 필드는 선택이고, 없는 claim(예전 API)은 `always_on`으로 읽는다.
- **엔드포인트.** `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`가 있으면 그 URL 그대로 쓴다. 없고 `OTEL_EXPORTER_OTLP_ENDPOINT`만 있으면 표준 OTel 규칙대로 뒤에 `/v1/traces`를 붙인다. 둘 다 있으면 앞의 것이 이긴다. 스킴은 `http`·`https`만 받는다.
- **테넌트 헤더.** `TRACE_TENANT_HEADER`는 `<헤더 이름>: <값 틀>` 한 줄이고 값 틀의 `{workspace_id}`를 워크스페이스 id로 바꾼다(예: `X-Scope-OrgID: {workspace_id}`). `TRACE_TENANT_HEADERS_FILE`은 JSON 객체 `{"<workspace_id>": {"<헤더 이름>": "<값>"}}`이고 mode 600이 아니면 시작 시 거절한다. 같은 헤더 이름이 겹치면 파일 → `TRACE_TENANT_HEADER` → `OTEL_EXPORTER_OTLP_HEADERS` 순으로 앞의 것이 이긴다. 워크스페이스가 파일에 없으면 `TRACE_TENANT_HEADER`로 만들고, 둘 다 없으면 테넌트 헤더 없이 보낸다(단일 테넌트 설치). 워크스페이스가 없는 span은 `TRACE_INSTALL_TENANT`를 `{workspace_id}` 자리의 값으로 쓴다.
- 시작할 때 OTLP 엔드포인트 호스트가 `EGRESS_PRIVATE_ALLOWLIST`에 있으면 경고를 한 번 남긴다(T5). 수집기 주소를 worker의 egress 허용 목록에 넣지 않는다. worker는 수집기로 직접 가지 않는다.
- **D2의 `full` 기본값은 내보내기를 켠 설치에서만 뜻이 있다.** 기본 꺼짐이므로 키를 하나도 주지 않은 설치는 내용을 어디에도 보내지 않는다. 켠 설치에서 `full`이면 마스킹을 거친 프롬프트·답변·도구 입출력이 운영자가 고른 수집기로 간다. 워크스페이스가 낮출 수 있고 설치 상한(`TRACE_CONTENT_MODE=metadata`)이 그 위에 있다.

## 7. 도구 호출 감사

### 7.1 결정 요약

1. **새 표를 만든다.** `tool_call_audits`: append-only, 호출 하나의 판정마다 한 행.
2. 기존 `tool_calls`를 늘리지 않는다. `authz_decisions`에 섞지 않는다.
3. **입력은 sha256과 바이트 수만 남긴다.** 원문도 요약도 이 표에 쓰지 않는다.
4. 주체는 워크스페이스·세션·turn·attempt·에이전트·릴리스·요청한 사람/키·표면까지 id로 남긴다. 이름·이메일은 남기지 않는다.
5. 판정은 `allow`·`deny`·`require_approval`·`unknown` 네 값과 근거 코드로 남긴다.
6. 보존은 `audit_retention_days`를 그대로 쓴다.

### 7.2 왜 새 표인가

| 안 | 결정 | 이유 |
|---|---|---|
| A. `tool_calls`에 열을 더한다 | **기각** | 그 표는 reconciler가 events에서 다시 만드는 **투영**이다(`schema.ts:1764` 주석). 다시 만들 수 있는 표에 잃으면 안 되는 판정을 넣으면, 투영을 다시 돌릴 때 감사 기록이 사라진다. 또 보존 정책이 없는 집계 표라 기간이 지나면 지우는 감사 정책과 맞지 않는다 |
| B. `authz_decisions`에 행을 더한다 | **기각** | 그 표의 한 행은 `AuthorizationRequest`(주체, action, 자원)에 대한 정책 판정이다. 도구 호출은 `action`·`resource_kind` 체계에 들어가지 않고, `authorize()`를 거치지 않는다. 억지로 넣으면 호출마다 가짜 action을 만들어야 하고 `policy_version`이 거짓이 된다 |
| C. `events`의 `tool_use` payload에 판정을 더한다 | **기각** | `events`는 SSE로 나가는 공개 계약이다. 판정과 근거를 거기 실으면 공개 이벤트 스키마가 바뀌고, 사람이 읽는 타임라인과 감사 기록의 보존 정책이 묶인다 |
| D. 새 표 `tool_call_audits` | **채택** | 쓰는 이유와 읽는 이유가 같은 한 표. `authz_decisions`와 같은 모양의 안전장치(append-only trigger, 보존 정리)를 그대로 쓴다 |

### 7.3 레코드

```text
tool_call_audits   (append-only: UPDATE는 trigger가 거절한다, authz_decisions_append_only와 같은 방식)

id                uuid  PK
at                timestamptz NOT NULL default now()
workspace_id      uuid        -- 워크스페이스에 묶이지 않은 legacy key 세션은 null
owner_id          text NOT NULL
session_id        uuid NOT NULL
turn_id           bigint NOT NULL
attempt_id        text NOT NULL
call_key          text NOT NULL   -- worker가 붙이는 호출 키: 유효한 tool_use_id면 "t:<id>", 아니면 "n:<turn 안의 순번>" (이름 공간이 달라 서로 충돌하지 않는다. 최대 130자 = 접두사 2 + id 128)
phase             text NOT NULL   -- asked | decided   (CHECK). 호출 하나의 판정 단계
tool_use_id       text        -- 엔진이 준 id. 7.4절의 문자 규칙에 안 맞으면 null
parent_tool_use_id text       -- 서브에이전트 안의 호출이면 바깥 tool_use의 id (같은 규칙)
tool_name         text NOT NULL   -- 7.4절의 규칙으로 걸러진 이름
mcp_server        text        -- tool_name이 mcp__<server>__<tool>이면 <server>, 아니면 null
input_sha256      text        -- 7.5절. require_approval 행은 null
input_bytes       integer     -- 마스킹된 정규형 입력의 UTF-8 바이트 수
decision          text NOT NULL   -- allow | deny | require_approval | unknown   (CHECK)
basis             text NOT NULL   -- 7.3.2절의 닫힌 목록 (검증은 contracts의 zod)
agent_id          uuid
agent_release_id  text
actor_user_id     uuid        -- 이 turn을 시킨 사람(turns.actor_id)
principal_kind    text        -- 세션을 만든 주체: user | api_key | agent ...
principal_id      text        --  (authz_decisions와 같은 CHECK: 둘 다 null이거나 둘 다 있다)
surface           text        -- SurfaceKind(web | slack | api, contracts/src/kollegium/surfaces.ts:20). 판정할 수 없는 legacy 행은 null
pending_request_id text       -- 사람에게 물은 호출이면 pending_requests.request_id
answered_by       jsonb       -- 사람이 답한 호출이면 pending_requests.answered_by의 복사본
answer_surface    text
answer_decision_id uuid       -- session.approve 판정(authz_decisions.id). FK 없음
source            text NOT NULL   -- platform | worker_report
record_version    integer NOT NULL  -- 이 레코드 모양의 버전(1). authz_decisions의 policy_version과 별개다
```

유일 키는 `(session_id, attempt_id, turn_id, call_key, phase)`이고 (turn마다 순번이 다시 시작하므로 `turn_id`가 들어간다) 삽입은 `ON CONFLICT DO NOTHING`이다(재전송 멱등성, 7.7절). 인덱스는 `(session_id, at)`, `(workspace_id, at)`, `(at)`(보존 정리용)이다. 외래 키는 두지 않는다. `authz_decisions`처럼 세션·키·사용자가 사라져도 행이 보존 기간 동안 남아야 한다.

#### 7.3.1 주체

- 워크스페이스·에이전트·릴리스·요청한 사람(`actor_user_id`)·세션을 만든 주체·표면은 **API가 DB에서 채운다.** worker가 보고하는 값이 아니다. 표면은 turn의 `channel`, 없으면 세션의 `channel`에서 `SurfaceKind`로 옮기고(두 열 모두 nullable, `schema.ts:1297`·`:1548`), 옮길 수 없으면 null이다. worker 보고에서 오는 것은 `call_key`, 도구 이름, `tool_use_id`, 입력 해시·바이트 수, 판정과 근거, 승인 관련 두 값(`pending_request_id`, `approval_input_hash`)이다.
- 사람이 답한 호출의 `answered_by`·`answer_surface`·`answer_decision_id`는 **`pending_requests`에서 복사한다.** worker가 보낸 값을 쓰지 않는다.
- **승인 근거는 API가 검증한다.** 근거가 `approval`·`approval_denied`·`approval_expired`·`approval_cancelled`인 보고는 다음이 모두 맞아야 그 근거로 기록한다. ① `pending_request_id`의 행이 같은 세션의 permission 요청이다. ② 행의 `tool`이 보고한 도구와 같다. ③ 행의 `input_hash`가 보고한 `approval_input_hash`와 같다. 이 값은 실행하는 쪽이 이미 쓰는 마스킹 **전** 인자의 해시(`packages/runtime-core/src/approval.ts:112`의 `approvalInputHash`)이고, 승인과 실행이 같은 인자였는지를 이것으로만 확인한다. 비교한 뒤 버리고 저장하지 않는다. ④ 답과 근거가 맞는다(승인 답 ↔ `approval`, 거절 답 ↔ `approval_denied`, 기한 만료·취소로 닫힘 ↔ 각 근거). ⑤ **그 승인이 이 호출에 유효했다.** 길이 둘이다. 같은 attempt 안에서 답이 바로 전달된 호출이면 요청 행의 `tool_use_id`·`attempt_id`·`turn_id`가 보고한 호출의 것과 같아야 한다(같은 attempt가 다음 turn을 받아도 이전 turn의 승인을 잇지 못하게 `turn_id`까지 본다). 재개 경로(아래)면 `permission_grants`에 그 `request_id`의 행이 있고 그 행의 `turn_id`·`attempt_id`가 보고한 turn·attempt와 같아야 한다(`packages/db/src/schema.ts`의 `permissionGrants`). ⑥ **한 요청의 승인은 한 번만 근거가 된다.** 같은 `pending_request_id`로 `decided`·`approval` 행이 **다른 호출 키로** 이미 있으면 새 보고는 근거로 인정하지 않는다(유일 부분 인덱스 `(pending_request_id) WHERE phase='decided' AND basis='approval'`). **순서는 다음과 같다.** 먼저 호출 유일 키(`session_id, attempt_id, turn_id, call_key, phase`)가 이미 있으면 그 보고는 같은 보고의 재전송이므로 아무것도 하지 않는다(⑥을 적용하지 않는다). 키가 새 것일 때만 ⑥을 적용하고, 걸리면 행을 버리지 않고 `unknown/approval_unverified`로 바꿔 넣는다(`pending_request_id`는 부분 인덱스에 걸리지 않도록 그 행에서는 null로 쓴다). 같은 인자를 다시 부르면 worker가 다시 묻는다(grant는 한 번만 소비된다, `apps/worker/src/worker-host.ts`의 `takeGrant`). 하나라도 틀리면 `decision=unknown`, `basis=approval_unverified`로 쓴다. 이 검증은 worker가 보낸 `call_key`·turn·attempt를 DB 사실과 맞춰 볼 뿐이므로, 같은 세션의 도구 코드가 보고를 꾸미는 것까지는 막지 못한다(7.9절).
- **재개 경로.** 사람이 답한 뒤 turn이 멈췄다 다시 열리면(`packages/db/src/parked-group.ts:310`이 새 turn을 만들고 `:340`이 기존 요청의 승인을 새 turn의 grant로 잇는다) 질문한 attempt와 실행하는 attempt·`tool_use_id`가 다를 수 있다. 그래서 `asked` 행과 `decided` 행은 `call_key`로 묶지 않고 **`pending_request_id`로 잇는다.** 검증 ①~④는 질문한 attempt·turn과 실행한 것의 일치를 요구하지 않고, 대신 ⑤가 grant의 대상 turn·attempt를 확인한다. grant를 쓰지 않은 요청은 `decided` 행이 없고, 그 상태는 `pending_requests`가 설명한다. 그래서 물은 호출이 항상 두 행이 되는 것은 아니다.

#### 7.3.2 판정과 근거

| `phase` | `decision` | `basis` | 뜻 |
|---|---|---|---|
| `decided` | `allow` | `trusted_tool` | 신뢰된 도구 목록(`trustedTools`)에 있다 |
| `decided` | `allow` | `permission_mode` | `bypassPermissions`·`auto` 모드가 묻지 않고 통과시켰다 |
| `decided` | `allow` | `memory_read` | 메모리만 읽는 호출이라 묻지 않고 허용했다(`runtime.ts:192`) |
| `decided` | `allow` | `approval` | 사람이 승인했다(`pending_request_id`, `answered_by` 필수, 7.3.1절 검증) |
| `decided` | `deny` | `not_permitted` | 세션의 허용 목록(`tools`) 밖이다(`canUseTool`과 `PreToolUse` 어느 쪽이든) |
| `decided` | `deny` | `hook_deny` | 호스트의 사전 검사(`precheckTool`)나 checkpoint 정지 구간이 거절했다 |
| `decided` | `deny` | `approval_denied` | 사람이 거절했다 |
| `decided` | `deny` | `approval_expired` / `approval_cancelled` | 답이 오기 전에 기한이 지났거나 취소됐다 |
| `decided` | `unknown` | `engine_internal` | 호출은 지나갔지만 adapter가 설정으로 설명하지 못하는 경로다(세션 규칙이 `canUseTool` 없이 통과시킨 경우 등). 추측하지 않는다 |
| `decided` | `unknown` | `unreported` | 판정을 보고하지 않는 worker(예전 이미지)의 호출 |
| `decided` | `unknown` | `approval_unverified` | 7.3.1절의 검증에 실패했다 |
| `asked` | `require_approval` | `approval_asked` | 사람에게 물었다. **API가 `registerPendingRequest`와 같은 트랜잭션에서 쓴다**(`source=platform`) |

- 호출의 지금 판정은 같은 호출의 `decided` 행이고, 없으면 `asked` 행이다. 순서는 시각이 아니라 `phase`가 정한다. 행을 고치지 않으므로 시각 동률이나 재전송이 현재 판정을 뒤집을 수 없다.
- `decided` 행은 호출마다 하나다. 같은 키로 다른 내용이 다시 오면 처음 것이 남고 API가 `tool_audit.conflict` 경고를 남긴다(7.7절).
- 답이 오지 않고 attempt가 사라진 호출은 `asked` 행만 남고, `pending_requests.settled_outcome`이 `lost`로 설명한다.
- SDK에 옵션으로 넘긴 `disallowedTools`(`runtime.ts:346`)로 엔진이 스스로 거절한 호출은 adapter가 보지 못한다. 그런 호출은 감사 행이 없고 `tool_use` 이벤트의 결과가 오류로 남을 뿐이다. 7.9절의 한계로 적는다.

### 7.4 무엇을 절대 기록하지 않는가

감사 행을 쓰는 경로(7.6절)는 다음을 **어떤 필드에도 쓰지 않는다.**

| 쓰지 않는 것 | 이유 |
|---|---|
| 도구 입력의 **원문, 일부(앞 N자), 요약** | 입력에는 명령어, 파일 경로, 코드, 비밀값이 섞인다. 요약은 도구마다 규칙이 필요하고 요약에서 새는 값을 막는 규칙을 또 만들어야 한다. 내용은 `events`에 이미 있고 세션 열람 권한 아래에 있다 |
| 도구 **결과**(출력, 오류 본문) | 같은 이유. 성공·실패와 소요 시간은 `tool_calls`에 있고, 본문은 `events`에 있다 |
| 사용자 메시지 원문(`turns.message`), 엔진의 thinking·assistant 텍스트, transcript | 감사 대상은 도구 호출이다. 대화 내용은 세션 정본이 갖는다 |
| 자격 증명 일체: 세션 credential, egress token, MCP 서버 token, GitHub·provider 토큰, bootstrap nonce, `OTEL_EXPORTER_OTLP_HEADERS` 값 | worker가 가진 비밀값 목록(`claimSecrets`, `apps/worker/src/secret-scrubber.ts:15`)에 해당하는 값은 이 경로로 들어올 이유가 없다 |
| 환경 변수 값 | 도구가 읽을 수 있는 환경은 비밀을 담는다 |
| HTTP 요청·응답 헤더, 쿠키, 클라이언트 IP, user agent | 개인 식별 정보이고 도구 호출의 판정과 무관하다 |
| 사람의 이름·이메일·Slack 표시 이름 | id(uuid, Slack은 연결된 계정 id)만 남기고 이름은 읽을 때 풀어 쓴다. 이름이 바뀌어도 기록이 틀리지 않는다 |
| MCP 서버의 **URL**과 `credential_ref` | 서버는 이름(`mcp_server`)으로만 남긴다 |
| 사유 같은 자유 서술(`authz_decisions.justification` 같은 칸) | 이 표에는 자유 서술 칸이 없다. 모든 문자열 필드는 닫힌 목록이거나 id다 |

**외부에서 온 문자열은 걸러서 쓴다.** 원격 MCP 서버가 준 도구 이름은 외부 문자열이고, `tool_use_id`·요청 id도 기존 contracts에서는 자유 문자열이다(`packages/contracts/src/worker-protocol/index.ts:825`, `shared/ids.ts:8`). `tool_name`·`tool_use_id`·`parent_tool_use_id`·`call_key`·`pending_request_id`는 `[A-Za-z0-9_.:-]{1,128}`만 받는다. 맞지 않으면 `tool_name`은 `invalid_tool_name`으로, 나머지 id는 null(`call_key`는 `n:<순번>`)로 쓰고 원래 값은 버린다. 이름을 따로 담을 칸이 없다. **이 규칙은 모양만 거른다.** 토큰이나 hex 비밀값도 이 문자 집합에 들어맞으므로 "자격 증명을 쓰지 않는다"는 보장은 **claim이 알려 준 비밀값(`claimSecrets`)과 마스킹 규칙이 잡는 패턴의 범위**까지다. worker는 외부 id를 보고하기 전에 `SecretScrubber`와 `sanitizeText`를 거친다. 둘이 값을 바꿨으면(`<redacted>`·`[REDACTED]`가 들어갔으면) 그 id는 null로 쓴다.

**개인정보.** 남는 개인 관련 값은 id뿐이다(`actor_user_id`, `principal_id`, `answered_by`). 이 id는 보존 기간이 지나면 정리 job이 지운다(7.7절). 사용자 한 명의 기록을 기간 전에 지우는 요청 경로는 만들지 않는다. 이것은 세션·이벤트에 삭제 API가 없는 지금의 정책([data-retention.md](../../operator/data-retention.md))과 같은 수준이고, 개인정보 삭제 요구가 생기면 보존 기간을 줄이는 쪽(최소 30일)으로 먼저 다룬다.

### 7.5 입력을 남기는 방법: 해시와 크기

`input_sha256`은 **마스킹이 끝난 입력을 정규형으로 직렬화해 sha256**을 낸 값이고, `input_bytes`는 그 정규형의 UTF-8 바이트 수다.

- 정규형은 키를 정렬한 JSON이다. 같은 입력이면 어디서 계산해도 같은 값이 나온다.
- **마스킹 뒤에 해시한다.** `events`에 저장되는 입력(`sanitizeNativeMessage`, `packages/adapters/runtimes/claude/src/mapper.ts:57`, 그리고 worker의 `scrubbingGateway`)과 같은 값이므로 감사 행과 이벤트의 표시 입력을 맞춰 볼 수 있고, 비밀값이 든 입력의 해시를 후보 대입으로 추측할 길이 줄어든다.
- **이 해시가 보장하는 것은 "마스킹된 표시 입력의 대응"까지다.** 마스킹은 서로 다른 원문을 같은 가림 값으로 만들 수 있으므로(`mapper.ts` 마스킹 규칙) 이 해시로 "승인된 인자와 실행된 인자가 같다"를 증명하지 못한다. 그 증명은 기존 승인 해시 `pending_requests.input_hash`(마스킹 **전** 인자)와 7.3.1절의 비교가 맡는다. 두 해시는 이름이 비슷하지만 다른 값이고, 감사 행에는 승인 해시를 저장하지 않는다.
- **남는 정보 유출.** 결정적 sha256이므로 후보가 적은 입력(짧은 명령, 흔한 경로, 개인정보)은 후보를 대입해 일치 여부를 확인할 수 있고, 같은 입력의 반복 호출을 세션 사이에서도 연결할 수 있다. 이것을 익명화라고 부르지 않는다. 이 표를 읽는 주체가 `events`를 읽는 주체보다 넓지 않은 동안은 받아들인다. 읽는 길이 그보다 넓어지면 워크스페이스별 HMAC으로 바꾼다(재검토 조건, 7.9절).
- 왜 해시인가: 호출이 같은 입력으로 반복됐는지, 표시된 입력이 `events`의 내용과 같은지(내용이 나중에 바뀌지 않았는지)를 확인할 수 있고, 내용은 복제하지 않는다.

| 입력을 남기는 안 | 결정 | 이유 |
|---|---|---|
| 원문 | **기각** | 비밀·개인정보를 두 곳에 두고, 열람 권한과 보존이 `events`와 달라진다 |
| 요약(도구별 첫 인자 등) | **기각** | 도구마다 규칙이 필요하고, 요약에 경로·명령 일부가 새며 가림 규칙을 하나 더 만든다 |
| 해시 + 바이트 수 | **채택** | 위 이유 |
| 아무것도 안 남김 | 기각 | 표시된 입력과 `events`의 내용을 맞춰 볼 수 없고, 같은 입력의 반복을 셀 수 없다 |

### 7.6 담당 모듈

```text
contracts   packages/contracts/src/…/tool-call-audit.ts
            ToolCallAuditEntry (zod), TOOL_AUDIT_DECISION_VALUES, TOOL_AUDIT_BASIS_VALUES
            + appendEventsRequestSchema에 선택 필드 tool_decisions[] (worker 보고)

platform    packages/platform/src/workers/worker-gateway.ts (기존)
            append 요청을 검증하고 보고(tool_decisions)를 WorkerUnitOfWork.commitEventsAtomic의 입력(toolAudits)으로 넘긴다.
            새 포트는 만들지 않는다 (3.4절)

db          packages/db/src/tool-call-audit.ts
            insertToolCallAudits(tx, entries): worker-unit-of-work의 트랜잭션 안에서만 부른다
            schema.ts의 표, 마이그레이션, 보존 정리(expireAuthzDecisions 옆)

worker      apps/worker: 보고를 모아 append-events에 싣는다
claude adapter  packages/adapters/runtimes/claude: canUseTool·PreToolUse 자리에서 판정을 관찰자에게 알린다
```

- **의존성 방향.** platform은 unit-of-work 입력 타입과 검증만 안다. 표를 아는 것은 db뿐이다. worker는 `platform`에 의존하지 않으므로([로그 계약 1.2절](logging-contract.md#12-에러를-문자열로-바꾸는-곳)의 `messageOf` 사본 설명) 보고 형식은 contracts의 zod를 쓴다.
- **왜 `ToolCallAuditSink` 포트를 두지 않나.** 이벤트 저장의 트랜잭션은 `commitEventsAtomic`이 db 안에서 연다(`packages/platform/src/workers/worker-gateway.ts:2581`가 부르고, 트랜잭션은 `packages/db/src/worker-unit-of-work.ts` 내부에서 열린다). 따로 조립한 `record()`를 platform 서비스가 부르면 그 트랜잭션에 참여하지 못한다. 감사 입력은 같은 포트의 입력 데이터로 실린다. 쓰는 레이어가 하나이고 구현이 DB 하나인 쓰기에 인터페이스를 하나 더 두면 트랜잭션 경계를 흐리기만 한다. 감사 행을 다른 곳(예: 제어 경로의 거절)에서 쓸 일이 생기면 그 호출이 소유한 트랜잭션에 같은 방식으로 얹고, 쓰는 곳이 둘 이상이 되면 그때 포트를 추출한다.
- **판정을 알리는 쪽도 인터페이스로 받는다.** Claude adapter는 worker의 타입을 모른다. adapter가 소유하는 작은 관찰자 인터페이스 하나를 `RuntimeHooks`(`packages/adapters/runtimes/claude/src/driver.ts:71`) 옆에 둔다.

  ```ts
  export interface ToolDecisionObserver {
    observe(decision: {
      toolUseId: string | undefined;
      parentToolUseId: string | undefined;
      tool: string;
      input: Record<string, unknown>; // redacted by the caller before hashing
      decision: "allow" | "deny";
      basis: ToolAuditBasis;
    }): void;
  }
  ```

  worker는 **트레이스 설정과 상관없이 항상** 실제 구현을 넣는다. 감사 보고는 내구 기록이므로 telemetry가 꺼진 기본 설치에서도 켜져 있어야 한다. 아무것도 하지 않는 구현은 adapter를 worker 밖에서 쓰는 곳(시험, 도구)에만 들어간다. `RuntimeHooks`에 메서드를 더하지 않는 이유는, 판정을 알리는 일과 사람에게 묻는 일(`onPermission`)이 다른 능력이어서다(ISP).
- **platform 안의 위치.** 새 파일이 없다. 기존 `worker-gateway`와 `WorkerUnitOfWork`의 입력만 늘어나므로, 열린 구조화 설계([패키지 구조화](package-structure.md), 열린 PR JeongJaeSoon/werft#1498)가 `workers/`나 `decision-log`를 어디로 옮기든 따라간다. 이 문서는 새 도메인 폴더를 만들지 않는다.
- **하지 않는 것:** 구현 없는 어댑터, 던지기만 하는 빈 구현, 쓰는 곳이 없는 읽기 인터페이스(`ToolCallAuditReader`). 읽는 API는 아직 없다(`authz_decisions`도 SQL로 읽는다).

### 7.7 쓰는 시점, 실패, 보존

- **쓰는 시점.** worker는 판정을 `append-events` 요청의 선택 필드 `tool_decisions[]`로 보낸다(요청 스키마가 `.strict()`라 예전 API는 모르는 필드를 거절한다. 그래서 새 API를 먼저 배포하고, 새 API는 필드가 없는 예전 worker 요청을 받는다). API는 `commitEventsAtomic`과 **같은 트랜잭션**에서 이벤트와 함께 행을 넣는다. 사람에게 묻는 `asked` 행은 API가 `registerPendingRequest`를 처리하는 같은 트랜잭션에서 쓴다.
- **보장하는 것은 "같은 append 안의 원자성"이다.** 검증을 통과해 삽입 대상으로 채택된 감사 행과 그 append의 이벤트는 함께 저장되거나 함께 저장되지 않는다. 스키마가 틀려 버려진 항목(아래)은 이 보장 밖이고, 그 항목의 감사 행은 없다. 이 문서는 **감사가 도구 실행의 게이트라고 주장하지 않는다.** worker는 이벤트를 비동기로 보내고(`apps/worker/src/event-publisher.ts:90`) 도구 이벤트가 저장된 **뒤에** pending 요청을 등록하며(`apps/worker/src/pending-requests.ts:534`), 즉시 허용 경로는 감사 저장을 기다리지 않는다(`runtime.ts:192`). 그래서 도구가 판정 행이 내구 저장되기 전에 실행될 수 있고, worker가 그 사이에 죽으면 행이 없다. 실행 전 내구성이 필요한 도구(git·외부 호출 등급)는 별도의 실행 게이트가 필요하고 그것은 방향 결정 티켓의 D10(T12)이 따로 정한다.
- **DB 오류는 append를 실패시킨다.** 행을 넣지 못한 DB 오류는 트랜잭션을 되돌리고 worker가 같은 배치를 재시도한다. 그러나 **보고 항목 하나가 스키마나 검증에서 틀렸다고 append 전체를 거절하지 않는다.** 그러면 잘못된 보고 하나가 이벤트를 영원히 막는다. 스키마가 맞지 않는 항목은 버리고 경고 로그와 세는 값(`tool_audit.dropped`)을 남기고, 승인 검증에 실패한 항목은 `unknown/approval_unverified`로 쓴다.
- **재전송은 멱등이다.** 이벤트 publisher는 응답이 유실되면 같은 배치를 다시 보내고 이벤트는 `source_sequence`와 내용 비교로 이를 처리한다(`packages/db/src/worker-unit-of-work.ts`). 감사 행은 유일 키 `(session_id, attempt_id, turn_id, call_key, phase)`와 `ON CONFLICT DO NOTHING`으로 같은 처리를 한다. 같은 키로 **내용이 다른** 보고가 오면 처음 것을 두고 `tool_audit.conflict` 경고를 남긴다. 재전송이나 뒤늦은 보고가 현재 판정을 되돌리지 못한다.
- **보존.** `settings.audit_retention_days`(기본 90일, 최소 30·최대 3650)를 `authz_decisions`와 **같이** 쓴다. 정리는 같은 reconciler pass의 `expireAuthzDecisions`(`packages/db/src/authz-decisions.ts:82`)와 같은 방식(워크스페이스별 기간, 오래된 것부터 `RECONCILER_BATCH_SIZE`개씩, `RECONCILER_DRY_RUN` 존중)으로 한다. 감사 기간을 정하는 설정이 둘이면 어느 쪽이 맞는지 운영자가 묻게 되므로 새 키를 만들지 않는다. 기간을 바꾸는 권한은 지금과 같이 owner(`audit_retention.manage`, `packages/platform/src/musterrolle/policy.ts:304`)다.
- **삭제 경로는 보존 정리 하나뿐이다.** 행 단위 삭제·수정 API는 없다. trigger가 UPDATE를 거절하고, DELETE는 정리 job만 한다.
- **기간 뒤에 남는 것.** 90일 뒤 이 표의 행은 사라진다. 사람이 승인·거절한 호출의 `answered_by`는 `pending_requests`에 남으므로 "누가 답했나"는 계속 답할 수 있다. 묻지 않고 허용·거절된 호출의 근거는 기간이 지나면 남지 않는다.

### 7.8 트레이스와의 관계

`werft.tool` span은 같은 판정을 속성(`werft.tool.decision`, `werft.tool.decision_basis`)으로 싣는다. 값은 7.3.2절의 목록이다. span은 best effort 관측이고 감사 기록은 내구 기록이다. 감사 쪽이 트레이스를 읽지 않으며, 트레이스가 없어도 감사는 완전하다. 속성에 입력 해시를 싣지 않는다(내용 속성 `gen_ai.tool.call.arguments`가 full 모드에서 마스킹된 입력을 이미 싣는다).

### 7.9 한계

- **같은 세션 안의 위조는 막지 못한다.** 도구 코드가 세션 credential로 gateway를 부를 수 있으므로, worker가 보고하는 값(`allow`·`deny`의 근거, 해시)은 attempt가 한 말이다. 그래서 `source`를 남기고 승인 근거는 API가 `pending_requests`로 검증한다. 도구 코드가 마음대로 쓸 수 있다는 점은 `events`도 같다.
- **엔진이 스스로 내린 판정은 보이지 않는다.** `disallowedTools`로 엔진이 거절한 호출은 행이 없고, 세션 규칙이 통과시킨 호출은 `unknown/engine_internal`이다(7.3.2절). 완전한 판정 기록은 엔진이 판정을 모두 adapter 콜백으로 넘길 때만 가능하다.
- **감사는 실행 게이트가 아니다.** 7.7절. 도구가 실행되기 전에 판정 행이 내구 저장되는 것은 보장하지 않는다.
- **해시가 후보 대입에 열려 있다.** 7.5절. 이 표를 읽는 주체가 `events`를 읽는 주체보다 넓어지는 변경(읽기 API, 화면)이 생기면 워크스페이스별 HMAC으로 바꾸는 결정을 그 변경의 전제로 둔다.
- **도구 단위 차단은 이 문서의 일이 아니다.** 원격 MCP 도구를 서버가 아니라 도구 단위로 막는 일은 별도 설계다. 이 감사는 막은 결과(`not_permitted`·`hook_deny`)를 기록할 뿐 막는 규칙을 만들지 않는다.
- **변조 방지(해시 체인, 서명)는 하지 않는다.** append-only trigger가 전부다. 규제 요구가 생기면 다시 본다.
- **읽는 API와 화면은 없다.** SQL로 읽는다. 읽는 길이 생기면 그 세션을 볼 수 있는 주체 범위를 넘지 않는다.

## 8. 후속 순서표

선행 관계는 Linear의 blocked-by 관계다. "기대는 절"은 그 티켓이 구현할 때 이 문서에서 읽을 곳이다. 수용 기준은 티켓 본문 그대로다(2026-11-10 읽음). T번호는 방향 결정 티켓 본문의 구현 후보 번호다. `X1`은 에픽에 따로 있는 콘솔 설정 티켓이고, T6(비밀값 마스킹 규칙 재작성과 통합)은 이 표의 대상이 아니라 T4와 T3가 기다리는 선행이다.

```text
T1 ──> T2 ──────────────┐
T1 ──> T5 ──> T9        │
T1 ──> T4 ──> T9        ├──> T3 ──> T11 (2단계)
T6 ──> T4 ──────────────┤
T1, T2, T4, T5, T6 ─────┘
T5, T3 ··> X1   (관련. 착수 전에 범위를 나눈다)
```

| 번호 | 제목 | 선행 | 기대는 절 |
|---|---|---|---|
| T1 | OTel tracer 부트스트랩과 로그의 trace_id | 없음 | 2, 3, 4.3, 6 |
| T2 | API HTTP span과 turn의 trace context | T1 | 4.1, 4.2, 5, 6 |
| T4 | telemetry ingest listener | T1, T6 | 2.2, 3.3, 4.1, 6 |
| T5 | 운영자 설정 키와 claim telemetry 계약 | T1 | 6, 4.2 |
| T3 | worker span emitter | T1, T2, T4, T5, T6 | 2.1, 3.3, 4, 7.3.2, 7.6, 7.8 |
| T9 | 운영 문서: OTLP 내보내기 설정 키와 기존 서술 갱신 | T4, T5 | 6, 2.3, 7.7 |
| X1 | 관측 내보내기 설정(OTLP 엔드포인트·헤더, Langfuse)을 콘솔에서 입력하고 세션 트레이스를 그곳으로 보낸다 | 없음(관련: T5, T3) | 2.3, 6, 3.3 |

### T1 OTel tracer 부트스트랩과 로그의 trace_id

- 선행: 없음. T2·732·733·734가 기다린다.
- 기대는 절: 2절(범위), 3절(포트), 4.3절(로그 필드), 6절(설정 키 중 `OTEL_TRACES_EXPORTER`·`OTLP_*`·`TRACE_INSTALL_TENANT`)
- 수용 기준:
  - `OTEL_TRACES_EXPORTER`가 없거나 `none`이면 exporter가 만들어지지 않고 아무 요청도 나가지 않는다 — 확인: 단위 테스트(fake OTLP 수신기 요청 0건)
  - `OTEL_TRACES_EXPORTER=otlp`와 endpoint를 주면 span이 `http/protobuf`로 전송된다 — 확인: fake OTLP 수신기 통합 테스트
  - 워크스페이스가 다른 span은 다른 batch로 나가고, 각 batch에 그 워크스페이스의 테넌트 헤더가 붙는다. 워크스페이스가 없는 span은 `TRACE_INSTALL_TENANT`로 간다 — 확인: 단위 테스트
  - 활성 span 안에서 남긴 로그 레코드에 trace_id·span_id가 채워지고, span 밖에서는 비어 있다 — 확인: 단위 테스트
  - Bun에서 await·setTimeout을 지난 뒤에도 활성 context가 유지된다 — 확인: Bun 테스트 출력
- 이 문서가 더하는 것: 로그의 `span_id`는 새 최상위 키라 로그 계약 문서와 `LOG_RECORD_KEYS`를 같은 PR에서 갱신한다(4.3절). "비어 있다"는 키를 쓰지 않는다는 뜻이다.

### T2 API HTTP span과 turn의 trace context

- 선행: T1. T3가 기다린다.
- 기대는 절: 4.1·4.2절(전파), 5절(span 규칙), 6절(샘플러)
- 수용 기준:
  - 클라이언트가 `traceparent`를 보낸 요청의 API span은 새 trace_id를 갖고, 보낸 context를 link로 가진다 — 확인: in-memory exporter 통합 테스트
  - `traceparent`의 sampled 플래그가 `00`이어도 API span이 기록된다 — 확인: 같은 테스트
  - `POST /v1/sessions/{id}/turns`가 만든 turn 행의 `trace_context`에 그 요청 span의 traceparent가 같은 트랜잭션으로 저장된다. 트랜잭션이 롤백되면 남지 않는다 — 확인: DB 통합 테스트
  - 마이그레이션이 기존 행을 null로 두고 올라가고 내려간다 — 확인: 마이그레이션 테스트 출력
  - nextInput 응답에 `trace_context`·`content_mode`가 실리고, 필드가 없는 예전 worker도 그대로 동작한다 — 확인: contracts 테스트와 worker 테스트
  - 이 attempt의 turn trace_id가 아닌 `traceparent`를 단 gateway 요청은 새 root가 된다 — 확인: 단위 테스트
- 이 문서가 바꾸는 것: 마지막 항을 "이 attempt의 turn trace_id가 아닌 `traceparent`를 단 gateway 요청은 span을 만들지 않는다. turn trace_id를 단 요청만 그 span의 자식이 된다"로 바꾼다(4.2절 4항, 5.3절). "요청마다 HTTP span"에서 health·metrics와 부모 없는 gateway 요청은 뺀다. 클라이언트의 `traceparent`는 `/v1/**`에서 link가 되고(`tracestate`는 버린다), 이 항과 무관하다. turn trace_id는 `turnTraceId(session_id, turn_id)`다(4.1절).

### T4 telemetry ingest listener

- 선행: T1, T6. T9·738·734가 기다린다.
- 기대는 절: 2.2절(위조 한계), 3.3절(exporter), 4.1절(trace_id 고정), 6절(`TRACE_INGEST_*`, `TRACE_MAX_BYTES_PER_TRACE`, `TRACE_FENCED_GRACE_SEC`, 테넌트 키)
- 이 문서가 바꾸는 것: 본문의 "trace_id가 이 attempt가 받은 turn id에서 나온 값(`SHA-256("werft.turn:" + turn_id)` 앞 16바이트)"은 틀린 식이다. 공개 `turn_id`는 세션 안의 순번이라 세션이 다르면 같은 값이 나온다. 검사 기준은 `turnTraceId(session_id, turn_id)`(4.1절)다.
- 수용 기준:
  - 4MiB 이하 batch는 ingest 포트에서 받고, 공개 API 포트의 본문 상한은 바뀌지 않는다 — 확인: 통합 테스트(두 포트에 같은 batch 전송)
  - credential이 다른 세션이거나 fence가 맞지 않는 요청은 거절된다. grace 안의 fence 잃은 attempt 데이터는 `werft.fenced=true`로 들어간다 — 확인: 통합 테스트
  - 이 attempt의 turn에서 나오지 않은 trace_id의 span은 버려지고 드롭 카운트가 오른다 — 확인: 통합 테스트
  - 보낸 span에 넣은 다른 `werft.workspace_id`·`langfuse.trace.public` 속성이 resource·span·span event 어디에도 남지 않는다 — 확인: 단위 테스트
  - metadata 모드 워크스페이스에서 온 `gen_ai.tool.call.result` 같은 내용 속성이 수집기로 가지 않는다 — 확인: 단위 테스트
  - 분당 상한을 넘으면 429와 드롭 카운트, 트레이스 상한을 넘으면 그 뒤 span에 `werft.content_dropped=true` — 확인: 단위 테스트
  - 수집기가 응답하지 않아도 heartbeat·next-input 지연이 늘지 않는다 — 확인: 멈춘 fake 수집기로 한 통합 테스트의 지연 출력
  - `TRACE_TENANT_HEADER`의 헤더와 `TRACE_TENANT_HEADERS_FILE`의 헤더가 워크스페이스별로 붙는다 — 확인: fake 수집기가 받은 헤더 테스트
  - ingest가 보낸 span에 수집기 전용 속성(`langfuse.*` 등)이 새로 생기지 않는다. 받은 쪽에 있던 것은 지워진다 — 확인: 단위 테스트

### T5 운영자 설정 키와 claim telemetry 계약

- 선행: T1. T3·737이 기다린다.
- 기대는 절: 6절 전체, 4.2절 3항(nextInput 필드 정의 선후)
- 수용 기준:
  - 키를 하나도 주지 않은 api는 export가 꺼지고, claim의 `telemetry.enabled`가 false다 — 확인: 설정 단위 테스트와 claim 응답 테스트
  - 잘못된 값(모르는 exporter·protocol, 음수 상한)은 시작 시 이름을 밝힌 오류로 멈춘다 — 확인: 설정 단위 테스트
  - `TRACE_CONTENT_MODE=metadata`면 워크스페이스 설정이 full이어도 claim·nextInput의 `content_mode`가 metadata다 — 확인: 단위 테스트
  - OTLP endpoint 호스트가 egress allowlist에 있으면 시작 로그에 경고가 한 번 남는다 — 확인: 단위 테스트의 로그 출력
  - `OTEL_EXPORTER_OTLP_HEADERS`와 헤더 맵 파일의 값이 로그·오류 메시지에 나오지 않는다 — 확인: 로그 캡처 테스트
  - worker 프로세스와 엔진 env에 `OTEL_*` 키가 넘어가지 않는다 — 확인: worker env 테스트
- 이 문서가 더하는 것: 샘플러가 `traceidratio`를 받으므로 claim `telemetry`에 선택 필드 `sampler`·`sampler_arg`를 싣는다(6절. 없는 claim은 `always_on`). 설계안의 `telemetry: { enabled, ingest_url, content_mode, content_max_bytes }`에 두 필드를 더하는 것이다. 이 PR 시점의 T5 본문에는 이 필드가 없으므로 구현 PR이 contracts에 정의한다. 엔드포인트·테넌트 헤더·샘플러의 구체 규칙은 6절이 정한다.

### T3 worker span emitter

- 선행: T1, T2, T4, T5, T6. T11가 기다린다.
- 기대는 절: 2.1절(trace 범위), 3.3절(worker의 exporter), 4절(trace_id·전파), 7.3.2절·7.6절(판정 관찰자)·7.8절(`werft.tool` 속성)
- 수용 기준:
  - fake model 세션의 한 turn(도구 1회 + 권한 요청 1회)에서 span 트리가 `werft.turn` root, `werft.llm_request`, `werft.tool`, tool 밑 `werft.permission_wait`, `werft.checkpoint`로 나온다 — 확인: in-memory exporter 통합 테스트의 트리 출력
  - trace_id가 turn id로 결정적이고, 같은 attempt의 다음 turn root가 이전 turn에 link한다 — 확인: 단위 테스트
    (이 문서가 바꾸는 것: "turn id로 결정적"은 `turnTraceId(session_id, turn_id)`로 읽고 4.1절의 시험 벡터를 쓴다)
  - `werft.permission_wait`에 `werft.permission_decision`·`werft.answer_surface`·`werft.pending_request_id`가 실린다 — 확인: 통합 테스트
  - 한국어 내용이 `content_max_bytes`에서 UTF-8 바이트로 잘리고 `werft.truncated.<원래 키>`가 붙는다 — 확인: 단위 테스트
  - `content_mode=metadata` turn의 span에 내용 속성이 없다. 다음 turn에서 full로 바뀌면 다시 실린다 — 확인: 단위 테스트
  - claim이 준 비밀값이 도구 출력에 있어도 span 속성에 남지 않는다 — 확인: 단위 테스트
  - ingest가 멈춰 있어도 `/append-events`와 finalize가 늦어지지 않고, 큐 상한을 넘으면 드롭 카운트가 오른다 — 확인: 멈춘 fake ingest로 한 통합 테스트
  - telemetry가 꺼진 claim에서는 span이 하나도 만들어지지 않는다 — 확인: 단위 테스트
- 이 문서가 더하는 것: `werft.tool` span에 `werft.tool.decision`·`werft.tool.decision_basis`를 싣는다(7.8절). 이 속성의 값은 감사 레코드와 같은 목록이다. 감사 레코드를 쓰는 일(7절) 자체는 이 티켓의 범위가 아니다.

### T9 운영 문서: OTLP 내보내기 설정 키와 기존 서술 갱신

- 선행: T4, T5.
- 기대는 절: 6절(키와 기본값), 2.3절(Langfuse와의 관계), 7.7절(감사 보존)
- 수용 기준:
  - 문서의 키만으로 export를 켠 로컬 스택에서 fake model 세션의 turn 트레이스가 fake OTLP 수신기에 도착하고, resource에 `werft.session_id`가 있다 — 확인: 수신기가 받은 span 덤프 출력
  - `docs/monitoring-datadog.md`와 `docs/test-ops.md`에 "OTel을 넣지 않는다"는 서술이 남지 않는다 — 확인: grep 출력
  - 설계안 §5.1의 키가 문서에 기본값과 함께 모두 있다 — 확인: 키 목록 대조
  - 비밀 헤더 값의 예시는 자리표시자만 쓴다 — 확인: 문서 리뷰
- 이 문서가 알리는 것: 티켓 본문의 경로가 낡았다. 지금 "OTel을 넣지 않는다"는 서술은 `apps/docs/content/docs/run-server/self-hosting/operate/monitoring-datadog.mdx:6`, `docs/operator/test-ops.md:547`, `docs/operator/data-retention.md`의 "트레이스와 플랫폼 정본의 경계" 절에 있고 `docs/monitoring-datadog.md`·`docs/test-ops.md`·`docs/operator/observability.md`는 없다. 키 표의 정본은 6절이다.

### X1 관측 내보내기 설정(OTLP 엔드포인트·헤더, Langfuse)을 콘솔에서 입력하고 세션 트레이스를 그곳으로 보낸다

- 선행: 없음(관련: 방향 결정 티켓). T5와 범위를 나눈 뒤 착수한다.
- 기대는 절: 2.3절(Langfuse는 OTLP 수신기 한 종류), 6절(키가 콘솔 설정의 서버 쪽 계약), 3.3절(worker는 수집기로 직접 보내지 않는다)
- 수용 기준:
  - 콘솔 설정에서 OTLP 엔드포인트와 헤더를 입력·수정·삭제할 수 있다. 헤더 값은 write-only 비밀값이라 저장 뒤에는 화면·API 응답에 나오지 않는다 — 확인: 웹 테스트, API 응답
  - 같은 화면에서 Langfuse를 고르면 주소와 key만 입력하면 된다 — 확인: 웹 테스트
  - 구현 전에 Langfuse가 OTLP를 받는지(어느 경로·인증 헤더인지) 확인한 결과가 PR에 있다 — 확인: 실측 출력
  - 설정을 넣은 뒤 시작한 세션의 worker가 그 엔드포인트로 트레이스를 보낸다. worker 환경·모델 입력·대화 기록에 헤더 값이 나오지 않는다 — 확인: fake OTLP 수신기가 받은 span 덤프, worker 환경 점검
  - 설정이 없으면 지금처럼 아무것도 내보내지 않는다 — 확인: 기존 E2E
  - 설정 변경은 감사 기록에 남는다(값은 남기지 않는다) — 확인: API 출력
- 이 문서가 충돌로 알리는 것: 티켓 본문은 "worker가 Claude Agent SDK/엔진의 OTel 설정으로 넘기고"라고 적는다. 이 문서는 D6(worker가 span을 직접 만들고 API ingest로 보낸다)에 따라 **worker에 `OTEL_*`를 넘기지 않는다**(6절). X1은 "콘솔 값 → api의 내보내기 설정"으로 읽어야 하고, 엔진 env로 넘기는 부분은 2단계(T11)의 일이다. 착수 전에 범위를 다시 정한다.

### 감사 구현 (티켓 없음)

7절의 구현(표, 마이그레이션, 포트, worker 보고, 보존 정리)은 위 일곱 티켓 어디에도 들어 있지 않다. 선행은 T2의 `nextInput` 필드와 같은 계약 PR(`appendEventsRequestSchema`)이고 T3의 판정 관찰자와 함께 가면 좋다. 이 문서의 PR이 만들지 않고, 리드가 티켓으로 올린다.

## 9. 기각한 안 모음

| 안 | 기각 이유 |
|---|---|
| 트레이스를 세션 화면의 정본으로 삼는다(B안) | 화면, SSE 재연결, finalize, 복구 판정이 기대는 계약이 best effort 신호에 의존하게 된다 |
| 앱이 수집기별로 속성을 바꿔 내보낸다(`TRACE_BACKEND_PROFILE`) | 수집기 선택은 운영자 몫이다(D11). 필요하면 수집기 앞단에서 바꾼다 |
| worker가 수집기로 직접 보낸다 | 엔진의 도구가 worker 환경을 읽을 수 있어 수집기 credential이 샌다 |
| 엔진 CLI의 telemetry를 1단계에 쓴다 | 스파이크에서 egress proxy에 막혔고 권한 결정이 `unknown`이었다 |
| gRPC 기본 | 받지 않는 수집기가 있다(예: Langfuse) |
| 클라이언트의 `traceparent`를 부모로 삼는다 | 클라이언트가 다른 세션 트레이스에 섞거나 `-00`으로 span을 끌 수 있다 |
| `Tracer` 인터페이스를 platform에 둔다 | 쓰는 곳이 db 아래 레이어와 worker까지 걸쳐 있다(3.1절) |
| 도구 호출 감사에 입력 원문·요약을 남긴다 | 7.5절 |
| 감사 보존 기간을 별도 설정으로 둔다 | 같은 "감사" 설정이 둘이 된다(7.7절) |

## 10. 검증한 것

- 인용한 `파일:줄`은 머지 직전 `origin/main`에서 `git show origin/main:<path> | sed -n '<줄>p'`로 다시 읽었다(PR 본문에 출력을 적는다).
- 이 문서가 다루는 숫자·이름은 티켓 본문(방향 결정 티켓과 T1~T5, T3, T9, X1)과 코드에서 읽었고, 코드에 없는 것은 "정한다"로 적었다.
