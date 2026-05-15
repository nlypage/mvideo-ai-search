package agent

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"

	catalog "github.com/nlypage/mvideo-ai-search/backend/internal/domain/catalog"
	"github.com/nlypage/mvideo-ai-search/backend/internal/domain/chat"
	"github.com/nlypage/mvideo-ai-search/backend/internal/domain/security"
	"github.com/nlypage/mvideo-ai-search/backend/internal/services/tools"
)

// DebugStep is a safe, UI-visible decision/tool trace.
type DebugStep struct {
	Step   int    `json:"step"`
	Type   string `json:"type"`
	Title  string `json:"title"`
	Detail string `json:"detail,omitempty"`
	Args   any    `json:"args,omitempty"`
	Result any    `json:"result,omitempty"`
}

// Result is the /api/llm response body.
type Result struct {
	Text     string               `json:"text"`
	Products []catalog.Product    `json:"products"`
	Sources  []catalog.BlogSource `json:"sources"`
	Raw      []chat.Message       `json:"raw"`
	Debug    []DebugStep          `json:"debug"`
}

// LocalAgent is the no-API-key fallback agent.
type LocalAgent struct {
	tools *tools.Registry
	debug bool
}

// NewLocal creates the local fallback agent.
func NewLocal(registry *tools.Registry, debug bool) *LocalAgent {
	return &LocalAgent{tools: registry, debug: debug}
}

// Chat answers using deterministic catalog/blog tools without an upstream LLM.
func (a *LocalAgent) Chat(ctx context.Context, messages []chat.Message, mode chat.Mode) (Result, error) {
	last := lastUserText(messages)
	if mode == chat.ModeB2C && security.IsOffTopic(last) {
		return finishResult(Result{Text: security.RefusalB2C}, a.debug, nil), nil
	}
	if mode == chat.ModeB2E && (security.IsPromptInjection(last) || security.IsOffTopic(last)) {
		return finishResult(Result{Text: "• Запрос вне рабочей задачи\n• Вернитесь к клиенту и товарам"}, a.debug, nil), nil
	}

	queries := deriveCatalogQueries(last)
	useCatalog := shouldSearchCatalog(last)
	debug := []DebugStep{}
	if a.debug {
		debug = append(debug, DebugStep{Step: 0, Type: "decision", Title: "Локальный агент выбрал запросы", Args: map[string]any{"catalogQueries": queries, "catalogQuery": firstQuery(queries, last), "useCatalog": useCatalog, "maxPrice": inferMaxPrice(last)}})
	}

	products := []catalog.Product{}
	if useCatalog {
		results, err := a.searchCatalogQueries(ctx, firstStrings(queries, 4), inferMaxPrice(last))
		if err != nil {
			return Result{}, err
		}
		for _, result := range results {
			if a.debug {
				debug = append(debug, DebugStep{Step: 1, Type: "result", Title: "Результат search_catalog: " + result.query, Result: compactToolResult(result.result)})
			}
			products = append(products, result.result.Products...)
		}
	}
	products = rankProductsForUserIntent(dedupeProducts(filterProductsForUserIntent(products, messages)), last)

	var article *catalog.BlogArticle
	if shouldSearchBlog(last) || isBroadSelectionRequest(last) {
		blogResult, err := a.tools.Run(ctx, "search_blog", tools.Args{Query: deriveBlogQuery(last, firstQuery(queries, last))})
		if err != nil {
			return Result{}, err
		}
		article = blogResult.Article
		if a.debug {
			debug = append(debug, DebugStep{Step: 2, Type: "result", Title: "Результат search_blog", Result: compactToolResult(blogResult)})
		}
	}

	if mode == chat.ModeB2E {
		return finishResult(Result{Text: buildB2ESalesText(products, last, article), Products: firstProducts(products, 4)}, a.debug, debug), nil
	}

	if len(products) == 0 {
		return finishResult(Result{Text: "Я попробовал разложить запрос на конкретные категории М.Видео, но публичный каталог сейчас не вернул товары. Уточните бюджет и интересы — например игры, музыка, спорт или учёба — и я попробую другой набор категорий."}, a.debug, debug), nil
	}

	recommended := recommendProductsFromIDs(productIDs(firstProducts(products, 4)), products, messages)
	if a.debug {
		debug = append(debug, DebugStep{Step: 3, Type: "result", Title: "Результат recommend_products", Result: map[string]any{"count": len(recommended)}})
	}
	display := firstProducts(products, 4)
	if len(recommended) > 0 {
		display = firstProducts(recommended, 4)
	}
	sources := []catalog.BlogSource{}
	if article != nil && article.Content != "" {
		sources = append(sources, catalog.BlogSource{Title: article.Title, URL: article.URL})
	}
	text := buildB2CRecommendationText(last, firstQuery(queries, last), queries, display, article)
	return finishResult(Result{Text: stripRenderedSourceLines(sanitizeAssistantText(text, mode, messages)), Products: display, Sources: sources}, a.debug, debug), nil
}

