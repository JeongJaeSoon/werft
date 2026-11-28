# 상태 기계

네 상태 기계(세션 admission, turn·attempt, 대화 turn, rollout 스위치)의 전이를 더하거나 바꾸는 변경은 그 기계의 표를 여기에 적거나 함께 고친다. 표마다 지금 상태, 입력과 조건, 다음 상태, 누가 일으키는지를 적고, 지켜야 할 성질을 함께 적는다.

절에는 세 가지를 적는다.

- 전이 표: 지금 상태, 다음 상태, 조건, 누가 일으키는지.
- 막을 전이: 일어나면 안 되는 전이와 그것을 거절하는 시험.
- 지킬 성질: 어떤 전이를 거쳐도 참이어야 하는 문장과 그것을 고정하는 시험.

허용 전이마다 성공 시험을 하나, 막을 전이마다 거절 시험을 하나 둔다.

## 1. 세션 admission

### 덮이지 않은 turn이 일으키는 전이

2번 절이 기대는 전이다.

| 지금 상태 | 다음 상태 | 조건 | 누가 일으키나 |
| --- | --- | --- | --- |
| active | recovery_required (status failed, reason context_gap) | 실행이 사라진 것이 확인됐거나 새 worker가 claim했고, 열린 turn이 없고, 마지막으로 돈 turn을 덮는 checkpoint가 없다. 끊긴 turn은 돈 turn으로 세지 않는다 | scheduler(실행 종료 확인), worker의 claim |

### 답을 기다리는 요청이 일으키는 전이

실행 중에 사람의 답이 필요한 요청(pending request)이 오래 답을 받지 못하면 플랫폼이 turn을 park한다. 전이는 요청의 종류와 상관없이 같다.

| 지금 상태 | 다음 상태 | 조건 | 누가 일으키나 |
| --- | --- | --- | --- |
| active | pausing (`pause_reason = awaiting_input`) | 열린 요청이 park 시한까지 답을 받지 못했다(`openSystemPark`, `packages/db/src/sessions/pause-control.ts`) | 서버(worker의 pendingControl 응답에 `park`를 싣는다) |
| pausing (`awaiting_input`) | paused | worker가 turn을 `input_wait_parked`로 끝내고 release했고 실행이 사라졌다 | worker(finalize), scheduler(실행 종료 확인) |
| paused (`awaiting_input`) | resuming, 그다음 active | park된 요청 묶음의 마지막 답이 왔다. 이어 하는 turn이 queued로 생긴다(`packages/db/src/sessions/parked-group.ts`) | 답한 사람(API, Slack) |

요청을 만드는 것은 둘이다.

- 질문 요청: 에이전트가 사람에게 묻는 질문.
- 권한 요청: 엔진이 도구 호출을 사람에게 물었고 어댑터가 그 물음에 스스로 답하지 않은 경우.

어댑터는 엔진이 물은 shell 명령과 파일 쓰기를 작업 공간 정책으로 다시 읽고, 사람에게 남길 까닭을 찾지 못하면 스스로 답한다(감사 근거 `sandbox_boundary`). 그런 호출은 요청이 되지 않으므로 위 전이를 일으키지 않는다. 판정은 글자로 하므로 변수·치환이 만드는 경로와 스크립트 안의 동작은 보지 못한다. 사람에게 남는 권한 요청을 묶으면 다음과 같다. 판정기의 시험은 `packages/runtime-core/src/asked-line.test.ts`에 있다.

| 사람에게 남는 것 | 판정하는 곳 |
| --- | --- |
| 정책의 묻기 목록에 든 명령 | `packages/runtime-core/src/asked-line.ts`의 `keptForPerson` |
| 비밀 이름, `.git`, `.claude` 경로에 쓰기 | 같음, 파일 도구는 `writeKeptForPerson` |
| 작업 공간 밖 경로 | 같음 |
| 위 셋이 없어도: shell이 어디에 서 있는지 알 수 없을 때(줄이 말하지 않는 이동, 여덟 곳 넘는 자리), 작업 공간 디렉터리 자체에 쓰기, 너무 깊이 감싼 스크립트, 묻기 목록과 대조하기에 너무 긴 줄 | 같음 |
| Claude 엔진 auto 모드에서 확실히 나뉘지 않는 줄, 목록 밖 명령, 파일 도구 | `askedLineRefusal`(분류기가 뒤에 있어 좁게 읽는다) |
| 엔진이 물은 MCP 도구(서버가 판정하는 도구 제외), plan 모드에서 엔진이 물은 호출, release가 Bash나 파일 도구를 deny 규칙으로 좁힌 세션, shell의 위치를 모르는 호출 | Claude 어댑터의 `canUseTool` |
| 읽어 낼 수 없는 명령 꼴(알 수 없는 shell 시작 꼴), 모르는 모양의 파일 변경 기록, 더 넓은 `grantRoot` | Codex 어댑터의 `sandbox-answers.ts` |

- 서버가 판정하는 push 관문(push 요청의 allow·ask·deny)과 토큰 범위는 이 절의 대상이 아니고 바뀌지 않는다.

지킬 성질:

- 권한 요청이 줄어도 질문 요청의 기다림, park, 이어 하기는 그대로 동작한다.
- 어댑터가 스스로 답한 호출은 요청을 만들지 않고, 감사에는 `sandbox_boundary`로 남는다(Claude는 도구가 끝났다는 hook을 받은 뒤, Codex는 답할 때 보고한다. Claude에서 엔진이 그 뒤 거절했거나 끝 hook이 오지 않으면 줄이 남지 않는다).
- park는 이미 도착해 처리 중인 답이 있으면 열리지 않는다. 답 없이 모두 만료된 park는 사람의 resume이 있어야 이어진다.

시험: `packages/db/src/parked-requests.integration.test.ts`의 `a parked question waits like a permission, and its answer resumes the park`, `packages/adapters/runtimes/claude/src/sandbox-answers.test.ts`의 `a line the policy does not keep runs without a person, recorded as the sandbox's`와 `… still goes to a person` 표, `packages/adapters/runtimes/codex/src/run.test.ts`의 `work inside the session's sandbox` 묶음, `packages/runtime-core/src/asked-line.test.ts`.

### 멈춤(stop)이 일으키는 전이

멈춤은 요청자의 Slack 멈춤 낱말 같은 stop 요청이다(`packages/db/src/stop-control.ts`). 기다리던 입력을 취소하고, 도는 턴이 있으면 그 턴을 중단하게 한다.

| 지금 상태 | 다음 상태 | 조건 | 누가 일으키나 |
| --- | --- | --- | --- |
| `active` | `closed` (status `stopped`) | 작업 세션(`task_closing` 있음)이고, 시작된 턴(`started_at` 있음)도 도는 턴도 없으며, 멈춤이 기다리던 입력을 하나 이상 취소했다 | 세션을 제어할 수 있는 사람의 멈춤 |
| `active` | `active` | 위 조건이 아닐 때: 작업이 아닌 세션, 첫 턴이 시작된 작업, 취소할 입력이 없는 멈춤 | 같음 |
| `closing`, `closed` | 그대로 | 멈춤은 `closed`로 답하고 아무것도 바꾸지 않는다 | 같음 |
| `paused`, `stopped`, `recovery_required` 등 | 그대로 | 기다리던 입력을 취소하고, 도는 턴이 있으면 중단을 요청한다 | 같음 |

`active` → `closed`는 recovery close와 같은 방식으로 닫는다(`closeSessionRow`). 디스패치 대기열(`unassigned_sessions`)에서 빠지고, 묶인 execution에는 kill intent를 쓰고, lease epoch를 올려 claim한 worker를 막는다. 작업은 `task_closed_reason = cancelled`로 끝나고, 스트림에는 `closed_by: stop_before_start`인 status 이벤트와 `session_closed` 이벤트가 남는다.

지켜야 할 성질:

- 시작된 턴이 하나라도 있는 세션은 멈춤으로 닫히지 않는다. 멈춘 세션은 열린 채로 다음 입력을 받는다.
- 멈춤으로 닫힌 작업은 열린 작업 상한(`openTaskLimit`)의 칸을 그 트랜잭션에서 돌려준다.
- 멈춤으로 닫힌 세션에는 새 launch가 나지 않는다. scheduler가 예약할 수 없다. 멈춤 전에 provider 호출에 들어간 launch는 kill intent(`desired_state = terminated`)를 보고 거둔다. close와 terminate도 같은 방식으로 거둔다.
- 세션을 닫은 멈춤의 Slack 안내를 쓰지 못하면 그 줄은 잃고, 그 실패로 이벤트를 다시 처리하게 하지 않는다. 링크가 닫힌 뒤의 재시도는 뒤에 적은 대로 이미 한 멈춤으로 끝나 그 줄을 쓰지 않는다. 같은 글이 다른 길로 다시 처리되는 경우(같은 글의 `message`와 `app_mention`이 outbox pass를 사이에 두고 따로 도착할 때, 멈춤 커밋 뒤 inbox complete 전에 lease가 끝났을 때)도 멘션이 되지 않는다. 멈춤 낱말 하나뿐인 글이 오면, receive path는 그 스레드의 닫힌 링크 세션(`session_links_closed_surface_ref_idx`)에서 이 글의 멈춤 키(`session_stops`, `slack-stop:<team>:<channel>:<ts>`)를 찾고, 있으면 처리된 것으로 끝낸다. 어디서 끝내는지는 이벤트가 채널 종류를 담았는지에 따른다. `channel_type`을 담은 이벤트는 판정 버퍼(`m1_engaged` 포함)보다 먼저 끝낸다. `group`이면 그 앞에서 공개 binding을 승인 대기로 바꾸되 안내는 쓰지 않는다. `channel_type`이 없는 멘션 없는 `message`가 열린 링크 없이 판정 버퍼로 가는 길이면 그 앞에서 끝낸다. 그 길은 원래 Slack에 채널 종류를 묻지 않는다. 그 밖의 `channel_type` 없는 글(`app_mention`, 멘션한 `message`, 열린 링크가 있는 스레드의 멘션 없는 답글)은 binding이 있고 DM의 것이 아니면 Slack에 채널 종류를 묻는다. 비공개로 바뀌었으면 승인 대기로 바꾸고 승인 대기 안내를 쓴 뒤 끝내고, 종류가 다르면 거절 안내(안내 조건을 채울 때)를 쓴 뒤 끝낸다. 둘 다 아니면 멘션 처리표의 안내·입력 권한 판단·작업의 멈춤과 입력보다 먼저 끝낸다. 멘션 처리표의 조용한 반환은 이 확인보다 앞선다. 그 사이 같은 스레드에 새 작업이 열렸어도 같다: 앞 작업을 닫은 글은 새 작업을 멈추지 않는다. 멈춤 안내는 다시 쓰지 않는다. 닫힌 스레드에 사람이 새로 쓴 멈춤 낱말은 다른 글(다른 키)이라 다른 글과 같이 다뤄진다: 봇을 멘션했거나 DM이면 멘션 처리표로 간다.
- 멈춤의 Slack 안내(닫힘 안내와 옛 멈춤 안내)는 멈춤 낱말을 쓴 사람의 Werft 사용자 locale로 쓴다. 연결된 사용자가 없으면 배포 기본 locale이다. outbox kind는 스레드 안내의 `failure_notice`이다. kind로 실패를 세는 곳은 없고, outbox 집계(`sent`·`failed`)는 kind와 상관없이 전송 결과로 센다.
- 멈춤으로 닫힌 작업의 스레드 링크는 세션의 `task_closed_reason`(`cancelled`)으로 닫힌다(`closeFinishedLinks`). 작업 사유가 없는 세션만 close receipt로 `completed`·`abandoned`를 가른다.
- 같은 멈춤을 같은 키로 다시 보내면 처음 결과를 돌려준다. 닫혔는지는 세션 행에서 다시 읽으므로, 이 변경 전에 요청이 취소된 채 열려 있던 작업을 나중 멈춤이 닫았다면 앞선 멈춤의 재시도도 닫힘으로 답한다.

시험: `packages/db/src/stop-control.test.ts`, `apps/control-host/src/slack/session-handler.integration.test.ts`의 Slack stop 시험(재처리 두 경우는 `… after an outbox pass closed the link stops once …`, `… lost its lease after the stop …`, 다시 열린 스레드는 `… after the thread opened new work stops nothing there …`, 판정 버퍼는 `an unmentioned stop word retried after its link closed is held for no judgment …`, 비공개 전환은 `… in a channel turned private sends its binding to approval …`, 닫힌 스레드의 새 멈춤 낱말은 `a new stop word mentioned in a thread whose task the stop closed …`).

### 작업 닫기(PR 사건, 요청자의 완료·취소)가 일으키는 전이

작업 세션(`task_closing` 있음)을 닫는 두 길이다. 둘 다 사람의 close와 같은 `closeAtomic`으로 닫고, 같은 트랜잭션에서 세션의 `task_closed_reason`을 쓴다(`packages/db/src/sessions/task-close.ts`).

- PR 사건: outcome refresher가 pass를 끝낼 때 한 번에 100개까지 고른다. `task_closing.eventRules`가 켜진 작업이어야 한다. 세션의 `github_pull_request` 성과 가운데 하나라도 `merged`면 `completed`로 닫는다. `merged`가 없고 `closed`가 있으면서 `open`이 없을 때만 `cancelled`로 닫는다. status 이벤트의 actor는 `{kind: system, by: pull_request_event}`이다.
- 요청자의 완료·취소: 작업 진행 메시지의 [완료]·[취소] 버튼이다. 누른 사람이 그 세션의 `session.control` 권한을 가져야 한다. 권한은 세션의 진행 메시지가 있는 스레드(revoke되지 않은 primary link)의 채널 ceiling으로 보며, 누른 채널의 ceiling을 쓰지 않는다. 권한이 없으면 누른 사람에게만 ephemeral 안내가 간다.
  - 버튼 값의 세션·link가 누른 메시지의 스레드와 맞지 않으면(다른 세션, 다른 link, 다른 채널·스레드, link가 없는 세션) 아무것도 닫지 않는다. 권한 판단 기록에 `surface_mismatch` 거절을 남기고, 누른 사람에게만 ephemeral 안내가 간다.

| 지금 상태 | 다음 상태 | 조건 | 누가 일으키나 |
| --- | --- | --- | --- |
| `active` (살아 있는 worker가 drain함) | `closing` 뒤 `closed` (status `stopped`) | 위 조건을 채운 작업 세션. `closed`는 실행이 사라진 것이 보일 때 된다(`confirmExecutionGone`). `task_closed_reason`은 그때 쓴다. `closing` 동안은 close의 idempotency 행(`payload_hash` `task_close:<사유>`)만 사유를 든다 | PR 사건(system), 세션을 제어할 수 있는 요청자 |
| `active` (drain할 worker 없음), `paused`, 이어 갈 수 있는 `stopped` | `closed` (status `stopped`) | 같음. `active`는 checkpoint가 마지막으로 돈 턴을 덮을 때만 닫힌다(`pauseBlocker`) | 같음 |
| `closing`, `closed` | 그대로 | 요청자에게는 `already_closed`로 답한다. 처음 닫은 사유가 남는다 | 같음 |
| `closing` | `recovery_required`, `stopping`·`stopped`, `active` | drain이 실패했거나(결과를 모르는 턴, checkpoint 없음) terminate가 앞질렀다. 세션에는 사유가 남지 않아 열린 일로 돌아가고, PR 사건이나 요청자가 다시 닫을 수 있다 | worker·reconciler, terminate |
| `recovery_required`, 이어 갈 수 없는 `stopped`, checkpoint가 덮지 못한 `active` | 그대로 | `closeAtomic`이 거절한다. 요청자는 실패 안내를 받는다. PR 사건은 다음 pass에 다시 시도한다 | 같음 |

막을 전이:

- 작업이 아닌 세션(`task_closing` 없음)은 어느 길로도 작업으로 닫히지 않는다(요청자에게 `not_task`).
- `eventRules`가 꺼진 작업은 PR 사건으로 닫히지 않는다.
- `merged` PR 없이 `closed` PR과 `open` PR이 함께 있는 작업은 닫히지 않는다. 열린 PR이 `merged`가 되면 `completed`로 닫힌다.
- 권한이 없는 사람이 누른 버튼은 세션을 바꾸지 않는다.

지켜야 할 성질:

- 작업의 스레드 링크는 다음 outbox pass의 `closeFinishedLinks`가 `task_closed_reason`으로 닫는다. 진행 메시지가 있는 링크는 닫힘 갱신 행(취소면 '작업을 취소했어요')이 생긴 뒤에 닫힌다. 같은 pass에서 진행 갱신을 넣은 뒤 링크를 닫기 전에 세션이 닫혀도 같다.
- 닫힌 작업의 진행 메시지에는 버튼이 없다.
- PR 사건의 사유는 닫기 트랜잭션이 세션을 잠근 뒤 그 세션의 PR 성과를 다시 읽어 정한다. pass가 후보를 고른 뒤, 닫기가 세션을 잠그기 전에 커밋된 PR 저장·refresh(새로 열린 PR, merge, 다시 열림)는 그 닫기에 보인다. PR 저장은 세션을 먼저 잠그므로 닫기가 먼저 잠갔으면 닫기 뒤에 저장된다. 성과 행은 잠그지 않는다: refresh는 성과 행을 잡은 채 세션을 기다리므로(`queueAchievementJudgment`), 잠그면 서로 기다린다.
- drain하는 닫기의 사유는 닫기를 받을 때 정한 값이다. 미병합 PR로 `cancelled`를 받은 뒤 실행이 사라지기 전에 PR이 다시 열려도 `closed`에는 `cancelled`가 남는다.
- PR 사건 pass는 replica마다 지난 pass가 멈춘 세션 id 뒤에서 이어 고른다. `closeAtomic`이 계속 거절하는 작업이 한 번에 고르는 수(100)보다 많아도 그 뒤 작업이 밀리지 않는다.
- 요청자가 닫은 작업의 스레드에 온 멘션은 대화 turn이 된다(`spawn_task`면 새 작업과 새 링크, `reply`면 답만). rollout `on`에서 작업이 `closing`이거나 링크가 아직 열려 있으면 링크가 닫힐 때까지 기다린다(아래 "닫히는 작업 스레드의 멘션").

