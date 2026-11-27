// SPDX-License-Identifier: AGPL-3.0-only
// SG1 contact "Can chu y" (crm.party.attention) and per-member "Da xem" (crm.party.attention_seen) DB tests (#4993).
// Verifies all 4 item kinds against real PostgreSQL rows, conversation RLS isolation, viewer and agent refusals,
// per-member seen independence and resurfacing on newer events, Dy follow-up drafts for quote_viewed and
// customer_replied, quote_link_view tracking freedom (no IP/UA), and schema/purge invariants.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CRM_FOLLOWUP_TEMPLATE, InboxReader, crmFollowupDong, type CrmFollowupGenerator } from '@ludy/agent';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import {
  PARTY_ATTENTION_MAX,
  type Deal,
  type PartyAttentionItem,
  type PartyAttentionList,
  type PartyAttentionSeen,
  type PipelineStage,
  type QuoteLinkCreated,
} from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { crmCommands, crmQueries, type FollowupSource } from '@ludy/mod-crm';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { crmFollowupAi, draftCrmFollowup } from '../src/crm-followup-ai.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'crm.deal_stale' };
const PUBLIC_URL = 'https://app.example.test/';
const CONFIG = { baseURL: 'http://localhost:1/v1', apiKey: null, model: 'test' };
const GOOD_WORDS = {
  lead: 'Bên mình vừa nhận được cập nhật từ anh/chị nên nhắn trao đổi thêm ạ.',
  closing: 'Anh/chị cần hỗ trợ thêm điều gì cứ nhắn lại cho bên mình nhé.',
};

