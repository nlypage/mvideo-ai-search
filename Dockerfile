FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

FROM deps AS build
ARG VITE_APP_MODE=both
ARG VITE_LOW_MEMORY_BUILD=1
ENV VITE_APP_MODE=${VITE_APP_MODE}
ENV VITE_LOW_MEMORY_BUILD=${VITE_LOW_MEMORY_BUILD}
ENV CLOUDFLARE_TELEMETRY_DISABLED=1
COPY . .
RUN if [ "$VITE_LOW_MEMORY_BUILD" = "1" ]; then bun run build; else bun run build:full; fi

FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV CLOUDFLARE_TELEMETRY_DISABLED=1
COPY --from=build /app/dist /app/dist
COPY --from=build /app/scripts/serve-worker.mjs /app/scripts/serve-worker.mjs
EXPOSE 3000
CMD ["node", "scripts/serve-worker.mjs"]
