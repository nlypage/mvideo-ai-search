package agent

import (
	"context"

	"github.com/nlypage/mvideo-ai-search/backend/internal/domain/chat"
	"github.com/nlypage/mvideo-ai-search/backend/internal/services/tools"
)

// StreamEvent is a UI-visible progress event emitted while the agent works.
type StreamEvent struct {
	Type   string `json:"type"`
	Name   string `json:"name,omitempty"`
	Hint   string `json:"hint,omitempty"`
	Step   int    `json:"step,omitempty"`
	Detail string `json:"detail,omitempty"`
	Text   string `json:"text,omitempty"`
}

// Stream answers like Chat and emits progress events for streaming UIs.
func (a *LocalAgent) Stream(ctx context.Context, messages []chat.Message, mode chat.Mode, emit func(StreamEvent) error) (Result, error) {
	return a.Chat(ctx, messages, mode)
}

// Stream answers with the upstream LLM and emits progress events for tool calls.
func (a *UpstreamAgent) Stream(ctx context.Context, messages []chat.Message, mode chat.Mode, emit func(StreamEvent) error) (Result, error) {
	return a.chat(ctx, messages, mode, emit)
}

func toolProgressHint(name string, _ tools.Args) string {
	switch name {
	case "search_catalog":
		return "Ищет в каталоге..."
	case "search_reviews":
		return "Читает отзывы..."
	case "search_blog":
		return "Ищет гайд в блоге..."
	case "cite_blog_source":
		return "Проверяет источник..."
	case "recommend_products":
		return "Подбирает карточки..."
	default:
		return "Думает..."
	}
}
