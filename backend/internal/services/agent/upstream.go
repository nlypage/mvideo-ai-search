package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/nlypage/mvideo-ai-search/backend/internal/clients/openai"
	catalog "github.com/nlypage/mvideo-ai-search/backend/internal/domain/catalog"
	"github.com/nlypage/mvideo-ai-search/backend/internal/domain/chat"
	"github.com/nlypage/mvideo-ai-search/backend/internal/domain/security"
	"github.com/nlypage/mvideo-ai-search/backend/internal/services/tools"
)

// ChatCompleter is implemented by OpenAI-compatible clients.
type ChatCompleter interface {
	Complete(ctx context.Context, messages []openai.Message, toolSpecs []openai.Tool, toolChoice string, maxTokens int, temperature float64) (openai.Message, error)
}

// UpstreamAgent is an OpenAI-compatible tool-calling agent with TS-route parity guards.
type UpstreamAgent struct {
	client ChatCompleter
	tools  *tools.Registry
	debug  bool
}

// NewUpstream creates an upstream LLM agent.
func NewUpstream(client ChatCompleter, registry *tools.Registry, debug bool) *UpstreamAgent {
	return &UpstreamAgent{client: client, tools: registry, debug: debug}
}

// Chat runs a bounded tool-calling loop.
func (a *UpstreamAgent) Chat(ctx context.Context, messages []chat.Message, mode chat.Mode) (Result, error) {
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

	for step := 0; step < 6; step++ {
		msg, err := a.client.Complete(ctx, convo, toolSpecs(), "auto", maxTokens(mode), temperature(mode))
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
				convo = append(convo, openai.Message{Role: "system", Content: "Ты использовал данные search_blog/article.content. Перед финальным ответом обязательно вызови cite_blog_source с title и url этой статьи. Не пиши строку 'Источник:' текстом."})
				continue
			}
			products := finalProducts(messages, searchProducts, recommendedProducts)
			return finishResult(Result{Text: stripRenderedSourceLines(answerText), Products: products, Sources: dedupeSources(citedSources)}, a.debug, debug), nil
		}

		if a.debug {
			debug = append(debug, DebugStep{Step: step, Type: "decision", Title: "Агент выбрал инструменты", Args: toolCallNames(msg.ToolCalls)})
		}
		for _, call := range msg.ToolCalls {
			args := parseToolArgs(call.Function.Arguments)
			if call.Function.Name == "search_catalog" {
				var changed bool
				args, changed = normalizeCatalogArgs(args, messages, catalogCursor)
				catalogCursor++
				if changed && a.debug {
					debug = append(debug, DebugStep{Step: step, Type: "decision", Title: "Нормализовал запрос каталога", Args: map[string]any{"query": args.Query, "maxPrice": args.MaxPrice, "limit": args.Limit}})
				}
			}

			result, err := a.runTool(ctx, call.Function.Name, args, searchProducts, messages)
			if err != nil {
				return Result{}, err
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
	result := a.finalNoToolsAnswer(ctx, convo, messages, mode, searchProducts, recommendedProducts, citedSources)
	return finishResult(result, a.debug, debug), nil
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

func (a *UpstreamAgent) finalNoToolsAnswer(ctx context.Context, convo []openai.Message, messages []chat.Message, mode chat.Mode, searchProducts []catalog.Product, recommendedProducts []catalog.Product, citedSources []catalog.BlogSource) Result {
	fallback := gracefulToolLimitAnswer(messages, searchProducts, recommendedProducts)
	finalConvo := append([]openai.Message(nil), convo...)
	finalConvo = append(finalConvo, openai.Message{Role: "system", Content: "Инструменты больше недоступны. Не вызывай tools. Ответь пользователю по уже собранным результатам каталога, статей и отзывов. Не упоминай лимит инструментов или технические ошибки."})
	msg, err := a.client.Complete(ctx, finalConvo, nil, "", maxTokens(mode), temperature(mode))
	if err != nil || strings.TrimSpace(msg.Content) == "" {
		return fallback
	}
	text := security.RedactSensitive(sanitizeAssistantText(msg.Content, mode, messages))
	return Result{Text: stripRenderedSourceLines(text), Products: finalProducts(messages, searchProducts, recommendedProducts), Sources: dedupeSources(citedSources)}
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

func finalProducts(messages []chat.Message, searchProducts []catalog.Product, recommendedProducts []catalog.Product) []catalog.Product {
	base := searchProducts
	if len(recommendedProducts) > 0 {
		base = recommendedProducts
	}
	return firstProducts(rankProductsForUserIntent(dedupeProducts(filterProductsForUserIntent(base, messages)), lastUserText(messages)), 4)
}

func maxTokens(mode chat.Mode) int {
	if mode == chat.ModeB2E {
		return 350
	}
	return 700
}

func temperature(mode chat.Mode) float64 {
	if mode == chat.ModeB2E {
		return 0.2
	}
	return 0.35
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

func toolSpecs() []openai.Tool {
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
