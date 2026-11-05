// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { ConfirmDialog } from '../components/confirm-dialog.tsx';
import { Empty, ErrorText, ListSkeleton, PageHeader } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { apiFetch, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { toast } from '../lib/toast.ts';

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

  const meeting = meetingQuery.data;

  useEffect(() => {
    let active = true;
    let createdAudioUrl: string | null = null;
    let createdVideoUrl: string | null = null;

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
        });
    }

    if (meeting?.hasVideo) {
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
    }

    return () => {
      active = false;
      if (createdAudioUrl) URL.revokeObjectURL(createdAudioUrl);
      if (createdVideoUrl) URL.revokeObjectURL(createdVideoUrl);
    };
  }, [meeting?.id, meeting?.hasAudio, meeting?.hasVideo]);

  const deleteMutation = useMutation({
    mutationFn: () => orpc.meetings.delete.call({ meetingId: id }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: orpc.meetings.key() });
      toast('Đã xóa cuộc họp và tiêu hủy khóa giải mã vĩnh viễn', 'success');
      void navigate({ to: '/o/$slug/meetings', params: { slug } });
    },
    onError: (err) => {
      toast(errorMessage(err), 'error');
    },
  });

  const addReaderMutation = useMutation({
    mutationFn: (userId: string) =>
      orpc.meetings.readers.add.call({ meetingId: id, userId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: orpc.meetings.key() });
      setNewReaderUserId('');
      setReaderError(null);
      toast('Đã thêm người xem cuộc họp', 'success');
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
      toast('Đã xóa quyền xem cuộc họp', 'success');
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
        <ErrorText>{errorMessage(meetingQuery.error ?? new Error('Không tìm thấy cuộc họp'))}</ErrorText>
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
        <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)}>
          {t('detail.delete')}
        </Button>
      </div>

      <PageHeader
        title={meeting.title}
        subtitle={`Người ghi: ${meeting.recorderUserId} • Tạo lúc: ${f.date(meeting.createdAt)}`}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant={STATUS_VARIANTS[meeting.status] ?? 'outline'}>{meeting.status}</Badge>
            <Badge variant="outline">
              {meeting.visibility === 'org' ? 'Toàn tổ chức' : 'Người tham gia'}
            </Badge>
          </div>
        }
      />

      {/* AI Off Status Card */}
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
          <Empty title="Chưa có bản ghi âm hoặc video cho cuộc họp này" />
        )}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Consent Record Card */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">{t('detail.consentRecord')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            <div>
              <span className="font-semibold text-muted-foreground">Hình thức: </span>
              <span>{meeting.consentMethod}</span>
            </div>
            <div>
              <span className="font-semibold text-muted-foreground">Phiên bản thông báo: </span>
              <span>{meeting.consentNoticeVersion}</span>
            </div>
            <div>
              <span className="font-semibold text-muted-foreground">Xác nhận lúc: </span>
              <span>{f.date(meeting.consentConfirmedAt)}</span>
            </div>
            <div>
              <span className="font-semibold text-muted-foreground">Hạn lưu trữ âm thanh: </span>
              <span>{meeting.audioRetentionDate}</span>
            </div>
            <div>
              <span className="font-semibold text-muted-foreground">Hạn lưu trữ văn bản: </span>
              <span>{meeting.textRetentionDate}</span>
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
              <form onSubmit={handleAddReader} className="flex gap-2">
                <Input
                  placeholder="User ID của người xem"
                  value={newReaderUserId}
                  onChange={(e) => setNewReaderUserId(e.target.value)}
                  className="text-xs"
                />
                <Button type="submit" size="sm" disabled={!newReaderUserId.trim() || addReaderMutation.isPending}>
                  {t('detail.addReader')}
                </Button>
              </form>
              {readerError && <ErrorText>{readerError}</ErrorText>}

              <ul className="divide-y text-xs">
                {meeting.readers.map((readerUserId) => (
                  <li key={readerUserId} className="flex items-center justify-between py-2">
                    <span className="font-mono">{readerUserId}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10"
                      onClick={() => removeReaderMutation.mutate(readerUserId)}
                    >
                      {t('detail.removeReader')}
                    </Button>
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
        title={t('detail.deleteConfirmTitle')}
        description={t('detail.deleteConfirmBody')}
        confirm={t('detail.deleteButton')}
        destructive
        onConfirm={() => deleteMutation.mutate()}
      />
    </div>
  );
}