type localCatalogResult struct {
	query  string
	result tools.Result
	err    error
}

func (a *LocalAgent) searchCatalogQueries(ctx context.Context, queries []string, maxPrice *float64) ([]localCatalogResult, error) {
	if len(queries) == 0 {
		return nil, nil
	}
	resultCh := make(chan localCatalogResult, len(queries))
	for _, query := range queries {
		go func(query string) {
			limit := 12
			result, err := a.tools.Run(ctx, "search_catalog", tools.Args{Query: query, MaxPrice: maxPrice, Limit: &limit})
			resultCh <- localCatalogResult{query: query, result: result, err: err}
		}(query)
	}
	byQuery := make(map[string]localCatalogResult, len(queries))
	for range queries {
		result := <-resultCh
		if result.err != nil {
			return nil, result.err
		}
		byQuery[result.query] = result
	}
	ordered := make([]localCatalogResult, 0, len(queries))
	for _, query := range queries {
		ordered = append(ordered, byQuery[query])
	}
	return ordered, nil
}

func finishResult(result Result, debugEnabled bool, debug []DebugStep) Result {
	if result.Products == nil {
		result.Products = []catalog.Product{}
	}
	if result.Sources == nil {
		result.Sources = []catalog.BlogSource{}
	}
	if result.Raw == nil {
		result.Raw = []chat.Message{}
	}
	if debugEnabled {
		result.Debug = firstDebug(debug, 40)
	} else if result.Debug == nil {
		result.Debug = []DebugStep{}
	}
	return result
}

func compactToolResult(result tools.Result) any {
	if len(result.Products) > 0 {
		items := make([]map[string]any, 0, min(len(result.Products), 8))
		for _, product := range firstProducts(result.Products, 8) {
			items = append(items, map[string]any{"id": product.ID, "title": product.Title, "price": product.Price, "rating": product.Rating, "reviews": product.Reviews})
		}
		return map[string]any{"source": result.Source, "role": result.Role, "page": result.Page, "count": len(result.Products), "products": items}
	}
	if result.Article != nil || len(result.Articles) > 0 {
		preview := ""
		if result.Article != nil {
			preview = security.SanitizeUserText(firstNonEmpty(result.Article.Content, result.Article.Snippet), 300)
		}
		return map[string]any{"source": result.Source, "title": result.Title, "url": result.URL, "articleRead": result.Article != nil && result.Article.Content != "", "contentPreview": preview, "articles": len(result.Articles), "error": result.Error}
	}
	if len(result.Reviews) > 0 {
		return map[string]any{"source": result.Source, "count": len(result.Reviews)}
	}
	return map[string]any{"citation": result.Citation, "error": result.Error, "source": result.Source}
}

func lastUserText(messages []chat.Message) string {
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == "user" {
			return messages[i].Content
		}
	}
	return ""
}

func shouldSearchCatalog(text string) bool {
	trimmed := strings.TrimSpace(strings.ToLower(text))
	if trimmed == "" || regexp.MustCompile(`^(привет|спасибо|как дела|что ты умеешь)[.!?]*$`).MatchString(trimmed) {
		return false
	}
	return regexp.MustCompile(`\p{L}|\p{N}`).MatchString(text)
}

