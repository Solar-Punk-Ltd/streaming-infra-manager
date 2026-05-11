# --- manager build stage ----------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- swarm-hls-stream build stage -------------------------------------------
# Pre-builds the workspace packages so deploy.sh's `build_if_needed` skips the
# pnpm install at runtime — the runtime image carries no pnpm.
FROM node:22-alpine AS shls-build
WORKDIR /shls
# python3/make/g++ for native module builds (esbuild, @swc/core, @parcel/watcher).
# pnpm 9 — matches lockfileVersion 9.0 in swarm-hls-stream/pnpm-lock.yaml and
# avoids pnpm 10/11's interactive build-script approval prompt.
RUN apk add --no-cache python3 make g++ \
 && npm install -g pnpm@9

COPY swarm-hls-stream/package.json swarm-hls-stream/pnpm-workspace.yaml swarm-hls-stream/pnpm-lock.yaml ./
COPY swarm-hls-stream/packages ./packages

RUN pnpm install --frozen-lockfile
RUN pnpm -r build

# --- runtime stage ----------------------------------------------------------
FROM node:22-alpine
WORKDIR /app

# bash + jq are required by deploy/scripts/*.sh.
# docker-cli + docker-cli-compose talk to the host daemon via the mounted socket.
# rsync + openssh-client are only needed when a profile deploys to a remote target.
RUN apk add --no-cache \
      bash jq \
      docker-cli docker-cli-compose \
      rsync openssh-client \
      ca-certificates

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY --from=build /app/dist ./dist

# Bake the swarm-hls-stream tree into the image. The deploy scripts plus their
# referenced compose files / Dockerfiles / configs all live in here.
# .dockerignore excludes node_modules + dist (rebuilt above) and re-includes
# swarm-hls-stream/.env* so the reference env files ship with the image.
COPY swarm-hls-stream ./swarm-hls-stream
COPY --from=shls-build /shls/packages/stream-uploader/dist ./swarm-hls-stream/packages/stream-uploader/dist
COPY --from=shls-build /shls/packages/client/dist ./swarm-hls-stream/packages/client/dist

ENV NODE_ENV=production
EXPOSE 9876
CMD ["node", "dist/index.js"]
