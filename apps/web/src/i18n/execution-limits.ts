/**
 * Settings > Workspace > Execution limits: the installation owner's limits,
 * once environment variables of the control host.
 */
export const executionLimitsKo = {
  "limits.nav": "실행 한도",
  "limits.title": "실행 한도",
  "limits.description":
    "이 설치의 모든 워크스페이스에 적용되는 실행 한도입니다. 전에는 서버 환경 변수로 정하던 값입니다.",
  "limits.defaultApplies": "저장한 값이 없어 기본값({value})을 씁니다.",
  "limits.defaultIs": "기본값은 {value}입니다.",
  "limits.blocked":
    "쓸 수 있는 값이 없습니다. 업그레이드 때 환경 변수 {env}의 값이 범위를 벗어나 옮겨 오지 못했거나, 저장된 값이 이 버전의 범위를 벗어났습니다. 값을 저장할 때까지 {refused} 환경 변수가 남아 있으면 저장한 뒤 지우세요.",
  "limits.blockedSaved":
    "쓸 수 있는 값이 없습니다. 저장된 값이 이 버전의 범위를 벗어났습니다. 값을 저장할 때까지 {refused}",
  "limits.useDefault": "기본값으로",
  "limits.save": "저장",
  "limits.section.title": "한도",
  "limits.section.description":
    "바꾼 값만 한 번에 저장합니다. 하나라도 거절되면 아무 값도 바뀌지 않습니다.",
  "limits.pending": "저장하지 않은 한도 {count}개",
  "limits.clean": "저장하지 않은 변경이 없습니다.",
  "limits.savedMany": "한도 {count}개를 저장했습니다.",
  "limits.notSaved":
    "저장하지 못했습니다. 표시한 칸을 고친 뒤 다시 저장하세요. 다른 칸의 값도 아직 저장되지 않았습니다.",
  "limits.wait.title": "사람 응답",
  "limits.wait.hint":
    "세션이 권한을 묻거나 질문을 하면 사람이 답할 때까지 기다립니다.",
  "limits.wait.detail":
    "이 시간 안에 답이 없으면 요청을 닫습니다. 기다리는 시간도 턴 시간에 들어가므로, 턴 시간 상한보다 오래 기다리지는 않습니다.",
  "limits.wait.label": "응답 대기 시간 (초)",
  "limits.wait.unit": "초",
  "limits.wait.value": "{value}초",
  "limits.wait.refused": "세션의 권한 요청과 질문을 받지 않습니다.",
  "limits.wait.applies":
    "저장하면 바로 다음 요청부터 적용됩니다. 이미 기다리는 요청은 처음 받은 시간을 그대로 씁니다.",
  "limits.wait.invalid": "1부터 {max}까지의 정수(초)를 적으세요.",
  "limits.wait.saved": "응답 대기 시간을 저장했습니다.",
  "limits.turn.title": "턴 시간",
  "limits.turn.hint": "턴 하나가 승인 대기를 포함해 돌 수 있는 시간입니다.",
  "limits.turn.detail": "넘으면 그 턴을 멈춥니다.",
  "limits.turn.label": "턴 시간 상한 (초)",
  "limits.turn.unit": "초",
  "limits.turn.value": "{value}초",
  "limits.turn.refused":
    "새 작업자를 띄우지 않습니다. 이미 값을 받은 작업자는 그 값으로 계속 돕니다.",
  "limits.turn.applies":
    "저장하면 그 뒤에 띄우는 작업자부터 적용됩니다. 쉬고 있는 작업자는 바로 내리고, 턴을 돌고 있는 작업자는 그 턴을 받을 때의 값으로 마친 뒤 내립니다. 세션은 다음에 작업자를 받을 때 새 값을 씁니다.",
  "limits.turn.invalid": "1부터 {max}까지의 정수(초)를 적으세요.",
  "limits.turn.saved": "턴 시간 상한을 저장했습니다.",
  "limits.retries.title": "모델 요청 재시도",
  "limits.retries.hint":
    "모델 공급자 요청이 실패했을 때 턴을 실패로 끝내기 전에 다시 보내는 횟수입니다.",
  "limits.retries.detail": "0이면 다시 보내지 않습니다.",
  "limits.retries.label": "재시도 횟수",
  "limits.retries.unit": "회",
  "limits.retries.value": "{value}회",
  "limits.retries.refused":
    "새 작업자를 띄우지 않습니다. 이미 값을 받은 작업자는 그 값으로 계속 돕니다.",
  "limits.retries.applies":
    "저장하면 그 뒤에 띄우는 작업자부터 적용됩니다. 쉬고 있는 작업자는 바로 내리고, 턴을 돌고 있는 작업자는 그 턴을 받을 때의 값으로 마친 뒤 내립니다. 세션은 다음에 작업자를 받을 때 새 값을 씁니다.",
  "limits.retries.invalid": "0부터 {max}까지의 정수를 적으세요.",
  "limits.retries.saved": "재시도 횟수를 저장했습니다.",
  "limits.cost.title": "세션 비용",
  "limits.cost.hint": "세션 하나가 쓸 수 있는 모델 비용입니다.",
  "limits.cost.detail":
    "닿으면 그 세션에 더 맡기지 않고, 대기 중인 메시지와 다시 시작도 돌지 않습니다.",
  "limits.cost.label": "세션 비용 한도 (USD)",
  "limits.cost.unit": "USD",
  "limits.cost.value": "{value} USD",
  "limits.cost.refused":
    "새 세션과 메시지를 받지 않고, 세션을 띄우지 않으며, 실행 중인 세션의 다음 모델 호출을 막습니다.",
  "limits.cost.applies":
    "저장하면 10초 안에 적용됩니다. 내린 한도는 실행 중인 세션의 다음 모델 호출부터 막고, 올린 한도는 그 세션이 다음에 작업자를 받을 때 닿습니다.",
  "limits.cost.invalid": "0보다 크고 {max} 이하인 금액(USD)을 적으세요.",
  "limits.cost.saved": "세션 비용 한도를 저장했습니다.",
  "limits.tokens.title": "세션 토큰",
  "limits.tokens.hint": "세션 하나가 쓰는 동안 쓸 수 있는 모델 토큰 수입니다.",
  "limits.tokens.detail": "0이면 토큰 한도 없이 비용 한도만 봅니다.",
  "limits.tokens.label": "세션 토큰 한도",
  "limits.tokens.unit": "토큰",
  "limits.tokens.value": "{value} 토큰",
  "limits.tokens.none": "한도 없음(0)",
  "limits.tokens.refused":
    "새 세션과 메시지를 받지 않고, 세션을 띄우지 않으며, 실행 중인 세션의 다음 모델 호출을 막습니다.",
  "limits.tokens.applies":
    "저장하면 10초 안에 적용됩니다. 내린 한도는 실행 중인 세션의 다음 모델 호출부터 막고, 올린 한도는 그 세션이 다음에 작업자를 받을 때 닿습니다.",
  "limits.tokens.invalid":
    "0부터 {max}까지의 정수를 적으세요. 0이면 토큰 한도가 없습니다.",
  "limits.tokens.saved": "세션 토큰 한도를 저장했습니다.",
  "limits.unknownTokens.title": "단가 미상 토큰",
  "limits.unknownTokens.hint":
    "세션 하나가 단가 미상 호출에 쓸 수 있는 토큰 수입니다. 무제한 지출을 막는 장치입니다.",
  "limits.unknownTokens.detail":
    "요청한 모델이나 답한 모델의 단가를 정하지 못한 호출은 단가 미상으로 표시하고 비용을 가장 높은 단가로 셉니다. 실제 단가는 더 높을 수 있어서 비용과 따로 토큰 수로 막습니다. 끌 수 없습니다.",
  "limits.unknownTokens.label": "단가 미상 토큰 한도",
  "limits.unknownTokens.unit": "토큰",
  "limits.unknownTokens.value": "{value} 토큰",
  "limits.unknownTokens.refused": "세션의 모델 호출을 모두 막습니다.",
  "limits.unknownTokens.applies":
    "저장하면 10초 안에 적용됩니다. 한도에 닿은 세션은 다음 모델 호출이 거절됩니다. 단가 미상 호출이 없는 세션에는 닿지 않습니다.",
  "limits.unknownTokens.invalid":
    "1부터 {max}까지의 정수를 적으세요. 0으로 끌 수 없습니다.",
  "limits.unknownTokens.saved": "단가 미상 토큰 한도를 저장했습니다.",
  "limits.queue.title": "대기 메시지",
  "limits.queue.hint":
    "세션 하나에 차례를 기다리며 쌓일 수 있는 메시지 수입니다.",
  "limits.queue.detail": "넘으면 그 세션의 다음 메시지를 받지 않습니다.",
  "limits.queue.label": "세션당 대기 메시지 수",
  "limits.queue.unit": "개",
  "limits.queue.value": "{value}개",
  "limits.queue.refused": "새 세션과 메시지를 받지 않습니다.",
  "limits.queue.applies":
    "저장하면 10초 안에 다음 메시지부터 적용됩니다. 이미 쌓인 메시지는 그대로 둡니다.",
  "limits.queue.invalid": "1부터 {max}까지의 정수를 적으세요.",
  "limits.queue.saved": "대기 메시지 수를 저장했습니다.",
  "limits.storage.title": "입력 보관",
  "limits.storage.hint": "이 설치 전체에 보관하는 입력 메시지의 합입니다.",
  "limits.storage.detail": "넘으면 새 메시지를 받지 않습니다.",
  "limits.storage.label": "입력 보관 한도 (바이트)",
  "limits.storage.unit": "바이트",
  "limits.storage.value": "{value}바이트",
  "limits.storage.refused": "새 세션과 메시지를 받지 않습니다.",
  "limits.storage.applies":
    "저장하면 10초 안에 다음 메시지부터 적용됩니다. 이미 보관한 입력은 지우지 않습니다.",
  "limits.storage.invalid": "1부터 {max}까지의 정수(바이트)를 적으세요.",
  "limits.storage.saved": "입력 보관 한도를 저장했습니다.",
  "limits.stopped.title": "멈춘 세션의 작업 공간",
  "limits.stopped.hint":
    "멈춘 세션의 작업 공간(Docker 볼륨, Kubernetes PVC)을 남겨 두는 시간입니다.",
  "limits.stopped.detail":
    "지나면 작업 공간을 회수하고, 그 뒤 다시 시작하면 체크포인트에서 복원합니다. 0이면 다음 정리 때 바로 회수합니다.",
  "limits.stopped.label": "멈춘 뒤 남겨 두는 시간 (초)",
  "limits.stopped.unit": "초",
  "limits.stopped.value": "{value}초",
  "limits.stopped.refused":
    "멈춘 세션과 일시 정지한 세션의 작업 공간을 회수하지 않습니다. 끝난 세션의 작업 공간은 계속 회수합니다.",
  "limits.stopped.applies":
    "저장하면 10초 안에 다음 정리부터 적용됩니다. 줄이면 이미 그 시간을 넘긴 작업 공간을 다음 정리 때 회수합니다.",
  "limits.stopped.invalid": "0부터 {max}까지의 정수(초)를 적으세요.",
  "limits.stopped.saved": "멈춘 세션의 작업 공간 보존 시간을 저장했습니다.",
  "limits.paused.title": "일시 정지한 세션의 작업 공간",
  "limits.paused.hint":
    "일시 정지한 세션의 작업 공간을 일시 정지한 때부터 남겨 두는 시간입니다.",
  "limits.paused.detail":
    "복원할 체크포인트가 있는 세션만 지나면 회수하고, 다시 시작하면 그 체크포인트에서 복원합니다. 0이면 다음 정리 때 바로 회수합니다.",
  "limits.paused.label": "일시 정지한 뒤 남겨 두는 시간 (초)",
  "limits.paused.unit": "초",
  "limits.paused.value": "{value}초",
  "limits.paused.refused":
    "멈춘 세션과 일시 정지한 세션의 작업 공간을 회수하지 않습니다. 끝난 세션의 작업 공간은 계속 회수합니다.",
  "limits.paused.applies":
    "저장하면 10초 안에 다음 정리부터 적용됩니다. 줄이면 이미 그 시간을 넘긴 작업 공간을 다음 정리 때 회수합니다.",
  "limits.paused.invalid": "0부터 {max}까지의 정수(초)를 적으세요.",
  "limits.paused.saved":
    "일시 정지한 세션의 작업 공간 보존 시간을 저장했습니다.",
  "limits.enforce.title": "작업 공간 용량",
  "limits.enforce.hint": "작업자의 작업 공간이 용량을 넘었을 때 할 일입니다.",
  "limits.enforce.label": "용량을 넘으면",
  "limits.enforce.warn": "기록만 남김",
  "limits.enforce.fail": "턴을 멈춤",
  "limits.enforce.off": "재지 않음",
  "limits.enforce.options":
    "기록만 남김: 넘은 것을 로그에 남기고 턴은 계속합니다. 턴을 멈춤: 넘은 턴을 멈춥니다. 재지 않음: 용량을 보지 않습니다.",
  "limits.enforce.refused":
    "작업자가 세션을 받지 않아 세션이 시작되지 않습니다.",
  "limits.enforce.applies":
    "저장하면 그 뒤에 세션을 받는 작업자부터 적용됩니다. 이미 돌고 있는 작업자는 받을 때의 값을 씁니다.",
  "limits.enforce.saved": "작업 공간 용량 설정을 저장했습니다.",
  "limits.archive.title": "세션 기록 보관",
  "limits.archive.hint":
    "오래 쉰 세션의 이벤트를 데이터베이스에서 오브젝트 스토리지로 옮겨 보관합니다.",
  "limits.archive.detail":
    "옮긴 이벤트는 운영자가 복원 명령으로 되돌립니다. 보관 작업은 운영자가 정한 일정(기본 매주)에 돌고, 작업을 끈 설치에서는 이 값을 쓰지 않습니다.",
  "limits.archive.daysLabel": "보관까지 쉰 기간 (일)",
  "limits.archive.daysUnit": "일",
  "limits.archive.daysValue": "{value}일",
  "limits.archive.off": "보관하지 않음(0)",
  "limits.archive.daysInvalid":
    "0(보관하지 않음) 또는 {min}부터 {max}까지의 정수(일)를 적으세요.",
  "limits.archive.modeLabel": "보관 작업이 할 일",
  "limits.archive.count": "세기만 함",
  "limits.archive.move": "실제로 옮김",
  "limits.archive.options":
    "세기만 함: 옮길 세션·이벤트·바이트 수만 로그에 남기고 아무것도 바꾸지 않습니다. 실제로 옮김: 이벤트를 오브젝트 스토리지로 옮기고 데이터베이스에서 지웁니다.",
  "limits.archive.refused": "보관 작업이 아무것도 옮기지 않고 실패로 끝납니다.",
  "limits.archive.applies": "저장하면 다음 보관 실행부터 적용됩니다.",
  "limits.archive.saved": "세션 기록 보관 설정을 저장했습니다.",
  "limits.archive.unavailable.object_store_disabled":
    "API의 오브젝트 스토리지 설정으로 보면 이 설치는 세션 기록을 보관하지 않습니다. 오브젝트 스토리지가 꺼져 있습니다(CHECKPOINT_OBJECT_STORE=disabled). 값은 저장해 둘 수 있고, 보관할 수 있게 된 뒤의 실행부터 씁니다.",
  "limits.archive.unavailable.unversioned":
    "API의 오브젝트 스토리지 설정으로 보면 이 설치는 세션 기록을 보관하지 않습니다. 오브젝트 스토리지가 버전을 잠그지 않아 옮긴 기록을 지켜 둘 수 없습니다(CHECKPOINT_OBJECT_PROTECTION=unversioned). 값은 저장해 둘 수 있고, 보관할 수 있게 된 뒤의 실행부터 씁니다.",
};

