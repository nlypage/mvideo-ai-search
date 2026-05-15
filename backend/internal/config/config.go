package config

import (
	"net/url"
	"strings"
	"time"
)

// AppMode controls which assistant mode this backend instance serves.
type AppMode string

const (
	// AppModeClient serves only the customer-facing B2C assistant.
	AppModeClient AppMode = "client"
	// AppModeConsultant serves only the consultant-facing B2E assistant.
	AppModeConsultant AppMode = "consultant"
	// AppModeBoth serves both B2C and B2E assistant modes.
	AppModeBoth AppMode = "both"
)

// Config contains runtime configuration loaded from environment variables.
type Config struct {
	HTTPAddr              string
	AppMode               AppMode
	LLMAPIKey             string
	LLMBaseURL            string
	LLMModel              string
	ConsultantAccessToken string
	AIDebug               bool
	LogLevel              string
	MVideoOrigin          string
	MVideoImageOrigin     string
	MVideoRequestTimeout  time.Duration
	ShutdownTimeout       time.Duration
}

// Load builds Config from an os.Environ-compatible slice.
func Load(environ []string) Config {
	env := parseEnv(environ)
	return Config{
		HTTPAddr:              firstNonEmpty(env["HTTP_ADDR"], env["PORT_ADDR"], ":8080"),
		AppMode:               normalizeAppMode(firstNonEmpty(env["APP_MODE"], env["VITE_APP_MODE"])),
		LLMAPIKey:             firstNonEmpty(env["LLM_API_KEY"], env["OPENAI_API_KEY"]),
		LLMBaseURL:            validateBaseURL(firstNonEmpty(env["LLM_BASE_URL"], "https://api.openai.com/v1")),
		LLMModel:              firstNonEmpty(env["LLM_MODEL"], "gpt-5.4-mini"),
		ConsultantAccessToken: env["CONSULTANT_ACCESS_TOKEN"],
		AIDebug:               isEnabled(firstNonEmpty(env["AI_DEBUG"], env["LLM_DEBUG"], env["VITE_AI_DEBUG"])),
		LogLevel:              firstNonEmpty(env["LOG_LEVEL"], "info"),
		MVideoOrigin:          validateHTTPSOrigin(firstNonEmpty(env["MVIDEO_ORIGIN"], "https://www.mvideo.ru"), "https://www.mvideo.ru"),
		MVideoImageOrigin:     validateHTTPSOrigin(firstNonEmpty(env["MVIDEO_IMAGE_ORIGIN"], "https://img.mvideo.ru"), "https://img.mvideo.ru"),
		MVideoRequestTimeout:  9 * time.Second,
		ShutdownTimeout:       10 * time.Second,
	}
}

// Configured reports whether an upstream LLM API key is available.
func (c Config) Configured() bool {
	return c.LLMAPIKey != ""
}

// ProviderName returns a safe display name for the configured LLM provider.
func (c Config) ProviderName() string {
	u, err := url.Parse(c.LLMBaseURL)
	if err != nil || u.Hostname() == "" {
		return "configured provider"
	}
	return u.Hostname()
}

func parseEnv(environ []string) map[string]string {
	out := make(map[string]string, len(environ))
	for _, item := range environ {
		key, value, ok := strings.Cut(item, "=")
		if !ok || key == "" {
			continue
		}
		out[key] = value
	}
	return out
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func normalizeAppMode(value string) AppMode {
	switch AppMode(value) {
	case AppModeClient, AppModeConsultant, AppModeBoth:
		return AppMode(value)
	default:
		return AppModeBoth
	}
}

func validateBaseURL(value string) string {
	return validateHTTPSOrigin(value, "https://api.openai.com/v1")
}

func validateHTTPSOrigin(value string, fallback string) string {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return fallback
	}
	u.RawQuery = ""
	u.Fragment = ""
	u.Path = strings.TrimRight(u.Path, "/")
	return strings.TrimRight(u.String(), "/")
}

func isEnabled(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}
