# werft 검증 map

이 디렉터리는 werft의 사용자 표면을 확인하는 정본이다. 몰기 전에 이 index를 읽고, 해당 기능 파일을 절차로 쓴다.

## 기본 전제

- `scripts/up.sh`로 이 run만의 스택을 띄웠고, 출력된 run id를 기록했다(fake model, ephemeral 포트, 이 run의 bootstrap token).
- `scripts/doctor.sh <run id>`가 exit 0이고 checkout SHA가 확인하려는 커밋이다.
- 드라이브하는 Bash 호출마다 `. .claude/skills/verify-werft/scripts/lib.sh <run id>`를 source한다. run id는 `up.sh`가 출력한 값이고 기본값은 없다.
- 이 run이 띄우지 않은 스택(기본 project `werft`, 다른 `verify-ap-*`)은 몰지 않는다.

## 몰기 규칙

- 경로·헤더·JSON 키는 적힌 그대로 쓴다.
- 웹 사용자 행동은 `ap_web`, key 호출자는 `ap_get`·`ap_post`, 운영자 CLI는 `ap_key`·`ap_revoke`로 한다. 비밀번호·초대 token·key secret이 본문에 드는 요청은 `web-user.mjs`, 화면은 `browser.mjs`로 한다. 그 값을 명령에 쓰면 agent-guard가 거부한다.
- 응답 마지막 줄이 HTTP 상태 코드다. 판정은 상태 코드와 본문의 `error.code`로 한다.
- bootstrap은 한 run에 한 번만 된다. 다른 상태에서 시작해야 하면 `down.sh <run id>` 뒤 `up.sh`.

## 증거와 생략 보고

- 출력은 `| tee "$EVIDENCE/<feature>.txt"`로 남긴다. 요청과 응답을 같이 남긴다.
- 상태를 바꾼 행동은 다른 읽기 경로로 다시 확인한다.
- key·cookie 값은 남기지 않는다.
- 몰 수 없던 진입점은 시도한 명령과 채워지지 않은 전제를 적는다. 다른 진입점으로 확인한 것을 그 진입점의 확인으로 보고하지 않는다.

## 기능 파일 형식

`procedures.md`는 실행 순서와 안정 id를 쓴다. 나머지 기능 파일은 H1 제목과 사용자에게 보이는 동작 한 문단, 그다음 H2 넷을 이 순서로 둔다: `Sub-features`, `How to get to it (user POV)`, `Driving it with lib.sh`, `Gotchas`.

## 기능

- [순서별 검증 절차](./procedures.md): 화면·API별 안정 id, 기본 스택 → mock Slack → 별도 데모 run.

- [웹 로그인](./web-login.md): 첫 owner bootstrap, 로그인 수단 목록(Google 꺼짐 404), 로그인, `me`(`permissions`·`workspace.settings`), 로그아웃, CSRF·잘못된 비밀번호 거절.
- [웹 콘솔](./web-console.md): 브라우저로 `/bootstrap` → `/login` → `/`(사이드바 shell) → 사용자 메뉴의 로그아웃, 언어(ko·ja·en), SPA fallback과 `/v1` JSON 404, `browser.mjs`로 1280·390 폭·light·dark·오류·로딩 스크린샷.
- [웹 초대·구성원·에이전트](./web-members-agents.md): `/members`의 초대 대화상자 → `/invite/{token}` 두 단계 수락 → 역할 변경(확인)·비활성, `/agents/new` 다섯 단계 마법사(member도), 상세 카드 탭 저장 → 릴리스 탭 release·활성화와 두 탭 409.
- [웹 로그인 선택·팀·연동 계정·API key·워크스페이스 설정](./web-settings.md): 비밀번호/로그인 공급자 선택, 팀과 에이전트 관리자 지정, Slack 연결·해제, API key 화면의 개인 key·에이전트 key 탭과 만들기 화면, 조직 관리 key 자리(준비 중), 감사 보존 29일 거절, Slack 게스트 사용 토글(member는 읽기 전용).
- [실제 Keycloak으로 로그인 공급자 몰기](./keycloak-login.md): 별도 run(`scripts/keycloak-up.sh`)에서 화면으로 공급자 추가 → Keycloak의 폼을 거친 테스트 로그인 → 켜기 → 계정 연결 → 첫 가입 → 검증 안 된 주소 거절 → 끄기와 세션 끊김, 틀린 PKCE verifier 거절(`scripts/keycloak-pkce.sh`), 로그에 secret 없음.
- [API key](./api-keys.md): key CLI로 운영자 key·workspace key 발급, scope 검사, 폐기 후 401. 웹의 권한별 key는 musterrolle d.
- [세션](./sessions.md): fake model 대본으로 세션 생성·turn 완료·권한 요청·pause/resume (전체 경로는 `docs/quickstart.md` 3장), 웹 사용자가 개인 key로 만든 세션이 웹 `/sessions`에 보이기.
- [운영 조회](./ops-endpoints.md): `/readyz`, `/docs`(API reference), `/v1/limits`(owner), `/v1/usage/summary`, 세션 usage.
- [GitHub sandbox](./github-sandbox.md): 실제 `JeongJaeSoon/werft-sandbox`. 별도 run(`github-sandbox/overlay.yml`, 버리는 master key)에서 App 등록(키는 파일 경로로만), 상한, 에이전트 릴리스의 GitHub 설정, clone·push(사람 cookie로 승인)·PR, 바로 인정 규칙의 PR 성과, workflow dispatch·rerun 거절, 게이트 receipt, 자기 PR 닫기와 volume 유지 정리.
- [멤버·팀·권한 (Musterrolle)](./musterrolle.md): 시나리오 a–g 전부. a(초대·역할 변경·OWNER_PROTECTED·LAST_OWNER·비활성화와 재활성화), b(팀과 팀을 에이전트 관리자로), c(Slack 계정 연결과 멘션·승인 판정, mock IdP overlay), d(권한별 개인 key와 에이전트 key), e(판정 기록·보존 기간·공유 범위·SSE 끊김·감사 열람·관리 목록), f(자격 연결), g(에이전트의 Slack 앱 연결). DM 기본 "나만"만 경로가 없다.

## 현재 구현과 보류

- 세션 목록: `relation`·`q`·`status` 필터와 `/v1/sessions/counts`. `channel`·`created_by`는 응답 필드이며 query 필터가 아니다. 목록·상세에 `agent`·`created_by`·`channel`·`model`·`repository`가 있다.
- 사용량: `/usage`의 내 사용량·설치 전체와 한도. 설치 전체·`/v1/limits`는 owner cookie만 허용한다.
- Slack: 서명 검증 → inbox 중복 제거 → slack role claim·lease → binding·연결 계정이 맞으면 세션 생성(P-SLACK-MENTION-ONLY) → 세션이 기다리는 요청의 카드 → 카드 버튼의 서명된 interaction(P-SLACK-APPROVAL-CLICK).
- 데모: `VERIFY_DEMO_ACCOUNTS=1`로 별도 run을 띄운다. 기본 run은 bootstrap을 위해 seed를 끈다.
- 보류: API key 마지막 사용 시각·발급자 이름은 아직 main에 없다. 검증 절차를 만들지 않는다.