시험: `apps/control-host/src/slack/outbox.integration.test.ts`의 `a task's close on …` 묶음과 `a work closed between a pass's progress and its link close keeps its link open for the closed update`, `apps/control-host/src/slack/session-handler.integration.test.ts`의 `a mention in the thread of a task its requester closed is a conversation turn, and its %s takes effect`, `packages/adapters/chat/slack/src/slack-interactions.test.ts`의 `the close buttons on a task's progress message` 묶음, `packages/platform/src/sessions/task-close.test.ts`, `packages/platform/src/sessions/outcome-refresher.test.ts`, `packages/db/src/sessions/task-close.test.ts`, `packages/db/src/close-control.integration.test.ts`의 `a task close that drains names its reason only once the session is closed; one lost to recovery leaves none`, `a pull request close that drains stores the reason judged under its lock and names it once closed`, `a pull request close does not wait on a refresh holding the pull request's row`.

#### 닫히는 작업 스레드의 멘션

rollout `on`에서 스레드에 묶인 작업이 결정 35대로 닫힌 작업(`closing`·`closed`)인데 그 링크가 아직 열려 있을 때 온 멘션이다. 두 틈이 있다. (가) 세션은 `closed`인데 `closeFinishedLinks`가 아직 링크를 닫지 않았다. (나) 세션이 `closing`이고 worker가 drain하고 있다. 링크가 열린 동안은 같은 스레드에 새 링크를 열 수 없으므로(`session_links_open_surface_ref_uniq`, `spawn_task`의 `thread_taken`), 멘션은 링크가 닫히기를 기다린다. 판정은 receive path(`slack-session-handler.ts`의 `waitOutClosedWork`)가 하고, 닫혔는지는 `sessionWorkClosed`와 같은 기준(`closedWork`)으로 본다. 일으키는 쪽은 멘션한 사람이다.

| 지금 상태 | 입력·조건 | 다음 상태 | 남는 것 |
| --- | --- | --- | --- |
| 작업 `closing`, 링크 열림 | 사람의 멘션(DM 아님, 링크를 연 글 아님) | 기다림: inbox가 이벤트를 `SLACK_CLOSED_WORK_MENTION_RECHECK_MS`(5초) 뒤 다시 보도록 미룬다(`SlackInboundDeferred`, 시도를 쓰지 않음, 상한 없음) | 그 닫기마다 스레드에 `taskClosingWait` 한 줄. 키는 닫기 receipt(없으면 세션) |
| 작업 `closed`, 링크 열림(틈 가) | 같음 | 기다림(같음) | 새 줄 없음 |
| 기다림 | 링크가 닫힘 | 위 처리표의 길(묶인 작업이 없는 스레드의 멘션): 대화 턴(`m2`). `spawn_task`면 새 세션과 새 링크, `reply`면 답만 | 턴 1개 |
| 기다림 | close가 실패해 작업이 `active`로 돌아감 | 그 세션의 다음 턴 | 세션 턴 1개 |
| 기다림 | rollout을 `shadow`·`off`로 내림 | 지금 길(세션). `closing`·`closed` 세션은 append를 거절한다 | 이 PR 전과 같음 |
| 작업 `closing`·`closed`, 링크 열림 | 봇이 쓴 멘션 | 기다림 | 줄 없음 |
| 작업 `idle`·`stopped`·`paused`(열린 작업) | 멘션 | 지금 길(세션 턴 또는 세션의 거절) | 이 PR 전과 같음 |

막을 전이(시험은 따로 적지 않으면 `apps/control-host/src/slack/session-handler.integration.test.ts`의 "Slack mentions as conversation turns"):

- 닫히는 작업 스레드의 멘션이 턴 없이 끝나거나 일반 실패 문구(`failed`)를 다는 것("a mention while its task drains waits past a 31-minute drain, told once, then opens the work again in a new session", "a mention after its task closed, before its link did ...: it waits for the link, unsaid, then is the thread's conversation turn").
- 한 닫기에 `taskClosingWait`를 두 번 다는 것. 다시 보는 동안 세션 revision이 checkpoint로 바뀌고 status 이벤트가 admission을 다시 쓰므로, 키는 닫기 receipt다("two mentions in one closing: one line in the thread").
- 기다리는 멘션이 inbox의 시도 상한이나 버퍼 시간(10분)에 버려지는 것(31분 drain 시험).
- close가 실패해 열린 작업에 온 멘션이 새 세션을 여는 것("a close that fails back to open work: the waiting mention is that work's next turn").
- `shadow`·`off`에서 기다리는 것("rollout %s: a mention while its task closes goes the current way, no wait").
- 열린 작업(`active`·`stopped`·`paused`)의 멘션이 기다리는 것("Slack replies in a work's thread once the rollout is on"의 멘션 시험).

알려진 한계:

- 링크가 끝내 닫히지 않으면(닫힌 세션의 보고가 끝나지 않음) 멘션은 계속 기다리고, 같은 스레드의 뒤 이벤트도 그 뒤에 선다. 미룸에는 상한이 없다.
- 닫기 receipt는 누가 닫든 세션 owner의 칸에 쓰인다(`closeAtomic`은 다른 owner에게 `not_found`). 그래서 owner index로 찾고, 찾지 못할 때(receipt 없이 `closing`인 예전 행)만 세션 키로 한 줄을 단다. 그 세션이 다시 열렸다 닫혀도 두 번째 줄은 없다.
- append가 `SESSION_CLOSING`·`SESSION_CLOSED`로 거절했는데 다시 읽은 작업이 열려 있으면(그 사이 close가 `active`로 돌아감) `failed`를 달지 않고 같은 간격으로 다시 본다. 다음 봄이 그 세션에 넣는다.
- 기다린 멘션이 C1 `reply`로 답한 뒤, 같은 스레드에 다른 멘션이 새 작업을 열고 나서야 같은 글의 다른 이벤트(`message`와 `app_mention`)가 처리되면 새 세션이 그 글을 한 번 더 받을 수 있다. 링크가 닫힌 스레드의 C1 멘션에 이 PR 전부터 있던 길이다.
- DM은 이 길을 타지 않는다.
- `closedWork`를 읽은 뒤 미루기 전에 close가 `active`로 돌아가면, 다음 봄(5초 뒤)에 세션 턴이 된다. 그 사이 늦어질 뿐 턴을 잃지 않는다. 읽기와 미룸 사이의 close 되돌림 경쟁은 이 PR 밖이다.

### terminate가 일으키는 전이

terminate는 사람이 세션을 강제로 끝내는 제어다(`POST /v1/sessions/{id}/terminate`, 관리자 terminate, 웹의 '세션 종료'). 판정은 `packages/db/src/control-unit-of-work.ts`의 `terminateAtomic`이 한다.

| 지금 상태 | 다음 상태 | 조건 | 누가 일으키나 |
| --- | --- | --- | --- |
| `recovery_required` (status `failed` 또는 `stopped`) | `closed` (status `stopped`) | `expected_revision`이 맞고, `expected_admission_state`를 보냈다면 `recovery_required`이고, 레거시 pod 바인딩(execution 없이 pod만)이 아니다. 묶인 execution이 없으면 receipt가 응답에서 `succeeded`다. 묶여 있으면 kill intent를 쓰고 receipt는 `accepted`로 남는다 | 세션을 제어할 수 있는 사람의 terminate |
| `active`, `pausing`, `paused`, `resuming`, `closing`, `stopping` | `stopping` 뒤 `stopped` (실행이 끊은 turn이 `outcome_unknown`이면 `recovery_required`) | 묶인 execution이 있을 때. 없으면 바로 `stopped` | 같음 |
| `stopped` | 그대로 | 묶인 execution이 없으면 admission·status·revision·lease epoch를 바꾸지 않는다 | 같음 |
| `closed`가 아닌 어느 상태든 | 그대로 | 앞선 검사(아래 순서)를 통과한 새 요청의 `expected_admission_state`가 지금 admission과 다르면 409 `REVISION_CONFLICT`(메시지에 지금 admission). 검사 순서: 이미 쓴 Idempotency-Key(본문이 같으면 receipt를 지금 상태로 replay, 다르면 `IDEMPOTENCY_CONFLICT`) → `closed`면 `SESSION_CLOSED` → `expected_revision` → `expected_admission_state`. 둘 다 다르면 메시지는 revision을 말한다. `recovery_required`로 가는 전이가 모두 revision을 올리지는 않으므로, 웹은 확인 창을 연 때의 admission을 이 값으로 보낸다(창이 열린 뒤 세션이 바뀌어도 창의 문구와 보내는 값은 그대로이고, 화면이 다른 세션으로 넘어가면 창은 닫힌다) | 같음 |
| `closed` | 그대로 | 409 `SESSION_CLOSED`로 거절한다 | 같음 |

`recovery_required` → `closed`는 복구 결정 `close`와 같은 방식으로 닫는다(`closeSessionRow`). 대기 입력은 `SESSION_CLOSED`로 취소되고, 디스패치 대기열에서 빠지고, lease epoch가 올라 claim한 worker를 막는다. 스트림에는 `closed_by: terminate`인 status 이벤트와 `session_closed` 이벤트가 남는다. 작업 세션의 Slack 링크는 recovery close처럼 `abandoned`로 닫힌다(close receipt가 없으므로). 링크는 Slack 후처리가 닫으므로, 아직 보고되지 않은 turn이 있으면 그 뒤에 닫힌다.

막을 전이:

- `recovery_required`가 아닌 세션은 terminate로 `closed`가 되지 않는다.
- `closed` 세션은 terminate로 다른 상태가 되지 않는다.
- 다른 admission을 보고 결정한 terminate(`expected_admission_state`가 다름)는 세션을 바꾸지 않는다.

지켜야 할 성질:

- terminate로 닫혀도 결과를 알 수 없는 turn에 답하지 않는다. 그 turn은 `outcome_unknown`으로 남고, receipt의 `unconfirmed_turn_id`가 가장 이른 그런 turn을 가리킨다(없으면 `null`, 예: 복원 실패로 `recovery_required`가 된 세션).
- 닫은 뒤 실행이 사라진 것을 보아도 세션은 다시 열리지 않는다. 그 관측은 바인딩과 worker 칸을 풀고 lease epoch를 한 번 더 올리고 terminate receipt를 `succeeded`로 정산한다. admission·status는 `closed`/`stopped` 그대로이고 close 이벤트를 다시 쓰지 않는다.
- 닫는 트랜잭션에서 lease epoch가 오르므로, 아직 살아 있는 worker의 heartbeat는 실행 종료가 관측되기 전에도 409 `STALE_EPOCH`다.
- 같은 terminate를 같은 키로 다시 보내면 처음 receipt를 돌려준다. 새 키의 terminate는 `closed`로 거절되고 세션의 revision은 그대로다.
- 웹 세션 상세는 `closed` 세션에 제어 버튼도 복구 결정도 그리지 않는다(`actionsFor`, `RecoveryDecisions`).

시험: `packages/db/src/terminate-recovery.test.ts`, `packages/db/src/control-unit-of-work.integration.test.ts`의 terminate 시험, `apps/web/src/routes/sessions.test.tsx`의 복구 화면 terminate 시험.

### Slack 멘션이 대화 계층에 들어가는 길

에이전트의 `conversation_rollout`이 `on`일 때 묶인 작업이 없는 스레드의 멘션을 처리표가 다룬다. 처리표는 생애주기 정지를 먼저 본다(보관, 강퇴, 승인 대기, 에이전트 비활성, 소유자 없음). 일으키는 쪽은 언제나 Slack에서 멘션한 사람이고, 판정은 receive path(`slack-session-handler.ts`)가 한다.

| 지금 상태 | 입력·조건 | 다음 상태 | 남는 것 |
| --- | --- | --- | --- |
| 에이전트 활성, 소유자 있음 또는 유예(14일) 안, 채널 사용 중, 듣기 `mention`·`free` | 멘션 | 대화 턴 후보(`m2`). 인가·입력 검사를 지나면 턴 | 턴 1개 |
| 위와 같고 듣기 `off` | 멘션 | 버림(`drop_with_off_notice`) | 스레드에 `channelOff` 한 줄 |
| 에이전트 `paused`, 채널 사용 중 | 멘션 | 정지(`lifecycle_stopped`, `agent_inactive`) | 스레드에 `agentInactive` 한 줄 |
| 소유자 없음이 유예를 넘김, 채널 사용 중 | 멘션 | 정지(`lifecycle_stopped`, `agent_ownerless`) | 스레드에 `agentOwnerless` 한 줄 |
| 채널 승인 대기(바인딩 `mode` `on`, 채널 사용 중), 에이전트 활성(소유자 없음은 유예 안) | 묶인 스레드 밖 사람의 멘션 | 정지(`lifecycle_stopped`, `pending_approval`) | 멘션한 사람에게만 `pendingApproval` 한 줄 |
| 채널 보관·강퇴, 또는 승인 대기와 에이전트 정지가 겹침, 또는 Slack이 이제 비공개라고 알리는 공개 채널 | 멘션 | 정지(`lifecycle_stopped`) 또는 승인 대기 | 없음(비공개로 바뀐 채널은 멘션한 사람에게만 `pendingApproval`) |
| 채널에 쓰이는 바인딩 없음(비공개 채널 승인 거절 뒤, 봇 입장 이벤트를 받지 못함), 봇은 채널에 있음 | 멘션 | 받지 않음(`no_binding`) | 멘션한 사람에게만 `channelUnbound` 한 줄 |
| 에이전트 `archived` | 멘션 | 처리표 앞에서 버림(보관이 바인딩과 identity를 취소한다) | 없음 |
| 에이전트 정지 또는 소유자 없음이 유예를 넘김 | 멘션 없는 글 | 정지 | 판단 버퍼에 담지 않음 |
| 소유자 없음이 유예를 넘김, 열린 작업에 묶인 스레드 | 요청자의 중단 말 | 작업 중단(`stop_session`) | 중단 안내 |
| DM, 에이전트 정지 | DM | 정지 | 없음 |
| rollout `off`·`shadow` | 멘션 | 지금 길(세션). 멘션은 처리표를 묻지 않는다 | 안내 없음 |
| rollout `off`·`shadow`, 채널에 바인딩 없음 | 묶인 스레드 밖 사람의 멘션 | 인가 판정 앞에서 버림 | 멘션한 사람에게만 `channelUnbound` 한 줄 |

지켜야 할 성질:

- 안내 한 줄은 턴, 모델 호출, 예산 예약을 만들지 않는다.
- 안내는 사람·채널·UTC 날짜마다 한 번이다. 같은 날 다른 스레드에서 다시 불러도 다시 달지 않고, 다른 사람에게는 따로 단다. 하루 한 번은 outbox dedupe 키로 지킨다.
- 소유자 없음 판정은 세션 생성의 `agent_ownerless` 거절과 같은 함수(`ownerlessPastGrace`)를 쓴다. 두 곳의 기준이 갈라지지 않는다.
- 소유자 없음은 이미 도는 작업을 멈추지 않으므로, 요청자의 중단 말은 막지 않는다.
- 채널 쪽 정지(보관·강퇴·승인 대기)가 있는 곳에는 에이전트 정지 안내를 쓰지 않는다. 채널 종류 검사(공개 채널이 비공개가 됨)를 지난 뒤에만 쓴다.
- 다른 조직 사람(인가와 같은 `slackUserKindOf` 기준: `is_stranger`·`is_external`·다른 team)의 멘션에는 스레드 안내를 쓰지 않는다. 채널 종류 검사가 내는 요청자용 안내는 그대로다.
- 에이전트 정지 안내는 처리표가 `lifecycle_stopped`라고 답할 때만 고른다. 바인딩 `mode`가 `off`(`not_received`)이면 아무것도 하지 않는다.
- 채널 승인보다 먼저 쓴 멘션에는 안내를 쓰지 않는다(입력 길과 같은 `approvedAt` 기준).
- 안내는 다시 읽은 바인딩이 여전히 쓰이고(`mode` `on`) Slack이 채널 종류를 확인했을 때만 쓴다.
- 공유 채널에서는 내부 사람이 일으킨 안내를 다른 조직 사람도 같은 스레드에서 본다.
- 판정은 inbox가 이벤트를 처리할 때의 상태로 한다. 안내를 큐에 넣은 뒤 에이전트가 다시 켜지거나 바인딩이 바뀌어도 그 안내는 취소하지 않는다.
- dedupe 키는 설치·채널·사람·문구·이벤트의 UTC 날짜다. 한 판정에 듣기 `off`와 에이전트 정지가 겹치면 정지 안내가 이긴다. 같은 날 다른 판정에서 다른 문구가 나오면 문구마다 한 번씩 나간다.
- 바인딩 없는 채널과 승인 대기 채널의 안내는 멘션한 사람에게만 보이는 ephemeral이다(outbox kind `notice`). 인가 판정을 만들지 않는다. 다른 조직 사람에게는 쓰지 않는다. 문구는 채널이나 에이전트 이름을 넣지 않는다. 바인딩 없는 채널의 안내에는 그 사람이 이 워크스페이스의 활성 사용자에 연결돼 있을 때만 콘솔의 에이전트 목록 링크를 단다. rollout `on`에서 Slack이 공개 채널을 이제 비공개라고 알려 승인 대기로 바뀔 때의 `pendingApproval`도 같은 하루 한 번 키를 쓰고, 다른 조직 사람에게는 쓰지 않는다. rollout `off`·`shadow`의 승인 대기 채널과 묶인 스레드의 안내는 지금처럼 인가 판정이 스레드 키로 단다(하루 한 번이 아니라 스레드마다 한 번). rollout `on`에서 처리표가 에이전트 정지를 본 채널이 비공개로 바뀌면 승인 대기로만 바꾸고 아무것도 달지 않는다. 그래서 같은 사람이 같은 날 그 채널에서 다시 멘션해도 승인 대기 안내는 한 번이다. 앞의 다른 성질(승인 시각, 다시 읽은 바인딩, 채널 종류 확인, 공유 채널에서 함께 봄)은 스레드 공개 줄의 것이다.
- 웹에서 `mode` `off`로 끈 바인딩은 이 안내를 받지 않는다. rollout `on`에서는 조용하고, `off`·`shadow`에서는 지금처럼 인가 판정의 거절 안내가 나간다.
- 소유자 없음이 되기 전에 버퍼에 담긴 글은 지우지 않는다. 버퍼의 수명(10분)이 지나면 사라진다. 비활성은 버퍼의 정리 길이 따로 지운다.

