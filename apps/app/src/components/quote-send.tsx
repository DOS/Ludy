// SPDX-License-Identifier: AGPL-3.0-only
// Sending a quote (#2694, docs/plan/crm-quotes.md Q2): the panel that sends a saved draft by a link the person copies or by an email the system queues, the links of a
// sent quote with how often each was opened, the org's quote defaults and letterhead, and the button of the conversation panel that puts a link into the reply box. Every
// send is a person's click; nothing leaves by itself. The core works with AI off: no model is involved.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { QUOTE_BANK_NOTE_MAX, QUOTE_PHONE_MAX, QUOTE_TEXT_MAX, QUOTE_VALID_DAYS_MAX, QUOTE_VALID_DAYS_MIN, type Quote, type QuoteLinkCreated, type QuoteSummary } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { NativeSelect } from '@crove/ui/components/native-select';
import { Textarea } from '@crove/ui/components/textarea';
import { ErrorText, Field } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';

export const refreshQuoteQueries = () => {
  void queryClient.invalidateQueries({ queryKey: orpc.crm.quotes.key() });
  void queryClient.invalidateQueries({ queryKey: orpc.crm.deals.list.key() });
};

// The address a link opens at on this deployment, and the words a person sends with it in the chat.
export const quoteUrl = (link: Pick<QuoteLinkCreated, 'path'>): string => `${window.location.origin}${link.path}`;
export const quoteLabel = (q: Pick<Quote | QuoteSummary, 'number' | 'revision'>): string => (q.number ? (q.revision > 1 ? `${q.number}-R${q.revision}` : q.number) : '');

// A link just made: shown once with a copy button and the message to paste into the chat.
export function NewLink({ quote, link }: { quote: Quote; link: QuoteLinkCreated }) {
  const t = useTranslations('quotes.send');
  const f = useFormat();
  const [copied, setCopied] = useState<'link' | 'message' | null>(null);
  const url = quoteUrl(link);
  const message = t('message', { number: quoteLabel(quote), total: f.money(quote.total, 'VND'), date: f.date(quote.validUntil), url });
  const copy = async (what: 'link' | 'message') => {
    try {
      await navigator.clipboard.writeText(what === 'link' ? url : message);
      setCopied(what);
    } catch {
      setCopied(null);
    }
  };
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted p-3 text-sm" role="status" data-testid="quote-new-link">
      <p className="font-medium text-foreground">{t('linkMade')}</p>
      <p className="text-xs text-muted-foreground">{t('linkOnce')}</p>
      <Input readOnly aria-label={t('linkLabel')} value={url} onFocus={(e) => e.currentTarget.select()} />
      <Textarea readOnly rows={3} aria-label={t('messageLabel')} value={message} onFocus={(e) => e.currentTarget.select()} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={() => void copy('message')}>
          {copied === 'message' ? t('copied') : t('copyMessage')}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => void copy('link')}>
          {copied === 'link' ? t('copied') : t('copyLink')}
        </Button>
      </div>
    </div>
  );
}

// The send controls of a saved draft: by link (the person then copies it) or by email (queued with the link). Not offered while there are unsaved changes, since a
// send is of what was saved.
export function QuoteSendPanel({ quote, dirty, onSent }: { quote: Quote; dirty: boolean; onSent: (sent: { quote: Quote; link: QuoteLinkCreated | null; mailed: string | null }) => void }) {
  const t = useTranslations('quotes.send');
  const [via, setVia] = useState<'link' | 'email'>('link');
  const [to, setTo] = useState('');
  const send = useMutation({
    mutationFn: async () => {
      const sent = await client.crm.quotes.send({ quoteId: quote.id, version: quote.version, via, ...(via === 'email' && to.trim() ? { to: to.trim() } : {}) });
      // By link the person needs the link next: made in the same click, shown once.
      const link = via === 'link' ? await client.crm.quotes.createLink({ quoteId: quote.id }) : null;
      return { quote: sent.quote, link, mailed: sent.mail === 'queued' ? (to.trim() || sent.quote.buyer?.email || '') : null };
    },
    onSuccess: (done) => {
      refreshQuoteQueries();
      onSent(done);
    },
    onError: refreshQuoteQueries,
  });
  // This panel sits inside the editor's <form> and has no form of its own: a nested form's submit bubbles up and would run the editor's save with the same version as
  // the send (#2825). So the button is a plain button, and Enter in the address box sends instead of submitting the editor.
  const sendNow = () => {
    if (!dirty && !send.isPending) send.mutate();
  };
  return (
    <div role="group" className="space-y-3 rounded-md border border-border p-3" aria-label={t('title')} data-testid="quote-send">
      <h4 className="text-sm font-medium text-foreground">{t('title')}</h4>
      <p className="text-xs text-muted-foreground">{t('hint')}</p>
      <Field label={t('via')}>
        {(c) => (
          <NativeSelect {...c} className="w-full" value={via} onChange={(e) => setVia(e.target.value as 'link' | 'email')}>
            <option value="link">{t('viaLink')}</option>
            <option value="email">{t('viaEmail')}</option>
          </NativeSelect>
        )}
      </Field>
      {via === 'email' && (
        <Field label={t('to')} hint={t('toHint')}>
          {(c) => (
            <Input
              {...c}
              type="email"
              autoComplete="off"
              maxLength={254}
              value={to}
              onChange={(e) => setTo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                e.preventDefault();
                sendNow();
              }}
            />
          )}
        </Field>
      )}
      {dirty && <p className="text-xs text-muted-foreground">{t('saveFirst')}</p>}
      {send.error && <ErrorText>{errorMessage(send.error)}</ErrorText>}
      <Button type="button" size="sm" loading={send.isPending} disabled={dirty} onClick={sendNow}>
        {via === 'email' ? t('sendEmail') : t('sendLink')}
      </Button>
    </div>
  );
}

