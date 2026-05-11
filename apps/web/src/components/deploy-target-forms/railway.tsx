'use client';

import { type AdapterFormProps, Field } from './shared';

interface RailwayConfig {
  projectId?: string;
  environmentId?: string;
  serviceId?: string;
}

export function RailwayForm({ config, onChange }: AdapterFormProps) {
  const c = config as RailwayConfig;
  const update = (patch: Partial<RailwayConfig>) => onChange({ ...c, ...patch });
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Field
        label="Project ID"
        value={c.projectId ?? ''}
        onChange={(v) => update({ projectId: v })}
        placeholder="01234567-89ab-cdef-0123-456789abcdef"
      />
      <Field
        label="Environment ID"
        value={c.environmentId ?? ''}
        onChange={(v) => update({ environmentId: v })}
        placeholder="01234567-89ab-cdef-0123-456789abcdef"
      />
      <Field
        label="Service ID"
        value={c.serviceId ?? ''}
        onChange={(v) => update({ serviceId: v })}
        placeholder="01234567-89ab-cdef-0123-456789abcdef"
      />
    </div>
  );
}

export function railwayDefaultConfig(): Record<string, unknown> {
  return { projectId: '', environmentId: '', serviceId: '' };
}
