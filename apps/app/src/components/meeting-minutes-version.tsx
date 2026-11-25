// SPDX-License-Identifier: AGPL-3.0-only
// The second-language version of a meeting's published minutes on its page (Meetings, #4777). Two parts:
//   MinutesVersionSwitch     every reader of the meeting: when the recorder has published a version, a switch between the original and that language. The original stays the record and is
//                            what shows first.
//   MinutesVersionPublisher  the recorder only: Vy's translation of the shared minutes (the card above, MeetingTranslation) becomes the draft they review segment by segment, edit, and
//                            publish with one click. Nothing is published without it; a segment left empty is left out. The server holds the text to the original it was made from.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import type { MinutesVersion, TranslationSegment, TranslationTarget } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Textarea } from '@ludy/ui/components/textarea';
import { ErrorText } from './ui.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { langTag } from '../lib/translation-targets.ts';
import type { TranslationOriginal } from './meeting-translation.tsx';

// The segments the translation run works on, in the order the server reads them (readTranslationSource): the summary, each decision, the title of each item of the shown stage.
export function segmentsOf(original: TranslationOriginal): Array<{ key: string; text: string }> {
  const out: Array<{ key: string; text: string }> = [];
  if (original.summary.trim() !== '') out.push({ key: 'summary', text: original.summary });
  original.decisions.forEach((d, i) => {
    if (d.trim() !== '') out.push({ key: `decision:${i}`, text: d });
  });
  for (const item of original.items) if (item.title.trim() !== '') out.push({ key: `item:${item.id}`, text: item.title });
  return out;
}

// The text the review starts from: Vy's checked translation, with a refused segment empty (the recorder writes it or leaves it out).
export function draftFrom(original: TranslationOriginal, translated: readonly TranslationSegment[]): Record<string, string> {
  const byKey = new Map(translated.map((s) => [s.key, s]));
  const draft: Record<string, string> = {};
  for (const { key } of segmentsOf(original)) {
    const s = byKey.get(key);
    draft[key] = s && s.state !== 'refused' ? s.text : '';
  }
  return draft;
}

// What is sent: the segments with text, in the original's order (the server holds the order and the keys).
export function publishable(original: TranslationOriginal, draft: Readonly<Record<string, string>>): Array<{ key: string; text: string }> {
  return segmentsOf(original).flatMap(({ key }) => {
    const text = (draft[key] ?? '').trim();
    return text === '' ? [] : [{ key, text }];
  });
}

const refreshVersions = () => {
  void queryClient.invalidateQueries({ queryKey: orpc.meetings.minutesVersion.key() });
};

