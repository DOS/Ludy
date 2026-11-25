// SPDX-License-Identifier: AGPL-3.0-only
// "Xem biên bản" (Meetings A4, #3162): the printable minutes of a meeting in the layout Vietnamese offices use. The browser prints it (to PDF as well); there is no document
// library. It reads what the meeting's readers may read (the recorder a draft beside the published result, a reader the published one only) and SHOWS only what the recorder
// published; until then it says "Bản nháp". The facts come from the meeting row and code (see lib/minutes.ts); Ludy signs nothing, so the signature block is blank.
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import type { MeetingSummaryTemplate } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { MinutesDocxButton } from '../components/meeting-minutes-docx.tsx';
import { canCreateMeetingMinutesEnvelope, MeetingMinutesSignHandoff } from '../components/meeting-minutes-sign-handoff.tsx';
import { memberLabel } from '../components/meeting-results.tsx';
import { ErrorText, ListSkeleton } from '../components/ui.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { buildMinutes, type MinutesModel } from '../lib/minutes.ts';
import { usePrintInLight } from '../lib/print.ts';
import { useScreenTitle } from '../lib/screen-title.ts';

// Reading the results is a sensitive read that leaves an audit row: no refetch on focus or remount.
const READ_ONCE = { staleTime: 5 * 60_000, refetchOnWindowFocus: false } as const;
const DOTS = '………………………………';