func shouldSearchBlog(text string) bool {
	return regexp.MustCompile(`(?i)как выбрать|что такое|чем отличается|сравни|сравнить|hdmi|dolby|atmos|oled|hdr|ps5|саундбар|кабель|телевизор|монитор|120\s*гц|vrr|qled|mini\s*led`).MatchString(text)
}

func isBroadSelectionRequest(text string) bool {
	return regexp.MustCompile(`(?i)что\s+подарить|подарок|варианты\s+для|что\s+взять|что\s+купить|идеи\s+для|подрост|школьник|студент|геймер|в\s+общагу`).MatchString(text)
}

func deriveCatalogQueries(text string) []string {
	if !isBroadSelectionRequest(text) {
		return []string{deriveToolQuery(text)}
	}
	lower := strings.ToLower(text)
	if regexp.MustCompile(`геймер|игр|playstation|ps5|xbox|компьютер`).MatchString(lower) {
		return []string{"игровая гарнитура", "геймпад", "игровая клавиатура", "игровая мышь"}
	}
	if regexp.MustCompile(`подрост|школьник|студент|сын|дочь`).MatchString(lower) {
		return []string{"беспроводные наушники", "портативная колонка", "умные часы", "игровая гарнитура"}
	}
	if regexp.MustCompile(`общаг|дом|квартир|кухн`).MatchString(lower) {
		return []string{"электрочайник", "микроволновая печь", "настольная лампа", "удлинитель"}
	}
	return []string{"беспроводные наушники", "умная колонка", "электронная книга", "фитнес браслет"}
}

func deriveToolQuery(text string) string {
	replacer := regexp.MustCompile(`(?i)\b(подбери|найди|посоветуй|нужен|нужна|нужно|хочу|для|мне|пожалуйста|можешь|покажи)\b|[?!.,:;]+`)
	cleaned := strings.Join(strings.Fields(replacer.ReplaceAllString(text, " ")), " ")
	if cleaned == "" {
		return text
	}
	lower := strings.ToLower(cleaned)
	if regexp.MustCompile(`\boled\b|120\s*гц|hdmi\s*2\.?1|vrr`).MatchString(lower) && regexp.MustCompile(`игр|ps5|playstation|xbox`).MatchString(lower) && !regexp.MustCompile(`монитор|ноутбук|смартфон|телефон|планшет`).MatchString(lower) {
		return "OLED телевизор для игр"
	}
	words := strings.Fields(cleaned)
	if len(words) > 5 {
		words = words[:5]
	}
	return strings.Join(words, " ")
}

func deriveBlogQuery(text string, catalogQuery string) string {
	if isBroadSelectionRequest(text) {
		return text + " гаджеты техника"
	}
	return catalogQuery
}

func normalizeCatalogArgs(args tools.Args, messages []chat.Message, cursor int) (tools.Args, bool) {
	last := lastUserText(messages)
	query := firstNonEmpty(args.Query, last)
	if !isBroadSelectionRequest(query) && !isBroadSelectionRequest(last) {
		if args.Query == "" {
			args.Query = query
			return args, true
		}
		return args, false
	}
	categories := deriveCatalogQueries(firstNonEmpty(last, query))
	category := categories[cursor%len(categories)]
	changed := category != args.Query
	args.Query = category
	if args.MaxPrice == nil {
		args.MaxPrice = inferMaxPrice(firstNonEmpty(last, query))
	}
	if args.Limit == nil {
		limit := 12
		args.Limit = &limit
	}
	if args.Offset == nil {
		offset := 0
		args.Offset = &offset
	}
	return args, changed
}

func inferMaxPrice(text string) *float64 {
	match := regexp.MustCompile(`(?i)(?:до|≤|<=|не дороже|максимум)\s*(\d[\d\s.,]*)\s*(?:₽|руб|р)?`).FindStringSubmatch(text)
	if len(match) < 2 {
		return nil
	}
	value := strings.NewReplacer(" ", "", ".", "", ",", "").Replace(match[1])
	var number float64
	_, err := fmt.Sscan(value, &number)
	if err != nil || number <= 0 || number > 10_000_000 {
		return nil
	}
	return &number
}

