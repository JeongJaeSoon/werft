/**
 * Settings > Workspace > Execution limits: the installation owner's limits,
 * once environment variables of the control host.
 */
export const executionLimitsKo = {
  "limits.nav": "실행 한도",
  "limits.title": "실행 한도",
  "limits.description":
    "이 설치의 모든 워크스페이스에 적용되는 실행 한도입니다. 전에는 control host의 환경 변수로 정하던 값입니다.",
  "limits.defaultApplies": "저장한 값이 없어 기본값({value})을 씁니다.",
  "limits.defaultIs": "기본값은 {value}입니다.",
  "limits.blocked":
    "쓸 수 있는 값이 없습니다. 업그레이드 때 환경 변수 {env}의 값이 범위를 벗어나 옮겨 오지 못했거나, 저장된 값이 이 버전의 범위를 벗어났습니다. 값을 저장할 때까지 {refused} 환경 변수가 남아 있으면 저장한 뒤 지우세요.",
  "limits.useDefault": "기본값으로",
  "limits.save": "저장",
  "limits.wait.title": "사람 응답",
  "limits.wait.hint":
    "세션이 권한을 묻거나 질문을 하면 사람이 답할 때까지 기다립니다. 이 시간 안에 답이 없으면 요청을 닫습니다. 기다리는 시간도 턴 시간에 들어가므로, 턴 시간 상한보다 오래 기다리지는 않습니다.",
  "limits.wait.label": "응답 대기 시간 (초)",
  "limits.wait.unit": "초",
  "limits.wait.value": "{value}초",
  "limits.wait.refused": "세션의 권한 요청과 질문을 받지 않습니다.",
  "limits.wait.applies":
    "저장하면 바로 다음 요청부터 적용됩니다. 이미 기다리는 요청은 처음 받은 시간을 그대로 씁니다.",
  "limits.wait.invalid": "1부터 {max}까지의 정수(초)를 적으세요.",
  "limits.wait.saved": "응답 대기 시간을 저장했습니다.",
  "limits.turn.title": "턴 시간",
  "limits.turn.hint":
    "턴 하나가 승인 대기를 포함해 돌 수 있는 시간입니다. 넘으면 그 턴을 멈춥니다.",
  "limits.turn.label": "턴 시간 상한 (초)",
  "limits.turn.unit": "초",
  "limits.turn.value": "{value}초",
  "limits.turn.refused":
    "새 worker를 띄우지 않습니다. 이미 값을 받은 worker는 그 값으로 계속 돕니다.",
  "limits.turn.applies":
    "저장하면 그 뒤에 띄우는 worker부터 적용됩니다. 쉬고 있는 worker는 바로 내리고, 턴을 돌고 있는 worker는 그 턴을 받을 때의 값으로 마친 뒤 내립니다. 세션은 다음에 worker를 받을 때 새 값을 씁니다.",
  "limits.turn.invalid": "1부터 {max}까지의 정수(초)를 적으세요.",
  "limits.turn.saved": "턴 시간 상한을 저장했습니다.",
  "limits.retries.title": "모델 요청 재시도",
  "limits.retries.hint":
    "모델 공급자 요청이 실패했을 때 턴을 실패로 끝내기 전에 다시 보내는 횟수입니다. 0이면 다시 보내지 않습니다.",
  "limits.retries.label": "재시도 횟수",
  "limits.retries.unit": "회",
  "limits.retries.value": "{value}회",
  "limits.retries.refused":
    "새 worker를 띄우지 않습니다. 이미 값을 받은 worker는 그 값으로 계속 돕니다.",
  "limits.retries.applies":
    "저장하면 그 뒤에 띄우는 worker부터 적용됩니다. 쉬고 있는 worker는 바로 내리고, 턴을 돌고 있는 worker는 그 턴을 받을 때의 값으로 마친 뒤 내립니다. 세션은 다음에 worker를 받을 때 새 값을 씁니다.",
  "limits.retries.invalid": "0부터 {max}까지의 정수를 적으세요.",
  "limits.retries.saved": "재시도 횟수를 저장했습니다.",
  "limits.cost.title": "세션 비용",
  "limits.cost.hint":
    "세션 하나가 쓸 수 있는 모델 비용입니다. 닿으면 그 세션에 더 맡기지 않고, 대기 중인 메시지와 다시 시작도 돌지 않습니다.",
  "limits.cost.label": "세션 비용 한도 (USD)",
  "limits.cost.unit": "USD",
  "limits.cost.value": "{value} USD",
  "limits.cost.refused":
    "새 세션과 메시지를 받지 않고, 세션을 띄우지 않으며, 실행 중인 세션의 다음 모델 호출을 막습니다.",
  "limits.cost.applies":
    "저장하면 10초 안에 적용됩니다. 내린 한도는 실행 중인 세션의 다음 모델 호출부터 막고, 올린 한도는 그 세션이 다음에 worker를 받을 때 닿습니다.",
  "limits.cost.invalid": "0보다 크고 {max} 이하인 금액(USD)을 적으세요.",
  "limits.cost.saved": "세션 비용 한도를 저장했습니다.",
  "limits.tokens.title": "세션 토큰",
  "limits.tokens.hint":
    "세션 하나가 쓰는 동안 쓸 수 있는 모델 토큰 수입니다. 0이면 토큰 한도 없이 비용 한도만 봅니다.",
  "limits.tokens.label": "세션 토큰 한도",
  "limits.tokens.unit": "토큰",
  "limits.tokens.value": "{value} 토큰",
  "limits.tokens.none": "한도 없음(0)",
  "limits.tokens.refused":
    "새 세션과 메시지를 받지 않고, 세션을 띄우지 않으며, 실행 중인 세션의 다음 모델 호출을 막습니다.",
  "limits.tokens.applies":
    "저장하면 10초 안에 적용됩니다. 내린 한도는 실행 중인 세션의 다음 모델 호출부터 막고, 올린 한도는 그 세션이 다음에 worker를 받을 때 닿습니다.",
  "limits.tokens.invalid":
    "0부터 {max}까지의 정수를 적으세요. 0이면 토큰 한도가 없습니다.",
  "limits.tokens.saved": "세션 토큰 한도를 저장했습니다.",
  "limits.queue.title": "대기 메시지",
  "limits.queue.hint":
    "세션 하나에 차례를 기다리며 쌓일 수 있는 메시지 수입니다. 넘으면 그 세션의 다음 메시지를 받지 않습니다.",
  "limits.queue.label": "세션당 대기 메시지 수",
  "limits.queue.unit": "개",
  "limits.queue.value": "{value}개",
  "limits.queue.refused": "새 세션과 메시지를 받지 않습니다.",
  "limits.queue.applies":
    "저장하면 10초 안에 다음 메시지부터 적용됩니다. 이미 쌓인 메시지는 그대로 둡니다.",
  "limits.queue.invalid": "1부터 {max}까지의 정수를 적으세요.",
  "limits.queue.saved": "대기 메시지 수를 저장했습니다.",
  "limits.storage.title": "입력 보관",
  "limits.storage.hint":
    "이 설치 전체에 보관하는 입력(메시지와 첨부)의 합입니다. 넘으면 새 메시지를 받지 않습니다.",
  "limits.storage.label": "입력 보관 한도 (바이트)",
  "limits.storage.unit": "바이트",
  "limits.storage.value": "{value}바이트",
  "limits.storage.refused": "새 세션과 메시지를 받지 않습니다.",
  "limits.storage.applies":
    "저장하면 10초 안에 다음 메시지부터 적용됩니다. 이미 보관한 입력은 지우지 않습니다.",
  "limits.storage.invalid": "1부터 {max}까지의 정수(바이트)를 적으세요.",
  "limits.storage.saved": "입력 보관 한도를 저장했습니다.",
  "limits.enforce.title": "작업 공간 용량",
  "limits.enforce.hint": "worker의 작업 공간이 용량을 넘었을 때 할 일입니다.",
  "limits.enforce.label": "용량을 넘으면",
  "limits.enforce.warn": "기록만 남김",
  "limits.enforce.fail": "턴을 멈춤",
  "limits.enforce.off": "재지 않음",
  "limits.enforce.options":
    "기록만 남김: 넘은 것을 로그에 남기고 턴은 계속합니다. 턴을 멈춤: 넘은 턴을 멈춥니다. 재지 않음: 용량을 보지 않습니다.",
  "limits.enforce.refused":
    "worker가 세션을 받지 않아 세션이 시작되지 않습니다.",
  "limits.enforce.applies":
    "저장하면 그 뒤에 세션을 받는 worker부터 적용됩니다. 이미 돌고 있는 worker는 받을 때의 값을 씁니다.",
  "limits.enforce.saved": "작업 공간 용량 설정을 저장했습니다.",
};

