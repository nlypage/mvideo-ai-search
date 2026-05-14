FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

FROM deps AS build
ARG VITE_APP_MODE=both
ENV VITE_APP_MODE=${VITE_APP_MODE}
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
