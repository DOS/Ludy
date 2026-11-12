// SPDX-License-Identifier: AGPL-3.0-only
// The signed wake-up webhook (ADR-0051 decision 4, issue #3024), pinned before it exists. Step 1 of the two-step plan: every case here passes today and
// bites the moment the feature lands, so the feature's own PR cannot weaken what it must keep.
//
//   - What the egress guard gives a wake-up from the first day (it is code under test and exists now): one resolution per attempt, every answer checked,
//     the connection pinned to the checked address (DNS rebinding: a name that is public at check time and private at connect time reaches nothing), a
//     redirect is an answer and never followed, the answer is read to a byte limit and one deadline covers the attempt, https only and the default port.
//   - What the feature must be, by its files: the delivery lives in `apps/kernel/src/mcp-wake.ts` and the body in `apps/kernel/src/mcp-wake-body.ts`; the
//     delivery goes only through the guard, with no test-only hook, reads at most 4 KB of the receiver's answer and never parses it (it is not an
//     instruction, ADR-0051 decision 8), gives each attempt at most 10 s, and its queue declares exactly `tenant_url`.
//   - What a body may carry: ids, an event type, dates, a day count and decimal-string amounts, by a pinned list of keys and a pinned shape for every
//     value, so no name, note, message or bank text can ride in a field whatever it is called.
//   - What the grant's wake-up table may hold: secrets only sealed, in the two named columns; the table under row-level security.
// A case whose feature does not exist yet passes by finding nothing. Once any source or migration names the delivery (its signature header, its queue or its
// table), the agreed files and shapes are required (the tripwire at the start of "the files"); the setup table and its commands are held to their own cases
// as soon as they exist. Part of the invariant suite; it imports package code under test, never helpers from outside test/invariant/. Keep this directory
// self-contained.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { EgressError, egressFetch, guardedRequest, type EgressOptions } from '@crove/kernel-runtime';
import { DEAL_WITHOUT_INVOICE_READ, RECEIVABLE_WITH_OPEN_DEAL_READ, SUPPLIER_BANK_CHANGED_READ, kernelCommands } from '@crove/kernel';
import { QUEUES, queueEgress } from '../../src/jobs-schema.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DELIVERY = 'apps/kernel/src/mcp-wake.ts';
const BODY = 'apps/kernel/src/mcp-wake-body.ts';
const SKIP = new Set(['node_modules', 'dist', 'test', 'tests', '.git', '.turbo', 'coverage']);

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The egress guard, with a local server standing in for the receiver.
// ---------------------------------------------------------------------------------------------------------------------------------------------

const BASE: EgressOptions = { timeoutMs: 5_000, maxBytes: 4096, overLimit: 'truncate', anyPort: true };
const LOOPBACK = [{ address: '127.0.0.1', family: 4 }];
const servers: http.Server[] = [];

interface Receiver {
  port: number;
  hits: string[];
}

async function receiver(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<Receiver> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { port: (server.address() as AddressInfo).port, hits };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((done) => s.close(() => done()))));
});

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(EgressError);
    return (error as EgressError).code;
  }
  throw new Error('expected the guard to refuse');
}

