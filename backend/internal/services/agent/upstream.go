package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	"github.com/nlypage/mvideo-ai-search/backend/internal/clients/openai"
	"github.com/nlypage/mvideo-ai-search/backend/internal/config"
	catalog "github.com/nlypage/mvideo-ai-search/backend/internal/domain/catalog"
	"github.com/nlypage/mvideo-ai-search/backend/internal/domain/chat"
	"github.com/nlypage/mvideo-ai-search/backend/internal/domain/security"
	"github.com/nlypage/mvideo-ai-search/backend/internal/services/tools"
)

// ChatCompleter is implemented by OpenAI-compatible clients.
type ChatCompleter interface {
	Complete(ctx context.Context, messages []openai.Message, toolSpecs []openai.Tool, toolChoice any, maxTokens int, temperature float64) (openai.Message, error)
}

// ChatStreamCompleter is implemented by OpenAI-compatible clients with native SSE support.
type ChatStreamCompleter interface {
	CompleteStream(ctx context.Context, messages []openai.Message, toolSpecs []openai.Tool, toolChoice any, maxTokens int, temperature float64, onDelta func(openai.StreamDelta) error) (openai.Message, error)
}

// UpstreamOptions controls model budget knobs for the upstream agent.
type UpstreamOptions struct {
	MaxTokensB2C   int
	MaxTokensB2E   int
	TemperatureB2C float64
	TemperatureB2E float64
}

// UpstreamOptionsFromConfig maps runtime config into upstream agent options.
func UpstreamOptionsFromConfig(cfg config.Config) UpstreamOptions {
	return UpstreamOptions{
		MaxTokensB2C:   cfg.LLMMaxTokensB2C,
		MaxTokensB2E:   cfg.LLMMaxTokensB2E,
		TemperatureB2C: cfg.LLMTemperatureB2C,
		TemperatureB2E: cfg.LLMTemperatureB2E,
	}
}

// UpstreamAgent is an OpenAI-compatible tool-calling agent with TS-route parity guards.
type UpstreamAgent struct {
	client         ChatCompleter
	tools          *tools.Registry
	debug          bool
	maxTokensB2C   int
	maxTokensB2E   int
	temperatureB2C float64
	temperatureB2E float64
}

// NewUpstream creates an upstream LLM agent.
func NewUpstream(client ChatCompleter, registry *tools.Registry, debug bool, options ...UpstreamOptions) *UpstreamAgent {
	opts := upstreamOptionsWithDefaults(options...)
	return &UpstreamAgent{
		client:         client,
		tools:          registry,
		debug:          debug,
		maxTokensB2C:   opts.MaxTokensB2C,
		maxTokensB2E:   opts.MaxTokensB2E,
		temperatureB2C: opts.TemperatureB2C,
		temperatureB2E: opts.TemperatureB2E,
	}
}

func upstreamOptionsWithDefaults(options ...UpstreamOptions) UpstreamOptions {
	out := UpstreamOptions{MaxTokensB2C: 700, MaxTokensB2E: 350, TemperatureB2C: 0.35, TemperatureB2E: 0.2}
	if len(options) == 0 {
		return out
	}
	opt := options[0]
	if opt.MaxTokensB2C > 0 {
		out.MaxTokensB2C = opt.MaxTokensB2C
	}
	if opt.MaxTokensB2E > 0 {
		out.MaxTokensB2E = opt.MaxTokensB2E
	}
	if opt.TemperatureB2C > 0 {
		out.TemperatureB2C = opt.TemperatureB2C
	}
	if opt.TemperatureB2E > 0 {
		out.TemperatureB2E = opt.TemperatureB2E
	}
	return out
}

// Chat runs a bounded tool-calling loop.
func (a *UpstreamAgent) Chat(ctx context.Context, messages []chat.Message, mode chat.Mode) (Result, error) {
	return a.chat(ctx, messages, mode, nil)
}

