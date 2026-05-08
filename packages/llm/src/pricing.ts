import { withTenant } from '@mergecrew/db';
import type { Usage } from './types.js';

interface PriceRow {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cacheReadPerMillionUsd: number | null;
  cacheWritePerMillionUsd: number | null;
}

const cache = new Map<string, PriceRow>();

export async function priceFor(
  organizationId: string,
  providerKind: string,
  modelId: string,
  occurredAt: Date,
): Promise<PriceRow | null> {
  const key = `${providerKind}/${modelId}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const row = await withTenant(organizationId, async (tx) => {
    const r = await tx.modelPriceTable.findFirst({
      where: { providerKind, modelId, effectiveAt: { lte: occurredAt } },
      orderBy: { effectiveAt: 'desc' },
    });
    return r;
  });
  if (!row) return null;
  const out: PriceRow = {
    inputPerMillionUsd: Number(row.inputPerMillionUsd),
    outputPerMillionUsd: Number(row.outputPerMillionUsd),
    cacheReadPerMillionUsd: row.cacheReadPerMillionUsd === null ? null : Number(row.cacheReadPerMillionUsd),
    cacheWritePerMillionUsd: row.cacheWritePerMillionUsd === null ? null : Number(row.cacheWritePerMillionUsd),
  };
  cache.set(key, out);
  return out;
}

export function estimateUsd(price: PriceRow, usage: Usage): number {
  const m = (n: number, perM: number): number => (n / 1_000_000) * perM;
  let total = 0;
  total += m(usage.inputTokens, price.inputPerMillionUsd);
  total += m(usage.outputTokens, price.outputPerMillionUsd);
  if (usage.cacheReadTokens && price.cacheReadPerMillionUsd) {
    total += m(usage.cacheReadTokens, price.cacheReadPerMillionUsd);
  }
  if (usage.cacheWriteTokens && price.cacheWritePerMillionUsd) {
    total += m(usage.cacheWriteTokens, price.cacheWritePerMillionUsd);
  }
  return total;
}