## 2. turn·attempt

turn은 `queued → running → completed | failed | interrupted | outcome_unknown | cancelled`로 간다. attempt는 worker 하나가 세션을 쥔 기간이다. checkpoint pointer는 세션이 복원할 수 있는 마지막 revision을 가리키고, 그 revision의 행은 자기가 덮는 turn을 이름으로 가진다.

### 용어

- **pending 사유**: turn이 checkpoint 없이 끝난 까닭. 세션에 적힌다.
  - advisory: `background_writer`, `tool_in_flight`, `checkpoint_lease_held`, `publish_failed`. 세션은 계속 일한다.
  - blocking(`mirror_error`), exhausted(`transcript_too_large`, `transcript_part_too_large`): 새 turn을 받지 않는다.
- **`publish_failed`의 두 갈래**: worker는 둘을 구분한다. 세션에 적히는 사유는 같다.
  - 인프라 실패: checkpoint 요청, 업로드, commit이 오류나 503으로 끝났다. worker 로그의 `category`가 `error`다. 잠시 뒤 같은 캡처가 통과할 수 있다.
  - 결정적 거절: 캡처가 스스로 거절했다(작업 공간이 한도를 넘음 등). 로그의 `category`가 `refused`다. 다음 turn이 작업 공간을 고쳐야 통과한다.
- **turn 밖 commit**: 이미 끝난 turn에 checkpoint를 붙이는 commit. turn은 끝난 상태 그대로 두고 pointer만 올린다. worker가 `POST /internal/worker/checkpoint-commit`으로 보낸다.
- **capture_kind**: manifest의 `captureKind`. turn 끝 캡처는 적지 않는다. turn 밖 캡처는 `between_turns`(turn 사이)나 `before_idle_exit`(idle 종료 직전)를 적는다. 판정 키에는 들어가지 않는다.
- **run이 조용하다**: engine이 추적하는 도구와 배경 작업이 없고, engine이 스스로 내던 답이 끝났고, engine 아래에 남은 프로세스가 없다. 배경 작업이 끝나면 engine은 그 알림을 받아 입력 없이 한 번 더 답한다. 알림을 받은 때부터 그 답의 result까지는 조용하지 않다. 그 사이에 찍은 transcript에는 알림만 있고 답이 없어서, 거기서 복원한 engine이 같은 알림에 다시 답한다. transcript에 넣지 않는 알림(ambient 작업)은 답을 열지 않는다. 작업이 목록에서 빠지는 것과 알림의 순서는 정해져 있지 않으므로, 캡처하는 동안 그 답이 시작됐으면, 답이 그 안에 끝났더라도 그 캡처는 버리고 답이 끝난 뒤 다시 찍는다. idle 종료 직전의 캡처가 그렇게 버려지면 한 번 더 찍는다. run에 조용한지 묻는 호출에도 캡처와 같은 단계 예산이 걸려 있다.

### 전이 표

| # | 지금 상태 | 다음 상태 | 조건 | 누가 |
| --- | --- | --- | --- | --- |
| T1 | turn running | turn completed, pointer 그대로, pending = advisory 사유 | finalize에 checkpoint가 없고 사유가 advisory다 | worker (finalize) |
| T2 | turn completed, pending advisory | pointer rev N+1(turn = 그 attempt가 마지막으로 끝낸 turn), pending 없음. turn은 completed 그대로 | 같은 attempt, 같은 lease epoch, lease가 살아 있음, 그 attempt에 열린 turn이 없음, 뒤에 시작한 turn이 없음, run이 조용함 | worker의 재시도 → gateway의 turn 밖 commit |
| T3 | 열린 turn 없음, 그 attempt의 이벤트 도착 | 이벤트가 그 attempt가 마지막으로 끝낸 turn에 붙고 `after_turn`으로 표시됨 | 같은 attempt, 같은 epoch, 그 attempt가 끝낸 turn이 있음. 어느 turn인지는 이벤트가 도착한 때로 정한다 | gateway (append-events) |
| T4 | 열린 turn 없음, 그 attempt의 provider 호출 | 호출이 그 attempt가 마지막으로 끝낸 turn의 예산 root로 잡힘 | 같은 attempt, 그 attempt가 끝낸 turn이 있음 | egress 판정 (예산 선택) |
| T5 | attempt running(idle), 빚진 checkpoint 있음, 배경 작업 없음 | 캡처(`before_idle_exit`) → turn 밖 commit → attempt exited. 캡처나 commit이 안 되면 그대로 exited | idle timeout | worker |
| T6 | attempt running(idle), 빚진 checkpoint 있음, 배경 작업 있음 | 유예 → 유예 안에 끝나면 캡처 → exited. 유예가 지나면 배경 작업 멈춤 → 알림 이벤트 → run이 조용해지기를 기다림 → 캡처 → exited | idle timeout | worker |
| T7 | turn completed, pending = `publish_failed`(인프라 실패), 새 입력 도착 | 새 turn은 queued로 남음 | 재시도가 성공하거나 보류 상한이 찰 때까지 | worker (next-input을 묻지 않음) |
| T8 | T7의 보류가 상한에 닿음 | 새 turn 시작. pending = `publish_failed`는 남음 | 첫 실패부터 `retryHoldMs`가 지남 | worker |
| T9 | turn completed, pending = `publish_failed`(결정적 거절) 또는 `background_writer`, 새 입력 도착 | 새 turn 시작. 그 turn의 finalize가 checkpoint를 commit하면 pending 없음 | 사유가 advisory다 | worker |
| T10 | attempt exited, 덮이지 않은 turn 있음 | 세션 recovery_required | 1번 절의 조건 | scheduler |
| T11 | turn running | turn failed(`emergency_stopped`). 대기 중인 입력은 cancelled. 실행이 있으면 lease epoch가 올라감 | 관리자가 그 세션이 일하는 Slack 채널에서 에이전트를 긴급 정지함 | 긴급 정지 트랜잭션 |
| T12 | 앞의 turn(cancelled 제외)이 failed(`emergency_stopped`), 새 입력으로 만든 turn의 첫 전달([이어서 하기] 제외) | 새 turn 시작. 끊긴 입력은 앞에 붙이지 않고 `prepend_skip_reason` = `emergency_stopped` | 정지를 풀고, 세션이 일시 정지됐으면 재개한 뒤 | worker의 next-input |
| T13 | attempt draining(요청된 drain: SIGTERM·SIGINT), 열린 turn 없음, 빚진 checkpoint 있음 | 배경 작업이 있으면 유예 없이 바로 멈춤 → 알림 이벤트 → run이 조용해지기를 기다림 → 캡처(`before_idle_exit`) → turn 밖 commit → release(`stop_kind: drain`) → exited. 캡처나 commit이 안 되거나 drain 예산이 다하면 그대로 exited | worker가 종료 신호를 받음(배포, 노드 정리, 컨테이너 재시작). T6의 유예 중이든 아니든 같다 | worker |
| T14 | turn이 끝났고 그 turn의 Slack 본 글(답 `reply:` 또는 실패 안내 `failure:`)이 보내기를 마침(`pending`·`sending`이 아님), T3으로 그 turn에 `after_turn` `result`가 붙음 | 그 스레드에 후속 글 행 하나(kind `reply`, 키 `after_turn:<link>:<turn>:<result 순번>`). 웹 대화는 같은 `after_turn` assistant 이벤트를 답 말풍선으로 그린다 | 링크가 revoke·mute 아님(열려 있거나, 닫힌 지 하루 안이고 답이 닫히기 전에 저장됨. 하루는 후속 글 행을 넣는 기한이고, 넣은 행은 그 뒤에도 보낸다), `report_mode`가 `none`이 아님, 설치가 revoke되지 않음, turn이 링크보다 뒤, 답 텍스트가 있음 | Slack outbox drain (`enqueueSlackAfterTurnReplies`) |
| T15 | turn running | turn failed(`worker_ownership_lost`), `outcome_unknown` 아님. 입력 receipt는 `WORKER_OWNERSHIP_LOST`로 failed. checkpoint와 pointer는 그대로. admission이 `active`이고 그 앞에 덮이지 않은 turn이 없으면 세션 admission은 그대로이고 status는 기다리는 입력이 있으면 `queued`, 없으면 `idle`. 그 앞에 덮이지 않은 turn이 있으면 T10이 함께 일어난다 | worker가 lease를 스스로 내려놓고 끝났다는 기록(exit 75)이 있고, 그 실행의 attempt가 가진 lease가 DB 시계로 모두 끝났다. 승인 대기 checkpoint가 온전한 turn은 park가 먼저다 | scheduler (실행 종료 확인) |
| T16 | turn running | turn failed(`tool_call_limit`), `outcome_unknown` 아님. 입력 receipt는 `INTERNAL_ERROR`(message `tool_call_limit`)로 failed. 세션 admission과 checkpoint 규칙은 다른 failed turn과 같고, 세션은 다음 입력을 받는다. Slack 스레드에는 실패 안내 대신 `SLACK_NOTICE_MESSAGES.*.toolCallLimit` 한 줄 | 그 turn의 `tool.called`가 서로 다른 id로 `WORKER_MAX_TURN_TOOL_CALLS`(기본 500, 1–100000)를 넘음. 하위 agent의 호출도 센다. worker가 interrupt를 보내고 engine이 interrupt 유예 안에 끝낸다. 유예 안에 끝내지 않으면 workspace quota와 같이 `outcome_unknown`(`tool_call_limit_interrupt_unanswered`) | worker (`countToolCall` → `cutAtLimit`) |

빚진 checkpoint는 worker가 기억하는 값이다. 마지막으로 끝낸 turn이 checkpoint 없이 끝났거나, 마지막 캡처 뒤에 engine이 스스로 답을 냈으면 빚이 있다.

- T5, T6, T13은 빚이 있을 때만 일어난다. 빚이 없으면 idle 종료와 drain은 캡처 없이 끝난다.
- T5와 T6의 캡처가 거절되거나 실패하면 worker는 새 checkpoint 없이 끝난다. 덮이지 않은 turn이 있으면 T10으로 간다. T6에서 멈춘 뒤 run이 `settleWaitMs` 안에 조용해지지 않은 경우도 같다(engine이 알림에 답하다가 새 작업을 시작한 경우 등).
- T6에서 멈추는 것은 그 run의 자손 프로세스다. worker 컨테이너에는 그 run의 프로세스만 있고, checkpoint를 `background_writer`로 거절하게 하는 프로세스 목록과 같은 목록을 쓴다. 신호를 보내기 직전에 목록을 다시 읽는다. SIGTERM을 보내고, 남으면 SIGKILL을 보낸다. lease를 잃었거나 다른 이유로 멈추는 중이면 신호를 보내지 않는다. T13(종료 신호)에서는 보낸다.
- 멈춘 프로세스의 명령 이름(커널의 `comm`, 15자 이하)만 `system` 이벤트(`background_tasks_stopped`)에 적는다. 인자와 환경 값은 적지 않는다. 이름은 영문자, 숫자, `.`, `_`, `+`, `-`만 남기고, 읽는 쪽(웹, engine 입력)도 그 모양인 이름만 최대 16개 쓴다.
- 그 이벤트는 세션 상세에 한 줄로 보이고, 다음 turn의 engine 입력 맨 앞에도 한 줄로 붙는다. 알림은 앞선 turn 가운데 끊기지도 `cancelled`도 아닌 마지막 turn의 것을 본다. 그래서 알림을 받은 turn이 끊기거나 버려지면 그 뒤의 turn에도 다시 붙는다(`keeps the line past a cut-off turn, …`, `keeps the line past a delivered turn an operator abandoned`).
- T7의 재시도가 성공하면 T2가 일어나고 queued였던 turn이 바로 시작한다.
- T7의 보류는 turn 하나의 빚에 한 번이고, 첫 실패부터 센다. 보류를 벗어난 뒤 다시 인프라 실패가 나도 시간을 새로 세지 않는다. 상한에 닿거나 넘는 재시도는 하지 않고, 상한에서 보류를 끝낸다. 그때 진행 중이던 캡처와 commit은 끝까지 가므로 다음 입력은 그만큼 더 기다릴 수 있다. 캡처가 끝나지 않으면 turn 끝 캡처와 같은 단계 예산(worker 시작 timeout)에서 worker가 실패로 끝난다.
- T8 뒤의 빚은 pause 직전과 idle 종료 직전에 한 번씩 다시 시도한다. 그래도 덮지 못하면 T10으로 간다.
- T13의 모든 대기는 drain 예산(`WORKER_DRAIN_TIMEOUT_SEC`, 기본 100초)이 끝나면 멈춘다. drain 예산은 설정에서 launcher의 종료 유예(`WORKER_STOP_GRACE_SEC`)보다 12초 짧게 잘리고, 그 12초가 engine 종료와 release의 몫이다. 프로세스 목록 읽기, 조용한지 묻기, 캡처, commit과 그 거절 보고는 모두 drain 예산과 경주한다. idle 종료가 배경 작업을 보는 목록 읽기도 같다. 예산이 다하면 보낸 commit의 답을 기다리지 않고 shutdown으로 간다(그 commit이 DB fence를 release보다 먼저 얻으면 들어가고, 아니면 막힌다). 예산 안에 답하지 않은 목록 읽기는 "프로세스 없음"이 아니라 "모름"이다. 그래서 run이 조용하다고 보지 않고 캡처를 시작하지 않는다. 조용해지기를 기다리는 시간은 기다림을 시작할 때마다 `settleWaitMs`와 그때 남은 drain 예산의 절반 가운데 작은 값으로 정하고, 그 안의 질문 하나하나도 그 시간에서 끊는다. 멈추기의 목록 읽기(신호 전과 신호를 기다리는 동안)는 하나하나 신호 하나를 기다리는 시간(`stopSignalWaitMs`)에서 끊는다. SIGKILL 전의 목록 읽기가 끊기면 무엇이 남았는지 모르므로 SIGKILL을 보내지 않는다. 남은 프로세스는 worker 컨테이너가 정리될 때 끝난다(worker는 자손이 모두 끝났는지 확인하지 않고 release한다). T13은 캡처를 한 번 시도한다(T7의 보류를 하지 않는다. 캡처 중에 engine 답이 끼어들면 그 답 뒤에 한 번 더 찍는다). 실패하면 T10으로 간다.
- 멈춤 알림(`background_tasks_stopped`)은 attempt 하나에 한 번이고, 멈추기를 끝까지 한 쪽이 낸다. idle 종료가 배경 작업을 멈추는 중에 종료 신호(또는 lease 잃음·실패)가 오면, idle 종료는 기다림을 바로 그만두고 다음 신호도 알림도 보내지 않는다. 종료 신호였으면 T13이 남은 프로세스를 다시 읽어 멈추고 알림을 낸다. drain 예산이 다해 T13의 멈추기가 끊긴 경우에도 알림은 내지 않는다.
- 요청되지 않은 drain(`mirror_error`, 복구 결정이 필요한 turn), lease 잃음, 실패에서는 T13이 일어나지 않는다.
- T10의 판정(context gap, claim gate)은 이 절의 전이가 바꾸지 않는다.
- 끊긴 turn(`worker_ownership_lost`, `emergency_stopped`)은 돈 turn으로 세지 않아 덮이지 않아도 T10을 일으키지 않는다. 그 앞의 turn이 덮이지 않았으면 T10은 그대로 일어난다.
- 긴급 정지는 열린 turn이 없어도 실행을 fence한다. 정지 뒤에는 그 worker의 T2·T3이 일어나지 않고 새 T4 판정도 거절된다. 정지 전에 이미 허가받은 provider 호출은 정지 뒤에 예산에 잡힐 수 있다. 그때 덮이지 않은 turn은 덮이지 않은 채 남고, 지금의 context gap 판정(실행 종료 확인, claim, `stopped`에서의 재개)을 그대로 받는다.
- T11로 끊긴 turn은 사람이 [이어서 하기]를 해야만 다시 돈다.
- T15의 조건은 둘 다 있어야 한다. 기록이 없으면, park되지 않고 열려 있던 turn은 `outcome_unknown`(`execution_gone`)이 되고 세션은 `recovery_required`로 간다(이미 `closed`인 세션은 그대로, R27). 기록은 있는데 lease가 아직 살아 있으면, kill이 요청되지 않은 실행은 아무것도 닫지 않고 lease가 끝난 뒤의 물음이 닫는다(R28).
- T15로 끊긴 turn은 저절로 다시 돌지 않는다. admission이 `active`이고 그 앞에 덮이지 않은 turn이 없으면 세션은 다음 입력을 새 worker에서 받고(P8), 새 입력으로 만든 turn은 끊긴 turn의 입력을 앞에 붙여 받는다. 그 입력의 출처가 지워졌거나 입력을 읽을 수 없으면 붙이지 않고 `prepend_skip_reason`을 적는다. [이어서 하기]로 만든 turn은 끊긴 turn의 입력이 곧 자기 입력이다.

### 값

값은 `apps/worker/src/worker-host.ts`의 `OUTSIDE_TURN_CHECKPOINT` 하나에 모여 있다.

| 이름 | 값 | 뜻 |
| --- | --- | --- |
| `idleBackgroundGraceMs` | 5분 | T6의 유예 |
| `afterIdleGrace` | `stop` | 유예 뒤 동작. `wait`이면 멈추지 않고 배경 작업이 끝날 때까지 종료를 미룬다 |
| `stopSignalWaitMs` | 10초 | SIGTERM에서 SIGKILL까지 |
| `settleWaitMs` | 60초 | 멈춘 뒤 run이 조용해지기를 기다리는 상한. engine이 알림에 답하는 시간이 여기에 든다 |
| `retryBackoffMs` | 1, 2, 4, 8, 15초(마지막 값 반복) | T7 재시도 간격 |
| `retryHoldMs` | 120초 | T7 보류의 총 시간 상한. 첫 실패부터 세고, 이 뒤에는 재시도를 시작하지 않는다 |
| `commitRetryMs` | 30초 | commit 하나가 5xx를 받으며 다시 보내는 상한 |

