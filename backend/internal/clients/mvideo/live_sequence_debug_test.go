package mvideo

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/nlypage/mvideo-ai-search/backend/internal/config"
	"github.com/nlypage/mvideo-ai-search/backend/internal/services/tools"
)

func TestLiveGiftCatalogSequence(t *testing.T) {
	if os.Getenv("MVIDEO_LIVE_TEST") != "1" {
		t.Skip("set MVIDEO_LIVE_TEST=1 to run live M.Video catalog sequence smoke")
	}
	client := New(config.Load(nil))
	registry := tools.New(client)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	queries := []string{"беспроводные наушники", "портативная колонка", "умные часы", "игровая гарнитура"}
	maxPrice := 5000.0
	limit := 5
	for _, query := range queries {
		result, err := registry.Run(ctx, "search_catalog", tools.Args{Query: query, MaxPrice: &maxPrice, Limit: &limit})
		t.Logf("query=%q err=%v toolError=%q products=%d page=%+v", query, err, result.Error, len(result.Products), result.Page)
		if err != nil || result.Error != "" || len(result.Products) == 0 {
			t.Fatalf("search_catalog %q failed: err=%v toolError=%q products=%d", query, err, result.Error, len(result.Products))
		}
		for _, product := range result.Products {
			if product.Price > int(maxPrice) {
				t.Fatalf("search_catalog %q returned over-budget product: %+v", query, product)
			}
		}
	}
}