func (a *UpstreamAgent) chat(ctx context.Context, messages []chat.Message, mode chat.Mode, emit func(StreamEvent) error) (Result, error) {
	messages, refusal := sanitizeConversation(messages, mode)
	if refusal != nil {
		return finishResult(*refusal, a.debug, nil), nil
	}

	convo := []openai.Message{{Role: "system", Content: systemPrompt(mode)}}
	for _, message := range messages {
		convo = append(convo, openai.Message{Role: message.Role, Content: message.Content})
	}
	debug := []DebugStep{}
	searchProducts := []catalog.Product{}
	recommendedProducts := []catalog.Product{}
	blogArticles := []catalog.BlogArticle{}
	citedSources := []catalog.BlogSource{}
	catalogCursor := 0
	toolChoice := any("auto")

	for step := 0; step < 6; step++ {
		streamContent := canStreamContentDeltas(mode, blogArticles, citedSources)
		msg, err := a.complete(ctx, convo, toolSpecs(), toolChoice, mode, emit, streamContent)
		toolChoice = "auto"
		if err != nil {
			return Result{}, err
		}
		convo = append(convo, msg)
		if a.debug {
			debug = append(debug, DebugStep{Step: step, Type: "assistant", Title: "Ответ модели", Detail: summarizeAssistantMessage(msg)})
		}

		if len(msg.ToolCalls) == 0 {
			answerText := security.RedactSensitive(sanitizeAssistantText(msg.Content, mode, messages))
			if shouldRequireCitationTool(answerText, blogArticles, citedSources, mode) {
				if a.debug {
					debug = append(debug, DebugStep{Step: step, Type: "decision", Title: "Требую структурный источник", Detail: "Ответ опирается на прочитанную статью, но cite_blog_source ещё не вызван."})
				}
				toolChoice = forceToolChoice("cite_blog_source")
				continue
			}
			products := finalProducts(mode, messages, searchProducts, recommendedProducts)
			return finishResult(Result{Text: stripRenderedSourceLines(answerText), Products: products, Sources: dedupeSources(citedSources)}, a.debug, debug), nil
		}

		if a.debug {
			debug = append(debug, DebugStep{Step: step, Type: "decision", Title: "Агент выбрал инструменты", Args: toolCallNames(msg.ToolCalls)})
		}
		preparedCalls := make([]preparedToolCall, len(msg.ToolCalls))
		for index, call := range msg.ToolCalls {
			args := parseToolArgs(call.Function.Arguments)
			if call.Function.Name == "search_catalog" {
				var changed bool
				args, changed = normalizeCatalogArgs(args, messages, catalogCursor)
				catalogCursor++
				if changed && a.debug {
					debug = append(debug, DebugStep{Step: step, Type: "decision", Title: "Нормализовал запрос каталога", Args: map[string]any{"query": args.Query, "maxPrice": args.MaxPrice, "limit": args.Limit}})
				}
			}
			preparedCalls[index] = preparedToolCall{Call: call, Args: args}
		}

		toolResults, err := a.runToolCallsConcurrently(ctx, preparedCalls, searchProducts, messages, step, emit)
		if err != nil {
			return Result{}, err
		}
		for _, completed := range toolResults {
			call := completed.Call
			result := completed.Result
			if mode == chat.ModeB2E {
				result.Products = enrichB2EProducts(result.Products)
			}
			if len(result.Products) > 0 {
				if call.Function.Name == "recommend_products" {
					recommendedProducts = append(recommendedProducts, result.Products...)
				} else {
					searchProducts = append(searchProducts, result.Products...)
				}
			}
			if result.Article != nil {
				blogArticles = append(blogArticles, *result.Article)
			}
			if len(result.Articles) > 0 {
				blogArticles = append(blogArticles, result.Articles...)
			}
			if result.Citation != nil {
				if canonical := canonicalBlogCitation(*result.Citation, blogArticles); canonical != nil {
					citedSources = append(citedSources, *canonical)
				} else {
					citedSources = append(citedSources, *result.Citation)
				}
			}
			encoded, err := json.Marshal(result)
			if err != nil {
				return Result{}, fmt.Errorf("encode tool result: %w", err)
			}
			convo = append(convo, openai.Message{Role: "tool", ToolCallID: call.ID, Name: call.Function.Name, Content: string(encoded)})
			if a.debug {
				debug = append(debug, DebugStep{Step: step, Type: "result", Title: "Результат " + call.Function.Name, Result: compactToolResult(result)})
			}
		}
	}

	if a.debug {
		debug = append(debug, DebugStep{Step: 6, Type: "assistant", Title: "Лимит инструментов достигнут", Detail: "Запрашиваю финальный ответ у модели без инструментов по уже собранным данным."})
	}
	result := a.finalNoToolsAnswer(ctx, convo, messages, mode, searchProducts, recommendedProducts, citedSources, emit)
	return finishResult(result, a.debug, debug), nil
}

