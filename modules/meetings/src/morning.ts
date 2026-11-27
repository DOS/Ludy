// SPDX-License-Identifier: AGPL-3.0-only
// The opt-in morning notice and daily briefing of the day's meetings, the module's side (#3955 part B, #5080). A member who turns it on gets, once a day at the time they chose in their own time zone,
// one in-app notice and one mail. Count-only mode ('count') sends only the count and link; full mode ('full', optional 'vyLines') queues non-sensitive metadata (`{ lang, org, path, day }`) and fetches
// briefing content at render time inside the read-only `member_briefing` context.
//
// meetings.morning.get          the caller's own setting (off until they turn it on). Private: the row policy shows a member their own row only.
// meetings.morning.set          the caller turns the notice on (time of day, time zone, language, content mode, optional vyLines) or off (row deleted).
// meetings.morning.notice       the worker's dispatch, in the system's context, deriving the due row through ludy_meetings.morning_notices_due and queuing v1 or v2 mail.
// meetings.morning.mail_content the render-time read-only query inside member_briefing, reading calendar_agenda, readable meetings, org reader display names, previous published decisions,
//                               live open/overdue/mine action item flags via worker definer, O5 open CRM deals via crm queries, and gated 36h Vy prep lines.
import { sql } from 'kysely';
import { createMailMessage, notifyMembers, uploaderEntity } from '@ludy/kernel';
import {
  MORNING_BRIEFING_CAPS,
  MORNING_COUNT_MAX,
  MORNING_DEFAULT_MINUTE,
  MORNING_KIND,
  MORNING_MAIL_CONTENT_COMMAND,
  MORNING_MAIL_SOURCE,
  MORNING_MAIL_TEMPLATE,
  followupClean,
  zMorningBriefingContent,
  zMorningBriefingMail,
  zMorningCountMail,
  zMorningEmpty,
  zMorningMailContentInput,
  zMorningNotice,
  zMorningSet,
  zMorningState,
  zTimeZoneName,
  type MorningBriefingContent,
  type MorningBriefingDeal,
  type MorningBriefingMeeting,
  type MorningBriefingOpenItem,
  type MorningState,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { dayText, vnDay } from './retention.ts';
import { ROLES, userOf } from './transcript.ts';

// Fixed mail subjects, one line: never carries a meeting title or count.
const SUBJECT = { vi: 'Hôm nay bạn có cuộc họp', en: 'You have meetings today' } as const;
const BRIEFING_SUBJECT = { vi: 'Lịch họp trong ngày', en: 'Daily meeting briefing' } as const;
const DEFAULT_ZONE = 'Asia/Ho_Chi_Minh';

const agendaLinkRank = (row: { meeting_id: string | null; series_id: string | null }): number =>
  row.meeting_id !== null ? 2 : row.series_id !== null ? 1 : 0;

function clampText(value: string, max: number): string {
  const cleaned = followupClean(value, true);
  const chars = Array.from(cleaned);
  return chars.length > max ? chars.slice(0, max).join('').trimEnd() : cleaned;
}

function safeTimeZone(value: string): string {
  return zTimeZoneName.safeParse(value).success ? value : DEFAULT_ZONE;
}

export const morningGet = defineQuery({
  name: 'meetings.morning.get',
  input: zMorningEmpty,
  access: ROLES,
  handler: async (ctx): Promise<MorningState> => {
    const userId = userOf(ctx.actor);
    const row = await ctx.trx
      .selectFrom('ludy_meetings.morning_notice')
      .select(['enabled', 'send_minute', 'time_zone', 'language', 'content', 'vy_lines'])
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return zMorningState.parse({
      enabled: row !== undefined && row.enabled,
      minute: row?.send_minute ?? MORNING_DEFAULT_MINUTE,
      timeZone: row?.time_zone ?? DEFAULT_ZONE,
      language: row?.language === 'en' ? 'en' : 'vi',
      content: row?.content === 'full' ? 'full' : 'count',
      vyLines: row?.vy_lines === true,
    });
  },
});

export const morningSet = defineCommand({
  name: 'meetings.morning.set',
  input: zMorningSet,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  handler: async (ctx, input): Promise<MorningState> => {
    const userId = userOf(ctx.actor);
    if (!input.enabled) {
      await ctx.trx.deleteFrom('ludy_meetings.morning_notice').where('org_id', '=', ctx.orgId).where('user_id', '=', userId).execute();
      ctx.audit({ enabled: false });
      return zMorningState.parse({
        enabled: false,
        minute: input.minute,
        timeZone: input.timeZone,
        language: input.language,
        content: 'count',
        vyLines: false,
      });
    }
    const vyLines = input.content === 'full' ? input.vyLines : false;
    // The member's own membership row, locked FOR KEY SHARE until this command commits: a removal of the member (a DELETE of that row, whose trigger deletes the setting) waits for the save, so the save cannot land
    // after the trigger and leave a setting for a departed member; and a save that meets a removal already committed finds no row and is refused. (A role change or a removal waits for the save to commit, for a moment; another save does not wait.)
    const member = await ctx.trx
      .selectFrom('ludy_kernel.tenant_member')
      .select('user_id')
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', userId)
      .forKeyShare()
      .executeTakeFirst();
    if (member === undefined) throw new DomainError('FORBIDDEN', 403, 'Bạn không còn là thành viên của tổ chức này');
    await ctx.trx
      .insertInto('ludy_meetings.morning_notice')
      .values({
        org_id: ctx.orgId,
        user_id: userId,
        send_minute: input.minute,
        time_zone: input.timeZone,
        language: input.language,
        enabled: true,
        content: input.content,
        vy_lines: vyLines,
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'user_id']).doUpdateSet({
          send_minute: input.minute,
          time_zone: input.timeZone,
          language: input.language,
          enabled: true,
          content: input.content,
          vy_lines: vyLines,
          updated_at: new Date(),
        }),
      )
      .execute();
    // Never store the zone name beside the member in the audit row: audit metadata records the notice preferences only.
    ctx.audit({ enabled: true, minute: input.minute, language: input.language, content: input.content, vyLines });
    return zMorningState.parse({
      enabled: true,
      minute: input.minute,
      timeZone: input.timeZone,
      language: input.language,
      content: input.content,
      vyLines,
    });
  },
});

