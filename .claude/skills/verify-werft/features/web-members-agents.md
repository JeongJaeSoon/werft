# 웹 초대·구성원·에이전트

owner·admin은 웹 콘솔 `/members`에서 초대 대화상자로 링크를 만들어 건네고, 받은 사람은 `/invite/{token}`에서 두 단계(계정 확인 → 비밀번호)로 들어온다. 같은 화면에서 역할을 바꾸고(확인 대화상자, owner 역할을 주거나 owner를 바꾸는 것은 owner만) 비활성화·재활성화한다. `/agents/new`는 다섯 단계 마법사(이름 → 하는 일 → 릴리스 → 켜기 → 채널 연결)로 에이전트를 만들어 바로 켠다(member도 만든다. 만든 사람이 그 에이전트의 관리자가 된다). `/agents/{id}`의 "카드" 탭에서 카드를 고쳐 새 version을 저장하고, "릴리스" 탭에서 release를 만들어 활성화한다. release의 `policy_pins`는 서버가 카드에서 정하고 승인 대기 상태는 없다(첫 활성화가 `approved_by`를 채운다). 두 탭이 같은 활성화를 다투면 늦은 탭은 덮어쓰지 않고 409를 안내한다. 홈 "시작하기"의 "구성원 초대하기"·"에이전트 준비하기"는 이 상태를 그대로 보인다.

## Sub-features

