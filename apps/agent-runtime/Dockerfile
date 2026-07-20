# Multi-stage build para o agent-runtime.
# Base: node:22-alpine (leve).
FROM node:22-alpine AS build

WORKDIR /app
COPY apps/agent-runtime/package.json apps/agent-runtime/tsconfig.json ./
RUN npm install --omit=dev=false --no-fund --no-audit

COPY apps/agent-runtime/src ./src
RUN npx tsc

FROM node:22-alpine AS runtime

# bash e ripgrep são exigência do motor de fix (Claude Code headless);
# USE_BUILTIN_RIPGREP=0 usa o rg do sistema (o embutido não roda em musl)
RUN apk add --no-cache tini git bash ripgrep

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

ENV NODE_ENV=production \
    WORKER_DATA_DIRECTORY=/data \
    USE_BUILTIN_RIPGREP=0

VOLUME ["/data"]

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
