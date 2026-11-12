# 결정(설계): worker supervisor와 엔진·git 자식 프로세스 사이의 경계

- 상태: 설계안(2026-11-12). 구현 전이다.
- 결정한 사람: 이 결정은 작업자 판단이다. 오너 지시는 순서에 대한 것이다(2026-11-12: "리팩토링 끝나면 추천 순서대로 대응해줘", "전체적으로 추천대로 하면될듯?").

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

env의 비밀은 nonce 하나로 줄었다. 대신 supervisor의 **메모리**에는 claim 응답으로 받은 값이 있다. 엔진이 봐서는 안 되는 값은 `session_credential`(gateway 쓰기 권한), object store token, MCP token이다. 계약 주석은 MCP token을 엔진에 넘기지 않는다고 적었지만, `/proc/<pid>/mem`을 읽을 수 있는 호스트에서는 그 약속이 지켜지지 않는다.

### nonce 재생 창

`bootstrapClaim`을 같은 nonce로 다시 부르면, attempt가 `allocated`인 동안에는 같은 binding에 새 `session_credential`을 발급하고 이전 것을 폐기한다. 응답을 잃은 claim을 되살리는 경로다. 엔진이 실행한 명령이 nonce를 읽어 재생하면 supervisor의 credential이 죽고 그 명령이 세션을 가진다.

attempt가 `allocated`를 벗어나는 곳은 두 군데다. heartbeat가 `starting`을 보고할 때와 `nextInput`이 첫 turn을 넘길 때다. worker의 heartbeat 루프는 첫 beat를 주기(기본 5초)만큼 기다린 뒤 보낸다. 그 사이에 worker는 git 설정을 쓰고 checkout을 준비하고 엔진을 띄울 수 있다. 창은 보통 5초 안에 닫히지만, 엔진이 그 전에 뜨지 않는다는 보장은 없다. nonce 자체는 발급 뒤 10분이 지나면 만료된다.

## 무엇을 골랐나

두 가지를 함께 한다. 어느 쪽도 운영자에게 새 권한, 이미지 사용자 변경, Helm 값 변경을 요구하지 않는다.

### 1. supervisor를 non-dumpable로 만든다

supervisor가 시작하자마자, 설정을 읽거나 자식을 띄우기 전에 자기 자신에게 `prctl(PR_SET_DUMPABLE, 0)`을 부른다. `ssh-agent`와 `gpg-agent`가 같은 UID로부터 키를 지키는 방법과 같다.

커널은 dumpable이 아닌 프로세스에 대해 다음을 한다.

- `/proc/<pid>/` 아래 파일의 소유자를 root로 바꾼다.
- `CAP_SYS_PTRACE`가 없는 프로세스의 ptrace 접근 검사를 거절한다. UID가 같아도 거절한다. `environ`, `mem`, `maps`, `fd`, `cwd`, `root`, `exe`, `ptrace(2)`, `process_vm_readv(2)`가 이 검사를 거친다.
- core dump를 만들지 않는다.

worker 컨테이너는 capability를 전부 버리고 `no-new-privileges`로 돌기 때문에, 엔진이 실행한 명령이 `CAP_SYS_PTRACE`를 얻을 길이 없다.

같은 조건에서 다시 측정한 결과다.

| 확인한 것 | supervisor(non-dumpable) | tini(PID 1) |
|---|---|---|
| `environ` 소유자 | `0:0` | `1000:1000` |
| 자식이 `environ` 읽기 | 실패(`Permission denied`) | 성공 |
| 자식이 `fd` 나열, `cwd` 읽기, `maps` 읽기 | 모두 실패 | 모두 성공 |
| 자식이 `mem` 열기 | 실패 | 실패(Yama) |

supervisor 자신이 쓰는 경로는 그대로 동작했다. `/proc/self/fd` 나열, `/proc/self/fd/<n>`을 거친 `statfs`·`lstat`·`readlink`·`readdir`(동기와 비동기 모두), `/proc/self/mountinfo`, 자식의 `/proc/<pid>/task/<tid>/children`, 그리고 git 실행이다. 자식 프로세스는 `execve` 때 dumpable로 돌아가므로 엔진과 git의 동작은 바뀌지 않는다.

구현 방식은 다음과 같다.

- `bun:ffi`로 libc의 `prctl`을 부른다. 새 의존성이나 네이티브 빌드가 없다.
- Linux에서 `prctl`이 실패하거나 다시 읽은 값이 0이 아니면 supervisor는 시작하지 않는다. 경계 없이 조용히 도는 것보다 뜨지 않는 편이 낫다. `PR_SET_DUMPABLE`은 모든 Linux 커널에 있고 Docker 기본 seccomp와 Kubernetes `RuntimeDefault`가 `prctl`을 허용한다.
- Linux가 아니면(개발자 macOS의 직접 실행) 아무것도 하지 않는다.

### 2. fenced activation으로 nonce를 무효로 만든다

