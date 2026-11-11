# syntax=docker/dockerfile:1.7
# Worker image: Bun runtime + the worker's production closure + the engine
# executables its installed runtimes bundle (@werft-ai/runtime-registry). Built
# from the repository root (`docker build -f apps/worker/Dockerfile .`).
#
# Base pinned by the multi-arch index digest of oven/bun:1.3.14 so amd64 CI
# and arm64 laptops build from one file. tests/images.test.ts keeps the three
# app Dockerfiles on the same digest; bump them together.
#
# The pin fixes Bun, not Debian: oven/bun does not rebuild a released tag, so
# the base's packages age with it. Every shipped stage therefore
# runs `apt-get upgrade`, keyed by APT_UPGRADE_KEY: images.yml passes the UTC
# date, so its layer cache takes each day's security fixes once; a local
# build keeps its cached layer. Two builds of one commit on different days
# can differ in Debian package versions; a release pins what it shipped by
# image digest. `--error-on=any`: a source that failed to fetch would
# otherwise leave its fixes out of a build that still passes. A fix that
# would remove a package stays held back (no full-upgrade in an image) and
# surfaces in images.yml's scan instead.
ARG BUN_IMAGE=oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4

FROM ${BUN_IMAGE} AS deps
WORKDIR /app
# THIRD_PARTY_NOTICES.md: the licenses of what this image ships.
COPY package.json bun.lock bunfig.toml tsconfig.base.json THIRD_PARTY_NOTICES.md ./
COPY apps ./apps
COPY packages ./packages
# --filter limits the install to apps/worker and the workspaces it depends on,
# which keeps the database driver, ORM and the web console's packages out. The lockfile
# carries every SDK platform package; --production keeps the linux ones that
# match this build's arch and drops testkit and the other devDependencies. The
# installed runtimes' image:verify checks each engine executable and drops the
# platform builds the engine will not run (for Claude, the ~200 MB musl twin),
# before this layer is copied into the runtime stage.
#
# WORKER_RUNTIME picks the one engine this image holds (the platform runs one
# engine per worker image). Empty is the registry as checked in; a runtime
# kind copies registry/variants/<kind>.* over package.json and src/index.ts
# first, so the import, the installed closure and image:verify change together.
# An unknown kind fails the build instead of shipping the default engine.
ARG WORKER_RUNTIME=
RUN reg=packages/adapters/runtimes/registry \
  && if [ -n "$WORKER_RUNTIME" ]; then \
       test -f "$reg/variants/$WORKER_RUNTIME.ts" \
         && test -f "$reg/variants/$WORKER_RUNTIME.package.json" \
         || { echo "unknown WORKER_RUNTIME: $WORKER_RUNTIME" >&2; exit 1; }; \
       cp "$reg/variants/$WORKER_RUNTIME.ts" "$reg/src/index.ts"; \
       cp "$reg/variants/$WORKER_RUNTIME.package.json" "$reg/package.json"; \
     fi \
  && bun install --frozen-lockfile --production \
    --filter ./apps/worker \
  && bun run --filter @werft-ai/runtime-registry image:verify

# What is published: deps without test sources, testkit and the demo tools
# (scripts/image-prune.sh).
FROM deps AS pruned
RUN --mount=type=bind,source=scripts/image-prune.sh,target=/tmp/image-prune.sh \
  sh /tmp/image-prune.sh --delete /app