- `invite-create` `/members`의 "초대 링크 만들기"가 대화상자 "초대"를 연다(`?invite.step=details`). 이메일·역할(select, 값 `owner`·`admin`·`member`. `GET /v1/members`의 `assignable_roles`에 없는 값은 비활성이고 칸 아래 "소유자 역할은 소유자만 줄 수 있습니다."가 붙는다. admin이면 owner가 비활성)을 넣고 대화상자 안의 "초대 링크 만들기"를 누르면 둘째 단계(`?invite.step=link`)에 `<origin>/invite/<token>` 링크가 읽기 전용 칸에 한 번만 보인다("링크 복사"·"다른 사람 초대"·"닫기"). 복사하지 않고 "닫기"를 누르면 "복사하지 않고 나가기" 확인이 한 번 더 뜬다. 대기 중 초대 목록에 생기고 "회수"는 확인 대화상자를 거친다.
- `invite-accept` 로그인하지 않은 브라우저로 링크를 열면 "초대받은 이메일로 쓰는 계정이 있나요?"와 "네, 계정이 있습니다"·"아니요, 처음입니다". 고르면 `?accept.step=password`에 이름(`display_name`, "처음"일 때만)·비밀번호 칸과 "초대 수락". 내면 `/`에 그 사람 이름으로 로그인된다.
- `invite-provider` 켜진 로그인 공급자가 있으면([web-settings.md](./web-settings.md) 1로 켠다) 첫 단계의 두 버튼 아래 "또는"과 구역 "비밀번호 없이 가입"에 공급자마다 "<이름> 계정으로 가입"이 있다. 누르면 `POST /v1/auth/providers/{id}/invite/start`(본문에 초대 token) 뒤 공급자 화면으로 가고, 돌아온 `/auth/callback/<공급자 id>`가 계정을 만들어 `/`에 로그인된다. 계정의 이메일은 초대받은 주소이고 비밀번호는 없다(`SELECT email, password_hash IS NULL FROM users`). 쓴 링크·회수된 링크로 누르면 `invite-used`·`invite-expired`와 같은 안내가 공급자 화면으로 가기 전에 나온다. 누른 뒤 공급자 화면으로 넘어가는 동안 버튼들은 비활성이다. 콜백이 거절되면(그사이 회수된 초대, 공급자가 검증하지 않은 주소: 둘 다 `401`) 콜백 화면이 "가입하지 못했습니다 — … 받은 초대 링크를 다시 열어 시도하고 …"라고 말한다. 켜진 공급자가 없으면 구역이 없다. 비밀번호 단계에는 없다. 화면은 `browser.mjs <run id> invite <who>`로 연다(token을 파일에서 읽고 폼은 건드리지 않는다).
- `invite-signed-in` 이미 로그인한 브라우저로 링크를 열면 "이미 이 워크스페이스의 구성원입니다" 안내와 "워크스페이스로 가기"·"로그아웃하고 다른 계정으로 수락".
- `invite-used` / `invite-expired` / `invite-invalid` 이미 쓴 링크로 수락하면 "이미 수락한 초대입니다"(본문 "이 초대는 이미 쓰였습니다. 수락한 계정으로 로그인하세요.", 버튼 "로그인 화면으로"), 회수했거나 만료된 링크는 "쓸 수 없는 초대입니다"(본문 "만료됐거나 회수된 초대입니다. …"). 둘 다 비밀번호 단계에서 제출한 뒤에 나온다. 모양이 틀린 token은 열자마자 "초대 링크가 올바르지 않습니다".
- `member-forbidden` member로 `/members`를 열면 제목 "구성원"과 "구성원 초대와 관리는 워크스페이스 소유자나 관리자가 합니다."만 보인다. 목록을 묻지 않아 서버 403도, 초대 버튼도 없다. 사이드바에도 "구성원"이 없다.
- `role-change` 역할 select(`aria-label` "<이름>의 역할")를 바꾸면 확인 대화상자 "<이름>의 역할을 <역할>(으)로 바꿀까요?"가 뜨고 "역할 바꾸기"를 눌러야 PATCH한다 → "<이름>의 역할을 <역할>(으)로 바꿨습니다." 마지막 owner를 내리면 "마지막 소유자는 역할을 바꾸거나 비활성화할 수 없습니다 — …".
- `disable` "비활성화"(`aria-label` "<이름> 비활성화")는 확인 대화상자 "<이름> 계정을 비활성화할까요?"를 거친다 → "<이름> 계정을 비활성화했습니다." 비활성화된 사람의 cookie 세션은 바로 끊긴다(`ap_web`이 401). "다시 활성화"는 바로 된다 → "… 다시 활성화했습니다. 이제 다시 로그인할 수 있습니다."
- `agent-create` `/agents/new`(`?new-agent.step=name|job|release|activate`). ① "이름": 이름·식별자(이름에서 채워진다), "다음". ② "하는 일": 역할·지시 사항·답변 언어(select `ko`|`en`)·모델(select, 로컬 스택은 `claude-sonnet-5`)·도구 radio·금지 도구, "초안 저장하고 다음"(여기서 `POST /v1/agents`, 이후 나가도 초안으로 남는다). ③ "릴리스": 모델 연결 select(`fake-messages`, 카드 모델을 제공하는 연결이 먼저 골라진다), "릴리스 만들기"(또는 "나중에 하기"). ④ "켜기": "에이전트 켜기" → "<이름>을(를) 켰습니다. 이제 새 세션이 이 에이전트를 씁니다."와 "에이전트 보기" 링크. owner·admin·member 모두 만든다(`me.permissions`의 `agent.create`).
- `agent-save` 상세의 "카드" 탭(`?tab=card`)에서 고쳐 "저장"하면 "저장했습니다 — 버전 N. 아직 활성화되지 않았습니다. 릴리스 탭에서 릴리스를 만들고 활성화해야 반영됩니다." 바뀐 것 없으면 "저장했습니다. 카드 내용이 같아 새 버전은 생기지 않았습니다." version이 둘 이상이면 "비교 기준"·"비교 대상" select가 생긴다.
- `release-activate` "릴리스" 탭(`?tab=release`)의 release 폼은 version select와 모델 연결 select다. "릴리스 만들기" → "릴리스를 만들었습니다(<label>). 아직 활성화되지 않았습니다.", 그 release의 "활성화" → "활성화됐습니다 — 이제 새 세션은 릴리스 <label>(으)로 시작합니다."(화면 문구는 web 변경을 따라 다시 확인한다). `<label>`은 만든 시각(서울, `2026-10-30_14:30:28`, 같은 초는 `-2`…)이다. 표 열은 버전(label)·상태·활성화 시각(이전 릴리스는 `시작 ~ 끝`)·카드 버전·연결·저장소·만든 사람·메모이고, 머리 태그는 `<label> · 활성`이다. 저장·release·활성화 문구는 서로 다르다.
- `activate-conflict` 다른 탭이 먼저 활성화했으면 409 "다른 곳에서 활성 릴리스를 먼저 바꿨습니다"와 "… 덮어쓰지 않고 멈췄습니다". "최신 상태 불러오기" 뒤 "보던 화면의 활성 릴리스: …. 지금 활성 릴리스: …."와 두 카드의 차이가 보이고, 그다음에야 다시 활성화된다.
- `checklist` 홈 "시작하기"의 "구성원 초대하기"는 구성원이 둘 이상이거나 초대가 있으면, "에이전트 준비하기"는 활성 release가 있는 에이전트가 있으면 완료. 조회가 실패하면(member는 구성원 목록을 못 본다) "확인할 수 없음".

