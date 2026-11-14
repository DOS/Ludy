// SPDX-License-Identifier: AGPL-3.0-only
// Record a meeting in the app (AI Meeting Notes M7, #2581). The microphone, and the camera when "Ghi cả video" is ticked.
// Consent comes first: nothing is captured before the notice is confirmed and the meeting (which stores that confirmation)
// exists. The recording is written to this device as it goes (IndexedDB), so a reload or a closed tab loses at most the
// last few seconds, and it is uploaded when stopped through the same media route as a file upload. Vy has no part on this
// screen: the recorder, the timer and the upload work with AI off.
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { ConsentMethod, MeetingLanguage, MeetingVisibility } from '@crove/kernel-contract';
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
import { RecordingNotice } from '../components/recording-notice.tsx';
import { ErrorText, PageHeader } from '../components/ui.tsx';
import { errorMessage, orpc, queryClient, sendLiveChunk, uploadMeetingMedia } from '../lib/api.ts';
import {
  assembleRecording,
  beginRecording,
  prepareCapture,
  createBrowserLiveRecorder,
  createClock,
  createIndexedDbChunkStore,
  formatClock,
  pickRecorderMime,
  RECORDING_NOTICE,
  startBlocker,
  startLiveCapture,
  stopReasonForUpload,
  uploadAfterLive,
  type ChunkStore,
  type LiveCapture,
  type RecordingKind,
  type RecordingMeta,
  type RecordingWriter,
} from '@crove/meeting-recorder';
import { setLocalRecording } from '../lib/recording-indicator.ts';
import { toast } from '../lib/toast.ts';

// A recording whose meta was touched this recently is still being written, by another tab.
const LIVE_WITHIN_MS = 15_000;

type Phase = 'setup' | 'recording' | 'paused' | 'uploading';

// Everything a running recording holds; one object so cleanup stops all of it.
interface Live {
  stream: MediaStream;
  recorder: MediaRecorder;
  writer: RecordingWriter;
  pending: Set<Promise<void>>;
  wakeLock: { release(): Promise<void> } | null;
  failed: boolean;
  // The audio-only recorder that sends pieces to the server when live notes were ticked (ADR-0052 L4a); null otherwise.
  liveCapture: LiveCapture | null;
}

