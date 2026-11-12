# 결정(설계): worker supervisor와 엔진·git 자식 프로세스 사이의 경계

- 상태: 결정(2026-11-12). 구현했다.
- 결정한 사람: 이 결정은 작업자 판단이고 Codex 설계 리뷰를 거쳤다. 오너 지시는 순서에 대한 것이다(2026-11-12: "리팩토링 끝나면 추천 순서대로 대응해줘", "전체적으로 추천대로 하면될듯?").

## 문제

worker 컨테이너 안에서는 프로세스 세 종류가 같은 UID(1000)로 돈다.

- **supervisor**: `bun run apps/worker/src/main.ts`. 세션을 claim하고 gateway와 말한다.
- **init**: PID 1인 `tini`. supervisor의 부모다.
- **엔진과 그 자식**: Claude Code·Codex, 엔진이 도구로 실행한 명령, supervisor가 띄운 git.

Linux는 같은 UID의 프로세스가 서로의 `/proc/<pid>/environ`을 읽도록 허용한다. 그래서 엔진이 실행한 명령은 supervisor가 가진 값을 읽을 수 있다. 엔진에 넘기는 환경 변수를 줄여도 막지 못한다.

### 2026-11-12 main에서 확인한 것

`werft-worker` 이미지를 LocalDockerBackend와 같은 설정(`CapDrop: ALL`, `no-new-privileges`, 읽기 전용 rootfs, `User: 1000:1000`)으로 띄워 측정했다. 호스트는 Docker 29.8.2, arm64, kernel 7.2다.

| 확인한 것 | 결과 |
|---|---|
| supervisor, tini, 자식의 UID | 모두 1000 |
| 자식이 `/proc/<supervisor pid>/environ` 읽기 | 성공. `WORKER_BOOTSTRAP_NONCE` 값이 보인다 |
| 자식이 `/proc/1/environ`(tini) 읽기 | 성공. 같은 값이 보인다 |
| 자식이 `/proc/<supervisor pid>/mem` 열기 | 이 호스트에서는 실패. Yama `ptrace_scope=1` 때문이며, 0인 호스트에서는 성공한다 |
| 자식이 supervisor의 `fd`·`maps`·`cwd` 읽기 | 성공 |

이 문제를 처음 적었을 때 꼽은 세 값의 지금 상태는 다음과 같다.

| 값 | 지금 상태 |
|---|---|
| object store 자격 증명 | worker env에 없다. worker는 proxy의 object store route로만 object store에 닿는다 |
| provider credential | worker env와 claim 응답에 없다. proxy의 credential route가 upstream 요청에 붙인다 |
| `WORKER_BOOTSTRAP_NONCE` | supervisor와 tini의 environ에 남아 있다 |

env의 비밀은 nonce 하나로 줄었다. 대신 supervisor의 **메모리**에는 claim 응답으로 받은 값이 있다. 그 가운데 엔진에 넘기지 않는 값은 `session_credential`(gateway 쓰기 권한), object store token, MCP 서버의 upstream token이다. `/proc/<pid>/mem`을 읽을 수 있는 호스트에서는 엔진이 실행한 명령이 이 값들을 읽는다.

### nonce로 할 수 있는 일

nonce를 가진 쪽은 `bootstrapClaim`을 다시 부를 수 있다. `claimAtomic`은 두 가지를 한다.

1. **재생.** attempt가 `allocated`인 동안에는 같은 binding에 새 `session_credential`을 발급하고 이전 것을 폐기한다. 응답을 잃은 claim을 되살리는 경로다. 엔진이 실행한 명령이 재생하면 supervisor의 credential이 죽고 그 명령이 세션을 가진다.
2. **이미지 불일치 거절.** 요청의 `image_runtime`이 launch가 가정한 것과 다르면 `refuseWorkerImage`가 execution을 종료시키고 `worker_image_refusals`에 행을 남긴다. scheduler는 그 이미지로는 어떤 세션도 띄우지 않는다. 이 검사는 재생 guard보다 **앞**에 있어서 attempt의 상태와 무관하게 실행된다. 엔진이 실행한 명령 하나가 설치 전체의 새 세션 launch를 막을 수 있다.

두 경로 모두 nonce가 만료되기 전(발급 뒤 10분)에만 열린다.

