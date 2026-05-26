# Builds the React SPA and serves it (plus reverse-proxies API calls) via nginx.
# Used on the deploy server — devs reach it through an SSH tunnel to port 8080.

FROM node:22-alpine AS build
WORKDIR /repo
RUN npm install -g pnpm@9

# Workspace manifests first so the install layer caches when sources change.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY common/package.json ./common/
COPY frontend/package.json ./frontend/
COPY manager/package.json ./manager/

RUN pnpm install --frozen-lockfile \
      --filter @streaming-infra-manager/frontend-prototype... \
      --filter @streaming-infra-manager/common...

COPY common ./common
COPY frontend ./frontend

RUN pnpm --filter @streaming-infra-manager/frontend-prototype build

# --- runtime stage ----------------------------------------------------------
FROM nginx:1.27-alpine
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/frontend/dist /usr/share/nginx/html

EXPOSE 80
