// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import {
  MEETING_AUDIO_RETENTION_CHOICES,
  MEETING_PLATFORMS,
  MEETING_STATUSES,
  MEETING_TEXT_RETENTION_CHOICES,
  MEETING_VIDEO_RETENTION_CHOICES,
  type LiveConsentMethod,
  type MeetingLanguage,
  type MeetingPlatform,
  type MeetingSettings,
  type MeetingStatus,
  type MeetingSummary,
  type MeetingVisibility,
} from '@ludy/kernel-contract';
import { RECORDING_NOTICE } from '@ludy/meeting-recorder';
import { Badge } from '@ludy/ui/components/badge';
import { Button, buttonVariants } from '@ludy/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ludy/ui/components/card';
import { Checkbox } from '@ludy/ui/components/checkbox';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@ludy/ui/components/dialog';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@ludy/ui/components/popover';
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@ludy/ui/components/sheet';
import { TableCell, TableRow } from '@ludy/ui/components/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ludy/ui/components/tabs';
import { DataTable, Empty, ErrorText, ListSkeleton, PageHeader } from '../components/ui.tsx';
import { MeetingSearch } from '../components/meeting-search.tsx';
import { MeetingAsk } from '../components/meeting-ask.tsx';
import { MeetingDigest } from '../components/meeting-digest.tsx';
import { TodayAgenda, UpcomingAgenda } from '../components/meeting-agenda.tsx';
import { ImportAutoClaim } from '../components/meeting-import-claim.tsx';
import { meetingsInstalled } from '../components/linked-meetings.tsx';
import { PlatformRecordings } from '../components/meeting-recordings.tsx';
import { ConsentPolicyCard, useConsentPolicy } from '../components/consent-policy.tsx';
import { MeetingHookCard } from '../components/meeting-hook.tsx';
import { MinutesChannelsCard } from '../components/meeting-chat.tsx';
import { RecordingNotice } from '../components/recording-notice.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient, uploadMeetingMedia } from '../lib/api.ts';
import {
  EMPTY_MEETING_FILTER,
  countActiveMeetingFilters,
  filterAndSortMeetings,
  formatMeetingDuration,
  hasActiveMeetingFilter,
  type MeetingListFilter,
  type MeetingMediaFilter,
  type MeetingSort,
} from '../lib/meetings-list.ts';
import { toast } from '../lib/toast.ts';

const STATUS_VARIANTS: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  ready: 'default',
  completed: 'default',
  processing: 'secondary',
  error: 'destructive',
};

