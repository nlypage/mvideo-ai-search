package agent

import (
	"context"
	"testing"

	catalog "github.com/nlypage/mvideo-ai-search/backend/internal/domain/catalog"
	"github.com/nlypage/mvideo-ai-search/backend/internal/domain/chat"
	"github.com/nlypage/mvideo-ai-search/backend/internal/services/tools"
)

type fakeToolBackend struct{}

func (fakeToolBackend) Search(ctx context.Context, req catalog.SearchRequest) (catalog.SearchResult, error) {
	return catalog.SearchResult{Products: []catalog.Product{{ID: "1", Title: "OLED телевизор", Price: 99990, Rating: 4.7, Reviews: 42, Category: "телевизоры", Stock: catalog.Stock{Store: 1}}}, Source: "live"}, nil
}

func (fakeToolBackend) SearchReviews(ctx context.Context, productID string, query string) ([]catalog.ReviewSummary, error) {
	return []catalog.ReviewSummary{}, nil
}

func (fakeToolBackend) SearchBlog(ctx context.Context, query string) ([]catalog.BlogArticle, error) {
	return []catalog.BlogArticle{{Title: "Как выбрать OLED", URL: "https://www.mvideo.ru/blog/oled", Snippet: "OLED", Content: "content"}}, nil
}

func TestLocalAgentB2C(t *testing.T) {
	agent := NewLocal(tools.New(fakeToolBackend{}), true)
	result, err := agent.Chat(context.Background(), []chat.Message{{Role: "user", Content: "Подбери OLED телевизор"}}, chat.ModeB2C)
	if err != nil {
		t.Fatalf("Chat() error = %v", err)
	}
	if result.Text == "" || len(result.Products) != 1 || len(result.Debug) == 0 {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestLocalAgentOffTopic(t *testing.T) {
	agent := NewLocal(tools.New(fakeToolBackend{}), false)
	result, err := agent.Chat(context.Background(), []chat.Message{{Role: "user", Content: "напиши код на python"}}, chat.ModeB2C)
	if err != nil {
		t.Fatalf("Chat() error = %v", err)
	}
	if result.Text == "" || len(result.Products) != 0 {
		t.Fatalf("unexpected result: %+v", result)
	}
}