attempt는 worker의 호출 하나가 fence를 통과하면 `allocated`를 벗어난다. `acquireFence`가 어떤 호출이든 받아들이는 순간 `starting`으로 옮긴다. 그런데 worker는 claim 뒤 첫 호출의 응답을 기다리지 않고 checkout 준비와 엔진 시작으로 넘어간다. heartbeat 루프의 첫 beat는 주기(기본 5초) 뒤에 나간다. 재생 창은 보통 몇 초 안에 닫히지만, 엔진이 그 전에 뜨지 않는다는 보장은 없다. 이미지 불일치 경로는 닫히지 않는다.

## 무엇을 골랐나

세 가지를 함께 한다. 어느 것도 운영자에게 새 권한, 이미지 사용자 변경, Helm 값 변경을 요구하지 않는다.

### 1. supervisor를 non-dumpable로 만든다

supervisor가 시작하자마자, 설정을 읽거나 자식을 띄우기 전에 자기 자신에게 `prctl(PR_SET_DUMPABLE, 0)`을 부른다. `ssh-agent`와 `gpg-agent`가 같은 UID로부터 키를 지키는 방법과 같다.

커널은 dumpable이 아닌 프로세스에 대해 다음을 한다.

- `/proc/<pid>/` 아래 파일의 소유자를 root로 바꾼다.
- `CAP_SYS_PTRACE`가 없는 프로세스의 ptrace 접근 검사를 거절한다. UID가 같아도 거절한다. `environ`, `mem`, `maps`, `fd`, `cwd`, `root`, `exe`, `io`, `ptrace(2)`, `process_vm_readv(2)`가 이 검사를 거친다.
- core dump를 만들지 않는다.

worker 컨테이너는 capability를 전부 버리고 `no-new-privileges`로 돌기 때문에, 엔진이 실행한 명령이 `CAP_SYS_PTRACE`를 얻을 길이 없다. 플래그는 `execve`와 UID·GID 변경에서만 바뀐다. supervisor는 둘 다 하지 않는다. 스레드는 주소 공간을 같이 쓰므로 플래그도 같이 쓴다.

같은 조건에서 다시 측정한 결과다.

| 확인한 것 | supervisor(non-dumpable) | tini(PID 1) |
|---|---|---|
| `environ` 소유자 | `0:0` | `1000:1000` |
| 자식이 `environ` 읽기 | 실패(`Permission denied`) | 성공 |
| 자식이 `fd` 나열, `cwd` 읽기, `maps` 읽기 | 모두 실패 | 모두 성공 |
| 자식이 `mem` 열기 | 실패 | 실패(Yama) |

supervisor 자신이 쓰는 경로는 그대로 동작했다. `/proc/self/fd` 나열, `/proc/self/fd/<n>`을 거친 `statfs`·`lstat`·`readlink`·`readdir`(동기와 비동기 모두), `/proc/self/mountinfo`, 자식의 `/proc/<pid>/task/<tid>/children`, 그리고 git 실행이다. 자식 프로세스는 `execve` 때 dumpable로 돌아가므로 엔진과 git의 동작은 바뀌지 않는다. 엔진에 API 키를 넘기는 file descriptor는 자식이 물려받는 것이라 부모의 `/proc`을 거치지 않는다.

구현 방식은 다음과 같다.

- `bun:ffi`로 libc의 `prctl`을 부른다. 새 의존성이나 네이티브 빌드가 없다.
- Linux에서 `prctl`을 부르지 못하거나 다시 읽은 값이 0이 아니면 supervisor는 시작하지 않는다. 경계 없이 조용히 도는 것보다 뜨지 않는 편이 낫다.
- Linux가 아니면(개발자 macOS의 직접 실행) 아무것도 하지 않는다.

기동 거부가 지원 환경을 줄이지 않는지는 측정으로 확인한다.

| 환경 | 확인 |
|---|---|
| Docker(runc) 기본 seccomp, arm64 | 측정했다. `prctl`이 0을 돌려주고 읽기가 거절됐다 |
| Docker 기본 seccomp, x86-64 | 고정한 Bun base 이미지를 에뮬레이션으로 돌려 같은 결과를 봤다. CI의 e2e job이 실제 x86-64 runner에서 이 경계를 매번 확인한다 |
| Kubernetes `RuntimeDefault`(containerd) | CI의 k8s-smoke job이 kind에서 실제 worker Pod를 띄운다. `prctl`이 막히면 worker가 뜨지 않아 그 job이 실패한다 |

`RuntimeDefault`는 runtime마다 다른 profile을 가리킨다. 위 표 밖의 runtime(gVisor, Kata, 직접 쓴 seccomp profile)에서 `prctl`이 막히면 worker는 뜨지 않는다. 그런 환경은 지금 지원 환경으로 적혀 있지 않다.

