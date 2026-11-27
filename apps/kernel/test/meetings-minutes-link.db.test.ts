// SPDX-License-Identifier: AGPL-3.0-only
// The link to the published minutes for people outside the org (#4822) on a real database: the org's switch is off until an owner turns it on; only the recorder of a meeting with published minutes
// makes a link, at most 10 live ones; the token is shown once and only its hash is kept; the public read answers the published summary, decisions and action items and nothing else (no draft, no
// transcript), shows a republish at once, counts the open, and gives ONE answer (null) for a malformed, unknown, revoked, expired, switched-off or unpublished link; revoking works with the switch off;
// the audit rows hold ids and never the token; and only the API login may run the definer.
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { MinutesLinkCreated, OrgMinutesLinkList } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { minutesView } from '../src/minutes-link.ts';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the minutes link for people outside the org (#4822)', () => {
  const dbName = `ludy_test_minutes_link_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let db: ReturnType<typeof createDb>;
  let runtime: Runtime;
  const users: Record<string, string> = {};
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const exec = <O = unknown>(who: string, name: string, input: unknown) => runtime.execute<O>(name, input, { actor: asUser(who), orgId });
  const ask = <O = unknown>(who: string, name: string, input: unknown) => runtime.query<O>(name, input, { actor: asUser(who), orgId });
  const refuses = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error as { code?: string }).code ?? 'ERR');
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
  const setSwitch = (enabled: boolean) => exec('owner', 'meetings.minutes_link.switch.set', { enabled });

  async function meeting(title: string, recorder = 'rec'): Promise<string> {
    const id = randomUUID();
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, $4, 'vi', now() - interval '2 hours', now() - interval '1 hour', 3600, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 20, current_date + 365)`,
      [orgId, id, users[recorder], title],
    );
    return id;
  }
  const result = (meetingId: string, stage: 'draft' | 'published', summary: string, decisions: string[]) =>
    sqlAdmin(`INSERT INTO ludy_meetings.meeting_result (org_id, meeting_id, summary, decisions, feature, stage) VALUES ($1, $2, $3, $4::jsonb, 'manual', $5)`, [orgId, meetingId, summary, JSON.stringify(decisions), stage]);
  const item = (meetingId: string, title: string, stage: 'draft' | 'published') =>
    sqlAdmin(`INSERT INTO ludy_meetings.action_item (org_id, meeting_id, title, who_drafted, when_drafted, stage, transcript_seconds) VALUES ($1, $2, $3, 'Lan', 'thứ sáu', $4, 10)`, [orgId, meetingId, title, stage]);
  // A meeting with published minutes, a draft beside them, and a transcript line that must never come out.
  async function published(title = 'Họp với khách', recorder = 'rec'): Promise<string> {
    const id = await meeting(title, recorder);
    await result(id, 'published', 'Tóm tắt đã xuất bản', ['Chốt giá', 'Gửi hợp đồng']);
    await item(id, 'Gửi báo giá', 'published');
    await item(id, 'VIỆC NHÁP BÍ MẬT', 'draft');
    await sqlAdmin(`INSERT INTO ludy_meetings.transcript_segment (org_id, id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage) VALUES ($1, $2, $3, 0, 10, 'Người nói 1', 'LỜI NÓI BÍ MẬT', 'published')`, [orgId, randomUUID(), id]);
    return id;
  }
  // What the database keeps of a token: its SHA-256 in hex (the test's own copy of the rule, so a change of it shows here).
  const minutesTokenHash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
  const makeLink = (meetingId: string, who = 'rec') => exec<MinutesLinkCreated>(who, 'meetings.minutes_link.create', { meetingId });
  const view = (token: string) => minutesView(runtime, { token });

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
    const appPool = createPool({ connectionString: url.toString(), max: 4 });
    pools.push(appPool);
    db = createDb(appPool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries] });
    for (const key of ['owner', 'rec', 'other', 'gone']) users[key] = await upsertIdentity(db, { issuer: 'mlink', subject: key, email: `${key}@mlink.test`, name: key });
    orgId = (await createOrg(runtime, asUser('owner'), 'Công ty Chia Sẻ')).orgId;
    await sqlAdmin(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member')`, [orgId, users.rec, users.other, users.gone]);
  }, 300_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('is off until an owner turns it on: no link is made while it is off, and only an owner or admin changes it', async () => {
    const id = await published();
    expect(await ask('rec', 'meetings.minutes_link.switch.get', {})).toEqual({ enabled: false });
    expect(await refuses(makeLink(id))).toBe('MINUTES_LINK_OFF');
    expect(await refuses(exec('rec', 'meetings.minutes_link.switch.set', { enabled: true }))).not.toBeNull();
    expect(await setSwitch(true)).toEqual({ enabled: true });
    expect((await makeLink(id)).linkId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('lets only the recorder of a meeting with published minutes make a link, and at most 10 live ones', async () => {
    await setSwitch(true);
    const id = await published();
    // A member who cannot read the meeting does not even find it; one who reads it (an attendee) is refused.
    expect(await refuses(makeLink(id, 'other'))).toBe('MEETING_NOT_FOUND');
    await sqlAdmin('INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)', [orgId, randomUUID(), id, users.other]);
    expect(await refuses(makeLink(id, 'other'))).toBe('FORBIDDEN');
    const draftOnly = await meeting('Chưa xuất bản');
    await result(draftOnly, 'draft', 'Bản nháp', []);
    expect(await refuses(makeLink(draftOnly))).toBe('MINUTES_NOT_PUBLISHED');
    for (let i = 0; i < 10; i += 1) await makeLink(id);
    expect(await refuses(makeLink(id))).toBe('MINUTES_LINK_LIMIT');
  });

  it('shows the token once and keeps only its hash; the list and the audit rows never hold it', async () => {
    await setSwitch(true);
    const id = await published();
    const link = await makeLink(id);
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(link.path).toBe(`/-/minutes#${link.token}`);
    const rows = await sqlAdmin<{ token_sha256: string }>('SELECT token_sha256 FROM ludy_meetings.minutes_link WHERE org_id = $1 AND id = $2', [orgId, link.linkId]);
    expect(rows.rows[0]?.token_sha256).toBe(minutesTokenHash(link.token));
    const listed = await ask<{ items: Array<Record<string, unknown>> }>('rec', 'meetings.minutes_link.list', { meetingId: id });
    expect(JSON.stringify(listed)).not.toContain(link.token);
    const audit = await sqlAdmin<{ n: string }>(`SELECT count(*)::text AS n FROM ludy_kernel.audit_event WHERE org_id = $1 AND audit_event::text LIKE '%' || $2 || '%'`, [orgId, link.token]);
    expect(audit.rows[0]?.n).toBe('0');
    expect(await refuses(ask('other', 'meetings.minutes_link.list', { meetingId: id }))).toBe('MEETING_NOT_FOUND');
  });

  it('answers the published summary, decisions and action items, counts the open, and never a draft or the transcript', async () => {
    await setSwitch(true);
    const id = await published('Họp với Công ty A');
    const link = await makeLink(id);
    const page = await view(link.token);
    expect(page).toMatchObject({ title: 'Họp với Công ty A', summary: 'Tóm tắt đã xuất bản', decisions: ['Chốt giá', 'Gửi hợp đồng'], orgName: 'Công ty Chia Sẻ' });
    expect(page?.actionItems).toEqual([{ text: 'Gửi báo giá', owner: 'Lan', due: 'thứ sáu' }]);
    const text = JSON.stringify(page);
    expect(text).not.toContain('BÍ MẬT');
    await view(link.token);
    const row = await sqlAdmin<{ views: number; first_viewed_at: Date | null }>('SELECT views, first_viewed_at FROM ludy_meetings.minutes_link WHERE org_id = $1 AND id = $2', [orgId, link.linkId]);
    expect(row.rows[0]?.views).toBe(2);
    expect(row.rows[0]?.first_viewed_at).not.toBeNull();
    // A republish shows at once: the page reads the published rows when it is opened.
    await sqlAdmin(`UPDATE ludy_meetings.meeting_result SET summary = 'Tóm tắt mới' WHERE org_id = $1 AND meeting_id = $2 AND stage = 'published'`, [orgId, id]);
    expect((await view(link.token))?.summary).toBe('Tóm tắt mới');
  });

  it('gives the one answer (null) for a malformed, unknown, revoked, expired, switched-off or unpublished link', async () => {
    await setSwitch(true);
    const id = await published();
    const link = await makeLink(id);
    expect(await view(link.token)).not.toBeNull();
    for (const token of ['', 'short', 'x'.repeat(43) + '!', 'A'.repeat(43), 'A'.repeat(44)]) expect(await view(token), token).toBeNull();
    expect(await minutesView(runtime, { token: link.token, extra: 1 })).toBeNull();
    expect(await minutesView(runtime, null)).toBeNull();
    // Switch off.
    await setSwitch(false);
    expect(await view(link.token)).toBeNull();
    await setSwitch(true);
    expect(await view(link.token)).not.toBeNull();
    // Unpublished: the published row is gone.
    const gone = await published();
    const goneLink = await makeLink(gone);
    await sqlAdmin(`DELETE FROM ludy_meetings.meeting_result WHERE org_id = $1 AND meeting_id = $2 AND stage = 'published'`, [orgId, gone]);
    expect(await view(goneLink.token)).toBeNull();
    // Expired.
    const old = await makeLink(id);
    await sqlAdmin(`UPDATE ludy_meetings.minutes_link SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE org_id = $1 AND id = $2`, [orgId, old.linkId]);
    expect(await view(old.token)).toBeNull();
    // Revoked.
    await exec('rec', 'meetings.minutes_link.revoke', { meetingId: id, linkId: link.linkId });
    expect(await view(link.token)).toBeNull();
  });

  it('revokes with the switch off, by the recorder or an owner, not by another member, and a link cannot live longer than 30 days', async () => {
    await setSwitch(true);
    const id = await published();
    const a = await makeLink(id);
    const b = await makeLink(id);
    expect(await refuses(exec('other', 'meetings.minutes_link.revoke', { meetingId: id, linkId: a.linkId }))).toBe('FORBIDDEN');
    await setSwitch(false);
    expect(await exec('rec', 'meetings.minutes_link.revoke', { meetingId: id, linkId: a.linkId })).toEqual({ linkId: a.linkId, revoked: true });
    expect(await exec('owner', 'meetings.minutes_link.revoke', { meetingId: id, linkId: b.linkId })).toEqual({ linkId: b.linkId, revoked: true });
    expect(await refuses(sqlAdmin(`INSERT INTO ludy_meetings.minutes_link (org_id, meeting_id, token_sha256, expires_at, created_by, created_at) VALUES ($1, $2, $3, now() + interval '31 days', $4, now())`, [orgId, id, 'a'.repeat(64), users.rec]))).not.toBeNull();
  });

  it('stops serving a meeting past its text retention date and a link whose maker left the org, and lets an owner list the links to end one', async () => {
    await setSwitch(true);
    const id = await published();
    const link = await makeLink(id);
    expect(await view(link.token)).not.toBeNull();
    // An owner who did not record the meeting lists its links (to end one) and a plain member who did not record it cannot.
    const listed = await ask<{ items: Array<{ id: string }> }>('owner', 'meetings.minutes_link.list', { meetingId: id });
    expect(listed.items.map((i) => i.id)).toContain(link.linkId);
    expect(await refuses(ask('other', 'meetings.minutes_link.list', { meetingId: id }))).toBe('MEETING_NOT_FOUND');
    // A meeting with no text retention date is kept until it is deleted, so its link still opens.
    await sqlAdmin(`UPDATE ludy_meetings.meeting SET text_retention_date = NULL WHERE org_id = $1 AND id = $2`, [orgId, id]);
    expect(await view(link.token)).not.toBeNull();
    // Retention: the meeting's text period has ended, so the page is gone before the nightly shred runs.
    await sqlAdmin(`UPDATE ludy_meetings.meeting SET text_retention_date = current_date - 2 WHERE org_id = $1 AND id = $2`, [orgId, id]);
    expect(await view(link.token)).toBeNull();
    // The maker left the org: their link goes with them.
    const mine = await published('Họp của người đã rời', 'gone');
    const goneLink = await makeLink(mine, 'gone');
    expect(await view(goneLink.token)).not.toBeNull();
    await sqlAdmin('DELETE FROM ludy_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [orgId, users.gone]);
    expect(await view(goneLink.token)).toBeNull();
  });

  it('lets the API login run the definer and no other role', async () => {
    const rows = await sqlAdmin<{ app: boolean; tenant: boolean; worker: boolean; pub: boolean }>(
      `SELECT has_function_privilege('ludy_app', 'ludy_meetings.minutes_link_view(text)', 'EXECUTE') AS app,
              has_function_privilege('ludy_tenant', 'ludy_meetings.minutes_link_view(text)', 'EXECUTE') AS tenant,
              has_function_privilege('ludy_worker', 'ludy_meetings.minutes_link_view(text)', 'EXECUTE') AS worker,
              has_function_privilege('public', 'ludy_meetings.minutes_link_view(text)', 'EXECUTE') AS pub`,
    );
    expect(rows.rows[0]).toEqual({ app: true, tenant: false, worker: false, pub: false });
  });

  it('lists live org minutes links for owner and admin without leaking unreadable attendees-only titles, supports revoke, and refuses member and viewer (#4952)', async () => {
    const orgUsers: Record<string, string> = {};
    for (const [key, displayName] of [
      ['owner2', 'Chủ Doanh Nghiệp'],
      ['admin2', 'Quản Trị Viên'],
      ['rec2', 'Cô Lan'],
      ['member2', 'Thành Viên'],
      ['viewer2', 'Người Xem'],
    ] as const) {
      orgUsers[key] = await upsertIdentity(db, { issuer: 'mlink-4952', subject: key, email: `${key}@mlink.test`, name: displayName });
    }
    const asOrgUser = (who: string) => ({ type: 'user' as const, userId: orgUsers[who] as string, aal: 'aal1' as const });
    const exec2 = <O = unknown>(who: string, name: string, input: unknown) => runtime.execute<O>(name, input, { actor: asOrgUser(who), orgId: org2 });
    const ask2 = <O = unknown>(who: string, name: string, input: unknown) => runtime.query<O>(name, input, { actor: asOrgUser(who), orgId: org2 });
    const org2 = (await createOrg(runtime, asOrgUser('owner2'), 'Công ty Quản Trị Liên Kết')).orgId;
    await sqlAdmin(
      `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role)
       VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'viewer')`,
      [org2, orgUsers.admin2, orgUsers.rec2, orgUsers.member2, orgUsers.viewer2],
    );
    await exec2('owner2', 'meetings.minutes_link.switch.set', { enabled: true });

    // Empty initially.
    expect(await ask2<OrgMinutesLinkList>('owner2', 'meetings.minutes_link.org_list', {})).toEqual({ items: [] });

    const seedPublished = async (title: string, visibility: 'attendees' | 'org', secretSummary: string): Promise<string> => {
      const mId = randomUUID();
      await sqlAdmin(
        `INSERT INTO ludy_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
         VALUES ($1, $2, $4, 'vi', now() - interval '2 hours', now() - interval '1 hour', 3600, $3, $5, 'ready', 'told_at_start', $3, now(), '1.0', current_date + 20, current_date + 365)`,
        [org2, mId, orgUsers.rec2, title, visibility],
      );
      await sqlAdmin(
        `INSERT INTO ludy_meetings.meeting_result (org_id, meeting_id, summary, decisions, feature, stage)
         VALUES ($1, $2, $3, '["Quyết định nội bộ"]'::jsonb, 'manual', 'published')`,
        [org2, mId, secretSummary],
      );
      return mId;
    };

    // 1) Attendees-only meeting unreadable to both owner2 and admin2.
    const privateMeetingId = await seedPublished('Họp lương bí mật', 'attendees', 'Lương tháng 12 tăng');
    const privateLink = await exec2<MinutesLinkCreated>('rec2', 'meetings.minutes_link.create', { meetingId: privateMeetingId });
    await view(privateLink.token);

    // 2) Attendees-only meeting shared ONLY with admin2 (owner2 still cannot read it).
    const adminSharedMeetingId = await seedPublished('Họp chia sẻ cho quản trị', 'attendees', 'Nội dung riêng cho admin');
    await sqlAdmin('INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)', [org2, randomUUID(), adminSharedMeetingId, orgUsers.admin2]);
    const adminSharedLink = await exec2<MinutesLinkCreated>('rec2', 'meetings.minutes_link.create', { meetingId: adminSharedMeetingId });

    // 3) Org-wide meeting readable by both owner2 and admin2.
    const orgMeetingId = await seedPublished('Họp giao ban toàn công ty', 'org', 'Kế hoạch quý tới');
    const orgWideLink = await exec2<MinutesLinkCreated>('rec2', 'meetings.minutes_link.create', { meetingId: orgMeetingId });

    // 4) Expired link that must be excluded.
    const expiredLink = await exec2<MinutesLinkCreated>('rec2', 'meetings.minutes_link.create', { meetingId: orgMeetingId });
    await sqlAdmin(`UPDATE ludy_meetings.minutes_link SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE org_id = $1 AND id = $2`, [org2, expiredLink.linkId]);

    // Member and viewer are refused (403 FORBIDDEN).
    expect(await refuses(ask2('member2', 'meetings.minutes_link.org_list', {}))).toBe('FORBIDDEN');
    expect(await refuses(ask2('viewer2', 'meetings.minutes_link.org_list', {}))).toBe('FORBIDDEN');

    // Owner sees all 3 live links: org-wide has title + canOpenMeeting=true; the two unreadable attendees-only ones have null title + canOpenMeeting=false and ZERO secret content/email/token leakage.
    const ownerList = await ask2<OrgMinutesLinkList>('owner2', 'meetings.minutes_link.org_list', {});
    expect(ownerList.items).toHaveLength(3);
    expect(new Set(ownerList.items.map((i) => i.id))).toEqual(new Set([orgWideLink.linkId, adminSharedLink.linkId, privateLink.linkId]));
    expect(new Date(ownerList.items[0]!.createdAt).getTime()).toBeGreaterThanOrEqual(new Date(ownerList.items[1]!.createdAt).getTime());
    expect(new Date(ownerList.items[1]!.createdAt).getTime()).toBeGreaterThanOrEqual(new Date(ownerList.items[2]!.createdAt).getTime());
    const ownerPrivate = ownerList.items.find((i) => i.id === privateLink.linkId);
    expect(ownerPrivate).toMatchObject({
      id: privateLink.linkId,
      meetingId: privateMeetingId,
      meetingTitle: null,
      canOpenMeeting: false,
      createdByName: 'Cô Lan',
      views: 1,
    });
    expect(ownerPrivate?.firstViewedAt).not.toBeNull();
    expect(ownerList.items.find((i) => i.id === adminSharedLink.linkId)).toMatchObject({
      meetingId: adminSharedMeetingId,
      meetingTitle: null,
      canOpenMeeting: false,
    });
    expect(ownerList.items.find((i) => i.id === orgWideLink.linkId)).toMatchObject({
      meetingId: orgMeetingId,
      meetingTitle: 'Họp giao ban toàn công ty',
      canOpenMeeting: true,
      createdByName: 'Cô Lan',
      views: 0,
      firstViewedAt: null,
    });
    const ownerSerialized = JSON.stringify(ownerList);
    expect(ownerSerialized).not.toContain('Họp lương bí mật');
    expect(ownerSerialized).not.toContain('Họp chia sẻ cho quản trị');
    expect(ownerSerialized).not.toContain('Lương tháng 12 tăng');
    expect(ownerSerialized).not.toContain('rec2@mlink.test');
    expect(ownerSerialized).not.toContain(privateLink.token);
    expect(ownerSerialized).not.toContain(orgWideLink.token);

    // Admin sees both org-wide and admin-shared titles, while privateMeetingId remains null.
    const adminList = await ask2<OrgMinutesLinkList>('admin2', 'meetings.minutes_link.org_list', {});
    expect(adminList.items.find((i) => i.id === privateLink.linkId)).toMatchObject({
      meetingTitle: null,
      canOpenMeeting: false,
    });
    expect(adminList.items.find((i) => i.id === adminSharedLink.linkId)).toMatchObject({
      meetingTitle: 'Họp chia sẻ cho quản trị',
      canOpenMeeting: true,
    });
    expect(adminList.items.find((i) => i.id === orgWideLink.linkId)).toMatchObject({
      meetingTitle: 'Họp giao ban toàn công ty',
      canOpenMeeting: true,
    });
    expect(JSON.stringify(adminList)).not.toContain('Họp lương bí mật');

    // Switch off still lets owner/admin list and revoke active links.
    await exec2('owner2', 'meetings.minutes_link.switch.set', { enabled: false });
    const afterSwitchOff = await ask2<OrgMinutesLinkList>('admin2', 'meetings.minutes_link.org_list', {});
    expect(afterSwitchOff.items).toHaveLength(3);

    // Admin revokes the unreadable attendees-only link; subsequent org_list excludes it and public view returns null.
    expect(await exec2('admin2', 'meetings.minutes_link.revoke', { meetingId: privateMeetingId, linkId: privateLink.linkId })).toEqual({
      linkId: privateLink.linkId,
      revoked: true,
    });
    const afterRevoke = await ask2<OrgMinutesLinkList>('owner2', 'meetings.minutes_link.org_list', {});
    expect(afterRevoke.items).toHaveLength(2);
    expect(new Set(afterRevoke.items.map((i) => i.id))).toEqual(new Set([orgWideLink.linkId, adminSharedLink.linkId]));
    expect(await view(privateLink.token)).toBeNull();

    // Cross-org isolation: orgId links never appear in org2.
    expect(afterRevoke.items.every((i) => i.meetingId === orgMeetingId || i.meetingId === adminSharedMeetingId)).toBe(true);

    // Past text retention date hides title and marks canOpenMeeting=false.
    await sqlAdmin(`UPDATE ludy_meetings.meeting SET text_retention_date = current_date - 2 WHERE org_id = $1 AND id = $2`, [org2, orgMeetingId]);
    const afterRetention = await ask2<OrgMinutesLinkList>('owner2', 'meetings.minutes_link.org_list', {});
    expect(afterRetention.items.find((i) => i.id === orgWideLink.linkId)).toMatchObject({
      meetingTitle: null,
      canOpenMeeting: false,
    });

    // Creator leaves the org: createdByName becomes null without exposing email.
    await sqlAdmin('DELETE FROM ludy_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [org2, orgUsers.rec2]);
    const afterCreatorLeft = await ask2<OrgMinutesLinkList>('owner2', 'meetings.minutes_link.org_list', {});
    expect(afterCreatorLeft.items.find((i) => i.id === orgWideLink.linkId)?.createdByName).toBeNull();
    expect(JSON.stringify(afterCreatorLeft)).not.toContain('rec2@mlink.test');

    // Sensitive read audit rows exist for owner2/admin2 calls and carry zero titles, IDs, or names.
    const auditRows = await sqlAdmin<{ row: string }>(
      `SELECT audit_event::text AS row FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'meetings.minutes_link.org_list'`,
      [org2],
    );
    expect(auditRows.rows.length).toBeGreaterThanOrEqual(4);
    const auditText = auditRows.rows.map((r) => r.row).join('\n');
    expect(auditText).not.toContain('Họp lương bí mật');
    expect(auditText).not.toContain('Họp giao ban toàn công ty');
    expect(auditText).not.toContain('Cô Lan');
    expect(auditText).not.toContain(privateMeetingId);
  });
});
