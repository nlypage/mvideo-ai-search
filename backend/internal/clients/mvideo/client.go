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
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/nlypage/mvideo-ai-search/backend/internal/config"
	catalog "github.com/nlypage/mvideo-ai-search/backend/internal/domain/catalog"
)

var errPoisonPill = errors.New("mvideo anti-bot response")

// Client talks to public M.Video catalog BFF endpoints.
type Client struct {
	origin      string
	imageOrigin string
	httpClient  *http.Client
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

// Search searches products and hydrates details/prices.
func (c *Client) Search(ctx context.Context, req catalog.SearchRequest) (catalog.SearchResult, error) {
	query := strings.TrimSpace(req.Query)
	if query == "" {
		return catalog.SearchResult{Products: []catalog.Product{}, Source: "live"}, nil
	}
	offset := clampInt(req.Offset, 0, 0, 1000)
	limit := clampInt(req.Limit, 24, 1, 36)
	searchLimit := catalogSearchLimit(limit, req.MaxPrice)
	maxPages := catalogSearchPages(req.MaxPrice)

	products := make([]catalog.Product, 0, limit)
	var total *int
	lastOffset := offset
	lastLimit := searchLimit
	for pageIndex := 0; pageIndex < maxPages && len(products) < limit; pageIndex++ {
		currentOffset := offset + pageIndex*searchLimit
		lastOffset = currentOffset
		lastLimit = searchLimit
		ids, pageTotal, err := c.searchProductIDs(ctx, query, currentOffset, searchLimit)
		if total == nil {
			total = pageTotal
		}
		if err != nil {
			if pageIndex == 0 {
				return catalog.SearchResult{Products: []catalog.Product{}, Source: "live", Page: &catalog.Page{Offset: offset, Limit: limit, Total: total}}, err
			}
			break
		}
		if len(ids) == 0 {
			break
		}

		details, prices, err := c.hydrateProducts(ctx, ids)
		if err != nil {
			if pageIndex == 0 {
				return catalog.SearchResult{}, err
			}
			break
		}

		for _, detail := range details {
			product, ok := c.toProduct(detail, prices[detail.ProductID])
			if ok && matchesPrice(product, req.MinPrice, req.MaxPrice) {
				products = append(products, product)
			}
		}
		products = dedupeProducts(products)
		if req.MaxPrice != nil && len(products) > 0 {
			break
		}
		if total == nil || currentOffset+searchLimit >= *total {
			break
		}
	}
	products = firstCatalogProducts(products, limit)

	page := &catalog.Page{Offset: offset, Limit: limit, Total: total}
	if total != nil && lastOffset+lastLimit < *total {
		next := lastOffset + lastLimit
		page.NextOffset = &next
	}
	return catalog.SearchResult{Products: products, Source: "live", Page: page}, nil
}

func (c *Client) hydrateProducts(ctx context.Context, ids []string) ([]detail, map[string]price, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	type detailsResult struct {
		items []detail
		err   error
	}
	type pricesResult struct {
		items map[string]price
		err   error
	}
	detailsCh := make(chan detailsResult, 1)
	pricesCh := make(chan pricesResult, 1)
	go func() {
		items, err := c.productDetails(ctx, ids)
		detailsCh <- detailsResult{items: items, err: err}
	}()
	go func() {
		items, err := c.productPrices(ctx, ids)
		pricesCh <- pricesResult{items: items, err: err}
	}()

	detailsRes := <-detailsCh
	if detailsRes.err != nil {
		cancel()
		<-pricesCh
		return nil, nil, detailsRes.err
	}
	pricesRes := <-pricesCh
	if pricesRes.err != nil {
		return nil, nil, pricesRes.err
	}
	return detailsRes.items, pricesRes.items, nil
}

func (c *Client) searchProductIDs(ctx context.Context, query string, offset int, limit int) ([]string, *int, error) {
	endpoint, err := url.Parse(c.origin + "/bff/products/v2/search")
	if err != nil {
		return nil, nil, fmt.Errorf("parse search url: %w", err)
	}
	params := endpoint.Query()
	params.Set("query", query)
	params.Set("offset", fmt.Sprint(offset))
	params.Set("limit", fmt.Sprint(limit))
	endpoint.RawQuery = params.Encode()

	var payload searchResponse
	if err := c.fetchJSON(ctx, http.MethodGet, endpoint.String(), nil, &payload); err != nil {
		return nil, nil, err
	}
	ids := uniqueStrings(payload.Body.Products)
	return ids, optionalPositiveInt(payload.Body.Total), nil
}

func (c *Client) productDetails(ctx context.Context, ids []string) ([]detail, error) {
	body := map[string]any{
		"productIds":       ids,
		"mediaTypes":       []string{"images"},
		"category":         true,
		"status":           true,
		"brand":            true,
		"propertyTypes":    []string{"KEY"},
		"propertiesConfig": map[string]int{"propertiesPortionSize": 6},
		"multioffer":       false,
	}
	var payload detailsResponse
	if err := c.fetchJSON(ctx, http.MethodPost, c.origin+"/bff/product-details/list", body, &payload); err != nil {
		return nil, err
	}
	return payload.Body.Products, nil
}

func (c *Client) productPrices(ctx context.Context, ids []string) (map[string]price, error) {
	endpoint, err := url.Parse(c.origin + "/bff/products/prices")
	if err != nil {
		return nil, fmt.Errorf("parse prices url: %w", err)
	}
	params := endpoint.Query()
	params.Set("productIds", strings.Join(ids, ","))
	params.Set("addBonusRubles", "true")
	params.Set("isPromoApplied", "true")
	endpoint.RawQuery = params.Encode()

	var payload pricesResponse
	if err := c.fetchJSON(ctx, http.MethodGet, endpoint.String(), nil, &payload); err != nil {
		return nil, err
	}
	out := make(map[string]price, len(payload.Body.MaterialPrices))
	for _, item := range payload.Body.MaterialPrices {
		out[item.ProductID] = item
	}
	return out, nil
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
	if err := json.Unmarshal(text, destination); err != nil {
		return fmt.Errorf("decode mvideo json: %w", err)
	}
	return nil
}

func (c *Client) toProduct(item detail, itemPrice price) (catalog.Product, bool) {
	id := strings.TrimSpace(item.ProductID)
	title := stripTags(item.Name)
	if id == "" || title == "" {
		return catalog.Product{}, false
	}
	salePrice := intOrZero(itemPrice.Price.SalePrice)
	if salePrice == 0 {
		salePrice = intOrZero(itemPrice.Price.BasePromoPrice)
	}
	basePrice := intOrZero(itemPrice.Price.BasePrice)
	oldPrice := (*int)(nil)
	if basePrice > 0 && salePrice > 0 && basePrice > salePrice {
		oldPrice = &basePrice
	}
	category := strings.Join(nonEmpty(item.Category.Name, item.BrandName), " · ")
	if category == "" {
		category = "Каталог"
	}
	margin := 0
	return catalog.Product{
		ID:       id,
		Title:    title,
		Price:    firstPositive(salePrice, basePrice),
		OldPrice: oldPrice,
		Rating:   finiteFloat(item.Rating.Star),
		Reviews:  intOrZero(item.Rating.Count),
		Image:    c.imageURL(firstNonEmpty(item.Image, firstString(item.Images))),
		URL:      c.origin + "/products/" + firstNonEmpty(item.NameTranslit, slugify(title)) + "-" + id,
		Stock:    availability(item),
		Margin:   &margin,
		Category: category,
	}, true
}

func defaultHeaders(origin string) map[string]string {
	return map[string]string{
		"accept":               "application/json, text/plain, */*",
		"accept-language":      "ru-RU,ru;q=0.9,en;q=0.8",
		"user-agent":           "Mozilla/5.0 (Linux; Android 10; Pixel 4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
		"referer":              origin + "/",
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

func catalogSearchLimit(limit int, maxPrice *float64) int {
	if maxPrice != nil && limit < 36 {
		return 36
	}
	return limit
}

func catalogSearchPages(maxPrice *float64) int {
	if maxPrice != nil {
		return 4
	}
	return 1
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

func availability(item detail) catalog.Stock {
	if item.Status.SoldOut {
		return catalog.Stock{Warehouse: 0, Store: 0, StoreName: "Нет в наличии"}
	}
	if item.Status.AvailableOnlyInRetailStore {
		return catalog.Stock{Warehouse: 0, Store: 1, StoreName: "Только в магазине"}
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

func uniqueStrings(values []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	return out
}

func intOrZero(value float64) int {
	if math.IsNaN(value) || math.IsInf(value, 0) || value <= 0 {
		return 0
	}
	return int(math.Round(value))
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

func nonEmpty(values ...string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			out = append(out, strings.TrimSpace(value))
		}
	}
	return out
}

type searchResponse struct {
	Body struct {
		Total    int      `json:"total"`
		Products []string `json:"products"`
	} `json:"body"`
}

type detailsResponse struct {
	Body struct {
		Products []detail `json:"products"`
	} `json:"body"`
}

type pricesResponse struct {
	Body struct {
		MaterialPrices []price `json:"materialPrices"`
	} `json:"body"`
}

type detail struct {
	ProductID    string   `json:"productId"`
	Name         string   `json:"name"`
	NameTranslit string   `json:"nameTranslit"`
	Image        string   `json:"image"`
	Images       []string `json:"images"`
	BrandName    string   `json:"brandName"`
	Category     struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"category"`
	Rating struct {
		Star  float64 `json:"star"`
		Count float64 `json:"count"`
	} `json:"rating"`
	Status struct {
		SoldOut                    bool `json:"soldOut"`
		AvailableOnlyInRetailStore bool `json:"availableOnlyInRetailStore"`
	} `json:"status"`
}

type price struct {
	ProductID string `json:"productId"`
	Price     struct {
		BasePrice      float64 `json:"basePrice"`
		SalePrice      float64 `json:"salePrice"`
		BasePromoPrice float64 `json:"basePromoPrice"`
	} `json:"price"`
}
