package tools

import (
	"context"
	"strings"

	catalog "github.com/nlypage/mvideo-ai-search/backend/internal/domain/catalog"
	"github.com/nlypage/mvideo-ai-search/backend/internal/domain/security"
)

// CatalogBackend is the tool registry dependency implemented by the M.Video client/service layer.
type CatalogBackend interface {
	Search(ctx context.Context, req catalog.SearchRequest) (catalog.SearchResult, error)
	SearchReviews(ctx context.Context, productID string, query string) ([]catalog.ReviewSummary, error)
	SearchBlog(ctx context.Context, query string) ([]catalog.BlogArticle, error)
}

// Args contains sanitized tool input values.
type Args struct {
	Query         string
	ProductID     string
	ProductIDs    []string
	RequiredTerms []string
	ExcludedTerms []string
	MinPrice      *float64
	MaxPrice      *float64
	Offset        *int
	Limit         *int
	Title         string
	URL           string
}

// Result is the JSON-serializable tool result shape used by the agent.
type Result struct {
	Products []catalog.Product       `json:"products,omitempty"`
	Reviews  []catalog.ReviewSummary `json:"reviews,omitempty"`
	Article  *catalog.BlogArticle    `json:"article,omitempty"`
	Articles []catalog.BlogArticle   `json:"articles,omitempty"`
	Title    string                  `json:"title,omitempty"`
	URL      string                  `json:"url,omitempty"`
	Snippet  string                  `json:"snippet,omitempty"`
	Citation *catalog.BlogSource     `json:"citation,omitempty"`
	Source   string                  `json:"source,omitempty"`
	Role     string                  `json:"role,omitempty"`
	Page     *catalog.Page           `json:"page,omitempty"`
	Error    string                  `json:"error,omitempty"`
}

// Registry runs allowlisted tools.
type Registry struct {
	backend CatalogBackend
}

// New creates a tool registry.
func New(backend CatalogBackend) *Registry {
	return &Registry{backend: backend}
}

// Run executes a tool by name.
func (r *Registry) Run(ctx context.Context, name string, args Args) (Result, error) {
	if r.backend == nil && name != "cite_blog_source" {
		return Result{Error: "tool backend unavailable"}, nil
	}
	sanitized := sanitizeArgs(args)
	switch name {
	case "search_catalog":
		return r.searchCatalog(ctx, sanitized)
	case "search_reviews":
		return r.searchReviews(ctx, sanitized)
	case "search_blog":
		return r.searchBlog(ctx, sanitized)
	case "cite_blog_source":
		return citeBlogSource(sanitized), nil
	case "recommend_products":
		// Product rehydration by IDs will be implemented with the upstream agent milestone.
		return Result{Error: "recommend_products is not implemented yet"}, nil
	default:
		return Result{Error: "unknown tool"}, nil
	}
}

func (r *Registry) searchCatalog(ctx context.Context, args Args) (Result, error) {
	if args.Query == "" {
		return Result{Error: "empty query"}, nil
	}
	result, err := r.backend.Search(ctx, catalog.SearchRequest{Query: args.Query, MinPrice: args.MinPrice, MaxPrice: args.MaxPrice, Offset: args.Offset, Limit: args.Limit})
	if err != nil {
		return Result{Error: "Не удалось получить товары из реального публичного каталога М.Видео: BFF каталога не вернул данные или заблокировал запрос."}, nil
	}
	if len(result.Products) == 0 {
		return Result{Error: "Не удалось получить товары из реального публичного каталога М.Видео: BFF каталога не вернул данные или заблокировал запрос."}, nil
	}
	return Result{Products: result.Products, Source: "live", Role: "catalog", Page: result.Page}, nil
}

func (r *Registry) searchReviews(ctx context.Context, args Args) (Result, error) {
	reviews, err := r.backend.SearchReviews(ctx, args.ProductID, args.Query)
	if err != nil {
		return Result{Error: "Не удалось получить релевантные отзывы покупателей М.Видео."}, nil
	}
	if len(reviews) == 0 {
		return Result{Error: "Не удалось получить релевантные отзывы покупателей М.Видео."}, nil
	}
	return Result{Reviews: reviews, Source: "live"}, nil
}

func (r *Registry) searchBlog(ctx context.Context, args Args) (Result, error) {
	if args.Query == "" {
		return Result{Error: "empty query"}, nil
	}
	articles, err := r.backend.SearchBlog(ctx, args.Query)
	if err != nil || len(articles) == 0 {
		return Result{Error: "Не удалось получить релевантную статью из реального публичного блога М.Видео."}, nil
	}
	article := articles[0]
	return Result{Article: &article, Articles: summarizeArticles(articles), Title: article.Title, URL: article.URL, Snippet: article.Snippet, Source: "live"}, nil
}

func citeBlogSource(args Args) Result {
	if args.Title == "" || args.URL == "" || !strings.Contains(args.URL, "/blog/") {
		return Result{Error: "invalid source"}
	}
	return Result{Citation: &catalog.BlogSource{Title: args.Title, URL: args.URL}, Source: "selected"}
}

func sanitizeArgs(args Args) Args {
	args.Query = security.SanitizeUserText(args.Query, 240)
	args.ProductID = security.SanitizeUserText(args.ProductID, 40)
	args.Title = security.SanitizeUserText(args.Title, 180)
	args.URL = security.SanitizeUserText(args.URL, 400)
	args.ProductIDs = sanitizeStrings(args.ProductIDs, 40, 8)
	args.RequiredTerms = sanitizeStrings(args.RequiredTerms, 40, 5)
	args.ExcludedTerms = sanitizeStrings(args.ExcludedTerms, 40, 5)
	return args
}

func sanitizeStrings(values []string, maxLength int, limit int) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, min(len(values), limit))
	for _, value := range values {
		clean := strings.ToLower(security.SanitizeUserText(value, maxLength))
		if clean == "" {
			continue
		}
		if _, ok := seen[clean]; ok {
			continue
		}
		seen[clean] = struct{}{}
		out = append(out, clean)
		if len(out) == limit {
			break
		}
	}
	return out
}

func summarizeArticles(articles []catalog.BlogArticle) []catalog.BlogArticle {
	out := make([]catalog.BlogArticle, 0, len(articles))
	for _, article := range articles {
		article.Content = ""
		article.ContentChars = 0
		article.ContentSource = ""
		out = append(out, article)
	}
	return out
}
