// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { ErrorText } from './ui.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';

// A switch the server has not finished after this long was lost (a job that died): the screen offers it again.
export const TELEGRAM_CHATS_STUCK_MS = 90_000;
// The screen asks again every two seconds while a switch is under way, for a minute at most.
const SETTLE_EVERY_MS = 2000;
const SETTLE_TIMES = 30;

type ChatState = 'off' | 'enabling' | 'on' | 'disabling';
// A Telegram Business account the bot is connected to (#3191): its name and @username, whether the connection is on, whether the bot may send, and whether
// an owner or admin allowed it (any Premium user can connect a bot that has Business Mode on); `ref` names it to the server when allowing or stopping it.
type BusinessAccount = { ref: string; name: string | null; username: string | null; enabled: boolean; canReply: boolean; approved: boolean };

// Whether a Telegram connection also answers customers' private chats (#3132): off, being turned on or off by the server, or on. The server
// sets the bot's webhook in a job, so the screen asks again until the state settles, and offers the switch again when it stood too long. A failed
// attempt shows its code in words. `active`: the connection still works; one whose token was refused can only be turned off.
export function TelegramChats({ channel, canEdit, active = true, now = Date.now() }: { channel: { id: string; chatState: ChatState; chatError: string | null; chatChangedAt?: string | null; chatBusiness?: BusinessAccount[] }; canEdit: boolean; active?: boolean; now?: number }) {
  const t = useTranslations('social');
  const switching = channel.chatState === 'enabling' || channel.chatState === 'disabling';
  const stuck = switching && channel.chatChangedAt != null && now - Date.parse(channel.chatChangedAt) > TELEGRAM_CHATS_STUCK_MS;
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
  // The job takes a few seconds: look at the channels again until it is done, a bounded number of times.
  useEffect(() => {
    if (!switching) return undefined;
    let times = 0;
    const id = setInterval(() => {
      if (++times > SETTLE_TIMES) {
        clearInterval(id);
        return;
      }
      void queryClient.invalidateQueries({ queryKey: orpc.channels.list.key() });
    }, SETTLE_EVERY_MS);
    return () => clearInterval(id);
  }, [switching, channel.chatState]);
  // Turning on is offered while off, or again when a turn on stood too long; turning off while on, or again when a switch stood too long.
  const turnOn = (channel.chatState === 'off' && active) || (channel.chatState === 'enabling' && stuck && active);
  const turnOff = channel.chatState === 'on' || (switching && stuck);
  return (
    <div className="mt-3 space-y-1" data-testid="telegram-chats">
      <p className="text-xs font-medium text-foreground">{t('telegramChatsTitle')}</p>
      <p className="text-xs text-subtle-foreground">
        {channel.chatState === 'on' ? t('telegramChatsOn') : channel.chatState === 'enabling' ? t('telegramChatsEnabling') : channel.chatState === 'disabling' ? t('telegramChatsDisabling') : t('telegramChatsOffHint')}
      </p>
      {stuck && <p className="text-xs text-warning">{t('telegramChatsStuck')}</p>}
      {channel.chatError && channel.chatState !== 'enabling' && channel.chatState !== 'disabling' && <p className="text-xs text-warning">{failure}</p>}
      {canEdit && (turnOn || turnOff) && (
        <Button variant="outline" size="sm" className="mt-1" loading={setChats.isPending} onClick={() => setChats.mutate(turnOn)}>
          {turnOn ? t('telegramChatsEnable') : t('telegramChatsDisable')}
        </Button>
      )}
      {setChats.error && <ErrorText>{errorMessage(setChats.error)}</ErrorText>}
      {channel.chatState === 'on' && <TelegramBusiness connectionId={channel.id} accounts={channel.chatBusiness ?? []} canEdit={canEdit} />}
    </div>
  );
}

// Telegram Business (#3191): an owner with Telegram Premium connects the bot to their own account in Telegram, and the bot then answers that account's
// customer chats. Nothing is turned on here but the choice of accounts: the screen says what to do in Telegram, in the order that works, lists the
// accounts Telegram told Ludy about, and an owner or admin allows the ones that are theirs. Telegram lets any Premium user connect a bot that has
// Business Mode on, so an account is not taken in until a person allows it, and stopping it ends its messages at once.
function TelegramBusiness({ connectionId, accounts, canEdit }: { connectionId: string; accounts: BusinessAccount[]; canEdit: boolean }) {
  const t = useTranslations('social');
  const allow = useMutation({
    mutationFn: (v: { ref: string; allow: boolean }) => client.channels.setTelegramBusiness({ connectionId, ref: v.ref, allow: v.allow }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: orpc.channels.list.key() });
    },
  });
  const status = (a: BusinessAccount): string =>
    !a.enabled ? t('telegramBusinessOff') : !a.approved ? t('telegramBusinessPending') : a.canReply ? t('telegramBusinessOn') : t('telegramBusinessReadOnly');
  const who = (a: BusinessAccount): string => {
    const name = a.name ?? (a.username ? '' : t('telegramBusinessUnnamed'));
    return [name, a.username ? `@${a.username}` : ''].filter((part) => part !== '').join(' ');
  };
  return (
    <div className="mt-2 space-y-1" data-testid="telegram-business">
      <p className="text-xs font-medium text-foreground">{t('telegramBusinessTitle')}</p>
      {accounts.length === 0 ? (
        <p className="text-xs text-subtle-foreground">{t('telegramBusinessHint')}</p>
      ) : (
        <>
          <ul className="space-y-1 text-xs text-subtle-foreground">
            {accounts.map((a) => (
              <li key={a.ref} data-testid="telegram-business-account" className="flex flex-wrap items-center gap-2">
                <span>
                  {who(a)}: {status(a)}
                </span>
                {canEdit && a.enabled && (
                  <Button variant="outline" size="sm" loading={allow.isPending && allow.variables?.ref === a.ref} onClick={() => allow.mutate({ ref: a.ref, allow: !a.approved })}>
                    {a.approved ? t('telegramBusinessStop') : t('telegramBusinessAllow')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {accounts.some((a) => a.enabled && !a.approved) && <p className="text-xs text-warning">{t('telegramBusinessPendingNote')}</p>}
          <p className="text-xs text-subtle-foreground">{t('telegramBusinessWindow')}</p>
        </>
      )}
      {allow.error && <ErrorText>{errorMessage(allow.error)}</ErrorText>}
    </div>
  );
}