### 2. fenced activation: 응답을 받은 뒤에만 자식을 띄운다

non-dumpable은 tini의 environ을 가리지 못한다. tini는 우리 코드가 아니고, dumpable 플래그는 `execve`를 넘어 유지되지 않으므로 바깥에서 켜 줄 수도 없다. 그래서 nonce는 엔진이 뜨기 전에 **쓸모없게** 만든다.

activation은 "fence를 통과했다고 gateway가 답한 쓰기 하나"다. supervisor는 claim 응답으로 credential과 scope를 설치한 바로 다음에 `attempt_state: "starting"`인 heartbeat 하나를 보내고, 성공 응답을 받을 때까지 다음으로 가지 않는다. 그 전에는 파일을 쓰지도 자식을 띄우지도 않는다. 지금 그 자리 뒤에 오는 일은 git 설정 쓰기, 저장소 route와 패키지 설정 쓰기, checkout 준비와 복원(git 자식), 확장 받기, 엔진 시작이다.

heartbeat를 고른 이유는 서버에 필요한 것이 이미 있기 때문이다. 세션과 attempt의 row lock, fence 검사, lease 검사, 앞으로만 가는 상태 전이가 `heartbeatAtomic`에 있다. 새 endpoint는 같은 일을 하는 route를 하나 더 만든다. 다만 지금의 `Heartbeat.beatOnce()`는 거절과 시간 초과를 삼키므로 activation에 쓰지 않는다. 성공을 돌려주거나 던지는 호출을 따로 둔다.

경우별 동작은 다음과 같다.

| 경우 | worker가 하는 일 |
|---|---|
| 성공 응답 | 응답의 lease로 heartbeat 루프를 시작하고 startup으로 간다 |
| 응답을 잃었다(시간 초과, 5xx, 연결 끊김) | 같은 credential과 fence로 같은 heartbeat를 다시 보낸다. claim을 다시 하지 않는다. 첫 요청이 이미 재생을 닫았을 수 있다 |
| 401 또는 stale fence | 늦게 도착한 중복 claim이 credential을 바꿨을 수 있다. claim을 한 번 다시 하고 activation을 다시 한다. 두 번째도 거절되면 아무것도 띄우지 않고 끝난다 |
| lease가 다 됐다, 또는 세션을 잃었다 | 끝난다. 늦게 온 성공 응답이 startup을 되살리지 않는다 |
| activation 중에 stop(SIGTERM) | 끝난다. 자식을 띄우지 않는다 |

중복 claim과 activation이 같은 row를 두고 겨룰 때 순서는 둘이다. activation이 먼저 lock을 잡으면 뒤의 claim은 `starting`을 보고 거절된다. claim이 먼저 잡으면 auth revision이 올라가 activation이 거절되고, 위 표의 세 번째 줄로 간다. activation이 받아들여지기 전에는 컨테이너 안에 nonce를 읽을 적대적 프로세스가 없으므로, 그때의 재생은 worker 자신의 것뿐이다.

### 3. claim은 activation 뒤의 launch를 아무것도 쓰지 않고 거절한다

`claimAtomic`에서 "이미 claim된 launch인데 attempt가 `allocated`가 아니다"를 이미지 불일치 검사보다 먼저 판정한다. 그 경우 `invalid_credential`(HTTP 401)을 돌려주고 어떤 행도 쓰지 않는다. 첫 claim과 `allocated`인 동안의 재생은 지금과 같은 순서로 이미지를 검사한다.

이 변경 뒤에는 activation이 받아들여진 launch의 nonce로 할 수 있는 일이 없다. `workload_identity` credential은 gateway가 거절하고, 다른 worker route는 session credential을 요구하고, egress proxy는 목적별 token을 따로 본다. attempt가 `allocated`로 돌아가는 쓰기는 없다.

tini의 environ에 남은 nonce는 그래서 비밀이 아니다. 나머지 값(execution id, gateway와 proxy의 주소, bucket 이름)은 원래 비밀이 아니다.

### 버전 조합

| API | worker | 일반 재생 | 가짜 `image_runtime` 재생 |
|---|---|---|---|
| 새 버전 | 새 버전 | 엔진이 뜨기 전에 닫힌다 | 엔진이 뜨기 전에 닫힌다 |
| 새 버전 | 옛 버전 | worker의 첫 호출이 받아들여지면 닫힌다. 그 전에 엔진이 뜰 수 있다 | 같다 |
| 옛 버전 | 새 버전 | 엔진이 뜨기 전에 닫힌다 | 닫히지 않는다 |

