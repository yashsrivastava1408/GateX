# The whole evaluator in one small image. Stage 1 builds the dashboard; stage 2 carries only what runs.
FROM node:25-slim AS build

WORKDIR /app

# Install dependencies first so this layer is reused when only the code changes.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

COPY . .
RUN npm run build


FROM node:25-slim

WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only: no Vite, no test tools, no type checker.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace shared --workspace server && npm cache clean --force

COPY shared/src shared/src
COPY server/src server/src
COPY server/config server/config
COPY server/scripts/doctor.ts server/scripts/doctor.ts
COPY --from=build /app/web/dist web/dist

# Uploads and report copies live here; compose mounts a folder over it.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:4000/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# tsx runs the TypeScript directly. Started without npm so a stop signal reaches the server and it can finish cleanly.
CMD ["node_modules/.bin/tsx", "server/src/index.ts"]
