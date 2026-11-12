<!--
Every ```bash block below runs, in order, in one `bash -euo pipefail`, in CI
(the `quickstart` job, tests/e2e/quickstart.sh) on a fresh clone, so each
`jq -e` line is an assertion there. Keep it that way: a block a reader should
not run as-is is ```sh or ```text.
-->

# Quickstart — 로컬 스택과 curl로 세션 한 바퀴

저장소를 clone한 머신에서 `scripts/local.sh`로 스택을 띄우고, curl만으로 세션의 전체 경로를 한 번 돈다: 생성 → 이벤트 관찰 → 권한 요청 응답 → 후속 메시지 → interrupt → pause → resume(복원) → terminate → 복구 결정 → resume.

로컬 스택의 기본은 실제 Claude다. 옵션 없는 `scripts/local.sh up`은 실제 Messages API를 부르는 스택을 띄운다. key는 콘솔의 설정 > 에이전트 연결 > 모델 연결 > 연결 추가에서 넣는 것이 기본이고, 셸의 `ANTHROPIC_API_KEY`는 대안이다. key 없이 뜬 스택은 fake로 바뀌지 않고 모델 연결이 없는 채로 남는다([real-claude.md](real-claude.md)). 이 문서는 결과가 매번 같아야 하고 CI가 key 없이 돌려야 하므로 `--fake-model`로 띄운다. 그러면 migrate가 `tests/fixtures/settings/fake-model.json`을 가져오고 compose의 `fake-messages` 서비스를 Messages API로 쓴다. 모델 계정은 필요 없다. 각 워커 안에서는 **진짜 Claude Code**(Agent SDK 0.3.270에 번들된 실행 파일)가 돌고, fake는 프롬프트에 적힌 대본대로 답한다(§ [스크립트된 프롬프트](#스크립트된-프롬프트)). 실제 Claude로 같은 스택을 쓰는 방법은 [5장](#5-실제-claude로-확인하기-선택-유료)에 있다.

이 문서의 `bash` 블록은 CI(`quickstart` job)가 새 clone에서 순서대로 실행한다. `jq -e`로 시작하는 줄은 `true`를 출력해야 한다. `false`가 나오면 그 단계가 기대와 다르게 끝난 것이고, CI에서는 그 자리에서 실패한다. 같은 시나리오를 `tests/e2e/alpha-path.e2e.ts`가 CI(`e2e` job)에서 자동으로 돈다.

## 알려진 제약

- 워커 안에서 실행되는 코드(에이전트의 tool 실행, prompt injection으로 들어온 명령 포함)는 attempt가 살아 있는 동안 그 attempt의 egress token으로 proxy를 거쳐 provider와 저장소, 그리고 자기 세션 prefix 안의 object를 부를 수 있다. provider key, 저장소 credential, object store credential 값 자체는 worker에 가지 않는다.
- 모든 세션이 운영자의 provider key 하나를 같이 쓴다.

## 0. 준비물

macOS나 Linux를 기준으로 한다. 셸은 bash나 zsh를 쓴다.

| 항목 | 버전 | 왜 |
|---|---|---|
| Docker Engine | **28 이상** | 워커 네트워크가 `gateway_mode_ipv4=isolated`를 쓴다. 28보다 낮은 daemon에서는 scheduler가 기동을 거부한다 |
| Docker Compose | 2.24.6 이상(Docker Desktop의 5.x도 된다) | compose의 `include`와 `env_file`의 `required`를 쓰고, `local.sh up`이 `include`로 합친 스택 위에 overlay를 겹친다 |
| curl, jq, uuidgen | 아무 버전 | `local.sh`와 3장의 수동 확인 |
| lsof | 아무 버전 | 0장의 포트 점검. 없으면 점검 블록이 아무것도 출력하지 않는다(`local.sh up`이 다시 확인한다) |
| git | 아무 버전 | clone |
| Bun | 1.3.12 이상 | 4장의 자동 검증과 6장의 key 폐기·백업에만 쓴다. 1–3장에는 필요 없다 |

로컬 스택은 루프백(`127.0.0.1`)에만 포트를 연다. 다음 포트가 비어 있어야 한다: **3000**(API), **5432**(Postgres), **4566**(SeaweedFS S3), **4567**(LocalStack Secrets Manager), **3001**(로컬 GitHub App 모의 서버). 로컬에 Postgres가 떠 있으면 5432가 겹치는 경우가 많다. Docker Desktop은 Settings → Software updates에서 엔진 버전을 확인한다.

```bash
docker version --format 'Docker Engine {{.Server.Version}}'
docker compose version
for p in 3000 5432 4566 4567 3001; do
  if lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1; then echo "사용 중: $p"; fi
done
docker system df
```

`사용 중:` 줄이 없어야 한다. 마지막 줄은 이미지 빌드에 쓸 디스크 여유를 보여 준다. `scripts/local.sh up`도 기동 전에 엔진·compose 버전과 포트를 다시 확인하고, 맞지 않으면 아무것도 띄우지 않고 이유를 출력한다.

## 1. clone과 기동

저장소는 public이라 인증 없이 받을 수 있다.

```text
git clone https://github.com/JeongJaeSoon/werft.git
cd werft
```

```bash
scripts/local.sh up --fake-model
KEY=$(scripts/local.sh demo-key \
  --scopes sessions:read,sessions:write,sessions:approve,sessions:control,sessions:recover)
