# Manager API image.
#
# NOTE: swarm-hls-stream is NOT baked into this image. It is bind-mounted from
# the host at runtime (see manager/docker-compose.yml) at the SAME absolute
# path on both sides. This matters because the api process shells out to
# `docker compose ... up` against compose files inside that tree; the docker
# daemon runs on the host, so any relative volume in those compose files is
# resolved against the host filesystem. Matching paths keeps that consistent.
#
# The swarm-hls-stream packages must therefore be built on the host before
# deploy — the deploy script (deploy/deploy.sh) handles that.

FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable

# Workspace manifests first so the install layer caches when sources change.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY common/package.json ./common/
COPY manager/package.json ./manager/
COPY frontend/package.json ./frontend/

RUN pnpm install --frozen-lockfile --filter @streaming-infra-manager/api...

COPY common ./common
COPY manager ./manager

RUN pnpm --filter @streaming-infra-manager/api... build

# Produces a self-contained tree at /out with prod node_modules + dist.
RUN pnpm deploy --filter=@streaming-infra-manager/api --prod /out

# --- runtime stage ----------------------------------------------------------
FROM node:22-alpine
WORKDIR /app

# git is for manager/scripts/stack-version-build.sh, which clones and updates
# the checkout of every added stack version.
#
# The Compose plugin is pinned. The deploy scripts run docker compose from
# inside this container, so this is the Compose that decides how a container
# is created from an image tag, and the shared image race the deploy guard
# closes was verified against exactly this version (the host's api container
# was read at Compose v5.1.4 on 2026-09-07). An Alpine revision bump of the
# same version is a deliberate edit here, never a silent move.
RUN apk add --no-cache \
      bash jq git \
      docker-cli docker-cli-compose=5.1.4-r1 \
      rsync openssh-client \
      ca-certificates

COPY --from=build /out ./
# Copied explicitly rather than left to what `pnpm deploy` decides to pack: a
# missing build script is a Versions page that fails on its first Add, at
# runtime, on the host.
COPY manager/scripts ./scripts

ENV NODE_ENV=production
EXPOSE 9876
CMD ["node", "dist/index.js"]
