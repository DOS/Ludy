// SPDX-License-Identifier: AGPL-3.0-only
// Invariant suite (Decision 7), so main's copy guards a later restatement of these functions. The public definers of Social and CRM carry the app check
// (ADR-0053, slice c C2): each function that finds the org of a public link, slug or feed asks crove_kernel.org_app_on for its app, so an off app answers like an
// address that never existed (the Finance one drops the bank feed notice). The behaviour of the shared lookups is in the social and CRM suites; this pins that none
// of the thirteen lost the check in a later migration. Set CROVE_TEST_ADMIN_URL to a superuser URL.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '@ludy/db/migrate';
import { createDbClient, resolveDbIdentifiers, type DbIdentifiers } from './fixtures/db-identifiers.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// The function and the app whose check its body carries.
const CHECKED: ReadonlyArray<readonly [string, string]> = [
  ['crove_social.review_link_by_token(text,boolean)', 'social'],
  ['crove_social.report_link_view(text)', 'social'],
  ['crove_social.short_link_hit(text,boolean)', 'social'],
  ['crove_social.bio_page_view(text)', 'social'],
  ['crove_social.bio_page_go(text,text,boolean)', 'social'],
  ['crove_social.bio_page_file(text,uuid)', 'social'],
  ['crove_social.calendar_feed_events(text)', 'social'],
  ['crove_crm.booking_feed_events(text)', 'crm'],
  ['crove_crm.booking_event_type(text,text)', 'crm'],
  ['crove_crm.booking_manage_find(text,text,text)', 'crm'],
  ['crove_crm.quote_link_view(text)', 'crm'],
  ['crove_crm.quote_link_logo(text)', 'crm'],
  ['crove_finance.bank_feed_notice_claim(integer)', 'finance'],
  ['crove_finance.misa_amis_callback_claim(integer)', 'finance'],
  ['crove_finance.bank_feed_hook_lookup(text,text)', 'finance'],
  ['crove_finance.bank_feed_hook_put_notice(uuid,text,text,text,text,text)', 'finance'],
  ['crove_finance.bank_feed_hook_claim(integer)', 'finance'],
  ['crove_finance.marketplace_hook_lookup(text,text)', 'finance'],
  ['crove_finance.marketplace_hook_put_notice(uuid,text,text,text,bytea,text)', 'finance'],
  ['crove_finance.marketplace_hook_claim(integer)', 'finance'],
  ['crove_kernel.meeting_platform_ring(text,text)', 'meetings'],
  ['crove_sign.public_token_resolve(text,boolean)', 'sign'],
  ['crove_sign.public_pdf_source(text)', 'sign'],
  ['crove_sign.public_verify_certificate(text,text)', 'sign'],
  ['crove_sign.public_record_view(text,text,text)', 'sign'],
  ['crove_sign.public_request_otp(text,text)', 'sign'],
  ['crove_sign.public_verify_otp(text,text,text,text)', 'sign'],
  ['crove_sign.public_submit(text,boolean,text,text,jsonb,text,text,text)', 'sign'],
  ['crove_sign.public_decline(text,text,text,text)', 'sign'],
  ['crove_sign.public_delegate(text,text,text,text,text,text,text)', 'sign'],
  ['crove_sign.public_direct_resolve(text,text)', 'sign'],
  ['crove_sign.public_direct_pdf_source(text,text)', 'sign'],
  ['crove_sign.public_direct_request_otp(text,text,text)', 'sign'],
  ['crove_sign.public_direct_verify_otp(text,text,text,text)', 'sign'],
  ['crove_sign.public_direct_start(text,text,text,text,text,text,text)', 'sign'],
  ['crove_sign.public_hub_list(text)', 'sign'],
  ['crove_sign.public_hub_resolve(text,uuid,text)', 'sign'],
  ['crove_sign.public_hub_pdf_source(text,uuid,text)', 'sign'],
  ['crove_sign.public_hub_request_otp(text,uuid,text,text)', 'sign'],
  ['crove_sign.public_hub_verify_otp(text,uuid,text,text,text)', 'sign'],
  ['crove_sign.public_hub_start(text,uuid,text,text,text,text,text,text)', 'sign'],
  ['crove_sign.public_attachment_preflight(text,uuid)', 'sign'],
  ['crove_sign.public_record_attachment(text,uuid,text,text,integer,text,text,text,text,text)', 'sign'],
];

suite('the public definers carry the app check (ADR-0053, C2)', () => {
  const dbName = `crove_test_public_definers_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let dbIds: DbIdentifiers | undefined;

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    dbIds = await resolveDbIdentifiers(adminUrl);
  });

  afterAll(async () => {
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('asks org_app_on for its own app in every function that finds the org of a public address', async () => {
    const client = createDbClient({ connectionString: adminUrl }, dbIds);
    await client.connect();
    try {
      for (const [fn, app] of CHECKED) {
        const { rows } = await client.query<{ def: string; secdef: boolean }>('SELECT pg_get_functiondef($1::regprocedure) AS def, prosecdef AS secdef FROM pg_proc WHERE oid = $1::regprocedure', [fn]);
        // The review link lookup is a plain helper of the definers; every other function of the list is itself one.
        if (fn !== 'crove_social.review_link_by_token(text,boolean)') expect(rows[0]?.secdef, fn).toBe(true);
        expect(rows[0]?.def, fn).toMatch(new RegExp(`crove_kernel\\.org_app_on\\([a-z0-9_]+\\.org_id, '${app}'\\)`));
      }
    } finally {
      await client.end();
    }
  });
});