# Git LFS, for a session's LFS objects through the proxy's repository route.
# Built here from upstream's release source rather than taken as its binary or
# Debian's package: both link a golang.org/x/net the image scan fails on,
# and the scan takes no exception for it. The same holds for
# github.com/klauspost/compress 1.19.1 (GO-2026-6865, fixed in 1.20.2). The
# build moves x/net to GIT_LFS_X_NET and compress to GIT_LFS_COMPRESS;
# go.mod and go.sum must then hash to the pins below, which
# fixes every module the binary links. Source, Go toolchain and module set are
# pinned; bumped by hand, since the daily apt upgrade does not reach them.
# The toolchain stays in this stage. THIRD_PARTY_NOTICES names the versions
# (GIT_LFS_* in scripts/third-party-notices.ts; tests/images.test.ts keeps
# them equal). On the build platform: Go cross-compiles, no emulation.
FROM --platform=$BUILDPLATFORM ${BUN_IMAGE} AS git-lfs
ARG GIT_LFS_VERSION=3.8.1
# The commit v3.8.1 tags; `git lfs version` reports it.
ARG GIT_LFS_COMMIT=a662a6dbfedf706cfa9fc7a5b7bcc7ba2e2c8a65
ARG GIT_LFS_X_NET=0.62.0
ARG GIT_LFS_COMPRESS=1.20.2
ARG GIT_LFS_GO=1.27.3
ARG BUILDARCH
ARG TARGETARCH
RUN --mount=type=bind,source=scripts/fetch-pinned.ts,target=/tmp/fetch-pinned.ts \
  bun /tmp/fetch-pinned.ts \
  https://github.com/git-lfs/git-lfs/releases/download/v${GIT_LFS_VERSION}/git-lfs-v${GIT_LFS_VERSION}.tar.gz \
  1939307bef808580f7c8954ede7072889d7e76721f5d6fdc4ab110bf907330ab \
  /tmp/git-lfs-src.tar.gz \
  https://api.github.com/repos/git-lfs/git-lfs/releases/assets/666389036
ADD --checksum=sha256:65efbc80fdc1fa2cd2631cad5b481777a68e8725f34e89f50fc6ac714e379b40 \
  https://dl.google.com/go/go${GIT_LFS_GO}.linux-amd64.tar.gz \
  /tmp/go-amd64.tar.gz
ADD --checksum=sha256:a06e99309dbcbdca1a8ccd2282c3ee146e55930886e26b4f1193269587165f49 \
  https://dl.google.com/go/go${GIT_LFS_GO}.linux-arm64.tar.gz \
  /tmp/go-arm64.tar.gz
# The base has no CA roots; Go needs them to reach the module proxy. Trixie's
# package, pinned to its archive sha256 and unpacked only (no maintainer
# scripts): Go reads every certificate under SSL_CERT_DIR. Not an ADD: that
# has no retry, and snapshot.debian.org has answered with a body of another
# hash for this pin. Bun carries its own roots; fetch-pinned.ts
# retries a wrong body like a failed request and writes only the pinned bytes.
RUN --mount=type=bind,source=scripts/fetch-pinned.ts,target=/tmp/fetch-pinned.ts \
  bun /tmp/fetch-pinned.ts \
  https://snapshot.debian.org/archive/debian/20250419T084132Z/pool/main/c/ca-certificates/ca-certificates_20250419_all.deb \
  ef590f89563aa4b46c8260d49d1cea0fc1b181d19e8df3782694706adf05c184 \
  /tmp/ca-certificates.deb \
  && dpkg-deb -x /tmp/ca-certificates.deb /tmp/ca-certificates
ENV SSL_CERT_DIR=/tmp/ca-certificates/usr/share/ca-certificates/mozilla
WORKDIR /tmp/git-lfs-src
# GOTOOLCHAIN=local: the go directive x/net raises must not fetch another Go.
# Modules come through proxy.golang.org, checked against sum.golang.org.
RUN tar -xzf "/tmp/go-${BUILDARCH}.tar.gz" -C /usr/local \
  && tar -xzf /tmp/git-lfs-src.tar.gz --strip-components=1 \
  && export PATH="/usr/local/go/bin:${PATH}" GOTOOLCHAIN=local \
  && go get "golang.org/x/net@v${GIT_LFS_X_NET}" "github.com/klauspost/compress@v${GIT_LFS_COMPRESS}" \
  && echo "5e9ffd420b23b3a013d9be80d7a11376c7d7a932ac9a13d11ecb2e994ce520fa  go.mod" | sha256sum -c - \
  && echo "654c608e1f9f9e0f9e67d55e5973d5beee8cb4a9be9c542bf0e241fe20ea8173  go.sum" | sha256sum -c - \
  && CGO_ENABLED=0 GOOS=linux GOARCH="$TARGETARCH" go build -trimpath \
    -ldflags="-s -w -X github.com/git-lfs/git-lfs/v3/config.GitCommit=${GIT_LFS_COMMIT}" \
    -o /tmp/git-lfs . \
  && cp LICENSE.md /tmp/git-lfs-LICENSE.md

