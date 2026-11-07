/** The run profiles screens (/profiles); every catalog spreads these in. */
export const profilesKo = {
  "nav.profiles": "프로필",
  "profiles.title": "프로필",
  "profiles.description":
    "에이전트가 쓸 모델과 도구를 정합니다. 설치 프로필은 이 설치의 모든 워크스페이스가 쓸 수 있는 가장 넓은 범위를 정하고, 워크스페이스 프로필은 설치 프로필 하나를 줄여 만듭니다.",
  "profiles.create": "프로필 만들기",
  "profiles.createCeiling": "설치 프로필 만들기",
  "profiles.kind.installation": "설치 프로필",
  "profiles.kind.workspace": "워크스페이스 프로필",
  "profiles.option": "{name} v{version} · {model} ({kind})",
  "profiles.optionKind.installation": "설치",
  "profiles.optionKind.workspace": "워크스페이스",
  "profiles.optionUnnamed": "{kind} 프로필 · {model}",
  "profiles.workspace.description":
    "수정하면 새 버전으로 저장됩니다. 이전 버전을 쓰던 에이전트는 그대로 동작합니다.",
  "profiles.locked": "바꾸려면 워크스페이스 소유자나 관리자에게 요청하세요",
  "profiles.count": "{count}개",
  "profiles.column.name": "이름",
  "profiles.column.version": "버전",
  "profiles.column.kind": "종류",
  "profiles.column.base": "바탕 프로필",
  "profiles.column.model": "기본 모델",
  "profiles.column.state": "상태",
  "profiles.narrowKind": "{kind} · v{version}",
  "profiles.repository.required": "저장소 필요",
  "profiles.repository.optional": "저장소 선택",
  "profiles.repository.none": "저장소 쓰지 않음",
  "profiles.billing.metered": "비용 집계",
  "profiles.billing.none": "비용 집계 안 함",
  "profiles.noTools": "도구 없음",
  "profiles.on": "켬",
  "profiles.off": "끔",
  "profiles.empty": "이 설치에 프로필이 없습니다.",
  "profiles.versionTag": "v{version}",
  "profiles.olderVersions": "이전 버전 {count}개",
  "profiles.origin.catalog": "설정 문서에서 가져옴",
  "profiles.origin.console": "콘솔에서 만듦",
  "profiles.state.usable": "사용 가능",
  "profiles.state.base_changed": "바탕 프로필 바뀜",
  "profiles.state.base_missing": "바탕 프로필 없음",
  "profiles.state.retired": "사용 중지됨",
  "profiles.state.base_retired": "바탕 프로필 사용 중지됨",
  "profiles.state.blocked": "차단됨",
  "profiles.state.base_blocked": "바탕 프로필 차단됨",
  "profiles.state.connection_missing": "연결 없음",
  "profiles.state.unattended_off": "이 설치에서 꺼짐",
  "profiles.state.definition_drift": "설정이 바뀜",
  "profiles.state.runtime_unsupported": "지원하지 않는 런타임",
  "profiles.stateReason.usable":
    "새 릴리스와 세션이 이 프로필을 고를 수 있습니다.",
  "profiles.stateReason.base_changed":
    "바탕 프로필 {base}가 이 버전을 만든 뒤 바뀌었습니다. 새 릴리스를 만들 수 없고, 이 버전을 쓰는 릴리스도 새 세션을 시작하지 못합니다. 다시 만들어 새 버전으로 옮기세요.",
  "profiles.stateReason.base_missing":
    "바탕 프로필 {base}가 없습니다. 새 릴리스를 만들 수 없고, 이 버전을 쓰는 릴리스도 새 세션을 시작하지 못합니다.",
  "profiles.stateReason.retired":
    "사용 중지했습니다. 이미 쓰는 릴리스와 세션은 계속 동작하고, 새 릴리스와 세션은 고를 수 없습니다.",
  "profiles.stateReason.base_retired":
    "바탕 프로필 {base}가 사용 중지됐습니다. 이미 쓰는 릴리스와 세션은 계속 동작하고, 새로 고를 수는 없습니다.",
  "profiles.stateReason.connection_missing":
    "이 프로필의 연결이 이 설치에 없어 아무것도 돌리지 않습니다. 연결을 다시 두거나 다른 연결로 새 버전을 만드세요.",
  "profiles.stateReason.unattended_off":
    "bypassPermissions 프로필인데 이 설치의 PLATFORM_ALLOW_UNATTENDED_PERMISSIONS가 꺼져 있어 아무것도 돌리지 않습니다.",
  "profiles.stateReason.definition_drift":
    "저장한 정의가 이 버전의 서버에서 같은 값으로 읽히지 않아 아무것도 돌리지 않습니다. 새 버전을 만드세요.",
  "profiles.stateReason.runtime_unsupported":
    "이 설치의 worker가 이 런타임이나 권한 모드를 받지 않아 아무것도 돌리지 않습니다.",
  "profiles.stateReason.blocked":
    "운영자가 차단했습니다. 새 릴리스와 세션을 만들 수 없고, 이미 쓰는 세션도 다음 턴에서 멈춥니다. 해제하면 다시 고를 수 있지만, 멈춘 턴은 다시 돌지 않습니다. 그 세션은 새 메시지를 보내야 다시 돕니다.",
  "profiles.stateReason.base_blocked":
    "바탕 프로필 {base}가 차단됐습니다. 이 버전을 쓰는 릴리스와 세션도 멈추고, 새로 고를 수 없습니다.",
  "profiles.newVersion": "새 버전",
  "profiles.remake": "다시 만들기",
  "profiles.retire": "사용 중지",
  "profiles.baseChanged.title": "{name}의 바탕 프로필이 바뀌었습니다",
  "profiles.baseChanged.text":
    "{base}가 바뀌었습니다. {id}로는 새 릴리스를 만들 수 없고, 이 버전을 쓰는 릴리스도 새 세션을 시작하지 못합니다. 다시 만들어 새 버전으로 옮기세요.",
  "profiles.baseMissing.title": "{name}의 바탕 프로필이 없어졌습니다",
  "profiles.baseMissing.text":
    "{base}가 없어졌습니다. {id}로는 새 릴리스를 만들 수 없고, 이 버전을 쓰는 릴리스도 새 세션을 시작하지 못합니다. 다른 설치 프로필로 새로 만드세요.",
  "profiles.editor.versionTitle": "{name} 새 버전",
  "profiles.editor.remakeTitle": "{name} 다시 만들기",
  "profiles.editor.description":
    "바탕이 되는 설치 프로필에서 모델·도구를 줄이거나 권한 모드를 더 엄격하게만 바꿀 수 있습니다.",
  "profiles.editor.base": "바탕 프로필",
  "profiles.editor.baseHeading": "설치 프로필 {id}",
  "profiles.editor.engineModel": "엔진 · 모델",
  "profiles.editor.engineModelValue": "Claude Agent SDK {version} · {model}",
  "profiles.editor.permissionMode": "권한 모드",
  "profiles.editor.narrowTitle": "이 워크스페이스에서 쓸 값",
  "profiles.editor.autoRulesNote":
    "auto 규칙(환경·허용·soft deny·hard deny, 모든 셸 명령 분류)은 여기서 고치지 않습니다. 따로 정하는 화면은 다음 단계에 생깁니다.",
  "profiles.editor.name": "이름",
  "profiles.editor.nameHint":
    "영문 소문자나 숫자로 시작하고, 영문 소문자·숫자·-로 40자까지 씁니다.",
  "profiles.editor.preview": "저장할 버전의 id: {id}",
  "profiles.editor.models": "모델",
  "profiles.editor.modelsHint":
    "세션이 고를 수 있는 모델입니다. 바탕 프로필에 있는 모델만 고릅니다.",
  "profiles.editor.defaultModel": "기본 모델",
  "profiles.editor.modeHint":
    "바탕 프로필과 같거나 사람이 더 많이 확인하는 모드만 고를 수 있습니다.",
  "profiles.editor.autoClosed":
    "auto는 바탕 프로필이 auto나 bypassPermissions일 때만 고를 수 있습니다.",
  "profiles.editor.bypassClosed":
    "bypassPermissions는 바탕 프로필이 bypassPermissions일 때만 고를 수 있습니다. 설치 설정 PLATFORM_ALLOW_UNATTENDED_PERMISSIONS가 켜져 있고 owner가 그런 설치 프로필을 만들어야 합니다.",
  "profiles.editor.bypassRisk":
    "bypassPermissions는 모든 도구 호출을 아무 판정 없이 실행합니다. 파일 쓰기·셸 명령·git commit도 사람이나 분류기가 확인하지 않고, 막는 것은 컨테이너·외부 접속 허용 목록·도구 목록·비용 한도뿐입니다. 위험한 호출을 분류기가 막게 하려면 auto를 고르세요.",
  "profiles.editor.scriptCeiling": "스크립트 상한",
  "profiles.editor.scriptNone": "실행 안 함",
  "profiles.editor.scriptLater": "2a 단계부터",
  "profiles.editor.scriptHint":
    "에이전트가 확장 스크립트를 부를 수 있는 한도입니다. 낮추기만 할 수 있습니다.",
  "profiles.editor.saveNote":
    "새 버전으로 저장합니다. 이전 버전을 쓰는 릴리스는 새 버전으로 옮겨야 바뀝니다.",
  "profiles.editor.save": "새 버전으로 저장",
  "profiles.editor.saving": "저장하는 중…",
  "profiles.editor.nameInvalid":
    "이름은 영문 소문자나 숫자로 시작하고, 영문 소문자·숫자·-로 40자까지 씁니다.",
  "profiles.editor.modelsEmpty": "모델을 하나 이상 고르세요.",
  "profiles.editor.tooLarge":
    "한 프로필에는 모델 32개, 도구 64개까지 담습니다. 줄인 뒤 다시 저장하세요.",
  "profiles.editor.tooLong":
    "프로필에는 200자 이하의 이름만 담습니다. 이름이 긴 모델이나 도구를 빼고 저장하세요.",
  "profiles.error.unknownBase":
    "그 바탕 프로필이 없습니다. 목록을 다시 불러오세요.",
  "profiles.error.baseUnusable":
    "그 바탕 프로필은 지금 쓸 수 없습니다. 사용할 수 있는 바탕 프로필을 고르세요.",
  "profiles.error.widens":
    "바탕 프로필이 허용하지 않는 값입니다. 목록을 다시 불러와 바탕 프로필을 확인하세요.",
  "profiles.error.versionTaken":
    "같은 이름의 새 버전이 방금 저장됐습니다. 다시 저장하면 그다음 버전이 됩니다.",
  "profiles.review.title": "검토",
  "profiles.review.text": "{id}와 달라진 칸입니다.",
  "profiles.review.none": "{id}와 달라진 칸이 없습니다.",
  "profiles.review.change": "{before} → {after}",
  "profiles.new.ceilingTitle": "설치 프로필 만들기",
  "profiles.new.ceilingVersionTitle": "{name} 새 버전",
  "profiles.new.ceilingDescription":
    "설치 프로필은 이 설치의 모든 워크스페이스가 쓸 수 있는 가장 넓은 범위를 정합니다. 워크스페이스 프로필은 이 범위를 줄이기만 합니다. 연결과 자격 증명은 모델 연결에서, 비용 한도는 서버 설정에서 정합니다.",
  "profiles.new.kind": "종류",
  "profiles.new.kindHint.workspace":
    "설치 프로필 하나를 바탕으로 모델·도구·권한 모드를 줄입니다.",
  "profiles.new.kindHint.installation":
    "연결 하나 위에서 런타임·모델·도구·권한 모드·저장소를 정합니다. owner만 만듭니다.",
  "profiles.new.fromMissing": "{id} 프로필이 없습니다. 빈 양식에서 시작합니다.",
  "profiles.new.cannotMake": "지금은 만들 수 없습니다",
  "profiles.new.noConnections":
    "이 설치에 연결이 없습니다. 모델 연결에서 연결을 더한 뒤 다시 여세요.",
  "profiles.new.noRuntimes": "이 설치의 worker가 받는 런타임이 없습니다.",
  "profiles.new.noBase": "바탕으로 쓸 수 있는 설치 프로필이 없습니다.",
  "profiles.ceiling.connection": "연결",
  "profiles.ceiling.connectionOption": "{id} ({kind} · {billing})",
  "profiles.ceiling.connectionHint":
    "모델 공급자와 자격 증명은 연결이 정합니다. 연결은 모델 연결에서 바꿉니다.",
  "profiles.ceiling.runtime": "런타임",
  "profiles.ceiling.runtimeVersion": "런타임 버전",
  "profiles.ceiling.runtimeVersionInvalid":
    "런타임 버전을 200자 이하로 적으세요.",
  "profiles.ceiling.modelsHint":
    "한 줄에 모델 하나씩 적습니다. 세션은 이 가운데에서 모델을 고릅니다.",
  "profiles.ceiling.titleModel": "제목 모델",
  "profiles.ceiling.titleModelHint": "비우면 기본 모델이 세션 제목을 짓습니다.",
  "profiles.ceiling.bypassClosed":
    "이 설치는 PLATFORM_ALLOW_UNATTENDED_PERMISSIONS가 꺼져 있어 bypassPermissions를 고를 수 없습니다.",
  "profiles.ceiling.claudeMd": "저장소의 CLAUDE.md 읽기",
  "profiles.ceiling.claudeMdHint":
    "켜면 세션이 저장소의 CLAUDE.md를 지시로 읽습니다.",
  "profiles.ceiling.repositoryMode": "저장소",
  "profiles.ceiling.repositories": "허용할 저장소",
  "profiles.ceiling.repositoriesHint":
    "이 프로필의 세션과 릴리스가 쓸 수 있는 저장소입니다.",
  "profiles.ceiling.appRepositories": "App이 설치된 저장소 모두 허용",
  "profiles.ceiling.appRepositoriesHint":
    "켜면 콘솔에 등록한 GitHub App이 설치된 저장소를 에이전트가 GitHub 탭에서 골라 쓸 수 있습니다. 끄면 아래에서 고른 저장소만 씁니다.",
  "profiles.ceiling.noRepositories": "이 설치에 저장소가 없습니다.",
  "profiles.ceiling.repositoriesEmpty":
    "저장소를 하나 이상 고르세요. 저장소 없이 돌리려면 '저장소 쓰지 않음'을 고릅니다.",
  "profiles.ceiling.preview": "{name} v{version}으로 저장합니다.",
  "profiles.ceiling.saveNote":
    "저장한 버전은 바뀌지 않습니다. 고치려면 새 버전을 만듭니다.",
  "profiles.ceiling.save": "저장",
  "profiles.ceiling.ownerOnly":
    "설치 프로필은 워크스페이스 owner만 만들고 사용 중지할 수 있습니다.",
  "profiles.ceiling.error.unknownConnection":
    "그 연결이 이 설치에 없습니다. 다시 불러와 연결을 고르세요.",
  "profiles.ceiling.error.runtimeNotInstalled":
    "이 설치의 worker가 그 런타임이나 권한 모드를 받지 않습니다.",
  "profiles.ceiling.error.unattendedNotAllowed":
    "이 설치는 PLATFORM_ALLOW_UNATTENDED_PERMISSIONS가 꺼져 있어 bypassPermissions 프로필을 저장하지 않습니다.",
  "profiles.ceiling.error.unknownRepository":
    "고른 저장소 가운데 이 설치에 없는 것이 있습니다. 다시 불러와 고르세요.",
  "profiles.ceiling.error.modelNotInModels":
    "기본 모델은 모델 목록에 있어야 합니다.",
  "profiles.ceiling.error.unknownPrevious":
    "앞 버전으로 고른 프로필이 없습니다. 목록을 다시 불러오세요.",
  "profiles.ceiling.error.invalid": "이 값은 프로필로 저장할 수 없습니다.",
  "profiles.ceiling.error.idTaken":
    "이 이름으로 만들 ID가 이미 있습니다. 다른 이름을 고르세요.",
  "profiles.ceiling.error.stalePrevious":
    "이 이름의 최신 버전은 {id}입니다. 새 버전은 최신 버전에서 만듭니다.",
  "profiles.ceiling.error.noVersion":
    "이 이름에는 아직 버전이 없습니다. 목록을 다시 불러오세요.",
  "profiles.ceiling.error.openLatest": "최신 버전에서 다시 만들기",
  "profiles.retireTitle": "{id} 버전을 사용 중지할까요?",
  "profiles.retireText":
    "이미 이 버전을 쓰는 릴리스와 세션은 계속 동작합니다. 새 릴리스와 세션은 이 버전을 고를 수 없습니다. 사용 중지는 되돌릴 수 없습니다.",
  "profiles.retireCeilingText":
    "이미 이 프로필을 쓰는 릴리스와 세션, 그 위의 워크스페이스 프로필은 계속 동작합니다. 새 릴리스·세션·워크스페이스 프로필은 이 프로필을 고를 수 없습니다. 사용 중지는 되돌릴 수 없습니다.",
  "profiles.retiring": "사용 중지하는 중…",
  "profiles.retired": "{id} 버전을 사용 중지했습니다.",
  "profiles.retireRow": "이 버전 사용 중지",
  "profiles.retireRowHint":
    "새 릴리스와 세션이 이 버전을 고를 수 없게 됩니다. 되돌릴 수 없습니다.",
  "profiles.blockRow": "이 설치 프로필 차단",
  "profiles.blockRowHint":
    "이 프로필을 쓰는 세션도 다음 턴에서 멈춥니다. 해제할 수 있지만 멈춘 턴은 다시 돌지 않습니다.",
  "profiles.block": "차단",
  "profiles.unblock": "차단 해제",
  "profiles.blockTitle": "설치 프로필 {id}을(를) 차단할까요?",
  "profiles.unblockTitle": "설치 프로필 {id}의 차단을 해제할까요?",
  "profiles.blockText":
    "이 프로필과 그 위의 워크스페이스 프로필로는 새 릴리스와 세션을 만들 수 없습니다. 이미 쓰는 세션도 다음 턴에서 멈추고, 지금 도는 턴은 모델·저장소 요청이 1초 남짓 안에 끊깁니다. 해제할 수 있지만 멈춘 턴은 다시 돌지 않습니다.",
  "profiles.unblockText":
    "이 프로필을 다시 고를 수 있습니다. 차단 중에 멈춘 세션과 턴은 저절로 다시 돌지 않으니, 필요한 세션에는 새 메시지를 보내세요.",
  "profiles.blocking": "차단하는 중…",
  "profiles.unblocking": "차단을 해제하는 중…",
  "profiles.blockDone": "설치 프로필 {id}을(를) 차단했습니다.",
  "profiles.unblockDone": "설치 프로필 {id}의 차단을 해제했습니다.",
  "profiles.blockOwnerOnly":
    "설치 프로필은 워크스페이스 owner만 차단하고 해제할 수 있습니다.",
  "profiles.open": "{name} 자세히 보기",
  "profiles.detail.notFound.title": "프로필을 찾을 수 없습니다",
  "profiles.detail.notFound.text":
    "{id} 프로필이 없습니다. 주소가 잘못됐을 수 있습니다.",
  "profiles.detail.back": "프로필 목록으로",
  "profiles.detail.workspaceDescription":
    "설치 프로필을 바탕으로 이 워크스페이스에서 만든 프로필입니다. 수정하면 새 버전으로 저장되고, 이 버전은 그대로 남습니다.",
  "profiles.detail.ceilingDescription":
    "이 설치의 모든 워크스페이스가 쓸 수 있는 가장 넓은 범위를 정합니다. 저장한 버전은 바뀌지 않고, 고치면 새 버전이 됩니다.",
  "profiles.detail.ownerOnly":
    "설치 프로필은 워크스페이스 owner만 바꿀 수 있습니다",
  "profiles.detail.createFrom": "이 프로필로 워크스페이스 프로필 만들기",
  "profiles.detail.settings": "설정",
  "profiles.detail.id": "id",
  "profiles.detail.models": "고를 수 있는 모델",
  "profiles.detail.titleModelDefault": "기본 모델",
  "profiles.detail.noRepositories": "허용한 저장소 없음",
  "profiles.detail.billing": "비용",
  "profiles.detail.created": "만든 때",
  "profiles.detail.retiredAt": "사용 중지한 때",
  "profiles.detail.audit.title": "기록",
  "profiles.detail.audit.origin": "출처",
  "profiles.detail.audit.createdBy": "만든 사람",
  "profiles.detail.audit.retiredBy": "사용 중지한 사람",
  "profiles.detail.audit.previous": "앞 버전",
  "profiles.detail.audit.noPrevious": "없음",
  "profiles.detail.audit.imported": "설정 문서",
  "profiles.detail.audit.unknown": "알 수 없음",
  "profiles.detail.audit.you": "{id} (나)",
  "profiles.detail.history.title": "버전 기록",
  "profiles.detail.history.ceilingDescription":
    "앞 버전으로 이어진 설치 프로필입니다. 이전 버전을 쓰던 릴리스는 그대로 동작합니다.",
  "profiles.detail.history.version": "버전",
  "profiles.detail.history.named": "{name} v{version}",
  "profiles.detail.history.current": "지금 보는 버전",
  "profiles.detail.narrowings.title": "이 프로필로 만든 워크스페이스 프로필",
  "profiles.detail.narrowings.description":
    "이 프로필을 바탕으로 줄여 만든 프로필입니다.",
  "profiles.detail.narrowings.empty":
    "이 프로필을 바탕으로 만든 워크스페이스 프로필이 없습니다.",
  "profiles.detail.agents.title": "이 프로필을 쓰는 에이전트",
  "profiles.detail.agents.description":
    "지금 활성 릴리스가 이 프로필(버전)을 쓰는 에이전트입니다. 이전 릴리스는 세지 않습니다.",
  "profiles.detail.agents.withheld":
    "에이전트 목록은 에이전트를 관리할 수 있는 사람만 봅니다",
  "profiles.detail.agents.empty": "지금 이 프로필을 쓰는 에이전트가 없습니다.",
  "profiles.detail.agents.agent": "에이전트",
  "profiles.detail.agents.release": "활성 릴리스",
  "profiles.detail.agents.open": "{name}의 릴리스 보기",
  "profiles.rollout.title": "새 버전 적용 현황",
  "profiles.rollout.description":
    "이 프로필을 따라가는 에이전트에 새 버전이 적용된 정도입니다.",
  "profiles.rollout.progress": "{total}개 중 {applied}개 적용",
  "profiles.rollout.pending": "{count}개는 적용을 기다리는 중입니다.",
  "profiles.rollout.failedTitle": "적용하지 못한 에이전트 {count}개",
  "profiles.rollout.failedAgents": "적용하지 못한 에이전트",
  "profiles.rollout.agent": "에이전트",
  "profiles.rollout.reason": "이유",
  "profiles.rollout.retry": "다시 시도",
  "profiles.rollout.retryFor": "{name} 다시 시도",
  "profiles.rollout.retried": "다시 적용하도록 올렸습니다: {name}",
  "profiles.rollout.notRetried":
    "다시 시도할 항목이 없습니다. 이미 처리되었을 수 있습니다.",
  "profiles.rollout.fixedModel":
    "고른 모델을 쓰는 에이전트 {count}개는 기본 모델이 바뀌어도 그대로 유지됩니다.",
  "profiles.tools.legend": "차단할 내장 도구",
  "profiles.tools.hint":
    "체크한 도구는 이 프로필의 세션에서 돌지 않습니다. 내장 도구만 다룹니다. MCP 도구는 에이전트의 MCP 설정이 정합니다.",
  "profiles.tools.unlimited":
    "아무것도 체크하지 않으면 제한 없음입니다. 다만 플랫폼이 지원하는 내장 도구 카탈로그({catalog}) 안에서입니다.",
  "profiles.tools.unlimitedBase":
    "아무것도 더 체크하지 않으면 바탕 프로필 {base}가 막지 않은 도구를 모두 씁니다. 그 범위는 플랫폼이 지원하는 내장 도구 카탈로그 안입니다.",
  "profiles.tools.providerNote":
    "provider 쪽 도구는 모델 공급자 쪽에서 돌아 외부 접속 proxy가 막지 못합니다. 첫 버전은 이 도구를 차단한 채 시작합니다.",
  "profiles.tools.boundary.local": "worker 안",
  "profiles.tools.boundary.egress": "외부 접속",
  "profiles.tools.boundary.provider": "provider 쪽",
  "profiles.tools.new": "새 도구",
  "profiles.tools.fixed": "바탕 프로필이 막은 도구입니다.",
  "profiles.tools.diff.legend": "카탈로그 차이",
  "profiles.tools.diff.text":
    "{id}에 없던 도구는 차단한 채 시작합니다. 열려면 받아들이기를 체크하고 위 목록에서 체크를 풉니다.",
  "profiles.tools.diff.accept": "{tool} 실행을 받아들이기",
  "profiles.tools.diff.stillBlocked": "지금은 차단돼 있습니다.",
  "profiles.tools.diff.opens": "이 버전에서 돕니다.",
  "profiles.tools.diff.removed": "지원이 끝난 도구:",
  "profiles.tools.unaccepted":
    "이전 버전에 없던 도구 {tools}를 열려면 받아들이기를 체크하거나 다시 차단하세요.",
  "profiles.tools.asked":
    "이전 버전이 다루지 않은 도구를 열려고 합니다. 아래 카탈로그 차이에서 받아들이거나 다시 차단하세요.",
  "profiles.tools.noCatalog":
    "런타임 버전 {version}에는 지원 카탈로그가 없어 차단목록을 저장할 수 없습니다. 지원하는 버전: {versions}",
  "profiles.tools.noCatalogs":
    "이 설치에는 지원 카탈로그가 없어 차단목록을 저장할 수 없습니다.",
  "profiles.tools.baseNoCatalog":
    "바탕 프로필의 런타임 버전에는 지원 카탈로그가 없어 이 프로필을 차단목록으로 저장할 수 없습니다.",
  "profiles.tools.error.mcpTool":
    "MCP 도구는 프로필에서 막을 수 없습니다. 내장 도구만 고르세요.",
  "profiles.tools.error.toolPattern":
    "패턴은 받지 않습니다. 내장 도구 이름 하나를 고르세요.",
  "profiles.tools.error.unknownTool":
    "이 런타임 버전의 지원 카탈로그에 없는 도구가 있습니다. 목록을 다시 불러오세요.",
  "profiles.tools.error.noToolCatalog":
    "이 런타임 버전에는 지원 카탈로그가 없어 차단목록을 저장할 수 없습니다.",
  "profiles.tools.error.baseDenies":
    "바탕 프로필이 막은 도구는 풀 수 없습니다. 목록을 다시 불러오세요.",
  "profiles.tools.blocked": "차단한 도구",
  "profiles.tools.running": "실행하는 도구",
  "profiles.tools.noneBlocked": "차단 없음",
  "profiles.tools.allowList":
    "이 버전의 런타임 버전에는 지원 카탈로그가 없습니다. 도구 목록(허용목록)으로만 정한 버전이라 콘솔에서는 읽기만 합니다.",
  "profiles.tools.blockedNew": "이 버전에서 막힌 새 도구 {count}개",
  "profiles.tools.blockedNewText":
    "이 버전이 차단 여부를 정한 적 없는 도구라 돌지 않습니다: {tools}. 열려면 지원 카탈로그 {catalog}로 새 버전을 만들어 받아들입니다.",
  "profiles.tools.makeVersion": "새 버전 만들기",
  "profiles.column.blocked": "차단",
  "profiles.blockedCount": "{count}개",
};

