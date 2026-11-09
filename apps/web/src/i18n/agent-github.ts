// The agent detail's GitHub tab (design github-agent.md §7). Kept apart from
// github.ts, which the workspace connection screen owns.
export const agentGitHubKo = {
  "agent.tabs.github": "GitHub",
  "agentGitHub.sectionNav": "GitHub 구역",
  "agentGitHub.manage": "관리",
  "agentGitHub.section.use": "사용",
  "agentGitHub.section.repositories": "저장소",
  "agentGitHub.section.details": "세부 설정",
  "agentGitHub.detailsHint":
    "기능 권한, Actions 허용 목록, push 승인입니다. 대부분은 기본값으로 충분합니다.",
  "agentGitHub.section.permissions": "권한",
  "agentGitHub.section.allowlist": "Actions 허용 목록",
  "agentGitHub.section.push": "push 승인",
  "agentGitHub.section.activity": "최근 기록",
  "agentGitHub.status": "상태",
  "agentGitHub.state.on": "사용 중",
  "agentGitHub.state.off": "꺼짐",
  "agentGitHub.status.repositories": "저장소 {count}개",
  "agentGitHub.status.repositoriesLegacy": "저장소 릴리스 설정대로",
  "agentGitHub.status.pushApproval": "push 전 승인",
  "agentGitHub.on": "켜짐",
  "agentGitHub.off": "꺼짐",
  "agentGitHub.badge.now": "즉시 반영",
  "agentGitHub.badge.default": "기본",
  "agentGitHub.badge.unsaved": "저장 전",
  "agentGitHub.enabled": "GitHub 사용",
  "agentGitHub.enabledHint":
    "끄면 이 에이전트에 새 GitHub 토큰을 내주지 않습니다. 진행 중인 세션도 다음 GitHub 요청부터 거절됩니다. 릴리스를 거치지 않고 바로 반영됩니다.",
  "agentGitHub.disableTitle": "GitHub 사용을 끌까요?",
  "agentGitHub.disableBody":
    "진행 중인 세션도 다음 GitHub 요청부터 거절됩니다. clone, push, PR, 워크플로 실행이 모두 멈춥니다.",
  "agentGitHub.disableConfirm": "끄기",
  "agentGitHub.enabledOn": "GitHub 사용을 켰습니다.",
  "agentGitHub.enabledOff": "GitHub 사용을 껐습니다.",
  "agentGitHub.offNote":
    "GitHub 사용이 꺼져 있어 아래 설정은 읽기만 할 수 있습니다.",
  "agentGitHub.pending.title": "저장하지 않은 변경 {count}건",
  "agentGitHub.pending.firstTitle": "GitHub 설정을 아직 저장하지 않았습니다",
  "agentGitHub.pending.body":
    "저장하면 다음에 시작하는 세션부터 적용됩니다. 권한을 줄이는 변경은 진행 중인 세션에도 바로 적용됩니다. 새 릴리스는 만들지 않습니다.",
  "agentGitHub.pending.save": "저장",
  "agentGitHub.pending.saving": "저장하는 중…",
  "agentGitHub.pending.revert": "되돌리기",
  "agentGitHub.pending.reload": "버리고 새로 읽기",
  "agentGitHub.saved":
    "GitHub 설정을 저장했습니다. 새 릴리스는 만들지 않았습니다.",
  "agentGitHub.conflict":
    "다른 곳에서 GitHub 설정이 먼저 바뀌어 저장하지 않았습니다. 변경을 버리고 새로 읽은 뒤 다시 바꾸세요.",
  "agentGitHub.stale":
    "다른 곳에서 GitHub 설정이 바뀌어 이 변경은 저장할 수 없습니다. 버리고 새로 읽으세요.",
  "agentGitHub.legacy":
    "이 에이전트에는 저장한 GitHub 설정이 아직 없습니다. 지금은 활성 릴리스의 설정(없으면 프로필이 허용하는 저장소 전체)으로 동작하고, 저장하면 이후 세션부터 아래 설정을 씁니다.",
  "agentGitHub.repositoriesHint":
    "이 에이전트가 쓸 GitHub 저장소를 켭니다. 켜고 끄는 즉시 저장됩니다. 켠 저장소는 새로 시작하는 세션부터 쓰고, 끈 저장소는 진행 중인 세션에서도 바로 쓸 수 없습니다. 토큰은 켠 저장소 하나로만 좁혀 발급합니다.",
  "agentGitHub.repositoriesNone":
    "이 App이 닿는 저장소가 없습니다. 워크스페이스 GitHub 설정에서 App 설치를 확인하세요.",
  "agentGitHub.ceilingUnset":
    "이 워크스페이스에는 아직 저장소 범위가 정해지지 않았습니다. 저장하면 기본 허용 목록(GitHub App이 닿는 저장소)이 적용됩니다.",
  "agentGitHub.repositoryToggle": "{name} 사용",
  "agentGitHub.repositoryOpen": "GitHub에서 {name} 열기",
  "agentGitHub.private": "비공개",
  "agentGitHub.repositoryRefused": "저장소를 바꾸지 못했습니다: {reason}",
  "agentGitHub.repositoryReason.repository_not_allowed":
    "워크스페이스가 허용한 저장소 범위 밖입니다.",
  "agentGitHub.repositoryReason.app_required":
    "PAT로 연결된 저장소라 권한을 좁힐 수 없습니다. GitHub App으로 옮겨야 고를 수 있습니다.",
  "agentGitHub.repositoriesFoot":
    "목록에 없는 저장소는 GitHub에서 App 설치에 더하면 나타납니다.",
  "agentGitHub.permissionsHint":
    "기본은 PR 작성·수정까지입니다. 브랜치 보호·필수 리뷰·CODEOWNERS처럼 GitHub가 막는 것은 저장소 설정을 따릅니다. merge 권한은 없습니다.",
  "agentGitHub.base": "PR 작성·수정",
  "agentGitHub.baseHint":
    "agent/<세션> 브랜치로 push하고, PR을 열고 고치고, 코멘트를 남깁니다. 필요한 권한: contents·pull requests 쓰기",
  "agentGitHub.baseState": "항상 켜짐",
  "agentGitHub.feature.review": "리뷰 승인",
  "agentGitHub.feature.reviewHint":
    "리뷰용 App으로 PR에 승인 리뷰를 남깁니다. 권장 권한이면 GitHub는 이 승인을 필수 리뷰로 세지 않으므로, 브랜치 규칙이 리뷰를 요구하면 쓰기 권한이 있는 사람의 승인처럼 GitHub가 인정하는 승인이 따로 필요합니다. 필요한 권한: 리뷰용 App의 pull requests 쓰기",
  "agentGitHub.feature.actions": "Actions 실행",
  "agentGitHub.feature.actionsHint":
    "허용 목록의 워크플로만 실행(workflow_dispatch)하거나 다시 실행합니다. 필요한 권한: actions 쓰기",
  "agentGitHub.feature.workflows": "워크플로 파일 수정",
  "agentGitHub.feature.workflowsHint":
    ".github/workflows 아래 파일을 바꾼 commit도 push합니다. 필요한 권한: workflows 쓰기",
  "agentGitHub.featureReason.app_permission_missing":
    "App에 이 권한이 없습니다. GitHub App 설정에서 더한 뒤 설치를 다시 승인하세요.",
  "agentGitHub.featureReason.over_workspace_ceiling":
    "워크스페이스 상한 밖입니다. 소유자·관리자가 GitHub 연결 설정에서 켭니다.",
  "agentGitHub.featureReason.no_reviewer_app":
    "워크스페이스에 리뷰용 App이 없습니다. PR을 만드는 App은 자기 PR을 승인할 수 없습니다.",
  "agentGitHub.featureReason.github_host_unsupported":
    "고른 저장소가 모두 GitHub Enterprise에 있어 기본 작업만 할 수 있습니다.",
  "agentGitHub.settingsLink": "GitHub 연결 설정",
  "agentGitHub.appNotInstalled": "App 미설치",
  "agentGitHub.reviewerNotInstalled":
    "리뷰용 App이 설치되지 않은 저장소: {repositories}. 그 저장소의 리뷰는 GitHub가 거절합니다.",
  "agentGitHub.workflowsActions":
    "워크플로 파일 수정과 Actions 실행을 같이 켜면, 에이전트가 허용 목록의 워크플로 파일을 자기 브랜치에서 고칠 수 있습니다. 사람이 그 브랜치를 머지하면 고친 파일이 실행 대상이 됩니다.",
  "agentGitHub.ceilingNote":
    "워크스페이스 상한은 소유자·관리자가 GitHub 연결 설정에서 정합니다.",
  "agentGitHub.allowlistHint":
    "Actions 실행이 켜져 있을 때 이 목록의 워크플로만 실행하거나 다시 실행합니다. 목록 밖의 workflow_dispatch와 다시 실행은 거절합니다.",
  "agentGitHub.allowlistEmpty": "목록에 없는 워크플로는 실행하지 않습니다.",
  "agentGitHub.allowlistOff":
    "Actions 실행을 켜면 실행할 워크플로를 고를 수 있습니다.",
  "agentGitHub.refDefault": "기본 브랜치만",
  "agentGitHub.refPattern": "ref 패턴 {ref}",
  "agentGitHub.remove": "빼기",
  "agentGitHub.removeLabel": "{workflow} 빼기",
  "agentGitHub.workflow": "워크플로 파일",
  "agentGitHub.workflowHint": ".github/workflows 아래의 파일 이름",
  "agentGitHub.ref": "ref 패턴(선택)",
  "agentGitHub.refHint": "비우면 기본 브랜치만. * 는 / 를 넘지 않습니다.",
  "agentGitHub.add": "워크플로 추가",
  "agentGitHub.workflowInvalid":
    "release.yml처럼 .yml이나 .yaml로 끝나는 파일 이름만 넣으세요. 경로는 받지 않습니다.",
  "agentGitHub.refAgent":
    "agent/ 브랜치는 에이전트가 내용을 정하므로 실행 대상이 될 수 없습니다.",
  "agentGitHub.refInvalid": "ref 패턴은 255자 이하로 넣으세요.",
  "agentGitHub.duplicate": "이미 목록에 있는 항목입니다.",
  "agentGitHub.full": "허용 목록은 32개까지입니다.",
  "agentGitHub.allowlistNote":
    "push나 pull_request로 자동 실행되는 워크플로는 막지 않습니다. 저장소의 Actions 설정을 따릅니다. 허용 목록에 넣는 워크플로는 입력값으로 실행할 코드나 checkout ref를 고르지 않아야 합니다.",
  "agentGitHub.pushApproval": "push 전 사람 승인",
  "agentGitHub.pushApprovalHint":
    "켜면 에이전트가 만든 commit을 sessions:approve 권한이 있는 사람이 승인해야 push합니다. 기존 에이전트는 켜진 채로 옮겨졌습니다.",
  "agentGitHub.pushApprovalOff":
    "승인 없이 agent/<세션> 브랜치로 push하고 PR을 엽니다.",
  "agentGitHub.pushAttached": "첨부 저장소 push",
  "agentGitHub.pushAttachedHint":
    "세션이 붙인 저장소의 agent/<세션> 브랜치로 push할 때의 규칙입니다. 세션의 주 저장소는 위의 승인 설정을 따릅니다.",
  "agentGitHub.pushAttached.allow": "승인 없이 허용",
  "agentGitHub.pushAttached.ask": "사람 승인 필요",
  "agentGitHub.pushAttached.deny": "허용하지 않음",
  "agentGitHub.pushAttachedAllowNote":
    "첨부 저장소는 사람 승인 없이 붙으므로, 허용하면 붙이기와 push가 사람 없이 이어집니다. 대상은 agent/<세션> 브랜치뿐이고 force push는 하지 않습니다.",
  "agentGitHub.activityHint":
    "토큰 발급과 거절, 설정 변경, 워크플로 실행은 감사 기록(receipt)에 남습니다. 볼 수 있는 세션의 기록만 보입니다.",
  "agentGitHub.activityEmpty": "아직 GitHub 기록이 없습니다.",
  "agentGitHub.activity.set_agent_github.on": "GitHub 사용 켬",
  "agentGitHub.activity.set_agent_github.off": "GitHub 사용 끔",
  "agentGitHub.activity.set_agent_github.settings": "GitHub 설정 저장",
  "agentGitHub.activity.create_agent_release": "GitHub 설정을 바꾼 릴리스",
  "agentGitHub.activity.activate_agent": "GitHub 설정을 바꾼 활성화",
  "agentGitHub.activity.mint_github_token": "토큰 발급",
  "agentGitHub.activity.mint_github_token.failed": "토큰 거절",
  "agentGitHub.activity.dispatch_workflow": "워크플로 실행",
  "agentGitHub.activity.dispatch_workflow.failed": "워크플로 실행 거절",
  "agentGitHub.activity.rerun_workflow": "워크플로 다시 실행",
  "agentGitHub.activity.rerun_workflow.failed": "다시 실행 거절",
  "agentGitHub.activity.review_pull_request": "리뷰",
  "agentGitHub.activity.review_pull_request.failed": "리뷰 거절",
  "agentGitHub.activity.session": "세션",
  "agentGitHub.activity.release": "릴리스 {release}",
  "agentGitHub.activity.byAdmin": "에이전트 관리자가 변경",
  "agentGitHub.purpose.clone": "clone",
  "agentGitHub.purpose.push": "push",
  "agentGitHub.purpose.pull_request": "PR",
  "agentGitHub.purpose.actions_read": "실행 조회",
  "agentGitHub.purpose.dispatch": "워크플로 실행",
  "agentGitHub.purpose.rerun": "다시 실행",
  "agentGitHub.purpose.review": "리뷰",
  "agentGitHub.purpose.outcome_refresh": "PR 상태 확인",
  "agentGitHub.purpose.merge": "PR 머지",
  "agentGitHub.refusal.github_disabled": "GitHub 사용 꺼짐",
  "agentGitHub.refusal.repository_not_allowed": "저장소 범위 밖",
  "agentGitHub.refusal.feature_off": "릴리스에서 꺼진 권한",
  "agentGitHub.refusal.over_workspace_ceiling": "워크스페이스 상한 밖",
  "agentGitHub.refusal.app_permission_missing": "App 권한 없음",
  "agentGitHub.refusal.no_reviewer_app": "리뷰용 App 없음",
  "agentGitHub.refusal.app_required": "GitHub App 필요",
  "agentGitHub.refusal.workflow_not_allowed": "허용 목록 밖",
  "agentGitHub.refusal.agent_ref_refused": "agent/ 브랜치 실행 거절",
  "agentGitHub.refusal.run_ref_unprovable": "플랫폼이 실행하지 않은 run",
  "agentGitHub.refusal.actions_off": "Actions 실행 꺼짐",
  "agentGitHub.refusal.github_settings_unsupported": "이 서버가 모르는 설정",
  "agentGitHub.refusal.github_host_unsupported": "GitHub Enterprise",
  "agentGitHub.refusal.repository_none": "저장소 없음",
  "agentGitHub.refusal.ambiguous_app": "App 선택 필요",
  "agentGitHub.refusal.pinned_app_removed": "고정된 App 삭제됨",
  "agentGitHub.refusal.merge_off": "워크스페이스가 머지를 허용하지 않음",
  "agentGitHub.refusalNext.ambiguous_app":
    "워크스페이스 설정 › GitHub 연결 설정 › 저장소 관리에서 이 저장소를 맡을 App을 고르세요",
  "agentGitHub.refusalNext.pinned_app_removed":
    "워크스페이스 설정 › GitHub 연결 설정 › 저장소 관리에서 이 저장소를 맡을 다른 App을 고르세요",
  "agentGitHub.saveRefused": "저장하지 못했습니다: {reason}",
  "agentGitHub.refused": "거절",
  "agentPullRequest.title": "Pull request 서식",
  "agentPullRequest.hint":
    "이 에이전트가 여는 Pull request의 본문을 워크스페이스 설정 위에 덮어씁니다. GitHub 세부 설정과 따로 저장하며, 릴리스를 만들지 않습니다. 이후에 여는·갱신하는 PR부터 적용됩니다.",
  "agentPullRequest.formatting": "서식",
  "agentPullRequest.formatting.inherit": "워크스페이스 설정을 따름",
  "agentPullRequest.formatting.on": "템플릿 사용",
  "agentPullRequest.formatting.off": "템플릿 사용 안 함",
  "agentPullRequest.formattingHint":
    "사용 안 함이면 저장소 템플릿과 아래 템플릿을 쓰지 않고 기본 서식으로 채웁니다.",
  "agentPullRequest.templateName": "저장소 템플릿 파일 이름",
  "agentPullRequest.templateNameHint":
    "저장소의 PULL_REQUEST_TEMPLATE 폴더에 파일이 여럿일 때 쓸 파일 이름입니다. 대소문자는 구분하지 않고, 경로로 쓰이지 않습니다.",
  "agentPullRequest.template": "이 에이전트의 템플릿",
  "agentPullRequest.templateHint":
    "비워 두면 워크스페이스의 템플릿을 씁니다. {bytes} / {max} 바이트",
  "agentPullRequest.save": "서식 저장",
  "agentPullRequest.saved": "Pull request 서식을 저장했습니다.",
  "agentPullRequest.conflict":
    "다른 곳에서 먼저 바꿨습니다. 저장된 값을 다시 불러왔으니 확인한 뒤 저장해 주세요.",
  "agentPullRequest.tooLarge":
    "템플릿이 {max} 바이트를 넘어 저장하지 못했습니다.",
  "agentPullRequest.invalidText": "템플릿이 올바른 UTF-8 텍스트가 아닙니다.",
  "agentPullRequest.unsupported":
    "템플릿에 지원하지 않는 마크업이 있거나 주석이 닫히지 않았습니다.",
};

