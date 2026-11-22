// SPDX-License-Identifier: AGPL-3.0-only
// Notes v2 E4 (#3560): end-to-end DB + HTTP tests for extension 'notes' scope, standalone/combined authorization,
// write-only boundary, Quick Capture + Web Clipper commands (always private + tainted, zero PII in audit), URL scheme
// sanitization, taint clearing on author edit, org-app gating, and cross-member / viewer / agent isolation.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { kernelCommands, kernelQueries } from '@ludy/kernel';
import { BlobNotFoundError, DomainError, Runtime, sha256Hex, type BlobStore, type CredentialBroker } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { notesCommands, notesQueries } from '@ludy/mod-notes';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { fakeMediaMeasurer } from './fake-media.ts';
import { RateLimiter } from '../src/rate-limit.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-notes-clipper-secret-0123456789-abcdef';
const ISSUER = 'crove-auth-notes-ext';
const suite = ADMIN ? describe : describe.skip;

class MemoryStore implements BlobStore {
  readonly storage = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array): Promise<string> {
    this.storage.set(key, new Uint8Array(bytes));
    return `content:${sha256Hex(bytes)}`;
  }
  async get(key: string): Promise<Uint8Array> {
    const bytes = this.storage.get(key);
    if (!bytes) throw new BlobNotFoundError(key);
    return bytes;
  }
  async getRange(key: string, start: number, end: number): Promise<Uint8Array> {
    return (await this.get(key)).subarray(start, end + 1);
  }
  async delete(key: string): Promise<void> {
    this.storage.delete(key);
  }
}

const EXT_ID = 'a'.repeat(32);
const challengeOf = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

