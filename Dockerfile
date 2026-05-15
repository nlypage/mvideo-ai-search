FROM oven/bun:1 AS frontend-deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

FROM frontend-deps AS frontend-build
ARG VITE_APP_MODE=both
ARG VITE_LOW_MEMORY_BUILD=1
ENV VITE_APP_MODE=${VITE_APP_MODE}
ENV VITE_LOW_MEMORY_BUILD=${VITE_LOW_MEMORY_BUILD}
ENV CLOUDFLARE_TELEMETRY_DISABLED=1
COPY . .
RUN if [ "$VITE_LOW_MEMORY_BUILD" = "1" ]; then bun run build; else bun run build:full; fi

FROM golang:1.26-bookworm AS backend-build
WORKDIR /src/backend
COPY backend/go.mod ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/mvideo-api ./cmd/api

FROM gcr.io/distroless/static-debian12 AS backend
WORKDIR /app
ENV HTTP_ADDR=:8080
ENV HEALTHCHECK_URL=http://127.0.0.1:8080/healthz
COPY --from=backend-build /out/mvideo-api /app/mvideo-api
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD ["/app/mvideo-api", "-healthcheck"]
CMD ["/app/mvideo-api"]

FROM node:24-slim AS frontend
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV CLOUDFLARE_TELEMETRY_DISABLED=1
COPY --from=frontend-build /app/dist /app/dist
COPY --from=frontend-build /app/scripts/serve-worker.mjs /app/scripts/serve-worker.mjs
EXPOSE 3000
CMD ["node", "scripts/serve-worker.mjs"]