export const agentGitHubEn: Record<keyof typeof agentGitHubKo, string> = {
  "agent.tabs.github": "GitHub",
  "agentGitHub.sectionNav": "GitHub sections",
  "agentGitHub.manage": "Manage",
  "agentGitHub.section.use": "Use",
  "agentGitHub.section.repositories": "Repositories",
  "agentGitHub.section.details": "Advanced settings",
  "agentGitHub.detailsHint":
    "Optional permissions, the Actions allow-list and push approval. The defaults suit most agents.",
  "agentGitHub.section.permissions": "Permissions",
  "agentGitHub.section.allowlist": "Actions allow list",
  "agentGitHub.section.push": "Push approval",
  "agentGitHub.section.activity": "Recent activity",
  "agentGitHub.status": "Status",
  "agentGitHub.state.on": "In use",
  "agentGitHub.state.off": "Off",
  "agentGitHub.status.repositories": "{count} repositories",
  "agentGitHub.status.repositoriesLegacy": "Repositories: as the release sets",
  "agentGitHub.status.pushApproval": "Approval before push",
  "agentGitHub.on": "On",
  "agentGitHub.off": "Off",
  "agentGitHub.badge.now": "Applies now",
  "agentGitHub.badge.default": "Default",
  "agentGitHub.badge.unsaved": "Unsaved",
  "agentGitHub.enabled": "Use GitHub",
  "agentGitHub.enabledHint":
    "When off, this agent gets no new GitHub token. Running sessions are refused from their next GitHub request. Applies at once, without a release.",
  "agentGitHub.disableTitle": "Turn GitHub off?",
  "agentGitHub.disableBody":
    "Running sessions are refused from their next GitHub request. Clone, push, pull requests and workflow runs all stop.",
  "agentGitHub.disableConfirm": "Turn off",
  "agentGitHub.enabledOn": "GitHub is on.",
  "agentGitHub.enabledOff": "GitHub is off.",
  "agentGitHub.offNote": "GitHub is off, so the settings below are read only.",
  "agentGitHub.pending.title": "{count} unsaved changes",
  "agentGitHub.pending.firstTitle": "GitHub settings are not saved yet",
  "agentGitHub.pending.body":
    "Saving applies from the next session that starts. A change that narrows a permission also applies to running sessions. No new release is made.",
  "agentGitHub.pending.save": "Save",
  "agentGitHub.pending.saving": "Saving…",
  "agentGitHub.pending.revert": "Revert",
  "agentGitHub.pending.reload": "Discard and reload",
  "agentGitHub.saved": "GitHub settings saved. No new release was made.",
  "agentGitHub.conflict":
    "The GitHub settings changed elsewhere first, so nothing was saved. Discard your changes, reload, and make them again.",
  "agentGitHub.stale":
    "The GitHub settings changed elsewhere, so these changes cannot be saved. Discard them and reload.",
  "agentGitHub.legacy":
    "This agent has no saved GitHub settings yet. It runs on the active release's settings (every repository its profile allows, if none). Saving makes later sessions use the settings below.",
  "agentGitHub.repositoriesHint":
    "Turn on the GitHub repositories this agent may use. A switch saves as soon as you flip it. A repository you turn on is used from the next session that starts; one you turn off is refused in running sessions too. Each token is narrowed to a single enabled repository.",
  "agentGitHub.repositoriesNone":
    "The App reaches no repositories. Check its installation in the workspace GitHub settings.",
  "agentGitHub.ceilingUnset":
    "This workspace has no repository scope yet. Saving applies the default allow list (the repositories the GitHub App reaches).",
  "agentGitHub.repositoryToggle": "Use {name}",
  "agentGitHub.repositoryOpen": "Open {name} on GitHub",
  "agentGitHub.private": "Private",
  "agentGitHub.repositoryRefused":
    "The repository could not be changed: {reason}",
  "agentGitHub.repositoryReason.repository_not_allowed":
    "Outside the repositories the workspace allows.",
  "agentGitHub.repositoryReason.app_required":
    "It connects with a PAT, which cannot be narrowed. Move it to a GitHub App to pick it.",
  "agentGitHub.repositoriesFoot":
    "A repository missing here appears once you add it to the App's installation on GitHub.",
  "agentGitHub.permissionsHint":
    "By default an agent writes pull requests and nothing more. What GitHub enforces, such as branch protection, required reviews and CODEOWNERS, follows the repository's settings. There is no merge permission.",
  "agentGitHub.base": "Write pull requests",
  "agentGitHub.baseHint":
    "Pushes to agent/<session> branches, opens and updates pull requests, comments. Needs: contents and pull requests write",
  "agentGitHub.baseState": "Always on",
  "agentGitHub.feature.review": "Approve reviews",
  "agentGitHub.feature.reviewHint":
    "Leaves approving reviews with the reviewer App. With the recommended permissions GitHub does not count them toward required reviews, so where a branch rule requires a review, another approval GitHub counts is still needed, such as one from a person with write access. Needs: the reviewer App's pull requests write",
  "agentGitHub.feature.actions": "Run Actions",
  "agentGitHub.feature.actionsHint":
    "Runs (workflow_dispatch) or reruns only workflows on the allow list. Needs: actions write",
  "agentGitHub.feature.workflows": "Edit workflow files",
  "agentGitHub.feature.workflowsHint":
    "Also pushes commits that change files under .github/workflows. Needs: workflows write",
  "agentGitHub.featureReason.app_permission_missing":
    "The App lacks this permission. Add it in the GitHub App's settings, then approve the installation again.",
  "agentGitHub.featureReason.over_workspace_ceiling":
    "Over the workspace ceiling. Owners and admins turn it on in the GitHub connection settings.",
  "agentGitHub.featureReason.no_reviewer_app":
    "The workspace has no reviewer App. The App that writes pull requests cannot approve its own.",
  "agentGitHub.featureReason.github_host_unsupported":
    "Every chosen repository is on GitHub Enterprise, which takes the default work only.",
  "agentGitHub.settingsLink": "GitHub connection settings",
  "agentGitHub.appNotInstalled": "App not installed",
  "agentGitHub.reviewerNotInstalled":
    "The reviewer App is not installed on: {repositories}. GitHub refuses reviews there.",
  "agentGitHub.workflowsActions":
    "With workflow edits and Actions both on, the agent can change an allowed workflow file on its own branch. Once a person merges that branch, the changed file is what runs.",
  "agentGitHub.ceilingNote":
    "Owners and admins set the workspace ceiling in the GitHub connection settings.",
  "agentGitHub.allowlistHint":
    "With Run Actions on, only workflows on this list run or rerun. Any other workflow_dispatch or rerun is refused.",
  "agentGitHub.allowlistEmpty": "No workflow outside the list runs.",
  "agentGitHub.allowlistOff":
    "Turn Run Actions on to pick the workflows it may run.",
  "agentGitHub.refDefault": "Default branch only",
  "agentGitHub.refPattern": "ref pattern {ref}",
  "agentGitHub.remove": "Remove",
  "agentGitHub.removeLabel": "Remove {workflow}",
  "agentGitHub.workflow": "Workflow file",
  "agentGitHub.workflowHint": "A file name under .github/workflows",
  "agentGitHub.ref": "ref pattern (optional)",
  "agentGitHub.refHint": "Empty: the default branch only. * does not cross /.",
  "agentGitHub.add": "Add workflow",
  "agentGitHub.workflowInvalid":
    "Enter a file name ending in .yml or .yaml, such as release.yml. Paths are not taken.",
  "agentGitHub.refAgent":
    "agent/ branches hold what the agent wrote, so they never run.",
  "agentGitHub.refInvalid": "Keep the ref pattern to 255 characters.",
  "agentGitHub.duplicate": "That entry is already on the list.",
  "agentGitHub.full": "The allow list holds up to 32 entries.",
  "agentGitHub.allowlistNote":
    "Workflows that run on push or pull_request are not blocked; the repository's Actions settings decide. A workflow on this list must not let its inputs choose the code it runs or the ref it checks out.",
  "agentGitHub.pushApproval": "Approve before push",
  "agentGitHub.pushApprovalHint":
    "When on, someone with sessions:approve approves the agent's commits before they are pushed. Existing agents moved over with it on.",
  "agentGitHub.pushApprovalOff":
    "Pushes to agent/<session> branches and opens pull requests without approval.",
  "agentGitHub.pushAttached": "Push to attached repositories",
  "agentGitHub.pushAttachedHint":
    "The rule for pushing to agent/<session> branches of repositories a session attached. The session's own repository follows the approval setting above.",
  "agentGitHub.pushAttached.allow": "Allow without approval",
  "agentGitHub.pushAttached.ask": "Ask a person",
  "agentGitHub.pushAttached.deny": "Do not allow",
  "agentGitHub.pushAttachedAllowNote":
    "A repository is attached without a person's approval, so allowing this lets attaching and pushing run with no person involved. It reaches only agent/<session> branches and never force-pushes.",
  "agentGitHub.activityHint":
    "Tokens issued or refused, setting changes and workflow runs are kept as receipts. Only sessions you can see are shown.",
  "agentGitHub.activityEmpty": "No GitHub activity yet.",
  "agentGitHub.activity.set_agent_github.on": "GitHub turned on",
  "agentGitHub.activity.set_agent_github.off": "GitHub turned off",
  "agentGitHub.activity.set_agent_github.settings": "GitHub settings saved",
  "agentGitHub.activity.create_agent_release":
    "Release with changed GitHub settings",
  "agentGitHub.activity.activate_agent":
    "Activation that changed GitHub settings",
  "agentGitHub.activity.mint_github_token": "Token issued",
  "agentGitHub.activity.mint_github_token.failed": "Token refused",
  "agentGitHub.activity.dispatch_workflow": "Workflow run",
  "agentGitHub.activity.dispatch_workflow.failed": "Workflow run refused",
  "agentGitHub.activity.rerun_workflow": "Workflow rerun",
  "agentGitHub.activity.rerun_workflow.failed": "Rerun refused",
  "agentGitHub.activity.review_pull_request": "Review",
  "agentGitHub.activity.review_pull_request.failed": "Review refused",
  "agentGitHub.activity.session": "Session",
  "agentGitHub.activity.release": "Release {release}",
  "agentGitHub.activity.byAdmin": "Changed by an agent admin",
  "agentGitHub.purpose.clone": "clone",
  "agentGitHub.purpose.push": "push",
  "agentGitHub.purpose.pull_request": "pull request",
  "agentGitHub.purpose.actions_read": "run lookup",
  "agentGitHub.purpose.dispatch": "workflow run",
  "agentGitHub.purpose.rerun": "rerun",
  "agentGitHub.purpose.review": "review",
  "agentGitHub.purpose.outcome_refresh": "pull request check",
  "agentGitHub.purpose.merge": "merge",
  "agentGitHub.refusal.github_disabled": "GitHub off",
  "agentGitHub.refusal.repository_not_allowed": "Repository out of scope",
  "agentGitHub.refusal.feature_off": "Permission off in the release",
  "agentGitHub.refusal.over_workspace_ceiling": "Over the workspace ceiling",
  "agentGitHub.refusal.app_permission_missing": "App lacks the permission",
  "agentGitHub.refusal.no_reviewer_app": "No reviewer App",
  "agentGitHub.refusal.app_required": "Needs a GitHub App",
  "agentGitHub.refusal.workflow_not_allowed": "Not on the allow list",
  "agentGitHub.refusal.agent_ref_refused": "agent/ branch refused",
  "agentGitHub.refusal.run_ref_unprovable": "A run the platform did not start",
  "agentGitHub.refusal.actions_off": "Run Actions off",
  "agentGitHub.refusal.github_settings_unsupported":
    "Settings this server does not know",
  "agentGitHub.refusal.github_host_unsupported": "GitHub Enterprise",
  "agentGitHub.refusal.repository_none": "No repository",
  "agentGitHub.refusal.ambiguous_app": "App choice needed",
  "agentGitHub.refusal.pinned_app_removed": "Pinned App removed",
  "agentGitHub.refusal.merge_off": "The workspace does not allow merging",
  "agentGitHub.refusalNext.ambiguous_app":
    "Choose the App that handles this repository under Workspace settings › GitHub connection › Manage repositories",
  "agentGitHub.refusalNext.pinned_app_removed":
    "Choose another App to handle this repository under Workspace settings › GitHub connection › Manage repositories",
  "agentGitHub.saveRefused": "Not saved: {reason}",
  "agentGitHub.refused": "Refused",
  "agentPullRequest.title": "Pull request layout",
  "agentPullRequest.hint":
    "Overrides the workspace's settings for the pull request bodies this agent opens. Saved apart from the GitHub details and makes no release. It applies to pull requests opened or updated afterwards.",
  "agentPullRequest.formatting": "Layout",
  "agentPullRequest.formatting.inherit": "Follow the workspace",
  "agentPullRequest.formatting.on": "Use templates",
  "agentPullRequest.formatting.off": "Do not use templates",
  "agentPullRequest.formattingHint":
    "When off, neither the repository's template nor the one below is used and the body is filled in the default layout.",
  "agentPullRequest.templateName": "Repository template file name",
  "agentPullRequest.templateNameHint":
    "Which file to use when the repository's PULL_REQUEST_TEMPLATE folder holds several. Case does not matter, and it is never used as a path.",
  "agentPullRequest.template": "This agent's template",
  "agentPullRequest.templateHint":
    "Leave empty to use the workspace's template. {bytes} / {max} bytes",
  "agentPullRequest.save": "Save layout",
  "agentPullRequest.saved": "Saved the pull request layout.",
  "agentPullRequest.conflict":
    "Someone changed it first. The saved values were reloaded; check them and save again.",
  "agentPullRequest.tooLarge":
    "The template is over {max} bytes and was not saved.",
  "agentPullRequest.invalidText": "The template is not valid UTF-8 text.",
  "agentPullRequest.unsupported":
    "The template has unsupported markup or an unclosed comment.",
};