# Release browser URLs can persistently return an error document. The official
# asset API is an independent route to the exact same SHA-pinned archive.
# GitHub CLI, upstream's release binary pinned by version and per-arch sha256
# (the release's checksums file). Only the binary and its license reach the
# runtime stage. Bumped by hand with GH_VERSION in
# scripts/third-party-notices.ts; tests/images.test.ts keeps them equal.
FROM --platform=$BUILDPLATFORM ${BUN_IMAGE} AS gh
ARG GH_VERSION=2.103.3
ARG TARGETARCH
RUN --mount=type=bind,source=scripts/fetch-pinned.ts,target=/tmp/fetch-pinned.ts \
  bun /tmp/fetch-pinned.ts \
  https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz \
  4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d \
  /tmp/gh-amd64.tar.gz \
  https://api.github.com/repos/cli/cli/releases/assets/679195621
RUN --mount=type=bind,source=scripts/fetch-pinned.ts,target=/tmp/fetch-pinned.ts \
  bun /tmp/fetch-pinned.ts \
  https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_arm64.tar.gz \
  ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63 \
  /tmp/gh-arm64.tar.gz \
  https://api.github.com/repos/cli/cli/releases/assets/679195636
RUN mkdir /tmp/gh \
  && tar -xzf "/tmp/gh-${TARGETARCH}.tar.gz" -C /tmp/gh --strip-components=1 \
    --no-same-owner

