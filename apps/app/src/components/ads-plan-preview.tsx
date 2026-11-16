// SPDX-License-Identifier: AGPL-3.0-only
// The whole plan of a campaign an approver is asked to sign (docs/plan/ads-write.md section 3.2, issue #3296): the objective, the dates, the audience, where it
// shows and a preview of each ad, read from the stored plan (adsChangePlan), never from a model. Every text of the ad is a text node: React escapes it, a link is
// shown as text and never as an anchor, the characters that reorder text are made visible, and a long text is cut with a native expander (no script needed).
import { useMemo } from 'react';
import { useTranslations } from 'use-intl';
import type { AdsChange } from '@crove/kernel-contract';
import { useFormat, useLocaleSetting } from '../i18n/provider.tsx';
import { adsChangePlan, type AdsPlanView, type ClampedText } from '../lib/ads-change.ts';

// The plan of a change that carries one, worded for the reader: the amounts and the dates in their locale, a country by its name (its code when unknown).
export function useAdsPlanView(change: AdsChange | null): AdsPlanView | null {
  const root = useTranslations();
  const f = useFormat();
  const { locale } = useLocaleSetting();
  return useMemo(() => {
    if (!change) return null;
    let names: Intl.DisplayNames | null = null;
    try {
      names = new Intl.DisplayNames([locale], { type: 'region' });
    } catch {
      names = null;
    }
    return adsChangePlan(change, root, {
      money: (amount, currency) => f.money(amount, currency),
      date: (day) => f.date(day),
      country: (code) => {
        try {
          return names?.of(code) ?? code;
        } catch {
          return code;
        }
      },
    });
  }, [change, root, f, locale]);
}

// A text that may be long: the start, and the whole behind an expander when it was cut. `dir="auto"` keeps its own direction inside the card.
function Clamped({ text, label, className }: { text: ClampedText; label: string; className?: string }) {
  const t = useTranslations('ads.change.plan');
  return (
    <div className={className}>
      <p className="whitespace-pre-line break-words" dir="auto">
        {text.shown}
      </p>
      {text.full !== null && (
        <details className="mt-1">
          <summary className="cursor-pointer text-link hover:underline" aria-label={`${t('showAll')}: ${label}`}>
            {t('showAll')}
          </summary>
          <p className="mt-1 whitespace-pre-line break-words" dir="auto">
            {text.full}
          </p>
        </details>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[9rem_1fr] sm:gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </div>
  );
}

// `nested` puts the headings one level lower, for a plan shown inside a list under a heading of its own.
export function AdsPlanPreview({ plan, nested = false }: { plan: AdsPlanView; nested?: boolean }) {
  const t = useTranslations('ads.change.plan');
  const Heading = nested ? 'h4' : 'h3';
  return (
    <div className="space-y-3 text-sm" data-testid="ads-plan">
      <Heading className="text-sm font-medium text-muted-foreground">{t('title')}</Heading>
      <dl className="space-y-2">
        <Row label={t('objective')}>{plan.objective}</Row>
        <Row label={t('schedule')}>{plan.schedule}</Row>
      </dl>
      <p className="text-sm font-medium text-foreground">{t('audience')}</p>
      <dl className="space-y-2">
        <Row label={t('location')}>{plan.audience.locations}</Row>
        <Row label={t('age')}>{plan.audience.age}</Row>
        <Row label={t('gender')}>{plan.audience.gender}</Row>
        <Row label={t('interests')}>
          <span dir="auto">{plan.audience.interests}</span>
        </Row>
      </dl>
      <dl className="space-y-2">
        <Row label={t('placements')}>{plan.placements}</Row>
        <Row label={t('destination')}>
          <Clamped text={plan.destination} label={t('destination')} />
        </Row>
      </dl>
      <div className="space-y-2">
        <Heading className="text-sm font-medium text-muted-foreground">{t('adsTitle')}</Heading>
        <ol className="space-y-2">
          {plan.ads.map((ad, index) => (
            <li key={index} className="space-y-1 rounded-md border border-border p-3" data-testid="ads-plan-ad">
              <p className="text-xs font-medium text-muted-foreground">{t('ad', { number: String(index + 1) })}</p>
              <Clamped text={ad.headline} label={`${t('ad', { number: String(index + 1) })}, ${t('headline')}`} className="font-semibold text-foreground" />
              <Clamped text={ad.primaryText} label={`${t('ad', { number: String(index + 1) })}, ${t('text')}`} className="text-foreground" />
              <p className="text-xs text-muted-foreground">
                {t('button')}: {ad.button}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
