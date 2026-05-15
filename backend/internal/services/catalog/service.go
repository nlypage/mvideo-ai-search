package catalog

import (
	"context"
	"errors"

	domain "github.com/nlypage/mvideo-ai-search/backend/internal/domain/catalog"
)

// ErrUnavailable means the live M.Video catalog client is not wired yet.
var ErrUnavailable = errors.New("catalog service unavailable")

// Searcher is the downstream live catalog client contract.
type Searcher interface {
	Search(ctx context.Context, req domain.SearchRequest) (domain.SearchResult, error)
}

// Service is the catalog application service.
type Service struct {
	searcher Searcher
}

// New creates the catalog service.
func New(searcher Searcher) *Service {
	return &Service{searcher: searcher}
}

// Search searches products in the live catalog.
func (s *Service) Search(ctx context.Context, req domain.SearchRequest) (domain.SearchResult, error) {
	select {
	case <-ctx.Done():
		return domain.SearchResult{}, ctx.Err()
	default:
	}
	if s.searcher == nil {
		return domain.SearchResult{Products: []domain.Product{}, Source: "live"}, ErrUnavailable
	}
	return s.searcher.Search(ctx, req)
}
