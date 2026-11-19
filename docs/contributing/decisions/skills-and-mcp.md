# 결정(설계): 스킬과 MCP 서버, 두 개념으로 엔진에 상관없이 등록·지정한다

- 상태: 설계. 코드는 바꾸지 않는다. 구현 단위는 [9절](#9-구현-단위)에 있다.
- 기준 커밋: `origin/main` `20d42022d`. `파일:줄`은 이 커밋에서 읽었다.
- 조사 근거: [조사: 엔진과 관리 콘솔이 스킬·MCP·플러그인을 다루는 방법](skills-and-mcp-research.md). 이 문서에서 바깥 제품을 말할 때는 그 조사의 절을 가리킨다.
- 관련 결정: [워크스페이스 원격 MCP 서버](mcp-credentials.md), [번들 stdio MCP 서버를 worker relay 뒤에 둔다](stdio-mcp-relay.md), [Agent SDK 버전](agent-sdk.md), [에이전트 담당 팀과 액션 RBAC](agent-rbac.md), [엔진별 worker 이미지](engine-worker-images.md).
- 티켓 번호: 저장소의 마크다운은 티켓 번호를 적지 못한다(`tests/docs-links.test.ts`). 번호는 이 문서를 들인 PR 본문에 있다.

## 요약

| 항목 | 결론 |
|---|---|
| 개념 | 조직이 엔진에 주는 것은 **스킬**과 **MCP 서버** 둘뿐이다. "플러그인"이라는 개념은 두지 않는다. 플러그인은 엔진마다 형식이 다르고(Claude `.claude-plugin/plugin.json`, Codex `plugin.json`, pi 패키지) 훅·명령·서브에이전트처럼 엔진 하나에만 뜻이 있는 것을 함께 싣기 때문이다 |
| 스킬 | [Agent Skills 사양](https://agentskills.io/specification)의 `SKILL.md` 디렉터리 하나가 단위다. 세 엔진 모두 이 형식을 읽는다(조사 1-6.1, 2-1.2, 2-2.6). 등록은 업로드 또는 Git(커밋 고정), 버전은 내용 digest |
| MCP 서버 | 지금의 워크스페이스 원격 MCP 서버([mcp-credentials.md](mcp-credentials.md))를 그대로 쓴다. 엔진은 어느 쪽이든 플랫폼의 relay만 보고, 자격은 egress가 붙인다 |
| 지정 | 워크스페이스 → 에이전트 → 세션 범위를 `required` / `optional` / `forbidden`으로 접는 지금의 해석기(`packages/platform/src/extensions/resolve.ts`)를 스킬에 그대로 쓴다. 바깥 범위는 안쪽을 좁히기만 한다 |
| 버전 고정과 배포 | 지정 행이 digest 하나를 가리킨다. 세션은 시작할 때 고른 digest를 `sessions.extensions`에 고정한다. 새 버전은 승인 → 에이전트 하나에 지정 → 워크스페이스 지정 교체 순으로 넓힌다 |
| 엔진 매핑 | 어댑터가 세션 작업 공간에 엔진이 읽는 자리로 펼친다. Claude는 지금처럼 스킬마다 로컬 plugin 하나(체크포인트 호환), Codex는 세션 스킬 루트, pi는 세션 전용 agent dir의 `skills/`. 엔진의 다른 탐색 경로는 닫고, 엔진이 보고한 스킬 집합이 기대와 정확히 같아야 시작한다. MCP는 셋 다 플랫폼 relay 주소 하나씩 |
| 데이터 접근 | 오너 결정(2026-11-20)대로 규칙 기반 접근 정책 하나를 실행 규칙 위에 둔다. 요청자(사람·없음), 에이전트, MCP 서버·도구, 세션에 켜진 스킬로 MCP 호출마다 허용 여부와 연결 종류(에이전트 연결 / 요청자 개인 연결)를 정한다. 판정 입력은 플랫폼 상태에서만 읽고 자기 신고 헤더는 받지 않는다. 공개 범위는 지금 에이전트 권한 관리가, 감사는 도구 사용 로그가, 사용량·비용은 지금 장부가 맡는다([6절](#6-mcp-자격과-데이터-접근-정책)) |
| 권한과 기록 | 등록·승인은 워크스페이스 관리자, 에이전트 범위 지정은 에이전트 관리자. 카탈로그는 구성원 누구나 보지만 "어느 에이전트에 지정됐나"는 그 에이전트를 볼 수 있는 사람에게만 보인다. 모든 변경은 지금의 receipt(`register_extension`, `attach_extension` 등)로 남고, 세션은 무엇을 썼는지 digest로 남긴다 |
| 콘솔 | 워크스페이스 설정의 "에이전트 연결" 묶음에 **스킬**을 **MCP 서버** 옆에 둔다. 에이전트 상세의 "접근" 탭에 스킬 칸을 MCP 칸 옆에 둔다 |
| pi | 세 번째 엔진으로 붙일 가치는 있다(MIT, SDK·RPC 임베딩, 스킬·MCP 내장, 공급자 30종 이상). 다만 내장 권한·샌드박스가 없어 플랫폼이 승인 경로를 확장으로 새로 만들어야 한다. **추천: 지금은 구현하지 않고, 스파이크 하나로 승인 게이트와 체크포인트가 붙는지만 확인한다.** Oh My Pi는 엔진으로 쓰지 않는다([8절](#8-pi-coding-agent를-세-번째-엔진으로)) |

## 1. 지금 있는 것

**스킬 쪽: "확장 번들".** 이름은 확장이지만 내용은 스킬만 받는다.

- 등록 검사: 업로드한 트리를 버리고 허용 목록으로 다시 만든 트리만 해시·저장한다. `hooks/`, `.mcp.json`, `bin/`, `agents/`, `commands/`, `settings*.json`은 경로째 거절한다(`packages/platform/src/extensions/bundle-validator.ts:9-17`, `:104-117`). 한 번들은 slug 하나 아래 스킬 여러 개를 담는다(`BundleManifest.skills`, `:64-69`).
- 저장: `extension_bundles`(digest, `source` `upload`|`github`, `review` `pending`|`approved`|`rejected`, 등록·승인한 사람)와 `extension_attachments`(범위 `workspace`|`agent`, `mode`)다(migration `0247`, `0251`). 객체는 `workspaces/<id>/bundles/<digest>.tar`(`bundle-service.ts:37-50`).
- 해석: 범위를 바깥부터 접는다. `required`는 안쪽이 빼거나 버전을 바꿀 수 없고, `forbidden`은 되살릴 수 없고, `optional`은 세션이 켤 때만 켜진다(`resolve.ts:70-200`). 엔진이 스킬을 못 하면 `feature_unsupported`, 도구 목록에 `Skill`이 없으면 `skill_tool_not_allowed`로 거절한다(`resolve.ts:207-223`).
- 기록: 승인과 지정·해제는 같은 transaction에서 receipt를 쓴다(`ports/extension-bundle-store.ts:102-121`).
- **빈 곳.** 등록·승인·지정 서비스는 있지만 HTTP 경로와 콘솔 화면이 없다. control-host가 쓰는 것은 archive 읽기뿐이다(`apps/control-host/src/api/checkpoints.ts:312-328`).

**엔진 쪽.**

- Claude: claim의 `extensions`를 로컬 plugin 경로로 넘기고 digest를 identity로 둔다(`packages/adapters/runtimes/claude/src/contract.ts:130-140`). 시작할 때 엔진이 `<slug>:<skill>`을 모두 보고했는지 확인한다(`plugin-skills.ts`).
- Codex: 번들과 관리자가 등록한 MCP 서버를 둘 다 거절한다(`packages/adapters/runtimes/codex/src/config.ts:179-181`). 엔진 표의 `skills`가 `none`이다(`packages/adapters/runtimes/codex-codec/src/descriptor.ts:37`). 플러그인·스킬 검색·스킬 MCP 설치 기능은 꺼 둔다(`config.ts:307-315`).

**MCP 쪽.** 설치 카탈로그 서버(`mcp_servers`, `agent_mcp_settings`)와 워크스페이스 서버(`workspace_mcp_servers`, `agent_workspace_mcp_servers`, migration `0286`, `0287`)가 있고, 콘솔에 "워크스페이스 설정 > MCP 서버"와 에이전트 "접근" 탭이 있다(`apps/web/src/routes/workspace-mcp-servers.tsx`, `agent-detail/workspace-mcp.tsx`). 엔진에는 relay만 보인다: Claude는 `type: "sdk"` in-process 서버(`claude/src/remote-mcp.ts`), Codex는 이 프로세스의 loopback relay와 `enabled_tools`(`codex/src/config.ts:325-342`, `mcp-relay.ts`). 토큰은 egress proxy가 붙인다.

정리하면, 모델과 판정은 거의 다 있다. 없는 것은 (1) 스킬의 엔진 중립 단위와 Codex·pi 매핑, (2) Codex의 워크스페이스 MCP, (3) 스킬의 API·콘솔이다.

## 2. 두 개념

### 스킬

**결정.** 스킬 하나 = `SKILL.md`를 가진 디렉터리 하나. 이름은 frontmatter `name`이고 워크스페이스 안에서 유일하다. 사양 밖의 엔진 전용 파일(Codex `agents/openai.yaml`, Claude plugin manifest)은 받지 않는다.

- **지금 번들과의 관계.** 저장·해석·receipt는 그대로 쓰고, 등록 단위만 "스킬 하나"로 좁힌다. 새 등록은 스킬이 정확히 하나인 번들이고 slug = 스킬 이름이다. 새 스킬 이름은 기존 번들의 slug와도 겹치지 못한다(엔진 이름이 겹치지 않게 하는 조건, [5절](#5-엔진-매핑)). 이미 있는 여러 스킬 번들(옛 번들)은 지금 모습 그대로 Claude에서만 계속 돌고, 새로 만들지 못한다. Codex·pi에는 옛 번들을 주지 않는다(`feature_unsupported`). 테이블 이름(`extension_*`)은 바꾸지 않는다. 바꾸는 비용(migration, 혼합 버전 worker 호환)에 비해 얻는 것이 화면의 낱말뿐이라, API와 콘솔에서만 "스킬"이라 부른다.
- **왜 하나씩인가.** 엔진마다 스킬 이름공간이 다르다. Claude는 plugin 이름을 붙여 `<plugin>:<skill>`로, Codex와 pi는 이름만으로 부른다(조사 1-6.1, 2-1.2, 2-2.6). 스킬 하나가 단위이고 이름이 워크스페이스에서 유일하면, 어느 엔진에서든 이름 하나로 겹침 없이 펼칠 수 있다. 여러 스킬을 한 번에 배포하는 편의는 콘솔의 "여러 개 업로드"로 준다.
- **부르는 조건은 엔진이 알린다.** 지금 해석기는 스킬이 있으면 도구 목록에 `Skill`이 있어야 한다고 본다(`resolve.ts:217-222`). 이것은 Claude의 조건이다. Codex에는 `Skill` 도구가 없고, Codex 어댑터는 모르는 도구 이름을 거절한다(`codex/src/config.ts:182-187`). 그래서 엔진 descriptor가 "스킬을 부르는 도구 이름"(Claude `Skill`, Codex·pi 없음)을 알리고, 해석기는 상수 대신 그 값을 본다. 없으면 도구 목록 검사를 하지 않는다.
- **스크립트.** `scripts/`는 지금처럼 받는다(`has_scripts`). 실행은 에이전트 Bash와 같은 샌드박스·env에서 엔진이 한다. 스킬은 비밀 값을 싣지 않는다. 비밀이 필요한 일은 MCP 서버로 한다.
- **MCP 의존.** 스킬은 MCP 서버를 싣지 않는다(`.mcp.json` 거절 유지). 스킬이 어떤 서버를 전제하면 frontmatter 밖의 플랫폼 메타데이터 `requires_mcp: [이름…]`를 등록 때 받는다. 해석기는 세션의 MCP 목록에 그 이름이 없으면 경고만 하고 막지 않는다(서버가 연결 전이어도 스킬의 다른 부분은 쓸 수 있다). 엔진이 의존을 스스로 설치하는 기능은 계속 끈다(Codex `features.skill_mcp_dependency_install`).

### MCP 서버

**결정.** 새 개념을 만들지 않는다. 조직이 쓰는 MCP 서버는 [mcp-credentials.md](mcp-credentials.md)의 워크스페이스 서버(원격, OAuth 또는 정적 token)다. 설치 카탈로그 서버는 운영자 경로로 남긴다. 번들 stdio 서버([stdio-mcp-relay.md](stdio-mcp-relay.md))는 "번들"이 아니라 **MCP 서버의 한 종류(`stdio`, 패키지 digest로 고정)**로 다시 정의한다. 스킬 번들이 서버를 싣지 않으므로, 그 설계의 "승인된 번들이 선언한 서버"는 "승인된 stdio MCP 서버 패키지"로 읽는다. 프로세스 수명·relay·판정 결정은 그대로 유효하다. 구현 순서는 바꾸지 않는다(원격 먼저, stdio는 그 설계의 선행 티켓을 따른다).

### 플러그인을 두지 않는 이유

- 세 엔진의 플러그인 형식이 다르고(조사 1-2, 2-1.6, 2-2.8), 그 안의 훅·명령·서브에이전트·확장 코드는 엔진 하나에만 뜻이 있다. 공통분모를 뽑으면 스킬과 MCP만 남는다.
- 플러그인은 코드 실행면이다. Claude plugin 디렉터리는 `settingSources: []`여도 `hooks/hooks.json`과 `.mcp.json`을 실행한다(`bundle-validator.ts:12-15`). 플랫폼 승인 경로 밖의 실행을 열지 않으려고 지금도 거절한다.
- Claude와 Codex의 관리 콘솔도 결국 플러그인 안의 connector·MCP를 따로 추가하게 한다(조사 1-2.1 "Plugin에 connector가 들어 있어도…", 2-1.7 "플러그인을 설치해도 커넥터나 MCP 접근 권한이 생기지 않는다"). 우리는 처음부터 둘로 나눈다.

## 3. 등록

| 출처 | 동작 |
|---|---|
| 업로드 | zip 또는 디렉터리 업로드. 지금 검사기를 지나면 digest가 정해지고 `review = pending`으로 들어간다. 같은 digest를 다시 올리면 `already_registered` |
| Git | GitHub 저장소·경로·ref를 받아, 등록 때 ref를 **커밋 SHA로 고정**해 읽는다. 읽기는 워크스페이스의 GitHub App 연결로 한다(멤버가 저장소 권한을 가질 필요 없다, 조사 1-2.1과 같은 모양). 저장하는 것은 검사기가 다시 만든 트리이고, 원본 위치(`repo`, `path`, `commit`)는 메타데이터로 남는다. "새 커밋 확인"은 같은 경로의 최신 커밋을 읽어 digest가 다르면 **새 버전 후보**를 `pending`으로 만든다. 자동 sync는 하지 않는다: 승인 없이 내용이 바뀌는 길이 된다 |

- 이름: 첫 등록이 이름을 정하고, 같은 이름의 다른 digest는 같은 스킬의 다음 버전이다. 버전 표시는 등록 순번(v1, v2…)과 digest 앞 12자다. `SKILL.md`의 `version` 같은 자기 신고 값은 쓰지 않는다.
- 승인: 등록한 사람과 다른 관리자가 승인한다(조사 1-1.2의 "자기가 제출한 요청은 승인할 수 없다"와 같다). 관리자가 한 사람뿐인 워크스페이스는 본인 승인을 허용하고 receipt에 그 사실을 남긴다.
- 지우기: 지정된 버전은 지우지 못한다. 지정이 없고 진행 중 세션이 쓰지 않는 버전만 "보관"한다. 객체는 체크포인트가 그 digest를 참조하는 동안 남긴다.

## 4. 지정, 버전 고정, 배포

**지정.** 지금 해석기를 그대로 쓴다. 범위는 워크스페이스 → 에이전트 → 세션이고, 한 범위에 한 이름당 한 버전이다.

| 모드 | 뜻 | Claude 조직 설정과의 대응(조사 1-2.1) |
|---|---|---|
| `required` | 항상 켜짐. 안쪽 범위가 빼거나 다른 버전으로 바꾸지 못함 | Required |
| `optional` | 세션을 만드는 사람이 켤 때만 켜짐 | Available to install |
| `forbidden` | 안쪽 범위가 켜지 못함 | Not available |

"Installed by default"(기본으로 켜고 끌 수 있음)는 두지 않는다. 세션 생성 화면의 기본 선택은 콘솔이 정할 일이고 해석 규칙을 늘릴 일이 아니다. Claude Enterprise는 그룹 설정이 겹치면 가장 관대한 값을 쓰지만, 우리는 바깥이 안쪽을 좁히기만 하는 지금 규칙을 지킨다. 결과가 범위 순서만으로 정해져 receipt로 설명할 수 있다.

**팀.** 팀 범위는 두지 않는다. 에이전트마다 담당 팀이 있고([agent-rbac.md](agent-rbac.md)), 팀 lead는 그 에이전트의 관리자다. 팀이 쓰는 스킬은 팀이 맡은 에이전트에 지정하는 것으로 충분하다. 사람 단위 차등(같은 에이전트를 쓰는 사람마다 다른 스킬)은 세션 transcript를 여러 사람이 읽는 구조와 맞지 않아 두지 않는다.

**버전 고정.** 지정 행은 digest 하나를 가리킨다. 세션은 시작할 때 해석 결과를 `sessions.extensions`에 남기고 그 세션 내내 그 digest만 쓴다. 지정을 바꾸면 새 세션부터 적용된다. checkpoint fingerprint가 digest를 담아야 다른 버전으로 resume하지 않는다.

- Claude: 이미 담는다. plugin 경로와 identity(digest)가 fingerprint에 들어간다(`ComponentIdentities.plugins`, `claude/src/config.ts:58-70`, `profile-fingerprint.ts:75-88`). 이 설계는 Claude의 plugin 매핑을 바꾸지 않으므로([5절](#5-엔진-매핑)) 기존 체크포인트는 그대로 resume된다.
- Codex: 지금 `codexProfileDigest`(`codex/src/config.ts:416-447`)는 번들을 해시하지 않는다(번들을 거절하므로 필요가 없었다). S6에서 정렬한 `(이름, digest)` 목록과 매핑 버전을 더한다. 스킬이 없는 세션은 그 필드를 넣지 않아 지금 체크포인트의 digest가 그대로다. 스킬이 있는 체크포인트를 다른 digest 목록으로 되살리려 하면 fingerprint가 달라 거절된다. MCP는 이미 정해진 규칙(좁히는 변경은 진행 중 세션에 바로, 넓히는 변경은 다음 세션부터)을 그대로 쓴다.

**배포 순서(권장, 강제하지 않음).**

1. 새 버전을 등록하고 다른 관리자가 승인한다.
2. 시험할 에이전트 하나의 에이전트 범위에 새 버전을 `required`로 지정한다. 워크스페이스 범위가 그 이름을 `optional`로 두었을 때만 가능하다(바깥 `required`는 안쪽이 버전을 바꾸지 못한다).
3. 괜찮으면 워크스페이스 범위의 지정을 새 버전으로 바꾸고 2의 에이전트 지정을 지운다.
4. 되돌리기는 지정을 옛 digest로 바꾸는 것이다. 옛 버전이 보관되지 않았으면 바로 된다.

콘솔은 스킬 상세에 "버전별로 지정된 곳"(보는 사람이 읽을 수 있는 에이전트만, [7절](#7-권한-receipt-콘솔))을 보여 이 순서를 돕는다. 자동 단계 배포(비율, 시간차)는 하지 않는다.

## 5. 엔진 매핑

어댑터의 일은 "고정된 스킬 트리 목록과 relay 주소 목록"을 엔진이 읽는 자리로 놓는 것뿐이다. 엔진의 다른 탐색 경로는 모두 닫는다(사용자·프로젝트 스킬, 엔진 자체의 MCP 설정, 플러그인 마켓). 세션 작업 공간의 저장소가 가진 `.agents/skills`, `.claude/skills`, `.pi/skills`도 엔진에 보이지 않게 한다. 저장소 내용이 승인 없이 스킬이 되는 길이기 때문이다.

| | Claude (Agent SDK) | Codex (app-server) | pi (가정, 구현 안 함) |
|---|---|---|---|
| 스킬을 놓는 자리 | **지금과 같다.** 번들(스킬) 하나마다 로컬 plugin 하나를 `plugins: [{type:"local", path}]`로 주고 identity는 digest다(`contract.ts:130-140`). 새 스킬은 plugin 이름이 스킬 이름이라 엔진에는 `<name>:<name>`으로, 옛 번들은 지금처럼 `<slug>:<skill>`로 보인다 | 세션 전용 `CODEX_HOME` 아래 `skills/<name>/`. 지금 어댑터가 `CODEX_HOME`을 세션마다 따로 만든다(`codex/src/config.ts` env 조립). 이 경로는 문서에서 빠진 deprecated 경로라(조사 2-1.2), app-server의 `skills/extraRoots/set`으로 세션 스킬 루트를 더하는 쪽을 먼저 시험한다 | 세션 전용 agent dir의 `skills/`, 또는 SDK의 `skills` 설정 |
| 다른 탐색 닫기 | 지금처럼 `settingSources: []`, tenant 전용 `HOME`·`CLAUDE_CONFIG_DIR`([agent-sdk.md](agent-sdk.md) 운영 제약 2), API key·egress token 인증(claude.ai 동기화 스킬은 구독 로그인에서만 온다, 조사 1-6.1). `skills` 옵션은 세션 스킬 이름만 | 아래 "Codex 탐색 닫기" | project trust를 주지 않음(`--no-approve`), agent dir을 세션 전용으로 |
| 시작 확인 | 엔진이 보고한 스킬 집합이 기대 집합과 **정확히 같아야** 시작한다. 지금 `missingSkills`(`plugin-skills.ts:34-39`)는 빠진 것만 보므로 남는 것도 보게 넓힌다 | `skills/list`로 같은 정확 일치. 이름과 실제 경로 둘 다 | RPC/SDK의 스킬 목록으로 같은 정확 일치 |
| MCP | `type: "sdk"` relay(지금) | `mcp_servers.<name>`에 loopback relay URL과 `enabled_tools`(지금 플랫폼 서버만, 워크스페이스 서버로 넓힘) | 내장 MCP 확장을 SDK 세션에 **명시적으로 로드**해야 한다(SDK 세션은 내장 확장을 자동으로 싣지 않는다). 설정에 relay URL, 노출 방식은 `direct`(codemode는 QuickJS가 도구를 대신 부르므로 도구 호출 기록과 승인이 한 단계 멀어진다). pi가 서버·도구 이름을 정규화하므로 플랫폼 이름 ↔ 엔진 이름 대응을 시작 때 확인한다 |
| 엔진 표 | `skills: native`, `mcp: native`, 스킬 호출 도구 `Skill` | `skills: none` → `native`, 스킬 호출 도구 없음 | 새 descriptor |

- **Codex 탐색 닫기.** Codex는 cwd에서 저장소 루트까지의 모든 `.agents/skills`, `$HOME/.agents/skills`, ADMIN `/etc/codex/skills`, 번들 시스템 스킬을 읽고, `extraRoots`는 이 루트를 대신하지 않고 더한다(조사 2-1.2, [탐색 구현](https://github.com/openai/codex/blob/main/codex-rs/ext/skills/src/host_roots.rs)). 그래서 S6은 고정한 Codex 버전에서 루트마다 닫는 방법을 확정한다: 사용자 루트는 비어 있는 세션 전용 `HOME`, ADMIN 루트는 worker 이미지에 그 디렉터리를 두지 않음, 시스템 스킬은 `[skills.bundled] enabled = false`, 저장소 쪽 `.agents/skills`는 시작 전에 어댑터가 작업 공간에서 찾은 `SKILL.md`마다 `[[skills.config]] path = … enabled = false`를 넣는다. 그리고 시작 확인의 정확 일치가 마지막 방어다. 실행 중 저장소에 새 `SKILL.md`가 생겨 `skills/changed`가 오면 그 턴을 끝내고 다음 턴 시작 전에 다시 끄고 대조한다. 이 중 하나라도 고정한 버전에서 확인하지 못하면 Codex의 스킬은 켜지 않는다(descriptor `none` 유지).
- **Claude의 plugin 매핑을 바꾸지 않는 이유.** 처음 안은 세션 스킬을 합성 plugin 하나(`werft:<name>`)로 묶는 것이었으나 버렸다. (1) checkpoint fingerprint가 plugin 경로·identity 목록을 해시하므로(`profile-fingerprint.ts:75-88`) 묶음 방식을 바꾸면 같은 digest여도 기존 체크포인트가 resume되지 않고, transcript에 남은 스킬 이름도 바뀐다. (2) 옛 번들의 `a:review`와 `b:review`가 한 plugin 안에서 겹친다. 지금 매핑을 두면 둘 다 생기지 않는다. 대가는 새 스킬이 `<name>:<name>`처럼 이름이 두 번 보이는 것뿐이다.
- **엔진 이름의 겹침.** 해석기의 겹침 검사(`resolve.ts:224-233`)는 `<번들>:<스킬>`로 본다. 엔진에 펼친 뒤의 이름(Claude `<plugin>:<skill>`, Codex·pi `<name>`)으로 활성화와 세션 생성 때 한 번 더 본다. 새 스킬 이름은 워크스페이스에서 유일하고 기존 slug와 겹치지 못하며 옛 번들은 Claude에만 가므로, 이 검사는 쓰기 검사가 빠졌을 때의 마지막 방어다.
- **Claude에서 로컬 plugin을 쓰는 이유.** SDK는 스킬을 코드로 등록하는 API가 없고 파일만 읽는다(조사 1-6.1). project 스킬(`.claude/skills`)은 `settingSources: ["project"]`가 있어야 읽히는데, 그러면 저장소의 `settings.json`과 훅까지 읽힌다. 지금 경로(로컬 plugin)가 project 설정 없이 스킬을 넣는 유일한 길이다. plugin 트리에는 검사기를 지난 `skills/`와 manifest만 있다. Claude의 in-process `sdk` 서버는 조직 managed 정책의 MCP 허용 목록 검사에서 빠지므로(조사 1-6.3), 고객 조직이 관리 정책을 두어도 플랫폼 MCP가 막히지 않는다. 반대로 `disableSideloadFlags`는 SDK `plugins` 옵션을 거부하므로, worker가 조직 credential로 managed settings를 받는 구성에서는 스킬이 막힌다. worker는 tenant 전용 config tree를 쓰므로 지금 구성에서는 해당하지 않는다고 운영 문서에 적는다.
- **Codex의 MCP를 넓히는 일.** 지금 거절 이유는 "관리자가 이름 붙인 원격 서버에는 호출마다 판정하는 길이 없다"이다(`codex/src/config.ts:177-180`). 워크스페이스 서버는 egress가 요청마다 DB로 판정하므로([mcp-credentials.md](mcp-credentials.md) 결정 6) 그 길이 생겼다. relay가 `/mcp/<name>`으로 보내고 `enabled_tools`로 claim의 도구만 보이면 Claude와 같은 경계가 된다.
- **이름.** 스킬 이름과 MCP 서버 이름은 각자의 이름공간이다. 엔진 하나 안에서 겹치는 것은 스킬끼리(`skill_name_collision`, 지금 있음)와 MCP 서버끼리(지금 있음)뿐이다.

## 6. MCP 자격과 데이터 접근 정책

### 자격

엔진 쪽 경계는 새로 정하지 않는다. [mcp-credentials.md](mcp-credentials.md)의 결정을 세 엔진에 같게 적용한다. 자격의 주체를 넓히는 일은 아래 "데이터 접근 정책"에 있다.

- 자격 주체는 워크스페이스 하나이고, 엔진과 worker는 token을 보지 못한다. 엔진이 보는 것은 relay 주소와 attempt 범위의 relay 비밀뿐이다(Codex는 `bearer_token_env_var`가 relay 비밀을 가리킨다).
- 엔진 스스로의 MCP 연결과 OAuth를 막는다. proxy가 upstream 401을 403으로 바꾸고 `www-authenticate`를 지우는 것은 relay를 지나는 요청에만 걸리므로, 엔진이 relay 밖의 서버를 아예 알지 못하게 하는 것이 먼저다.
  - Claude: `mcpServers`에 relay만 주고 `strictMcpConfig: true`로 다른 MCP 설정을 무시하게 한다. claude.ai connector는 구독 로그인에서만 오고(조사 1-3.3) worker는 API key·egress token으로 인증하지만, 그래도 `disableClaudeAiConnectors`에 해당하는 설정을 tenant config에 둔다. OAuth 저장소는 tenant 전용 `CLAUDE_CONFIG_DIR` 안이고 세션이 끝나면 버린다.
  - Codex: `mcp_servers`는 어댑터가 넘기는 override뿐이고, 사용자 `config.toml`이 없는 세션 전용 `CODEX_HOME`, 저장소 `.codex` 미신뢰(지금, `codex/src/config.ts`의 `projects` trust)로 다른 설정 층이 들어오지 않는다. 어댑터는 app-server의 `mcpServer/oauth/login`·`config/mcpServer/reload`를 부르지 않고, 엔진 쪽 token 저장소는 세션 `CODEX_HOME` 안이라 세션과 함께 버린다.
  - pi: user·project `mcp.json`을 읽지 않게 agent dir을 세션 전용으로, project trust를 주지 않는다. `pi mcp login`은 부르지 않는다.
  - 시험(S8): 저장소의 `.mcp.json`·`.codex/config.toml`·`.agents` 아래와 엔진 사용자 설정 자리에 시험용 서버를 넣고, 엔진이 그 서버로 직접 연결하거나 token을 저장하지 않음을 확인한다.
- 스킬은 자격을 갖지 않는다. 스킬이 외부 서비스를 써야 하면 그 서비스의 MCP 서버를 `requires_mcp`로 가리킨다.

### 데이터 접근 정책 (오너 결정, 2026-11-20)

오너 결정의 요지는 셋이다. 누가 호출했는지와 어떤 스킬인지에 따라 데이터를 가져가도 되는지 정한다. 개인의 MCP 연결을 쓸지 에이전트의 MCP 연결을 쓸지 정한다. 이 둘을 자기 신고 헤더가 아니라 rule-based로 정한다. 이 셋을 **규칙 기반 접근 정책 하나**로 묶는다.

**정책이 정하는 것.** MCP `tools/call` 하나마다 "이 호출이 외부 데이터를 가져가도 되는가, 된다면 **어느 연결**의 자격으로"를 정한다. 도구를 엔진에 보일지, 실행 전에 물을지는 실행 규칙(allow/deny/ask)이 정한다([10절](#10-실행-규칙지시-파일-설계와의-관계)). 접근 정책은 실행 규칙이 허용한 호출에만 판정하는 **그 위의 한 층**이다. 실행 규칙이 막은 호출은 정책까지 오지 않는다.

**규칙의 모양.** 워크스페이스마다 순서 있는 규칙 목록 하나가 있고, 위에서부터 처음 맞는 규칙 하나로 정한다. 방화벽 규칙처럼 결과를 "몇 번 규칙"으로 설명할 수 있게 하려는 것이다.

| 칸 | 값 | 판정 때 어디서 읽나 |
|---|---|---|
| 요청자 | 사람(구성원·팀·역할) 또는 "사람 없음"(일정·webhook처럼 에이전트가 스스로 시작한 턴) | 그 턴을 시작한 플랫폼 주체. 세션 행과 턴 입력의 작성자를 control-host가 읽는다 |
| 에이전트 | 에이전트 또는 그 담당 팀 | 세션 행 |
| MCP 서버와 도구 | 서버, 선택으로 `mcp__<서버>__<도구>` | proxy 요청의 서버 이름과 JSON-RPC 본문(지금 egress 판정이 이미 읽는다) |
| 스킬 | 이 세션에 켜진 스킬(이름, 선택으로 버전) | 세션의 고정된 스킬 목록(`sessions.extensions`) |
| 결과 | `allow`(연결 종류를 함께 정함) 또는 `deny` | — |
| 연결 종류 | `agent`(워크스페이스·에이전트가 소유한 연결) 또는 `personal`(요청자 본인의 연결) | — |

- **자기 신고를 믿지 않는다.** 요청자, 에이전트, 스킬은 모두 플랫폼이 이미 가진 상태(세션 행, 턴 작성자, 고정된 스킬 목록)에서 읽는다. 엔진이나 worker가 보내는 헤더·인자로 받지 않는다. 엔진이 "이 호출은 어떤 스킬이 했다"고 표시하는 길이 없으므로, 스킬 칸은 "이 세션에 그 스킬이 켜져 있다"는 세션 단위 조건이다. 호출 하나가 어느 스킬에서 나왔는지는 판정하지 않는다. 이것을 문서와 화면에 그대로 적는다.
- **연결 종류.** `agent`는 지금의 워크스페이스 연결(`workspace_mcp_connections.subject = 'workspace'`)이다. `personal`은 새로 연결 행의 `subject = 'user:<id>'`를 허용해 만든다. [mcp-credentials.md](mcp-credentials.md) 결정 1은 subject를 넓힐 자리를 남겨 두었고, 그 문서의 LATER "요청자 본인의 계정"을 이 결정이 연다. 개인 연결은 구성원 본인이 개인 설정에서 같은 OAuth 흐름(서버별 redirect, PKCE, 저장 때 재검사)으로 만들고, 그 사람의 턴에서만 쓰인다. 다른 사람의 턴이 남의 개인 연결을 쓰는 규칙은 만들 수 없다(검증에서 거절).
- **여러 사람이 쓰는 세션.** 개인 연결로 가져온 데이터는 transcript에 남아 같은 세션을 보는 다른 사람에게 보인다. 이 때문에 [mcp-credentials.md](mcp-credentials.md)는 개인 계정을 미뤘다. 그래서 `personal` 규칙은 이름·팀 공유가 없고 워크스페이스 전체 공개가 아닌 세션에서만 맞게 하고, 공유된 세션에서는 그 규칙을 건너뛴다(다음 규칙으로 간다). 공유가 나중에 생기면 그 뒤의 호출부터 적용되고, 이미 개인 연결로 가져온 데이터가 있으면 공유하는 화면에서 경고한다. 공유가 없어도 그 에이전트의 관리자는 세션을 읽는다(세션 목록의 `administered`, `packages/contracts/src/api/session.ts:694`). 개인 연결을 만드는 화면에 "이 에이전트의 관리자도 이 세션을 볼 수 있다"를 적는다. 관리자 열람까지 막을지는 오너 확인 항목으로 남긴다(기본값: 막지 않고 알린다).
- **기본값과 이행.** 규칙이 하나도 없는 워크스페이스는 지금 동작과 같다. 암묵 규칙 하나 "에이전트가 켠 서버 → `allow`, `agent` 연결"이 맨 아래에 있다고 본다. 개인 연결만 있고 맞는 규칙이 없으면 `deny`(fail closed)다.
- **판정 자리.** 지금 egress 판정(`packages/platform/src/workers/mcp-egress.ts`, [mcp-credentials.md](mcp-credentials.md) 결정 6)이 요청마다 세션 상태를 다시 읽는 자리에 정책 평가를 더한다. 결과의 연결로 `Authorization`을 붙인다. 거절 이유에 `access_policy_denied`(규칙 번호 포함)와 `personal_connection_missing`(요청자에게 개인 연결이 없음)을 더한다. 엔진에는 지금처럼 도구 오류로만 보인다.
- **권한.** 규칙 목록을 고치는 것은 워크스페이스 관리자이고 콘솔 세션에서만 받는다. 규칙의 판정 대상(어느 에이전트·사람)이 보이는 범위는 7절의 에이전트 읽기 거름과 같다.

**공개 범위는 새 개념이 아니다.** 어떤 에이전트를 누가 쓸 수 있는지는 지금의 에이전트 권한 관리([agent-rbac.md](agent-rbac.md): 담당 팀, 에이전트 관리자, 세션 공유)가 정한다. 스킬과 MCP 서버는 에이전트에 지정되므로 그 에이전트를 쓸 수 있는 사람에게만 닿는다. 스킬이나 MCP 서버에 따로 "공개 범위"를 두지 않는다.

**감사는 도구 사용 로그다.** 에이전트가 어떤 도구를 썼는지(MCP 포함)를 남긴다. 새 저장소를 만들지 않고 지금의 `call_mcp` receipt와 도구 호출 감사 레코드([관측과 도구 호출 감사](observability-otel-and-tool-call-audit.md))에 칸을 더한다: 요청자, 맞은 규칙 번호(암묵 규칙이면 그렇다고), 연결 종류와 연결 subject·`generation`. 개인 연결의 subject는 사용자 id이고 외부 계정 식별자는 꾸미지 않는다([mcp-credentials.md](mcp-credentials.md) 결정 7과 같다).

**사용량·비용 귀속은 지금 것을 쓴다.** 세션 사용량 장부([세션 사용량 장부](provider-usage-ledger.md))와 지금의 사용량 화면을 그대로 적용한다(오너 결정). 이 설계는 더하지 않는다.

## 7. 권한, receipt, 콘솔

### 권한

| 동작 | 누가 | 근거 |
|---|---|---|
| 스킬 등록·새 버전·Git 새 커밋 확인 | 워크스페이스 관리자(`owner`·`admin`) | 지금 `EXTENSION_MANAGER_ROLES`(`bundle-service.ts:29-31`) |
| 승인·거절, 보관 | 워크스페이스 관리자, 등록한 사람이 아닌 사람([3절](#3-등록)) | 위와 같음 |
| 워크스페이스 범위 지정 | 워크스페이스 관리자 | 위와 같음 |
| 에이전트 범위 지정(승인된 버전만) | 그 에이전트의 관리자(담당 팀 lead, 개인 관리자, 관리자 팀 구성원)와 워크스페이스 관리자 | 에이전트 MCP 켜기·끄기(`agent.manage`)와 같은 축. 지금 서비스는 워크스페이스 관리자만 받으므로 넓힌다 |
| 세션에서 `optional` 켜기 | 그 에이전트를 실행할 수 있는 사람 | 세션 생성 권한 |
| 카탈로그 보기(이름, 버전, 출처, 승인 상태, 워크스페이스 범위 지정) | 워크스페이스 구성원 | `workspace.read` |
| 에이전트 범위 지정 보기(어느 에이전트에 어느 버전, 그 개수, 그 receipt) | 그 에이전트를 볼 수 있는 사람만. 목록·개수·receipt를 에이전트 읽기 권한으로 거른다 | 담당 팀 밖에는 에이전트가 보이지 않는다([agent-rbac.md](agent-rbac.md) 2026-11-16 후속). 지정 관계가 숨긴 에이전트를 드러내면 안 된다 |

모든 쓰기는 콘솔 세션(사용자 주체)에서만 받는다. API key로는 할 수 없다([mcp-credentials.md](mcp-credentials.md) 결정 2와 같은 규칙).

### receipt와 결정 기록

- 등록·승인·거절·지정·해제·보관은 각각 receipt를 같은 transaction에서 쓴다. 지금 있는 `register_extension`(`ports/extension-bundle-store.ts:75-78`), 승인 receipt, `attach_extension`·`detach_extension`을 그대로 쓰고, 없는 것은 보관(`archive_extension`) 하나만 더한다. 종류 이름을 "skill"로 바꾸지 않는다(지난 receipt 조회가 두 이름을 알아야 한다). 대상에는 이름·digest·출처(Git이면 커밋)를 남긴다.
- 세션은 시작 때 해석 결과(이름, digest, 범위)를 이벤트로 남긴다. 그래서 "이 세션은 어떤 스킬의 어느 버전으로 돌았나"를 receipt와 세션 이벤트만으로 답할 수 있다. Claude Enterprise의 Compliance API가 스킬·플러그인 이벤트를 남기는 것(조사 1-5)과 같은 수준이고, 엔진 로컬 기록에 기대지 않는다는 점은 Codex 문서가 Compliance API의 한계로 적은 것(조사 2-1.7)을 피한다.
- 스킬 사용 자체(엔진이 스킬을 읽거나 부른 것)와 MCP 도구 사용은 도구 호출 감사([관측과 도구 호출 감사](observability-otel-and-tool-call-audit.md))가 다룬다. 새 감사 레코드는 만들지 않고, MCP 호출에는 6절의 칸(요청자, 맞은 규칙, 연결 종류·subject·`generation`)을 더한다.

### 콘솔 메뉴

```text
워크스페이스 설정
  └ 에이전트 연결
      ├ 통합 (Slack, GitHub)        지금
      ├ 모델 연결                    지금
      ├ MCP 서버                     지금
      ├ 데이터 접근 정책             새로: 순서 있는 규칙 목록, 규칙마다 "최근 맞은 호출 수", 규칙 시험(요청자·에이전트·서버·스킬을 넣으면 몇 번 규칙이 맞는지)
      └ 스킬                         새로
          ├ 목록: 이름, 최신 승인 버전, 대기 중 버전 수, 워크스페이스 지정 모드, 쓰는 에이전트 수(보는 사람이 읽을 수 있는 에이전트만)
          ├ 추가: 업로드 / GitHub에서
          ├ 승인 대기: 버전별 diff(파일 목록과 SKILL.md 본문), 승인·거절
          └ 스킬 상세: 버전 기록(digest, 출처, 등록·승인한 사람), 버전별 지정된 곳(읽을 수 있는 에이전트만), 워크스페이스 지정 모드, 보관

에이전트 상세 > 접근 탭
  ├ MCP 서버                         지금
  └ 스킬                             새로
      워크스페이스가 준 것(모드, 버전, 바꿀 수 없음 표시)과 이 에이전트가 더하거나 좁힌 것

새 세션
  └ 이 에이전트의 optional 스킬 켜기

개인 설정
  └ 연결된 계정                       지금 화면에 MCP 서버의 개인 연결 칸을 더함(연결·끊기, "이 에이전트의 관리자도 세션을 볼 수 있다" 안내)
```

Claude는 스킬과 플러그인을 한 화면(Plugins & skills)에, connector를 다른 화면에 둔다(조사 1-0). 우리는 플러그인이 없으므로 "MCP 서버"와 "스킬"을 같은 묶음의 이웃 항목으로 둔다. 둘 다 "에이전트에 주는 능력"이라 한 묶음이 맞고, 자격(MCP)과 내용 승인(스킬)은 일의 모양이 달라 한 화면에 합치지 않는다.

## 8. pi coding agent를 세 번째 엔진으로

### 무엇인가(조사 2-2)

MIT 오픈소스 코딩 에이전트다. 저장소는 `earendil-works/pi`(옛 `badlogic/pi-mono`)이고 패키지는 `@earendil-works/pi-coding-agent`다. 1.0(2026-10-01) 뒤 거의 매주 릴리스한다. 임베딩은 SDK(`createAgentSession`), `--mode rpc`(stdin/stdout JSONL), `--mode json` 셋이다. 세션은 `id`/`parentId` 트리의 JSONL 파일이다. 공급자는 30종 이상이다. 스킬은 Agent Skills 사양을 구현하고, MCP는 0.99.0(2026-09-29)부터 내장 확장으로 지원한다(그 전에는 "지원하지 않는다"가 공식 입장이었다). **내장 권한·샌드박스가 없다.** 도구 호출 게이트는 확장의 `tool_call` 훅으로 만든다.

### 가치

- **공급자 중립.** Claude 어댑터는 Anthropic Messages(직접 또는 LiteLLM), Codex는 OpenAI Responses에 묶여 있다. pi는 공급자 30종 이상을 엔진 하나로 받는다. 고객이 쓰는 모델이 둘 밖일 때의 길이 된다.
- **스킬·MCP 모델과 잘 맞는다.** 이 설계의 두 개념을 pi가 그대로 읽는다. 플러그인 대신 "pi 패키지"가 있지만 쓰지 않으면 된다.
- **임베딩이 깨끗하다.** RPC 모드는 Codex app-server와 같은 모양(프로세스 하나, JSONL)이라 codec-kit의 이벤트 codec 구조(`packages/adapters/runtimes/codec-kit`)와 registry의 descriptor 방식에 들어간다.

### 비용과 맞춤

| 항목 | 해야 할 일 | 크기 |
|---|---|---|
| 승인·권한 | pi에는 승인 경로가 없다. worker 안에서 도는 확장을 만들어 `tool_call` 훅에서 플랫폼 판정(묻기·막기·승인 대기)을 하고, 승인 대기 동안 프로세스를 살려 둔다([agent-sdk.md](agent-sdk.md) 운영 제약 1과 같은 요구). 확장은 pi 프로세스와 같은 권한이라 엔진 쪽 코드가 플랫폼 경계 안에 들어온다 | 큼 |
| 샌드박스 | pi는 격리를 하지 않는다. 지금 worker 컨테이너·supervisor 경계([worker-supervisor-boundary.md](worker-supervisor-boundary.md))가 그대로 격리가 된다. Codex의 bubblewrap 같은 엔진 내부 샌드박스는 없다 | 중간 |
| 체크포인트·resume | JSONL 세션 파일을 체크포인트에 담고 되살리는 일. 트리 구조라 Claude transcript mirror보다 단순할 수 있으나 확인 필요 | 중간 |
| 이벤트 codec | RPC 이벤트를 공개 SSE 이벤트로 바꾸는 codec과 계약 시험 | 중간 |
| 엔진 이미지 | Node 22.19 이상 이미지 하나 더([engine-worker-images.md](engine-worker-images.md)) | 작음 |
| 지시 파일 | pi는 `AGENTS.md`·`CLAUDE.md`를 trust와 무관하게 읽는다. 지시 파일을 어떻게 넣을지는 실행 규칙·지시 파일 설계가 정한다([10절](#10-실행-규칙지시-파일-설계와의-관계)) | 그 설계에 따름 |

### 위험

- **보안 모델의 차이.** Claude·Codex는 엔진이 묻고 플랫폼이 답한다. pi는 엔진이 묻지 않으므로 플랫폼이 엔진 안에 게이트를 심어야 한다. 게이트가 빠진 도구(새 버전이 더한 내장 도구, MCP `codemode`가 대신 부르는 호출)는 묻지 않고 돈다. 엔진 버전을 올릴 때마다 도구 목록을 대조하는 시험이 필요하다.
- **변화 속도.** 1.0 뒤 매주 릴리스이고 MCP 입장도 1년 안에 뒤집혔다. [agent-sdk.md](agent-sdk.md)처럼 정확한 버전 고정과 호환 harness가 필요하다.
- **기여 정책.** 새 기여자의 이슈·PR을 자동으로 닫는다. 상류에 고칠 것이 생기면 우회해야 한다.

### Oh My Pi

`can1357/oh-my-pi`, MIT, pi의 fork다(README가 그렇게 적는다). Rust 네이티브 코어, LSP·DAP, worktree 서브에이전트, 네이티브 MCP, 승인 모드(기본 `yolo`)를 더했다. Claude·Codex·Gemini·OpenCode의 MCP 설정과 스킬을 **자동으로 가져오고**, 저장소를 열면 설정·확장·훅·스킬·MCP를 "의도대로" 불러온다(조사 2-3). 월 40건 넘게 릴리스한다.

**쓰지 않는다.** 이 설계가 막으려는 것(저장소 내용이 승인 없이 스킬·MCP·훅이 되는 것)을 기본 동작으로 한다. 끌 수는 있지만 끌 것이 많고 릴리스 속도가 빨라 매번 확인해야 한다. 엔진으로 붙인다면 pi 본체가 맞다. Oh My Pi의 기능(LSP, 서브에이전트) 중 필요한 것이 생기면 그때 기능 단위로 다시 본다.

### 추천

**지금은 구현하지 않는다.** 먼저 이 설계의 Claude·Codex 단위([9절](#9-구현-단위))를 끝내 두 엔진에서 스킬·MCP 모델이 같게 동작함을 보인다. 그 뒤 **스파이크 하나**(코드는 머지하지 않음)로 다음 셋을 확인하고, 셋 다 되면 pi 엔진을 별도 설계로 올린다.

1. `tool_call` 훅 확장이 내장 도구와 MCP 도구 호출을 **모두** 받고, 플랫폼 승인 대기 동안 프로세스를 살린 채 막을 수 있다.
2. RPC 모드에서 세션 JSONL을 체크포인트로 담고 다른 컨테이너에서 resume할 수 있다.
3. 사용자·프로젝트 탐색을 끄고 세션 전용 스킬 루트와 relay MCP만 보이게 할 수 있다. SDK 세션에 내장 MCP 확장을 명시적으로 로드하고, pi가 정규화한 서버·도구 이름이 플랫폼 이름과 1:1로 대응한다.

엔진을 하나 더 붙이는 이유가 "공급자 중립"이라면, 고객 요구(둘 밖의 모델)가 생기는 때가 시작 조건이다.

## 9. 구현 단위

| 단위 | 내용 | 선행 |
|---|---|---|
| S1 | 이 문서 | 없음 |
| S2 | 스킬 API: 등록(업로드, 스킬 하나로 좁힘), 버전, 승인(본인 승인 규칙), 지정·해제, 보관, `requires_mcp` 메타데이터, receipt 추가, `packages/core` 응답 표 | S1 |
| S3 | Git 출처: 저장소·경로·ref를 커밋으로 고정해 읽기, "새 커밋 확인" | S2 |
| S4 | 콘솔: 워크스페이스 설정 > 스킬, 에이전트 접근 탭의 스킬 칸, 새 세션의 optional 켜기 | S2 |
| S5 | 해석기와 Claude 어댑터: 스킬 호출 도구를 descriptor에서 읽기, 엔진 이름 기준 겹침 검사, 시작 확인을 정확 일치로(`missingSkills` → 빠진 것과 남는 것), `strictMcpConfig`. plugin 매핑과 fingerprint는 바꾸지 않음 | S2 |
| S6 | Codex 어댑터: 스킬 루트(extraRoots 우선, 안 되면 세션 `CODEX_HOME/skills`), 고정 버전에서 루트별 탐색 닫기 확정과 `skills/changed` 처리, `skills/list` 정확 일치, `codexProfileDigest`에 스킬 digest와 매핑 버전, descriptor `skills: native`(닫기를 확인하지 못하면 `none` 유지) | S2, S5 |
| S7 | Codex 어댑터: 워크스페이스 MCP 서버를 relay로(`assertStartable` 거절 해제, `enabled_tools`) | 워크스페이스 MCP 구현 |
| S8 | E2E: 같은 스킬과 MCP 서버를 Claude·Codex 에이전트에 지정하고 둘 다 쓰는지, 저장소의 `.agents/skills`·`.claude/skills`가 보이지 않는지, 저장소와 엔진 사용자 설정에 넣은 시험용 MCP 서버로 엔진이 직접 연결하거나 token을 저장하지 않는지, 담당 팀 밖 구성원에게 숨긴 에이전트의 지정이 보이지 않는지 | S4–S7 |
| S10 | 개인 MCP 연결: 연결 행 `subject = 'user:<id>'` 허용(CHECK 넓힘), 구성원 본인의 OAuth 흐름과 끊기, 구성원 이탈 때 끊기, 개인 설정 화면 | 워크스페이스 MCP 구현 |
| S11 | 데이터 접근 정책: 규칙 저장·순서·검증(남의 개인 연결 금지), egress 판정에 평가와 연결 선택, 공유된 세션에서 `personal` 규칙 건너뛰기, 거절 이유 두 개, `call_mcp` receipt와 도구 감사 칸, 콘솔 규칙 화면과 규칙 시험 | S10, 실행 규칙 설계의 판정 순서 |
| S9 | pi 스파이크(머지 안 함): [8절](#8-pi-coding-agent를-세-번째-엔진으로) 추천의 세 확인과 MCP 확장의 명시적 로드, 플랫폼 이름 ↔ pi 정규화 이름 대응. 결과를 이 문서의 후속으로 기록 | S8 |

## 10. 실행 규칙·지시 파일 설계와의 관계

명령·도구의 allow/deny 규칙과 지시 파일(`CLAUDE.md`·`AGENTS.md`)을 엔진에 어떻게 넣을지는 별도의 실행 규칙·지시 파일 설계가 정한다. 이 문서는 그 둘을 다루지 않는다. 겹치는 곳은 세 가지뿐이다.

- 6절의 데이터 접근 정책은 실행 규칙 **위의** 층이다. 판정 순서는 실행 규칙(보일지·물을지·막을지)이 먼저이고, 허용된 MCP 호출에만 접근 정책이 데이터를 가져가도 되는지와 연결을 정한다. 두 판정은 같은 egress 요청 경로에서 이 순서로 돌고, 둘 다 자기 신고 입력을 받지 않는다는 원칙을 같이 쓴다. 규칙 문법을 하나로 합칠지는 그 설계와 맞춘다.

- MCP 도구를 좁히는 것은 이 문서에서 claim의 도구 목록(Codex `enabled_tools`, Claude relay의 고정 목록)으로 한다. deny 문법이 엔진마다 어떻게 표현되는지는 그 설계의 몫이다.
- 스킬 경로를 놓을 때 엔진의 project 설정 로딩을 켜지 않는다는 이 문서의 전제(Claude `settingSources: []`, Codex 저장소 `.codex` 미신뢰, pi project trust 없음)는 지시 파일을 엔진이 아니라 플랫폼이 넣는다는 지금 방식과 같은 방향이다. 그 설계가 이 전제를 바꾸면 5절의 "다른 탐색 닫기"를 다시 본다.

## 범위 밖

- 플러그인, 훅, 슬래시 명령, 서브에이전트 정의, 엔진 확장 코드(pi 확장, Codex 앱).
- 마켓플레이스 탐색과 외부 카탈로그 가져오기(Anthropic 카탈로그, Codex 마켓플레이스).
- 사람별 개인 스킬과 멤버 간 공유. 스킬은 조직이 승인한 것만 엔진에 간다.
- 콘솔 안의 스킬 작성기.
- 엔진의 자동 의존 설치(스킬이 MCP 서버를 깔게 하는 기능).
- 보안 스캔(Claude Enterprise의 스킬 스캔에 해당). 승인 사람 검토로 대신하고, 필요해지면 다시 본다.
- pi 엔진 구현([8절](#8-pi-coding-agent를-세-번째-엔진으로) 추천에 따라 오너 결정 뒤).

## 대안 (고르지 않음)

- **플러그인을 단위로 하고 엔진별 변환기를 둔다.** 엔진마다 다른 훅·명령을 승인하고 판정할 길이 필요하고, 변환할 수 없는 부분이 매번 생긴다. 오너 지시(스킬 + MCP)와도 다르다.
- **번들(여러 스킬)을 계속 등록 단위로 둔다.** Claude 외 엔진에서 이름공간을 흉내 내야 하고(`<slug>-<skill>` 같은 이름 바꾸기), 버전이 스킬 하나가 아니라 묶음 단위로 움직여 한 스킬만 고치는 배포가 무거워진다.
- **저장소의 `.agents/skills`를 그대로 읽게 한다.** 엔진 셋이 다 읽는 자리라 가장 쉽지만, 저장소에 push할 수 있는 사람이 승인 없이 에이전트 능력을 바꾼다.
- **Git 출처를 push마다 자동 sync한다.** Claude 조직 설정이 이렇게 한다(조사 1-2.1). 우리는 승인이 버전 단위라, 자동 sync는 승인 대기 버전을 늘릴 뿐 배포를 빠르게 하지 않는다.
- **가장 관대한 값 규칙(Claude Enterprise 그룹).** 결과를 설명하려면 모든 그룹 소속을 봐야 한다. 범위 순서 규칙이 receipt로 설명하기 쉽다.
