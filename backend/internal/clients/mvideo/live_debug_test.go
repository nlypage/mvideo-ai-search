package mvideo

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/nlypage/mvideo-ai-search/backend/internal/config"
	catalog "github.com/nlypage/mvideo-ai-search/backend/internal/domain/catalog"
	"github.com/nlypage/mvideo-ai-search/backend/internal/services/tools"
)

func TestLiveToolsSmoke(t *testing.T) {
	if os.Getenv("MVIDEO_LIVE_TEST") != "1" {
		t.Skip("set MVIDEO_LIVE_TEST=1 to run live M.Video tool smoke")
	}
	if testing.Short() {
		t.Skip("live tool smoke skipped in short mode")
	}
	client := New(config.Load(nil))
	registry := tools.New(client)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	catalogResult, err := registry.Run(ctx, "search_catalog", tools.Args{Query: "телевизор"})
	if err != nil {
		t.Fatalf("search_catalog returned Go error: %v", err)
	}
	if catalogResult.Error != "" || len(catalogResult.Products) == 0 {
		t.Fatalf("search_catalog failed: error=%q products=%d", catalogResult.Error, len(catalogResult.Products))
	}
	t.Logf("search_catalog ok: products=%d first=%q", len(catalogResult.Products), catalogResult.Products[0].Title)

	blogResult, err := registry.Run(ctx, "search_blog", tools.Args{Query: "телевизор"})
	if err != nil {
		t.Fatalf("search_blog returned Go error: %v", err)
	}
	if blogResult.Error != "" || blogResult.Article == nil || blogResult.Article.Content == "" {
		t.Fatalf("search_blog failed: error=%q article=%+v", blogResult.Error, blogResult.Article)
	}
	t.Logf("search_blog ok: title=%q content=%d", blogResult.Article.Title, len(blogResult.Article.Content))

	if summary := catalogResult.Products[0].ReviewSummary; summary != nil {
		t.Logf("catalog review summary ok/non-fatal: rating=%.1f productId=%s", summary.TotalRating, catalogResult.Products[0].ID)
	}
}

func TestLiveClientSearchDirect(t *testing.T) {
	if os.Getenv("MVIDEO_LIVE_TEST") != "1" {
		t.Skip("set MVIDEO_LIVE_TEST=1 to run live M.Video client smoke")
	}
	client := New(config.Load(nil))
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	result, err := client.Search(ctx, catalog.SearchRequest{Query: "телевизор"})
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	if len(result.Products) == 0 {
		t.Fatalf("Search() products = 0 page=%+v", result.Page)
	}
}