function VersionLines({ version, original }: { version: MinutesVersion; original: TranslationOriginal }) {
  const byKey = new Map(version.segments.map((s) => [s.key, s.text]));
  const summary = byKey.get('summary');
  const decisions = original.decisions.flatMap((_, i) => {
    const text = byKey.get(`decision:${i}`);
    return text === undefined ? [] : [{ i, text }];
  });
  const items = original.items.flatMap((item) => {
    const text = byKey.get(`item:${item.id}`);
    return text === undefined ? [] : [{ id: item.id, text }];
  });
  return (
    <div className="space-y-2 text-sm" lang={langTag(version.language)} data-testid="minutes-version-text">
      {summary !== undefined && <p className="whitespace-pre-wrap">{summary}</p>}
      {decisions.length > 0 && (
        <ul className="list-disc space-y-1 pl-5">
          {decisions.map(({ i, text }) => (
            <li key={i}>{text}</li>
          ))}
        </ul>
      )}
      {items.length > 0 && (
        <ul className="list-disc space-y-1 pl-5">
          {items.map(({ id, text }) => (
            <li key={id}>{text}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Readers: the original is the child; with a published version a switch shows the version instead, on the reader's own choice.
export function MinutesVersionSwitch({ meetingId, original, children }: { meetingId: string; original: TranslationOriginal; children: ReactNode }) {
  const t = useTranslations('meetings.results.minutesVersion');
  const tt = useTranslations('meetings.translationTargets');
  const versions = useQuery({ ...orpc.meetings.minutesVersion.get.queryOptions({ input: { meetingId } }), staleTime: 0, refetchOnWindowFocus: false });
  const [shown, setShown] = useState<TranslationTarget | null>(null);
  const list = versions.data?.versions ?? [];
  if (list.length === 0) return <>{children}</>;
  // Literal keys, one by one, so the translator keeps its narrow type.
  const names: Record<TranslationTarget, string> = { en: tt('names.en'), vi: tt('names.vi'), zh: tt('names.zh'), ja: tt('names.ja'), ko: tt('names.ko') };
  const active = shown === null ? null : (list.find((v) => v.language === shown) ?? null);
  return (
    <div className="space-y-2" data-testid="minutes-version-switch">
      <div role="group" aria-label={t('switchLabel')} className="flex flex-wrap items-center gap-1">
        <Button size="sm" variant={active === null ? 'default' : 'outline'} aria-pressed={active === null} onClick={() => setShown(null)}>
          {t('original')}
        </Button>
        {list.map((v) => (
          <Button key={v.language} size="sm" variant={active?.language === v.language ? 'default' : 'outline'} aria-pressed={active?.language === v.language} lang={langTag(v.language)} onClick={() => setShown(v.language)}>
            {names[v.language]}
          </Button>
        ))}
      </div>
      {active === null ? (
        children
      ) : (
        <div className="space-y-2">
          <VersionLines version={active} original={original} />
          <p className="text-xs text-muted-foreground">{t('note')}</p>
        </div>
      )}
    </div>
  );
}

// The recorder: review, edit and publish the translation of the shared minutes, or take a published one down.
export function MinutesVersionPublisher({ meetingId, original }: { meetingId: string; original: TranslationOriginal }) {
  const t = useTranslations('meetings.results.minutesVersion');
  const tt = useTranslations('meetings.translationTargets');
  const [open, setOpen] = useState(false);
  const [language, setLanguage] = useState<TranslationTarget | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const mine = useQuery({ ...orpc.meetings.translation.get.queryOptions({ input: { meetingId } }), staleTime: 60_000, refetchOnWindowFocus: false });
  const versions = useQuery({ ...orpc.meetings.minutesVersion.get.queryOptions({ input: { meetingId } }), staleTime: 0, refetchOnWindowFocus: false });
  // The translations of the shared stage the recorder has that are still of the text on screen.
  const ready = (mine.data?.translations ?? []).filter((x) => x.stage === 'published' && !x.stale);
  const chosen = ready.find((x) => x.to === language) ?? ready[0] ?? null;
  const source = useQuery({
    ...orpc.meetings.translation.source.queryOptions({ input: { meetingId, stage: 'published', ...(chosen ? { to: chosen.to } : {}) } }),
    enabled: open && chosen !== null,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const publish = useMutation({
    mutationFn: () => {
      if (!chosen || !source.data) throw new Error('not ready');
      return orpc.meetings.minutesVersion.publish.call({ meetingId, language: chosen.to, hash: source.data.hash, segments: publishable(original, draft) });
    },
    onSuccess: () => {
      refreshVersions();
      setOpen(false);
    },
  });
  const unpublish = useMutation({
    mutationFn: (to: TranslationTarget) => orpc.meetings.minutesVersion.unpublish.call({ meetingId, language: to }),
    onSuccess: refreshVersions,
  });
  const names: Record<TranslationTarget, string> = { en: tt('names.en'), vi: tt('names.vi'), zh: tt('names.zh'), ja: tt('names.ja'), ko: tt('names.ko') };
  const published = versions.data?.versions ?? [];
  const segments = segmentsOf(original);
  const chosenIsPublished = chosen !== null && published.some((v) => v.language === chosen.to);
  const start = () => {
    if (!chosen) return;
    publish.reset();
    setLanguage(chosen.to);
    setDraft(draftFrom(original, chosen.segments));
    setOpen(true);
  };
  const nothingToPublish = publishable(original, draft).length === 0;
  // Nothing to show to a recorder who has neither a translation to review nor a version to take down.
  if (published.length === 0 && ready.length === 0) return null;
  return (
    <div className="space-y-2 rounded-lg border p-3" data-testid="minutes-version-publisher">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{t('title')}</Badge>
        {published.map((v) => (
          <span key={v.language} className="inline-flex items-center gap-1 text-xs" lang={langTag(v.language)}>
            {names[v.language]}
            <Button size="sm" variant="outline" loading={unpublish.isPending && unpublish.variables === v.language} disabled={unpublish.isPending} aria-label={`${t('unpublish')}: ${names[v.language]}`} onClick={() => unpublish.mutate(v.language)}>
              {t('unpublish')}
            </Button>
          </span>
        ))}
      </div>
      {chosen && !open && (
        <Button size="sm" variant={chosenIsPublished ? 'outline' : 'default'} onClick={start}>
          {chosenIsPublished ? t('replace') : t('review')}
        </Button>
      )}
      {chosen && open && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">{t('reviewHint')}</p>
          {ready.length > 1 && (
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t('language')}>
              {ready.map((x) => (
                <Button key={x.to} size="sm" variant={chosen.to === x.to ? 'default' : 'outline'} aria-pressed={chosen.to === x.to} lang={langTag(x.to)} onClick={() => {
                  setLanguage(x.to);
                  setDraft(draftFrom(original, x.segments));
                }}>
                  {names[x.to]}
                </Button>
              ))}
            </div>
          )}
          <ol className="space-y-3">
            {segments.map(({ key, text }, i) => {
              const translated = chosen.segments.find((s) => s.key === key);
              return (
                <li key={key} className="space-y-1">
                  <p className="text-xs text-muted-foreground" id={`mv-orig-${key}`}>
                    <span className="sr-only">{t('originalOf', { n: String(i + 1) })}: </span>
                    {text}
                  </p>
                  <Textarea
                    aria-label={t('segment', { n: String(i + 1) })}
                    aria-describedby={`mv-orig-${key}`}
                    lang={langTag(chosen.to)}
                    value={draft[key] ?? ''}
                    maxLength={12000}
                    rows={key === 'summary' ? 5 : 2}
                    onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                  />
                  {translated?.state === 'refused' && <p className="text-xs text-muted-foreground">{t('refused')}</p>}
                  {translated !== undefined && translated.state !== 'refused' && translated.codes.length > 0 && <p className="text-xs text-warning">{t('mark')}</p>}
                </li>
              );
            })}
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" loading={publish.isPending} disabled={publish.isPending || nothingToPublish || !source.data} onClick={() => publish.mutate()}>
              {chosenIsPublished ? t('replace') : t('publish')}
            </Button>
            <Button size="sm" variant="outline" disabled={publish.isPending} onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
            {nothingToPublish && (
              <span className="text-xs text-muted-foreground" role="status">
                {t('empty')}
              </span>
            )}
          </div>
        </div>
      )}
      {publish.error && <ErrorText>{errorMessage(publish.error)}</ErrorText>}
      {unpublish.error && <ErrorText>{errorMessage(unpublish.error)}</ErrorText>}
      <div role="status" aria-live="polite" className="text-xs text-muted-foreground empty:hidden">
        {publish.isSuccess && !open ? t('published') : unpublish.isSuccess ? t('unpublished') : null}
      </div>
    </div>
  );
}
