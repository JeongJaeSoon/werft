# @werft-ai/sdk

서버와 스크립트에서 API key로 Werft 세션을 다루는 TypeScript SDK다. 세션 생성, 메시지, 이벤트 스트림, 권한 요청 답변, push 요청, close를 감싸고 재시도·Idempotency-Key·turn 대기를 대신 한다. Node 20.3 이상과 Bun에서 돈다. 브라우저에서는 API key가 새므로 막혀 있다.

```sh
npm install @werft-ai/sdk
```

이 명령은 릴리스(dist-tag `latest`)를 설치한다. main push에서 프리릴리스를 자동 게시하지 않는다. 기존 `main` dist-tag는 갱신되지 않으므로 릴리스 버전을 사용한다.

```ts
import { Werft, waitForTurn } from "@werft-ai/sdk";

// WERFT_BASE_URL, WERFT_API_KEY 환경 변수를 읽는다.
const werft = new Werft();
const created = await werft.sessions.create({
  agent_release_id: process.env.WERFT_AGENT_RELEASE_ID!,
  message: "README를 요약해 줘",
});
const turn = await waitForTurn(werft, created.session_id, created.turn_id);
console.log(turn.status);
```

- 사용 안내: [TypeScript SDK](https://jeongjaesoon.github.io/werft/ko/sdk/)
- 유즈케이스별 샘플(세션 목록, 이벤트 스트림, 재시도, 질문·권한 답변, 세션 제어, close, push): [SDK 샘플](https://jeongjaesoon.github.io/werft/ko/reference/examples/)
- HTTP API 규칙: [API 유즈케이스 가이드](https://jeongjaesoon.github.io/werft/ko/reference/api-guide/)

## 라이선스

[Apache License 2.0](LICENSE)이다. npm 배포본에는 저장소의 `packages/client` 코드와 `packages/contracts` 타입이 함께 묶여 들어가며, 배포본 전체가 Apache-2.0이다([NOTICE](NOTICE)). 저장소의 나머지(서버, 웹 콘솔, 그 밖의 패키지)는 PolyForm Small Business 1.0.0을 따르는 source-available 코드다.

## 빌드와 배포 (저장소 안)

`bun run --cwd packages/sdk build:package`가 `packages/sdk/dist`에 배포본을 만든다. ESM 모듈 하나와 d.ts 하나에 `@werft-ai/client`와 `@werft-ai/contracts` 타입을 묶고, 런타임 의존성은 `openapi-fetch`, d.ts가 참조하는 의존성은 `zod`만 남긴다. 소스맵은 넣지 않는다. 저장소의 `package.json`은 계속 `src`를 가리키고 `private`이라 workspace는 이 빌드 없이 돈다.

`bun scripts/sdk-pack-smoke.ts`는 배포본을 `npm pack`한 tarball을 빈 디렉터리에 `npm install`하고, `skipLibCheck` 없이 타입 검사한 뒤, [examples/sdk-approver](https://github.com/JeongJaeSoon/werft/blob/main/examples/sdk-approver/src/session-close.ts) 샘플을 Node로 가짜 API에 대고 돌린다.

배포는 [.github/workflows/sdk-release.yml](https://github.com/JeongJaeSoon/werft/blob/main/.github/workflows/sdk-release.yml)이 한다. UI와 동일하게 버전 태그 push와 수동 실행에서만 돈다. 버전 없는 수동 실행은 빌드·검사·pack까지만 하는 dry run이다. SDK·client·contracts·샘플·consumer 스크립트·lockfile·공통 Bun action·관련 workflow·LICENSE를 바꾼 PR과 main push는 ci.yml의 독립 `sdk-pack-smoke` job으로 같은 consumer 검사를 실행한다.

1. `package.json`의 `version`과 `src/version.ts`의 `SDK_VERSION`을 함께 올려 main에 머지하고, 그 커밋의 main CI가 끝나기를 기다린다.
2. main에서 workflow를 실행한다. `<버전>`은 `package.json`의 값 그대로다.

   ```sh
   gh workflow run sdk-release.yml --repo JeongJaeSoon/werft --ref main -f version=<버전>
   ```

3. `build`가 다음을 모두 확인하고 빌드·검사·pack을 마친다. run의 ref가 main이고, 입력이 패키지 버전과 같고, 커밋이 main에 있고, 그 커밋의 main CI가 성공했고, `sdk-v<버전>` 태그가 없어야 한다. 하나라도 어긋나거나 조회에 실패하면 아무것도 쓰지 않고 멈춘다.
4. `tag`가 그 커밋에 `sdk-v<버전>` 태그를 만든다.
5. `publish`가 `release` environment 승인을 기다린다. 승인하면 `npm publish --provenance --access public`으로 3에서 검사한 tarball을 올린다. 토큰 없이 [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)의 OIDC로 인증한다.

대상 커밋은 실행 시점의 main head다. 그 커밋의 CI가 아직 돌고 있으면 끝난 뒤 다시 실행한다. 태그는 승인 앞에서 만들므로 게시가 실패하거나 승인을 거부해도 태그가 남는다. 다시 시도할 때는 같은 run의 Re-run failed jobs를 쓴다. 새 수동 실행은 태그가 이미 있어 멈춘다. 그 버전을 포기할 때는 사람이 태그를 지우거나 버전을 올린다. tarball artifact 보존은 30일이다. `tests/sdk-release.test.ts`가 이 게이트를 검사한다.

### 태그 push 릴리스

이미 main에 머지됐고 그 커밋의 main CI가 성공한 버전에 `sdk-v<버전>` 태그를 직접 push해도 게시한다. 태그의 버전은 `packages/sdk/package.json`과 같아야 한다. `build`는 main 소속·버전·해당 커밋의 main CI를 확인하고 같은 테스트·빌드·consumer 검사·pack을 실행한다. 이 경로는 이미 태그가 있으므로 `tag`를 생략하고, `publish`가 `release` 승인을 기다린다. 수동 dispatch를 태그 ref로 실행하는 것은 게시 경로가 아니다.

단, `release` environment 정책은 `main` 브랜치와 `v*` 태그만 허용한다. 오너가 필수 승인자를 유지하며 `sdk-v*`를 추가하기 전까지 태그 경로는 빌드·검증까지만 가능하고 게시가 정책에 막힌다. 게시는 위 main dispatch로 한다.

main push는 게시하지 않는다. 이 workflow는 prerelease environment와 `SDK_PRERELEASE` variable을 참조하지 않는다.

### 릴리스 준비

릴리스(`release` environment) 게시 전에 사람이 다음을 준비해 둔다. 둘 중 하나라도 없으면 `publish`가 environment에서 거부되거나 npm 인증 오류로 실패한다.

1. `release` environment는 수동 릴리스용 `main` 브랜치와 required reviewer를 유지한다. `sdk-v*` 허용은 오너가 태그 게시를 결정한 경우에만 추가하며, 함께 tag ruleset으로 태그 생성자를 제한하는 것을 권장한다. 다른 패키지의 태그 패턴은 유지한다. 승인자는 수동 실행의 ref가 `main`이고 입력 버전이 맞는지 직접 확인한다. 태그 게시라면 이벤트가 `push`인지 확인하고, 신뢰할 수 있는 checkout에서 `git fetch origin main` 뒤 `git merge-base --is-ancestor <태그의 커밋 SHA> origin/main` 또는 GitHub compare로 main 소속을 독립 확인한다. 해당 커밋의 main CI 성공과 패키지 버전도 확인한다. 태그의 workflow를 고치면 검증 로그도 임의로 만들 수 있으므로 로그만 승인 근거로 삼지 않는다. environment가 태그 패턴을 허용하면 그 태그 ref에서 workflow를 고친 수동 실행도 정책을 통과할 수 있다. 승인자는 이벤트·ref·커밋을 별도로 확인하고 main 변경 리뷰를 유지한다.
2. npmjs.com의 패키지 설정에 trusted publisher를 등록한다. 값은 GitHub Actions, 저장소 `JeongJaeSoon/werft`, workflow `sdk-release.yml`, environment `release`이고 `Allow npm publish`를 켠다. 값은 대소문자까지 정확히 맞아야 하고, `package.json`의 `repository.url`도 이 저장소와 일치해야 한다. 새 등록은 2일 안에 첫 게시가 성공해야 한다. 그 안에 게시하지 못하면 만료되므로 지우고 다시 만든다. 등록은 고칠 수 없어서 workflow 파일이나 environment, 저장소 이름이 바뀌어도 다시 만든다.
