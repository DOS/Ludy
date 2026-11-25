// SPDX-License-Identifier: AGPL-3.0-only
// The Inbox of the Social app (CV3, #2306, plan docs/plan/conversations.md section 11): the comments on the org's posts and the private messages of its
// channels, together, in two panes (the conversation and the contact beside it from 2xl). The comment inbox of CV1 (#2303) redirects here; a post page keeps its own "Bình luận" tab, a second view of the same
// comment conversations. How long conversations are kept is an org setting, in Settings (#3582); saved replies and auto-draft live in the Inbox settings drawer (#3673).
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useRef, type RefObject } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@ludy/ui/components/button';
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@ludy/ui/components/sheet';
import { AutoDraftControl, SavedRepliesPanel, useAutoDraftState, useSavedRepliesState } from '../components/conversation-drafts.tsx';
import { useMe } from '../components/conversation-inbox.tsx';
import { AvailabilityControl, InboxScreen } from '../components/conversation-inbox-screen.tsx';
import { PageHeader } from '../components/ui.tsx';
import { getConfig } from '../lib/auth.ts';
import { parseConversationInboxSearch, type InboxSearch } from '../lib/conversation-inbox.ts';
import { withSearch } from '../lib/search.ts';

export function SocialInboxPage() {
  const t = useTranslations('conversations.inbox');
  const { slug } = useParams({ strict: false }) as { slug: string };
  const search: InboxSearch = useSearch({ strict: false });
  const navigate = useNavigate();
  const { canWrite, isAdmin } = useMe();
  const aiOn = getConfig().aiEnabled === true;
  const settingsOpen = search.settings === true;
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const setSettingsOpen = (open: boolean) => {
    void navigate({
      to: '/o/$slug/social/inbox',
      params: { slug },
      search: (prev) => withSearch(parseConversationInboxSearch(prev), { settings: open ? true : undefined }),
      replace: true,
    });
  };
  return (
    // On a phone the open conversation takes the whole screen: the heading and the status line give way to it (the screen marks `data-reading`).
    <div className="max-xl:[&:has([data-reading=true])_[data-inbox-intro]]:hidden">
      <div data-inbox-intro>
        <PageHeader
          title={t('pageTitle')}
          subtitle={t('pageSubtitle')}
          actions={
            <Button
              ref={settingsTriggerRef}
              type="button"
              variant="outline"
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen(true)}
              className="max-md:min-h-11 pointer-coarse:min-h-11"
              data-testid="inbox-settings-trigger"
            >
              {t('settingsTrigger')}
            </Button>
          }
        />
        {/* The member's own status sits in a line of its own under the heading: it is theirs, not a filter of the list. */}
        <div className="-mt-3 mb-4">
          <AvailabilityControl paused={settingsOpen} />
        </div>
      </div>
      <InboxScreen
        search={search}
        covered={settingsOpen}
        onSearch={(next) => void navigate({ to: '/o/$slug/social/inbox', params: { slug }, search: next, replace: true })}
      />
      <InboxSettingsDrawer
        key={slug}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        canWrite={canWrite}
        isAdmin={isAdmin}
        aiOn={aiOn}
        triggerRef={settingsTriggerRef}
      />
    </div>
  );
}

// Holds form draft and toggle mutation state per org in a sibling shell (not SocialInboxPage) so typing does not re-render InboxScreen, errors/in-flight saves survive closing, and offline users are never trapped in the drawer.
function InboxSettingsDrawer({
  open,
  onOpenChange,
  canWrite,
  isAdmin,
  aiOn,
  triggerRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canWrite: boolean;
  isAdmin: boolean;
  aiOn: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const t = useTranslations('conversations.inbox');
  const savedReplies = useSavedRepliesState();
  const autoDraft = useAutoDraftState();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        closeLabel={t('settingsDrawer.close')}
        data-testid="inbox-settings-sheet"
        className="sm:max-w-lg"
        finalFocus={() => {
          const trigger = triggerRef.current;
          if (trigger && trigger.getClientRects().length > 0) return trigger;
          return document.getElementById('main-content') ?? true;
        }}
      >
        <SheetHeader>
          <SheetTitle>{t('settingsDrawer.title')}</SheetTitle>
          <SheetDescription>{t(aiOn ? 'settingsDrawer.description' : 'settingsDrawer.descriptionNoAi')}</SheetDescription>
        </SheetHeader>
        <SheetBody className="space-y-6">
          {open && (
            <>
              <SavedRepliesPanel canWrite={canWrite} state={savedReplies} />
              {aiOn && (
                <div className="border-t border-border pt-4 empty:hidden">
                  <AutoDraftControl isAdmin={isAdmin} set={autoDraft} />
                </div>
              )}
            </>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
