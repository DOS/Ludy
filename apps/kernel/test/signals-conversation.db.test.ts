// SPDX-License-Identifier: AGPL-3.0-only
// Rule 4 of Vy's cross-app alerts on Home, end to end on PostgreSQL 17 (Vy plan C4, rule 4, #3124): the real kernel.today over the real CRM open deals and the real inbox read, for a real owner and
// members, with nothing stood in. A customer conversation (status new, the customer wrote last) unanswered for 24 hours or more whose contact has an open deal gives one flag per contact, linking to the
// thread in Hộp thư. It fires on a seeded case (open deal, inbound unanswered 25 h) and not on its near misses (answered, 23 h, deal won or lost, a thread the member may not read, a resolved
// thread), and no message text crosses into the item or the read's answer. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { CONVERSATION_UNANSWERED_SIGNALS_READ, type Deal, type PipelineStage, type TodayItem } from '@crove/kernel-contract';
import { DomainError, Runtime } from '@crove/kernel-runtime';
import { crmCommands, crmQueries } from '@crove/mod-crm';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const RULE = 'signal:conversation-unanswered:';
const SECRET = 'Anh Nam hỏi giá lô hàng bí mật';

suite('the unanswered conversation rule on Home, end to end (#3124)', () => {
  const dbName = `crove_test_signals_conversation_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
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
  const rows = <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) => admin(async (c) => (await c.query<T>(text, params)).rows);
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@conv.test`, name: null }) as Promise<string>;

  async function org() {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const [member, limited] = [await identity('member'), await identity('limited')];
    await rows("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')", [orgId, member, limited]);
    const channel = async (): Promise<string> =>
      (await rows<{ id: string }>("INSERT INTO crove_kernel.channel_connection (org_id, provider, external_account_id, display_name, connected_by) VALUES ($1, 'sandbox', $2, 'Kênh thử', $3) RETURNING id", [orgId, `acct-${randomUUID().slice(0, 8)}`, owner]))[0]?.id as string;
    const open = await channel();
    const closed = await channel();
    // `limited` may use only the closed channel; `member` is limited to none, so uses every one.
    await rows('INSERT INTO crove_kernel.channel_access (org_id, user_id, channel_connection_id, created_by) VALUES ($1, $2, $3, $4)', [orgId, limited, closed, owner]);
    const exec = <T>(user: string, command: string, input: unknown) => rt.execute<T>(command, input, { actor: asUser(user), orgId });
    const home = async (user: string) => (await rt.query<{ items: TodayItem[]; failed: number }>('kernel.today', {}, { actor: asUser(user), orgId })).items;
    const party = (name: string) => rows<{ id: string }>("INSERT INTO crove_kernel.party (org_id, name, kind) VALUES ($1, $2, 'organization') RETURNING id", [orgId, name]).then((r) => (r[0] as { id: string }).id);
    const stage = async (name: string) => ((await exec<PipelineStage[]>(owner, 'crm.pipeline.setup', {})).find((s) => s.name === name) as PipelineStage);
    const openDeal = (partyId: string) => exec<Deal>(owner, 'crm.deal.create', { partyId, title: 'Hợp đồng bí mật', amount: '15000000', expectedClose: null });
    async function closedDeal(partyId: string, stageName: string): Promise<void> {
      const deal = await openDeal(partyId);
      await exec<Deal>(owner, 'crm.deal.move', { dealId: deal.id, version: deal.version, stageId: (await stage(stageName)).id });
    }
    // A thread of `partyId` whose messages arrived `hoursAgo` hours before now: [direction, hoursAgo] in order. The last of the thread decides its status as the inbox's own rule does (the customer last: new).
    async function thread(partyId: string | null, messages: Array<['in' | 'out', number] | ['in' | 'out', number, number]>, over: { channelId?: string; kind?: 'direct' | 'comment_thread'; status?: 'new' | 'pending' | 'resolved'; hidden?: boolean; removed?: boolean } = {}): Promise<string> {
      const id = randomUUID();
      const last = messages.at(-1)?.[0];
      const status = over.status ?? (last === 'in' ? 'new' : 'pending');
      await admin(async (c) => {
        await c.query('BEGIN');
        await c.query(
          `INSERT INTO crove_kernel.conversation (org_id, id, channel_connection_id, kind, external_thread_id, party_id, status, last_seq, resolved_at, last_inbound_at, last_message_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ${status === 'resolved' ? 'now()' : 'NULL'}, now(), now())`,
          [orgId, id, over.channelId ?? open, over.kind ?? 'comment_thread', `t-${id}`, partyId, status, messages.length],
        );
        for (const [i, [direction, hours, receivedHours]] of messages.entries()) {
          const at = `now() - make_interval(secs => ${Math.round(hours * 3600)})`;
          const arrived = `now() - make_interval(secs => ${Math.round((receivedHours ?? hours) * 3600)})`;
          await c.query(
            `INSERT INTO crove_kernel.conversation_message (org_id, conversation_id, channel_connection_id, kind, seq, direction, sent_at, received_at, author_kind, author_user_id, body, send_state, hidden_at, platform_removed_at)
             VALUES ($1, $2, $3, $4, $5, $6, ${at}, ${arrived}, $7, NULL, $8, $9, ${over.hidden && direction === 'in' ? 'now()' : 'NULL'}, ${over.removed && direction === 'in' ? 'now()' : 'NULL'})`,
            [orgId, id, over.channelId ?? open, over.kind ?? 'comment_thread', i + 1, direction, direction === 'in' ? 'contact' : 'system', direction === 'in' ? SECRET : 'Dạ em gửi báo giá ạ', direction === 'in' ? null : 'sent'],
          );
        }
        await c.query('COMMIT');
      });
      return id;
    }
    return { orgId, owner, member, limited, open, closed, home, party, openDeal, closedDeal, thread, exec };
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
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    pool = createPool({ connectionString: url.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...crmCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...crmQueries],
    });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  const fired = (items: TodayItem[]) => items.filter((i) => i.id.startsWith(RULE) && !i.id.endsWith(':more')).map((i) => i.id.slice(RULE.length));

  it('fires for a customer unanswered 25 hours on an open deal, and not on its near misses', async () => {
    const o = await org();
    const [late, recent, answered, wonDeal, lostDeal, noDeal, resolved, hiddenOnly, noContact, removedOnly, lateArrival, answeredStaleStatus] = [await o.party('A'), await o.party('B'), await o.party('C'), await o.party('D'), await o.party('E'), await o.party('F'), await o.party('G'), await o.party('H'), await o.party('I'), await o.party('J'), await o.party('K'), await o.party('L')];
    for (const p of [late, recent, answered, resolved, hiddenOnly, noContact, removedOnly, lateArrival, answeredStaleStatus]) await o.openDeal(p);
    await o.closedDeal(wonDeal, 'Thắng');
    await o.closedDeal(lostDeal, 'Thua');
    const lateThread = await o.thread(late, [['in', 25]]);
    await o.thread(recent, [['in', 23]]); // 23 hours: inside the window
    await o.thread(answered, [['in', 30], ['out', 26]]); // answered 26 hours ago: nothing waits
    await o.thread(wonDeal, [['in', 40]]); // the deal is won
    await o.thread(lostDeal, [['in', 40]]); // the deal is lost
    await o.thread(noDeal, [['in', 40]]); // no deal at all
    await o.thread(resolved, [['in', 40]], { status: 'resolved' }); // a person closed it
    await o.thread(hiddenOnly, [['in', 40]], { hidden: true }); // the only message was hidden by the org
    await o.thread(null, [['in', 40]]); // a thread with no contact set joins nothing
    await o.thread(removedOnly, [['in', 40]], { removed: true }); // the customer removed their only message
    await o.thread(lateArrival, [['in', 40, 10]]); // written 40 h ago by the sender's clock but only stored 10 h ago: the storing time counts
    await o.thread(answeredStaleStatus, [['in', 30], ['out', 26]], { status: 'new' }); // the status says new but an answer follows the message: nothing waits
    expect(noContact).toBeTruthy();
    expect(fired(await o.home(o.owner))).toEqual([late]);
    const item = (await o.home(o.owner)).find((i) => i.id === `${RULE}${late}`);
    expect(item).toMatchObject({ kind: 'flag', app: 'conversations', severity: 'warn', title: { key: 'signals.conversationUnanswered', params: { hours: 25 } }, href: `/social/inbox?c=${lateThread}` });
    // The window closed one hour ago.
    expect(Math.round((Date.now() - Date.parse(item?.dueAt as string)) / 3_600_000)).toBe(1);
    // A member with every channel sees the same flag.
    expect(fired(await o.home(o.member))).toEqual([late]);
  });

  it('counts the wait from the oldest customer message after the last answer, and takes the longest wait of a contact\'s threads', async () => {
    const o = await org();
    const [partyA, partyB] = [await o.party('A'), await o.party('B')];
    await o.openDeal(partyA);
    await o.openDeal(partyB);
    // A: answered once, then the customer wrote at 30 h and 26 h: it has waited since 30 h.
    await o.thread(partyA, [['in', 50], ['out', 40], ['in', 30], ['in', 26]]);
    // B: two threads, 27 h and 48 h: the longer wait gives the link.
    await o.thread(partyB, [['in', 27]]);
    const older = await o.thread(partyB, [['in', 48]]);
    const items = await o.home(o.owner);
    expect(items.find((i) => i.id === `${RULE}${partyA}`)?.title.params).toEqual({ hours: 30 });
    expect(items.find((i) => i.id === `${RULE}${partyB}`)).toMatchObject({ title: { params: { hours: 48 } }, href: `/social/inbox?c=${older}` });
    // Longest wait first on Home.
    expect(items.filter((i) => i.id.startsWith(RULE)).map((i) => i.id.slice(RULE.length))).toEqual([partyB, partyA]);
  });

  it('counts from the time Ludy stored a message, so a skewed sender clock neither hides nor inflates a wait', async () => {
    const o = await org();
    const [future, ancient] = [await o.party('A'), await o.party('B')];
    await o.openDeal(future);
    await o.openDeal(ancient);
    // A mail dated 10 hours in the future (a wrong Date header) that arrived 30 hours ago: the wait is 30 hours, not hidden.
    await o.thread(future, [['in', -10, 30]]);
    // A mail dated 200 hours ago that arrived 5 hours ago: the wait is 5 hours, so nothing fires.
    await o.thread(ancient, [['in', 200, 5]]);
    const items = await o.home(o.owner);
    expect(fired(items)).toEqual([future]);
    expect(items.find((i) => i.id === `${RULE}${future}`)?.title.params).toEqual({ hours: 30 });
  });

  it('shows a member only the threads they may read: a private message without the permission and a channel they are limited away from give them no flag', async () => {
    const o = await org();
    const [direct, other, readable] = [await o.party('A'), await o.party('B'), await o.party('C')];
    for (const p of [direct, other, readable]) await o.openDeal(p);
    await o.thread(direct, [['in', 30]], { kind: 'direct' }); // a private message: owners and admins only
    await o.thread(other, [['in', 30]], { channelId: o.open }); // a channel `limited` may not use
    await o.thread(readable, [['in', 30]], { channelId: o.closed }); // the one channel `limited` may use
    expect(fired(await o.home(o.owner)).sort()).toEqual([direct, other, readable].sort());
    expect(fired(await o.home(o.member)).sort()).toEqual([other, readable].sort());
    expect(fired(await o.home(o.limited))).toEqual([readable]);
  });

  it('lets no message text cross: not in the item, not in the read\'s answer', async () => {
    const o = await org();
    const p = await o.party('Công ty Bí Mật');
    await o.openDeal(p);
    await o.thread(p, [['in', 26]]);
    const home = JSON.stringify(await o.home(o.owner));
    expect(home).toContain(`${RULE}${p}`);
    expect(home).not.toMatch(/Nam|giá|bí mật|Bí Mật|Hợp đồng|Dạ em/);
    const answer = await rt.query<unknown[]>(CONVERSATION_UNANSWERED_SIGNALS_READ, { partyIds: [p] }, { actor: asUser(o.owner), orgId: o.orgId });
    expect(answer).toHaveLength(1);
    expect(Object.keys(answer[0] as object).sort()).toEqual(['conversationId', 'partyId', 'since']);
    expect(JSON.stringify(answer)).not.toMatch(/Nam|giá|bí mật|Dạ em/);
  });

  it('answers the inbox read for a person\'s own session only, with a strict input', async () => {
    const o = await org();
    const p = await o.party('A');
    await expect(rt.query(CONVERSATION_UNANSWERED_SIGNALS_READ, { partyIds: [] }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toBeDefined();
    await expect(rt.query(CONVERSATION_UNANSWERED_SIGNALS_READ, { partyIds: [p], extra: 1 }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toBeDefined();
    const grant = { ...asUser(o.owner), mcp: { grantId: randomUUID(), clientId: 'c', clientName: 'C', scopes: ['ludy.read'], kind: 'company' as const } };
    await expect(rt.query(CONVERSATION_UNANSWERED_SIGNALS_READ, { partyIds: [p] }, { actor: grant, orgId: o.orgId })).rejects.toBeInstanceOf(DomainError);
  });
});