재생 guard와 fence의 상태 전이는 첫 릴리스(`v0.1.0`)부터 API에 있다. 그래서 새 worker의 activation은 출시된 모든 API에서 일반 재생을 닫는다. 두 경로를 모두 닫으려면 API와 worker를 모두 올린다. 순서는 상관없다.

## 막는 것과 못 막는 것

엔진이 실행한 명령(같은 UID, capability 없음)을 기준으로 적는다.

| 공격 | 결과 |
|---|---|
| supervisor의 `environ` 읽기 | 막는다 |
| supervisor의 메모리 읽기(`mem`, `process_vm_readv`, ptrace) | 막는다. Yama 설정과 무관하다 |
| supervisor의 열린 fd, 메모리 지도, cwd, I/O 통계 읽기 | 막는다 |
| tini의 `environ`에서 nonce를 읽어 claim을 다시 보내기 | nonce는 읽히지만 claim은 아무것도 쓰지 않고 거절된다 |
| supervisor의 `cmdline`, `status`, `stat`의 공개 칸 읽기 | 못 막는다. 비밀이 없다. nonce와 credential은 명령행에 넣지 않는다 |
| supervisor에 신호 보내기 | 못 막는다. `SIGKILL`은 세션을 끊고 `SIGSTOP`은 멈춰 세운다. 값은 새지 않고, lease 만료가 세션을 회수한다 |
| HOME·`/tmp`·workspace의 파일 고치기 | 못 막는다. 세 곳 모두 같은 UID가 쓴다 |
| egress proxy에 worker로서 요청하기 | 못 막는다. 네트워크 위치가 같다. route마다 token이 필요하다 |

### 엔진이 볼 수 있는 credential

non-dumpable이 지키는 것은 supervisor만 가진 값이다. supervisor가 자식에게 넘긴 값은 그 자식의 environ이나 메모리에 있고, 자식은 dumpable이다.

| 값 | 어디에 있나 | 엔진이 실행한 명령이 읽을 수 있나 |
|---|---|---|
| `session_credential` | supervisor 메모리 | 없다 |
| object store token | supervisor 메모리 | 없다 |
| MCP 서버의 upstream token | supervisor 메모리(relay) | 없다 |
| 저장소 route token | supervisor가 띄운 git의 env(`GIT_CONFIG_VALUE_*`) | 그 git이 도는 동안 읽을 수 있다 |
| 저장소 비밀번호(route가 없는 옛 설정) | supervisor가 띄운 git의 env(`WORKER_GIT_PASSWORD`) | 그 git이 도는 동안 읽을 수 있다. egress token이 아니라 저장소의 실제 자격 증명이다 |
| provider egress token | Claude는 file descriptor 또는 `ANTHROPIC_AUTH_TOKEN`, Codex는 env | 읽을 수 있다. 엔진이 provider를 부르는 데 쓰는 값이다 |
| Codex MCP relay secret | Codex의 env | 읽을 수 있다. upstream token과 다른 값이고 worker 안의 relay에만 통한다 |
| packages token | HOME의 패키지 매니저 설정 파일 | 읽을 수 있다 |
| 사용자가 준 환경 변수 | 엔진의 env | 읽을 수 있다. 엔진에 주려고 넣은 값이다 |

저장소 비밀번호를 뺀 아래쪽 값들은 attempt 범위의 egress token이거나 엔진에 주기로 한 값이다. 그 범위가 곧 엔진의 권한이다. 저장소 비밀번호는 claim이 저장소 route를 주지 않는 옛 설정에서만 넘어가며, attempt보다 오래 사는 값이다. 이 설계는 이 표의 어느 값도 범위를 바꾸지 않는다.

### supervisor가 읽는, 같은 UID가 쓸 수 있는 것

이 설계는 **기밀성** 경계이지 무결성 경계가 아니다. supervisor는 엔진이 뜬 뒤에도 다음을 읽는다.

- `$HOME/.werft/`의 git identity·trailer·strip 파일. attribution repair가 읽는다.
- workspace의 `.git/config`와 include, index, refs, objects, attributes. checkpoint capture가 git을 돌린다.
- `.git/werft-*` 아래의 임시 저장소와 index.
- `CODEX_HOME/sessions/` 아래의 Codex rollout 파일. supervisor가 열어서 올린다.
- HOME과 `/tmp`의 runtime 상태와 cache.

