# Agent SDK·LiteLLM 호환 harness

SDK·LiteLLM 버전을 올릴 때 돌리는 호환 harness다. 실제 Agent SDK가 실제 번들 Claude Code child process를 실행하고, local fake Anthropic upstream과 실제 LiteLLM proxy를 거쳐 왕복하는지 process 수준에서 확인한다. 채택 버전, 운영 제약, 버전을 고정하는 방식은 [결정 기록](../../docs/contributing/decisions/agent-sdk.md)에 있다.

workspace 밖의 독립 설치 단위다. 자기 `bun.lock`으로 SDK를 고정하고, `packages/testkit`은 상대 경로로 import한다. CI `agent-sdk-compat` job이 main push와 수동 실행에서만 돌린다([docs/contributing/ci.md](../../docs/contributing/ci.md)). 이 harness의 SDK 버전이 제품과 같은지는 `tests/agent-sdk-compat/sdk-version.test.ts`가 검사한다.

실제 Anthropic 계정, credential, 과금 호출은 쓰지 않는다. paid smoke는 별도 승인 대상이다.

## 고정 버전과 실행 환경

| 항목 | 고정값 | 검증 |
| --- | --- | --- |
| Agent SDK | `@anthropic-ai/claude-agent-sdk@0.3.319` | 실제 query 및 callback |
| 번들 Claude Code | `2.1.319` | 실제 binary `--version` |
| LiteLLM | `1.100.1` | 실제 proxy PID 및 `--version` |
| 로컬 플랫폼 | macOS arm64 | 실제 process contract |
| CI 플랫폼 | Linux amd64 | 동일 version probe와 전체 contract suite |
| Anthropic endpoint | `POST /v1/messages` | SDK → LiteLLM → fake upstream |
| system prompt | `claude_code` preset + append | outbound request 검사 |
| filesystem settings | `settingSources: ["project"]` | 격리 matrix 검사 |

## 실행

저장소 루트에서 실행한다.

```bash
bun install --frozen-lockfile
bun install --cwd scripts/agent-sdk-compat --frozen-lockfile
uv tool install 'litellm[proxy]==1.100.1'
bun run --cwd scripts/agent-sdk-compat probe:version
bun run --cwd scripts/agent-sdk-compat check
```

`check`는 typecheck, contract suite(`test:contract`), LiteLLM transport suite(`test:transport`)를 차례로 돌린다. `test:contract`는 LiteLLM 없이도 돈다. 검사는 loopback HTTP server와 child process 실행 권한이 필요하다. 외부 네트워크는 최초 의존성 설치 외에는 필요하지 않다.

## SDK와 project 확장 계약

실제 SDK 및 실제 번들 process에서 다음을 확인한다.

- `CLAUDE.md`, `.claude/rules`, project custom command, project Skill 로딩 및 실제 호출
- local plugin namespaced command, in-process MCP tool, programmatic subagent 실제 호출
- `PreToolUse`, `PostToolUse`, `canUseTool`의 `requestId`, `toolUseID` 전달
- 같은 assistant message에서 복수 `AskUserQuestion` callback의 동시 실행, 선택지/자유입력 답변, tool ID 상관관계
- `default`, `acceptEdits`, `plan`, `dontAsk` mode 및 scoped allow/deny/ask 우선순위
- bare `allowedTools: ["Bash"]`의 callback 우회, project deny/ask의 우선순위
- headless 임시 workspace의 project allow 보류와 host callback fallback
- `plan` mode에서 host callback이 allow할 수 있으므로 플랫폼 callback의 별도 fail-closed 정책 필요
- 완료된 tool을 새 process에서 같은 session ID로 resume해도 중복 실행하지 않음
- 같은 user message UUID를 resume process에 다시 보내면 SDK가 deduplicate하고, UUID를 재생성하면 새 turn으로 실행함. 앱 queue가 UUID 생성과 redelivery 안정성을 소유함
- streaming input의 `interrupt()`는 현재 turn만 중단하고 같은 process의 후속 입력을 처리함

## 승인 대기 중 process 종료와 resume

