import type { ReactNode } from 'react';
import type { Tone } from '../../content/vi';

const CHIP_TONES: Record<Tone, string> = {
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  accent: 'bg-accent-soft text-accent-ink',
  neutral: 'bg-surface-2 text-muted',
};

export function toneOf(value: string): Tone {
  return value === 'ok' || value === 'warn' || value === 'accent' ? value : 'neutral';
}

export function Chip({ tone = 'neutral', wrap = false, children, className = '' }: { tone?: Tone; wrap?: boolean; children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${wrap ? 'max-w-full' : 'whitespace-nowrap'} ${CHIP_TONES[tone]} ${className}`}>
      {children}
    </span>
  );
}

export function Kbd({ children, small = false }: { children: ReactNode; small?: boolean }) {
  return (
    <kbd
      className={`inline-flex items-center justify-center rounded-sm border border-line-strong/60 bg-surface font-mono font-medium text-muted ${
        small ? 'h-5 min-w-5 px-1 text-[11px]' : 'h-7 min-w-7 px-1.5 text-xs'
      }`}
    >
      {children}
    </kbd>
  );
}

export function SectionHead({ id, title, lead, children }: { id: string; title: string; lead?: string; children?: ReactNode }) {
  return (
    <div className="mb-10 grid gap-4 md:mb-12 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:items-end md:gap-12">
      <h2 id={id} className="font-display text-[1.75rem] leading-[1.15] font-semibold tracking-[-0.02em] text-fg sm:text-4xl">
        {title}
      </h2>
      {lead ? <p className="max-w-[62ch] text-base text-muted sm:text-lg">{lead}</p> : null}
      {children}
    </div>
  );
}

const BUTTON = 'inline-flex h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium whitespace-nowrap transition-colors';

export function ButtonLink({ href, children, variant = 'primary', className = '' }: { href: string; children: ReactNode; variant?: 'primary' | 'secondary'; className?: string }) {
  const look =
    variant === 'primary'
      ? 'bg-accent text-accent-fg hover:bg-accent/90'
      : 'border border-line-strong/70 bg-surface text-fg hover:bg-surface-2';
  return (
    <a href={href} className={`${BUTTON} ${look} ${className}`}>
      {children}
    </a>
  );
}

export function Section({ id, labelledBy, children, tinted = false }: { id?: string; labelledBy: string; children: ReactNode; tinted?: boolean }) {
  return (
    <section id={id} aria-labelledby={labelledBy} className={`py-16 sm:py-24 ${tinted ? 'border-y border-line bg-surface-2/40' : ''}`}>
      <div className="wrap">{children}</div>
    </section>
  );
}

// The brand mark: four keycaps that spell L, U, D and Y, the Y key in teal (Vy, the AI assistant), in the brand colors.
// The same paths as public/brand/ludy-mark.svg; public/favicon.svg draws the keys alone.
export function LudyMark({ className = 'size-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 92 92" className={className} aria-hidden="true">
      <path className="fill-brand-lip" d="M0 15A11 11 0 0 1 11 4H32A11 11 0 0 1 43 15V32A11 11 0 0 1 32 43H11A11 11 0 0 1 0 32ZM49 15A11 11 0 0 1 60 4H81A11 11 0 0 1 92 15V32A11 11 0 0 1 81 43H60A11 11 0 0 1 49 32ZM0 64A11 11 0 0 1 11 53H32A11 11 0 0 1 43 64V81A11 11 0 0 1 32 92H11A11 11 0 0 1 0 81Z" />
      <path className="fill-brand-spark-lip" d="M49 64A11 11 0 0 1 60 53H81A11 11 0 0 1 92 64V81A11 11 0 0 1 81 92H60A11 11 0 0 1 49 81Z" />
      <path className="fill-brand" d="M0 11A11 11 0 0 1 11 0H32A11 11 0 0 1 43 11V28A11 11 0 0 1 32 39H11A11 11 0 0 1 0 28ZM49 11A11 11 0 0 1 60 0H81A11 11 0 0 1 92 11V28A11 11 0 0 1 81 39H60A11 11 0 0 1 49 28ZM0 60A11 11 0 0 1 11 49H32A11 11 0 0 1 43 60V77A11 11 0 0 1 32 88H11A11 11 0 0 1 0 77Z" />
      <path className="fill-brand-spark" d="M49 60A11 11 0 0 1 60 49H81A11 11 0 0 1 92 60V77A11 11 0 0 1 81 88H60A11 11 0 0 1 49 77Z" />
      <path className="fill-none stroke-brand-ink" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" d="M14.85 8.1V30.9H28.15M61.95 8.1V22.35A8.55 8.55 0 0 0 79.05 22.35V8.1M12 57.1H19.6A11.4 11.4 0 0 1 19.6 79.9H12Z" />
      <path className="fill-none stroke-brand-spark-ink" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" d="M61.95 57.1L70.5 69.1L79.05 57.1M70.5 69.1V79.9" />
    </svg>
  );
}