export WERFT_AGENT_RELEASE_ID=$(scripts/local.sh demo-release release-notes)
# 답은 세션을 연 key가 아닌 다른 key로 한다(자기 승인 금지).
APPROVER_KEY=$(scripts/local.sh demo-key --scopes sessions:read,sessions:approve)
echo "${KEY:0:12}…"
scripts/local.sh status
```

`up --fake-model`은 compose project `werft`을 fake 모델로 띄운다(`infra/compose.fake-model.yml` overlay). 첫 실행은 api·scheduler·worker 이미지를 이 checkout에서 빌드하므로 몇 분에서 10분쯤 걸린다. `/readyz`가 `{"status":"ready","checks":{"database":"ok","schema":"ok","config":"ok"}}`를 돌려줄 때까지 기다렸다가 그 응답을 출력하고 끝난다. 컨테이너가 뜬 뒤 이만큼 기다리는 시간은 180초이고, `LOCAL_READY_TIMEOUT_SEC`로 바꾼다. 뜨는 서비스는 다음과 같다.

- postgres(+ 한 번 도는 `migrate`), localstack(SeaweedFS S3), fake-git(샘플 저장소 `agent/sample-app`을 내주는 GitHub App 모의 서버), secrets(API·로컬 App 전용 Secrets Manager), fake-messages(`--fake-model`일 때만), egress-proxy
- `api`(`127.0.0.1:3000`)와 `scheduler`(5초마다 한 pass로 세션마다 worker 컨테이너를 띄운다)
- `reconciler`(pass가 끝날 때마다 10초 쉬고 다음 pass를 돈다. lease가 만료된 세션과 orphan 세션을 다시 queue에 넣거나 복구 대상으로 표시하고, 기한을 넘긴 interrupt·terminate receipt를 `unknown`으로 마감한다. 사용량 API가 읽는 도구 호출 표도 이 pass가 채운다)
- `worker`는 상주하지 않는다. 이미지 빌드와 `claude --version` 확인만 하고 끝난다. 실제 워커는 scheduler가 세션마다 띄운다

`key`는 API 컨테이너 안에서 key CLI(`apps/control-host/src/api/keys.ts`)를 돌린다. key는 stdout에 **한 번만** 출력되고, 폐기할 때 쓰는 key id는 stderr의 `key_id …` 줄에 나온다. 위 `echo`는 발급됐는지만 앞 12자로 확인한다. `demo-key`는 데모 owner(`demo-owner@example.test`)의 개인 key를 workspace `demo`에 발급한다(`key --workspace <workspace id> --personal <user id>`와 같다). 세션은 언제나 에이전트 release로 만들므로, `demo-release release-notes`가 데모 에이전트 `release-notes`의 활성 release id를 읽어 `WERFT_AGENT_RELEASE_ID`에 넣는다. 둘 다 `up --fake-model`이 만든 데모 데이터를 읽기만 한다. `--scopes`는 필수이며 위 목록이 전부다. 복구 결정(`sessions:recover`)을 빼면 ⑨의 recovery 호출이 403이다.

`status`는 컨테이너 목록과 `/readyz` 응답을 보여 준다. api·scheduler·reconciler가 running이면 다음 장으로 넘어간다.

### 웹 콘솔 데모 계정

`up`은 `/readyz`가 ready가 된 뒤 웹 콘솔(`http://127.0.0.1:3000/login`)에 로그인할 데모 계정 둘을 만든다. 값은 모든 머신에서 같고 저장소에 공개돼 있다. 다른 곳에서 쓰지 않는다.

| 역할 | 이메일 | 비밀번호 |
|---|---|---|
| owner | `demo-owner@example.test` | `demo-local-only` |
| member | `demo-member@example.test` | `demo-local-only` |

- 사용자가 없는 설치에서는 데모 owner가 첫 owner가 되고 workspace `demo`(이름 `Demo`)가 생긴다. 이미 owner가 있는 설치에서는 살아 있는 owner가 그 workspace로 초대하고 수락한 것과 같게 더한다.
- 같은 이메일의 사용자가 이미 있으면 건드리지 않는다. 비밀번호나 역할을 바꿨어도 그대로 둔다. 그래서 `up`을 다시 돌려도 중복이나 데이터 변화가 없다.
- 이미 떠 있는 스택에는 `scripts/local.sh demo-accounts`가 빠진 계정만 더한다. `LOCAL_DEMO_ACCOUNTS=0 scripts/local.sh up --fake-model`은 계정을 만들지 않는다. bootstrap token으로 첫 owner를 직접 만들 때는 이렇게 띄운다(데모 owner가 있으면 bootstrap은 409 `BOOTSTRAP_DONE`이다).
- 만들지 않는 조건: Docker가 이 머신의 것이 아니거나(`DOCKER_HOST`나 지금 docker context의 주소가 `unix://`·`npipe://`가 아님) 떠 있는 api 컨테이너가 게시한 포트 중 하나라도 loopback(`127.0.0.1`·`[::1]`) 밖에 열려 있으면 `local.sh: demo accounts not added: …`를 출력하고 계정 없이 `up`을 마친다.
- 계정을 쓰는 CLI(`apps/control-host/src/api/demo-accounts.ts`)도 스스로 거부한다. `DEMO_ACCOUNTS=local`(`local.sh`만 넘긴다)이 없거나, Kubernetes 안(`KUBERNETES_SERVICE_HOST`)이거나, `DATABASE_URL`의 host가 compose의 `postgres`나 이 머신(`localhost`·`127.0.0.1`·`[::1]`)이 아니거나 query(`?host=` 등 연결 대상을 바꿀 수 있는 옵션)가 붙어 있으면 아무것도 쓰지 않고 exit 2로 끝난다.
- Helm 설치는 미리보기 설치만 예외다. 게시 이미지에는 두 CLI가 없으므로, 미리보기는 `deploy/kind/up.sh`가 `local` target으로 빌드한 control-host 이미지로 설치한 것이어야 한다. chart의 `preview.enabled: true`(기본 false)가 api Pod에 자기 namespace를 담은 `PREVIEW_NAMESPACE`를 넣고, `DATABASE_URL`의 host가 그 namespace의 `postgres` Service(`postgres`·`postgres.<ns>`·`postgres.<ns>.svc`·`postgres.<ns>.svc.cluster.local`)이고 그 host가 실제로 `postgres.<ns>.svc.cluster.local`과 같은 주소로 풀릴 때만 두 CLI가 돈다(Service가 없으면 짧은 이름이 Pod의 search domain을 따라 다른 host로 풀릴 수 있어서다). 하나라도 아니면 위와 같이 exit 2다. `api.extraEnv`로 `PREVIEW_NAMESPACE`를 넣으면 chart 렌더가 실패한다. 미리보기 설치에서는 `kubectl -n <ns> exec deploy/werft-api -- env DEMO_ACCOUNTS=local bun run apps/control-host/src/api/demo-accounts.ts`, 이어서 같은 방식으로 `demo-data.ts`를 부른다(`demo-data.ts`는 fake model catalog가 필요하다).
- 사용자는 있는데 살아 있는 owner가 없는 설치도 거부한다. 그 상태의 bootstrap은 복구여서 모든 세션을 끝낸다.