export const executionLimitsEn: Record<keyof typeof executionLimitsKo, string> =
  {
    "limits.nav": "Execution limits",
    "limits.title": "Execution limits",
    "limits.description":
      "Limits for every workspace of this installation, once environment variables of the control host.",
    "limits.defaultApplies":
      "Nothing is saved, so the default of {value} applies.",
    "limits.defaultIs": "The default is {value}.",
    "limits.blocked":
      "No usable value. At the upgrade, the environment variable {env} was out of range and was not carried in, or the saved value is out of this version's range. Until a value is saved, {refused} If the variable is still set, remove it after saving.",
    "limits.useDefault": "Use the default",
    "limits.save": "Save",
    "limits.wait.title": "Human answers",
    "limits.wait.hint":
      "When a session asks for a permission or a question, it waits for a person to answer. With no answer within this long, the request closes. The wait counts toward the turn's time, so it never outlasts the turn time limit.",
    "limits.wait.label": "Wait for an answer (seconds)",
    "limits.wait.unit": "seconds",
    "limits.wait.value": "{value} seconds",
    "limits.wait.refused": "sessions cannot ask for permissions or questions.",
    "limits.wait.applies":
      "A save applies from the next request on. A request already waiting keeps the wait it was given.",
    "limits.wait.invalid": "Enter a whole number of seconds from 1 to {max}.",
    "limits.wait.saved": "Saved the wait for an answer.",
    "limits.turn.title": "Turn time",
    "limits.turn.hint":
      "How long one turn may run, approvals included. Past it, the turn is stopped.",
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
      "How many times a failed model provider request is sent again before the turn fails. With 0 it is not sent again.",
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
    "limits.cost.hint":
      "The model cost one session may spend. Once it is reached, the session is given nothing further, and its queued messages and resumes do not run.",
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
    "limits.tokens.hint":
      "The model tokens one session may use over its life. With 0 there is no token limit, only the cost limit.",
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
    "limits.queue.title": "Waiting messages",
    "limits.queue.hint":
      "How many messages may wait their turn in one session. Past that, the session's next message is not taken.",
    "limits.queue.label": "Waiting messages per session",
    "limits.queue.unit": "messages",
    "limits.queue.value": "{value} messages",
    "limits.queue.refused": "no session or message is taken.",
    "limits.queue.applies":
      "A save applies within 10 seconds, from the next message on. Messages already waiting stay.",
    "limits.queue.invalid": "Enter a whole number from 1 to {max}.",
    "limits.queue.saved": "Saved the waiting messages limit.",
    "limits.storage.title": "Kept input",
    "limits.storage.hint":
      "All the input (messages and attachments) this installation keeps. Past that, no new message is taken.",
    "limits.storage.label": "Kept input limit (bytes)",
    "limits.storage.unit": "bytes",
    "limits.storage.value": "{value} bytes",
    "limits.storage.refused": "no session or message is taken.",
    "limits.storage.applies":
      "A save applies within 10 seconds, from the next message on. Input already kept is not removed.",
    "limits.storage.invalid": "Enter a whole number of bytes from 1 to {max}.",
    "limits.storage.saved": "Saved the kept input limit.",
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
    "limits.useDefault": "既定に戻す",
    "limits.save": "保存",
    "limits.wait.title": "人の応答",
    "limits.wait.hint":
      "セッションが権限を求めたり質問したりすると、人が答えるまで待ちます。この時間内に答えがなければリクエストを閉じます。待ち時間もターンの時間に含まれるため、ターン時間の上限より長くは待ちません。",
    "limits.wait.label": "応答の待ち時間 (秒)",
    "limits.wait.unit": "秒",
    "limits.wait.value": "{value} 秒",
    "limits.wait.refused": "セッションの権限リクエストと質問を受け付けません。",
    "limits.wait.applies":
      "保存すると次のリクエストから適用されます。すでに待っているリクエストは最初に受けた時間のままです。",
    "limits.wait.invalid": "1 から {max} までの整数 (秒) を入力してください。",
    "limits.wait.saved": "応答の待ち時間を保存しました。",
    "limits.turn.title": "ターンの時間",
    "limits.turn.hint":
      "1 つのターンが承認待ちを含めて動ける時間です。超えるとそのターンを止めます。",
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
      "モデルプロバイダーへのリクエストが失敗したとき、ターンを失敗にする前に送り直す回数です。0 なら送り直しません。",
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
    "limits.cost.hint":
      "1 つのセッションが使えるモデルの費用です。達するとそのセッションにはそれ以上任せず、待機中のメッセージと再開も動きません。",
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
    "limits.tokens.hint":
      "1 つのセッションが使えるモデルのトークン数です。0 ならトークンの上限はなく、費用の上限だけを見ます。",
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
    "limits.queue.title": "待機メッセージ",
    "limits.queue.hint":
      "1 つのセッションで順番を待てるメッセージの数です。超えると、そのセッションの次のメッセージを受け付けません。",
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
      "このインストール全体で保管する入力 (メッセージと添付) の合計です。超えると新しいメッセージを受け付けません。",
    "limits.storage.label": "入力の保管上限 (バイト)",
    "limits.storage.unit": "バイト",
    "limits.storage.value": "{value} バイト",
    "limits.storage.refused": "新しいセッションとメッセージを受け付けません。",
    "limits.storage.applies":
      "保存すると 10 秒以内に次のメッセージから適用されます。すでに保管した入力は削除しません。",
    "limits.storage.invalid":
      "1 から {max} までの整数 (バイト) を入力してください。",
    "limits.storage.saved": "入力の保管上限を保存しました。",
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
  };
