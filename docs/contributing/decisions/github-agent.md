# 결정: 에이전트 GitHub 설정과 기능별 권한

- 후속(2026-11-11): 실행 프로필은 통째로 지웠다(migration `0268_remove_profiles`, 기존 데이터는 이전하지 않고 지움). 이 문서의 프로필·상한·롤아웃 언급은 그때의 기록이다. 지금은 에이전트 release가 provider 연결과 카드 모델로 실행 spec(런타임·도구·권한 모드)을 고정하고, 묻기·막기 규칙은 워크스페이스와 에이전트의 실행 규칙(`workspace_engine_settings`, `agent_engine_settings`)이 정한다.
- 상태: 설계. 구현 PR GA-1~GA-7과 GA-4b가 이 문서를 계약으로 쓴다([9절](#9-구현-pr-분할)). 같은 역할에 App 여럿을 받는 일은 [결정 11](#결정-11-같은-역할에-app-여럿)이 계약이다.
- 후속(2026-11-10): 아래의 "기본 저장소"와 "시작 저장소"는 당시 동작이다. 지금은 설정 행이 있는 에이전트의 세션이 저장소 없이 시작하고 필요한 저장소만 붙이며, `start_repository_id`는 시작에 쓰이지 않는다. 현재 규칙은 [API 서버 운영 문서](../../operator/api-server.md)의 "새 세션의 시작 저장소"다.
- 개정(2026-11-02): 오너 결정 다섯 건으로 "역할마다 App 하나"를 "역할마다 App 여럿, 저장소마다 고정된 연결"로 바꿨다. 바뀐 곳은 결정 1·5·9·10, 3절 게이트, 4절, 5절, 6절, 7절이고, 바뀐 곳마다 이전 결정과 바뀐 이유를 적었다.
- 결정(2026-11-03): PR 템플릿과 co-author의 오너 결정 D1~D5를 확정했다. 작성자는 App bot, 요청한 사람은 Co-author다([결정 5의 PR 템플릿과 co-author 결정](#pr-템플릿과-co-author-결정)).
- 기준 커밋: `origin/main` `cee8359b`. 아래 `파일:줄`은 [10절](#10-세션-성과물)을 빼고 모두 이 커밋 기준이다. 10절은 `3f4dd99d` 기준이다.
- 오너 원문(2026-10-30): "github apps 에서는 기능별로 권한을 가진다고 봐야할거 같아 그리고 기본적으로는 pr 을 작성하고 변경하기위한 권한 까지만을 기본값으로 가지고 그 외에 승인이나, 액션 실행 이나 관리 등등 그리고 액션을 실행하고자 할경우에 어떤 액션까지 허용할것인지에 대한 권한 관리는 agent 설정에서 관리가능하도록 하는게 좋을거 같아", "agent 상세화면에 slack 탭이 잇는것처럼 github 도 별도 탭으로 나눠서 일단 애초에 github 를 사용할것인가 아닌가 를 제어할수 있도록 하고 github 의 상세 옵션을 제어할수 있도록 메뉴를 확장하는게 좋을거 같네", "추천대로 진행해줘"(결정 0~10 전부).
- 리드 결정(2026-10-30, 이 설계 중 질문): GitHub 작업은 control-host의 서비스 한 곳에서 하고 입구는 둘이다. 세션 API와 세션 안의 내장 MCP 서버 `github`다. 내장 MCP는 구현 분할의 마지막 PR이다. 같은 에이전트가 연 PR의 리뷰 승인은 플랫폼이 막지 않는다([결정 1](#결정-1-리뷰-전용-app)).
- 개정 예고(2026-11-04): 세션 안 `gh`가 같은 서비스의 셋째 입구가 된다. 이미지의 `gh`를 shim으로 바꿔 정해진 명령 여덟 개만 내장 MCP와 같은 dispatcher로 보내고, 진짜 `gh`는 지금처럼 로그인이 없다. 서비스 한 곳은 그대로다. 계약은 [에이전트 행동 도구 카탈로그](action-broker.md#58-t8-gh-입구)이고, 이 줄은 그 구현 단위(L14)가 고친다.

## 지금 구조

- **연결.** 콘솔에서 등록한 GitHub App은 워크스페이스에 하나다. `github_apps`에는 `UNIQUE (workspace_id)`가 걸려 있다(`packages/db/migrations/0192_github_apps.sql:12`, `packages/db/src/schema.ts:512-537`). 키는 `secret_values`에 그 행 id를 owner로 해서 암호화해 둔다(`packages/db/src/github-apps.ts:25-29`). 등록할 때 `GET /app`으로 키를 확인한다(`packages/platform/src/musterrolle/github-app-service.ts:208-245`). 이때 App의 권한은 읽지 않는다.
- **어느 저장소가 그 App을 쓰나.** 카탈로그 저장소의 `auth`가 `{ kind: github_app }` 한 줄이면 콘솔 App을 쓴다(`packages/platform/src/sessions/catalog.ts:259-264`, `293`, `442-443`). `app_id`·`installation_id`·키 참조를 적은 저장소는 카탈로그의 App을 쓴다(`apps/control-host/src/api/forge-github.ts:707-759`). 콘솔 App의 forge는 `credentials()`의 첫 행으로 만든다(`forge-github.ts:612`). 이 query는 행을 거르지 않는다(`github-apps.ts:168-195`).
- **토큰 발급.** control-host만 키를 쥔다. 요청마다 **저장소 하나**(`repositoryNames: [repo.name]`, `forge-github.ts:445`)와 작업별 권한으로 installation token을 발급한다. clone은 `contents: read`, push는 `contents: write`(`forge-github.ts:265-266`), PR·코멘트는 `contents: read` + `pull_requests: write`(`forge-github.ts:207-210`)다. 토큰은 저장소·권한 조합별로 메모리에 캐시한다(`forge-github.ts:152-177`).
- **worker는 토큰을 받지 않는다.** clone은 egress proxy가 받아 gateway가 그때 발급한 자격 증명으로 보낸다(`packages/platform/src/workers/worker-gateway.ts:1241-1255`). proxy는 upload-pack만 받고 receive-pack(push)에는 경로가 없다(`apps/egress-proxy/src/credential.ts:160-175`). push는 API 프로세스가 한다. 쓰기 자격 증명을 받고(`packages/platform/src/sessions/push-executor.ts:108`) `deps.pusher.push`를 부른다(`push-executor.ts:138`).
- **누가 무엇을 부르나.** push 요청은 `session.submit` 호출자(사람이나 에이전트 key)가 만든다(`packages/platform/src/sessions/push-request-service.ts:127-134`). 승인, PR 열기, 코멘트는 `sessions:approve`를 가진 사람이나 API key만 한다(`push-request-service.ts:66-77`, `packages/platform/src/sessions/pull-request-service.ts:103`). 에이전트 key도 개인 key처럼 발급할 때 `sessions:approve`를 포함한 scope를 골라 받는다. 다만 workspace의 key(개인·에이전트)는 자기가 시작한 세션의 push 요청과 확인 요청을 승인하지 못한다(GA-8, [GA-8에서 정한 것](#ga-8에서-정한-것)). 이 문서를 쓸 때는 에이전트 key가 `sessions:approve`를 가질 수 없었다(`packages/platform/src/musterrolle/policy.ts:283-285`). 웹과 Slack에는 push·PR 화면이 없다. **세션 안의 에이전트가 GitHub 작업을 부를 경로도 없다.**
- **에이전트 설정이 사는 곳.** 카드(`agent_versions.card`)는 불변 버전이다. 릴리스(`agent_releases`)는 카드·프로필·저장소·`policy_pins`를 해시한 id를 가진다(`schema.ts:2846-2888`, `packages/platform/src/agents/release-ids.ts:61-77`). 카드에 나중에 더한 칸은 optional로 두어 옛 카드의 해시를 지킨다(`packages/contracts/src/kollegium/agents.ts:101-105`). 릴리스 id 버전도 같은 이유로 올린다(`release-ids.ts:32-39`). 즉시 반영하는 스위치는 `agents` 행의 열로 둔다. 선례는 `slack_mention_only`다(`schema.ts:2408`, `packages/db/migrations/0188_slack_mention_only.sql:3`).
- **사람의 외부 계정.** `linked_accounts`는 provider를 일반화한 테이블이지만 값은 `slack` 하나다(`schema.ts:720-783`, CHECK는 `766-769`, `packages/contracts/src/musterrolle/linked-accounts.ts:14`). 화면은 `/settings/linked-accounts`다(`apps/web/src/router.tsx:240-243`).
- **세션을 시작한 사람.** turn 1의 `actor_id`가 시작자이고, 없으면 `sessions.created_by_user_id`다(`packages/db/src/session-shares.ts:68-71`). turn의 actor는 그 요청 principal 뒤의 사람이다(`packages/db/src/postgres-unit-of-work.ts:452`). 웹 cookie, 개인 API key(`api_keys.kind = 'personal'`, 만든 사람 필수 `schema.ts:2351-2357`), 연결된 Slack 사용자는 사람으로 풀린다. 에이전트 key와 operator key는 사람이 없다.
- **commit 작성자.** worker 이미지의 system git 설정이 `Werft <noreply@werft.invalid>`다(`apps/worker/Dockerfile:53-58`). Co-authored-by는 코드에 없다.
- **PR과 세션.** 브랜치 `agent/<session-id>`. PR 본문 꼬리는 "Opened by Werft from session …, commit …"이다(`pull-request-service.ts:204`). 이미 열린 PR을 다시 쓸 때는 꼬리를 고치지 않는다(`pull-request-service.ts:192-196`).
- **감사.** receipt operation 목록은 `packages/contracts/src/api/receipt.ts:25-111`이다. GitHub 쪽은 `request_push`·`decide_push`·`push`·`open_pull_request`·`comment_pull_request`·`set_github_app`·`delete_github_app`이 있다. receipt의 `agent_id`는 늘 null이다(`policy.ts:43-50`).

## 1. 실제 허용은 교집합이다

GitHub 토큰 하나가 가질 권한은 아래 다섯의 교집합이고, **발급할 때마다** 다시 계산한다(검토 문서 3절의 원칙).

1. **App 설치 권한**: GitHub가 강제한다. 등록할 때와 발급할 때 읽은 값이다([결정 2](#결정-2-app-최대-권한설치-상한)).
2. **워크스페이스 상한**: owner·admin이 정한다([결정 9](#결정-9-워크스페이스-상한--에이전트-좁히기)).
3. **에이전트 릴리스의 GitHub 설정**: 릴리스에 고정된다([결정 7](#결정-7-릴리스와의-관계)).
4. **에이전트 GitHub 스위치**: 즉시 반영된다.
5. **이번 작업**: clone, push, PR, dispatch, rerun, 리뷰.

이 계산을 하는 곳은 control-host의 **GitHub 게이트** 한 곳이다([3절](#3-토큰-발급-경로와-좁히기)). 세션 API, 내장 MCP, gateway의 clone, push 실행기는 모두 이 게이트를 지나야 토큰을 얻는다.

## 2. 결정별로 어떻게 지키나

### 결정 0. GitHub가 강제하는 것은 다시 책임지지 않는다

- 플랫폼은 브랜치 보호, 필수 리뷰, CODEOWNERS, ruleset, 필수 검사를 읽지도 흉내 내지도 않는다. GitHub가 거절하면 push·PR의 원문 사유는 지금처럼 로그에만 남긴다(`forge-github.ts:642-660`, `675-697`, #912). receipt에는 HTTP 상태와 플랫폼이 분류한 `reason_code`만 둔다. GitHub의 오류 문구는 요청에 넣은 값(예: dispatch `inputs`, 리뷰 본문)을 되비출 수 있기 때문이다. 같은 이유로 새 작업(dispatch·rerun·리뷰)의 오류는 **로그에도** 원문(`message`·`errors`)을 남기지 않는다. HTTP 상태, 플랫폼이 분류한 `reason_code`, GitHub의 `x-github-request-id`만 남긴다. 지금 오류 로거(`forge-github.ts:642-660`)를 이 작업에 그대로 쓰지 않는다. 그것으로 끝이다.
- 플랫폼이 여전히 막는 것은 **플랫폼이 만든 경계**뿐이다. push 대상 브랜치 고정과 기본 브랜치 거절(`push-executor.ts:93-99`), force push 금지, 토큰을 worker에 주지 않는 것, 그리고 이 문서가 더하는 기능별 권한·허용 목록·저장소 범위다.
- 에이전트 기본값은 PR 작성·수정까지다. 다시 말해 clone(`contents: read`), push(`contents: write`), PR 열기·코멘트(`pull_requests: write`)다. 그 밖의 권한은 모두 꺼진 채로 시작한다([4절 기본값 표](#에이전트-github-설정의-기본값)).

### 결정 1. 리뷰 전용 App

- **왜 두 번째 App인가.** GitHub는 PR 작성자의 승인 리뷰를 받지 않는다. 플랫폼이 연 PR의 작성자는 작성용 App bot이다. 같은 App의 토큰으로는 그 PR을 승인할 수 없다.
- **데이터.** `github_apps`에 `role`(`author`·`reviewer`)을 더한다([4절](#4-데이터-모델)). 리뷰용 App은 별도 행이다. 키도 행 id로 따로 보관하므로 따로 교체하고 따로 지울 수 있다. 한 역할에 행이 여럿일 수 있다([결정 11](#결정-11-같은-역할에-app-여럿)).
  - 이전 결정: 유일 제약을 `(workspace_id, role)`로 두어 역할마다 행 하나였다. 바뀐 이유: 오너 결정(2026-11-02) 1. 같은 역할에 App 여럿을 받는다.
- **등록.** #922의 등록 흐름(App ID와 .pem, `GET /app`으로 확인)을 그대로 쓴다. 경로에 role만 더한다([6절](#6-api)). 같은 워크스페이스에 같은 `app_id`는 역할이 달라도 한 행이다. 역할과 상관없이 다른 연결에 이미 있으면 `409` `reason_code: same_app`이다. 같은 App이면 작성자 규칙 때문에 승인이 늘 거절되기 때문이다.
- **사용.** 에이전트 GitHub 설정의 `review`가 켜져 있을 때만 리뷰 작업이 리뷰용 App 토큰을 받는다. 어느 리뷰용 App인지는 그 저장소에 고정된 리뷰용 연결이 정한다([결정 11](#저장소에-고정된-연결)). 그 토큰은 `contents: read` + `pull_requests: write`, 저장소 하나다. 리뷰는 `POST /repos/{owner}/{repo}/pulls/{n}/reviews`에 `commit_id`를 반드시 넣어 부른다. 에이전트가 읽은 SHA가 아닌 것은 승인하지 않게 하려는 것이다(검토 문서 2절 Codex 경고). PR head가 그 사이 바뀌었으면 GitHub가 그 리뷰를 옛 commit에 단다.
- **리뷰용 App이 없을 때.** 에이전트 탭의 "리뷰 승인"은 비활성이고, "워크스페이스에 리뷰용 App이 없습니다" 안내와 GitHub 연결 설정 링크를 보인다. API는 `options`에서 `review.available: false, reason: no_reviewer_app`를 준다. 이미 `review`가 켜진 릴리스가 리뷰를 부르면 `409` `reason_code: no_reviewer_app`이다. 리뷰용 App이 그 저장소에 설치되지 않았으면 `503` `forge_failed`(지금 forge의 "not installed" 경로와 같다)다.
- **리뷰할 수 있는 PR.** 에이전트 저장소 범위([결정 8](#결정-8-에이전트별-저장소-범위)) 안의 저장소에 열린 PR이면 누가 열었든 리뷰할 수 있다. 사람이 연 PR도 포함한다. 오너가 말한 "agent-platform이 리뷰를 하는 경우"가 이것이다. 어떤 PR을 승인해도 되는지는 GitHub의 리뷰 규칙이 정한다(결정 0).
- **같은 에이전트의 작성과 승인(리드 결정, 플랫폼은 막지 않는다).** 같은 에이전트가 작성용 App으로 PR을 열고 리뷰용 App으로 승인할 수 있다. 승인은 PR에 남지만, 권장 권한(Contents read)인 리뷰용 App의 승인은 GitHub가 필수 리뷰로 세지 않는다. 그래서 브랜치 보호나 ruleset이 리뷰를 요구하는 저장소에서는 병합에 GitHub가 인정하는 다른 승인(보통 쓰기 권한이 있는 사람의 승인)이 여전히 필요하다. 실측(GA-VERIFY-2, 2026-11-02): werft-sandbox#27을 작성용 App이 열고 리뷰용 App(contents:read, metadata:read, pull_requests:write)이 head `deede79a`에서 승인했지만, 필수 승인 1의 ruleset 아래에서 `reviewDecision=REVIEW_REQUIRED`, `mergeStateStatus=BLOCKED`, 그 리뷰의 `authorCanPushToRepository=false`였다. 필수 리뷰 규칙이 없는 저장소는 승인과 상관없이 병합할 수 있다. 결정 0에 따라 이것은 GitHub 쪽 설정으로 다룬다. 연결 화면에는 이 사실과, 사람 리뷰가 필요하면 GitHub에서 필수 리뷰를 요구하라는 대응을 적는다. 리뷰용 App을 ruleset bypass 목록에 넣지 않는다. 리뷰용 App에 Contents 쓰기를 주라는 안내는 하지 않는다(오너 결정 2026-11-02, [결정 2](#결정-2-app-최대-권한설치-상한)는 그것을 상한보다 넓은 권한으로 경고한다). "자기 PR 승인 거절" 옵션은 [LATER](#later)에 둔다. 리뷰 receipt에는 PR을 연 세션·에이전트와 리뷰한 세션·에이전트를 함께 남겨 사후에 찾을 수 있게 한다.

### 결정 2. App 최대 권한(설치 상한)

- **안내하는 권한.** 작성용 App: 기본은 Contents read & write, Pull requests read & write, Metadata read다. 선택은 Actions read & write, Checks read & write, Issues read & write, Workflows read & write다(Workflows는 [결정 3](#결정-3-workflows-권한)). Administration은 주지 않는다. 리뷰용 App: Contents read, Pull requests read & write, Metadata read다. 이 목록은 등록 화면의 안내, `apps/docs`의 GitHub 연동 문서, 운영 문서에 같은 값으로 들어간다.
- **실제 권한 읽기.** 권한은 두 가지다. App이 요청한 권한(`GET /app`의 `permissions`)과, 설치가 승인한 권한(`GET /repos/{o}/{r}/installation`의 `permissions`)이다. App 권한을 늘려도 설치 쪽에서 승인하기 전에는 installation token이 그 권한을 받지 못한다. `GitHubAppDirectory.describe`(`forge-github.ts:544-555`)는 App 권한을 함께 돌려준다. 저장소별 설치 조회(`installationFor`, `forge-github.ts:476-492`)는 설치 권한을 함께 돌려준다. App 권한은 등록과 `GET …/github-apps/{role}` 때마다 읽어 행의 `permissions`·`permissions_checked_at`에 둔다. 설치 권한은 같은 조회 때 저장소별로 읽어 응답에만 싣는다. 화면은 "App에 없음"과 "설치 승인 대기"를 나눠 보인다.
- **판정은 GitHub가 한다.** 게이트는 캐시된 권한으로 미리 거절하지 않는다. 필요한 권한으로 installation token을 그대로 요청한다. 설치가 그 권한을 갖지 않으면 GitHub가 발급을 거절(422)하고, 게이트는 이것을 `409` `reason_code: app_permission_missing`으로 바꾼다. 그래서 오너가 권한을 더하고 설치를 승인하면 재시작이나 캐시 만료를 기다리지 않고 다음 요청부터 돈다. 캐시된 권한은 화면 표시와 탭의 비활성 안내에만 쓴다.
- **상한보다 넓으면 경고.** 그 role의 안내 목록 밖의 권한, 또는 안내보다 높은 수준이 있으면 경고 목록을 낸다. 예: `administration`, 리뷰용 App의 `contents: write`. 저장은 막지 않는다. 오너가 의도해 넓힌 App일 수 있어서다. 경고는 등록 응답의 `warnings`와 receipt `set_github_app`의 result에 남는다.
- **App에 없는 권한.** 에이전트 탭에서 그 항목은 비활성이고 "App에 이 권한이 없습니다. GitHub App 설정에서 더한 뒤 설치를 다시 승인하세요"를 보인다. 설치 승인만 남았으면 "GitHub에서 설치의 권한 변경을 승인하세요"를 보인다. 이 안내는 캐시된 값이라 늦을 수 있고, 실제 판정은 위와 같이 발급 요청이 한다.

### 결정 3. workflows 권한

- 에이전트 GitHub 설정의 `workflows`(기본 false). 켜면 push 토큰이 `contents: write` + `workflows: write`가 된다. 끄면 `contents: write`뿐이다. `.github/workflows/` 아래를 바꾸는 push는 GitHub가 거절한다. 이것은 GitHub가 강제하는 규칙이고, werft-sandbox에서 실측으로 확인한다(GA-2 검증).
- 플랫폼은 push 전에 diff를 검사하지 않는다(결정 0). GitHub의 거절은 지금처럼 `push_failed`로 끝난다. 원문 사유는 로그에만 남긴다. 사유가 workflows 권한이면 `push_error.reason_code: workflows_permission_missing`으로 분류해 세션과 receipt에 보인다.
- **PAT 저장소는 이 제한을 지킬 수 없다.** PAT는 권한을 좁혀 발급할 수 없다(`forge-github.ts:130-132`). 그래서 PAT 저장소(`kind: basic`, github.com)는 에이전트 `github.repositories`에 고를 수 없다(`400` `reason_code: app_required`). `github` 설정이 없는 기존 릴리스는 PAT 저장소를 지금처럼 쓴다. 이것은 이 문서 전과 같은 동작이고, 운영 문서에 "기능별 권한을 쓰려면 App으로 옮긴다"를 적는다.
- `workflows`와 `actions`를 같이 켜면 에이전트는 허용 목록에 있는 워크플로 파일 자체를 자기 브랜치에서 고칠 수 있다. 그 브랜치는 dispatch 대상이 아니지만([결정 4](#결정-4-actions-허용-목록)), 사람이 머지하면 대상이 된다. 탭은 둘을 같이 켤 때 이 점을 경고한다.
- App에 `workflows` 권한이 없거나 워크스페이스 상한이 막으면 탭에서 선택할 수 없고 안내를 보인다([결정 2](#결정-2-app-최대-권한설치-상한)와 같은 문구 규칙).

### 결정 4. Actions 허용 목록

- **설정.** 릴리스의 `github.actions_allow`: `[{ workflow: "<파일 이름>", ref?: "<패턴>" }]`, 최대 32개다. 켜는 스위치는 `github.features.actions`다. `workflow`는 `.github/workflows/` 아래의 파일 이름(`deploy.yml`)이다. 경로 구분자는 받지 않는다. `ref`는 생략하면 그 저장소의 기본 브랜치만 뜻한다. 적으면 `*` 하나만 쓰는 glob이다(`release/*`). `*`는 `/`를 넘지 않는다. 목록이 비면 dispatch·rerun은 모두 거절한다. `actions`가 꺼져 있으면 목록을 저장할 수 없다(`400` `reason_code: actions_off`).
- **강제 지점.** 게이트가 토큰을 발급하기 **전에** 판정한다. 토큰은 control-host 밖으로 나가지 않으므로, 목록 밖 호출을 할 수 있는 토큰이 존재하지 않는다.
- **에이전트가 쓴 ref는 돌리지 않는다.** dispatch는 그 ref에 있는 워크플로 파일과 그 파일이 부르는 스크립트를 그대로 실행한다. 그래서 허용 목록 항목은 그 ref의 코드만큼만 안전하다. 에이전트는 `agent/<session-id>` 브랜치의 내용을 정할 수 있다. push 승인을 끈 릴리스면 사람 없이 정한다. 그러니 이 브랜치를 허용하면 목록 안의 `deploy.yml`이 에이전트가 고친 `scripts/deploy.sh`를 그 저장소의 비밀값으로 돌리게 된다. 그래서 게이트는 목록과 상관없이 플랫폼이 push하는 ref(`agent/` 접두사)에 대한 dispatch를 거절한다(`403` `reason_code: agent_ref_refused`). rerun은 아래처럼 플랫폼이 직접 허용한 ref로 dispatch한 run만 받으므로 이 브랜치의 run은 처음부터 대상이 아니다. 사람이 이 브랜치를 기본 브랜치나 허용한 ref로 머지한 뒤에만 그 코드가 dispatch 대상이 된다. 그 머지는 GitHub의 리뷰 규칙을 거친다(결정 0).
  - `workflow_dispatch`: 요청의 `workflow`·`ref`를 목록과 맞춘다. 맞지 않으면 `403` `reason_code: workflow_not_allowed`이고, GitHub에는 아무것도 보내지 않는다. 맞으면 `actions: write` 토큰으로 `POST /repos/{o}/{r}/actions/workflows/{workflow}/dispatches`를 부른다. `ref`는 브랜치만 뜻하고, GitHub에는 `refs/heads/<branch>`로 보내 같은 이름의 태그와 헷갈리지 않게 한다. `return_run_details: true`로 받은 run id를 [`github_workflow_dispatches`](#github_workflow_dispatches-새)에 기록한다.
  - rerun(`…/actions/runs/{run_id}/rerun`, `rerun-failed-jobs`): 호출자는 `run_id`만 넘긴다. rerun은 원래 run의 ref·SHA를 그대로 다시 쓴다. 그런데 GitHub의 run 응답(`event`, `head_branch`)만으로는 그 ref가 브랜치였는지 같은 이름의 태그였는지 증명할 수 없다. 그래서 **플랫폼이 이 저장소에서 브랜치로 dispatch해 run id를 기록한 run만** rerun한다. 기록이 없으면 `403` `reason_code: run_ref_unprovable`이다. 기록이 있으면 기록된 `workflow`·`ref`를 **지금 세션 릴리스의** 허용 목록과 다시 맞춘다. 목록이 그 사이 바뀌었으면 거절한다. push·PR로 시작된 run은 rerun하지 않는다. 그런 run의 재실행은 저장소 쪽의 일이다(결정 0).
- **입력값.** 허용 목록은 워크플로 파일과 ref만 좁힌다. `inputs`는 그대로 넘긴다. 허용 목록에 넣는 워크플로가 입력값으로 checkout ref나 실행할 스크립트를 고르게 되어 있으면, 에이전트가 `inputs`로 `agent/<session-id>`를 골라 위의 우회를 다시 열 수 있다. 그래서 운영 문서와 탭의 허용 목록 안내에 조건을 적는다: 허용 목록에 넣는 워크플로는 입력값으로 실행 코드나 checkout ref를 임의로 고르지 않아야 한다. 입력값별 제한은 이번에 만들지 않는다([LATER](#later)).
- **막지 않는 것.** `on: push`·`on: pull_request`로 도는 워크플로는 플랫폼이 건드리지 않는다. push와 PR이 그것을 부르는 것은 저장소 설정의 일이다.
- **세션 밖의 호출.** dispatch·rerun은 세션에 묶인 작업이다. 세션이 그 저장소를 쓰고 있어야 한다. 그 세션의 릴리스가 목록을 정한다.

### 결정 5. Co-authored-by

- **누가 들어가나.** 그 commit을 만든 턴의 요청자(턴의 `actor_id`, 위 [지금 구조](#지금-구조)의 사람 풀이 규칙)가 활성 GitHub 연동 계정을 가졌으면 그 사람이다. 세션 시작자가 아니다. 시작자 A의 세션에서 B가 이어 요청한 턴의 commit에는 B가 들어간다. 웹, 개인 API key, Slack 모두 같은 규칙으로 사람이 나온다. 에이전트 key, operator key, 그리고 앞으로 생길 스케줄·외부 시스템 트리거는 요청자가 없으므로 트레일러를 넣지 않는다. 그때 PR과 commit은 App 단독이다. (이전 결정: 세션 시작자. 바뀐 이유: 한 세션에서 여러 사람이 요청하기 때문이다.)
- **연결.** 설정 > 연동 계정에 GitHub를 더한다. GitHub OAuth로 본인을 확인한다. 사용자 이름을 직접 넣는 칸은 두지 않는다. OAuth 클라이언트는 작성용 App의 사용자 인증(App의 Client ID와 client secret)을 쓴다. 별도 OAuth App을 만들지 않으려는 것이다([오너 단계](#오너만-할-수-있는-단계)). 작성용 연결이 여럿이면 설정에 명시한 연결 하나를 쓴다([결정 11](#결정-11-같은-역할에-app-여럿)의 3). (이전 결정: 작성용 App이 하나라 그 App이었다. 바뀐 이유: 오너 결정 2026-11-02 3.) 콜백은 `GET /user` 한 번만 부르고, 받은 user token은 저장하지 않고 버린다. 행에는 `external_user_id = <GitHub 숫자 id>`, `external_user_name = <login>`, `external_tenant = "github.com"`, `verified_via = 'github_oauth'`이 들어간다(응답의 `expires_at`은 null). 같은 GitHub 계정은 한 사람에게만 연결된다. 이것은 지금의 live 유일 인덱스(`schema.ts:756-758`)가 그대로 지킨다.
- **이메일.** `<id>+<login>@users.noreply.github.com`이다. 이메일은 연결할 때의 id와 login으로 만든다. 사람이 GitHub login을 바꾸면 다시 연결해야 이메일이 새 login을 따른다. login을 바꾼 뒤 옛 이메일이 여전히 그 계정에 귀속되는지는 확인하지 않았다. GA-4에서 werft-sandbox로 새 이메일의 귀속만 확인하고, 옛 이메일 귀속은 [LATER](#later)에 둔다.
- **넣는 곳과 때.** 트레일러는 **worker가 commit할 때** 넣는다. 승인 뒤에 넣으면 SHA가 바뀌어 사람이 승인한 commit과 달라지기 때문이다(검토 문서 4절 4번). claim 응답에 `git.co_author: { name, email } | null`과 `git.session_url`을 더한다. worker는 시작할 때 system git에 `core.hooksPath`를 플랫폼 hook 디렉터리로 둔다. 그 디렉터리의 `commit-msg` hook이 `git interpret-trailers --if-exists addIfDifferent`로 `Co-authored-by: <login> <email>`과 `Agent-Session: <session URL>`을 더한다. `name`은 연결할 때 GitHub가 준 login이고, 사람이 쓴 표시 이름은 쓰지 않는다. 서버는 login(`^[A-Za-z0-9-]{1,39}$`)과 숫자 id를 다시 검사한 뒤에만 claim에 싣는다. hook은 값을 shell 문자열에 끼우지 않고 argv(`--trailer`)로 넘기며, CR·LF·NUL이 든 값은 넣지 않고 건너뛴다. 값은 claim마다 받고, 한 claim 안의 턴마다 `nextInput` 응답의 `input.co_author`로 다시 받는다(없으면 claim의 값이 그대로 선다). 그래서 세션 도중에 연결하면 다음 턴의 commit부터 들어간다.
  - 알려진 한계: 세션이 `--no-verify`로 commit하면 트레일러가 빠진다. 트레일러는 귀속 표시이지 보안 경계가 아니므로 막지 않는다. 대신 PR 본문 꼬리가 같은 정보를 늘 싣는다(아래). 저장소의 `commit-msg` hook이 트레일러 뒤에 문단을 더해도(예: husky의 `Husky-Ran:`) 트레일러는 한 번만 남는다. 우리 hook이 마지막 트레일러 블록에 없는 줄만 더하고, 앞 문단에 같은 줄이 있으면 지운 뒤 마지막 블록으로 옮기기 때문이다. push 검사는 마지막 트레일러 블록의 줄만 세므로 줄이 그 블록에 있어야 한다.
- **PR과 세션 연결(검토 문서 4절).** PR 본문 꼬리를 아래 줄들로 바꾼다. 세션 콘솔 URL, 에이전트 id·릴리스 id, push 요청 id, 트리거 종류(`web`·`slack`·`personal_key`·`agent_key`·`operator_key`), 시작자의 GitHub 연결 여부다. 그 push를 요청한 턴의 요청자가 있으면 `Requested by` 줄(`@` 없이 login, 알림을 보내지 않으려는 것이다)과 경로를 더하고, 그 사람이 연결돼 있으면 `Co-authored-by` 줄도 넣는다. 이 줄은 `Requested by`의 login에 묶인다. 요청자는 `push_intents.turn_id`가 가리키는 턴에서 읽는다. PR을 다시 쓸 때도(`pull-request-service.ts:192-196`) 꼬리를 최신 승인 commit으로 고친다. 본문은 누구나 고칠 수 있으므로 증거가 아니라 찾아가는 수단이다. 기준 기록은 DB의 PR 행과 receipt다.
- **미연결 안내.** 마지막 턴의 요청자가 있지만 GitHub를 연결하지 않았으면, 세션 상세와 그 세션의 PR 정보 영역에 "GitHub 계정 미연결: 연결하지 않은 요청자의 commit에는 공동 작성자가 들어가지 않습니다"와 연동 계정 링크를 보인다. 요청자가 없는 턴(에이전트 key 등)에는 안내를 띄우지 않고, 상세에 "App 단독"으로만 표시한다. 세션 상세의 줄은 마지막 턴의 요청자를 따르고, 턴이 아직 없으면 시작자를 따른다.

#### GA-4에서 정한 것

구현하면서 위 설명과 달라지거나 위에서 정하지 않은 것을 여기 둔다. 위 문단과 이 목록이 다르면 이 목록이 맞다.

- **Client ID.** OAuth에는 App의 Client ID가 필요한데 `github_apps` 행에 없었다. `client_id` 열(nullable, [4절](#github_apps-0192-열-추가))을 더하고, 등록과 `GET …/github-app` 때 읽는 `GET /app`의 `client_id`를 같이 둔다. 이 열이 없는 기존 행은 owner·admin이 GitHub 연결 화면을 한 번 열면 채워진다. 앞 이미지는 이 열을 읽지도 쓰지도 않는다. 앞 이미지가 App을 교체하면 열이 옛 값으로 남을 수 있지만, 다음 `GET …/github-app`이 고친다.
- **콘솔 주소.** 콜백 URL은 `<콘솔 origin>/settings/linked-accounts/github`, 세션 URL은 `<콘솔 origin>/sessions/<id>`다. 콘솔 origin은 환경 변수 `CONSOLE_ORIGIN` 하나다(옛 `SLACK_OIDC_REDIRECT_URI`는 지워졌고, 이번 릴리스에만 그 origin을 대체값으로 읽는다). 없으면 `oauth.callback_url`·`git.session_url`이 null이고, 연결 시작은 `github_oauth_unset`, commit의 `Agent-Session` 트레일러는 세션 id를 싣고(아래 "콘솔 주소가 없을 때의 Agent-Session") PR 꼬리는 세션 id만 싣는다.
- **오류 코드.** 작성용 App·Client ID·client secret·콘솔 origin 가운데 하나라도 없으면 연결 시작과 callback이 `409` `GITHUB_LINK_NOT_CONFIGURED`(`reason_code: github_oauth_unset`)다. Slack의 `SLACK_LINK_NOT_CONFIGURED`와 같은 자리다. 같은 GitHub 계정이 다른 사람에게 연결돼 있으면 `409 LINK_TAKEN`, 이미 GitHub를 연결했으면 `409 LINK_EXISTS`, state 만료·불일치·GitHub의 code 거절은 `400`이다(Slack과 같다).
- **state.** HttpOnly cookie `ap_github_link`(path `/v1/linked-accounts/github`, 10분)에 state, 시작한 사람, 만료 시각을 둔다. callback은 cookie를 늘 지우고, 만료 시각을 서버에서도 본다. 같은 code·state를 다시 보내면 cookie가 없어 `400`이다. GitHub의 code도 한 번만 쓰인다.
- **client secret 저장.** `PUT …/github-settings/oauth-client-secret`는 작성용 App이 없으면 `409` `GITHUB_LINK_NOT_CONFIGURED`(`reason_code: no_author_app`)다. 이 확인은 본문을 읽기 전에 한다(값을 받지 않고 거절한다). 저장소가 같은 확인을 잠금 안에서 한 번 더 한다. secret과 `oauth_client_secret_set`은 한 트랜잭션에서 쓰고 `set_github_app` receipt(`purpose: oauth_client_secret`, `last4`)를 남긴다. 응답은 `{ receipt_id, oauth }`이고 값은 어디에도 돌려주지 않는다. 지우는 경로는 따로 두지 않는다(구성원 계정 연결을 다른 연결로 바꾸거나 마지막 작성용 연결을 해제할 때 같이 지워진다. [결정 11](#결정-11-같은-역할에-app-여럿)의 3·5).
- **user token.** callback은 code를 `POST <github.com>/login/oauth/access_token`으로 바꾸고 `GET /user` 한 번으로 `id`·`login`만 읽은 뒤 token을 버린다. 로그에도 receipt에도 token·code·client secret을 싣지 않는다. `login`은 `^[A-Za-z0-9-]{1,39}$`, `id`는 양의 정수가 아니면 연결하지 않는다(`400`).
- **hook 디렉터리.** `core.hooksPath`를 system에 두면 저장소의 `.git/hooks`가 돌지 않는다. 그래서 플랫폼 hook 디렉터리(`/usr/local/share/werft/git-hooks`)의 모든 client hook은 같은 스크립트 하나이고, 저장소의 `.git/hooks/<이름>`이 실행 가능하면 그것을 먼저 그대로 부른다. `commit-msg`만은 저장소 hook이 성공한 뒤 플랫폼 트레일러를 더하고, 저장소 hook이 실패하면 그 실패로 commit을 멈춘다. `pre-commit install`처럼 `core.hooksPath`가 있으면 설치를 거절하는 도구는 그대로 거절한다(알려진 한계).
- **트레일러 값의 전달.** worker는 claim을 받으면 `$HOME/.werft/git-trailers`에 트레일러를 한 줄에 하나씩 쓴다(`Co-authored-by: …`, `Agent-Session: …`). 값이 없으면 그 줄이 없고, 둘 다 없으면 파일을 지운다. hook은 그 파일의 줄을 `--trailer` argv로만 넘기고, 이 두 키가 아니거나 CR이 든 줄은 건너뛴다. engine의 환경 변수는 바꾸지 않는다.
- **트리거 종류.** 세션 행의 `channel`과 만든 key로 정한다. `web`·`slack`은 그대로, `api`면 만든 key의 `kind`가 `personal`이면 `personal_key`, `agent`면 `agent_key`, key 행이 없으면 `operator_key`다. `channel`이 없는 옛 행은 만든 key가 있으면 그 key로, 만든 사람만 있으면 `web`이다.
- **PR 본문 꼬리.** 꼬리는 `<!-- werft:pr-tail -->` 줄부터 `<!-- /werft:pr-tail -->` 줄까지다. 옛 이름(`agent-platform:pr-tail`)의 꼬리는 첫 태그 전이라 읽지 않는다. 그런 본문은 옛 줄을 글로 두고 끝에 새 꼬리를 붙인다. PR 열기가 GitHub에서 열린 PR을 찾아 답할 때 그 PR 본문에서 마지막 꼬리만 새 꼬리로 바꾸고(표시는 각자 한 줄에 들여쓰기 없이 홀로, 코드 블록과 `<details>`·`<pre>` 같은 HTML 요소 밖에 있을 때만 표시로 보고, 그 사이가 플랫폼이 쓰는 줄을 쓰는 순서 그대로 한 번씩 담을 때만 꼬리로 본다. 사람이 그 안에 한 줄이라도 더하면(`Co-authored-by` 줄도) 그 짝은 사람 글이다. 앞뒤의 사람 글은 줄바꿈(CRLF)까지 쓴 그대로 두고, 같은 본문을 두 번 갱신한 결과는 한 번 갱신한 결과와 같다. 처음 여는 PR 본문도 같은 규칙으로 꼬리를 붙인다. 사람이 문장·코드 블록·HTML 블록에 인용하거나 사이를 고친 표시는 글로 둔다. 그런 짝이 없는 PR은 아무것도 지우지 않고 끝에 붙인다. 본문이 코드 블록이나 HTML 요소를 연 채 끝나면 그것을 닫은 뒤 붙여, 다음 갱신이 꼬리를 다시 찾는다), 이미 기록된 같은 push 요청을 다시 답할 때는 고치지 않는다. 꼬리를 고치지 못해도(GitHub 오류) PR 열기는 실패하지 않고 로그만 남긴다. GA-4b의 성과물 기록은 이 경로의 `savePullRequest` 그대로다.
- **commit 작성자(2026-11-01, 오너 원문 "커밋 작성자가 Werft이고 Co-authored-by가 없는 것: 개선해줘").** 결정 1은 "플랫폼이 연 PR의 작성자는 작성용 App bot"이라 했지만 commit은 이미지 기본값 `Werft <noreply@werft.invalid>`로 남아 있었다. 세션 저장소가 콘솔의 작성용 App(`{ kind: github_app }` 한 줄)을 쓰면 claim의 새 칸 `git_author`가 그 App의 bot 계정 `<slug>[bot]`과 `<bot user id>+<slug>[bot]@users.noreply.github.com`을 싣는다. bot user id는 `GET /users/<slug>[bot]`의 `id`다(GitHub 공식 예: [actions/checkout](https://github.com/actions/checkout#push-a-commit-using-the-built-in-token) "The user email is `{user.id}+{user.login}@users.noreply.github.com`", [actions/create-github-app-token](https://github.com/actions/create-github-app-token#configure-git-cli-for-an-apps-bot-user)). `git` 안이 아니라 옆에 둔 것은 앞 이미지 worker의 `claimGitSchema`가 strict라 새 칸 하나로 claim 전체를 거절하기 때문이다. worker는 `$HOME/.werft/git-identity`에 `[user]`를 쓰고, 이미지의 system 설정이 기본값 뒤에서 `include.path=~/.werft/git-identity`로 읽는다. 값이 없거나 bot 형식이 아니면 파일을 지워 기본값으로 돌아간다. 카탈로그 App, PAT, GHES, GitHub가 아닌 호스트의 저장소와 checkpoint·workspace 내부 commit은 그대로다.
- **콘솔 주소가 없을 때의 Agent-Session.** 위 "콘솔 주소" 항목과 달리, `git.session_url`이 null이면 worker가 `Agent-Session: <세션 id>`를 넣는다. PR 꼬리가 싣는 것과 같은 id다. `git`이 없는 앞 API의 claim에는 지금처럼 아무 트레일러도 넣지 않는다.
- **세션 상세의 귀속 줄.** `GET /v1/sessions/{id}/github/attribution`(`session.read`)이 `{ trigger, attribution: "co_author" | "unlinked" | "app_only", login }`을 준다. 지금 연결 상태로 계산하므로 다음 claim의 commit부터의 귀속이다. 화면은 저장소가 있는 세션의 "결과물" 탭 위쪽에 한 줄로 보인다(GA-4b의 GitHub PR 영역이 같은 자리에 붙는다). 게이트 거절 이유는 리드 결정으로 GA-3에서 GA-4b로 옮겼다([GA-4b에서 정한 것](#ga-4b에서-정한-것)).

#### PR 템플릿과 co-author 결정

D1~D5 확정(2026-11-03). PR 본문 템플릿과 commit 귀속은 플랫폼 도구가 붙인다는 설계에서 오너가 고른 것이다. 에이전트는 내용만 넘기고, 템플릿·트레일러·작성자는 플랫폼 도구와 worker git 설정이 붙인다. 도구별 동작은 [에이전트 행동 도구 카탈로그 10절](action-broker.md#10-오너-결정-d1d11)이 정본이다.

- **D1 (a).** commit에 엔진 이름 `Co-Authored-By: Claude`를 넣지 않는다. 에이전트는 author인 App bot으로 드러나고, 어느 모델이 썼는지는 `Agent-Session`의 세션 기록으로 찾는다. 엔진 어댑터가 엔진 서명을 끄고, commit hook과 턴 끝 복구가 남은 줄을 지우고, push 직전 검증이 그래도 남은 줄을 거절한다.
- **D2 (a).** 저장소에 PR 템플릿이 여럿이면 설정이 고른 것만 쓰고, 설정이 없으면 플랫폼 기본 틀을 쓴다. GitHub도 여럿 가운데 하나를 고르지 않으므로 플랫폼도 추측하지 않는다.
- **D3 (b).** PR 꼬리와 `Agent-Session`의 세션 링크는 워크스페이스 설정 `session_link: url | id`로 정하고 기본은 url이다. 지금 동작은 그대로 두고, 공개 저장소를 다루는 워크스페이스는 콘솔 주소를 빼고 세션 id만 낼 수 있다. 모든 경로가 같은 값을 쓴다.
- **D4 (a).** 에이전트가 구조화 필드 없이 `body`만 보내면 저장소 템플릿에 다시 배치하지 않고 그대로 쓴다(`verbatim`, 설정으로 `as_summary`). 기존 세션의 PR 모양이 갑자기 바뀌지 않게 하려는 것이다. 공통 정리, 엔진 서명 줄 제거, 꼬리는 그대로 적용한다.
- **D5 (a).** 귀속이 틀린 commit(트레일러가 빠졌거나 author가 바뀐 것)은 worker가 턴 끝 checkpoint 직전에 고친다. 원격에 없는 commit만 다시 만들고, 고치지 못하면 `request_push`가 `attribution_mismatch`로 거절한다. 복구는 턴 끝 checkpoint를 확정하기 전에 하고 push는 그 checkpoint의 commit을 고정하므로, "승인 뒤 SHA를 바꾸지 않는다"는 위 규칙은 그대로다. 대신 에이전트가 기억하던 commit SHA가 다음 턴에 바뀔 수 있다.
  - **push 시점 검증(control-host 안의 action-broker).** 정본은 push 직전의 검사다. claim마다 서버가 낸 작성자·co-author·`Agent-Session` 묶음을 `session_commit_attributions`에 쌓고(세션과 값 조합마다 한 행), push는 그 장부로 판정한다. worker가 보낸 값은 기대값에 쓰지 않는다. commit은 세션에 발급된 묶음 중 하나와 맞으면 통과한다. 세션 도중 GitHub 연결이나 작성용 App이 바뀌어도 앞선 commit이 억울하게 거절되지 않게 하려는 것이다. 장부가 비어 있으면(이 변경 전에 claim한 세션) 검사하지 않는다. 장부를 쓰지 못하면 claim이 실패한다. DB가 일시적으로 안 될 때(연결 실패, 53·57 계열, 직렬화 실패·교착·잠금 시간 초과)는 API가 재시도 가능으로 답해 worker가 다시 받고, 그 밖의 오류(예: 마이그레이션 0232 전의 테이블 없음)는 재시도 불가인 `INTERNAL_ERROR`라 worker의 claim이 실패로 끝난다.
  - **검사 범위.** `rev-list <git_commit> --not <PR base 브랜치, 저장소 기본 브랜치, 대상 브랜치>`다. 세 끝점은 `ls-remote` 한 번으로 고정하고, bundle에 없는 것은 SHA로 `refs/push/check/*`에 받는다. 읽지 못하거나 base 브랜치 이름을 쓸 수 없으면 거절한다. 검사를 끄지 않는다. 사람이 쓴 commit을 머지로 끌어온 경우도 거절한다.
  - **`request_push`의 빠른 거절.** worker가 checkpoint manifest의 `attribution`에 틀린 commit을 적어 두면 `request_push`가 사람에게 묻기 전에 거절한다. 이 값은 조언이다. 지워도 push 시점 검사는 그대로다. 서버가 보호한 commit(이전 claim 값으로 만든 것)은 worker가 판정하지 않는다.
  - **복구의 경계.** 도구(`werft-repair-attribution`)는 git plumbing만 쓰고 tree와 부모 수를 바꾸지 않는다. 원격 추적 ref와 서버가 알려 준 보호 commit(최근 checkpoint 32개의 workspace commit)은 다시 만들지 않는다. 보호 목록을 받지 못하거나 manifest 하나라도 검증되지 않으면 복구하지 않는다. 이미 올바른 commit은 해시와 서명을 그대로 둔다. 저장소·HOME의 git 설정은 에이전트가 쓸 수 있으므로 프로그램을 시작할 수 있는 키는 환경 변수 설정으로 고정한다.
  - **배포 순서와 되돌림.** 배포 순서에는 제약이 없다. worker 이미지가 먼저 올라가도(운영은 worker 태그가 먼저, control-host가 뒤다) 새 worker는 옛 control-host에서 `/protected-commits` 404를 받아 복구를 건너뛰고, 보호 목록 없이는 mismatch도 판정하지 않으므로 manifest에 `attribution` 칸을 쓰지 않는다. 옛 worker와 새 control-host는 manifest에 칸이 없어 `request_push`를 통과하고 push 시점에서 막힌다. 제약은 되돌림에만 있다. `attribution` 칸은 선택 칸이지만 옛 control-host의 codec은 모르는 칸을 거절하므로, 이 변경을 되돌리면 이미 저장된 칸이 든 manifest(복구 뒤에도 틀린 commit이 남았을 때만 생긴다)를 옛 코드가 읽지 못한다.
  - **작업 트리 snapshot은 `uncommitted_changes`로 거절한다.** 에이전트가 추적 파일 변경을 commit하지 않고 턴을 끝내면 worker가 만드는 checkpoint commit(`Werft checkpoint`)은 플랫폼의 snapshot이다. snapshot의 identity는 복원용이라 고정이고 무효 주소이며, 내용은 엔진이 판단하지 않았다. 그래서 claim identity를 씌워 받지 않고(그러면 엔진이 보지 않은 내용이 엔진 판단 없이 push된다) `request_push`가 사람에게 묻기 전에 `uncommitted_changes`로 거절한다. 거절 문구는 commit한 뒤 그 턴이 끝난 다음 턴에 다시 요청하라고 말한다. checkpoint는 턴이 끝날 때 잡히므로 같은 턴 안의 재요청은 이전 checkpoint를 다시 본다. 신호는 worker가 manifest `attribution.mismatches`에 `problems`가 빈 항목(snapshot commit)을 쓰는 것이다. 판정이 빈 목록을 내는 일은 없고 옛 control-host도 그 모양을 읽으므로 스키마와 배포 순서는 바뀌지 않는다. 옛 worker나 신호를 쓰지 못한 checkpoint는 지금처럼 push 시점의 `attribution_mismatch`에서 막힌다. untracked 파일만 있는 작업 공간은 commit이 HEAD 그대로라 영향이 없다. 자동 복구(`werft-repair-attribution`)는 commit만 다시 만들고 snapshot은 복구 뒤 capture에서 생기므로 snapshot을 건드리지 않는다.
- **작성자와 Co-author.** PR과 commit 모두 작성자(author·committer)는 플랫폼 GitHub App bot이고, 요청한 사람은 `Co-authored-by`다. 요청한 사람은 세션 시작자가 아니라 그 commit이나 PR 호출이 일어난 턴의 요청자다. 요청자가 GitHub 계정을 연결하지 않았으면 이름을 어디에도 넣지 않는다. commit에는 `Agent-Session`만 남고, PR 꼬리는 이름 없이 계정 미연결이라고만 적는다. 에이전트 key·operator key·스케줄처럼 요청자가 없으면 App 단독이다. 자리별 값은 [호출자 매핑](action-broker.md#7-호출자-매핑)에 있다. 위 "누가 들어가나"와 "미연결 안내"는 이 규칙에 맞춰 고쳤다.
- **D6~D11.** 도구 카탈로그가 도구 관점에서 다시 분류했다. D7·D9·D10은 결정 목록에서 뺐고(D10의 여러 소스 지원은 도구 한계로 남는다), D6(첨부 저장소 push 기본 승인 없음)과 D11(commit bot의 App은 주 저장소의 고정 연결 App. PR 템플릿 설계의 "App 선택은 지금 그대로"를 [claim이 남기는 고정](#claim이-남기는-고정)으로 개정했다)은 도구 기본값이 됐고, D8은 (a)를 유지한다. 판정과 이유는 [도구 카탈로그 10절](action-broker.md#10-오너-결정-d1d11)에 있다.

### 결정 6. push 전 사람 승인

- 릴리스의 `github.push_approval`(boolean)이다. 새 에이전트(GitHub 탭을 처음 저장할 때)의 기본값은 false다(2026-11-02 오너 결정 d123 "기본 카탈로그 auto + push_approval 기본 끔", 처음에는 true였다). 켜고 싶은 에이전트는 탭에서 켠다. `policy_pins.github`가 없는 릴리스(이 기능 전의 모든 릴리스)는 지금도 true로 읽고, 명시적으로 true를 저장한 릴리스도 그대로다. 그래서 기존 에이전트는 데이터를 고치지 않고도 지금 동작 그대로다([5절](#5-기존-설치-이전)). 탭의 상태 줄도 설정 없는 릴리스는 "켜짐"으로 보인다.
- **첫 checkpoint 전의 push 요청(2026-11-02).** push는 지난 턴 끝의 checkpoint만 고정하므로, 세션의 첫 턴에서 커밋하고 바로 부른 `request_push`는 `no_checkpoint`로 거절된다. 이때 내장 MCP는 그 턴을 `push_continuations`에 표시하고, 모델에게 "턴을 끝내면 이어 턴이 온다"고 답한다. 이 답은 오류가 아니라 `status: "deferred"`, `continuation: "after_turn"`인 정상 결과다(2026-11-03). 오류(`PUSH_SOURCE_MISSING`)로 답하던 동안 모델이 사용자에게 "push가 거절됐다"고 말했기 때문이다. 이어 턴이 예약되지 않은 경우(턴이 이미 끝났거나 그 턴이 이어 턴 자체)는 지금처럼 오류다. 그 턴이 checkpoint와 함께 `completed`로 끝나면 finalize 트랜잭션이 플랫폼 턴 하나(actor·channel 없음, 고정 문구)를 큐에 넣고, 모델은 그 턴에서 같은 요청을 다시 부른다. 고정되는 것은 여전히 검증된 checkpoint의 commit뿐이다. 이어 턴은 표시하지 않으므로 이어지지 않고, active가 아닌 세션(pause·close·recovery), checkpoint 없이 끝난 턴, 뒤에 사람 턴이 이미 기다리는 턴에는 만들지 않는다. 마지막 경우는 그 턴이 남길 checkpoint가 원래 요청한 commit이 아닐 수 있어서다. 표시 대상은 요청이 시작될 때 돌던 턴이고, 표시는 finalize와 같은 세션 행 잠금 아래에서 그 턴이 아직 돌 때만 한다. 그래서 늦게 처리된 거절이 다음 턴을 표시하지 않는다. 턴 중간 checkpoint를 포인터로 올리거나 요청을 미뤄 두는 새 상태보다 범위가 작고, 이어 턴에서 PR 열기와 Slack 답까지 이어진다. 그 이어 턴이 도는 동안 사람이 Slack에서 push를 승인하면, 승인 후속 턴("PR을 열어라")이 이어 턴이 연 PR을 한 번 더 여는 일이 있었다(2026-11-03 세션 8daa1a1e). 그래서 승인 후속 턴은 세션에 `running` 턴이 있으면 `push_follow_ups`에 맡겨 그 턴이 끝날 때 PR 기록을 다시 보고 없을 때만 넣는다(2026-11-03). 승인 시점에 바로 빼면 그 턴이 PR 없이 끝날 때 PR이 영영 열리지 않으므로 빼지 않고 미룬다. 고정되는 것은 여전히 검증된 checkpoint의 commit뿐이다. 이어 턴은 표시하지 않으므로 이어지지 않고, active가 아닌 세션(pause·close·recovery), checkpoint 없이 끝난 턴, 뒤에 사람 턴이 이미 기다리는 턴에는 만들지 않는다. 마지막 경우는 그 턴이 남길 checkpoint가 원래 요청한 commit이 아닐 수 있어서다. 표시 대상은 요청이 시작될 때 돌던 턴이고, 표시는 finalize와 같은 세션 행 잠금 아래에서 그 턴이 아직 돌 때만 한다. 그래서 늦게 처리된 거절이 다음 턴을 표시하지 않는다. 턴 중간 checkpoint를 포인터로 올리거나 요청을 미뤄 두는 새 상태보다 범위가 작고, 이어 턴에서 PR 열기와 Slack 답까지 이어진다.
- **갱신(2026-11-09).** `AGENT_ACTION_FLOWS`와 `SESSION_PROMPT_REVISION`은 없어졌다. 턴 안의 `request_push`는 언제나 의도 흐름이고, 이어 턴(`push_continuations`)은 더 만들지 않으며, 엔진에 가는 프롬프트에는 사실만 적는다. 아래 두 문단은 당시 결정의 기록이다.
- **개정 예고(2026-11-04).** 위 이어 턴 문단은 [에이전트 행동 도구 카탈로그](action-broker.md)로 바뀐다. 설치 설정 `AGENT_ACTION_FLOWS`가 켜진 배포에서는 턴 안의 `request_push`가 push 의도가 되어 그 턴이 끝난 결과를 push하고, 이어 턴과 모델에게 주는 안내문이 없다(L4). push 전에 부른 `open_pull_request`는 push 뒤로 예약된다(L5). push 요청은 만들 때의 흐름 `flow`(`legacy` | `actions`)를 행에 적고, 이어 턴과 승인 후속 턴은 `flow = 'legacy'` 요청에만 생긴다. 설정은 새 직접 호출의 경로만 고른다. 설정이 꺼진 동안 만든 직접 요청은 `legacy`라 위 문단 그대로이고, 설정이 켜진 동안 만든 요청과 의도에서 바뀐 요청은 설정을 꺼도 `actions`로 남는다. 아래 "정책 승인은 세션의 주 저장소에만"도 오너 결정 D6으로 바뀐다. 새 release의 첨부 저장소 push는 기본 승인 없음(`push.attached: allow`)이고, 칸이 없는 옛 release는 사람 승인 그대로다(L3). 이 문단들은 각 단위가 머지될 때 고친다.
- **true:** 지금과 같다. 요청은 `requested`로 남고, `sessions:approve`를 가진 사람이 결정한다.
- **정책 승인은 세션의 주 저장소에만(2026-11-03, 2026-11-09에 대체됨: push는 모든 저장소에 `push_approval`과 `push_attached` 중 더 엄격한 쪽 하나로 판정한다. 현재 규칙은 [API 서버 운영 문서](../../operator/api-server.md)).** false여도 부착한 다른 저장소로 가는 push 요청은 `requested`로 남아 사람이 결정한다. 정책 승인은 릴리스가 주 저장소의 자기 작업 브랜치(`agent/<session-id>…`)에 준 것이고, 부착 저장소는 사람 승인 없이 붙으므로([session-repository-attachment.md](session-repository-attachment.md) 결정 3) 쓰기까지 사람 없이 열면 붙이기와 쓰기가 한 번에 열린다. 주 저장소가 없는 `optional` 세션의 push도 모두 사람이 결정한다.
- **false:** push 요청을 만드는 같은 트랜잭션에서 `approved`로 둔다. `decided_by`는 `{ kind: "policy", agent_release_id }`이고 `decide_push` receipt를 남긴다. 결정 0의 "기본값은 PR 작성·수정까지"를 사람 승인 없이 쓰는 경우다.
- **PR 열기·코멘트(두 경우 공통).** push가 끝난(`pushed`) 요청에서는 `session.submit` 호출자(에이전트 key와 내장 MCP 포함)도 PR을 열고 코멘트를 달 수 있다. 사람이 승인했든 정책이 승인했든 같다. PR은 그 요청이 push한 브랜치와 commit으로만 열리므로, 사람 승인이 지키는 것(무엇이 push되나)은 PR을 누가 여느냐와 상관없이 그대로다. 지금은 `sessions:approve` scope와 `session.approve` 권한을 가진 호출자만 PR을 연다(`pull-request-service.ts:103-107`). GA-2가 이 규칙을 바꾼다. `sessions:approve` 호출자는 지금처럼 그대로 열 수 있다.
- 대상 브랜치 고정과 force push 금지는 승인 여부와 상관없이 그대로다.
- **승인이 지키는 것은 commit이다(GA-7).** 요청 뒤에 세션이 checkpoint를 다시 남겼어도, 그 마지막 checkpoint의 commit이 요청이 고정한 `git_commit`과 같고 결정 본문의 `git_commit`도 같으면 승인한다. 셋 중 하나라도 다르면 지금처럼 `409 CHECKPOINT_MOVED`(`checkpoint_moved`)다. push되는 것은 여전히 요청이 고정한 revision의 commit이다. [GA-7에서 정한 것](#ga-7에서-정한-것).

### 결정 7. 릴리스와의 관계

- **릴리스에 넣는 값(보안 값):** 권한(`workflows`·`actions`·`checks`·`issues`·`review`), Actions 허용 목록, 저장소 범위, push 승인이다. 이 값은 카드가 아니라 **릴리스의 입력**이다. 지금 릴리스는 카드 버전·실행 프로필·저장소로 만든다(`packages/contracts/src/kollegium/agents.ts:477-486`). 여기에 `github`를 네 번째 입력으로 더하고 `policy_pins.github`에 넣는다. 그래서 GitHub 설정만 바꾸면 카드 버전은 그대로이고 새 릴리스만 생긴다(GA-MOCKUP 시안 A와 같다). `policy_pins`는 릴리스 id 해시에 들어가므로 값이 바뀌면 릴리스 id도 바뀐다. 릴리스 요청에 `github`가 없으면 지금 활성 릴리스의 `policy_pins.github`를 그대로 물려받는다. 카드를 고쳐 새 릴리스를 만들 때 GitHub 설정이 사라지지 않게 하려는 것이다. 활성 릴리스에 없으면 새 릴리스에도 없다. 이력은 릴리스 목록과 `create_agent_release`·`activate_agent` receipt로 남는다. `policy_pins.github`가 있는 릴리스만 id 버전을 4로 올린다. 없는 릴리스는 지금 버전 그대로 해시되어 기존 id가 검증된다(`release-ids.ts:32-39`의 방식).
- **즉시 반영하는 값:** GitHub 사용 스위치 `agents.github_enabled` 하나다. 끄면 게이트가 그 에이전트의 릴리스로 도는 모든 세션에 새 토큰을 내주지 않는다(`403` `reason_code: github_disabled`). 진행 중인 세션도 다음 토큰 요청부터 거절된다. 대상은 clone(gateway 재허가), push 실행, PR, dispatch, 리뷰다. 플랫폼이 이미 기록한 PR의 상태를 읽는 `outcome_refresh`만 대상이 아니다([10절](#pr-상태-갱신-조회로-한다)). 이미 발급해 캐시한 토큰이 control-host 안에 남아도 게이트가 먼저 거절하므로 쓰이지 않는다. 스위치를 바꾸면 `set_agent_github` receipt를 남긴다.
- 릴리스에 고정된 값도 발급할 때마다 그 시점의 워크스페이스 상한과 App 권한으로 다시 자른다. 상한을 낮추면 기존 릴리스의 그 기능은 다음 발급부터 거절된다(`409` `reason_code: over_workspace_ceiling`). 릴리스나 세션을 `CATALOG_MISMATCH`로 만들지는 않는다. 상한을 다시 올리면 같은 릴리스가 그대로 다시 돈다.

### 결정 8. 에이전트별 저장소 범위

- 릴리스의 `github.repositories`: 카탈로그 저장소 id 목록(1~32개)이다. 고를 수 있는 것은 GitHub App(콘솔 App이나 카탈로그 App)을 쓰는 저장소 가운데 릴리스 프로필이 허용하는 것(`allowedPair`)이다. 릴리스의 `repository_id`가 있으면 목록에 반드시 들어가야 한다(`400` `reason_code: release_repository_outside`).
- **강제.** 게이트는 세션의 저장소가 목록에 없으면 토큰을 내주지 않는다(`403` `reason_code: repository_not_allowed`). 토큰은 지금처럼 그 저장소 하나로 좁혀 발급한다(`repositoryNames`, `forge-github.ts:445`). 그래서 "에이전트 범위로 좁히기"는 GitHub 쪽으로 보면 여전히 저장소 하나짜리 토큰이다. 범위 검사는 발급 전에 한다. 세션을 만들 때도 같은 검사로 미리 거절한다(`409` `reason_code: repository_not_allowed`). clone 단계까지 가서야 실패하지 않게 하려는 것이다.
- `github` 설정이 없는 릴리스는 지금처럼 프로필이 허용하는 모든 저장소를 쓴다.

### 결정 9. 워크스페이스 상한 → 에이전트 좁히기

- 워크스페이스 GitHub 설정의 `ceiling`이다: `{ workflows, actions, checks, issues, review }` 각 boolean. 행이 없으면 모두 false다. 기본 권한(contents·pull_requests)은 상한에 두지 않는다. 그 권한을 막으려면 에이전트 스위치를 끈다.
- 상한은 워크스페이스에 하나다. 같은 역할의 모든 App 연결이 이 상한 하나를 읽는다. App 연결마다 상한을 두지 않는다(오너 결정 2026-11-02, [결정 11](#결정-11-같은-역할에-app-여럿)의 2).
- **누가.** owner·admin만 바꾼다. `workspace.manage`(`policy.ts:241`)이고 API key는 못 한다. 실행 프로필의 규칙과 같다. 저장할 때(`400` `reason_code: over_workspace_ceiling`)와 쓸 때(게이트의 교집합) 같은 정책 함수를 쓴다. 그 함수는 `packages/contracts`에 두어 서버와 콘솔이 같이 쓴다. 워크스페이스 프로필이 `WORKSPACE_PROFILE_POLICY`(`packages/contracts/src/api/profile-derivation.ts:153`)를 저장과 실행에서 같이 쓰는 것과 같다.
- 상한은 App 권한보다 넓게 저장할 수 있다. 실제 허용은 교집합이므로 해가 없다. 화면은 App에 없는 항목에 "App에 권한 없음"을 같이 보인다.
- 상한을 낮출 때 기존 릴리스 처리는 [결정 7](#결정-7-릴리스와의-관계) 마지막 항목과 같다. 상한 변경은 `set_github_ceiling` receipt(이전 값과 새 값)를 남긴다.

### 결정 10. 감사

| operation | 언제 | actor | result |
|---|---|---|---|
| `mint_github_token` (새) | 게이트가 GitHub에 **새로** 토큰을 발급받았을 때. 캐시에서 꺼낸 것은 남기지 않는다 | 그 작업의 actor. clone은 세션 시작자, push 실행기는 없음(null). 시작자가 없으면 null([GA-2에서 정한 것](#ga-2에서-정한-것)) | `session_id`, `agent_id`, `agent_release_id`, `repository_id`, `role`(`author`·`reviewer`), `connection_id`(콘솔 연결이면 그 행 id, 카탈로그 App이면 null), 이 발급이 고정을 썼으면 `pinned_by: first_mint`, `app_id`, `permissions`, `purpose`(`clone`·`push`·`pull_request`·`actions_read`·`dispatch`·`rerun`·`review`·`outcome_refresh`), `expires_at` |
| 게이트의 거절 | 발급 전에 거절했을 때 | 같음 | 같은 칸 + `reason_code`. status `failed`. 연결을 정하지 못하거나 고정된 연결이 닿지 않아 끝난 발급(`503` `forge_failed`)도 남기고 `pin_state`(`none_unreachable`·`lookup_failed`·`pinned_unreachable`)를 싣는다. `ambiguous_app`이면 `candidate_connection_ids`([결정 11](#그대로-지키는-것)) |
| `set_github_app` (있음) | 등록·교체, 구성원 계정 연결에 쓰는 연결 바꾸기(`purpose: user_link`) | 사람 | `app_id`에 `connection_id`, `role`, `permissions`, `warnings`를 더한다. 옛 역할 주소의 교체가 고정을 지웠으면 `pins_cleared`, 같은 App을 다시 더해 고정을 되살렸으면 `pins_restored`, `purpose: user_link`이면 `before`·`after`(연결 id) |
| `delete_github_app` (있음) | 연결 해제 | 사람 | `connection_id`, `app_id`, `role`, 해제할 때의 영향(`pinned_repository_count`, `agent_count`, `active_session_count`) |
| `set_repository_github_app` (새) | 에이전트의 저장소 고르기가 고정을 남김, 관리자가 고정 연결을 바꿈, 세션 claim이 주 저장소의 고정을 남김([결정 11](#저장소에-고정된-연결)) | 사람(고르기와 관리자 변경 모두 콘솔 세션 cookie만 받는다) | `repository_id`, `role`, `pinned_by`(`selection`·`admin`), `before`, `after`(연결 id). claim이 남긴 고정은 actor가 null이고 `event: pinned_at_claim`, `pinned_by: claim`, `app_id`, `session_id`, `before: null`, `after`가 실린다 |
| `set_github_ceiling` (새) | 상한 변경 | owner·admin | `before`, `after` |
| `set_agent_github` (새) | 스위치 변경 | 에이전트 관리자 | `agent_id`, `enabled` |
| `create_agent_release`·`activate_agent` (있음) | GitHub 보안 값 변경 | 그대로 | result에 `github`(릴리스의 `policy_pins.github`)를 더한다 |
| `review_pull_request` (새) | 리뷰 제출과 그 거절 | 세션 작업의 actor | `session_id`, `agent_id`, `repository_id`, `number`, `commit_id`, `event`(`APPROVE`·`REQUEST_CHANGES`·`COMMENT`), `review_id`, PR을 연 `opened_by_session_id`·`opened_by_agent_id`(플랫폼이 연 PR이면) |
| `dispatch_workflow`·`rerun_workflow` (새) | dispatch·rerun과 그 거절 | 같음 | `workflow`, `ref` 또는 `run_id`, `allowed_by`(맞은 목록 항목) |
| `link_account`·`unlink_account` (있음) | GitHub 연결·해제 | 본인 | `provider: "github"`, `external_user_id`, `login` |
| `decide_push` (있음) | push 승인을 끈 릴리스의 자동 승인 | null. `approved_by`의 policy decider가 누구인지 말한다 | `agent_release_id` |

- receipt는 토큰 값을 싣지 않는다. 지금 forge가 오류에 요청 헤더를 남기지 않는 규칙(`forge-github.ts:642-660`)을 그대로 따른다. GitHub 오류 원문, dispatch `inputs`의 값, 리뷰 본문도 싣지 않는다. 상태, 플랫폼의 `reason_code`, 위 표의 칸만 싣는다.
- **선행 수정.** 에이전트별 감사를 하려면 receipt의 `agent_id`가 채워져야 한다. 지금은 늘 null이다(`policy.ts:43-50`). GA-1에서 `receiptActorOf`가 caller의 에이전트 key의 `agent_id`를 싣게 고친다. **`actor.agent_id`는 호출자 key에서만 채운다**("누가 했나"). 사람이 부르면 null이고, 다른 에이전트의 key가 불렀으면 그 에이전트다. 위 표의 `result.agent_id`는 세션 릴리스에서 채운다("어느 에이전트의 세션인가"). 둘은 다를 수 있고, 게이트가 actor 쪽을 세션 릴리스로 덮어쓰지 않는다. 내장 MCP 호출의 actor는 GA-7이 정한다([9절](#9-구현-pr-분할)).
- **에이전트별 활동 조회(`…/github/activity`).** actor로 찾지 않는다. 사람이 릴리스를 만들면 actor에 에이전트가 없기 때문이다. 대상으로 찾는다. 둘을 합친다. (1) 에이전트 대상 receipt: `target_ref.resource`가 `{ kind: "agent", id }`인 것(`set_agent_github`, `create_agent_release`, `activate_agent`. 지금 에이전트 receipt가 이 모양이다, `packages/db/src/agents.ts:162-170`). (2) 세션 대상 receipt: `target_ref.session_id`가 있고 그 세션의 릴리스가 이 에이전트의 것인 것(`mint_github_token`, 게이트 거절, `review_pull_request`, `dispatch_workflow`, `rerun_workflow`). 게이트 receipt는 그래서 `target_ref`에 `session_id`를 싣는다. (2)는 호출자가 볼 수 있는 세션만 남긴다. 세션 목록과 같은 술어(`sessionVisibleTo`, `packages/db/src/session-shares.ts:95-100`)를 SQL에서 걸고 나서 최근 20개를 자른다. 에이전트 관리자라도 공유받지 않은 세션의 기록은 받지 못한다. 단건 receipt 조회가 세션의 `session.read`를 검사하는 것(`packages/platform/src/sessions/session-service.ts:1360-1368`)과 같은 경계다.
- 발급이 잦은 clone(gateway 재허가)도 캐시 덕분에 토큰 하나에 receipt 하나다. 토큰은 1시간 유효하고, 만료 10분 전에 다시 발급한다(`forge-github.ts:28`).
- 위 표의 `connection_id`와 `set_repository_github_app`은 2026-11-02 개정에서 더했다. 이전 결정: 역할마다 연결이 하나라 `role`만으로 어느 App인지 정해졌다. 바뀐 이유: 오너 결정(2026-11-02) 1로 한 역할에 연결이 여럿이 되어, 어느 연결이 발급했는지를 행 id로 남겨야 한다.

### 결정 11. 같은 역할에 App 여럿

- 오너 원문(2026-11-02, 오케스트레이터 경유): "결정필요 추천대로 해줘". 아래 1~5가 그 다섯 건이다. 설계 근거는 GitHub 연결 설정 재설계안(repo 밖 문서 6·7절)과 그 설계에 대한 Codex 의견 두 번이다.
- 이전 결정: 역할(작성용·리뷰용)마다 App 연결 하나였다(결정 1, [4절](#github_apps-0192-열-추가)의 `UNIQUE (workspace_id, role)`, [6절](#6-api)의 `…/github-apps/{role}`). 바뀐 이유: 한 워크스페이스가 저장소마다 다른 App(조직마다 App, 저장소 묶음마다 App)을 써야 하는 경우를 받지 못했다. 오너가 추천안대로 바꿨다.
- 이 절은 위 결정 1·2, [GA-4에서 정한 것](#ga-4에서-정한-것), 3절 게이트, 4절, 6절, [GA-5에서 정한 것](#ga-5에서-정한-것), [GA-3에서 정한 것](#ga-3에서-정한-것) 가운데 "역할마다 App 하나"를 전제한 문장을 대체한다. 둘이 다르면 이 절이 맞다. 그 문장들은 이렇게 읽는다.
  - "작성용 App"이 OAuth를 뜻하는 곳(GA-4의 Client ID·client secret·`no_author_app`)은 아래 3의 연결이다. `client_id` 채우기는 `GET …/github-apps/{connectionId}`와 목록 조회에서도 한다.
  - App 권한을 읽는 곳(결정 2, `GET …/github-apps/{role}`)은 연결마다 읽는다. 탭의 `app_permission_missing` 판정(GA-3)은 고른 저장소의 고정 연결의 권한으로 하고, 고정이 없는 저장소는 판정하지 않는다. 실제 판정은 발급이 한다.
  - GA-5의 `GET …/github-apps/{role}` 응답 `repositories[]`(저장소별 설치 권한)는 그 주소가 동작하는 연결 0·1개일 때의 그 연결 기준이다. 연결 id 주소의 `GET`도 같은 칸을 그 연결 기준으로 준다.
  - 저장소별 "App 미설치" 배지(GA-5의 `installed: { author, reviewer }`)는 역할마다 고정된 연결이 닿는지로 정한다. 고정이 없으면 그 역할의 연결 하나라도 닿으면 true, 모두 닿지 않으면 false, 조회 실패가 있거나 닿는 연결이 여럿이면 null이다.

1. **같은 역할에 App 여럿을 둔다.** 연결은 `github_apps` 행 하나이고, 행 id를 API에 `connection_id`로 낸다. 같은 워크스페이스에서 같은 `app_id`는 역할이 달라도 한 행이다. "GitHub 계정(설치 account)마다 App 하나" 같은 등록 제약은 두지 않는다. 등록 때의 검사는 그 뒤의 설치, 저장소 이전, 동시 등록, 조회 실패를 막지 못하므로 실행 계약이 되지 못한다(Codex 2차). 실행 때 App을 하나로 정하는 것은 아래 [저장소에 고정된 연결](#저장소에-고정된-연결)이다. 토큰은 고정된 연결만 발급하고, 다른 연결로 대신 발급하지 않는다. 옛 역할 단위 API(`…/github-apps/{role}`, `…/github-app`)는 그 역할의 연결이 0개나 1개일 때만 지금처럼 동작하고, 여럿이면 `409 GITHUB_APP_CONFLICT`(`reason_code: ambiguous_role`)다. 목록 순서로 하나를 고르지 않는다. 옛 역할 주소의 `PUT`이 지금처럼 다른 `app_id`로 교체하면, 같은 트랜잭션에서 그 연결(`connection_id`가 교체하는 행)에 고정된 행을 지우고 `set_github_app` receipt에 `pins_cleared`(지운 수)를 남긴다. 연결 id가 빈 다른 App의 고정은 지우지 않는다. 그 뒤 같은 트랜잭션에서 새 `app_id`의 빈 고정을 되살린다([4절](#catalog_repository_github_apps-새)의 `app_id`). 순서는 지우기 다음 되살리기다. 연결 행 id는 그대로라도 고정이 receipt 없이 다른 App으로 옮겨가지 않는다. 그 역할의 연결은 이 하나뿐이므로 다음 발급이 새 App으로 고정을 다시 남기고(`pinned_by: first_mint`), 새 App이 닿지 않는 저장소는 설치 없음으로 거절된다. 기존 공개 API의 교체 동작을 깨지 않으려고 고른 방식이다(리드 결정 2026-11-02). manifest로 App을 만드는 경로(JeongJaeSoon/agent-platform#1001)는 이 개정 뒤 늘 새 연결을 더한다. 기존 연결을 교체하지 않으므로 그 경로의 `replace`와 `author_app_exists`·`author_app_changed`는 쓰지 않는다. 다른 App으로 옮기는 것은 새 연결을 더한 뒤 옛 연결을 해제하는 것이다(아래 5).
2. **기능 상한은 워크스페이스에 하나다.** `github_workspace_settings.ceiling` 그대로다([결정 9](#결정-9-워크스페이스-상한--에이전트-좁히기)). 같은 역할의 모든 연결이 같은 상한을 읽는다. 연결마다 다른 것은 App 권한과 설치 승인 권한뿐이고, 그것은 고정된 연결의 발급 요청이 판정한다([결정 2](#결정-2-app-최대-권한설치-상한)).
3. **구성원 계정 연결(OAuth)은 설정에 명시한 연결로 한다.** `github_workspace_settings.user_link_connection_id`([4절](#github_workspace_settings-새))가 그 연결이고, 작성용 연결만 고를 수 있다. 작성용 연결이 하나면 그것이다. 첫 작성용 연결을 등록할 때 같은 트랜잭션에서 이 칸을 채우고, 이전 마이그레이션은 기존 작성용 행으로 채운다. 읽을 때 칸이 비어 있고 작성용 연결이 하나면 그 연결로 읽는다. 섞인 배포 동안 앞 이미지가 첫 작성용 연결을 등록하면 칸이 빈 채 남기 때문이다. 같은 이유로 작성용 연결을 더하는 `POST`는 칸이 비어 있고 기존 작성용 연결이 하나면 그 기존 연결로 같은 트랜잭션에서 칸을 채운다. 그래서 두 번째 작성용 App을 더해도 구성원 계정 연결이 꺼지지 않는다. Client ID와 client secret은 이 연결의 것이다. 연결을 바꾸면 같은 트랜잭션에서 client secret을 지우고 `oauth_client_secret_set`을 false로 둔다. 새 App의 client secret은 다시 받는다. 진행 중인 OAuth 콜백은 state에 담은 연결 id가 지금 값과 다르면 `400`으로 끝난다.
4. **리뷰 승인용 App의 설치 저장소도 페이지 목록으로 보인다.** 저장소 페이지 API(`GET …/github-repositories`, [settings-replace-file-catalog.md 1.1절](settings-replace-file-catalog.md#11-github-app-저장소-등록-없이-설치-목록이-정본))의 `installations[]`에 모든 연결(작성용·리뷰용)의 설치를 넣고, 항목마다 `connection_id`, `role`, 설치 승인 권한 `permissions`, 저장소 수 `repository_count`(읽지 못하면 null)를 더한다. 요청의 `installation_id`가 이 워크스페이스 연결의 설치가 아니면 `404`다. `installation_id`를 생략하면 1.1절의 기본값(정지되지 않은 첫 설치, account 이름순)을 쓴다. 기본값을 고르는 역할은 작성용이고, 작성용 연결이 없으면 리뷰용이다. 그 역할의 연결이 여럿일 때만 `400` `reason_code: installation_required`다. 그래서 작성용 하나와 리뷰용 하나면 기본값을 쓴다. 리뷰용 설치의 저장소 행에서 `agent_count`는 리뷰를 켠 에이전트 가운데 그 저장소를 고른 수다. 에이전트의 저장소 고르기(`POST /v1/agents/{id}/github/repositories`)는 지금처럼 작성용 설치만 받는다. 1.1절의 "작성용 App"(상한 `installed`, 설치 밖 목록)은 작성용 연결 어느 것이든이다.
5. **사용 중인 연결도 영향을 확인한 뒤 해제할 수 있다.** 콘솔은 해제 전에 `GET …/github-apps/{connectionId}`의 `usage`로 그 연결에 고정된 저장소 수, 그 저장소를 쓰는 에이전트 수(활성 릴리스의 `github.repositories`에 고정 저장소가 있는 `github_enabled` 에이전트. 리뷰용이면 그 가운데 `review`를 켠 것), 고정 저장소에서 진행 중인 세션 수를 읽어 확인 창에 보인다. `github` 설정이 없는 릴리스는 프로필이 허용하는 모든 저장소를 쓰므로 에이전트 수에 들지 않는다. 그래서 확인 창은 에이전트 수를 "적어도 N개"로 쓴다. 해제를 막는 것은 구성원 계정 연결에 쓰는 연결 하나뿐이다(`409 GITHUB_APP_CONFLICT`, `reason_code: in_use_for_user_link`). 이 판정은 칸의 값이 아니라 위 3의 읽기 규칙으로 정한 연결로 한다(칸이 비어 있고 작성용 연결이 하나면 그 연결). 다른 작성용 연결로 바꾼 뒤에 해제한다. 막는 것은 다른 작성용 연결이 있을 때뿐이다. 마지막 작성용 연결이면 지금처럼 해제를 받고, 같은 트랜잭션에서 client secret을 지우고 `user_link_connection_id`를 비운다. 그러면 구성원 계정 연결의 새 시작이 꺼지고, 확인 창의 영향 항목에 이것을 적는다. 마지막 작성용 연결을 막지 않는 것은 오너 결정(2026-11-02, "b 로 좋은거 같아")이다. 공개 API(`DELETE …/github-app`, `…/github-apps/author`) 호환을 지키고 GitHub 연결을 완전히 걷어낼 수 있게 하려는 것이다. 이전 결정: 작성용 App을 지우면 client secret만 같이 지워졌다. 이미 연결한 구성원의 연동 계정 행은 GitHub 숫자 id로 사람을 가리키고 App과 무관하므로, 구성원 계정 연결을 다른 연결로 바꿔도 그대로 남고 Co-authored-by도 계속 들어간다. 바뀌는 것은 새 연결 시작뿐이다(client secret을 다시 넣기 전까지 `github_oauth_unset`). 해제는 한 트랜잭션에서 행과 키 슬롯을 지우고, 그 연결의 고정은 연결 id를 비워 남긴다. 해제 확인 창은 "같은 App을 다시 더하면 이 고정이 되살아납니다"를 적는다([4절](#catalog_repository_github_apps-새)의 `app_id`). 그 저장소들은 다음 토큰 요청부터 `pinned_app_removed`로 거절된다. 진행 중인 세션도 같다. 그 연결의 토큰 캐시는 통째로 버린다([3절](#github-게이트)).

#### 저장소에 고정된 연결

GitHub App을 쓰는 카탈로그 저장소(`auth` `{ kind: github_app }`)마다 역할별로 연결 하나를 고정한다([4절](#catalog_repository_github_apps-새)). 카탈로그에 App을 직접 적은 저장소(`app_id`·`installation_id`)는 그 App을 쓰고 고정이 없다. 게이트는 [6단계](#github-게이트)에서 아래 표대로 연결을 고른다. "닿는다"는 그 연결의 App JWT로 `GET /repos/{owner}/{repo}/installation`(`installationFor`)이 설치를 돌려준다는 뜻이다.

| 고정 | 그 역할의 연결이 저장소에 닿는 수 | 동작 |
|---|---|---|
| 없음 | 0개 | 거절. 지금의 설치 없음 경로와 같다(`503` `forge_failed`). 리뷰용 연결이 하나도 없으면 `409` `no_reviewer_app`이다([결정 1](#결정-1-리뷰-전용-app)). 고정을 남기지 않는다 |
| 없음 | 1개 | 그 연결로 발급하고 고정을 남긴다. `INSERT … ON CONFLICT DO NOTHING` 뒤 다시 읽어, 동시에 먼저 남은 고정이 있으면 그것을 따른다 |
| 없음 | 2개 이상 | 거절 `409 GITHUB_REFUSED`, `reason_code: ambiguous_app`. 관리자가 고정을 정할 때까지 고정을 남기지 않는다 |
| 없음 | 조회 실패(어느 연결 하나라도 GitHub 오류·rate limit·App JWT 거절) | 다시 시도할 수 있는 실패(`503` `forge_failed`). 닿는다고 답한 연결만으로 고르지 않고, 고정을 남기지 않는다. 키가 거절된 연결 하나가 그 역할의 고정 없는 저장소를 모두 막으므로, 관리자는 그 연결의 키를 교체하거나 해제하거나, 저장소마다 고정을 정해 푼다(고정 변경은 대상 연결 하나만 묻는다) |
| 있음 | 고정된 연결이 닿음 | 그 연결로 발급한다. 다른 연결이 닿는지는 묻지 않는다 |
| 있음 | 고정된 연결이 닿지 않음(설치 해제, 설치에서 저장소 뺌, 저장소 이전) | 지금의 설치 없음 거절과 같다(`503` `forge_failed`). 다른 연결로 대신 발급하지 않고 고정도 바꾸지 않는다 |
| 있음 | 고정된 연결이 해제됨(연결 id가 빔) | 거절 `409 GITHUB_REFUSED`, `reason_code: pinned_app_removed`. 대신 발급하지 않는다 |

- **고정이 생기는 곳은 넷이다.** (1) 에이전트가 저장소를 고를 때(settings-replace-file-catalog.md 1.1절의 고르기). 서버는 1.1절의 확인(`installationFor`로 그 저장소의 설치 id가 요청의 `installation_id`와 같은지)을 마친 뒤에만, 그 설치의 연결을 작성용 고정으로 남긴다. 호출자가 보낸 `installation_id`만 믿고 쓰지 않는다. 이 고정은 `set_repository_github_app` receipt(`pinned_by: selection`, `before: null`)로 남는다. 고르기는 `agent.manage`(에이전트별 관리자인 member 포함)가 하므로, 이 고정은 관리자가 바꿀 때까지 워크스페이스의 모든 에이전트에 대해 그 저장소의 작성용 App을 정한다. 연결은 이미 그 저장소에 닿는 App이고 실행 권한을 넓히지 않는다. 이미 다른 연결로 고정돼 있으면 고정을 바꾸지 않고, 응답 `{ catalog_id, connection_id }`의 `connection_id`가 고정된 연결을 알린다. (2) 고정이 없는 저장소의 첫 발급(위 표의 1개). #992에서 넘어온 행과 리뷰용 첫 사용이 여기로 온다. (3) 관리자가 바꿀 때(`PUT …/github-repositories/{catalog_id}/app-pins/{role}`, [6절](#6-api)). 서버는 그 연결이 같은 역할이고 저장소에 닿는지 확인하고, 아니면 `400`(`reason_code: role_mismatch`·`not_installed`)이다. `set_repository_github_app` receipt를 남기고 다음 토큰 요청부터 적용한다. (4) 세션 claim이 주 저장소에 고정이 아직 없을 때([아래](#claim이-남기는-고정))
- 릴리스에는 연결 id를 넣지 않는다. 그래서 릴리스 지문과 릴리스 이전 규칙([결정 7](#결정-7-릴리스와의-관계))은 바뀌지 않는다. 같은 릴리스가 저장소마다 다른 App을 쓴다.
- `outcome_refresh`도 작성용 고정으로 같은 표를 따른다. `ambiguous_app`·`pinned_app_removed`는 `check_error: github_refused`, 설치 없음과 조회 실패는 `forge_failed`로 남고([10절](#pr-상태-갱신-조회로-한다)의 실패 규칙), 다음 간격에 다시 읽는다.
- 이 고정의 판정은 발급 요청마다 하고, 캐시에서 꺼낸 토큰을 줄 때도 고정 연결의 캐시에서만 꺼낸다.

#### claim이 남기는 고정

D11 개정(PR 0). 이전 결정: PR 템플릿 설계 4.1절이 "App 선택은 지금 그대로"라 commit 작성자는 이미 고정된 App만 따랐고, 고정이 없으면 이미지의 `Werft`였다. 바뀐 이유: commit의 bot과 PR을 여는 bot이 달라지지 않게 하려는 것이다. 구현은 PR 2이고 아래가 그 코드의 동작이다(`worker-gateway.ts`의 `pinAtClaim`, `github-pins.ts`의 `pinFirst`).

- **허용 조건.** 세션의 주 저장소가 콘솔에 등록한 App으로 연결돼 있고(카탈로그가 직접 지정한 App과 PAT 연결 저장소는 해당 없음), 그 저장소의 작성용 고정이 아직 없을 때만 claim이 고정을 남긴다. 고르는 규칙은 토큰 발급의 위 표와 같은 resolver다. 작성용 연결 가운데 그 저장소에 닿는 것이 정확히 하나일 때만 고정하고, 둘 이상이면 `ambiguous_app`, 닿는 연결이 없으면 `none_unreachable`, GitHub가 답하지 않으면 `lookup_failed`로 고정하지 않는다. 고정이 이미 있으면 그것을 따르고 새로 쓰지 않는다. 고정은 `INSERT … ON CONFLICT DO NOTHING`이고 연결이 그 사이 교체됐는지를 쓰기 잠금 안에서 다시 확인한다.
- **출처와 감사.** `pinned_by = 'claim'`이다. `first_mint`로 적지 않는다. 같은 트랜잭션에서 `set_repository_github_app` receipt를 쓰고 result의 `event`가 `pinned_at_claim`이다([4절](#4-데이터-모델)의 receipt 표). 사람이 한 일이 아니므로 actor는 null이고 result에 `session_id`와 `app_id`가 들어간다. 고정이 생기지 않았으면 receipt도 없다.
- **실패해도 claim은 계속한다.** 아래 어느 경우에도 claim은 막히지 않고 commit 작성자를 `Werft`(`noreply@werft.invalid`)로 하여 그대로 발급된다. 이미 만든 고정과 receipt는 되돌리지 않는다. 로그 문구는 계약이 아니다.
  - 고정을 만들지 못함(위 거절 사유, `no_author_app`, 저장소 URL을 읽지 못함, resolver의 예외): 고정도 receipt도 없다.
  - 고정은 만들었으나 다시 읽은 결과가 없거나(`not_pinned`) 읽기가 예외로 끝남: 이 claim이 고정을 만들었다면 고정과 `pinned_at_claim` receipt는 남는다.
  - 고정을 읽었으나 bot 사용자 조회가 실패하거나 답이 없음: 고정과 receipt는 남는다.

#### 그대로 지키는 것

- **에이전트별 저장소 범위([결정 8](#결정-8-에이전트별-저장소-범위)).** 고정은 "어느 App이 발급하나"만 정한다. 저장소가 릴리스 `github.repositories` 안인지는 게이트 3단계가 고정을 보기 전에 판정하고(`repository_not_allowed`), 고정이 있어도 범위 밖 저장소의 토큰은 나오지 않는다. 토큰은 지금처럼 저장소 하나로 좁혀 발급한다. 저장소를 고정한 연결이 다른 저장소에도 설치돼 있어도 범위는 넓어지지 않는다.
- **게이트 하나의 발급([3절](#github-게이트)).** 고정을 읽고 쓰는 것은 게이트 6단계 안이고, 고정을 고른 연결의 발급기만 installation token을 만든다. 고르기와 관리자 변경은 App JWT로 `installationFor`만 부르고(해제 영향 조회는 DB만 읽는다) installation token을 발급하지 않는다(고르기가 owner/name을 읽는 설치 토큰은 settings-replace-file-catalog.md 1.1절의 관리 경로 그대로이고 세션 작업에 쓰이지 않는다). 그래서 게이트를 거치지 않고 세션 작업용 토큰을 얻는 경로는 늘지 않는다.
- **어느 연결이 발급했나([결정 10](#결정-10-감사)).** `mint_github_token`과 게이트 거절 receipt의 result에 `connection_id`를 싣는다. 첫 발급이 고정을 남겼으면 그 `mint_github_token` result에 `pinned_by: first_mint`를 더한다. 고르기와 관리자 변경이 남긴 고정은 `set_repository_github_app`(`pinned_by: selection`·`admin`)으로, claim이 남긴 고정은 같은 operation의 `event: pinned_at_claim`(`pinned_by: claim`)으로, 옛 역할 주소의 교체가 지운 고정은 `set_github_app`의 `pins_cleared`로, 해제된 고정이 되살아난 것은 `set_github_app`의 `pins_restored`로 남는다. 고정 없이 설치 없음·조회 실패로 끝난 발급과, 고정된 연결이 닿지 않은 발급도 게이트 실패 receipt를 남기고 result에 `pin_state`(`none_unreachable`·`lookup_failed`·`pinned_unreachable`)를 싣는다. `ambiguous_app` 거절은 `candidate_connection_ids`(닿은 연결들)를 싣는다. 그래서 고정이 언제 누구에 의해 생겼는지와, 토큰마다 어느 연결이 발급했는지를 receipt만으로 찾는다.
- **`same_app`과 `no_author_app`의 비교 대상.** `same_app`은 새로 등록하거나 옛 역할 주소로 교체하는 `app_id`를 그 워크스페이스의 **다른 모든 연결**(역할 상관없이, 바꾸는 연결 자신은 빼고)과 비교한다. 같은 App의 키 교체는 자기 자신과만 같으므로 걸리지 않는다. `UNIQUE (workspace_id, app_id)`가 같은 판정을 DB에서 한 번 더 한다. 그래서 리뷰용 App은 어느 작성용 App과도 같지 않고, 작성용 App이 여럿이어도 리뷰용 App은 작성용 App이 연 PR의 작성자와 같은 App일 수 없다. `no_author_app`은 리뷰용 연결을 더할 때 작성용 연결이 **하나라도** 있는지만 본다. 리뷰용 연결을 특정 작성용 연결과 짝짓지 않는다. 마지막 작성용 연결을 해제해도 리뷰용 연결은 남는다([GA-5에서 정한 것](#ga-5에서-정한-것)과 같다).

## 3. 토큰 발급 경로와 좁히기

### GitHub 게이트

`packages/platform`에 포트 하나를 더하고 control-host가 구현한다. 지금 호출자는 `ForgeResolver`(`packages/platform/src/ports/forge.ts:76`)에서 adapter를 받아 `gitCredential(repo, access)`를 부른다. 이 자리를 게이트로 바꾼다.

```ts
// packages/platform/src/ports/github-gate.ts (sketch)
export type GitHubPurpose =
  | "clone" | "push" | "pull_request"
  | "actions_read" | "dispatch" | "rerun" | "review"
  // GA-4b: the platform reading a PR it recorded (section 10).
  | "outcome_refresh";

export type GitHubWork = {
  sessionId: string;
  purpose: GitHubPurpose;
  // Passed, but never trusted: the gate checks it again against the
  // session row (its own repository, its attached list) and the release.
  repositoryId?: string;
  /** dispatch only. */
  workflow?: { file: string; ref: string };
  /** rerun only. The gate finds its workflow and ref in github_workflow_dispatches. */
  runId?: number;
  actor: ReceiptActor;
};

// What a granted piece of work may call: bound to one repository, one App
// and one credential the gate issued. No method issues a credential itself.
export interface GitHubGrant {
  readonly role: "author" | "reviewer";
  readonly repo: RepoRef;
  readonly permissions: Readonly<Record<string, "read" | "write">>;
  /** For git over HTTP (clone, push). */
  readonly gitCredential: GitCredential;
  /** REST calls with that same credential (PR, comment, run, dispatch, review). */
  readonly api: GitHubApi;
}

export interface GitHubGate {
  /** Refuses with GitHubGateError(reason_code) before any GitHub call. */
  grant(work: GitHubWork): Promise<GitHubGrant>;
}
```

- 원칙: 호출자는 저장소를 넘기되, 게이트가 세션 행(주 저장소와 부착 목록)과 릴리스로 다시 검증한다. 넘긴 값은 힌트일 뿐 허용 범위를 넓히지 않는다. 주 저장소가 아닌 저장소에는 `clone`·`push`·`pull_request`와 플랫폼의 `outcome_refresh`만 허용한다([session-multi-repository.md](session-multi-repository.md) 결정 1·5).
- `grant`가 하는 일, 이 순서로:
  1. 세션 → 릴리스 → 에이전트를 읽는다. 릴리스가 없는 세션은 "기본 설정"을 쓴다. 기본 설정은 GitHub 켜짐, push 승인 켜짐, 선택 권한 없음, 프로필이 허용하는 모든 저장소다. 지금 동작과 같다.
  2. `agents.github_enabled`이 false면 `github_disabled`다.
  - `outcome_refresh`만 예외다. 1단계, 3단계의 저장소 binding 검사, 6~8단계만 하고 2단계, 3단계의 릴리스 범위 검사, 4·5단계는 건너뛴다([10절](#pr-상태-갱신-조회로-한다)). 에이전트의 작업이 아니라 플랫폼이 이미 기록한 PR을 읽는 것이기 때문이다.
  3. 세션 행의 저장소와 그 binding을 읽는다(gateway의 지금 검사 `worker-gateway.ts:1226-1240`와 같다). 그 저장소가 릴리스 `github.repositories` 밖이면 `repository_not_allowed`다. 호출자는 저장소를 고를 수 없다.
  4. purpose별 필요 권한을 정한다([표](#작업별-권한)). 선택 권한이 필요한데 릴리스가 끈 것이면 `feature_off`, 상한이 막으면 `over_workspace_ceiling`이다. App·설치 권한은 여기서 보지 않고 6단계의 발급 요청이 판정한다.
  5. dispatch·rerun이면 허용 목록을 맞춘다(`workflow_not_allowed`).
  6. role(`review`만 `reviewer`)과 저장소로 [고정된 연결](#저장소에-고정된-연결)을 정해 그 연결의 발급 함수를 고르고, 저장소 하나와 권한으로 installation token을 요청한다. 고정이 없고 닿는 연결이 여럿이면 `ambiguous_app`, 고정된 연결이 해제됐으면 `pinned_app_removed`다. (이전 결정: 역할의 연결 행 하나를 골랐다. 바뀐 이유: 오너 결정 2026-11-02 1.) GitHub가 권한 부족으로 거절하면 `app_permission_missing`이다([결정 2](#결정-2-app-최대-권한설치-상한)).
  7. 새로 발급했으면 `mint_github_token` receipt를 남긴다. 거절했으면 거절 receipt를 남긴다.
  8. 그 자격 증명에 묶인 `GitHubGrant`를 돌려준다.
- **발급은 게이트 안에만 있다.** 지금 `ForgeAdapter`는 메서드마다 스스로 자격 증명을 얻는다(`call()`이 `credential()`을 부른다, `forge-github.ts:179-191`). PR 조회·생성, 저장소 조회, 코멘트가 모두 이 경로다. GA-2는 이 발급 함수(`issuer`, `forge-github.ts:407-460`)와 캐시(`forge-github.ts:152-177`)를 게이트 구현 안으로 옮긴다. REST 메서드는 `GitHubGrant.api`로 옮겨 받은 자격 증명만 쓰게 한다. 그래서 게이트를 거치지 않고 토큰을 얻는 코드 경로가 남지 않는다. 캐시는 지금처럼 **연결마다 따로** 둔다. 지금 캐시 키(`owner/name|permissions`, `forge-github.ts:156-159`)에는 GitHub 서버가 없고, 격리는 연결마다 forge를 따로 만드는 것(`forge-github.ts:722-736`)이 해 준다. 게이트도 연결(콘솔 연결의 행 id, 또는 카탈로그 저장소의 `api_base`·`app_id`·`installation_id`)마다 발급기와 캐시 한 벌을 두고, 그 안의 키는 지금 그대로 쓴다. 콘솔 연결 행이 바뀌면 그 연결의 캐시를 통째로 버린다(지금 `createRegisteredGitHubForge`가 연결이 바뀌면 forge를 새로 만드는 것과 같다). GA-2 테스트: 서로 다른 `api_base`에서 같은 App id·같은 저장소 이름을 쓰는 두 연결이 서로의 토큰을 받지 않는다. 캐시에서 꺼낸 토큰을 줄 때도 1~5단계는 매번 다시 한다(`outcome_refresh`는 위 예외의 단계만).
- **카탈로그 App 저장소**(`app_id`를 적은 저장소)도 같은 게이트를 지난다. 그 저장소의 `author` 연결은 카탈로그의 App이고 `reviewer` 연결은 없다. 그래서 리뷰는 `no_reviewer_app`이다. App 권한은 그 App의 `GET /app`을 처음 발급할 때 한 번 읽어 메모리에 둔다. 카탈로그의 `api_base`가 github.com API가 아닌 저장소(GHES)는 **기본 작업**(`clone`·`push`·`pull_request`)과 `outcome_refresh`만 받는다. 그 밖의 purpose(`actions_read`·`dispatch`·`rerun`·`review`)는 게이트 4단계에서 `409` `reason_code: github_host_unsupported`로 거절한다. 탭은 그 저장소만 고른 에이전트에서 선택 권한을 같은 이유로 비활성으로 보인다. GA-2 테스트: GHES 카탈로그 저장소 세션의 clone·push·PR은 지금처럼 되고 dispatch는 `github_host_unsupported`다.
- **PAT 저장소**(`kind: basic`, github.com)는 권한을 좁힐 수 없다. `github` 설정이 없는 릴리스(와 릴리스 없는 세션)만 기본 작업(clone·push·PR)을 지금처럼 한다. 선택 권한 작업은 모두 `app_required`로 거절한다. `outcome_refresh`는 릴리스와 상관없이 PAT로 읽는다. 이때 자격 증명은 좁혀지지 않고, 플랫폼이 부르는 호출만 읽기(`GET …/pulls/{n}`)다. `github` 설정이 있는 릴리스는 PAT 저장소를 고를 수 없다([결정 3](#결정-3-workflows-권한)).

### GA-2에서 정한 것

구현하면서 위 설명과 달라지거나 위에서 정하지 않은 것을 여기 둔다. 위 문단과 이 목록이 다르면 이 목록이 맞다.

- **놓인 곳.** 게이트의 판정(`createGitHubGate`)은 `packages/platform/src/sessions/github-gate.ts`에 있고, 포트는 `packages/platform/src/ports/github-gate.ts`다. control-host는 연결만 준다. `forge-github.ts`의 `createGitHubConnection`이 연결 하나(발급기, 토큰 캐시, 그 자격 증명에 묶인 REST 호출)이고, `connectionsOf`가 저장소마다 연결을 고른다. `ForgeAdapter`·`ForgeResolver`는 없앴다. 그래서 control-host에도 게이트를 거치지 않고 토큰을 얻는 경로가 없다.
- **GitHub가 아닌 저장소.** 연결이 없고 `github_app` 인증도 아닌 저장소(GitHub가 아닌 호스트, PAT의 GHES, bearer, 공개)는 1단계 다음에 바로 `null`을 돌려주고 호출자가 카탈로그의 자격 증명을 그대로 쓴다. 스위치·범위를 보지 않는다. GitHub 설정은 GitHub 저장소에만 뜻이 있고, 릴리스 검증이 GitHub App 저장소가 아닌 곳의 `github`를 `app_required`로 막기 때문이다.
- **receipt actor.** receipt의 principal 종류는 `api_key`·`user`·`installation`뿐이다(`receiptActorSchema`). 표의 `{ kind: "service" }` 대신, 사람이 없는 작업(push 실행기의 발급, 정책의 자동 승인)은 actor를 null로 둔다. 자동 승인은 `decided_by: { kind: "policy", agent_release_id }`와 receipt result의 `approved_by`로 알 수 있다. clone은 세션 시작자, 시작자가 없으면 null이다.
- **ref를 적지 않은 허용 목록 항목.** "기본 브랜치"는 GitHub에 묻지 않고 카탈로그 항목의 `branch`로 정한다. 게이트가 GitHub를 부르기 전에 판정해야 해서다.
- **상한 밖의 `workflows`.** 릴리스가 `workflows`를 켰어도 상한이 막으면 push 토큰에서 `workflows: write`만 빠지고 push 자체는 거절하지 않는다. 그 push가 워크플로 파일을 바꾸면 GitHub가 거절하고 `workflows_permission_missing`이 된다.
- **HTTP 상태.** `GITHUB_REFUSED`는 정책 거절(`github_disabled`, `repository_not_allowed`, `feature_off`, `workflow_not_allowed`, `agent_ref_refused`, `run_ref_unprovable`)이면 `403`, 나머지는 `409`다(`githubRefusalStatus`). 세션 생성의 저장소 범위 거절도 `403` `repository_not_allowed`이고 receipt는 없다(`receipt_id: null`).
- **저장소 binding.** 게이트는 모든 purpose에서 세션이 만들 때 고정한 저장소 URL·브랜치와 지금 카탈로그 항목을 비교한다. 다르면 거절 receipt 없이 `503`(저장소가 옮겨졌다)이다. gateway·push 실행기·PR 서비스의 binding 검사는 그대로 두고, Actions 작업도 같은 보호를 받게 한 것이다.
- **물려받은 `github`.** `github` 없이 만든 릴리스가 활성 릴리스의 설정을 물려받을 때도 보낸 설정과 같은 검증(저장소 범위·PAT·`actions_off`·상한)을 한다. 카드 편집이 릴리스를 다른 저장소로 옮기면 `release_repository_outside`로 막힌다.
- **승인 scope가 있는 호출자의 PR 열기.** `sessions:approve` scope가 있어도 share가 `session.approve`를 주지 않으면 `session.submit`으로 다시 보고, 되면 submit 호출자로 연다(`pushed` 요청만).
- **clone 거절이 보이는 곳.** proxy와 worker의 동작은 바꾸지 않는다(clone 재허가가 `GITHUB_REFUSED`로 실패한다). 이유는 게이트의 거절 receipt(`mint_github_token`, `target_ref.session_id`)로 세션 상세의 receipt 목록에서 보인다.
- **GA-2가 하지 않은 것.** `GET …/github-settings`의 OAuth 칸(GA-4), 저장소별 설치 권한을 응답에 싣는 것과 `…/github-apps/{role}` 경로(GA-5), 활성화·릴리스 생성 receipt의 `github` result(GA-3)다. App 권한은 지금 `…/github-app`(작성용)의 등록과 `GET` 때 읽어 행에 두고, 응답의 `github_app`에 `permissions`·`permissions_checked_at`·`warnings`를 싣는다.

### 작업별 권한

| purpose | 권한 | 연결 | 누가 부르나 |
|---|---|---|---|
| `clone` | `contents: read` | author | gateway 재허가(`worker-gateway.ts:1241-1255`) |
| `push` | `contents: write`, `workflows`가 켜졌으면 + `workflows: write` | author | push 실행기(`push-executor.ts:108`) |
| `pull_request` | `contents: read`, `pull_requests: write` | author | PR 열기·코멘트(`pull-request-service.ts`) |
| `actions_read` | `actions: read` | author | run 조회(rerun 판정은 GitHub가 아니라 `github_workflow_dispatches`로 한다) |
| `dispatch`, `rerun` | `actions: write` | author | 새 GitHub 작업 서비스 |
| `review` | `contents: read`, `pull_requests: write` | reviewer | 새 GitHub 작업 서비스 |
| `outcome_refresh` | `pull_requests: read` | author | 성과물 상태 조회(GA-4b, [10절](#pr-상태-갱신-조회로-한다)). 에이전트 스위치·범위·기능·상한을 보지 않는다 |

`checks: write`와 `issues: write`는 이번에 상한·릴리스 칸과 게이트의 판정만 만든다. 그 권한을 쓰는 작업(check run 쓰기, issue 쓰기)은 이 문서 범위에서 만들지 않는다. 칸이 먼저 있어야 오너가 App에 미리 권한을 주고 에이전트별로 켜 둘 수 있다. 작업은 필요할 때 이 표에 줄을 더해 만든다.

### GitHub 작업 서비스와 두 입구

- `packages/platform/src/sessions/github-work-service.ts`(새)가 dispatch·rerun·review를 한다. 기존 push 요청·PR 서비스와 같은 층이고 같은 게이트를 쓴다. 세션 share로 `session.submit`을 검사한다(`push-request-service.ts`의 `requireSession`과 같다).
- **입구 1: 세션 API**([6절](#6-api)). 에이전트 key, 개인 key, 웹이 부른다.
- **입구 2: 내장 MCP 서버 `github`**(GA-7). 세션의 에이전트가 자기 세션에 대해서만 부른다. worker는 여전히 토큰을 받지 않는다. MCP 호출은 egress proxy를 지나 control-host의 작업 서비스에 닿는다. proxy는 지금 `/mcp/<server>` 경로마다 control-host에 허가를 묻는다(`credential.ts:144-148`, `689`). 그 허가가 attempt 토큰으로 세션을 정하므로 다른 세션의 이름으로 부를 수 없다. 도구는 `request_push`, `open_pull_request`, `comment_pull_request`, `dispatch_workflow`, `rerun_workflow`, `submit_review`, `get_workflow_run`이다. 각 도구는 입구 1과 같은 서비스 함수를 부른다. push 승인을 켠 릴리스에서 `request_push`는 요청만 만들고 사람을 기다린다. 이 서버는 `github_enabled`이고 릴리스에 `github` 설정이 있는 세션에만 붙는다. 도구 목록은 릴리스가 켠 기능만 노출한다. upstream 주소, 허가 응답 모양, 도구 정책 핀(`policy_pins.tools`)과의 관계는 GA-7의 첫 커밋 전에 이 문서에 절을 더해 정한다([아래](#내장-mcp-서버-github)).

### 내장 MCP 서버 `github`

GA-7이 정한다. 지금 있는 원격 MCP 경로(카탈로그 `mcp_servers`, `packages/platform/src/workers/mcp-egress.ts`)를 그대로 타고, 다른 점만 적는다.

- **붙는 조건.** claim이 세션 릴리스의 `policy_pins.github`를 읽어, 있으면 runtime config의 `mcp_servers`에 `github` 항목을 더한다. 원격 MCP 서버와 함께 붙을 수 있으므로 `mcp_servers`는 최대 둘이다. 붙을지는 릴리스만 보고 정한다. `github_enabled`는 claim에서 보지 않는다. 이 항목의 `binding`은 checkpoint fingerprint에 들어가므로, 세션 도중 바뀌는 스위치로 붙였다 뗐다 하면 같은 세션의 앞 checkpoint를 복원할 수 없게 되기 때문이다. 대신 스위치가 꺼지면 아래 허가가 모든 교환을 거절한다. 엔진은 서버에 닿지 못하고 도구를 하나도 받지 못한다. 그래서 실제 동작은 "켜진 에이전트의 세션에만 붙는다"와 같다. `binding`은 `sha256({ release_id, server_id: "github", builtin: true })`다.
- **이름.** `github`는 내장 서버의 이름이다. 카탈로그 `mcp_servers`의 id로 `github`를 쓰면 카탈로그를 읽을 때 거절한다. 카드가 `github`를 원격 서버로 적어도 카탈로그에 없으므로 원격 서버로는 붙지 않는다.
- **토큰.** 새 egress 토큰을 만들지 않는다. attempt의 `mcp` 토큰 하나가 두 서버를 같이 쓴다. 그 토큰의 binding은 원격 서버가 있으면 원격 서버의 것이고, 없으면 `github`의 것이다. 원격 서버의 허가는 지금처럼 자기 binding과 맞춰 보고, `github`의 허가는 binding을 보지 않는다. `github` 쪽에는 카탈로그에서 옮겨질 URL이나 자격 증명 이름이 없기 때문이다.
- **허가.** proxy가 `/mcp/github` 교환마다 묻는 질문(`purpose: mcp`, `server: github`, `rpc`)에 gateway가 답한다. 순서는 이렇다. (1) attempt 토큰으로 세션과 attempt를 정한다. 지금의 `authorizeEgressAtomic` fence다. 세션 id는 토큰에서만 나오고, 도구 인자로 받지 않는다. (2) 세션 릴리스에 `policy_pins.github`가 없으면 거절한다. (3) `agents.github_enabled`가 false면 거절한다. 세션을 만든 credential이 기록되지 않은 세션도 거절한다(아래 actor). (4) JSON-RPC method는 원격 서버와 같은 목록(`initialize`, `ping`, `tools/list`, `tools/call`, `notifications/*`)만 받는다. (5) `tools/call`이면 그 도구가 릴리스가 노출하는 도구여야 한다(아래 표). 거절은 `403` `FORBIDDEN`이고 receipt를 남기지 않는다. 도구 호출이 게이트까지 가서 거절되면 그 거절 receipt는 입구 1과 같이 남는다.
- **허가 응답.** `{ session_id, attempt_id, upstream: { url: "/mcp/github", headers: [["authorization", "Bearer <서명된 grant>"]] } }`. `url`이 `/`로 시작하는 경로이면 proxy는 그것을 자기가 아는 authorizer 주소(`EGRESS_AUTHORIZER_URL`)에 붙여 보낸다. 그래서 upstream은 authorizer listener다. 그 listener는 worker allowlist에 없다(`docs/operator/api-server.md`). control-host가 자기 주소를 따로 설정받지 않아도 된다. 다른 경로(provider, 저장소, 원격 MCP)의 허가 응답은 지금처럼 절대 URL이다. allowlist를 건너뛰는 것은 경로로 받은 upstream뿐이다. 카탈로그 URL이 authorizer와 같은 origin이어도 allowlist 검사를 받는다.
- **서명된 grant.** `v1.<payload>.<mac>`. payload는 `{ session_id, attempt_id, exp }`의 base64url이고, `exp`는 발급 뒤 60초다. mac은 `EGRESS_AUTHORIZER_TOKEN`에서 용도 문자열로 파생한 키의 HMAC-SHA256이다. authorizer listener의 `/mcp/github`는 이 서명과 만료만 보고 세션을 정한다. worker는 이 헤더를 보지 못한다. proxy가 worker의 `authorization` 헤더를 grant의 값으로 덮어쓰고, 응답이 그 값을 되비추면 걸러 낸다. 이 키를 아는 것은 control-host와 proxy뿐이다. proxy는 이미 모든 upstream 자격 증명을 받는 쪽이므로 새로 믿는 쪽이 생기지 않는다. 교환마다 proxy가 새로 허가를 묻고 grant를 새로 받으므로 60초면 충분하다.
- **서버.** control-host가 authorizer listener에서 Streamable HTTP의 상태 없는 JSON 응답으로 답한다. 메시지 하나를 받아 하나를 답한다(알림은 `202`). `GET`과 `DELETE`는 `405`다. `tools/list`는 릴리스가 노출하는 도구만 준다. 세션은 서명된 grant로만 정하고 요청 본문의 어떤 값도 세션을 고르지 않는다.
- **도구와 노출.** 노출은 릴리스의 `policy_pins.github.features`로만 정한다. 워크스페이스 상한과 App 권한은 목록에서 빼지 않는다. 그것은 호출 때 게이트가 정하고(`over_workspace_ceiling`, `app_permission_missing`), 그 거절도 receipt로 보인다.

| 도구 | 노출 조건 | 부르는 함수(입구 1과 같다) | 인자 |
|---|---|---|---|
| `request_push` | 늘 | `PushRequestService.create` | 없음 |
| `open_pull_request` | 늘 | `PullRequestService.open` | `push_request_id`, `title?`, `body?` |
| `update_pull_request` | 늘 | `PullRequestService.update`(입구 1 없음, 아래 "PR 제목·본문 수정") | `push_request_id`, `title?`, `body?`(하나 이상) |
| `comment_pull_request` | 늘 | `PullRequestService.comment` | `push_request_id`, `body`, `marker?` |
| `close_pull_request`, `reopen_pull_request` | 늘 | `PullRequestService.setState`(입구 1 없음, [action-broker.md](action-broker.md) T9) | `push_request_id` |
| `dispatch_workflow` | `features.actions` | `GitHubWorkService.dispatch` | `workflow`, `ref`, `inputs?` |
| `get_workflow_run` | `features.actions` | `GitHubWorkService.getRun` | `run_id` |
| `rerun_workflow` | `features.actions` | `GitHubWorkService.rerun` | `run_id`, `failed_only?` |
| `submit_review` | `features.review` | `GitHubWorkService.review` | `number`, `event`, `commit_id`, `body?` |
| `list_repositories` | 늘 | `RepositoryAttachmentService.list`(입구 1 없음, [session-repository-attachment.md](session-repository-attachment.md) 결정 3) | 없음 |
| `attach_repository` | 늘 | `RepositoryAttachmentService.attach`(입구 1 없음, [session-repository-attachment.md](session-repository-attachment.md) 결정 3) | `repository_id` |

- **PR 제목·본문 수정(2026-11-03).** 오너가 "pr 작성이나 commit, push 이런거 뻔한거"를 매번 승인 없이 하길 원했고, 연 PR을 고칠 도구가 없었다. `update_pull_request`는 코멘트와 같은 규칙으로 PR을 찾고(그 push 요청이 연 PR, 없으면 같은 저장소·브랜치에서 세션이 연 PR) 같은 권한(`pushed` 요청에서 `session.submit`)으로 고친다. 본문은 사람 글만 바꾸고 플랫폼 꼬리는 그 push 요청의 commit으로 다시 붙인다. 제목·본문은 PR 열기와 같이 정리한다. 매번 `update_pull_request` receipt(`created: false`)를 남긴다. 세션 API 경로는 두지 않았다(사람은 GitHub에서 고친다).

- **`policy_pins.tools`와의 관계.** 원격 MCP 서버의 도구는 `policy_pins.tools.per_tool`의 `mcp__<server>__<tool>: allow`로 핀한다. `github`의 도구는 그 표에 두지 않는다. `policy_pins.github`가 같은 릴리스 해시에 이미 들어 있고, 위 표가 그것에서 도구를 정하기 때문이다. 두 곳에 같은 정보를 두면 서로 어긋날 수 있다. claim은 노출하는 도구의 `mcp__github__<tool>` 이름을 runtime config의 `tools`에 더한다. worker의 relay는 원격 서버와 같이 그 이름만 엔진에 보인다. 서버의 `tools/list`, 허가의 `tools/call` 검사, relay의 목록, 세 곳이 같은 함수(contracts의 `githubMcpTools`)로 정한다.
- **MCP 호출의 actor(2절 "선행 수정"의 GA-7 몫).** 부르는 쪽은 세션 안의 에이전트이고 key가 없다. receipt actor는 지금의 원격 MCP 거절 receipt(`call_mcp`)와 같이 정한다. principal은 세션을 만든 credential(`created_by_api_key_id`가 있으면 그 `api_key`, 없으면 `created_by_user_id`의 `user`)이고, `actor_user_id`는 세션을 만든 사람, `agent_id`는 세션 릴리스의 에이전트다. 둘 다 없는 세션에는 도구를 열지 않는다(허가의 (3) 다음에 거절한다). push 요청의 `requested_by`는 null일 수 없고, 누가 시작했는지 모르는 세션에 GitHub 쓰기를 열지 않으려는 것이다. 2절의 "`actor.agent_id`는 호출자 key에서만 채운다"와 어긋나지 않는다. 이 호출의 호출자는 바로 그 세션의 에이전트이기 때문이다. receipt를 다른 입구와 나눠 보려면 actor의 principal이 아니라 이 `agent_id`가 세션 릴리스와 같다는 점을 본다.
- **권한 판정.** 서비스 함수는 입구 1과 같은 것을 부른다. 다만 권한 판정(`AuthorizationPolicy`)은 그 attempt의 세션 하나에 묶인 판정으로 바꿔 끼운다. 그 세션의 `session.read`·`session.submit`만 허용하고 나머지는 모두 거절한다. principal의 scope는 비워 둔다. 그래서 MCP 호출은 push를 결정할 수 없고(`decide_push` 도구가 없고, 있어도 `missing_scope`), PR 열기·코멘트는 `pushed` 요청에서만 된다(결정 6). 세션을 만든 사람의 지금 권한은 다시 보지 않는다. 이 호출의 권한은 세션 안에서 도는 attempt라는 사실에서 나오고, 그 사실은 (1)의 fence가 교환마다 다시 확인한다.
- **`request_push`는 기다리지 않는다.** push 승인을 켠 릴리스에서 도구는 `requested` 요청을 만들고 바로 돌아온다. 사람이 승인하고 push 실행기가 push한 뒤, 에이전트가 `open_pull_request`를 부른다. 그 전에 부르면 지금의 PR 서비스 거절(`not_pushed`)이 돌아온다. 도구가 사람의 결정을 붙잡고 기다리면 턴 하나가 사람을 기다리며 비용 없이 멈춰 있게 되고, 그 사이 lease와 호출 시간 제한(30분)에 걸린다. push 승인을 끈 릴리스는 같은 트랜잭션에서 `approved`가 되고 push 실행기가 곧 push한다.
- **push하는 것은 마지막 checkpoint다.** `request_push`는 입구 1과 같이 세션의 마지막으로 커밋된 checkpoint를 push한다. 턴 안에서 방금 만든 commit은 그 턴이 끝나 checkpoint가 생겨야 들어간다. 도구 설명에 이것을 적는다. 도구를 부른 턴이 끝나면 checkpoint가 늘 새로 생기므로, 승인은 checkpoint revision이 아니라 commit으로 판정한다([GA-7에서 정한 것](#ga-7에서-정한-것)).
- **worker 환경.** worker는 여전히 GitHub 토큰을 받지 않는다. runtime config에는 egress 토큰과 proxy 경로만 있고, 서명된 grant는 proxy와 control-host 사이에만 있다. GA-7 테스트는 claim 응답과 worker가 엔진에 넘기는 환경·설정 파일에 GitHub 토큰 모양(`ghs_`, `ghp_`, `github_pat_`, `x-access-token`)이 없음을 본다.
- **도구 결과.** 성공하면 입구 1의 응답 본문을 JSON 텍스트로 준다. 서비스 거절은 `isError: true`와 입구 1과 같은 `code`·`message`·`details`(`reason_code`, `refusal`, `receipt_id`)를 준다. 인자가 스키마에 맞지 않으면 서비스를 부르지 않고 `isError: true`로 답한다.
- **섞인 배포.** `mcp_servers` 최대 둘을 모르는 앞 worker 이미지는 원격 서버와 `github`가 같이 붙은 claim을 거절한다. 앞 proxy 이미지는 경로 모양의 upstream을 거절한다(`parseGrant`). 둘 다 그 세션의 GitHub 도구가 동작하지 않는 쪽으로만 틀린다. proxy와 worker 이미지를 API보다 먼저 올린다. GitHub 설정이 있는 릴리스로 이 배포 전에 checkpoint를 남긴 세션은 `github` 서버 없이 만든 runtime config를 claim의 `restore_runtime_configs`로 함께 받으므로, 그 checkpoint에서 그대로 이어진다.

### GA-7에서 정한 것

- **checkpoint가 움직인 뒤의 승인.** werft-sandbox 실측에서, 에이전트가 턴 안에서 `request_push`를 부르면 그 턴이 끝날 때 checkpoint revision이 올라가 사람의 승인이 늘 `409 CHECKPOINT_MOVED`였다. push 승인을 켠 릴리스에서는 도구로 만든 요청을 하나도 승인할 수 없었다. 결정 6이 지키는 것은 "사람이 본 commit이 push된다"이므로, 판정을 commit으로 옮긴다.
  - 서비스가 결정 전에 세션의 마지막 checkpoint(revision과 commit)를 읽는다.
  - 결정 트랜잭션은 세션의 지금 revision이 요청이 고정한 revision과 같으면 지금처럼 승인한다. 다르면 지금 revision이 서비스가 읽은 revision과 같고, 그 commit이 요청의 `git_commit`과 같을 때만 승인한다. 결정 본문의 `git_commit`은 이미 요청의 것과 같아야 한다(`commit_mismatch`).
  - 그 사이에 checkpoint가 또 움직였거나 commit이 다르면 `checkpoint_moved`다.
  - push 실행기는 지금처럼 요청이 고정한 revision의 commit을 push한다.
  - 입구 1(HTTP 결정)도 같은 규칙이다. commit 없는 턴이 지난 뒤의 승인이 이제 된다.

### GA-8에서 정한 것

오너 결정(2026-11-01): "에이전트 key 도 개인 key 와 같은 것을 할수 있어 하지만 key 를 발급할 때 각 key 별로 필요한 권한을 적절히 설정할 수 있는거지", "이 에이전트 key 라는게 사실상 팀에서 사용하는 key 가 되는거지". D26 5의 "에이전트 key는 승인하지 않는다"를 아래로 바꾼다.

- **발급.** 에이전트 key도 개인 key와 같은 칸으로 `sessions:approve`를 포함한 모든 scope를 고른다. 상한은 지금처럼 발급하는 사람이 그때 가진 scope다. 이미 있는 key의 scope는 바꾸지 않는다. 승인이 필요하면 새로 발급한다.
- **에이전트 key가 승인하는 범위.** 그 에이전트의 세션뿐이다(지금의 `agent_ceiling`). 그 안에서는 세션 시작자나 에이전트 관리자처럼 확인 요청에 답하고 push를 결정한다.
- **자기 승인 금지.** 승인하는 key가 그 세션을 시작한 key(`sessions.created_by_api_key_id`)이면 거절한다. 에이전트 key와 개인 key 모두 같다. 공유되는 것은 사람이 아니라 key이기 때문이다. 같은 사람이 웹(cookie)으로, 또는 다른 key로 승인하는 것은 막지 않는다. 세션을 시작한 key가 없는 세션(웹, Slack)에는 이 규칙이 걸리지 않는다. workspace에 속하지 않은 key(key CLI의 operator key, workspace 이전 key, AUTH_MODE=none)도 예외다. 곁에서 대신 승인할 구성원이나 다른 key가 없기 때문이다. quickstart와 E2E는 operator key 하나로 세션을 만들고 그 key로 답한다.
- **판정하는 곳.** 권한 판정의 `session.approve` 한 곳이다(`reason_code: self_approval`). 모든 승인 입구가 이 판정을 지난다. HTTP의 push 결정과 확인 요청 답변이 그렇고, 내장 MCP의 `request_push`로 만든 요청도 같은 HTTP 결정으로 승인한다. MCP 호출 자체는 `session.approve`를 갖지 않는다([내장 MCP 서버](#내장-mcp-서버-github)의 권한 판정). Slack에는 지금 승인 입구가 없고, 생기면 같은 판정을 지난다. 확인 요청 목록의 `answerable`도 같은 판정이라 시작한 key에게는 false다.
- **거절.** push 결정은 `403 FORBIDDEN`, `details.refusal: self_approval`과 `decide_push` 실패 receipt다. 확인 요청 답변은 `403 FORBIDDEN`, `details.reason_code: self_approval`과 `answer` 실패 receipt다. 둘 다 `details.receipt_id`로 receipt를 돌려준다.
- **감사.** receipt actor는 지금처럼 key(`principal`)와 그 에이전트(`agent_id`)다. `decide_push` receipt(승인·거절 모두)와 `answer` 거절 receipt의 result에 `decider_key: { id, kind, issued_by_user_id }`를 더한다. 에이전트 key는 actor에 사람이 없으므로, 누가 발급한 key인지는 이 칸으로 본다. 사람이 결정하면 null이다.

## 4. 데이터 모델

### `github_apps` (0192, 열 추가)

| 열 | 타입 | 규칙 |
|---|---|---|
| `role` (새) | text NOT NULL DEFAULT `'author'` | `CHECK (role IN ('author', 'reviewer'))`. 기존 행은 `author` |
| `permissions` (새) | jsonb | 마지막으로 읽은 `GET /app`의 `permissions`. 읽기 전(기존 행)은 NULL이고 다음 `GET …/github-apps/author`나 첫 발급 때 채운다 |
| `permissions_checked_at` (새) | timestamptz | `permissions`와 짝 CHECK |
| `client_id` (GA-4, 새) | text | `GET /app`의 `client_id`. 사용자 연결(OAuth)의 client. 읽기 전(기존 행)은 NULL이고 다음 등록이나 `GET …/github-app` 때 채운다 |

- 제약: `github_apps_workspace_uniq`(`0192:12`)를 지우고 `UNIQUE (workspace_id, app_id)`를 건다. 한 역할에 행이 여럿일 수 있고, 같은 App은 역할이 달라도 한 행이다([결정 11](#결정-11-같은-역할에-app-여럿)).
  - 이전 결정: `UNIQUE (workspace_id, role)`(GA-1, `0194_github_agent_settings.sql`)로 역할마다 행 하나였다. 바뀐 이유: 오너 결정(2026-11-02) 1. 이 제약을 바꾸는 마이그레이션은 기존 행에 같은 `app_id`가 둘 있으면 실패한다. `same_app` 규칙이 그런 행을 만들지 않았으므로 정상 설치에서는 걸리지 않는다.
- 키 슬롯은 행 id로 정해지므로(`github-apps.ts:25-29`) 바꾸지 않는다.
- `credentials()`(`github-apps.ts:168-195`)는 연결 id를 받고 그 행만 돌려준다. 역할로 첫 행을 고르는 경로는 두지 않는다. 게이트가 [저장소 고정](#저장소에-고정된-연결)으로 연결 id를 정한다. (이전 결정: role을 받아 그 role의 행을 돌려주고, 콘솔 App forge는 역할마다 하나였다.)

### `github_workspace_settings` (새)

| 열 | 타입 | 규칙 |
|---|---|---|
| `workspace_id` | uuid PK FK workspaces | |
| `ceiling` | jsonb NOT NULL | `{ workflows, actions, checks, issues, review }` boolean. 스키마는 contracts의 `githubCeilingSchema` 하나 |
| `user_link_connection_id` (2026-11-02, 새) | uuid NULL FK `github_apps` ON DELETE RESTRICT | 구성원 계정 연결(OAuth)에 쓰는 작성용 연결([결정 11](#결정-11-같은-역할에-app-여럿)의 3). 첫 작성용 연결을 등록할 때 채우고, 이전 마이그레이션은 기존 작성용 행으로 채운다. 비어 있고 작성용 연결이 하나면 그 연결로 읽고, 다음 작성용 `POST`가 채운다. 다른 작성용 연결이 있는 동안 이 연결은 해제할 수 없다(`in_use_for_user_link`). 마지막 작성용 연결을 해제할 때는 새 이미지가 같은 트랜잭션에서 이 칸을 먼저 비운다. RESTRICT라 섞인 배포 동안 앞 이미지가 이 행을 지우려 하면 외래 키에 걸려 `500`으로 실패하고, 다른 요청은 계속 처리한다([5절](#5-기존-설치-이전)). 이전 결정: 칸이 없고 작성용 행 하나가 늘 OAuth의 App이었다 |
| `oauth_client_secret_set` | boolean NOT NULL DEFAULT false | 사용자 연결용 client secret이 `secret_values`(owner `{ kind: "github_app", id: <user_link_connection_id> }`, purpose `github_oauth_client_secret`)에 있는지. `user_link_connection_id`를 바꾸면 같은 트랜잭션에서 secret을 지우고 false로 둔다. 값은 다시 읽어 보여 주지 않는다. client secret은 App에 묶인 값이므로, `user_link_connection_id`의 연결을 지우거나 그 연결을 `app_id`가 다른 App으로 바꾸면(옛 역할 주소의 `PUT`) 같은 트랜잭션에서 secret을 지우고 이 칸을 false로 둔다. 다른 작성용 연결을 지우거나 바꿔도 secret은 그대로다(이전 결정: 작성용 App 하나를 지우거나 바꾸면 늘 지웠다. 바뀐 이유: 오너 결정 2026-11-02 1·3). 같은 App의 개인 키만 바꿀 때는 그대로 둔다(지금 교체는 같은 행을 고친다, `packages/db/src/github-apps.ts:111-120`. 삭제는 키 슬롯만 지운다, `153-158`). GA-4 테스트가 세 경우를 나눠 본다 |
| `revision` | integer NOT NULL DEFAULT 1 | 쓸 때마다 +1. PUT은 `revision`을 받아 다르면 `409 REVISION_CONFLICT`. revision은 상한의 CAS다. client secret 쓰기는 바꾸지 않는다 |
| `updated_by`, `updated_at` | uuid, timestamptz | |

행이 없으면 상한은 모두 false이고 client secret은 없다.

### `catalog_repository_github_apps` (새)

저장소에 고정된 연결([결정 11](#저장소에-고정된-연결)). 2026-11-02 개정에서 더했다. 이전에는 역할마다 연결이 하나라 고정이 필요 없었다.

| 열 | 타입 | 규칙 |
|---|---|---|
| `repository_id` | text NOT NULL | 카탈로그 저장소 id. `PRIMARY KEY (repository_id, role)` |
| `role` | text NOT NULL | `CHECK (role IN ('author', 'reviewer'))` |
| `connection_id` | uuid NULL FK `github_apps` ON DELETE SET NULL | 고정된 연결. null이면 고정했던 연결이 해제된 것이고 게이트는 `pinned_app_removed`로 거절한다. 행을 지우면(CASCADE) 다음 발급이 다른 연결로 새로 고정할 수 있으므로 지우지 않고 비운다 |
| `app_id` | bigint NOT NULL | 고정할 때 그 연결의 GitHub App id. 연결이 해제돼 `connection_id`가 비어도 남는다. 같은 역할에 같은 `app_id`의 연결을 다시 더하면(`POST`, 옛 역할 주소의 `PUT`) 같은 트랜잭션에서 이 `app_id`의 빈 고정을 새 연결로 되살리고 `set_github_app` receipt에 `pins_restored`(수)를 남긴다. 이전에는 같은 App을 다시 등록하면 저장소가 그대로 다시 돌았으므로, 그 동작을 잃지 않으려는 것이다 |
| `pinned_by` | text NOT NULL | `selection`(에이전트의 저장소 고르기)·`first_mint`(첫 발급)·`admin`(관리자 변경)·`claim`(세션 claim이 주 저장소에 남김. 마이그레이션으로 CHECK에 더했다) |
| `updated_by`, `updated_at` | uuid NULL, timestamptz NOT NULL | `first_mint`와 `claim`이면 `updated_by`는 null |

- 고르기, 첫 발급, claim은 `INSERT … ON CONFLICT DO NOTHING`이다. 행을 고치는 것은 관리자 변경, 해제(`connection_id`를 비움), 같은 App을 다시 더할 때의 되살리기다. 행을 지우는 것은 옛 역할 주소의 다른 App 교체 하나다([결정 11](#결정-11-같은-역할에-app-여럿)의 1).
- 고정이 null인 행도 관리자가 다른 연결로 바꿀 수 있다. 그것이 해제 뒤 저장소를 다시 쓰는 길이다.

### `github_workflow_dispatches` (새)

| 열 | 타입 | 규칙 |
|---|---|---|
| `run_id` | bigint | GitHub run id. `UNIQUE (repository_id, run_id)` |
| `repository_id` | text NOT NULL | 카탈로그 저장소 id |
| `session_id` | uuid NOT NULL FK sessions | dispatch한 세션 |
| `agent_release_id` | text | 그때의 릴리스 |
| `workflow` | text NOT NULL | 파일 이름 |
| `ref` | text NOT NULL | 브랜치 이름(`refs/heads/` 없이) |
| `receipt_id` | uuid NOT NULL FK receipts | `dispatch_workflow` receipt |
| `created_at` | timestamptz NOT NULL | |

GitHub가 run id를 돌려주지 않은 dispatch는 행을 남기지 않는다. 그 run은 rerun할 수 없다. rerun은 이 행을 찾고, 세션 저장소와 `repository_id`가 같아야 한다.

### `agents.github_enabled` (새 열)

boolean NOT NULL DEFAULT true. 기존 에이전트는 true다. 지금 GitHub 저장소를 쓰는 에이전트가 멈추지 않게 하려는 것이다. 새 에이전트도 true다. 끄는 것은 GitHub 탭의 스위치다.

### 릴리스 `policy_pins.github`

```ts
// packages/contracts/src/kollegium/agents.ts (sketch)
export const agentGitHubSchema = z.object({
  repositories: z.array(z.string().min(1).max(128)).min(1).max(32),
  push_approval: z.boolean(),
  features: z.object({
    workflows: z.boolean(),
    actions: z.boolean(),
    checks: z.boolean(),
    issues: z.boolean(),
    review: z.boolean(),
  }).strict(),
  actions_allow: z.array(z.object({
    workflow: z.string().regex(/^[A-Za-z0-9._-]+\.ya?ml$/),
    ref: z.string().min(1).max(255).optional(),
  }).strict()).max(32),
}).strict();
// createAgentReleaseRequestSchema: github?: AgentGitHub (absent: inherit the active release's)
// policyPinsSchema: github?: AgentGitHub (absent on every release made before it)
```

- 릴리스를 만들 때 저장소 id가 카탈로그·프로필에 있는지, PAT 저장소가 아닌지, `actions_allow`가 `actions` 없이 쓰이지 않았는지, 워크스페이스 상한 안인지 검사하고 같은 값을 `policy_pins.github`에 넣는다. 상한 검사는 저장 시점의 안내이고, 실행 때 다시 자른다([결정 7](#결정-7-릴리스와의-관계)). 카드 스키마는 바꾸지 않는다.
- **저장소 없는 릴리스.** 프로필의 `repository_mode`가 `none`이면 릴리스에 `repository_id`가 없다(`packages/contracts/src/kollegium/agents.ts:483-484`). 이런 릴리스에는 `policy_pins.github`를 두지 않는다. 요청에 `github`를 넣으면 `400` `reason_code: repository_none`이고, 활성 릴리스의 `github`도 물려받지 않는다. 그래서 GitHub 설정이 있는 에이전트도 저장소 없는 프로필로 옮길 수 있다. 그 릴리스의 세션은 저장소가 없으니 GitHub 작업이 생기지 않는다. 다시 저장소 있는 프로필로 옮기면 활성 릴리스에 `github`가 없으므로 [기본값](#에이전트-github-설정의-기본값)으로 읽고, 탭에서 다시 저장해야 한다. GA-2 테스트: GitHub 설정이 있는 에이전트를 `repository_mode: none` 프로필로 옮기는 요청이 `github` 없이 성공하고 `github`를 넣으면 `repository_none`이다.
- **기본 저장소 없는 `optional` 릴리스.** `optional` 프로필 릴리스는 `repository_id` 없이도 `policy_pins.github`를 둔다. 카드 편집으로 만든 릴리스도 활성 릴리스의 `github`를 물려받는다. `github.repositories`가 기본 저장소를 포함해야 한다는 검사(`release_repository_outside`)는 기본 저장소가 있을 때만 한다. 이 릴리스의 세션은 저장소 없이 시작하고, 시작 때 `attached_repository_ids`로 고른 저장소를 붙인다. 생략하면 처음엔 붙인 저장소가 없고, 필요할 때 `attach_repository`로 붙인다. 이 의미가 생기기 전에 만든 세션(부착 목록이 NULL)은 `github.repositories` 전체를 쓴다. claim의 `additional_repositories`, egress `/repository/<id>`, push 요청, PR은 모두 "부착 목록 ∩ 지금의 `github.repositories`"로 게이트에서 다시 검사받고, 어기면 `repository_not_allowed`와 receipt다. push 요청은 `repository_id`를 꼭 보내야 하고, 생략하면 `no_repository`다. 기본 저장소가 없으니 모든 저장소가 "주 저장소가 아닌 저장소"이고, 게이트 원칙대로 `clone`·`push`·`pull_request`·`outcome_refresh`만 된다. workflow 실행·재실행·리뷰는 `repository_not_allowed`다. `none` 프로필 세션은 시작 때 부착 목록을 보내면 거절한다(세션 행이 두 경우를 구분하지 않아 세션 생성에서 막는다). 콘솔 GitHub 탭은 이 릴리스를 아직 `repository_none`으로 보이고 저장하지 않는다([session-repository-attachment.md](session-repository-attachment.md) 결정 4).
- 같은 내용의 릴리스를 다시 만들면 지금처럼 `created: false`로 그 릴리스를 돌려준다. 그래서 GitHub 설정을 바꿨다가 되돌리면 앞의 릴리스 id가 다시 나온다.

#### 에이전트 GitHub 설정의 기본값

| 칸 | 새 에이전트(GitHub 탭을 처음 저장할 때) | `github` 없는 릴리스(기존) |
|---|---|---|
| `repositories` | 릴리스 `repository_id` 하나(없으면 빈 목록이라 저장 전에 고르게 한다) | 프로필이 허용하는 모든 저장소 |
| `push_approval` | false (2026-11-02 전에는 true) | true |
| `features.*` | 모두 false | 모두 false |
| `actions_allow` | `[]` | `[]` |

### `linked_accounts` (CHECK 확장)

- 새 번호의 마이그레이션이 `linked_accounts_provider_check`(`schema.ts:766-769`)를 `IN ('slack', 'github')`로 바꾼다. `verified_via`에는 지금 DB CHECK가 없고 TypeScript 타입만 있다(`schema.ts:742`). 타입에 `github_oauth`를 더한다. contracts의 `LINKED_ACCOUNT_PROVIDER_VALUES`에도 더한다. 0141 파일은 고치지 않는다.
- `expires_at`은 열이 아니라 응답 필드다. 서비스가 null로 채운다(`packages/platform/src/musterrolle/linked-account-service.ts:31-32`). GitHub 행도 토큰을 두지 않으므로 같다.
- GitHub 행: `external_tenant = 'github.com'`, `external_user_id` = GitHub 숫자 id(문자열), `external_user_name` = login, `external_tenant_name = 'GitHub'`. 한 사람은 GitHub 계정 하나다(`linked_accounts_user_live_uniq`, `schema.ts:759-761`).
- `stale`은 쓰지 않는다. 토큰을 두지 않으므로 GitHub 계정이 사라진 것을 알 수 없다. 해제(`revoked`, `unlinked`)와 오프보딩만 있다.

### push 요청의 결정 주체

`push_requests.decided_by`(jsonb, `schema.ts:1766`)에 `{ kind: "policy", agent_release_id }` 모양을 더한다. contracts의 결정 주체 스키마와 웹·SDK 생성물을 같이 고친다.

## 5. 기존 설치 이전

마이그레이션은 확장 → 전환 → 정리로 한다. 규칙은 하나다. **N단계 이미지는 N+1단계가 남긴 DB를 읽고 멈추지 않는다.**

| 단계 | PR | DB | 앞 이미지가 멈추지 않는 이유 |
|---|---|---|---|
| 확장 | GA-1 | `github_apps.role`·`permissions`, `UNIQUE (workspace_id, role)`, `github_workspace_settings`, `agents.github_enabled DEFAULT true`, `linked_accounts` CHECK, receipt operation 값, `decided_by` 모양. store의 `find`·`put`·`delete`·`credentials`가 모두 role을 받고(지금은 모두 `workspace_id`만 본다, `github-apps.ts:85-89`, `111-114`, `153-158`, `168-195`), 기존 API와 콘솔 forge는 `author`에 묶는다. 그래서 이 이미지의 작성용 API는 뒤 단계가 만든 리뷰용 행을 읽거나 바꾸거나 지우지 않는다. **이 이미지는 `policy_pins.github`가 있는 릴리스의 세션에 GitHub 토큰을 주지 않는다**(clone·push·PR 모두 `409` `reason_code: github_settings_unsupported`). 좁히기를 모르는 이미지가 그 릴리스를 기본 설정으로 돌리는 일이 없게 하려는 것이다(fail closed). 릴리스 `policy_pins.github`를 **읽고**, 릴리스 요청에 `github`가 없을 때 활성 릴리스의 값을 물려받는 일까지 한다. 지금 `policyPinsSchema`는 `.strict()`라 이 칸이 든 릴리스를 거절한다(아래 실측). 그래서 쓰는 쪽(GA-2의 릴리스 요청 `github`)보다 읽고 물려받는 쪽이 먼저 모든 replica에 있어야 한다. 그래야 어느 replica가 카드 수정으로 릴리스를 만들어도 GitHub 설정이 사라지지 않고 같은 id가 나온다 | 0단계 이미지는 새 열과 테이블을 읽지 않는다. 이 단계에는 `reviewer` 행을 만드는 API가 없으므로, 0단계 이미지의 `credentials()` 첫 행은 여전히 작성용 App이다 |
| 전환 | GA-2~GA-7 | `github_workflow_dispatches`(GA-2, 새 테이블). 그 밖은 게이트, 릴리스 요청 `github`, 리뷰용 App 등록, OAuth, 상한 API | GA-1 이미지는 새 테이블을 읽지 않는다. GA-1 이미지는 `role`로 거르므로 리뷰용 행을 무시한다. `policy_pins.github`가 있는 릴리스는 GA-1 이미지에서 GitHub 토큰을 받지 못한다(fail closed). 섞인 기간에 그 세션이 GA-1 replica에 claim되면 clone이 거절될 수 있다. 그래서 GA-2를 모든 replica에 올린 뒤에 GitHub 탭(GA-3)을 연다. 탭 없이 릴리스 API로 `github`를 쓸 수는 있지만, 그 결과도 막히는 쪽으로만 틀린다 |
| 정리 | — | 없음 | 옛 경로 `/v1/workspaces/{id}/github-app`은 작성용 별칭으로 남긴다. 지울 이유가 생기면 그때 정한다 |

- **기존 연결 → 작성용 행.** `role` 열의 기본값이 `author`이므로 기존 행은 그대로 작성용이다. 데이터를 옮기지 않는다. `permissions`는 다음 조회나 첫 발급 때 채운다.
- **기존 에이전트 → push 승인 켜짐.** 기존 릴리스에는 `policy_pins.github`가 없으므로 [기본값 표](#에이전트-github-설정의-기본값)대로 `push_approval: true`로 읽는다. 릴리스 id도 바뀌지 않는다. 사람이 GitHub 탭에서 처음 저장할 때 새 릴리스가 생긴다(카드 버전은 그대로).
- **기존 에이전트 → GitHub 켜짐.** `github_enabled DEFAULT true`다.
- **실측(이 문서를 쓸 때, `cee8359b`).** 실제 contracts·release-ids 코드를 부르는 bun 테스트로 세 가지를 확인했다. `policyPinsSchema.safeParse({ tools, github })`는 실패한다. (카드 쪽 `agentCardSchema`도 모르는 칸이면 실패하므로, 설정을 카드에 두지 않는 이 설계에서는 카드 스키마를 건드리지 않는다.) 그리고 `deriveReleaseId`는 `policy_pins`에 키가 없을 때와 `github: undefined`일 때 같은 id(`sha256:6d06f0eb…`)를 낸다. `canonicalJsonOfJson`이 undefined 키를 버리기 때문이다. 반면 `canonicalJson`은 undefined에서 throw하므로, 해시에 들어가는 값은 지금처럼 `canonicalJsonOfJson`으로만 계산한다.
- **0단계로 되돌리기.** `policy_pins.github`가 든 릴리스가 생긴 뒤(GA-2 이후) 0단계 이미지로 되돌리면 그 에이전트의 릴리스를 읽지 못한다. GA-1 이전으로는 되돌리지 않는다.
- **알려진 한계.** 리뷰용 행을 만든 뒤(GA-5 이후) 0단계 이미지로 되돌리면 그 이미지의 `credentials()`가 행을 고르는 순서는 정해져 있지 않다. GA-1 이전으로는 되돌리지 않는다. 실행 프로필 전환(`profile-db.md` 5절)과 같은 규칙이다.
- **같은 역할에 App 여럿(2026-11-02 개정).** 확장 마이그레이션 하나가 유일 제약을 `(workspace_id, app_id)`로 바꾸고, `catalog_repository_github_apps`를 만들고, `user_link_connection_id`를 기존 작성용 행으로 채운다. 기존 저장소의 고정은 마이그레이션이 쓰지 않는다. 역할마다 연결이 하나인 동안에는 첫 발급이 그 연결을 고정하므로(닿으면 1개, 아니면 0개) 지금과 같은 App이 발급한다. 앞 이미지는 역할의 첫 행을 쓰므로, 역할마다 연결이 하나인 동안 앞 이미지와 새 이미지는 같은 App을 고른다. 그래서 두 번째 연결을 더하는 API(`POST …/github-apps`)는 새 이미지가 모든 replica에 올라간 뒤에 쓴다. 섞인 배포 동안 앞 이미지의 콘솔에서 구성원 계정 연결에 쓰는 작성용 App을 지우면 `user_link_connection_id`의 RESTRICT에 걸려 `500`이다. 새 이미지는 그 칸을 먼저 비우고 지우거나(마지막 작성용 연결), `409` `in_use_for_user_link`로 답한다(다른 작성용 연결이 있을 때). 운영자는 배포 중 앞 이미지 콘솔의 이 `500`을 예상한다. 한 역할에 연결이 둘 이상 생긴 뒤에는 앞 이미지로 되돌리지 않는다. 앞 이미지가 고르는 행이 정해져 있지 않기 때문이다(위 알려진 한계와 같은 규칙).

## 6. API

| 메서드·경로 | 누가 | 내용 |
|---|---|---|
| `GET`·`PUT`·`DELETE /v1/workspaces/{id}/github-apps/{role}` (새, `role` = `author`·`reviewer`) | owner·admin, cookie 세션만 | #922와 같은 본문과 응답(`openapi.ts:1167`, `1219`, `1260`)이다. 응답의 `github_app`에 `role`, `permissions`, `permissions_checked_at`, `warnings`(상한보다 넓은 권한 목록), `connection_id`를 더한다. `PUT reviewer`는 작성용 행이 없으면 `409` `reason_code: no_author_app`, 같은 App이면 `409` `same_app`이다. 그 역할의 연결이 0개나 1개일 때만 이렇게 동작하고, 여럿이면 세 메서드 모두 `409 GITHUB_APP_CONFLICT`(`reason_code: ambiguous_role`)다. `PUT`이 다른 `app_id`로 교체하면 그 연결의 고정을 지우고 receipt에 `pins_cleared`를 남긴다. `DELETE`는 연결 id 주소의 `DELETE`와 같은 규칙이다. 구성원 계정 연결에 쓰는 작성용 연결은 다른 작성용 연결이 있으면 `409` `in_use_for_user_link`이고, 마지막 작성용 연결이면 지금처럼 지워진다. 해제한 연결의 고정은 비워 남고, 같은 App을 다시 더하면 되살아난다([결정 11](#결정-11-같은-역할에-app-여럿)). (이전 결정: 역할마다 행 하나라 이 주소가 연결을 정했다. 바뀐 이유: 오너 결정 2026-11-02 1) |
| `/v1/workspaces/{id}/github-app` (있음) | 그대로 | `…/github-apps/author`의 별칭. 응답 모양은 그대로이고, 새 칸은 optional로 더한다. 작성용 연결이 여럿이면 `ambiguous_role`이다(2026-11-02 개정. 이전에는 작성용 행이 하나라 늘 그 행이었다) |
| `GET`·`POST /v1/workspaces/{id}/github-apps` (2026-11-02, 새) | owner·admin, cookie 세션만 | `GET`은 모든 연결의 목록(`connection_id`, `role`, 나머지는 위 `github_app`과 같다). `POST`는 본문 `{ role, app_id, private_key }`로 연결을 더한다. 등록 검사는 #922와 같고, `role: reviewer`는 작성용 연결이 하나도 없으면 `no_author_app`, 같은 `app_id`가 이미 있으면 역할과 상관없이 `409` `same_app`이다. 첫 작성용 연결이면 `user_link_connection_id`를 같이 채운다. `set_github_app` receipt |
| `GET`·`PUT`·`DELETE /v1/workspaces/{id}/github-apps/{connectionId}` (2026-11-02, 새) | owner·admin, cookie 세션만 | 경로의 값이 `author`·`reviewer`가 아니면 연결 id다. `GET` 응답에 `usage: { pinned_repository_count, agent_count, active_session_count, user_link }`([결정 11](#결정-11-같은-역할에-app-여럿)의 5)를 더한다. `PUT`은 같은 App의 키 교체만 받는다(저장된 `app_id`와 다르면 `400` `reason_code: app_id_mismatch`). 다른 App은 `POST`로 더한다. `DELETE`는 `user_link`인 연결이고 다른 작성용 연결이 있으면 `409` `in_use_for_user_link`이고, 아니면 해제한다(`delete_github_app` receipt). 옛 역할 주소의 `DELETE`도 같은 규칙이라, 작성용 App이 하나인 워크스페이스에서는 지금처럼 지워진다. 해제한 연결의 고정은 비워 남고, 같은 역할에 같은 App을 다시 더하면 되살아난다 |
| `PUT /v1/workspaces/{id}/github-repositories/{catalog_id}/app-pins/{role}` (2026-11-02, 새) | owner·admin, cookie 세션만 | 본문 `{ connection_id }`. 저장소의 고정 연결을 바꾼다([저장소에 고정된 연결](#저장소에-고정된-연결)). 연결의 역할이 다르면 `400` `role_mismatch`, 그 App이 저장소에 닿지 않으면 `400` `not_installed`. `set_repository_github_app` receipt. 저장소 페이지 API의 행에는 `pins: { author, reviewer }`(연결 id 또는 null)를 더한다 |
| `PUT /v1/workspaces/{id}/github-settings/user-link-app` (2026-11-02, 새) | owner·admin, cookie 세션만 | 본문 `{ connection_id }`(작성용 연결만, 아니면 `400` `role_mismatch`). 구성원 계정 연결에 쓰는 연결을 바꾸고 client secret을 지운다. `set_github_app` receipt(`purpose: user_link`) |
| `GET /v1/workspaces/{id}/github-settings` (새) | 구성원 | 2026-11-02 개정으로 `connections: [{ connection_id, role, name, app_id, key_status, permissions, installations: [{ id, account, permissions }] }]`와 `oauth.connection_id`를 더한다. 저장소 이름·수와 키를 저장한 사람은 넣지 않는다(구성원도 읽는 응답이다). 이 칸 끝의 `apps.author`·`apps.reviewer`는 그 역할의 연결이 하나일 때 그 연결이고, 0개나 여럿이면 null이다. 이전 결정: 역할마다 행이 하나라 null은 "App 없음"이었다. 바뀐 이유: 오너 결정 2026-11-02 1. 칸을 지우지 않아 응답 모양은 그대로지만, 연결이 여럿인 워크스페이스에서 `apps`만 읽는 클라이언트는 App이 없다고 보인다. 그래서 콘솔과 SDK는 `connections`를 읽고, 두 번째 연결을 더하는 화면은 `connections`를 읽는 콘솔과 함께 나간다. 그 밖의 칸: `ceiling`, `revision`, `agents_using`(기능별로, `github_enabled`가 true이고 활성 릴리스의 `policy_pins.github`에서 그 기능을 켠 에이전트 수. 시안 C). 이 수는 "활성 릴리스에서 켠 에이전트"이지 실제 영향 전부가 아니다. 앞 릴리스로 아직 도는 세션도 상한을 낮추면 다음 발급부터 거절된다. 화면 문구는 "활성 릴리스에서 켠 에이전트 N개"로 하고, 낮출 때 확인 대화 상자에 "앞 릴리스로 도는 세션도 다음 GitHub 요청부터 거절됩니다"를 적는다,  `oauth: { client_id, client_secret_set, callback_url }`, `apps: { author: { permissions } \| null, reviewer: … }` |
| `PUT /v1/workspaces/{id}/github-settings` (새) | owner·admin, cookie 세션만 | 본문 `{ ceiling, revision }`. `set_github_ceiling` receipt |
| `PUT /v1/workspaces/{id}/github-settings/oauth-client-secret` (새) | owner·admin, cookie 세션만 | 본문 `{ client_secret }`. `set_github_app` receipt(`purpose: oauth_client_secret`, 끝 네 글자만). 값은 다시 읽히지 않는다 |
| `GET /v1/agents/{id}/github` (새) | 에이전트를 볼 수 있는 사람 | `enabled`, 활성 릴리스의 `github`(없으면 `null`과 `legacy_defaults`), `options`: 고를 수 있는 저장소, 각 기능의 `available`과 `reason`(`app_permission_missing`·`over_workspace_ceiling`·`no_reviewer_app`·`app_required`·`github_host_unsupported`) |
| `PUT /v1/agents/{id}/github/enabled` (새) | 에이전트 관리자(`agent.manage`), cookie 세션만 | 본문 `{ enabled }`. 즉시 반영. `set_agent_github` receipt. Slack의 `…/slack/app/settings`(`openapi.ts:3102-3119`)와 같은 자리 |
| `POST /v1/agents/{id}/releases` (있음, 본문 확장) | 그대로 | 본문에 optional `github`(위 스키마)를 더한다. 없으면 활성 릴리스의 값을 물려받는다. 검증 실패는 `400`의 `details.field`(`github.…`)와 `details.reason_code`(`repository_not_allowed`·`app_required`·`actions_off`·`over_workspace_ceiling`·`release_repository_outside`). 활성화는 지금의 흐름 그대로 |
| `GET /v1/agents/{id}/github/activity` (새) | 에이전트를 볼 수 있는 사람 | 그 에이전트의 GitHub receipt 최근 20개(`mint_github_token`, 게이트 거절, `set_agent_github`, `review_pull_request`, `dispatch_workflow`, `rerun_workflow`, GitHub 설정이 바뀐 `create_agent_release`·`activate_agent`). 대상으로 찾고 세션 기록은 호출자가 볼 수 있는 세션만 준다([결정 10](#결정-10-감사)의 조회 규칙, 시안 A "최근 기록") |
| `POST /v1/linked-accounts/github/start`, `POST …/github/callback` (새) | 본인(`account.link`) | Slack의 `…/slack/start`·`…/slack/callback`(`openapi.ts:2722`, `2743`)과 같은 모양과 state 규칙. 작성용 App이나 client secret이 없으면 `409` `reason_code: github_oauth_unset`([GA-4에서 정한 것](#ga-4에서-정한-것)) |
| `GET /v1/sessions/{id}/github/attribution` (GA-4, 새) | `session.read` | `{ trigger, attribution, login }`. 세션 상세의 귀속 줄([GA-4에서 정한 것](#ga-4에서-정한-것)) |
| `GET /v1/sessions/{id}/outcomes` (GA-4b, 새) | `session.read` | 세션의 성과물 목록([10절](#세션-상세의-성과물)) |
| `GET /v1/sessions/{id}/github/refusals` (GA-4b, 새) | `session.read` | 세션의 최근 게이트 거절 10개, 최근 것부터. `{ items: [{ receipt_id, operation, purpose, reason_code, created_at }] }`([GA-4b에서 정한 것](#ga-4b에서-정한-것)) |
| `GET /v1/usage/outcomes` (GA-4b, 새) | `GET /v1/usage/summary`와 같다 | 기간의 PR 성과물 집계([10절](#roi-재료-집계-query)) |
| `POST /v1/sessions/{id}/github/workflow-dispatches` (새) | `session.submit` | 본문 `{ workflow, ref, inputs? }`. GitHub에 `return_run_details: true`로 보내고, 응답은 `{ receipt_id, run: { id, html_url } \| null }`이다. GitHub가 run 정보를 주지 않으면 `run`은 null이다. `inputs`는 receipt에도 로그에도 남기지 않는다(키 이름만 남긴다). GitHub 오류 응답의 원문도 남기지 않는다([결정 0](#결정-0-github가-강제하는-것은-다시-책임지지-않는다)) |
| `GET /v1/sessions/{id}/github/workflow-runs/{run_id}` (새) | `session.read` | `actions_read`. `{ id, path, head_branch, status, conclusion, html_url }` |
| `POST /v1/sessions/{id}/github/workflow-runs/{run_id}/rerun` (새) | `session.submit` | 본문 `{ failed_only?: boolean }` |
| `POST /v1/sessions/{id}/github/pull-requests/{number}/reviews` (새) | `session.submit` | 본문 `{ event, commit_id, body? }`. `commit_id`는 40자 hex 필수 |
| `POST …/push-requests/{id}/pull-request`, `…/comments` (있음) | 바뀜 | `pushed` 요청이면 사람이 승인했든 정책이 승인했든 `session.submit`도 된다([결정 6](#결정-6-push-전-사람-승인)). `sessions:approve`는 그대로 된다 |

- 게이트 거절의 공통 형식: HTTP `403`(정책) 또는 `409`(설정이 없음·상한), `error.code` `GITHUB_REFUSED`, `details.reason_code`, `details.receipt_id`. 연결을 정하지 못하거나 고정된 연결이 닿지 않아 끝난 `503` `forge_failed`도 `details.receipt_id`로 게이트 실패 receipt(`pin_state`)를 돌려준다. GA-5의 리뷰용 App 미설치와 같은 방식이다. `reason_code` 값은 contracts의 `GITHUB_REFUSAL_VALUES` 하나에 모은다: `github_disabled`, `repository_not_allowed`, `feature_off`, `over_workspace_ceiling`, `app_permission_missing`, `no_reviewer_app`, `app_required`, `workflow_not_allowed`, `agent_ref_refused`, `run_ref_unprovable`, `actions_off`, `github_settings_unsupported`, `github_host_unsupported`, `repository_none`, 그리고 2026-11-02 개정의 `ambiguous_app`·`pinned_app_removed`(둘 다 `409`, [결정 11](#저장소에-고정된-연결)). 이전에는 역할마다 연결이 하나라 이 두 거절이 생기지 않았다.
- App 연결 관리의 충돌은 게이트 거절이 아니므로 `GITHUB_APP_CONFLICT`(`409`)의 `details.reason_code`로 준다: `same_app`, `no_author_app`, 그리고 2026-11-02 개정의 `ambiguous_role`·`in_use_for_user_link`([GA-5에서 정한 것](#ga-5에서-정한-것)과 같은 자리).
- 2026-11-02 개정의 입력 검증 거절은 `400`의 `details.reason_code`로 준다: `app_id_mismatch`(연결 id 주소의 키 교체에 다른 App), `role_mismatch`(고정·구성원 계정 연결에 역할이 다른 연결), `not_installed`(고정할 연결의 App이 저장소에 닿지 않음), `installation_required`(연결이 여럿인데 저장소 페이지 API에 `installation_id`가 없음).
- 새 경로는 `apps/control-host/src/api/openapi.ts`, `route-error-coverage.ts`, `packages/core`의 응답 표, `packages/client` 생성물, `docs/openapi.json`에 같이 들어간다.

### GA-5에서 정한 것

구현하면서 위 설명과 달라지거나 위에서 정하지 않은 것을 여기 둔다. 위 문단과 이 목록이 다르면 이 목록이 맞다.

- **역할 충돌의 오류 코드.** `same_app`·`no_author_app`은 `GITHUB_REFUSED`가 아니라 새 코드 `GITHUB_APP_CONFLICT`(`409`)의 `details.reason_code`로 준다. 게이트 거절이 아니고 receipt도 남기지 않아서다. store가 워크스페이스 advisory lock 안에서 다른 role의 행을 읽고 판정한다. 작성용 App을 지금 리뷰용 App과 같은 App으로 바꾸는 것도(`…/github-app` 별칭 포함) `same_app`이다. 작성용 App을 지워도 리뷰용 App은 남는다.
- **별칭.** `…/github-app`은 `…/github-apps/author`와 같은 처리다. 웹은 `…/github-apps/{role}`만 부른다.
- **저장소별 설치 권한.** `GET …/github-apps/{role}`의 `repositories[]`에 `installation_permissions`를 더했다. 그 저장소를 덮는 설치가 승인한 권한이고, 설치가 없거나 읽지 못하면 `null`이다. App 권한보다 좁으면 연결 화면이 "설치 승인 대기"를 보인다.
- **"App 미설치" 배지.** `GET /v1/agents/{id}/github`의 `options.repositories[]`에 `installed: { author, reviewer }`를 더했다. role마다 그 연결이 App JWT로 `GET /repos/{owner}/{repo}/installation`을 물어 정하고, 토큰은 발급하지 않는다. 연결이 없거나(PAT·GHES·카탈로그 App 저장소의 리뷰용) GitHub가 답하지 않으면 `null`이다. 탭은 `false`일 때만 배지를 단다. 리뷰 승인 줄은 켤 수 있을 때, 고른 저장소 중 리뷰용 App이 없는 곳이 있으면 배지와 그 저장소 이름을 보인다. 잠그지는 않는다. 저장소마다 GitHub가 정한다.
- **리뷰 receipt.** `review_pull_request`의 result는 `session_id`·`agent_id`·`agent_release_id`·`repository_id`, `number`·`commit_id`·`event`, `opened_by_session_id`·`opened_by_agent_id`, 성공이면 `review_id`다. 연 세션은 같은 owner에서 그 저장소·번호의 PR을 기록한 가장 최근 세션이고, 없으면(사람이 연 PR) `null`이다. 게이트 거절도 같은 operation으로 남고 `number`·`commit_id`·`event`를 싣는다. 리뷰 본문은 receipt에도 로그에도 남기지 않는다. GitHub가 리뷰를 거절하면(예: PR을 연 App의 승인, `422`) 실패 receipt에 HTTP 상태와 `github_request_id`만 두고 `503` `BACKEND_UNAVAILABLE`이다. 리뷰용 App이 그 저장소에 설치되지 않아 토큰을 받지 못해도 실패 receipt(`role`·`app_id`)를 남기고 `503`의 `details.receipt_id`로 돌려준다.
- **연결 화면.** 리뷰용 App 카드는 작성용 App 카드 바로 아래에 둔다. 비어 있으면 권장 권한 줄을, 등록되면 저장소별 설치 상태를 보인다. 같은 에이전트 승인 위험 단락은 늘 보이고, 삭제 줄은 위험 구역이 아니라 이 카드 안에 둔다. 위험 구역은 작성용 App의 것이다.

## 7. 화면

시안은 GA-MOCKUP이 만든 오너 확인용 사본이다(repo 밖 시안 모음). 화면 이름은 그 시안의 파일 이름이다. A는 에이전트 GitHub 탭(`a-default`, `a-nogh`, `a-noreview`, `a-ceiling`), B는 연동 계정(`b-unlinked`, `b-linked`), C는 GitHub 연결 설정(`c-default`, `c-noreview`, `c-member`)이다. 화면 PR(GA-3·GA-4·GA-6)은 이 절과 시안을 같이 기준으로 삼는다. 둘이 다르면 이 문서를 먼저 고친다. 시안과 이 문서가 다른 곳은 하나다. 시안 A는 저장소 후보를 "작성용 App을 쓰는 설치된 저장소"로 그렸다. 이 문서는 거기에 릴리스 프로필이 허용하는 것(`allowedPair`)이라는 조건을 더하고 PAT 저장소를 뺀다([결정 8](#결정-8-에이전트별-저장소-범위)). 탭은 프로필이 허용하지 않는 저장소를 이유와 함께 비활성으로 보인다.

### 에이전트 상세 GitHub 탭

`AGENT_TABS`(`apps/web/src/routes/agent-detail.tsx:70-76`)의 `slack` 뒤에 `github`를 더한다. 구성은 Slack 탭과 같다. 위에 사용 스위치, 아래에 상세 옵션이다.

1. **GitHub 사용**: 스위치. 즉시 반영되고, 끌 때 "진행 중인 세션도 다음 GitHub 요청부터 거절됩니다" 확인 대화 상자를 띄운다. 꺼져 있으면 아래 영역은 읽기 전용으로 흐리게 보인다.
2. **저장소**: 고를 수 있는 저장소 목록(체크박스). 설치 안 된 저장소는 "App 미설치" 배지.
3. **권한**: 기본 권한 줄(읽기 전용, "PR 작성·수정: contents·pull requests")과 선택 권한 다섯 줄(workflows 수정, Actions 실행, Checks 쓰기, Issues 쓰기, 리뷰 승인). 줄마다 비활성일 때 이유 한 줄과 해결할 곳 링크(GitHub 연결 설정)를 단다.
4. **Actions 허용 목록**: Actions 실행을 켰을 때만 보인다. 행마다 워크플로 파일 이름과 선택 ref 패턴. 비었으면 "목록에 없는 워크플로는 실행하지 않습니다".
5. **push 전 사람 승인**: 스위치. 끌 때 "승인 없이 `agent/<세션>` 브랜치로 push하고 PR을 엽니다" 경고.
6. **저장**: 2~5는 "새 릴리스로 저장"이다. 저장하지 않은 변경이 있으면 위쪽에 "릴리스에 넣지 않은 변경 N건" 상자(새 릴리스로 저장 / 되돌리기)를 보인다. 저장하면 같은 카드 버전·같은 실행 프로필에 새 GitHub 설정으로 릴리스를 만들고, 지금의 활성화 단계로 이어진다.
7. **최근 기록**: `…/github/activity`의 receipt 몇 줄과 운영 기록 링크.

### GA-3에서 정한 것

구현하면서 위 설명과 달라지거나 위에서 정하지 않은 것을 여기 둔다. 위 문단과 이 목록이 다르면 이 목록이 맞다.

- **누가 읽나.** 세 경로 모두 `agent.manage`가 있어야 한다. 에이전트 상세(`GET /v1/agents/{id}`)를 읽는 조건과 같다. 스위치는 cookie 세션의 사람만 바꾼다. API 키는 `403` `reason_code: web_session_required`다.
- **`GET …/github` 응답.** 6절의 칸에 `active_release_id`, `release_repository_id`(활성 릴리스의 저장소), `unsavable`을 더했다. `unsavable`은 탭이 저장을 막는 이유이고 `no_active_release` → `repository_none` → `app_required` 순서로 하나만 준다. 이유는 저장소와 기능에 따로 둔다. 저장소는 `repository_not_allowed`(활성 릴리스의 실행 프로필이 허용하지 않음)와 `app_required`(PAT 저장소), 기능은 `github_host_unsupported` → `over_workspace_ceiling` → `no_reviewer_app` → `app_permission_missing` 순서다. App 권한은 마지막으로 읽어 둔 값으로 판정하고, 아직 읽지 않았으면(`null`) 판정하지 않는다. 실제 허용은 발급 때마다 게이트가 다시 정한다. (그 뒤 `release_repository_id`와 `unsavable`은 없어졌다. 탭은 `settings_revision`·`start_repository_id`로 `PUT …/github/settings`에 저장하고, 저장소는 워크스페이스 상한으로 고른다.)
- **저장소 줄.** 체크박스 대신 스위치다. 활성 릴리스의 저장소는 켜진 채 잠근다. 후보는 카탈로그에서 GitHub에 있는 저장소 전부(App 저장소와 github.com의 PAT 저장소)이고, 고를 수 없는 것은 이유와 함께 잠근다. 이미 켠 줄은 이유가 생겨도 끌 수 있다. "App 미설치" 배지는 저장소별 설치 상태가 필요해서 GA-5로 미룬다.
- **기능 줄.** 순서는 시안을 따라 리뷰 승인, Actions 실행, 검사 결과 쓰기, 이슈 쓰기, 워크플로 파일 수정이다. GitHub Enterprise 이유에는 설정 링크를 달지 않는다. 워크스페이스에서 고칠 수 없어서다. workflows와 Actions를 같이 켜면 허용 목록의 파일을 에이전트가 자기 브랜치에서 고칠 수 있다는 경고를 보인다.
- **허용 목록 입력.** 화면은 `agent/` 브랜치를 가리킬 수 있는 ref 패턴(첫 `/` 앞이 `agent`에 맞는 것: `agent/*`, `ag*/x`, `*/x`)과 중복, 33번째 항목을 받지 않는다. 서버는 릴리스 때 이것을 막지 않고 실행 때 게이트가 `agent_ref_refused`로 막는다. 시안의 `agent/*` 예시는 쓰지 않는다(`main`, `release/*`).
- **저장.** 화면이 `POST …/releases`에 활성 릴리스의 `version_id`·`runtime_profile_id`·`repository_id`와 새 `github`를 보내고, 이어서 페이지가 읽은 `activation_revision`으로 `POST …/activate`를 부른다. 그 사이 다른 사람이 활성화했으면(`REVISION_CONFLICT`) 만든 릴리스를 활성화하지 않고 알린다. 변경은 그대로 남는다.
- **기록에 들어가는 receipt.** `create_agent_release`와 `activate_agent`의 result에 `github`(그 릴리스의 `policy_pins.github` 또는 `null`)와 `github_changed`(바로 앞 활성 릴리스와 다른가)를 쓴다. 기록은 `github_changed: true`인 것만 보인다. 이 칸이 없는 예전 receipt는 보이지 않는다. 세션의 receipt(`mint_github_token`, `review_pull_request`, `dispatch_workflow`, `rerun_workflow`)는 `target_ref.session_id`의 세션이 이 에이전트의 릴리스로 돌았고 호출자가 볼 수 있는 것(`sessionVisibleTo`)만 준다. 이 거르기는 SQL에서 20개를 자르기 전에 한다. 그래서 에이전트 관리자도 공유받지 않은 비공개 세션의 거절은 보지 못한다.
- **운영 기록 링크.** 넣지 않았다. 운영 화면에는 receipt를 에이전트로 거르는 곳이 없다.
- **push 절.** 시안의 "push와 작성자"에서 공동 작성자 설명은 GA-4(연동 계정)로 미룬다. GA-3은 push 전 승인 스위치만 둔다.

### 설정 > 연동 계정

`/settings/linked-accounts`의 서비스 목록에 GitHub 행을 더한다. 미연결이면 "GitHub 계정 연결" 버튼이 GitHub 동의 화면으로 간다. 연결되면 login과 "공동 작성자 이메일 `<id>+<login>@users.noreply.github.com`" 한 줄, "해제" 버튼을 보인다. 작성용 App이나 client secret이 없으면 버튼은 비활성이고 "owner·admin이 GitHub 연결 설정에서 사용자 연결을 켜야 합니다"를 보인다.

### 설정 > 워크스페이스 > 연동 > GitHub

`/settings/workspace/integrations/github`(`router.tsx`)는 위에서 아래로 GitHub 카드, 에이전트가 쓸 수 있는 기능, 구성원 GitHub 계정 연결 세 덩어리다. 화면 계약은 GitHub 연결 설정 시안 v3(repo 밖 설계 문서 4절)와 그 7절의 오너 결정 1~8(2026-11-02, 모두 추천안)이다. 이전 결정: 작성용·리뷰용 영역마다 등록 양식과 App 권한 표를 두었고, 결정 11 개정 뒤에는 역할 섹션 안에 연결 카드를 그렸다. 바뀐 이유: 오너가 권한 표·비교 열·경고 상자·키 교체 버튼·요약 카드·계정 칩 줄을 빼고 한 카드로 줄이기로 했다.

1. **GitHub 카드**
   - 머리: GitHub 타일, "App N개 · 계정 N곳", 주 버튼 **조직 추가**. App이 여럿이면 설치할 App을 고르는 메뉴가 열린다. 콘솔이 일회용 상태(`POST …/github-apps/{connectionId}/installations/start`)를 만들어 그 App의 설치 화면으로 보내고, 돌아오면 `POST …/github-apps/installations/complete`로 연결한 사람을 남긴다.
   - **GitHub App 목록**: 연결마다 한 줄. 이름, 역할 배지(작성용·리뷰 승인용. 역할 섹션은 없다), App ID와 마지막 키 저장 날짜·저장한 사람, 상태 배지(연결됨·권한 추가 필요·승인 대기 N곳·GitHub 인증 실패·확인 못 함). 안내보다 넓은 권한이 있으면 배지 하나를 달고 그 목록은 배지를 열어 본다. ⋯ 메뉴는 **새 키 등록**(같은 App의 새 키를 같은 연결에 저장, `PUT …/github-apps/{connectionId}`)과 **연결 해제**다. 목록 아래 **App 추가**는 새 App 만들기(manifest)와 이미 있는 App 연결 가운데 고른다. 리뷰 승인용으로 연결할 때만 같은 에이전트가 작성과 승인을 할 수 있다는 위험과 GitHub 쪽 대응([결정 1](#결정-1-리뷰-전용-app))을 그 창에 보인다.
   - **권한이 모자란 App**: 켠 기능에 그 App의 권한이 모자라면 App 행에 무슨 기능에 무슨 권한이 필요한지 한 문장, **GitHub에서 권한 추가**(그 App의 권한 설정 화면), **App 소유자에게 보낼 안내 복사**를 둔다. 같은 App에 모자란 기능이 여럿이어도 링크는 하나다. 권한을 더하면 GitHub가 설치한 계정마다 owner에게 승인을 요청하고, 다시 설치하지 않아도 된다. 새 App일 때만 설치부터 다시 한다.
   - **승인 대기**: App이 요청한 권한을 아직 승인하지 않은 설치가 있으면 App 행에 그 계정들과 권한을 한 문장으로 적고 **owner에게 보낼 안내 복사**를 둔다.
   - **설치 표**: 한 행이 설치 하나(계정 × App)다. 열은 이름(행 머리) · 유형 · 저장소 · App · 연결한 사람 · 상태 · ⋯이다. 연결한 사람은 콘솔에서 시작해 돌아온 설치만 알고, 모르면 GitHub가 준 설치 날짜를 보인다. 상태는 연결됨·승인 대기·중지됨·확인 못 함이고, GitHub 조회가 실패한 "확인 못 함"을 승인 대기로 보이지 않는다. ⋯ 메뉴의 **GitHub에서 관리**(승인 대기면 **GitHub에서 승인**)가 그 설치의 설정 화면으로 간다. 표 자신의 폭이 760px 이하면 이름 · 상태 · ⋯만 남기고 나머지는 이름 칸 아래 줄로 옮긴다. 표 아래에 GitHub에서 마지막으로 읽은 시각을 적는다.
   - **에이전트가 쓰는 저장소** 줄: 에이전트가 고른 저장소 수와 설치 밖 수, **저장소 관리**. 설치 표와 따로 있어서 설치가 모두 사라져도 들어갈 수 있다.
   - 화면의 GitHub 링크는 설치 행 ⋯의 "GitHub에서 관리"와, 권한이 모자란 App 행의 "GitHub에서 권한 추가" 둘뿐이고 목적지가 겹치지 않는다.
2. **저장소 시트**: 설치를 골라 그 설치가 닿는 저장소를 한 쪽씩 보인다(저장소 · 기본 브랜치 · 에이전트, [결정 11](#결정-11-같은-역할에-app-여럿)의 4). 고르기 전에는 작성용 App의 첫 설치를, 없으면 리뷰 승인용 App의 첫 설치를 이름으로 읽는다(account 이름순, 정지됐거나 GitHub가 답하지 않은 설치는 건너뛴다). 같은 역할의 연결이 여럿이면 서버가 기본값을 고르지 않기 때문이다. 행 메뉴에서 기본 브랜치와 저장소를 맡을 App(고정 연결, `PUT …/app-pins/{role}`)을 바꾼다. 에이전트가 골랐지만 지금 어느 설치도 닿지 않는 저장소는 "설치 밖 저장소"로 따로 모은다.
3. **에이전트가 쓸 수 있는 기능**: PR 작성·수정(항상 켜짐), Actions 실행, 워크플로 파일 수정, PR 리뷰 승인. 워크스페이스 상한 하나이고([결정 9](#결정-9-워크스페이스-상한--에이전트-좁히기), 결정 11의 2), 에이전트마다 켜는 것은 그 에이전트의 GitHub 탭이다. 스위치는 바꾸면 바로 저장한다. 마지막으로 받은 저장값 전체(화면에 없는 `checks`·`issues` 포함)에 그 칸만 바꿔 `revision`과 함께 보내고, 저장은 하나씩 차례로 보낸다. 실패하거나 `409`면 저장된 값을 다시 읽어 스위치를 되돌리고 알린다. 끌 때만 확인 창을 띄운다. 기능 행의 배지는 "App 권한 필요"와 "일부 계정 승인 대기" 둘이다. 승인 대기 배지는 그 기능이 쓰는 권한을 아직 승인하지 않은 설치가 있을 때만 붙고, 기능과 상관없는 권한의 승인 대기는 배지를 더하지 않는다. 링크는 없고 해결은 App 행에서 한다. owner·admin만 바꾸고, 다른 사람에게는 읽기 전용이다.
4. **구성원 GitHub 계정 연결**: 어느 작성용 App의 사용자 인증으로 연결하는지 한 줄, 상태 배지(켜짐·설정 필요), ⋯ 메뉴(client secret 입력·바꾸기, callback URL 보기). 작성용 연결이 여럿이면 이 줄에서 고른다(결정 11의 3).

- 구성원(읽기 전용)에게는 App 목록과 설치 표의 이름·유형·App·상태만 보인다. 저장소 열, 연결한 사람, ⋯ 메뉴, 조직 추가, App 추가, 저장소 관리는 없다.
- App이 하나도 없으면 GitHub 카드 안에 "GitHub App 만들기"와 "이미 있는 App 연결"만 두고, 기능과 구성원 계정 연결은 숨긴다.
- 연결 해제는 확인 창에 `usage`의 세 수와 "같은 App을 다시 더하면 고정이 되살아납니다"를 보인다. 구성원 계정 연결에 쓰는 연결은, 다른 작성용 연결이 있으면 해제하지 않고 "구성원 계정 연결을 다른 작성용 App으로 바꾼 뒤 해제할 수 있습니다"를 보인다. 마지막 작성용 연결이면 확인 창 영향 항목에 "구성원이 새로 GitHub 계정을 연결할 수 없게 됩니다(이미 연결한 계정은 그대로입니다)"를 더한다(결정 11의 5).

### 세션 상세

PR 정보 영역(세션 출력)에 commit 귀속 한 줄: "공동 작성자: <login>" / "GitHub 계정 미연결" 안내와 연동 계정 링크 / "App 단독(시작자 없음)". 그리고 게이트 거절이 있으면 이유를 보인다.

i18n ko·en·ja를 같이 고친다.

## 8. 검증 기준(werft-sandbox)

실 GitHub 검증은 `JeongJaeSoon/werft-sandbox`와 작성용 App `werft-sandbox-agent`(App ID는 저장소 밖 노트에 있다)로 한다. 리뷰용 App은 오너가 새로 만든다. 각 구현 PR의 실측 항목은 [9절](#9-구현-pr-분할)에 있다. 공통 규칙은 셋이다. 자기 verify 스택 하나를 쓰고 끝나면 바로 `down.sh`로 내린다(volume은 남는다). 키 파일은 경로만 넘기고 읽지 않는다. 거절을 확인할 때는 플랫폼 거절(게이트 `reason_code`)과 GitHub 거절(403·422)을 나눠 적는다.

## 9. 구현 PR 분할

| PR | 범위 | 수락 기준 | werft-sandbox 실측 |
|---|---|---|---|
| GA-1 데이터 모델·이전(확장) | 마이그레이션: `github_apps.role`·`permissions`·`permissions_checked_at`과 `UNIQUE (workspace_id, role)`, `github_workspace_settings`, `agents.github_enabled DEFAULT true`, `linked_accounts` provider CHECK 확장·`verified_via` TypeScript 타입 확장. contracts: `agentGitHubSchema`(`policy_pins.github`의 optional 칸), 릴리스를 만들 때 활성 릴리스의 `github` 물려받기, `githubCeilingSchema`, `GITHUB_REFUSAL_VALUES`, receipt operation 값, `decided_by` policy 모양. store의 role 인자(`find`·`put`·`delete`·`credentials`)와 기존 API·forge의 `author` 고정. `policy_pins.github` 릴리스 세션의 GitHub 토큰 fail closed(`github_settings_unsupported`). `receiptActorOf`의 `agent_id` 채우기. 릴리스 id 버전 4(`github`이 있을 때만) | 실 postgres 통합 테스트: 기존 `github_apps` 행이 `author`로 읽힌다. `(workspace, role)` 유일. `reviewer` 행을 직접 넣어도 콘솔 forge가 작성용 App을 쓰고, 기존 `GET`·`PUT`·`DELETE …/github-app`이 그 행과 키를 건드리지 않는다. `policy_pins.github`가 있는 릴리스의 세션은 clone·push·PR이 `github_settings_unsupported`. 기존 릴리스 id가 그대로 검증된다(fixture). GitHub 설정만 바꾸면 카드 버전·카드 해시는 그대로이고 `policy_pins.github`와 릴리스 id만 바뀐다. 에이전트 key의 `request_push` receipt에 `agent_id`가 있다. `bun run typecheck`, `bun test`, migration snapshot 테스트(`packages/db/src/schema.test.ts`) | 기존 등록 App으로 clone·push·PR이 #922 결과와 같다(PR 하나, 작성자 `app/werft-sandbox-agent`). receipt `request_push`에 `agent_id` |
| GA-2 토큰 발급 좁히기·허용 목록 | 릴리스 요청 `github`와 그 검증(저장소·PAT·상한·`actions_off`). `GitHubGate` 포트와 control-host 구현. gateway·push 실행기·PR 서비스를 게이트로 옮긴다. `credential(repo, permissions)`. App 권한 읽기(`describe`의 `permissions`)와 경고. 작업 서비스의 dispatch·run 조회·rerun과 세션 API, `github_workflow_dispatches` 마이그레이션(새 테이블이라 앞 이미지와 섞여도 안전하다). 새 작업의 오류 로그는 원문 없이 남긴다. `push_approval` false의 자동 승인과 `pushed` 요청의 `session.submit` PR 열기. `mint_github_token`·거절·`dispatch_workflow`·`rerun_workflow`·`decide_push`(policy) receipt. `github_enabled` 즉시 거절. 상한 정책 함수(contracts, 저장·실행 공용)와 `github-settings` GET·PUT API, `set_github_ceiling` receipt(GA-3의 Actions 실측이 상한을 켜야 하므로 화면보다 먼저 둔다) | 게이트 단위 테스트: [작업별 권한 표](#작업별-권한)의 각 줄과 각 `reason_code`. 꺼진 스위치가 진행 중 세션의 다음 clone 재허가·push·PR을 거절한다. 허용 목록의 ref glob(`*`가 `/`를 넘지 않음, `ref` 생략은 기본 브랜치만). `agent/` ref dispatch는 목록과 상관없이 `agent_ref_refused`. rerun은 `github_workflow_dispatches`에 기록된 run만 받고, 기록 없는 run(push로 시작된 run, 같은 이름의 브랜치·태그가 있는 저장소의 태그 run 포함)은 `run_ref_unprovable`. 기록된 run도 지금 릴리스 목록에서 빠졌으면 `workflow_not_allowed`. 입력값을 되비추는 fake GitHub 오류로 dispatch를 실패시켜 로그·receipt에 입력값이 없음을 확인한다. `pushed` 요청의 PR 열기가 `session.submit`(에이전트 key)으로 된다. 캐시된 토큰이 있어도 꺼진 뒤에는 쓰이지 않는다. fake GitHub(`packages/testkit/src/fake-github.ts`)로 route 테스트. 상한 서비스 테스트: owner·admin만(member·API key `403`), `revision` 충돌, 상한을 낮추면 기존 릴리스의 그 기능이 다음 발급부터 `over_workspace_ceiling`이고 올리면 다시 돈다 | 먼저 `PUT …/github-settings`로 상한의 workflows·actions를 켠다. 기본 권한으로 PR 생성. `workflows` 꺼진 릴리스로 `.github/workflows/` 변경 push → GitHub 거절과 `workflows_permission_missing`. 켠 릴리스(App에 권한 추가 뒤)로 같은 push 성공. 허용 목록 안 dispatch 성공, 목록 밖 dispatch는 플랫폼 `workflow_not_allowed`(GitHub 호출 없음, receipt). 목록 안 워크플로라도 `agent/<SID>` ref면 `agent_ref_refused`. 플랫폼이 dispatch한 run의 rerun 성공, `main` push로 시작된 run의 rerun은 `run_ref_unprovable`. 저장소 범위 밖 세션 생성 거절. `contents: read` 토큰 push 거절(검토 문서 6절 1번). 스위치를 끄면 진행 중 세션의 다음 push 요청이 `github_disabled`. 상한에서 Actions를 끄면 dispatch가 `over_workspace_ceiling`이고, 다시 켜면 성공 |
| GA-3 에이전트 GitHub 탭 | `GET /v1/agents/{id}/github`, `PUT …/github/enabled`, `GET …/github/activity`, 탭 화면·i18n·stories | activity route 테스트: 사람이 만든 릴리스·활성화·스위치 변경이 목록에 나온다. 공유받지 않은 비공개 세션의 게이트 receipt는 에이전트 관리자에게도 나오지 않는다. 걸러 낸 뒤에 20개를 자르므로, 볼 수 있는 기록이 20개 넘게 있으면 비공개 기록이 최근에 몰려 있어도 20개가 다 찬다. web 테스트(비활성 이유 여섯 가지, 저장 → 같은 카드 버전의 새 릴리스, 저장 안 한 변경 상자), 1440·390 전후 캡처, ui-review | 탭에서 저장소 하나·Actions·허용 목록 하나를 켜고 릴리스 → 그 릴리스로 dispatch 성공·목록 밖 거절. 스위치 끄기 → 탭의 최근 기록에 거절 이유(세션 상세에 보이는 것은 GA-4b로 옮김) |
| GA-4 사용자 GitHub OAuth·Co-authored-by | `…/github-settings/oauth-client-secret`과 GitHub 연결 화면의 사용자 계정 연결 영역(리드 결정, API와 같은 PR), `github_apps.client_id` 마이그레이션, `linked-accounts/github/start·callback`, 연동 계정 화면, claim의 `git.co_author`·`session_url`, worker `commit-msg` hook, PR 본문 꼬리 확장과 재사용 PR 꼬리 갱신, 세션 상세의 귀속 줄 | callback 테스트(state 만료·재사용, 같은 GitHub 계정 두 사람 `409`). hook 단위 테스트(트레일러 한 번만, 기존 트레일러 보존, `co_author` null이면 `Agent-Session`만). 시작자 규칙: 웹·개인 key·Slack 연결 사용자 → 사람, 에이전트 key → null | 오너 계정 연결 → 웹에서 시작한 세션의 commit에 `Co-authored-by: <login> <id+login@users.noreply.github.com>`, GitHub PR 화면에 공동 작성자로 보인다. 에이전트 key 세션은 트레일러 없음·"App 단독". PR 본문 꼬리에 세션 URL. 같은 세션 두 번째 push 뒤 꼬리의 commit이 최신 |
| GA-4b 세션 성과물(GitHub PR) | [10절](#10-세션-성과물) 전부. 마이그레이션 `session_outcomes`·`outcome_refresh_quotas`(새 테이블). forge `createPullRequest` 결과의 `created`(422로 남의 PR을 돌려줬으면 false). contracts `SESSION_OUTCOME_TYPE_VALUES`·성과물 스키마. `savePullRequest` 트랜잭션의 성과물 기록. forge 포트 `getPullRequest`와 `ForgePullRequest`의 `merged_at`·`closed_at`. 게이트 purpose `outcome_refresh`. API replica마다 도는 `outcome-refresher`(상태 조회와 성과물 없는 `pull_requests` 행 채우기). `GET /v1/sessions/{id}/outcomes`, `GET /v1/usage/outcomes`. 세션 상세 "결과물" 탭의 GitHub PR 영역과 세션 토큰·비용 줄, i18n ko·en·ja | 실 postgres 통합 테스트: PR 열기가 성과물 행 하나(`open`, `receipt_id` = `open_pull_request` receipt)를 같은 트랜잭션에서 만든다. 같은 세션의 두 번째 PR 열기(같은 URL)는 행을 늘리지 않는다. GitHub에 이미 열린 PR을 답한 경우와, 찾을 때는 없었는데 생성이 422로 사람의 PR을 돌려준 경우(fake GitHub) 모두 `metadata.adopted: true`. 성과물 행을 쓰지 못하면 `pull_requests` 행과 receipt도 남지 않는다(한 트랜잭션). 성과물 없는 `pull_requests` 행(push 요청 있음)을 refresher가 채우고 그 행의 `receipt_id`를 쓴다. push 요청이 없는 옛 행은 건너뛴다. refresher 두 개가 같은 행을 집지 않고, GitHub 호출 동안 DB 잠금을 쥐지 않는다(느린 fake GitHub 응답 중에 다른 refresher가 다른 행을 처리한다). 집기만 하고 답을 못 받은 행의 `state_checked_at`은 그대로다. lease가 만료돼 다시 집힌 행에 늦게 온 앞 결과(`open`)는 새 결과(`merged`)를 덮지 않는다. 같은 `quota_key`를 refresher 두 개가 동시에 집어도 한 창의 `used`가 예산을 넘지 않는다(남은 몫 50에 두 refresher가 동시에 집으면 합이 50). 최근 PR 몇 개를 한 시간 동안 5분마다 다시 읽으면 요청마다 `used`가 늘어 예산에서 멈춘다. 같은 사용자의 서로 다른 PAT 두 개가 같은 `quota_key`를 쓰고, 저장소의 PAT를 다른 사용자의 것으로 바꾸면 다음 pass부터 새 키로 센다(fake `GET /user`). 조회가 500을 받아도 같은 pass에서 다시 보내지 않는다(fake GitHub 요청 수). `GET /user`가 실패한 PAT는 1시간 동안 다시 부르지 않고 그 저장소의 행도 집지 않는다. `x-ratelimit-remaining`이 limit의 20% 아래이거나 429면 그 단위가 reset까지 멈추고 다른 replica도 집지 않는다. 간격 표대로 읽을 행을 고른다(`merged`는 읽지 않음, 닫힌 지 30일 지난 `closed`는 읽지 않음). fake GitHub로 `open → merged`, `open → closed → open`, 404 → `check_error: not_found`이고 state는 그대로. 에이전트 스위치를 끄고 범위를 좁혀도 `outcome_refresh`는 발급된다. `GET /v1/usage/outcomes`: PR 둘인 세션의 비용이 한 번만 더해진다, 성과물 없는 세션의 비용이 `cost_usd`에 들어간다, scope별 읽기 권한이 summary와 같다(member의 `installation` 403, API key의 `agent` 403), 합계 행의 `session_count`·`cost_usd`가 같은 기간의 summary와 같다. web 테스트(PR 영역의 세 state 배지, `check_error` 줄, 탭 수 = PR + 파일, 둘 다 없을 때 빈 안내), 1440·390 전후 캡처, ui-review | 플랫폼으로 PR을 연다 → `GET …/outcomes`에 `open` 행. GitHub에서 그 PR(만든 지 1일 안, 예산·멈춤에 걸리지 않은 설치)을 머지 → 7분 안에(간격 5분 + 1분 tick + 조회 시간) `merged`와 `merged_at`, 세션 상세 배지가 "머지됨". 다른 세션의 PR을 GitHub에서 닫음 → `closed`. 다시 열기 → 1일 간격 안에서 `open`(실측은 `state_checked_at`을 앞당겨 다음 pass를 기다린다). `GET /v1/usage/outcomes?scope=agent`가 그 에이전트의 `pr_count` 2, `merged_pr_count` 1과 두 세션의 비용 합을 보인다. 에이전트 GitHub 스위치를 끈 뒤에도 남은 열린 PR의 머지가 반영된다 |
| GA-5 리뷰용 App·리뷰 승인 | `github-apps/{role}` 경로와 화면의 리뷰용 App 영역, 리뷰용 forge, 작업 서비스의 리뷰와 세션 API, `review_pull_request` receipt, `no_reviewer_app` | route 테스트: `same_app`, `no_author_app`, 리뷰용 App 없을 때 `options.review.available: false`. 리뷰가 `commit_id`를 보낸다. 리뷰 토큰이 reviewer forge에서 나온다 | 리뷰용 App 등록(키는 경로만) → 작성용 App이 연 PR을 리뷰 승인 → GitHub에 `app/<리뷰용 App>` 승인. 리뷰 꺼진 릴리스는 `feature_off`. 리뷰용 App을 지운 뒤 `no_reviewer_app`. 필수 리뷰 1 브랜치 보호에서 승인이 조건을 채우는지 기록(결정 1의 위험 실측) |
| GA-6 워크스페이스 상한 화면 | 연결 화면의 App 권한 표·상한(API는 GA-2에 있다). 사용자 연결 영역(Client ID·콜백 URL·client secret)은 그 API를 만드는 GA-4가 같이 만든다(리드 결정 2026-10-30). 저장소별 설치 권한("설치 승인 대기")은 그 응답을 더하는 GA-5가 표에 더한다 | web 테스트(owner·admin만 바꾸고 member는 읽기 전용, `revision` 충돌 안내, 낮출 때 확인 대화 상자), 1440·390 캡처, ui-review | 화면에서 상한의 Actions를 끄면 GA-3에서 켠 에이전트의 dispatch가 거절되고, 다시 켜면 성공 |
| GA-7 내장 MCP `github` | 세션에 붙는 내장 MCP 서버, 도구 일곱 개, egress 허가 경로, 릴리스 기능에 따른 도구 노출. 첫 커밋 전에 이 문서 [3절](#github-작업-서비스와-두-입구)에 upstream·허가·도구 정책 절을 더한다 | 도구가 다른 세션 id를 받지 않는다(attempt 토큰으로 정함). 꺼진 기능의 도구는 목록에 없다. 입구 1과 같은 receipt. worker 환경에 GitHub 토큰이 없다(env·파일 검사) | Slack에서 시작한 세션의 에이전트가 도구로 push 요청 → 사람 승인 → 에이전트가 도구로 PR 열기. push 승인 꺼진 릴리스는 승인 없이 PR. 허용 목록 안 dispatch |

순서: GA-1 → GA-2 → (GA-3, GA-4, GA-6 병렬 가능) → GA-4b(GA-4 바로 뒤, 세션 상세의 PR 정보 영역을 같이 쓴다) → GA-5(GA-3 뒤, 탭의 리뷰 항목) → GA-7. GA-4b는 GA-2의 게이트에 purpose를 더하므로 GA-2 뒤여야 하고, GA-5·GA-7과는 겹치지 않는다. GA-3은 GA-2가 모든 replica에 올라간 뒤에 연다([5절](#5-기존-설치-이전)). 각 PR의 첫 커밋 전에 이 문서의 해당 절을 다시 읽고, 계약과 다르게 가야 하면 이 문서를 먼저 고친다.

### 오너만 할 수 있는 단계

1. **작성용 App 권한 추가**: GitHub > Settings > Developer settings > GitHub Apps > `werft-sandbox-agent` > Permissions & events. Repository permissions의 Actions·Checks·Issues·Workflows를 Read and write로 바꾸고 저장한다. 그 뒤 Install App > JeongJaeSoon > 바뀐 권한을 승인한다. GA-2 실측 전에 한다. Administration은 주지 않는다.
2. **리뷰용 App 만들기**: 같은 화면 > New GitHub App. 이름 예 `werft-sandbox-reviewer`, Webhook 끔, Repository permissions는 Contents Read-only, Pull requests Read and write, Metadata Read-only다. "Only on this account"로 만든다. Install App으로 `werft-sandbox` 하나에 설치하고 Generate a private key로 .pem을 받는다. 키 파일 경로만 카드에 알린다. GA-5 실측 전에 한다.
3. **사용자 연결용 OAuth 설정**: `werft-sandbox-agent` App 설정 > General. Callback URL에 verify 스택의 `<콘솔 주소>/settings/linked-accounts/github`를 더하고, "Expire user authorization tokens"는 그대로 둔다. Client secrets > Generate a new client secret으로 값을 만들어 콘솔의 사용자 계정 연결 칸에 직접 넣는다. GA-4 실측 전에 한다.
4. **werft-sandbox 준비**: `main`에 `.github/workflows/sandbox-dispatch.yml`과 `.github/workflows/sandbox-other.yml`을 둔다. 둘 다 `on: workflow_dispatch`이고 `echo` 한 줄짜리다. 하나는 허용 목록 안, 하나는 밖을 시험하는 데 쓴다. 브랜치 보호 `main`에 "Require a pull request before merging, Required approvals 1"을 켠다(GA-5의 위험 실측). GA-2 실측 전에 한다.

## 10. 세션 성과물

- 오너 원문(2026-10-30): "roi 측정관점에서 세션별 성과(결과물? 이라고 되어잇는거 같네)를 기록을 명확히 하도록 하고싶어 그 type 으로써 github 혹은 github_pullrequest? 같은거로 해서 링크가되엇든 이 세션에서는 이렇게 동작, 토큰을 사용해서 성과물로써 github 의 pr 이라는 카테고리를 놓아서 roi 를 파악할수 잇는 재로를 쓰도록 하는거지 다른 결과물 타입이 어떤게 잇을지는 아직 잘모르겟네".
- 목적: 세션 하나가 만든 것(성과물)을 type과 함께 DB에 남기고, 그 세션의 토큰·비용과 이어 "이 세션은 토큰 N, 비용 $X를 써서 PR 하나를 만들었고 그 PR이 머지됐다"를 셀 수 있게 한다. 이번에 채우는 type은 GitHub PR(`github_pull_request`) 하나다.
- 이 절의 `파일:줄`은 `origin/main` `3f4dd99d` 기준이다.

### 지금 있는 것

- **"결과물" 탭은 파일이다.** 세션 상세의 탭 하나가 "결과물"이다(`apps/web/src/routes/sessions.tsx:425-431`, 문구 `apps/web/src/i18n/outputs.ts:2`). 내용은 작업 공간 `out/` 폴더의 파일뿐이다(`outputs.ts:7`). API는 `GET /v1/sessions/{id}/outputs`(`apps/control-host/src/api/openapi.ts:1734-1739`)이고, 목록은 마지막으로 커밋된 checkpoint의 manifest에서 읽는다(`packages/platform/src/sessions/output-service.ts:42-44`, `packages/platform/src/checkpoints/checkpoint-service.ts:1278-1282`). `checkpoint_outputs`(`packages/db/src/schema.ts:1915-1934`)는 그 파일 객체의 크기 기록이다. type도 외부 링크도 없다. 일본어 문구는 이미 "成果物"다(`outputs.ts:11`).
- **PR은 행으로 남지만 읽는 곳이 없다.** `pull_requests`는 세션·URL을 키로 저장소 id, 번호, head, base, `open_pull_request` receipt를 가진다(`schema.ts:1213-1233`). PR을 열 때(`packages/platform/src/sessions/pull-request-service.ts:141-226`) 같은 트랜잭션에서 receipt와 함께 쓴다(`packages/db/src/pull-requests.ts:160-221`). 열린 PR을 GitHub에서 찾아 답한 경우도 행을 남긴다(`pull-request-service.ts:192-196`, `212-221`). push 요청을 잇기 전의 옛 행은 번호·push 요청이 비어 있고 공개 모양으로 읽지 못한다(`pull-requests.ts:18-30`).
- **PR의 상태는 모른다.** 행에 상태 칸이 없다. forge 포트의 PR은 `open`·`closed`만 알고 머지 여부가 없다(`packages/platform/src/ports/forge.ts:29-35`). 읽는 메서드는 열린 PR을 브랜치로 찾는 것 하나다(`forge.ts:50-54`, GitHub 구현 `apps/control-host/src/api/forge-github.ts:248-251`의 `state: "open"`). API에도 PR을 여는 `POST`와 코멘트뿐이고(`openapi.ts:2151`, `2189`) 세션의 PR 목록을 읽는 경로가 없다. 웹에도 PR을 보이는 화면이 없다.
- **세션의 토큰·비용은 세션 행에 있다.** `sessions.cost_usd`(추정 비용, `schema.ts:1013-1019`)와 `sessions.provider_tokens`(모든 토큰, `schema.ts:1021-1027`)다. 둘 다 egress proxy가 잰 호출마다 `provider_usage`(`schema.ts:2013`)에 쌓으면서 더한다. 모델별 합은 `session_model_usage`(`schema.ts:2083-2121`)이고, 그 trigger가 세션의 에이전트를 릴리스에서 복사한다(`packages/db/migrations/0169_usage_breakdown_rollup.sql:35-38`). 세션의 에이전트는 `sessions.agent_release_id`(`schema.ts:1009-1011`) → `agent_releases.agent_id`(`schema.ts:2851`)다. 세션 하나는 `GET /v1/sessions/{id}/usage`(`openapi.ts:1697-1700`), 기간 합은 `GET /v1/usage/summary`·`…/breakdown`(`openapi.ts:3886-3891`, `3971-3976`)이 읽는다. 에이전트별 묶음 query는 `packages/db/src/usage-reader.ts:136-146`이다.
- **GitHub 웹훅을 받는 곳이 없다.** control-host에 GitHub 이벤트를 받는 경로나 서명 검사가 없다. 오너가 만든 App도 Webhook을 끈 채다([오너 단계](#오너만-할-수-있는-단계) 2와 같은 설정).
- **주기 작업의 선례.** push 실행기는 API replica마다 하나씩 돌고 `FOR UPDATE SKIP LOCKED`로 서로의 행을 피한다(`packages/platform/src/sessions/push-executor.ts:197-218`, `packages/db/src/push-requests.ts:404-416`, 연결 `apps/control-host/src/api/server.ts:706`, `963`).

### 이름

화면의 "결과물"은 지금처럼 `out/` 파일이다. 새 개념은 **성과물**(영어 `outcome`, 일본어 "成果")이라 부른다. 데이터는 따로 두고, 화면은 같은 "결과물" 탭 안에 영역을 하나 더한다([아래](#세션-상세의-성과물)). 오너가 말한 "결과물"과 같은 자리에서 보이게 하려는 것이다.

### 데이터 모델: `session_outcomes` (새)

| 열 | 타입 | 규칙 |
|---|---|---|
| `id` | uuid PK | |
| `owner_id` | text NOT NULL | 세션의 owner |
| `session_id` | uuid NOT NULL FK sessions | 성과물을 만든 세션 |
| `agent_release_id` | text | 그 세션의 `agent_release_id`. 릴리스 없는 세션은 null |
| `agent_id` | uuid | 그 릴리스의 `agent_id`. 쓸 때 복사한다(`session_model_usage`와 같은 이유: 세션의 릴리스는 바뀌지 않고, 집계가 릴리스 표를 매번 잇지 않게 한다) |
| `type` | text NOT NULL | `CHECK (type IN ('github_pull_request'))`. 값은 contracts의 `SESSION_OUTCOME_TYPE_VALUES` 하나에 모은다 |
| `url` | text NOT NULL | 외부 링크. PR이면 `html_url` |
| `repository_id` | text | 카탈로그 저장소 id. 저장소와 상관없는 type은 null |
| `external_id` | text | 그 type 안의 식별자. PR이면 번호(문자열) |
| `state` | text NOT NULL | type별 값. PR은 `open`·`merged`·`closed`. `CHECK (type <> 'github_pull_request' OR state IN ('open', 'merged', 'closed'))` |
| `state_changed_at` | timestamptz NOT NULL | 마지막으로 state가 바뀐 때. 처음에는 `created_at` |
| `merged_at`, `closed_at` | timestamptz | GitHub가 준 값 그대로 |
| `state_checked_at` | timestamptz | 마지막으로 GitHub에 물어 답(성공이든 `check_error`든)을 받은 때. 아직 안 받았으면 null. 집을 때는 고치지 않는다 |
| `lease_token`, `lease_expires_at` | uuid, timestamptz | refresher가 이 행을 집었다는 표시. 결과를 쓸 때 지운다 |
| `check_error` | text | 마지막 조회가 실패한 `reason_code`(`not_found`·`forge_failed`·`github_refused`). 성공하면 null |
| `metadata` | jsonb NOT NULL DEFAULT `'{}'` | type별 모양. PR은 `{ head, base, adopted, merge_commit_sha, additions, deletions, changed_files, commits }`. 제목·본문·리뷰 내용은 넣지 않는다 |
| `receipt_id` | uuid FK receipts | 만든 작업의 receipt. PR은 `open_pull_request` receipt |
| `created_at` | timestamptz NOT NULL | |

- 제약: `UNIQUE (session_id, type, url)`. 상태 조회용 부분 인덱스 `(state_checked_at) WHERE type = 'github_pull_request' AND state <> 'merged'`.
- **type은 등록된 목록이다.** 열린 문자열로 두지 않는다. 집계가 type마다 state의 뜻(무엇이 "성공"인가)을 알아야 하기 때문이다. type을 더할 때는 마이그레이션 하나가 CHECK를 넓히고 contracts 값과 state 규칙을 더한다. `linked_accounts`의 provider CHECK(`schema.ts:766-769`)와 같은 방식이다.
- **`pull_requests`는 그대로 둔다.** 그 표는 push 요청과 PR을 잇는 기록이고 키가 `(session_id, url)`이다. 성과물 행은 같은 `(session_id, url)`과 같은 `receipt_id`를 가진다. 외래 키는 걸지 않는다. 성과물 표는 type이 여럿이 될 표라서다.
- **만드는 것은 서버뿐이다.** 성과물을 쓰는 API는 두지 않는다. 사람이나 에이전트가 성과물을 직접 적게 하면 ROI 재료가 자기 보고가 된다.
- 개정(2026-11-02): `metadata`의 "제목은 넣지 않는다"는 [성과 규칙 설계](achievement-rules.md#근거-추가-github_review)가 바꿨다. PR 행은 `title`(200자)을 갖고, 리뷰는 type `github_review` 행이 된다. 본문과 리뷰 내용은 여전히 넣지 않는다.
- 새 표이므로 앞 이미지와 섞여도 안전하다. 앞 이미지는 이 표를 읽지도 쓰지도 않는다([5절](#5-기존-설치-이전)의 규칙).

### PR을 열 때 자동으로 남긴다

- **경로.** `pull_requests` 행을 쓰는 `savePullRequest`(`pull-requests.ts:160-221`)의 같은 트랜잭션에서 성과물 행을 `ON CONFLICT (session_id, type, url) DO NOTHING`으로 넣는다. 넣는 것은 그 트랜잭션이 `pull_requests` 행을 처음 쓸 때(새 행이나 옛 행 채우기, `pull-requests.ts:205-218`)뿐이다. state `open`, `metadata`의 head·base·`adopted`, `receipt_id`는 그 행에 쓰는 `open_pull_request` receipt다. 이미 기록된 PR을 다시 답하는 호출은 새 receipt를 만들지만(`pull-requests.ts:176-192`, 서비스에서는 `pull-request-service.ts:161-180`이 먼저 답한다) 성과물은 건드리지 않는다. GA-2 뒤에 PR 열기는 GitHub 게이트를 지나는 PR 서비스(`pull-request-service.ts`) 하나이고, 세션 API와 내장 MCP의 `open_pull_request`(GA-7)가 모두 그 함수를 부른다([3절](#github-작업-서비스와-두-입구)). 그래서 입구가 늘어도 기록 지점은 하나다.
- **같은 PR을 다시 답할 때.** 세션의 push 요청은 브랜치 `agent/<session-id>` 하나를 같이 쓴다. 두 번째 push 요청의 PR 열기는 같은 URL을 돌려주므로 성과물은 하나로 남는다. 앞 PR이 닫힌 뒤 다시 열면 GitHub가 새 PR을 만들고(`pull-request-service.ts:192-205`) URL이 다르므로 성과물이 하나 더 생긴다.
- **기존 행과 섞인 기간.** 이 기능 전에 연 PR, 그리고 배포가 섞인 동안 앞 이미지가 연 PR은 성과물 행이 없다. 아래 상태 조회가 돌 때마다 `pull_requests`에서 `push_request_id`가 있는데 성과물이 없는 행을 찾아 같은 모양으로 만든다(state `open`, `receipt_id`는 그 `pull_requests` 행의 receipt, `metadata.adopted`는 알 수 없으므로 null, `state_checked_at` null이라 바로 읽힌다). 마이그레이션에서 한 번 채우는 방식은 섞인 기간의 행을 놓치므로 쓰지 않는다. push 요청이 없는 옛 행(번호 없음)은 만들지 않는다.
- **무엇이 성과물인가: 플랫폼의 PR 열기가 기록한 PR.** 성과물은 `pull_requests`에 남은 PR이다. 플랫폼이 만든 PR과, PR 열기가 GitHub에서 찾아 답한 열린 PR(`pull-request-service.ts:192-196`)이 둘 다 들어간다. 뒤의 것은 사람이 `agent/<session-id>` 브랜치로 먼저 연 PR일 수 있다. 그 브랜치의 commit은 이 세션이 만든 것이므로 성과물로 센다. 다만 구분할 수 있게 `metadata.adopted`에 둔다. 이 값은 `savePullRequest`의 `created`로 정하지 않는다. 서비스는 열린 PR을 찾지 못하면 `created: true`로 두는데(`pull-request-service.ts:192-196`), 그 사이 사람이 PR을 열었으면 forge의 생성 요청이 422를 받고 그 사람의 PR을 돌려주기 때문이다(`forge-github.ts:300-305`). 그래서 GA-4b는 `createPullRequest`가 실제로 만들었는지(`created`)를 forge 결과에 싣고, `adopted`는 "찾은 열린 PR을 답했거나 forge가 만들지 않았다"이다. 상태 조회가 채우는 행([위](#pr을-열-때-자동으로-남긴다))은 알 수 없으므로 null이다. PR 열기를 한 번도 부르지 않은 PR은 성과물이 아니다([LATER](#later)).

### PR 상태 갱신: 조회로 한다

**추천과 기본값: 주기 조회(polling).** 웹훅은 이번에 쓰지 않는다.

- **웹훅을 쓰려면 필요한 것.** 오너가 App 설정에서 Webhook을 켜고 URL과 webhook secret을 넣어야 한다(밖에 보이는 설정 변경, 오너만 할 수 있다). control-host에 GitHub가 닿는 공개 경로, 서명(`X-Hub-Signature-256`) 검사, secret 보관, 놓친 이벤트를 다시 맞추는 조회가 새로 필요하다. verify 스택은 로컬이라 GitHub가 닿지 않으므로 werft-sandbox 실측에 터널도 필요하다. 웹훅을 켜도 놓친 이벤트 때문에 조회는 남는다. 그래서 조회만으로 시작하고, 웹훅은 조회의 비용이나 지연이 문제가 될 때 더한다([LATER](#later)).
- **Webhook을 끈 지금의 뜻.** GitHub는 플랫폼에 아무것도 알려 주지 않는다. 머지·닫힘은 플랫폼이 다음에 물어볼 때까지 보이지 않는다. 그래서 성과물 state는 늘 "`state_checked_at` 시점의 값"이고, API와 화면은 그 시각을 같이 보인다.
- **도는 곳.** API replica마다 하나씩 도는 `outcome-refresher`. push 실행기와 같은 모양(`push-executor.ts:197-218`)이고 1분마다 돈다. 집는 방식도 push 실행기의 claim(`push-requests.ts:404-416`)처럼 DB 잠금을 GitHub 호출 동안 쥐지 않는다. 한 문장의 `UPDATE … SET lease_token = <새 uuid>, lease_expires_at = now() + interval '2 minutes' WHERE id IN (SELECT … WHERE <읽을 때가 됨> AND (lease_expires_at IS NULL OR lease_expires_at < now()) ORDER BY state_checked_at NULLS FIRST LIMIT 50 FOR UPDATE SKIP LOCKED) RETURNING …`로 행을 집는다. `state_checked_at`은 집을 때 고치지 않으므로 화면의 "상태 확인" 시각은 실제로 답을 받은 때다. GitHub 호출은 트랜잭션 밖에서 하고, 결과는 `WHERE id = $1 AND lease_token = $2`로 행마다 따로 쓰며 같은 문장에서 lease를 지운다. lease가 만료돼 다른 refresher가 다시 집은 행에 늦게 온 앞 결과는 0행으로 끝나고 버린다. push 실행기가 `push_attempts`로 늦은 결과를 막는 것(`push-requests.ts:434-443`)과 같다. replica가 죽으면 그 행은 lease 만료(2분) 뒤 다시 집힌다.
- **누구를 언제 읽나.** `state_checked_at`이 null이거나 아래 간격보다 오래된 행만 읽는다.

| state | 다시 읽는 간격 | 그만 읽는 때 |
|---|---|---|
| `open` | 만든 지 1일 안이면 5분, 30일 안이면 1시간, 그 뒤는 1일 | 없음(열려 있는 동안) |
| `closed` | 1일(다시 열릴 수 있다) | `closed_at` 뒤 30일 |
| `merged` | 읽지 않는다 | 머지는 끝 상태다 |

- **무엇을 부르나.** `GET /repos/{o}/{r}/pulls/{number}` 하나다. `merged_at`이 있으면 `merged`, `state: closed`이면 `closed`, 아니면 `open`이다. forge 포트에 `getPullRequest(repo, number)`를 더하고 `ForgePullRequest`에 `merged_at`·`closed_at`과 metadata 칸을 더한다. 값이 바뀌었을 때만 state와 `state_changed_at`을 고친다.
- **토큰.** 게이트에 purpose `outcome_refresh`를 더한다. 권한은 `pull_requests: read` 하나, 연결은 author다([작업별 권한](#작업별-권한)). 이것은 에이전트의 작업이 아니라 플랫폼이 이미 연 PR의 상태를 읽는 것이다. 그래서 게이트 1단계(세션·릴리스 읽기)와 저장소 binding 검사, 6~8단계만 하고, 에이전트 스위치(2단계), 릴리스의 저장소 범위(3단계의 범위 검사), 기능·상한(4단계), 허용 목록(5단계)은 보지 않는다. 에이전트의 GitHub를 끄거나 범위를 좁혀도 그 에이전트가 앞서 연 PR의 머지는 ROI 기록에 남아야 하기 때문이다. App 토큰은 control-host 밖으로 나가지 않고 읽기 권한뿐이며 플랫폼이 고른 PR 하나만 읽으므로, [결정 7](#결정-7-릴리스와의-관계)의 "끄면 에이전트의 작업은 멈춘다"는 그대로다. GHES 카탈로그 App 저장소도 읽는다([3절](#github-게이트)). PAT 저장소는 PAT로 읽는다. PAT는 좁힐 수 없으므로 자격 증명은 그대로이고, 읽기로 제한되는 것은 플랫폼이 부르는 호출(`GET …/pulls/{n}`)뿐이다. receipt의 actor는 null이다(push 실행기와 같다. [GA-4b에서 정한 것](#ga-4b에서-정한-것)). `mint_github_token`은 새로 발급했을 때만 남는다. 캐시(`forge-github.ts:152-177`)는 replica의 메모리에 연결·저장소·권한 조합별로 있고 토큰은 만료 10분 전에 다시 받으므로(`forge-github.ts:28`), receipt는 replica·저장소마다 대략 50분에 하나다.
- **실패.** 404(PR·저장소가 사라졌거나 App 설치가 빠짐)는 `not_found`, 그 밖의 GitHub 오류는 `forge_failed`, 게이트 거절은 `github_refused`로 `check_error`에 두고 state는 그대로 둔다. `state_checked_at`은 고쳐서 같은 간격으로 다시 읽는다. 오류 원문은 [결정 0](#결정-0-github가-강제하는-것은-다시-책임지지-않는다)대로 남기지 않는다.
- **요청량.** 위 간격이면 PR 하나가 시간당 쓰는 요청은 만든 지 1일 안이 12회, 1~30일이 1회, 30일 넘은 `open`과 `closed`가 1/24회다. 그래서 간격대로 다 읽으면 시간당 요청은 대략 12 × (최근 1일에 연 열린 PR) + (1~30일 된 열린 PR) + (나머지 읽을 행) / 24다. 하루 300개를 열고 대부분 하루 안에 머지하면 시간당 3600회 남짓이다. 하루 300개가 30일씩 열려 있으면 12 × 300 + 29 × 300 = 12300회로, 간격대로는 읽을 수 없다. 그래서 아래 예산이 간격보다 앞선다.
- **예산과 멈춤.** GitHub REST 한도는 한도의 주인마다 따로다. App 설치 토큰은 설치마다(설치 규모에 따라 시간당 5000부터 늘어난다), PAT는 그 PAT의 사용자 전체가 같이 쓴다. GraphQL 한도와는 따로다. refresher는 한도 단위를 `quota_key`로 묶고, 그 단위에서 자기가 쓰는 양만 제한한다.
  - `quota_key`는 성과물 행에 두지 않는다. 자격 증명은 바뀔 수 있기 때문이다(콘솔 App 교체, 카탈로그의 PAT 교체). refresher는 pass마다, 읽을 때가 된 행의 `repository_id`별로 **이번 요청에 실제로 쓸 자격 증명**에서 키를 정한다. App이면 `app:<api_base>:<installation_id>`, PAT면 `pat:<api_base>:<그 PAT로 부른 GET /user의 숫자 id>`다. `GET /user` 결과는 그 자격 증명 값의 해시를 키로 메모리에 두므로 PAT를 바꾸면 다시 부른다. 이 요청은 키를 알기 전에 보내므로 **예산 밖**이다. 대신 replica마다 자격 증명 하나에 1시간에 한 번까지만 보낸다(성공은 PAT가 바뀔 때까지 두고, 실패하면 1시간 동안 그 PAT 저장소의 행을 집지 않는다). 그래서 예산 밖 요청은 replica 수 × PAT 수 / 시간을 넘지 않는다. 같은 설치나 같은 사용자의 PAT를 쓰는 저장소·연결·replica는 같은 키를 쓴다.
  - 예산과 멈춤은 replica가 같이 보는 표 `outcome_refresh_quotas`에 단위마다 한 행으로 둔다: `quota_key` PK, `rate_limit`(마지막으로 본 `x-ratelimit-limit`, 처음 보기 전에는 null), `window_start`, `used`, `paused_until`.
  - 시간당 예산은 `rate_limit`의 20%(null이면 1000)다. 행 하나를 집는 것이 요청 하나다. 그래서 refresher의 조회는 지금 forge client의 자동 재시도·throttle 대기(`forge-github.ts:104-118`)를 끄고 한 번만 보낸다. 실패는 아래 "실패"대로 다음 간격에 다시 읽는다. 집기는 단위별로 한 트랜잭션에서 한다. 그 단위의 `outcome_refresh_quotas` 행을 `FOR UPDATE`로 잠그고(없으면 만든다), `window_start`가 1시간보다 오래됐으면 `window_start = now()`, `used = 0`으로 되돌린다. `paused_until`이 지나지 않았으면 집지 않는다. 남은 몫(예산 − `used`)과 50 가운데 작은 수만큼, 이 pass에서 그 키로 정해진 저장소들의 성과물 행을 집고, 집은 수를 `used`에 더한 뒤 커밋한다. 단위의 행 잠금이 확인과 차감을 직렬로 만들므로 replica가 여럿이어도 한 창에서 예산을 넘겨 집지 않는다. 같은 행을 5분마다 다시 읽어도 읽을 때마다 `used`가 는다. 예산을 넘는 행은 `state_checked_at` 오래된 순으로 밀려 늦게 읽힌다. 창은 고정 1시간이라 창 경계 앞뒤를 합치면 1시간 안에 예산의 두 배까지 쓸 수 있다.
  - 응답의 `x-ratelimit-remaining`이 limit의 20% 아래이거나 rate limit 응답(403·429)을 받으면, 그 단위의 `paused_until`을 `x-ratelimit-reset`(또는 `retry-after`)으로 둔다. 이미 집어 나간 요청은 막지 못한다. 그 수는 replica마다 한 pass의 최대 50이므로 단위 전체로는 replica 수 × 50까지다(이것도 이미 `used`에 들어 있어 예산은 넘지 않는다).
  - 보장 범위: 예산이 세는 것은 집은 행, 곧 PR 조회 수다. 그 밖에 refresher가 보내는 요청(PAT 사용자를 확인하는 `GET /user`(위의 상한), App 설치 토큰 발급과 설치 조회, 실패를 가르는 설치 여부 확인)은 세지 않는다. 설치 토큰은 만료 전까지 캐시돼 다시 받지 않는다. 그래서 refresher가 한 단위에서 시간당 보내는 PR 조회는 예산을 넘지 않고, 그 단위가 바닥나 가면 멈춘다. 다른 작업(에이전트의 clone·push·PR, PAT 사용자의 다른 호출)의 몫을 따로 떼어 두지는 않는다. 그 작업들이 한도를 다 쓰면 refresher도 멈춘다.
  - 밀리거나 멈춘 행은 state와 `check_error`를 바꾸지 않고 늦게 읽힐 뿐이다. 화면은 `state_checked_at`으로 그 늦음을 보인다.

### ROI 재료: 집계 query

화면(대시보드)은 이번에 만들지 않는다. 같은 기간·범위 규칙으로 읽는 API 하나와 그 query 모양만 정한다.

- **세션 단위로 먼저 접는다.** 세션 하나에 성과물이 여럿일 수 있으므로, 성과물을 세션별로 센 뒤 세션에 잇는다. 그래야 세션 비용이 두 번 더해지지 않는다.

```sql
-- sketch: one row per agent plus the total, over the sessions
-- GET /v1/usage/summary would count for the same scope and period
WITH s AS (
  SELECT s.id, ar.agent_id, s.cost_usd, s.provider_tokens
  FROM sessions s
  LEFT JOIN agent_releases ar ON ar.id = s.agent_release_id
  WHERE <summary period on s.created_at> AND <summary scope predicate>
), o AS (
  SELECT session_id,
         count(*) AS prs,
         count(*) FILTER (WHERE state = 'merged') AS merged,
         count(*) FILTER (WHERE state = 'closed') AS closed
  FROM session_outcomes
  WHERE type = 'github_pull_request' AND session_id IN (SELECT id FROM s)
  GROUP BY session_id
)
SELECT s.agent_id,
       grouping(s.agent_id) = 1 AS total,
       count(*) AS session_count,
       coalesce(sum(s.cost_usd), 0) AS cost_usd,
       coalesce(sum(s.provider_tokens), 0) AS token_count,
       count(*) FILTER (WHERE o.prs > 0) AS sessions_with_pr,
       count(*) FILTER (WHERE o.merged > 0) AS sessions_with_merged_pr,
       coalesce(sum(o.prs), 0) AS pr_count,
       coalesce(sum(o.merged), 0) AS merged_pr_count,
       coalesce(sum(o.closed), 0) AS closed_pr_count,
       coalesce(sum(s.cost_usd) FILTER (WHERE o.merged > 0), 0)
         AS cost_of_merged_sessions_usd
FROM s LEFT JOIN o ON o.session_id = s.id
GROUP BY GROUPING SETS ((s.agent_id), ());
```

- 세션이 하나도 없는 기간도 `()` 묶음이 합계 행 하나를 내고, 합은 모두 0이다(summary가 빈 기간에 0을 주는 것과 같다).

- **API.** `GET /v1/usage/outcomes`. `scope`·`since`·`until`·`agent_id`와 누가 어느 범위를 읽는지는 `GET /v1/usage/summary`와 똑같다(`openapi.ts:3886-3891`). `group_by=agent`면 에이전트별 행을 더한다. 응답은 위 칸에 `cost_per_merged_pr_usd`(`cost_usd / merged_pr_count`, 0이면 null)와 `cost_complete`(summary와 같은 뜻), `refreshed_at`을 더한다. `cost_per_merged_pr_usd`의 분자는 **기간의 모든 세션** 비용이다. 성과물이 없는 세션의 비용도 그 PR들을 얻는 데 든 비용이기 때문이다. 머지된 세션만의 비용은 `cost_of_merged_sessions_usd`로 따로 준다. 아무것도 바꾸지 않는다.
- **읽는 법.** 기간은 세션을 만든 때로 자른다(summary와 같다). 그래서 기간 뒤에 머지된 PR도 그 세션의 기간에 들어가고, 같은 기간을 나중에 다시 읽으면 `merged_pr_count`가 늘 수 있다. state는 각 행의 `state_checked_at` 시점 값이다. `unmetered` 세션은 비용이 0이므로 토큰 수를 같이 본다.

### 세션 상세의 성과물

- "결과물" 탭(`sessions.tsx:425-431`) 위쪽에 "GitHub PR" 영역을 더한다. [7절](#세션-상세)의 "PR 정보 영역"이 이 자리다. 행마다 `<저장소>#<번호>` 링크, state 배지(열림·머지됨·닫힘), 머지·닫힌 시각, "상태 확인 <상대 시각>"(`state_checked_at`), `check_error`가 있으면 그 이유 한 줄을 보인다. 영역 아래에 이 세션의 토큰 수와 추정 비용 한 줄을 `GET /v1/sessions/{id}/usage`의 값으로 보인다. 그 아래가 지금의 `out/` 파일 목록이다.
- 탭의 수는 PR 수와 파일 수의 합이다. 둘 다 없으면 지금의 빈 안내를 쓴다. 빈 안내 문구(`outputs.ts:7`)는 "PR과 out/ 폴더의 파일"을 세는 것으로 고친다.
- API는 `GET /v1/sessions/{id}/outcomes`(`session.read`)다. `{ items: [{ id, type, url, repository_id, external_id, state, state_changed_at, merged_at, closed_at, state_checked_at, check_error, metadata, created_at }] }`, 만든 순서. 아무것도 바꾸지 않는다.
- i18n ko·en·ja를 같이 고친다. 일본어 "成果物"는 지금 파일 탭의 이름이므로 PR 영역 제목은 "GitHub PR"로 둔다.

### GA-4b에서 정한 것

- **게이트 거절 이유는 GA-4b가 보인다(리드 결정, GA-3에서 옮김).** `GET /v1/sessions/{id}/github/refusals`(`session.read`)가 그 세션의 실패한 게이트 receipt(`mint_github_token`·`dispatch_workflow`·`rerun_workflow`·`review_pull_request` 가운데 `result.reason_code`가 있는 것) 최근 10개를 최근 것부터 준다. 칸은 `receipt_id`, `operation`, `purpose`(게이트 receipt가 늘 남기는 작업의 purpose), `reason_code`, `created_at`이다. `reason_code`와 `purpose`가 contracts 값 밖인 행은 10개를 고르기 전에 빼므로, 다른 판이 쓴 행이 아는 거절을 밀어내지 않는다. 화면은 "결과물" 탭의 GitHub PR 영역 아래에 이유와 시각을 한 줄씩 보인다. 조회는 `receipts_owner_created_at_idx`로 owner의 최근 receipt부터 거른다. 새 인덱스는 만들지 않았다.
- **refresher receipt의 actor는 null이다.** receipt actor의 `principal.kind`는 `api_key`·`user`·`installation`뿐이고 `service`가 없다(`packages/contracts/src/musterrolle/authorization.ts:71-76`). 위 10절의 `{ kind: "service", id: "outcome-refresher" }`를 쓰려면 principal 계약을 넓혀야 하므로, push 실행기처럼 actor null(`GitHubWork.actor`)로 남긴다. receipt의 `purpose: outcome_refresh`가 누가 했는지를 대신 말한다.
- **`quota_key`는 연결이 정한다.** `GitHubConnection.quotaKey(repo)`. App은 `app:<api_base>:<installation_id>`이고, 설치 id는 토큰 발급과 같은 경로로 찾는다. PAT는 `pat:<api_base>:<GET /user의 id>`이고, 결과는 `sha256(api_base, PAT)`를 키로 프로세스 메모리에 둔다. `GET /user`가 실패하면 그 자격 증명은 1시간 동안 다시 묻지 않고, 그 동안 그 저장소들의 행은 집지 않는다.
- **조회 client는 따로 둔다.** `GitHubApi.getPullRequest(number)`는 자동 재시도·throttle이 없는 Octokit으로 한 번만 보내고, 성공이든 실패(`GitHubCallError.rateLimit`)든 응답의 `x-ratelimit-*`·`retry-after`를 돌려준다. 로그에는 status와 request id만 남긴다.
- **`created`의 뜻.** forge `createPullRequest`가 `{ …, created }`를 돌려준다. 만들면 true, 422로 열린 PR을 찾아 돌려주면 false다. PR 서비스의 `created`는 이제 "forge가 실제로 만들었다"이고 찾은 열린 PR을 답하면 false다. 그래서 `open_pull_request` receipt의 `created`도 422 경로에서 false가 되고, 그 경우에도 열린 PR을 답할 때처럼 본문 꼬리를 고친다. 성과물의 `metadata.adopted`는 `!created`다.
- **채워 넣는 행.** 성과물이 없는 `pull_requests` 행에서 만든 성과물은 `created_at`을 그 `pull_requests` 행의 `created_at`으로 둔다(간격 표의 "만든 지"가 실제 PR 나이를 따른다). pass마다 500행까지 채운다.
- **집기와 결과.** 임대는 2분, 단위마다 한 번에 50행까지다. 결과는 `WHERE id AND lease_token`으로만 쓰므로 임대가 끝난 뒤 늦게 온 답은 아무것도 바꾸지 않는다. rate limit 응답(429, 또는 `x-ratelimit-remaining: 0`이나 `retry-after`가 있는 403)은 `check_error`로 남기지 않고 임대만 풀며(`state_checked_at` 그대로), 그 단위에서 이번 pass에 집은 나머지 행도 읽지 않고 푼다. 게이트가 null(GitHub 저장소가 아님)을 주면 같은 방식으로 푼다.
- **읽을 수 없는 저장소의 행.** 연결이 없으면(App이나 PAT가 그 저장소를 맡지 않음) 행에 `github_refused`를 쓴다. App의 설치 조회가 실패해 단위를 정하지 못하면 App 자신의 JWT로 설치 여부를 물어, 설치가 없으면 `not_found`, 그 밖이면 `forge_failed`를 쓴다. 이 둘은 행을 집지 않으므로 예산을 쓰지 않는다. 설치 id가 카탈로그에 고정됐거나 캐시돼 단위는 정해졌는데 토큰 발급이 실패하면 같은 방법으로 `not_found`·`forge_failed`를 가른다. 이때는 이미 집은 행이고 토큰 요청도 GitHub에 갔으므로 집을 때 더한 몫은 그대로 둔다(행 하나가 요청 하나). 어느 경우든 state는 그대로 두고 `state_checked_at`만 고쳐 같은 간격으로 다시 본다. 이렇게 쓸 때 만료된 임대도 지우므로, 그 임대를 쥐었던 replica의 늦은 답은 이 확인을 덮지 않는다. pass마다 오류 종류별로 50행까지다. `GET /user`가 실패한 PAT는 위 규칙대로 1시간 동안 그 저장소의 행을 집지도 쓰지도 않는다. 카탈로그에서 빠진 저장소의 행은 건드리지 않는다.
- **임대 안에서만 읽는다.** 임대 시간(2분)은 집기를 부르기 직전의 시각부터 센다. DB의 임대는 그 트랜잭션이 시작한 뒤부터라 이 시각보다 늦게 끝난다. 집은 행을 차례로 읽다가 이 시간이 지나면 남은 행은 읽지 않고 임대만 풀고, 게이트 발급이나 단위 확인이 느려 그사이 지났으면 PR 조회를 보내지 않는다. 그사이 다른 replica가 다시 집었을 수 있어서다. 단위는 게이트가 발급한 grant의 연결, 곧 PR 조회가 실제로 쓸 자격 증명에서 다시 정한다. 그 단위가 집을 때의 단위와 다르면(App 교체, 설치 이동) 조회하지 않고 임대만 풀어 다음 pass에서 새 단위로 집는다. 집을 때 `used`에 더한 몫은 돌려주지 않는다.
- **결과물 탭은 1분마다 다시 읽는다.** PR 상태는 세션이 멈춘 뒤에도 GitHub에서 바뀌고 세션 이벤트가 없으므로, 탭이 열린 동안 성과물과 거절 목록을 refresher 주기와 같은 60초마다 다시 읽는다.
- **`GET /v1/usage/outcomes`.** `group_by`는 `agent`만 받고, `scope=agent`와 같이 쓰면 400이다(summary의 규칙). `cost_per_merged_pr_usd`는 SQL에서 소수 6자리로 반올림한다. 행이 없는 기간의 합계 행은 모두 0이고 `cost_per_merged_pr_usd`는 null이다.

## 대안

설계는 두 후보를 놓고 골랐다. 이 카드의 모델 호출 제한으로 후보는 카드가 직접 썼다(architect의 단일 시스템 예외).

- **B: 가변 설정 테이블 + 프록시 강제.** `agent_github_settings`를 가변 행으로 두고 변경 이력을 별도 테이블에 쌓는다. worker가 GitHub REST를 egress proxy로 직접 부르고, proxy가 경로·메서드로 허용 목록을 거른 뒤 토큰을 붙인다. 고르지 않은 이유는 셋이다. (1) 결정 7의 "보안 값은 릴리스에 넣어 이력"을 따로 만든 이력 테이블로 다시 구현하게 된다. (2) proxy가 GitHub REST 경로 문법을 알아야 한다. rerun처럼 대상 워크플로를 GitHub에 물어봐야 판정할 수 있는 요청도 있다. (3) worker 쪽에 GitHub API 전체로 가는 통로가 생긴다. 지금의 "토큰은 control-host 밖으로 나가지 않는다"(검토 문서 1절)가 깨진다.
- **A(고름): 릴리스 핀 + control-host 게이트.** 보안 값은 릴리스의 입력으로 받아 `policy_pins`에 고정하고, 즉시 값은 Slack의 `slack_mention_only`처럼 행의 열로 둔다. 모든 발급이 게이트 하나를 지나므로 새 작업을 더할 때 "이 파일만 보고 맞게 고치면 전체가 맞는" 지점이 하나다.
- **상한을 실행 프로필에 두기.** 검토 문서 3절은 권한 등급을 설치 상한 프로필에 두자고 제안했다. 오너는 결정 9에서 워크스페이스 GitHub 연결 설정에 두기로 정했다. 프로필은 모델·도구·권한 모드를 다루고, GitHub 연결 설정은 워크스페이스에 하나뿐이라 그쪽이 사람에게 찾기 쉽다.
- **App 연결마다 상한(결정 11의 2에서 버림).** 같은 역할의 App마다 다른 상한을 둘 수 있지만, 에이전트가 켠 기능이 저장소마다 다르게 막혀 사람이 이유를 찾기 어렵다. App마다 다른 것은 App·설치 권한으로 이미 드러나고 발급 요청이 판정한다.
- **설치 account마다 App 하나(결정 11의 1에서 버림).** 등록할 때 같은 account에 설치된 App 둘을 막으면 실행 때 App이 하나로 정해질 것처럼 보이지만, 등록 뒤의 설치·저장소 이전·동시 등록·조회 실패는 막지 못한다(Codex 2차). 저장소 고정은 실행 때 정하고 그 결과를 남긴다.
- **릴리스에 역할별 연결 id(결정 11의 1에서 버림).** Codex 1차 의견이다. 한 에이전트가 저장소마다 다른 App을 써야 하면 릴리스의 연결 하나로는 모자라고, 연결을 바꿀 때마다 새 릴리스가 생긴다.
- **사용자 연결에 별도 OAuth App.** client를 작성용 App과 떼어 둘 수 있지만, 오너가 App을 하나 더 만들고 관리해야 한다. GitHub App의 사용자 인증으로 `GET /user` 하나면 충분하므로 고르지 않았다. 작성용 App을 교체하면 콜백 URL과 client secret을 다시 넣는다.

## LATER

- **자기 PR 승인 거절 옵션**(리드 결정으로 이번에 넣지 않음). 다시 볼 조건: 결정 1의 위험이 실제 저장소에서 필수 리뷰를 우회한 사례가 나오거나, 오너가 GitHub 쪽 설정만으로 부족하다고 판단할 때. 모양은 리뷰 요청의 PR이 같은 에이전트의 세션에서 열렸으면 `409` `reason_code: own_pull_request`다.
- **dispatch 입력값별 제한**([결정 4](#결정-4-actions-허용-목록)). 허용 목록 항목에 입력 이름별 허용 값이나 패턴을 더하는 것이다. 다시 볼 조건: 입력값으로 ref나 스크립트를 고르는 워크플로를 허용 목록에 넣어야 할 때.
- **push·PR로 시작된 run의 rerun.** 지금은 플랫폼이 dispatch한 run만 rerun한다. 다시 볼 조건: GitHub run 응답이 원래 ref의 전체 이름(`refs/heads/…`)을 주게 되거나, 에이전트가 PR 검사의 재실행을 해야 하는 요청이 나올 때.
- **checks·issues 작업.** 칸과 판정만 만든다([작업별 권한](#작업별-권한)). 다시 볼 조건: 에이전트가 check run이나 issue를 써야 하는 요청이 나올 때.
- **login 변경 뒤 옛 noreply 이메일의 귀속.** 다시 볼 조건: 연결한 사람이 GitHub login을 바꾼 뒤 그 전 commit의 공동 작성자 표시가 사라졌다는 보고가 나올 때.
- **rate limit 사용량 화면.** 브리프의 범위 밖이다. 다시 볼 조건: 에이전트 여럿이 App 하나를 함께 쓸 때.
- **merge 권한.** 범위 밖이다. "플랫폼 머지 요청 기능"으로 따로 검토한다.
- **성과물의 다른 type**([10절](#10-세션-성과물)). 후보는 Slack 답변(세션이 스레드에 남긴 답과 그 반응), 파일·문서(`out/`의 파일이나 외부 문서 링크), GitHub issue(GA의 `issues` 작업이 생기면), 그리고 리뷰(`review_pull_request`), dispatch한 run이다. 다시 볼 조건: 오너가 PR 밖에서 세고 싶은 결과를 정할 때. 더할 때는 type마다 state와 "성공"의 뜻을 먼저 정한다.
- **GitHub 웹훅으로 PR 상태 받기**([10절](#pr-상태-갱신-조회로-한다)). 오너가 App의 Webhook을 켜고 URL·secret을 넣어야 한다. 다시 볼 조건: 열린 PR이 많아 조회가 설치의 REST 한도를 눈에 띄게 쓰거나, 머지 반영이 5분보다 빨라야 한다는 요청이 나올 때.
- **PR 열기를 부르지 않은 PR을 성과물로.** 사람이 `agent/<session-id>` 브랜치로 직접 열고 플랫폼의 PR 열기가 한 번도 답하지 않은 PR이다. 다시 볼 조건: 그런 PR이 실제로 생겨 ROI에서 빠진다는 보고가 나올 때.
- **성과물 대시보드.** API(`GET /v1/usage/outcomes`)만 만든다. 다시 볼 조건: 오너가 사용량 화면에서 ROI를 보고 싶어 할 때.
- **GHES.** 범위 밖이다. 콘솔 App은 github.com만 쓴다(#922). 카탈로그 App의 GHES 저장소는 게이트의 기본 작업(`clone`·`push`·`pull_request`)과 `outcome_refresh`만 받고 나머지는 `github_host_unsupported`다([3절](#3-토큰-발급-경로와-좁히기)).
