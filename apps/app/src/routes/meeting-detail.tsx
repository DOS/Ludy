// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@crove/ui/components/card';
import { Label } from '@crove/ui/components/label';
import { NativeSelect } from '@crove/ui/components/native-select';
import { ConfirmDialog } from '../components/confirm-dialog.tsx';
import { MeetingResults, memberLabel } from '../components/meeting-results.tsx';
import { MeetingTranscript } from '../components/meeting-transcript.tsx';
import { StepUpPrompt } from '../components/two-factor.tsx';
import { Empty, ErrorText, ListSkeleton, PageHeader } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { apiFetch, errorMessage, isStepUpRequired, orpc, queryClient } from '../lib/api.ts';
import { toast } from '../lib/toast.ts';

const CONSENT_KEYS = { told_at_start: 'toldAtStart', in_invite: 'inInvite', in_writing: 'inWriting' } as const;

const STATUS_VARIANTS: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  ready: 'default',
  completed: 'default',
  processing: 'secondary',
  error: 'destructive',
};

export function MeetingDetailPage() {
  const t = useTranslations('meetings');
  const f = useFormat();
  const navigate = useNavigate();
  const { slug, id } = useParams({ strict: false }) as { slug: string; id: string };

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [newReaderUserId, setNewReaderUserId] = useState('');
  const [readerError, setReaderError] = useState<string | null>(null);
  // The meeting the owner confirmed deleting: a step-up retry deletes that one and no other.
  const [pendingOwnerDeleteId, setPendingOwnerDeleteId] = useState<string | null>(null);

  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [audioLoading, setAudioLoading] = useState(false);
  const [videoLoading, setVideoLoading] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);

  const meetingQuery = useQuery(
    orpc.meetings.get.queryOptions({
      input: { meetingId: id },
    }),
  );

  // The same query the transcript panel runs (one request): the AI-off notice gives way once there is a transcript.
  const transcriptQuery = useQuery({ ...orpc.meetings.transcript.get.queryOptions({ input: { meetingId: id } }), staleTime: 5 * 60_000, refetchOnWindowFocus: false });
  const hasTranscript = (transcriptQuery.data?.segments.length ?? 0) > 0;

  const orgQuery = useQuery(orpc.org.get.queryOptions());
  const isOwner = orgQuery.data?.role === 'owner';
  const orgMembers = orgQuery.data?.members ?? [];

  const meeting = meetingQuery.data;

  useEffect(() => {
    let active = true;
    // A new meeting starts clean: no player on a revoked URL, no error of the last one.
    setAudioUrl(null);
    setVideoUrl(null);
    setAudioError(null);
    setVideoError(null);
    setAudioLoading(false);
    setVideoLoading(false);
    let createdAudioUrl: string | null = null;
    let createdVideoUrl: string | null = null;

    // Video is fetched after the audio finishes: the server allows one large transfer per member at a time.
    const loadVideo = () => {
      if (!active || !meeting?.hasVideo) return;
      setVideoLoading(true);
      setVideoError(null);
      apiFetch(`/api/meetings/${meeting.id}/video`)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.blob();
        })
        .then((blob) => {
          if (active) {
            createdVideoUrl = URL.createObjectURL(blob);
            setVideoUrl(createdVideoUrl);
          }
        })
        .catch((err: unknown) => {
          if (active) setVideoError(errorMessage(err));
        })
        .finally(() => {
          if (active) setVideoLoading(false);
        });
    };

    if (meeting?.hasAudio) {
      setAudioLoading(true);
      setAudioError(null);
      apiFetch(`/api/meetings/${meeting.id}/audio`)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.blob();
        })
        .then((blob) => {
          if (active) {
            createdAudioUrl = URL.createObjectURL(blob);
            setAudioUrl(createdAudioUrl);
          }
        })
        .catch((err: unknown) => {
          if (active) setAudioError(errorMessage(err));
        })
        .finally(() => {
          if (active) setAudioLoading(false);
          loadVideo();
        });
    }

    if (!meeting?.hasAudio) loadVideo();

    return () => {
      active = false;
      if (createdAudioUrl) URL.revokeObjectURL(createdAudioUrl);
      if (createdVideoUrl) URL.revokeObjectURL(createdVideoUrl);
    };
  }, [meeting?.id, meeting?.hasAudio, meeting?.hasVideo]);

  // Leaving a meeting drops a pending owner deletion and its step-up prompt.
  useEffect(() => {
    setPendingOwnerDeleteId(null);
    setDeleteOpen(false);
  }, [id]);

  const deleteMutation = useMutation({
    mutationFn: () => orpc.meetings.delete.call({ meetingId: id }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: orpc.meetings.key() });
      toast(t('detail.deleted'), 'success');
      void navigate({ to: '/o/$slug/meetings', params: { slug } });
    },
    onError: (err) => {
      toast(errorMessage(err), 'error');
    },
  });

  const ownerDeleteMutation = useMutation({
    mutationFn: (meetingId: string) => orpc.meetings.ownerDelete.call({ meetingId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: orpc.meetings.key() });
      toast(t('detail.ownerDeleted'), 'success');
      void navigate({ to: '/o/$slug/meetings', params: { slug } });
    },
    onError: (err) => {
      // A fresh second factor is asked for below, and the same request is repeated once it is verified.
      if (!isStepUpRequired(err)) toast(errorMessage(err), 'error');
    },
  });

  const addReaderMutation = useMutation({
    mutationFn: (userId: string) =>
      orpc.meetings.readers.add.call({ meetingId: id, userId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: orpc.meetings.key() });
      setNewReaderUserId('');
      setReaderError(null);
      toast(t('detail.readerAdded'), 'success');
    },
    onError: (err) => {
      setReaderError(errorMessage(err));
    },
  });

  const removeReaderMutation = useMutation({
    mutationFn: (userId: string) =>
      orpc.meetings.readers.remove.call({ meetingId: id, userId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: orpc.meetings.key() });
      toast(t('detail.readerRemoved'), 'success');
    },
    onError: (err) => {
      toast(errorMessage(err), 'error');
    },
  });

  if (meetingQuery.isPending && !meetingQuery.error) {
    return <ListSkeleton />;
  }

  if (meetingQuery.error || !meeting) {
    return (
      <div className="space-y-4">
        <Link to="/o/$slug/meetings" params={{ slug }} className="text-sm text-link underline">
          {t('detail.back')}
        </Link>
        <ErrorText>{errorMessage(meetingQuery.error ?? new Error(t('detail.notFound')))}</ErrorText>
      </div>
    );
  }

  const handleAddReader = (e: FormEvent) => {
    e.preventDefault();
    if (!newReaderUserId.trim()) return;
    addReaderMutation.mutate(newReaderUserId.trim());
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Link to="/o/$slug/meetings" params={{ slug }} className="text-sm text-link underline">
          &larr; {t('detail.back')}
        </Link>
        {meeting.isRecorder ? (
          <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)}>
            {t('detail.delete')}
          </Button>
        ) : isOwner ? (
          <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)}>
            {t('detail.ownerDelete')}
          </Button>
        ) : null}
      </div>

      {/* Next to the header, so the owner sees it right after the confirm dialog closes; its code field takes the focus. */}
      {ownerDeleteMutation.error && isStepUpRequired(ownerDeleteMutation.error) && pendingOwnerDeleteId === id && (
        <div className="mb-4">
          <StepUpPrompt
            action={t('detail.ownerDeleteVerify')}
            onVerified={() => ownerDeleteMutation.mutate(pendingOwnerDeleteId)}
            onCancel={() => {
              ownerDeleteMutation.reset();
              setPendingOwnerDeleteId(null);
            }}
          />
        </div>
      )}

      <PageHeader
        title={meeting.title}
        subtitle={t('detail.recordedBy', { user: meeting.recorderUserId, date: f.date(meeting.createdAt) })}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant={STATUS_VARIANTS[meeting.status] ?? 'outline'}>{meeting.status}</Badge>
            <Badge variant="outline">
              {meeting.visibility === 'org' ? t('badgeOrg') : t('badgeAttendees')}
            </Badge>
          </div>
        }
      />

      {/* AI Off Status Card: gone once the meeting has a transcript */}
      {!hasTranscript && (
        <Card className="border-primary/20 bg-primary/5">
          <CardHeader>
            <CardTitle className="text-sm font-semibold text-primary">
              {t('detail.aiOffCardTitle')}
            </CardTitle>
            <CardDescription className="text-xs text-muted-foreground">
              {t('detail.aiOffCardDesc')}
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {/* Playback section */}
      <div className="space-y-6">
        {meeting.hasAudio && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-medium">{t('detail.audioPlayerTitle')}</CardTitle>
            </CardHeader>
            <CardContent>
              {audioLoading && <div className="text-xs text-muted-foreground">{t('detail.loadingMedia')}</div>}
              {audioError && <ErrorText>{audioError}</ErrorText>}
              {audioUrl && <audio controls className="w-full" src={audioUrl} />}
            </CardContent>
          </Card>
        )}

        {meeting.hasVideo && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-medium">{t('detail.videoPlayerTitle')}</CardTitle>
            </CardHeader>
            <CardContent>
              {videoLoading && <div className="text-xs text-muted-foreground">{t('detail.loadingMedia')}</div>}
              {videoError && <ErrorText>{videoError}</ErrorText>}
              {videoUrl && (
                <video controls className="w-full max-h-96 rounded-lg bg-muted" src={videoUrl} />
              )}
            </CardContent>
          </Card>
        )}

        {!meeting.hasAudio && !meeting.hasVideo && (
          <Empty title={t('detail.noMedia')} />
        )}
      </div>

      {/* The transcript: the recorder's draft, or what was shared with the meeting */}
      <MeetingTranscript meetingId={id} />
      <MeetingResults meetingId={id} readers={meeting.readers} />

      <div className="grid gap-6 md:grid-cols-2">
        {/* Consent Record Card */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">{t('detail.consentRecord')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            <div>
              <span className="font-semibold text-muted-foreground">{t('detail.consentMethodLabel')}: </span>
              <span>{t(`form.${CONSENT_KEYS[meeting.consentMethod]}`)}</span>
            </div>
            <div>
              <span className="font-semibold text-muted-foreground">{t('detail.consentNoticeVersion')}: </span>
              <span>{meeting.consentNoticeVersion}</span>
            </div>
            <div>
              <span className="font-semibold text-muted-foreground">{t('detail.consentConfirmedAt')}: </span>
              <span>{f.date(meeting.consentConfirmedAt)}</span>
            </div>
            <div>
              <span className="font-semibold text-muted-foreground">{t('detail.audioRetention')}: </span>
              <span>{meeting.audioRetentionDate}</span>
            </div>
            <div>
              <span className="font-semibold text-muted-foreground">{t('detail.textRetention')}: </span>
              <span>{meeting.textRetentionDate ?? t('detail.untilDeleted')}</span>
            </div>
          </CardContent>
        </Card>

        {/* Readers List Card */}
        {meeting.visibility === 'attendees' && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">
                {t('detail.readersTitle', { count: String(meeting.readers.length) })}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {meeting.isRecorder && (
                <form onSubmit={handleAddReader} className="space-y-1">
                  <Label htmlFor="reader-user-id">{t('detail.readerUserId')}</Label>
                  <div className="flex gap-2">
                    <NativeSelect id="reader-user-id" value={newReaderUserId} onChange={(e) => setNewReaderUserId(e.target.value)} className="text-xs">
                      <option value="">{t('detail.readerUserIdPlaceholder')}</option>
                      {orgMembers
                        .filter((m) => !meeting.readers.includes(m.userId))
                        .map((m) => (
                          <option key={m.userId} value={m.userId}>
                            {memberLabel(orgMembers, m.userId, t('results.unknownMember'))}
                          </option>
                        ))}
                    </NativeSelect>
                    <Button type="submit" size="sm" disabled={!newReaderUserId.trim()} loading={addReaderMutation.isPending}>
                      {t('detail.addReader')}
                    </Button>
                  </div>
                </form>
              )}
              {readerError && <ErrorText>{readerError}</ErrorText>}

              <ul className="divide-y text-xs">
                {meeting.readers.map((readerUserId) => (
                  <li key={readerUserId} className="flex items-center justify-between py-2">
                    <span>{memberLabel(orgMembers, readerUserId, t('results.unknownMember'))}</span>
                    {meeting.isRecorder && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:bg-destructive/10"
                        loading={removeReaderMutation.isPending && removeReaderMutation.variables === readerUserId}
                        disabled={removeReaderMutation.isPending}
                        onClick={() => removeReaderMutation.mutate(readerUserId)}
                      >
                        {t('detail.removeReader')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={meeting.isRecorder ? t('detail.deleteConfirmTitle') : t('detail.ownerDeleteTitle')}
        description={
          meeting.isRecorder
            ? t('detail.deleteConfirmBody')
            : t('detail.ownerDeleteBody')
        }
        confirm={meeting.isRecorder ? t('detail.deleteButton') : t('detail.ownerDeleteConfirm')}
        destructive
        onConfirm={() => {
          if (meeting.isRecorder) {
            deleteMutation.mutate();
          } else if (isOwner) {
            setPendingOwnerDeleteId(meeting.id);
            ownerDeleteMutation.mutate(meeting.id);
          }
        }}
      />
    </div>
  );
}
