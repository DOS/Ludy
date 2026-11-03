// SPDX-License-Identifier: AGPL-3.0-only
// The port's contract, run against the offline sandbox provider (ADR-0044 point 8): numbering, the idempotency key, the failure
// modes (slow, reject, a lost answer, pending), adjustment and replacement, and that no step needs a host or a credential
// that is not the sandbox's.
import { describe, expect, it } from 'vitest';
import { EInvoiceProviderError, SANDBOX_EINVOICE_SECRET, createSandboxEInvoiceProvider, isEInvoiceProvider, type EInvoiceRequest } from '../src/index.ts';

const request = (key: string, extra: Partial<EInvoiceRequest> = {}): EInvoiceRequest => ({
  key,
  templateNo: '1',
  symbol: 'C26TSB',
  date: '2026-11-03',
  currency: 'VND',
  seller: { taxCode: '0100000000', name: 'Công ty Thử Nghiệm' },
  buyer: { kind: 'business', taxCode: '0100000001', name: 'Công ty Mua', address: '1 Phố Thử, Hà Nội', email: null },
  lines: [
    { description: 'Hàng A', unit: 'cái', quantity: '2', unitPrice: '100000', amount: '200000', vatRate: '10%', vatAmount: '20000' },
    { description: 'Hàng B', unit: 'cái', quantity: '1', unitPrice: '50000', amount: '50000', vatRate: '8%', vatAmount: '4000' },
  ],
  subtotal: '250000',
  vatAmount: '24000',
  total: '274000',
  ...extra,
});

const secret = SANDBOX_EINVOICE_SECRET;
const instant = async (): Promise<void> => undefined;

