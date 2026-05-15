package mvideo

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	catalog "github.com/nlypage/mvideo-ai-search/backend/internal/domain/catalog"
)

func TestSearchUsesProductsBFF(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-set-application-id") == "" {
			t.Fatalf("missing M.Video application header")
		}
		if r.URL.Path != "/bff/products" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != http.MethodPost {
			t.Fatalf("method = %s, want POST", r.Method)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		if body["query"] != "oled tv" || body["cursorId"] != "2" || body["limit"] != float64(12) {
			t.Fatalf("unexpected request body: %+v", body)
		}
		filters, ok := body["filters"].([]any)
		if !ok || len(filters) != 1 {
			t.Fatalf("filters = %+v", body["filters"])
		}
		filter := filters[0].(map[string]any)
		values := filter["valuesId"].([]any)
		if filter["id"] != "price" || len(values) != 1 || values[0] != "10000-" {
			t.Fatalf("unexpected filters: %+v", filters)
		}
		_, _ = w.Write([]byte(`{"body":{"total":20,"cursorId":"14","items":[{"productId":"100","name":"<b>OLED TV</b>","slug":"/products/oled-tv-100","images":["Pdb/a.jpg"],"price":{"basePrice":120000,"salePrice":99990},"rating":{"star":4.7,"count":12},"status":"available","soldOut":false},{"productId":"200","name":"Cheap TV","slug":"/products/cheap-tv-200","images":["//cdn.test/b.jpg"],"price":{"basePrice":1000,"salePrice":1000},"rating":{"star":4.1,"count":2},"status":"available","soldOut":false}]}}`))
	}))
	defer server.Close()

	client := &Client{origin: server.URL, imageOrigin: "https://img.example.test", httpClient: server.Client()}
	minPrice := 10_000.0
	offset := 2
	limit := 12
	result, err := client.Search(context.Background(), catalog.SearchRequest{Query: "oled tv", MinPrice: &minPrice, Offset: &offset, Limit: &limit})
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}

	if result.Source != "live" || result.Page == nil || result.Page.Total == nil || *result.Page.Total != 20 || result.Page.NextOffset == nil || *result.Page.NextOffset != 14 {
		t.Fatalf("unexpected page/source: %+v", result)
	}
	if len(result.Products) != 1 {
		t.Fatalf("products len = %d, want 1: %+v", len(result.Products), result.Products)
	}
	product := result.Products[0]
	if product.ID != "100" || product.Title != "OLED TV" || product.Price != 99990 || product.OldPrice == nil || *product.OldPrice != 120000 {
		t.Fatalf("unexpected product: %+v", product)
	}
	if product.Rating != 4.7 || product.Reviews != 12 || product.Category != "Каталог" || product.Image != "https://img.example.test/Pdb/a.jpg" || product.URL != server.URL+"/products/oled-tv-100" {
		t.Fatalf("unexpected product fields: %+v", product)
	}
}

func TestSearchWithMaxPriceUsesNativeProductsFilterOnly(t *testing.T) {
	searchCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/bff/products" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		searchCalls++
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		if body["limit"] != float64(5) || body["cursorId"] != "" {
			t.Fatalf("unexpected request body: %+v", body)
		}
		filters := body["filters"].([]any)
		filter := filters[0].(map[string]any)
		values := filter["valuesId"].([]any)
		if filter["id"] != "price" || len(values) != 1 || values[0] != "-5000" {
			t.Fatalf("unexpected filters: %+v", filters)
		}
		_, _ = w.Write([]byte(`{"body":{"total":100,"cursorId":"5","items":[{"productId":"1","name":"Premium Speaker 1","slug":"/products/premium-speaker-1","price":{"salePrice":10000},"status":"available"},{"productId":"2","name":"Premium Speaker 2","slug":"/products/premium-speaker-2","price":{"salePrice":11000},"status":"available"},{"productId":"3","name":"Premium Speaker 3","slug":"/products/premium-speaker-3","price":{"salePrice":12000},"status":"available"},{"productId":"4","name":"Premium Speaker 4","slug":"/products/premium-speaker-4","price":{"salePrice":13000},"status":"available"},{"productId":"5","name":"Budget Speaker","slug":"/products/budget-speaker","price":{"salePrice":3000},"status":"available"}]}}`))
	}))
	defer server.Close()

	client := &Client{origin: server.URL, imageOrigin: "https://img.example.test", httpClient: server.Client()}
	maxPrice := 5000.0
	limit := 5
	result, err := client.Search(context.Background(), catalog.SearchRequest{Query: "speaker", MaxPrice: &maxPrice, Limit: &limit})
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	if searchCalls != 1 {
		t.Fatalf("search calls = %d, want 1", searchCalls)
	}
	if len(result.Products) != 1 || result.Products[0].ID != "5" || result.Products[0].Price != 3000 {
		t.Fatalf("unexpected products: %+v", result.Products)
	}
	if result.Page == nil || result.Page.NextOffset == nil || *result.Page.NextOffset != 5 {
		t.Fatalf("unexpected page: %+v", result.Page)
	}
}

