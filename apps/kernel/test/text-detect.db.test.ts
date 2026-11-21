// SPDX-License-Identifier: AGPL-3.0-only
// Database tests for crove_kernel.text_detect and crove_kernel.text_redact_spans (#4001, Slice 1):
// - Verifies real values (email, phone, national_id, tax_code, bank_account) and near-misses (prices, years, counts,
//   dates, percentages, timestamps, meeting numbers, URLs, UUIDs, IPv4).
// - Verifies exact 1-based Unicode character offsets (including emojis / surrogate pairs) and non-overlapping spans.
// - Verifies span-verified redaction (selective confirmation, literal marks, untrusted client offsets rejected, 22023 checks).
// - Verifies hardening, permissions, role isolation, and linear-time ReDoS safety.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hardeningViolations, migrate, setRolePasswords } from '@ludy/db/migrate';
import { PII_DETECT_CASES, type RedactionKind } from './pii-detect-cases.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

interface DetectRow {
  kind: RedactionKind;
  start_pos: number;
  end_pos: number;
  match_text: string;
}

const MARK_BY_KIND: Record<RedactionKind, string> = {
  email: '[đã ẩn: email]',
  phone: '[đã ẩn: số điện thoại]',
  national_id: '[đã ẩn: CCCD]',
  tax_code: '[đã ẩn: mã số thuế]',
  bank_account: '[đã ẩn: số tài khoản]',
};

