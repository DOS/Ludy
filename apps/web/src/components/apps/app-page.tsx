// SPDX-License-Identifier: AGPL-3.0-only
import { Check, Minus } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AppPageCopy } from '../../content/app-page';
import { SIGN_IN_URL } from '../../content/site';
import type { Dictionary } from '../../content/vi';
import { Faq } from '../landing/faq';
import { SiteFooter } from '../landing/site-footer';
import { SiteHeader } from '../landing/site-header';
import { ButtonLink, Chip, Section, SectionHead } from '../landing/ui';

// The page of one app (DESIGN.md 6.1 anatomy, per app): the promise with the product working, how it works, what it
// does today grouped by job, what is coming, what the AI assistant does here, who it is for, questions and the call to
// action. Server-rendered, no client JavaScript of its own. An app supplies its copy (AppPageCopy), its product visual
// for the hero and one visual per group of features.
export interface AppPageProps {
  dict: Dictionary;
  copy: AppPageCopy;
  // The same page in the other language, for the language switch.
  otherLangHref: string;
  hero: ReactNode;
  // One visual per group, by the group's id in the copy.
  visuals: Readonly<Record<string, ReactNode>>;
}

export function AppPage({ dict, copy, otherLangHref, hero, visuals }: AppPageProps) {
  const home = dict.lang === 'vi' ? '/' : '/en';
  const selfHost = `${home}#tu-host`;
  const { soon, assistant } = copy;
  return (
    <>
      <SiteHeader dict={dict} otherLangHref={otherLangHref} linkToHome />
      <main id="main">
        <section aria-labelledby="app-title" className="pt-10 pb-16 sm:pt-14 sm:pb-24">
          <div className="wrap">
            <nav aria-label={copy.crumbLabel} className="mx-auto max-w-[880px] text-sm text-muted">
              <ol className="flex flex-wrap justify-center gap-x-2">
                <li>
                  <a href={home} className="hover:text-fg">
                    Ludy
                  </a>
                  <span aria-hidden="true"> /</span>
                </li>
                <li aria-current="page" className="font-medium text-fg">
                  {copy.appName}
                </li>
              </ol>
            </nav>
            <div className="mx-auto mt-8 max-w-[880px] text-center">
              <h1 id="app-title" className="font-display text-[2.375rem] leading-[1.12] font-semibold tracking-[-0.025em] text-fg sm:text-5xl lg:text-[3.5rem]">
                {copy.hero.title}
              </h1>
              <p className="mx-auto mt-6 max-w-[62ch] text-base text-muted sm:text-lg">{copy.hero.lead}</p>
              <div className="mt-8 flex flex-wrap justify-center gap-3">
                <ButtonLink href={selfHost}>{copy.hero.primary}</ButtonLink>
                <ButtonLink href={SIGN_IN_URL} variant="secondary">
                  {copy.hero.secondary}
                </ButtonLink>
              </div>
              <p className="mx-auto mt-5 max-w-[60ch] text-sm text-subtle">{copy.hero.note}</p>
            </div>
            <div className="mt-12 sm:mt-14">{hero}</div>
          </div>
        </section>

        <Section id="how" labelledBy="how-title" tinted>
          <SectionHead id="how-title" title={copy.how.title} lead={copy.how.lead} />
          <ol className="grid gap-8 md:grid-cols-2 lg:grid-cols-4 lg:gap-10">
            {copy.how.steps.map((step, i) => (
              <li key={step.name} className="min-w-0 border-t border-line-strong/60 pt-4">
                <div className="flex items-center gap-3">
                  <span className="num inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent-ink" aria-hidden="true">
                    {i + 1}
                  </span>
                  <h3 className="font-display text-lg font-semibold">{step.name}</h3>
                </div>
                <p className="mt-3 text-sm text-muted">{step.body}</p>
                <div className="mt-4">
                  <Chip tone={step.tone}>{step.outcome}</Chip>
                </div>
              </li>
            ))}
          </ol>
        </Section>

        <Section id="features" labelledBy="features-title">
          <SectionHead id="features-title" title={copy.groups.title} lead={copy.groups.lead} />
          <div className="flex flex-col">
            {copy.groups.items.map((group, i) => (
              <div
                key={group.id}
                id={group.id}
                className="grid scroll-mt-24 gap-8 border-t border-line py-12 first:border-t-0 first:pt-0 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-14"
              >
                <div className={`min-w-0 ${i % 2 === 1 ? 'lg:order-2' : ''}`}>
                  <h3 className="font-display text-2xl font-semibold tracking-[-0.015em]">{group.title}</h3>
                  <p className="mt-3 max-w-[60ch] text-muted">{group.lead}</p>
                  <ul className="mt-6 flex max-w-[60ch] flex-col gap-3 text-sm text-muted">
                    {group.points.map((point) => (
                      <li key={point} className="flex gap-3">
                        <Check className="mt-0.5 size-4 shrink-0 text-ok" strokeWidth={2.5} aria-hidden="true" />
                        <span>{point}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className={`min-w-0 ${i % 2 === 1 ? 'lg:order-1' : ''}`}>{visuals[group.id]}</div>
              </div>
            ))}
          </div>
        </Section>

        {soon ? (
          <Section id="soon" labelledBy="soon-title" tinted>
            <SectionHead id="soon-title" title={soon.title} lead={soon.lead} />
            <ul className="grid gap-6 md:grid-cols-2">
              {soon.items.map((item) => (
                <li key={item.title} className="flex min-w-0 flex-col items-start gap-2 border-t border-line pt-4">
                  <Chip tone="neutral">{soon.label}</Chip>
                  <h3 className="font-display text-lg font-semibold">{item.title}</h3>
                  <p className="max-w-[56ch] text-sm text-muted">{item.body}</p>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {assistant ? (
          <Section id="vy" labelledBy="vy-title" tinted={!soon}>
            <SectionHead id="vy-title" title={assistant.title} lead={assistant.lead} />
            <div className="grid gap-8 md:grid-cols-2 md:gap-12">
              <div className="min-w-0">
                <h3 className="font-display text-lg font-semibold">{assistant.doesTitle}</h3>
                <ul className="mt-4 flex flex-col gap-3 text-sm text-muted">
                  {assistant.does.map((line) => (
                    <li key={line} className="flex gap-3">
                      <Check className="mt-0.5 size-4 shrink-0 text-ok" strokeWidth={2.5} aria-hidden="true" />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="min-w-0">
                <h3 className="font-display text-lg font-semibold">{assistant.doesNotTitle}</h3>
                <ul className="mt-4 flex flex-col gap-3 text-sm text-muted">
                  {assistant.doesNot.map((line) => (
                    <li key={line} className="flex gap-3">
                      <Minus className="mt-0.5 size-4 shrink-0 text-subtle" strokeWidth={2.5} aria-hidden="true" />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </Section>
        ) : null}

        <Section id="audience" labelledBy="audience-title">
          <SectionHead id="audience-title" title={copy.audience.title} lead={copy.audience.lead} />
          <div className="grid gap-8 md:grid-cols-3 md:gap-10">
            {copy.audience.items.map((item) => (
              <div key={item.title} className="min-w-0 border-t border-line-strong/60 pt-4">
                <h3 className="font-display text-lg font-semibold">{item.title}</h3>
                <p className="mt-2 text-sm text-muted">{item.body}</p>
              </div>
            ))}
          </div>
        </Section>

        <Faq dict={dict} faq={copy.faq} />

        <Section id="start" labelledBy="start-title">
          <div className="mx-auto max-w-[720px] text-center">
            <h2 id="start-title" className="font-display text-[1.75rem] leading-[1.15] font-semibold tracking-[-0.02em] sm:text-4xl">
              {copy.cta.title}
            </h2>
            <p className="mx-auto mt-4 max-w-[56ch] text-base text-muted sm:text-lg">{copy.cta.body}</p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <ButtonLink href={selfHost}>{copy.cta.primary}</ButtonLink>
              <ButtonLink href={SIGN_IN_URL} variant="secondary">
                {copy.cta.secondary}
              </ButtonLink>
            </div>
          </div>
        </Section>
      </main>
      <SiteFooter dict={dict} />
    </>
  );
}