non-dumpable은 tini의 environ을 가리지 못한다. tini는 우리 코드가 아니고, dumpable 플래그는 `execve`를 넘어 유지되지 않으므로 바깥에서 켜 줄 수도 없다. 그래서 nonce는 감추지 않고 **쓸모없게** 만든다.

supervisor는 claim 응답을 받은 직후, 다른 일을 하기 전에 `attempt_state: "starting"`인 heartbeat 하나를 보내고 그 응답을 기다린다. 이 heartbeat는 다른 worker 호출과 같은 fence(attempt, lease epoch, execution generation, auth revision)를 지난다. 서버는 이 beat에서 attempt를 `allocated`에서 `starting`으로 옮긴다. 그 뒤 같은 nonce의 `bootstrapClaim`은 `invalid_credential`(HTTP 401)로 거절되고 아무것도 쓰지 않는다. supervisor의 credential도 그대로 남는다.

순서는 worker가 지킨다. activation이 받아들여지기 전에는 자식 프로세스를 하나도 띄우지 않는다. git 설정 쓰기, checkout 준비, 복원, 엔진 시작이 모두 그 뒤다.

- activation이 일시적으로 실패하면(네트워크, 5xx, lock timeout) claim이 준 lease 안에서 재시도한다.
- activation이 확정적으로 거절되면(401, stale epoch, lease 만료) worker는 세션을 잃은 것으로 보고 아무것도 띄우지 않은 채 끝난다.
- 서버 계약과 route는 바뀌지 않는다. heartbeat가 `starting`을 받아 상태를 옮기는 동작은 이미 있다. 새 worker와 옛 API, 옛 worker와 새 API가 모두 그대로 동작한다. 옛 worker는 지금의 재생 창을 그대로 가진다.

activation 뒤에 nonce로 할 수 있는 일은 없다. 그래서 tini의 environ에 남은 값은 비밀이 아니다. tini의 environ에 있는 나머지 값(execution id, gateway와 proxy의 주소, bucket 이름)은 원래 비밀이 아니다.

## 막는 것과 못 막는 것

엔진이 실행한 명령(같은 UID, capability 없음)을 기준으로 적는다.

| 공격 | 결과 |
|---|---|
| supervisor의 `environ` 읽기 | 막는다 |
| supervisor의 메모리 읽기(`mem`, `process_vm_readv`, ptrace) | 막는다. Yama 설정과 무관하다 |
| supervisor의 열린 fd, 메모리 지도, cwd 읽기 | 막는다 |
| tini의 `environ`에서 nonce를 읽어 재생 | nonce는 읽히지만 재생은 거절된다 |
| supervisor에 신호 보내기(`kill`) | 못 막는다. 세션이 끊길 뿐 값은 새지 않는다. lease 만료가 세션을 회수한다 |
| HOME·`/tmp`·workspace의 파일 고치기 | 못 막는다. 세 곳 모두 같은 UID가 쓴다 |
| supervisor가 띄운 git 등 다른 자식의 `environ`·메모리 읽기 | 못 막는다. 그 자식들은 dumpable이다. 엔진이 봐서는 안 되는 값은 그 자식들에 넘기지 않는다 |
| egress proxy에 worker로서 요청하기 | 못 막는다. 네트워크 위치가 같다. route마다 token이 필요하고, 엔진이 가진 token의 범위가 곧 엔진의 권한이다 |

파일을 고쳐서 supervisor 안에서 코드를 실행시키는 길은 따로 확인했다.

- supervisor의 코드(`/app`)는 읽기 전용 rootfs에 있다.
- worker 소스에는 지연 `import()`가 없다.
- Bun 1.3.14는 `SIGUSR1`로 디버거를 열지 않는다. 신호를 받으면 종료한다.
- supervisor가 workspace에서 git을 돌릴 때 저장소의 hook·fsmonitor·filter는 실행되지 않는다.

그래도 이 설계는 **기밀성** 경계이지 무결성 경계가 아니다. 같은 UID가 쓰는 디렉터리를 supervisor가 읽는 한, 새 코드가 그 길을 다시 열 수 있다. 무결성까지 필요해지면 아래 대안 C로 간다.

## 대안