func (a *UpstreamAgent) complete(ctx context.Context, convo []openai.Message, specs []openai.Tool, toolChoice any, mode chat.Mode, emit func(StreamEvent) error, streamContent bool) (openai.Message, error) {
	if emit != nil && streamContent {
		if streamer, ok := a.client.(ChatStreamCompleter); ok {
			return streamer.CompleteStream(ctx, convo, specs, toolChoice, a.maxTokens(mode), a.temperature(mode), func(delta openai.StreamDelta) error {
				if delta.Content == "" {
					return nil
				}
				return emit(StreamEvent{Type: "delta", Text: delta.Content})
			})
		}
	}
	return a.client.Complete(ctx, convo, specs, toolChoice, a.maxTokens(mode), a.temperature(mode))
}

func canStreamContentDeltas(mode chat.Mode, blogArticles []catalog.BlogArticle, citedSources []catalog.BlogSource) bool {
	return mode != chat.ModeB2C || len(blogArticles) == 0 || len(citedSources) > 0
}

type preparedToolCall struct {
	Call openai.ToolCall
	Args tools.Args
}

type completedToolCall struct {
	Call   openai.ToolCall
	Result tools.Result
}

func (a *UpstreamAgent) runToolCallsConcurrently(ctx context.Context, calls []preparedToolCall, searchProducts []catalog.Product, messages []chat.Message, step int, emit func(StreamEvent) error) ([]completedToolCall, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	results := make([]completedToolCall, len(calls))
	var wg sync.WaitGroup
	var mu sync.Mutex
	var emitMu sync.Mutex
	var firstErr error
	emitSafe := func(event StreamEvent) error {
		if emit == nil {
			return nil
		}
		emitMu.Lock()
		defer emitMu.Unlock()
		return emit(event)
	}
	setErr := func(err error) {
		mu.Lock()
		defer mu.Unlock()
		if firstErr == nil {
			firstErr = err
			cancel()
		}
	}
	for index, call := range calls {
		wg.Add(1)
		go func(index int, call preparedToolCall) {
			defer wg.Done()
			name := call.Call.Function.Name
			if err := emitSafe(StreamEvent{Type: "tool_call_start", Name: name, Hint: toolProgressHint(name, call.Args), Step: step}); err != nil {
				setErr(err)
				return
			}
			result, err := a.runTool(ctx, name, call.Args, searchProducts, messages)
			if err != nil {
				setErr(err)
				return
			}
			results[index] = completedToolCall{Call: call.Call, Result: result}
			if err := emitSafe(StreamEvent{Type: "tool_call_done", Name: name, Hint: "Готово", Step: step}); err != nil {
				setErr(err)
				return
			}
		}(index, call)
	}
	wg.Wait()
	if firstErr != nil {
		return nil, firstErr
	}
	return results, nil
}

func (a *UpstreamAgent) runTool(ctx context.Context, name string, args tools.Args, searchProducts []catalog.Product, messages []chat.Message) (tools.Result, error) {
	if name == "recommend_products" {
		products := recommendProductsFromIDs(args.ProductIDs, searchProducts, messages)
		if len(products) == 0 {
			return tools.Result{Error: "no allowed recommended products"}, nil
		}
		return tools.Result{Products: products, Source: "selected", Role: "recommendation"}, nil
	}
	return a.tools.Run(ctx, name, args)
}

func forceToolChoice(name string) map[string]any {
	return map[string]any{"type": "function", "function": map[string]string{"name": name}}
}

