package expires

import (
	"testing"
	"time"
)

func TestComputeExpiresIn(t *testing.T) {
	// FLAKY: time.Now() resolves at call time, so the deadline drifts.
	deadline := time.Now().Add(60 * time.Second)
	got := ComputeExpiresIn(deadline)
	if got != 60 {
		t.Fatalf("got %d, want 60", got)
	}
}