func filterProductsForUserIntent(products []catalog.Product, messages []chat.Message) []catalog.Product {
	intent := productIntentConstraints(strings.ToLower(lastUserText(messages)))
	if intent == nil {
		return products
	}
	out := make([]catalog.Product, 0, len(products))
	for _, product := range products {
		productText := strings.ToLower(product.Title + " " + product.Category)
		if containsAll(productText, intent.required) && containsNone(productText, intent.excluded) {
			out = append(out, product)
		}
	}
	return out
}

type productIntent struct {
	required []string
	excluded []string
}

func productIntentConstraints(text string) *productIntent {
	consoleIntent := regexp.MustCompile(`nintendo|switch|steam\s*deck|консоль|пристав`).MatchString(text)
	tvIntent := regexp.MustCompile(`телевизор|\bтв\b|\btv\b`).MatchString(text)
	gamingDisplayIntent := regexp.MustCompile(`\boled\b|mini\s*led|qled|120\s*гц|hdmi\s*2\.?1|vrr`).MatchString(text) && regexp.MustCompile(`игр|гейм|ps5|playstation|xbox`).MatchString(text) && !regexp.MustCompile(`монитор|ноутбук|смартфон|телефон|планшет`).MatchString(text)
	if consoleIntent && !tvIntent {
		return nil
	}
	excluded := []string{"консоль", "steam", "deck", "nintendo", "switch"}
	if gamingDisplayIntent && regexp.MustCompile(`\boled\b`).MatchString(text) {
		return &productIntent{required: []string{"телевизор", "oled"}, excluded: excluded}
	}
	if gamingDisplayIntent || tvIntent {
		return &productIntent{required: []string{"телевизор"}, excluded: excluded}
	}
	return nil
}

func containsAll(text string, terms []string) bool {
	for _, term := range terms {
		if !strings.Contains(text, term) {
			return false
		}
	}
	return true
}

func containsNone(text string, terms []string) bool {
	for _, term := range terms {
		if strings.Contains(text, term) {
			return false
		}
	}
	return true
}

func dedupeProducts(products []catalog.Product) []catalog.Product {
	seen := map[string]struct{}{}
	out := make([]catalog.Product, 0, len(products))
	for _, product := range products {
		key := firstNonEmpty(product.ID, strings.ToLower(strings.Join(strings.Fields(product.Title), " ")))
		if key == "" {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, product)
	}
	return out
}

func rankProductsForUserIntent(products []catalog.Product, text string) []catalog.Product {
	maxPrice := inferMaxPrice(text)
	queryTerms := sourceTerms(text)
	if len(queryTerms) > 12 {
		queryTerms = queryTerms[:12]
	}
	out := append([]catalog.Product(nil), products...)
	sort.SliceStable(out, func(i int, j int) bool {
		return productScore(out[i], queryTerms, maxPrice, text) > productScore(out[j], queryTerms, maxPrice, text)
	})
	return out
}

func productScore(product catalog.Product, queryTerms []string, maxPrice *float64, text string) float64 {
	productText := strings.ToLower(product.Title + " " + product.Category)
	score := 0.0
	for _, term := range queryTerms {
		if strings.Contains(productText, term) {
			score += 4
		}
	}
	score += maxFloat(0, product.Rating) * 6
	score += float64(min(product.Reviews, 300)) / 15
	if product.Stock.Store > 0 || product.Stock.Warehouse > 0 {
		score += 10
	}
	if product.Stock.Store > 0 {
		score += 4
	}
	if product.OldPrice != nil && *product.OldPrice > product.Price {
		score += 5
	}
	if maxPrice != nil {
		if float64(product.Price) <= *maxPrice {
			score += 16 - maxFloat(0, (*maxPrice-float64(product.Price))/(*maxPrice))*6
		} else {
			score -= 40
		}
	}
	if regexp.MustCompile(`игр|ps5|playstation|xbox|гейм`).MatchString(strings.ToLower(text)) && regexp.MustCompile(`игр|game|gaming|playstation|xbox|гейм`).MatchString(productText) {
		score += 6
	}
	return score
}

