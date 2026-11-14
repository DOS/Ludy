// SPDX-License-Identifier: AGPL-3.0-only
// A booking linked to a deal (#3103, docs/plan/calendar.md "Deal links") on PostgreSQL 17: a person links and unlinks a booking with commands that leave audit events, a deal of
// another org is refused, the deal panel lists the deal's bookings to the people who may read them, Dy's suggestion is a fixed rule over the guest's contact (a person
// confirms it), a booking made from a deal's "Đặt lịch" link carries the deal, and a deleted deal leaves its bookings unlinked. Set CROVE_TEST_ADMIN_URL to a superuser URL;
// each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { isVietnamHoliday, zonedDate, zonedInstant, type BookingDealChanged, type BookingItem, type DealBookings, type EventType, type PipelineStage } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { crmCommands, crmQueries } from '@crove/mod-crm';
import { bookingRequest } from '../src/booking-page.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const VN = 'Asia/Ho_Chi_Minh';
const DAY = 86_400_000;
const SYSTEM = { type: 'system' as const, component: 'test.crm.booking.deal' };

// A day a few days ahead that is not a Vietnamese public holiday, in Vietnam time.
function bookableDay(offset = 3): string {
  let date = zonedDate(VN, Date.now() + offset * DAY);
  while (isVietnamHoliday(date)) date = zonedDate(VN, Date.parse(`${date}T12:00:00Z`) + DAY);
  return date;
}
const at = (date: string, minute: number) => new Date(zonedInstant(VN, date, minute)).toISOString();

