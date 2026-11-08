// SPDX-License-Identifier: AGPL-3.0-only
// The Inbox of the Social app (CV3, #2306, plan docs/plan/conversations.md section 11): the comments on the org's posts and the private messages of its
// channels, together, in three panes. The comment inbox of CV1 (#2303) redirects here; a post page keeps its own "Bình luận" tab, a second view of the same
// comment conversations. Retention is set here by owners and admins, as it was on the comment inbox.
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { ConversationRetentionSetting } from '../components/conversation-inbox.tsx';
import { InboxScreen } from '../components/conversation-inbox-screen.tsx';
import { PageHeader } from '../components/ui.tsx';
import type { InboxSearch } from '../lib/conversation-inbox.ts';

export function SocialInboxPage() {
  const t = useTranslations('conversations.inbox');
  const search: InboxSearch = useSearch({ strict: false });
  const navigate = useNavigate();
  return (
    <div className="space-y-4">
      <PageHeader title={t('pageTitle')} subtitle={t('pageSubtitle')} />
      <ConversationRetentionSetting />
      <InboxScreen search={search} onSearch={(next) => void navigate({ to: '.', search: next, replace: true })} />
    </div>
  );
}