describe('the offline e-invoice provider', () => {
  it('is a provider id, has no host and no cancel', () => {
    const { provider } = createSandboxEInvoiceProvider();
    expect(isEInvoiceProvider('sandbox')).toBe(true);
    expect(isEInvoiceProvider('misa')).toBe(false);
    expect(provider.hosts).toEqual([]);
    expect(provider.capabilities.cancel).toBe(false);
    expect(Object.keys(provider)).not.toContain('cancel');
  });

  it('tests the connection and lists templates and series only for its own credential', async () => {
    const { provider } = createSandboxEInvoiceProvider();
    expect(await provider.testConnection(secret)).toBe('works');
    expect(await provider.testConnection('other')).toBe('wrong_credentials');
    expect((await provider.listTemplates(secret)).map((t) => `${t.templateNo}/${t.symbol}`)).toEqual(['1/C26TSB', '2/C26TSM']);
    await expect(provider.listTemplates('other')).rejects.toMatchObject({ kind: 'credentials' });
  });

  it('numbers per series, signs, and returns an XML with the elements the intake reads', async () => {
    const { provider } = createSandboxEInvoiceProvider({ now: () => new Date('2026-11-03T03:00:00Z') });
    const first = await provider.issue(secret, request('11111111-1111-4111-8111-111111111111'));
    const second = await provider.issue(secret, request('22222222-2222-4222-8222-222222222222'));
    const other = await provider.issue(secret, request('33333333-3333-4333-8333-333333333333', { templateNo: '2', symbol: 'C26TSM' }));
    expect(first).toMatchObject({ state: 'issued', number: '0000001', signedAt: '2026-11-03T03:00:00.000Z' });
    expect(second).toMatchObject({ state: 'issued', number: '0000002' });
    expect(other).toMatchObject({ state: 'issued', number: '0000001' });
    if (first.state !== 'issued') throw new Error('not issued');
    expect(first.taxAuthorityCode).toMatch(/^SB[0-9A-F]{32}$/);
    const files = await provider.files(secret, first.ref);
    const xml = new TextDecoder().decode(files.xml);
    for (const part of ['<SHDon>0000001</SHDon>', '<KHHDon>C26TSB</KHHDon>', '<MST>0100000000</MST>', '<TgTTTBSo>274000</TgTTTBSo>', '<TgTThue>24000</TgTThue>', `<MCCQT>${first.taxAuthorityCode}</MCCQT>`]) expect(xml).toContain(part);
    // Totals per rate are the sums of the lines' own figures.
    expect(xml).toContain('<LTSuat><TSuat>10%</TSuat><ThTien>200000</ThTien><TThue>20000</TThue></LTSuat>');
    expect(xml).toContain('<LTSuat><TSuat>8%</TSuat><ThTien>50000</ThTien><TThue>4000</TThue></LTSuat>');
    expect(files.pdf).toBeNull();
  });

  it('escapes markup in what it was given', async () => {
    const { provider } = createSandboxEInvoiceProvider();
    const out = await provider.issue(secret, request('44444444-4444-4444-8444-444444444444', { buyer: { kind: 'consumer', taxCode: null, name: 'A & B <x>', address: null, email: null } }));
    if (out.state !== 'issued') throw new Error('not issued');
    const xml = new TextDecoder().decode((await provider.files(secret, out.ref)).xml);
    expect(xml).toContain('A &amp; B &lt;x&gt;');
    expect(xml).not.toContain('A & B <x>');
  });

  it('dedupes on Ludy\'s key: the same key is the same invoice', async () => {
    const { provider } = createSandboxEInvoiceProvider();
    const a = await provider.issue(secret, request('55555555-5555-4555-8555-555555555555'));
    const b = await provider.issue(secret, request('55555555-5555-4555-8555-555555555555'));
    expect(b).toEqual(a);
    const next = await provider.issue(secret, request('66666666-6666-4666-8666-666666666666'));
    expect(next).toMatchObject({ number: '0000002' });
  });

  it('rejects an unknown series and a scripted rejection, recording nothing', async () => {
    const { provider, control } = createSandboxEInvoiceProvider();
    expect(await provider.issue(secret, request('77777777-7777-4777-8777-777777777777', { symbol: 'C26TXX' }))).toEqual({ state: 'rejected', ref: null, code: 'series_unknown' });
    control.script('reject');
    expect(await provider.issue(secret, request('88888888-8888-4888-8888-888888888888'))).toEqual({ state: 'rejected', ref: null, code: 'rejected_by_tax_authority' });
    expect(await provider.status(secret, { key: '88888888-8888-4888-8888-888888888888', ref: null })).toEqual({ state: 'unknown' });
    // Fixed and sent again under the same key: a new invoice, number 1 (nothing was recorded for the rejected one).
    expect(await provider.issue(secret, request('88888888-8888-4888-8888-888888888888'))).toMatchObject({ state: 'issued', number: '0000001' });
  });

  it('answers pending for some polls and then issued', async () => {
    const { provider, control } = createSandboxEInvoiceProvider();
    control.pendingPolls = 2;
    control.script('pending');
    const key = '99999999-9999-4999-8999-999999999999';
    const out = await provider.issue(secret, request(key));
    expect(out.state).toBe('pending');
    expect((await provider.status(secret, { key, ref: null })).state).toBe('pending');
    expect((await provider.status(secret, { key, ref: null })).state).toBe('issued');
    if (out.state !== 'pending') throw new Error('not pending');
    await expect(provider.files(secret, out.ref)).resolves.toBeDefined();
  });

  it('refuses the files of a pending invoice', async () => {
    const { provider, control } = createSandboxEInvoiceProvider();
    control.pendingPolls = 3;
    control.script('pending');
    const out = await provider.issue(secret, request('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
    if (out.state !== 'pending') throw new Error('not pending');
    await expect(provider.files(secret, out.ref)).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('loses an answer but keeps the invoice, so a retry that asks the key first sends nothing twice', async () => {
    const { provider, control } = createSandboxEInvoiceProvider();
    control.script('lose_answer');
    const key = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await expect(provider.issue(secret, request(key))).rejects.toBeInstanceOf(EInvoiceProviderError);
    const asked = await provider.status(secret, { key, ref: null });
    expect(asked).toMatchObject({ state: 'issued', number: '0000001' });
    // A blind retry would dedupe on the key as well, never making a second invoice.
    expect(await provider.issue(secret, request(key))).toEqual(asked);
    expect(control.calls.filter((c) => c.startsWith('issue:'))).toHaveLength(2);
  });

  it('can be slow', async () => {
    const waited: number[] = [];
    const { provider, control } = createSandboxEInvoiceProvider({ wait: async (ms) => void waited.push(ms) });
    control.slowMs = 1234;
    control.script('slow');
    expect(await provider.issue(secret, request('cccccccc-cccc-4ccc-8ccc-cccccccccccc'))).toMatchObject({ state: 'issued' });
    expect(waited).toEqual([1234]);
    const { provider: quick } = createSandboxEInvoiceProvider({ wait: instant });
    expect(await quick.issue(secret, request('dddddddd-dddd-4ddd-8ddd-dddddddddddd'))).toMatchObject({ state: 'issued' });
  });

  it('answers a repeat that arrives while the first waits with the same invoice, never a second number', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { provider, control } = createSandboxEInvoiceProvider({ wait: () => gate });
    control.script('slow');
    const key = '11111111-2222-4333-8444-555555555555';
    const first = provider.issue(secret, request(key));
    const second = provider.issue(secret, request(key));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(b).toEqual(a);
    expect(a).toMatchObject({ state: 'issued', number: '0000001' });
    expect(await provider.issue(secret, request('66666666-7777-4888-8999-000000000000'))).toMatchObject({ number: '0000002' });
  });

  it('adjusts and replaces with the original in the XML, as new invoices', async () => {
    const { provider } = createSandboxEInvoiceProvider();
    const original = await provider.issue(secret, request('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'));
    if (original.state !== 'issued') throw new Error('not issued');
    const ref = { kind: 'adjustment' as const, templateNo: '1', symbol: 'C26TSB', number: original.number, date: '2026-11-03' };
    const adjusted = await provider.adjust(secret, { ...request('ffffffff-ffff-4fff-8fff-ffffffffffff'), original: ref });
    if (adjusted.state !== 'issued') throw new Error('not issued');
    expect(adjusted.number).toBe('0000002');
    const xml = new TextDecoder().decode((await provider.files(secret, adjusted.ref)).xml);
    expect(xml).toContain('<TCHDon>2</TCHDon>');
    expect(xml).toContain('<SHDCLQuan>0000001</SHDCLQuan>');
    const replaced = await provider.replace(secret, { ...request('00000000-0000-4000-8000-000000000001'), original: { ...ref, kind: 'replacement' } });
    if (replaced.state !== 'issued') throw new Error('not issued');
    expect(new TextDecoder().decode((await provider.files(secret, replaced.ref)).xml)).toContain('<TCHDon>1</TCHDon>');
  });

  it('never records a credential', async () => {
    const { provider, control } = createSandboxEInvoiceProvider();
    await provider.issue(secret, request('00000000-0000-4000-8000-000000000002'));
    expect(JSON.stringify(control.calls)).not.toContain(secret);
  });
});
