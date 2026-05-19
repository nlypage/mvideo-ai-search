package mvideo

import (
	"context"
	"fmt"
	"html"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	catalog "github.com/nlypage/mvideo-ai-search/backend/internal/domain/catalog"
)

const blogArticleContentLimit = 4_000

// SearchBlog searches public M.Video WordPress APIs and hydrates the top candidate.
func (c *Client) SearchBlog(ctx context.Context, query string) ([]catalog.BlogArticle, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return []catalog.BlogArticle{}, nil
	}
	c.ensureCaches()
	cacheKey := strings.ToLower(query)
	if cached, ok := c.blogCache.Get(cacheKey); ok {
		return cached, nil
	}
	articles, err := c.fetchBlogCandidates(ctx, query)
	if err != nil {
		return nil, err
	}
	articles = rankBlogArticles(articles, query)
	if len(articles) == 0 {
		return []catalog.BlogArticle{}, nil
	}
	hydrated, err := c.hydrateBlogArticle(ctx, articles[0])
	if err == nil {
		articles[0] = hydrated
	}
	c.blogCache.Set(cacheKey, articles)
	return articles, nil
}

func (c *Client) fetchBlogCandidates(ctx context.Context, query string) ([]catalog.BlogArticle, error) {
	type blogResult struct {
		articles []catalog.BlogArticle
		err      error
	}
	postsCh := make(chan blogResult, 1)
	searchCh := make(chan blogResult, 1)
	go func() {
		articles, err := c.fetchBlogPosts(ctx, query)
		postsCh <- blogResult{articles: articles, err: err}
	}()
	go func() {
		articles, err := c.fetchBlogSearch(ctx, query)
		searchCh <- blogResult{articles: articles, err: err}
	}()
	posts := <-postsCh
	search := <-searchCh
	if posts.err != nil && search.err != nil {
		return nil, posts.err
	}
	articles := []catalog.BlogArticle{}
	if posts.err == nil {
		articles = append(articles, posts.articles...)
	}
	if search.err == nil {
		articles = append(articles, search.articles...)
	}
	return articles, nil
}

func (c *Client) fetchBlogPosts(ctx context.Context, query string) ([]catalog.BlogArticle, error) {
	endpoint, err := url.Parse(c.origin + "/blog/wp-json/wp/v2/posts")
	if err != nil {
		return nil, fmt.Errorf("parse blog posts url: %w", err)
	}
	params := endpoint.Query()
	params.Set("search", query)
	params.Set("per_page", "8")
	params.Set("_fields", "link,title,excerpt")
	endpoint.RawQuery = params.Encode()

	var items []wordpressPost
	if err := c.fetchJSON(ctx, http.MethodGet, endpoint.String(), nil, &items); err != nil {
		return nil, err
	}
	articles := make([]catalog.BlogArticle, 0, len(items))
	for _, item := range items {
		if item.Link == "" || item.Title.Rendered == "" {
			continue
		}
		articles = append(articles, catalog.BlogArticle{
			Title:   stripTags(item.Title.Rendered),
			URL:     c.absoluteMVideoURL(item.Link),
			Snippet: truncate(stripTags(firstNonEmpty(item.Excerpt.Rendered, item.Title.Rendered)), 260),
		})
	}
	return articles, nil
}

func (c *Client) fetchBlogSearch(ctx context.Context, query string) ([]catalog.BlogArticle, error) {
	endpoint, err := url.Parse(c.origin + "/blog/wp-json/wp/v2/search")
	if err != nil {
		return nil, fmt.Errorf("parse blog search url: %w", err)
	}
	params := endpoint.Query()
	params.Set("search", query)
	params.Set("per_page", "8")
	endpoint.RawQuery = params.Encode()

	var items []wordpressSearch
	if err := c.fetchJSON(ctx, http.MethodGet, endpoint.String(), nil, &items); err != nil {
		return nil, err
	}
	articles := make([]catalog.BlogArticle, 0, len(items))
	for _, item := range items {
		if item.Subtype != "post" || item.URL == "" || item.Title == "" {
			continue
		}
		articles = append(articles, catalog.BlogArticle{Title: stripTags(item.Title), URL: c.absoluteMVideoURL(item.URL), Snippet: stripTags(item.Title)})
	}
	return articles, nil
}