export const morningNotice = defineCommand({
  name: 'meetings.morning.notice',
  input: zMorningNotice,
  // A mail is queued (an effect outside Ludy), so the command is R2 as the weekly status mail is; it runs only in the system's context.
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  handler: async (ctx, input): Promise<{ notified: boolean; mailed: boolean; notificationId?: string | null }> => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ hệ thống mới báo cuộc họp trong ngày');
    const { rows: found } = await sql<{ events: number; english: boolean }>`
      SELECT events, english FROM ludy_meetings.morning_notices_due(1::int, ${ctx.orgId}::uuid, ${input.userId}::uuid, ${input.day}::date)`.execute(ctx.trx);
    const due = found[0];
    // Nothing due any more (no meeting that day, turned off, muted, told already): nothing is written, not even an audit row.
    if (!due) return { notified: false, mailed: false };
    // The count the notice and the mail carry never passes the mail's own bound, so a day with more events than that is still told (and the mail still parses) instead of rolling back and being retried.
    const events = Math.min(due.events, MORNING_COUNT_MAX);
    const sent = await notifyMembers(ctx, {
      kind: MORNING_KIND,
      users: [input.userId],
      key: `morning:${input.day}`,
      // Nothing but the count: no title, no event, no subject (the line opens the meetings page).
      detail: { count: String(events) },
      legalEntityId: await uploaderEntity(ctx, input.userId),
    });
    // Turned off, left the org, or told already for this day: no in-app line, so no mail either.
    if (sent === 0) return { notified: false, mailed: false };
    // Read back the newly inserted notification id in the same transaction so the worker can queue browser push (#4082).
    const notice = await ctx.trx
      .selectFrom('ludy_kernel.notification')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', input.userId)
      .where('kind', '=', MORNING_KIND)
      .where('dedupe_key', '=', `morning:${input.day}`)
      .executeTakeFirst();
    const org = await ctx.trx.selectFrom('ludy_kernel.tenant').select(['slug', 'name']).where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
    // The member's address while they are a member with an account that is not disabled (the worker's member_emails: no name, no other account column).
    const { rows } = await sql<{ email: string | null }>`SELECT email FROM ludy_kernel.member_emails(${[input.userId]}::uuid[])`.execute(ctx.trx);
    const email = rows[0]?.email ?? null;
    // The function returns a flag, not the language's text (no text leaves a definer of ludy_meetings, meetings-readers.db.test.ts).
    const lang = due.english ? 'en' : 'vi';
    let mail: { status: 'sending' | 'queued' | 'suppressed' } | null = null;
    if (email) {
      const { rows: modeRows } = await sql<{ full: boolean }>`
        SELECT ludy_meetings.morning_notice_is_full(${ctx.orgId}::uuid, ${input.userId}::uuid) AS full`.execute(ctx.trx);
      const orgName = (org.name.trim() || org.slug).slice(0, 200);
      const meetingsPath = `/o/${org.slug}/meetings`;
      if (modeRows[0]?.full === true) {
        mail = await createMailMessage(ctx, {
          stream: 'transactional',
          source: MORNING_MAIL_SOURCE,
          sourceId: input.userId,
          templateKey: MORNING_MAIL_TEMPLATE,
          to: email,
          subject: BRIEFING_SUBJECT[lang],
          payload: zMorningBriefingMail.parse({ lang, org: orgName, path: meetingsPath, day: input.day }),
          status: 'queued',
        });
      } else {
        mail = await createMailMessage(ctx, {
          stream: 'transactional',
          source: MORNING_MAIL_SOURCE,
          templateKey: MORNING_MAIL_TEMPLATE,
          to: email,
          subject: SUBJECT[lang],
          payload: zMorningCountMail.parse({ lang, org: orgName, count: events, path: meetingsPath }),
          status: 'queued',
        });
      }
    }
    const mailed = mail?.status === 'queued';
    // A day and a flag only: no address and no per-member calendar count in the owner-visible audit row (#5018).
    ctx.audit({ day: input.day, mailed });
    return { notified: true, mailed, notificationId: notice?.id ?? null };
  },
});

