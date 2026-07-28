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

RUN apk add --no-cache \
      bash jq \
      docker-cli docker-cli-compose \
      rsync openssh-client \
      ca-certificates

COPY --from=build /out ./

ENV NODE_ENV=production
EXPOSE 9876
CMD ["node", "dist/index.js"]
