// SPDX-License-Identifier: AGPL-3.0-only
// Product visuals for the Ludy Nhân sự page (/nhan-su), rendered in pure HTML with the home page's sample company
// (Gạo Sạch Mekong) and semantic design tokens. Panel titles stay plain elements so the document heading outline stays
// strictly section titles and feature groups.
import {
  BriefcaseBusiness,
  Calendar,
  Check,
  FileSpreadsheet,
  Lock,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  UsersRound,
} from 'lucide-react';
import type { HrmCopy } from '../../content/hrm-vi';
import type { Dictionary } from '../../content/vi';
import { Chip } from '../landing/ui';

type Props = { dict: Dictionary; copy: HrmCopy };

function PanelTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <span className="min-w-0 text-sm font-semibold text-fg">{title}</span>
      {sub ? <span className="min-w-0 text-xs text-subtle">{sub}</span> : null}
    </div>
  );
}

// Hero: draft monthly pay run (owners & admins only), pseudonymized AI anomaly review, and four-eyes aggregate handoff.
export function HrmHero({ dict, copy }: Props) {
  const f = copy.fragments.hero;
  return (
    <figure aria-label={f.label} className="rounded-lg border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-4 text-xs text-subtle">
        <span>{dict.shell.org}</span>
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip tone="accent" wrap>
            <Lock className="size-3 shrink-0" aria-hidden="true" />
            {f.roleBadge}
          </Chip>
          <Chip tone="neutral">{copy.fragments.sample}</Chip>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,0.95fr)]">
        {/* Left: Draft monthly pay run */}
        <div className="flex min-w-0 flex-col rounded-md border border-line bg-bg p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-semibold text-fg">{f.runTitle}</span>
            <Chip tone="accent">{f.runState}</Chip>
          </div>
          <span className="mt-1 text-xs text-subtle">{f.employeesCount}</span>

          <ul className="mt-3 flex flex-col gap-2.5 border-t border-line pt-3 text-xs">
            {f.rows.map((row) => (
              <li key={row.name} className="rounded-sm border border-line bg-surface p-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-fg">{row.name}</span>
                  <Chip tone={row.tone} wrap>
                    {row.tag}
                  </Chip>
                </div>
                <div className="mt-1 text-muted">{row.dept}</div>
                <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2 border-t border-line pt-1.5">
                  <span className="num text-muted">{row.gross}</span>
                  <span className="num font-semibold text-fg">{row.net}</span>
                </div>
              </li>
            ))}
          </ul>

          <dl className="mt-auto grid gap-1.5 border-t border-line pt-3 text-xs sm:grid-cols-2">
            <div className="flex items-baseline justify-between gap-2 rounded-sm border border-line bg-surface px-2.5 py-2">
              <dt className="text-muted">{f.grossLabel}</dt>
              <dd className="num font-semibold text-fg">{f.grossTotal}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-2 rounded-sm border border-line bg-surface px-2.5 py-2">
              <dt className="text-muted">{f.netLabel}</dt>
              <dd className="num font-semibold text-fg">{f.netTotal}</dd>
            </div>
          </dl>
        </div>

        {/* Right: Pseudonymized AI coworker review + aggregate accounting handoff */}
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex min-w-0 flex-col rounded-md border border-dashed border-accent/60 bg-bg p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-sm font-semibold text-fg">
                <Sparkles className="size-4 shrink-0 text-accent-ink" aria-hidden="true" />
                {f.lyTitle}
              </span>
              <Chip tone="accent" wrap>
                {f.lyBadge}
              </Chip>
            </div>
            <p className="mt-3 rounded-sm border border-line bg-surface p-3 text-xs text-muted">{f.lyNote}</p>
            <div className="mt-2.5 flex items-start gap-1.5 text-xs text-muted">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-ok" aria-hidden="true" />
              <span>{f.privacyBadge}</span>
            </div>
          </div>

          <div className="flex min-w-0 flex-1 flex-col rounded-md border border-line bg-bg p-4">
            <PanelTitle title={f.handoffTitle} sub={f.handoffSub} />
            <dl className="mt-3 flex flex-col gap-2 text-xs">
              {f.handoffLines.map(([account, amount]) => (
                <div key={account} className="flex flex-wrap items-baseline justify-between gap-2 rounded-sm border border-line bg-surface px-3 py-2">
                  <dt className="num font-medium text-fg">{account}</dt>
                  <dd className="num font-semibold text-fg">{amount}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-auto flex items-start gap-1.5 pt-3 text-xs text-subtle">
              <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>{f.gateNote}</span>
            </p>
          </div>
        </div>
      </div>
    </figure>
  );
}

// Group 1: Per-person sealed PII, labor contract & probation checks, and 01/PLI + Labor Register exports.
export function RecordsAndContractsVisual({ copy }: Props) {
  const f = copy.fragments.records;
  return (
    <figure className="rounded-md border border-line bg-bg">
      <figcaption className="border-b border-line px-4 py-3">
        <PanelTitle title={f.title} sub={f.sub} />
        <span className="sr-only">{copy.fragments.sample}</span>
      </figcaption>
      <div className="px-4 py-3 text-xs">
        <span className="font-semibold text-subtle">{f.sealedTitle}</span>
        <ul className="mt-2 grid gap-2 sm:grid-cols-2">
          {f.sealedFields.map((field) => (
            <li key={field} className="flex items-center gap-2 rounded-sm border border-line bg-surface px-2.5 py-2 text-fg">
              <Lock className="size-3.5 shrink-0 text-ok" aria-hidden="true" />
              <span className="min-w-0">{field}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="border-t border-line px-4 py-3 text-xs">
        <span className="font-semibold text-subtle">{f.contractsTitle}</span>
        <ul className="mt-2 flex flex-col gap-2">
          {f.alerts.map((alert) => (
            <li key={alert.person} className="rounded-sm border border-line bg-surface p-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-fg">{alert.person}</span>
                <Chip tone={alert.tone} wrap>
                  {alert.badge}
                </Chip>
              </div>
              <p className="mt-1 text-muted">{alert.detail}</p>
            </li>
          ))}
        </ul>
      </div>
      <div className="border-t border-line px-4 py-3 text-xs">
        <span className="font-semibold text-subtle">{f.exportsTitle}</span>
        <ul className="mt-2 flex flex-wrap gap-2">
          {f.exports.map((item) => (
            <li key={item} className="inline-flex items-center gap-1.5 rounded-sm border border-line bg-surface px-2.5 py-1.5 text-fg">
              <FileSpreadsheet className="size-3.5 shrink-0 text-ok" aria-hidden="true" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </div>
    </figure>
  );
}

// Group 2: Batch timekeeping import, 40h monthly OT cap check, and annual leave accrual with 5-year seniority.
export function TimekeepingAndLeaveVisual({ copy }: Props) {
  const f = copy.fragments.timekeeping;
  return (
    <figure className="rounded-md border border-line bg-bg">
      <figcaption className="border-b border-line px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <PanelTitle title={f.title} sub={f.sub} />
          <Chip tone="ok" wrap>
            <Check className="size-3" strokeWidth={3} aria-hidden="true" />
            {f.importBadge}
          </Chip>
        </div>
        <span className="sr-only">{copy.fragments.sample}</span>
      </figcaption>
      <div className="px-4 py-3 text-xs">
        <span className="font-semibold text-subtle">{f.otTitle}</span>
        <ul className="mt-2 flex flex-col gap-2">
          {f.otRows.map((row) => (
            <li key={row.name} className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-line bg-surface p-2.5">
              <div className="min-w-0">
                <span className="block font-semibold text-fg">{row.name}</span>
                <span className="num text-muted">
                  {row.regular} · {row.ot}
                </span>
              </div>
              <Chip tone={row.tone} wrap>
                {row.tone === 'warn' ? (
                  <TriangleAlert className="size-3" aria-hidden="true" />
                ) : (
                  <Check className="size-3" strokeWidth={3} aria-hidden="true" />
                )}
                {row.status}
              </Chip>
            </li>
          ))}
        </ul>
      </div>
      <div className="border-t border-line px-4 py-3 text-xs">
        <span className="font-semibold text-subtle">{f.leaveTitle}</span>
        <p className="mt-1 font-medium text-fg">{f.leavePerson}</p>
        <dl className="mt-2 grid gap-2 sm:grid-cols-3">
          {f.leaveStats.map(([label, value]) => (
            <div key={label} className="rounded-sm border border-line bg-surface p-2.5">
              <dt className="text-muted">{label}</dt>
              <dd className="num mt-0.5 text-sm font-semibold text-fg">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </figure>
  );
}

// Group 3: Statutory math (BHXH/BHYT/BHTN, PIT, 13th-month, severance) & strict salary visibility boundary.
export function PayrollAndHandoffVisual({ copy }: Props) {
  const f = copy.fragments.payroll;
  return (
    <figure className="rounded-md border border-line bg-bg">
      <figcaption className="border-b border-line px-4 py-3">
        <PanelTitle title={f.title} sub={f.sub} />
        <span className="sr-only">{copy.fragments.sample}</span>
      </figcaption>
      <ul className="flex flex-col gap-2 px-4 py-3 text-xs">
        {f.calcItems.map((item) => (
          <li key={item.label} className="flex items-start gap-2 rounded-sm border border-line bg-surface p-2.5">
            <Check className="mt-0.5 size-3.5 shrink-0 text-ok" strokeWidth={3} aria-hidden="true" />
            <div className="min-w-0">
              <span className="block font-semibold text-fg">{item.label}</span>
              <span className="text-muted">{item.value}</span>
            </div>
          </li>
        ))}
      </ul>
      <div className="border-t border-line px-4 py-3 text-xs">
        <span className="font-semibold text-subtle">{f.splitTitle}</span>
        <div className="mt-2 grid gap-2.5 sm:grid-cols-2">
          <div className="min-w-0 rounded-sm border border-line bg-surface p-3">
            <span className="flex items-center gap-1.5 font-semibold text-fg">
              <UsersRound className="size-3.5 shrink-0 text-accent-ink" aria-hidden="true" />
              {f.ownerBoxTitle}
            </span>
            <p className="mt-1.5 text-muted">{f.ownerBoxBody}</p>
          </div>
          <div className="min-w-0 rounded-sm border border-line bg-surface-2 p-3">
            <span className="flex items-center gap-1.5 font-semibold text-fg">
              <ShieldCheck className="size-3.5 shrink-0 text-ok" aria-hidden="true" />
              {f.accountantBoxTitle}
            </span>
            <p className="mt-1.5 text-muted">{f.accountantBoxBody}</p>
          </div>
        </div>
      </div>
    </figure>
  );
}

// Group 4: Lightweight recruiting pipeline, PII-free calendar interview event, 1-click hire & PDPL erase.
export function RecruitingVisual({ copy }: Props) {
  const f = copy.fragments.recruiting;
  return (
    <figure className="rounded-md border border-line bg-bg">
      <figcaption className="border-b border-line px-4 py-3">
        <PanelTitle title={f.title} sub={f.sub} />
        <span className="sr-only">{copy.fragments.sample}</span>
      </figcaption>
      <div className="px-4 py-3 text-xs">
        <div className="flex items-center gap-2 font-semibold text-fg">
          <BriefcaseBusiness className="size-4 shrink-0 text-accent-ink" aria-hidden="true" />
          <span>{f.openingTitle}</span>
        </div>
        <dl className="mt-2.5 grid grid-cols-3 gap-2">
          {f.stages.map((item) => (
            <div key={item.stage} className="rounded-sm border border-line bg-surface p-2.5 text-center">
              <dt className="text-muted">{item.stage}</dt>
              <dd className="num mt-0.5 text-base font-semibold text-fg">{item.count}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="border-t border-line px-4 py-3 text-xs">
        <span className="font-semibold text-subtle">{f.calendarTitle}</span>
        <div className="mt-2 rounded-sm border border-line bg-surface p-2.5">
          <div className="flex items-center gap-2 font-medium text-fg">
            <Calendar className="size-3.5 shrink-0 text-ok" aria-hidden="true" />
            <span>{f.calendarEvent}</span>
          </div>
          <p className="mt-1 text-muted">{f.calendarPrivacy}</p>
        </div>
      </div>
      <div className="border-t border-line px-4 py-3 text-xs">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 rounded-sm border border-line bg-surface px-3 py-2 font-medium text-fg">
            <Check className="size-3.5 shrink-0 text-ok" strokeWidth={3} aria-hidden="true" />
            <span>{f.hireAction}</span>
          </div>
          <div className="flex items-center gap-2 rounded-sm border border-line bg-surface-2 px-3 py-2 text-muted">
            <Lock className="size-3.5 shrink-0 text-subtle" aria-hidden="true" />
            <span>{f.eraseAction}</span>
          </div>
        </div>
      </div>
    </figure>
  );
}

// Group 5: Ly's pseudonymization wall (E1, E2, C1), candidate brief, and deterministic AI-off fallback.
export function CoworkerPrivacyVisual({ copy }: Props) {
  const f = copy.fragments.coworker;
  return (
    <figure className="rounded-md border border-line bg-bg">
      <figcaption className="border-b border-line px-4 py-3">
        <PanelTitle title={f.title} sub={f.sub} />
        <span className="sr-only">{copy.fragments.sample}</span>
      </figcaption>
      <div className="flex flex-col gap-3 px-4 py-3 text-xs">
        <div>
          <span className="font-semibold text-subtle">{f.shieldTitle}</span>
          <div className="mt-2 flex flex-col gap-2">
            <div className="flex items-start gap-2 rounded-sm border border-line bg-surface p-2.5 text-fg">
              <Lock className="mt-0.5 size-3.5 shrink-0 text-ok" aria-hidden="true" />
              <span>{f.keptInServer}</span>
            </div>
            <div className="flex items-start gap-2 rounded-sm border border-line bg-surface p-2.5 text-muted">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-accent-ink" aria-hidden="true" />
              <span>{f.sentToModel}</span>
            </div>
          </div>
        </div>

        <div className="rounded-sm border border-dashed border-accent/60 bg-surface p-3">
          <span className="flex items-center gap-1.5 font-semibold text-fg">
            <Sparkles className="size-3.5 shrink-0 text-accent-ink" aria-hidden="true" />
            {f.briefTitle}
          </span>
          <p className="mt-1 text-muted">{f.briefBody}</p>
        </div>

        <div className="rounded-sm border border-line bg-surface-2 p-3">
          <span className="block font-semibold text-fg">{f.aiOffTitle}</span>
          <span className="mt-1 block text-muted">{f.aiOffBody}</span>
        </div>
      </div>
    </figure>
  );
}
