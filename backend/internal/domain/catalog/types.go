package catalog

// Product is the public product card contract returned to the frontend.
type Product struct {
	ID            string         `json:"id"`
	Title         string         `json:"title"`
	Price         int            `json:"price"`
	OldPrice      *int           `json:"oldPrice,omitempty"`
	Rating        float64        `json:"rating"`
	Reviews       int            `json:"reviews"`
	Image         string         `json:"image"`
	URL           string         `json:"url"`
	Stock         Stock          `json:"stock"`
	Margin        *int           `json:"margin,omitempty"`
	Category      string         `json:"category"`
	ReviewSummary *ReviewSummary `json:"reviewSummary,omitempty"`
}

// Stock describes M.Video product availability.
type Stock struct {
	Warehouse int    `json:"warehouse"`
	Store     int    `json:"store"`
	StoreName string `json:"storeName"`
}

// Page describes catalog pagination metadata.
type Page struct {
	Offset     int  `json:"offset"`
	Limit      int  `json:"limit"`
	Total      *int `json:"total,omitempty"`
	NextOffset *int `json:"nextOffset,omitempty"`
}

// SearchRequest contains sanitized catalog search parameters.
type SearchRequest struct {
	Query    string
	MinPrice *float64
	MaxPrice *float64
	Offset   *int
	Limit    *int
}

// SearchResult is the service-level catalog search response.
type SearchResult struct {
	Products []Product
	Source   string
	Page     *Page
}

// ReviewSummary summarizes public customer reviews for one product.
type ReviewSummary struct {
	ProductID        string   `json:"productId"`
	TotalNumber      int      `json:"totalNumber"`
	RecommendPercent int      `json:"recommendPercent"`
	TotalRating      float64  `json:"totalRating"`
	Snippets         []string `json:"snippets"`
	Benefits         []string `json:"benefits"`
	Drawbacks        []string `json:"drawbacks"`
}

// BlogArticle is a public M.Video blog article candidate or hydrated source.
type BlogArticle struct {
	Title         string   `json:"title"`
	URL           string   `json:"url"`
	Snippet       string   `json:"snippet"`
	Content       string   `json:"content,omitempty"`
	ContentChars  int      `json:"contentChars,omitempty"`
	ContentSource string   `json:"contentSource,omitempty"`
	Score         *float64 `json:"score,omitempty"`
	Relevance     string   `json:"relevance,omitempty"`
}

// BlogSource is a structured citation selected from blog search results.
type BlogSource struct {
	Title string `json:"title"`
	URL   string `json:"url"`
}
