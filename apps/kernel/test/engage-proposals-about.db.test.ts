// SPDX-License-Identifier: AGPL-3.0-only
// What the Inbox card of an AI coworker's Engage proposal says it is ABOUT (epic #3857, E4, issue #3863): not ids, but what the approver approves, read from the real records as the approver: a booking's guest,
// meeting type and current time; a quote's number, state, total, customer and the customer's own email beside the address the AI proposes; a post's title and channels; an ad launch's campaign, account, state and
// budget. Only owners and admins get the card; an id the database does not know gives no lines and no error. The fixtures (a bookable event type, a sent-ready quote, a post, a live launch) are the ones of the
// CRM, Social and Ads twin tests, copied. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertIdentity } from '@ludy/kernel';
import { isVietnamHoliday, zonedDate, zonedInstant, type Deal, type EventType, type PipelineStage, type Quote } from '@ludy/kernel-contract';
import type { PostView } from '@ludy/mod-social';
import { bookingRequest } from '../src/booking-page.ts';
import { ADMIN, startHarness, type Harness } from './engage-proposals-harness.ts';

const suite = ADMIN ? describe : describe.skip;
const VN = 'Asia/Ho_Chi_Minh';
const DAY = 86_400_000;
const HASH = `sha256:${'b'.repeat(64)}`;
const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

// A day at least three days ahead that is not a Vietnamese public holiday, in Vietnam time.
function bookableDay(offset = 3): string {
  let date = zonedDate(VN, Date.now() + offset * DAY);
  while (isVietnamHoliday(date)) date = zonedDate(VN, Date.parse(`${date}T12:00:00Z`) + DAY);
  return date;
}
const at = (date: string, minute: number) => new Date(zonedInstant(VN, date, minute)).toISOString().replace('.000Z', 'Z');
const item = (over: Record<string, unknown> = {}) => ({ kind: 'item' as const, description: 'Gói kế toán năm', unit: 'gói', quantity: '2', unitPrice: '1500000', vatRate: '10%', ...over });

type About = Array<{ label: string; value: string }>;
interface Detail {
  engage: { about: About; fields: Array<{ key: string; value: string }> } | null;
}

