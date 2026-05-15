package ratelimit

import (
	"testing"
	"time"
)

func TestMemoryLimiterAllow(t *testing.T) {
	now := time.Date(2026, 5, 15, 0, 0, 0, 0, time.UTC)
	limiter := NewMemoryLimiter(Policy{Limit: 2, Window: time.Minute, Now: func() time.Time { return now }})

	if !limiter.Allow("client") {
		t.Fatal("first request denied")
	}
	if !limiter.Allow("client") {
		t.Fatal("second request denied")
	}
	if limiter.Allow("client") {
		t.Fatal("third request allowed, want denied")
	}

	now = now.Add(time.Minute + time.Second)
	if !limiter.Allow("client") {
		t.Fatal("request after reset denied")
	}
}

func TestMemoryLimiterKeysAreIndependent(t *testing.T) {
	now := time.Date(2026, 5, 15, 0, 0, 0, 0, time.UTC)
	limiter := NewMemoryLimiter(Policy{Limit: 1, Window: time.Minute, Now: func() time.Time { return now }})

	if !limiter.Allow("a") || !limiter.Allow("b") {
		t.Fatal("independent keys should each be allowed once")
	}
	if limiter.Allow("a") {
		t.Fatal("second request for same key allowed, want denied")
	}
}