이것들은 supervisor가 읽는 입력이지 supervisor 안에서 코드가 실행되는 길은 아니다. 확인한 것은 다음과 같다. supervisor의 코드(`/app`)는 읽기 전용 rootfs에 있다. worker 소스에는 지연 `import()`가 없다. Bun 1.3.14는 `SIGUSR1`로 디버거를 열지 않고 종료한다. supervisor가 workspace에서 git을 돌릴 때 hook·fsmonitor·filter를 끈다. 마지막 것은 설정된 이름을 세어 끄는 방식이라, 저장소가 동시에 바뀌는 경우까지 보장하지는 않는다.

supervisor가 읽은 내용을 대신 내보내는 경로(rollout 올리기, checkpoint)는 non-dumpable로 막히지 않는다. 같은 UID는 supervisor가 여는 경로를 symlink로 바꿀 수 있다. Codex rollout은 경로를 따라 `stat`한 뒤 따로 연다. 이 경로로 무엇이 나갈 수 있는지는 이 설계에서 검증하지 않았다.

무결성까지 필요해지면 아래 대안 C로 간다.

## 대안

| | A. `hidepid` | B. 한 컨테이너 안의 UID 분리 | C. 컨테이너 둘(supervisor와 엔진) | **D. non-dumpable + activation** |
|---|---|---|---|---|
| supervisor `environ`·메모리 | 못 막는다. `hidepid=1`·`2`는 같은 UID의 프로세스를 가리지 않는다 | 막는다 | 막는다. PID namespace가 다르다(`shareProcessNamespace`를 켜지 않는 한) | 막는다 |
| tini `environ` | 못 막는다 | init을 다른 UID로 두면 막는다 | 막는다 | 못 막는다. activation이 값을 무효로 만든다 |
| 신호 | 못 막는다 | 막는다 | 막는다 | 못 막는다 |
| 파일 변조 | 못 막는다 | 소유자·그룹·상위 디렉터리 권한을 따로 맞춰야 막는다. workspace는 둘 다 써야 한다 | 공유 volume은 여전히 둘 다 쓴다. HOME과 `/tmp`는 나뉜다 | 못 막는다 |
| LocalDocker | `/proc`을 다시 마운트해야 한다. `CAP_SYS_ADMIN`이 필요하다 | `CAP_SETUID`·`CAP_SETGID`를 줘야 한다 | 세션마다 컨테이너 둘, 공유 volume, 공유 네트워크 | 바뀌는 것 없음 |
| Kubernetes | `procMount`에 `hidepid`가 없다 | capability를 더해야 한다. Pod Security `restricted`를 어긴다 | Pod에 컨테이너 둘. 권한 추가 없음 | 바뀌는 것 없음 |
| 엔진 둘에 주는 영향 | 없음 | 엔진을 다른 UID로 띄우는 launcher, workspace·HOME 권한 조정 | 엔진을 다른 컨테이너에서 띄우는 원격 launcher. stdio, API 키 fd, MCP relay, 종료 관찰을 컨테이너 너머로 옮겨야 한다 | 없음 |
| 운영 복잡도 | 낮음 | 중간. 권한을 가진 launcher가 새 공격면이다 | 높음. 두 backend의 수명 관리, 자원 상한, 회수가 모두 두 배가 된다 | 낮음 |
| 운영자에게 요구하는 것 | 추가 capability | 추가 capability | 없음 | 없음 |

