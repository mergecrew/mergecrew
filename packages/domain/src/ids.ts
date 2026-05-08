import { z } from 'zod';

export const Uuid = z.string().uuid();
export type Uuid = z.infer<typeof Uuid>;

export const ChangesetId = z.string().regex(/^cs_[A-Za-z0-9]{4,12}$/);
export type ChangesetId = z.infer<typeof ChangesetId>;

export const RunId = z.string().regex(/^run_[A-Za-z0-9_-]+$/);
export type RunId = z.infer<typeof RunId>;

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz123456789';

export function shortId(prefix: string, n = 5): string {
  let out = '';
  // Node 22 has globalThis.crypto.
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  for (let i = 0; i < n; i++) out += ALPHABET[(bytes[i] ?? 0) % ALPHABET.length];
  return `${prefix}_${out}`;
}

export const newChangesetId = (): ChangesetId => shortId('cs', 5) as ChangesetId;
export const newRunIdForDate = (d: Date, projectShort: string): RunId =>
  `run_${d.toISOString().slice(0, 10)}_${projectShort}` as RunId;