| | A. `hidepid` | B. 한 컨테이너 안의 UID 분리 | C. 컨테이너 둘(supervisor와 엔진) | **D. non-dumpable + activation** |
|---|---|---|---|---|
| supervisor `environ`·메모리 | 못 막는다. `hidepid`는 다른 UID의 프로세스만 가린다 | 막는다 | 막는다. PID namespace가 다르다 | 막는다 |
| tini `environ` | 못 막는다 | init을 다른 UID로 두면 막는다 | 막는다 | 못 막는다. activation이 값을 무효로 만든다 |
| 신호, 파일 변조 | 못 막는다 | 막는다 | 막는다 | 못 막는다 |
| LocalDocker | `/proc`을 다시 마운트해야 한다. `CAP_SYS_ADMIN`이 필요하다 | 컨테이너를 root로 시작하고 `CAP_SETUID`·`CAP_SETGID`를 줘야 한다 | 세션마다 컨테이너 둘, 공유 volume, 공유 네트워크 | 바뀌는 것 없음 |
| Kubernetes | `procMount`에 `hidepid`가 없다 | `runAsNonRoot`를 풀고 capability를 더해야 한다. Pod Security `restricted`를 어긴다 | Pod에 컨테이너 둘. 권한 추가 없음 | 바뀌는 것 없음 |
| 엔진 둘에 주는 영향 | 없음 | 엔진을 다른 UID로 띄우는 launcher, workspace·HOME 권한 조정 | 엔진을 다른 컨테이너에서 띄우는 원격 launcher, stdio·API 키 fd·MCP relay·종료 관찰을 컨테이너 너머로 옮겨야 한다 | 없음 |
| 운영 복잡도 | 낮음 | 중간. root로 시작하는 init이 새 공격면이다 | 높음. 두 backend의 수명 관리, 자원 상한, 회수가 모두 두 배가 된다 | 낮음 |
| 운영자에게 요구하는 것 | 추가 capability | 추가 capability, root 시작 | 없음 | 없음 |

- **A를 버린 이유**: 같은 UID를 가리지 못하므로 이 문제를 풀지 못한다. 권한도 더 요구한다.
- **B를 버린 이유**: `no-new-privileges`와 `CapDrop: ALL` 아래에서는 UID를 바꿀 수 없다. 풀려면 컨테이너가 root와 `CAP_SETUID`·`CAP_SETGID`로 시작해야 하고, 지금의 비특권 실행 계약(`runAsNonRoot`, capability 전부 제거)을 깬다. 운영자에게 새 권한을 요구하는 설계다.
- **C를 지금 하지 않는 이유**: 가장 강한 경계이고 권한도 요구하지 않는다. 그러나 두 실행 backend와 두 엔진 어댑터를 모두 다시 짜야 한다. 인수 기준이 요구하는 것(environ과 메모리를 읽지 못한다, nonce 재생이 거절된다)은 D로 채워진다. 엔진이 supervisor를 죽이거나 파일로 속이는 것까지 막아야 할 때 C를 한다. D는 C로 갈 때 버릴 것이 없다. activation은 그대로 필요하고, non-dumpable은 supervisor 컨테이너 안의 방어로 남는다.
- **credential broker 사이드카**: 처음에 꼽은 세 번째 선택지다. supervisor가 이미 그 broker 역할을 한다(gateway 호출, object store 접근, MCP relay). 이것을 컨테이너 밖으로 빼는 것이 C다.
- **nonce를 환경 변수 대신 파일로 주기**: 같은 UID가 파일을 읽으므로 나아지지 않는다.
- **claim 재생을 아예 없애기**: 응답을 잃은 claim이 lease 만료까지 세션을 묶는다. activation은 재생의 쓸모는 남기고 창만 닫는다.

## 구현 단위

| PR | 내용 | 인수 기준 |
|---|---|---|
| 1 | fenced activation. worker가 claim 직후 `starting` heartbeat를 보내고 응답을 받은 뒤에만 자식을 띄운다. worker 단위 시험이 순서를 고정한다 | activation 뒤 nonce 재생이 거절되고 worker의 credential이 살아 있음을 확인하는 PostgreSQL 통합 시험 |
| 2 | supervisor non-dumpable. 시작 시 `prctl`, 실패하면 기동 거부 | 실제 worker 이미지를 LocalDockerBackend로 띄워 `/proc/<supervisor pid>/environ` 읽기가 실패함을 확인하는 실 daemon 시험 |

두 PR은 서로 의존하지 않는다. 두 엔진의 conformance 스위트는 바뀌지 않고 통과해야 한다.

## 운영자에게 바뀌는 것

- 배포 요구는 바뀌지 않는다. 이미지 사용자, capability, `securityContext`, 커널 설정이 그대로다.
- supervisor 프로세스의 `/proc/<pid>/` 항목(`environ`, `fd`, `maps`)은 컨테이너 안에서 worker 사용자나 capability 없는 root로는 읽을 수 없다. 디버깅에는 `CAP_SYS_PTRACE`가 있는 exec(`docker exec --privileged`, `kubectl debug`)을 쓴다. supervisor는 core dump를 남기지 않는다.
- worker 이미지를 직접 만드는 경우: supervisor는 Linux에서 `prctl`을 부르지 못하면 뜨지 않는다. 배포하는 이미지(Debian, glibc)에서는 해당하지 않는다.

## 확인하지 못한 것

- gVisor·Kata 같은 sandbox runtime에서 `/proc`이 dumpable 플래그를 같은 방식으로 지키는지는 측정하지 않았다. 지원 환경으로 적은 runtime(Docker의 runc, Kubernetes 기본 runtime)에서는 커널이 직접 판정한다.
- x86-64에서는 구현 PR의 CI가 측정한다. 위 표는 arm64 결과다.
