// SPDX-License-Identifier: AGPL-3.0-only
// A customer's photo to a Telegram bot as an image in Hộp thư, on PostgreSQL 17 (issue #3192, plan docs/plan/conversations-channels.md section 4.2): the route parks
// the update, the worker stores the message with a pending image row that holds the photo's file id (a reference: no address, no token), the media job opens the
// connection's sealed token inside the job, asks `getFile` and fetches the file from the Bot API host, and the bytes are stored as the message's image. The bot's
// token and the file's address live in that job only: nothing the database holds ever names them. Business chats work the same. Set CROVE_TEST_ADMIN_URL to a
// superuser URL; each run makes its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TELEGRAM_HOOK_KEY_INFO, TELEGRAM_MEDIA_HOSTS, TelegramPublisher, TelegramConversations, telegramHookSecret, type ConversationAdapter, type ConversationMediaInput, type Fetch } from '@crove/channel';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { CredentialVault, Runtime, parseVaultKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { dueConversationAttachments, requestConversationAttachments, runConversationAttachment, runConversationIntake, runTelegramChatHook } from '../src/conversations-worker.ts';
import { createHttpApp } from '../src/http.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SECRET = 'test-only-jwt-secret-for-telegram-photos-0123456789-abcdef';
const SYSTEM = { type: 'system' as const, component: 'conversations' };
const BASE = '/api/channels/telegram/webhook';
const TOKEN = '555555555:EEHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw5';
// The part of the token that is secret (the bot id before the colon is public), taken from the token itself so no second literal of it is kept.
const TOKEN_SECRET = TOKEN.slice(TOKEN.indexOf(':') + 1);
const APP_URL = 'https://ludy.example.com';
const CONN = 'PhOtO-123_abc=';
const OWNER_TG = 900;
// A file id as Telegram makes one: base64url, opaque. Two sizes of one photo, and the path getFile answers for the bigger.
const SMALL_ID = 'AgACAgIAAxkBAAIPhotoSmall_0123456789abcdef';
const BIG_ID = 'AgACAgIAAxkBAAIPhotoBig_0123456789abcdefXYZ';
const FILE_PATH = 'photos/file_77.jpg';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0, 0, 0, 0, 0, 0, 0]);

class MemoryStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return `content:${sha256Hex(bytes)}`;
  }
  async get(key: string) {
    const b = this.blobs.get(key);
    if (!b) throw new Error('missing blob');
    return b;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
}

