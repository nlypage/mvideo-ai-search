package ratelimit

import (
	"sync"
	"time"
)

// Policy describes a fixed-window rate limit.
type Policy struct {
	Limit  int
	Window time.Duration
	Now    func() time.Time
}

type bucket struct {
	count   int
	resetAt time.Time
}

// MemoryLimiter is an in-process fixed-window rate limiter.
type MemoryLimiter struct {
	mu      sync.Mutex
	policy  Policy
	buckets map[string]bucket
}

// NewMemoryLimiter creates an in-memory limiter. It is parity with the current TypeScript backend;
// use a distributed implementation when running multiple backend replicas.
func NewMemoryLimiter(policy Policy) *MemoryLimiter {
	if policy.Limit <= 0 {
		policy.Limit = 1
	}
	if policy.Window <= 0 {
		policy.Window = time.Minute
	}
	if policy.Now == nil {
		policy.Now = time.Now
	}
	return &MemoryLimiter{policy: policy, buckets: make(map[string]bucket)}
}

// Allow consumes one request from key and reports whether it remains within the limit.
func (l *MemoryLimiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.policy.Now()
	for bucketKey, current := range l.buckets {
		if current.resetAt.Before(now) {
			delete(l.buckets, bucketKey)
		}
	}
	current, ok := l.buckets[key]
	if !ok || current.resetAt.Before(now) {
		l.buckets[key] = bucket{count: 1, resetAt: now.Add(l.policy.Window)}
		return true
	}

	current.count++
	l.buckets[key] = current
	return current.count <= l.policy.Limit
}

// Cleanup removes expired buckets.
func (l *MemoryLimiter) Cleanup() {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.policy.Now()
	for key, current := range l.buckets {
		if current.resetAt.Before(now) {
			delete(l.buckets, key)
		}
	}
}
