// SPDX-License-Identifier: AGPL-3.0-only
// The way back from a task made in the Inbox ("Create task", CV3, #3295) to its thread (#3421, plan docs/plan/conversations.md section 4). The link carries only the
// thread's id: no title, name or text. A member who may not read the thread, and a thread that was erased, land on the Inbox's own "not found" answer, so the task
// never confirms that the thread exists. Without the Social module (Engage) there is no Inbox to open and the link is not shown.
import { Link } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { installedModules } from '../lib/org-modules.ts';

export const conversationInboxInstalled = (): boolean => installedModules().includes('social');

export function TaskConversationLink({ conversationId, slug }: { conversationId: string; slug: string }) {
  const t = useTranslations('tasks');
  if (!conversationInboxInstalled()) return null;
  return (
    <p className="text-sm" data-testid="task-conversation-link">
      <Link to="/o/$slug/social/inbox" params={{ slug }} search={{ c: conversationId }} className="text-link underline">
        {t('openConversation')}
      </Link>
    </p>
  );
}
