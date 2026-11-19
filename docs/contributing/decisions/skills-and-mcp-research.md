# 조사: 엔진과 관리 콘솔이 스킬·MCP·플러그인을 다루는 방법

- 조사일: 2026-11-20. 공개 문서와 공개 저장소만 읽었다. 확인하지 못한 것은 "확인 못 함"으로 적었다.
- 이 조사를 근거로 한 설계는 [스킬과 MCP 서버, 두 개념으로 엔진에 상관없이 등록·지정한다](skills-and-mcp.md)에 있다.
- 1부는 Claude Team/Enterprise와 Claude Code·Agent SDK, 2부는 Codex·pi·Oh My Pi다.

# 1부. Claude Team / Enterprise

---

## 1-0. 한눈에 보기

| 영역 | claude.ai 관리 화면 | Claude Code 쪽 정책 | 누가 관리 |
|---|---|---|---|
| Skills / Plugins | **Organization settings > Plugins & skills** (탭: Inventory, Marketplaces, Organization skills, Requests, Policy) | managed settings: `extraKnownMarketplaces`, `enabledPlugins`, `strictKnownMarketplaces`, `blockedMarketplaces`, `syncClaudeAiPlugins`, `syncClaudeAiSkills` 등 | Owner·Primary Owner. Enterprise에서는 커스텀 역할의 **Libraries** 권한 보유자도 가능. 기본 **Admin** 역할은 이 페이지 권한이 없다 |
| Connectors (원격 MCP) | **Organization settings > Connectors** | `managed-mcp.json`, `managedMcpServers`, `allowedMcpServers`/`deniedMcpServers`, `allowManagedMcpServersOnly`, `allowAllClaudeAiMcps`, `disableClaudeAiConnectors` | Owner·Primary Owner. Enterprise에서는 Libraries 관리 권한이 있는 커스텀 역할도 가능 |
| Desktop extensions (.mcpb) | **Organization settings > Connectors > Desktop** 탭 (Allowlist) | Desktop system policy `isDesktopExtensionEnabled` 등 | Owner·Primary Owner |
| Claude Code 정책 | **Organization settings > Claude Code > Managed settings** (server-managed settings) | MDM, `managed-settings.json`, `managed-settings.d/` | Owner·Primary Owner |
| 감사 | **Organization settings > Data and Privacy > Export logs** (Enterprise, 180일 CSV), Compliance API | OpenTelemetry, Analytics API | Owner·Primary Owner |

---

## 1-1. Skills

