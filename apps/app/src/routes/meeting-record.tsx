// SPDX-License-Identifier: AGPL-3.0-only
// Record a meeting in the app (AI Meeting Notes M7, #2581). The microphone, and the camera when "Ghi cả video" is ticked.
// Consent comes first: nothing is captured before the notice is confirmed and the meeting (which stores that confirmation)
// exists. The recording is written to this device as it goes (IndexedDB), so a reload or a closed tab loses at most the
// last few seconds, and it is uploaded when stopped through the same media route as a file upload. Since #3197 the recorder
// itself is the app-level controller (lib/recording-controller.ts): this screen is its form and its view, so moving to
// another screen does not stop the recording. Vy has no part on this screen: the recorder, the timer and the upload work with AI off.
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'use-intl';
import { MEETING_SUMMARY_TEMPLATES, type LiveConsentMethod, type MeetingLanguage, type BuiltInSummaryTemplate, type MeetingVisibility } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { ConfirmDialog } from '../components/confirm-dialog.tsx';
import { useMe } from '../components/conversation-inbox.tsx';
import { NotesSubnav } from '../components/notes-subnav.tsx';
import { useConsentPolicy } from '../components/consent-policy.tsx';
import { ImportAutoClaim } from '../components/meeting-import-claim.tsx';
import { RecordingNotice } from '../components/recording-notice.tsx';
import { ErrorText, PageHeader } from '../components/ui.tsx';
import { createIndexedDbChunkStore, formatClock, startBlocker, type ChunkStore, type RecordingMeta } from '@crove/meeting-recorder';
import {
  clearRecorderError,
  getRecorderSnapshot,
  isOwnRecording,
  pauseOrResume,
  recorderElapsedMs,
  startRecording,
  stop,
  subscribeRecorder,
  uploadRecording,
} from '../lib/recording-controller.ts';

// A recording whose meta was touched this recently is still being written, by another tab.
const LIVE_WITHIN_MS = 15_000;

