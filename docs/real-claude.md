# 실제 Claude로 확인하기

로컬 스택의 기본은 실제 Messages API다. [quickstart](quickstart.md)는 결정적인 대본과 무료 CI를 위해 `--fake-model`로 띄우고, 이 문서는 기본 경로를 쓰는 방법 둘을 다룬다.

- **A. 유료 e2e 한 번**: `tests/e2e/run.sh --real-model`. 스택을 띄우고 정해진 시나리오를 돌린 뒤 스스로 지운다.
- **B. 직접 대화**: `scripts/local.sh up`. 스택을 띄워 두고 curl로 자유 문장을 보낸다.

둘 다 같은 기본 설정 문서(`tests/fixtures/settings/real-model.json`)와 비용 상한 overlay(`infra/compose.real-model.yml`)를 쓴다. 필요한 것은 **실행하는 사람 본인의 Anthropic API key** 하나다. B는 key를 콘솔의 모델 연결 화면에 넣는 것이 기본이고, 환경 변수로 주는 것은 대안이다. A는 사람이 화면을 만지지 않는 시험이라 환경 변수로만 받는다. AWS 계정은 필요 없다(S3는 named volume에 저장하는 SeaweedFS다. 기본 설정 문서는 Secrets Manager를 쓰지 않아 `secrets`는 뜨지 않는다). 유료 호출이므로 CI에서는 돌지 않는다.

