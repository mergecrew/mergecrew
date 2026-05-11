'use client';

import { type AdapterFormProps, Field } from './shared';

interface RenderConfig {
  serviceId?: string;
}

export function RenderForm({ config, onChange }: AdapterFormProps) {
  const c = config as RenderConfig;
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Field
        label="Service ID"
        value={c.serviceId ?? ''}
        onChange={(v) => onChange({ ...c, serviceId: v })}
        placeholder="srv-abc123def456"
      />
    </div>
  );
}

export function renderDefaultConfig(): Record<string, unknown> {
  return { serviceId: '' };
}
