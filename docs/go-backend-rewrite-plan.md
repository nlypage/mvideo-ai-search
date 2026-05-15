# План полного rewrite backend на Go

Дата: 2026-05-15  
Ветка: `rewrite-backend-go`  
Цель: вынести текущие server/API части TanStack Start из TypeScript в отдельный production-grade Go backend, сохранив публичные контракты `/api/llm` и `/api/catalog` для существующего React/TanStack frontend.

## 1. Исходное состояние

### Текущий backend

- `src/routes/api/catalog.ts` — HTTP endpoint поиска каталога:
  - `GET /api/catalog?query=&minPrice=&maxPrice=&offset=&limit=`
  - `POST /api/catalog` с JSON body `{ query, minPrice, maxPrice, offset, limit }`
  - вызывает `runTool("search_catalog", ...)`
  - ограничение body: `4_000` bytes
  - базовая защита: sanitize, prompt-injection/off-topic фильтры
- `src/routes/api/llm.ts` — основной AI proxy/agent endpoint:
  - `GET /api/llm` возвращает runtime config `{ configured, model, provider, appMode, debug }`
  - `POST /api/llm` принимает `{ mode: "b2c" | "b2e", messages: [...] }`
  - rate limit in-memory: `b2c=30/10m`, `b2e=60/10m`
  - mode gate через `APP_MODE|VITE_APP_MODE`: `client`, `consultant`, `both`
  - опциональный `CONSULTANT_ACCESS_TOKEN` через header `x-consultant-token`
  - upstream OpenAI-compatible `/chat/completions` с tool calling
  - fallback local agent, если `LLM_API_KEY` отсутствует
  - body limit: `24_000` bytes
- `src/lib/mv-tools.ts` — интеграции и доменная логика:
  - public M.Video catalog BFF
  - product details/prices/reviews
  - blog WordPress APIs + HTML fallback
  - in-memory TTL cache 5 минут
  - cookies/headers для публичных M.Video endpoints
- `src/lib/mv-security.ts` — off-topic/prompt-injection filters, sanitize/redaction
- `src/lib/mv-prompts.ts` — B2C/B2E system prompts
- `src/lib/mv-llm.ts` — frontend client wrapper, который должен продолжить работать без изменений или с минимальной заменой base URL.

### Текущий deployment

- `Dockerfile` собирает TanStack frontend и запускает SSR worker через Node.
- `docker-compose.yml` поднимает два отдельных сервиса из одного image:
  - `cltkf` / client mode на `${CLIENT_PORT:-3000}`
  - `mvideo-consultant` / consultant mode на `${CONSULTANT_PORT:-3001}`
- Runtime env:
  - `APP_MODE`
  - `LLM_API_KEY` / `OPENAI_API_KEY`
  - `LLM_BASE_URL`
  - `LLM_MODEL`
  - `AI_DEBUG` / `LLM_DEBUG` / `VITE_AI_DEBUG`
  - `CONSULTANT_ACCESS_TOKEN`
- Есть Cloudflare/TanStack config (`wrangler.jsonc`, `src/server.ts`), но Go backend целесообразно деплоить как отдельный HTTP service/container.

## 2. Стабильные API-контракты

Rewrite не должен ломать frontend. Первичная совместимость обязательна.

### `GET /api/llm`

Response `200`:

```json
{
  "configured": true,
  "model": "gpt-5.4-mini",
  "provider": "api.openai.com",
  "appMode": "client",
  "debug": false
}
```

### `POST /api/llm`

Request:

```json
{
  "mode": "b2c",
  "messages": [{ "role": "user", "content": "Подбери OLED телевизор для PS5" }]
}
```

Response success:

```json
{
  "text": "...",
  "products": [],
  "sources": [],
  "raw": [],
  "debug": []
}
```

Error semantics to preserve:

- `400` — empty/invalid messages/body
- `403` — mode forbidden or invalid consultant token
- `429` — rate limit exceeded
- `500` — AI proxy error, without leaking secrets

### `GET/POST /api/catalog`

Response success:

```json
{
  "products": [],
  "source": "live",
  "page": { "offset": 0, "limit": 24, "total": 100, "nextOffset": 24 }
}
```

Response safe empty/error:

```json
{ "products": [], "error": "..." }
```

## 3. Целевая Go-архитектура

### Layout

```text
backend/
  go.mod
  go.sum
  cmd/api/main.go
  internal/app/app.go
  internal/config/config.go
  internal/httpapi/router.go
  internal/httpapi/handlers/llm.go
  internal/httpapi/handlers/catalog.go
  internal/domain/chat/types.go
  internal/domain/catalog/types.go
  internal/domain/tools/registry.go
  internal/domain/security/security.go
  internal/services/agent/agent.go
  internal/services/agent/local.go
  internal/services/agent/upstream.go
  internal/services/mvideo/client.go
  internal/services/mvideo/catalog.go
  internal/services/mvideo/products.go
  internal/services/mvideo/reviews.go
  internal/services/mvideo/blog.go
  internal/services/cache/memory.go
  internal/services/ratelimit/memory.go
  internal/observability/logging.go
  internal/testutil/
```

