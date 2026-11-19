// SPDX-License-Identifier: AGPL-3.0-only
// The machine translation of a meeting's summary on its page (meetings integrations E1, #3184, plan section 7a). Any reader can ask for a translation of the summary they read, and
// the recorder for their own draft: the button says the language it will translate into (the other of Vietnamese and English), what it is expected to cost and, when it cannot be
// pressed, why. Vy translates on the click; the answer is the member's alone, shown beside the original as "Bản dịch máy" and never in its place. A line the checks refused shows
// the original with a fixed word; a line with a mark shows the translation and the mark. A translation is never shared, mailed or turned into a task from here.
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { AiMeter, Translated, TranslationSegment, TranslationStatus, TranslationTarget, Translations } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { useFormat } from '../i18n/provider.tsx';
import { ErrorText } from './ui.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { hasChoice, langTag, pickedTarget } from '../lib/translation-targets.ts';

type Stage = 'draft' | 'published';
// What the screen shows of the original it translates, so the translation can sit beside it line by line.
export interface TranslationOriginal {
  summary: string;
  decisions: readonly string[];
  items: ReadonlyArray<{ id: string; title: string }>;
}

// Why the button cannot be pressed, as a key under `meetings.results.translation`, or null when it can. The status is the server's (the switch, text to translate); the meter is the
// org's AI budget (aiOn false: no model on this system; state stop: a budget that covers meetings is spent). A stopped Vy is told by the refusal of the click.
export function translateBlocked(status: Pick<TranslationStatus, 'enabled' | 'reason'> | undefined, meter: Pick<AiMeter, 'aiOn' | 'state'> | undefined): 'off' | 'nothing' | 'noModel' | 'budget' | null {
  if (!status) return 'off';
  if (!status.enabled) return status.reason === 'nothing' ? 'nothing' : 'off';
  if (meter && !meter.aiOn) return 'noModel';
  if (meter && meter.state === 'stop') return 'budget';
  return null;
}

