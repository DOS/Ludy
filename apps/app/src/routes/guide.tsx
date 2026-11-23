// SPDX-License-Identifier: AGPL-3.0-only
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Card } from '@ludy/ui/components/card';
import { StatusLink } from '../components/status-link.tsx';
import { SupportLink } from '../components/support-link.tsx';
import { PageHeader } from '../components/ui.tsx';
import { useLocaleSetting } from '../i18n/provider.tsx';
import { getConfig } from '../lib/auth.ts';
import { crmGuide } from '../lib/crm-guide.ts';
import type { GuideStep } from '../lib/guide-text.ts';
import { quickGuide } from '../lib/quick-guide.ts';
import { supportLink } from '../lib/support.ts';
import { installedModules, useModulesVersion } from '../lib/org-modules.ts';

// One card per step: its heading and its numbered lines. The headings are h2 (h3 under another h2), so the page keeps one h1.
function GuideCards({ steps, level = 2 }: { steps: readonly GuideStep[]; level?: 2 | 3 }) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <div className="grid max-w-3xl gap-4">
      {steps.map((step) => (
        <Card key={step.id} id={`guide-${step.id}`} className="block scroll-mt-20 p-5">
          <Heading className="text-base font-semibold text-foreground">{step.title}</Heading>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
            {step.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ol>
        </Card>
      ))}
    </div>
  );
}

// The one-page quick guide (issues #310, #3596): upload and approve, the VAT return, the export. Its steps are written in
// both interface languages (see quick-guide.ts); the CRM guide (#2231) follows where the crm module is on.
export function GuidePage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const t = useTranslations('guide');
  const back = useTranslations('inboxDetail');
  const { locale } = useLocaleSetting();
  const hasSupport = supportLink(getConfig().supportUrl) !== null;
  // The CRM guide only where the crm module is on.
  useModulesVersion(); // the apps of the org can change while this screen is open
  const hasCrm = installedModules().includes('crm');
  // The CRM guide is closed until asked for (#3596), so the quick guide stays one short page; a link to one of its steps opens it.
  const [crmOpen, setCrmOpen] = useState(false);
  useEffect(() => {
    if (window.location.hash.startsWith('#guide-crm')) setCrmOpen(true);
  }, []);
  const quick = quickGuide(undefined, locale);
  const crm = hasCrm ? crmGuide(undefined, locale) : [];

  return (
    <>
      <Link to="/o/$slug/inbox" params={{ slug }} className="text-sm text-muted-foreground hover:text-foreground">
        {back('back')}
      </Link>
      <div className="mt-3">
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
      </div>
      {/* Contents (#1422): on a phone the guide is several screens tall; each line jumps to its card. */}
      <nav aria-label={t('contents')} className="mb-6 max-w-3xl rounded-xl border bg-card p-4 text-sm">
        <p className="font-medium text-foreground">{t('contents')}</p>
        {/* One group per guide: both number their steps from 1. */}
        <div className="mt-2 grid gap-4 sm:grid-cols-2">
          {[
            { title: t('title'), steps: quick, onOpen: undefined },
            ...(hasCrm ? [{ title: t('crmTitle'), steps: crm, onOpen: () => setCrmOpen(true) }] : []),
          ].map((guide) => (
            <div key={guide.title}>
              <p className="text-xs text-subtle-foreground">{guide.title}</p>
              <ul className="mt-1 grid gap-1">
                {guide.steps.map((step) => (
                  <li key={step.id}>
                    <a href={`#guide-${step.id}`} onClick={guide.onOpen} className="text-link hover:underline">
                      {step.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </nav>
      <GuideCards steps={quick} />
      {hasCrm && (
        <details open={crmOpen} onToggle={(event) => setCrmOpen(event.currentTarget.open)} className="mt-8 max-w-3xl">
          {/* The heading is the summary: an h2 of the same page, and the one control that opens the guide. */}
          <summary className="cursor-pointer rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            <h2 className="inline text-lg font-semibold tracking-tight text-foreground">{t('crmTitle')}</h2>
            <span className="mt-1 block text-sm text-muted-foreground">{t('crmSubtitle')}</span>
          </summary>
          <div className="mt-4">
            <GuideCards steps={crm} level={3} />
          </div>
        </details>
      )}
      {hasSupport && (
        <p className="mt-6 text-sm text-muted-foreground">
          {t('supportHint')} <SupportLink className="text-link hover:underline" />.
        </p>
      )}
      {getConfig().statusPage && (
        <p className="mt-2 text-sm text-muted-foreground">
          {t('statusHint')} <StatusLink className="text-link hover:underline" />.
        </p>
      )}
    </>
  );
}
