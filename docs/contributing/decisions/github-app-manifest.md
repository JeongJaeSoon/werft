# 결정: 작성용 GitHub App을 콘솔에서 manifest로 만든다

- 상태: 결정됨. 구현은 이 문서를 따른다.
- 출처: GitHub 연결 설정 재구성 시안 v2 A절. 오너가 정할 것 3(새 App은 비공개 기본, 만들 때 공개 선택)은 추천안을 채택했다(2026-11-01).
- 관련: [저장소 카탈로그 DB](repository-catalog-db.md), [GitHub 에이전트 연결](github-agent.md).

## 1. 무엇을 골랐나

GitHub 연결 설정에 '새 App 만들기'를 주 버튼으로 둔다. '이미 있는 App 추가'(App ID와 .pem)는 보조 경로로 남긴다. 새 App은 GitHub의 [manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)로 만든다. 관리자는 GitHub에서 Create를 한 번 누른다. 그러면 콘솔이 App ID, 개인 키, client secret을 받아 저장한다. 사람이 키 파일을 내려받거나 붙여 넣는 일은 없다.

- 작성용 App(author)만 만든다. 리뷰 승인용 App은 지금처럼 '고급'에서 '이미 있는 App 추가'로만 등록한다.
- github.com만 지원한다. GitHub Enterprise Server는 LATER다.

## 2. 흐름

| 단계 | 누가 | 무엇 |
|---|---|---|
| 1 | 관리자 | 콘솔에서 소유할 곳(조직 login 또는 내 개인 계정)과 범위(비공개 기본, 공개 선택)를 고른다. Actions·워크플로 권한을 넣을지도 고른다(기본 끔) |
| 2 | 콘솔 → API | `POST /v1/workspaces/{id}/github-apps/author/manifest`. 서버가 manifest와 state를 만들어 돌려준다 |
| 3 | 브라우저 | 숨은 form으로 GitHub(`https://github.com/organizations/{org}/settings/apps/new?state=…` 또는 `https://github.com/settings/apps/new?state=…`)에 `manifest`를 POST한다 |
| 4 | 관리자 | GitHub에서 이름을 확인하고 Create를 누른다 |
| 5 | GitHub → 브라우저 | `redirect_url`(콘솔 화면 `/settings/workspace/integrations/github/new-app`)로 `code`와 `state`를 붙여 보낸다 |
| 6 | 콘솔 → API | `POST /v1/workspaces/{id}/github-apps/author/manifest/complete` `{ code, state }`. 서버가 state를 검사하고 소모한 뒤 `POST /app-manifests/{code}/conversions`를 부르고, 결과를 한 트랜잭션에 저장한다 |
| 7 | 콘솔 | 응답의 설치 주소(`{html_url}/installations/new`)로 보낸다. 설치를 마치면 GitHub가 `setup_url`(설정 › 연동 › GitHub)로 돌려보낸다 |

- 시작 요청 본문: `owner`(`{ kind: "organization", login }` 또는 `{ kind: "user" }`), `public`(기본 false), `actions`(기본 false), `replace`(기본 false). 응답: `action_url`(state를 붙인 GitHub 주소), `manifest`(form에 넣을 JSON 문자열), `expires_at`.
- 완료 응답: `github_app`(GET과 같은 모양), `install_url`, `receipt_id`.
- 시안은 `redirect_url`을 API 경로로 적었다. 여기서는 Slack 앱 설치 콜백과 같은 방식으로 콘솔 화면이 받는다. 화면이 세션 cookie와 CSRF 헤더를 붙여 API에 보낸다. 콜백 GET이 API에 직접 오면 cookie만으로 쓰기가 일어나는데, 그 형태는 이 API의 쓰기 규칙(CSRF 헤더 필수)과 맞지 않는다.
- code는 GitHub 기준 1시간 안에 교환해야 한다. state도 1시간 뒤 만료된다.

## 3. state