### 막을 전이

| # | 막을 전이 | 답 | 시험 |
| --- | --- | --- | --- |
| R1 | lease를 잃었거나 epoch가 지난 attempt의 turn 밖 commit | 409 `LEASE_EXPIRED` 또는 `STALE_EPOCH` | `is refused from an attempt whose epoch has passed or whose lease has lapsed` |
| R2 | 그 attempt가 마지막으로 끝낸 turn이 아닌 turn id로 하는 commit | 409 `REQUEST_STALE`(다른 attempt의 turn은 404) | `is refused on a turn that is not the last the attempt finalized`, `is refused on another attempt's turn, and on a turn the session does not have` |
| R3 | 다음 turn이 시작된 뒤 도착한 turn 밖 commit | 409 `REQUEST_STALE`. manifest를 판정하기 전에 거절한다. 판정하는 동안 다음 turn이 시작됐으면, 한도 판정을 적는 transaction이 fence 아래에서 turn을 다시 보고 적지 않는다 | `is refused once a later turn has started: that turn's finalize commits what covers both`, `is refused from the turn alone before its manifest is judged, …`, `packages/platform/src/workers/worker-gateway.test.ts`의 `a checkpoint for a turn that takes none any more is refused before its manifest is judged, …`, `a limit verdict on a checkpoint outside a turn is handed to the store with its turn, …`, `a limit its manifest reached is recorded while the turn still takes a checkpoint, and not once the next turn has started` |
| R4 | blocking 사유(`mirror_error`)를 그 사유를 낸 attempt의 turn 밖 commit이 지우는 것 | commit은 되지만 사유는 남고, pointer는 복원 지점으로 믿지 않는다 | `does not clear the blocking reason of the attempt that raised it, so the pointer stays untrusted` |
| R5 | revision이 pointer의 다음 번호가 아닌 commit | 409 `REVISION_CONFLICT` | `is refused when its revision is not the pointer's next` |
| R6 | 다른 attempt가 끝낸 turn에 이벤트를 `after_turn`으로 붙이는 것 | 이벤트는 어느 turn에도 붙지 않는다 | `are never put on another attempt's turn` |
| R7 | 긴급 정지가 fence한 worker의 turn 밖 commit(끊긴 turn은 `failed`라 상태만으로는 checkpoint를 받는다) | 409 `STALE_EPOCH`, pointer 그대로 | `packages/db/src/emergency-stop.test.ts`의 `the fenced worker puts no checkpoint outside a turn on the turn the stop cut off` |
| R8 | 긴급 정지로 끊긴 turn의 입력이 다음 turn 앞에 저절로 붙는 것 | 붙지 않고 `prepended_turn`과 `prepend_skip_reason`이 적힌다 | `packages/db/src/emergency-stop.test.ts`의 `the next message is not given the stopped turn's input, and the skip is recorded`, `the next message after input the stop cancelled is not given the stopped turn's input either` |
| R9 | 덮인 turn 뒤의 drain이 캡처하는 것 | 캡처하지 않고 끝난다 | `apps/worker/src/worker-host-outside-turn.test.ts`의 `a drain after a covered turn takes no capture` |
| R10 | T13의 캡처나 commit, idle 종료의 목록 읽기가 drain 예산을 넘어 종료를 붙잡는 것. 조용한지 묻는 질문 하나가 캡처 몫까지 쓰는 것 | 예산(질문은 settle 시간)에서 기다림을 그만두고 release한다 | 같은 파일의 `a drain capture that never returns is given up at the drain budget`, `a drain commit the gateway never answers is left at the drain budget, …`, `a process scan that stalls while the idle exit checks the work does not hold a drain past its budget`, `a scan that stalls after SIGTERM is cut at the signal window, …`, `a quiet probe that does not answer is cut at the settle window, …` |
| R11 | 멈춤 알림이 한 attempt에서 두 번 나가는 것 | 한 번을 넘지 않는다 | 같은 파일의 `a drain that comes while the idle exit is stopping the work stops what is left and announces it once` |
| R12 | 예산 안에 답하지 않은 목록 읽기를 "프로세스 없음"으로 보고 worker가 포기한 뒤 캡처를 시작하는 것 | 조용하다고 보지 않고 캡처(checkpoint lease)를 시작하지 않는다 | 같은 파일의 `a scan the drain budget cut short is not read as a quiet run, …` |
| R13 | 후속 글이 그 turn의 본 글보다 먼저 나가는 것 | 본 글이 `pending`·`sending`인 동안 후속 글 행을 만들지 않는다 | `apps/control-host/src/slack/outbox.integration.test.ts`의 `waits while the turn's reply is unsent, and goes once it is` |
| R14 | 같은 답(같은 `after_turn` result)에 후속 글이 둘 생기는 것 | dedupe 키가 하나만 받는다. 두 drain이 동시에 읽어도 행은 하나 | 같은 파일의 `taken again, the same answer is one post; two answers are two, in order` |
| R15 | 원본이 지워졌거나, 비공개 채널이 승인 대기이거나, 스레드가 mute된 turn의 후속 글이 나가는 것 | turn의 sources를 그대로 실어 지운 원본은 `voided_by_delete`, 승인 대기는 `not_addressed`로 끝나고, mute된 스레드에는 행을 만들지 않는다(본 답과 같은 규칙) | 같은 파일의 `is never sent once the message the turn answers is deleted`, `is not sent to a private channel waiting for approval, nor to a muted thread` |
| R16 | turn 자신의 result나 `after_turn` 표시 없는 이벤트로 후속 글이 생기는 것 | 후속 글 없음 | 같은 파일의 `a turn's own result, or one not marked after it, posts nothing` |
| R17 | turn의 실패 안내가 끝났지만 그 뒤 생긴 본 답(`reply:`)이 아직 보내는 중일 때 후속 글이 먼저 나가는 것 | 본 글 두 키 가운데 하나라도 `pending`·`sending`이면 기다린다 | 같은 파일의 `waits too while a reply comes after the turn's failure notice, and goes once it is sent` |
| R18 | 요청자 한 사람에게만 보인 안내 뒤의 후속 글이 스레드 전체에 나가는 것 | 후속 글 없음 | 같은 파일의 `does not follow a notice shown to the requester alone` |
| R19 | 본 글을 보내는 동안 세션이 닫혀 링크가 먼저 닫히고 후속 글이 사라지는 것 | 링크는 닫히고, 닫히기 전 답의 후속 글은 닫힌 링크가 하루 안에 받는다 | 같은 파일의 `a closed session's link closes at once, and the follow-up it owed still goes` |
| R20 | 텍스트 없는 답이 한 번에 읽는 수를 차지해 뒤의 답이 나가지 못하는 것 | 텍스트 없는 답은 후보가 아니다 | 같은 파일의 `one with nothing to say holds no place ahead of a later answer` |
| R21 | 닫히는 세션에서 한 drain에 다 넣지 못한 후속 글이 링크가 닫혀 사라지는 것 | 닫힌 링크가 하루 안에 받는다 | 같은 파일의 `a closed session's thread still gets every follow-up it owed, one a pass` |
| R22 | 사람이 보내지 않은 turn(Slack 봇·agent)의 후속 글이 스레드를 연 사람을 부르는 것 | 멘션 없음 | 같은 파일의 `calls no one for a turn no person sent, not even who opened the thread` |
| R23 | 다른 drain이 본 글을 막 보낸 사이에 링크가 닫혀 후속 글이 사라지는 것 | 닫힌 링크가 하루 안에 받는다 | 같은 파일의 `a follow-up whose reply another pass just sent still goes once its link has closed` |
| R26 | 링크가 닫힌 뒤 저장된 답, 또는 닫힌 지 하루가 지난 링크에 후속 글이 나가는 것 | 후속 글 없음 | 같은 파일의 `an answer stored after its link closed, or a link closed over a day ago, gets no follow-up` |
| R24 | 텍스트나 도구 호출이 payload 옆(`events.neutral`)에 저장된 답을 잘못 읽는 것 | 읽는 쪽과 같은 규칙으로 읽는다 | 같은 파일의 `reads what the engine said from the fields stored beside its payload, as the codec stores them`, `a tool call it cannot read keeps the text beside it, as a reply reads it` |
| R25 | 본문이 읽는 마지막 500개 이벤트보다 앞에만 텍스트가 있는 답이 한 번에 읽는 수를 차지하는 것 | 그런 답은 텍스트가 없는 답으로 본다 | 같은 파일의 `text further back than a reply reads is none, so it holds no place ahead of a later answer` |
| R27 | lease를 내려놓았다는 기록(exit 75) 없이 사라진 worker의 열린 turn(승인 대기 checkpoint에 park되지 않은 것)을 `worker_ownership_lost`로 닫는 것 | turn은 `outcome_unknown`(`execution_gone`), 세션은 `recovery_required`(이미 `closed`인 세션은 `closed` 그대로). 사람의 복구 결정이 그 turn을 정한다 | `packages/db/src/worker-ownership-lost.test.ts`의 `word absent, lease expired: turn outcome_unknown, session recovery_required`, `word absent, lease live: turn outcome_unknown, session recovery_required`, `the sweep records lease_expired and the turn is unknown, as before`, D2 gate의 D-03 |
| R28 | 기록은 있지만 lease가 아직 살아 있고 kill이 요청되지 않은 실행의 turn을 닫는 것 | 닫지 않는다. 기록만 남기고 slot과 세션 연결을 그대로 둔다(`lease_pending`). kill이 요청된 실행은 기다리지 않는다. 그때 park되지 않고 열려 있던 turn은 `outcome_unknown`으로 닫힌다 | 같은 파일의 `word kept, lease live: nothing is settled, the word is recorded and the look is asked again`, `a later look that no longer sees the exit code still waits while the lease is live`, `is not held up by a live lease: the exit settles at once, the turn unknown as before` |
| R29 | 상한 안쪽의 turn(호출이 상한과 같거나 적음)이 `tool_call_limit`로 끝나는 것. engine이 같은 id를 두 번 낸 호출을 둘로 세는 것 | 그 turn은 engine이 말한 대로 끝난다 | `apps/worker/src/worker-host.test.ts`의 `a turn that makes exactly the limit's calls ends as the engine says`, `a call the engine names twice counts once` |
| R30 | 한 turn의 상한이 세션이나 다음 turn을 끝내는 것, 다음 turn이 앞 turn의 호출 수를 이어 세는 것 | engine이 유예 안에 끝내면 그 turn만 failed. 세션은 닫히지 않고(admission `active`) 다음 입력을 받고, 다음 turn은 0부터 센다 | 같은 파일의 `the call past the limit ends only that turn tool_call_limit, and the next turn runs from zero`(claude scripted 엔진), `a Codex run is cut at the same call, and its next turn runs`(Codex 어댑터의 이벤트 꼴) |
| R31 | 상한으로 끊긴 turn에서 뒤늦은 승인 요청이 등록·허용되는 것, 뒤에 온 사용자 interrupt가 두 번째 interrupt를 보내 끝(`tool_call_limit`)을 바꾸는 것 | 승인 요청은 바로 취소된다. worker는 사용자 interrupt를 실행하지 않고, turn은 `tool_call_limit`로 끝나며, 그 interrupt의 receipt는 turn이 확정될 때 `no_op`으로 `succeeded`가 된다 | 같은 파일의 `an approval asked after the cut is refused, not registered`, `a user's interrupt after the cut leaves the turn to the limit` |

R7~R28을 빼면, 파일을 적지 않은 시험은 `packages/db/src/worker-unit-of-work.outside-turn.test.ts`에 있다.

열린 turn, `outcome_unknown` turn, `cancelled` turn에 하는 commit도 409 `REQUEST_STALE`로 거절한다(`is refused on a turn that is %s`).

turn만 보고 거절할 수 있는 commit(R2, R3, 위 문장)은 manifest를 읽기 전에, lease를 보기 전에 거절한다. 그래서 lease를 잃은 attempt가 R1의 답 대신 409 `REQUEST_STALE`나 404를 먼저 받을 수 있다. pointer와 pending 사유를 쓰는 일은 언제나 fence 아래에서 한다.

turn을 이름으로 가진 채 저장된 이벤트를 turn 없이 다시 보내면 같은 이벤트로 받지 않는다(409, `an event stored for a turn it named is not the same event sent again for no turn`). 같은 commit의 재전송은 revision, manifest 위치, digest, object version이 모두 같을 때만 저장된 답을 돌려준다(`a resend that names another version of the manifest object is not the commit that landed`).

### 지킬 성질

| # | 성질 | 시험 |
| --- | --- | --- |
| P1 | 덮이지 않은 turn이 있는 세션은 새 worker로 넘어가지 않는다 | `tests/context-gap-flow.integration.test.ts`의 `an idle exit without a covering checkpoint waits on an operator, …` |
| P2 | 배경 작업을 남긴 turn 뒤에 idle 종료가 와도, 캡처가 성공하면 세션은 recovery_required가 되지 않는다 | 같은 파일의 `a turn that left background work running is checkpointed once the work ends, …`, `apps/worker/src/worker-host-outside-turn.test.ts`의 유예 안·밖 시험 |
| P3 | turn 없는 checkpoint는 어느 turn도 덮지 않는다. turn 밖 commit은 언제나 turn id를 가진다 | `a checkpoint that names no turn covers none, …`, `a commit outside a turn always names the turn it is put on` |
| P4 | turn 밖 출력과 비용은 언제나 한 turn에 속한다 | `go on the turn it ended last, marked as after it, …`, `packages/db/src/exchange-budget.test.ts`의 `a call between turns is charged as the turn the attempt ended last, …` |
| P5 | 인프라 실패 pending 동안 다음 turn은 시작하지 않는다. 결정적 거절은 다음 turn을 막지 않고, 보류는 상한에서 끝난다 | `apps/worker/src/worker-host-outside-turn.test.ts`의 `a publish the infrastructure failed is retried in the lease, …`, `a capture the workspace itself refuses does not hold the next turn, …`, `past the hold's limit input is asked for again …`, 업로드만 실패시킨 `an upload the store fails is retried in the lease on the backoff, …`와 commit만 실패시킨 `a commit the gateway fails is retried in the lease on the backoff, …`, 흐름 시험 `an upload the store failed is retried in the lease while the next message stays queued, …`, `a commit the gateway failed is retried in the lease while the next message stays queued, …`, D2 gate의 B-02 |
| P6 | 배경 작업 유예 중에 종료 신호를 받아도, 캡처가 성공해 마지막 turn이 덮이면 세션은 recovery_required가 되지 않는다. 캡처가 실패해 마지막 turn이 덮이지 않은 채 남으면 지금처럼 recovery_required다 | 흐름 시험 `SIGTERM during the background grace stops the work, checkpoints the turn …`, `SIGTERM during the background grace whose capture fails still leaves the session to a recovery decision`, `apps/worker/src/worker-host-outside-turn.test.ts`의 `a drain during the background grace stops the work at once …`, `a drain whose capture fails leaves the turn uncovered and still drains` |
| P7 | turn이 끝난 뒤 engine이 스스로 낸 답은 그 turn의 스레드에 답 하나당 후속 글 한 번, 본 글 뒤에 간다. 웹 대화에도 같은 답이 앞머리 없이 보인다 | `outbox.integration.test.ts`의 `goes once into the turn's thread, after its reply, under the line that says so`, `packages/adapters/chat/slack/src/slack-after-turn.test.ts`, `packages/react/src/blocks/session-chat.test.tsx`의 `shows it as the agent's next message in the turn, …` |
| P8 | lease를 스스로 내려놓고 끝난 worker의 turn(T15)은 승격되지 않는다(checkpoint 행도 pointer도 생기지 않는다). admission이 `active`이고 그 앞에 덮이지 않은 turn이 없으면 세션은 recovery_required가 되지 않고, 다음 입력을 새 worker에서 돈다 | `packages/db/src/worker-ownership-lost.test.ts`의 `word kept, lease expired: turn failed, session active`, `the look after the lease runs out fails the turn and keeps the session, from the record alone`, `input queued behind the lost turn is signalled, and the next worker gets it, never the lost turn`, D2 gate의 D-02·D-04 |
| P9 | 세션 turn의 도구 호출 수 상한은 두 엔진에 같게 worker가 센다(엔진의 `maxTurns`에 맡기지 않는다. Codex는 그 설정을 거절한다). 상한은 turn 하나에만 걸리고, 그 cut은 세션을 recovery_required로 보내지 않는다(engine이 interrupt에 답했을 때) | R30의 두 시험, `packages/adapters/runtimes/codex/src/run.test.ts`의 `each tool item is one tool.called, parallel ones too, and an interrupt ends the turn interrupted` |

D2 gate의 check는 `tests/d2-gate/gate.e2e.test.ts`가 낸다. B-02는 `B: a publish that fails at the manifest is never promoted`, D-02~D-04는 `D: a worker that loses its lease mid-turn promotes nothing`이다. 이 시험들은 `scripts/d2-gate/run.sh`가 띄운 스택에서만 돈다(야간과 수동 실행, gate 자신이나 `.github/workflows/d2-gate.yml`의 경로 목록에 든 파일을 바꾼 PR, release candidate 전의 `scripts/soak/rc.sh`).

