# 결정(제안): 실행 규칙(허용·거부)과 조직·에이전트 지시문

- 상태: 제안. 오너가 화면 시안을 고른 뒤에 구현한다. 이 문서는 구현을 승인하지 않는다.
- 기준: `origin/main` `20d42022d`. 파일 이름과 줄은 이 커밋에서 읽었다.
- 앞선 결정: [에이전트 마법사 재작업](agent-wizard-rework.md)(에이전트 지시문 칸을 만들었다가 2026-11-09에 없앴다), [원격 MCP 서버 등록](mcp-credentials.md)(MCP deny와 egress 집행). 지운 실행 규칙 화면은 [JeongJaeSoon/werft#1518](https://github.com/JeongJaeSoon/werft/pull/1518)에서 만들고 [JeongJaeSoon/werft#1798](https://github.com/JeongJaeSoon/werft/pull/1798)에서 지웠다.
- 엔진 중립 스킬·MCP 등록 설계는 별도 문서로 진행 중이다. 이 문서와 겹치는 곳은 "스킬·MCP 설계와 맞물리는 곳"에 모았다.

## 요약

1. **실행 규칙.** 규칙 하나는 `효과(허용|거부) + 대상(명령|파일 읽기|파일 수정|MCP 도구) + 패턴`이다. 워크스페이스 기본 규칙과 에이전트 규칙을 합치고, 거부가 어느 쪽에 있든 이긴다. 어디에도 맞지 않는 호출은 지금처럼 그 세션의 권한 모드대로 간다. werft가 이 공통 규칙을 엔진마다 바꿔 넣는다. 엔진이 표현하지 못하는 허용은 빼고(권한 모드대로 간다), 표현하지 못하는 거부가 있으면 그 엔진으로 실행하지 않는다. 규칙은 호출 모양을 비교하는 안전망이고 경계가 아니다. 경계는 지금처럼 컨테이너와 egress다.
2. **지시문.** 사용자는 파일 이름을 고르지 않는다. 글 두 개를 쓴다. 워크스페이스 설정 페이지의 **조직 지시문**과 에이전트 상세의 **에이전트 지시문**이다. 세션은 `조직 → 에이전트 → 저장소 지시 파일` 순서로 이어 붙인 글을 받는다. werft는 이미 엔진이 파일을 직접 읽지 못하게 막고 글을 프롬프트로 넣는다. 그래서 "CLAUDE.md냐 AGENTS.md냐"는 werft 안에서는 고를 문제가 아니다.
3. **추천.** 규칙 편집기는 시안 A(표 + 규칙 추가 행)다. 지시문은 시안 A(워크스페이스 설정 카드 + 나란히 미리보기)에, 시안 B의 "합친 결과" 보기를 에이전트 쪽에 더한다.

## 지금 있는 것

- **내장 작업 공간 규칙.** `packages/runtime-core/src/workspace-policy.json` 하나가 엔진마다 바뀌어 들어간다.
  - Claude에는 flag settings의 permission 규칙으로 들어가므로 저장소의 `.claude/settings.json`이 넓히지 못한다(`packages/adapters/runtimes/claude/src/workspace-permissions.ts:5-20`).
  - Codex에는 `CODEX_HOME/rules`의 `.rules` 파일(`prefix_rule`)로 들어간다. prefix로 옮길 수 없는 패턴은 `unexpressed`로 따로 모은다(`packages/adapters/runtimes/codex/src/exec-rules.ts:5-27`).
  - 이 규칙은 사용자가 끌 수 없고, 이 문서의 규칙보다 먼저 판정한다.
- **사용자 규칙 경로의 흔적.** worker 계약에는 `runtime_config.disallowed_tools`가 남아 있다(`packages/contracts/src/worker-protocol/index.ts:426-436`). 하지만 #1798 뒤로 서버는 이 필드를 보내지 않는다. Codex 어댑터는 deny 규칙을 받으면 실행을 거절한다(`packages/adapters/runtimes/codex/src/config.ts:176`). DB의 `workspace_engine_settings`·`agent_engine_settings` 표는 행과 함께 남아 있고, 엔진 문법 문자열을 저장한다.
- **MCP deny.** 릴리스가 고정한 MCP deny는 두 곳에서 쓴다. 에이전트 MCP 설정을 저장할 때 `mcp_tool_denied`로 거절하고, egress가 `tools/call`마다 `mcpToolPermitted`로 판정한다(`packages/platform/src/workers/mcp-egress.ts:164`, `packages/platform/src/catalog/mcp-tool-decision.ts:9-15`). egress 판정은 엔진과 상관없이 동작한다. 일치는 정확한 이름과 서버 전체(`mcp__<서버>__*`)뿐이다.
- **권한 모드.** Claude는 기본이 `auto`, Codex는 `default`다(`packages/platform/src/agents/release-run.ts:73-77`). Claude의 `auto`와 `bypassPermissions`는 통과시킨 호출에 `canUseTool`을 부르지 않는다(`packages/adapters/runtimes/claude/src/runtime.ts:212-214`). 거부 규칙(`disallowedTools`)은 모든 모드에서 엔진에 넘긴다(같은 파일 `:484-487`). 플랫폼 MCP 서버의 `trustedTools`는 엔진의 권한 단계를 건너뛴다(같은 파일 `:416-431`).
- **지시 파일.**
  - 저장소 지시 파일: Claude는 `AGENTS.md`, 없으면 `CLAUDE.md`를 읽고(`packages/adapters/runtimes/claude-codec/src/descriptor.ts:32`), Codex는 `AGENTS.md`만 읽는다(`packages/adapters/runtimes/codex-codec/src/descriptor.ts:50`). 읽는 것은 worker다. 엔진은 직접 읽지 않는다.
    - Claude는 `settingSources: []`로 엔진의 CLAUDE.md 읽기를 끄고(`packages/adapters/runtimes/claude/src/contract.ts:110-122`), 텍스트를 preset 시스템 프롬프트 뒤에 붙인다(`repository-instructions.ts:15-29`, `runtime.ts:488-494`).
    - Codex는 `project_doc_max_bytes = 0`으로 엔진의 AGENTS.md 읽기를 끄고 developer instructions로 넣는다(`packages/adapters/runtimes/codex/src/config.ts:193-209`, `:318-319`).
  - 플랫폼 지시문은 저장소 없는 세션에 주는 한 줄뿐이다(`apps/worker/src/composition.ts:370-399`).
  - worker는 플랫폼 지시문을 작업 디렉터리에 `AGENTS.md`로 두고 `CLAUDE.md`를 그 링크로 둔다. 세션 안에서 파일을 직접 여는 도구를 위한 것이다. 저장소가 그 이름을 이미 쓰면 손대지 않는다(`apps/worker/src/instruction-files.ts:16-44`).
- **에이전트 지시문.** 한 번 만들었다가 2026-11-09 오너 결정으로 없앴다. 동작 지시는 저장소 파일 하나로만 남았다([에이전트 마법사 재작업](agent-wizard-rework.md) 머리말). 이 문서는 그 자리를 다시 연다. 그때 정리한 checkpoint 지문과 worker 호환 조건(같은 문서의 "동작 지시를 둘 자리", "worker 호환")은 그대로 따른다.

## 조사 요약과 시장 동향 (2026-11-20 확인)

이 절은 다른 제품이 관리자에게 "에이전트가 무엇을 실행해도 되는지"를 어떻게 맡기는지 정리한다. 기간은 최근 3~6개월이고, 기준선이 되는 이전 자료도 포함했다. 엔진 세 개의 세부 문법은 다음 절 "엔진 조사"에 있다. [P]는 vendor 문서·changelog, [S]는 2차 출처다.

| 제품 | 관리자가 정하는 곳 | 규칙 모양과 결합 | 출처 |
|---|---|---|---|
| Claude Code | managed settings(파일·MDM, Team/Enterprise는 claude.ai 관리 화면에 JSON을 붙여 넣는 server-managed settings) | allow·ask·deny, deny → ask → allow. 목록은 scope를 가로질러 합쳐진다. `allowManagedPermissionRulesOnly`를 켜면 user·project·local 규칙과 `--allowedTools`를 무시한다 | [P] [managed settings](https://code.claude.com/docs/en/managed-settings), [server-managed](https://code.claude.com/docs/en/server-managed-settings), [settings](https://code.claude.com/docs/en/settings) |
| Codex | `requirements.toml`, ChatGPT Admin Console의 Agent security(워크스페이스 기본 + 사용자·그룹 override). 클라우드에서 못 받으면 시작하지 않는다 | 관리자 `[rules]`의 decision은 `prompt`나 `forbidden`만 된다(`allow` 금지). 관리자는 좁히기만 한다. approval policy와 sandbox mode를 허용 목록으로 제한한다 | [P] [managed configuration](https://learn.chatgpt.com/docs/enterprise/managed-configuration.md), [approvals·security](https://learn.chatgpt.com/docs/agent-approvals-security.md) |
| GitHub Copilot cloud agent | org 설정(2026-04-03): firewall 켜기, 권장 allowlist, org 공통 allowlist, **저장소 관리자가 항목을 더할 수 있는지** | 기본값은 "저장소가 정한다". 차단하면 막힌 주소를 PR에 남긴다. MCP는 enterprise managed settings의 allow·deny(2026-08-06 GA)이고, 서버를 이름이 아니라 URL·명령으로 식별한다 | [P] [firewall changelog](https://github.blog/changelog/2026-04-03-organization-firewall-settings-for-copilot-cloud-agent/), [MCP allowlist](https://github.blog/changelog/2026-08-06-mcp-allowlists-in-enterprise-managed-settings/) |
| Cursor | team dashboard, managed·저장소별 `permissions.json` | 실행 모드는 Auto-review / Allowlist / Run Everything이다. Ask Every Time은 3.5(2026-05)에서 없앴다. 관리자는 쓸 수 있는 모드를 줄이고, 관리자가 정한 칸에는 "controlled by the admin"이 붙는다. 상위 출처가 범주째 대체한다. 문서 제목이 "Auto-review is not a security boundary"다 | [P] [run modes](https://cursor.com/docs/agent/security/run-modes), [deployment](https://cursor.com/docs/enterprise/deployment-patterns) |
| Gemini CLI | admin policy 디렉터리(TOML policy engine), enterprise controls | `allow`·`deny`·`ask_user`에 숫자 priority가 붙고 admin tier가 가장 높다. 사용자가 admin 통제를 덮지 못하고, 확장 정책은 `allow`를 줄 수 없다 | [P] [policy engine](https://geminicli.com/docs/reference/policy-engine.md), [enterprise](https://geminicli.com/docs/admin/enterprise-controls/) |
| AWS AgentCore Policy | gateway | 도구 호출마다 Cedar로 판정하고 기본은 거부다 | [S] [구현 안내](https://hidekazu-konishi.com/entry/amazon_bedrock_agentcore_policy_implementation_guide.html), [P] [preview 발표](https://aws.amazon.com/about-aws/whats-new/2025/12/amazon-bedrock-agentcore-policy-evaluations-preview) |

**이 기간의 사고와 비판**
- 텍스트 매칭 allowlist의 우회
  - Cursor CVE-2026-22708(2026-01, 2.3에서 수정): `export` 같은 셸 내장 명령이 allowlist 검사를 거치지 않았다. `PAGER`를 바꿔 두면 허용된 `git branch`가 임의 코드를 실행했다. [P] [advisory](https://github.com/cursor/cursor/security/advisories/GHSA-82wg-qcm4-fp2w)
  - Roo Code CVE-2026-110202~110206(2026-10): 명령 치환·따옴표·리다이렉트 해석 차이로 자동 승인을 우회했다. [P] [VulnCheck](https://www.vulncheck.com/advisories/roo-code-through-3.54.0-auto-approve-bypass-via-command-substitution-at-command-position)
  - Claude Code·Codex·Gemini CLI에서는 같은 기간의 공개 CVE를 찾지 못했다. 다만 두 문서 모두 텍스트 규칙의 한계를 스스로 적는다.
- 저장소 설정 파일을 믿어서 생긴 실행: Gemini CLI가 workspace trust와 allowlist를 우회당해 RCE가 났다(GHSA-wpqr-6v78-jr5g, 2026). [S] [요약](https://labs.cloudsecurityalliance.org/research/csa-research-note-gemini-cli-rce-cvss10-ai-tool-security-202/)
- MCP 도구 설명 바꿔치기(rug pull): 승인한 뒤에 설명이 조용히 바뀐다. 대응은 도구 정의 해시 고정과 바뀌면 다시 승인하는 것이다. [S] [CSA](https://labs.cloudsecurityalliance.org/research/csa-research-note-mcp-tool-description-poisoning-20260711-cs/)

**모이는 방향**
1. **모드와 규칙 목록, 두 층.** 모드(Claude permission mode, Codex approval × sandbox, Cursor run mode) 위에 allow·ask·deny 목록이 얹힌다. 관리자 화면은 "쓸 수 있는 모드"와 "강제하는 목록"을 따로 둔다.
2. **거부가 이긴다.** Claude, Codex, Copilot MCP 모두 그렇다. Gemini만 숫자 priority를 쓴다.
3. **조직 층은 좁히는 쪽이다.** Codex는 관리자 규칙에서 `allow`를 막았다. Claude는 "managed 규칙만" 잠금을 둔다. Copilot은 "하위가 더해도 되는가"를 따로 켠다. 결과적으로 "강제 / 위임 / 하위 추가 허용" 세 단계가 보편적이다.
4. **잠긴 규칙과 그 출처를 사용자에게 보인다.** Cursor "controlled by the admin", Claude `/status`·`/permissions`, Copilot PR 경고.
5. **정책을 못 받으면 멈춘다(fail-closed).** Codex 클라우드 요구, Claude `forceRemoteSettingsRefresh`, Copilot의 잘못된 정책이 그렇다.
6. **텍스트 규칙은 경계가 아니다.** 실제 강제는 sandbox와 egress에 두고, classifier(Auto-review, auto mode)도 경계가 아니라고 vendor가 명시한다.
7. **도구 호출의 판정은 gateway로 모인다.** Cedar나 ReBAC로 호출마다 판정하고 기본은 거부다. MCP 서버는 이름이 아니라 URL·명령으로 식별한다.
8. **엔진 사이의 권한 규칙 표준은 없다.** AAIF가 표준화한 것은 MCP, Agent Skills, AGENTS.md다. Agent Skills의 `allowed-tools`는 실험 필드이고 Claude 문법을 쓴다([spec](https://agentskills.io/specification)). 지시 파일은 AGENTS.md가 가장 넓게 채택됐다(Codex, Copilot, Cursor, Gemini CLI, goose 등, [agents.md](https://agents.md/)).

## 엔진 조사 (공개 자료, 2026-11-20 확인)

pi는 `badlogic/pi-mono`에서 `earendil-works/pi`로 옮겼다. 인용은 `earendil-works/pi@1e34c3b` 기준이다. Codex 소스 인용은 `openai/codex@6eea328` 기준이다.

### 권한 규칙

| 항목 | Claude Code / Agent SDK | Codex CLI | pi |
|---|---|---|---|
| 효과 | `allow`·`ask`·`deny` | `allow`·`prompt`·`forbidden` | 내장 규칙 없음. 확장의 `tool_call` handler가 `{ block: true }`를 돌려 막는다 |
| 충돌 | deny → ask → allow 순서로 처음 맞는 것. 구체성은 순서를 바꾸지 않는다 | 맞는 규칙 중 가장 엄격한 것 | handler 코드가 정한다 |
| 명령 | `Bash(npm run *)`. `*`는 어디든 모든 문자. 복합 명령은 연산자로 나누고, 허용은 모든 조각이 맞아야, 거부는 한 조각만 맞아도 걸린다 | `prefix_rule(pattern=[...])`. token 단위 prefix이고 glob은 없다. 단순 `&&`·`;`·`|` 연결만 나눈다 | `bash` 도구 호출을 handler가 보고 판정 |
| 파일 | `Read(...)`, `Edit(...)`. gitignore 문법 | `[permissions.<name>]` profile의 `read`·`write`·`deny`. `sandbox_mode`와 같이 쓸 수 없다 | `read`·`edit`·`write` 호출을 handler가 판정 |
| 네트워크 | `WebFetch(domain:...)`, sandbox 목록과 합쳐진다 | profile의 `network.domains` | 웹 도구가 기본에 없다 |
| MCP | `mcp__<서버>__<도구>`, `mcp__<서버>__*` | 서버마다 `enabled_tools`·`disabled_tools` | `--tools`·`--exclude-tools`는 모델에 보이는 도구만 거른다. codemode 스크립트는 숨긴 MCP 도구도 부를 수 있다 |
| 범위 | managed > CLI > local > project > user. 목록은 합쳐지고 어디서든 deny가 이긴다 | 설정 층마다 `rules/`. project 층은 trust가 있어야 읽는다 | trust는 `.pi` 설정과 확장을 읽을지만 정한다 |
| 한계 | 문서가 "security boundary가 아니다"라고 쓴다(`/bin/rm`, `bash -c` 등) | rules는 sandbox 밖에서 돌려도 되는 명령을 정할 뿐, sandbox를 대신하지 않는다 | 묻는 단계가 없다. 막지 않은 것은 바로 돈다 |

출처: [Claude permissions](https://code.claude.com/docs/en/permissions), [Agent SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions), [Codex rules](https://learn.chatgpt.com/docs/agent-configuration/rules), [Codex permissions](https://learn.chatgpt.com/codex/permissions), [Codex config reference](https://learn.chatgpt.com/codex/config-file/config-reference), [Codex config schema](https://github.com/openai/codex/blob/6eea32808167c4b87508e9611ba116f061ee315c/codex-rs/core/config.schema.json), [pi extensions](https://github.com/earendil-works/pi/blob/1e34c3b4c7df78e716a8f53ad0bcf3a00feceedc/packages/coding-agent/docs/extensions.md), [pi CLI](https://github.com/earendil-works/pi/blob/1e34c3b4c7df78e716a8f53ad0bcf3a00feceedc/packages/coding-agent/docs/cli.md), [pi security](https://github.com/earendil-works/pi/blob/1e34c3b4c7df78e716a8f53ad0bcf3a00feceedc/packages/coding-agent/docs/security.md).

### 지시 파일

| 항목 | Claude Code / Agent SDK | Codex CLI | pi |
|---|---|---|---|
| 이름 | `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/*.md` | `AGENTS.override.md` → `AGENTS.md` → `project_doc_fallback_filenames` (디렉터리마다 처음 하나) | `AGENTS.override.md` → `AGENTS.md` → `CLAUDE.md` (디렉터리마다 처음 하나) |
| AGENTS.md | CLI v2.1.277부터 기본값으로 읽는다. 단, 작업 디렉터리나 그 위에 `CLAUDE.md`·`.claude/CLAUDE.md`·`CLAUDE.local.md`가 **없을 때만** 읽는다 | 기본 | 기본. 같은 디렉터리에 AGENTS.md가 있으면 CLAUDE.md는 읽지 않는다 |
| 찾는 범위 | 파일 시스템 루트 → 작업 디렉터리, 하위 디렉터리는 그 파일을 다룰 때 | git 루트 → 작업 디렉터리. trust 없는 project는 읽지 않는다 | agent 디렉터리, 그다음 파일 시스템 루트 → 작업 디렉터리. git 루트에서 멈추지 않고 trust 없이도 읽는다 |
| 크기 | 4 MiB를 넘으면 건너뛴다(권장 200줄) | 합계 32 KiB(`project_doc_max_bytes`) | 확인 못 함 |
| 끄고 직접 넣기 | SDK `settingSources: []` + `systemPrompt` append | `project_doc_max_bytes = 0` + `developer_instructions` | `--no-context-files` + `--append-system-prompt` |

출처: [Claude memory](https://code.claude.com/docs/en/memory), [Agent SDK claude-code-features](https://code.claude.com/docs/en/agent-sdk/claude-code-features), [Codex agents_md.rs](https://github.com/openai/codex/blob/6eea32808167c4b87508e9611ba116f061ee315c/codex-rs/core/src/agents_md.rs), [Codex defaults.toml](https://github.com/openai/codex/blob/6eea32808167c4b87508e9611ba116f061ee315c/codex-rs/config/defaults.toml), [pi resource-loader.ts](https://github.com/earendil-works/pi/blob/1e34c3b4c7df78e716a8f53ad0bcf3a00feceedc/packages/coding-agent/src/core/resource-loader.ts#L214), [pi configuration](https://github.com/earendil-works/pi/blob/1e34c3b4c7df78e716a8f53ad0bcf3a00feceedc/packages/coding-agent/docs/configuration.md).

**확인 못 한 것.** Agent SDK 세션이 AGENTS.md를 읽는지(SDK 문서의 `settingSources` 표에는 CLAUDE.md만 있다). Codex MCP `approval_mode` 값 네 개의 뜻. pi 지시 파일의 크기 한도와 `@import` 지원. werft는 앞의 둘에 기대지 않는다. Claude는 `settingSources: []`로 엔진 읽기를 끄고, Codex MCP는 `disabled_tools`와 egress로만 다룬다.

## 따를 것 / 다르게 갈 것

권한 규칙에는 엔진 사이 표준이 없다. 지시 파일만 AGENTS.md라는 표준이 있다. 그래서 세 가지 방식을 대상마다 나눠 쓴다.

| 방식 | 대상 | 이유 |
|---|---|---|
| **표준 그대로** | 저장소 지시 파일 이름(`AGENTS.md` 우선), MCP 서버와 도구의 식별(서버 등록과 MCP `tools/list`의 도구 이름) | 여러 엔진과 MCP 서버가 같은 뜻으로 받는다. 저장소 쪽 사용자는 이미 이 이름을 쓴다 |
| **엔진별 어댑터** | 규칙 변환(Claude flag settings와 `mcp__<서버>__<도구>` 표기, Codex `.rules`와 서버별 `disabled_tools`, pi 확장), 지시문 전달(시스템 프롬프트 뒤, developer instructions), 엔진의 지시 파일 직접 읽기 끄기 | 엔진마다 문법과 표현 능력이 다르다. MCP 도구를 가리키는 표기도 엔진마다 다르다. 차이는 어댑터와 코덱 descriptor가 갖고 화면에 새지 않는다 |
| **werft 모델 + 포트** | 규칙 모델과 저장, 합치기와 판정 순서, 세션 snapshot, 판정 기록 | 표준이 없고, 저장 모양이 한 엔진 문법이면 다른 엔진이 못 받는다(지운 화면의 실패) |

**따르는 업계 관행**
- 거부가 이긴다(Claude, Codex, Copilot MCP). 조직 층은 좁히는 쪽으로 쓴다.
- 물려받은 규칙은 출처와 함께 보이고, 아래 층에서 지우지 못한다(Cursor "controlled by the admin", Claude `/permissions`).
- 정책을 싣지 못하면 실행하지 않는다(Codex 클라우드 요구, Claude `forceRemoteSettingsRefresh`). 이 문서의 "capable worker가 없으면 claim 거절", "표현 못 하는 거부면 그 엔진으로 실행하지 않음"이 이것이다.
- 텍스트 규칙을 경계로 부르지 않는다(Claude, Cursor 문서). 경계는 컨테이너와 egress다.
- 판정은 엔진 밖 gateway에서 한다(AgentCore, Copilot MCP). werft에서는 MCP egress가 그 자리다.

**다르게 가는 것과 이유**

| 다른 제품 | werft | 이유 |
|---|---|---|
| 엔진 문법 문자열을 저장한다(Claude `Bash(...)`, Codex `prefix_rule`) | 엔진 중립 모양으로 저장하고 claim 때 바꾼다 | 엔진이 셋이다. 지운 화면은 Claude 문법을 저장해서 Codex가 받지 못했다 |
| 효과에 ask가 있다(Claude, Gemini, Codex `prompt`) | v1은 허용·거부만 | 오너 지시. 모델은 ask를 더할 자리를 막지 않는다(고르지 않은 것) |
| 모드와 규칙을 한 화면에서 고른다(Cursor run modes, Codex approval × sandbox) | 이 화면은 규칙만. 권한 모드는 지금처럼 릴리스 값이다 | auto 모드를 이번에 다루지 않는다. 모드 선택이 들어가면 화면이 지운 것만큼 길어진다 |
| 네트워크 규칙을 같은 목록에 둔다(Claude `WebFetch(domain:)`, Codex network permissions) | v1 대상에서 뺀다 | 실제 경계는 설치의 egress allowlist다. 엔진 규칙에 넣으면 경계처럼 보이지만 경계가 아니다 |
| 관리자 층은 allow를 줄 수 없다(Codex `requirements.toml`, Gemini 확장 정책) | 워크스페이스 허용을 둔다 | werft의 워크스페이스 관리자는 그 워크스페이스의 실행 주체다. 묻기를 줄이는 허용을 조직이 정하는 것이 오너 요구다. 대신 아래 "에이전트 관리자가 허용을 더할 수 있음"으로 위임을 조절한다 |
| 하위 층 추가 허용은 따로 켠다(Copilot firewall, Claude `allowManagedPermissionRulesOnly`) | 워크스페이스 설정 하나: **에이전트 관리자가 허용을 더할 수 있음**(기본 켬). 끄면 에이전트 규칙은 거부만 받는다 | 업계의 "강제 / 위임 / 하위 추가 허용" 세 단계 중 werft에 필요한 것은 하위 허용의 켜고 끄기 하나다. 거부 추가는 언제나 좁히는 일이라 막을 이유가 없다. **오너 결정 필요(5번).** 끌 때 이미 저장된 에이전트 허용은 지우지 않고 합치기에서 뺀다. 화면에는 "위임이 꺼져 적용되지 않음"으로 남는다. 끄는 것은 허용 삭제와 같은 좁히는 변경이라 진행 중인 세션의 다음 claim부터 걸린다. 다시 켜는 것은 넓히는 변경이라 새 세션부터 걸린다("언제 적용되나") |
| 엔진이 저장소의 설정·지시 파일을 직접 읽는다 | 엔진의 직접 읽기를 끄고 worker가 읽어 프롬프트로 넣는다(지금과 같음) | 저장소 설정을 믿어서 생긴 실행 사고(Gemini CLI GHSA-wpqr-6v78-jr5g)와 같은 종류를 막는다. 저장소 파일은 지시문으로만 들어가고 설정이나 규칙으로는 들어가지 않는다 |

**사고에서 가져오는 규칙**
- **허용은 환경을 바꾸는 명령에 맞지 않는다.** 실행 단위가 변수 대입(`X=1 cmd`)이나 환경·별칭을 바꾸는 내장 명령(`export`, `env`, `alias`, `typeset`, `declare`, `set`, `source`, `.`, `eval`, `exec`)으로 시작하면, 어떤 사용자 허용에도 맞지 않은 것으로 본다. 거부 판정은 그대로 한다. Cursor CVE-2026-22708이 바로 이 모양이었다. 허용 칸에 이런 명령을 넣으면 저장하지 않는다.
- **나눌 수 없는 명령은 허용에 맞지 않는다.** 앞 절의 "실행 단위"와 같다. Roo Code CVE들은 명령 치환과 따옴표 해석 차이로 자동 승인을 우회했다.
- **MCP 서버는 등록 id로 가리킨다.** 이름 문자열이 아니다(Copilot MCP allowlist가 URL·명령으로 식별하는 것과 같은 이유). 도구 정의가 바뀌었을 때 다시 승인하는 일(rug pull 대응)은 스킬·MCP 설계의 몫이다.
- **세션은 적용된 규칙의 digest를 기록한다.** 사고 뒤에 "그때 어떤 규칙이었나"를 답할 수 있어야 한다.

## 공통 규칙 모델

```
Rule  = { effect: "allow" | "deny", target: Target, pattern: string }
Target = "command" | "file_read" | "file_edit" | "mcp_tool"
Scope = workspace | agent
```

### 패턴

세 엔진이 모두 같은 뜻으로 받을 수 있는 모양만 받는다.

| 대상 | 패턴 | 예 | 받지 않는 것 |
|---|---|---|---|
| 명령 | 공백으로 나눈 단어의 **앞부분**. 실행 단위 하나가 그 단어들로 시작하면 맞는다 | `git push --force` | 단어 안의 `*`, 셸 연산자, 따옴표, 환경 변수. 허용에서는 변수 대입이나 환경을 바꾸는 내장 명령으로 시작하는 패턴(앞 절) |
| 파일 읽기·수정 | 저장소 루트 기준 경로. `*`(한 단계), `**`(여러 단계), 끝의 `/`(디렉터리) | `.github/workflows/**` | `..`, 절대 경로, 홈(`~`), 부정(`!`), 이스케이프 |
| MCP 도구 | 워크스페이스에 등록한 서버 하나 + 도구 이름. 도구 이름 끝에만 `*` | `github / delete_*` | 서버 이름의 `*` |

- 명령 패턴을 prefix로 묶는 이유는 Codex `prefix_rule`이 prefix만 받기 때문이다. Claude에는 `Bash(<p>)`와 `Bash(<p> *)` 두 규칙으로 넣어 같은 뜻을 만든다. 단어 안 glob을 받으면 Codex에서 표현하지 못하는 규칙이 흔해지고, 화면의 경고가 늘어난다.
- **실행 단위.** 패턴은 호출 명령 문자열 전체가 아니라 실행 단위마다 비교한다. 실행 단위는 `&&`·`||`·`;`·`|`로 나눈 조각이다. Claude와 Codex는 엔진이 나눈다. pi는 werft 확장이 같은 방식으로 나눈다. 따옴표·명령 치환·리다이렉션·변수가 들어 있어 나눌 수 없는 명령은 허용 규칙에 맞지 않은 것으로 본다. 거부 규칙은 나눌 수 있는 부분만으로도 판정한다. pi에서는 나눌 수 없는 명령을 werft 승인 요청으로 보낸다(권한 모드와 상관없이).
- **경로 기준.** 파일 패턴은 저장소 루트에 고정한다. Claude에는 세션의 저장소 루트를 붙인 절대 경로(`//<루트>/<g>`)로 넣는다. `./g`는 엔진의 현재 디렉터리 기준이라 하위 디렉터리에서 뜻이 바뀌므로 쓰지 않는다. 비교는 심볼릭 링크를 푼 실제 경로로 한다. 루트 밖을 가리키는 경로는 어떤 허용에도 맞지 않는다. 새로 만드는 파일은 이미 있는 가장 가까운 상위 디렉터리의 실제 경로에 남은 이름을 붙여 비교한다. 그래서 상위 디렉터리가 루트 밖을 가리키는 링크면 루트 밖 경로가 된다.

### 규칙이 하는 일과 못 하는 일

규칙은 **호출 모양**을 비교한다. 행위 전체를 막지 않는다. 화면의 판정기와 규칙 입력 칸 아래에 이 한계를 적는다.
- `git push --force` 거부는 `git push origin --force`, `git push -f`, `git -C . push --force`에 맞지 않는다. 막으려면 그 모양들을 각각 더해야 한다. 판정기는 이런 이웃 모양을 예시로 보인다.
- 파일 규칙은 엔진의 파일 도구(Read·Edit 등)와 명령 규칙에 걸린 명령에만 닿는다. 허용한 `python`·`node`·테스트 스크립트가 안에서 여는 파일은 보지 못한다. 스킬 스크립트도 바깥 실행 명령만 규칙을 받는다.
- 보장해야 하는 것(비밀 값, 네트워크 목적지, 다른 세션의 파일)은 지금처럼 컨테이너, 파일 권한, egress가 맡는다. Claude 문서도 권한 규칙을 security boundary가 아니라고 쓴다.
- 네트워크(도메인)는 v1 대상에서 뺀다. Codex는 sandbox profile 없이는 도메인을 못 받고, pi에는 웹 도구가 없다. 무엇보다 실제 경계는 설치의 egress allowlist(`EGRESS_ALLOWLIST`, `apps/egress-proxy/src/config.ts:24`)이고, 그것은 운영자 설정이다. 워크스페이스별 도메인 목록이 필요하면 egress에서 엔진과 상관없이 집행하는 별도 설계로 한다.
- 규칙 문자열은 엔진 문법으로 저장하지 않는다. 지운 엔진 설정 표는 Claude 문법 문자열을 저장했다. 그래서 Codex가 그 규칙을 받지 못했고, 화면은 엔진별 문법을 그대로 보였다.

### 판정 순서

1. 거부: 내장 규칙의 거부 ∪ 워크스페이스 거부 ∪ 에이전트 거부. 하나라도 맞으면 거부한다.
2. 내장 규칙의 묻기: 맞으면 사람에게 묻는다.
3. 허용: 내장 규칙의 허용 ∪ 워크스페이스 허용 ∪ 에이전트 허용. 맞으면 묻지 않고 실행한다.
4. 어디에도 맞지 않으면 그 세션의 권한 모드대로 한다.

- "내장 규칙 먼저, 처음 맞는 것"으로 판정하지 않는다. 그렇게 하면 내장 허용이 사용자 거부를 이긴다. 위 순서는 Claude의 deny → ask → allow와 같다. Codex는 가장 엄격한 것이 이기므로 결과가 같다. pi는 werft 확장이 이 순서로 판정한다.
- 4의 "권한 모드대로"는 "항상 묻는다"가 아니다. Claude `auto`는 분류기가 판단한다. `default`도 읽기 전용 명령처럼 엔진이 스스로 허용하는 것은 묻지 않는다. 플랫폼 MCP 서버의 `trustedTools`는 권한 단계를 건너뛴다(사용자 MCP 거부는 egress에서 여전히 막힌다). 이 문서는 4를 바꾸지 않는다. "맞지 않으면 항상 묻기"가 필요하면 엔진마다 강제로 묻는 경로를 따로 설계해야 한다.
- 내장 규칙 중 Codex로 옮기지 못한 묻기(`unexpressed`)는 지금도 Codex에서 빠져 있다. 옮긴 묻기도 모양이 넓어지거나 좁아질 수 있다(예: `git * --output*`가 `git --output`이 된다, `exec-rules.ts:15`). 사용자 허용이 그 자리를 넓히지 않도록, Codex로 넘기는 사용자 허용이 **원본** 내장 묻기 패턴 하나와라도 겹칠 수 있으면 그 허용을 Codex에서 뺀다. 겹침 판정은 원본 패턴(Claude 문법) 기준으로 한다.
- 에이전트는 워크스페이스 규칙을 지우거나 끄지 못한다. 좁히려면 거부를 더한다. "에이전트에서만 워크스페이스 허용을 끈다"를 두면 같은 화면에 덮어쓰기와 합치기가 섞인다. 지운 화면이 장황했던 이유 중 하나가 이것이다.
- auto 모드는 이번에 다루지 않는다. 다만 거부는 auto에서도 지켜진다(`disallowedTools`, `prefix_rule forbidden`). 허용이 auto에서 하는 일(분류기를 건너뛰는지)은 auto 모드를 다룰 때 정한다.

### 언제 적용되나

- 세션은 시작할 때 합친 규칙을 snapshot으로 남긴다.
- 넓히는 변경(허용 추가, 거부 삭제)은 새 세션부터 걸린다.
- 좁히는 변경(거부 추가, 허용 삭제)은 대상마다 걸리는 때가 다르다. 화면의 저장 안내에 그대로 쓴다.

| 좁히는 변경 | 걸리는 때 |
|---|---|
| MCP 도구 거부 | 바로. egress가 호출마다 지금 규칙을 읽는다(에이전트 MCP 선택의 `effectiveMcp`와 같다) |
| 명령·파일 규칙 | 진행 중인 세션의 다음 claim(다음 turn)부터. 이미 돌고 있는 turn에는 걸리지 않는다 |

- **표현 못 하는 거부가 진행 중에 생기면.** 예를 들어 Codex 세션이 도는 중에 파일 거부를 더한 경우다. 다음 claim에서 서버가 엔진의 표현 능력을 다시 검사하고 claim을 거절한다. 세션은 이유("이 규칙 때문에 Codex로 이어 갈 수 없습니다")와 함께 멈춘다. checkpoint에서 재개할 때도 같은 검사를 한다. 거부를 지키지 못하는 채로 도구가 실행되는 길은 없다.

## 엔진별 변환표

| 공통 규칙 | Claude | Codex | pi |
|---|---|---|---|
| 명령 허용 `p` | flag settings `permissions.allow`에 `Bash(p)`, `Bash(p *)` | `prefix_rule(pattern=p의 단어들, decision="allow")` | werft 확장이 `bash` 명령을 실행 단위로 나누고, 모든 단위가 허용에 맞을 때만 통과 |
| 명령 거부 `p` | `permissions.deny` 같은 두 규칙(모든 모드에서 지켜짐) | `decision="forbidden"` | 실행 단위 하나라도 맞으면 `{ block: true }` |
| 파일 읽기 허용·거부 `g` | `Read(//<루트>/g)` | **표현 못 함** (아래 참고) | 확장이 `read` 호출의 실제 경로를 비교 |
| 파일 수정 허용·거부 `g` | `Edit(//<루트>/g)` (Write 포함) | **표현 못 함** | 확장이 `edit`·`write` 호출을 비교 |
| MCP 허용 `s / t` | `mcp__s__t` allow | 도구 `approval_mode` 값의 뜻이 확인되지 않아 **표현하지 않음**(권한 모드대로) | 확장이 `mcp__s__t`를 통과 |
| MCP 거부 `s / t` | `mcp__s__t` deny + werft egress 거절 | `mcp_servers.s.disabled_tools` + werft egress 거절 | `--exclude-tools mcp__s__t` + werft egress 거절 |

- **MCP 도구 이름 끝의 `*`.** Codex `disabled_tools`는 이름 목록이고, 지금 egress 판정도 정확한 이름과 서버 전체만 본다(`mcp-tool-decision.ts:9-15`). 그래서 두 곳을 이렇게 바꾼다.
  - egress: 판정에 "서버 id + 도구 이름 prefix"를 더한다. 서버 목록이 나중에 도구를 더해도 걸린다.
  - Codex·pi 설정: 세션이 고정한 도구 목록으로 정확한 이름을 펼쳐 넣는다. 펼친 뒤에 생긴 도구는 egress가 막는다.
  - 도구 목록을 읽지 못하면 그 서버를 세션에 붙이지 않는다.
- **pi의 묻기.** 확장이 승인 요청을 보냈는데 거절되거나, 시간이 지나거나, 연결이 끊기면 그 호출을 막는다.

- **Codex 파일 규칙.** Codex는 경로 규칙을 sandbox permission profile로만 받는다. werft는 Codex를 `auto` 외에는 sandbox 없이 컨테이너 안에서 돌린다(`packages/adapters/runtimes/codex/src/config.ts:29-50`). 그래서 v1에서는 표현 못 함으로 둔다. profile을 켜는 것은 Codex sandbox와 컨테이너 경계를 함께 다루는 별도 결정이다.
- **pi.** pi에는 묻는 단계가 없다. 그래서 내장 묻기 규칙과 `default` 권한 모드의 묻기를 지키려면, werft 확장이 그 호출을 werft 승인 요청으로 돌려야 한다. 이것은 pi를 엔진으로 붙이는 비용에 들어간다. pi를 붙일지는 스킬·MCP 설계 문서에서 판단한다.
- **MCP 거부.** 엔진 설정과 egress, 두 겹으로 막는다. 엔진 설정을 우회하는 경로(pi codemode 등)도 egress에서 막힌다.

### 표현 못 하는 규칙

| 경우 | 동작 | 화면 |
|---|---|---|
| 허용을 표현 못 함 | 그 규칙만 빠지고 그 호출은 권한 모드대로 간다. 허용이 없어질 뿐 넓어지지는 않는다 | 규칙 줄의 엔진 표시에 `Codex ?`. 툴팁: "이 엔진에서는 이 허용이 적용되지 않습니다" |
| 거부를 표현 못 함 | 그 엔진으로는 세션을 시작하거나 이어 가지 않는다(앞 절). 지금 Codex 어댑터가 deny를 받으면 거절하는 것과 같다 | 규칙 줄에 `Codex ⛔`. 그 규칙을 받는 에이전트가 그 엔진을 쓰면 에이전트 상세 위에 경고: "이 규칙 때문에 Codex로 실행할 수 없습니다" |
| 패턴이 공통 모양을 벗어남 | 저장하지 않는다 | 입력 줄 아래 이유. 예: "명령 패턴에는 `*`를 쓸 수 없습니다. 앞부분만 쓰세요" |

## 규칙 편집기 시안

목업 하나에 세 안이 다 있다. 워크스페이스·에이전트 범위와 Claude·Codex·pi 변환을 바꿔 볼 수 있다. 세 안 모두 같은 부분을 공유한다.

- 엔진이 받는 모양: Claude JSON, Codex `.rules`, pi 확장 입력
- 명령 판정기: 명령을 넣으면 어느 규칙이 맞는지 보인다
- 판단 순서

| 안 | 모양 | 워크스페이스·에이전트 | 좋은 점 | 아쉬운 점 |
|---|---|---|---|---|
| A. 표 + 규칙 추가 행 | 규칙 하나가 표의 한 줄(효과·대상·패턴·출처·엔진). 맨 아래 줄에서 추가 | 에이전트 화면에 물려받은 줄이 회색으로 같이 보인다. "물려받은 규칙 보기"로 접는다 | 가장 단순하다. 규칙이 늘어도 정렬·검색이 쉽다. 390px에서는 카드 줄로 바뀐다 | 대상별로 한눈에 보기는 B보다 약하다 |
| B. 대상별 묶음 | 명령·파일 읽기·파일 수정·MCP 묶음마다 허용과 거부를 칩으로 나란히 | 물려받은 칩은 점선 | 대상별 상태가 한눈에 보인다. 엔진 미지원 표시를 묶음 머리에 한 번만 한다 | 묶음 네 개라 화면이 길다. 묶음마다 추가 줄이 있다 |
| C. 프리셋 + 직접 규칙 | 자주 쓰는 묶음을 스위치로, 나머지를 직접 추가 | 스위치마다 "워크스페이스 값 / 이 에이전트에서 바꿈" | 처음 쓰는 사람에게 가장 쉽다 | 프리셋 목록을 werft가 관리해야 한다. 스위치는 에이전트에서 워크스페이스 값을 끄는 덮어쓰기라 위의 합치기 규칙과 어긋난다 |

**추천: A.** 오너 요구("한 줄씩 추가", "예전 것보다 간결하게")에 가장 그대로 맞는다. 덮어쓰기 없이 합치기만 있어 판단 순서가 화면에서 바로 읽힌다.
- B의 "묶음 머리의 엔진 표시"는 A의 대상 필터로 가져올 수 있다.
- C의 프리셋은 나중에 A의 "추가" 메뉴 안 "자주 쓰는 규칙에서 고르기"로 붙일 수 있다. 고르면 규칙 줄이 들어가므로 덮어쓰기가 생기지 않는다.

**자리.** 워크스페이스는 설정 › 워크스페이스 아래 "실행 규칙"이다(MCP 서버·실행 한도와 같은 줄). 에이전트는 상세의 "실행 규칙" 탭이다(`AGENT_TABS`, `apps/web/src/routes/agent-detail/navigation.ts:4-12`).
- 쓰기 권한은 지운 화면과 같다. 워크스페이스는 소유자·관리자, 에이전트는 에이전트 관리자다.
- 저장할 때마다 receipt를 남긴다.

## 지시문

### 모델

- 조직 지시문: 워크스페이스에 하나. 워크스페이스 설정 페이지의 카드로 둔다. 모든 에이전트의 모든 세션이 받고, 에이전트가 끌 수 없다.
- 에이전트 지시문: 에이전트에 하나. 에이전트 상세에서 쓴다.
- 저장소 지시 파일: 지금처럼 세션이 연 저장소 루트의 파일.

세션이 받는 글은 이 순서로 잇는다. 머리말로 출처를 밝힌다(지금 저장소 파일에 붙이는 머리말과 같은 방식).

```
Organization instructions set by this workspace's administrators:
<조직 지시문>

Agent instructions set by this agent's administrators:
<에이전트 지시문>

Contents of the instruction file (AGENTS.md, else CLAUDE.md) at the root of the repository ...:
<저장소 파일>
```

- 순서는 넓은 것에서 좁은 것이다. 뒤의 글은 앞의 글을 구체화한다(이 저장소의 테스트 명령, 이 에이전트의 릴리스 절차).
- **순서는 우선권이 아니다.** 세 엔진 모두 글을 이어 붙일 뿐이고, 겹 사이의 권한을 집행하지 않는다. 조직 지시문의 머리말에 "아래 글과 충돌하면 이 글을 따른다"를 넣는다. 저장소 파일은 저장소에 쓸 수 있는 누구나 고칠 수 있는 글이므로, 머리말에서 출처를 밝힌다(지금과 같다). 반드시 지켜야 하는 것은 지시문이 아니라 실행 규칙으로 둔다. 편집기 설명에도 이렇게 쓴다.
- 비어 있는 겹은 머리말째 빠진다.

### 엔진에 넣는 방식

| 엔진 | 조직·에이전트 지시문 | 저장소 파일 |
|---|---|---|
| Claude | `systemPromptAppend`에 위 순서로 | 지금과 같음(`AGENTS.md`, 없으면 `CLAUDE.md`) |
| Codex | `developer_instructions`에 위 순서로 | **`AGENTS.md`, 없으면 `CLAUDE.md`로 바꾼다** (지금은 `AGENTS.md`만) |
| pi (붙인다면) | `--no-context-files` + `--append-system-prompt` | 같은 규칙 |

- **파일 이름을 고르는 화면은 없다.** werft는 세 엔진 모두 엔진이 지시 파일을 직접 읽지 못하게 막는다. 그리고 글을 프롬프트로 넣는다. 그래서 엔진이 CLAUDE.md를 읽는지 AGENTS.md를 읽는지는 결과에 영향이 없다. Agent SDK가 AGENTS.md를 읽는지 확인되지 않은 것도 같은 이유로 문제가 되지 않는다.
- **저장소 파일 규칙을 하나로.** Codex만 `CLAUDE.md`를 못 받는 차이를 없앤다. `AGENTS.md` 우선은 Codex·pi의 순서와 같다. Claude Code가 로컬에서 고르는 순서와는 반대다(Claude Code는 `CLAUDE.md`가 있으면 `AGENTS.md`를 읽지 않는다). 두 파일이 다 있는 저장소에서 로컬과 werft가 다른 파일을 쓸 수 있다는 뜻이므로, 저장소 겹의 설명에 쓴다.
- **작업 디렉터리의 파일.** worker가 두는 `AGENTS.md`(+ `CLAUDE.md` 링크)에는 조직·에이전트 지시문을 이은 글을 넣는다. 이 파일은 저장소가 두 이름을 모두 쓰지 않을 때만 생기고, 저장소 지시는 들어 있지 않다. 그러니 "세션 안의 다른 도구를 위한 플랫폼 지시문 사본"일 뿐이다. 세션이 실제로 받은 글은 세션 snapshot에서 보여 준다.
- **크기.** 조직·에이전트 겹은 각각 32 KiB(제안). Codex가 저장소 지시에 쓰는 기본 예산과 같은 크기다. 넘으면 저장을 거절한다. 저장소 파일은 저장 API가 없으므로 claim 때 32 KiB에서 자르고, 잘랐다는 한 줄을 붙인다. 자르기는 새 세션부터다. snapshot이 없는 옛 세션은 지금처럼 파일을 통째로 읽고 합쳐 지문을 유지한다(Codex는 합친 developer instructions를 지문에 넣는다, `codex/src/config.ts:424-425`).
- **checkpoint.** 지시문은 세션 시작 때 snapshot으로 남기고, 그 세션의 모든 claim·재개에 그 snapshot을 넣는다. 지금 구현은 이 글을 지문에 넣는다. Claude는 `appendSystemPrompt`를(`packages/adapters/runtimes/claude/src/profile-fingerprint.ts:82`), Codex는 합친 developer instructions를(`packages/adapters/runtimes/codex/src/config.ts:424-425`) 넣는다. snapshot이 세션 안에서 바뀌지 않으므로 지문도 바뀌지 않는다. 설정에서 문장을 고쳐도 진행 중인 세션의 checkpoint는 그대로 재개된다. 새 세션만 새 글과 새 지문을 받는다.
  - 대화 압축 뒤에도 같은 글이 실려야 한다. Claude는 압축 뒤 그 run의 설정을 쓰므로(`packages/adapters/runtimes/claude/src/config.ts:120-127`) snapshot을 넣으면 같은 글이 된다.
  - 옛 세션(snapshot이 없는 세션)은 조직·에이전트 겹 없이 재개한다. 플랫폼 지시문과 저장소 파일은 지금 방식 그대로 넣어 지금 지문을 유지한다.
  - 복구 검증 도구(`scripts/lib/checkpoint-pins.ts`)도 snapshot을 읽어 지문을 다시 만들게 고친다.
  - pi를 붙인다면 재개 의미를 따로 확인한다.
- **worker 호환과 활성화 조건.** 규칙과 지시문은 각각 worker capability(`run_rules`, `instructions`)로 알린다. 지운 `engine_settings` capability와 같은 방식이다.
  - 서버는 그 capability를 알린 worker에만 값을 싣는다. 값이 없는 claim에는 필드를 싣지 않는다([worker 호환](worker-compat.md)).
  - 규칙이 있는 세션을 받을 capable worker가 없으면, 규칙을 빼고 보내지 않고 claim을 거절한다. 거부를 잃은 채로 실행하지 않는다.
  - 지시문만 있고 capable worker가 없으면 지시문 없이 돌리지 않고 기다린다. 지시문이 빠진 실행은 동작이 달라지기 때문이다.
  - 새 필드는 strict 계약에 선택 필드로 먼저 배포한다(expand). capability는 어댑터가 규칙과 지시문을 실제로 집행하는 이미지에서 처음 알린다. 롤백 하한은 그 이미지다.

### 화면 시안

| 안 | 모양 | 좋은 점 | 아쉬운 점 |
|---|---|---|---|
| A. 설정 카드 + 나란히 미리보기 | 워크스페이스 설정 페이지에 "조직 지시문" 카드. 편집기와 미리보기를 좌우로(좁은 화면은 편집/미리보기 전환). 에이전트 지시문은 상세 설정 안 같은 편집기 | 메뉴가 늘지 않는다. 오너가 가리킨 워크스페이스 설정 페이지 그대로 | 에이전트 쪽에서 합쳐진 결과를 보기 어렵다 |
| B. 에이전트 탭 + 겹 보기 | 에이전트 상세에 "지시문" 탭. 조직 → 에이전트 → 저장소 세 겹과 편집/미리보기/합친 결과 탭 | 세션이 받는 글을 그대로 확인한다 | 탭이 하나 는다 |

**추천.** 조직 지시문은 A의 카드로 둔다. 에이전트 지시문은 상세 설정 안에 A의 편집기를 두되, B의 "합친 결과" 보기를 더한다. 탭은 늘리지 않는다.

**편집기.** 지금 웹·UI 패키지에는 마크다운 렌더러도 코드 편집기도 없다(`packages/ui/package.json` 의존성).
- v1 편집기: 고정폭 `textarea` + 줄 번호 + 서식 버튼 몇 개(제목·굵게·코드·목록·코드 블록). 코드 편집기(CodeMirror 등)는 쓰는 모습을 본 뒤에 정한다.
- 미리보기: 렌더러로 의존성이 늘어난다. `react-markdown` 하나, 표·체크 목록이 필요하면 `remark-gfm`까지 둘이다. 지시문은 관리자가 쓰지만 다른 구성원의 브라우저에서도 렌더되므로, 스크립트가 들어갈 길을 두지 않는다. 구성 조건을 고정하고 회귀 시험을 둔다.
  - 날 HTML은 렌더하지 않는다(`rehype-raw` 금지, `skipHtml`).
  - 기본 `urlTransform`을 유지한다(`javascript:` 등 제거).
  - 플러그인은 `remark-gfm`만 쓴다. HTML을 그대로 넣는 커스텀 컴포넌트는 쓰지 않는다.
  - 외부 이미지는 불러오지 않고 링크로 보인다. 미리보기를 연 사람이 추적되지 않게 하려는 것이다.
  - 의존성 추가는 구현 PR에서 따로 승인받는다.

## werft 아키텍처 적용

[패키지 구조](package-structure.md)의 원칙을 따른다. 플랫폼 도메인은 디렉터리 하나다. 포트는 그 포트를 부르는 도메인이 갖는다. contracts에는 데이터와 스키마만 둔다. db는 같은 도메인 이름으로 나눈다.

| 자리 | 하는 일 |
|---|---|
| `packages/contracts/src/shared/run-rules.ts`(새 파일) | 규칙과 지시문의 zod 스키마. 패턴 문법 검사(앞의 "패턴"과 "사고에서 가져오는 규칙"), 개수·길이·32 KiB 한도. 웹과 서버가 같은 검사를 쓴다 |
| `packages/contracts/src/worker-protocol` | capability `run_rules`·`instructions`(`workerCapabilitiesSchema`, `index.ts:114-126`)와 claim의 선택 필드. 필드에는 엔진 중립 규칙 목록, 그 digest, 이어 붙일 지시문 겹을 싣는다. 엔진 문법은 싣지 않는다 |
| `packages/platform/src/run-rules/`(새 도메인) | `ports/`: 규칙·지시문 저장소 포트. `policy/`: 합치기, 판정 순서, 엔진 표현 능력 검사(순수 함수). `service/`: 저장(receipt 포함), 세션 snapshot 만들기, claim에 싣기 |
| `packages/db/src/run-rules/` | 포트 구현. 표 `workspace_run_rules`, `agent_run_rules`, 지시문 표 둘, 워크스페이스의 "에이전트 허용 위임" 값, 세션 snapshot 칸 |
| 코덱 descriptor(`packages/adapters/runtimes/{claude,codex}-codec/src/descriptor.ts`) | 엔진마다 어떤 대상·효과를 표현하는지 선언한다. platform의 표현 능력 검사가 이것을 읽는다. 엔진 이름으로 분기하는 코드를 platform에 두지 않는다 |
| 런타임 어댑터(`packages/adapters/runtimes/{claude,codex}`) | 엔진 중립 규칙을 엔진 설정으로 바꾼다. 지시문 겹을 엔진 입력에 넣는다. 엔진 거부를 `deny` 관측으로 내보낸다 |
| `apps/worker` | 값을 그대로 어댑터에 넘기고 capability를 알린다. 판정하지 않는다 |
| egress(`packages/platform/src/workers/mcp-egress.ts`, `workspace-mcp-egress.ts`) | MCP 도구 판정을 한 함수로 합친다. 도구 이름 prefix를 판정에 더한다. 통합 접근 판정이 생기면 그 판정 호출의 한 입력이 된다 |
| `apps/control-host` API, `apps/web` | 저장 API(새 경로는 `packages/core/src/schemas/responses.ts` 응답 표에 더한다), 워크스페이스 설정 화면, 에이전트 상세 화면 |

**통합 접근 판정과의 접점.** MCP 호출은 egress에서 접근 판정과 같은 호출로 판정한다(앞 절). 명령·파일 규칙은 엔진이 판정한다. 그래서 `run-rules/`는 접근 판정 도메인에 의존하지 않는다. 판정 기록 형식(주체·대상·근거 규칙·결과)만 공유한다. 접근 판정 도메인이 기록 포트를 먼저 만들면 그것을 쓰고, 아니면 `run-rules/`가 같은 형식으로 시작하고 나중에 옮긴다.

**검토한 다른 구조**

| 안 | 고르지 않은 이유 |
|---|---|
| platform에서 엔진 문법으로 바꿔 worker에 보낸다 | 엔진 차이가 platform으로 샌다. 이미지마다 엔진 버전이 다르면 문법도 달라질 수 있다. 바꾸기는 엔진을 아는 어댑터가 한다 |
| 모든 도구 호출을 hook으로 서버에 물어 판정한다(중앙 판정점) | 호출마다 왕복이 생기고, 서버가 멈추면 세션이 멈춘다. Claude `auto`와 `trustedTools`는 hook을 건너뛰는 경로가 있다. 이미 서버를 거치는 MCP만 중앙에서 판정한다 |
| 규칙을 에이전트 카드·릴리스에 고정한다 | 워크스페이스 기본과 합치는 모델과 맞지 않는다. 좁히는 변경이 다음 릴리스까지 기다린다 |
| Cedar·OPA 같은 정책 언어를 사용자에게 보인다 | 오너 요구가 "한 줄씩 추가"다. 판정 대상이 넷이고 효과가 둘이라 표 하나로 충분하다. 통합 접근 판정이 정책 엔진을 쓰게 되면, 이 규칙은 그 엔진의 입력 데이터가 될 수 있다 |
| 옛 `*_engine_settings` 표를 고쳐 쓴다 | 엔진 문법 문자열을 담는 표라 모양이 다르다. 새 표를 만들고, 옛 표는 별도 정리 결정까지 그대로 둔다 |

## 스킬·MCP 설계와 맞물리는 곳

- **MCP 도구 대상의 이름.** 규칙의 MCP 서버는 워크스페이스에 등록한 서버 목록에서 고른다(자유 입력이 아니다). 그래서 스킬·MCP 설계의 서버 식별자를 그대로 쓴다. 서버 이름이 바뀌어도 규칙은 서버 id를 따라간다.
- **MCP 거부의 집행.** egress의 호출별 판정은 엔진과 상관없다. 그래서 그 설계의 "엔진 중립" 원칙과 같은 자리에 둔다. 릴리스 MCP deny 핀과 사용자 거부 규칙은 한 판정 함수에서 합친다.
- **통합 접근 판정과의 관계.** 오너는 2026-11-20에 메모리 범위, MCP 인증정보, 에이전트 답변 권한을 하나의 접근 판정 모델로 판정하기로 했다. 모델의 입력은 주체(요청자, 에이전트, 팀 소속), 대상, 맥락(비공개 세션, DM, 공개 채널)이다. 결과는 허용 또는 거부이고, 모두 감사에 남긴다. 실행 규칙은 이 모델을 새로 설계하지 않고 다음처럼 놓는다.
  - **MCP 도구 호출은 한 진입점에서 판정한다.** egress의 `tools/call` 판정이 이미 호출마다 서버를 거친다. 그 자리에서 접근 판정(어느 인증정보로 부를지)과 실행 규칙의 MCP 거부를 한 판정 호출로 묶고, 결과는 한 번만 기록한다. 이것은 지금 감사 경로를 바꾸는 일이다.
    - 지금 설치 카탈로그 경로는 인증정보 관련 거부 일부만 기록하고, 도구 거부와 허용은 기록 없이 돌려준다(`packages/platform/src/workers/mcp-egress.ts:117`, `:159-168`).
    - 워크스페이스 MCP 경로는 허용 호출을 따로 기록한다(`packages/platform/src/workers/workspace-mcp-egress.ts:137`).
    - 합칠 때는 두 경로가 같은 판정 함수와 같은 기록 한 줄을 쓴다. 열린 스트림의 재판정(`regrant`)은 같은 호출의 재확인으로 묶어, 거부로 바뀔 때만 새 줄을 남긴다.
  - **명령·파일 규칙은 진입점을 공유하지 않는다.** 이 규칙은 claim 때 엔진 설정으로 바뀌고, 호출마다 엔진(pi는 werft 확장)이 판정한다. 그래서 호출마다 서버의 판정 API를 부르는 구조가 아니다. 공유하는 것은 판정 기록의 형식이다. claim 때 합친 규칙과 세션 snapshot을 같은 감사 레코드(주체·대상·근거 규칙·결과)로 남긴다. 엔진이 거부한 호출을 남기는 길은 **지금 없다.**
    - Claude 어댑터는 엔진 거부(`PermissionDenied`)를 받으면 대기 항목을 지울 뿐 관측을 내보내지 않는다(`packages/adapters/runtimes/claude/src/runtime.ts:250-256`, `:447`, `tool-decisions.ts:68-70`).
    - 관측 계약에는 맞은 규칙을 담는 칸이 없다(`packages/runtime-core/src/tool-decision.ts:8-25`).
    - 구현 계획(4단계)에 둘을 넣는다. 첫째, 엔진 거부를 `decision: "deny"`로 내보낸다. 둘째, 관측에 근거 규칙(공통 규칙 id 또는 "내장 규칙")을 담는 선택 칸을 더한다.
    - 엔진이 어느 규칙에 걸렸는지 알려 주지 않을 때(Claude·Codex 모두 거부 사유만 준다)는 werft가 같은 호출을 snapshot 규칙에 다시 맞춰 근거를 채운다. 그래도 못 찾으면 "엔진 거부, 근거 미상"으로 남긴다.
  - **규칙을 고칠 수 있는 사람**(워크스페이스 소유자·관리자, 에이전트 관리자)은 지금의 RBAC가 판정한다. 이것은 접근 판정 모델의 대상이 아니다.
- **스킬.** 스킬은 규칙 대상이 아니다. 스킬이 실행하는 스크립트는 명령이므로 명령 규칙을 그대로 받는다. 지시문은 항상 실리는 글이고, 스킬은 필요할 때 불러오는 글이다. 조직 지시문에 스킬 본문을 붙여 넣지 말라는 안내를 편집기 설명에 둔다.
- **pi.** 이 문서는 pi를 세 번째 엔진으로 가정하고 변환을 적었다. 붙일지와 비용은 스킬·MCP 설계 문서가 정한다. 붙인다면 이 문서의 pi 열이 확장의 요구 사항이 된다. 권한 판정, 묻기를 werft 승인으로 돌리기, `--no-context-files`가 그 내용이다.

## 고르지 않은 것

- **엔진별 규칙 화면.** 오너가 "파일명이나 에이전트 종류에 따라 화면 설정 방식이 달라지면 번거롭다"고 했다. 규칙과 지시문 모두 화면 하나에 공통 모델을 둔다.
- **묻기(ask) 효과.** 오너 지시는 허용·거부부터다. 맞지 않는 호출은 권한 모드대로 가고(`default`에서는 대개 묻는다), 묻기 규칙은 "허용 안에서 일부를 다시 묻게"하거나 `auto`에서도 꼭 묻게 할 때 필요하다. 그 수요가 보이면 효과에 `ask`를 더한다. 모델은 그것을 막지 않는다.
- **엔진 문법 그대로 쓰기(고급 모드).** 지운 화면이 이 방식이었다. 엔진마다 다른 문법이 화면에 드러나고, Codex가 받지 못했다.
- **에이전트 지시문을 카드·릴리스에 고정.** 앞선 마법사 설계는 카드에 두고 릴리스로 고정했다. 이 문서는 조직 지시문과 같은 "설정 + 세션 시작 snapshot"을 추천한다. 두 겹이 같은 규칙으로 바뀌어야 화면 설명이 하나로 끝난다. 릴리스 고정이 필요하다는 판단이면 에이전트 겹만 카드로 옮길 수 있다. **오너 결정 필요.**

## 오너가 고를 것

1. 규칙 편집기: A(추천) / B / C
2. 지시문 화면: A 카드 + 합친 결과 보기(추천) / B 탭
3. 에이전트 지시문을 설정(추천)으로 둘지 카드·릴리스로 고정할지
4. 미리보기를 위한 마크다운 렌더러 의존성 추가(`react-markdown`, 필요하면 `remark-gfm`)
5. 워크스페이스 설정 "에이전트 관리자가 허용을 더할 수 있음": 둔다·기본 켬(추천) / 두지 않음(에이전트는 늘 허용을 더할 수 있다)

## 단계별 구현 계획

오너가 위 다섯 가지를 고른 뒤에 시작한다. 단계마다 PR 하나나 둘이다. 앞 단계가 끝나야 다음 단계를 시작한다(괄호는 막는 단계). 화면에 보이는 변화는 9단계에서 처음 생긴다. 그 전 단계는 값이 없으면 지금과 똑같이 동작한다.

| 단계 | 내용 | 끝났다고 보는 조건 |
|---|---|---|
| 1. 계약과 저장소 | `shared/run-rules.ts` 스키마와 패턴 검사. `run-rules/` 도메인의 포트와 `policy/`(합치기·판정 순서·표현 능력). db 표와 migration, 포트 구현. 옛 `*_engine_settings` 표는 건드리지 않는다 | 패턴 검사 시험이 사고 사례(`export X=… && git …`, 명령 치환, `..`, 서버 이름 `*`)를 거절한다. 판정 순서 시험이 "내장 허용이 사용자 거부를 이기지 않음"을 보인다. db integration 시험 통과 |
| 2. 저장 API와 권한 (1) | 워크스페이스·에이전트 규칙과 지시문의 읽기·저장 API, receipt, 소유자·관리자·에이전트 관리자 RBAC, "에이전트 허용 위임" 값. 응답 표와 OpenAPI | 권한 없는 사람의 저장이 거절되는 시험. 위임을 끄면 에이전트 허용 저장이 거절되는 시험. receipt가 남는다 |
| 3. worker 계약 expand (1) | capability 이름 `run_rules`·`instructions`와 claim 선택 필드를 strict 계약에 더한다. worker는 받은 값을 어댑터까지 넘긴다. 이 단계의 worker는 capability를 **알리지 않는다** | strict 계약 시험 통과. 값이 없는 claim의 바이트가 지금과 같다. 이 이미지는 capability를 보내지 않는다는 시험 |
| 4. Claude 어댑터 (3) | flag settings allow·deny 변환, 루트 고정 경로, 지시문 겹 이어 붙이기, 엔진 거부를 `deny` 관측으로, 관측의 근거 규칙 칸 | `bypassPermissions`에서도 거부가 지켜지는 시험. 규칙·지시문이 비면 프로필 지문이 지금과 같은 golden 시험. 압축 뒤에도 같은 지시문이 실리는 시험 |
| 5. Codex 어댑터 (3) | `.rules` allow·forbidden, 원본 내장 묻기와 겹치는 허용 빼기, 펼친 `disabled_tools`, deny 거절 조건 갱신, 저장소 파일 `CLAUDE.md` fallback, 32 KiB 자르기(새 세션만) | 실제 Codex 바이너리의 `execpolicy check`로 변환 결과를 확인하는 시험. 옛 세션의 지문이 바뀌지 않는 시험 |
| 6. worker capability 알리기 (4, 5) | 두 어댑터가 들어간 이미지에서 처음으로 `run_rules`·`instructions`를 알린다. 이 이미지가 롤백 하한이 된다 | 이 이미지로 Claude·Codex 세션 모두 받은 거부를 지키는 시험(worker를 거쳐 어댑터까지). 3단계 이미지는 capability를 보내지 않아 규칙이 실리지 않는다 |
| 7. 플랫폼에서 켜기: snapshot과 claim (2, 6, 8) | 합치기(위임이 꺼지면 에이전트 허용 빼기 포함), 세션 snapshot·digest, capable worker에만 싣기와 없을 때 claim 거절, claim·재개 때 표현 능력 검사, `checkpoint-pins.ts`가 snapshot으로 지문 만들기 | 넓히는 변경은 진행 중인 세션에 걸리지 않고 새 세션에만 걸리는 시험. 좁히는 변경(위임 끄기 포함)은 다음 claim부터 걸리는 시험. 설정을 고친 뒤 재개한 세션이 snapshot의 지시문과 같은 지문을 쓰는 시험. 표현 못 하는 거부가 진행 중에 생기면 다음 claim이 이유와 함께 멈추는 시험. capable worker가 없으면 거부를 잃고 실행하지 않는 시험 |
| 8. egress MCP 판정 합치기 (2) | egress MCP 판정에 사용자 거부와 도구 이름 prefix를 더한다. 두 egress 경로의 판정·기록을 한 함수와 한 줄로 합친다 | MCP 거부를 저장하면 진행 중인 세션의 다음 호출부터 막히는 시험. prefix 거부가 나중에 더해진 도구에도 걸리는 시험. 호출 하나가 기록 한 줄만 남기는 시험. `regrant`는 거부로 바뀔 때만 새 줄을 남기는 시험 |
| 9. 화면 (7, 8) | 규칙 편집기(고른 안), 조직 지시문 카드, 에이전트 지시문과 합친 결과 보기, 미리보기(의존성 승인 뒤), 위임 스위치와 "위임이 꺼져 적용되지 않음" 표시, i18n(ko·en·ja) | PR에 390px·1280px 전후 화면. 접근성 검사. 저장 안내가 "언제 적용되나" 표와 같은 문장이다 |
| 10. 사용자 문서와 실제 확인 (9) | 사용 문서. 로컬 스택에서 Claude·Codex 세션으로 허용·거부와 지시문을 확인 | 실제 세션에서 거부된 명령, 기록 줄, 세션이 받은 지시문을 PR에 붙인다 |

- 8단계는 2단계 뒤라면 3~6단계와 따로 진행할 수 있다. 7단계는 8단계를 기다린다. 사용자 MCP 거부는 `trustedTools`와 세션 뒤에 생긴 도구까지 egress가 막는다는 보장을 전제로 하므로, egress 집행 없이 규칙을 켜지 않는다. 통합 접근 판정의 판정 호출이 먼저 생기면 그 위에 얹는다. 그 일정이 늦으면 MCP 판정만 지금 함수에서 합치고, 접근 판정이 생길 때 옮긴다. 어느 쪽이든 8단계를 막지 않는다.
- pi는 이 계획에 넣지 않는다. 스킬·MCP 설계가 pi를 붙이기로 하면, 이 문서의 pi 열을 요구 사항으로 하는 단계를 그때 더한다.
