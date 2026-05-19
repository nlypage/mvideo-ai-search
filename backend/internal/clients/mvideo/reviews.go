package mvideo

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	catalog "github.com/nlypage/mvideo-ai-search/backend/internal/domain/catalog"
)

// SearchReviews returns review summaries by product ID or by first catalog results for query.
func (c *Client) SearchReviews(ctx context.Context, productID string, query string) ([]catalog.ReviewSummary, error) {
	productID = strings.TrimSpace(productID)
	query = strings.TrimSpace(query)
	cacheKey := strings.ToLower(productID + "|" + query)
	if cacheKey != "|" {
		c.ensureCaches()
		if cached, ok := c.reviewsCache.Get(cacheKey); ok {
			return cached, nil
		}
	}
	ids := []string{}
	if productID != "" {
		ids = []string{productID}
	} else if query != "" {
		result, err := c.Search(ctx, catalog.SearchRequest{Query: query})
		if err != nil {
			return nil, err
		}
		for _, product := range result.Products {
			ids = append(ids, product.ID)
			if len(ids) == 3 {
				break
			}
		}
	}
	if len(ids) == 0 {
		return []catalog.ReviewSummary{}, nil
	}

	reviews, err := c.productReviewsBatch(ctx, ids)
	if err != nil {
		return nil, err
	}
	if cacheKey != "|" {
		c.ensureCaches()
		c.reviewsCache.Set(cacheKey, reviews)
	}
	return reviews, nil
}

func (c *Client) productReviewsBatch(ctx context.Context, ids []string) ([]catalog.ReviewSummary, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	type reviewResult struct {
		index  int
		review catalog.ReviewSummary
		ok     bool
		err    error
	}
	resultCh := make(chan reviewResult, len(ids))
	for index, id := range ids {
		go func(index int, id string) {
			review, ok, err := c.productReviews(ctx, id)
			resultCh <- reviewResult{index: index, review: review, ok: ok, err: err}
		}(index, id)
	}
	ordered := make([]reviewResult, len(ids))
	for range ids {
		result := <-resultCh
		if result.err != nil {
			cancel()
			return nil, result.err
		}
		ordered[result.index] = result
	}
	reviews := make([]catalog.ReviewSummary, 0, len(ids))
	for _, result := range ordered {
		if result.ok {
			reviews = append(reviews, result.review)
		}
	}
	return reviews, nil
}

func (c *Client) productReviews(ctx context.Context, productID string) (catalog.ReviewSummary, bool, error) {
	endpoint, err := url.Parse(c.origin + "/bff/reviews/aplaut")
	if err != nil {
		return catalog.ReviewSummary{}, false, fmt.Errorf("parse reviews url: %w", err)
	}
	params := endpoint.Query()
	params.Set("context", "product")
	params.Set("contextId", productID)
	params.Set("sort", "helpfulness:desc")
	params.Set("perPage", "5")
	endpoint.RawQuery = params.Encode()

	var payload reviewsResponse
	if err := c.fetchJSON(ctx, http.MethodGet, endpoint.String(), nil, &payload); err != nil {
		return catalog.ReviewSummary{}, false, err
	}
	if len(payload.Body.Reviews) == 0 {
		return catalog.ReviewSummary{}, false, nil
	}

	summary := catalog.ReviewSummary{
		ProductID:        productID,
		TotalNumber:      intOrZero(payload.Body.TotalNumber),
		RecommendPercent: intOrZero(payload.Body.RecommendPercent),
		TotalRating:      finiteFloat(payload.Body.TotalRating),
		Snippets:         make([]string, 0, 3),
		Benefits:         make([]string, 0, 3),
		Drawbacks:        make([]string, 0, 3),
	}
	for _, item := range payload.Body.Reviews {
		appendLimited(&summary.Snippets, stripTags(item.Text), 3)
		appendLimited(&summary.Benefits, stripTags(item.Benefits), 3)
		appendLimited(&summary.Drawbacks, stripTags(item.Drawbacks), 3)
	}
	return summary, true, nil
}

func appendLimited(values *[]string, value string, limit int) {
	if len(*values) >= limit || strings.TrimSpace(value) == "" {
		return
	}
	*values = append(*values, strings.TrimSpace(value))
}

type reviewsResponse struct {
	Body struct {
		TotalNumber      float64 `json:"totalNumber"`
		RecommendPercent float64 `json:"recommendPercent"`
		TotalRating      float64 `json:"totalRating"`
		Reviews          []struct {
			Text      string `json:"text"`
			Benefits  string `json:"benefits"`
			Drawbacks string `json:"drawbacks"`
		} `json:"reviews"`
	} `json:"body"`
}
