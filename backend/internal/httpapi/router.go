package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net"
	"net/http"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"github.com/nlypage/mvideo-ai-search/backend/internal/config"
	catalogdomain "github.com/nlypage/mvideo-ai-search/backend/internal/domain/catalog"
	"github.com/nlypage/mvideo-ai-search/backend/internal/domain/chat"
	"github.com/nlypage/mvideo-ai-search/backend/internal/domain/security"
	"github.com/nlypage/mvideo-ai-search/backend/internal/services/agent"
	"github.com/nlypage/mvideo-ai-search/backend/internal/services/ratelimit"
)

const (
	catalogBodyLimitBytes = 4_000
	llmBodyLimitBytes     = 24_000
)

type CatalogSearcher interface {
	Search(ctx context.Context, req catalogdomain.SearchRequest) (catalogdomain.SearchResult, error)
}

type ChatAgent interface {
	Chat(ctx context.Context, messages []chat.Message, mode chat.Mode) (agent.Result, error)
}

type StreamingChatAgent interface {
	ChatAgent
	Stream(ctx context.Context, messages []chat.Message, mode chat.Mode, emit func(agent.StreamEvent) error) (agent.Result, error)
}

// Dependencies contains application services used by HTTP handlers.
type Dependencies struct {
	Catalog CatalogSearcher
	Agent   ChatAgent
}

type apiHandler struct {
	cfg        config.Config
	catalog    CatalogSearcher
	agent      ChatAgent
	b2cLimiter *ratelimit.MemoryLimiter
	b2eLimiter *ratelimit.MemoryLimiter
}

// NewRouter builds all public backend routes.
func NewRouter(cfg config.Config, logger *slog.Logger, deps ...Dependencies) http.Handler {
	api := &apiHandler{
		cfg:        cfg,
		catalog:    firstDeps(deps).Catalog,
		agent:      firstDeps(deps).Agent,
		b2cLimiter: ratelimit.NewMemoryLimiter(ratelimit.Policy{Limit: 30, Window: 10 * time.Minute}),
		b2eLimiter: ratelimit.NewMemoryLimiter(ratelimit.Policy{Limit: 60, Window: 10 * time.Minute}),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", healthHandler)
	mux.HandleFunc("GET /readyz", readinessHandler(cfg))
	mux.HandleFunc("GET /api/llm", llmConfigHandler(cfg))
	mux.HandleFunc("POST /api/llm", api.llmPostHandler)
	mux.HandleFunc("POST /api/llm/stream", api.llmStreamHandler)
	mux.HandleFunc("GET /api/catalog", api.catalogGetHandler)
	mux.HandleFunc("POST /api/catalog", api.catalogPostHandler)

	return securityHeaders(recoverer(logger)(requestLogger(logger)(mux)))
}

func healthHandler(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func readinessHandler(cfg config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"status":     "ready",
			"configured": cfg.Configured(),
			"appMode":    cfg.AppMode,
		})
	}
}

func llmConfigHandler(cfg config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"configured": cfg.Configured(),
			"model":      cfg.LLMModel,
			"provider":   cfg.ProviderName(),
			"appMode":    cfg.AppMode,
			"debug":      cfg.AIDebug,
		})
	}
}

func (h *apiHandler) llmPostHandler(w http.ResponseWriter, r *http.Request) {
	messages, mode, ok := h.prepareLLMRequest(w, r)
	if !ok {
		return
	}
	if h.agent == nil {
		writeJSON(w, http.StatusOK, llmInProgressResult())
		return
	}
	result, err := h.agent.Chat(r.Context(), messages, mode)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "AI proxy error"})
		return
	}
	writeJSON(w, http.StatusOK, normalizeAgentResult(result))
}

