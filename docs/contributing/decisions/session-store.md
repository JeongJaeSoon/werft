# 결정: transcript 저장은 Agent SDK `SessionStore`로 한다

후속(2026-11-11): 실행 프로필은 통째로 지웠다(migration `0266_remove_profiles`, 기존 데이터는 이전하지 않고 지움). 이 문서의 프로필·상한·롤아웃 언급은 그때의 기록이다. 지금은 에이전트 release가 provider 연결과 카드 모델로 실행 spec(런타임·도구·권한 모드)을 고정하고, 묻기·막기 규칙은 워크스페이스와 에이전트의 실행 규칙(`workspace_engine_settings`, `agent_engine_settings`)이 정한다.

## 무엇을 골랐나

세션 transcript의 저장과 복구는 고정한 Agent SDK(`0.3.270`)의 `SessionStore` 하나로 한다. 제품 구현은 `ClaudeSessionStore`(`packages/adapters/runtimes/claude/src/session-store.ts`)다.

다만 SDK mirror의 최신 상태를 곧바로 checkpoint로 보지 않는다. object store에 기록된 immutable part 목록과 각 part의 SHA-256을 **exact revision**으로 고정한다. 이 revision을 workspace git SHA, `cwd`, SDK·Claude Code 버전, 비밀값을 뺀 config profile fingerprint와 함께 하나의 immutable manifest로 묶은 뒤에야 복구 정본으로 승격한다.

### publish 순서

두 번호를 구분한다. **execution generation**은 실행(claim) 하나에 하나다. worker는 SDK를 시작하기 전에 claim이 준 generation으로 store를 열고, 그 실행의 transcript는 그 generation의 prefix에만 쓴다. **checkpoint revision**은 세션의 checkpoint pointer가 가리키는 번호이고, 한 실행 안에서 checkpoint를 commit할 때마다 하나씩 오른다.

아래가 모두 성립하기 전에는 새 checkpoint revision을 commit하지 않는다.

1. 진행 중인 tool 호출과 등록된 background writer가 안전 지점에 이른다. checkpoint가 끝날 때까지 새 writer는 시작하지 못한다.
2. 그 turn의 terminal `result` 앞에서 mirror flush가 끝났고, 그 실행에 `mirror_error`도 실패한 채 남은 append도 없다.
3. workspace를 commit해 exact git SHA를 얻는다.
4. root와 모든 subagent transcript의 exact part key·SHA-256 revision을 capture한다.
5. git SHA, transcript revision, `cwd`, 버전, config fingerprint를 immutable manifest에 쓴다.
6. pointer를 다음 revision(현재 revision + 1)으로 올린다. 세션 행의 lease epoch, execution generation, auth revision이 이 실행의 것과 같을 때만 올라간다.

1~5에서 실패하거나 6의 조건이 맞지 않으면 pointer는 이전 revision에 그대로 있다. branch HEAD, 최신 mirror object, 미완료 manifest를 서로 섞어 resume하지 않는다.

### 실패 계약

| 상황 | 관찰한 SDK 동작 | 제품 계약 |
|---|---|---|
| 같은 UUID 재전달 | timeout·retry로 같은 entry가 여러 part에 남을 수 있다 | body가 같으면 한 번만 복원하고, 다르면 손상으로 거절한다 |
| append reject | 세 번 시도한 뒤 `mirror_error`를 내고, agent `result`는 성공일 수 있다 | 그 turn의 checkpoint를 승격하지 않는다 |
| append timeout | 늦게 도착한 원 요청과 retry가 모두 반영될 수 있다 | UUID로 dedup하고, `mirror_error`가 있었으면 승격하지 않는다 |
| process kill | flush 중이면 result도 checkpoint도 없다 | pointer는 마지막으로 commit된 revision에 남는다. 다음 실행은 새 generation으로 그 revision이 고정한 part만 채택하므로, 죽은 프로세스가 그 뒤에 남긴 write는 읽지 않는다 |
| manifest·object 누락, hash 불일치 | exact revision 검증이 실패한다 | SDK를 시작하기 전에 claim을 실패시킨다. 조용히 새 session을 만들지 않는다 |
| store에 없는 session resume | SDK는 로컬 transcript로 fallback하고, 그것도 없으면 `No conversation found`로 끝난다. 모델 호출은 없다 | 제품은 revision을 먼저 검증·materialize하므로 이 fallback에 기대지 않는다 |
| 같은 `/workspace`의 두 session | 같은 project key를 공유한다 | `sessionId` namespace로 완전히 분리한다 |

## 왜

