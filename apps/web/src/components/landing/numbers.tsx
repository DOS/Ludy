// SPDX-License-Identifier: AGPL-3.0-only
import type { Dictionary } from '../../content/vi';
import { GITHUB_URL } from '../../content/site';
import { STATS } from '../../content/stats';
import { Section, SectionHead } from './ui';

// Counts that are rounded down in stats.ts show a plus sign.
const ROUNDED = new Set<string>(['testCases', 'typescriptLines']);

// The numbers band (owner request, 2026-11-12): the same counts as the README, read from the module tools/readme-assets.mjs writes from the
// repository, so the site cannot claim a number the code does not hold.
export function Numbers({ dict }: { dict: Dictionary }) {
  const { numbers } = dict;
  const format = new Intl.NumberFormat(dict.lang === 'vi' ? 'vi-VN' : 'en-US');
  return (
    <Section id="so-lieu" labelledBy="numbers-title">
      <SectionHead id="numbers-title" title={numbers.title} lead={numbers.lead} />
      <dl className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-5">
        {numbers.items.map((item, i) => {
          const value = STATS[item.key as keyof typeof STATS];
          return (
            <div key={item.key} className="flex flex-col rounded-xl border border-line bg-surface p-4">
              <dd className={`num font-display text-3xl leading-none font-semibold tracking-[-0.02em] sm:text-4xl ${i % 2 === 0 ? 'text-accent-ink' : 'text-ok'}`}>
                {format.format(value)}
                {ROUNDED.has(item.key) ? '+' : ''}
              </dd>
              <dt className="mt-3 text-sm leading-snug font-medium">{item.label}</dt>
              <dd className="mt-1 text-xs text-subtle">{item.hint}</dd>
            </div>
          );
        })}
      </dl>
      <p className="mt-6 text-sm text-subtle">
        {numbers.note}{' '}
        <a href={`${GITHUB_URL}#in-numbers`} className="font-medium text-accent-ink underline-offset-4 hover:underline">
          {numbers.noteLink}
        </a>
      </p>
    </Section>
  );
}
