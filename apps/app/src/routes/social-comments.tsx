// SPDX-License-Identifier: AGPL-3.0-only
// The comment inbox of Social (#2303, plan docs/plan/conversations.md section 11): the comments on the org's own posts across
// its channels, New, Pending and Resolved, answered here. A private message is not here: it is Service's.
import { useTranslations } from 'use-intl';
import { ConversationInbox, ConversationRetentionSetting } from '../components/conversation-inbox.tsx';
import { PageHeader } from '../components/ui.tsx';

export function SocialCommentsPage() {
  const t = useTranslations('conversations');
  return (
    <div className="space-y-4">
      <PageHeader title={t('pageTitle')} subtitle={t('pageSubtitle')} />
      <ConversationRetentionSetting />
      <ConversationInbox kind="comment_thread" />
    </div>
  );
}