`--fake-model`로 띄운 스택에서는 계정 다음에 화면을 채울 데모 데이터를 공개 API로 더한다(`apps/control-host/src/api/demo-data.ts`). 데모 owner가 에이전트 셋(`release-notes`·`code-review`는 저장소 `sample-app`, `support-triage`는 저장소 없음)을 만들어 활성화하고, owner와 member가 세션 일곱 개를 연다. owner의 세션은 쉬는 중(성과물 `out/release-notes.md` 하나), 작업 중, 권한 요청 대기, 종료가 하나씩이고, member의 세션은 질문 대기, 쉬는 중, 제목 없는 쉬는 중이다. owner의 작업 중·권한 요청 세션은 owner에게만 공유돼 있어 member 목록에는 다섯 개, owner 목록에는 일곱 개가 보인다. 모델은 fake가 대본대로 답하므로 세션 상세의 첫 메시지에 `GATE-SPEC` 대본이 그대로 보이고, 사용량은 fake 호출이 남긴 아주 작은 값이다. 시드는 세션을 하나씩 열고 원하는 상태가 될 때까지 기다리므로 몇 분 걸린다. 상태는 시드 직후의 모습이다. 작업 중 세션은 fake가 단계마다 답을 늦게 돌려줘서 약 1시간(worker의 turn 상한) 작업 중으로 남고, 질문·권한 요청은 답하지 않으면 30분 뒤 만료된다. 그 뒤 화면을 다시 채우려면 `scripts/local.sh reset --fake-model`로 새로 띄운다(데이터를 모두 지운다). 에이전트는 slug로, 세션은 제목으로(제목 없는 세션은 첫 메시지로) 찾아 이미 있으면 건너뛴다. 그래서 다시 돌려도 중복이 없고 기존 데이터를 지우거나 바꾸지 않는다. 시드는 끝날 때 자기가 연 로그인 세션을 로그아웃해서, 다시 돌려도 브라우저의 데모 로그인이 밀려나지 않는다. 앞선 시드가 세션을 만든 뒤 마무리 전에 실패했으면(owner만 공유, 성과물, 종료 중 하나가 빠짐) 다시 돌릴 때 `incomplete`를 출력하고 실패한다. 쉬는 중·답변 대기·작업 중은 시드 뒤에 저절로 바뀌므로 보지 않는다. 그 세션은 고치지 않으므로 `reset`으로 다시 띄운다. 연동 계정(Slack·GitHub)과 PR은 실제 provider가 필요해 만들지 않는다. 사용하는 연결(`fake-messages`)이 fake Messages API(`http://fake-messages:4010`)를 부르지 않으면 CLI가 exit 2로 거부하고 `local.sh`는 `local.sh: demo data not added`를 출력한 뒤 `up`을 마친다. 옵션 없는 `up`(실제 Claude)이 이 경우다. `LOCAL_DEMO_DATA=0`이면 계정만 만든다.

로컬 스택은 머신마다 하나로 쓴다. project 이름 `werft`, 0장의 포트, worker label `werft.installation=local`이 기본값이다. `local.sh`는 이 값을 스스로 정하지 않고 `COMPOSE_PROJECT_NAME`·`COMPOSE_FILE`·`EXECUTION_INSTALLATION_ID`를 compose가 해석한 그대로의 스택(`docker compose config`)을 따른다. `up`은 그 스택이 여는 포트를 점검하고 `docker compose port api 3000`이 알려 주는 주소의 `/readyz`를 기다린다. `down`은 떠 있는 스택의 egress proxy가 가진 installation id(컨테이너가 하나도 없으면 compose가 해석한 `EXECUTION_INSTALLATION_ID`)의 label이 붙은 worker 자원을 지운다. `up`과 `reset`은 환경 변수 `COMPOSE_FILE`의 파일들(없으면 `compose.yaml`) 위에 overlay를 얹는다. 옵션이 없으면 `infra/compose.real-model.yml`(세션 비용 상한), `--fake-model`이면 `infra/compose.fake-model.yml`이다. 이 문서의 명령(`API=http://127.0.0.1:3000`, 3장의 `installation=local` label)은 기본값 기준이다. compose의 포트는 `infra/`에 고정돼 있어서, project만 바꾼 두 번째 스택은 `up`의 포트 점검에서 멈춘다. 다른 스택 옆에서 돌려야 하면 자기 project와 임시 포트로 뜨는 `tests/e2e/run.sh`를 쓴다(4장).

코드를 새로 pull했으면 `scripts/local.sh up --fake-model`을 다시 실행한다. 매번 이미지를 이 checkout에서 다시 빌드한다.

