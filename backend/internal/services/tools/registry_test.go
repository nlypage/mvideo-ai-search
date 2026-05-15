package tools

import (
	"context"
	"errors"
	"testing"

	catalog "github.com/nlypage/mvideo-ai-search/backend/internal/domain/catalog"
)

type fakeBackend struct {
	searchReq catalog.SearchRequest
	err       error
}

func (f *fakeBackend) Search(ctx context.Context, req catalog.SearchRequest) (catalog.SearchResult, error) {
	f.searchReq = req
	if f.err != nil {
		return catalog.SearchResult{}, f.err
	}
	return catalog.SearchResult{Products: []catalog.Product{{ID: "1", Title: "TV", Price: 100}}, Source: "live", Page: &catalog.Page{Limit: 24}}, nil
}

func (f *fakeBackend) SearchReviews(ctx context.Context, productID string, query string) ([]catalog.ReviewSummary, error) {
	if f.err != nil {
		return nil, f.err
	}
	return []catalog.ReviewSummary{{ProductID: productID, TotalRating: 4.5}}, nil
}

func (f *fakeBackend) SearchBlog(ctx context.Context, query string) ([]catalog.BlogArticle, error) {
	if f.err != nil {
		return nil, f.err
	}
	return []catalog.BlogArticle{{Title: "Как выбрать HDMI", URL: "https://www.mvideo.ru/blog/test", Snippet: "HDMI", Content: "long content", ContentChars: 1000, ContentSource: "wordpress"}}, nil
}

func TestRunSearchCatalog(t *testing.T) {
	backend := &fakeBackend{}
	registry := New(backend)
	minPrice := 100.0
	result, err := registry.Run(context.Background(), "search_catalog", Args{Query: " TV\n", MinPrice: &minPrice})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if len(result.Products) != 1 || result.Source != "live" || result.Role != "catalog" {
		t.Fatalf("unexpected result: %+v", result)
	}
	if backend.searchReq.Query != "TV" || backend.searchReq.MinPrice == nil || *backend.searchReq.MinPrice != 100 {
		t.Fatalf("unexpected request: %+v", backend.searchReq)
	}
}

func TestRunSearchBlogSummarizesArticleList(t *testing.T) {
	registry := New(&fakeBackend{})
	result, err := registry.Run(context.Background(), "search_blog", Args{Query: "HDMI"})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result.Article == nil || result.Article.Content == "" {
		t.Fatalf("article was not hydrated: %+v", result)
	}
	if len(result.Articles) != 1 || result.Articles[0].Content != "" {
		t.Fatalf("articles should be summarized: %+v", result.Articles)
	}
}

func TestRunErrorShapes(t *testing.T) {
	registry := New(&fakeBackend{err: errors.New("blocked")})
	result, err := registry.Run(context.Background(), "search_reviews", Args{ProductID: "1"})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result.Error == "" {
		t.Fatalf("expected safe error result: %+v", result)
	}

	result, err = registry.Run(context.Background(), "cite_blog_source", Args{Title: "T", URL: "https://www.mvideo.ru/blog/x"})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result.Citation == nil || result.Source != "selected" {
		t.Fatalf("unexpected citation: %+v", result)
	}
}