### Основные решения

- HTTP: начать с stdlib `net/http` + small middleware. Router можно сделать через `http.ServeMux` Go 1.22+ patterns; внешние зависимости не нужны на старте.
- Config: env-only с валидацией и безопасными defaults.
- Logging: `log/slog`, redaction для токенов и upstream errors.
- HTTP clients: единый `http.Client` с timeout, per-request `context.Context`, retry только для безопасных M.Video GET при явных transient errors.
- Cache: in-memory TTL как parity с текущим кодом; интерфейсом подготовить Redis/Cloudflare KV later.
- Rate limit: in-memory parity; интерфейсом подготовить distributed limiter later.
- Tool calling: typed registry с JSON schemas, строгим allowlist и sanitizer args.
- Upstream LLM: OpenAI-compatible client для `/chat/completions`; provider-agnostic base URL validation только `https`.
- Local fallback agent: сначала перенос текущих heuristics без попытки улучшать продуктовую логику.
- Deployment: backend как отдельный container, frontend proxy на Go API через env `VITE_API_BASE_URL` или dev/prod reverse proxy.

## 4. Этапы реализации

### Milestone 0 — Подготовка и фиксация контракта

Статус: начат.

- [x] Создать ветку `rewrite-backend-go`.
- [x] Инвентаризировать текущие API и deployment.
- [ ] Сохранить примеры request/response fixtures для `/api/llm` и `/api/catalog`.
- [ ] Зафиксировать acceptance tests parity до удаления TS backend.
- [ ] Дождаться отчетов subagents и внести уточнения в этот план.

Deliverables:

- `docs/go-backend-rewrite-plan.md`
- `backend/` skeleton
- API fixtures/tests

### Milestone 1 — Go skeleton и инфраструктура

- [ ] `backend/go.mod`
- [ ] `cmd/api/main.go` с graceful shutdown
- [ ] config/env loader
- [ ] router + middleware:
  - request id
  - recovery
  - JSON content type
  - no-store/security headers для API
  - CORS только если frontend будет ходить cross-origin
- [ ] health endpoints:
  - `GET /healthz`
  - `GET /readyz`
- [ ] базовые unit tests для config/security/handlers.

Acceptance:

- `go test ./...` green
- `go run ./cmd/api` стартует локально
- `curl /healthz` возвращает `200`

### Milestone 2 — Domain types, security и rate limit

- [ ] Перенести types: `Product`, `BlogArticle`, `ReviewSummary`, `BlogSource`, `ChatMessage`, `LLMResult`.
- [ ] Перенести sanitize/off-topic/prompt-injection/redaction.
- [ ] Реализовать body size limits: catalog `4KB`, llm `24KB`.
- [ ] Реализовать mode gate и consultant token.
- [ ] Реализовать in-memory rate limiter с cleanup.

Acceptance:

- table-driven tests покрывают sanitize, injection/off-topic, mode gate, rate limit.

### Milestone 3 — M.Video client/tools parity

- [ ] Catalog search:
  - `/bff/products/v2/search`
  - `/bff/product-details/list`
  - `/bff/products/prices`
- [ ] Reviews:
  - `/bff/reviews/aplaut`
- [ ] Blog:
  - `/blog/wp-json/wp/v2/search`
  - `/blog/wp-json/wp/v2/posts`
  - category HTML fallback
- [ ] Cookie/header handling parity.
- [ ] TTL cache.
- [ ] `Tools.Run(name,args)` with allowlist.

Acceptance:

- unit tests with `httptest.Server` for each external client path.
- integration smoke can be opt-in via env, not required in CI.

### Milestone 4 — `/api/catalog` на Go

- [ ] Implement GET/POST handler.
- [ ] Preserve response shape and safe empty behavior.
- [ ] Add handler tests with mocked tool runner.
- [ ] Frontend can switch catalog calls to Go service without UI changes.

Acceptance:

- Contract tests pass for valid, empty, off-topic, injection, invalid body, oversized body.

### Milestone 5 — `/api/llm` local fallback на Go

- [ ] Normalize messages parity.
- [ ] Перенести heuristics:
  - broad selection requests
  - catalog query derivation
  - blog query derivation
  - max price inference
  - ranking/filtering/dedup products
  - B2C/B2E text builders
- [ ] Preserve `debug` shape.

Acceptance:

- snapshots/fixtures для representative запросов B2C/B2E без `LLM_API_KEY`.

