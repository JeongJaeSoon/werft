# syntax=docker/dockerfile:1.7
# Control-host image: one executable, five roles —
# `apps/control-host/src/main.ts api|metrics|scheduler|reconciler|slack` — none
# of them with the Agent SDK or the Claude Code executable.
# Only the scheduler role is given the Docker socket, and it runs as root
# for that (compose `user:`); the image default stays uid 1000. Built from
# the repository root (`docker build -f apps/control-host/Dockerfile .`).
#
# Base pinned by the multi-arch index digest of oven/bun:1.3.14; see
# apps/worker/Dockerfile for why and tests/images.test.ts for the check.
ARG BUN_IMAGE=oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4

FROM ${BUN_IMAGE} AS manifests
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.base.json THIRD_PARTY_NOTICES.md ./
# Keep the workspace layout, but let source-only edits reuse the install layers.
RUN --mount=type=bind,source=apps,target=/src/apps \
    --mount=type=bind,source=packages,target=/src/packages \
  cd /src && find apps packages -name package.json -exec cp --parents '{}' /app/ \;

FROM ${BUN_IMAGE} AS web
WORKDIR /app
COPY --from=manifests /app/ ./
RUN bun install --frozen-lockfile --filter ./apps/web
COPY apps/web ./apps/web
COPY packages ./packages
RUN bun run --cwd apps/web build \
  && test -f apps/web/dist/index.html

FROM ${BUN_IMAGE} AS deps
WORKDIR /app
COPY --from=manifests /app/ ./
# --filter limits the install to the one app this image runs, which is what
# keeps @anthropic-ai/* out of it; the lockfile stays frozen either way.
RUN bun install --frozen-lockfile --production \
    --filter ./apps/control-host \
  && test ! -e node_modules/@anthropic-ai
COPY apps ./apps
COPY packages ./packages
COPY docs/api/index.html docs/api/scalar.js ./docs/api/

# What is published: deps without test sources, testkit and the demo tools
# (scripts/image-prune.sh). `deps` itself stays whole for the `local` target.
FROM deps AS pruned
RUN --mount=type=bind,source=scripts/image-prune.sh,target=/tmp/image-prune.sh \
  sh /tmp/image-prune.sh --delete /app

# gitleaks: the skill gate's secret check runs it as a child process
# (apps/control-host/src/wiring/gitleaks.ts). Built here from upstream's tag
# source rather than taken as its release binary: that one is built with Go
# 1.24.11 and links module versions the image scan fails on (24 fixable High
# or Critical for 8.30.1). The same shape as the git-lfs stage in
# apps/worker/Dockerfile, with its Go and CA pins: the build moves brotli,
# compress, x/text and xz to the GITLEAKS_* versions below; go.mod and go.sum
# must then hash to the pins, which fixes every module the binary links.
# Bumped by hand with GITLEAKS_* in scripts/third-party-notices.ts;
# tests/images.test.ts keeps them equal. On the build platform: Go
# cross-compiles, no emulation.
FROM --platform=$BUILDPLATFORM ${BUN_IMAGE} AS gitleaks
ARG GITLEAKS_VERSION=8.30.1
ARG GITLEAKS_BROTLI=1.2.7
ARG GITLEAKS_COMPRESS=1.20.2
ARG GITLEAKS_X_TEXT=0.39.0
ARG GITLEAKS_XZ=0.5.15
ARG GITLEAKS_GO=1.27.4
ARG BUILDARCH
ARG TARGETARCH
# The release has no source asset: GitHub's archive of the tag (its embedded
# commit is the tag's, 83d9cd684c87d95d656c1458ef04895a7f1cbd8e), and
# codeload, the host behind that URL, as the second route.
RUN --mount=type=bind,source=scripts/fetch-pinned.ts,target=/tmp/fetch-pinned.ts \
  bun /tmp/fetch-pinned.ts \
  https://github.com/gitleaks/gitleaks/archive/refs/tags/v${GITLEAKS_VERSION}.tar.gz \
  e90fb266d75837e75894c778bf594ab8e2787f12dce5a62651f21b893eaf9abb \
  /tmp/gitleaks-src.tar.gz \
  https://codeload.github.com/gitleaks/gitleaks/tar.gz/refs/tags/v${GITLEAKS_VERSION}