suite('Notes v2 E4 (#3560): extension notes scope, Quick Capture & Web Clipper over HTTP + PostgreSQL 17', () => {
  const dbName = `crove_test_notes_ext_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let runtime: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();
  const accounts = new Map<string, { subject: string; email: string; session: string }>();
  let slug = '';
  let orgId = '';

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function jwt(name: string, mfa = false) {
    let who = accounts.get(name);
    if (!who) {
      who = { subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@notes-ext.test`, session: randomUUID() };
      accounts.set(name, who);
    }
    const now = Math.floor(Date.now() / 1000);
    const assurance = mfa ? { aal: 'aal2', amr: [{ method: 'totp', timestamp: now }] } : { aal: 'aal1' };
    return new SignJWT({ role: 'authenticated', email: who.email, session_id: who.session, is_anonymous: false, ...assurance })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }

  const asBrowser = async (name: string, org: string | null = slug, mfa = false) => ({
    authorization: `Bearer ${await jwt(name, mfa)}`,
    'content-type': 'application/json',
    ...(org ? { 'x-crove-org': org } : {}),
  });
  const asToken = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

  async function rpc(path: string, headers: Record<string, string>, input: unknown) {
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json()) as { json?: Record<string, unknown> };
    return { status: response.status, body: (body.json ?? body) as Record<string, unknown> };
  }

  async function connectAndExchange(name: string, scopes: string[]) {
    const verifier = randomBytes(32).toString('base64url');
    const authRes = await app.request('/api/extension/authorize', {
      method: 'POST',
      headers: await asBrowser(name),
      body: JSON.stringify({ extensionId: EXT_ID, codeChallenge: challengeOf(verifier), codeChallengeMethod: 'S256', scopes, deviceName: 'Chrome on macOS' }),
    });
    const authBody = (await authRes.json()) as { code?: string };
    expect(authRes.status, JSON.stringify(authBody)).toBe(200);
    const tokenRes = await app.request('/api/extension/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `chrome-extension://${EXT_ID}` },
      body: JSON.stringify({ code: authBody.code, codeVerifier: verifier }),
    });
    expect(tokenRes.status).toBe(200);
    return (await tokenRes.json()) as { token: string; tokenId: string; orgId: string; scopes: string[]; expiresAt: string };
  }

  async function join(name: string, role: 'admin' | 'member' | 'viewer') {
    await jwt(name);
    const email = accounts.get(name)?.email;
    const invited = await rpc('org/invite', await asBrowser('owner', slug, true), { email, role });
    expect(invited.status).toBe(200);
    const accepted = await rpc('invites/accept', await asBrowser(name, null), { token: String(invited.body.acceptPath).split('#')[1] });
    expect(accepted.status).toBe(200);
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
    const appUrl = new URL(adminUrl);
    appUrl.username = 'ludy_app';
    appUrl.password = 'test-app-pw';
    pool = createPool({ connectionString: appUrl.toString(), max: 8 });
    const db = createDb(pool);
    const config = loadConfig({ DATABASE_URL: appUrl.toString(), AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent', EXTENSION_IDS: EXT_ID });
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: [...kernelCommands, ...financeCommands, ...meetingsCommands, ...notesCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries, ...meetingsQueries, ...notesQueries],
    });
    const broker = {
      keyId: 'k1-notes-ext',
      keyIds: ['k1-notes-ext'],
      derive: (purpose: string) => createHash('sha256').update(`test-secret:${purpose}`).digest(),
      deriveKey: (keyId: string, purpose: string) => createHash('sha256').update(`test-secret:${keyId}:${purpose}`).digest(),
    } as unknown as CredentialBroker;
    app = createHttpApp({
      config,
      runtime,
      store,
      broker,
      authenticate: createAuthenticator(config, db),
      pool,
      aiEnabled: false,
      extensionTokenLimit: new RateLimiter({ perMinute: 40 }),
      mediaMeasurer: fakeMediaMeasurer(),
    });
    const created = await rpc('org/create', await asBrowser('owner', null), { name: `Notes Ext Org ${randomUUID().slice(0, 6)}`, idempotencyKey: randomUUID() });
    expect(created.status).toBe(200);
    slug = String(created.body.slug);
    orgId = String(created.body.orgId);
    await join('member', 'member');
    await join('other', 'member');
    await join('viewer', 'viewer');
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('authorizes and exchanges standalone notes scope via notes.extension.exchanged and supports combined scopes', async () => {
    const notesOnly = await connectAndExchange('member', ['notes']);
    expect(notesOnly.scopes).toEqual(['notes']);

    const meRes = await app.request('/api/extension/me', { headers: { authorization: `Bearer ${notesOnly.token}` } });
    expect(meRes.status).toBe(200);
    expect((await meRes.json()) as Record<string, unknown>).toMatchObject({
      scopes: ['notes'],
      features: { meetings: false, agenda: false, notes: true },
    });

    const notesExchangeAudit = await admin(async (c) =>
      (await c.query<{ detail: Record<string, unknown> }>(
        `SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'notes.extension.exchanged' AND outcome = 'ok'`,
        [orgId],
      )).rows,
    );
    expect(notesExchangeAudit.some((r) => r.detail.extensionToken === notesOnly.tokenId)).toBe(true);

    const combined = await connectAndExchange('member', ['meetings', 'notes']);
    expect(combined.scopes).toEqual(['meetings', 'notes']);
    const meCombined = await app.request('/api/extension/me', { headers: { authorization: `Bearer ${combined.token}` } });
    expect((await meCombined.json()) as Record<string, unknown>).toMatchObject({
      scopes: ['meetings', 'notes'],
      features: { meetings: true, agenda: false, notes: true },
    });

    // 'agenda' still requires 'meetings' even when combined with 'notes'.
    const badCombo = await app.request('/api/extension/authorize', {
      method: 'POST',
      headers: await asBrowser('member'),
      body: JSON.stringify({ extensionId: EXT_ID, codeChallenge: challengeOf('v'.repeat(43)), codeChallengeMethod: 'S256', scopes: ['notes', 'agenda'], deviceName: 'Chrome' }),
    });
    expect(badCombo.status).toBe(422);
  });

  it('clips private + tainted notes and quick-captures private + tainted to-dos with zero audit PII', async () => {
    const { token, tokenId } = await connectAndExchange('member', ['notes']);
    const headers = asToken(token);

    const clipRes = await rpc('notes/clip', headers, {
      title: 'Clipped Article',
      body: 'Summary paragraph with **highlights**.',
      tags: ['Research', 'Web'],
      sourceUrl: 'https://example.com/posts/123?ref=tab',
    });
    expect(clipRes.status).toBe(200);
    const noteId = String(clipRes.body.noteId);

    const todoRes = await rpc('notes/todos/quickCapture', headers, {
      title: 'Follow up invoice #88',
      details: 'Verify contract PDF',
      dueOn: '2027-03-01',
      sourceUrl: 'https://example.com/contracts/88',
    });
    expect(todoRes.status).toBe(200);
    const todoId = String(todoRes.body.todoId);

    const noteRow = await admin(async (c) =>
      (await c.query<{ visibility: string; tainted: boolean; author_user_id: string; body: string; tags: string[] }>(
        'SELECT visibility, tainted, author_user_id, body, tags FROM crove_notes.note WHERE id = $1',
        [noteId],
      )).rows[0],
    );
    expect(noteRow?.visibility).toBe('private');
    expect(noteRow?.tainted).toBe(true);
    expect(noteRow?.body).toContain('[https://example.com/posts/123?ref=tab](https://example.com/posts/123?ref=tab)');
    expect(noteRow?.body).toContain('Summary paragraph with **highlights**.');
    expect(noteRow?.tags).toEqual(['research', 'web']);

    const todoRow = await admin(async (c) =>
      (await c.query<{ owner_user_id: string; tainted: boolean; details: string; due_on: string }>(
        'SELECT owner_user_id, tainted, details, due_on::text FROM crove_notes.todo WHERE id = $1',
        [todoId],
      )).rows[0],
    );
    expect(todoRow?.owner_user_id).toBe(noteRow?.author_user_id);
    expect(todoRow?.tainted).toBe(true);
    expect(todoRow?.details).toContain('https://example.com/contracts/88');
    expect(todoRow?.details).toContain('Verify contract PDF');
    expect(todoRow?.due_on).toBe('2027-03-01');

    // Audit rows must record extensionToken and taint, never raw URL or clipped text.
    const auditRows = await admin(async (c) =>
      (await c.query<{ command: string; detail: Record<string, unknown> }>(
        `SELECT command, detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command IN ('notes.note.clip', 'notes.todo.quick_capture')`,
        [orgId],
      )).rows,
    );
    expect(auditRows).toHaveLength(2);
    for (const row of auditRows) {
      expect(row.detail.extensionToken).toBe(tokenId);
      expect(row.detail.tainted).toBe(true);
      const serialized = JSON.stringify(row.detail);
      expect(serialized).not.toContain('example.com');
      expect(serialized).not.toContain('Clipped Article');
      expect(serialized).not.toContain('Follow up invoice #88');
    }

    // Other member and even org owner cannot see the private clipped note or private to-do.
    for (const outsider of ['other', 'owner']) {
      const readNote = await rpc('notes/get', await asBrowser(outsider), { noteId });
      expect(readNote.status).toBe(404);
      const readTodo = await rpc('notes/todos/get', await asBrowser(outsider), { todoId });
      expect(readTodo.status).toBe(404);
    }

    // Author can read the clipped note in Ludy and clearing taint happens on author content edit.
    const authorGet = await rpc('notes/get', await asBrowser('member'), { noteId });
    expect(authorGet.status).toBe(200);
    expect(authorGet.body.visibility).toBe('private');
    expect(authorGet.body.tainted).toBe(true);

    const edited = await rpc('notes/update', await asBrowser('member'), {
      noteId,
      revision: Number(authorGet.body.revision),
      title: 'Reviewed Article',
      body: 'Edited and verified content',
      tags: ['research'],
    });
    expect(edited.status).toBe(200);
    const clearedRow = await admin(async (c) => (await c.query<{ tainted: boolean }>('SELECT tainted FROM crove_notes.note WHERE id = $1', [noteId])).rows[0]);
    expect(clearedRow?.tainted).toBe(false);
  });

  it('enforces write-only extension boundary, URL scheme sanitization, role/agent blocks and org app switch', async () => {
    const { token } = await connectAndExchange('member', ['notes']);
    const headers = asToken(token);

    // Every read and standard mutation route stays closed to a notes extension token.
    for (const closedPath of [
      'notes/list',
      'notes/get',
      'notes/search',
      'notes/panel',
      'notes/exportMine',
      'notes/create',
      'notes/todos/list',
      'notes/todos/get',
      'notes/todos/create',
      'notes/todos/myWork',
      'meetings/create',
    ]) {
      const res = await rpc(closedPath, headers, {});
      expect(res.status, closedPath).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    }

    // Unsafe URL schemes and embedded credentials are rejected cleanly.
    for (const badUrl of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'chrome://settings',
      'file:///etc/passwd',
      'https://user:pass@example.com/secret',
    ]) {
      const badNote = await rpc('notes/clip', headers, { title: 'Bad', sourceUrl: badUrl });
      expect(badNote.status, badUrl).toBe(400);
      const badTodo = await rpc('notes/todos/quickCapture', headers, { title: 'Bad', sourceUrl: badUrl });
      expect(badTodo.status, badUrl).toBe(400);
    }

    // Viewer cannot authorize an extension or execute clip commands.
    const viewerAuth = await app.request('/api/extension/authorize', {
      method: 'POST',
      headers: await asBrowser('viewer'),
      body: JSON.stringify({ extensionId: EXT_ID, codeChallenge: challengeOf('w'.repeat(43)), codeChallengeMethod: 'S256', scopes: ['notes'], deviceName: 'Chrome' }),
    });
    expect(viewerAuth.status).toBe(403);

    // Agents are strictly refused from extension clip / quick capture commands.
    await expect(
      runtime.execute('notes.note.clip', { title: 'Agent try', body: 'no' }, { actor: { type: 'agent', agentId: randomUUID(), runId: randomUUID() }, orgId }),
    ).rejects.toBeInstanceOf(DomainError);
    await expect(
      runtime.execute('notes.todo.quick_capture', { title: 'Agent todo' }, { actor: { type: 'agent', agentId: randomUUID(), runId: randomUUID() }, orgId }),
    ).rejects.toBeInstanceOf(DomainError);

    // Org switching Notes app OFF blocks authorize (404) and turns features.notes to false.
    const ownerHeaders = await asBrowser('owner', slug, true);
    const offRes = await rpc('org/setApp', ownerHeaders, { module: 'notes', enabled: false });
    expect(offRes.status).toBe(200);
    try {
      const deniedAuth = await app.request('/api/extension/authorize', {
        method: 'POST',
        headers: await asBrowser('member'),
        body: JSON.stringify({ extensionId: EXT_ID, codeChallenge: challengeOf('z'.repeat(43)), codeChallengeMethod: 'S256', scopes: ['notes'], deviceName: 'Chrome' }),
      });
      expect(deniedAuth.status).toBe(404);
      const meWhileOff = await app.request('/api/extension/me', { headers: { authorization: `Bearer ${token}` } });
      expect((await meWhileOff.json()) as Record<string, unknown>).toMatchObject({ features: { notes: false } });
    } finally {
      await rpc('org/setApp', ownerHeaders, { module: 'notes', enabled: true });
    }
  });
});
