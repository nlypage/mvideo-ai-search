package mvideo

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"math"
	"net/http"
	"net/http/cookiejar"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/nlypage/mvideo-ai-search/backend/internal/config"
	catalog "github.com/nlypage/mvideo-ai-search/backend/internal/domain/catalog"
	"github.com/nlypage/mvideo-ai-search/backend/internal/services/cache"
)

var errPoisonPill = errors.New("mvideo anti-bot response")
var errEmptyResponse = errors.New("mvideo empty response")

// Client talks to public M.Video catalog BFF endpoints.
type Client struct {
	origin       string
	imageOrigin  string
	httpClient   *http.Client
	cacheOnce    sync.Once
	searchCache  cache.Store[catalog.SearchResult]
	blogCache    cache.Store[[]catalog.BlogArticle]
	reviewsCache cache.Store[[]catalog.ReviewSummary]
}

// New creates a M.Video client from runtime config.
func New(cfg config.Config) *Client {
	jar, _ := cookiejar.New(nil)
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConns = 100
	transport.MaxIdleConnsPerHost = 20
	transport.IdleConnTimeout = 90 * time.Second
	return &Client{
		origin:      strings.TrimRight(cfg.MVideoOrigin, "/"),
		imageOrigin: strings.TrimRight(cfg.MVideoImageOrigin, "/"),
		httpClient:  &http.Client{Timeout: cfg.MVideoRequestTimeout, Jar: jar, Transport: transport},
	}
}

func (c *Client) ensureCaches() {
	c.cacheOnce.Do(func() {
		const ttl = 5 * time.Minute
		if c.searchCache == nil {
			c.searchCache = cache.NewTTLStore[catalog.SearchResult](ttl)
		}
		if c.blogCache == nil {
			c.blogCache = cache.NewTTLStore[[]catalog.BlogArticle](ttl)
		}
		if c.reviewsCache == nil {
			c.reviewsCache = cache.NewTTLStore[[]catalog.ReviewSummary](ttl)
		}
	})
}

// Search searches products and hydrates details/prices.
func (c *Client) Search(ctx context.Context, req catalog.SearchRequest) (catalog.SearchResult, error) {
	query := strings.TrimSpace(req.Query)
	if query == "" {
		return catalog.SearchResult{Products: []catalog.Product{}, Source: "live"}, nil
	}
	offset := clampInt(req.Offset, 0, 0, 1000)
	limit := clampInt(req.Limit, 24, 1, 36)
	c.ensureCaches()
	cacheKey := searchCacheKey(query, req.MinPrice, req.MaxPrice, offset, limit)
	if cached, ok := c.searchCache.Get(cacheKey); ok {
		return cached, nil
	}
	payload, err := c.searchProducts(ctx, query, offset, limit, req.MinPrice, req.MaxPrice)
	page := &catalog.Page{Offset: offset, Limit: limit, Total: optionalPositiveInt(payload.Body.Total)}
	if payload.Body.CursorID != "" {
		if next := intOrZeroString(payload.Body.CursorID); next > offset {
			page.NextOffset = &next
		}
	} else if page.Total != nil && offset+limit < *page.Total {
		next := offset + limit
		page.NextOffset = &next
	}
	if err != nil {
		return catalog.SearchResult{Products: []catalog.Product{}, Source: "live", Page: page}, err
	}

	products := make([]catalog.Product, 0, len(payload.Body.Items))
	for _, item := range payload.Body.Items {
		product, ok := c.toProductFromListItem(item)
		if ok && matchesPrice(product, req.MinPrice, req.MaxPrice) {
			products = append(products, product)
		}
	}
	products = firstCatalogProducts(dedupeProducts(products), limit)
	result := catalog.SearchResult{Products: products, Source: "live", Page: page}
	c.searchCache.Set(cacheKey, result)
	return result, nil
}

func (c *Client) searchProducts(ctx context.Context, query string, offset int, limit int, minPrice *float64, maxPrice *float64) (productsResponse, error) {
	body := map[string]any{
		"limit":                 limit,
		"cursorId":              cursorID(offset),
		"enrich":                true,
		"sortBy":                "popularity",
		"sortDirection":         "desc",
		"isGettingBonusRoubles": true,
		"query":                 query,
	}
	if valuesID := nativePriceValuesID(minPrice, maxPrice); len(valuesID) > 0 {
		body["filters"] = []map[string]any{{"id": "price", "valuesId": valuesID}}
	}

	var payload productsResponse
	if err := c.fetchJSON(ctx, http.MethodPost, c.origin+"/bff/products", body, &payload); err != nil {
		if !errors.Is(err, errEmptyResponse) {
			return productsResponse{}, err
		}
		if warmErr := c.warmSession(ctx); warmErr != nil {
			return productsResponse{}, warmErr
		}
		if err := c.fetchJSON(ctx, http.MethodPost, c.origin+"/bff/products", body, &payload); err != nil {
			return productsResponse{}, err
		}
	}
	return payload, nil
}

