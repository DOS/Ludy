import type { Dictionary } from '../../content/vi';

type Finance = Dictionary['modules']['finance'];

const VAT_SHADES = ['bg-accent', 'bg-accent/55', 'bg-accent/30'];

// The quarter's input VAT, split by vendor: the total, a bar to scale and the amounts. Used by the home page's Ludy Kế
// toán card and by the Ludy Kế toán page.
export function VatBreakdown({ vat, className = '' }: { vat: Finance['vat']; className?: string }) {
  return (
    <figure className={`rounded-md border border-line bg-bg p-3 ${className}`}>
      <figcaption className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold">{vat.title}</span>
      </figcaption>
      <div className="num mt-1 font-display text-2xl font-semibold tracking-[-0.01em]">{vat.total}</div>
      <div className="mt-3 flex h-2.5 gap-0.5 overflow-hidden rounded-sm" aria-hidden="true">
        {vat.rows.map((row, i) => (
          <span key={row.name} className={`block h-full min-w-1 ${VAT_SHADES[i] ?? 'bg-accent/20'}`} style={{ width: `${row.pct}%` }} />
        ))}
      </div>
      <ul className="mt-3 flex flex-col gap-1.5 text-xs">
        {vat.rows.map((row, i) => (
          <li key={row.name} className="flex items-center gap-2">
            <span className={`size-2 shrink-0 rounded-[2px] ${VAT_SHADES[i] ?? 'bg-accent/20'}`} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-muted">{row.name}</span>
            <span className="num">{row.amount}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

// The sales invoice series with the numbers missing from it marked, as the VAT screen shows them before a return is
// filed. The missing numbers are also named in visible text under the grid, so a color is never the only signal.
export function SalesNumberGaps({ sales, className = '' }: { sales: Finance['sales']; className?: string }) {
  return (
    <figure className={`min-w-0 rounded-md border border-line bg-bg p-3 ${className}`}>
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="text-sm font-semibold">{sales.title}</span>
        <span className="text-xs text-subtle">{sales.sub}</span>
      </figcaption>
      <ol className="mt-3 grid grid-cols-4 gap-1.5 sm:grid-cols-10" aria-label={sales.summary}>
        {Array.from({ length: sales.last - sales.first + 1 }, (_, k) => {
          const n = sales.first + k;
          const gap = sales.gaps.includes(n);
          return (
            <li
              key={n}
              className={`num rounded-sm border px-1 py-1 text-center text-xs ${gap ? 'border-dashed border-warn/70 bg-warn-soft font-semibold text-warn' : 'border-line bg-surface text-muted'}`}
            >
              {String(n).padStart(8, '0').slice(-5)}
            </li>
          );
        })}
      </ol>
      <p className="mt-3 text-xs text-muted">{sales.summary}</p>
      <p className="mt-1 text-xs text-subtle">{sales.hint}</p>
    </figure>
  );
}
