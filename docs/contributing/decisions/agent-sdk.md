# 결정: Agent SDK 버전은 정확히 고정하고 호환 harness로 확인한 뒤 올린다

## 무엇을 골랐나

worker는 `@anthropic-ai/claude-agent-sdk@0.3.319`와 그 SDK에 번들된 Claude Code `2.1.319`를 로컬 process로 실행한다. Anthropic 전송은 직접 연결하거나, 운영자가 승인한 LiteLLM의 `/v1/messages` 경로를 거친다. 제품은 LiteLLM을 함께 배포하지 않는다. 호환 harness가 확인하는 LiteLLM은 `1.100.1`이고, 로컬 모델 확인용 compose(`infra/compose.local-model.yml`)의 LiteLLM 이미지는 이와 별도로 digest로 고정한다.

버전은 이렇게 고정한다.

| 무엇 | 어디에 | 방식 |
|---|---|---|
| 제품이 쓰는 SDK | `packages/adapters/runtimes/claude/package.json` | 범위 없는 정확한 버전(`0.3.319`). 루트 `bun.lock`이 함께 고정한다 |
| 번들 Claude Code | SDK 패키지 | SDK 버전을 따라간다. 따로 설치하지 않는다 |
| 호환 harness가 쓰는 SDK | `scripts/agent-sdk-compat/package.json` | 제품과 같은 정확한 버전. harness 자신의 `bun.lock`이 고정한다 |
| harness가 확인하는 LiteLLM | CI `agent-sdk-compat` job | `uv tool install 'litellm[proxy]==1.100.1'` |

harness는 workspace 밖의 독립 설치 단위라서 제품 버전을 올려도 자동으로 따라오지 않는다. 그래서 두 `package.json`이 함께 선언한 의존성(SDK와 MCP tool schema에 쓰는 `zod`)의 버전이 같은지 `tests/agent-sdk-compat/sdk-version.test.ts`가 검사한다. 이 테스트는 루트 `bun test`에 들어 있어 PR마다 돈다.

## 운영 제약

이 버전에서 관찰한 SDK 동작 때문에 제품은 다음 두 가지를 지킨다.

1. **외부 승인 대기는 SDK `defer`나 중단 후 `resume`에 맡기지 않는다.** worker process와 `canUseTool` callback을 살려 둔 채 기다리고, 기한이 지나면 deny한 뒤 새 turn으로 다시 시도한다. `PreToolUse`의 `permissionDecision: "defer"`는 turn을 `success/tool_deferred`로 닫고, 이후 `resume`은 미뤄 둔 tool을 다시 부르지 않는다. 승인 대기 중에 process를 끝내면(`abort()`·`SIGTERM`·`SIGKILL`) resume은 대기 중이던 tool과 callback을 재생하지 않는다.
2. **`HOME`, `CLAUDE_CONFIG_DIR`, `settingSources` 격리만으로는 상위 `CLAUDE.md` 탐색을 막지 못한다.** `settingSources: ["project"]`여도 workspace 상위 디렉터리의 `CLAUDE.md`를 읽는다. 그래서 tenant workspace의 상위 경로 전체를 tenant 전용 clean mount로 제공한다. tenant마다 `HOME`과 `CLAUDE_CONFIG_DIR`을 따로 두고, host의 설정·memory·credential 파일은 tenant config tree에 복사하지 않는다.

`result.success`만으로 승인 대기 turn이 끝났다고 판단하지 않는다. `requestId`, `toolUseID`, worker 생존 상태를 함께 본다.

## 왜

- 제품 테스트(`runtime.integration.test.ts`)는 실제 SDK와 local fake Messages API로 제품 adapter를 확인한다. 하지만 실제 LiteLLM proxy를 거친 왕복, project 확장(`CLAUDE.md`·Skill·plugin) 로딩, 권한 mode 우선순위, 상위 `CLAUDE.md` 탐색은 제품 테스트가 보지 않는다. 버전을 올릴 때 이것들이 바뀌었는지는 실제 SDK process로만 알 수 있다.
- SDK와 LiteLLM의 동작은 버전마다 바뀔 수 있다. 범위 버전(`^`)이면 lockfile을 다시 만들 때 확인하지 않은 버전이 들어온다.

## 대안

- **harness 없이 제품 테스트만으로 버전을 올린다.** LiteLLM 왕복과 project 확장 계약을 확인할 곳이 없어져서 고르지 않았다.
- **harness를 루트 `tests/` 아래 workspace 테스트로 둔다.** 루트 `bun test tests packages apps`가 LiteLLM 없이 그 파일들을 돌리게 되고, 제품과 같은 lockfile을 쓰게 되어 SDK 버전을 따로 시험할 수 없다. 그래서 자기 lockfile을 가진 `scripts/agent-sdk-compat/`에 두고 CI 전용 job이 돌린다.
- **harness 실패로 run을 막는다.** 지금까지 이 harness의 CI 실패는 모두 flaky였고 제품 회귀는 없었다. 그래서 job은 `continue-on-error`로 두고 실패를 이슈로 알린다([ci.md](../ci.md)).

## 이 harness가 지키는 계약

실제 SDK가 실제 번들 Claude Code child process를 실행하고, local fake Anthropic upstream과 실제 LiteLLM proxy를 거쳐 왕복한다. 실제 Anthropic 계정·credential·과금 호출은 쓰지 않는다. 계약별 세부 목록은 [harness README](../../../scripts/agent-sdk-compat/README.md)에 있다.

| 계약 | 파일 |
|---|---|
| project 확장(`CLAUDE.md`·rules·command·Skill·plugin·MCP·subagent), hook·callback의 ID 전달, 권한 mode와 allow/deny/ask 우선순위, resume과 UUID dedup, `interrupt()` | `src/sdk-contract.test.ts` |
| 승인 대기 중 종료(`abort()`·`SIGTERM`·`SIGKILL`)와 `defer` 뒤 resume | `src/lifecycle-contract.test.ts` |
| tenant 격리: `HOME`·`CLAUDE_CONFIG_DIR` 분리, 상위 `CLAUDE.md` 탐색 | `src/isolation-contract.test.ts` |
| LiteLLM `/v1/messages` 전달, header·cache metadata 유지, alias 라우팅, `429` 전달, timeout, 취소 전달 | `src/litellm-transport.test.ts` |
| 실제 SDK·Claude Code·LiteLLM 버전과 플랫폼 | `src/version-probe.ts` |

native SDK message를 public SSE event로 바꾸는 투영은 이 harness가 아니라 제품 코드(`packages/adapters/runtimes/claude/src/mapper.ts`와 `mapper.test.ts`, `runtime.integration.test.ts`)가 확인한다.

## 실행

CI의 `agent-sdk-compat` job이 main push와 수동 실행(`gh workflow run CI --ref <branch> -f only=agent-sdk-compat`)에서 돌린다. PR에서는 돌지 않는다. 로컬에서는 다음 순서로 돌린다.

```bash
bun install --frozen-lockfile
bun install --cwd scripts/agent-sdk-compat --frozen-lockfile
uv tool install 'litellm[proxy]==1.100.1'
bun run --cwd scripts/agent-sdk-compat probe:version
bun run --cwd scripts/agent-sdk-compat check
```

SDK나 `zod`를 올릴 때는 두 `package.json`을 같은 버전으로 함께 바꾸고, 두 lockfile을 갱신한 뒤 위 명령과 CI 수동 실행으로 확인한다.