- 32바이트 난수를 base64url로 만든다. 저장은 SHA-256 해시로만 하고, 원문은 응답 한 번에만 나간다.
- 새 표 `github_app_manifest_states`: `state_hash`(PK), `workspace_id`, `actor_user_id`, `role`(지금은 `author`만), `owner_login`(null이면 개인 계정), `public`, `replaces_app_id`(시작할 때 있던 App, 없으면 null), `expires_at`, `created_at`.
- complete가 먼저 행을 지우면서 읽는다(`DELETE … RETURNING`). 그래서 같은 state는 한 번만 쓰인다. 검사가 실패해도 그 state는 다시 쓸 수 없다.
- 검사: 행이 있고, 만료 전이고, 요청한 워크스페이스와 사람이 같다. 그 사람은 아직 `workspace.manage`를 가진다(저장 트랜잭션 안에서 잠금 아래 다시 본다). 거절은 400 `BAD_REQUEST`이고 `reason_code`는 `state_invalid`다. 어느 검사에 걸렸는지는 응답에 넣지 않고 로그에만 남긴다.
- 만료된 행은 시작 요청 때 함께 지운다. 따로 도는 청소 작업은 없다.

## 4. 저장

교환 응답의 `id`, `slug`, `name`, `html_url`, `owner`, `permissions`, `client_id`, `client_secret`, `pem`을 한 트랜잭션에 넣는다.

- `github_apps` 행: 지금의 `put`과 같다. 키는 secret 저장소에 봉인한다.
- client secret: 구성원 계정 연결(`putClientSecret`)과 같은 슬롯에 넣는다. 그래서 '구성원 GitHub 계정 연결'의 client secret 입력 단계가 사라진다.
- receipt는 '이미 있는 App 추가'와 같은 `set_github_app`이다. `result`에 `source: "manifest"`, 소유 계정, 공개 여부를 더한다. 비밀값은 넣지 않는다. client secret을 따로 넣을 때 남기던 receipt는 쓰지 않는다. 같은 트랜잭션의 한 receipt가 App과 secret을 함께 말한다.
- `webhook_secret`은 저장하지 않는다. manifest에 `hook_attributes`를 넣지 않아 webhook이 없다(§5).
- 교체: 작성용 App이 있을 때는 위험 구역의 '교체'에서 확인 창을 거친 뒤 '새 App 만들기'와 '이미 있는 App 추가' 가운데 고른다. 시작 요청은 `replace: true`를 보내야 하고, 없으면 409 `GITHUB_APP_CONFLICT`(`reason_code: author_app_exists`)다. 시작할 때의 App ID(없으면 null)를 state의 `replaces_app_id`에 둔다. 완료할 때 잠금 아래 지금의 App ID와 다르면(그사이 다른 사람이 등록·교체·삭제했으면) 저장하지 않고 409 `author_app_changed`를 돌려준다. 이때 GitHub에는 App이 만들어진 채 남으므로 `details.html_url`로 App 링크를 보여 관리자가 지울 수 있게 한다. 교체는 '이미 있는 App 추가'의 교체와 같다. 행 id는 그대로 두고, 이전 App의 client secret은 지운다.
- 교환은 성공했는데 저장이 실패하면 키를 잃는다(code는 한 번만 교환된다). 이때는 503 `BACKEND_UNAVAILABLE`, `reason_code: store_failed`, `details.app_id`, `details.html_url`을 돌려준다. GitHub가 code를 거절하면(만료·이미 씀) 400 `BAD_REQUEST` `code_rejected`, 닿지 않으면 503 `github_unreachable`이다. 교환 요청은 다시 보내지 않는다. 첫 요청이 GitHub에서 성공했다면 두 번째 요청은 거절되고 키만 잃는다. 화면은 "App은 GitHub에 만들어졌지만 키를 저장하지 못했습니다. App 설정에서 새 키를 만들어 '이미 있는 App 추가'로 연결하세요"와 App 링크를 보인다.

## 5. manifest

