package config

import "testing"

func TestLoadDefaults(t *testing.T) {
	cfg := Load(nil)

	if cfg.HTTPAddr != ":8080" {
		t.Fatalf("HTTPAddr = %q, want :8080", cfg.HTTPAddr)
	}
	if cfg.AppMode != AppModeBoth {
		t.Fatalf("AppMode = %q, want both", cfg.AppMode)
	}
	if cfg.LLMBaseURL != "https://api.openai.com/v1" {
		t.Fatalf("LLMBaseURL = %q", cfg.LLMBaseURL)
	}
	if cfg.LLMModel != "gpt-5.4-mini" {
		t.Fatalf("LLMModel = %q", cfg.LLMModel)
	}
	if cfg.Configured() {
		t.Fatal("Configured() = true, want false")
	}
}

func TestLoadOverrides(t *testing.T) {
	cfg := Load([]string{
		"HTTP_ADDR=:9090",
		"APP_MODE=client",
		"LLM_API_KEY=sk-test",
		"LLM_BASE_URL=https://example.com/v1/",
		"LLM_MODEL=model-a",
		"AI_DEBUG=true",
	})

	if cfg.HTTPAddr != ":9090" {
		t.Fatalf("HTTPAddr = %q", cfg.HTTPAddr)
	}
	if cfg.AppMode != AppModeClient {
		t.Fatalf("AppMode = %q", cfg.AppMode)
	}
	if cfg.LLMBaseURL != "https://example.com/v1" {
		t.Fatalf("LLMBaseURL = %q", cfg.LLMBaseURL)
	}
	if cfg.LLMModel != "model-a" {
		t.Fatalf("LLMModel = %q", cfg.LLMModel)
	}
	if !cfg.AIDebug {
		t.Fatal("AIDebug = false, want true")
	}
	if !cfg.Configured() {
		t.Fatal("Configured() = false, want true")
	}
	if cfg.ProviderName() != "example.com" {
		t.Fatalf("ProviderName() = %q", cfg.ProviderName())
	}
}

func TestLoadRejectsUnsafeBaseURL(t *testing.T) {
	cfg := Load([]string{"LLM_BASE_URL=http://example.com/v1"})
	if cfg.LLMBaseURL != "https://api.openai.com/v1" {
		t.Fatalf("LLMBaseURL = %q", cfg.LLMBaseURL)
	}
}

func TestLoadAliasEnvAndMVideoOrigins(t *testing.T) {
	cfg := Load([]string{
		"PORT_ADDR=:7070",
		"VITE_APP_MODE=consultant",
		"OPENAI_API_KEY=test-key",
		"LLM_DEBUG=on",
		"MVIDEO_ORIGIN=https://shop.example.test/",
		"MVIDEO_IMAGE_ORIGIN=http://unsafe.example.test",
	})

	if cfg.HTTPAddr != ":7070" {
		t.Fatalf("HTTPAddr = %q", cfg.HTTPAddr)
	}
	if cfg.AppMode != AppModeConsultant {
		t.Fatalf("AppMode = %q", cfg.AppMode)
	}
	if !cfg.Configured() || !cfg.AIDebug {
		t.Fatalf("Configured/AIDebug = %v/%v", cfg.Configured(), cfg.AIDebug)
	}
	if cfg.MVideoOrigin != "https://shop.example.test" {
		t.Fatalf("MVideoOrigin = %q", cfg.MVideoOrigin)
	}
	if cfg.MVideoImageOrigin != "https://img.mvideo.ru" {
		t.Fatalf("MVideoImageOrigin = %q", cfg.MVideoImageOrigin)
	}
}
