// SPDX-License-Identifier: AGPL-3.0-only
// What would be sent to MISA AMIS Kế toán (#3901, S3a of #3854), in the connection card: a person picks a voucher kind and a period and sees the vouchers as the push would write them, each with its AMIS
// type, lines and total, and the blockers that keep one from being sent. A read (vouchers.misaAmisPreview): nothing is sent from here. The AMIS branch and the party codes are not matched yet, and the choices
// Ludy made for AMIS (reftype, reason, purchase purpose) are shown, because they are not yet confirmed against a MISA sandbox. A row is told by Ludy's voucher number and the line, never a name or an invoice.
import { useMutation } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { MISA_AMIS_BLOCKERS, MISA_AMIS_KINDS, type MisaAmisBlockerNotes, type MisaAmisKind, type MisaAmisMatchCheckQueued, type MisaAmisMatchStatus, type MisaAmisPreview, type MisaAmisPreviewItem } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage } from '../lib/api.ts';
import { MisaAmisPushConfirm } from './misa-amis-push-panel.tsx';
import { CHECK_POLL_MS, CHECK_WAIT_MS, checkTick, pickResult } from '../lib/misa-amis-match-check.ts';
import type { PushOffer } from '../lib/misa-amis-push.ts';
import { ErrorText } from './ui.tsx';

const PURPOSES = ['1', '2', '3', '4', '5'] as const;
type Purpose = (typeof PURPOSES)[number];
// How many vouchers the list shows on screen (the server sends up to 500).
const SHOWN = 20;

// The kinds of blocker on the rows the screen shows (the first SHOWN vouchers), each once: the coworker's notes are shown only beside a kind that is on the list on screen, so a note is never read beside a list it was not written for.
function kindsOnList(result: MisaAmisPreview): Set<string> {
  return new Set(result.items.slice(0, SHOWN).flatMap((item) => item.blockers.map((b) => b.code)));
}

