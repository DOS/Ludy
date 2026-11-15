// SPDX-License-Identifier: AGPL-3.0-only
// Approved minutes posted to a Slack or Microsoft Teams channel (Meetings B4, #3168). Two parts:
//   MinutesChannelsCard  on the Meetings tab, for an owner or admin: paste the webhook address of a Slack channel or a Teams group, with a name. The address is shown only while it is pasted and is never
//                        shown again; the list says the name, the kind and the host.
//   MeetingChatPost      on a meeting's published result, for its recorder: "Gửi vào Slack / Teams" opens the exact message (the title, the summary, the decisions and the action items, nothing else), the
//                        channels, and says everyone in the channel will read it even if they cannot open the meeting. The recorder picks a channel and presses "Gửi"; a repeat needs a tick; nothing is sent
//                        without that click. No AI part: the text is the published minutes, formatted by code.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { CHAT_LABEL_MAX, CHAT_URL_MAX, MEETING_CHAT_KINDS, chatMessageText, type ChatPosted, type ChatPreview, type MeetingChatKind } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@crove/ui/components/dialog';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { ErrorText } from './ui.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { toast } from '../lib/toast.ts';

// A preview is read fresh each time the dialog opens: the facts key must be the published result's now.
const FRESH = { staleTime: 0, gcTime: 0, refetchOnMount: 'always', refetchOnWindowFocus: false } as const;