type MeetingsTab = 'recorded' | 'today' | 'upcoming';
type UtilityTool = 'digest' | 'ask' | 'search';

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
        <CardTitle role="heading" aria-level={2}>{t('title')}</CardTitle>
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
  const meetingsOn = meetingsInstalled();

  const [activeTab, setActiveTab] = useState<MeetingsTab>('recorded');
  const [activeTool, setActiveTool] = useState<UtilityTool | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filter, setFilter] = useState<MeetingListFilter>(EMPTY_MEETING_FILTER);
  const [sort, setSort] = useState<MeetingSort>('started_desc');
  const [modalOpen, setModalOpen] = useState(false);

  // Form state
  const [title, setTitle] = useState('');
  const [language, setLanguage] = useState<MeetingLanguage>('vi');
  const [visibility, setVisibility] = useState<MeetingVisibility>('attendees');
  const [keepVideo, setKeepVideo] = useState(false);
  const [consentMethod, setConsentMethod] = useState<LiveConsentMethod | ''>('');
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

  const meetingsQuery = useQuery(orpc.meetings.list.queryOptions({ input: { limit: 200 } }));
  const todayAgendaQuery = useQuery({
    ...orpc.meetings.today.facts.queryOptions({ input: {} }),
    enabled: meetingsOn,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const upcomingAgendaQuery = useQuery({
    ...orpc.meetings.agenda.list.queryOptions({ input: { range: 'upcoming' } }),
    enabled: meetingsOn,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const allMeetings = meetingsQuery.data ?? [];
  const filteredMeetings = useMemo(() => filterAndSortMeetings(allMeetings, filter, sort), [allMeetings, filter, sort]);
  const activeFilterCount = countActiveMeetingFilters(filter);
  const filterOrSearchActive = hasActiveMeetingFilter(filter);

  // Scoped J/K focus navigation across recorded meeting links without hijacking inputs, dialogs, or other tabs.
  useEffect(() => {
    if (activeTab !== 'recorded' || modalOpen || settingsOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key !== 'j' && key !== 'k') return;
      const active = document.activeElement;
      const targetEl = e.target instanceof Element ? e.target : null;
      const guardSelector = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [data-slot="popover-content"], [data-slot="sheet-content"]';
      if ((active instanceof Element && active.closest(guardSelector)) || targetEl?.closest(guardSelector)) return;
      if (document.querySelector('[role="dialog"], [data-slot="popover-content"]')) return;
      const links = Array.from(document.querySelectorAll<HTMLElement>('[data-meeting-row-link]'));
      if (links.length === 0) return;
      const idx = active instanceof HTMLElement ? links.indexOf(active) : -1;
      const nextIdx =
        key === 'j'
          ? idx === -1
            ? 0
            : Math.min(links.length - 1, idx + 1)
          : idx === -1
            ? links.length - 1
            : Math.max(0, idx - 1);
      e.preventDefault();
      links[nextIdx]?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [activeTab, modalOpen, settingsOpen]);

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

  const durationLabels = {
    hours: (hours: number) => t('duration.hours', { hours: String(hours) }),
    hoursMinutes: (hours: number, minutes: number) => t('duration.hoursMinutes', { hours: String(hours), minutes: String(minutes) }),
    minutes: (minutes: number) => t('duration.minutes', { minutes: String(minutes) }),
    seconds: (seconds: number) => t('duration.seconds', { seconds: String(seconds) }),
    empty: t('duration.empty'),
  };

  const activeChips: Array<{ key: string; label: string; clear: () => void }> = [];
  if (filter.search.trim() !== '') {
    activeChips.push({
      key: 'search',
      label: t('filters.searchChip', { value: filter.search.trim() }),
      clear: () => setFilter((cur) => ({ ...cur, search: '' })),
    });
  }
  if (filter.status !== 'all') {
    activeChips.push({
      key: 'status',
      label: `${t('filters.status')}: ${t(`status.${filter.status}`)}`,
      clear: () => setFilter((cur) => ({ ...cur, status: 'all' })),
    });
  }
  if (filter.visibility !== 'all') {
    activeChips.push({
      key: 'visibility',
      label: `${t('filters.visibility')}: ${filter.visibility === 'org' ? t('badgeOrg') : t('badgeAttendees')}`,
      clear: () => setFilter((cur) => ({ ...cur, visibility: 'all' })),
    });
  }
  if (filter.media !== 'all') {
    const mediaLabel =
      filter.media === 'audio'
        ? t('badgeAudio')
        : filter.media === 'video'
          ? t('badgeVideo')
          : t('badgeTranscript');
    activeChips.push({
      key: 'media',
      label: `${t('filters.media')}: ${mediaLabel}`,
      clear: () => setFilter((cur) => ({ ...cur, media: 'all' })),
    });
  }
  if (filter.platform !== 'all') {
    activeChips.push({
      key: 'platform',
      label: `${t('filters.platform')}: ${t(`agenda.service.${filter.platform}`)}`,
      clear: () => setFilter((cur) => ({ ...cur, platform: 'all' })),
    });
  }

  const toggleTool = (tool: UtilityTool) => setActiveTool((cur) => (cur === tool ? null : tool));

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setSettingsOpen(true)}
              data-testid="meetings-settings-trigger"
              className="max-md:min-h-11"
            >
              {t('settingsTrigger')}
            </Button>
            <Link to="/o/$slug/meetings/record" params={{ slug }} className={buttonVariants({ variant: 'outline', className: 'max-md:min-h-11' })}>
              {t('record.open')}
            </Link>
            <Button type="button" onClick={() => setModalOpen(true)} className="max-md:min-h-11">
              {t('new')}
            </Button>
          </div>
        }
      />

      {/* Recordings a meeting platform finished (C1, #3173): the member's own, imported with a click; the copied audio is claimed on the next visit to any Meetings page. */}
      <ImportAutoClaim />

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as MeetingsTab)} data-testid="meetings-tabs">
        <TabsList className="w-full sm:w-fit flex-wrap">
          <TabsTrigger value="recorded" data-testid="meetings-tab-recorded">
            <span>{t('tabs.recorded')}</span>
            {meetingsQuery.data !== undefined && (
              <Badge variant="secondary" className="tabular-nums">
                {f.number(allMeetings.length)}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="today" data-testid="meetings-tab-today">
            <span>{t('tabs.today')}</span>
            {todayAgendaQuery.data?.enabled && todayAgendaQuery.data.items.length > 0 && (
              <Badge variant="secondary" className="tabular-nums">
                {f.number(todayAgendaQuery.data.items.length)}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="upcoming" data-testid="meetings-tab-upcoming">
            <span>{t('tabs.upcoming')}</span>
            {upcomingAgendaQuery.data?.enabled && upcomingAgendaQuery.data.events.length > 0 && (
              <Badge variant="secondary" className="tabular-nums">
                {f.number(upcomingAgendaQuery.data.events.length)}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="recorded" className="space-y-4 pt-2">
          <PlatformRecordings slug={slug} />

          {/* Compact collapsible utility strip: at most one AI/search tool expanded at a time so the table stays above the fold. */}
          <div className="space-y-3" data-testid="meetings-utility-strip">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant={activeTool === 'digest' ? 'secondary' : 'outline'}
                size="sm"
                className="max-md:min-h-11"
                aria-expanded={activeTool === 'digest'}
                aria-controls="meetings-tool-panel-digest"
                data-testid="meetings-tool-digest"
                onClick={() => toggleTool('digest')}
              >
                {t('tools.digest')}
              </Button>
              <Button
                type="button"
                variant={activeTool === 'ask' ? 'secondary' : 'outline'}
                size="sm"
                className="max-md:min-h-11"
                aria-expanded={activeTool === 'ask'}
                aria-controls="meetings-tool-panel-ask"
                data-testid="meetings-tool-ask"
                onClick={() => toggleTool('ask')}
              >
                {t('tools.ask')}
              </Button>
              <Button
                type="button"
                variant={activeTool === 'search' ? 'secondary' : 'outline'}
                size="sm"
                className="max-md:min-h-11"
                aria-expanded={activeTool === 'search'}
                aria-controls="meetings-tool-panel-search"
                data-testid="meetings-tool-search"
                onClick={() => toggleTool('search')}
              >
                {t('tools.search')}
              </Button>
            </div>
            <div id="meetings-tool-panel-digest" hidden={activeTool !== 'digest'}>
              {activeTool === 'digest' && <MeetingDigest slug={slug} />}
            </div>
            <div id="meetings-tool-panel-ask" hidden={activeTool !== 'ask'} className="rounded-lg border border-border bg-card p-4">
              {activeTool === 'ask' && <MeetingAsk slug={slug} />}
            </div>
            <div id="meetings-tool-panel-search" hidden={activeTool !== 'search'} className="rounded-lg border border-border bg-card p-4">
              {activeTool === 'search' && <MeetingSearch slug={slug} />}
            </div>
          </div>

          <div className="space-y-2" data-testid="meetings-toolbar">
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-48 flex-1 sm:max-w-sm">
                <Label htmlFor="meeting-search" className="sr-only">
                  {t('searchLabel')}
                </Label>
                <Input
                  id="meeting-search"
                  type="search"
                  placeholder={t('searchPlaceholder')}
                  value={filter.search}
                  onChange={(e) => setFilter((cur) => ({ ...cur, search: e.target.value }))}
                  className="max-md:min-h-11"
                />
              </div>

              <Popover>
                <PopoverTrigger
                  data-testid="meetings-filter-trigger"
                  aria-label={activeFilterCount > 0 ? t('filters.buttonCount', { count: String(activeFilterCount) }) : t('filters.button')}
                  render={<Button type="button" variant="outline" className="shrink-0 max-md:min-h-11" />}
                >
                  {t('filters.button')}
                  {activeFilterCount > 0 && (
                    <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground tabular-nums">
                      {activeFilterCount}
                    </span>
                  )}
                </PopoverTrigger>
                <PopoverContent data-testid="meetings-filter-popover">
                  <PopoverTitle>{t('filters.button')}</PopoverTitle>
                  <div className="mt-3 flex flex-col gap-3">
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="meeting-filter-status" className="text-xs text-subtle-foreground">
                        {t('filters.status')}
                      </Label>
                      <NativeSelect
                        id="meeting-filter-status"
                        size="sm"
                        className="w-full [&_select]:max-md:min-h-11"
                        value={filter.status}
                        onChange={(e) => setFilter((cur) => ({ ...cur, status: e.target.value as MeetingStatus | 'all' }))}
                      >
                        <NativeSelectOption value="all">{t('filters.all')}</NativeSelectOption>
                        {MEETING_STATUSES.map((s) => (
                          <NativeSelectOption key={s} value={s}>
                            {t(`status.${s}`)}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </div>

                    <div className="flex flex-col gap-1">
                      <Label htmlFor="meeting-filter-visibility" className="text-xs text-subtle-foreground">
                        {t('filters.visibility')}
                      </Label>
                      <NativeSelect
                        id="meeting-filter-visibility"
                        size="sm"
                        className="w-full [&_select]:max-md:min-h-11"
                        value={filter.visibility}
                        onChange={(e) => setFilter((cur) => ({ ...cur, visibility: e.target.value as MeetingVisibility | 'all' }))}
                      >
                        <NativeSelectOption value="all">{t('filters.all')}</NativeSelectOption>
                        <NativeSelectOption value="attendees">{t('badgeAttendees')}</NativeSelectOption>
                        <NativeSelectOption value="org">{t('badgeOrg')}</NativeSelectOption>
                      </NativeSelect>
                    </div>

                    <div className="flex flex-col gap-1">
                      <Label htmlFor="meeting-filter-media" className="text-xs text-subtle-foreground">
                        {t('filters.media')}
                      </Label>
                      <NativeSelect
                        id="meeting-filter-media"
                        size="sm"
                        className="w-full [&_select]:max-md:min-h-11"
                        value={filter.media}
                        onChange={(e) => setFilter((cur) => ({ ...cur, media: e.target.value as MeetingMediaFilter }))}
                      >
                        <NativeSelectOption value="all">{t('filters.all')}</NativeSelectOption>
                        <NativeSelectOption value="audio">{t('badgeAudio')}</NativeSelectOption>
                        <NativeSelectOption value="video">{t('badgeVideo')}</NativeSelectOption>
                        <NativeSelectOption value="transcript">{t('badgeTranscript')}</NativeSelectOption>
                      </NativeSelect>
                    </div>

                    <div className="flex flex-col gap-1">
                      <Label htmlFor="meeting-filter-platform" className="text-xs text-subtle-foreground">
                        {t('filters.platform')}
                      </Label>
                      <NativeSelect
                        id="meeting-filter-platform"
                        size="sm"
                        className="w-full [&_select]:max-md:min-h-11"
                        value={filter.platform}
                        onChange={(e) => setFilter((cur) => ({ ...cur, platform: e.target.value as MeetingPlatform | 'all' }))}
                      >
                        <NativeSelectOption value="all">{t('filters.all')}</NativeSelectOption>
                        {MEETING_PLATFORMS.map((p) => (
                          <NativeSelectOption key={p} value={p}>
                            {t(`agenda.service.${p}`)}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </div>

                    {activeFilterCount > 0 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="max-md:min-h-11"
                        data-testid="meetings-filter-reset"
                        onClick={() => setFilter((cur) => ({ ...EMPTY_MEETING_FILTER, search: cur.search }))}
                      >
                        {t('filters.reset')}
                      </Button>
                    )}
                  </div>
                </PopoverContent>
              </Popover>

              <NativeSelect
                id="meeting-sort"
                aria-label={t('sort.label')}
                className="[&_select]:max-md:min-h-11"
                value={sort}
                onChange={(e) => setSort(e.target.value as MeetingSort)}
              >
                <NativeSelectOption value="started_desc">{t('sort.startedDesc')}</NativeSelectOption>
                <NativeSelectOption value="started_asc">{t('sort.startedAsc')}</NativeSelectOption>
                <NativeSelectOption value="title_asc">{t('sort.titleAsc')}</NativeSelectOption>
                <NativeSelectOption value="duration_desc">{t('sort.durationDesc')}</NativeSelectOption>
              </NativeSelect>
            </div>

            {filterOrSearchActive && meetingsQuery.data !== undefined && (
              <div className="flex flex-wrap items-center gap-2">
                {activeChips.map((chip) => (
                  <button
                    key={chip.key}
                    type="button"
                    onClick={chip.clear}
                    aria-label={t('filters.removeChip', { label: chip.label })}
                    className="inline-flex min-h-6 max-md:min-h-11 items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2.5 py-0.5 text-xs text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    data-testid={`meetings-chip-${chip.key}`}
                  >
                    <span>{chip.label}</span>
                    <span aria-hidden="true">×</span>
                  </button>
                ))}
                <p role="status" className="text-xs text-muted-foreground" data-testid="meetings-filtered-count">
                  {t('filters.showingCount', { shown: f.number(filteredMeetings.length), total: f.number(allMeetings.length) })}
                </p>
              </div>
            )}
          </div>

          {meetingsQuery.isPending && !meetingsQuery.error ? (
            <ListSkeleton />
          ) : meetingsQuery.error ? (
            <ErrorText>{errorMessage(meetingsQuery.error)}</ErrorText>
          ) : allMeetings.length === 0 ? (
            <Empty
              title={t('empty')}
              hint={t('emptyHint')}
              action={
                <Button type="button" onClick={() => setModalOpen(true)} className="max-md:min-h-11">
                  {t('new')}
                </Button>
              }
            />
          ) : filteredMeetings.length === 0 ? (
            <Empty
              title={t('filters.emptyTitle')}
              hint={t('filters.emptyHint')}
              action={
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setFilter(EMPTY_MEETING_FILTER)}
                  className="max-md:min-h-11"
                  data-testid="meetings-clear-filters"
                >
                  {t('filters.reset')}
                </Button>
              }
            />
          ) : (
            <DataTable
              stacked
              head={[t('table.colMeeting'), t('table.colWhen'), t('table.colSummary'), t('table.colRetention')]}
            >
              {filteredMeetings.map((m: MeetingSummary) => {
                const duration = m.lengthSeconds === null ? null : formatMeetingDuration(m.lengthSeconds, durationLabels);
                return (
                  <TableRow key={m.id} data-testid="meeting-row">
                    <TableCell data-label={t('table.colMeeting')} className="px-4 py-3">
                      <div className="inline-flex flex-wrap items-center gap-2">
                        <Link
                          data-meeting-row-link
                          to="/o/$slug/meetings/$id"
                          params={{ slug, id: m.id }}
                          className="inline-flex min-h-11 items-center rounded-sm font-semibold text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:min-h-6"
                        >
                          <span className="min-w-0 break-words">{m.title}</span>
                        </Link>
                        <Badge variant={STATUS_VARIANTS[m.status] ?? 'outline'}>{t(`status.${m.status}`)}</Badge>
                        {m.platform && <Badge variant="outline">{t(`agenda.service.${m.platform}`)}</Badge>}
                      </div>
                    </TableCell>
                    <TableCell data-label={t('table.colWhen')} className="px-4 py-3 text-xs text-muted-foreground">
                      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="text-foreground">{f.dateTime(m.startedAt ?? m.createdAt)}</span>
                        {duration && <span className="font-mono tabular-nums">{duration}</span>}
                      </span>
                    </TableCell>
                    <TableCell data-label={t('table.colSummary')} className="px-4 py-3">
                      <div className="inline-flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline">{m.visibility === 'org' ? t('badgeOrg') : t('badgeAttendees')}</Badge>
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {t('table.readersCount', { count: m.readersCount })}
                        </span>
                        {m.hasAudio && <Badge variant="secondary">{t('badgeAudio')}</Badge>}
                        {m.hasVideo && <Badge variant="secondary">{t('badgeVideo')}</Badge>}
                        {m.hasTranscript && <Badge variant="secondary">{t('badgeTranscript')}</Badge>}
                      </div>
                    </TableCell>
                    <TableCell data-label={t('table.colRetention')} className="px-4 py-3 text-xs text-muted-foreground tabular-nums">
                      {f.date(m.audioRetentionDate)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </DataTable>
          )}
        </TabsContent>

        <TabsContent value="today" className="pt-2">
          <TodayAgenda slug={slug} />
        </TabsContent>

        <TabsContent value="upcoming" className="pt-2">
          <UpcomingAgenda slug={slug} />
        </TabsContent>
      </Tabs>

      {/* Settings Drawer */}
      <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
        <SheetContent closeLabel={t('settingsDrawer.close')} data-testid="meetings-settings-sheet" className="sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>{t('settingsDrawer.title')}</SheetTitle>
            <SheetDescription>{t('settingsDrawer.description')}</SheetDescription>
          </SheetHeader>
          <SheetBody className="space-y-4">
            {settingsOpen && (
              <>
                <RetentionSettingsCard />
                <ConsentPolicyCard />
                <MeetingHookCard />
                <MinutesChannelsCard />
              </>
            )}
          </SheetBody>
        </SheetContent>
      </Sheet>

      {/* New Meeting Modal with Mandatory Consent Gate */}
      <Dialog
        open={modalOpen}
        onOpenChange={(open) => {
          // A running create-and-upload is not dismissed: its result would land on a later draft.
          if (!open && submitting) return;
          setModalOpen(open);
          if (!open) resetForm();
        }}
      >
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
                accept="audio/*,video/*,.mp3,.m4a,.wav,.aac,.ogg,.webm,.opus,.mp4,.mov,.m4v"
                aria-describedby="meeting-audio-hint"
                onChange={(e) => setAudioFile(e.target.files?.[0] ?? null)}
                disabled={uploadedKinds.includes('audio')}
              />
              <p id="meeting-audio-hint" className="text-xs text-muted-foreground">
                {t('form.audioFileVideoHint')}
              </p>
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
                  onChange={(e) => setConsentMethod(e.target.value as LiveConsentMethod)}
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
