# 결정(제안): Kubernetes에서 worker Pod를 누가 만드나

상태: 제안(2026-10-31).

이 문서가 바꾸는 기본값은 없다. 지금 설치는 그대로 scheduler가 Pod를 만든다.

control plane(api·scheduler·reconciler)은 어느 안에서도 남는다. 세션의 상태, 슬롯, lease, checkpoint는 계속 플랫폼이 쥔다. 이 문서가 고르는 것은 **worker Pod를 누가 만드느냐**뿐이다.

## 무엇을 골랐나

**0안: 지금처럼 플랫폼(scheduler)이 Pod를 만들되, 권한을 worker 전용 namespace의 Pod·PVC로 줄인다.** nonce Secret을 projected ServiceAccount token으로 바꿔 `secrets` 권한을 없애고, scheduler가 만들 수 있는 Pod를 ValidatingAdmissionPolicy로 worker spec에 묶는다. 세션별 이미지·리소스·재개 제어, 종료 확인, 세션별 workspace가 지금 그대로 남는다. 아래 "0안" 절이 그 내용이다.

**1안(KEDA pull)은 설계해 두고 고르지 않는다.** "플랫폼이 Kubernetes 권한을 하나도 갖지 않는다"가 요구 사항이 되고, 이미지·크기를 class 몇 개로 묶어도 되는 설치가 생기면 opt-in 모드로 꺼낸다. 아래 "1안 설계"가 그때 쓸 설계다. 처음 판은 1안을 추천했다. 0안을 같은 비교 축에 올려 다시 보니, 1안이 0안보다 더 주는 것은 "Pod·PVC 생성 권한 0"과 "어댑터 코드 삭제"이고, 그 값으로 세션별 이미지(진행 중인 runtime 고정 작업과 부딪친다), 종료 확인, checkpoint 없는 작업의 구출 경로를 내준다. 0안은 지금 권한에서 가장 위험한 두 가지(release namespace의 Secret 읽기, 모든 Pod 로그 읽기)를 같은 비용 없이 없앤다.

## 1안 요약

Kubernetes 설치에 실행 모드 `kubernetes_pull`을 opt-in으로 하나 더 둔다. 이 모드에서는 플랫폼(api·scheduler)이 Kubernetes API를 부르지 않는다.

