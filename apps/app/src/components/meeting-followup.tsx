// SPDX-License-Identifier: AGPL-3.0-only
// The follow-up email after a meeting (L3, #2590; personal note & unpublished draft #4292): the recorder of a meeting with a shared summary (or, for the recorder alone, a
// reviewed/manual unpublished draft) clicks "Soạn thư cảm ơn", picks either the structured minutes layout or a personal note prose style (optionally drafted by their own
// member-scoped Vy under meetings.followup_note), edits the text and the recipients, and sends it. Nothing is sent without that click.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import {
  FOLLOWUP_CLOSING_MAX,
  FOLLOWUP_GREETING_MAX,
  FOLLOWUP_HINT_MAX,
  FOLLOWUP_LEAD_MAX,
  FOLLOWUP_NOTE_MAX,
  FOLLOWUP_RECIPIENTS_MAX,
  FOLLOWUP_SUBJECT_MAX,
  followupAddress,
  type FollowupDraft,
  type FollowupNoteAnswer,
  type FollowupNoteStatus,
  type FollowupStage,
  type FollowupStyle,
  type FollowupWording,
} from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Checkbox } from '@ludy/ui/components/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@ludy/ui/components/dialog';
import { Input } from '@ludy/ui/components/input';
import { Textarea } from '@ludy/ui/components/textarea';
import { ErrorText } from './ui.tsx';
import { errorMessage, orpc } from '../lib/api.ts';

const WORDING = { used: 'wording.used', off: 'wording.off', busy: 'wording.busy', budget: 'wording.budget', failed: 'wording.failed' } as const;
const NOTE_STATE = {
  used: 'noteState.used',
  none: 'noteState.none',
  off: 'noteState.off',
  busy: 'noteState.busy',
  budget: 'noteState.budget',
  failed: 'noteState.failed',
} as const;

// A draft is read fresh each time the dialog opens: the facts key must be the chosen stage's now.
const FRESH = { staleTime: 0, gcTime: 0, refetchOnMount: 'always', refetchOnWindowFocus: false } as const;

function Label({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
      {children}
    </label>
  );
}

function buildPersonalNoteStarter(draft: FollowupDraft): string {
  const parts: string[] = [draft.words.greeting, '', draft.words.lead];
  if (draft.facts.summary.trim() !== '') {
    parts.push('', draft.facts.summary.trim());
  }
  const bullets = [
    ...draft.facts.decisions.filter((d) => d.trim() !== '').map((d) => `- ${d.trim()}`),
    ...draft.facts.items.map((item) => `- ${item.title.trim()}`).filter((line) => line !== '- '),
  ];
  if (bullets.length > 0) {
    parts.push('', ...bullets);
  }
  parts.push('', draft.words.closing);
  return parts.join('\n').slice(0, FOLLOWUP_NOTE_MAX);
}

