# 변경 기록

Werft를 설치하거나 올리는 사람이 릴리스마다 꼭 읽어야 하는 것만 적는다. 변경 목록 전체는 GitHub Release의 자동 생성 노트(`.github/release.yml`로 분류)에 있고, 이 파일에 옮겨 쓰지 않는다.

## 쓰는 방식

- 절은 두 가지만 쓴다. "보안"(수정한 취약점과 영향받는 버전)과 "운영자가 할 일"(올릴 때 직접 해야 하는 일. 안 하면 조용히 깨지는 변경이 먼저 온다). 해당 없는 절은 쓰지 않는다.
- 가장 위의 "미출시" 절에 쌓는다. 릴리스 태그를 만드는 사람이 그 절의 제목을 태그로 바꾸고, 새 "미출시" 절을 위에 더한다.
- 각 항목은 PR 링크(`JeongJaeSoon/werft#123`)를 붙이고 한국어로 서술한다.
- 이 파일은 사람이 쓴다. 태그가 있다고 전제하고 쓰지 않는다.
- `v0.1.1`·`v0.1.0` 절은 이 형식 이전에 쓴 것이라 다른 절(GitHub 작업, 게시 패키지 등)이 남아 있다.

## 미출시

### 운영자가 할 일

- **비공개 Slack 채널에서 생긴 세션은 공유 범위와 상관없이 채널 문을 먼저 지난다. 그래서 채널을 나간 만든 사람은 자기 `private` 세션을 못 보고, API key로는 그 세션에 닿지 않는다**(JeongJaeSoon/werft#2081). migration은 없고 따로 할 일도 없다. `share_scope` 값은 바뀌지 않는다.
  - 세션의 부모 대화가 비공개 채널이면(그 채널 binding의 `surface_kind`. 살아 있는 binding이 없으면 가장 최근 binding) 그 에이전트를 쓸 수 있는 지금 채널 멤버만 문을 지나고, 그다음 범위의 원래 규칙을 함께 본다. `private`는 만든 사람 본인, `people`·`team`은 지목된 사람, `workspace`는 워크스페이스 규칙이다. `private_channel` 세션은 지금과 같다.
  - 보이는 변화: 비공개 채널의 `private` 세션은 채널을 나간 만든 사람도, 다른 채널 멤버도 목록에서 못 보고 상세가 `404`다. API key(개인 key·에이전트 key 모두)로는 읽기·쓰기·승인이 모두 `404`이고 판정 기록의 이유는 `private_channel_key`다. 공유를 넓혀도(`private`→`workspace` 등) 채널 밖 사람에게는 보이지 않는다.
  - 이 릴리스 전에 비공개 채널에서 만든 `workspace`·`people`·`team` 세션도 같은 문을 지난다. 채널 밖의 워크스페이스 멤버와 key는 더 이상 보지 못한다(`private_channel`로 옮기기 전이어도 같다).
  - binding이 없어 종류를 모르는 채널의 세션은 비공개로 본다. 그런 채널이 걸린 판정마다 `warn` 로그 `Channel kind unknown; held private`(`event` `session.private_channel.kind_unknown`, `conversation_count`)를 남긴다.
  - 공개 채널·DM·웹·API로 만든 세션은 그대로다.
  - 지원 창 안의 옛 이미지로 되돌리면 옛 판정(`private_channel` 범위만 채널 문을 지남)으로 돌아간다. 그동안 나간 만든 사람과 key가 다시 자기 `private` 세션에 닿는다.

- **migration `0336_session_link_old_uniques`가 `session_links`의 옛 unique 둘(`session_links_surface_ref_key`, `session_links_session_uniq`)을 지운다. 이 릴리스를 올린 뒤에는 `v0.3.0` 이하의 이미지로 되돌릴 수 없다**(JeongJaeSoon/werft#2079). 따로 할 일은 없고, Slack 스레드의 동작은 그대로다.
  - 남는 unique는 닫히지 않은 link만 보는 둘이다. 스레드와 세션마다 열린 link는 하나뿐이고, 닫힌 link는 그 옆에 이력으로 남을 수 있다. 이 릴리스에는 link를 닫는 길이 없다.
  - `v0.3.0` 이하의 이미지는 옛 unique를 가리키는 `ON CONFLICT`로 스레드를 예약하므로, 되돌리면 Slack 스레드에 세션이 생기지 않는다. 열린 link만 보는 예약으로 옮긴 JeongJaeSoon/werft#2041부터의 이미지로는 되돌려도 된다. 더 앞으로 가야 하면 업그레이드 전 백업으로 DB를 복원한다.
  - `v0.3.0`에서 바로 올리면 migrate가 끝난 뒤 옛 slack 역할이 내려갈 때까지 그 역할이 받은 스레드 예약이 실패하고, 그 이벤트는 다시 시도된다.
  - 행은 고치지 않는다. 제약은 표를 읽지 않는 한 문장으로, 인덱스는 `CONCURRENTLY`로 지운다.

- **migration 0308 전에 처리를 마친 Slack inbox 행에 남은 원문(`payload`)을 지우는 운영자 명령 `slack-inbound-payloads.ts`가 생긴다**(JeongJaeSoon/werft#2080). migration은 없다. 돌리기 전에는 그 원문이 남아 있을 뿐이고 동작은 같다.
  - **모든 slack 역할이 0308 이후 이미지로 돈 뒤에 한 번 돌린다.** 앞선 이미지의 slack 역할이 남아 있으면 처리한 행에 원문을 다시 남긴다.
  - api 컨테이너에서 `bun run apps/control-host/src/api/slack-inbound-payloads.ts`를 돌린다. 처리를 마친 행(`processed`)의 원문만 지우고, 처리 중인 행과 실패한 행(받은 지 7일 뒤 reconciler가 지운다)은 그대로다.
  - 기본키 순서로 1000행씩(`--batch-size`, 1~10000) 문장마다 따로 커밋한다. 행 잠금은 그 묶음의 처리된 행에만 잡히고 표의 읽기·쓰기는 막지 않는다. 결과는 한 줄 JSON(상태별 원문 있는 행 수 전후, 지운 수, 묶음 수와 크기, 걸린 시간)이고, 다시 돌려도 더 지우는 것이 없다.
  - 끝난 뒤에도 원문이 남은 처리된 행이 있으면 종료 코드 `3`이다. 앞선 이미지의 slack 역할을 내린 뒤 다시 돌린다. 수는 묶음마다 따로 읽으므로 `0`이 앞선 이미지가 없다는 증거는 아니다. 돌리기 전에 컨테이너의 이미지를 확인한다. 지운 원문은 돌아오지 않는다.

- **Slack에서 채널이 삭제되면(`channel_deleted`·`group_deleted`) 그 채널의 채널 요약을 모든 버전의 이력과 함께 지운다**(JeongJaeSoon/werft#2075). migration은 없고 따로 할 일도 없다. 이 릴리스에는 요약을 쓰는 길이 없어서 지울 행도 아직 없다.
  - 관여 기록, 대화, `channel_contexts` 행은 남는다. 보관과 `channel_not_found`(조회 실패로 정리한 채널)로는 지우지 않는다.

- **migration `0335_input_hold`가 웹 입력의 Slack 글 위치(ts)를 기다리는 Slack 줄을 보류하고, 게시가 `uncertain`으로 끝난 입력을 "Slack 반영을 확인하지 못했어요"(`unconfirmed`)로 남긴다**(JeongJaeSoon/werft#2074). 따로 할 일은 없다. 이 릴리스에는 웹 입력을 적는 route가 없어서 새 칸이 채워지는 줄은 생기지 않고, Slack 멘션과 답, 웹·API 세션의 동작은 그대로다.
  - 칸: `slack_outbox.correlation_id`(웹 입력의 Slack 글마다 새로 만드는 상관값), `slack_outbox.held_for_input_id`(그 입력의 글 스레드를 기다리는 줄), `conversation_inputs.slack_mirror`의 새 값 `unconfirmed`.
  - 웹 입력의 Slack 글에는 상관값이 message metadata(`event_type` `werft_input_mirror`)로 실린다. 다른 줄의 `chat.postMessage`에는 지금처럼 metadata가 없다.
  - `uncertain`이면 다시 보내지 않고 새 스레드도 만들지 않는다. 돌아온 자기 앱의 글이 그 상관값을 가진 `uncertain` 거울 하나를 정확히 가리킬 때만 그 글을 거울로 잇는다. 본문으로는 잇지 않는다.
  - 문에서 버린 이벤트의 `drop_fields`에 `metadata`(`event_type`과 거울의 `correlation_id`)가 더해진다. `event_payload`의 나머지는 남기지 않는다.
  - 보류된 줄은 거울이 끝내 실패하거나 `SLACK_ROLE_INPUT_HOLD_SEC`(기본 3600, Helm `slack.inputHoldSec`)가 지나면 보내지 않고 `failed`(`input_unplaced`)로 닫는다. 로그 `Slack rows held for a web input's post closed unsent; Slack never confirmed the post`.
  - "다시 보내기"는 사람이 부를 때만 같은 입력의 거울을 새 상관값으로 보낸다. 이 릴리스에는 그 버튼이나 route가 없다.
  - CHECK와 외래 키는 `NOT VALID`로 더하고 따로 검증하며, 색인은 `CONCURRENTLY`로 만든다. 지원 창 안의 이미지로 되돌려도 된다.

- **Slack에서 지운 글을 직접 출처로 가진 턴은 API와 웹에서 가려진다**(JeongJaeSoon/werft#2071). migration은 없고 따로 할 일도 없다. 저장된 값은 지우지 않고 읽을 때만 가리며, 지운 글이 없는 세션의 응답은 그대로다.
  - 그 글이 입력인 턴의 입력, 그 턴의 답과 도구 결과를 가린다. 턴 응답은 `message`가 `""`, `result`가 `null`이 되고 `source_deleted_at`이 붙는다. `terminal_reason`도 `null`이다. 이벤트(SSE와 보관된 이벤트 포함)는 모양만 남기고 내용(엔진의 system 글, error의 `message`, 끝난 이유 포함)을 비우며 envelope에 `source_deleted_at`이 붙는다. 그 턴의 열린 요청은 목록에서 빠진다.
  - 물려받기만 한 뒤 턴은 가리지 않는다(세션은 지금처럼 멈춘다).
  - 첫 턴에서 만든 제목(`derived`·`generated`)은 세션 목록·상세·검색·도구 호출·사용량 목록에서 `null`이 되고 `title_deleted_at`이 붙는다. 사람이 준 제목은 그대로이고, status 이벤트에 남은 예전 제목은 가린다.
  - 감사 읽기도 같이 가린다. 무엇을 가렸는지는 결정 행의 시각과 `deleted_sources.deleted_at`으로 알 수 있다.
  - 웹은 가린 곳에 "Slack에서 삭제됨"을 보여 준다.

- **세션의 권한 모드를 release에 적힌 값이 아니라 지금 규칙(연결과 모델)으로 정한다. 그래서 `default`로 만든 옛 Claude 모델 release의 세션이 `auto`로 바뀐다**(JeongJaeSoon/werft#2070). migration은 없고, release를 다시 만들 필요도 없다. release id는 그대로다.
  - Claude 모델(`anthropic` 연결, 또는 `litellm` 연결의 Claude 모델 id)은 `auto`, Codex(`openai_responses`)와 Claude가 아닌 모델은 `default`로 돈다. 이미 도는 세션은 다음에 worker가 세션을 받을 때 바뀐다. 세션 상세의 `runtime.permission_mode`도 이 값을 보인다.
  - 그 세션은 사람에게 묻던 호출을 이제 분류기가 판정한다. 묻기 목록에 걸린 호출과 push 승인은 지금처럼 사람에게 간다.
  - 모드를 고르는 설정은 없다. 연결, 에이전트, 설치 설정 어디에도 없고, `default`로 되돌리는 스위치도 없다.
  - release의 `spec_source.permission_mode`는 `default`와 `auto`만 읽는다. `acceptEdits`·`dontAsk`·`plan`·`bypassPermissions`가 적힌 release(지금 서버는 만들지 않는다)는 spec을 읽지 못해 새 세션을 시작하지 못한다.
  - 지원 창 안의 이미지로 되돌리면 옛 release의 세션은 다시 `default`로 돈다.

- **migration `0334_input_mirror`가 outbox 종류 `input_mirror`와 칸 `input_id`를 더하고, Slack에 비친 웹 입력에 그 글의 자리를 별칭으로 잇는다**(JeongJaeSoon/werft#2067). 따로 할 일은 없다. 이 릴리스에는 웹 입력을 적는 route가 없어서 새 종류의 줄은 생기지 않고, Slack 멘션과 답, 웹·API 세션의 동작은 그대로다.
  - 웹 입력은 `instruction`과 같은 모양으로 올라가고, 게시 결과를 적는 트랜잭션에서 그 글의 (team, 채널, ts)가 입력의 별칭(새 주제면 주제의 위치도)이 된다. 같은 스레드의 사람 답글은 그 주제의 다음 순번이다. 돌아온 이벤트는 지금처럼 문에서 `own_bot_user`로 버린다.
  - 별칭이 생긴 뒤 그 글을 지우면 그 입력을 출처로 가진 outbox 줄이 `voided_by_delete`로 멈춘다.
  - 답글이 게시 결과보다 먼저 처리되어 스레드가 이미 다른 주제인 드문 경우는 합치지 않고 `warn` 로그 `Slack mirror opened a thread another topic already holds; the topics stay apart`를 남긴다.
  - CHECK와 외래 키는 `NOT VALID`로 더하고 따로 검증하며, 색인은 `CONCURRENTLY`로 만든다. 지원 창 안의 이미지로 되돌려도 된다.
- **에이전트가 받는 GitHub 도구 설명과 checkpoint 거절 이유가, 브랜치는 worktree 없이 작업 공간에서 `git switch -c <브랜치> <repository_id>/<branch>`로 만든다고 알린다**(JeongJaeSoon/werft#2069). migration은 없고 따로 할 일도 없다.
  - 작업 공간 안의 git worktree·clone은 지금처럼 checkpoint가 거절하고, 그 턴의 push는 `turn_ended_without_checkpoint`로 취소된다. `git worktree`의 묻기 규칙도 그대로다.
- **migration `0333_source_deleted`가 `sessions`에 `source_deleted_at`(timestamptz, nullable)을 더하고, 지운 Slack 글을 출처로 가진 턴이 있는 열린 세션을 멈춘다**(JeongJaeSoon/werft#2064). 따로 할 일은 없고, 지운 글이 없는 세션의 동작은 그대로다.
  - 직접 출처든 물려받은 출처든 턴 하나만 걸려도 세션 전체를 멈춘다. 글의 수정으로는 멈추지 않는다. 닫힌 세션은 건드리지 않는다.
  - 실행 중인 턴은 끊지 않고, 끝난 뒤 pause처럼 `paused`가 된다. 대기 중인 입력은 내보내지 않는다.
  - `attention.code`는 `SOURCE_DELETED`이고, 메시지·재개·`start_fresh`·`retry_restore`는 `409 SOURCE_DELETED`로 거절된다. 닫기만 된다. 이유는 세션 이벤트 `source_deleted`로 남는다.
  - 지원 창 안의 이미지로 되돌려도 된다. 옛 이미지는 칸을 읽지 않으므로 멈춘 세션을 재개할 수 있게 된다.
- **`private_channel` 세션의 DM 알림은 지금 채널 멤버에게만 가고, 인수는 채널 멤버가 한다**(JeongJaeSoon/werft#2066). migration은 없고 따로 할 일도 없다.
  - 세션에 관한 DM(모델이 허용 목록에서 빠짐, 다음 모델로 옮김, `runtime_retired`로 멈춤, worker 이미지 교체)은 보내기 직전에, 받는 Slack 계정이 세션의 비공개 채널 중 하나의 지금 멤버인지 본다. 멤버가 아니거나 확인하지 못하면 보내지 않고 `failed`(`error_code` `reader_outside_channel`)로 끝난다. 에이전트 관리자도 같다. 에이전트 단위 알림(에이전트의 모델 이동)은 그대로다.
  - 요청자가 비활성화되어 인수를 기다리는 `private_channel` 세션은 그 채널의 지금 멤버이고 세션에 쓸 수 있는(`session.submit`) 사람이 `POST /v1/sessions/{id}/takeover`로 인수한다. 사유는 받지 않는다. owner·admin도 채널 멤버가 아니면 `404`다. 다른 세션의 인수는 그대로다.
  - 요청자가 채널을 나가도 세션은 멈추지 않는다. 보고와 카드는 지금처럼 그 채널의 스레드에만 가고, 봇이 채널에서 빠지면 어디에도 보내지 않는다.
- **migration `0332_unknown_budget_end`가 끝을 모르는 호출을 적는 칸 `unknown_at`을 더하고, 한도가 있는 계정에서 root 종류 `none`의 예약을 한도의 80%에서 거절한다**(JeongJaeSoon/werft#2065). 따로 할 일은 없고, 예산 한도가 없는 설치는 지금처럼 돈다.
  - 쓰인 provider 호출에 lease(5분) 안에 사용량 보고가 없으면 reconciler가 `budget_reservations`(대화 호출은 `conversation_calls`도)의 `unknown_at`을 적는다. 상태는 `reserved`(`in_flight`) 그대로이고, 예약은 풀지 않고 쓴 것으로 센다. 늦은 보고가 실제 값으로 정산하고, lease 갱신과 해제는 표시를 지운다. 세션 호출과 대화 호출 모두 같다.
  - 끝을 모르는 예약이 많은 계정부터 배치 크기만큼 그 수와 묶인 금액이 `warn` 로그 `Budget reservations of unknown end held`에, 모든 계정의 합계가 `Budget reservations of unknown end reported`에 남는다. `Provider exchange ledger reconciled`와 `Conversation call reservations reconciled`에 `unknown_count`가 더해진다. 묶인 예약을 푸는 운영자 명령은 아직 없다.
  - root 종류 `none`(사람도 key도 없는 실행)은 80%에서, 사람과 key·Slack 봇의 요청은 100%에서 거절된다. 한도가 없는 계정에는 80% 판정이 없다.
  - 상태 값과 CHECK는 바뀌지 않는다. 지원 창 안의 이미지로 되돌려도 `unknown_at`은 무시되고 예약은 `reserved`로 정산된다.

- **스킬의 자동 승인이 화면의 '자동 연동' 스위치로 바뀌고, migration `0331_reset_skill_auto_approve`가 이미 켜졌거나 요청 중이던 자동 승인을 모두 끄고 `skill_git_sources`에 칸 `auto_approve_checks_grant_id`를 더한다**(JeongJaeSoon/werft#2055). 업그레이드한 뒤 자동 연동을 쓸 스킬마다 스킬 상세의 GitHub 동기화 구역에서 다시 켜야 한다. 다시 켜지 않으면 새 버전이 승인 대기로 쌓인다. 끈 수는 migration 로그(`db.migrate.notice`)에 `0331: auto-approve turned off on N GitHub skill sources`로 남고, 끈 것이 없으면 아무 줄도 남지 않는다.
  - 켜는 방법이 바뀌었다. 오너나 어드민 한 명이 화면에서 켜고 끈다. 다른 관리자의 동의는 필요 없다. 연동 대상이 브랜치이기만 하면 되고(태그와 커밋은 400 `not_branch`), GitHub의 브랜치 보호 규칙과 PR 리뷰는 보지 않는다.
  - 켜 두면 고정 규칙 검사를 통과한 버전이 사람의 승인 없이 승인되어 현재 버전이 된다. 규칙에 걸린 버전만 승인 대기로 남는다. 켜는 순간에도 한 번 확인해, 승인 대기로 있던 버전(처음 등록한 v1 포함)이 규칙을 통과하면 승인한다.
  - 그 브랜치에 push할 수 있는 사람과 App이 곧 스킬을 바꿀 수 있는 사람이 된다. 에이전트의 App이 그 저장소에 push할 수 있으면 에이전트도 포함된다. 누가 push할 수 있는지는 GitHub ruleset으로 정한다. 고정 규칙 검사는 스크립트가 조합하는 URL이나 base64 같은 내용을 걸러 내지 못한다.
  - 자동 연동을 켜지 않은 스킬은 지금과 같다. 새 버전은 승인 대기로 들어오고 사람이 승인한다.
  - API가 바뀐다. `PUT /v1/workspace/skills/{name}/sync/auto-approve`의 `action`은 `on`과 `off`만 받는다(`request`와 `consent`는 400). 응답의 `git.auto_approve`는 `{ state, enabled_by }`이고 `state`는 `off`나 `on`이다. `last_check.auto_approval`에서 `rule`과 `pull_request`가 빠지고, `reason`은 `checks_failed`와 `baseline_changed`만 남는다. `last_check.trigger.kind`에 `auto_approve`(자동 연동을 켤 때의 확인)가 더해진다. `PUT /v1/workspace/skills/{name}/sync`와 `…/sync/auto-approve`의 응답에 `check`가 더해진다. 그 호출이 돌린 확인이 끝났으면 `checked`, 돌고 있던 확인 뒤로 밀렸으면 `queued`, 확인을 돌리지 않았으면 null이다.
  - 칸 하나를 더하고 값을 바꾸는 migration이라 지원 창 안의 이미지로 되돌려도 된다(옛 이미지는 그 칸을 읽지도 쓰지도 않는다). 되돌린 이미지는 옛 방식(두 관리자의 요청과 동의, 리뷰된 PR)으로 동작하고, 꺼진 설정은 꺼진 채로 남는다. 되돌린 이미지나 올리는 동안 아직 떠 있던 옛 서버가 옛 방식으로 켠 자동 승인, 그리고 옛 서버가 멈췄다 다시 켠 스킬의 자동 연동은 이 버전에서 꺼짐으로 읽히고 아무것도 승인하지 않는다(새 칸은 이 버전만 쓴다). 쓰려면 화면에서 다시 켠다.

- **사람이 고른 적 없는 빈 값은 이제 GitHub push 승인을 묻지 않는다. 새 에이전트는 사람이 승인을 켜기 전까지 승인 없이 push한다**(JeongJaeSoon/werft#2061). migration은 없고 저장된 설정은 바꾸지 않는다. 판정을 읽는 방식만 바뀐다.
  - 승인 없음으로 바뀌는 것: GitHub 설정을 저장하지 않은 에이전트와 github 설정이 없는 release(핀이 `push_approval: false`인 release 포함), 첨부 저장소 push 정책이 비어 있는(NULL) 설정. 에이전트 GitHub 탭과 `GET /v1/agents/{id}/github`의 `push_attached`도 이 경우 `allow`로 보인다.
  - 그대로인 것: 사람이 켠 **push 전 사람 승인**, 정책 `ask`·`deny`, release 핀의 `push_approval: true`, 읽을 수 없는 설정(계속 사람에게 묻는다), push 승인과 정책 중 더 엄격한 쪽을 따르는 규칙.
  - 올리는 즉시 이미 도는 세션의 다음 push부터 적용된다. 데모 설치에서는 25개 에이전트(NULL 행 9, 설정 없음 16)가 승인 없이 push하게 된다. 사람 승인을 계속 받을 에이전트는 올리기 전에 GitHub 탭에서 **push 전 사람 승인**을 켜고 저장한다.
  - 지원 창 안의 옛 이미지로 되돌리면 빈 값이 다시 사람 승인으로 읽힌다(더 엄격해질 뿐이다).

- **API key는 `private_channel` 세션에 쓰기·승인도 못 한다. 요청자가 채널을 나간 push는 지금 채널 멤버가 승인·거절한다**(JeongJaeSoon/werft#2062). migration은 없고 따로 할 일도 없다.
  - 보이는 변화: 개인 key·에이전트 key로 `private_channel` 세션에 메시지, 대기 요청 답, push 요청·승인·거절, PR 열기·댓글, workflow 실행, 중단·재개·종료·인계 등 `/v1/sessions/{id}` 아래 모든 경로를 부르면 `404`다(읽기는 JeongJaeSoon/werft#2053부터 `404`). 판정 기록의 이유는 `private_channel_key`다. 세션 안에서 에이전트가 요청하는 push, key로 만든 세션, 공개 채널 세션은 그대로다.
  - push를 요청한 사람(그 push를 요청한 턴의 사람. 사람이 없으면 세션을 맡은 사람, 곧 시작한 사람이나 넘겨받은 사람)이 세션의 비공개 채널을 모두 나가면, Slack 승인 카드에 "요청자가 채널을 나갔어요"가 붙고 `session.approve`를 가진 지금 채널 멤버 누구나 승인·거절할 수 있다. 결정 기록(`decided_by`)에는 누른 사람이 남는다. 나간 요청자는 결정할 수 없고, 다시 들어오면 표시가 사라지고 원래 규칙으로 돌아간다. 카드는 채널 멤버 변화(`member_joined_channel`·`member_left_channel`) 때 다시 그려진다. 멤버인지 확인하지 못하면 원래 규칙을 쓰고 로그 `Push requester's channel membership unconfirmed`를 남긴다.
  - 도구 권한·질문 카드는 그대로다.
  - 카드의 새 표시 상태(`open_requester_left`·`reject_only_requester_left`)를 모르는 옛 이미지로 되돌리면, 그 카드를 끝난 카드로 보고 다시 그리지 않는다(버튼은 남고 누르면 그대로 판정된다).

- **migration `0330_judgment_buffer`가 입력 접수 표 `conversation_inputs`에 판단 버퍼의 만료 칸 `buffer_expires_at`과 그 색인을 더한다**(JeongJaeSoon/werft#2059). 따로 할 일은 없고 Slack 동작도 그대로다.
  - 판단 버퍼는 에이전트의 대화 층 스위치 `conversation_rollout`이 `shadow`·`on`이고 채널이 `free`로 듣는 때만 멘션 없는 글을 본문째 담는다. 스위치 기본값은 `off`이고 이 릴리스에는 스위치를 바꾸는 API가 없어서, 올린 뒤에도 버퍼는 비어 있다.
  - 담긴 줄은 10분 뒤 reconciler가 통째로 지운다(로그 `Judgment buffer purged`, `expired_count`·`unlistened_count`). Slack에서 글이 지워지면 바로, 채널 보관·삭제·봇이 나감·binding `off`·에이전트 보관 때도 바로 지운다. 글이 고쳐지면 담긴 본문만 바뀐다.
  - 줄을 고치지 않고 칸과 색인을 더하고 CHECK를 넓히기만 하므로 지원 창 안의 이미지로 되돌려도 된다. 다만 옛 reconciler는 버퍼 줄을 지우지 않는다(스위치를 켠 적이 없으면 버퍼 줄은 없다).

- **migration `0329_slack_outbox_voided_by_delete`가 outbox 상태 `voided_by_delete`와 칸 `sources_turn`을 더하고, Slack에서 지운 글에 걸린 답과 턴을 막는다**(JeongJaeSoon/werft#2058). 따로 할 일은 없고, 지운 글이 없는 Slack 멘션의 답과 웹·API 세션의 동작은 그대로다.
  - 출처(물려받은 것 포함)에 지운 글(묘비 포함)이 든 outbox 줄은 보내기 직전에 `voided_by_delete`(`error_code` `source_deleted`)로 끝나고 나가지 않는다. slack 역할이 `warn` 로그 `Slack send voided: a source was deleted`를 남긴다. 보내기 시작한 뒤의 삭제는 나간 글을 그대로 두고, 수정은 아무것도 막지 않는다.
  - 지운 글로는 세션을 만들거나 턴을 넣지 않는다. Slack에는 안내를 올리지 않고 `warn` 로그 `Slack input refused by the session`(`code` `SOURCE_DELETED`)만 남는다.
  - **보이는 변화**: 지운 Slack 글이 든 세션에 웹·API로 메시지를 보내면 409 `SOURCE_DELETED`로 거절된다.
  - CHECK는 `NOT VALID`로 더하고 따로 검증한다. 지원 창 안의 이미지로 되돌려도 된다.

- **migration `0328_conversation_calls`가 세션 없는 provider 호출(대화 호출)의 표 `conversation_calls`를 더하고, 세션 제목 짓기 호출과 실행 중인 턴이 없는 세션 호출을 그 세션을 만든 첫 턴의 예산 계정에 매긴다**(JeongJaeSoon/werft#2057). 따로 할 일은 없다.
  - 대화 호출은 토큰을 내기 전에 root의 계정에 그 호출의 최대 비용(요청 본문 바이트 상한과 `max_tokens`)을 예약하고, 토큰은 egress proxy를 지나는 Messages 호출 한 번에만 쓰인다. 2분 안에 쓰이지 않은 토큰의 예약은 reconciler가 푼다(로그 `Conversation call reservations reconciled`, `released_count`). 이 릴리스에는 대화 호출을 내는 경로가 없어서 표는 비어 있다.
  - 한도를 정하지 않은 설치에서는 제목 짓기 호출과 턴 사이의 호출이 지금처럼 돈다. 한도를 넣으면 이 호출들도 세션을 만든 사람(또는 key)의 계정에서 판정되고, 넘으면 제목은 첫 메시지에서 자른 것이 그대로 남는다.
  - egress proxy가 provider 허가 요청에 헤더 `x-werft-exchange-id`를 붙인다. 앞선 API는 이 헤더를 무시한다. 대화 호출 토큰은 이 헤더가 있어야 허가되므로 api와 egress proxy를 함께 올린다.
  - 새 표만 만들므로 지원 창 안의 이미지로 되돌려도 된다.

- **비공개 Slack 채널에서 시작한 세션은 새 공유 범위 `private_channel`로 생기고, 그 에이전트를 쓸 수 있는 지금 채널 멤버에게만 보인다**(JeongJaeSoon/werft#2053). migration `0327_private_channel_share_scope`가 `session_shares`의 범위 CHECK에 `private_channel`을 더한다. 따로 할 일은 없다.
  - 보이는 변화: API key(개인 key·에이전트 key 모두, key 주인이 멤버여도)로는 이 세션이 목록에 없고 상세·turns·events·outputs·pending-requests가 `404`다. 판정 기록에는 이유 `private_channel_key`로 남는다. 채널을 나간 만든 사람과 멤버가 아닌 owner·admin도 못 본다(사유를 적은 감사 읽기는 된다. 관리 목록 `/v1/admin/sessions`에는 메타데이터만 `share_scope: private_channel`로 남고, 관리 종료는 채널 밖에서 `404`다). 공유 범위를 바꾸려 하면 409(`reason_code: private_channel_session`)다.
  - 멤버 확인은 api와 slack 역할이 bot token으로 `conversations.members`를 읽고 5분 캐시한다(`groups:read`, 새 scope 없음). 확인하지 못하면(429·Slack 장애·bot이 채널 밖) 멤버에게도 숨긴다. 세션 목록은 `private_channel` 세션이 있는 채널마다 한 번씩, 동시에 8개까지 확인한다.
  - 개인 key의 사용량 합계(`scope=me`)에는 key 주인이 만든 `private_channel` 세션이 이름 없는 금액·개수로 들어간다. 세션을 가리키는 줄(도구 호출, 최근 성과)은 보이지 않는다.
  - 이 릴리스 전에 비공개 채널에서 만든 세션은 그대로 `workspace`다(옮기기는 다음 티켓).
  - 공개 채널·DM·웹·API로 만든 세션은 그대로다.
  - 지원 창 안의 옛 이미지로 되돌리거나 함께 돌리면, 옛 host는 `private_channel` 세션을 만든 사람에게만 보인다. 그동안 다른 채널 멤버는 잠깐 못 보고, 채널을 나간 만든 사람은 그 host에서 (자기 key로도) 계속 본다. 워크스페이스 전체로 넓어지지는 않는다.

- **migration `0326_link_posting`이 Slack 스레드의 게시 설정을 `session_links`의 칸 셋(`report_mode`·`mirror_instructions`·`post_prompts`)으로 나누고, 채널 binding에 `report_mode` 기본값 `per_step`을 더한다**(JeongJaeSoon/werft#2052). 따로 할 일은 없고, Slack에 올라가는 글의 종류와 횟수는 그대로다.
  - outbox는 이제 `visibility` 대신 새 칸을 본다(아직 옮기지 않은 `summary` link를 막을 때만 `visibility`를 읽는다). 답·실패·결과 알림은 `report_mode`(비면 채널 값), 웹·API 지시 거울은 `mirror_instructions`, 승인 카드·질문은 `post_prompts`다.
  - `full` link는 그대로 두고(기본값이 같은 뜻), `summary` link는 api 기동 때 도는 정리가 `none`·`false`·`false`로 옮긴다. 로그 `Summary session links moved`. 이 릴리스까지 `summary` link를 만드는 길은 없었다.
  - 칸을 더하기만 하므로 지원 창 안의 이미지로 되돌려도 된다. `visibility`는 뒤의 릴리스가 지운다.

- **migration `0325_channel_summaries`가 채널 요약 표 셋(`channel_summaries`, `channel_summary_lines`, `channel_summary_line_sources`)을 더한다**(JeongJaeSoon/werft#2054). 따로 할 일은 없고, Slack과 세션의 동작은 그대로다. 요약을 쓰는 길은 아직 없어서 표는 비어 있다.
  - 줄에는 에이전트가 쓴 글만 있고 Slack 글의 본문은 없다. 출처(글의 자리와 입력 접수 줄 id)와 화자는 서버가 입력 접수 줄에서 읽는다.
  - 바뀔 때마다 버전이 오르고 옛 버전은 되돌리기용 이력으로 남는다. 출처 글이 지워지거나 고쳐지면 그 줄을 모든 버전에서 지운다.
  - 요약 줄의 출처인 글의 삭제·수정 표식은 70분이 지나도 reconciler가 지우지 않는다.
  - 새 표만 만들므로 지원 창 안의 이미지로 되돌려도 된다.

- **migration `0324_source_sets`가 `turns`와 `slack_outbox`에 출처 집합 칸 `sources`(jsonb, nullable)와 GIN 색인 둘을 더한다**(JeongJaeSoon/werft#2048). 따로 할 일은 없고, Slack 멘션의 답과 웹·API 세션의 동작은 그대로다.
  - 출처 집합은 그 턴이 나온 Slack 글을 자리(team, 채널, ts)와 입력 접수 줄 id로만 적는다. 본문은 없다. 그 턴의 입력은 `direct`, 같은 세션 앞 턴들의 것은 `inherited`로 가른다. 한 집합은 256개까지 적고, 넘으면 `overflow`를 표시한다.
  - Slack 글로 생긴 턴과 그 세션의 뒤 턴(이어 가는 턴, push 후속 턴, 웹·API 지시), 그 턴의 답·실패 알림·승인 카드 줄이 출처를 갖는다. Slack과 무관한 웹·API 세션의 턴은 비어 있다.
  - 출처에 든 글의 삭제·수정 표식은 70분이 지나도 지워지지 않는다. 지운 출처로 답을 막거나 세션을 멈추는 동작은 아직 없다.
  - 칸은 기본값 없이 더하고 색인은 `CONCURRENTLY`로 만들어 표를 다시 쓰지 않는다. 있던 줄은 비어 있는 채로 남는다. 지원 창 안의 이미지로 되돌려도 된다.

- **migration `0323_conversation_engagements`가 관여 기록 표 `conversation_engagements`를 더하고, Slack 글이 세션의 턴이 될 때 그 글에 에이전트가 관여했다는 줄을 하나 적는다**(JeongJaeSoon/werft#2049). 따로 할 일은 없고, Slack과 세션의 동작은 그대로다.
  - 입력 접수 줄을 적는 같은 transaction에서 적는다. 줄에는 에이전트, 글의 자리(team, 채널, ts), 종류, 그 글이 든 세션만 남고 본문·스레드 ts·링크는 없다.
  - 종류: 세션을 연 멘션이나 DM은 `mention`, 멘션 없는 맨 위 글로 연 세션은 `reply`, 이미 열린 세션에 들어간 글은 `bound`.
  - 한 글이 두 이벤트로 와도, 다시 처리돼도 에이전트마다 한 줄이다. 있던 세션은 채우지 않는다.
  - 관여 기록이 있는 글의 삭제·수정 표식은 70분이 지나도 reconciler가 지우지 않는다.
  - 새 표만 만들므로 지원 창 안의 이미지로 되돌려도 된다.

- **provider 호출이 세션 한도와 함께 실행 중인 턴의 root 예산 계정에서도 잡히고, migration `0322_budget_root_slack_bot`이 root 종류에 `slack_bot`을 더한다**(JeongJaeSoon/werft#2050). 따로 할 일은 없다.
  - 한도를 정하지 않은 설치(`budget_limits` 행 없음)에서는 지금처럼 돈다. 원장에 호출마다 root 종류(`user`·`key`·`slack_bot`·`none`)와 계정이 남는다. root `none`(사람이 시키지 않은 에이전트 스스로의 일)은 한도가 없으면 거절되지만, 이 릴리스에는 그런 턴을 만드는 경로가 없다.
  - `budget_limits`에 한도를 넣으면 넘는 호출은 지금과 같은 `BUDGET_EXCEEDED`로 거절된다. 거절마다 API가 `info` 로그 `Provider exchange refused for the budget`(`turn_id`, `refused_by` `session`/`account`, `budget_root_kind`, `budget_account_id`)을 남긴다.
  - 요청자를 읽을 수 없는 턴, 세션 제목 짓기 호출, 실행 중인 턴이 없는 호출은 세션 한도만 본다. 제목 짓기 호출은 egress proxy가 open에 헤더로 알리므로 api와 egress proxy를 함께 올린다(proxy만 앞선 버전이면 그동안 제목 호출도 턴의 계정에 잡힌다). CHECK를 넓히기만 하므로 지원 창 안의 이미지로 되돌려도 된다.

- **에이전트 앱이 Slack 채널의 보관·보관 해제·이름 변경·삭제 이벤트 여덟 개를 받고, 삭제된 채널의 binding을 새 상태 `gone`으로 둔다**(JeongJaeSoon/werft#2047). migration `0321_channel_lifecycle`이 대화에 채널 상태·이름 칸을 더하고 binding 상태에 `gone`을, inbox 버림 이유에 `channel_gone`을 더한다.
  - **업그레이드 뒤 에이전트마다 콘솔 Slack 탭의 "다시 확인"(`POST /v1/agents/{id}/slack/app/events/recheck`) 또는 API 컨테이너의 `bun run apps/control-host/src/api/slack-app.ts finalize --agent <agent_id>`를 한 번 실행해야** 채널 삭제·보관·이름 변경 이벤트가 온다. 하지 않으면 삭제된 채널의 처리는 게시나 채널 조회가 `channel_not_found`를 받는 조회 실패 경로로만 동작한다(그때까지 binding은 `ready`로 남는다). 새 scope는 없다. 다시 보낸 manifest가 설치에 없는 scope를 요청하면 "다시 확인"도 응답의 `reinstall_required`와 콘솔 안내로 재설치를 알린다(JeongJaeSoon/werft#2056). [업그레이드 안내](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/upgrade-compose#slack-채널-이벤트와-manifest-다시-보내기)
  - 삭제된 Slack 채널을 에이전트의 채널 목록에 "삭제됨"으로 보인다. `gone` 채널은 글을 받지도 보내지도 않는다. 살아 있는 채널의 멘션·세션·답은 그대로다.
  - 이벤트를 놓친 채널도 게시나 채널 조회의 `channel_not_found`로 공개 채널은 `gone`, bot이 있던 비공개 채널은 `left`가 된다. 429·Slack 장애·token 오류로는 바뀌지 않는다.
  - `GET`·`PUT /v1/agents/{id}/slack-bindings`의 `status`에 `gone`이 생긴다.
  - 칸과 값을 더하기만 하므로 지원 창 안의 이미지로 되돌려도 된다. 다만 되돌린 이미지는 `gone` binding을 `left`처럼 막지 못하고 보통 줄로 읽는다.

- **migration `0320_session_parent_conversation`이 세션에 부모 대화 칸 `parent_conversation_id`(nullable)를 더하고, api가 기동할 때마다 Slack에 묶인 세션의 부모 대화를 채운다**(JeongJaeSoon/werft#2045). 따로 할 일은 없고, Slack·웹·세션 API의 동작은 그대로다.
  - 새 Slack 세션은 만들 때 채운다. 채널 스레드의 세션은 그 채널의 메인 대화, DM 세션은 그 사람의 DM 메인 대화다. link가 없는 세션(웹의 "새 세션", 세션 API)은 비워 둔다.
  - 있던 세션은 api 기동 때 한 번씩 도는 정리가 묶음으로 채운다. 닫히거나 폐기된 link의 세션도 채운다. 세션마다 비어 있을 때만 채우므로 다시 기동해도, 여러 api가 함께 기동해도 결과가 같고, 중간에 멈추면 다음 기동이 남은 세션부터 잇는다.
  - DM 세션의 사람은 그 세션을 연 사람, 없거나 워크스페이스 멤버가 아니면 link를 만든 사람이다. 새 세션이 만들 때 고르는 사람과 같다. 둘 다 없으면 부모를 비워 두고 로그 `Linked DM sessions left without a parent conversation`에 이유별 수(`no_person`·`no_membership`)를 남긴다. 채운 수는 `Parent conversations filled`, 채우지 못한 세션은 경고 로그에 세션 id와 함께 남고 다음 기동에서 다시 시도한다.
  - 세션의 요청자 칸(`requester_kind`)은 채우지 않는다.
  - 칸은 `NOT VALID`로 더한 외래 키를 따로 검증하므로 `sessions`를 오래 잠그지 않는다. 지원 창 안의 이미지로 되돌려도 되고, 그동안 만든 Slack 세션은 부모 없이 생겼다가 다시 올리면 채워진다.

- **migration `0318_provider_exchange_budget`이 provider 호출 원장 `provider_exchanges`에 예산 계정 칸 `budget_root_kind`·`budget_account_id`를 nullable로 더한다**(JeongJaeSoon/werft#2044). 따로 할 일은 없고 동작도 그대로다.
  - 이 릴리스에서는 어떤 호출도 계정을 넘기지 않으므로 두 칸은 비어 있고, 세션 비용 한도와 토큰 한도는 지금처럼 동작한다.
  - 칸을 더하기만 하므로 지원 창 안의 이미지로 되돌려도 된다.

- **migration `0317_binding_listen`이 채널 binding에 듣기 칸 `listen`(`free`·`mention`·`off`)을, 에이전트에 대화 층 스위치 `conversation_rollout`(`off`·`shadow`·`on`)을 더한다**(JeongJaeSoon/werft#2042). 따로 할 일은 없고 동작도 그대로다.
  - 있던 binding은 그 에이전트의 `slack_mention_only`가 `true`면 `mention`, `false`면 `free`로 채운다. 새로 만드는 binding은 `free`로 시작한다. `slack_mention_only`는 바꾸지 않고, 에이전트가 무엇에 반응하는지는 지금처럼 그 값과 binding의 `mode`가 정한다.
  - 모든 에이전트의 스위치는 `off`다. 이 릴리스의 받는 길은 두 칸을 읽지 않는다.
  - `GET`·`PUT /v1/agents/{id}/slack-bindings`의 binding에 `listen`이 생긴다. `PUT`에서 `listen`을 빼면 그 채널의 값을 그대로 둔다.
  - 칸을 더하기만 하므로 지원 창 안의 이미지로 되돌려도 된다.

- **migration `0319_web_inputs`가 입력 접수 표 `conversation_inputs`에 웹 입력의 칸 셋(`client_message_id`·`body`·`slack_mirror`)을 더하고 `turn_id`를 비워 둘 수 있게 한다**(JeongJaeSoon/werft#2046). 할 일은 없고 동작도 그대로다.
  - 웹에서 들어온 입력을 서버가 받는 즉시 입력 id·주제·요청자·순번을 정해 적는 접수 서비스가 생긴다. 이 릴리스에서는 이 서비스를 부르는 route가 없어 웹 입력 줄은 생기지 않는다. 웹 콘솔의 세션 시작과 메시지는 지금 길 그대로다.
  - 웹 입력 줄은 본문을 갖는다. Slack 접수 줄은 지금처럼 본문 없이 턴을 가리킨다. CHECK가 둘을 가른다.
  - 인덱스는 `CONCURRENTLY`로 만들고 CHECK는 `NOT VALID`로 더해 따로 검증하므로 쓰기를 오래 막지 않는다. 있던 줄은 모두 Slack 접수 줄이라 검증을 통과한다. 지원 창 안의 이미지로 되돌려도 된다.

- **migration `0314_budget_accounts`가 예산 계정 표 셋(`budget_limits`·`budget_accounts`·`budget_reservations`)을 빈 채로 만든다**(JeongJaeSoon/werft#2034). 따로 할 일은 없다.
  - 이 릴리스에서는 어떤 호출도 이 표를 읽거나 쓰지 않는다. 세션 비용 한도와 토큰 한도는 그대로이고, 한도를 정하는 화면·API·운영자 명령은 아직 없다.
  - 새 표만 만들므로 지원 창 안의 이미지로 되돌려도 된다.

- **migration `0313_session_link_history`가 `session_links`에 `closed_at`·`closed_reason` 칸과 닫히지 않은 link만 보는 부분 unique 둘을, `slack_outbox`에 `session_link_id` 칸을 더한다**(JeongJaeSoon/werft#2038). 이 릴리스의 코드는 새 칸을 아직 읽거나 쓰지 않으므로 할 일은 없고 동작도 그대로다. 있던 줄은 모두 닫히지 않은 link로 남고, 옛 unique 둘은 뒤의 릴리스가 지울 때까지 남는다. 인덱스는 `CONCURRENTLY`로 만들고 CHECK와 외래 키는 `NOT VALID`로 더해 따로 검증하므로 쓰기를 오래 막지 않는다. 지원 창 안의 이미지로 되돌려도 된다.

- **api가 멈추기 시작하면 열린 세션 이벤트 스트림(SSE)을 바로 끝내, 열린 스트림이 있어도 종료가 드레인 상한(35초)을 기다리지 않는다**(JeongJaeSoon/werft#2032). 할 일은 없다. stop grace는 그대로 두어도 된다.
  - api 재시작·재배포 때 콘솔과 SDK의 이벤트 스트림은 곧바로 끊기고, 새 api에 `Last-Event-ID`로 다시 붙어 놓친 이벤트 없이 이어진다. 이전에는 스트림이 드레인 상한까지 붙어 있다가 잘렸다.
  - 로그 `SSE stream closed`의 `reason`에 `shutting_down`이 생긴다. 열린 스트림 때문에 `Drain deadline passed` 경고가 나던 종료는 이제 `In-flight requests drained`로 끝난다.

- **Slack 글을 입력 접수 표 `conversation_inputs`에 적는다**(JeongJaeSoon/werft#2040). migration `0316_conversation_inputs`가 표를 만든다. 할 일은 없고, Slack과 세션의 동작은 그대로다.
  - slack 역할이 멘션·DM·묶인 스레드의 글을 지금처럼 턴으로 넣은 뒤, inbox 행을 처리됨으로 바꾸는 같은 transaction에서 접수 줄 하나를 적는다. 0310의 `conversations`·`conversation_topics`도 이때부터 채운다.
  - 접수 줄에는 글의 자리(team, 채널, ts), 주제 안의 순번(서버가 접수한 순서), 요청자, 그 글이 된 턴만 남고 본문은 없다. `message`와 `app_mention`으로 두 번 와도, 재전송돼도 에이전트마다 한 줄이다.
  - 접수 줄이 있는 글의 삭제·수정 표식은 70분이 지나도 reconciler가 지우지 않는다.
  - 지원 창 안의 이미지로 되돌리면 그동안의 글은 접수 줄 없이 턴만 생긴다.

- **대화 층의 빈 표 셋 `channel_contexts`·`conversations`·`conversation_topics`를 더한다**(JeongJaeSoon/werft#2023). migration `0310_conversation_scopes`가 만든다. 표를 더하는 일에는 할 일이 없고 동작도 그대로다. 표를 채우기 시작하는 것은 위 `conversation_inputs` 항목이다. 지원 창 안의 이미지로 되돌려도 영향이 없다.

- **Slack에서 글을 지우거나 고친 이벤트를 버리지 않고 그 글의 자리와 시각만 표식으로 남기며, migration `0312_slack_source_marks`가 표 `deleted_sources`·`edited_sources`를 더한다**(JeongJaeSoon/werft#2035). 따로 할 일은 없다.
  - `message_deleted`, 답이 달린 글을 지울 때 오는 묘비 `message_changed`는 삭제 표식, 사람이 고친 `message_changed`는 수정 표식이 된다. 글의 본문과 이벤트 원문은 저장하지 않고, inbox 행은 원문 없이 `processed`로 남는다. 같은 글이 지워지면 수정 표식은 지운다.
  - 표식은 만든 지 70분(판단 버퍼 10분과 1시간)이 지나면 reconciler가 지우고, 지운 수를 로그 `Unknown Slack source marks purged`에 남긴다.
  - 버린 이유 `message_subtype`으로 집계하던 질의는 수가 준다. 링크 미리보기처럼 사람이 고치지 않은 `message_changed`는 지금처럼 버린다.
  - 표를 더하기만 하므로 지원 창 안의 이미지로 되돌려도 된다.
- **Slack inbox(`slack_inbound_events`)가 처리를 마친 이벤트의 원문(`payload`)을 바로 지우고, 실패한 이벤트의 원문은 받은 지 7일이 지나면 reconciler가 지운다**(JeongJaeSoon/werft#2025). 따로 할 일은 없다.
  - migration `0308_slack_inbound_payload_check`가 CHECK를 바꾼다. 처리된 행과 실패한 행은 원문이 없어도 되고, 받은 행은 원문이 있어야 하고, 버린 행은 지금처럼 원문이 없다. 새 CHECK를 `NOT VALID`로 더해 검증한 뒤 옛 CHECK를 지우고, 인덱스는 `CONCURRENTLY`로 만든다.
  - 처리된 행의 원문을 읽던 진단 SQL은 이제 빈 값을 본다. 행(이벤트 종류·상태·버린 이유·시도 횟수)은 남는다. 이 릴리스 전에 처리한 행의 원문은 아직 남아 있다.
  - 이미지는 지원 창 안으로 되돌려도 된다. 원문을 지운 행이 생긴 뒤에는 옛 CHECK를 다시 걸 수 없으므로 0308 아래로 스키마를 내리지 않는다.

- **Slack 입력에서 자기 앱의 메아리와 Slackbot 글의 버린 이유가 바뀌고, migration `0307_slack_drop_fields`가 `slack_inbound_events`에 `drop_fields` 칸을 더한다**(JeongJaeSoon/werft#2026). 할 일은 버린 이유로 집계하는 대시보드나 질의를 맞추는 것뿐이다.
  - 에이전트 자신의 앱이 `bot_id`를 달고 쓴 글(에이전트의 답, 웹 콘솔에서 사람 이름으로 올린 지시)은 bot 허용 목록보다 먼저 `own_bot_user`로 버린다. 이전에는 허용 목록 규칙에 걸려 `bot_allowlist_empty`·`bot_not_allowed`·`bot_message`로 남았다.
  - Slackbot(`USLACK`)의 글은 DM이든 채널이든 새 이유 `slackbot`으로 버린다. 이전에는 Slackbot DM을 사람 DM으로 처리해 실패하는 계정 연결 안내를 outbox에 넣었고, 채널 글도 사람 글로 받았다.
  - 문에서 버린 줄의 `drop_fields`에는 보낸 쪽(`bot_id`·`app_id`·`user`)과 `subtype`·`message.subtype`만 남고 본문은 남지 않는다. 옛 줄과 slack 역할이 버린 줄은 비어 있다. CHECK는 `NOT VALID`로 더한 뒤 따로 검증하므로 검증 스캔 동안 쓰기를 막지 않는다(칸 추가와 CHECK 교체는 잠깐 잠금을 잡는다). 옛 이미지와 섞여 돌아도 된다.

- **migration `slack_channel_member_cache`가 Slack 비공개 채널 멤버 확인용 임시 캐시 표를 더한다**(JeongJaeSoon/werft#2033). 할 일은 없다. 표에는 Slack 사용자 id와 읽은 시각만 5분 동안 남고, reconciler가 지난 줄을 지운다(로그 `Expired Slack channel member lists deleted`). 백업에 이 표가 빠져도 복원 뒤 Slack에서 다시 읽는다. 아직 이 캐시를 읽는 화면이나 API는 없다.

- **보호 브랜치 자동 승인이 고정 규칙 검사에 걸린 스킬 버전에서 멈춘다**(JeongJaeSoon/werft#2024). 올린 뒤 자동 승인되던 스킬 버전이 승인 대기로 남을 수 있다. scripts·실행 파일 추가, 300줄 넘는 변경, 새 URL 호스트, 보이지 않는 유니코드, 지시처럼 보이는 문장, `description` 변경 중 하나라도 앞 승인 버전과 비교해 걸리면 그 스킬만 멈추고(`last_check.auto_approval.reason`: `checks_failed`), 같은 push의 다른 스킬은 그대로 자동 승인된다. 멈춘 버전은 스킬 상세의 "자동 승인" 행과 검토 화면 맨 위의 "고정 규칙 검사"에서 걸린 규칙을 보고 사람이 승인한다. 설정할 것은 없다.

- **API가 EGRESS 허용 목록을 proxy와 같은 방식으로 한 번 읽어, 올린 뒤 콘솔 경고와 collector 경고가 달라질 수 있다**(JeongJaeSoon/werft#2009). 설정 값은 그대로 두어도 된다. 경고가 새로 나오면 목록을 확인한다.
  - 모델 연결 콘솔의 "egress 허용 목록 밖" 경고가 워크스페이스 MCP 등록 검사와 같은 목록을 쓴다. `API.Anthropic.com:443`이나 `github.com.:443`처럼 대소문자나 끝의 점이 다른 항목, `[fd00::1]:8443` 같은 IPv6 항목에 맞는 주소는 이제 경고하지 않는다. 쉼표와 공백만 있는 값은 "목록을 모름"으로 읽어 어떤 주소에도 경고하지 않는다(이전에는 모든 주소에 경고했다). 등록이 `credential_allowlist_unset`으로 거절하는 것과 같다.
  - OTLP collector가 worker 허용 목록(`EGRESS_ALLOWLIST`·`EGRESS_PRIVATE_ALLOWLIST`)에 있다는 기동 경고 `tracing.collector_on_egress_allowlist`가 host 끝의 점을 무시한다. `collector.internal.:4318` 같은 항목에도 이제 경고가 나온다.
  - proxy가 기동을 거절하는 항목(포트가 없거나 1~65535의 정수가 아닌 항목)은 API도 버린다. 콘솔 목록에서 빠지고, 포트 없는 `collector.internal`에는 collector 경고가 더는 나오지 않으며, `[fd00::1:443]` 같은 항목이 `[fd00::1]:443` 등록을 허용하지 않는다.

- **스킬 버전의 `review`에 `superseded`(대체됨)가 생기고, 더 새로운 버전이 승인된 스킬의 승인 대기 버전은 올릴 때 대체됨으로 닫힌다**(JeongJaeSoon/werft#2019).
  - 새 버전이 승인되거나(사람의 승인, 동기화의 자동 승인) 되돌리기로 현재 버전이 되면, 그보다 순번이 작은 보관하지 않은 승인 대기 버전이 같은 transaction에서 `superseded`가 된다. 검토 목록과 승인 대기 수에서 빠지고, 버전 목록에는 '대체됨'으로 보인다. 관리자는 그 버전을 여전히 승인하거나 거절할 수 있고, 되돌리기는 지금처럼 승인된 버전만 고른다.
  - migration `0306_skill_superseded_versions`가 이미 쌓인 승인 대기 버전 가운데 같은 스킬에 순번이 더 큰 승인 버전이 있는 것만 `superseded`로 바꾼다. 그 승인은 receipt를 새로 쓰지 않는다. 바뀔 행 수는 올리기 전에 이 쿼리로 센다: `SELECT count(*) FROM extension_bundles AS old WHERE old.review = 'pending' AND old.archived_at IS NULL AND old.version IS NOT NULL AND EXISTS (SELECT 1 FROM extension_bundles AS newer WHERE newer.workspace_id = old.workspace_id AND newer.name = old.name AND newer.review = 'approved' AND newer.version > old.version);`
  - `GET /v1/workspace/skills` 응답의 `review` 값을 `pending`·`approved`·`rejected` 셋으로만 가정하는 API client는 `superseded`를 다루도록 고친다. 대체를 일으킨 `approve_extension`·`revert_extension` receipt의 `result.superseded`에 닫힌 버전의 id와 순번이 남는다. 알림은 없다.
  - rolling deploy 중 옛 replica에서 한 승인은 아무것도 닫지 않는다. 그 사이 승인한 스킬에 남은 오래된 대기 버전은 관리자가 거절하거나 승인해서 닫는다.

- **v0.1.0보다 앞선 설치만을 위한 경로가 없어진다. 그런 설치는 이 판으로 바로 올리지 못하므로, 먼저 이 판보다 앞선 release로 올려 옮긴다**(JeongJaeSoon/werft#2018). 호환 경로는 없다.

  - 파일 카탈로그 가져오기: `settings import|seed --from-dir`(이제 `Unknown option`), compose migrate의 `/legacy-config` 마운트와 `PLATFORM_LEGACY_CONFIG_DIR`, Helm migrate Job의 옛 `catalog` ConfigMap 마운트와 그 seed 단계. compose migrate는 `SETTINGS_DOCUMENT`가 있을 때만 `settings seed --document`를 돈다.
  - API·slack 역할은 남은 `PLATFORM_CONFIG_DIR`·`SESSION_CATALOG_JSON`으로 기동을 거부하지 않는다. 읽지 않고 뜬다. 정리하려면 지운다.
  - 설정 CLI(`settings import --document`·`seed`)는 GitHub App 없는 저장소 항목(`auth`가 없거나 `basic`·`bearer`)을 `note:`와 함께 빼지 않고, API import처럼 문서 전체를 거절한다. 진행 중 세션이 가리키는 저장소가 빠지면 거절하던 검사와, DB 행을 남기고 결과의 `kept`로 알리던 규칙도 없어졌다(결과에 `kept`가 없다). test-ops도 그 문서를 컨테이너를 띄우기 전에 같은 메시지로 거절한다.
  - test-ops는 `catalog_revision`만 적은 옛 `current.json`을 읽지 않는다(`manifest has unknown key catalog_revision`).
  - 백업·복원: 내장 Gitea 데이터가 든 백업을 exit 3으로 거절하던 검사와, 남은 `<project>_gitea-data` volume에 대한 `backup`·`reset` 경고가 없어졌다. 그런 백업의 `gitea/`·`repos/`는 복원하지 않고 무시한다.
  - local-docker: isolation contract 6보다 앞선 worker와 network를 위한 특별 처리(교체 전 확인이 실패한 contract 5 미만 worker를 공유 network에서 떼어 내기, contract 5 network의 host 주소 유예, worker 없이 남은 옛 network 재생성)가 없어졌다. contract 5 미만 worker는 다른 옛 contract 컨테이너처럼 stale로 교체되고, 확인이 실패하면 network에 붙은 채 다음 pass를 기다린다. launch와 교체 전 확인은 host 주소가 있는 network를 worker가 붙어 있든 없든 `gives the host an address on it`으로 거절하고 그 자리에서 다시 만들지 않는다. worker가 없어진 network는 `reconcileNetworks`가 지운다. 옛 worker가 남아 교체가 진행되지 않으면 운영자가 확인하고 그 컨테이너를 지운다.
  - quota label 없이 이름으로 찾던 옛 workspace volume(`werft-ws-<installationId>-<sessionId>`)을 찾지도, GC로 회수하지도, `migrate-workspace`의 원본으로 쓰지도 않는다. 남아 있으면 운영자가 확인하고 `docker volume rm`으로 지운다. `migrate-workspace`는 다른 quota로 만든 label 있는 workspace를 옮기는 데 그대로 쓴다.

- **Slack·GitHub 계정 연결의 일회용 state가 봉인된 cookie로 바뀌어, 올리는 순간 진행 중이던 연결은 한 번 실패한다**(JeongJaeSoon/werft#1997). `werft_slack_link`·`werft_github_link`의 값을 로그인 공급자 flow cookie와 같은 방식(AES-256-GCM, master key에서 뽑은 키)으로 봉인한다. 옛 형식의 cookie는 읽지 않으므로, 올리기 전에 연결을 시작해 동의 화면에 있던 사람은 callback에서 `400`(다시 시작 안내)을 받고 처음부터 다시 한다. 호환 경로는 없다. 데이터와 이미 연결된 계정에는 영향이 없다. Slack 연결도 이제 서버가 시작 뒤 10분을 검사한다(이전에는 브라우저의 cookie 만료에만 기댔다).

- **설치 카탈로그 MCP(설치 owner가 콘솔이나 설정 문서의 `mcp_servers`로 더하던 원격 MCP 서버)가 없어진다. 워크스페이스 MCP 서버로 옮기지 않는다**(JeongJaeSoon/werft#1998).
  - migration `0304_retire_catalog_mcp`가 카탈로그 행, 그 저장값, 에이전트의 카탈로그 선택을 지운다. migrate 로그 `db.migrate.notice`에 지운 서버의 수와 이름이 남는다(`0304: … catalog MCP servers retired (…)`). 계속 쓸 서버는 올리기 전에 이 이름을 적어 두고, 올린 뒤 워크스페이스 MCP 서버로 등록해 에이전트에서 고른다.
  - 비어 있지 않은 `mcp_servers`를 담은 설정 문서는 가져오기가 `400 invalid_document`로 거절한다. 보관한 내보내기 파일과 seed 문서에서 그 칸을 지운다.
  - `/v1/installation/settings/mcp-servers`와 `/v1/agents/{id}/mcp/settings` route가 없어졌다(`404`).
  - 옛 release의 세션은 그 서버 없이 돈다. 그 서버를 넣고 찍은 checkpoint도 복원된다. 대안이 16개 찬 세션은 가장 오래된 대안 하나의 checkpoint를 복원하지 못할 수 있다. 그러면 API 로그에 `claim.retired_catalog_restore_dropped` 경고가 세션 id와 함께 남는다. 그 서버가 쓰던 credential 이름의 묶음을 풀어도 세션은 시작된다.
  - rolling deploy 중 옛 replica가 카탈로그를 쓰면(가져오기·콘솔·카탈로그를 적은 카드 저장) DB가 거절한다. 올리는 동안 카탈로그를 바꾸지 않는다.

- **worker가 `packages`가 없는 bootstrap claim을 계약 위반으로 거절한다**(JeongJaeSoon/werft#1991). 지원 창 안의 control-host(`v0.3.0`부터)는 claim마다 `packages`를 보내므로, control-host를 먼저 올리는 순서를 지키면 할 일은 없다. `packages`를 보내지 않는 더 옛 control-host에 이 worker 이미지를 붙이면 세션이 시작하지 않는다. 그런 control-host를 만났을 때 HOME의 npm·Bundler·Go 설정을 지우던 동작도 없어졌다.

- **Slack 계정 연결(Sign in with Slack)이 로그인 공급자와 같은 주소 규칙과 id_token 검사를 받는다**(JeongJaeSoon/werft#1995).
  - API는 Slack에 https로만 요청한다. `slack.com`이 loopback·link-local·reserved 주소로 풀리면 보내지 않고 연결이 `503`으로 끝난다. 그런 DNS·프록시를 두었다면 올리기 전에 바로잡는다.
  - id_token은 `exp`·`iat`·`sub`가 있어야 하고, `aud`가 client 하나뿐이어야 한다. `iat`는 앞으로 60초, 뒤로 11분까지 받는다(이전에는 미래의 `iat`를 1초도 받지 않았다). 서버 시계가 크게 어긋나면 연결이 `400`으로 거절된다.
  - mock Slack 시험 스택은 `MOCK_SLACK_OIDC_ISSUER`의 host:port에만 평문 http와 사설 주소를 허용한다.
- **`HEARTBEAT_TTL_SEC`의 하한이 20초 초과에서 15초 초과로 내려가고, worker가 옛 API를 위해 하던 호환 재시도가 없어진다**(JeongJaeSoon/werft#1983).
  - 하한은 worker의 lease 안전 마진(10초)과 heartbeat 간격(5초)의 합이다. 10초마다 heartbeat를 보내던 옛 worker는 지원 창 밖이다. 그런 worker가 아직 돌 때 TTL을 20초 이하로 낮추면 그 attempt는 첫 heartbeat 무렵 lease를 잃는다. TTL을 낮추기 전에 옛 worker가 남아 있지 않은지 본다.
  - worker는 strict API가 400으로 거절한 release(`stop_kind`)와 pending-control(`settled[].reason`·`answer_result`)을 그 필드를 뺀 채 다시 보내지 않는다. 로그 `worker.release.stop_kind_refused`·`worker.pending.settlement_detail_refused`도 더 나오지 않는다. 지원 창 안의 API는 이 필드를 모두 받으므로, control-host를 먼저 올리는 순서를 지키면 할 일은 없다.
- **세션 제목 생성·Luna 판정·GitHub Packages token 확인 호출이 설정된 주소 밖으로 나가지 않는다. redirect를 따라가지 않고, 메타데이터·link-local 주소로 풀린 이름은 거절한다**(JeongJaeSoon/werft#1986).
  - 제목·판정 호출은 `SESSION_TITLE_EGRESS_URL`의 host:port(egress proxy)에만 간다. 사설 주소와 plain http는 계속 된다. 모델 서버 주소는 전처럼 proxy가 판단하므로, 사설 모델 서버 때문에 새로 설정할 것은 없다.
  - token 확인은 `GITHUB_PACKAGES_API_URL`의 host:port에만 간다. 기본값 `https://api.github.com`은 공인 주소로 풀릴 때만 부른다. 사내 DNS가 `api.github.com`을 사설 주소로 돌려주는 설치는 token 등록이 "확인할 수 없음"으로 실패한다. 이때는 `GITHUB_PACKAGES_API_URL`에 그 주소를 직접 적는다. 직접 적은 주소는 http이거나 사설 주소여도 된다.
  - `EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST`(workspace MCP 서버용)에 proxy를 넣을 필요는 없다. 넣지 않는다.

- **egress proxy와 API가 같은 IP 주소 판정을 쓴다. 경계 주소는 거절 쪽으로 바뀌었다**(JeongJaeSoon/werft#1987). 올리기 전에 allowlist에 둔 이름이 아래 주소로 풀리지 않는지 확인한다. 그런 이름이 있으면 그 목적지는 올린 뒤 `403`(proxy) 또는 `address_not_allowed`(API)가 된다.
  - egress proxy는 6to4(`2002::/16`), Teredo를 포함한 `2001::/23`, `2000::/3` 밖의 IPv6(`::a.b.c.d`, `::ffff:0:a.b.c.d`, `4000::/2` 등), `3fff::/20`, site-local `fec0::/10`를 reserved로 거절한다. 이전에는 6to4와 `::a.b.c.d`를 안에 든 IPv4로 판정했고, 나머지는 public(`fec0::/10`은 private)으로 통과시켰다. `EGRESS_PRIVATE_ALLOWLIST` 목적지도 `fec0::/10`로 풀리면 거절된다.
  - API의 IdP·모델 공급자·워크스페이스 MCP 요청은 앞자리가 0인 IPv4 답(`010.0.0.1`)을 거절한다. 이전에는 `10.0.0.1`로 읽었다.
  - 연결의 `billing: none`과 저장소 `api_base`의 http 허용에서 link-local(`169.254.0.0/16`, `fe80::/10`)이 사설 주소에서 빠졌다. 그런 endpoint의 연결은 콘솔에서 더할 때와 설정 문서로 seed할 때 거절된다. egress proxy는 link-local에 닿지 않으므로 이 연결은 원래 동작하지 않았다. IPv6 안에 쓴 IPv4(`::ffff:10.0.0.1` 등)는 계속 사설로 보지 않는다.
- **`BOOTSTRAP_TOKEN`·`BOOTSTRAP_TOKEN_FILE` 환경 값과 Helm `secrets.bootstrapToken`이 없어졌다. 첫 owner는 운영자가 받은 일회용 설정 링크로 만든다**(JeongJaeSoon/werft#1979).
  - Helm values에 `secrets.bootstrapToken`이 남아 있으면(`true`든 `false`든) render가 멈춘다. values에서 지우고 Secret의 `BOOTSTRAP_TOKEN`도 지운다.
  - compose·test-ops env 파일의 `BOOTSTRAP_TOKEN`은 어느 컨테이너에도 가지 않는다. 지운다.
  - 링크는 live owner가 없을 때만 `bun run apps/control-host/src/api/setup-link.ts`(api 컨테이너·Pod 안. test-ops는 `scripts/test-ops.sh setup-link`)가 stdout에 한 번 출력한다. 로그나 파일에는 남지 않는다. 24시간 뒤 만료되고, 다시 실행하면 앞 링크는 무효가 된다. `scripts/test-ops.sh bootstrap-token`은 `setup-link`로 바뀌었다.
  - `POST /v1/auth/bootstrap` 본문의 `bootstrap_token`이 `setup_token`으로 바뀌었다. 옛 필드만 보낸 요청은 `401`이다. 링크를 확인하는 공개 route `POST /v1/auth/setup-link/check`(살아 있으면 `204`, 아니면 `401`)가 더해졌다.
  - 로그인 화면의 첫 owner 링크가 없어졌다. `/bootstrap`은 살아 있는 링크로 열었을 때만 폼을 보인다.
  - owner를 모두 잃었을 때의 복구도 같은 링크로 한다. migration `0300_setup_links`가 `setup_links` 표를 더한다. 쓴 토큰을 적던 `bootstrap_token_uses` 표는 더 읽거나 쓰지 않고 남겨 둔다.
  - rolling deploy 중 옛 replica는 링크를 모르고 새 replica는 옛 토큰을 받지 않는다. 첫 owner 만들기와 복구는 모든 api가 새 이미지로 바뀐 뒤에 한다.
- **에이전트 release가 없는 열린 세션은 올린 뒤 API가 기동할 때 닫힌다**(JeongJaeSoon/werft#2028). 기동할 때마다 남은 것을 다시 찾으며, 요청을 받는 것과 함께 뒤에서 돌므로 요청을 받기 전에 끝난다는 보장은 없다. release를 요구하기 전에 접수된 세션이라 어떤 worker도 맡지 못하고 열린 채 남아 있던 것이다. recovery close와 같은 방식으로 닫힌다(대기 입력은 `SESSION_CLOSED`로 취소되고, 기다리던 제어 receipt는 `CONTROL_SUPERSEDED`로 실패한다). 닫은 수가 API 로그 `Sessions without an agent release closed` 한 줄로 남는다. 닫지 못한 세션은 세션 id와 함께 경고로 남고 다음 기동에서 다시 시도한다. 대상이 없으면 아무 일도 일어나지 않는다. 할 일은 없고, 그런 세션을 따로 보고 있었다면 로그를 확인한다.
- **에이전트 slug 유일 색인이 지우지 않은 에이전트만 보는 부분 색인(`WHERE deleted_at IS NULL`)으로 바뀐다. 그래서 rolling deploy 중이나 되돌린 뒤 옛 코드에서는 에이전트 생성이 실패한다**(JeongJaeSoon/werft#1807).
  - 원인: 옛 replica의 `ON CONFLICT`에는 `WHERE`가 없어서 PostgreSQL이 맞는 색인을 찾지 못한다.
  - 대처: 모든 api replica가 새 이미지로 바뀔 때까지 에이전트를 만들지 않는다.
  - 되돌릴 때: 지운 에이전트와 같은 slug가 다시 쓰이지 않았다면 migration `0290`의 색인을 전체 유일 색인으로 되돌린다.
  - 이번 판의 `DELETE /v1/agents/{id}`는 행을 지우지 않는다. 대신 에이전트를 보관하고, 그 에이전트의 surface 바인딩·신원·에이전트 API 키를 같은 트랜잭션에서 회수한다. 기존 세션은 그대로 읽힌다.
  - 같은 트랜잭션에서 그 에이전트 전용 Slack 앱의 signing secret·client secret·bot token을 지운다.
  - 앱 행과 Slack 쪽 앱은 남는다. Slack에서 앱을 없애려면 따로 지운다.
- **변수·워크스페이스 MCP 서버·GitHub App·로그인 공급자·로그인 방법·Slack config token을 지우면 행이 `deleted_at`·`deleted_by`와 함께 남는다. 비밀은 지울 때 같이 없어진다**(JeongJaeSoon/werft#1796). migration `0289`가 여섯 표에 두 열을 더하고, 이름·issuer·App id·subject의 UNIQUE를 지우지 않은 행만 보는 부분 index로 바꾼다. `slack_config_tokens`는 새 `id` PK를 받는다. 롤링 배포 중 앞선 api replica는 지운 행을 걸러 내지 않으므로 새 replica가 지운 것을 다시 보여 줄 수 있고, 로그인 공급자 생성은 500으로 실패한다. 모든 replica가 바뀌면 해당 없다. 되돌릴 때는 앞선 판이 지운 행을 살아 있는 행으로 읽으므로, 먼저 여섯 표에서 `DELETE … WHERE deleted_at IS NOT NULL`로 지운 행을 없앤다.
- **워크스페이스·에이전트의 실행 규칙(허용·묻기·막기 목록, 자동 모드 목록)이 없어졌다. 저장해 둔 규칙은 새 세션에도, 이미 도는 세션의 다음 claim에도 더는 적용되지 않는다**(JeongJaeSoon/werft#1798). 규칙으로 막던 도구나 묻던 명령이 있었다면 올린 뒤에는 권한 모드와 플랫폼의 작업 공간 규칙대로만 돈다. 올리기 전에 저장된 규칙을 확인한다. MCP 도구 하나를 막는 방법은 에이전트 카드의 `capabilities.tool_policy.per_tool`에 `deny`를 적는 것뿐이다.
  - **없어진 API:** `GET|PUT /v1/workspaces/{id}/engine-settings`, `GET|PUT /v1/agents/{id}/engine-settings`. 이 경로를 부르던 client는 `404`를 받는다. 콘솔의 워크스페이스 설정 **실행 규칙** 카드와 에이전트 상세의 **실행 규칙** 탭도 없어졌다.
  - DB의 `workspace_engine_settings`·`agent_engine_settings` 표와 `sessions.engine_settings_start` 열은 데이터를 지우지 않도록 그대로 두고 더는 읽거나 쓰지 않는다. migration은 없다. 지난 저장의 receipt는 그대로 읽힌다.
  - worker는 `engine_settings` capability를 더는 알리지 않고, 앞선 control-host가 보낸 `runtime_config.engine_settings`도 엔진에 넘기지 않는다. 그래서 control-host를 먼저 올리고 worker 이미지를 바꾼다. worker를 먼저 바꾸면 묻기·패턴 막기·자동 모드 규칙을 저장해 둔 워크스페이스·에이전트의 세션은 앞선 control-host가 재시도 가능한 503으로 claim을 거절해, control-host가 바뀔 때까지 시작하지 않고 기다린다.

- **Claude 모델의 새 release는 `auto` 권한 모드로 돈다. 연결의 자동 모드 판정과 그 API는 없어졌다.** Claude 모델은 `anthropic` 연결의 모델, 또는 `litellm` 연결에서 `claude-`·`anthropic/claude-`로 시작하거나 `sonnet`·`opus`·`haiku`·`fable`(`[1m]`이 붙어도 된다)과 정확히 같은 모델 id다. 그 밖의 모델(`my-sonnet-proxy`처럼 계열 이름을 품기만 한 id 포함)과 Codex 연결(`openai_responses`)은 `default`다. 세션의 모델이 다음 판으로 옮겨 가면 모드도 새 모델로 다시 정한다. 자동 모드는 그것을 지원하는 모델에서만 동작한다([Claude Code의 자동 모드 요건](https://code.claude.com/docs/en/permission-modes#eliminate-prompts-with-auto-mode)). 이미 만든 release는 고정된 모드를 지키므로, 다시 release할 때까지 원래 모드로 돈다.
  - **`auto`도 `default`와 같은 작업 공간 규칙을 받는다.** `git`·`gh`, `sed`, 작업 공간 안 쓰기·`mkdir`, 조회는 분류기 없이 실행되고, 묻기 목록(비밀 경로, `git --output`, 비밀 이름의 `git add` 등)에 걸린 호출은 분류기가 아니라 사람에게 권한 요청으로 간다. 그래서 `auto` 세션에도 사람이 답할 권한 요청이 생길 수 있다. `bun run`·`npm run`·`npx` 같은 스크립트 실행은 엔진이 `auto`에서 허용을 빼므로 분류기가 판정한다. 분류기를 쓸 수 없는 연결에서는 분류기가 판정할 호출이 거부된다.
  - **엔진 설정은 인자가 아니라 파일로 넘긴다.** worker는 엔진을 시작할 때마다 합친 설정(플랫폼 기본값, 자동 모드 규칙)을 체크아웃 밖의 `$CLAUDE_CONFIG_DIR/launcher-settings.json`(이미지에서는 `/home/bun/.claude/launcher-settings.json`)에 새로 쓰고 그 경로를 `--settings`로 준다. 파일에는 그 파일 자신의 편집을 막는 deny 규칙(`Edit(~/…)`, `Edit(//…)`)이 함께 들어가고, 세션 중에 바뀌어도 다음 엔진 시작 때 다시 쓴다. 그래서 설정 크기에 걸던 엔진 인자 한도(100 000바이트)는 없어졌다.
  - `--fake-model` 스택의 `fake-messages`는 자동 모드의 안전 검사에 언제나 허용으로 답하므로, 그 스택의 예시 release도 `auto`로 돈다. 사람에게 권한을 묻는 것은 묻기 규칙에 걸린 호출뿐이라, 문서 예제의 권한 요청 단계는 `tee` 대신 묻기 규칙에 걸리는 `sed -n "w …"`로 파일을 쓰고, 데모 데이터의 권한 요청 세션은 작업 공간 규칙의 묻기에 걸리는 명령을 쓴다.
- **Codex 세션이 작업 공간 규칙의 허용 명령(`git`, `gh`, `sed`, `mkdir`, `bun`·`npm`·`pnpm`·`yarn`의 `test`·`run`)을 묻지 않고 실행한다.** 앞선 판은 이 명령마다 사람에게 물었다. 묻기 목록 중 Codex 규칙(명령 앞쪽 토큰의 prefix)으로 표현되는 모양만 계속 묻고, 나머지(`git log --output=x`, `git add secret.env`, `git config alias.x …`, `sed -n "w …"` 등)는 묻지 않고 실행된다. 이 허용은 sandbox 밖에서 돈다. 목록과 이유는 [에이전트 권한](https://jeongjaesoon.github.io/werft/ko/agents/permissions/)의 자율 모드 절에 있다. 저장소의 `.codex/rules`는 더는 읽지 않는다(앞선 판에서는 저장소 규칙이 명령을 허용할 수 있었다).
  - **없어진 API:** `POST /v1/installation/settings/connections/{id}/auto-mode`와 연결 응답의 `auto_mode` 필드. 이 경로를 부르던 client는 `404`를 받는다. 콘솔 설정 → 모델 연결의 **자동 모드 판정** 버튼도 없어졌다.
  - DB의 `provider_connections.auto_mode` 열은 데이터를 지우지 않도록 그대로 두고 더는 읽거나 쓰지 않는다. migration은 없다. 지난 판정의 `set_connection_auto_mode` receipt는 그대로 읽힌다.
- **모델 연결·MCP 서버·저장소별 GitHub App 키는 DB 저장값(`"stored": true`)만 쓴다. 환경 변수(`value_env`)와 Secrets Manager(`secret_id`) 참조는 없어졌고, api는 Secrets Manager를 읽지 않는다**(JeongJaeSoon/werft#1784). 값은 콘솔이나 `POST /v1/installation/settings/{connections|mcp-servers|repositories}/{id}/credential`로 넣고, `PLATFORM_SECRET_KEY`로 암호화해 둔다. 할 일은 다음과 같다.
  - 올리기 전에 env나 Secrets Manager를 가리키는 모델 연결마다 지금 릴리스 콘솔의 **화면에서 키 넣기**로 키를 넣어 두면 끊기지 않는다. MCP 서버와 저장소 App 키는 지금 릴리스에서 옮길 길이 없으니, 올린 뒤 바로 키를 넣는다(아래).
  - 사용 중지한 연결·MCP 서버가 아직 env나 Secrets Manager를 가리키면 올린 뒤 다시 켤 수 없다. 콘솔은 사용 중지한 행의 키를 받지 않고, 키 없는 행을 켜지 않는다. 그 연결을 계속 쓰려면 올리기 전에 켜고 **화면에서 키 넣기**로 키를 넣는다. MCP 서버는 올리기 전에 켜 두고 올린 뒤 키를 넣는다. 아니면 올린 뒤 새 id로 연결이나 서버를 만든다. id는 다시 쓰지 않는다.
  - migration `0288_remove_external_credentials`가 env·Secrets Manager를 가리키던 행을 값 없는 저장 행(`needs_value`)으로 바꾼다. 옛 `auth`는 `carried_auth`에 기록으로만 남는다. 명시적 App 저장소의 binding이 바뀌므로, worker 저장소 토큰의 binding은 같은 migration이 새 binding으로 옮기고, push 요청의 binding은 그 저장소의 키를 넣을 때 옮긴다(push 요청 표는 커지는 표라 migration 안에서 고치지 않는다). 키를 넣기 전에는 올리기 전에 만든 push에서 PR을 열 수 없다. 앞선 api replica가 받은 키는 push를 옮기지 않으므로, 저장소 App 키는 모든 api가 새 이미지로 바뀐 뒤 넣는다(먼저 넣었다면 한 번 더 넣는다). 키를 넣을 때까지 `needs_value` 행을 쓰는 세션은 돌지 않는다. 연결과 MCP 서버는 콘솔에서, 저장소 App 키는 `POST /v1/installation/settings/repositories/{id}/credential`(owner·admin, RSA 개인 키 PEM, 웹 화면 없음)로 넣는다.
  - 설정 문서의 `value_env`·`secret_id` 항목은 다시 가져오기 전에 `"stored": true`로 바꾼다. 가져오기(API, CLI, `--from-dir`)는 그 필드를 `400 invalid_document`로 거절하고, CLI는 필드 이름을 적는다.
  - Helm values에서 `secrets.catalogEnv`와 `config.aws.secretsManagerEndpointUrl`을 지운다. 남아 있으면 render가 멈춘다. `catalogEnv`에 `BOOTSTRAP_TOKEN`을 넣었다면 그것도 지운다(첫 owner는 설정 링크로 만든다. 위 항목).
  - compose의 api env에서 연결 키 변수(`ANTHROPIC_API_KEY` 등)와 `AWS_ENDPOINT_URL_SECRETS_MANAGER`를 지운다.
  - 키 없이는 저장하지 않는다. 콘솔은 8자를 넣기 전까지 저장 버튼을 켜지 않고, API는 8바이트 미만이거나 제어 문자·앞뒤 공백이 있는 값을 `400`으로 거절하며, DB도 CHECK와 trigger로 막는다. 연결 화면의 "화면에서 키 넣기" 버튼과 `POST /v1/installation/settings/connections/{id}/convert`는 없어졌다. v0.3.0의 0285 되돌리기 SQL은 이 릴리스 뒤에는 쓸 수 없다([외부 자격 증명 출처를 없앤 릴리스](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/upgrade-compose#외부-자격-증명-출처를-없앤-릴리스)).

- **에이전트가 켠 워크스페이스 MCP 서버를 세션이 쓴다. 그런 서버가 있는 세션은 새 worker 이미지(capability `workspace_mcp`)만 claim한다**(JeongJaeSoon/werft#1759). 앞선 worker는 그 세션을 claim하면 재시도 가능한 503(`BACKEND_UNAVAILABLE`)을 받고, 아무것도 묶이지 않는다. 그래서 control-host를 먼저 올리고 worker 이미지를 바꾼다. 바뀔 때까지 그런 세션은 시작하지 않고 기다린다. 워크스페이스 서버가 없는 세션은 앞선 worker도 그대로 claim한다. 새 worker를 앞선 control-host에 붙이면 control-host가 모르는 key를 거절하고, worker는 그 key를 빼고 다시 claim한다. 서버 호출은 proxy를 거쳐 등록한 URL로 가고, 저장된 관리자 자격(OAuth access token 또는 정적 token)이 Bearer로 붙는다. 그러므로 서버의 host:port를 proxy와 api 둘 다의 `EGRESS_CREDENTIAL_ALLOWLIST`(로컬 시험 서버는 `EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST`)에 넣는다. compose는 두 쪽에 같은 값을 준다. api 목록에 없으면 등록이 거절되고, proxy 목록에만 없으면 등록은 되지만 호출이 proxy에서 막힌다. 요청 줄은 등록한 경로와 query 그대로다. 보내는 `tools/call`은 `accepted` `call_mcp` receipt에 서버 이름·연결 generation·도구를 남기고, 그 receipt를 쓰지 못하면 보내지 않는다. 거절된 호출은 같은 receipt에 이유(`workspace_server_unavailable`, `oauth_needs_reauth`, `credential_unavailable`)를 남긴다. 세션은 시작 때의 서버 이름·URL로 고정되므로, 세션 중에 지우거나 URL을 바꾼 서버는 그 세션에서 `workspace_server_unavailable`로 거절되고 다음 세션부터 새 URL을 쓴다. 이 PR에는 migration이 없다(열과 표는 JeongJaeSoon/werft#1754의 0287). 되돌리면 앞선 control-host는 워크스페이스 서버를 claim에 싣지 않으므로, 그 세션은 서버 없이 돈다. 이 판이 만든 checkpoint는 앞선 판에서 config가 달라 resume하지 못하고 새로 시작한다.

- **엔진 설정 `permissions.deny`의 `mcp__<서버>__*`가 그 서버의 MCP 도구를 모두 막는다. 앞선 빌드는 이 규칙을 도구 이름 하나로 보고 아무것도 막지 않았다**(JeongJaeSoon/werft#1757). 워크스페이스·에이전트 엔진 설정에 이미 `__*`로 끝나는 `mcp__` deny를 저장해 두었다면, 올린 뒤 그 서버(내장 `github` 포함)의 `tools/call`이 모두 거절된다. 저장된 엔진 규칙은 호출마다 판정하므로 세션 도구 목록(claim, `tools/list`)에는 도구가 남는다. 막혔는지는 목록이 아니라 호출 결과로 본다. 올리기 전에 저장된 규칙을 본다. 롤링 배포 중에는 앞선 api replica가 여전히 막지 않으므로, 모든 api replica가 새 이미지로 바뀐 뒤에 효과가 있다. 에이전트 MCP 설정의 허용 도구에 `__*`로 끝나는 이름을 새로 저장하는 일은 이제 `tool_outside_server`로 거절된다. 이미 저장된 그런 이름은 그대로 남고 도구 하나의 이름으로만 비교된다. migration은 없다. 되돌리면 와일드카드 deny는 다시 아무것도 막지 않는다.

- **Helm: checkpoint object store 설정은 `config.aws`·`config.checkpoints`·`secrets.objectStoreKeys`에서만 받는다. 어느 role의 `extraEnv`, `config.limits`, `secrets.catalogEnv`에 `AWS_`나 `CHECKPOINT_OBJECT_`로 시작하는 이름이 있으면 render가 멈춘다**(JeongJaeSoon/werft#1745). 앞선 chart는 `extraEnv`를 그 role에만 넣었다. 그래서 `api.extraEnv`로 바꾼 bucket·endpoint·`CHECKPOINT_OBJECT_STORE`는 api에서만 이기고, checkpoint GC·세션 보관 CronJob과 scheduler는 chart 값으로 돌았다. `CHECKPOINT_OBJECT_STORE`와 `CHECKPOINT_OBJECT_ENCRYPTION_CHECK`는 새 values `config.checkpoints.objectStore`(기본 `s3`)·`config.checkpoints.encryptionCheck`(기본 `enforce`)로 넣는다. 이제 api와 두 CronJob이 같은 값을 받는다. 그 밖의 `AWS_` 이름(`AWS_ENDPOINT_URL_S3`, `AWS_ROLE_ARN`, `AWS_PROFILE` 등)은 chart로 넣을 길이 없다. IRSA role은 api ServiceAccount의 annotation으로 준다. render가 멈추면 hook도 돌지 않으므로 설치는 그대로다. 올리기 전에 `api.extraEnv`의 값이 chart 값과 달랐는지 본다. 달랐다면 세션 보관 job이 api가 읽지 않는 저장소로 이벤트를 옮기고 DB 행을 지웠을 수 있다. 그 이벤트는 설정을 맞춘 뒤에는 읽지 못하므로, 앞선 chart의 CronJob으로 restore를 먼저 돌린다. 옮길 곳과 절차는 업그레이드 문서에 있다. 이 이름을 values에 두지 않은 설치는 할 일이 없다. Pod env에 `CHECKPOINT_OBJECT_STORE=s3`·`CHECKPOINT_OBJECT_ENCRYPTION_CHECK=enforce`가 더해질 뿐이고, 읽는 쪽의 기본값과 같다. Compose는 바뀌지 않는다. migration은 없다. 되돌리면 앞선 chart는 두 새 values를 읽지 않아 api와 두 CronJob이 기본값(`s3`, `enforce`)으로 돈다. `helm rollback`은 그 revision의 values로 돌아가므로 옛 `api.extraEnv`와 함께 앞선 갈라짐도 돌아온다. 되돌린 동안에는 보관 CronJob을 멈춘다([object store 설정을 한 곳에서 받는 릴리스](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/upgrade-kubernetes#1-대상-chart와-제어-영역-우선-교체)).

- **멈춘·일시 정지한 세션의 workspace(Docker volume, Kubernetes PVC) 보존 시간도 env가 아니라 설정 > 워크스페이스 > 실행 한도 "멈춘 세션의 작업 공간"·"일시 정지한 세션의 작업 공간"에서 owner가 저장한다. migrate가 `EXECUTION_WORKSPACE_STOPPED_TTL_SEC`·`EXECUTION_WORKSPACE_PAUSED_TTL_SEC`를 한 번 옮겨 담고, scheduler는 이 env를 읽지 않는다**(JeongJaeSoon/werft#1744). 옮기는 방식과 로그는 아래 실행 한도 항목과 같다. Compose의 scheduler는 두 env를 받지 않고(앞선 `:-86400` 기본값도 없앴다), 두 값은 `.env`·호스트 env에서 migrate에만 넘어간다. scheduler에 overlay로 넘기던 값은 올리기 전에 `.env`로 옮기거나 올린 뒤 화면에서 저장한다. Helm은 두 키를 scheduler가 읽던 대로 `scheduler.extraEnv`가 `config.limits`보다 이기게 골라 migrate Job에 넣고, `api.extraEnv`의 두 키는 옮기지 않는다. `config.limits`의 두 키는 이제 scheduler에 들어가지 않는다. `scheduler.extraEnv`의 값은 scheduler Pod에도 그대로 남지만 읽히지 않는다. 아무것도 넣지 않은 설치는 앞선 기본값(각 86400초)을 쓴다. 범위는 0–315360000초(3650일)다. 앞선 릴리스는 상한이 없었으므로 그보다 긴 값, 그리고 앞선 scheduler가 거절하던 값(빈 문자열·공백, 소수, 음수)은 옮기지 않고 그 키를 막는다. 앞선 릴리스와 달리 scheduler의 시작은 멈추지 않는다. 둘 중 하나라도 막혔거나 설정을 읽지 못하는 동안 scheduler는 `stopped`·`paused` 세션의 workspace를 둘 다 새로 회수하지 않는다(로그 `Workspace TTLs cannot be read; keeping every stopped and paused session's workspace`). 끝난 세션의 workspace, 앞선 pass가 마치지 못한 회수, launch는 그대로 한다. 화면에서 값을 저장하면 다음 pass부터 다시 만료를 센다. migration은 없다. 되돌리면 앞선 scheduler는 env(compose 기본 86400초, Helm `scheduler.extraEnv`)만 읽으므로, 화면에서 보존 시간을 늘려 두었다면 되돌리기 전에 그 값을 `.env`나 `scheduler.extraEnv`에 옮겨 적는다. 그러지 않으면 앞선 scheduler가 더 일찍 volume을 지우고, checkpoint 없는 `stopped` 세션의 volume에만 남은 작업은 사라진다([데이터별 보존](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/reference/storage/#데이터별-보존)).
- **세션 이벤트 보관의 기간과 세기만/실제로 옮기기도 env가 아니라 설정 > 워크스페이스 > 실행 한도 "세션 기록 보관"에서 owner가 저장한다. migrate가 `SESSION_ARCHIVE_AFTER_DAYS`·`SESSION_ARCHIVE_DRY_RUN`을 한 번 옮겨 담고, 보관 job은 실행마다 DB에서 두 값을 읽는다**(JeongJaeSoon/werft#1743). 옮기는 방식과 로그는 아래 실행 한도 항목과 같다. Compose의 `maintenance`는 두 env를 받지 않고, 두 값은 `.env`·호스트 env에서 migrate에만 넘어간다. `maintenance`에 overlay로 넘기던 값은 올리기 전에 `.env`로 옮기거나 올린 뒤 화면에서 저장한다. Helm은 `sessionArchive.afterDays`·`dryRun`의 chart 기본값(180, `true`)을 지웠다. 설치 values에 적은 값만 migrate Job에 들어가고(`0`·`false`도 값이다), 보관 CronJob은 두 값을 받지 않는다. 앞선 chart는 범위 밖 `afterDays`에서 렌더를 멈췄지만, 이제는 렌더가 되고 migrate가 그 키를 막는다. 아무것도 넣지 않은 설치는 앞선 기본값(180일, 세기만)을 쓴다. 앞선 판이 거절하던 값(날짜는 숫자만, dry run은 `true`·`false`·`1`·`0`만)은 옮기지 않고 그 키를 막는다. 막힌 동안 보관 job은 아무것도 옮기지 않고 `Session archive refused: its settings cannot be read`(키 이름만)를 남기고 1로 끝난다. Compose의 `maintenance` 루프는 종료 코드를 보지 않으므로 이 로그로 본다. `restore`는 설정을 읽지 않아 키가 막혀 있어도 돈다. 화면은 API의 object store 설정으로 보아 보관할 수 없는 설치(`disabled`·`unversioned`)이면 그렇다고 알린다. migration은 없다. 되돌리면 앞선 빌드는 env·values만 읽으므로, 되돌리기 전에 화면의 두 값을 `.env`(Helm `sessionArchive.afterDays`·`dryRun`)에 옮겨 적는다. 그러지 않으면 앞선 빌드가 자기 기본값이나 남은 옛 값으로 보관한다([세션 이벤트 보관](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/reference/storage/#세션-이벤트-보관)).
- **turn 시간과 provider 재시도도 env가 아니라 설정 > 워크스페이스 > 실행 한도에서 owner가 저장한다. migrate가 `MAX_TURN_SECONDS`·`PROVIDER_MAX_RETRIES`를 한 번 옮겨 담고, api·scheduler는 이 env를 읽지 않는다**(JeongJaeSoon/werft#1742). 옮기는 방식과 로그는 바로 아래 항목과 같다. Compose의 `x-installation-limits`에는 `EXECUTION_SLOT_LIMIT`만 남고, 두 값은 `.env`·호스트 env에서 migrate에만 넘어간다. api·scheduler에 overlay로 넘기던 값은 올리기 전에 `.env`로 옮기거나 올린 뒤 화면에서 저장한다. Helm은 values에 남은 `config.limits`의 두 키를 migrate Job에만 넣고, chart의 `config.limits` 기본값에서 두 키를 뺐다. 두 키는 scheduler가 읽던 대로 `scheduler.extraEnv`가 `config.limits`보다 이기고, `api.extraEnv`의 두 키는 옮기지 않는다. 아무것도 넣지 않은 설치는 앞선 기본값(3600초, 2회)을 쓴다. 옮긴 값이 떠 있는 worker의 값과 같으면 올린 뒤에도 그 worker는 그대로 돈다. scheduler는 pass마다 콘솔 값을 읽어 그 pass가 예약하는 launch에 고정한다. 값을 바꾸면 다른 값으로 뜬 worker 가운데 쉬고 있는 것은 바로 내려가고, turn을 돌고 있는 것은 받은 값으로 그 turn을 마친 뒤 내려간다. 값을 고정하기 전에 예약된 launch는 컨테이너·Pod env의 값으로 견주고, 그 env도 읽지 못하는 claim된 worker의 drain 기한은 turn 시간이 가질 수 있는 가장 긴 값(604800초) + 5분이다. 범위를 벗어난 env 값(예: `MAX_TURN_SECONDS=0`)은 앞선 릴리스와 달리 api·scheduler의 시작을 멈추지 않는다. 옮기지 않고 그 키를 막으며, 막힌 동안 scheduler는 새 launch를 예약하지 않고(로그 `Launches skipped: the worker limits cannot be read`) 값을 고정하기 전에 예약된 launch도 다시 만들지 않는다(`Launch held: …`). `GET /v1/limits`·`GET /v1/sessions/{id}/usage`도 `503`이다. 화면에서 값을 저장하면 풀린다. migration은 없다. 되돌리면 앞선 빌드는 env를 읽으므로(없으면 compose·chart 기본값), 화면에서 바꾼 값을 쓰려면 env·values에 다시 넣는다([웹으로 옮긴 실행 한도](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/upgrade-compose#웹으로-옮긴-실행-한도)).
- **세션 비용·토큰, 대기 메시지, 입력 보관, 작업 공간 용량 한도는 env가 아니라 설정 > 워크스페이스 > 실행 한도에서 owner가 저장한다. migrate가 `SESSION_COST_LIMIT_USD`·`SESSION_TOKEN_LIMIT`·`QUEUED_INPUT_LIMIT_PER_SESSION`·`STORAGE_LIMIT_BYTES`·`WORKSPACE_ENFORCE`를 한 번 옮겨 담고, 어느 role도 이 env를 읽지 않는다**(JeongJaeSoon/werft#1734). migrate는 schema migration 뒤, 어느 role보다 먼저 저장한 값이 없는 키에만 env 값을 옮기고 값 없이 `note:` 줄을 남긴다. 워크스페이스가 있으면 작성자 없는 감사 기록(`by: "env_import"`)을 남긴다. 빈 값은 넣지 않은 것으로 본다. Compose는 `.env`·호스트 env의 이 값을 migrate에만 넘기므로, api·scheduler에 overlay로 넘기던 값은 올리기 전에 `.env`로 옮기거나 올린 뒤 화면에서 저장한다. Helm은 values에 남은 `config.limits`의 네 키와 `api.workspaceEnforce`를 migrate Job에만 넣는다. `api.extraEnv`의 같은 이름도 migrate Job에 넣고(같은 이름이 둘이면 `api.extraEnv`가 이긴다), api Pod에도 그대로 남지만 api는 읽지 않는다. values의 `api.workspaceEnforce: warn` 기본값을 뺐다. 아무것도 넣지 않은 설치는 앞선 기본값과 같은 값을 쓴다. 모든 role을 이 버전으로 올린 뒤 env·values의 그 줄을 지운다. 남아 있으면 migrate가 돌 때마다 `Ignored removed settings` 줄이 나온다. 저장한 값은 env가 바꾸지 않는다. 범위를 벗어난 값은 옮기지 않는다. 앞선 릴리스는 시작을 멈췄지만, 이제는 시작한 뒤 화면에서 값을 저장할 때까지 그 키를 읽는 일만 `503 BACKEND_UNAVAILABLE`로 거절한다. 세션 한도 네 키(비용·토큰·대기 메시지·입력 보관) 중 하나라도 막히면 새 세션과 메시지, `GET /v1/limits`·`GET /v1/sessions/{id}/usage`가 거절된다. 세션 비용이나 토큰이 막히면 scheduler는 launch를 건너뛴다. 설정을 60초 넘게 읽지 못할 때(DB 장애)도 같다. 같은 `Idempotency-Key`로 다시 보낸 요청은 막힌 동안에도 저장한 답을 받는다. 낮춘 비용 상한은 실행 중인 세션의 다음 provider 호출부터, 올린 상한은 다음 claim부터 걸린다. 이미 떠 있는 worker는 claim 때 받은 작업 공간 용량 정책을 계속 쓴다. `PENDING_REQUEST_TTL_SEC`도 이제 API 첫 기동이 아니라 migrate가 옮기고, Helm은 `api.extraEnv`의 그 값을 migrate Job에 넣는다. `v0.2.0` 이상에서 이미 옮긴 설치는 할 일이 없다. 되돌릴 때 `installation_config` 표는 지우지 않는다. 화면에서 바꾼 값을 되돌린 빌드에서도 쓰려면 env·values에 다시 넣는다([웹으로 옮긴 실행 한도](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/upgrade-compose#웹으로-옮긴-실행-한도)).
- **게시 chart의 기본 worker 이미지가 그 릴리스의 Claude·Codex 두 이미지 목록(`images.workers`)으로 바뀐다. 패키지의 `images.worker`는 비어 있고, Helm values의 `images.workerCodex`는 없어졌다**(JeongJaeSoon/werft#1737). 새 설치는 두 엔진의 세션을 함께 띄운다. 올리기 전에 단일 이미지를 유지할지 목록으로 바꿀지 정한다. 두 절차 모두 [Kubernetes 업그레이드](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/upgrade-kubernetes)에 있다. control-host를 먼저 바꾸는 1단계는 두 설치에 같다.
  - 단일 이미지를 유지하려면 values에 `images.workers: []`와 `images.worker`의 repository·digest·runtime을 적는다. 값은 대상 chart의 `files/release-images.json`에서 얻는다. 1단계의 `next_workers control`과 2단계의 `worker.json`이 이 값을 만든다. Codex 이미지를 배포하는 설치는 2단계의 `ENGINE`을 `codex`로 둔다.
  - 목록으로 바꾸려면 [이미지 목록 설치의 upgrade](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/upgrade-kubernetes#이미지-목록-설치의-upgrade)를 따른다. 2단계는 대상 chart의 `files/next-workers.jq final`로 만든 목록을 넘긴다. 처음 바꿀 때는 `KNOWN`에 배포된 이미지(있으면 직전 이미지도)의 `releasedAt`을 적고, runtime 없이 배포했다면 runtime도 적는다(JeongJaeSoon/werft#1731).
  - 이 절차 없이 올리면 결과는 설치에 따라 다르다. values에 `images.worker`를 적은 설치는 render에서 실패한다(`set images.workers: [] to deploy images.worker alone`). hook과 migration은 돌지 않는다. 적지 않은 설치는 목록 설치로 바뀌고, 지금 이미지를 직전 이미지로 남기지 않는다. 지금 이미지의 checkpoint를 목록의 이미지가 복원하지 못하면(엔진·SDK·CLI가 다르거나 runtime 없이 배포한 이미지) 업그레이드 전 검사가 승인할 수 없는 `refused`로 멈춘다.
  - values에 적은 목록은 기본 목록과 합쳐지지 않는다. Helm이 목록을 통째로 바꾸기 때문이다. 목록 설치는 릴리스마다 같은 절차로 새 목록을 만든다. 그러지 않으면 새 릴리스의 worker 이미지가 들어가지 않는다.
  - `images.workerCodex`를 읽던 스크립트는 같은 chart의 `files/release-images.json`이나 release manifest의 `images["worker-codex"]`·`workerCodexRuntime`·`workerCodexReleasedAt`을 읽게 바꾼다. 셋 다 그대로 남는다.
- **`MAX_TURN_SECONDS`·`PROVIDER_MAX_RETRIES`는 launch가 예약될 때 그 launch에 고정되고 격리 stamp에서 빠진다. 값을 바꿔도 worker가 한꺼번에 교체되지 않는다**(JeongJaeSoon/werft#1739). 전에는 둘 중 하나를 바꾸면 모든 worker가 stale이 됐다. claim된 worker는 새 `MAX_TURN_SECONDS` + 5분 기한으로 drain됐고, claim되지 않은 worker는 교체 횟수를 쓰며 다시 만들어졌다. 이제 claim된 worker는 받은 값으로 지금 turn을 마친 뒤 내려가고, 기한은 그 worker의 turn 시간 + 5분이다. claim되지 않은 launch는 반납되고 세션이 새 값으로 다시 예약한다(경고 `Launch was reserved with other worker limits`, pass 로그 `launch_limits_changed_count`). 다른 사유(격리 계약, 회수된 이미지)의 drain 기한도 그 worker가 받은 turn 시간으로 잰다. 올릴 때 할 일은 없고 migration도 없다. 앞선 판이 만든 컨테이너·Pod는 그 값이 지금 값과 같으면 그대로 쓴다. 되돌리면 앞선 판은 이 판이 만든 컨테이너·Pod를 모두 stale로 보고 한 번씩 교체한다. claim된 것은 turn을 마친 뒤 교체한다([turn 시간과 재시도를 바꿀 때](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/explanation/isolation#turn-시간과-재시도를-바꿀-때)).
- **모델 연결의 "사용할 모델"은 공급자가 알려 준 목록에서 체크해 고른다. 그래서 api가 연결의 key로 공급자의 `GET /v1/models`를 직접 부르고, 그 호스트는 api의 `EGRESS_CREDENTIAL_ALLOWLIST`(사설 서버는 `EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST`)에 있어야 한다**(JeongJaeSoon/werft#1773). Compose와 Helm은 proxy와 api에 같은 목록을 주고 기본값에 `api.anthropic.com:443`·`api.openai.com:443`이 있으므로, 기본값을 쓰는 설치는 할 일이 없다. 목록을 바꿔 쓰는 설치, 그리고 LiteLLM·호환 서버를 쓰는 설치는 그 endpoint의 `host:port`가 api 쪽 목록에도 있는지 본다. 없으면 화면이 그 이유(`host_not_allowed`, 목록이 비면 `credential_allowlist_unset`)를 보이고 목록을 읽지 않으며, 저장된 모델은 그대로 둔다. 모델 이름을 손으로 적던 입력 칸은 없어졌다. 공급자가 목록을 주지 않는 경우에도 이미 저장된 모델은 체크된 채 남고 저장할 수 있지만, 새 이름을 손으로 더할 수는 없다. 그런 연결은 API(`POST /v1/installation/settings/connections/{id}/models`)로 넣는다. 이 route는 이름을 그대로 받는다. migration은 없다. 되돌리면 앞선 화면의 입력 칸이 돌아오고, 이 판이 저장한 목록은 그대로 쓰인다.
- **계정 연결 거절 응답 여덟 가지(`BAD_REQUEST`·`SLACK_NOT_INSTALLED`·`LINK_TEAM_MISMATCH`·`LINK_TAKEN`·`LINK_EXISTS`·`GITHUB_LINK_NOT_CONFIGURED`)의 `error.message` 첫 문장 끝맺음이 합니다체로 바뀐다(예: "연결돼 있어요" → "연결돼 있습니다")**(JeongJaeSoon/werft#1893). `code`·HTTP 상태·`retryable`은 그대로다. 이 글을 글자로 비교하는 연동이 있으면 `code`로 판단하게 바꾼다. migration은 없다.
- **쓰지 않는 표 `catalog_authority`·`owner_workspace_map`·`push_continuations`를 행째 지운다**(JeongJaeSoon/werft#2010). migration `0305_drop_unused_tables`가 지운다. `v0.1.0` 이후 어느 릴리스도 앞의 두 표를 읽거나 쓰지 않았고, `push_continuations`를 쓴 마지막 릴리스는 `v0.1.1`이므로 지원 창 안의 이미지는 영향이 없다. 다만 표에 행이 남아 있을 수 있다. `catalog_authority`에는 설정 파일 카탈로그 시절에 활성화한 revision 한 행, `owner_workspace_map`에는 운영자가 손으로 넣은 owner와 워크스페이스의 매핑, `push_continuations`에는 `v0.1.1` 이하가 만든 이어 턴 기록이다. 행이 있으면 migrate 로그 `db.migrate.notice`에 표마다 지운 행 수가 남는다(`0305: dropped rows: …`). 그 행이 필요하면 올리기 전에 백업한다. 0305 아래로 스키마를 내려도 행은 돌아오지 않는다.
- **Slack에서 push를 승인·거절한 뒤의 후속 턴이 에이전트의 턴이 되고, 누른 사람의 세션 입력 권한을 더는 보지 않는다**(JeongJaeSoon/werft#2037). 전에는 그 턴의 보낸 사람이 길에 따라 달랐다. 실행 중인 턴을 기다렸다 넣으면 push를 요청한 사람, 바로 넣으면 버튼을 누른 사람이었다. 이제 두 길 모두 요청자가 그 세션의 에이전트(`requester.kind: "agent"`, `auth_method: "push_decision"`)이고 사람 칸(`actor_id`)은 비어, 화면에서 보낸 사람이 사람 이름이 아닌 일반 라벨로 보인다. 그 턴이 세션의 마지막 턴인 동안 commit은 App만으로 귀속된다. PR에 적는 "요청한 사람"은 push를 요청한 턴에서 읽으므로 바뀌지 않는다. 승인·거절은 push 결정 권한만 보므로, 세션 입력 권한이 없는 승인자가 눌러도 후속 턴이 생기고 누른 사람 이름의 메시지 추가 receipt는 생기지 않는다. 같은 push 요청의 후속 턴은 세션에 하나만 생긴다. 세션의 상태 검사(일시 정지, 인수 대기, 체크포인트, 입력 한도)는 그대로다. migration은 없다. 되돌리면 앞선 판은 이 판이 넣은 후속 턴을 요청자 없는 턴으로 읽는다.
- **새 턴마다 요청자가 들어온 자격(인증 근거)을 남기고, 턴 읽기 API(`GET /v1/sessions/{id}/turns`, `GET /v1/sessions/{id}/turns/{turn_id}`)가 `requester`(`kind`·`id`·`auth_method`·`carried`)를 돌려준다**(JeongJaeSoon/werft#2027). migration `0315_turn_requester_auth`가 `turns.requester_auth`(jsonb)와 `tool_call_audits.requester_kind`·`requester_id`(text)를 더한다. 셋 다 nullable이고 기본값·색인·backfill이 없어 표를 다시 쓰지 않는다. 올릴 때 할 일은 없다. 근거는 콘솔 로그인 세션 id, 개인 key id, 에이전트 key의 에이전트, Slack 설치와 연결 계정이고, key의 비밀·cookie·Slack 사용자 id는 담지 않는다. 승인 뒤 이어 가는 턴은 멈췄던 턴의 요청자와 근거를 물려받는다(`carried`가 true). 옛 턴은 고치지 않아 `requester`나 `auth_method`가 null로 보인다. 감사 행의 두 칸은 이 릴리스에서 비어 있다. 되돌리면 앞선 판은 새 칸을 읽지도 쓰지도 않는다([턴에 요청자의 인증 근거를 남기는 릴리스](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/upgrade-compose#턴에-요청자의-인증-근거를-남기는-릴리스)).
- **Slack 사용자 id(`U…`·`W…`)를 channel로 가진 outbox 줄은 모델 안내만 넣을 수 있고, 다른 줄은 넣기에서 거절되며 Slack에 보내지 않는다**(JeongJaeSoon/werft#2029). migration `0309_slack_outbox_channel`이 CHECK `slack_outbox_channel_check`를 더한다. 어느 릴리스도 그런 줄을 쓰지 않았으므로 보통은 할 일이 없다. 그런 줄이 남아 있으면 migrate 로그 `db.migrate.notice`에 수가 남고(`0309: … slack_outbox rows name a Slack user as their channel`) migrate가 `VALIDATE CONSTRAINT`에서 멈춘다. 그 줄을 지우고 다시 돌린다([사람에게 바로 가는 Slack 글을 막는 릴리스](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/upgrade-compose#사람에게-바로-가는-slack-글을-막는-릴리스)).

## v0.3.0

`v0.2.0` 뒤 `main`에 들어간 변경이다. 한 배포가 Claude와 Codex 세션을 각자 엔진의 worker 이미지로 함께 띄우고, worker 이미지 목록의 항목을 철회할 수 있다. env로 가리키던 자격 증명은 DB에 한 번 옮긴 뒤 env를 다시 읽지 않고, 설정 문서는 빈 설치에만 한 번 넣는다. 두 변경 모두 올릴 때 자동으로 옮겨져 기존 실행은 이어진다. 하지만 env나 문서를 고쳐 다시 배포하던 운영 방식이 더는 반영되지 않고, 자격 증명 이관을 되돌리려면 SQL이 필요하다. 그래서 minor 버전을 올린다. migration `0282`–`0285`가 있으므로 올리기 전에 DB를 백업하고 아래 "운영자가 할 일"을 모두 읽는다.

### 운영자가 할 일

- **api는 설정의 `value_env`를 env에서 읽지 않는다. 연결·자기 GitHub App을 적은 저장소·MCP 서버의 그 값을 처음 읽을 때 DB에 봉인해 한 번 옮긴다**(JeongJaeSoon/werft#1721). migration `0285_credential_carried_auth`가 세 표에 `carried_auth`(옛 `auth`, 되돌리기용)를, `catalog_repositories`에 `carried_binding`(옮기기 전후 binding)을 더하고 명시적 App 저장소가 저장값을 갖게 CHECK를 바꾼다. 옮긴 행마다 api 로그에 `… took its credential from <이름> into the database and no longer reads it; remove <이름>`이 남고 receipt `set_settings_credential`(`by: env_import`, 이름만)이 쌓인다. 그 뒤 변수를 빼도 된다. 올릴 때 env에 값이 없는 행은 옮기지 못해 빠지고 경고가 한 번 남는다. 변수를 넣고 다시 띄운다. 실행 경로가 거절할 값(8바이트 미만 등, RSA PEM이 아닌 App 키)과 8자 미만인 키도 옮기지 않고 빠지며 경고가 한 번 남는다. 첫 워크스페이스가 생기기 전에는 env에서 읽는다. 명시적 App 저장소는 옮기면 binding이 바뀌므로, 같은 트랜잭션에서 옛 binding을 그대로 가진 push 요청과 실행 중 세션의 저장소 토큰을 새 binding으로 옮긴다(옮긴 수는 로그와 receipt `rebound`). 옮김을 아직 읽지 않은 replica나 앞선 빌드가 그 뒤 옛 binding으로 쓰는 행은 `push_requests`·`worker_credentials`의 INSERT trigger가 새 binding으로 적는다. 옮기기 전의 push로도 PR을 열고 병합할 수 있다. 이 릴리스로 올릴 때는 api를 하나로 줄이거나 옛 replica를 모두 내린 뒤 새 빌드를 띄운다(Helm은 기본 replica가 여럿이라 업그레이드 1단계 전에 `--replicas=0`으로 내리고 `--set api.replicas=1`을 더한다). 아직 옮김을 읽지 않은 replica가 그 사이 push를 `catalog_changed`로 실패시킬 수 있고, 그 push는 다시 요청하면 된다. 그 App 키는 이제 `POST /v1/installation/settings/repositories/{id}/credential`(owner·admin, RSA 개인 키 PEM)로 바꾼다. 옮긴 뒤 옛 문서를 손으로 `settings import`하면 옮긴 항목이 `conflicts`로 멈춘다. URL 저장소(`basic`·`bearer`)는 옮기지 않는다. 되돌리면 앞선 빌드가 명시적 App 저장소의 저장값을 거절하므로, 이 릴리스의 api replica를 모두 내린 뒤 아래 링크한 업그레이드 문서 절의 되돌리기 SQL을 한 트랜잭션으로 돌려 `carried_auth`·`carried_binding`에서 행과 binding을 되돌리고, 변수를 env에 다시 넣어 앞선 빌드를 띄운다. replica가 하나라도 살아 있으면 되돌린 행을 다시 옮긴다([env로 가리키던 자격 증명은 DB로 한 번 옮긴다](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/upgrade-compose#env로-가리키던-자격-증명은-db로-한-번-옮긴다)).
- **세션은 자기 엔진의 worker 이미지로 뜨고, 이미지 목록이 두 엔진을 받는다**(JeongJaeSoon/werft#1719). 엔진을 바꾼 단일 env 배포(`WORKER_IMAGE`와 `WORKER_IMAGE_PREVIOUS`의 엔진이 다르다)에서는 옛 엔진의 세션이 checkpoint가 없어도 직전 이미지로 뜬다. 지금까지는 새 엔진 이미지로 떠서 실행되지 못했다. 직전 이미지를 비우려면 옛 엔진의 세션이 모두 끝나야 한다. `WORKER_IMAGES`·`images.workers`는 엔진마다 철회되지 않은 이미지를 둘까지 받고, `released_at` 순서는 같은 엔진 안에서만 본다. 두 엔진 목록은 scheduler·API·Slack role을 모두 이 버전으로 올린 뒤에 준다. 옛 버전은 그 목록을 거부해 기동하지 않으므로, 되돌릴 때는 먼저 목록을 엔진 하나로 줄인다. 목록에 세션 엔진의 이미지가 없으면 checkpoint 없는 세션은 slot 없이 기다리고(scheduler 로그 `waiting_for_engine_count`), checkpoint가 있는 세션은 `incompatible_checkpoint`로 멈춘다. 한 엔진의 이미지를 모두 빼는 업그레이드는 아래 항목대로 검사된다.
- **Kubernetes 업그레이드 전 검사가 엔진마다 판정하고, 한 엔진의 이미지를 모두 빼는 upgrade는 그 엔진의 열린 세션을 승인 목록(`no_engine_image`)에 올린다**(JeongJaeSoon/werft#1724). 대상이 이미지를 하나라도 적은 엔진은 남는 엔진이고, 그 엔진의 배포된 가장 새 이미지는 지금처럼 승인 없이 보호된다. 하나도 적지 않은 엔진은 그 보호를 건너뛰는 대신, 닫히지 않은 그 엔진의 세션을 checkpoint가 없어도 `affected`에 `no_engine_image`로 올린다. runtime kind를 모르거나 없는 열린 세션도 같다. 그래서 그런 upgrade는 지금까지 오르지 않던 세션 때문에 `refused`가 될 수 있고, 그 목록을 `upgrade.approvedSessions`에 정확히 넣어야 통과한다. 그 엔진의 launch가 slot을 쥐고 있으면 승인으로 넘길 수 없다. 엔진이 하나뿐인 배포와 runtime 없이 배포된 이미지가 있는 배포의 판정과 문구는 그대로다. scheduler는 이미지 목록에 자기 세션 엔진의 철회되지 않은 이미지가 없는 claim 전 launch를 다시 만들지 않고 돌려보낸다(검사와 rollout 사이에 예약된 launch). 그런 launch와 철회된 이미지의 launch가 claim 없이 끝나도 launch 실패로 세지 않으므로, 격리되거나 대기 입력이 `LAUNCH_FAILED`로 실패하지 않는다. 되돌리려면 그 엔진의 이미지를 목록에 다시 넣는다. 기다리던 세션은 다시 뜨고, `incompatible_checkpoint`로 멈춘 세션은 `retry_restore`로 다시 시도한다([엔진을 빼는 upgrade](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/upgrade-kubernetes#3-검사-결과와-예외)).
- **worker 이미지 목록의 항목을 철회(`retracted: true`)할 수 있다. 철회한 이미지로는 새 launch를 하지 않고, 이미 떠 있는 launch도 내린다**(JeongJaeSoon/werft#1716, JeongJaeSoon/werft#1727, JeongJaeSoon/werft#1720, JeongJaeSoon/werft#1723, JeongJaeSoon/werft#1718). `retracted`를 쓰지 않으면 동작이 같다. checkpoint가 없는 세션은 자기 엔진의 철회되지 않은 가장 새 이미지로 뜬다. checkpoint가 있는 세션은 철회되지 않은 이미지 중 엔진·SDK·CLI가 같고 그 checkpoint의 digest scheme을 복원하는 이미지로 뜬다. 철회한 이미지에서 다른 이미지로 옮기는 launch는 세션 이벤트에 `system` 이벤트(subtype `worker_image_replaced`)를 남기고, 연결된 세션 생성자에게 Slack DM을 보낸다. checkpoint를 복원하는 이미지가 철회된 것뿐이면 세션은 `runtime_retired`로 멈추고, 생성자에게 Slack DM이 간다. worker가 붙은 launch는 진행 중인 turn이 끝난 뒤 내려간다. 기한(turn 최대 시간 + 마무리 여유)을 넘기면 기다리지 않는다. 그때 끊긴 turn은 기존 drain 정책대로 `recovery_required`가 될 수 있다. 목록의 이미지가 모두 철회되면 checkpoint 없는 세션은 launch를 기다린다. 그런 세션은 세션 상세 `attention`에 새 code `NO_WORKER_IMAGE`로 보인다. attention code로 분기하는 클라이언트는 이 값을 함께 처리한다. 앞선 빌드는 `retracted`를 모르는 필드로 거부해 기동하지 않으므로, 되돌리기 전에 목록에서 `retracted` 항목을 뺀다. 목록에서 뺀 이미지를 registry에서 지워도 되는지는 문서의 절차로 판단한다(JeongJaeSoon/werft#1729, [옛 worker 이미지 지우기](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/upgrade-kubernetes#옛-worker-이미지-지우기)).
- **migrate는 설정 문서와 옛 설정 디렉터리를 빈 설치에만 한 번 넣는다. 그 뒤 연결·저장소·MCP 서버는 콘솔에서 바꾼다**(JeongJaeSoon/werft#1715). 문서(`SETTINGS_DOCUMENT`, test-ops는 `PLATFORM_SETTINGS_DOCUMENT`)를 고쳐 다시 배포해도 들어가지 않는다. Compose·Helm의 migrate가 `settings import` 대신 `settings seed --from-dir /legacy-config [--document <문서>]`를 돌린다. migration `0282_settings_seed_decided`가 `settings_generation.seed_decided_at`을 더하고, 올린 뒤 첫 migrate가 그 시각을 적는다. 연결이나 MCP 서버가 이미 있는 설치(사용 중지한 것 포함)는 아무것도 가져오지 않고 시각만 적으며, 로그에 `note: … not imported: the installation already holds settings. They seed an empty installation only; change settings in the console` 한 줄을 남긴다. 실패가 아니다. 저장소 행만 있는 설치는 빈 설치로 보고 한 번 넣는다. 문서를 일부러 다시 넣을 때는 owner가 `settings import`를 손으로 돌린다. test-ops `upgrade`는 바뀐 문서를 넣지도 DB와 비교하지도 않고, digest가 바뀌면 `upgrade: the settings document changed; …` 로그만 남긴다(`deploy`의 확인은 그대로). `scripts/local.sh down --keep-volumes`로 남긴 개발 volume에는 fixture 변경이 들어가지 않으니 volume을 새로 만들거나 `settings import`를 돌린다. 되돌리면 앞선 migrate가 배포마다 문서를 다시 가져오고, 콘솔에서 바꾼 항목이 문서의 같은 id와 다르면 migrate가 실패해 API가 뜨지 않는다. 되돌리기 전에 그 항목을 문서에서 빼거나 콘솔의 값에 맞춘다. `seed_decided_at` 열은 지우지 않는다([설정 문서는 빈 설치에 한 번만 들어간다](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/upgrade-compose#설정-문서는-빈-설치에-한-번만-들어간다)).
- **재개한 세션은 붙인 저장소를 브랜치의 지금 끝이 아니라 그 세션이 처음 받은 commit으로 다시 받는다. migration `0283_session_repository_pins`가 `session_repository_pins` 표를 더한다**(JeongJaeSoon/werft#1708). 도중에 붙인 저장소와 세션을 시작할 때 받은 저장소 모두에 적용된다. 그 사이 원격 브랜치가 움직이거나 force-push로 다시 써져도, 재개 뒤의 `refs/remotes/<id>/<branch>`는 처음 받은 commit을 가리킨다. 처음 받은 commit은 worker가 fetch한 commit이며, 세션·저장소마다 한 번만 기록한다. control-host와 worker를 모두 이 버전으로 올려야 적용된다. 한쪽만 올리면 전처럼 브랜치 끝을 받고 오류는 나지 않는다. 올리기 전의 세션은 다음 부착이나 claim에서 처음 기록된다. 세션 소유를 잃은 attempt가 보낸 부착 결과는 이제 반영하지 않는다. 그 부착은 지금 세션을 가진 attempt가 다시 받는다. 할 일은 없다. 기록한 commit이 원격에서 사라진 세션은 재개할 때 그 저장소를 받지 못한다(바로 아래 항목).
- **재개할 때 기록한 commit으로 다시 받지 못한 저장소는 더 이상 붙어 있는 것으로 보이지 않는다. migration `0284_session_repository_pin_restore_failed`가 `session_repository_pins.restore_failed_at`을 더한다**(JeongJaeSoon/werft#1722). 세션 이벤트에 `repository_restore_failed`(저장소 id, commit)가 한 번 남고, 콘솔의 세션 이벤트에 "붙인 저장소 …을(를) 이 세션이 기록한 commit …(으)로 다시 받지 못해 붙이지 않았습니다"로 보인다. 그 뒤 claim은 그 저장소를 싣지 않는다. `list_repositories`는 그 저장소를 `failed`와 새 필드 `failure: restore_failed`·`commit`으로 보여 주고, `attach_repository`는 "이미 붙어 있음"이라고 답하지 않고 브랜치의 지금 끝을 새로 받는다. worker 로그 `worker.workspace.restore_failed`에는 저장소 id와 commit만 남는다. 할 일은 없다.

## v0.2.0

`v0.1.3` 뒤 `main`에 들어간 변경이다. 실행 프로필을 없앴고(migration `0270`이 세션과 그 기록을 비운다), API와 env 일부가 예전과 호환되지 않게 바뀌어 minor 버전을 올린다. 올리기 전에 DB를 백업하고 아래 "운영자가 할 일"을 모두 읽는다. worker 안의 명령이 세션을 가로채거나 credential을 읽던 보안 문제 두 건을 고쳤으므로 `v0.1.3` 이하를 쓰는 곳은 올리기를 권한다.

### 보안

- **worker 안에서 실행된 명령이 launch nonce로 세션을 가로채거나, worker 이미지의 새 launch를 전부 막을 수 있었다**(JeongJaeSoon/werft#1626). `v0.1.0`부터 `v0.1.3`까지가 영향을 받는다. nonce(`WORKER_BOOTSTRAP_NONCE`)는 worker 컨테이너의 프로세스 환경에 있고, engine이 실행한 명령이 같은 사용자로 돌아 그 값을 읽을 수 있다. 그 값으로 claim을 다시 보내면 worker가 첫 호출을 하기 전(기본 5초 안)에는 세션의 credential이 그 명령에게 넘어갔다. claim에 다른 `image_runtime`을 적으면 시점과 무관하게 execution이 끝나고 worker 이미지가 거절 목록에 올라, 그 이미지로는 어떤 세션도 뜨지 않았다. 둘 다 nonce가 만료되기 전(발급 뒤 10분)에만 가능했다. 이제 worker는 claim 직후 heartbeat 하나를 보내 API가 받아들인 뒤에만 engine을 띄우고, API는 그 뒤에 온 claim을 `401`로 거절하며 아무것도 바꾸지 않는다. 이 경로로 거절 목록에 오른 이미지는 scheduler 로그의 `Worker image refused`로 알 수 있다. 이미지와 설정한 runtime이 실제로 맞는데 그 로그가 있으면 DB의 `worker_image_refusals`에서 그 이미지의 행을 지운다(`claimed` 열이 claim에 적힌 값이다). 이 표를 비우는 명령은 없다.
- **engine이 실행한 명령이 worker 프로세스의 환경과 메모리에서 engine에 주지 않은 credential을 읽을 수 있었다**(JeongJaeSoon/werft#1627). `v0.1.0`부터 `v0.1.3`까지가 영향을 받는다. worker 컨테이너 안에서는 worker 프로세스와 engine, engine이 실행한 명령이 모두 같은 사용자(UID 1000)로 돈다. 그래서 그 명령이 `/proc/<pid>/`로 worker 프로세스의 환경, 메모리, 열린 descriptor를 읽을 수 있었다. 그 안에는 session credential, object store token, MCP 서버의 upstream token이 있다. 이제 worker 프로세스는 시작할 때 자신을 non-dumpable로 만들어 같은 사용자의 이 읽기를 막는다. 이 수정은 worker 이미지에 있으므로 worker 이미지를 올려야 닫힌다. 운영 절차가 바뀌는 점은 아래 "운영자가 할 일"의 같은 PR 항목에 있다.

### 운영자가 할 일

- **세션의 비용·토큰 상한을 넘는 provider 호출이 `403 BUDGET_EXCEEDED`로 거절된다. control-host와 egress proxy를 같은 릴리스로 함께 올린다**(JeongJaeSoon/werft#1704, JeongJaeSoon/werft#1710). 끄는 설정은 없다. proxy는 과금되는 호출마다 control-host의 사용량 장부에 먼저 묻고, 장부는 세션에 이미 기록된 사용량과 진행 중인 호출들의 예약에 이 호출의 예약을 더해 `SESSION_COST_LIMIT_USD`·`SESSION_TOKEN_LIMIT`과 비교한다. 예약은 요청 크기 전체를 가장 비싼 캐시 쓰기 단가로, 출력을 요청의 출력 상한 전체로 세므로 세션은 실제 사용량이 상한에 닿기 한 호출 몫 전에 멈춘다. 상한은 한 호출의 예약(모델에 따라 대략 $1–2)보다 커야 한다. 그보다 작으면 첫 호출부터 거절된다. 세션에 기록되는 비용은 예약이 아니라 실제 사용량이다. 새 proxy를 옛 control-host와 같이 두면 장부가 호출을 열지 못해 모든 provider 호출이 `503`이 된다. control-host를 먼저 올리거나 함께 올린다. 장부가 5초 안에 답하지 않을 때도 그 호출은 `503`이다. migration `0280_provider_exchange_release`는 lease가 끝난 `provider_exchanges` 행을 한 번 지우고, 그 뒤로 사용량이 보고된 호출의 행은 보고와 함께 지워지고, 청구되지 않아 풀린 행은 풀린 지 7일 뒤에 지워진다([데이터 보존](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/reference/storage/#데이터별-보존)).
- **성과 판정기 Luna가 실제 OpenAI Decisions API를 부른다. 쓰려면 `openai_decisions` 연결을 만들고 고른다**(JeongJaeSoon/werft#1702). 설치 owner가 설정 > 에이전트 연결 > 모델 연결에서 종류 `openai_decisions`로 OpenAI API key를 넣고, 성과 규칙 > 판정 설정에서 그 연결을 고른다. 이 연결로 에이전트는 실행되지 않는다. egress proxy의 `EGRESS_CREDENTIAL_ALLOWLIST`에 `api.openai.com:443`이 없으면 판정이 실패한다. 고르면 Luna 규칙의 판정 근거(PR 제목, 저장소 이름, `out/` 파일 앞부분, 최근 대화)가 OpenAI로 간다. API도 바뀐다. `GET /v1/workspaces/{id}/achievement-judge`가 고를 수 있는 연결 목록 `connections`를 함께 주고, `PUT`은 그 목록에 없는 `connection_id`를 400 `unknown_connection`으로 거절한다(이미 저장된 id는 그 연결을 사용 중지해도 그대로 둘 수 있다). 설정 연결 API의 `kind`에 `openai_decisions`가 올 수 있으니 이 값으로 분기하는 클라이언트는 함께 고친다. migration은 없다. 이 연결을 만든 뒤 이 종류를 모르는 빌드로 되돌리면 그 빌드의 모델 연결 목록(화면과 API)이 다른 연결까지 함께 실패한다. 되돌리기 전에 그 연결 행을 DB에서 지운다([성과 판정 연결과 되돌리기](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/upgrade-compose#성과-판정-연결과-되돌리기)).
- **사람 응답 대기 시간은 env가 아니라 설정 > 워크스페이스 > 실행 한도에서 owner가 저장한다. `PENDING_REQUEST_TTL_SEC`는 처음 뜰 때 한 번 옮겨 담고 그 뒤로는 읽지 않는다**(JeongJaeSoon/werft#1707). migration `0281_installation_config`가 키마다 한 행인 `installation_config` 표를 더한다. 그 키의 행이 없고 API 컨테이너에 값이 실제로 들어와 있으면 첫 기동이 값을 옮기고 값 없이 경고하며, 워크스페이스가 있으면 작성자 없는 감사 기록(`by: "env_import"`)을 남긴다. `infra/compose.core.yml`과 Helm chart는 이 값을 넘기지 않으므로, 설치 쪽 overlay나 Kubernetes `api.extraEnv`로 직접 넘긴 경우에만 옮겨진다. 옮긴 뒤 env 줄을 지운다. 남아 있으면 시작할 때마다 `Ignored removed settings: PENDING_REQUEST_TTL_SEC` 경고가 나온다. 1–604800의 정수가 아닌 값은 옮기지 않는다. 앞선 릴리스처럼 시작을 멈추지 않지만 기본값으로 돌지도 않는다. 화면에서 값을 저장할 때까지 새 권한 요청·질문의 등록이 `503 BACKEND_UNAVAILABLE`로 거절된다(worker가 다시 보낸다). worker는 `QUESTION_TIMEOUT_SEC`를 읽지 않는다(launcher가 넘긴 적 없는 값이라 동작은 같다). 되돌릴 때 `installation_config` 표는 지우지 않고 env 줄을 다시 넣는다([웹으로 옮긴 실행 한도](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/upgrade-compose#웹으로-옮긴-실행-한도)).
- **`paused` 세션의 workspace volume(Docker volume, K8s PVC)도 TTL 뒤 회수된다. 새 설정 `EXECUTION_WORKSPACE_PAUSED_TTL_SEC`의 기본값은 86400(하루)이다**(JeongJaeSoon/werft#1655). 승인 대기로 park된 세션도 포함한다. resume이 받아들일 checkpoint가 있는 세션만 회수하고, resume하면 새 workspace에 그 checkpoint를 복원한다. migration `0273_paused_at`이 `sessions.paused_at`을 더한다. 이미 `paused`인 세션은 올린 뒤 회수 pass가 처음 본 시각부터 센다. 그래서 올린 직후 한꺼번에 지워지지 않는다. 회수 중에는 그 세션의 resume, parked 요청에 대한 답, 끝난 turn의 interrupt가 503 `BACKEND_UNAVAILABLE`(`Retry-After: 10`)로 거절되고 아무것도 기록되지 않는다. 같은 요청을 다시 보내면 된다. checkpoint 복원이 실패하면 전에는 volume에 남은 파일을 start_fresh가 쓸 수 있었지만, 회수된 세션에서는 빈 작업 디렉터리로 시작한다. paused volume을 더 오래 두려면 이 값을 늘린다(compose는 `infra/compose.core.yml`, Helm은 `scheduler.extraEnv`).
- **`SLACK_OIDC_REDIRECT_URI`·`SLACK_OIDC_CLIENT_ID`·`SLACK_OIDC_CLIENT_SECRET`을 더는 읽지 않는다. `CONSOLE_ORIGIN`이 없으면 Slack 계정 연결이 `503`이 된다**(JeongJaeSoon/werft#1684). `v0.1.2`에서 한 릴리스 동안 남긴 폴백(`CONSOLE_ORIGIN`이 없으면 `SLACK_OIDC_REDIRECT_URI`의 origin을 쓰던 것)을 없앴다. 그런 설치는 올리기 전에 API와 slack 역할에 `CONSOLE_ORIGIN`을 넣는다. 넣지 않으면 Slack 계정 연결이 `503`, Slack 앱 만들기가 거절되고, 저장한 이벤트 입구 주소(아래 항목)도 없으면 이벤트 구독이 등록되지 않는다(`events_url_unset`). 세 값은 env에서 지운다. Compose는 `infra/compose.core.yml`이 더는 넘기지 않는다. Kubernetes는 `api.extraEnv`·`slack.extraEnv`에서 지운다. 남아 있으면 API가 시작할 때 값 없이 `Ignored removed settings: <이름>` 경고를 한 번 남기고, 값은 쓰지 않는다([지운 Slack 연결 env](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/upgrade-compose#지운-slack-연결-env)).
- **Slack 이벤트 입구 주소는 env가 아니라 설정 > 연동 > Slack에서 owner가 저장한다. `SLACK_EVENTS_PUBLIC_URL`은 처음 뜰 때 한 번 옮겨 담고 그 뒤로는 읽지 않는다**(JeongJaeSoon/werft#1692). migration `0278_slack_settings`가 설치 전체에 하나인 `slack_settings` 표를 더한다. 이 표가 비어 있고 API 컨테이너에 그 값이 실제로 들어와 있으면 첫 기동이 값을 옮기고 값 없이 경고하며, 작성자 없는 감사 기록(`by: "env_import"`)을 남긴다. Compose의 `infra/compose.core.yml`은 이 값을 넘기지 않으므로, 설치 쪽 overlay나 Kubernetes `api.extraEnv`로 직접 넘긴 경우에만 옮겨진다. 그 밖에는 올린 뒤 화면에서 저장한다. 옮긴 뒤 env 줄을 지운다. 남아 있으면 시작할 때마다 `Ignored removed settings: SLACK_EVENTS_PUBLIC_URL` 경고가 나온다. https가 아니거나 query가 있는 값은 옮기지 않고 그렇다고 경고하며, 앞선 릴리스와 달리 시작을 멈추지 않는다. 비워 두면 `CONSOLE_ORIGIN`에서 계산한 주소를 쓴다. 주소를 바꾸면 이미 만든 앱은 에이전트의 Slack 탭에서 "다시 확인"으로 새 주소를 보낸다. 되돌릴 때 `slack_settings` 표는 지우지 않는다([웹으로 옮긴 Slack 이벤트 입구 주소](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/upgrade-compose#웹으로-옮긴-slack-이벤트-입구-주소)).
- **mock Slack 시험용 `SLACK_API_URL`·`SLACK_OIDC_ISSUER`는 `MOCK_SLACK_API_URL`·`MOCK_SLACK_OIDC_ISSUER`로 이름이 바뀌었다**(JeongJaeSoon/werft#1692). 옛 이름은 읽지 않고 `Ignored removed settings` 경고에 이름만 나온다. 새 이름에 값이 있으면 주소와 상관없이 시작할 때 `Mock Slack override in use: <이름>` 경고를 한 줄 남긴다(예전에는 주소가 Slack이 아닐 때만 경고했다). 운영 설정에는 두 이름 모두 두지 않는다([mock Slack env 이름](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/upgrade-compose#mock-slack-env-이름)).
- **worker 프로세스의 환경, 메모리, 메모리 지도, 열린 descriptor를 컨테이너 안에서 `/proc`으로 읽을 수 없다**(JeongJaeSoon/werft#1627). 명령행과 프로세스 이름은 전처럼 보인다. worker 프로세스가 시작할 때 자신을 non-dumpable로 만들어, engine이 실행한 명령이 worker 프로세스의 환경과 메모리를 읽지 못한다. 배포 요구(이미지 사용자, capability, `securityContext`)는 바뀌지 않는다. 바뀌는 것은 두 가지다. worker 프로세스를 `docker exec`이나 `kubectl exec`으로 들여다보는 절차(`strace`, `gdb`, `/proc/<pid>/` 보기)는 root이면서 `CAP_SYS_PTRACE`를 가진 프로세스로 바꾼다. Docker에서는 `docker exec --privileged -u 0`이다. Kubernetes에서는 worker 컨테이너를 대상으로 하고(`kubectl debug --target=<container>`) root와 `CAP_SYS_PTRACE`를 주는 debug 컨테이너가 필요하다. worker 프로세스는 core dump를 남기지 않는다. worker 이미지를 직접 만드는 곳은 glibc가 있는 이미지를 쓴다. worker는 libc의 `prctl`을 부르지 못하면 뜨지 않는다(`The worker cannot make itself unreadable to the engine`).
- **이번 릴리스는 control-host와 worker 이미지를 한 upgrade로 함께 올린다**(JeongJaeSoon/werft#1626, JeongJaeSoon/werft#1649). 프로필 제거 전에 빌드한 worker(`v0.1.3` 포함)는 새 control-host의 `bootstrap-claim` 응답을 읽지 못해 시작 직후 끝난다(`POST /bootstrap-claim answered a body this worker cannot read`). 세션은 세 번 launch한 뒤 `recovery_required`(`STARTUP_FAILED`)로 멈춘다. 그래서 업그레이드 문서의 "API 먼저, worker 나중" 순서(Compose의 중간 release, Kubernetes의 1단계)는 이번 릴리스에 적용하지 않는다. 그런 이미지는 지원 창에 들지 않으므로 `images.workerPrevious`에 따로 넣지 않는다. 다만 Kubernetes의 업그레이드 전 검사는 worker 이미지가 바뀌는 upgrade의 `images.workerPrevious`가 지금 배포된 이미지이기를 요구하므로, 업그레이드 문서의 `worker-previous.json`은 그대로 넘긴다. `0270`이 세션을 비우고 새 세션은 언제나 현재 이미지로 뜨므로, 그 이미지로 뜨는 세션은 없다([프로필 제거 릴리스의 업그레이드 순서](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/upgrade-compose#프로필-제거-릴리스의-업그레이드-순서)). 위 보안 수정도 둘 다 올려야 완전하다. API만 올리면 이전 worker가 첫 heartbeat 전에 engine을 띄울 수 있고, worker만 올리면 이전 API가 다른 `image_runtime`을 적은 claim을 계속 받는다.
- **실행 프로필을 없앴다. migration `0270_remove_profiles`가 프로필 데이터를 지운다.** 설치·워크스페이스 프로필 표, 세션·release·repository의 프로필 열과 설정 문서의 `profiles`가 지워지며 되살릴 수 없다. 세션과 그 아래 기록은 45개 표에서 비워지고(`provider_usage` 포함, `agent_usage`·`tool_call_audits`·에이전트는 남음), 세션이 없는 `slack_outbox` 행은 남긴다. 이 변경의 이전 초안(`0269_remove_profiles`)을 적용해 본 개발·verify DB는 새로 만든다. 올리기 전에 DB를 백업하고, 되돌리려면 그 백업으로 복원한다([업그레이드](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/upgrade-compose)).
  - release는 provider 연결 하나와 카드 모델을 고른다. 런타임 spec은 release에 고정된다: 연결 종류의 런타임을 이미지의 버전으로, 내장 도구 전부, 연결의 분류기가 되면 `auto`, 안 되면 `default` 모드. `0270`은 모든 release를 지우고 에이전트마다 활성 release와 draft를 비운다. 그래서 올린 뒤에는 어느 에이전트도 세션을 시작하지 못한다. 에이전트마다 연결과 모델을 고르고 다시 release한다. spec을 만들 수 없는 release로 세션을 시작하면 `RELEASE_SPEC_UNAVAILABLE`로 거절된다.
  - 연결은 모델 목록(`models`, 선택 `model_families`)을 가진다. 목록에 없는 모델로는 release를 만들 수 없다. `0270`은 프로필을 지우기 전에, 목록이 빈 연결마다 그 연결에 대응하던 프로필(차단되지 않은 것, 퇴역했으면 활성 release가 쓰던 것만)의 모델을 채운다. 목록이 이미 있던 연결에는 아무것도 더하지 않는다. 올린 뒤 설정 → 모델 연결에서 연결마다 에이전트가 쓸 모델이 목록에 모두 있는지 확인하고, 빠진 모델을 넣는다. 설정 문서에서는 최상위 `profiles` 키와 저장소 항목의 `profiles`를 지운다. 최상위 키가 있으면 `settings import`(CLI와 API)가 문서를 거절한다(CLI의 오류는 `` `profiles` is no longer part of a settings document ``). 저장소 항목의 `profiles`는 CLI가 버리지만 API는 거절한다.
  - 실행 규칙은 워크스페이스와 에이전트 설정에서 온다. 거부 목록은 둘의 합집합이다. repository는 워크스페이스 상한과 에이전트의 GitHub 설정으로 판정한다.
  - API: `/v1/profiles`, 워크스페이스·설치 프로필 API와 세션의 프로필 변경을 없앴다. `POST /v1/sessions`는 `profile_id`를 받지 않고 `agent_release_id`가 언제나 필요하다. release 생성은 `runtime_profile_id` 대신 `connection_id`를 받는다. 오류 `PROFILE_BLOCKED`·`PROFILE_DIGEST_MISMATCH`·`RELEASE_PROFILE_MISMATCH`를 없앴고 `RELEASE_SPEC_UNAVAILABLE`을 더했으며, `PERMISSION_WAIT_ABOVE_PROFILE`은 `PERMISSION_WAIT_ABOVE_LIMIT`으로 이름을 바꿨다. 이 값들을 쓰는 클라이언트를 함께 고친다.
- **worker의 heartbeat 응답에 `auth_revision`이 없고, API는 `batch_key` 없는 append-events 요청도 받는다**(JeongJaeSoon/werft#1657). worker protocol 필드를 걷어내는 2단계다. `v0.1.0`부터 모든 릴리스의 worker 이미지는 `auth_revision` 없는 heartbeat 응답을 받으므로 할 일은 없다. worker는 이번 릴리스에도 `batch_key`를 보낸다. 다음 릴리스의 worker가 보내지 않게 되면, 그 worker와 함께 도는 API는 이번 릴리스 이후여야 한다. [업그레이드](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/upgrade-compose)의 "worker protocol 필드를 걷어내는 순서"에 적었다.
- **실행 중이던 turn을 끊은 terminate 뒤의 세션 `status`가 `failed`가 아니라 `stopped`다**(JeongJaeSoon/werft#1624). execution 회수(revoke)가 turn을 끊은 경우도 같다. `admission_state`는 그대로 `recovery_required`이고 turn은 `outcome_unknown`이라 복구 결정 절차는 바뀌지 않는다. 이벤트 스트림 `status` 프레임의 `phase`도 `stopped`다. 멈추라는 요청 없이 실행이 사라져(worker 종료, lease 만료) turn이 `outcome_unknown`이 된 세션은 지금처럼 `failed`다. 복구가 필요한 세션을 `status: failed`로 고르던 클라이언트·알림은 `admission_state: recovery_required`로 고르게 바꾼다. `/metrics`의 `sessions` gauge는 이 세션을 계속 `state="recovery_required"`로 세고 `status` label만 `stopped`가 된다. 웹 콘솔의 세션 목록은 이 세션에 "복구 필요"를 함께 보인다. 이미 `failed`로 저장된 세션은 바뀌지 않는다.
- **웹 콘솔의 에이전트 지도(`/sessions/map`)와 옛 주소 리다이렉트를 없앴다**(JeongJaeSoon/werft#1689). 옛 주소 `/teams`, `/teams/<팀 id>`, `/usage`, `/settings/api-keys/org`는 이제 새 주소로 가지 않고 "찾을 수 없는 화면"이다. 사내 문서나 북마크에 이 주소가 있으면 각각 `/members/teams`, `/members/teams/<팀 id>`, `/operations/usage`, `/settings/workspace/api-keys`로 바꾼다. `/sessions/map`은 없는 세션 주소로 읽힌다. 세션 목록·상세 화면과 API는 바뀌지 않는다.
- **일회성 명령 `mcp-settings-migration`을 없앴다**(JeongJaeSoon/werft#1616). release의 MCP 값(서버, 허용 도구, credential 이름)을 에이전트의 MCP 설정 행으로 복사하던 명령이다(`bun run apps/control-host/src/api/mcp-settings-migration.ts`의 `--dry-run`·`--apply`·`--revert`). 아직 실행하지 않은 설치는 올리기 전에 이전 버전(`v0.1.3`)에서 먼저 실행한다. 이미 복사한 행과 `agent_mcp_settings` 표는 그대로 남는다.
- **로그 필드의 여러 줄 값(stack, 실패한 worker의 `log_tail`)은 처음 마스킹에 걸린 줄 앞까지 남는다**(JeongJaeSoon/werft#1654). 지금까지는 값 안 어디든 비밀 모양의 값이나 `input:`·`message:`·`token=` 같은 조각이 있으면 값 전체가 `[REDACTED]`였다. 그래서 scheduler 로그의 `Execution resource failed; log tail kept` 줄에서 worker의 종료 원인을 읽을 수 없었다. 이제 비밀 모양의 값은 그 값이 걸친 줄만, 키 조각은 그 줄부터 끝까지 가린다. 가려지던 값은 지금도 가려진다. 다만 그 앞의 줄(예외 이름, 메시지의 앞부분, 앞선 로그 줄)은 API·scheduler·worker·egress proxy의 stdout과 로그 수집기에 남는다. 할 일은 없다.
- **worker의 checkpoint capture 로그에 `point` 필드가 더해진다**(JeongJaeSoon/werft#1642). 값은 승인 대기 중의 capture면 `approval_wait`, turn 끝이면 `turn_end`다. 대상은 `worker.checkpoint.failed`·`blocked`·`result`·`transcript_limit`·`report_failed`·`published`와 `worker.attribution_repair` 로그다. 승인 대기 capture가 실패하면 그 승인 대기는 worker가 죽었을 때 이어 갈 수 없는데(`outcome_unknown`), 세션의 `checkpoint_pending_reason`은 다음 turn 끝 commit이 지운다. 그 사실은 이제 이 로그의 `point: approval_wait`로 남는다. 할 일은 없다. API와 세션 상태는 바뀌지 않는다.
- **승인 대기 checkpoint를 남기지 못한 승인 요청마다 세션 이벤트 스트림에 `system` 이벤트 `approval_checkpoint_failed`가 한 번 온다**(JeongJaeSoon/werft#1645). 필드는 `request_id`와 `reason`(`capture_failed`, `capture_timed_out`, `verification_failed`)이다. 다음 checkpoint가 `checkpoint_pending_reason`을 지워도 이 이벤트는 남는다. 이벤트의 `subtype`으로 분기하는 클라이언트는 이 값을 더하거나 모르는 값으로 다룬다. 웹 콘솔 타임라인은 이 이벤트를 한 줄로 보인다. worker 프로토콜의 승인 요청 등록에 새 필드(`checkpoint_failure`)가 생겨, 이 필드를 모르는 control host는 새 worker의 등록을 거절한다. 이번 릴리스는 control-host와 worker 이미지를 한 upgrade로 함께 올린다(위 항목). 다음 릴리스부터는 [업그레이드](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/upgrade-compose) 절차대로 API를 먼저 올리고 worker 이미지를 나중에 올린다. 되돌릴 때는 worker 이미지를 먼저 내린다.
- **Claude 가격표에 이름이 없는 모델이 fallback 최고 단가로 계산될 때, 두 경우에 비용이 더 높게 기록된다**(JeongJaeSoon/werft#1630). 대상은 어느 가격표에도 없는 모델과, 긴 문맥 단가가 표에 없는 OpenAI 모델의 272K 초과 호출이다. `standard`가 아닌 speed(`fast`, 모르는 단계, 값 없음)로 응답하면 fallback 최고 단가의 2배로 센다. 오래 유지하는 cache write는 speed와 상관없이 input 단가의 2배가 아니라 2.5배로 센다. fallback이 OpenAI 모델의 fast 단계와 12시간 cache write를 반영하지 않아 실제보다 적게 세던 것을 고쳤다. 가격표의 단가로 계산되는 호출, Claude 가격표에 이름이 있는 모델, `billing: none` 연결의 비용은 그대로다. `standard` speed의 fallback은 오래 유지하는 cache write만 바뀐다. 할 일은 없다. 해당 세션은 `SESSION_COST_LIMIT_USD`에 더 빨리 닿는다.
- **OpenAI 모델의 비용이 세 경우에 더 높게 기록된다**(JeongJaeSoon/werft#1644). 단가표를 [공식 단가](https://developers.openai.com/api/docs/pricing)(2026-11-12 확인)에 맞췄다. `gpt-5.5`의 `fast` 응답은 표준 단가의 2배가 아니라 2.5배로 센다. `gpt-6-astra`·`gpt-6.1-sol`의 `ultrafast` 응답과, 모델의 항목에 없는 speed 단계는 2배가 아니라 표가 아는 가장 큰 배수인 6배로 센다. Pro 모델(`gpt-5.5-pro`, `gpt-5.4-pro`, `gpt-5.2-pro`, `gpt-5-pro`, `o3-pro`)은 fallback 최고 단가(input $20, output $75)가 아니라 자기 단가(최고 input $60, output $270)로 세고, ledger의 `priced_by`가 `fallback`에서 `table`이 된다. 어느 표에도 없는 모델의 fallback은 `fast`면 2배가 아니라 2.5배, 그 밖의 단계면 6배로 센다. `standard` speed의 fallback 단가는 바뀌지 않는다(Pro 단가를 넣지 않는다). 할 일은 없다. 해당 세션은 `SESSION_COST_LIMIT_USD`에 더 빨리 닿는다.
- **세션 제목 호출은 path `/v1/messages`, 세션의 모델, `max_tokens` 64 이하로만 나간다**(JeongJaeSoon/werft#1658). API가 제목 호출의 권한에 이 한도를 싣고, egress proxy가 요청 본문을 대조해 벗어나면 403으로 거절한다. 정상 제목 호출은 바뀌지 않는다. 한도는 API와 proxy가 모두 이 버전일 때 걸린다. 한쪽이 이전 버전이면 지금처럼 검사하지 않을 뿐 호출은 깨지지 않는다. 할 일은 없다.
- **엔진이 지원하지 않는 기능 때문에 worker가 거절한 세션은 첫 실패에서 `recovery_required`가 된다**(JeongJaeSoon/werft#1641). 세션 설정이 요구한 기능(`mcp`, `classifier_review` 등)이 worker 이미지의 엔진에 없을 때다. 전에는 일반 startup 실패처럼 30초·60초 뒤 두 번 더 launch하고 3회째에 멈췄다. 이제 `attention`은 `failures: 1`, `retry_at: null`이고 `reason`은 전과 같은 worker의 문구다. checkpoint가 있는 세션은 원인을 고친 뒤 `retry_restore`로 같은 checkpoint에서 이어 갈 수 있다. `paused`에서 resume한 세션은 첫 launch에서 resume이 실패하고, receipt 오류 `message`가 worker의 거절 이유다. 할 일은 없다. 이 이유로 멈춘 세션은 worker 이미지를 올리거나 에이전트 설정에서 그 기능을 빼고 복구 결정을 내린다.
- **설정된 worker 이미지 어느 쪽으로도 재개할 수 없는 세션의 resume receipt가 `failed`로 끝난다**(JeongJaeSoon/werft#1648). `paused` 세션을 resume했는데 scheduler가 launch 전에 `incompatible_checkpoint`로 멈춘 경우다(업그레이드에서 그 세션을 승인하고 이미지를 뺀 뒤가 대표적이다). 전에는 세션이 `recovery_required`가 되어도 receipt가 `accepted`에 남았다. 이제 receipt의 `error.code`는 `CHECKPOINT_UNAVAILABLE`이고 `message`에 checkpoint를 봉인한 조합과 설정된 이미지의 조합이 있다. 세션의 `attention`과 `checkpoint_restore_failed` 이벤트는 그대로이고, 그 세션의 `status` 이벤트에 receipt와 같은 오류가 `resume_failed`로 더해진다. 할 일은 없다. resume receipt가 `accepted`에 머무는 것을 기다리던 클라이언트는 이제 `failed`를 받는다.
- **Claude 모델의 비용을 공식 단가와 OpenAI 표와 같은 규칙으로 센다. 어떤 호출은 더 적게, 어떤 호출은 더 많이 기록된다**(JeongJaeSoon/werft#1656). 할 일은 없다. 적게 기록되는 세션은 `SESSION_COST_LIMIT_USD`에 늦게 닿고, 많게 기록되는 세션은 더 빨리 닿는다. 금액은 100만 token, `global` 기준이다.
  - 단가표를 [공식 단가](https://platform.claude.com/docs/en/about-claude/pricing)(2026-11-13 확인)에 맞췄다. `claude-sonnet-5-5`의 cache read는 $0.20이 아니라 $0.10이다. `claude-fable-5-2`·`claude-mythos-5-2`는 fallback이 아니라 자기 단가(입력 $8, 출력 $40, cache read $0.20, fast 2배)로 센다.
  - Claude 표에 있는 모델이 fast 배수 없이 `fast`로, 또는 모르는 speed로 응답하면, 두 표를 통틀어 최고 단가(fallback)가 아니라 모델 자기 단가에 두 표를 통틀어 가장 큰 배수(6배)를 곱해 센다. OpenAI 표가 항목에 없는 단계를 세는 방식과 같다. ledger의 `priced_by`는 `fallback`이 아니라 `table`이고, authorizer의 fallback 경고도 남지 않는다. 출력은 자기 단가가 $12.50을 넘는 모델은 오르고(Opus 4 $450, Fable 5·5.1과 Mythos 5·5.1 $300, Opus 4.5~4.8·5 $150, Opus 5.5 $120, Sonnet 4.x $90), 그 아래 모델은 내린다(Sonnet 5·5.5 $60, Haiku 4.5 $30, Haiku 5.5는 100K 이하 prompt에서 $3). 입력·cache 부분도 자기 단가 × 6과 fallback($20/$2) 중 어느 쪽이 큰지에 따라 오르거나 내린다.
  - Claude 표에 있는 4.6 이후 모델이 `global`·`us`가 아닌 geo로 응답하면, 최고 단가 × 1.1이 아니라 모델 자기 단가 × 1.1로 센다(`priced_by=table`). 요청에 `inference_geo`가 없고 응답이 끊겨 요청만으로 추정한 호출도 여기에 든다. 출력 기준으로 Opus 5는 $82.50에서 $27.50, Sonnet 5는 $11로 내린다.
  - 4.6 이전 모델이 200K를 넘고 speed가 `standard`가 아니면, fallback 단가에 그 speed 배수(6배)를 더 곱한다. 입력 기준으로 $20에서 $120으로 오른다.
  - fallback(두 표를 통틀어 최고 단가)의 출력 단가는 $75에서 $80(Fable 5.2 fast 출력)으로 오른다. fallback으로 세는 호출은 모두 오른다. 그런 호출은 어느 표에도 없는 모델, 4.6 이전 Claude 모델의 200K 초과, 긴 문맥 단가가 없는 OpenAI 모델의 272K 초과, 표에 없는 judge 모델이다. 입력($20)·cache read($2) 단가와 Pro 모델의 fallback은 그대로다.
- **egress proxy가 평문 http forward 요청에서 `Connection: keep-alive`를 보낸 client의 연결을 응답 뒤에 닫지 않고 다음 요청을 받는다**(JeongJaeSoon/werft#1687). worker 안 도구가 Bun `fetch`로 평문 http 주소를 잇달아 부르면, 앞 응답이 non-2xx일 때 다음 요청이 `The socket connection was closed unexpectedly`로 가끔 실패하던 것을 고쳤다. 다음 요청도 새 연결처럼 머리 검사와 egress 판정을 다시 받고, upstream에는 요청마다 새로 연결한다. keep-alive를 보내지 않는 client(curl, git)는 지금처럼 응답 뒤에 닫힌다. 쉬는 연결은 15초 뒤 닫힌다. 함께 머리 검사가 엄격해진다. 칸 값에 제어 문자(bare CR·LF 등)가 있거나 칸 이름·method가 token이 아닌 요청(`Content-Length : 4`처럼 콜론 앞에 공백이 있는 것 포함)은 400이고, 그런 칸이나 상태 줄을 보낸 upstream 응답은 502이다. 할 일은 없다.
- **늦게 commit된 도구 호출이 사용량 통계에서 빠지지 않는다**(JeongJaeSoon/werft#1653). 오래 열린 transaction이 늦게 넣은 이벤트가 있으면, tool-call projection의 커서가 그보다 낮은 id의 아직 commit되지 않은 이벤트를 넘어갈 수 있었다. 이제 커서는 margin(60초) 안에 든 첫 이벤트 앞에서 멈춘다. 정상 순서의 이벤트는 전과 같은 때 반영된다. 할 일은 없다.
- **Google 로그인이 공급자의 응답을 더 엄격하게 검증한다**(JeongJaeSoon/werft#1662). Google(`https://accounts.google.com`)로 로그인하는 설치는 할 일이 없다. `GOOGLE_OIDC_ISSUER`를 다른 OIDC 공급자로 돌려 쓴 설치는 아래 경우에 로그인이 거절되니 올리기 전에 확인한다.
  - id_token에 `iat`가 없거나, 60초 넘게 미래이거나, 11분보다 오래됐다. `aud`가 client ID 하나가 아니다(다른 audience가 함께 있는 경우 포함). `nbf`가 60초 넘게 미래다. `sub`가 255자를 넘는다.
  - discovery 문서의 endpoint가 `https`가 아니다(issuer 자신이 `http`인 설치는 예외). `response_types_supported`에 `code`가 없다. 서명 알고리즘에 RS256·ES256이 없다. token endpoint의 client 인증 방식을 알리면서 `client_secret_basic`·`client_secret_post`가 없다. PKCE 방식을 알리면서 S256이 없다.
  - 서명 키가 RSA 2048비트보다 짧다.
  - 공급자 이름이 link-local(`169.254.0.0/16`, `fe80::/10`)·multicast·reserved·unspecified 주소로 풀린다. IPv6는 전역 유니캐스트(`2000::/3`) 가운데 문서용·6to4·Teredo 같은 특수 범위를 뺀 주소와 `fc00::/7`만 받는다. `https` issuer가 loopback 주소로 풀린다. 사설 주소(`10.0.0.0/8` 등)의 공급자는 전처럼 쓸 수 있다.
  - 공급자가 redirect로 답하면 따라가지 않는다. 응답 본문은 1 MiB까지 읽는다.
  - 전보다 받는 경우: ES256으로 서명한 id_token(공급자가 discovery에서 알릴 때). id_token에 `email`이 없으면 UserInfo에서 읽는다(`sub`가 같고 `email_verified`가 `true`일 때).
- **Google 로그인 수단이 있는 사용자는 올린 뒤 한 번 다시 로그인한다. migration `0274_web_session_login_method`가 `web_sessions.login_method_id`를 더한다**(JeongJaeSoon/werft#1664). 새 버전은 세션마다 그 세션을 만든 로그인 수단을 적는다. 올리기 전에 만든 세션에는 이 값이 없고, 그런 세션은 사용자에게 외부 로그인 수단(Google)이 하나도 없을 때만 받는다. 비밀번호만 쓰는 사용자의 세션은 그대로다. Google 수단이 있는 사용자는 그 세션을 비밀번호로 만들었더라도 다시 로그인한다. 로그인하는 방법은 바뀌지 않는다. 공급자를 끄면 그 공급자로 만든 세션이 끊기게 하는 변경의 바탕이다.
  - 옛 버전 API 프로세스가 함께 도는 동안(replica가 여럿인 배포의 교체 중)에 옛 프로세스가 만든 세션도 값이 없어 같은 판정을 받는다. 교체 중에 로그인한 Google 사용자는 교체가 끝난 뒤 한 번 더 로그인할 수 있다.
  - 이 migration은 `login_methods (user_id, issuer)` 유일 인덱스(비밀번호 수단 제외)도 만든다. 한 사용자에게 같은 issuer의 외부 수단이 둘 있으면 `login_methods has a user with two external login methods of one issuer`로 멈추고 아무것도 바꾸지 않는다. 메시지에 적힌 조회로 행을 찾아 하나를 지운 뒤 다시 돌린다. 외부 수단은 지금까지 첫 가입 때만 만들어졌으므로, DB를 직접 고치지 않은 설치에서는 일어나지 않는다.
  - 옛 버전으로 되돌릴 수 있다. 옛 코드는 새 칸을 읽지 않는다. 칸과 인덱스까지 지우려면 `ALTER TABLE web_sessions DROP COLUMN login_method_id`와 `DROP INDEX login_methods_user_issuer_uniq`를 돌린다.
- **Google 로그인은 웹 관리 화면에서 공급자로 다시 등록한다. `GOOGLE_OIDC_*` 환경 변수는 더는 읽지 않는다**(JeongJaeSoon/werft#1666). 로그인 공급자가 환경 변수가 아니라 DB의 설정 행(`login_providers`)이 됐다. 옛 설정을 자동으로 옮기지 않는다. 올리면 환경 변수로 켜 둔 Google 로그인은 꺼지고 로그인 화면에는 비밀번호만 남는다. Google로만 로그인하던 사용자는 owner가 공급자를 다시 등록할 때까지 새로 로그인할 수 없다. Google 로그인 수단이 있는 사용자의 웹 세션은 올리는 순간 끊긴다(위 migration `0274` 항목). 그래서 Google로만 로그인하던 owner는 공급자를 다시 등록하러 들어올 수 없다. 올리기 전에 비밀번호로 로그인할 수 있는 owner가 한 명 이상 있는지 확인한다. 사용자와 Google 계정의 연결(`login_methods`)은 남으므로, 같은 issuer(`https://accounts.google.com`)로 다시 등록하면 같은 계정으로 들어온다. 비밀번호 로그인은 그대로다.
  - 공급자를 등록하는 관리 API(`/v1/login-providers`)가 들어왔다(JeongJaeSoon/werft#1667). owner만 쓴다. 공급자는 꺼진 채로 만들어지고, 지금 설정으로 테스트 로그인이 통과해야 켤 수 있다. 등록 순서와 요청은 `docs/operator/api-server.md`의 "로그인 공급자(OIDC)" 절에 있다. 새로 요구하는 설정이나 권한은 없고, migration도 없다.
  - 공급자를 등록하는 화면이 들어왔다(JeongJaeSoon/werft#1669). owner가 콘솔의 설정 > 워크스페이스 > **로그인**에서 공급자를 더하고, 화면이 보여 주는 redirect URI를 IdP에 등록한 뒤 client ID와 client secret을 넣고, 테스트 로그인이 통과하면 켠다. Google 로그인을 쓰던 설치는 올린 뒤 여기서 Google을 다시 등록한다. API에 `CONSOLE_ORIGIN`이 없으면 화면이 그 사실을 말하고 공급자를 더할 수 없다. 새로 요구하는 설정이나 권한은 없고, migration도 없다.
  - 로그인한 사람이 자기 로그인 수단을 다루는 화면과, 공급자의 가입 규칙을 바꾸는 화면이 들어왔다(JeongJaeSoon/werft#1672). 누구나 콘솔의 설정 > **로그인 수단**에서 켜진 공급자의 계정을 자기 계정에 연결하고, 쓰지 않을 수단을 끊는다. 비밀번호를 끊으면 다시 정할 수 없다고 화면이 확인 대화상자에서 말한다. owner는 공급자 상세에서 허용 도메인, 초대 없이 가입, 검증된 이메일 요구를 바꾼다. 초대 링크를 연 사람은 켜진 공급자가 있으면 비밀번호를 정하는 대신 그 공급자의 계정으로 가입할 수 있다. 계정의 이메일은 초대받은 주소가 되고 비밀번호는 없다. 로그인 화면의 공급자 버튼과 공급자 상세의 테스트 로그인 버튼은 공급자 화면으로 넘어가는 동안 다시 눌리지 않는다(전에는 넘어가는 사이에 다시 누를 수 있었고, 그러면 먼저 시작한 로그인이나 테스트가 거절될 수 있었다). 로그인, 연결, 초대 가입, 테스트 로그인 가운데 하나를 시작하면 나머지도 그동안 잡힌다. 초대 수락과 구성원 화면의 안내에서 "Google로만 로그인하던 계정"은 "SSO로만 로그인하던 계정"으로 바뀌었다. 새로 요구하는 설정이나 권한은 없고, migration도 없다.
  - 초대 링크로 공급자 가입을 하는 API와, 로그인한 사람이 자기 로그인 수단을 연결하고 끊는 API(`/v1/auth/me/login-methods`)가 들어왔다(JeongJaeSoon/werft#1670). 있던 로그인과 초대 수락의 동작은 바뀌지 않는다. 연결과 끊기는 만든 지 10분 안의 세션에서만 되고, 마지막으로 쓸 수 있는 수단은 끊을 수 없다. 비밀번호를 끊은 사람은 비밀번호를 다시 정할 수 없다. 요청과 응답은 `docs/operator/api-server.md`의 "로그인 공급자(OIDC)" 절에 있다. 새로 요구하는 설정이나 권한은 없고, migration도 없다.
  - 순서: 옛 버전의 API 프로세스를 모두 내린 뒤에 올리고, 그다음 공급자를 등록한다. migration `0275_login_providers`가 `login_methods.kind`의 `google`을 `oidc`로 바꾸므로, migration 뒤에도 도는 옛 프로세스의 Google 로그인은 실패한다(연결된 사용자는 `409 LOGIN_LINK_REQUIRED`, 처음 들어오는 사용자는 `500`).
  - 공급자에 등록하는 리디렉션 URI가 `<CONSOLE_ORIGIN>/auth/callback/<공급자 id>`로 바뀐다. API에 `CONSOLE_ORIGIN`이 있어야 하고, 없으면 공급자 로그인의 시작이 `503`이다. Google Cloud Console의 승인된 리디렉션 URI는 공급자를 등록해 id를 받은 뒤에 바꾼다. 공급자의 주소는 `https`여야 한다. `CONSOLE_ORIGIN`이 `localhost`·`127.0.0.1`인 로컬 스택만 loopback의 `http` 공급자를 쓸 수 있다(전에는 `GOOGLE_OIDC_ISSUER`에 어떤 `http` 주소든 줄 수 있었다).
  - `GOOGLE_OIDC_CLIENT_ID`·`GOOGLE_OIDC_CLIENT_SECRET`·`GOOGLE_OIDC_REDIRECT_URI`·`GOOGLE_OIDC_ISSUER`·`GOOGLE_OIDC_ALLOWED_DOMAINS`·`GOOGLE_OIDC_JIT`는 지운다. 남아 있어도 읽지 않고 기동은 된다. `infra/compose.core.yml`도 넘기지 않는다.
  - API가 바뀐다. `POST /v1/auth/google/start`·`POST /v1/auth/google/callback`이 없어지고 `POST /v1/auth/providers/{id}/start`·`POST /v1/auth/oidc/callback`이 생긴다. `GET /v1/auth/login-methods`의 응답이 `{"methods":["password","google"]}`에서 `{"password":"on","providers":[{"id","display_name"}]}`로 바뀐다. 웹 콜백 경로는 `/auth/google/callback`에서 `/auth/callback/<공급자 id>`가 된다. 올리는 순간 진행 중이던 Google 로그인은 처음부터 다시 한다.
  - migration `0276_web_sessions_login_method_idx`는 `web_sessions`에 부분 인덱스를 `CONCURRENTLY`로 만든다. 쓰기를 막지 않는다.
  - 옛 버전으로 되돌리려면 옛 코드의 Google 로그인이 다시 `kind = 'google'`을 찾도록 아래를 돌린다. 새 버전에서 Google이 아닌 공급자로 만든 로그인 수단이 있으면 먼저 지운다. `login_providers` 테이블과 `web_sessions_login_method_live_idx` 인덱스는 옛 코드가 읽지 않으므로 남겨도 된다.

    ```sql
    ALTER TABLE login_methods DROP CONSTRAINT login_methods_kind_check;
    UPDATE login_methods SET kind = 'google' WHERE kind = 'oidc';
    ALTER TABLE login_methods ADD CONSTRAINT login_methods_kind_check CHECK (kind IN ('password', 'google'));
    ```
- **비밀번호 로그인을 설치 전체에서 닫을 수 있고, 닫아도 비밀번호로 들어오는 비상 관리자 한 명이 생긴다. migration `0277_login_settings`가 `login_settings` 테이블을 만들고 비상 관리자를 지정한다**(JeongJaeSoon/werft#1673). 올리기만 해서는 누구의 로그인도 바뀌지 않는다. 비밀번호 로그인은 열린 채다. 올리자마자 바뀌는 것은 하나다. migration이 비밀번호가 있는 켜진 owner 가운데 멤버십이 가장 오래된 사람을 비상 관리자로 지정하고, 그때부터 그 사람은 끄거나(멤버십, 계정) owner가 아니게 바꾸거나 그 비밀번호를 끊을 수 없다(`409 REVISION_CONFLICT`, `details.reason_code: emergency_admin`). 그 사람을 내보내려면 먼저 비밀번호가 있는 다른 owner를 비상 관리자로 지정한다(`PATCH /v1/login-settings`). 그런 owner가 없으면 아래 복구 명령의 `reset-password`로 한 명에게 비밀번호를 준다. 비밀번호가 있는 켜진 owner가 한 명도 없는 설치는 지정이 비어 있고, 그 동안에는 비밀번호 로그인을 닫을 수 없다.
  - 콘솔에 화면이 들어왔다(JeongJaeSoon/werft#1674). owner가 설정 > 워크스페이스 > **로그인**의 "비밀번호 로그인" 구역에서 닫고, 열고, 비상 관리자를 바꾼다. 닫기 전에 화면이 누구의 세션이 끊기는지 확인받는다. 닫힌 설치의 로그인 화면은 공급자 버튼을 먼저 보이고, 비밀번호 폼은 "비상 관리자 로그인"을 누르면 나온다. 닫힌 설치의 초대 화면은 비밀번호 단계 없이 공급자 버튼만 보인다. `GET /v1/login-settings`는 비상 관리자로 지정할 수 있는 owner 목록(`emergency_admin_candidates`)을 함께 준다. 새로 요구하는 설정이나 권한은 없고, migration도 없다.
  - 올린 뒤 누가 지정됐는지 본다: `docker compose exec -T api bun run apps/control-host/src/api/login-recovery.ts status`의 `emergency_admin`.
  - 비밀번호 로그인은 로그인한 owner가 `PATCH /v1/login-settings`(`{"password_login": "emergency_only"}`)로 닫는다. 켜진 공급자가 있고, 비상 관리자가 비밀번호로 들어올 수 있고, 닫는 owner 자신이 비상 관리자이거나 켜진 공급자의 계정을 연결해 뒀을 때만 된다. 닫으면 비상 관리자를 뺀 모든 사람의 비밀번호 세션이 끊기고, 그 뒤로 비상 관리자가 아닌 사람의 비밀번호 로그인(`401`), 초대의 비밀번호 수락(`403`, 비상 관리자의 초대도 같다), 비상 관리자가 아닌 사람 앞으로 owner가 내는 재설정 링크(`409`), 켜진 마지막 공급자 끄기(`409`)가 거절된다. 닫힌 동안의 로그인과 초대 수락은 비밀번호가 맞든 틀리든 같은 답으로 끝난다.
  - 로그인이 망가졌을 때의 복구 명령 `apps/control-host/src/api/login-recovery.ts`가 들어왔다(`status`, `enable-password`, `disable-provider`, `reset-password`). API 컨테이너에서 `DATABASE_URL`만으로 돈다. `reset-password`는 token을 stdout에 그대로 낸다. 로그에 남기지 않는다. 명령, 종료 코드, 닫힌 동안의 거절은 `docs/operator/api-server.md`의 "비밀번호 로그인 끄기, 비상 관리자, 복구" 절에 있다.
  - API가 바뀐다. `GET`·`PATCH /v1/login-settings`가 생긴다. 공개 `GET /v1/auth/login-methods`의 `password`는 `on` 말고 `emergency_only`도 된다. `POST /v1/users/{user_id}/disable`과 `POST /v1/workspaces/{id}/members/{userId}/password-reset`이 `409`를, `POST /v1/login-providers/{id}/disable`이 `409`(`last_provider`)를 답할 수 있다. 새로 요구하는 환경 변수나 권한은 없다.
  - 로그인 실패 횟수를 지우는 때가 바뀐다(비밀번호 로그인을 닫지 않은 설치도). 전에는 비밀번호가 맞으면 바로 지웠고, 이제 세션이 만들어진 뒤(초대는 수락이 끝난 뒤)에 지운다. 비밀번호를 확인한 뒤 그 사이에 계정이 꺼지거나 비밀번호가 바뀌어 거절된 시도는 실패로 세어진 채 남는다. 저장소 장애(`503`)는 전과 같이 세지 않는다. 할 일은 없다.
  - 비밀번호 로그인의 때가 그 사람의 로그인 수단에 적힌다(`GET /v1/auth/me/login-methods`의 비밀번호 항목 `last_login_at`). 전에는 공급자 로그인만 적혔다. 올리기 전부터 쓰던 비밀번호는 다음 비밀번호 로그인까지 비어 있다.
  - 옛 버전으로 되돌릴 수 있다. 옛 코드는 `login_settings`를 읽지 않으므로, 되돌리면 비밀번호 로그인이 닫혀 있던 설치도 모두에게 다시 열린다. 복구 명령으로 낸 재설정 token 가운데 쓰지 않은 것은 되돌리기 전에 지운다(`DELETE FROM password_resets WHERE issued_by IS NULL AND used_at IS NULL`). 완전히 걷어내려면 그 뒤 `DROP TABLE login_settings`를 돌리고, `password_resets.issued_by`가 NULL인 행이 없을 때 `ALTER TABLE password_resets ALTER COLUMN issued_by SET NOT NULL`을 돌린다.
- **parked 요청이 수천 개인 승인 대기 그룹이 닫힌다**(JeongJaeSoon/werft#1650). 전에는 약 3,000개를 넘으면 이어 갈 turn의 메시지가 32 KiB를 넘어 그룹을 닫는 transaction이 되돌려졌고, 답은 저장된 채 turn이 이어지지 않았다. 이제 메시지에는 들어가는 만큼의 답이 그대로 실리고, 나머지는 마지막 줄 `… N more answers cut`으로 센다. 그보다 작은 그룹의 메시지는 바뀌지 않는다. 할 일은 없다.
- **release 메모(`note`)를 없앴다. `POST /v1/agents/{id}/releases`에 `note`를 보내면 400이다**(JeongJaeSoon/werft#1690). 값이 `null`이어도 거절한다. release를 담은 응답(release 생성, 에이전트 상세의 `releases`·`active_release` 등)에도 `note`가 없다. release를 만드는 스크립트·클라이언트에서 `note`를 빼고, 응답의 `note`를 읽던 곳을 고친다. 이미 남긴 메모는 DB의 `agent_releases.note`에 남지만 API로는 읽을 수 없다. 이 열은 지원 창의 이전 릴리스가 아직 읽으므로 이번에 지우지 않고, 두 릴리스 뒤의 migration이 지운다.
- **세션 목록 `GET /v1/sessions`의 항목과 세션 상세 `GET /v1/sessions/{id}`에 `activity`가 없다**(JeongJaeSoon/werft#1693). 세션의 최근 이벤트 500개를 요약하던 객체(`last`, `tool_count`, `error_count`, `subagent_count`, `current_tool`, `window`)다. 웹 콘솔은 에이전트 지도를 지운 뒤 이 값을 읽지 않는다. 이 값을 읽던 스크립트·클라이언트는 고친다. 세션 이벤트는 `GET /v1/sessions/{id}/events`로 전처럼 읽을 수 있다. migration은 없다.
- **세션 이벤트 보관(session archive)이 chunk마다 세션 activity를 계산해 저장하지 않는다. migration `0279_session_event_archive_activity_defaults`가 `session_event_archives.activity`·`activity_through`에 기본값(빈 activity, `0`)을 준다**(JeongJaeSoon/werft#1695). 위 항목으로 이 값을 읽는 API가 없어졌다. 기본값만 바꾸므로 행을 다시 쓰지 않고, 이미 보관한 행의 값은 그대로다. 두 열은 지원 창의 이전 릴리스가 아직 쓰고 읽으므로 이번에 지우지 않고, 두 릴리스 뒤의 migration이 지운다. 롤아웃 중 아직 이전 버전인 API(replica가 여럿인 배포의 교체 중)나 이전 버전으로 되돌린 API는, 이 버전이 보관한 세션의 목록 activity에서 보관된 이벤트를 세지 못하고 표에 남은 이벤트만 센다. 오류는 나지 않는다. 할 일은 없다.
- **test-ops의 `preflight`(`deploy`·`upgrade`·`start`가 부른다)가 컨테이너가 bind mount로 읽는 파일을 그 컨테이너의 사용자가 읽지 못하면 거부한다**(JeongJaeSoon/werft#1699). 대상은 postgres 초기 SQL(uid 999), 설정 문서와 `legacy-config`(migrate, uid 1000)이고, 판정은 파일의 소유자·그룹·기타 비트로 한다. root로 도는 LocalStack과 scheduler의 mount는 보지 않는다. postgres와 migrate는 호스트 사용자로 돌지 않으므로, umask `077`·`027`에서 받은 checkout이나 번들은 전에는 첫 `deploy`에서 postgres unhealthy나 migrate 실패로만 멈췄다. 이미 초기화한 postgres volume이 있는 설치는 초기 SQL을 다시 읽지 않아 지금까지 드러나지 않았을 수 있고, 이 버전의 `upgrade`·`start`에서 처음 거부된다. 거부 메시지가 적은 경로를 보고 checkout이나 번들 디렉터리에 `chmod -R o+rX`, 설정 문서에 `chmod o+r`를 실행한다.

## v0.1.3

`v0.1.2` 뒤 `main`에 들어간 변경이다. 권한 판정을 고친 항목이 있으므로 `v0.1.2`를 쓰는 곳은 올리기를 권한다.

### 보안

- **release가 `per_tool: deny`로 막은 MCP 도구를 에이전트 설정의 허용이 다시 열 수 있었다**(JeongJaeSoon/werft#1502). `v0.1.2`가 영향을 받는다. 이제 claim의 도구 목록과 egress의 `tools/call` 판정이 같은 함수로 deny를 먼저 본다. 막힌 호출은 기존과 같은 `403 FORBIDDEN`이다.
- **팀 `lead`인 member 에이전트 관리자가 관리자 팀을 붙여 그 팀 전원에게 관리 권한을 줄 수 있었다**(JeongJaeSoon/werft#1508). `v0.1.2`가 영향을 받는다. 이제 관리자 팀 추가(`POST /v1/agents/{id}/admins`의 `team_id`)는 `team.manage`(owner·admin)가 있어야 하고, 아니면 `403`이다. 이미 붙은 팀, 팀 떼기, 사람 붙이기·떼기는 그대로다. 이 호출을 자동화한 곳은 owner·admin 계정으로 바꾼다.
- **일시중지·보관된 에이전트와 승인된 적 없는 release로도 세션이 시작됐다**(JeongJaeSoon/werft#1513). `v0.1.2`가 영향을 받는다. 이제 `POST /v1/sessions`는 `409 AGENT_NOT_RUNNABLE`(`reason_code`: `agent_inactive`·`release_unapproved`)로 거절하고, Slack 경로도 같다. 승인된 이전 release는 에이전트가 활성인 동안 계속 쓸 수 있다. 세션을 만드는 자동화는 활성 에이전트와 승인된 release를 고르게 바꾼다.
- **provider 사용량 보고가 끝내 실패한 세션이 예산 한도를 넘어 계속 호출할 수 있었다**(JeongJaeSoon/werft#1515). `v0.1.2`가 영향을 받는다. 이제 egress proxy는 그 세션의 이후 provider 호출을 예산 소진(`BUDGET_EXCEEDED`)으로 거절하고 `Provider usage went unreported`를 로그에 남긴다.

### 운영자가 할 일

- **egress proxy를 control-host보다 먼저 올린다**(JeongJaeSoon/werft#1515). `openai_responses` 연결의 `/v1/responses`는 새 프록시에만 있고, 옛 프록시는 이 경로를 `404`로 거절한다. 업그레이드 문서의 순서대로 API를 먼저 올렸다면, 프록시를 올릴 때까지 `openai_responses` 연결을 만들지 않는다. Claude 연결은 어느 순서에서도 그대로 동작한다.
- **API를 worker보다 먼저 올린다**(JeongJaeSoon/werft#1539). 새 worker는 도구 호출 판단(`tool_decisions`)을 함께 보내고, 옛 API는 이 칸이 든 요청을 거절한다. `v0.1.2` worker는 `v0.1.3` API와 그대로 동작한다. `v0.1.3` worker는 다음 릴리스(프로필 제거)의 API와 동작하지 않는다(미출시 절의 "control-host와 worker 이미지를 한 upgrade로 함께 올린다").
- **api env에 `OTEL_TRACES_EXPORTER=otlp`가 있으면 이 버전부터 트레이스를 내보낸다**(JeongJaeSoon/werft#1534, JeongJaeSoon/werft#1546, JeongJaeSoon/werft#1558).
  - `TRACE_CONTENT_MODE` 기본값이 `full`이라 프롬프트·답변·도구 입출력이 수집기로 간다. 내용을 내보내지 않으려면 `metadata`로 둔다.
  - `TRACE_INGEST_URL`이 없으면 api가 키 이름을 밝히고 시작하지 않는다. worker가 닿는 api의 ingest 주소를 넣는다.
  - api가 worker 전용 ingest 포트(`TRACE_INGEST_PORT`, 기본 `4319`, Helm은 `config.tracing.ingestPort`)를 더 연다. worker는 egress proxy를 지나 이 포트에 닿으므로 compose는 `EGRESS_PRIVATE_ALLOWLIST`에 `api:<포트>`를 더하고, Helm은 `config.egress.privateAllowlist`를 `<api Service 이름>:3000,<api Service 이름>:<포트>`로 직접 지정한다.
  - 키를 비운 설치는 할 일이 없다. 절차는 `docs/operator/api-server.md`를 따른다.
- **DB 마이그레이션 7개(`0263`~`0269`)가 `migrate`에서 적용된다.** 열·테이블·인덱스를 더하는 것이 대부분이다. `0265_agent_usage`는 기존 에이전트마다 `scope = workspace` 행을 넣는다(JeongJaeSoon/werft#1553). `0264_runtime_tools_source`는 트랜잭션 없이 돌며 `sessions`에 기본값 `profile`인 NOT NULL 열과 CHECK를 더한다. 중간에 실패하면 이미 커밋된 문장은 남고, 다음 `migrate`가 이 파일을 처음부터 다시 돌린다(JeongJaeSoon/werft#1524). 올리기 전에 DB를 백업한다.
- **API로 만든 카드에서 `language`를 빼면 이제 `follow-user`다**(JeongJaeSoon/werft#1504). 전에는 `ko`로 저장됐다. 이미 저장된 `ko`는 바뀌지 않는다. 한국어 고정이 필요한 새 카드는 `language: ko`를 적는다. 고정 언어(`en`·`ja`·`ko`)는 이제 사용자가 다른 언어로 써도 그 언어로 답한다.

## v0.1.2

`v0.1.0` 뒤 첫 게시 릴리스다. `v0.1.1` 태그는 게시에 실패해 패키지와 Release가 없으므로, 아래 `v0.1.1` 절의 변경도 모두 이 버전에 들어 있다. `v0.1.0`에서 올릴 때 따를 절차는 이 절의 "운영자가 할 일"이다. `v0.1.1` 절의 "운영자가 할 일"은 그 시점의 기록이라 마이그레이션 범위와 `AGENT_ACTION_FLOWS` 절차가 이 버전에는 맞지 않으므로 따르지 않는다.

### 보안

- **`werft-worker` 이미지의 git-lfs가 링크한 `github.com/klauspost/compress`를 1.20.2로 올렸다**(GO-2026-6865, JeongJaeSoon/werft#1277). 자세한 영향은 `v0.1.1` 절의 보안 항목과 같다. `v0.1.0`의 worker 이미지는 취약 버전을 담고 있으므로 올리기를 권한다.

### 운영자가 할 일

- **`v0.1.0`에서 올리면 DB 마이그레이션 27개(`0236`~`0262`)가 `migrate`에서 적용된다.** 새 열·테이블·인덱스를 더하는 것이 대부분이지만, 기존 행을 채우거나 바꾸는 `UPDATE`·`INSERT`와 제약 변경이 든 것도 있다. `0243_agent_managing_team_required`는 백필 뒤 `SET NOT NULL`을 건다. 적용한 뒤에는 `v0.1.0` 이미지로 되돌려도 동작한다고 보장하지 않으니 올리기 전에 DB를 백업한다.
- **올리는 순서는 control-host·API·검증기·GC·세션 보관 CronJob을 먼저, worker를 나중에 한다**(아래 체크포인트 항목). 옛 이미지로 시작한 정리 Job이 끝났는지 확인한 뒤 worker를 올린다. `AGENT_ACTION_FLOWS`는 이 버전이 읽지 않으므로 켜는 절차는 없다.
- **Slack 연동 env를 정리했다. 공개 주소는 `CONSOLE_ORIGIN` 하나다**(JeongJaeSoon/werft#1439). Slack 계정 연결의 redirect(`<CONSOLE_ORIGIN>/settings/linked-accounts/slack`)와 이벤트 주소(`<CONSOLE_ORIGIN>/v1/slack/events/<agent_id>`)는 여기서 계산하고, 설정 > 연동 > Slack 화면에 복사할 수 있게 보인다. 올리기 전에 `CONSOLE_ORIGIN`을 api와 slack role에 넣는다.
  - `SLACK_OIDC_REDIRECT_URI`: 이제 읽는 값이 아니다. `CONSOLE_ORIGIN`이 없을 때만 이번 릴리스에서 그 origin을 폴백으로 쓰고, 다음 릴리스에서 폴백도 없앤다. 시작할 때 "폐기 예정" 경고가 나온다. `CONSOLE_ORIGIN`을 넣은 뒤 지운다.
  - `SLACK_OIDC_CLIENT_ID`·`SLACK_OIDC_CLIENT_SECRET`: 읽지 않는다. 이 값으로 손으로 만든 OIDC 앱에 연결하던 워크스페이스는 설정 > 연동 > Slack에서 App Configuration Token을 넣고 link 앱을 만들어야 구성원이 Slack 계정을 연결할 수 있다. 만들기 전에는 그 워크스페이스의 연결이 막힌다.
  - `SLACK_EVENTS_PUBLIC_URL`: 이벤트 입구를 콘솔과 따로 둘 때만 남기는 선택 값이다. 없으면 콘솔 origin이 이벤트 주소다. 콘솔이 https가 아니면 이벤트 구독이 등록되지 않는다(`events_url_unset`; 이 호스트의 loopback과 mock은 예외). 계산값과 다르면 시작할 때 값 없이 "불일치" 경고만 나온다.
  - `SLACK_API_URL`·`SLACK_OIDC_ISSUER`: mock Slack 시험 전용이다. 운영 설정에 두지 않는다. Slack이 아닌 곳을 가리키면 시작할 때 경고가 나오고, 동작은 그대로다.
  - 이 버전보다 앞선 이미지로 되돌릴 수 있는 동안에는 지우려던 옛 env 줄(`SLACK_OIDC_REDIRECT_URI`, 따로 두는 이벤트 입구의 `SLACK_EVENTS_PUBLIC_URL`, 손으로 만든 앱의 `SLACK_OIDC_CLIENT_ID`·`SLACK_OIDC_CLIENT_SECRET`)을 남긴다. 앞선 이미지는 `SLACK_OIDC_REDIRECT_URI`가 없으면 Slack 연결이 503이고 `SLACK_EVENTS_PUBLIC_URL`이 없으면 이벤트 구독을 등록하지 않는다.
- **에이전트 엔진 입력에서 플랫폼 지시문을 걷어냈다.** 시스템 프롬프트, 도구 설명과 응답, 후속 턴 메시지(Slack 승인·parked 재개 포함)에는 사실만 적고 채널(Slack·웹)은 말하지 않는다. 설치 설정 `SESSION_PROMPT_REVISION`과 `AGENT_ACTION_FLOWS`는 없어졌고 값을 줘도 읽지 않는다. 턴 안의 `request_push`는 언제나 의도 흐름이며 턴 밖에서는 `no_running_turn`으로 거절하고, 이어 턴(`push_continuations`)은 더 만들지 않는다. 옛 플랫폼 문단으로 만든 체크포인트는 worker가 동결한 문구로 지문을 다시 계산해 그대로 재개한다(JeongJaeSoon/werft#1401).
- **worker는 이제 모든 세션의 체크포인트에 로컬 브랜치를 담는다**(`workspace.sources`, `refs/checkpoint/source/*`). 옛 API·검증기는 이를 거절하므로 API·검증기·GC·세션 보관 CronJob을 먼저 올리고 worker를 나중에 올린다. 순서가 어긋나면 새 worker의 체크포인트가 거절되는 동안 push가 막히지만 데이터는 잃지 않는다.

## v0.1.1

`v0.1.1`은 게시되지 않았고 변경은 `v0.1.2`에 포함된다. 아래는 `v0.1.1` 태그를 만들 때의 기록이다. 올리는 절차는 `v0.1.2` 절을 따른다.

`v0.1.0` 뒤 `main`에 들어간 변경이다. 보안 수정이 있으므로 `v0.1.0`을 쓰는 곳은 올리기를 권한다. `v0.1.1` 태그로 게시하면 이미지 태그는 `v0.1.1`, chart 버전은 `0.1.1`이고 둘 다 태그에서 정해진다(`Chart.yaml`의 `version`은 태그 릴리스에 쓰이지 않는다).

### 보안

- **worker 이미지의 git-lfs가 링크한 `github.com/klauspost/compress`를 1.19.1에서 1.20.2로 올렸다**(JeongJaeSoon/werft#1277). 취약점 번호는 GO-2026-6865이고, 수정 버전은 1.20.2다. 영향은 `werft-worker` 이미지 안의 git-lfs 바이너리다. 이미지 스캔이 이 취약점을 잡은 것은 worker 이미지뿐이고, 이미지에 들어가는 변경도 worker의 Dockerfile 하나다. `v0.1.0`의 worker 이미지는 이 취약 버전을 담고 있고, 이미지 스캔(`supply-chain`)이 수정 가능한 high로 잡는다.

### 운영자가 할 일

`v0.1.0`에서 올릴 때 직접 해야 하는 일이다. 업그레이드 명령은 [업그레이드](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/upgrade/)를 따른다.

1. **DB 마이그레이션 네 개(`0236`~`0239`)가 `migrate`에서 적용된다.** 모두 추가형이다(열·테이블·인덱스 추가). `0239_connection_replaces_auth`는 `provider_connections.replaces_auth`를 더하고, 앞 이미지로 돌아가도 새 열은 무시된다(JeongJaeSoon/werft#1262).
2. **control-host를 먼저, worker를 나중에 올린다**(JeongJaeSoon/werft#1254). 새 worker는 claim과 poll에 `platform_tool_trust`를 싣고, 이 칸을 모르는 옛 control-host는 본문을 거절한다. worker는 그 거절을 받으면 `platform_tool_trust`를 빼고 다시 보내므로 순서가 어긋나도 통신이 끊기지는 않지만, 그 동안 이 도구는 엔진 권한 단계를 지난다.
3. **턴이 끝날 때 push하는 흐름은 `AGENT_ACTION_FLOWS`가 기본 off다**(JeongJaeSoon/werft#1252). 켜려면 먼저 api, `maintenance`(compose), `checkpointGc`·`sessionArchive` CronJob(Kubernetes)이 모두 이 버전 이미지로 돌고 있고, 옛 이미지로 시작한 Job이 끝났어야 한다. 옛 이미지의 checkpoint 정리가 고정한 revision을 지울 수 있기 때문이다. worker 이미지도 이 버전으로 올린 뒤에 켠다. 켠 뒤에 만든 세션은 프롬프트 리비전 2를 받는데, 옛 worker는 그 claim을 읽지 못한다. 값은 `true`·`false`·`1`·`0`만 받고, 다른 값이면 api가 시작하지 않는다. 절차와 되돌리기는 `docs/operator/api-server.md`의 "턴이 끝날 때 push하기"를 따른다.

### GitHub 작업

- 에이전트가 이번 턴의 commit을 이어 가는 턴 없이 push한다. `request_push`가 push 의도만 남기고, 턴이 끝나면 finalize가 revision을 고정해 control-host 안의 실행기가 push 요청을 만든다. `AGENT_ACTION_FLOWS`가 켜진 곳에서만 쓴다(JeongJaeSoon/werft#1252).
- PR을 예약한 push는 push가 끝나면 플랫폼이 PR을 연다. 모든 push가 PR을 여는 것은 아니고, PR 내용을 맡긴 요청에만 적용된다. control-host 안의 action-broker가 저장소·head·base를 forge에서 다시 대조해 만들거나 이어받고, 결과마다 알림(ko·ja·en)이 간다(JeongJaeSoon/werft#1253). PR 내용은 push가 끝나기 전에 REST `?schedule=true`와 MCP `open_pull_request({ push_intent_id })`로 맡기고, MCP `get_push_request`로 요청 상태를 읽는다(JeongJaeSoon/werft#1259).
- **`request_push({ pull_request: … })`는 `AGENT_ACTION_FLOWS` 값과 상관없이 `pull_request_needs_tool_call`로 거절되고 아무것도 만들지 않는다.** PR은 `open_pull_request`를 따로 불러 연다(JeongJaeSoon/werft#1259).
- 세션 화면이 PR 단계(`due`부터 `cancelled`까지)와 끝난 사유, PR 번호 링크를 보여 준다. `PushRequest`에 `pr_error`·`pr_number`·`pr_url`이 기본 null로 더해졌다(가산)(JeongJaeSoon/werft#1257).
- PR 본문 서식(저장소 템플릿 선택, 서식 끄기, 에이전트별 템플릿, 세션 링크 표기)을 워크스페이스와 에이전트 설정에서 바꾼다. 새 API 경로 두 개가 더해졌다(JeongJaeSoon/werft#1245).
- push·PR·저장소 읽기 도구는 서버 정책이 이미 판정하므로 엔진 권한 단계(사람 허용 카드, auto 분류기)에서 뺐다. 리뷰와 workflow 도구는 그대로 엔진을 지나고, `plan` 모드에서는 이 도구도 기존대로 엔진이 판정한다(JeongJaeSoon/werft#1254).

### 모델 연결

- 모델 키를 콘솔의 모델 연결 화면에서 넣는 것이 기본이다. 단일 서버는 `ANTHROPIC_API_KEY` 없이도 기동한다. 키 없는 연결의 프로필로 세션을 시작하면 화면 경로를 알리는 거부 메시지(`connection_missing`)가 나온다(JeongJaeSoon/werft#1262).
- env 참조로 만든 모델 연결을 화면에서 stored로 바꿀 수 있다(`POST /v1/installation/settings/connections/{id}/convert`). 서버는 env 값을 읽어 옮기지 않고 사람이 입력한 값만 봉인한다(JeongJaeSoon/werft#1262).

### 단일 서버

- 저장소 값을 에이전트 설정 행과 워크스페이스 상한으로 옮기는 이행 스크립트에 쓰기(`apply`), before-image, 되돌리기(`revert`)가 더해졌다. 자동으로 실행되지 않고, 실행은 운영자가 정한다(JeongJaeSoon/werft#1244).

### 게시와 문서

- `v` 태그의 `release` 환경 승인이 `publish` 앞 한 번으로 줄었다(JeongJaeSoon/werft#1275).
- 셀프 호스팅 문서가 첫 `v` 태그 없음·미확인 문구를 `v0.1.0`과 실측 결과에 맞췄다(JeongJaeSoon/werft#1276). PR 단계 문서가 ko·ja·en으로 더해졌다(JeongJaeSoon/werft#1257).

## v0.1.0

첫 릴리스 `v0.1.0`이 `9e2098e5`에 게시됐다(GitHub Release, 이미지 태그 `v0.1.0`, chart `0.1.0`). `main`에 머지될 때마다 나오는 `main-<12>` 이미지 태그와 `0.1.0-main-<12>` chart는 릴리스가 아니다. SDK `@werft-ai/sdk`는 npm에 올라 있다(현재 `latest`는 `0.1.2`).

이름이 `agent-platform`에서 `werft`로 바뀌었고 옛 이름과의 호환은 없다. 이전 스냅샷으로 만든 설치는 제자리로 올릴 수 없으므로 새로 설치한다.

### 운영자가 할 일

이미 `main-<12>` 게시물로 설치한 곳이 올릴 때 직접 해야 하는 일이다. 업그레이드 명령은 [업그레이드](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/upgrade/)를 따른다.

1. **지표 이름이 `werft`로 바뀌었다. 옛 이름 별칭은 없다**(JeongJaeSoon/werft#1188).
   - Prometheus: `agent_platform_*`가 `werft_*`가 됐다. 이름 외에 라벨, 단위, 의미는 같다. 이 지표로 만든 규칙과 대시보드의 쿼리를 바꾼다.
   - Datadog: 사용자 지표 `agent_platform.*`가 `werft.*`가 됐다. 정의(`infra/datadog/definitions`의 log metric, 모니터, 대시보드)는 자동으로 적용되지 않는다. 새 정의를 적용하기 전에는 옛 지표 id가 계속 쌓이고, 적용하면 새 id로 시계열이 새로 시작한다. 옛 시계열은 이어지지 않는다. Datadog Agent의 postgres 설정 `metric_prefix`도 `werft`가 됐다.
   - 로그 파이프라인의 grok 규칙 이름 `agent_platform_json`은 `werft_json`이 됐다. 규칙 이름만 바뀌고 동작은 같다.
   - Datadog compose overlay를 쓰는 곳은 overlay를 새로 적용하면 `http_check` 인스턴스 이름 `agent-platform-readyz`가 `werft-readyz`로, 로그 `source:agent-platform`이 `source:werft`로 바뀐다(JeongJaeSoon/werft#1189). Helm으로만 설치한 곳은 이 이름들을 쓰지 않으니 바꿀 것이 없다. 옛 이름으로 만든 모니터 쿼리(`instance:agent-platform-readyz`), 로그 파이프라인 필터(`source:agent-platform OR service:werft-worker`), 저장한 로그 검색을 새 이름으로 바꾼다.
2. **CSS 이름이 `werft`로 바뀌었다**(JeongJaeSoon/werft#1188). 웹 콘솔을 임베드하며 스타일을 덮어쓰는 곳이 해당한다. 옛 이름은 조용히 무시된다.

   | 옛 | 새 |
   | --- | --- |
   | `--ap-*` (CSS 변수) | `--werft-*` |
   | `ap-button`, `ap-dialog`, `ap-input`, `ap-state`, `ap-status`, `ap-receipt`, `ap-skeleton`, `ap-visually-hidden`와 `__`·`--` 변형 | `werft-*` |
   | `data-ap-button`, `data-ap-dialog` | `data-werft-button`, `data-werft-dialog` |
   | `@layer ap` | `@layer werft` |
   | 키프레임 `ap-spin`, `ap-pulse`, `ap-fade-in`, `ap-dialog-in` | `werft-*` |

   worker 이름 `ap-worker-*`는 이미 떠 있는 스택의 소유권 판별에 쓰이므로 바꾸지 않았다. 작업 공간·네트워크 이름과 라벨은 아래 8번에서, compose project 이름은 10번과 11번에서 바뀐다.
3. **chart와 이미지 이름이 `werft`다**(JeongJaeSoon/werft#1166). chart 이름이 `agent-platform`이던 release는 지우고 새로 설치한다.
4. **설정 파일 카탈로그가 없어지고 DB 설정만 쓴다**(JeongJaeSoon/werft#1167). 파일 카탈로그로 돌던 이전 스냅샷의 설치는 제자리로 올릴 수 없으므로 새로 설치한다.
5. **worker 이미지가 같아도 직전 이미지(`images.workerPrevious`)를 빼거나 바꾸면 업그레이드 전 검사가 `refused`로 멈출 수 있다**(JeongJaeSoon/werft#1204). 대상 이미지(현재 이미지와, 있으면 직전 이미지) 어느 쪽과도 맞지 않거나 조합이 기록되지 않은 세션이 있을 때다. 이전에는 그대로 통과했고, 맞지 않는 세션은 재개 때 멈췄다. 보관한 `worker-previous.json`을 계속 넘긴다. 이 검사의 직전 이미지 경로는 클러스터에서 실행해 확인하지 않았다.
6. **worker가 workspace에 남기는 이름이 `werft`로 바뀌었다**(JeongJaeSoon/werft#1226). 지침 파일 제외 마커는 `# werft: instruction files`, 복원 디렉터리는 `.git/werft-checkpoint`, 임시 이름은 `.git/werft-<용도>-*`다. 이전 스냅샷으로 만든 workspace는 새로 만든다.
7. **세션 쿠키 이름과 CSRF 헤더 값이 `werft`로 바뀌어 올린 직후 로그인이 한 번 끊긴다**(JeongJaeSoon/werft#1231). 세션 쿠키는 `__Host-ap_session`에서 `__Host-werft_session`으로, Google 로그인 쿠키는 `__Host-werft_google_login`으로, GitHub·Slack 연결 쿠키는 `werft_github_link`·`werft_slack_link`로 바뀌었다. 옛 쿠키는 읽지 않으므로 모든 사용자가 다시 로그인한다. 데이터는 잃지 않고, 진행 중이던 GitHub·Slack 연결과 Google 로그인은 처음부터 다시 한다. `X-Requested-With: agent-platform-web`을 보내던 스크립트는 쿠키 세션의 변경 요청에서 `403`을 받으므로 `werft-web`으로 바꾼다. API key 호출에는 영향이 없다.
8. **컨테이너·볼륨·Pod의 라벨과 이름 접두사가 `werft`로 바뀌었다**(JeongJaeSoon/werft#1232). 라벨은 `agent-platform.*`에서 `werft.*`로, Kubernetes의 `part-of`는 `werft`로, 작업 공간 볼륨·PVC 이름은 `ap-ws-*`에서 `werft-ws-*`로, 네트워크는 `ap-net-*`에서 `werft-net-*`로 바뀐다. 볼륨 라벨과 PVC 이름은 만든 뒤에 고칠 수 없어서, 이전 스냅샷으로 만든 설치를 그 자리에서 올리면 기존 작업 공간을 찾지 못한다. 이 경우 새로 설치한다.
9. **기본 secret id가 `werft/*`로 바뀌었다**(JeongJaeSoon/werft#1239). 로컬 스택의 시드, 예시 설정 문서, Helm 예시(`werft/prod/control-plane`)가 해당한다. 옛 id로 설정을 import한 DB에 새 예시 문서를 import하면 충돌로 전체 거부되어 `migrate`가 실패하고 API가 시작하지 않는다. 이전 스냅샷의 DB는 그대로 쓰지 말고 새로 설치한다.
10. **단일 서버(test-ops)의 기본 설정 파일, 상태 디렉터리, compose project, Datadog 환경 파일 경로가 `werft`로 바뀌었다**(JeongJaeSoon/werft#1251). 새 기본값은 `/etc/werft`, `/var/lib/werft/test-ops`, `werft-test-ops`다. 이전 스냅샷으로 만든 설치는 옛 경로의 설정 파일을 읽지 않으므로 제자리로 올릴 수 없다. 새로 설치한다.

11. **로컬 스택의 compose project, kind 클러스터, 백업 스크립트 기본값, 상태·캐시 디렉터리가 `werft`로 바뀌었다**(JeongJaeSoon/werft#1247). 새로 띄우는 스택은 `werft` project의 새 volume에서 시작한다. 이전 이름으로 띄운 스택의 데이터는 지우지 않지만 새 project는 읽지 않는다. 비밀 키 파일이 없는데 project의 `postgres-data` volume이 있으면 `scripts/local.sh up`은 새 키를 만들지 않고 멈춘다. 새 키로는 저장된 비밀 값을 못 읽기 때문이다.

### 게시 패키지

- 이미지 셋(`werft-control-host`, `werft-worker`, `werft-egress-proxy`)이 `ghcr.io/jeongjaesoon/`에 `main-<12>` 태그로 `main` 머지마다 게시된다(JeongJaeSoon/werft#1168).
- 이미지는 `linux/amd64`와 `linux/arm64`를 담은 index다. 노드가 자기 아키텍처를 받고, chart의 digest는 index를 가리킨다(JeongJaeSoon/werft#1186). 이 변경 전의 `main-<12>` 태그는 amd64뿐이다.
- Helm chart `werft`가 `oci://ghcr.io/jeongjaesoon/werft`에 `0.1.0-main-<12>` 버전으로 게시된다. chart 하나가 세 이미지의 digest와 worker runtime을 담아, checkout 없이 설치한다(JeongJaeSoon/werft#1177). 로그인 없이 받는다.
- TypeScript SDK `@werft-ai/sdk`는 npm trusted publishing으로 게시된다(JeongJaeSoon/werft#1176).

### 단일 서버

- `scripts/test-ops.sh`에 `stop`(volume 유지)과 `start`(내려간 설치를 같은 volume으로 다시 올림)를 더했다. `compose down`이나 재부팅 뒤에는 `deploy`(release 기록이 있어 거부)나 `upgrade`(postgres 없이 실패)가 아니라 `start`를 쓴다. 재부팅하면 postgres, api, localstack은 스스로 올라오지 않으므로 `start`를 직접 부른다(JeongJaeSoon/werft#1249).

### 게시 이미지에서 빠진 것

- 게시 이미지(control-host, worker, egress-proxy)에서 테스트 소스, testkit, Storybook, 스냅샷, 데모 계정·데모 데이터를 뺐다(JeongJaeSoon/werft#1194). 이미지가 작아지고, 서버에 시험 도구가 남지 않는다.
- 그래서 **게시 이미지로 띄운 스택(게시 chart로 띄운 preview 포함)에서는 데모 계정 CLI(`demo-accounts.ts`)를 쓸 수 없다.** 부르면 `Module not found`로 실패한다. 데모 계정과 시험용 IdP, mock-slack은 저장소의 로컬 스택(`local` target)에만 있다.

### 문서

- 셀프 호스팅 문서를 단일 서버 설치와 Kubernetes 설치로 나눴다(JeongJaeSoon/werft#1193). Kubernetes 설치는 게시 chart로 kind에서 확인했으나 DB Secret 단계는 문서 블록 그대로가 아니었고, 고친 kind Secret 블록은 실행하지 않았다. 이후 `v0.1.0`과 같은 commit(`9e2098e5`)에서 `main-<12>` 게시물로 확인했다(Kubernetes: chart 설치부터 rollout, readyz·docs 200, bootstrap 201과 재요청 409, 키 있음 200·없음 401. 단일 서버: 3~7단계에서 readyz·docs 200, bootstrap 201, 키 있음 200·없음 401). 실제 AWS S3·IAM과 실제 DNS·공인 인증서에서의 실행은 아직 실측하지 않았다.
- 업그레이드 문서를 한국어, 영어, 일본어로 문서 사이트에 더했다. 업그레이드 문서가 적은 범위 밖의 절차와 **릴리스 버전(`v0.1.0`)으로 올리는 업그레이드는 실행해 확인하지 않았다.**

### 라이선스

- 저장소는 [PolyForm Small Business License 1.0.0](LICENSE)을 따르는 source-available 코드다.
- `packages/sdk`(npm `@werft-ai/sdk`)와 `examples/`만 Apache License 2.0이다. 범위는 [README](README.md#라이선스)에 있다.
