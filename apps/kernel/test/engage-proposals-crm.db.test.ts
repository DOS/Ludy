// SPDX-License-Identifier: AGPL-3.0-only
// The CRM twins an AI coworker asks with (epic #3857, E4, issue #3863; ADR-0051 decision 10): sending a quote and moving or cancelling a booking. For each: the call leaves one pending, tainted proposal and
// changes nothing; a rejection changes nothing, ever; an approval runs the original command once, as the approver, with every check it has (a quote edited since is stale, a booking time that is taken or a booking
// that is no longer changeable) judged then and leaving the proposal pending when it refuses. Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run makes its own database.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isVietnamHoliday, zonedDate, zonedInstant, type Deal, type EventType, type PipelineStage, type Quote } from '@ludy/kernel-contract';
import { bookingRequest } from '../src/booking-page.ts';
import { ADMIN, startHarness, type Harness } from './engage-proposals-harness.ts';

const suite = ADMIN ? describe : describe.skip;
const VN = 'Asia/Ho_Chi_Minh';
const DAY = 86_400_000;

// A day at least three days ahead that is not a Vietnamese public holiday, in Vietnam time.
function bookableDay(offset = 3): string {
  let date = zonedDate(VN, Date.now() + offset * DAY);
  while (isVietnamHoliday(date)) date = zonedDate(VN, Date.parse(`${date}T12:00:00Z`) + DAY);
  return date;
}
const at = (date: string, minute: number) => new Date(zonedInstant(VN, date, minute)).toISOString();
const item = (over: Record<string, unknown> = {}) => ({ kind: 'item' as const, description: 'Gói kế toán năm', unit: 'gói', quantity: '2', unitPrice: '1500000', vatRate: '10%', ...over });

