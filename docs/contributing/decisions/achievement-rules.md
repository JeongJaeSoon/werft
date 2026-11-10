# 결정: 워크스페이스 성과 규칙과 판정

- 후속(2026-11-11): 실행 프로필은 통째로 지웠다(migration `0266_remove_profiles`, 기존 데이터는 이전하지 않고 지움). 이 문서의 프로필·상한·롤아웃 언급은 그때의 기록이다. 지금은 에이전트 release가 provider 연결과 카드 모델로 실행 spec(런타임·도구·권한 모드)을 고정하고, 묻기·막기 규칙은 워크스페이스와 에이전트의 실행 규칙(`workspace_engine_settings`, `agent_engine_settings`)이 정한다.
- 상태: **최종본, 오너 승인(2026-11-02).** 구현은 [9절](#9-구현-분할)의 티켓 순서로 한다. 구현 중 이 문서와 다르게 만들 일이 생기면 바꾸기 전에 오너에게 묻는다.
- 기준 커밋: `origin/main` `7f5803032`. 아래 `파일:줄`은 모두 이 커밋 기준이다.
- 오너 원문(2026-11-02): "세션 중에 pr 만드는거 확인했잖아 이런것들을 성과로 등록하는 대응을 진행하고 싶어 … 성과가 되는게 어떤건지 자연어로 정의 해서 자동으로 db 에 등록되도록 하고 이 판단하는걸 decision api 를 사용하면 어떨까 … 성과 룰이라는 워크스페이스 설정? 프로필? (에이전트 별로 달라질수 도 잇으려나 )을 넣고 이를 바탕으로 decisiona api 가 판단해서 성과인지 아닌지 그리고 그에 따른 데이터 타입이 미리 정해져있어서 그를 바탕으로 db 에 저장되고 화면에 성과물로 표시되는게 좋지 않는가 … 성과물 룰은 전용 설정 ui 이가 있어서 (이렇게 되면 일단 워크스페이스 쪽에서만 정의할수 있게하는게 맞는거 같기도하네) 거기에 규칙을 하나씩 지정할수 잇는거지 예를들어 구분, 제목, 성과 정의 (문장 설명) type_name? 같은거 db 에 들어갈것들"
- 추가 오너 원문(2026-11-02): "decision api 를 실시간으로 계속 사용하면 비용이 많이 들테니까 턴 10회마다 한번되게 한다거나 이걸 사용자가 설정할수 잇게하고 llm 엔드포인트 설정이나 어떤 모델을 쓸지도 사용자가 커스텀할수 잇어야겟네 ?"
- 추가 오너 원문 2(2026-11-02): "decision api 라하는건 jev 나 luna 같은걸 말하는거야"
- 추가 오너 원문 3(2026-11-02): "성과 규칙의 판정모델이 sonnet 이나 haiku 로 되어있는데 luna decision api 나 jev decision api 를 기준으로 하도록 해줘 / 성과 type 도 사람이 추가할수 잇게해하는게 좋지않을까 / 그리고 구분도 사람이 추가할수 잇게하는게 좋을듯 ??? 그래서 구분이 대분류? 카테고리? 가 되는거고 그 제목이랑 성과 type, 성과 정의는 1:1:1 로 연결되는거지 / 그리고 대상 pr 은 pr 에만 의존하는 내용이니까 지워야할거같은데 ???"
- 승인 원문(2026-11-02): "그거 말고는 성과나 성과 규칙의 수집 데이터나 정보의 표현 방법은 모두 적절한거 같아 또 구현하다가 각색하지 말고 내 피드백 반영 후 설계해서 구현진행해줘"
- 오너 피드백 반영 범위(오케스트레이터 정리): 판정기 Luna만, 구분을 사람이 추가, 제목·성과 type·성과 정의 1:1:1, 사람이 추가한 성과 type은 공통 칸만, 규칙의 '대상 PR' 칸 삭제. 그 밖의 수집 데이터와 표현은 바꾸지 않았다.
- 화면 셋: 설정 아래 "성과 규칙"(판정 설정·구분·성과 type·규칙), 세션 상세 결과물 탭 위의 성과 카드(확인·거절, 판정 줄), 워크스페이스 성과·성과당 비용(ROI). 오너가 승인한 시안은 repo 밖에 있고, 각 화면 티켓(AR-6·AR-7·AR-8)이 시안을 가리킨다.

## 0. 무엇을 골랐나 (한 장 요약)

**두 층.** 아래 층은 코드가 쓰는 **근거 사실**, 위 층은 규칙이 정하는 **성과**다.

| 층 | 무엇 | 누가 쓰나 | 지금 |
|---|---|---|---|
| 근거 사실 | 세션이 실제로 한 일: PR 열기·머지, 리뷰 제출, `out/` 파일 | 플랫폼 코드 | PR은 이미 있다(`session_outcomes`). 리뷰를 더한다 |
| 성과 | 워크스페이스 규칙에 맞은 것 | 판정기 하나. 규칙마다 "바로 인정"(판정기 안 부름) 또는 "Luna 판정" | 새로 만든다 |

- **판정기는 Luna 하나다.** OpenAI Decisions API(`POST /v1/decisions`, 모델 `gpt-6-luna`). 글을 만들지 않고 고르기·확률만 답하는 판정 전용 API다([1절](#decision-api-luna)). Sonnet·Haiku 같은 글 생성 모델로 판정하는 경로는 두지 않는다. 판정기 안의 백엔드 interface는 남겨 둔다.
- **설정의 세 단계: 구분 → 규칙 → 성과 type.** 구분(카테고리)은 사람이 만들고 이름을 바꾸고 보관한다. 규칙은 구분 아래 한 줄이고 **제목·성과 type·성과 정의가 1:1:1**이다. 성과 type 하나는 사용 중인 규칙 하나에만 묶인다.
- **성과 type도 사람이 만든다.** 사람이 만든 type은 이름·key와 **근거 종류**(PR·리뷰·`out/` 파일·대화, 코드에 고정된 목록) 하나로 이루어지고, 그 성과 행은 **공통 칸만** 가진다(제목·링크·근거 종류·근거 id). 내장 type 셋(`pull_request`·`code_review`·`document`)만 구조화 칸(`payload`)을 가진다. 자유 JSON 스키마는 두지 않는다([2절](#성과-type의-데이터-모양-세-후보)).
- **규칙에는 PR에만 맞는 칸이 없다.** "머지된 PR만" 같은 조건은 성과 정의 문장에 쓰고, Luna가 근거의 상태를 보고 판정한다. PR 고유 정보는 근거 쪽에만 있다.
- **판정 주기 기본값: 근거가 생기거나 바뀔 때만.** 근거 없는 세션은 판정하지 않으므로 비용 0이다. "N턴마다"(기본 10, 최소 5)와 "세션이 멈출 때"를 설정에서 켠다.
- **엔드포인트는 새 설정 체계를 만들지 않는다.** 연결 표(`provider_connections`, 설정 DB 이전 S1)에 kind `openai_decisions` 하나를 더해 고른다. 모델은 `gpt-6-luna` 하나라 고르는 칸이 없다.
- **판정 비용은 세션 비용과 따로 센다.** 판정 1회(근거 요약) 약 $0.00025. 워크스페이스 하루 판정 예산을 둔다.
- **PR·리뷰 근거의 성과는 바로 집계되고, `out/` 파일이나 대화로 인정한 성과는 사람이 확인해야 ROI에 들어간다.**

## 1. 지금 구조

### decision API: Luna

오너가 말한 것은 플랫폼 밖의 판정 전용 API이고, 고른 것은 Luna다. 아래 값은 벤더가 공표한 값이다. 요청·응답 모양은 구현 전에 공식 문서로 다시 확인한다.

| | OpenAI Decisions API ("Luna") |
|---|---|
| 모양 | `POST /v1/decisions`. 모델은 `gpt-6-luna` 하나. 고르기(choice) 질문에 답하고 선택지별 확률·confidence를 준다. 글은 만들지 않는다 |
| 시기 | 2026-09-29 preview, 2026-10-06 공개 |
| 비용 | 입력 $0.10/Mtok, 출력 과금 없음 |
| 호스팅 | OpenAI 직접. Bedrock에는 없다 |

판정 기록에는 `backend` 칸(값 `luna` 하나)을 둔다. 나중에 백엔드가 늘어도 지난 판정을 구분하기 위해서이고, 지금 백엔드를 고르는 설정은 없다.

### 코드 안의 "decision"

코드의 decision은 셋이고, 모두 위 API와 상관없다.

- 권한 판정 로그: `authorize`가 `allow`·`deny`를 내고 `authz_decisions`에 남긴다(`apps/control-host/src/api/server.ts:448`, `packages/db/migrations/0137_authz_decisions.sql:17-22`, `apps/control-host/src/api/routes/workspaces.ts:40-56`).
- 사람의 결정: push 요청 승인·거절(`packages/contracts/src/api/push-request.ts:15`, `:111`), 권한 답변의 `allow`·`deny`(API 이름은 `action`, 저장 키는 `decision`, `packages/contracts/src/api/answer.ts`).
- 복구 결정(`packages/contracts/src/api/control.ts:42-69`).

플랫폼이 스스로 밖의 모델 API를 부르는 곳은 **세션 제목 짓기 하나**다. control-host가 짧게 사는 토큰(`wet_`)을 만들어 egress proxy의 provider 경로로 부르고, proxy가 자격 증명을 붙인다(`packages/platform/src/sessions/session-titler.ts:12-21`, `:44-66`, `packages/platform/src/workers/worker-gateway.ts:996-1031`). 판정기는 이 호출 경로(토큰 → proxy → 자격 증명은 proxy만)를 따른다. 부르는 API는 다르다.

### 성과의 아래 층은 이미 절반 있다

- `session_outcomes`(0200)는 "세션이 만든 것"을 type과 함께 남기는 표이고, type은 `github_pull_request` 하나다(`packages/db/migrations/0200_session_outcomes.sql:9-35`, `packages/contracts/src/api/session-outcome.ts:9-14`). 설계는 `docs/contributing/decisions/github-agent.md` 10절이다. 원칙 둘을 이어받는다. (1) 근거 종류는 등록된 목록이다. (2) **서버만 쓴다.** 사람이나 에이전트가 직접 적으면 ROI가 자기 보고가 되기 때문이다.
- PR 행은 PR을 열 때 같은 트랜잭션에서 생기고(`packages/db/src/pull-requests.ts:105-135`, `:234`), `outcome-refresher`가 GitHub에 물어 `open`·`merged`·`closed`를 고친다(`packages/platform/src/sessions/outcome-refresher.ts:54`, 연결 `apps/control-host/src/api/server.ts:874`).
- 세션 상세 "결과물" 탭이 PR을 1분마다 다시 읽어 보인다(`apps/web/src/routes/session-outputs.tsx:76-92`, `:128-161`). ROI 집계 API `GET /v1/usage/outcomes`는 있지만 화면은 없다(`apps/control-host/src/api/openapi.ts:5017`).
- **리뷰는 receipt만 있다.** `GitHubWorkService.review`가 `review_pull_request` receipt에 번호·commit·event·`review_id`·PR을 연 세션을 남긴다. GitHub가 돌려준 리뷰 `html_url`은 버린다(`packages/platform/src/sessions/github-work-service.ts:252-305`).
- **GitHub 작업은 모두 플랫폼을 지난다.** worker는 GitHub 토큰을 받지 않고, PR 열기·리뷰·dispatch는 control-host의 게이트를 지난다(github-agent.md 3절). 그래서 PR·리뷰라는 사실은 코드가 빠짐없이 안다. 판정기가 필요한 것은 "어떤 PR이 이 워크스페이스의 성과인가"(예: 버그 수정 PR만, 머지된 PR만)나, 사실로 남지 않는 일(대화 속 문제 해결)을 가릴 때다.
- `out/` 파일은 마지막 checkpoint의 manifest에 있다(`packages/platform/src/sessions/output-service.ts:42-44`). 에이전트가 직접 쓰는 파일이라 게이트를 지난 사실은 아니다.

### 비용·연결

- 세션 비용은 egress proxy가 잰 호출마다 `provider_usage`에 쌓이고 세션 행에 더해진다. 이 표는 `session_id`·`attempt_id`가 NOT NULL이다(`packages/db/src/schema.ts:2366-2433`). 판정 호출을 여기 넣으면 세션 비용에 섞인다.
- 연결 kind는 `anthropic`·`litellm` 둘뿐이고(`packages/platform/src/sessions/catalog.ts:119-136`), egress proxy에 OpenAI로 가는 경로가 없다. Luna를 쓰려면 연결 kind 하나와 proxy 경로 하나가 새로 필요하다.
- 연결은 DB(`provider_connections`)에 있다(`docs/contributing/decisions/settings-replace-file-catalog.md`).
- 가격표는 플랫폼이 가진다(`packages/platform/src/limits/model-prices.ts:41-64`). `gpt-6-luna`는 없다.

## 2. 대안 비교

| | A. 정적(근거 종류만으로 인정) | B. 모든 규칙을 Luna로 | **C. 두 층(고름)** |
|---|---|---|---|
| 무엇 | 근거가 생기면 그 종류의 규칙이 늘 성과로 센다 | 모든 규칙·근거 쌍을 Luna에 보낸다 | 근거 사실은 코드가, 성과 여부는 규칙마다 "바로 인정" 또는 "Luna 판정" |
| 비용 | 0 | 판정마다 약 $0.00025 | "바로 인정" 규칙은 0, Luna 규칙만 근거가 생기거나 바뀔 때 |
| 정확도 | 사실에는 정확. "버그 수정 PR만"·"머지된 PR만" 같은 뜻은 못 가린다 | 뜻을 가린다. 사실은 근거가 받쳐 준다 | 같음 |
| 감사·재현 | 같은 입력 같은 결과 | 확률·규칙 버전·입력 digest를 남겨 판정을 다시 따라갈 수 있다 | 같음 |
| 프롬프트 인젝션 | 없음 | 판정기는 예·아니오만 고르므로 속아도 바뀌는 것이 그 하나 | 같음 |
| 오너 요구 | 자연어 정의가 장식이 된다 | 그대로 | 그대로 + "리뷰는 다 센다" 같은 규칙을 공짜로 |

A·B는 C의 두 판정 방식이다. 그래서 C는 A나 B를 먼저 만들고 바꾸는 길보다 크지 않다.

### 설계 후보(구조가 다른 둘)

- **C1(고름): 근거 표와 성과 표를 나눈다.** `session_outcomes`는 근거 사실로 두고 종류를 넓힌다. 성과는 새 표 `session_achievements`에 둔다. 성과를 쓰는 곳은 판정기 하나뿐이다("바로 인정"도 판정기가 한다).
- **C2: `session_outcomes` 하나에 `source`·`rule_id`·`review_state` 칸을 더한다.** PR 전용 칸(state·lease·`check_error`)과 `UNIQUE (session_id, type, url)`이 근거 없는 성과와 맞지 않고, "누가 이 행을 쓰나"가 둘(PR 서비스·판정기)이 된다(design-red-flags의 split ownership). 고르지 않았다.

### 성과 type의 데이터 모양: 세 후보

| | **T1. 내장 type만 구조화, 사람 type은 공통 칸만 (고름)** | T2. type마다 자유 JSON 스키마 | T3. 모든 type에 근거 종류별 스냅샷 |
|---|---|---|---|
| type을 만들 때 고르는 것 | 이름, key, 근거 종류(코드 목록) | 이름, key, JSON Schema | 이름, key, 근거 종류 |
| 칸은 누가 채우나 | 공통 칸과 내장 `payload` 모두 코드가 근거에서 채운다 | 누군가 채워야 한다. Luna는 글을 만들지 않으므로 채울 주체가 없다 | 코드 |
| 집계·화면 | 모든 성과가 같은 공통 칸이라 한 표로 집계한다. 내장 type 셋의 칸만 화면이 안다. 사람 type의 PR 정보는 `evidence_id`로 근거 행을 읽어 보인다 | type마다 화면·집계가 스키마를 읽어 그려야 한다 | PR 정보가 근거 행과 성과 행 두 곳에 생긴다 |
| 검증 | 내장 type zod 스키마 3개(코드) | 워크스페이스마다 다른 스키마를 런타임 검증 | 근거 종류별 zod 스키마 4개 |

T2를 고르지 않은 이유: (1) 판정기가 글을 만들지 않으므로 칸을 채울 주체가 없다. (2) 사람이 스키마를 바꾸면 앞 성과 행과 모양이 어긋나 집계가 깨진다. (3) 화면과 ROI 집계가 워크스페이스마다 다른 모양을 알아야 한다. T3을 고르지 않은 이유: PR 고유 정보는 근거 쪽에 둔다는 오너 피드백과 맞지 않고, 같은 사실을 두 곳에 복사한다. 사람 type의 성과도 `evidence_id`가 근거 행을 가리키므로 "머지된 버그 수정 PR 수" 같은 집계는 근거 행을 조인해 셀 수 있다.

## 3. 개념과 데이터 모델

### 이름

| 화면 | 코드·DB | 뜻 |
|---|---|---|
| 근거 | `session_outcomes` (그대로) | 플랫폼이 직접 본 사실 |
| 구분 | `achievement_categories` (새) | 규칙을 묶는 대분류. 사람이 만든다 |
| 성과 type | `achievement_types` (새) | 성과의 종류. 내장 셋 + 사람이 만든 것 |
| 성과 규칙 | `achievement_rules` (새) | 구분 아래 한 줄: 제목·type·정의 |
| 판정 | `achievement_judgments` (새) | 판정 한 번의 기록: 입력·비용·결과 |
| 성과 | `session_achievements` (새) | 규칙에 맞아 성과로 센 것 |

영어 `outcome`은 이미 근거 표가 쓰므로 새 개념은 `achievement`로 둔다.

### 근거 종류 (코드에 고정한 목록)

근거 종류는 플랫폼이 무엇을 직접 보는지에 달려 있으므로 사람이 더할 수 없다. 더할 때는 코드와 마이그레이션이 같이 간다.

| 근거 종류 | 출처 | 근거 id | Luna에 보이는 것 | 성과의 `review_state` |
|---|---|---|---|---|
| `github_pull_request` | `session_outcomes` PR 행 | 그 행 id | 저장소·번호·상태·머지 시각·변경 규모·PR 제목(200자) | `auto` |
| `github_review` | `session_outcomes` 리뷰 행(새) | 그 행 id | 저장소·번호·event | `auto` |
| `out_file` | 마지막 checkpoint의 `out/` 목록 | `path` | 경로·크기·앞 2,000자 | `needs_review`(에이전트가 쓴 파일) |
| `conversation` | 대화 | 없음 | 최근 20턴 발췌(최대 16,000토큰) | `needs_review` |

### 근거 추가: `github_review`

`session_outcomes`의 CHECK에 `github_review`를 더한다. 리뷰 서비스가 성공 receipt를 쓰는 같은 트랜잭션에서 행을 넣는다(`github-work-service.ts:296-304`). `url`은 GitHub가 돌려준 리뷰 `html_url`, `external_id`는 `review_id`, `state`는 `submitted` 하나, `metadata`는 `{ number, event, commit_id, opened_by_session_id }`다. 리뷰 본문은 넣지 않는다. refresher는 이 행을 읽지 않는다(부분 인덱스가 PR만 본다, `0200_session_outcomes.sql:39`).

PR 행의 `metadata`에 `title`(200자)을 더한다. Luna가 "버그 수정 PR"을 가리려면 제목이 필요하다. 본문은 넣지 않는다. github-agent.md 10절의 "제목·본문은 넣지 않는다"를 제목에 한해 바꾼다.

### `achievement_categories` (새)

| 열 | 규칙 |
|---|---|
| `id` uuid PK, `workspace_id` | |
| `name` | 1~32자. 워크스페이스 안에서 보관 안 된 것끼리 유일. 바꿀 수 있다 |
| `position` | 화면 순서 |
| `created_by`, `created_at` | |
| `archived_at`, `archived_by` | 보관. 사용 중인 규칙이 남아 있으면 보관할 수 없다(`409 category_in_use`) |

- 이름은 성과 행에 복사하지 않는다. 화면은 지금 이름으로 묶는다. 이름을 바꾸면 지난 성과도 새 이름 아래 보인다.
- 워크스페이스를 만들 때 넣는 구분은 없다. 첫 규칙을 만들 때 구분도 만든다.

### `achievement_types` (새)

| 열 | 규칙 |
|---|---|
| `id` uuid PK, `workspace_id` | |
| `key` | `type_name`. `[a-z][a-z0-9_]{1,40}`. 워크스페이스 안에서 유일. **바꿀 수 없다**(성과 행·집계·API가 이 값으로 묶는다) |
| `name` | 화면 이름 1~40자. 바꿀 수 있다 |
| `evidence_kind` | 위 근거 종류 하나. **바꿀 수 없다** |
| `builtin` | 내장 셋이면 true. 워크스페이스를 만들 때(그리고 마이그레이션으로 기존 워크스페이스에) 넣는다 |
| `created_by`, `created_at`, `archived_at`, `archived_by` | 보관. 사용 중인 규칙이 있으면 보관할 수 없다. 내장 type은 보관할 수 없다 |

내장 type 셋과 `payload`(코드가 근거에서 복사, zod로 검사):

| key | 근거 종류 | `payload` |
|---|---|---|
| `pull_request` | `github_pull_request` | `repository`, `number`, `url`, `state`, `merged_at`, `additions`, `deletions` |
| `code_review` | `github_review` | `repository`, `number`, `url`, `event`, `commit_id` |
| `document` | `out_file` | `path`, `size` |

- 사람이 만든 type의 성과는 `payload`가 null이다. 화면은 근거 종류가 PR·리뷰면 `evidence_id`로 근거 행을 읽어 상태를 보인다.
- key·근거 종류를 바꾸고 싶으면 새 type을 만들고 규칙을 새 버전으로 옮긴다. 지난 성과는 옛 type에 남는다.
- 워크스페이스당 type은 보관 안 된 것 50개까지다.

### `achievement_rules` (새)

| 열 | 규칙 |
|---|---|
| `id` uuid PK | 버전마다 새 id |
| `workspace_id`, `family_id`, `version` | 같은 규칙의 버전 묶음. `UNIQUE (family_id, version)` |
| `category_id` | 구분 |
| `title` | 1~80자 |
| `type_id` | 성과 type |
| `definition` | 성과 정의 1~2,000자. Luna 판정의 질문에 그대로 들어간다 |
| `judge` | `always`(바로 인정, 판정기 안 부름) 또는 `luna` |
| `agent_ids` | null이면 모든 에이전트. 1차 화면은 null만 |
| `created_by`, `created_at` | |
| `superseded_by` | 다음 버전 id. 최신 버전이면 null |
| `disabled_at`, `disabled_by` | 사용 중지. family의 최신 버전에만 둔다 |

- **1:1:1.** 규칙 한 줄이 제목 하나·type 하나·정의 하나를 갖는다. 그리고 type 하나는 사용 중인 규칙 하나에만 묶인다: `UNIQUE (type_id) WHERE superseded_by IS NULL AND disabled_at IS NULL`. 그래서 같은 type의 성과는 언제나 한 정의로 센다. 다른 정의가 필요하면 type을 새로 만든다.
- **행은 바뀌지 않는다.** 구분·제목·type·정의·판정 방식을 고치면 같은 `family_id`의 `version + 1`이 생기고 앞 버전은 `superseded_by`를 가진다. 성과 행은 판정에 쓴 버전 id를 가리킨다.
- **PR에만 맞는 칸은 없다.** "열렸을 때/머지됐을 때" 같은 조건은 정의 문장에 쓴다("머지된 PR만 성과다"). 그런 규칙은 `luna`로 판정하고, 근거가 바뀌면(머지) 다시 판정한다. `always` 규칙은 그 근거 종류의 근거가 처음 생길 때 조건 없이 센다.
- 워크스페이스당 사용 중인 규칙은 최대 30개다.

### 워크스페이스 판정 설정 (`workspaces.settings`에 한 칸)

`dispatch_model`처럼 워크스페이스 설정 스키마(`packages/contracts/src/musterrolle/workspaces.ts:42-62`)에 `achievement_judge`를 더한다.

| 칸 | 기본값 | 뜻 |
|---|---|---|
| `connection_id` | null | kind `openai_decisions` 연결 하나. null이면 `luna` 규칙은 판정하지 않고 "판정기 없음"으로 보인다. `always` 규칙은 늘 돈다 |
| `threshold` | 0.9 | "예"의 확률이 이 값 이상이면 성과 |
| `on_evidence` | true | 근거가 생기거나 바뀔 때 판정 |
| `every_n_turns` | null | 켜면 N턴마다(5~100). `conversation` 근거 type 규칙이 있을 때만 의미가 있다 |
| `on_idle` | false | 세션이 멈출 때(idle·pause·close) 한 번 |
| `transcript` | `recent` | `conversation` 규칙에 보낼 대화: `none`·`recent`(최근 20턴, 최대 16,000토큰, 도구 결과 제외) |
| `daily_budget_usd` | 1 | 워크스페이스 하루 판정 비용 상한. 넘으면 그날 판정은 미룬다 |
| `max_per_session` | 20 | 세션 하나의 판정 횟수 상한 |

### `achievement_judgments` (새)

| 열 | 규칙 |
|---|---|
| `id` uuid PK, `workspace_id`, `owner_id`, `session_id` | |
| `trigger` | `evidence`·`turns`·`idle`·`manual` |
| `status` | `queued`·`running`·`succeeded`·`failed`·`deferred`(예산)·`skipped`(판정기 없음) |
| `rules` jsonb | 판정에 쓴 규칙 버전 id 목록 |
| `evidence_ids` | 판정에 넣은 근거 |
| `input_digest` | 보낸 입력의 sha256. 같은 입력을 다시 보내지 않는다 |
| `backend`, `connection_id` | `backend`는 `luna` |
| `calls`, `input_tokens`, `cost_usd` | **판정 비용 원장.** 세션 비용과 따로 |
| `threshold` | Luna에 물을 때 쓴 워크스페이스 문턱. 물은 것이 없으면 null. 성과는 자기를 만든 판정의 값을 보인다 |
| `error_code`, `attempts`, `next_attempt_at` | 실패·재시도 |
| `lease_token`, `lease_expires_at` | 판정기가 집었다는 표시(refresher와 같은 방식) |
| `created_at`, `finished_at` | |

### `session_achievements` (새)

| 열 | 규칙 |
|---|---|
| `id` uuid PK, `workspace_id`, `owner_id`, `session_id` | |
| `agent_id`, `agent_release_id` | 세션에서 복사 |
| `rule_id`, `rule_family_id`, `type_id` | 판정에 쓴 규칙 버전과 그 type |
| `title` | 공통 칸. 코드가 정한다: PR·리뷰는 `owner/repo#번호`, 파일은 경로, 대화는 세션 제목 |
| `link` | 공통 칸. PR·리뷰 URL, 파일은 세션 결과물 탭의 그 파일, 대화는 세션 링크 |
| `evidence_kind`, `evidence_id` | 공통 칸. 근거. `conversation`은 id null |
| `payload` jsonb | 내장 type만. 위 표의 모양을 zod로 검사. 사람 type은 null |
| `judge` | `always`·`luna` |
| `probability` | Luna의 "예" 확률. `always`면 null |
| `judgment_id` | |
| `review_state` | `auto`(PR·리뷰 근거, 바로 집계)·`needs_review`·`confirmed`·`rejected` |
| `reviewed_by`, `reviewed_at`, `review_note` | |
| `superseded_at`, `superseded_by` | 다시 판정해 결과가 바뀌면 앞 행을 덮지 않고 내린다 |
| `created_at` | |

- 판정기가 글을 만들지 않으므로 요약 칸은 없다. 사람이 확인할 때 `review_note`에 적을 수 있다.
- 중복 막기: `UNIQUE (rule_family_id, session_id, evidence_id) WHERE evidence_id IS NOT NULL AND superseded_at IS NULL`, `conversation`은 `UNIQUE (rule_family_id, session_id) WHERE evidence_id IS NULL AND superseded_at IS NULL`.
- **사람의 결정이 이긴다.** `confirmed`·`rejected` 행은 다시 판정해도 바뀌지 않는다.
- **쓰는 것은 판정기뿐이다.** 성과를 직접 만드는 API는 없다. 사람은 확인·거절만 한다.

## 4. 판정 흐름

```
근거가 생김·바뀜 ─┐ (PR 서비스·리뷰 서비스·refresher의 같은 트랜잭션, out/은 checkpoint 커밋 때)
N턴째 끝남 ───────┼─▶ achievement_judgments (queued, 세션당 queued 하나로 합친다)
세션 멈춤 ────────┘
                 │  판정기 loop (API replica마다, 30초, FOR UPDATE SKIP LOCKED + lease)
                 ▼
     1. 그 세션에 맞는 사용 중 규칙을 읽는다
     2. 규칙을 그 type의 근거 종류에 맞는 근거와 짝짓는다
     3. always 규칙: 짝마다 바로 성과 행 (비용 0)
     4. luna 규칙: 예산·횟수 확인 → 짝마다 고르기 질문 → 확률 ≥ 문턱이면 성과
     5. 성과 행 + 판정 결과를 한 트랜잭션으로
```

- **합치기.** 세션에 `queued` 판정이 이미 있으면 새로 만들지 않고, 그 판정의 trigger를 가장 최근 trigger로 바꾼다. 마지막 trigger 뒤 2분이 지난 것만 집는다.
- **N턴.** 턴이 끝날 때 control-host가 끝난 턴 수를 보고 `% N = 0`이면 넣는다. 세션 제목을 짓는 지점과 같은 곳이다(`worker-gateway.ts:1980`). `conversation` 근거 type 규칙이 없으면 넣지 않는다.
- **무엇을 다시 보나.** 근거가 바뀌면(PR 머지) 그 근거와 짝인 규칙만 다시 판정한다. 같은 규칙 버전·같은 `input_digest`는 다시 보내지 않는다. "아니오"였던 PR이 머지되면 입력(상태)이 바뀌었으므로 다시 묻는다.

### Luna에 보내는 것

짝(규칙, 근거)마다 고르기 질문 하나다. 규칙은 자기 type의 근거 종류에만 대므로 짝의 수는 작다(규칙 2개 × 근거 2개면 4번).

```text
question: 아래 <definition>에 비추어, <evidence>는 이 워크스페이스의 성과인가?
choices:  ["yes", "no"]
input:    <definition>{규칙의 성과 정의}</definition>
          <evidence kind="github_pull_request">repo, number, state, merged_at, additions, deletions,
             <untrusted>PR 제목(200자)</untrusted></evidence>
→ { choice, probabilities: { yes: 0.94, no: 0.06 } }    yes ≥ threshold면 성과
```

- `out_file`은 경로·크기와 `<untrusted>`의 파일 앞 2,000자, `conversation`은 `<untrusted>`의 최근 대화 발췌를 넣는다.
- 확률은 성과 행의 `probability`에 남는다. 이유 글은 없다. 화면은 "정의에 맞을 확률 0.94"로 보인다.

### 프롬프트 인젝션 막기

세션 대화, PR 제목, 파일 내용은 누구든 쓸 수 있는 글이다(Slack 손님, 저장소 내용, 에이전트 자신). 판정기가 속아도 할 수 있는 일을 좁힌다.

1. **판정기는 글을 만들지 않는다.** 답은 `yes`·`no`와 확률뿐이라 속아도 바뀌는 것은 그 짝 하나의 예·아니오다.
2. **사실은 지어낼 수 없다.** 짝은 코드가 만들고, 성과 행의 모든 칸은 코드가 근거에서 채운다.
3. **에이전트가 쓴 글이 근거인 성과는 사람 확인 전 집계에 들지 않는다.** `out_file`·`conversation`은 늘 `needs_review`다.
4. **최악의 경우**는 PR 하나가 성과로 잘못 세지거나 빠지는 것이고, 화면에서 거절할 수 있다.

### 판정 비용 (Luna: 입력 $0.10/Mtok, 출력 무료. 벤더 공표값)

| 입력 | 짝 하나의 입력 토큰 | 짝 하나 | 판정 1회(짝 4개) |
|---|---|---|---|
| 근거 요약 (PR·리뷰) | 약 600 | $0.00006 | **약 $0.00025** |
| 파일 앞 2,000자 | 약 1,200 | $0.00012 | — |
| 최근 대화 발췌 | 약 16,500 | $0.00165 | — |

세션 하나(30턴, PR 하나 열고 머지, 리뷰 하나, Luna 규칙 2개)의 판정 비용:

| 주기 | 판정 | 세션 하나 | 세션 1,000개/월 |
|---|---|---|---|
| **근거가 생길 때만 (기본)** | PR 열림+리뷰는 합쳐 1, 머지 1 → 2 | 약 $0.0005 | **약 $0.5** |
| + 10턴마다 대화 규칙 1개 | + 3 | 약 $0.0055 | 약 $5.5 |

- 기본 하루 예산 $1이면 근거 판정 약 4,000회다.

### 비용 분리와 호출 경로

- 판정기는 egress proxy를 지난다. 자격 증명은 proxy만 붙이는 지금 규칙(세션 제목과 같다)과 egress 허용 목록을 지키기 위해서다. proxy에 `/decisions/v1/decisions` 경로를 더하고 `openai_decisions` 연결의 키를 붙인다. 오류 본문에 자격 증명 조각이 들어 있을 수 있으므로 proxy와 판정기는 오류 본문을 남기지 않는다.
- 판정 토큰은 제목 토큰처럼 control-host가 만든다(새 접두 `wej_`). 지금 egress grant는 `session_id`·`attempt_id`를 돌려주는데(`worker-gateway.ts:1027-1031`), 판정 grant는 대신 `judgment_id`를 돌려주고 proxy의 사용량 보고는 `provider_usage`가 아니라 그 판정 행에 쓴다. 세션 예산은 보지 않고 워크스페이스 판정 예산을 본다.
- 가격표에 `gpt-6-luna`(입력 0.10, 출력 0)를 더한다.
- 판정 비용은 `GET /v1/usage/achievements`가 따로 준다. 세션 비용 합(`GET /v1/usage/summary`)에는 들어가지 않는다.

### 실패와 다시 판정

- 오류·시간 초과(10초)·응답 모양 오류는 1분·5분·30분 뒤 세 번까지 다시 한다. 그 뒤 `failed`이고 세션 상세에 이유가 보인다.
- 예산을 넘으면 `deferred`로 두고 다음 날(UTC 0시) 다시 집는다. always 짝은 그때도 성과로 남긴다. 미룬 판정에 새 trigger가 들어오면 2분 뒤 다시 돌려 새 근거의 always 짝을 세고, luna 짝은 다시 미룬다.
- 연결이 사용 중지되면 `skipped`(`judge_unavailable`)이고 설정 화면이 경고를 보인다.
- 판정기가 짝 하나를 거부하면(`refusal`) 그 짝은 성과가 아니고 다시 묻지 않는다. 판정은 `succeeded`로 끝나고 `error_code`에 `judge_refused`를 남긴다.
- **수동 다시 판정**: owner·admin이 세션 상세에서 누른다(`trigger: manual`). 규칙을 고쳐도 지난 세션을 자동으로 다시 판정하지 않는다. 기간 일괄 다시 판정은 [LATER](#8-later).

## 5. API와 권한

| 경로 | 권한 | 하는 일 |
|---|---|---|
| `GET /v1/achievement-categories`·`POST`·`PATCH /{id}`(이름·순서)·`POST /{id}/archive` | 읽기 `workspace.read`, 쓰기 `achievement_rule.manage` | 구분 |
| `GET /v1/achievement-types`·`POST`·`PATCH /{id}`(이름만)·`POST /{id}/archive` | 같음 | 성과 type. `POST`는 `{ key, name, evidence_kind }` |
| `GET /v1/achievement-rules` | `workspace.read` | 규칙(family의 최신 버전), 구분별 |
| `POST /v1/achievement-rules` | `achievement_rule.manage` | v1 만들기. type이 이미 사용 중이면 `409 type_in_use` |
| `POST /v1/achievement-rules/{family_id}/versions` | 같음 | 고친 내용으로 새 버전 |
| `POST /v1/achievement-rules/{family_id}/disable`·`/enable` | 같음 | 사용 중지·재개. 재개할 때 type이 다른 규칙에 쓰이고 있으면 `409 type_in_use` |
| `GET`·`PUT /v1/workspaces/{id}/achievement-judge` | `workspace.read`·`achievement_rule.manage` | 판정 설정 |
| `GET /v1/sessions/{id}/achievements` | `session.read` | 성과·판정 상태·실패 이유 |
| `POST /v1/sessions/{id}/achievement-judgments` | `achievement_rule.manage` + `session.read` | 수동 다시 판정 |
| `POST /v1/achievements/{id}/review` | `achievement.review` + `session.read` | `{ action: confirm|reject, note? }` |
| `GET /v1/usage/achievements` | `GET /v1/usage/summary`와 같은 범위 규칙 | 구분·type·규칙·에이전트별 수, 세션 비용, 판정 비용, 성과당 비용 |

- 새 action 둘을 `packages/platform/src/musterrolle/policy.ts`에 더한다: `achievement_rule.manage`(owner·admin, `workspace.manage`와 같은 역할 표 `:275`), `achievement.review`(owner·admin과 그 에이전트의 관리자). 관리 action이므로 API key는 거절한다(`docs/contributing/architecture.md:86`).
- 쓰기마다 receipt: 구분·type·규칙의 만들기·고치기·보관·사용 중지, `set_achievement_judge`, `review_achievement`, `rejudge_session`. 정의 본문은 receipt에 싣지 않고 id·버전만 싣는다.
- 성과당 비용: `cost_per_achievement_usd = 기간 모든 세션 비용 / 집계되는 성과 수`(`auto` + `confirmed`). github-agent.md 10절의 `cost_per_merged_pr_usd`와 같은 이유로 성과 없는 세션 비용도 넣는다. 판정 비용은 `judge_cost_usd`로 따로.

## 6. 모듈 경계 (Kiel·Kollegium·Musterrolle)

| 모듈 | 맡는 것 |
|---|---|
| **Kiel**(세션 런타임) | 근거 사실 쓰기(`session_outcomes`, 리뷰 근거, PR 제목), 판정 trigger(근거·턴 끝·멈춤), 판정기 loop, 판정 토큰과 egress grant, 판정·성과 표, 세션 상세 API. 구분·type·규칙 표도 여기 둔다: 워크스페이스 프로필처럼 Kiel이 읽어 실행에 쓰는 워크스페이스 설정이다. 코드는 `packages/platform/src/sessions/achievements/` |
| **Musterrolle**(권한·워크스페이스) | `achievement_rule.manage`·`achievement.review` action과 역할 표, 워크스페이스 설정 스키마의 `achievement_judge` 칸 |
| **Kollegium**(에이전트) | 1차에는 없음. 규칙은 에이전트 릴리스에 고정하지 않는다: 규칙은 에이전트가 하는 일이 아니라 세는 법만 바꾸므로, 릴리스에 넣으면 규칙을 고칠 때마다 새 릴리스가 필요해진다. 에이전트별 규칙 화면과 에이전트 상세의 "성과" 탭은 LATER에서 Kollegium 몫이다 |
| egress proxy | `/decisions` 경로, 연결 kind `openai_decisions`의 키 붙이기, 판정 grant의 사용량 보고 |

## 7. 오너 결정 (확정)

오너 승인(2026-11-02)으로 아래가 확정이다. 앞 초안의 추천을 그대로 받았고, 3차 피드백으로 바뀐 것은 굵게 적었다.

1. **판정기는 Luna 하나**(오너 원문 "Decisions(Luna) 만 해도 괜찮아"). 글 생성 모델 판정 경로는 없다.
2. **구분은 사람이 만드는 대분류.** 규칙 한 줄 = 제목·성과 type·성과 정의 1:1:1이고, type 하나에 사용 중인 규칙은 하나뿐이다.
3. **성과 type은 사람이 만든다. 사람 type의 성과는 공통 칸만**(제목·링크·근거 종류·근거 id). 내장 셋만 `payload`.
4. **규칙에 '대상 PR' 칸은 없다.** PR 상태 조건은 정의 문장에 쓰고 Luna가 판정한다.
5. 근거 종류는 PR·리뷰·`out/` 파일·대화 넷. 새 근거 종류는 코드로 더한다.
6. PR 제목(200자)을 근거에 남겨 Luna에 보낸다. github-agent.md 10절을 그만큼 바꾼다.
7. `out/` 파일·대화가 근거인 성과는 owner·admin과 그 에이전트의 관리자가 확인해야 ROI에 든다.
8. 에이전트별 규칙은 칸(`agent_ids`)만 만들고 1차 화면은 "모든 에이전트"만.

위험:

- **Decisions API는 나온 지 얼마 되지 않았다(2026-10-06).** 요청·응답 모양이 바뀔 수 있다. 백엔드 안에 가두고, 응답을 zod로 검사해 모르는 모양이면 `failed`로 둔다. 값은 벤더 공표값이고, Luna 백엔드 티켓의 첫 커밋 전에 공식 문서로 확인한다. 문서가 이 설계와 다르면(예: 확률을 주지 않음) 구현을 멈추고 오너에게 묻는다.
- **세션 내용이 OpenAI로 나간다.** PR 제목·저장소 이름은 Luna 규칙이 있으면 늘, 파일 앞부분은 `out_file` 규칙이 있을 때, 대화 발췌는 `conversation` 규칙과 `transcript: recent`가 함께일 때만. 판정 설정 화면에 무엇이 나가는지 보이고, 설치 운영자가 egress 허용 목록에 `api.openai.com`을 넣어야 열린다.
- **판정 grant가 `session_id`·`attempt_id` 없이 사용량을 보고**하는 것은 egress proxy의 보고 계약을 넓힌다. proxy를 API보다 먼저 올려야 하고, 앞 proxy는 판정 grant를 거절하는 쪽으로만 틀려야 한다.
- **연결 DB 이전(S1)에 기댄다.** `openai_decisions` 연결은 `provider_connections` 위에 만든다. S1 전에 하려면 `connections.yaml`에 kind를 더해야 하고 그것은 S4에서 다시 옮겨야 하므로, Luna 백엔드 티켓은 S1 뒤에 둔다.

## 8. LATER

- **jev 백엔드.** 다시 볼 조건: 오너가 jev를 쓰자고 하고 API 문서(인증·요청 모양·호스팅·데이터 보관)를 줄 때.
- **근거 종류 추가**(Slack 답변, dispatch한 run의 성공). 다시 볼 조건: 오너가 그 결과를 성과로 세고 싶어 할 때.
- **기간 일괄 다시 판정.** 다시 볼 조건: 규칙을 고친 뒤 지난 기간을 새 기준으로 보고 싶다는 요청. 예상 비용을 먼저 보이고 확인받는다.
- **규칙 미리보기**(최근 세션 하나에 시험 판정). 다시 볼 조건: 정의를 고칠 때 결과를 미리 보고 싶다는 요청.
- **에이전트 상세 "성과" 탭과 에이전트별 규칙 화면(Kollegium).** 다시 볼 조건: 에이전트마다 다른 규칙이 필요하다는 요청.

## 9. 구현 분할

에픽: **세션 성과 규칙과 판정**. 티켓은 tracker의 그 에픽 아래에 있다.

| # | 제목 | 앞 |
|---|---|---|
| AR-0 | 성과 규칙 설계 문서를 repo에 둔다 | — |
| AR-1 | 리뷰 제출과 PR 제목을 근거로 남긴다 | AR-0 |
| AR-2 | 구분·성과 type·규칙을 저장하고 API로 관리한다 | AR-0 |
| AR-3 | 바로 인정 규칙으로 성과를 남긴다 | AR-1, AR-2 |
| AR-4 | 판정 비용 원장과 판정 trigger(N턴·멈춤·수동) | AR-3 |
| AR-5 | Luna로 성과 정의를 판정한다 | AR-4, S1 |
| AR-6 | 콘솔: 성과 규칙 설정 화면 | AR-2 |
| AR-7 | 콘솔: 세션 상세의 성과와 확인·거절 | AR-3 |
| AR-8 | 성과 집계 API와 화면 | AR-3 |
| AR-9 | 문서와 실측 검증 | AR-5~8 |

AR-1과 AR-2는 같이 갈 수 있고, AR-6은 AR-2 뒤 바로 갈 수 있다. AR-4·AR-5가 egress proxy 계약을 바꾼다(배포 순서: proxy 먼저). AR-5는 연결 DB 이전 S1 뒤다.
