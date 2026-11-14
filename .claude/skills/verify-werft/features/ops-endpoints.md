# 운영 조회

운영자와 호출자는 스택이 준비됐는지, API 문서와 설치 상한·세션 사용량이 어떤지 읽는다.

## Sub-features

- `readyz` `GET /readyz` → `{"status":"ready","checks":{"database":"ok","schema":"ok","config":"ok"}}`.
- `docs` `GET /docs` → API reference HTML.
- `limits` `GET /v1/limits` → 설치 상한과 사용량. 로그인한 workspace owner만 읽는다.
- `usage` `GET /v1/sessions/{id}/usage` → 세션 비용·대기 입력 수.
- `summary` `GET /v1/usage/summary?scope=me|installation&since=&until=` → 기간에 만든 세션의 수·비용·token·실행 시간 합. `installation`은 owner만.

## How to get to it (user POV)

- 브라우저나 curl로 `$API/readyz`, `$API/docs`.
- key 호출자: `/v1/sessions/{id}/usage`, `/v1/usage/summary?scope=me`.
- owner의 웹 cookie(`ap_as owner` 뒤 `ap_web`): `/v1/limits`, `/v1/usage/summary?scope=installation`. 홈과 `/usage` 화면이 부르는 방식이다.

## Driving it with lib.sh

Preconditions:

- `doctor.sh <run id>`가 ready. `/v1/*`에는 `sessions:read` key.

```sh
. .claude/skills/verify-werft/scripts/lib.sh <run id>
```

- **준비.** `curl -sS "$API/readyz"` → 위 JSON.
- **문서.** `curl -sS -o "$EVIDENCE/docs.html" -w '%{http_code} %{content_type}\n' "$API/docs"` → `200 text/html; charset=utf-8`.
- **상한.** `ap_as owner; ap_web GET /v1/limits` → `200`, `scope: "installation"`, `limits.execution_slot_limit` 등. member cookie나 `ap_get`(key)은 `403 FORBIDDEN`.
- **기간 합계.** `ap_get "/v1/usage/summary?scope=me&since=$(date -u +%Y-%m-01)"` → `200`, 개인 key는 발급한 사람이 웹·개인 key로 시작한 세션을 합산한다. 발급자가 없는 key는 자기 key가 시작한 세션만 합산한다. member cookie로 `scope=me`는 그 사람의 세션(개인 key로 만든 것 포함), `scope=installation`은 owner만 `200`이고 나머지는 `403`.
- **사용량.** `ap_get "/v1/sessions/$SID/usage"` → `200`.
- **브라우저 확인**이 필요하면 Orca의 `orca tab`으로 `$API/docs`를 연다(작업 전 브라우저 잠금이 있으면 잡고, 끝나면 푼다).

## Gotchas

- `/readyz`는 인증이 없다. `/v1`은 key도 웹 cookie도 없으면 401.
- `/docs`는 외부 스크립트 없이 열리는 정적 HTML이다. 브라우저 확인은 필수가 아니다.

`/operations/usage` 화면은 “사용량·한도”다. 내 사용량과 owner 전용 설치 전체를 고른다. 세션·실행 시간·추정 비용·토큰과 UTC 집계 기준을 표시하고 owner에게만 한도 표를 보인다. summary의 period는 생성 시각 기준 `[since,until)`이고 basis는 created_in_period·provider_usage_estimate·turn_wall_clock이다. 절차: [procedures.md](procedures.md) P-API-USAGE·P-WEB-USAGE. 소스: `packages/contracts/src/api/usage.ts`, `packages/platform/src/usage/usage-service.ts`, `apps/web/src/routes/usage.tsx`.