## How to get to it (user POV)

- owner로 `$VERIFY_API/`에 로그인해 왼쪽 사이드바의 "구성원"·"에이전트"로 간다. member도 "에이전트" → "새 에이전트"로 `/agents/new`에 간다.
- 초대받는 사람은 owner와 cookie를 나누지 않는 다른 브라우저(profile)로 링크를 연다.
- release 폼의 모델 연결은 `GET /v1/connections`에서 고른다. 카드 모델이 연결의 모델 목록에 없으면 서버가 거절하므로 폼이 카드 모델을 제공하는 연결을 먼저 고른다.

## Driving it with lib.sh

Preconditions: [web-login.md](./web-login.md)대로 owner를 `web-user.mjs`로 bootstrap·login했다. `orch hold browser --note "<what>"`를 잡았다. 화면은 이 run의 headless Chrome(`browser.mjs`, [web-console.md](./web-console.md))으로 몬다. 비밀번호와 초대 token은 명령에 쓰지 않는다: `web-user.mjs invite`가 token을 `users/<who>.invite`에, 초대받는 사람의 무작위 비밀번호를 `users/<who>`에 두고, 수락은 API(`web-user.mjs accept`)나 화면(`browser.mjs accept`)이 그 파일에서 읽는다.

```sh
. .claude/skills/verify-werft/scripts/lib.sh <run id>
U=.claude/skills/verify-werft/scripts/web-user.mjs
B=.claude/skills/verify-werft/scripts/browser.mjs
node $U <run id> invite owner member member   # 201 {invite_id, invite_token: (saved, N chars), expires_at}
node $B <run id> start                         # PID는 browser/pid에 남는다
node $B <run id> accept member                 # 계정 확인에서 "처음"을 고르고 이름·비밀번호를 넣어 수락 → "accept member -> /"
node $U <run id> login member                  # 같은 비밀번호로 API 로그인 → 200 role member, cookie.member
```