// The picker of the language to translate into (E3, #3186): shown only when the server offers more than the other language of the pair, so a deployment that has switched none on sees no new control. Each
// name is written in its own language, whatever the screen's.
export function TranslationTargetPicker({ id, targets, value, onChange, disabled }: { id: string; targets: readonly TranslationTarget[]; value: TranslationTarget; onChange: (to: TranslationTarget) => void; disabled?: boolean }) {
  const t = useTranslations('meetings.translationTargets');
  // Literal keys, one by one: a template key over the whole union makes the type checker build a big key union for every use of the translator.
  const names: Record<TranslationTarget, string> = { en: t('names.en'), vi: t('names.vi'), zh: t('names.zh'), ja: t('names.ja'), ko: t('names.ko') };
  return (
    <div className="flex items-center gap-2" data-testid="translation-target">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {t('label')}
      </Label>
      <NativeSelect id={id} value={value} disabled={disabled === true} onChange={(e) => onChange(e.target.value as TranslationTarget)} className="w-auto">
        {targets.map((to) => (
          <NativeSelectOption key={to} value={to} lang={langTag(to)}>
            {names[to]}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  );
}

const refresh = () => {
  void queryClient.invalidateQueries({ queryKey: orpc.meetings.translation.key() });
};
const READ_ONCE = { staleTime: 5 * 60_000, refetchOnWindowFocus: false } as const;

const KNOWN_FAILURES = ['AI_BUDGET_EXHAUSTED', 'AI_STOPPED', 'TRANSLATE_TIMEOUT', 'TRANSLATE_FAILED', 'TRANSLATE_UNPARSABLE', 'TRANSLATE_EMPTY', 'TRANSLATE_TOO_LONG', 'TRANSLATE_NOTHING', 'TRANSLATION_STALE'] as const;

// The translated lines beside their originals. A refused line keeps the original with a fixed word; a marked line keeps the translation with the mark.
function TranslatedLines({ translation, original }: { translation: Translations['translations'][number]; original: TranslationOriginal }) {
  const t = useTranslations('meetings.results.translation');
  const byKey = new Map<string, TranslationSegment>(translation.segments.map((s) => [s.key, s]));
  const line = (key: string, originalText: string) => {
    const s = byKey.get(key);
    if (!s) return null;
    if (s.state === 'refused') {
      return (
        <>
          <span>{originalText}</span> <span className="text-xs text-muted-foreground">({t('refused')})</span>
        </>
      );
    }
    return (
      <>
        <span>{s.text}</span>
        {s.codes.map((code) => (
          <Badge key={code} variant="outline" className="ml-1" data-testid="translation-mark">
            {t(`marks.${code as 'NUMBER_DROPPED' | 'NAME_ADDED'}`)}
          </Badge>
        ))}
      </>
    );
  };
  const summary = line('summary', original.summary);
  const decisions = original.decisions.flatMap((d, i) => {
    const l = line(`decision:${i}`, d);
    return l ? [{ i, l }] : [];
  });
  const items = original.items.flatMap((item) => {
    const l = line(`item:${item.id}`, item.title);
    return l ? [{ id: item.id, l }] : [];
  });
  return (
    <div className="space-y-2 text-sm" lang={langTag(translation.to)}>
      {summary && <p className="whitespace-pre-wrap">{summary}</p>}
      {decisions.length > 0 && (
        <ul className="list-disc space-y-1 pl-5">
          {decisions.map(({ i, l }) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
      {items.length > 0 && (
        <ul className="list-disc space-y-1 pl-5">
          {items.map(({ id, l }) => (
            <li key={id}>{l}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function MeetingTranslation({ meetingId, stage, original }: { meetingId: string; stage: Stage; original: TranslationOriginal }) {
  const t = useTranslations('meetings.results.translation');
  const f = useFormat();
  const tt = useTranslations('meetings.translationTargets');
  // The language the member picked; none until they do (the server then takes the other language of the pair, as before the picker).
  const [picked, setPicked] = useState<TranslationTarget | undefined>(undefined);
  const status = useQuery({ ...orpc.meetings.translation.status.queryOptions({ input: { meetingId, stage, ...(picked ? { to: picked } : {}) } }), ...READ_ONCE, placeholderData: keepPreviousData });
  const meter = useQuery({ ...orpc.ai.meter.queryOptions({ input: { module: 'meetings' } }), staleTime: 15_000 });
  const mine = useQuery({ ...orpc.meetings.translation.get.queryOptions({ input: { meetingId } }), ...READ_ONCE });
  const ask = useMutation({ mutationFn: (): Promise<Translated> => orpc.meetings.translation.translate.call({ meetingId, stage, ...(picked ? { to: picked } : {}) }), onSuccess: refresh });
  // Nothing to show before the server has answered; a deployment without Vy for meetings has no status data, so no panel at all.
  if (!status.data) return null;
  const blocked = translateBlocked(status.data, meter.data);
  // The member's own translation into the language shown (one per stage and language).
  // The language shown: the member's pick at once (the status of a new pick takes a moment to arrive and the card keeps the previous one meanwhile), else what the server answered.
  const shown = picked ?? status.data.to;
  const switching = status.isPlaceholderData;
  const translation = mine.data?.translations.find((x) => x.stage === stage && x.to === shown);
  const answer = ask.data;
  const failure = answer?.state === 'failed' ? ((KNOWN_FAILURES as readonly string[]).includes(answer.errorCode ?? '') ? (answer.errorCode as (typeof KNOWN_FAILURES)[number]) : 'default') : null;
  // The button's words for the language shown: the long-standing ones for the pair, and "Dịch sang {language}" for the rest (literal keys, so the translator keeps its narrow type).
  const otherNames = { zh: tt('names.zh'), ja: tt('names.ja'), ko: tt('names.ko') };
  const label = shown === 'en' ? t('toEnglish') : shown === 'vi' ? t('toVietnamese') : tt('to', { language: otherNames[shown] });
  const cost = status.data.estimate?.cost ?? null;
  return (
    <div className="space-y-2 rounded-lg border p-3" data-testid="meeting-translation" data-stage={stage}>
      {translation && (
        <div className="space-y-2" data-testid="translation-block">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{t('label')}</Badge>
            {translation.stale && <span className="text-xs text-warning">{t('stale')}</span>}
          </div>
          <TranslatedLines translation={translation} original={original} />
          <p className="text-xs text-muted-foreground">{t('private')}</p>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {hasChoice(status.data.targets) && <TranslationTargetPicker id={`translate-to-${stage}`} targets={status.data.targets} value={shown} disabled={ask.isPending} onChange={(to) => {
          // A new language is a new request: the answer or the failure of the one before is not shown beside it.
          ask.reset();
          setPicked(pickedTarget(to, status.data.targets));
        }} />}
        <Button size="sm" variant={translation && !translation.stale ? 'outline' : 'default'} loading={ask.isPending} disabled={blocked !== null || ask.isPending || switching} onClick={() => ask.mutate()}>
          {translation ? (translation.stale ? t('again') : t('againFresh')) : label}
        </Button>
        {blocked !== null && (
          <span className="text-xs text-muted-foreground" role="status" data-testid="translation-blocked">
            {t(`blocked.${blocked}`)}
          </span>
        )}
        {blocked === null && cost !== null && <span className="text-xs text-muted-foreground">{t('estimate', { cost: f.aiAmount(cost) })}</span>}
      </div>
      {/* Always in the page: the progress of the translation is announced when it starts and when it ends. */}
      <div role="status" aria-live="polite" className="empty:mb-0">
        {ask.isPending && <p className="text-xs">{t('running')}</p>}
      </div>
      {failure && <ErrorText>{`${t('failed')} ${t(`codes.${failure}`)}`}</ErrorText>}
      {ask.error && <ErrorText>{errorMessage(ask.error)}</ErrorText>}
      {!translation && blocked === null && <p className="text-xs text-muted-foreground">{t('desc')}</p>}
    </div>
  );
}