// `push` is given where the connection card can offer to send what the preview shows (an owner or admin, the push on, the connection tested): the preview itself stays a read.
// `checkConnectionId` is given only to an owner or admin (the route refuses anyone else): it shows the button that asks for the check.
export function MisaAmisPreviewPanel({ legalEntityId, push, checkConnectionId }: { legalEntityId: string; push?: { connectionId: string; offer: PushOffer }; checkConnectionId?: string }) {
  const t = useTranslations('misaAmisPreview');
  const lang = useLocale() === 'en' ? 'en' : 'vi';
  const [kind, setKind] = useState<MisaAmisKind>(MISA_AMIS_KINDS[0]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [serviceItemCode, setServiceItemCode] = useState('');
  const [salesItemCode, setSalesItemCode] = useState('');
  const [purpose, setPurpose] = useState<Purpose>('1');
  const id = useId();
  const asked = `${kind}|${from}|${to}|${serviceItemCode}|${salesItemCode}|${purpose}|${legalEntityId}`;
  const ask = {
    kind,
    legalEntityId,
    purchasePurpose: purpose,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(serviceItemCode.trim() ? { serviceItemCode: serviceItemCode.trim() } : {}),
    ...(salesItemCode.trim() ? { salesItemCode: salesItemCode.trim() } : {}),
  };
  const preview = useMutation<MisaAmisPreview>({ mutationFn: () => client.vouchers.misaAmisPreview(ask) });
  // The coworker's notes on the kinds of blocker (S5): asked only when something is blocked, after the list is on screen; with AI off or every note dropped the list stands alone.
  const notes = useMutation<MisaAmisBlockerNotes>({ mutationFn: () => client.vouchers.misaAmisBlockerNotes({ ...ask, lang }) });
  const [answeredFor, setAnsweredFor] = useState<string | null>(null);
  // Counts the previews that landed: the confirm block starts afresh with each one, so a send that is done (or refused as stale) never hides the button for the next confirmation of the same digest.
  const [runs, setRuns] = useState(0);
  // Anything the answer depended on changing clears it, so an old list is never read beside new choices.
  const { reset } = preview;
  const { reset: resetNotes } = notes;
  useEffect(() => {
    reset();
    resetNotes();
  }, [asked, reset, resetNotes]);
  // The last answer that landed, kept while a re-read is in flight (a mutation clears its own data when it runs again): the list, the status line and the button stay mounted, so the status text changes in place and focus is kept.
  const [last, setLast] = useState<{ asked: string; data: MisaAmisPreview } | null>(null);
  const result = pickResult(last, preview.data ?? null, answeredFor, asked);
  const inFlight = useRef(false);
  inFlight.current = preview.isPending;
  const check = useMutation<MisaAmisMatchCheckQueued>({ mutationFn: () => client.misaAmis.matches.check({ id: checkConnectionId ?? '', ask }) });
  const [waitUntil, setWaitUntil] = useState<number | null>(null);
  const [slow, setSlow] = useState(false);
  const checkState = result?.matchCheck.state ?? null;
  const { mutate: rerun } = preview;
  // Anything the answer depended on changing ends the wait with it.
  useEffect(() => {
    setWaitUntil(null);
    setSlow(false);
  }, [asked]);
  useEffect(() => {
    if (waitUntil === null) return;
    if (checkTick(checkState, waitUntil, Date.now()) === 'stop') {
      setWaitUntil(null);
      return;
    }
    const timer = setInterval(() => {
      const tick = checkTick(checkState, waitUntil, Date.now());
      if (tick !== 'poll') {
        setWaitUntil(null);
        setSlow(tick === 'slow');
        return;
      }
      if (inFlight.current) return;
      rerun(undefined, { onSuccess: (data) => { setAnsweredFor(asked); setLast({ asked, data }); } });
    }, CHECK_POLL_MS);
    return () => clearInterval(timer);
  }, [waitUntil, checkState, rerun, asked]);
  // The slow notice belongs to a check that is still waiting: once a result is shown (done, failed or none) it is cleared, so a later request never starts with it already up.
  useEffect(() => {
    if (checkState !== 'requested') setSlow(false);
  }, [checkState]);
  const waiting = waitUntil !== null;
  const askCheck = () => {
    setSlow(false);
    check.mutate(undefined, {
      // The preview is read again at once, so the line says "checking" and the poll starts from what the server holds.
      onSuccess: () => preview.mutate(undefined, { onSuccess: (data) => { setAnsweredFor(asked); setLast({ asked, data }); setWaitUntil(Date.now() + CHECK_WAIT_MS); } }),
    });
  };
  return (
    <details className="mt-3 rounded-md border border-border p-3 text-sm" data-testid="misa-amis-preview">
      <summary className="cursor-pointer font-medium text-foreground">{t('title')}</summary>
      <p className="mt-2 text-muted-foreground">{t('hint')}</p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-kind`} className="text-xs text-muted-foreground">
            {t('kindLabel')}
          </label>
          <NativeSelect id={`${id}-kind`} value={kind} onChange={(e) => setKind(e.target.value as MisaAmisKind)}>
            {MISA_AMIS_KINDS.map((k) => (
              <NativeSelectOption key={k} value={k}>
                {t(`kind.${k}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-from`} className="text-xs text-muted-foreground">
            {t('from')}
          </label>
          <Input id={`${id}-from`} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-to`} className="text-xs text-muted-foreground">
            {t('to')}
          </label>
          <Input id={`${id}-to`} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        {kind === 'purchase_services' && (
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-service`} className="text-xs text-muted-foreground">
              {t('serviceItem')}
            </label>
            <Input id={`${id}-service`} className="min-w-40" maxLength={50} autoComplete="off" value={serviceItemCode} onChange={(e) => setServiceItemCode(e.target.value)} />
          </div>
        )}
        {kind === 'sales' && (
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-sales`} className="text-xs text-muted-foreground">
              {t('salesItem')}
            </label>
            <Input id={`${id}-sales`} className="min-w-40" maxLength={50} autoComplete="off" value={salesItemCode} onChange={(e) => setSalesItemCode(e.target.value)} />
          </div>
        )}
        {(kind === 'purchase_services' || kind === 'purchase_goods' || kind === 'cash_payment' || kind === 'bank_debit') && (
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-purpose`} className="text-xs text-muted-foreground">
              {t('purposeLabel')}
            </label>
            <NativeSelect id={`${id}-purpose`} value={purpose} onChange={(e) => setPurpose(e.target.value as Purpose)}>
              {PURPOSES.map((p) => (
                <NativeSelectOption key={p} value={p}>
                  {t(`purpose.${p}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        )}
        <Button type="button" variant="outline" size="sm" loading={preview.isPending} onClick={() =>
            preview.mutate(undefined, {
              onSuccess: (data) => {
                setAnsweredFor(asked);
                setLast({ asked, data });
                setRuns((n) => n + 1);
                if (data.blocked > 0) notes.mutate();
              },
            })
          } data-testid="misa-amis-preview-run">
          {t('run')}
        </Button>
      </div>
      {preview.error && (
        <div className="mt-2" data-testid="misa-amis-preview-error">
          <ErrorText>{errorMessage(preview.error)}</ErrorText>
        </div>
      )}
      {result && <MisaAmisPreviewResult result={result} notes={notes.data ?? null} />}
      {result && checkConnectionId && <MisaAmisCheckButton state={result.matchCheck.state} pending={check.isPending} waiting={waiting} slow={slow && result.matchCheck.state === 'requested'} error={check.error} onAsk={askCheck} />}
      {result && push && <MisaAmisPushConfirm key={`${runs}:${result.digest}`} result={result} ask={ask} connectionId={push.connectionId} offer={push.offer} />}
    </details>
  );
}