- API로만 수락하려면 `node $U <run id> accept member` → `200` `{user_id, workspace, role: "member"}`, cookie가 생긴다.
- 브라우저는 cookie를 하나만 가진다. 다른 사람으로 화면을 보려면 사이드바 아래 사용자 메뉴를 열고 로그아웃한 뒤(`node $B <run id> open /`, `click "Verify Owner"`, `click 로그아웃`. [web-console.md](./web-console.md) `logout`) `node $B <run id> login <who>`. 이미 로그인한 브라우저로 초대 링크를 열면 `invite-signed-in` 화면이 나온다.
- 초대 대화상자(`invite-create`)는 `<main>` 밖에 그려져 `@N`이 닿지 않는다. CSS로 몬다: `open /members` → `click "구성원 초대"` → `type '[role=dialog] input[type=email]' invitee@example.test` → `click '[role=dialog] form button[type=submit]'`(같은 글자의 바깥 버튼이 먼저 잡히므로 글자로 누르지 않는다) → `?invite.step=link`. 그 링크의 token은 출력하지 않는다(`eval`로 읽지 말고 대화상자 버튼 이름이나 목록의 "대기 중인 초대"로 확인한다). 끝내려면 `click 닫기` → `click "복사하지 않고 나가기"`.
- `accept`는 `/`에 닿아야 exit 0이다. 폼 대신 안내 화면이 나오면 그 제목을 출력하고 exit 1로 끝난다. 그래서 다른 상태 화면도 `accept`로 본다(token을 `open` 인자로 넘기지 않는다. 명령줄 인자는 `ps`에 보인다): 로그인한 브라우저로 `accept member` → `| 이미 이 워크스페이스의 구성원입니다`, 이미 수락한 뒤 로그아웃한 브라우저로 다시 `accept member` → `| 이미 수락한 초대입니다`. 모양이 틀린 token은 `open /invite/not-a-real-token` → "초대 링크가 올바르지 않습니다". zsh에서는 `[...]`가 든 CSS를 따옴표로 감싼다.

역할 변경·비활성은 owner 화면에서 몬다. 확인 대화상자 둘이 동시에 열리지 않도록 하나씩 끝낸다(`click`은 `el.click()`이라 열린 modal 뒤의 버튼도 누른다).

```sh
node $B <run id> click '[aria-label="Verify Member 편집"]'
node $B <run id> click '[role=dialog] [role=radio][value=admin]'
node $B <run id> click '[role=dialog] button:last-child' # Save, then confirm the role change.   # 출력은 "selected member": 확인 전에는 값이 그대로다
node $B <run id> click "역할 바꾸기"                                               # → "Verify Member의 역할을 관리자(으)로 바꿨습니다."
node $B <run id> click '[aria-label="Verify Member 비활성화"]'
node $B <run id> click '[role=dialog] button:last-child'                          # 대화상자의 "비활성화" → "… 계정을 비활성화했습니다."
node $B <run id> click "다시 활성화"
```

그 뒤 DB로 다시 읽는다(읽기만).

```sh
ap_compose exec -T postgres psql -U postgres -d sessions -c "select u.email, m.role, m.disabled_at from memberships m join users u on u.id=m.user_id order by u.email" | tee "$EVIDENCE/members-db.txt"
```

비활성 뒤 초대받은 사람으로 `node $B <run id> open /`을 다시 열면 `/login?redirect=%2F`.

에이전트는 `/agents/new` 마법사로 만든다. 단계마다 칸이 바뀌고 `@N`(main 안 N번째 칸, 0부터)은 지금 단계의 칸만 센다. member로 로그인한 브라우저에서:

```sh
node $B <run id> open /agents/new                    # /agents/new?new-agent.step=name
node $B <run id> type @0 "Member Helper"             # 이름. 식별자(@1)는 member-helper로 채워진다
node $B <run id> click 다음                          # → ?new-agent.step=job
node $B <run id> type @0 "verify helper"; node $B <run id> type @1 "Answer briefly."   # 역할, 지시 사항
node $B <run id> select @3 claude-sonnet-5           # 모델 (@2는 답변 언어, @4는 금지 도구)
node $B <run id> click "초안 저장하고 다음"           # → ?new-agent.step=release, 연결 select @0 = fake-messages
node $B <run id> click "릴리스 만들기"               # → ?new-agent.step=activate
node $B <run id> click "에이전트 켜기"                # → "Member Helper을(를) 켰습니다. …"
node $B <run id> click "에이전트 보기"                # → /agents/<id>
```

