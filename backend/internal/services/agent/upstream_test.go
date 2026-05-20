package agent

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nlypage/mvideo-ai-search/backend/internal/clients/openai"
	catalog "github.com/nlypage/mvideo-ai-search/backend/internal/domain/catalog"
	"github.com/nlypage/mvideo-ai-search/backend/internal/domain/chat"
	"github.com/nlypage/mvideo-ai-search/backend/internal/services/tools"
)

type fakeCompleter struct {
	calls int
}

func (f *fakeCompleter) Complete(ctx context.Context, messages []openai.Message, toolSpecs []openai.Tool, toolChoice any, maxTokens int, temperature float64) (openai.Message, error) {
	if isGuardCompletion(messages) {
		return openai.Message{Role: "assistant", Content: `{"rejection_score":0.05,"reason":"товарный запрос","label":"allow"}`}, nil
	}
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
	// Возвращаем тестовые отзывы для обогащения товаров
	return []catalog.ReviewSummary{{
		ProductID:        productID,
		TotalRating:      4.5,
		TotalNumber:      42,
		RecommendPercent: 85,
		Snippets:         []string{"Отличный товар", "Рекомендую"},
		Benefits:         []string{"Качество", "Цена"},
		Drawbacks:        []string{"Доставка"},
	}}, nil
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

type guardRejectCompleter struct {
	mainCalls int
}

func (g *guardRejectCompleter) Complete(ctx context.Context, messages []openai.Message, toolSpecs []openai.Tool, toolChoice any, maxTokens int, temperature float64) (openai.Message, error) {
	if isGuardCompletion(messages) {
		return openai.Message{Role: "assistant", Content: `{"rejection_score":0.96,"reason":"алгоритмы вне домена М.Видео","label":"reject"}`}, nil
	}
	g.mainCalls++
	return openai.Message{Role: "assistant", Content: "should not be called"}, nil
}

func TestUpstreamAgentRefusesOffDomainB2CBeforeMainModel(t *testing.T) {
	completer := &guardRejectCompleter{}
	agent := NewUpstream(completer, tools.New(fakeUpstreamBackend{}), true)
	result, err := agent.Chat(context.Background(), []chat.Message{{Role: "user", Content: "как написать бинайрный поиск"}}, chat.ModeB2C)
	if err != nil {
		t.Fatalf("Chat() error = %v", err)
	}
	if result.Text == "" || len(result.Products) != 0 || completer.mainCalls != 0 {
		t.Fatalf("unexpected result/calls: %+v calls=%d", result, completer.mainCalls)
	}
}

func TestUpstreamAgentAllowsShortCatalogQueryThroughGuard(t *testing.T) {
	completer := &fakeCompleter{}
	agent := NewUpstream(completer, tools.New(fakeUpstreamBackend{}), true)
	result, err := agent.Chat(context.Background(), []chat.Message{{Role: "user", Content: "блинница"}}, chat.ModeB2C)
	if err != nil {
		t.Fatalf("Chat() error = %v", err)
	}
	if result.Text == "" || completer.calls == 0 {
		t.Fatalf("expected main model call for product query, got result=%+v calls=%d", result, completer.calls)
	}
}

func TestParseB2CGuardDecision(t *testing.T) {
	allow := parseB2CGuardDecision("```json\n{\"rejection_score\":0.12,\"reason\":\"товар\",\"label\":\"allow\"}\n```")
	if allow.shouldReject() || allow.RejectionScore != 0.12 || allow.Label != "allow" {
		t.Fatalf("unexpected allow decision: %+v", allow)
	}
	reject := parseB2CGuardDecision(`{"rejection_score":0.91,"reason":"код","label":"reject"}`)
	if !reject.shouldReject() {
		t.Fatalf("expected reject decision: %+v", reject)
	}
	invalid := parseB2CGuardDecision("not json")
	if !invalid.shouldReject() {
		t.Fatalf("invalid guard response must fail closed: %+v", invalid)
	}
}

type sequenceCompleter struct {
	calls        int
	seq          []openai.Message
	toolChoices  []any
	maxTokens    []int
	temperatures []float64
}

func (s *sequenceCompleter) Complete(ctx context.Context, messages []openai.Message, toolSpecs []openai.Tool, toolChoice any, maxTokens int, temperature float64) (openai.Message, error) {
	if isGuardCompletion(messages) {
		return openai.Message{Role: "assistant", Content: `{"rejection_score":0.05,"reason":"товарный запрос","label":"allow"}`}, nil
	}
	s.calls++
	s.toolChoices = append(s.toolChoices, toolChoice)
	s.maxTokens = append(s.maxTokens, maxTokens)
	s.temperatures = append(s.temperatures, temperature)
	if s.calls > len(s.seq) {
		return openai.Message{Role: "assistant", Content: "done"}, nil
	}
	return s.seq[s.calls-1], nil
}

func (s *sequenceCompleter) CompleteStream(ctx context.Context, messages []openai.Message, toolSpecs []openai.Tool, toolChoice any, maxTokens int, temperature float64, onDelta func(openai.StreamDelta) error) (openai.Message, error) {
	msg, err := s.Complete(ctx, messages, toolSpecs, toolChoice, maxTokens, temperature)
	if err != nil || len(msg.ToolCalls) > 0 || onDelta == nil {
		return msg, err
	}
	midpoint := len([]rune(msg.Content)) / 2
	parts := []string{string([]rune(msg.Content)[:midpoint]), string([]rune(msg.Content)[midpoint:])}
	for _, part := range parts {
		if part == "" {
			continue
		}
		if err := onDelta(openai.StreamDelta{Content: part}); err != nil {
			return openai.Message{}, err
		}
	}
	return msg, nil
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

func isGuardCompletion(messages []openai.Message) bool {
	return len(messages) > 0 && messages[0].Content == b2cGuardPrompt
}

func toolCall(name string, args string) openai.Message {
	return multiToolCall([]struct{ name, args string }{{name: name, args: args}})
}

func multiToolCall(calls []struct{ name, args string }) openai.Message {
	out := openai.Message{Role: "assistant", ToolCalls: make([]openai.ToolCall, 0, len(calls))}
	for _, item := range calls {
		call := openai.ToolCall{ID: "call-" + item.name, Type: "function"}
		call.Function.Name = item.name
		call.Function.Arguments = item.args
		out.ToolCalls = append(out.ToolCalls, call)
	}
	return out
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
	forced, ok := completer.toolChoices[2].(map[string]any)
	if !ok || forced["type"] != "function" {
		t.Fatalf("expected forced citation tool choice, got %#v", completer.toolChoices[2])
	}
	if result.Text != "OLED важен для контраста" || completer.calls != 4 {
		t.Fatalf("unexpected text/calls: %q calls=%d", result.Text, completer.calls)
	}
}

type parallelBackend struct {
	searchStarted chan struct{}
	blogStarted   chan struct{}
	release       chan struct{}
	searchOnce    sync.Once
	blogOnce      sync.Once
	releaseOnce   sync.Once
}

func (b *parallelBackend) Search(ctx context.Context, req catalog.SearchRequest) (catalog.SearchResult, error) {
	b.searchOnce.Do(func() { close(b.searchStarted) })
	select {
	case <-b.blogStarted:
	case <-ctx.Done():
		return catalog.SearchResult{}, ctx.Err()
	}
	select {
	case <-b.release:
	case <-ctx.Done():
		return catalog.SearchResult{}, ctx.Err()
	}
	return catalog.SearchResult{Products: []catalog.Product{{ID: "1", Title: "OLED TV", Price: 100}}}, nil
}

func (b *parallelBackend) SearchReviews(ctx context.Context, productID string, query string) ([]catalog.ReviewSummary, error) {
	return nil, nil
}

func (b *parallelBackend) SearchBlog(ctx context.Context, query string) ([]catalog.BlogArticle, error) {
	b.blogOnce.Do(func() { close(b.blogStarted) })
	select {
	case <-b.searchStarted:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	select {
	case <-b.release:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return []catalog.BlogArticle{{Title: "OLED", URL: "https://www.mvideo.ru/blog/oled", Snippet: "snippet", Content: "content"}}, nil
}

func (b *parallelBackend) closeRelease() {
	b.releaseOnce.Do(func() { close(b.release) })
}

func TestUpstreamAgentRunsToolCallsConcurrently(t *testing.T) {
	backend := &parallelBackend{searchStarted: make(chan struct{}), blogStarted: make(chan struct{}), release: make(chan struct{})}
	completer := &sequenceCompleter{seq: []openai.Message{
		multiToolCall([]struct{ name, args string }{
			{name: "search_catalog", args: `{"query":"OLED","limit":1}`},
			{name: "search_blog", args: `{"query":"OLED"}`},
		}),
		{Role: "assistant", Content: "Готово"},
	}}
	agent := NewUpstream(completer, tools.New(backend), false)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	defer backend.closeRelease()

	done := make(chan error, 1)
	go func() {
		_, err := agent.Chat(ctx, []chat.Message{{Role: "user", Content: "Подбери OLED и объясни выбор"}}, chat.ModeB2C)
		done <- err
	}()

	select {
	case <-backend.searchStarted:
	case <-time.After(300 * time.Millisecond):
		t.Fatal("search_catalog did not start")
	}
	select {
	case <-backend.blogStarted:
	case <-time.After(300 * time.Millisecond):
		t.Fatal("search_blog did not start while search_catalog was still running")
	}
	backend.closeRelease()
	if err := <-done; err != nil {
		t.Fatalf("Chat() error = %v", err)
	}
}

func TestUpstreamAgentUsesConfiguredBudgets(t *testing.T) {
	completer := &sequenceCompleter{seq: []openai.Message{{Role: "assistant", Content: "ok"}}}
	agent := NewUpstream(completer, tools.New(fakeUpstreamBackend{}), false, UpstreamOptions{MaxTokensB2C: 901, MaxTokensB2E: 451, TemperatureB2C: 0.41, TemperatureB2E: 0.11})
	_, err := agent.Chat(context.Background(), []chat.Message{{Role: "user", Content: "Подбери OLED"}}, chat.ModeB2E)
	if err != nil {
		t.Fatalf("Chat() error = %v", err)
	}
	if completer.maxTokens[0] != 451 || completer.temperatures[0] != 0.11 {
		t.Fatalf("unexpected B2E budget: tokens=%d temperature=%v", completer.maxTokens[0], completer.temperatures[0])
	}
}

func TestUpstreamAgentStreamEmitsContentDeltas(t *testing.T) {
	completer := &sequenceCompleter{seq: []openai.Message{{Role: "assistant", Content: "Потоковый ответ"}}}
	agent := NewUpstream(completer, tools.New(fakeUpstreamBackend{}), false)
	deltas := []string{}
	result, err := agent.Stream(context.Background(), []chat.Message{{Role: "user", Content: "Подбери OLED"}}, chat.ModeB2C, func(event StreamEvent) error {
		if event.Type == "delta" {
			deltas = append(deltas, event.Text)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("Stream() error = %v", err)
	}
	if result.Text != "Потоковый ответ" || len(deltas) < 2 || strings.Join(deltas, "") != result.Text {
		t.Fatalf("unexpected stream result: text=%q deltas=%+v", result.Text, deltas)
	}
}

func TestUpstreamAgentSkipsExtraFinalCallWhenToolLimitHasProducts(t *testing.T) {
	seq := make([]openai.Message, 0, 6)
	for i := 0; i < 6; i++ {
		msg := toolCall("search_catalog", `{"query":"OLED TV","limit":1}`)
		msg.Content = "Уже нашёл подходящий OLED TV"
		seq = append(seq, msg)
	}
	completer := &sequenceCompleter{seq: seq}
	agent := NewUpstream(completer, tools.New(fakeUpstreamBackend{}), false)
	result, err := agent.Chat(context.Background(), []chat.Message{{Role: "user", Content: "Подбери OLED"}}, chat.ModeB2C)
	if err != nil {
		t.Fatalf("Chat() error = %v", err)
	}
	if completer.calls != 6 {
		t.Fatalf("Complete() calls = %d, want 6 without extra final call", completer.calls)
	}
	if len(result.Products) != 1 || result.Text == "" {
		t.Fatalf("unexpected fallback result: %+v", result)
	}
}