export function MeetingRecordPage() {
  const t = useTranslations('meetings');
  const { slug } = useParams({ strict: false }) as { slug: string };
  const { userId } = useMe();
  const scope = userId ? `${slug}:${userId}` : null;

  // The recorder is app-level: this is only its view. It keeps recording when this screen is left.
  const recorder = useSyncExternalStore(subscribeRecorder, getRecorderSnapshot, getRecorderSnapshot);
  const phase = recorder.phase;
  // A booking opens this screen with its title, contact and calendar event (L1, #2587); the meeting is linked to them once it is created.
  const prefill = useSearch({ strict: false }) as { title?: string; partyId?: string; calendarEventId?: string; agendaId?: string };
  const [title, setTitle] = useState(prefill.title ?? '');
  const [language, setLanguage] = useState<MeetingLanguage>('vi');
  const [visibility, setVisibility] = useState<MeetingVisibility>('attendees');
  // The minutes template (A4, #3162): the general summary unless the recorder picks another; changeable later on the meeting's page.
  const [summaryTemplate, setSummaryTemplate] = useState<BuiltInSummaryTemplate>('general');
  const [withVideo, setWithVideo] = useState(false);
  // Off at every visit and never remembered: ticked for one recording only.
  const [liveNotes, setLiveNotes] = useState(false);
  const [consentMethod, setConsentMethod] = useState<LiveConsentMethod | ''>('');
  // A strict org accepts only a written method (A2, #3160): the unwritten one is not offered, and a choice made before the policy loaded is dropped.
  const consentPolicy = useConsentPolicy();
  useEffect(() => {
    if (consentPolicy === 'strict' && consentMethod === 'told_at_start') setConsentMethod('');
  }, [consentPolicy, consentMethod]);
  const [consentAgreed, setConsentAgreed] = useState(false);
  // A refusal from this screen's own checks; the recorder's own messages come with its snapshot.
  const [formError, setFormError] = useState<string | null>(null);
  const error = formError ?? recorder.error;
  const [elapsed, setElapsed] = useState(0);
  const [recoverable, setRecoverable] = useState<RecordingMeta[]>([]);
  const busyId = recorder.busyId;

  const store = useMemo<ChunkStore | null>(() => {
    try {
      return typeof indexedDB === 'undefined' ? null : createIndexedDbChunkStore();
    } catch {
      return null;
    }
  }, []);
  const unmounted = useRef(false);
  useEffect(() => {
    unmounted.current = false;
    // A message from an earlier recording (stopped early, upload failed) was shown when it happened; it does not wait here for the next visit.
    if (getRecorderSnapshot().phase === 'idle') clearRecorderError();
    return () => {
      unmounted.current = true;
    };
  }, []);

  const refreshRecoverable = async () => {
    if (!store || !scope) return;
    const metas = await store.list(scope).catch(() => []);
    if (!unmounted.current) setRecoverable(metas.filter((m) => isOwnRecording(m.id) || Date.now() - m.updatedAt > LIVE_WITHIN_MS));
  };

  useEffect(() => {
    void refreshRecoverable();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, scope]);

  // A recording another tab (or the page before a reload) was writing is offered once its heartbeat is stale, so look again while idle.
  useEffect(() => {
    if (phase !== 'idle') return;
    const poll = setInterval(() => void refreshRecoverable(), 5000);
    return () => clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, store, scope]);

  // An upload that finished (or failed) leaves the copy on the device or clears it: read the list again.
  useEffect(() => {
    if (phase === 'idle' && busyId === null) void refreshRecoverable();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, busyId]);

  // The timer on screen; the clock itself is exact (it lives in the controller), this only repaints it.
  useEffect(() => {
    if (phase !== 'recording') {
      setElapsed(recorderElapsedMs());
      return;
    }
    const timer = setInterval(() => setElapsed(recorderElapsedMs()), 500);
    return () => clearInterval(timer);
  }, [phase]);

  const blocker = startBlocker({ title, consentMethod, consentAgreed });
  const unsupported = typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia || !store;

  const start = async () => {
    setFormError(null);
    clearRecorderError();
    // The gate: the button is disabled without these, and the handler checks again.
    if (blocker !== null) {
      setFormError(t(blocker === 'title' ? 'form.titleRequired' : blocker === 'consentMethod' ? 'form.consentMethodRequired' : 'form.consentRequired'));
      return;
    }
    if (unsupported || !store || !scope) {
      setFormError(t('record.unsupported'));
      return;
    }
    await startRecording({
      store,
      scope,
      slug,
      title,
      language,
      visibility,
      summaryTemplate,
      withVideo,
      liveNotes,
      consentMethod: consentMethod as LiveConsentMethod,
      prefill,
    });
  };

  // The preview of a recording with video; it is the recorder's own stream, so it also shows when the member comes back to this screen.
  const previewRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (previewRef.current) previewRef.current.srcObject = recorder.stream;
  }, [recorder.stream, phase]);

  const uploadAndClear = async (meta: RecordingMeta): Promise<void> => {
    if (!store) return;
    setFormError(null);
    clearRecorderError();
    await uploadRecording(store, slug, meta);
    if (!unmounted.current) void refreshRecoverable();
  };

  const discard = async (meta: RecordingMeta) => {
    if (!store) return;
    await store.remove(meta.id);
    await refreshRecoverable();
  };

  const recording = phase === 'recording' || phase === 'paused';
  const startDisabled = blocker !== null || unsupported || phase !== 'idle';

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('record.title')}
        subtitle={t('record.subtitle')}
        actions={
          <Link to="/o/$slug/meetings" params={{ slug }} className="text-sm text-muted-foreground hover:text-foreground">
            {t('detail.back')}
          </Link>
        }
      />
      <NotesSubnav slug={slug} active="meetings" />
      {/* An import the member started (C1, #3173): its copied audio is claimed here too */}
      <ImportAutoClaim />

      {error && <ErrorText>{error}</ErrorText>}
      {unsupported && <ErrorText>{t('record.unsupported')}</ErrorText>}

      {recoverable.length > 0 && phase === 'idle' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">{t('record.recoverTitle')}</CardTitle>
            <CardDescription>{t('record.recoverHint')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {recoverable.map((meta) => (
              <div key={meta.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-border p-3 text-sm">
                <div>
                  <div className="font-medium">{meta.title}</div>
                  <div className="text-xs text-muted-foreground">{t('record.recoverLength', { length: formatClock(meta.elapsedMs) })}</div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => void uploadAndClear(meta)} disabled={busyId !== null} loading={busyId === meta.id}>
                    {t('record.recoverUpload')}
                  </Button>
                  <ConfirmDialog
                    render={<Button size="sm" variant="outline" disabled={busyId !== null} />}
                    title={t('record.discardTitle')}
                    description={t('record.discardBody')}
                    confirm={t('record.discardConfirm')}
                    destructive
                    onConfirm={() => void discard(meta)}
                  >
                    {t('record.discard')}
                  </ConfirmDialog>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {recording || phase === 'uploading' || phase === 'starting' ? (
        <Card>
          <CardContent className="space-y-4 pt-6">
            <div className="flex items-center gap-3" role="status" aria-live="polite">
              <span className={`inline-block size-3 rounded-full ${phase === 'recording' ? 'animate-pulse bg-destructive' : 'bg-muted-foreground'}`} aria-hidden="true" />
              <span className="text-sm font-medium">
                {phase === 'recording' ? t('record.recording') : phase === 'paused' ? t('record.paused') : phase === 'starting' ? t('record.starting') : t('record.uploading')}
              </span>
              <span className="font-mono text-2xl tabular-nums" aria-label={t('record.timer')}>{formatClock(phase === 'starting' ? 0 : elapsed)}</span>
            </div>
            {recorder.withVideo && <video ref={previewRef} autoPlay muted playsInline className="aspect-video w-full max-w-md rounded bg-muted" />}
            <p className="text-xs text-muted-foreground">{t('record.keepScreenOn')}</p>
            <p className="text-xs text-muted-foreground">{t('record.keepsGoing')}</p>
            {recording && (
              <div className="flex gap-2">
                <Button variant="outline" onClick={pauseOrResume}>
                  {phase === 'paused' ? t('record.resume') : t('record.pause')}
                </Button>
                <Button variant="destructive" onClick={stop}>
                  {t('record.stop')}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="space-y-4 pt-6">
            <div className="space-y-1">
              <Label htmlFor="record-title">{t('form.title')}</Label>
              <Input id="record-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('form.titlePlaceholder')} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="record-lang">{t('form.language')}</Label>
                <NativeSelect id="record-lang" value={language} onChange={(e) => setLanguage(e.target.value as MeetingLanguage)}>
                  <NativeSelectOption value="vi">{t('form.langVi')}</NativeSelectOption>
                  <NativeSelectOption value="en">{t('form.langEn')}</NativeSelectOption>
                </NativeSelect>
              </div>
              <div className="space-y-1">
                <Label htmlFor="record-vis">{t('form.visibility')}</Label>
                <NativeSelect id="record-vis" value={visibility} onChange={(e) => setVisibility(e.target.value as MeetingVisibility)}>
                  <NativeSelectOption value="attendees">{t('form.visibilityAttendees')}</NativeSelectOption>
                  <NativeSelectOption value="org">{t('form.visibilityOrg')}</NativeSelectOption>
                </NativeSelect>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="record-template">{t('templates.label')}</Label>
              <NativeSelect id="record-template" value={summaryTemplate} onChange={(e) => setSummaryTemplate(e.target.value as BuiltInSummaryTemplate)}>
                {MEETING_SUMMARY_TEMPLATES.map((code) => (
                  <NativeSelectOption key={code} value={code}>
                    {t(`templates.names.${code}`)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox id="record-video" checked={withVideo} onCheckedChange={(c) => setWithVideo(Boolean(c))} />
              <Label htmlFor="record-video" className="cursor-pointer">{t('record.withVideo')}</Label>
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Checkbox id="record-live-notes" checked={liveNotes} onCheckedChange={(c) => setLiveNotes(Boolean(c))} />
                <Label htmlFor="record-live-notes" className="cursor-pointer">{t('record.liveNotes')}</Label>
              </div>
              <p className="pl-6 text-xs text-muted-foreground">{t('record.liveNotesHint')}</p>
            </div>
            <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
              <div className="text-sm font-semibold">{t('form.consentSectionTitle')}</div>
              <p className="text-xs text-muted-foreground">{t('form.consentNotice')}</p>
              <RecordingNotice meetingLanguage={language} />
              <div className="space-y-1">
                <Label htmlFor="record-consent-method" className="text-xs">{t('form.consentMethod')}</Label>
                <NativeSelect id="record-consent-method" value={consentMethod} onChange={(e) => setConsentMethod(e.target.value as LiveConsentMethod)} required>
                  <NativeSelectOption value="" disabled>{t('form.selectConsentMethod')}</NativeSelectOption>
                  {consentPolicy === 'standard' && <NativeSelectOption value="told_at_start">{t('form.toldAtStart')}</NativeSelectOption>}
                  <NativeSelectOption value="in_invite">{t('form.inInvite')}</NativeSelectOption>
                  <NativeSelectOption value="in_writing">{t('form.inWriting')}</NativeSelectOption>
                  <NativeSelectOption value="in_call_chat">{t('form.inCallChat')}</NativeSelectOption>
                </NativeSelect>
                {consentPolicy === 'strict' && <p className="text-xs text-muted-foreground" data-testid="consent-strict-note">{t('consentPolicy.strictNote')}</p>}
              </div>
              <div className="flex items-start gap-2 pt-1">
                <Checkbox id="record-consent-agreed" checked={consentAgreed} onCheckedChange={(c) => setConsentAgreed(Boolean(c))} />
                <Label htmlFor="record-consent-agreed" className="cursor-pointer text-xs font-medium leading-snug">{t('form.consentConfirmCheckbox')}</Label>
              </div>
            </div>
            <Button onClick={() => void start()} disabled={startDisabled}>
              {t('record.start')}
            </Button>
            <p className="text-xs text-muted-foreground">{t('record.hint')}</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
