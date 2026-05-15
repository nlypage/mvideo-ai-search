package openai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestComplete(t *testing.T) {
	apiKey := "test-" + strings.Repeat("k", 12)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		if r.Header.Get("authorization") != "Bearer "+apiKey {
			t.Fatalf("authorization = %q", r.Header.Get("authorization"))
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if body["model"] != "test-model" {
			t.Fatalf("model = %v", body["model"])
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer server.Close()

	client := &Client{baseURL: server.URL + "/v1", apiKey: apiKey, model: "test-model", httpClient: &http.Client{Timeout: time.Second}}
	message, err := client.Complete(context.Background(), []Message{{Role: "user", Content: "hi"}}, nil, "", 10, 0.1)
	if err != nil {
		t.Fatalf("Complete() error = %v", err)
	}
	if message.Content != "ok" {
		t.Fatalf("content = %q", message.Content)
	}
}
