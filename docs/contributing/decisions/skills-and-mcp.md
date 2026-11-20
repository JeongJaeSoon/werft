# 결정(설계): 스킬과 MCP 서버를 엔진에 상관없이 등록·지정하고, werft 플러그인으로 묶는다

- 상태: 설계. 코드는 바꾸지 않는다. 단계와 끝난 조건은 [14절](#14-단계별-구현-계획)에 있다.
- 기준 커밋: `origin/main` `20d42022d`. `파일:줄`은 이 커밋에서 읽었다.
- 조사 근거: [조사: 엔진과 관리 콘솔이 스킬·MCP·플러그인을 다루는 방법](skills-and-mcp-research.md). 이 문서에서 바깥 제품을 말할 때는 그 조사의 절을 가리킨다. 표준과 시장 동향(2026-05 ~ 2026-11)의 요약, 무엇을 따르고 무엇을 다르게 가는지, werft 안의 자리는 [11절](#11-조사-요약과-시장-동향), [12절](#12-따를-것과-다르게-갈-것), [13절](#13-werft-아키텍처-적용)에 있다.
- 관련 결정: [접근 판정 하나로 기억 범위, MCP 자격, 에이전트 답변을 정한다](access-decisions.md)(데이터 접근 정책의 정본), [에이전트 기억 레이어](memory-layer.md), [워크스페이스 원격 MCP 서버](mcp-credentials.md), [번들 stdio MCP 서버를 worker relay 뒤에 둔다](stdio-mcp-relay.md), [Agent SDK 버전](agent-sdk.md), [에이전트 담당 팀과 액션 RBAC](agent-rbac.md), [엔진별 worker 이미지](engine-worker-images.md).
- 티켓 번호: 저장소의 마크다운은 티켓 번호를 적지 못한다(`tests/docs-links.test.ts`). 번호는 이 문서를 들인 PR 본문에 있다.

## 요약

| 항목 | 결론 |
|---|---|
| 개념 | 조직이 엔진에 주는 것은 **스킬**과 **MCP 서버**다. 이 둘과 실행 규칙·지시를 가리키는 엔진 중립 묶음인 **werft 플러그인**가 공유·지정의 단위다([10절](#10-스킬-라이브러리-의존성-werft-플러그인-오너-요청-2026-11-20)). 엔진 고유의 플러그인(Claude·Codex plugin, pi 패키지)은 원본 개념으로 두지 않고, 어댑터가 werft 플러그인에서 만드는 **엔진 플러그인(출력)**으로만 생긴다. 엔진 플러그인은 엔진마다 형식이 다르고(Claude `.claude-plugin/plugin.json`, Codex `plugin.json`, pi 패키지) 훅·명령·서브에이전트처럼 엔진 하나에만 뜻이 있는 것을 함께 싣기 때문이다 |
| 스킬 | [Agent Skills 사양](https://agentskills.io/specification)의 `SKILL.md` 디렉터리 하나가 단위다. 세 엔진 모두 이 형식을 읽는다(조사 1-6.1, 2-1.2, 2-2.6). 등록은 업로드 또는 Git(커밋 고정), 버전은 내용 digest |
| MCP 서버 | 지금의 워크스페이스 원격 MCP 서버([mcp-credentials.md](mcp-credentials.md))를 그대로 쓴다. 엔진은 어느 쪽이든 플랫폼의 relay만 보고, 자격은 egress가 붙인다 |
| 지정 | 워크스페이스 → 에이전트 → 세션 범위를 `required` / `optional` / `forbidden`으로 접는 지금의 해석기(`packages/platform/src/extensions/resolve.ts`)를 쓴다. 바깥 범위는 안쪽을 좁히기만 한다. 지정 단위가 werft 플러그인이 된 뒤에도 `forbidden`은 그 플러그인이 담은 스킬 이름에까지 걸리고, 펼친 결과로 다시 확인한다. 다른 플러그인에 같은 이름의 스킬을 담아 금지를 비켜 가지 못한다 |
| 버전 고정과 배포 | 지정 행이 digest 하나를 가리킨다. 세션은 시작할 때 고른 digest를 `sessions.extensions`에 고정한다. 새 버전은 승인 → 에이전트 하나에 지정 → 워크스페이스 지정 교체 순으로 넓힌다 |
| 엔진 매핑 | 어댑터가 세션 작업 공간에 엔진이 읽는 자리로 펼친다. Claude는 지금처럼 스킬마다 로컬 plugin 하나(체크포인트 호환), Codex는 세션 스킬 루트, pi는 세션 전용 agent dir의 `skills/`. 엔진의 다른 탐색 경로는 닫고, 엔진이 보고한 스킬 집합이 기대와 정확히 같아야 시작한다. MCP는 셋 다 플랫폼 relay 주소 하나씩 |
| 데이터 접근 | 오너 결정(2026-11-20)의 규칙 기반 접근 정책은 [접근 판정](access-decisions.md)의 MCP 축(`mcp.use`)이다. 규칙 모양, 이행·정책 모드, 요청자(턴의 인증 근거), 개인 데이터 전제, 기록은 그 문서가 정본이다. 이 문서는 MCP에만 있는 것을 정한다: 언제 무엇을 묻는지(서버·턴의 첫 요청은 도구 없이, `tools/call`마다 도구와 함께, 매번 규칙 목록 전체를 첫 일치로), 개인 연결이 지나야 하는 경로, 전송 세션의 subject 고정, 엔진 자체 MCP 연결 막기([6절](#6-mcp-자격과-데이터-접근-정책)) |
| 권한과 기록 | 제출은 구성원, 승인은 제출한 사람이 아닌 워크스페이스 관리자, 에이전트 범위 지정은 에이전트 관리자. 라이브러리는 각 플러그인의 공개 범위([접근 판정](access-decisions.md) 2절의 목록) 안의 구성원에게 보이고, "어느 에이전트에 지정됐나"는 그 에이전트를 볼 수 있는 사람에게만 보인다. 모든 변경은 지금의 receipt(`register_extension`, `attach_extension` 등)로 남고, 세션은 무엇을 썼는지 digest로 남긴다 |
| 라이브러리와 의존성 | 태그·분류·소유자·버전·사용 현황으로 찾는 스킬 라이브러리. 태그·분류·공개 범위는 manifest 밖의 라이브러리 메타데이터라 digest와 승인에 들지 않고 실행에 영향이 없다. werft 플러그인 manifest가 필요한 MCP 서버·도구, 실행 규칙, 지원 엔진을 선언하고, 지정·활성화·세션 시작 때 확인해 빠진 것을 이름으로 말한다([10절](#10-스킬-라이브러리-의존성-werft-플러그인-오너-요청-2026-11-20)) |
| 콘솔 | 워크스페이스 설정의 "에이전트 연결" 묶음에 **스킬**을 **MCP 서버** 옆에 둔다. 에이전트 상세의 "접근" 탭에 스킬 칸을 MCP 칸 옆에 둔다 |
| pi | 세 번째 엔진으로 붙일 가치는 있다(MIT, SDK·RPC 임베딩, 스킬·MCP 내장, 공급자 30종 이상). 다만 내장 권한·샌드박스가 없어 플랫폼이 승인 경로를 확장으로 새로 만들어야 한다. **추천: 지금은 구현하지 않고, 스파이크 하나로 승인 게이트와 체크포인트가 붙는지만 확인한다.** Oh My Pi는 엔진으로 쓰지 않는다([8절](#8-pi-coding-agent를-세-번째-엔진으로)) |

## 1. 지금 있는 것

**스킬 쪽: "확장 번들".** 이름은 확장이지만 내용은 스킬만 받는다.

- 등록 검사: 업로드한 트리를 버리고 허용 목록으로 다시 만든 트리만 해시·저장한다. `hooks/`, `.mcp.json`, `bin/`, `agents/`, `commands/`, `settings*.json`은 경로째 거절한다(`packages/platform/src/extensions/bundle-validator.ts:9-17`, `:107-118`). 남기는 것은 `skills/<name>/…`와 `.claude-plugin/plugin.json`(키 셋만)이다([2절](#2-두-개념)). 한 번들은 slug 하나 아래 스킬 여러 개를 담는다(`BundleManifest.skills`, `:64-69`).
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

**결정.** 스킬 하나 = `SKILL.md`를 가진 디렉터리 하나. 이름은 frontmatter `name`이고 워크스페이스 안에서 유일하다. 사양 밖의 엔진 전용 파일(Codex `agents/openai.yaml`, Claude plugin manifest)은 새 스킬 등록에서 받지 않는다.

- **지금 검사기와 다른 점.** 지금 검사기는 엔진 manifest를 모두 거절하지 않는다. `.claude-plugin/plugin.json`은 받아서 `name`·`version`·`description` 세 키만 남기고(다른 키는 거절), `name`은 번들 slug로 바꿔 다시 쓴다(`bundle-validator.ts:96`, `:437-474`, `:322-328`). 거절되는 것은 허용 목록 밖의 경로다: 루트의 `plugin.json`(Codex 형식)은 `path_not_allowed`, `agents/`(Codex `openai.yaml`의 자리)·`hooks/`·`.mcp.json`은 `denied_path`다(`:107-118`, `:355-376`). 새 규칙은 이렇다. 새 스킬 등록(스킬 하나)은 올린 트리의 `.claude-plugin/plugin.json`도 거절한다. 그 파일의 `version`·`description`은 스킬의 `SKILL.md`와 등록 순번이 대신하기 때문이다. 저장 트리에는 검사기가 스킬 이름만으로 만드는 고정 `.claude-plugin/plugin.json`을 지금처럼 넣는다. Claude 매핑과 digest를 바꾸지 않으려는 것이고([5절](#5-엔진-매핑)), 사람이 올린 엔진 형식이 아니다. 옛 번들 경로(여러 스킬 번들의 새 버전)는 지금 검사기 그대로다.

- **지금 번들과의 관계.** 저장·해석·receipt는 그대로 쓰고, 등록 단위만 "스킬 하나"로 좁힌다. 새 등록은 스킬이 정확히 하나인 번들이고 slug = 스킬 이름이다. 새 스킬 이름은 기존 번들의 slug와도 겹치지 못한다(엔진 이름이 겹치지 않게 하는 조건, [5절](#5-엔진-매핑)). 이미 있는 여러 스킬 번들(옛 번들)은 지금 모습 그대로 Claude에서만 계속 돌고, 새로 만들지 못한다. Codex·pi에는 옛 번들을 주지 않는다(`feature_unsupported`). 테이블 이름(`extension_*`)은 바꾸지 않는다. 바꾸는 비용(migration, 혼합 버전 worker 호환)에 비해 얻는 것이 화면의 낱말뿐이라, API와 콘솔에서만 "스킬"이라 부른다.
- **왜 하나씩인가.** 엔진마다 스킬 이름공간이 다르다. Claude는 plugin 이름을 붙여 `<plugin>:<skill>`로, Codex와 pi는 이름만으로 부른다(조사 1-6.1, 2-1.2, 2-2.6). 스킬 하나가 단위이고 이름이 워크스페이스에서 유일하면, 어느 엔진에서든 이름 하나로 겹침 없이 펼칠 수 있다. 여러 스킬을 한 번에 배포하는 편의는 콘솔의 "여러 개 업로드"로 준다.
- **부르는 조건은 엔진이 알린다.** 지금 해석기는 스킬이 있으면 도구 목록에 `Skill`이 있어야 한다고 본다(`resolve.ts:217-222`). 이것은 Claude의 조건이다. Codex에는 `Skill` 도구가 없고, Codex 어댑터는 모르는 도구 이름을 거절한다(`codex/src/config.ts:182-187`). 그래서 엔진 descriptor가 "스킬을 부르는 도구 이름"(Claude `Skill`, Codex·pi 없음)을 알리고, 해석기는 상수 대신 그 값을 본다. 없으면 도구 목록 검사를 하지 않는다.
- **스크립트.** `scripts/`는 지금처럼 받는다(`has_scripts`). 실행은 에이전트 Bash와 같은 샌드박스·env에서 엔진이 한다. 스킬은 비밀 값을 싣지 않는다. 비밀이 필요한 일은 MCP 서버로 한다.
- **MCP 의존.** 스킬은 MCP 서버를 싣지 않는다(`.mcp.json` 거절 유지). 필요한 MCP 서버·도구, 실행 규칙, 지원 엔진은 스킬을 담은 werft 플러그인의 manifest(`requires`, `engines`)가 선언하고, 지정·활성화·세션 시작 때 확인한다([10절](#10-스킬-라이브러리-의존성-werft-플러그인-오너-요청-2026-11-20)). 스킬 하나에는 이 선언 칸이 없고, 스킬을 등록할 때 함께 만들어지는 단일 스킬 werft 플러그인의 manifest에 둔다. 처음 안의 스킬 메타데이터 `requires_mcp`(경고만)는 두지 않는다. 엔진이 의존을 스스로 설치하는 기능은 계속 끈다(Codex `features.skill_mcp_dependency_install`).

### MCP 서버

**결정.** 새 개념을 만들지 않는다. 조직이 쓰는 MCP 서버는 [mcp-credentials.md](mcp-credentials.md)의 워크스페이스 서버(원격, OAuth 또는 정적 token)다. 설치 카탈로그 서버는 운영자 경로로 남긴다. 번들 stdio 서버([stdio-mcp-relay.md](stdio-mcp-relay.md))는 "번들"이 아니라 **MCP 서버의 한 종류(`stdio`, 패키지 digest로 고정)**로 다시 정의한다. 스킬 번들이 서버를 싣지 않으므로, 그 설계의 "승인된 번들이 선언한 서버"는 "승인된 stdio MCP 서버 패키지"로 읽는다. 프로세스 수명·relay·판정 결정은 그대로 유효하다. 구현 순서는 바꾸지 않는다(원격 먼저, stdio는 그 설계의 선행 티켓을 따른다).

### 엔진 플러그인을 원본으로 두지 않는 이유

- 세 엔진의 플러그인 형식이 다르고(조사 1-2, 2-1.6, 2-2.8), 그 안의 훅·명령·서브에이전트·확장 코드는 엔진 하나에만 뜻이 있다. 공통분모를 뽑으면 스킬과 MCP만 남는다.
- 플러그인은 코드 실행면이다. Claude plugin 디렉터리는 `settingSources: []`여도 `hooks/hooks.json`과 `.mcp.json`을 실행한다(`bundle-validator.ts:12-15`). 플랫폼 승인 경로 밖의 실행을 열지 않으려고 지금도 거절한다.
- Claude와 Codex의 관리 콘솔도 결국 플러그인 안의 connector·MCP를 따로 추가하게 한다(조사 1-2.1 "Plugin에 connector가 들어 있어도…", 2-1.7 "플러그인을 설치해도 커넥터나 MCP 접근 권한이 생기지 않는다"). 우리는 처음부터 둘로 나눈다.
- 그렇다고 묶음이 없는 것은 아니다. 공유·지정의 묶음은 엔진 중립인 **werft 플러그인**이고(이름은 같은 "플러그인"이지만 원본은 이것 하나다), Claude plugin 같은 엔진 형식은 어댑터가 만드는 엔진 플러그인(출력)으로만 생긴다([10절](#10-스킬-라이브러리-의존성-werft-플러그인-오너-요청-2026-11-20)).

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
- Codex: 지금 `codexProfileDigest`(`codex/src/config.ts:416-447`)는 번들을 해시하지 않는다(번들을 거절하므로 필요가 없었다). S4에서 정렬한 `(이름, digest)` 목록과 매핑 버전을 더한다. 스킬이 없는 세션은 그 필드를 넣지 않아 지금 체크포인트의 digest가 그대로다. 스킬이 있는 체크포인트를 다른 digest 목록으로 되살리려 하면 fingerprint가 달라 거절된다. MCP는 이미 정해진 규칙(좁히는 변경은 진행 중 세션에 바로, 넓히는 변경은 다음 세션부터)을 그대로 쓴다.

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
| 시작 확인 | 엔진이 보고한 스킬 집합이 기대 집합과 **정확히 같아야** 시작한다. 비교 집합과 숨은 스킬은 아래 "Claude의 시작 확인" |  `skills/list`로 같은 정확 일치. 이름과 실제 경로 둘 다 | RPC/SDK의 스킬 목록으로 같은 정확 일치 |
| MCP | `type: "sdk"` relay(지금) | `mcp_servers.<name>`에 loopback relay URL과 `enabled_tools`(지금 플랫폼 서버만, 워크스페이스 서버로 넓힘) | 내장 MCP 확장을 SDK 세션에 **명시적으로 로드**해야 한다(SDK 세션은 내장 확장을 자동으로 싣지 않는다). 설정에 relay URL, 노출 방식은 `direct`(codemode는 QuickJS가 도구를 대신 부르므로 도구 호출 기록과 승인이 한 단계 멀어진다). pi가 서버·도구 이름을 정규화하므로 플랫폼 이름 ↔ 엔진 이름 대응을 시작 때 확인한다 |
| 엔진 표 | `skills: native`, `mcp: native`, 스킬 호출 도구 `Skill` | `skills: none` → `native`, 스킬 호출 도구 없음 | 새 descriptor |

- **Codex 탐색 닫기.** Codex는 cwd에서 저장소 루트까지의 모든 `.agents/skills`, `$HOME/.agents/skills`, ADMIN `/etc/codex/skills`, 번들 시스템 스킬을 읽고, `extraRoots`는 이 루트를 대신하지 않고 더한다(조사 2-1.2, [탐색 구현](https://github.com/openai/codex/blob/main/codex-rs/ext/skills/src/host_roots.rs)). 그래서 S4는 고정한 Codex 버전에서 루트마다 닫는 방법을 확정한다: 사용자 루트는 비어 있는 세션 전용 `HOME`, ADMIN 루트는 worker 이미지에 그 디렉터리를 두지 않음, 시스템 스킬은 `[skills.bundled] enabled = false`, 저장소 쪽 `.agents/skills`는 시작 전에 어댑터가 작업 공간에서 찾은 `SKILL.md`마다 `[[skills.config]] path = … enabled = false`를 넣는다. 그리고 시작 확인의 정확 일치가 마지막 방어다. 실행 중 저장소에 새 `SKILL.md`가 생겨 `skills/changed`가 오면 그 턴을 끝내고 다음 턴 시작 전에 다시 끄고 대조한다. 이 중 하나라도 고정한 버전에서 확인하지 못하면 Codex의 스킬은 켜지 않는다(descriptor `none` 유지).
- **Claude의 시작 확인.** 지금 확인은 `initializationResult()`의 `commands`에 기대한 `<plugin>:<skill>`이 모두 있는지만 본다(`claude/src/run.ts:182-202`, `plugin-skills.ts:34-39`). 이 목록에는 엔진의 내장 명령이 섞이고, `user-invocable: false` 스킬은 빠진다(`plugin-skills.ts:13-19`). 그래서 정확 일치를 이렇게 정한다.
  1. **시작 전, 사용자 호출 가능 스킬.** 비교 집합은 `commands` 가운데 plugin 이름공간이 붙은 이름(`<plugin>:<…>`)뿐이다. 내장 명령은 이름공간이 없어 빠진다. `settingSources: []`이고 plugin은 어댑터가 넘긴 것뿐이며, 검사기가 plugin 트리의 `commands/`를 거절하므로, 이름공간이 붙은 이름은 모두 플랫폼 스킬이어야 한다. 기대 집합은 사용자 호출 가능 스킬의 `<plugin>:<skill>`이다. 빠진 것도 남는 것도 시작 거절이다.
  2. **첫 턴 시작 때, 숨은 스킬까지.** 숨은 스킬은 첫 턴 stream의 `system/init` 메시지가 싣는 스킬 목록으로 본다([Agent SDK 스킬 문서](https://code.claude.com/docs/en/agent-sdk/skills)). 이 메시지는 모델 출력과 도구 호출보다 먼저 온다. 목록이 숨은 스킬을 포함한 전체 기대 집합과 정확히 같지 않으면 어댑터는 도구 호출 전에 그 턴을 중단하고 세션을 실패로 끝낸다(`skill_set_mismatch`). 그래서 맞지 않은 세션에서는 도구가 하나도 돌지 않는다.
  3. 목록 이름의 정확한 형식(이름공간이 붙는가)은 S3이 고정한 SDK 버전에서 확인해 비교 규칙과 시험에 적는다. 확인하지 못하면 숨은 스킬(`user-invocable: false`)의 등록을 받지 않는다.
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
  - 시험(S7): 저장소의 `.mcp.json`·`.codex/config.toml`·`.agents` 아래와 엔진 사용자 설정 자리에 시험용 서버를 넣고, 엔진이 그 서버로 직접 연결하거나 token을 저장하지 않음을 확인한다.
- 스킬은 자격을 갖지 않는다. 스킬이 외부 서비스를 써야 하면 그 스킬을 담은 werft 플러그인이 그 서비스의 MCP 서버를 `requires.mcp`로 가리킨다.

### 데이터 접근 정책 (오너 결정, 2026-11-20)

오너 결정의 요지는 셋이다. 누가 호출했는지와 어떤 스킬인지에 따라 데이터를 가져가도 되는지 정한다. 개인의 MCP 연결을 쓸지 에이전트의 MCP 연결을 쓸지 정한다. 이 둘을 자기 신고 헤더가 아니라 rule-based로 정한다.

이 정책은 [접근 판정](access-decisions.md)의 **MCP 축**이다. 그 문서가 정본인 것은 여기 다시 적지 않는다: 규칙 모양(축, 요청자, 에이전트, 대상, 맥락, 스킬 칸, 첫 일치, `revision`·`rule_id`), 이행·정책 모드, 요청자(턴의 인증 근거와 그 재확인, "확인되지 않음"과 `requester_revoked`), `personal`이 맞았는데 쓸 수 없을 때의 `fallback`과 최종 거절, 개인 데이터 전제, 판정 기록, 거절 이유 이름. 이 절은 MCP에만 있는 것, 곧 egress가 **언제 무엇을 묻는지**, 개인 연결이 지나야 하는 경로, 전송 세션의 subject 고정을 정한다.

도구를 엔진에 보일지, 실행 전에 물을지는 실행 규칙(allow/deny/ask)이 정한다([9절](#9-실행-규칙지시-파일-설계와의-관계)). 접근 판정은 실행 규칙이 허용한 호출에만 서는 **그 위의 한 층**이다(접근 판정 6절의 순서).

#### 언제 무엇을 묻나

egress는 `mcp.use`를 다음 두 때에 묻는다. 매번 정책의 규칙 목록 **전체를 위에서부터 다시** 평가하고, 처음 맞는 규칙 하나가 결과다.

| 때 | 판정 요청의 도구 | 맞을 수 있는 규칙 | 결과의 쓰임 |
|---|---|---|---|
| 그 턴에서 그 서버의 첫 요청 | 없음(`tool: null`) | 도구 칸이 **비어 있는** 규칙만. 도구 칸이 있는 규칙은 도구 없는 요청에 맞지 않는다 | `allow`면 연결 종류와 subject를 그 (서버, 턴)에 고정한다. `deny`면 그 요청을 거절하고 고정하지 않는다 |
| 그 뒤의 모든 요청(`tools/list`, 스트림, `regrant`) | 없음 | 위와 같다 | 결과가 거절이면 거절, 고정한 subject와 다른 subject를 요구하면 `mcp_session_subject_changed`(아래 "전송 세션") |
| `tools/call`마다 | 그 도구(서버가 알린 이름) | 모든 규칙. 도구 칸이 있는 규칙은 그 도구가 목록에 있을 때만 맞는다 | 위와 같다 |

- **도구 규칙과 연결 규칙의 우선순위는 순서 하나로 정한다.** 도구 칸이 있는 규칙은 결과가 `deny`뿐이다(접근 판정 2절 "대상"). 그래서 `tools/call` 판정에서 도구 `deny` 규칙이 서버의 `allow` 규칙보다 **위**에 있으면 그 도구가 막히고, **아래**에 있으면 위의 `allow`가 먼저 맞아 그 도구 규칙은 아무것도 하지 않는다. "처음 맞는 규칙 하나"에 따로 더해지는 deny 단계는 없다. 콘솔은 위의 넓은 규칙에 가려 절대 맞지 않는 규칙을 저장 때 경고한다.
- 도구 규칙은 결과가 `deny`뿐이므로 `tools/call` 판정이 고른 subject는 언제나 같은 턴의 도구 없는 판정과 같은 규칙 집합에서 나온다. 다르게 나오면(그 사이 정책 `revision`이나 연결 상태가 바뀜) 아래 전송 세션 규칙대로 거절한다.
- 판정 요청의 도구 칸에는 서버가 `tools/list`로 알린 이름을 그대로 싣는다. 규칙과 콘솔이 보이는 `mcp__<서버>__<도구>`는 werft가 서버 이름을 붙여 보이는 표기이고 MCP 규약이 아니다(접근 판정 15절).
- 이 판정은 지금 egress 검사(고정한 서버 묶음, 엔드포인트 일치, 연결 상태, 도구 목록과 release deny의 교집합, `generation` 재확인)를 대신하지 않고 그 위에 더해진다(접근 판정 4절).

#### 개인 연결

`agent`는 지금의 워크스페이스 연결(`workspace_mcp_connections.subject = 'workspace'`)이다. `personal`은 연결 행의 `subject = 'user:<id>'`다. [mcp-credentials.md](mcp-credentials.md) 결정 1은 subject를 넓힐 자리를 남겼고, 그 문서의 LATER "요청자 본인의 계정"을 이 결정이 연다. CHECK를 넓히는 것으로는 부족하다. 지금 연결 조회·잠금·비밀 저장은 subject를 `'workspace'`로 고정하고(`packages/db/src/musterrolle/workspace-mcp.ts:41`), 호출 receipt의 `generation` 재확인도 그렇다(`workspace-mcp-egress.ts`). 개인 연결 단계([접근 판정](access-decisions.md) 11절 B5)는 판정이 고른 `(server_id, subject)`를 다음 모두에 관통시킨다. 이 표는 그 단계가 지나야 하는 MCP 쪽 경로의 목록이다.

| 경로 | 바뀌는 것 | mcp-credentials.md |
|---|---|---|
| OAuth 시작·콜백 | 개인 흐름은 `workspace.manage`가 아니라 "인증된 본인 + 지금 구성원"을 본다. 흐름 행이 subject를 갖고, 콜백 저장 때 같은 사람·지금 구성원인지 다시 본다 | 결정 3(동의 흐름, 콜백 재검사) |
| 비밀 값 | owner_ref `<server uuid>:user:<id>`. purpose는 같다 | 결정 4 |
| 갱신·끊기·이탈 | 연결 행 잠금이 subject를 포함한다. 구성원 이탈·비활성 때 그 사람의 개인 연결을 모두 끊는다 | 결정 3(끊기, 떠날 때) |
| egress 자격 조회와 `accepted` receipt | 판정이 고른 subject의 연결 행을 `FOR SHARE`로 잡고 그 `generation`을 receipt에 남긴다 | 결정 6, 7 |
| 서버 등록 | 그대로 관리자만. 개인 연결은 등록된 서버에만 만든다 | 결정 2 |

워크스페이스 연결의 관리자 권한과 개인 연결의 본인 권한은 서로를 대신하지 않는다. 관리자는 남의 개인 연결을 만들거나 쓰지 못하고, 끊는 것만(보안 대응) 할 수 있다.

#### 개인 연결의 전제

개인 연결로 가져온 데이터는 transcript에 남아 세션을 읽는 사람에게 보인다. 그래서 `personal`을 쓸 수 있는 조건(요청자가 확인된 사람이고 세션 소유자, 세션 공유 범위 `private`, 판정이 세션 행을 `FOR UPDATE`로 잡고 개인 표시를 먼저 commit, 표시가 있는 세션의 공유·이관은 본인 확인)은 [접근 판정](access-decisions.md) 2절의 "개인 기억·개인 연결의 전제"가 정본이다. 처음 이 문서에 따로 적었던 전제(공유와 판정이 `FOR SHARE`로 경합)는 그 문서의 표시 commit 규칙으로 바뀌었다. MCP 쪽에서 더할 것은 하나다: 전제가 깨져 `personal`을 쓸 수 없게 되면 그 판정의 결과(`fallback: agent` 또는 최종 거절)가 고정한 subject와 달라지므로, 아래 전송 세션 규칙이 그 (서버, 턴)의 upstream 세션을 버리게 한다.

#### 전송 세션

`tools/list`·스트림·핸드셰이크는 도구 단위가 아니므로, 연결은 위처럼 **(서버, 턴)** 단위로 정한다. 턴 동안 고정하는 것은 **subject(어느 연결)뿐이고 허용 판정은 고정하지 않는다.** 그 뒤의 모든 요청은 지금 정책(지금 `revision`)과 `personal` 전제로 다시 판정한다. 결과가 거절이면 그 요청을 바로 거절한다(턴 도중 규칙을 지우거나 서버를 막으면 다음 요청부터 막힌다). 결과가 고정한 것과 다른 subject를 요구하면(예: 개인 연결이 끊겨 `fallback: agent`로 바뀜) 그 요청을 `mcp_session_subject_changed`로 거절하고, relay가 upstream 상태를 버리고 다시 시작할 때 새 subject로 고정한다.

지금 relay는 서버마다 upstream MCP client 하나를 다시 쓴다(`claude/src/remote-mcp.ts:65-79`, `codex/src/mcp-relay.ts:69-89`). 한 계정으로 연 MCP 상태를 다른 subject가 이어 쓰지 않게 해야 한다. 무엇이 "MCP 상태"인지는 서버가 쓰는 MCP 개정에 따라 다르다. 2026-07-28 개정은 `initialize` 핸드셰이크와 프로토콜 세션(`Mcp-Session-Id` 헤더)을 없앴고, 버전과 능력을 요청마다 `_meta`에 싣고, GET 스트림을 `subscriptions/listen`으로 바꿨다([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)). 옛 개정의 서버와 새 개정의 서버가 함께 있으므로 둘 다 정한다.

| | 옛 개정(2025-11-25까지): 세션 있음 | 2026-07-28: 세션 없음 |
|---|---|---|
| (서버, 턴)의 첫 요청 | `initialize` | `server/discover` 또는 첫 요청 |
| 묶는 것 | egress가 upstream이 준 `Mcp-Session-Id`를 그것을 연 `(attempt, 서버, subject, generation)`에 묶어 기록한다. 다른 묶음의 요청이 그 id를 실으면 `mcp_session_subject_changed`로 거절하고 upstream에 보내지 않는다 | 묶을 세션 id가 없다. egress는 요청마다 고정한 subject와 판정 결과를 비교하고, 다르면 같은 이유로 거절한다. 그 턴에 열린 `subscriptions/listen` 스트림은 연 subject에 묶어, subject가 바뀌면 egress가 끊는다 |
| 서버가 만든 상태 | 세션 안에 있다. 세션을 버리면 함께 버려진다 | 서버가 만들어 도구 인자로 주고받는 handle에 있다. egress는 handle을 해석하지 않는다. subject가 바뀐 뒤 엔진이 옛 handle을 다시 보내면 새 계정의 token과 함께 간다. 다른 계정이 만든 handle을 거절하는 것은 서버의 일이다. 이 한계를 운영 문서의 "개인 연결" 안내에 적는다 |
| 목록 캐시 | relay가 `tools/list` 결과를 subject마다 따로 둔다 | 같다. 결과의 `cacheScope`가 `private`이면 다른 subject에 다시 쓰지 않고, `ttlMs`보다 오래 쓰지 않는다 |

- relay는 `mcp_session_subject_changed`를 받으면 그 서버의 upstream client를 버리고 다시 시작한다. 정책 모드인 워크스페이스에서는 턴이 시작될 때마다 relay의 upstream client를 새로 만든다(턴 사이에 요청자가 바뀔 수 있다).
- 연결 끊기·재인증으로 `generation`이 바뀌면 지금처럼 다음 `regrant`에서 스트림이 끊기고, 위 규칙으로 새로 고정한다.
- 어느 개정을 쓰는지는 서버가 정하고, relay는 두 개정의 감지·되돌림 규칙을 따른다. 판정과 subject 고정은 개정과 무관하게 같다. 판정은 요청마다 서기 때문이다(접근 판정 15절).

#### 판정 자리와 거절

지금 egress 판정(`packages/platform/src/workers/workspace-mcp-egress.ts`, [mcp-credentials.md](mcp-credentials.md) 결정 6)이 요청마다 세션 상태를 다시 읽는 자리에서 `mcp.use`를 묻고, 결과의 `credential`로 연결 행을 골라 `Authorization`을 붙인다(접근 판정 5절). 거절 이유는 접근 판정의 목록(`access_policy_denied`, `personal_connection_unavailable`, `requester_unresolved`, `requester_revoked` 등)을 쓰고, MCP에만 있는 `mcp_session_subject_changed` 하나를 egress 거절로 더한다. 엔진에는 지금처럼 도구 오류로만 보인다. 정책을 고치는 화면과 권한은 접근 판정의 단계(B2, B3)가 맡는다.

**실행에 닿는 범위는 새 개념이 아니다.** 어떤 에이전트를 누가 쓸 수 있는지는 지금의 에이전트 권한 관리([agent-rbac.md](agent-rbac.md): 담당 팀, 에이전트 관리자, 세션 공유)가 정한다. 스킬과 MCP 서버는 에이전트에 지정되므로 그 에이전트를 쓸 수 있는 사람의 실행에만 닿는다. 라이브러리의 플러그인 공개 범위([10절](#10-스킬-라이브러리-의존성-werft-플러그인-오너-요청-2026-11-20))는 누가 라이브러리에서 보고 지정 화면에서 고를 수 있나만 정하고, 실행 중 판정의 입력이 아니다(접근 판정 2절 "스킬 공유 범위"). MCP 서버에는 공개 범위를 두지 않는다.

**기록은 판정 기록과 도구 사용 로그다.** 판정마다 접근 판정의 기록(`authz_decisions`의 축 칸: 요청자, 규칙 모드·`revision`·`rule_id`·순번, 연결 종류·subject·`generation`·`fallback`)이 남고, MCP 호출의 도구 호출 감사 행([관측과 도구 호출 감사](observability-otel-and-tool-call-audit.md))이 그 판정을 `access_decision_id`로 가리킨다(접근 판정 7절). 지금의 `call_mcp` receipt는 그대로 둔다. 개인 연결의 subject는 사용자 id이고 외부 계정 식별자는 남기지 않는다([mcp-credentials.md](mcp-credentials.md) 결정 7과 같다).

**사용량·비용 귀속은 지금 것을 쓴다.** 세션 사용량 장부([세션 사용량 장부](provider-usage-ledger.md))와 지금의 사용량 화면을 그대로 적용한다(오너 결정). 이 설계는 더하지 않는다.

## 7. 권한, receipt, 콘솔

### 권한

| 동작 | 누가 | 근거 |
|---|---|---|
| 스킬·werft 플러그인 제출·새 버전·Git 새 커밋 확인 | 워크스페이스 구성원(`pending`으로 들어감) | 라이브러리 기여([10절](#10-스킬-라이브러리-의존성-werft-플러그인-오너-요청-2026-11-20)). 지금 서비스는 관리자만 받으므로 넓힌다. 승인 전에는 어디에도 지정되지 않는다 |
| 태그 달기·떼기 | 그 플러그인을 볼 수 있는 구성원 | 라이브러리 메타데이터. digest와 승인에 들지 않고 실행에 영향이 없다. 누가 했는지 남김 |
| 분류 정하기 | 워크스페이스 관리자 | 라이브러리 메타데이터(분류 목록도 관리자가 정한다) |
| 공개 범위 정하기 | 제출한 사람은 제출 때 제안하고 좁힐 수 있다. 넓히기와 승인 때 확정은 워크스페이스 관리자 | 라이브러리 메타데이터. 넓어질 때 관리자를 거치는 것은 [10절](#10-스킬-라이브러리-의존성-werft-플러그인-오너-요청-2026-11-20) |
| 승인·거절, 보관 | 워크스페이스 관리자, 등록한 사람이 아닌 사람([3절](#3-등록)) | 위와 같음 |
| 워크스페이스 범위 지정 | 워크스페이스 관리자 | 위와 같음 |
| 에이전트 범위 지정(승인된 버전만) | 그 에이전트의 관리자(담당 팀 lead, 개인 관리자, 관리자 팀 구성원)와 워크스페이스 관리자 | 에이전트 MCP 켜기·끄기(`agent.manage`)와 같은 축. 지금 서비스는 워크스페이스 관리자만 받으므로 넓힌다 |
| 세션에서 `optional` 켜기 | 그 에이전트를 실행할 수 있는 사람 | 세션 생성 권한 |
| 카탈로그 보기(이름, 버전, 출처, 승인 상태, 워크스페이스 범위 지정) | 그 플러그인의 공개 범위 안의 구성원, 제출한 사람, 워크스페이스 관리자. 이미 워크스페이스 범위에 지정된 플러그인은 구성원 모두(실행에 닿는 것을 숨기지 않는다) | `workspace.read`와 공개 범위 |
| 에이전트 범위 지정에서 고르기 | 위 "카탈로그 보기"가 되는 사람 가운데 그 에이전트의 관리자 | 보이지 않는 플러그인은 고를 수 없다 |
| 에이전트 범위 지정 보기(어느 에이전트에 어느 버전, 그 개수, 그 receipt) | 그 에이전트를 볼 수 있는 사람만. 목록·개수·receipt를 에이전트 읽기 권한으로 거른다 | 담당 팀 밖에는 에이전트가 보이지 않는다([agent-rbac.md](agent-rbac.md) 2026-11-16 후속). 지정 관계가 숨긴 에이전트를 드러내면 안 된다 |

모든 쓰기는 콘솔 세션(사용자 주체)에서만 받는다. API key로는 할 수 없다([mcp-credentials.md](mcp-credentials.md) 결정 2와 같은 규칙).

### receipt와 결정 기록

- 등록·승인·거절·지정·해제·보관은 각각 receipt를 같은 transaction에서 쓴다. 지금 있는 `register_extension`(`ports/extension-bundle-store.ts:75-78`), 승인 receipt, `attach_extension`·`detach_extension`을 그대로 쓰고, 없는 것은 보관(`archive_extension`)과 라이브러리 메타데이터 변경(`update_extension_metadata`, [10절](#10-스킬-라이브러리-의존성-werft-플러그인-오너-요청-2026-11-20)) 둘만 더한다. 종류 이름을 "skill"로 바꾸지 않는다(지난 receipt 조회가 두 이름을 알아야 한다). 대상에는 이름·digest·출처(Git이면 커밋)를 남긴다.
- 세션은 시작 때 해석 결과(이름, digest, 범위)를 이벤트로 남긴다. 그래서 "이 세션은 어떤 스킬의 어느 버전으로 돌았나"를 receipt와 세션 이벤트만으로 답할 수 있다. Claude Enterprise의 Compliance API가 스킬·플러그인 이벤트를 남기는 것(조사 1-5)과 같은 수준이고, 엔진 로컬 기록에 기대지 않는다는 점은 Codex 문서가 Compliance API의 한계로 적은 것(조사 2-1.7)을 피한다.
- 스킬 사용 자체(엔진이 스킬을 읽거나 부른 것)와 MCP 도구 사용은 도구 호출 감사([관측과 도구 호출 감사](observability-otel-and-tool-call-audit.md))가 다룬다. 새 감사 레코드는 만들지 않고, MCP 호출 행은 접근 판정의 기록을 `access_decision_id`로 가리킨다([6절](#6-mcp-자격과-데이터-접근-정책)).

### 콘솔 메뉴

```text
워크스페이스 설정
  └ 에이전트 연결
      ├ 통합 (Slack, GitHub)        지금
      ├ 모델 연결                    지금
      ├ MCP 서버                     지금
      ├ 접근 정책                    접근 판정 설계의 규칙 화면(그 문서 B3). MCP 축 규칙도 여기서 고친다
      └ 스킬 라이브러리              새로(아래는 관리자에게만 보이는 칸 포함)
          ├ 목록: 이름, 최신 승인 버전, 대기 중 버전 수, 태그·분류, 공개 범위, 워크스페이스 지정 모드, 쓰는 에이전트 수(보는 사람이 읽을 수 있는 에이전트만)
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

Claude는 스킬과 플러그인을 한 화면(Plugins & skills)에, connector를 다른 화면에 둔다(조사 1-0). 우리는 엔진 플러그인을 원본으로 두지 않으므로 "MCP 서버"와 "스킬 라이브러리"(스킬과 werft 플러그인)를 같은 묶음의 이웃 항목으로 둔다. 둘 다 "에이전트에 주는 능력"이라 한 묶음이 맞고, 자격(MCP)과 내용 승인(스킬)은 일의 모양이 달라 한 화면에 합치지 않는다.

## 8. pi coding agent를 세 번째 엔진으로

### 무엇인가(조사 2-2)

MIT 오픈소스 코딩 에이전트다. 저장소는 `earendil-works/pi`(옛 `badlogic/pi-mono`)이고 패키지는 `@earendil-works/pi-coding-agent`다. 1.0(2026-10-01) 뒤 거의 매주 릴리스한다. 임베딩은 SDK(`createAgentSession`), `--mode rpc`(stdin/stdout JSONL), `--mode json` 셋이다. 세션은 `id`/`parentId` 트리의 JSONL 파일이다. 공급자는 30종 이상이다. 스킬은 Agent Skills 사양을 구현하고, MCP는 0.99.0(2026-09-29)부터 내장 확장으로 지원한다(그 전에는 "지원하지 않는다"가 공식 입장이었다). **내장 권한·샌드박스가 없다.** 도구 호출 게이트는 확장의 `tool_call` 훅으로 만든다.

### 가치

- **공급자 중립.** Claude 어댑터는 Anthropic Messages(직접 또는 LiteLLM), Codex는 OpenAI Responses에 묶여 있다. pi는 공급자 30종 이상을 엔진 하나로 받는다. 고객이 쓰는 모델이 둘 밖일 때의 길이 된다.
- **스킬·MCP 모델과 잘 맞는다.** 이 설계의 두 개념을 pi가 그대로 읽는다. 엔진 플러그인에 해당하는 "pi 패키지"·확장은 어댑터의 출력으로만 쓴다.
- **임베딩이 깨끗하다.** RPC 모드는 Codex app-server와 같은 모양(프로세스 하나, JSONL)이라 codec-kit의 이벤트 codec 구조(`packages/adapters/runtimes/codec-kit`)와 registry의 descriptor 방식에 들어간다.

### 비용과 맞춤

| 항목 | 해야 할 일 | 크기 |
|---|---|---|
| 승인·권한 | pi에는 승인 경로가 없다. worker 안에서 도는 확장을 만들어 `tool_call` 훅에서 플랫폼 판정(묻기·막기·승인 대기)을 하고, 승인 대기 동안 프로세스를 살려 둔다([agent-sdk.md](agent-sdk.md) 운영 제약 1과 같은 요구). 확장은 pi 프로세스와 같은 권한이라 엔진 쪽 코드가 플랫폼 경계 안에 들어온다 | 큼 |
| 샌드박스 | pi는 격리를 하지 않는다. 지금 worker 컨테이너·supervisor 경계([worker-supervisor-boundary.md](worker-supervisor-boundary.md))가 그대로 격리가 된다. Codex의 bubblewrap 같은 엔진 내부 샌드박스는 없다 | 중간 |
| 체크포인트·resume | JSONL 세션 파일을 체크포인트에 담고 되살리는 일. 트리 구조라 Claude transcript mirror보다 단순할 수 있으나 확인 필요 | 중간 |
| 이벤트 codec | RPC 이벤트를 공개 SSE 이벤트로 바꾸는 codec과 계약 시험 | 중간 |
| 엔진 이미지 | Node 22.19 이상 이미지 하나 더([engine-worker-images.md](engine-worker-images.md)) | 작음 |
| 지시 파일 | pi는 `AGENTS.md`·`CLAUDE.md`를 trust와 무관하게 읽는다. 지시 파일을 어떻게 넣을지는 실행 규칙·지시 파일 설계가 정한다([9절](#9-실행-규칙지시-파일-설계와의-관계)) | 그 설계에 따름 |

### 위험

- **보안 모델의 차이.** Claude·Codex는 엔진이 묻고 플랫폼이 답한다. pi는 엔진이 묻지 않으므로 플랫폼이 엔진 안에 게이트를 심어야 한다. 게이트가 빠진 도구(새 버전이 더한 내장 도구, MCP `codemode`가 대신 부르는 호출)는 묻지 않고 돈다. 엔진 버전을 올릴 때마다 도구 목록을 대조하는 시험이 필요하다.
- **변화 속도.** 1.0 뒤 매주 릴리스이고 MCP 입장도 1년 안에 뒤집혔다. [agent-sdk.md](agent-sdk.md)처럼 정확한 버전 고정과 호환 harness가 필요하다.
- **기여 정책.** 새 기여자의 이슈·PR을 자동으로 닫는다. 상류에 고칠 것이 생기면 우회해야 한다.

### Oh My Pi

`can1357/oh-my-pi`, MIT, pi의 fork다(README가 그렇게 적는다). Rust 네이티브 코어, LSP·DAP, worktree 서브에이전트, 네이티브 MCP, 승인 모드(기본 `yolo`)를 더했다. Claude·Codex·Gemini·OpenCode의 MCP 설정과 스킬을 **자동으로 가져오고**, 저장소를 열면 설정·확장·훅·스킬·MCP를 "의도대로" 불러온다(조사 2-3). 월 40건 넘게 릴리스한다.

**쓰지 않는다.** 이 설계가 막으려는 것(저장소 내용이 승인 없이 스킬·MCP·훅이 되는 것)을 기본 동작으로 한다. 끌 수는 있지만 끌 것이 많고 릴리스 속도가 빨라 매번 확인해야 한다. 엔진으로 붙인다면 pi 본체가 맞다. Oh My Pi의 기능(LSP, 서브에이전트) 중 필요한 것이 생기면 그때 기능 단위로 다시 본다.

### 추천

**지금은 구현하지 않는다.** 먼저 이 설계의 Claude·Codex 단위([14절](#14-단계별-구현-계획))를 끝내 두 엔진에서 스킬·MCP 모델이 같게 동작함을 보인다. 그 뒤 **스파이크 하나**(코드는 머지하지 않음)로 다음 셋을 확인하고, 셋 다 되면 pi 엔진을 별도 설계로 올린다.

1. `tool_call` 훅 확장이 내장 도구와 MCP 도구 호출을 **모두** 받고, 플랫폼 승인 대기 동안 프로세스를 살린 채 막을 수 있다.
2. RPC 모드에서 세션 JSONL을 체크포인트로 담고 다른 컨테이너에서 resume할 수 있다.
3. 사용자·프로젝트 탐색을 끄고 세션 전용 스킬 루트와 relay MCP만 보이게 할 수 있다. SDK 세션에 내장 MCP 확장을 명시적으로 로드하고, pi가 정규화한 서버·도구 이름이 플랫폼 이름과 1:1로 대응한다.

엔진을 하나 더 붙이는 이유가 "공급자 중립"이라면, 고객 요구(둘 밖의 모델)가 생기는 때가 시작 조건이다.

## 9. 실행 규칙·지시 파일 설계와의 관계

명령·도구의 allow/deny 규칙과 지시 파일(`CLAUDE.md`·`AGENTS.md`)을 엔진에 어떻게 넣을지는 별도의 실행 규칙·지시 파일 설계가 정한다. 이 문서는 그 둘을 다루지 않는다. 겹치는 곳은 세 가지뿐이다.

- 6절의 데이터 접근 정책(접근 판정의 MCP 축)은 실행 규칙 **위의** 층이다. 판정 순서는 실행 규칙(보일지·물을지·막을지)이 먼저이고, 허용된 MCP 호출에만 접근 판정이 데이터를 가져가도 되는지와 연결을 정한다. 실행 규칙은 worker·엔진 쪽 평가기에서, 접근 판정은 control-host egress에서 돌고, 두 기록은 `access_decision_id`로 이어진다([접근 판정](access-decisions.md) 6절). 둘 다 자기 신고 입력을 받지 않는다는 원칙을 같이 쓴다. 규칙 문법은 합치지 않는다(접근 판정의 대안 절).

- MCP 도구를 좁히는 것은 이 문서에서 claim의 도구 목록(Codex `enabled_tools`, Claude relay의 고정 목록)으로 한다. deny 문법이 엔진마다 어떻게 표현되는지는 그 설계의 몫이다.
- 스킬 경로를 놓을 때 엔진의 project 설정 로딩을 켜지 않는다는 이 문서의 전제(Claude `settingSources: []`, Codex 저장소 `.codex` 미신뢰, pi project trust 없음)는 지시 파일을 엔진이 아니라 플랫폼이 넣는다는 지금 방식과 같은 방향이다. 그 설계가 이 전제를 바꾸면 5절의 "다른 탐색 닫기"를 다시 본다.

## 10. 스킬 라이브러리, 의존성, werft 플러그인 (오너 요청, 2026-11-20)

오너 요청은 셋이다. 여러 사람이 태그를 달아 분야별로 스킬을 찾고 쓰는 사내 라이브러리를 둔다. 스킬을 쓸 때 함께 필요한 MCP와 도구를 적는다. 그리고 엔진마다 맞춰 변환하는 추상화 층을 둔다. 마지막 요청은 "그러면 플러그인 개념이 필요한가"라는 질문과 함께 왔다. 답은 이 절의 끝에 있다.

### werft 플러그인

**결정.** 공유와 지정의 단위를 **werft 플러그인**로 둔다. 플러그인는 엔진 중립인 werft 고유 manifest 하나이고, 이 manifest는 다른 것을 **가리키기만** 한다.

| manifest 칸 | 뜻 | 누가 정의하나 |
|---|---|---|
| `name`, `description` | 이름과 설명. 라이브러리 검색이 읽는다 | 이 문서 |
| `skills` | 스킬 이름과 digest의 목록. 플러그인 버전이 스킬 버전을 고정한다 | 이 문서([2절](#2-두-개념)의 스킬) |
| `requires.mcp` | 필요한 MCP 서버 이름, 선택으로 도구 이름(`mcp__<서버>__<도구>`) | 이 문서([6절](#6-mcp-자격과-데이터-접근-정책)의 서버) |
| `requires.rules` | 필요한 실행 규칙(예: 어떤 명령을 허용해야 한다) | 규칙의 문법과 "충족"의 판정은 실행 규칙 설계([9절](#9-실행-규칙지시-파일-설계와의-관계))가 정한다. 이 문서는 칸과 확인 시점만 정한다 |
| `instructions` | 플러그인가 에이전트에 더하는 지시 조각 | 지시를 엔진에 넣는 방법은 실행 규칙·지시 파일 설계가 정한다. 플러그인는 텍스트만 싣는다 |
| `engines` | 지원 엔진 목록(`claude`, `codex`, 나중에 `pi`). 비우면 "스킬과 MCP만 쓰므로 모든 엔진" | 이 문서 |

- **저장.** manifest는 정규화한 JSON으로 저장하고 그 해시가 플러그인 digest다. 스킬 digest를 담으므로 플러그인 digest 하나가 내용 전체를 고정한다. 등록·승인·버전·보관은 [3절](#3-등록)의 스킬 규칙과 같다(새 버전 = 새 digest, 다른 사람이 승인). manifest에 든 칸은 위 표가 전부이고, 모두 실행에 영향이 있으므로 바뀌면 새 버전과 승인을 거친다. 태그·분류·공개 범위는 manifest에 넣지 않는다(아래 "스킬 라이브러리").
- **엔진 형식은 받지 않는다.** Claude `plugin.json`, Codex `plugin.json`·`config.toml` 조각, pi 패키지·확장은 원본으로 받지 않는다. werft 플러그인은 manifest JSON 하나로 제출하고 파일 트리를 받지 않으므로, 엔진 형식이 들어올 자리가 없다. 스킬 트리 쪽은 [2절](#2-두-개념)대로다: 지금 검사기는 `.claude-plugin/plugin.json`을 키 셋만 남겨 받고 루트 `plugin.json`·`agents/`는 거절하며, 새 스킬 등록은 올린 `.claude-plugin/plugin.json`도 거절한다. 저장 트리의 고정 `.claude-plugin/plugin.json`은 검사기가 스킬 이름만으로 만든다.
- **지정 단위.** [4절](#4-지정-버전-고정-배포)의 해석기는 플러그인 이름을 단위로 접는다(`required`/`optional`/`forbidden`, 범위 순서 그대로). 스킬 하나만 쓰고 싶으면 스킬을 등록할 때 같은 이름의 단일 스킬 werft 플러그인가 함께 만들어진다.
- **`forbidden`은 펼친 결과에도 걸린다.** 플러그인 이름으로만 접으면, 바깥 범위가 스킬 `foo`(그 단일 스킬 플러그인 `foo`)를 `forbidden`으로 두어도 `foo`를 담은 다른 승인 플러그인 `bar`를 안쪽 범위에 지정해 `foo`를 되살릴 수 있다. 그래서 정한다. 어떤 범위가 플러그인 P를 `forbidden`으로 두면 P의 이름과 **P가 담은 스킬 이름 모두**가 그 범위와 안쪽에서 금지된다(버전과 상관없이 이름으로). 해석기는 접은 뒤 플러그인을 스킬로 펼치고, 펼친 스킬 이름 가운데 금지된 것이 있으면 그 스킬을 담은 플러그인을 거절한다. 지정 때(`required`면 저장 거절, `optional`이면 "켤 수 없음"과 이유), release 활성화 때, 세션 시작 때 같은 검사를 한다. 이유는 `extension_forbidden`이고 금지한 범위와 플러그인을 이름으로 말한다. 여러 스킬 플러그인을 금지하면 그 안의 스킬 모두가 금지되는 것은 의도한 것이다. 금지는 안전 장치라 넓게 걸리는 쪽이 맞다. 지금의 `extension_bundles`·`extension_attachments`는 "스킬 트리 저장"과 "플러그인 지정"으로 역할이 나뉜다. 지정 행이 플러그인 digest를 가리키게 바꾸는 migration은 S8의 일이다. 옛 번들 지정은 그대로 읽는다.
- **겹침.** 한 세션에 펼쳐진 플러그인들의 스킬 이름이 엔진 이름 기준으로 겹치면 거절한다([5절](#5-엔진-매핑)의 검사를 그대로 쓴다). 두 플러그인가 같은 스킬의 같은 digest를 담으면 한 번만 펼친다. 다른 digest를 담으면 겹침으로 거절한다.

### 엔진 어댑터가 하는 변환

플러그인는 해석이 끝나면 "스킬 트리 목록 + MCP 서버 목록(relay) + 실행 규칙 + 지시 조각"으로 펼쳐진다. 어댑터는 이것을 엔진의 형식으로 **출력**한다.

| | Claude | Codex | pi(가정) |
|---|---|---|---|
| 스킬 | 스킬마다 로컬 plugin 디렉터리(지금, `contract.ts:130-140`). 엔진 플러그인(출력)인 Claude plugin은 여기서만 생긴다 | 세션 스킬 루트([5절](#5-엔진-매핑)) | 세션 agent dir의 `skills/` |
| MCP | `type: "sdk"` relay | `mcp_servers.<name>` override | MCP 확장 설정 |
| 실행 규칙·지시 | 실행 규칙·지시 파일 설계의 Claude 출력 | 같은 설계의 Codex 출력 | 같은 설계의 pi 출력(확장의 `tool_call` 게이트) |

그래서 엔진이 늘어도 바뀌는 것은 어댑터의 출력 한 열이다. 플러그인와 라이브러리와 해석기는 그대로다.

### 의존성 확인

`requires`는 선언으로 끝나지 않는다. 세 시점에 확인하고, 빠진 것을 이름으로 말한다.

| 시점 | 확인 | 빠졌을 때 |
|---|---|---|
| 지정(워크스페이스·에이전트 범위) | `requires.mcp`의 서버가 워크스페이스에 등록돼 있고 이 에이전트(워크스페이스 범위면 지정 화면이 고른 에이전트)가 켰는가. 도구 이름이 저장된 도구 목록에 있고 deny에 걸리지 않는가. `requires.rules`를 실행 규칙 판정기가 충족한다고 하는가. 에이전트의 엔진이 `engines`에 있는가 | `required`: 저장 거절, 빠진 것 목록(`missing: [{kind: "mcp", server, tool?}, {kind: "rule", …}, {kind: "engine", …}]`). `optional`: 저장은 하되 그 에이전트에서는 "켤 수 없음"과 이유를 보인다 |
| release 활성화 | 위와 같다. 지금 `checkAgentExtensions`(`agent-service.ts:225-240`)가 하는 거절 경로에 더한다 | 활성화 거절, 같은 목록 |
| 세션 시작 | 위와 같고, 더해 MCP 연결 상태(`active`인가, 정책이 이 요청자에게 허용하는가) | 서버 미등록·꺼짐·엔진 불일치·규칙 불충족은 시작 거절. 연결이 `needs_reauth`이거나 정책이 이 요청자를 막는 것은 시작은 하되 세션 시작 이벤트와 화면에 "이 플러그인의 MCP가 지금 쓸 수 없음"을 남긴다(런타임 상태라 지정 때는 알 수 없다) |

이것이 처음 안의 스킬 메타데이터 `requires_mcp`(경고만)를 대신한다([2절](#2-두-개념)).

### 스킬 라이브러리

라이브러리는 워크스페이스의 승인된 플러그인와 스킬을 찾아보는 화면과 API다. 새 저장소가 아니라 위 manifest와 지정·세션 기록을 읽는다.

- **찾기.** 이름·설명 검색, 태그(자유 입력, 워크스페이스 안), 분류(관리자가 정한 목록에서 하나), 지원 엔진, 필요한 MCP 서버로 거른다.
- **보이는 것.** 소유자(등록한 사람과 관리 팀), 버전 기록(digest, 출처, 승인한 사람), 필요한 것(`requires`), 사용 현황. 사용 현황은 "쓰는 에이전트 수"와 "최근 30일 세션 수"이고, 둘 다 보는 사람이 읽을 수 있는 에이전트·세션만 센다([7절](#7-권한-receipt-콘솔)의 에이전트 읽기 거름과 같다).
- **라이브러리 메타데이터.** 태그, 분류, 공개 범위는 플러그인 이름에 붙는 메타데이터다. manifest에 들지 않으므로 digest를 바꾸지 않고, 버전이 바뀌어도 이어진다. 셋 다 실행에 영향이 없다(실행에 닿는 것은 지정이다). 바꿀 때마다 누가 무엇을 바꿨는지 receipt(`update_extension_metadata`)로 남긴다.
- **태그.** 그 플러그인을 볼 수 있는 구성원 누구나 승인된 플러그인에 태그를 달고 뗄 수 있다. 승인을 거치지 않는다.
- **분류.** 워크스페이스 관리자가 정한 목록에서 하나를 관리자가 고른다.
- **공개 범위.** [접근 판정](access-decisions.md) 2절의 공개 범위 목록을 그대로 쓴다: `private`(제출한 사람과 워크스페이스 관리자), `people`(지정한 구성원), `team`(지정한 팀), `workspace`(구성원 모두, 기본값). 라이브러리 목록·검색·상세와 지정 화면에서 누가 그 플러그인을 보고 고를 수 있나만 정한다. 제출한 사람은 제출 때 범위를 제안하고 좁힐 수 있다. 넓히는 것과 승인 때의 확정은 워크스페이스 관리자만 한다. 공개 범위를 좁혀도 이미 있는 지정은 그대로 돌고(지정이 실행을 정한다), 워크스페이스 범위에 지정된 플러그인은 범위와 상관없이 구성원 모두에게 보인다. 바꾸는 화면이 이것을 알린다.
- **기여.** 구성원 누구나 플러그인와 스킬을 제출할 수 있다(`pending`). 승인은 지금처럼 워크스페이스 관리자, 제출한 사람이 아닌 사람이다. Claude 조직 설정의 "Publishing: Requires review"와 같은 모양이다(조사 1-1.6). 지정은 [7절](#7-권한-receipt-콘솔)의 권한 그대로다.
- **쓰기.** 라이브러리에서 "이 에이전트에 지정"을 누르면 의존성 확인을 거친 지정 화면으로 간다.

### werft 플러그인과 엔진 플러그인

이 절은 "엔진 플러그인을 원본으로 두지 않는다"는 [2절](#2-두-개념)의 결정을 바꾸지 않는다. 오너의 질문("그러면 플러그인 개념이 필요한가")에 대한 답은 이렇다. **플러그인 개념은 둔다. 다만 원본은 엔진 중립의 werft 플러그인 하나이고, 엔진마다 다른 플러그인은 그것의 출력 형식이다.** 이름: 사용자에게는 "werft 플러그인", 엔진 쪽 결과물은 이 문서에서 "엔진 플러그인(출력)"이라 부른다.

- **원본 개념**은 스킬, MCP 서버, werft 플러그인 셋이다. 플러그인는 스킬과 MCP·규칙·지시를 **가리키는** manifest일 뿐이고, 훅·명령·서브에이전트·엔진 확장 코드를 싣지 않는다. 엔진 하나에만 뜻이 있는 것을 담지 않으므로, 2절이 플러그인을 버린 두 이유(엔진마다 형식이 다름, 승인 밖의 실행면)에 해당하지 않는다.
- **엔진 플러그인(출력)**인 Claude plugin, Codex config 조각, pi 확장 설정은 어댑터가 세션마다 만들고 버린다. 저장하지 않고, 사람이 편집하지 않고, 승인 대상도 아니다. 승인 대상은 그 원본인 werft 플러그인 digest다.
- 그래서 엔진 하나를 더 붙이는 비용은 어댑터의 출력 하나다. 반대로 플러그인을 원본으로 두면 엔진 수만큼 형식과 승인 경로가 생긴다.

## 11. 조사 요약과 시장 동향

2026-11-20에 공개 자료로 조사했다. 스킬과 MCP 서버를 등록·버전 고정·배포·엔진에 넣는 일에 닿는 것만 적는다. 엔진과 관리 콘솔의 자세한 동작은 [조사 문서](skills-and-mcp-research.md)에 있고, 기억과 권한 판정 쪽은 [기억 레이어](memory-layer.md) 11절과 [접근 판정](access-decisions.md) 14절에 있다. 공식 문서나 1차 출처로 확인하지 못한 것은 쓰지 않았다.

### 표준

- **Agent Skills.** `SKILL.md`(YAML frontmatter + 본문)를 가진 디렉터리 하나가 스킬이다. frontmatter는 `name`(1–64자, 디렉터리 이름과 같아야 함), `description`(1–1024자), 선택 칸 `license`·`compatibility`·`metadata`(문자열 맵)·`allowed-tools`(실험)뿐이다. **버전 칸과 의존성 선언이 없다**. 명세의 예는 버전을 `metadata` 안에 둔다([명세](https://agentskills.io/specification)). 클라이언트 구현 안내는 `.agents/skills/`를 프로젝트·사용자 범위에서 읽고, 프로젝트 스킬은 폴더 trust로 막고, 꺼진 스킬은 목록에서 숨기고, 클라우드·샌드박스 에이전트는 사용자·조직 스킬을 샌드박스 밖에서 넣으라고 한다([안내](https://agentskills.io/client-implementation/adding-skills-support)). 2026-10-22에 Linux Foundation의 Agentic AI Foundation(AAIF)으로 옮겨졌고, 첫 작업 항목은 버전 있는 릴리스와 보안 안내다([LF 발표](https://www.linuxfoundation.org/press/agentic-ai-foundation-announces-four-new-projects-agent-skills-open-responses-openenv-and-opensandbox), [AAIF 글](https://aaif.io/blog/agent-skills-sharing-team-expertise-across-ai-agents)). 레지스트리, 서명, 버전 제약, 보안 검사 형식은 명세에 없다.
- **MCP 2026-07-28 개정.** `initialize` 핸드셰이크와 프로토콜 세션(`Mcp-Session-Id`)을 없애고, 버전과 능력을 요청마다 `_meta`에 싣는다. GET 스트림은 `subscriptions/listen`으로 바뀌고, 서버가 요청 사이에 상태가 필요하면 도구 인자로 handle을 주고받는다. `tools/list` 결과에 `ttlMs`·`cacheScope`가 붙는다. 도구 정의의 해시·고정 같은 무결성 장치는 없다([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)).
- **MCP Registry.** 공식 레지스트리는 게시자 이름공간을 확인한다(`io.github.*`는 GitHub OAuth, 도메인 이름공간은 DNS). 서버가 안전한지는 확인하지 않고, 선별은 하위 레지스트리에 맡긴다([about](https://modelcontextprotocol.io/registry/about), [charter](https://modelcontextprotocol.io/community/registry/charter.md)).
- **IdP 중심 MCP 인가.** MCP Enterprise-Managed Authorization(ID-JAG)은 IdP가 준 단언을 MCP 서버의 인가 서버에서 audience가 묶인 token으로 바꿔, 서버마다 동의 화면 없이 IdP가 접근을 정하게 한다([확장](https://modelcontextprotocol.io/extensions/auth/enterprise-managed-authorization)). 성숙도는 출처마다 다르게 적혀 있다.

### 엔진과 관리 제품

| 제품 | 스킬·플러그인 | MCP | 버전·배포 | 출처 |
|---|---|---|---|---|
| Claude Code·Agent SDK | 관리·개인·프로젝트·plugin(이름공간)·claude.ai 동기화 순으로 읽는다. 동기화 스킬은 고정이 없다 | `mcpServers` JSON | marketplace 출처를 ref·커밋 SHA로 고정할 수 있다. 관리 설정 `strictKnownMarketplaces`가 허용한 marketplace만 받는다(plugin 하나 단위가 아니라 marketplace 단위) | [skills](https://code.claude.com/docs/en/skills), [marketplaces](https://code.claude.com/docs/en/plugin-marketplaces), [settings](https://code.claude.com/docs/en/settings) |
| Claude Skills API | 업로드한 스킬마다 완전한 스냅샷 버전(`skver_…`)을 둔다. 공유 단위는 워크스페이스이고 그 워크스페이스에 닿는 key는 사용자 스킬을 모두 읽고 지운다. Managed Agents는 버전을 빼면 `latest`다 | — | 버전 고정은 쓰는 쪽이 고른다 | [skills guide](https://platform.claude.com/docs/en/build-with-claude/skills-guide), [Managed Agents skills](https://platform.claude.com/docs/en/managed-agents/skills) |
| Claude Plugins API(beta, Enterprise) | plugin 업로드마다 불변 버전. 조직·그룹에 설치 값(required / auto_install / available / not_available)을 두고, 여러 그룹에 든 사람은 가장 넓은 값을 받는다 | plugin 안 | `served_version_id`를 정하면 그 버전으로 영구 고정된다. 보안 검사 설정을 켜면 검사를 통과한 버전만 내준다 | [Plugins API](https://platform.claude.com/docs/en/manage-claude/plugins-api) |
| claude.ai 조직 스킬 | 소유자가 전원에게 배포하고, 구성원이 사람·그룹이나 조직 전체에 공유한다. **조직 전체 게시에는 승인 단계가 없다.** 검토를 원하면 게시를 끄고 제출을 소유자에게 보내야 한다. Enterprise에는 자동 보안 검사가 있지만 Skills API 업로드는 검사 대상이 아니다 | connector는 따로 | — | [도움말](https://support.claude.com/en/articles/13119606-provision-and-manage-skills-for-your-organization), [enterprise 스킬](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/enterprise) |
| OpenAI Codex | REPO(cwd에서 저장소 루트까지의 `.agents/skills`)·USER·ADMIN·SYSTEM 범위. Codex 전용 sidecar `agents/openai.yaml`이 암묵 호출 정책과 도구 의존을 싣는다. plugin은 루트 `plugin.json`(이식 manifest, 고유 설정은 `extensions.com.openai`)이고 `.claude-plugin/marketplace.json`도 읽는다. 훅은 사용자 trust가 있어야 돈다 | `[mcp_servers]` TOML, 자격은 env var 이름(`bearer_token_env_var`), `enabled_tools`·`disabled_tools` | plugin 캐시가 버전별 디렉터리 | [build skills](https://learn.chatgpt.com/docs/build-skills), [plugins](https://developers.openai.com/codex/plugins/build), [MCP](https://developers.openai.com/codex/mcp) |
| GitHub | Copilot은 `.github/skills`와 `.claude/skills`를 읽는다. `gh skill install`은 `@버전`이나 `--pin`으로 태그·커밋 SHA에 고정하고, 고정한 스킬은 `gh skill update`가 건너뛴다(2026-04, 공개 미리보기) | 조직 MCP 허용 목록 | 고정은 고르는 것 | [Copilot skills](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-skills), [gh skill](https://github.blog/changelog/2026-04-16-manage-agent-skills-with-github-cli/) |
| Cursor, Gemini CLI, goose | Cursor는 `.cursor/skills`·`.agents/skills`·`.claude/skills`를 읽고 팀 marketplace에 required·default on을 둔다. Gemini CLI는 관리자 `allowMCPServers` 허용 목록을 사용자가 넘지 못한다. goose는 관리자 허용 목록이 없으면 무엇이든 설치된다 | 허용 목록 | — | [Cursor skills](https://cursor.com/docs/skills), [Cursor plugins](https://cursor.com/docs/plugins), [Gemini CLI enterprise](https://geminicli.com/docs/admin/enterprise-controls/), [goose allowlist](https://goose-docs.ai/docs/guides/allowlist) |

### 시장 동향 (대략 2026-05 ~ 2026-11)

| 흐름 | 무엇 | 출처 |
|---|---|---|
| 형식은 하나로 모였다 | 스킬은 Agent Skills, 도구·데이터는 MCP다. 둘 다 AAIF 아래에 있고, 엔진들이 서로의 디렉터리(`.agents/skills`, `.claude/skills`)와 manifest(Codex의 `.claude-plugin/marketplace.json` 읽기)를 읽는다 | 위 표, [LF 발표](https://www.linuxfoundation.org/press/agentic-ai-foundation-announces-four-new-projects-agent-skills-open-responses-openenv-and-opensandbox) |
| 배포 단위는 plugin | 스킬 + MCP + 훅·명령을 묶은 plugin을 git 기반 조직 marketplace로 내보내고, 관리자 허용 목록, required·default on, "관리 출처만" 잠금으로 다스린다. plugin 형식은 엔진마다 다르다 | [Claude Plugins API](https://platform.claude.com/docs/en/manage-claude/plugins-api), [Cursor plugins](https://cursor.com/docs/plugins), [Codex plugins](https://developers.openai.com/codex/plugins/build) |
| 고정은 있지만 기본이 아니다 | 커밋 SHA 고정(`gh skill --pin`, marketplace `sha`)과 버전 고정(Plugins API `served_version_id`)이 생겼지만, 많은 경로의 기본은 자동 갱신이나 `latest`다. Trail of Bits는 버전 고정, 추가·갱신할 수 있는 사람 제한, 선별한 내부 marketplace를 권한다 | [Trail of Bits, 2026-06-03](https://blog.trailofbits.com/2026/06/03/the-sorry-state-of-skill-distribution/) |
| 자동 검사는 필요하지만 모자라다 | Snyk는 공개 레지스트리 두 곳의 스킬 3,984개에서 악성 76개를 확인했다(2026-02). Trail of Bits는 레지스트리 검사기들을 패딩, `.pyc` 페이로드, 레지스트리 주소 바꾸기로 비켜 갔다. 검사보다 출처(누가, 어느 커밋)와 선별이 더 강한 통제로 보인다 | [Snyk ToxicSkills](https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub/), [Trail of Bits](https://blog.trailofbits.com/2026/06/03/the-sorry-state-of-skill-distribution/) |
| MCP 공급망 사고 | 승인 뒤 도구 설명을 몰래 바꾸는 rug pull과 도구 설명 오염, 작업 공간 파일의 MCP 설정이 trust 없이 실행되는 RCE(Gemini CLI). 방어로 도구 정의 고정과 바뀌면 재승인, 조직 허용 목록, 저장소 설정 자동 로드 금지가 나온다 | [CSA, 2026-07-11](https://labs.cloudsecurityalliance.org/research/csa-research-note-mcp-tool-description-poisoning-20260711-cs/), [CSA Gemini CLI](https://labs.cloudsecurityalliance.org/research/csa-research-note-gemini-cli-rce-cvss10-ai-tool-security-202/) |
| 자격은 엔진 밖에 | Codex는 자격을 env var 이름으로만 받고, MCP 인가는 IdP 중심(ID-JAG)으로 간다 | [Codex MCP](https://developers.openai.com/codex/mcp), [MCP 확장](https://modelcontextprotocol.io/extensions/auth/enterprise-managed-authorization) |

**흐름.** 형식(Agent Skills, MCP)은 엔진 사이에서 하나로 모였다. 그 위의 배포 단위(plugin)와 그것을 다스리는 방법(허용 목록, 버전 고정, 승인, 검사)은 제품마다 다르고 표준이 없다. 고정과 승인은 있되 기본값이 아니고, 자동 검사는 우회된다는 것이 같은 시기에 보였다. 조직 플랫폼이 할 일은 형식은 표준대로 받고, 배포와 통제는 자기 모델로 두는 것이다.

## 12. 따를 것과 다르게 갈 것

| 구분 | 무엇 | 이 문서에서 |
|---|---|---|
| 표준을 그대로 저장 | Agent Skills 디렉터리(`SKILL.md`와 명세 칸) | 스킬 하나가 등록 단위다(2절). 버전은 명세에 없으므로 werft가 내용 digest와 등록 순번으로 붙이고, `SKILL.md`의 자기 신고 버전은 쓰지 않는다(3절) |
| 표준을 그대로 저장 | MCP 원격 서버(URL, OAuth 또는 정적 token), 서버가 알린 도구 이름 | 워크스페이스 MCP 서버 그대로(2절, [mcp-credentials.md](mcp-credentials.md)). 판정 요청의 도구 칸은 서버가 알린 이름이다(6절) |
| 엔진별 어댑터 | 스킬을 놓는 자리와 탐색 닫기, MCP 설정 형식(Claude JSON, Codex TOML), 엔진 plugin 형식, 시작 확인 | 5절과 10절 "엔진 어댑터가 하는 변환". 엔진 plugin은 출력이다 |
| 우리 모델, 포트 뒤 | 등록·승인·버전 고정·지정·라이브러리, werft 플러그인 manifest, 의존성 확인, 접근 판정 | 표준이 정하지 않는 부분이다. 저장소·출처·엔진·판정을 포트로 나눠([13절](#13-werft-아키텍처-적용)) 표준이 버전·의존·레지스트리를 정하면 바깥 경계에서 맞춘다 |

**따르는 것.**

- **스킬 형식은 Agent Skills.** 세 엔진이 다 읽으므로 엔진마다 바꾸지 않는다. Codex `agents/openai.yaml`, Claude 전용 frontmatter 같은 엔진 전용 확장은 받지 않는다(2절).
- **버전은 불변이고 기본이 고정이다.** Claude Plugins API의 불변 버전과 `served_version_id` 고정, `gh skill --pin`, Trail of Bits의 권고와 같다. 지정 행이 digest 하나를 가리키고 세션은 시작 때 digest를 고정한다(4절).
- **Git 출처는 커밋 SHA로 고정한다.** marketplace `sha`, `gh skill --pin`과 같다. 태그를 받아도 등록 때 커밋으로 풀어 남긴다(3절).
- **설치 값의 모양.** `required`·`optional`·`forbidden`은 Claude의 Required·Available·Not available과 대응한다(4절).
- **저장소 안의 스킬·MCP 설정을 엔진이 읽지 않게 한다.** Agent Skills 안내가 프로젝트 스킬을 trust로 막으라고 하고, 작업 공간 MCP 설정 RCE가 그 이유를 보였다. 우리는 trust 여부와 상관없이 닫는다(5절).
- **자격은 엔진에 값으로 주지 않는다.** Codex `bearer_token_env_var`와 같은 생각이고, 우리는 relay 비밀만 준다(6절).
- **허용 목록.** Copilot·Gemini CLI·goose의 MCP 허용 목록처럼, 엔진에는 워크스페이스에 등록되고 에이전트가 켠 서버만 relay로 보인다(5·6절).
- **제출과 승인을 나눈다.** Anthropic의 수동 검토 목록이 말하는 업무 분리처럼, 승인은 제출한 사람이 아닌 관리자가 한다(3절).
- **선별한 내부 카탈로그.** Trail of Bits가 권하는 모양이다. 라이브러리는 워크스페이스가 승인한 플러그인만 보인다(10절).
- **공유 범위의 이름.** claude.ai 조직 스킬이 사람·그룹·조직 전체로 공유하는 것처럼, 라이브러리 공개 범위를 둔다. 이름은 접근 판정의 공개 범위 목록을 쓴다(10절).
- **세션이 무엇을 썼는지 남긴다.** 엔진 로컬 기록이 아니라 receipt와 세션 이벤트에 digest로 남긴다(7절).

**다르게 가는 것과 이유.**

| 그들 | 우리 | 이유 |
|---|---|---|
| 엔진 plugin이 배포 단위이고 원본이다(Claude·Codex·Cursor) | 원본은 엔진 중립의 werft 플러그인이고 엔진 plugin은 세션마다 만드는 출력이다(2·10절) | 엔진마다 형식이 다르고, 훅·명령·확장 코드는 엔진 하나에만 뜻이 있으며 플랫폼 승인 밖의 실행면이다. 원본이 하나여야 승인 경로가 하나다 |
| plugin이 훅·명령·서브에이전트를 싣는다 | 싣지 않는다(범위 밖) | 훅은 엔진 프로세스 안에서 승인 경로 밖의 코드를 돌린다. Codex도 훅에는 사용자 trust를 따로 요구하고 훅이 있는 plugin을 공개 디렉터리에 올리지 않는다([Codex plugins](https://developers.openai.com/codex/plugins/build)). 명령·도구 규칙은 실행 규칙 설계가 다룬다 |
| 자동 갱신, `latest` 기본(Claude Code marketplace, Managed Agents, 동기화 스킬) | 자동 갱신 없음, 새 커밋은 새 버전 후보(`pending`) | 승인 없이 내용이 바뀌는 길이 된다(3절) |
| 조직 전체 게시에 승인이 없다(claude.ai 조직 스킬 기본) | 모든 버전이 승인을 거치고, 공개 범위를 넓히는 것은 관리자만 한다(7·10절) | 라이브러리의 플러그인은 에이전트에 지정되어 여러 사람의 실행에 들어간다 |
| 여러 그룹이면 가장 넓은 값(Claude Plugins API) | 바깥 범위가 안쪽을 좁히기만 한다. `forbidden`은 펼친 결과에도 걸린다(4·10절) | 결과를 범위 순서만으로 receipt로 설명할 수 있고, 금지를 다른 묶음으로 비켜 갈 수 없다 |
| 자동 보안 검사가 통제의 중심이다(claude.ai Enterprise, Plugins API, 공개 레지스트리) | 이번 설계에는 자동 검사를 넣지 않는다. 허용 목록으로 다시 만든 트리만 저장하는 검사기, 다른 사람의 승인, 커밋 고정, 실행 샌드박스로 막는다(범위 밖) | 검사는 우회된다는 것이 같은 시기에 보였다. 넣을 때는 승인을 대신하지 않는 참고 결과로 넣는다. 지켜볼 것: Agent Skills의 보안 안내 |
| 공개 레지스트리·marketplace에서 가져온다(MCP Registry, skills.sh) | 가져오지 않는다. 업로드와 워크스페이스 GitHub 연결만 출처다(3절, 범위 밖) | 공식 MCP Registry도 게시자만 확인하고 안전은 확인하지 않는다. 가져오기를 열 때도 승인과 고정을 거친다 |
| 도구 정의 고정(시장 권고) | 이 설계에서는 하지 않는다. 엔진에 보이는 도구는 claim의 도구 이름 목록과 release deny로 좁힌다 | MCP 개정에 무결성 장치가 없어 werft가 해시를 정해야 한다. 원격 MCP 서버 설계([mcp-credentials.md](mcp-credentials.md))의 후속으로 다룬다 |
| 스킬이 의존을 스스로 설치한다(Codex `skill_mcp_dependency_install`) | 끈다. werft 플러그인이 의존을 선언하고 werft가 세 시점에 확인한다(10절) | 의존 설치는 승인 밖에서 MCP 서버를 늘린다 |

## 13. werft 아키텍처 적용

1–10절이 자세한 적용이다. 이 절은 그것을 자리별로 모은 지도다.

### 누가 무엇을 갖나

| 자리 | 맡는 것 |
|---|---|
| `packages/contracts` | 스킬·werft 플러그인 등록·지정·라이브러리 API 계약, claim의 extensions 항목, 거절 이유(`extension_forbidden`, `skill_set_mismatch`, `mcp_session_subject_changed`) |
| `packages/core` | 새 경로의 응답 표 |
| `packages/platform/src/extensions/` | 검사기(`bundle-validator.ts`), 해석기(`resolve.ts`: 접기, 펼치기, `forbidden`, 엔진 이름 겹침), 등록·승인 서비스(`bundle-service.ts`), 의존성 확인, 저장 포트(`ports/extension-bundle-store.ts`) |
| `packages/db/src/extensions/` | 저장 포트의 Postgres 구현 |
| `packages/runtime-core` | 번들 digest와 archive(`extension-bundle-archive.ts`) |
| `apps/control-host` | HTTP API(콘솔 세션만), Git 출처 읽기(워크스페이스 GitHub App), 세션 시작 때 해석 결과 고정 |
| `packages/platform/src/workers/workspace-mcp-egress.ts`와 그 DB 쪽 | MCP 축 판정 요청(6절 "언제 무엇을 묻나"), (서버, 턴) subject 고정과 전송 세션 묶음 |
| `packages/adapters/runtimes/claude`, `codex`, `codex-codec` | 엔진 매핑과 탐색 닫기, 시작 확인, 엔진 plugin 출력, relay, descriptor의 스킬 칸 |
| `apps/web` | 스킬 라이브러리, 에이전트 접근 탭의 스킬 칸, 새 세션의 optional 켜기 |

### 포트와 어댑터

- 안쪽 모델은 스킬(트리 digest), werft 플러그인(manifest digest), 지정(범위·모드·digest), 라이브러리 메타데이터다. 해석기와 의존성 확인은 순수 함수이고 I/O는 포트로만 한다.
- 바깥 어댑터는 다섯이다: 저장소(Postgres와 객체 저장소), 출처(업로드, GitHub), 엔진(Claude, Codex, 나중의 pi), 실행 규칙 판정기(의존성 확인의 `requires.rules`가 부른다, 그 설계의 것), 접근 판정(`authorize`, MCP 축, [접근 판정](access-decisions.md)의 것).
- 엔진을 더하면 엔진 어댑터 하나와 descriptor 하나가 는다. 해석기, 라이브러리, 판정은 바뀌지 않는다.

### 데이터 모델

이름은 구현에서 정한다.

| 표·칸 | 내용 | 단계 |
|---|---|---|
| `extension_bundles` | 스킬 트리 저장으로 역할을 좁힌다. 새 행은 스킬 하나. Git 출처의 저장소·경로·커밋 칸(없으면 더한다) | S1, S2 |
| receipt 종류 | `archive_extension`, `update_extension_metadata` | S1, S10 |
| werft 플러그인 | (워크스페이스, 이름, digest) → 정규화한 manifest, 승인 상태, 등록·승인한 사람 | S8 |
| `extension_attachments` | 지정 행이 werft 플러그인 digest를 가리킨다(옛 번들 지정은 읽기 유지) | S8 |
| 라이브러리 메타데이터 | 플러그인 이름 → 태그(단 사람), 분류, 공개 범위와 그 대상 | S10 |
| `sessions.extensions` | 펼친 결과(플러그인 digest와 스킬 이름·digest) | S8 |
| MCP 전송 묶음 | (attempt, 서버, 턴) → 고정한 subject·`generation`, 옛 개정 서버의 `Mcp-Session-Id` | S11 |

### 고른 것과 고르지 않은 것

- **엔진 plugin을 원본으로**, **공개 레지스트리에서 가져오기**, **push마다 자동 sync**, **가장 넓은 값 규칙**은 고르지 않았다. 이유는 12절과 대안 절이다.
- **스킬 저장 테이블 이름을 바꾸지 않는다**(2절). 바꾸는 비용(migration, 섞인 버전 worker 호환)에 비해 얻는 것이 낱말뿐이다.
- **MCP 판정을 엔진 쪽 훅에 두지 않는다.** 엔진 프로세스는 프롬프트 인젝션에 놓여 있다. 판정은 control-host egress에 있다(접근 판정 16절).

## 14. 단계별 구현 계획

단계 하나는 PR 한두 개이고, 단계마다 티켓 하나를 만든다. 구현은 오너가 시작을 정한 뒤 티켓 순서대로 한다. 아래 "앞선 단계"가 티켓의 blocked-by다. A·B로 시작하는 단계는 [접근 판정](access-decisions.md) 11절의 것이다. 처음 판의 개인 MCP 연결과 데이터 접근 정책 단위는 그 문서의 B5(개인 MCP 연결)와 A4·B2·B3(MCP egress 판정, 규칙, 콘솔)로 옮겼고, 여기에는 MCP에만 있는 S11만 남는다.

### 지금: Claude·Codex에서 같은 스킬·MCP

| 단계 | 내용 | PR | 끝난 조건 | 앞선 단계 |
|---|---|---|---|---|
| S1 스킬 API | 관리자 등록(업로드, 스킬 하나로 좁힘, 올린 `.claude-plugin/plugin.json` 거절. 구성원 제출은 S10), 버전(등록 순번 + digest), 승인(본인 승인 규칙), 워크스페이스·에이전트 범위 지정·해제(에이전트 관리자까지 넓힘), 보관, receipt `archive_extension`, `packages/core` 응답 표 | 1–2 | 서비스·API 시험: 스킬 둘 이상 트리 거절, 엔진 manifest 거절, 본인 승인 거절(관리자 한 사람이면 허용과 receipt), 지정된 버전 보관 거절, API key 쓰기 거절 | — |
| S2 Git 출처 | 저장소·경로·ref를 커밋 SHA로 풀어 읽기(워크스페이스 GitHub App), 원본 위치 메타데이터, "새 커밋 확인"이 digest가 다를 때만 `pending` 후보 | 1 | fake-git 통합 시험: 태그 → 커밋 고정, 같은 내용이면 후보 없음, 다른 내용이면 `pending` | S1 |
| S3 해석기와 Claude 어댑터 | descriptor의 스킬 호출 도구, 엔진 이름 기준 겹침 검사, 시작 확인 두 단계(5절 "Claude의 시작 확인"), `strictMcpConfig`. plugin 매핑과 fingerprint는 그대로 | 1–2 | 시작 확인 시험: 빠진 스킬·남는 스킬·내장 명령 섞임·숨은 스킬 불일치가 각각 거절되고, 숨은 스킬 불일치 세션에서 도구가 돌지 않음. 기존 체크포인트 resume 시험 | S1 |
| S4 Codex 스킬 | 스킬 루트(extraRoots 먼저), 고정 버전에서 루트별 탐색 닫기와 `skills/changed` 처리, `skills/list` 정확 일치, `codexProfileDigest`에 스킬 digest와 매핑 버전, descriptor `skills: native`(닫기를 확인하지 못하면 `none`) | 1–2 | 통합 시험: 저장소·사용자·ADMIN·시스템 스킬이 보이지 않음, 실행 중 새 `SKILL.md`가 다음 턴 전에 꺼짐, 스킬 없는 세션의 fingerprint가 그대로 | S1, S3 |
| S5 Codex 워크스페이스 MCP | 워크스페이스 MCP 서버를 relay로(`assertStartable` 거절 해제, `enabled_tools`) | 1 | fake MCP 서버로 Codex 세션이 도구를 부르고, claim 밖 도구가 보이지 않음 | — |
| S6 콘솔(스킬) | 워크스페이스 설정 > 스킬, 에이전트 접근 탭의 스킬 칸, 새 세션의 optional 켜기 | 1–2 | 화면 시험과 실제 스택 화면 기록(PR에 전후 캡처) | S1 |
| S7 E2E | 같은 스킬과 MCP 서버를 Claude·Codex 에이전트에 지정하고 둘 다 쓰는지, 저장소의 `.agents/skills`·`.claude/skills`가 보이지 않는지, 저장소와 엔진 사용자 설정에 넣은 시험용 MCP 서버로 엔진이 직접 연결하거나 token을 저장하지 않는지, 담당 팀 밖 구성원에게 숨긴 에이전트의 지정이 보이지 않는지 | 1 | CI의 E2E가 두 엔진에서 통과 | S3, S4, S5, S6 |

### 다음: werft 플러그인, 라이브러리, MCP 전송 세션

| 단계 | 내용 | PR | 끝난 조건 | 앞선 단계 |
|---|---|---|---|---|
| S8 werft 플러그인 | manifest 스키마와 digest, 단일 스킬 플러그인 자동 생성, 지정 행이 플러그인 digest를 가리키는 migration(옛 번들 지정은 읽기 유지), 해석기의 플러그인 단위 접기·펼치기·`forbidden` 펼친 결과 검사·펼친 뒤 겹침 검사, 어댑터별 엔진 plugin 출력 | 2 | 해석기 시험: 스킬 `foo` 금지 아래에서 `foo`를 담은 다른 플러그인 지정이 지정·활성화·세션 시작 모두에서 `extension_forbidden`, 같은 digest 중복은 한 번 펼침, 다른 digest는 겹침. migration 시험: 옛 지정이 그대로 해석됨 | S1, S3, S4 |
| S9 의존성 확인 | 지정·release 활성화·세션 시작의 세 시점, `missing` 목록 응답, 실행 규칙 충족 판정 호출 | 1 | 시점마다 빠진 MCP 서버·도구·규칙·엔진이 이름으로 나오는 시험, 세션 시작의 런타임 상태(재인증 필요)는 시작하고 이벤트를 남김 | S8, 실행 규칙 설계의 판정기 |
| S10 라이브러리 | 검색·태그·분류·공개 범위·사용 현황(에이전트·세션 읽기 거름), 구성원 제출, receipt `update_extension_metadata`, 콘솔 화면 | 2 | 공개 범위 밖 구성원에게 목록·검색·상세·지정 화면에서 보이지 않음, 워크스페이스 범위 지정은 범위와 상관없이 보임, 사용 현황이 숨긴 에이전트를 세지 않음, 화면 기록 | S8, S6 |
| S11 MCP 전송 세션의 subject 고정 | 6절 "언제 무엇을 묻나"(도구 없는 첫 판정, `tools/call` 판정)와 "전송 세션": (서버, 턴) subject 고정, 옛 개정의 `Mcp-Session-Id` 묶음, 2026-07-28 개정의 요청별 비교와 `subscriptions/listen` 묶음, 목록 캐시의 subject 분리, relay 재시작(Claude·Codex) | 1–2 | egress 통합 시험: 턴 도중 규칙 삭제 → 다음 요청 거절, subject가 바뀌는 판정 → `mcp_session_subject_changed`와 relay 재시작, 다른 subject의 세션 id 거절, 두 개정의 fake 서버에서 같은 결과. 개인 연결 결과(B5)를 켜기 전에 머지한다 | A4, S5 |

### 나중

| 단계 | 내용 | 앞선 단계 |
|---|---|---|
| S12 pi 스파이크(머지 안 함) | [8절](#8-pi-coding-agent를-세-번째-엔진으로) 추천의 세 확인과 MCP 확장의 명시적 로드, 플랫폼 이름 ↔ pi 정규화 이름 대응. 결과를 이 문서의 후속으로 기록 | S7 |

## 범위 밖

- 엔진 플러그인을 원본으로 받는 것, 훅, 슬래시 명령, 서브에이전트 정의, 엔진 확장 코드(pi 확장, Codex 앱).
- 마켓플레이스 탐색과 외부 카탈로그 가져오기(Anthropic 카탈로그, Codex 마켓플레이스).
- 사람별 개인 스킬(승인 없이 엔진에 가는 스킬). 구성원은 라이브러리에 제출할 수 있지만, 엔진에 가는 것은 조직이 승인하고 지정한 플러그인뿐이다. 공개 범위 `private`·`people`도 승인된 플러그인을 라이브러리에서 누구에게 보일지일 뿐이다.
- 엔진 형식(Claude·Codex plugin, pi 패키지)을 원본으로 가져오는 변환기. 출력 방향(werft 플러그인 → 엔진 형식)만 만든다.
- 콘솔 안의 스킬 작성기.
- 엔진의 자동 의존 설치(스킬이 MCP 서버를 깔게 하는 기능).
- 자동 보안 검사(Claude Enterprise의 스킬 검사에 해당). 검사기의 허용 목록 재구성, 다른 사람의 승인, 커밋 고정으로 대신한다. 넣을 때는 승인을 대신하지 않는 참고 결과로 넣는다([12절](#12-따를-것과-다르게-갈-것)).
- pi 엔진 구현([8절](#8-pi-coding-agent를-세-번째-엔진으로) 추천에 따라 오너 결정 뒤).

## 대안 (고르지 않음)

- **엔진 플러그인을 원본 단위로 하고 엔진 사이 변환기를 둔다.** 엔진마다 다른 훅·명령을 승인하고 판정할 길이 필요하고, 변환할 수 없는 부분이 매번 생긴다. werft 플러그인이 같은 공유 단위를 엔진 중립으로 준다.
- **번들(여러 스킬)을 계속 등록 단위로 둔다.** Claude 외 엔진에서 이름공간을 흉내 내야 하고(`<slug>-<skill>` 같은 이름 바꾸기), 버전이 스킬 하나가 아니라 묶음 단위로 움직여 한 스킬만 고치는 배포가 무거워진다.
- **저장소의 `.agents/skills`를 그대로 읽게 한다.** 엔진 셋이 다 읽는 자리라 가장 쉽지만, 저장소에 push할 수 있는 사람이 승인 없이 에이전트 능력을 바꾼다.
- **Git 출처를 push마다 자동 sync한다.** Claude 조직 설정이 이렇게 한다(조사 1-2.1). 우리는 승인이 버전 단위라, 자동 sync는 승인 대기 버전을 늘릴 뿐 배포를 빠르게 하지 않는다.
- **가장 관대한 값 규칙(Claude Enterprise 그룹).** 결과를 설명하려면 모든 그룹 소속을 봐야 한다. 범위 순서 규칙이 receipt로 설명하기 쉽다.