export const executionLimitsEn: Record<keyof typeof executionLimitsKo, string> =
  {
    "limits.nav": "Execution limits",
    "limits.title": "Execution limits",
    "limits.description":
      "These limits apply to every workspace of this installation. They used to be set with server environment variables.",
    "limits.defaultApplies":
      "Nothing is saved, so the default of {value} applies.",
    "limits.defaultIs": "The default is {value}.",
    "limits.blocked":
      "No usable value. At the upgrade, the environment variable {env} was out of range and was not carried in, or the saved value is out of this version's range. Until a value is saved, {refused} If the variable is still set, remove it after saving.",
    "limits.blockedSaved":
      "No usable value. The saved value is out of this version's range. Until a value is saved, {refused}",
    "limits.useDefault": "Use the default",
    "limits.save": "Save",
    "limits.section.title": "Limits",
    "limits.section.description":
      "Saving sends only the changed values, all at once. If any is refused, nothing changes.",
    "limits.pending": "Unsaved limits: {count}",
    "limits.clean": "No unsaved changes.",
    "limits.savedMany": "Saved {count} limits.",
    "limits.notSaved":
      "Nothing was saved. Fix the marked fields and save again; the other fields are not saved yet either.",
    "limits.wait.title": "Human answers",
    "limits.wait.hint":
      "When a session asks for a permission or a question, it waits for a person to answer.",
    "limits.wait.detail":
      "With no answer within this long, the request closes. The wait counts toward the turn's time, so it never outlasts the turn time limit.",
    "limits.wait.label": "Wait for an answer (seconds)",
    "limits.wait.unit": "seconds",
    "limits.wait.value": "{value} seconds",
    "limits.wait.refused": "sessions cannot ask for permissions or questions.",
    "limits.wait.applies":
      "A save applies from the next request on. A request already waiting keeps the wait it was given.",
    "limits.wait.invalid": "Enter a whole number of seconds from 1 to {max}.",
    "limits.wait.saved": "Saved the wait for an answer.",
    "limits.turn.title": "Turn time",
    "limits.turn.hint": "How long one turn may run, approvals included.",
    "limits.turn.detail": "Past it, the turn is stopped.",
    "limits.turn.label": "Turn time limit (seconds)",
    "limits.turn.unit": "seconds",
    "limits.turn.value": "{value} seconds",
    "limits.turn.refused":
      "no new worker starts; a worker already given a value keeps running on it.",
    "limits.turn.applies":
      "A save applies to workers started after it. An idle worker is stopped at once; one in a turn finishes that turn under the value it took it with, then stops. The session takes the new value with its next worker.",
    "limits.turn.invalid": "Enter a whole number of seconds from 1 to {max}.",
    "limits.turn.saved": "Saved the turn time limit.",
    "limits.retries.title": "Model request retries",
    "limits.retries.hint":
      "How many times a failed model provider request is sent again before the turn fails.",
    "limits.retries.detail": "With 0 it is not sent again.",
    "limits.retries.label": "Retries",
    "limits.retries.unit": "retries",
    "limits.retries.value": "{value} retries",
    "limits.retries.refused":
      "no new worker starts; a worker already given a value keeps running on it.",
    "limits.retries.applies":
      "A save applies to workers started after it. An idle worker is stopped at once; one in a turn finishes that turn under the value it took it with, then stops. The session takes the new value with its next worker.",
    "limits.retries.invalid": "Enter a whole number from 0 to {max}.",
    "limits.retries.saved": "Saved the retries.",
    "limits.cost.title": "Session cost",
    "limits.cost.hint": "The model cost one session may spend.",
    "limits.cost.detail":
      "Once it is reached, the session is given nothing further, and its queued messages and resumes do not run.",
    "limits.cost.label": "Session cost limit (USD)",
    "limits.cost.unit": "USD",
    "limits.cost.value": "{value} USD",
    "limits.cost.refused":
      "no session or message is taken, no session launches, and a running session's next model call is stopped.",
    "limits.cost.applies":
      "A save applies within 10 seconds. A lowered limit stops a running session's next model call; a raised one reaches it the next time it gets a worker.",
    "limits.cost.invalid": "Enter an amount in USD above 0 and at most {max}.",
    "limits.cost.saved": "Saved the session cost limit.",
    "limits.tokens.title": "Session tokens",
    "limits.tokens.hint": "The model tokens one session may use over its life.",
    "limits.tokens.detail":
      "With 0 there is no token limit, only the cost limit.",
    "limits.tokens.label": "Session token limit",
    "limits.tokens.unit": "tokens",
    "limits.tokens.value": "{value} tokens",
    "limits.tokens.none": "no limit (0)",
    "limits.tokens.refused":
      "no session or message is taken, no session launches, and a running session's next model call is stopped.",
    "limits.tokens.applies":
      "A save applies within 10 seconds. A lowered limit stops a running session's next model call; a raised one reaches it the next time it gets a worker.",
    "limits.tokens.invalid":
      "Enter a whole number from 0 to {max}. With 0 there is no token limit.",
    "limits.tokens.saved": "Saved the session token limit.",
    "limits.unknownTokens.title": "Tokens of unknown price",
    "limits.unknownTokens.hint":
      "The tokens one session may use on calls of unknown price. It keeps spend from running without a limit.",
    "limits.unknownTokens.detail":
      "A call whose requested or answering model cannot be priced is marked as of unknown price and counted at the highest known rate. Its real price may be higher, so tokens are limited apart from cost. It cannot be turned off.",
    "limits.unknownTokens.label": "Limit on tokens of unknown price",
    "limits.unknownTokens.unit": "tokens",
    "limits.unknownTokens.value": "{value} tokens",
    "limits.unknownTokens.refused":
      "every model call of every session is stopped.",
    "limits.unknownTokens.applies":
      "A save applies within 10 seconds. A session at the limit has its next model call refused. A session with no call of unknown price is not affected.",
    "limits.unknownTokens.invalid":
      "Enter a whole number from 1 to {max}. It cannot be 0.",
    "limits.unknownTokens.saved": "Saved the limit on tokens of unknown price.",
    "limits.queue.title": "Waiting messages",
    "limits.queue.hint":
      "How many messages may wait their turn in one session.",
    "limits.queue.detail":
      "Past that, the session's next message is not taken.",
    "limits.queue.label": "Waiting messages per session",
    "limits.queue.unit": "messages",
    "limits.queue.value": "{value} messages",
    "limits.queue.refused": "no session or message is taken.",
    "limits.queue.applies":
      "A save applies within 10 seconds, from the next message on. Messages already waiting stay.",
    "limits.queue.invalid": "Enter a whole number from 1 to {max}.",
    "limits.queue.saved": "Saved the waiting messages limit.",
    "limits.storage.title": "Kept input",
    "limits.storage.hint": "All the input messages this installation keeps.",
    "limits.storage.detail": "Past that, no new message is taken.",
    "limits.storage.label": "Kept input limit (bytes)",
    "limits.storage.unit": "bytes",
    "limits.storage.value": "{value} bytes",
    "limits.storage.refused": "no session or message is taken.",
    "limits.storage.applies":
      "A save applies within 10 seconds, from the next message on. Input already kept is not removed.",
    "limits.storage.invalid": "Enter a whole number of bytes from 1 to {max}.",
    "limits.storage.saved": "Saved the kept input limit.",
    "limits.stopped.title": "Stopped sessions' workspaces",
    "limits.stopped.hint":
      "How long a stopped session keeps its workspace (Docker volume, Kubernetes PVC).",
    "limits.stopped.detail":
      "Past it the scheduler reclaims it, and a later resume restores from the checkpoint. With 0 it is reclaimed at the next cleanup.",
    "limits.stopped.label": "Keep after stopping (seconds)",
    "limits.stopped.unit": "seconds",
    "limits.stopped.value": "{value} seconds",
    "limits.stopped.refused":
      "no stopped or paused session's workspace is reclaimed; finished sessions' workspaces still are.",
    "limits.stopped.applies":
      "A save applies within 10 seconds, from the next cleanup on. A shorter time reclaims workspaces already past it at the next cleanup.",
    "limits.stopped.invalid":
      "Enter a whole number of seconds from 0 to {max}.",
    "limits.stopped.saved": "Saved how long stopped sessions keep workspaces.",
    "limits.paused.title": "Paused sessions' workspaces",
    "limits.paused.hint":
      "How long a paused session keeps its workspace, from when it paused.",
    "limits.paused.detail":
      "Only a session with a checkpoint to restore is reclaimed past it, and a resume restores that checkpoint. With 0 it is reclaimed at the next cleanup.",
    "limits.paused.label": "Keep after pausing (seconds)",
    "limits.paused.unit": "seconds",
    "limits.paused.value": "{value} seconds",
    "limits.paused.refused":
      "no stopped or paused session's workspace is reclaimed; finished sessions' workspaces still are.",
    "limits.paused.applies":
      "A save applies within 10 seconds, from the next cleanup on. A shorter time reclaims workspaces already past it at the next cleanup.",
    "limits.paused.invalid": "Enter a whole number of seconds from 0 to {max}.",
    "limits.paused.saved": "Saved how long paused sessions keep workspaces.",
    "limits.enforce.title": "Workspace size",
    "limits.enforce.hint":
      "What to do when a worker's workspace outgrows its quota.",
    "limits.enforce.label": "When it is outgrown",
    "limits.enforce.warn": "Log only",
    "limits.enforce.fail": "Stop the turn",
    "limits.enforce.off": "Do not measure",
    "limits.enforce.options":
      "Log only: the overrun is logged and the turn goes on. Stop the turn: the turn that outgrew it stops. Do not measure: the size is not watched.",
    "limits.enforce.refused": "workers take no session, so no session starts.",
    "limits.enforce.applies":
      "A save applies to workers that take a session after it. A worker already running keeps the value it was given.",
    "limits.enforce.saved": "Saved the workspace size setting.",
    "limits.archive.title": "Session event archive",
    "limits.archive.hint":
      "Moves the events of long-idle sessions out of the database into archive objects in the object store.",
    "limits.archive.detail":
      "An operator puts moved events back with the restore command. The archive job runs on the operator's schedule (weekly by default); an installation that turned the job off does not use these values.",
    "limits.archive.daysLabel": "Idle before archiving (days)",
    "limits.archive.daysUnit": "days",
    "limits.archive.daysValue": "{value} days",
    "limits.archive.off": "no archiving (0)",
    "limits.archive.daysInvalid":
      "Enter 0 (no archiving) or a whole number of days from {min} to {max}.",
    "limits.archive.modeLabel": "What the archive job does",
    "limits.archive.count": "Count only",
    "limits.archive.move": "Move the events",
    "limits.archive.options":
      "Count only: logs how many sessions, events and bytes it would move, and changes nothing. Move the events: moves them into archive objects and deletes them from the database.",
    "limits.archive.refused": "the archive job moves nothing and fails.",
    "limits.archive.applies": "A save applies from the next archive run on.",
    "limits.archive.saved": "Saved the session event archive settings.",
    "limits.archive.unavailable.object_store_disabled":
      "By the API's object store settings, this installation does not archive session events: the object store is off (CHECKPOINT_OBJECT_STORE=disabled). The values can still be saved, and apply from the first run after archiving becomes possible.",
    "limits.archive.unavailable.unversioned":
      "By the API's object store settings, this installation does not archive session events: the object store does not lock versions, so moved events could not be kept safe (CHECKPOINT_OBJECT_PROTECTION=unversioned). The values can still be saved, and apply from the first run after archiving becomes possible.",
  };