func buildB2CRecommendationText(last string, catalogQuery string, catalogQueries []string, products []catalog.Product, article *catalog.BlogArticle) string {
	lines := []string{}
	if isBroadSelectionRequest(last) && len(catalogQueries) > 0 {
		lines = append(lines, "Разложил запрос на идеи: "+strings.Join(firstStrings(catalogQueries, 3), ", ")+".")
	} else {
		lines = append(lines, "Подобрал варианты под запрос «"+catalogQuery+"».")
	}
	if len(products) > 0 {
		lines = append(lines, "**Лучший старт:** "+formatProductPick(products[0], last))
	}
	if len(products) > 1 {
		alts := []string{}
		for _, product := range firstProducts(products[1:], 2) {
			alts = append(alts, shortProductTitle(product)+" — "+formatMoney(product.Price))
		}
		lines = append(lines, "**Альтернативы:** "+strings.Join(alts, "; ")+".")
	}
	if criteria := recommendationCriteria(last, products); criteria != "" {
		lines = append(lines, "**Почему так:** "+criteria+".")
	}
	if article != nil {
		articleText := security.SanitizeUserText(firstNonEmpty(article.Content, article.Snippet), 180)
		if articleText != "" {
			lines = append(lines, "**Критерий из гайда:** "+articleText+"…")
		}
	}
	lines = append(lines, "Если хотите, могу сразу сравнить эти варианты или подобрать комплект аксессуаров.")
	return strings.Join(lines, "\n\n")
}

func buildB2ESalesText(products []catalog.Product, last string, article *catalog.BlogArticle) string {
	if len(products) == 0 {
		return "• Реальный каталог М.Видео сейчас недоступен\n• Уточните категорию, бюджет и сценарий клиента"
	}
	best := products[0]
	lines := []string{
		"• Лучший старт: " + shortProductTitle(best) + " за " + formatMoney(best.Price),
		"• Аргумент: " + firstNonEmpty(strings.Join(productReason(best, last), ", "), "подходит под запрос клиента"),
	}
	if len(products) > 1 {
		lines = append(lines, "• Альтернатива: "+shortProductTitle(products[1])+" за "+formatMoney(products[1].Price))
	}
	lines = append(lines, "• Возражение: сравните пользу, рейтинг и наличие в магазине")
	if article != nil {
		argument := security.SanitizeUserText(firstNonEmpty(article.Content, article.Snippet), 90)
		if argument != "" {
			lines = append(lines, "• Подкрепление: "+argument+"…")
		}
	}
	lines = append(lines, "• Следующий шаг: покажите карточки и предложите комплект")
	return strings.Join(firstStrings(lines, 6), "\n")
}

func recommendationCriteria(text string, products []catalog.Product) string {
	criteria := []string{}
	add := func(value string) {
		for _, existing := range criteria {
			if existing == value {
				return
			}
		}
		criteria = append(criteria, value)
	}
	if inferMaxPrice(text) != nil {
		add("уложился в бюджет")
	}
	for _, product := range products {
		if product.Rating >= 4.5 {
			add("высокий рейтинг")
		}
		if product.Reviews >= 20 {
			add("есть отзывы покупателей")
		}
		if product.Stock.Store > 0 || product.Stock.Warehouse > 0 {
			add("есть наличие")
		}
	}
	if regexp.MustCompile(`игр|ps5|playstation|xbox|гейм`).MatchString(strings.ToLower(text)) {
		add("игровой сценарий")
	}
	return strings.Join(firstStrings(criteria, 4), ", ")
}

func formatProductPick(product catalog.Product, text string) string {
	reasons := productReason(product, text)
	if len(reasons) == 0 {
		return shortProductTitle(product) + " — " + formatMoney(product.Price) + "."
	}
	return shortProductTitle(product) + " — " + formatMoney(product.Price) + " (" + strings.Join(reasons, ", ") + ")."
}