상세는 탭 넷(개요·카드·릴리스·관리자)이고 패널이 모두 mount된 채 숨어 있어 `@N`은 숨은 칸까지 센다(한 version일 때 @0 이름·@1 역할·@2 지시 사항·@3 답변 언어·@4 모델·@5 금지 도구·@6 version·@7 연결·@8 관리자로 추가할 사람·@9 팀, version이 둘 이상이면 @6·@7에 비교 select가 끼어 뒤가 둘씩 밀린다). 숨은 칸에는 `type`이 들어가지 않으므로 탭을 주소로 연다: `open "/agents/<id>?tab=card"` → `type @2 "…"` → `click 저장`, `open "/agents/<id>?tab=release"` → `click "릴리스 만들기"` → `click 활성화`, `?tab=admins`에서 `select @<팀 칸> <team id>` → `click "팀 추가"`. 칸 순서는 `eval`로 label을 찍어 확인한다.

충돌은 같은 상세를 두 탭에 띄우고, 두 탭 모두 활성화 전 상태에서 A로 활성화한 뒤 B로 다른 release를 활성화한다(두 탭은 Orca 탭 둘로 연다. `browser.mjs`는 탭 하나만 쓴다).

```sh
ap_compose exec -T postgres psql -U postgres -d sessions -c "select a.slug, a.activation_revision, v.version_no as active_version, u.email as created_by from agents a left join agent_releases r on r.id=a.active_release_id left join agent_versions v on v.id=r.version_id left join users u on u.id=a.created_by" | tee "$EVIDENCE/agents-db.txt"
```

409 직후에는 revision과 version이 A가 활성화한 그대로여야 한다. B에서 "최신 상태 불러오기"를 누르면 보던·지금 활성 release와 카드 차이가 보이고, 그 뒤 활성화는 성공한다(revision +1).

끝나면 `node $B <run id> stop`(`down.sh`도 부른다). Orca 탭을 열었으면 `orca tab close --page <id>`, profile은 `orca tab profile delete --profile <id>`로 지운다.

## Gotchas

- 마법사 ②단계를 넘기면 초안이 저장된다. 같은 식별자로 다시 만들면 거절되니 run마다 이름을 바꾸거나 새 run에서 한다.
- `orca click`이 접힌 영역 아래 버튼(상세의 "저장")을 누르지 못할 때가 있다. 겹친 요소는 없었다. `orca eval --expression "[...document.querySelectorAll('button')].find(b=>b.textContent==='저장').click()"`로 누른다. `browser.mjs click`은 처음부터 이렇게 누른다.
- 비활성된 사람의 탭은 열린 채로는 `me`의 staleTime(30초)이 지나고 포커스가 돌아와야 로그인 화면으로 간다. 다시 열면 바로 간다.
- `GET /v1/members`가 owner·admin(`member.manage`) 전용이라 member는 구성원 목록을 못 본다. 권한 없음 화면이 맞는 결과다.
- 웹 카드 폼에는 `credential_refs`가 없어 웹에서 만든 에이전트는 바로 활성화된다. API로 `capabilities.credential_refs`를 넣은 카드는 연결 전 활성화가 `409 CREDENTIAL_UNBOUND`다. 자격 연결은 릴리스 탭에 있다. Slack 앱 설치 설정은 API로 한다([musterrolle.md](./musterrolle.md) f·g).
- 초대 token은 URL 경로에 있다. 텍스트 증거에는 링크를 남기지 않는다. 초대 링크 스크린샷의 token은 수락이나 회수 뒤 무효다.
- 같은 사람을 두 번 초대하지 않는다. `invite`는 그 사람의 `users/<who>`가 이미 있으면 새 비밀번호를 만들지 않고 그대로 쓴다.

현재 구성원 화면은 구성원·팀·초대 LinkTabs다. 표는 GridTable의 role=table/row/cell이며 구성원·역할·관리 3열이다. 역할은 행의 편집 버튼 → RadioGroup → 저장 → 역할 바꾸기 확인으로 바꾼다. 팀 주소는 `/members/teams`, 대기 중 초대는 `/members/invites`다. 에이전트 목록은 전체/관리하는 에이전트 SegmentedControl과 개수, 카드/표 보기다. 소스: `apps/web/src/routes/members.tsx`, `agents.tsx`. 실행 순서는 [procedures.md](procedures.md)를 따른다.
