FROM node:22-alpine AS build
WORKDIR /repo
RUN npm install -g pnpm@9

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

# --- swarm-hls-stream build stage -------------------------------------------
FROM node:22-alpine AS shls-build
WORKDIR /shls

RUN apk add --no-cache python3 make g++ \
 && npm install -g pnpm@9

COPY manager/swarm-hls-stream/package.json manager/swarm-hls-stream/pnpm-workspace.yaml manager/swarm-hls-stream/pnpm-lock.yaml ./
COPY manager/swarm-hls-stream/packages ./packages

RUN pnpm install --frozen-lockfile
RUN pnpm -r build

# --- runtime stage ----------------------------------------------------------
FROM node:22-alpine
WORKDIR /app

RUN apk add --no-cache \
      bash jq \
      docker-cli docker-cli-compose \
      rsync openssh-client \
      ca-certificates

COPY --from=build /out ./

COPY manager/swarm-hls-stream ./swarm-hls-stream
COPY --from=shls-build /shls/packages/stream-uploader/dist ./swarm-hls-stream/packages/stream-uploader/dist
COPY --from=shls-build /shls/packages/client/dist ./swarm-hls-stream/packages/client/dist

ENV NODE_ENV=production
EXPOSE 9876
CMD ["node", "dist/index.js"]