async function loadBriefingDeals(
  ctx: QueryContext,
  sliceMeetings: ReadonlyArray<{ agendaId: string; readableMeetingId: string | null; previousMeetingId: string | null }>,
  allMeetingIds: readonly string[],
): Promise<Map<string, MorningBriefingDeal[]>> {
  const out = new Map<string, MorningBriefingDeal[]>();
  if (allMeetingIds.length === 0) return out;
  const linkRows = await ctx.trx
    .selectFrom('ludy_meetings.meeting_link')
    .select(['meeting_id', 'party_id', 'deal_id'])
    .where('org_id', '=', ctx.orgId)
    .where('meeting_id', 'in', allMeetingIds)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const linksByMeeting = new Map<string, Array<{ party_id: string | null; deal_id: string | null }>>();
  for (const row of linkRows) {
    const list = linksByMeeting.get(row.meeting_id) ?? [];
    list.push({ party_id: row.party_id, deal_id: row.deal_id });
    linksByMeeting.set(row.meeting_id, list);
  }

  let crmInstalled = true;
  const dealPartyById = new Map<string, string | null>();
  const resolvePartyForMeeting = async (meetingId: string): Promise<string | null> => {
    const links = linksByMeeting.get(meetingId);
    if (!links || links.length === 0) return null;
    const directParty = links.find((l) => l.party_id !== null)?.party_id ?? null;
    if (directParty !== null) return directParty;
    if (!crmInstalled) return null;
    for (const l of links) {
      if (l.deal_id === null) continue;
      if (dealPartyById.has(l.deal_id)) {
        const cached = dealPartyById.get(l.deal_id) ?? null;
        if (cached !== null) return cached;
        continue;
      }
      try {
        const deal = await ctx.query<{ partyId: string }>('crm.deal.get', { dealId: l.deal_id });
        if (deal.status === 'not_installed') {
          crmInstalled = false;
          return null;
        }
        dealPartyById.set(l.deal_id, deal.value.partyId);
        return deal.value.partyId;
      } catch (error) {
        if (error instanceof DomainError && error.code === 'DEAL_NOT_FOUND') {
          dealPartyById.set(l.deal_id, null);
          continue;
        }
        throw error;
      }
    }
    return null;
  };

  const partyByAgendaId = new Map<string, string>();
  for (const item of sliceMeetings) {
    for (const candidateId of [item.readableMeetingId, item.previousMeetingId]) {
      if (!candidateId) continue;
      const partyId = await resolvePartyForMeeting(candidateId);
      if (partyId !== null) {
        partyByAgendaId.set(item.agendaId, partyId);
        break;
      }
    }
  }
  if (!crmInstalled || partyByAgendaId.size === 0) return out;

  let stageNamesPromise: Promise<Map<string, string>> | undefined;
  const getStageNames = (): Promise<Map<string, string>> =>
    (stageNamesPromise ??= (async () => {
      const stages = await ctx.query<Array<{ id: string; name: string }>>('crm.stage.list', {});
      if (stages.status === 'not_installed') {
        crmInstalled = false;
        return new Map<string, string>();
      }
      return new Map(stages.value.map((s) => [s.id, s.name] as const));
    })());

  const dealsByParty = new Map<string, MorningBriefingDeal[]>();
  for (const partyId of new Set(partyByAgendaId.values())) {
    if (!crmInstalled) break;
    const listed = await ctx.query<{
      items: Array<{ id: string; title: string; amount: string; stageId: string; stageKind: string; expectedClose: string | null }>;
    }>('crm.deal.list', {
      partyId,
      status: 'open',
      limit: MORNING_BRIEFING_CAPS.dealsPerMeetingMax,
    });
    if (listed.status === 'not_installed') {
      crmInstalled = false;
      break;
    }
    const openDeals = listed.value.items.filter((d) => d.stageKind === 'open').slice(0, MORNING_BRIEFING_CAPS.dealsPerMeetingMax);
    if (openDeals.length === 0) {
      dealsByParty.set(partyId, []);
      continue;
    }
    const stages = await getStageNames();
    if (!crmInstalled) break;
    const mapped: MorningBriefingDeal[] = [];
    for (const deal of openDeals) {
      const title = clampText(deal.title, MORNING_BRIEFING_CAPS.dealTitleMax);
      if (title === '') continue;
      mapped.push({
        id: deal.id,
        title,
        stage: clampText(stages.get(deal.stageId) ?? '', MORNING_BRIEFING_CAPS.dealStageMax),
        stageKind: 'open',
        amount: /^0+(?:\.0+)?$/.test(deal.amount) ? null : deal.amount,
        expectedClose: deal.expectedClose,
      });
    }
    dealsByParty.set(partyId, mapped);
  }

  for (const [agendaId, partyId] of partyByAgendaId) {
    out.set(agendaId, dealsByParty.get(partyId) ?? []);
  }
  return out;
}

