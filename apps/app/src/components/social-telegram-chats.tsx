// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { ErrorText } from './ui.tsx';
import { client, errorMessage, queryClient } from '../lib/api.ts';

// Whether a Telegram connection also answers customers' private chats (#3132): off, being turned on or off by the server, or on. The server
// sets the bot's webhook in a job, so the screen asks again until the state settles. A failed attempt shows its code in words.
export function TelegramChats({ channel, canEdit }: { channel: { id: string; chatState: 'off' | 'enabling' | 'on' | 'disabling'; chatError: string | null }; canEdit: boolean }) {
  const t = useTranslations('social');
  const switching = channel.chatState === 'enabling' || channel.chatState === 'disabling';
  // What the last failed attempt says in words; a code the screen has no words for is shown as it is.
  const failure =
    channel.chatError === 'BOT_IN_USE'
      ? t('telegramChatsBotInUse')
      : channel.chatError === 'WEBHOOK_NEEDS_HTTPS'
        ? t('telegramChatsNeedsHttps')
        : channel.chatError === 'TELEGRAM_TOKEN_REFUSED'
          ? t('telegramChatsTokenRefused')
          : channel.chatError === 'TELEGRAM_WEBHOOK_REFUSED'
            ? t('telegramChatsAddressRefused')
            : channel.chatError === 'CHANNEL_NOT_CONFIGURED'
              ? t('telegramChatsNoWorker')
              : channel.chatError === 'NO_HOOK_KEY'
                ? t('telegramChatsNoKey')
                : t('telegramChatsFailedOther', { code: channel.chatError ?? '' });
  const setChats = useMutation({
    mutationFn: (on: boolean) => client.channels.setTelegramChats({ connectionId: channel.id, on }),
    onSuccess: () => {
      void queryClient.invalidateQueries();
    },
  });
  // The job takes a few seconds: look again until it is done.
  useQuery({
    queryKey: ['telegram-chats-settle', channel.id, channel.chatState],
    queryFn: async () => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await queryClient.invalidateQueries();
      return null;
    },
    enabled: switching,
    retry: false,
  });
  return (
    <div className="mt-3 space-y-1" data-testid="telegram-chats">
      <p className="text-xs font-medium text-foreground">{t('telegramChatsTitle')}</p>
      <p className="text-xs text-subtle-foreground">
        {channel.chatState === 'on' ? t('telegramChatsOn') : channel.chatState === 'enabling' ? t('telegramChatsEnabling') : channel.chatState === 'disabling' ? t('telegramChatsDisabling') : t('telegramChatsOffHint')}
      </p>
      {channel.chatState === 'off' && channel.chatError && <p className="text-xs text-warning">{failure}</p>}
      {canEdit && !switching && (
        <Button variant="outline" size="sm" className="mt-1" loading={setChats.isPending} onClick={() => setChats.mutate(channel.chatState !== 'on')}>
          {channel.chatState === 'on' ? t('telegramChatsDisable') : t('telegramChatsEnable')}
        </Button>
      )}
      {setChats.error && <ErrorText>{errorMessage(setChats.error)}</ErrorText>}
    </div>
  );
}