type WakeLockApi = { request(type: 'screen'): Promise<{ release(): Promise<void> }> };
const requestWakeLock = async (): Promise<{ release(): Promise<void> } | null> =>
  (await (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock?.request('screen').catch(() => null)) ?? null;

export function MeetingRecordPage() {
  const t = useTranslations('meetings');
  const navigate = useNavigate();
  const { slug } = useParams({ strict: false }) as { slug: string };
  const { userId } = useMe();
  const scope = userId ? `${slug}:${userId}` : null;

  const [phase, setPhase] = useState<Phase>('setup');
  // A booking opens this screen with its title, contact and calendar event (L1, #2587); the meeting is linked to them once it is created.
  const prefill = useSearch({ strict: false }) as { title?: string; partyId?: string; calendarEventId?: string };
  const [title, setTitle] = useState(prefill.title ?? '');
  const [language, setLanguage] = useState<MeetingLanguage>('vi');
  const [visibility, setVisibility] = useState<MeetingVisibility>('attendees');
  const [withVideo, setWithVideo] = useState(false);
  // Off at every visit and never remembered: ticked for one recording only.
  const [liveNotes, setLiveNotes] = useState(false);
  const [consentMethod, setConsentMethod] = useState<ConsentMethod | ''>('');
  // A strict org accepts only a written method (A2, #3160): the unwritten one is not offered, and a choice made before the policy loaded is dropped.
  const consentPolicy = useConsentPolicy();
  useEffect(() => {
    if (consentPolicy === 'strict' && consentMethod === 'told_at_start') setConsentMethod('');
  }, [consentPolicy, consentMethod]);
  const [consentAgreed, setConsentAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [recoverable, setRecoverable] = useState<RecordingMeta[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const store = useMemo<ChunkStore | null>(() => {
    try {
      return typeof indexedDB === 'undefined' ? null : createIndexedDbChunkStore();
    } catch {
      return null;
    }
  }, []);
  const clock = useRef(createClock());
  const live = useRef<Live | null>(null);
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const unmounted = useRef(false);
  // The meeting created for this screen, reused if a later local step fails, so a retry makes no second meeting.
  const createdMeetingId = useRef<string | null>(null);
  // The links of a booking are set once per created meeting; a failed link never blocks the recording (the recorder can link on the meeting page).
  const linkedMeetingId = useRef<string | null>(null);
  // Recordings this tab wrote: shown in the recovery list at once; another tab's only once its heartbeat is stale.
  const ownIds = useRef(new Set<string>());

  const refreshRecoverable = async () => {
    if (!store || !scope) return;
    const metas = await store.list(scope).catch(() => []);
    if (!unmounted.current) setRecoverable(metas.filter((m) => ownIds.current.has(m.id) || Date.now() - m.updatedAt > LIVE_WITHIN_MS));
  };

  useEffect(() => {
    void refreshRecoverable();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, scope]);

  // A recording another tab (or the page before a reload) was writing is offered once its heartbeat is stale, so look again while idle.
  useEffect(() => {
    if (phase !== 'setup') return;
    const poll = setInterval(() => void refreshRecoverable(), 5000);
    return () => clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, store, scope]);

  // The timer on screen; the clock itself is exact, this only repaints it.
  useEffect(() => {
    if (phase !== 'recording') return;
    const timer = setInterval(() => setElapsed(clock.current.elapsedMs(Date.now())), 500);
    return () => clearInterval(timer);
  }, [phase]);

  // While recording or paused, the meta is touched every few seconds so another tab can tell this one is live (a pause writes no chunk).
  useEffect(() => {
    if (phase !== 'recording' && phase !== 'paused') return;
    const beat = setInterval(() => void live.current?.writer.touch(clock.current.elapsedMs(Date.now())).catch(() => undefined), 5000);
    return () => clearInterval(beat);
  }, [phase]);

  // The header chip "Đang ghi 12:31" (A1, #3159): published while this screen records or is paused, withdrawn the moment it stops
  // or the screen is left (leaving stops the devices, see below).
  useEffect(() => {
    const l = live.current;
    if ((phase !== 'recording' && phase !== 'paused') || !l) {
      setLocalRecording(null);
      return;
    }
    setLocalRecording({ meetingId: l.writer.meta().meetingId, title: title.trim(), paused: phase === 'paused', elapsedMs: () => clock.current.elapsedMs(Date.now()) });
    return () => setLocalRecording(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // The browser drops the wake lock when the tab is hidden: take it again when the tab is back.
  useEffect(() => {
    const again = () => {
      const l = live.current;
      if (document.visibilityState !== 'visible' || !l || l.recorder.state === 'inactive') return;
      void requestWakeLock().then((lock) => {
        if (lock && live.current === l) l.wakeLock = lock;
        else void lock?.release().catch(() => undefined);
      });
    };
    document.addEventListener('visibilitychange', again);
    return () => document.removeEventListener('visibilitychange', again);
  }, []);

  // Leaving the screen mid-recording stops the devices; what was saved stays on the device and is offered again.
  useEffect(() => {
    unmounted.current = false;
    const flush = () => {
      const l = live.current;
      if (l && l.recorder.state === 'recording') l.recorder.requestData();
    };
    window.addEventListener('pagehide', flush);
    return () => {
      unmounted.current = true;
      window.removeEventListener('pagehide', flush);
      // A1 (#3159): leaving the screen stops the recording; say so on the saved copy, so its later upload tells the meeting why.
      void live.current?.writer.markStopped('left_screen');
      releaseDevices(live.current, true);
    };
  }, []);

  const kind: RecordingKind = withVideo ? 'video' : 'audio';
  const blocker = startBlocker({ title, consentMethod, consentAgreed });
  const unsupported = typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia || !store;

  const releaseDevices = (l: Live | null, stopRecorder: boolean) => {
    if (!l) return;
    if (stopRecorder) l.liveCapture?.abandon();
    if (stopRecorder && l.recorder.state !== 'inactive') {
      try {
        l.recorder.stop();
      } catch {
        // already stopped
      }
    }
    for (const track of l.stream.getTracks()) track.stop();
    void l.wakeLock?.release().catch(() => undefined);
    if (live.current === l) live.current = null;
  };

  const start = async () => {
    setError(null);
    // The gate: the button is disabled without these, and the handler checks again.
    if (blocker !== null) {
      setError(t(blocker === 'title' ? 'form.titleRequired' : blocker === 'consentMethod' ? 'form.consentMethodRequired' : 'form.consentRequired'));
      return;
    }
    if (unsupported || !store || !scope) {
      setError(t('record.unsupported'));
      return;
    }
    const result = await prepareCapture<MediaStream, MediaRecorder>({
      openStore: async () => void (await store.list(scope)),
      getStream: () =>
        navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
          video: withVideo ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
        }),
      createMeeting: async () => {
        // The meeting row stores who confirmed the notice and how; the server refuses media for a meeting without it.
        createdMeetingId.current ??= (await orpc.meetings.create.call({ title: title.trim(), language, visibility, keepVideo: withVideo, consentMethod: consentMethod as ConsentMethod, consentNoticeVersion: RECORDING_NOTICE.version, liveNotes })).meetingId;
        const meetingId = createdMeetingId.current;
        if (linkedMeetingId.current !== meetingId) {
          linkedMeetingId.current = meetingId;
          const targets = [
            ...(prefill.partyId ? [{ kind: 'party' as const, targetId: prefill.partyId }] : []),
            ...(prefill.calendarEventId ? [{ kind: 'calendar_event' as const, targetId: prefill.calendarEventId }] : []),
          ];
          const results = await Promise.allSettled(targets.map((target) => orpc.meetings.links.add.call({ meetingId, ...target })));
          if (results.some((r) => r.status === 'rejected')) toast(t('links.prefillFailed'), 'error');
        }
        return meetingId;
      },
      makeRecorder: (stream) => {
        const mimeType = pickRecorderMime((type) => MediaRecorder.isTypeSupported(type), kind);
        return new MediaRecorder(stream, {
          ...(mimeType ? { mimeType } : {}),
          audioBitsPerSecond: 64_000,
          ...(withVideo ? { videoBitsPerSecond: 1_500_000 } : {}),
        });
      },
      begin: async (meetingId, recorder) => {
        const mimeType = pickRecorderMime((type) => MediaRecorder.isTypeSupported(type), kind);
        const writer = await beginRecording(store, {
          id: crypto.randomUUID(),
          scope,
          meetingId,
          title: title.trim(),
          kind,
          mimeType: recorder.mimeType || mimeType || (withVideo ? 'video/webm' : 'audio/webm'),
          startedAt: Date.now(),
        });
        ownIds.current.add(writer.meta().id);
        return writer;
      },
      wakeLock: requestWakeLock,
      unmounted: () => unmounted.current,
    });
    if (result.status === 'aborted') return;
    if (result.status === 'failed') {
      setError(result.reason === 'store' ? t('record.unsupported') : result.reason === 'device' ? t(withVideo ? 'record.deviceDeniedVideo' : 'record.deviceDenied') : errorMessage(result.error));
      return;
    }
    const { stream, recorder, writer } = result;
    // A device that goes away mid-recording (microphone unplugged, permission taken back) ends its tracks: say why it stopped.
    for (const track of stream.getTracks()) track.addEventListener('ended', () => void writer.markStopped('mic_lost'));
    const l: Live = { stream, recorder, writer, pending: new Set(), wakeLock: result.wakeLock, failed: false, liveCapture: null };
    live.current = l;
    recorder.ondataavailable = (event) => {
      const write = writer.addChunk(event.data, clock.current.elapsedMs(Date.now())).catch(() => {
        // The device refused a chunk (storage full): keep what is saved, stop, and say so.
        if (!l.failed) {
          l.failed = true;
          void l.writer.markStopped('storage_full');
          setError(t('record.saveFailed'));
          if (l.recorder.state !== 'inactive') l.recorder.stop();
        }
      });
      l.pending.add(write);
      void write.finally(() => l.pending.delete(write));
    };
    recorder.onstop = () => void onStopped(l);
    try {
      clock.current.start(Date.now());
      setElapsed(0);
      // A chunk every 5 seconds is written to the device while recording.
      recorder.start(5000);
      // A second, audio-only recorder sends pieces of about 15 seconds; none is made without the tick, and a failure
      // here never stops the recording.
      l.liveCapture = startLiveCapture({
        enabled: liveNotes,
        makeRecorder: () => createBrowserLiveRecorder(stream),
        send: (piece) => sendLiveChunk({ meetingId: writer.meta().meetingId, ...piece }),
        now: () => Date.now(),
      });
      setPhase('recording');
    } catch (err) {
      releaseDevices(l, true);
      setError(errorMessage(err));
    }
  };

  const attachPreview = (node: HTMLVideoElement | null) => {
    previewRef.current = node;
    if (node && live.current && withVideo) node.srcObject = live.current.stream;
  };

  const pauseOrResume = () => {
    const l = live.current;
    if (!l) return;
    if (l.recorder.state === 'recording') {
      l.recorder.pause();
      l.liveCapture?.pause();
      clock.current.pause(Date.now());
      setElapsed(clock.current.elapsedMs(Date.now()));
      setPhase('paused');
    } else if (l.recorder.state === 'paused') {
      l.recorder.resume();
      l.liveCapture?.resume();
      clock.current.resume(Date.now());
      setPhase('recording');
    }
  };

  const stop = () => {
    const l = live.current;
    if (!l) return;
    clock.current.pause(Date.now());
    setElapsed(clock.current.elapsedMs(Date.now()));
    setPhase('uploading');
    // The recorder's own click: no stop reason goes with the upload (A1, #3159).
    void l.writer.markStopped('user');
    // The live recorder stops first; its last piece is taken in onStopped before the devices are released.
    void l.liveCapture?.halt();
    l.recorder.stop();
  };

  // The browser fires the last chunk before `stop`: wait for every write, then upload what the device holds.
  const onStopped = async (l: Live) => {
    await Promise.all(l.pending);
    await l.liveCapture?.halt();
    // The recorder stopped and nobody clicked, left the screen or filled the device: the browser or the device ended it.
    await l.writer.markStopped('unknown');
    const meta = l.writer.meta();
    releaseDevices(l, false);
    if (unmounted.current) return;
    if (meta.stopped !== 'user') setError(t('record.stoppedEarly', { time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), reason: t(`stopReason.${meta.stopped ?? 'unknown'}`) }));
    // The live pieces are refused once the final recording is stored: they finish (or give up) first, then the upload.
    await uploadAfterLive(l.liveCapture, () => uploadAndClear(meta, l.failed));
  };

  const uploadAndClear = async (meta: RecordingMeta, partial = false): Promise<boolean> => {
    if (!store) return false;
    setBusyId(meta.id);
    try {
      const recording = await assembleRecording(store, meta);
      if (!recording) {
        await store.remove(meta.id);
        setError(t('record.nothingSaved'));
        return false;
      }
      await uploadMeetingMedia(meta.meetingId, meta.kind, recording.file, recording.lengthSeconds, stopReasonForUpload(meta));
      // Uploaded: the device copy is cleared at once.
      await store.remove(meta.id);
      await queryClient.invalidateQueries({ queryKey: orpc.meetings.key() });
      toast(t(partial ? 'record.uploadedPartial' : 'record.uploaded'), 'success');
      void navigate({ to: '/o/$slug/meetings/$id', params: { slug, id: meta.meetingId } });
      return true;
    } catch (err) {
      // The copy stays on the device, and the screen offers the upload again.
      setError(`${t('record.uploadFailed')} ${errorMessage(err)}`);
      return false;
    } finally {
      if (!unmounted.current) {
        setBusyId(null);
        setPhase('setup');
        void refreshRecoverable();
      }
    }
  };

  const discard = async (meta: RecordingMeta) => {
    if (!store) return;
    await store.remove(meta.id);
    await refreshRecoverable();
  };

  const recording = phase === 'recording' || phase === 'paused';
  const startDisabled = blocker !== null || unsupported || phase !== 'setup';

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

      {error && <ErrorText>{error}</ErrorText>}
      {unsupported && <ErrorText>{t('record.unsupported')}</ErrorText>}

      {recoverable.length > 0 && phase === 'setup' && (
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

      {recording || phase === 'uploading' ? (
        <Card>
          <CardContent className="space-y-4 pt-6">
            <div className="flex items-center gap-3" role="status" aria-live="polite">
              <span className={`inline-block size-3 rounded-full ${phase === 'recording' ? 'animate-pulse bg-destructive' : 'bg-muted-foreground'}`} aria-hidden="true" />
              <span className="text-sm font-medium">
                {phase === 'recording' ? t('record.recording') : phase === 'paused' ? t('record.paused') : t('record.uploading')}
              </span>
              <span className="font-mono text-2xl tabular-nums" aria-label={t('record.timer')}>{formatClock(elapsed)}</span>
            </div>
            {withVideo && <video ref={attachPreview} autoPlay muted playsInline className="aspect-video w-full max-w-md rounded bg-muted" />}
            <p className="text-xs text-muted-foreground">{t('record.keepScreenOn')}</p>
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
                <NativeSelect id="record-consent-method" value={consentMethod} onChange={(e) => setConsentMethod(e.target.value as ConsentMethod)} required>
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