function ItemRow({ item }: { item: MisaAmisPreviewItem }) {
  const t = useTranslations('misaAmisPreview');
  const f = useFormat();
  return (
    <li className="rounded-md border border-border p-2" data-testid="misa-amis-preview-item">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">{item.voucherNo}</span>
        <span className="text-xs text-muted-foreground">{t('amisType', { type: String(item.amisType) })}</span>
        <span className="text-xs text-muted-foreground">{t('lines', { count: String(item.lines) })}</span>
        {item.parts > 1 && <span className="text-xs text-muted-foreground">{t('parts', { count: String(item.parts) })}</span>}
        <span className="ml-auto tabular-nums text-foreground">{item.blockers.length === 0 ? f.money(item.total, 'VND') : ''}</span>
      </div>
      {item.blockers.length > 0 ? (
        <ul className="mt-1 space-y-1">
          {item.blockers.map((b, i) => (
            <li key={`${b.code}:${b.lineNo ?? ''}:${i}`} className="flex flex-wrap items-center gap-2" data-testid="misa-amis-preview-blocker">
              <Badge variant="secondary">{t(`blocker.${b.code}`)}</Badge>
              {b.lineNo !== null && <span className="text-xs text-muted-foreground">#{b.lineNo}</span>}
            </li>
          ))}
          {item.blockersMore > 0 && (
            <li className="text-xs text-subtle-foreground" data-testid="misa-amis-preview-blockers-more">
              {t('moreBlockers', { count: String(item.blockersMore) })}
            </li>
          )}
        </ul>
      ) : (
        <p className="mt-1 text-xs text-subtle-foreground" data-testid="misa-amis-preview-choices">
          {t('choices', { reftype: String(item.reftype), reason: item.reasonTypeId === null ? t('noReason') : String(item.reasonTypeId) })}
        </p>
      )}
    </li>
  );
}

// The button that asks for the check (an owner or admin only: the panel is given no connection to check for anyone else). While a check waits it is disabled; a check that is done leaves it ready for the next.
export function MisaAmisCheckButton({ state, pending, waiting, slow, error, onAsk }: { state: MisaAmisMatchStatus['state']; pending: boolean; waiting: boolean; slow: boolean; error: unknown; onAsk: () => void }) {
  const t = useTranslations('misaAmisPreview');
  return (
    <div className="mt-2" data-testid="misa-amis-check">
      <Button type="button" variant="outline" size="sm" loading={pending || waiting} disabled={waiting} onClick={onAsk} data-testid="misa-amis-check-run">
        {waiting ? t('matchRunning') : state === 'done' ? t('matchRerun') : t('matchRun')}
      </Button>
      {slow && <p className="mt-1 text-xs text-muted-foreground">{t('matchSlow')}</p>}
      {error != null && <ErrorText>{errorMessage(error)}</ErrorText>}
    </div>
  );
}

// The last check against the firm's catalogue, in one line. The region is always there before its text changes, so a screen reader hears "checking" and the result without focus moving.
function MatchStatusLine({ result }: { result: MisaAmisPreview }) {
  const t = useTranslations('misaAmisPreview');
  const f = useFormat();
  const { state, failure, checkedAt } = result.matchCheck;
  let line: string | null = null;
  if (state === 'requested') line = t('matchChecking');
  else if (state === 'failed') line = t(`matchFailed.${failure ?? 'unreachable'}`);
  else if (state === 'done' && checkedAt) line = t('matchDone', { when: f.dateTime(checkedAt) });
  else if (!result.checkedAgainstAmis) line = t('notChecked');
  return (
    <div role="status" aria-live="polite">
      {line && (
        <p className="mb-2 text-muted-foreground" data-testid={state === 'none' ? 'misa-amis-preview-unchecked' : 'misa-amis-match-status'}>
          {line}
        </p>
      )}
    </div>
  );
}

export function MisaAmisPreviewResult({ result, notes = null }: { result: MisaAmisPreview; notes?: MisaAmisBlockerNotes | null }) {
  const t = useTranslations('misaAmisPreview');
  const onList = kindsOnList(result);
  const shown = notes?.ai === 'used' ? notes.notes.filter((n) => onList.has(n.code)) : [];
  if (result.vouchers === 0) {
    return (
      <div className="mt-3" data-testid="misa-amis-preview-empty">
        <p className="text-muted-foreground">{result.more ? t('moreOnly') : t('noVouchers')}</p>
      </div>
    );
  }
  return (
    <div className="mt-3" role="status" data-testid="misa-amis-preview-result">
      <p className="mb-1 text-foreground" data-testid="misa-amis-preview-summary">
        {t('summary', { vouchers: String(result.vouchers), ready: String(result.ready), blocked: String(result.blocked) })}
      </p>
      {shown.length > 0 && (
        <div className="mb-2 rounded-md border border-border p-2" data-testid="misa-amis-preview-notes">
          <p className="mb-1 text-xs font-medium text-muted-foreground">{t('notes.title')}</p>
          <ul className="space-y-1">
            {MISA_AMIS_BLOCKERS.flatMap((code) => shown.filter((n) => n.code === code)).map((n) => (
              <li key={n.code} className="text-muted-foreground" data-testid="misa-amis-preview-note">
                <Badge variant="secondary" className="mr-2">
                  {t(`blocker.${n.code}`)}
                </Badge>
                {n.text}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(notes?.ai === 'busy' || notes?.ai === 'budget' || notes?.ai === 'failed') && (
        <p className="mb-1 text-subtle-foreground" data-testid="misa-amis-preview-notes-ai-state">
          {t(`notes.${notes.ai}`)}
        </p>
      )}
      {result.more && (
        <p className="mb-1 text-muted-foreground" data-testid="misa-amis-preview-more">
          {t('more')}
        </p>
      )}
      <MatchStatusLine result={result} />
      <p className="mb-2 text-xs text-subtle-foreground" data-testid="misa-amis-preview-purpose">
        {t('purposeNote', { purpose: t(`purpose.${result.purchasePurpose}`) })}
      </p>
      <ul className="space-y-2">
        {result.items.slice(0, SHOWN).map((item) => (
          <ItemRow key={item.sourceId} item={item} />
        ))}
      </ul>
      {result.items.length > SHOWN && <p className="mt-2 text-xs text-subtle-foreground">{t('andMore', { count: String(result.items.length - SHOWN) })}</p>}
      <p className="mt-2 text-xs text-subtle-foreground">{t('nothingSent')}</p>
    </div>
  );
}