suite('what the card of an AI coworker\'s ask is about (#3863)', () => {
  let h: Harness;
  let slug = '';
  let dealId = '';
  let today = '';
  let connectionId = '';
  const day = bookableDay();
  const D = (n: number) => addDays(today, n);
  beforeAll(async () => {
    h = await startHarness('engage_about');
    slug = (await h.q<{ slug: string }>('SELECT slug FROM crove_kernel.tenant WHERE org_id = $1', [h.orgId])).rows[0]?.slug as string;
    today = (await h.q<{ d: string }>("SELECT (now() AT TIME ZONE 'UTC')::date::text AS d")).rows[0]?.d as string;
    await exec('kernel.calendar.hours.save', { timeZone: VN, windows: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: 0, end: 1440 })) });
    await exec<EventType>('crm.event_type.create', {
      slug: 'tu-van',
      title: 'Tư vấn thuế',
      description: null,
      durationMin: 30,
      bufferBeforeMin: 0,
      bufferAfterMin: 0,
      minNoticeMin: 0,
      horizonDays: 60,
      dailyLimit: null,
      locationKind: 'video',
      locationValue: 'https://meet.example.test/x',
      hostUserId: h.owner,
    });
    const party = (await h.q<{ id: string }>("INSERT INTO crove_kernel.party (org_id, name, kind, email, tax_code, address) VALUES ($1, 'Công ty Khách', 'organization', 'khach@example.test', '0312345678', '12 Lê Lợi, Quận 1') RETURNING id", [h.orgId])).rows[0]?.id as string;
    await exec<PipelineStage[]>('crm.pipeline.setup', {});
    dealId = (await exec<Deal>('crm.deal.create', { partyId: party, title: 'Gói kế toán năm', amount: '15000000', expectedClose: '2026-12-31' })).id;
    connectionId = randomUUID();
    await h.q("INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox', $3, 'Kênh thử', $4)", [h.orgId, connectionId, `acct-${randomUUID().slice(0, 8)}`, h.owner]);
    await withoutGuard('crove_ads.ad_org_setting', 'switch_guard', async (c) => {
      await c.query('INSERT INTO crove_ads.ad_org_setting (org_id, write_enabled, launches_blocked) VALUES ($1, true, false) ON CONFLICT DO NOTHING', [h.orgId]);
      await c.query('UPDATE crove_ads.ad_org_setting SET write_enabled = true, launches_blocked = false WHERE org_id = $1', [h.orgId]);
    });
  }, 300_000);
  afterAll(async () => {
    await h?.stop();
  });

  const exec = <O = unknown>(command: string, input: unknown) => h.runtime.execute<O>(command, input, { actor: h.person(h.owner), orgId: h.orgId });
  // The card as the owner reads it: the proposal asked through a company grant, then kernel.inbox.get.
  async function cardOf(command: string, payload: Record<string, unknown>): Promise<{ id: string; about: About | undefined; engage: Detail['engage'] }> {
    const { actor } = await h.grant();
    const made = await h.propose(actor, command, payload);
    const detail = await h.runtime.query<Detail>('kernel.inbox.get', { id: made.proposalId }, { actor: h.person(h.owner), orgId: h.orgId });
    return { id: made.proposalId, about: detail.engage?.about, engage: detail.engage };
  }

  async function withoutGuard(table: string, trigger: string | readonly string[], fn: (c: pg.Client) => Promise<void>): Promise<void> {
    const c = new pg.Client({ connectionString: h.adminUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      const triggers = typeof trigger === 'string' ? [trigger] : trigger;
      for (const t of triggers) await c.query(`ALTER TABLE ${table} DISABLE TRIGGER ${t}`);
      await fn(c);
      for (const t of triggers) await c.query(`ALTER TABLE ${table} ENABLE ALWAYS TRIGGER ${t}`);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      await c.end();
    }
  }

  // A confirmed booking of the type at `minute` of the day.
  let guests = 0;
  async function booking(minute: number) {
    guests += 1;
    const email = `khach${guests}@example.test`;
    await bookingRequest(h.runtime, slug, 'tu-van', { startsAt: at(day, minute), name: 'Nguyễn Văn Khách', email, phone: '0901234567', note: 'Hỏi về thuế', timeZone: VN });
    const row = (await h.q<{ id: string }>('SELECT id FROM crove_crm.booking WHERE org_id = $1 AND starts_at = $2', [h.orgId, at(day, minute)])).rows[0];
    const bookingId = row?.id as string;
    await h.system('test.crm.booking', 'crm.booking.confirm', { bookingId });
    return { bookingId, email };
  }

  it('booking move and cancel: the guest, the guest\'s email, the meeting type and the time the booking holds now', async () => {
    const { bookingId, email } = await booking(600);
    const move = await cardOf('crm.booking.move_approved', { bookingId, startsAt: at(day, 720) });
    expect(move.about).toEqual([
      { label: 'guest', value: 'Nguyễn Văn Khách' },
      { label: 'guestEmail', value: email },
      { label: 'eventType', value: 'Tư vấn thuế' },
      { label: 'bookingTime', value: at(day, 600) },
    ]);
    // The new time the AI proposes stays in the card's own fields, beside the one it holds now.
    expect(move.engage?.fields.find((f) => f.key === 'startsAt')?.value).toBe(at(day, 720));
    const cancel = await cardOf('crm.booking.cancel_approved', { bookingId });
    expect(cancel.about).toEqual(move.about);
  });

  it('quote send: the number, state, total and customer, and the customer\'s own email beside the address the AI proposes', async () => {
    const empty = await exec<Quote>('crm.quote.save', { dealId, lines: [] });
    const quote = await exec<Quote>('crm.quote.save', { quoteId: empty.id, version: empty.version, lines: [item()] });
    const card = await cardOf('crm.quote.send_approved', { quoteId: quote.id, version: quote.version, via: 'email', to: 'someone-else@example.test' });
    // A draft has no number yet: the line is left out. The total is what the database stores (a decimal string).
    expect(card.about).toEqual([
      { label: 'quoteStatus', value: 'draft' },
      { label: 'quoteTotal', value: '3300000.0000' },
      { label: 'party', value: 'Công ty Khách' },
      { label: 'partyEmail', value: 'khach@example.test' },
    ]);
    expect(card.engage?.fields.find((f) => f.key === 'to')?.value).toBe('someone-else@example.test');
    // Sent, it has its number.
    await exec('crm.quote.send', { quoteId: quote.id, version: quote.version, via: 'link' });
    const sentNumber = (await h.q<{ number: string }>('SELECT number FROM crove_crm.quote WHERE org_id = $1 AND id = $2', [h.orgId, quote.id])).rows[0]?.number as string;
    expect(sentNumber).toBeTruthy();
    const again = await cardOf('crm.quote.send_approved', { quoteId: quote.id, version: quote.version + 1, via: 'link' });
    expect(again.about?.slice(0, 2)).toEqual([
      { label: 'quote', value: sentNumber },
      { label: 'quoteStatus', value: 'sent' },
    ]);
  });

  it('post submit and variant schedule: the post\'s title (or the start of its text) and the channels of the variants the ask names, all of them when it names none', async () => {
    const second = randomUUID();
    await h.q("INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox', $3, 'Kênh hai', $4)", [h.orgId, second, `acct-${randomUUID().slice(0, 8)}`, h.owner]);
    const body = `Khuyến mãi tháng 12 ${'x'.repeat(200)}`;
    const { postId } = await exec<{ postId: string }>('social.post.create', { body, channels: [{ connectionId }, { connectionId: second }] });
    const post = await h.runtime.query<PostView>('social.post.get', { postId }, { actor: h.person(h.owner), orgId: h.orgId });
    const first = post.variants[0]?.id as string;
    const named = await cardOf('social.post.submit_approved', { postId, variantIds: [first] });
    expect(named.about).toEqual([
      { label: 'post', value: body.slice(0, 120) },
      { label: 'channels', value: expect.stringMatching(/^Kênh (thử|hai)$/) },
    ]);
    const all = await cardOf('social.post.submit_approved', { postId });
    const channels = all.about?.find((a) => a.label === 'channels')?.value.split(', ').sort();
    expect(channels).toEqual(['Kênh hai', 'Kênh thử']);
    // A title wins over the text.
    await h.q("UPDATE crove_social.post SET title = 'Tiêu đề bài' WHERE org_id = $1 AND id = $2", [h.orgId, postId]);
    const scheduled = await cardOf('social.variant.schedule_approved', { postId, at: new Date(Date.now() + 4 * 3_600_000).toISOString() });
    expect(scheduled.about?.[0]).toEqual({ label: 'post', value: 'Tiêu đề bài' });
  });

  // A live launch of 100 000 VND a day (begun three days ago, ending in ten), named after its plan, in a named account.
  async function rig(): Promise<string> {
    const connection = randomUUID();
    const account = randomUUID();
    await h.q(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, scopes, connected_by) VALUES ($1, $2, 'sandbox_ads', $3, 'Thử', '{}', $4)`, [h.orgId, connection, `acct-${connection.slice(0, 8)}`, h.owner]);
    await h.q(`INSERT INTO crove_ads.ad_account (org_id, id, channel_connection_id, provider, external_account_id, name, backfill_from, currency, time_zone) VALUES ($1, $2, $3, 'sandbox_ads', $4, 'Tài khoản Tiệm Bánh', '2025-10-01', 'VND', $5)`, [h.orgId, account, connection, `acct-${connection.slice(0, 8)}`, VN]);
    const draft = randomUUID();
    await h.q(`INSERT INTO crove_ads.ad_campaign_draft (org_id, id, ad_account_id, name, objective, created_by) VALUES ($1, $2, $3, 'Khuyến mãi Tết', 'traffic', $4)`, [h.orgId, draft, account, h.owner]);
    const launch = randomUUID();
    await h.q(
      `INSERT INTO crove_ads.ad_launch (org_id, id, ad_account_id, draft_id, proposal_id, plan_hash, currency, daily_budget, start_on, end_on, amount, commit_until, created_by, state)
       VALUES ($1, $2, $3, $4, $5, $6, 'VND', '100000', $7, $8, '1400000', $8, $9, 'queued')`,
      [h.orgId, launch, account, draft, randomUUID(), HASH, D(-3), D(10), h.owner],
    );
    await withoutGuard('crove_ads.ad_launch', 'launch_guard', async (c) => {
      await c.query(`UPDATE crove_ads.ad_launch SET state = 'launching', step = 'campaign' WHERE org_id = $1 AND id = $2`, [h.orgId, launch]);
      await c.query(`UPDATE crove_ads.ad_launch SET state = 'live', step = 'live' WHERE org_id = $1 AND id = $2`, [h.orgId, launch]);
    });
    return launch;
  }

  it('ads launch stop and budget lower: the campaign, the account, the state and the budget it holds with its currency', async () => {
    const launch = await rig();
    const expected: About = [
      { label: 'launch', value: 'Khuyến mãi Tết' },
      { label: 'adAccount', value: 'Tài khoản Tiệm Bánh' },
      { label: 'launchState', value: 'live' },
      { label: 'launchBudget', value: '100000 VND' },
    ];
    expect((await cardOf('ads.launch.stop_approved', { launchId: launch })).about).toEqual(expected);
    expect((await cardOf('ads.budget.lower_approved', { launchId: launch, dailyBudget: '60000' })).about).toEqual(expected);
    // A shorter flight also says the day it ends now, beside the proposed one.
    expect((await cardOf('ads.schedule.shorten_approved', { launchId: launch, endOn: D(5) })).about).toEqual([...expected, { label: 'launchEnds', value: D(10) }]);
    // Pausing everything has nothing to read.
    expect((await cardOf('ads.pause_all_approved', {})).about).toEqual([]);
  });

  it('shows the lines to owners and admins only: a member and a viewer get no card', async () => {
    const { bookingId } = await booking(540);
    const { actor } = await h.grant();
    const made = await h.propose(actor, 'crm.booking.cancel_approved', { bookingId });
    for (const role of ['member', 'viewer'] as const) {
      const id = await upsertIdentity(h.db, { issuer: 'engage-about', subject: `${role}-${randomUUID()}`, email: `${role}-${randomUUID().slice(0, 8)}@engage-about.test`, name: role });
      await h.q('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [h.orgId, id, role]);
      const asRole = await h.runtime.query<Detail>('kernel.inbox.get', { id: made.proposalId }, { actor: h.person(id), orgId: h.orgId });
      expect(asRole.engage, role).toBeNull();
      expect(JSON.stringify(asRole), role).not.toContain('Nguyễn Văn Khách');
    }
    const admin = await upsertIdentity(h.db, { issuer: 'engage-about', subject: `admin-${randomUUID()}`, email: `admin-${randomUUID().slice(0, 8)}@engage-about.test`, name: 'admin' });
    await h.q("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin')", [h.orgId, admin]);
    const asAdmin = await h.runtime.query<Detail>('kernel.inbox.get', { id: made.proposalId }, { actor: h.person(admin), orgId: h.orgId });
    expect(asAdmin.engage?.about.find((a) => a.label === 'guest')?.value).toBe('Nguyễn Văn Khách');
  });

  it('an id the database does not know gives no lines and no error, for every kind', async () => {
    const ghost = randomUUID();
    const cases: Array<[string, Record<string, unknown>]> = [
      ['crm.booking.move_approved', { bookingId: ghost, startsAt: at(day, 780) }],
      ['crm.booking.cancel_approved', { bookingId: ghost }],
      ['crm.quote.send_approved', { quoteId: ghost, version: 1, via: 'link' }],
      ['social.post.submit_approved', { postId: ghost }],
      ['social.variant.schedule_approved', { postId: ghost, variantIds: [randomUUID()], at: new Date(Date.now() + 4 * 3_600_000).toISOString() }],
      ['ads.launch.stop_approved', { launchId: ghost }],
      ['ads.object.pause_approved', { launchId: ghost, slot: 'campaign' }],
      ['ads.object.archive_approved', { launchId: ghost, slot: 'campaign' }],
      ['ads.budget.lower_approved', { launchId: ghost, dailyBudget: '60000' }],
      ['ads.schedule.shorten_approved', { launchId: ghost, endOn: D(5) }],
    ];
    for (const [command, payload] of cases) {
      const card = await cardOf(command, payload);
      expect(card.engage, command).not.toBeNull();
      expect(card.about, command).toEqual([]);
    }
  });
});
