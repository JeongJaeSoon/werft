# syntax=docker/dockerfile:1.7
# Control-host image (94S-117): one executable, three roles —
# `apps/control-host/src/main.ts api|scheduler|reconciler` — none of them
# with the Agent SDK or the Claude Code executable.
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

FROM ${BUN_IMAGE} AS runtime
# git: the checkpoint verifier fetches each workspace bundle into a scratch
# repository (94S-228); without the executable every checkpoint finalize
# fails with ENOENT and no pointer ever advances. The smoke test checks it.
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
WORKDIR /app
COPY --from=pruned --chown=1000:1000 /app /app
COPY --from=web --chown=1000:1000 /app/apps/web/dist /app/apps/web/dist
# The corresponding source of every Debian package in this image (94S-375);
# see apps/worker/Dockerfile.
RUN --mount=type=bind,source=scripts/third-party-notices.ts,target=/tmp/third-party-notices.ts \
  bun /tmp/third-party-notices.ts --debian-sources >DEBIAN_SOURCES.md
USER 1000:1000
ENV NODE_ENV=production
ENV WEB_DIST_DIR=/app/apps/web/dist
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
# Other roles: `bun run apps/control-host/src/main.ts <scheduler|reconciler>`
# runs that role's pass loop (compose's services); add `--once` for one pass.
CMD ["bun", "run", "apps/control-host/src/main.ts", "api"]

# The local stack's image (scripts/local.sh, the e2e and kind stacks): the
# published image plus what they run from it: testkit's fake git host and
# mock IdPs, and the demo-account CLIs, which DEMO_ACCOUNTS=local gates. Never
# published; demo-data.ts imports demo-accounts.ts, so they travel together.
FROM runtime AS local
COPY --from=deps --chown=1000:1000 /app/packages/testkit /app/packages/testkit
COPY --from=deps --chown=1000:1000 /app/apps/control-host/src/api/demo-accounts.ts /app/apps/control-host/src/api/demo-data.ts /app/apps/control-host/src/api/

# The last stage is the default target, and the one images.yml builds
# (`target: release`): a stage added above never becomes the published image.
FROM runtime AS release
