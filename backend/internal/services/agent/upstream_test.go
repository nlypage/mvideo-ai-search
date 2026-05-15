package agent

import (
	"context"
	"testing"

	"github.com/nlypage/mvideo-ai-search/backend/internal/clients/openai"
	catalog "github.com/nlypage/mvideo-ai-search/backend/internal/domain/catalog"
	"github.com/nlypage/mvideo-ai-search/backend/internal/domain/chat"
	"github.com/nlypage/mvideo-ai-search/backend/internal/services/tools"
)

type fakeCompleter struct {
	calls int
}

func (f *fakeCompleter) Complete(ctx context.Context, messages []openai.Message, toolSpecs []openai.Tool, toolChoice string, maxTokens int, temperature float64) (openai.Message, error) {
	f.calls++
	if f.calls == 1 {
		call := openai.ToolCall{ID: "call-1", Type: "function"}
		call.Function.Name = "search_catalog"
		call.Function.Arguments = `{"query":"OLED TV","limit":1}`
		return openai.Message{Role: "assistant", ToolCalls: []openai.ToolCall{call}}, nil
	}
	return openai.Message{Role: "assistant", Content: "Нашёл OLED TV"}, nil
}

type fakeUpstreamBackend struct{}

func (fakeUpstreamBackend) Search(ctx context.Context, req catalog.SearchRequest) (catalog.SearchResult, error) {
	return catalog.SearchResult{Products: []catalog.Product{{ID: "1", Title: "OLED TV", Price: 100}}, Source: "live"}, nil
}

func (fakeUpstreamBackend) SearchReviews(ctx context.Context, productID string, query string) ([]catalog.ReviewSummary, error) {
	return nil, nil
}

func (fakeUpstreamBackend) SearchBlog(ctx context.Context, query string) ([]catalog.BlogArticle, error) {
	return nil, nil
}

func TestUpstreamAgentToolLoop(t *testing.T) {
	completer := &fakeCompleter{}
	agent := NewUpstream(completer, tools.New(fakeUpstreamBackend{}), true)
	result, err := agent.Chat(context.Background(), []chat.Message{{Role: "user", Content: "Подбери OLED"}}, chat.ModeB2C)
	if err != nil {
		t.Fatalf("Chat() error = %v", err)
	}
	if result.Text != "Нашёл OLED TV" || len(result.Products) != 1 || len(result.Debug) == 0 || completer.calls != 2 {
		t.Fatalf("unexpected result/calls: %+v calls=%d", result, completer.calls)
	}
}

type sequenceCompleter struct {
	calls int
	seq   []openai.Message
}

func (s *sequenceCompleter) Complete(ctx context.Context, messages []openai.Message, toolSpecs []openai.Tool, toolChoice string, maxTokens int, temperature float64) (openai.Message, error) {
	s.calls++
	if s.calls > len(s.seq) {
		return openai.Message{Role: "assistant", Content: "done"}, nil
	}
	return s.seq[s.calls-1], nil
}

type recordingBackend struct {
	queries []string
}

func (b *recordingBackend) Search(ctx context.Context, req catalog.SearchRequest) (catalog.SearchResult, error) {
	b.queries = append(b.queries, req.Query)
	return catalog.SearchResult{Products: []catalog.Product{{ID: "1", Title: "Игровая гарнитура", Price: 5000, Rating: 4.8, Reviews: 50, Category: "гарнитуры", Stock: catalog.Stock{Store: 1}}}, Source: "live"}, nil
}

func (b *recordingBackend) SearchReviews(ctx context.Context, productID string, query string) ([]catalog.ReviewSummary, error) {
	return nil, nil
}

func (b *recordingBackend) SearchBlog(ctx context.Context, query string) ([]catalog.BlogArticle, error) {
	return []catalog.BlogArticle{{Title: "Как выбрать OLED", URL: "https://www.mvideo.ru/blog/oled", Snippet: "snippet", Content: "content"}}, nil
}

func toolCall(name string, args string) openai.Message {
	call := openai.ToolCall{ID: "call-" + name, Type: "function"}
	call.Function.Name = name
	call.Function.Arguments = args
	return openai.Message{Role: "assistant", ToolCalls: []openai.ToolCall{call}}
}

func TestUpstreamAgentNormalizesBroadCatalogAndRecommendProducts(t *testing.T) {
	backend := &recordingBackend{}
	completer := &sequenceCompleter{seq: []openai.Message{
		toolCall("search_catalog", `{"query":"что подарить геймеру","limit":1}`),
		toolCall("recommend_products", `{"productIds":["1","missing"]}`),
		{Role: "assistant", Content: "Берите гарнитуру"},
	}}
	agent := NewUpstream(completer, tools.New(backend), false)
	result, err := agent.Chat(context.Background(), []chat.Message{{Role: "user", Content: "Что подарить геймеру до 10000 рублей?"}}, chat.ModeB2C)
	if err != nil {
		t.Fatalf("Chat() error = %v", err)
	}
	if len(backend.queries) != 1 || backend.queries[0] != "игровая гарнитура" {
		t.Fatalf("catalog query was not normalized: %#v", backend.queries)
	}
	if len(result.Products) != 1 || result.Products[0].ID != "1" {
		t.Fatalf("unexpected products: %+v", result.Products)
	}
}

func TestUpstreamAgentRequiresStructuredBlogCitation(t *testing.T) {
	completer := &sequenceCompleter{seq: []openai.Message{
		toolCall("search_blog", `{"query":"OLED телевизор"}`),
		{Role: "assistant", Content: "OLED важен для контраста по статье"},
		toolCall("cite_blog_source", `{"title":"Как выбрать OLED","url":"https://www.mvideo.ru/blog/oled"}`),
		{Role: "assistant", Content: "OLED важен для контраста\n\nИсточник: лишняя строка"},
	}}
	agent := NewUpstream(completer, tools.New(&recordingBackend{}), true)
	result, err := agent.Chat(context.Background(), []chat.Message{{Role: "user", Content: "Как выбрать OLED телевизор?"}}, chat.ModeB2C)
	if err != nil {
		t.Fatalf("Chat() error = %v", err)
	}
	if len(result.Sources) != 1 || result.Sources[0].URL != "https://www.mvideo.ru/blog/oled" {
		t.Fatalf("expected structured citation, got %+v", result.Sources)
	}
	if result.Text != "OLED важен для контраста" || completer.calls != 4 {
		t.Fatalf("unexpected text/calls: %q calls=%d", result.Text, completer.calls)
	}
}
