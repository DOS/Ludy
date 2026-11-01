import { Archive, ArrowRight, Check, FileSpreadsheet, FileUp, Lock, Mail, TriangleAlert } from 'lucide-react';
import type { AccountingCopy } from '../../content/accounting-vi';
import type { Dictionary } from '../../content/vi';
import { SalesNumberGaps, VatBreakdown } from '../landing/finance-fragments';
import { Chip } from '../landing/ui';

// The pieces of Ludy Kế toán the page draws, in HTML with the example data of the home page's sample company (DESIGN.md
// 2 and 6.2): each is something the product shows today. Panel titles are not headings, so the page's outline stays
// the section titles and the feature groups.
type Props = { dict: Dictionary; copy: AccountingCopy };

function PanelTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <span className="text-sm font-semibold">{title}</span>
      {sub ? <span className="text-xs text-subtle">{sub}</span> : null}
    </div>
  );
}

// The hero: one purchase invoice as Ludy read it, the fixed checks it passed and the entry proposed from it, drawn as a
// proposal (dashed, "Đề xuất") with the approve button that asks for the two-factor code.
export function AccountingHero({ dict, copy }: Props) {
  const { detail } = dict.shell;
  const f = copy.fragments.hero;
  return (
    <figure aria-label={f.label} className="rounded-lg border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-4 text-xs text-subtle">
        <span>{dict.shell.org}</span>
        <Chip tone="neutral">{copy.fragments.sample}</Chip>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="flex min-w-0 flex-col rounded-md border border-line bg-bg p-4">
          <PanelTitle title={detail.title} sub={detail.sub} />
          <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
            {detail.meta.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-subtle">{label}</dt>
                <dd className="num min-w-0 truncate">{value}</dd>
              </div>
            ))}
          </dl>
          <ul className="mt-3 flex flex-col gap-2 border-t border-line pt-3 text-xs">
            {detail.lines.map((line) => (
              <li key={line.name} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3">
                <span className="min-w-0 font-medium">{line.name}</span>
                <span className="num text-right">{line.amount}</span>
                <span className="num col-span-2 text-subtle">{line.qty}</span>
              </li>
            ))}
          </ul>
          <dl className="mt-auto flex flex-col gap-1 border-t border-line pt-3 text-xs">
            {detail.totals.map(([label, value]) => (
              <div key={label} className="flex justify-between gap-3">
                <dt className="text-subtle">{label}</dt>
                <dd className="num">{value}</dd>
              </div>
            ))}
            <div className="flex justify-between gap-3 border-t border-line pt-1.5 text-sm font-semibold">
              <dt>{detail.grand[0]}</dt>
              <dd className="num">{detail.grand[1]}</dd>
            </div>
          </dl>
        </div>

        <div className="flex min-w-0 flex-col rounded-md border border-line bg-bg p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold">{f.checksTitle}</span>
            <Chip tone="ok">{detail.checksBadge}</Chip>
          </div>
          <ul className="mt-3 flex flex-col gap-2.5 text-sm">
            {detail.checks.map((check) => (
              <li key={check} className="flex items-center gap-2">
                <span className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-ok-soft text-ok">
                  <Check className="size-3" strokeWidth={3} aria-hidden="true" />
                </span>
                {check}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex min-w-0 flex-col rounded-md border border-dashed border-accent/60 bg-bg p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold">{f.entryTitle}</span>
            <Chip tone="accent">{f.proposal}</Chip>
          </div>
          <ul className="mt-3 flex flex-col gap-2.5 text-xs">
            {dict.entry.lines.map((line) => (
              <li key={line.account} className={`grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 ${line.side === 'credit' ? 'pl-4' : ''}`}>
                <span className="num font-semibold">
                  {line.side === 'credit' ? dict.entry.credit : dict.entry.debit} {line.account}
                </span>
                <span className="num">{line.amount}</span>
                <span className="col-span-2 text-subtle">{line.name}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex items-center gap-2 text-xs">
            <Chip tone="ok">{dict.flow.proposal.balanced}</Chip>
            <span className="text-subtle">{dict.flow.proposal.balancedNote}</span>
          </div>
          <p className="mt-3 border-t border-line pt-3 text-xs text-subtle">{f.learned}</p>
          <div className="mt-auto pt-4">
            <span className="flex h-9 items-center justify-center rounded-md bg-accent text-sm font-medium text-accent-fg">{dict.flow.approve.button}</span>
            <p className="mt-2 flex items-center gap-1.5 text-xs text-subtle">
              <Lock className="size-3.5 shrink-0" aria-hidden="true" />
              {f.approveNote}
            </p>
          </div>
        </div>
      </div>
    </figure>
  );
}

// Receive and check: the two ways a document arrives, and an invoice the checks held back.
export function IntakeVisual({ copy }: Props) {
  const f = copy.fragments.intake;
  const icons = [FileUp, Mail];
  return (
    <figure className="rounded-md border border-line bg-bg">
      <figcaption className="border-b border-line px-4 py-3">
        <PanelTitle title={f.title} sub={f.sub} />
        <span className="sr-only">{copy.fragments.sample}</span>
      </figcaption>
      <div className="px-4 py-3">
        <div className="text-xs text-subtle">{f.sourcesLabel}</div>
        <ul className="mt-2 grid gap-3 sm:grid-cols-2">
          {f.sources.map((source, i) => {
            const Icon = icons[i] ?? FileUp;
            return (
              <li key={source.label} className="flex min-w-0 items-start gap-2.5 text-sm">
                <Icon className="mt-0.5 size-4 shrink-0 text-subtle" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block font-medium">{source.label}</span>
                  <span className="block text-xs text-muted">{source.body}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="border-t border-line px-4 py-4">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-sm">
          <span className="min-w-0 font-medium">{f.held.party}</span>
          <span className="num text-right">{f.held.amount}</span>
          <span className="text-xs text-subtle">{f.held.sub}</span>
        </div>
        <ul className="mt-3 flex flex-col gap-2 text-xs">
          <li className="flex items-start gap-2 text-warn">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span className="font-medium">{f.held.failed}</span>
          </li>
          <li className="flex items-start gap-2 text-muted">
            <Check className="mt-0.5 size-3.5 shrink-0 text-ok" strokeWidth={3} aria-hidden="true" />
            <span>{f.held.passed}</span>
          </li>
        </ul>
        <div className="mt-3">
          <Chip tone="warn">{f.held.state}</Chip>
        </div>
      </div>
    </figure>
  );
}

// Post with control: a learned account rule with where it came from, a line no rule matched, and a replacement invoice.
export function PostingVisual({ copy }: Props) {
  const f = copy.fragments.posting;
  return (
    <figure className="rounded-md border border-line bg-bg">
      <figcaption className="sr-only">{copy.fragments.sample}</figcaption>
      <div className="px-4 py-3">
        <div className="text-sm font-semibold">{f.ruleTitle}</div>
        <div className="mt-2">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-subtle">
                {f.ruleHead.map((cell) => (
                  <th key={cell} scope="col" className="pr-3 pb-1.5 font-medium last:pr-0 last:text-right">
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-line">
                <td className="py-2 pr-3 font-medium">{f.rule.party}</td>
                <td className="py-2 pr-3">{f.rule.item}</td>
                <td className="num py-2 text-right font-semibold">{f.rule.account}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-xs text-subtle">{f.rule.by}</p>
      </div>
      <div className="border-t border-line px-4 py-3">
        <div className="text-sm font-semibold">{f.unclassifiedTitle}</div>
        <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 text-xs">
          <span className="min-w-0 font-medium">{f.unclassified.item}</span>
          <span className="num text-right">{f.unclassified.amount}</span>
          <span className="col-span-2">
            <Chip tone="warn" wrap>
              <TriangleAlert className="size-3" aria-hidden="true" />
              {f.unclassified.state}
            </Chip>
          </span>
        </div>
      </div>
      <div className="border-t border-line px-4 py-3">
        <div className="text-sm font-semibold">{f.replaceTitle}</div>
        <ol className="mt-2 flex flex-col gap-2 text-xs sm:flex-row sm:items-stretch sm:gap-3">
          <li className="min-w-0 flex-1 rounded-sm border border-dashed border-line-strong/70 px-3 py-2">
            <span className="num block font-semibold line-through">{f.replaceFrom.name}</span>
            <span className="block text-subtle">{f.replaceFrom.state}</span>
          </li>
          <li className="hidden items-center text-subtle sm:flex" aria-hidden="true">
            <ArrowRight className="size-4" />
          </li>
          <li className="min-w-0 flex-1 rounded-sm border border-line bg-surface px-3 py-2">
            <span className="num block font-semibold">{f.replaceTo.name}</span>
            <span className="block text-subtle">{f.replaceTo.state}</span>
          </li>
        </ol>
      </div>
    </figure>
  );
}

// VAT and the calendar: input VAT by vendor, the return as an export for HTKK, the sales number gaps, the tax calendar
// of a client and the email that asks for missing invoices.
export function TaxVisual({ dict, copy }: Props) {
  const f = copy.fragments.tax;
  const { vat, sales } = dict.modules.finance;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <span className="sr-only">{copy.fragments.sample}</span>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-4">
          <VatBreakdown vat={vat} />
          <div className="rounded-md border border-line bg-bg p-3 text-xs">
            <div className="flex items-center gap-2">
              <FileSpreadsheet className="size-4 shrink-0 text-subtle" aria-hidden="true" />
              <span className="min-w-0 flex-1 text-sm font-semibold">{f.returnTitle}</span>
            </div>
            <div className="mt-2 font-medium">{f.returnFile}</div>
            <p className="mt-1 text-subtle">{f.returnNote}</p>
          </div>
        </div>
        <figure className="min-w-0 rounded-md border border-line bg-bg p-3">
          <figcaption>
            <PanelTitle title={f.calendarTitle} sub={f.calendarSub} />
          </figcaption>
          <ul className="mt-3 flex flex-col divide-y divide-line">
            {f.calendar.map((row) => (
              <li key={row.name} className="flex flex-col gap-1.5 py-2.5 text-xs first:pt-0">
                <span className="font-medium">{row.name}</span>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-subtle">{f.dueLabel}</span>
                  <span className="num">{row.due}</span>
                  <Chip tone={row.tone}>
                    {row.tone === 'ok' ? <Check className="size-3" strokeWidth={3} aria-hidden="true" /> : null}
                    {row.state}
                  </Chip>
                </span>
                {row.note ? <span className="text-subtle">{row.note}</span> : null}
              </li>
            ))}
          </ul>
          <p className="mt-1 border-t border-line pt-2 text-xs text-subtle">{f.calendarNote}</p>
        </figure>
      </div>
      <SalesNumberGaps sales={sales} />
      <figure className="min-w-0 rounded-md border border-line bg-bg p-3 text-xs">
        <figcaption className="flex items-start gap-2">
          <Mail className="mt-0.5 size-4 shrink-0 text-subtle" aria-hidden="true" />
          <span className="min-w-0">
            <span className="block text-sm font-semibold">{f.mailTitle}</span>
            <span className="block text-subtle">{f.mailSub}</span>
          </span>
        </figcaption>
        <div className="mt-3 rounded-sm border border-line bg-surface p-3">
          <div className="font-medium">{f.mailSubject}</div>
          <p className="mt-1.5 text-muted">{f.mailBody}</p>
          <ul className="mt-2 flex flex-col gap-1">
            {f.mailRows.map(([what, amount]) => (
              <li key={what} className="flex justify-between gap-3">
                <span className="min-w-0">{what}</span>
                <span className="num shrink-0">{amount}</span>
              </li>
            ))}
          </ul>
        </div>
      </figure>
    </div>
  );
}

// Books and period end: the closing steps of a year and the files the books export to.
export function BooksVisual({ copy }: Props) {
  const f = copy.fragments.books;
  return (
    <figure className="rounded-md border border-line bg-bg">
      <figcaption className="sr-only">{copy.fragments.sample}</figcaption>
      <div className="px-4 py-3">
        <PanelTitle title={f.closeTitle} sub={f.closeSub} />
        <ol className="mt-3 flex flex-col divide-y divide-line">
          {f.close.map((step) => (
            <li key={step.name} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-2.5 text-sm first:pt-0">
              <span className="flex min-w-0 items-center gap-2 font-medium">
                {step.tone === 'ok' ? <Lock className="size-4 shrink-0 text-ok" aria-hidden="true" /> : <Archive className="size-4 shrink-0 text-subtle" aria-hidden="true" />}
                {step.name}
              </span>
              <Chip tone={step.tone} wrap>
                {step.state}
              </Chip>
            </li>
          ))}
        </ol>
      </div>
      <div className="border-t border-line px-4 py-3">
        <div className="text-sm font-semibold">{f.exportsTitle}</div>
        <ul className="mt-3 flex flex-col divide-y divide-line">
          {f.exports.map((file) => (
            <li key={file.name} className="flex items-start justify-between gap-3 py-2.5 text-xs first:pt-0">
              <span className="min-w-0">
                <span className="block text-sm font-medium">{file.name}</span>
                <span className="block text-muted">{file.body}</span>
              </span>
              <Chip tone="neutral">{file.format}</Chip>
            </li>
          ))}
        </ul>
        <p className="mt-2 border-t border-line pt-2 text-xs text-subtle">{f.draftNote}</p>
      </div>
    </figure>
  );
}