ADD --checksum=sha256:7226736c2339719cda28fbf3a54d71aa63bcefe376e98cef00034268dab24840 \
  https://dl.google.com/go/go${GITLEAKS_GO}.linux-amd64.tar.gz \
  /tmp/go-amd64.tar.gz
ADD --checksum=sha256:3392582988a273a87ab5043ee1b2c9c17a2c3c00580bf9326c47a2e0aaaeac92 \
  https://dl.google.com/go/go${GITLEAKS_GO}.linux-arm64.tar.gz \
  /tmp/go-arm64.tar.gz
# CA roots for the module proxy, as in the git-lfs stage.
RUN --mount=type=bind,source=scripts/fetch-pinned.ts,target=/tmp/fetch-pinned.ts \
  bun /tmp/fetch-pinned.ts \
  https://snapshot.debian.org/archive/debian/20250419T084132Z/pool/main/c/ca-certificates/ca-certificates_20250419_all.deb \
  ef590f89563aa4b46c8260d49d1cea0fc1b181d19e8df3782694706adf05c184 \
  /tmp/ca-certificates.deb \
  && dpkg-deb -x /tmp/ca-certificates.deb /tmp/ca-certificates
ENV SSL_CERT_DIR=/tmp/ca-certificates/usr/share/ca-certificates/mozilla
WORKDIR /tmp/gitleaks-src
# GOTOOLCHAIN=local: the go directive x/text raises must not fetch another Go.
# Modules come through proxy.golang.org, checked against sum.golang.org. The
# version flag is upstream's (.goreleaser.yml), so `gitleaks version` reports it.
RUN mkdir /tmp/gitleaks \
  && tar -xzf "/tmp/go-${BUILDARCH}.tar.gz" -C /usr/local \
  && tar -xzf /tmp/gitleaks-src.tar.gz --strip-components=1 \
  && export PATH="/usr/local/go/bin:${PATH}" GOTOOLCHAIN=local \
  && go get "github.com/andybalholm/brotli@v${GITLEAKS_BROTLI}" \
    "github.com/klauspost/compress@v${GITLEAKS_COMPRESS}" \
    "golang.org/x/text@v${GITLEAKS_X_TEXT}" \
    "github.com/ulikunitz/xz@v${GITLEAKS_XZ}" \
  && echo "a13ed4c5bd482e1f8b9c459d304cac2613329f66cc9d464bd5899a3884b1c2c4  go.mod" | sha256sum -c - \
  && echo "34afad49c62791658bbf2343cb8fbaf4d130d1601fd4dc10d1633afb819d3d26  go.sum" | sha256sum -c - \
  && CGO_ENABLED=0 GOOS=linux GOARCH="$TARGETARCH" go build -trimpath \
    -ldflags="-s -w -X github.com/zricethezav/gitleaks/v8/version.Version=${GITLEAKS_VERSION}" \
    -o /tmp/gitleaks/gitleaks . \
  && cp LICENSE /tmp/gitleaks/LICENSE \
  && cp /usr/local/go/LICENSE /tmp/gitleaks/GO-LICENSE \
  && go version -m /tmp/gitleaks/gitleaks >/tmp/gitleaks-buildinfo \
  && if grep -q '=>' /tmp/gitleaks-buildinfo; then echo "replaced module" >&2; exit 1; fi \
  && mods="$(awk '$1 == "dep" { print $2 "@" $3 }' /tmp/gitleaks-buildinfo)" \
  && [ -n "$mods" ] \
  && cache="$(go env GOMODCACHE)" \
  && for mod in $mods; do \
    dir="$cache/$(printf '%s' "$mod" | sed 's/[A-Z]/!\l&/g')"; \
    dest="/tmp/gitleaks/modules/$mod"; \
    { mkdir -p "$dest" \
      && find "$dir" -maxdepth 1 -type f \( -iname 'licen[cs]e*' -o -iname 'copying*' -o -iname 'notice*' \) \
        -exec cp -t "$dest" -- '{}' + \
      && [ -n "$(ls -A "$dest")" ]; } \
      || { echo "no license file in $mod" >&2; exit 1; }; \
  done

