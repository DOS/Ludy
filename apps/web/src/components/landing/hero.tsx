// SPDX-License-Identifier: AGPL-3.0-only
import type { Dictionary } from '../../content/vi';
import { GITHUB_URL } from '../../content/site';
import { OrgChart } from './org-chart';
import { ButtonLink } from './ui';

// The hero (option E, the owner's pick): the promise centered on top, and under it the org chart with AI agents at
// full width. The chart is live: each position opens what is waiting there.
export function Hero({ dict }: { dict: Dictionary }) {
  const { hero } = dict;
  return (
    <section aria-labelledby="hero-title" className="pt-6 pb-14 sm:pt-8 sm:pb-20">
      <div className="wrap">
        <div className="mx-auto max-w-[880px] text-center">
          <h1 id="hero-title" className="font-display text-[1.875rem] leading-[1.1] font-semibold tracking-[-0.025em] text-fg sm:text-[2.75rem]">
            {hero.title}
          </h1>
          <p className="mt-1.5 text-lg text-muted sm:text-xl">{hero.tagline}</p>
          <div className="mt-4 flex flex-wrap justify-center gap-3">
            <ButtonLink href="#tu-host">{hero.primary}</ButtonLink>
            <ButtonLink href={GITHUB_URL} variant="secondary">
              {hero.secondary}
            </ButtonLink>
          </div>
        </div>
        <div className="mt-6 sm:mt-7">
          <OrgChart dict={dict} />
        </div>
      </div>
    </section>
  );
}