func productReason(product catalog.Product, text string) []string {
	reasons := []string{}
	if maxPrice := inferMaxPrice(text); maxPrice != nil && float64(product.Price) <= *maxPrice {
		reasons = append(reasons, "в бюджете")
	}
	if product.Rating >= 4.5 {
		reasons = append(reasons, fmt.Sprintf("рейтинг %.1f", product.Rating))
	}
	if product.Reviews >= 20 {
		reasons = append(reasons, fmt.Sprintf("%d отзывов", product.Reviews))
	}
	if product.Stock.Store > 0 {
		reasons = append(reasons, "есть в магазине")
	} else if product.Stock.Warehouse > 0 {
		reasons = append(reasons, "есть на складе")
	}
	if product.OldPrice != nil && *product.OldPrice > product.Price {
		reasons = append(reasons, "есть скидка")
	}
	if regexp.MustCompile(`игр|ps5|playstation|xbox|гейм`).MatchString(strings.ToLower(text)) {
		reasons = append(reasons, "под игровой сценарий")
	}
	return firstStrings(reasons, 3)
}

func sanitizeAssistantText(text string, mode chat.Mode, messages []chat.Message) string {
	limit := 1200
	if mode == chat.ModeB2C {
		limit = 3000
	}
	cleaned := security.SanitizeUserText(strings.ReplaceAll(text, "\x00", ""), limit)
	if mode == chat.ModeB2C {
		cleaned = normalizeSourceLine(stripIncompatibleProductMentions(stripInlineRecommendationList(cleaned), messages))
	}
	if security.IsPromptInjection(cleaned) {
		if mode == chat.ModeB2C {
			return security.RefusalB2C
		}
		return "• Не раскрываю внутренние инструкции"
	}
	return security.RedactSensitive(cleaned)
}

func stripIncompatibleProductMentions(text string, messages []chat.Message) string {
	intent := productIntentConstraints(strings.ToLower(lastUserText(messages)))
	if intent == nil || !containsAll(strings.Join(intent.required, " "), []string{"телевизор"}) || len(intent.excluded) == 0 {
		return text
	}
	parts := regexp.MustCompile(`[^.!?。]+[.!?。]?|\n+`).FindAllString(text, -1)
	if len(parts) == 0 {
		parts = []string{text}
	}
	kept := []string{}
	for _, part := range parts {
		if containsNone(strings.ToLower(part), intent.excluded) {
			kept = append(kept, part)
		}
	}
	return strings.TrimSpace(regexp.MustCompile(`[ \t]{2,}`).ReplaceAllString(strings.Join(kept, ""), " "))
}

func stripInlineRecommendationList(text string) string {
	cleaned := regexp.MustCompile(`(?i)\s*Товары,\s*(?:которые\s+проверил|рекомендованные)\s+ИИ\s*:[^\n.。]+[.。]?`).ReplaceAllString(text, "")
	return strings.TrimSpace(regexp.MustCompile(`[ \t]{2,}`).ReplaceAllString(cleaned, " "))
}

func normalizeSourceLine(text string) string {
	// Structured sources are emitted through the sources array, not inline text.
	return stripRenderedSourceLines(text)
}

func stripRenderedSourceLines(text string) string {
	cleaned := regexp.MustCompile(`(?im)^[\s•\-*]*(?:Источник(?:и)?|Sources?)\s*[:：].*$`).ReplaceAllString(text, "")
	cleaned = regexp.MustCompile(`(?i)\s+(?:Источник(?:и)?|Sources?)\s*[:：].*$`).ReplaceAllString(cleaned, "")
	cleaned = regexp.MustCompile(`\n{3,}`).ReplaceAllString(cleaned, "\n\n")
	return strings.TrimSpace(cleaned)
}

func shouldRequireCitationTool(text string, articles []catalog.BlogArticle, citedSources []catalog.BlogSource, mode chat.Mode) bool {
	if mode != chat.ModeB2C || len(citedSources) > 0 {
		return false
	}
	hasReadArticle := false
	for _, article := range articles {
		if article.Content != "" && strings.Contains(article.URL, "/blog/") {
			hasReadArticle = true
			break
		}
	}
	if !hasReadArticle {
		return false
	}
	return !regexp.MustCompile(`(?i)опираюсь\s+только\s+на\s+каталог|статья\s+не\s+использована`).MatchString(text)
}