export const profilesEn: Record<keyof typeof profilesKo, string> = {
  "nav.profiles": "Profiles",
  "profiles.title": "Profiles",
  "profiles.description":
    "The models and tools an agent uses. An installation profile sets the widest range every workspace on this installation can use; a workspace profile narrows one installation profile.",
  "profiles.create": "Create profile",
  "profiles.createCeiling": "Create installation profile",
  "profiles.kind.installation": "Installation profile",
  "profiles.kind.workspace": "Workspace profile",
  "profiles.option": "{name} v{version} · {model} ({kind})",
  "profiles.optionKind.installation": "installation",
  "profiles.optionKind.workspace": "workspace",
  "profiles.optionUnnamed": "{kind} profile · {model}",
  "profiles.workspace.description":
    "Editing saves a new version. Agents on an earlier version keep working as they are.",
  "profiles.locked": "To change these, ask a workspace owner or admin",
  "profiles.count": "{count}",
  "profiles.column.name": "Name",
  "profiles.column.version": "Version",
  "profiles.column.kind": "Kind",
  "profiles.column.base": "Based on",
  "profiles.column.model": "Default model",
  "profiles.column.state": "Status",
  "profiles.narrowKind": "{kind} · v{version}",
  "profiles.repository.required": "Repository required",
  "profiles.repository.optional": "Repository optional",
  "profiles.repository.none": "No repository",
  "profiles.billing.metered": "Cost tracked",
  "profiles.billing.none": "No cost tracked",
  "profiles.noTools": "No tools",
  "profiles.on": "On",
  "profiles.off": "Off",
  "profiles.empty": "This installation has no profiles.",
  "profiles.versionTag": "v{version}",
  "profiles.olderVersions": "Earlier versions ({count})",
  "profiles.origin.catalog": "Imported from a settings document",
  "profiles.origin.console": "Made in the console",
  "profiles.state.usable": "Available",
  "profiles.state.base_changed": "Base profile changed",
  "profiles.state.base_missing": "Base profile removed",
  "profiles.state.retired": "Turned off",
  "profiles.state.base_retired": "Base profile turned off",
  "profiles.state.blocked": "Blocked",
  "profiles.state.base_blocked": "Base profile blocked",
  "profiles.state.connection_missing": "No connection",
  "profiles.state.unattended_off": "Off on this installation",
  "profiles.state.definition_drift": "Settings changed",
  "profiles.state.runtime_unsupported": "Runtime not supported",
  "profiles.stateReason.usable":
    "New releases and sessions can pick this profile.",
  "profiles.stateReason.base_changed":
    "The base profile {base} changed after this version was made. No new release can use it, and releases on it cannot start new sessions. Recreate it as a new version.",
  "profiles.stateReason.base_missing":
    "The base profile {base} is gone. No new release can use this version, and releases on it cannot start new sessions.",
  "profiles.stateReason.retired":
    "Turned off. Releases and sessions already on it keep running; new ones cannot pick it.",
  "profiles.stateReason.base_retired":
    "The base profile {base} was turned off. What already uses this keeps running; nothing new can pick it.",
  "profiles.stateReason.connection_missing":
    "This profile's connection is not on this installation, so it runs nothing. Put the connection back or make a new version on another one.",
  "profiles.stateReason.unattended_off":
    "This is a bypassPermissions profile and PLATFORM_ALLOW_UNATTENDED_PERMISSIONS is off here, so it runs nothing.",
  "profiles.stateReason.definition_drift":
    "This server no longer reads the saved definition the same way, so it runs nothing. Create a new version.",
  "profiles.stateReason.runtime_unsupported":
    "No worker on this installation takes this runtime or permission mode, so it runs nothing.",
  "profiles.stateReason.blocked":
    "The operator blocked it. No new release or session can use it, and sessions already on it stop at their next turn. After unblocking it can be picked again, but a stopped turn does not run again: send that session a new message.",
  "profiles.stateReason.base_blocked":
    "The base profile {base} is blocked. Releases and sessions on this version stop too, and nothing new can pick it.",
  "profiles.newVersion": "New version",
  "profiles.remake": "Recreate",
  "profiles.retire": "Turn off",
  "profiles.baseChanged.title": "The base profile of {name} changed",
  "profiles.baseChanged.text":
    "{base} changed. No new release can use {id}, and releases that use it cannot start new sessions. Recreate it and move to the new version.",
  "profiles.baseMissing.title": "The base profile of {name} was removed",
  "profiles.baseMissing.text":
    "{base} is gone. No new release can use {id}, and releases that use it cannot start new sessions. Create a new one from another installation profile.",
  "profiles.editor.versionTitle": "New version of {name}",
  "profiles.editor.remakeTitle": "Recreate {name}",
  "profiles.editor.description":
    "From the installation profile it is based on, you can only remove models and tools or make the permission mode stricter.",
  "profiles.editor.base": "Base profile",
  "profiles.editor.baseHeading": "Installation profile {id}",
  "profiles.editor.engineModel": "Engine · model",
  "profiles.editor.engineModelValue": "Claude Agent SDK {version} · {model}",
  "profiles.editor.permissionMode": "Permission mode",
  "profiles.editor.narrowTitle": "Values for this workspace",
  "profiles.editor.autoRulesNote":
    "Auto rules (environment, allow, soft deny, hard deny, classifying every shell command) are not edited here. A screen for them comes in a later stage.",
  "profiles.editor.name": "Name",
  "profiles.editor.nameHint":
    "Starts with a lowercase letter or digit; lowercase letters, digits and - up to 40 characters.",
  "profiles.editor.preview": "ID of the version to save: {id}",
  "profiles.editor.models": "Models",
  "profiles.editor.modelsHint":
    "The models a session may pick. Only the base profile's models are offered.",
  "profiles.editor.defaultModel": "Default model",
  "profiles.editor.modeHint":
    "Choose the base profile's permission mode or a mode that requires more human review.",
  "profiles.editor.autoClosed":
    "auto is available only when the base profile uses auto or bypassPermissions.",
  "profiles.editor.bypassClosed":
    "bypassPermissions can be picked only over a base profile in bypassPermissions. The installation setting PLATFORM_ALLOW_UNATTENDED_PERMISSIONS has to be on and an owner has to make such an installation profile.",
  "profiles.editor.bypassRisk":
    "bypassPermissions runs every tool call with nothing judging it. File writes, shell commands and git commits run with no person or classifier checking them; only the container, the egress allowlist, the tool list and the cost limit bound it. Pick auto to have a classifier stop risky calls.",
  "profiles.editor.scriptCeiling": "Script ceiling",
  "profiles.editor.scriptNone": "Not run",
  "profiles.editor.scriptLater": "From stage 2a",
  "profiles.editor.scriptHint":
    "The maximum level of access to extension scripts. You can only lower it.",
  "profiles.editor.saveNote":
    "This saves a new version. Releases on an earlier version change only when moved to the new one.",
  "profiles.editor.save": "Save as new version",
  "profiles.editor.saving": "Saving…",
  "profiles.editor.nameInvalid":
    "A name starts with a lowercase letter or digit and holds lowercase letters, digits and - up to 40 characters.",
  "profiles.editor.modelsEmpty": "Pick at least one model.",
  "profiles.editor.tooLarge":
    "A profile holds up to 32 models and 64 tools. Pick fewer and save again.",
  "profiles.editor.tooLong":
    "A profile holds names of up to 200 characters. Leave out the model or tool with the long name and save again.",
  "profiles.error.unknownBase": "That base profile is gone. Reload the list.",
  "profiles.error.baseUnusable":
    "That base profile cannot be used now. Pick one that is usable.",
  "profiles.error.widens":
    "The base profile does not allow a value you picked. Reload the list and check the base profile.",
  "profiles.error.versionTaken":
    "A new version of this name was just saved. Save again to make the one after it.",
  "profiles.review.title": "Review",
  "profiles.review.text": "What differs from {id}.",
  "profiles.review.none": "Nothing differs from {id}.",
  "profiles.review.change": "{before} → {after}",
  "profiles.new.ceilingTitle": "Create installation profile",
  "profiles.new.ceilingVersionTitle": "New version of {name}",
  "profiles.new.ceilingDescription":
    "An installation profile sets the widest range every workspace on this installation can use. Workspace profiles can only narrow it. Connections and credentials are set under Model connections, cost limits in the server settings.",
  "profiles.new.kind": "Kind",
  "profiles.new.kindHint.workspace":
    "Narrows the models, tools and permission mode of one installation profile.",
  "profiles.new.kindHint.installation":
    "Sets the runtime, models, tools, permission mode and repositories on one connection. Only an owner makes one.",
  "profiles.new.fromMissing":
    "There is no profile {id}. Starting from an empty form.",
  "profiles.new.cannotMake": "Nothing can be made now",
  "profiles.new.noConnections":
    "This installation has no connection. Add one under Model connections, then open this again.",
  "profiles.new.noRuntimes": "No worker on this installation takes a runtime.",
  "profiles.new.noBase":
    "There is no usable installation profile to start from.",
  "profiles.ceiling.connection": "Connection",
  "profiles.ceiling.connectionOption": "{id} ({kind} · {billing})",
  "profiles.ceiling.connectionHint":
    "The connection sets the model provider and credentials. Connections change under Model connections.",
  "profiles.ceiling.runtime": "Runtime",
  "profiles.ceiling.runtimeVersion": "Runtime version",
  "profiles.ceiling.runtimeVersionInvalid":
    "Enter a runtime version of up to 200 characters.",
  "profiles.ceiling.modelsHint":
    "One model per line. Sessions pick their model from these.",
  "profiles.ceiling.titleModel": "Title model",
  "profiles.ceiling.titleModelHint":
    "Left empty, the default model names sessions.",
  "profiles.ceiling.bypassClosed":
    "PLATFORM_ALLOW_UNATTENDED_PERMISSIONS is off on this installation, so bypassPermissions cannot be picked.",
  "profiles.ceiling.claudeMd": "Read the repository's CLAUDE.md",
  "profiles.ceiling.claudeMdHint":
    "On, sessions read the repository's CLAUDE.md as instructions.",
  "profiles.ceiling.repositoryMode": "Repository",
  "profiles.ceiling.repositories": "Allowed repositories",
  "profiles.ceiling.repositoriesHint":
    "The repositories sessions and releases on this profile may use.",
  "profiles.ceiling.appRepositories":
    "Allow every repository the App is installed on",
  "profiles.ceiling.appRepositoriesHint":
    "On: agents pick, on their GitHub tab, any repository the console's GitHub App is installed on. Off: only the repositories chosen below.",
  "profiles.ceiling.noRepositories": "This installation has no repositories.",
  "profiles.ceiling.repositoriesEmpty":
    "Pick at least one repository. To run without one, choose 'No repository'.",
  "profiles.ceiling.preview": "Saves as {name} v{version}.",
  "profiles.ceiling.saveNote":
    "A saved version never changes. To change it, make a new version.",
  "profiles.ceiling.save": "Save",
  "profiles.ceiling.ownerOnly":
    "Only a workspace owner makes and turns off installation profiles.",
  "profiles.ceiling.error.unknownConnection":
    "That connection is not on this installation. Reload and pick a connection.",
  "profiles.ceiling.error.runtimeNotInstalled":
    "No worker on this installation takes that runtime or permission mode.",
  "profiles.ceiling.error.unattendedNotAllowed":
    "PLATFORM_ALLOW_UNATTENDED_PERMISSIONS is off on this installation, so a bypassPermissions profile is not saved.",
  "profiles.ceiling.error.unknownRepository":
    "A repository you picked is not on this installation. Reload and pick again.",
  "profiles.ceiling.error.modelNotInModels":
    "The default model has to be one of the models.",
  "profiles.ceiling.error.unknownPrevious":
    "The previous version you named is gone. Reload the list.",
  "profiles.ceiling.error.invalid": "This value cannot be saved in a profile.",
  "profiles.ceiling.error.idTaken":
    "The ID this name would get is taken. Pick another name.",
  "profiles.ceiling.error.stalePrevious":
    "The latest version of this name is {id}. A new version is made from the latest one.",
  "profiles.ceiling.error.noVersion":
    "This name has no version yet. Reload the list.",
  "profiles.ceiling.error.openLatest": "Start again from the latest version",
  "profiles.retireTitle": "Turn off version {id}?",
  "profiles.retireText":
    "Releases and sessions that already use it keep running. New releases and sessions cannot pick it. Turning it off cannot be undone.",
  "profiles.retireCeilingText":
    "Releases, sessions and workspace profiles already using this one keep running. New releases, sessions and workspace profiles cannot pick it. Turning it off cannot be undone.",
  "profiles.retiring": "Turning off…",
  "profiles.retired": "Turned off version {id}.",
  "profiles.retireRow": "Turn off this version",
  "profiles.retireRowHint":
    "New releases and sessions can no longer pick it. This cannot be undone.",
  "profiles.blockRow": "Block this installation profile",
  "profiles.blockRowHint":
    "Sessions on it stop at their next turn. You can unblock it, but a stopped turn does not run again.",
  "profiles.block": "Block",
  "profiles.unblock": "Unblock",
  "profiles.blockTitle": "Block installation profile {id}?",
  "profiles.unblockTitle": "Unblock installation profile {id}?",
  "profiles.blockText":
    "No new release or session can use this profile or the workspace profiles over it. Sessions already on it stop at their next turn, and a running turn loses its model and repository requests within about a second. You can unblock it, but a stopped turn does not run again.",
  "profiles.unblockText":
    "This profile can be picked again. Sessions and turns stopped while it was blocked do not run again on their own: send those sessions a new message.",
  "profiles.blocking": "Blocking…",
  "profiles.unblocking": "Unblocking…",
  "profiles.blockDone": "Blocked installation profile {id}.",
  "profiles.unblockDone": "Unblocked installation profile {id}.",
  "profiles.blockOwnerOnly":
    "Only a workspace owner blocks and unblocks installation profiles.",
  "profiles.open": "Open {name}",
  "profiles.detail.notFound.title": "Profile not found",
  "profiles.detail.notFound.text":
    "There is no profile {id}. The address may be wrong.",
  "profiles.detail.back": "Back to profiles",
  "profiles.detail.workspaceDescription":
    "Made in this workspace from an installation profile. Editing saves a new version; this version stays as it is.",
  "profiles.detail.ceilingDescription":
    "Sets the widest range every workspace on this installation can use. A saved version never changes; editing makes a new one.",
  "profiles.detail.ownerOnly":
    "Only a workspace owner changes installation profiles",
  "profiles.detail.createFrom": "Create a workspace profile from this one",
  "profiles.detail.settings": "Settings",
  "profiles.detail.id": "ID",
  "profiles.detail.models": "Models to choose from",
  "profiles.detail.titleModelDefault": "Default model",
  "profiles.detail.noRepositories": "No repository allowed",
  "profiles.detail.billing": "Cost",
  "profiles.detail.created": "Created",
  "profiles.detail.retiredAt": "Turned off",
  "profiles.detail.audit.title": "Record",
  "profiles.detail.audit.origin": "Source",
  "profiles.detail.audit.createdBy": "Created by",
  "profiles.detail.audit.retiredBy": "Turned off by",
  "profiles.detail.audit.previous": "Previous version",
  "profiles.detail.audit.noPrevious": "None",
  "profiles.detail.audit.imported": "Settings document",
  "profiles.detail.audit.unknown": "Unknown",
  "profiles.detail.audit.you": "{id} (you)",
  "profiles.detail.history.title": "Versions",
  "profiles.detail.history.ceilingDescription":
    "Installation profiles linked by their previous version. Releases on an earlier one keep running.",
  "profiles.detail.history.version": "Version",
  "profiles.detail.history.named": "{name} v{version}",
  "profiles.detail.history.current": "Viewing",
  "profiles.detail.narrowings.title": "Workspace profiles made from this one",
  "profiles.detail.narrowings.description":
    "Profiles made by narrowing this one.",
  "profiles.detail.narrowings.empty":
    "No workspace profile is made from this one.",
  "profiles.detail.agents.title": "Agents using this profile",
  "profiles.detail.agents.description":
    "Agents whose active release uses this profile (version). Earlier releases are not counted.",
  "profiles.detail.agents.withheld":
    "Only people who can manage agents see the agent list",
  "profiles.detail.agents.empty": "No agent uses this profile now.",
  "profiles.detail.agents.agent": "Agent",
  "profiles.detail.agents.release": "Active release",
  "profiles.detail.agents.open": "Open the release of {name}",
  "profiles.rollout.title": "New version rollout",
  "profiles.rollout.description":
    "How far the new version has reached the agents that follow this profile.",
  "profiles.rollout.progress": "{applied} of {total} applied",
  "profiles.rollout.pending": "{count} are waiting to be applied.",
  "profiles.rollout.failedTitle": "{count} agents could not be updated",
  "profiles.rollout.failedAgents": "Agents that could not be updated",
  "profiles.rollout.agent": "Agent",
  "profiles.rollout.reason": "Reason",
  "profiles.rollout.retry": "Try again",
  "profiles.rollout.retryFor": "Try {name} again",
  "profiles.rollout.retried": "{name} was queued to be applied again.",
  "profiles.rollout.notRetried":
    "There was nothing to retry. It may already have been handled.",
  "profiles.rollout.fixedModel":
    "{count} agents with a chosen model keep it when the default model changes.",
  "profiles.tools.legend": "Built-in tools to block",
  "profiles.tools.hint":
    "A ticked tool does not run in this profile's sessions. Only built-in tools are listed here; an agent's MCP settings decide its MCP tools.",
  "profiles.tools.unlimited":
    "With nothing ticked there is no limit, within the built-in tool catalog the platform supports ({catalog}).",
  "profiles.tools.unlimitedBase":
    "With nothing more ticked it runs every tool the base profile {base} does not block, within the built-in tool catalog the platform supports.",
  "profiles.tools.providerNote":
    "Provider-side tools run at the model provider, where the egress proxy cannot stop them. A first version starts with them blocked.",
  "profiles.tools.boundary.local": "In worker",
  "profiles.tools.boundary.egress": "Egress",
  "profiles.tools.boundary.provider": "Provider side",
  "profiles.tools.new": "New tool",
  "profiles.tools.fixed": "The base profile blocks this tool.",
  "profiles.tools.diff.legend": "Catalog changes",
  "profiles.tools.diff.text":
    "Tools {id} did not have start blocked. To open one, tick its accept box and clear it in the list above.",
  "profiles.tools.diff.accept": "Accept running {tool}",
  "profiles.tools.diff.stillBlocked": "Blocked for now.",
  "profiles.tools.diff.opens": "Runs in this version.",
  "profiles.tools.diff.removed": "No longer supported:",
  "profiles.tools.unaccepted":
    "To open {tools}, which the previous version did not have, tick accept or block it again.",
  "profiles.tools.asked":
    "This opens tools the previous version never weighed. Accept them under Catalog changes, or block them again.",
  "profiles.tools.noCatalog":
    "No supported catalog lists runtime version {version}, so a block list cannot be saved on it. Supported versions: {versions}",
  "profiles.tools.noCatalogs":
    "This installation has no supported catalog, so a block list cannot be saved.",
  "profiles.tools.baseNoCatalog":
    "No supported catalog lists the base profile's runtime version, so this profile cannot be saved as a block list.",
  "profiles.tools.error.mcpTool":
    "A profile cannot block MCP tools. Pick built-in tools only.",
  "profiles.tools.error.toolPattern":
    "Patterns are not taken. Pick a whole built-in tool.",
  "profiles.tools.error.unknownTool":
    "A tool is not in this runtime version's supported catalog. Reload the list.",
  "profiles.tools.error.noToolCatalog":
    "No supported catalog lists this runtime version, so a block list cannot be saved on it.",
  "profiles.tools.error.baseDenies":
    "A tool the base profile blocks cannot be opened. Reload the list.",
  "profiles.tools.blocked": "Blocked tools",
  "profiles.tools.running": "Tools that run",
  "profiles.tools.noneBlocked": "None blocked",
  "profiles.tools.allowList":
    "No supported catalog lists this version's runtime version. It was set by a tool list (an allow list), so the console only reads it.",
  "profiles.tools.blockedNew": "{count} new tools blocked in this version",
  "profiles.tools.blockedNewText":
    "These tools do not run in this version, which never decided on them: {tools}. To open them, make a new version on the supported catalog {catalog} and accept them.",
  "profiles.tools.makeVersion": "Make a new version",
  "profiles.column.blocked": "Blocked",
  "profiles.blockedCount": "{count}",
};