// The links of a sent quote: when each opens until, whether it was opened, and a way to revoke it or make another.
export function QuoteLinks({ quote, canEdit }: { quote: Quote; canEdit: boolean }) {
  const t = useTranslations('quotes.send');
  const f = useFormat();
  const [made, setMade] = useState<QuoteLinkCreated | null>(null);
  const create = useMutation({
    mutationFn: () => client.crm.quotes.createLink({ quoteId: quote.id }),
    onSuccess: (link) => {
      setMade(link);
      refreshQuoteQueries();
    },
  });
  const revoke = useMutation({ mutationFn: (linkId: string) => client.crm.quotes.revokeLink({ linkId }), onSuccess: refreshQuoteQueries });
  return (
    <section className="space-y-3 rounded-md border border-border p-3" aria-label={t('links')} data-testid="quote-links">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-medium text-foreground">{t('links')}</h4>
        {canEdit && quote.status === 'sent' && (
          <Button type="button" size="sm" variant="outline" loading={create.isPending} onClick={() => create.mutate()}>
            {t('newLink')}
          </Button>
        )}
      </div>
      {quote.firstViewedAt && <p className="text-xs text-muted-foreground">{t('firstViewed', { time: f.dateTime(quote.firstViewedAt) })}</p>}
      {made && <NewLink quote={quote} link={made} />}
      {quote.links.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('noLinks')}</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {quote.links.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center justify-between gap-2" data-testid="quote-link">
              <span className="text-muted-foreground">
                {l.revokedAt ? <Badge variant="outline">{t('revoked')}</Badge> : l.live ? <Badge variant="success">{t('live')}</Badge> : <Badge variant="warning">{t('expiredLink')}</Badge>}{' '}
                {t('linkMeta', { until: f.date(l.expiresAt.slice(0, 10)), views: String(l.views) })}
              </span>
              {canEdit && l.live && (
                <Button type="button" size="sm" variant="ghost" loading={revoke.isPending && revoke.variables === l.id} onClick={() => revoke.mutate(l.id)}>
                  {t('revoke')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {(create.error || revoke.error) && <ErrorText>{errorMessage(create.error ?? revoke.error)}</ErrorText>}
    </section>
  );
}

// The org's quote defaults and the letterhead the document prints: owners and admins only. An empty field prints nothing.
export function QuoteSettingsForm({ onDone }: { onDone: () => void }) {
  const setting = useQuery(orpc.crm.quotes.setting.queryOptions({ input: {} }));
  if (setting.isPending) return null;
  if (setting.error || !setting.data) return <ErrorText>{errorMessage(setting.error)}</ErrorText>;
  return <SettingsFields initial={setting.data} onDone={onDone} />;
}

function SettingsFields({ initial, onDone }: { initial: { validDays: number; defaultVat: string; defaultTerms: string | null; phone: string | null; email: string | null; bankNote: string | null }; onDone: () => void }) {
  const t = useTranslations('quotes.settings');
  const [validDays, setValidDays] = useState(String(initial.validDays));
  const [vat, setVat] = useState(initial.defaultVat);
  const [terms, setTerms] = useState(initial.defaultTerms ?? '');
  const [phone, setPhone] = useState(initial.phone ?? '');
  const [email, setEmail] = useState(initial.email ?? '');
  const [bank, setBank] = useState(initial.bankNote ?? '');
  const save = useMutation({
    mutationFn: () =>
      client.crm.quotes.setSetting({ validDays: Number(validDays), defaultVat: vat, defaultTerms: terms.trim() || null, phone: phone.trim() || null, email: email.trim() || null, bankNote: bank.trim() || null }),
    onSuccess: () => {
      refreshQuoteQueries();
      onDone();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const days = Number(validDays);
  const valid = Number.isInteger(days) && days >= QUOTE_VALID_DAYS_MIN && days <= QUOTE_VALID_DAYS_MAX;
  return (
    <form onSubmit={submit} className="grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-2" aria-label={t('title')} data-testid="quote-settings">
      <h3 className="text-base font-medium sm:col-span-2">{t('title')}</h3>
      <Field label={t('validDays')} hint={t('validDaysHint', { min: String(QUOTE_VALID_DAYS_MIN), max: String(QUOTE_VALID_DAYS_MAX) })}>
        {(c) => <Input {...c} inputMode="numeric" value={validDays} onChange={(e) => setValidDays(e.target.value)} />}
      </Field>
      <Field label={t('defaultVat')}>
        {(c) => (
          <NativeSelect {...c} className="w-full" value={vat} onChange={(e) => setVat(e.target.value)}>
            {['0%', '5%', '8%', '10%', 'KCT', 'KKKNT'].map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      <Field label={t('phone')}>{(c) => <Input {...c} type="tel" maxLength={QUOTE_PHONE_MAX} value={phone} onChange={(e) => setPhone(e.target.value)} />}</Field>
      <Field label={t('email')}>{(c) => <Input {...c} type="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
      <Field label={t('bankNote')} hint={t('bankNoteHint')} className="sm:col-span-2">
        {(c) => <Textarea {...c} rows={2} maxLength={QUOTE_BANK_NOTE_MAX} value={bank} onChange={(e) => setBank(e.target.value)} />}
      </Field>
      <Field label={t('defaultTerms')} className="sm:col-span-2">
        {(c) => <Textarea {...c} rows={3} maxLength={QUOTE_TEXT_MAX} value={terms} onChange={(e) => setTerms(e.target.value)} />}
      </Field>
      {save.error && (
        <div className="sm:col-span-2">
          <ErrorText>{errorMessage(save.error)}</ErrorText>
        </div>
      )}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" loading={save.isPending} disabled={!valid}>
          {t('save')}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t('cancel')}
        </Button>
      </div>
    </form>
  );
}

// The event the reply box listens for: the text of a quote link for the open conversation (the person reads it, edits it and presses Send; nothing is sent here).
export const REPLY_INSERT_EVENT = 'ludy:reply-insert';
export interface ReplyInsert {
  conversationId: string;
  text: string;
}

// In the conversation's contact panel: the customer's sent quotes that still open, each with a button that makes a link and puts the message into the reply box. Where the
// conversation cannot be answered from here (the platform's window is closed), the email way of the quote is the offer.
export function QuoteReplyInsert({ conversationId, partyId, canReply }: { conversationId: string; partyId: string; canReply: boolean }) {
  const t = useTranslations('quotes.send');
  const f = useFormat();
  const list = useQuery(orpc.crm.quotes.list.queryOptions({ input: { partyId, status: 'sent', limit: 5 } }));
  const insert = useMutation({
    mutationFn: async (quote: QuoteSummary) => {
      const link = await client.crm.quotes.createLink({ quoteId: quote.id });
      const text = t('message', { number: quoteLabel(quote), total: f.money(quote.total, 'VND'), date: f.date(quote.validUntil), url: quoteUrl(link) });
      window.dispatchEvent(new CustomEvent<ReplyInsert>(REPLY_INSERT_EVENT, { detail: { conversationId, text } }));
    },
    onSuccess: refreshQuoteQueries,
  });
  const open = (list.data?.items ?? []).filter((q) => !q.expired);
  if (open.length === 0) return null;
  return (
    <div className="space-y-1" data-testid="quote-reply-insert">
      <h3 className="text-sm font-semibold text-foreground">{t('replyTitle')}</h3>
      {!canReply && <p className="text-xs text-muted-foreground">{t('replyClosed')}</p>}
      <ul className="divide-y divide-border rounded-md border border-border">
        {open.map((q) => (
          <li key={q.id} className="flex items-center justify-between gap-2 px-2 py-1.5">
            <span className="min-w-0 text-xs text-muted-foreground">
              <span className="block truncate text-foreground">{quoteLabel(q)}</span>
              {f.money(q.total, 'VND')}
            </span>
            <Button type="button" size="sm" variant="outline" disabled={!canReply} loading={insert.isPending && insert.variables?.id === q.id} onClick={() => insert.mutate(q)}>
              {t('replyInsert')}
            </Button>
          </li>
        ))}
      </ul>
      {insert.error && <ErrorText>{errorMessage(insert.error)}</ErrorText>}
    </div>
  );
}