| 키 | 값 |
|---|---|
| `name` | `werft-{조직 login 앞 22자, 개인 계정이면 agent}-{16진 4자}`. App 이름은 GitHub 전체에서 하나뿐이고 34자까지라 끝에 무작위 4자를 붙인다. GitHub 화면에서 바꿀 수 있다 |
| `url` | `CONSOLE_ORIGIN` |
| `redirect_url` | `{CONSOLE_ORIGIN}/settings/workspace/integrations/github/new-app` |
| `callback_urls` | 구성원 계정 연결 콜백(`githubCallbackUrl`) |
| `setup_url` | `{CONSOLE_ORIGIN}/settings/workspace/integrations/github` |
| `public` | 기본 `false`. 관리자가 '여러 조직에서 쓰기'를 고르면 `true` |
| `default_permissions` | `contents: write`, `pull_requests: write`, `metadata: read`. 고르면 `actions: write`, `workflows: write`를 더한다. administration과 조직 권한은 넣지 않는다 |
| `hook_attributes` | 넣지 않는다. GitHub는 꺼 둔 webhook이어도 인터넷에서 닿지 않는 URL이면 manifest를 거절한다(`localhost` 콘솔에서 확인) |
| `default_events` | `[]` |
| `request_oauth_on_install` | `false` |

- 비공개 App은 소유 계정에만 설치된다. 여러 조직에서 쓰려면 공개로 만든다. 공개 App이어도 플랫폼은 '에이전트가 쓰는 저장소'에 더한 저장소에만 토큰을 받는다.

## 6. 막는 조건

시작 요청은 다음일 때 503 `BACKEND_UNAVAILABLE`로 거절한다. master key가 없을 때 App 등록이 이미 쓰는 코드이고, 새 오류 코드는 두지 않는다. 화면은 `GET …/github-apps/{role}`의 새 칸 `manifest_blocked`(`console_origin_unset` 또는 null)를 미리 읽고 버튼을 막은 채 이유를 보인다. Slack 앱 만들기의 사전 차단과 같은 방식이다. master key가 없으면 그 GET이 이미 503이고, 화면은 지금처럼 그 이유를 보인다.

| `reason_code` | 조건 |
|---|---|
| `console_origin_unset` | `CONSOLE_ORIGIN`이 없다. redirect와 계정 연결 콜백을 만들 수 없다 |

master key가 없어 키를 봉인할 수 없을 때는 `reason_code` 없이 App 등록과 같은 503을 돌려준다.

- `localhost` origin도 된다. manifest의 redirect는 브라우저가 따라가는 이동이라 GitHub 서버가 콘솔에 접속하지 않는다. 다만 다른 사람의 계정 연결은 그 사람의 브라우저가 열 수 있는 주소여야 한다.

## 7. 로그와 응답

- `code`, `state`, `pem`, `client_secret`, `webhook_secret`은 로그, 오류 응답, receipt에 넣지 않는다. 로그에는 App ID, slug, 결과, 거절 사유만 남긴다.
- complete 응답에 `Referrer-Policy: no-referrer`를 붙인다. 콜백 화면은 API를 부른 직후 URL에서 `code`와 `state`를 지운다(router의 replace 이동).
- complete 응답은 App 정보와 설치 주소, receipt id만 담는다. 키와 secret은 응답에 없다.
- 콘솔 CSP의 `form-action`은 `'self' https://github.com`이다. manifest form은 github.com으로만 보낼 수 있다.

## 8. LATER

- App 여럿 허용(오너 결정 2026-11-02, [github-agent.md 결정 11](github-agent.md#결정-11-같은-역할에-app-여럿)) 뒤 manifest의 `replace`·`author_app_exists`는 GHUI-impl 2에서 연결 추가로 바뀐다.

- GitHub Enterprise Server의 manifest(`{GHES}/settings/apps/new`).
- 리뷰 승인용 App의 manifest 생성.
- App 소유 계정과 공개 여부를 행에 두고 '다른 조직에 설치' 버튼을 공개 App에만 보이기.
