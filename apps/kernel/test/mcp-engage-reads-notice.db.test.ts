// SPDX-License-Identifier: AGPL-3.0-only
// The one-time notice of the Engage reads (issue #4069, follow-up of #4068): a person who connected an AI app before the consent screen named the Hộp thư, bookings and ads reads is told once, in the
// app. Who is told (a live grant made before the cutoff that holds `ludy.read`, its person a member now), what is not (a grant made after, a revoked one, a person who left), that it is once whatever the passes,
// that it names no client, that a muted kind does not hide it, that it is a notice only (the grant, its scopes and its standing are as they were), and that only the system runs it.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepMcpEngageReadsNotices, upsertIdentity, type NotificationItem } from '@ludy/kernel';
import { ADMIN, startHarness, type Harness } from './engage-proposals-harness.ts';

const suite = ADMIN ? describe : describe.skip;
const KIND = 'kernel.mcp_engage_reads';

suite('the notice of the Engage reads (#4069)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness('engage_reads_notice');
  }, 300_000);
  afterAll(async () => {
    await h?.stop();
  });

  const pass = () => sweepMcpEngageReadsNotices({ runtime: h.worker, workerDb: h.workerDb });
  const person = async (role: 'owner' | 'admin' | 'member') => {
    const id = await upsertIdentity(h.db, { issuer: 'engage-reads', subject: `${role}-${randomUUID()}`, email: `${role}-${randomUUID().slice(0, 8)}@engage-reads.test`, name: role });
    await h.q('INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [h.orgId, id, role]);
    return id;
  };
  // A grant of `userId`, kind company or member. `due` is what the column holds. These cases set it by hand: the test database was empty when the migration ran, so its default is false (a new install is told nothing);
  // on an instance that had grants, the default is true for the hour after the migration and false later. `'default'` leaves the column to the database.
  const grant = async (userId: string, due: boolean | 'default', kind: 'company' | 'member' = 'company', scopes: string[] = ['ludy.read']) => {
    const id = randomUUID();
    await h.q(
      `INSERT INTO ludy_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by, kind, member_id)
       VALUES ($1, $2, $3, $4, $7, 'old-app.example.org', $5::text[], $6, now(), now() + interval '89 days', $3, $8, $9)`,
      [h.orgId, id, userId, `client-${id}`, scopes, `oauth-${id}`, `Old app ${id.slice(0, 4)}`, kind, kind === 'member' ? userId : null],
    );
    if (due !== 'default') await h.q('UPDATE ludy_kernel.agent_grant SET engage_reads_due = $3 WHERE org_id = $1 AND id = $2', [h.orgId, id, due]);
    return id;
  };
  // A grant that needs the notice (made before the instance served the consent screen that names the reads).
  const OLD = true;
  const notices = async (userId: string) => (await h.q<{ detail: Record<string, string>; subject_type: string | null; dedupe_key: string }>(`SELECT detail, subject_type, dedupe_key FROM ludy_kernel.notification WHERE org_id = $1 AND user_id = $2 AND kind = $3`, [h.orgId, userId, KIND])).rows;
  const stamp = async (grantId: string) => (await h.q<{ at: Date | null }>('SELECT engage_reads_told_at AS at FROM ludy_kernel.agent_grant WHERE org_id = $1 AND id = $2', [h.orgId, grantId])).rows[0]?.at ?? null;

  it('tells the person of a due grant (made before the consent screen named the reads), once, and leaves the grant exactly as it was', async () => {
    const owner = await person('owner');
    const g = await grant(owner, OLD);
    const beforeRow = (await h.q('SELECT scopes, max_risk, kind, revoked_at, expires_at FROM ludy_kernel.agent_grant WHERE org_id = $1 AND id = $2', [h.orgId, g])).rows[0];
    expect(await notices(owner)).toEqual([]);
    expect(await stamp(g)).toBeNull();
    expect(await pass()).toBeGreaterThanOrEqual(1);
    const got = await notices(owner);
    expect(got).toHaveLength(1);
    expect(got[0]?.detail).toEqual({ grants: 'company' });
    expect(got[0]?.dedupe_key).toBe('mcp_engage_reads');
    expect(await stamp(g)).not.toBeNull();
    // A notice only: no scope, risk, kind, expiry or revoke changed.
    expect((await h.q('SELECT scopes, max_risk, kind, revoked_at, expires_at FROM ludy_kernel.agent_grant WHERE org_id = $1 AND id = $2', [h.orgId, g])).rows[0]).toEqual(beforeRow);
    // Another pass and a replay of the command write nothing.
    await pass();
    expect(await h.system('kernel.mcp.engage_reads_notify', 'kernel.mcp.engage_reads_notify', { userId: owner })).toEqual({ sent: 0 });
    expect(await notices(owner)).toHaveLength(1);
  });

  it('shows in the bell with no client name in it, and a person who muted the kind is told anyway', async () => {
    const admin = await person('admin');
    await h.q('INSERT INTO ludy_kernel.notification_mute (org_id, user_id, kind) VALUES ($1, $2, $3)', [h.orgId, admin, KIND]);
    const g = await grant(admin, OLD);
    await pass();
    expect(await stamp(g)).not.toBeNull();
    const seen = await h.runtime.query<{ items: NotificationItem[]; unread: number }>('kernel.notification.list', {}, { actor: h.person(admin), orgId: h.orgId });
    const item = seen.items.find((i) => i.kind === KIND);
    expect(item?.read).toBe(false);
    expect(item?.detail).toEqual({ grants: 'company' });
    expect(JSON.stringify(item)).not.toContain('Old app');
    expect(JSON.stringify(item)).not.toContain('old-app.example.org');
  });

  it('one notice for a person with several grants; a member grant alone says so; both says both', async () => {
    const both = await person('admin');
    const a = await grant(both, OLD);
    const m = await grant(both, OLD, 'member', ['ludy.read']);
    const alone = await person('member');
    const b = await grant(alone, OLD, 'member', ['ludy.read']);
    await pass();
    expect((await notices(both)).map((n) => n.detail)).toEqual([{ grants: 'both' }]);
    expect((await notices(alone)).map((n) => n.detail)).toEqual([{ grants: 'member' }]);
    for (const id of [a, m, b]) expect(await stamp(id)).not.toBeNull();
  });

  it('does not tell a revoked grant, a person who left (their grant ends with them), or a grant without `ludy.read`', async () => {
    const revoked = await person('owner');
    const r = await grant(revoked, OLD);
    await h.q('UPDATE ludy_kernel.agent_grant SET revoked_at = now() WHERE org_id = $1 AND id = $2', [h.orgId, r]);
    const left = await person('admin');
    const l = await grant(left, OLD);
    await h.q('DELETE FROM ludy_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [h.orgId, left]);
    // Removing a member ends their grants, so there is nothing for the notice to say to them.
    expect((await h.q<{ revoked_at: Date | null }>('SELECT revoked_at FROM ludy_kernel.agent_grant WHERE org_id = $1 AND id = $2', [h.orgId, l])).rows[0]?.revoked_at).not.toBeNull();
    // A member grant that holds only the private-items read does not read the Engage data.
    const privateOnly = await person('member');
    const p = await grant(privateOnly, OLD, 'member', ['ludy.member.read']);
    await pass();
    for (const [who, id] of [[revoked, r], [left, l], [privateOnly, p]] as const) {
      expect(await notices(who)).toEqual([]);
      expect(await stamp(id)).toBeNull();
    }
  });

  it('a new install tells nothing: the table was empty when the migration ran, so a grant made now is not due, and neither is one made later', async () => {
    const owner = await person('owner');
    const fresh = await grant(owner, 'default');
    expect((await h.q<{ due: boolean }>('SELECT engage_reads_due AS due FROM ludy_kernel.agent_grant WHERE org_id = $1 AND id = $2', [h.orgId, fresh])).rows[0]?.due).toBe(false);
    const explicit = await grant(owner, false);
    await pass();
    expect(await notices(owner)).toEqual([]);
    expect(await stamp(fresh)).toBeNull();
    expect(await stamp(explicit)).toBeNull();
  });

  it('a member limited to another legal entity sees the notice: it is filed under the entity they see, not the default one', async () => {
    const branch = (await h.q<{ id: string }>(`INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh 4069', 'branch', $2) RETURNING id`, [h.orgId, h.owner])).rows[0]?.id as string;
    const limited = await person('member');
    await h.q(`INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [h.orgId, limited, branch, h.owner]);
    const g = await grant(limited, OLD, 'member', ['ludy.read']);
    await pass();
    expect(await stamp(g)).not.toBeNull();
    const row = (await h.q<{ legal_entity_id: string }>(`SELECT legal_entity_id FROM ludy_kernel.notification WHERE org_id = $1 AND user_id = $2 AND kind = $3`, [h.orgId, limited, KIND])).rows[0];
    expect(row?.legal_entity_id).toBe(branch);
    // The bell shows it to them (the restrictive le_scope policy would hide a row under the default entity).
    const seen = await h.runtime.query<{ items: NotificationItem[] }>('kernel.notification.list', {}, { actor: h.person(limited), orgId: h.orgId });
    expect(seen.items.filter((i) => i.kind === KIND)).toHaveLength(1);
  });

  it('is a command only the system runs: a person, even an owner, cannot', async () => {
    const owner = await person('owner');
    await expect(h.runtime.execute('kernel.mcp.engage_reads_notify', { userId: owner }, { actor: h.person(owner, true), orgId: h.orgId })).rejects.toMatchObject({ status: 403 });
  });
});