- **A를 버린 이유**: 같은 UID를 가리지 못하므로 이 문제를 풀지 못한다. 권한도 더 요구한다.
- **B를 버린 이유**: `no-new-privileges`와 `CapDrop: ALL` 아래의 지금 launcher는 UID를 바꿀 수 없다. 풀려면 `CAP_SETUID`·`CAP_SETGID`가 필요하고, 지금의 비특권 실행 계약(`runAsNonRoot`, capability 전부 제거)을 깬다. 운영자에게 새 권한을 요구하는 설계다.
- **C를 지금 하지 않는 이유**: 가장 강한 경계이고 권한도 요구하지 않는다. 그러나 두 실행 backend와 두 엔진 어댑터를 모두 다시 짜야 하고, 공유 volume의 파일 변조는 C로도 남는다. 인수 기준이 요구하는 것(environ과 메모리를 읽지 못한다, nonce 재생이 거절된다)은 D로 채워진다. 엔진이 supervisor를 멈추거나 HOME의 파일로 속이는 것까지 막아야 할 때 C를 한다. D는 C로 갈 때 버릴 것이 없다. activation과 claim의 판정 순서는 그대로 필요하고, non-dumpable은 supervisor 컨테이너 안의 방어로 남는다.
- **credential broker 사이드카**: 처음에 꼽은 세 번째 선택지다. supervisor가 이미 그 broker 역할을 한다(gateway 호출, object store 접근, MCP relay). 이것을 컨테이너 밖으로 빼는 것이 C다.
- **nonce를 tini의 environ에서 빼기**: tini 앞에 wrapper를 두고, nonce를 한 번 읽고 지우는 파일이나 pipe로 옮긴 뒤 env를 비우고 tini를 `exec`하면 된다. 엔진이 뜨기 전에 지워지므로 효과는 있다. 하지 않는 이유는 activation 뒤의 nonce가 이미 아무 일도 못 하기 때문이다. 이미지 entrypoint 계약을 두 backend에서 바꾸는 비용에 비해 얻는 것이 없다. nonce를 받는 새 경로가 생기면 다시 본다.
- **claim 재생을 아예 없애기**: 응답을 잃은 claim이 lease 만료까지 세션을 묶는다. activation은 재생의 쓸모는 남기고 창만 닫는다.

## 구현 단위

| PR | 내용 | 시험 |
|---|---|---|
| 1 | claim의 판정 순서(위 3)와 fenced activation(위 2) | PostgreSQL 통합 시험: activation 뒤의 일반 재생과 가짜 `image_runtime` 재생이 모두 401이고 launch·execution·credential·attempt·session 행과 `worker_image_refusals`가 그대로다. activation과 중복 claim이 같은 row를 두고 겨루는 두 순서(activation이 먼저, claim이 먼저)를 lock으로 강제해 각각 확인한다. worker 단위 시험: activation 전에 파일 쓰기와 자식 실행이 없다, 응답 손실·401·lease 만료·stop의 경우별 동작. e2e: 엔진이 실행한 명령이 tini의 environ에서 nonce를 읽어 claim을 보내면 401이고 turn은 끝까지 간다 |
| 2 | supervisor non-dumpable(위 1) | e2e: 실제 scheduler가 LocalDockerBackend로 실제 Docker daemon에 띄운 worker 컨테이너에서, 엔진이 실행한 명령이 supervisor의 `environ`·`fd`·`mem`을 읽지 못한다. 같은 명령이 tini의 `environ`은 읽는다(읽을 수 있는 대조군). 명령의 UID와 capability를 함께 찍는다 |

두 PR은 서로 의존하지 않는다. 두 엔진의 conformance 스위트는 바뀌지 않고 통과해야 한다.

## 운영자에게 바뀌는 것

- 배포 요구는 바뀌지 않는다. 이미지 사용자, capability, `securityContext`, 커널 설정이 그대로다.
- 두 경로를 모두 닫으려면 API와 worker 이미지를 모두 올린다.
- supervisor 프로세스의 `/proc/<pid>/` 항목 가운데 환경, 메모리, 메모리 지도, cwd, 열린 descriptor는 컨테이너 안에서 worker 사용자로는 읽을 수 없다. 명령행과 프로세스 이름은 누구에게나 보인다. capability 없는 root는 열린 descriptor의 번호만 보고, 메모리 지도와 cwd는 읽지 못한다(측정함. 환경과 메모리도 같은 검사를 거친다). 디버깅에는 root이면서 `CAP_SYS_PTRACE`를 가진 프로세스가 필요하다. Docker에서는 `docker exec --privileged -u 0`이다(측정함: `--privileged`만 주고 worker 사용자로 들어가면 읽지 못한다). Kubernetes에서는 worker 컨테이너를 대상으로 하고 root와 `CAP_SYS_PTRACE`를 주는 debug 컨테이너가 필요하다(측정하지 않음). supervisor는 core dump를 남기지 않는다.
- worker 이미지를 직접 만드는 경우: supervisor는 Linux에서 `prctl`을 부르지 못하면 뜨지 않는다. 배포하는 이미지(Debian, glibc)에서는 해당하지 않는다.

## 확인하지 못한 것

- gVisor·Kata 같은 sandbox runtime에서 `/proc`이 dumpable 플래그를 같은 방식으로 지키는지는 측정하지 않았다.
- supervisor의 git이 동시에 바뀌는 저장소에서 저장소가 정한 코드를 절대 실행하지 않는다는 것은 증명하지 않았다.
