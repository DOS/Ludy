// SPDX-License-Identifier: AGPL-3.0-only
// "Bản ghi có sẵn trên nền tảng" on the Meetings tab (meetings integrations C1, #3173): the recordings the member's meeting platforms finished, each with what it offers and what can be done
// with it by its state, and the "Nhập" dialog. Importing is a person's click with one consent tick (the platform showed its own recording notice); Ludy copies only the audio, never deletes the
// platform's copy and transcribes the audio itself. The core works with AI off, and Ludy never joins or records a call. The list is the member's alone (the server's row security).
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { IMPORT_CONSENT_NOTICE_VERSION, MEETING_SUMMARY_TEMPLATES, type MeetingLanguage, type MeetingPlatformRecordingView, type BuiltInSummaryTemplate, type MeetingVisibility } from '@crove/kernel-contract';
import { IMPORT_NOTICE, noticeLanguageFor } from '@crove/meeting-recorder';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@crove/ui/components/dialog';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { canRetry, canSubmitImport, errorKey, importBlock, isTranscriptImport, lengthParts, pollMs } from '../lib/meeting-platform.ts';
import { formatBytes } from '../lib/offboarding.ts';
import { toast } from '../lib/toast.ts';
import { useConsentPolicy } from './consent-policy.tsx';
import { meetingsInstalled } from './linked-meetings.tsx';
import { ErrorText, RowsSkeleton } from './ui.tsx';

// The member's recordings, read again every 5 seconds while one is being downloaded, received or sealed and every minute otherwise. react-query does not poll in a hidden tab, so a tab nobody
// looks at asks nothing. The card and the claim of the copied audio share this one query.
export function useMeetingPlatformRecordings(enabled: boolean) {
  return useQuery({ ...orpc.meetingPlatform.recordings.queryOptions(), enabled, refetchInterval: (query) => pollMs(query.state.data) });
}

const refreshRecordings = () => Promise.all([queryClient.invalidateQueries({ queryKey: orpc.meetingPlatform.recordings.key() }), queryClient.invalidateQueries({ queryKey: orpc.meetings.list.key() })]);

