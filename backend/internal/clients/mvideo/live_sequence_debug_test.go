package mvideo

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/nlypage/mvideo-ai-search/backend/internal/config"
	catalog "github.com/nlypage/mvideo-ai-search/backend/internal/domain/catalog"
)

func TestLiveGiftCatalogSequence(t *testing.T) {
	if os.Getenv("MVIDEO_LIVE_TEST") != "1" {
		t.Skip("set MVIDEO_LIVE_TEST=1 to run live M.Video catalog sequence smoke")
	}
	client := New(config.Load(nil))
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	queries := []string{"беспроводные наушники", "портативная колонка", "умные часы", "игровая гарнитура"}
	maxPrice := 5000.0
	limit := 5
	for _, query := range queries {
		result, err := client.Search(ctx, catalog.SearchRequest{Query: query, MaxPrice: &maxPrice, Limit: &limit})
		t.Logf("query=%q err=%v products=%d page=%+v", query, err, len(result.Products), result.Page)
		if err != nil || len(result.Products) == 0 {
			t.Fatalf("Search %q failed: err=%v products=%d", query, err, len(result.Products))
		}
	}
}
