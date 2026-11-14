/**
 * Settings > Workspace > Execution limits: the installation owner's limits,
 * once environment variables of the API.
 */
export const executionLimitsKo = {
  "limits.nav": "실행 한도",
  "limits.title": "실행 한도",
  "limits.description":
    "이 설치의 모든 워크스페이스에 적용되는 실행 한도입니다. 전에는 API의 환경 변수로 정하던 값입니다.",
  "limits.waitTitle": "사람 응답",
  "limits.waitHint":
    "세션이 권한을 묻거나 질문을 하면 사람이 답할 때까지 기다립니다. 이 시간 안에 답이 없으면 요청을 닫습니다. 기다리는 시간도 턴 시간에 들어가므로, 턴 시간 상한보다 오래 기다리지는 않습니다.",
  "limits.waitLabel": "응답 대기 시간 (초)",
  "limits.seconds": "초",
  "limits.defaultApplies": "저장한 값이 없어 기본값 {seconds}초를 씁니다.",
  "limits.defaultIs": "기본값은 {seconds}초입니다.",
  "limits.waitApplies":
    "저장하면 바로 다음 요청부터 적용됩니다. 이미 기다리는 요청은 처음 받은 시간을 그대로 씁니다.",
  "limits.waitInvalid": "1부터 {max}까지의 정수(초)를 적으세요.",
  "limits.waitSaved": "응답 대기 시간을 저장했습니다.",
  "limits.useDefault": "기본값으로",
  "limits.save": "저장",
};

export const executionLimitsEn: Record<keyof typeof executionLimitsKo, string> =
  {
    "limits.nav": "Execution limits",
    "limits.title": "Execution limits",
    "limits.description":
      "Limits for every workspace of this installation, once environment variables of the API.",
    "limits.waitTitle": "Human answers",
    "limits.waitHint":
      "When a session asks for a permission or a question, it waits for a person to answer. With no answer within this long, the request closes. The wait counts toward the turn's time, so it never outlasts the turn time limit.",
    "limits.waitLabel": "Wait for an answer (seconds)",
    "limits.seconds": "seconds",
    "limits.defaultApplies":
      "Nothing is saved, so the default of {seconds} seconds applies.",
    "limits.defaultIs": "The default is {seconds} seconds.",
    "limits.waitApplies":
      "A save applies from the next request on. A request already waiting keeps the wait it was given.",
    "limits.waitInvalid": "Enter a whole number of seconds from 1 to {max}.",
    "limits.waitSaved": "Saved the wait for an answer.",
    "limits.useDefault": "Use the default",
    "limits.save": "Save",
  };

export const executionLimitsJa: Record<keyof typeof executionLimitsKo, string> =
  {
    "limits.nav": "実行の上限",
    "limits.title": "実行の上限",
    "limits.description":
      "このインストールのすべてのワークスペースに適用される実行の上限です。以前は API の環境変数で決めていた値です。",
    "limits.waitTitle": "人の応答",
    "limits.waitHint":
      "セッションが権限を求めたり質問したりすると、人が答えるまで待ちます。この時間内に答えがなければリクエストを閉じます。待ち時間もターンの時間に含まれるため、ターン時間の上限より長くは待ちません。",
    "limits.waitLabel": "応答の待ち時間 (秒)",
    "limits.seconds": "秒",
    "limits.defaultApplies":
      "保存した値がないため、既定の {seconds} 秒を使います。",
    "limits.defaultIs": "既定は {seconds} 秒です。",
    "limits.waitApplies":
      "保存すると次のリクエストから適用されます。すでに待っているリクエストは最初に受けた時間のままです。",
    "limits.waitInvalid": "1 から {max} までの整数 (秒) を入力してください。",
    "limits.waitSaved": "応答の待ち時間を保存しました。",
    "limits.useDefault": "既定に戻す",
    "limits.save": "保存",
  };
