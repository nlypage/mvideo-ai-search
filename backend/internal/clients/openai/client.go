package openai

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
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

// StreamDelta is emitted for each content token from a streaming completion.
type StreamDelta struct {
	Content string
}

// New creates a chat completions client.
func New(cfg config.Config) *Client {
	timeout := cfg.LLMTimeout
	if timeout <= 0 {
		timeout = 20 * time.Second
	}
	return &Client{baseURL: strings.TrimRight(cfg.LLMBaseURL, "/"), apiKey: cfg.LLMAPIKey, model: cfg.LLMModel, httpClient: &http.Client{Timeout: timeout}}
}

// Complete sends one chat completion request.
func (c *Client) Complete(ctx context.Context, messages []Message, tools []Tool, toolChoice any, maxTokens int, temperature float64) (Message, error) {
	encoded, err := json.Marshal(chatPayload(c.model, messages, tools, toolChoice, maxTokens, temperature, false))
	if err != nil {
		return Message{}, fmt.Errorf("encode chat completion: %w", err)
	}

	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			if err := sleepWithContext(ctx, retryDelay(attempt)); err != nil {
				return Message{}, err
			}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/chat/completions", bytes.NewReader(encoded))
		if err != nil {
			return Message{}, fmt.Errorf("create chat completion request: %w", err)
		}
		req.Header.Set("content-type", "application/json")
		req.Header.Set("authorization", "Bearer "+c.apiKey)

		res, err := c.httpClient.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("chat completion request: %w", err)
			if ctx.Err() != nil {
				return Message{}, lastErr
			}
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(res.Body, 2<<20))
		closeErr := res.Body.Close()
		if readErr != nil {
			return Message{}, fmt.Errorf("read chat completion response: %w", readErr)
		}
		if closeErr != nil {
			return Message{}, fmt.Errorf("close chat completion response: %w", closeErr)
		}
		if res.StatusCode < 200 || res.StatusCode >= 300 {
			lastErr = fmt.Errorf("chat completion status %d: %s", res.StatusCode, string(body[:min(len(body), 500)]))
			if isRetryableStatus(res.StatusCode) {
				continue
			}
			return Message{}, lastErr
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
	return Message{}, lastErr
}

// CompleteStream sends a streaming chat completion request and assembles the final message.
func (c *Client) CompleteStream(ctx context.Context, messages []Message, tools []Tool, toolChoice any, maxTokens int, temperature float64, onDelta func(StreamDelta) error) (Message, error) {
	encoded, err := json.Marshal(chatPayload(c.model, messages, tools, toolChoice, maxTokens, temperature, true))
	if err != nil {
		return Message{}, fmt.Errorf("encode streaming chat completion: %w", err)
	}

	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			if err := sleepWithContext(ctx, retryDelay(attempt)); err != nil {
				return Message{}, err
			}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/chat/completions", bytes.NewReader(encoded))
		if err != nil {
			return Message{}, fmt.Errorf("create streaming chat completion request: %w", err)
		}
		req.Header.Set("content-type", "application/json")
		req.Header.Set("accept", "text/event-stream")
		req.Header.Set("authorization", "Bearer "+c.apiKey)

		res, err := c.httpClient.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("streaming chat completion request: %w", err)
			if ctx.Err() != nil {
				return Message{}, lastErr
			}
			continue
		}
		if res.StatusCode < 200 || res.StatusCode >= 300 {
			body, readErr := io.ReadAll(io.LimitReader(res.Body, 2<<20))
			closeErr := res.Body.Close()
			if readErr != nil {
				return Message{}, fmt.Errorf("read streaming chat completion response: %w", readErr)
			}
			if closeErr != nil {
				return Message{}, fmt.Errorf("close streaming chat completion response: %w", closeErr)
			}
			lastErr = fmt.Errorf("streaming chat completion status %d: %s", res.StatusCode, string(body[:min(len(body), 500)]))
			if isRetryableStatus(res.StatusCode) {
				continue
			}
			return Message{}, lastErr
		}
		message, err := readStreamingChatCompletion(res.Body, onDelta)
		closeErr := res.Body.Close()
		if err != nil {
			return Message{}, err
		}
		if closeErr != nil {
			return Message{}, fmt.Errorf("close streaming chat completion response: %w", closeErr)
		}
		return message, nil
	}
	return Message{}, lastErr
}

func chatPayload(model string, messages []Message, tools []Tool, toolChoice any, maxTokens int, temperature float64, stream bool) map[string]any {
	payload := map[string]any{
		"model":       model,
		"messages":    messages,
		"temperature": temperature,
		"max_tokens":  maxTokens,
	}
	if stream {
		payload["stream"] = true
	}
	if len(tools) > 0 {
		payload["tools"] = tools
		switch choice := toolChoice.(type) {
		case nil:
			payload["tool_choice"] = "auto"
		case string:
			if choice == "" {
				payload["tool_choice"] = "auto"
			} else {
				payload["tool_choice"] = choice
			}
		default:
			payload["tool_choice"] = choice
		}
	}
	return payload
}

func readStreamingChatCompletion(body io.Reader, onDelta func(StreamDelta) error) (Message, error) {
	message := Message{Role: "assistant"}
	toolCalls := map[int]*ToolCall{}
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64*1024), 2<<20)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, ":") {
			continue
		}
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			break
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Role      string `json:"role"`
					Content   string `json:"content"`
					ToolCalls []struct {
						Index    int    `json:"index"`
						ID       string `json:"id"`
						Type     string `json:"type"`
						Function struct {
							Name      string `json:"name"`
							Arguments string `json:"arguments"`
						} `json:"function"`
					} `json:"tool_calls"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			return Message{}, fmt.Errorf("decode streaming chat completion chunk: %w", err)
		}
		for _, choice := range chunk.Choices {
			if choice.Delta.Role != "" {
				message.Role = choice.Delta.Role
			}
			if choice.Delta.Content != "" {
				message.Content += choice.Delta.Content
				if onDelta != nil {
					if err := onDelta(StreamDelta{Content: choice.Delta.Content}); err != nil {
						return Message{}, err
					}
				}
			}
			for _, deltaCall := range choice.Delta.ToolCalls {
				call := toolCalls[deltaCall.Index]
				if call == nil {
					call = &ToolCall{}
					toolCalls[deltaCall.Index] = call
				}
				if deltaCall.ID != "" {
					call.ID = deltaCall.ID
				}
				if deltaCall.Type != "" {
					call.Type = deltaCall.Type
				}
				if deltaCall.Function.Name != "" {
					call.Function.Name = deltaCall.Function.Name
				}
				if deltaCall.Function.Arguments != "" {
					call.Function.Arguments += deltaCall.Function.Arguments
				}
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return Message{}, fmt.Errorf("read streaming chat completion: %w", err)
	}
	if len(toolCalls) > 0 {
		message.ToolCalls = make([]ToolCall, 0, len(toolCalls))
		for index := 0; index < len(toolCalls); index++ {
			if call := toolCalls[index]; call != nil {
				message.ToolCalls = append(message.ToolCalls, *call)
			}
		}
	}
	return message, nil
}

func isRetryableStatus(status int) bool {
	return status == http.StatusTooManyRequests || status >= 500
}

func retryDelay(attempt int) time.Duration {
	base := 200 * time.Millisecond
	if attempt >= 2 {
		base = 600 * time.Millisecond
	}
	return base + time.Duration(rand.Int63n(int64(base/2)))
}

func sleepWithContext(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