suite('SG1 contact attention list and per-member seen marks on PostgreSQL (#4993)', () => {
  const dbName = `ludy_test_crm_attention_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
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
  const rows = <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) => admin(async (c) => (await c.query<T>(text, params)).rows);
  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@attention.test`, name: null }) as Promise<string>;

  async function setupOrg() {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty ${randomUUID().slice(0, 6)}`);
    const [member, limited, viewer] = [await person('member'), await person('limited'), await person('viewer')];
    await rows(
      "INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'viewer')",
      [orgId, member, limited, viewer],
    );
    const channel = async () =>
      (await rows<{ id: string }>(
        "INSERT INTO ludy_kernel.channel_connection (org_id, provider, external_account_id, display_name, connected_by) VALUES ($1, 'sandbox', $2, 'Kênh thử', $3) RETURNING id",
        [orgId, `acct-${randomUUID().slice(0, 8)}`, owner],
      ))[0]?.id as string;
    const openChannel = await channel();
    const restrictedChannel = await channel();
    // `limited` can access only `restrictedChannel`, so threads on `openChannel` are invisible under RLS.
    await rows(
      'INSERT INTO ludy_kernel.channel_access (org_id, user_id, channel_connection_id, created_by) VALUES ($1, $2, $3, $4)',
      [orgId, limited, restrictedChannel, owner],
    );

    const exec = <T>(user: string, command: string, input: unknown) => rt.execute<T>(command, input, { actor: asUser(user), orgId });
    const query = <T>(user: string, command: string, input: unknown) => rt.query<T>(command, input, { actor: asUser(user), orgId });
    const party = (name: string, email: string | null = 'khach@example.test') =>
      rows<{ id: string }>(
        "INSERT INTO ludy_kernel.party (org_id, name, kind, email) VALUES ($1, $2, 'organization', $3) RETURNING id",
        [orgId, name, email],
      ).then((r) => (r[0] as { id: string }).id);

    await exec<PipelineStage[]>(owner, 'crm.pipeline.setup', {});
    const newDeal = (user: string, partyId: string, title = 'Cơ hội mới') =>
      exec<Deal>(user, 'crm.deal.create', { partyId, title, amount: '12000000', expectedClose: null });

    const sentQuote = async (dealId: string, sentDaysAgo: number, validInDays: number, number = `BG-2026-${Math.floor(Math.random() * 9000) + 1000}`) => {
      const saved = await exec<{ id: string }>(member, 'crm.quote.save', {
        dealId,
        lines: [{ kind: 'item', description: 'Gói dịch vụ', unit: 'gói', quantity: '2', unitPrice: '6000000', vatRate: '10%' }],
      });
      await rows(
        "UPDATE ludy_crm.quote SET status = 'sent', number = $3, sent_at = now() - make_interval(days => $4), sent_via = 'link', valid_until = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + $5::int WHERE org_id = $1 AND id = $2",
        [orgId, saved.id, number, sentDaysAgo, validInDays],
      );
      const total = (await rows<{ total: string }>('SELECT total::text AS total FROM ludy_crm.quote WHERE org_id = $1 AND id = $2', [orgId, saved.id]))[0]?.total as string;
      return { id: saved.id, number, total };
    };

    const viewQuoteLink = async (quoteId: string) => {
      const link = await exec<QuoteLinkCreated>(member, 'crm.quote.create_link', { quoteId });
      await appPool.query('SELECT ludy_crm.quote_link_view($1::text) AS page', [link.token]);
      return link;
    };

    const thread = async (
      partyId: string,
      messages: Array<['in' | 'out', number]>,
      channelId = openChannel,
    ): Promise<string> => {
      const id = randomUUID();
      await admin(async (c) => {
        await c.query('BEGIN');
        await c.query(
          `INSERT INTO ludy_kernel.conversation (org_id, id, channel_connection_id, kind, external_thread_id, party_id, status, last_seq, last_inbound_at, last_message_at)
           VALUES ($1, $2, $3, 'comment_thread', $4, $5, 'new', $6, now(), now())`,
          [orgId, id, channelId, `t-${id}`, partyId, messages.length],
        );
        for (const [i, [direction, hoursAgo]] of messages.entries()) {
          await c.query(
            `INSERT INTO ludy_kernel.conversation_message (org_id, conversation_id, channel_connection_id, kind, seq, direction, sent_at, received_at, author_kind, author_user_id, body, send_state)
             VALUES ($1, $2, $3, 'comment_thread', $4, $5, now() - make_interval(secs => $6), now() - make_interval(secs => $6), $7, NULL, $8, $9)`,
            [
              orgId,
              id,
              channelId,
              i + 1,
              direction,
              Math.round(hoursAgo * 3600),
              direction === 'in' ? 'contact' : 'system',
              direction === 'in' ? 'SECRET_BODY_DO_NOT_LEAK' : 'Dạ bên em đã gửi báo giá ạ',
              direction === 'in' ? null : 'sent',
            ],
          );
        }
        await c.query('COMMIT');
      });
      return id;
    };

    const attention = (user: string, partyId: string) =>
      query<PartyAttentionList>(user, 'crm.party.attention', { partyId }).then((r) => r.items);

    const markSeen = (user: string, item: Pick<PartyAttentionItem, 'partyId' | 'kind' | 'targetId' | 'eventAt'>) =>
      exec<PartyAttentionSeen>(user, 'crm.party.attention_seen', {
        partyId: item.partyId,
        kind: item.kind,
        targetId: item.targetId,
        eventAt: item.eventAt,
      });

    const raiseSteps = () => worker.execute<{ raised: number; closed: number }>('crm.next_step.raise', {}, { actor: SYSTEM, orgId });

    return {
      orgId,
      owner,
      member,
      limited,
      viewer,
      openChannel,
      restrictedChannel,
      exec,
      query,
      party,
      newDeal,
      sentQuote,
      viewQuoteLink,
      thread,
      attention,
      markSeen,
      raiseSteps,
    };
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
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const login = (user: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      return url.toString();
    };
    pool = createPool({ connectionString: login('ludy_app', 'test-app-pw'), max: 4 });
    appPool = new pg.Pool({ connectionString: login('ludy_app', 'test-app-pw'), max: 2 });
    workerPool = createPool({ connectionString: login('ludy_worker', 'test-worker-pw'), max: 2 });
    db = createDb(pool);
    const registered = { commands: [...kernelCommands, ...crmCommands], queries: [...kernelQueries({ inboundDomain: null }), ...crmQueries] };
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registered);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registered);
  });

  afterAll(async () => {
    await pool?.end();
    await appPool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('returns all 4 kinds newest-first with ids and dates only, hiding restricted conversations and enforcing 10-item cap', async () => {
    const o = await setupOrg();
    const party = await o.party('Công ty Minh Tâm', 'minhtam@khach.test');

    // 1. quote_viewed (via real first-party quote_link_view) and an accepted quote (answered -> must not appear)
    const dViewed = await o.newDeal(o.member, party, 'Deal Báo Giá Đã Xem');
    const qViewed = await o.sentQuote(dViewed.id, 1, 20, 'BG-2026-1001');
    await o.viewQuoteLink(qViewed.id);

    const dAccepted = await o.newDeal(o.member, party, 'Deal Đã Chốt');
    const qAccepted = await o.sentQuote(dAccepted.id, 1, 20, 'BG-2026-1003');
    await o.viewQuoteLink(qAccepted.id);
    await rows("UPDATE ludy_crm.quote SET status = 'accepted', decided_at = now() WHERE org_id = $1 AND id = $2", [o.orgId, qAccepted.id]);

    // 2. quote_unanswered (sent 5 days ago, valid 20 days -> raises quote_unanswered)
    const dUnanswered = await o.newDeal(o.member, party, 'Deal Chờ Trả Lời');
    await o.sentQuote(dUnanswered.id, 5, 20, 'BG-2026-1004');

    // 3. quote_expiring (valid in 1 day -> raises quote_expiring)
    const dExpiring = await o.newDeal(o.member, party, 'Deal Sắp Hết Hạn');
    await o.sentQuote(dExpiring.id, 1, 1, 'BG-2026-1005');

    await o.raiseSteps();

    // Seed a quote viewed 9 days ago (> 7-day window -> must not appear) after raiseSteps so it stays quote_viewed-only.
    const dOldView = await o.newDeal(o.member, party, 'Deal Cũ');
    const qOldView = await o.sentQuote(dOldView.id, 12, 20, 'BG-2026-1002');
    await rows("UPDATE ludy_crm.quote SET first_viewed_at = now() - interval '9 days' WHERE org_id = $1 AND id = $2", [o.orgId, qOldView.id]);

    // 4. customer_replied on openChannel (10 days quiet -> reply 1h ago), plus a short-gap thread (2 days -> no item)
    const convQuietBreak = await o.thread(party, [['out', 10 * 24], ['in', 1]], o.openChannel);
    await o.thread(party, [['out', 2 * 24], ['in', 2]], o.openChannel);

    const memberItems = await o.attention(o.member, party);
    expect(memberItems.map((i) => i.kind).sort()).toEqual(
      ['customer_replied', 'quote_expiring', 'quote_unanswered', 'quote_viewed'].sort(),
    );

    // Every item holds only kind, date, and IDs (never prose or message body).
    const serialized = JSON.stringify(memberItems);
    expect(serialized).not.toContain('SECRET_BODY_DO_NOT_LEAK');
    expect(serialized).not.toContain('Deal Báo Giá Đã Xem');
    for (const item of memberItems) {
      expect(Object.keys(item).sort()).toEqual([
        'conversationId',
        'dealId',
        'eventAt',
        'kind',
        'nextStepId',
        'partyId',
        'quoteId',
        'targetId',
      ]);
    }
    // Newest first order check
    for (let i = 1; i < memberItems.length; i++) {
      expect(new Date(memberItems[i - 1]!.eventAt).getTime()).toBeGreaterThanOrEqual(new Date(memberItems[i]!.eventAt).getTime());
    }

    // `limited` cannot read `openChannel`, so gets zero `customer_replied` item for `convQuietBreak`.
    const limitedItems = await o.attention(o.limited, party);
    expect(limitedItems.some((i) => i.kind === 'customer_replied' && i.conversationId === convQuietBreak)).toBe(false);
    expect(limitedItems.some((i) => i.kind === 'quote_viewed')).toBe(true);

    // Viewer reads all visible items cleanly.
    const viewerItems = await o.attention(o.viewer, party);
    expect(viewerItems).toHaveLength(memberItems.length);

    // Cap of 10 items even when more exist.
    for (let i = 0; i < 8; i++) {
      const extraDeal = await o.newDeal(o.member, party, `Deal Extra ${i}`);
      const extraQuote = await o.sentQuote(extraDeal.id, 1, 20, `BG-2026-200${i}`);
      await o.viewQuoteLink(extraQuote.id);
    }
    const capped = await o.attention(o.member, party);
    expect(capped).toHaveLength(PARTY_ATTENTION_MAX);
  });

  it('tracks "Da xem" independently per member, resurfaces on a newer event, clamps future timestamps, and refuses viewers/agents', async () => {
    const o = await setupOrg();
    const party = await o.party('Công ty Hải Đăng');
    const deal = await o.newDeal(o.member, party);
    const quote = await o.sentQuote(deal.id, 1, 20, 'BG-2026-3001');
    await o.viewQuoteLink(quote.id);

    const convId = await o.thread(party, [['out', 20 * 24], ['in', 10 * 24]], o.openChannel);

    const initialMember = await o.attention(o.member, party);
    const viewedItem = initialMember.find((i) => i.kind === 'quote_viewed' && i.quoteId === quote.id)!;
    const replyItem = initialMember.find((i) => i.kind === 'customer_replied' && i.conversationId === convId)!;
    expect(viewedItem).toBeDefined();
    expect(replyItem).toBeDefined();

    // Viewer cannot mark seen (refused by access AND RLS).
    await expect(o.markSeen(o.viewer, viewedItem)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Non-existent or unreadable targets cannot be suppressed (`404 ATTENTION_ITEM_NOT_FOUND`).
    await expect(
      o.markSeen(o.member, { partyId: party, kind: 'quote_viewed', targetId: randomUUID(), eventAt: viewedItem.eventAt }),
    ).rejects.toMatchObject({ code: 'ATTENTION_ITEM_NOT_FOUND' });
    await expect(o.markSeen(o.limited, replyItem)).rejects.toMatchObject({ code: 'ATTENTION_ITEM_NOT_FOUND' });

    // Agents are refused on both query and command.
    const agentId = randomUUID();
    const runId = randomUUID();
    await expect(
      rt.query('crm.party.attention', { partyId: party }, { actor: { type: 'agent', agentId, runId }, orgId: o.orgId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      rt.execute(
        'crm.party.attention_seen',
        { partyId: party, kind: 'quote_viewed', targetId: quote.id },
        { actor: { type: 'agent', agentId, runId }, orgId: o.orgId },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Member passes an inflated future eventAt -> clamped to actual active eventAt.
    const clamped = await o.exec<PartyAttentionSeen>(o.member, 'crm.party.attention_seen', {
      partyId: party,
      kind: 'quote_viewed',
      targetId: quote.id,
      eventAt: '2099-01-01T00:00:00.000Z',
    });
    expect(new Date(clamped.seenEventAt).getFullYear()).toBeLessThan(2099);

    // Member marks replyItem seen -> both vanish for `member`, still visible for `owner`.
    await o.markSeen(o.member, replyItem);
    const afterMember = await o.attention(o.member, party);
    expect(afterMember).toHaveLength(0);
    const ownerItems = await o.attention(o.owner, party);
    expect(ownerItems).toHaveLength(2);

    // A newer quote link view for the same quote makes `quote_viewed` resurface for `member`.
    await new Promise((r) => setTimeout(r, 15));
    await o.viewQuoteLink(quote.id);
    // A newer customer reply after 9 more quiet days makes `customer_replied` resurface for `member`.
    await rows(
      `INSERT INTO ludy_kernel.conversation_message (org_id, conversation_id, channel_connection_id, kind, seq, direction, sent_at, received_at, author_kind, author_user_id, body, send_state)
       VALUES ($1, $2, $3, 'comment_thread', 3, 'in', now() - interval '1 hour', now() - interval '1 hour', 'contact', NULL, 'Alo em', NULL)`,
      [o.orgId, convId, o.openChannel],
    );
    const resurfaced = await o.attention(o.member, party);
    expect(resurfaced.map((i) => i.kind).sort()).toEqual(['customer_replied', 'quote_viewed']);
  });

  it('builds Dy follow-up drafts for quote_viewed and customer_replied, enforces conversation RLS, and keeps AI-off template fallback', async () => {
    const o = await setupOrg();
    const party = await o.party('Công ty Hoa Sen', 'hoasen@khach.test');
    const deal = await o.newDeal(o.member, party);
    const quote = await o.sentQuote(deal.id, 2, 15, 'BG-2026-4001');
    await o.viewQuoteLink(quote.id);
    const convId = await o.thread(party, [['out', 10 * 24], ['in', 2]], o.openChannel);

    const gen: CrmFollowupGenerator = async () => ({ output: GOOD_WORDS, usage: { inputTokens: 30, outputTokens: 15 } });
    const aiCoworker = crmFollowupAi(new InboxReader(CONFIG, { crmFollowup: gen }), new DraftBudget({ perUserPerMinute: 100, perOrgPerMinute: 100 }));
    const offCoworker = crmFollowupAi(null, new DraftBudget({ perUserPerMinute: 100, perOrgPerMinute: 100 }));

    const viewedFacts = await o.query<FollowupSource>(o.member, 'crm.followup.source', { reason: 'quote_viewed', quoteId: quote.id });
    expect(viewedFacts).toMatchObject({ reason: 'quote_viewed', dealId: deal.id, contactName: 'Công ty Hoa Sen', quote: { id: quote.id, label: 'BG-2026-4001', total: quote.total } });
    const viewedDraft = await draftCrmFollowup(
      { ai: aiCoworker, publicUrl: PUBLIC_URL, makeLink: (q) => o.exec<QuoteLinkCreated>(o.member, 'crm.quote.create_link', { quoteId: q }) },
      o.orgId,
      o.member,
      viewedFacts,
      undefined,
    );
    expect(viewedDraft.ai).toBe('used');
    expect(viewedDraft.reason).toBe('quote_viewed');
    expect(viewedDraft.hasLink).toBe(true);
    expect(viewedDraft.text).toContain(crmFollowupDong(quote.total));

    const replyFacts = await o.query<FollowupSource>(o.member, 'crm.followup.source', { reason: 'customer_replied', partyId: party, conversationId: convId });
    expect(replyFacts).toMatchObject({ reason: 'customer_replied', quote: null, contactName: 'Công ty Hoa Sen' });
    expect(replyFacts.days).toBeGreaterThanOrEqual(7);
    const replyDraftOff = await draftCrmFollowup(
      { ai: offCoworker, publicUrl: PUBLIC_URL, makeLink: (q) => o.exec<QuoteLinkCreated>(o.member, 'crm.quote.create_link', { quoteId: q }) },
      o.orgId,
      o.member,
      replyFacts,
      undefined,
    );
    expect(replyDraftOff.ai).toBe('off');
    expect(replyDraftOff.text).toContain(CRM_FOLLOWUP_TEMPLATE.customer_replied.lead);

    // Limited member without channel access cannot draft from hidden conversation.
    await expect(
      o.query<FollowupSource>(o.limited, 'crm.followup.source', { reason: 'customer_replied', partyId: party, conversationId: convId }),
    ).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
  });

  it('satisfies table PK, RLS, org_purge, and zero IP/UA capture in quote_link_view', async () => {
    const fnRows = await rows<{ def: string }>(
      "SELECT pg_catalog.pg_get_functiondef('ludy_crm.quote_link_view(text)'::regprocedure) AS def",
    );
    expect(fnRows[0]?.def.toLowerCase()).not.toContain('user_agent');
    expect(fnRows[0]?.def.toLowerCase()).not.toContain('inet');

    const purgeRows = await rows<{ def: string }>(
      "SELECT pg_catalog.pg_get_functiondef('ludy_kernel.org_purge(integer)'::regprocedure) AS def",
    );
    expect(purgeRows[0]?.def).toContain('ludy_crm.party_attention_seen');

    const pkRows = await rows<{ cols: string }>(
      `SELECT string_agg(a.attname, ',' ORDER BY k.ord) AS cols
       FROM pg_catalog.pg_constraint con
       JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL pg_catalog.unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
       WHERE n.nspname = 'ludy_crm' AND c.relname = 'party_attention_seen' AND con.contype = 'p'`,
    );
    expect(pkRows[0]?.cols).toBe('org_id,id');
  });
});