suite('a booking linked to a deal on PostgreSQL (#3103)', () => {
  const dbName = `crove_test_crm_booking_deals_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let app: Runtime;
  let worker: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const register = (db: Db) =>
    new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...crmCommands], queries: [...kernelQueries({ inboundDomain: null }), ...crmQueries] });

  const person = (name: string) => upsertIdentity(createDb(appPool), { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@deal.test`, name: null });

  // An org with an owner, a host (who leads the type), another member who hosts nothing and a viewer; a pipeline; one 30-minute type bookable all day.
  async function org() {
    const owner = await person('owner');
    const host = await person('host');
    const other = await person('other');
    const viewer = await person('viewer');
    const { orgId } = await createOrg(app, asUser(owner), `Công ty ${randomUUID().slice(0, 6)}`);
    await admin((c) =>
      c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, host, other, viewer]),
    );
    const slug = (await admin((c) => c.query<{ slug: string }>('SELECT slug FROM crove_kernel.tenant WHERE org_id = $1', [orgId]))).rows[0]?.slug as string;
    await app.execute('kernel.calendar.hours.save', { timeZone: VN, windows: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: 0, end: 1440 })) }, { actor: asUser(host), orgId });
    const type = await app.execute<EventType>(
      'crm.event_type.create',
      { slug: 'tu-van', title: 'Tư vấn thuế', description: null, durationMin: 30, bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeMin: 0, horizonDays: 60, dailyLimit: null, locationKind: 'video', locationValue: 'https://meet.example.test/x', hostUserId: host },
      { actor: asUser(host), orgId },
    );
    const exec = <T>(user: string, command: string, input: unknown) => app.execute<T>(command, input, { actor: asUser(user), orgId });
    const query = <T>(user: string, command: string, input: unknown) => app.query<T>(command, input, { actor: asUser(user), orgId });
    const stages = await exec<PipelineStage[]>(owner, 'crm.pipeline.setup', {});
    const party = (name: string, over: { email?: string | null; phone?: string | null } = {}) =>
      admin((c) =>
        c
          .query<{ id: string }>("INSERT INTO crove_kernel.party (org_id, name, kind, email, phone) VALUES ($1, $2, 'person', $3, $4) RETURNING id", [orgId, name, over.email ?? null, over.phone ?? null])
          .then((r) => r.rows[0]!.id),
      );
    const deal = (partyId: string, title = 'Gói kế toán năm') => exec<{ id: string; version: number }>(owner, 'crm.deal.create', { partyId, title, amount: '15000000', expectedClose: null });
    const stage = (kind: 'open' | 'won' | 'lost') => stages.find((s) => s.kind === kind)!;
    // A booking of the type on the given day, requested through the public page and confirmed by the worker.
    const book = async (day: string, minute: number, over: Record<string, unknown> = {}): Promise<string> => {
      const request = await bookingRequest(app, slug, 'tu-van', { startsAt: at(day, minute), name: 'Nguyễn Văn Khách', email: 'khach@example.test', phone: '0901234567', note: null, timeZone: VN, ...over });
      if (!request) throw new Error('no request');
      const id = (await admin((c) => c.query<{ id: string }>("SELECT id FROM crove_crm.booking WHERE org_id = $1 AND status = 'pending' ORDER BY created_at DESC, id DESC LIMIT 1", [orgId]))).rows[0]!.id;
      expect(await worker.execute<{ status: string }>('crm.booking.confirm', { bookingId: id }, { actor: SYSTEM, orgId })).toMatchObject({ status: 'confirmed' });
      return id;
    };
    const dealOf = async (bookingId: string) => (await admin((c) => c.query<{ deal_id: string | null }>('SELECT deal_id FROM crove_crm.booking WHERE org_id = $1 AND id = $2', [orgId, bookingId]))).rows[0]!.deal_id;
    const audits = async (command: string, bookingId: string) =>
      (await admin((c) => c.query<{ outcome: string; target_type: string; detail: Record<string, unknown> }>('SELECT outcome, target_type, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 AND target_id = $3 ORDER BY occurred_at, id', [orgId, command, bookingId]))).rows;
    const item = async (user: string, bookingId: string) => (await query<BookingItem>(user, 'crm.booking.get', { id: bookingId }));
    return { orgId, slug, owner, host, other, viewer, type, exec, query, stage, party, deal, book, dealOf, audits, item };
  }

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const login = (user: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = user;
      u.password = password;
      return u.toString();
    };
    appPool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 4 });
    app = register(createDb(appPool));
    worker = register(createDb(workerPool));
  });

  afterAll(async () => {
    await appPool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('links and unlinks a booking with commands that leave audit events, and moves the link to another deal', async () => {
    const o = await org();
    const day = bookableDay();
    const booking = await o.book(day, 540);
    const guest = await o.party('Nguyễn Văn Khách', { email: 'khach@example.test' });
    const first = await o.deal(guest, 'Gói kế toán năm');
    const second = await o.deal(guest, 'Gói tư vấn thuế');
    expect(await o.dealOf(booking)).toBeNull();

    expect(await o.exec<BookingDealChanged>(o.host, 'crm.booking.link_deal', { bookingId: booking, dealId: first.id })).toEqual({ bookingId: booking, dealId: first.id });
    expect(await o.dealOf(booking)).toBe(first.id);
    expect((await o.item(o.host, booking)).deal).toMatchObject({ id: first.id, title: 'Gói kế toán năm', status: 'open' });

    // The same link again changes nothing, and says so in its audit row; a link to another deal moves it and names the one it left.
    await o.exec(o.host, 'crm.booking.link_deal', { bookingId: booking, dealId: first.id });
    await o.exec(o.owner, 'crm.booking.link_deal', { bookingId: booking, dealId: second.id });
    expect(await o.dealOf(booking)).toBe(second.id);
    expect(await o.exec<BookingDealChanged>(o.host, 'crm.booking.unlink_deal', { bookingId: booking })).toEqual({ bookingId: booking, dealId: null });
    expect(await o.dealOf(booking)).toBeNull();
    // Unlinking a booking that has no deal is harmless.
    await o.exec(o.host, 'crm.booking.unlink_deal', { bookingId: booking });

    const links = await o.audits('crm.booking.link_deal', booking);
    expect(links.map((a) => [a.outcome, a.detail.dealId, a.detail.previousDealId ?? null, a.detail.linked])).toEqual([
      ['ok', first.id, null, true],
      ['ok', first.id, first.id, false],
      ['ok', second.id, first.id, true],
    ]);
    expect(links.every((a) => a.target_type === 'crm.booking')).toBe(true);
    const unlinks = await o.audits('crm.booking.unlink_deal', booking);
    expect(unlinks.every((a) => a.target_type === 'crm.booking')).toBe(true);
    expect(unlinks.map((a) => [a.outcome, a.detail.previousDealId ?? null, a.detail.unlinked])).toEqual([
      ['ok', second.id, true],
      ['ok', null, false],
    ]);
    // Ids and flags only: neither the deal's title nor the guest's details are in an audit row.
    expect(JSON.stringify([...links, ...unlinks])).not.toMatch(/Gói|Khách|khach@|0901234567/);
  });

  it('refuses a deal of another org, a booking the caller may not read, and a request the worker has not decided', async () => {
    const o = await org();
    const p = await org();
    const day = bookableDay();
    const booking = await o.book(day, 540);
    const mine = await o.deal(await o.party('Khách của tôi'));
    const theirs = await p.deal(await p.party('Khách của họ'));

    await expect(o.exec(o.owner, 'crm.booking.link_deal', { bookingId: booking, dealId: theirs.id })).rejects.toMatchObject({ code: 'DEAL_NOT_FOUND', status: 404 });
    await expect(o.exec(o.owner, 'crm.booking.link_deal', { bookingId: booking, dealId: randomUUID() })).rejects.toMatchObject({ code: 'DEAL_NOT_FOUND' });
    // The other org cannot reach this org's booking either.
    await expect(p.exec(p.owner, 'crm.booking.link_deal', { bookingId: booking, dealId: theirs.id })).rejects.toMatchObject({ code: 'BOOKING_NOT_FOUND', status: 404 });
    expect(await o.dealOf(booking)).toBeNull();

    // A member who leads nothing and holds nothing reads no booking, so links none; a viewer is refused outright.
    await expect(o.exec(o.other, 'crm.booking.link_deal', { bookingId: booking, dealId: mine.id })).rejects.toMatchObject({ code: 'BOOKING_HOST_FORBIDDEN', status: 403 });
    await expect(o.exec(o.other, 'crm.booking.unlink_deal', { bookingId: booking })).rejects.toMatchObject({ code: 'BOOKING_HOST_FORBIDDEN' });
    await expect(o.exec(o.viewer, 'crm.booking.link_deal', { bookingId: booking, dealId: mine.id })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(o.exec(o.viewer, 'crm.booking.unlink_deal', { bookingId: booking })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(await o.dealOf(booking)).toBeNull();

    // A request nobody decided yet is not a booking.
    const request = await bookingRequest(app, o.slug, 'tu-van', { startsAt: at(day, 600), name: 'Khách', email: 'moi@example.test', phone: null, note: null, timeZone: VN });
    expect(request).not.toBeNull();
    const pending = (await admin((c) => c.query<{ id: string }>("SELECT id FROM crove_crm.booking WHERE org_id = $1 AND status = 'pending'", [o.orgId]))).rows[0]!.id;
    await expect(o.exec(o.owner, 'crm.booking.link_deal', { bookingId: pending, dealId: mine.id })).rejects.toMatchObject({ code: 'BOOKING_NOT_FOUND' });
  });

  it('lists a deal\'s upcoming and past bookings to the people who may read them, and only to those', async () => {
    const o = await org();
    const day = bookableDay();
    const guest = await o.party('Nguyễn Văn Khách', { email: 'khach@example.test' });
    const deal = await o.deal(guest);
    const later = await o.book(day, 540);
    const earlier = await o.book(day, 480);
    const cancelled = await o.book(day, 600);
    const unrelated = await o.book(day, 660);
    for (const id of [later, earlier, cancelled]) await o.exec(o.host, 'crm.booking.link_deal', { bookingId: id, dealId: deal.id });
    await o.exec(o.host, 'crm.booking.cancel', { bookingId: cancelled });
    // A past booking: the page cannot make one, so the row and its event go in directly, as a meeting that has happened.
    const event = randomUUID();
    const past = randomUUID();
    const start = new Date(Date.now() - 3 * DAY);
    await admin(async (c) => {
      await c.query(
        "INSERT INTO crove_kernel.calendar_event (org_id, id, user_id, starts_at, ends_at, time_zone, title, kind, created_by) VALUES ($1, $2, $3, $4, $5, $6, 'Đã họp', 'booking', $3)",
        [o.orgId, event, o.host, start.toISOString(), new Date(start.getTime() + 1_800_000).toISOString(), VN],
      );
      await c.query(
        "INSERT INTO crove_crm.booking (org_id, id, event_type_id, starts_at, ends_at, status, calendar_event_id, party_id, visitor_name, email, time_zone, deal_id) VALUES ($1, $2, $3, $4, $5, 'confirmed', $6, $7, 'Nguyễn Văn Khách', 'khach@example.test', $8, $9)",
        [o.orgId, past, o.type.id, start.toISOString(), new Date(start.getTime() + 1_800_000).toISOString(), event, guest, VN, deal.id],
      );
    });

    const asHost = await o.query<DealBookings>(o.host, 'crm.deal.bookings', { dealId: deal.id });
    expect(asHost.upcoming.map((b) => b.id)).toEqual([earlier, later, cancelled]);
    expect(asHost.upcoming.map((b) => b.status)).toEqual(['confirmed', 'confirmed', 'cancelled']);
    expect(asHost.past.map((b) => b.id)).toEqual([past]);
    expect(asHost.upcoming.every((b) => b.deal?.id === deal.id && b.dealSuggestions.length === 0)).toBe(true);
    expect([...asHost.upcoming, ...asHost.past].map((b) => b.id)).not.toContain(unrelated);
    // An owner reads the same; a member who hosts nothing reads none of them; a viewer reads no booking; another org has no such deal.
    expect((await o.query<DealBookings>(o.owner, 'crm.deal.bookings', { dealId: deal.id })).upcoming).toHaveLength(3);
    expect(await o.query<DealBookings>(o.other, 'crm.deal.bookings', { dealId: deal.id })).toEqual({ upcoming: [], past: [] });
    await expect(o.query(o.viewer, 'crm.deal.bookings', { dealId: deal.id })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    const p = await org();
    await expect(p.query(p.owner, 'crm.deal.bookings', { dealId: deal.id })).rejects.toMatchObject({ code: 'DEAL_NOT_FOUND' });
  });

  it('suggests the guest\'s open deals by a fixed rule, never a closed one, and a person links one', async () => {
    const o = await org();
    const day = bookableDay();
    const booking = await o.book(day, 540, { email: 'Khach@Example.test', phone: '+84 901 234 567' });
    expect((await o.item(o.host, booking)).dealSuggestions).toEqual([]);

    // The booking's own contact (matched by email when the worker confirmed it), another contact with the same email in other letters, and one with the same phone.
    const [contact] = (await admin((c) => c.query<{ party_id: string }>('SELECT party_id FROM crove_crm.booking WHERE org_id = $1 AND id = $2', [o.orgId, booking]))).rows;
    const byContact = await o.deal(contact!.party_id, 'Báo giá thuế');
    const byEmail = await o.deal(await o.party('Khách khác', { email: 'KHACH@example.TEST' }), 'Dịch vụ kế toán');
    const byPhone = await o.deal(await o.party('Khách ba', { phone: '0901 234 567' }), 'Hóa đơn điện tử');
    // A second deal by phone, changed later than the first: four deals fit, three are offered, and the older of the two phone deals is the one left out.
    const byPhoneLater = await o.deal(await o.party('Khách bốn', { phone: '+84901234567' }), 'Hóa đơn mua vào');
    const stranger = await o.deal(await o.party('Người lạ', { email: 'la@example.test', phone: '0912345678' }), 'Không liên quan');
    const closed = await o.deal(await o.party('Khách đã thắng', { email: 'khach@example.test' }), 'Đã chốt');
    const won = o.stage('won');
    await o.exec(o.owner, 'crm.deal.move', { dealId: closed.id, version: closed.version, stageId: won.id });

    const suggested = (await o.item(o.host, booking)).dealSuggestions;
    expect(suggested.map((s) => [s.id, s.match])).toEqual([
      [byContact.id, 'contact'],
      [byEmail.id, 'email'],
      [byPhoneLater.id, 'phone'],
    ]);
    expect(suggested.map((s) => s.id)).not.toContain(byPhone.id);
    expect(suggested.map((s) => s.id)).not.toContain(stranger.id);
    expect(suggested.map((s) => s.id)).not.toContain(closed.id);
    // The screen's list carries the same suggestions, and a suggestion links nothing by itself.
    const listed = (await o.query<BookingItem[]>(o.host, 'crm.booking.list', { scope: 'mine', period: 'upcoming', withSuggestions: true })).find((b) => b.id === booking);
    expect(listed?.dealSuggestions.map((s) => s.id)).toEqual(suggested.map((s) => s.id));
    // The reads that only count or list bookings (the Home and the invoice screens) do not ask, and get none: no search for deals is made for them.
    const plain = (await o.query<BookingItem[]>(o.host, 'crm.booking.list', { scope: 'mine', period: 'upcoming' })).find((b) => b.id === booking);
    expect(plain?.dealSuggestions).toEqual([]);
    expect(await o.dealOf(booking)).toBeNull();

    // A person confirms one: the booking is linked and offers no more.
    await o.exec(o.host, 'crm.booking.link_deal', { bookingId: booking, dealId: suggested[1]!.id });
    const linked = await o.item(o.host, booking);
    expect(linked.deal?.id).toBe(byEmail.id);
    expect(linked.dealSuggestions).toEqual([]);
  });

  it('carries the deal of a "Đặt lịch" link, and drops a deal that is not the org\'s without a word', async () => {
    const o = await org();
    const p = await org();
    const day = bookableDay();
    const mine = await o.deal(await o.party('Khách của tôi'));
    const theirs = await p.deal(await p.party('Khách của họ'));

    const withDeal = await o.book(day, 540, { dealId: mine.id });
    expect(await o.dealOf(withDeal)).toBe(mine.id);
    expect((await o.item(o.host, withDeal)).deal?.id).toBe(mine.id);
    // Another org's deal, and an id that names nothing: the request goes through as any other, with no link and no different answer.
    const foreign = await o.book(day, 600, { dealId: theirs.id });
    const made = await o.book(day, 660, { dealId: randomUUID() });
    const plain = await o.book(day, 720);
    expect(await o.dealOf(foreign)).toBeNull();
    expect(await o.dealOf(made)).toBeNull();
    expect(await o.dealOf(plain)).toBeNull();
    expect(await p.dealOf(withDeal).catch(() => 'not found')).toBe('not found');
    // The page's body is checked: an id that is not an id is refused.
    await expect(bookingRequest(app, o.slug, 'tu-van', { startsAt: at(day, 780), name: 'Khách', email: 'x@example.test', timeZone: VN, dealId: 'not-an-id' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('leaves the bookings of a deal that is deleted in place, unlinked', async () => {
    const o = await org();
    const day = bookableDay();
    const deal = await o.deal(await o.party('Khách để xóa'));
    const booking = await o.book(day, 540);
    await o.exec(o.host, 'crm.booking.link_deal', { bookingId: booking, dealId: deal.id });
    await o.exec(o.owner, 'crm.deal.delete', { dealId: deal.id });
    expect(await o.dealOf(booking)).toBeNull();
    expect((await o.item(o.host, booking)).status).toBe('confirmed');
  });
});
