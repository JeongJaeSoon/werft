# 제3자 구성요소 고지

배포 이미지(control-host·worker·egress-proxy)에 들어가는 제3자 구성요소와 그 라이선스다. npm 패키지의 라이선스 전문은 패키지가 싣고 있으면 이미지 안 `/app/node_modules/<패키지>/`에 함께 들어 있다. 싣지 않은 패키지는 아래 "라이선스 파일이 없는 npm 패키지" 절이 전문을 대신 싣는다.

이 파일은 `bun scripts/third-party-notices.ts`가 `bun.lock`에서 만든다. 손으로 고치지 않는다. CI의 `check (static)`이 `--check`로 최신인지 확인한다.

## 베이스 이미지와 OS 패키지

세 이미지 모두 `oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4`(Dockerfile의 `BUN_IMAGE`) 위에 만든다. 이 베이스는 Debian 13(trixie) slim이다. 빌드할 때 `apt-get upgrade`로 Debian 보안 수정을 올리므로 이미지의 Debian 패키지 버전은 베이스 digest의 것보다 새로울 수 있다.

### Bun 1.3.14 (`/usr/local/bin/bun`)

- **라이선스.** Bun 자체는 MIT다. 함께 링크된 라이브러리와 각각의 라이선스는 https://github.com/oven-sh/bun/blob/bun-v1.3.14/LICENSE.md 에 있다. 이미지에는 Oven이 배포한 실행 파일이 수정 없이 들어 있다.
- **빌드.** oven-sh/bun commit `0d9b296af33f2b851fcbf4df3e9ec89751734ba4`(`bun --revision`)이다. images.yml이 빌드한 이미지(linux/amd64, linux/arm64)마다 이 값을 확인한다.
- **LGPL-2.1 구성요소.** Bun은 아래 라이브러리를 정적으로 링크한다. LGPL-2.1 전문은 이미지 안 `/usr/share/common-licenses/LGPL-2.1`에 있다.
  - JavaScriptCore·WebCore(WebKit): https://github.com/oven-sh/WebKit/tree/5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b
  - TinyCC: https://github.com/oven-sh/tinycc/tree/12882eee073cfe5c7621bcfadf679e1372d4537b
- **대응 소스와 재링크.** 이 실행 파일 전체의 소스는 https://github.com/oven-sh/bun/tree/bun-v1.3.14 이다. 위 라이브러리를 고쳐 Bun을 다시 링크하는 절차는 https://github.com/oven-sh/bun/blob/bun-v1.3.14/CONTRIBUTING.md 의 "Building WebKit locally"다. WebKit을 위 commit으로 받아 `bun run build:local`로 빌드한다. LICENSE.md에 적힌 `make jsc`·`zig build`는 옛 절차다.

### Debian 패키지와 대응 소스

- **라이선스.** 각 패키지의 저작권 표시와 라이선스 조건은 이미지 안 `/usr/share/doc/<패키지>/copyright`에 있다. GPL·LGPL·Apache-2.0처럼 여러 패키지가 쓰는 라이선스는 이 파일이 전문 대신 `/usr/share/common-licenses/`의 사본을 가리킨다. images.yml이 빌드한 이미지마다 설치된 모든 패키지에 copyright 파일이 있는지 확인한다.
- **대응 소스.** 이미지마다 `/app/DEBIAN_SOURCES.md`가 설치된 모든 Debian 패키지의 source package 이름과 정확한 버전, 그 소스가 보관된 https://snapshot.debian.org/ 주소를 적는다. GPL·LGPL 패키지도 모두 여기에 들어 있다. 이 목록은 빌드할 때 그 이미지의 dpkg 데이터베이스에서 만든다(`bun scripts/third-party-notices.ts --debian-sources`). images.yml은 빌드한 이미지마다 목록이 실제 설치 상태와 같은지 확인하고, 게시할 때 snapshot.debian.org가 각 소스를 실제로 갖고 있는지 확인한다. 없다고 답한 소스가 있으면 게시하지 않는다. 답을 받지 못한 소스는 main 게시에서 경고로 남고, 릴리스(tag)에서는 게시를 막는다. `apt-get upgrade` 때문에 빌드마다 버전이 달라질 수 있어, 목록은 저장소가 아니라 이미지에 둔다.
- **Dockerfile이 추가로 설치하는 Debian 패키지.** control-host는 ca-certificates(MPL-2.0·GPL-2.0+)·git(GPL-2.0)·tini(MIT), worker는 ca-certificates·git·tini·xfsprogs(GPL-2.0·LGPL-2.1)다. egress-proxy는 추가 패키지가 없다.

