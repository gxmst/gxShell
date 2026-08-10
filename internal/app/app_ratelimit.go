package app

import (
	"sync"
	"time"
)

const (
	maxConnectionsPerProfile = 3
	connectionRatePeriod     = 30 * time.Second
)

type connectionRateLimiter struct {
	mu       sync.Mutex
	attempts map[string][]time.Time
}

func newConnectionRateLimiter() *connectionRateLimiter {
	return &connectionRateLimiter{
		attempts: make(map[string][]time.Time),
	}
}

// CheckAndRecord checks if a connection attempt is allowed and records it.
// Returns error if rate limit is exceeded.
func (r *connectionRateLimiter) CheckAndRecord(profileID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	now := time.Now()
	cutoff := now.Add(-connectionRatePeriod)

	// Clean old attempts
	recent := r.attempts[profileID][:0]
	for _, t := range r.attempts[profileID] {
		if t.After(cutoff) {
			recent = append(recent, t)
		}
	}

	if len(recent) >= maxConnectionsPerProfile {
		return &RateLimitError{
			ProfileID:    profileID,
			AttemptsUsed: len(recent),
			RetryAfter:   recent[0].Add(connectionRatePeriod).Sub(now),
		}
	}

	r.attempts[profileID] = append(recent, now)
	return nil
}

// Reset clears the rate limit for a specific profile.
func (r *connectionRateLimiter) Reset(profileID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.attempts, profileID)
}

// RateLimitError is returned when connection rate limit is exceeded.
type RateLimitError struct {
	ProfileID    string
	AttemptsUsed int
	RetryAfter   time.Duration
}

func (e *RateLimitError) Error() string {
	return "connection rate limit exceeded, retry after " + e.RetryAfter.Round(time.Second).String()
}