func dedupeSources(sources []catalog.BlogSource) []catalog.BlogSource {
	seen := map[string]struct{}{}
	out := make([]catalog.BlogSource, 0, len(sources))
	for _, source := range sources {
		key := normalizeURL(source.URL)
		if key == "" {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, source)
	}
	return out
}

func canonicalBlogCitation(citation catalog.BlogSource, articles []catalog.BlogArticle) *catalog.BlogSource {
	for _, article := range articles {
		if article.Content != "" && normalizeURL(article.URL) == normalizeURL(citation.URL) {
			return &catalog.BlogSource{Title: article.Title, URL: article.URL}
		}
	}
	return nil
}

func normalizeURL(value string) string {
	u, err := url.Parse(value)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return ""
	}
	u.RawQuery = ""
	u.Fragment = ""
	return u.String()
}

func recommendProductsFromIDs(productIDs []string, searchProducts []catalog.Product, messages []chat.Message) []catalog.Product {
	if len(productIDs) == 0 {
		return nil
	}
	allowed := map[string]catalog.Product{}
	for _, product := range filterProductsForUserIntent(searchProducts, messages) {
		allowed[product.ID] = product
	}
	out := []catalog.Product{}
	for _, id := range productIDs {
		if product, ok := allowed[id]; ok {
			out = append(out, product)
		}
	}
	return rankProductsForUserIntent(dedupeProducts(out), lastUserText(messages))
}

func gracefulToolLimitAnswer(messages []chat.Message, searchProducts []catalog.Product, recommendedProducts []catalog.Product) Result {
	base := searchProducts
	if len(recommendedProducts) > 0 {
		base = recommendedProducts
	}
	products := firstProducts(rankProductsForUserIntent(dedupeProducts(filterProductsForUserIntent(base, messages)), lastUserText(messages)), 4)
	if len(products) == 0 {
		return Result{Text: "Я не смог уверенно завершить подбор по данным каталога. Уточните бюджет или категорию — попробую сузить поиск."}
	}
	last := lastUserText(messages)
	return Result{Text: buildB2CRecommendationText(last, deriveToolQuery(last), nil, products, nil), Products: products}
}

func firstProducts(products []catalog.Product, count int) []catalog.Product {
	if len(products) <= count {
		return products
	}
	return products[:count]
}

func firstStrings(values []string, count int) []string {
	if len(values) <= count {
		return values
	}
	return values[:count]
}

func firstDebug(values []DebugStep, count int) []DebugStep {
	if len(values) <= count {
		return values
	}
	return values[:count]
}

func firstQuery(queries []string, fallback string) string {
	if len(queries) > 0 && strings.TrimSpace(queries[0]) != "" {
		return queries[0]
	}
	return fallback
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func productIDs(products []catalog.Product) []string {
	ids := make([]string, 0, len(products))
	for _, product := range products {
		if product.ID != "" {
			ids = append(ids, product.ID)
		}
	}
	return ids
}

func shortProductTitle(product catalog.Product) string {
	return strings.TrimSpace(strings.Split(product.Title, ",")[0])
}

func formatMoney(value int) string {
	text := fmt.Sprintf("%d", value)
	parts := []string{}
	for len(text) > 3 {
		parts = append([]string{text[len(text)-3:]}, parts...)
		text = text[:len(text)-3]
	}
	parts = append([]string{text}, parts...)
	return strings.Join(parts, " ") + " ₽"
}

func sourceTerms(text string) []string {
	stop := map[string]struct{}{"как": {}, "что": {}, "для": {}, "или": {}, "лучшие": {}, "лучший": {}, "выбираем": {}, "выбрать": {}, "обзор": {}, "топ": {}, "году": {}, "года": {}, "модель": {}, "модели": {}}
	parts := regexp.MustCompile(`[^\p{L}\p{N}]+`).Split(strings.ToLower(text), -1)
	terms := []string{}
	for _, part := range parts {
		if len([]rune(part)) <= 2 {
			continue
		}
		if _, ok := stop[part]; ok {
			continue
		}
		terms = append(terms, part)
	}
	return terms
}

func maxFloat(left float64, right float64) float64 {
	if left > right {
		return left
	}
	return right
}