export const executionLimitsJa: Record<keyof typeof executionLimitsKo, string> =
  {
    "limits.nav": "実行の上限",
    "limits.title": "実行の上限",
    "limits.description":
      "このインストールのすべてのワークスペースに適用される実行の上限です。以前は control host の環境変数で決めていた値です。",
    "limits.defaultApplies":
      "保存した値がないため、既定 ({value}) を使います。",
    "limits.defaultIs": "既定は {value} です。",
    "limits.blocked":
      "使える値がありません。アップグレード時に環境変数 {env} の値が範囲外で移せなかったか、保存された値がこのバージョンの範囲外です。値を保存するまで、{refused} 環境変数が残っていれば、保存したあと削除してください。",
    "limits.blockedSaved":
      "使える値がありません。保存された値がこのバージョンの範囲外です。値を保存するまで、{refused}",
    "limits.useDefault": "既定に戻す",
    "limits.save": "保存",
    "limits.section.title": "上限",
    "limits.section.description":
      "変更した値だけをまとめて保存します。1 つでも拒否されると、どの値も変わりません。",
    "limits.pending": "未保存の上限 {count} 件",
    "limits.clean": "未保存の変更はありません。",
    "limits.savedMany": "上限を {count} 件保存しました。",
    "limits.notSaved":
      "保存できませんでした。示した欄を直してから、もう一度保存してください。ほかの欄の値もまだ保存されていません。",
    "limits.wait.title": "人の応答",
    "limits.wait.hint":
      "セッションが権限を求めたり質問したりすると、人が答えるまで待ちます。",
    "limits.wait.detail":
      "この時間内に答えがなければリクエストを閉じます。待ち時間もターンの時間に含まれるため、ターン時間の上限より長くは待ちません。",
    "limits.wait.label": "応答の待ち時間 (秒)",
    "limits.wait.unit": "秒",
    "limits.wait.value": "{value} 秒",
    "limits.wait.refused": "セッションの権限リクエストと質問を受け付けません。",
    "limits.wait.applies":
      "保存すると次のリクエストから適用されます。すでに待っているリクエストは最初に受けた時間のままです。",
    "limits.wait.invalid": "1 から {max} までの整数 (秒) を入力してください。",
    "limits.wait.saved": "応答の待ち時間を保存しました。",
    "limits.turn.title": "ターンの時間",
    "limits.turn.hint": "1 つのターンが承認待ちを含めて動ける時間です。",
    "limits.turn.detail": "超えるとそのターンを止めます。",
    "limits.turn.label": "ターンの時間上限 (秒)",
    "limits.turn.unit": "秒",
    "limits.turn.value": "{value} 秒",
    "limits.turn.refused":
      "新しい worker を起動しません。すでに値を受けた worker はその値で動き続けます。",
    "limits.turn.applies":
      "保存すると、そのあとに起動する worker から適用されます。待機中の worker はすぐに止め、ターン中の worker はそのターンを受けたときの値で終えてから止めます。セッションは次に worker を受けるときに新しい値を使います。",
    "limits.turn.invalid": "1 から {max} までの整数 (秒) を入力してください。",
    "limits.turn.saved": "ターンの時間上限を保存しました。",
    "limits.retries.title": "モデル呼び出しの再試行",
    "limits.retries.hint":
      "モデルプロバイダーへのリクエストが失敗したとき、ターンを失敗にする前に送り直す回数です。",
    "limits.retries.detail": "0 なら送り直しません。",
    "limits.retries.label": "再試行の回数",
    "limits.retries.unit": "回",
    "limits.retries.value": "{value} 回",
    "limits.retries.refused":
      "新しい worker を起動しません。すでに値を受けた worker はその値で動き続けます。",
    "limits.retries.applies":
      "保存すると、そのあとに起動する worker から適用されます。待機中の worker はすぐに止め、ターン中の worker はそのターンを受けたときの値で終えてから止めます。セッションは次に worker を受けるときに新しい値を使います。",
    "limits.retries.invalid": "0 から {max} までの整数を入力してください。",
    "limits.retries.saved": "再試行の回数を保存しました。",
    "limits.cost.title": "セッションの費用",
    "limits.cost.hint": "1 つのセッションが使えるモデルの費用です。",
    "limits.cost.detail":
      "達するとそのセッションにはそれ以上任せず、待機中のメッセージと再開も動きません。",
    "limits.cost.label": "セッションの費用上限 (USD)",
    "limits.cost.unit": "USD",
    "limits.cost.value": "{value} USD",
    "limits.cost.refused":
      "新しいセッションとメッセージを受け付けず、セッションを起動せず、実行中のセッションの次のモデル呼び出しを止めます。",
    "limits.cost.applies":
      "保存すると 10 秒以内に適用されます。下げた上限は実行中のセッションの次のモデル呼び出しから止め、上げた上限はそのセッションが次に worker を受けるときに届きます。",
    "limits.cost.invalid":
      "0 より大きく {max} 以下の金額 (USD) を入力してください。",
    "limits.cost.saved": "セッションの費用上限を保存しました。",
    "limits.tokens.title": "セッションのトークン",
    "limits.tokens.hint": "1 つのセッションが使えるモデルのトークン数です。",
    "limits.tokens.detail":
      "0 ならトークンの上限はなく、費用の上限だけを見ます。",
    "limits.tokens.label": "セッションのトークン上限",
    "limits.tokens.unit": "トークン",
    "limits.tokens.value": "{value} トークン",
    "limits.tokens.none": "上限なし (0)",
    "limits.tokens.refused":
      "新しいセッションとメッセージを受け付けず、セッションを起動せず、実行中のセッションの次のモデル呼び出しを止めます。",
    "limits.tokens.applies":
      "保存すると 10 秒以内に適用されます。下げた上限は実行中のセッションの次のモデル呼び出しから止め、上げた上限はそのセッションが次に worker を受けるときに届きます。",
    "limits.tokens.invalid":
      "0 から {max} までの整数を入力してください。0 ならトークンの上限はありません。",
    "limits.tokens.saved": "セッションのトークン上限を保存しました。",
    "limits.unknownTokens.title": "単価不明のトークン",
    "limits.unknownTokens.hint":
      "1 つのセッションが単価不明の呼び出しに使えるトークン数です。無制限の支出を防ぐための仕組みです。",
    "limits.unknownTokens.detail":
      "要求したモデルか応答したモデルの単価を決められない呼び出しは、単価不明として記録し、費用を最高単価で数えます。実際の単価はそれより高い場合があるため、費用とは別にトークン数で止めます。無効にはできません。",
    "limits.unknownTokens.label": "単価不明トークンの上限",
    "limits.unknownTokens.unit": "トークン",
    "limits.unknownTokens.value": "{value} トークン",
    "limits.unknownTokens.refused":
      "セッションのモデル呼び出しをすべて止めます。",
    "limits.unknownTokens.applies":
      "保存すると 10 秒以内に適用されます。上限に達したセッションは次のモデル呼び出しが拒否されます。単価不明の呼び出しがないセッションには影響しません。",
    "limits.unknownTokens.invalid":
      "1 から {max} までの整数を入力してください。0 にはできません。",
    "limits.unknownTokens.saved": "単価不明トークンの上限を保存しました。",
    "limits.queue.title": "待機メッセージ",
    "limits.queue.hint": "1 つのセッションで順番を待てるメッセージの数です。",
    "limits.queue.detail":
      "超えると、そのセッションの次のメッセージを受け付けません。",
    "limits.queue.label": "セッションごとの待機メッセージ数",
    "limits.queue.unit": "件",
    "limits.queue.value": "{value} 件",
    "limits.queue.refused": "新しいセッションとメッセージを受け付けません。",
    "limits.queue.applies":
      "保存すると 10 秒以内に次のメッセージから適用されます。すでに待っているメッセージはそのままです。",
    "limits.queue.invalid": "1 から {max} までの整数を入力してください。",
    "limits.queue.saved": "待機メッセージ数を保存しました。",
    "limits.storage.title": "入力の保管",
    "limits.storage.hint":
      "このインストール全体で保管する入力メッセージの合計です。",
    "limits.storage.detail": "超えると新しいメッセージを受け付けません。",
    "limits.storage.label": "入力の保管上限 (バイト)",
    "limits.storage.unit": "バイト",
    "limits.storage.value": "{value} バイト",
    "limits.storage.refused": "新しいセッションとメッセージを受け付けません。",
    "limits.storage.applies":
      "保存すると 10 秒以内に次のメッセージから適用されます。すでに保管した入力は削除しません。",
    "limits.storage.invalid":
      "1 から {max} までの整数 (バイト) を入力してください。",
    "limits.storage.saved": "入力の保管上限を保存しました。",
    "limits.stopped.title": "停止したセッションの作業領域",
    "limits.stopped.hint":
      "停止したセッションの作業領域 (Docker volume、Kubernetes PVC) を残しておく時間です。",
    "limits.stopped.detail":
      "過ぎると scheduler が回収し、そのあと再開すると checkpoint から復元します。0 なら次の整理ですぐに回収します。",
    "limits.stopped.label": "停止後に残す時間 (秒)",
    "limits.stopped.unit": "秒",
    "limits.stopped.value": "{value} 秒",
    "limits.stopped.refused":
      "停止したセッションと一時停止したセッションの作業領域を回収しません。終了したセッションの作業領域は回収し続けます。",
    "limits.stopped.applies":
      "保存すると 10 秒以内に次の整理から適用されます。短くすると、すでにその時間を過ぎた作業領域を次の整理で回収します。",
    "limits.stopped.invalid":
      "0 から {max} までの整数 (秒) を入力してください。",
    "limits.stopped.saved":
      "停止したセッションの作業領域を残す時間を保存しました。",
    "limits.paused.title": "一時停止したセッションの作業領域",
    "limits.paused.hint":
      "一時停止したセッションの作業領域を、一時停止したときから残しておく時間です。",
    "limits.paused.detail":
      "復元できる checkpoint があるセッションだけが過ぎると回収され、再開するとその checkpoint から復元します。0 なら次の整理ですぐに回収します。",
    "limits.paused.label": "一時停止後に残す時間 (秒)",
    "limits.paused.unit": "秒",
    "limits.paused.value": "{value} 秒",
    "limits.paused.refused":
      "停止したセッションと一時停止したセッションの作業領域を回収しません。終了したセッションの作業領域は回収し続けます。",
    "limits.paused.applies":
      "保存すると 10 秒以内に次の整理から適用されます。短くすると、すでにその時間を過ぎた作業領域を次の整理で回収します。",
    "limits.paused.invalid":
      "0 から {max} までの整数 (秒) を入力してください。",
    "limits.paused.saved":
      "一時停止したセッションの作業領域を残す時間を保存しました。",
    "limits.enforce.title": "作業領域の容量",
    "limits.enforce.hint": "worker の作業領域が容量を超えたときの動作です。",
    "limits.enforce.label": "容量を超えたら",
    "limits.enforce.warn": "記録だけ",
    "limits.enforce.fail": "ターンを止める",
    "limits.enforce.off": "測らない",
    "limits.enforce.options":
      "記録だけ: 超えたことをログに残し、ターンは続けます。ターンを止める: 超えたターンを止めます。測らない: 容量を見ません。",
    "limits.enforce.refused":
      "worker がセッションを受けないため、セッションが始まりません。",
    "limits.enforce.applies":
      "保存すると、そのあとにセッションを受ける worker から適用されます。すでに動いている worker は受けたときの値を使います。",
    "limits.enforce.saved": "作業領域の容量の設定を保存しました。",
    "limits.archive.title": "セッション記録の保管",
    "limits.archive.hint":
      "長く使われていないセッションのイベントを、データベースから object store の保管 object に移します。",
    "limits.archive.detail":
      "移したイベントは運用者が restore コマンドで戻します。保管ジョブは運用者が決めた予定 (既定は毎週) で動き、ジョブを止めたインストールではこの値を使いません。",
    "limits.archive.daysLabel": "保管までの未使用期間 (日)",
    "limits.archive.daysUnit": "日",
    "limits.archive.daysValue": "{value} 日",
    "limits.archive.off": "保管しない (0)",
    "limits.archive.daysInvalid":
      "0 (保管しない) か、{min} から {max} までの整数 (日) を入力してください。",
    "limits.archive.modeLabel": "保管ジョブの動作",
    "limits.archive.count": "数えるだけ",
    "limits.archive.move": "実際に移す",
    "limits.archive.options":
      "数えるだけ: 移すセッション・イベント・バイトの数をログに残すだけで、何も変えません。実際に移す: イベントを保管 object に移し、データベースから削除します。",
    "limits.archive.refused": "保管ジョブは何も移さず、失敗で終わります。",
    "limits.archive.applies": "保存すると次の保管の実行から適用されます。",
    "limits.archive.saved": "セッション記録の保管の設定を保存しました。",
    "limits.archive.unavailable.object_store_disabled":
      "API の object store の設定から見ると、このインストールはセッション記録を保管しません。object store が無効です (CHECKPOINT_OBJECT_STORE=disabled)。値は保存しておけ、保管できるようになったあとの実行から使います。",
    "limits.archive.unavailable.unversioned":
      "API の object store の設定から見ると、このインストールはセッション記録を保管しません。object store がバージョンをロックしないため、移した記録を守れません (CHECKPOINT_OBJECT_PROTECTION=unversioned)。値は保存しておけ、保管できるようになったあとの実行から使います。",
  };