export const agentGitHubJa: Record<keyof typeof agentGitHubKo, string> = {
  "agent.tabs.github": "GitHub",
  "agentGitHub.sectionNav": "GitHub の項目",
  "agentGitHub.manage": "管理",
  "agentGitHub.section.use": "利用",
  "agentGitHub.section.repositories": "リポジトリ",
  "agentGitHub.section.details": "詳細設定",
  "agentGitHub.detailsHint":
    "任意の権限、Actions 許可リスト、push の承認。多くのエージェントでは既定のままで十分です。",
  "agentGitHub.section.permissions": "権限",
  "agentGitHub.section.allowlist": "Actions 許可リスト",
  "agentGitHub.section.push": "push の承認",
  "agentGitHub.section.activity": "最近の記録",
  "agentGitHub.status": "状態",
  "agentGitHub.state.on": "利用中",
  "agentGitHub.state.off": "オフ",
  "agentGitHub.status.repositories": "リポジトリ {count} 件",
  "agentGitHub.status.repositoriesLegacy": "リポジトリ: リリースの設定どおり",
  "agentGitHub.status.pushApproval": "push 前の承認",
  "agentGitHub.on": "オン",
  "agentGitHub.off": "オフ",
  "agentGitHub.badge.now": "すぐ反映",
  "agentGitHub.badge.default": "既定",
  "agentGitHub.badge.unsaved": "未保存",
  "agentGitHub.enabled": "GitHub を使う",
  "agentGitHub.enabledHint":
    "オフにすると、このエージェントに新しい GitHub トークンを出しません。実行中のセッションも次の GitHub リクエストから拒否されます。リリースを経ずにすぐ反映されます。",
  "agentGitHub.disableTitle": "GitHub をオフにしますか?",
  "agentGitHub.disableBody":
    "実行中のセッションも次の GitHub リクエストから拒否されます。clone、push、PR、ワークフロー実行がすべて止まります。",
  "agentGitHub.disableConfirm": "オフにする",
  "agentGitHub.enabledOn": "GitHub をオンにしました。",
  "agentGitHub.enabledOff": "GitHub をオフにしました。",
  "agentGitHub.offNote": "GitHub がオフのため、以下の設定は読むだけです。",
  "agentGitHub.pending.title": "未保存の変更 {count} 件",
  "agentGitHub.pending.firstTitle": "GitHub 設定はまだ保存されていません",
  "agentGitHub.pending.body":
    "保存すると、次に始まるセッションから適用されます。権限を絞る変更は、実行中のセッションにも適用されます。新しいリリースは作りません。",
  "agentGitHub.pending.save": "保存",
  "agentGitHub.pending.saving": "保存しています…",
  "agentGitHub.pending.revert": "元に戻す",
  "agentGitHub.pending.reload": "破棄して読み込み直す",
  "agentGitHub.saved":
    "GitHub の設定を保存しました。新しいリリースは作っていません。",
  "agentGitHub.conflict":
    "その間に別の場所で GitHub の設定が変わったため、保存していません。変更を破棄して読み込み直し、もう一度変更してください。",
  "agentGitHub.stale":
    "別の場所で GitHub の設定が変わったため、この変更は保存できません。破棄して読み込み直してください。",
  "agentGitHub.legacy":
    "このエージェントにはまだ保存された GitHub の設定がありません。有効なリリースの設定(なければプロファイルが許可するすべてのリポジトリ)で動きます。保存すると、以降のセッションは以下の設定を使います。",
  "agentGitHub.repositoriesHint":
    "このエージェントが使う GitHub リポジトリをオンにします。スイッチは切り替えるとすぐ保存されます。オンにしたリポジトリは次に始まるセッションから使われ、オフにしたリポジトリは実行中のセッションでもすぐ使えなくなります。トークンはオンのリポジトリ 1 つに絞って発行します。",
  "agentGitHub.repositoriesNone":
    "この App が届くリポジトリがありません。ワークスペースの GitHub 設定で App のインストールを確認してください。",
  "agentGitHub.ceilingUnset":
    "このワークスペースにはリポジトリの範囲がまだありません。保存すると既定の許可リスト（GitHub App が届くリポジトリ）が適用されます。",
  "agentGitHub.repositoryToggle": "{name} を使う",
  "agentGitHub.repositoryOpen": "GitHub で {name} を開く",
  "agentGitHub.private": "非公開",
  "agentGitHub.repositoryRefused": "リポジトリを変更できませんでした: {reason}",
  "agentGitHub.repositoryReason.repository_not_allowed":
    "ワークスペースが許可するリポジトリの範囲外です。",
  "agentGitHub.repositoryReason.app_required":
    "PAT で接続されたリポジトリのため権限を絞れません。GitHub App に移すと選べます。",
  "agentGitHub.repositoriesFoot":
    "一覧にないリポジトリは、GitHub で App のインストールに加えると表示されます。",
  "agentGitHub.permissionsHint":
    "既定は PR の作成・修正までです。ブランチ保護・必須レビュー・CODEOWNERS のように GitHub が止めるものはリポジトリの設定に従います。merge の権限はありません。",
  "agentGitHub.base": "PR の作成・修正",
  "agentGitHub.baseHint":
    "agent/<セッション> ブランチに push し、PR を開いて直し、コメントを残します。必要な権限: contents・pull requests の書き込み",
  "agentGitHub.baseState": "常にオン",
  "agentGitHub.feature.review": "レビュー承認",
  "agentGitHub.feature.reviewHint":
    "レビュー用 App で PR に承認レビューを残します。推奨する権限では GitHub はこの承認を必須レビューに数えないため、ブランチのルールがレビューを求める場合は、書き込み権限を持つ人の承認など、GitHub が数える承認が別に必要です。必要な権限:レビュー用 App の pull requests の書き込み",
  "agentGitHub.feature.actions": "Actions の実行",
  "agentGitHub.feature.actionsHint":
    "許可リストのワークフローだけを実行(workflow_dispatch)または再実行します。必要な権限: actions の書き込み",
  "agentGitHub.feature.workflows": "ワークフローファイルの変更",
  "agentGitHub.feature.workflowsHint":
    ".github/workflows 以下のファイルを変えた commit も push します。必要な権限: workflows の書き込み",
  "agentGitHub.featureReason.app_permission_missing":
    "App にこの権限がありません。GitHub App の設定で加えてから、インストールを承認し直してください。",
  "agentGitHub.featureReason.over_workspace_ceiling":
    "ワークスペースの上限の外です。オーナー・管理者が GitHub 連携の設定でオンにします。",
  "agentGitHub.featureReason.no_reviewer_app":
    "ワークスペースにレビュー用 App がありません。PR を作る App は自分の PR を承認できません。",
  "agentGitHub.featureReason.github_host_unsupported":
    "選んだリポジトリがすべて GitHub Enterprise にあるため、基本の作業だけができます。",
  "agentGitHub.settingsLink": "GitHub 連携の設定",
  "agentGitHub.appNotInstalled": "App 未インストール",
  "agentGitHub.reviewerNotInstalled":
    "レビュー用 App がインストールされていないリポジトリ: {repositories}。そこでのレビューは GitHub が拒否します。",
  "agentGitHub.workflowsActions":
    "ワークフローファイルの変更と Actions の実行を両方オンにすると、エージェントが許可リストのワークフローファイルを自分のブランチで変えられます。人がそのブランチをマージすると、変えたファイルが実行対象になります。",
  "agentGitHub.ceilingNote":
    "ワークスペースの上限はオーナー・管理者が GitHub 連携の設定で決めます。",
  "agentGitHub.allowlistHint":
    "Actions の実行がオンのとき、このリストのワークフローだけを実行・再実行します。リスト外の workflow_dispatch と再実行は拒否します。",
  "agentGitHub.allowlistEmpty": "リストにないワークフローは実行しません。",
  "agentGitHub.allowlistOff":
    "Actions の実行をオンにすると、実行するワークフローを選べます。",
  "agentGitHub.refDefault": "既定のブランチのみ",
  "agentGitHub.refPattern": "ref パターン {ref}",
  "agentGitHub.remove": "外す",
  "agentGitHub.removeLabel": "{workflow} を外す",
  "agentGitHub.workflow": "ワークフローファイル",
  "agentGitHub.workflowHint": ".github/workflows 以下のファイル名",
  "agentGitHub.ref": "ref パターン(任意)",
  "agentGitHub.refHint": "空なら既定のブランチのみ。* は / をまたぎません。",
  "agentGitHub.add": "ワークフローを追加",
  "agentGitHub.workflowInvalid":
    "release.yml のように .yml か .yaml で終わるファイル名だけを入れてください。パスは受け付けません。",
  "agentGitHub.refAgent":
    "agent/ ブランチはエージェントが中身を決めるため、実行対象にできません。",
  "agentGitHub.refInvalid": "ref パターンは 255 文字以下にしてください。",
  "agentGitHub.duplicate": "すでにリストにある項目です。",
  "agentGitHub.full": "許可リストは 32 件までです。",
  "agentGitHub.allowlistNote":
    "push や pull_request で自動実行されるワークフローは止めません。リポジトリの Actions 設定に従います。許可リストに入れるワークフローは、入力値で実行するコードや checkout する ref を選ばないものにしてください。",
  "agentGitHub.pushApproval": "push 前の人の承認",
  "agentGitHub.pushApprovalHint":
    "オンにすると、エージェントが作った commit を sessions:approve 権限のある人が承認してから push します。既存のエージェントはオンのまま移行しました。",
  "agentGitHub.pushApprovalOff":
    "承認なしで agent/<セッション> ブランチに push し、PR を開きます。",
  "agentGitHub.pushAttached": "追加リポジトリへの push",
  "agentGitHub.pushAttachedHint":
    "セッションが追加したリポジトリの agent/<セッション> ブランチへ push するときのルールです。セッションの主リポジトリは上の承認設定に従います。",
  "agentGitHub.pushAttached.allow": "承認なしで許可",
  "agentGitHub.pushAttached.ask": "人の承認が必要",
  "agentGitHub.pushAttached.deny": "許可しない",
  "agentGitHub.pushAttachedAllowNote":
    "追加リポジトリは人の承認なしで追加されるため、許可すると追加と push が人を介さず続きます。対象は agent/<セッション> ブランチだけで、force push は行いません。",
  "agentGitHub.activityHint":
    "トークンの発行と拒否、設定の変更、ワークフローの実行は監査記録(receipt)に残ります。見られるセッションの記録だけを表示します。",
  "agentGitHub.activityEmpty": "まだ GitHub の記録がありません。",
  "agentGitHub.activity.set_agent_github.on": "GitHub をオン",
  "agentGitHub.activity.set_agent_github.off": "GitHub をオフ",
  "agentGitHub.activity.set_agent_github.settings": "GitHub 設定を保存",
  "agentGitHub.activity.create_agent_release": "GitHub 設定を変えたリリース",
  "agentGitHub.activity.activate_agent": "GitHub 設定を変えた有効化",
  "agentGitHub.activity.mint_github_token": "トークン発行",
  "agentGitHub.activity.mint_github_token.failed": "トークン拒否",
  "agentGitHub.activity.dispatch_workflow": "ワークフロー実行",
  "agentGitHub.activity.dispatch_workflow.failed": "ワークフロー実行の拒否",
  "agentGitHub.activity.rerun_workflow": "ワークフロー再実行",
  "agentGitHub.activity.rerun_workflow.failed": "再実行の拒否",
  "agentGitHub.activity.review_pull_request": "レビュー",
  "agentGitHub.activity.review_pull_request.failed": "レビューの拒否",
  "agentGitHub.activity.session": "セッション",
  "agentGitHub.activity.release": "リリース {release}",
  "agentGitHub.activity.byAdmin": "エージェント管理者が変更",
  "agentGitHub.purpose.clone": "clone",
  "agentGitHub.purpose.push": "push",
  "agentGitHub.purpose.pull_request": "PR",
  "agentGitHub.purpose.actions_read": "実行の照会",
  "agentGitHub.purpose.dispatch": "ワークフロー実行",
  "agentGitHub.purpose.rerun": "再実行",
  "agentGitHub.purpose.review": "レビュー",
  "agentGitHub.purpose.outcome_refresh": "PR の状態確認",
  "agentGitHub.purpose.merge": "PR のマージ",
  "agentGitHub.refusal.github_disabled": "GitHub オフ",
  "agentGitHub.refusal.repository_not_allowed": "リポジトリの範囲外",
  "agentGitHub.refusal.feature_off": "リリースでオフの権限",
  "agentGitHub.refusal.over_workspace_ceiling": "ワークスペースの上限外",
  "agentGitHub.refusal.app_permission_missing": "App の権限なし",
  "agentGitHub.refusal.no_reviewer_app": "レビュー用 App なし",
  "agentGitHub.refusal.app_required": "GitHub App が必要",
  "agentGitHub.refusal.workflow_not_allowed": "許可リスト外",
  "agentGitHub.refusal.agent_ref_refused": "agent/ ブランチの実行拒否",
  "agentGitHub.refusal.run_ref_unprovable":
    "プラットフォームが始めていない run",
  "agentGitHub.refusal.actions_off": "Actions の実行オフ",
  "agentGitHub.refusal.github_settings_unsupported":
    "このサーバーが知らない設定",
  "agentGitHub.refusal.github_host_unsupported": "GitHub Enterprise",
  "agentGitHub.refusal.repository_none": "リポジトリなし",
  "agentGitHub.refusal.ambiguous_app": "App の選択が必要",
  "agentGitHub.refusal.pinned_app_removed": "固定した App は削除済み",
  "agentGitHub.refusal.merge_off": "ワークスペースがマージを許可していない",
  "agentGitHub.refusalNext.ambiguous_app":
    "ワークスペース設定 › GitHub 連携設定 › リポジトリを管理 で、このリポジトリを担当する App を選んでください",
  "agentGitHub.refusalNext.pinned_app_removed":
    "ワークスペース設定 › GitHub 連携設定 › リポジトリを管理 で、このリポジトリを担当する別の App を選んでください",
  "agentGitHub.saveRefused": "保存できませんでした: {reason}",
  "agentGitHub.refused": "拒否",
  "agentPullRequest.title": "Pull request の書式",
  "agentPullRequest.hint":
    "このエージェントが開く Pull request の本文について、ワークスペースの設定を上書きします。GitHub の詳細設定とは別に保存され、リリースは作りません。以降に開く・更新する PR から適用されます。",
  "agentPullRequest.formatting": "書式",
  "agentPullRequest.formatting.inherit": "ワークスペースの設定に従う",
  "agentPullRequest.formatting.on": "テンプレートを使う",
  "agentPullRequest.formatting.off": "テンプレートを使わない",
  "agentPullRequest.formattingHint":
    "使わない場合は、リポジトリのテンプレートも下のテンプレートも使わず、既定の書式で埋めます。",
  "agentPullRequest.templateName": "リポジトリのテンプレートのファイル名",
  "agentPullRequest.templateNameHint":
    "リポジトリの PULL_REQUEST_TEMPLATE フォルダに複数のファイルがあるときに使うファイル名です。大文字小文字は区別せず、パスとしては使われません。",
  "agentPullRequest.template": "このエージェントのテンプレート",
  "agentPullRequest.templateHint":
    "空にするとワークスペースのテンプレートを使います。{bytes} / {max} バイト",
  "agentPullRequest.save": "書式を保存",
  "agentPullRequest.saved": "Pull request の書式を保存しました。",
  "agentPullRequest.conflict":
    "先に他の場所で変更されました。保存済みの値を読み込み直したので、確認してからもう一度保存してください。",
  "agentPullRequest.tooLarge":
    "テンプレートが {max} バイトを超えているため保存できませんでした。",
  "agentPullRequest.invalidText":
    "テンプレートが正しい UTF-8 のテキストではありません。",
  "agentPullRequest.unsupported":
    "テンプレートにサポートされないマークアップがあるか、コメントが閉じられていません。",
};
