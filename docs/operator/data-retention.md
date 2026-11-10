# 플랫폼이 보존하는 데이터

플랫폼이 남기는 데이터를 종류별로 모았다. 항목마다 저장 위치, 만드는 시점, 보존 기간, 삭제 조건, 근거 코드를 적는다. 뒤쪽에는 세션 하나를 생성부터 종료까지 따라가는 확인 절차를 둔다. 보존 기간은 플랫폼 기본값을 따르고, 설치처가 바꿀 수 있는 것은 설치처가 바꾼다. 이 문서는 코드와 설정의 플랫폼 기본값을 적고, 설치처가 바꾸는 방법(환경 변수, Helm 값, API)이 있으면 항목마다 "바꾸기"로 함께 적는다. 바꿀 방법이 없으면 그렇다고 적는다. 기본값이 없는 항목은 「정해지지 않음」으로 적고 [결정할 항목](#결정할-항목)에 모았다.

`파일:줄`은 `origin/main` `fc1e7f26` 기준이다. `schema.ts`는 `packages/db/src/schema.ts`를 줄인 이름이다.

## 먼저 알아 둘 것

- **세션은 지우지 않고, 이벤트는 보관한 뒤에만 DB에서 뺀다.** `schema.ts`의 `toolCalls` 주석이 "Nothing deletes sessions; event rows leave only once archived"라고 적는다. 세션을 지우는 API도 없다. 세션 route에는 GET·POST·PATCH만 있다(`packages/core/src/schemas/responses.ts:161-214`). 그래서 세션에 딸린 행(turn, 이벤트, 도구 호출, 대기 요청, 사용량, receipt)은 세션을 닫아도 남는다. 오래 쉰 세션의 이벤트만 [세션 이벤트 보관](#세션-이벤트-보관)이 checkpoint bucket으로 옮긴다. 옮겨도 API 응답은 같다.
- **기간이 지나면 지우는 것은 넷이다.** 권한 판정 기록(`authz_decisions`, 기본 90일), 로그인 세션(`web_sessions`, 만료 30일 뒤), Slack 설치 state(10분), 멈춘 세션의 worker 작업 공간(24시간)이다. checkpoint object는 기간이 아니라 pointer 기준으로 GC가 지운다.
- **트레이스는 기본으로 내보내지 않는다.** 운영자가 `OTEL_TRACES_EXPORTER=otlp`와 수집기 주소를 설정해야 내보낸다([트레이스와의 경계](#트레이스와-플랫폼-정본의-경계)).

## 세션 실행 데이터 (PostgreSQL)

- **세션** — `sessions` 표(`schema.ts:951`)
  - 담는 것: 만든 사람 `created_by_user_id`와 만든 key `created_by_api_key_id`(`schema.ts:1066-1067`), 상태(`status`, `admission_state`), 실행 spec(연결·모델·런타임), 저장소, 추정 비용 `cost_usd`(`schema.ts:1084`), 토큰 합 `provider_tokens`(`schema.ts:1092`), 작업 공간 회수 시각 `workspace_reclaimed_at`(`schema.ts:1051`).
  - 만드는 시점: `POST /v1/sessions`가 첫 입력을 받을 때(`packages/db/src/postgres-unit-of-work.ts:282`).
  - 보존 기간: 무기한.
  - 삭제 조건: 없음. close는 `admission_state`를 `closed`로 바꿀 뿐 행을 지우지 않는다(`packages/db/src/close-control.ts:54-110`).
  - 바꾸기: 없음. 이 절의 다른 표(turn, 이벤트, 도구 호출, 대기 요청, 실행 이력, checkpoint 행, receipt, GitHub 작업, Slack 입출력)도 같다. 보존 기간을 정하는 설정이 없다.
- **turn과 입력 원문** — `turns` 표(`schema.ts:1241`)
  - 담는 것: 사용자가 보낸 메시지 원문 `message`(`schema.ts:1249`), 보낸 사람 `actor_id`(`schema.ts:1262`), 끝난 turn의 결과·사용량 `result_json`(`schema.ts:1253`, 쓰는 곳 `packages/db/src/worker-unit-of-work.ts:2512-2522`).
  - 만드는 시점: 입력을 받을 때(`postgres-unit-of-work.ts:177`).
  - 보존 기간: 무기한. 입력 원문의 바이트는 설치 상한 `STORAGE_LIMIT_BYTES`에 계속 센다. 상한은 지우지 않고 새 입력을 413으로 거절할 뿐이다. 설치처는 `STORAGE_LIMIT_BYTES`(Helm `config.limits.STORAGE_LIMIT_BYTES`, 기본 1 GiB, `values.yaml:126`)로 상한을 바꾼다([configuration.md](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/configuration/)).
  - 삭제 조건: 없음. close·terminate는 대기 중인 turn을 `cancelled`로 바꿀 뿐이다.
- **세션 이벤트** — `events` 표(`schema.ts:1303`)
  - 담는 것: `system`·`assistant`·`tool_use`·`tool_result`·`question`·`result`·`status`·`error` 이벤트. `payload`(`schema.ts:1310`)에 assistant 텍스트, 도구 입력, 도구 결과 본문이 그대로 들어간다. 이 표가 기능의 정본이다([세션 데이터가 흐르는 길](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/session-data-flow/)).
  - 만드는 시점: worker가 `/append-events`로 보낼 때(`worker-unit-of-work.ts:2364`). 제어 단계의 상태 이벤트는 `packages/db/src/session-events.ts`의 `recordEvent`.
  - 보존 기간: 무기한. 내용은 지우지 않는다. 오래 쉰 세션의 행은 [세션 이벤트 보관](#세션-이벤트-보관)이 bucket의 object로 옮기고, API는 그 object에서 같은 응답을 읽는다. 그래서 SSE의 410 `CURSOR_EXPIRED`는 지금 생기지 않는다([API 유즈케이스 가이드](https://jeongjaesoon.github.io/werft/ko/reference/api-guide/)).
  - 삭제 조건: 보관 job이 object를 쓰고, hold를 걸고, 다시 읽어 확인한 뒤에만 그 행을 DB에서 뺀다.
  - 바꾸기: `SESSION_ARCHIVE_AFTER_DAYS`(Helm `sessionArchive.afterDays`)로 옮기기 시작하는 기간을 정한다. 0이면 옮기지 않는다.

### 세션 이벤트 보관

오래 쉰 세션의 `events` 행을 checkpoint bucket으로 옮기는 주간 job이다(`apps/control-host/src/api/session-archive.ts`, 구현 `packages/db/src/session-event-archives.ts`). `events` 말고는 어떤 표의 행도 바꾸지 않는다.

- **대상** — 마지막 활동(`last_turn_at`, 없으면 `created_at`)이 `SESSION_ARCHIVE_AFTER_DAYS`(기본 180일, 0이면 끔, 30~3650일)보다 오래된 세션. 도는 turn, 답을 기다리는 승인·질문 요청, 열린 push 요청이 있는 세션은 건너뛴다. 도구 호출과 숫자 집계 투영이 아직 읽지 않은 이벤트가 하나라도 있는 세션도 건너뛴다. 옮기는 사이에 세션이 다시 움직이면 지우기 직전의 transaction이 이를 보고 그 세션을 그대로 둔다. 범위 밖 값이면 job이 시작하지 않는다.
- **형식** — 이벤트 행 1000개 또는 8 MiB마다 JSONL.gz object 하나. key는 `session-archive/<session id>/events-<첫 id>-<끝 id>-<nonce>.jsonl.gz`다. 줄 하나가 DB 행 하나이고, 숫자와 마이크로초 시각은 DB의 텍스트 그대로다. worker의 object store 경로는 `sessions/<자기 세션>/`만 서명하므로 worker는 이 key를 읽지도 쓰지도 못한다.
- **기록** — `session_event_archives` 표. object마다 id 범위, key, VersionId, sha256, 이벤트 수, 바이트, 마지막 이벤트 시각, 그리고 보관한 범위의 활동 요약을 담는다.
- **순서** — create-only로 쓴다 → legal hold를 건다 → 그 버전을 다시 읽어 줄 단위로 대조한다 → 한 transaction에서 `session_event_archives` 행을 쓰고 같은 범위의 `events` 행을 지운다. 어느 단계든 실패하면 DB의 행은 그대로다. `locked` 설치에서만 돈다. `unversioned`나 `disabled`면 아무것도 하지 않고 끝난다.
- **dry run이 기본이다.** `SESSION_ARCHIVE_DRY_RUN`(Helm `sessionArchive.dryRun`)이 `true`면 옮길 세션·이벤트·바이트 수만 로그(`Session archive completed`)에 남긴다. `false`로 바꿔야 옮긴다.
- **읽기** — 이벤트 목록 API, SSE와 `Last-Event-ID`, 세션 목록의 마지막 이벤트 시각, 활동 요약, 설치 사용량(`usage.archived_events.used_bytes`)이 보관된 범위를 그대로 반영한다. API 프로세스가 object를 읽으므로, 보관된 세션은 API에 checkpoint object store가 설정돼 있어야 읽힌다.
- **되돌리기** — `bun run apps/control-host/src/api/session-archive.ts restore <session id>`가 그 세션의 이벤트를 같은 id로 `events`에 되돌리고 `session_event_archives` 행을 지운다. object는 hold가 걸린 채 bucket에 남는다. 되돌린 세션이 여전히 대상이면 다음 pass가 다시 보관한다. DB에 계속 두려면 그 전에 `SESSION_ARCHIVE_AFTER_DAYS`를 늘리거나 0으로 끈다.
- **일정** — compose는 `maintenance` 서비스가 checkpoint GC 뒤에 주 1회 돈다(`MAINTENANCE_INTERVAL_SEC`, 기본 604800초, Unix epoch부터 센 주기의 배수 시각이라 기본값이면 매주 목요일 00:00 UTC). 바로 한 번 돌리려면 `docker compose exec maintenance bun run apps/control-host/src/api/session-archive.ts`. Kubernetes는 CronJob(`sessionArchive.schedule`, 기본 `0 5 * * 0`)이 api ServiceAccount로 돈다.
- **백업** — 보관한 object는 그 이벤트의 유일한 사본이다. bucket은 DB와 함께 정본이고, 백업과 복원은 `session_event_archives`의 VersionId도 고정한다([backup-restore.md](backup-restore.md)).
- **도구 호출 기록** — `tool_calls`(`schema.ts:1342`), 일별 합계 `tool_call_days`, 도구 설명 `tool_descriptions`
  - 담는 것: 도구 이름, 시각, 결과(`ok`·`failed`·`unknown`), 걸린 시간, 이벤트 id. 입력·출력 본문은 없다. 본문은 이벤트에 있다.
  - 만드는 시점: reconciler가 pass마다 이벤트에서 투영한다(`packages/db/src/tool-calls.ts:72`, 호출 `apps/control-host/src/reconciler/reconcile.ts:185`).
  - 보존 기간: 무기한. 삭제 조건: 없음.
  - `/metrics`의 도구 호출 수는 trigger가 채우는 `tool_call_outcomes`(이름·결과별 수)에서 읽는다. 토큰·비용 합은 같은 방식의 `provider_usage_totals`에서 읽는다. psql로 원본 행을 지우면 trigger가 그 이름·모델의 합을 다시 센다.
- **승인·질문 요청** — `pending_requests`(`schema.ts:1634`)와 `approval_checkpoints`, `permission_grants`, `turn_continuations`
  - 담는 것: 요청 본문 `payload`(`schema.ts:1645`), 답 `answer`(`schema.ts:1654`), 답한 주체 `answered_by`와 답을 허용한 판정 id `answer_decision_id`(`schema.ts:1660-1666`), 닫힌 방식(`settled_outcome`·`settled_reason`).
  - 판정 행(`authz_decisions`)은 감사 보존 기간이 지나면 지워지지만 `answered_by`는 이 행에 남는다. 그래서 기간이 지난 뒤에도 누가 답했는지는 남고, 그 판정의 세부만 사라진다.
  - 만드는 시점: worker가 요청을 등록할 때(`packages/db/src/pending-control.ts:248`).
  - 보존 기간: 무기한. close는 열린 요청에 `resolved_at`만 적는다(`close-control.ts:75-83`).
  - 삭제 조건: `pending_requests`는 없음. `permission_grants`·`turn_continuations`는 대기 중인 turn을 취소할 때 지운다(`packages/db/src/control-unit-of-work.ts:213-217`).
- **실행 이력** — `attempts`(`schema.ts:2036`), `executions`, `worker_launches`, `worker_credentials`
  - 만드는 시점: worker가 세션을 claim할 때(`worker-unit-of-work.ts:1732`)와 scheduler가 worker를 띄울 때.
  - 보존 기간: 무기한. 삭제 조건: 없음.
- **작업 큐** — `queue_messages`, `unassigned_sessions`, `workers`
  - 처리하면 지우는 작업 행이다(예: `packages/db/src/queries.ts:408`, `close-control.ts:86`). 보존 데이터가 아니다.
- **checkpoint 행** — `checkpoints`(`schema.ts:1934`), `checkpoint_outputs`(`schema.ts:1983`)
  - 담는 것: manifest의 object key와 version, 부모 revision, transcript 바이트 수, 성과물 파일의 key와 크기.
  - 만드는 시점: turn 끝에 checkpoint pointer를 올릴 때(`worker-unit-of-work.ts:485`, `508`).
  - 보존 기간: 무기한. GC가 object를 지우면 행에 `collected_at`(`schema.ts:1960`)과 `objects_purged_at`(`schema.ts:1963`)만 적고 행은 남긴다(`packages/db/src/checkpoint-store.ts:251-292`).
  - 닫힌 지 하루가 지났고 열린 push 요청이 없는 세션은 GC pass가 정리를 마치면 `sessions.checkpoint_collection_settled_at`을 적고, 다음 pass부터 읽지 않는다. 하루는 worker 자격 증명의 12시간보다 길어서, 그 뒤에 object를 쓸 attempt가 없다.
  - 설치 사용량의 성과물 바이트는 trigger가 key마다 채우는 `checkpoint_output_objects`와 합계 `checkpoint_output_totals`에서 읽는다.
- **receipt와 멱등 키** — `receipts`(`schema.ts:1538`), `idempotency_keys`(`schema.ts:1612`)
  - 담는 것: 명령(입력, 제어, 공유 변경, GitHub 게이트 등)마다 결과 한 행. 응답의 `X-Request-Id`가 `request_id`로 남는다.
  - 보존 기간: 무기한. 삭제 조건: 없음.
- **GitHub 작업** — `push_requests`(`schema.ts:1814`), `pull_requests`(`schema.ts:1283`), `github_workflow_dispatches`(`schema.ts:578`)
  - 만드는 시점: push 요청 생성(`packages/db/src/push-requests.ts:279`), PR 열기(`packages/db/src/pull-requests.ts:208`), workflow dispatch(`packages/db/src/github-settings.ts:175`).
  - 보존 기간: 무기한. 삭제 조건: 없음.
- **Slack 입출력** — `slack_inbound_events`(`schema.ts:708`), `slack_outbox`(`schema.ts:3037`), `session_links`
  - 담는 것: 받은 Slack 이벤트(본문 `payload`, `schema.ts:726`), 보낼 메시지, Slack 대화와 세션의 연결.
  - 보존 기간: 무기한. 받은 이벤트를 버릴 때는 행을 남기고 `payload`와 `conversation_key`만 비운다(`packages/db/src/slack-inbound-events.ts:179-189`). outbox는 상태만 바꾼다.

## 오브젝트 스토리지 (checkpoint bucket)

bucket은 `S3_BUCKET`(기본 `claude-sessions`, `infra/compose.core.yml:290`, `deploy/helm/werft/values.yaml:138`)이다. 세션 하나의 object는 모두 `sessions/<session id>/` 아래에 있다(`packages/platform/src/checkpoints/checkpoint-service.ts:98-99`). 보호 방식(`CHECKPOINT_OBJECT_PROTECTION`, 기본 `locked`)과 bucket 조건은 [api-server.md](api-server.md)에 있다.

- **transcript** — `sessions/<id>/transcripts/generation-<10자리>/…/part-<n>.jsonl`
  - 담는 것: 엔진(Claude Code)이 쓴 대화 기록 JSONL 원문. 프롬프트, 답변, 도구 입출력이 모두 들어간다.
  - 만드는 시점: turn 도중 엔진이 transcript에 쓸 때마다(`packages/adapters/runtimes/claude/src/session-store.ts:216`, key `:259`, 디렉터리 이름 `packages/runtime-core/src/checkpoint-manifest.ts:482-486`).
  - 상한: part 하나 16 MiB, 합계 512 MiB(`checkpoint-manifest.ts:164-165`). 넘으면 세션이 새 turn을 받지 않는다([capacity.md](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/capacity/)).
  - 보존 기간·삭제 조건: 아래 checkpoint GC를 따른다. 지금 실행 세대(generation)보다 오래된 세대만 지운다.
  - 바꾸기: 상한은 코드 상수라 바꿀 수 없다.
- **checkpoint** — `sessions/<id>/checkpoints/<10자리 revision>/<attempt>/<publish>/` 아래의 `manifest.json`, `workspace-<sha256>.bundle`, `untracked/<sha256>`, `outputs/<sha256>`
  - 담는 것: 작업 공간 git bundle, 추적하지 않는 파일, `out/` 성과물 파일, 그리고 이것들과 transcript를 묶는 manifest(`checkpoint-service.ts:336-346`, 쓰는 곳 `apps/worker/src/session-checkpoints.ts:1101`, `1137`, `1189`, `1314`).
  - 만드는 시점: turn 끝에 worker가 올린다. 모든 쓰기는 create-only다(`packages/storage/src/checkpoint-objects.ts:109-140`).
  - 보존 기간: pointer와 그 부모 `DEFAULT_MAX_RESTORE_FALLBACKS = 3`개(`checkpoint-service.ts:312`), 열린 push 요청이 고정한 revision은 남는다(`packages/platform/src/checkpoints/checkpoint-collector.ts:102-145`).
  - 삭제 조건: checkpoint GC만 지운다(`checkpoint-collector.ts:174-259`, 삭제 `checkpoint-objects.ts:350-371`). Kubernetes 설치는 CronJob이 매주 일요일 04:00에 돈다(`values.yaml`의 `checkpointGc.schedule: "0 4 * * 0"`). compose 설치는 `maintenance` 서비스가 주 1회 돈다. GC는 `locked`에서만 돈다. bucket에 lifecycle 만료 규칙을 두지 않는 이유와 백업과의 관계는 [backup-restore.md](backup-restore.md)에 있다.
  - 바꾸기: Helm `checkpointGc.enabled`·`schedule`·`dryRun`(`values.yaml:258-261`)으로 일정과 실행 여부를 바꾼다. compose에서는 `CHECKPOINT_GC_DRY_RUN`으로 세기만 할 수 있다. 남기는 부모 수(3)는 코드 상수라 바꿀 수 없다.
- **보관한 세션 이벤트** — `session-archive/<session id>/events-<첫 id>-<끝 id>-<nonce>.jsonl.gz`
  - 담는 것: 그 범위의 `events` 행 원문. assistant 텍스트, 도구 입력, 도구 결과 본문이 그대로 들어간다.
  - 만드는 시점: [세션 이벤트 보관](#세션-이벤트-보관) job이 옮길 때. create-only로 쓰고 legal hold를 건다.
  - 보존 기간: 무기한. checkpoint GC는 `sessions/` 아래만 보므로 이 object를 지우지 않는다. lifecycle 만료 규칙도 두지 않는다. 이 prefix에는 storage class 이동만 허용한다.
  - 바꾸기: 없음.
- **로컬 S3의 디스크** — compose의 SeaweedFS는 `local-s3-data` volume에 남는다(`infra/compose.local.yml:30`, `204`). test-ops의 LocalStack은 메모리에만 두므로 컨테이너와 함께 사라진다(`infra/compose.localstack.yml:10-12`).

## worker 작업 공간

- **작업 공간 volume** — Docker는 `werft-ws-<installation>-<session>-…` volume(`packages/adapters/execution/local-docker/src/backend.ts:277`), Kubernetes는 worker마다 PVC
  - 담는 것: 저장소 checkout과 엔진이 쓰는 파일 전부.
  - 보존 기간: 세션이 멈춘 뒤 24시간(`DEFAULT_STOPPED_WORKSPACE_TTL_MS`, `packages/platform/src/scheduler/options.ts:25`, 설정 `EXECUTION_WORKSPACE_STOPPED_TTL_SEC`, `apps/control-host/src/scheduler/config.ts:110-113`). 다시 돌아오지 않을 세션의 volume은 TTL 전에도 지운다.
  - 삭제 조건: scheduler의 작업 공간 회수(`packages/platform/src/scheduler/workspaces.ts:23`). 만든 지 `EXECUTION_WORKSPACE_GC_MIN_AGE_SEC`(기본 3600초)가 지나지 않은 volume은 건드리지 않는다. 지운 뒤에도 세션은 마지막 checkpoint에서 다시 연다. 자세한 규칙은 [실행 기반과 worker 격리](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/execution/).
  - 바꾸기: `EXECUTION_WORKSPACE_STOPPED_TTL_SEC`(compose `infra/compose.core.yml:400`, Helm은 `scheduler.extraEnv`)와 `EXECUTION_WORKSPACE_GC_MIN_AGE_SEC`(Helm `worker.workspace.gcMinAgeSec`, `values.yaml:285`).

## 로그

- **API·worker·scheduler·reconciler·egress proxy의 stdout 로그**
  - 형식: JSON 한 줄(`packages/observability/src/index.ts:131-177`). worker는 자체 logger(`apps/worker/src/console-logger.ts`)를 쓴다.
  - 만드는 시점: 프로세스가 동작할 때마다. `LOG_LEVEL` 기본 `info`.
  - 보존 기간: `infra/compose.core.yml`에 정의된 compose 서비스는 json-file driver로 컨테이너마다 50 MB 파일 5개까지 남기고 오래된 것부터 지운다(`infra/compose.core.yml`의 `x-logging`). `docker inspect -f '{{json .HostConfig.LogConfig}}' <컨테이너>`로 확인한다. scheduler가 띄운 worker 컨테이너와 Kubernetes는 플랫폼이 정하지 않는다. Docker daemon 기본값, 노드의 로그 회전, Datadog의 index 보존이 적용된다([Datadog 감시 기준](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/monitoring-datadog/)).
  - 삭제 조건: 위 회전 말고는 플랫폼이 정하지 않는다.
  - 바꾸기: compose는 `infra/compose.core.yml`의 `x-logging`을 고친다. 그 밖에는 설치처가 Docker log driver, 노드 로그 회전, 수집기에서 정한다. 플랫폼 쪽 설정은 `LOG_LEVEL`(Helm `config.logLevel`) 하나로, 양만 바꾼다.

## 계정·권한·감사 (PostgreSQL)

- **권한 판정 기록** — `authz_decisions`(`schema.ts:1574`)
  - 만드는 시점: 판정할 때(`packages/db/src/authz-decisions.ts:17`). 무엇이 남는지는 [api-server.md](api-server.md#판정-감사와-보존-기간).
  - 보존 기간: 워크스페이스의 `settings.audit_retention_days`, 기본 90일, 30~3650일(`packages/contracts/src/musterrolle/workspaces.ts:33-36`).
  - 삭제 조건: reconciler pass마다(`RECONCILER_INTERVAL_SEC`, 기본 10초) 기간이 지난 행을 오래된 것부터 `RECONCILER_BATCH_SIZE`(기본 100)개씩 지운다(`authz-decisions.ts:82-106`, 호출 `reconcile.ts:180`). `RECONCILER_DRY_RUN=true`면 세기만 한다.
  - 바꾸기: 워크스페이스 owner가 `POST /v1/workspaces/{id}/audit-retention`으로 30~3650일 안에서 바꾼다([api-server.md](api-server.md#판정-감사와-보존-기간)). 지우는 속도는 Helm `reconciler.intervalSec`·`batchSize`(`values.yaml:202`, `206`).
- **로그인 세션** — `web_sessions`(`schema.ts:323`)
  - 보존 기간: 14일(`WEB_SESSION_TTL_MS`, `apps/control-host/src/api/auth.ts:50`), 사용자마다 최대 10개(`auth.ts:55`). 만료된 행은 만료 30일 뒤까지 남는다.
  - 삭제 조건: 그 사용자가 다시 로그인할 때 만료·폐기된 행과, 최근 10개를 넘는 행을 지운다(`packages/db/src/identity.ts`). 다시 로그인하지 않는 사용자의 행은 reconciler pass가 만료 30일 뒤에 `RECONCILER_BATCH_SIZE`개씩 지운다(`deleteExpiredWebSessions`, `EXPIRED_WEB_SESSION_KEEP_DAYS`). `RECONCILER_DRY_RUN=true`면 세기만 한다.
  - 바꾸기: 없음(코드 상수). 아래 Slack 설치 state도 같다.
- **Slack 설치 state** — `slack_install_states`
  - 보존 기간: 600초(`packages/contracts/src/musterrolle/slack-install.ts:41`). 새 설치 링크를 만들 때 만료된 행을, 쓰면 그 행을 지운다(`packages/db/src/slack-install-states.ts:21-41`).
- **비밀값** — `secret_values`(`schema.ts:442`), 마스터 키로 암호화
  - 삭제 조건: 사람이 config token·GitHub App 등을 지울 때만(`packages/db/src/secret-values.ts:185`, `305`).
- **API key** — `api_keys`(`schema.ts:2365`)
  - 삭제 조건: 없음. 폐기는 `revoked_at`만 적는다(`packages/db/src/api-keys.ts:342`).
- **사용자·구성원·초대·연동 계정·binding** — `users`(`schema.ts:183`), `memberships`, `invites`, `password_resets`, `login_methods`, `linked_accounts`, `credential_bindings`, `surface_bindings`, 에이전트 버전·릴리스
  - 보존 기간: 무기한. 초대와 비밀번호 재설정은 만료 칸이 있지만 지우지 않는다. 연동 계정과 binding은 회수만 한다(`schema.ts:782`, `2773`, `3108`). 에이전트 버전·릴리스는 trigger가 수정·삭제를 막는다.

## 토큰·비용·성과물

이 절은 GA-4b 설계([github-agent.md 10절](../contributing/decisions/github-agent.md#10-세션-성과물))가 정한 데이터를 그대로 따른다.

- **호출마다의 사용량** — `provider_usage`(`schema.ts:2081`)
  - 담는 것: Messages 호출 하나의 모델, 토큰 다섯 종류, 도구 요청 수, 추정 비용. 비용·사용량의 정본이다.
  - 만드는 시점: egress proxy가 응답에서 사용량을 읽어 보내면 API가 쓴다(`apps/egress-proxy/src/usage.ts`, `worker-unit-of-work.ts:1917`).
  - 보존 기간: 무기한. 삭제 조건: 없음.
- **세션별 합계** — `sessions.cost_usd`·`provider_tokens`, 세션×모델 합계 `session_model_usage`(`schema.ts:2158`)
  - 만드는 시점: `provider_usage` insert trigger가 더한다(`packages/db/migrations/0127_session_provider_tokens.sql`, `0169_usage_breakdown_rollup.sql`).
  - 보존 기간: 무기한.
- **세션 성과물** — `session_outcomes`, `outcome_refresh_quotas`
  - 이 표는 위 기준 커밋 뒤에 들어왔다(`packages/db/migrations/0200_session_outcomes.sql`, 리뷰는 `0209_session_outcome_reviews.sql`). 그래서 이 항목에는 줄 번호를 적지 않는다.
  - 담는 것: 세션이 남긴 GitHub PR(`github_pull_request`)과 리뷰(`github_review`) 한 건마다 URL, 저장소, release·에이전트, 상태와 그 시각(`state_changed_at`, `merged_at`, `closed_at`). PR 상태는 `open`·`merged`·`closed`이고, 다시 읽은 시각(`state_checked_at`)과 읽기 실패(`check_error`)도 남는다. `metadata`에는 PR이면 제목(최대 200자), head·base 브랜치, merge commit SHA, 변경 규모가, 리뷰면 리뷰한 PR 번호, 리뷰 종류, commit, 그 PR을 연 세션이 들어간다. 리뷰 본문은 남기지 않는다. `outcome_refresh_quotas`는 PR 상태를 다시 읽는 GitHub 호출의 rate limit 창이다.
  - 만드는 시점: PR을 열거나 리뷰를 남기는 트랜잭션에서(`packages/db/src/pull-requests.ts`, `packages/db/src/github-settings.ts`의 `insert(sessionOutcomes)`). push 요청이 연 PR 중 성과물 행이 없는 것은 refresher가 `pull_requests` 행에서 나중에 채운다(`packages/db/src/session-outcomes.ts`의 `fillMissing`). 열린 PR과 닫힌 지 30일이 안 된 PR은 주기적으로 상태를 다시 읽어 행을 고친다. 머지된 PR과 리뷰는 다시 읽지 않는다.
  - 보존 기간: **정해지지 않음.** 설계에도 없다. 지우는 경로도 없다.

## 내용이 남는 곳과 마스킹

프롬프트·답변·도구 입출력은 세 곳에 남는다. 어디서 무엇을 가리는지가 다르다.

- **입력 메시지 원문** — `turns.message`
  - 마스킹: 없음. 받은 그대로 저장한다. 크기만 검사한다(32 KiB, `MESSAGE_MAX_BYTES`, `packages/contracts/src/api/session.ts:555`).
- **이벤트** — `events.payload`의 assistant 텍스트, `tool_use` 입력, `tool_result` 본문, `question`과 `pending_requests.payload`
  - 마스킹: 두 겹이다. Claude adapter의 `sanitizeNativeMessage`가 민감한 키의 값, `Bearer …`·`sk-ant…` 같은 비밀 모양, `password=…` 같은 이름 붙은 값을 `[REDACTED]`로 바꾼다(`packages/adapters/runtimes/claude/src/mapper.ts:52-56`). worker의 `scrubbingGateway`가 이 attempt가 받은 비밀값 자체를 `<redacted>`로 바꾼다(`apps/worker/src/secret-scrubber.ts:107-123`). 엔진이 base64처럼 다시 인코딩한 값은 잡지 못한다(`secret-scrubber.ts:36-40`). 규칙의 차이는 [세션 데이터가 흐르는 길](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/session-data-flow/#비밀값을-어디서-가리나).
  - 열람: 그 세션을 볼 수 있는 주체만 읽는다([세션 데이터가 흐르는 길](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/session-data-flow/)).
- **transcript object** — `sessions/<id>/transcripts/…`
  - 마스킹: 없음. 엔진이 쓴 JSONL을 그대로 올린다(`session-store.ts:255-262`). 세션을 다시 열 때 엔진에 그대로 돌려줘야 하는 원본이라서다. 그래서 이벤트에서 가려진 값도 transcript에는 남을 수 있다.
  - 접근: worker는 자기 세션 prefix에만 쓰고 읽는다. object store 자격 증명은 API와 maintenance 컨테이너에만 있다([api-server.md](api-server.md)).
- **로그** — 내용을 싣지 않는다
  - `sanitizeFields`가 `message`·`body`·`content`·`prompt`·`input`·`output`·`transcript` 같은 이름의 필드를 빼고, 민감한 키의 값과 비밀 모양의 문자열을 `[REDACTED]`로 바꾼다(`packages/observability/src/redaction.ts:12-31`, `54-66`).
  - worker는 예외다. 본문 필드를 빼지 않고 비밀값만 가린다(`apps/worker/src/console-logger.ts:40`). worker는 본문을 로그에 싣지 않는다는 전제이고, 빼는 규칙이 `input_id` 같은 필드까지 지우기 때문이다.

## 트레이스와 플랫폼 정본의 경계

세션 관측(OTel) 방향 결정(2026-10-21)의 결론을 따른다.

- **D1 = C(혼합).** 기능이 기대는 이벤트는 DB `events` 표에 남기고, 이것이 세션 화면·SSE 재연결·turn 종료 판정·질문 알림·복구 판정의 정본이다. 트레이스는 운영자가 고른 OTLP 수집기로 내보내는 관측 신호이고 best effort다. 트레이스가 빠져도 플랫폼의 기록은 그대로다.
- **D11 = OTLP 내보내기까지.** 플랫폼은 span을 만들어 표준 OTLP로 내보내는 데까지 맡는다. 수집기 선택, 수집기 안의 보존 기간, 대시보드는 운영자 몫이다. 그래서 트레이스의 보존 기간은 이 문서가 다루지 않는다.
- **D8.** 이벤트 표 trim은 지금 무기한이고, 정책은 따로 정한다.
- **지금 상태.** API가 OTLP exporter를 갖고 있고 기본은 꺼짐이다. 켜면 로그의 `trace_id`·`span_id`가 활성 span 안에서 채워진다. 엔진의 telemetry는 켜지 않는다. 내보낼 곳(OTLP 엔드포인트·헤더)은 설치처가 설정에서 정하며 키는 [api-server.md](api-server.md#트레이스-내보내기-otlp)에 있다. 켠 설치에서는 트레이스에 내용(프롬프트·답변·도구 입출력)이 기본으로 실린다(D2). 내용을 싣지 않으려면 `TRACE_CONTENT_MODE=metadata`로 설치 상한을 낮춘다. 워크스페이스별 content mode는 아직 없고 설치 상한만 적용된다. 이 절과 [마스킹 절](#내용이-남는-곳과-마스킹)의 트레이스 쪽 마스킹은 그 단위가 들어올 때 더한다.

## 세션 하나 따라가기

세션 하나를 만들고 끝낼 때까지, 무엇이 어디에 남는지 순서대로 읽는다. API는 `sessions:read`·`sessions:write`·`sessions:control` scope를 가진 개인 key 또는 에이전트 key로 부른다. 아래 1의 본문은 개인 key의 것이고, 에이전트 key는 그 에이전트의 `agent_release_id`를 넣고, `repository_id`는 빼면 GitHub 설정 행이 있는 에이전트는 저장소 없이 시작하고 행이 없는 에이전트는 release의 저장소를 쓴다([api-server.md](api-server.md)). `$API`는 API 주소, `$KEY`는 key다. DB는 읽기만 한다. 로컬 compose 스택이면 `docker compose exec -T postgres psql -U postgres -d sessions`로 붙는다.

1. **세션을 만든다.** `POST /v1/sessions`에 `Idempotency-Key`를 붙여 보낸다. 응답의 `session_id`, `turn_id`, `receipt_id`를 적어 둔다.

   ```sh
   curl -sS -X POST "$API/v1/sessions" -H "Authorization: Bearer $KEY" \
     -H "Idempotency-Key: $(uuidgen)" -H 'content-type: application/json' \
     -d '{"agent_release_id":"<release>","repository_id":"<repository>","message":"<prompt>"}'
   ```

2. **turn이 끝날 때까지 읽는다.** `GET /v1/sessions/{id}/turns/{turn_id}`의 `status`가 끝 상태(`completed`·`failed`·`interrupted`·`cancelled`·`outcome_unknown`, `packages/contracts/src/api/session.ts:52-58`)가 될 때까지 몇 초 간격으로 읽는다. 끝난 turn의 `result`가 `turns.result_json`이다.
3. **세션 상태를 읽는다.** `GET /v1/sessions/{id}`의 `status`, `admission_state`, `revision`을 본다.
4. **이벤트를 읽는다.** `GET /v1/sessions/{id}/events`는 SSE다. 처음부터 받아 `event: result`가 나오면 끊는다. `Last-Event-ID`로 이어 받는 법은 [api-guide.md § 5](https://jeongjaesoon.github.io/werft/ko/reference/api-guide/#5-sse로-진행-보기와-last-event-id-재연결).

   ```sh
   curl -sSN --max-time 5 "$API/v1/sessions/$SID/events" -H "Authorization: Bearer $KEY"
   ```

5. **대기 요청을 읽는다.** `GET /v1/sessions/{id}/pending-requests`는 아직 답할 수 있는 열린 요청만 보인다. 승인·질문이 있었다면 답하는 동안 여기서 보고, 답한 뒤의 `answer`·`answered_by`·닫힌 방식은 10의 SQL로 읽는다.
6. **사용량을 읽는다.** `GET /v1/sessions/{id}/usage`. 토큰과 추정 비용이 `provider_usage`에서 온다.
7. **성과물을 읽는다.** `GET /v1/sessions/{id}/outputs`. 마지막 checkpoint의 manifest가 가리키는 `out/` 파일 목록이다.
8. **세션을 닫는다.** 3에서 읽은 `revision`으로 `POST /v1/sessions/{id}/close`를 보낸다. `Idempotency-Key`가 필요하다.

   ```sh
   curl -sS -X POST "$API/v1/sessions/$SID/close" -H "Authorization: Bearer $KEY" \
     -H "Idempotency-Key: $(uuidgen)" -H 'content-type: application/json' \
     -d '{"expected_revision":<revision>,"reason":"<reason>"}'
   ```

   `GET /v1/sessions/{id}`가 `admission_state: closed`가 될 때까지 읽는다. 닫힌 세션은 다시 열 수 없고, 새 메시지는 `409 SESSION_CLOSED`다.
9. **receipt를 읽는다.** 1의 `receipt_id`로 `GET /v1/receipts/{id}`.
10. **DB에 남은 것을 센다.** 닫은 뒤에도 행이 그대로인지 본다. `<id>`는 세션 id다.

    ```sql
    SELECT status, admission_state, cost_usd, provider_tokens FROM sessions WHERE id = '<id>';
    SELECT sequence AS turn_id, status, octet_length(message) AS message_bytes FROM turns WHERE session_id = '<id>';
    SELECT type, count(*) FROM events WHERE session_id = '<id>' GROUP BY type ORDER BY type;
    SELECT name, outcome FROM tool_calls WHERE session_id = '<id>';
    SELECT kind, answer->>'decision' AS decision, answered_by->'principal'->>'kind' AS answered_by, settled_outcome, resolved_at IS NOT NULL AS resolved FROM pending_requests WHERE session_id = '<id>';
    SELECT model, input_tokens, output_tokens FROM provider_usage WHERE session_id = '<id>';
    SELECT revision, manifest_ref, collected_at FROM checkpoints WHERE session_id = '<id>';
    ```

    `decision`은 권한 요청에만 있고 질문 행에서는 비어 있다. `tool_calls`는 reconciler가 다음 pass에서 채우므로 몇 초 늦을 수 있다. checkpoint의 `manifest_ref`가 bucket 안의 manifest key다. 그 아래 object는 [오브젝트 스토리지](#오브젝트-스토리지-checkpoint-bucket) 절의 경로에 있다.

## 이벤트 저장 형태

**현재 형태 유지.** 이벤트 한 건이 `events` 한 행이고, 본문은 `payload jsonb`에 기본 압축(pglz)으로 둔다. payload에 GIN 인덱스는 두지 않는다. 다른 형태와 견준 결과다(2026-11-01).

측정 조건: PostgreSQL 16과 MongoDB 7.0 컨테이너. 세션 20개에 이벤트 20,000건씩, 모두 40만 건이다. 그중 15%는 2~11 kB 도구 결과이고, payload 원문은 659 MB다. 페이지 읽기는 세션 중간에서 100건, 추가는 4 kB 도구 결과 1건이다. 둘 다 30번 잰 중앙값이다.

| 형태 | 디스크 (heap + TOAST + 인덱스) | 페이지 읽기 | 추가 | 백업 |
| --- | --- | --- | --- | --- |
| 행 + jsonb, pglz (지금) | 475 MB (207 + 222 + 43) | 1.29 ms | 1.13 ms | 24.3 MB |
| 행 + jsonb, TOAST lz4 | 498 MB (204 + 248 + 43) | 1.31 ms | 1.22 ms | 24.2 MB |
| 세션당 jsonb 문서 하나 | 236 MB, 추가 31번 뒤 601 MB | 18.38 ms | 324.73 ms | 127.0 MB |
| 별도 문서 저장소 (MongoDB) | 143 MB (131 + 인덱스 12) | 1 ms | 1 ms 미만 | 39.1 MB |

백업은 PostgreSQL이 `pg_dump -Fc -t <표>`, MongoDB가 `mongodump --archive --gzip`의 바이트 수다.

- **lz4로 바꾸지 않는다.** 압축되는 값(2 kB가 넘는 6만 건)에서 pglz보다 11% 크고(TOAST 248 MB 대 222 MB), 읽기와 추가 시간은 같다.
- **세션당 문서는 쓰지 않는다.** 추가할 때마다 30 MB쯤 되는 문서 전체를 다시 쓴다. 그래서 추가가 300 ms를 넘고, vacuum 전까지 쓸 때마다 디스크가 는다. 페이지 하나를 읽어도 문서 전체를 풀어야 한다. worker 재전송을 걸러 내는 (`attempt_id`, `source_sequence`) 확인도 문서 안을 뒤져야 한다.
- **별도 저장소로 옮기지 않는다.** 디스크는 3분의 1이다. 작은 값까지 블록 단위로 압축하기 때문이다. 하지만 읽기와 추가는 지금과 같다. 이벤트는 turn·대기 요청·receipt와 한 트랜잭션에 쓰인다(`worker-unit-of-work.ts`). 저장소가 둘이 되면 이 원자성과 백업 시점의 일치가 깨지고, 운영할 저장소가 하나 는다.
- 디스크 크기는 이벤트 보존 기간과 trim 정책(아래 결정할 항목의 첫 줄)으로 다룬다.

다시 재는 법. PostgreSQL 쪽은 빈 데이터베이스를 하나 만들어 `BENCH_DATABASE_URL=postgresql://… bun packages/db/bench/event-storage.ts 20 20000`을 돌린다. MongoDB 쪽은 같은 행을 `SELECT row_to_json(…) FROM ev_row`로 `mongoimport`에 넘긴다. 그다음 `(session_id, id)` 인덱스와 (`session_id`, `attempt_id`, `source_sequence`) unique 인덱스를 만들고, `db.events.stats()`와 같은 읽기·추가로 잰다.

## 결정할 항목

다음은 지금 기본값이 없어 「정해지지 않음」 또는 「무기한」으로 남은 항목이다. 정책을 정하는 일은 이 문서의 범위 밖이다.

- 보관한 이벤트 object의 보존 기간. 지금은 무기한이고 지우는 경로가 없다.
- 세션과 그에 딸린 행(`sessions`, `turns`, `tool_calls`, `pending_requests`, `provider_usage`, `receipts` 등)의 보존 기간과, 세션 삭제 API를 둘지.
- 입력 원문(`turns.message`)과 transcript object의 마스킹 여부. 지금은 둘 다 가리지 않는다.
- 닫힌 세션의 마지막 checkpoint와 transcript object의 보존 기간. 지금 GC는 pointer와 부모 3개를 늘 남기므로 닫힌 세션의 object도 무기한 남는다.
- worker 컨테이너와 Kubernetes의 프로세스 로그 보존 기간(Docker daemon 기본값, 노드 로그 회전, 수집기 보존).
- 만료된 초대·비밀번호 재설정 행의 정리.
- `session_outcomes`의 보존 기간.