func (c *Client) hydrateBlogArticle(ctx context.Context, article catalog.BlogArticle) (catalog.BlogArticle, error) {
	slug := blogSlug(article.URL)
	if slug == "" {
		return article, nil
	}
	endpoint, err := url.Parse(c.origin + "/blog/wp-json/wp/v2/posts")
	if err != nil {
		return article, fmt.Errorf("parse blog article url: %w", err)
	}
	params := endpoint.Query()
	params.Set("slug", slug)
	params.Set("per_page", "1")
	params.Set("_fields", "link,title,excerpt,content")
	endpoint.RawQuery = params.Encode()

	var items []wordpressPost
	if err := c.fetchJSON(ctx, http.MethodGet, endpoint.String(), nil, &items); err != nil {
		return article, err
	}
	if len(items) == 0 {
		return article, nil
	}
	content := normalizeArticleText(stripTags(items[0].Content.Rendered))
	if len(content) < 300 {
		return article, nil
	}
	article.Content = limitArticleContent(content)
	article.ContentChars = len(content)
	article.ContentSource = "wordpress"
	return article, nil
}

func rankBlogArticles(articles []catalog.BlogArticle, query string) []catalog.BlogArticle {
	terms := strings.Fields(strings.ToLower(query))
	seen := map[string]struct{}{}
	out := make([]catalog.BlogArticle, 0, len(articles))
	for _, article := range articles {
		if article.URL == "" {
			continue
		}
		if _, ok := seen[article.URL]; ok {
			continue
		}
		seen[article.URL] = struct{}{}
		text := strings.ToLower(article.Title + " " + article.Snippet + " " + article.URL)
		score := 0.0
		for _, term := range terms {
			if strings.Contains(text, term) {
				score += 2
			}
		}
		if strings.Contains(strings.ToLower(article.Title), "как выбрать") || strings.Contains(article.URL, "/obzory/") || strings.Contains(article.URL, "/pomogaem-razobratsya/") {
			score += 2
		}
		if score < 2 {
			continue
		}
		article.Score = &score
		article.Relevance = "Статья совпадает с темой запроса."
		out = append(out, article)
	}
	return out
}

func (c *Client) absoluteMVideoURL(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	if parsed.IsAbs() {
		parsed.RawQuery = ""
		parsed.Fragment = ""
		return parsed.String()
	}
	base, err := url.Parse(c.origin)
	if err != nil {
		return ""
	}
	resolved := base.ResolveReference(parsed)
	resolved.RawQuery = ""
	resolved.Fragment = ""
	return resolved.String()
}

func blogSlug(articleURL string) string {
	parsed, err := url.Parse(articleURL)
	if err != nil {
		return ""
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(parts) == 0 {
		return ""
	}
	return parts[len(parts)-1]
}

func normalizeArticleText(text string) string {
	return strings.TrimSpace(regexp.MustCompile(`\s+`).ReplaceAllString(strings.ReplaceAll(text, "Читайте также:", ""), " "))
}

func limitArticleContent(text string) string {
	if len(text) <= blogArticleContentLimit {
		return text
	}
	cut := text[:blogArticleContentLimit]
	lastSpace := strings.LastIndex(cut, " ")
	if lastSpace < blogArticleContentLimit-200 {
		lastSpace = blogArticleContentLimit - 200
	}
	return strings.TrimSpace(cut[:lastSpace]) + "…"
}

func truncate(value string, max int) string {
	if len(value) <= max {
		return value
	}
	return strings.TrimSpace(value[:max])
}

type wordpressSearch struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Subtype string `json:"subtype"`
}

type wordpressPost struct {
	Link  string `json:"link"`
	Title struct {
		Rendered string `json:"rendered"`
	} `json:"title"`
	Excerpt struct {
		Rendered string `json:"rendered"`
	} `json:"excerpt"`
	Content struct {
		Rendered string `json:"rendered"`
	} `json:"content"`
}

var _ = html.UnescapeString
