// SPDX-License-Identifier: AGPL-3.0-only
// `finance.mcp.cash_forecast` and `finance.mcp.month_close` (#5346) as the runtime runs them for a grant: the figures are the ones the Kế toán screens read for the same books (the projection only
// takes fields away), what the owner entered shows as a count and in the figures, and a grant that sees only part of the books gets nothing. The privacy pins of both tools are invariants
// (apps/kernel/test/invariant/mcp-cash-forecast-projection.db.test.ts and mcp-month-close-projection.db.test.ts); this file is the product flow.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { SIGNAL_PARTIAL_VIEW_CODE, type CashForecast, type MonthClose } from '@ludy/kernel-contract';
import { Runtime, type UserActor } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the finance MCP reads of the cash forecast and the month-close checklist (#5346)', () => {
  const dbName = `ludy_test_mcp_forecast_close_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const user = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const mcp = (userId: string, grantId: string): UserActor => ({ ...user(userId), mcp: { grantId, clientId: 'client-1', clientName: 'Test client', scopes: ['ludy.read'] } });

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
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@forecast-close.test`, name: null }) as Promise<string>;
  const day = (offset: number) => `((pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + ${offset})`;

  async function org(withBranch = false) {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, user(owner), `Org ${randomUUID().slice(0, 6)}`);
    const entity = (await rows<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId]))[0]?.id as string;
    if (withBranch) await rows("INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2)", [orgId, owner]);
    const grant = async () => {
      const id = randomUUID();
      await rows(
        `INSERT INTO ludy_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by)
         VALUES ($1, $2, $3, $5, 'Test client', 'client.example.com', ARRAY['ludy.read'], $4, now(), now() + interval '30 days', $3)`,
        [orgId, id, owner, `oauth-${id}`, `client-${id}`],
      );
      return id;
    };
    const post = async (ago: number, debit: string, credit: string, amount: string) =>
      admin(async (c) => {
        await c.query('BEGIN');
        const entry = randomUUID();
        await c.query(`INSERT INTO ludy_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, $2, ${day(-ago)}, 'test', 'finance.test', $3, $4)`, [orgId, entry, randomUUID(), entity]);
        await c.query(`INSERT INTO ludy_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, legal_entity_id) VALUES ($1, $2, 1, $3, $5, 0, $6), ($1, $2, 2, $4, 0, $5, $6)`, [orgId, entry, debit, credit, amount, entity]);
        await c.query('COMMIT');
      });
    const item = (label: string, category: string, direction: 'in' | 'out', amount: string, firstOffset: number, recurrence: 'once' | 'monthly' | 'quarterly') =>
      rows(`INSERT INTO ludy_finance.cash_forecast_item (org_id, legal_entity_id, label, category, direction, amount, first_date, recurrence) VALUES ($1, $2, $3, $4, $5, $6, ${day(firstOffset)}, $7)`, [orgId, entity, label, category, direction, amount, recurrence]);
    const forecast = async () => rt.query<Record<string, unknown>>('finance.mcp.cash_forecast', {}, { actor: mcp(owner, await grant()), orgId });
    const screenForecast = () => rt.query<CashForecast>('finance.cash_forecast', {}, { actor: user(owner), orgId });
    const close = async (month: string) => rt.query<Record<string, unknown>>('finance.mcp.month_close', { month }, { actor: mcp(owner, await grant()), orgId });
    const screenClose = (month: string) => rt.query<MonthClose>('finance.month_close', { month }, { actor: user(owner), orgId });
    return { orgId, owner, entity, post, item, forecast, screenForecast, close, screenClose };
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
    const url = new URL(adminUrl);
    url.username = 'ludy_app';
    url.password = 'test-app-pw';
    pool = createPool({ connectionString: url.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('reads the cash forecast: the screen\'s own opening cash, low point, checkpoints and left-out line, the entered items as a count that also moves the figures', async () => {
    const o = await org();
    await o.post(10, '111', '511', '50000000');
    const bare = await o.forecast();
    const bareScreen = await o.screenForecast();
    expect(bare.openingCash).toBe('50000000');
    expect(bare.enteredItems).toEqual({ count: 0 });
    // The projection takes fields away and changes no figure.
    expect(bare.openingCash).toBe(bareScreen.openingCash);
    expect(bare.low).toEqual(bareScreen.low);
    expect(bare.checkpoints).toEqual(bareScreen.checkpoints);
    expect(bare.notIncluded).toEqual(bareScreen.notIncluded);
    expect(bare.taxMarkers).toEqual(bareScreen.taxMarkers);
    expect(bare.truncated).toBe(bareScreen.truncated);
    expect(bare.notIncluded).toContain('rent');
    expect(bare).not.toHaveProperty('series');
    // One monthly rent: it is counted, it lowers the 90-day balance and it comes off the left-out line, and only its count is read.
    await o.item('Thuê văn phòng', 'rent', 'out', '10000000', 5, 'monthly');
    const withRent = await o.forecast();
    const withRentScreen = await o.screenForecast();
    expect(withRent.enteredItems).toEqual({ count: 1 });
    expect(withRent.notIncluded).not.toContain('rent');
    expect(withRent.checkpoints).toEqual(withRentScreen.checkpoints);
    expect(withRent.low).toEqual(withRentScreen.low);
    const last = (withRent.checkpoints as Array<{ balance: string }>)[2] as { balance: string };
    const lastBare = (bare.checkpoints as Array<{ balance: string }>)[2] as { balance: string };
    expect(Number(last.balance)).toBeLessThan(Number(lastBare.balance));
    expect(JSON.stringify(withRent)).not.toContain('Thuê văn phòng');
  });

  it('reads the month-close checklist: the screen\'s own items without the link hint, and only for the month asked', async () => {
    const o = await org();
    const screen = await o.screenClose('2026-03');
    const seen = await o.close('2026-03');
    expect(seen.month).toBe('2026-03');
    expect(seen.items).toEqual(screen.items.map((i) => ({ key: i.key, count: i.count, period: i.period })));
    // A month no period lock covers has the lock item open; another month is another answer.
    const march = (seen.items as Array<{ key: string; count: number }>).find((i) => i.key === 'lock');
    expect(march).toMatchObject({ count: 1 });
    expect((await o.close('2026-04')).month).toBe('2026-04');
  });

  it('refuses both reads for an org with more than one legal entity and answers nothing of the part it could see', async () => {
    const o = await org(true);
    await o.post(10, '111', '511', '50000000');
    await expect(o.forecast()).rejects.toMatchObject({ code: SIGNAL_PARTIAL_VIEW_CODE, status: 403 });
    await expect(o.close('2026-03')).rejects.toMatchObject({ code: SIGNAL_PARTIAL_VIEW_CODE, status: 403 });
  });
});