// The body of the import dialog: the title, the language, who reads it, the minutes template, the notice of the active language and the one consent tick the submit waits for.
export function ImportForm({ recording, onDone, onCancel }: { recording: MeetingPlatformRecordingView; onDone: () => void; onCancel: () => void }) {
  const t = useTranslations('meetings.platform.dialog');
  const tm = useTranslations('meetings');
  const tp = useTranslations('meetings.platform');
  const locale = useLocale();
  // A recording with only the platform's own transcript (C2, #3174): its lines are copied, no audio, and it says whose transcription it is.
  const transcriptOnly = isTranscriptImport(recording);
  const platform = tp(`provider.${recording.provider}`);
  const policy = useConsentPolicy();
  const strict = policy === 'strict';
  const [title, setTitle] = useState(recording.title);
  const [language, setLanguage] = useState<MeetingLanguage>('vi');
  const [visibility, setVisibility] = useState<MeetingVisibility>('attendees');
  const [template, setTemplate] = useState<BuiltInSummaryTemplate>('general');
  const [ticked, setTicked] = useState(false);
  const start = useMutation({
    mutationFn: () =>
      orpc.meetings.importStart.call({
        recordingId: recording.id,
        title: title.trim(),
        language,
        visibility,
        summaryTemplate: template,
        consentMethod: 'platform_notice',
        consentNoticeVersion: IMPORT_CONSENT_NOTICE_VERSION,
        consentConfirmed: true,
      }),
    onSuccess: async () => {
      toast(t('started'), 'success');
      await refreshRecordings();
      onDone();
    },
  });
  const can = canSubmitImport({ consentTicked: ticked, title, strict, pending: start.isPending });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (can) start.mutate();
  };
  // A strict org refuses this method (CONSENT_METHOD_NOT_ALLOWED); the general wording of that code talks about the live recording, so this dialog says its own.
  const refused = start.error && (start.error as { code?: string }).code === 'CONSENT_METHOD_NOT_ALLOWED';
  const notice = IMPORT_NOTICE.text[noticeLanguageFor(locale)];
  return (
    <form onSubmit={submit} className="space-y-4" data-testid="meeting-import-form">
      <div className="space-y-1">
        <Label htmlFor="import-title">{t('titleLabel')}</Label>
        <Input id="import-title" value={title} maxLength={200} required onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <Label htmlFor="import-lang">{tm('form.language')}</Label>
          <NativeSelect id="import-lang" value={language} onChange={(e) => setLanguage(e.target.value as MeetingLanguage)}>
            <NativeSelectOption value="vi">{tm('form.langVi')}</NativeSelectOption>
            <NativeSelectOption value="en">{tm('form.langEn')}</NativeSelectOption>
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor="import-vis">{tm('form.visibility')}</Label>
          <NativeSelect id="import-vis" value={visibility} onChange={(e) => setVisibility(e.target.value as MeetingVisibility)}>
            <NativeSelectOption value="attendees">{tm('form.visibilityAttendees')}</NativeSelectOption>
            <NativeSelectOption value="org">{tm('form.visibilityOrg')}</NativeSelectOption>
          </NativeSelect>
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="import-template">{tm('templates.label')}</Label>
        <NativeSelect id="import-template" value={template} onChange={(e) => setTemplate(e.target.value as BuiltInSummaryTemplate)}>
          {MEETING_SUMMARY_TEMPLATES.map((code) => (
            <NativeSelectOption key={code} value={code}>
              {tm(`templates.names.${code}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground" data-testid="meeting-import-terms">
        <li>{transcriptOnly ? t('copyTranscript', { platform }) : t(recording.provider === 'microsoft_teams' ? 'teamsVideo' : 'copyAudio')}</li>
        <li>{t('keepOriginal')}</li>
        <li>{t('noParticipants')}</li>
        <li>{transcriptOnly ? t('platformTranscript', { platform }) : t('ownTranscript')}</li>
        {recording.provider === 'microsoft_teams' && !transcriptOnly && <li data-testid="meeting-import-cost">{t('teamsCost')}</li>}
      </ul>
      <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
        <div className="text-xs font-medium text-foreground">{t('noticeHeading')}</div>
        <p lang={noticeLanguageFor(locale)} className="rounded bg-muted/60 p-2 text-xs italic text-foreground" data-testid="meeting-import-notice">
          {notice}
        </p>
        <p className="text-xs text-muted-foreground">{t('noticeDraft')}</p>
        <div className="flex items-start gap-2 pt-1">
          <Checkbox id="import-consent" checked={ticked} disabled={strict} onCheckedChange={(c) => setTicked(Boolean(c))} />
          <Label htmlFor="import-consent" className="cursor-pointer text-xs font-medium leading-snug text-foreground">
            {t('consent')}
          </Label>
        </div>
      </div>
      {strict && (
        <p className="text-xs text-destructive" role="alert" data-testid="meeting-import-strict">
          {t('strict')}
        </p>
      )}
      {start.error && <ErrorText>{refused ? t('strict') : errorMessage(start.error)}</ErrorText>}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={start.isPending} onClick={onCancel}>
          {t('cancel')}
        </Button>
        <Button type="submit" disabled={!can} loading={start.isPending} data-testid="meeting-import-submit">
          {t('submit')}
        </Button>
      </DialogFooter>
    </form>
  );
}

function ImportDialog({ recording, onClose }: { recording: MeetingPlatformRecordingView | null; onClose: () => void }) {
  const t = useTranslations('meetings.platform.dialog');
  return (
    <Dialog open={recording !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{recording && isTranscriptImport(recording) ? t('descTranscript') : t('desc')}</DialogDescription>
        </DialogHeader>
        {recording && <ImportForm key={recording.id} recording={recording} onDone={onClose} onCancel={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function offers(row: MeetingPlatformRecordingView, words: { audio: string; video: string; transcript: string; nothing: string }): string {
  const items = [row.hasAudio && words.audio, row.hasVideo && words.video, row.hasTranscript && words.transcript].filter((x): x is string => typeof x === 'string');
  return items.length > 0 ? items.join(', ') : words.nothing;
}

function RecordingRow({ row, slug, canImport, onImport }: { row: MeetingPlatformRecordingView; slug: string; canImport: boolean; onImport: (row: MeetingPlatformRecordingView) => void }) {
  const t = useTranslations('meetings.platform.recordings');
  const tp = useTranslations('meetings.platform');
  const f = useFormat();
  // A failed try may have left an empty meeting in the member's list: it is removed after the dismissal, by the same rule as a retry (own, never edited, holding nothing). The clean-up is best effort,
  // so a failure of it never undoes the dismissal; the meeting list is read again either way.
  const dismiss = useMutation({
    mutationFn: async () => {
      const done = await orpc.meetingPlatform.dismiss.call({ recordingId: row.id });
      // Only a failed try can have made a meeting: dismissing a plain suggestion has nothing to clean.
      if (row.status === 'failed') await orpc.meetings.importDiscardEmpty.call({ recordingId: row.id }).catch(() => undefined);
      return done;
    },
    onSuccess: () => refreshRecordings(),
  });
  const title = row.title === '' ? t('untitled') : row.title;
  const block = importBlock(row);
  const length = row.lengthSeconds === null ? null : lengthParts(row.lengthSeconds);
  const lengthText = length === null ? null : length.hours > 0 ? t('lengthHours', length) : length.minutes > 0 ? t('lengthMinutes', { minutes: length.minutes }) : t('lengthShort');
  const quiet = (label: string, of: string) => (
    <Button type="button" size="sm" variant="ghost" disabled={dismiss.isPending} aria-label={of} onClick={() => dismiss.mutate()}>
      {label}
    </Button>
  );
  return (
    <li className="space-y-2 p-3 text-sm" data-testid="meeting-recording" data-status={row.status}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 break-words font-medium text-foreground">{title}</span>
            <Badge variant="outline">{tp(`provider.${row.provider}`)}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {[f.dateTime(row.startedAt), lengthText, row.sizeBytes === null ? null : formatBytes(row.sizeBytes, f.number)].filter((x) => x !== null).join(' · ')}
          </p>
          {!row.hasAudio && row.hasVideo && row.videoImportMaxBytes !== null && (
            <p className="text-xs text-subtle-foreground" data-testid="meeting-recording-video-note">
              {t('videoKeepsAudio')}
            </p>
          )}
          {isTranscriptImport(row) && (
            <p className="text-xs text-subtle-foreground" data-testid="meeting-recording-transcript-note">
              {t('transcriptKeepsText', { platform: tp(`provider.${row.provider}`) })}
            </p>
          )}
          <p className="text-xs text-subtle-foreground">{t('offers', { items: offers(row, { audio: t('offerAudio'), video: t('offerVideo'), transcript: t('offerTranscript'), nothing: t('offerNothing') }) })}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {row.status === 'suggested' && block === null && (
            <>
              {canImport ? (
                <Button type="button" size="sm" aria-label={t('importOf', { title })} data-testid="meeting-recording-import" onClick={() => onImport(row)}>
                  {t('import')}
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground" data-testid="meeting-recording-viewer">
                  {t('viewerOnly')}
                </span>
              )}
              {quiet(t('dismiss'), t('dismissOf', { title }))}
            </>
          )}
          {row.status === 'suggested' && block !== null && (
            <>
              <span className="text-xs text-muted-foreground" data-testid="meeting-recording-blocked">
                {block === 'video_only' ? t('videoOnly') : block === 'transcript_only' ? t('transcriptOnly') : block === 'too_long' ? t('tooLong') : t('tooLarge')}
              </span>
              {quiet(t('dismiss'), t('dismissOf', { title }))}
            </>
          )}
          {row.status === 'importing' && (
            <span className="text-xs text-muted-foreground" role="status">
              {t('importing')}
            </span>
          )}
          {(row.status === 'staged' || row.status === 'claimed') && (
            <span className="text-xs text-muted-foreground" role="status">
              {t('processing')}
            </span>
          )}
          {row.status === 'imported' && row.meetingId && (
            <Link to="/o/$slug/meetings/$id" params={{ slug, id: row.meetingId }} className="text-xs font-medium underline" data-testid="meeting-recording-open">
              {t('imported')}
            </Link>
          )}
          {row.status === 'failed' && (
            <>
              {row.errorCode === 'connection_expired' && (
                <Link to="/o/$slug/settings/security" params={{ slug }} hash="meeting-platforms" className="text-xs font-medium underline">
                  {tp('settings.title')}
                </Link>
              )}
              {canImport && canRetry(row) && (
                <Button type="button" size="sm" variant="outline" aria-label={t('importOf', { title })} data-testid="meeting-recording-retry" onClick={() => onImport(row)}>
                  {t('retry')}
                </Button>
              )}
              {quiet(t('dismiss'), t('dismissOf', { title }))}
            </>
          )}
        </div>
      </div>
      {row.status === 'importing' && <p className="text-xs text-muted-foreground">{t('importingHint')}</p>}
      {row.status === 'staged' && <p className="text-xs text-muted-foreground">{t('stagedHint')}</p>}
      {row.status === 'failed' && (
        <p className="text-xs text-destructive" data-testid="meeting-recording-error">
          {t('failed', { reason: tp(`errors.${errorKey(row.errorCode)}`) })}
        </p>
      )}
      {dismiss.error && <ErrorText>{errorMessage(dismiss.error)}</ErrorText>}
    </li>
  );
}

export function PlatformRecordings({ slug }: { slug: string }) {
  const t = useTranslations('meetings.platform.recordings');
  const on = meetingsInstalled();
  const recordings = useMeetingPlatformRecordings(on);
  const connections = useQuery({ ...orpc.meetingPlatform.connections.queryOptions(), enabled: on });
  // A member demoted to viewer after connecting still sees their own list (the server lets a viewer read and dismiss), but the import itself is a meeting the viewer may not create: no "Nhập" until the role is known to allow it.
  const org = useQuery({ ...orpc.org.get.queryOptions(), enabled: on });
  const canImport = org.data !== undefined && org.data.role !== 'viewer';
  const [target, setTarget] = useState<MeetingPlatformRecordingView | null>(null);
  if (!on) return null;
  const rows = recordings.data ?? [];
  const hasConnection = (connections.data?.length ?? 0) > 0;
  // Nothing connected and nothing listed: the card stays out of the way.
  if (!hasConnection && rows.length === 0 && !recordings.error) return null;
  return (
    <section className="space-y-2" aria-labelledby="meeting-recordings-title" data-testid="meeting-recordings">
      <h2 id="meeting-recordings-title" className="text-sm font-semibold">
        {t('title')}
      </h2>
      <p className="text-xs text-muted-foreground">{t('hint')}</p>
      {recordings.isPending && !recordings.error && (
        <div data-testid="meeting-recordings-loading" aria-label={t('loading')}>
          <RowsSkeleton rows={2} />
        </div>
      )}
      {recordings.error && <ErrorText>{errorMessage(recordings.error)}</ErrorText>}
      {recordings.data && rows.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="meeting-recordings-empty">
          {t('none')}
        </p>
      )}
      {rows.length > 0 && (
        <ul className="divide-y rounded-lg border border-border bg-card">
          {rows.map((row) => (
            <RecordingRow key={row.id} row={row} slug={slug} canImport={canImport} onImport={setTarget} />
          ))}
        </ul>
      )}
      <ImportDialog recording={target} onClose={() => setTarget(null)} />
    </section>
  );
}