func (a *UpstreamAgent) finalNoToolsAnswer(ctx context.Context, convo []openai.Message, messages []chat.Message, mode chat.Mode, searchProducts []catalog.Product, recommendedProducts []catalog.Product, citedSources []catalog.BlogSource, emit func(StreamEvent) error) Result {
	fallback := gracefulToolLimitAnswer(messages, searchProducts, recommendedProducts)
	fallback.Sources = dedupeSources(citedSources)
	if (len(recommendedProducts) > 0 || len(searchProducts) > 0) && lastAssistantContent(convo) != "" {
		return fallback
	}
	finalConvo := append([]openai.Message(nil), convo...)
	finalConvo = append(finalConvo, openai.Message{Role: "system", Content: "Инструменты больше недоступны. Не вызывай tools. Ответь пользователю по уже собранным результатам каталога, статей и отзывов. Не упоминай лимит инструментов или технические ошибки."})
	msg, err := a.complete(ctx, finalConvo, nil, "", mode, emit, true)
	if err != nil || strings.TrimSpace(msg.Content) == "" {
		return fallback
	}
	text := security.RedactSensitive(sanitizeAssistantText(msg.Content, mode, messages))
	return Result{Text: stripRenderedSourceLines(text), Products: finalProducts(mode, messages, searchProducts, recommendedProducts), Sources: dedupeSources(citedSources)}
}

func sanitizeConversation(messages []chat.Message, mode chat.Mode) ([]chat.Message, *Result) {
	lastUnsafe := -1
	for i := len(messages) - 1; i >= 0; i-- {
		message := messages[i]
		if message.Role == "user" && (security.IsPromptInjection(message.Content) || (mode == chat.ModeB2C && security.IsOffTopic(message.Content))) {
			lastUnsafe = i
			break
		}
	}
	if lastUnsafe == -1 {
		return messages, nil
	}
	if lastUnsafe == len(messages)-1 {
		if mode == chat.ModeB2C {
			return nil, &Result{Text: security.RefusalB2C}
		}
		return nil, &Result{Text: "• Запрос вне рабочей задачи\n• Вернитесь к клиенту и товарам"}
	}
	return messages[lastUnsafe+1:], nil
}

func summarizeAssistantMessage(msg openai.Message) string {
	if len(msg.ToolCalls) > 0 {
		return "План следующего шага: " + strings.Join(toolCallNames(msg.ToolCalls), ", ")
	}
	return security.SanitizeUserText(firstNonEmpty(msg.Content, "Финальный ответ без дополнительных инструментов"), 500)
}

func finalProducts(mode chat.Mode, messages []chat.Message, searchProducts []catalog.Product, recommendedProducts []catalog.Product) []catalog.Product {
	base := searchProducts
	if len(recommendedProducts) > 0 {
		base = recommendedProducts
	}
	products := firstProducts(rankProductsForUserIntent(dedupeProducts(filterProductsForUserIntent(base, messages)), lastUserText(messages)), 4)
	if mode == chat.ModeB2E {
		return enrichB2EProducts(products)
	}
	return products
}

func (a *UpstreamAgent) maxTokens(mode chat.Mode) int {
	if mode == chat.ModeB2E {
		return a.maxTokensB2E
	}
	return a.maxTokensB2C
}

func (a *UpstreamAgent) temperature(mode chat.Mode) float64 {
	if mode == chat.ModeB2E {
		return a.temperatureB2E
	}
	return a.temperatureB2C
}

func lastAssistantContent(messages []openai.Message) string {
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == "assistant" {
			return strings.TrimSpace(messages[i].Content)
		}
	}
	return ""
}

func parseToolArgs(raw string) tools.Args {
	var args tools.Args
	values := parseToolArgMap(raw)
	args.Query = stringValue(values["query"])
	args.ProductID = stringValue(values["productId"])
	args.Title = stringValue(values["title"])
	args.URL = stringValue(values["url"])
	args.ProductIDs = stringSlice(values["productIds"])
	args.RequiredTerms = stringSlice(values["requiredTerms"])
	args.ExcludedTerms = stringSlice(values["excludedTerms"])
	args.MinPrice = floatPtr(values["minPrice"])
	args.MaxPrice = floatPtr(values["maxPrice"])
	args.Offset = intPtr(values["offset"])
	args.Limit = intPtr(values["limit"])
	return args
}

