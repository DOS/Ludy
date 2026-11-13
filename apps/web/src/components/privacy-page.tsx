// SPDX-License-Identifier: AGPL-3.0-only
import { en } from '../content/en';
import type { PrivacyBlock, PrivacyCopy } from '../content/privacy';
import { privacyEn } from '../content/privacy-en';
import { privacyVi } from '../content/privacy-vi';
import { PRIVACY_CONTACT_EMAIL } from '../content/site';
import { vi } from '../content/vi';
import { SiteFooter } from './landing/site-footer';
import { SiteHeader } from './landing/site-header';

// The privacy policy in either language (/privacy, served from /en/privacy for an English visitor): plain text in
// sections, with a contents list, the version and the review notice at the top. Server-rendered, no client JavaScript.
// A table is drawn as one card per row (each cell labelled by its column), so a phone never scrolls sideways.
function Block({ block }: { block: PrivacyBlock }) {
  if (block.kind === 'p') return <p className="mt-4 max-w-[70ch] text-base text-muted">{block.text}</p>;
  if (block.kind === 'list') {
    return (
      <ul className="mt-4 max-w-[70ch] list-disc space-y-2 pl-5 text-base text-muted marker:text-subtle">
        {block.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    );
  }
  return (
    <figure className="mt-4 max-w-[70ch]">
      <figcaption className="text-sm font-semibold text-fg">{block.caption}</figcaption>
      <ul className="mt-2 divide-y divide-line rounded-md border border-line">
        {block.rows.map((row) => (
          <li key={row[0]} className="grid gap-3 p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)]">
            {row.map((cell, i) => (
              <div key={block.head[i]} className="min-w-0 text-sm">
                <div className="text-xs font-medium text-subtle">{block.head[i]}</div>
                <div className={i === 0 ? 'mt-0.5 font-medium text-fg' : 'mt-0.5 text-muted'}>{cell}</div>
              </div>
            ))}
          </li>
        ))}
      </ul>
    </figure>
  );
}

export function PrivacyPage({ lang, contactEmail = PRIVACY_CONTACT_EMAIL }: { lang: 'vi' | 'en'; contactEmail?: string | null }) {
  const dict = lang === 'vi' ? vi : en;
  const copy: PrivacyCopy = lang === 'vi' ? privacyVi : privacyEn;
  return (
    <>
      <SiteHeader dict={dict} linkToHome />
      <main id="main">
        <article aria-labelledby="privacy-title" className="pt-10 pb-16 sm:pt-14 sm:pb-24">
          <div className="wrap">
            <nav aria-label={copy.crumbLabel} className="text-sm text-muted">
              <ol className="flex flex-wrap gap-x-2">
                <li>
                  <a href="/" className="hover:text-fg">
                    Ludy
                  </a>
                  <span aria-hidden="true"> /</span>
                </li>
                <li aria-current="page" className="font-medium text-fg">
                  {copy.title}
                </li>
              </ol>
            </nav>
            <h1 id="privacy-title" className="mt-8 font-display text-[2.375rem] leading-[1.12] font-semibold tracking-[-0.025em] text-fg sm:text-5xl">
              {copy.title}
            </h1>
            <p className="mt-6 max-w-[70ch] text-base text-muted sm:text-lg">{copy.lead}</p>
            <p className="mt-6 max-w-[70ch] rounded-md border border-line bg-surface-2/40 px-4 py-3 text-sm text-muted">
              <span className="font-medium text-fg">{copy.versionLine}</span> {copy.reviewNotice}
            </p>
            <nav aria-labelledby="privacy-contents" className="mt-10 max-w-[70ch]">
              <h2 id="privacy-contents" className="text-sm font-semibold text-fg">
                {copy.contentsTitle}
              </h2>
              <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-muted">
                {copy.sections.map((section) => (
                  <li key={section.id}>
                    <a href={`#${section.id}`} className="hover:text-fg hover:underline">
                      {section.title}
                    </a>
                  </li>
                ))}
              </ol>
            </nav>
            {copy.sections.map((section) => (
              <section key={section.id} id={section.id} aria-labelledby={`${section.id}-title`} className="mt-14 scroll-mt-24">
                <h2 id={`${section.id}-title`} className="font-display text-[1.75rem] leading-[1.15] font-semibold tracking-[-0.02em] text-fg">
                  {section.title}
                </h2>
                {section.blocks.map((block, i) => (
                  <Block key={i} block={block} />
                ))}
                {section.id === 'rights' && contactEmail !== null ? (
                  <p className="mt-4 max-w-[70ch] text-base text-muted">
                    {copy.contact.emailLead} <a href={`mailto:${contactEmail}`} className="font-medium text-fg underline">{contactEmail}</a>.
                  </p>
                ) : null}
              </section>
            ))}
          </div>
        </article>
      </main>
      <SiteFooter dict={dict} />
    </>
  );
}