T14의 후속 글은 답 하나(engine이 입력 없이 내고 `result`로 끝낸 것)마다 하나다. 본문은 같은 turn의 앞선 `after_turn` result 다음부터 이 result까지의 top-level assistant 이벤트에서, 마지막 도구 호출 뒤의 텍스트다(본 답과 같은 `finalReplyText`). 맨 앞에 요청자 멘션과 스레드 언어의 한 줄(`SLACK_OUTBOX_MESSAGES.*.afterTurn`)을 붙인다. 멘션은 질문 카드처럼 검사한 `<@…>`를 본문에 넣는 것이다. turn을 보낸 사람(`actor_id`)이 있고 그 사람의 Slack 계정이 연결돼 있을 때만 붙는다. Slack 봇이나 agent가 보낸 turn에서는 아무도 부르지 않는다(`SLACK_AFTER_TURN_MENTIONS_REQUESTER`로 끈다). 본 답은 멘션을 허용만 하고 넣지는 않는다. 본 글 두 키(`reply:`·`failure:`) 가운데 하나라도 보내는 중이면 기다리고, 본 글이 요청자 한 사람에게만 보인 안내(`notice`)면 후속 글은 없다. 텍스트가 없는 답(도구 호출만 한 답)은 올리지 않고, 찾을 때부터 후보에서 빠진다. 찾는 SQL은 `finalReplyText`와 같은 규칙으로 읽는다: 칸은 payload의 것을, 없으면 그 옆에 저장된 것(`events.neutral`)을 쓰고, 도구 호출은 `eventToolCall`이 읽는 모양만, 공백은 `trim`이 지우는 문자로 보며, 본문이 읽는 마지막 500개 이벤트 안만 본다. 링크는 후속 글을 기다리지 않고 전처럼 닫힌다(그래서 같은 스레드의 다음 멘션은 새 세션을 연다). 닫힌 링크도 닫힌 지 하루(`AFTER_TURN_CLOSED_LINK_GRACE`) 안이면, 닫히기 전에 저장된 답의 후속 글은 받는다(`linkTakesNew`가 그 키만 받는다). 닫힌 뒤에 저장된 답에는 후속 글이 없다. 닫힌 지 얼마 안 된 링크는 `session_links_recent_closed_idx`로 찾는다. 찾는 일은 `events_after_turn_result_idx`(after_turn result만 담은 부분 인덱스)로 링크마다 한다. turn의 본 답 판정은 바뀌지 않는다: 본 답은 여전히 `after_turn` 이벤트를 빼고 읽는다.

P4에는 예외가 하나 있다. 그 attempt가 아직 끝낸 turn이 없으면(시작 직후) 이벤트는 어느 turn에도 붙지 않고, 호출은 세션의 첫 turn의 예산 root로 잡힌다.

P4의 turn은 이벤트와 호출이 각각 control plane에 도착한 때로 정한다. turn N 뒤에 engine이 낸 이벤트가 늦게 도착해 turn N+1이 도는 중에 저장되면 어느 turn에도 붙지 않고, N+1이 끝난 뒤에 저장되면 N+1에 붙는다. 호출도 도착한 때의 turn으로 잡히므로, turn 경계에 걸친 답은 이벤트와 비용이 서로 다른 turn에 잡힐 수 있다. `after_turn` 이벤트는 답 판정(Slack 답, 예산 거절 경계)에 쓰이지 않는다.

`after_turn` 표시는 control plane만 붙인다. worker payload에 같은 이름의 키가 있어도 읽히지 않는다. payload가 객체가 아닌 이벤트는 표시를 옆에 저장만 하고, 읽을 때는 payload 그대로 나간다. Slack이 원문을 지워 가려진 turn의 이벤트는 표시 없이 읽힌다.

### 알려진 한계

- 이미 checkpoint가 있는 turn 뒤에 engine이 스스로 답을 냈는데 그 답을 다시 캡처하지 못한 채 worker가 끝나면, pointer는 여전히 그 turn을 덮는다고 읽힌다. 다음 worker는 그 답이 없는 transcript에서 이어 간다. 답은 세션의 이벤트(`after_turn`)로 남고, 웹 대화와 (T14가 올리는 스레드라면) Slack 스레드에 보인다. engine의 문맥에서는 빠진다. worker는 그 답을 다시 캡처하려고 시도하지만, 판정(context gap)은 이 경우를 보지 않는다.
- T14는 답이 `result`로 끝나야 후속 글을 만든다. result 전에 worker가 끝나면 그 답의 글은 없다(이벤트와 웹 대화에는 남는다).
- 본문은 답마다 마지막 500개 이벤트만 읽는다. 텍스트 뒤에 텍스트도 도구 호출도 아닌 이벤트가 500개 이상 오면 그 답은 텍스트가 없는 답으로 보고 올리지 않는다(찾는 SQL도 같은 범위를 센다).
- 닫힌 링크는 하루 동안만 후속 글을 받는다. 본 글이 링크가 닫힌 뒤 하루 넘게 나가지 못하면 그 후속 글은 올라가지 않는다.
- 세션 이벤트 아카이브가 `events`에서 옮긴 답은 후속 글 대상에서 빠진다(아카이브에는 남는다).
- 모델이 본문에 요청자를 이미 멘션했다면 맨 앞 멘션과 함께 두 번 보인다.
- 같은 turn의 답 둘이 함께 기다리다 따로 claim되거나 앞의 것이 다시 보내기를 기다리면, 뒤의 답이 먼저 올라갈 수 있다.
- 살아 있는 run에서 engine이 입력 없이 답하는 중에 다음 입력이 전달되고, 그 답의 result가 입력을 이름으로 갖지 않으면 worker는 새 turn을 `outcome_unknown`으로 닫는다(전부터 있던 동작). 배경 작업이 끝난 직후에 메시지가 들어오면 일어날 수 있다. 이 절의 전이는 복원한 engine이 같은 알림에 다시 답하는 경우만 막는다.
- ambient가 아닌 알림 뒤에 engine이 result를 내지 않으면, 그 run은 다음 turn의 result가 올 때까지 조용하지 않다고 읽힌다. 그동안 turn 밖 캡처는 거절되고, 덮이지 않은 turn이 있으면 idle 종료는 T10으로 간다.
- 배경 작업 멈춤 알림은 checkpoint commit과 따로 보낸다. commit이 먼저 닿고 알림이 닿기 전에 worker가 fence되면(긴급 정지, 종료 등) 다음 turn의 입력과 세션 상세에 그 줄이 없다.
- T6에서 멈춘 뒤 engine이 답하면서 새 작업을 시작하면, 알림 이벤트에는 처음 목록의 명령 이름만 들어 있다.
- T16의 상한은 `tool.called`로 센다. 상한을 넘는 호출은 interrupt가 engine에 닿기 전에 시작됐을 수 있다(대화 turn의 상한과 같다). Claude의 server tool(`server_tool_use`, 웹 검색 등)은 engine이 `tool_use`로 내지 않아 세지 않는다. 같은 오류가 이어질 때 멈추는 규칙은 두지 않는다(정상 재시도를 끊는다).

### 멘션 턴의 시도

Slack 멘션 턴이 결정 없이(`no_decision`) 끝나면, slack 역할의 턴 끝내기 pass가 같은 글로 다시 시도한다. 시도는 `conversation_turn_queue`의 한 줄이다. 같은 `input_id`에 `attempt`를 하나 올린 새 turn을 쓰고, 멘션(`conversation_engagements`)을 새 turn으로 옮긴다. 앞 turn은 그 자리에서 끝난 것으로 표시해 다시 집지 않는다.

"밖으로 나간 것"은 다음 가운데 하나다. 나간 것이 있는 시도는 다시 하지 않는다. 같은 말이나 도구 효과가 두 번 나갈 수 있어서다.

- turn에 결정이나 작업 효과(`decision`, `task_effect`)가 적혔다.
- 그 turn의 `slack_outbox` 줄이 있다(다시 시도 안내 줄은 뺀다).
- 그 turn의 provider 호출의 끝 보고가 turn이 끝난 뒤 기다림 상한(30초) 안에 오지 않았다. 아직 `in_flight`이거나, 상한이 지난 뒤에 왔다. 정산된 호출은 적힌 끝 시각(`ended_at`)이 상한 뒤면 상한 뒤에 온 것으로 읽는다(그 시각이 상한 전인데 커밋이 상한 뒤인 경우는 알려진 한계).

provider 호출과 예산 원장 줄만으로는 나간 것으로 보지 않는다. 시도마다 자기 호출과 원장 줄을 따로 잡는다.

| # | 지금 상태 | 다음 상태 | 조건 | 누가 |
| --- | --- | --- | --- | --- |
| M1 | 시도 N(N < 3)이 `no_decision`으로 끝남 | 시도 N+1 queued, 스레드에 다시 시도 안내 한 줄(글 하나에 한 번), 스레드는 처리 중 그대로 | 나간 것이 없음, 예산 거절이 아님, 긴급 정지가 아님, 글이 지워지지 않음, 앞 시도가 끝난 뒤 간격이 지남 | 턴 끝내기 pass |
| M2 | 시도 3이 `no_decision`으로 끝남 | 실패 문구 한 줄, 스레드 active | 나간 것이 없음 | 턴 끝내기 pass |
| M3 | 시도가 `no_decision`으로 끝남, permit의 거절이 `budget` | 그 예산 계정의 문구 한 줄(사람 또는 팀), 스레드 active | — | 턴 끝내기 pass |
| M4 | 시도가 `no_decision`으로 끝남, 나간 것이 있음 | 실패 문구 한 줄, 스레드 active | 시도 횟수와 상관없음 | 턴 끝내기 pass |
| M5 | 다시 시도할 수 있는 시도(마지막 시도가 아님)가 끝났고 그 호출이 `in_flight` | 그대로(기다림) | 끝난 때부터 30초 안 | 턴 끝내기 pass |
| M6 | M5의 기다림 | M1(호출이 보고됨) 또는 M4(30초가 지남) | — | 턴 끝내기 pass |
| M7 | 시도가 `emergency_stopped`로 끝남, 또는 다음 시도를 쓰기 전에 글이 지워지거나 대화 rollout이 `on`이 아니게 됨 | 아무 말 없이 스레드 active | — | 턴 끝내기 pass |

### 멘션 턴의 시도: 값

값은 `packages/platform/src/conversations/conversation-turns.ts`에 있다.

| 이름 | 값 | 뜻 |
| --- | --- | --- |
| `MENTION_TURN_ATTEMPTS` | 3 | 첫 시도를 포함한 시도 수 |
| `MENTION_TURN_RETRY_DELAYS_MS` | 0, 10초 | 2번째, 3번째 시도 전 간격 |
| `MENTION_TURN_CALL_SETTLE_WAIT_MS` | 30초 | M5의 기다림 상한. 주제는 호출을 하나만 받으므로, 앞 호출이 남은 채 다시 시도하면 동시성 거절이 난다 |

### 멘션 턴의 시도: 막을 전이와 성질

시험은 모두 `apps/control-host/src/slack/session-handler.integration.test.ts`에 있다.

| # | 막을 전이 | 시험 |
| --- | --- | --- |
| MR1 | 네 번째 시도 | `three tries that all fail: one retry line and one failure line, no fourth try, the thread active` |
| MR2 | 예산 거절된 시도의 다시 시도 | `a try a budget account refused is not tried again: the account's line alone, the thread active` |
| MR3 | 나간 것이 있는 시도의 다시 시도 | `a try that left a Slack row is not tried again: the failure line at once, the thread active` |
| MR4 | 호출이 남은 시도의 바로 다시 시도 | `a try whose call is still out waits for its report, and past the wait ends on the failure line` |
| MR5 | 긴급 정지로 끝난 시도의 다시 시도나 안내 | `a try an emergency stop ended is not tried again and says nothing, the thread active` |
| MR6 | 지워진 글의 다음 시도 | `a mention deleted before its next try is written ends with nothing said` |
| MR7 | 나란히 돈 두 pass가 다음 시도를 둘 쓰는 것 | `two passes at once write one next try and one retry line` |
| MR8 | 끝 보고가 상한 뒤에 온 호출의 시도를 다시 하는 것 | `a call that reports past the wait counts as one still out, whichever pass reads it` |
| MR9 | 다음 시도를 쓰지 못했는데 다시 시도 안내를 다는 것 | `a try whose kept input is gone ends on the failure line alone, with no retry line` |
| MR10 | 열 수 없는 봉인(다른 key)이 큐 정리를 막거나 남는 것 | `an untaken try sealed under another key ends, keeps nothing, and its thread hears the failure line` |
| MR11 | 다른 pass가 다음 시도를 쓰고 사본을 놓은 것을 사본이 없어진 것으로 읽고 실패 문구를 다는 것. 사본을 멘션보다 먼저 읽는다 | `a pass that read the mention before another wrote the next try ends on that try, with no failure line` |
| MR12 | 다시 시도 안내를 쓰지 못해서 이미 옮긴 다음 시도를 잃는 것. 안내 없이 다음 시도를 큐에 넣는다 | `a retry line that cannot be written leaves the next try queued` |
| MR13 | permit을 쓴 뒤 큐에 넣기 전에 긴급 정지가 끝낸 시도가 큐에 들어가는 것. 큐에 넣을 때 정지와 같은 큐 잠금 아래에서 turn이 이미 끝났는지(`ended_at`) 본다 | `a try an emergency stop ended before it was queued is not queued, and nothing follows it` |
| MR15 | 대화 rollout이 꺼진 에이전트의 다음 시도. 다시 시도 요청이 rollout을 읽고 `on`이 아니면 말 없이 끝낸다 | `a try whose agent's rollout went off is not tried again and says nothing, the thread active` |
| MR16 | pass가 시도의 끝을 읽은 뒤 긴급 정지가 끝낸 시도에 실패 문구를 다는 것. 시도를 읽을 때 큐 결과가 `emergency_stopped`면 없는 시도로 본다 | `a try an emergency stop ended after a pass read its end says nothing once the channel is on` |
| MR19 | 정지가 끝낸 셋째 시도의 실패 문구를 다시 켠 뒤 다는 것(셋째 시도는 사본이 없다) | `a third try a stop ended after its runtime reported says nothing once the channel is on` |
| MR20 | 정지 전에 입력을 읽은 pass가 다시 켠 뒤 다음 시도를 쓰는 것. 발급 transaction이 바인딩 잠금 뒤에 앞 시도의 큐 결과를 읽고, `emergency_stopped`면 쓰지 않는다 | `a pass that read the try's input before a stop and the channel on again writes no next try` |
| MR21 | 정지 전에 입력을 읽은 pass가, 큐가 앞 시도의 끝을 잊은 뒤 다음 시도를 쓰는 것. 발급은 앞 시도의 큐 줄이 `ended`이고 정지 결과가 아닐 때만 쓴다 | `a pass that read the try's input before a stop and the queue forgot it writes no next try` |
| MR22 | 실패 문구를 고른 pass가 정지와 다시 켜기 뒤에 그 줄을 다는 것. 줄의 데이터를 읽을 때 큐 결과가 `emergency_stopped`면 쓰지 않고, 쓰지 않은 줄은 세지 않는다 | `a pass that chose the failure line before a stop says nothing once the channel is on` |
| MR23 | 다른 pass가 끝 문구를 단 시도를 이어 다음 시도를 쓰는 것. 발급은 앞 시도의 끝 줄(`conversation_reply:<turn_id>`)이 있으면 쓰지 않고, 끝 문구는 멘션이 다음 시도로 옮겨진 시도에 쓰지 않는다 | `a pass that read the try's input after another wrote its failure line writes no next try` |
| MR24 | 다른 pass가 먼저 단 끝 문구나 먼저 쓴 다음 시도를 한 번 더 세는 것. 줄이나 시도가 중복 키에 걸린 pass는 그것을 세지 않는다 | `a failure line another pass wrote first is counted once` |
| MR25 | 멘션이 이미 다음 시도로 넘어간 앞 시도를 정지 건수에 한 번 더 넣는 것. 정지는 입력 사본만 남은 앞 시도를 정리하되, 멘션을 쥔 시도나 그 정지가 끝낸 시도만 센다 | `a try whose mention the next try holds is not counted again by a stop` |
| MR26 | 끝 문구를 쓰지 못한(outbox 오류) 시도가, 그 뒤 정지했다 다시 켠 채널에서 다음 pass에 끝 문구를 다는 것. 줄을 쓰기 전에 그 시도가 끝난 뒤 생긴 같은 Slack 팀·채널의 정지 알림(정지마다 하나, 다시 켜도 남음. 시각은 정지가 시작한 때가 아니라 알림을 쓴 때)을 보고, 있으면 쓰지 않는다 | `a failure line not written before a stop says nothing once the channel is on` |
| MR27 | 줄이나 다음 시도를 쓴 뒤 입력 사본을 놓다 실패한 pass가 그것을 세지 않는 것. 쓴 것을 먼저 세고 사본을 놓는다 | `an account's line written before its input could not go is counted` |
| MR28 | 다른 Slack 팀의 같은 채널 id가 정지돼 끝 문구를 빠뜨리는 것. 정지 알림은 그 시도의 설치와 같은 팀의 것만 본다 | `a stop of the same channel id in another Slack team leaves the failure line` |
| MR29 | 다음 시도를 큐에 넣은 뒤 스레드 상태 잡기를 놓다 실패해 그 시도를 세지 않는 것. 큐에 넣은 시도는 놓기가 실패해도 `queued`로 돌려준다(놓지 못한 잡기는 기한이 지나면 풀린다) | `a next try queued before its thread claim could not go is counted` |
| MR17 | 다음 시도를 기다리는(10초) 동안 정지했다 다시 켠 채널에서 그 시도를 하는 것. 정지는 채널의 결정 없이 끝나 입력을 남긴 Slack 멘션 시도(운영자 turn은 빼고)도 `emergency_stopped`로 끝내고 사본을 놓는다 | `a try waiting out its delay when the channel is stopped is not tried again once it is on` |
| MR18 | 다시 시도 요청이 rollout을 읽은 뒤 꺼진 rollout에서 다음 시도를 쓰는 것. 발급 transaction이 에이전트 줄을 공유 잠금으로 다시 읽는다 | `a rollout turned off after the try was read is not tried again` |
| MR14 | 런타임이 끝을 보고한 뒤 pass가 끝내기 전에 긴급 정지가 끝낸 시도를, 채널을 다시 켠 뒤 다시 하는 것. 정지는 자기가 끝낸 turn의 이미 끝난 큐 줄을 사본이 있든 없든 `emergency_stopped`로 바꾸고 사본을 놓는다 | `a try its runtime reported before an emergency stop is not tried again once the channel is on` |

