import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg:       { DEFAULT: 'var(--bg)', 2: 'var(--bg-2)' },
        paper:    { DEFAULT: 'var(--paper)', 2: 'var(--paper-2)' },
        ink:      { DEFAULT: 'var(--ink)', 2: 'var(--ink-2)', 3: 'var(--ink-3)' },
        muted:    { DEFAULT: 'var(--muted)', 2: 'var(--muted-2)' },
        hair:     { DEFAULT: 'var(--hair)', 2: 'var(--hair-2)', strong: 'var(--hair-strong)' },
        accent:   { DEFAULT: 'var(--accent)', deep: 'var(--accent-deep)', soft: 'var(--accent-soft)', tint: 'var(--accent-tint)' },
        energy:   { DEFAULT: 'var(--energy)', deep: 'var(--energy-deep)', soft: 'var(--energy-soft)' },
        positive: { DEFAULT: 'var(--positive)', deep: 'var(--positive-deep)', soft: 'var(--positive-soft)' },
        warn:     'var(--warn)',
      },
      fontFamily: {
        sans: ['var(--font-geist)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-geist-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        card:         '0 1px 0 rgba(11,19,32,0.04), 0 8px 24px -8px rgba(11,19,32,0.08)',
        'card-hover': '0 1px 0 rgba(11,19,32,0.06), 0 16px 36px -10px rgba(11,19,32,0.14)',
        pop:          '0 1px 0 rgba(11,19,32,0.06), 0 24px 48px -12px rgba(11,19,32,0.18)',
      },
      borderRadius: {
        DEFAULT: '0',
        sm: '4px',
        md: '6px',
      },
      keyframes: {
        'live-pulse':   { '0%, 100%': { boxShadow: '0 0 0 0 rgba(16,185,129,0.45)' }, '50%': { boxShadow: '0 0 0 5px rgba(16,185,129,0)' } },
        'step-pulse':   { '0%, 100%': { boxShadow: '0 0 0 0 rgba(14,91,201,0.5)' },   '50%': { boxShadow: '0 0 0 6px rgba(14,91,201,0)' } },
        'pulse-energy': { '0%, 100%': { boxShadow: '0 0 0 0 rgba(255,77,84,0.5)' },   '50%': { boxShadow: '0 0 0 6px rgba(255,77,84,0)' } },
        blink:          { '50%': { opacity: '0' } },
        'ul-in':        { to: { transform: 'scaleX(1)' } },
      },
      animation: {
        'live-pulse':   'live-pulse 1.6s ease-in-out infinite',
        'step-pulse':   'step-pulse 1.6s ease-in-out infinite',
        'pulse-energy': 'pulse-energy 1.8s ease-in-out infinite',
        blink:          'blink 1.1s steps(2) infinite',
        'ul-in':        'ul-in 1.1s cubic-bezier(.7,.2,.2,1) 0.4s forwards',
      },
    },
  },
  plugins: [],
};

export default config;
