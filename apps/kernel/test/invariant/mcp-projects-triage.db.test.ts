// SPDX-License-Identifier: AGPL-3.0-only
// Protected invariant suite for `projects.mcp.triage_summary` (#4493, ADR-0051, ADR-0058):
//   - Member MCP grants (`mcp_member`) are refused; only company grants (`mcp_company`, scope `ludy.read`) may query.
//   - Private projects (`visibility = 'private'`) fail closed with 404 and never leak into unscoped counts or items.
//   - `meetings.meeting`-sourced triage items are excluded from BOTH counts and items unless the source meeting is
//     `visibility = 'org'`, has a `published` result, and has not passed its `text_retention_date` (Asia/Ho_Chi_Minh).
//   - `decline_reason` is never exposed on summary items, and cross-org rows are completely isolated.
// Self-contained invariant suite: imports only ./fixtures/* and package code under test.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime, type UserActor } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { projectsCommands, projectsQueries } from '@ludy/mod-projects';
import {
  createDbClient,
  createDbPool,
  resolveDbIdentifiers,
  setActiveRolePasswords,
  type DbIdentifiers,
} from './fixtures/db-identifiers.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SHIPPED = ['projects', 'meetings', 'notes', 'crm', 'finance', 'hr', 'sign', 'ads', 'social'] as const;

interface TriageSummaryOut {
  counts: {
    pending: number;
    snoozed: number;
    accepted: number;
    merged: number;
    declined: number;
    snoozeElapsed: number;
    tainted: number;
  };
  items: Array<{
    id: string;
    projectId: string;
    sourceType: string;
    sourceId: string | null;
    status: string;
    title: string;
    tainted: boolean;
    sourceTrust: string;
    declineReason?: unknown;
  }>;
}