// ---------------------------------------------------------------------------
// The org's channels (owner and admin)
// ---------------------------------------------------------------------------
export function MinutesChannelsCard() {
  const t = useTranslations('meetings.chat');
  const orgQuery = useQuery(orpc.org.get.queryOptions());
  const canEdit = orgQuery.data?.role === 'owner' || orgQuery.data?.role === 'admin';
  const list = useQuery({ ...orpc.meetings.chat.channels.queryOptions({ input: {} }), enabled: canEdit });
  const [kind, setKind] = useState<MeetingChatKind>('slack');
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.meetings.chat.key() });
  const save = useMutation({
    mutationFn: () => orpc.meetings.chat.saveChannel.call({ kind, label: label.trim(), url: url.trim() }),
    onSuccess: async () => {
      // The address leaves the form the moment it is saved.
      setUrl('');
      setLabel('');
      toast(t('saved'), 'success');
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => orpc.meetings.chat.removeChannel.call({ id }),
    onSuccess: async () => {
      toast(t('removed'), 'success');
      await refresh();
    },
  });

  if (!canEdit) return null;
  const channels = list.data?.channels ?? [];
  return (
    <Card data-testid="minutes-channels">
      <CardHeader>
        <CardTitle>{t('cardTitle')}</CardTitle>
        <CardDescription>{t('cardHint')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {list.isSuccess && channels.length === 0 && <p className="text-xs text-muted-foreground">{t('empty')}</p>}
        <ul className="space-y-2" data-testid="minutes-channel-list">
          {channels.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="outline">{t(`kind.${c.kind}`)}</Badge>
              <span>{c.label}</span>
              <span className="text-xs text-muted-foreground">{c.host}</span>
              <ConfirmDialog
                render={<Button variant="ghost" size="sm" className="ml-auto" loading={remove.isPending && remove.variables === c.id} />}
                destructive
                title={t('removeTitle')}
                description={t('removeConfirm', { label: c.label })}
                confirm={t('remove')}
                onConfirm={() => remove.mutate(c.id)}
              >
                {t('remove')}
              </ConfirmDialog>
            </li>
          ))}
        </ul>
        {remove.error && <ErrorText>{errorMessage(remove.error)}</ErrorText>}

        <form
          className="space-y-3 border-t pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="chat-kind">{t('kindLabel')}</Label>
            <NativeSelect id="chat-kind" value={kind} onChange={(e) => setKind(e.target.value as MeetingChatKind)}>
              {MEETING_CHAT_KINDS.map((k) => (
                <NativeSelectOption key={k} value={k}>
                  {t(`kind.${k}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <Label htmlFor="chat-label">{t('nameLabel')}</Label>
            <Input id="chat-label" value={label} maxLength={CHAT_LABEL_MAX} placeholder={t('namePlaceholder')} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="chat-url">{t('urlLabel')}</Label>
            <Input id="chat-url" value={url} maxLength={CHAT_URL_MAX} autoComplete="off" spellCheck={false} onChange={(e) => setUrl(e.target.value)} />
            <p className="text-xs text-muted-foreground">{kind === 'slack' ? t('urlHintSlack') : t('urlHintTeams')}</p>
            <p className="text-xs text-muted-foreground">{t('urlOnce')}</p>
          </div>
          {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
          <Button type="submit" loading={save.isPending} disabled={label.trim() === '' || url.trim() === ''}>
            {t('save')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The recorder's post
// ---------------------------------------------------------------------------
const RESULT_KEY = { sent: 'result.sent', failed: 'result.failed', ambiguous: 'result.ambiguous' } as const;

export function MeetingChatPost({ meetingId }: { meetingId: string }) {
  const t = useTranslations('meetings.chat');
  const common = useTranslations('common');
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<{ label: string; kind: MeetingChatKind; posted: ChatPosted } | null>(null);
  return (
    <div className="space-y-1" data-testid="meeting-chat">
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) setOutcome(null);
        }}
      >
        <DialogTrigger render={<Button size="sm" variant="outline" />}>{t('open')}</DialogTrigger>
        <DialogContent closeLabel={common('close')} className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription>{t('desc')}</DialogDescription>
          </DialogHeader>
          {open && (
            <ChatBody
              meetingId={meetingId}
              onDone={(label, kind, posted) => {
                setOutcome({ label, kind, posted });
                // A post that went out, or may have, closes the dialog; a refusal stays open so the recorder can read why and try again.
                if (posted.state !== 'failed') setOpen(false);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      {outcome && <PostOutcome label={outcome.label} kind={outcome.kind} posted={outcome.posted} />}
    </div>
  );
}

function PostOutcome({ label, kind, posted }: { label: string; kind: MeetingChatKind; posted: ChatPosted }) {
  const t = useTranslations('meetings.chat');
  const key = posted.state === 'sent' && kind === 'teams' ? 'result.sentTeams' : RESULT_KEY[posted.state];
  return (
    <div className="space-y-1" role="status" data-testid="chat-outcome">
      <p className={posted.state === 'sent' ? 'text-xs text-muted-foreground' : 'text-xs text-destructive'}>{t(key, { label })}</p>
      {posted.code && posted.state !== 'sent' && <p className="text-xs text-muted-foreground">{codeText(t, posted.code)}</p>}
      {posted.retryAfterSeconds !== null && <p className="text-xs text-muted-foreground">{t('result.retryAfter', { seconds: String(posted.retryAfterSeconds) })}</p>}
    </div>
  );
}

const RESULT_CODES = [
  'CHANNEL_ADDRESS_INVALID',
  'CHANNEL_ADDRESS_UNREADABLE',
  'CHANNEL_UNREACHABLE',
  'CHANNEL_GONE',
  'CHANNEL_REFUSED',
  'CHANNEL_REJECTED',
  'CHANNEL_REDIRECTED',
  'CHANNEL_RATE_LIMITED',
  'CHANNEL_TIMEOUT',
  'CHANNEL_NO_ANSWER',
  'CHANNEL_SERVER_ERROR',
] as const;
type ResultCode = (typeof RESULT_CODES)[number];
const isResultCode = (code: string): code is ResultCode => (RESULT_CODES as readonly string[]).includes(code);

// The codes the adapter and the route can answer; anything else is shown by its code alone.
function codeText(t: (key: `result.code.${ResultCode}`) => string, code: string): string {
  return isResultCode(code) ? t(`result.code.${code}`) : code;
}

function ChatBody({ meetingId, onDone }: { meetingId: string; onDone: (label: string, kind: MeetingChatKind, posted: ChatPosted) => void }) {
  const preview = useQuery({ ...orpc.meetings.chat.preview.queryOptions({ input: { meetingId } }), ...FRESH });
  if (preview.isPending) return null;
  if (preview.error) return <ErrorText>{errorMessage(preview.error)}</ErrorText>;
  return <ChatForm key={preview.data.factsKey} preview={preview.data} onDone={onDone} onReload={() => void preview.refetch()} />;
}

export function ChatForm({ preview, onDone, onReload }: { preview: ChatPreview; onDone: (label: string, kind: MeetingChatKind, posted: ChatPosted) => void; onReload?: () => void }) {
  const t = useTranslations('meetings.chat');
  const params = useParams({ strict: false }) as { slug?: string };
  const [channelId, setChannelId] = useState<string | null>(preview.channels.length === 1 ? (preview.channels[0]?.id ?? null) : null);
  const [repeat, setRepeat] = useState(false);
  const channel = preview.channels.find((c) => c.id === channelId) ?? null;
  // The link the post carries opens the meeting in this app: only people who can view the meeting get past the sign-in and the meeting's own readers rule.
  const link = params.slug ? `${window.location.origin}/o/${encodeURIComponent(params.slug)}/meetings/${preview.meetingId}` : null;
  const post = useMutation({
    mutationFn: () => {
      if (!channel) throw new Error('no channel');
      return orpc.meetings.chat.post.call({ meetingId: preview.meetingId, channelId: channel.id, factsKey: preview.factsKey, confirmRepeat: repeat });
    },
    onSuccess: (posted) => {
      if (channel) onDone(channel.label, channel.kind, posted);
    },
  });
  const needsTick = channel !== null && (channel.last === 'sent' || channel.last === 'ambiguous');
  const code = (post.error as { code?: string } | null)?.code;
  const askTick = needsTick || code === 'CHAT_ALREADY_POSTED';
  const blocked = channel === null || preview.tooLong || preview.postsLeft === 0 || channel.last === 'busy' || (askTick && !repeat);
  const result = post.data;
  return (
    <div className="space-y-4" data-testid="chat-form">
      <section className="space-y-1">
        <h3 className="text-xs font-medium text-muted-foreground">{t('messageTitle')}</h3>
        <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 font-sans text-sm" data-testid="chat-message">
          {chatMessageText(preview.message, link)}
        </pre>
        <p className="text-xs text-muted-foreground">{t('linkNote')}</p>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-medium text-muted-foreground">{t('pickChannel')}</h3>
        {preview.channels.length === 0 && <p className="text-xs text-muted-foreground">{t('noChannels')}</p>}
        <ul className="space-y-1 text-sm" data-testid="chat-channels">
          {preview.channels.map((c) => (
            <li key={c.id}>
              <label className="flex flex-wrap items-center gap-2">
                <input
                  type="radio"
                  name="chat-channel"
                  checked={channelId === c.id}
                  onChange={() => {
                    setChannelId(c.id);
                    setRepeat(false);
                    post.reset();
                  }}
                />
                <Badge variant="outline">{t(`kind.${c.kind}`)}</Badge>
                <span>{c.label}</span>
                <span className="text-xs text-muted-foreground">{c.host}</span>
                {c.last !== 'none' && <span className={c.last === 'failed' ? 'text-xs text-muted-foreground' : 'text-xs text-destructive'}>{t(`last.${c.last}`)}</span>}
              </label>
            </li>
          ))}
        </ul>
        {askTick && (
          <label className="flex items-center gap-2 text-xs" data-testid="chat-repeat">
            <Checkbox checked={repeat} onCheckedChange={(on) => setRepeat(on === true)} />
            {t('repeat')}
          </label>
        )}
      </section>

      <div className="space-y-2 border-t pt-3">
        <p className="text-xs font-medium text-destructive" data-testid="chat-warning">
          {t('warning')}
        </p>
        <p className="text-xs text-muted-foreground">{preview.postsLeft === 0 ? t('limitReached') : t('postsLeft', { count: String(preview.postsLeft) })}</p>
        {preview.tooLong && <ErrorText>{t('tooLong')}</ErrorText>}
        {post.error && <ErrorText>{errorMessage(post.error)}</ErrorText>}
        {result && result.state === 'failed' && channel && <PostOutcome label={channel.label} kind={channel.kind} posted={result} />}
        {code === 'STALE_CHAT' && onReload && (
          <Button variant="outline" size="sm" onClick={onReload} data-testid="chat-reload">
            {t('reload')}
          </Button>
        )}
        <Button loading={post.isPending} disabled={blocked} onClick={() => post.mutate()} data-testid="chat-send">
          {t('send')}
        </Button>
      </div>
    </div>
  );
}
