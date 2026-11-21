// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@crove/ui/components/card';
import { Label } from '@crove/ui/components/label';
import { NativeSelect } from '@crove/ui/components/native-select';
import { ConfirmDialog } from '../components/confirm-dialog.tsx';
import { AgendaAttach } from '../components/meeting-agenda.tsx';
import { ImportAutoClaim } from '../components/meeting-import-claim.tsx';
import { MeetingLinks } from '../components/meeting-links.tsx';
import { MeetingResults, memberLabel } from '../components/meeting-results.tsx';
import { MeetingLive } from '../components/meeting-live.tsx';
import { MeetingAdherence } from '../components/meeting-adherence.tsx';
import { MeetingBrief } from '../components/meeting-brief.tsx';
import { MeetingSeries } from '../components/meeting-series.tsx';
import { MeetingTitleSuggest } from '../components/meeting-title.tsx';
import { MeetingChapters } from '../components/meeting-chapters.tsx';
import { MeetingCommitments } from '../components/meeting-commitments.tsx';
import { MeetingNotes } from '../components/meeting-notes.tsx';
import { MeetingTranscript } from '../components/meeting-transcript.tsx';
import { RecordNotesPanel, notesInstalled } from '../components/notes-panel.tsx';
import { StepUpPrompt } from '../components/two-factor.tsx';
import { RecordingStoppedNote } from '../components/recording-stopped.tsx';
import { Empty, ErrorText, ListSkeleton, PageHeader } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { apiFetch, errorMessage, fetchVideoTicket, isStepUpRequired, orpc, queryClient } from '../lib/api.ts';
import { toast } from '../lib/toast.ts';
import type { TranscriptFocus } from '../lib/transcript-focus.ts';
import { createVideoTicketPlayer, videoStreamUrl, type VideoTicketPlayer } from '../lib/video-ticket.ts';

const CONSENT_KEYS = { told_at_start: 'toldAtStart', in_invite: 'inInvite', in_writing: 'inWriting', in_call_chat: 'inCallChat', platform_notice: 'platformNotice' } as const;

const STATUS_VARIANTS: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  ready: 'default',
  completed: 'default',
  processing: 'secondary',
  error: 'destructive',
};

