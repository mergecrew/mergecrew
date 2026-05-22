import {
  type ReactNode,
  type ButtonHTMLAttributes,
  type AnchorHTMLAttributes,
  type InputHTMLAttributes,
  Fragment,
} from 'react';
import Link from 'next/link';
import { clsx } from 'clsx';

/* ─────────────────────────────────────────────────────────────
   Surfaces
   ───────────────────────────────────────────────────────────── */

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx('border border-hair bg-paper shadow-card', className)}>
      {children}
    </div>
  );
}

export function CardHead({
  title,
  meta,
  right,
}: {
  title: string;
  meta?: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-hair-2 px-[18px] py-[14px]">
      <h3 className="m-0 text-[15px] font-semibold tracking-[-0.015em]">{title}</h3>
      {meta && <span className="font-mono text-[11px] text-muted whitespace-nowrap">{meta}</span>}
      {right && <div className="ml-auto">{right}</div>}
    </div>
  );
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('p-[18px]', className)}>{children}</div>;
}

/* ─────────────────────────────────────────────────────────────
   Buttons
   ───────────────────────────────────────────────────────────── */

type BtnVariant = 'primary' | 'accent' | 'energy' | 'ghost' | 'danger' | 'secondary' | 'destructive';
type BtnSize = 'sm' | 'md' | 'lg';

const BTN_BASE =
  'inline-flex items-center justify-center gap-2 border font-medium leading-none ' +
  'transition-[transform,background-color,border-color,color] duration-100 cursor-pointer ' +
  'hover:-translate-y-[1px] active:translate-y-0 disabled:opacity-50 disabled:pointer-events-none ' +
  'no-underline';

function btnSize(size: BtnSize) {
  return size === 'sm'
    ? 'px-[10px] py-[6px] text-[12.5px]'
    : size === 'lg'
      ? 'px-[20px] py-[13px] text-[14.5px]'
      : 'px-[14px] py-[9px] text-[13.5px]';
}

function btnVariant(v: BtnVariant) {
  // `secondary` and `destructive` are legacy variants kept for backward
  // compatibility with pre-redesign call sites — they map to the new
  // ghost / danger styles so the visual system stays consistent.
  switch (v) {
    case 'primary':
      return 'bg-ink border-ink text-paper hover:bg-ink-2';
    case 'accent':
      return 'bg-accent border-accent text-white hover:bg-accent-deep hover:border-accent-deep';
    case 'energy':
      return 'bg-energy border-energy text-white hover:bg-energy-deep hover:border-energy-deep';
    case 'ghost':
    case 'secondary':
      return 'bg-transparent border-ink text-ink hover:bg-paper';
    case 'danger':
    case 'destructive':
      return 'bg-paper border-energy text-energy-deep hover:bg-energy hover:text-white';
  }
}

