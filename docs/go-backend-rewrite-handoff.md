# Go backend rewrite handoff

## Summary

The backend rewrite now lives in `backend/` as a separate Go service while the existing TanStack frontend remains the public entrypoint. The frontend keeps same-origin `/api/*` calls; the Node runtime proxies those calls to the Go backend when `BACKEND_ORIGIN` is configured.

Current branch: `rewrite-backend-go`.

## Implemented

### Go backend

- HTTP server with graceful shutdown and production timeouts.
- Config loader with env aliases and defaults:
  - default `LLM_MODEL=gpt-5.4-mini`
  - `LLM_API_KEY` / `OPENAI_API_KEY`
  - `HTTP_ADDR` / `PORT_ADDR`
  - `APP_MODE` / `VITE_APP_MODE`
  - `AI_DEBUG` / `LLM_DEBUG` / `VITE_AI_DEBUG`
- Health endpoints:
  - `GET /healthz`
  - `GET /readyz`
- Frontend-compatible public API endpoints:
  - `GET /api/llm`
  - `POST /api/llm`
  - `GET /api/catalog`
  - `POST /api/catalog`
- Security helpers:
  - user text sanitization
  - off-topic guard
  - prompt-injection guard
  - sensitive value redaction
- Fixed-window in-memory rate limiter.
- Panic recovery with redaction.

### M.Video integration

- Catalog search client:
  - `/bff/products/v2/search`
  - `/bff/product-details/list`
  - `/bff/products/prices`
- Reviews client:
  - `/bff/reviews/aplaut`
- Blog client:
  - `/blog/wp-json/wp/v2/posts`
  - `/blog/wp-json/wp/v2/search`
- Runtime/tool performance:
  - cookie jar handles M.Video cookie-setting redirects;
  - tuned HTTP connection pooling;
  - catalog details/prices hydrate concurrently;
  - top-product reviews fetch concurrently;
  - blog post/search candidate endpoints run concurrently;
  - local fallback broad catalog searches run concurrently.
- Tool registry:
  - `search_catalog`
  - `search_reviews`
  - `search_blog`
  - `cite_blog_source`
  - agent-handled `recommend_products` for allowlisted catalog results

### LLM agent

- Local fallback agent used when no upstream API key is configured.
- OpenAI-compatible chat completions client.
- Bounded upstream tool-calling loop with registry integration.
- Rich B2C/B2E system prompts ported from the TypeScript route.
- Broad request decomposition and catalog query normalization for gift/selection scenarios.
- Product intent filtering/ranking, budget inference, dedupe, recommendation allowlist, and B2C/B2E response builders.
- Forced structured blog citation flow when `article.content` is used.
- Final no-tools answer fallback after tool limit.
- Contract-compatible `/api/llm` response fields:
  - `text`
  - `products`
  - `sources`
  - `raw`
  - `debug`

### Docker/cutover

- Multi-target `Dockerfile`:
  - `frontend`
  - `backend`
- Backend image:
  - static Go binary
  - distroless runtime
  - `:8080`
  - executable healthcheck via `/app/mvideo-api -healthcheck`
- Frontend image:
  - keeps Node runtime for TanStack SSR/static serving
  - proxies `/api/*` to `BACKEND_ORIGIN` when configured
- Compose split:
  - customer frontend/backend pair
  - consultant frontend/backend pair
- GHCR workflow publishes:
  - `client-latest`
  - `consultant-latest`
  - `backend-latest`

## Validation status

Passing locally:

```bash
cd backend && go test ./...
cd backend && go test -race ./...
cd backend && golangci-lint run ./...
docker compose config --quiet
docker compose -f docker-compose.dokploy.yml config --quiet
node --check scripts/serve-worker.mjs
docker build --target backend -t mvideo-go-backend-check .
docker build --target frontend --build-arg VITE_APP_MODE=client --build-arg VITE_LOW_MEMORY_BUILD=1 -t mvideo-frontend-check .
```

Runtime smoke passed:

- backend container `GET /healthz`
- frontend container `GET /api/llm` proxied through `BACKEND_ORIGIN` to the Go backend
- response returned `appMode=client`, `model=gpt-5.4-mini`, `configured=false`
- opt-in live M.Video tools smoke: `MVIDEO_LIVE_TEST=1 go test ./internal/clients/mvideo -run TestLiveToolsSmoke -count=1 -v` (`3.73s` in latest run)

## Known gaps before production cutover

1. The Go agent now carries the key TypeScript heuristics, but it is still not a byte-for-byte clone of every prompt sentence and every UI debug detail.
2. Rate limiting is in-memory and per replica.
3. Consultant auth remains optional; production consultant deployments should set `CONSULTANT_ACCESS_TOKEN`.
4. M.Video upstreams may require ongoing anti-bot tuning; current client detects poison-pill/blocked responses and returns safe failures. The current live smoke passes after adding a cookie jar for M.Video's cookie-setting redirects.
5. Subagent review for the final Docker phase was attempted, but agents failed/stalled due tool/runtime issues. The implementation was manually validated with tests, builds, compose checks, and runtime smoke.

## Cutover checklist

See `docs/go-backend-cutover-checklist.md`.

## Recommended next steps

1. Run one real upstream LLM smoke with a non-production API key.
2. Deploy to staging with `BACKEND_ORIGIN` enabled.
3. Test both app modes:
   - customer `APP_MODE=client`
   - consultant `APP_MODE=consultant` with `CONSULTANT_ACCESS_TOKEN`
4. Monitor backend logs for M.Video upstream errors/rate limits.
5. Only after staging passes, promote `backend-latest`, `client-latest`, and `consultant-latest` together.