**로컬 데이터는 named volume에 남는다.** S3는 SeaweedFS 4.48(서비스 이름은 호환성을 위해 `localstack` 유지), PostgreSQL도 자기 volume에 저장한다. Docker/OrbStack 재시작이나 `scripts/local.sh down --keep-volumes` 뒤 `scripts/local.sh up --fake-model`로 다시 띄워도 checkpoint가 남는다. 옵션 없는 `scripts/local.sh down`과 `reset`은 명시적인 전체 데이터 삭제 명령이므로 보존할 때 쓰지 않는다. 기존 LocalStack 설치에서 전환하는 절차는 [7장](#재부팅이나-docker-재시작-뒤)을 따른다.

fake-git(`http://127.0.0.1:3001`)은 로컬 GitHub App 모의 서버다. 샘플 `agent/sample-app`은 App JWT를 확인하고 발급한 설치 토큰으로만 clone한다. 키는 스택 안에서 생성해 별도 Secrets Manager에 저장하며 worker에는 전달하지 않는다. 익명 URL 저장소와 basic/bearer 등록은 지원하지 않는다. 실제 저장소는 설정 > 워크스페이스 > 연동 > GitHub에서 App 연동으로 등록한다. 기존 URL 저장소 행은 삭제하지 않으며, 지원하지 않는 설정으로 거부·보고한다.

## 2. curl 준비

아래 블록을 **같은 터미널**에 한 번 붙여 넣는다. 3장의 명령이 모두 이 함수와 `KEY`를 쓴다. 셸을 새로 열었으면 1장의 `KEY=…`·`export WERFT_AGENT_RELEASE_ID=…` 줄부터 다시 한다.

```bash
API=http://127.0.0.1:3000
AUTH=(-H "Authorization: Bearer $KEY" -H 'Content-Type: application/json')
APPROVE=(-H "Authorization: Bearer $APPROVER_KEY" -H 'Content-Type: application/json')

# 세션 생성·메시지 본문. message는 스크립트된 프롬프트다(아래 절).
body() { jq -nc --arg m "$1" '{agent_release_id:env.WERFT_AGENT_RELEASE_ID, repository_id:"sample-app", message:$m}'; }
say() { jq -nc --arg m "$1" '{message:$m}'; }
post() { curl -sS "$API$1" "${AUTH[@]}" -H "Idempotency-Key: $(uuidgen)" -d "$2"; }
get() { curl -sS "$API$1" "${AUTH[@]}"; }
# 승인 요청의 답과 그 receipt는 APPROVER_KEY로 보내고 읽는다.
answer_as() { curl -sS "$API$1" "${APPROVE[@]}" -H "Idempotency-Key: $(uuidgen)" -d "$2"; }
get_as() { curl -sS "$API$1" "${APPROVE[@]}"; }
# 응답 JSON에서 jq 식 $2의 값이 $3이 될 때까지 GET $1을 되풀이한다.
wait_for() {
  for _ in $(seq 1 180); do
    [ "$(get "$1" | jq -r "$2")" = "$3" ] && return 0
    sleep 1
  done
  echo "timed out: $1 $2 != $3" >&2; get "$1" >&2; return 1
}
revision() { get "/v1/sessions/$SID" | jq .revision; }

get /v1 | jq .
```

`get /v1`이 `owner_id`가 든 JSON을 돌려주면 준비가 끝났다. 401이면 `KEY`가 비었거나 다른 스택에서 발급한 key다.

세션 API(`/v1/sessions`와 그 아래)의 모든 POST는 `Idempotency-Key`가 필수다(`/v1/auth/bootstrap`·`login`·`logout`은 쓰지 않는다). `post`가 요청마다 새 값을 붙인다. 같은 key와 같은 본문으로 다시 보내면 처음 응답이 그대로 오고(재시도 안전), 같은 key에 다른 본문이면 409 `IDEMPOTENCY_CONFLICT`다.

## 3. 세션 한 바퀴

### ① 생성

```bash
created=$(post /v1/sessions "$(body 'GATE-SPEC {"id":"q1","steps":[{"tool":"Bash","input":{"command":"echo alpha | tee hello.txt","description":"write hello.txt"}}],"final":"wrote hello.txt"}')")
echo "$created" | jq .
echo "$created" | jq -e '.status == "queued" and .turn_id == "1"'
SID=$(echo "$created" | jq -r .session_id)
```

```text
{ "session_id": "…", "turn_id": "1", "receipt_id": "…", "receipt_status": "accepted", "status": "queued" }
```

201이다. scheduler가 다음 pass에서 worker를 띄우고, worker가 저장소를 clone한 뒤 turn 1을 시작한다.

### ② 이벤트 관찰

turn 1은 `echo alpha | tee hello.txt`를 실행하려다 권한을 묻고 멈춘다. worker가 뜨고 저장소를 clone하는 데 몇 초에서 수십 초가 걸리므로, 세션이 그 상태(`needs_input`)가 될 때까지 기다린 뒤 스트림을 처음부터 읽는다.

```bash
wait_for "/v1/sessions/$SID" .status needs_input
curl -sSN --max-time 5 "$API/v1/sessions/$SID/events" -H "Authorization: Bearer $KEY" \
  >/tmp/quickstart-events.txt || true
grep -A1 '^event: question' /tmp/quickstart-events.txt
```

`curl: (28) Operation timed out after 5… milliseconds`는 정상이다. 이벤트 스트림은 서버가 닫지 않으므로 `--max-time 5`가 5초 뒤에 끊은 것이고, `|| true`가 있어 다음 줄은 그대로 실행된다. ⑧에서도 같은 메시지가 나온다.

SSE 스트림이다(`id`·`event`·`data` 한 묶음씩, 15초마다 comment keepalive). 사람이 볼 때는 `--max-time` 없이 열어 두고 Ctrl-C로 닫는다. 연결이 끊기면 backoff 뒤 마지막으로 완전히 받은 이벤트의 `id`를 `Last-Event-ID` 헤더로 보내 재연결한다. 서버는 그 이벤트 **다음**부터 재생한다. `410 CURSOR_EXPIRED`는 cursor가 보존 범위 밖이라는 뜻이므로 세션·turn 상태를 다시 읽어 동기화해야 한다. 지금 서버는 이벤트를 지우지 않아 410을 내지 않지만 클라이언트 계약에는 미리 포함한다.

이벤트 이름은 `system`·`assistant`·`tool_use`·`tool_result`·`question`·`result`·`status`·`error`다. `result` 이벤트의 `data.session_id`는 플랫폼 세션 id가 아니라 **engine(Claude Code) 세션 id**이며 durable 완료 판정이 아니다. turn 조회(`GET /v1/sessions/{id}/turns/{turn_id}`)의 `status`가 `completed`·`failed`·`interrupted`·`cancelled`·`outcome_unknown` 중 하나일 때만 terminal로 판정한다. `completed`는 engine이 turn을 정상 종료했다는 뜻이고 요청한 일을 다 했다는 뜻은 아니다([api-guide 4절](https://jeongjaesoon.github.io/werft/ko/reference/api-guide/#4-메시지-보내기와-turn-상태-보기)).

### ③ 대기 중인 요청

예시 release의 권한 모드는 `fake-messages` 연결의 자동 모드 판정을 따른다. 판정이 `unsupported`이면 `default`로 돈다. Claude Code는 읽기 전용 명령(`cat`, `ls` 등)은 묻지 않고 실행하므로, 권한 흐름은 파일을 바꾸는 명령으로 보여 준다.

```bash
get "/v1/sessions/$SID/pending-requests" | jq .
REQ=$(get "/v1/sessions/$SID/pending-requests" | jq -r '.items[0].request_id')
```

```text
{ "items": [ { "request_id": "req_…", "turn_id": "1", "kind": "permission", "tool": "Bash", "input": { "command": "echo alpha | tee hello.txt", … }, "expires_at": "…" } ] }
```

요청은 30분(`PENDING_REQUEST_TTL_SEC`, 정수 초) 안에 답하지 않으면 거절로 끝난다. 값을 바꾸면 worker도 그만큼 기다린다. 다만 turn 상한 `MAX_TURN_SECONDS`를 넘길 수는 없다.

### ④ 응답

```bash
answer=$(answer_as "/v1/sessions/$SID/answers" "$(jq -nc --arg r "$REQ" '{request_id:$r, kind:"permission", action:"allow"}')")
echo "$answer" | jq .
wait_for "/v1/sessions/$SID/turns/1" .status completed
get "/v1/sessions/$SID/turns/1" | jq -e '.status == "completed"'
get_as "/v1/receipts/$(echo "$answer" | jq -r .receipt_id)" | jq '{operation, status}'
```

답은 세션을 연 key(`KEY`)가 아닌 다른 key(`APPROVER_KEY`)로 보낸다. workspace key는 자기가 연 세션의 요청에 답하지 못한다(403 `self_approval`). 거절은 `{"action":"deny","reason":"…"}`(reason 필수)이다. `AskUserQuestion`에서 오는 `kind: "question"` 요청은 `answers: [{question_id, selected_option_ids}]`로 답한다.

### ⑤ 후속 메시지

```bash
post "/v1/sessions/$SID/messages" "$(say 'GATE-SPEC {"id":"q2","steps":[],"final":"second turn"}')" | jq .
wait_for "/v1/sessions/$SID/turns/2" .status completed
get "/v1/sessions/$SID/turns/2" | jq -e '.status == "completed"'
```

202와 함께 `turn_id: "2"`가 온다. 같은 worker의 같은 Claude Code 세션에서 이어진다. 세션 하나에 쌓을 수 있는 대기 입력은 `QUEUED_INPUT_LIMIT_PER_SESSION`(기본 20)개이고, 넘으면 429다.

### ⑥ interrupt

turn 3은 모델 응답이 5분 늦게 오도록 대본을 짰다. 실행 중인 turn을 지정해서 멈춘다. 여기서는 turn이 `running`이 된 것만 기다린다 — 모델 호출이 실제로 진행 중일 때 멈추는지는 `tests/e2e`가 fake의 호출 기록을 보고 확인한다.

```bash
post "/v1/sessions/$SID/messages" "$(say 'GATE-SPEC {"id":"q3","steps":[],"final":"too late","finalDelayMs":300000}')" | jq .
wait_for "/v1/sessions/$SID" .current_turn_id 3
wait_for "/v1/sessions/$SID" .status running
interrupt=$(post "/v1/sessions/$SID/interrupt" '{"target_turn_id":"3"}')
echo "$interrupt" | jq .
wait_for "/v1/sessions/$SID/turns/3" .status interrupted
get "/v1/sessions/$SID/turns/3" | jq -e '.status == "interrupted"'
get "/v1/receipts/$(echo "$interrupt" | jq -r .receipt_id)" | jq '{status, result}'
```

아직 시작하지 않은 turn은 409 `TURN_NOT_STARTED`, 이미 끝난 turn은 `no_op: true`인 성공 receipt다. 멈춘 turn은 `interrupted`, 세션은 `status: stopped`가 된다. worker는 남아 있어 다음 메시지를 그대로 받는다.

### ⑦ pause

pause·terminate·resume·recovery는 세션의 현재 `revision`을 `expected_revision`으로 보낸다(다르면 409 `REVISION_CONFLICT`).

```bash
wait_for "/v1/sessions/$SID" .status stopped
post "/v1/sessions/$SID/pause" "$(jq -nc --argjson r "$(revision)" '{expected_revision:$r, reason:"quickstart"}')" | jq .
wait_for "/v1/sessions/$SID" .admission_state paused
get "/v1/sessions/$SID" | jq '{status, admission_state, checkpoint_revision}'
get "/v1/sessions/$SID" | jq -e '.admission_state == "paused" and .checkpoint_revision != null'
code=$(curl -sS -o /tmp/quickstart-paused.json -w '%{http_code}' "$API/v1/sessions/$SID/messages" \
  "${AUTH[@]}" -H "Idempotency-Key: $(uuidgen)" -d "$(say 'while paused')")
jq -e --arg code "$code" '$code == "409" and .error.code == "SESSION_PAUSED"' /tmp/quickstart-paused.json
```

worker가 진행 중인 일을 마무리하고 checkpoint(workspace git bundle + transcript)를 커밋한 뒤 사라진다. 그동안은 `pausing`이고, 끝나면 `paused`다. paused 동안 보낸 메시지는 409 `SESSION_PAUSED`다(마지막 줄). 60초 안에 drain되지 않으면 세션 상세의 `attention`에 `PAUSE_BLOCKED`가 뜬다.

### ⑧ resume — 새 worker에서 복원

```bash
post "/v1/sessions/$SID/resume" "$(jq -nc --argjson r "$(revision)" '{expected_revision:$r}')" | jq .
wait_for "/v1/sessions/$SID" .admission_state active
post "/v1/sessions/$SID/messages" "$(say 'GATE-SPEC {"id":"q4","steps":[{"tool":"Bash","input":{"command":"cat hello.txt","description":"read hello.txt"}}],"final":"restored"}')" | jq .
wait_for "/v1/sessions/$SID/turns/4" .status completed
get "/v1/sessions/$SID/turns/4" | jq -e '.status == "completed"'
curl -sSN --max-time 5 "$API/v1/sessions/$SID/events" -H "Authorization: Bearer $KEY" \
  >/tmp/quickstart-events.txt || true
sed -n 's/^data: *//p' /tmp/quickstart-events.txt |
  jq -se 'any(.[]; .turn_id == "4" and (tojson | contains("alpha")))'
```

새 worker는 빈 HOME·workspace에서 마지막 checkpoint만으로 저장소와 Claude Code 세션을 복원한다. 마지막 줄은 turn 4의 이벤트에 turn 1이 쓴 `alpha`가 있는지 본다. turn 4의 `cat hello.txt`가 `alpha`를 돌려주면 workspace가 복원된 것이다.

### ⑨ terminate → 복구 결정 → resume

turn 5를 느리게 걸어 두고 실행 중에 terminate한다(⑥처럼 `running`까지만 기다린다). 결과를 알 수 없는 turn이 남으므로 세션은 복구 결정을 기다린다.

```bash
post "/v1/sessions/$SID/messages" "$(say 'GATE-SPEC {"id":"q5","steps":[],"final":"never","finalDelayMs":300000}')" | jq .
wait_for "/v1/sessions/$SID" .current_turn_id 5
wait_for "/v1/sessions/$SID" .status running
post "/v1/sessions/$SID/terminate" "$(jq -nc --argjson r "$(revision)" '{expected_revision:$r, reason:"quickstart"}')" | jq .
wait_for "/v1/sessions/$SID" .admission_state recovery_required
get "/v1/sessions/$SID/turns/5" | jq -e '.status == "outcome_unknown"'

decision=$(post "/v1/sessions/$SID/recovery-decisions" "$(jq -nc --argjson r "$(revision)" \
  '{decision:"abandon", expected_revision:$r, reason:"slow call had no effect", target_turn_id:"5"}')")
echo "$decision" | jq .
wait_for "/v1/receipts/$(echo "$decision" | jq -r .receipt_id)" .status succeeded
get "/v1/receipts/$(echo "$decision" | jq -r .receipt_id)" | jq .result
get "/v1/receipts/$(echo "$decision" | jq -r .receipt_id)" | jq -e '.result.resumable == true'

post "/v1/sessions/$SID/resume" "$(jq -nc --argjson r "$(revision)" '{expected_revision:$r}')" | jq .
wait_for "/v1/sessions/$SID" .admission_state active
post "/v1/sessions/$SID/messages" "$(say 'GATE-SPEC {"id":"q6","steps":[{"tool":"Bash","input":{"command":"cat hello.txt","description":"read hello.txt"}}],"final":"still here"}')" | jq .
wait_for "/v1/sessions/$SID/turns/6" .status completed
get "/v1/sessions/$SID/turns/6" | jq -e '.status == "completed"'
```

- terminate는 대기 중인 입력을 취소하고 열린 권한 요청을 닫는다. 실행 중이던 turn은 `outcome_unknown`이 되고 세션은 `status: stopped`, `admission_state: recovery_required`다. 멈추라는 요청 없이 실행이 사라진 세션(worker 종료, lease 만료)은 `status: failed`다. 도구가 이미 바깥에 한 일은 되돌리지 않는다(`external_effects_reverted: false`).
- 복구 결정은 `abandon`(turn을 `cancelled`로), `confirm_completed`(checkpoint가 그 turn까지 덮을 때, `evidence_ref` 필수), `close`(세션을 끝냄, 되돌릴 수 없음), `start_fresh`(이전 engine 문맥을 모두 버리고 현재 pointer까지의 checkpoint를 retire하여 아무것도 복원하지 않는 새 Claude Code 세션에서 대기 중인 입력을 실행함), `retry_restore`(checkpoint 복원 실패의 원인을 고친 뒤 실패 횟수를 초기화하고 pointer를 유지해 다음 claim에서 같은 checkpoint를 다시 복원함) 중 하나다. 전체 절차는 [api-guide 7절](https://jeongjaesoon.github.io/werft/ko/reference/api-guide/#7-outcome_unknownrecovery_required-복구-결정)을 본다. receipt `result.resumable`이 `true`면 resume할 수 있다.
- idle 상태에서 terminate하면 복구 결정 없이 바로 `stopped`이고, 그대로 resume할 수 있다.

### 로그 보기

```sh
docker compose logs -f api scheduler
```

worker 컨테이너는 끝나면 scheduler가 바로 지우므로 `docker logs`로 나중에 볼 수 없다. 남기려면 스택을 띄운 동안 다른 터미널에서 시작되는 worker마다 로그를 따라가는 루프를 하나 걸어 둔다(`tests/e2e/run.sh`가 같은 방법을 쓴다).

```sh
mkdir -p worker-logs
docker events --filter label=werft.installation=local --filter type=container \
  --filter event=start --format '{{.Actor.ID}} {{index .Actor.Attributes "name"}}' |
  while read -r id name; do docker logs -f --timestamps "$id" >"worker-logs/$name.log" 2>&1 & done
```

## 4. 명령 하나로 자동 검증

3장을 손으로 도는 대신 스크립트로 확인한다. 처음 한 번 테스트 의존성을 설치한다.

```sh
bun install
```

| 명령 | 확인하는 것 | 성공 표시 |
|---|---|---|
| `tests/e2e/run.sh` | 세션 경로 전체(3장과 같은 흐름 + pause 경계 케이스). CI `e2e` job과 같다 | 끝의 `tests:` 줄이 `skip=0 fail=0`이고 exit 0 |
| `tests/e2e/quickstart.sh` | 이 문서의 `bash` 블록을 순서대로 한 `bash -euo pipefail`에서 실행한다. `jq -e` 줄 하나라도 `false`면 실패다. CI `quickstart` job과 같다. 1장 스택이 없을 때만 돌린다(아래 경고) | `== quickstart: every block ran` |
| `tests/e2e/restore-resume.sh` | 세션 두 turn → pause → 백업 → 원본 전부 삭제 → 새 project에 복원·검증 → resume해서 같은 Claude 세션으로 이어지는지 | exit 0. 비교표는 `RR_OUT/record.txt` |

`run.sh`와 `restore-resume.sh`는 **자기 compose project와 임시 포트**로 따로 뜨고, 끝나면 자기가 만든 것을 모두 지운다. 1장 스택과 겹치지 않는다. 다만 이미지를 새로 빌드하므로 무겁다. 하나씩 돌린다.

> **`quickstart.sh`는 1장 스택과 그 데이터를 지운다.** 문서 그대로 기본 project(`werft`)와 기본 포트(3000 등)를 쓴다. 1장 스택이 떠 있으면 그 스택을 이어 받아 세션과 API key를 하나씩 더 만들고, 마지막 블록의 `scripts/local.sh down`으로 스택과 volume을 모두 지운다. 1장 스택을 7장처럼 내린 뒤에 돌리거나 새로 clone한 머신에서만 돌린다.

실행 기록은 `E2E_OUT`(기본값은 새 임시 디렉터리이고 끝날 때 경로를 출력한다)에 남는다. `record.txt`(tested SHA, 이미지 id, SDK·Claude Code 버전), `test.log`, compose 로그, worker 로그가 들어 있다. 스택을 남겨 두고 테스트만 반복하려면 `E2E_UP_ONLY=1 tests/e2e/run.sh`로 띄우고, `source <E2E_OUT>/vars.sh` 뒤에 `bun test ./tests/e2e/alpha-path.e2e.ts`를 돌린다.

## 5. 실제 Claude로 확인하기 (선택, 유료)

옵션 없는 `scripts/local.sh up`이 같은 스택을 실제 Claude에 붙인다. 본인의 Anthropic API key는 콘솔의 모델 연결 화면에서 넣는다. 유료 e2e 한 번과 그 스택에서 직접 대화하는 방법, 비용, key 취급은 [real-claude.md](real-claude.md)에 있다.

## 6. 운영 기능 둘러보기

2장의 함수와 3장의 `SID`를 그대로 쓴다.

```bash
get "/v1/usage/summary?scope=me&since=$(date -u +%Y-%m-01)" | jq .
get "/v1/sessions/$SID/usage" | jq .
```

| 기능 | 명령 |
|---|---|
| 이번 달 내 사용량(세션 수·비용·token·실행 시간) | `get "/v1/usage/summary?scope=me&since=$(date -u +%Y-%m-01)" \| jq .` |
| 세션 사용량(비용·대기 입력 수) | `get /v1/sessions/$SID/usage \| jq .` |
| turn 조회 | `get /v1/sessions/$SID/turns/1 \| jq .` |
| receipt 조회 | `get /v1/receipts/<receipt_id> \| jq .` |
| API key 추가 발급 | `scripts/local.sh key <owner> --scopes …`. key id는 stderr의 `key_id …` 줄에 있다 |
| API key 폐기 | `bun run keys revoke <key id>`. 폐기한 key로 호출하면 401이다 |
| Idempotency 확인 | 같은 `Idempotency-Key`로 같은 본문을 다시 보내면 첫 응답이 그대로 온다. 같은 key에 다른 본문을 보내면 409 `IDEMPOTENCY_CONFLICT`다 |
| 샘플 저장소 clone | 위 샘플 세션으로 확인한다. 로컬 GitHub App이 발급한 설치 토큰이 필요하며 익명 clone과 웹 UI는 제공하지 않는다 |

에이전트가 워커 안에서 만든 커밋의 작성자는 워커 이미지의 기본값 `Werft <noreply@werft.invalid>`다. 그래서 Claude가 커밋 전에 이름과 이메일을 묻지 않는다. 세션 안에서 `git config`로 정한 값이 있으면 그 값이 먼저다.

### 백업 → 복원 → 검증 (수동)

백업·복원의 정본 절차, writer 중지 순서, 새 project 복원, 검증과 정리는 [백업과 복원](operator/backup-restore.md#로컬에서-끝까지-돌려-보기)에 있다. 실서버에서는 이 로컬 예시 대신 [단일 서버 배포의 백업·복원 기준](operator/server-deployment.md#6-백업과-복원-기준을-운영한다)을 따른다.

## 7. 정리

```bash
scripts/local.sh down
```

`down`은 스택과 **모든 데이터**(세션, checkpoint, API key)를 지운다. scheduler가 만든 worker 컨테이너·네트워크·workspace volume은 compose 소유가 아니므로 `werft.installation=<installation id>` label(기본 `local`, 1장)로 찾아 함께 지운다. 처음부터 다시 하려면 `scripts/local.sh reset --fake-model`(= `down` 뒤 `up --fake-model`)을 쓴다. 새 스택에서는 1장의 `KEY=…`부터 다시 한다.

데이터를 보존하며 내릴 때는 `scripts/local.sh down --keep-volumes`를 쓴다. compose 서비스와 scheduler가 만든 worker 컨테이너·네트워크를 지우고, compose volume과 workspace volume(`werft-ws-*`)은 남긴다. `docker compose down`만 하면 compose label이 없는 worker 컨테이너와 그 네트워크가 남아 Docker 주소 풀을 계속 차지할 수 있다. 다시 `scripts/local.sh up --fake-model`로 올리면 S3 객체·버전·법적 hold·버킷 설정과 암호화 seed도 `local-s3-data` named volume에서 읽는다. seed를 잃거나 바꾸면 기존 객체를 복호화할 수 없으므로 volume 전체를 함께 보존한다. 외장 디스크 bind mount나 별도 라이선스는 필요 없다. bucket의 객체를 잃은 설치에만 아래 복구 결정이 필요하다.

### 재부팅이나 Docker 재시작 뒤

호스트나 Docker 재시작 뒤에도 `scripts/local.sh up --fake-model`만 실행하면 된다. 빈 volume으로 처음 시작할 때도 versioning·Object Lock·기본 AES256 암호화를 자동 설정한다.

bucket이 비어 있는데 PostgreSQL에 기존 checkpoint가 남아 있으면 API는 복구 결정을 할 때까지 기동을 거부한다. 보존한 백업이 있으면 [백업 절차](operator/backup-restore.md)대로 이전에 사용하지 않은 새 compose project에 복원한다. 복구할 백업이 없어 그 checkpoint를 포기하기로 했다면, 계정·워크스페이스·API key는 남기고 아래 명령으로 유실 참조만 해제한다.

```bash
scripts/local.sh forget-lost-checkpoints   # 잃은 checkpoint를 포기하고 그 세션을 출력한다
scripts/local.sh up --fake-model           # 실제 Claude 스택이면 옵션 없이
```

`forget-lost-checkpoints`는 API가 거부하는 그 상태, 즉 bucket에 object version이 하나도 없는데 DB에 미회수 checkpoint가 남은 경우에만 동작한다. bucket에 버전이 하나라도 있으면 아무것도 바꾸지 않고 실패한다. 동작하면 남은 checkpoint를 모두 회수된 것(`collected_at`)으로 표시하고 잃은 세션 수와 ID를 출력한다.

- `recovery_required <id>`: 그 checkpoint에서 복원될, 닫히지 않은 세션이다. pause·resume·stop 도중이었거나 이미 `recovery_required`였던 세션도 포함하며, 열려 있던 pause·resume receipt는 실패로 끝난다. 잃은 pointer는 `start_fresh`가 하듯 retire되지만 어느 turn의 문맥도 버린 것으로 치지 않는다. 그래서 세션 상세는 `admission_state: "recovery_required"`이다. worker에 전달돼 끝난 turn(`completed`·`failed`·`interrupted`)이 있으면 `attention`은 `CONTEXT_GAP`(`checkpointed_turn_id: null`)이고, 그런 turn이 없으면 `attention`은 null이다. 이벤트 스트림에는 system `checkpoint_objects_lost`와 `reason: "checkpoint_objects_lost"`인 status가 남는다. resume과 새 메시지는 409 `RECOVERY_REQUIRED`로 거부되고, 아무 일도 없었던 것처럼 새로 시작하지 않는다. 다른 복구 결정으로 `stopped`가 된 뒤의 resume도 409 `CHECKPOINT_UNAVAILABLE`이다. 대기 중인 입력은 남는다. 이전 문맥 없이 이어 가려면 복구 결정 `start_fresh`, 끝내려면 `close`를 보낸다([api-guide 7절](https://jeongjaesoon.github.io/werft/ko/reference/api-guide/#7-outcome_unknownrecovery_required-복구-결정)). 복원할 checkpoint가 없으므로 `retry_restore`는 거부된다.
- `unchanged <id>`: 이미 닫혔거나 `start_fresh`로 checkpoint를 버려 복원할 것이 없는 세션이다.

잃은 checkpoint가 없으면 `No checkpoint is missing from the bucket`만 출력하고 끝난다. 세션까지 모두 지우고 새로 하려면 여전히 `scripts/local.sh reset --fake-model`이다.

`up --fake-model`의 데모 데이터 시드는 기존 데모 세션의 outputs 조회가 409 `CHECKPOINT_UNAVAILABLE`이면 `awaiting-recovery session <id>: CHECKPOINT_UNAVAILABLE; existing demo left unchanged`를 출력하고 그 세션을 그대로 둔 채 나머지 시드를 계속한다. 뒤의 `exists session <제목>`은 기존 세션이 있다는 뜻이며 산출물이 복구됐다는 뜻이 아니다. 잃은 산출물을 다시 만들거나 복구 결정을 대신하지 않는다. 다른 조회 오류는 시드를 중단한다.

## 8. 막혔을 때

| 증상 | 원인과 조치 |
|---|---|
| `local.sh up`이 `Docker Engine … is too old`로 끝나거나, scheduler가 재시작을 반복하고 로그에 `GatewayModeUnsupportedError`가 있다 | Docker Engine이 28 미만이다. 엔진을 올린다 |
| `local.sh up`이 `no ANTHROPIC_API_KEY … the stack starts with no model connection`을 출력하고 세션이 `connection_missing`으로 거절된다 | 옵션 없는 `up`은 실제 Claude를 쓰고 key 없이도 뜬다. 이 문서대로 모델 계정 없이 하려면 `--fake-model`을 붙이고, 실제 Claude로 하려면 [real-claude.md](real-claude.md#key-입력과-폐기)대로 설정 > 에이전트 연결 > 모델 연결 > 연결 추가에서 key를 넣는다 |
| `local.sh up`이 `127.0.0.1 port(s) … already in use`로 끝나거나 `bind: address already in use`가 나온다 | 0장의 포트 중 하나를 다른 프로세스나 다른 스택이 쓰고 있다. 0장의 `lsof` 루프로 찾는다 |
| API가 기동하지 않고 로그에 `Checkpoint bucket … holds no object version, but the database still has checkpoints that restores read`가 있다 | 이전 LocalStack 설치의 S3가 유실됐거나, 새 S3 volume으로 전환하면서 postgres의 checkpoint 참조만 남았다. 계정과 key를 남기려면 `scripts/local.sh forget-lost-checkpoints` 뒤 `up`([7장](#재부팅이나-docker-재시작-뒤), 잃은 checkpoint의 세션은 `recovery_required`), 모두 지우고 새로 띄우려면 `scripts/local.sh reset --fake-model`(실제 Claude 스택이면 옵션 없이, 세션도 지워진다) |
| scheduler가 재시작을 반복하고 로그에 `SCHEDULER_PASS_TIMEOUT_SEC must be greater than EXECUTION_DOCKER_STOP_TIMEOUT_SEC + EXECUTION_DOCKER_REQUEST_TIMEOUT_SEC` | 예전에 만든 `.env`에 옛 기본값(`SCHEDULER_PASS_TIMEOUT_SEC=120`)이 남아 있다. pass는 worker 정지 하나를 끝까지 기다릴 수 있어서 timeout이 그보다 길어야 한다. 두 줄을 지우거나 `.env.example`처럼 `SCHEDULER_PASS_TIMEOUT_SEC=180`·`SCHEDULER_HEALTH_STALE_SEC=200`으로 고친다. 새로 clone한 머신에는 `.env`가 없다 |
| zsh에서 `readyz`나 다른 URL이 `NOT_FOUND`이고 `Could not resolve host: echo`가 함께 뜬다 | oh-my-zsh의 `url-quote-magic`이 URL 뒤에 붙여 넣은 `;` 앞에 `\`를 넣었다. 명령을 보면 `readyz\;`로 되어 있고, 요청은 `/readyz;`로 가며 `echo`는 curl의 호스트 이름이 된다. URL을 따옴표로 감싸도 막히지 않는다. 스택 문제가 아니다. 이 문서의 명령처럼 줄바꿈은 `curl -sS -w '\n' http://127.0.0.1:3000/readyz`로 붙인다. 이 동작을 아예 끄려면 `~/.zshrc`에서 `DISABLE_MAGIC_FUNCTIONS="true"`의 주석을 풀고 새 셸을 연다 |
| `readyz`가 503 `NOT_READY`다 | DB나 migration이 아직 준비되지 않았다. `docker compose --profile apps ps -a`에서 `migrate`가 `Exited (0)`인지 보고 `docker compose logs api migrate`를 확인한다 |
| `scripts/backup.sh`가 `checkpoint objects could not be backed up at the versions their checkpoints pin`으로 끝난다 | checkpoint가 가리키는 객체 버전이 없다. 이전 LocalStack 설치의 유실이나 S3 volume·암호화 키 누락을 확인한다. 새 로컬 S3는 named volume에 영속화된다. 복구 가능한 백업을 찾고, 없을 때만 [7장](#재부팅이나-docker-재시작-뒤)의 명시적 유실 참조 해제 또는 전체 초기화를 선택한다 |
| 세션이 `queued`에서 움직이지 않는다 | `docker compose logs scheduler`와 worker 로그(3장 끝의 루프)를 본다. `EXECUTION_SLOT_LIMIT`(기본 10)만큼 세션이 이미 실행 중일 수도 있다 |
| POST가 401이다 | `Authorization` 헤더가 빠졌거나, key가 다른 스택의 DB에서 발급됐다. `reset`이나 `down` 뒤라면 key도 지워졌다. 1장의 `KEY=…`와 2장의 함수를 다시 설정한다 |
| POST가 403이다 | key에 그 scope가 없다. `--scopes`를 1장과 같게 발급한다 |
| ④의 allow가 409 `REQUEST_EXPIRED`다 | 권한 요청이 30분 안에 답을 받지 못해 거절로 끝났고 turn 1도 이미 끝났다. `hello.txt`가 만들어지지 않았으니 ⑧에서 `alpha`가 나오지 않는다. ①부터 새 세션으로 다시 하고 ②–④를 30분 안에 진행한다 |
| 409 `REVISION_CONFLICT` | 그 사이 세션이 바뀌었다. `$(revision)`으로 다시 읽어 보낸다 |
| pause가 오래 `pausing`이고 `attention.code`가 `PAUSE_BLOCKED`다 | worker가 60초 안에 drain하지 못했다. 진행 중인 turn을 interrupt하거나 기다린다 |
| pull한 코드가 반영되지 않은 것 같다 | `scripts/local.sh up --fake-model`(실제 Claude 스택이면 옵션 없이)을 다시 실행한다. 이미지를 이 checkout에서 다시 빌드한다 |
| 빌드 중 디스크가 부족하다 | `docker system df`로 확인하고, 필요 없는 이미지와 빌드 캐시를 지운다(예: `docker builder prune`) |

## 스크립트된 프롬프트

fake Messages API(`packages/testkit/src/scripted-messages.ts`)는 user 메시지 안의 `GATE-SPEC {…}`를 대본으로 읽는다.

```text
GATE-SPEC {"id":"<이름>","steps":[{"tool":"<도구>","input":{…},"delayMs":<선택>}],"final":"<마지막 답>","finalDelayMs":<선택>}
```

- `steps`의 도구 호출을 하나씩 순서대로 보내고, 도구 결과를 다 받으면 `final` 텍스트로 turn을 끝낸다. 몇 번째 단계인지는 대본 뒤에 쌓인 도구 결과 수로 정하므로 서버는 상태를 갖지 않는다.
- `delayMs`·`finalDelayMs`는 그 응답을 늦춘다. 긴 turn(interrupt·terminate 시연)을 만들 때 쓴다.
- 대본이 없는 메시지에는 `Hello from the local fake Messages API.`로 답한다.
- 도구는 release의 `effective_tools`(런타임의 내장 도구 전부) 안에 있고, 워크스페이스·에이전트 실행 규칙의 막기 목록 밖이어야 한다. 막힌 도구는 권한 요청 없이 거절된다.
