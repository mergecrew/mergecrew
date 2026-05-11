'use client';

import { type AdapterFormProps, Field } from './shared';

interface NetlifyConfig {
  siteId?: string;
}

export function NetlifyForm({ config, onChange }: AdapterFormProps) {
  const c = config as NetlifyConfig;
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Field
        label="Site ID"
        value={c.siteId ?? ''}
        onChange={(v) => onChange({ ...c, siteId: v })}
        placeholder="12345678-aaaa-bbbb-cccc-dddddddddddd"
        hint="Netlify's API site id (a UUID), NOT the user-facing slug."
      />
    </div>
  );
}

export function netlifyDefaultConfig(): Record<string, unknown> {
  return { siteId: '' };
}