suite('crove_kernel.text_detect and text_redact_spans (#4001 Slice 1)', () => {
  const dbName = `crove_test_text_detect_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let client: pg.Client;

  const detect = async (text: string | null): Promise<DetectRow[]> =>
    (await client.query<DetectRow>('SELECT kind, start_pos, end_pos, match_text FROM crove_kernel.text_detect($1)', [text])).rows;

  const redactSpans = async (text: string | null, starts: Array<number | null> | null, kinds: Array<string | null> | null, marks: Array<string | null> | null): Promise<string | null> =>
    (await client.query<{ out: string | null }>('SELECT crove_kernel.text_redact_spans($1, $2, $3, $4) AS out', [text, starts, kinds, marks])).rows[0]?.out ?? null;

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
    await setRolePasswords(adminUrl, {
      crove_app: 'test-app-pw',
      crove_worker: 'test-worker-pw',
      crove_prober: 'test-prober-pw',
      crove_reporter: 'test-reporter-pw',
    });
    client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
  }, 120_000);

  afterAll(async () => {
    if (client) await client.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  }, 60_000);

  it('detects every real value with exact Unicode code-point offsets and rejects every near-miss', async () => {
    for (const c of PII_DETECT_CASES) {
      const rows = await detect(c.text);
      expect(
        rows.map((r) => ({ kind: r.kind, matchText: r.match_text })),
        c.name,
      ).toEqual(c.expected);

      const codePoints = Array.from(c.text);
      let prevEnd = 1;
      for (const row of rows) {
        expect(row.start_pos, `${c.name}: monotonic non-overlapping start`).toBeGreaterThanOrEqual(prevEnd);
        expect(row.end_pos, `${c.name}: non-empty span`).toBeGreaterThan(row.start_pos);
        expect(codePoints.slice(row.start_pos - 1, row.end_pos - 1).join(''), `${c.name}: code-point slice matches match_text`).toBe(row.match_text);
        const { rows: sqlSlice } = await client.query<{ s: string }>(
          'SELECT pg_catalog.substr($1::text, $2::int, $3::int - $2::int) AS s',
          [c.text, row.start_pos, row.end_pos],
        );
        expect(sqlSlice[0]?.s, `${c.name}: SQL substr matches match_text`).toBe(row.match_text);
        prevEnd = row.end_pos;
      }
    }
  });

  it('handles NULL, empty text, and Vietnamese NFD decomposed text', async () => {
    expect(await detect(null)).toEqual([]);
    expect(await detect('')).toEqual([]);

    const nfd = 'So\u0302\u0301 ta\u0300i khoa\u0309n 12345678 va\u0300 đi\u00ea\u0323n thoa\u0323i 0912 345 678.';
    expect(await detect(nfd)).toEqual([
      { kind: 'bank_account', start_pos: 18, end_pos: 26, match_text: '12345678' },
      { kind: 'phone', start_pos: 44, end_pos: 56, match_text: '0912 345 678' },
    ]);
  });

  it('agrees with crove_kernel.text_mentions on detected emails and non-international digit values', async () => {
    const line = 'Mail đặng@x.example, gọi 0912 345 678, MST 0101234567-001, CCCD 079091001234, STK 19034567890123.';
    const rows = await detect(line);
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      const probeKind = row.kind === 'email' ? 'email' : 'digits';
      const probeVal = row.kind === 'email' ? row.match_text.toLowerCase() : row.match_text.replace(/\D/g, '');
      const { rows: mentioned } = await client.query<{ ok: boolean }>('SELECT crove_kernel.text_mentions($1, $2, $3) AS ok', [line, probeKind, probeVal]);
      expect(mentioned[0]?.ok, `${row.kind} ${row.match_text}`).toBe(true);
    }
  });

  it('redacts only confirmed spans re-verified by the server, handles emojis, literal marks, and rejects bad inputs', async () => {
    const text = '📞 Gọi 0912 345 678, mail ab@x.example hoặc STK 19034567890123 nhé.';
    const found = await detect(text);
    expect(found).toHaveLength(3);

    // Confirm #1 (phone) and #3 (bank_account), leaving #2 (email) untouched.
    const phone = found[0] as DetectRow;
    const bank = found[2] as DetectRow;
    const selective = await redactSpans(
      text,
      [phone.start_pos, bank.start_pos],
      [phone.kind, bank.kind],
      [MARK_BY_KIND[phone.kind], MARK_BY_KIND[bank.kind]],
    );
    expect(selective).toBe('📞 Gọi [đã ẩn: số điện thoại], mail ab@x.example hoặc STK [đã ẩn: số tài khoản] nhé.');

    // Client sends tampered/wrong offset or mismatched kind: nothing is redacted.
    expect(await redactSpans(text, [1], ['phone'], ['[đã ẩn: số điện thoại]'])).toBe(text);
    expect(await redactSpans(text, [phone.start_pos], ['email'], ['[đã ẩn: email]'])).toBe(text);
    expect(await redactSpans(text, [phone.start_pos + 1], ['phone'], ['[đã ẩn: số điện thoại]'])).toBe(text);

    // Literal mark replacement: regex replacement sequences (\1, \&) stay literal.
    expect(await redactSpans('Mail ab@x.example.', [6], ['email'], ['R&D \\1 \\&'])).toBe('Mail R&D \\1 \\&.');

    // Empty selection or NULL text returns text/NULL after validating args.
    expect(await redactSpans(text, [], [], [])).toBe(text);
    expect(await redactSpans(null, [], [], [])).toBeNull();

    // Validation raises 22023 even when p_text is NULL.
    await expect(redactSpans(null, null, [], [])).rejects.toMatchObject({ code: '22023' });
    await expect(redactSpans('abc', [1], [], [])).rejects.toMatchObject({ code: '22023' });
    await expect(redactSpans('abc', [0], ['phone'], ['[đã ẩn]'])).rejects.toMatchObject({ code: '22023' });
    await expect(redactSpans('abc', [1], ['unknown_kind'], ['[đã ẩn]'])).rejects.toMatchObject({ code: '22023' });
    await expect(redactSpans('abc', [1], ['phone'], ['   '])).rejects.toMatchObject({ code: '22023' });
    await expect(redactSpans('abc', [1], ['phone'], ['\t\n\u00a0'])).rejects.toMatchObject({ code: '22023' });
    await expect(redactSpans('abc', [1], ['phone'], ['x'.repeat(201)])).rejects.toMatchObject({ code: '22023' });
    await expect(redactSpans('abc', [null as unknown as number], ['phone'], ['[đã ẩn]'])).rejects.toMatchObject({ code: '22023' });
    await expect(
      client.query("SELECT crove_kernel.text_redact_spans('abc', ARRAY[[1]], ARRAY[['phone']], ARRAY[['[đã ẩn]']])"),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      client.query("SELECT crove_kernel.text_redact_spans('abc', '[0:0]={1}'::integer[], ARRAY['phone'], ARRAY['[đã ẩn]'])"),
    ).rejects.toMatchObject({ code: '22023' });
  });

  it('stays fast and O(N) on long hostile, ReDoS-shaped, and ~100 KB multi-match/benign inputs', async () => {
    const hostile = [
      'a@'.repeat(2000),
      ('a@b' + '.'.repeat(50)).repeat(200),
      '1 '.repeat(4000),
      '0'.repeat(8000),
      '1 '.repeat(5000) + '1px',
      'a.b.'.repeat(1500) + '@x',
      '('.repeat(1500) + '0912345678' + ')'.repeat(1500),
      '+'.repeat(1500) + '0912345678',
      '1-2-3-'.repeat(1200),
      '0912345678 '.repeat(400),
    ];
    const started = performance.now();
    for (const input of hostile) {
      await detect(input);
    }
    expect(performance.now() - started).toBeLessThan(2000);

    const emails100k = 'a@example.com, '.repeat(6700);
    const prices100k = '100.000.000, '.repeat(7700);
    const phones100k = '0912345678, '.repeat(8400);
    const invoice99k = 'Ngày 21-11-2026 thanh toán 100.000.000 đ cho đơn hàng này.\n'.repeat(1500);

    const tEmails = performance.now();
    const detectedEmails = await detect(emails100k);
    const emailsMs = performance.now() - tEmails;
    expect(detectedEmails).toHaveLength(6700);
    expect(emailsMs).toBeLessThan(2500);

    const tPrices = performance.now();
    expect(await detect(prices100k)).toEqual([]);
    const pricesMs = performance.now() - tPrices;
    expect(pricesMs).toBeLessThan(2500);

    const tPhones = performance.now();
    const detectedPhones = await detect(phones100k);
    const phonesMs = performance.now() - tPhones;
    expect(detectedPhones).toHaveLength(8400);
    expect(phonesMs).toBeLessThan(2500);

    const tInvoice = performance.now();
    expect(await detect(invoice99k)).toEqual([]);
    const invoiceMs = performance.now() - tInvoice;
    expect(invoiceMs).toBeLessThan(2500);

    const tRedactAscii = performance.now();
    const redactedEmails = await redactSpans(
      emails100k,
      detectedEmails.map((r) => r.start_pos),
      detectedEmails.map((r) => r.kind),
      detectedEmails.map(() => MARK_BY_KIND.email),
    );
    const redactAsciiMs = performance.now() - tRedactAscii;
    expect(redactedEmails).toBe('[đã ẩn: email], '.repeat(6700));
    expect(redactAsciiMs).toBeLessThan(2500);

    const vnMultiLine = 'Nguyễn Văn Ánh 📞 0912 345 678 😀.\r\n';
    const vn91k = vnMultiLine.repeat(2100);
    const vnDetected = await detect(vn91k);
    expect(vnDetected).toHaveLength(2100);

    const tRedactVn = performance.now();
    const redactedVn = await redactSpans(
      vn91k,
      vnDetected.map((r) => r.start_pos),
      vnDetected.map((r) => r.kind),
      vnDetected.map(() => MARK_BY_KIND.phone),
    );
    const redactVnMs = performance.now() - tRedactVn;
    expect(redactedVn).toBe('Nguyễn Văn Ánh 📞 [đã ẩn: số điện thoại] 😀.\r\n'.repeat(2100));
    expect(redactVnMs).toBeLessThan(2500);
  });

  it('is immutable, parallel-safe SECURITY INVOKER with pinned search_path, narrow crove_tenant grant, and zero hardening violations', async () => {
    const sigs = [
      'crove_kernel.text_detect(text)',
      'crove_kernel.text_redact_spans(text, integer[], text[], text[])',
    ];
    for (const sig of sigs) {
      const meta = (
        await client.query<{ provolatile: string; proparallel: string; prosecdef: boolean; proconfig: string[] | null }>(
          'SELECT provolatile, proparallel, prosecdef, proconfig FROM pg_catalog.pg_proc WHERE oid = $1::regprocedure',
          [sig],
        )
      ).rows[0];
      expect([meta?.provolatile, meta?.proparallel, meta?.prosecdef], sig).toEqual(['i', 's', false]);
      expect(meta?.proconfig, sig).toEqual(['search_path=pg_catalog, pg_temp']);

      const acl = (
        await client.query<{ acl: string[] | null }>(
          'SELECT proacl::text[] AS acl FROM pg_catalog.pg_proc WHERE oid = $1::regprocedure',
          [sig],
        )
      ).rows[0]?.acl ?? [];
      expect(
        acl.filter((entry) => !/^(?:postgres|crove_migrator|crove_owner)=/.test(entry)).map((entry) => entry.split('=')[0]),
        sig,
      ).toEqual(['crove_tenant']);

      expect((await client.query<{ ok: boolean }>(`SELECT has_function_privilege('public', $1, 'EXECUTE') AS ok`, [sig])).rows[0]?.ok, sig).toBe(false);
      expect((await client.query<{ ok: boolean }>(`SELECT has_function_privilege('crove_app', $1, 'EXECUTE') AS ok`, [sig])).rows[0]?.ok, sig).toBe(true);
      expect((await client.query<{ ok: boolean }>(`SELECT has_function_privilege('crove_worker', $1, 'EXECUTE') AS ok`, [sig])).rows[0]?.ok, sig).toBe(true);
      expect((await client.query<{ ok: boolean }>(`SELECT has_function_privilege('crove_prober', $1, 'EXECUTE') AS ok`, [sig])).rows[0]?.ok, sig).toBe(false);
      expect((await client.query<{ ok: boolean }>(`SELECT has_function_privilege('crove_reporter', $1, 'EXECUTE') AS ok`, [sig])).rows[0]?.ok, sig).toBe(false);
    }

    // Verify crove_app can execute both functions directly, while crove_prober is refused.
    const roleUrl = (user: string, pw: string) => {
      const u = new URL(adminUrl);
      u.username = user;
      u.password = pw;
      return u.toString();
    };
    const appClient = new pg.Client({ connectionString: roleUrl('crove_app', 'test-app-pw') });
    await appClient.connect();
    try {
      const { rows } = await appClient.query<DetectRow>("SELECT * FROM crove_kernel.text_detect('Gọi 0912 345 678')");
      expect(rows).toEqual([{ kind: 'phone', start_pos: 5, end_pos: 17, match_text: '0912 345 678' }]);
    } finally {
      await appClient.end();
    }

    const proberClient = new pg.Client({ connectionString: roleUrl('crove_prober', 'test-prober-pw') });
    await proberClient.connect();
    try {
      await expect(proberClient.query("SELECT * FROM crove_kernel.text_detect('Gọi 0912 345 678')")).rejects.toMatchObject({ code: '42501' });
    } finally {
      await proberClient.end();
    }

    expect(await hardeningViolations(client)).toEqual([]);
  });
});
