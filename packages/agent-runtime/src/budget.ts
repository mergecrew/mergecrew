export interface BudgetSpec {
  tokens?: number;
  usd?: number;
}

export class BudgetTracker {
  private tokens = 0;
  private usd = 0;

  constructor(private spec: BudgetSpec | undefined) {}

  add(usage: { totalTokens: number }, usdEstimate: number): void {
    this.tokens += usage.totalTokens;
    this.usd += usdEstimate;
  }

  exhausted(): { exhausted: boolean; reason?: 'tokens' | 'usd' } {
    if (this.spec?.tokens && this.tokens >= this.spec.tokens) return { exhausted: true, reason: 'tokens' };
    if (this.spec?.usd && this.usd >= this.spec.usd) return { exhausted: true, reason: 'usd' };
    return { exhausted: false };
  }

  snapshot(): { tokens: number; usd: number } {
    return { tokens: this.tokens, usd: this.usd };
  }
}
