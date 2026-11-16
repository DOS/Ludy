// SPDX-License-Identifier: AGPL-3.0-only
// Integration tests on PostgreSQL 17 for #2609: sharing project weekly status into org-visible project notes
// (R1, tainted propagation, immediate record-panel visibility) and emailing project members (R2, confirmation gate,
// suppression handling, worker template rendering with HTML escaping, notifications, and WORM audit redaction).
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import {
  PROJECT_WEEKLY_STATUS_MAIL_SOURCE,
  PROJECT_WEEKLY_STATUS_MAIL_TEMPLATE,
  PROJECT_WEEKLY_STATUS_NOTE_TAG,
  type NoteRecordPanel,
  type NoteWritten,
  type PersonalDataErasure,
  type PersonalDataResult,
  type ProjectWeeklyStatusSendMailResult,
} from '@crove/kernel-contract';
import { LocalDiskStore, Runtime } from '@crove/kernel-runtime';
import type { MailProvider, OutboundMail } from '@crove/mail';
import { notesCommands, notesQueries } from '@crove/mod-notes';
import { projectsCommands, projectsQueries } from '@crove/mod-projects';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { runMailJob } from '../src/mail-queue.ts';
import { MAIL_TEMPLATES } from '../src/mail-templates.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-proj-weekly-share-0123456789-abcdef';
const ISSUER = 'crove-auth-proj-share';
const SYSTEM = { type: 'system' as const, component: 'kernel.worker' };
const suite = ADMIN ? describe : describe.skip;

function recordingMailer() {
  const sent: OutboundMail[] = [];
  const batchPrefix = randomUUID().slice(0, 8);
  const mailer: MailProvider = {
    name: 'test',
    enabled: true,
    sendRetrySafety: 'never',
    async send(mail) {
      sent.push(mail);
      return { status: 'accepted', providerMessageId: `em_${batchPrefix}_${sent.length}` };
    },
  };
  return { mailer, sent };
}