M1·M2는 `a model that fails twice and answers the third time: …`와 MR1의 시험이, M6의 M1 갈래는 `a try whose call reports within the wait is tried again`이 본다.

| # | 성질 | 시험 |
| --- | --- | --- |
| MP1 | 한 글의 시도는 같은 `input_id`에 attempt 1, 2, 3이고, 시도마다 자기 원장 줄을 잡는다(승인된 provider 호출마다 한 줄) | `a model that fails twice and answers the third time: …` |
| MP2 | 다시 시도 안내는 글 하나에 한 번, 다음 시도를 쓴 뒤에만 단다. 끝 문구는 마지막 시도에 한 번이다. 모든 줄은 turn의 출처를 실어, 보내기 시작하기 전에 글이 지워지면 나가지 않는다 | MR1, MR7, MR9, MR6의 시험 |
| MP3 | 시도가 끝나는 모든 길에서 스레드는 active로 돌아간다 | M2, M3, M4, M7의 시험 |
| MP4 | 다음 시도는 보관한 요청 사본으로 쓴다. 다시 시도하지 않는 turn의 사본은 그 자리에서 놓는다. 놓기 전에 pass가 멈추면 보관 기한(1시간)의 sweep이 놓는다 | MR2의 시험 |

알려진 한계:

- 첫 시도가 밖으로 나간 것이 있어 바로 끝나도 실패 문구는 "세 번 시도했지만"이다(정해진 문구).
- 줄을 쓰는 pass가 정지 결과를 읽은 뒤 outbox에 넣기 전에 정지와 다시 켜기가 모두 끝나면 그 줄은 나갈 수 있다. pass가 정지와 다시 켜기 전체를 가로질러 멈춰야 생기고, 다음 시도는 발급 가드가 막는다.
- 턴 끝내기 pass가 10분 넘게 멈췄다 돌아오면, 큐가 그 시도의 끝을 잊어(`forgotten`) 입력 사본이 남았어도 다시 시도나 실패 문구 없이 끝난다.
- 롤링 업그레이드 중 앞선 이미지의 pass가 먼저 스레드를 active로 돌린 시도는 다시 시도하지 않는다. 앞선 이미지의 큐와 긴급 정지는 끝난 turn을 막거나 런타임이 보고한 큐 줄을 바꾸지 않는다.
- 다시 시도 안내 줄은 정지가 보내지 않은 채널 글을 거둘 때 함께 거둔다. 정지가 이어지는 동안 쓴 줄도 다시 켤 때 거둔다. 다만 안내를 쓰는 pass가 정지와 다시 켜기를 모두 지난 뒤에 그 줄을 커밋하면, 시도는 큐에 들어가지 않는데(`ended`) 안내 줄만 나갈 수 있다.
- 다시 해 볼게요 줄의 첫 Slack 보내기가 다시 보낼 수 있는 오류로 끝나 미뤄지거나, 보내기 pass가 그 줄을 잡은 채 마감에 닿아 잡기가 풀리기를 기다리는 사이 다음 시도가 답하면, 답이 먼저 나가고 그 줄이 뒤에 올 수 있다. 같은 스레드의 답을 대기 중인 그 줄 뒤에 세우거나, 답이 나갈 때 그 줄을 거두는 일은 후속으로 둔다.
- 다음 시도를 기다리는(10초) 사이 같은 스레드의 다른 멘션이 끝나면, 그 멘션의 상태 되돌리기가 스레드를 active로 돌리고, 다음 시도는 처리 중을 다시 보내지 않는다. 다음 시도를 쓸 때 처리 중을 다시 잡는 일은 후속으로 둔다.
- 호출의 정산이 30초 상한 전의 시각으로 적히고 커밋이 상한 뒤에 되면, 커밋 전에 읽은 pass는 실패 문구로, 커밋 뒤에 읽은 pass는 다시 시도로 갈 수 있다. 두 pass가 나란히 돌고 정산 커밋이 상한을 가로지를 때만 생긴다. 그때 스레드에는 실패 문구와 다시 해 볼게요, 답이 함께 온다(순서는 두 pass의 속도에 따라 다르고, 먼저 끝난 쪽이 스레드를 active로 돌렸으면 다음 시도 동안 처리 중으로 다시 보이지 않는다). 시도 수, 원장 줄, 중복 키는 그대로다.
- 다음 시도의 permit과 멘션 옮기기를 커밋한 뒤 큐에 넣기 전에 프로세스가 멈추거나 큐 넣기가 SQL 상한(10초)에 걸리면, 앞 시도에서 다시 이을 수 없고 새 시도는 큐에 없는 turn으로 조용히 끝난다(안내 줄이 먼저 커밋됐으면 그 줄만 남고 끝 문구는 없다). 발급과 큐 넣기를 한 transaction으로 묶는 일은 후속으로 둔다.
- 두 pass가 같은 시도를 서로 다르게 읽으면(릴리스 전환 중 한쪽은 연결을 찾지 못해 끝 문구를, 다른 쪽은 다시 시도를 고름), 두 쪽 모두 상대가 쓰기 전에 읽었을 때 끝 문구와 다음 시도가 함께 갈 수 있다(MR23은 한쪽이 먼저 커밋한 순서만 막는다). 끝 줄 쓰기와 멘션 옮기기를 한 잠금 아래 두는 일은 후속으로 둔다.

## 3. 대화 turn

### 작업 효과

멘션 턴이 `spawn_task`(새 작업 만들기)나 `route_to_task`(열린 작업에 넘기기)로 끝나면, slack 역할의 턴 끝내기 pass가 그 결정의 효과를 한 번 낸다. 결과는 `conversation_turns.task_effect`에 남는다. 값이 없으면 아직 끝을 쓰지 않은 것이다. `route_to_task`의 입력은 끝을 쓰기 전에 들어갈 수 있다.

#### `route_to_task`

| 지금 상태 | 다음 상태 | 조건 | 누가 일으키나 |
| --- | --- | --- | --- |
| `decided`, `task_effect` 없음 | `routed` | 출처 글이 지워지지 않았고, 대상이 턴과 같은 대화의 열린 작업이고, 글쓴이가 그 작업에 `session.submit` 권한이 있고, 보관한 요청 사본이 있어 그 작업에 입력이 들어갔다. 이 턴의 입력이 이미 작업에 있으면(앞선 실행이나 나란히 돈 실행이 넣었다) 그 뒤 글이 지워졌거나 권한이 바뀌었어도 판정 없이 `routed`다 | 턴 끝내기 pass |
| `decided`, `task_effect` 없음 | `refused` | (아래 셋은 이 턴의 입력이 작업에 없을 때만) 글쓴이의 `session.submit`이 거절됐다. 요청자에게만 알리고, 그 글이 닿지 않으면 스레드에 서버 한 줄을 단다 | 턴 끝내기 pass |
| `decided`, `task_effect` 없음 | `failed` | 대상이 닫혔거나 다른 대화(다른 채널, 다른 사람의 DM)의 작업이다. 턴이 Slack 앱이나 Slack 주체에 묶여 있지 않다. 출처 집합이 넘쳤다. 요청 사본의 기한(1시간)이 지났다. 그 밖의 세션 거절. 스레드에 서버 한 줄을 단다 | 턴 끝내기 pass |
| `decided`, `task_effect` 없음 | `voided` | 턴이 읽은 글에 지움 표식이 있다(효과 직전, 또는 입력을 받을 때). 아무것도 쓰지 않고 말하지 않는다 | 턴 끝내기 pass |
| `routed`, `refused`, `failed`, `voided` | (없음) | 끝 상태다. 다시 돌려도 바뀌지 않는다 | — |

지키는 성질:

- 끝 상태는 다른 끝 상태로 가지 않는다. 효과는 `task_effect`가 비어 있을 때만 쓴다.
- `route_to_task`의 효과는 작업을 새로 만들지 않는다. 대상 작업이 실행 중이면 입력은 그 뒤에 줄을 선다.
- `routed`면 대상 작업에 그 글의 입력이 하나 있고, 다른 값이면 없다. 입력은 턴 id를 키로, 호출자가 보내는 어떤 키와도 겹치지 않는 범위에서 받는다. `routed`가 아닌 끝은 그 입력이 없을 때만 쓴다. 같은 턴을 몇 번 돌려도 입력, mirror 줄, 스레드 안내 줄은 하나다.
- 입력을 넣는 일과 끝을 쓰는 일은 같은 잠금(그 턴의 입력 영수증 범위)을 잡는다. 끝을 쓰는 쪽은 잠금 뒤에 영수증을 읽고, 입력을 넣는 쪽은 잠금 뒤에 그 턴이 `routed`가 아닌 값으로 끝났으면 넣지 않는다. 그래서 같은 턴의 두 실행이 나란히 돌아도 입력과 끝이 어긋나지 않는다. 입력이 있어 끝을 쓰지 못한 실행은 그 자리에서 `routed`로 끝낸다.
- 열린 작업인지는 입력을 넣기 전에 본다. 그 뒤 작업이 `failed`가 되었어도 입력 허용(admission)이 열려 있으면 입력은 들어가고 작업은 다시 줄을 선다. 원래 스레드의 후속 글과 같다.
- 요청자에게만 보이는 거절 알림은 끝을 쓰기 전에 보낸다. 끝을 쓰기 전에 실행이 멈추거나 두 실행이 나란히 돌면 또 갈 수 있고, 다른 실행이 입력을 막 넣었다면 결국 `routed`로 끝나는 턴에도 갈 수 있다(`spawn_task`의 거절 알림과 같다).
- 넘긴 입력은 턴의 출처 집합 전체(direct와 inherited)를 싣는다. 그중 하나가 지워지면 그 출처를 실은 보내기가 막힌다.
- `spawn_task`의 값(`opened`)과 `route_to_task`의 값(`routed`)은 섞이지 않는다. `routed_session_id`는 `route_to_task` 턴에만 있고, `routed`면 반드시 있다. 결정이 없는 턴에는 `task_draft`, `routed_session_id`, `task_effect`가 모두 없다(CHECK `conversation_turns_task_check`).

#### `spawn_task`

| 지금 상태 | 다음 상태 | 조건 | 누가 일으키나 |
| --- | --- | --- | --- |
| `decided`, `task_effect` 없음 | `opened` | `task.spawn`을 다시 판정해 허용되고 작업 세션이 열려 스레드에 묶였다(앞선 실행이 연 세션도 같다) | 턴 끝내기 pass |
| `decided`, `task_effect` 없음 | `refused` | `task.spawn` 거절, 열린 작업 한도, 쓸 수 없는 저장소 | 턴 끝내기 pass |
| `decided`, `task_effect` 없음 | `failed` | 턴이 묶여 있지 않다, 출처 집합이 넘쳤다, 스레드를 다른 글이 잡았다, 요청 사본이 없다 | 턴 끝내기 pass |
| `decided`, `task_effect` 없음 | `voided` | 턴이 읽은 글에 지움 표식이 있다 | 턴 끝내기 pass |
| 끝 상태 | (없음) | 다시 돌려도 바뀌지 않는다 | — |

### 청하지 않은 턴

M1이 끼어들기(`speak`)로 판단한 글에, 아무도 부르지 않았는데 에이전트가 대화 턴으로 답한다(v1-b/U1). 대화 rollout이 `on`일 때만 턴을 낸다. 판단 하나(`conversation_judgments`의 한 줄)가 턴 하나를 낳고, 그 줄의 `target_ts`(답할 글), `turn_id`(낸 턴), `answer`(어떻게 끝났나)에 상태가 남는다. 버퍼의 묶음 판단(`buffer_m1`)과 최근 관여한 스레드의 답글 판단(`m1_engaged`)이 턴을 낸다. 닫힌 작업에 묶인 스레드의 답글(`m1`)은 rollout `on`에서 세션에 가지 않고 판단 버퍼에 보류된 채 판단받으므로, `speak`면 턴을 낸다. 같은 답글이 `shadow`·`off`에서 이미 세션의 턴이 된 뒤 판단받았으면 세션이 답하고 판단은 기록만 남는다. 작업 스레드의 답글(`m1_to_task`)은 작업이 열려 있으면 턴을 낳지 않고, `speak`면 작업의 다음 턴이 된다. 기다리는 사이 그 작업이 닫혔으면 턴을 낸다(아래 "작업 스레드의 답글").

| 지금 상태 | 다음 상태 | 조건 | 누가 일으키나 |
| --- | --- | --- | --- |
| (판단 전) | `speak`, `target_ts` 있음 | M1이 `speak`로 답하고 `reply_to`가 읽은 글(refs) 가운데 하나를 가리킨다. 답글 판단은 그 답글 자신이다 | M1 판단 pass |
| (판단 전) | `quiet`/`invalid_target` | 묶음 판단의 `speak`가 답할 글을 고르지 않았거나, 읽지 않은 글을 가리켰다. 턴을 내지 않는다 | M1 판단 pass |
| `speak`, `turn_id`·`answer` 없음 | `turn_id` 있음 | rollout `on`, 채널 binding이 살아 있고(`ready`, `mode = on`, 외부 공유 아님, 긴급 정지 아님) 판단한 글을 아직 듣는다(묶음 판단의 글은 듣기 `free`일 때만, 관여한 스레드와 닫힌 작업 스레드의 답글은 `free`나 `mention`일 때). 닫힌 작업 스레드의 답글(`m1`)은 세션의 턴이 그 글을 가져가지 않았을 때만이다. 에이전트가 `active`이고 채널이 보관되지 않았으며, 턴의 출처 글에 지움 표식이 없다. 턴(요청자 없음, root none)과 permit, 판단의 `turn_id`를 한 transaction에 쓰고, 답할 글의 첫 시도(attempt 1)로 큐에 넣는다 | 판단을 기록한 M1 판단 pass |
| `speak`, `turn_id`·`answer` 없음 | 그대로 | rollout `shadow`·`off`. 판단만 남는다 | M1 판단 pass |
| `speak`, `turn_id`·`answer` 없음 | `answer` = `source_deleted` | 턴의 출처 글에 지움 표식이 있다 | M1 판단 pass |
| `speak`, `turn_id`·`answer` 없음 | `answer` = `channel_stopped` | 살아 있는 binding이 없거나(판단한 글을 더 듣지 않는 경우 포함) 긴급 정지 중이다. 턴을 낼 때 에이전트가 `active`가 아니거나(이미 보관된 에이전트는 `not_started`) 채널이 보관·삭제됐을 때도 같다 | M1 판단 pass |
| `speak`, `turn_id`·`answer` 없음 | `answer` = `not_started` | 에이전트·대화·활성 릴리스·연결이 없거나, 답할 글이 턴의 입력 한도보다 길다 | M1 판단 pass |
| `turn_id` 있음, `answer` 없음, 턴 `running` | `answer` = `replied` | 턴이 `reply`로 끝났다. 답할 글의 스레드에 답을 단다(최상위 글이면 그 글의 스레드, 답글이면 부모 스레드) | 턴 끝내기 pass |
| 〃 | `answer` = `no_reply` | 턴이 `no_reply`로 끝났다 | 턴 끝내기 pass |
| 〃 | `answer` = `budget_refused` | 결정 없이 끝났고 permit의 마지막 거절이 예산이다 | 턴 끝내기 pass |
| 〃 | `answer` = `no_decision` | 결정 없이 끝났다(한도, 실패, 시간 초과, 받히지 않음). 다시 시도하지 않고 아무 말도 하지 않는다 | 턴 끝내기 pass |
| 〃 | `answer` = `source_deleted` | 결정을 기록하기 전에 출처 글이 지워졌다(`voided_by_delete`) | 턴 끝내기 pass |
| `answer` 있음 | (없음) | 끝 상태다. 다시 돌려도 바뀌지 않는다 | — |

막을 전이(괄호는 그 거절을 고정하는 시험):

- 한 판단에서 두 번째 턴을 내지 않는다(`packages/db/src/conversations/unasked-turns.test.ts` "the same judgment again makes no second turn"). 고유 색인 `conversation_judgments_turn_uniq`가 한 턴에 판단 둘이 붙는 것을 막는다("one judgment per turn").
- `answer`가 있거나 `quiet`인 판단에서 턴을 내지 않는다("a judgment whose end is written already, or that did not speak, makes none").
- `shadow`·`off`에서 턴을 내지 않는다("rollout shadow/off: ... no turn is made"). 판단 기록이 주제를 지운 뒤에도 `rollout_off`로 답하고 판단에 아무것도 쓰지 않는다("rollout shadow: no turn comes, and the topic goes with the post").
- 턴이 있는 판단에 `not_started`류를 덮어쓰지 않는다. 끝은 한 번만 쓴다("why no turn was made is written once ...", "a reply is replied ..., written once").
- 아직 `running`인 턴의 끝을 쓰지 않는다("a running turn writes nothing yet").
- `target_ts`는 refs 밖이거나 `speak`가 아닌 판단에 둘 수 없다. `turn_id`·`answer`는 `target_ts` 없이 둘 수 없고, `answer`는 위 값만 받는다. `speak`는 `invalid_target`을 이유로 가질 수 없다(CHECK, "conversation_judgments' unasked columns" 시험들). refs에 NULL이 섞여 있어도 refs 밖의 `target_ts`는 막고, 결정이 없는 `judged` 행도 `target_ts`를 가질 수 없다("a target not among the refs is refused, a null among them too", "a judged record with no decision holds no target").
- 속도 제한(`rate_limited`)·`quiet`·기록되지 않은 판단, `m1_to_task` 답글, 보류되지 않은(세션이 가져간) `m1` 답글은 턴을 내지 않는다(`packages/platform/src/conversations/unasked-turns.test.ts`). DB도 `m1_to_task` 판단과, 세션의 턴이 가져간 글의 `m1` 판단으로는 턴을 쓰지 않는다("a reply of work going on that spoke (m1_to_task) makes none: the work answers it", "a closed work's reply its session took (m1) makes none: one post, one answer"). 보류된 `m1` 답글은 턴을 낸다("a closed work's held reply that spoke (m1) makes its one unasked turn").
- 묶음을 닫은 뒤 채널 듣기가 `mention`으로 바뀌면 묶음 판단은 턴을 내지 않는다. 관여한 스레드의 답글 판단은 낸다("listening for mentions alone: no turn", "an engaged reply still speaks while the channel hears mentions alone"). 판단 뒤 채널이 보관되었거나 에이전트가 멈췄으면 턴을 내지 않는다("the channel archived / the agent paused since the judgment: no turn"). 에이전트 상태는 잠근 채 읽는다. 채널 상태는 잠그지 않고 읽으므로, 턴을 쓰는 transaction과 같은 순간에 commit되는 채널 보관은 놓칠 수 있다.
- `shadow`·`off`에서 세션이 가져간 닫힌 작업 스레드의 답글은 `speak`여도 청하지 않은 턴이 없고 세션의 턴 하나만 남는다(`packages/db/src/conversations/unasked-turns.test.ts`의 "the session takes it as its one turn; M1's speak makes no unasked turn", `apps/control-host/src/slack/session-handler.integration.test.ts`의 "one post, one answer: a reply a session took makes no unasked turn, though M1 spoke").

