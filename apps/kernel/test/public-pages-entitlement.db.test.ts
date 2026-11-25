// SPDX-License-Identifier: AGPL-3.0-only
// Full HTTP and SQL verification for #3393 (ADR-0053 C2a follow-up): Social and CRM public pages must check BOTH the
// org's own toggle (org_app_on) and billing entitlement (Runtime.appOn), returning the exact same 404 "not found" as
// an unknown key with zero DB writes, zero blob reads and zero org_id leaks when either gate refuses access.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { contentGeneration, Runtime, type BlobStore } from '@ludy/kernel-runtime';
import { crmCommands, crmQueries } from '@ludy/mod-crm';
import { socialCommands, socialQueries } from '@ludy/mod-social';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const VN = 'Asia/Ho_Chi_Minh';
const DAY = 86_400_000;
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3]);

const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

class SpyMemoryStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  getCount = 0;

  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return contentGeneration(sha256Hex(bytes));
  }

  async get(key: string) {
    this.getCount += 1;
    const found = this.blobs.get(key);
    if (!found) throw new Error(`missing blob: ${key}`);
    return found;
  }

  async delete(key: string) {
    this.blobs.delete(key);
  }
}

function futureWeekdayAt(daysAhead: number, minutesUtcPlus7: number): string {
  const base = new Date(Date.now() + daysAhead * DAY);
  const y = base.getUTCFullYear();
  const m = String(base.getUTCMonth() + 1).padStart(2, '0');
  const d = String(base.getUTCDate()).padStart(2, '0');
  const hh = String(Math.floor(minutesUtcPlus7 / 60)).padStart(2, '0');
  const mm = String(minutesUtcPlus7 % 60).padStart(2, '0');
  return new Date(`${y}-${m}-${d}T${hh}:${mm}:00+07:00`).toISOString();
}

function dayBounds(daysAhead: number): { from: string; to: string } {
  const base = new Date(Date.now() + daysAhead * DAY);
  const y = base.getUTCFullYear();
  const m = String(base.getUTCMonth() + 1).padStart(2, '0');
  const d = String(base.getUTCDate()).padStart(2, '0');
  const start = new Date(`${y}-${m}-${d}T00:00:00+07:00`);
  return { from: start.toISOString(), to: new Date(start.getTime() + DAY).toISOString() };
}