export function MinutesSheet({ model, company, title, place, template }: { model: MinutesModel; company: string; title: string; place: string; template: MeetingSummaryTemplate }) {
  const t = useTranslations('meetings');
  const m = model;
  const clock = m.to
    ? t('minutes.timeRange', { from: m.from.time, to: m.to.time, day: m.from.day, month: m.from.month, year: m.from.year })
    : t('minutes.timeStart', { from: m.from.time, day: m.from.day, month: m.from.month, year: m.from.year });
  return (
    <article className="minutes-sheet mx-auto max-w-[210mm] space-y-4 bg-card p-4 text-[13px] sm:p-8 leading-relaxed text-card-foreground shadow-sm print:p-0 print:shadow-none" data-testid="minutes-sheet">
      <header className="space-y-3">
        <p className="text-sm font-semibold uppercase">{company}</p>
        <div className="text-center">
          <h1 className="text-xl font-bold tracking-wide">{t('minutes.heading')}</h1>
          <p className="font-medium">{t('minutes.subject', { title })}</p>
          {!m.published && (
            <p className="mt-2 inline-block rounded border-2 border-foreground px-3 py-1 text-base font-bold uppercase tracking-widest" data-testid="minutes-draft">
              {t('minutes.draft')}
            </p>
          )}
        </div>
      </header>

      <dl className="space-y-1">
        <div className="flex gap-2">
          <dt className="font-semibold">{t('minutes.time')}:</dt>
          <dd>{clock}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="font-semibold">{t('minutes.place')}:</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere]" data-testid="minutes-place">{place.trim() === '' ? DOTS : place.trim()}</dd>
        </div>
        <div>
          <dt className="font-semibold">{t('minutes.attendees')}:</dt>
          <dd>
            <ul className="list-disc pl-6">
              {m.attendees.map((name, i) => (
                <li key={`${i}-${name}`}>{i === 0 ? `${name} (${t('minutes.recorder')})` : name}</li>
              ))}
            </ul>
          </dd>
        </div>
      </dl>

      {!m.published ? (
        <p className="rounded border border-dashed border-foreground p-3" data-testid="minutes-nothing">
          {t('minutes.draftNone')}
        </p>
      ) : (
        <>
          <section className="space-y-2">
            <h2 className="font-bold">{t('minutes.content')}</h2>
            {m.sections.length === 0 && <p>{t('minutes.noContent')}</p>}
            {m.sections.map((s, i) => (
              <div key={s.key ?? 'all'} className="space-y-1">
                {s.key !== null && (
                  <h3 className="font-semibold">
                    {i + 1}. {s.title ?? t(`templates.sections.${template}.${s.key}` as never)}
                  </h3>
                )}
                <p className="whitespace-pre-wrap">{s.text}</p>
              </div>
            ))}
          </section>

          <section className="space-y-2">
            <h2 className="font-bold">{t('minutes.conclusions')}</h2>
            {m.conclusions.length === 0 ? (
              <p>{t('minutes.noConclusions')}</p>
            ) : (
              <ul className="list-disc pl-6">
                {m.conclusions.map((c, i) => (
                  <li key={`${i}-${c}`}>{c}</li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="font-bold">{t('minutes.actions')}</h2>
            {m.actions.length === 0 ? (
              <p>{t('minutes.noActions')}</p>
            ) : (
              <table className="w-full border-collapse border border-foreground">
                <thead>
                  <tr>
                    <th scope="col" className="w-10 border border-foreground px-2 py-1 text-center sm:w-12">{t('minutes.colNo')}</th>
                    <th scope="col" className="border border-foreground px-2 py-1 text-left">{t('minutes.colTask')}</th>
                    <th scope="col" className="w-28 border border-foreground px-2 py-1 text-left sm:w-40">{t('minutes.colOwner')}</th>
                    <th scope="col" className="w-24 border border-foreground px-2 py-1 text-left sm:w-32">{t('minutes.colDue')}</th>
                  </tr>
                </thead>
                <tbody>
                  {m.actions.map((a, i) => (
                    <tr key={`${i}-${a.title}`} className="break-inside-avoid" data-testid="minutes-action">
                      <td className="border border-foreground px-2 py-1 text-center">{i + 1}</td>
                      <td className="border border-foreground px-2 py-1 [overflow-wrap:anywhere]">{a.title}</td>
                      <td className="border border-foreground px-2 py-1 [overflow-wrap:anywhere]">{a.owner ?? DOTS}</td>
                      <td className="border border-foreground px-2 py-1 [overflow-wrap:anywhere]">{a.due ?? DOTS}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}

      {/* Blank on purpose: people sign on paper or with their own e-signature tool; Ludy signs for no one. */}
      <footer className="grid grid-cols-2 gap-8 pt-6 text-center break-inside-avoid" data-testid="minutes-signatures">
        <div className="space-y-1">
          <p className="font-bold">{t('minutes.signRecorder')}</p>
          <p className="italic">{t('minutes.signHint')}</p>
          <div className="h-28" />
        </div>
        <div className="space-y-1">
          <p className="font-bold">{t('minutes.signChair')}</p>
          <p className="italic">{t('minutes.signHint')}</p>
          <div className="h-28" />
        </div>
      </footer>
    </article>
  );
}

export function MeetingMinutesPage() {
  const t = useTranslations('meetings');
  const { slug, id } = useParams({ strict: false }) as { slug: string; id: string };
  const [place, setPlace] = useState('');
  // Paper gets the light theme while printing, whatever the screen uses.
  usePrintInLight();
  // Outside the shell nothing else names the tab (WCAG 2.4.2, DESIGN.md section 7).
  useScreenTitle(t('minutes.pageTitle'));
  const meeting = useQuery(orpc.meetings.get.queryOptions({ input: { meetingId: id } }));
  const results = useQuery({ ...orpc.meetings.results.get.queryOptions({ input: { meetingId: id } }), ...READ_ONCE });
  const org = useQuery(orpc.org.get.queryOptions());
  const back = (
    <Link to="/o/$slug/meetings/$id" params={{ slug, id }} className="text-sm text-link underline">
      <span aria-hidden="true">&larr;</span> {t('minutes.back')}
    </Link>
  );
  // Outside the org's frame: the page lays out its own margins, and the toolbar leaves the paper. It is its own <main>, the one landmark of a page the shell does not wrap.
  const frame = (body: ReactNode) => <main className="min-h-screen bg-background px-4 py-6 text-foreground print:p-0">{body}</main>;
  if (meeting.isPending || results.isPending || org.isPending) return frame(<ListSkeleton />);
  const failure = meeting.error ?? results.error ?? org.error;
  if (failure || !meeting.data || !results.data || !org.data) {
    return frame(
      <div className="space-y-4">
        {back}
        <ErrorText>{errorMessage(failure ?? new Error(t('detail.notFound')))}</ErrorText>
      </div>,
    );
  }
  const members = org.data.members;
  const model = buildMinutes(meeting.data, results.data, (userId) => memberLabel(members, userId, t('results.unknownMember')));
  return frame(
    <div className="space-y-4">
      <div className="space-y-3 print:hidden">
        {back}
        <h1 className="text-lg font-semibold">{t('minutes.pageTitle')}</h1>
        <p className="text-xs text-muted-foreground">{t('minutes.screenNote')}</p>
        {model.newerDraft && model.published && <p className="text-sm font-medium">{t('minutes.draftNewer')}</p>}
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="minutes-place">{t('minutes.placeLabel')}</Label>
            <Input id="minutes-place" value={place} maxLength={200} onChange={(e) => setPlace(e.target.value)} className="w-72" />
            <p className="text-xs text-muted-foreground">{t('minutes.placeHint')}</p>
          </div>
          <Button onClick={() => window.print()}>{t('minutes.print')}</Button>
          {/* The published minutes as a Word file (#4774): built on the server from the published rows only. */}
          {model.published && <MinutesDocxButton meetingId={id} place={place} />}
          {model.published && (
            <MeetingMinutesSignHandoff
              source={{
                meeting: {
                  id: meeting.data.id,
                  title: meeting.data.title,
                  startedAt: meeting.data.startedAt,
                  createdAt: meeting.data.createdAt,
                  endedAt: meeting.data.endedAt,
                  recorderUserId: meeting.data.recorderUserId,
                  readers: meeting.data.readers,
                  summaryTemplate: meeting.data.summaryTemplate,
                  minutesTemplate: meeting.data.minutesTemplate,
                  isRecorder: meeting.data.isRecorder,
                },
                results: results.data,
                companyName: org.data.name,
                place,
                orgMembers: members,
              }}
              canEdit={canCreateMeetingMinutesEnvelope(org.data.role, meeting.data.isRecorder)}
            />
          )}
        </div>
        <p className="text-xs text-muted-foreground">{t('minutes.printHint')}</p>
      </div>
      <MinutesSheet model={model} company={org.data.name} title={meeting.data.title} place={place} template={meeting.data.summaryTemplate} />
    </div>,
  );
}
