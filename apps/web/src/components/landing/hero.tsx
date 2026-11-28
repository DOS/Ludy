// SPDX-License-Identifier: AGPL-3.0-only
import { ArrowDown, ArrowRight, Check } from 'lucide-react';
import type { Dictionary } from '../../content/vi';
import { SIGN_UP_URL } from '../../content/site';
import { AppShell } from './app-shell';
import { ButtonLink } from './ui';

// Hero: SaaS promise centered above the interactive product workspace (AppShell),
// with Cloud free trial as the primary action and self-hosting linked calmly inline.
export function Hero({ dict }: { dict: Dictionary }) {
  const { hero } = dict;
  return (
    <section aria-labelledby="hero-title" className="pt-8 pb-16 sm:pt-12 sm:pb-20">
      <div className="wrap">
        <div className="mx-auto max-w-[820px] text-center">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs font-medium text-muted">
            <span className="size-1.5 rounded-full bg-ok" aria-hidden="true" />
            <span>{hero.eyebrow}</span>
          </div>
          <h1 id="hero-title" className="font-display text-[2rem] leading-[1.12] font-semibold tracking-[-0.025em] text-fg sm:text-[3rem]">
            {hero.title}
          </h1>
          <p className="mt-2 font-display text-lg font-medium text-accent-ink sm:text-2xl">{hero.tagline}</p>
          <p className="mx-auto mt-4 max-w-[58ch] text-base text-muted sm:text-lg">{hero.lead}</p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <ButtonLink href={SIGN_UP_URL} className="min-h-11 px-5">
              <span>{hero.primary}</span>
              <ArrowRight className="size-4" aria-hidden="true" />
            </ButtonLink>
            <ButtonLink href="#san-pham" variant="secondary" className="min-h-11 px-5">
              <span>{hero.secondary}</span>
              <ArrowDown className="size-4" aria-hidden="true" />
            </ButtonLink>
          </div>
          <ul className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-muted sm:text-sm">
            {hero.proofItems.map((item) => (
              <li key={item} className="inline-flex items-center gap-1.5">
                <Check className="size-3.5 shrink-0 text-ok" strokeWidth={2.5} aria-hidden="true" />
                <span>{item}</span>
              </li>
            ))}
            <li>
              <a href="#tu-host" className="font-medium text-accent-ink underline-offset-4 hover:underline">
                {hero.selfHostLink}
              </a>
            </li>
          </ul>
        </div>
        <AppShell dict={dict} />
      </div>
    </section>
  );
}
