// SPDX-License-Identifier: AGPL-3.0-only
// The Inbox of the Social app (CV3, #2306, plan docs/plan/conversations.md section 11): the comments on the org's posts and the private messages of its
// channels, together, in two panes (the conversation and the contact beside it from 2xl). The comment inbox of CV1 (#2303) redirects here; a post page keeps its own "Bình luận" tab, a second view of the same
// comment conversations. How long conversations are kept is an org setting, in Settings (#3582), not here.
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { AvailabilityControl, InboxScreen } from '../components/conversation-inbox-screen.tsx';
import { PageHeader } from '../components/ui.tsx';
import type { InboxSearch } from '../lib/conversation-inbox.ts';

export function SocialInboxPage() {
  const t = useTranslations('conversations.inbox');
  const search: InboxSearch = useSearch({ strict: false });
  const navigate = useNavigate();
  return (
    // On a phone the open conversation takes the whole screen: the heading and the status line give way to it (the screen marks `data-reading`).
    <div className="max-xl:[&:has([data-reading=true])_[data-inbox-intro]]:hidden">
      <div data-inbox-intro>
        <PageHeader title={t('pageTitle')} subtitle={t('pageSubtitle')} />
        {/* The member's own status sits in a line of its own under the heading: it is theirs, not a filter of the list. */}
        <div className="-mt-3 mb-4">
          <AvailabilityControl />
        </div>
      </div>
      <InboxScreen search={search} onSearch={(next) => void navigate({ to: '.', search: next, replace: true })} />
    </div>
  );
}
