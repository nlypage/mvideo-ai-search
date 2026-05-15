package mvideo

import (
	"context"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	catalog "github.com/nlypage/mvideo-ai-search/backend/internal/domain/catalog"
)

func TestSearchHydratesProducts(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-set-application-id") == "" {
			t.Fatalf("missing M.Video application header")
		}
		switch r.URL.Path {
		case "/bff/products/v2/search":
			if r.URL.Query().Get("query") != "oled tv" || r.URL.Query().Get("offset") != "2" || r.URL.Query().Get("limit") != "12" {
				t.Fatalf("unexpected search query: %s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"body":{"total":20,"products":["100","100","200"]}}`))
		case "/bff/product-details/list":
			if r.Method != http.MethodPost {
				t.Fatalf("details method = %s", r.Method)
			}
			_, _ = w.Write([]byte(`{"body":{"products":[{"productId":"100","name":"<b>OLED TV</b>","nameTranslit":"oled-tv","image":"/a.jpg","brandName":"Brand","category":{"name":"Телевизоры"},"rating":{"star":4.7,"count":12},"status":{}},{"productId":"200","name":"Cheap TV","image":"//cdn.test/b.jpg","category":{"name":"Телевизоры"},"rating":{"star":4.1,"count":2},"status":{"soldOut":true}}]}}`))
		case "/bff/products/prices":
			if got := r.URL.Query().Get("productIds"); got != "100,200" {
				t.Fatalf("productIds = %q", got)
			}
			_, _ = w.Write([]byte(`{"body":{"materialPrices":[{"productId":"100","price":{"basePrice":120000,"salePrice":99990}},{"productId":"200","price":{"basePrice":1000,"salePrice":1000}}]}}`))
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
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
	if product.Rating != 4.7 || product.Reviews != 12 || product.Category != "Телевизоры · Brand" || product.Image != "https://img.example.test/a.jpg" {
		t.Fatalf("unexpected hydrated fields: %+v", product)
	}
}

func TestSearchWithMaxPriceExpandsSearchWindow(t *testing.T) {
	searchCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/bff/products/v2/search":
			searchCalls++
			if searchCalls == 1 {
				if r.URL.Query().Get("limit") != "5" || r.URL.Query().Get("price") != "0-5000" {
					t.Fatalf("native search query = %s, want limit=5 price=0-5000", r.URL.RawQuery)
				}
				_, _ = w.Write([]byte(`{"body":{"total":100,"products":["1","2","3","4","5"]}}`))
				return
			}
			if r.URL.Query().Get("limit") != "36" || r.URL.Query().Get("price") != "" {
				t.Fatalf("fallback search query = %s, want limit=36 without price", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"body":{"total":100,"products":["1","2","3","4","5","6"]}}`))
		case "/bff/product-details/list":
			if searchCalls == 1 {
				_, _ = w.Write([]byte(`{"body":{"products":[{"productId":"1","name":"Premium Speaker 1","status":{}},{"productId":"2","name":"Premium Speaker 2","status":{}},{"productId":"3","name":"Premium Speaker 3","status":{}},{"productId":"4","name":"Premium Speaker 4","status":{}},{"productId":"5","name":"Premium Speaker 5","status":{}}]}}`))
				return
			}
			_, _ = w.Write([]byte(`{"body":{"products":[{"productId":"1","name":"Premium Speaker 1","status":{}},{"productId":"2","name":"Premium Speaker 2","status":{}},{"productId":"3","name":"Premium Speaker 3","status":{}},{"productId":"4","name":"Premium Speaker 4","status":{}},{"productId":"5","name":"Premium Speaker 5","status":{}},{"productId":"6","name":"Budget Speaker","status":{}}]}}`))
		case "/bff/products/prices":
			_, _ = w.Write([]byte(`{"body":{"materialPrices":[{"productId":"1","price":{"salePrice":10000}},{"productId":"2","price":{"salePrice":11000}},{"productId":"3","price":{"salePrice":12000}},{"productId":"4","price":{"salePrice":13000}},{"productId":"5","price":{"salePrice":14000}},{"productId":"6","price":{"salePrice":3000}}]}}`))
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	client := &Client{origin: server.URL, imageOrigin: "https://img.example.test", httpClient: server.Client()}
	maxPrice := 5000.0
	limit := 5
	result, err := client.Search(context.Background(), catalog.SearchRequest{Query: "speaker", MaxPrice: &maxPrice, Limit: &limit})
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	if len(result.Products) != 1 || result.Products[0].ID != "6" || result.Products[0].Price != 3000 {
		t.Fatalf("unexpected products: %+v", result.Products)
	}
	if result.Page == nil || result.Page.NextOffset == nil || *result.Page.NextOffset != 36 {
		t.Fatalf("unexpected page: %+v", result.Page)
	}
}

func TestSearchHydratesDetailsAndPricesConcurrently(t *testing.T) {
	detailsStarted := make(chan struct{})
	pricesStarted := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/bff/products/v2/search":
			_, _ = w.Write([]byte(`{"body":{"total":1,"products":["100"]}}`))
		case "/bff/product-details/list":
			close(detailsStarted)
			select {
			case <-pricesStarted:
			case <-time.After(500 * time.Millisecond):
				http.Error(w, "prices did not start concurrently", http.StatusInternalServerError)
				return
			}
			_, _ = w.Write([]byte(`{"body":{"products":[{"productId":"100","name":"TV","category":{"name":"Телевизоры"},"status":{}}]}}`))
		case "/bff/products/prices":
			close(pricesStarted)
			select {
			case <-detailsStarted:
			case <-time.After(500 * time.Millisecond):
				http.Error(w, "details did not start concurrently", http.StatusInternalServerError)
				return
			}
			_, _ = w.Write([]byte(`{"body":{"materialPrices":[{"productId":"100","price":{"salePrice":100}}]}}`))
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	client := &Client{origin: server.URL, imageOrigin: "https://img.example.test", httpClient: server.Client()}
	result, err := client.Search(context.Background(), catalog.SearchRequest{Query: "tv"})
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	if len(result.Products) != 1 {
		t.Fatalf("products len = %d", len(result.Products))
	}
}

func TestSearchFollowsCookieSettingRedirect(t *testing.T) {
	searchHits := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/bff/products/v2/search":
			searchHits++
			if _, err := r.Cookie("mvid_session"); err != nil {
				http.SetCookie(w, &http.Cookie{Name: "mvid_session", Value: "ok", Path: "/"})
				http.Redirect(w, r, r.URL.String(), http.StatusFound)
				return
			}
			_, _ = w.Write([]byte(`{"body":{"total":1,"products":["100"]}}`))
		case "/bff/product-details/list":
			_, _ = w.Write([]byte(`{"body":{"products":[{"productId":"100","name":"TV","category":{"name":"Телевизоры"},"status":{}}]}}`))
		case "/bff/products/prices":
			_, _ = w.Write([]byte(`{"body":{"materialPrices":[{"productId":"100","price":{"salePrice":100}}]}}`))
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

	t.Run("empty ids returns empty page", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{"body":{"total":0,"products":[]}}`))
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
