# 결정: 실행 프로필을 DB 하나로 관리한다

- 상태: **폐기됨.** 실행 프로필은 이 결정을 대체한 프로필 제거 변경에서 통째로 지웠다(migration `0270_remove_profiles`, 기존 데이터는 이전하지 않고 지움). 지금은 에이전트 release가 provider 연결과 카드 모델로 실행 spec을 고정하고, 묻기·막기 규칙은 워크스페이스와 에이전트의 실행 규칙이 정한다. 이 문서는 다른 결정 기록이 가리키는 결정의 요약이다.
- 폐기 전에 대체된 것: 설정 파일(`profiles.yaml` 시드, `connections.yaml`)을 읽는 부분과, 상한이 `repository_ids` 나열로만 저장소를 허용하는 [저장소 허용](#저장소-허용) 규칙(GitHub App 저장소의 `installed`)은 [settings-replace-file-catalog.md](settings-replace-file-catalog.md)가 대체했다.
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

## 데이터 모델

설치 상한은 `installation_profiles`, 워크스페이스 판은 `workspace_profiles`(0174)에 둔다. 한 테이블로 합치지 않았다. 합치면 0174의 `ws_` CHECK와 `workspace_id`·`created_by` NOT NULL을 풀어야 하고, 옛 이미지는 테이블 전체를 워크스페이스 판으로 읽으므로 롤백한 이미지가 상한 행을 워크스페이스 판으로 잘못 읽는다. 그래서 테이블은 둘, API·콘솔의 개념은 하나(`GET /v1/profiles`의 한 목록)다.

행은 바뀌지 않는다. 바뀌는 것은 은퇴(`retired_at`·`retired_by`)와 차단(`blocked_at`·`blocked_by`) 표시, 그리고 가져온 행의 `repository_ids`를 NULL에서 한 번 채우는 것뿐이다. 상한을 고치면 다음 버전이 새 id로 생기고 `previous_id`가 앞 버전을 가리킨다(오너 결정 2). 기존 워크스페이스 판과 release는 옛 id를 그대로 가리키므로 멈추지 않는다.

상한 행의 `definition`은 YAML 프로필 항목 그대로 둔다. YAML에서 읽은 것과 DB에서 읽은 것이 같은 해석 함수를 지나 같은 객체가 된다. 이 전환에서 가장 지켜야 할 것이 기존 id가 같은 프로필 객체로 풀리는 것이기 때문이다. 지문만이 아니라 지문에서 빠진 칸(모델 목록)까지 같아야 한다.

## 연결

provider 연결(endpoint·자격 증명 참조·billing)은 DB가 아니라 설치 설정 파일 `connections.yaml`에 둔다. DB 행의 `definition.provider`는 어떤 연결과 정확히 같아야 돌고, 같은 연결이 없으면 그 행은 `connection_missing`이다. 자격 증명은 연결의 참조로만 푼다. 그래서 DB 행이 새 `value_env`·`secret_id`나 새 endpoint를 들여올 길이 없다. 콘솔에서 상한을 만들 때는 `connection_id`만 고르고, 서버가 그 연결의 provider를 `definition`에 복사한다.

## 저장소 허용

정리 단계([롤백](#롤백)의 셋째 단계)부터 허용은 DB의 `repository_ids`만 본다(오너 결정 3을 넓혔다). 가져온 상한도 같다. 그 전 단계에서는 가져온 id는 저장소 배열이, 콘솔에서 만든 버전은 자기 `repository_ids`가 정한다. `repositories.<id>.profiles` 배열은 빈 테이블에 시드할 때와 NULL로 남은 가져온 행을 기동 때 한 번 채울 때만 읽는다. 허용을 그 배열에 되돌려 넣지 않는다. 그 배열은 저장소 객체 안에 있어 `catalogRevision`과 저장소 route 토큰의 `repositoryBinding`에 순서까지 들어간다. DB에서 만든 허용을 그 배열에 다시 넣으면 상한 하나를 만들 때마다 revision과 binding이 바뀌어 권위 replica가 바뀌고 발급된 저장소 토큰이 끊긴다.

## 운영자

설치 상한을 만들고 은퇴·차단하는 운영자는 이 설치의 워크스페이스 owner이고, 로그인한 사람(cookie 세션)만이다. action `profile.installation.manage`는 API key가 가질 수 없다. 근거는 설치당 워크스페이스가 하나라는 것이다. bootstrap은 첫 owner와 기본 워크스페이스를 만들고, 그 뒤로는 새 워크스페이스를 만들지 않는다. 운영자는 옛 YAML보다 넓은 모델·도구·모드·저장소 쌍을 가진 새 상한을 만들 수 있다. 운영자도 넘지 못하는 것은 연결·자격 증명·billing·설치 한도·bypass 스위치다. 다른 판별 방법(env로 지정, 별도 테이블)은 설치에 워크스페이스가 둘 이상 생기는 날 다시 본다.

## 한 레지스트리

release 생성, 세션 시작, gateway의 claim 후보, provider egress 재허가가 모두 프로필 레지스트리 하나의 snapshot을 읽는다. api·slack 두 역할이 같은 레지스트리를 쓴다. 그래서 저장할 때만이 아니라 이미 저장된 행과 핀된 release도 같은 검사(연결 일치, 지문 일치, `bypassPermissions`를 여는 env, worker가 지원하는 runtime·모드)를 받는다. 세션의 프로필이 이 replica에서 돌지 않는 이유가 replica에 따라 다를 수 있으면 claim은 세션을 실패시키지 않고 넘긴다. 실패시키는 것은 모든 replica에서 같은 이유뿐이다.

## 시드

`profiles.yaml`은 `installation_profiles`가 비어 있을 때의 초기 시드로만 읽는다(오너 결정 4). 빈 테이블 확인, 파일 읽기와 검증, 넣기가 한 advisory lock·transaction 안에 있어서, 두 replica가 빈 DB에서 같이 떠도 한쪽 YAML만 들어간다. 채워진 DB에서는 파일을 열지도 않는다. 파일이 없거나 깨졌거나 새 id를 더해도 DB와 기동에 영향이 없다.

## 감사

행 자체가 `created_by`·`created_at`·`retired_by`·`retired_at`을 가진다. 행이 바뀌지 않으므로 그 id의 행이 곧 그 시점의 내용이고, 이전 내용은 `previous_id`로 이어진 앞 버전에 있다. 사람이 한 쓰기에는 쓰기와 같은 transaction에서 receipt를 남긴다(`create_installation_profile`, `retire_installation_profile`, `block_installation_profile`, `unblock_installation_profile`). 가져오기는 receipt를 남기지 않는다. 가져온 행 자체가 기록이다.

## 롤백

확장 → 전환 → 정리 세 단계로 옮긴다. 규칙은 하나다: N단계 이미지는 N+1단계가 남기는 DB와 파일을 읽을 수 있어야 한다. 마이그레이션은 추가만 하고 되돌리지 않는다. 오너가 호환성 없이 파괴적 변경을 허용했으므로(2026-10-28), 전환부터는 앞 단계 이미지로 되돌리는 것을 요구하지 않는다. 알려진 한계: 확장 앞(0단계) 이미지로 되돌리면 그 이미지가 모르는 id의 세션은 첫 claim에서 `catalog_mismatch`가 되고 입력은 남는다. 그래서 모든 replica가 확장 단계 이상이 된 뒤에 전환을 올리고, 전환에서 0단계로 한 번에 내리지 않는다.

## 회수

은퇴는 새 부착(새 release, release 없는 새 세션, 새 판의 바탕)만 막고 이미 붙은 것은 멈추지 않는다. 상한 하나를 실행 중에도 멈추는 수단은 차단이다. 차단한 상한과 그 위 판은 새 release와 새 세션을 거절하고, 다음 턴을 기다리는 세션은 다음 claim이 `catalog_mismatch`로 격리하며(입력은 남는다), 지금 도는 턴은 proxy의 다음 재허가에서 provider·저장소 요청이 끊긴다. 해제도 운영자만 하고, 이미 격리된 세션은 되살리지 않는다. 연결을 빼는 것(`connection_missing`)도 회수 수단이다. 같은 참조에 정상적인 새 키를 넣는 것은 회전이지 회수가 아니다. 지문은 자격 증명 값을 빼고 계산하므로 새 값으로 그대로 계속 돈다.

## 확장 지점: 팀 프로필

만들지 않는다(이전 오너 결정 a안). 나중에 만든다면 `workspace_profiles`에 `team_id`를 더하거나 같은 모양의 `team_profiles`를 두고, 바탕을 워크스페이스 판으로 삼아 같은 `ProfileDerivationPolicy`로 한 층 더 좁힌다(`profile-derivation.ts:31-53`은 바탕과 판의 쌍만 안다). 이 문서의 테이블·API는 그 층을 위한 열이나 값을 미리 두지 않는다.

## 대안

- **한 테이블에 두 종류.** [데이터 모델](#데이터-모델)의 이유로 고르지 않았다.
- **상한은 설치 설정에 두고(`limits`) 프로필만 DB로.** 상한을 바꿀 때마다 재배포가 남는다. 오너가 없애려는 재배포가 바로 이것이라 고르지 않았다.
- **연결·자격 참조까지 전부 DB로.** 콘솔 쓰기 하나로 임의 endpoint와 API가 가진 다른 자격 증명 참조를 묶을 수 있다(`catalog.ts:814-823`가 그 값을 upstream 헤더에 싣는다). 고르지 않았다.
- **상한을 제자리에서 고치기.** 지문에 드는 실행 설정을 바꾸거나 쓰던 모델을 뺄 때마다 그 위의 판과 release가 거절된다(`catalog.ts:685-694`, `agent-service.ts:75-82`). 모델 추가나 `title_model` 변경처럼 핀에 들지 않는 변경만 무사하고(`catalog.ts:183-188`), 모델 제거는 그 모델을 쓰던 release·세션·판만 멈춘다. 오너 결정 2의 B안이다.
- **DB 허용을 `repositories.<id>.profiles` 배열로 되돌려 넣기.** revision과 저장소 binding이 상한마다 바뀐다. [저장소 허용](#저장소-허용) 참고.

## 오너 결정 (모두 오너 확인 대기, 기본값 적용)

1. 운영자 판별: **A 워크스페이스 owner(기본)** / B env로 지정 / C 별도 테이블. 어느 안이든 운영자는 모델·도구·권한 모드·저장소 쌍을 옛 YAML보다 넓힐 수 있다(연결·자격 증명·billing·bypass 스위치는 못 바꾼다).
2. 상한을 바꾸는 방식: **A 불변 버전 + 은퇴(기본)** / B 제자리 변경.
3. 저장소 허용: **A 콘솔에서 만든 상한은 행의 `repository_ids`로 DB에서, 운영자만 고친다. 가져온 id는 `repositories.yaml` 그대로(기본)** / B 모두 `repositories.yaml`(새 상한 계열마다 재배포).
4. 정리 단계 뒤 `profiles.yaml`: **A 빈 테이블일 때의 초기 시드(기본)** / B 읽지 않음.