준비물은 [quickstart 0장](quickstart.md#0-준비물)과 같고, Docker Compose는 **2.24.6 이상**이어야 한다(`include`로 합친 스택 위에 overlay를 겹친다). B는 quickstart 2장의 curl 헬퍼를 쓴다.

## 기본 스택이 쓰는 것

- migrate가 `tests/fixtures/settings/real-model.json`을 가져온다. 연결은 `https://api.anthropic.com`을 부르는 `anthropic` 하나이고, 그 모델 목록에 `claude-sonnet-5`가 있다. 이 문서에는 fake를 가리키는 연결이 없다. fake 문서(`fake-model.json`)는 `--fake-model` overlay를 얹을 때만 가져온다.
- key의 기본 경로는 콘솔이다. B는 key 없이 뜨고, 설정 > 에이전트 연결 > 모델 연결 > 연결 추가에서 넣은 key가 DB에 봉인돼 저장된다. 환경 변수는 대안이다. 셸의 `ANTHROPIC_API_KEY`(없으면 저장소 `.env`의 그 줄)가 있으면 **API 컨테이너에만** 이름으로 전달되고(`infra/compose.local.yml`), 설정 문서의 `value_env`가 그 값을 읽는다. 추적되는 compose 파일과 명령 인자 어디에도 값이 없다. worker는 attempt 범위의 egress token만 받고, egress proxy가 `api.anthropic.com:443`(기본 `EGRESS_CREDENTIAL_ALLOWLIST`)으로 나가는 요청에 key를 붙인다.
- 상한: `infra/compose.real-model.yml`이 기본으로 `SESSION_COST_LIMIT_USD=1`(세션당 1달러), `MAX_TURN_SECONDS=600`(turn당 600초)을 건다. A와 B가 같은 값을 쓴다. 올리려면 같은 이름의 변수를 셸에 export한다. B(`local.sh up`)는 저장소 `.env`에 적은 값도 읽는다. `local.sh`를 거치지 않고 `docker compose up`으로 띄우면 이 overlay가 없으므로 core 기본값(세션당 25달러, turn당 3600초)이다.

`ANTHROPIC_API_KEY`가 셸과 `.env` 어디에도 없거나 비어 있을 때 `run.sh --real-model`(A)은 Docker를 건드리기 전에 exit 2로 끝난다. `local.sh up`(B)은 뜨되, 모델 연결 없이 뜬다고 알리고 화면 경로를 한 줄로 알려 준다. 어느 쪽도 fake로 대신 뜨지 않는다. 연결에 key가 없는 동안 그 연결의 release로 세션을 만들면 화면 경로를 알려 주는 오류로 거절된다. 연결을 넣으면 쓸 수 있게 된다. `.env`의 key 줄 따옴표가 깨졌으면 B도 exit 2로 끝난다. fake로 돌리려면 `--fake-model`을 명시한다.

## key 입력과 폐기

이 용도로 쓸 **전용 key**를 만들고 Console에서 workspace 지출 한도를 걸어 두기를 권한다. 상한은 세션마다 따로 걸리므로 세션을 여러 개 만들면 합계는 상한보다 커질 수 있다.

**B의 기본 경로는 화면이다.** `scripts/local.sh up`을 key 없이 실행한 뒤(아래 B의 1단계), 콘솔에 owner로 로그인해 **설정 > 에이전트 연결 > 모델 연결**에서 **연결 추가**를 누른다. 종류는 `anthropic`, 주소는 기본값(`https://api.anthropic.com`)을 두고 key를 붙여 넣어 저장한다. key는 DB에 봉인돼 저장되고 화면에는 끝 네 글자만 보인다. 셸 history, 프로세스 목록, 컨테이너 설정에 key가 남지 않는다. 이미 `value_env` 연결이 있으면 같은 화면에서 key를 넣어 저장형으로 바꾼다. 저장한 key는 그 화면에서 교체하거나 지우고, 스택을 `down`하면 DB와 함께 사라진다.

**대안: 환경 변수.** A는 환경 변수로만 받고, B도 화면을 거치지 않으려면 환경 변수로 줄 수 있다. 셸 history에 남지 않도록 `read -rs`로 입력받는다.

```sh
printf 'Anthropic API key: '
read -rs ANTHROPIC_API_KEY
echo
```

- 명령을 실행한 뒤에는 `unset ANTHROPIC_API_KEY`로 셸에서 지운다. B는 `up`이 끝나면 key가 이미 API 컨테이너에 넘어가 있으므로 바로 지워도 된다.
- 스택이 떠 있는 동안에는 API 컨테이너 설정(`docker inspect`)에 key가 있다. 다 쓰면 스택을 내린다(A는 스스로, B는 `scripts/local.sh down`).
- 다 쓴 key는 Console의 API Keys에서 비활성화하거나 삭제한다.

환경 변수로 매번 입력하지 않으려면 `.env.example`을 복사한 `.env`의 `ANTHROPIC_API_KEY=` 줄에 값을 적는다. `.env`는 git과 이미지 빌드가 무시한다. 두 명령은 셸에 export된 값이 없을 때만 이 한 줄을 읽고, `.env`의 다른 값은 가져오지 않는다. 다른 파일을 쓰려면 `AGENT_PLATFORM_DOTENV`에 그 경로를 준다. 값은 `.env.example`에 적지 않는다(추적되는 파일이고 저장소는 public이다). 디스크에 평문으로 남으므로 다 쓰면 그 줄을 비운다.

## A. 명령 하나로 real-model e2e

```sh
export ANTHROPIC_API_KEY
tests/e2e/run.sh --real-model
unset ANTHROPIC_API_KEY
```

`run.sh`는 평소 e2e와 같은 스택을 자기 compose project와 루프백 임시 포트로 띄우되 fake overlay 대신 비용 상한 overlay를 얹고, 스크립트된 스위트 대신 `tests/e2e/real-model.e2e.ts`를 돈다. 끝나면 자기가 만든 것을 모두 지운다. 1장 스택과 겹치지 않는다.

**무엇을 확인하나.** 모델의 문장은 보지 않는다. 도구 결과(저장소 상태)와 플랫폼 기록을 본다.

1. turn 1: 샘플 저장소에 파일을 만들고 커밋한다. 권한 요청은 테스트가 허용한다.
2. turn 2: 같은 worker에서 `git log`와 `cat`으로 그 커밋을 읽는다.
3. pause: checkpoint가 turn 2까지 덮는다.
4. resume 후 turn 3: 새 worker(turn 1과 겹치는 attempt 없음)에서 같은 커밋 hash와 파일 내용이 나오고, Claude Code 세션 id가 turn 1과 같다.
5. `GET /v1/sessions/{id}/usage`: 세 turn 모두 비용을 보고했고(`complete: true`) 금액이 0보다 크며 상한을 넘지 않았다. key로 부른 `GET /v1/limits`는 owner 전용이라 403이다.

run record(`E2E_OUT`, 끝에 경로를 출력한다)의 `record.txt`에는 tested SHA, 이미지 id, SDK·Claude Code 버전과 함께 `model`, `provider_endpoint`, `session_cost_limit_usd`가 남는다. `test.log`에는 세션 id, 커밋, attempt, 실제 비용을 담은 `real_model` JSON 한 줄이 남는다. 성공하면 `tests: pass=1 skip=0 fail=0`이다.

`run.sh`는 끝날 때 `E2E_OUT` 전체(compose 로그, 모든 worker 로그, run record, 테스트 출력)에서 key 값을 찾는다. 하나라도 나오면 파일 이름만 출력하고 실행을 실패시킨다. key 값은 어떤 로그에도 출력되지 않는다. `E2E_KEEP=1`로 스택을 남겼다면 끝에 출력되는 `kept: compose project <project>, installation <installation>`의 두 값으로 직접 지운다. scheduler가 만든 worker 컨테이너·네트워크·workspace volume은 compose 소유가 아니므로 label로 지우고, run.sh가 tag를 붙인 이미지 셋은 이름으로 지운다.

```sh
P='e2e-123456789'; I='e2e123456789'   # kept: 줄의 project와 installation 값으로 바꾼다
docker compose -p "$P" -f infra/compose.yml -f tests/e2e/compose.yml \
  -f infra/compose.real-model.yml --profile apps down -v --remove-orphans --rmi local
docker ps -aq --filter "label=werft.installation=$I" | xargs -r docker rm -f
docker network ls -q --filter "label=werft.installation=$I" | xargs -r docker network rm
docker volume ls -q --filter "label=werft.installation=$I" | xargs -r docker volume rm
docker image rm "werft-control-host:$P" "werft-worker:$P" "werft-egress-proxy:$P"
```

## B. 실제 Claude와 직접 대화하기

스택을 띄워 두고 대본 없이 자유 문장을 보낸다. quickstart의 `--fake-model` 스택과 같은 project(`werft`)와 포트를 쓰므로 둘을 동시에 띄울 수 없다. fake 스택이 떠 있을 때 `up`을 실행해도 DB는 그대로이고 설정 문서의 연결만 더해진다. 에이전트는 그 연결로 다시 release해야 실제 Claude로 돈다. 처음부터 하려면 `up` 대신 `scripts/local.sh reset`을 쓴다(기존 세션과 데이터가 지워진다).

**1. 스택 띄우기와 key 넣기.** key 없이 띄운다. 화면 경로를 알리는 한 줄이 나온다.

```sh
scripts/local.sh up
KEY=$(scripts/local.sh key real-claude \
  --scopes sessions:read,sessions:write,sessions:approve,sessions:control,sessions:recover)
echo "${KEY:0:12}…"
```

`up`은 quickstart 1장과 같이 `/readyz`가 ready가 될 때까지 기다린 뒤 끝난다. 그다음 [key 입력과 폐기](#key-입력과-폐기)의 화면 경로로 key를 넣는다. 환경 변수로 주려면 그 절의 `read -rs` 세 줄 뒤에 `export ANTHROPIC_API_KEY`를 하고 `scripts/local.sh up`을 실행한다.

**2. 헬퍼 설정.** [quickstart 2장](quickstart.md#2-curl-준비)의 블록을 같은 터미널에 그대로 붙여 넣은 다음, 세션을 만드는 `body`는 그대로 두고, `anthropic` 연결로 만든 release id를 `WERFT_AGENT_RELEASE_ID`에 넣는다.

```sh
export WERFT_AGENT_RELEASE_ID='<anthropic 연결로 만든 release id>'
```

**3. 대화 시작.** 샘플 저장소에는 제목 한 줄짜리 `README.md`뿐이라 요약을 시키면 "내용이 없다"는 답이 온다. 파일을 만드는 요청으로 시작한다.

```sh
created=$(post /v1/sessions "$(body 'hello.py에 인사를 출력하는 스크립트를 만들고, README에 실행 방법을 적은 뒤 커밋해 주세요')")
echo "$created" | jq .
SID=$(echo "$created" | jq -r .session_id)
```

`anthropic` 연결로 만든 release는 `auto` 모드라, 사람에게 물었을 도구 호출(Bash 등)마다 모델 분류기가 허용·거부를 정한다. 그래서 보통은 권한 요청 없이 끝나고, 거부된 호출이 있었는지는 이벤트 스트림의 `tool_result`에서 본다. 분류기를 쓸 수 없으면 그 호출은 거부된다(fail closed). 모델이 `AskUserQuestion`으로 물으면 요청이 오고 세션이 `needs_input`이 된다. quickstart ③·④와 같은 방법으로 답한다. `default` 모드로 돌던 2026-09-29 실측에서는 `Write`(hello.py), `Edit`(README.md), `Bash`(`git add … && git commit …`) 권한 요청 세 개가 이 순서로 한 번에 하나씩 왔다. 모델이 생성하는 도구 요청에 따라 개수와 순서가 달라질 수 있고 여러 권한 요청이 동시에 대기할 수도 있다. 권한 요청 자체는 30분 뒤에 만료되지만 이 overlay는 turn을 600초로 제한하므로, turn이 시작된 뒤 10분 안에 모두 답해야 한다.

아래 `allow_until_done`은 turn이 끝날(`completed`·`failed`·`interrupted`·`cancelled`·`outcome_unknown`) 때까지 3초마다 보고, 세션이 `needs_input`이면 첫 권한 요청을 출력한 뒤 허용한다. 동시에 여러 요청이 대기하면 한 회차에 첫 요청 하나를 답하고, 남은 요청으로 세션이 `needs_input`인 동안 다음 회차를 계속한다. turn 제한과 같은 10분(200번)이 지나면 멈춘다. 허용하기 전에 보려면 이 루프 대신 quickstart ③·④의 명령을 한 번씩 되풀이한다.

```sh
allow_until_done() {
  for _ in $(seq 1 200); do
    case "$(get "/v1/sessions/$SID/turns/$1" | jq -r .status)" in
      completed | failed | interrupted | cancelled | outcome_unknown)
        get "/v1/sessions/$SID/turns/$1" | jq '{status, result}'
        return 0 ;;
    esac
    if [ "$(get "/v1/sessions/$SID" | jq -r .status)" = needs_input ]; then
      req=$(get "/v1/sessions/$SID/pending-requests" |
        jq -c 'first(.items[] | select(.kind == "permission")) | {request_id, tool, input}')
      if [ -n "$req" ]; then
        echo "$req"
        post "/v1/sessions/$SID/answers" "$(echo "$req" | jq -c '{request_id, kind:"permission", action:"allow"}')" | jq -c .
      fi
    fi
    sleep 3
  done
  echo "turn $1 did not finish in 600s" >&2; return 1
}
allow_until_done 1
```

대화 흐름을 보려면 다른 터미널에서 이벤트 스트림을 연다(Ctrl-C로 닫는다): `curl -sSN "$API/v1/sessions/$SID/events" -H "Authorization: Bearer $KEY"`.

커밋 작성자는 워커 이미지의 기본값 `Werft <noreply@werft.invalid>`다. 그래서 요청에 git 사용자 이름과 이메일을 적지 않아도 Claude가 커밋한다. worker에서는 push를 지원하지 않으므로 fake-git(`http://127.0.0.1:3001`)의 `agent/sample-app`에는 `initial` 커밋만 남는다. 커밋은 worker의 작업 트리와 checkpoint에 있고, 4단계처럼 후속 메시지로 hash를 물어 확인한다.

**4. pause → resume 뒤 이어서 대화.** turn이 끝나 세션이 `idle`이 되면 quickstart ⑦·⑧과 같이 멈췄다 되살린다. 새 worker가 checkpoint에서 저장소와 Claude Code 세션을 복원하므로 앞의 대화를 기억한다.

```sh
wait_for "/v1/sessions/$SID" .status idle
post "/v1/sessions/$SID/pause" "$(jq -nc --argjson r "$(revision)" '{expected_revision:$r, reason:"real-claude"}')" | jq .
wait_for "/v1/sessions/$SID" .admission_state paused
post "/v1/sessions/$SID/resume" "$(jq -nc --argjson r "$(revision)" '{expected_revision:$r}')" | jq .
wait_for "/v1/sessions/$SID" .admission_state active
post "/v1/sessions/$SID/messages" "$(say '방금 만든 커밋의 hash와 hello.py 내용을 알려 주세요')" | jq .
wait_for "/v1/sessions/$SID/turns/2" .status completed
curl -sSN --max-time 5 "$API/v1/sessions/$SID/events" -H "Authorization: Bearer $KEY" \
  >/tmp/real-claude-events.txt || true
sed -n 's/^data: *//p' /tmp/real-claude-events.txt |
  jq -r 'select(.turn_id == "2" and .data.type == "assistant") | .data.message.content[]? | select(.type == "text") | .text'
```

turn 조회 결과(`result`)에는 답 문장이 없다. 답은 이벤트 스트림의 `assistant` 이벤트에 있으므로, 마지막 두 줄이 스트림을 처음부터 읽어 turn 2의 text만 뽑는다(`curl: (28)`은 quickstart ②와 같이 정상이다). 이 식은 Claude adapter의 native message shape을 읽으며 public contract는 `message` 내부 구조를 고정하지 않는다. 실측에서는 커밋 hash와 `print("안녕하세요!")`가 나왔다.

후속 메시지는 모두 `post "/v1/sessions/$SID/messages" "$(say '…')"`로 보낸다. 응답의 `turn_id`로 위 두 줄의 `2`를 바꾸고, 권한 요청이 오는 요청이면 `wait_for` 대신 `allow_until_done <turn_id>`를 쓴다. 지금까지 든 비용은 `get "/v1/sessions/$SID/usage" | jq .`로 본다.

**5. 정리.**

```sh
scripts/local.sh down
```

스택과 모든 데이터(세션, checkpoint, API key)를 지운다. 화면에서 넣은 모델 key는 DB에 있으므로 함께 사라지고, 환경 변수로 준 key를 가진 API 컨테이너도 이때 사라진다. 마지막으로 Console에서 key를 비활성화한다.

## 자율 모드 세션

승인 없이 끝까지 도는 세션은 자율 모드로 돈다. 켜는 조건과 남는 경계는 [api-server.md](operator/api-server.md#자율-모드-bypasspermissionsauto)의 '자율 모드' 절에 있다. 판정하지 않은 Anthropic 연결로 만든 release는 분류기가 판정하는 `auto`로 돌고 설치 설정도 필요 없다. 판정 없이 도는 `bypassPermissions`는 새 release가 고르지 않는다. 2단계 헬퍼를 붙여 넣은 뒤 이어서 실행한다.

```sh
created=$(post /v1/sessions "$(body 'hello.py에 "안녕하세요"를 출력하는 파이썬 스크립트를 만들고, python3 hello.py로 실행해 출력을 확인한 뒤 git add와 git commit까지 해 주세요. 끝나면 커밋 hash를 알려 주세요.')")
SID=$(echo "$created" | jq -r .session_id)
wait_for "/v1/sessions/$SID/turns/1" .status completed
get "/v1/sessions/$SID" | jq -c '{status, runtime, pending_request_count}'
get "/v1/sessions/$SID/usage" | jq -r .cost.amount_usd
```

세션 상세의 `runtime.permission_mode`가 `auto`이고 `pending_request_count`가 0이다. 2026-10 실측에서 `auto`는 Bash 호출마다 분류기 요청(입력 약 4만3천 토큰)이 하나씩 더 나가서 비용은 약 0.15달러였다. 분류기 판정이 바뀔 수 있으므로 거부된 호출이 있었는지는 이벤트 스트림의 `tool_result`에서 본다. 무엇을 묻고 막을지는 워크스페이스와 에이전트의 실행 규칙으로 더 좁힌다.

## 비용

Sonnet 5 기준(100만 토큰당 입력 2달러, 출력 10달러, 캐시 쓰기 2.5달러, 캐시 읽기 0.2달러) 추정치다. Claude Code 요청 하나는 system prompt와 도구 정의로 약 2만5천 토큰이다.

- A는 turn 세 개에 모델 호출이 10번 안팎이다. 캐시가 맞으면 한 번 실행에 약 0.2달러이고, 캐시가 전혀 맞지 않아도 0.6달러를 넘지 않을 것으로 본다. 이미지 빌드까지 합쳐 처음에는 10분 남짓 걸린다.
- B는 보내는 메시지만큼 든다. 위 예시(turn 두 개)는 A와 비슷한 규모다.
- 상한은 기본 세션당 1달러다(위 [상한](#기본-스택이-쓰는-것)대로 올릴 수 있다). SDK가 호출이 끝날 때마다 누적 비용을 확인하므로 마지막 호출 하나만큼은 넘을 수 있다. 넘으면 그 turn이 `budget_exceeded`로 실패한다. B에서는 새 세션을 만들면 다시 1달러가 생긴다.

실제로 든 비용은 A는 `test.log`의 `cost_usd`, B는 세션의 `usage`에 있다. 둘 다 egress proxy가 계측한 usage를 플랫폼 가격표로 환산한 추정치다. 청구액은 Console에서 확인한다.

## 막혔을 때

| 증상 | 원인과 조치 |
|---|---|
| `run.sh --real-model`이 바로 exit 2로 끝난다 | A는 환경 변수로만 key를 받는다. `ANTHROPIC_API_KEY`가 셸에도 `.env`에도 없거나 비었다. [key 입력](#key-입력과-폐기)의 `read -rs` 세 줄과 `export ANTHROPIC_API_KEY`를 같은 셸에서 한 뒤 다시 실행한다 |
| `local.sh up`이 `invalid ANTHROPIC_API_KEY quoting`으로 exit 2로 끝난다 | `.env`의 key 줄 따옴표가 한쪽만 있다. 따옴표를 맞추거나 그 줄을 지우고(key는 화면으로 넣는다) 다시 실행한다 |
| 세션이 `connection_missing`(연결 없음)이거나 모델 key를 넣으라는 오류로 거절된다 | 모델 연결에 key가 없다. 설정 > 에이전트 연결 > 모델 연결 > 연결 추가에서 넣는다 |
| `local.sh up`이 `docker compose … is too old; … is an overlay on compose.yaml's include`로 끝난다 | Docker Compose가 2.24.6보다 낮다. 2.24.0–2.24.5는 `include` 위의 overlay를 `conflicts with imported resource`로 거부한다. compose를 올린다 |
| turn이 `budget_exceeded`로 실패한다 | 세션 비용이 1달러 상한을 넘었다. 새 세션을 만든다 |
| 그 밖의 증상 | [quickstart 8장](quickstart.md#8-막혔을-때)을 본다 |
