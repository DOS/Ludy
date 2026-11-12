// SPDX-License-Identifier: AGPL-3.0-only
// The follow-up email after a meeting (L3, #2590): the recorder of a meeting with a shared summary clicks "Soạn thư cảm ơn", reads the draft (the shared summary, the decisions
// and the action items, in the meeting's language), edits the words around them and the recipients, and sends it. Nothing is sent without that click. The words are fixed
// unless the recorder asks their Vy for the lead-in and the closing, which is metered, may be refused, and is tainted until they tick "Tôi đã đọc"; with AI off the fixed words
// stand. An address that is neither a reader of the meeting nor a contact linked to it is flagged and sent only when ticked. The dialog is the meetings module's own; it hands off
// to Email compose once that screen exists (docs/plan/email.md E4 and E7).
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { FOLLOWUP_CLOSING_MAX, FOLLOWUP_GREETING_MAX, FOLLOWUP_HINT_MAX, FOLLOWUP_LEAD_MAX, FOLLOWUP_RECIPIENTS_MAX, FOLLOWUP_SUBJECT_MAX, followupAddress, type FollowupDraft, type FollowupWording } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@crove/ui/components/dialog';
import { Input } from '@crove/ui/components/input';
import { Textarea } from '@crove/ui/components/textarea';
import { ErrorText } from './ui.tsx';
import { errorMessage, orpc } from '../lib/api.ts';

const WORDING = { used: 'wording.used', off: 'wording.off', busy: 'wording.busy', budget: 'wording.budget', failed: 'wording.failed' } as const;

// A draft is read fresh each time the dialog opens: the facts key must be the published result's now.
const FRESH = { staleTime: 0, gcTime: 0, refetchOnMount: 'always', refetchOnWindowFocus: false } as const;

function Label({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
      {children}
    </label>
  );
}

