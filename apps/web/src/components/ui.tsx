import { type ReactNode, type ButtonHTMLAttributes } from 'react';
import { clsx } from 'clsx';
import Link from 'next/link';

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={clsx(
        'rounded-lg border bg-[rgb(var(--card))] p-4 shadow-sm',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Button({ children, variant = 'primary', className, ...rest }: {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost' | 'destructive';
  className?: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={clsx(
        'inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm transition-colors',
        variant === 'primary' && 'bg-accent text-accent-fg hover:opacity-90',
        variant === 'secondary' && 'border bg-transparent hover:bg-zinc-100 dark:hover:bg-zinc-800',
        variant === 'ghost' && 'hover:bg-zinc-100 dark:hover:bg-zinc-800',
        variant === 'destructive' && 'bg-red-600 text-white hover:bg-red-700',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function LinkButton(props: { href: string; children: ReactNode; variant?: 'primary' | 'secondary' | 'ghost' }) {
  return (
    <Link
      href={props.href}
      className={clsx(
        'inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm transition-colors',
        props.variant === 'primary' && 'bg-accent text-accent-fg hover:opacity-90',
        (props.variant ?? 'secondary') === 'secondary' && 'border bg-transparent hover:bg-zinc-100 dark:hover:bg-zinc-800',
        props.variant === 'ghost' && 'hover:bg-zinc-100 dark:hover:bg-zinc-800',
      )}
    >
      {props.children}
    </Link>
  );
}

export function StatusDot({ status }: { status: 'running' | 'paused' | 'idle' | 'failed' | 'done' }) {
  const cls =
    status === 'running' ? 'bg-emerald-500 animate-pulse' :
    status === 'paused' ? 'bg-amber-500' :
    status === 'failed' ? 'bg-red-500' :
    status === 'done' ? 'bg-zinc-400' :
    'bg-zinc-300';
  return <span className={clsx('inline-block h-2 w-2 rounded-full', cls)} />;
}

export function Chip({ children, kind = 'neutral' }: { children: ReactNode; kind?: 'low' | 'medium' | 'high' | 'neutral' }) {
  return (
    <span
      className={clsx(
        'inline-block rounded-full px-2 py-0.5 text-xs',
        kind === 'low' && 'bg-emerald-100 text-emerald-800',
        kind === 'medium' && 'bg-amber-100 text-amber-800',
        kind === 'high' && 'bg-red-100 text-red-800',
        kind === 'neutral' && 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200',
      )}
    >
      {children}
    </span>
  );
}
