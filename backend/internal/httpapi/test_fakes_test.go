package httpapi

import (
	"context"

	catalogdomain "github.com/nlypage/mvideo-ai-search/backend/internal/domain/catalog"
	"github.com/nlypage/mvideo-ai-search/backend/internal/domain/chat"
	"github.com/nlypage/mvideo-ai-search/backend/internal/services/agent"
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

type fakeStreamingAgent struct {
	result agent.Result
	events []agent.StreamEvent
}

func (f *fakeStreamingAgent) Chat(ctx context.Context, messages []chat.Message, mode chat.Mode) (agent.Result, error) {
	select {
	case <-ctx.Done():
		return agent.Result{}, ctx.Err()
	default:
	}
	return f.result, nil
}

func (f *fakeStreamingAgent) Stream(ctx context.Context, messages []chat.Message, mode chat.Mode, emit func(agent.StreamEvent) error) (agent.Result, error) {
	select {
	case <-ctx.Done():
		return agent.Result{}, ctx.Err()
	default:
	}
	for _, event := range f.events {
		if err := emit(event); err != nil {
			return agent.Result{}, err
		}
	}
	return f.result, nil
}
