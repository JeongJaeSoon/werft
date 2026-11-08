export const githubKo = {
  "github.nav": "GitHub 연결 설정",
  "github.description":
    "에이전트가 저장소를 clone하고, 승인된 결과를 push하고, PR을 열 때 쓰는 GitHub 연결입니다. 에이전트마다 쓸 저장소는 에이전트의 GitHub 탭에서 고릅니다.",
  "github.newTab": "(새 탭에서 열림)",
  "github.copied": "복사했습니다",
  "github.card.counts": "App {apps}개 · 계정 {accounts}곳",
  "github.card.none": "연결 없음",
  "github.card.hint":
    "에이전트가 작업할 조직과 개인 계정에 GitHub App을 설치합니다. 어느 저장소까지 열지는 설치할 때 GitHub에서 정합니다.",
  "github.card.addAccount": "조직 추가",
  "github.card.install": "{name} 설치",
  "github.empty.title": "아직 연결된 GitHub App이 없습니다",
  "github.empty.hint":
    "GitHub에서 App을 만들면 콘솔이 키를 받아 보관합니다. 만든 뒤 조직에 설치하면 여기 표에 나옵니다.",
  "github.empty.create": "GitHub App 만들기",
  "github.role.author": "작성용",
  "github.role.authorHint": "clone·push·PR을 이 App으로 합니다.",
  "github.role.reviewer": "리뷰 승인용",
  "github.role.reviewerHint":
    "PR에 리뷰를 남깁니다. GitHub는 PR을 연 App의 승인을 받지 않으므로 작성용과 다른 App이어야 합니다.",
  "github.apps.title": "GitHub App",
  "github.apps.idLine": "App ID {id}",
  "github.apps.keyLine": "App ID {id} · 키 {at} {by} 저장",
  "github.apps.keyLineAt": "App ID {id} · 키 {at} 저장",
  "github.apps.state.ok": "연결됨",
  "github.apps.state.short": "권한 추가 필요",
  "github.apps.state.pending": "승인 대기 {count}곳",
  "github.apps.state.rejected": "GitHub 인증 실패",
  "github.apps.state.unknown": "확인 못 함",
  "github.apps.menu": "{name} 메뉴",
  "github.apps.newKey": "새 키 등록",
  "github.apps.remove": "연결 해제",
  "github.apps.add": "App 추가",
  "github.apps.wide": "안내보다 넓은 권한",
  "github.apps.wideBody":
    "{list}. 플랫폼은 이 권한으로 토큰을 발급하지 않지만, 키가 새면 GitHub에서는 쓸 수 있습니다.",
  "github.apps.need":
    "{features}을(를) 쓰려면 이 App에 {permissions} 권한이 필요합니다. 더하면 GitHub가 설치한 계정마다 owner에게 승인을 요청합니다. 다시 설치하지 않아도 됩니다.",
  "github.apps.addPermissions": "GitHub에서 권한 추가",
  "github.apps.copyOwnerNote": "App 소유자에게 보낼 안내 복사",
  "github.apps.ownerNote":
    "GitHub App {name}에 권한을 더해 주세요: {permissions}.\n권한 설정: {url}\n저장하면 GitHub가 이 App을 설치한 계정마다 owner에게 승인을 요청합니다. 다시 설치하지 않아도 됩니다.",
  "github.apps.pendingLine":
    "{accounts}의 owner가 {permissions}을(를) 승인하면 그 계정 저장소에서도 이 App의 권한이 모두 동작합니다.",
  "github.apps.pendingSome": "새 권한",
  "github.apps.copyInstallNote": "owner에게 보낼 안내 복사",
  "github.apps.installNote":
    "GitHub App {name}이(가) 권한 승인을 기다립니다: {permissions}.\n계정마다 설치 설정에서 승인해 주세요.\n{lines}",
  "github.apps.rejected":
    "GitHub가 이 App의 키를 받지 않습니다. 키가 지워졌다면 ⋯ 메뉴에서 새 키를 등록하고, App이 삭제됐다면 새 App을 추가해 저장소 고정을 옮기세요. 고정이 없는 저장소의 요청도 실패합니다.",
  "github.apps.removeTitle": "App 연결을 해제할까요?",
  "github.apps.removeUsage":
    "이 App에 고정된 저장소 {pinned}개, 활성 릴리스에서 쓰는 에이전트 적어도 {agents}개, 끝나지 않은 세션 {sessions}개가 있습니다.",
  "github.apps.removeUserLink":
    "구성원이 새로 GitHub 계정을 연결할 수 없게 됩니다(이미 연결한 계정은 그대로입니다).",
  "github.apps.removeHint":
    "고정된 저장소의 요청은 다른 App으로 고정을 옮길 때까지 거절됩니다. 같은 App을 다시 더하면 이 고정이 되살아납니다. GitHub의 App과 설치는 그대로 남습니다.",
  "github.apps.removeHeld":
    "구성원 GitHub 계정 연결이 이 App을 씁니다. 구성원 계정 연결을 다른 작성용 App으로 바꾼 뒤 해제할 수 있습니다.",
  "github.apps.removeUsageFailed":
    "이 App을 쓰는 저장소·에이전트·세션을 읽지 못해 해제할 수 없습니다. 창을 닫고 다시 여세요.",
  "github.apps.removed": "{name} 연결을 해제했습니다.",
  "github.add.title": "App 추가",
  "github.add.hint":
    "GitHub에서 새 App을 만들거나, 이미 있는 App을 App ID와 개인 키로 연결합니다.",
  "github.add.existing": "이미 있는 App 연결",
  "github.add.existingHint":
    "App ID와 개인 키 파일로 연결합니다. GitHub는 키의 공개 부분만 보관해서 예전에 받은 .pem을 다시 내려받을 수 없습니다. 파일이 없으면 App 설정 › Private keys에서 새로 만드세요.",
  "github.add.role": "이 App으로 할 일",
  "github.add.riskTitle": "같은 에이전트의 작성과 승인",
  "github.add.risk":
    "같은 에이전트가 작성용 App으로 연 PR을 이 App으로 승인할 수 있고, 플랫폼은 이를 막지 않습니다. 승인은 PR에 보이지만, 권장 권한(Contents 읽기)인 App의 승인은 GitHub가 필수 리뷰로 세지 않습니다. 그래서 브랜치 규칙이 리뷰를 요구하면 병합에는 GitHub가 인정하는 다른 승인(보통 쓰기 권한이 있는 사람의 승인)이 필요합니다. 그런 규칙이 없는 저장소는 승인 없이도 병합할 수 있으니, 사람 리뷰가 꼭 필요하면 GitHub에서 필수 리뷰를 요구하세요.",
  "github.add.saved": "GitHub App을 연결했습니다.",
  "github.add.sameApp":
    "이미 다른 역할로 연결된 App입니다. 작성용과 리뷰 승인용은 다른 App이어야 합니다.",
  "github.add.noAuthorApp":
    "리뷰 승인용 App을 연결하려면 작성용 App이 먼저 있어야 합니다.",
  "github.newKey.title": "{name}의 새 키 등록",
  "github.newKey.hint":
    "GitHub의 App 설정 › Private keys에서 새 키를 만들어 여기에 저장합니다. 새 키로 동작하는 것을 확인한 뒤 GitHub에서 옛 키를 지우세요.",
  "github.newKey.saved": "새 키를 저장했습니다.",
  "github.appId": "App ID",
  "github.appIdHint": "GitHub App 설정 페이지 위쪽에 있는 숫자입니다.",
  "github.appIdMissing": "App ID를 숫자로 넣어 주세요.",
  "github.key": "Private key (.pem)",
  "github.keyHint":
    "키는 GitHub에서 확인한 뒤 암호화해 저장하고, 저장한 뒤에는 다시 보여 주지 않습니다. 저장했으면 내려받은 파일은 지우세요.",
  "github.keyMissing": ".pem 파일을 골라 주세요.",
  "github.privateKeysLink": "GitHub 문서: 개인 키 관리",
  "github.save": "확인하고 저장",
  "github.connect": "연결",
  "github.invalidKey":
    "이 파일은 RSA private key가 아닙니다. GitHub App 페이지의 Private keys에서 받은 .pem 파일을 고르세요.",
  "github.rejected":
    "GitHub가 이 App ID와 키를 받지 않았습니다. App ID와, 그 App에서 받은 키인지 확인하세요.",
  "github.saveUnreachable":
    "GitHub에 연결하지 못해 저장하지 않았습니다. 잠시 뒤 다시 시도하세요.",
  "github.newApp": "새 App 만들기",
  "github.newAppHint":
    "GitHub에서 Create를 한 번 누르면 콘솔이 App ID·개인 키·client secret을 받아 저장합니다. pem 파일을 다루지 않습니다.",
  "github.newApp.owner": "App을 소유할 곳",
  "github.newApp.org": "조직",
  "github.newApp.orgHint": "조직 소유자만 만들 수 있습니다.",
  "github.newApp.orgLogin": "조직 이름",
  "github.newApp.orgLoginMissing":
    "GitHub 조직 이름(영문·숫자·하이픈, 39자 이하)을 적어 주세요.",
  "github.newApp.user": "내 개인 계정",
  "github.newApp.userHint":
    "계정 주인이 떠나도 App은 그 개인 계정에 남습니다. 시험용에만 권합니다.",
  "github.newApp.scope": "설치할 범위",
  "github.newApp.private": "이 계정에서만 (비공개 App)",
  "github.newApp.privateHint": "App을 소유한 계정에만 설치할 수 있습니다.",
  "github.newApp.public": "여러 조직에서 (공개 App)",
  "github.newApp.publicHint":
    "다른 조직도 설치할 수 있게 됩니다. 콘솔은 에이전트가 고른 저장소에만 토큰을 받습니다.",
  "github.newApp.actions": "Actions·워크플로 권한도 받기",
  "github.newApp.actionsHint":
    "에이전트가 워크플로를 실행하고 워크플로 파일을 고칠 수 있게 actions·workflows 쓰기를 더합니다. 나중에 더해도 다시 설치할 필요는 없습니다.",
  "github.newApp.next":
    "GitHub로 이동해 이름을 확인하고 Create를 누릅니다. 콘솔로 돌아오면 키가 저장됩니다(1시간 안에 마쳐야 합니다). 그다음 설치 화면에서 저장소를 고릅니다.",
  "github.newApp.submit": "GitHub에서 만들기",
  "github.newApp.blocked":
    "CONSOLE_ORIGIN이 설정되지 않아 GitHub가 콘솔로 돌아올 주소가 없습니다. 운영자에게 콘솔 주소 설정을 요청하거나 '이미 있는 App 연결'을 쓰세요.",
  "github.newApp.working": "GitHub에서 만든 App을 저장하는 중입니다.",
  "github.newApp.done": "App을 저장했습니다. 설치 화면으로 이동합니다.",
  "github.newApp.stateInvalid":
    "이 링크는 만료되었거나 이미 쓰였습니다. GitHub 연결에서 다시 시작하세요.",
  "github.newApp.codeRejected":
    "GitHub가 이 요청을 받지 않았습니다(만료되었거나 이미 쓰였습니다). 다시 시작하세요.",
  "github.newApp.changed":
    "그사이 다른 App이 등록되어 이 App은 저장하지 않았습니다. GitHub에 만들어진 App은 필요 없으면 지우세요.",
  "github.newApp.storeFailed":
    "App은 GitHub에 만들어졌지만 키를 저장하지 못했습니다. App 설정에서 새 개인 키를 만들어 '이미 있는 App 연결'로 연결하세요.",
  "github.newApp.openApp": "GitHub에서 App 열기",
  "github.newApp.back": "GitHub 연결 설정으로",
  "github.install.done": "GitHub 설치를 연결했습니다.",
  "github.install.stateInvalid":
    "설치는 GitHub에 있지만, 시작한 지 1시간이 지났거나 이미 쓰인 링크라 연결한 사람을 기록하지 않았습니다.",
  "github.install.notRecorded":
    "설치는 GitHub에 있지만 연결한 사람을 기록하지 못했습니다.",
  "github.table.label": "GitHub App을 설치한 조직과 개인 계정",
  "github.table.name": "이름",
  "github.table.type": "유형",
  "github.table.repositories": "저장소",
  "github.table.app": "App",
  "github.table.connectedBy": "연결한 사람",
  "github.table.status": "상태",
  "github.table.menu": "메뉴",
  "github.table.type.organization": "조직",
  "github.table.type.user": "개인 계정",
  "github.table.reposAll": "전체 {count}개",
  "github.table.reposAllUnknown": "전체",
  "github.table.reposSelected": "{count}개 선택",
  "github.table.reposSelectedUnknown": "골라서",
  "github.table.installedAt": "설치 {at}",
  "github.table.connectedLine": "연결: {by}",
  "github.table.state.active": "연결됨",
  "github.table.state.approval_pending": "승인 대기",
  "github.table.state.suspended": "중지됨",
  "github.table.state.unknown": "확인 못 함",
  "github.table.rowMenu": "{name} 메뉴",
  "github.table.manage": "GitHub에서 관리",
  "github.table.approve": "GitHub에서 승인",
  "github.table.empty": "아직 GitHub App을 설치한 계정이 없습니다.",
  "github.table.readAt": "GitHub에서 읽음",
  "github.repos.title": "에이전트가 쓰는 저장소",
  "github.repos.counts": "에이전트가 고른 저장소 {count}개",
  "github.repos.countsOutside":
    "에이전트가 고른 저장소 {count}개 · 설치 밖 {outside}개",
  "github.repos.manage": "저장소 관리",
  "github.sheet.title": "저장소",
  "github.sheet.close": "닫기",
  "github.sheet.hint":
    "설치마다 GitHub가 허용한 저장소입니다. 브랜치와 저장소를 맡을 App은 행 메뉴에서 바꿉니다.",
  "github.sheet.installation": "{account} · {app} ({count}개)",
  "github.sheet.tableOf": "{account} · {app} 설치의 저장소",
  "github.sheet.col.repository": "저장소",
  "github.sheet.col.agents": "에이전트",
  "github.sheet.col.status": "상태",
  "github.sheet.col.menu": "메뉴",
  "github.sheet.rowMenu": "{name} 메뉴",
  "github.sheet.branch": "기본 브랜치 바꾸기",
  "github.sheet.branchTitle": "{name}의 기본 브랜치",
  "github.sheet.pins": "맡을 App 바꾸기",
  "github.sheet.pinsTitle": "{name}을(를) 맡을 App",
  "github.sheet.pinsHint":
    "이 저장소의 토큰은 고른 App이 발급합니다. 이 저장소에 닿지 않는 App을 고르면 그 App을 저장소에 설치할 때까지 요청이 거절됩니다.",
  "github.sheet.pinsSaved": "{name}을(를) 맡을 App을 바꿨습니다.",
  "github.sheet.unpinned": "고정 안 함",
  "github.sheet.notReaching": "{name} (이 저장소에 설치 안 됨)",
  "github.sheet.outside": "설치 밖 저장소",
  "github.sheet.outsideHint":
    "에이전트가 골랐지만 지금 어느 설치도 닿지 않는 저장소입니다. 설치가 사라져도 여기 남습니다.",
  "github.sheet.outsideBadge": "설치 밖",
  "github.repo.pickTitle": "App이 설치된 저장소",
  "github.repo.pickHint":
    "GitHub가 App 설치에 허용한 저장소입니다. 목록에 없으면 GitHub에서 App 설치에 저장소를 더하세요.",
  "github.repo.pickEmpty": "이 설치에 허용된 저장소가 없습니다.",
  "github.repo.pickNoApp": "작성용 App을 먼저 연결하세요.",
  "github.repo.pickNameHeld":
    "같은 이름을 쓰던 다른 저장소의 항목이 남아 있습니다. GitHub에서 이름이 바뀐 그 저장소를 먼저 한 번 고르면 항목이 새 이름으로 바뀝니다.",
  "github.repo.pickNoInstallation":
    "App이 아직 어디에도 설치되지 않았습니다. GitHub에서 App을 설치하세요.",
  "github.repo.installationReviewer": "{account} (리뷰 승인용 App)",
  "github.repo.installationChoose": "설치를 고르세요",
  "github.repo.installation": "설치",
  "github.repo.pageOf": "{total}개 중 {from}–{to}",
  "github.repo.previousPage": "이전",
  "github.repo.nextPage": "다음",
  "github.repo.private": "비공개",
  "github.repo.branch": "기본 브랜치",
  "github.repo.branchHint":
    "세션이 이 브랜치에서 시작합니다. 바꾸면 이 저장소에서 실행 중인 세션은 다음 저장소 요청부터 거절됩니다.",
  "github.repo.branchInvalid": "브랜치 이름이 올바르지 않습니다.",
  "github.repo.save": "저장",
  "github.repo.saved": "{name}의 기본 브랜치를 {branch}(으)로 바꿨습니다.",
  "github.repo.conflict":
    "다른 곳에서 이 저장소를 먼저 바꿨습니다. 새로 읽은 값을 확인하고 다시 저장하세요.",
  "github.feature.base": "PR 작성·수정",
  "github.feature.baseHint":
    "clone, push, PR 열기·코멘트. GitHub를 쓰는 에이전트는 늘 씁니다.",
  "github.feature.actions": "Actions 실행",
  "github.feature.actionsHint":
    "에이전트 허용 목록의 워크플로를 실행하거나 다시 실행합니다.",
  "github.feature.workflows": "워크플로 파일 수정",
  "github.feature.workflowsHint":
    ".github/workflows 아래 파일을 바꾼 commit도 push합니다.",
  "github.feature.review": "PR 리뷰 승인",
  "github.feature.reviewHint":
    "PR에 코멘트·변경 요청·승인 리뷰를 남깁니다. 리뷰 승인용 App이 있어야 켤 수 있습니다.",
  "github.feature.merge": "자기 PR 머지",
  "github.feature.mergeHint":
    "사용자가 머지하라고 지시하면 에이전트가 자기 세션이 연 PR을 squash로 머지합니다. 필수 check와 리뷰는 GitHub가 판단하고 브랜치 보호는 우회하지 않습니다. 기본값은 꺼짐입니다.",
  "github.ceiling.title": "에이전트가 쓸 수 있는 기능",
  "github.ceiling.hint":
    "워크스페이스 전체의 상한입니다. 에이전트마다 켜는 것은 에이전트의 GitHub 탭에서 합니다. 스위치를 바꾸면 바로 저장되고, 앞 릴리스로 도는 세션도 다음 GitHub 요청부터 따릅니다.",
  "github.ceiling.always": "항상 켜짐",
  "github.ceiling.agentsUsing": "활성 릴리스에서 켠 에이전트 {count}개",
  "github.ceiling.viaApp": "{name}(으)로 · {using}",
  "github.ceiling.appShort": "App 권한 필요",
  "github.ceiling.pending": "일부 계정 승인 대기",
  "github.ceiling.saving": "{feature} 저장하는 중",
  "github.ceiling.saved": "{feature} 저장했습니다",
  "github.ceiling.failed": "저장하지 못해 스위치를 저장된 값으로 되돌렸습니다.",
  "github.ceiling.conflict":
    "다른 곳에서 먼저 바꿨습니다. 스위치를 지금 저장된 값으로 되돌렸습니다.",
  "github.ceiling.lowerTitle": "기능을 끌까요?",
  "github.ceiling.lowerBody":
    "{feature}을(를) 끕니다(활성 릴리스에서 켠 에이전트 {count}개). 앞 릴리스로 도는 세션도 다음 GitHub 요청부터 거절됩니다.",
  "github.ceiling.lowerBodyNoCount":
    "{feature}을(를) 끕니다. 앞 릴리스로 도는 세션도 다음 GitHub 요청부터 머지가 거절됩니다.",
  "github.ceiling.lowerConfirm": "끄기",
  "github.permissions.level.read": "읽기",
  "github.permissions.level.write": "쓰기",
  "github.permissions.level.admin": "관리",
  "github.permissions.name.contents": "Contents",
  "github.permissions.name.pull_requests": "Pull requests",
  "github.permissions.name.metadata": "Metadata",
  "github.permissions.name.actions": "Actions",
  "github.permissions.name.checks": "Checks",
  "github.permissions.name.issues": "Issues",
  "github.permissions.name.workflows": "Workflows",
  "github.permissions.name.administration": "Administration",
  "github.pullRequest.title": "Pull request",
  "github.pullRequest.hint":
    "에이전트가 여는 Pull request의 본문과 커밋에 남기는 세션 링크를 정합니다. 이후에 여는·갱신하는 PR과 다음 커밋부터 적용되고, GitHub에 이미 있는 글은 바꾸지 않습니다.",
  "github.pullRequest.formatting": "저장소·워크스페이스 템플릿 사용",
  "github.pullRequest.formattingHint":
    "끄면 저장소 템플릿과 아래 템플릿을 모두 쓰지 않고, 본문은 기본 서식으로 채웁니다.",
  "github.pullRequest.mode": "템플릿을 고르는 방식",
  "github.pullRequest.mode.repository_first":
    "저장소 템플릿 먼저, 없으면 아래 템플릿",
  "github.pullRequest.mode.override": "저장소 템플릿 대신 아래 템플릿 사용",
  "github.pullRequest.template": "기본 템플릿",
  "github.pullRequest.templateHint":
    "비워 두면 기본 서식을 씁니다. {bytes} / {max} 바이트",
  "github.pullRequest.sessionLink": "세션 링크",
  "github.pullRequest.sessionLink.url": "세션 주소 (URL)",
  "github.pullRequest.sessionLink.id": "세션 ID만",
  "github.pullRequest.sessionLinkHint":
    "PR 본문 끝과 커밋의 Agent-Session 줄에 쓰입니다.",
  "github.pullRequest.saved": "Pull request 설정을 저장했습니다.",
  "github.pullRequest.failed": "Pull request 설정을 저장하지 못했습니다.",
  "github.pullRequest.conflict":
    "다른 곳에서 먼저 바꿨습니다. 지금 저장된 값을 다시 불러왔으니 확인한 뒤 저장해 주세요.",
  "github.pullRequest.tooLarge":
    "템플릿이 {max} 바이트를 넘어 저장하지 못했습니다.",
  "github.pullRequest.invalidText": "템플릿이 올바른 UTF-8 텍스트가 아닙니다.",
  "github.pullRequest.unsupported":
    "템플릿에 지원하지 않는 마크업이 있거나 주석이 닫히지 않았습니다.",
};