지킬 성질:

- 청하지 않은 턴의 결정 도구는 `reply`와 `no_reply`뿐이다(`conversationDecisionTools("agent")`, 골든 시험). 서버도 같은 표로 다시 본다.
- 요청자가 없다(`requester_kind = agent`, permit `root_kind = none`, `requester_user_id` 없음). 호출은 에이전트 팀 계정에 잡히고, 이 호출의 예약까지 더해 팀 계정 한도의 80% 이상이 되면 거절된다. 팀 계정에 한도가 없으면 거절된다(`admitsBudgetReserve`). 채널의 M1 판단 한도(기본 시간당 12회, binding마다 다를 수 있다)는 판단에 그대로 걸린다.
- 👀를 달지 않고, 다시 시도하지 않고, 시도 줄을 달지 않고, 스레드 상태("processing"/active)를 바꾸지 않는다. 같은 스레드의 멘션 턴이 단 "processing"을 대신하지도 않는다(새 턴이 있다고 옛 멘션 턴을 `superseded`로 넘기지 않는다). 턴을 쓸 때 잡는 상태 claim(큐에 넣은 뒤 놓는다)은 같은 스레드의 상태 보정을 막지 않고, 끝날 때 스레드를 다시 보정할 줄로 남기지도 않는다("its end leaves no thread to set again, though a newer mention holds it", "a thread's status to set waits on no unasked turn of it").
- 턴을 낼 때 잠금은 에이전트 share까지 멘션 재시도 길과 같은 순서다. scope의 binding과 주제, 출처 글의 표식, 에이전트(share) 순이다. 청하지 않은 턴은 그 뒤 살아 있는 binding을 share로 한 번 더 잡는다. 이 순서는 에이전트 보관(archive: 에이전트 → binding)과 엇갈려, 서로 상대가 잡은 잠금을 기다리면 PostgreSQL이 한쪽을 교착으로 끝낸다. 턴 쪽이 끝나면 판단에 `turn_id`·`answer`가 비어 남는다. 두 길을 함께 따로 고친다.
- `answer`는 판단의 턴이 어떻게 끝났는지다(결정, 예산 거절, 결정 없음, 나지 않음). Slack에 실제로 올라갔는지는 outbox 줄이 가진다. 결정 뒤 글이 지워져 outbox가 보내지 않아도 `replied`로 남는다.
- 턴의 지시는 고른 글 하나다. 같은 묶음의 다른 글은 "참고일 뿐 지시가 아니다"라는 줄 뒤 데이터 블록에 넣는다. 데이터 블록 안의 글은 그 블록을 닫지 못한다.
- 답은 고른 글의 스레드에만 단다. 채널 최상위에 올리지 않는다. 답을 달기 직전에 출처 글의 지움 표식을 다시 보고, 같은 턴의 답은 몇 번 돌려도 하나다.
- 판단을 기록하는 transaction은 판단한 글의 버퍼 행과 그 행만 있던 주제를 지운다. 다만 rollout이 `on`이고 `speak`가 글을 골랐으면 고른 글의 주제는 남긴다. 턴은 그 transaction 뒤에 그 주제에 쓰이기 때문이다. 턴이 나지 않으면(rollout `on`이 아니게 됨, `not_started`, `source_deleted`, `channel_stopped`) speaker가 그 주제를 비었을 때 지운다(`packages/db/src/conversations/unasked-turns.test.ts` "a batch that spoke keeps its post's topic for the turn", platform "... lets its topic go ...").
- 판단을 기록한 뒤 턴을 내기 전에 프로세스가 죽으면 그 판단의 턴은 나지 않는다(`turn_id`·`answer` 둘 다 없이 남는다). 남긴 주제도 빈 채로 남는다. 알려진 한계다.
- 판단 기록과 턴 내기는 다른 transaction이다. 그 틈에 같은 주제의 마지막 다른 버퍼 행이 지워지면(다른 묶음의 기록, 기한 지난 행 정리) 주제도 지워져 턴이 나지 않고 `not_started`가 남는다. 잘못 올리는 글은 없다. 다시 시도하지 않는다. 알려진 한계다.
- rollout을 `shadow`·`off`로 내리거나 binding만 철회해도 이미 낸 턴은 계속 돌아 답할 수 있다. 멘션 턴과 같다. 내림과 철회는 다음 턴부터 적용되고, 지금 멈추는 것은 긴급 정지가 맡는다. 긴급 정지는 채널의 돌고 있는 대화 턴을 요청자와 상관없이 끝내고, 보내기 시작하지 않은 글(`sending` 전)을 막는다. 이미 `sending`이 된 글은 올라갈 수 있다. W1은 `on` → `shadow` 때 큐에 든(아직 시작하지 않은) 대화 턴을 취소한다(W1 사양).
- `shadow`에서 기록한 직후 `on`이 되면, 판단이 남은 주제를 다른 글이 쓰고 있을 때만 턴이 난다. 비어서 지워졌으면 `not_started`가 남는다.

### 작업 스레드의 답글

작업에 묶인 Slack 스레드에 사람이 봇을 멘션하지 않고 단 답글이다(v1-b/U1). rollout `on`에서만 이 길을 탄다. `shadow`·`off`에서는 예전처럼 세션이 바로 받는다(`shadow`는 곁에 판단 기록만 남기고, 그 기록의 등급도 아래 결정 35를 따른다: `idle`인 `active` 세션의 답글은 `m1_to_task`). 작업이 열렸는지는 결정 35대로 묶인 세션의 `admission_state`로 본다(`packages/db/src/conversations/session-work.ts`의 `sessionWorkClosed`). `closing`·`closed`면 닫힌 작업(`m1`), 그 밖이면(`idle`·`paused`·`stopped` 세션 포함) 열린 작업(`m1_to_task`)이다. 세션이 없으면 닫힌 작업으로 본다. 봇을 멘션한 답글은 이 길을 타지 않고 지금의 멘션 길로 간다.

| 지금 상태 | 다음 상태 | 조건 | 누가 일으키나 |
| --- | --- | --- | --- |
| (받음), 닫힌 작업 | 보류(`m1`, 판단 전) | 처리표가 `m1`을 낸다. binding이 승인됐고, 글이 텍스트이며 들을 수 있는 사람의 글이다. 글을 판단 버퍼에 보류하고 판단을 연다. 세션에는 가지 않는다 | slack 역할 inbox pass |
| (받음), 닫힌 작업 | 버림 | 처리표가 `m1`을 내지 않거나(듣기 `off` 등), 승인 전이거나, 들을 수 없는 사람의 글이다. 세션에도 가지 않는다 | slack 역할 inbox pass |
| 보류(`m1`) | 청하지 않은 턴 | M1이 `speak`. 앞 표의 턴 내기를 따른다 | M1 판단 pass |
| 보류(`m1`) | 끝(턴 없음) | `quiet`, 판단 실패(`failed`), 판단을 부르지 못함(`not_called`: 예산·한도·모델 없음), 판단이 던짐. 보류한 글을 지운다 | M1 판단 pass |
| (받음), 열린 작업 | 기다림(`m1_to_task`, 판단 전) | 처리표가 `m1_to_task`를 낸다. 글을 판단 버퍼에 보류하고 판단을 연다. 이벤트는 2초 뒤 다시 보도록 미룬다 | slack 역할 inbox pass |
| (받음), 열린 작업 | 세션 턴 | `SLACK_ROLE_TASK_REPLY_WAIT_SEC`가 0이거나, 처리표가 `m1_to_task`를 내지 않거나(멈춤 낱말은 `stop_session`), 승인 전이거나, 들을 수 없는 사람의 글이거나, 버퍼 한도가 방금 보류한 글을 곧바로 밀어냈다(더 새 글이 버퍼를 채움). 한 번 보류됐던 글(`m1_to_task` 기록이 있다)은 다시 보류하지 않는다. 기다리는 사이나 판단 중 버퍼 한도에 밀린 글의 기록도 지우지 않고 `failed`로 끝내 둔다 | slack 역할 inbox pass |
| 기다림 | 기다림 | 판단이 아직 없고, 판단을 연 지 `SLACK_ROLE_TASK_REPLY_WAIT_SEC`(기본 30초)가 지나지 않았다. 다시 미룬다 | slack 역할 inbox pass |
| 기다림 | 기다림 | 판단 중 글(또는 그 맥락)이 고쳐지거나 지워져 판단이 무효가 됐다. 무효인 호출은 따로 `voided` 기록으로 남고, 답글은 보류한 `m1`처럼 고친 글로 한 번 더 판단한다(다른 호출 키). 그 판단도 무효면 판단하지 못한 것(`failed`)으로 끝난다. 상한은 처음 보류한 때부터 센다 | M1 판단 pass |
| 기다림 | 세션 턴 | `speak`, 판단 실패·부르지 못함·던짐(판단 기록이 `failed`·`not_called`로 끝나 보류한 행에 붙어 남는다), 상한을 넘어 난 `quiet`, 또는 기다림이 상한을 넘었다(끝나지 않은 판단을 `failed`/`timed_out`으로 끝내 포기한다). 세션의 턴이 보류한 행을 그 행의 글로 가져간다. 판단 중 글이 고쳐졌으면 고친 글이다 | slack 역할 inbox pass |
| 기다림 | 끝(세션 턴 없음) | 상한 안에 난 `quiet`(판단을 연 때 + 상한 안에 기록됨). 보류한 글을 지운다 | slack 역할 inbox pass |
| 기다림(작업이 그사이 `closing`·`closed`) | 청하지 않은 턴 | M1이 `speak`이고, 판단 pass가 볼 때(`heldWorkClosed`)와 턴을 쓸 때(`issueUnsolicitedTurnAtomic`) 모두 스레드의 작업이 닫혀 있고, 세션의 턴이 그 글을 가져가지 않았다. 앞 표의 턴 내기를 따른다. 등급은 처음 보류할 때의 `m1_to_task`다(닫힌 작업의 `m1`으로 다시 보류하지 않는다) | M1 판단 pass |
| 기다림(작업이 그사이 `closing`) | 기다림 | 세션으로 갈 답글(`speak`, 판단 실패·부르지 못함·던짐, 상한 넘김)이다. close가 실패해 작업이 열린 작업으로 돌아갈 수 있으므로 inbox는 이벤트를 끝내지 않고 5초 뒤 다시 본다(`SlackInboundDeferred`). 돌아가면 세션 턴, `closed`가 되면 아래 끝("work closing when M1 spoke, its close failing back before the unasked turn: ...") | slack 역할 inbox pass |
| 기다림(작업이 그사이 `closing`·`closed`) | 끝(턴 없음) | 청하지 않은 턴이 이미 답했거나(판단의 `turn_id`), 작업이 `closed`라 세션이 받지 못한다(`quiet`, 판단 실패·부르지 못함·던짐, 상한 넘김). 이벤트는 처리된 것으로 끝난다 | slack 역할 inbox pass |

막을 전이(괄호는 그 거절을 고정하는 시험, 따로 적지 않으면 `apps/control-host/src/slack/session-handler.integration.test.ts`의 "Slack replies in a work's thread once the rollout is on"):

- 한 글이 세션의 턴과 청하지 않은 턴을 둘 다 낳지 않는다. rollout `on`에서 닫힌 작업의 멘션 없는 답글은 세션에 가지 않는다("an unmentioned reply goes to no session; ..."). 세션의 턴이 가져간 글의 `m1` 판단은 `speak`여도 DB가 턴을 `duplicate`로 거절한다("one post, one answer: ...", `packages/db/src/conversations/unasked-turns.test.ts` "a closed work's reply its session took (m1) makes none"). `m1_to_task` 판단은 작업이 열려 있으면 청하지 않은 턴을 내지 않는다("its speak makes it the work's next turn"에서 speaker를 부르지 않음, "work open when M1 spoke: ..."). 기다리는 사이 작업이 닫혔으면 턴 하나를 내고, inbox는 판단의 `turn_id`를 보고 세션에 넣지 않는다("work %s while its reply waited ...: M1's speak answers it with one unasked turn, and the work takes nothing", "work closed when M1 spoke and open again before the reply is looked at: ..."). 판단하는 작업은 receive path가 그 글을 보류할 때 읽은 세션이다(판단의 `work_session_id`). 보류 직전에 그 링크가 닫히고 같은 스레드에 다른 작업이 붙었어도 그렇다. 그 칸이 비어 있는 예전 기록은 보류할 때까지 만든 스레드의 마지막 링크로 본다("... is judged by that work, not one the thread opened after it", `packages/db/src/conversations/unasked-turns.test.ts`의 "... is judged by the session it was held for, though the thread opened another before its hold"). 청하지 않은 턴이 답한 글은 세션이 가져가지 않는다: receive path는 rollout이 무엇이든, 보류 행이 버퍼에 남았든 아니든 그 글의 `m1_to_task` 판단에 `turn_id`가 있으면 이벤트를 끝낸다("a reply an unasked turn answered, its work open again and %s: the work takes nothing"). 세션 append도 같은 글로 판단을 찾아 있으면 되돌린다. append는 그 글의 출처 잠금을 먼저 잡으므로 아직 쓰는 중인 발행은 커밋된 뒤에 보인다("... is no session's turn, its held row gone since"). 작업이 다시 열렸거나 세션이 이미 가져간 글이면 DB가 `duplicate`로 거절한다(`packages/db/src/conversations/unasked-turns.test.ts`의 "a reply of work going on that spoke (m1_to_task) makes none", "a reply held for its work (m1_to_task), that work %s ...: one unasked turn").
- 닫힌 작업의 답글은 판단하지 못하면 세션에도 청하지 않은 턴에도 가지 않는다("M1 could not judge it (failed / budget_refused / throws): left unanswered, the work done").
- 닫힌 작업의 답글이 `quiet`이면 턴이 없다("kept quiet (no_reply): no turn of any kind").
- 열린 작업의 답글이 `quiet`이면 세션이 듣지 못한다("kept quiet: the work never hears it, and its held text goes").
- 멈춤 낱말은 판단을 기다리지 않는다("a stop word is no reply to judge: nothing waits for M1").
- `idle`·`stopped` 세션의 작업은 닫힌 작업으로 보지 않는다("idle work, admission active / stopped, is open (decision 35): ..."). `closeAtomic`이 drain으로 남긴 `closing`(닫기 receipt가 있다)도 SQL로 둔 `closing`과 같이 닫힌 작업이다("an unmentioned reply while its task drains for real: ..."). `closing`은 턴이 아직 돌아도 닫힌 작업이다("work closing (decision 35), its turn still running: ...", `packages/db/src/conversations/session-work.test.ts`).
- 봇을 멘션한 글은 M1 판단으로 가지 않는다("a mention of the agent is no reply for M1: ..."). 열린 작업이면 세션의 턴이 된다. `closing`·`closed` 작업의 링크가 열린 동안의 멘션은 링크가 닫히기를 기다렸다가 대화 턴이 된다("닫히는 작업 스레드의 멘션").
- `shadow`·`off`에서는 기다리지 않는다("rollout shadow / off: nothing waits, the work takes the reply as before"). rollout은 이벤트를 볼 때마다 다시 읽으므로, 기다리는 사이 `shadow`·`off`로 내리면 다음 봄에서 지금의 길(세션)로 간다. 그 전에 `quiet`이 났어도 그렇다.
- 보류한 행은 세션의 턴이 가져갈 때까지 판단 기록(끝났든 아니든)이 붙어 있어 채널의 M1 배치가 가져가지 않는다. 포기·판단 실패·편집 무효 어느 길에서도 기록을 떼지 않는다("M1 could not judge it (...): the work takes it anyway (PM Q2)", "a judgment that waited past its time is given up: ...", `packages/db/src/surface/m1-judgments.integration.test.ts` "a held reply of work going on edited while judged waits for its judgment again, its row kept").
- 상한을 넘어 난 `quiet`은 답글을 작업에서 떼지 못한다("a quiet M1 gave past the wait does not keep the reply from the work"). 판단의 `judged_at`은 잠금을 기다린 뒤 실제로 쓴 시각(`clock_timestamp()`)이다.
- 같은 claim 안에서 rollout을 내려도 `quiet`이 서지 않는다. 보류를 보는 transaction이 rollout을 다시 읽어(에이전트 행 `FOR SHARE`, 스위치는 `FOR UPDATE`) `on`이 아니면 지금의 길(세션)로 보낸다("a rollout lowered while a claim looks at its reply: ...").
- 기다리는 사이 버퍼 한도에 밀려 판단기가 기록을 먼저 끝내도(`failed`) 그 글은 다시 보류하지 않는다("a reply the buffer's limit took while it waited, its record ended by the judge, is not held again").
- 버퍼 한도에 곧바로 밀린 답글은 기다림을 다시 시작하지 않는다("a reply the buffer's limit takes at once goes to the work, with no wait left behind").
- 기다리는 사이 작업이 닫혀도 답글을 `m1`으로 다시 보류하지 않는다("work closed while its reply waited: the reply keeps its grade and is judged once").
- 기다리는 사이 밀린 글을 세션으로 보낸 뒤 그 append가 실패해 이벤트를 다시 봐도 다시 보류하지 않는다(기록을 `failed`로 끝내 둔다, "a reply evicted while it waits is sent to the work once: ..."). 판단 중 밀린 글의 판단이 맥락 삭제로 무효가 돼도 기록의 refs를 지우지 않는다(`packages/db/src/surface/m1-judgments.integration.test.ts` "a held reply of work going on evicted while judged keeps its record, ended, ...").
- 한 번 보류된 글은 다음 봄에서 그 보류가 답한다. 처음 보류할 때 한 검사(듣는 사람인지, 채널이 듣는지)를 다시 하지 않으므로 Slack이 그 순간 audience를 말하지 못해도 상한 안의 `quiet`이 선다(`packages/adapters/chat/slack/src/slack-thread-judgment.test.ts` "a reply held before answers by its hold, though Slack cannot say its audience now").
- 채널 종류를 말하지 않는 이벤트는 공개 채널로 묶인 채널이면 판단 전에 Slack에 종류를 묻는다. 비공개로 바뀌었으면 M1이 읽기 전에 지금의 길이 승인 대기로 보낸다("an event that does not say its channel turned private is not judged before the channel's kind is").
- 한 답글에 청하지 않은 턴은 하나다. 같은 글이 다른 이벤트로 다시 보류돼 `speak`이 나도 두 번째 턴은 `duplicate`로 거절한다(`packages/db/src/conversations/unasked-turns.test.ts` "a reply held again by a second event of it is answered once").
- 기다리는 사이 밀린 글의 기록을 끝내려다 판단기가 먼저 판정을 썼으면 그 판정을 다시 읽어 따른다(상한 안의 `quiet`이면 세션에 가지 않는다).
- 세션 턴은 `m1_to_task` 판단이 붙고 배치가 갖지 않은 보류 행만 가져간다. 배치가 가진 행은 버퍼에 남는다(`packages/db/src/conversations/unasked-turns.test.ts` "a post a batch holds stays the batch's when a session's turn takes it").

