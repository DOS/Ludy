// SPDX-License-Identifier: AGPL-3.0-only
import { ArrowRight, BriefcaseBusiness, Calculator, Check, FilePenLine, Lock, Megaphone, Pin, ShieldCheck, Sparkles, UsersRound, type LucideIcon } from 'lucide-react';
import type { Dictionary } from '../../content/vi';
import { appPagePath, type AppPageKey } from '../../content/site';
import { Chip, Section, SectionHead, toneOf } from './ui';

const ICONS: Record<string, LucideIcon> = {
  teamwork: UsersRound,
  finance: Calculator,
  engage: Megaphone,
  hr: BriefcaseBusiness,
  sign: FilePenLine,
  ai: Sparkles,
};

const BENTO_ORDER = ['finance', 'teamwork', 'engage', 'sign', 'hr', 'ai'] as const;
type AppKey = (typeof BENTO_ORDER)[number];

const BENTO_SPANS: Record<AppKey, string> = {
  finance: 'md:col-span-12 lg:col-span-7',
  teamwork: 'md:col-span-6 lg:col-span-5',
  engage: 'md:col-span-6 lg:col-span-5',
  sign: 'md:col-span-12 lg:col-span-7',
  hr: 'md:col-span-6 lg:col-span-6',
  ai: 'md:col-span-6 lg:col-span-6',
};

