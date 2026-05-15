package openai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/nlypage/mvideo-ai-search/backend/internal/config"
)

// Client is a minimal OpenAI-compatible chat completions client.
type Client struct {
	baseURL    string
	apiKey     string
	model      string
	httpClient *http.Client
}

// Message is an OpenAI-compatible chat message.
type Message struct {
	Role       string     `json:"role"`
	Content    string     `json:"content"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
	Name       string     `json:"name,omitempty"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
}

// ToolCall is a model-requested function call.
type ToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

// Tool is an OpenAI-compatible function tool schema.
type Tool struct {
	Type     string       `json:"type"`
	Function FunctionSpec `json:"function"`
}

// FunctionSpec describes a function tool.
type FunctionSpec struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"`
}

// New creates a chat completions client.
func New(cfg config.Config) *Client {
	return &Client{baseURL: strings.TrimRight(cfg.LLMBaseURL, "/"), apiKey: cfg.LLMAPIKey, model: cfg.LLMModel, httpClient: &http.Client{Timeout: 20 * time.Second}}
}

// Complete sends one chat completion request.
func (c *Client) Complete(ctx context.Context, messages []Message, tools []Tool, toolChoice string, maxTokens int, temperature float64) (Message, error) {
	payload := map[string]any{
		"model":       c.model,
		"messages":    messages,
		"temperature": temperature,
		"max_tokens":  maxTokens,
	}
	if len(tools) > 0 {
		payload["tools"] = tools
		payload["tool_choice"] = toolChoice
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return Message{}, fmt.Errorf("encode chat completion: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/chat/completions", bytes.NewReader(encoded))
	if err != nil {
		return Message{}, fmt.Errorf("create chat completion request: %w", err)
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("authorization", "Bearer "+c.apiKey)

	res, err := c.httpClient.Do(req)
	if err != nil {
		return Message{}, fmt.Errorf("chat completion request: %w", err)
	}
	defer func() { _ = res.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(res.Body, 2<<20))
	if err != nil {
		return Message{}, fmt.Errorf("read chat completion response: %w", err)
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return Message{}, fmt.Errorf("chat completion status %d: %s", res.StatusCode, string(body[:min(len(body), 500)]))
	}
	var completion struct {
		Choices []struct {
			Message Message `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(body, &completion); err != nil {
		return Message{}, fmt.Errorf("decode chat completion: %w", err)
	}
	if len(completion.Choices) == 0 {
		return Message{}, fmt.Errorf("empty chat completion choices")
	}
	return completion.Choices[0].Message, nil
}