export function MeetingDetailPage() {
  const t = useTranslations('meetings');
  const tn = useTranslations('notes');
  const f = useFormat();
  const navigate = useNavigate();
  const { slug, id } = useParams({ strict: false }) as { slug: string; id: string };
  // A search hit names the transcript line to open at (L2, #2589).
  const { seg } = useSearch({ strict: false }) as { seg?: string };

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
  // The player streams the video by a short-lived ticket (#2703); the element and the ticket player are kept for its error events.
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // A chapter was clicked (#3844): the transcript goes to its line, and a recording that is already loaded is set to that second (it is never started by the click).
  const [jump, setJump] = useState<TranscriptFocus | undefined>(undefined);
  // The page links to another meeting in place: a jump to a line of one meeting never carries over to the next.
  useEffect(() => setJump(undefined), [id]);
  const jumpTo = (second: number, speaker?: string) => {
    setJump((j) => ({ second, speaker, token: (j?.token ?? 0) + 1 }));
    if (audioRef.current) audioRef.current.currentTime = second;
    if (videoRef.current) videoRef.current.currentTime = second;
  };
  const videoPlayer = useRef<VideoTicketPlayer | null>(null);

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

    // Video is fetched after the audio finishes: the server allows one large transfer per member at a time.
    const loadVideo = () => {
      if (!active || !meeting?.hasVideo) return;
      setVideoLoading(true);
      setVideoError(null);
      // No download into memory: a ticket, then the <video> streams ranges from the kernel by itself.
      const player = createVideoTicketPlayer({
        fetchTicket: () => fetchVideoTicket(meeting.id),
        urlFor: (ticket) => videoStreamUrl(meeting.id, ticket),
        element: () => videoRef.current,
        onFailure: (err) => {
          if (active) setVideoError(err instanceof Error && err.message === 'VIDEO_TICKET_INVALID' ? t('detail.videoPlayFailed') : errorMessage(err));
        },
      });
      videoPlayer.current = player;
      player
        .start()
        .then((url) => {
          if (active) setVideoUrl(url);
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
      videoPlayer.current?.stop();
      videoPlayer.current = null;
      if (createdAudioUrl) URL.revokeObjectURL(createdAudioUrl);
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
          <span aria-hidden="true">&larr;</span> {t('detail.back')}
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
        subtitle={orgQuery.data ? t('detail.recordedBy', { user: memberLabel(orgMembers, meeting.recorderUserId, t('results.unknownMember')), date: f.date(meeting.createdAt) }) : undefined}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant={STATUS_VARIANTS[meeting.status] ?? 'outline'}>{t(`status.${meeting.status}`)}</Badge>
            <Badge variant="outline">
              {meeting.visibility === 'org' ? t('badgeOrg') : t('badgeAttendees')}
            </Badge>
          </div>
        }
      />
      {/* A recording that ended without the recorder's click leaves a visible line (A1, #3159): when it stopped and why, in plain words. */}
      <RecordingStoppedNote meeting={meeting} />
      {/* The recorder's own Vy offers up to three titles on a click (#3947); a pick renames the meeting, nothing changes before it */}
      <MeetingTitleSuggest key={`title-${id}`} meetingId={id} isRecorder={meeting.isRecorder} hasTranscript={hasTranscript} />

      {/* AI Off Status Card: gone once the meeting has a transcript */}
      {!hasTranscript && (
        <Card className="border-primary/20 bg-primary/5">
          <CardHeader>
            <CardTitle role="heading" aria-level={2} className="text-sm font-semibold text-primary">
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
              <CardTitle role="heading" aria-level={2} className="text-base font-medium">{t('detail.audioPlayerTitle')}</CardTitle>
            </CardHeader>
            <CardContent>
              {audioLoading && <div role="status" className="text-xs text-muted-foreground">{t('detail.loadingMedia')}</div>}
              {audioError && <ErrorText>{audioError}</ErrorText>}
              {audioUrl && <audio ref={audioRef} controls aria-label={t('detail.audioPlayerTitle')} className="w-full" src={audioUrl} />}
            </CardContent>
          </Card>
        )}

        {meeting.hasVideo && (
          <Card>
            <CardHeader>
              <CardTitle role="heading" aria-level={2} className="text-base font-medium">{t('detail.videoPlayerTitle')}</CardTitle>
            </CardHeader>
            <CardContent>
              {videoLoading && <div role="status" className="text-xs text-muted-foreground">{t('detail.loadingMedia')}</div>}
              {videoError && <ErrorText>{videoError}</ErrorText>}
              {videoUrl && (
                <video
                  ref={videoRef}
                  controls
                  aria-label={t('detail.videoPlayerTitle')}
                  preload="metadata"
                  className="w-full max-h-96 rounded-lg bg-muted"
                  src={videoUrl}
                  onLoadedMetadata={() => videoPlayer.current?.mediaLoaded()}
                  onError={() => videoPlayer.current?.mediaError()}
                />
              )}
            </CardContent>
          </Card>
        )}

        {!meeting.hasAudio && !meeting.hasVideo && (
          <Empty title={t('detail.noMedia')} />
        )}
      </div>

      {/* An import the member started (C1, #3173): its copied audio is claimed here too */}
      <ImportAutoClaim />

      {/* The recorder's own calendar (B1, #3165): link this recording to the one event it overlaps, after a click */}
      {meeting.isRecorder && <AgendaAttach meetingId={id} />}

      <MeetingLive meetingId={id} liveNotes={meeting.liveNotes} isRecorder={meeting.isRecorder} />
      {/* Each keyed child below has a key of its own: the same key on siblings makes React duplicate or drop children on a re-render (#4066) */}
      {/* The chapters (#3844): the published table of contents for every reader, the recorder's own draft editor; a click takes the transcript below to the line */}
      <MeetingChapters key={`chapters-${id}`} meetingId={id} isRecorder={meeting.isRecorder} onJump={jumpTo} />
      {/* What each speaker said they would do or decided (#3954): the recorder's own Vy on a click, each line opens the transcript where it was said, nothing is saved */}
      <MeetingCommitments key={`commitments-${id}`} meetingId={id} isRecorder={meeting.isRecorder} hasTranscript={hasTranscript} onJump={jumpTo} />
      {/* The transcript: the recorder's draft, or what was shared with the meeting */}
      <MeetingTranscript key={`transcript-${id}`} meetingId={id} {...(seg ? { focusSegmentId: seg } : {})} focusSecond={jump} platformCut={meeting.platformTranscriptCut} />
      {/* Did the meeting cover its agenda (#3959): the recorder's own click, Vy compares the agenda with the transcript above and cites the lines */}
      <MeetingAdherence key={`adherence-${id}`} meetingId={id} isRecorder={meeting.isRecorder} onJump={jumpTo} />
      {/* The recorder's own rough notes (A5): theirs alone, so only the recorder gets the box */}
      {/* What to bring to the next meeting of a series (#3543): the previous meeting's decisions, the open items, the linked customer's open deals, and Vy's few sentences on a click */}
      <MeetingBrief slug={slug} meetingId={id} />
      {/* The open items of the previous meeting of its series (#3542), and the recorder's way to put a meeting in a series */}
      <MeetingSeries meetingId={id} isRecorder={meeting.isRecorder} startedAt={meeting.startedAt} />
      {meeting.isRecorder && <MeetingNotes meetingId={id} minutesTemplate={meeting.minutesTemplate} />}
      <MeetingResults
        key={`results-${id}`}
        meetingId={id}
        slug={slug}
        visibility={meeting.visibility}
        readers={meeting.readers}
        template={meeting.summaryTemplate}
        minutesTemplate={meeting.minutesTemplate}
        title={meeting.title}
        {...(orgQuery.data
          ? {
              signInfo: {
                startedAt: meeting.startedAt,
                createdAt: meeting.createdAt,
                endedAt: meeting.endedAt,
                recorderUserId: meeting.recorderUserId,
                companyName: orgQuery.data.name,
                orgMembers,
                canEdit: orgQuery.data.role !== 'viewer',
              },
            }
          : {})}
        minutesLink={
          <Link to="/o/$slug/print/meeting-minutes/$id" params={{ slug, id }} className="text-sm text-link underline">
            {t('minutes.open')}
          </Link>
        }
      />

      {notesInstalled() && (
        <RecordNotesPanel
          slug={slug}
          target={{ targetType: 'meetings.meeting', targetId: meeting.id }}
          headingId={`notes-meeting-${meeting.id}`}
          label={tn('panel.toggleOf', { name: meeting.title })}
          empty={tn('panel.emptyRecord')}
        />
      )}

      <div className="grid gap-6 md:grid-cols-2">
        {/* Consent Record Card */}
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2} className="text-sm font-medium">{t('detail.consentRecord')}</CardTitle>
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

        <MeetingLinks meetingId={meeting.id} isRecorder={meeting.isRecorder} />

        {/* Readers List Card */}
        {meeting.visibility === 'attendees' && (
          <Card>
            <CardHeader>
              <CardTitle role="heading" aria-level={2} className="text-sm font-medium">
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
                    <span id={`reader-name-${readerUserId}`}>{memberLabel(orgMembers, readerUserId, t('results.unknownMember'))}</span>
                    {meeting.isRecorder && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:bg-destructive/10"
                        aria-describedby={`reader-name-${readerUserId}`}
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
