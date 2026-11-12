# 결정(설계): 세션 사용량을 호출 시작 때부터 적는 장부

- 상태: 설계(2026-11-12). 1단계(이 문서의 "2c-1")만 구현한다. 2단계("2c-2")는 실제 OpenAI 키 검증([94S-1522](https://linear.app/94soon/issue/94S-1522)) 뒤에 따로 결정한다.
- 결정한 사람: 이 설계는 작업자 판단이고 Codex 설계 리뷰를 거쳤다. 오너 지시는 순서에 대한 것이다(2026-11-12: "리팩토링 끝나면 추천 순서대로 대응해줘", "전체적으로 추천대로 하면될듯?").
- 티켓: [94S-1542](https://linear.app/94soon/issue/94S-1542)(2c-1), [94S-1543](https://linear.app/94soon/issue/94S-1543)(2c-2).

## 문제

세션에는 비용 상한(`SESSION_COST_LIMIT_USD`)과 토큰 상한(`SESSION_TOKEN_LIMIT`)이 있다. 지금 이 상한은 **끝난 호출만** 본다.

호출 하나는 이렇게 흐른다.

1. worker의 엔진이 egress proxy의 provider 경로를 부른다.
2. proxy가 control-host에 권한을 묻는다(`POST /authorize`). control-host는 세션에 저장된 비용과 토큰을 상한과 비교한다. 넘었으면 `403 BUDGET_EXCEEDED`다.
3. proxy가 upstream을 부르고 응답을 worker에 흘려 준다. 열린 호출은 30초마다 권한을 다시 묻는다(regrant).
4. 응답이 끝나면 proxy가 사용량을 보고한다(`POST /usage`, 호출마다 만든 `exchange_id`). control-host가 단가를 매겨 `provider_usage`에 한 줄을 넣고 세션 비용에 더한다.

2번의 비교는 4번이 끝난 호출의 합만 안다. 그래서 다음 호출은 상한을 넘을 수 있다.

| 경우 | 왜 넘는가 |
|---|---|
| 긴 응답 하나 | 응답이 끝나야 비용이 적힌다. 그 호출 자체는 막을 수 없다 |
| 병렬 호출 | 둘 다 2번을 통과한 뒤에 각각 4번을 한다 |
| 보고가 가는 중의 다음 호출 | 4번이 끝나기 전에 다음 2번이 온다 |
| 보고 유실 | proxy는 1·5·15초 간격으로 네 번 보낸다(시도마다 시한 10초, 합쳐 약 61초). 다 실패하면 그 호출은 세지 않는다. proxy는 그 세션을 프로세스 메모리의 목록에 넣고 이후 호출을 거절한다. 이 목록은 proxy가 재시작하면 사라지고, 다른 proxy replica는 모른다 |

마지막 경우는 초과액에 한도가 없다. 운영 문서는 지금 이것을 "소프트 한도"라고 적는다.

### 2026-11-12 main에서 확인한 것

- 권한 확인: `packages/platform/src/workers/worker-gateway.ts`의 `authorizeEgress`와 `authorizedTitleEgress`가 `budgetExceeded`(저장된 `costUsd`·`providerTokens`와 상한의 비교)를 부른다.
- 보고: `apps/egress-proxy/src/credential.ts`의 `reportUsage`. `exchange_id`는 upstream 응답을 받은 **뒤**에 만든다. 재시도 간격은 `DEFAULT_USAGE_REPORT_BACKOFF_MS = [1_000, 5_000, 15_000]`, 시도 시한은 `DEFAULT_AUTHORIZE_TIMEOUT_MS = 10_000`이다.
- 유실 처리: 같은 파일의 `unreportedSessions`(프로세스 안의 `Set`).
- 기록: `packages/db/src/worker-unit-of-work.ts`의 `recordProviderUsageAtomic`. 세션과 attempt 행을 잠그고, `provider_usage`에 `exchange_id`를 기본 키로 한 줄을 넣는다. 같은 `exchange_id`의 같은 내용은 한 번만 센다.
- 끊긴 응답: proxy는 응답이 사용량을 말하기 전에 끊기면 요청에서 계산한 높은 값으로 보고한다(`apps/egress-proxy/src/usage.ts`의 `requestEstimate`: 입력은 요청 바이트 수, 출력은 `max_tokens`, Responses 요청에 상한이 없으면 32,768). 그 보고에는 `estimated: true`가 붙는다.
- 열린 호출의 시한: 호출 하나는 길어야 35분이다(`DEFAULT_EXCHANGE_TIMEOUT_MS`). regrant 간격은 30초, 권한을 못 물은 채 버티는 시간은 90초다.
- proxy는 권한을 묻기 전에 요청 본문을 다 받는다(본문 검사가 권한 확인보다 앞에 있다).
- `/authorize`와 `/usage`의 요청 schema는 `.strict()`다. 모르는 칸이 있는 요청은 400이다. proxy의 응답 해석(`parseGrant`)은 아는 칸만 읽는다.

## 무엇을 골랐나

호출을 **시작할 때** 장부에 한 줄을 적고, 보고가 오면 그 줄을 지운다. 줄에는 요청에서 계산한 상한 금액(예약)을 적는다. 은행의 가승인과 같은 방식이다.

- 진행 중인 호출과 보고가 가는 중인 호출은 예약으로 장부에 있다.
- 보고가 유실된 호출은 지워지지 않은 줄로 남는다. proxy가 재시작해도, replica가 여럿이어도 DB에 있다.
- 끝내 보고가 오지 않은 호출은 0이 아니라 예약 금액으로 확정할 수 있다.

구현은 둘로 나눈다.

- **2c-1 (이 문서로 구현한다).** 장부와 그것을 채우는 통로를 만든다. 상한 판정과 기록되는 비용은 **바꾸지 않는다**. 줄이 쌓이고 지워지는 것, 남는 줄의 수를 본다.
- **2c-2 (나중에 결정한다).** 판정에 예약을 더하고, 남은 줄을 예약 금액으로 확정한다. 사용자에게 보이는 비용과 상한 동작이 바뀌므로 오너 결정이 필요하다.

### 1. 장부: `provider_exchanges`

새 표 하나다. 줄이 있다는 것은 "권한을 받았고 아직 보고되지 않은 호출"이라는 뜻이다.

| 열 | 뜻 |
|---|---|
| `exchange_id` (기본 키) | proxy가 호출마다 만든 UUID. 권한 요청, regrant, 보고가 같은 값을 쓴다 |
| `session_id`, `attempt_id` | 누구의 호출인가. `provider_usage`와 같은 참조다 |
| `reserve` | 요청에서 계산한 사용량 추정(모델, 입력·출력 토큰, speed, geo). `/usage`의 `usage`와 같은 모양이다 |
| `opened_at` | 처음 권한을 받은 시각 |
| `lease_expires_at` | 이 시각까지 갱신이나 보고가 없으면 "끝내 보고되지 않은 호출"로 본다 |

상태는 따로 두지 않는다. 줄의 유무와 `lease_expires_at`으로 충분하다.

```
(없음) ──권한 부여──▶ 열림 ──보고──▶ (지움, provider_usage에 한 줄)
                      │  ▲
                      │  └─ regrant: lease 연장
                      └─ lease 만료 ──▶ 미보고 (줄이 남는다)
                                          └─ 늦은 보고 ──▶ (지움, provider_usage에 한 줄)
```

- **열림.** control-host가 권한을 **부여할 때** 줄을 넣는다. 거절한 요청은 줄을 만들지 않는다.
- **연장.** regrant는 같은 `exchange_id`로 온다. 줄의 `lease_expires_at`만 늘린다. `reserve`와 `opened_at`은 처음 값을 지킨다.
- **보고.** `recordProviderUsageAtomic`이 `provider_usage`에 줄을 넣는 같은 transaction에서 장부의 줄을 지운다. 보고가 다시 와도(같은 `exchange_id`) 지울 줄이 없을 뿐이다.
- **미보고.** lease가 지난 줄이다. 늦은 보고는 언제나 받아들인다. 실제 사용량이 추정보다 정확하기 때문이다.
- 장부에 줄이 없는 보고(옛 proxy, 또는 2c-1 이전에 시작한 호출)는 지금처럼 기록한다.

lease는 180초다. 근거: 마지막 regrant 뒤 응답이 끝나기까지 최대 30초, 그 뒤 보고가 재시도 끝에 도착하기까지 최대 약 61초, 합쳐 약 91초다. 그 두 배를 잡았다. proxy가 죽으면 그 호출의 줄은 마지막 갱신에서 180초 뒤에 미보고가 된다.

### 2. 권한 요청에 싣는 칸

`POST /authorize`의 provider 요청에 선택 칸 둘을 더한다.

| 칸 | 뜻 |
|---|---|
| `exchange_id` | 이 호출의 UUID |
| `reserve` | 요청 본문에서 계산한 추정. proxy의 `requestEstimate`가 만드는 값이다 |

둘은 함께 오거나 함께 없다. 없으면 지금과 똑같이 동작한다.

`count_tokens`는 과금되지 않고 proxy도 계측하지 않는다. 그 요청에는 칸을 싣지 않고 장부에도 적지 않는다.

제목 생성 호출은 control-host가 proxy의 같은 provider 경로로 보내고, 세션의 비용으로 센다(`authorizedTitleEgress`). 부여되는 권한에 `session_id`와 `attempt_id`가 있으므로 같은 장부에 적는다.

성과 판정(judgment) 호출은 세션이 내지 않는다. 장부에 적지 않는다.

### 3. proxy

- `exchange_id`를 권한을 묻기 **전에** 만든다. 권한 요청, regrant, 보고가 그 값을 쓴다.
- 권한 요청에 `exchange_id`와 `reserve`를 싣는다. 단, control-host가 받을 수 있다고 알린 뒤에만 싣는다(아래 "버전 조합").
- 보고는 그대로다.

### 4. 남은 줄을 보는 일 (2c-1)

reconciler가 주기적으로 lease가 지난 줄을 센다. 2c-1에서는 세고 알리기만 한다.

- 새로 미보고가 된 줄마다 경고 로그 한 줄: `Provider exchange went unreported`(`session_id`, `attempt_id`, `exchange_id`, `opened_at`). 값은 식별자와 시각뿐이다.
- 미보고가 된 지 7일이 넘은 줄은 지운다. 2c-1에서 이 줄은 판정에 쓰이지 않으므로 쌓아 둘 이유가 없다.

## Codex 반론 7항목에 대한 답

94S-663에서 Codex가 낸 반론이다. 각각 이 설계가 어떻게 다루는지 적는다.

**1. exchange 식별과 상태 전이.** `exchange_id`를 proxy가 권한 요청 전에 만들어, 한 호출의 권한 요청·regrant·보고를 하나로 묶는다. 상태는 줄의 유무와 lease로만 표현한다(위 그림). 전이마다 누가 일으키는지가 하나다: 열림과 연장은 권한 부여, 지움은 보고, 미보고는 시간.

**2. 스트리밍 lease와 약 61초의 보고 대기.** 스트림은 35분까지 간다. lease를 35분으로 잡으면 죽은 호출이 35분 동안 예약을 쥔다. 대신 이미 있는 30초 regrant로 짧은 lease(180초)를 갱신한다. 새 heartbeat는 만들지 않는다. 보고 대기 61초는 lease 안에 들어온다.

**3. 중단된 exchange에 일괄 0 사용량 금지.** 0으로 확정하는 길이 없다. 끊긴 응답은 지금도 proxy가 요청 추정으로 보고한다. 보고조차 못 한 호출은 줄이 남고, 2c-2에서 그 줄의 `reserve`로 확정한다. `reserve`는 요청의 `max_tokens`에서 왔으므로 그 호출이 낼 수 있는 최댓값이다.

**4. 세션 직렬화의 원자성과 경합.** 2c-1의 줄 넣기는 한 문장짜리 upsert라 잠금이 필요 없고 판정에 쓰이지 않는다. 2c-2의 판정은 "확정된 비용 + 열린 예약의 합 < 상한"을 줄 넣기와 한 transaction에서 봐야 한다. 그때는 세션 행을 `FOR UPDATE`로 잠근다. 잠그는 순서는 모든 fenced write와 같은 세션 → attempt다(`recordProviderUsageAtomic`이 이미 이 순서다). 그러면 한 세션의 병렬 권한 요청이 차례로 처리되어 둘 다 통과하는 경합이 없다. 비용은 provider 권한 요청마다 세션 행 잠금 하나다.

**5. 혼합 버전 롤아웃 순서.** 아래 "버전 조합"이다. 순서는 migration → 새 칸을 받는 API → 새 proxy → 옛 proxy가 다 빠짐 → 집행 플래그(2c-2)다. 운영자가 순서를 틀려도 깨지지 않게, proxy는 API가 알린 뒤에만 새 칸을 보낸다.

**6. 제목 호출과 `count_tokens`의 범위.** 제목 호출은 세션 비용이므로 장부에 적는다. `count_tokens`는 과금되지 않으므로 적지 않는다. judgment는 세션 밖이므로 적지 않는다(위 2절).

**7. 보존, 인덱스, 증가량.** 장부에는 열린 호출과 미보고 호출만 있다. 보고된 호출의 줄은 지워지고 기록은 `provider_usage`에 남는다. 열린 줄의 수는 proxy의 동시 호출 상한(프로세스마다 256, client마다 32)을 넘지 않는다. 미보고 줄은 2c-1에서 7일 뒤 지운다. 인덱스는 기본 키와 `lease_expires_at`(만료 훑기)이고, 2c-2에서 `session_id`(예약 합)를 더한다. 줄에는 식별자, 숫자, 시각, 모델 이름만 있다. 프롬프트나 응답 내용은 없다.

## 버전 조합

`/authorize`의 schema가 `.strict()`라서, 옛 control-host는 새 칸이 든 요청을 400으로 거절한다. proxy가 무조건 새 칸을 보내면 "proxy를 먼저 올린" 설치의 모든 provider 호출이 깨진다. 그래서 proxy는 control-host가 받을 수 있다고 알린 뒤에만 보낸다.

- 새 control-host는 권한 응답에 `usage_ledger: 1`을 싣는다. 옛 proxy는 모르는 칸을 무시한다(`parseGrant`).
- 새 proxy는 그 값을 본 뒤의 provider 권한 요청부터 새 칸을 싣는다. 권한 응답에 그 값이 없으면(옛 replica가 답함) 다시 싣지 않는다. 판단은 가장 최근 응답을 따른다.

| proxy | control-host | 동작 |
|---|---|---|
| 옛 | 옛 | 지금과 같다 |
| 옛 | 새 | 새 칸이 오지 않는다. 장부에 줄이 생기지 않는다. 지금과 같다 |
| 새 | 옛 | 응답에 `usage_ledger`가 없어 새 칸을 보내지 않는다. 지금과 같다 |
| 새 | 새 | proxy가 처음 받은 응답 뒤부터 장부에 적는다 |

새 proxy의 첫 호출 하나는 장부에 적히지 않을 수 있다(아직 응답을 받기 전이다). worker는 모델을 부르기 전에 저장소 clone 등으로 권한을 먼저 묻는 것이 보통이지만 보장은 아니다. 2c-1에서는 판정에 쓰이지 않으므로 문제가 없다. 2c-2는 이 틈을 닫아야 한다(아래).

되돌리기: 새 control-host를 옛 것으로 내리면 응답에서 `usage_ledger`가 사라지고 proxy가 새 칸을 멈춘다. 표는 남고 쓰이지 않는다. migration은 표를 더하기만 하므로 옛 빌드가 그 위에서 그대로 돈다.

## 2c-2가 이 장부로 하는 일 (지금은 하지 않는다)

2c-2는 오너 결정 뒤에 따로 설계를 확정한다. 이 장부가 그것을 감당하는지만 적는다.

- **판정에 예약을 더한다.** 확정된 비용 + 열린 예약 합 + 미보고 예약 합이 상한 이상이면 거절한다. 병렬 호출과 보고가 가는 중인 호출이 닫힌다.
- **미보고를 예약으로 확정한다.** lease가 지난 줄을 `reserve`로 `provider_usage`에 넣는다(`estimated`). 보고 유실, proxy 재시작, 복수 replica가 닫힌다. proxy의 `unreportedSessions`는 필요 없어진다.
- **보내지 못한 호출을 풀어 준다.** 권한을 받았지만 upstream에 요청을 쓰지 못한 호출(연결 실패 등)은 과금되지 않았다. 예약으로 확정하면 없는 비용을 물린다. proxy가 "보내지 않았다"를 알리는 통로가 필요하다.
- **첫 호출의 틈.** 집행을 켠 설치에서는 새 칸이 없는 provider 권한 요청을 어떻게 다룰지 정해야 한다(옛 proxy가 다 빠진 뒤에 켜고, 그 뒤에는 거절하는 방식 등).
- **남는 한계.** 긴 응답 하나는 그 호출의 예약(`max_tokens`)까지만 간다. 상한이 없는 Responses 요청의 32,768은 추정이지 최댓값이 아니다. 그 경우는 계속 소프트하다.

## 대안

| 대안 | 버린 이유 |
|---|---|
| 판정 때 세션 행을 잠그고, 호출이 끝날 때까지 다음 호출을 막는다 | 엔진은 병렬로 호출한다. 한 번에 하나만 허용하면 턴이 느려지고, 35분짜리 스트림이 세션을 막는다 |
| `provider_usage`에 "열림" 상태의 줄을 미리 넣는다 | 그 표의 사용량 열은 모두 NOT NULL이고, insert trigger가 합계 표에 더한다. 열린 줄을 넣으면 합계가 추정으로 부풀고, 확정 때 trigger를 거슬러 고쳐야 한다 |
| proxy가 유실 목록을 디스크나 공유 저장소에 둔다 | proxy에 상태가 생긴다. 지금 proxy는 무상태이고 replica를 늘릴 수 있다. 장부는 이미 DB가 있는 control-host 쪽이 맞다 |
| lease 없이, 열린 줄을 35분 뒤에 미보고로 본다 | 죽은 호출이 35분 동안 예약을 쥔다. regrant가 이미 있어서 짧은 lease가 공짜다 |
| 운영자 설정으로 새 칸을 켠다(`EGRESS_…` 변수) | 운영자에게 새 설정과 순서를 요구한다. 응답으로 알리면 설정이 필요 없다 |

## 구현 단위 (2c-1)

1. DB: migration `0272`로 `provider_exchanges`를 더한다. 포트에 "열기·연장"과 "만료 훑기"를 더하고, `recordProviderUsageAtomic`이 보고 때 줄을 지운다. PostgreSQL 통합 시험.
2. control-host: `/authorize`의 provider 요청에 선택 칸 둘, 권한 부여 때 줄 넣기, 응답의 `usage_ledger`. 옛 요청(칸 없음)이 그대로인지 시험.
3. proxy: `exchange_id`를 앞으로 옮기고, 알림을 받은 뒤 새 칸을 싣는다. 옛 응답(알림 없음)에서는 싣지 않는지 시험.
4. reconciler: 미보고 줄의 로그와 7일 뒤 정리.
5. 문서: 운영 문서의 "소프트 한도" 서술은 2c-1에서 바뀌지 않는다(동작이 같다). 미보고 로그 한 줄을 더한다.

두 엔진 conformance는 계속 통과해야 한다. 특히 Codex의 `BUDGET_EXCEEDED` 시나리오가 그대로여야 한다.

## 운영자에게 바뀌는 것 (2c-1)

- 새 설정, 새 권한은 없다.
- DB에 표 하나가 생긴다. 크기는 동시 호출 수 수준이다.
- reconciler 로그에 `Provider exchange went unreported`가 생길 수 있다. 지금의 proxy 로그 `Provider usage went unreported`와 같은 사건을 control-host 쪽에서 본 것이고, proxy가 죽어서 로그를 남기지 못한 경우도 잡는다.
- 기록되는 비용과 상한 동작은 바뀌지 않는다.

## 확인하지 못한 것

- provider 권한 요청마다 upsert 하나가 늘 때의 부하는 재지 않았다. 열린 호출마다 30초에 한 번이다.
- 실제 OpenAI Responses API에서 `reserve`(특히 상한 없는 요청의 32,768)가 실제 사용량의 위에 있는지는 확인하지 못했다. 94S-1522가 먼저다.
- 새 proxy의 첫 호출이 실제로 얼마나 자주 장부를 비껴가는지는 재지 않았다.