지킬 성질:

- 열린 작업의 답글은 판단하지 못해도 세션에 간다("M1 could not judge it (...): the work takes it anyway (PM Q2)"). 기다림이 상한을 넘으면 판단 실패로 보고 세션에 넣는다("a judgment that waited past its time is given up: ..."). 늦게 온 판단은 기록만 남고 답글의 길을 바꾸지 못한다.
- 기다리는 이벤트는 lease를 놓고 그 스레드를 비켜 세운다. 같은 채널의 다른 스레드는 계속 처리된다("the reply waits for M1, its thread aside; ...", `packages/db/src/surface/slack-inbound-claims.test.ts` "a deferred row is released to wait its time; ..."). 같은 스레드의 뒤 이벤트와, 스레드 키 없이 채널의 줄에 서는 이벤트(멤버·이름·보관)는 미룬 행이 끝날 때까지 기다린다(채널 규칙을 바꾸는 이벤트가 앞 글을 앞지르지 않게 하는 claim의 규칙). 그런 채널 전체 이벤트가 채널 줄의 맨 앞에 서면 그 뒤의 다른 스레드도 그 이벤트를 기다린다. 미룸은 시도 횟수를 쓰지 않아 최대 시도에 닿지 않는다(`packages/adapters/chat/slack/src/slack-inbox.test.ts` "a deferred event waits its time, released, and its waits spend no attempt").
- 상한은 판단을 연 시각부터 센다. 포기는 아직 끝나지 않은(`outcome` 없는) 판단만 `failed`로 끝내고, 0행이면 다시 읽어 같은 순간 기록된 판단을 따른다. 그 판단이 `quiet`이어도 상한을 넘어 기록됐으면 세션으로 간다.
- 보류·포기·`quiet`의 글 지움은 한 transaction에서 먼저 그 이벤트의 inbox 행을 lease와 함께 잡는다(`FOR UPDATE`, inbox 완료와 같은 순서). lease를 잃은 claim은 아무것도 쓰지 않고, 그 뒤 미룸이 claim 잃음으로 기록한다. 그래서 한 이벤트의 두 주인이 같은 글을 동시에 보류하거나 포기하지 않는다. 세션의 append는 이 transaction 밖이라 fence가 덮지 않는다(아래 한계). 보류는 그 뒤 에이전트(rollout·gate, binding) → 글 표시 → 주제 → 대화 → 입력 → 판단 → 채널 버퍼 한도 순이다. 글 표시를 주제보다 먼저 잡는 것은 세션의 append(세션 → 글 표시 → 주제)와 같은 순서다. 닫힌 작업의 보류(inbox 완료)는 청하지 않은 턴 발행·멘션 재시도와 같이 주제 → 글 표시 순이다. 발행은 교착에 끊기면 다시 하지 않으므로 그쪽과 순서를 맞췄다. lease를 잃은 예전 claim이 같은 글을 append하는 것과 맞물리면(`closing` → `active` 되돌림이 있어야 한다) PostgreSQL이 한쪽을 끊고, 끊긴 쪽(append 또는 inbox 완료)은 다시 시도된다. 포기는 판단 행만 잡는다.
- `speak` 뒤의 세션 턴은 보류한 행을 그대로 가져간다(입력 하나, 판단이 가리키는 행).
- 기다리는 사이 편집된 글은 고친 글로 세션에 간다. 푼 글이 이벤트의 처음 글과 같아도(글자로 친 `<@봇>`을 진짜 멘션으로 고친 편집) 행의 편집 시각으로 안다("an edit to a mention of a reply that wrote one out: ...").
- M1 채널 시간 상한(맞물린 스레드 판단과 배치를 센다)은 `m1`·`m1_to_task` 판단을 세지 않는다. 그 판단이 예산·동시 호출 한도로 부르지 못하면(`not_called`) 위 표의 실패 길을 탄다.
- 판단이 끝난 뒤 이벤트를 다시 보기까지 미룸 간격(2초)과 inbox pass 간격만큼 늦을 수 있고, M1 판단 pass가 도는 간격(기본 5초)도 기다림에 들어간다. 기본 상한 30초는 실측으로 정한 값이 아니다. 알려진 한계다.

알려진 한계(Codex 리뷰에서 나온 것, 이 PR 밖):

- 열린 작업이어도 세션의 admission이 `paused`·`stopped`면 세션 append가 이 PR 전과 같이 거절한다. 그 답글은 M1을 기다린 뒤 지금처럼 턴 없이 끝난다.
- `closing` 세션이 close 실패로 `active`로 돌아가고, 그 사이 lease를 잃은 예전 claim이 세션에 append하면 같은 글에 청하지 않은 턴과 세션 턴이 둘 다 날 수 있다. lease 만료, rollout 전환, close 실패가 겹쳐야 한다.
- 세션 없이 링크만 있는 스레드(여는 중이거나 열기 실패)의 답글은 이 길을 타지 않고 지금의 여는 길로 간다.
- 기다리는 사이 링크가 닫히면(`SLACK_ROLE_CLOSE_LINKS`) 다음 봄은 묶이지 않은 스레드의 길로 가서 턴 없이 끝난다. 보류한 행은 판단 기록이 붙어 있어 배치가 가져가지 않고, 버퍼 시간이 지나면 지워진다. 그 사이 글이 버퍼에서 밀렸고 최근 맞물린 스레드면, 묶이지 않은 길이 그 글을 `m1_engaged`로 다시 보류해 판단할 수 있다.
- lease를 잃은 예전 claim이 fence를 지난 뒤(또는 `shadow`일 때 이벤트를 읽고) 멈췄다 살아나 append하면, append는 fence 밖이라 판단이 나기 전이나 새 주인이 상한 안의 `quiet`을 본 뒤에도 그 답글을 세션에 넣을 수 있다. 닫힌 작업에서 두 종류 턴이 나려면 위 `closing` → `active` 되돌림이 있어야 한다. inbox의 at-least-once 처리는 이 PR 전과 같다.
- 보류한 글이 편집된 뒤 버퍼에서 밀리면 고친 글이 남지 않아, 세션은 이벤트의 처음 글을 받는다.
- 편집으로 고친 보류 글은 버퍼에 Slack 글자를 푼 채로 남는다. 그래서 세션에 넘길 때 그 안에서 봇 멘션을 벗기면, 글자로 친 `<@봇>`도 멘션으로 읽히고, 멘션의 표시 이름에 든 `>`에서 멘션이 끝난 것으로 읽힌다.
- 기다리는 사이 세션이 정상 종료되면(`closing`·`closed`) 등급은 `m1_to_task`로 남는다. `speak`이면 청하지 않은 턴이 답하지만, 판단 실패·부르지 못함·던짐이면 답하는 턴이 없다(닫힌 작업의 `m1`과 같다). M1이 `speak`할 때 작업이 열려 있었고 inbox가 다시 볼 때 `closed`면 턴 없이 끝난다.
- 청하지 않은 턴의 발행(토픽 `FOR KEY SHARE` → 글의 출처 잠금)과 세션 append(출처 잠금 → 토픽 `FOR UPDATE`)는 같은 글에서 잠금 순서가 반대다. close가 `active`로 돌아가는 순간 둘이 엇갈리면 PostgreSQL이 한쪽을 교착으로 끊고 남은 쪽이 턴 하나를 낸다. 발행이 끊기면 append가 세션 턴을 내고(판단은 턴 없이 남는다), append가 끊기면 다시 보는 inbox가 발행된 턴을 보고 끝낸다. 두 순서는 이 PR 전부터 있던 것이다.
- 같은 글이 다른 이벤트 ID로 다시 들어오고 그 사이 스레드가 새 작업에 다시 묶이면, 닫힌 작업의 판단과 새 작업의 세션이 한 글에 둘 다 답하거나, 새 보류와 청하지 않은 턴 발행이 교착할 수 있다(Slack은 한 앱에 한 글을 한 이벤트로 보내고, 재시도는 같은 이벤트 ID다).
- 버퍼 시간(10분)보다 오래 그 이벤트를 다시 보지 못하면(긴 장애) 예전 기록을 찾지 못해 다시 보류한다.
- 세션이 글을 넘겨받은 뒤(`{edited}`를 읽은 뒤 append 전) 온 편집은 세션에 가지 않는다. 세션이 바로 받은 글의 편집과 같다.

### mirror 스레드: 가리키는 작업

다른 스레드의 글을 열린 작업에 넘기면, 그 스레드(`task_thread_mirrors`의 한 줄, 스레드당 하나)가 그 작업을 가리킨다. 작업의 보고는 작업의 스레드에만 가고, mirror 스레드에는 "원래 스레드에서 이어서 할게요 ↗" 한 줄과 원래 스레드 링크만 간다. mirror 스레드에 또 글이 오면 대화가 다시 판단한다.

| 지금 상태 | 다음 상태 | 조건 | 누가 일으키나 |
| --- | --- | --- | --- |
| 줄 없음 | 작업 A를 가리킴(`rev` 1) | 그 스레드의 글이 작업 A로 넘어갔다. 안내 한 줄을 단다 | 넘기기 효과(같은 transaction) |
| 작업 A를 가리킴 | 작업 A를 가리킴 | 또 A로 넘어갔다. 안내를 달지 않는다 | 넘기기 효과 |
| 작업 A를 가리킴 | 작업 B를 가리킴(`rev` + 1) | B로 넘어갔다. 안내 한 줄을 단다 | 넘기기 효과 |
| 가리킴 | 줄 없음 | 가리키던 작업 세션이 지워졌다(외래 키 cascade) | 세션 삭제 |
| 그대로 | 그대로 | 입력이 들어간 뒤 끝을 쓰기 전에 대상 작업이 닫혔다(첫 턴 전 멈춤 등). 턴은 `routed`로 끝나지만 mirror 줄을 바꾸지 않고 안내도 달지 않는다. 끝을 쓰는 transaction은 세션 행을 잡고 열린 작업인지 다시 본다 | 넘기기 효과 |

지키는 성질:

- 안내는 가리키는 작업이 바뀔 때만 단다. A→B→A면 두 번 단다. 안내의 중복 키는 mirror 줄의 id와 `rev`라서 같은 바뀜에 두 번 달리지 않는다. cascade로 지워진 뒤 새로 생긴 줄은 id가 달라 `rev` 1부터 다시 안내한다.
- 줄 바꾸기와 안내 달기는 한 transaction이다. 두 글이 같은 작업으로 동시에 넘어가도 안내는 하나다(스레드의 유일 인덱스가 순서를 정한다).

## 4. rollout 스위치

에이전트의 `conversation_rollout`(`off`, `shadow`, `on`)이다. 바꾸는 길은 웹의 `POST /v1/agents/{id}/slack/notice/rollout`(워크스페이스 owner·admin, 웹 세션)과 운영자 명령 `slack-notice.ts set-rollout` 두 가지이고, 둘 다 `setConversationRollout`(`packages/db/src/surface/conversation-rollout.ts`)을 지난다. 바뀔 때마다 같은 transaction에서 `set_conversation_rollout` receipt를 하나 쓴다(`reason`은 null). 순서는 `off`→`shadow`→`on`이고, 지금은 `shadow`까지만 연다. shadow→on은 W1이 연다.

### 전이 표

| 지금 상태 | 다음 상태 | 조건 | 누가 일으키나 | 시험(`packages/db/src/surface/conversation-rollout.test.ts`) |
| --- | --- | --- | --- | --- |
| `off` | `shadow` | 없음. 고지 승인도 살아 있는 Slack 설치도 묻지 않는다 | owner·admin(웹), 운영자 CLI | "off → shadow needs no approval…", "off → shadow needs no live Slack install either" |
| `shadow` | `off` | 없음. 그 에이전트가 판단하려고 쥔 글을 모두 지운다. 판단 기록과 채널 요약은 남는다 | 같음 | "shadow → off empties the buffer and holds nothing new" |
| `on` | `shadow`, `off` | 없음(SQL로 `on`이 된 에이전트를 내리는 길) | 같음 | "on → shadow and on → off are taken, for a switch SQL left on" |
| `off`, `shadow` | 같은 값 | 바뀌지 않는다. receipt를 쓰지 않는다. `on`인 에이전트에 `on`을 주면 아래처럼 거절된다 | 같음 | "the value it holds changes nothing and writes no receipt" |

### 막을 전이

| 전이 | 거절 | 시험 |
| --- | --- | --- |
| `off` → `on` | 400 `BAD_REQUEST`, `rollout_on_unavailable`(CLI는 exit 4). 아무것도 바꾸지 않고 receipt도 쓰지 않는다 | "off → on is refused, from the web and the operator CLI, and changes nothing" |
| `shadow` → `on`, `on` → `on` | 같음. W1이 열 때까지 | "shadow → on is refused until W1 opens it"(`on` → `on`도 같은 시험) |
| 워크스페이스 owner·admin이 아닌 사람의 변경 | 403 `workspace_admin_required`(에이전트 admin도) | "owners and admins change it…" |

없앤 전이: 고지 승인 철회 → `off`, 다시 승인이 필요해짐(고지 판 바뀜, 승인한 Slack 팀이 설치에서 빠짐) → `off`. 둘 다 reconciler와 철회 경로가 스위치를 스스로 내리던 전이다. 이제 스위치는 사람이 바꿀 때만 바뀐다. 전에 쓰인 `by: reconciler` receipt는 그대로 읽힌다.

### 지킬 성질

- 대화 gate(`conversationGate`)는 스위치만 본다. `off`면 닫히고(`rollout_off`) `shadow`·`on`이면 열린다. 시험: "it follows the switch alone".
- 이 변경은 저장된 스위치 값을 바꾸지 않는다. `off`인 에이전트는 승인 줄이 있든 없든 배포 뒤에도 `off`로 남아 글을 쥐지 않고 채널 안내도 쓰지 않는다. 시험: "an agent at off, approved or not, stays off and does not listen".
- 승인이 서 있던 동안에는 세 길(올릴 때 판단, 철회, reconciler)이 승인 없는 에이전트의 스위치를 `off`로 두었다. 다만 gate는 바로 닫혀도 저장값은 reconciler가 내릴 때까지 올라가 있었다. 승인 없는 Slack 팀이 더해졌거나 살아 있는 설치가 없어졌는데 reconciler가 아직 내리지 못한 에이전트(다음 pass 전, dry-run, 실패)는 배포 뒤 gate가 열린다. 옛 gate가 닫은 것은 판단과 채널 안내뿐이고 버퍼에 담는 일은 저장값을 봤으므로, 기한이 남은 버퍼의 글도 판단된다. 설치와 듣는 채널이 있으면 새 글도 담긴다. 배포 바로 전에 `packages/db/src/surface/raised-without-notice-approval.sql`로 그런 에이전트를 찾는다. 쿼리와 배포 사이에 승인 충족이나 대상을 바꾸는 설치·연결·스위치 변경이 있으면 다시 돌린다. 옛 reconciler가 남아 있는 동안(배포 중, 되돌림) dry-run이 아닌 그 pass는 승인 없이 올라간 에이전트를 다시 보고 스위치를 `off`로 내리고 담긴 글을 지운다. 그래서 스위치는 옛 reconciler가 모두 내려간 뒤에 올린다. 설치가 없어 목록에 오른 에이전트는 gate가 열려도 설치가 되살아나기 전에는 글을 받지 않는다. 시험: "the pre-deploy check for raised agents the approval held closed".
- 승인된 `shadow` 에이전트는 `shadow`로 남아 계속 듣는다. 철회된 승인 줄은 스위치를 내리지 않는다. 시험: "an approved agent at shadow stays at shadow and keeps listening", "a revoked approval row neither closes the gate nor lowers a raised switch".
- 채널 안내(`slack_outbox`의 `channel_notice` 행)는 스위치가 올라간 에이전트가 '모든 글'을 듣는 적격 채널마다 승인 없이 한 번 쓴다. 같은 판으로는 다시 쓰지 않고, 다시 알리라는 고지 판이 오면 그 판에서 한 번 더 쓴다. 문구만 바뀐 판에는 쓰지 않는다. 전송이 확정 실패하면 같은 판으로 다른 키의 행을 다시 쓴다. 한 판의 행은 첫 시도를 포함해 5개까지다(다시 시도는 4번). 시험: `apps/control-host/src/slack/channel-notice.integration.test.ts`의 "an agent raised with no approval tells its channels as one approved did".
