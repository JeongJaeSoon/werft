# 결정(설계): 승인된 번들의 stdio MCP 서버를 worker가 띄우고 원격 MCP relay 뒤에 둔다

- 상태: 설계. 이 문서가 머지된 뒤 [94S-875](https://linear.app/94soon/issue/94S-875)를 [10절](#10-구현-단위)의 단위로 나눠 진행한다. 이 PR은 코드를 바꾸지 않는다.
- 기준 커밋: `origin/main` `88440d0d8`. `파일:줄`은 이 커밋에서 직접 읽은 값이다. 새로 만든 모듈 이름은 제안이고, 이름이 아닌 경계와 순서가 결정이다.
- 선행 티켓은 아직 모두 열려 있다: [94S-869](https://linear.app/94soon/issue/94S-869)(분류·manifest), [94S-870](https://linear.app/94soon/issue/94S-870)(승인 화면), [94S-871](https://linear.app/94soon/issue/94S-871)(프로필 상한·관문 하나), [94S-872](https://linear.app/94soon/issue/94S-872)(hook 실행기), [94S-873](https://linear.app/94soon/issue/94S-873)(Claude 콜백), [94S-874](https://linear.app/94soon/issue/94S-874)(hook ledger). 아직 없는 코드를 이 문서가 인용할 때는 그 티켓의 완료 조건을 근거로 쓰고, 코드처럼 적지 않는다.
- 관련: [94S-780](https://linear.app/94soon/issue/94S-780)(원격 MCP relay, Done), [94S-919](https://linear.app/94soon/issue/94S-919)(호출자 상한 집행), [94S-1487](https://linear.app/94soon/issue/94S-1487)(도구 이름 deny 우선 판정, PR #1502).
- 원 결정: [action-broker.md](action-broker.md#대안)는 commit 도구를 "worker 안 stdio MCP 서버"로 두는 안을 골랐다가 접었다. 이유는 둘이었다(플랫폼 MCP 서버는 remote만 받는다, 세션 내내 사는 서버 프로세스가 턴 끝 capture의 자손 관측에 걸린다). 이 문서는 그 결론을 바꾸지 않는다. 같은 두 이유를 **턴 안에서만 사는 프로세스**로 푼다([2절](#2-프로세스-자리와-수명)).

## 요약

| 항목 | 결론 |
|---|---|
| 자리와 수명 | worker 프로세스가 서버를 새 프로세스 그룹으로 띄운다. 수명은 **턴**이다: 세션 시작에 한 번 띄워 목록을 캐시하고, 체크포인트(턴 끝·승인 대기) 때 **lease를 쥔 뒤** 끄고, 다음 턴 첫 도구 호출에 다시 띄운다 |
| 노출 | 원격 relay와 같은 `type: "sdk"` in-process relay. 상대만 HTTP에서 **worker가 든 stdio 연결**로 바뀐다. egress 프록시의 `/mcp/<name>` 길은 쓰지 않는다 |
| 판정 | 엔진에 보이는 도구 = 승인된 선언 도구 ∩ 상한. 컨트롤 플레인이 main에 있는 deny 우선 함수(`visibleMcpTools`) 하나로 해석해 세션 행에 상한으로 고정한다. **호출 시점에도** 같은 함수로 `tools/call`과 `tools/list`를 판정하므로(판정 전용 worker 경로, 캐시 없음, 닫힌 채 실패) 실행 중 deny 추가를 따라간다. 원격과의 동등성은 허용 집합과 호출 판정에 한한다(원격 목록은 즉시 줄지 않는다) 넓어지는 방향은 따르지 않는다([3절](#3-relay가-stdio-서버를-내보내는-방법과-판정-자리)) |
| identity | `{번들 digest, 서버 이름}`. 이름 공간은 하나이고 겹치면 release 활성화·세션 생성이 거부한다 |
| 클라이언트 능력 | relay의 upstream 클라이언트는 능력을 하나도 선언하지 않는다. sampling·roots·elicitation은 오류로 거절한다 |
| env·cwd | hook과 같은 실행기를 쓴다(94S-872). 서버만의 규칙을 더하지 않는다 |
| 실패 | `required` 서버가 시작·첫 `tools/list`에 실패하면 첫 입력 전에 `run.ready()`가 거절한다. 그 밖의 실패는 경고하고 계속한다 |

## 1. 범위와 현재 코드

지금 worker는 remote MCP 서버만 안다.

- 선언: `runtime_config.mcp_servers`의 항목마다 `mcpServersOf`가 `${egressCredentialUrl}/mcp/<name>`과 attempt 토큰을 단 `PlatformMcpServer`를 만든다(`apps/worker/src/composition.ts:390-403`). 번들은 `bundle.extensions`로 따로 간다(`:342-350`).
- 노출: Claude 어댑터가 서버마다 `remoteMcpRelay`를 만든다(`packages/adapters/runtimes/claude/src/contract.ts:157-175`). relay는 `type: "sdk"` 서버이고 StreamableHTTP 클라이언트로 프록시에 말하며, 고정된 도구만 `tools/list`에 싣고 그 밖의 `tools/call`은 거절한다(`packages/adapters/runtimes/claude/src/remote-mcp.ts:54-127`). 토큰은 엔진 argv·env에 가지 않는다.
- 프록시 쪽 판정: egress 토큰은 세션의 서버 **하나**에 묶이고(`packages/platform/src/workers/mcp-egress.ts:97-107`), 서버·자격·workspace를 본 뒤 `tools/call`의 도구 이름을 release 고정 목록과 대조한다(`:158-170`).
- 체크포인트: 턴 끝에 worker가 lease를 잡고(`apps/worker/src/worker-host.ts:2845-2850`) 엔진 자손과, 작업 폴더를 cwd로 가진 등록되지 않은 프로세스를 센다. 하나라도 남으면 `background_writer`로 거부한다(`apps/worker/src/engine-processes.ts:82-108`, `worker-host.ts:2851-2871`). 도구가 도는 중이면 `tool_in_flight`로 거부한다(`packages/adapters/runtimes/claude/src/turn-ledger.ts:258-264`).

이 일은 surface·action 모듈([surface-action-modules.md](surface-action-modules.md))의 일이 아니다. 에이전트의 바깥 작업이나 사람 쪽 채널이 아니라 worker 안 프로세스와 런타임 어댑터의 일이므로 새 코드는 `apps/worker`와 `packages/adapters/runtimes/claude`에 놓는다. 컨트롤 플레인 쪽 해석은 기존 `packages/platform/src/sessions/catalog.ts` 자리다.

## 2. 프로세스 자리와 수명

**결정.** worker 프로세스가 서버를 직접 띄운다. 수명은 턴이다.

1. 세션 시작(**첫 입력 전**. 준비는 `start()` 전에 시작하고 `run.ready()`가 끝을 기다린다, [7절](#7-실패와-ready-의미)): 선언된 서버를 모두 띄우고 MCP `initialize`와 `tools/list`(입력 스키마 포함)를 받아 **캐시**한다. `required` 서버가 여기서 실패하면 세션 시작이 실패한다([7절](#7-실패와-ready-의미)).
2. 턴 중: 도구 호출은 떠 있는 프로세스로 간다. 꺼져 있으면 첫 `tools/call`이 다시 띄운다(재연결 포함).
3. 체크포인트 직전, **lease를 먼저 잡고** 그 안에서 정리한다. 체크포인트를 잡는 곳은 둘이다: 턴 끝(`worker-host.ts:2845`)과 승인 대기(`:2684`, `:2709`). 승인 대기 캡처는 자손 검사도 서버 종료도 하지 않으므로 같은 `quiesce()`를 두 곳 모두에 넣는다.
   1. `leaseCheckpoint`가 거부하면(`tool_in_flight` 등) **아무것도 끄지 않는다.** lease가 있으면 엔진의 새 도구 호출은 `leasedAdmission`으로 거절되고(`turn-ledger.ts:144`), 실행 중인 도구가 있으면 lease 자체가 거절되므로, lease를 쥔 시점에는 서버에 가는 호출이 없다. 서버를 먼저 끄면 실행 중인 호출을 끊게 되므로 이 순서가 필요하다.
   2. lease를 쥔 뒤 `quiesce()`: 서버 새 시작·재연결을 막고, 진행 중인 시작을 회수하고, 서버 프로세스 그룹에 SIGTERM, 기한(기본 5초) 뒤 SIGKILL, 그룹이 비었음을 확인한다.
   2'. 서버를 끈 뒤 **자손 검사**(`engines.descendants()`)를 한다. 턴 끝은 이미 하는 검사이고, 승인 대기 경로에는 없다(`worker-host.ts:2851`은 턴 끝뿐이다). 승인 대기에서는 stdio 서버를 쓰는 세션일 때만 같은 검사를 더한다. 다른 세션의 승인 대기 동작은 바꾸지 않는다. 그룹을 벗어난 서버 자손의 쓰기가 승인 대기 캡처와 겹치지 않게 하기 위해서다.
   3. 확인하지 못하면 체크포인트를 잡지 않는다. 턴 끝은 기존 사유 `background_writer`로 거부하고 detail에 서버 이름을 적는다(새 사유를 `packages/contracts/src/worker-protocol/index.ts:722` 목록에 더하지 않는다). 승인 대기는 기존의 "건너뜀"(`lease === null` 경로와 같은 `return null`)으로 처리한다.
   4. 확인되면 캡처하고, lease를 놓은 뒤 `quiesce` 핸들을 푼다.
4. 막힌 동안 `tools/list`는 서버를 건드리지 않는다. 시작 때 받은 캐시를 돌려주는 것이 **항상의 규칙**이다(막힘 여부와 무관하게 `tools/list`는 살아 있는 서버로 전달하지 않는다). 그래서 "막힌 중 목록 요청이 서버를 깨운다"는 경쟁이 없다. `tools/call`이 `quiesced` 서버로 오면 오류로 끊지 않고 **핸들이 풀릴 때까지 기다린 뒤** 서버를 다시 띄워 호출한다. 턴 끝 lease는 새 도구 호출을 거절하므로 거의 오지 않지만, 승인 대기 캡처는 이미 승인 대기 중인 호출을 lease가 막지 못한다(`turn-ledger.ts:318`은 승인 대기 호출을 실행 중 검사에서 뺀다. `runtime.ts:206`은 답변 뒤 lease를 다시 보지 않고 allow를 돌려준다). 승인 답이 정리 도중에 와도 호출이 서버가 꺼지는 순간에 끊기지 않고 캡처 동안 서버가 되살아나지도 않게 하는 장벽이 이 대기다. 대기의 길이는 핸들이 풀리는 때, 곧 lease가 풀리는 때까지다. 승인 체크포인트의 lease는 캡처가 돌아온 뒤에도 정산이 끝날 때까지 유지되므로(`worker-host.ts:2743`) `APPROVAL_CHECKPOINT_MS`보다 길 수 있다. 호출은 자기 중단 신호(엔진 interrupt)로 대기에서 빠져나올 수 있고, 그 밖의 시한을 새로 만들지 않는다: 핸들을 일찍 풀면 캡처와 서버 쓰기가 겹친다. `closed`이면 `isError`로 거절한다. 캡처 뒤에 늦게 적용된 승인 답은 기존의 `answersThrough` 검사가 그 캡처를 무효로 다룬다(`worker-host.ts:2709` 근처).

**막힘의 소유권.** 서버 관리자는 상태가 셋이다: `open`, `quiesced(핸들)`, `closed`(영구). `quiesce()`는 핸들을 돌려주고 `핸들.release()`는 멱등이며 `quiesced`일 때만 `open`으로 돌린다. `closed`는 attempt 종료(abort·close·소유권 유실)가 만든 상태이고 어떤 `release()`도 되돌리지 못한다. **일반 턴 interrupt는 `closed`가 아니다.** interrupt는 턴만 멈추고 같은 run의 턴 루프가 계속되므로(`worker-host.ts:1999`, `:1100`) 턴 끝과 같은 `quiesce()`(되돌릴 수 있음)를 쓰고 다음 턴 첫 호출이 서버를 다시 띄운다. 이 규칙은 코드가 가진 경로에 맞춘다: 캡처 거절·예외로 즉시 lease를 놓는 경로, finalize가 불확실해 미결 요청까지 lease를 유지하는 경로, 기다리던 쪽이 포기한 뒤 늦게 lease를 돌려주는 경로(`worker-host.ts:1721`, `:1862`, `:2882`). lease를 얻지 못했으면 `quiesce()`를 부르지 않았으므로 풀 것도 없다. 늦은 `release()`가 정리 중이거나 끝난 attempt의 서버 입장을 다시 열지 못한다. 중첩 정리는 하나의 종료 Promise를 공유한다.

attempt가 끝날 때(abort·close·소유권 유실)는 같은 정리를 하고(`closed`), 종료 확인 전에는 체크포인트도 정상 release도 하지 않는다. 이 등록부와 release 조건은 94S-872가 hook용으로 만든다. 서버는 거기에 **같은 종류의 항목으로 오르는 소비자**이고, 등록부의 항목은 소유 종류(`hook` · `mcp:<서버>`)를 가진다. 턴 경계의 `quiesce()`는 `mcp` 종류만 끄고 hook은 건드리지 않는다. hook은 짧고 94S-874의 ledger 항목으로 따로 지켜진다.

종료 방식 두 가지를 구분한다. 턴 끝에 우리가 끈 서버는 다음 턴에 다시 띄울 수 있다. **스스로 죽은** 서버는 그 attempt 안에서 다시 띄우지 않는다(티켓). 호출은 `isError` 결과로 돌려주고 경고한다.

서버가 쓰는 작업 폴더 파일은 에이전트 Bash의 것과 같이 그 턴 체크포인트에 들어간다. lease 안에서 프로세스가 죽은 것을 확인한 뒤 capture하므로 겹치지 않는다. 그룹을 벗어난 자손은 기존 cwd 검사가 `background_writer`로 잡는다. cwd를 밖으로 옮기거나 조회를 막은 프로세스는 못 잡는 위험은 94S-874와 에이전트 Bash가 이미 수용한 것과 같다.

ledger 항목은 서버에 열지 않는다. 94S-874의 `hook:<id>` 항목은 짧은 호출이 체크포인트와 겹치지 않게 하려는 것이다. 서버는 lease 안에서 끄고 확인한 뒤 캡처하고(앞의 순서), 호출이 없다는 것은 lease의 도구 검사가 이미 보장하므로 ledger가 더할 것이 없다. 서버가 받는 도구 호출 자체는 엔진의 도구 호출이라서 기존 `toolStarting`·`toolSettled`가 이미 기록한다.

### 대안 (고르지 않음)

- **세션 내내 사는 프로세스.** 가장 단순하지만 [action-broker.md](action-broker.md#대안)가 접은 바로 그 이유로 모든 턴 끝 capture를 `background_writer`로 막는다. 거부.
- **도구 호출마다 띄우고 끄기.** capture와 겹칠 일이 없으나, MCP는 `initialize` 핸드셰이크와 서버 상태(열린 브라우저, DB 연결)를 전제하고 호출마다 시작 비용을 낸다. `tools/list` 캐시도 의미가 없어진다. 거부.
- **세션 시작 때만 띄우고 목록만 캐시한 뒤 끄기.** 첫 도구 호출이 항상 재시작이 되어 위의 이점이 없다. 시작 시 띄운 프로세스를 첫 턴까지 두는 쪽이 더 단순하다.
- **컨트롤 호스트나 별도 컨테이너에서 실행.** 번들 스크립트는 세션의 작업 폴더와 에이전트 Bash와 같은 env·네트워크에서 돌기로 사람이 결정했다(94S-870 문구). 공유 인프라에서 승인된 외부 코드를 돌리는 새 위협면을 만든다. 거부.
- **서버마다 ledger 항목.** 위에서 설명한 대로 얻는 것이 없다. 거부.

## 3. relay가 stdio 서버를 내보내는 방법과 판정 자리

**결정.** 엔진에는 지금처럼 `type: "sdk"` in-process 서버만 간다. relay의 upstream만 갈아 끼운다. egress 프록시의 `/mcp/<name>` 경로로 stdio 서버를 돌리지 않는다.

이유는 셋이다.

1. egress 토큰은 세션의 서버 하나에 묶이고 서버는 카탈로그의 `credential_ref`·workspace 허용으로 해석된다(`mcp-egress.ts:97-130`). stdio 서버는 자격이 없고 번들이 선언한다. 같은 판정 함수를 억지로 태우면 "서버가 하나뿐" 가정과 자격 receipt를 둘 다 깨야 한다.
2. 프록시는 HTTP 요청을 중계하는 자리인데 stdio 서버는 worker가 연 파이프다. 프록시를 거치려면 worker가 자기 안의 프로세스에 자기 HTTP 서버를 세워 프록시를 돌아오게 해야 한다. 같은 호스트에서 한 바퀴 도는 것이다.
3. worker는 stdio 서버에 줄 비밀이 없다. 프록시가 하는 일(자격 주입, 토큰을 argv에서 숨기기)이 필요 없다.

**인터페이스.** relay를 둘로 쪼갠다. 쪼개는 방향은 쓰는 쪽(relay)이 필요한 만큼만 정의한다.

```ts
// packages/adapters/runtimes/claude, relay가 소유한다. 작은 인터페이스 하나.
export interface McpUpstream {
  listTools(signal: AbortSignal): Promise<readonly Tool[]>;
  callTool(params: CallToolRequest["params"], opts: { signal: AbortSignal; timeoutMs: number }): Promise<CallToolResult>;
}
// 원격: StreamableHTTP 클라이언트로 구현(지금의 remote-mcp.ts 안쪽).
// stdio: worker가 구현해 주입한다. 어댑터는 프로세스를 모른다.
export function mcpRelay(server: { name: string; tools: readonly string[] }, upstream: McpUpstream): { type: "sdk"; name: string; instance: McpServer };
```

- 상속 없이 합성이다. `remoteMcpRelay`는 `mcpRelay(…, httpUpstream(…))`를 호출하는 얇은 함수로 남는다.
- stdio upstream은 **worker**(`apps/worker`)가 만든다. 프로세스 그룹, 등록부, 막는 상태는 worker의 자원이고, 어댑터가 가진 능력은 `McpUpstream`뿐이다. 어댑터 `contract.ts`는 `RuntimeStart.bundle.mcpServers`처럼 런타임 코어 타입을 통해 받는다. 런타임 코어에 더하는 것은 "upstream을 주입하는 서버 항목" 하나다(`url`·`token` 대신 `upstream`을 가진 변형).
- 목록 캐시는 stdio upstream을 만드는 worker 쪽 `CachedListing`이 맡는다. 시작 때 한 번 받은 입력 스키마 포함 목록을 항상 돌려주고, relay의 필터·호출 거절은 relay가 맡는다. 책임이 겹치지 않는다: relay는 "무엇이 보이고 불릴 수 있나", stdio upstream은 "프로세스가 언제 살아 있나"를 맡는다.

**불변식(리드 결정, 94S-1487).** deny-first는 전송 수단과 무관해야 한다. 원격은 호출마다 egress가 저장된 엔진 규칙의 `mcp__` deny까지 보고 판정한다(`packages/db/src/mcp-egress.ts:192-203` `withoutSavedMcpDenies`). stdio 서버 뒤에서 새 deny를 무시하면 "deny가 이긴다"가 전송 수단에 달리게 된다. 그래서 **모든 stdio `tools/call`과 `tools/list` 응답이 호출 시점에 같은 deny-first 판정을 거친다.** 세션에 고정한 목록은 판정의 **상한**(넓어지지 않음)이고, 호출 시점 판정은 그 안에서만 좁힌다.

**판정은 세 자리에 나뉜다.**

| 자리 | 하는 일 | 원격 | stdio |
|---|---|---|---|
| 컨트롤 플레인(세션 해석) | 선언 ∩ 상한을 계산해 세션 행에 고정 [94S-871, 94S-919] | 시작 스냅샷 | 같은 방식으로 고정(상한) |
| 컨트롤 플레인(호출 시점 판정) | release deny, 저장된 엔진 규칙 deny, 호출자 상한 [94S-919]을 **지금 값**으로 deny 우선 판정 | egress `decide`(`mcp-egress.ts`) | **새 worker 경로** `POST` 판정 요청. `decide`와 같은 판정 함수를 부른다 |
| worker relay | 고정된 목록 밖 `tools/list`·`tools/call` 거절, 판정 결과 집행 | 있음 | 있음 |

**stdio의 호출 시점 판정이 가는 길.** egress `/mcp/<name>` 경로는 쓰지 않는다(위 이유 1~3). 대신 worker가 attempt에 묶인 인증으로 컨트롤 플레인에 묻는 **판정 전용 경로**를 둔다. 공유할 것은 `decide` 안의 조각이 아니다. `decide`는 이미 계산된 `state.tools`에 `mcpToolPermitted`를 적용할 뿐이고, 현재 설정 교차는 DB의 `sessionEffectiveMcp`, 저장 deny의 조회·적용은 `withoutSavedMcpDenies`(`packages/db/src/mcp-egress.ts:92`, `:192`)에 있다. 그래서 둘을 구분한다: ① **deny 쪽 정책 입력을 읽는 공통 경로**(저장 deny와 release deny, 호출자 상한을 DB에서 읽음. egress와 stdio가 **함께** 쓴다)와 ② **순수 판정 함수**(`visibleMcpTools`). 현재 MCP **설정 행**을 교차하는 `sessionEffectiveMcp`는 원격 전용으로 남고 공유하지 않는다. U2b는 ①을 egress와 새 경로가 같이 부르도록 뽑는다. `effectiveMcp`는 시작 스냅샷을 받는 분기에서 에이전트의 **단일 서버 설정 행**을 입력으로 받고, 행이 없거나 서버가 다르면 빈 집합을 돌려준다(`mcp-settings.ts:60`. 스냅샷과 행이 모두 없으면 release 도구를 돌려준다, `:73-76`). 번들의 stdio 서버는 그 행에 없으므로 **`effectiveMcp`를 stdio에 쓰지 않는다.** stdio의 호출 시점 입력은 셋이다: 서버마다 세션에 고정한 상한(허용 이름 목록), 지금의 release deny와 저장된 엔진 규칙 deny(`mcpDeniedBy`, `packages/db/src/claim-engine-settings.ts`가 원격과 같은 읽기 경로), 호출자 상한(94S-919). 판정은 `visibleMcpTools(서버, 고정 상한, ...deny)`이고 설정 행이 없다는 것은 아무것도 뜻하지 않는다(행이 없다고 거절하지 않는다). 그래서 상한은 넓어질 수 없고 deny만 줄인다. 첫 시험: 서버 둘이 있는 세션이 **처음에는 둘 다 허용**되고, 한쪽에만 deny를 더하면 그쪽만 좁아진다.

**새 경로의 연결은 worker 프로토콜을 따른다.** `packages/core`의 응답 표(`schemas/responses.ts`)는 공개 클라이언트의 `OperationKey`용이고 기존 worker 경로는 거기에 없다. 새 경로를 거기에 올리지 않는다. 연결은 `packages/contracts`의 worker-protocol 스키마 → `apps/control-host/src/api/routes/worker.ts`의 `jsonWithSchema` → worker gateway client의 decoder다. 인증은 `gateway.authenticate` 뒤 `requireScope`(`packages/platform/src/workers/worker-gateway.ts:1630`)로 session·attempt·lease epoch·execution generation·auth revision을 대조하고, `requireScope`가 토큰이 DB보다 오래됐을 수 있다고 명시하므로 **현재 DB 소유권을 확인하는 fenced read**로 서버·고정 상한을 읽는다. bootstrap 토큰, 다른 attempt, 낡은 fence는 거절하는 시험을 둔다.

relay가 쓰는 인터페이스는 relay가 소유하고 작게 둔다.

```ts
// relay(어댑터)가 소유한다. 원격은 egress가 판정하므로 gate를 주지 않는다.
export interface McpToolGate {
  /** 지금 이 서버에서 호출해도 되는 도구(고정 상한 안에서). */
  visible(server: string, signal: AbortSignal): Promise<readonly string[]>;
  permits(server: string, tool: string, signal: AbortSignal): Promise<boolean>;
}
```

- `tools/list`: 캐시된 목록(입력 스키마 포함)을 `visible()`로 걸러 돌려준다. 스키마는 시작 때의 것이고 이름 집합만 지금 값이다.
- `tools/call`: 순서는 **`quiesce` 대기 → `permits()` → 서버 호출**이다. 대기 뒤에 판정을 받아야 승인 답으로 재개된 호출이 대기 중에 더해진 deny를 우회하지 못한다("캐시하지 않는다"의 한 가지 뜻). 판정이 거절이면 서버를 띄우지도 않고 `isError`로 돌려준다. 시험: 대기 중 deny를 더하면 대기가 풀린 뒤 호출이 거절된다(U3/U4).
- **시간과 중단.** gate를 기다리는 호출은 ledger에서 실행 중이므로 체크포인트 lease가 `tool_in_flight`로 거절한다. 그래서 gate 요청에는 자체 시한을 둔다(초기 10초, 시험에서 조정)과 호출자의 `AbortSignal`을 결합한다. worker gateway client의 `post()`는 요청 시한은 있으나 `AbortSignal`을 받지 않으므로 U2b/U3이 이를 더한다. 재시도는 하지 않는다(시한 초과는 닫힌 채 실패). 서버 호출의 30분 시한은 gate 이전의 대기를 덮지 않는다.
- **캐시하지 않는다.** 판정 결과에 시한을 두면 그 시한만큼 새 deny가 무시된다. 호출당 컨트롤 플레인 왕복 하나를 쓴다(도구 호출 지연 증가). 도구 호출은 이미 모델 한 번의 왕복 뒤에 있어 이 비용을 받아들인다.
- **닫힌 채 실패한다.** 컨트롤 플레인에 닿지 못하거나 판정이 오류면 `tools/call`은 `isError`(정책 판정 불가)로 거절한다. 허용으로 넘기지 않는다. `tools/list`의 판정 실패는 `CallToolResult`가 아니라 **JSON-RPC 오류**로 돌려준다(빈 목록으로 숨기면 모델이 도구가 없다고 믿는다).
- **원격과의 동등성은 허용 집합과 호출 판정에 한한다.** 원격의 `decide`는 `tools/list`를 허용하고 `remote-mcp.ts`는 고정 목록으로만 거르므로 원격 목록은 새 deny로 즉시 줄지 않는다. stdio는 목록도 호출 시점 판정으로 거른다. 동등성 시험은 같은 입력에서 **현재 허용 집합과 `tools/call` 판정**이 같음을 비교한다. 원격 목록의 즉시 축소는 이 문서가 바꾸지 않는다.
- 호출 시점 판정이 불가능한 배치는 이 불변식을 어기므로 고르지 않는다: 이 배치(worker 안 relay + 판정 전용 경로)가 불변식을 지키는 가장 단순한 길이다.
- 판정 함수는 넓히지 못한다. 반환은 항상 세션에 고정한 목록의 부분집합이다. 실행 중 정책이 넓어져도 이미 시작된 세션에는 닿지 않는다(원격과 같다).

프록시 재검사가 의미 있는 이유(자격이 worker 밖)는 stdio에 해당하지 않는다. 그래도 호출 시점 판정을 두는 이유는 자격 보호가 아니라 **deny-first 불변식**이다.

### 해석 함수

main에는 이미 deny 우선 함수가 있다: `visibleMcpTools(server, allow, ...denies)`와 `mcpToolPermitted`(`packages/platform/src/sessions/mcp-tool-decision.ts:13-60`, 94S-1487). 원격의 claim과 egress가 둘 다 이 함수에서 나온다. stdio도 새 함수를 만들지 않고 이것을 부른다.

- `server` = 번들 서버 이름. `allow` = 선언 도구를 `mcp__<이름>__<도구>`로 쓴 목록 ∩ 세션의 `tools` 상한(profile·release). `denies` = release deny, 스냅샷 `mcp_deny`, 저장된 엔진 규칙, 호출자 상한이 뺀 도구. 일치는 정확 일치이며 접두어 일치가 아니다(그 함수의 계약).
- 출력: 그 함수는 허용된 이름의 정렬된 배열만 돌려준다. 뺀 도구와 이유(`undeclared`·`over_limit`·`denied`)는 **U2 호출부가** 입력 목록과의 차이로 계산해 해석 결과에 남긴다.
- 선언 밖 도구(서버가 `tools/list`에 선언에 없는 도구를 돌려줄 때)는 빼고 `extension.mcp.tool_filtered`를 남긴다. 상한이나 deny로 빠진 **선언된** 도구는 해석 결과에 이유와 함께 남기고, worker 이벤트는 만들지 않는다. 정책의 결과는 런타임 사건이 아니다.
- 결과를 세션 행에 고정하고 claim·restore가 같은 값을 다시 쓴다. 체크포인트 지문에 들어가는 서버 binding은 `stdio:<digest>:<이름>:<고정 도구 해시>`로 한다. 번들 digest가 같아도 상한이 바뀐 세션은 지문이 다르다.
- **실행 중 정책 축소를 따라간다.** 원격은 `effectiveMcp`(`packages/platform/src/sessions/mcp-settings.ts:35-75`)가 시작 스냅샷과 지금의 설정 행을 교차해 설정이 줄면 이미 도는 세션도 바로 좁아진다. stdio는 그 설정 행이 아니라 deny 쪽 입력(release deny, 저장된 엔진 규칙, 호출자 상한)으로 같은 결과를 얻는다: 호출 시점 판정이 고정 상한에서 지금의 deny를 뺀다. 넓어지는 방향은 따르지 않는다(세션에 고정한 목록이 상한). 시험 두 개를 고정한다: (1) 세션 시작 뒤 저장된 엔진 규칙에 `mcp__` deny를 더하면 다음 `tools/call`이 거절되고 `tools/list`에서 빠진다, (2) 세션 시작 뒤 설정을 넓히거나 deny를 지워도 고정한 목록 밖으로 넓어지지 않는다.

### 대안 (고르지 않음)

- **egress `/mcp/<name>`으로 일원화.** 위의 이유 1~3. 이것이 이 안의 가장 큰 유혹(두 길이 하나로 합쳐 보임)이지만, 합치는 것은 길이 아니라 **해석 함수**라는 것이 결론이다.
- **엔진에 `type: "stdio"`로 전달.** 완료 조건 1이 금지한다. 엔진 트리에 선언이 생기고 sampling·roots·elicitation, 도구 목록을 플랫폼이 거르지 못한다.
- **worker가 stdio 서버를 localhost HTTP로 감싸 `type: "http"`로 전달.** 엔진 프로세스가 서버에 직접 닿아 필터가 없다. 거부.
- **worker에 별도 정책 엔진.** worker는 정책을 모른다. 규칙은 컨트롤 플레인에 두고 worker는 묻는다.
- **세션 시작에 고정한 목록만으로 집행(초안의 안).** 실행 중 새 deny를 무시해 deny-first가 전송 수단에 달린다. 리드 결정으로 거부했다.
- **판정 결과를 짧게 캐시.** 캐시 시한만큼 새 deny가 무시된다. 거부.
- **판정 실패 시 고정 목록으로 허용.** 컨트롤 플레인 장애가 deny를 풀게 된다. 거부(닫힌 채 실패).
- **egress `/mcp/<name>`을 판정에만 재사용.** 토큰이 서버 하나에 묶이고(`state.server`) 자격·regrant 검사가 섞여 있어, 판정 부분만 뽑은 공유 함수와 전용 경로가 더 작다.

## 4. 서버 identity와 이름 충돌

**결정.** 서버 identity는 `{번들 digest, 서버 이름}`. 엔진이 보는 도구 이름은 `mcp__<이름>__<도구>`이므로 이름 공간은 세션의 **모든 번들 stdio 서버와 catalog 원격 서버가 하나**다.

- 같은 이름이 둘 이상이면(번들끼리, 번들과 catalog 원격, 번들과 `platform` 서버) **release 활성화와 세션 생성이 거부**한다. 서버 이름을 번들 이름으로 덮어쓰거나 접두어를 붙이지 않는다.
- 이름 형식을 제한한다: `^[a-z0-9][a-z0-9-]{0,30}$`. 엔진이 `mcp__<서버>__<도구>`에서 서버 이름을 `__`로 나누므로 `__`는 안 된다. 94S-869의 완료 조건에는 이 검사가 없으므로 **U2가 소유**한다(release 활성화·세션 생성의 같은 검사 자리). 869가 manifest 단계에서 같은 정규식을 더 일찍 거절해도 U2의 검사는 남는다.
- 현재 코드는 이름을 객체 키로 쓴다(`contract.ts:162-174`의 `Object.fromEntries`). 겹치면 뒤의 항목이 앞의 relay를 **조용히 덮는다**. 이 검사는 그 덮어쓰기가 도달하기 전 한 곳(세션 해석)에서 해야 하고, 어댑터는 겹침을 만나면 던지는 단언 하나를 더 둔다.
- 같은 번들의 두 버전은 한 세션에 같이 오르지 않는다(세션이 번들마다 버전 하나를 고정한다, 94S-867).

### 대안 (고르지 않음)

- **번들 이름을 도구 이름 접두어로**(`mcp__<번들>.<서버>__…`). 번들 이름이 바뀌면 모델이 보는 도구 이름과 사용자의 `tools` 규칙이 같이 바뀌고, `__` 구분 규칙과도 맞물린다. 티켓도 거부를 골랐다.
- **뒤 선언이 이기게.** 번들 하나가 다른 번들이나 catalog의 서버를 가로채는 길이다. 거부.

## 5. 거절하는 클라이언트 능력, 그리고 시험 계약

**결정.** relay가 stdio 서버에게 보이는 MCP **클라이언트**는 능력을 하나도 선언하지 않는다(`capabilities: {}`). 서버가 `sampling/createMessage`·`roots/list`·`elicitation/create`를 보내도 SDK 클라이언트는 처리기가 없어 `MethodNotFound`로 답한다. 그래도 이 동작을 SDK 기본값에만 맡기지 않고, 세 요청에 **명시적으로 거절 오류를 돌려주는 처리기**를 두고 시험한다. SDK 버전이 올라 기본이 바뀌어도 시험이 잡는다.

- 서버가 보내는 알림(`tools/list_changed`, 진행 알림, 로그)은 엔진에 전달하지 않는다. 목록은 세션 시작에 고정한 캐시다.
- 거절은 worker 로그에 경고로 남기고 이벤트는 만들지 않는다([LATER](#later)).
- 엔진이 relay에 선언하는 능력(예: 엔진 쪽 sampling)도 서버로 전달하지 않는다. relay는 요청을 중계하지 않고 `tools/list`·`tools/call`만 처리한다(지금 `remote-mcp.ts`의 두 처리기가 전부다).

**시험 계약을 구현 전에 정의한다.** 책임별로 세 갈래로 나눈다.

1. **relay 계약**(fake upstream으로): 고정 밖 이름의 `tools/call` 거절, 고정 밖 도구가 `tools/list`에서 빠짐, 설명 기록. 정책은 relay에만 있다.
2. **upstream 계약**(원격과 stdio가 **같은 시험 파일**을 통과): `listTools`가 페이지를 끝까지 돌려줌, `callTool`이 시한·중단 신호를 존중함, 오류가 `isError` 결과 또는 던짐 중 하나로 일관됨.
3. **stdio 수명·전송 시험**(stdio만): 입력 스키마가 보존된 캐시 응답, 막힌 중 서버를 띄우지 않음, 서버발 `sampling/createMessage`·`roots/list`·elicitation 거절. `McpUpstream`은 U1에서 **원격 구현이 첫 구현자**로 생기고, 그 전에 원격 동작을 시험으로 고정한다. stdio 구현이 오기 전에 쪼개는 것은 인터페이스를 미리 정의하는 단계이고, 구현 없는 어댑터는 만들지 않는다([10절 U1](#10-구현-단위)).

## 6. env·cwd·샌드박스와 hook 공유

**결정.** hook(94S-872)과 같은 실행기로 띄운다. 서버를 위한 규칙을 따로 만들지 않는다.

- 새 프로세스 그룹. cwd는 세션 작업 디렉터리. env는 엔진에 넘기는 env에서 `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR`를 빼고 `CLAUDE_PLUGIN_ROOT`·`CLAUDE_PROJECT_DIR`를 더한 값. worker `process.env`와 fd 3은 주지 않는다. 이 노출은 사람이 수용한 위험이다(94S-872).
- 샌드박스 없음. 외부 서드파티 번들을 받을 때 다시 본다([LATER](#later)).
- `extensions.scripts`가 `hooks`인 프로필에서만 stdio MCP가 돈다(94S-871). 승인되지 않은 번들 버전이나 상한 밖 프로필은 release 활성화·세션 생성에서 거부한다.
- 스크립트가 든 세션은 `ptrace_scope ≥ 1`이 아니면 시작하지 않는다(94S-871). 서버도 같은 조건을 받는다.
- 서버만의 차이: 파이프 연결(stdin/stdout은 MCP, stderr는 비워서 막힘을 방지), 호출 시한은 relay의 30분(`remote-mcp.ts:12`) 그대로, 시작 시한은 15초(초기 값, [LATER](#later)).
- stderr는 마지막 64 KiB를 링 버퍼로 두고 비정상 종료 때 worker 로그(경고)에만 쓴다. 이벤트·transcript에는 넣지 않는다. env가 에이전트 Bash와 같으므로 값에 비밀이 섞일 수 있다.

**인터페이스 소유.** 실행기는 hook과 서버 둘이 쓰는 worker 안의 능력이다. 쓰는 쪽(`apps/worker`의 extension 프로세스 모듈)이 정의한다.

```ts
interface ProcessGroupHost {
  spawn(spec: { owner: "hook" | `mcp:${string}`; argv: readonly string[]; env: Env; cwd: string; stdio: "pipe" }): ManagedProcess; // 새 그룹
  terminate(owner: "hook" | "mcp" | "all", reason: string): Promise<void>; // SIGTERM → 기한 → SIGKILL → 그룹이 빈 것 확인
}
```

hook 쪽은 `spawn`을 짧은 호출에, 서버는 긴 수명에 쓴다. 94S-872가 이미 다른 모양으로 나온 뒤라면 그 모양이 이긴다. U3의 첫 일이 이 인터페이스에 맞추는 것이다.

stdio 전송은 SDK의 `StdioClientTransport`가 프로세스를 직접 띄운다. 이 전송이 프로세스 그룹과 등록부 소유를 우리에게 주는지는 이 PR에서 **확인하지 못했다**(worktree에 의존성이 설치돼 있지 않다). U3의 첫 시험으로 확인한다. 안 되면 SDK의 `Transport` 인터페이스를 직접 구현한다(`ReadBuffer`·`serializeMessage`로 줄 단위 JSON-RPC를 읽고 쓰는 약 40줄). 어느 쪽이든 `McpUpstream` 밖의 코드는 모른다.

### 대안 (고르지 않음)

- **서버용 읽기 전용 샌드박스.** 티켓이 "정하지 않는 것"으로 둔 일이다. 외부 번들 지원 때 본다.
- **서버를 hook과 다른 env로.** 에이전트 Bash와 같은 env라는 한 가지 위협 모델을 한 곳에 적어 두는 쪽이 승인 화면 문구(94S-870)와 어긋나지 않는다.

## 7. 실패와 ready() 의미

- `required` 서버(manifest 선언)는 세션 시작의 기동이나 첫 `tools/list`가 실패하면 **첫 입력 전에** `ready()`가 거절한다. 어댑터의 `start()`는 run을 동기적으로 만들고 `ready()`가 따로 준비를 기다리므로(`contract.ts:275`, `:381`), worker의 사전 준비가 실패해도 `ready()`가 저절로 거절되지는 않는다. 그래서 연결 경계를 정한다: worker가 `start()` 전에 서버 준비를 **시작**하고, 서버 항목의 `upstream.ready(): Promise<void>`(런타임 코어의 작은 인터페이스)를 run이 가진다. `ClaudeSdkRun.ready()`가 `required` 서버의 `upstream.ready()`를 엔진 초기화 결과보다 먼저 기다린다. 시험은 `run.ready()`가 **직접 거절**되고 입력이 하나도 엔진에 가지 않음을 고정한다.
- 선택 서버의 시작 실패, 시작 뒤 종료, 재기동 실패, 호출 오류는 경고하고 계속한다. 호출은 `isError` 결과로 돌려준다.
- 티켓은 `required` 서버가 **시작 뒤** 죽은 경우를 따로 적지 않는다. 이 문서는 시작 뒤 실패를 모두 "경고하고 계속"으로 읽는다. `required`의 의미는 세션 시작 게이트까지다([LATER](#later) 첫 항목).
- 스스로 죽은 서버는 attempt 안에서 다시 띄우지 않는다. 턴 끝에 우리가 끈 서버만 다음 턴에 다시 띄운다([2절](#2-프로세스-자리와-수명)).
- 종료를 확인하지 못하면 체크포인트와 정상 release를 하지 않는다(94S-872가 만든 release 조건에 서버가 오른다).

### 대안 (고르지 않음)

- **`required` 서버 실패 시 세션을 중간에 죽임.** 에이전트가 이미 한 일이 있는 세션을 서버 하나 때문에 버리는 것은 복구 비용이 크다. 시작 게이트가 필요한 계약이다.
- **자동 재시작.** 스스로 죽은 서버의 재시작은 같은 입력으로 같은 크래시를 반복시키고 호출 시한을 소모한다. 티켓도 금지한다.

## 8. 이벤트

`extension.mcp.started`·`extension.mcp.exited`·`extension.mcp.tool_filtered`. hook의 `extension.hook.ran`(94S-872)과 같은 게시 경로를 쓴다.

| 이벤트 | 담는 것 | 담지 않는 것 |
|---|---|---|
| `started` | 번들 digest, 서버 이름, `required`, 도구 수, 시작 시간, `restart` 여부 | 명령줄 인자, env |
| `exited` | 번들 digest, 서버 이름, 사유(`turn_end` · `crashed` · `start_failed` · `close` · `abort` · `ownership_lost`), exit code·signal, SIGKILL 여부 | stderr 본문 |
| `tool_filtered` | 번들 digest, 서버 이름, 뺀 도구 이름과 이유(`undeclared`) | 도구 설명·스키마 |

**경계와 내구성.** 턴 정산은 publisher를 flush하고 `hold()`로 `finalSourceSequence`를 고정한 뒤 캡처한다(`worker-host.ts:1638`, `apps/worker/src/event-publisher.ts:193`). `quiesce()`가 내는 `exited{turn_end}`는 그 뒤에 나오므로 **그 턴의 finalize 경계 안에 들지 않는다.** 게이트웨이는 종료된 턴에 새 이벤트를 거부하고(`worker-unit-of-work.ts:3060-3067`) 그 실패가 publisher를 멈출 수 있으므로, 이 이벤트는 끝난 턴의 id를 **전송 범위에 달지 않는다.** 전송 범위는 `turn_id: null`(attempt 범위)로 하고 원래 턴 id는 payload의 `ended_turn_id`에 둔다. 이는 hold가 풀릴 때 게시되는 텔레메트리이며, `extension.hook.ran`과 같은 경로의 같은 내구성(베스트 에포트)을 갖는다. 소비자는 턴의 최종 순번에 이것이 있다고 가정하지 않는다. 이벤트 시험은 "실제 게이트웨이를 통과해 게시된다"와 "payload에 `ended_turn_id`가 있다"를 고정한다. 경계 안에 넣으려면 `quiesce()`를 정산 앞으로 옮겨야 하는데, 그러면 lease 없이 서버를 끄게 되어 위 [2절](#2-프로세스-자리와-수명)의 순서가 깨지므로 하지 않는다.

## 9. 완료 조건 대응

| 94S-875 완료 조건 | 이 문서 | 단위 |
|---|---|---|
| 1. 서버를 hook과 같은 env·cwd로 띄우고 relay가 말한다. 엔진에 `stdio`가 가지 않는다 | [3](#3-relay가-stdio-서버를-내보내는-방법과-판정-자리), [6](#6-envcwd샌드박스와-hook-공유) | U1, U3 |
| 2. 엔진에 보이는 도구 = 선언 ∩ 상한, 세션 행에 고정 (호출 시점 deny-first는 리드 결정으로 더함) | [3절 해석 함수](#해석-함수), 호출 시점 판정 | U2, U2b |
| 3. identity `{digest, 이름}`, 이름 충돌 거부 | [4](#4-서버-identity와-이름-충돌) | U2 |
| 4. sampling·roots·elicitation 거부 | [5](#5-거절하는-클라이언트-능력-그리고-시험-계약) | U1, U3 |
| 5. 턴 끝 차단 → 종료 확인 → 체크포인트, 막힌 중 목록은 캐시 | [2](#2-프로세스-자리와-수명) | U4 |
| 6. attempt별 등록부, interrupt·abort·close·소유권 유실 정리 | [2](#2-프로세스-자리와-수명), [6](#6-envcwd샌드박스와-hook-공유) | U5 |
| 7. `required` 실패는 `ready()` 실패, 선택 서버는 경고 | [7](#7-실패와-ready-의미) | U3 |
| 8. `extension.mcp.*` 이벤트 | [8](#8-이벤트) | U2(`tool_filtered` 계약), U3(`started`·`exited`·`tool_filtered` 발행) |

## 10. 구현 단위

순서대로 한 PR씩. 각 단위는 앞 단위가 머지된 뒤 시작한다. 선행 티켓이 닫히기 전에 시작할 수 있는 단위는 U1뿐이다.

| 단위 | 내용 | 선행 | 완료 조건 |
|---|---|---|---|
| **U1** relay 분리 | `remote-mcp.ts`의 동작을 시험으로 먼저 고정(고정 밖 거절, 목록 필터, 설명 기록)하고 `McpUpstream` + `mcpRelay` + `CachedListing`으로 쪼갠다. 원격 동작은 바뀌지 않는다. 서버발 요청 거절 처리기와 계약 시험 파일을 둔다. relay가 소유하는 `McpToolGate`(선택 인자)와 fake gate 시험(거절은 서버를 부르지 않음, 목록이 gate로 걸러짐)도 여기서 정의한다 | 없음 | 4 (relay 쪽) |
| **U2** 해석·이름 | manifest의 stdio 선언을 읽어 `선언 ∩ 상한`을 `visibleMcpTools`(main에 있음)로 계산해 세션 행에 고정, 이름 정규식과 이름 공간 단일화 검사(release 활성화·세션 생성), claim이 선언·고정 목록을 싣는 계약, 지문 binding, 선언에서 요구 기능 `stdio_mcp`를 강제로 도출해 claim에 싣음. **호출자 상한 입력을 비워 둔 채 머지하지 않는다** | 94S-869(manifest 모양), 94S-871(관문), 94S-870(승인), 94S-919(호출자 상한 집행) | 2, 3, 8(계약) |
| **U2b** 호출 시점 판정 경로 | deny 쪽 정책 입력을 읽는 공통 경로(release deny·저장 deny·호출자 상한. 설정 행 교차는 원격 전용으로 남김)를 egress에서 뽑고(원격 동작 불변을 시험으로 먼저 고정), 그 경로와 `visibleMcpTools`를 부르는 판정 전용 worker 경로(`visible`·`permits`)를 더한다. 연결은 contracts worker-protocol 스키마, `routes/worker.ts`, gateway client decoder이며 `packages/core` 응답 표에는 올리지 않는다. gateway client `post()`에 `AbortSignal`을 더한다. 계약 시험: 서버 둘 중 한쪽 deny만 그쪽을 좁힘, 같은 입력에서 egress와 이 경로의 허용 집합·호출 판정이 같음, 시작 뒤 더한 저장 deny가 다음 판정에 반영됨, 설정을 넓혀도 상한을 넘지 않음, 판정 불가는 거절(`tools/list`는 JSON-RPC 오류), bootstrap 토큰·다른 attempt·낡은 fence 거절 | U2, 94S-919(호출자 상한 교차) | 2 |
| **U3** worker stdio upstream | `McpUpstream`의 stdio 구현, `McpToolGate`의 worker 구현(U2b 경로 호출, 캐시 없음, 닫힌 채 실패, 순서는 `quiesce` 대기 → `permits` → 호출, 대기 중 deny 시험), 프로세스 그룹 실행기(94S-872)에 서버 항목(`mcp:<이름>` 종류)으로 오르기, 능력 없는 클라이언트, 세션 시작 준비(띄움·`initialize`·`tools/list` 캐시), `upstream.ready()`와 `run.ready()` 연결, `required` 게이트, `started`·`exited`·`tool_filtered` 발행. spawn 전에 worker의 활성 기능 상수 `stdio_mcp`를 검사하고 상수는 아직 꺼져 있다 | U1, U2, U2b, 94S-872 | 1, 4, 7, 8 |
| **U4** 체크포인트 정리 | 턴 끝과 승인 대기 캡처에 "lease → `quiesce()`(막음·회수·SIGTERM/SIGKILL·확인) → 캡처 → lease 해제 → 핸들 해제"를 넣는다. 막힘 소유권 상태(`open`/`quiesced`/`closed`). 다음 턴 첫 `tools/call`에서 다시 띄움. 확인 실패는 턴 끝 `background_writer`, 승인 대기는 건너뜀 | U3, 94S-873(Claude 콜백이 닿는 같은 구간), 94S-874(같은 `worker-host.ts` 구간이라 충돌을 피하려는 순서이며 논리 선행은 아니다) | 5 |
| **U5** 비정상 경로, 켬 | abort·close·소유권 유실에서 같은 정리(`closed`). 일반 턴 interrupt는 `closed`가 아니라 되돌릴 수 있는 `quiesce()`로 처리하고 다음 턴이 서버를 다시 띄운다([2절](#2-프로세스-자리와-수명)), 종료 확인 전에는 체크포인트·정상 release 금지, 스스로 죽은 서버의 재기동 금지. **마지막에 `stdio_mcp` 기능 상수를 켜고 worker가 알린다** | U3, U4, 94S-872 | 6 |

**중간 상태의 안전.** U3~U4 동안 서버를 띄우는 길은 두 겹으로 닫혀 있다. 지금의 기능 요구 계산(`packages/runtime-core/src/features.ts:16`)은 번들 선언을 읽지 않고, worker의 기능 검사도 `run.ready()` 뒤라서(`worker-host.ts:874`) manifest의 표기나 시작 후 거절만으로는 부족하다.
1. **U2가 요구 기능을 선언에서 강제로 도출한다.** 번들에 stdio MCP 선언이 있으면 claim의 요구 기능에 `stdio_mcp`가 반드시 들어간다(manifest의 선택적 표기에 맡기지 않는다). 그 기능이 없는 worker는 claim 단계에서 세션을 받지 못한다.
2. **U3의 supervisor가 spawn 전에 로컬 검사를 한다.** worker 자신의 활성 기능 상수에 `stdio_mcp`가 없으면 프로세스를 띄우기 전에 실패한다. 이 상수를 켜는 것은 U5다.
따라서 수명 관리가 없는 서버가 운영에서 도는 상태는 없다. U3·U4의 시험은 상수를 시험에서만 켠다.

U3과 U4는 한 PR로 합치지 않는다. U3은 세션 시작에서 끝나고 U4는 체크포인트 구간만 건드려 시험 계층이 다르다. 합치면 한 PR이 두 가지 위험을 함께 진다.

각 단위의 인터페이스와 계약 시험은 그 단위 PR의 **첫 커밋**에 둔다. 구현이 없는 어댑터나 "지원하지 않음"을 던지는 빈 구현은 만들지 않는다: `McpUpstream`은 U1에서 원격 구현과 함께 생기고, stdio 구현은 U3에서 생긴다.

## 대안 요약 (결정 단위)

| 결정 | 고른 것 | 접은 것 |
|---|---|---|
| 수명 | 턴 | 세션 내내, 호출마다, 시작만, 별도 컨테이너 |
| 노출 | 같은 relay, worker 주입 upstream | egress `/mcp/<name>`, 엔진 `stdio`, localhost HTTP 감싸기 |
| 판정 | 컨트롤 플레인이 하나의 함수로 상한을 고정하고, 호출 시점에도 같은 함수로 판정(전용 worker 경로, 캐시 없음, 닫힌 채 실패) | worker 쪽 정책 엔진, 고정 목록만 집행, 판정 캐시, egress 경로 재사용 |
| 이름 | 충돌 거부 | 번들 접두어, 뒤가 이김 |
| 능력 | 선언 없음 + 명시 거절 | SDK 기본에만 의존 |
| env | hook과 같은 실행기 | 서버 전용 env·샌드박스 |

## LATER

- **`required` 서버의 시작 뒤 실패를 세션 실패로 올릴지.** 지금은 경고하고 계속한다. 다시 볼 조건: 필수 서버가 죽은 세션이 쓸모없이 다음 입력을 계속 받는 사례가 운영에서 나올 때.
- **호출 시점 판정의 비용과 가용성.** 지금은 호출마다 컨트롤 플레인 왕복 하나를 쓰고 닿지 못하면 닫힌 채 실패한다([3절](#3-relay가-stdio-서버를-내보내는-방법과-판정-자리)). 다시 볼 조건: 판정 왕복이 도구 호출 지연의 눈에 띄는 몫이 되거나, 컨트롤 플레인 장애로 stdio 호출이 거절된 사례가 운영에서 나올 때. 그때도 시한 있는 캐시는 새 deny를 늦추므로 불변식과 맞바꿀지 따로 결정한다.
- **서버발 요청 거절의 이벤트.** 지금은 worker 로그 경고다. 다시 볼 조건: 관리자가 "왜 서버가 동작하지 않나"를 승인 화면이나 이벤트에서 찾아야 할 때.
- **시작 시한(15초)·종료 기한(5초)의 설정.** 다시 볼 조건: 정상 서버가 기한 안에 못 뜨거나 못 끝나 거부가 반복될 때.
- **서버 상태를 턴을 넘어 유지.** 티켓이 "정하지 않는 것"으로 둔다. 다시 볼 조건: 턴마다 재시작 비용이 사용자 지연으로 측정될 때. 그때는 체크포인트와의 충돌(자손 관측)을 먼저 풀어야 한다.
- **stdio 서버용 샌드박스, 등록 때 격리 `tools/list`.** 티켓의 "정하지 않는 것"과 같다. 다시 볼 조건: 외부 서드파티 번들을 받는 결정이 날 때.
- **SDK `StdioClientTransport` 사용 가능 여부.** U3의 첫 시험에서 확인하며 결과를 PR에 적는다.

## Codex 반론

**1회차**(초안). Codex가 적대적 검토를 했다(`codex exec`, 읽기 전용). 11건: Act-on 9, Consider 1, Noted 1. 아래는 각 건이 어떻게 정리됐는지다.

| # | 지적 | 처리 |
|---|---|---|
| 1 | 승인 대기 캡처(`worker-host.ts:2684`, `:2709`)는 서버를 끄지도 자손을 보지도 않아 서버 쓰기와 겹친다 | **수용.** 코드를 확인했다. `quiesce()`를 턴 끝과 승인 대기 두 곳에 넣는다([2절](#2-프로세스-자리와-수명)). 승인 대기에서 확인에 실패하면 체크포인트를 건너뛴다 |
| 2 | lease 전에 막으면 새 호출을 못 막고, 실행 중인 호출을 SIGTERM으로 끊을 수 있다 | **수용, 순서를 뒤집었다.** lease를 먼저 쥐면 엔진의 새 도구 호출이 거절되고 실행 중인 도구가 있으면 lease가 거절된다. 그 뒤에 끄면 끊을 호출이 없다. 티켓의 "차단"은 서버 시작·재연결 차단이고 이 순서와 맞는다. `tools/list`는 항상 캐시라 막힌 중 경쟁이 없다 |
| 3 | 막힘 해제의 소유권, lease 미획득·늦은 완료·중첩 정리 | **수용.** `open`/`quiesced`/`closed` 세 상태와 멱등 `release()`, `closed`는 되돌릴 수 없음, 정리 Promise 공유([2절](#2-프로세스-자리와-수명)) |
| 4 | `exited{turn_end}`가 finalize 경계보다 늦다 | **수용하되 경계 안에 넣지 않는다.** (3회차에서 종료된 턴 id를 거부하는 게이트웨이 규칙이 더 나와 전송 범위를 attempt로 바꿨다.) 이벤트를 텔레메트리로 정하고 귀속·내구성 계약을 적었다. 정산 앞으로 옮기면 lease 없이 끄게 되어 2번 결정이 깨지므로 거절한다([8절](#8-이벤트)) |
| 5 | U3만 활성화되면 수명 관리 없는 서버가 돈다. `terminateAll`이 hook까지 닫는다 | **수용.** `requires.features: stdio_mcp`를 U2가 더하고 worker가 알리는 것은 U5다([10절](#10-구현-단위)). 실행기의 종료는 소유 종류별로 하고 턴 경계는 `mcp`만 끈다([6절](#6-envcwd샌드박스와-hook-공유)) |
| 6 | `required` 실패가 `ready()`에 이어진다는 단정, 약한 시험 | **수용.** `upstream.ready()`를 run이 가지고 `run.ready()`가 직접 거절하는 경계를 정했고 시험도 그것으로 고쳤다([7절](#7-실패와-ready-의미)) |
| 7 | 94S-1487이 이미 머지됐다. `visibleMcpTools`가 있다 | **수용.** 확인했다(`mcp-tool-decision.ts:13`). 새 함수를 만들지 않고 그것을 부른다. 기준 커밋과 PR 번호 문장을 고쳤다([3절](#해석-함수)) |
| 8 | 원격은 `effectiveMcp`로 실행 중 정책 축소를 따른다. 같은 함수 호출 시험으로는 이 의미가 보존되지 않는다 | **수용. 초안은 차이를 받아들였으나 리드가 뒤집었다**(4회차 전 리드 결정): stdio도 호출 시점에 같은 deny-first 판정을 받아 실행 중 축소를 따른다([3절](#3-relay가-stdio-서버를-내보내는-방법과-판정-자리), U2b) |
| 9 | 이름 정규식은 869의 완료 조건에 없다. 919가 없을 때 호출자 상한을 비운 채 머지하는 것은 보장을 어긴다 | **수용.** 이름 검사는 U2가 소유한다. U2는 919를 하드 선행으로 두고 상한을 비운 채 머지하지 않는다([10절](#10-구현-단위)) |
| 10 | `McpUpstream` 공통 시험의 책임이 인터페이스와 안 맞는다 | **수용.** relay 계약, upstream 계약, stdio 수명·전송 시험 셋으로 나눴다([5절](#5-거절하는-클라이언트-능력-그리고-시험-계약)). 캐시는 worker 쪽 stdio upstream 소유다 |
| 11 | 인용한 코드 사실 확인(덮어쓰기, 30분 시한, `EACCES`, `background_writer`) | 변경 없음 |

**2회차**(수정본에 대한 재검토). 6건: Act-on 4, Consider 1, Noted 1. 1회차 수정 가운데 lease 먼저 순서와 `quiesce()`의 위치는 유지됐고, 그 위에서 새 틈 넷이 나왔다.

| # | 지적 | 처리 |
|---|---|---|
| 1 | 승인 대기에서는 lease가 이미 승인 대기 중인 호출을 막지 못하고 답변 뒤 재검사도 없다 | **수용.** 코드를 확인했다(`turn-ledger.ts:318`, `runtime.ts:206`). `quiesced` 서버로 온 호출을 오류로 끊지 않고 핸들이 풀릴 때까지 기다리는 장벽으로 바꿨다. `closed`만 오류다([2절](#2-프로세스-자리와-수명)) |
| 2 | 승인 대기 경로에는 탈출 자손 검사가 없다 | **수용.** stdio 서버를 쓰는 세션의 승인 대기에만 종료 뒤 `descendants()` 검사를 더한다. 다른 세션의 동작은 바꾸지 않는다 |
| 3 | `stdio_mcp` 미광고만으로는 막히지 않는다(`features.ts:16`, `worker-host.ts:874`) | **수용.** U2가 선언에서 요구 기능을 강제로 도출하고 U3 supervisor가 spawn 전에 로컬 검사를 한다. 상수는 U5가 켠다([10절](#10-구현-단위)) |
| 4 | interrupt를 영구 `closed`로 둬서 다음 턴이 망가진다 | **수용.** 일반 턴 interrupt는 턴 끝과 같은 되돌릴 수 있는 정리로 옮겼다. `closed`는 abort·close·소유권 유실뿐이다 |
| 5 | 판정 함수의 출력을 과장했다(허용 이름 배열만 돌려준다) | **수용.** 제외 사유는 U2 호출부가 입력과의 차이로 계산한다고 책임을 적었다 |
| 6 | 구현 검증은 후속이다 | 변경 없음. 이 PR은 설계이고 검증은 단위 PR마다 한다 |

**3회차**(PR #1521 diff 기준 독립 리뷰). Act-on 2, Consider 2, Noted 2. 완료 조건 8개가 모두 절에 대응하고 링크·앵커 40개가 해석됨을 확인했다.

| # | 지적 | 처리 |
|---|---|---|
| 1 | 종료 이벤트를 끝난 턴 id로 게시하면 게이트웨이가 거부한다(`worker-unit-of-work.ts:3060-3067`) | **수용.** 전송 범위는 `turn_id: null`, 원래 턴은 payload `ended_turn_id`. 시험은 실제 게이트웨이를 통과하게 한다([8절](#8-이벤트)) |
| 2 | U5가 interrupt를 다시 `closed`로 묶어 2회차 #4와 충돌한다 | **수용.** U5 행에서 interrupt를 뺐다 |
| 3 | 서버 준비를 "엔진 시작 전"과 "첫 입력 전"으로 둘 다 적었다 | **수용.** "첫 입력 전"으로 통일: 준비는 `start()` 전에 시작하고 `run.ready()`가 기다린다 |
| 4 | 승인 대기 호출의 대기가 `APPROVAL_CHECKPOINT_MS`로 제한된다는 설명이 틀렸다(`worker-host.ts:2743`) | **수용.** 대기는 lease 해제까지이며 호출 자신의 중단 신호로만 빠져나온다. 핸들을 일찍 풀면 캡처와 서버 쓰기가 겹치므로 별도 시한을 만들지 않는다 |

Act-on 2건과 Consider 2건을 모두 반영했다. 수정한 head에서 링크·앵커를 다시 확인했다.

**4회차**(`1637310ef..7bee77c6f`, 리드의 호출 시점 deny-first 결정을 담은 변경). Act-on 3, Consider 3, Noted 1. 8개 완료 조건의 대응은 유지됨을 확인했다.

| # | 지적 | 처리 |
|---|---|---|
| 1 | 공유할 조각이 `decide`가 아니다. 설정 교차는 DB `sessionEffectiveMcp`, 저장 deny는 `withoutSavedMcpDenies`에 있고 `effectiveMcp`는 서버 하나를 가정한다 | **수용.** 정책 입력을 읽는 공통 경로와 순수 판정 함수를 구분했다. 서버 둘 시험을 U2b의 첫 시험으로 둔다([3절](#3-relay가-stdio-서버를-내보내는-방법과-판정-자리)). 5회차에서 "서버별 `start`로 `effectiveMcp`를 반복 호출"이 틀렸음이 드러나 정정했다(아래) |
| 2 | `permits → … → quiesce 대기 → 재기동` 순서면 대기 중 더한 deny를 우회한다 | **수용.** 순서를 `quiesce 대기 → permits → 서버 호출`로 정했고 대기 중 deny 시험을 U3/U4에 둔다 |
| 3 | `packages/core` 응답 표는 공개 `OperationKey`용이고 worker 경로는 거기 없다 | **수용.** 코드로 확인했다(`responses.ts`에 worker 항목 없음). contracts worker-protocol → `routes/worker.ts` → gateway client decoder로 고쳤다. 앞서 적은 "core 응답 표에 올린다"는 잘못이었다 |
| 4 | attempt 인증만으로 소유권 fencing이 완성되지 않는다 | **수용.** `requireScope` + 현재 DB 소유권을 확인하는 fenced read, 거절 시험(bootstrap 토큰·다른 attempt·낡은 fence)을 U2b에 더했다 |
| 5 | gate의 시한과 중단 계약이 없다. `post()`는 `AbortSignal`을 받지 않는다 | **수용.** 자체 시한(초기 10초)과 호출자 `AbortSignal` 결합, 재시도 없음. `post()`에 `AbortSignal`을 더하는 일은 U2b/U3 |
| 6 | 원격은 목록이 새 deny로 즉시 줄지 않는다. `tools/list` 판정 실패는 `isError`가 아니다 | **수용.** 동등성을 허용 집합·호출 판정으로 좁혔다. `tools/list` 실패는 JSON-RPC 오류 |
| 7 | 완료 조건 대응 유지, 새 보장의 시험을 수용 기준에 연결하라 | 시험은 U2b·U3 행에 적었다 |

Act-on 3건과 Consider 3건을 모두 반영했다.

**5회차**(`7bee77c6f..066b02bb3`, 4회차 반영분만). 6개 항목 가운데 5개는 해소로 확인됐고(대기 뒤 판정 순서, worker 프로토콜 연결, `requireScope`와 DB 소유권, gate 시한·중단, 동등성 범위), 1개는 미해결, 새 지적은 Act-on 1·Consider 1·Noted 1이었다.

| # | 지적 | 처리 |
|---|---|---|
| 1 | 서버별 `start`로 `effectiveMcp`를 부른다는 매핑이 틀렸다. `effectiveMcp`는 에이전트의 단일 서버 설정 행을 받고 행이 없거나 서버가 다르면 빈 집합이다(`mcp-settings.ts:60`, `packages/db/src/mcp-settings.ts:12`). A만 있는 행이면 B는 deny 전부터 전부 거절된다 | **수용.** 코드로 확인했다. stdio는 `effectiveMcp`를 쓰지 않고 `visibleMcpTools(서버, 고정 상한, ...deny)`로 판정한다. 입력은 고정 상한, 지금의 release·저장 규칙 deny(`mcpDeniedBy`), 호출자 상한이다. 설정 행의 부재는 거절 사유가 아니다. 첫 시험을 "처음에는 둘 다 허용"으로 고쳤다([3절](#3-relay가-stdio-서버를-내보내는-방법과-판정-자리)) |
| 2 | 요약 15행이 목록도 원격과 똑같이 줄어든다고 남아 있다 | **수용.** 요약을 허용 집합·호출 판정으로 한정했다 |
| 3 | 참조 경로·라인·링크 오류 없음(`:97`은 호출 위치이고 선언은 `:92`) | 변경 없음 |

5회차의 수정은 위 1·2번 하나뿐이고 결정의 방향을 바꾸지 않았다.

**6회차**(`066b02bb3..4a53f5f79`, 5회차 반영분만). 앞선 정정은 코드와 일치하고 링크·앵커 42개와 경로에 오류가 없음을 확인했다. 새 지적은 Act-on 1, Consider 1, Noted 1.

| # | 지적 | 처리 |
|---|---|---|
| 1 | 공통 입력 경로의 설명이 "현재 설정 행"을 읽는다고 남아 있어 "stdio 입력에 설정 행이 없다"와 충돌한다 | **수용.** 공유 대상을 deny 쪽(release·저장 deny, 호출자 상한)으로 한정하고 설정 행 교차(`sessionEffectiveMcp`)는 원격 전용으로 분리했다(3절, U2b) |
| 2 | `effectiveMcp` 설명에 조건이 필요하다(스냅샷과 행이 모두 없으면 release 도구) | **수용.** "시작 스냅샷을 받는 분기에서"로 한정하고 `:73-76`을 적었다 |
| 3 | 나머지 정정은 코드와 일치 | 변경 없음 |

6회차의 수정도 문장 정합이다. 이 변경은 reviewer가 한 번 더 읽는다(7회차).
