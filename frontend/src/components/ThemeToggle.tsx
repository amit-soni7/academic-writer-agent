import type { ReactNode } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';

interface Props {
  value: ThemePreference;
  onChange: (t: ThemePreference) => void;
  compact?: boolean;
}

const OPTIONS: { value: ThemePreference; label: string; icon: ReactNode }[] = [
  {
    value: 'light',
    label: 'Light',
    icon: (
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707m12.728 0l-.707-.707M6.343 6.343l-.707-.707M12 8a4 4 0 100 8 4 4 0 000-8z" />
      </svg>
    ),
  },
  {
    value: 'system',
    label: 'System',
    icon: (
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
      </svg>
    ),
  },
  {
    value: 'dark',
    label: 'Dark',
    icon: (
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
      </svg>
    ),
  },
];

export default function ThemeToggle({ value, onChange, compact = false }: Props) {
  return (
    <div
      className="flex items-center rounded-lg p-0.5 gap-0.5"
      style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-faint)' }}
      role="group"
      aria-label="Theme preference"
    >
      {OPTIONS.map((opt) => {
        const isActive = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            title={opt.label}
            aria-pressed={isActive}
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 transition-all duration-150 focus:outline-none"
            style={{
              background: isActive ? 'var(--bg-surface)' : 'transparent',
              color: isActive ? 'var(--gold)' : 'var(--text-muted)',
              boxShadow: isActive ? '0 1px 3px rgba(0,0,0,0.15)' : 'none',
              border: isActive ? '1px solid var(--border-muted)' : '1px solid transparent',
            }}
          >
            {opt.icon}
            {!compact && (
              <span
                className="font-mono text-[9px] uppercase tracking-widest leading-none"
                style={{ color: isActive ? 'var(--gold)' : 'var(--text-muted)' }}
              >
                {opt.label}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