FROM ${BUN_IMAGE} AS runtime
# git: workspace checkout, bundles and the tools Claude Code shells out to.
# ca-certificates: the egress proxy tunnels TLS, the worker still verifies it.
# tini: see ENTRYPOINT.
# xfsprogs: not for the worker. The scheduler runs this image once more per
# launch, as a short-lived helper that puts the inode ceiling on the session
# volume (xfs_io, xfs_quota; packages/adapters/execution/local-docker
# workspace-inodes.ts), so the daemon needs no second image for it.
# The upgrade: see ARG APT_UPGRADE_KEY.
ARG APT_UPGRADE_KEY=
RUN apt-get update --error-on=any \
  && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y --with-new-pkgs \
  && apt-get install -y --no-install-recommends ca-certificates git tini xfsprogs \
  && rm -rf /var/lib/apt/lists/*
# The author and committer of Claude's commits when neither the repository nor
# the session sets one; without it git refuses to commit and Claude asks the
# user who they are. System scope, so a `git config` the session
# runs still wins; the worker's own git reads no system config. The include
# comes after them: when the session's repository uses the console's GitHub
# App, the worker writes that App's bot user there (git-trailers.ts), and a
# missing file is skipped.
RUN git config --system user.name Werft \
  && git config --system user.email noreply@werft.invalid \
  && git config --system include.path '~/.werft/git-identity'
# The LFS filter, so a commit stores a tracked file as a pointer. Smudge is
# skipped: a checkout leaves pointers rather than failing when the objects'
# host is not on the proxy's list, and `git lfs pull` fetches them.
COPY --from=git-lfs /tmp/git-lfs /usr/local/bin/git-lfs
COPY --from=git-lfs /tmp/git-lfs-LICENSE.md /usr/local/share/doc/git-lfs/LICENSE.md
RUN git lfs install --system --skip-repo --skip-smudge
# gh carries no credentials, and api.github.com is not on the proxy's
# allowlist by default: GitHub writes stay with the github MCP server.
COPY --from=gh /tmp/gh/bin/gh /usr/local/bin/gh
COPY --from=gh /tmp/gh/LICENSE /usr/local/share/doc/gh/LICENSE
# The session's commit trailers (Co-authored-by, Agent-Session): every client
# hook is one dispatcher that runs the repository's own hook of that name
# too, since core.hooksPath stops git looking in .git/hooks. System scope
# again, so the worker's own git (GIT_CONFIG_NOSYSTEM) runs none of them.
# werft-trailers.sh beside it is the message fix the hook and the platform's
# other commit tools source; git runs no file by that name as a hook.
COPY --chmod=0755 apps/worker/git-hooks/werft-hook /usr/local/share/werft/git-hooks/werft-hook
COPY --chmod=0644 apps/worker/git-hooks/werft-trailers.sh /usr/local/share/werft/git-hooks/werft-trailers.sh
# The attribution repair tool the worker runs at a turn's end (plumbing only;
# it sources werft-trailers.sh from the directory above). Beside the hooks but
# no hook name, so git never runs it.
COPY --chmod=0755 apps/worker/git-hooks/werft-repair-attribution /usr/local/share/werft/git-hooks/werft-repair-attribution
RUN ln -s /usr/local/share/werft/git-hooks/werft-repair-attribution /usr/local/bin/werft-repair-attribution
RUN cd /usr/local/share/werft/git-hooks \
  && for hook in applypatch-msg pre-applypatch post-applypatch pre-commit \
    pre-merge-commit prepare-commit-msg commit-msg post-commit pre-rebase \
    post-checkout post-merge pre-push pre-auto-gc post-rewrite \
    sendemail-validate post-index-change; do ln -s werft-hook "$hook"; done \
  && git config --system core.hooksPath /usr/local/share/werft/git-hooks
# uid/gid 1000 is what LocalDockerBackend runs the container as
# (DEFAULT_WORKER_USER); the base image already owns it as user `bun`, so
# the build asserts that instead of adding a second account. /workspace is
# the mount point of the per-session volume; Docker seeds a fresh volume from
# the image path, so the directory must already exist with the worker's
# ownership (image contract).
RUN test "$(id -u bun)" = 1000 && test "$(id -g bun)" = 1000 \
  && mkdir -p /workspace && chown 1000:1000 /workspace
WORKDIR /app
COPY --from=pruned --chown=1000:1000 /app /app
# Each installed runtime checks its engine and puts it on PATH (for Claude,
# `claude`, resolved the way the runtime does at run time), so the build fails
# if an engine stops shipping for this arch.
RUN bun run --filter @werft-ai/runtime-registry image:verify
# DEBIAN_SOURCES.md: the source package and version of every Debian package
# in this image, with its snapshot.debian.org address, which is how the
# notices meet the GPL's source obligation. Written from this
# image's own dpkg database after the last apt-get, because the upgrade makes
# the versions a property of the build, not of the commit. images.yml fails
# the build when a later step changes the installed packages.
RUN --mount=type=bind,source=scripts/third-party-notices.ts,target=/tmp/third-party-notices.ts \
  bun /tmp/third-party-notices.ts --debian-sources >DEBIAN_SOURCES.md
USER 1000:1000
ENV NODE_ENV=production
VOLUME ["/workspace"]
# An init as PID 1, as in apps/control-host/Dockerfile: a git the workspace code
# kills at its deadline and the tool processes Claude Code leaves behind are
# reparented to PID 1, and bun never reaps children it did not spawn, so
# under bun each stays a zombie for the session's life. tini reaps them and
# forwards the SIGTERM that starts the drain. `-s` keeps it the subreaper
# when something else (`docker run --init`) holds PID 1.
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/usr/local/bin/docker-entrypoint.sh"]
# The scheduler passes bootstrap identity through env (WORKER_EXECUTION_ID,
# WORKER_BOOTSTRAP_NONCE, WORKER_GATEWAY_URL, ...) and may override Cmd.
CMD ["bun", "run", "apps/worker/src/main.ts"]

# The last stage is the default target, and the one images.yml builds
# (`target: release`).
FROM runtime AS release