function PreviewFinance({ p }: { p: Dictionary['appCards']['previews']['finance'] }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-bg p-3 text-xs">
      <div className="flex items-center justify-between gap-2 text-[11px] font-medium text-muted">
        <span>{p.header}</span>
        <Chip tone="accent">{p.badge}</Chip>
      </div>
      <ul className="flex flex-col gap-1.5">
        {p.rows.map((row) => (
          <li key={row.doc} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-surface px-2.5 py-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[11px] font-medium text-muted">{row.doc}</span>
                <span className="truncate font-medium text-fg">{row.party}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted">
                <span className="font-mono">{row.account}</span>
                <span className="num font-medium text-fg">{row.amount}</span>
              </div>
            </div>
            <Chip tone={toneOf(row.tone)}>{row.status}</Chip>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between gap-2 pt-0.5 text-[11px] text-muted">
        <span>{p.footerNote}</span>
        <span className="inline-flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 font-medium text-accent-fg">
          <Check className="size-3" strokeWidth={2.5} aria-hidden="true" />
          {p.approveLabel}
        </span>
      </div>
    </div>
  );
}

function PreviewTeamwork({ p }: { p: Dictionary['appCards']['previews']['teamwork'] }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-bg p-3 text-xs">
      <div className="text-[11px] font-medium text-muted">{p.header}</div>
      <div className="flex items-start gap-2 rounded-md border border-line bg-surface px-2.5 py-2">
        <Pin className="mt-0.5 size-3.5 shrink-0 text-accent-ink" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-fg">{p.noteTitle}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Chip tone="accent">{p.noteTag}</Chip>
          </div>
        </div>
      </div>
      <div className="flex items-start gap-2 rounded-md border border-line bg-surface px-2.5 py-2">
        <span className="mt-0.5 inline-flex size-3.5 shrink-0 rounded-[3px] border border-line-strong bg-surface-2" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-fg">{p.taskTitle}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted">
            <span className="num">{p.taskDue}</span>
            <span>{p.stepDone}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function PreviewEngage({ p }: { p: Dictionary['appCards']['previews']['engage'] }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-bg p-3 text-xs">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="font-medium text-muted">{p.channel}</span>
        <Chip tone="ok">{p.stage}</Chip>
      </div>
      <div className="rounded-md border border-line bg-surface px-2.5 py-2">
        <div className="font-medium text-fg">{p.customerName}</div>
        <div className="mt-0.5 text-muted">{p.message}</div>
      </div>
      <div className="rounded-md border border-dashed border-accent/60 bg-surface px-2.5 py-2">
        <div className="font-medium text-accent-ink">{p.draftLabel}</div>
        <div className="mt-0.5 text-fg">{p.draftReply}</div>
      </div>
    </div>
  );
}

function PreviewSign({ p }: { p: Dictionary['appCards']['previews']['sign'] }) {
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-line bg-bg p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-fg">{p.header}</span>
        <span className="rounded-sm border border-line bg-surface px-2 py-0.5 font-mono text-[11px] font-medium text-muted">{p.packetTag}</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {p.signers.map((signer) => (
          <div key={signer.role} className="flex items-center justify-between gap-2 rounded-md border border-line bg-surface px-2.5 py-2">
            <span className="truncate font-medium text-fg">{signer.role}</span>
            <Chip tone={toneOf(signer.tone)}>{signer.state}</Chip>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-surface px-2.5 py-2">
        <span className="flex items-center gap-1.5 text-muted">
          <ShieldCheck className="size-3.5 shrink-0 text-ok" aria-hidden="true" />
          <span>{p.depositLabel}</span>
        </span>
        <Chip tone="ok">{p.depositValue}</Chip>
      </div>
    </div>
  );
}

function PreviewHr({ p }: { p: Dictionary['appCards']['previews']['hr'] }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-bg p-3 text-xs">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="font-medium text-muted">{p.header}</span>
        <span className="font-mono text-muted">{p.period}</span>
      </div>
      <ul className="grid gap-1.5 sm:grid-cols-2">
        {p.items.map((item) => (
          <li key={item.label} className="flex items-center justify-between gap-2 rounded-md border border-line bg-surface px-2.5 py-2">
            <span className="truncate text-muted">{item.label}</span>
            <Chip tone={toneOf(item.tone)}>{item.value}</Chip>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PreviewAi({ p }: { p: Dictionary['appCards']['previews']['ai'] }) {
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-line bg-bg p-3 text-xs">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="font-medium text-muted">{p.header}</span>
        <Chip tone="ok">{p.killSwitchState}</Chip>
      </div>
      <div className="rounded-md border border-line bg-surface px-2.5 py-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-muted">{p.spentLabel}</span>
          <span className="num font-medium text-fg">{p.spentValue}</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
          <div className="h-full rounded-full bg-accent" style={{ width: `${p.pct}%` }} />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <Lock className="size-3.5 shrink-0 text-fg" aria-hidden="true" />
          <span>{p.killSwitchLabel}</span>
        </span>
        <span className="font-mono font-medium text-fg">R1</span>
      </div>
    </div>
  );
}

function renderPreview(key: AppKey, previews: Dictionary['appCards']['previews']) {
  switch (key) {
    case 'finance':
      return <PreviewFinance p={previews.finance} />;
    case 'teamwork':
      return <PreviewTeamwork p={previews.teamwork} />;
    case 'engage':
      return <PreviewEngage p={previews.engage} />;
    case 'sign':
      return <PreviewSign p={previews.sign} />;
    case 'hr':
      return <PreviewHr p={previews.hr} />;
    case 'ai':
      return <PreviewAi p={previews.ai} />;
  }
}

// Asymmetric 12-column pure-RSC Bento Grid covering all 6 apps with static mini UI previews.
export function AppCards({ dict }: { dict: Dictionary }) {
  const { appCards } = dict;
  const byKey = Object.fromEntries(appCards.items.map((item) => [item.key, item])) as Record<AppKey, (typeof appCards.items)[number]>;

  return (
    <Section id="san-pham" labelledBy="apps-title" tinted>
      <SectionHead id="apps-title" title={appCards.title} lead={appCards.lead} />
      <ul className="grid grid-cols-1 gap-5 md:grid-cols-12">
        {BENTO_ORDER.map((key) => {
          const item = byKey[key];
          const Icon = ICONS[item.key] ?? Sparkles;
          return (
            <li key={item.key} className={`flex min-w-0 flex-col rounded-xl border border-line bg-surface p-5 sm:p-6 ${BENTO_SPANS[key]}`}>
              <h3 className="flex items-center gap-2.5 font-display text-lg leading-snug font-semibold">
                <Icon className="size-5 shrink-0 text-accent-ink" aria-hidden="true" />
                <span>{item.name}</span>
              </h3>
              <p className="mt-2 text-sm text-muted">{item.body}</p>
              <div className="mt-4 mb-5">{renderPreview(key, appCards.previews)}</div>
              <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
                {item.agent ? (
                  <span className="text-xs text-muted">
                    {appCards.agentLabel}: <span className="font-medium text-fg">{item.agent}</span>
                  </span>
                ) : (
                  <span className="text-xs text-muted">{appCards.aiControlLabel}</span>
                )}
                {item.page ? (
                  <a href={appPagePath(item.page as AppPageKey)} className="inline-flex items-center gap-1 text-sm font-medium text-accent-ink underline-offset-4 hover:underline">
                    {appCards.more}
                    <ArrowRight className="size-4" aria-hidden="true" />
                  </a>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
