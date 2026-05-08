interface BreakerState {
  failures: number;
  successes: number;
  windowStart: number;
  openUntil: number;
}

const WINDOW_MS = 60_000;
const FAIL_THRESHOLD = 0.25;
const MIN_SAMPLES = 10;
const OPEN_DURATION_MS = 60_000;

export class CircuitBreaker {
  private states = new Map<string, BreakerState>();

  isOpen(key: string): boolean {
    const s = this.states.get(key);
    if (!s) return false;
    if (Date.now() < s.openUntil) return true;
    return false;
  }

  recordSuccess(key: string): void {
    const s = this.ensure(key);
    this.maybeRollWindow(s);
    s.successes++;
  }

  recordFailure(key: string): void {
    const s = this.ensure(key);
    this.maybeRollWindow(s);
    s.failures++;
    const total = s.successes + s.failures;
    if (total >= MIN_SAMPLES && s.failures / total >= FAIL_THRESHOLD) {
      s.openUntil = Date.now() + OPEN_DURATION_MS;
    }
  }

  private ensure(key: string): BreakerState {
    let s = this.states.get(key);
    if (!s) {
      s = { failures: 0, successes: 0, windowStart: Date.now(), openUntil: 0 };
      this.states.set(key, s);
    }
    return s;
  }

  private maybeRollWindow(s: BreakerState): void {
    if (Date.now() - s.windowStart > WINDOW_MS) {
      s.windowStart = Date.now();
      s.failures = 0;
      s.successes = 0;
    }
  }
}
