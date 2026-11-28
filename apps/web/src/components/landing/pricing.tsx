// SPDX-License-Identifier: AGPL-3.0-only
import { Check } from 'lucide-react';
import type { Dictionary } from '../../content/vi';
import { DOCS_URL, SIGN_UP_URL } from '../../content/site';
import { CopyCommand } from './copy-command';
import { ButtonLink, Section, SectionHead } from './ui';

// Cloud-first Pricing (Free trial, no price listed yet) beside Self-host Free Forever (AGPL-3.0) with inline docker compose command.
export function Pricing({ dict }: { dict: Dictionary }) {
  const { pricing } = dict;
  const { cloud, selfHost } = pricing;
  return (
    <Section id="bang-gia" labelledBy="pricing-title" tinted>
      <SectionHead id="pricing-title" title={pricing.title} lead={pricing.lead} />
      <div className="grid gap-5 md:grid-cols-2">
        <div className="flex min-w-0 flex-col rounded-xl border-2 border-accent bg-surface p-6 sm:p-7">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-base font-semibold text-fg">{cloud.name}</h3>
            <span className="inline-flex items-center rounded-full bg-accent px-2.5 py-0.5 text-xs font-semibold text-accent-fg">{cloud.badge}</span>
          </div>
          <div className="mt-3 font-display text-3xl font-semibold tracking-[-0.02em] text-fg">{cloud.price}</div>
          <p className="mt-2 text-sm text-muted">{cloud.body}</p>
          <ul className="mt-5 flex flex-col gap-2.5 text-sm text-fg">
            {cloud.items.map((item) => (
              <li key={item} className="flex items-start gap-2.5">
                <Check className="mt-0.5 size-4 shrink-0 text-ok" strokeWidth={2.5} aria-hidden="true" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
          <div className="mt-8 pt-2 md:mt-auto">
            <ButtonLink href={SIGN_UP_URL} className="min-h-11 w-full sm:w-auto">
              {cloud.cta}
            </ButtonLink>
          </div>
        </div>

        <div id="tu-host" className="flex min-w-0 scroll-mt-24 flex-col rounded-xl border border-line bg-surface p-6 sm:p-7">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-base font-semibold text-fg">{selfHost.name}</h3>
            <span className="inline-flex items-center rounded-full border border-line bg-surface-2 px-2.5 py-0.5 font-mono text-xs font-medium text-fg">{selfHost.tag}</span>
          </div>
          <div className="mt-3 font-display text-3xl font-semibold tracking-[-0.02em] text-fg">{selfHost.price}</div>
          <p className="mt-2 text-sm text-muted">{selfHost.body}</p>
          <ul className="mt-5 flex flex-col gap-2.5 text-sm text-fg">
            {selfHost.items.map((item) => (
              <li key={item} className="flex items-start gap-2.5">
                <Check className="mt-0.5 size-4 shrink-0 text-ok" strokeWidth={2.5} aria-hidden="true" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
          <div className="mt-5">
            <CopyCommand command={selfHost.command} copy={selfHost.copy} copied={selfHost.copied} copyFail={selfHost.copyFail} />
            <p className="mt-2 text-xs text-muted">{selfHost.openHint}</p>
          </div>
          <div className="mt-6 pt-2 md:mt-auto">
            <ButtonLink href={DOCS_URL} variant="secondary" className="min-h-11 w-full sm:w-auto">
              {selfHost.cta}
            </ButtonLink>
          </div>
        </div>
      </div>
    </Section>
  );
}
