import { cookies } from 'next/headers';

export type Density = 'compact' | 'comfortable';

const DENSITY_COOKIE = 'mergecrew_density';

export async function getDensity(): Promise<Density> {
  const c = await cookies();
  const raw = c.get(DENSITY_COOKIE)?.value;
  return raw === 'compact' ? 'compact' : 'comfortable';
}

export async function setDensity(value: Density): Promise<void> {
  const c = await cookies();
  c.set(DENSITY_COOKIE, value, {
    path: '/',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365,
  });
}

/**
 * Tailwind class fragments keyed by density. Pages call `densityClasses()`
 * once and pick the relevant fragments instead of conditionally hardcoding
 * class strings.
 */
export function densityClasses(d: Density): {
  pad: string;
  gapBlock: string;
  gapInline: string;
  text: string;
} {
  if (d === 'compact') {
    return { pad: 'p-3', gapBlock: 'space-y-2', gapInline: 'gap-2', text: 'text-xs' };
  }
  return { pad: 'p-6', gapBlock: 'space-y-4', gapInline: 'gap-4', text: 'text-sm' };
}
