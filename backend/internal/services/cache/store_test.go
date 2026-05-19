package cache

import (
	"testing"
	"time"
)

func TestTTLStore(t *testing.T) {
	now := time.Date(2026, 5, 18, 12, 0, 0, 0, time.UTC)
	store := newTTLStoreWithClock[string](time.Minute, func() time.Time { return now })

	if _, ok := store.Get("missing"); ok {
		t.Fatal("expected missing key")
	}

	store.Set("key", "value")
	got, ok := store.Get("key")
	if !ok || got != "value" {
		t.Fatalf("Get() = %q, %v; want value, true", got, ok)
	}

	now = now.Add(time.Minute)
	if _, ok := store.Get("key"); ok {
		t.Fatal("expected expired key to miss")
	}
}

func TestTTLStoreDelete(t *testing.T) {
	store := NewTTLStore[int](time.Minute)
	store.Set("key", 7)
	store.Delete("key")
	if _, ok := store.Get("key"); ok {
		t.Fatal("expected deleted key to miss")
	}
}
