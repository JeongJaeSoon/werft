# 결정(설계): owner가 관리 기록을 목록으로 보고 내보낸다

- 상태: 설계. 코드는 바꾸지 않는다. 단계는 [6절](#6-단계별-구현-계획)에 있다.
- 기준 커밋: `origin/main` `0d53825e5`. `파일:줄`은 이 커밋에서 읽었다.
- 관련 결정: [관측과 도구 호출 감사](observability-otel-and-tool-call-audit.md), [접근 판정 하나로](access-decisions.md), [Musterrolle 모듈 경계](musterrolle-boundary.md). 운영 문서: [판정 감사와 보존 기간](../../operator/api-server.md#판정-감사와-보존-기간).
- 티켓 번호: 저장소의 마크다운은 티켓 번호를 적지 못한다(`tests/docs-links.test.ts`). 번호는 이 문서를 들인 PR 본문에 있다.

## 요약

- owner가 워크스페이스의 관리 기록을 콘솔과 API로 본다. 지금은 DB를 직접 읽어야 하고, API로는 `GET /v1/receipts/{id}`로 한 건씩만 읽는다.
- 원천은 이미 있는 두 표다: 무엇이 바뀌었나(`receipts`)와 누가 무엇을 하려다 허용·거절됐나(`authz_decisions`). 새 기록 표는 만들지 않는다.
- 읽기 API 하나: `GET /v1/audit/events`. 시간 역순 cursor 페이지이고, 같은 경로에 `Accept: application/x-ndjson`을 주면 같은 거름의 행 전체를 한 줄에 하나씩 흘려 보낸다(내보내기).
- 누가 읽나: owner만. 새 action `audit_log.read`를 판정으로 묻고, 허용도 기록한다(기록을 읽은 일이 기록에 남는다).
- 화면: 설정 > 워크스페이스 아래 "감사 기록" 목록 하나(기간·종류·사람 거름, 내보내기 단추, 보존 기간 안내).
- 1차 범위 밖: API key로 읽기, SIEM으로 밀어 보내기, OCSF 모양, 도구 호출 감사(`tool_call_audits`). [6절](#6-단계별-구현-계획)의 "나중" 단계다.

## 1. 지금 있는 것

### 두 원천

| | `receipts` | `authz_decisions` |
|---|---|---|
| 정의 | `packages/db/src/schema.ts:2223` | `packages/db/src/schema.ts:2259` |
| 한 행 | 상태를 바꾸는 명령 하나. `operation`(`packages/contracts/src/api/receipt.ts:29`의 값 144개: 세션 명령과 관리 작업), `target_ref`, `status`, `result`·`error`, `actor`, `request_id` | 판정 하나. 주체(`principal_kind`·`principal_id`·`actor_user_id`·`agent_id`), `action`, 대상(`resource_kind`·`resource_id`), `outcome`, `reason_code`, `justification`, `surface`, `policy_version`, `request_id` |
| 무엇이 남나 | 명령을 받은 모든 receipt | 거절·`redact`·`require_approval`은 모두. 허용은 관리 action, 승인, Slack 입력만([운영 문서](../../operator/api-server.md#판정-감사와-보존-기간)) |
| 고칠 수 있나 | `status`·`result`·`updated_at`이 명령의 진행에 따라 바뀐다 | 아니다. UPDATE는 trigger가 거절한다 |
| 보존 | 기간 없음. 세션처럼 지우지 않는다([데이터 보존](../../operator/data-retention.md)) | 워크스페이스의 `audit_retention_days`(기본 90일, 30~3650). reconciler가 지난 행을 지운다 |
| 시간 인덱스 | `receipts_owner_created_at_idx (owner_id, created_at)` 있음 | `authz_decisions_at_idx (at)`뿐. **`(owner_id, at)` 인덱스가 없다** |
| 두 표를 잇는 것 | `request_id` | `request_id`(응답의 `X-Request-Id`) |

관리 쓰기는 요청 하나에 판정 행 하나를 남긴다. 저장소가 잠금 아래에서 거절한 규칙(owner 보호, 자기 보호, 마지막 owner 등)도 그 요청의 `deny` 한 줄이다. 그래서 "누가 무엇을 하려 했고 어떻게 됐나"는 판정 행이 답하고, "무엇이 실제로 바뀌었나"는 같은 `request_id`의 receipt가 답한다.

### 읽는 길

- `GET /v1/receipts/{id}`(`packages/platform/src/sessions/session-service.ts:1546`)는 한 건을 읽는다. receipt가 가리키는 에이전트를 읽을 수 없는 사람에게는 없는 receipt와 같은 `404`를 준다(같은 파일의 `hiddenAgentRefs`). DB 쪽은 `(id, owner_id)` 한 줄 조회다(`packages/db/src/postgres-unit-of-work.ts:1824`).
- 판정 행을 읽는 API는 없다.
- 보존 기간은 owner가 `POST /v1/workspaces/{id}/audit-retention`으로 바꾼다(`audit_retention.manage`, owner만, `packages/platform/src/musterrolle/policy.ts:321`).
- 이름이 비슷한 `session.audit_read`는 다른 것이다. 공유 밖 세션을 이유를 적고 읽는 관리자 동작이다.

## 2. 조사 요약과 시장 동향

공개 문서 조사(2026-11-20). 확인하지 못한 것은 그렇게 적었다.

### 제품들이 하는 것

| 제품 | 목록 API | 내보내기·흘려 보내기 | 누가·보존 |
|---|---|---|---|
| GitHub (enterprise·org) | `GET /enterprises/{e}/audit-log`. 거름은 검색식(`phrase`: actor, action, created 등), cursor(`after`·`before`), `per_page` 최대 100, 기본 최신 먼저([REST](https://docs.github.com/en/enterprise-cloud@latest/rest/enterprise-admin/audit-log)) | 화면에서 JSON·CSV, git 이벤트는 gzip NDJSON(100MB·10분 상한, [내보내기](https://docs.github.com/en/enterprise-cloud@latest/admin/monitoring-activity-in-your-enterprise/reviewing-audit-logs-for-your-enterprise/exporting-audit-log-activity-for-your-enterprise)). 흘려 보내기: S3, Azure Blob·Event Hubs, Datadog, GCS, Splunk HEC. 최소 한 번 전달, 멈춤 동안 7일 보관([streaming](https://docs.github.com/en/enterprise-cloud@latest/admin/monitoring-activity-in-your-enterprise/reviewing-audit-logs-for-your-enterprise/streaming-the-audit-log-for-your-enterprise)) | enterprise 관리자, org은 owner만([org](https://docs.github.com/en/organizations/keeping-your-organization-secure/managing-security-settings-for-your-organization/reviewing-the-audit-log-for-your-organization)). 웹 이벤트 180일 |
| Slack | `GET /audit/v1/logs`. `oldest`·`latest`, `action`(최대 30개), `actor`, `entity`, cursor, 최신 먼저([API](https://docs.slack.dev/reference/audit-logs-api/methods-actions-reference)) | 화면에서 CSV·JSON([도움말](https://slack.com/help/articles/360000394286-Audit-logs-in-Slack)). 직접 밀어 보내기는 확인 못 함 | Enterprise의 org Owner token(`auditlogs:read`). 행에 `context`(IP, UA, session)([개요](https://docs.slack.dev/admins/audit-logs-api)). 보존은 확인 못 함 |
| Okta | System Log API. `since`·`until`, 거름식(eventType, actor, target, outcome), 불투명 `after` cursor. `until` 없이 오름차순이면 끝없이 이어지는 폴링 모드([API](https://developer.okta.com/docs/reference/system-log-query/)) | EventBridge·Splunk Cloud로 흘려 보내기, 거름·재전송 없음, 최소 한 번([log streams](https://help.okta.com/en-us/content/topics/reports/log-streaming/about-log-streams.htm)). event hook(HTTPS POST, [hooks](https://developer.okta.com/docs/concepts/event-hooks/)) | 90일. 행에 `outcome.result`, 묶음용 `transaction.id` |
| Google Workspace | Reports API `activities.list`. 시작·끝 시각, eventName, 거름식, `pageToken`, 기본 1000행([API](https://developers.google.com/workspace/admin/reports/reference/rest/v1/activities/list)) | API로 당겨 가기 | 6개월, 바꿀 수 없음([보존](https://knowledge.workspace.google.com/admin/reports/data-retention-and-lag-times)). 행에 `events[].status` |
| Atlassian | `GET /admin/v1/orgs/{orgId}/events`(cursor, from·to, action, actor, ip). 폴링용 `/events-stream`(2025-05부터 분당 10회, [API](https://developer.atlassian.com/cloud/admin/organization/rest/api-group-events/)) | CSV 최대 10,000행·180일, 비동기로 만들어 하루짜리 링크를 메일로([내보내기](https://support.atlassian.com/security-and-access-policies/docs/export-audit-logs/)) | org 관리자. Guard 등급에 따라 최대 1년, 없으면 org 이벤트를 남기지 않음([열람](https://support.atlassian.com/security-and-access-policies/docs/view-audit-log-activities/)) |
| Notion | 질의 API는 확인 못 함 | 거른 집합의 CSV. 워크스페이스마다 webhook 하나로 실시간 JSON(24시간 동안 7번 재시도) | Enterprise의 org owner. 365일. 화면 거름: 날짜, 사람·에이전트, 종류, teamspace, 관련 이벤트([도움말](https://www.notion.com/help/audit-log)) |

### 시장 동향 (대략 2026-05 ~ 2026-11)

- **목록 API는 어디에나 기본이다.** 시간 범위, 행위자, 종류 거름, 불투명 cursor, 최신 먼저가 공통이다. 보존은 90일(Okta)에서 1년(Notion, Atlassian Guard)이고, 긴 보존은 상위 요금제다.
- **밀어 보내기는 위쪽 제품부터.** GitHub은 여러 대상(S3, HEC, Datadog)으로, 중간 제품은 webhook 하나(Notion)나 고정된 파트너 둘(Okta)로 보낸다. 모두 최소 한 번 전달이고 받는 쪽이 event id로 중복을 거른다. 당겨 가는 API는 그대로 기본이다.
- **OCSF.** 스키마는 1.9.0이고 API Activity가 클래스 6003이다([schema](https://schema.ocsf.io/classes/api_activity)). AWS AppFabric이 SaaS 감사 기록을 OCSF로 바꿔 Security Lake에 넣는다([AppFabric](https://docs.aws.amazon.com/appfabric/latest/adminguide/security-lake.html)). 그러나 제품이 직접 OCSF를 내보내기보다는 제3자 변환이 대부분이다([AWS 블로그](https://aws.amazon.com/blogs/security/patterns-for-consuming-custom-log-sources-in-amazon-security-lake)).
- **NDJSON.** GitHub이 대량 내보내기를 gzip NDJSON으로 준다. 작은 제품은 비동기 내보내기 작업으로 JSON Lines를 준다.
- **거절도 남긴다.** OWASP 로깅 지침은 인가·인증 실패를 결과와 이유, 상관 id와 함께 남기라고 한다([OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)). Okta(`outcome.result`)와 Google(`events[].status`)이 결과 칸을 둔다. GitHub·Slack·Notion이 거절 시도를 남기는지는 확인 못 했다.

## 3. 따를 것과 다르게 갈 것

### 따를 것

- **owner만 읽는다.** GitHub org, Slack, Notion이 모두 최고 관리자에게만 연다.
- **목록 API의 모양.** 시간 범위, 행위자, 종류, 결과 거름. 불투명 cursor. 최신 먼저. 페이지 상한(200)은 GitHub(100)과 Google(1000) 사이다.
- **거절을 같은 흐름에 둔다.** OWASP 기본이고, werft는 요청마다 판정 행 하나(허용 또는 이유 있는 거절)를 이미 남긴다.
- **상관 id로 묶는다.** Okta의 `transaction.id`처럼 `request_id`가 판정과 receipt를 묶는다. 화면은 같은 `request_id`의 행을 묶어 보인다.
- **보존 창 밖은 보이지 않는다.** 모든 제품이 보존 기간을 넘은 행을 API에서 내지 않는다.
- **NDJSON 내보내기.** GitHub의 대량 내보내기 모양을 따른다.

### 다르게 갈 것

| 무엇 | 다른 제품 | werft | 이유 |
|---|---|---|---|
| 내보내기 방식 | 비동기 작업과 만료 링크(Atlassian), 화면 CSV(Slack, Notion) | 같은 경로의 동기 NDJSON 스트림, 끝 줄, 100,000행 상한 | 자체 호스팅이라 파일 저장소와 메일을 가정할 수 없다. 보존 창 안의 행 수는 스트리밍으로 충분하다. CSV는 화면이 NDJSON에서 만들 수 있으나 1차에 넣지 않는다 |
| IP·user agent | Slack, Okta, GitHub은 행에 담는다 | 담지 않는다 | 두 원천 표에 칸이 없다. 넣으려면 쓰는 경로를 모두 바꾸고 개인정보 보존을 다시 정해야 한다. 열린 질문으로 둔다 |
| 밀어 보내기 | 위쪽 제품의 기본 | 나중 단계(C2) | 재시도·순서·비밀 보관과 대상별 adapter가 필요하다. 당겨 가는 API가 먼저다 |
| OCSF | 제3자 변환이 대부분 | 고유 모양을 쓰고, OCSF는 나중에 선택 형식(C3) | 표준이 아직 제품 쪽에 퍼지지 않았다. 고유 모양을 먼저 안정시키고 변환은 포트 뒤에 둔다 |
| 원천 | 대개 하나의 감사 표 | 기존 두 표를 합쳐 읽는다 | 4절. 새 표는 두 기록을 맞추는 일을 만든다 |
| API key로 읽기 | 대개 관리자 token·scope로 당겨 간다 | 1차는 owner의 로그인 세션만, key는 C1 | 관리 action은 key에 열지 않는 것이 지금 규칙이다(`MANAGEMENT_ROLES`). 예외는 따로 정한다 |

## 4. werft 아키텍처 적용

### 누가 무엇을 갖나

| 자리 | 하는 일 |
|---|---|
| `packages/contracts` (musterrolle) | `auditEventSchema`, 목록 요청 거름(`from`·`to`·`kind`·`actor_user_id`·`action`·`outcome`·`cursor`·`limit`), 응답 `{ items, next_cursor }`, NDJSON 끝 줄. action 값 `audit_log.read` |
| `packages/platform` (musterrolle) | `AuditLogService`: 판정을 묻고(`requirePermitted(…, "audit_log.read", { kind: "workspace", id })`), 보존 기간 창을 정하고, 포트 `AuditLogReader`에서 페이지를 받아 응답 모양으로 바꾼다. 내보내기도 같은 서비스가 페이지를 이어 부른다 |
| `packages/db` (musterrolle) | `createPostgresAuditLogReader`: 두 표를 각각 keyset으로 읽어 합친다. 새 파일 하나와 통합 시험 하나 |
| `apps/control-host` | route `GET /v1/audit/events`(JSON과 NDJSON), OpenAPI, 응답 표 |
| `apps/web` | 설정 > 워크스페이스 > 감사 기록 화면 |

판정 정책은 `MANAGEMENT_ROLES`에 `"audit_log.read": ["owner"]`를 더한다. 관리 action이므로 API key는 scope와 상관없이 거절되고, 허용은 기록 대상에 넣는다. 감사 기록을 읽은 일과 내보낸 일 자체가 감사 기록에 남아야 하기 때문이다.

### 한 행의 모양

두 원천을 한 모양으로 보인다. 원천이 다르다는 것은 `kind`로 남긴다.

```json
{
  "kind": "decision",
  "id": "…",
  "at": "2026-11-20T06:51:25.123Z",
  "request_id": "…",
  "actor": { "principal_kind": "user", "principal_id": "…", "user_id": "…", "agent_id": null },
  "action": "member.manage",
  "target": { "kind": "workspace", "id": "…" },
  "outcome": "deny",
  "reason_code": "owner_protected",
  "surface": "web"
}
```

- `kind: "receipt"`면 `action`은 `operation`, `target`은 `target_ref`에서 고른 종류와 id, `outcome`은 receipt `status`, `reason_code`는 없음, `at`은 `created_at`이다.
- receipt의 `result`·`error` 본문은 싣지 않는다. 자세한 것은 `GET /v1/receipts/{id}`가 지금의 숨김 규칙대로 준다. 목록이 새 공개 경로가 되지 않게 하려는 것이다.
- 사람 이름은 싣지 않는다. 화면은 구성원 목록으로 id를 이름으로 바꾸고, 떠난 사람은 id로 보인다.

### 시간 창과 보존

- 목록과 내보내기는 두 원천 모두 보존 창(`now - audit_retention_days`) 안의 행만 준다. receipts는 지우지 않으므로 더 오래된 행이 DB에 있어도 이 API로는 나오지 않는다. 한쪽만 더 길게 보이면 "판정 없는 receipt"가 생겨 읽는 사람이 헷갈린다.
- `from`이 창보다 앞이면 창의 시작으로 바꾸고, 응답에 `retention_start`를 준다. 화면은 이것으로 "보존 기간 밖은 나오지 않습니다"를 적는다.
- receipts에도 보존 기간을 적용할지는 이 문서가 정하지 않는다(8절 열린 질문). receipts는 세션의 일부라 지우는 일이 세션 보존 정책과 묶여 있다.

### 페이지

- 순서는 `(at, kind, id)` 역순이다. `kind`의 순서는 문자열 순서(`decision` < `receipt`)다. 같은 밀리초의 행도 순서가 하나로 정해진다.
- cursor는 마지막 행의 `(at, kind, id)`를 담은 불투명한 문자열이다. offset은 쓰지 않는다. 쓰는 동안 행이 늘어도 페이지가 밀리지 않는다.
- 경계 조건은 표마다 **세 칸 전체**를 비교한다. 각 표는 자기 `kind`를 상수로 넣는다: receipts는 `(created_at, 'receipt', id) < ($at, $kind, $id)`, 판정은 `(at, 'decision', id) < ($at, $kind, $id)`. 두 칸 `(at, id)`만 비교하면 같은 시각의 다른 표 행이 id 크기에 따라 빠지거나 두 번 나온다. 두 표를 각각 이 조건과 `ORDER BY at DESC, id DESC LIMIT n+1`로 읽고, 합쳐 `(at, kind, id)` 역순으로 정렬한 뒤 n개를 자른다. `kind` 거름이 하나면 한 표만 읽는다.
- 시험 fixture: 같은 시각에 두 표의 행을 두고, id 크기가 receipt 쪽이 큰 경우와 판정 쪽이 큰 경우를 모두 만든다. 페이지 크기 1로 넘기며 목록과 내보내기 이어 받기 모두에서 빠짐과 겹침이 없음을 본다.
- 늦게 commit되는 행: 먼저 시작해 늦게 끝난 transaction의 행은 이미 지나간 cursor보다 앞 시각일 수 있다. 사람이 보는 목록과 한 번의 내보내기에서는 다음에 다시 읽으면 보인다. 같은 cursor로 계속 당겨 가는 쪽(C1)에는 최근 몇 초를 늦게 내는 지연 창이 필요하고, 그 단계에서 정한다.
- `limit` 기본 50, 최대 200.
- 인덱스: `receipts`는 `(owner_id, created_at)`이 이미 있다. `authz_decisions`에는 `(owner_id, at)` 인덱스를 새로 둔다(1단계의 migration). 지금 있는 `(at)` 인덱스만으로는 워크스페이스 하나의 행을 찾으려고 모든 워크스페이스의 최근 행을 훑는다.

### 내보내기

- 같은 경로, 같은 거름에 `Accept: application/x-ndjson`. 응답은 `200`과 `Content-Type: application/x-ndjson`이고, 한 줄에 위 모양의 행 하나다. 서버는 페이지(500행)를 이어 읽어 흘려 보내고, 메모리에 전부 모으지 않는다.
- 마지막 줄은 끝 표시 `{"kind":"end","rows":N,"truncated":false}`다. 끝 줄이 없으면 받는 쪽은 중간에 끊긴 것을 안다.
- 한 번에 최대 100,000행. 넘으면 끝 줄이 `truncated: true`와 `next_cursor`를 준다. 이어 받으려면 그 cursor로 다시 부른다.
- 한 워크스페이스에 동시 내보내기는 하나. 두 번째는 `429`다. 한 번의 내보내기는 최대 10분이다. 넘으면 끝 줄 없이 끊고, 받은 마지막 행의 cursor로 이어 받는다.
- 허용 기록은 시작할 때 한 번 남긴다. 거름은 판정 행에 넣지 않는다(판정 행에는 본문 칸이 없다).
- **흘려 보내는 동안 권한을 다시 본다.** 판정 한 번으로 오래 흘려 보내면, 그사이 owner가 강등되거나 로그아웃해도 남은 행을 계속 받는다. 그래서 두 가지를 한다.
  - 로그인: 세션 이벤트 스트림의 credential watchdog(`apps/control-host/src/api/routes/sessions/events.ts:164`)과 같은 방식으로 `reauthenticate`를 주기적으로 부른다. DB를 기다리거나 출력이 막혀(backpressure) 있어도 타이머가 따로 돈다. 확인이 유효한 시각을 넘으면 다음 줄을 쓰지 않는다.
  - 역할: 페이지(500행)를 읽기 전마다 `audit_log.read`를 기록 없이(`record: false`) 다시 묻는다. 거절이면 끝 줄 없이 끊는다.
  - 둘 다 실패를 거절로 다룬다. 끊긴 내보내기는 끝 줄이 없으므로 받는 쪽이 완전하지 않음을 안다.

### 고른 것과 고르지 않은 것

| 안 | 판단 | 이유 |
|---|---|---|
| 기존 두 표를 읽는다 | **채택** | 이미 append-only(판정)이고 보존 정리가 있다. 새 표는 두 기록을 맞추는 일을 새로 만든다 |
| 새 `audit_events` 표에 두 원천을 복사한다 | 기각 | 쓰는 경로마다 한 번 더 쓰고, 두 사본이 어긋날 수 있다. 읽기 성능은 인덱스 하나로 충분하다 |
| 요청 하나를 한 행으로 합친다(판정 + receipt) | 기각(1차) | 판정 없는 receipt(기록하지 않는 허용, 예: 세션 명령)와 receipt 없는 판정(거절)이 많아 합친 행의 반이 비어 있다. 화면이 `request_id`로 묶어 보이는 것으로 충분하다 |
| offset 페이지 | 기각 | 쓰기가 계속 오는 표에서 페이지가 밀린다 |
| 비동기 내보내기 작업(파일 만들고 링크) | 기각(1차) | 저장소와 만료가 필요하다. 보존 창 안의 행 수는 스트리밍으로 충분하다. 크기가 커지면 다시 본다 |
| admin도 읽는다 | 기각(1차) | admin의 거절 기록에는 owner의 결정이 담긴다. owner만으로 시작하고 요구가 생기면 넓힌다 |

## 5. 실패 모드

- 판정 실패(DB 오류 등)는 거절이다. 지금 `authorize`와 같다.
- 보존 기간을 읽지 못하면 거절한다. 기본 90일로 대신하면 줄인 기간보다 오래된 행을 보일 수 있다.
- 스트리밍 도중 DB 오류는 연결을 끊는다. 끝 줄이 없으므로 받는 쪽이 안다.
- 같은 시각 행이 페이지 경계에 걸려도 표마다 세 칸 전체를 비교하므로 빠지거나 겹치지 않는다(4절 시험 fixture).
- 내보내기 도중 강등·로그아웃·세션 폐기는 끝 줄 없는 종료다. 10분을 넘긴 내보내기도 같다.

## 6. 단계별 구현 계획

단계 하나는 PR 하나이고, 단계마다 티켓 하나를 만든다. 구현은 오너가 시작을 정한 뒤 티켓 순서대로 한다. "앞선 단계"가 티켓의 blocked-by다.

### 지금

| 단계 | 내용 | PR | 끝난 조건 | 앞선 단계 |
|---|---|---|---|---|
| A 읽기 API와 내보내기 | `authz_decisions (owner_id, at)` 인덱스 migration, contracts 모양, `audit_log.read` 판정(owner만, 허용 기록), `AuditLogService`, db reader, `GET /v1/audit/events`(JSON 페이지와 NDJSON), OpenAPI와 운영 문서 | 1 | db 통합 시험(두 표 합치기, 같은 시각 경계에서 id 크기가 양쪽으로 뒤집힌 fixture로 빠짐·겹침 없음, 보존 창, 다른 워크스페이스 안 보임), route 통합 시험(owner 200, admin·member·API key 403과 그 거절 행 하나, 허용 행 하나), NDJSON 끝 줄과 상한, 느린 내보내기 도중 강등·로그아웃 → 끝 줄 없이 종료. 실제 스택에서 demo owner로 목록·내보내기 확인 | — |
| B 콘솔 화면 | 설정 > 워크스페이스 > 감사 기록: 기간·종류·사람 거름, 페이지 넘김, 같은 `request_id` 묶음 표시, 내보내기 단추, 보존 기간 안내. owner가 아니면 메뉴도 경로도 없음 | 1 | 화면 시험(빈 상태, 거절 행, 긴 값), 390px·1280px light·dark 캡처, 실제 스택에서 거절을 만든 뒤 화면에서 찾기 | A |

### 나중

| 단계 | 내용 | 앞선 단계 |
|---|---|---|
| C1 API key로 읽기 | SIEM이 당겨 가도록 읽기 전용 scope(예: `audit:read`)를 owner가 발급하는 key에만. 관리 action을 key에 열지 않는 지금 규칙의 예외라서 따로 정한다 | A |
| C2 밀어 보내기 | 워크스페이스별 대상(HTTP 수신처, 객체 저장소)으로 새 행을 보낸다. 재시도·순서·비밀 보관이 필요하다 | A |
| C3 OCSF 모양 | 내보내기에 OCSF 클래스(API Activity, Account Change, Authentication)로 바꾼 모양을 선택으로 둔다 | A |
| C4 도구 호출 감사 | `tool_call_audits`를 세 번째 `kind`로. 세션 단위 권한과 묶여 있어 owner 목록에 넣을지 따로 정한다 | A |

## 7. 이행

- migration은 인덱스 하나(`CREATE INDEX CONCURRENTLY`)뿐이다. 칸이나 표는 바꾸지 않는다.
- `POLICY_VERSION`을 올린다(새 action).
- 섞인 버전: 옛 control-host는 새 경로를 모르므로 `404`다. 화면은 새 웹과 새 API가 같이 나가므로 문제가 없다.

## 8. 열린 질문

1. receipts에도 보존 기간을 적용할까. 지금은 세션과 함께 영구 보존이다. 이 API는 보존 창 밖을 보이지 않으므로 결정이 미뤄져도 동작은 같다.
2. admin에게도 열까. 1차는 owner만.
3. 사람 거름은 `actor_user_id`만 받는다. API key·에이전트 주체로 거르는 일은 요구가 생기면 더한다.
4. 행에 IP·user agent를 둘까. 다른 제품은 대개 둔다. 두 원천 표의 쓰는 경로를 모두 바꾸고 개인정보 보존을 다시 정해야 하므로 따로 정한다.
