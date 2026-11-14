// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import {
  MEETING_AUDIO_RETENTION_CHOICES,
  MEETING_TEXT_RETENTION_CHOICES,
  MEETING_VIDEO_RETENTION_CHOICES,
  type ConsentMethod,
  type MeetingLanguage,
  type MeetingSettings,
  type MeetingSummary,
  type MeetingVisibility,
} from '@crove/kernel-contract';
import { RECORDING_NOTICE } from '@crove/meeting-recorder';
import { Badge } from '@crove/ui/components/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@crove/ui/components/card';
import { Button, buttonVariants } from '@crove/ui/components/button';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@crove/ui/components/dialog';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { Empty, ErrorText, ListSkeleton, PageHeader } from '../components/ui.tsx';
import { MeetingSearch } from '../components/meeting-search.tsx';
import { NotesSubnav } from '../components/notes-subnav.tsx';
import { ConsentPolicyCard, useConsentPolicy } from '../components/consent-policy.tsx';
import { MeetingHookCard } from '../components/meeting-hook.tsx';
import { RecordingNotice } from '../components/recording-notice.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient, uploadMeetingMedia } from '../lib/api.ts';
import { toast } from '../lib/toast.ts';

const STATUS_VARIANTS: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  ready: 'default',
  completed: 'default',
  processing: 'secondary',
  error: 'destructive',
};

