// SPDX-License-Identifier: AGPL-3.0-only
import { ArrowRight, ChevronDown } from 'lucide-react';
import type { Dictionary } from '../../content/vi';
import { SIGN_UP_URL } from '../../content/site';
import { ButtonLink, Section } from './ui';

// Native details/summary: keyboard accessible without JavaScript. App pages use tinted FAQ; home page passes showClosingCta and tinted={false}.
export function Faq({
  dict,
  faq = dict.faq,
  showClosingCta = false,
  tinted = true,
}: {
  dict: Dictionary;
  faq?: { title: string; items: ReadonlyArray<{ q: string; a: string }> };
  showClosingCta?: boolean;
  tinted?: boolean;
}) {
  return (
    <Section id="hoi-dap" labelledBy="faq-title" tinted={tinted}>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-16">
        <h2 id="faq-title" className="font-display text-[1.75rem] leading-[1.15] font-semibold tracking-[-0.02em] sm:text-4xl">
          {faq.title}
        </h2>
        <div className="divide-y divide-line border-y border-line">
          {faq.items.map((item) => (
            <details key={item.q} className="group">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 font-medium [&::-webkit-details-marker]:hidden">
                {item.q}
                <ChevronDown className="size-4 shrink-0 text-subtle transition-transform group-open:rotate-180" aria-hidden="true" />
              </summary>
              <p className="max-w-[68ch] pb-4 text-sm text-muted">{item.a}</p>
            </details>
          ))}
        </div>
      </div>
      {showClosingCta ? (
        <div className="mt-14 flex flex-col items-start justify-between gap-6 rounded-xl border border-line bg-surface p-6 sm:flex-row sm:items-center sm:p-8">
          <div className="max-w-[56ch]">
            <h3 className="font-display text-xl font-semibold text-fg sm:text-2xl">{dict.faq.closingCta.title}</h3>
            <p className="mt-1.5 text-sm text-muted sm:text-base">{dict.faq.closingCta.body}</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <ButtonLink href={SIGN_UP_URL} className="min-h-11 px-5">
              <span>{dict.faq.closingCta.primary}</span>
              <ArrowRight className="size-4" aria-hidden="true" />
            </ButtonLink>
            <ButtonLink href="#tu-host" variant="secondary" className="min-h-11 px-5">
              {dict.faq.closingCta.secondary}
            </ButtonLink>
          </div>
        </div>
      ) : null}
    </Section>
  );
}