export function Button({
  variant = 'primary',
  size = 'md',
  children,
  className,
  ...rest
}: {
  variant?: BtnVariant;
  size?: BtnSize;
  children: ReactNode;
  className?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'>) {
  return (
    <button {...rest} className={clsx(BTN_BASE, btnSize(size), btnVariant(variant), className)}>
      {children}
    </button>
  );
}

export function LinkButton({
  variant = 'primary',
  size = 'md',
  href,
  children,
  className,
  ...rest
}: {
  variant?: BtnVariant;
  size?: BtnSize;
  href: string;
  children: ReactNode;
  className?: string;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'className'>) {
  return (
    <Link {...rest} href={href} className={clsx(BTN_BASE, btnSize(size), btnVariant(variant), className)}>
      {children}
    </Link>
  );
}

export function Arrow() {
  return (
    <span
      className="relative inline-block h-px w-[12px] bg-current
        after:absolute after:right-[-1px] after:top-[-3px] after:h-[7px] after:w-[7px]
        after:rotate-45 after:border-r after:border-t after:border-current"
    />
  );
}

/* ─────────────────────────────────────────────────────────────
   Typography helpers
   ───────────────────────────────────────────────────────────── */

export function Label({
  children,
  accent,
  energy,
  className,
}: {
  children: ReactNode;
  accent?: boolean;
  energy?: boolean;
  className?: string;
}) {
  return (
    <span
      className={clsx(
        'font-mono text-[11px] uppercase tracking-[0.1em]',
        accent ? 'text-accent' : energy ? 'text-energy-deep' : 'text-muted',
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ─────────────────────────────────────────────────────────────
   Status indicators
   ───────────────────────────────────────────────────────────── */

export function StatusDot({
  status,
}: {
  status: 'running' | 'paused' | 'idle' | 'failed' | 'done' | 'pending';
}) {
  const cls =
    status === 'running'
      ? 'bg-positive animate-live-pulse'
      : status === 'pending'
        ? 'bg-energy animate-pulse-energy'
        : status === 'paused'
          ? 'bg-warn'
          : status === 'failed'
            ? 'bg-energy'
            : status === 'done'
              ? 'bg-muted'
              : 'bg-muted-2';
  return <span className={clsx('inline-block h-2 w-2 rounded-full', cls)} />;
}

type BadgeKind = 'healthy' | 'warn' | 'disabled' | 'accent';
export function StatBadge({ kind = 'healthy', children }: { kind?: BadgeKind; children: ReactNode }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-[6px] px-[8px] py-[3px]',
        'font-mono text-[10.5px] uppercase tracking-[0.06em]',
        kind === 'healthy' && 'bg-positive-soft text-positive-deep',
        kind === 'warn' && 'bg-energy-soft text-energy-deep',
        kind === 'accent' && 'bg-accent-soft text-accent-deep',
        kind === 'disabled' && 'bg-bg text-muted border border-hair',
      )}
    >
      <span className="h-[6px] w-[6px] rounded-full bg-current" />
      {children}
    </span>
  );
}

/* Replaces the old <Chip> — same name so old callers continue to compile. */
export function Chip({
  children,
  kind = 'neutral',
}: {
  children: ReactNode;
  kind?: 'low' | 'medium' | 'high' | 'neutral';
}) {
  return (
    <span
      className={clsx(
        'inline-block px-[8px] py-[3px] font-mono text-[11px] uppercase tracking-[0.06em]',
        kind === 'low' && 'bg-positive-soft text-positive-deep',
        kind === 'medium' && 'bg-energy-soft text-energy-deep',
        kind === 'high' && 'bg-energy text-white',
        kind === 'neutral' && 'bg-bg text-ink-2 border border-hair',
      )}
    >
      {children}
    </span>
  );
}

/* ─────────────────────────────────────────────────────────────
   Roles
   ───────────────────────────────────────────────────────────── */

export type Role =
  | 'owner'
  | 'admin'
  | 'operator'
  | 'reviewer'
  | 'viewer'
  | 'pending'
  | 'member';

export function RolePill({ role }: { role: Role }) {
  return (
    <span
      className={clsx(
        'inline-block px-[8px] py-[3px] font-mono text-[10.5px] uppercase tracking-[0.06em] border',
        role === 'owner' && 'bg-ink border-ink text-paper',
        role === 'admin' && 'bg-accent border-accent text-paper',
        role === 'operator' && 'bg-accent-soft border-accent text-accent-deep',
        role === 'reviewer' && 'bg-accent-soft border-accent text-accent-deep',
        role === 'viewer' && 'bg-bg border-hair text-ink-2',
        role === 'member' && 'bg-bg border-hair text-ink-2',
        role === 'pending' && 'bg-energy-soft border-energy text-energy-deep',
      )}
    >
      {role}
    </span>
  );
}

/* ─────────────────────────────────────────────────────────────
   Logo
   ───────────────────────────────────────────────────────────── */

export function Mark({ size = 32 }: { size?: number }) {
  return (
    <div
      className="relative border-[1.5px] border-ink bg-paper"
      style={{ width: size, height: size }}
    >
      <div className="absolute left-[4px] top-[4px] h-[10px] w-[10px] bg-accent" />
      <div className="absolute right-[4px] bottom-[4px] h-[10px] w-[10px] bg-ink" />
    </div>
  );
}

// Bump in lockstep with apps/web/package.json. Render-only; the
// orchestrator + API services have their own version strings.
const WEB_VERSION = '0.1.0';

export function Wordmark({ withTag = true, href = '/' }: { withTag?: boolean; href?: string }) {
  return (
    <Link href={href} className="group inline-flex items-center gap-[10px] no-underline text-ink sm:gap-[14px]">
      <Mark />
      <span className="text-[17px] font-semibold tracking-[-0.025em] sm:text-[19px]">Mergecrew</span>
      {withTag && (
        // Tag eats a lot of horizontal room on phones — hide it for
        // anything below `sm` so the header bar can fit without a
        // horizontal scroll.
        <span className="hidden font-mono text-[10px] uppercase tracking-[0.1em] text-muted sm:inline">
          v{WEB_VERSION} · alpha
        </span>
      )}
    </Link>
  );
}

/* ─────────────────────────────────────────────────────────────
   Form rows
   ───────────────────────────────────────────────────────────── */

export function FieldRow({
  label,
  required,
  help,
  children,
}: {
  label: string;
  required?: boolean;
  help?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[220px_1fr] gap-8 border-b border-hair-2 py-5 last:border-0">
      <div>
        <div className="text-[13.5px] font-medium tracking-[-0.005em] text-ink">
          {label}
          {required && <span className="ml-[2px] text-energy">*</span>}
        </div>
        {help && (
          <div className="mt-[6px] text-[12.5px] leading-[1.5] text-muted">{help}</div>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-2">{children}</div>
    </div>
  );
}

export function Toggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!value)}
      type="button"
      className={clsx(
        'relative h-[22px] w-[38px] rounded-full border-0 transition-colors cursor-pointer p-0',
        value ? 'bg-positive' : 'bg-hair-strong',
      )}
    >
      <i
        className={clsx(
          'absolute left-[2px] top-[2px] h-[18px] w-[18px] rounded-full bg-paper shadow transition-transform',
          value && 'translate-x-[16px]',
        )}
      />
    </button>
  );
}

export function ToggleRow({
  label,
  desc,
  value,
  onChange,
}: {
  label: string;
  desc?: ReactNode;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-8 border-b border-hair-2 py-[18px] last:border-0">
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium tracking-[-0.005em]">{label}</div>
        {desc && (
          <div className="mt-[5px] text-[12.5px] leading-[1.55] text-muted">{desc}</div>
        )}
      </div>
      <Toggle value={value} onChange={onChange} />
    </div>
  );
}

export function Input({
  mono,
  sm,
  ...rest
}: { mono?: boolean; sm?: boolean } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={clsx(
        'w-full border border-hair bg-paper-2 px-3 text-[13.5px] text-ink outline-none',
        'transition-[border-color,box-shadow] duration-100',
        'focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]',
        sm ? 'h-[30px] px-[10px] text-[12.5px]' : 'h-[36px]',
        mono && 'font-mono text-[13px]',
        rest.className,
      )}
    />
  );
}