export const morningMailContent = defineQuery({
  name: MORNING_MAIL_CONTENT_COMMAND,
  input: zMorningMailContentInput,
  access: ROLES,
  memberBriefing: { reads: ['crm.stage.list', 'crm.deal.get', 'crm.deal.list'] },
  handler: async (ctx, input): Promise<MorningBriefingContent> => {
    if (!ctx.memberBriefing) {
      throw new DomainError('FORBIDDEN', 403, 'Chỉ ngữ cảnh bản tin sáng mới được chạy truy vấn này');
    }
    const memberUserId = ctx.memberBriefing.memberUserId;
    const { rows: windowRows } = await sql<{
      window_from: Date;
      window_to: Date;
      today: string;
      vy_lines: boolean;
    }>`
      SELECT window_from, window_to, today::text AS today, vy_lines
      FROM ludy_meetings.morning_briefing_window(${input.day}::date)`.execute(ctx.trx);
    const window = windowRows[0];
    if (!window) {
      return zMorningBriefingContent.parse({ day: input.day, totalMeetings: 0, meetings: [] });
    }
    const { rows: connRows } = await sql<{ id: string }>`
      SELECT id FROM ludy_meetings.morning_briefing_active_connections() AS t(id)`.execute(ctx.trx);
    const connectionIds = connRows.map((r) => r.id);
    if (connectionIds.length === 0) {
      return zMorningBriefingContent.parse({ day: input.day, totalMeetings: 0, meetings: [] });
    }

    const agendaRows = await ctx.trx
      .selectFrom('ludy_meetings.calendar_agenda')
      .select(['id', 'external_id', 'title', 'starts_at', 'ends_at', 'time_zone', 'invitee_count', 'meeting_id', 'series_id'])
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', memberUserId)
      .where('connection_id', 'in', connectionIds)
      .where('starts_at', '>=', new Date(window.window_from))
      .where('starts_at', '<', new Date(window.window_to))
      .orderBy('starts_at')
      .orderBy('id')
      .limit(MORNING_COUNT_MAX)
      .execute();

    const deduped = new Map<string, (typeof agendaRows)[number]>();
    for (const row of agendaRows) {
      const key = `${row.external_id}\0${new Date(row.starts_at).toISOString()}`;
      const existing = deduped.get(key);
      if (!existing || agendaLinkRank(row) > agendaLinkRank(existing)) {
        deduped.set(key, row);
      }
    }
    const uniqueAgenda = [...deduped.values()];
    const totalMeetings = Math.min(uniqueAgenda.length, MORNING_COUNT_MAX);
    const slice = uniqueAgenda.slice(0, MORNING_BRIEFING_CAPS.meetingsMax);
    if (slice.length === 0) {
      return zMorningBriefingContent.parse({ day: input.day, totalMeetings: 0, meetings: [] });
    }

    const todayVn = vnDay(new Date());
    const linkedMeetingIds = [...new Set(slice.flatMap((r) => (r.meeting_id !== null ? [r.meeting_id] : [])))];
    const readableMeetingRows =
      linkedMeetingIds.length === 0
        ? []
        : await ctx.trx
            .selectFrom('ludy_meetings.meeting')
            .select([
              'id',
              'recorder_user_id',
              'series_id',
              sql<string | null>`text_retention_date::text`.as('text_day'),
              sql<Date>`coalesce(started_at, created_at)`.as('at'),
            ])
            .where('org_id', '=', ctx.orgId)
            .where('id', 'in', linkedMeetingIds)
            .execute();
    const readableMeetingsById = new Map<string, { id: string; recorderUserId: string; seriesId: string | null; at: Date }>();
    for (const m of readableMeetingRows) {
      if (m.text_day !== null && dayText(m.text_day) <= todayVn) continue;
      readableMeetingsById.set(m.id, {
        id: m.id,
        recorderUserId: m.recorder_user_id,
        seriesId: m.series_id,
        at: new Date(m.at),
      });
    }

    const seriesTargets: Array<{ agendaId: string; seriesId: string; beforeAt: Date; excludeId: string | null }> = [];
    for (const row of slice) {
      const readable = row.meeting_id !== null ? readableMeetingsById.get(row.meeting_id) ?? null : null;
      const seriesId = readable?.seriesId ?? row.series_id;
      if (seriesId !== null) {
        seriesTargets.push({
          agendaId: row.id,
          seriesId,
          beforeAt: readable ? readable.at : new Date(row.starts_at),
          excludeId: readable?.id ?? null,
        });
      }
    }
    const previousRows =
      seriesTargets.length === 0
        ? []
        : (
            await sql<{ agenda_id: string; previous_meeting_id: string }>`
              SELECT q.agenda_id, p.id AS previous_meeting_id
              FROM pg_catalog.unnest(
                ${sql.val(seriesTargets.map((s) => s.agendaId))}::uuid[],
                ${sql.val(seriesTargets.map((s) => s.seriesId))}::uuid[],
                ${sql.val(seriesTargets.map((s) => s.beforeAt.toISOString()))}::timestamptz[],
                ${sql.val(seriesTargets.map((s) => s.excludeId))}::uuid[]
              ) AS q(agenda_id, series_id, before_at, exclude_id)
              CROSS JOIN LATERAL (
                SELECT m.id
                FROM ludy_meetings.meeting m
                WHERE m.org_id = ${ctx.orgId}::uuid
                  AND m.series_id = q.series_id
                  AND coalesce(m.started_at, m.created_at) < q.before_at
                  AND (m.text_retention_date IS NULL OR m.text_retention_date > ${todayVn}::date)
                  AND (q.exclude_id IS NULL OR m.id <> q.exclude_id)
                ORDER BY coalesce(m.started_at, m.created_at) DESC, m.id DESC
                LIMIT 1
              ) AS p`.execute(ctx.trx)
          ).rows;
    const previousByAgendaId = new Map(previousRows.map((r) => [r.agenda_id, r.previous_meeting_id]));

    const readableMeetingIds = [...readableMeetingsById.keys()];
    const readerRows =
      readableMeetingIds.length === 0
        ? []
        : await ctx.trx
            .selectFrom('ludy_meetings.meeting_reader')
            .select(['meeting_id', 'user_id'])
            .where('org_id', '=', ctx.orgId)
            .where('meeting_id', 'in', readableMeetingIds)
            .execute();
    const userIdsByMeeting = new Map<string, Set<string>>();
    for (const [id, m] of readableMeetingsById) {
      userIdsByMeeting.set(id, new Set([m.recorderUserId]));
    }
    for (const r of readerRows) {
      userIdsByMeeting.get(r.meeting_id)?.add(r.user_id);
    }
    const allReaderUserIds = [...new Set([...userIdsByMeeting.values()].flatMap((set) => [...set]))];
    const dirRows =
      allReaderUserIds.length === 0
        ? []
        : (
            await sql<{ user_id: string; display_name: string | null }>`
              SELECT user_id, display_name
              FROM ludy_kernel.member_briefing_directory
              WHERE user_id = ANY (${allReaderUserIds}::uuid[])`.execute(ctx.trx)
          ).rows;
    const nameByUserId = new Map<string, string>();
    for (const d of dirRows) {
      if (!d.display_name) continue;
      const cleaned = clampText(d.display_name, MORNING_BRIEFING_CAPS.nameMax);
      if (cleaned !== '') nameByUserId.set(d.user_id, cleaned);
    }

    const previousMeetingIds = [...new Set(previousByAgendaId.values())];
    const resultRows =
      previousMeetingIds.length === 0
        ? []
        : await ctx.trx
            .selectFrom('ludy_meetings.meeting_result')
            .select(['meeting_id', 'decisions'])
            .where('org_id', '=', ctx.orgId)
            .where('meeting_id', 'in', previousMeetingIds)
            .where('stage', '=', 'published')
            .orderBy('created_at')
            .orderBy('id')
            .execute();
    const decisionsByMeeting = new Map<string, string[]>();
    for (const r of resultRows) {
      const list = decisionsByMeeting.get(r.meeting_id) ?? [];
      if (list.length < MORNING_BRIEFING_CAPS.decisionsPerMeetingMax) {
        const raw = Array.isArray(r.decisions) ? (r.decisions as unknown[]) : [];
        for (const d of raw) {
          if (typeof d !== 'string') continue;
          const cleaned = clampText(d, MORNING_BRIEFING_CAPS.decisionTextMax);
          if (cleaned === '') continue;
          list.push(cleaned);
          if (list.length >= MORNING_BRIEFING_CAPS.decisionsPerMeetingMax) break;
        }
      }
      decisionsByMeeting.set(r.meeting_id, list);
    }

    const actionItemRows =
      previousMeetingIds.length === 0
        ? []
        : await ctx.trx
            .selectFrom('ludy_meetings.action_item')
            .select(['id', 'meeting_id', 'title'])
            .where('org_id', '=', ctx.orgId)
            .where('meeting_id', 'in', previousMeetingIds)
            .where('stage', '=', 'published')
            .orderBy('transcript_seconds')
            .orderBy('created_at')
            .orderBy('id')
            .execute();
    const flagRows =
      previousMeetingIds.length === 0 || actionItemRows.length === 0
        ? []
        : (
            await sql<{
              action_item_id: string;
              is_open: boolean;
              is_overdue: boolean;
              is_mine: boolean;
              due_on: string | null;
            }>`
              SELECT action_item_id, is_open, is_overdue, is_mine, due_on::text AS due_on
              FROM ludy_meetings.morning_briefing_task_flags(${previousMeetingIds}::uuid[], ${window.today}::date)`.execute(ctx.trx)
          ).rows;
    const flagsByItemId = new Map(flagRows.map((f) => [f.action_item_id, f]));
    const openItemsByMeeting = new Map<string, MorningBriefingOpenItem[]>();
    for (const item of actionItemRows) {
      const list = openItemsByMeeting.get(item.meeting_id) ?? [];
      if (list.length >= MORNING_BRIEFING_CAPS.actionItemsPerMeetingMax) continue;
      const flag = flagsByItemId.get(item.id);
      if (!flag || !flag.is_open) continue;
      const text = clampText(item.title, MORNING_BRIEFING_CAPS.actionItemTextMax);
      if (text === '') continue;
      list.push({
        text,
        dueOn: flag.due_on,
        overdue: flag.is_overdue,
        mine: flag.is_mine,
      });
      openItemsByMeeting.set(item.meeting_id, list);
    }

    const allMeetingIds = [...new Set([...readableMeetingIds, ...previousMeetingIds])];
    const slicePairs = slice.map((row) => ({
      agendaId: row.id,
      readableMeetingId: row.meeting_id !== null && readableMeetingsById.has(row.meeting_id) ? row.meeting_id : null,
      previousMeetingId: previousByAgendaId.get(row.id) ?? null,
    }));
    const dealsByAgendaId = await loadBriefingDeals(ctx, slicePairs, allMeetingIds);

    const vyLinesByMeeting = new Map<string, string[]>();
    if (window.vy_lines && allMeetingIds.length > 0) {
      const vyRows = await ctx.trx
        .selectFrom('ludy_meetings.morning_brief_lines')
        .select(['meeting_id', 'lines'])
        .where('org_id', '=', ctx.orgId)
        .where('user_id', '=', memberUserId)
        .where('meeting_id', 'in', allMeetingIds)
        .where('expires_at', '>', sql<Date>`pg_catalog.now()`)
        .execute();
      for (const vyRow of vyRows) {
        const raw = Array.isArray(vyRow.lines) ? (vyRow.lines as unknown[]) : [];
        const cleaned = raw
          .filter((line): line is string => typeof line === 'string')
          .map((line) => clampText(line, MORNING_BRIEFING_CAPS.vyLineTextMax))
          .filter((line) => line !== '')
          .slice(0, MORNING_BRIEFING_CAPS.vyLinesPerMeetingMax);
        if (cleaned.length > 0) vyLinesByMeeting.set(vyRow.meeting_id, cleaned);
      }
    }

    let vyMeetingsUsed = 0;
    const meetings: MorningBriefingMeeting[] = slice.map((row) => {
      const readableMeetingId = row.meeting_id !== null && readableMeetingsById.has(row.meeting_id) ? row.meeting_id : null;
      const previousMeetingId = previousByAgendaId.get(row.id) ?? null;

      let readerNames: string[] = [];
      let extraReadersCount = 0;
      if (readableMeetingId !== null) {
        const names = [
          ...new Set(
            [...(userIdsByMeeting.get(readableMeetingId) ?? [])]
              .map((uid) => nameByUserId.get(uid) ?? '')
              .filter((name) => name !== ''),
          ),
        ].sort((a, b) => a.localeCompare(b, 'vi') || (a < b ? -1 : a > b ? 1 : 0));
        readerNames = names.slice(0, MORNING_BRIEFING_CAPS.orgNamesMax);
        extraReadersCount = Math.min(Math.max(0, names.length - MORNING_BRIEFING_CAPS.orgNamesMax), MORNING_COUNT_MAX);
      }

      let vyLines: string[] | undefined;
      if (window.vy_lines && vyMeetingsUsed < MORNING_BRIEFING_CAPS.vyMeetingsMax) {
        const key = readableMeetingId ?? previousMeetingId;
        const candidateLines =
          (key ? vyLinesByMeeting.get(key) : undefined) ??
          (readableMeetingId && previousMeetingId ? vyLinesByMeeting.get(previousMeetingId) : undefined);
        if (candidateLines && candidateLines.length > 0) {
          vyLines = candidateLines;
          vyMeetingsUsed += 1;
        }
      }

      return {
        id: readableMeetingId ?? row.id,
        path: readableMeetingId ? `${input.orgPrefix}/meetings/${readableMeetingId}` : `${input.orgPrefix}/meetings/record`,
        title: clampText(row.title, MORNING_BRIEFING_CAPS.titleMax),
        startAt: new Date(row.starts_at).toISOString(),
        endAt: new Date(row.ends_at).toISOString(),
        timeZone: safeTimeZone(row.time_zone),
        inviteeCount: Math.min(Math.max(0, row.invitee_count), MORNING_COUNT_MAX),
        readerNames,
        extraReadersCount,
        previousDecisions: previousMeetingId ? (decisionsByMeeting.get(previousMeetingId) ?? []) : [],
        openItems: previousMeetingId ? (openItemsByMeeting.get(previousMeetingId) ?? []) : [],
        deals: dealsByAgendaId.get(row.id) ?? [],
        ...(vyLines ? { vyLines } : {}),
      };
    });

    return zMorningBriefingContent.parse({
      day: input.day,
      totalMeetings,
      meetings,
    });
  },
});

export const morningCommands = [morningSet, morningNotice];
export const morningQueries = [morningGet, morningMailContent];
