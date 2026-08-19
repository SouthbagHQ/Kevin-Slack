# syntax=docker/dockerfile:1

FROM oven/bun:debian AS bun

FROM node:24-bookworm-slim AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates chromium dumb-init \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    CHROME_PATH=/usr/bin/chromium
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