suite('Telegram photos as images on PostgreSQL (#3192)', () => {
  const dbName = `crove_test_telegram_photos_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  const store = new MemoryStore();
  let app: ReturnType<typeof createHttpApp>;
  let worker: Runtime;
  let workerDb: Db;
  let api: Runtime;
  let vault: CredentialVault;
  let orgId = '';
  let ownerId = '';
  let connectionId = '';
  let hook = '';
  let updateId = 9000;
  const nowSec = () => Math.floor(Date.now() / 1000);

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
  const derived = () => vault.deriveKeys(TELEGRAM_HOOK_KEY_INFO).map((k) => k.key);
  const post = (body: string) => app.request(`${BASE}/${hook}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': telegramHookSecret(derived()[0] as Buffer, hook) }, body });
  const intake = () => runConversationIntake({ workerDb, runtime: worker });
  const asOwner = () => ({ actor: { type: 'user' as const, userId: ownerId, aal: 'aal1' as const }, orgId });
  const photos = [
    { file_id: SMALL_ID, file_unique_id: 'us', width: 90, height: 67, file_size: 1200 },
    { file_id: BIG_ID, file_unique_id: 'ub', width: 1280, height: 960, file_size: 180_000 },
  ];
  // A photo (or any other message body) from a customer in a bot chat.
  const botChat = (over: Record<string, unknown>, o: { chat: number; messageId: number }) =>
    JSON.stringify({ update_id: updateId++, message: { message_id: o.messageId, from: { id: o.chat, is_bot: false, first_name: 'Khách' }, chat: { id: o.chat, type: 'private' }, date: nowSec(), ...over } });
  const businessChat = (over: Record<string, unknown>, o: { chat: number; messageId: number; own?: boolean; field?: string }) =>
    JSON.stringify({
      update_id: updateId++,
      [o.field ?? 'business_message']: {
        message_id: o.messageId,
        business_connection_id: CONN,
        from: o.own ? { id: OWNER_TG, is_bot: false, first_name: 'Lan' } : { id: o.chat, is_bot: false, first_name: 'Khách' },
        chat: { id: o.chat, first_name: 'Khách', type: 'private' },
        date: nowSec(),
        ...over,
      },
    });
  const pending = () =>
    rows<{ id: string; state: string; kind: string; source_url: string | null; source_ref: string | null; storage_key: string; message_id: string }>(
      'SELECT id, state, kind, source_url, source_ref, storage_key, message_id FROM crove_kernel.conversation_attachment WHERE org_id = $1 ORDER BY created_at, id',
      [orgId],
    );
  const bodyOf = async (externalId: string) => (await rows<{ body: string }>('SELECT body FROM crove_kernel.conversation_message WHERE org_id = $1 AND external_message_id = $2', [orgId, externalId]))[0]?.body;

  // Every text, json and bytea column of every table in the database that holds `needle`, so a secret that was stored there shows up wherever it is (arrays and other
  // types are not scanned).
  const whereIs = (needle: string) =>
    admin(async (c) => {
      const columns = (
        await c.query<{ table_schema: string; table_name: string; column_name: string; data_type: string }>(
          `SELECT c.table_schema, c.table_name, c.column_name, c.data_type FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
           WHERE t.table_type = 'BASE TABLE' AND c.table_schema NOT IN ('pg_catalog', 'information_schema') AND c.data_type IN ('text', 'jsonb', 'json', 'character varying', 'bytea')`,
        )
      ).rows;
      const found: string[] = [];
      for (const col of columns) {
        // A bytea column is searched for the needle's UTF-8 bytes (cast to text it is hex, which a plain needle never matches).
        const test = col.data_type === 'bytea' ? `position(convert_to($1::text, 'UTF8') in "${col.column_name}") > 0` : `"${col.column_name}"::text LIKE '%' || $1::text || '%'`;
        const hit = await c.query(`SELECT 1 FROM "${col.table_schema}"."${col.table_name}" WHERE ${test} LIMIT 1`, [needle]);
        if (hit.rowCount) found.push(`${col.table_schema}.${col.table_name}.${col.column_name}`);
      }
      return found;
    });

  // The Bot API, answered from memory: `getFile` with the path, then the file. `fetched` is every address the media call asked for, in order.
  function botApi(over: { getFile?: { status?: number; body: unknown }; file?: { status?: number; bytes: Uint8Array } } = {}) {
    const fetched: Array<{ method: string; url: string }> = [];
    const fetchImpl: Fetch = async (input, init) => {
      fetched.push({ method: init?.method ?? 'GET', url: input });
      if (input.endsWith('/getFile')) {
        const a = over.getFile ?? { body: { ok: true, result: { file_id: BIG_ID, file_unique_id: 'ub', file_size: 180_000, file_path: FILE_PATH } } };
        return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } });
      }
      const f: { status?: number; bytes: Uint8Array } = over.file ?? { bytes: PNG };
      return new Response(f.bytes as Uint8Array<ArrayBuffer>, { status: f.status ?? 200 });
    };
    return { fetched, fetchImpl };
  }
  // The job as the worker runs it: the real adapter, with the guarded fetch the job would hand it replaced by the in-memory Bot API (the guard itself is the
  // kernel-runtime's, tested there and in conversation-media-ref.test.ts), and the host list and opened credential as the job gives them.
  function fetchOne(attachmentId: string, api: ReturnType<typeof botApi>) {
    const given: Array<{ externalAccountId: string; secret: string; mediaRef: string; hosts: readonly string[]; maxBytes: number }> = [];
    const real = new TelegramConversations();
    const adapter: ConversationAdapter = {
      provider: 'telegram',
      reply: async () => ({ kind: 'unknown' }),
      media: (input: ConversationMediaInput) => {
        given.push({ externalAccountId: input.externalAccountId, secret: input.secret, mediaRef: input.mediaRef, hosts: input.hosts, maxBytes: input.maxBytes });
        return real.media({ ...input, fetch: api.fetchImpl });
      },
    };
    return runConversationAttachment({ runtime: worker, store, broker: vault, adapter: (p: string) => (p === 'telegram' ? adapter : undefined) }, { orgId, connectionId, action: 'attachment', attachmentId }).then((outcome) => ({ outcome, given }));
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
    const pool = createPool({ connectionString: appUrl.toString(), max: 4 });
    pools.push(pool);
    const db = createDb(pool);
    const registered = { commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: null })] };
    api = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registered);
    vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
    const config = loadConfig({ DATABASE_URL: appUrl.toString(), AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: 'crove-auth', AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    app = createHttpApp({ config, runtime: api, store, authenticate: createAuthenticator(config, db), pool, aiEnabled: false, telegramWebhook: { keys: derived } });
    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'crove_worker';
    workerUrl.password = 'test-worker-pw';
    const workerPool = createPool({ connectionString: workerUrl.toString(), max: 2 });
    pools.push(workerPool);
    workerDb = createDb(workerPool);
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(registered);

    ownerId = (await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@telegram-photos.test`, name: null })) as string;
    orgId = (await createOrg(api, { type: 'user', userId: ownerId, aal: 'aal1' }, 'Công ty Ảnh')).orgId;
    const channel = '-1005555555555';
    const sealed = vault.seal(JSON.stringify({ botToken: TOKEN, username: null }), { orgId, provider: 'telegram', externalAccountId: channel });
    connectionId = (
      await api.execute<{ connectionId: string }>(
        'kernel.channel.connect',
        { provider: 'telegram', externalAccountId: channel, displayName: 'Kênh thử', scopes: [], expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
        asOwner(),
      )
    ).connectionId;
    await api.execute('kernel.channel.telegram_chat_set', { connectionId, on: true }, asOwner());
    const hookCalls: string[] = [];
    const hookFetch: Fetch = async (input) => {
      hookCalls.push(input);
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const adapter = new TelegramPublisher(undefined, new TelegramConversations({ fetch: hookFetch })).conversations;
    expect(await runTelegramChatHook({ runtime: worker, broker: vault, adapter: (p: string) => (p === 'telegram' ? adapter : undefined), baseUrl: APP_URL }, { orgId, connectionId, action: 'chat', on: true })).toBe('on');
    hook = ((await rows<{ chat_hook: string }>('SELECT chat_hook FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2', [orgId, connectionId]))[0] as { chat_hook: string }).chat_hook;
  });

  afterAll(async () => {
    for (const p of pools) await p.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('keeps a photo to the bot as a message with a pending image row that holds the largest size\'s file id and no address, handed to the job by ids only', async () => {
    expect((await post(botChat({ caption: 'Cái áo này còn không shop?', photo: photos }, { chat: 3101, messageId: 11 }))).status).toBe(200);
    expect(await intake()).toEqual({ stored: 1, dropped: 0 });
    // The message says its caption; the image is a row of its own, named by the file id of the larger size.
    expect(await bodyOf('3101:11')).toBe('Cái áo này còn không shop?');
    const [row] = await pending();
    expect(row).toMatchObject({ state: 'pending', kind: 'direct', source_url: null, source_ref: BIG_ID });
    expect(await rows('SELECT 1 FROM crove_kernel.conversation_attachment WHERE org_id = $1 AND source_ref = $2', [orgId, SMALL_ID])).toHaveLength(0);
    // The relay hands the row out by ids; the queued event and the audit log hold no file id and no token.
    expect(await dueConversationAttachments(workerDb)).toEqual(expect.arrayContaining([{ orgId, connectionId, attachmentId: (row as { id: string }).id }]));
    expect(await requestConversationAttachments(worker, [{ orgId, attachmentId: (row as { id: string }).id }])).toBe(1);
    for (const needle of [BIG_ID, SMALL_ID, TOKEN_SECRET, FILE_PATH]) {
      expect((await rows('SELECT 1 FROM crove_kernel.outbox_event WHERE payload::text LIKE $1', [`%${needle}%`])).length).toBe(0);
      expect((await rows('SELECT 1 FROM crove_kernel.audit_event WHERE detail::text LIKE $1', [`%${needle}%`])).length).toBe(0);
    }
    // Until the job has run, the file id is in exactly one place: the pending row's reference (which also shows that the scan the next test relies on finds what is there).
    expect(await whereIs(BIG_ID)).toEqual(['crove_kernel.conversation_attachment.source_ref']);
    expect(await whereIs(TOKEN_SECRET)).toEqual([]);
    // The job reads the source (a reference, not an address) for the Telegram connection.
    expect(await worker.query('kernel.conversation.attachment_source', { attachmentId: (row as { id: string }).id }, { actor: SYSTEM, orgId })).toMatchObject({ provider: 'telegram', sourceUrl: null, mediaRef: BIG_ID });
  });

  it('opens the token inside the job, asks getFile and fetches the file from the Bot API host only, stores the bytes as the message\'s image, and leaves the token, the path and the file id nowhere in the database', async () => {
    const [row] = await pending();
    const bot = botApi();
    const { outcome, given } = await fetchOne((row as { id: string }).id, bot);
    expect(outcome).toBe('stored');
    // The job handed the adapter the opened credential, the reference, the Bot API's host as the only one, and the cap.
    expect(given).toHaveLength(1);
    expect(given[0]).toMatchObject({ externalAccountId: '-1005555555555', mediaRef: BIG_ID, hosts: ['api.telegram.org'], maxBytes: 5 * 1024 * 1024 });
    expect(JSON.parse(given[0]?.secret as string)).toMatchObject({ botToken: TOKEN });
    expect([...TELEGRAM_MEDIA_HOSTS]).toEqual(['api.telegram.org']);
    // Two requests, both to the Bot API's host, the token in the paths and the path Telegram answered in the second.
    expect(bot.fetched).toEqual([
      { method: 'POST', url: `https://api.telegram.org/bot${TOKEN}/getFile` },
      { method: 'GET', url: `https://api.telegram.org/file/bot${TOKEN}/${FILE_PATH}` },
    ]);
    // The row is stored: the reference is cleared, the bytes are in the store under the reserved key, the type and size come from the bytes.
    const after = (await pending())[0] as { id: string; state: string; source_ref: string | null; storage_key: string };
    expect(after).toMatchObject({ state: 'stored', source_ref: null });
    expect(Buffer.from(store.blobs.get(after.storage_key) as Uint8Array).equals(PNG)).toBe(true);
    expect(await rows('SELECT content_type, width, height, size_bytes FROM crove_kernel.conversation_attachment WHERE org_id = $1 AND id = $2', [orgId, after.id])).toEqual([{ content_type: 'image/png', width: 2, height: 3, size_bytes: PNG.byteLength }]);
    // The thread shows the image on its message.
    const thread = (await rows<{ id: string }>('SELECT id FROM crove_kernel.conversation WHERE org_id = $1 AND external_thread_id = $2', [orgId, '3101']))[0] as { id: string };
    const detail = await api.query<{ messages: Array<{ attachments?: unknown[] }> }>('kernel.conversation.get', { conversationId: thread.id }, asOwner());
    expect(detail.messages[0]?.attachments).toEqual([expect.objectContaining({ id: after.id, contentType: 'image/png', width: 2, height: 3 })]);
    // Neither the token, nor the path of the file, nor the file id is in any text column of any table now: the job held them and let them go.
    expect(await whereIs(TOKEN_SECRET)).toEqual([]);
    expect(await whereIs(FILE_PATH)).toEqual([]);
    expect(await whereIs('api.telegram.org/file')).toEqual([]);
    expect(await whereIs(BIG_ID)).toEqual([]);
    // A second job for the stored row does nothing, and asks Telegram for nothing.
    const again = botApi();
    expect((await fetchOne(after.id, again)).outcome).toBe('none');
    expect(again.fetched).toEqual([]);
  });

  it('takes the customer\'s photo of an allowed business account into its thread the same way, and not the account\'s own photo, an edit, a message of an account nobody allowed, or any other kind of file', async () => {
    // The account connects the bot; until an owner allows it nothing of its chats is stored, a photo included.
    expect((await post(JSON.stringify({ update_id: updateId++, business_connection: { id: CONN, user: { id: OWNER_TG, first_name: 'Lan', username: 'lan_tran' }, user_chat_id: OWNER_TG, date: nowSec(), rights: { can_reply: true }, is_enabled: true } }))).status).toBe(200);
    await intake();
    const before = (await pending()).length;
    expect((await post(businessChat({ photo: photos }, { chat: 3201, messageId: 1 }))).status).toBe(200);
    expect(await intake()).toEqual({ stored: 0, dropped: 0 });
    expect(await pending()).toHaveLength(before);
    const list = await api.query<Array<{ id: string; chatBusiness: Array<{ ref: string }> }>>('kernel.channel.list', {}, asOwner());
    const ref = list.find((c) => c.id === connectionId)?.chatBusiness[0]?.ref as string;
    expect(await api.execute('kernel.channel.telegram_business_allow', { connectionId, ref, allow: true }, asOwner())).toEqual({ approved: true });
    // Allowed: the customer's photo is a message with its image row; the account's own photo is a line of what it sent, and an edit adds no image.
    expect((await post(businessChat({ photo: photos }, { chat: 3202, messageId: 2 }))).status).toBe(200);
    expect((await post(businessChat({ photo: photos }, { chat: 3202, messageId: 3, own: true }))).status).toBe(200);
    expect((await post(businessChat({ caption: 'Giá mới', photo: photos }, { chat: 3202, messageId: 2, field: 'edited_business_message' }))).status).toBe(200);
    expect((await post(botChat({ document: { file_id: 'doc-file-id', file_unique_id: 'ud', file_name: 'bang-gia.pdf' } }, { chat: 3203, messageId: 4 }))).status).toBe(200);
    expect((await post(botChat({ photo: [{ file_id: BIG_ID, file_unique_id: 'ub', width: 4000, height: 3000, file_size: 5 * 1024 * 1024 + 1 }] }, { chat: 3204, messageId: 5 }))).status).toBe(200);
    expect((await intake()).dropped).toBe(0);
    const thread = `b:3202:${CONN}`;
    expect(await bodyOf(`${thread}:2`)).toBe('Giá mới');
    expect(await bodyOf(`${thread}:3`)).toBe('[Đã gửi ảnh]');
    const rowsNow = await pending();
    const created = rowsNow.slice(before);
    // Exactly one new image row: the customer's own photo, in the business thread's message, from the file id of the larger size.
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ state: 'pending', kind: 'direct', source_url: null, source_ref: BIG_ID });
    const owner = (await rows<{ external_message_id: string }>('SELECT m.external_message_id FROM crove_kernel.conversation_message m WHERE m.org_id = $1 AND m.id = $2', [orgId, (created[0] as { message_id: string }).message_id]))[0];
    expect(owner?.external_message_id).toBe(`${thread}:2`);
    // A document and a photo over the cap stay placeholder lines and make no image row.
    expect(await bodyOf('3203:4')).toBe('[Khách gửi tệp]');
    expect(await bodyOf('3204:5')).toBe('[Khách gửi ảnh]');
    // The job fetches the business photo exactly as a bot chat's: the business connection id is no part of what is asked of Telegram.
    const bot = botApi();
    expect((await fetchOne((created[0] as { id: string }).id, bot)).outcome).toBe('stored');
    expect(bot.fetched.map((f) => f.url).join(' ')).not.toContain(CONN);
  });

  it('drops a photo Telegram no longer has or the token cannot reach, asks again for a busy Telegram, drops what is not an image, and says so only by a short code that holds no token, path or file id', async () => {
    const make = async (messageId: number) => {
      const before = (await pending()).length;
      expect((await post(botChat({ photo: photos }, { chat: 3300 + messageId, messageId }))).status).toBe(200);
      await intake();
      return ((await pending()).slice(before)[0] as { id: string }).id;
    };
    const failures = [
      [botApi({ getFile: { status: 400, body: { ok: false, error_code: 400, description: `Bad Request: wrong file_id ${BIG_ID}` } } }), 'dropped'],
      [botApi({ getFile: { status: 401, body: { ok: false, error_code: 401, description: `Unauthorized ${TOKEN}` } } }), 'dropped'],
      [botApi({ getFile: { status: 429, body: { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 5 } } } }), 'retry'],
      [botApi({ file: { status: 500, bytes: new Uint8Array(0) } }), 'retry'],
      [botApi({ file: { status: 200, bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>') } }), 'dropped'],
      [botApi({ getFile: { body: { ok: true, result: { file_id: BIG_ID, file_unique_id: 'ub', file_path: '/var/lib/telegram-bot-api/x.jpg' } } } }), 'dropped'],
    ] as const;
    let n = 20;
    for (const [bot, expected] of failures) {
      const id = await make(n++);
      expect((await fetchOne(id, bot)).outcome).toBe(expected);
    }
    // What a failed row leaves in the audit log is its outcome and a short code: never the token, the path of a file, an address, or Telegram's words.
    const audits = await rows<{ detail: { outcome?: string; code?: string } }>("SELECT detail FROM crove_kernel.audit_event WHERE detail->>'outcome' IN ('dropped', 'retry') AND detail ? 'attachment_id'");
    expect(audits.map((a) => `${a.detail.outcome}:${a.detail.code}`)).toEqual(expect.arrayContaining(['dropped:TG_MEDIA_GONE', 'dropped:TELEGRAM_TOKEN_REFUSED', 'retry:TG_MEDIA_BUSY', 'retry:HTTP_500', 'dropped:NOT_AN_IMAGE', 'dropped:TG_MEDIA_PATH']));
    for (const a of audits) expect(a.detail.code).toMatch(/^[A-Za-z0-9_]{1,64}$/);
    expect(await whereIs(TOKEN_SECRET)).toEqual([]);
    expect(await whereIs('Bad Request: wrong file_id')).toEqual([]);
  });
});
