// SPDX-License-Identifier: AGPL-3.0-only
// A quote number is unique within the legal entity that issued it (#2832) on PostgreSQL 17: the same BG-YYYY-NNNN in two entities of one org is allowed, a duplicate within one
// entity is still refused (by the constraint, named quote_number_entity_uq), and a revision keeps the entity whose series gave its number even when the org's default entity
// has changed since. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { Deal, PipelineStage, Quote, QuoteSent } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { crmCommands, crmQueries } from '@crove/mod-crm';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const item = { kind: 'item' as const, description: 'Gói kế toán năm', unit: 'gói', quantity: '2', unitPrice: '1500000', vatRate: '10%' };

suite('crm quote numbers per legal entity on PostgreSQL (#2832)', () => {
  const dbName = `crove_test_crm_quote_number_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...crmCommands], queries: [...kernelQueries({ inboundDomain: null }), ...crmQueries] });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('allows the same number in two entities of one org, refuses a duplicate within one entity, and a revision keeps the entity of its number', async () => {
    const owner = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@quote-number.test`, name: null });
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty ${randomUUID().slice(0, 6)}`);
    const exec = <T>(command: string, input: unknown) => rt.execute<T>(command, input, { actor: asUser(owner), orgId });
    const partyId = await admin((c) =>
      c
        .query<{ id: string }>("INSERT INTO crove_kernel.party (org_id, name, kind, tax_code, address) VALUES ($1, 'Công ty ABC', 'organization', '0312345678', '12 Lê Lợi, Quận 1') RETURNING id", [orgId])
        .then((r) => r.rows[0]!.id),
    );
    // A second entity of the org (the first is the default one the org was made with).
    const entityB = await admin((c) =>
      c
        .query<{ id: string }>("INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh B', 'branch', $2) RETURNING id", [orgId, owner])
        .then((r) => r.rows[0]!.id),
    );
    await exec<PipelineStage[]>('crm.pipeline.setup', {});
    const deal = await exec<Deal>('crm.deal.create', { partyId, title: 'Gói kế toán năm', amount: '15000000', expectedClose: '2026-12-31' });
    const draft = await exec<Quote>('crm.quote.save', { dealId: deal.id, lines: [] });
    const ready = await exec<Quote>('crm.quote.save', { quoteId: draft.id, version: draft.version, lines: [item] });
    const sent = (await exec<QuoteSent>('crm.quote.send', { quoteId: ready.id, version: ready.version, via: 'link' })).quote;
    expect(sent.number).toMatch(/^BG-\d{4}-0001$/);
    const entityA = await admin((c) => c.query<{ issuer_entity_id: string }>('SELECT issuer_entity_id FROM crove_crm.quote WHERE org_id = $1 AND id = $2', [orgId, sent.id]).then((r) => r.rows[0]!.issuer_entity_id));
    expect(entityA).not.toBe(entityB);

    // Another entity's series gives the same number: allowed. The same number in the same entity (and revision) is refused, by the named constraint.
    const insertSent = (entity: string) =>
      admin((c) =>
        c.query(
          `INSERT INTO crove_crm.quote (org_id, deal_id, party_id, valid_until, created_by, status, number, sent_at, sent_via, issuer_entity_id, buyer_name)
           VALUES ($1, $2, $3, '2031-01-31', $4, 'sent', $5, now(), 'link', $6, 'Công ty ABC')`,
          [orgId, deal.id, partyId, owner, sent.number, entity],
        ),
      );
    await expect(insertSent(entityB)).resolves.toBeDefined();
    await expect(insertSent(entityA)).rejects.toMatchObject({ code: '23505', constraint: 'quote_number_entity_uq' });
    await expect(insertSent(entityB)).rejects.toMatchObject({ code: '23505', constraint: 'quote_number_entity_uq' });

    // A second quote, sent from the default entity A (number 0002); its entity is then moved to a third entity C, as if C's series had given its number while A was not the default.
    // Its revision keeps C (the entity whose series gave the number), so it cannot collide with a quote of A's own series.
    const entityC = await admin((c) =>
      c
        .query<{ id: string }>("INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh C', 'branch', $2) RETURNING id", [orgId, owner])
        .then((r) => r.rows[0]!.id),
    );
    const deal2 = await exec<Deal>('crm.deal.create', { partyId, title: 'Gói kế toán năm 2', amount: '15000000', expectedClose: '2026-12-31' });
    const draft2 = await exec<Quote>('crm.quote.save', { dealId: deal2.id, lines: [] });
    const ready2 = await exec<Quote>('crm.quote.save', { quoteId: draft2.id, version: draft2.version, lines: [item] });
    const sent2 = (await exec<QuoteSent>('crm.quote.send', { quoteId: ready2.id, version: ready2.version, via: 'link' })).quote;
    expect(sent2.number).toMatch(/^BG-\d{4}-0002$/);
    await admin((c) => c.query('UPDATE crove_crm.quote SET issuer_entity_id = $3 WHERE org_id = $1 AND id = $2', [orgId, sent2.id, entityC]));
    const revision = await exec<Quote>('crm.quote.revise', { quoteId: sent2.id });
    const revised = (await exec<QuoteSent>('crm.quote.send', { quoteId: revision.id, version: revision.version, via: 'link' })).quote;
    expect(revised.number).toBe(sent2.number);
    const revisedIssuer = await admin((c) => c.query<{ issuer_entity_id: string }>('SELECT issuer_entity_id FROM crove_crm.quote WHERE org_id = $1 AND id = $2', [orgId, revised.id]).then((r) => r.rows[0]!.issuer_entity_id));
    expect(revisedIssuer).toBe(entityC);
  });
});