export const githubEn: Record<keyof typeof githubKo, string> = {
  "github.nav": "GitHub connection",
  "github.description":
    "The GitHub connection agents use to clone repositories, push approved results and open pull requests. Each agent picks its repositories in its own GitHub tab.",
  "github.newTab": "(opens in a new tab)",
  "github.copied": "Copied",
  "github.card.counts": "{apps} Apps · {accounts} accounts",
  "github.card.none": "Not connected",
  "github.card.hint":
    "Install a GitHub App on the organizations and personal accounts agents work in. Which repositories it reaches is chosen on GitHub when installing.",
  "github.card.addAccount": "Add organization",
  "github.card.install": "Install {name}",
  "github.empty.title": "No GitHub App connected yet",
  "github.empty.hint":
    "Create an App on GitHub and the console receives and keeps its key. Install it on an organization and it shows in the table here.",
  "github.empty.create": "Create a GitHub App",
  "github.role.author": "Author",
  "github.role.authorHint": "Clones, pushes and opens pull requests.",
  "github.role.reviewer": "Reviewer",
  "github.role.reviewerHint":
    "Reviews pull requests. GitHub refuses an approval from the App that opened the pull request, so it must be another App.",
  "github.apps.title": "GitHub Apps",
  "github.apps.idLine": "App ID {id}",
  "github.apps.keyLine": "App ID {id} · key saved {at} by {by}",
  "github.apps.keyLineAt": "App ID {id} · key saved {at}",
  "github.apps.state.ok": "Connected",
  "github.apps.state.short": "Needs permissions",
  "github.apps.state.pending": "Pending at {count}",
  "github.apps.state.rejected": "GitHub auth failed",
  "github.apps.state.unknown": "Not checked",
  "github.apps.menu": "{name} menu",
  "github.apps.newKey": "Register a new key",
  "github.apps.remove": "Disconnect",
  "github.apps.add": "Add App",
  "github.apps.wide": "Wider than guided",
  "github.apps.wideBody":
    "{list}. The platform issues no token with these, but a leaked key could use them on GitHub.",
  "github.apps.need":
    "{features} needs {permissions} on this App. Once added, GitHub asks the owner of each account it is installed on to approve. No reinstall is needed.",
  "github.apps.addPermissions": "Add permissions on GitHub",
  "github.apps.copyOwnerNote": "Copy a note for the App owner",
  "github.apps.ownerNote":
    "Please add permissions to the GitHub App {name}: {permissions}.\nPermissions: {url}\nOnce saved, GitHub asks the owner of each account it is installed on to approve. No reinstall is needed.",
  "github.apps.pendingLine":
    "Once the owners of {accounts} approve {permissions}, all of this App's permissions work in those accounts' repositories too.",
  "github.apps.pendingSome": "the new permissions",
  "github.apps.copyInstallNote": "Copy a note for the owners",
  "github.apps.installNote":
    "The GitHub App {name} is waiting for approval of: {permissions}.\nPlease approve it in each account's installation settings.\n{lines}",
  "github.apps.rejected":
    "GitHub does not accept this App's key. If the key was deleted, register a new one from the ⋯ menu; if the App was deleted, add a new App and move the repository pins to it. Requests for repositories without a pin fail too.",
  "github.apps.removeTitle": "Disconnect this App?",
  "github.apps.removeUsage":
    "{pinned} repositories are pinned to it, at least {agents} agents use it in their active release and {sessions} sessions on it have not ended.",
  "github.apps.removeUserLink":
    "Members can no longer link new GitHub accounts (accounts already linked stay).",
  "github.apps.removeHint":
    "Requests for pinned repositories are refused until their pins move to another App. Adding the same App again brings these pins back. The App and its installations stay on GitHub.",
  "github.apps.removeHeld":
    "Member GitHub account linking uses this App. Switch it to another author App, then disconnect this one.",
  "github.apps.removeUsageFailed":
    "Could not read the repositories, agents and sessions that use this App, so it cannot be disconnected. Close this and open it again.",
  "github.apps.removed": "Disconnected {name}.",
  "github.add.title": "Add App",
  "github.add.hint":
    "Create a new App on GitHub, or connect one that exists with its App ID and private key.",
  "github.add.existing": "Connect an existing App",
  "github.add.existingHint":
    "Connect with the App ID and a private key file. GitHub keeps only the public part of a key, so a .pem downloaded before cannot be downloaded again. Without the file, generate a new one under the App's settings › Private keys.",
  "github.add.role": "What this App does",
  "github.add.riskTitle": "One agent opening and approving",
  "github.add.risk":
    "An agent can approve, with this App, a pull request it opened with the author App; the platform does not stop it. The approval shows on the pull request, but GitHub does not count an approval from an App with the recommended permission (Contents read) toward required reviews. So where a branch rule requires a review, merging still needs another approval GitHub counts, usually from a person with write access. A repository with no such rule can merge without any approval; if a person's review must be required, require reviews on GitHub.",
  "github.add.saved": "Connected the GitHub App.",
  "github.add.sameApp":
    "This App is already connected in another role. The author and reviewer Apps must differ.",
  "github.add.noAuthorApp": "Connect an author App before a reviewer App.",
  "github.newKey.title": "New key for {name}",
  "github.newKey.hint":
    "Generate a new key under the App's settings › Private keys on GitHub and save it here. Once the new key works, delete the old one on GitHub.",
  "github.newKey.saved": "Saved the new key.",
  "github.appId": "App ID",
  "github.appIdHint":
    "The number at the top of the GitHub App's settings page.",
  "github.appIdMissing": "Enter the App ID as a number.",
  "github.key": "Private key (.pem)",
  "github.keyHint":
    "The key is checked with GitHub, then stored encrypted and never shown again. Delete the downloaded file once it is saved.",
  "github.keyMissing": "Choose the .pem file.",
  "github.privateKeysLink": "GitHub docs: managing private keys",
  "github.save": "Check and save",
  "github.connect": "Connect",
  "github.invalidKey":
    "This file is not an RSA private key. Choose the .pem file from the GitHub App's Private keys.",
  "github.rejected":
    "GitHub did not accept this App ID and key. Check the App ID and that the key belongs to that App.",
  "github.saveUnreachable":
    "GitHub could not be reached, so nothing was saved. Try again shortly.",
  "github.newApp": "Create a new App",
  "github.newAppHint":
    "Click Create once on GitHub and the console receives and stores the App ID, private key and client secret. No .pem file to handle.",
  "github.newApp.owner": "Who owns the App",
  "github.newApp.org": "An organization",
  "github.newApp.orgHint": "Only organization owners can create it.",
  "github.newApp.orgLogin": "Organization name",
  "github.newApp.orgLoginMissing":
    "Enter the GitHub organization name (letters, digits and hyphens, up to 39).",
  "github.newApp.user": "My personal account",
  "github.newApp.userHint":
    "The App stays tied to the account if its owner leaves. Use it for trials only.",
  "github.newApp.scope": "Where it can be installed",
  "github.newApp.private": "This account only (private App)",
  "github.newApp.privateHint":
    "It can be installed only on the account that owns it.",
  "github.newApp.public": "Several organizations (public App)",
  "github.newApp.publicHint":
    "Other organizations can install it too. The console gets tokens only for the repositories agents pick.",
  "github.newApp.actions": "Also ask for Actions and workflow permissions",
  "github.newApp.actionsHint":
    "Adds actions and workflows write so agents can run workflows and change workflow files. Adding them later needs no reinstall.",
  "github.newApp.next":
    "On GitHub, check the name and click Create. Back in the console the key is stored (finish within an hour). Then pick repositories on the install screen.",
  "github.newApp.submit": "Create on GitHub",
  "github.newApp.blocked":
    "CONSOLE_ORIGIN is not set, so GitHub has no console address to come back to. Ask the operator to set it, or use 'Connect an existing App'.",
  "github.newApp.working": "Storing the App created on GitHub.",
  "github.newApp.done": "Saved the App. Going to the install screen.",
  "github.newApp.stateInvalid":
    "This link has expired or was already used. Start again from GitHub connection.",
  "github.newApp.codeRejected":
    "GitHub did not accept this request (it expired or was already used). Start again.",
  "github.newApp.changed":
    "Another App was registered in the meantime, so this one was not stored. Delete the App GitHub created if you do not need it.",
  "github.newApp.storeFailed":
    "The App was created on GitHub but its key could not be stored. Generate a new private key in the App's settings and connect it with 'Connect an existing App'.",
  "github.newApp.openApp": "Open the App on GitHub",
  "github.newApp.back": "Back to GitHub settings",
  "github.install.done": "Connected the GitHub installation.",
  "github.install.stateInvalid":
    "The installation is on GitHub, but the link was over an hour old or already used, so who connected it was not recorded.",
  "github.install.notRecorded":
    "The installation is on GitHub, but who connected it could not be recorded.",
  "github.table.label":
    "Organizations and personal accounts the GitHub Apps are installed on",
  "github.table.name": "Name",
  "github.table.type": "Type",
  "github.table.repositories": "Repositories",
  "github.table.app": "App",
  "github.table.connectedBy": "Connected by",
  "github.table.status": "Status",
  "github.table.menu": "Menu",
  "github.table.type.organization": "Organization",
  "github.table.type.user": "Personal",
  "github.table.reposAll": "All {count}",
  "github.table.reposAllUnknown": "All",
  "github.table.reposSelected": "{count} selected",
  "github.table.reposSelectedUnknown": "Selected",
  "github.table.installedAt": "Installed {at}",
  "github.table.connectedLine": "Connected: {by}",
  "github.table.state.active": "Connected",
  "github.table.state.approval_pending": "Pending",
  "github.table.state.suspended": "Suspended",
  "github.table.state.unknown": "Not checked",
  "github.table.rowMenu": "{name} menu",
  "github.table.manage": "Manage on GitHub",
  "github.table.approve": "Approve on GitHub",
  "github.table.empty": "No account has installed a GitHub App yet.",
  "github.table.readAt": "Read from GitHub",
  "github.repos.title": "Repositories agents use",
  "github.repos.counts": "{count} repositories picked by agents",
  "github.repos.countsOutside":
    "{count} repositories picked by agents · {outside} outside installations",
  "github.repos.manage": "Manage repositories",
  "github.sheet.title": "Repositories",
  "github.sheet.close": "Close",
  "github.sheet.hint":
    "What GitHub lets each installation reach. Change a branch or the App that handles a repository from its row menu.",
  "github.sheet.installation": "{account} · {app} ({count})",
  "github.sheet.tableOf": "Repositories of the {account} · {app} installation",
  "github.sheet.col.repository": "Repository",
  "github.sheet.col.agents": "Agents",
  "github.sheet.col.status": "Status",
  "github.sheet.col.menu": "Menu",
  "github.sheet.rowMenu": "{name} menu",
  "github.sheet.branch": "Change default branch",
  "github.sheet.branchTitle": "Default branch of {name}",
  "github.sheet.pins": "Change handling App",
  "github.sheet.pinsTitle": "App that handles {name}",
  "github.sheet.pinsHint":
    "The chosen App issues this repository's tokens. Choosing one that does not reach the repository refuses requests until it is installed there.",
  "github.sheet.pinsSaved": "Changed the App that handles {name}.",
  "github.sheet.unpinned": "Not pinned",
  "github.sheet.notReaching": "{name} (not installed on this repository)",
  "github.sheet.outside": "Outside installations",
  "github.sheet.outsideHint":
    "Repositories agents picked that no installation reaches now. They stay here when an installation goes away.",
  "github.sheet.outsideBadge": "Outside",
  "github.repo.pickTitle": "Repositories the App is installed on",
  "github.repo.pickHint":
    "The repositories GitHub lets the App's installation reach. If one is missing, add it to the App's installation on GitHub.",
  "github.repo.pickEmpty": "This installation reaches no repository.",
  "github.repo.pickNoApp": "Connect an author App first.",
  "github.repo.pickNameHeld":
    "Another repository's entry still holds this name. Pick that repository, renamed on GitHub, once first and its entry takes the new name.",
  "github.repo.pickNoInstallation":
    "The App is not installed anywhere yet. Install it on GitHub.",
  "github.repo.installationReviewer": "{account} (reviewer App)",
  "github.repo.installationChoose": "Choose an installation",
  "github.repo.installation": "Installation",
  "github.repo.pageOf": "{from}–{to} of {total}",
  "github.repo.previousPage": "Previous",
  "github.repo.nextPage": "Next",
  "github.repo.private": "Private",
  "github.repo.branch": "Default branch",
  "github.repo.branchHint":
    "Sessions start from this branch. A change refuses the next repository request of sessions running on it.",
  "github.repo.branchInvalid": "That is not a valid branch name.",
  "github.repo.save": "Save",
  "github.repo.saved": "{name} now starts from {branch}.",
  "github.repo.conflict":
    "Someone changed this repository first. Check the values just read and save again.",
  "github.feature.base": "Write pull requests",
  "github.feature.baseHint":
    "Clone, push, open and comment on pull requests. Every agent with GitHub does this.",
  "github.feature.actions": "Run Actions",
  "github.feature.actionsHint":
    "Run or rerun the workflows on the agent's allow-list.",
  "github.feature.workflows": "Change workflow files",
  "github.feature.workflowsHint":
    "Also push commits that change files under .github/workflows.",
  "github.feature.review": "Approve pull requests",
  "github.feature.reviewHint":
    "Leave comments, change requests and approvals on pull requests. Needs a reviewer App.",
  "github.feature.merge": "Merge its own pull requests",
  "github.feature.mergeHint":
    "When a person tells it to, an agent squash-merges a pull request its own session opened. GitHub still decides on required checks and reviews, and branch protection is never bypassed. Off by default.",
  "github.ceiling.title": "Features agents may use",
  "github.ceiling.hint":
    "The workspace's ceiling. Each agent turns features on in its own GitHub tab. A switch saves at once, and sessions still on an earlier release follow it from their next GitHub request.",
  "github.ceiling.always": "Always on",
  "github.ceiling.agentsUsing":
    "{count} agents turn it on in their active release",
  "github.ceiling.viaApp": "With {name} · {using}",
  "github.ceiling.appShort": "App needs permission",
  "github.ceiling.pending": "Some accounts pending",
  "github.ceiling.saving": "Saving {feature}",
  "github.ceiling.saved": "Saved {feature}",
  "github.ceiling.failed":
    "Could not save, so the switch is back to the saved value.",
  "github.ceiling.conflict":
    "Someone changed this first. The switches show what is saved now.",
  "github.ceiling.lowerTitle": "Turn this feature off?",
  "github.ceiling.lowerBody":
    "Turns off {feature} ({count} agents turn it on in their active release). Sessions still on an earlier release are refused from their next GitHub request too.",
  "github.ceiling.lowerBodyNoCount":
    "Turns off {feature}. Sessions still on an earlier release are refused a merge from their next GitHub request.",
  "github.ceiling.lowerConfirm": "Turn off",
  "github.permissions.level.read": "read",
  "github.permissions.level.write": "write",
  "github.permissions.level.admin": "admin",
  "github.permissions.name.contents": "Contents",
  "github.permissions.name.pull_requests": "Pull requests",
  "github.permissions.name.metadata": "Metadata",
  "github.permissions.name.actions": "Actions",
  "github.permissions.name.checks": "Checks",
  "github.permissions.name.issues": "Issues",
  "github.permissions.name.workflows": "Workflows",
  "github.permissions.name.administration": "Administration",
  "github.pullRequest.title": "Pull requests",
  "github.pullRequest.hint":
    "Sets how pull request bodies and the session link in commits are written. It applies to pull requests opened or updated afterwards and to later commits; text already on GitHub is not rewritten.",
  "github.pullRequest.formatting": "Use repository and workspace templates",
  "github.pullRequest.formattingHint":
    "When off, neither the repository template nor the template below is used and the body is filled in the default layout.",
  "github.pullRequest.mode": "How the template is chosen",
  "github.pullRequest.mode.repository_first":
    "Repository template first, else the template below",
  "github.pullRequest.mode.override":
    "Use the template below instead of the repository's",
  "github.pullRequest.template": "Default template",
  "github.pullRequest.templateHint":
    "Leave empty for the default layout. {bytes} / {max} bytes",
  "github.pullRequest.sessionLink": "Session link",
  "github.pullRequest.sessionLink.url": "Session address (URL)",
  "github.pullRequest.sessionLink.id": "Session ID only",
  "github.pullRequest.sessionLinkHint":
    "Used at the end of the pull request body and in the commit's Agent-Session line.",
  "github.pullRequest.saved": "Saved the pull request settings.",
  "github.pullRequest.failed": "Could not save the pull request settings.",
  "github.pullRequest.conflict":
    "Someone changed it first. The saved values were reloaded; check them and save again.",
  "github.pullRequest.tooLarge":
    "The template is over {max} bytes and was not saved.",
  "github.pullRequest.invalidText": "The template is not valid UTF-8 text.",
  "github.pullRequest.unsupported":
    "The template has unsupported markup or an unclosed comment.",
};