func (c *Client) warmSession(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.origin+"/", nil)
	if err != nil {
		return fmt.Errorf("create warmup request: %w", err)
	}
	for key, value := range defaultHeaders(c.origin) {
		req.Header.Set(key, value)
	}
	req.Header.Set("accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
	res, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("mvideo warmup request: %w", err)
	}
	defer func() { _ = res.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("mvideo warmup status %d", res.StatusCode)
	}
	return nil
}

func (c *Client) fetchJSON(ctx context.Context, method string, endpoint string, body any, destination any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encode request: %w", err)
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	for key, value := range defaultHeaders(c.origin) {
		req.Header.Set(key, value)
	}
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}

	res, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("mvideo request: %w", err)
	}
	defer func() { _ = res.Body.Close() }()
	text, err := io.ReadAll(io.LimitReader(res.Body, 2<<20))
	if err != nil {
		return fmt.Errorf("read mvideo response: %w", err)
	}
	if isPoisonPill(string(text)) {
		return errPoisonPill
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("mvideo status %d", res.StatusCode)
	}
	if len(text) == 0 {
		return errEmptyResponse
	}
	if err := json.Unmarshal(text, destination); err != nil {
		return fmt.Errorf("decode mvideo json: %w", err)
	}
	return nil
}

func (c *Client) toProductFromListItem(item productListItem) (catalog.Product, bool) {
	id := strings.TrimSpace(item.ProductID)
	title := stripTags(item.Name)
	if id == "" || title == "" {
		return catalog.Product{}, false
	}
	salePrice := intOrZero(item.Price.SalePrice)
	basePrice := intOrZero(item.Price.BasePrice)
	oldPrice := (*int)(nil)
	if basePrice > 0 && salePrice > 0 && basePrice > salePrice {
		oldPrice = &basePrice
	}
	margin := 0
	return catalog.Product{
		ID:       id,
		Title:    title,
		Price:    firstPositive(salePrice, basePrice),
		OldPrice: oldPrice,
		Rating:   finiteFloat(item.Rating.Star),
		Reviews:  intOrZero(item.Rating.Count),
		Image:    c.imageURL(firstString(item.Images)),
		URL:      c.productListItemURL(item, title, id),
		Stock:    listItemAvailability(item),
		Margin:   &margin,
		Category: "Каталог",
	}, true
}

func (c *Client) productListItemURL(item productListItem, title string, id string) string {
	if strings.HasPrefix(item.Slug, "http") {
		return item.Slug
	}
	if strings.HasPrefix(item.Slug, "/") {
		return c.origin + item.Slug
	}
	if strings.TrimSpace(item.Slug) != "" {
		return c.origin + "/" + strings.TrimLeft(item.Slug, "/")
	}
	return c.origin + "/products/" + slugify(title) + "-" + id
}

func defaultHeaders(origin string) map[string]string {
	return map[string]string{
		"accept":               "application/json, text/plain, */*",
		"accept-language":      "ru-RU,ru;q=0.9,en;q=0.8",
		"user-agent":           "Mozilla/5.0 (Linux; Android 10; Pixel 4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
		"referer":              origin + "/",
		"origin":               origin,
		"x-set-application-id": "ea45c09a-880c-4b8e-a822-836dabb8988e",
		"cookie": strings.Join([]string{
			"MVID_CITY_ID=CityR_32",
			"MVID_REGION_ID=1",
			"MVID_REGION_SHOP=S002",
			"MVID_KLADR_ID=7700000000000",
			"MVID_TIMEZONE_OFFSET=3",
			"MVID_CATALOG_STATE=1",
			"MVID_WEBP_ENABLED=true",
			"MVID_ENVCLOUD=prod2",
			"deviceType=desktop",
			"searchType2=2",
		}, "; "),
	}
}

func nativePriceValuesID(minPrice *float64, maxPrice *float64) []string {
	if minPrice == nil && maxPrice == nil {
		return nil
	}
	minValue := 0
	if minPrice != nil {
		minValue = intOrZero(*minPrice)
	}
	if maxPrice == nil {
		if minValue <= 0 {
			return nil
		}
		return []string{fmt.Sprintf("%d-", minValue)}
	}
	maxValue := intOrZero(*maxPrice)
	if maxValue <= 0 {
		return nil
	}
	if minValue <= 0 {
		return []string{fmt.Sprintf("-%d", maxValue)}
	}
	return []string{fmt.Sprintf("%d-%d", minValue, maxValue)}
}