func TestSearchWarmsSessionAfterEmptyProductsResponse(t *testing.T) {
	productsHits := 0
	warmHits := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/bff/products":
			productsHits++
			if productsHits == 1 {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			if _, err := r.Cookie("mvid_session"); err != nil {
				t.Fatalf("retry missing warmup cookie: %v", err)
			}
			_, _ = w.Write([]byte(`{"body":{"total":1,"cursorId":"1","items":[{"productId":"100","name":"TV","slug":"/products/tv-100","price":{"salePrice":100},"status":"available"}]}}`))
		case "/":
			warmHits++
			http.SetCookie(w, &http.Cookie{Name: "mvid_session", Value: "ok", Path: "/"})
			_, _ = w.Write([]byte("ok"))
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookie jar: %v", err)
	}
	httpClient := server.Client()
	httpClient.Jar = jar
	client := &Client{origin: server.URL, imageOrigin: "https://img.example.test", httpClient: httpClient}
	result, err := client.Search(context.Background(), catalog.SearchRequest{Query: "tv"})
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	if productsHits != 2 || warmHits != 1 || len(result.Products) != 1 {
		t.Fatalf("unexpected warmup result: productsHits=%d warmHits=%d result=%+v", productsHits, warmHits, result)
	}
}

func TestSearchFollowsCookieSettingRedirect(t *testing.T) {
	searchHits := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/bff/products" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		searchHits++
		if _, err := r.Cookie("mvid_session"); err != nil {
			http.SetCookie(w, &http.Cookie{Name: "mvid_session", Value: "ok", Path: "/"})
			http.Redirect(w, r, r.URL.String(), http.StatusTemporaryRedirect)
			return
		}
		_, _ = w.Write([]byte(`{"body":{"total":1,"cursorId":"1","items":[{"productId":"100","name":"TV","slug":"/products/tv-100","price":{"salePrice":100},"status":"available"}]}}`))
	}))
	defer server.Close()

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookie jar: %v", err)
	}
	httpClient := server.Client()
	httpClient.Jar = jar
	client := &Client{origin: server.URL, imageOrigin: "https://img.example.test", httpClient: httpClient}
	result, err := client.Search(context.Background(), catalog.SearchRequest{Query: "tv"})
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	if searchHits != 2 || len(result.Products) != 1 {
		t.Fatalf("unexpected redirect/search result: hits=%d result=%+v", searchHits, result)
	}
}

func TestSearchEdgeCases(t *testing.T) {
	t.Run("empty query does not call upstream", func(t *testing.T) {
		client := &Client{origin: "https://www.mvideo.ru", imageOrigin: "https://img.mvideo.ru", httpClient: http.DefaultClient}
		result, err := client.Search(context.Background(), catalog.SearchRequest{Query: "   "})
		if err != nil {
			t.Fatalf("Search() error = %v", err)
		}
		if len(result.Products) != 0 || result.Source != "live" {
			t.Fatalf("unexpected result: %+v", result)
		}
	})

	t.Run("empty items returns empty page", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{"body":{"total":0,"items":[]}}`))
		}))
		defer server.Close()
		client := &Client{origin: server.URL, imageOrigin: "https://img.example.test", httpClient: server.Client()}
		result, err := client.Search(context.Background(), catalog.SearchRequest{Query: "tv"})
		if err != nil {
			t.Fatalf("Search() error = %v", err)
		}
		if len(result.Products) != 0 || result.Page == nil || result.Page.Total != nil {
			t.Fatalf("unexpected result: %+v", result)
		}
	})

	t.Run("non 2xx returns error", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "blocked", http.StatusTooManyRequests)
		}))
		defer server.Close()
		client := &Client{origin: server.URL, imageOrigin: "https://img.example.test", httpClient: server.Client()}
		_, err := client.Search(context.Background(), catalog.SearchRequest{Query: "tv"})
		if err == nil || !strings.Contains(err.Error(), "status 429") {
			t.Fatalf("Search() error = %v, want status 429", err)
		}
	})

	t.Run("context cancellation", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			<-r.Context().Done()
		}))
		defer server.Close()
		client := &Client{origin: server.URL, imageOrigin: "https://img.example.test", httpClient: server.Client()}
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		_, err := client.Search(ctx, catalog.SearchRequest{Query: "tv"})
		if err == nil {
			t.Fatal("Search() error = nil, want cancellation")
		}
	})
}

func TestSearchReturnsPoisonPillError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("checking your browser captcha"))
	}))
	defer server.Close()

	client := &Client{origin: server.URL, imageOrigin: "https://img.example.test", httpClient: &http.Client{Timeout: time.Second}}
	_, err := client.Search(context.Background(), catalog.SearchRequest{Query: "tv"})
	if err == nil || !strings.Contains(err.Error(), "anti-bot") {
		t.Fatalf("Search() error = %v, want anti-bot", err)
	}
}
