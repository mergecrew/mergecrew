import { revalidatePath } from 'next/cache';
import { getDensity, setDensity, type Density } from '@/lib/preferences';

async function toggleAction(formData: FormData) {
  'use server';
  const next = String(formData.get('next') ?? '') as Density;
  if (next !== 'compact' && next !== 'comfortable') return;
  await setDensity(next);
  const path = String(formData.get('path') ?? '/');
  revalidatePath(path);
}

/**
 * Two-button toggle for the user's density preference. Server-rendered;
 * uses a server action to set the cookie and revalidate the calling page.
 *
 * Caller must pass `revalidate` (the page path that should re-render after
 * the cookie flip) — `next/headers` doesn't expose pathname server-side.
 */
export async function DensityToggle({ revalidate }: { revalidate: string }) {
  const current = await getDensity();
  return (
    <form action={toggleAction} className="inline-flex rounded-md border bg-zinc-50 p-0.5 text-xs dark:bg-zinc-900 dark:border-zinc-800">
      <input type="hidden" name="path" value={revalidate} />
      <DensityButton current={current} value="comfortable" label="Cozy" />
      <DensityButton current={current} value="compact" label="Compact" />
    </form>
  );
}

function DensityButton({
  current,
  value,
  label,
}: {
  current: Density;
  value: Density;
  label: string;
}) {
  const active = current === value;
  return (
    <button
      type="submit"
      name="next"
      value={value}
      className={
        'rounded px-2 py-1 ' +
        (active
          ? 'bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900'
          : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800')
      }
      aria-pressed={active}
    >
      {label}
    </button>
  );
}
