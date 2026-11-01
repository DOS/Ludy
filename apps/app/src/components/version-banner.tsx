// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { BUILD, VERSION_MIN_GAP_MS, VERSION_POLL_MS, fetchServerBuild, isStaleBuild } from '../lib/build-version.ts';

// "Please reload" when the API runs another build than this bundle (#2261). Only a bundle with a build id asks, so the
// kernel-served app never does; the check is one small public request every few minutes and when the tab comes back.
export function VersionBanner() {
  const t = useTranslations('common');
  const [stale, setStale] = useState(false);
  useEffect(() => {
    if (BUILD === '') return;
    let last = 0;
    const check = async () => {
      last = Date.now();
      const server = await fetchServerBuild();
      if (isStaleBuild(BUILD, server)) setStale(true);
    };
    void check();
    const timer = window.setInterval(() => void check(), VERSION_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - last >= VERSION_MIN_GAP_MS) void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  if (!stale) return null;
  return (
    <div role="status" className="flex flex-wrap items-center justify-center gap-3 bg-primary px-4 py-2 text-sm text-primary-foreground">
      <span>{t('newVersion')}</span>
      <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>
        {t('newVersionReload')}
      </Button>
    </div>
  );
}
