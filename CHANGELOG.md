# 변경 기록

Werft를 설치하거나 올리는 사람이 릴리스마다 꼭 읽어야 하는 것만 적는다. 변경 목록 전체는 GitHub Release의 자동 생성 노트(`.github/release.yml`로 분류)에 있고, 이 파일에 옮겨 쓰지 않는다.

## 쓰는 방식

- 절은 두 가지만 쓴다. "보안"(수정한 취약점과 영향받는 버전)과 "운영자가 할 일"(올릴 때 직접 해야 하는 일. 안 하면 조용히 깨지는 변경이 먼저 온다). 해당 없는 절은 쓰지 않는다.
- 가장 위의 "미출시" 절에 쌓는다. 릴리스 태그를 만드는 사람이 그 절의 제목을 태그로 바꾸고, 새 "미출시" 절을 위에 더한다.
- 각 항목은 PR 링크(`JeongJaeSoon/werft#123`)를 붙이고 한국어로 서술한다.
- 이 파일은 사람이 쓴다. 태그가 있다고 전제하고 쓰지 않는다.
- `v0.1.1`·`v0.1.0` 절은 이 형식 이전에 쓴 것이라 다른 절(GitHub 작업, 게시 패키지 등)이 남아 있다.

## 미출시

### 보안

- **worker 안에서 실행된 명령이 launch nonce로 세션을 가로채거나, worker 이미지의 새 launch를 전부 막을 수 있었다**(JeongJaeSoon/werft#1626). `v0.1.0`부터 `v0.1.3`까지가 영향을 받는다. nonce(`WORKER_BOOTSTRAP_NONCE`)는 worker 컨테이너의 프로세스 환경에 있고, engine이 실행한 명령이 같은 사용자로 돌아 그 값을 읽을 수 있다. 그 값으로 claim을 다시 보내면 worker가 첫 호출을 하기 전(기본 5초 안)에는 세션의 credential이 그 명령에게 넘어갔다. claim에 다른 `image_runtime`을 적으면 시점과 무관하게 execution이 끝나고 worker 이미지가 거절 목록에 올라, 그 이미지로는 어떤 세션도 뜨지 않았다. 둘 다 nonce가 만료되기 전(발급 뒤 10분)에만 가능했다. 이제 worker는 claim 직후 heartbeat 하나를 보내 API가 받아들인 뒤에만 engine을 띄우고, API는 그 뒤에 온 claim을 `401`로 거절하며 아무것도 바꾸지 않는다. 이 경로로 거절 목록에 오른 이미지는 scheduler 로그의 `Worker image refused`로 알 수 있다. 이미지와 설정한 runtime이 실제로 맞는데 그 로그가 있으면 DB의 `worker_image_refusals`에서 그 이미지의 행을 지운다(`claimed` 열이 claim에 적힌 값이다). 이 표를 비우는 명령은 없다.

### 운영자가 할 일

- **`paused` 세션의 workspace volume(Docker volume, K8s PVC)도 TTL 뒤 회수된다. 새 설정 `EXECUTION_WORKSPACE_PAUSED_TTL_SEC`의 기본값은 86400(하루)이다**(JeongJaeSoon/werft#1655). 승인 대기로 park된 세션도 포함한다. resume이 받아들일 checkpoint가 있는 세션만 회수하고, resume하면 새 workspace에 그 checkpoint를 복원한다. migration `0273_paused_at`이 `sessions.paused_at`을 더한다. 이미 `paused`인 세션은 올린 뒤 회수 pass가 처음 본 시각부터 센다. 그래서 올린 직후 한꺼번에 지워지지 않는다. 회수 중에는 그 세션의 resume, parked 요청에 대한 답, 끝난 turn의 interrupt가 503 `BACKEND_UNAVAILABLE`(`Retry-After: 10`)로 거절되고 아무것도 기록되지 않는다. 같은 요청을 다시 보내면 된다. checkpoint 복원이 실패하면 전에는 volume에 남은 파일을 start_fresh가 쓸 수 있었지만, 회수된 세션에서는 빈 작업 디렉터리로 시작한다. paused volume을 더 오래 두려면 이 값을 늘린다(compose는 `infra/compose.core.yml`, Helm은 `scheduler.extraEnv`).
- **`SLACK_OIDC_REDIRECT_URI`·`SLACK_OIDC_CLIENT_ID`·`SLACK_OIDC_CLIENT_SECRET`을 더는 읽지 않는다. `CONSOLE_ORIGIN`이 없으면 Slack 계정 연결이 `503`이 된다**(JeongJaeSoon/werft#1684). `v0.1.2`에서 한 릴리스 동안 남긴 폴백(`CONSOLE_ORIGIN`이 없으면 `SLACK_OIDC_REDIRECT_URI`의 origin을 쓰던 것)을 없앴다. 그런 설치는 올리기 전에 API와 slack 역할에 `CONSOLE_ORIGIN`을 넣는다. 넣지 않으면 Slack 계정 연결이 `503`, Slack 앱 만들기가 거절되고, 저장한 이벤트 입구 주소(아래 항목)도 없으면 이벤트 구독이 등록되지 않는다(`events_url_unset`). 세 값은 env에서 지운다. Compose는 `infra/compose.core.yml`이 더는 넘기지 않는다. Kubernetes는 `api.extraEnv`·`slack.extraEnv`에서 지운다. 남아 있으면 API가 시작할 때 값 없이 `Ignored removed settings: <이름>` 경고를 한 번 남기고, 값은 쓰지 않는다([지운 Slack 연결 env](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/upgrade-compose#지운-slack-연결-env)).
- **Slack 이벤트 입구 주소는 env가 아니라 설정 > 연동 > Slack에서 owner가 저장한다. `SLACK_EVENTS_PUBLIC_URL`은 처음 뜰 때 한 번 옮겨 담고 그 뒤로는 읽지 않는다**(JeongJaeSoon/werft#PR_NUMBER). migration `0278_slack_settings`가 설치 전체에 하나인 `slack_settings` 표를 더한다. 이 표가 비어 있고 API 컨테이너에 그 값이 실제로 들어와 있으면 첫 기동이 값을 옮기고 값 없이 경고하며, 작성자 없는 감사 기록(`by: "env_import"`)을 남긴다. Compose의 `infra/compose.core.yml`은 이 값을 넘기지 않으므로, 설치 쪽 overlay나 Kubernetes `api.extraEnv`로 직접 넘긴 경우에만 옮겨진다. 그 밖에는 올린 뒤 화면에서 저장한다. 옮긴 뒤 env 줄을 지운다. 남아 있으면 시작할 때마다 `Ignored removed settings: SLACK_EVENTS_PUBLIC_URL` 경고가 나온다. https가 아니거나 query가 있는 값은 옮기지 않고 그렇다고 경고하며, 앞선 릴리스와 달리 시작을 멈추지 않는다. 비워 두면 `CONSOLE_ORIGIN`에서 계산한 주소를 쓴다. 주소를 바꾸면 이미 만든 앱은 에이전트의 Slack 탭에서 "다시 확인"으로 새 주소를 보낸다. 되돌릴 때 `slack_settings` 표는 지우지 않는다([웹으로 옮긴 Slack 이벤트 입구 주소](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/upgrade-compose#웹으로-옮긴-slack-이벤트-입구-주소)).
- **mock Slack 시험용 `SLACK_API_URL`·`SLACK_OIDC_ISSUER`는 `MOCK_SLACK_API_URL`·`MOCK_SLACK_OIDC_ISSUER`로 이름이 바뀌었다**(JeongJaeSoon/werft#PR_NUMBER). 옛 이름은 읽지 않고 `Ignored removed settings` 경고에 이름만 나온다. 새 이름에 값이 있으면 주소와 상관없이 시작할 때 `Mock Slack override in use: <이름>` 경고를 한 줄 남긴다(예전에는 주소가 Slack이 아닐 때만 경고했다). 운영 설정에는 두 이름 모두 두지 않는다([mock Slack env 이름](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/upgrade-compose#mock-slack-env-이름)).
- **worker 프로세스의 환경, 메모리, 메모리 지도, 열린 descriptor를 컨테이너 안에서 `/proc`으로 읽을 수 없다**(JeongJaeSoon/werft#1627). 명령행과 프로세스 이름은 전처럼 보인다. worker 프로세스가 시작할 때 자신을 non-dumpable로 만들어, engine이 실행한 명령이 worker 프로세스의 환경과 메모리를 읽지 못한다. 배포 요구(이미지 사용자, capability, `securityContext`)는 바뀌지 않는다. 바뀌는 것은 두 가지다. worker 프로세스를 `docker exec`이나 `kubectl exec`으로 들여다보는 절차(`strace`, `gdb`, `/proc/<pid>/` 보기)는 root이면서 `CAP_SYS_PTRACE`를 가진 프로세스로 바꾼다. Docker에서는 `docker exec --privileged -u 0`이다. Kubernetes에서는 worker 컨테이너를 대상으로 하고(`kubectl debug --target=<container>`) root와 `CAP_SYS_PTRACE`를 주는 debug 컨테이너가 필요하다. worker 프로세스는 core dump를 남기지 않는다. worker 이미지를 직접 만드는 곳은 glibc가 있는 이미지를 쓴다. worker는 libc의 `prctl`을 부르지 못하면 뜨지 않는다(`The worker cannot make itself unreadable to the engine`).
- **이번 릴리스는 control-host와 worker 이미지를 한 upgrade로 함께 올린다**(JeongJaeSoon/werft#1626, JeongJaeSoon/werft#1649). 프로필 제거 전에 빌드한 worker(`v0.1.3` 포함)는 새 control-host의 `bootstrap-claim` 응답을 읽지 못해 시작 직후 끝난다(`POST /bootstrap-claim answered a body this worker cannot read`). 세션은 세 번 launch한 뒤 `recovery_required`(`STARTUP_FAILED`)로 멈춘다. 그래서 업그레이드 문서의 "API 먼저, worker 나중" 순서(Compose의 중간 release, Kubernetes의 1단계)는 이번 릴리스에 적용하지 않는다. 그런 이미지는 지원 창에 들지 않으므로 `images.workerPrevious`에 따로 넣지 않는다. 다만 Kubernetes의 업그레이드 전 검사는 worker 이미지가 바뀌는 upgrade의 `images.workerPrevious`가 지금 배포된 이미지이기를 요구하므로, 업그레이드 문서의 `worker-previous.json`은 그대로 넘긴다. `0270`이 세션을 비우고 새 세션은 언제나 현재 이미지로 뜨므로, 그 이미지로 뜨는 세션은 없다([프로필 제거 릴리스의 업그레이드 순서](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/upgrade-compose#프로필-제거-릴리스의-업그레이드-순서)). 위 보안 수정도 둘 다 올려야 완전하다. API만 올리면 이전 worker가 첫 heartbeat 전에 engine을 띄울 수 있고, worker만 올리면 이전 API가 다른 `image_runtime`을 적은 claim을 계속 받는다.
- **실행 프로필을 없앴다. migration `0270_remove_profiles`가 프로필 데이터를 지운다.** 설치·워크스페이스 프로필 표, 세션·release·repository의 프로필 열과 설정 문서의 `profiles`가 지워지며 되살릴 수 없다. 세션과 그 아래 기록은 45개 표에서 비워지고(`provider_usage` 포함, `agent_usage`·`tool_call_audits`·에이전트는 남음), 세션이 없는 `slack_outbox` 행은 남긴다. 이 변경의 이전 초안(`0269_remove_profiles`)을 적용해 본 개발·verify DB는 새로 만든다. 올리기 전에 DB를 백업하고, 되돌리려면 그 백업으로 복원한다([업그레이드](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/upgrade-compose)).
  - release는 provider 연결 하나와 카드 모델을 고른다. 런타임 spec은 release에 고정된다: 연결 종류의 런타임을 이미지의 버전으로, 내장 도구 전부, 연결의 분류기가 되면 `auto`, 안 되면 `default` 모드. 이 버전 이전의 release로 만든 세션은 spec을 만들 수 없으면 `RELEASE_SPEC_UNAVAILABLE`로 거절된다. 그 에이전트는 다시 release한다.
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
- **Google 로그인은 웹 관리 화면에서 공급자로 다시 등록한다. `GOOGLE_OIDC_*` 환경 변수는 더는 읽지 않는다**(JeongJaeSoon/werft#1666). 로그인 공급자가 환경 변수가 아니라 DB의 설정 행(`login_providers`)이 됐다. 옛 설정을 자동으로 옮기지 않는다. 올리면 환경 변수로 켜 둔 Google 로그인은 꺼지고 로그인 화면에는 비밀번호만 남는다. Google로만 로그인하던 사용자는 owner가 공급자를 다시 등록할 때까지 새로 로그인할 수 없다. 이미 로그인해 있는 세션은 만료될 때까지 쓸 수 있다. 사용자와 Google 계정의 연결(`login_methods`)은 남으므로, 같은 issuer(`https://accounts.google.com`)로 다시 등록하면 같은 계정으로 들어온다. 비밀번호 로그인은 그대로다.
  - **공급자를 등록하는 관리 화면은 이 변경에 없고 뒤따르는 변경에 들어온다.** 이 변경만 들어간 `main`에는 공급자를 만드는 화면도 API도 없다. Google 로그인을 쓰는 설치는 관리 화면이 들어간 릴리스로 올린다. 그 전의 `main`을 올리면 비밀번호 로그인만 쓸 수 있다.
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
  - 비밀번호 로그인은 로그인한 owner가 `PATCH /v1/login-settings`(`{"password_login": "emergency_only"}`)로 닫는다. 켜진 공급자가 있고, 비상 관리자가 비밀번호로 들어올 수 있고, 닫는 owner 자신이 비상 관리자이거나 켜진 공급자의 계정을 연결해 뒀을 때만 된다. 닫으면 비상 관리자를 뺀 모든 사람의 비밀번호 세션이 끊기고, 그 뒤로 비상 관리자가 아닌 사람의 비밀번호 로그인(`401`), 초대의 비밀번호 수락(`403`, 비상 관리자의 초대도 같다), 비상 관리자가 아닌 사람 앞으로 owner가 내는 재설정 링크(`409`), 켜진 마지막 공급자 끄기(`409`)가 거절된다. 닫힌 동안의 로그인과 초대 수락은 비밀번호가 맞든 틀리든 같은 답으로 끝난다. 닫는 화면은 이 변경에 없고 뒤따르는 변경에 들어온다.
  - 로그인이 망가졌을 때의 복구 명령 `apps/control-host/src/api/login-recovery.ts`가 들어왔다(`status`, `enable-password`, `disable-provider`, `reset-password`). API 컨테이너에서 `DATABASE_URL`만으로 돈다. `reset-password`는 token을 stdout에 그대로 낸다. 로그에 남기지 않는다. 명령, 종료 코드, 닫힌 동안의 거절은 `docs/operator/api-server.md`의 "비밀번호 로그인 끄기, 비상 관리자, 복구" 절에 있다.
  - API가 바뀐다. `GET`·`PATCH /v1/login-settings`가 생긴다. 공개 `GET /v1/auth/login-methods`의 `password`는 `on` 말고 `emergency_only`도 된다. `POST /v1/users/{user_id}/disable`과 `POST /v1/workspaces/{id}/members/{userId}/password-reset`이 `409`를, `POST /v1/login-providers/{id}/disable`이 `409`(`last_provider`)를 답할 수 있다. 새로 요구하는 환경 변수나 권한은 없다.
  - 로그인 실패 횟수를 지우는 때가 바뀐다(비밀번호 로그인을 닫지 않은 설치도). 전에는 비밀번호가 맞으면 바로 지웠고, 이제 세션이 만들어진 뒤(초대는 수락이 끝난 뒤)에 지운다. 비밀번호를 확인한 뒤 그 사이에 계정이 꺼지거나 비밀번호가 바뀌어 거절된 시도는 실패로 세어진 채 남는다. 저장소 장애(`503`)는 전과 같이 세지 않는다. 할 일은 없다.
  - 비밀번호 로그인의 때가 그 사람의 로그인 수단에 적힌다(`GET /v1/auth/me/login-methods`의 비밀번호 항목 `last_login_at`). 전에는 공급자 로그인만 적혔다. 올리기 전부터 쓰던 비밀번호는 다음 비밀번호 로그인까지 비어 있다.
  - 옛 버전으로 되돌릴 수 있다. 옛 코드는 `login_settings`를 읽지 않으므로, 되돌리면 비밀번호 로그인이 닫혀 있던 설치도 모두에게 다시 열린다. 복구 명령으로 낸 재설정 token 가운데 쓰지 않은 것은 되돌리기 전에 지운다(`DELETE FROM password_resets WHERE issued_by IS NULL AND used_at IS NULL`). 완전히 걷어내려면 그 뒤 `DROP TABLE login_settings`를 돌리고, `password_resets.issued_by`가 NULL인 행이 없을 때 `ALTER TABLE password_resets ALTER COLUMN issued_by SET NOT NULL`을 돌린다.
- **parked 요청이 수천 개인 승인 대기 그룹이 닫힌다**(JeongJaeSoon/werft#1650). 전에는 약 3,000개를 넘으면 이어 갈 turn의 메시지가 32 KiB를 넘어 그룹을 닫는 transaction이 되돌려졌고, 답은 저장된 채 turn이 이어지지 않았다. 이제 메시지에는 들어가는 만큼의 답이 그대로 실리고, 나머지는 마지막 줄 `… N more answers cut`으로 센다. 그보다 작은 그룹의 메시지는 바뀌지 않는다. 할 일은 없다.
- **release 메모(`note`)를 없앴다. `POST /v1/agents/{id}/releases`에 `note`를 보내면 400이다**(JeongJaeSoon/werft#1690). 값이 `null`이어도 거절한다. release를 담은 응답(release 생성, 에이전트 상세의 `releases`·`active_release` 등)에도 `note`가 없다. release를 만드는 스크립트·클라이언트에서 `note`를 빼고, 응답의 `note`를 읽던 곳을 고친다. 이미 남긴 메모는 DB의 `agent_releases.note`에 남지만 API로는 읽을 수 없다. 이 열은 지원 창의 이전 릴리스가 아직 읽으므로 이번에 지우지 않고, 두 릴리스 뒤의 migration이 지운다.
- **세션 목록 `GET /v1/sessions`의 항목과 세션 상세 `GET /v1/sessions/{id}`에 `activity`가 없다**(JeongJaeSoon/werft#1693). 세션의 최근 이벤트 500개를 요약하던 객체(`last`, `tool_count`, `error_count`, `subagent_count`, `current_tool`, `window`)다. 웹 콘솔은 에이전트 지도를 지운 뒤 이 값을 읽지 않는다. 이 값을 읽던 스크립트·클라이언트는 고친다. 세션 이벤트는 `GET /v1/sessions/{id}/events`로 전처럼 읽을 수 있다. migration은 없다.

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
