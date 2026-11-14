# This run's worker image with real Node and npm: the shipped image has
# neither, and npm on Bun's node shim fails differently (94S-1233). `base` is
# the run's own worker image, passed by derived-worker.yml.
FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS node

FROM base
USER root
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
  && node --version && npm --version
USER 1000:1000