func (h *apiHandler) llmStreamHandler(w http.ResponseWriter, r *http.Request) {
	messages, mode, ok := h.prepareLLMRequest(w, r)
	if !ok {
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "streaming unsupported"})
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	if h.agent == nil {
		_ = writeSSE(w, flusher, "final", normalizeAgentResult(llmInProgressResult()))
		return
	}

	emit := func(event agent.StreamEvent) error {
		return writeSSE(w, flusher, event.Type, event)
	}
	var result agent.Result
	var err error
	if streamer, ok := h.agent.(StreamingChatAgent); ok {
		result, err = streamer.Stream(r.Context(), messages, mode, emit)
	} else {
		result, err = h.agent.Chat(r.Context(), messages, mode)
	}
	if err != nil {
		_ = writeSSE(w, flusher, "error", map[string]string{"error": "AI proxy error"})
		return
	}
	_ = writeSSE(w, flusher, "final", normalizeAgentResult(result))
}

func (h *apiHandler) prepareLLMRequest(w http.ResponseWriter, r *http.Request) ([]chat.Message, chat.Mode, bool) {
	var body struct {
		Mode     chat.Mode      `json:"mode"`
		Messages []chat.Message `json:"messages"`
	}
	if err := readLimitedJSON(r, llmBodyLimitBytes, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return nil, "", false
	}

	mode := body.Mode
	if mode != chat.ModeB2E {
		mode = chat.ModeB2C
	}
	if err := validateServiceMode(mode, h.cfg.AppMode); err != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
		return nil, "", false
	}
	if mode == chat.ModeB2E && h.cfg.ConsultantAccessToken != "" && r.Header.Get("x-consultant-token") != h.cfg.ConsultantAccessToken {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return nil, "", false
	}
	if !h.allowRequest(clientKey(r, mode), mode) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "rate limit exceeded"})
		return nil, "", false
	}
	messages := normalizeMessages(body.Messages)
	if len(messages) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "empty messages"})
		return nil, "", false
	}
	return messages, mode, true
}

func llmInProgressResult() agent.Result {
	return agent.Result{Text: "Go AI backend rewrite is in progress. Keep production traffic on the existing TypeScript AI route until the agent service is implemented.", Products: []catalogdomain.Product{}, Sources: []catalogdomain.BlogSource{}, Raw: []chat.Message{}, Debug: []agent.DebugStep{}}
}

func normalizeAgentResult(result agent.Result) agent.Result {
	if result.Debug == nil {
		result.Debug = []agent.DebugStep{}
	}
	if result.Products == nil {
		result.Products = []catalogdomain.Product{}
	}
	if result.Sources == nil {
		result.Sources = []catalogdomain.BlogSource{}
	}
	return result
}

func (h *apiHandler) catalogGetHandler(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	req := catalogdomain.SearchRequest{
		Query:    security.SanitizeUserText(query.Get("query"), 240),
		MinPrice: numberOrUndefined(query.Get("minPrice")),
		MaxPrice: numberOrUndefined(query.Get("maxPrice")),
		Offset:   intOrUndefined(query.Get("offset")),
		Limit:    intOrUndefined(query.Get("limit")),
	}
	h.handleCatalogSearch(w, r, req)
}

func (h *apiHandler) catalogPostHandler(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Query    any `json:"query"`
		MinPrice any `json:"minPrice"`
		MaxPrice any `json:"maxPrice"`
		Offset   any `json:"offset"`
		Limit    any `json:"limit"`
	}
	if err := readLimitedJSON(r, catalogBodyLimitBytes, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"products": []any{}, "error": "Invalid request body"})
		return
	}
	req := catalogdomain.SearchRequest{
		Query:    security.SanitizeUserText(body.Query, 240),
		MinPrice: numberOrUndefined(fmt.Sprint(body.MinPrice)),
		MaxPrice: numberOrUndefined(fmt.Sprint(body.MaxPrice)),
		Offset:   intOrUndefined(fmt.Sprint(body.Offset)),
		Limit:    intOrUndefined(fmt.Sprint(body.Limit)),
	}
	h.handleCatalogSearch(w, r, req)
}

func (h *apiHandler) handleCatalogSearch(w http.ResponseWriter, r *http.Request, req catalogdomain.SearchRequest) {
	if req.Query == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"products": []any{}, "error": "Empty query"})
		return
	}
	if security.IsPromptInjection(req.Query) || security.IsOffTopic(req.Query) {
		writeJSON(w, http.StatusOK, map[string]any{"products": []any{}})
		return
	}
	if h.catalog == nil {
		writeJSON(w, http.StatusOK, map[string]any{"products": []any{}, "error": "Catalog error"})
		return
	}
	result, err := h.catalog.Search(r.Context(), req)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"products": []any{}, "error": "Catalog error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"products": result.Products, "source": result.Source, "page": result.Page})
}

