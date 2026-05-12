package expires

import "time"

// ComputeExpiresIn returns the seconds remaining until the given expiry.
// BUG: uses time.Now() directly — tests can't pin the clock.
func ComputeExpiresIn(expiry time.Time) int64 {
	return int64(expiry.Sub(time.Now()).Seconds())
}