suite('the CRM proposal twins (#3863)', () => {
  let h: Harness;
  let slug = '';
  let dealId = '';
  const day = bookableDay();
  beforeAll(async () => {
    h = await startHarness('engage_crm');
    slug = (await h.q<{ slug: string }>('SELECT slug FROM ludy_kernel.tenant WHERE org_id = $1', [h.orgId])).rows[0]?.slug as string;
    // The owner hosts a 30-minute call, bookable all day every day in Vietnam time.
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
    const party = (await h.q<{ id: string }>("INSERT INTO ludy_kernel.party (org_id, name, kind, email, tax_code, address) VALUES ($1, 'Công ty Khách', 'organization', 'khach@example.test', '0312345678', '12 Lê Lợi, Quận 1') RETURNING id", [h.orgId])).rows[0]?.id as string;
    await exec<PipelineStage[]>('crm.pipeline.setup', {});
    dealId = (await exec<Deal>('crm.deal.create', { partyId: party, title: 'Gói kế toán năm', amount: '15000000', expectedClose: '2026-12-31' })).id;
  }, 300_000);
  afterAll(async () => {
    await h?.stop();
  });

  const exec = <O = unknown>(command: string, input: unknown) => h.runtime.execute<O>(command, input, { actor: h.person(h.owner), orgId: h.orgId });

  // A draft quote with one priced line, ready to send.
  async function readyQuote(): Promise<Quote> {
    const empty = await exec<Quote>('crm.quote.save', { dealId, lines: [] });
    return exec<Quote>('crm.quote.save', { quoteId: empty.id, version: empty.version, lines: [item()] });
  }
  const quoteRow = async (quoteId: string) => (await h.q<{ status: string; version: number; sent_via: string | null }>('SELECT status, version, sent_via FROM ludy_crm.quote WHERE org_id = $1 AND id = $2', [h.orgId, quoteId])).rows[0];

  // A confirmed booking of the type at `minute` of the day: the visitor's request, then the worker's confirmation.
  let guests = 0;
  async function booking(minute: number) {
    guests += 1;
    await bookingRequest(h.runtime, slug, 'tu-van', { startsAt: at(day, minute), name: 'Nguyễn Văn Khách', email: `khach${guests}@example.test`, phone: '0901234567', note: 'Hỏi về thuế', timeZone: VN });
    const row = (await h.q<{ id: string }>('SELECT id FROM ludy_crm.booking WHERE org_id = $1 AND starts_at = $2', [h.orgId, at(day, minute)])).rows[0];
    const bookingId = row?.id as string;
    await h.system('test.crm.booking', 'crm.booking.confirm', { bookingId });
    return bookingId;
  }
  const bookingRow = async (bookingId: string) => {
    const row = (await h.q<{ status: string; starts_at: Date }>('SELECT status, starts_at FROM ludy_crm.booking WHERE org_id = $1 AND id = $2', [h.orgId, bookingId])).rows[0];
    return { status: row?.status, startsAt: row?.starts_at.toISOString() };
  };

  it('quote send: waits as a tainted proposal, the quote stays a draft until a person approves, then it is sent once; a quote edited since is refused as stale', async () => {
    const quote = await readyQuote();
    const { actor } = await h.grant();
    const payload = { quoteId: quote.id, version: quote.version, via: 'link' };
    const made = await h.propose(actor, 'crm.quote.send_approved', payload);
    expect(made.status).toBe('pending');
    expect(await h.proposal(made.proposalId)).toMatchObject({ status: 'pending', command: 'crm.quote.send_approved', kind: 'crm.quote_send', tainted: true, payload });
    expect((await h.proposal(made.proposalId)).requested_by_grant).not.toBeNull();
    // The original never ran: the quote is still a draft.
    expect(await h.ran('crm.quote.send')).toBe(0);
    expect(await quoteRow(quote.id)).toMatchObject({ status: 'draft', version: quote.version, sent_via: null });

    // Someone edits the quote while the proposal waits: the original's own version check refuses at the approval, the proposal stays pending, nothing is sent.
    const edited = await exec<Quote>('crm.quote.save', { quoteId: quote.id, version: quote.version, lines: [item({ quantity: '3' })] });
    await expect(h.approve(made.proposalId)).rejects.toMatchObject({ code: 'STALE_VERSION' });
    expect((await h.proposal(made.proposalId)).status).toBe('pending');
    expect(await h.executions('crm.quote.send', made.proposalId)).toBe(0);
    expect(await quoteRow(quote.id)).toMatchObject({ status: 'draft', version: edited.version });

    // A proposal made on what stands now goes through once.
    const fresh = await h.propose(actor, 'crm.quote.send_approved', { quoteId: quote.id, version: edited.version, via: 'link' });
    await h.approve(fresh.proposalId);
    expect((await h.proposal(fresh.proposalId)).status).toBe('executed');
    expect(await h.executions('crm.quote.send', fresh.proposalId)).toBe(1);
    expect(await quoteRow(quote.id)).toMatchObject({ status: 'sent', sent_via: 'link' });
    // A second approval finds nothing to approve: no second send.
    await expect(h.approve(fresh.proposalId)).rejects.toMatchObject({ status: expect.any(Number) });
    expect(await h.executions('crm.quote.send', fresh.proposalId)).toBe(1);
    expect(await h.ran('crm.quote.send')).toBe(1);
  });

  it('quote send: a rejected proposal never sends, a key the original does not declare is refused, and a person cannot call the twin', async () => {
    const quote = await readyQuote();
    const { actor } = await h.grant();
    const made = await h.propose(actor, 'crm.quote.send_approved', { quoteId: quote.id, version: quote.version, via: 'link' });
    await h.reject(made.proposalId);
    expect((await h.proposal(made.proposalId)).status).toBe('rejected');
    await expect(h.approve(made.proposalId)).rejects.toBeDefined();
    expect(await h.executions('crm.quote.send', made.proposalId)).toBe(0);
    expect(await quoteRow(quote.id)).toMatchObject({ status: 'draft', sent_via: null });

    await expect(h.propose(actor, 'crm.quote.send_approved', { quoteId: quote.id, version: quote.version, via: 'link', approvedBy: 'manager' })).rejects.toBeDefined();
    await expect(exec('crm.quote.send_approved', { payload: { quoteId: quote.id, version: quote.version, via: 'link' } })).rejects.toMatchObject({ status: 403 });
    expect(await quoteRow(quote.id)).toMatchObject({ status: 'draft' });
  });

  it('booking move: waits as a tainted proposal, the booking keeps its time until a person approves, then it moves once; a time taken meanwhile is refused', async () => {
    const id = await booking(540);
    const { actor } = await h.grant();
    const payload = { bookingId: id, startsAt: at(day, 720) };
    const made = await h.propose(actor, 'crm.booking.move_approved', payload);
    expect(made.status).toBe('pending');
    expect(await h.proposal(made.proposalId)).toMatchObject({ status: 'pending', command: 'crm.booking.move_approved', kind: 'crm.booking_move', tainted: true, payload });
    expect((await h.proposal(made.proposalId)).requested_by_grant).not.toBeNull();
    expect(await h.ran('crm.booking.move')).toBe(0);
    expect(await bookingRow(id)).toEqual({ status: 'confirmed', startsAt: at(day, 540) });

    // The new time is taken while it waits: the original's own check refuses at the approval, the proposal stays pending, the booking stays where it was.
    await exec('kernel.calendar.event.add', { startsAt: at(day, 720), endsAt: at(day, 750), timeZone: VN, title: 'Bận', kind: 'manual' });
    await expect(h.approve(made.proposalId)).rejects.toMatchObject({ code: 'BOOKING_TIME_TAKEN' });
    expect((await h.proposal(made.proposalId)).status).toBe('pending');
    expect(await h.executions('crm.booking.move', made.proposalId)).toBe(0);
    expect(await bookingRow(id)).toEqual({ status: 'confirmed', startsAt: at(day, 540) });

    // A free time goes through once.
    const free = await h.propose(actor, 'crm.booking.move_approved', { bookingId: id, startsAt: at(day, 780) });
    await h.approve(free.proposalId);
    expect((await h.proposal(free.proposalId)).status).toBe('executed');
    expect(await h.executions('crm.booking.move', free.proposalId)).toBe(1);
    expect(await bookingRow(id)).toEqual({ status: 'confirmed', startsAt: at(day, 780) });
    // A second approval finds nothing to approve: no second move.
    await expect(h.approve(free.proposalId)).rejects.toMatchObject({ status: expect.any(Number) });
    expect(await h.executions('crm.booking.move', free.proposalId)).toBe(1);
    expect(await h.ran('crm.booking.move')).toBe(1);
  });

  it('booking move: a rejected proposal never moves, a key the original does not declare is refused, and a person cannot call the twin', async () => {
    const id = await booking(840);
    const { actor } = await h.grant();
    const made = await h.propose(actor, 'crm.booking.move_approved', { bookingId: id, startsAt: at(day, 900) });
    await h.reject(made.proposalId);
    expect((await h.proposal(made.proposalId)).status).toBe('rejected');
    await expect(h.approve(made.proposalId)).rejects.toBeDefined();
    expect(await h.executions('crm.booking.move', made.proposalId)).toBe(0);
    expect(await bookingRow(id)).toEqual({ status: 'confirmed', startsAt: at(day, 840) });

    await expect(h.propose(actor, 'crm.booking.move_approved', { bookingId: id, startsAt: at(day, 900), approvedBy: 'manager' })).rejects.toBeDefined();
    await expect(exec('crm.booking.move_approved', { payload: { bookingId: id, startsAt: at(day, 900) } })).rejects.toMatchObject({ status: 403 });
    expect(await bookingRow(id)).toEqual({ status: 'confirmed', startsAt: at(day, 840) });
  });

  it('booking cancel: waits as a tainted proposal, the booking stays until a person approves, then it is cancelled once; a booking cancelled meanwhile is refused as not changeable', async () => {
    const id = await booking(960);
    const { actor } = await h.grant();
    const payload = { bookingId: id };
    const made = await h.propose(actor, 'crm.booking.cancel_approved', payload);
    expect(made.status).toBe('pending');
    expect(await h.proposal(made.proposalId)).toMatchObject({ status: 'pending', command: 'crm.booking.cancel_approved', kind: 'crm.booking_cancel', tainted: true, payload });
    expect((await h.proposal(made.proposalId)).requested_by_grant).not.toBeNull();
    expect(await h.ran('crm.booking.cancel')).toBe(0);
    expect(await bookingRow(id)).toEqual({ status: 'confirmed', startsAt: at(day, 960) });

    await h.approve(made.proposalId);
    expect((await h.proposal(made.proposalId)).status).toBe('executed');
    expect(await h.executions('crm.booking.cancel', made.proposalId)).toBe(1);
    expect(await bookingRow(id)).toEqual({ status: 'cancelled', startsAt: at(day, 960) });
    // A second approval finds nothing to approve: no second cancel.
    await expect(h.approve(made.proposalId)).rejects.toMatchObject({ status: expect.any(Number) });
    expect(await h.executions('crm.booking.cancel', made.proposalId)).toBe(1);
    expect(await h.ran('crm.booking.cancel')).toBe(1);

    // A person cancels another booking while a proposal for it waits: the original's own check refuses at the approval, and the proposal stays pending with no run under it.
    const other = await booking(1020);
    const stale = await h.propose(actor, 'crm.booking.cancel_approved', { bookingId: other });
    await exec('crm.booking.cancel', { bookingId: other });
    await expect(h.approve(stale.proposalId)).rejects.toMatchObject({ code: 'BOOKING_NOT_CHANGEABLE' });
    expect((await h.proposal(stale.proposalId)).status).toBe('pending');
    expect(await h.executions('crm.booking.cancel', stale.proposalId)).toBe(0);
  });

  it('booking cancel: a rejected proposal never cancels, a key the original does not declare is refused, and a person cannot call the twin', async () => {
    const id = await booking(1080);
    const { actor } = await h.grant();
    const made = await h.propose(actor, 'crm.booking.cancel_approved', { bookingId: id });
    await h.reject(made.proposalId);
    expect((await h.proposal(made.proposalId)).status).toBe('rejected');
    await expect(h.approve(made.proposalId)).rejects.toBeDefined();
    expect(await h.executions('crm.booking.cancel', made.proposalId)).toBe(0);
    expect(await bookingRow(id)).toEqual({ status: 'confirmed', startsAt: at(day, 1080) });

    await expect(h.propose(actor, 'crm.booking.cancel_approved', { bookingId: id, approvedBy: 'manager' })).rejects.toBeDefined();
    await expect(exec('crm.booking.cancel_approved', { payload: { bookingId: id } })).rejects.toMatchObject({ status: 403 });
    expect(await bookingRow(id)).toEqual({ status: 'confirmed', startsAt: at(day, 1080) });
  });
});
