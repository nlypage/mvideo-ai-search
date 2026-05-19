// Package cache provides small in-memory TTL stores for demo-speed optimizations.
package cache

import (
	"sync"
	"time"
)

// Store is a typed key-value cache with TTL-based expiration.
type Store[T any] interface {
	Get(key string) (T, bool)
	Set(key string, value T)
	Delete(key string)
}

type entry[T any] struct {
	value     T
	expiresAt time.Time
}

// TTLStore is a sync.Map-backed in-memory cache.
type TTLStore[T any] struct {
	ttl   time.Duration
	clock func() time.Time
	items sync.Map
}

// NewTTLStore creates a cache where each Set stores a value for ttl.
func NewTTLStore[T any](ttl time.Duration) *TTLStore[T] {
	return newTTLStoreWithClock[T](ttl, time.Now)
}

func newTTLStoreWithClock[T any](ttl time.Duration, clock func() time.Time) *TTLStore[T] {
	if ttl <= 0 {
		ttl = time.Minute
	}
	if clock == nil {
		clock = time.Now
	}
	return &TTLStore[T]{ttl: ttl, clock: clock}
}

// Get returns a cached value when the key exists and has not expired.
func (s *TTLStore[T]) Get(key string) (T, bool) {
	var zero T
	if key == "" || s == nil {
		return zero, false
	}
	raw, ok := s.items.Load(key)
	if !ok {
		return zero, false
	}
	cached, ok := raw.(entry[T])
	if !ok || !s.clock().Before(cached.expiresAt) {
		s.items.Delete(key)
		return zero, false
	}
	return cached.value, true
}

// Set stores a value until the configured TTL expires.
func (s *TTLStore[T]) Set(key string, value T) {
	if key == "" || s == nil {
		return
	}
	s.items.Store(key, entry[T]{value: value, expiresAt: s.clock().Add(s.ttl)})
}

// Delete removes a key from the cache.
func (s *TTLStore[T]) Delete(key string) {
	if key == "" || s == nil {
		return
	}
	s.items.Delete(key)
}

var _ Store[int] = (*TTLStore[int])(nil)
