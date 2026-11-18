// SPDX-License-Identifier: AGPL-3.0-only
// One line that says whether running ads from Ludy is on, with the way to its setting (#3640, Engage audit AD-2, AD-13). The switches live in the Ads settings, not on the
// working screen, and the campaign page used to tell the owner running ads was off only after a save. Owners and admins only (the read is theirs); nothing is drawn while
// it loads or if it fails, since the setting's own screen shows the failure and the line is only a pointer.
import { Link } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { useWriteState } from './ads-write.tsx';

export function AdsRunStatus({ slug, canManage, variant = 'status' }: { slug: string; canManage: boolean; variant?: 'status' | 'campaigns' }) {
  const t = useTranslations('ads.adsSettings');
  const state = useWriteState();
  if (!canManage || !state.data) return null;
  const on = state.data.writeEnabled;
  // On the campaign page only the "off" case matters: a plan approved there cannot reach the platform until it is on.
  if (variant === 'campaigns' && on) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground" role="status" data-testid="ads-run-status">
      <Badge variant={on ? 'warning' : 'secondary'}>{on ? t('status.on') : t('status.off')}</Badge>
      {variant === 'campaigns' && <span>{t('campaignsOff')}</span>}
      <Link to="/o/$slug/ads" params={{ slug }} search={{ settings: true }} className="text-link hover:underline" data-testid="ads-run-status-link">
        {t('open')}
      </Link>
    </p>
  );
}
