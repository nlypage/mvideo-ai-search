package app

import (
	"log/slog"
	"net/http"

	"github.com/nlypage/mvideo-ai-search/backend/internal/clients/mvideo"
	"github.com/nlypage/mvideo-ai-search/backend/internal/clients/openai"
	"github.com/nlypage/mvideo-ai-search/backend/internal/config"
	"github.com/nlypage/mvideo-ai-search/backend/internal/httpapi"
	"github.com/nlypage/mvideo-ai-search/backend/internal/services/agent"
	catalogservice "github.com/nlypage/mvideo-ai-search/backend/internal/services/catalog"
	"github.com/nlypage/mvideo-ai-search/backend/internal/services/tools"
)

// App wires runtime configuration, services, and HTTP transport.
type App struct {
	cfg    config.Config
	logger *slog.Logger
}

// New creates an application instance.
func New(cfg config.Config, logger *slog.Logger) *App {
	return &App{cfg: cfg, logger: logger}
}

// Handler returns the root HTTP handler.
func (a *App) Handler() http.Handler {
	catalogClient := mvideo.New(a.cfg)
	catalogService := catalogservice.New(catalogClient)
	toolRegistry := tools.New(catalogClient)
	var chatAgent httpapi.ChatAgent = agent.NewLocal(toolRegistry, a.cfg.AIDebug)
	if a.cfg.Configured() {
		chatAgent = agent.NewUpstream(openai.New(a.cfg), toolRegistry, a.cfg.AIDebug, agent.UpstreamOptionsFromConfig(a.cfg))
	}
	return httpapi.NewRouter(a.cfg, a.logger, httpapi.Dependencies{Catalog: catalogService, Agent: chatAgent})
}
