// SPDX-License-Identifier: AGPL-3.0-only
import { Link } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { getConfig } from '../lib/auth.ts';

export function NotesSubnav({ slug, active }: { slug: string; active: 'notes' | 'my-work' | 'meetings' }) {
  const t = useTranslations('nav');
  const tm = useTranslations('meetings');
  const meetingsOn = getConfig().modules.includes('meetings');

  return (
    <div className="mb-6 flex border-b border-border">
      <Link
        to="/o/$slug/notes"
        params={{ slug }}
        className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
          active === 'notes'
            ? 'border-primary text-primary font-semibold'
            : 'border-transparent text-muted-foreground hover:text-foreground'
        }`}
      >
        {t('notes')}
      </Link>
      <Link
        to="/o/$slug/my-work"
        params={{ slug }}
        className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
          active === 'my-work'
            ? 'border-primary text-primary font-semibold'
            : 'border-transparent text-muted-foreground hover:text-foreground'
        }`}
      >
        {t('myWork')}
      </Link>
      {meetingsOn && (
        <Link
          to="/o/$slug/meetings"
          params={{ slug }}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            active === 'meetings'
              ? 'border-primary text-primary font-semibold'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          {tm('tab')}
        </Link>
      )}
    </div>
  );
}
