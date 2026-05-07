# --- build stage --------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime stage ------------------------------------------------------------
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

ENV NODE_ENV=production
EXPOSE 9876
CMD ["node", "dist/index.js"]