suite('invariant (#4493): projects.mcp.triage_summary privacy, meeting retention, and grant bounds', () => {
  const dbName = `crove_test_mcp_triage_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let dbIds: DbIdentifiers | undefined;
  const pools: pg.Pool[] = [];
  let runtime!: Runtime;
  let noMeetingsRuntime!: Runtime;

  let orgA = '';
  let orgB = '';
  const users: Record<string, string> = {};
  let orgProjectA = '';
  let privateProjectA = '';
  let archivedProjectA = '';
  let orgProjectB = '';
  let companyGrantA = '';
  let memberGrantA = '';

  const ids: Record<string, string> = {};

  const asUser = (key: string): UserActor => ({ type: 'user', userId: users[key] as string, aal: 'aal1' });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = createDbClient({ connectionString: adminUrl }, dbIds);
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function seedMeeting(
    org: string,
    key: string,
    recorderKey: string,
    visibility: 'org' | 'attendees',
    publish: boolean,
  ): Promise<string> {
    const meetingId = (
      await runtime.execute<{ meetingId: string }>(
        'meetings.meeting.create',
        { title: `Meeting ${key}`, consentMethod: 'told_at_start', visibility },
        { actor: asUser(recorderKey), orgId: org, idempotencyKey: randomUUID() },
      )
    ).meetingId;
    await runtime.execute(
      'meetings.summary.save',
      { meetingId, summary: `Summary ${key}`, decisions: [`Decision ${key}`] },
      { actor: asUser(recorderKey), orgId: org, idempotencyKey: randomUUID() },
    );
    if (publish) {
      await runtime.execute(
        'meetings.result.publish',
        { meetingId, confirmed: true },
        { actor: asUser(recorderKey), orgId: org, idempotencyKey: randomUUID() },
      );
    }
    ids[`meeting_${key}`] = meetingId;
    return meetingId;
  }

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
    dbIds = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' }, dbIds);

    const url = new URL(adminUrl);
    url.username = dbIds ? dbIds.roleName('crove_app') : 'crove_app';
    url.password = 'test-app-pw';
    const pool = createDbPool({ connectionString: url.toString(), max: 4 }, dbIds);
    pools.push(pool);
    const db = createDb(pool);

    const deps = {
      inboundDomain: null,
      apps: { shipped: SHIPPED, deployment: SHIPPED, entitlements: async () => ['full'] },
    };
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...meetingsCommands, ...projectsCommands],
      queries: [...kernelQueries(deps), ...meetingsQueries, ...projectsQueries],
    });
    const noMeetingsDeps = {
      inboundDomain: null,
      apps: {
        shipped: SHIPPED,
        deployment: SHIPPED.filter((m) => m !== 'meetings'),
        entitlements: async () => ['full'],
      },
    };
    noMeetingsRuntime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...projectsCommands],
      queries: [...kernelQueries(noMeetingsDeps), ...projectsQueries],
    });

    for (const k of ['ownerA', 'adminA', 'memberA', 'ownerB']) {
      users[k] = await upsertIdentity(db, { issuer: 'mcp-triage-inv', subject: k, email: `${k}@mcp-triage.test`, name: k });
    }
    orgA = (await createOrg(runtime, asUser('ownerA'), 'Org Triage A')).orgId;
    orgB = (await createOrg(runtime, asUser('ownerB'), 'Org Triage B')).orgId;

    await admin(async (c) => {
      await c.query(
        `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role)
         VALUES ($1, $2, 'admin'), ($1, $3, 'member')`,
        [orgA, users.adminA, users.memberA],
      );
      companyGrantA = randomUUID();
      memberGrantA = randomUUID();
      await c.query(
        `INSERT INTO ludy_kernel.agent_grant
           (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, revoked_at, created_by, kind, member_id)
         VALUES
           ($1, $2, $3, $4, 'Company Read', 'mcp-triage.example', ARRAY['ludy.read'], $5, now(), now() + interval '7 days', NULL, $3, 'company', NULL),
           ($1, $6, $7, $8, 'Member Read', 'mcp-triage-m.example', ARRAY['ludy.read'], $9, now(), now() + interval '7 days', NULL, $7, 'member', $7)`,
        [
          orgA,
          companyGrantA,
          users.adminA,
          `mcp-triage-comp-${companyGrantA}`,
          `oauth-${companyGrantA}`,
          memberGrantA,
          users.memberA,
          `mcp-triage-mem-${memberGrantA}`,
          `oauth-${memberGrantA}`,
        ],
      );
    });

    orgProjectA = (
      await runtime.execute<{ projectId: string }>(
        'projects.project.create',
        { name: 'Public Project A', memberUserIds: [users.ownerA as string, users.adminA as string, users.memberA as string] },
        { actor: asUser('ownerA'), orgId: orgA, idempotencyKey: randomUUID() },
      )
    ).projectId;
    privateProjectA = (
      await runtime.execute<{ projectId: string }>(
        'projects.project.create',
        { name: 'Private Project A', visibility: 'private', memberUserIds: [users.ownerA as string] },
        { actor: asUser('ownerA'), orgId: orgA, idempotencyKey: randomUUID() },
      )
    ).projectId;
    archivedProjectA = (
      await runtime.execute<{ projectId: string }>(
        'projects.project.create',
        { name: 'Archived Project A', memberUserIds: [users.ownerA as string] },
        { actor: asUser('ownerA'), orgId: orgA, idempotencyKey: randomUUID() },
      )
    ).projectId;
    orgProjectB = (
      await runtime.execute<{ projectId: string }>(
        'projects.project.create',
        { name: 'Public Project B', memberUserIds: [users.ownerB as string] },
        { actor: asUser('ownerB'), orgId: orgB, idempotencyKey: randomUUID() },
      )
    ).projectId;

    // Seed non-meeting triage items in Org A public project: manual (untainted) + declined with sensitive decline_reason.
    const manualRes = await runtime.execute<{ item: { id: string } }>(
      'projects.triage.create',
      { projectId: orgProjectA, sourceType: 'manual', sourceId: null, title: 'Internal manual triage' },
      { actor: asUser('ownerA'), orgId: orgA, idempotencyKey: randomUUID() },
    );
    ids.manualPublic = manualRes.item.id;

    const declinedRes = await runtime.execute<{ item: { id: string } }>(
      'projects.triage.create',
      { projectId: orgProjectA, sourceType: 'manual', sourceId: null, title: 'Declined manual triage' },
      { actor: asUser('ownerA'), orgId: orgA, idempotencyKey: randomUUID() },
    );
    await runtime.execute(
      'projects.triage.decline',
      { itemId: declinedRes.item.id, declineReason: 'BI MAT DECLINE REASON 4493' },
      { actor: asUser('ownerA'), orgId: orgA, idempotencyKey: randomUUID() },
    );
    ids.declinedPublic = declinedRes.item.id;

    // Seed private-project and archived-project triage rows (both must stay hidden from counts and items).
    const privRes = await runtime.execute<{ item: { id: string } }>(
      'projects.triage.create',
      { projectId: privateProjectA, sourceType: 'manual', sourceId: null, title: 'BI MAT PRIVATE TRIAGE' },
      { actor: asUser('ownerA'), orgId: orgA, idempotencyKey: randomUUID() },
    );
    ids.privatePublic = privRes.item.id;

    const archRes = await runtime.execute<{ item: { id: string } }>(
      'projects.triage.create',
      { projectId: archivedProjectA, sourceType: 'manual', sourceId: null, title: 'Archived triage item' },
      { actor: asUser('ownerA'), orgId: orgA, idempotencyKey: randomUUID() },
    );
    ids.archivedItem = archRes.item.id;
    await runtime.execute(
      'projects.project.archive',
      { projectId: archivedProjectA },
      { actor: asUser('ownerA'), orgId: orgA, idempotencyKey: randomUUID() },
    );

    // Seed Meetings in Org A (published org, unpublished draft org, attendees-only recorded by admin grantor, expired yesterday, ends today).
    const vnToday = `(pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`;
    const mOrgPub = await seedMeeting(orgA, 'orgPub', 'memberA', 'org', true);
    const mOrgDraft = await seedMeeting(orgA, 'orgDraft', 'memberA', 'org', false);
    const mAttendees = await seedMeeting(orgA, 'attendees', 'adminA', 'attendees', true);
    const mEnded = await seedMeeting(orgA, 'ended', 'memberA', 'org', true);
    const mEndsToday = await seedMeeting(orgA, 'endsToday', 'memberA', 'org', true);

    for (const [key, meetingId, actorKey] of [
      ['triageOrgPub', mOrgPub, 'memberA'],
      ['triageOrgDraft', mOrgDraft, 'memberA'],
      ['triageAttendees', mAttendees, 'adminA'],
      ['triageEnded', mEnded, 'memberA'],
      ['triageEndsToday', mEndsToday, 'memberA'],
    ] as const) {
      const created = await runtime.execute<{ item: { id: string } }>(
        'projects.triage.create',
        { projectId: orgProjectA, sourceType: 'meetings.meeting', sourceId: meetingId, title: `Triage ${key}` },
        { actor: asUser(actorKey), orgId: orgA, idempotencyKey: randomUUID() },
      );
      ids[key] = created.item.id;
    }

    // Expire retention after the triage items already exist (real-world post-creation expiry).
    await admin(async (c) => {
      await c.query(`UPDATE ludy_meetings.meeting SET text_retention_date = ${vnToday} - 1 WHERE org_id = $1 AND id = $2`, [orgA, mEnded]);
      await c.query(`UPDATE ludy_meetings.meeting SET text_retention_date = ${vnToday} WHERE org_id = $1 AND id = $2`, [orgA, mEndsToday]);
    });

    // Seed Org B triage row to confirm cross-org isolation.
    const otherOrgItem = await runtime.execute<{ item: { id: string } }>(
      'projects.triage.create',
      { projectId: orgProjectB, sourceType: 'manual', sourceId: null, title: 'Org B triage item' },
      { actor: asUser('ownerB'), orgId: orgB, idempotencyKey: randomUUID() },
    );
    ids.orgBItem = otherOrgItem.item.id;
  }, 180_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  const mcpCompanyActor = () => ({
    type: 'user' as const,
    userId: users.adminA as string,
    aal: 'aal1' as const,
    mcp: {
      grantId: companyGrantA,
      clientId: `mcp-triage-comp-${companyGrantA}`,
      clientName: 'Company Read',
      scopes: ['ludy.read'],
      kind: 'company' as const,
    },
  });

  const mcpMemberActor = () => ({
    type: 'user' as const,
    userId: users.memberA as string,
    aal: 'aal1' as const,
    mcp: {
      grantId: memberGrantA,
      clientId: `mcp-triage-mem-${memberGrantA}`,
      clientName: 'Member Read',
      scopes: ['ludy.read'],
      kind: 'member' as const,
    },
  });

  it('refuses mcp_member grants on projects.mcp.triage_summary', async () => {
    await expect(
      runtime.query('projects.mcp.triage_summary', {}, { actor: mcpMemberActor(), orgId: orgA }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('rejects private projects with 404 and excludes private, archived, and cross-org rows from counts and items', async () => {
    await expect(
      runtime.query('projects.mcp.triage_summary', { projectId: privateProjectA }, { actor: mcpCompanyActor(), orgId: orgA }),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND', status: 404 });

    await expect(
      runtime.query('projects.mcp.triage_summary', { projectId: archivedProjectA }, { actor: mcpCompanyActor(), orgId: orgA }),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND', status: 404 });

    const summary = await runtime.query<TriageSummaryOut>('projects.mcp.triage_summary', {}, { actor: mcpCompanyActor(), orgId: orgA });
    const returnedIds = new Set(summary.items.map((i) => i.id));
    expect(returnedIds.has(ids.privatePublic as string)).toBe(false);
    expect(returnedIds.has(ids.archivedItem as string)).toBe(false);
    expect(returnedIds.has(ids.orgBItem as string)).toBe(false);
    expect(JSON.stringify(summary)).not.toContain('BI MAT PRIVATE TRIAGE');
  });

  it('excludes attendees-only, draft, and expired meeting rows from BOTH counts and items while omitting decline_reason', async () => {
    const summary = await runtime.query<TriageSummaryOut>('projects.mcp.triage_summary', {}, { actor: mcpCompanyActor(), orgId: orgA });
    const returnedIds = new Set(summary.items.map((i) => i.id));

    // Eligible: manualPublic (pending, untainted), declinedPublic (declined, untainted), triageOrgPub (pending, tainted).
    expect(returnedIds.has(ids.manualPublic as string)).toBe(true);
    expect(returnedIds.has(ids.declinedPublic as string)).toBe(true);
    expect(returnedIds.has(ids.triageOrgPub as string)).toBe(true);

    // Excluded meeting rows must be absent from items AND excluded from counts!
    for (const hiddenKey of ['triageOrgDraft', 'triageAttendees', 'triageEnded', 'triageEndsToday'] as const) {
      expect(returnedIds.has(ids[hiddenKey] as string), hiddenKey).toBe(false);
    }

    expect(summary.counts).toEqual({
      pending: 2,
      snoozed: 0,
      accepted: 0,
      merged: 0,
      declined: 1,
      snoozeElapsed: 0,
      tainted: 1,
    });
    expect(summary.items).toHaveLength(3);

    // Decline reason must never leak on summary items.
    for (const item of summary.items) {
      expect('declineReason' in item).toBe(false);
      expect('decline_reason' in item).toBe(false);
    }
    expect(JSON.stringify(summary)).not.toContain('BI MAT DECLINE REASON');
  });

  it('gates meetings.mcp.visible_ids to company ludy.read grants and fails closed when meetings is uninstalled', async () => {
    const requestedIds = [
      ids.meeting_orgPub as string,
      ids.meeting_orgDraft as string,
      ids.meeting_attendees as string,
      ids.meeting_ended as string,
      ids.meeting_endsToday as string,
    ];

    const visibleRes = await runtime.query<{ visibleIds: string[] }>(
      'meetings.mcp.visible_ids',
      { meetingIds: requestedIds },
      { actor: mcpCompanyActor(), orgId: orgA },
    );
    expect(visibleRes.visibleIds).toEqual([ids.meeting_orgPub]);

    // Refuses member MCP grants, browser users, and wrong-scope company grants.
    await expect(
      runtime.query('meetings.mcp.visible_ids', { meetingIds: requestedIds }, { actor: mcpMemberActor(), orgId: orgA }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      runtime.query('meetings.mcp.visible_ids', { meetingIds: requestedIds }, { actor: asUser('ownerA'), orgId: orgA }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(
      runtime.query(
        'meetings.mcp.visible_ids',
        { meetingIds: requestedIds },
        {
          actor: {
            ...mcpCompanyActor(),
            mcp: { ...mcpCompanyActor().mcp, scopes: ['ludy.engage.write'] },
          },
          orgId: orgA,
        },
      ),
    ).rejects.toMatchObject({ status: 403 });

    // When meetings is not installed in the runtime, projects.mcp.triage_summary fails closed on meeting rows in BOTH counts and items.
    const noMeetingsSummary = await noMeetingsRuntime.query<TriageSummaryOut>(
      'projects.mcp.triage_summary',
      {},
      { actor: mcpCompanyActor(), orgId: orgA },
    );
    const noMeetingsIds = new Set(noMeetingsSummary.items.map((i) => i.id));
    expect(noMeetingsIds.has(ids.manualPublic as string)).toBe(true);
    expect(noMeetingsIds.has(ids.declinedPublic as string)).toBe(true);
    expect(noMeetingsIds.has(ids.triageOrgPub as string)).toBe(false);
    expect(noMeetingsSummary.counts).toEqual({
      pending: 1,
      snoozed: 0,
      accepted: 0,
      merged: 0,
      declined: 1,
      snoozeElapsed: 0,
      tainted: 0,
    });
  });
});