- 공식 `SessionStore`는 root transcript와 `subpath` 기반 subagent transcript를 같은 SDK resume 경로로 복원한다. 새 config 디렉터리를 준 새 프로세스에서도 store에서 첫 turn 문맥을 읽어 이어 간다.
- SDK는 terminal `result`를 iterator에 넘기기 전에 남은 mirror batch를 flush한다. 그래서 같은 turn에서 먼저 도착한 `system/mirror_error`를 보고 checkpoint publish를 막을 수 있다.
- mirror는 best-effort다. append가 실패해도 agent 실행은 성공할 수 있고, timeout된 write는 늦게 반영될 수 있다. 그래서 store가 UUID로 dedup하고, payload가 다른 같은 UUID는 손상으로 다룬다.
- store의 최신 suffix는 계속 늘어날 수 있다. checkpoint revision은 capture 시점의 exact part와 hash만 담으므로, 그 뒤에 붙은 suffix는 revision을 읽을 때 보이지 않는다. lease를 잃은 worker가 계속 쓰더라도 다음 generation은 그 write를 읽지 않는다.
- store resume용 임시 config는 SDK가 종료할 때 지운다. host 설정을 복사해 쓰지 않고, worker가 자기 설정의 config 디렉터리(`apps/worker/src/composition.ts`의 `claudeConfigDir`)를 SDK에 준다.

공식 계약과 비교 기준:

- [Persist sessions to external storage](https://code.claude.com/docs/en/agent-sdk/session-storage)
- [Work with sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
- [TypeScript conformance suite](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/examples/session-stores/shared/conformance.ts)
- [공식 S3 예제](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/examples/session-stores/s3/src/S3SessionStore.ts)

## 대안

- **filesystem snapshot을 병행 write backend로 유지.** transcript와 workspace git SHA를 같은 시점으로 묶을 수 없어 고르지 않았다. 이 방식의 metadata에는 git SHA가 없으므로 둘이 일관된다고 검증할 방법이 없다.
- **SDK mirror의 최신 상태를 그대로 checkpoint로 사용.** mirror는 checkpoint 뒤에도 계속 쓰이고, 실패한 batch가 빠진 채 남을 수 있다. "mirror가 최신이다"와 "이 checkpoint로 resume할 수 있다"를 같은 말로 만들 수 없어 고르지 않았다.
- **SDK의 로컬 transcript fallback에 기대는 resume.** store에 transcript가 없을 때 SDK는 컨테이너 로컬 디스크를 읽는다. 그 디스크는 커밋된 대화가 아니므로, 제품은 revision을 검증한 뒤에만 SDK를 시작한다.

## 지금 이 계약을 지키는 테스트

| 계약 | 테스트 |
|---|---|
| UUID dedup, 같은 UUID의 다른 body 거절, key 순서 무관 | `packages/adapters/runtimes/claude/src/session-store.test.ts` |
| exact revision: 이후 suffix 무시, part 목록·bytes 변조와 누락 거절 | `packages/adapters/runtimes/claude/src/session-store.test.ts` |
| generation 분리, checkpoint만큼만 이전 generation 채택(죽거나 lease를 잃은 실행이 checkpoint 뒤에 쓴 write는 다음 실행이 읽지 않음) | `packages/adapters/runtimes/claude/src/session-store.test.ts`, `runtime.integration.test.ts`의 `resumes a new generation from the pinned checkpoint, never from an old worker's later writes` |
| 실제 SDK에서 mirror 내용과 로컬 transcript 일치, pinned checkpoint에서 resume | `packages/adapters/runtimes/claude/src/runtime.integration.test.ts` (`transcript mirror against the actual SDK`) |
| 실제 SDK에서 `mirror_error`가 `result`보다 먼저 오고 checkpoint를 막음 | 같은 파일, `a mirror that keeps rejecting is reported before the turn's result, which still succeeds` |
| 실제 SDK에서 timeout 뒤 늦게 반영된 write를 한 번만 복원 | 같은 파일, `restores once the entries of appends that timed out but still landed` |
| 실제 SDK가 끝나지 않은 mirror append 뒤에 `result`를 붙잡아 두고, append가 끝나면 내보냄 | 같은 파일, `holds the turn's result until a pending mirror append lands` |
| append가 끝나지 않은 채 프로세스가 죽은 실행은 `result`가 없고 checkpoint를 준비하지 못함 | 같은 파일, `a run killed while its mirror append hangs leaves no result to checkpoint` |
| 실제 SDK에서 store에 없는 session resume이 모델 호출 없이 실패 | 같은 파일, `a resume the store holds nothing for fails without reaching the model` |
| tool·background writer가 끝나기 전 checkpoint 거절 | 같은 파일, `checkpoint quiescence against the actual SDK` |
| `mirror_error`가 있으면 checkpoint 거절 | `packages/adapters/runtimes/claude/src/turn-ledger.test.ts` |
| manifest를 쓰기 전 실패, mirror 실패 시 manifest 보류, 기존 manifest 덮어쓰기 거절 | `apps/worker/src/session-checkpoints.test.ts` |
| S3 요청 시간 상한, body가 멈춘 응답 | `packages/storage/src/s3-request-bounds.test.ts`, `packages/storage/src/body-stall.test.ts` |
