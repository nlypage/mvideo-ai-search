package mvideo

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestSearchReviewsByProductID(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/bff/reviews/aplaut" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.URL.Query().Get("contextId") != "100" || r.URL.Query().Get("perPage") != "5" {
			t.Fatalf("unexpected query: %s", r.URL.RawQuery)
		}
		_, _ = w.Write([]byte(`{"body":{"totalNumber":2,"recommendPercent":90,"totalRating":4.5,"reviews":[{"text":"<p>Отлично</p>","benefits":"звук","drawbacks":"цена"}]}}`))
	}))
	defer server.Close()

	client := &Client{origin: server.URL, imageOrigin: "https://img.example.test", httpClient: server.Client()}
	reviews, err := client.SearchReviews(context.Background(), "100", "")
	if err != nil {
		t.Fatalf("SearchReviews() error = %v", err)
	}
	if len(reviews) != 1 || reviews[0].ProductID != "100" || reviews[0].TotalRating != 4.5 || reviews[0].Snippets[0] != "Отлично" {
		t.Fatalf("unexpected reviews: %+v", reviews)
	}
}

func TestSearchReviewsByQueryFetchesTopProductsConcurrently(t *testing.T) {
	var active int32
	var maxActive int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/bff/products":
			_, _ = w.Write([]byte(`{"body":{"total":3,"items":[{"productId":"100","name":"TV 1","slug":"/products/tv-1-100","price":{"salePrice":100},"status":"available"},{"productId":"200","name":"TV 2","slug":"/products/tv-2-200","price":{"salePrice":200},"status":"available"},{"productId":"300","name":"TV 3","slug":"/products/tv-3-300","price":{"salePrice":300},"status":"available"}]}}`))
		case "/bff/reviews/aplaut":
			current := atomic.AddInt32(&active, 1)
			for {
				maxSeen := atomic.LoadInt32(&maxActive)
				if current <= maxSeen || atomic.CompareAndSwapInt32(&maxActive, maxSeen, current) {
					break
				}
			}
			time.Sleep(50 * time.Millisecond)
			atomic.AddInt32(&active, -1)
			_, _ = fmt.Fprintf(w, `{"body":{"totalNumber":1,"recommendPercent":90,"totalRating":4.5,"reviews":[{"text":"Отзыв %s","benefits":"быстро","drawbacks":""}]}}`, r.URL.Query().Get("contextId"))
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	client := &Client{origin: server.URL, imageOrigin: "https://img.example.test", httpClient: server.Client()}
	reviews, err := client.SearchReviews(context.Background(), "", "tv")
	if err != nil {
		t.Fatalf("SearchReviews() error = %v", err)
	}
	if len(reviews) != 3 || atomic.LoadInt32(&maxActive) < 2 {
		t.Fatalf("reviews not fetched concurrently: len=%d maxActive=%d reviews=%+v", len(reviews), maxActive, reviews)
	}
}

func TestSearchBlogHydratesTopArticle(t *testing.T) {
	longContent := strings.Repeat("подробный текст про HDMI кабель ", 20)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/blog/wp-json/wp/v2/posts" && r.URL.Query().Get("search") != "":
			_, _ = fmt.Fprintf(w, `[{"link":"%s/blog/pomogaem-razobratsya/kak-vybrat-hdmi","title":{"rendered":"Как выбрать HDMI кабель"},"excerpt":{"rendered":"HDMI 2.1 для телевизора"}}]`, serverURL(r))
		case r.URL.Path == "/blog/wp-json/wp/v2/search":
			_, _ = w.Write([]byte(`[]`))
		case r.URL.Path == "/blog/wp-json/wp/v2/posts" && r.URL.Query().Get("slug") == "kak-vybrat-hdmi":
			_, _ = fmt.Fprintf(w, `[{"link":"%s/blog/pomogaem-razobratsya/kak-vybrat-hdmi","title":{"rendered":"Как выбрать HDMI кабель"},"excerpt":{"rendered":""},"content":{"rendered":"<article>%s</article>"}}]`, serverURL(r), longContent)
		default:
			t.Fatalf("unexpected request: %s?%s", r.URL.Path, r.URL.RawQuery)
		}
	}))
	defer server.Close()

	client := &Client{origin: server.URL, imageOrigin: "https://img.example.test", httpClient: server.Client()}
	articles, err := client.SearchBlog(context.Background(), "HDMI кабель")
	if err != nil {
		t.Fatalf("SearchBlog() error = %v", err)
	}
	if len(articles) != 1 || articles[0].Title != "Как выбрать HDMI кабель" || articles[0].ContentSource != "wordpress" || articles[0].ContentChars < 300 {
		t.Fatalf("unexpected articles: %+v", articles)
	}
}

func TestSearchBlogCachesIdenticalQueries(t *testing.T) {
	var postsHits int32
	var searchHits int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/blog/wp-json/wp/v2/posts" && r.URL.Query().Get("search") != "":
			atomic.AddInt32(&postsHits, 1)
			_, _ = fmt.Fprintf(w, `[{"link":"%s/blog/pomogaem-razobratsya/kak-vybrat-hdmi","title":{"rendered":"Как выбрать HDMI кабель"},"excerpt":{"rendered":"HDMI 2.1 для телевизора"}}]`, serverURL(r))
		case r.URL.Path == "/blog/wp-json/wp/v2/search":
			atomic.AddInt32(&searchHits, 1)
			_, _ = w.Write([]byte(`[]`))
		case r.URL.Path == "/blog/wp-json/wp/v2/posts" && r.URL.Query().Get("slug") == "kak-vybrat-hdmi":
			_, _ = fmt.Fprintf(w, `[{"link":"%s/blog/pomogaem-razobratsya/kak-vybrat-hdmi","title":{"rendered":"Как выбрать HDMI кабель"},"excerpt":{"rendered":""},"content":{"rendered":"%s"}}]`, serverURL(r), strings.Repeat("текст ", 80))
		default:
			t.Fatalf("unexpected request: %s?%s", r.URL.Path, r.URL.RawQuery)
		}
	}))
	defer server.Close()

	client := &Client{origin: server.URL, imageOrigin: "https://img.example.test", httpClient: server.Client()}
	for i := 0; i < 2; i++ {
		articles, err := client.SearchBlog(context.Background(), "HDMI кабель")
		if err != nil {
			t.Fatalf("SearchBlog() error = %v", err)
		}
		if len(articles) != 1 {
			t.Fatalf("unexpected articles: %+v", articles)
		}
	}
	if postsHits != 1 || searchHits != 1 {
		t.Fatalf("upstream hits: posts=%d search=%d, want 1/1", postsHits, searchHits)
	}
}

func TestSearchReviewsCachesIdenticalProductRequests(t *testing.T) {
	var hits int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		_, _ = w.Write([]byte(`{"body":{"totalNumber":1,"recommendPercent":90,"totalRating":4.5,"reviews":[{"text":"Отлично","benefits":"звук","drawbacks":""}]}}`))
	}))
	defer server.Close()

	client := &Client{origin: server.URL, imageOrigin: "https://img.example.test", httpClient: server.Client()}
	for i := 0; i < 2; i++ {
		reviews, err := client.SearchReviews(context.Background(), "100", "")
		if err != nil {
			t.Fatalf("SearchReviews() error = %v", err)
		}
		if len(reviews) != 1 {
			t.Fatalf("unexpected reviews: %+v", reviews)
		}
	}
	if hits != 1 {
		t.Fatalf("upstream hits = %d, want 1", hits)
	}
}

func serverURL(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}