export function FollowupForm({ draft, onSent }: { draft: FollowupDraft; onSent: (queued: number) => void }) {
  const t = useTranslations('meetings.followup');
  const [subject, setSubject] = useState(draft.words.subject);
  const [greeting, setGreeting] = useState(draft.words.greeting);
  const [lead, setLead] = useState(draft.words.lead);
  const [closing, setClosing] = useState(draft.words.closing);
  const [fromVy, setFromVy] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [hint, setHint] = useState('');
  const [before, setBefore] = useState<{ lead: string; closing: string } | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(draft.recipients.filter((r) => !r.alreadySent).map((r) => r.email)));
  const [extra, setExtra] = useState<string[]>([]);
  const [extraText, setExtraText] = useState('');
  const [extraError, setExtraError] = useState(false);
  const [confirmed, setConfirmed] = useState<Set<string>>(() => new Set());
  const [confirmRepeat, setConfirmRepeat] = useState(false);
  // One key per version of the form: a double click or a retry of the same send is the same request, and any edit is a new one.
  const key = useRef<string>(crypto.randomUUID());
  const touch = () => {
    key.current = crypto.randomUUID();
  };

  const wording = useMutation({
    mutationFn: () => orpc.meetings.followup.wording.call({ meetingId: draft.meetingId, ...(hint.trim() ? { hint: hint.trim() } : {}) }),
    onSuccess: (answer: FollowupWording) => {
      if (!answer.words) return;
      setBefore({ lead, closing });
      setLead(answer.words.lead);
      setClosing(answer.words.closing);
      // Vy's words are the model's until the recorder says they read them.
      setFromVy(true);
      setReviewed(false);
      touch();
    },
  });
  const send = useMutation({
    mutationFn: () =>
      orpc.meetings.followup.send.call({
        meetingId: draft.meetingId,
        factsKey: draft.factsKey,
        subject,
        greeting,
        lead,
        closing,
        recipients: [...chosen],
        confirmedOutsiders: extra.filter((a) => confirmed.has(a)),
        confirmRepeat,
        fromVy,
        reviewed,
        idempotencyKey: key.current,
      }),
    onSuccess: (sent) => onSent(sent.queued),
  });

  const suggested = new Set(draft.recipients.map((r) => r.email));
  const addExtra = () => {
    const address = followupAddress(extraText);
    if (address === null) {
      setExtraError(true);
      return;
    }
    setExtraError(false);
    setExtraText('');
    touch();
    if (suggested.has(address)) setChosen((c) => new Set(c).add(address));
    else if (!extra.includes(address)) {
      setExtra((e) => [...e, address]);
      setChosen((c) => new Set(c).add(address));
    }
  };
  const toggle = (address: string, on: boolean) => {
    touch();
    setChosen((c) => {
      const next = new Set(c);
      if (on) next.add(address);
      else next.delete(address);
      return next;
    });
  };
  const tick = (address: string, on: boolean) => {
    touch();
    setConfirmed((c) => {
      const next = new Set(c);
      if (on) next.add(address);
      else next.delete(address);
      return next;
    });
  };

  const picked = [...chosen];
  const outsiders = picked.filter((a) => !suggested.has(a));
  const repeats = draft.recipients.filter((r) => r.alreadySent && chosen.has(r.email));
  const blocked =
    picked.length === 0 ||
    picked.length > FOLLOWUP_RECIPIENTS_MAX ||
    draft.sendsLeft === 0 ||
    (fromVy && !reviewed) ||
    outsiders.some((a) => !confirmed.has(a)) ||
    (repeats.length > 0 && !confirmRepeat) ||
    subject.trim() === '' ||
    lead.trim() === '' ||
    closing.trim() === '' ||
    greeting.trim() === '';

  return (
    <div className="space-y-4" data-testid="followup-form">
      <p className="text-xs text-muted-foreground">{t('note')}</p>

      <section className="space-y-2">
        <h3 className="text-xs font-medium text-muted-foreground">{t('wordsTitle')}</h3>
        <div className="space-y-1">
          <Label htmlFor="followup-subject">{t('subject')}</Label>
          <Input id="followup-subject" value={subject} maxLength={FOLLOWUP_SUBJECT_MAX} onChange={(e) => { setSubject(e.target.value); touch(); }} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="followup-greeting">{t('greeting')}</Label>
          <Input id="followup-greeting" value={greeting} maxLength={FOLLOWUP_GREETING_MAX} onChange={(e) => { setGreeting(e.target.value); touch(); }} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="followup-lead">{t('lead')}</Label>
          <Textarea id="followup-lead" value={lead} rows={3} maxLength={FOLLOWUP_LEAD_MAX} onChange={(e) => { setLead(e.target.value); touch(); }} />
        </div>
        <div className="space-y-1">
          <h4 className="text-xs font-medium text-muted-foreground">{t('factsTitle')}</h4>
          <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm" data-testid="followup-facts">
            {draft.facts.summary && <p className="whitespace-pre-wrap">{draft.facts.summary}</p>}
            {draft.facts.decisions.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground">{t('decisions')}</p>
                <ul className="list-disc space-y-1 pl-5">
                  {draft.facts.decisions.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              </div>
            )}
            {draft.facts.items.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground">{t('items')}</p>
                <ul className="list-disc space-y-1 pl-5">
                  {draft.facts.items.map((item, i) => (
                    <li key={i}>
                      {item.title}
                      {item.who ? `, ${t('owner')}: ${item.who}` : ''}
                      {item.when ? `, ${t('due')}: ${item.when}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{t('factsNote')}</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="followup-closing">{t('closing')}</Label>
          <Textarea id="followup-closing" value={closing} rows={2} maxLength={FOLLOWUP_CLOSING_MAX} onChange={(e) => { setClosing(e.target.value); touch(); }} />
        </div>
      </section>

      <section className="space-y-2" data-testid="followup-vy">
        <div className="flex flex-wrap items-center gap-2">
          <Input aria-label={t('hint')} className="min-w-48 flex-1" value={hint} maxLength={FOLLOWUP_HINT_MAX} placeholder={t('hintExample')} disabled={send.isPending || wording.isPending} onChange={(e) => { setHint(e.target.value); wording.reset(); }} />
          <Button variant="outline" size="sm" loading={wording.isPending} disabled={send.isPending} onClick={() => wording.mutate()} data-testid="followup-wording">
            {t('wordingButton')}
          </Button>
        </div>
        {wording.data && (
          <p className="text-xs text-subtle-foreground" role="status" data-testid="followup-wording-state">
            {t(WORDING[wording.data.ai])}
          </p>
        )}
        {wording.error && <ErrorText>{errorMessage(wording.error)}</ErrorText>}
        {before && wording.data?.words && (
          <Button variant="ghost" size="sm" onClick={() => { setLead(before.lead); setClosing(before.closing); setBefore(null); setFromVy(false); setReviewed(false); touch(); wording.reset(); }}>
            {t('wordingUndo')}
          </Button>
        )}
        {fromVy && (
          <label className="flex items-center gap-2 text-sm" data-testid="followup-review">
            <Checkbox checked={reviewed} onCheckedChange={(on) => { setReviewed(on === true); touch(); }} />
            <Badge variant="outline">{t('fromVy')}</Badge>
            {t('reviewed')}
          </label>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-medium text-muted-foreground">{t('recipientsTitle')}</h3>
        {draft.recipients.length === 0 && extra.length === 0 && <p className="text-xs text-muted-foreground">{t('noRecipients')}</p>}
        <ul className="space-y-1 text-sm" data-testid="followup-recipients">
          {draft.recipients.map((r) => (
            <li key={r.email}>
              <label className="flex items-center gap-2">
                <Checkbox checked={chosen.has(r.email)} onCheckedChange={(on) => toggle(r.email, on === true)} />
                <span>{r.name}</span>
                <span className="text-xs text-muted-foreground">{r.email}</span>
                {r.alreadySent && <Badge variant="outline">{t('alreadySent')}</Badge>}
              </label>
            </li>
          ))}
          {extra.map((address) => (
            <li key={address} className="space-y-1" data-testid="followup-outsider">
              <label className="flex items-center gap-2">
                <Checkbox checked={chosen.has(address)} onCheckedChange={(on) => toggle(address, on === true)} />
                <span className="text-xs">{address}</span>
                <Badge variant="outline">{t('outsider')}</Badge>
              </label>
              {chosen.has(address) && (
                <label className="flex items-center gap-2 pl-6 text-xs">
                  <Checkbox checked={confirmed.has(address)} onCheckedChange={(on) => tick(address, on === true)} />
                  {t('confirmOutsider')}
                </label>
              )}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-2">
          <Input aria-label={t('addAddress')} className="min-w-48 flex-1" type="email" value={extraText} placeholder={t('addAddress')} maxLength={254} onChange={(e) => { setExtraText(e.target.value); setExtraError(false); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addExtra(); } }} />
          <Button variant="outline" size="sm" onClick={addExtra} disabled={extraText.trim() === ''}>
            {t('add')}
          </Button>
        </div>
        {extraError && <ErrorText>{t('addressInvalid')}</ErrorText>}
        {repeats.length > 0 && (
          <label className="flex items-center gap-2 text-xs" data-testid="followup-repeat">
            <Checkbox checked={confirmRepeat} onCheckedChange={(on) => { setConfirmRepeat(on === true); touch(); }} />
            {t('confirmRepeat', { count: String(repeats.length) })}
          </label>
        )}
      </section>

      <div className="space-y-2 border-t pt-3">
        <p className="text-xs text-muted-foreground">{draft.sendsLeft === 0 ? t('limitReached') : t('sendsLeft', { count: String(draft.sendsLeft) })}</p>
        {send.error && <ErrorText>{errorMessage(send.error)}</ErrorText>}
        <Button loading={send.isPending} disabled={blocked || wording.isPending} onClick={() => send.mutate()} data-testid="followup-send">
          {t('send', { count: String(picked.length) })}
        </Button>
      </div>
    </div>
  );
}

export function MeetingFollowup({ meetingId }: { meetingId: string }) {
  const t = useTranslations('meetings.followup');
  const common = useTranslations('common');
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  return (
    <div className="space-y-1" data-testid="meeting-followup">
      <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) setDone(null); }}>
        <DialogTrigger render={<Button size="sm" variant="outline" />}>{t('open')}</DialogTrigger>
        <DialogContent closeLabel={common('close')} className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription>{t('desc')}</DialogDescription>
          </DialogHeader>
          {open && <FollowupBody meetingId={meetingId} onSent={(queued) => { setDone(queued); setOpen(false); }} />}
        </DialogContent>
      </Dialog>
      {done !== null && (
        <p className="text-xs text-muted-foreground" role="status" data-testid="followup-done">
          {t('queued', { count: String(done) })}
        </p>
      )}
    </div>
  );
}

function FollowupBody({ meetingId, onSent }: { meetingId: string; onSent: (queued: number) => void }) {
  const draft = useQuery({ ...orpc.meetings.followup.draft.queryOptions({ input: { meetingId } }), ...FRESH });
  if (draft.isPending) return null;
  if (draft.error) return <ErrorText>{errorMessage(draft.error)}</ErrorText>;
  return <FollowupForm draft={draft.data} onSent={onSent} />;
}