/* ─────────────────────────────────────────────────────────────
   Page layout primitives
   ───────────────────────────────────────────────────────────── */

export function PageHead({
  crumb,
  title,
  meta,
  actions,
}: {
  crumb: { label: string; href?: string }[];
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b border-hair pb-5 sm:mb-7 sm:gap-6">
      <div className="min-w-0 flex-1">
        <div className="mb-[10px] flex flex-wrap items-center gap-[10px] font-mono text-[11px] uppercase tracking-[0.06em] text-muted">
          {crumb.map((c, i) => (
            <Fragment key={i}>
              {i > 0 && <span className="opacity-40">/</span>}
              {c.href ? (
                <Link
                  href={c.href}
                  className="break-all text-muted no-underline hover:text-ink"
                >
                  {c.label}
                </Link>
              ) : (
                <span className="break-all text-ink">{c.label}</span>
              )}
            </Fragment>
          ))}
        </div>
        <h1 className="m-0 break-words text-[24px] font-medium leading-[1.05] tracking-[-0.03em] sm:text-[32px] sm:leading-none md:text-[36px]">
          {title}
        </h1>
        {meta && <div className="mt-3 min-w-0 break-words text-[13px] text-ink-2 sm:text-[14px]">{meta}</div>}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-[10px]">
          {actions}
        </div>
      )}
    </div>
  );
}

export function Tile({
  k,
  v,
  n,
  accent,
  energy,
  positive,
  delta,
}: {
  k: string;
  v: string;
  n?: string;
  accent?: boolean;
  energy?: boolean;
  positive?: boolean;
  delta?: { dir: 'up' | 'down'; label: string };
}) {
  return (
    <div className="border border-hair bg-paper px-[18px] py-[16px]">
      <span className="mb-[10px] block font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted">
        {k}
      </span>
      <div
        className={clsx(
          'text-[26px] font-medium leading-none tracking-[-0.025em] whitespace-nowrap',
          accent && 'text-accent',
          energy && 'text-energy-deep',
          positive && 'text-positive-deep',
        )}
      >
        {v}
      </div>
      {n && <div className="mt-[6px] truncate text-[12.5px] text-ink-2">{n}</div>}
      {delta && (
        <div
          className={clsx(
            'mt-1 font-mono text-[11px]',
            delta.dir === 'up' ? 'text-positive-deep' : 'text-energy-deep',
          )}
        >
          {delta.dir === 'up' ? '↑ ' : '↓ '}
          {delta.label}
        </div>
      )}
    </div>
  );
}

/* Lightweight stat cell — label on top, value below. Sized smaller
   than <Tile> so a stack of them fits inside a Card. Tone tints the
   value (positive ⇒ shipped/healthy, energy ⇒ overspend/warning). */
export function Stat({
  label,
  value,
  tone,
  mono = true,
}: {
  label: string;
  value: ReactNode;
  tone?: 'energy' | 'positive';
  /** Default true — numeric stats look right in Geist Mono. Set false for prose values. */
  mono?: boolean;
}) {
  return (
    <div>
      <div className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted">
        {label}
      </div>
      <div
        className={clsx(
          'mt-1 text-[16px] tabular-nums',
          mono && 'font-mono',
          tone === 'energy'
            ? 'text-energy-deep'
            : tone === 'positive'
              ? 'text-positive-deep'
              : 'text-ink',
        )}
      >
        {value}
      </div>
    </div>
  );
}
