// SPDX-License-Identifier: AGPL-3.0-only
// The two scan caps of the Meetings MCP reads, on a real database (#4087, from the "Risk left" of #4024 and #4039): `ludy_meetings_decisions` reads at most 100 meetings of its window (DECISIONS_MEETINGS_MAX) and says
// `truncated` when there were more; `ludy_meetings_search` searches the 200 newest meetings (MCP_SEARCH_MEETINGS_MAX) and says `truncated` when older ones were not searched. Exactly at the cap nothing is cut; one meeting
// past it is. The caps are not changed here, so the privacy pins in test/invariant/meetings-mcp-projection.db.test.ts are untouched; this file only fills the meetings with SQL (the rows are what a published meeting of
// the org holds: an org-visible meeting and its published result).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { MCP_SEARCH_MEETINGS_MAX } from '@ludy/kernel-contract';
import { Runtime, type UserActor } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
// How many meetings `ludy_meetings_decisions` reads at most (DECISIONS_MEETINGS_MAX in modules/meetings/src/mcp.ts, a module-private constant): changing it fails this file, which is the point of it.
const DECISIONS_MEETINGS_MAX = 100;

interface Decisions {
  items: Array<{ meetingId: string; meetingTitle: string; decision: string }>;
  truncated: boolean;
}
interface Search {
  items: Array<{ meetingId: string; meetingTitle: string; field: string; snippet: string }>;
  truncated: boolean;
}

suite('the scan caps of the Meetings MCP reads (#4087)', () => {
  const dbName = `crove_test_mcp_caps_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let runtime: Runtime;
  let ownerId = '';
  let decisionsOrg = '';
  let searchOrg = '';
  const asOwner = (): UserActor => ({ type: 'user', userId: ownerId, aal: 'aal1' });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const sqlAdmin = <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) => admin((c) => c.query<R>(text, params));

  // Meetings numbered `from` to `to` of an org: org-visible, started `n` minutes ago (so a higher number is older), each with a published result holding one decision. A title says its number, and the one at `needleAt`
  // carries `needle` in it.
  async function seedMeetings(org: string, from: number, to: number, needle: string | null, needleAt: number | null): Promise<void> {
    await sqlAdmin(
      `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       SELECT $1::uuid, gen_random_uuid(), CASE WHEN n = $4 THEN 'Họp ' || $3::text || ' ' || n ELSE 'Họp ' || n END, 'vi', now() - (n || ' minutes')::interval, now() - (n || ' minutes')::interval + interval '30 minutes', 1800, $2::uuid, 'org', 'ready', 'told_at_start', $2::uuid, now(), '1.0', current_date + 30, current_date + 365
         FROM generate_series($5::int, $6::int) n`,
      [org, ownerId, needle ?? '', needleAt ?? -1, from, to],
    );
    await sqlAdmin(
      `INSERT INTO crove_meetings.meeting_result (org_id, meeting_id, summary, decisions, feature, stage)
       SELECT m.org_id, m.id, 'Tóm tắt', jsonb_build_array('Quyết định của ' || m.title), 'manual', 'published'
         FROM crove_meetings.meeting m
        WHERE m.org_id = $1 AND NOT EXISTS (SELECT 1 FROM crove_meetings.meeting_result r WHERE r.org_id = m.org_id AND r.meeting_id = m.id)`,
      [org],
    );
  }

  async function companyGrant(org: string) {
    const grantId = randomUUID();
    await sqlAdmin(
      `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by, kind, member_id)
       VALUES ($1, $2, $3, $5, 'Test client', 'client.example.com', ARRAY['ludy.read'], $4, clock_timestamp(), now() + interval '30 days', $3, 'company', NULL)`,
      [org, grantId, ownerId, `oauth-${grantId}`, `client-${grantId}`],
    );
    const actor: UserActor = { type: 'user', userId: ownerId, aal: 'aal1', mcp: { grantId, clientId: 'client-1', clientName: 'Test client', scopes: ['ludy.read'], kind: 'company' } };
    return { actor, orgId: org };
  }
  const decisions = async (org: string) => runtime.query<Decisions>('meetings.mcp.decisions', { days: 30, limit: 100 }, await companyGrant(org));
  const search = async (org: string, q: string) => runtime.query<Search>('meetings.mcp.search', { q, limit: 10 }, await companyGrant(org));

  beforeAll(async () => {
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    const pool = createPool({ connectionString: url.toString(), max: 4 });
    pools.push(pool);
    const db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries] });
    ownerId = await upsertIdentity(db, { issuer: 'mcp-caps', subject: 'owner', email: 'owner@mcp-caps.test', name: 'owner' });
    decisionsOrg = (await createOrg(runtime, asOwner(), 'Org quyết định')).orgId;
    searchOrg = (await createOrg(runtime, asOwner(), 'Org tìm kiếm')).orgId;
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('decisions: exactly the cap of meetings is read whole, and one more makes the answer say it was cut', async () => {
    await seedMeetings(decisionsOrg, 1, DECISIONS_MEETINGS_MAX, null, null);
    const whole = await decisions(decisionsOrg);
    expect(whole.items).toHaveLength(DECISIONS_MEETINGS_MAX);
    expect(whole.truncated).toBe(false);
    await seedMeetings(decisionsOrg, DECISIONS_MEETINGS_MAX + 1, DECISIONS_MEETINGS_MAX + 1, null, null);
    const cut = await decisions(decisionsOrg);
    // The newest meetings are the ones read: the oldest (number 101) is the one left out.
    expect(cut.items).toHaveLength(DECISIONS_MEETINGS_MAX);
    expect(cut.truncated).toBe(true);
    expect(cut.items.some((i) => i.meetingTitle === `Họp ${DECISIONS_MEETINGS_MAX + 1}`)).toBe(false);
    expect(cut.items[0]?.meetingTitle).toBe('Họp 1');
  });

  it('search: the oldest of the newest 200 meetings is found, and a 201st is not searched, with the answer saying older ones were left out', async () => {
    const cap = MCP_SEARCH_MEETINGS_MAX;
    expect(cap).toBe(200);
    await seedMeetings(searchOrg, 1, cap, 'sầu riêng', cap);
    const whole = await search(searchOrg, 'sầu riêng');
    expect(whole.items.map((i) => i.meetingTitle)).toEqual([`Họp sầu riêng ${cap}`]);
    expect(whole.truncated).toBe(false);
    // One older meeting past the cap holds another phrase: it is not searched, and the answer says older meetings were left out.
    await seedMeetings(searchOrg, cap + 1, cap + 1, 'xoài cát', cap + 1);
    const missing = await search(searchOrg, 'xoài cát');
    expect(missing.items).toEqual([]);
    expect(missing.truncated).toBe(true);
    // A meeting inside the cap is still found, and the answer still says it was cut.
    const still = await search(searchOrg, 'sầu riêng');
    expect(still.items.map((i) => i.meetingTitle)).toEqual([`Họp sầu riêng ${cap}`]);
    expect(still.truncated).toBe(true);
  });
});