- 클러스터의 [KEDA](https://keda.sh/) `ScaledJob`이 플랫폼에 "지금 worker를 받을 수 있는 대기 세션이 몇 개인가"를 묻고, 그 수만큼 worker Job을 만든다.
- 새로 뜬 worker는 어떤 세션에도 묶이지 않은 채 시작한다. 자기 Pod에 묶인 ServiceAccount token을 내고 claim해서 대기 세션 하나를 받는다. launch 행은 이때 생긴다.
- 플랫폼에는 Role도 RoleBinding도 없다. Pod를 만들고 지우는 일은 KEDA와 Job controller, workspace 볼륨은 Pod를 따라 생기고 사라지는 generic ephemeral volume이 맡는다.
- 대가로 **종료 계약이 바뀐다.** 지금은 "Pod가 사라진 것을 확인한 뒤 슬롯을 돌려준다". pull 모드의 플랫폼은 Pod를 볼 수 없으므로 "worker를 펜싱하고(그 뒤로 proxy는 그 worker의 자격 증명 사용을 거절한다) 유예가 지나면 돌려준다"가 된다. 아래 "종료 계약"이 이 차이와 그 근거를 적는다.

기존 `kubernetes` 모드(push)는 기본값으로 그대로 두고 설정으로 고른다. compose 설치는 지금처럼 `local_docker`다. 1안에 대한 Codex의 반대 의견과 대안은 "다른 의견"에 그대로 남긴다.

```text
          ┌──────────── 플랫폼 (K8s 권한 없음) ────────────┐
          │ api  GET  /internal/execution/demand           │
          │      POST /worker/bootstrap-claim (SA token)   │
          └──────▲──────────────────────────▲──────────────┘
    claim 가능한 │ 대기 수 (metrics-api)     │ claim → 세션 하나, launch 행 생성
          ┌──────┴────────┐   Job 생성   ┌──┴─────────────────────┐
          │ KEDA          │────────────▶│ worker Job (Pod 하나)  │
          │ ScaledJob     │             │ ephemeral workspace    │
          │ (class마다)   │             │ egress는 proxy로만     │
          └───────────────┘             └────────────────────────┘
          ValidatingAdmissionPolicy가 worker namespace의 Pod spec을 강제한다
```

## 지금 구조

[Kubernetes 실행 backend](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/kubernetes-backend/)와 `packages/adapters/execution/kubernetes`가 정본이다. 요약하면 다음과 같다.

- scheduler pass가 대기 세션마다 launch를 예약하고(`worker_launches` 행, generation, 이미지·리소스 고정), `ensureExecution`으로 Pod 하나, Pod가 소유하는 nonce Secret 하나, 세션 workspace PVC(`ap-ws-<installation>-<session>`)를 만든다(`packages/platform/src/scheduler/launch.ts`, `kubernetes/src/backend.ts`).
- scheduler Role은 worker namespace 하나에 걸리고 `pods`·`secrets`·`persistentvolumeclaims`의 get·list·create·delete와 `pods/log` get을 갖는다(`deploy/helm/werft/templates/scheduler.yaml`). SA token을 마운트하는 Pod는 scheduler뿐이다.
- chart에는 worker namespace를 따로 정하는 값이 없다. `EXECUTION_K8S_NAMESPACE`의 기본값은 scheduler 자신의 namespace이고, chart의 Role과 RoleBinding도 release namespace에 생긴다(`scheduler.yaml:174`). 그 namespace에는 앱 Secret(`DATABASE_URL`, `PLATFORM_SECRET_KEY`, provider 키 등, `templates/api.yaml`, `external-secret.yaml`)이 있다. 그래서 지금 scheduler SA는 그 Secret을 모두 읽을 수 있고, Pod를 만들 수 있으므로 그 Secret을 마운트한 Pod도 만들 수 있다.
- worker는 env의 nonce를 내고 `POST /worker/bootstrap-claim`으로 binding(세션, attempt, lease epoch, 토큰)을 받는다. 그 뒤 heartbeat와 `/next-input` long poll을 돈다. lease를 잃으면 진행 중인 turn을 버리고 exit 75로 끝난다(`apps/worker/src/worker-host.ts`).
- 종료와 슬롯: terminate·lease 만료는 lease epoch를 올리고 `executions.desired_state=terminated`를 적는다. 이때 `pod_id`·`execution_id`를 남겨 "제거가 확인될 때까지 새 claim이 시작되지 않게" 한다(`packages/db/src/lease-reconcile.ts:150-180`). 슬롯 반환, binding 제거, 기동 실패 집계는 scheduler가 Pod가 사라진 것을 확인하는 경로에서만 일어난다(`packages/db/src/worker-unit-of-work.ts:3029-3289`).
- lease가 만료되면 그 attempt의 worker 자격 증명이 폐기된다(`packages/db/src/lease-reconcile.ts:130-138`). worker의 egress는 NetworkPolicy로 egress proxy에만 열려 있다(`deploy/helm/werft/templates/networkpolicies.yaml`).
- reconcile이 Pod를 inspect해서 기동 실패(backoff 뒤 5회면 quarantine), 낡은 isolation stamp, nonce 만료, launch spec 불일치를 교체하고, 실패한 Pod의 로그 tail을 읽는다.
- 이미지와 리소스(`WORKER_IMAGE`, `WORKER_CPUS`, `WORKER_MEMORY_MB`, `WORKER_PIDS_LIMIT`)는 설치 전역이다. launch 예약 때 이미지 digest를 고정한다.

pull로 옮길 때 이미 준비된 자리도 있다.

| 이미 있는 것 | 위치 |
| --- | --- |
| claim 요청의 credential에 `workload_identity` 종류가 있다. 지금 gateway는 403으로 거절한다 | `packages/contracts/src/worker-protocol/index.ts:66-71`, `packages/platform/src/workers/worker-gateway.ts:981-987` |
| launch의 `session_id`가 null이면 claim이 partition의 맨 앞 대기 세션을 `SKIP LOCKED`로 고른다 | `packages/db/src/worker-unit-of-work.ts:1610-1637` |
| worker는 기다리는 세션이 없으면 `NOT_FOUND`로 스스로 나간다("KEDA-style launchers must see it leave") | `apps/worker/src/worker-host.ts:796-800` |
| 세션의 `partition`은 "이 세션을 돌릴 worker pool"이고 생성 뒤 바뀌지 않는다 | `packages/db/src/schema.ts:1118-1122` |
| launch에 drain 요청 시각(`drain_requested_at`)이 있다 | `packages/db/src/schema.ts:2263` |

## 왜 다시 보나

- 지금 scheduler SA는 release namespace의 모든 Secret과 모든 Pod 로그를 읽는다. 앱 Secret에 닿는 이 넓은 권한은 0안과 1안 모두 없앤다.
- scheduler는 DB 접속과 클러스터 쓰기 권한(Pod·PVC)을 함께 쥔다. 이 결합을 없애는 것은 1안(또는 5안)뿐이다. 0안에서는 그대로 남고, 대신 admission이 그 쓰기로 만들 수 있는 Pod를 묶는다.
- 1안만 주는 것: Pod 수명 관리를 표준 부품에 넘긴다. Pod·Secret·PVC 생성 순서, UID 조건부 삭제, adopt 판단, 로그 tail 읽기(어댑터 약 1,000줄과 같은 양의 테스트)가 플랫폼 코드에서 빠진다.
- 노드 자동 확장, ResourceQuota처럼 클러스터 운영자가 쓰는 도구는 두 안 모두에 걸린다. 1안은 PriorityClass 같은 Pod 필드를 chart 템플릿에서 바로 고치고, 0안은 그 값을 scheduler 설정으로 넘겨야 한다(지금 nodeSelector·tolerations가 그렇다).
- 비슷한 제품을 보면 두 갈래가 있다. GitHub ARC는 listener가 GitHub를 long poll하고, runner가 뜬 뒤 job을 받는다([ARC](https://docs.github.com/en/actions/concepts/runners/actions-runner-controller)). Azure Pipelines agent는 KEDA scaler로 뜨고 `--once`로 job 하나를 받는다([KEDA azure-pipelines](https://keda.sh/docs/latest/scalers/azure-pipelines/)). GitLab Runner([Kubernetes executor](https://docs.gitlab.com/runner/executors/kubernetes/))와 Buildkite([agent-stack-k8s](https://buildkite.com/docs/agent/v3/agent-stack-k8s))는 클러스터 안의 controller가 job마다 Pod를 만든다. 어느 쪽이든 SaaS 본체는 클러스터 권한을 갖지 않는다. 우리 scheduler는 DB를 쥔 채 Pod를 만들므로 둘 중 어디에도 맞지 않는다.

## 후보

먼저 두 주요 후보를 오너가 정한 비교 축으로 놓는다.

| 축 | 0 플랫폼 직접 생성, 권한 축소 (고름) | 1 KEDA ScaledJob pull |
| --- | --- | --- |
| 세션별 이미지·리소스 | 자유. launch마다 정한다 | class(partition + 이미지 digest) 단위. 고정 템플릿 하나가 class 하나 |
| 재개 제어 | 지금과 같음. 세션이 고정한 이미지로 재개(진행 중인 runtime 고정 작업)가 그대로 들어간다 | 그 이미지의 class가 남아 있어야 재개된다. 재개 가능한 세션이 고정한 digest마다 class를 유지 |
| 종료 확인 | scheduler가 Pod가 사라진 것을 보고 슬롯을 돌려준다(지금 계약) | 플랫폼은 Pod를 못 본다. 펜싱 + 유예로 대신하고 NetworkPolicy 강제가 필수 |
| workspace | 세션별 PVC. checkpoint 없는 작업도 TTL 안에 구출 가능 | Pod와 함께 사라진다. 마지막 checkpoint까지만 복구 |
| 플랫폼 K8s 권한 | worker 전용 namespace의 `pods`·`persistentvolumeclaims` get·list·create·delete(실패 로그를 읽으면 `pods/log` get). 만들 수 있는 Pod는 admission이 worker spec으로 묶는다 | 없음 |
| 클러스터 쪽 새 권한 | 없음(admission 정책 설치는 운영자 권한) | KEDA operator의 ClusterRole(모든 API group `get`, 기본으로 모든 namespace secrets 읽기) |
| 운영 의존성 | 새 상주 컴포넌트 없음. admission 정책(Kubernetes 1.30+)과, 0-2를 하면 api의 JWKS 접근이 필요 | KEDA(클러스터당 하나, external metrics API 등록 하나). admission 정책과 api의 JWKS 접근도 필요 |
| 시작 지연 | scheduler pass 간격(`SCHEDULER_INTERVAL_SEC` 5초) + Pod 기동. 지금과 같음 | KEDA polling 간격(5초로 둠) + Pod 기동. PoC 2.3~8.6초 |
| 격리 | 플랫폼이 Pod spec을 만들고 isolation stamp로 확인·교체(지금과 같음) + admission | chart 템플릿 + admission이 전부. 플랫폼은 spec을 보지 못한다 |
| 우리가 유지하는 K8s 코드 | 지금 어댑터(약 1,000줄과 테스트) | chart 템플릿뿐 |

두 안 사이의 차이는 결국 한 줄이다. **1안은 플랫폼의 Pod·PVC 생성 권한과 어댑터 코드를 없애는 대신, 세션별 이미지를 미리 구성한 class로 제한하고, 종료 확인과 checkpoint 없는 작업의 구출 경로를 내준다.**

나머지 후보는 다음과 같다.

| | 2 상시 worker 풀 | 3 K8s 밖 실행 서비스 | 4 operator/CRD | 5 클러스터 안 launcher |
| --- | --- | --- | --- | --- |
| 플랫폼 K8s 권한 | 없음 | 없음, 대신 클라우드 API 권한 | 우리 CR의 create·delete | 없음. launcher가 0안의 Role을 가짐 |
| 우리가 유지하는 K8s 코드 | 없음 | 없음 | operator | 지금 어댑터 전부 + launcher |
| 종료 확인 | 플랫폼은 못 본다 | 서비스마다 다름 | operator가 본다 | launcher가 보고 api로 알린다 |
| 세션 격리 | Deployment는 컨테이너만 재시작해 Pod·볼륨이 다음 세션에 남는다 | 서비스마다 다름 | 지금과 같음 | 지금과 같음 |
| 세션별 이미지·크기 | 풀 단위 | 자유 | 자유 | 자유 |
| 시작 지연 | 거의 0, 대신 늘 떠 있는 비용 | 서비스 콜드스타트 | 지금과 같음 | 지금과 같음 |
| 새 의존성 | 없음 | 외부 서비스 | 없음 | 없음 |

- **1을 지금 고르지 않은 이유**: 위 표의 마지막 한 줄. 세션별 이미지 선택이 진행 중이라 class 묶음과 바로 부딪치고, 0안이 권한 위험의 큰 부분을 같은 비용 없이 없앤다.
- **2를 버린 이유**: Deployment의 Pod는 컨테이너가 끝나도 지워지지 않고 같은 Pod에서 다시 시작한다. emptyDir와 `/tmp`가 다음 세션에 남으므로 "세션 하나에 Pod 하나"가 깨진다.
- **3을 버린 이유**: 권한이 K8s에서 클라우드 API로 옮겨갈 뿐이다. egress proxy와 NetworkPolicy로 만든 경계를 그 서비스에서 다시 만들어야 한다.
- **4를 버린 이유**: 플랫폼이 CR 쓰기 권한을 갖고, 지금 scheduler가 하는 일을 operator로 옮겨 계속 유지해야 한다. 5가 같은 이점을 CR 없이 준다.
- **5를 고르지 않은 이유**: 0안과 같은 Role을 launcher라는 다른 Pod로 옮길 뿐이다. 얻는 것은 "DB 접속과 클러스터 권한을 한 Pod가 쥐지 않는다"인데, scheduler pass가 지금 동기로 부르는 `ensureExecution`·`inspect`·`terminate`를 api 너머 비동기 요청과 보고로 바꾸는 큰 공사가 든다. 0안을 한 뒤에도 그 분리가 필요하면 그때 본다. Codex는 처음 판에서 5를 1보다 먼저 하자고 했다("다른 의견").

## 0안: 플랫폼이 직접 만들고 권한을 줄인다

control plane과 실행 경로는 지금 그대로다. 바꾸는 것은 네 가지다. 각각 따로 넣을 수 있다.

### 0-1. worker 전용 namespace

chart에 `execution.workerNamespace`를 둔다. 값이 있으면 다음을 그 namespace로 옮기고, `EXECUTION_K8S_NAMESPACE`를 그 값으로 넘긴다. 그 namespace에는 worker Pod, 그 Pod의 PVC(와 0-2 전까지는 nonce Secret)만 둔다. 앱 Secret은 release namespace에 남으므로, scheduler가 Secret을 읽거나 Secret을 마운트한 Pod를 만들어도 앱 Secret에는 닿지 않는다.

- 옮기는 것: scheduler의 Role과 RoleBinding(subject는 release namespace의 scheduler SA), worker ServiceAccount(`templates/serviceaccounts.yaml`), worker NetworkPolicy(`templates/networkpolicies.yaml`의 worker 정책), 0-4의 admission 정책 binding.
- release namespace에 남는 것: api·proxy·scheduler와 그 NetworkPolicy. proxy 정책의 ingress peer는 `namespaceSelector`(worker namespace)와 `podSelector`(worker 라벨)를 **같은 항목**에 넣는다. 따로 넣으면 OR가 되어 그 namespace의 아무 Pod나, 또는 release namespace의 worker 라벨 Pod가 들어온다. worker 정책의 egress peer도 같은 방식으로 release namespace의 proxy를 고른다.
- private registry: chart는 지금 `images.pullSecrets`를 worker Pod의 `imagePullSecrets`로 넘긴다(`templates/scheduler.yaml:45-47`, `specs.ts:292-298`). Secret은 namespace를 넘어 참조할 수 없으므로, 운영자가 같은 이름의 pull Secret을 worker namespace에도 둔다(ExternalSecret을 쓰면 그 namespace에 하나 더). 0-4의 admission은 `imagePullSecrets`를 이 목록의 이름으로만 허용한다. 순서는 pull Secret을 먼저 두고 그다음 `workerNamespace`를 켠다.
- namespace 자체는 chart가 만들지 않는다(`helm --create-namespace`처럼 release 하나가 다른 namespace의 수명을 쥐지 않게). 운영자가 미리 만들고 Pod Security Admission 라벨을 단다. 없으면 render는 되지만 install이 실패하므로 설치 안내에 적는다.
- 기본값은 비워 둔다(지금과 같은 namespace). 값을 넣는 것은 새 설치나, 아래 "이전" 순서를 따른 설치다.
- 검증: 나눈 설치에서 worker → proxy가 통하고, worker namespace의 다른 Pod → proxy와 worker → api·외부 직접 접속이 막힌다.

### 0-2. nonce Secret 대신 projected ServiceAccount token

1안의 "worker 신원"과 같은 token을 쓴다. 다른 점은 scheduler가 Pod를 만들었으므로 Pod UID를 안다는 것이다.

- scheduler가 Pod spec에 audience `agent-platform-worker:<installation>`의 projected token 볼륨을 넣는다. nonce Secret은 만들지 않는다.
- worker는 token을 `Authorization`에 넣고, 지금처럼 `execution_id`·`execution_generation`과 함께 claim한다. api는 token을 JWKS로 오프라인 검증한 뒤 아래의 "승인된 UID"와 대조한다.

`executions.provider_ref`와 단순히 비교하면 안 된다. provider_ref는 관측값이고 교체 요청이 지우지 않는다. 지금 nonce는 교체할 때 같은 execution·generation에서 폐기되어 claim을 원자적으로 막는다(`packages/db/src/scheduler-store.ts:441-505`, `packages/platform/src/scheduler/reconcile.ts:125-186`). token 방식도 같은 성질이 필요하므로, nonce 열 자리에 다음 상태를 `worker_launches`에 둔다. 모두 claim과 같은 행 잠금 아래에서 바뀐다.

| 열 | 뜻 |
| --- | --- |
| `bootstrap_kind` | `nonce` 또는 `workload_identity`. launch를 예약할 때 정하고 바꾸지 않는다 |
| `authorized_uid` | claim을 받을 Pod UID. scheduler가 create 응답을 받은 뒤 적는다 |
| `identity_revoked_at` | 교체 요청이 적는다. 그 뒤로 그 UID는 claim할 수 없다 |
| `bootstrap_deadline` | 지금 nonce TTL과 같은 역할. 지나면 claim을 받지 않고 reconcile이 교체한다 |

- claim은 token UID = `authorized_uid`, `identity_revoked_at`이 null, `bootstrap_deadline` 전, slot 미반환일 때만 받는다. 재전송 규칙은 지금 그대로다.
- 생성 시도는 `launch_attempts`로 구별한다. 지금 nonce도 이 값에 묶여 시도마다 새로 발급되고(`scheduler-store.ts:362`), 실패 처리와 `beginLaunchAttempt`가 이 값을 올린다(`scheduler-store.ts:550-620`). `replacement_count`는 실패 재시도에서 바뀌지 않으므로 시도를 구별하지 못한다.
- 새 시도를 여는 것은 `beginLaunchAttempt` 하나다. 이 UPDATE가 `launch_attempts`를 올리면서 같은 문장에서 `authorized_uid`와 `identity_revoked_at`을 비우고 `bootstrap_deadline`을 새로 적는다. 조건은 지금 그대로(기대한 `launch_attempts`, slot 보유, desired running)다. 폐기 상태에서 벗어나는 길은 이것뿐이다.
- `authorized_uid`는 조건부 UPDATE로만 적는다. 조건: generation이 같고, `launch_attempts`가 그 Pod의 시도 번호와 같고, `identity_revoked_at`이 null이고, `authorized_uid`가 비어 있고, slot을 쥐고 있을 때. 하나라도 어긋나면 그 Pod는 낡은 시도의 것이므로 적지 않고, 다음 pass가 교체 대상으로 본다. 그래서 늦게 도착한 create 응답이나 이전 시도의 Pod가 승인되지 않는다.
- `authorized_uid`가 아직 없으면 재시도할 수 있는 오류로 답한다. worker는 지금도 1초마다 `WORKER_CLAIM_TIMEOUT_SEC`(60초)까지 claim을 다시 시도한다.
- 지금 adopt는 Pod가 가진 nonce를 DB의 nonce와 대조해 "이 Pod가 지금 생성 시도의 것인가"를 판단한다(`backend.ts:195-197`). nonce가 없으면 그 대조를 Pod annotation으로 대신한다. scheduler는 Pod를 만들 때 `beginLaunchAttempt`가 돌려준 시도 번호를 annotation으로 적는다.
- create는 성공했는데 scheduler가 UID를 적기 전에 죽은 경우: 다음 pass의 inspect가 이름으로 Pod를 찾는다. Pod annotation의 시도 번호가 지금 `launch_attempts`와 같고, launch가 폐기되지 않았고, `authorized_uid`가 비어 있으면 그 Pod UID를 위와 같은 조건부 UPDATE로 적는다(지금 "create 결과를 모르는 launch는 다음 pass가 inspect해 채택한다"와 같은 규칙). annotation이 다르거나, 폐기된 launch이거나, 다른 UID가 이미 적혀 있으면 그 Pod는 채택하지 않고 교체한다. adopt와 inspect는 폐기된 UID나 이전 시도의 Pod를 승인하지 못한다.
- `requestReplacement`의 credential fence(`scheduler-store.ts:450-455`)는 nonce 지문 대신 호출자가 읽은 `authorized_uid`(비어 있으면 null)를 받는다. 호출자가 스냅샷을 읽은 뒤 새로 승인된 UID는 그 교체 요청이 폐기하지 않는다.
- 교체와 실패 처리: `requestReplacement`와 실패 기록이 `identity_revoked_at`을 적는다(지금 `nonceHash: null` 자리). teardown 뒤 다음 시도는 위의 `beginLaunchAttempt`로 열고, 새 Pod의 UID는 그 시도 번호로 위 조건부 UPDATE를 거쳐야 승인된다.
- token 자체의 만료(10분, kubelet이 갱신)와 launch의 `bootstrap_deadline`은 다른 것이다. 앞은 서명 검증에서, 뒤는 launch 상태에서 본다.
- `bootstrapCredentialState`와 adopt 판단(지금은 Secret을 읽고 nonce 지문을 대조한다, `kubernetes/src/backend.ts:228-274`)은 `bootstrap_kind`로 갈린다. `workload_identity` launch는 Secret을 보지 않고 위 열로 판단한다.
- 결과: `workload_identity` launch만 남으면 Role에서 `secrets`가 빠진다. nonce가 Secret과 env에 남지 않는다.
- 테스트로 고정할 것: create 성공 뒤 UID 기록 전 crash, 교체 요청과 claim의 경합, 폐기된 UID의 재claim, deadline 경과, 응답 유실 재전송.

### 0-3. 실패 로그 tail을 끌 수 있게

`pods/log` get은 그 namespace의 모든 Pod 로그를 읽는 권한이다. 지금은 어댑터가 라벨을 확인한 뒤에만 읽지만 권한 자체는 넓다. chart에 `worker.failureLogTail`(기본 `true`, 지금과 같음)을 두고, `false`면 Role에서 `pods/log`를 빼고 어댑터는 tail 없이 종료 사유만 남긴다. 0-1을 하면 그 namespace에는 worker Pod만 있으므로 켜 둬도 위험이 작다.

### 0-4. scheduler가 만들 수 있는 Pod를 admission으로 묶는다

`pods` create 권한이 남는 한, scheduler가 털리면 그 namespace에 아무 Pod나 만들 수 있다. chart가 worker namespace에 ValidatingAdmissionPolicy를 배포해, scheduler SA가 만드는 Pod를 worker spec 계약으로 제한한다. Kubernetes 1.30부터 GA인 기능이라 별도 컴포넌트가 필요 없다. 계약은 1안과 볼륨 쪽이 다르다. 지금 Pod spec(`packages/adapters/execution/kubernetes/src/specs.ts`)을 기준으로 다음만 허용한다.

- 이미지: digest 형식이고 허용 목록에 있다.
- ServiceAccount: worker SA, `automountServiceAccountToken: false`.
- 볼륨: 세션 workspace PVC(`claimName`이 `ap-ws-<installation>-` 접두사), 메모리 emptyDir(`/tmp`, HOME), 0-2의 projected token(audience 고정). 전환 기간에만 nonce Secret 참조를 허용하되, 이름이 nonce Secret 접두사이고 `secretKeyRef` 하나뿐인 경우로 제한한다. 그 밖의 Secret·ConfigMap·hostPath는 거절한다.
- 보안 설정: `readOnlyRootFilesystem`, `runAsNonRoot`, capabilities drop ALL, `allowPrivilegeEscalation: false`, hostNetwork·hostPID 없음.
- 네트워크: `dnsPolicy: None`, proxy 주소의 `hostAliases`, `enableServiceLinks: false`, NetworkPolicy가 고르는 라벨.

검증: 지금 어댑터가 만드는 Pod(nonce 판, token 판)는 통과하고, 임의 Secret을 마운트하거나 다른 이미지·쓰기 가능한 root fs인 Pod는 거절된다.

### 0안의 결과

| | 지금 | 0안(0-1~0-4) |
| --- | --- | --- |
| Role 위치 | release namespace(앱 Secret과 같은 곳) | worker 전용 namespace |
| `pods` | get·list·create·delete | 같음. 만들 수 있는 Pod는 admission이 묶음 |
| `persistentvolumeclaims` | get·list·create·delete | 같음 |
| `secrets` | get·list·create·delete | 없음 |
| `pods/log` | get | 켜면 get(worker Pod만 있는 namespace), 끄면 없음 |

어댑터, chart Role, `deploy/helm/render-check.ts`의 Role 검사, [Kubernetes 실행 backend](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/kubernetes-backend/)의 RBAC 표가 함께 바뀐다.

### 0안의 이전

- 0-3, 0-4는 기존 설치에 바로 들어간다.
- 0-2는 세 단계다. (1) api·backend·reconcile이 `bootstrap_kind`로 두 방식을 모두 처리하는 판을 낸다. 새 launch는 아직 `nonce`. (2) 새 launch를 `workload_identity`로 바꾼다. 떠 있는 nonce launch는 그대로 claim·adopt·교체된다. Role의 `secrets`는 남긴다. (3) `nonce` launch가 하나도 남지 않고 nonce Secret이 모두 지워진 것을 확인한 뒤 Role에서 `secrets`를 빼고 nonce 경로를 지운다. (1)과 (2) 사이, (2)와 (3) 사이에서 scheduler 재시작과 이전 판으로의 되돌림을 검증한다. (2)에서 되돌리면 이전 판이 `workload_identity` launch를 모르므로, (1)의 판이 그 launch를 교체할 수 있어야 한다.
- 0-1은 PVC가 namespace를 옮길 수 없어서 순서가 필요하다. backend는 지금 namespace 하나만 조회·생성·삭제하므로(`kubernetes/src/backend.ts`), 기존 세션의 PVC를 그냥 두고 namespace를 바꾸면 그 세션의 workspace를 못 찾고 빈 PVC를 새로 만들거나 회수를 잘못 처리한다. 그래서 전환 기간에는 backend가 이전 namespace를 함께 본다.
  - `EXECUTION_K8S_LEGACY_NAMESPACE`를 받는다. 이전 namespace에도 Pod가 계속 생기므로, 이전이 끝날 때까지 두 namespace 모두에 scheduler Role, worker SA, worker NetworkPolicy, admission 정책 binding, pull Secret을 두고, proxy의 ingress 규칙은 두 namespace의 worker를 모두 받는다.
  - 세션의 workspace PVC가 이전 namespace에 있고 그 세션에 committed checkpoint가 없으면 그 세션의 launch는 이전 namespace에 만든다. 새 세션과 PVC가 없는 세션은 새 namespace로 간다. 판단은 launch를 예약할 때 하고, launch 행에 namespace를 적는다.
  - `listManaged`·`inspect`·`terminate`·`listWorkspaces`·`removeWorkspace`는 두 namespace를 모두 본다. 끝나지 않은 workspace 회수 claim은 적힌 namespace에서 마저 처리한다(`packages/platform/src/scheduler/workspaces.ts:43`).
  - 끝나는 시점에는 상한이 없다. 이전 namespace의 PVC를 쓰는 세션이 재개하면 계속 그 PVC를 쓰고, stopped TTL은 마지막 상태 변경부터 세며 slot을 쥔 launch가 있으면 회수하지 않는다(`packages/db/src/scheduler-store.ts:863-879`). 그래서 legacy 값과 이전 namespace의 리소스는 **실제로** 이전 namespace에 PVC·launch·끝나지 않은 회수 claim이 하나도 남지 않은 것을 확인한 뒤에 지운다.
  - 이전을 앞당기려면, committed checkpoint가 있는 세션은 다음 launch를 새 namespace에 만들고 이전 PVC는 회수 대상으로 넘긴다. restore가 workspace를 통째로 교체하므로 잃는 것이 없다. checkpoint가 없는 세션만 이전 namespace에 남는다.
  - 테스트로 고정할 것: 이전 namespace에 PVC가 있는 세션의 재개, 끝나지 않은 회수 claim, checkpoint 없는 세션의 전환.

### 0안의 검증

OrbStack 내장 K8s의 기존 `k8s-smoke` 흐름에 더한다.

- `kubectl auth can-i --list --as=system:serviceaccount:<ns>:<scheduler>`가 worker namespace의 `pods`·`persistentvolumeclaims`(와 켰을 때 `pods/log`)만 보이고, release namespace의 `secrets`가 `no`다.
- 세션 하나가 token claim으로 turn을 끝낸다. 다른 Pod의 token, UID가 launch와 다른 token은 401이다.
- scheduler SA로 정책을 어기는 Pod(쓰기 가능한 root fs, 다른 이미지, Secret 마운트)를 만들면 admission이 거절한다.
- worker namespace를 나눈 설치에서 worker → proxy, proxy → api 경로가 통하고, worker → api 직접 경로는 막힌다.

## 1안 설계

### worker 신원: nonce Secret 대신 projected ServiceAccount token

ScaledJob은 Job마다 다른 값을 넣을 수 없다. KEDA 문서는 Job 하나가 "뜬 뒤 이벤트 하나를 가져와 처리한다"고만 적고, 이벤트별 템플릿은 없다([scaling jobs](https://keda.sh/docs/latest/concepts/scaling-jobs/)). 그래서 Pod마다 다른 nonce를 env로 줄 수 없다. 대신 Pod에 묶인 SA token을 쓴다.

- worker Job 템플릿이 projected `serviceAccountToken` 볼륨을 마운트한다. audience는 `agent-platform-worker:<installation>`, `expirationSeconds`는 600이다([projected volumes](https://kubernetes.io/docs/concepts/storage/projected-volumes/)). SA token 자동 마운트는 지금처럼 끈다. 이 SA에는 Role이 없다.
- worker는 이 token을 `Authorization`에 넣어 claim한다. 본문은 `{credential: {kind: "workload_identity"}, image, class, isolation_contract}`다. 지금 스키마는 `execution_id`·`execution_generation`을 요구하고 `job_uid`를 본문에서 받는데, 신원은 검증한 token에서만 꺼내야 하므로 이 둘을 고친다.
- api는 token을 **오프라인**으로 검증한다. 서명(JWKS), `iss`, `aud`, `exp`, `nbf`, namespace, ServiceAccount 이름과 UID, Pod 이름·UID claim을 본다([bound tokens](https://kubernetes.io/docs/reference/access-authn-authz/service-accounts-admin/)). `TokenReview`는 cluster 범위 create 권한이 필요해서 쓰지 않는다.
- JWKS: 관리형 클러스터(EKS·GKE 등)는 공개 OIDC issuer를 준다. 그렇지 않은 클러스터는 api Pod가 자기 SA token(Role 없음)으로 `/openid/v1/jwks`를 읽는다. 쿠버네티스 기본 ClusterRoleBinding `system:service-account-issuer-discovery`가 모든 SA에 이 경로를 연다. PoC의 권한 없는 worker SA로도 get이 허용됐다. JWKS는 캐시하고 kid가 바뀌면 다시 읽는다. 읽을 수 없으면 claim을 거절한다(fail closed). 이미 claim한 worker는 영향이 없다.
- 멱등: 멱등 키는 `(issuer, Pod UID)`다. 지금 nonce 재전송 규칙을 그대로 쓴다. attempt가 아직 `allocated`이고 binding이 유효할 때만 같은 binding을 돌려주고, worker가 인증된 호출을 한 번 하면 재전송은 닫힌다(`worker-unit-of-work.ts:1522`, `fence.ts:53`). 한 번 쓴 Pod UID는 다른 세션에 다시 쓰이지 않는다.

이 token이 증명하는 것은 "그 namespace의 그 SA로 뜬 Pod가 발급받았다"까지다. Pod가 아직 있는지, 요청이 그 Pod에서 왔는지, 그 Pod가 무슨 이미지를 돌리는지는 증명하지 않는다. 오프라인 검증은 지워진 Pod의 token도 만료까지(최대 10분) 받는다. 그래서 다음 두 가지가 함께 있어야 nonce를 대신한다.

- "아직 claim하지 않은 Pod의 token을 다른 곳에서 먼저 쓰기"는 네트워크로 막히지 않는다. claim route는 공개 api에 있고, api의 3000 포트는 기본값(`networkPolicy.api.ingressFrom: []`)에서 어디서든 닿는다(`deploy/helm/werft/values.yaml:305-316`). 막는 것은 token이 그 Pod의 볼륨에만 있다는 것과, 한 UID가 한 번만 claim한다는 규칙이다. 지금 nonce는 Pod가 소유한 Secret(`stringData.nonce`)에 저장되고 env로 들어간다(`packages/adapters/execution/kubernetes/src/specs.ts:348-361`). 그래서 그 namespace의 Secret을 읽을 수 있는 주체(scheduler SA 포함)도 nonce를 읽는다. projected token은 API 객체로 저장되지 않고 kubelet이 그 Pod의 볼륨에만 쓴다. 노출 경로는 token 쪽이 하나 적다. 새면 위험은 같다. 그 값으로 세션 하나를 claim할 수 있다(token은 최대 10분, nonce는 10분 TTL).
- 이미지와 Pod spec은 token이 아니라 admission이 보증한다(아래 "Pod spec 강제").

### claim이 launch를 만든다

지금은 scheduler가 launch를 먼저 예약하고 worker가 그 launch를 claim한다. pull 모드에서는 둘이 한 트랜잭션이 된다. 지금 claim 후보 쿼리는 "이미 예약된 launch"를 전제로 하고 다른 launch의 슬롯을 보지 않으므로, 그대로 쓰지 않는다. 불변식과 lock 순서는 지금 `reserveLaunch`(`packages/db/src/scheduler-store.ts:259-360`)를 따른다.

1. `(issuer, Pod UID)`로 기존 launch를 찾는다. 있으면 위 재전송 규칙대로 답한다. 동시에 들어온 같은 UID 요청은 이 열의 unique 제약이 하나만 남긴다.
2. advisory lock `executions:reserve_launch`를 잡고, 설치 슬롯(`slot_released_at IS NULL`인 launch 수 < `EXECUTION_SLOT_LIMIT`)과 class 상한을 다시 센다. 넘으면 `NOT_FOUND`다.
3. 후보 세션을 고른다. 조건은 `inspectDemand`의 조건(예산, restore 재시도 시각, takeover, revoke)에 "그 세션에 슬롯을 쥔 launch가 없다"와 "세션이 고정한 이미지가 있으면 worker의 digest와 같다"를 더한 것이다. `SKIP LOCKED`.
4. 세션 행을 잠그고 조건을 다시 확인한다. terminate·pause와의 경합은 이 잠금이 정한다.
5. generation을 그 세션의 max + 1로 정하고 `executions`(backend `kubernetes_pull`, `provider_ref`·`launch_operation_id`는 Pod UID), `worker_launches`(session_id 채움, nonce 없음, image는 worker가 보고한 digest), attempt를 만든다.

fence는 generation만이 아니라 lease epoch, auth revision, attempt 상태와 lease를 함께 본다(`packages/db/src/fence.ts:43`). 이 값들은 지금 claim이 만드는 그대로 만들므로 checkpoint publish와 이후 쓰기의 fencing은 바뀌지 않는다. 구현 때 같은 UID 동시 요청, terminate 경합, 응답 유실 재전송, 낡은 finalize를 테스트로 고정한다.

### 종료 계약

플랫폼은 Pod를 지울 수도, 사라졌는지 볼 수도 없다. 그래서 "끝났다"를 다르게 정의한다.

**펜싱된 worker가 할 수 있는 것.** lease 만료는 lease epoch를 올리고 그 attempt의 worker 자격 증명을 폐기한다(`packages/db/src/lease-reconcile.ts:130-138`). terminate는 epoch만 올린다(`packages/db/src/control-unit-of-work.ts:542-562`). 어느 쪽이든 proxy의 자격 증명 확인이 token의 유효기간이 아니라 fence(세션이 아직 그 attempt를 가리키고 lease가 남았는지)를 보므로(`packages/db/src/worker-unit-of-work.ts:1845-1852`) 펜싱 뒤의 새 교환은 거절된다. 이미 열린 교환은 30초마다 다시 확인하고, 확인할 수 없으면 최대 90초까지 이어진다(`apps/egress-proxy/src/credential.ts:60-71`). worker의 egress는 NetworkPolicy로 proxy에만 열려 있고, provider 키와 저장소 자격 증명은 proxy의 credential route가 쓴다. 그래서 펜싱된 worker는 플랫폼에 쓸 수 없고(fence), 그 뒤로는 모델을 부르거나 push하는 것처럼 자격 증명이 드는 부작용을 새로 낼 수 없다. proxy allowlist에 있는 자격 증명 없는 목적지(패키지 레지스트리 등)에는 Pod가 살아 있는 동안 계속 닿을 수 있다. 이것은 이미 시작된 외부 부작용을 되돌리지 않는다. 지금 push 모드도 Pod 삭제가 끝나기 전까지는 같다.

이 보장은 NetworkPolicy가 실제로 강제될 때만 성립한다. 지금 chart의 정책은 모두 `networkPolicy.enabled`에 달려 있고(`networkpolicies.yaml:1`), 정책을 강제하지 않는 CNI에서는 정책이 있어도 효과가 없다. 그래서 pull 모드에서는 `networkPolicy.enabled: false`면 chart render가 실패하고, "worker Pod에서 proxy를 거치지 않은 외부 접속이 막힌다"를 설치 검증 항목으로 둔다. admission이 label과 proxy env를 검사하는 것만으로는 직접 접속을 막지 못한다.

| 상황 | push(지금) | pull |
| --- | --- | --- |
| pause·close처럼 drain이 필요한 종료 | Pod 삭제 → SIGTERM → worker가 turn을 drain하고 release | heartbeat 응답에 `drain_requested`를 더한다(지금은 `control_pending`만 있다, `worker-protocol/index.ts:370-377`). worker는 SIGTERM과 같은 drain 경로를 탄다. release가 끝나면 스스로 나간다 |
| terminate(강제), lease 만료 | 펜싱 후 Pod 삭제, 사라짐을 확인한 뒤 슬롯 반환 | 펜싱(lease 만료는 자격 증명 폐기도 한다). 살아 있는 worker는 다음 heartbeat(5초 간격)에서 lease lost로 나간다. 응답이 없는 worker는 Job `activeDeadlineSeconds`가 끝낸다 |
| 정상 종료(idle 등) | worker release 후 종료, scheduler가 Pod 부재 확인 | worker release가 곧 종료 receipt다 |

**슬롯 반환.** pull launch의 슬롯은 다음 중 먼저 오는 때에 돌려준다.

- worker의 release가 기록됐을 때(정상 종료와 drain).
- 펜싱한 뒤 `HEARTBEAT_TTL_SEC` + `WORKER_STOP_GRACE_SEC`가 지났을 때. 이 동안 살아 있는 worker는 lease lost를 보고 나간다. 그 뒤에도 남은 Pod는 플랫폼 슬롯 밖에서 클러스터 자원만 쓴다. 이것을 묶는 것은 물리 상한(아래 "두 상한")이다.

binding 제거와 재큐잉(세션을 다시 `unassigned_sessions`에 넣기)도 이 시점에 한다. 지금 Pod 부재 확인 경로가 하는 일(`worker-unit-of-work.ts:3030-3290`)을 이 두 시점으로 옮기는 것이다. push 모드의 경로는 건드리지 않는다.

**기동 실패.** 지금은 "Pod가 claim 전에 끝남"을 그 세션의 실패로 센다. pull에서는 claim 전 실패가 어떤 세션에도 묶이지 않으므로 세션 탓이 아니다. 대기 세션은 다음 Job이 받는다. 세션 탓인 실패(restore가 거듭 실패, 첫 입력 요청 전 사망)는 claim 뒤 첫 입력 요청 전에 lease를 잃은 횟수로 센다. 한도와 backoff는 지금 값을 쓴다.

**실패 로그.** scheduler가 `pods/log`로 읽던 tail은 클러스터 로그 수집기에 맡긴다. worker가 나가기 전에 `worker.failed`를 남기는 경로는 그대로다. OOMKilled 같은 종료 사유는 플랫폼이 더는 알 수 없다.

### workspace: 세션별 PVC 대신 generic ephemeral volume

workspace는 Job 템플릿의 `ephemeral.volumeClaimTemplate`이다. Pod가 생길 때 PVC가 생기고 Pod가 지워질 때 함께 지워진다([ephemeral volumes](https://kubernetes.io/docs/concepts/storage/ephemeral-volumes/)). 노드 디스크로 충분하면 emptyDir도 된다.

잃는 것은 다음과 같다.

- 복구 보장은 **마지막으로 commit된 checkpoint까지**다. restore가 있으면 worker는 workspace를 통째로 교체하므로(`apps/worker/src/workspace.ts:180-189`) 여기까지는 지금과 같다.
- checkpoint가 아직 없는 세션은 지금 PVC 덕분에 건강한 checkout과 로컬에만 있는 작업을 다음 worker가 이어받는다. pull에서는 Pod가 끝나면 사라진다. 지금 운영자가 TTL 안에 볼륨에서 직접 꺼내는 구출 경로([실행 기반](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/operate/execution/) "`stopped` 세션의 workspace는 만료된다")도 없어진다.
- turn 도중 worker가 죽으면 그 turn은 지금처럼 `outcome_unknown`이 되거나 `recovery_required`로 멈출 수 있다. 다음 worker는 마지막 checkpoint에서 시작한다.

workspace GC(`listWorkspaces`·`removeWorkspace`)는 이 모드에서 할 일이 없다.

### 대기 수: KEDA가 DB가 아니라 api를 읽는다

KEDA [PostgreSQL scaler](https://keda.sh/docs/latest/scalers/postgresql/)를 쓰면 KEDA operator(다른 namespace)가 DB 접속 정보와 대기 조건 SQL을 갖는다. 조건은 바뀌는 코드다. 그래서 api에 `GET /internal/execution/demand?class=<c>`를 두고 [metrics-api scaler](https://keda.sh/docs/latest/scalers/metrics-api/)가 KEDA 전용 bearer로 읽게 한다.

- 값은 **지금 claim할 수 있는 수**다. `min(그 class의 대기 세션 수, 설치에 남은 슬롯, class에 남은 슬롯)`. 슬롯이 가득 찼는데 대기만 세면 KEDA가 Job을 만들고, Job은 `NOT_FOUND`로 나가고, 다음 poll이 또 만드는 고리가 생긴다.
- ScaledJob은 `scalingStrategy: accurate`, `targetValue: 1`이다. `default`는 `min(max, 대기 수) - 실행 중 Job 수`라서 세션을 받아 오래 도는 Job까지 뺀다. PoC 3a에서 실제로 새 세션이 45초 동안 굶었다(아래 "검증").
- `pendingPodConditions: [Ready]`를 두고, worker의 readiness probe는 claim이 끝난 뒤에만 Ready가 된다. 그래야 Running이지만 아직 claim하지 않은 Job이 pending으로 세어져 같은 대기 세션에 Job이 두 번 뜨지 않는다([ScaledJob spec](https://keda.sh/docs/2.21/reference/scaledjob-spec/)).
- Job spec: `parallelism: 1`, `completions: 1`, `backoffLimit: 0`, `restartPolicy: Never`. 재시도로 생긴 새 Pod는 새 UID라 다른 세션을 claim할 수 있으므로 Job 수준 재시도를 쓰지 않는다. 다시 띄우는 일은 다음 poll이 한다.
- 같은 숫자를 지표로도 낸다. 지금은 대기 세션 수 지표가 없다(`werft.queue.oldest_age_seconds`뿐). 진행 중인 Kubernetes 실행 지표 작업과 하나로 합친다.

### 두 상한

| 상한 | 무엇을 센다 | 어디서 |
| --- | --- | --- |
| 논리 상한 | 슬롯을 쥔 pull launch 수 | `EXECUTION_SLOT_LIMIT`(설치)와 class별 상한. claim과 대기 수 endpoint가 지킨다 |
| 물리 상한 | 그 class에서 떠 있는 Job·Pod 수 | ScaledJob `maxReplicaCount`(class별), worker namespace의 ResourceQuota(전체) |

물리 상한은 논리 상한보다 조금 커야 한다. 펜싱됐지만 아직 안 나간 Pod와 claim 전 Pod가 그 차이를 쓴다. 차이를 얼마로 둘지는 열린 결정이다.

이미지를 받지 못하는 Job은 claim 전이라 플랫폼 슬롯을 쓰지 않지만 물리 상한과 노드 자원을 차지하고, `accurate`의 pending으로 세어져 새 Job을 막는다. `WORKER_CLAIM_TIMEOUT_SEC`는 프로세스 안에서 재므로 이 경우에 작동하지 않는다. `activeDeadlineSeconds`는 세션 길이에 맞춰야 해서 짧게 둘 수 없다. 그래서 이 상태는 클러스터 경보(claim 없이 N분 넘은 Job)로 잡고, 이미지 digest는 admission이 허용 목록으로 미리 막는다. 남는 위험은 열린 결정에 적는다.

### class와 이미지

ScaledJob은 템플릿이 고정이라 이미지와 리소스도 고정이다. 세션별 크기와 이미지는 class로 표현한다.

- class는 세션의 `partition`과 이미지 digest의 짝이다. chart가 `execution.pull.classes` 목록마다 ScaledJob 하나를 만든다(partition, 이미지 digest, cpu·memory, nodeSelector, tolerations, `maxReplicaCount`, 대기 수 URL). 지금은 모든 세션이 partition `default`이므로 처음에는 class 하나다.
- partition은 세션 생성 때 정해지고 바뀌지 않는다. "에이전트 설정으로 세션 크기를 고른다"는 생성 때 partition을 고르는 것이 된다.
- 고정 이미지가 없는 세션은 그 partition의 "현재" class가 받는다.

진행 중인 runtime 고정 작업(재개 시 이미지 선택, helm 업그레이드 검사, 이미지 허용 목록)과의 관계:

- 세션이 이미지를 고정하면, claim 조건에 "worker의 digest와 같다"가 들어간다. 대기 수 endpoint는 class(=partition과 digest)별로 센다.
- 이전 이미지의 class는 **재개할 수 있는 세션 중 그 이미지를 고정한 세션이 하나라도 있는 동안** 남긴다. 대기 수가 0이라는 것은 지금 기다리는 세션이 없다는 뜻일 뿐이다. paused·stopped 세션이 나중에 재개할 수 있다. 그래서 chart 값의 class 목록을 운영자가 손으로 관리하지 않도록, api가 "재개 가능한 세션이 고정한 digest 목록"을 내고 운영자가 그것과 chart를 대조하는 검사(runtime 고정 작업의 `helm` 업그레이드 검사와 같은 자리)를 둔다.
- 이미지를 폐기하면 그 이미지를 고정한 세션은 재개할 때 지금 규칙대로 `INCOMPATIBLE_CHECKPOINT`가 되고, 운영자가 `start_fresh`나 `close`를 고른다.
- 이 방식은 동시에 지원하는 digest 수가 적을 때만 맞다. 세션마다 임의의 이미지를 고르는 것이 목표라면 고정 템플릿과 맞지 않고, 후보 5(launcher)가 맞다.

이 부분은 runtime-pin 리드와 고정 단위(세션인지 launch인지)를 맞춘 뒤 확정한다.

### Pod spec 강제

지금은 플랫폼이 Pod spec을 직접 만들고, isolation stamp가 다르면 교체한다(`packages/adapters/execution/kubernetes/src/specs.ts`). pull에서는 chart가 만든 템플릿을 KEDA가 Job으로 만든다. 그 namespace에 Pod를 만들 수 있는 누구든 같은 SA로 Pod를 띄우면 claim할 수 있다. PSA `restricted`는 읽기 전용 root fs조차 강제하지 않는다([PSP→PSS 매핑](https://kubernetes.io/docs/reference/access-authn-authz/psp-to-pod-security-standards/)). 그래서 pull 모드의 **필수 조건**으로, chart가 worker namespace에 ValidatingAdmissionPolicy를 배포한다. 정책이 없으면 chart render가 실패한다.

정책이 확인하는 것:

- 이미지: digest 형식이고 class 목록(허용 목록)에 있다.
- ServiceAccount: worker SA. `automountServiceAccountToken: false`. 볼륨은 audience가 맞는 projected token, ephemeral workspace, 메모리 emptyDir(`/tmp`, HOME)뿐이다.
- 보안 설정: `readOnlyRootFilesystem`, `runAsNonRoot`, capabilities drop ALL, `allowPrivilegeEscalation: false`, hostPath·hostNetwork·hostPID 없음.
- 네트워크: `dnsPolicy: None`, proxy 주소의 `hostAliases`, `enableServiceLinks: false`, NetworkPolicy가 고르는 label.
- command와 env: worker 진입점과 proxy env가 템플릿과 같다.

worker는 claim에 isolation 계약 버전을 보내고, 서버는 지금 값보다 낮으면 거절한다. 이것은 낡은 이미지를 빨리 거르는 장치일 뿐 증명이 아니다. 증명은 admission이 한다. 정책을 바꾸기 전에 생긴 Pod는 정책이 다시 보지 않으므로 `activeDeadlineSeconds` 안에 끝난다는 것만 보장된다. 정책을 강화하는 변경은 class 이미지를 바꾸는 것과 같은 방식으로 이전 Pod가 빠지기를 기다린다.

egress proxy 주소: 지금 scheduler는 proxy Service의 ClusterIP를 매번 풀어 `hostAliases`에 넣는다. 템플릿은 고정이므로 proxy Service의 `clusterIP`를 chart 값으로 고정한다.

### 데이터·API·chart 변경

- DB
  - `worker_launches.launch_identity`(`issuer` + Pod UID, unique, null 허용). nonce 열은 null로 둔다.
  - `executions.backend`에 `kubernetes_pull`.
  - pull launch의 슬롯 반환·binding 제거·재큐잉을 위 "종료 계약"의 두 시점에서 하는 경로. 기동 실패는 `launch_failure_count`를 claim 뒤 계산으로 채운다. 새 열이 필요한지는 구현 때 확인한다.
- API·프로토콜
  - `bootstrapClaimRequestSchema`: `workload_identity`일 때 `execution_id`·`execution_generation`·`job_uid`를 받지 않고 `image`·`class`·`isolation_contract`를 받는다. token은 `Authorization`.
  - `heartbeatResponseSchema`에 `drain_requested`.
  - `GET /internal/execution/demand?class=<c>` → `{ "claimable": n }`. KEDA 전용 bearer. 사람 API 키와 섞지 않는다. 새 route는 core 응답 표(`packages/core` responses)에 넣는다.
  - 재개 가능한 세션이 고정한 digest 목록(운영자용).
- worker
  - `apps/worker/src/config.ts`는 지금 `WORKER_BOOTSTRAP_NONCE`·`WORKER_EXECUTION_ID`·`WORKER_EXECUTION_GENERATION`을 필수로 요구한다. pull에서는 token 경로(`WORKER_IDENTITY_TOKEN_PATH`)가 이들을 대신한다. `WORKER_OBJECT_PREFIX`(`sessions/<sessionId>/`)처럼 세션을 미리 알아야 하는 env는 binding에서 받는다.
  - claim 뒤 Ready가 되는 readiness 파일 또는 엔드포인트. `drain_requested`를 받으면 SIGTERM과 같은 drain.
- 설정
  - `EXECUTION_BACKEND=kubernetes_pull`. 이 값이면 scheduler pass는 fillSlots·orphan 정리·workspace GC를 건너뛰고, pull launch의 슬롯 반환 시각 처리와 행 정리만 한다.
  - `EXECUTION_PULL_ISSUER`, `EXECUTION_PULL_JWKS_URL`, `EXECUTION_PULL_AUDIENCE`, `EXECUTION_PULL_NAMESPACE`, `EXECUTION_PULL_SERVICE_ACCOUNT`, KEDA bearer의 hash.
- chart
  - `execution.mode: push | pull`(기본 `push`). 지금 chart는 `EXECUTION_BACKEND=kubernetes`를 박아 두었으므로 이 값으로 바꾼다.
  - `pull`이면 `networkPolicy.enabled: false`를 거절한다("종료 계약").
  - `pull`이면 scheduler Role·RoleBinding과 scheduler의 SA token 마운트를 만들지 않는다. class마다 ScaledJob과 TriggerAuthentication, worker namespace에 ValidatingAdmissionPolicy와 binding, ResourceQuota를 만든다.
  - worker namespace를 api와 나누면 NetworkPolicy가 namespace를 넘어야 한다. 지금 proxy 정책은 같은 namespace의 podSelector만 본다(`networkpolicies.yaml`). 처음에는 같은 namespace를 쓰고, 나누는 것은 열린 결정이다.
  - KEDA는 chart에 넣지 않는다. 클러스터당 하나만 둘 수 있고(external metrics API 등록이 하나뿐이다, [FAQ](https://keda.sh/docs/2.21/reference/faq/)) 다른 설치와 함께 쓰기 때문이다. `keda.sh/v1alpha1` CRD가 없으면 render가 실패한다. KEDA operator는 문서상 모든 API group의 `get`과 모든 namespace의 secrets 읽기를 갖는다([KEDA cluster](https://keda.sh/docs/latest/operate/cluster/)). 설치 안내에 `KEDA_RESTRICT_SECRET_ACCESS=true`를 권한다.
  - `deploy/helm/render-check.ts`에 pull 모드 검사(Role 없음, 템플릿의 SA token 자동 마운트 꺼짐, projected token audience, 정책 존재)를 더한다.

## 1안: 기존 방식과 공존

- 기본값은 바뀌지 않는다. `execution.mode`가 없거나 `push`면 지금 chart와 같은 manifest가 나와야 한다. render-check에 "pull 값이 없으면 manifest가 이전과 같다"는 검사를 둔다.
- 한 설치는 한 모드만 쓴다. 섞으면 슬롯과 실패 계산이 두 갈래가 된다.
- compose 설치는 바뀌지 않는다. `local_docker`는 docker.sock을 쓰는 push다.

## 1안: 이전 단계

1. **확장**: claim의 `workload_identity`, launch 멱등 키 열, pull 종료 계약 경로, 대기 수 endpoint, heartbeat `drain_requested`, worker의 token 경로, `EXECUTION_BACKEND=kubernetes_pull`, chart `execution.mode: pull`. 기본값은 `push`. 기존 설치의 동작과 manifest는 그대로다.
2. **검증**: 아래 "구현 뒤 실측할 것"을 OrbStack K8s에서 통과한다. 그 뒤 dev 클러스터 하나를 pull로 옮긴다.
3. **전환(설치 하나를 push → pull)**:
   1. 새 push 예약을 멈춘다(scheduler admission 정지). 이것 없이 기다리면 scheduler가 그동안 새 launch를 계속 예약한다.
   2. 남은 push 실행이 끝나고 슬롯이 모두 반환된 것을 DB로 확인한다.
   3. 세션별 PVC를 처리한다. checkpoint가 없는 stopped 세션의 PVC는 구출 기간이 끝날 때까지 남기고, 끝나지 않은 workspace 회수 claim은 push scheduler로 마저 처리한다. 끝나지 않은 회수가 남으면 resume을 막는다(`packages/platform/src/scheduler/workspaces.ts:43`).
   4. pull을 켠다.
   - 되돌리기(pull → push)는 같은 순서의 반대다. 새 pull claim을 막고(대기 수 endpoint가 0을 내고 claim이 `NOT_FOUND`), pull 슬롯이 모두 반환된 뒤 push를 켠다.
4. **기본값 변경**과 **push 경로 삭제**(`packages/adapters/execution/kubernetes`, scheduler Role)는 각각 별도 결정이다.

## 1안: 검증 계획

### PoC로 잰 것 (2026-10-31, OrbStack K8s v1.36.5, KEDA 2.21.0)

플랫폼 대신 Postgres 표 하나와 psql worker로 "KEDA가 대기 수만큼 Job을 띄우고, 뜬 Job이 스스로 일을 하나 claim한다"는 흐름만 잰 것이다. 플랫폼의 claim, 펜싱, 슬롯, checkpoint는 들어가지 않았고, trigger도 이 설계의 metrics-api가 아니라 PostgreSQL scaler다.

- worker namespace에 Role·RoleBinding은 0개였다. worker SA(`automountServiceAccountToken: false`)의 권한은 쿠버네티스 기본 discovery뿐이었고(`kubectl auth can-i --list`), 그 안에 `/openid/v1/jwks` get이 있었다.
- ScaledJob: `pollingInterval: 5`. worker는 `FOR UPDATE SKIP LOCKED`로 한 행을 claim한 뒤 정해진 시간 일하고 끝난다. 이미지는 노드에 캐시돼 있었다.

| 회차 | 조건 | 결과 |
| --- | --- | --- |
| 0 | 대기 0 | Job 0개 |
| 1 | 대기 3, `maxReplicaCount` 5, `default`, 일 20초 | Job 3개, 서로 다른 행을 claim. 행 생성부터 claim까지 4.4~4.6초 |
| 2 | 대기 8, `maxReplicaCount` 5, `default`, 일 20초 | 먼저 5개(2.3~2.7초). 남은 3개는 앞의 Job이 끝난 뒤 생성, 33.7초(일 20초 포함). claim할 것이 없어 그냥 나간 Job 0개 |
| 3a | `maxReplicaCount` 10, `default`, 일 90초. 5개를 넣고 15초 뒤 3개 더 | 처음 5개는 6.7~7.3초에 claim. 늦게 온 3개는 상한이 5칸 남았는데도 45초 동안 Job이 하나도 생기지 않았다. `min(10, 대기 3) - 실행 중 5 < 0`이기 때문이다 |
| 3b | 3a와 같고 `accurate` | 늦게 온 3개도 7.9~8.6초에 claim. Job은 모두 8개로 남는 것이 없었다 |

3a가 `accurate`를 고른 근거다. 대기 수에 이미 claim된 세션을 넣지 않는 한 `default`는 오래 도는 세션이 있을 때 새 세션을 굶긴다.

### 구현 뒤 실측할 것

OrbStack 내장 K8s에서 verify 스택의 chart를 `execution.mode: pull`로 올린다. 결과는 Job 수만이 아니라 DB의 슬롯, session binding, attempt 상태, checkpoint pointer 값으로 확인한다.

- 권한: 플랫폼 SA에 RoleBinding이 없다(`kubectl get rolebindings -n <ns>`).
- 기본 흐름: 세션 하나 → Job 하나 → token claim → turn 완료. 시작 지연을 같은 클러스터의 push 모드와 비교한다.
- 상한: 세션 셋을 `EXECUTION_SLOT_LIMIT=2`로 돌리면 대기 수가 2를 넘지 않고, 세 번째는 슬롯이 반환된 뒤 시작한다. `NOT_FOUND`로 나가는 Job이 반복해서 생기지 않는다.
- Running이지만 claim 전인 Job: claim을 일부러 늦춘 worker로 같은 세션에 Job이 두 번 뜨지 않는다.
- 이미지 실패: 없는 digest의 class는 admission이 거절하고, 받을 수 없는 이미지의 Job은 경보에 잡힌다.
- 종료: close·pause는 drain 뒤 release, Job은 성공으로 끝난다. idle 중 worker를 SIGKILL하면 펜싱 + 유예 뒤 슬롯이 돌아오고 다음 Job이 마지막 checkpoint에서 이어간다. turn 도중 SIGKILL은 그 turn이 `outcome_unknown` 또는 `recovery_required`가 되는 것을 확인한다.
- 펜싱 뒤 살아 있는 worker: SIGSTOP으로 멈춘 worker를 펜싱하고 유예가 지나 같은 세션을 새 worker가 claim하게 한다. 그 뒤 SIGCONT하면 이전 worker의 자격 증명이 드는 proxy 요청과 finalize·checkpoint publish가 거절되고(`worker-unit-of-work.ts:2426`), 새 worker의 checkpoint는 영향이 없고, 이전 worker는 lease lost로 나간다. lease 만료와 terminate 두 경로 모두 본다.
- 네트워크 격리: worker Pod에서 proxy를 거치지 않은 외부 접속과 api 직접 접속이 막힌다. OrbStack의 CNI가 NetworkPolicy를 강제하지 않으면 이 항목은 강제하는 CNI(예: Calico를 올린 kind)에서 잰다.
- 신원: 다른 SA로 띄운 Pod의 token, audience가 다른 token, 만료된 token, 이미 claim한 Pod UID의 token으로 다른 세션 claim은 모두 401이다. JWKS를 읽을 수 없으면 claim이 거절되고 도는 worker는 영향이 없다.
- admission: 정책을 어기는 Pod(쓰기 가능한 root fs, 다른 이미지)를 worker SA로 직접 만들면 거절된다.
- Job 재시도: `backoffLimit: 0`이라 실패한 Job이 새 Pod로 다른 세션을 받지 않는다.
- 모드 전환: push → pull, pull → push를 위 순서대로 해서 세션 하나가 양쪽에서 이어간다.
- 이미지 고정: 이전 이미지로 고정된 세션은 새 이미지 worker에게 가지 않는다(runtime-pin과 맞춘 뒤).

## 다른 의견: Codex 검토 (2026-10-31)

1안을 추천하던 첫 초안에 대한 독립 검토는 결론이 달랐다. 그 판단은 다음과 같다.

> 현재 문서대로 구현을 권고하지 않는다. `accurate`와 claim-time launch 자체는 성립하지만, 기존 코드의 핵심인 "실행 종료를 확인한 뒤 자원을 반환한다"는 계약을 바꾸는 설계가 빠졌다. 우선 push를 유지하겠다. 플랫폼의 Kubernetes 권한 제거가 필수라면, 클러스터 안의 별도 launcher가 플랫폼에서 예약된 실행을 pull하고 기존 Pod 생성·종료 관측 로직을 수행하는 방식을 먼저 택하겠다. KEDA 방식은 제한된 이미지/class와 논리적 종료 보장을 받아들이는 opt-in 실험으로 한정하는 편이 낫다.

처음 판은 KEDA 방식을 먼저 확장·검증하자고 했다. 근거는 펜싱 뒤에는 proxy가 그 worker의 자격 증명 사용을 거절하므로 Pod 종료를 못 봐도 막을 부작용은 막힌다는 것, launcher는 Kubernetes 제어 코드를 우리에게 남긴다는 것이었다. 지금 판은 0안(직접 생성, 권한 축소)을 같은 축에 올려 0안을 고른다. Codex의 "우선 push를 유지하겠다"와 같은 결론이고, 그 push를 어떻게 줄일지가 0안이다. 1안은 Codex가 말한 대로 "제한된 이미지/class와 논리적 종료 보장을 받아들이는 opt-in"의 설계로 남긴다.

## 열린 결정

| 결정 | 추천 | 기본값 |
| --- | --- | --- |
| 0안과 1안 중 무엇을 할지 | 0안 | 지금 그대로 |
| 0안 중 먼저 할 것 | 0-1(worker 전용 namespace)과 0-4(admission). 앱 Secret 노출을 바로 없앤다. 0-2(token)는 그다음 | - |
| `worker.failureLogTail` 기본값 | `true`(지금과 같음). 0-1 뒤에는 worker Pod만 읽는다 | `true` |
| 1안을 꺼낼 조건 | "플랫폼 K8s 권한 0"이 설치 요구 사항이 되고, 그 설치가 이미지·크기를 class 몇 개로 묶어도 될 때 | 꺼내지 않음 |
| 1안을 꺼낼 때: KEDA 의존, 새 종료 계약, checkpoint 없는 작업 손실 | 이 문서의 1안 설계대로 받아들인다. 실측이 조건 | - |
| 1안을 꺼낼 때: 물리 상한과 논리 상한의 차이, `activeDeadlineSeconds` | 논리 상한 + 2, 24시간 | - |
| compose에 pull(상시 풀)을 둘지 | 두지 않는다 | 두지 않음 |
