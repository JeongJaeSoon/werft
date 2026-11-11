# syntax=docker/dockerfile:1.7
# Egress proxy image: the only route off every worker network, so
# it ships as a released, digest-pinned image like the other apps instead of
# a source tree mounted into a stock Bun image. Built from the
# repository root (`docker build -f apps/egress-proxy/Dockerfile .`).
#
# Base pinned by the multi-arch index digest of oven/bun:1.3.14; see
# apps/worker/Dockerfile for why and tests/images.test.ts for the check.
ARG BUN_IMAGE=oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4

# One stage and no `bun install`: the proxy imports nothing but Bun and its
# own files. tests/images.test.ts fails once apps/egress-proxy/package.json
# gains a dependency; that is when this grows the deps stage the other apps
# have.
FROM ${BUN_IMAGE} AS runtime
# Debian's security fixes: see APT_UPGRADE_KEY in apps/worker/Dockerfile.
ARG APT_UPGRADE_KEY=
RUN apt-get update --error-on=any \
  && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y --with-new-pkgs \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Owned by root and only readable by the proxy's user, so a compromised
# proxy cannot rewrite the code the next start runs.
COPY apps/egress-proxy/package.json ./
# The licenses of what this image ships: the Bun base.
COPY THIRD_PARTY_NOTICES.md ./
COPY apps/egress-proxy/src ./src
# The corresponding source of every Debian package in this image;
# see apps/worker/Dockerfile.
RUN --mount=type=bind,source=scripts/third-party-notices.ts,target=/tmp/third-party-notices.ts \
  bun /tmp/third-party-notices.ts --debian-sources >DEBIAN_SOURCES.md
USER 1000:1000
ENV NODE_ENV=production
EXPOSE 3128
CMD ["bun", "run", "src/main.ts"]

# The last stage is the default target, and the one images.yml builds
# (`target: release`). The proxy ships only src/ minus .dockerignore's tests.
FROM runtime AS release