func parseToolArgMap(raw string) map[string]any {
	var values map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(raw)), &values); err == nil {
		return values
	}
	start := strings.Index(raw, "{")
	if start == -1 {
		return map[string]any{}
	}
	depth := 0
	inString := false
	escaped := false
	for i := start; i < len(raw); i++ {
		char := raw[i]
		if inString {
			if escaped {
				escaped = false
			} else if char == '\\' {
				escaped = true
			} else if char == '"' {
				inString = false
			}
			continue
		}
		switch char {
		case '"':
			inString = true
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				if err := json.Unmarshal([]byte(raw[start:i+1]), &values); err == nil {
					return values
				}
				return map[string]any{}
			}
		}
	}
	return map[string]any{}
}

func stringValue(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

func stringSlice(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if text, ok := item.(string); ok {
			out = append(out, security.SanitizeUserText(text, 40))
		}
	}
	return out
}

func floatPtr(value any) *float64 {
	number, ok := value.(float64)
	if !ok || number <= 0 {
		return nil
	}
	return &number
}

func intPtr(value any) *int {
	number, ok := value.(float64)
	if !ok || number <= 0 {
		return nil
	}
	integer := int(number)
	return &integer
}

func toolCallNames(calls []openai.ToolCall) []string {
	names := make([]string, 0, len(calls))
	for _, call := range calls {
		if call.Function.Name != "" {
			names = append(names, call.Function.Name)
		}
	}
	return names
}

var defaultToolSpecs = buildToolSpecs()

func toolSpecs() []openai.Tool {
	return defaultToolSpecs
}

func buildToolSpecs() []openai.Tool {
	object := func(properties map[string]any, required []string) map[string]any {
		return map[string]any{"type": "object", "additionalProperties": false, "properties": properties, "required": required}
	}
	arrayOfStrings := map[string]any{"type": "array", "items": map[string]any{"type": "string"}}
	return []openai.Tool{
		{Type: "function", Function: openai.FunctionSpec{Name: "search_catalog", Description: "Поиск товаров в публичном каталоге М.Видео. Для широких запросов передавай короткий тип товара/категорию, не полный вопрос.", Parameters: object(map[string]any{"query": map[string]any{"type": "string"}, "requiredTerms": arrayOfStrings, "excludedTerms": arrayOfStrings, "minPrice": map[string]any{"type": "number"}, "maxPrice": map[string]any{"type": "number"}, "offset": map[string]any{"type": "number"}, "limit": map[string]any{"type": "number"}}, []string{"query"})}},
		{Type: "function", Function: openai.FunctionSpec{Name: "search_reviews", Description: "Получает реальные отзывы покупателей М.Видео по конкретному productId", Parameters: object(map[string]any{"productId": map[string]any{"type": "string"}, "query": map[string]any{"type": "string"}}, []string{"productId"})}},
		{Type: "function", Function: openai.FunctionSpec{Name: "search_blog", Description: "Поиск статей и обзоров в блоге М.Видео для критериев выбора и технических объяснений", Parameters: object(map[string]any{"query": map[string]any{"type": "string"}}, []string{"query"})}},
		{Type: "function", Function: openai.FunctionSpec{Name: "cite_blog_source", Description: "Выбирает прочитанную статью блога М.Видео как структурный источник финального ответа", Parameters: object(map[string]any{"title": map[string]any{"type": "string"}, "url": map[string]any{"type": "string"}}, []string{"title", "url"})}},
		{Type: "function", Function: openai.FunctionSpec{Name: "recommend_products", Description: "Фиксирует выбранные товары для блока карточек рекомендаций. Передавай только productIds из результатов search_catalog.", Parameters: object(map[string]any{"productIds": arrayOfStrings}, []string{"productIds"})}},
	}
}