func (h *apiHandler) allowRequest(key string, mode chat.Mode) bool {
	if mode == chat.ModeB2E {
		return h.b2eLimiter.Allow(key)
	}
	return h.b2cLimiter.Allow(key)
}

func firstDeps(deps []Dependencies) Dependencies {
	if len(deps) == 0 {
		return Dependencies{}
	}
	return deps[0]
}

func validateServiceMode(mode chat.Mode, appMode config.AppMode) error {
	if appMode == config.AppModeClient && mode != chat.ModeB2C {
		return errors.New("this service allows only customer AI mode")
	}
	if appMode == config.AppModeConsultant && mode != chat.ModeB2E {
		return errors.New("this service allows only consultant AI mode")
	}
	return nil
}

func clientKey(r *http.Request, mode chat.Mode) string {
	realIP := ""
	if r.RemoteAddr != "" {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err == nil {
			realIP = host
		} else {
			realIP = strings.TrimSpace(r.RemoteAddr)
		}
	}
	if realIP == "" {
		realIP = strings.TrimSpace(r.Header.Get("x-real-ip"))
	}
	if realIP == "" {
		realIP = strings.TrimSpace(strings.Split(r.Header.Get("x-forwarded-for"), ",")[0])
	}
	if realIP == "" {
		realIP = "unknown"
	}
	return string(mode) + ":" + realIP
}

func normalizeMessages(messages []chat.Message) []chat.Message {
	if len(messages) > 8 {
		messages = messages[len(messages)-8:]
	}
	normalized := make([]chat.Message, 0, len(messages))
	for _, message := range messages {
		if message.Role != "user" && message.Role != "assistant" {
			continue
		}
		maxLength := 900
		if message.Role == "user" {
			maxLength = 700
		}
		content := security.SanitizeUserText(message.Content, maxLength)
		if content == "" {
			continue
		}
		normalized = append(normalized, chat.Message{Role: message.Role, Content: content})
	}
	return normalized
}

func readLimitedJSON(r *http.Request, maxBytes int64, destination any) error {
	if r.ContentLength > maxBytes {
		return fmt.Errorf("request body too large: %d > %d", r.ContentLength, maxBytes)
	}
	defer func() { _ = r.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBytes+1))
	if err != nil {
		return fmt.Errorf("read body: %w", err)
	}
	if int64(len(body)) > maxBytes {
		return fmt.Errorf("request body too large: %d > %d", len(body), maxBytes)
	}
	if len(body) == 0 {
		return errors.New("empty body")
	}
	if err := json.Unmarshal(body, destination); err != nil {
		return fmt.Errorf("decode json: %w", err)
	}
	return nil
}

func numberOrUndefined(value string) *float64 {
	number, err := strconv.ParseFloat(value, 64)
	if err != nil || math.IsNaN(number) || math.IsInf(number, 0) || number <= 0 {
		return nil
	}
	return &number
}

func intOrUndefined(value string) *int {
	number, err := strconv.Atoi(value)
	if err != nil || number <= 0 {
		return nil
	}
	return &number
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		// Response headers are already committed; there is no safe client-facing fix here.
		return
	}
}

func writeSSE(w http.ResponseWriter, flusher http.Flusher, event string, payload any) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encode sse %s: %w", event, err)
	}
	if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, encoded); err != nil {
		return fmt.Errorf("write sse %s: %w", event, err)
	}
	flusher.Flush()
	return nil
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

func requestLogger(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			next.ServeHTTP(w, r)
			logger.Info("request completed", slog.String("method", r.Method), slog.String("path", r.URL.Path), slog.Duration("duration", time.Since(start)))
		})
	}
}

func recoverer(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if recovered := recover(); recovered != nil {
					logger.Error(
						"panic recovered",
						slog.String("panic", security.RedactSensitive(fmt.Sprint(recovered))),
						slog.String("stack", security.RedactSensitive(string(debug.Stack()))),
					)
					writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}
