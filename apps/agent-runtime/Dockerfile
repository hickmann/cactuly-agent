# Multi-stage build para o agent-runtime.
# Base: node:22-alpine (leve).
FROM node:22-alpine AS build

WORKDIR /app
COPY apps/agent-runtime/package.json apps/agent-runtime/tsconfig.json ./
RUN npm install --omit=dev=false --no-fund --no-audit

COPY apps/agent-runtime/src ./src
RUN npx tsc

FROM node:22-alpine AS runtime

RUN apk add --no-cache tini git

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

ENV NODE_ENV=production \
    WORKER_DATA_DIRECTORY=/data

VOLUME ["/data"]

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
