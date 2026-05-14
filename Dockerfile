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
RUN bun run build

FROM oven/bun:1-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV CLOUDFLARE_TELEMETRY_DISABLED=1
COPY --from=build /app /app
EXPOSE 3000
CMD ["bun", "scripts/serve-worker.mjs"]