export const githubJa: Record<keyof typeof githubKo, string> = {
  "github.nav": "GitHub 連携設定",
  "github.description":
    "エージェントがリポジトリを clone し、承認された結果を push し、PR を開くときに使う GitHub 連携です。エージェントごとに使うリポジトリは、エージェントの GitHub タブで選びます。",
  "github.newTab": "(新しいタブで開きます)",
  "github.copied": "コピーしました",
  "github.card.counts": "App {apps} 件 · アカウント {accounts} 件",
  "github.card.none": "未接続",
  "github.card.hint":
    "エージェントが作業する組織と個人アカウントに GitHub App をインストールします。どのリポジトリまで開くかは、インストール時に GitHub で決めます。",
  "github.card.addAccount": "組織を追加",
  "github.card.install": "{name} をインストール",
  "github.empty.title": "接続された GitHub App はまだありません",
  "github.empty.hint":
    "GitHub で App を作成すると、コンソールが鍵を受け取って保管します。作成後に組織へインストールすると、ここの表に表示されます。",
  "github.empty.create": "GitHub App を作成",
  "github.role.author": "作成用",
  "github.role.authorHint": "clone・push・PR をこの App で行います。",
  "github.role.reviewer": "レビュー承認用",
  "github.role.reviewerHint":
    "PR にレビューを残します。GitHub は PR を開いた App の承認を受け付けないため、作成用とは別の App にしてください。",
  "github.apps.title": "GitHub App",
  "github.apps.idLine": "App ID {id}",
  "github.apps.keyLine": "App ID {id} · 鍵 {at} {by} が保存",
  "github.apps.keyLineAt": "App ID {id} · 鍵 {at} 保存",
  "github.apps.state.ok": "接続済み",
  "github.apps.state.short": "権限の追加が必要",
  "github.apps.state.pending": "承認待ち {count} 件",
  "github.apps.state.rejected": "GitHub 認証失敗",
  "github.apps.state.unknown": "確認できず",
  "github.apps.menu": "{name} のメニュー",
  "github.apps.newKey": "新しい鍵を登録",
  "github.apps.remove": "接続を解除",
  "github.apps.add": "App を追加",
  "github.apps.wide": "案内より広い権限",
  "github.apps.wideBody":
    "{list}。プラットフォームはこの権限でトークンを発行しませんが、鍵が漏れると GitHub では使えます。",
  "github.apps.need":
    "{features} を使うには、この App に {permissions} の権限が必要です。追加すると、GitHub がインストール先のアカウントごとに owner へ承認を依頼します。再インストールは不要です。",
  "github.apps.addPermissions": "GitHub で権限を追加",
  "github.apps.copyOwnerNote": "App の所有者に送る案内をコピー",
  "github.apps.ownerNote":
    "GitHub App {name} に権限を追加してください: {permissions}。\n権限の設定: {url}\n保存すると、GitHub がこの App のインストール先アカウントごとに owner へ承認を依頼します。再インストールは不要です。",
  "github.apps.pendingLine":
    "{accounts} の owner が {permissions} を承認すると、そのアカウントのリポジトリでもこの App の権限がすべて使えます。",
  "github.apps.pendingSome": "新しい権限",
  "github.apps.copyInstallNote": "owner に送る案内をコピー",
  "github.apps.installNote":
    "GitHub App {name} が権限の承認を待っています: {permissions}。\nアカウントごとにインストール設定で承認してください。\n{lines}",
  "github.apps.rejected":
    "GitHub がこの App の鍵を受け付けません。鍵が削除された場合は ⋯ メニューから新しい鍵を登録し、App が削除された場合は新しい App を追加してリポジトリの固定を移してください。固定のないリポジトリのリクエストも失敗します。",
  "github.apps.removeTitle": "App の接続を解除しますか?",
  "github.apps.removeUsage":
    "この App に固定されたリポジトリ {pinned} 件、有効なリリースで使うエージェント 少なくとも {agents} 件、終わっていないセッション {sessions} 件があります。",
  "github.apps.removeUserLink":
    "メンバーは新しく GitHub アカウントを連携できなくなります (連携済みのアカウントはそのままです)。",
  "github.apps.removeHint":
    "固定されたリポジトリのリクエストは、固定を別の App に移すまで拒否されます。同じ App をもう一度追加すると、この固定が戻ります。GitHub の App とインストールはそのまま残ります。",
  "github.apps.removeHeld":
    "メンバーの GitHub アカウント連携がこの App を使っています。アカウント連携を別の作成用 App に切り替えてから解除できます。",
  "github.apps.removeUsageFailed":
    "この App を使うリポジトリ・エージェント・セッションを読めなかったため、解除できません。閉じてからもう一度開いてください。",
  "github.apps.removed": "{name} の接続を解除しました。",
  "github.add.title": "App を追加",
  "github.add.hint":
    "GitHub で新しい App を作成するか、既存の App を App ID と秘密鍵で接続します。",
  "github.add.existing": "既存の App を接続",
  "github.add.existingHint":
    "App ID と秘密鍵ファイルで接続します。GitHub は鍵の公開部分しか保管しないため、以前取得した .pem を再ダウンロードすることはできません。ファイルがなければ App 設定 › Private keys で新しく作成してください。",
  "github.add.role": "この App の役割",
  "github.add.riskTitle": "同じエージェントによる作成と承認",
  "github.add.risk":
    "同じエージェントが作成用 App で開いた PR を、この App で承認できます。プラットフォームはこれを止めません。承認は PR に表示されますが、推奨する権限(Contents 読み取り)の App による承認を GitHub は必須レビューに数えません。そのため、ブランチのルールがレビューを求める場合、マージには GitHub が数える別の承認(通常は書き込み権限を持つ人の承認)が必要です。そのようなルールがないリポジトリは承認なしでもマージできるため、人のレビューが必ず必要なら GitHub で必須レビューを求めてください。",
  "github.add.saved": "GitHub App を接続しました。",
  "github.add.sameApp":
    "すでに別の役割で接続されている App です。作成用とレビュー承認用は別の App にしてください。",
  "github.add.noAuthorApp":
    "レビュー承認用 App を接続するには、先に作成用 App が必要です。",
  "github.newKey.title": "{name} の新しい鍵を登録",
  "github.newKey.hint":
    "GitHub の App 設定 › Private keys で新しい鍵を作成し、ここに保存します。新しい鍵で動くことを確かめてから、GitHub で古い鍵を削除してください。",
  "github.newKey.saved": "新しい鍵を保存しました。",
  "github.appId": "App ID",
  "github.appIdHint": "GitHub App の設定ページ上部にある数字です。",
  "github.appIdMissing": "App ID を数字で入力してください。",
  "github.key": "Private key (.pem)",
  "github.keyHint":
    "鍵は GitHub で確認してから暗号化して保存し、保存後は二度と表示しません。保存したら、ダウンロードしたファイルは削除してください。",
  "github.keyMissing": ".pem ファイルを選んでください。",
  "github.privateKeysLink": "GitHub ドキュメント: 秘密鍵の管理",
  "github.save": "確認して保存",
  "github.connect": "接続",
  "github.invalidKey":
    "このファイルは RSA private key ではありません。GitHub App の Private keys から取得した .pem ファイルを選んでください。",
  "github.rejected":
    "GitHub がこの App ID と鍵を受け付けませんでした。App ID と、その App の鍵かどうかを確認してください。",
  "github.saveUnreachable":
    "GitHub に接続できなかったため、保存しませんでした。しばらくしてから再試行してください。",
  "github.newApp": "新しい App を作成",
  "github.newAppHint":
    "GitHub で Create を一度押すと、コンソールが App ID・秘密鍵・client secret を受け取って保存します。pem ファイルを扱う必要はありません。",
  "github.newApp.owner": "App を所有する場所",
  "github.newApp.org": "組織",
  "github.newApp.orgHint": "組織のオーナーだけが作成できます。",
  "github.newApp.orgLogin": "組織名",
  "github.newApp.orgLoginMissing":
    "GitHub の組織名 (英数字とハイフン、39 文字以内) を入力してください。",
  "github.newApp.user": "自分の個人アカウント",
  "github.newApp.userHint":
    "アカウントの持ち主が離れても App はそのアカウントに残ります。試用にだけおすすめします。",
  "github.newApp.scope": "インストールできる範囲",
  "github.newApp.private": "このアカウントだけ (非公開 App)",
  "github.newApp.privateHint":
    "App を所有するアカウントにだけインストールできます。",
  "github.newApp.public": "複数の組織 (公開 App)",
  "github.newApp.publicHint":
    "ほかの組織もインストールできるようになります。コンソールはエージェントが選んだリポジトリにだけトークンを取得します。",
  "github.newApp.actions": "Actions・ワークフローの権限も取得する",
  "github.newApp.actionsHint":
    "エージェントがワークフローを実行し、ワークフローファイルを変更できるよう actions・workflows の書き込みを追加します。あとで追加しても再インストールは不要です。",
  "github.newApp.next":
    "GitHub で名前を確認して Create を押します。コンソールに戻ると鍵が保存されます (1 時間以内に完了してください)。続いてインストール画面でリポジトリを選びます。",
  "github.newApp.submit": "GitHub で作成",
  "github.newApp.blocked":
    "CONSOLE_ORIGIN が設定されていないため、GitHub がコンソールに戻る先がありません。運用者にコンソールのアドレス設定を依頼するか、「既存の App を接続」を使ってください。",
  "github.newApp.working": "GitHub で作成した App を保存しています。",
  "github.newApp.done": "App を保存しました。インストール画面に移動します。",
  "github.newApp.stateInvalid":
    "このリンクは期限切れか、すでに使われています。GitHub 連携からやり直してください。",
  "github.newApp.codeRejected":
    "GitHub がこのリクエストを受け付けませんでした (期限切れか使用済み)。やり直してください。",
  "github.newApp.changed":
    "その間に別の App が登録されたため、この App は保存しませんでした。GitHub に作成された App が不要なら削除してください。",
  "github.newApp.storeFailed":
    "App は GitHub に作成されましたが、鍵を保存できませんでした。App 設定で新しい秘密鍵を作成し、「既存の App を接続」で接続してください。",
  "github.newApp.openApp": "GitHub で App を開く",
  "github.newApp.back": "GitHub 連携設定に戻る",
  "github.install.done": "GitHub のインストールを接続しました。",
  "github.install.stateInvalid":
    "インストールは GitHub にありますが、開始から 1 時間が過ぎたか使用済みのリンクのため、接続した人を記録しませんでした。",
  "github.install.notRecorded":
    "インストールは GitHub にありますが、接続した人を記録できませんでした。",
  "github.table.label": "GitHub App をインストールした組織と個人アカウント",
  "github.table.name": "名前",
  "github.table.type": "種類",
  "github.table.repositories": "リポジトリ",
  "github.table.app": "App",
  "github.table.connectedBy": "接続した人",
  "github.table.status": "状態",
  "github.table.menu": "メニュー",
  "github.table.type.organization": "組織",
  "github.table.type.user": "個人",
  "github.table.reposAll": "すべて {count} 件",
  "github.table.reposAllUnknown": "すべて",
  "github.table.reposSelected": "{count} 件を選択",
  "github.table.reposSelectedUnknown": "選択",
  "github.table.installedAt": "インストール {at}",
  "github.table.connectedLine": "接続: {by}",
  "github.table.state.active": "接続済み",
  "github.table.state.approval_pending": "承認待ち",
  "github.table.state.suspended": "停止中",
  "github.table.state.unknown": "確認できず",
  "github.table.rowMenu": "{name} のメニュー",
  "github.table.manage": "GitHub で管理",
  "github.table.approve": "GitHub で承認",
  "github.table.empty":
    "GitHub App をインストールしたアカウントはまだありません。",
  "github.table.readAt": "GitHub から読み取り",
  "github.repos.title": "エージェントが使うリポジトリ",
  "github.repos.counts": "エージェントが選んだリポジトリ {count} 件",
  "github.repos.countsOutside":
    "エージェントが選んだリポジトリ {count} 件 · インストール外 {outside} 件",
  "github.repos.manage": "リポジトリを管理",
  "github.sheet.title": "リポジトリ",
  "github.sheet.close": "閉じる",
  "github.sheet.hint":
    "インストールごとに GitHub が許可したリポジトリです。ブランチと担当する App は行のメニューで変更します。",
  "github.sheet.installation": "{account} · {app} ({count} 件)",
  "github.sheet.tableOf": "{account} · {app} のインストールのリポジトリ",
  "github.sheet.col.repository": "リポジトリ",
  "github.sheet.col.agents": "エージェント",
  "github.sheet.col.status": "状態",
  "github.sheet.col.menu": "メニュー",
  "github.sheet.rowMenu": "{name} のメニュー",
  "github.sheet.branch": "デフォルトブランチを変更",
  "github.sheet.branchTitle": "{name} のデフォルトブランチ",
  "github.sheet.pins": "担当する App を変更",
  "github.sheet.pinsTitle": "{name} を担当する App",
  "github.sheet.pinsHint":
    "このリポジトリのトークンは選んだ App が発行します。このリポジトリに届かない App を選ぶと、その App をリポジトリにインストールするまでリクエストは拒否されます。",
  "github.sheet.pinsSaved": "{name} を担当する App を変更しました。",
  "github.sheet.unpinned": "固定しない",
  "github.sheet.notReaching": "{name} (このリポジトリに未インストール)",
  "github.sheet.outside": "インストール外のリポジトリ",
  "github.sheet.outsideHint":
    "エージェントが選んだものの、いまどのインストールも届かないリポジトリです。インストールがなくなってもここに残ります。",
  "github.sheet.outsideBadge": "インストール外",
  "github.repo.pickTitle": "App がインストールされたリポジトリ",
  "github.repo.pickHint":
    "GitHub が App のインストールに許可したリポジトリです。一覧にない場合は GitHub で App のインストールにリポジトリを加えてください。",
  "github.repo.pickEmpty":
    "このインストールで許可されたリポジトリはありません。",
  "github.repo.pickNoApp": "先に作成用 App を接続してください。",
  "github.repo.pickNameHeld":
    "同じ名前を使っていた別のリポジトリの項目が残っています。GitHub で名前が変わったそのリポジトリを先に一度選ぶと、項目が新しい名前になります。",
  "github.repo.pickNoInstallation":
    "App はまだどこにもインストールされていません。GitHub で App をインストールしてください。",
  "github.repo.installationReviewer": "{account}(レビュー承認用 App)",
  "github.repo.installationChoose": "インストール先を選んでください",
  "github.repo.installation": "インストール先",
  "github.repo.pageOf": "{total} 件中 {from}–{to}",
  "github.repo.previousPage": "前へ",
  "github.repo.nextPage": "次へ",
  "github.repo.private": "非公開",
  "github.repo.branch": "デフォルトブランチ",
  "github.repo.branchHint":
    "セッションはこのブランチから始まります。変えると、このリポジトリで実行中のセッションは次のリポジトリ要求から拒否されます。",
  "github.repo.branchInvalid": "ブランチ名が正しくありません。",
  "github.repo.save": "保存",
  "github.repo.saved": "{name} のデフォルトブランチを {branch} に変えました。",
  "github.repo.conflict":
    "ほかの場所で先にこのリポジトリが変更されました。読み直した値を確かめて、もう一度保存してください。",
  "github.feature.base": "PR の作成・修正",
  "github.feature.baseHint":
    "clone、push、PR の作成・コメント。GitHub を使うエージェントは常に使います。",
  "github.feature.actions": "Actions の実行",
  "github.feature.actionsHint":
    "エージェントの許可リストにあるワークフローを実行・再実行します。",
  "github.feature.workflows": "ワークフローファイルの変更",
  "github.feature.workflowsHint":
    ".github/workflows 以下のファイルを変えた commit も push します。",
  "github.feature.review": "PR のレビュー承認",
  "github.feature.reviewHint":
    "PR にコメント・変更依頼・承認のレビューを残します。レビュー承認用 App があると有効にできます。",
  "github.feature.merge": "自分の PR のマージ",
  "github.feature.mergeHint":
    "人が指示したとき、エージェントは自分のセッションが開いた PR を squash でマージします。必須チェックとレビューは GitHub が判断し、ブランチ保護は回避しません。既定はオフです。",
  "github.ceiling.title": "エージェントが使える機能",
  "github.ceiling.hint":
    "ワークスペース全体の上限です。エージェントごとに有効にするのは、エージェントの GitHub タブで行います。スイッチを変えるとすぐに保存され、以前のリリースで動くセッションも次の GitHub リクエストから従います。",
  "github.ceiling.always": "常に有効",
  "github.ceiling.agentsUsing":
    "有効なリリースで有効にしたエージェント {count} 件",
  "github.ceiling.viaApp": "{name} で · {using}",
  "github.ceiling.appShort": "App の権限が必要",
  "github.ceiling.pending": "一部のアカウントが承認待ち",
  "github.ceiling.saving": "{feature} を保存しています",
  "github.ceiling.saved": "{feature} を保存しました",
  "github.ceiling.failed":
    "保存できなかったため、スイッチを保存済みの値に戻しました。",
  "github.ceiling.conflict":
    "ほかの場所で先に変更されました。スイッチをいま保存されている値に戻しました。",
  "github.ceiling.lowerTitle": "機能を無効にしますか?",
  "github.ceiling.lowerBody":
    "{feature} を無効にします (有効なリリースで有効にしたエージェント {count} 件)。以前のリリースで動いているセッションも、次の GitHub リクエストから拒否されます。",
  "github.ceiling.lowerBodyNoCount":
    "{feature} をオフにします。以前のリリースで動いているセッションも、次の GitHub リクエストからマージが拒否されます。",
  "github.ceiling.lowerConfirm": "無効にする",
  "github.permissions.level.read": "読み取り",
  "github.permissions.level.write": "書き込み",
  "github.permissions.level.admin": "管理",
  "github.permissions.name.contents": "Contents",
  "github.permissions.name.pull_requests": "Pull requests",
  "github.permissions.name.metadata": "Metadata",
  "github.permissions.name.actions": "Actions",
  "github.permissions.name.checks": "Checks",
  "github.permissions.name.issues": "Issues",
  "github.permissions.name.workflows": "Workflows",
  "github.permissions.name.administration": "Administration",
  "github.pullRequest.title": "Pull request",
  "github.pullRequest.hint":
    "エージェントが開く Pull request の本文と、コミットに残すセッションリンクを設定します。以降に開く・更新する PR と次のコミットから適用され、GitHub 上の既存の文章は書き換えません。",
  "github.pullRequest.formatting":
    "リポジトリ・ワークスペースのテンプレートを使う",
  "github.pullRequest.formattingHint":
    "オフにすると、リポジトリのテンプレートも下のテンプレートも使わず、本文は既定の書式で埋めます。",
  "github.pullRequest.mode": "テンプレートの選び方",
  "github.pullRequest.mode.repository_first":
    "リポジトリのテンプレートを優先し、なければ下のテンプレート",
  "github.pullRequest.mode.override":
    "リポジトリのテンプレートの代わりに下のテンプレートを使う",
  "github.pullRequest.template": "既定のテンプレート",
  "github.pullRequest.templateHint":
    "空にすると既定の書式を使います。{bytes} / {max} バイト",
  "github.pullRequest.sessionLink": "セッションリンク",
  "github.pullRequest.sessionLink.url": "セッションのアドレス (URL)",
  "github.pullRequest.sessionLink.id": "セッション ID のみ",
  "github.pullRequest.sessionLinkHint":
    "PR 本文の末尾とコミットの Agent-Session 行に使われます。",
  "github.pullRequest.saved": "Pull request の設定を保存しました。",
  "github.pullRequest.failed": "Pull request の設定を保存できませんでした。",
  "github.pullRequest.conflict":
    "先に他の場所で変更されました。保存済みの値を読み込み直したので、確認してからもう一度保存してください。",
  "github.pullRequest.tooLarge":
    "テンプレートが {max} バイトを超えているため保存できませんでした。",
  "github.pullRequest.invalidText":
    "テンプレートが正しい UTF-8 のテキストではありません。",
  "github.pullRequest.unsupported":
    "テンプレートにサポートされないマークアップがあるか、コメントが閉じられていません。",
};