### Milestone 6 — upstream tool-calling agent на Go

- [ ] OpenAI-compatible chat client.
- [ ] Tool schemas parity.
- [ ] Tool call loop up to 8 steps.
- [ ] Safe tool args parser.
- [ ] Citation enforcement for blog usage.
- [ ] Final no-tools answer fallback.
- [ ] Upstream timeout 20s.

Acceptance:

- `httptest.Server` simulates tool calls and final answer.
- No secret leakage in errors/logs.

### Milestone 7 — Frontend integration

Варианты:

1. Recommended for Docker: frontend and backend as separate services behind reverse proxy.
2. Transitional: TanStack API route proxies `/api/*` to Go backend while UI remains unchanged.
3. Later: remove TS API routes after Go parity is validated.

Tasks:

- [ ] Add frontend API base config if needed.
- [ ] Update `src/lib/mv-llm.ts` only if endpoint origin changes.
- [ ] Add compose services:
  - `backend-client` / `APP_MODE=client`
  - `backend-consultant` / `APP_MODE=consultant`
  - or one backend with `APP_MODE=both`, depending on deployment decision.

Acceptance:

- B2C and B2E UI flows both work against Go backend.

### Milestone 8 — Docker/CI/observability

- [ ] Multi-stage Go Dockerfile or extend root Dockerfile.
- [ ] docker-compose for split frontend/backend.
- [ ] CI commands:
  - `go test ./...`
  - `go test -race ./...` where supported
  - existing `bun run lint` / `bun run build`
- [ ] Structured logs.
- [ ] Readiness reflects config and optional upstream dependencies.

Acceptance:

- Local compose starts complete stack.
- Existing two-service client/consultant deployment remains possible.

### Milestone 9 — Cutover and cleanup

- [ ] Run parity checklist.
- [ ] Switch frontend traffic to Go backend.
- [ ] Keep TS routes as proxy/fallback for one iteration.
- [ ] Remove TS backend code only after parity is confirmed.
- [ ] Update docs/env examples.

## 5. Validation matrix

| Area             | Check                                                                 |
| ---------------- | --------------------------------------------------------------------- |
| Go unit          | `cd backend && go test ./...`                                         |
| Race             | `cd backend && go test -race ./...`                                   |
| Frontend lint    | `bun run lint`                                                        |
| Frontend build   | `bun run build`                                                       |
| Catalog contract | GET/POST success, empty, injection, body too large                    |
| LLM config       | GET configured/unconfigured provider response                         |
| LLM auth         | B2E token accepted/rejected                                           |
| LLM rate limit   | b2c/b2e limits preserved                                              |
| Local fallback   | no API key returns product recommendations when catalog mock has data |
| Upstream tools   | tool calls execute only allowlisted tools                             |
| Security         | secrets redacted, no hidden prompt leakage, no unbounded body         |
| Deployment       | docker compose starts frontend + Go backend                           |

## 6. Risks and mitigations

| Risk                                         | Impact | Mitigation                                                                               |
| -------------------------------------------- | -----: | ---------------------------------------------------------------------------------------- |
| M.Video public BFF blocks requests           |   High | Preserve headers/cookies, add testable client abstraction, graceful empty responses      |
| Distributed rate limit missing               | Medium | Start with parity in-memory; add Redis/KV interface later if multi-replica needed        |
| Tool-calling provider differences            |   High | OpenAI-compatible client with tolerant JSON parsing and fixtures                         |
| Frontend origin/proxy mismatch               | Medium | Keep `/api/*` path stable via proxy or same-origin routing                               |
| Rewriting heuristics changes recommendations |   High | Snapshot fixtures before refactor; port behavior first, improve later                    |
| Cloudflare Worker vs Go container mismatch   | Medium | Treat Go backend as container target; leave Worker SSR separately until cutover decision |
| Large rewrite drift                          |   High | Serial milestones, one writer, subagent review after each material diff                  |

## 7. Subagent orchestration

Во время rewrite использовались parallel subagents для API inventory, architecture и deployment анализа. В финальном дереве временные handoff-артефакты удалены как лишние после завершения переноса.

Правило работы:

- parallel subagents читают и планируют;
- основной поток или один `worker` пишет код;
- после каждого крупного milestone — fresh-context review fanout: correctness, tests, maintainability/security.

## 8. Definition of Done

Rewrite считается завершенным, когда:

- Go backend реализует `/api/llm`, `/api/catalog`, `/healthz`, `/readyz`.
- Существующий frontend работает с Go backend без регрессий в B2C/B2E сценариях.
- Все env/deployment docs обновлены.
- Go tests, race tests where feasible, frontend lint/build проходят.
- TS backend routes удалены или оставлены только как documented proxy/fallback на переходный период.
- Rollback path documented: вернуть frontend на прежний TS API route/container image.