export const profilesJa: Record<keyof typeof profilesKo, string> = {
  "nav.profiles": "プロファイル",
  "profiles.title": "プロファイル",
  "profiles.description":
    "エージェントが使うモデルとツールを決めます。インストールのプロファイルは、このインストールのすべてのワークスペースが使える最も広い範囲を決めます。ワークスペースのプロファイルはインストールのプロファイルを 1 つ絞って作ります。",
  "profiles.create": "プロファイルを作成",
  "profiles.createCeiling": "インストールのプロファイルを作成",
  "profiles.kind.installation": "インストールのプロファイル",
  "profiles.kind.workspace": "ワークスペースのプロファイル",
  "profiles.option": "{name} v{version} · {model}（{kind}）",
  "profiles.optionKind.installation": "インストール",
  "profiles.optionKind.workspace": "ワークスペース",
  "profiles.optionUnnamed": "{kind}プロファイル · {model}",
  "profiles.workspace.description":
    "編集すると新しいバージョンとして保存されます。前のバージョンを使っていたエージェントはそのまま動きます。",
  "profiles.locked":
    "変更するにはワークスペースのオーナーか管理者に依頼してください",
  "profiles.count": "{count} 件",
  "profiles.column.name": "名前",
  "profiles.column.version": "バージョン",
  "profiles.column.kind": "種類",
  "profiles.column.base": "ベースプロファイル",
  "profiles.column.model": "既定のモデル",
  "profiles.column.state": "状態",
  "profiles.narrowKind": "{kind} · v{version}",
  "profiles.repository.required": "リポジトリ必須",
  "profiles.repository.optional": "リポジトリ任意",
  "profiles.repository.none": "リポジトリを使わない",
  "profiles.billing.metered": "コスト集計",
  "profiles.billing.none": "コスト集計なし",
  "profiles.noTools": "ツールなし",
  "profiles.on": "オン",
  "profiles.off": "オフ",
  "profiles.empty": "このインストールにはプロファイルがありません。",
  "profiles.versionTag": "v{version}",
  "profiles.olderVersions": "前のバージョン {count} 件",
  "profiles.origin.catalog": "設定ドキュメントから取り込み",
  "profiles.origin.console": "コンソールで作成",
  "profiles.state.usable": "使用可能",
  "profiles.state.base_changed": "ベースプロファイル変更済み",
  "profiles.state.base_missing": "ベースプロファイルなし",
  "profiles.state.retired": "使用停止",
  "profiles.state.base_retired": "ベースプロファイル使用停止",
  "profiles.state.blocked": "ブロック中",
  "profiles.state.base_blocked": "ベースプロファイルブロック中",
  "profiles.state.connection_missing": "接続なし",
  "profiles.state.unattended_off": "このインストールでは無効",
  "profiles.state.definition_drift": "設定変更済み",
  "profiles.state.runtime_unsupported": "未対応のランタイム",
  "profiles.stateReason.usable":
    "新しいリリースとセッションがこのプロファイルを選べます。",
  "profiles.stateReason.base_changed":
    "ベースプロファイル {base} がこのバージョンの作成後に変わりました。新しいリリースは作成できず、このバージョンを使うリリースも新しいセッションを開始できません。作り直して新しいバージョンに移してください。",
  "profiles.stateReason.base_missing":
    "ベースプロファイル {base} がありません。新しいリリースは作成できず、このバージョンを使うリリースも新しいセッションを開始できません。",
  "profiles.stateReason.retired":
    "使用停止しました。すでに使っているリリースとセッションは動き続け、新しいものは選べません。",
  "profiles.stateReason.base_retired":
    "ベースプロファイル {base} が使用停止されました。すでに使っているものは動き続け、新しく選ぶことはできません。",
  "profiles.stateReason.connection_missing":
    "このプロファイルの接続がこのインストールにないため、何も動かしません。接続を戻すか、別の接続で新しいバージョンを作ってください。",
  "profiles.stateReason.unattended_off":
    "bypassPermissions のプロファイルですが、このインストールでは PLATFORM_ALLOW_UNATTENDED_PERMISSIONS が無効なので何も動かしません。",
  "profiles.stateReason.definition_drift":
    "保存した定義をこのサーバーが同じ値として読めないため、何も動かしません。新しいバージョンを作ってください。",
  "profiles.stateReason.runtime_unsupported":
    "このインストールの worker がこのランタイムか権限モードを受け付けないため、何も動かしません。",
  "profiles.stateReason.blocked":
    "運用担当者がブロックしました。新しいリリースとセッションでは使えず、すでに使っているセッションも次のターンで止まります。解除すると再び選べますが、止まったターンは再実行されません。そのセッションには新しいメッセージを送ってください。",
  "profiles.stateReason.base_blocked":
    "ベースプロファイル {base} がブロックされました。このバージョンを使うリリースとセッションも止まり、新しく選ぶことはできません。",
  "profiles.newVersion": "新しいバージョン",
  "profiles.remake": "作り直す",
  "profiles.retire": "使用停止",
  "profiles.baseChanged.title": "{name} のベースプロファイルが変わりました",
  "profiles.baseChanged.text":
    "{base} が変わりました。{id} では新しいリリースを作成できず、このバージョンを使うリリースも新しいセッションを開始できません。作り直して新しいバージョンに移してください。",
  "profiles.baseMissing.title": "{name} のベースプロファイルがなくなりました",
  "profiles.baseMissing.text":
    "{base} がなくなりました。{id} では新しいリリースを作成できず、このバージョンを使うリリースも新しいセッションを開始できません。別のインストールのプロファイルから新しく作成してください。",
  "profiles.editor.versionTitle": "{name} の新しいバージョン",
  "profiles.editor.remakeTitle": "{name} を作り直す",
  "profiles.editor.description":
    "ベースのインストールのプロファイルから、モデル・ツールを減らすか、権限モードをより厳しくすることだけができます。",
  "profiles.editor.base": "ベースプロファイル",
  "profiles.editor.baseHeading": "インストールのプロファイル {id}",
  "profiles.editor.engineModel": "エンジン・モデル",
  "profiles.editor.engineModelValue": "Claude Agent SDK {version} · {model}",
  "profiles.editor.permissionMode": "権限モード",
  "profiles.editor.narrowTitle": "このワークスペースで使う値",
  "profiles.editor.autoRulesNote":
    "auto ルール(環境・許可・soft deny・hard deny、すべてのシェルコマンドの分類)はここでは変更しません。設定する画面は次の段階でできます。",
  "profiles.editor.name": "名前",
  "profiles.editor.nameHint":
    "英小文字または数字で始め、英小文字・数字・ハイフン（-）を使って40文字以内で入力してください。",
  "profiles.editor.preview": "保存するバージョンの ID: {id}",
  "profiles.editor.models": "モデル",
  "profiles.editor.modelsHint":
    "セッションが選べるモデルです。ベースプロファイルにあるモデルだけを選べます。",
  "profiles.editor.defaultModel": "既定のモデル",
  "profiles.editor.modeHint":
    "ベースプロファイルと同じか、人がより多く確認するモードだけを選べます。",
  "profiles.editor.autoClosed":
    "auto はベースプロファイルが auto か bypassPermissions のときだけ選べます。",
  "profiles.editor.bypassClosed":
    "bypassPermissions はベースプロファイルが bypassPermissions のときだけ選べます。インストール設定 PLATFORM_ALLOW_UNATTENDED_PERMISSIONS が有効で、オーナーがそのようなインストールのプロファイルを作成する必要があります。",
  "profiles.editor.bypassRisk":
    "bypassPermissions はすべてのツール呼び出しを判定なしで実行します。ファイルの書き込み・シェルコマンド・git commit も人や分類器が確認せず、制限はコンテナ・外部接続の許可リスト・ツール一覧・コスト上限だけです。危険な呼び出しを分類器に止めさせるには auto を選んでください。",
  "profiles.editor.scriptCeiling": "スクリプト上限",
  "profiles.editor.scriptNone": "実行しない",
  "profiles.editor.scriptLater": "2a 段階から",
  "profiles.editor.scriptHint":
    "エージェントが拡張スクリプトを呼べる上限です。下げることだけができます。",
  "profiles.editor.saveNote":
    "新しいバージョンとして保存します。前のバージョンを使うリリースは、新しいバージョンに移すまで変わりません。",
  "profiles.editor.save": "新しいバージョンとして保存",
  "profiles.editor.saving": "保存中…",
  "profiles.editor.nameInvalid":
    "名前は英小文字か数字で始め、英小文字・数字・- で 40 文字までです。",
  "profiles.editor.modelsEmpty": "モデルを 1 つ以上選んでください。",
  "profiles.editor.tooLarge":
    "1 つのプロファイルに入るのはモデル 32 個、ツール 64 個までです。減らしてからもう一度保存してください。",
  "profiles.editor.tooLong":
    "プロファイルに入る名前は 200 文字までです。名前の長いモデルやツールを外してから保存してください。",
  "profiles.error.unknownBase":
    "そのベースプロファイルはありません。一覧を再読み込みしてください。",
  "profiles.error.baseUnusable":
    "そのベースプロファイルは現在使用できません。使用できるベースプロファイルを選んでください。",
  "profiles.error.widens":
    "ベースプロファイルが許可しない値です。一覧を再読み込みしてベースプロファイルを確認してください。",
  "profiles.error.versionTaken":
    "同じ名前の新しいバージョンがいま保存されました。もう一度保存するとその次のバージョンになります。",
  "profiles.review.title": "確認",
  "profiles.review.text": "{id} と異なる項目です。",
  "profiles.review.none": "{id} と異なる項目はありません。",
  "profiles.review.change": "{before} → {after}",
  "profiles.new.ceilingTitle": "インストールのプロファイルを作成",
  "profiles.new.ceilingVersionTitle": "{name} の新しいバージョン",
  "profiles.new.ceilingDescription":
    "インストールのプロファイルは、このインストールのすべてのワークスペースが使える最も広い範囲を決めます。ワークスペースのプロファイルはこれを絞ることだけができます。接続と認証情報はモデル接続で、コスト上限はサーバー設定で決めます。",
  "profiles.new.kind": "種類",
  "profiles.new.kindHint.workspace":
    "インストールのプロファイル 1 つをもとに、モデル・ツール・権限モードを絞ります。",
  "profiles.new.kindHint.installation":
    "接続 1 つの上で、ランタイム・モデル・ツール・権限モード・リポジトリを決めます。オーナーだけが作れます。",
  "profiles.new.fromMissing":
    "プロファイル {id} はありません。空のフォームから始めます。",
  "profiles.new.cannotMake": "いまは作れません",
  "profiles.new.noConnections":
    "このインストールに接続がありません。モデル接続で接続を追加してから開き直してください。",
  "profiles.new.noRuntimes":
    "このインストールの worker が受け付けるランタイムがありません。",
  "profiles.new.noBase": "もとにできるインストールのプロファイルがありません。",
  "profiles.ceiling.connection": "接続",
  "profiles.ceiling.connectionOption": "{id} ({kind} · {billing})",
  "profiles.ceiling.connectionHint":
    "モデルの提供元と認証情報は接続が決めます。接続はモデル接続で変更します。",
  "profiles.ceiling.runtime": "ランタイム",
  "profiles.ceiling.runtimeVersion": "ランタイムのバージョン",
  "profiles.ceiling.runtimeVersionInvalid":
    "ランタイムのバージョンを 200 文字以内で入力してください。",
  "profiles.ceiling.modelsHint":
    "1 行に 1 つのモデルを書きます。セッションはこの中からモデルを選びます。",
  "profiles.ceiling.titleModel": "タイトルのモデル",
  "profiles.ceiling.titleModelHint":
    "空にすると既定のモデルがセッションのタイトルを付けます。",
  "profiles.ceiling.bypassClosed":
    "このインストールでは PLATFORM_ALLOW_UNATTENDED_PERMISSIONS が無効なので bypassPermissions は選べません。",
  "profiles.ceiling.claudeMd": "リポジトリの CLAUDE.md を読む",
  "profiles.ceiling.claudeMdHint":
    "オンにするとセッションがリポジトリの CLAUDE.md を指示として読みます。",
  "profiles.ceiling.repositoryMode": "リポジトリ",
  "profiles.ceiling.repositories": "許可するリポジトリ",
  "profiles.ceiling.repositoriesHint":
    "このプロファイルのセッションとリリースが使えるリポジトリです。",
  "profiles.ceiling.appRepositories":
    "App がインストールされたリポジトリをすべて許可",
  "profiles.ceiling.appRepositoriesHint":
    "オンにすると、コンソールに登録した GitHub App がインストールされたリポジトリを、エージェントが GitHub タブで選んで使えます。オフにすると、下で選んだリポジトリだけを使います。",
  "profiles.ceiling.noRepositories":
    "このインストールにはリポジトリがありません。",
  "profiles.ceiling.repositoriesEmpty":
    "リポジトリを1つ以上選んでください。リポジトリなしで動かすには「リポジトリを使わない」を選びます。",
  "profiles.ceiling.preview": "{name} v{version} として保存します。",
  "profiles.ceiling.saveNote":
    "保存したバージョンは変わりません。変更するには新しいバージョンを作ります。",
  "profiles.ceiling.save": "保存",
  "profiles.ceiling.ownerOnly":
    "インストールのプロファイルはワークスペースのオーナーだけが作成・使用停止できます。",
  "profiles.ceiling.error.unknownConnection":
    "その接続はこのインストールにありません。再読み込みして接続を選んでください。",
  "profiles.ceiling.error.runtimeNotInstalled":
    "このインストールの worker はそのランタイムか権限モードを受け付けません。",
  "profiles.ceiling.error.unattendedNotAllowed":
    "このインストールでは PLATFORM_ALLOW_UNATTENDED_PERMISSIONS が無効なので、bypassPermissions のプロファイルは保存しません。",
  "profiles.ceiling.error.unknownRepository":
    "選んだリポジトリにこのインストールにないものがあります。再読み込みして選び直してください。",
  "profiles.ceiling.error.modelNotInModels":
    "既定のモデルはモデル一覧に含めてください。",
  "profiles.ceiling.error.unknownPrevious":
    "前のバージョンとして選んだプロファイルがありません。一覧を再読み込みしてください。",
  "profiles.ceiling.error.invalid":
    "この値はプロファイルとして保存できません。",
  "profiles.ceiling.error.idTaken":
    "この名前で作る ID はすでにあります。別の名前を選んでください。",
  "profiles.ceiling.error.stalePrevious":
    "この名前の最新バージョンは {id} です。新しいバージョンは最新バージョンから作ります。",
  "profiles.ceiling.error.noVersion":
    "この名前にはまだバージョンがありません。一覧を再読み込みしてください。",
  "profiles.ceiling.error.openLatest": "最新バージョンから作り直す",
  "profiles.retireTitle": "バージョン {id} を使用停止しますか?",
  "profiles.retireText":
    "すでにこのバージョンを使っているリリースとセッションは動き続けます。新しいリリースとセッションではこのバージョンを選べません。使用停止は元に戻せません。",
  "profiles.retireCeilingText":
    "すでにこのプロファイルを使っているリリース・セッションと、その上のワークスペースのプロファイルは動き続けます。新しいリリース・セッション・ワークスペースのプロファイルではこのプロファイルを選べません。使用停止は元に戻せません。",
  "profiles.retiring": "使用停止しています…",
  "profiles.retired": "バージョン {id} を使用停止しました。",
  "profiles.retireRow": "このバージョンを使用停止",
  "profiles.retireRowHint":
    "新しいリリースとセッションではこのバージョンを選べなくなります。元に戻せません。",
  "profiles.blockRow": "このプロファイルをブロック",
  "profiles.blockRowHint":
    "このプロファイルを使うセッションも次のターンで止まります。解除できますが、止まったターンは再実行されません。",
  "profiles.block": "ブロック",
  "profiles.unblock": "ブロック解除",
  "profiles.blockTitle": "インストールのプロファイル {id} をブロックしますか?",
  "profiles.unblockTitle":
    "インストールのプロファイル {id} のブロックを解除しますか?",
  "profiles.blockText":
    "このプロファイルとその上のワークスペースのプロファイルでは、新しいリリースとセッションを作成できません。すでに使っているセッションも次のターンで止まり、いま動いているターンは 1 秒ほどでモデルとリポジトリへのリクエストが切れます。解除できますが、止まったターンは再実行されません。",
  "profiles.unblockText":
    "このプロファイルを再び選べるようになります。ブロック中に止まったセッションとターンは自動では再実行されません。必要なセッションには新しいメッセージを送ってください。",
  "profiles.blocking": "ブロックしています…",
  "profiles.unblocking": "ブロックを解除しています…",
  "profiles.blockDone": "インストールのプロファイル {id} をブロックしました。",
  "profiles.unblockDone":
    "インストールのプロファイル {id} のブロックを解除しました。",
  "profiles.blockOwnerOnly":
    "インストールのプロファイルはワークスペースのオーナーだけがブロック・解除できます。",
  "profiles.open": "{name} の詳細を見る",
  "profiles.detail.notFound.title": "プロファイルが見つかりません",
  "profiles.detail.notFound.text":
    "プロファイル {id} はありません。アドレスが誤っている可能性があります。",
  "profiles.detail.back": "プロファイル一覧へ",
  "profiles.detail.workspaceDescription":
    "インストールのプロファイルをもとにこのワークスペースで作ったプロファイルです。編集すると新しいバージョンとして保存され、このバージョンはそのまま残ります。",
  "profiles.detail.ceilingDescription":
    "このインストールのすべてのワークスペースが使える最も広い範囲を決めます。保存したバージョンは変わらず、編集すると新しいバージョンになります。",
  "profiles.detail.ownerOnly":
    "インストールのプロファイルはワークスペースのオーナーだけが変更できます",
  "profiles.detail.createFrom": "ワークスペースのプロファイルを作成",
  "profiles.detail.settings": "設定",
  "profiles.detail.id": "ID",
  "profiles.detail.models": "選べるモデル",
  "profiles.detail.titleModelDefault": "既定のモデル",
  "profiles.detail.noRepositories": "許可したリポジトリなし",
  "profiles.detail.billing": "コスト",
  "profiles.detail.created": "作成日時",
  "profiles.detail.retiredAt": "使用停止日時",
  "profiles.detail.audit.title": "記録",
  "profiles.detail.audit.origin": "出どころ",
  "profiles.detail.audit.createdBy": "作成者",
  "profiles.detail.audit.retiredBy": "使用停止した人",
  "profiles.detail.audit.previous": "前のバージョン",
  "profiles.detail.audit.noPrevious": "なし",
  "profiles.detail.audit.imported": "設定ドキュメント",
  "profiles.detail.audit.unknown": "不明",
  "profiles.detail.audit.you": "{id} (自分)",
  "profiles.detail.history.title": "バージョン履歴",
  "profiles.detail.history.ceilingDescription":
    "前のバージョンでつながったインストールのプロファイルです。前のバージョンを使うリリースはそのまま動きます。",
  "profiles.detail.history.version": "バージョン",
  "profiles.detail.history.named": "{name} v{version}",
  "profiles.detail.history.current": "表示中",
  "profiles.detail.narrowings.title":
    "このプロファイルから作ったワークスペースのプロファイル",
  "profiles.detail.narrowings.description":
    "このプロファイルを絞って作ったプロファイルです。",
  "profiles.detail.narrowings.empty":
    "このプロファイルから作ったワークスペースのプロファイルはありません。",
  "profiles.detail.agents.title": "このプロファイルを使うエージェント",
  "profiles.detail.agents.description":
    "有効なリリースでこのプロファイル（バージョン）を使用しているエージェントです。以前のリリースは含みません。",
  "profiles.detail.agents.withheld":
    "エージェント一覧はエージェントを管理できる人だけが見られます",
  "profiles.detail.agents.empty":
    "今このプロファイルを使うエージェントはありません。",
  "profiles.detail.agents.agent": "エージェント",
  "profiles.detail.agents.release": "有効なリリース",
  "profiles.detail.agents.open": "{name}のリリースを表示",
  "profiles.rollout.title": "新バージョンの適用状況",
  "profiles.rollout.description":
    "このプロファイルに追従するエージェントに新しいバージョンが行き渡った状況です。",
  "profiles.rollout.progress": "{total}件中{applied}件を適用",
  "profiles.rollout.pending": "{count}件は適用待ちです。",
  "profiles.rollout.failedTitle": "適用できなかったエージェント{count}件",
  "profiles.rollout.failedAgents": "適用できなかったエージェント",
  "profiles.rollout.agent": "エージェント",
  "profiles.rollout.reason": "理由",
  "profiles.rollout.retry": "再試行",
  "profiles.rollout.retryFor": "{name}を再試行",
  "profiles.rollout.retried": "{name}をもう一度適用するよう戻しました。",
  "profiles.rollout.notRetried":
    "再試行する項目がありません。すでに処理済みの可能性があります。",
  "profiles.rollout.fixedModel":
    "モデルを選んでいるエージェント{count}件は、既定モデルが変わってもそのままです。",
  "profiles.tools.legend": "ブロックする組み込みツール",
  "profiles.tools.hint":
    "チェックしたツールはこのプロファイルのセッションで動きません。扱うのは組み込みツールだけです。MCP ツールはエージェントの MCP 設定が決めます。",
  "profiles.tools.unlimited":
    "何もチェックしなければ制限なしです。ただし、プラットフォームがサポートする組み込みツールのカタログ（{catalog}）の範囲内です。",
  "profiles.tools.unlimitedBase":
    "これ以上チェックしなければ、ベースのプロファイル {base} がブロックしていないツールをすべて使います。その範囲はプラットフォームがサポートする組み込みツールのカタログ内です。",
  "profiles.tools.providerNote":
    "provider 側のツールはモデル提供元で動くため、外部接続 proxy では止められません。最初のバージョンはこれらをブロックした状態で始まります。",
  "profiles.tools.boundary.local": "worker 内",
  "profiles.tools.boundary.egress": "外部接続",
  "profiles.tools.boundary.provider": "provider 側",
  "profiles.tools.new": "新しいツール",
  "profiles.tools.fixed": "ベースのプロファイルがブロックしているツールです。",
  "profiles.tools.diff.legend": "カタログの違い",
  "profiles.tools.diff.text":
    "{id} になかったツールはブロックした状態で始まります。開くには受け入れにチェックし、上の一覧でチェックを外します。",
  "profiles.tools.diff.accept": "{tool} の実行を受け入れる",
  "profiles.tools.diff.stillBlocked": "今はブロックされています。",
  "profiles.tools.diff.opens": "このバージョンで動きます。",
  "profiles.tools.diff.removed": "サポートが終わったツール:",
  "profiles.tools.unaccepted":
    "前のバージョンになかったツール {tools} を開くには、受け入れにチェックするか、もう一度ブロックしてください。",
  "profiles.tools.asked":
    "前のバージョンが扱っていなかったツールを開こうとしています。下のカタログの違いで受け入れるか、もう一度ブロックしてください。",
  "profiles.tools.noCatalog":
    "ランタイムバージョン {version} にはサポートするカタログがないため、ブロックリストを保存できません。サポートするバージョン: {versions}",
  "profiles.tools.noCatalogs":
    "このインストールにはサポートするカタログがないため、ブロックリストを保存できません。",
  "profiles.tools.baseNoCatalog":
    "ベースのプロファイルのランタイムバージョンにはサポートするカタログがないため、このプロファイルをブロックリストとして保存できません。",
  "profiles.tools.error.mcpTool":
    "MCP ツールはプロファイルでブロックできません。組み込みツールだけを選んでください。",
  "profiles.tools.error.toolPattern":
    "パターンは受け付けません。組み込みツールの名前を一つ選んでください。",
  "profiles.tools.error.unknownTool":
    "このランタイムバージョンのサポートするカタログにないツールがあります。一覧を読み込み直してください。",
  "profiles.tools.error.noToolCatalog":
    "このランタイムバージョンにはサポートするカタログがないため、ブロックリストを保存できません。",
  "profiles.tools.error.baseDenies":
    "ベースのプロファイルがブロックしたツールは開けません。一覧を読み込み直してください。",
  "profiles.tools.blocked": "ブロックしたツール",
  "profiles.tools.running": "実行するツール",
  "profiles.tools.noneBlocked": "ブロックなし",
  "profiles.tools.allowList":
    "このバージョンのランタイムバージョンにはサポートするカタログがありません。ツール一覧（許可リスト）だけで決めたバージョンなので、コンソールでは読むだけです。",
  "profiles.tools.blockedNew":
    "このバージョンでブロックされた新しいツール {count} 個",
  "profiles.tools.blockedNewText":
    "このバージョンがブロックするかを決めたことのないツールなので動きません: {tools}。開くには、サポートするカタログ {catalog} で新しいバージョンを作って受け入れます。",
  "profiles.tools.makeVersion": "新しいバージョンを作る",
  "profiles.column.blocked": "ブロック",
  "profiles.blockedCount": "{count} 個",
};