### Git LFS 3.8.1 (worker, `/usr/local/bin/git-lfs`)

- **라이선스.** Git LFS 자체는 MIT다. 저작권 표시와 허가문 전문은 이미지 안 `/usr/local/share/doc/git-lfs/LICENSE.md`(https://github.com/git-lfs/git-lfs/blob/v3.8.1/LICENSE.md)에 있다. 이미지의 실행 파일은 worker Dockerfile이 git-lfs 프로젝트의 v3.8.1 소스 릴리스(sha256 고정)에서 Go 1.27.3로 직접 빌드한 것이다. git-lfs 소스는 고치지 않았다. 바꾼 것은 의존 모듈 버전뿐이다: `golang.org/x/net`을 v0.62.0으로, `github.com/klauspost/compress`를 v1.20.2로 올렸고, 그에 따라 `golang.org/x/crypto`·`x/sync`·`x/sys`·`x/text`도 올라갔다(빌드가 go.mod·go.sum을 sha256으로 확인한다).
- **정적으로 링크된 Go 코드.** 이 실행 파일은 Go 표준 라이브러리를 링크한다. 그 BSD-3-Clause 문구도 같은 LICENSE.md에 있다. https://github.com/git-lfs/git-lfs/blob/v3.8.1/go.mod 에 적힌 모듈(위에서 올린 버전 포함)도 링크하며, 각 모듈의 라이선스는 그 모듈의 소스에 있다. 링크한 모듈과 버전은 실행 파일에 기록되어 있어, 이미지 밖의 Go로 `go version -m <실행 파일>`을 실행하면 보인다.
- **대응 소스.** https://github.com/git-lfs/git-lfs/tree/v3.8.1 와 apps/worker/Dockerfile의 `git-lfs` stage(모듈 버전 변경)

### GitHub CLI 2.103.3 (worker, `/usr/local/bin/gh`)

- **라이선스.** GitHub CLI는 MIT다. 저작권 표시와 허가문 전문은 이미지 안 `/usr/local/share/doc/gh/LICENSE`(https://github.com/cli/cli/blob/v2.103.3/LICENSE)에 있다. 이미지의 실행 파일은 cli/cli 프로젝트가 배포한 v2.103.3 linux 릴리스 바이너리(sha256 고정)를 수정 없이 넣은 것이다.
- **정적으로 링크된 Go 코드.** 이 실행 파일은 Go 표준 라이브러리와 https://github.com/cli/cli/blob/v2.103.3/go.mod 에 적힌 모듈을 링크한다. 각 모듈의 라이선스는 그 모듈의 소스에 있다. 링크한 모듈과 버전은 실행 파일에 기록되어 있어, 이미지 밖의 Go로 `go version -m <실행 파일>`을 실행하면 보인다.
- **소스.** https://github.com/cli/cli/tree/v2.103.3

### Claude Code 실행 파일 (worker)

- **권리와 조건.** `@anthropic-ai/claude-agent-sdk@0.3.319`과 그 플랫폼 빌드가 싣는 `claude` 실행 파일은 오픈소스가 아니다. © Anthropic PBC. All rights reserved. 이용 조건은 Anthropic Commercial Terms of Service(https://www.anthropic.com/legal/commercial-terms)와 Claude Code 법률 고지(https://code.claude.com/docs/en/legal-and-compliance)를 따른다.
- **싣는 방식.** Anthropic이 npm에 게시한 실행 파일을 수정하지 않고 그대로 싣는다. musl 빌드만 이미지에서 뺀다.
- **내장 런타임.** 이 실행 파일은 Bun 1.4.4 런타임을 내장한다. 따라서 JavaScriptCore(LGPL-2.1)도 정적으로 링크되어 있다. images.yml이 worker 이미지(linux/amd64, linux/arm64)마다 실행 파일 안의 `Bun v<버전>` 표시로 이 버전을 확인한다.

## 배포 조건이 붙은 구성요소

허용 목록(MIT·Apache-2.0·BSD 계열·ISC 등) 밖의 라이선스다. 각각 스크립트의 `REVIEWED`에 검토 사유가 있다.

- `@anthropic-ai/claude-agent-sdk@0.3.319` (SEE LICENSE IN README.md): Anthropic 독점 소프트웨어다(패키지 LICENSE.md: © Anthropic PBC. All rights reserved). Anthropic Commercial Terms와 Claude Code를 제품에 싣는 조건을 따른다(위 "Claude Code 실행 파일" 절). worker 이미지에만 들어간다.
- `@anthropic-ai/claude-agent-sdk-linux-arm64@0.3.319` (SEE LICENSE IN LICENSE.md): 위 SDK가 싣는 플랫폼별 Claude Code 실행 파일이고, 조건도 같다. 수정하지 않고 그대로 싣는다. musl 빌드는 worker Dockerfile이 지운다.
- `@anthropic-ai/claude-agent-sdk-linux-x64@0.3.319` (SEE LICENSE IN LICENSE.md): 위 SDK가 싣는 플랫폼별 Claude Code 실행 파일이고, 조건도 같다. 수정하지 않고 그대로 싣는다. musl 빌드는 worker Dockerfile이 지운다.

Apache-2.0 패키지가 NOTICE 파일을 싣고 있으면 그 전문을 아래 "NOTICE 전문"에 옮긴다.

## 복사한 소스

`packages/ui`는 Adobe react-spectrum의 React Aria Components starter(Apache-2.0)에서 복사해 고친 파일을 가질 수 있다. npm 패키지가 아니라 저장소 소스라서 아래 표에 나오지 않는다. 복사한 파일 목록, 원본 경로·commit·sha256, 변경 고지는 `packages/ui/NOTICE.md`가, 라이선스 전문은 `packages/ui/LICENSE-APACHE-2.0`이 정본이다. 두 파일은 `@werft-ai/ui` 배포본에도 함께 들어간다.

## npm 패키지 (production closure)

| 패키지 | 버전 | 라이선스 | 이미지 |
|---|---|---|---|
| @anthropic-ai/claude-agent-sdk | 0.3.319 | SEE LICENSE IN README.md | worker |
| @anthropic-ai/claude-agent-sdk-linux-arm64 | 0.3.319 | SEE LICENSE IN LICENSE.md | worker |
| @anthropic-ai/claude-agent-sdk-linux-x64 | 0.3.319 | SEE LICENSE IN LICENSE.md | worker |
| @anthropic-ai/sdk | 0.125.0 | MIT | worker |
| @asteasolutions/zod-to-openapi | 9.1.0 | MIT | control-host |
| @aws-sdk/checksums | 3.1001.0 | Apache-2.0 | control-host, worker |
| @aws-sdk/client-s3 | 3.1131.0 | Apache-2.0 | control-host, worker |
| @aws-sdk/client-secrets-manager | 3.1138.0 | Apache-2.0 | control-host |
| @aws-sdk/core | 3.978.0 | Apache-2.0 | control-host, worker |
| @aws-sdk/core | 3.978.1 | Apache-2.0 | control-host, worker |
| @aws-sdk/credential-provider-env | 3.972.71 | Apache-2.0 | control-host, worker |
| @aws-sdk/credential-provider-env | 3.972.72 | Apache-2.0 | control-host, worker |
| @aws-sdk/credential-provider-http | 3.972.73 | Apache-2.0 | control-host, worker |
| @aws-sdk/credential-provider-http | 3.972.74 | Apache-2.0 | control-host, worker |
| @aws-sdk/credential-provider-ini | 3.973.16 | Apache-2.0 | control-host, worker |
| @aws-sdk/credential-provider-ini | 3.973.17 | Apache-2.0 | control-host, worker |
| @aws-sdk/credential-provider-login | 3.972.78 | Apache-2.0 | control-host, worker |
| @aws-sdk/credential-provider-login | 3.972.79 | Apache-2.0 | control-host, worker |
| @aws-sdk/credential-provider-node | 3.972.83 | Apache-2.0 | control-host, worker |
| @aws-sdk/credential-provider-node | 3.972.84 | Apache-2.0 | control-host, worker |
| @aws-sdk/credential-provider-process | 3.972.71 | Apache-2.0 | control-host, worker |
| @aws-sdk/credential-provider-process | 3.972.72 | Apache-2.0 | control-host, worker |
| @aws-sdk/credential-provider-sso | 3.973.15 | Apache-2.0 | control-host, worker |
| @aws-sdk/credential-provider-sso | 3.973.16 | Apache-2.0 | control-host, worker |
| @aws-sdk/credential-provider-web-identity | 3.972.77 | Apache-2.0 | control-host, worker |
| @aws-sdk/credential-provider-web-identity | 3.972.78 | Apache-2.0 | control-host, worker |
| @aws-sdk/middleware-sdk-s3 | 3.972.76 | Apache-2.0 | control-host, worker |
| @aws-sdk/nested-clients | 3.997.45 | Apache-2.0 | control-host, worker |
| @aws-sdk/nested-clients | 3.997.46 | Apache-2.0 | control-host, worker |
| @aws-sdk/signature-v4-multi-region | 3.996.46 | Apache-2.0 | control-host, worker |
| @aws-sdk/signature-v4-multi-region | 3.996.47 | Apache-2.0 | control-host, worker |
| @aws-sdk/token-providers | 3.1129.0 | Apache-2.0 | control-host, worker |
| @aws-sdk/token-providers | 3.1138.0 | Apache-2.0 | control-host, worker |
| @aws-sdk/types | 3.974.5 | Apache-2.0 | control-host, worker |
| @aws-sdk/types | 3.974.6 | Apache-2.0 | control-host, worker |
| @aws-sdk/xml-builder | 3.972.40 | Apache-2.0 | control-host, worker |
| @aws-sdk/xml-builder | 3.972.41 | Apache-2.0 | control-host, worker |
| @aws/lambda-invoke-store | 0.3.0 | Apache-2.0 | control-host, worker |
| @babel/runtime | 7.29.7 | MIT | worker |
| @electric-sql/pglite | 0.3.10 | Apache-2.0 | control-host |
| @floating-ui/core | 1.8.0 | MIT | control-host |
| @floating-ui/dom | 1.8.0 | MIT | control-host |
| @floating-ui/react-dom | 2.1.9 | MIT | control-host |
| @floating-ui/utils | 0.2.12 | MIT | control-host |
| @hono/node-server | 2.1.1 | MIT | worker |
| @hono/zod-openapi | 1.6.3 | MIT | control-host |
| @hono/zod-validator | 0.9.1 | MIT | control-host |
| @internationalized/date | 3.12.4 | Apache-2.0 | control-host |
| @internationalized/number | 3.6.9 | Apache-2.0 | control-host |
| @internationalized/string | 3.2.10 | Apache-2.0 | control-host |
| @modelcontextprotocol/sdk | 1.32.1 | MIT | worker |
| @octokit/auth-app | 8.3.1 | MIT | control-host |
| @octokit/auth-oauth-app | 9.0.5 | MIT | control-host |
| @octokit/auth-oauth-device | 8.0.5 | MIT | control-host |
| @octokit/auth-oauth-user | 6.0.4 | MIT | control-host |
| @octokit/auth-token | 6.0.0 | MIT | control-host |
| @octokit/core | 7.0.8 | MIT | control-host |
| @octokit/endpoint | 11.0.5 | MIT | control-host |
| @octokit/graphql | 9.0.5 | MIT | control-host |
| @octokit/oauth-authorization-url | 8.0.0 | MIT | control-host |
| @octokit/oauth-methods | 6.0.5 | MIT | control-host |
| @octokit/openapi-types | 28.0.0 | MIT | control-host |
| @octokit/openapi-types | 29.0.1 | MIT | control-host |
| @octokit/plugin-retry | 8.1.1 | MIT | control-host |
| @octokit/plugin-throttling | 11.0.5 | MIT | control-host |
| @octokit/request | 10.0.16 | MIT | control-host |
| @octokit/request-error | 7.1.2 | MIT | control-host |
| @octokit/types | 17.0.0 | MIT | control-host |
| @octokit/types | 18.0.0 | MIT | control-host |
| @opentelemetry/api | 1.9.0 | Apache-2.0 | control-host, worker |
| @opentelemetry/api-logs | 0.223.0 | Apache-2.0 | control-host, worker |
| @opentelemetry/core | 2.12.0 | Apache-2.0 | control-host, worker |
| @opentelemetry/exporter-trace-otlp-proto | 0.223.0 | Apache-2.0 | control-host, worker |
| @opentelemetry/otlp-exporter-base | 0.223.0 | Apache-2.0 | control-host, worker |
| @opentelemetry/otlp-transformer | 0.223.0 | Apache-2.0 | control-host, worker |
| @opentelemetry/resources | 2.12.0 | Apache-2.0 | control-host, worker |
| @opentelemetry/sdk-logs | 0.223.0 | Apache-2.0 | control-host, worker |
| @opentelemetry/sdk-metrics | 2.12.0 | Apache-2.0 | control-host, worker |
| @opentelemetry/sdk-trace | 2.12.0 | Apache-2.0 | control-host, worker |
| @opentelemetry/semantic-conventions | 1.45.0 | Apache-2.0 | control-host, worker |
| @radix-ui/primitive | 1.1.7 | MIT | control-host |
| @radix-ui/react-arrow | 1.1.15 | MIT | control-host |
| @radix-ui/react-checkbox | 1.3.11 | MIT | control-host |
| @radix-ui/react-collection | 1.1.15 | MIT | control-host |
| @radix-ui/react-compose-refs | 1.1.5 | MIT | control-host |
| @radix-ui/react-context | 1.2.2 | MIT | control-host |
| @radix-ui/react-dialog | 1.1.23 | MIT | control-host |
| @radix-ui/react-direction | 1.1.4 | MIT | control-host |
| @radix-ui/react-dismissable-layer | 1.1.19 | MIT | control-host |
| @radix-ui/react-focus-guards | 1.1.6 | MIT | control-host |
| @radix-ui/react-focus-scope | 1.1.16 | MIT | control-host |
| @radix-ui/react-id | 1.1.4 | MIT | control-host |
| @radix-ui/react-popover | 1.1.23 | MIT | control-host |
| @radix-ui/react-popper | 1.3.7 | MIT | control-host |
| @radix-ui/react-portal | 1.1.17 | MIT | control-host |
| @radix-ui/react-presence | 1.1.10 | MIT | control-host |
| @radix-ui/react-primitive | 2.1.10 | MIT | control-host |
| @radix-ui/react-radio-group | 1.4.7 | MIT | control-host |
| @radix-ui/react-roving-focus | 1.1.19 | MIT | control-host |
| @radix-ui/react-slot | 1.3.3 | MIT | control-host |
| @radix-ui/react-switch | 1.3.7 | MIT | control-host |
| @radix-ui/react-tabs | 1.1.21 | MIT | control-host |
| @radix-ui/react-use-callback-ref | 1.1.4 | MIT | control-host |
| @radix-ui/react-use-controllable-state | 1.2.6 | MIT | control-host |
| @radix-ui/react-use-effect-event | 0.0.5 | MIT | control-host |
| @radix-ui/react-use-is-hydrated | 0.1.3 | MIT | control-host |
| @radix-ui/react-use-layout-effect | 1.1.4 | MIT | control-host |
| @radix-ui/react-use-rect | 1.1.4 | MIT | control-host |
| @radix-ui/react-use-size | 1.1.4 | MIT | control-host |
| @radix-ui/rect | 1.1.3 | MIT | control-host |
| @react-types/shared | 3.37.0 | Apache-2.0 | control-host |
| @smithy/core | 3.34.1 | Apache-2.0 | control-host, worker |
| @smithy/core | 3.35.0 | Apache-2.0 | control-host, worker |
| @smithy/credential-provider-imds | 4.5.2 | Apache-2.0 | control-host, worker |
| @smithy/fetch-http-handler | 5.8.0 | Apache-2.0 | control-host, worker |
| @smithy/node-http-handler | 4.12.1 | Apache-2.0 | control-host, worker |
| @smithy/signature-v4 | 5.7.3 | Apache-2.0 | control-host, worker |
| @smithy/types | 4.18.0 | Apache-2.0 | control-host, worker |
| @smithy/types | 4.19.0 | Apache-2.0 | control-host, worker |
| @stablelib/base64 | 1.0.1 | MIT | worker |
| @swc/helpers | 0.5.23 | Apache-2.0 | control-host |
| @types/node | 26.5.1 | MIT | control-host |
| @types/pg | 8.15.5 | MIT | control-host |
| @types/react | 19.3.0 | MIT | control-host |
| @types/react-dom | 19.3.0 | MIT | control-host |
| accepts | 2.0.0 | MIT | worker |
| ajv | 8.20.0 | MIT | worker |
| ajv-formats | 3.0.1 | MIT | worker |
| aria-hidden | 1.2.6 | MIT | control-host |
| before-after-hook | 4.0.0 | Apache-2.0 | control-host |
| body-parser | 2.4.0 | MIT | worker |
| bottleneck | 2.19.5 | MIT | control-host |
| bowser | 2.14.1 | MIT | control-host, worker |
| bun-types | 1.3.14 | MIT | control-host |
| bytes | 3.1.2 | MIT | worker |
| call-bind-apply-helpers | 1.0.2 | MIT | worker |
| call-bound | 1.0.4 | MIT | worker |
| class-variance-authority | 0.7.1 | Apache-2.0 | control-host |
| client-only | 0.0.1 | MIT | control-host |
| clsx | 2.1.1 | MIT | control-host |
| content-disposition | 1.1.0 | MIT | worker |
| content-type | 1.0.5 | MIT | worker |
| content-type | 2.1.0 | MIT | worker |
| content-type | 3.1.1 | MIT | control-host |
| cookie | 0.7.2 | MIT | worker |
| cookie-signature | 1.2.2 | MIT | worker |
| cors | 2.8.6 | MIT | worker |
| cross-spawn | 7.0.6 | MIT | worker |
| csstype | 3.2.3 | MIT | control-host |
| debug | 4.4.3 | MIT | worker |
| depd | 2.0.0 | MIT | worker |
| detect-node-es | 1.1.0 | MIT | control-host |
| drizzle-orm | 0.45.2 | Apache-2.0 | control-host |
| dunder-proto | 1.0.1 | MIT | worker |
| ee-first | 1.1.1 | MIT | worker |
| encodeurl | 2.0.0 | MIT | worker |
| es-define-property | 1.0.1 | MIT | worker |
| es-errors | 1.3.0 | MIT | worker |
| es-object-atoms | 1.1.2 | MIT | worker |
| escape-html | 1.0.3 | MIT | worker |
| etag | 1.8.1 | MIT | worker |
| eventsource | 3.0.7 | MIT | worker |
| eventsource-parser | 3.1.1 | MIT | worker |
| express | 5.2.1 | MIT | worker |
| express-rate-limit | 8.7.0 | MIT | worker |
| fast-deep-equal | 3.1.3 | MIT | worker |
| fast-sha256 | 1.3.0 | Unlicense | worker |
| fast-uri | 3.1.7 | BSD-3-Clause | worker |
| finalhandler | 2.1.1 | MIT | worker |
| forwarded | 0.2.0 | MIT | worker |
| fresh | 2.0.0 | MIT | worker |
| function-bind | 1.1.2 | MIT | worker |
| get-intrinsic | 1.3.0 | MIT | worker |
| get-nonce | 1.0.1 | MIT | control-host |
| get-proto | 1.0.1 | MIT | worker |
| gopd | 1.2.0 | MIT | worker |
| has-symbols | 1.1.0 | MIT | worker |
| hasown | 2.0.4 | MIT | worker |
| hono | 4.13.11 | MIT | control-host, worker |
| hono | 4.13.7 | MIT | worker |
| http-errors | 2.0.1 | MIT | worker |
| iconv-lite | 0.7.3 | MIT | worker |
| inherits | 2.0.4 | ISC | worker |
| ip-address | 10.7.0 | MIT | worker |
| ipaddr.js | 1.9.1 | MIT | worker |
| is-promise | 4.0.0 | MIT | worker |
| isexe | 2.0.0 | ISC | worker |
| jose | 6.2.12 | MIT | worker |
| json-schema-to-ts | 3.1.1 | MIT | worker |
| json-schema-traverse | 1.0.0 | MIT | worker |
| json-schema-typed | 8.0.2 | BSD-2-Clause | worker |
| json-with-bigint | 3.5.12 | MIT | control-host |
| lucide-react | 1.53.0 | ISC | control-host |
| math-intrinsics | 1.1.0 | MIT | worker |
| media-typer | 1.1.1 | MIT | worker |
| merge-descriptors | 2.0.0 | MIT | worker |
| mime-db | 1.54.0 | MIT | worker |
| mime-types | 3.0.2 | MIT | worker |
| ms | 2.1.3 | MIT | worker |
| negotiator | 1.1.0 | MIT | worker |
| object-assign | 4.1.1 | MIT | worker |
| object-inspect | 1.13.4 | MIT | worker |
| on-finished | 2.4.1 | MIT | worker |
| once | 1.4.0 | ISC | worker |
| openapi-fetch | 0.17.0 | MIT | control-host |
| openapi-typescript-helpers | 0.1.0 | MIT | control-host |
| openapi3-ts | 4.6.1 | MIT | control-host |
| parseurl | 1.3.3 | MIT | worker |
| path-key | 3.1.1 | MIT | worker |
| path-to-regexp | 8.4.2 | MIT | worker |
| pg | 8.16.3 | MIT | control-host |
| pg-cloudflare | 1.4.0 | MIT | control-host |
| pg-connection-string | 2.14.0 | MIT | control-host |
| pg-int8 | 1.0.1 | ISC | control-host |
| pg-pool | 3.14.0 | MIT | control-host |
| pg-protocol | 1.16.0 | MIT | control-host |
| pg-types | 2.2.0 | MIT | control-host |
| pgpass | 1.0.5 | MIT | control-host |
| pkce-challenge | 5.0.1 | MIT | worker |
| postgres-array | 2.0.0 | MIT | control-host |
| postgres-bytea | 1.0.1 | MIT | control-host |
| postgres-date | 1.0.7 | MIT | control-host |
| postgres-interval | 1.2.0 | MIT | control-host |
| proxy-addr | 2.0.8 | MIT | worker |
| qs | 6.16.1 | BSD-3-Clause | worker |
| range-parser | 1.3.0 | MIT | worker |
| raw-body | 3.0.2 | MIT | worker |
| react | 19.3.0 | MIT | control-host |
| react-aria | 3.53.1 | Apache-2.0 | control-host |
| react-aria-components | 1.22.1 | Apache-2.0 | control-host |
| react-dom | 19.3.0 | MIT | control-host |
| react-remove-scroll | 2.7.2 | MIT | control-host |
| react-remove-scroll-bar | 2.3.8 | MIT | control-host |
| react-stately | 3.51.0 | Apache-2.0 | control-host |
| react-style-singleton | 2.2.3 | MIT | control-host |
| require-from-string | 2.0.2 | MIT | worker |
| router | 2.2.0 | MIT | worker |
| safer-buffer | 2.1.2 | MIT | worker |
| scheduler | 0.28.0 | MIT | control-host |
| send | 1.2.1 | MIT | worker |
| serve-static | 2.2.1 | MIT | worker |
| setprototypeof | 1.2.0 | ISC | worker |
| shebang-command | 2.0.0 | MIT | worker |
| shebang-regex | 3.0.0 | MIT | worker |
| side-channel | 1.1.1 | MIT | worker |
| side-channel-list | 1.0.1 | MIT | worker |
| side-channel-map | 1.0.1 | MIT | worker |
| side-channel-weakmap | 1.0.2 | MIT | worker |
| split2 | 4.2.0 | ISC | control-host |
| standardwebhooks | 1.1.1 | MIT | worker |
| statuses | 2.0.2 | MIT | worker |
| tailwind-merge | 3.5.0 | MIT | control-host |
| toad-cache | 3.7.4 | MIT | control-host |
| toidentifier | 1.0.1 | MIT | worker |
| ts-algebra | 2.0.0 | MIT | worker |
| tslib | 2.8.1 | 0BSD | control-host, worker |
| type-is | 2.1.0 | MIT | worker |
| undici-types | 8.9.0 | MIT | control-host |
| universal-github-app-jwt | 2.2.2 | MIT | control-host |
| universal-user-agent | 7.0.3 | ISC | control-host |
| unpipe | 1.0.0 | MIT | worker |
| use-callback-ref | 1.3.3 | MIT | control-host |
| use-sidecar | 1.1.3 | MIT | control-host |
| use-sync-external-store | 1.7.0 | MIT | control-host |
| vary | 1.1.2 | MIT | worker |
| which | 2.0.2 | ISC | worker |
| wrappy | 1.0.2 | ISC | worker |
| xtend | 4.0.2 | MIT | control-host |
| yaml | 2.9.1 | ISC | control-host |
| zod | 4.6.7 | MIT | control-host, worker |
| zod-to-json-schema | 3.25.2 | ISC | worker |

## 라이선스 파일이 없는 npm 패키지

아래 패키지는 배포본에 라이선스 파일도 저작권 표시도 싣지 않는다. package.json이 밝힌 라이선스와 author(저작자 표기)·저장소를 적고, 라이선스 전문은 이 절에 대신 싣는다. author는 package.json의 표기일 뿐 확인된 저작권자가 아니다. 실제 저작권 표시는 각 저장소에서 확인해야 한다. images.yml은 이미지의 `/app/node_modules`에서 라이선스 파일이 없는 패키지가 모두 여기에 있는지 확인한다.

- `@aws-sdk/credential-provider-http@3.972.73` (Apache-2.0): AWS SDK for JavaScript Team, https://github.com/aws/aws-sdk-js-v3.git
- `@aws-sdk/credential-provider-http@3.972.74` (Apache-2.0): AWS SDK for JavaScript Team, https://github.com/aws/aws-sdk-js-v3.git
- `@aws-sdk/credential-provider-login@3.972.78` (Apache-2.0): AWS SDK for JavaScript Team, https://github.com/aws/aws-sdk-js-v3.git
- `@aws-sdk/credential-provider-login@3.972.79` (Apache-2.0): AWS SDK for JavaScript Team, https://github.com/aws/aws-sdk-js-v3.git
- `@aws-sdk/nested-clients@3.997.45` (Apache-2.0): AWS SDK for JavaScript Team, https://github.com/aws/aws-sdk-js-v3.git
- `@aws-sdk/nested-clients@3.997.46` (Apache-2.0): AWS SDK for JavaScript Team, https://github.com/aws/aws-sdk-js-v3.git
- `@hono/zod-openapi@1.6.3` (MIT): 저작자 표기 없음, https://github.com/honojs/middleware.git
- `@hono/zod-validator@0.9.1` (MIT): 저작자 표기 없음, https://github.com/honojs/middleware.git
- `bun-types@1.3.14` (MIT): 저작자 표기 없음, https://github.com/oven-sh/bun
- `client-only@0.0.1` (MIT): 저작자 표기 없음
- `drizzle-orm@0.45.2` (Apache-2.0): Drizzle Team, https://github.com/drizzle-team/drizzle-orm.git
- `pg-types@2.2.0` (MIT): Brian M. Carlson, git://github.com/brianc/node-pg-types.git
- `pgpass@1.0.5` (MIT): Hannes Hörl, https://github.com/hoegaarden/pgpass.git
- `react-remove-scroll-bar@2.3.8` (MIT): Anton Korzunov, https://github.com/theKashey/react-remove-scroll-bar
- `standardwebhooks@1.1.1` (MIT): Standard Webhooks, https://github.com/standard-webhooks/standard-webhooks

### MIT 전문

위 MIT 패키지의 허락 조건이다. "<저작권자>"는 각 패키지의 저작권자이며, 위 목록의 author는 그 표기다.

```text
MIT License

Copyright (c) <저작권자>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Apache-2.0 전문

이미지 안 `/usr/share/common-licenses/Apache-2.0`에 있다(Debian base-files). https://www.apache.org/licenses/LICENSE-2.0 과 같은 글이다.

## NOTICE 전문

없음.
