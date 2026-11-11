# 결정: 실행 프로필을 DB 하나로 관리한다

- 상태(2026-11-11): **폐기됨.** 실행 프로필은 이 결정을 대체한 프로필 제거 변경에서 통째로 지웠다(migration `0270_remove_profiles`, 기존 데이터는 이전하지 않고 지움). 아래는 그때의 기록이다. 지금은 에이전트 release가 provider 연결과 카드 모델로 실행 spec을 고정하고, 묻기·막기 규칙은 워크스페이스와 에이전트의 실행 규칙이 정한다.
- 상태: 결정(2026-10-28). 저장소 허용·시드·회수 절은 같은 날 고쳤다. 설정 파일(`profiles.yaml` 시드, `connections.yaml`)을 읽는 부분과, 상한이 `repository_ids` 나열로만 저장소를 허용하는 [저장소 허용](#저장소-허용) 규칙(GitHub App 저장소의 `installed`)은 대체됨 → [settings-replace-file-catalog.md](settings-replace-file-catalog.md)(2026-11-02).
- 기준 커밋: `origin/main` `77b91d84`. 아래 `파일:줄`은 모두 이 커밋 기준이다.
- 오너 원문(2026-10-28): "설치 설정 파일을 고친 뒤 다시 배포해야하는 프로필 개념은 없애고 그냥 db 에서 관리하는 프로필 개념으로 통일하는게 낫지않아?", "DB 단일 관리로 통합하고 싶어 순차적으로 진행해도 좋아"

## 무엇을 골랐나

"프로필"은 DB에만 있는 하나의 개념이 된다. 종류는 둘이고, 둘 다 바뀌지 않는 버전이다.

| 종류 | 테이블 | 누가 만드나 | 하는 일 |
|---|---|---|---|
| 설치 상한 프로필(지금의 운영자 프로필) | `installation_profiles` (새 테이블) | 운영자(설치 owner) | 이 설치에서 쓸 수 있는 모델·도구·권한 모드·저장소의 상한 |
| 워크스페이스 프로필 | `workspace_profiles` (0174, 그대로) | 워크스페이스 owner·admin | 상한 하나를 바탕으로 좁힌 판 |

설치 설정 파일에는 프로필이 아닌 것만 남는다: provider 연결(endpoint·자격 증명 참조·billing, 새 파일 `connections.yaml`), 저장소(`repositories.yaml`, 지금 그대로), 그리고 위험 기능을 여는 환경 변수(`PLATFORM_ALLOW_UNATTENDED_PERMISSIONS`). 이것들은 비밀 값이나 설치의 격리를 다루므로 원래 설치 작업이다. 상한을 넓히거나 좁히는 일, 새 상한을 만드는 일은 더 이상 재배포가 필요 없다.

팀 단위 프로필은 이번에 만들지 않는다(이전 오너 결정 a안). [확장 지점](#확장-지점-팀-프로필)만 적어 둔다.

## 지금 구조 (바뀌는 것의 출발점)

- 운영자 프로필은 `PLATFORM_CONFIG_DIR`의 `profiles.yaml`(`apps/control-host/src/api/catalog-config.ts:37`)이다. API가 기동할 때 한 번 읽고(`catalog-config.ts:144-163`), 자격 증명 참조를 그 자리에서 값으로 푼다(`catalog-config.ts:165-194`). DB에는 없고 프로세스 메모리의 `SessionCatalog.profiles`에 있다(`packages/platform/src/sessions/catalog.ts:446-451`). slack 역할도 같은 YAML을 따로 읽는다(`apps/control-host/src/slack/main.ts:119`, `138-143`).
- 워크스페이스 프로필은 `workspace_profiles`(`packages/db/migrations/0174_workspace_profiles.sql:1-30`, `packages/db/src/schema.ts:3093-3145`)에 있다. 행은 `retired_at`·`retired_by` 말고는 바뀌지 않고(`catalog.ts:453-476`), id는 `ws_<slug>_<이름>_v<n>`이다(`packages/contracts/src/api/profiles.ts:103-112`).
- 워크스페이스 판은 바탕의 `model`·`models`·`tools`·`permission_mode`만 좁힐 수 있다(`packages/contracts/src/api/profile-derivation.ts:5-11`, `82-150`). 이 정책은 서버와 콘솔이 같이 쓰는 한 지점이다(`profile-derivation.ts:152-154`).
- release와 세션은 프로필 id와 지문(`profileFingerprint`, `catalog.ts:896-908`)을 고정한다. release id는 `runtime_profile_id`·`profile_digest`와 함께 프로필에서 만든 `runtime_config_snapshot`까지 해시한다(`packages/platform/src/agents/release-ids.ts:61-75`, `152-167`). 세션(`schema.ts:881-887`), 시도(`schema.ts:1951-1952`), checkpoint(`schema.ts:1859-1860`)도 `profile_id`와 `profile_fingerprint`를 남긴다. 세션을 시작할 때 `profilePinned`로 지문을 다시 맞추고 다르면 `PROFILE_DIGEST_MISMATCH`다(`packages/platform/src/agents/agent-service.ts:50-86`).
- v2 지문은 `model`·`models`·`repository`·`title_model`을 빼고 계산한다(`catalog.ts:896-903`). 그래서 지문이 같아도 모델 목록이 다르면 release의 모델 검사(`agent-service.ts:75-82`)와 판의 `baseHolds`(`catalog.ts:685-694`) 결과가 달라진다.

그래서 이 전환에서 가장 지켜야 할 것은 **기존 id가 같은 프로필 객체로 풀리는 것**이다. 지문만이 아니라 지문에서 빠진 칸까지 같아야 한다.

## 1. 데이터 모델

### `installation_profiles` (PD-2가 만든다)

| 열 | 타입 | 규칙 |
|---|---|---|
| `id` | text PK | 가져온 것은 YAML id 그대로(`claude-coding-real` 등). 콘솔에서 만든 것은 `op_<name>_v<n>`. `CHECK (id NOT LIKE 'ws\_%')` |
| `name` | text | 콘솔에서 만든 행의 버전 계열 이름. 가져온 행은 NULL이다(가져온 행의 이름은 id다). `CHECK ((origin = 'catalog') = (name IS NULL))` |
| `version` | integer NOT NULL | `>= 1`. 가져온 것은 1. 유일 제약은 콘솔 행에만 건다: `UNIQUE (name, version) WHERE origin = 'console'`. 그래서 가져온 id와 콘솔 이름은 서로 다른 이름 공간이고, YAML에 `foo`를 더해도 콘솔의 `foo` v1과 부딪히지 않는다 |
| `origin` | text NOT NULL | `CHECK IN ('catalog', 'console')`. YAML에서 가져왔는지, 콘솔에서 만들었는지 |
| `definition` | jsonb NOT NULL | `catalogProfileConfigSchema`(`catalog.ts:178-217`)로 파싱한 프로필 항목 그대로. provider는 endpoint·`auth.kind`·참조 이름(`value_env`/`secret_id`)·billing만 있고 값은 없다 |
| `permission_mode` | text NOT NULL | 6개 값 CHECK(0174와 같은 목록) + `CHECK (permission_mode = definition->>'permission_mode')`. DB 수준에서 모드로 거르고 막기 위한 열 |
| `fingerprint` | text NOT NULL | 쓸 때 계산한 `profileFingerprint`. 읽을 때 다시 계산해 다르면 그 행은 아무것도 돌리지 않는다(`definition_drift`) |
| `repository_ids` | jsonb | 그 상한이 돌 수 있는 저장소 id 목록. PD-5부터 가져온 행도 이 열이 정한다. 가져온 행의 NULL은 "아직 `repositories.yaml`에서 옮기지 않음"이고 콘솔 행은 NULL일 수 없다. [저장소 허용](#저장소-허용) 참고 |
| `previous_id` | text | 이 버전이 대신하는 앞 버전 id. 계열을 잇는 데만 쓴다 |
| `created_by` | uuid FK users | 가져온 행은 NULL |
| `created_at` | timestamptz NOT NULL default now() | |
| `retired_at`, `retired_by` | timestamptz, uuid FK users | 0174와 같은 짝 CHECK |
| `blocked_at`, `blocked_by` | timestamptz, uuid FK users | PD-5. 같은 짝 CHECK. [회수](#회수-차단) 참고 |

- **행은 바뀌지 않는다.** 바뀌는 것은 `retired_at`·`retired_by`, `blocked_at`·`blocked_by`, 그리고 가져온 행의 `repository_ids`를 NULL에서 한 번 채우는 것뿐이다. 상한을 고치면 다음 버전이 새 id로 생긴다(오너 결정 2). 콘솔 행은 같은 `name`의 `version + 1`이고, 가져온 행을 고치면 운영자가 고른 `name`의 v1이 되며 `previous_id`가 가져온 id를 가리킨다. 기존 워크스페이스 판과 release는 옛 id를 그대로 가리키므로 멈추지 않는다. 지금은 YAML을 제자리에서 고쳐 지문에 드는 실행 설정(tools·permission_mode·endpoint·runtime 등)을 바꾸거나 쓰던 모델을 빼면 그 id의 release·세션·판이 거절된다(`docs/operator/api-server.md:88`, `catalog.ts:896-903`, `685-694`). 모델을 더하거나 `title_model`을 바꾸는 것처럼 핀에 들지 않는 변경은 멈추지 않는다(`catalog.ts:183-188`). 불변 버전에서는 바꾼 내용이 새 id로 가므로 옛 id 쪽은 어느 경우에도 멈추지 않는다. 가져온 행을 바꾸는 CLI·API도 두지 않는다.
- **`definition`을 프로필 항목 그대로 두는 이유.** DB 행을 `SessionCatalogConfig`의 한 항목으로 되돌린 뒤 지금의 `sessionCatalogView`(`catalog.ts:1170-1194`)와 `resolveSessionCatalog`(`catalog.ts:1202-1238`)를 그대로 통과시킨다. YAML에서 읽은 것과 DB에서 읽은 것이 같은 함수를 지나므로 같은 항목이면 같은 객체가 나온다. 열을 나눠 다시 조립하면 키 하나(`repository` 생략 규칙, `catalog.ts:420-421`, `1185`)만 어긋나도 지문이 달라진다.
- **이름 공간.** YAML에 `ws_`로 시작하는 id가 있으면 지금처럼 기동을 거부한다(`catalog.ts:348-355`). `op_`는 거부하지 않는다. 지금 유효한 `op_…` id가 있을 수 있고, 그 id를 바꾸면 release·세션 핀이 깨지기 때문이다. 콘솔의 `name`은 `[a-z0-9-]`만 받으므로(`profiles.ts:32-34`와 같은 규칙) 두 출처의 id가 부딪히는 것은 YAML id가 `op_<name>_v<n>` 모양일 때뿐이다. 콘솔이 만들 id가 이미 있으면 저장은 `409`(`reason_code: id_taken`)이고 다른 이름을 고른다. 거꾸로 YAML에 새로 더한 id가 이미 콘솔 행의 id면 가져오기는 그 id를 넣지 않고 충돌로 보고한다(아래 충돌 처리와 같다). 그 YAML id를 다른 이름으로 바꾼다.

### `workspace_profiles` (바꾸지 않는다)

0174의 열·제약·id 규칙을 그대로 둔다. `base_profile_id`는 이제 `installation_profiles.id`를 가리킨다. FK는 걸지 않는다. 바탕이 없을 때의 상태(`base_missing`, `catalog.ts:676-679`)를 지금처럼 읽고, 옛 이미지가 이 테이블을 읽는 방식(`packages/db/src/workspace-profiles.ts:86-92`)을 건드리지 않기 위해서다.

### 한 테이블로 합치지 않은 이유

두 종류를 `workspace_profiles` 하나에 넣으면 0174의 `ws_` CHECK와 `workspace_id`·`created_by` NOT NULL(`0174_workspace_profiles.sql:3`, `15`, `20`)을 풀어야 한다. 그리고 옛 이미지의 `listAll`은 테이블 전체를 워크스페이스 판으로 읽는다(`packages/db/src/workspace-profiles.ts:86-92`). 롤백한 이미지가 상한 행을 워크스페이스 판으로 잘못 읽게 된다. 그래서 테이블은 둘, API·콘솔의 개념은 하나(`GET /v1/profiles`의 한 목록)로 둔다.

### 연결(`connections.yaml`)

```yaml
connections:
  anthropic-main:
    kind: anthropic
    endpoint: https://api.anthropic.com
    auth:
      kind: api_key
      value_env: ANTHROPIC_API_KEY
```

- 항목 하나는 지금 프로필의 `provider` 값 하나와 같은 모양이다(`catalog.ts:116-133`).
- DB 행의 `definition.provider`는 어떤 연결과 정확히 같아야 돈다(canonical JSON 비교). 같은 연결이 없으면 그 행의 상태는 `connection_missing`이고 아무것도 돌리지 않는다.
- 자격 증명은 연결의 참조만 푼다. 지금 `catalogCredentialRefs`가 프로필에서 참조를 모으는 자리(`catalog-config.ts:176-189`)가 연결에서 모으게 된다. 그래서 DB 행이 새 `value_env`·`secret_id`나 새 endpoint를 들여올 길이 없다. 콘솔에서 상한을 만들 때는 `connection_id`만 고르고, 서버가 그 연결의 provider를 `definition`에 복사한다.
- 연결 집합은 하나의 출처에서만 온다. `connections.yaml`이 있으면 그 파일의 항목만이다. 없으면(PD-2~PD-4 기간에 아직 파일을 만들지 않은 설치) `profiles.yaml` 각 항목의 provider를 그 프로필 id를 이름으로 한 연결로 본다. 둘을 합치지 않는 것은 연결을 빼는 일이 회수 수단으로 늘 작동하게 하기 위해서다. 합치면 YAML 프로필에 남은 provider가 파일에서 뺀 연결을 되살린다.
- 이 파일을 읽는 일은 PD-2(확장)부터 한다. 그래야 PD-3에서 새 연결과 그 위의 상한을 만든 뒤 PD-2 이미지로 되돌려도 그 연결의 자격 증명이 풀린다. `profiles.yaml`에서 `connections.yaml`을 만드는 CLI(`bun run profiles connections-from-yaml`)도 PD-2가 만들고, `profiles import --check`는 연결이 없는 행을 보고한다. PD-5 이미지는 `connections.yaml`이 없으면 기동하지 않는다.
- PD-3~PD-4 이미지는 `profiles.yaml`도 `connections.yaml`도 없으면 연결 0개로 뜨고 기동 로그에 경고를 남긴다. 그때 모든 행은 `connection_missing`이다. `profiles.yaml`만 빼려면 먼저 `connections-from-yaml`로 연결 파일을 만든다.

### 저장소 허용

**PD-5부터(오너 결정 3을 d81-1 A로 넓혔다, 2026-10-28): 허용은 DB `repository_ids`만 본다.** 가져온 상한도 같다. `repositories.<id>.profiles` 배열은 두 번만 읽는다. 빈 테이블에 시드할 때 각 행의 `repository_ids`로, 그리고 PD-5 마이그레이션이 NULL로 둔 가져온 행을 기동 때 한 번 채울 때. 둘 다 시드와 같은 lock·transaction 안이고, NULL인 행만 채우므로 두 번 돌려도 결과가 같다. 채우기 전에 행을 읽는 replica(다른 api, slack 역할)는 NULL을 자기 배열로 읽는다. 채울 값과 같으므로 그 창에서도 쌍과 revision이 업그레이드 전과 같다. 그 뒤로 배열을 고쳐도 허용은 바뀌지 않는다. 배열은 선택 항목이 되고, 남아 있으면 지금처럼 저장소 객체에 들어가 `catalogRevision`·`repositoryBinding`이 업그레이드로 바뀌지 않는다(지우면 revision이 한 번 바뀐다). 가져온 상한의 저장소를 바꾸려면 그 id를 `previous_id`로 한 콘솔 버전을 만든다. 아래는 PD-2~PD-4 기간의 규칙이다.

지금 "이 프로필이 이 저장소에서 돈다"는 `repositories.<id>.profiles`에 프로필 id를 적는 것이다(`catalog.ts:370-386`). 이 배열은 저장소 객체 안에 있어 `catalogRevision`(`catalog.ts:1043-1059`)과 저장소 route 토큰의 `repositoryBinding`(`catalog.ts:1026-1035`, `862-866`이 `profiles`를 남긴다)에 순서까지 들어간다. 그래서 DB에서 만든 허용을 이 배열에 다시 넣으면 상한 하나를 만들 때마다 revision과 binding이 바뀌어 권위 replica가 바뀌고 발급된 저장소 토큰이 끊긴다.

- 저장소 객체는 `repositories.yaml`에서 읽은 그대로 둔다(배열과 순서 포함). PD-5에서도 바꾸지 않는다.
- 허용 판단(`allowedPair`의 `catalog.ts:1074-1078`, gateway 실행 쌍의 `worker-gateway.ts:536-539`, `584`)은 "저장소 배열에 바탕 id가 있다 **또는** 그 상한 행의 `repository_ids`에 저장소 id가 있다"로 바꾼다. 가져온 id는 지금처럼 YAML 배열이 정하고, 콘솔에서 만든 버전은 자기 `repository_ids`가 정한다(오너 결정 3). 콘솔은 새 버전을 만들 때 앞 버전이 돌던 저장소를 기본값으로 채운다.
- 워크스페이스 판은 지금처럼 바탕의 허용을 물려받는다(`trustedProfileId`, `catalog.ts:789-797`).
- PD-3부터 저장소 배열에 이 replica의 YAML에 없는 id가 있어도 기동을 거부하지 않는다. `profiles.yaml`이 없어도 뜨고 그 id는 DB 행으로 있기 때문이다. 행이 없는 id는 아무 상한도 허용하지 않을 뿐이다. `profiles: none`과 다른 id를 섞는 것은 지금처럼 거부한다.

## 2. 상한과 좁히기

### 층

1. **설치 설정(파일·env, 재배포 필요):** 연결, 저장소와 그 자격 증명, 설치 한도(`SESSION_COST_LIMIT_USD` 등), `PLATFORM_ALLOW_UNATTENDED_PERMISSIONS`.
2. **설치 상한 프로필(DB, 운영자):** 연결 하나 위에서 runtime·모델·도구·권한 모드·`project_settings`·저장소 모드·`repository_ids`를 정한다.
3. **워크스페이스 프로필(DB, 워크스페이스 owner·admin):** 상한 하나를 `WORKSPACE_PROFILE_POLICY`로 좁힌다. 규칙은 지금과 같다(`profile-derivation.ts:60-75`, `115-142`).

운영자는 지금 YAML을 고치는 사람이 하던 일을 콘솔에서 하는 신뢰 주체다. 운영자는 옛 YAML보다 넓은 모델·도구·모드·저장소 쌍을 가진 새 상한을 만들 수 있고, 이것은 의도한 변경이다. 운영자도 넘지 못하는 것은 1층(연결·자격 증명·billing·설치 한도·bypass 스위치)뿐이다.

### 운영자는 누구인가 — 오너 확인 대기(기본값 적용)

- **기본값: 이 설치의 워크스페이스 owner, 로그인한 사람(cookie 세션)만.** 새 action `profile.installation.manage`를 `MANAGEMENT_ROLES`에 `["owner"]`로 둔다(`packages/platform/src/musterrolle/policy.ts:238-258`). 이 표의 action은 API key가 가질 수 없다(`policy.ts:236-237`). 서비스는 지금 워크스페이스 판을 쓸 때처럼 principal이 user인지 다시 본다(`packages/platform/src/sessions/workspace-profiles.ts:186-202`).
- 근거: 설치당 워크스페이스는 하나다. bootstrap은 첫 owner와 기본 워크스페이스를 만들고, 그 뒤로는 새 워크스페이스를 만들지 않는다(`packages/db/src/identity.ts:74-80`). 설치 전체에 걸린 것을 owner만 보게 한 선례도 있다(`usage.installation_read: ["owner"]`, `policy.ts:256`).
- 그래서 누군가를 owner 역할로 올리는 것은 설치 상한을 만들고 은퇴시키는 권한도 주는 것이다. 워크스페이스 판은 강제 정책이 아니라 상한 위의 선택지 하나이고, owner는 상한을 직접 고를 수 있으므로 owner에게 좁히기는 경계가 아니다.
- 다른 안: (B) env `PLATFORM_OPERATOR_EMAILS`로 지정, (C) 별도 `installation_operators` 테이블. 설치에 워크스페이스가 둘 이상 생기는 날 다시 본다. 그때도 action 이름은 그대로 두고 판별만 바꾼다.

### 한 레지스트리

지금은 해석 경로마다 프로필을 읽는 곳이 다르다. release 생성(`agent-service.ts:308`), 세션 시작(`agent-service.ts:63-68`), provider egress 재허가(`packages/platform/src/workers/worker-gateway.ts:1164-1178`)는 `catalogProfile`(`catalog.ts:702-718`)을 지난다. 그러나 gateway의 운영자 claim 후보는 기동 때 `catalog.profiles`를 직접 읽어 한 번 만들고(`worker-gateway.ts:535-563`), 후보 캐시는 워크스페이스 판의 변경만 본다(`worker-gateway.ts:566-575`). DB 다시 읽기도 `ws_` id만 대상이다(`catalog.ts:772-787`).

그래서 PD-2는 **프로필 레지스트리 하나**를 만든다.

- 레지스트리는 DB의 두 테이블과 연결·저장소를 한 번에 읽어 검증한 snapshot을 낸다: 돌 수 있는 상한(연결 일치, 지문 일치, env 검사를 통과한 것), 워크스페이스 판, 저장소 허용 관계. `catalog.profiles`와 `catalog.workspace_profiles`는 둘 다 이 snapshot에서 온다.
- gateway의 claim 후보(운영자 몫 포함)와 claim이 비교하는 catalog revision은 같은 snapshot에서 얻고, snapshot이 바뀔 때 함께 다시 만든다. 지금은 revision도 gateway를 만들 때 한 번 계산해 고정한다(`worker-gateway.ts:614`, `956`).
- **claim이 세션을 실패시키는 조건을 DB 상한까지 넓힌다.** 지금 gateway는 revision이 활성 revision과 같아도, 세션의 `ws_` 프로필을 그 replica가 아직 읽지 못했으면 실패시키지 않고 넘긴다(`packages/db/src/worker-unit-of-work.ts:1093-1094`, 그 밖에는 `1107`, `1171`에서 `catalog_mismatch`로 격리한다). 콘솔 상한은 revision에 들지 않으므로 같은 보호가 필요하다. 세션의 프로필이 DB의 상한(또는 그 위의 판)이고 이 replica에서 돌지 않는 이유가 replica에 따라 다를 수 있는 것(snapshot에 아직 없음, `connection_missing`, `unattended_off`, worker runtime 미지원)이면 실패시키지 않고 넘긴다. 실패시키는 것은 모든 replica에서 같은 이유(은퇴 뒤 새 부착, 바탕 지문 변경, 지운 모델)뿐이다. 구현은 claim에 `settledProfileIds`를 넘긴다: 이 replica에서 도는 상한 id와, 바탕이 이 replica에서 도는 워크스페이스 판 id. 세션의 프로필이 이 집합에 없으면 claim은 실패시키지 않고 넘긴다. 운영 규칙도 같이 둔다: 새 연결·env는 모든 replica에 배포한 뒤에 그것을 쓰는 상한을 만든다.
- 상태와 부착 규칙([6절](#상태와-부착-규칙))의 **읽기**도 PD-2에 넣는다. 은퇴는 PD-3의 API로만 생기지만, PD-3에서 PD-2로 되돌린 뒤에도 은퇴한 상한에 새 release가 붙지 않아야 하기 때문이다.
- 모르는 id가 오면 `ws_` 여부와 상관없이 다시 읽는다(지금 `catalog.ts:782-785`의 규칙을 모든 id로).
- api·slack 두 역할이 같은 레지스트리를 쓴다. slack의 기동(`slack/main.ts:119`)과 release 해석(`slack/main.ts:175-181`)도 이 레지스트리로 옮긴다.

### 상한을 지키는 방법

| 조건 | 어떻게 지키나 | 코드 근거 |
|---|---|---|
| 워크스페이스 판은 상한보다 넓어질 수 없다 | 저장(`refusal`)과 실행(`baseHolds`)이 같은 정책을 쓴다. 상한이 DB로 와도 이 두 자리는 그대로다 | `workspace-profiles.ts:248-259`, `catalog.ts:685-694`, `profile-derivation.ts:152-154` |
| `bypassPermissions`는 env가 열어야 쓴다 | 저장: env가 `true`가 아니면 `bypassPermissions` 상한 저장은 `400`(`reason_code: unattended_not_allowed`). 실행: 레지스트리가 env가 꺼진 프로세스에서 그 상한을 `unattended_off`로 두고 snapshot의 돌 수 있는 상한에서 뺀다. 그 위의 판도 바탕이 없으니 돌지 않는다. 지금 기동을 거부하는 검사(`catalog-config.ts:155-160`)는 "행을 빼고 기동 로그에 id를 적는다"로 바꾼다. DB에 행이 있다고 API가 뜨지 않으면 콘솔 한 번의 저장으로 설치가 멈추기 때문이다 | `catalog-config.ts:155-160`, `280`, `packages/contracts/src/api/session.ts:95-97` |
| 저장할 때만이 아니라 release·claim·egress에서도 막는다 | 위 [한 레지스트리](#한-레지스트리). 모든 해석이 같은 snapshot을 읽으므로 이미 저장된 행과 핀된 release도 같은 검사를 받는다 | `catalog.ts:702-718`, `worker-gateway.ts:535-606`, `1164-1178` |
| `auto`는 env 없이 쓴다 | PR JeongJaeSoon/agent-platform#894 결정 그대로. 분류기가 호출마다 판정하고 쓸 수 없으면 엔진이 그 호출을 거부한다(운영 문서의 실측 기록). 이 문서는 이 동작을 바꾸지 않는다 | `session.ts:89-97`, `docs/operator/api-server.md:244` |
| 연결·자격 증명은 DB로 바꿀 수 없다 | 위 [연결](#연결connectionsyaml) 절. 행의 provider가 연결과 같지 않으면 돌지 않고, 자격 증명은 연결의 참조로만 푼다 | `catalog-config.ts:176-194`, `catalog.ts:814-823` |
| `billing: none`은 사설 endpoint에서만 | billing도 연결에서 온다. `definition`을 같은 스키마로 파싱하므로 사설 주소 규칙도 그대로 걸린다 | `catalog.ts:207-216`, `809-811` |
| worker가 지원하는 runtime·모드만 | 저장과 적재 때 `installedRuntimes.assertProfiles`(runtime 종류와 그 runtime이 받는 권한 모드)를 같이 부른다 | `catalog-config.ts:48`, `161`, `packages/platform/src/sessions/feature-gate.ts:47-58` |

## 3. 이전 경로

### 가져오기(import)

- **언제:** api 역할이 기동할 때, 레지스트리를 처음 읽기 전에 한 번. slack 역할은 가져오지 않고 레지스트리를 읽기만 한다. 워크스페이스가 아직 없는 빈 설치(bootstrap 전)에서도 돈다. 가져오기는 워크스페이스에 묶이지 않는다.
- **무엇을:** `profiles.yaml`의 각 항목을 `installation_profiles` 행 하나로(`origin = 'catalog'`, `version = 1`, `name = NULL`, `repository_ids = []`).
- **멱등 키는 `id`다.** `INSERT … ON CONFLICT (id) DO NOTHING`. 같은 YAML로 두 번, 세 번 돌려도 행 수와 내용이 같다. 여러 replica가 같이 떠도 advisory lock(`profiles:import`) 아래에서 차례로 돈다. bootstrap이 같은 방식을 쓴다(`identity.ts:78-79`).
- **시드 규칙(오너 결정 4, 오너 확인 대기·기본값 적용):** PD-2~PD-4는 기동마다 위 insert-if-absent를 한다. PD-5부터는 `installation_profiles`가 비어 있을 때만 한다(새 설치와 로컬 스택이 바로 뜨는 초기 시드). 빈 테이블 확인, `profiles.yaml` 읽기와 검증, 넣기가 한 advisory lock·transaction 안에 있다. 그래서 두 replica가 빈 DB에서 같이 떠도 한쪽 YAML만 들어간다. 채워진 DB에서는 `profiles.yaml`을 열지도 않는다. 파일이 없거나 깨졌거나 새 id를 더해도 DB와 기동에 아무 영향이 없다.
- **PD-2~PD-4 기간의 YAML 운영 규칙(한 가지):** 새 id를 더하는 것은 된다. 지금의 카탈로그 변경과 같아서 revision이 바뀌고 지금의 `catalog-authority` 롤아웃 절차(`api-server.md:43-52`)를 그대로 밟는다. 이미 있는 id를 고치거나 지우지는 않는다. 지워도 행은 남고(가져오기는 넣기만 한다), PD-3부터는 은퇴로 대신한다.
- **어느 replica든 같은 후보 집합을 본다:** PD-2 이미지는 자기 YAML에 있는 id는 그 YAML 값으로, 나머지 `origin = 'catalog'` 행(다른 replica가 넣었거나 YAML에서 지운 id)과 콘솔 행은 DB 값으로 푼다. 자기 YAML도 기동 때 DB에 넣었으므로 후보 id 집합은 언제나 DB의 집합이다. 그 가운데 실제로 도는 집합은 그 replica의 연결·env·worker runtime 검사를 통과한 것이다. 그래서 **같은 연결 집합·env·저장소 설정·worker runtime 지원을 가지고 가져온 id에 충돌이 없는 replica끼리는** A의 YAML이 `{a}`, B가 `{a, b}`여도 둘 다 `{a, b}`를 풀고 `catalogRevision`(`catalog.ts:1043-1059`, 도는 집합으로 계산)이 같다. `connections.yaml` 없이 두 replica의 YAML provider가 다르면, 다른 provider를 쓰는 id는 그것이 없는 replica에서 `connection_missing`이고 revision도 달라진다. 이것은 지금 카탈로그가 다른 replica가 섞일 때와 같은 상황이고 같은 `catalog-authority` 규칙이 다룬다(revision이 다른 replica는 세션을 실패시키지 않는다, `api-server.md:43`). 이런 replica를 피하려면 provider가 다른 id를 YAML에 더하기 전에 `connections.yaml`을 만들어 모든 replica에 같이 둔다. 0단계 이미지는 자기 YAML 집합으로 계산하므로 0단계와 섞인 동안도 같다.
- **이미 있는 id의 내용이 다를 때(충돌):** 비교 대상은 지문이 아니라 정규화한 `definition` 전체다(canonical JSON). 지문은 모델 목록을 빼므로 충돌을 놓친다. 행은 불변이라 덮어쓰지 않고, 기동 로그에 `Profile import conflict`(id, 서로 다른 최상위 칸 이름)를 남긴다.
  - 확장(PD-2): 그 replica는 자기 YAML 값으로 그 id를 푼다. 같은 id가 콘솔 행이어도 그렇다(0단계 이미지와 같은 값을 보게 하려는 것이다). `import --check`가 이 충돌을 보고하므로 그 YAML id를 다른 이름으로 바꾼다. replica마다 YAML이 다른 것은 지금도 있는 상황이고, 지금처럼 활성 catalog revision이 어느 replica가 세션을 실패시킬지 정한다(`api-server.md:43-52`).
  - 전환(PD-3) 이후: DB 값이 이긴다. YAML 값은 쓰지 않는다.
  - 그래서 PD-3을 올리기 전에 각 replica의 설정 디렉터리로 `bun run profiles import --check`(PD-2가 만드는 읽기 전용 CLI)를 돌린다. 보고하는 것: 같은 id의 `definition` 충돌, DB의 `origin = 'catalog'` id 중 이 YAML에 없는 것, 이 YAML의 id 중 DB에 없는 것, 연결이 없는 행, 그리고 이 YAML만으로 계산한 revision과 DB 집합으로 계산한 revision. 앞의 넷이 0이고 두 revision이 같아야 0으로 끝난다. 그래야 PD-3에서 PD-2로, PD-2에서 0단계로 되돌린 이미지가 같은 집합·같은 revision을 본다. 충돌이 있으면 YAML을 DB 값으로 되돌리거나 바꾼 내용을 새 id로 옮긴다. YAML에 없는 DB id가 있으면 그 id를 YAML에 되살린다(0단계로 되돌릴 일이 없다고 판단하면 남겨 두고 PD-3에서 은퇴시킨다).

### 기존 id와 프로필 객체를 지키는 방법

| 무엇이 고정하나 | 왜 안 깨지나 |
|---|---|
| release id(`release-ids.ts:61-75`): `runtime_profile_id`, `profile_digest`, 프로필에서 만든 `runtime_config_snapshot`(`release-ids.ts:156-167`) | 가져온 행의 id는 YAML id 그대로이고, `definition`이 YAML 항목 그대로라 같은 `sessionCatalogView`·`resolveSessionCatalog`를 지나 같은 객체가 된다. 지문과 snapshot이 그 객체에서 나온다 |
| 세션·시도·checkpoint의 `profile_id`·`profile_fingerprint`(`schema.ts:881-887`, `1951-1952`, `1859-1860`)와 v1 지문 | 위와 같다. v1 지문도 `profileFingerprintV1`이 같은 객체에서 계산한다(`catalog.ts:910-917`, `947-956`) |
| 지문에서 빠진 모델 목록 | `definition`에 `models`가 그대로 있으므로 release 모델 검사(`agent-service.ts:75-82`)와 `baseHolds`의 좁히기 검사(`catalog.ts:685-694`)가 같은 결과다 |
| 워크스페이스 판의 `base_profile_id`·`base_fingerprint`(`0174:6-7`) | 바탕 id와 지문이 그대로다 |
| 활성 catalog revision(`catalog_authority`, `schema.ts:2331-2340`)과 저장소 binding | `catalogRevision`(`catalog.ts:1043-1059`)은 `origin = 'catalog'` 행과 `repositories.yaml` 그대로의 저장소 객체로 지금과 같은 식으로 계산한다. 콘솔에서 만든 `op_` 행과 `repository_ids`는 워크스페이스 판처럼 revision에 넣지 않는다(`api-server.md:92`의 규칙 8). 저장소 객체를 바꾸지 않으므로 `repositoryBinding`도 같다 |

PD-2의 검증: `config/`, `config/fake-model/`, `config/fake-model-unattended/`, `config/local-model/`의 모든 프로필에 대해 YAML 경로와 DB 경로가 같은 것을 확인한다. 비교 대상은 해석된 프로필 객체 전체, `profilePins`(v2·v1, `catalog.ts:1004-1018`), `profileModels`, 판 하나를 얹은 `baseHolds`, `deriveReleaseId`에 들어가는 release 내용, `runtimeConfigOf`(`catalog.ts:614-628`, worker가 checkpoint 지문에 넣는 값), `catalogRevision`이다. 이미 있는 main 지문 고정 테스트(`apps/control-host/src/api/catalog-config.test.ts:307-330`)가 DB 경로로도 같은 값을 내야 한다.

## 4. 감사

- **누가·언제:** 행 자체가 `created_by`·`created_at`·`retired_by`·`retired_at`을 가진다. 가져온 행은 `created_by`가 NULL이고 `origin = 'catalog'`이다.
- **무엇을:** 행이 바뀌지 않으므로 그 id의 행이 곧 그 시점의 내용이다. 이전 내용은 `previous_id`로 이어진 앞 버전에 그대로 있다. 행을 바꾸거나 지우는 경로를 두지 않으므로 누가·언제·무엇이 행에 남는다.
- **receipt:** 사람이 한 쓰기에만, 쓰기와 같은 transaction에 남긴다(지금 워크스페이스 판의 방식, `packages/db/src/workspace-profiles.ts:45-72`). receipt의 `owner_id`(NOT NULL, `schema.ts:1433`)는 그 사람의 워크스페이스 id다.

| operation | actor | result |
|---|---|---|
| `create_installation_profile` | 운영자 | `profile_id`, `name`, `version`, `previous_id`, `fingerprint`, `permission_mode`, `connection_id`, `repository_ids` |
| `retire_installation_profile` | 운영자 | `profile_id` |
| `block_installation_profile`, `unblock_installation_profile` | 운영자 | `profile_id` (PD-5) |
| `create_workspace_profile`, `retire_workspace_profile` | 그대로 | 그대로 |

가져오기는 receipt를 남기지 않는다. 빈 설치에서는 bootstrap 전이라 receipt가 걸 워크스페이스가 없고(`identity.ts:74-105`), 가져온 행 자체가 기록이다. 기동 로그에도 `Profiles imported`(새로 넣은 id 목록)를 남긴다.

## 5. 롤백: 확장 → 전환 → 정리

**오너가 호환성 없이 파괴적 변경을 허용했다(2026-10-28).** 전환(PD-3)부터는 앞 단계 이미지로 되돌리는 것을 요구하지 않는다. 아래 규칙과 표는 확장(PD-2)까지 지킨 기록이고, PD-3 이후 단계는 이 규칙을 지키려고 호환 코드를 두지 않는다. 예: PD-3이 쓰는 receipt 종류 `create_installation_profile`·`retire_installation_profile`은 PD-2 이미지가 읽지 못하고, release 없는 새 세션의 은퇴 확인도 PD-2 이미지에는 없다.

규칙 하나: **N단계 이미지는 N+1단계가 남기는 DB와 파일을 읽을 수 있어야 한다.** 그래서 한 단계를 되돌려도 앞 이미지가 그 상태를 읽고 계속 돈다. 마이그레이션은 추가만 하고 되돌리지 않는다.

| 단계 | PR | 이미지가 하는 일 | 되돌릴 때 앞 이미지가 멈추지 않는 이유 |
|---|---|---|---|
| 0. 지금 | — | YAML만 읽는다 | — |
| 1. 확장 | PD-2 | 테이블 추가, 기동 때 가져오기, `connections.yaml` 읽기, 레지스트리(api·slack). 가져온 id의 정본은 그 replica의 YAML, `op_` 행은 DB | 0단계 이미지는 새 테이블과 `connections.yaml`을 읽지 않고 YAML을 읽는다. 가져온 행과 YAML은 같은 객체·revision이므로 release·세션·워크스페이스 판이 같은 프로필로 풀린다. 이 단계에는 `op_` 행을 만드는 API가 없으므로 0단계 이미지가 모르는 프로필도 없다 |
| 2. 전환 | PD-3(API), PD-4(콘솔) | DB가 정본. 상한 쓰기 API. `profiles.yaml`은 없어도 뜬다 | 1단계 이미지는 `op_` 행, `repository_ids`, `connections.yaml`의 새 연결을 이미 읽으므로 콘솔에서 만든 상한과 그 위의 판·release가 계속 돈다. 가져온 행의 집합·내용·revision은 YAML과 같다(전환 전 `import --check`가 0). 운영자는 전환 기간에 `profiles.yaml`의 기존 id를 고치거나 지우지 않는다 |
| 3. 정리 | PD-5 | `profiles.yaml`은 빈 테이블일 때의 시드로만 읽는다. 연결은 `connections.yaml`에서만 읽고, 이 파일이 없으면 기동하지 않는다 | **PD-5를 올리기 전에** 운영자가 `connections-from-yaml`로 `connections.yaml`을 만들고 `import --check`로 연결 없는 행 0을 확인한다(PD-2부터 할 수 있다). 2단계 이미지는 이미 그 파일을 유일한 연결 출처로 읽고 `profiles.yaml` 없이도 뜬다. 행과 revision은 그대로다. `profiles.yaml`은 정리 이미지가 안정된 뒤에 지운다 |

알려진 한계: 0단계 이미지로 되돌리면 `op_` 상한과 그 위 판으로 만든 세션은 0단계 이미지가 모르는 id라 첫 claim에서 `catalog_mismatch`가 되고 입력은 남는다. 0174 배포 때와 같은 한계이고 같은 규칙으로 막는다: 모든 replica가 1단계 이상이 된 뒤에 2단계를 올린다(`api-server.md:96`). 2단계에서 0단계로 한 번에 내리지 않는다.

## 6. API

| 메서드·경로 | 누가 읽고 쓰나 | 내용 |
|---|---|---|
| `GET /v1/profiles` (있음) | 구성원, read scope key | 한 목록. `source`는 `operator`·`workspace` 그대로(값을 바꾸면 기존 SDK가 깨진다). `source: operator` 항목에 optional `installation` 객체를 더한다: `name`, `version`, `origin`, `state`, `connection_id`, `title_model`, `project_settings`, `previous_id`, `created_by`, `created_at`, `retired_by`, `retired_at`. 워크스페이스 판의 `workspace` 객체에도 `created_by`·`retired_by`를 더한다. 더하는 방식은 지금의 optional 필드와 같다(`profiles.ts:76-94`) |
| `GET /v1/installation-profiles/options` (새) | 운영자 | 생성 화면이 고를 것: `connections`(`id`, `kind`, `billing`만. endpoint·참조 이름은 내보내지 않는다, `profiles.ts:56-59`와 같은 원칙), `runtimes`(`runtime_kind`와 받는 권한 모드), `repositories`(id), `unattended_allowed`(env 값) |
| `POST /v1/installation-profiles` (새) | 운영자, cookie 세션만 | 본문: `name`, `connection_id`, `runtime_kind`, `runtime_version`, `model`, `models`, `title_model?`, `tools`, `permission_mode`, `project_settings`(기본 `{ claude_md: false }`), `repository_mode`(기본 `required`), `repository_ids`, `previous_id?`. 기본값은 지금 스키마의 기본값과 같다(`catalog.ts:194-195`). 응답: `{ profile, receipt_id }`(`profiles.ts:135-141`과 같은 모양). 오류(`details.reason_code`): `400` `unknown_connection`·`runtime_not_installed`·`unattended_not_allowed`·`unknown_repository`·`model_not_in_models`·`unknown_previous`·`invalid_profile`(정의 스키마 위반, `details.field`), `403`(admin·member, API key), `409` `REVISION_CONFLICT`의 `stale_previous`(`details.latest_id`)·`id_taken`. 아래 `previous_id` 규칙이 같은 이름 동시 저장을 막는다 |
| `POST /v1/installation-profiles/{profile_id}/retire` (새) | 운영자, cookie 세션만 | 은퇴. 이미 은퇴했으면 `receipt_id: null`. 정의가 이 이미지의 스키마로 읽히지 않는 행(`definition_drift`의 한 경우)은 목록에 없고 은퇴도 `404`다. 그 행은 어차피 아무것도 돌리지 않는다 |
| `POST /v1/installation-profiles/{profile_id}/block`, `…/unblock` (PD-5) | 운영자, cookie 세션만 | 차단과 해제. 응답은 은퇴와 같은 `{ profile, receipt_id }`이고, 이미 그 상태면 `receipt_id: null`. 읽히지 않는 행은 `404`. [회수](#회수-차단) 참고 |
| `POST /v1/workspace-profiles`, `…/retire` (있음) | 그대로 owner·admin | `base_profile_id`는 `usable`인 상한 id 아무것이나. 그 밖의 상한은 `400`(`reason_code`는 그 상한의 상태) |

`previous_id`는 서버가 이렇게 정한다. 같은 `name`의 콘솔 버전이 있으면 `previous_id`는 그 가운데 최신 버전의 id여야 하고, 아니면 `409` `stale_previous`이며 `details.latest_id`가 최신 id다. 없으면 `previous_id`는 비우거나(새 계열) 이미 있는 행의 id(가져온 상한을 고쳐 새 이름으로 옮길 때)여야 하고, 없는 id면 `400` `unknown_previous`다. 판정과 쓰기는 가져오기와 같은 advisory lock 안에서 하므로, 같은 이름을 동시에 저장하면 하나가 v1이 되고 다른 하나는 `stale_previous`를 받는다. 콘솔은 그 응답의 `latest_id`를 다시 읽어 사람이 고른다.

### 상태와 부착 규칙

- 상한의 상태: `usable`, `retired`, `blocked`(PD-5, 다른 모든 상태보다 먼저 정한다), `connection_missing`, `unattended_off`, `definition_drift`, `runtime_unsupported`(이 이미지의 worker가 그 runtime이나 권한 모드를 받지 않음). 워크스페이스 판에는 `base_retired`(바탕이 은퇴함)와 `base_blocked`(PD-5, 바탕이 차단됨)를 더한다. PD-2는 이 상태를 레지스트리 안에서만 쓴다(기동 로그 `Profiles left out of this replica's catalog`에 id와 상태). API 응답에 내보내는 것은 PD-3이다. `workspaceProfileStateSchema`(`profiles.ts:25-30`)에 값을 더하는 것이라 같은 PR에서 web·SDK 생성물을 함께 갱신한다.
- 지금 `workspaceProfileRefusal`은 `ws_`가 아닌 id를 바로 통과시키고(`catalog.ts:746`), 은퇴 예외는 정확히 `retired`만 본다(`catalog.ts:751-753`). PD-2가 이 함수를 상한 id까지 보는 부착 검사로 넓히고(롤백한 이미지도 은퇴를 지키도록), PD-3은 은퇴를 만드는 쓰기 API를 더한다.

| 쓰임 | 상한 `retired` | 판 `base_retired` | 그 밖의 비 `usable` |
|---|---|---|---|
| 새 release, release 없는 새 세션, 새 판의 바탕 | 거절 | 거절 | 거절 |
| 이미 만든 release의 새 세션, 진행 중인 세션 | 돈다 | 돈다 | 돌지 않는다 |

부착 검사는 replica의 snapshot을 본다. 그래서 다른 replica에서 은퇴한 상한은 snapshot이 다시 읽힐 때까지(최대 1초) 이 replica에서 새 부착을 받을 수 있다. release·판을 쓰는 트랜잭션 안에서 상한 행을 다시 읽지는 않는다. 은퇴는 새 부착을 막을 뿐 이미 붙은 것을 멈추지 않으므로, 그 1초 사이에 붙은 release도 은퇴 직전에 붙은 release와 같게 다뤄진다. 실행 중에도 멈춰야 하면 아래의 회수 수단을 쓴다.

### 회수: 차단

은퇴는 지금 판의 규칙(`api-server.md:90`)처럼 새 부착만 막는다. 상한 하나를 실행 중에도 멈추는 수단은 PD-5부터 **차단**이다(리드 결정 2026-10-28: 보류 이유였던 호환 단계가 사라졌고 오너 목표가 재배포 없는 관리다). 차단은 DB 상태라 모든 replica에서 같으므로(snapshot이 다시 읽히는 최대 1초 뒤) 실패시켜도 되는 이유다.

| 차단한 상한과 그 위 판 | 어떻게 되나 |
|---|---|
| 새 release, 새 세션(release가 있든 없든), 새 판의 바탕 | 거절. 상태는 `blocked`·`base_blocked` |
| 다음 턴을 기다리는 세션 | 그 상한이 실행 집합에서 빠지고 `settledProfileIds`에는 남으므로 다음 claim이 `catalog_mismatch`로 격리한다. 입력은 남는다 |
| 지금 도는 턴 | proxy의 다음 재허가에서 provider·저장소 요청이 끊긴다(연결을 뺄 때와 같은 경로, `worker-gateway.ts`의 egress 재허가) |
| 해제 | 상한이 원래 상태(`usable`·`retired`)로 돌아온다. 이미 격리된 세션은 되살리지 않는다 |

해제도 운영자만 한다. 실수로 막은 상한의 release를 버리지 않게 하려는 것이다. 차단과 해제는 행의 `blocked_at`·`blocked_by`를 바꾸고 receipt를 남긴다.

그 밖의 수단도 그대로 있다. `bypassPermissions`에 대해서는 env, 그리고 연결을 빼는 것이다(`connection_missing`). `connections.yaml`이 있는 설치에서는 그 파일에서 빼면 된다. 아직 없는 설치(PD-2~PD-4)에서는 먼저 `connections-from-yaml`로 파일을 만든 뒤 뺀다. 연결 출처가 하나라 이 순서면 PD-2 이상의 어느 이미지로 되돌려도 뺀 연결이 되살아나지 않는다. 0단계 이미지는 `connections.yaml`을 읽지 않고 `profiles.yaml`의 provider를 다시 쓰므로, 연결을 이렇게 회수한 뒤에는 0단계로 되돌리지 않는다. 어느 이미지에서도 통하는 회수는 provider 쪽에서 그 자격 증명을 폐기하고 유효한 대체 값을 주지 않는 것이다. 같은 참조에 정상적인 새 키를 넣는 것은 회전이지 회수가 아니다. 지문은 값을 빼고 계산하므로(`catalog.ts:868-875`) 새 값으로 그대로 계속 돈다.

- 새 경로는 `apps/control-host/src/api/openapi.ts`(지금 프로필 경로는 `3404`, `3438`, `3469`), `route-error-coverage.ts:86-87`, `packages/core`의 응답 표, `packages/client` 생성물에 같이 들어간다.

## 7. 콘솔

지금은 `/profiles`(`apps/web/src/router.tsx:324-328`)와 `/profiles/$profileId`(`router.tsx:330-334`)뿐이고, "프로필 만들기"는 같은 페이지의 인라인 편집기를 연다(`apps/web/src/routes/profiles.tsx:174`, `222-230`). 운영자 섹션 설명은 "설치 설정 파일을 고친 뒤 다시 배포하세요"다(`apps/web/src/i18n/profiles.ts:12-13`).

- **`/profiles` 목록:** 한 표. 열은 이름, 버전, 종류(설치 상한·워크스페이스), 바탕(워크스페이스 판만), 기본 모델, 권한 모드, 상태. 종류 필터(전체·설치 상한·워크스페이스). 재배포 안내 문구는 지운다. "프로필 만들기"(owner·admin)와 "설치 상한 만들기"(운영자만) 버튼은 둘 다 아래 생성 페이지로 간다.
- **`/profiles/new` 전용 생성 페이지:** 쿼리 `?kind=workspace|installation&from=<id>&mode=version|remake`. 인라인 편집기의 `mode`(`apps/web/src/routes/profile-editor.tsx:40-44`)를 이 쿼리가 대신한다.
  1. 종류: 워크스페이스 프로필 / 설치 상한(운영자에게만 보인다).
  2. 바탕(워크스페이스) 또는 연결(설치 상한, `options`의 `connections`). 워크스페이스는 `usable` 상한만, `auto`를 허용하는 것을 먼저 보인다(지금 `profiles.tsx:101-102`의 순서).
  3. 값: 기본 모델과 모델 목록, 도구, 권한 모드. 워크스페이스 판은 `WORKSPACE_PROFILE_POLICY.choices`가 고를 수 있는 것을 정한다. 설치 상한은 runtime(`options.runtimes`), `title_model`, `project_settings`, 저장소 모드와 저장소(`options.repositories`)도 고른다. `options.unattended_allowed`가 false면 `bypassPermissions`는 비활성과 이유 한 줄, 고르면 위험 안내(PR JeongJaeSoon/agent-platform#894의 문구를 다시 쓴다).
  4. 검토: 바탕 또는 앞 버전과 달라진 칸만 보여 준다. 저장하면 새 프로필의 상세 페이지로 간다.
- **`/profiles/$profileId` 상세:** 설정 전체, 상태와 그 이유, 같은 계열의 버전 목록(`previous_id`로 이어진 것), (상한이면) 이 상한을 바탕으로 한 워크스페이스 판, 만든 사람·시각·은퇴한 사람·시각. 버튼: 새 버전(`/profiles/new?from=<id>&mode=version`), 다시 만들기(바탕이 바뀐 판), 은퇴(확인 대화 상자).
- **release 탭과 새 에이전트 흐름의 프로필 선택:** 지금 `pickable`은 운영자 프로필을 상태와 상관없이 고를 수 있게 둔다(`apps/web/src/components/profile-options.tsx:5-6`). PD-4는 이것을 "상한은 `installation.state`가, 판은 `workspace.state`가 `usable`일 때만"으로 바꾼다. 목록에는 모든 프로필이 상태와 함께 보이고, 고를 수 있는 것만 선택지가 된다.
- i18n ko·en·ja를 같이 고친다.

## 8. 단계별 PR 계획

| PR | 범위 | 검증 |
|---|---|---|
| PD-2 마이그레이션·이전(확장) | migration(다음 번호, 작성 시점 `0187`)으로 `installation_profiles` 추가. 기동 때 가져오기(advisory lock, insert-if-absent). `connections.yaml` 읽기와 연결 기반 자격 증명 해석. [한 레지스트리](#한-레지스트리)(api·slack, gateway claim 후보 포함). 저장소 허용 관계. env·연결·지문 검사. `profiles import --check`, `profiles connections-from-yaml` CLI | 실제 postgres 통합 테스트: 같은 카탈로그로 가져오기를 두 번 돌려 행 수·내용이 같다. 빈 DB(bootstrap 전)에서 가져오기. 두 replica가 동시에 기동. YAML 집합이 다른 두 replica가 같은 연결 파일 아래에서 같은 id 집합과 revision을 푼다. 연결 파일 없이 provider가 다른 경우에는 없는 쪽이 `connection_missing`이고 revision이 달라 그 replica가 세션을 실패시키지 않는다. 콘솔 행과 같은 id의 YAML 항목은 넣지 않고 충돌로 보고한다. 은퇴 행이 PD-2 이미지에서도 새 부착을 막는다. gateway의 후보와 revision이 같은 snapshot에서 나온다. 가져온 프로필·저장소가 같은 두 replica 중 하나에만 새 연결을 두고 그 연결의 콘솔 상한으로 세션을 만들면, 연결이 없는 replica의 claim은 세션을 실패시키지 않고 넘기고 연결이 있는 replica가 그 세션을 돌린다. `connections.yaml`이 있으면 YAML provider를 연결로 보지 않는다(빼면 `connection_missing`). [위 비교 목록](#기존-id와-프로필-객체를-지키는-방법)을 네 카탈로그 전부에서. DB에 `op_` 행을 직접 넣고 release 생성·세션 시작·claim·provider egress가 그 행으로 도는지, env를 끈 프로세스에서는 bypass 상한과 그 위 판이 네 경로 모두에서 거절되는지(gateway·agent-service·slack 테스트). 0단계 이미지와 같은 DB에서 revision이 같다. `bun run typecheck`, `bun test` |
| PD-3 API 전환 | DB 정본으로 해석. 쓰기 API·`options`·`profile.installation.manage`. 상태·부착 규칙. `profiles.yaml` 없이 기동. OpenAPI·SDK·core 응답 표. 콘솔의 프로필 선택지가 `usable`이 아닌 상한을 고르지 못하게 하고 그 상태를 보인다(은퇴 API와 함께 나와야 은퇴한 상한을 고르고 서버가 거절하는 구간이 없다) | 서비스 테스트: owner만 상한 저장, admin·member `403`, API key `403`, env 꺼짐에서 bypass 저장 `400`, `id_taken`. 부착 규칙 표의 각 칸. **운영자 상한 E2E**(`tests/e2e`, fake model): owner가 상한 v2를 만들고 admin이 그 위에 판을 만들어 세션이 돈다. 상한 v1의 기존 release는 계속 돈다. v1을 은퇴하면 v1 위의 새 release는 거절되고 기존 release의 새 세션은 돈다. (앞 이미지로 되돌리는 검증은 [5절](#5-롤백-확장--전환--정리)의 오너 결정으로 뺐다) |
| PD-4 콘솔 | 목록·상세·`/profiles/new`·`pickable`·i18n·stories | web 테스트, 390px 포함 화면 확인과 스크린샷, ui-review |
| PD-5 정리(호환 없이, 오너 2026-10-28) | `profiles.yaml`은 빈 테이블일 때의 시드로만(빈 확인·읽기·넣기가 한 lock·transaction), `connections.yaml` 필수(없으면 이름을 대며 기동 거부, YAML provider를 연결로 보는 fallback 삭제). 저장소 허용을 DB `repository_ids`로만 판정하고, 마이그레이션(다음 번호)이 가져온 행을 NULL로 두면 기동이 `repositories.yaml` 배열에서 한 번 채운다. 상한 [차단](#회수-차단)·해제 API와 상태 `blocked`·`base_blocked`. `profiles import --check` 삭제(롤백 확인용이었다). 네 설정 디렉터리(`config/`, `config/fake-model/`, `config/fake-model-unattended/`, `config/local-model/`)에 `connections.yaml`. 운영 문서와 `apps/docs`. 차단 버튼은 콘솔 작업 몫 | 실 postgres 통합 테스트: 빈 테이블 시드, 채워진 DB에서 YAML의 새 id·바뀐 내용·깨진 파일이 DB를 바꾸지 않음, 두 replica 동시 시드, 이전 두 번 같은 결과. 차단: owner만(admin·member·API key `403`), 새 release·세션·claim 거절, 대기 세션 claim 격리, 해제. 연결 파일 없이 기동 거부. 빈 DB에서 `scripts/local.sh up --fake-model`. 운영자 상한 E2E에 차단 시나리오. verify 스택에서 시드·이전·차단과 덤프 diff |

각 PR의 첫 커밋 전에 이 문서의 해당 절을 다시 읽고, 계약과 다르게 가야 하면 이 문서를 먼저 고친다.

## 확장 지점: 팀 프로필

만들지 않는다(이전 오너 결정 a안). 나중에 만든다면 `workspace_profiles`에 `team_id`를 더하거나 같은 모양의 `team_profiles`를 두고, 바탕을 워크스페이스 판으로 삼아 같은 `ProfileDerivationPolicy`로 한 층 더 좁힌다(`profile-derivation.ts:31-53`은 바탕과 판의 쌍만 안다). 이 문서의 테이블·API는 그 층을 위한 열이나 값을 미리 두지 않는다.

## 대안

- **한 테이블에 두 종류.** [위](#한-테이블로-합치지-않은-이유)의 이유로 고르지 않았다.
- **상한은 설치 설정에 두고(`limits`) 프로필만 DB로.** 상한을 바꿀 때마다 재배포가 남는다. 오너가 없애려는 재배포가 바로 이것이라 고르지 않았다.
- **연결·자격 참조까지 전부 DB로.** 콘솔 쓰기 하나로 임의 endpoint와 API가 가진 다른 자격 증명 참조를 묶을 수 있다(`catalog.ts:814-823`가 그 값을 upstream 헤더에 싣는다). 고르지 않았다.
- **상한을 제자리에서 고치기.** 지문에 드는 실행 설정을 바꾸거나 쓰던 모델을 뺄 때마다 그 위의 판과 release가 거절된다(`catalog.ts:685-694`, `agent-service.ts:75-82`). 모델 추가나 `title_model` 변경처럼 핀에 들지 않는 변경만 무사하고(`catalog.ts:183-188`), 모델 제거는 그 모델을 쓰던 release·세션·판만 멈춘다. 오너 결정 2의 B안이다.
- **DB 허용을 `repositories.<id>.profiles` 배열로 되돌려 넣기.** revision과 저장소 binding이 상한마다 바뀐다. [저장소 허용](#저장소-허용) 참고.

## 오너 결정 (모두 오너 확인 대기, 기본값 적용)

1. 운영자 판별: **A 워크스페이스 owner(기본)** / B env로 지정 / C 별도 테이블. 어느 안이든 운영자는 모델·도구·권한 모드·저장소 쌍을 옛 YAML보다 넓힐 수 있다(연결·자격 증명·billing·bypass 스위치는 못 바꾼다).
2. 상한을 바꾸는 방식: **A 불변 버전 + 은퇴(기본)** / B 제자리 변경.
3. 저장소 허용: **A 콘솔에서 만든 상한은 행의 `repository_ids`로 DB에서, 운영자만 고친다. 가져온 id는 `repositories.yaml` 그대로(기본)** / B 모두 `repositories.yaml`(새 상한 계열마다 재배포).
4. 정리 단계 뒤 `profiles.yaml`: **A 빈 테이블일 때의 초기 시드(기본)** / B 읽지 않음.
