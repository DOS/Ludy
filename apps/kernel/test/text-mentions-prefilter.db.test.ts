// SPDX-License-Identifier: AGPL-3.0-only
// crove_kernel.text_mentions after its prefilter (#3832): the answer must be exactly what the unchanged pattern gives. The reference is `text ~* crove_kernel.text_mention_pattern(kind, value)`,
// which is what text_mentions was before the prefilter (the pattern function is not touched); the cases are the shared table of the free-text matcher (pii-text-cases.ts), a hostile set of
// Vietnamese phone formats, and a seeded random set of texts and values. A prefilter that rejects a text the pattern accepts would be a personal-data erasure that misses a phone number, so every
// disagreement fails, and the sets are checked to hold both matches and non-matches (a test with only one kind of answer proves nothing).
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run makes its own database.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '@ludy/db/migrate';
import { personalDataProbe } from '@ludy/kernel';
import { PII_TEXT_CASES } from './pii-text-cases.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

interface Case {
  text: string;
  kind: 'email' | 'digits';
  value: string;
}
interface Verdict {
  got: boolean;
  ref: boolean;
}

// A small seeded generator, so a failure reproduces.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

suite('crove_kernel.text_mentions with its prefilter (#3832)', () => {
  const dbName = `crove_test_text_mentions_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let client: pg.Client;

  // Both answers for each case, in one round trip.
  async function verdicts(cases: readonly Case[]): Promise<Verdict[]> {
    const out: Verdict[] = [];
    for (let at = 0; at < cases.length; at += 2000) {
      const part = cases.slice(at, at + 2000);
      const { rows } = await client.query<{ got: boolean; ref: boolean }>(
        `SELECT crove_kernel.text_mentions(c.t, c.k, c.v) AS got, (c.t ~* crove_kernel.text_mention_pattern(c.k, c.v)) AS ref
           FROM unnest($1::text[], $2::text[], $3::text[]) WITH ORDINALITY AS c(t, k, v, n) ORDER BY c.n`,
        [part.map((c) => c.text), part.map((c) => c.kind), part.map((c) => c.value)],
      );
      out.push(...rows);
    }
    return out;
  }
  const disagreements = (cases: readonly Case[], got: readonly Verdict[]) => cases.flatMap((c, i) => (got[i]?.got === got[i]?.ref ? [] : [`${JSON.stringify(c)} -> ${JSON.stringify(got[i])}`]));

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

  it('answers as the pattern does on the shared case table, each value read as the finder reads it', async () => {
    const cases: Case[] = [];
    for (const c of PII_TEXT_CASES) {
      const probe = personalDataProbe(c.value);
      if (probe) cases.push({ text: c.text, kind: probe.kind === 'email' ? 'email' : 'digits', value: probe.kind === 'email' ? probe.email : probe.digits });
    }
    expect(cases.length).toBeGreaterThan(30);
    const got = await verdicts(cases);
    expect(disagreements(cases, got)).toEqual([]);
    expect(got.some((g) => g.got)).toBe(true);
    expect(got.some((g) => !g.got)).toBe(true);
  });

  it('answers as the pattern does on a hostile set of Vietnamese phone formats', async () => {
    const values = ['0912345678', '84912345678', '02838291234', '842838291234', '0101234567001', '079091001234', '0901234567', '8401234567', '091777665', '123456789012345', '1234567890123456', '12345678901234567890', '09123456789012345678'];
    // The spaces the pattern names (space, tab, line breaks, no-break spaces, the zero-width no-break space), the punctuation it allows, and characters it must not take as separators.
    const allowed = [' ', '  ', '   ', '.', '-', '(', ')', ' ( ', ' ', ' ', ' ', '﻿', '\t', '\n', ' . ', '.-', ') ', '-.'];
    const refused = ['/', ',', '_', 'x', ' ', '٠', ':', '+', '    ', '....'];
    const cases: Case[] = [];
    const kinds = (v: string): Case['kind'] => (v.includes('@') ? 'email' : 'digits');
    const spell = (digits: string, sep: string) => digits.split('').join(sep);
    for (const value of values) {
      const forms = [value, value.startsWith('84') ? `0${value.slice(2)}` : value, value.startsWith('0') ? `84${value.slice(1)}` : value];
      for (const form of forms) {
        for (const sep of [...allowed, ...refused, '']) {
          for (const [pre, post] of [['', ''], ['Gọi ', ' nhé'], ['(', ')'], ['+', ''], ['0', ''], ['', '0'], ['1 ', ''], ['', ' 1'], ['1.', ''], ['', '.1'], ['\n', '\n'], ['STK ', ' 90']] as const) {
            cases.push({ text: `${pre}${spell(form, sep)}${post}`, kind: kinds(value), value });
          }
        }
        // One digit short, one swapped, one extra, the digits of both forms mixed, a list one number a line, and a longer number in groups around it.
        const short = form.slice(0, -1);
        cases.push({ text: spell(short, ' '), kind: 'digits', value });
        cases.push({ text: `${form.slice(0, 3)}${form.slice(4, 5)}${form.slice(3, 4)}${form.slice(5)}`, kind: 'digits', value });
        cases.push({ text: `${form}9`, kind: 'digits', value });
        cases.push({ text: `1. ${form}\n2. ${form}`, kind: 'digits', value });
        cases.push({ text: `${form.slice(0, 4)} ${form.slice(4)} ${form.slice(0, 4)}`, kind: 'digits', value });
      }
    }
    // Non-ASCII digits are not the pattern's digits: whatever it answers, the filter must agree. Texts that lack one digit a number needs, and a text with every digit but in the wrong order.
    cases.push({ text: '٠٩١٢٣٤٥٦٧٨ và ０９１２３４５６７８', kind: 'digits', value: '0912345678' });
    cases.push({ text: '091234567', kind: 'digits', value: '0912345678' });
    cases.push({ text: '8765432109', kind: 'digits', value: '0912345678' });
    cases.push({ text: '', kind: 'digits', value: '0912345678' });
    cases.push({ text: 'không có số nào ở đây', kind: 'digits', value: '0912345678' });
    const got = await verdicts(cases);
    expect(cases.length).toBeGreaterThan(2000);
    expect(disagreements(cases, got)).toEqual([]);
    // Non-vacuous: the set holds many matches and many non-matches.
    expect(got.filter((g) => g.got).length).toBeGreaterThan(300);
    expect(got.filter((g) => !g.got).length).toBeGreaterThan(300);
  });

  it('answers as the pattern does on seeded random texts and values, emails included', async () => {
    const rand = rng(3832);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;
    const digits = (n: number) => Array.from({ length: n }, () => String(Math.floor(rand() * 10))).join('');
    const words = ['giá', 'hạn giao', 'tháng', 'Nguyễn Văn A', 'Chúng ta', 'bàn về', 'gọi', 'SĐT', 'mã số', 'đặng', 'a', 'OK'];
    const seps = [' ', '.', '-', '(', ')', ' ', '\t', '\n', ' ', ' ', '/', ',', 'x', '  ', '...'];
    const cases: Case[] = [];
    for (let i = 0; i < 6000; i++) {
      const email = rand() < 0.2;
      let value: string;
      let rendered: string;
      if (email) {
        value = `${pick(['ab', 'khach.hang', 'a+b', 'đặng', 'x_y'])}@${pick(['x.example', 'congty.example', 'A.Example'])}`.toLowerCase();
        rendered = rand() < 0.5 ? value : value.toUpperCase();
      } else {
        const base = pick([digits(8), digits(10), `0${digits(9)}`, `0${digits(10)}`, `84${digits(9)}`, `84${digits(10)}`, digits(12), digits(13), digits(15), digits(17), digits(20)]);
        value = base;
        const form = rand() < 0.5 ? base : base.startsWith('0') ? `84${base.slice(1)}` : base.startsWith('84') ? `0${base.slice(2)}` : base;
        rendered = form
          .split('')
          .map((d, at) => (at === 0 ? d : `${rand() < 0.35 ? pick(seps) : ''}${d}`))
          .join('');
      }
      const noise = () => Array.from({ length: Math.floor(rand() * 4) }, () => pick([...words, digits(1 + Math.floor(rand() * 6)), pick(seps)])).join(pick([' ', '', '. ']));
      const mention = rand() < 0.55 ? rendered : email ? noise() : rendered.slice(0, -1 - Math.floor(rand() * 2));
      const text = `${noise()}${rand() < 0.3 ? pick(seps) : ' '}${mention}${rand() < 0.3 ? pick(seps) : ' '}${noise()}`;
      cases.push({ text, kind: email ? 'email' : 'digits', value });
    }
    const got = await verdicts(cases);
    expect(disagreements(cases, got)).toEqual([]);
    expect(got.filter((g) => g.got).length).toBeGreaterThan(500);
    expect(got.filter((g) => !g.got).length).toBeGreaterThan(500);
    expect(cases.filter((c, i) => c.kind === 'email' && got[i]?.got).length).toBeGreaterThan(50);
  });

  it('keeps the validation, the NULL answer and the function\'s shape', async () => {
    const ask = (text: string | null, kind: string, value: string | null) => client.query(`SELECT crove_kernel.text_mentions($1, $2, $3) AS found`, [text, kind, value]);
    // A bad kind or value raises whatever the text is, a NULL text included (so a caller's mistake is never read as "not found").
    await expect(ask('abc', 'phone', '0912345678')).rejects.toMatchObject({ code: '22023' });
    await expect(ask(null, 'phone', '0912345678')).rejects.toMatchObject({ code: '22023' });
    await expect(ask('abc', 'digits', '12345')).rejects.toMatchObject({ code: '22023' });
    await expect(ask(null, 'digits', '12345')).rejects.toMatchObject({ code: '22023' });
    await expect(ask('abc', 'email', 'not an email')).rejects.toMatchObject({ code: '22023' });
    expect((await ask(null, 'digits', '0912345678')).rows[0].found).toBe(false);
    expect((await ask(null, 'email', 'ab@x.example')).rows[0].found).toBe(false);
    // Still an immutable, parallel-safe invoker function with a pinned search path, for the tenant role alone.
    const meta = (await client.query(`SELECT provolatile, proparallel, prosecdef, proconfig FROM pg_catalog.pg_proc WHERE oid = 'crove_kernel.text_mentions(text, text, text)'::regprocedure`)).rows[0];
    expect([meta.provolatile, meta.proparallel, meta.prosecdef]).toEqual(['i', 's', false]);
    expect(JSON.stringify(meta.proconfig)).toContain('search_path=pg_catalog, pg_temp');
    // The ACL names the tenant role alone besides the owner (the other logins reach it through that role), as the first migration gave it.
    const acl = (await client.query<{ acl: string[] }>(`SELECT proacl::text[] AS acl FROM pg_catalog.pg_proc WHERE oid = 'crove_kernel.text_mentions(text, text, text)'::regprocedure`)).rows[0]?.acl ?? [];
    expect(acl.filter((entry) => !/^(?:postgres|crove_migrator|crove_owner)=/.test(entry)).map((entry) => entry.split('=')[0])).toEqual(['crove_tenant']);
    expect((await client.query(`SELECT has_function_privilege('public', 'crove_kernel.text_mentions(text, text, text)', 'EXECUTE') AS ok`)).rows[0].ok).toBe(false);
  });
});
