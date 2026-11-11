# 질문과 권한 요청에 답하기

`src/questions.ts`는 세션이 사람에게 묻는 두 가지(`AskUserQuestion`의 질문, 파일 쓰기 같은 도구의 권한 요청)에 스크립트가 답하는 방법을 보여 준다. 저장소를 정하지 않고 에이전트 릴리스로 세션을 만든다. 공통 준비는 [SDK 샘플](https://jeongjaesoon.github.io/werft/ko/reference/examples/)에 있다.

1. turn 1의 질문에 `waitForTurn`의 `question` handler가 답한다. 질문과 선택지가 예상한 것과 다르면 `undefined`를 돌려 콘솔이나 Slack의 사람에게 남긴다.
2. turn 2의 `Write` 권한 요청을 `permission` handler가 사유와 함께 거절한다. 사유는 모델에게 돌아간다.
3. turn 3의 같은 요청은 handler 없이 기다린다. `requests.list`로 열린 요청을 보고 `answerPending`으로 한 번 답한다. 같은 요청에 다른 답을 보내면 409 `IDEMPOTENCY_CONFLICT`다. 요청 하나에는 답이 하나뿐이고 SDK의 기본 key가 `answer:<request_id>`이기 때문이다.

## key와 실행

개인 key를 `sessions:read`, `sessions:write`, `sessions:approve`, `sessions:control`로 발급한다. 답하려면 `sessions:approve`가 있어야 하고, 에이전트 key에는 줄 수 없다. `WERFT_AGENT_RELEASE_ID`(필수)로 세션을 만들 에이전트 릴리스를 정한다.

```sh
bun examples/sdk-questions/src/questions.ts
```

## 실행 결과

```text
session …: created on general
question req_…: "Which environment should the report cover?" -> staging
answer req_…: accepted
turn 1: completed
permission req_…: deny Write /workspace/notes.txt
answer req_…: accepted
turn 2: completed
open request req_…: permission Write /workspace/notes.txt, expires 2026-10-28T17:13:31.693Z
permission req_…: allow Write /workspace/notes.txt
answer req_…: accepted
answer receipt: answer succeeded
second answer: 409 IDEMPOTENCY_CONFLICT
turn 3: completed
still open: 0
close: receipt succeeded
```

- handler는 보안 경계다. 이 샘플은 질문 문구와 선택지 이름, 도구와 파일 경로가 정확히 맞을 때만 답한다. 권한 요청의 `file_path`는 worker가 작업 디렉터리(`/workspace`) 기준으로 푼 값이 온다.
- `answer ...: accepted`는 답이 저장됐다는 뜻이다. 거절도 `accepted`다. 무엇으로 답했는지는 그 위의 `allow`·`deny` 줄이 보여 준다.
- 요청은 설치의 대기 시간(기본 30분) 안에 답하지 않으면 거절로 끝난다. 그 뒤의 답은 `too_late`(`REQUEST_EXPIRED`)다.

`bun test examples/sdk-questions`가 가짜 API로 세 요청에 보낸 답의 본문과 `answer:<request_id>` key, turn이 실패했을 때의 종료 코드 1을 확인한다.
