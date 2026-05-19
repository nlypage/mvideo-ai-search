package openai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
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

func TestCompleteRetriesRetryableStatus(t *testing.T) {
	var attempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if attempts.Add(1) == 1 {
			http.Error(w, "rate limited", http.StatusTooManyRequests)
			return
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok after retry"}}]}`))
	}))
	defer server.Close()

	client := &Client{baseURL: server.URL + "/v1", apiKey: "test-" + strings.Repeat("x", 12), model: "test-model", httpClient: &http.Client{Timeout: time.Second}}
	message, err := client.Complete(context.Background(), []Message{{Role: "user", Content: "hi"}}, nil, "", 10, 0.1)
	if err != nil {
		t.Fatalf("Complete() error = %v", err)
	}
	if message.Content != "ok after retry" || attempts.Load() != 2 {
		t.Fatalf("unexpected retry result: content=%q attempts=%d", message.Content, attempts.Load())
	}
}

func TestCompleteSerializesForcedToolChoice(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		choice, ok := body["tool_choice"].(map[string]any)
		if !ok || choice["type"] != "function" {
			t.Fatalf("tool_choice = %#v", body["tool_choice"])
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer server.Close()

	client := &Client{baseURL: server.URL + "/v1", apiKey: "test-" + strings.Repeat("x", 12), model: "test-model", httpClient: &http.Client{Timeout: time.Second}}
	_, err := client.Complete(context.Background(), []Message{{Role: "user", Content: "hi"}}, []Tool{{Type: "function", Function: FunctionSpec{Name: "cite_blog_source"}}}, map[string]any{"type": "function", "function": map[string]string{"name": "cite_blog_source"}}, 10, 0.1)
	if err != nil {
		t.Fatalf("Complete() error = %v", err)
	}
}

func TestCompleteStreamEmitsDeltasAndAssemblesContent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if body["stream"] != true {
			t.Fatalf("stream = %v, want true", body["stream"])
		}
		w.Header().Set("content-type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"При\"}}]}\n\n"))
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"вет\"}}]}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer server.Close()

	client := &Client{baseURL: server.URL + "/v1", apiKey: "test-" + strings.Repeat("x", 12), model: "test-model", httpClient: &http.Client{Timeout: time.Second}}
	deltas := []string{}
	message, err := client.CompleteStream(context.Background(), []Message{{Role: "user", Content: "hi"}}, nil, "", 10, 0.1, func(delta StreamDelta) error {
		deltas = append(deltas, delta.Content)
		return nil
	})
	if err != nil {
		t.Fatalf("CompleteStream() error = %v", err)
	}
	if message.Content != "Привет" || strings.Join(deltas, "") != "Привет" {
		t.Fatalf("unexpected stream result: message=%+v deltas=%+v", message, deltas)
	}
}

func TestCompleteStreamAssemblesToolCalls(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call-1\",\"type\":\"function\",\"function\":{\"name\":\"search_catalog\",\"arguments\":\"{\\\"query\\\":\\\"\"}}]}}]}\n\n"))
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"OLED\\\"}\"}}]}}]}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer server.Close()

	client := &Client{baseURL: server.URL + "/v1", apiKey: "test-" + strings.Repeat("x", 12), model: "test-model", httpClient: &http.Client{Timeout: time.Second}}
	message, err := client.CompleteStream(context.Background(), []Message{{Role: "user", Content: "hi"}}, []Tool{{Type: "function", Function: FunctionSpec{Name: "search_catalog"}}}, "auto", 10, 0.1, nil)
	if err != nil {
		t.Fatalf("CompleteStream() error = %v", err)
	}
	if len(message.ToolCalls) != 1 || message.ToolCalls[0].Function.Name != "search_catalog" || message.ToolCalls[0].Function.Arguments != `{"query":"OLED"}` {
		t.Fatalf("unexpected tool calls: %+v", message.ToolCalls)
	}
}