func cursorID(offset int) string {
	if offset <= 0 {
		return ""
	}
	return fmt.Sprint(offset)
}

func searchCacheKey(query string, minPrice *float64, maxPrice *float64, offset int, limit int) string {
	return strings.Join([]string{strings.ToLower(strings.TrimSpace(query)), priceKey(minPrice), priceKey(maxPrice), strconv.Itoa(offset), strconv.Itoa(limit)}, "|")
}

func priceKey(value *float64) string {
	if value == nil {
		return ""
	}
	return strconv.FormatFloat(*value, 'f', 2, 64)
}

func firstCatalogProducts(products []catalog.Product, limit int) []catalog.Product {
	if len(products) <= limit {
		return products
	}
	return products[:limit]
}

func matchesPrice(product catalog.Product, minPrice *float64, maxPrice *float64) bool {
	price := float64(product.Price)
	return (minPrice == nil || price >= *minPrice) && (maxPrice == nil || price <= *maxPrice)
}

func dedupeProducts(products []catalog.Product) []catalog.Product {
	seen := make(map[string]struct{}, len(products))
	out := make([]catalog.Product, 0, len(products))
	for _, product := range products {
		key := strings.ToLower(strings.Join(strings.Fields(product.Title), " "))
		if key == "" {
			key = product.ID
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, product)
	}
	return out
}

func listItemAvailability(item productListItem) catalog.Stock {
	if item.SoldOut || strings.EqualFold(item.Status, "soldout") || strings.EqualFold(item.Status, "notavailable") {
		return catalog.Stock{Warehouse: 0, Store: 0, StoreName: "Нет в наличии"}
	}
	return catalog.Stock{Warehouse: 1, Store: 1, StoreName: "Наличие на mvideo.ru"}
}

func (c *Client) imageURL(image string) string {
	clean := strings.ReplaceAll(html.UnescapeString(image), `\/`, "/")
	if clean == "" {
		return c.origin + "/favicon.ico"
	}
	if strings.HasPrefix(clean, "http") {
		return clean
	}
	if strings.HasPrefix(clean, "//") {
		return "https:" + clean
	}
	if strings.HasPrefix(clean, "/") {
		return c.imageOrigin + clean
	}
	return c.imageOrigin + "/" + clean
}

var nonSlugChars = regexp.MustCompile(`[^a-zA-Zа-яА-ЯёЁ0-9]+`)

func slugify(value string) string {
	return strings.Trim(nonSlugChars.ReplaceAllString(strings.ToLower(value), "-"), "-")
}

func stripTags(value string) string {
	var out strings.Builder
	inside := false
	for _, char := range value {
		switch char {
		case '<':
			inside = true
		case '>':
			inside = false
		default:
			if !inside {
				out.WriteRune(char)
			}
		}
	}
	return strings.Join(strings.Fields(html.UnescapeString(out.String())), " ")
}

func isPoisonPill(text string) bool {
	lower := strings.ToLower(text)
	return strings.Contains(lower, "запросы, поступающие с") ||
		strings.Contains(lower, "похожи на автоматические") ||
		strings.Contains(lower, "captcha") ||
		strings.Contains(lower, "too many requests") ||
		strings.Contains(lower, "checking your browser")
}

func clampInt(value *int, fallback int, minValue int, maxValue int) int {
	if value == nil || *value <= 0 {
		return fallback
	}
	if *value < minValue {
		return minValue
	}
	if *value > maxValue {
		return maxValue
	}
	return *value
}

func optionalPositiveInt(value int) *int {
	if value <= 0 {
		return nil
	}
	return &value
}

func intOrZero(value float64) int {
	if math.IsNaN(value) || math.IsInf(value, 0) || value <= 0 {
		return 0
	}
	return int(math.Round(value))
}

func intOrZeroString(value string) int {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || parsed <= 0 {
		return 0
	}
	return parsed
}

func finiteFloat(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	return value
}

func firstPositive(values ...int) int {
	for _, value := range values {
		if value > 0 {
			return value
		}
	}
	return 0
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func firstString(values []string) string {
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

type productsResponse struct {
	Body struct {
		Items    []productListItem `json:"items"`
		CursorID string            `json:"cursorId"`
		Total    int               `json:"total"`
	} `json:"body"`
}

type productListItem struct {
	ProductID string   `json:"productId"`
	Name      string   `json:"name"`
	Images    []string `json:"images"`
	Slug      string   `json:"slug"`
	Price     struct {
		BasePrice float64 `json:"basePrice"`
		SalePrice float64 `json:"salePrice"`
	} `json:"price"`
	Rating struct {
		Star  float64 `json:"star"`
		Count float64 `json:"count"`
	} `json:"rating"`
	Status  string `json:"status"`
	SoldOut bool   `json:"soldOut"`
}