suite('projects P6 share_note & send_mail (#2609)', () => {
  const dbName = `crove_test_proj_share_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let blobDir = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let workerRt: Runtime;
  let apps: {
    full: ReturnType<typeof createHttpApp>;
    withoutProjects: ReturnType<typeof createHttpApp>;
    withoutNotes: ReturnType<typeof createHttpApp>;
  };

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const asUser = (userId: string) => ({
    type: 'user' as const,
    userId,
    sessionId: randomUUID(),
    aal: 'aal1' as const,
  });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    sessionId: randomUUID(),
    aal: 'aal2' as const,
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function newPerson(tag: string) {
    const subject = randomUUID();
    const email = `${tag}-${randomUUID().slice(0, 8)}@proj-share.test`;
    const userId = await upsertIdentity(db, { issuer: ISSUER, subject, email, name: `User ${tag}` });
    return { subject, email, userId };
  }

  async function tokenFor(person: { subject: string; email: string }) {
    return new SignJWT({ role: 'authenticated', email: person.email, session_id: randomUUID(), aal: 'aal1', is_anonymous: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(person.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }

  async function rpc(
    appName: keyof typeof apps,
    path: string,
    person: { subject: string; email: string },
    input: unknown,
    orgSlug?: string,
  ) {
    const response = await apps[appName].request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await tokenFor(person)}`,
        'content-type': 'application/json',
        ...(orgSlug ? { 'x-crove-org': orgSlug } : {}),
      },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    const unwrapped =
      parsed && typeof parsed === 'object' && 'json' in parsed ? (parsed as { json: unknown }).json : parsed;
    return { status: response.status, body: unwrapped };
  }

  async function inviteAndJoin(orgId: string, inviterId: string, person: { email: string; userId: string }, role: 'admin' | 'member' | 'viewer') {
    const inv = await rt.execute<{ acceptPath: string }>(
      'kernel.member.invite.create',
      { email: person.email, role },
      { actor: asMfa(inviterId), orgId, idempotencyKey: randomUUID() },
    );
    await rt.executeOrgless('kernel.member.invite.accept', { token: inv.acceptPath.split('#')[1] }, { actor: asUser(person.userId) });
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

    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'crove_worker';
    workerUrl.password = 'test-worker-pw';

    pool = createPool({ connectionString: appUrl.toString(), max: 4 });
    workerPool = createPool({ connectionString: workerUrl.toString(), max: 2 });
    db = createDb(pool);

    const config = loadConfig({
      DATABASE_URL: appUrl.toString(),
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
      SEAL_KEY: randomBytes(32).toString('base64'),
    });
    const rtOpts = { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' as const };
    rt = new Runtime(db, rtOpts).register({
      commands: [...kernelCommands, ...projectsCommands, ...notesCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...projectsQueries, ...notesQueries],
    });
    const withoutProjects = new Runtime(db, { ...rtOpts, absentModules: ['projects'] }).register({
      commands: [...kernelCommands, ...notesCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...notesQueries],
    });
    const withoutNotes = new Runtime(db, { ...rtOpts, absentModules: ['notes'] }).register({
      commands: [...kernelCommands, ...projectsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...projectsQueries],
    });
    workerRt = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...projectsCommands, ...notesCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...projectsQueries, ...notesQueries],
    });
    blobDir = await mkdtemp(join(tmpdir(), 'crove-proj-share-'));
    const store = new LocalDiskStore(blobDir);
    const makeApp = (runtime: Runtime) =>
      createHttpApp({ config, runtime, store, authenticate: createAuthenticator(config, db), pool, aiEnabled: false });
    apps = {
      full: makeApp(rt),
      withoutProjects: makeApp(withoutProjects),
      withoutNotes: makeApp(withoutNotes),
    };
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (blobDir) await rm(blobDir, { recursive: true, force: true });
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('enforces RBAC, archive lock, module gates, tainted propagation, and immediate notes panel visibility for share_note', async () => {
    const owner = await newPerson('org-owner');
    const adminUser = await newPerson('org-admin');
    const projectLead = await newPerson('proj-lead');
    const plainMember = await newPerson('plain-member');
    const viewer = await newPerson('viewer');
    const org = await createOrg(rt, asUser(owner.userId), 'Cong ty Chia se Tuan');

    await inviteAndJoin(org.orgId, owner.userId, adminUser, 'admin');
    await inviteAndJoin(org.orgId, owner.userId, projectLead, 'member');
    await inviteAndJoin(org.orgId, owner.userId, plainMember, 'member');
    await inviteAndJoin(org.orgId, owner.userId, viewer, 'viewer');

    const { projectId } = await rt.execute<{ projectId: string }>(
      'projects.project.create',
      { name: 'Trien khai ERP', ownerUserId: projectLead.userId },
      { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    await rt.execute(
      'projects.member.add',
      { projectId, userId: plainMember.userId },
      { actor: asUser(projectLead.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );

    // Non-owner plain member and viewer cannot share weekly status as an org note.
    const plainRes = await rpc(
      'full',
      'projects/weeklyStatusShareNote',
      plainMember,
      { projectId, title: 'Khong duoc phep', body: 'Noi dung bi chan', tainted: false, idempotencyKey: randomUUID() },
      org.slug,
    );
    expect(plainRes.status).toBe(403);

    const viewerRes = await rpc(
      'full',
      'projects/weeklyStatusShareNote',
      viewer,
      { projectId, title: 'Khong duoc phep', body: 'Viewer bi chan', tainted: false, idempotencyKey: randomUUID() },
      org.slug,
    );
    expect(viewerRes.status).toBe(403);

    // Module gates: projects off or notes off both reject with 404.
    const offProj = await rpc(
      'withoutProjects',
      'projects/weeklyStatusShareNote',
      owner,
      { projectId, title: 'Test off', body: 'Body', tainted: false, idempotencyKey: randomUUID() },
      org.slug,
    );
    expect(offProj.status).toBe(404);

    const offNotes = await rpc(
      'withoutNotes',
      'projects/weeklyStatusShareNote',
      owner,
      { projectId, title: 'Notes off', body: 'Body', tainted: false, idempotencyKey: randomUUID() },
      org.slug,
    );
    expect(offNotes.status).toBe(404);

    // Project owner shares unedited AI draft -> org note with tainted = true and tag bao-cao-tuan.
    const secretAiText = 'AI draft sensitive sentence 987123.';
    const aiShare = await rpc(
      'full',
      'projects/weeklyStatusShareNote',
      projectLead,
      { projectId, title: 'Bao cao tuan: Trien khai ERP', body: secretAiText, tainted: true, idempotencyKey: randomUUID() },
      org.slug,
    );
    expect(aiShare.status, JSON.stringify(aiShare.body)).toBe(200);
    const aiWritten = aiShare.body as NoteWritten;
    expect(aiWritten.noteId).toMatch(/^[0-9a-f-]{36}$/i);

    // Org admin shares human-edited summary -> tainted = false.
    const humanEditTitle = 'Bao cao tuan (da duyet tay)';
    const humanShare = await rpc(
      'full',
      'projects/weeklyStatusShareNote',
      adminUser,
      { projectId, title: humanEditTitle, body: 'Da hoan thanh 3 viec va kiem tra xong hop dong.', tainted: false, idempotencyKey: randomUUID() },
      org.slug,
    );
    expect(humanShare.status, JSON.stringify(humanShare.body)).toBe(200);
    const humanWritten = humanShare.body as NoteWritten;

    // Immediately visible in project NotesPanel to another org member.
    const panel = await rt.query<NoteRecordPanel>(
      'notes.record.panel',
      { targetType: 'projects.project', targetId: projectId },
      { actor: asUser(plainMember.userId), orgId: org.orgId },
    );
    const panelNotes = [...panel.pinned, ...panel.latest];
    expect(panelNotes).toHaveLength(2);
    const byId = new Map(panelNotes.map((n) => [n.id, n]));
    expect(byId.get(aiWritten.noteId)).toMatchObject({
      visibility: 'org',
      tainted: true,
      tags: [PROJECT_WEEKLY_STATUS_NOTE_TAG],
    });
    expect(byId.get(humanWritten.noteId)).toMatchObject({
      visibility: 'org',
      tainted: false,
      tags: [PROJECT_WEEKLY_STATUS_NOTE_TAG],
    });

    // WORM audit events never leak free-text title or body.
    const auditRows = await admin(async (c) =>
      (
        await c.query<{ command: string; detail: unknown }>(
          `SELECT command, detail FROM crove_kernel.audit_event
           WHERE org_id = $1 AND command IN ('projects.weekly_status.share_note', 'notes.note.create')
           ORDER BY occurred_at ASC`,
          [org.orgId],
        )
      ).rows,
    );
    const serializedAudit = JSON.stringify(auditRows);
    expect(serializedAudit).not.toContain(secretAiText);
    expect(serializedAudit).not.toContain(humanEditTitle);
    expect(serializedAudit).not.toContain('Da hoan thanh 3 viec');

    // Archived project refuses new weekly status note shares.
    await rt.execute(
      'projects.project.archive',
      { projectId },
      { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    const archivedRes = await rpc(
      'full',
      'projects/weeklyStatusShareNote',
      owner,
      { projectId, title: 'Archived', body: 'Should fail', tainted: false, idempotencyKey: randomUUID() },
      org.slug,
    );
    expect(archivedRes.status).toBe(409);
  });

  it('enforces RBAC, solo-project no-op, mail suppression, worker template escaping, notification dispatch, and WORM redaction for send_mail', async () => {
    const owner = await newPerson('mail-owner');
    const alice = await newPerson('mail-alice');
    const bobSuppressed = await newPerson('mail-bob');
    const plainMember = await newPerson('mail-plain');
    const viewer = await newPerson('mail-viewer');
    const org = await createOrg(rt, asUser(owner.userId), 'Cong ty Gui Bao cao');

    await inviteAndJoin(org.orgId, owner.userId, alice, 'member');
    await inviteAndJoin(org.orgId, owner.userId, bobSuppressed, 'member');
    await inviteAndJoin(org.orgId, owner.userId, plainMember, 'member');
    await inviteAndJoin(org.orgId, owner.userId, viewer, 'viewer');

    const { projectId } = await rt.execute<{ projectId: string }>(
      'projects.project.create',
      { name: 'Du an <Web> & App', ownerUserId: owner.userId },
      { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );

    // 1. Solo project (only owner on project) sends 0 emails cleanly.
    const soloRes = await rpc(
      'full',
      'projects/weeklyStatusSendMail',
      owner,
      {
        projectId,
        subject: 'Bao cao tuan solo',
        summary: 'Chi co minh toi.',
        language: 'vi',
        tainted: false,
        confirmed: true,
        idempotencyKey: randomUUID(),
      },
      org.slug,
    );
    expect(soloRes.status, JSON.stringify(soloRes.body)).toBe(200);
    expect(soloRes.body).toEqual({ sentCount: 0, skippedCount: 0 });

    // Add Alice (deliverable), Bob (suppressed), and plainMember (we will suppress plainMember too or keep Alice+Bob; let's test plainMember RBAC then keep Alice & Bob).
    await rt.execute('projects.member.add', { projectId, userId: alice.userId }, { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() });
    await rt.execute('projects.member.add', { projectId, userId: bobSuppressed.userId }, { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() });
    await rt.execute('projects.member.add', { projectId, userId: plainMember.userId }, { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() });

    // Viewer & non-owner plain member cannot send weekly status email.
    const plainDenied = await rpc(
      'full',
      'projects/weeklyStatusSendMail',
      plainMember,
      { projectId, subject: 'Blocked', summary: 'Blocked', language: 'vi', tainted: false, confirmed: true, idempotencyKey: randomUUID() },
      org.slug,
    );
    expect(plainDenied.status).toBe(403);

    const viewerDenied = await rpc(
      'full',
      'projects/weeklyStatusSendMail',
      viewer,
      { projectId, subject: 'Blocked', summary: 'Blocked', language: 'vi', tainted: false, confirmed: true, idempotencyKey: randomUUID() },
      org.slug,
    );
    expect(viewerDenied.status).toBe(403);

    // Omitting confirmed: true is rejected.
    const unconfirmed = await rpc(
      'full',
      'projects/weeklyStatusSendMail',
      owner,
      { projectId, subject: 'Missing confirm', summary: 'No confirm', language: 'vi', tainted: false, confirmed: false, idempotencyKey: randomUUID() },
      org.slug,
    );
    expect(unconfirmed.status).toBeGreaterThanOrEqual(400);

    // Remove plainMember so remaining other project members are Alice (deliverable) and Bob (suppressed).
    await rt.execute('projects.member.remove', { projectId, userId: plainMember.userId }, { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() });
    await rt.execute(
      'kernel.mail.suppression.add',
      { email: bobSuppressed.email, scope: 'all' },
      { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );

    // Add a completed task in this week so server-side deterministic counts appear in the email.
    const { taskId: doneTaskId } = await rt.execute<{ taskId: string }>(
      'projects.task.create',
      { projectId, title: 'Chot bao gia', assigneePositionId: null },
      { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    await rt.execute(
      'kernel.task.set_status',
      { id: doneTaskId, status: 'done' },
      { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );

    const subjectSecret = 'Bao cao tuan: Q4 <review>';
    const summarySecret = 'Tom tat <script>alert(1)</script> chi tiet rieng tu 555111.';
    const mailIdem = randomUUID();
    const mailRes = await rpc(
      'full',
      'projects/weeklyStatusSendMail',
      owner,
      {
        projectId,
        subject: subjectSecret,
        summary: summarySecret,
        language: 'vi',
        tainted: true,
        confirmed: true,
        idempotencyKey: mailIdem,
      },
      org.slug,
    );
    expect(mailRes.status, JSON.stringify(mailRes.body)).toBe(200);
    expect(mailRes.body as ProjectWeeklyStatusSendMailResult).toEqual({ sentCount: 1, skippedCount: 1 });

    // Replaying the same idempotencyKey returns the cached result without queueing duplicate mails.
    const mailReplay = await rpc(
      'full',
      'projects/weeklyStatusSendMail',
      owner,
      {
        projectId,
        subject: subjectSecret,
        summary: summarySecret,
        language: 'vi',
        tainted: true,
        confirmed: true,
        idempotencyKey: mailIdem,
      },
      org.slug,
    );
    expect(mailReplay.status).toBe(200);
    expect(mailReplay.body).toEqual({ sentCount: 1, skippedCount: 1 });

    // Inspect queued & suppressed mail_message rows.
    const mailRows = await admin(async (c) =>
      (
        await c.query<{ id: string; to_address: string; status: string; stream: string; template_key: string; source: string }>(
          `SELECT id, to_address, status, stream, template_key, source
           FROM crove_kernel.mail_message
           WHERE org_id = $1 AND source = $2
           ORDER BY created_at ASC`,
          [org.orgId, PROJECT_WEEKLY_STATUS_MAIL_SOURCE],
        )
      ).rows,
    );
    expect(mailRows).toHaveLength(2);
    const aliceRow = mailRows.find((r) => r.to_address === alice.email);
    const bobRow = mailRows.find((r) => r.to_address === bobSuppressed.email);
    expect(aliceRow).toMatchObject({ status: 'queued', stream: 'transactional', template_key: PROJECT_WEEKLY_STATUS_MAIL_TEMPLATE });
    expect(bobRow).toMatchObject({ status: 'suppressed', stream: 'transactional', template_key: PROJECT_WEEKLY_STATUS_MAIL_TEMPLATE });
    expect(mailRows.find((r) => r.to_address === owner.email)).toBeUndefined();

    // Mail worker renders escaped HTML only for Alice's queued message, never sends suppressed Bob row.
    const { mailer, sent } = recordingMailer();
    const jobDeps = {
      runtime: workerRt,
      mailer,
      templates: MAIL_TEMPLATES,
      publicUrl: 'https://app.example.test',
      bounceDomain: null,
      sleep: async () => {},
    };
    const aliceJob = await runMailJob(jobDeps, { orgId: org.orgId, messageId: aliceRow!.id });
    expect(aliceJob).toEqual({ action: 'recorded', outcome: 'sent', code: null });
    const bobJob = await runMailJob(jobDeps, { orgId: org.orgId, messageId: bobRow!.id });
    expect(bobJob).toMatchObject({ action: 'none' });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(alice.email);
    expect(sent[0]?.subject).toBe(subjectSecret);
    expect(sent[0]?.html).not.toContain('<script>');
    expect(sent[0]?.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(sent[0]?.html).toContain('Du an &lt;Web&gt; &amp; App');
    expect(sent[0]?.html).toContain(`https://app.example.test/o/${org.slug}/projects/${projectId}`);
    expect(sent[0]?.text).toContain('Hoàn thành tuần này: 1');
    expect(sent[0]?.text).toContain('đồng nghiệp AI');

    // Outbox event projects.weekly_status.sent dispatches in-app notification for Alice only, with project name resolved cleanly.
    const outboxRows = await admin(async (c) =>
      (
        await c.query<{ id: string; payload: unknown }>(
          `SELECT id, payload FROM crove_kernel.outbox_event
           WHERE org_id = $1 AND type = 'projects.weekly_status.sent'`,
          [org.orgId],
        )
      ).rows,
    );
    expect(outboxRows).toHaveLength(1);
    const outboxText = JSON.stringify(outboxRows[0]?.payload);
    expect(outboxText).not.toContain(alice.email);
    expect(outboxText).not.toContain(summarySecret);

    const dispatched = await workerRt.execute<{ sent: number }>(
      'kernel.notification.dispatch',
      { eventId: outboxRows[0]!.id },
      { actor: SYSTEM, orgId: org.orgId },
    );
    expect(dispatched.sent).toBe(1);

    const aliceNotifs = await rt.query<{ items: Array<{ kind: string; subjectId: string | null; detail: Record<string, string> }> }>(
      'kernel.notification.list',
      {},
      { actor: asUser(alice.userId), orgId: org.orgId },
    );
    const projectNotif = aliceNotifs.items.find((n) => n.kind === 'projects.weekly_status');
    expect(projectNotif).toBeDefined();
    expect(projectNotif?.subjectId).toBe(projectId);
    expect(projectNotif?.detail.title).toBe('Du an <Web> & App');

    // WORM audit events contain zero emails, zero subject text, zero summary text.
    const auditRows = await admin(async (c) =>
      (
        await c.query<{ command: string; detail: unknown }>(
          `SELECT command, detail FROM crove_kernel.audit_event
           WHERE org_id = $1 AND command IN ('projects.weekly_status.send_mail', 'kernel.mail.members.queue')`,
          [org.orgId],
        )
      ).rows,
    );
    const auditSerialized = JSON.stringify(auditRows);
    expect(auditSerialized).not.toContain(alice.email);
    expect(auditSerialized).not.toContain(bobSuppressed.email);
    expect(auditSerialized).not.toContain(subjectSecret);
    expect(auditSerialized).not.toContain(summarySecret);
    expect(auditSerialized).not.toContain('555111');
  });

  it('skips entity-restricted project members when project holds tasks outside their le_scope (#2609)', async () => {
    const owner = await newPerson('scope-owner');
    const branchMember = await newPerson('scope-branch');
    const orgWideMember = await newPerson('scope-orgwide');
    const org = await createOrg(rt, asUser(owner.userId), 'Cong ty Phan quyen mail');
    await inviteAndJoin(org.orgId, owner.userId, branchMember, 'member');
    await inviteAndJoin(org.orgId, owner.userId, orgWideMember, 'member');

    let defaultEntityId = '';
    let branchEntityId = '';
    let defaultTaskId = '';
    let branchTaskId = '';
    await admin(async (c) => {
      defaultEntityId = (
        await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [org.orgId])
      ).rows[0]!.id;
      branchEntityId = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by)
           VALUES ($1, 'Chi nhanh Mien Trung', 'branch', $2) RETURNING id`,
          [org.orgId, owner.userId],
        )
      ).rows[0]!.id;
      await c.query(
        `INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by)
         VALUES ($1, $2, 'external_accountant', $3, $4)`,
        [org.orgId, branchMember.userId, branchEntityId, owner.userId],
      );
      defaultTaskId = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.task (org_id, title, source, created_by_type, legal_entity_id)
           VALUES ($1, 'Viec tru so chinh', 'human', 'user', $2) RETURNING id`,
          [org.orgId, defaultEntityId],
        )
      ).rows[0]!.id;
      branchTaskId = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.task (org_id, title, source, created_by_type, legal_entity_id)
           VALUES ($1, 'Viec chi nhanh', 'human', 'user', $2) RETURNING id`,
          [org.orgId, branchEntityId],
        )
      ).rows[0]!.id;
    });

    const { projectId: mixedProjectId } = await rt.execute<{ projectId: string }>(
      'projects.project.create',
      { name: 'Du an da phap nhan' },
      { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    await rt.execute('projects.member.add', { projectId: mixedProjectId, userId: branchMember.userId }, { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() });
    await rt.execute('projects.member.add', { projectId: mixedProjectId, userId: orgWideMember.userId }, { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() });
    await rt.execute('projects.task.add', { projectId: mixedProjectId, taskId: defaultTaskId }, { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() });

    const mixedRes = await rpc(
      'full',
      'projects/weeklyStatusSendMail',
      owner,
      {
        projectId: mixedProjectId,
        subject: 'Bao cao tuan: Du an da phap nhan',
        summary: 'Tong hop tru so chinh.',
        language: 'vi',
        tainted: false,
        confirmed: true,
        idempotencyKey: randomUUID(),
      },
      org.slug,
    );
    expect(mixedRes.status, JSON.stringify(mixedRes.body)).toBe(200);
    expect(mixedRes.body).toEqual({ sentCount: 1, skippedCount: 1 });

    const mixedMails = await admin(async (c) =>
      (
        await c.query<{ to_address: string }>(
          `SELECT to_address FROM crove_kernel.mail_message
           WHERE org_id = $1 AND source = $2 AND source_id = $3`,
          [org.orgId, PROJECT_WEEKLY_STATUS_MAIL_SOURCE, mixedProjectId],
        )
      ).rows,
    );
    expect(mixedMails.map((r) => r.to_address)).toEqual([orgWideMember.email]);

    const { projectId: branchProjectId } = await rt.execute<{ projectId: string }>(
      'projects.project.create',
      { name: 'Du an chi nhanh' },
      { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    await rt.execute('projects.member.add', { projectId: branchProjectId, userId: branchMember.userId }, { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() });
    await rt.execute('projects.task.add', { projectId: branchProjectId, taskId: branchTaskId }, { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() });

    const branchRes = await rpc(
      'full',
      'projects/weeklyStatusSendMail',
      owner,
      {
        projectId: branchProjectId,
        subject: 'Bao cao tuan: Du an chi nhanh',
        summary: 'Tien do chi nhanh on.',
        language: 'vi',
        tainted: false,
        confirmed: true,
        idempotencyKey: randomUUID(),
      },
      org.slug,
    );
    expect(branchRes.status, JSON.stringify(branchRes.body)).toBe(200);
    expect(branchRes.body).toEqual({ sentCount: 1, skippedCount: 0 });
  });

  it('finds and erases project weekly status email copies under personal_data commands (#2609)', async () => {
    const owner = await newPerson('pdpl-owner');
    const recipient = await newPerson('pdpl-rcpt');
    const org = await createOrg(rt, asUser(owner.userId), 'Cong ty PDPL');
    await inviteAndJoin(org.orgId, owner.userId, recipient, 'member');

    const { projectId: cleanProjectId } = await rt.execute<{ projectId: string }>(
      'projects.project.create',
      { name: 'Du an noi bo' },
      { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    await rt.execute('projects.member.add', { projectId: cleanProjectId, userId: recipient.userId }, { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() });

    const targetEmail = 'khach.pdpl@share.test';
    await rt.execute<ProjectWeeklyStatusSendMailResult>(
      'projects.weekly_status.send_mail',
      {
        projectId: cleanProjectId,
        subject: `Bao cao tuan cho ${targetEmail} don 123456789`,
        summary: 'Khach 0912345678 da duyet don 123456789.',
        language: 'vi',
        tainted: false,
        confirmed: true,
      },
      { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );

    const foundByEmail = await rt.execute<PersonalDataResult>(
      'kernel.personal_data.find',
      { value: targetEmail },
      { actor: asUser(owner.userId), orgId: org.orgId },
    );
    expect(foundByEmail.matches.map((m) => m.column)).toContain('crove_kernel.mail_message.payload');

    // Short numbers (8-9 digits, <10 digits) leave weekly status mails intact and list the kept reason.
    const shortKept = await rt.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: '123456789' },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    expect(shortKept.kept).toContainEqual({
      column: 'crove_kernel.mail_message.payload',
      rows: 1,
      reason: expect.stringContaining('fewer than 10 digits'),
    });

    // Erasing the email drops subject & payload on the queued mail so the worker will not send stale PII.
    const erasedQueued = await rt.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: targetEmail },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    expect(erasedQueued.erased).toContainEqual({ column: 'crove_kernel.mail_message.payload', rows: 1 });
    expect(erasedQueued.kept.filter((k) => k.column === 'crove_kernel.mail_message.payload')).toEqual([]);

    const queuedRow = (
      await admin((c) =>
        c.query<{ id: string; subject: string | null; payload: unknown; to_address: string | null }>(
          `SELECT id, subject, payload, to_address FROM crove_kernel.mail_message
           WHERE org_id = $1 AND source = $2 AND source_id = $3`,
          [org.orgId, PROJECT_WEEKLY_STATUS_MAIL_SOURCE, cleanProjectId],
        ),
      )
    ).rows[0]!;
    expect(queuedRow.subject).toBeNull();
    expect(queuedRow.payload).toBeNull();
    expect(queuedRow.to_address).toBe(recipient.email);

    const { mailer, sent } = recordingMailer();
    const jobAfterErase = await runMailJob(
      {
        runtime: workerRt,
        mailer,
        templates: MAIL_TEMPLATES,
        publicUrl: 'https://app.example.test',
        bounceDomain: null,
        sleep: async () => {},
      },
      { orgId: org.orgId, messageId: queuedRow.id },
    );
    expect(jobAfterErase).toEqual({ action: 'recorded', outcome: 'failed', code: 'TEMPLATE_DATA' });
    expect(sent).toHaveLength(0);
    expect((await rt.execute<PersonalDataResult>('kernel.personal_data.find', { value: targetEmail }, { actor: asUser(owner.userId), orgId: org.orgId })).matches).toEqual([]);

    // Delivered mails matched via the project's name also drop server-side payload & subject and report the kept delivery notice.
    const projectEmail = 'khach.duan@share.test';
    const { projectId: namedProjectId } = await rt.execute<{ projectId: string }>(
      'projects.project.create',
      { name: `Trien khai cho ${projectEmail}` },
      { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    await rt.execute('projects.member.add', { projectId: namedProjectId, userId: recipient.userId }, { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() });
    await rt.execute<ProjectWeeklyStatusSendMailResult>(
      'projects.weekly_status.send_mail',
      {
        projectId: namedProjectId,
        subject: 'Bao cao tuan du an',
        summary: 'Tien do dung ke hoach.',
        language: 'vi',
        tainted: false,
        confirmed: true,
      },
      { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    const deliveredMailId = (
      await admin((c) =>
        c.query<{ id: string }>(
          `SELECT id FROM crove_kernel.mail_message WHERE org_id = $1 AND source = $2 AND source_id = $3`,
          [org.orgId, PROJECT_WEEKLY_STATUS_MAIL_SOURCE, namedProjectId],
        ),
      )
    ).rows[0]!.id;
    const deliveredJob = await runMailJob(
      {
        runtime: workerRt,
        mailer,
        templates: MAIL_TEMPLATES,
        publicUrl: 'https://app.example.test',
        bounceDomain: null,
        sleep: async () => {},
      },
      { orgId: org.orgId, messageId: deliveredMailId },
    );
    expect(deliveredJob).toEqual({ action: 'recorded', outcome: 'sent', code: null });

    const erasedDelivered = await rt.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: projectEmail },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    expect(erasedDelivered.erased).toEqual(
      expect.arrayContaining([
        { column: 'crove_kernel.mail_message.payload', rows: 1 },
        { column: 'crove_projects.project.name', rows: 1 },
      ]),
    );
    expect(erasedDelivered.kept).toContainEqual({
      column: 'crove_kernel.mail_message.payload',
      rows: 1,
      reason: expect.stringContaining('cannot be recalled'),
    });

    const eraseAudit = (
      await admin((c) =>
        c.query<{ detail: unknown }>(
          `SELECT detail FROM crove_kernel.audit_event
           WHERE org_id = $1 AND command = 'kernel.personal_data.erase' AND outcome = 'ok'
           ORDER BY id DESC LIMIT 1`,
          [org.orgId],
        ),
      )
    ).rows[0]!;
    expect(eraseAudit.detail).toMatchObject({ project_weekly_mails: 1 });
    expect(JSON.stringify(eraseAudit)).not.toContain(projectEmail);

    // A concurrent send_mail holding the shared projects.weekly_mail advisory lock causes personal_data.erase to fail cleanly with PERSONAL_DATA_BUSY rather than missing in-flight mail rows.
    const lockClient = await pool.connect();
    try {
      await lockClient.query('BEGIN');
      await lockClient.query('SELECT pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended($1, 0))', [`projects.weekly_mail:${org.orgId}`]);
      await expect(
        rt.execute(
          'kernel.personal_data.erase',
          { value: 'concurrent.check@share.test' },
          { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
        ),
      ).rejects.toMatchObject({ code: 'PERSONAL_DATA_BUSY', status: 409 });
      await lockClient.query('COMMIT');
    } finally {
      lockClient.release();
    }
  });
});
