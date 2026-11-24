// SPDX-License-Identifier: AGPL-3.0-only
// Product visuals for the Ludy eSign page (/esign), rendered in pure HTML with the home page's sample company
// (Gạo Sạch Mekong) and semantic design tokens. Panel titles stay plain elements so the document heading outline stays
// strictly section titles and feature groups.
import {
  ArrowRight,
  Bell,
  Check,
  FileCheck2,
  FileDiff,
  FilePenLine,
  FileText,
  KeyRound,
  Lock,
  Mail,
  PenLine,
  Search,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Stamp,
  Webhook,
} from 'lucide-react';
import type { EsignCopy } from '../../content/esign-vi';
import type { Dictionary } from '../../content/vi';
import { Chip } from '../landing/ui';

type Props = { dict: Dictionary; copy: EsignCopy };

function PanelTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <span className="min-w-0 text-sm font-semibold text-fg">{title}</span>
      {sub ? <span className="min-w-0 text-xs text-subtle">{sub}</span> : null}
    </div>
  );
}

function FauxButton({ children, primary = false }: { children: string; primary?: boolean }) {
  return (
    <span
      className={`inline-flex h-8 items-center justify-center rounded-md border px-2.5 text-xs font-medium ${
        primary ? 'border-line-strong/70 bg-surface-2 text-fg' : 'border-line bg-surface text-muted'
      }`}
      aria-hidden="true"
    >
      {children}
    </span>
  );
}