FROM ${BUN_IMAGE} AS runtime
# git: the checkpoint verifier fetches each workspace bundle into a scratch
# repository; without the executable every checkpoint finalize fails with ENOENT
# and no pointer ever advances. The smoke test checks it.
# ca-certificates: the approved push runs git over https from this container
# (packages/platform/src/action/change-request/push-executor.ts). --no-install-recommends
# drops it from git, and without it every https push fails at ls-remote.
# tini: see ENTRYPOINT.
# The upgrade: see APT_UPGRADE_KEY in apps/worker/Dockerfile.
ARG APT_UPGRADE_KEY=
RUN apt-get update --error-on=any \
  && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y --with-new-pkgs \
  && apt-get install -y --no-install-recommends ca-certificates git tini \
  && rm -rf /var/lib/apt/lists/*
# The base image ships a non-root `bun` user as 1000:1000; the API runs as it.
RUN test "$(id -u bun)" = 1000
COPY --from=gitleaks --chmod=0755 /tmp/gitleaks/gitleaks /usr/local/bin/gitleaks
COPY --from=gitleaks /tmp/gitleaks/LICENSE /usr/local/share/doc/gitleaks/LICENSE
COPY --from=gitleaks /tmp/gitleaks/GO-LICENSE /usr/local/share/doc/gitleaks/GO-LICENSE
COPY --from=gitleaks /tmp/gitleaks/modules /usr/local/share/doc/gitleaks/modules
WORKDIR /app
COPY --from=pruned --chown=1000:1000 /app /app
COPY --from=web --chown=1000:1000 /app/apps/web/dist /app/apps/web/dist
# The corresponding source of every Debian package in this image;
# see apps/worker/Dockerfile.
RUN --mount=type=bind,source=scripts/third-party-notices.ts,target=/tmp/third-party-notices.ts \
  bun /tmp/third-party-notices.ts --debian-sources >DEBIAN_SOURCES.md
USER 1000:1000
ENV NODE_ENV=production
ENV WEB_DIST_DIR=/app/apps/web/dist
# The Werft version this image is (a release tag or a commit), which the
# built-in `werft` MCP server answers as and pins its docs links to. images.yml
# passes it; a local build leaves it empty (0.0.0-unknown). The docs it
# answers from are apps/docs/content, copied with apps above; the smoke test
# checks they are there.
ARG WERFT_VERSION=
ENV WERFT_VERSION=${WERFT_VERSION}
EXPOSE 3000
# An init as PID 1 wherever the image runs, not only under compose's
# `init: true`: the checkpoint verifier kills a git that outlives its timeout
# by process group, and the helpers that orphans are reparented to PID 1. bun
# never waits for children it did not spawn, so under bun each would stay a
# zombie for the container's life. `-s` makes tini the subreaper too when
# something else (`docker run --init`) already holds PID 1. It also forwards
# SIGTERM, which bun as PID 1 ignored until the stop timeout killed it. The
# base image's entrypoint stays in the chain so `docker run <image> <file>`
# still means `bun <file>`.
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/usr/local/bin/docker-entrypoint.sh"]
# Other roles: `bun run apps/control-host/src/main.ts metrics` serves the
# metrics endpoint; `<scheduler|reconciler|slack>` runs that role's pass loop
# (compose's services); add `--once` for one pass.
CMD ["bun", "run", "apps/control-host/src/main.ts", "api"]

# The local stack's image (scripts/local.sh, the e2e and kind stacks): the
# published image plus what they run from it: testkit's fake git host and
# mock IdPs, and the demo-account CLIs, which DEMO_ACCOUNTS=local gates. Never
# published; demo-data.ts imports demo-accounts.ts, so they travel together.
FROM runtime AS local
COPY --from=deps --chown=1000:1000 /app/packages/testkit /app/packages/testkit
COPY --from=deps --chown=1000:1000 /app/apps/control-host/src/api/demo-accounts.ts /app/apps/control-host/src/api/demo-data.ts /app/apps/control-host/src/api/
# The fake GitHub App's key directory: a compose volume mounted here takes
# this owner, so the fake (uid 1000) can write the key it generates.
USER root
RUN install -d -o 1000 -g 1000 -m 0700 /var/lib/fake-github
USER 1000:1000

# The last stage is the default target, and the one images.yml builds
# (`target: release`): a stage added above never becomes the published image.
FROM runtime AS release
