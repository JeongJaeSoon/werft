# SDK 세션 샘플

`src/session-close.ts`는 FAKE 모델로 세션 생성 → SSE 타임라인 → 메시지 전송 → 권한 요청 답변 → 결과 읽기 → 종료 receipt 확인을 실행하는 작은 CLI다. 새 앱 대신 기존 예제를 확장했다.

## 준비

저장소 루트에서 `bun install --frozen-lockfile`을 실행한다. 이 샘플은 workspace의 `@werft-ai/sdk`(`packages/sdk`)를 쓰고, 루트 `tsconfig.json`이 타입 검사한다. 저장소 밖에서는 [`npm install @werft-ai/sdk`](../../apps/docs/content/docs/getting-started/install.mdx)로 설치하고 같은 파일을 Node 22.18 이상(`node session-close.ts`)이나 Bun으로 돌린다. SDK는 서버나 스크립트에서 사용하고 브라우저에 API key를 넣지 않는다.

이 디렉터리는 SDK와 같이 [Apache License 2.0](../LICENSE)을 따른다.

자신의 격리된 스택을 `scripts/local.sh up --fake-model`로 띄운다. 다른 사람의 스택·포트를 재사용하지 않는다. 실제 모델 key는 필요 없다. 예제 메시지의 `GATE-SPEC`은 FAKE 모델용 대본이므로 실제 모델로 실행하지 않는다.

웹 콘솔에서 에이전트를 만들고 `claude-coding-local` 프로필과 `sample-app` 저장소로 버전을 배포한다. 에이전트 key는 그 에이전트의 `sessions:read`, `sessions:write`, `sessions:control` scope로 발급한다. 같은 workspace에서 세션에 접근 가능한 사용자 key(또는 같은 에이전트의 다른 key)를 `sessions:read`, `sessions:approve` scope로 별도 발급한다. 세션을 시작한 key는 `sessions:approve`를 가져도 그 세션의 요청을 승인하지 못한다.

다음 값을 실행 환경에 설정한다. key를 소스·README·출력에 붙여 넣지 않는다.

| 환경 변수 | 값 |
| --- | --- |
| `WERFT_BASE_URL` | 자기 FAKE 스택의 API URL |
| `WERFT_API_KEY` | 위 에이전트 key |
| `WERFT_AGENT_RELEASE_ID` | 배포의 `sha256:…` ID |
| `WERFT_APPROVER_API_KEY` | 별도 사용자 승인 key |

```sh
bun examples/sdk-approver/src/session-close.ts
```

`POST /v1/sessions`에는 `WERFT_AGENT_RELEASE_ID`(필수)만 대상 정보로 보낸다. 승인자 key를 생략하면 같은 클라이언트로 답하므로 해당 key에 승인 권한이 있어야 한다.

## 실행 결과

첫 turn은 `hello from the SDK`를 반환한다. 다음 turn에서 `Bash`의 정확히 `echo alpha | tee hello.txt` 명령만 허용하며 다른 권한 요청은 거절한다. 승인자 클라이언트가 SSE를 받으며 요청에 답한다.

```text
session …: created, turn 1 queued
  event assistant (turn 1)
turn 1: completed
permission …: allow Bash "echo alpha | tee hello.txt"
answer …: accepted
turn 2: completed
close: receipt succeeded
session …: admission closed, status stopped
message after close: 409 SESSION_CLOSED
```

실제 이벤트 종류와 receipt 결과도 출력한다. turn이 실패하거나 종료 receipt가 실패하면 종료 코드 1이다. API 오류에는 code·message·request ID를 출력한다. 실패한 세션은 자동 삭제하지 않으므로 출력된 session ID로 콘솔에서 상태를 확인한다. 전체 실행 제한은 5분이다.

회귀 테스트는 `bun test examples/sdk-approver`로 실행한다. agent release 전달과 별도 승인자 사용, 세션 종료 후 메시지 거절을 검증한다.
