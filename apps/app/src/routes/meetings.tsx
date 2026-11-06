// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import type { ConsentMethod, MeetingLanguage, MeetingSummary, MeetingVisibility } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@crove/ui/components/dialog';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { Empty, ErrorText, ListSkeleton, PageHeader } from '../components/ui.tsx';
import { NotesSubnav } from '../components/notes-subnav.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient, uploadMeetingMedia } from '../lib/api.ts';
import { toast } from '../lib/toast.ts';

const STATUS_VARIANTS: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  ready: 'default',
  completed: 'default',
  processing: 'secondary',
  error: 'destructive',
};

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
  const [consentAgreed, setConsentAgreed] = useState(false);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

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
  };

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!title.trim()) {
      setFormError('Vui lòng nhập tên cuộc họp');
      return;
    }
    if (!consentMethod) {
      setFormError('Vui lòng chọn phương thức ghi nhận đồng thuận');
      return;
    }
    if (!consentAgreed) {
      setFormError('Bạn bắt buộc phải xác nhận sự đồng thuận của người tham gia');
      return;
    }

    try {
      setSubmitting(true);
      const created = await orpc.meetings.create.call({
        title: title.trim(),
        language,
        visibility,
        keepVideo,
        consentMethod,
      });

      if (audioFile) {
        await uploadMeetingMedia(created.meetingId, 'audio', audioFile);
      }

      if (keepVideo && videoFile) {
        await uploadMeetingMedia(created.meetingId, 'video', videoFile);
      }

      await queryClient.invalidateQueries({ queryKey: orpc.meetings.key() });
      toast('Đã tạo cuộc họp và lưu trữ bản ghi mã hóa thành công', 'success');
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
          <Button onClick={() => setModalOpen(true)}>
            {t('new')}
          </Button>
        }
      />
      <NotesSubnav slug={slug} active="meetings" />

      <div className="flex items-center gap-4">
        <div className="w-full max-w-sm">
          <Input
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
          hint="Ghi lại cuộc họp đầu tiên để lưu giữ bản ghi âm và video được mã hóa an toàn."
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
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-foreground">{m.title}</span>
                  <Badge variant={STATUS_VARIANTS[m.status] ?? 'outline'}>{m.status}</Badge>
                  <Badge variant="outline">
                    {m.visibility === 'org' ? 'Toàn tổ chức' : 'Người tham gia'}
                  </Badge>
                  {m.hasAudio && <Badge variant="secondary">Audio</Badge>}
                  {m.hasVideo && <Badge variant="secondary">Video</Badge>}
                </div>
                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  <span>{f.date(m.createdAt)}</span>
                  <span>Lưu âm thanh đến: {m.audioRetentionDate}</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* New Meeting Modal with Mandatory Consent Gate */}
      <Dialog open={modalOpen} onOpenChange={(open) => { setModalOpen(open); if (!open) resetForm(); }}>
        <DialogContent className="max-w-lg" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t('newModalTitle')}</DialogTitle>
            <DialogDescription>{t('newModalDesc')}</DialogDescription>
          </DialogHeader>

          <form onSubmit={handleCreate} className="space-y-4">
            {formError && <ErrorText>{formError}</ErrorText>}

            <div className="space-y-1">
              <Label htmlFor="meeting-title">{t('form.title')}</Label>
              <Input
                id="meeting-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('form.titlePlaceholder')}
                required
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
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="keep-video"
                  checked={keepVideo}
                  onCheckedChange={(checked) => setKeepVideo(Boolean(checked))}
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
              <div className="rounded bg-muted/60 p-2 text-xs italic text-foreground">
                {t('form.consentSpokenSentence')}
              </div>

              <div className="space-y-1">
                <Label htmlFor="consent-method" className="text-xs">
                  {t('form.consentMethod')}
                </Label>
                <NativeSelect
                  id="consent-method"
                  value={consentMethod}
                  onChange={(e) => setConsentMethod(e.target.value as ConsentMethod)}
                  required
                >
                  <NativeSelectOption value="" disabled>{t('form.selectConsentMethod')}</NativeSelectOption>
                  <NativeSelectOption value="told_at_start">{t('form.toldAtStart')}</NativeSelectOption>
                  <NativeSelectOption value="in_invite">{t('form.inInvite')}</NativeSelectOption>
                  <NativeSelectOption value="in_writing">{t('form.inWriting')}</NativeSelectOption>
                </NativeSelect>
              </div>

              <div className="flex items-start gap-2 pt-1">
                <Checkbox
                  id="consent-agreed"
                  checked={consentAgreed}
                  onCheckedChange={(c) => setConsentAgreed(Boolean(c))}
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
                {submitting ? t('form.submitting') : t('form.submit')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
