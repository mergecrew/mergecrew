'use client';

import { type AdapterFormProps, Field } from './shared';

interface FlyConfig {
  appName?: string;
  imageTemplate?: string;
  region?: string;
  publicUrl?: string;
}

export function FlyForm({ config, onChange }: AdapterFormProps) {
  const c = config as FlyConfig;
  const update = (patch: Partial<FlyConfig>) => onChange({ ...c, ...patch });
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Field
        label="App name"
        value={c.appName ?? ''}
        onChange={(v) => update({ appName: v })}
        placeholder="acme-api-dev"
        hint="As it appears in Fly's dashboard / DNS."
      />
      <Field
        label="Image template"
        value={c.imageTemplate ?? ''}
        onChange={(v) => update({ imageTemplate: v })}
        placeholder="registry.fly.io/acme-api-dev:${sha}"
        hint="${sha} → opts.ref at trigger time."
      />
      <Field
        label="Region (optional)"
        value={c.region ?? ''}
        onChange={(v) => update({ region: v })}
        placeholder="iad"
      />
      <Field
        label="Public URL override (optional)"
        value={c.publicUrl ?? ''}
        onChange={(v) => update({ publicUrl: v })}
        placeholder="https://acme-api-dev.fly.dev"
      />
    </div>
  );
}

export function flyDefaultConfig(): Record<string, unknown> {
  return { appName: '', imageTemplate: 'registry.fly.io/${appName}:${sha}' };
}