| 종료 방식 | child 회수 | callback | terminal result | transcript | file side effect | resume |
| --- | --- | --- | --- | --- | --- | --- |
| `AbortController.abort()` | PID 확인, exit `0` 또는 `SIGTERM` | abort | `success/completed`가 먼저 관측된 뒤 iterator error | pending `tool_use_id` 유지 | 없음 | session은 열리지만 pending tool/callback을 재생하지 않음 |
| `SIGTERM` | PID 확인, exit `143` 또는 `SIGTERM` | signal로 종료 | 없음, iterator error | pending `tool_use_id` 유지 | 없음 | session은 열리지만 pending tool/callback을 재생하지 않음 |
| `SIGKILL` | PID 확인, exit `137` 또는 `SIGKILL` | process 즉시 종료 | 없음, iterator error | tail 및 pending tool이 유실될 수 있음 | 없음 | transcript flush 여부에 따라 pending tool을 재생하지 않거나 `No conversation found`로 실패함 |

따라서 `result.success`만으로 승인 대기 turn의 완료를 판단하지 않는다. 플랫폼은 `requestId`, `toolUseID`, worker 생존 상태를 함께 관리해야 한다.

`PreToolUse`의 `permissionDecision: "defer"`는 복수 tool hook을 모두 호출하고 `success/tool_deferred`로 turn을 닫는다. 이후 `resume`은 deferred tool을 재호출하지 않는다. 외부 승인 저장소의 durable continuation 수단으로 채택하지 않는다.

## tenant 격리

서로 다른 `HOME`과 `CLAUDE_CONFIG_DIR`을 사용하면 다른 tenant의 user settings, credential, memory, project instruction 및 host 인증 환경변수는 outbound request에 섞이지 않았다. 그러나 workspace 상위 디렉터리의 `CLAUDE.md`는 `settingSources: ["project"]`에서도 로딩됐다.

필수 배치 계약은 다음과 같다.

- tenant마다 별도의 `HOME`과 `CLAUDE_CONFIG_DIR`을 제공한다.
- host settings, memory, credential 파일을 tenant config tree에 복사하지 않는다.
- repo부터 filesystem root까지의 상위 경로를 tenant 전용 clean mount로 구성한다.
- SessionStore가 임시 config를 만들 때 allowlist 방식으로 필요한 project 설정만 복사한다.

## native SDK message → public SSE

public API는 다음 8종만 노출한다.

| public event | native source | 보존 필드 |
| --- | --- | --- |
| `system` | 비오류 system message | `type`, 공개 가능한 `subtype` |
| `assistant` | assistant text/content block | message, `parent_tool_use_id` |
| `tool_use` | assistant `tool_use` block | message, `parent_tool_use_id`, tool id |
| `tool_result` | user `tool_result` block | `tool_use_id`, result content |
| `question` | `canUseTool`/질문 pending request | `request_id`, `tool_use_id`, kind, tool, input |
| `result` | SDK result | subtype, session ID, usage, stop/terminal reason |
| `status` | platform session transition | 정규화된 session status |
| `error` | assistant error 또는 mirror error | 안정적인 code와 비민감 message |

native init의 cwd, tool inventory, backend error detail은 공개하지 않는다. `stream_event` partial frame은 native envelope에만 보존하고, 안정적인 public event로 직접 투영하지 않는다.

이 투영은 이 harness가 아니라 제품 코드에서 검증한다. 구현은 `packages/adapters/runtimes/claude/src/mapper.ts`(unit 테스트 `mapper.test.ts`)이고, 실제 SDK 왕복은 같은 디렉터리의 `runtime.integration.test.ts`가 확인한다.

## LiteLLM 실제 proxy 계약

실제 LiteLLM `1.100.1` process를 실행해 다음을 확인한다.

- Agent SDK streaming 요청이 `/v1/messages`로 전달됨
- tool payload, prompt cache metadata, `anthropic-version`, `anthropic-beta` 유지
- primary/helper/subagent alias가 각각 지정한 Anthropic upstream model로 라우팅됨
- upstream `429` 및 Anthropic error type 전달
- deployment별 `request_timeout`과 `timeout` 설정이 지연 upstream을 중단함
- streaming client 취소가 LiteLLM을 거쳐 upstream request abort로 전달됨

## 보안 및 범위

테스트는 placeholder credential만 사용하고 로그나 public SSE에 credential, host path, native error detail을 노출하지 않는다. paid Claude smoke는 이 harness의 필수 조건이 아니며 별도 승인과 비용 통제 후 수행한다.
