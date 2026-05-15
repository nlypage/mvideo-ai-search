# Go backend cutover checklist

## Topology

The rewritten backend runs as a separate Go service while the existing TanStack frontend keeps the same public origin.

```text
browser
  -> frontend container :3000
      -> static assets / SSR
      -> /api/* proxy to BACKEND_ORIGIN
          -> Go backend container :8080
```

This preserves the frontend contracts:

- `GET /api/llm`
- `POST /api/llm`
- `GET /api/catalog`
- `POST /api/catalog`

## Local compose

```bash
docker compose up --build cltkf cltkf-backend
```

Customer UI:

```bash
curl -fsS http://localhost:${CLIENT_PORT:-3000}/api/llm
curl -fsS 'http://localhost:${CLIENT_PORT:-3000}/api/catalog?query=телевизор&limit=1'
```

Consultant UI:

```bash
docker compose up --build mvideo-consultant mvideo-consultant-backend
curl -fsS http://localhost:${CONSULTANT_PORT:-3001}/api/llm
```

## Required production env

Frontend containers:

- `BACKEND_ORIGIN=http://<backend-service>:8080`
- `APP_MODE=client` or `APP_MODE=consultant`

Backend containers:

- `APP_MODE=client` or `APP_MODE=consultant`
- `HTTP_ADDR=:8080`
- `LLM_MODEL=gpt-5.4-mini`
- optional `LLM_API_KEY` / `OPENAI_API_KEY`
- optional `LLM_BASE_URL`, default `https://api.openai.com/v1`
- optional `AI_DEBUG=false`
- optional `CONSULTANT_ACCESS_TOKEN` for consultant mode
- optional `LOG_LEVEL=info`

## Dokploy images

Published tags expected by `docker-compose.dokploy.yml`:

- `ghcr.io/nlypage/mvideo-ai-search:client-latest`
- `ghcr.io/nlypage/mvideo-ai-search:consultant-latest`
- `ghcr.io/nlypage/mvideo-ai-search:backend-latest`

Override tags with:

- `CLIENT_IMAGE_TAG`
- `CONSULTANT_IMAGE_TAG`
- `BACKEND_IMAGE_TAG`

## Smoke checks

Run after deployment:

```bash
curl -fsS https://<client-domain>/api/llm | jq .
curl -fsS 'https://<client-domain>/api/catalog?query=телевизор&limit=1' | jq .
curl -fsS https://<consultant-domain>/api/llm | jq .
```

Expected:

- `GET /api/llm` returns `configured`, `model`, `provider`, `appMode`, `debug`.
- catalog requests return HTTP `200` with `products` array, even if upstream catalog is temporarily empty.
- invalid consultant token returns HTTP `403` only for protected `POST /api/llm` consultant calls.

## Validation gates

Before promotion:

```bash
cd backend && go test ./...
cd backend && go test -race ./...
cd backend && golangci-lint run ./...
docker compose config --quiet
docker compose -f docker-compose.dokploy.yml config --quiet
docker build --target backend -t mvideo-go-backend-check .
docker build --target frontend --build-arg VITE_APP_MODE=client --build-arg VITE_LOW_MEMORY_BUILD=1 -t mvideo-frontend-check .
node --check scripts/serve-worker.mjs
```

## Rollback

The TypeScript API routes were removed after the Go cutover. Rollback now means redeploying a previous immutable frontend image/commit that still contains those routes, or fixing/promoting the Go backend image.

1. Redeploy the previous known-good frontend image tag if immediate rollback is required.
2. Redeploy the previous known-good backend image tag, or stop the Go backend only after the previous combined image is serving `/api/*` again.
3. Keep failed Go backend container logs until triage is complete.