### 1-1.1 기능과 플랜
- Team·Enterprise 플랜에서 조직 전체 skill을 관리할 수 있다. 특정 그룹에 plugin으로 skill을 배포하는 기능과 보안 스캔은 Enterprise 전용이다. [support 13119606](https://support.claude.com/en/articles/13119606)
- Skills를 쓰려면 Code Execution과 File Creation이 켜져 있어야 한다는 설명이 있다. 이것은 검색 요약에서만 봤고 원문 확인은 못 했다(확인 못 함). [support 13119606](https://support.claude.com/en/articles/13119606)

### 1-1.2 역할과 권한
- 조직 전체 skill을 추가하거나 삭제하는 것은 Owner만 할 수 있다("Only owners can add or remove organization-wide skills"). [support 13119606](https://support.claude.com/en/articles/13119606)
- **Plugins & skills** 페이지는 Team·Enterprise의 Owner와 Primary Owner가 쓸 수 있다. Enterprise에서는 커스텀 역할에 **Libraries** 권한(view 또는 manage)이 있는 멤버도 쓸 수 있다. 이 권한은 **Organization settings > Roles** 역할 편집기의 **Libraries** 행에서 준다. 멤버 목록의 **Admin** 역할에는 이 페이지가 포함되지 않는다. view 권한만 있으면 **Add** 메뉴와 availability 설정이 보이지 않는다. [claude.com/docs/plugins/admin](https://claude.com/docs/plugins/admin.md)
- 게시 요청 검토는 Owner·Primary Owner와 Libraries가 "Can manage"인 역할이 한다. 자기가 제출한 요청은 승인할 수 없다. [plugins/admin](https://claude.com/docs/plugins/admin.md), [support 13119606](https://support.claude.com/en/articles/13119606)
- 멤버는 기본적으로 개인 skill을 만들고 올릴 수 있다. 배포된 skill은 끌 수만 있고 삭제할 수는 없다. [support 13119606](https://support.claude.com/en/articles/13119606)
- 기본 역할은 User, Admin, Owner, Primary Owner 네 가지다. 커스텀 역할을 적용하려면 멤버의 역할을 "Custom"으로 둬야 한다. [support 13930458](https://support.claude.com/en/articles/13930458)

### 1-1.3 관리 화면 구조
- 관리자: **Organization settings > Plugins & skills**. 탭은 **Inventory**, **Marketplaces**, **Organization skills**(아직 Inventory로 옮겨지지 않은 업로드 skill이 있을 때만 보임), **Requests**, **Policy**다. [plugins/admin](https://claude.com/docs/plugins/admin.md)
  - support 13119606에는 탭이 Policy, Requests, Inventory 세 개로 적혀 있다. 문서 사이에 차이가 있다.
- 멤버: **Customize > Skills**. 구역은 "Personal skills", "Shared with you", "Organization skills"다. [support 13119606](https://support.claude.com/en/articles/13119606)
- **Policy** 탭에 있는 스위치: **Skills**(조직 전체 on/off), **User-created skills**, **Skill sharing**, **Share with groups**(Enterprise), **Publishing**, **Skill and plugin security scanning**. [plugins/admin](https://claude.com/docs/plugins/admin.md)

### 1-1.4 배포 방식
- **Add > Upload a skill**(SKILL.md가 든 .zip) 또는 **Create a skill**. [support 13119606](https://support.claude.com/en/articles/13119606), [plugins/admin](https://claude.com/docs/plugins/admin.md)
- Owner가 배포한 skill은 "enabled by default for everyone"이고, 사용자는 개별 skill을 끌 수 있다. [support 13119606](https://support.claude.com/en/articles/13119606)
- Inventory에서 행 메뉴의 **Default access**로 **Not available**, **Available to install**, **Installed by default**, **Required** 중 하나를 고른다. Enterprise에서는 **Group access…**도 쓸 수 있다. [support 13119606](https://support.claude.com/en/articles/13119606)
- 멤버끼리 공유하거나(**Skill sharing**) 조직에 게시(**Publish to org**)할 수도 있다. [plugins/admin](https://claude.com/docs/plugins/admin.md)
- 배포된 skill은 claude.ai 계정으로 로그인한 Claude Code에도 들어간다. 터미널 세션에서는 `~/.claude/skills/synced/`로 내려받는다. 막으려면 managed settings에 `syncClaudeAiSkills: false`를 넣는다. [support 13119606](https://support.claude.com/en/articles/13119606), [code skills](https://code.claude.com/docs/en/skills.md)

### 1-1.5 버전과 업데이트
- 게시 항목의 새 버전을 승인하면 쓰는 사람 모두에게 자동으로 적용된다. 승인 전까지는 기존 버전을 그대로 쓴다. [support 13119606](https://support.claude.com/en/articles/13119606)
- 조직이 올린 항목은 상세 페이지에서 **Upload new version**으로 새 버전을 올린다. **Version history**에서 **Compare with current**, **Revert to this version**, **Make this the current version**을 쓸 수 있다. 저장소에서 sync한 항목은 revert할 수 없다. [plugins/admin](https://claude.com/docs/plugins/admin.md)
- 동료가 공유한 skill은 소유자가 새 버전을 저장하면 받는 사람이 다음에 쓸 때 자동으로 갱신된다. [support 13119606](https://support.claude.com/en/articles/13119606)
- Claude Code의 synced skill은 작업 중에는 약 10분, 유휴 상태에서는 약 40분마다 확인한다. 실행 중인 세션에도 재시작 없이 반영된다. 버전 고정(pin) 기능은 문서에 없다. [code skills](https://code.claude.com/docs/en/skills.md)

### 1-1.6 게시 정책과 보안 스캔
- **Publishing** 값은 **Requires review**, **Open**, **Off**다. 따로 정하지 않았을 때 기본값은 Team이 **Open**, Enterprise는 보안 스캔이 켜져 있으면 **Open**, 아니면 **Requires review**다. [plugins/admin](https://claude.com/docs/plugins/admin.md)
- 보안 스캔은 Enterprise 전용이다. CMEK, ZDR, HIPAA 조직에서는 쓸 수 없다. 결과에 따라 통과하면 정상 설치되고, 위험하면 경고 배너가 뜨며, 악성이면 차단된다. [support 13119606](https://support.claude.com/en/articles/13119606)

---

## 1-2. Plugins와 plugin marketplaces

### 1-2.1 claude.ai 조직 설정
- 위치: **Organization settings > Plugins & skills** (skill과 같은 페이지). [plugins/admin](https://claude.com/docs/plugins/admin.md)
- **Add** 메뉴: **Upload a skill**, **Create a skill**, **Upload a plugin**, **Create a plugin**, **Sync from GitHub**, **Sync from GitLab**, **Add marketplace**(Anthropic 카탈로그 등). [plugins/admin](https://claude.com/docs/plugins/admin.md)
- Availability 값과 멤버에게 미치는 효과 [plugins/admin](https://claude.com/docs/plugins/admin.md):
  - **Not available**: 숨김
  - **Available to install**: **Discover**에 노출된다
  - **Installed by default**: 설치된 상태로 시작하고 멤버가 끌 수 있다
  - **Required**: 항상 켜져 있고 끌 수 없다. "This plugin is required by your organization"이라는 표시가 붙는다
- Enterprise의 그룹 규칙 [plugins/admin](https://claude.com/docs/plugins/admin.md):
  - 그룹 설정이 조직 설정보다 우선한다. 그룹 설정이 더 엄격해도 마찬가지다.
  - 한 멤버가 여러 그룹에 속하면 가장 관대한 값이 적용된다.
  - 그룹은 SCIM으로 동기화하거나 **Organization settings > Groups**에서 만든다.
  - 그룹별 설정을 하려면 Libraries "Can manage"와 Identity & Access "Can view" 권한이 필요하다.
- Plugin에 connector가 들어 있어도 availability만으로는 추가되지 않는다. Owner가 **Organization settings > Connectors**에서 따로 추가해야 한다. [plugins/admin](https://claude.com/docs/plugins/admin.md)
- **Marketplaces** 탭 [plugins/admin](https://claude.com/docs/plugins/admin.md), [org-rollout](https://claude.com/docs/plugins/org-rollout.md):
  - **Re-sync**로 즉시 sync한다.
  - **Sync automatically**를 켜면 기본 브랜치에 push할 때 sync한다. 저장소에 webhook이 필요하다.
  - marketplace별 **Default access**를 정할 수 있다.
  - 정기 sync는 없다. tag는 읽지 않는다.
  - Anthropic 카탈로그는 **Remove from organization**으로 뺄 수 있다.
  - 멤버는 저장소 접근 권한이 없어도 된다. 조직의 GitHub/GitLab 연결로 읽는다.
- **Turn off Skills**를 하면 plugin과 skill이 모두 꺼지고, Claude Code의 synced plugin도 멈춘다. [plugins/admin](https://claude.com/docs/plugins/admin.md)
- Inventory 탭에 **Users (30d)** 사용량 열이 있다. 내보내기(export)는 없다. [plugins/admin](https://claude.com/docs/plugins/admin.md)

### 1-2.2 Claude Code managed settings
- 전달 경로는 세 가지다. [code plugins/org](https://code.claude.com/docs/en/plugins/org)
  - server-managed: **Organization settings > Claude Code > Managed settings**. Owner 역할이 필요하다.
  - MDM
  - `managed-settings.json`
- 함께 쓰는 키 [code plugins/org](https://code.claude.com/docs/en/plugins/org):
  - `extraKnownMarketplaces`: marketplace를 등록한다. 소스 형식은 `github`, `git`, `url`, `file`, `directory`.
  - `enabledPlugins`: `"name@marketplace": true`는 강제로 켜고, `false`는 모든 scope에서 차단하고 숨긴다.
- 제한 키 [code plugins/org](https://code.claude.com/docs/en/plugins/org):
  - `strictKnownMarketplaces`: 허용 목록이다. 별칭은 `allowedMarketplaces`이고 v2.1.232 이상에서 쓸 수 있다. `[]`이면 공식 marketplace까지 모두 막는다. 항목 형식은 `github`(owner 와일드카드 `org/*`는 v2.1.223 이상), `git`, `url`, `file`, `directory`, `hostPattern`, `pathPattern`, `skills-dir`.
  - `blockedMarketplaces`: 허용 목록보다 먼저 검사한다.
  - `disableSideloadFlags`: `--plugin-dir`, Agent SDK `plugins` 옵션 등을 거부한다.
  - `strictPluginOnlyCustomization`: user·project 소스의 skills, agents, hooks, mcp를 막는다.
  - `syncClaudeAiPlugins`: v2.1.273 이상.
  - `disableCommandPluginSources`, `pluginSuggestionMarketplaces`, `pluginTrustMessage`.
- 검사 시점 [code plugins/org](https://code.claude.com/docs/en/plugins/org):
  - 다운로드 전: add, install, update, auto-update 때.
  - 세션 시작 때 다시 검사한다.
  - claude.ai 관리 콘솔에 넣은 목록은 claude.ai에서 git 저장소 marketplace를 추가할 때도 적용된다. 이미 추가된 marketplace와 업로드한 plugin은 다시 검사하지 않는다.
- 업데이트 [code plugins/org](https://code.claude.com/docs/en/plugins/org), [org-rollout](https://claude.com/docs/plugins/org-rollout.md):
  - marketplace별 `autoUpdate`를 관리자가 정하면 사용자가 바꿀 수 없다.
  - 전체를 끄려면 `env.DISABLE_AUTOUPDATER=1`. plugin만 계속 업데이트하려면 `FORCE_AUTOUPDATE_PLUGINS=1`을 함께 둔다.
  - `plugin.json`의 `version`을 올려야 업데이트로 인식된다.
  - 릴리스 채널은 ref가 다른 marketplace 두 개와 그룹별 managed settings로 구성한다.
- 두 경로로 같은 이름의 plugin이 들어오면 managed settings로 설치된 쪽을 로드한다. [org-rollout](https://claude.com/docs/plugins/org-rollout.md)
- 할 수 없는 것: 사용자별·그룹별 키 적용(파일이나 그룹 구성을 따로 배포해야 한다), allowlist로 marketplace 안의 개별 항목 제한, `/plugin` 숨기기. [code plugins/org](https://code.claude.com/docs/en/plugins/org)

---

## 1-3. Connectors (원격 MCP)

### 1-3.1 claude.ai 조직 connector
- custom connector를 추가할 수 있는 사람: Team은 Owner·Primary Owner, Enterprise는 여기에 더해 "custom role that includes Manage access to Libraries". [support 11175166](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
- 추가 경로 [support 11175166](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp):
  1. **Organization settings > Connectors** → **Add** → **Custom** → **Web** → URL 입력.
  2. **Authentication**: "Sign in now", "Sign in when needed", "No sign in".
  3. **OAuth client**: "Use Claude's published identity (Recommended)", "Register automatically", "Use your own OAuth client". redirect URL은 `https://claude.ai/api/mcp/auth_callback`.
  4. **Request headers**: 고정 헤더를 넣을 수 있다. 이 경우 모든 사용자가 같은 credential로 접근한다.
- 멤버는 **Customize > Connectors**에서 각자 **Connect**한다. [support 11175166](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
- 수정 기능은 없다. 지우고 다시 추가해야 한다. 버전 개념은 문서에 없다(확인 못 함). [support 11175166](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
- Claude Code 문서에는 "On Team and Enterprise plans, only admins can add servers"라고 적혀 있다. [code mcp](https://code.claude.com/docs/en/mcp.md)
- Enterprise 역할별 connector 권한 [support 13930458](https://support.claude.com/en/articles/13930458):
  - **Organization settings > Roles** → 역할 → **Connectors** 탭.
  - 값: "Always allow", "Needs approval", "Blocked", "Custom"(도구별 지정). "All connectors" 행에서 기본값을 정한다.
  - "How members connect": "Individually", "Managed authorization", "Set per connector".
  - 조직 전체 도구 정책이 상한이다. 역할 설정은 그보다 좁힐 수만 있다.
  - 여러 역할을 가진 멤버에게는 가장 관대한 값이 적용된다. 변경이 반영되기까지 최대 15분이 걸린다.
  - 새 역할의 기본값은 "Needs approval"이다.
- Connectors Directory(Anthropic 제공 connector)를 조직에서 켜고 끄는 정확한 화면 이름은 확인 못 함.
- **Organization settings > Connectors** 페이지의 전체 탭 구성(Desktop 외의 탭 이름)도 확인 못 함.

### 1-3.2 Desktop extensions (.mcpb, 로컬 MCP)
- Team·Enterprise, Owner·Primary Owner. [support 12592343](https://support.claude.com/en/articles/12592343-enabling-and-using-the-desktop-extension-allowlist)
- 위치: **Organization settings > Connectors > Desktop** 탭 → "Allowlist" 토글.
  - "Browse extensions" → "Add to your team"으로 추가한다.
  - Enterprise에는 "Block all desktop extensions"도 있다.
- 기본값은 꺼짐이다. 이때는 registry에 있는 모든 extension을 쓸 수 있다.
- 켜면 기존 설치가 강제로 삭제되고 drag 설치가 막힌다. Claude Desktop 0.13.91 이상이 필요하다.
- custom extension: "Add custom extension"으로 .mcpb를 올리면 "Custom team extensions"에 들어가고, "Add to team"으로 추가한다.
- 업데이트는 manifest의 `version`을 올리고 `name`은 그대로 둔 채 "Upload new version"으로 올린다.
- 기기 정책 `isDesktopExtensionEnabled`, `isDesktopExtensionDirectoryEnabled`가 false이면 앱 안의 allowlist보다 우선한다.

### 1-3.3 Claude Code MCP 정책
- `managed-mcp.json` [code managed-mcp](https://code.claude.com/docs/en/managed-mcp.md):
  - 이 파일이 있으면 MCP를 독점 제어한다. 사용자 서버, plugin 서버, `--mcp-config`가 모두 막히고, claude.ai connector도 기본으로 꺼진다.
  - 경로: macOS `/Library/Application Support/ClaudeCode/`, Linux/WSL `/etc/claude-code/`, Windows `C:\Program Files\ClaudeCode\`.
  - 형식은 `.mcp.json`과 같다. server-managed settings로는 배포할 수 없다.
  - `{"mcpServers": {}}`이면 MCP 전체를 끈다.
- `managedMcpServers` [code managed-mcp](https://code.claude.com/docs/en/managed-mcp.md):
  - 사용자 서버는 그대로 두고 원격 서버를 추가로 준다. v2.1.259 이상.
  - `http`/`sse`와 `https://`만 허용한다. `command`, `env`, `${VAR}`는 쓸 수 없다.
  - 사용자가 지울 수는 없지만 `/mcp`에서 끌 수는 있다. server-managed로 받으면 실행 중인 세션에도 추가·변경·삭제가 반영된다.
- `allowedMcpServers` / `deniedMcpServers` [code managed-mcp](https://code.claude.com/docs/en/managed-mcp.md):
  - 항목 형식: `serverUrl`(와일드카드 가능), `serverCommand`(정확히 일치), `serverName`(보안 통제로 쓰면 안 된다).
  - denylist가 항상 우선한다.
  - `allowManagedMcpServersOnly: true`이면 관리자 허용 목록만 쓴다. 여러 소스를 읽으려면 v2.1.273 이상.
  - `allowedMcpServers`를 설정하지 않으면 모두 허용, `[]`이면 모두 차단이다.
- claude.ai connector와의 관계 [code managed-mcp](https://code.claude.com/docs/en/managed-mcp.md), [code mcp](https://code.claude.com/docs/en/mcp.md):
  - `allowAllClaudeAiMcps`를 켜면 `managed-mcp.json`이 있어도 claude.ai connector를 함께 로드한다.
  - `disableClaudeAiConnectors` 또는 `ENABLE_CLAUDEAI_MCP_SERVERS=false`로 끈다.
  - connector는 claude.ai 구독 로그인일 때만 가져온다. API 키, `setup-token`, Bedrock에서는 가져오지 않는다.
  - 조직 도구 설정이 `ask`이면 모든 모드에서 매 호출마다 묻고, `blocked`이면 도구가 숨겨진다.
  - 데스크톱 앱의 local/SSH 세션은 in-process `sdk` 서버로 전달되므로 MCP 설정이 적용되지 않는다.

---

## 1-4. Claude Code managed settings 전달 방식
- server-managed settings [code server-managed-settings](https://code.claude.com/docs/en/server-managed-settings.md):
  - Team·Enterprise 플랜에서 Owner·Primary Owner만 관리한다.
  - 위치: **Organization settings > Claude Code > Managed settings**.
  - 시작할 때 가져오고 1시간마다 다시 확인한다. 캐시는 마지막 성공 후 24시간 동안 유효하다.
  - Enterprise에서는 그룹별 구성(**Add configuration**, **Everyone else**, 순위 지정, **Switch to group-based configurations**)을 쓸 수 있다. 구성끼리 병합되지 않는다.
  - Team은 전체에 하나의 설정만 적용한다.
- endpoint-managed [code managed-settings](https://code.claude.com/docs/en/managed-settings.md):
  - macOS plist 도메인 `com.anthropic.claudecode`, Windows `HKLM\SOFTWARE\Policies\ClaudeCode` (값 이름 `Settings`).
  - 파일 `managed-settings.json`과 `managed-settings.d/`.
  - MDM은 30분마다 변경을 확인한다.
  - 우선순위는 remote > MDM > file > HKCU다. 기본은 정책 키를 가진 첫 소스 하나만 쓰고, `managedSourcesBehavior: "merge"`이면 합친다.
- managed skill 디렉터리: managed settings 디렉터리 아래 `.claude/skills/<name>/SKILL.md` (Linux 예: `/etc/claude-code/.claude/skills/`). 이름이 겹치면 enterprise > personal > project 순으로 이긴다. [code skills](https://code.claude.com/docs/en/skills.md)

---

## 1-5. 감사 (Audit)
- **Audit log export** [support 9970975](https://support.claude.com/en/articles/9970975-access-audit-logs), [compliance-api](https://platform.claude.com/docs/en/manage-claude/compliance-api.md):
  - Enterprise 전용, Owner·Primary Owner.
  - 위치: **Organization settings > Data and Privacy > Export logs**.
  - 최근 180일 CSV를 내보내고, 다운로드 링크는 24시간 유효하다. CMEK 조직은 쓸 수 없다.
  - help center 문서의 이벤트 목록에는 skill, plugin, connector 이벤트가 없다.
  - skill 공유는 `role_assignment` 이벤트로 남고 내용은 남지 않는다는 설명이 있다. [support 13119606](https://support.claude.com/en/articles/13119606)
- **Compliance API** [compliance-api](https://platform.claude.com/docs/en/manage-claude/compliance-api.md), [activity feed](https://platform.claude.com/docs/en/manage-claude/compliance-activity-feed):
  - Enterprise에서는 전체를, Console 조직에서는 Activity Feed만 쓸 수 있다.
  - Activity Feed는 `GET /v1/compliance/activities`이고 `read:compliance_activities` scope가 필요하다. 1분 안에 조회되고 6년 보관한다. 소급 기록은 없다.
  - 조직별 effective settings 조회 엔드포인트도 있다.
- 관련 `activity_types` 값. API reference 앞부분에서 이름으로 추린 것이라 전체 목록과 정밀 대조는 하지 않았다. [activities/list](https://platform.claude.com/docs/en/api/compliance/activities/list)
  - Skill: `claude_skill_created`, `claude_skill_enabled`, `claude_skill_disabled`, `claude_skill_replaced`, `claude_skill_version_created`, `claude_skill_served_version_updated`, `claude_skill_security_scan_completed`, `claude_skill_security_scan_override_updated`, `claude_skill_deleted`, `claude_skill_downloaded`, `claude_skill_auto_enabled`, `claude_skill_auto_disabled`, `group_skill_shares_revoked`
  - Plugin: `claude_plugin_created`, `claude_plugin_updated`, `claude_plugin_enabled`, `claude_plugin_disabled`, `claude_plugin_version_created`, `claude_plugin_served_version_updated`, `claude_plugin_replaced`, `claude_plugin_deleted`, `claude_plugin_security_scan_completed`, `plugin_installation_preference_updated`, `cli_plugin_exec_policy_updated`
  - Marketplace: `marketplace_created`, `marketplace_updated`, `marketplace_deleted`, `marketplace_webhook_provisioned`, `marketplace_webhook_deleted`, `claude_code_user_marketplaces_updated`
  - MCP/Connector: `mcp_server_created`, `mcp_server_updated`, `mcp_server_deleted`, `mcp_tool_policy_updated`, `mcp_server_managed_auth_updated`, `mcp_server_managed_auth_token_exchanged`, `integration_user_connected`, `integration_user_disconnected`, `admin_connector_request_resolved`, `org_connector_domain_guard_updated`
  - Desktop extension: `desktop_extension_uploaded`, `desktop_extension_version_uploaded`, `desktop_extension_allowlisted`, `desktop_extension_removed_from_allowlist`, `desktop_extension_blocklisted`, `desktop_extension_unblocked`, `desktop_extension_deleted`
  - 설정과 역할: `claude_organization_settings_updated`, `claude_code_user_settings_updated`, `rbac_role_*`, `role_assignment_granted`, `role_assignment_revoked`
- server-managed settings 변경도 Compliance API나 audit log export로 볼 수 있다. 계정팀에 문의해야 한다. 이벤트에는 행위자, 기기, 이전 값과 새 값의 참조가 들어간다. [server-managed-settings](https://code.claude.com/docs/en/server-managed-settings.md)
- Claude Code 사용 감사 [code plugins/org](https://code.claude.com/docs/en/plugins/org), [code managed-mcp](https://code.claude.com/docs/en/managed-mcp.md):
  - OpenTelemetry 이벤트 `claude_code.plugin_installed`, `claude_code.plugin_loaded`. MCP 도구 이름을 남기려면 `OTEL_LOG_TOOL_DETAILS=1`.
  - Enterprise Analytics API `GET /v1/organizations/analytics/plugins`.

---

## 1-6. Agent SDK / Claude Code의 로딩 방식 (오케스트레이션 매핑용)

### 1-6.1 Skills
- skill은 `SKILL.md`가 든 디렉터리다. 프로그램에서 등록하는 API는 없고, 파일시스템에 둬야 한다. [sdk skills](https://code.claude.com/docs/en/agent-sdk/skills)
- `settingSources`(TS) / `setting_sources`(Py) [sdk claude-code-features](https://code.claude.com/docs/en/agent-sdk/claude-code-features.md):
  - 값은 `"user"`, `"project"`, `"local"`. 생략하면 `["user","project","local"]`과 같다.
  - `"project"`: `<cwd>`부터 저장소 루트까지 `.claude/skills/`와 `additionalDirectories`의 `.claude/skills/`.
  - `"user"`: `~/.claude/skills/`.
  - managed policy, `~/.claude.json`, auto memory, claude.ai connector는 이 값과 상관없이 로드된다.
  - 멀티테넌트에서는 `settingSources: []`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, 테넌트별 파일시스템을 권장한다.
- `skills` 옵션 [sdk skills](https://code.claude.com/docs/en/agent-sdk/skills):
  - `"all"`, 이름 목록, `[]` 중 하나. 생략하면 발견된 skill이 모두 켜진다.
  - 설정하면 Skill 도구가 자동으로 `allowedTools`에 들어간다.
  - plugin skill은 `plugin:skill` 형식이고 와일드카드는 거부된다.
  - init 메시지의 `skills`, `slash_commands`로 확인한다.
- `plugins` 옵션: `[{ type: "local", path }]`만 받는다. marketplace plugin은 먼저 받아서 로컬 경로를 넘겨야 한다. plugin 안의 `skills/`, `agents/`, `hooks/`, `.mcp.json`이 로드된다. TS에서는 `reloadPlugins({ addPlugins })`로 실행 중에 추가할 수 있다(v0.3.301 이상). [sdk plugins](https://code.claude.com/docs/en/agent-sdk/plugins)
- managed settings의 `disableSideloadFlags`는 SDK `plugins` 옵션도 거부한다. [code plugins/org](https://code.claude.com/docs/en/plugins/org)
- claude.ai synced skill은 API 키나 `CLAUDE_CODE_OAUTH_TOKEN` 인증, `--setting-sources`에서 `user`를 뺀 경우에는 동기화되지 않는다. [code skills](https://code.claude.com/docs/en/skills.md)

### 1-6.2 MCP
- `mcpServers` 옵션(Py `mcp_servers`) [sdk mcp](https://code.claude.com/docs/en/agent-sdk/mcp):
  - stdio `{command,args,env}`, `{type:"http"|"sse", url, headers}`, in-process SDK 서버(`createSdkMcpServer`).
- `.mcp.json`(프로젝트 루트)은 `"project"` setting source가 켜져 있을 때 로드된다. [sdk mcp](https://code.claude.com/docs/en/agent-sdk/mcp)
- 도구 이름은 `mcp__<server>__<tool>`이다. `allowedTools`에 `mcp__server__*` 형식으로 허용해야 한다. [sdk mcp](https://code.claude.com/docs/en/agent-sdk/mcp)
- SDK는 OAuth를 대화형으로 처리하지 않는다. 앱이 토큰을 얻어 `headers`로 넘긴다. [sdk mcp](https://code.claude.com/docs/en/agent-sdk/mcp)
- `mcpServers: {}`로는 claude.ai connector를 막지 못한다. `strictMcpConfig: true` 또는 `disableClaudeAiConnectors`를 쓴다. [sdk claude-code-features](https://code.claude.com/docs/en/agent-sdk/claude-code-features.md)
- CLI scope: local·user는 `~/.claude.json`, project는 `.mcp.json`. 우선순위는 local > project > user > … > claude.ai connector. [code mcp](https://code.claude.com/docs/en/mcp.md)

### 1-6.3 매핑할 때 참고할 점 (출처 기반)
- 조직 정책은 SDK 프로세스에도 적용된다. managed settings는 `settingSources`와 상관없이 읽고, 조직 credential로 인증하면 server-managed settings도 가져온다. [sdk claude-code-features](https://code.claude.com/docs/en/agent-sdk/claude-code-features.md)
- 그래서 플랫폼이 넘기는 `mcpServers`, `plugins`도 조직의 `allowedMcpServers`/`deniedMcpServers`, `disableSideloadFlags`, `managed-mcp.json`에 막힐 수 있다. 단, in-process `sdk` 서버는 allowlist·denylist 검사에서 빠진다. [code managed-mcp](https://code.claude.com/docs/en/managed-mcp.md), [code plugins/org](https://code.claude.com/docs/en/plugins/org)

---

## 1-7. 확인 못 함
- **Organization settings > Connectors**의 전체 탭 구성(Desktop 외의 탭 이름)과 Anthropic Directory connector를 조직에서 켜고 끄는 정확한 UI.
- 원격 connector의 버전 관리. 문서상 "제거 후 재추가"만 있다.
- 조직 skill과 plugin을 관리하는 공개 API(CRUD) 존재 여부. 공식 문서에서 찾지 못했다.
- Skills 사용에 Code Execution/File Creation이 필요하다는 조건. 검색 요약에서만 봤다.
- Compliance API `activity_types` 전체 목록. 응답이 약 3.9MB라 앞부분만 읽었다.

# 2부. Codex · pi · Oh My Pi
참고로 developers.openai.com/codex/* 문서는 현재 learn.chatgpt.com/docs/* 로 308 리다이렉트된다(예: `developers.openai.com/codex/mcp` → `learn.chatgpt.com/docs/extend/mcp?surface=cli`). 아래 링크는 리다이렉트된 뒤의 주소다.

---

## 2-1. OpenAI Codex

### 2-1.1 저장소 현황
- [openai/codex](https://github.com/openai/codex): Apache-2.0, 별 약 135.9k, 최신 릴리스 `rust-v0.170.0`(2026-11-18), 마지막 push 2026-11-19. 날짜와 수치는 2026-11-20에 `gh api`로 확인했다.

### 2-1.2 스킬 로딩
출처: [Build skills](https://learn.chatgpt.com/docs/build-skills)
- 스킬은 `SKILL.md`가 들어 있는 디렉터리다. `scripts/`, `references/`, `assets/`, `agents/openai.yaml`은 선택 사항이다. frontmatter에는 `name`과 `description`이 반드시 있어야 한다.
- 탐색 범위
  - REPO: `$CWD/.agents/skills`, `$CWD/../.agents/skills`(Git 저장소 안의 상위 폴더), `$REPO_ROOT/.agents/skills`
  - USER: `$HOME/.agents/skills`
  - ADMIN: `/etc/codex/skills`
  - SYSTEM: Codex에 번들된 `skill-creator`, `skill-installer`. 기본으로 켜져 있다.
- 심볼릭 링크로 연결된 스킬 폴더도 따라간다. 이름이 같은 스킬은 합치지 않고 둘 다 선택기에 보일 수 있다.
- **`$CODEX_HOME/skills`**: 공식 문서에는 나오지 않는다. 소스 코드에서는 "Deprecated user skills location (`$CODEX_HOME/skills`), kept for backward compatibility"라는 주석과 함께 아직 탐색 경로에 들어 있다([codex-rs/ext/skills/src/host_roots.rs](https://github.com/openai/codex/blob/main/codex-rs/ext/skills/src/host_roots.rs)). 번들 `skill-installer` 스크립트는 여전히 `$CODEX_HOME/skills`에 설치한다([list-skills.py](https://github.com/openai/codex/blob/main/codex-rs/skills/src/assets/samples/skill-installer/scripts/list-skills.py)).
- 호출 방식
  - 명시 호출: CLI와 IDE에서는 `/skills` 또는 `$`로, ChatGPT에서는 `@`로 고른다.
  - 암묵 호출: 작업이 `description`과 맞으면 Codex가 스킬을 고른다. `agents/openai.yaml`에서 `policy.allow_implicit_invocation: false`로 끌 수 있다.
- 켜고 끄기: `~/.codex/config.toml`의 `[[skills.config]]` 항목에 `path`(SKILL.md 절대 경로) 또는 `name` 중 하나와 `enabled = false`를 쓴다. 여러 항목이 맞으면 마지막 항목이 이긴다. 번들 스킬은 신뢰된 프로젝트의 `.codex/config.toml`에서 `[skills.bundled] enabled = false`로 끈다.
- app-server에서는 `skills/list`(cwd별, `forceReload`, `perCwdExtraUserRoots`), `skills/extraRoots/set`, `skills/config/write`, `skills/changed` 알림을 쓴다([App Server](https://learn.chatgpt.com/docs/app-server)).

### 2-1.3 MCP 설정 (`config.toml` `[mcp_servers.<name>]`)
출처: [MCP (CLI)](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- stdio 필드: `command`(필수), `args`, `env`, `env_vars`(허용해서 전달할 환경 변수), `cwd`
- streamable HTTP 필드: `url`(필수), `bearer_token_env_var`(`Authorization`에 넣을 토큰을 담은 환경 변수 이름), `http_headers`(고정 값), `env_http_headers`(헤더 이름을 환경 변수 이름에 매핑)
- 공통 필드: `enabled_tools`(허용 목록), `disabled_tools`(enabled_tools 다음에 적용하는 거부 목록), `startup_timeout_sec`(기본 10), `tool_timeout_sec`(기본 60), `enabled = false`, `required = true`(서버가 준비되지 않으면 시작 실패)
- OAuth는 `codex mcp login <server>`로 하고, 브라우저가 없으면 `--no-browser`를 붙인다. `codex mcp add <name> --env K=V -- <cmd>`로 추가하고 `codex mcp list`로 확인한다.
- app-server에서는 `mcpServerStatus/list`, `mcpServer/tool/call`, `mcpServer/resource/read`, `mcpServer/oauth/login`, `config/mcpServer/reload`를 쓴다. `required` 서버가 시작에 실패하면 `thread/start`와 `thread/resume`도 실패한다([App Server](https://learn.chatgpt.com/docs/app-server)).

### 2-1.4 AGENTS.md
출처: [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- 전역: `$CODEX_HOME`(기본 `~/.codex`)에서 `AGENTS.override.md`를 먼저 찾고, 없으면 `AGENTS.md`를 쓴다. 비어 있지 않은 첫 파일 하나만 읽는다.
- 프로젝트: 프로젝트 루트에서 cwd까지 내려가며 디렉터리마다 `AGENTS.override.md` → `AGENTS.md` → `project_doc_fallback_filenames` 순으로 찾고, 디렉터리당 한 파일만 쓴다. 루트에서 cwd 순서로 이어 붙이므로 cwd에 가까운 파일이 뒤에 온다.
- 합계 크기가 `project_doc_max_bytes`(기본 32 KiB)에 닿으면 더 붙이지 않는다.

### 2-1.5 codex exec / app-server
- `codex exec`([Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode))
  - 기본 샌드박스는 read-only다. 쓰기는 `--sandbox workspace-write`로 허용한다. `--full-auto`는 제거됐다.
  - `--json`은 JSONL 이벤트를 낸다(`thread.started`, `turn.*`, `item.*`, `error`).
  - 그 밖의 플래그: `--output-schema`, `-o/--output-last-message`, `codex exec resume --last|<id>`, `--ephemeral`, `--ignore-user-config`
  - `CODEX_API_KEY`는 실행 한 번에만 인라인으로 넣으라고 권한다.
- app-server([App Server](https://learn.chatgpt.com/docs/app-server))
  - JSON-RPC 2.0(와이어에 `"jsonrpc"` 헤더 없음)을 쓴다. 기본 전송은 stdio다. websocket은 실험 단계이고 지원 대상이 아니며, 루프백이 아닌 리스너는 기본적으로 인증 없이 열린다.
  - thread/turn/item 모델이다. `thread/start`에서 `model`, `cwd`, `approvalPolicy`, `sandbox`를 스레드마다 지정한다.
  - 문서는 `clientInfo.name`이 컴플라이언스 로그에서 클라이언트를 식별한다고 적는다.

### 2-1.6 플러그인
출처: [Build plugins](https://developers.openai.com/codex/plugins/build/)
- 이식형 플러그인은 루트에 `plugin.json`을 둔다. `.codex-plugin/plugin.json`은 호환용 대체 경로다.
- 스킬은 루트 `skills/`, MCP는 루트 `mcp.json`(`mcpServers`), 앱 매핑은 `.app.json`, 훅은 기본 경로 `hooks/hooks.json`에 둔다. 훅은 수동 설치한 Codex 데스크톱 플러그인에만 적용된다.
- 마켓플레이스 위치: `$REPO_ROOT/.agents/plugins/marketplace.json`, 호환용 `$REPO_ROOT/.claude-plugin/marketplace.json`, 개인용 `~/.agents/plugins/marketplace.json`
- 명령: `codex plugin marketplace add owner/repo [--ref]`, `list`, `upgrade`, `remove`. 관리자는 워크스페이스 역할을 골라 플러그인을 게시할 수 있다.

### 2-1.7 관리자·워크스페이스 관리
출처: [Managed configuration](https://learn.chatgpt.com/docs/enterprise/managed-configuration)
- 계층은 세 가지다.
  - Requirements: 관리자가 강제하고 사용자가 덮어쓸 수 없다.
  - 기본값 config.toml: 시스템 또는 클라우드에서 내려오고 사용자가 덮어쓸 수 있다.
  - 레거시 `managed_config.toml`
- 정책을 정하는 곳
  - 클라우드: Admin Console > Agent security(UI 또는 "Edit as TOML"). 워크스페이스 기본값과 사용자·그룹·역할별 Override를 둘 수 있다.
  - 자체 호스팅: HTTPS 설정 서버
  - 기기 관리: macOS MDM의 `config_toml_base64`
- 파일 위치
  - `requirements.toml`: Unix는 `/etc/codex/requirements.toml`, Windows는 `%ProgramData%\OpenAI\Codex\requirements.toml`
  - `managed_config.toml`: `/etc/codex/managed_config.toml`
- `requirements.toml`로 강제할 수 있는 것
  - 승인과 샌드박스: `allowed_approval_policies`, `allowed_permission_profiles`(또는 레거시 `allowed_sandbox_modes`), `allowed_web_search_modes`
  - 기능 고정: `[features]`(예: `hooks`, `plugins`, `browser_use`, `computer_use`)
  - 명령과 파일: `[rules] prefix_rules`(`prompt`/`forbidden`), `[permissions.filesystem] deny_read`, 네트워크 프록시
- **MCP 허용 목록**: `requirements.toml`의 `mcp_servers`에서 이름과 identity(stdio는 `identity.command`, HTTP는 `identity.url`)가 둘 다 맞아야 서버가 켜진다. 맞지 않으면 꺼진다. 빈 테이블은 MCP 전체를 끈다. 플러그인에 번들된 서버는 `plugins.<plugin>.mcp_servers.<server>`로 지정한다.
- 플러그인 제어
  - `features.plugins = false`로 끈다.
  - `[marketplaces] restrict_to_allowed_sources = true`와 `[marketplaces.allowed_sources.<name>]`(git, host_pattern, local)로 출처를 제한한다.
  - 이 제한은 데스크톱 앱과 CLI에만 적용되고, IDE 확장과 웹에는 적용되지 않는다.
- 관리형 훅: Global `requirements.toml`에 `mcp_tool` 핸들러를 둔다. `[features].hooks = true`로 고정할 수 있다.
- OTel: `[otel]` 관리 값이 로컬 값보다 우선한다.
- 우선순위: 클라우드 requirements가 시스템 requirements보다 높다. 로컬 값이 규칙을 어기면 호환되는 값으로 바꾸고 사용자에게 알린다.
- **스킬 관리**([Skill controls](https://learn.chatgpt.com/docs/enterprise/skills)): 스킬 경로는 세 가지이고 서로 분리돼 있다.
  1. ChatGPT 워크스페이스 Skills: 워크스페이스 권한과 수명 주기로 관리한다.
  2. 로컬 파일시스템 스킬: 파일 배포와 로컬 설정으로 관리한다.
  3. 플러그인
  - 워크스페이스 제어는 로컬 스킬이나 플러그인을 설치하지 않는다. 플러그인을 설치해도 커넥터나 MCP 접근 권한이 생기지 않는다.
  - `requirements.toml`에서 파일시스템 스킬을 허용 목록으로 제한하는 키가 있는지는 **확인 못 함**(해당 페이지와 managed-config 페이지에 그런 키가 없다).
- **감사**([Compliance API and audit events](https://learn.chatgpt.com/docs/enterprise/compliance-api))
  - 로컬 접근 기록 유형으로 `conversation_message`와 `codex_log`만 이름이 나온다.
  - 문서는 이 기록이 "every local command, file operation, screenshot, approval, or external action"을 모두 담지는 않는다고 적는다. 이를 보완하는 수단은 OTel과 관리형 MCP 훅이고, 둘 다 따로 수집해야 한다.
  - 보존 기간 30일과 API 키 사용분 제외는 검색 요약에서만 봤다([Governance](https://developers.openai.com/codex/enterprise/governance)). 원문은 **확인 못 함**.

---

## 2-2. pi coding agent (pi-mono)

### 2-2.1 정체와 현황
- 저장소 `badlogic/pi-mono`는 **`earendil-works/pi`로 옮겨졌다**(GitHub API가 리다이렉트로 응답). 상세 내용은 [earendil-works/pi](https://github.com/earendil-works/pi)에 있다.
  - 라이선스 MIT, 별 약 122.9k, 생성 2025-08-09
  - 기여 수 상위: badlogic(Mario Zechner) 4496, mitsuhiko 1032, 그다음 davidbrai, christianklotz 등. 2026-11-20 `gh api` 기준이다.
- 패키지 이름: `@mariozechner/pi-coding-agent`는 0.73.1에서 멈췄고 npm에서 "please use @earendil-works/pi-coding-agent instead"로 deprecated 처리됐다. 현재 이름은 `@earendil-works/pi-coding-agent` 1.5.2(2026-11-10)이다. 2026-11-20 `npm view` 기준이다.
- 릴리스 주기: 1.0.0이 2026-10-01에 나왔고, 이후 1.1.0(10-07), 1.2.0(10-12), 1.3.0(10-15), 1.4.0(10-21), 1.5.0(11-02), 1.5.2(11-10)가 나왔다. 대략 주 1회다([CHANGELOG](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md)).
- 기여 정책: 새 기여자의 이슈와 PR은 자동으로 닫히고, 메인테이너가 매일 검토한다([README](https://github.com/earendil-works/pi)).

### 2-2.2 아키텍처
출처: [README](https://github.com/earendil-works/pi)
- 모노레포 패키지
  - `pi-ai`: OpenAI, Anthropic, Google 등을 하나로 묶는 LLM API
  - `pi-agent-core`: 에이전트 런타임
  - `pi-coding-agent`: CLI와 SDK
  - `pi-tui`
  - `pi-durable`, `pi-telemetry`, `chord`
- 기본 도구: read, bash, edit, write([package.json description](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/package.json))
- 서브에이전트와 plan mode는 일부러 넣지 않았다("skips features like sub-agents and plan mode").
- Node.js 22.19 이상이 필요하다.

### 2-2.3 임베딩 방식
- SDK: `createAgentSession()`으로 `AgentSession`을 만든다. `SessionManager.inMemory()`를 쓰면 세션 파일을 남기지 않는다([sdk.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)).
- RPC: `pi --mode rpc --no-session`으로 띄운다. stdin으로 JSONL 명령, stdout으로 `response`, 세션 이벤트, extension UI 레코드가 오간다. TypeScript용 `RpcClient`가 있다([rpc.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)).
- JSON 모드: `pi --mode json "<prompt>"`는 한 번 실행하고 세션 헤더와 이벤트를 JSONL로 낸 뒤 종료한다([json.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md)).
- 실제 통합 예로 README가 OpenClaw를 든다.

### 2-2.4 세션 형식
출처: [session-format.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md)
- 위치: `~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl`
- JSONL 파일이고, 항목은 `id`/`parentId`로 트리를 이뤄 한 파일 안에서 분기한다. 현재 버전은 v3이고, 이전 버전은 불러올 때 자동으로 마이그레이션한다.

### 2-2.5 프로바이더
출처: [providers.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md)
- API 키로 쓰는 프로바이더: Anthropic, OpenAI, Google Gemini, GitHub Copilot, Mistral, Groq, Cerebras, xAI, OpenRouter, Vercel AI Gateway, DeepSeek, Hugging Face, Fireworks, Together, Moonshot, MiniMax, Qwen, ZAI 등 30종 이상
- 별도 설정이 필요한 프로바이더: Azure OpenAI, Amazon Bedrock, Google Vertex AI, Cloudflare
- `/login`으로 구독 OAuth나 API 키를 연결하면 `auth.json`에 저장된다.

### 2-2.6 스킬
출처: [skills.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md), [configuration.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/configuration.md)
- [Agent Skills 사양](https://agentskills.io/specification)을 구현했다. 시작할 때 이름, 설명, 경로만 시스템 프롬프트에 넣고, 모델이 필요할 때 `SKILL.md`를 읽는다. `/skill:name`으로 강제 호출할 수 있다.
- 탐색 위치: `<agent-dir>/skills/`(기본 `~/.pi/agent`), `.pi/skills/`, `~/.agents/skills/`, 그리고 cwd부터 저장소 루트까지의 `.agents/skills/`. 설정의 `skills` 배열과 Pi 패키지(npm, git)로도 더할 수 있다.
- frontmatter에서 `disable-model-invocation`, `allowed-tools`(실험)를 지원한다. 이름이 겹치면 먼저 찾은 스킬을 쓰고 경고한다.

### 2-2.7 MCP — 입장이 바뀌었다
- 2025-11-30 블로그에서 Mario Zechner는 "pi does not and will not support MCP"라고 했다. 이유로는 "significant context overhead"를 들었다([블로그](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)).
- **0.99.0(2026-09-29)부터 MCP를 내장 확장으로 지원한다.** stdio와 streamable HTTP를 지원하고 OAuth도 된다. SSE는 거부한다([CHANGELOG](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md), [mcp.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md)).
- 설정 파일은 `~/.pi/agent/mcp.json`(사용자)과 `.pi/mcp.json`(프로젝트, project trust를 받은 뒤에만 읽음)이다. 형식은 Claude와 같은 `mcpServers`다. `env`와 `headers`에 `${VAR}`와 `!command`를 쓸 수 있다.
- 노출 방식(`exposure`)
  - `codemode`(기본): 모델이 쓴 JS를 QuickJS 샌드박스에서 돌려 도구를 호출한다.
  - `deferred`: `tool_search`로 찾은 도구만 선언한다.
  - `direct`
  - 도구별 지정은 `toolExposure`로 한다. 컨텍스트 비용 문제는 이 방식으로 우회한다.
- 모든 MCP 호출은 확장의 `tool_call`/`tool_result` 핸들러를 거친다. 그래서 권한 게이트 확장이 MCP 호출에도 적용된다.

### 2-2.8 확장·훅
출처: [extensions.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- 확장은 TypeScript 모듈이고 Pi 프로세스 안에서 같은 OS 권한으로 돈다. 위치는 `~/.pi/agent/extensions/`와 `.pi/extensions/`다.
- 할 수 있는 것: `pi.on(event)`로 생명주기 이벤트 구독, `tool_call`에서 차단하거나 입력 수정, `pi.registerTool`, `registerCommand`, 프로바이더와 MCP 서버 등록
- 확장, 스킬, 프롬프트, 테마를 Pi 패키지로 묶어 npm이나 git으로 배포한다([packages.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)).

### 2-2.9 샌드박스·권한 모델
출처: [README](https://github.com/earendil-works/pi), [security.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md)
- **내장 권한 시스템이 없다.** 실행한 사용자의 권한으로 돌고, 도구 호출마다 승인을 받지 않는다.
- 격리가 필요하면 컨테이너나 VM을 쓰라고 한다. 문서는 Gondolin 확장(micro-VM), Docker, OpenShell 세 가지를 안내한다.
- Project trust: `.pi/settings.json`, `.pi/mcp.json`, `.pi/extensions` 같은 프로젝트 리소스를 불러올지 정한다. 비대화형 모드에서는 `--approve`/`--no-approve`나 `defaultProjectTrust`로 정한다. 저장 위치는 `~/.pi/agent/trust.json`이다.
- `AGENTS.md`와 `CLAUDE.md`는 trust와 상관없이 로드된다.

---

## 2-3. Oh My Pi (omp)

### 2-3.1 존재 확인
**존재한다.** 저장소는 [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)다.
- GitHub에서 fork로 표시되지는 않지만, README에 "Fork of Pi by @mariozechner"라고 적혀 있다.
- 라이선스 MIT. 저작권 표기는 Mario Zechner, Can Bölük, Stencil Labs, Inc.이다([LICENSE](https://github.com/can1357/oh-my-pi/blob/main/LICENSE)).
- 메인테이너는 can1357(Can Bölük)이고 Stencil Labs가 만든다. 홈페이지는 [omp.sh](https://omp.sh)다.
- 활동: 별 약 39.5k, 생성 2025-12-31, 최신 릴리스 v19.0.0(2026-11-19)
  - 월별 릴리스 수: 2026-08 35건, 09 46건, 10 48건, 11 23건(20일까지)
  - 기여 수 상위: can1357 14035, roboomp(봇) 4570, H4vC, will-bogusz, badlogic
  - 2026-11-20 `gh api` 기준이다.
- npm 패키지는 `@oh-my-pi/pi-coding-agent` 19.0.0(MIT)이다.

### 2-3.2 pi에 더한 것
출처: [README](https://github.com/can1357/oh-my-pi)
- 런타임: Bun, 약 80k줄의 Rust 네이티브 코어(N-API). 자체 bash 5.3 엔진과 in-process ripgrep, glob이 들어 있다.
- 자체 표기: 60개 이상 프로바이더, 31개 내장 도구
- **LSP**: 쓰기마다 연동한다. rename에는 `workspace/willRenameFiles`를 쓴다([lsp-config.md](https://github.com/can1357/oh-my-pi/blob/main/docs/lsp-config.md)).
- **DAP 디버거**: lldb, dlv, debugpy를 붙인다.
- **서브에이전트**: `task`가 격리된 worktree로 작업을 나누고, 결과를 스키마로 검증해 돌려준다. Agent Hub에서 지켜볼 수 있다.
- 그 밖의 기능
  - advisor 모델: 매 턴 검토
  - `/review`: P0~P3 판정
  - TTSR: 정규식 규칙으로 스트림을 끊고 다시 시도
  - `/collab`: 세션 공유
  - 메모리: retain/learn/recall
  - hashline 편집
  - `pr://`, `skill://` 같은 내부 스킴
  - 브라우저와 데스크톱 조작
  - Python/JS 커널
- **MCP**: 네이티브로 지원한다.
  - 기본 위치는 `.omp/mcp.json`과 `~/.omp/agent/mcp.json`이다.
  - Claude Code, Codex(`~/.codex/config.toml`의 `[mcp_servers.*]`), Gemini CLI, OpenCode 설정도 읽어서 변환한다([mcp-config.md](https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md)).
- **스킬**: `.claude`, `.codex`, `.agents`, `.cursor` 등에서 자동으로 가져온다. 소스별 토글(`enableCodexUser`, `enableAgentsProject` 등)과 skillshare lock 파일이 있다([skills.md](https://github.com/can1357/oh-my-pi/blob/main/docs/skills.md)).
- **승인 모드**(pi에는 없는 기능)
  - 도구마다 `read`/`write`/`exec` 등급이 있다.
  - `tools.approvalMode`는 `always-ask`, `always-ask-cached`, `write`, `yolo`(기본) 중 하나다.
  - MCP 도구는 annotation과 상관없이 `write` 등급이다([approval-mode.md](https://github.com/can1357/oh-my-pi/blob/main/docs/approval-mode.md)).
- 진입점: 인터랙티브, `omp -p`, Node SDK(`createAgentSession`), `omp --mode rpc`(NDJSON), `omp acp`(Agent Client Protocol, Zed 등)
- 훅, 마켓플레이스, 플러그인 문서도 있다(docs/hooks.md, marketplace.md). 세부 내용은 읽지 않았다.
- 프로젝트 입력: 저장소를 열면 설정, 확장, 훅, 스킬, MCP를 "by design"으로 불러온다. 프로젝트 `.mcp.json`을 빼려면 `--config` 오버레이로 `mcp.enableProjectConfig: false`를 준다.

---

## 2-4. 확인 못 함
- Codex `requirements.toml`에 파일시스템 스킬을 허용 목록으로 제한하는 키가 있는지
- Codex Compliance API 보존 기간 30일과 API 키 사용분 제외의 원문(검색 요약에서만 봄)
- Codex `codex exec`의 `-c` 오버라이드 세부(이번 문서에는 없음)
- omp의 hooks, marketplace 세부와 Codex·Claude 훅 호환 여부
