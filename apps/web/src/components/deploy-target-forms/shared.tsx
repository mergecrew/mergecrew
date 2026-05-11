'use client';

import { type ReactNode } from 'react';

export interface AdapterFormProps {
  config: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}

export function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
  mono = true,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: ReactNode;
  mono?: boolean;
}) {
  return (
    <label className="text-sm">
      <span className="block text-zinc-600 dark:text-zinc-400">{label}</span>
      <input
        className={`mt-1 w-full rounded border px-2 py-1 dark:bg-zinc-900 dark:border-zinc-700 ${mono ? 'font-mono' : ''}`}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <span className="block text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  hint?: ReactNode;
}) {
  return (
    <label className="text-sm">
      <span className="block text-zinc-600 dark:text-zinc-400">{label}</span>
      <select
        className="mt-1 w-full rounded border px-2 py-1 dark:bg-zinc-900 dark:border-zinc-700"
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && <span className="block text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}