export function FollowupForm({
  draft,
  noteStatus = null,
  noteStatusPending = false,
  initialStyle = 'structured',
  onStageChange,
  onSent,
  onReload,
}: {
  draft: FollowupDraft;
  noteStatus?: FollowupNoteStatus | null;
  noteStatusPending?: boolean;
  initialStyle?: FollowupStyle;
  onStageChange?: (stage: FollowupStage) => void;
  onSent: (queued: number) => void;
  onReload?: () => void;
}) {
  const t = useTranslations('meetings.followup');
  const effectiveStage: FollowupStage = draft.stage ?? 'published';
  const [style, setStyle] = useState<FollowupStyle>(initialStyle);
  const [subject, setSubject] = useState(draft.words.subject);
  const [greeting, setGreeting] = useState(draft.words.greeting);
  const [lead, setLead] = useState(draft.words.lead);
  const [closing, setClosing] = useState(draft.words.closing);
  const [fromVy, setFromVy] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [hint, setHint] = useState('');
  const [before, setBefore] = useState<{ lead: string; closing: string } | null>(null);

  const [noteBody, setNoteBody] = useState(() => buildPersonalNoteStarter(draft));
  const [noteHint, setNoteHint] = useState('');
  const [noteFromVy, setNoteFromVy] = useState(false);
  const [noteReviewed, setNoteReviewed] = useState(false);
  const [noteBefore, setNoteBefore] = useState<string | null>(null);

  const [confirmUnpublished, setConfirmUnpublished] = useState(false);
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
    mutationFn: () =>
      orpc.meetings.followup.wording.call({
        meetingId: draft.meetingId,
        stage: effectiveStage,
        ...(hint.trim() ? { hint: hint.trim() } : {}),
      }),
    onSuccess: (answer: FollowupWording) => {
      if (!answer.words) return;
      // The words before Vy's first text: Undo goes back to these, never to an earlier Vy text that would lose its review tick.
      setBefore((b) => b ?? { lead, closing });
      setLead(answer.words.lead);
      setClosing(answer.words.closing);
      // Vy's words are the model's until the recorder says they read them.
      setFromVy(true);
      setReviewed(false);
      touch();
    },
  });

  const generateNote = useMutation({
    mutationFn: () =>
      orpc.meetings.followup.note.call({
        meetingId: draft.meetingId,
        stage: effectiveStage,
        ...(noteHint.trim() ? { hint: noteHint.trim() } : {}),
      }),
    onSuccess: (answer: FollowupNoteAnswer) => {
      if (answer.ai !== 'used' || answer.note === null) return;
      setNoteBefore((b) => b ?? noteBody);
      setNoteBody(answer.note);
      setNoteFromVy(true);
      setNoteReviewed(false);
      touch();
    },
  });

  const send = useMutation({
    mutationFn: () =>
      orpc.meetings.followup.send.call({
        meetingId: draft.meetingId,
        style,
        stage: effectiveStage,
        factsKey: draft.factsKey,
        subject,
        ...(style === 'personal_note'
          ? {
              body: noteBody,
              fromVy: noteFromVy,
              reviewed: noteReviewed,
            }
          : {
              greeting,
              lead,
              closing,
              fromVy,
              reviewed,
            }),
        confirmUnpublished: effectiveStage === 'draft' ? confirmUnpublished : false,
        recipients: [...chosen],
        confirmedOutsiders: extra.filter((a) => confirmed.has(a)),
        confirmRepeat,
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
  const sendCode = (send.error as { code?: string } | null)?.code;
  // The tick also shows when the server says an address (one the recorder added) already got the mail.
  const askRepeat = repeats.length > 0 || sendCode === 'ALREADY_SENT';
  const activeReviewBlocked = style === 'personal_note' ? noteFromVy && !noteReviewed : fromVy && !reviewed;
  const activeTextEmpty =
    style === 'personal_note'
      ? subject.trim() === '' || noteBody.trim() === ''
      : subject.trim() === '' || lead.trim() === '' || closing.trim() === '' || greeting.trim() === '';
  const blocked =
    picked.length === 0 ||
    picked.length > FOLLOWUP_RECIPIENTS_MAX ||
    draft.sendsLeft === 0 ||
    (effectiveStage === 'draft' && !confirmUnpublished) ||
    activeReviewBlocked ||
    outsiders.some((a) => !confirmed.has(a)) ||
    (askRepeat && !confirmRepeat && repeats.length > 0) ||
    activeTextEmpty;

  const busyAi = wording.isPending || generateNote.isPending;
  const noteAiOff = noteStatus !== null && !noteStatus.enabled && noteStatus.reason === 'off';
  const noteAiDisabledReason =
    noteStatus !== null && !noteStatus.enabled && (noteStatus.reason === 'budget' || noteStatus.reason === 'paused' || noteStatus.reason === 'forbidden')
      ? noteStatus.reason
      : null;

  return (
    <div className="space-y-4" data-testid="followup-form">
      <p className="text-xs text-muted-foreground">{t('note')}</p>

      {draft.hasPublished && draft.hasDraft && onStageChange && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('stageLabel')} data-testid="followup-stage-switch">
          <Button
            type="button"
            size="sm"
            variant={effectiveStage === 'published' ? 'secondary' : 'outline'}
            aria-pressed={effectiveStage === 'published'}
            disabled={send.isPending || busyAi}
            onClick={() => onStageChange('published')}
            data-testid="followup-stage-published"
          >
            {t('stagePublished')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={effectiveStage === 'draft' ? 'secondary' : 'outline'}
            aria-pressed={effectiveStage === 'draft'}
            disabled={send.isPending || busyAi}
            onClick={() => onStageChange('draft')}
            data-testid="followup-stage-draft"
          >
            {t('stageDraft')}
          </Button>
        </div>
      )}

      {effectiveStage === 'draft' && (
        <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm" data-testid="followup-unpublished-notice">
          <p className="text-xs text-foreground">{t('unpublishedNotice')}</p>
          <label className="flex cursor-pointer items-center gap-2 text-xs font-medium max-md:min-h-11" data-testid="followup-confirm-unpublished">
            <Checkbox checked={confirmUnpublished} onCheckedChange={(on) => { setConfirmUnpublished(on === true); touch(); }} />
            <span>{t('confirmUnpublished')}</span>
          </label>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('styleLabel')} data-testid="followup-style-switch">
        <Button
          type="button"
          size="sm"
          variant={style === 'structured' ? 'secondary' : 'outline'}
          aria-pressed={style === 'structured'}
          disabled={send.isPending || busyAi}
          onClick={() => { setStyle('structured'); touch(); }}
          data-testid="followup-style-structured"
        >
          {t('styleStructured')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={style === 'personal_note' ? 'secondary' : 'outline'}
          aria-pressed={style === 'personal_note'}
          disabled={send.isPending || busyAi}
          onClick={() => { setStyle('personal_note'); touch(); }}
          data-testid="followup-style-personal"
        >
          {t('stylePersonalNote')}
        </Button>
      </div>

      <section className="space-y-2">
        <h3 className="text-xs font-medium text-muted-foreground">{t('wordsTitle')}</h3>
        <div className="space-y-1">
          <Label htmlFor="followup-subject">{t('subject')}</Label>
          <Input id="followup-subject" value={subject} maxLength={FOLLOWUP_SUBJECT_MAX} onChange={(e) => { setSubject(e.target.value); touch(); }} />
        </div>

        {style === 'structured' ? (
          <>
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
          </>
        ) : (
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="followup-note-body">{t('noteBody')}</Label>
              <span className="text-xs tabular-nums text-muted-foreground">
                {Array.from(noteBody).length} / {FOLLOWUP_NOTE_MAX}
              </span>
            </div>
            <Textarea
              id="followup-note-body"
              value={noteBody}
              rows={9}
              maxLength={FOLLOWUP_NOTE_MAX}
              onChange={(e) => { setNoteBody(e.target.value); touch(); }}
              data-testid="followup-note-body"
            />
            <p className="text-xs text-muted-foreground">{t('noteBodyHelp')}</p>
          </div>
        )}
      </section>

      {style === 'structured' ? (
        <section className="space-y-2" data-testid="followup-vy">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label={t('hint')}
              className="min-w-48 flex-1"
              value={hint}
              maxLength={FOLLOWUP_HINT_MAX}
              placeholder={t('hintExample')}
              disabled={send.isPending || busyAi}
              onChange={(e) => { setHint(e.target.value); wording.reset(); }}
            />
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
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setLead(before.lead);
                setClosing(before.closing);
                setBefore(null);
                setFromVy(false);
                setReviewed(false);
                touch();
                wording.reset();
              }}
            >
              {t('wordingUndo')}
            </Button>
          )}
          {fromVy && (
            <label className="flex cursor-pointer items-center gap-2 text-sm max-md:min-h-11" data-testid="followup-review">
              <Checkbox checked={reviewed} onCheckedChange={(on) => { setReviewed(on === true); touch(); }} />
              <Badge variant="outline">{t('fromVy')}</Badge>
              <span>{t('reviewed')}</span>
            </label>
          )}
        </section>
      ) : (
        <section className="space-y-2" data-testid="followup-note-vy">
          {noteAiOff ? (
            <p className="text-xs text-muted-foreground" data-testid="followup-note-ai-off">
              {t('noteAiOff')}
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label={t('hint')}
                className="min-w-48 flex-1"
                value={noteHint}
                maxLength={FOLLOWUP_HINT_MAX}
                placeholder={t('noteHintExample')}
                disabled={send.isPending || busyAi || noteAiDisabledReason !== null}
                onChange={(e) => { setNoteHint(e.target.value); generateNote.reset(); }}
                data-testid="followup-note-hint"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                loading={generateNote.isPending}
                disabled={send.isPending || noteStatusPending || noteAiDisabledReason !== null}
                onClick={() => generateNote.mutate()}
                data-testid="followup-note-generate"
              >
                {t('noteButton')}
              </Button>
            </div>
          )}
          {noteAiDisabledReason && (
            <p className="text-xs text-muted-foreground" role="status" data-testid="followup-note-disabled-reason">
              {t(`noteAiStatus.${noteAiDisabledReason}`)}
            </p>
          )}
          {generateNote.data && (
            <p className="text-xs text-subtle-foreground" role="status" data-testid="followup-note-state">
              {t(NOTE_STATE[generateNote.data.ai])}
            </p>
          )}
          {generateNote.error && <ErrorText>{errorMessage(generateNote.error)}</ErrorText>}
          {noteBefore !== null && noteFromVy && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setNoteBody(noteBefore);
                setNoteBefore(null);
                setNoteFromVy(false);
                setNoteReviewed(false);
                touch();
                generateNote.reset();
              }}
              data-testid="followup-note-undo"
            >
              {t('noteUndo')}
            </Button>
          )}
          {noteFromVy && (
            <label className="flex cursor-pointer items-center gap-2 text-sm max-md:min-h-11" data-testid="followup-review">
              <Checkbox checked={noteReviewed} onCheckedChange={(on) => { setNoteReviewed(on === true); touch(); }} />
              <Badge variant="outline">{t('fromVy')}</Badge>
              <span>{t('reviewed')}</span>
            </label>
          )}
        </section>
      )}

      <section className="space-y-2">
        <h3 className="text-xs font-medium text-muted-foreground">{t('recipientsTitle')}</h3>
        {draft.recipients.length === 0 && extra.length === 0 && (
          <p className="text-xs text-muted-foreground">{effectiveStage === 'draft' ? t('noRecipientsDraft') : t('noRecipients')}</p>
        )}
        <ul className="space-y-1 text-sm" data-testid="followup-recipients">
          {draft.recipients.map((r) => (
            <li key={r.email}>
              <label className="flex cursor-pointer items-center gap-2 max-md:min-h-11">
                <Checkbox checked={chosen.has(r.email)} onCheckedChange={(on) => toggle(r.email, on === true)} />
                <span>{r.name}</span>
                <span className="text-xs text-muted-foreground">{r.email}</span>
                {r.alreadySent && <Badge variant="outline">{t('alreadySent')}</Badge>}
              </label>
            </li>
          ))}
          {extra.map((address) => (
            <li key={address} className="space-y-1" data-testid="followup-outsider">
              <label className="flex cursor-pointer items-center gap-2 max-md:min-h-11">
                <Checkbox checked={chosen.has(address)} onCheckedChange={(on) => toggle(address, on === true)} />
                <span className="text-xs">{address}</span>
                <Badge variant="outline">{t('outsider')}</Badge>
              </label>
              {chosen.has(address) && (
                <label className="flex cursor-pointer items-center gap-2 pl-6 text-xs max-md:min-h-11">
                  <Checkbox checked={confirmed.has(address)} onCheckedChange={(on) => tick(address, on === true)} />
                  <span>{t('confirmOutsider')}</span>
                </label>
              )}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label={t('addAddress')}
            className="min-w-48 flex-1"
            type="email"
            value={extraText}
            placeholder={t('addAddress')}
            maxLength={254}
            onChange={(e) => { setExtraText(e.target.value); setExtraError(false); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addExtra(); } }}
          />
          <Button variant="outline" size="sm" onClick={addExtra} disabled={extraText.trim() === ''}>
            {t('add')}
          </Button>
        </div>
        {extraError && <ErrorText>{t('addressInvalid')}</ErrorText>}
        {askRepeat && (
          <label className="flex cursor-pointer items-center gap-2 text-xs max-md:min-h-11" data-testid="followup-repeat">
            <Checkbox checked={confirmRepeat} onCheckedChange={(on) => { setConfirmRepeat(on === true); touch(); }} />
            <span>{t('confirmRepeat', { count: String(Math.max(repeats.length, 1)) })}</span>
          </label>
        )}
      </section>

      <div className="space-y-2 border-t pt-3">
        <p className="text-xs text-muted-foreground">{draft.sendsLeft === 0 ? t('limitReached') : t('sendsLeft', { count: String(draft.sendsLeft) })}</p>
        {send.error && <ErrorText>{errorMessage(send.error)}</ErrorText>}
        {sendCode === 'STALE_FOLLOWUP' && onReload && (
          <Button variant="outline" size="sm" onClick={onReload} data-testid="followup-reload">
            {t('reload')}
          </Button>
        )}
        <Button loading={send.isPending} disabled={blocked || busyAi} onClick={() => send.mutate()} data-testid="followup-send">
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

/**
 * The stage to ask for after a failed load. A draft the recorder chose that was published (or removed) in another tab is gone: the default stage (published, else draft) is
 * asked for again instead of leaving the dialog on "no draft" until it is reopened (#4479).
 */
export function stageAfterLoadError(choice: FollowupStage | undefined, error: unknown): FollowupStage | undefined {
  const code = (error as { code?: string } | null)?.code;
  return choice === 'draft' && code === 'NO_DRAFT_SUMMARY' ? undefined : choice;
}

function FollowupBody({ meetingId, onSent }: { meetingId: string; onSent: (queued: number) => void }) {
  const [stageChoice, setStageChoice] = useState<FollowupStage | undefined>(undefined);
  const draft = useQuery({
    ...orpc.meetings.followup.draft.queryOptions({ input: { meetingId, ...(stageChoice ? { stage: stageChoice } : {}) } }),
    ...FRESH,
  });
  const noteStatus = useQuery({
    ...orpc.meetings.followup.noteStatus.queryOptions({ input: { meetingId } }),
    ...FRESH,
  });
  const fallback = draft.error ? stageAfterLoadError(stageChoice, draft.error) : stageChoice;
  useEffect(() => {
    if (fallback !== stageChoice) setStageChoice(fallback);
  }, [fallback, stageChoice]);
  if (draft.isPending) return null;
  // The default stage is being asked for: nothing is shown for the one render before it loads, not the error of the stage that is gone.
  if (draft.error && fallback !== stageChoice) return null;
  if (draft.error) return <ErrorText>{errorMessage(draft.error)}</ErrorText>;
  return (
    <FollowupForm
      key={`${draft.data.stage ?? 'published'}-${draft.data.factsKey}`}
      draft={draft.data}
      noteStatus={noteStatus.data ?? null}
      noteStatusPending={noteStatus.isPending}
      onStageChange={(next) => setStageChoice(next)}
      onSent={onSent}
      onReload={() => void draft.refetch()}
    />
  );
}
