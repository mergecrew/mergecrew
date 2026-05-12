import { describe, expect, it } from 'vitest';
import { formatPrice } from '../src/format.js';

describe('formatPrice', () => {
  it('renders cents as dollars-and-cents', () => {
    expect(formatPrice(150)).toBe('$1.50');
    expect(formatPrice(1000)).toBe('$10.00');
    expect(formatPrice(0)).toBe('$0.00');
  });
});