// The org's three retention periods (ADR-0047 point 7, plan section 9). Everyone who reads meetings sees them; an owner or admin changes them. A change
// applies to meetings recorded afterwards. The AI coworker has no part here: the periods are the org's own, and the core works with AI off.
function RetentionSettingsCard() {
  const t = useTranslations('meetings.settings');
  const settingsQuery = useQuery(orpc.meetings.settings.get.queryOptions({ input: {} }));
  const orgQuery = useQuery(orpc.org.get.queryOptions());
  const canEdit = orgQuery.data?.role === 'owner' || orgQuery.data?.role === 'admin';
  const [draft, setDraft] = useState<MeetingSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = draft ?? settingsQuery.data ?? null;

  const change = (patch: Partial<MeetingSettings>) => {
    if (!current) return;
    const next = { ...current, ...patch };
    // A kept video is never longer than the audio (a choice of "right after the transcript" counts as 7 days).
    if (next.videoRetentionDays > Math.max(next.audioRetentionDays, 7)) next.videoRetentionDays = 7;
    setDraft(next);
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      await orpc.meetings.settings.set.call(draft);
      await queryClient.invalidateQueries({ queryKey: orpc.meetings.settings.key() });
      setDraft(null);
      toast(t('saved'), 'success');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (settingsQuery.isPending || !current) return null;
  const audioLabel = (n: number) => (n === 0 ? t('audioChoice.0') : n === 7 ? t('audioChoice.7') : n === 30 ? t('audioChoice.30') : t('audioChoice.90'));
  const videoLabel = (n: number) => (n === 7 ? t('videoChoice.7') : t('videoChoice.30'));
  const textLabel = (n: number) => (n === 0 ? t('textChoice.0') : n === 90 ? t('textChoice.90') : n === 365 ? t('textChoice.365') : t('textChoice.730'));
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('hint')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="retention-audio">{t('audio')}</Label>
            <NativeSelect id="retention-audio" disabled={!canEdit} value={String(current.audioRetentionDays)} onChange={(e) => change({ audioRetentionDays: Number(e.target.value) as MeetingSettings['audioRetentionDays'] })}>
              {MEETING_AUDIO_RETENTION_CHOICES.map((n) => (
                <NativeSelectOption key={n} value={String(n)}>
                  {audioLabel(n)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <Label htmlFor="retention-video">{t('video')}</Label>
            <NativeSelect id="retention-video" disabled={!canEdit} value={String(current.videoRetentionDays)} onChange={(e) => change({ videoRetentionDays: Number(e.target.value) as MeetingSettings['videoRetentionDays'] })}>
              {MEETING_VIDEO_RETENTION_CHOICES.filter((n) => n <= Math.max(current.audioRetentionDays, 7)).map((n) => (
                <NativeSelectOption key={n} value={String(n)}>
                  {videoLabel(n)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <Label htmlFor="retention-text">{t('text')}</Label>
            <NativeSelect id="retention-text" disabled={!canEdit} value={String(current.textRetentionDays)} onChange={(e) => change({ textRetentionDays: Number(e.target.value) as MeetingSettings['textRetentionDays'] })}>
              {MEETING_TEXT_RETENTION_CHOICES.map((n) => (
                <NativeSelectOption key={n} value={String(n)}>
                  {textLabel(n)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        </div>
        {error ? <ErrorText>{error}</ErrorText> : null}
        {canEdit ? (
          <Button onClick={() => void save()} disabled={!draft || saving}>
            {t('save')}
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">{t('adminOnly')}</p>
        )}
      </CardContent>
    </Card>
  );
}

export function MeetingsPage() {
  const t = useTranslations('meetings');
  const f = useFormat();
  const navigate = useNavigate();
  const { slug } = useParams({ strict: false }) as { slug: string };

  const [search, setSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);

  // Form state
  const [title, setTitle] = useState('');
  const [language, setLanguage] = useState<MeetingLanguage>('vi');
  const [visibility, setVisibility] = useState<MeetingVisibility>('attendees');
  const [keepVideo, setKeepVideo] = useState(false);
  const [consentMethod, setConsentMethod] = useState<ConsentMethod | ''>('');
  // A strict org accepts only a written method (A2, #3160): the unwritten one is not offered, and a choice made before the policy loaded is dropped.
  const consentPolicy = useConsentPolicy();
  useEffect(() => {
    if (consentPolicy === 'strict' && consentMethod === 'told_at_start') setConsentMethod('');
  }, [consentPolicy, consentMethod]);
  const [consentAgreed, setConsentAgreed] = useState(false);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // A failed upload leaves the meeting created: a retry keeps it and sends only the media that has not gone yet.
  const createdIdRef = useRef<string | null>(null);
  const uploadedRef = useRef<Set<'audio' | 'video'>>(new Set());
  // The same facts as state, so the form can lock the meeting-level fields and the media already sent.
  const [meetingCreated, setMeetingCreated] = useState(false);
  const [uploadedKinds, setUploadedKinds] = useState<ReadonlyArray<'audio' | 'video'>>([]);

  const meetingsQuery = useQuery(orpc.meetings.list.queryOptions({ input: {} }));

  const meetings = (meetingsQuery.data ?? []).filter((m: MeetingSummary) => {
    if (!search.trim()) return true;
    return m.title.toLowerCase().includes(search.toLowerCase());
  });

  const resetForm = () => {
    setTitle('');
    setLanguage('vi');
    setVisibility('attendees');
    setKeepVideo(false);
    setConsentMethod('');
    setConsentAgreed(false);
    setAudioFile(null);
    setVideoFile(null);
    setFormError(null);
    setSubmitting(false);
    createdIdRef.current = null;
    uploadedRef.current = new Set();
    setMeetingCreated(false);
    setUploadedKinds([]);
  };

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!title.trim()) {
      setFormError(t('form.titleRequired'));
      return;
    }
    if (!consentMethod) {
      setFormError(t('form.consentMethodRequired'));
      return;
    }
    if (!consentAgreed) {
      setFormError(t('form.consentRequired'));
      return;
    }

    try {
      setSubmitting(true);
      if (!createdIdRef.current) {
        const made = await orpc.meetings.create.call({
          title: title.trim(),
          language,
          visibility,
          keepVideo,
          consentMethod,
          consentNoticeVersion: RECORDING_NOTICE.version,
        });
        createdIdRef.current = made.meetingId;
        setMeetingCreated(true);
      }
      const created = { meetingId: createdIdRef.current };

      if (audioFile && !uploadedRef.current.has('audio')) {
        await uploadMeetingMedia(created.meetingId, 'audio', audioFile);
        uploadedRef.current.add('audio');
        setUploadedKinds([...uploadedRef.current]);
      }

      if (keepVideo && videoFile && !uploadedRef.current.has('video')) {
        await uploadMeetingMedia(created.meetingId, 'video', videoFile);
        uploadedRef.current.add('video');
        setUploadedKinds([...uploadedRef.current]);
      }

      await queryClient.invalidateQueries({ queryKey: orpc.meetings.key() });
      toast(t('created'), 'success');
      setModalOpen(false);
      resetForm();
      void navigate({ to: '/o/$slug/meetings/$id', params: { slug, id: created.meetingId } });
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link to="/o/$slug/meetings/record" params={{ slug }} className={buttonVariants({ variant: 'outline' })}>
              {t('record.open')}
            </Link>
            <Button onClick={() => setModalOpen(true)}>
              {t('new')}
            </Button>
          </div>
        }
      />
      <NotesSubnav slug={slug} active="meetings" />

      <MeetingSearch slug={slug} />

      <div className="flex items-center gap-4">
        <div className="w-full max-w-sm space-y-1">
          <Label htmlFor="meeting-search">{t('searchLabel')}</Label>
          <Input
            id="meeting-search"
            type="search"
            placeholder={t('searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {meetingsQuery.isPending && !meetingsQuery.error ? (
        <ListSkeleton />
      ) : meetingsQuery.error ? (
        <ErrorText>{errorMessage(meetingsQuery.error)}</ErrorText>
      ) : meetings.length === 0 ? (
        <Empty
          title={t('empty')}
          hint={t('emptyHint')}
          action={
            <Button onClick={() => setModalOpen(true)}>
              {t('new')}
            </Button>
          }
        />
      ) : (
        <div className="divide-y rounded-lg border border-border bg-card">
          {meetings.map((m: MeetingSummary) => (
            <Link
              key={m.id}
              to="/o/$slug/meetings/$id"
              params={{ slug, id: m.id }}
              className="flex items-center justify-between p-4 transition-colors hover:bg-muted/50 focus-visible:bg-muted/50"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 break-words font-semibold text-foreground">{m.title}</span>
                  <Badge variant={STATUS_VARIANTS[m.status] ?? 'outline'}>{m.status}</Badge>
                  <Badge variant="outline">
                    {m.visibility === 'org' ? t('badgeOrg') : t('badgeAttendees')}
                  </Badge>
                  {m.hasAudio && <Badge variant="secondary">{t('badgeAudio')}</Badge>}
                  {m.hasVideo && <Badge variant="secondary">{t('badgeVideo')}</Badge>}
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>{f.date(m.createdAt)}</span>
                  <span>{t('audioKeptUntil', { date: m.audioRetentionDate })}</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      <RetentionSettingsCard />
      <ConsentPolicyCard />
      <MeetingHookCard />

      {/* New Meeting Modal with Mandatory Consent Gate */}
      <Dialog open={modalOpen} onOpenChange={(open) => {
          // A running create-and-upload is not dismissed: its result would land on a later draft.
          if (!open && submitting) return;
          setModalOpen(open);
          if (!open) resetForm();
        }}>
        <DialogContent className="max-w-lg" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t('newModalTitle')}</DialogTitle>
            <DialogDescription>{t('newModalDesc')}</DialogDescription>
          </DialogHeader>

          <form onSubmit={handleCreate} className="space-y-4">
            {formError && <ErrorText>{formError}</ErrorText>}
            {meetingCreated && <p className="text-xs text-muted-foreground">{t('form.lockedHint')}</p>}

            <div className="space-y-1">
              <Label htmlFor="meeting-title">{t('form.title')}</Label>
              <Input
                id="meeting-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('form.titlePlaceholder')}
                required
                disabled={meetingCreated}
                maxLength={200}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="meeting-lang">{t('form.language')}</Label>
                <NativeSelect
                  id="meeting-lang"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value as MeetingLanguage)}
                  disabled={meetingCreated}
                >
                  <NativeSelectOption value="vi">{t('form.langVi')}</NativeSelectOption>
                  <NativeSelectOption value="en">{t('form.langEn')}</NativeSelectOption>
                </NativeSelect>
              </div>

              <div className="space-y-1">
                <Label htmlFor="meeting-vis">{t('form.visibility')}</Label>
                <NativeSelect
                  id="meeting-vis"
                  value={visibility}
                  onChange={(e) => setVisibility(e.target.value as MeetingVisibility)}
                  disabled={meetingCreated}
                >
                  <NativeSelectOption value="attendees">{t('form.visibilityAttendees')}</NativeSelectOption>
                  <NativeSelectOption value="org">{t('form.visibilityOrg')}</NativeSelectOption>
                </NativeSelect>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="meeting-audio">{t('form.audioFile')}</Label>
              <Input
                id="meeting-audio"
                type="file"
                accept="audio/*,.mp3,.m4a,.wav,.aac,.ogg,.webm,.opus"
                onChange={(e) => setAudioFile(e.target.files?.[0] ?? null)}
                disabled={uploadedKinds.includes('audio')}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="keep-video"
                  checked={keepVideo}
                  onCheckedChange={(checked) => setKeepVideo(Boolean(checked))}
                  disabled={meetingCreated}
                />
                <Label htmlFor="keep-video" className="cursor-pointer">
                  {t('form.keepVideo')}
                </Label>
              </div>

              {keepVideo && (
                <div className="mt-2 space-y-1 pl-6">
                  <Label htmlFor="meeting-video">{t('form.videoFile')}</Label>
                  <Input
                    id="meeting-video"
                    type="file"
                    accept="video/*,.mp4,.mov,.webm,.m4v"
                    onChange={(e) => setVideoFile(e.target.files?.[0] ?? null)}
                    disabled={uploadedKinds.includes('video')}
                  />
                </div>
              )}
            </div>

            {/* Mandatory Consent Gate Box */}
            <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
              <div className="text-sm font-semibold text-foreground">
                {t('form.consentSectionTitle')}
              </div>
              <p className="text-xs text-muted-foreground">
                {t('form.consentNotice')}
              </p>
              <RecordingNotice meetingLanguage={language} />

              <div className="space-y-1">
                <Label htmlFor="consent-method" className="text-xs">
                  {t('form.consentMethod')}
                </Label>
                <NativeSelect
                  id="consent-method"
                  value={consentMethod}
                  onChange={(e) => setConsentMethod(e.target.value as ConsentMethod)}
                  required
                  disabled={meetingCreated}
                >
                  <NativeSelectOption value="" disabled>{t('form.selectConsentMethod')}</NativeSelectOption>
                  {consentPolicy === 'standard' && <NativeSelectOption value="told_at_start">{t('form.toldAtStart')}</NativeSelectOption>}
                  <NativeSelectOption value="in_invite">{t('form.inInvite')}</NativeSelectOption>
                  <NativeSelectOption value="in_writing">{t('form.inWriting')}</NativeSelectOption>
                  <NativeSelectOption value="in_call_chat">{t('form.inCallChat')}</NativeSelectOption>
                </NativeSelect>
                {consentPolicy === 'strict' && <p className="text-xs text-muted-foreground" data-testid="consent-strict-note">{t('consentPolicy.strictNote')}</p>}
              </div>

              <div className="flex items-start gap-2 pt-1">
                <Checkbox
                  id="consent-agreed"
                  checked={consentAgreed}
                  onCheckedChange={(c) => setConsentAgreed(Boolean(c))}
                  disabled={meetingCreated}
                />
                <Label htmlFor="consent-agreed" className="text-xs leading-snug cursor-pointer font-medium text-foreground">
                  {t('form.consentConfirmCheckbox')}
                </Label>
              </div>
            </div>

            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" disabled={submitting} />}>
                {t('form.cancel')}
              </DialogClose>
              <Button type="submit" disabled={!consentAgreed || !consentMethod || submitting} loading={submitting}>
                {t('form.submit')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