// Hero: sequential envelope with Signer/CC roles, red stamp + initials, dashed AI proposal, SME playbook check and human Send gate.
export function EsignHero({ dict, copy }: Props) {
  const f = copy.fragments.hero;
  return (
    <figure aria-label={f.label} className="rounded-lg border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-4 text-xs text-subtle">
        <span>{dict.shell.org}</span>
        <Chip tone="neutral">{copy.fragments.sample}</Chip>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_minmax(0,0.95fr)]">
        {/* Left: Envelope summary & signers */}
        <div className="flex min-w-0 flex-col rounded-md border border-line bg-bg p-4">
          <span className="text-sm font-semibold text-fg">{f.docTitle}</span>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Chip tone="accent" wrap>
              {f.sourceChip}
            </Chip>
            <Chip tone="neutral">{f.routingChip}</Chip>
            <Chip tone="ok">
              <Check className="size-3" strokeWidth={3} aria-hidden="true" />
              {f.inspectBadge}
            </Chip>
          </div>
          <div className="mt-4 border-t border-line pt-3">
            <span className="text-xs font-semibold text-subtle">{f.signersTitle}</span>
            <ul className="mt-2 flex flex-col gap-2.5 text-xs">
              {f.signers.map((signer) => (
                <li key={`${signer.order}-${signer.name}`} className="rounded-sm border border-line bg-surface p-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-fg">
                      <span className="num text-subtle">{signer.order}</span> {signer.name}
                    </span>
                    <Chip tone={signer.tone}>{signer.state}</Chip>
                  </div>
                  <span className="mt-1 block text-muted">{signer.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Center: Contract page preview with placed field/stamp and dashed AI proposal */}
        <div className="flex min-w-0 flex-col rounded-md border border-line bg-bg p-4">
          <PanelTitle title={f.pageLabel} sub={f.docTitle} />
          <div className="mt-3 flex flex-1 flex-col justify-between gap-4 rounded-sm border border-line bg-surface p-3.5 text-xs">
            <div className="space-y-1.5 text-muted">
              <p className="font-medium text-fg">{f.partyA}</p>
              <p className="font-medium text-fg">{f.partyB}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-1.5 rounded-sm border border-line-strong/70 bg-bg p-2.5">
                <span className="flex items-center gap-1.5 font-medium text-fg">
                  <PenLine className="size-3.5 shrink-0 text-ok" aria-hidden="true" />
                  {f.placedField}
                </span>
                <span className="h-5 rounded-sm border border-line bg-surface" aria-hidden="true" />
              </div>
              <div className="flex min-w-0 flex-col gap-2 rounded-sm border border-dashed border-accent/60 bg-accent-soft/50 p-2.5">
                <div className="flex flex-wrap items-center justify-between gap-1">
                  <span className="font-medium text-accent-ink">{f.proposalField}</span>
                  <Chip tone="accent" wrap>
                    <Sparkles className="size-3" aria-hidden="true" />
                    {f.proposalBadge}
                  </Chip>
                </div>
                <div className="flex flex-wrap gap-1.5" aria-hidden="true">
                  <span className="inline-flex h-6 items-center rounded-sm bg-accent px-2 text-[11px] font-medium text-accent-fg">
                    {f.applyBtn}
                  </span>
                  <span className="inline-flex h-6 items-center rounded-sm border border-line bg-surface px-2 text-[11px] text-muted">
                    {f.dismissBtn}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right: Playbook & clause check + human Send gate */}
        <div className="flex min-w-0 flex-col rounded-md border border-dashed border-accent/60 bg-bg p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-semibold text-fg">{f.vyTitle}</span>
            <Chip tone="ok" wrap>
              <ShieldCheck className="size-3" aria-hidden="true" />
              {f.vyRisk}
            </Chip>
          </div>
          <p className="mt-3 rounded-sm border border-line bg-surface p-3 text-xs text-muted">{f.vyClause}</p>
          <div className="mt-auto pt-4">
            <span
              className="flex h-9 items-center justify-center rounded-md border border-line-strong/70 bg-surface-2 text-sm font-medium text-fg"
              aria-hidden="true"
            >
              {f.sendBtn}
            </span>
            <p className="mt-2 flex items-center gap-1.5 text-xs text-subtle">
              <Lock className="size-3.5 shrink-0" aria-hidden="true" />
              {f.sendNote}
            </p>
          </div>
        </div>
      </div>
    </figure>
  );
}

// Group 1: Starter A4 drafter, reusable template tags, 9 field types + 1-click initials, and revision diff.
export function IntakeAndTemplatesVisual({ copy }: Props) {
  const f = copy.fragments.templatesAndDrafting;
  return (
    <figure className="rounded-md border border-line bg-bg">
      <figcaption className="border-b border-line px-4 py-3">
        <PanelTitle title={f.title} sub={f.sub} />
        <span className="sr-only">{copy.fragments.sample}</span>
      </figcaption>
      <div className="px-4 py-3 text-xs">
        <span className="font-semibold text-subtle">{f.starterTitle}</span>
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {f.starterKinds.map((kind) => (
            <li key={kind} className="inline-flex items-center gap-1 rounded-sm border border-line bg-surface px-2.5 py-1 text-fg">
              <FileText className="size-3 shrink-0 text-subtle" aria-hidden="true" />
              <span>{kind}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="border-t border-line px-4 py-3 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-semibold text-subtle">{f.tagsTitle}</span>
          <Chip tone="accent" wrap>
            {f.initialAllBadge}
          </Chip>
        </div>
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {f.tagsDetected.map((tag) => (
            <li key={tag} className="rounded-sm border border-line bg-surface px-2 py-1 font-mono text-[11px] text-fg">
              {tag}
            </li>
          ))}
        </ul>
      </div>
      <div className="border-t border-line px-4 py-3 text-xs">
        <span className="font-semibold text-subtle">{f.paletteTitle}</span>
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {f.fieldTypes.map((type) => (
            <li key={type} className="inline-flex items-center gap-1 rounded-sm border border-line bg-surface px-2 py-1 text-fg">
              <FilePenLine className="size-3 shrink-0 text-subtle" aria-hidden="true" />
              <span>{type}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="border-t border-line px-4 py-3 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 font-semibold text-fg">
            <FileDiff className="size-3.5 shrink-0 text-subtle" aria-hidden="true" />
            {f.diffTitle}
          </span>
          <Chip tone="warn" wrap>
            {f.diffBadge}
          </Chip>
        </div>
        <p className="mt-1.5 text-muted">{f.diffNote}</p>
      </div>
    </figure>
  );
}

// Group 2: Connected suite handoffs from Engage, Meeting minutes, Projects -> Finance invoice, and HR (Decree 337/2025).
export function HandoffsVisual({ copy }: Props) {
  const f = copy.fragments.handoffs;
  return (
    <figure className="rounded-md border border-line bg-bg">
      <figcaption className="border-b border-line px-4 py-3">
        <PanelTitle title={f.title} sub={f.sub} />
        <span className="sr-only">{copy.fragments.sample}</span>
      </figcaption>
      <ul className="flex flex-col gap-2.5 p-4 text-xs">
        {f.cards.map((card) => (
          <li key={card.from} className="rounded-sm border border-line bg-surface p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold text-fg">{card.from}</span>
              <Chip tone={card.tone} wrap>
                {card.badge}
              </Chip>
            </div>
            <div className="mt-1.5 flex items-start gap-1.5 text-muted">
              <ArrowRight className="mt-0.5 size-3.5 shrink-0 text-subtle" aria-hidden="true" />
              <span className="min-w-0">{card.to}</span>
            </div>
          </li>
        ))}
      </ul>
    </figure>
  );
}

// Group 3: Mobile-first signing ceremony across Zalo fragment, direct links, public hub, stamps, attachments and delegation.
export function CeremonyVisual({ copy }: Props) {
  const f = copy.fragments.ceremony;
  return (
    <figure className="rounded-md border border-line bg-bg">
      <figcaption className="border-b border-line px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-sm font-semibold text-fg">
            <Smartphone className="size-4 shrink-0 text-subtle" aria-hidden="true" />
            {f.title}
          </span>
          <Chip tone="ok" wrap>
            <Mail className="size-3" aria-hidden="true" />
            {f.otpBadge}
          </Chip>
        </div>
        <span className="mt-1 block break-all font-mono text-[11px] text-subtle">{f.urlNote}</span>
        <span className="sr-only">{copy.fragments.sample}</span>
      </figcaption>
      <div className="flex flex-col gap-3 px-4 py-3 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="min-w-0 text-sm font-medium text-fg">{f.docTitle}</span>
          <Chip tone="accent" wrap>
            {f.remainingBadge}
          </Chip>
        </div>
        <div>
          <Chip tone="neutral" wrap>
            {f.sharedSummaryBadge}
          </Chip>
        </div>
        <div className="rounded-sm border border-line bg-surface p-3">
          <div className="flex flex-wrap gap-3 border-b border-line pb-2" aria-hidden="true">
            {f.tabs.map((tab, i) => (
              <span
                key={tab}
                className={i === f.activeTab ? 'border-b-2 border-accent pb-1 font-semibold text-fg' : 'pb-1 text-subtle'}
              >
                {tab}
              </span>
            ))}
          </div>
          <div className="mt-3 rounded-sm border border-line bg-bg px-3 py-3 text-center font-display text-base font-semibold italic text-fg">
            {f.typedName}
          </div>
          <div className="mt-2.5 flex items-center gap-1.5 rounded-sm border border-line bg-bg px-2.5 py-1.5 text-muted">
            <Stamp className="size-3.5 shrink-0 text-subtle" aria-hidden="true" />
            <span className="min-w-0">{f.attachmentChip}</span>
          </div>
        </div>
        <div className="flex items-start gap-2 text-muted">
          <span className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-ok bg-ok text-bg" aria-hidden="true">
            <Check className="size-3" strokeWidth={3} />
          </span>
          <span>{f.consent}</span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <span className="min-w-0 flex-1 text-[11px] text-subtle">{f.delegateNote}</span>
          <div className="flex flex-wrap gap-2">
            <FauxButton>{f.declineBtn}</FauxButton>
            <FauxButton primary>{f.submitBtn}</FauxButton>
          </div>
        </div>
      </div>
    </figure>
  );
}

// Group 4: SHA-256 sealing, hash-chained ledger, sender-side KYC check, CA boundary, and offline Web Crypto verify.
export function SealingAndVerifyVisual({ copy }: Props) {
  const f = copy.fragments.sealing;
  return (
    <figure className="rounded-md border border-line bg-bg">
      <figcaption className="border-b border-line px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-semibold text-fg">{f.title}</span>
          <Chip tone="ok" wrap>
            <ShieldCheck className="size-3" aria-hidden="true" />
            {f.chainBadge}
          </Chip>
        </div>
        <span className="sr-only">{copy.fragments.sample}</span>
      </figcaption>
      <dl className="grid gap-2.5 px-4 py-3 text-xs sm:grid-cols-2">
        <div className="min-w-0 rounded-sm border border-line bg-surface p-2.5 sm:col-span-2">
          <dt className="text-subtle">{f.certCodeLabel}</dt>
          <dd className="num mt-0.5 font-mono text-sm font-semibold text-fg">{f.certCode}</dd>
        </div>
        <div className="min-w-0 rounded-sm border border-line bg-surface p-2.5">
          <dt className="text-subtle">{f.sourceLabel}</dt>
          <dd className="mt-0.5 break-all font-mono text-muted">{f.sourceHash}</dd>
        </div>
        <div className="min-w-0 rounded-sm border border-line bg-surface p-2.5">
          <dt className="text-subtle">{f.sealedLabel}</dt>
          <dd className="mt-0.5 break-all font-mono text-fg">{f.sealedHash}</dd>
        </div>
      </dl>
      <div className="border-t border-line px-4 py-3 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-semibold text-fg">{f.kycTitle}</span>
          <Chip tone="ok" wrap>
            <Check className="size-3" strokeWidth={3} aria-hidden="true" />
            {f.kycStatus}
          </Chip>
        </div>
        <p className="mt-1 text-muted">{f.kycNote}</p>
      </div>
      <div className="border-t border-line px-4 py-3 text-xs">
        <div className="flex items-center gap-2 font-semibold text-fg">
          <FileCheck2 className="size-4 shrink-0 text-ok" aria-hidden="true" />
          <span>{f.verifyTitle}</span>
        </div>
        <p className="mt-1 text-muted">{f.verifyNote}</p>
        <div className="mt-2.5 flex flex-wrap gap-2">
          <Chip tone="ok" wrap>
            <Check className="size-3" strokeWidth={3} aria-hidden="true" />
            {f.verifyResult}
          </Chip>
          <Chip tone="neutral" wrap>
            {f.caBadge}
          </Chip>
        </div>
      </div>
    </figure>
  );
}

// Group 5: SME playbook checklist with copyable redline, renewal & Today alerts, and scoped Contract Vault Q&A.
export function ObligationsAndPlaybookVisual({ copy }: Props) {
  const f = copy.fragments.obligationsAndPlaybook;
  return (
    <figure className="rounded-md border border-line bg-bg">
      <figcaption className="border-b border-line px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-semibold text-fg">{f.title}</span>
          <Chip tone="ok" wrap>
            {f.playbookVerdict}
          </Chip>
        </div>
        <span className="sr-only">{copy.fragments.sample}</span>
      </figcaption>
      <div className="flex flex-col gap-3 px-4 py-3 text-xs">
        <div className="rounded-sm border border-line bg-surface p-3">
          <span className="font-semibold text-subtle">{f.playbookTitle}</span>
          <p className="mt-1 font-medium text-fg">{f.playbookRule}</p>
          <div className="mt-2 rounded-sm border border-dashed border-accent/60 bg-bg p-2.5">
            <span className="block text-[11px] font-medium text-accent-ink">{f.redlineLabel}</span>
            <p className="mt-0.5 text-muted">{f.redlineText}</p>
          </div>
        </div>
        <div className="rounded-sm border border-line bg-surface p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 font-semibold text-fg">
              <Bell className="size-3.5 shrink-0 text-warn" aria-hidden="true" />
              {f.renewalTitle}
            </span>
            <Chip tone="warn" wrap>
              {f.renewalBadge}
            </Chip>
          </div>
          <p className="num mt-1.5 text-muted">{f.renewalMeta}</p>
        </div>
        <div className="rounded-sm border border-dashed border-accent/60 bg-surface p-3">
          <span className="flex items-center gap-1.5 font-semibold text-fg">
            <Search className="size-3.5 shrink-0 text-accent-ink" aria-hidden="true" />
            {f.vaultTitle}
          </span>
          <p className="mt-1.5 font-medium text-fg">{f.vaultQuery}</p>
          <p className="mt-1 text-muted">{f.vaultAnswer}</p>
        </div>
        <div className="rounded-sm border border-line bg-surface-2 px-3 py-2 text-muted">{f.aiOffNote}</div>
      </div>
    </figure>
  );
}

// Group 6: Signed HMAC webhooks, 4 read-only MCP tools, and scoped /api/v1/sign/* external REST API.
export function IntegrationsVisual({ copy }: Props) {
  const f = copy.fragments.integrations;
  return (
    <figure className="rounded-md border border-line bg-bg">
      <figcaption className="border-b border-line px-4 py-3">
        <PanelTitle title={f.title} sub={f.sub} />
        <span className="sr-only">{copy.fragments.sample}</span>
      </figcaption>
      <div className="flex flex-col gap-3 px-4 py-3 text-xs">
        <div className="rounded-sm border border-line bg-surface p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 font-semibold text-fg">
              <Webhook className="size-3.5 shrink-0 text-ok" aria-hidden="true" />
              {f.webhookTitle}
            </span>
            <Chip tone="ok" wrap>
              {f.webhookPayload}
            </Chip>
          </div>
          <p className="mt-1.5 break-all font-mono text-[11px] text-muted">{f.webhookMeta}</p>
        </div>
        <div className="rounded-sm border border-line bg-surface p-3">
          <span className="font-semibold text-subtle">{f.mcpTitle}</span>
          <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {f.mcpTools.map((tool) => (
              <li key={tool} className="break-all rounded-sm border border-line bg-bg px-2.5 py-1.5 font-mono text-[11px] text-fg">
                {tool}
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-sm border border-line bg-surface p-3">
          <span className="flex items-center gap-1.5 font-semibold text-fg">
            <KeyRound className="size-3.5 shrink-0 text-accent-ink" aria-hidden="true" />
            {f.apiTitle}
          </span>
          <ul className="mt-2 flex flex-col gap-1.5">
            {f.apiScopes.map((scope) => (
              <li key={scope} className="rounded-sm border border-line bg-bg px-2.5 py-1.5 font-mono text-[11px] text-muted">
                {scope}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </figure>
  );
}