suite('public pages entitlement check across Social and CRM (#3393)', () => {
  const dbName = `ludy_test_public_entitlement_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let store: SpyMemoryStore;
  let adminRt: Runtime;
  let workerRt: Runtime;
  let httpConfig: ReturnType<typeof loadConfig>;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const systemActor = { type: 'system' as const, component: 'worker' };
  const unknownToken = 'u'.repeat(43);

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  function makeHttp(entitled: readonly string[]) {
    const rt = new Runtime(db, {
      manifests: TEST_MANIFESTS,
      entitlements: async () => entitled,
    }).register({
      commands: [...kernelCommands, ...socialCommands, ...crmCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries, ...crmQueries],
    });
    const app = createHttpApp({
      config: httpConfig,
      runtime: rt,
      store,
      authenticate: createAuthenticator(httpConfig, db),
      pool,
      aiEnabled: false,
    });
    return { rt, app };
  }

  async function postJson(app: ReturnType<typeof createHttpApp>, path: string, body: unknown) {
    return app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function seedOrgWithPublicSurface() {
    const person = (tag: string) =>
      upsertIdentity(db, {
        issuer: 'test',
        subject: randomUUID(),
        email: `${tag}-${randomUUID().slice(0, 8)}@pub3393.test`,
        name: null,
      });
    const owner = await person('owner');
    const host = await person('host');
    const { orgId } = await createOrg(adminRt, asUser(owner), `Cửa hàng ${randomUUID().slice(0, 6)}`);
    await admin((c) => c.query("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin')", [orgId, host]));
    const slug = (await admin((c) => c.query<{ slug: string }>('SELECT slug FROM ludy_kernel.tenant WHERE org_id = $1', [orgId]))).rows[0]!.slug;

    // Seed library images (source 'social') for review media, bio avatar, bio post image and quote letterhead logo.
    const insertFile = async (bytes: Uint8Array, contentType: 'image/png' | 'image/jpeg', filename: string) => {
      const id = randomUUID();
      const sha = sha256Hex(bytes);
      const storageKey = `org/${orgId}/${sha}`;
      const generation = await store.put(storageKey, bytes);
      await admin((c) =>
        c.query(
          `INSERT INTO ludy_kernel.file (org_id, id, sha256, storage_key, generation, filename, content_type, size_bytes, source, image_width, image_height)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'social', 120, 40)`,
          [orgId, id, sha, storageKey, generation, filename, contentType, bytes.byteLength],
        ),
      );
      return id;
    };

    const reviewFileId = await insertFile(new Uint8Array([...JPEG_BYTES, 1]), 'image/jpeg', 'review.jpg');
    const bioAvatarFileId = await insertFile(new Uint8Array([...PNG_BYTES, 1]), 'image/png', 'avatar.png');
    const bioPostFileId = await insertFile(new Uint8Array([...JPEG_BYTES, 2]), 'image/jpeg', 'bio-post.jpg');
    const quoteLogoFileId = await insertFile(new Uint8Array([...PNG_BYTES, 2]), 'image/png', 'logo.png');

    // Social channel + posts.
    const conn = randomUUID();
    await admin((c) =>
      c.query(
        'INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)',
        [orgId, conn, 'sandbox', `acct-${conn.slice(0, 8)}`, 'Fanpage Thử', owner],
      ),
    );
    const { postId: reviewPostId } = await adminRt.execute<{ postId: string }>(
      'social.post.create',
      { body: 'Bài cần duyệt #3393', media: [{ fileId: reviewFileId }], channels: [{ connectionId: conn }] },
      { actor: asUser(owner), orgId },
    );
    const reviewSingle = await adminRt.execute<{ token: string; linkId: string }>(
      'social.review_link.create',
      { postId: reviewPostId },
      { actor: asUser(owner), orgId },
    );

    const { postId: planPostId } = await adminRt.execute<{ postId: string }>(
      'social.post.create',
      { body: 'Bài kế hoạch #3393', scheduledAt: futureWeekdayAt(3, 600), channels: [{ connectionId: conn }] },
      { actor: asUser(owner), orgId },
    );
    const reviewPlan = await adminRt.execute<{ token: string; linkId: string }>(
      'social.review_link.create_plan',
      { postIds: [planPostId] },
      { actor: asUser(owner), orgId },
    );

    const reportLink = await adminRt.execute<{ token: string; linkId: string }>(
      'social.report_link.create',
      {
        periodStart: '2026-10-01T00:00:00+07:00',
        periodEnd: '2026-11-01T00:00:00+07:00',
        connectionIds: [conn],
        title: 'Báo cáo #3393',
      },
      { actor: asUser(owner), orgId },
    );

    const { postId: publishedPostId } = await adminRt.execute<{ postId: string }>(
      'social.post.create',
      { body: 'Bài đã đăng lên bio #3393', linkUrl: 'https://shop.example/bai-viet-3393', media: [{ fileId: bioPostFileId }], channels: [{ connectionId: conn }] },
      { actor: asUser(owner), orgId },
    );
    const publishedVariantId = (
      await admin((c) => c.query<{ id: string }>("UPDATE ludy_social.post_variant SET status = 'published', published_at = now() WHERE post_id = $1 RETURNING id", [publishedPostId]))
    ).rows[0]!.id;

    const shortCode = `Ab${randomBytes(6).toString('hex').slice(0, 10)}`;
    const shortTargetUrl = 'https://shop.example/uu-dai-3393';
    const shortLinkId = (
      await admin((c) =>
        c.query<{ id: string }>(
          'INSERT INTO ludy_social.short_link (org_id, code, variant_id, revision, post_id, target_url) VALUES ($1, $2, $3, 1, $4, $5) RETURNING id',
          [orgId, shortCode, publishedVariantId, publishedPostId, shortTargetUrl],
        ),
      )
    ).rows[0]!.id;

    const bioSlug = `bio-${randomUUID().slice(0, 8)}`;
    const bioTargetUrl = 'https://shop.example/mua-ngay';
    await adminRt.execute(
      'social.bio.save',
      {
        slug: bioSlug,
        title: 'Tiệm #3393',
        about: 'Mô tả cửa hàng',
        avatarFileId: bioAvatarFileId,
        buttons: [{ label: 'Mua ngay', url: bioTargetUrl }],
        showPosts: true,
        published: true,
      },
      { actor: asUser(owner), orgId },
    );

    const { postId: scheduledCalPostId } = await adminRt.execute<{ postId: string }>(
      'social.post.create',
      { body: 'Bài lịch đăng #3393', channels: [{ connectionId: conn }] },
      { actor: asUser(owner), orgId },
    );
    await admin((c) => c.query("UPDATE ludy_social.post_variant SET status = 'scheduled', scheduled_at = now() + interval '2 days' WHERE post_id = $1", [scheduledCalPostId]));
    const socialCalFeed = await adminRt.execute<{ token: string }>('social.calendar_feed.create', {}, { actor: asUser(owner), orgId });

    // CRM booking setup: hours, event type, one confirmed booking (to inspect/manage), and a free slot on the same day.
    await adminRt.execute('kernel.calendar.hours.save', { timeZone: VN, windows: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: 0, end: 1440 })) }, { actor: asUser(host), orgId });
    const bookingTypeSlug = 'tu-van';
    const eventType = await adminRt.execute<{ id: string }>(
      'crm.event_type.create',
      {
        slug: bookingTypeSlug,
        title: 'Tư vấn #3393',
        description: null,
        durationMin: 30,
        bufferBeforeMin: 0,
        bufferAfterMin: 0,
        minNoticeMin: 0,
        horizonDays: 60,
        dailyLimit: null,
        locationKind: 'video',
        locationValue: 'https://meet.example.test/3393',
        hostUserId: host,
      },
      { actor: asUser(host), orgId },
    );

    const bookingDaysAhead = 4;
    const confirmedStart = futureWeekdayAt(bookingDaysAhead, 540);
    const freeSlotStart = futureWeekdayAt(bookingDaysAhead, 720);
    const bookingRange = dayBounds(bookingDaysAhead);

    // Seed one confirmed booking + requestToken + manageToken via the HTTP booking flow while entitled.
    const { app: setupHttp } = makeHttp(['social', 'crm']);
    const seededReqRes = await postJson(setupHttp, `/api/booking/${slug}/${bookingTypeSlug}`, {
      startsAt: confirmedStart,
      name: 'Khách Hẹn Trước',
      email: 'khach-truoc@example.test',
      timeZone: VN,
    });
    expect(seededReqRes.status).toBe(202);
    const seededReqBody = (await seededReqRes.json()) as { token: string };
    const bookingRow = (await admin((c) => c.query<{ id: string }>('SELECT id FROM ludy_crm.booking WHERE org_id = $1 ORDER BY created_at DESC LIMIT 1', [orgId]))).rows[0]!;
    await workerRt.execute('crm.booking.confirm', { bookingId: bookingRow.id }, { actor: systemActor, orgId });
    const manageData = await workerRt.execute<{ token: string | null }>('crm.booking.mail_data', { bookingId: bookingRow.id, revision: 0 }, { actor: systemActor, orgId });
    const bookingManageToken = manageData.token as string;
    const bookingFeed = await adminRt.execute<{ token: string }>('crm.booking_feed.create', {}, { actor: asUser(host), orgId });

    // CRM quote setup: logo, party, deal, quote sent via link, quote link token.
    await adminRt.execute('crm.quote_setting.logo_set', { fileId: quoteLogoFileId }, { actor: asUser(owner), orgId });
    const party = await adminRt.execute<{ partyId: string }>('kernel.party.create', { kind: 'organization', name: 'Công ty Khách #3393', email: 'buyer@example.test' }, { actor: asUser(owner), orgId });
    const deal = await adminRt.execute<{ id: string }>('crm.deal.create', { partyId: party.partyId, title: 'Cơ hội #3393', amount: '1000000', expectedClose: null }, { actor: asUser(owner), orgId });
    const draftQuote = await adminRt.execute<{ id: string; version: number }>(
      'crm.quote.save',
      { dealId: deal.id, lines: [{ kind: 'item', description: 'Gói tư vấn', unit: 'gói', quantity: '1', unitPrice: '1000000', vatRate: '10%' }] },
      { actor: asUser(owner), orgId },
    );
    const sentQuote = await adminRt.execute<{ quote: { id: string } }>('crm.quote.send', { quoteId: draftQuote.id, version: draftQuote.version, via: 'link' }, { actor: asUser(owner), orgId });
    const quoteLink = await adminRt.execute<{ linkId: string; token: string }>('crm.quote.create_link', { quoteId: sentQuote.quote.id }, { actor: asUser(owner), orgId });

    return {
      orgId,
      slug,
      owner,
      host,
      conn,
      reviewSingle,
      reviewPlan,
      reviewPostId,
      planPostId,
      reviewFileId,
      reportLink,
      shortCode,
      shortLinkId,
      shortTargetUrl,
      bioSlug,
      bioAvatarFileId,
      bioPostId: publishedPostId,
      bioPostFileId,
      bioTargetUrl,
      socialCalToken: socialCalFeed.token,
      eventTypeId: eventType.id,
      bookingTypeSlug,
      bookingRange,
      freeSlotStart,
      confirmedStart,
      confirmedBookingId: bookingRow.id,
      bookingRequestToken: seededReqBody.token,
      bookingManageToken,
      crmFeedToken: bookingFeed.token,
      quoteId: sentQuote.quote.id,
      quoteLinkId: quoteLink.linkId,
      quoteToken: quoteLink.token,
      quoteLogoFileId,
    };
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
    pool = createPool({ connectionString: appUrl.toString(), max: 6 });

    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'ludy_worker';
    workerUrl.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: workerUrl.toString(), max: 2 });

    db = createDb(pool);
    store = new SpyMemoryStore();
    const registry = {
      commands: [...kernelCommands, ...socialCommands, ...crmCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries, ...crmQueries],
    };
    adminRt = new Runtime(db, { manifests: TEST_MANIFESTS, entitlements: async () => ['social', 'crm'] }).register(registry);
    workerRt = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registry);

    httpConfig = loadConfig({
      DATABASE_URL: appUrl.toString(),
      AUTH_JWT_SECRET: 'test-only-jwt-secret-for-public-entitlement-0123456',
      AUTH_ISSUER: 'ludy-auth',
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
      PUBLIC_URL: 'http://localhost:8080/',
    });
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('enforces ludy_social.public_page_org and ludy_crm.public_page_org privileges, hardening, and lookup parity', async () => {
    const f = await seedOrgWithPublicSurface();

    // 1. Only ludy_app holds EXECUTE (besides postgres); all other runtime/public/tenant roles are denied.
    const fns = ['ludy_social.public_page_org(text,text)', 'ludy_crm.public_page_org(text,text)'];
    const roles = ['ludy_app', 'ludy_worker', 'ludy_tenant', 'ludy_definer_tenant', 'ludy_prober', 'ludy_reporter', 'ludy_auth_reader', 'public'];
    const matrix = await admin(async (c) => {
      const { rows } = await c.query<{ fn: string; role: string; can: boolean }>(
        `SELECT f AS fn, r AS role, has_function_privilege(r, f, 'EXECUTE') AS can FROM unnest($1::text[]) f CROSS JOIN unnest($2::text[]) r`,
        [fns, roles],
      );
      return Object.fromEntries(fns.map((fn) => [fn, roles.filter((r) => rows.some((row) => row.fn === fn && row.role === r && row.can))]));
    });
    expect(matrix).toEqual({
      'ludy_social.public_page_org(text,text)': ['ludy_app'],
      'ludy_crm.public_page_org(text,text)': ['ludy_app'],
    });
    await expect(workerPool.query("SELECT ludy_social.public_page_org('bio', $1)", [f.bioSlug])).rejects.toMatchObject({ code: '42501' });
    await expect(workerPool.query("SELECT ludy_crm.public_page_org('quote_link', $1)", [f.quoteToken])).rejects.toMatchObject({ code: '42501' });

    // 2. Definers are STABLE SECURITY DEFINER with search_path = pg_catalog, pg_temp.
    const meta = await admin(async (c) =>
      (
        await c.query<{ nspname: string; proname: string; prosecdef: boolean; provolatile: string; proconfig: string[] | null }>(
          `SELECT n.nspname, p.proname, p.prosecdef, p.provolatile::text AS provolatile, p.proconfig
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname IN ('ludy_social', 'ludy_crm') AND p.proname = 'public_page_org'
           ORDER BY 1`,
        )
      ).rows,
    );
    expect(meta).toEqual([
      { nspname: 'ludy_crm', proname: 'public_page_org', prosecdef: true, provolatile: 's', proconfig: ['search_path=pg_catalog, pg_temp'] },
      { nspname: 'ludy_social', proname: 'public_page_org', prosecdef: true, provolatile: 's', proconfig: ['search_path=pg_catalog, pg_temp'] },
    ]);

    const socialOrg = async (kind: string | null, key: string | null) =>
      (await pool.query<{ id: string | null }>('SELECT ludy_social.public_page_org($1, $2) AS id', [kind, key])).rows[0]?.id ?? null;
    const crmOrg = async (kind: string | null, key: string | null) =>
      (await pool.query<{ id: string | null }>('SELECT ludy_crm.public_page_org($1, $2) AS id', [kind, key])).rows[0]?.id ?? null;

    // 3. Unknown or NULL p_kind raises 22023.
    await expect(socialOrg('unknown', f.bioSlug)).rejects.toMatchObject({ code: '22023' });
    await expect(socialOrg(null, f.bioSlug)).rejects.toMatchObject({ code: '22023' });
    await expect(crmOrg('unknown', f.quoteToken)).rejects.toMatchObject({ code: '22023' });
    await expect(crmOrg(null, f.quoteToken)).rejects.toMatchObject({ code: '22023' });

    // 4. All valid Social & CRM kinds resolve the owning org while active and app-on.
    expect(await socialOrg('review_link', f.reviewSingle.token)).toBe(f.orgId);
    expect(await socialOrg('review_link', f.reviewPlan.token)).toBe(f.orgId);
    expect(await socialOrg('report_link', f.reportLink.token)).toBe(f.orgId);
    expect(await socialOrg('short_link', f.shortCode)).toBe(f.orgId);
    expect(await socialOrg('bio', f.bioSlug)).toBe(f.orgId);
    expect(await socialOrg('calendar_feed', f.socialCalToken)).toBe(f.orgId);

    expect(await crmOrg('booking_page', `${f.slug}/${f.bookingTypeSlug}`)).toBe(f.orgId);
    expect(await crmOrg('booking_manage', `${f.slug}/${f.bookingTypeSlug}/${f.bookingManageToken}`)).toBe(f.orgId);
    expect(await crmOrg('booking_feed', f.crmFeedToken)).toBe(f.orgId);
    expect(await crmOrg('quote_link', f.quoteToken)).toBe(f.orgId);

    // 5. Invalid/malformed keys return NULL cleanly (never leak or throw).
    expect(await socialOrg('review_link', 'short')).toBeNull();
    expect(await socialOrg('review_link', null)).toBeNull();
    expect(await socialOrg('short_link', 'bad!code')).toBeNull();
    expect(await socialOrg('bio', 'A')).toBeNull();
    expect(await crmOrg('booking_page', 'only-one-part')).toBeNull();
    expect(await crmOrg('booking_page', null)).toBeNull();
    expect(await crmOrg('booking_manage', `${f.slug}/${f.bookingTypeSlug}/bad-mac`)).toBeNull();
    expect(await crmOrg('quote_link', 'short')).toBeNull();

    // 6. org_app_on(social = false) stops all Social kinds while CRM stays active, and vice versa.
    await adminRt.execute('kernel.org.set_app', { module: 'social', enabled: false }, { actor: asUser(f.owner), orgId: f.orgId, idempotencyKey: randomUUID() });
    expect(await socialOrg('review_link', f.reviewSingle.token)).toBeNull();
    expect(await socialOrg('report_link', f.reportLink.token)).toBeNull();
    expect(await socialOrg('short_link', f.shortCode)).toBeNull();
    expect(await socialOrg('bio', f.bioSlug)).toBeNull();
    expect(await socialOrg('calendar_feed', f.socialCalToken)).toBeNull();
    expect(await crmOrg('quote_link', f.quoteToken)).toBe(f.orgId);

    await adminRt.execute('kernel.org.set_app', { module: 'social', enabled: true }, { actor: asUser(f.owner), orgId: f.orgId, idempotencyKey: randomUUID() });
    await adminRt.execute('kernel.org.set_app', { module: 'crm', enabled: false }, { actor: asUser(f.owner), orgId: f.orgId, idempotencyKey: randomUUID() });
    expect(await crmOrg('booking_page', `${f.slug}/${f.bookingTypeSlug}`)).toBeNull();
    expect(await crmOrg('booking_manage', `${f.slug}/${f.bookingTypeSlug}/${f.bookingManageToken}`)).toBeNull();
    expect(await crmOrg('booking_feed', f.crmFeedToken)).toBeNull();
    expect(await crmOrg('quote_link', f.quoteToken)).toBeNull();
    expect(await socialOrg('bio', f.bioSlug)).toBe(f.orgId);

    // 7. Archiving the event_type stops booking_page while booking_manage stays resolvable when crm app is back on.
    await adminRt.execute('kernel.org.set_app', { module: 'crm', enabled: true }, { actor: asUser(f.owner), orgId: f.orgId, idempotencyKey: randomUUID() });
    await adminRt.execute('crm.event_type.set_active', { eventTypeId: f.eventTypeId, active: false }, { actor: asUser(f.host), orgId: f.orgId });
    expect(await crmOrg('booking_page', `${f.slug}/${f.bookingTypeSlug}`)).toBeNull();
    expect(await crmOrg('booking_manage', `${f.slug}/${f.bookingTypeSlug}/${f.bookingManageToken}`)).toBe(f.orgId);

    // 8. Disabling the booking feed owner's user_account stops booking_feed, and closing the tenant stops everything.
    await admin((c) => c.query('UPDATE ludy_kernel.user_account SET disabled_at = now() WHERE id = $1', [f.host]));
    expect(await crmOrg('booking_feed', f.crmFeedToken)).toBeNull();
    await admin((c) => c.query("UPDATE ludy_kernel.tenant SET status = 'closed' WHERE org_id = $1", [f.orgId]));
    expect(await socialOrg('bio', f.bioSlug)).toBeNull();
    expect(await crmOrg('quote_link', f.quoteToken)).toBeNull();
  });

  it('blocks every Social and CRM HTTP endpoint identically to 404 with zero writes or leaks when org_app_on is true but unentitled', async () => {
    const f = await seedOrgWithPublicSurface();
    const { app: httpNone } = makeHttp([]);
    const { app: httpCrmOnly } = makeHttp(['crm']);
    const { app: httpSocialOnly } = makeHttp(['social']);
    const { app: httpFull } = makeHttp(['social', 'crm']);

    // Verify org_app_on IS true for both modules on this org (proving entitlement alone blocks).
    const appStates = await admin(async (c) =>
      (await c.query<{ crm: boolean; social: boolean }>("SELECT ludy_kernel.org_app_on($1, 'crm') AS crm, ludy_kernel.org_app_on($1, 'social') AS social", [f.orgId])).rows[0],
    );
    expect(appStates).toEqual({ crm: true, social: true });

    const storeReadsBefore = store.getCount;

    type PublicCase = {
      name: string;
      run: (edge: ReturnType<typeof createHttpApp>) => Response | Promise<Response>;
      unknown: () => Response | Promise<Response>;
    };

    const verifyBlockedAcross = async (cases: readonly PublicCase[], edges: readonly ReturnType<typeof createHttpApp>[]) => {
      for (const spec of cases) {
        const baseline = await spec.unknown();
        expect(baseline.status, `${spec.name} baseline`).toBe(404);
        const baselineText = await baseline.text();
        for (const edge of edges) {
          const actual = await spec.run(edge);
          expect(actual.status, spec.name).toBe(404);
          const actualText = await actual.text();
          expect(actualText, spec.name).toBe(baselineText);
          expect(actualText, spec.name).not.toContain(f.orgId);
          expect(JSON.stringify(Object.fromEntries(actual.headers.entries())), spec.name).not.toContain(f.orgId);
        }
      }
    };

    const socialCases: readonly PublicCase[] = [
      {
        name: 'POST /api/review/view (single)',
        run: (edge) => postJson(edge, '/api/review/view', { token: f.reviewSingle.token }),
        unknown: () => postJson(httpFull, '/api/review/view', { token: unknownToken }),
      },
      {
        name: 'POST /api/review/view (plan)',
        run: (edge) => postJson(edge, '/api/review/view', { token: f.reviewPlan.token }),
        unknown: () => postJson(httpFull, '/api/review/view', { token: unknownToken }),
      },
      {
        name: 'POST /api/review/media',
        run: (edge) => postJson(edge, '/api/review/media', { token: f.reviewSingle.token }),
        unknown: () => postJson(httpFull, '/api/review/media', { token: unknownToken }),
      },
      {
        name: 'POST /api/review/file',
        run: (edge) => postJson(edge, '/api/review/file', { token: f.reviewSingle.token, fileId: f.reviewFileId }),
        unknown: () => postJson(httpFull, '/api/review/file', { token: unknownToken, fileId: f.reviewFileId }),
      },
      {
        name: 'POST /api/review/answer (single)',
        run: (edge) => postJson(edge, '/api/review/answer', { token: f.reviewSingle.token, name: 'Khách', verdict: 'approved' }),
        unknown: () => postJson(httpFull, '/api/review/answer', { token: unknownToken, name: 'Khách', verdict: 'approved' }),
      },
      {
        name: 'POST /api/review/answer (plan)',
        run: (edge) => postJson(edge, '/api/review/answer', { token: f.reviewPlan.token, postId: f.planPostId, name: 'Khách', verdict: 'approved' }),
        unknown: () => postJson(httpFull, '/api/review/answer', { token: unknownToken, postId: f.planPostId, name: 'Khách', verdict: 'approved' }),
      },
      {
        name: 'POST /api/report/view',
        run: (edge) => postJson(edge, '/api/report/view', { token: f.reportLink.token }),
        unknown: () => postJson(httpFull, '/api/report/view', { token: unknownToken }),
      },
      {
        name: 'GET /l/:code',
        run: (edge) => edge.request(`/l/${f.shortCode}`, { headers: { 'user-agent': 'Mozilla/5.0' } }),
        unknown: () => httpFull.request(`/l/${'Z'.repeat(12)}`, { headers: { 'user-agent': 'Mozilla/5.0' } }),
      },
      {
        name: 'GET /b/:slug',
        run: (edge) => edge.request(`/b/${f.bioSlug}`),
        unknown: () => httpFull.request('/b/missing-bio-slug-3393'),
      },
      {
        name: 'GET /b/:slug/go/button:0',
        run: (edge) => edge.request(`/b/${f.bioSlug}/go/button:0`, { headers: { 'user-agent': 'Mozilla/5.0' } }),
        unknown: () => httpFull.request('/b/missing-bio-slug-3393/go/button:0', { headers: { 'user-agent': 'Mozilla/5.0' } }),
      },
      {
        name: 'GET /b/:slug/go/post',
        run: (edge) => edge.request(`/b/${f.bioSlug}/go/post:${f.bioPostId}`, { headers: { 'user-agent': 'Mozilla/5.0' } }),
        unknown: () => httpFull.request(`/b/missing-bio-slug-3393/go/post:${f.bioPostId}`, { headers: { 'user-agent': 'Mozilla/5.0' } }),
      },
      {
        name: 'GET /b/:slug/img (avatar)',
        run: (edge) => edge.request(`/b/${f.bioSlug}/img/${f.bioAvatarFileId}`),
        unknown: () => httpFull.request(`/b/missing-bio-slug-3393/img/${f.bioAvatarFileId}`),
      },
      {
        name: 'GET /b/:slug/img (post)',
        run: (edge) => edge.request(`/b/${f.bioSlug}/img/${f.bioPostFileId}`),
        unknown: () => httpFull.request(`/b/missing-bio-slug-3393/img/${f.bioPostFileId}`),
      },
      {
        name: 'GET /cal/:file (social)',
        run: (edge) => edge.request(`/cal/${f.socialCalToken}.ics`),
        unknown: () => httpFull.request(`/cal/${unknownToken}.ics`),
      },
    ];

    const crmCases: readonly PublicCase[] = [
      {
        name: 'GET /api/booking/:org/:type',
        run: (edge) => edge.request(`/api/booking/${f.slug}/${f.bookingTypeSlug}?from=${encodeURIComponent(f.bookingRange.from)}&to=${encodeURIComponent(f.bookingRange.to)}`),
        unknown: () => httpFull.request(`/api/booking/no-such-org/${f.bookingTypeSlug}?from=${encodeURIComponent(f.bookingRange.from)}&to=${encodeURIComponent(f.bookingRange.to)}`),
      },
      {
        name: 'POST /api/booking/:org/:type (request)',
        run: (edge) =>
          postJson(edge, `/api/booking/${f.slug}/${f.bookingTypeSlug}`, {
            startsAt: f.freeSlotStart,
            name: 'Khách Lẻn Vào',
            email: 'unentitled@example.test',
            timeZone: VN,
          }),
        unknown: () =>
          postJson(httpFull, `/api/booking/no-such-org/${f.bookingTypeSlug}`, {
            startsAt: f.freeSlotStart,
            name: 'Khách Lẻn Vào',
            email: 'unentitled@example.test',
            timeZone: VN,
          }),
      },
      {
        name: 'POST /api/booking/:org/:type (status)',
        run: (edge) => postJson(edge, `/api/booking/${f.slug}/${f.bookingTypeSlug}`, { token: f.bookingRequestToken }),
        unknown: () => postJson(httpFull, `/api/booking/${f.slug}/${f.bookingTypeSlug}`, { token: unknownToken }),
      },
      {
        name: 'POST /api/booking/:org/:type (manage view)',
        run: (edge) => postJson(edge, `/api/booking/${f.slug}/${f.bookingTypeSlug}`, { manage: f.bookingManageToken }),
        unknown: () => postJson(httpFull, `/api/booking/no-such-org/${f.bookingTypeSlug}`, { manage: f.bookingManageToken }),
      },
      {
        name: 'POST /api/booking/:org/:type (manage cancel)',
        run: (edge) => postJson(edge, `/api/booking/${f.slug}/${f.bookingTypeSlug}`, { manage: f.bookingManageToken, action: 'cancel' }),
        unknown: () => postJson(httpFull, `/api/booking/no-such-org/${f.bookingTypeSlug}`, { manage: f.bookingManageToken, action: 'cancel' }),
      },
      {
        name: 'POST /api/booking/:org/:type (manage move)',
        run: (edge) => postJson(edge, `/api/booking/${f.slug}/${f.bookingTypeSlug}`, { manage: f.bookingManageToken, action: 'move', startsAt: f.freeSlotStart }),
        unknown: () => postJson(httpFull, `/api/booking/no-such-org/${f.bookingTypeSlug}`, { manage: f.bookingManageToken, action: 'move', startsAt: f.freeSlotStart }),
      },
      {
        name: 'GET /cal/:file (crm)',
        run: (edge) => edge.request(`/cal/${f.crmFeedToken}.ics`),
        unknown: () => httpFull.request(`/cal/${unknownToken}.ics`),
      },
      {
        name: 'POST /api/quote/view',
        run: (edge) => postJson(edge, '/api/quote/view', { token: f.quoteToken }),
        unknown: () => postJson(httpFull, '/api/quote/view', { token: unknownToken }),
      },
      {
        name: 'POST /api/quote/logo',
        run: (edge) => postJson(edge, '/api/quote/logo', { token: f.quoteToken }),
        unknown: () => postJson(httpFull, '/api/quote/logo', { token: unknownToken }),
      },
    ];

    await verifyBlockedAcross(socialCases, [httpNone, httpCrmOnly]);
    await verifyBlockedAcross(crmCases, [httpNone, httpSocialOnly]);

    // Zero blob store reads and zero DB side-effect writes must have occurred.
    expect(store.getCount).toBe(storeReadsBefore);
    const dbSideEffects = await admin(async (c) => {
      const reviewFeedback = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM ludy_social.review_feedback WHERE org_id = $1', [f.orgId]);
      const shortClicks = await c.query<{ n: number }>('SELECT coalesce(sum(clicks), 0)::int AS n FROM ludy_social.short_link_click WHERE org_id = $1', [f.orgId]);
      const bioClicks = await c.query<{ n: number }>('SELECT coalesce(sum(clicks), 0)::int AS n FROM ludy_social.bio_click WHERE org_id = $1', [f.orgId]);
      const quoteLink = await c.query<{ views: number; first_viewed_at: string | null }>('SELECT views, first_viewed_at FROM ludy_crm.quote_link WHERE org_id = $1 AND id = $2', [f.orgId, f.quoteLinkId]);
      const quote = await c.query<{ first_viewed_at: string | null }>('SELECT first_viewed_at FROM ludy_crm.quote WHERE org_id = $1 AND id = $2', [f.orgId, f.quoteId]);
      const bookings = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM ludy_crm.booking WHERE org_id = $1', [f.orgId]);
      const confirmed = await c.query<{ status: string; manage_request_id: string | null }>('SELECT status, manage_request_id FROM ludy_crm.booking WHERE org_id = $1 AND id = $2', [f.orgId, f.confirmedBookingId]);
      const outbox = await c.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type IN ('social.review.answered', 'crm.booking.manage_requested')",
        [f.orgId],
      );
      const bookingRequests = await c.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type = 'crm.booking.requested'",
        [f.orgId],
      );
      return {
        reviewFeedback: reviewFeedback.rows[0]!.n,
        shortClicks: shortClicks.rows[0]!.n,
        bioClicks: bioClicks.rows[0]!.n,
        quoteLink: quoteLink.rows[0],
        quote: quote.rows[0],
        bookings: bookings.rows[0]!.n,
        confirmed: confirmed.rows[0],
        outbox: outbox.rows[0]!.n,
        bookingRequests: bookingRequests.rows[0]!.n,
      };
    });
    expect(dbSideEffects).toEqual({
      reviewFeedback: 0,
      shortClicks: 0,
      bioClicks: 0,
      quoteLink: { views: 0, first_viewed_at: null },
      quote: { first_viewed_at: null },
      bookings: 1,
      confirmed: { status: 'confirmed', manage_request_id: null },
      outbox: 0,
      bookingRequests: 1,
    });

    // --- Cross-module isolation & recovery: entitled endpoints work cleanly ---
    // Social works under httpSocialOnly (with CRM off).
    expect((await postJson(httpSocialOnly, '/api/review/view', { token: f.reviewSingle.token })).status).toBe(200);
    expect((await postJson(httpSocialOnly, '/api/review/view', { token: f.reviewPlan.token })).status).toBe(200);
    expect((await postJson(httpSocialOnly, '/api/review/media', { token: f.reviewSingle.token })).status).toBe(200);
    expect((await postJson(httpSocialOnly, '/api/review/file', { token: f.reviewSingle.token, fileId: f.reviewFileId })).status).toBe(200);
    expect((await postJson(httpSocialOnly, '/api/review/answer', { token: f.reviewSingle.token, name: 'Chị Lan', verdict: 'approved' })).status).toBe(200);
    expect((await postJson(httpSocialOnly, '/api/review/answer', { token: f.reviewPlan.token, postId: f.planPostId, name: 'Chị Lan', verdict: 'approved' })).status).toBe(200);
    expect((await postJson(httpSocialOnly, '/api/report/view', { token: f.reportLink.token })).status).toBe(200);

    const shortRedirect = await httpSocialOnly.request(`/l/${f.shortCode}`, { headers: { 'user-agent': 'Mozilla/5.0' } });
    expect(shortRedirect.status).toBe(302);
    expect(shortRedirect.headers.get('location')).toBe(f.shortTargetUrl);

    expect((await httpSocialOnly.request(`/b/${f.bioSlug}`)).status).toBe(200);
    const bioRedirect = await httpSocialOnly.request(`/b/${f.bioSlug}/go/button:0`, { headers: { 'user-agent': 'Mozilla/5.0' } });
    expect(bioRedirect.status).toBe(302);
    expect(bioRedirect.headers.get('location')).toBe(f.bioTargetUrl);
    const bioPostRedirect = await httpSocialOnly.request(`/b/${f.bioSlug}/go/post:${f.bioPostId}`, { headers: { 'user-agent': 'Mozilla/5.0' } });
    expect(bioPostRedirect.status).toBe(302);
    expect(bioPostRedirect.headers.get('location')).toBe('https://shop.example/bai-viet-3393');
    expect((await httpSocialOnly.request(`/b/${f.bioSlug}/img/${f.bioAvatarFileId}`)).status).toBe(200);
    expect((await httpSocialOnly.request(`/b/${f.bioSlug}/img/${f.bioPostFileId}`)).status).toBe(200);
    expect((await httpSocialOnly.request(`/cal/${f.socialCalToken}.ics`)).status).toBe(200);

    // CRM works under httpCrmOnly (with Social off).
    expect(
      (await httpCrmOnly.request(`/api/booking/${f.slug}/${f.bookingTypeSlug}?from=${encodeURIComponent(f.bookingRange.from)}&to=${encodeURIComponent(f.bookingRange.to)}`)).status,
    ).toBe(200);
    expect(
      (
        await postJson(httpCrmOnly, `/api/booking/${f.slug}/${f.bookingTypeSlug}`, {
          startsAt: f.freeSlotStart,
          name: 'Khách Hợp Lệ',
          email: 'hop-le@example.test',
          timeZone: VN,
        })
      ).status,
    ).toBe(202);
    expect((await postJson(httpCrmOnly, `/api/booking/${f.slug}/${f.bookingTypeSlug}`, { token: f.bookingRequestToken })).status).toBe(200);
    expect((await postJson(httpCrmOnly, `/api/booking/${f.slug}/${f.bookingTypeSlug}`, { manage: f.bookingManageToken })).status).toBe(200);
    expect((await postJson(httpCrmOnly, `/api/booking/${f.slug}/${f.bookingTypeSlug}`, { manage: f.bookingManageToken, action: 'cancel' })).status).toBe(202);
    expect((await httpCrmOnly.request(`/cal/${f.crmFeedToken}.ics`)).status).toBe(200);
    expect((await postJson(httpCrmOnly, '/api/quote/view', { token: f.quoteToken })).status).toBe(200);
    expect((await postJson(httpCrmOnly, '/api/quote/logo', { token: f.quoteToken })).status).toBe(200);
  });
});
