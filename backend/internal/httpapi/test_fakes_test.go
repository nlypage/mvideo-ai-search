package httpapi

import (
	"context"

	catalogdomain "github.com/nlypage/mvideo-ai-search/backend/internal/domain/catalog"
)

type fakeCatalogSearcher struct {
	request catalogdomain.SearchRequest
	result  catalogdomain.SearchResult
	err     error
}

func (f *fakeCatalogSearcher) Search(ctx context.Context, req catalogdomain.SearchRequest) (catalogdomain.SearchResult, error) {
	select {
	case <-ctx.Done():
		return catalogdomain.SearchResult{}, ctx.Err()
	default:
	}
	f.request = req
	return f.result, f.err
}