describe('what the egress guard gives a wake-up (#3024)', () => {
  it('resolves the receiver once per attempt and connects to the address it checked, so a name that turns private after the check reaches nothing (DNS rebinding)', async () => {
    const r = await receiver((_req, res) => res.end('ok'));
    let asked = 0;
    // The first answer is the checked one. A connect that resolved the name again would use the system resolver, which cannot resolve a .test name: the
    // request reaches the local server only through the pinned address, and the injected resolver is asked exactly once.
    const resolve = async () => {
      asked += 1;
      return asked === 1 ? LOOPBACK : [{ address: '10.0.0.5', family: 4 }];
    };
    const answer = await guardedRequest(`http://wake.example.test:${r.port}/hook`, { method: 'POST', body: Buffer.from('{}') }, { ...BASE, resolve, allowed: (a) => a === '127.0.0.1' });
    expect(answer.status).toBe(200);
    expect(asked).toBe(1);
    expect(r.hits).toEqual(['POST /hook']);
  });

  it('refuses a name that is private at check time before anything is sent, and one that has a single private address among its answers', async () => {
    const r = await receiver((_req, res) => res.end('ok'));
    const privateOnly = async () => [{ address: '10.0.0.5', family: 4 }];
    expect(await code(guardedRequest(`http://wake.example.test:${r.port}/hook`, { method: 'POST', body: Buffer.from('{}') }, { ...BASE, resolve: privateOnly }))).toBe('blocked');
    const mixed = async () => [...LOOPBACK, { address: '169.254.169.254', family: 4 }];
    expect(await code(guardedRequest(`http://wake.example.test:${r.port}/hook`, { method: 'POST', body: Buffer.from('{}') }, { ...BASE, resolve: mixed, allowed: (a) => a === '127.0.0.1' }))).toBe('blocked');
    expect(r.hits).toEqual([]);
  });

  it('never follows a redirect: it is an answer (3xx) for the caller to count as a failed attempt', async () => {
    const r = await receiver((req, res) => {
      res.statusCode = 302;
      res.setHeader('location', `http://127.0.0.1:${(req.socket.localPort ?? 0).toString()}/elsewhere`);
      res.end();
    });
    const answer = await guardedRequest(`http://wake.example.test:${r.port}/hook`, { method: 'POST', body: Buffer.from('{}') }, { ...BASE, resolve: async () => LOOPBACK, allowed: (a) => a === '127.0.0.1' });
    expect(answer.status).toBe(302);
    expect(r.hits).toEqual(['POST /hook']);
  });

  it('reads at most the byte limit of the answer and stops, and ends an attempt at its deadline', async () => {
    const big = await receiver((_req, res) => res.end('x'.repeat(65_536)));
    const answer = await guardedRequest(`http://wake.example.test:${big.port}/hook`, { method: 'POST', body: Buffer.from('{}') }, { ...BASE, resolve: async () => LOOPBACK, allowed: (a) => a === '127.0.0.1' });
    expect(answer.body.length).toBe(4096);
    expect(answer.truncated).toBe(true);
    const silent = await receiver(() => {
      // Never answers.
    });
    expect(await code(guardedRequest(`http://wake.example.test:${silent.port}/hook`, { method: 'POST', body: Buffer.from('{}') }, { ...BASE, timeoutMs: 300, resolve: async () => LOOPBACK, allowed: (a) => a === '127.0.0.1' }))).toBe('timeout');
  });

  it('sends only over https, on the default port, to a name or public address, with no credentials in the URL', async () => {
    const send = egressFetch({ timeoutMs: 1_000, maxBytes: 4096, overLimit: 'truncate' });
    const refused = (url: string) => code(send(url, { method: 'POST', body: '{}' }));
    expect(await refused('http://hook.example.test/')).toBe('invalid_url');
    expect(await refused('https://hook.example.test:8443/')).toBe('invalid_url');
    expect(await refused('https://user:pw@hook.example.test/')).toBe('invalid_url');
    for (const literal of ['https://127.0.0.1/', 'https://10.0.0.5/', 'https://169.254.169.254/latest/meta-data/', 'https://[::1]/', 'https://[fd00::1]/']) {
      expect(await refused(literal), literal).toBe('blocked');
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The files.
// ---------------------------------------------------------------------------------------------------------------------------------------------

function walk(dir: string, accept: (name: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, accept, out);
    else if (accept(entry.name)) out.push(relative(ROOT, path).replaceAll('\\', '/'));
  }
  return out;
}

const SOURCES = ['apps', 'packages', 'modules', 'tools'].filter((d) => existsSync(join(ROOT, d))).flatMap((d) => walk(join(ROOT, d), (n) => /\.(ts|tsx|mts|mjs|js)$/.test(n) && !n.endsWith('.d.ts')));
const MIGRATIONS = existsSync(join(ROOT, 'supabase/migrations')) ? walk(join(ROOT, 'supabase/migrations'), (n) => n.endsWith('.sql')) : [];
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const naming = (files: readonly string[], text: string) => files.filter((path) => read(path).includes(text)).sort();
// Code only: the lines that are not comments.
const codeOf = (path: string) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');

// The wake-up feature exists once any source or migration names one of its marks.
// Two levels: the setup (the grant's wake-up table and its commands) is held to the table and command cases by what it is; the delivery (a signature, the queue,
// the delivery table) additionally needs its two files and its queue. So the setup can land before the delivery, and the delivery cannot land half-built.
const MARKS = ['Ludy-Signature', 'kernel-mcp-wake', 'agent_wake_delivery'];
const featureFiles = [...new Set([...MARKS.flatMap((m) => naming(SOURCES, m)), ...MARKS.flatMap((m) => naming(MIGRATIONS, m))])].sort();
const wakeQueues: Array<[string, string]> = Object.entries(QUEUES).filter(([, name]) => /mcp-wake/.test(name));

// Every number a source gives a limit: a literal, or a constant of literals and products (`4 * 1024`, `10_000`, `export const MAX: number = 4096 as const`).
// None found is null (a limit that cannot be read is a failure, not a pass); a decoy elsewhere cannot hide a large one, since every match counts.
function limits(source: string, key: string): number[] | null {
  const found = [...source.matchAll(new RegExp(`\\b${key}\\b(?:\\s*:\\s*([A-Za-z_][A-Za-z0-9_]*|[0-9_]+))?\\s*[,}\\n]`, 'g'))];
  if (found.length === 0) return null;
  const out: number[] = [];
  for (const m of found) {
    let value = m[1] ?? key;
    if (/^[A-Za-z_]/.test(value)) {
      const c = source.match(new RegExp(`\\bconst\\s+${value}\\s*(?::\\s*number)?\\s*=\\s*([0-9_ *]+)(?:\\s+as const)?;`));
      if (!c) return null;
      value = c[1] as string;
    }
    out.push(value.split('*').map((q) => Number(q.replaceAll('_', '').trim())).reduce((a, b) => a * b, 1));
  }
  return out;
}

// The module specifiers a file imports or requires, by every form (static, dynamic, require).
function specifiers(text: string): string[] {
  return [...text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm)].map((m) => m[1] as string);
}
const RAW_NETWORK = /^(node:)?(https?|net|tls|http2|dgram|dns|undici|axios|got|node-fetch|ky|superagent|ws)$/;

describe('the files of the wake-up webhook (#3024)', () => {
  it('has its delivery and its body builder at the agreed paths once anything names the feature (the tripwire)', () => {
    if (featureFiles.length === 0) return;
    expect(existsSync(join(ROOT, DELIVERY)), `${DELIVERY} is where the wake-up is delivered (named by ${featureFiles.join(', ')})`).toBe(true);
    expect(existsSync(join(ROOT, BODY)), `${BODY} is the only builder of the body`).toBe(true);
    expect(naming(SOURCES, 'Ludy-Signature').filter((f) => f !== DELIVERY), 'the signature header is set by the delivery file alone').toEqual([]);
  });

  it('declares exactly the tenant URL egress on the delivery queue, and never that egress on another wake-up queue, and names the queue once', () => {
    // The delivery queue by its exact name; the sweep that decides what to send is another queue and reaches no URL.
    for (const [key, name] of wakeQueues) expect(queueEgress(name), key).toEqual(name === 'kernel-mcp-wake' ? ['tenant_url'] : 'none');
    if (featureFiles.length > 0) expect(wakeQueues.filter(([, name]) => name === 'kernel-mcp-wake').length, 'a queue named kernel-mcp-wake carries the deliveries').toBe(1);
    expect(naming(SOURCES, "'kernel-mcp-wake'").filter((f) => f !== 'apps/kernel/src/jobs-schema.ts')).toEqual([]);
  });

  it('puts the guard hooks and the delivery module nowhere in production wiring but through its own dependencies: no file that imports it sets a test-only hook', () => {
    const importers = SOURCES.filter((f) => f !== DELIVERY && specifiers(read(f)).some((spec) => /(^|\/)mcp-wake(\.ts)?$/.test(spec)));
    for (const f of importers) expect(codeOf(f), f).not.toMatch(/\b(anyPort|allowed|resolve|hostAllowed)\s*:/);
    // The one place a body is signed and posted: no other file both reaches the guard and signs.
    const both = SOURCES.filter((f) => f !== DELIVERY && /\b(egressFetch|guardedRequest|guardedFetch)\(/.test(codeOf(f)) && /createHmac\(/.test(codeOf(f)));
    expect(both, 'a file that reaches a tenant URL and signs with an HMAC').toEqual([]);
  });

  it('delivers only through egressFetch with httpsOnly, no test-only hook, a 4 KB read of the answer that is never read as data, and at most 10 s an attempt', () => {
    if (!existsSync(join(ROOT, DELIVERY))) return;
    const file = codeOf(DELIVERY);
    // The https-only fetch of the guard, and not the guard's plain-http entry points.
    expect(file).toMatch(/\begressFetch\(/);
    expect(file).not.toMatch(/\b(guardedRequest|guardedFetch)\b/);
    const flags = [...file.matchAll(/\bhttpsOnly\b\s*:\s*([^,}\n]+)/g)].map((m) => (m[1] as string).trim());
    expect(flags.length, 'httpsOnly: true is stated').toBeGreaterThan(0);
    expect(flags.every((v) => v === 'true')).toBe(true);
    // No raw network: not a bare or global fetch, no Node or third-party client, however it is imported.
    expect(file.replace(/\begressFetch\b/g, '')).not.toMatch(/\bfetch\b/);
    const imports = specifiers(read(DELIVERY));
    for (const spec of imports) expect(spec, `import of ${spec}`).not.toMatch(RAW_NETWORK);
    expect(file).not.toMatch(/\b(import|require)\s*\(/);
    for (const spec of imports.filter((i) => i.startsWith('.'))) {
      const target = join('apps/kernel/src', spec.replace(/^\.\//, ''));
      if (existsSync(join(ROOT, target))) for (const inner of specifiers(read(target))) expect(inner, `${target} imports ${inner}`).not.toMatch(RAW_NETWORK);
    }
    // The guard's test hooks are a test's to inject through the delivery's dependencies, never wired in the production file.
    expect(file).not.toMatch(/\b(anyPort|allowed|resolve|hostAllowed)\s*:/);
    // The answer is a status and nothing more: at most 4 KB read, truncated rather than refused, and never read as data in any form.
    const bytes = limits(file, 'maxBytes');
    expect(bytes, 'maxBytes: a literal or a constant of literals').not.toBeNull();
    for (const n of bytes ?? []) expect(n, 'maxBytes is 4096 at most').toBeLessThanOrEqual(4096);
    expect(file).toMatch(/overLimit\s*:\s*'truncate'/);
    expect(file).not.toMatch(/JSON\.parse\(|\.(json|text|arrayBuffer|blob|formData|body)\b|\bbody\.getReader\b/);
    const times = limits(file, 'timeoutMs');
    expect(times, 'timeoutMs: a literal or a constant of literals').not.toBeNull();
    for (const n of times ?? []) expect(n, 'timeoutMs is 10 s at most').toBeLessThanOrEqual(10_000);
    expect(file).toMatch(/createHmac\('sha256'/);
    // The headers a delivery sends are these and nothing else: no name or id can ride in a header of its own.
    const sent = [...file.matchAll(/['"](Ludy-[A-Za-z-]+)['"]/gi)].map((m) => (m[1] as string).toLowerCase());
    for (const h of new Set(sent)) expect(['ludy-event-id', 'ludy-timestamp', 'ludy-signature'], `header ${h}`).toContain(h);
    for (const h of ['ludy-event-id', 'ludy-timestamp', 'ludy-signature']) expect(sent, h).toContain(h);
  });

  it('never logs a secret or the signed body: the delivery file writes only codes, ids and counts', () => {
    if (!existsSync(join(ROOT, DELIVERY))) return;
    // Whole call expressions, so a call spread over several lines is read as one.
    for (const call of codeOf(DELIVERY).matchAll(/(?:console\.(?:log|warn|error|info|debug)|\blogger?\.\w+)\s*\(([\s\S]*?)\)\s*;/g)) {
      expect(call[0], call[0]).not.toMatch(/secret|sealed|signature|body|url|payload/i);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The body.
// ---------------------------------------------------------------------------------------------------------------------------------------------

const UUID = '0197a1c2-7b3e-7c11-9a55-3f2d8e6b4a10';
const UUID2 = '0197a1c2-7b3e-7c11-9a55-3f2d8e6b4a11';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
// A decimal string with no leading zero, so an account number is no amount.
const AMOUNT_RE = /^-?(0|[1-9]\d{0,17})(\.\d{1,4})?$/;
// The rules the kernel runs, by their read names (code under test): a new rule is a change to this protected file.
const RULES = [DEAL_WITHOUT_INVOICE_READ, RECEIVABLE_WITH_OPEN_DEAL_READ, SUPPLIER_BANK_CHANGED_READ];
// An item's key is its rule's short name and the ids it is about: lower-case words, then ids, never anything a person typed.
const KEY_RE = /^[a-z]+(_[a-z]+)*(:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}){1,3}$/;
const TYPES = ['signal.fired', 'schedule.due', 'ping'];
const SEVERITIES = ['info', 'warn', 'block'];
const TOP_KEYS = ['id', 'type', 'created_at', 'org', 'grant', 'data'];
const ITEM_KEYS = ['rule', 'key', 'severity', 'party_id', 'deal_id', 'invoice_id', 'amount', 'due_on', 'days'];

// A body is exactly the pinned keys, each value of its pinned shape: an id, a date, a number or one of a few fixed words. A name, a note or a message
// fits none of these, so none can ride in any field, whatever it is called. Returns what is wrong, or [].
function bodyProblems(body: unknown): string[] {
  const out: string[] = [];
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isObject(body)) return ['the body is not an object'];
  for (const k of Object.keys(body)) if (!TOP_KEYS.includes(k)) out.push(`unknown key ${k}`);
  for (const k of ['id', 'org', 'grant']) if (typeof body[k] !== 'string' || !UUID_RE.test(body[k])) out.push(`${k} is not an id`);
  if (typeof body.created_at !== 'string' || !INSTANT_RE.test(body.created_at)) out.push('created_at is not an instant');
  if (typeof body.type !== 'string' || !TYPES.includes(body.type)) out.push('type is not an event type');
  const data = body.data;
  if (!isObject(data)) return [...out, 'data is not an object'];
  if (body.type === 'ping') {
    if (Object.keys(data).length > 0) out.push('a ping carries no data');
  } else if (body.type === 'schedule.due') {
    for (const k of Object.keys(data)) if (k !== 'date') out.push(`unknown data key ${k}`);
    if (typeof data.date !== 'string' || !DATE_RE.test(data.date)) out.push('date is not a date');
  } else if (body.type === 'signal.fired') {
    for (const k of Object.keys(data)) if (k !== 'items') out.push(`unknown data key ${k}`);
    const items = data.items;
    if (!Array.isArray(items) || items.length < 1 || items.length > 20) return [...out, 'items is not one to twenty items'];
    for (const [i, item] of items.entries()) {
      if (!isObject(item)) {
        out.push(`item ${i} is not an object`);
        continue;
      }
      for (const k of Object.keys(item)) if (!ITEM_KEYS.includes(k)) out.push(`item ${i}: unknown key ${k}`);
      const str = (k: string, re: RegExp) => item[k] !== undefined && (typeof item[k] !== 'string' || !re.test(item[k])) && out.push(`item ${i}: ${k} has the wrong shape`);
      if (typeof item.rule !== 'string' || !RULES.includes(item.rule)) out.push(`item ${i}: rule has the wrong shape`);
      if (typeof item.key !== 'string' || !KEY_RE.test(item.key)) out.push(`item ${i}: key has the wrong shape`);
      if (typeof item.severity !== 'string' || !SEVERITIES.includes(item.severity)) out.push(`item ${i}: severity is not one of the three`);
      str('party_id', UUID_RE);
      str('deal_id', UUID_RE);
      str('invoice_id', UUID_RE);
      str('amount', AMOUNT_RE);
      str('due_on', DATE_RE);
      if (item.days !== undefined && (typeof item.days !== 'number' || !Number.isInteger(item.days) || item.days < 0 || item.days > 3650)) out.push(`item ${i}: days is not a day count`);
    }
  }
  return out;
}

const base = { id: UUID, org: UUID2, grant: UUID2, created_at: '2026-11-12T03:00:00.000Z' };
const item = { rule: DEAL_WITHOUT_INVOICE_READ, key: `deal_without_invoice:${UUID}`, severity: 'warn', party_id: UUID, deal_id: UUID2, amount: '12500000', due_on: '2026-11-19', days: 7 };
const VALID = [
  { ...base, type: 'signal.fired', data: { items: [item] } },
  { ...base, type: 'schedule.due', data: { date: '2026-11-12' } },
  { ...base, type: 'ping', data: {} },
];
// What a body must refuse, each with the thing that must not cross.
const HOSTILE: Array<[string, unknown]> = [
  ['a name beside the ids', { ...VALID[0], data: { items: [{ ...item, party_name: 'Công ty TNHH Nguyễn Văn A' }] } }],
  ['a note in a key of its own', { ...VALID[0], data: { items: [{ ...item, note: 'gọi lại khách trước thứ sáu' }] } }],
  ['text in the rule', { ...VALID[0], data: { items: [{ ...item, rule: 'Hợp đồng chưa có hóa đơn' }] } }],
  ['text in the key', { ...VALID[0], data: { items: [{ ...item, key: 'Nguyen Van A owes 12 million' }] } }],
  ['a name with underscores in the key', { ...VALID[0], data: { items: [{ ...item, key: ['Nguyen', 'Van', 'A', '0912345678'].join('_') }] } }],
  ['a name with underscores in the rule', { ...VALID[0], data: { items: [{ ...item, rule: 'kernel.signals.nguyen_van_a_no_tien' }] } }],
  ['an account number as the amount', { ...VALID[0], data: { items: [{ ...item, amount: '0123456789' }] } }],
  ['a bank account in the amount', { ...VALID[0], data: { items: [{ ...item, amount: '0123456789 Vietcombank' }] } }],
  ['an amount as a JS number', { ...VALID[0], data: { items: [{ ...item, amount: 12500000 }] } }],
  ['an email in an id', { ...VALID[0], data: { items: [{ ...item, party_id: 'khach@example.com' }] } }],
  ['a message body at the top', { ...VALID[0], message: 'Xin chào, hóa đơn của anh' }],
  ['free text in data beside the items', { ...VALID[0], data: { items: [item], summary: 'Hai khoản cần xem' } }],
  ['more than twenty items', { ...VALID[0], data: { items: Array.from({ length: 21 }, () => item) } }],
  ['a ping with data', { ...VALID[2], data: { note: 'x' } }],
  ['an unknown event type', { ...VALID[1], type: 'note.created' }],
  ['a date with text', { ...VALID[1], data: { date: 'thứ hai 12/11' } }],
];

describe('what a wake-up body may carry (#3024)', () => {
  it('accepts the three bodies the design lists and refuses what must not cross, by the pinned shapes', () => {
    for (const body of VALID) expect(bodyProblems(body), JSON.stringify(body)).toEqual([]);
    for (const [name, body] of HOSTILE) expect(bodyProblems(body), name).not.toEqual([]);
  });

  it('is built by one function that returns a body of exactly these shapes and refuses every hostile input', async () => {
    if (!existsSync(join(ROOT, BODY))) return;
    const mod = (await import(pathToFileURL(join(ROOT, BODY)).href)) as { wakeBody?: (input: unknown) => string };
    expect(typeof mod.wakeBody, `${BODY} exports wakeBody(event): string`).toBe('function');
    const wakeBody = mod.wakeBody as (input: unknown) => string;
    for (const body of VALID) {
      const text = wakeBody(body);
      expect(typeof text).toBe('string');
      const parsed: unknown = JSON.parse(text);
      expect(bodyProblems(parsed), text).toEqual([]);
      expect(parsed).toEqual(body);
    }
    for (const [name, body] of HOSTILE) {
      // Refused (a throw) or reduced to a body that still fits: never a body that carries the hostile part.
      let text: string | null = null;
      try {
        text = wakeBody(body);
      } catch {
        text = null;
      }
      if (text !== null) expect(bodyProblems(JSON.parse(text) as unknown), name).toEqual([]);
      for (const canary of ['Nguyễn', 'Nguyen Van A', 'Nguyen_Van_A', 'nguyen_van_a', '0123456789', 'khach@example.com', 'Vietcombank', 'Xin chào', 'gọi lại', 'Hai khoản', 'thứ hai']) {
        expect(text ?? '', `${name}: ${canary}`).not.toContain(canary);
      }
    }
  });

  it('is the only producer of the body: no other file builds one by its keys', () => {
    if (!existsSync(join(ROOT, DELIVERY))) return;
    // The delivery signs and posts the text the builder gave; it does not shape a body of its own.
    expect(codeOf(DELIVERY)).toMatch(/\bwakeBody\b/);
    expect(codeOf(DELIVERY)).not.toMatch(/\bcreated_at\s*:/);
  });

  it('has user-only commands for the wake-up setup that the agent actor cannot run (each checks the actor is a user and not an MCP grant, and none is open to a member), and system-only commands for its delivery', () => {
    for (const c of kernelCommands.filter((x) => x.name.startsWith('kernel.mcp.wake.'))) {
      // The system's own steps (enqueue, record, the sync of seen signals) are the system actor's alone, which the runtime enforces and the handler says again; no user, agent
      // or MCP grant runs one. Every other command is for an owner or an admin.
      if (c.access === 'system') {
        expect(String(c.handler), `${c.name} refuses any actor but the system`).toMatch(/actor\.type\s*!==\s*['"]system['"]/);
        expect((c as { mcp?: unknown }).mcp, c.name).toBeUndefined();
        continue;
      }
      const access = c.access as readonly string[];
      if (access.length > 0) {
        expect(access.every((r) => r === 'owner' || r === 'admin'), `${c.name} access`).toBe(true);
        expect(String(c.handler), `${c.name} refuses a non-user actor`).toMatch(/actor\.type\s*!==\s*['"]user['"]/);
        expect(String(c.handler), `${c.name} refuses an MCP grant`).toMatch(/actor\.mcp/);
        expect(['R2', 'R3', 'R4'], `${c.name} risk`).toContain(c.risk);
      }
      expect((c as { mcp?: unknown }).mcp, c.name).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The tables.
// ---------------------------------------------------------------------------------------------------------------------------------------------

// The statements of the migrations that create or alter a wake-up table, as text, SQL comments taken out.
function statements(table: string): string[] {
  return MIGRATIONS.flatMap((path) =>
    read(path)
      .replace(/--[^\n]*/g, '')
      .split(/;\s*\n/)
      .filter((st) => new RegExp(`\\b${table}\\b`).test(st))
      .map((st) => `${path}: ${st}`),
  );
}

// The columns a table gets, from its CREATE TABLE (a top-level comma list) and from every ADD COLUMN: [name, type].
function columnsOf(tables: readonly string[], table: string): Array<readonly [string, string]> {
  const out: Array<readonly [string, string]> = [];
  for (const st of tables) {
    const create = st.match(new RegExp(`CREATE TABLE(?: IF NOT EXISTS)?\\s+crove_kernel\\.${table}\\s*\\(([\\s\\S]*)\\)\\s*$`, 'i'));
    if (create) {
      let depth = 0;
      let current = '';
      const parts: string[] = [];
      for (const ch of create[1] as string) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) {
          parts.push(current);
          current = '';
        } else current += ch;
      }
      parts.push(current);
      for (const part of parts) {
        const m = part.trim().match(/^([a-z_][a-z0-9_]*)\s+([a-z]+(?:\[\])?)/i);
        if (m && !/^(primary|unique|foreign|check|constraint)$/i.test(m[1] as string)) out.push([m[1] as string, (m[2] as string).toLowerCase()]);
      }
    }
    for (const m of st.matchAll(new RegExp(`ALTER TABLE\\s+(?:ONLY\\s+)?crove_kernel\\.${table}\\b[\\s\\S]*?ADD COLUMN(?: IF NOT EXISTS)?\\s+([a-z_][a-z0-9_]*)\\s+([a-z]+(?:\\[\\])?)`, 'gi'))) out.push([m[1] as string, (m[2] as string).toLowerCase()]);
  }
  return out;
}

// Row-level security as every tenant table has it: apply_tenant_rls, or, for a table no login role may touch (reached only by definers, like agent_grant), row-level
// security enabled and the agent write guard installed.
const rlsOk = (all: string, table: string): boolean =>
  new RegExp(`apply_tenant_rls\\(\\s*'crove_kernel\\.${table}'`).test(all) ||
  (new RegExp(`ALTER TABLE\\s+crove_kernel\\.${table}\\s+ENABLE ROW LEVEL SECURITY`, 'i').test(all) && new RegExp(`agent_write_guard_install\\(\\s*'crove_kernel\\.${table}'`).test(all));

describe('what the grant wake-up tables may hold (#3024)', () => {
  it('keeps a secret only sealed, in the two named columns, puts the wake-up table under row-level security and ties it to its grant', () => {
    const tables = statements('agent_grant_wake');
    if (tables.length === 0) return;
    const columns = columnsOf(tables, 'agent_grant_wake');
    expect(columns.length, 'a migration creates crove_kernel.agent_grant_wake with its columns').toBeGreaterThan(5);
    // Every column that could hold a secret is one of the sealed ones, a key id or the public hint; none is plain text.
    for (const [name, type] of columns.filter(([n]) => /secret|token|signing|hmac|key|password|credential/i.test(n))) {
      expect(['secret_sealed', 'previous_sealed', 'secret_key_id', 'secret_hint'], `${name} ${type}`).toContain(name);
      if (name.endsWith('_sealed')) expect(['bytea', 'jsonb'], `${name} is sealed bytes or an envelope`).toContain(type);
    }
    const all = tables.join('\n');
    expect(rlsOk(all, 'agent_grant_wake'), 'row-level security: apply_tenant_rls, or enabled with the agent write guard on a definer-only table').toBe(true);
    expect(all, 'a foreign key to the grant, so revoking or expiring it reaches the wake-up').toMatch(/REFERENCES\s+crove_kernel\.agent_grant\s*\(/i);
  });

  it('keeps the delivery rows free of any secret column and under row-level security', () => {
    const tables = statements('agent_wake_delivery');
    if (tables.length === 0) return;
    for (const [name, type] of columnsOf(tables, 'agent_wake_delivery')) expect(name, `${name} ${type}`).not.toMatch(/secret|signature|hmac|token|password|credential/i);
    expect(rlsOk(tables.join('\n'), 'agent_wake_delivery'), 'row-level security on the delivery table').toBe(true);
  });
});
