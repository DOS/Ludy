// SPDX-License-Identifier: AGPL-3.0-only
// The MISA meInvoice adapter (#2503) against recorded answers shaped by MISA's own developer document: nothing here reaches a network. The checks: the request it writes (headers,
// SignType 2, the key as RefID, exact numbers), how each answer and error code ends a step, that a lost answer is asked about before anything is sent again, that the USB-token
// path is never called, the document's limits as data, and that the adapter is off until its gates are written.
import { describe, expect, it } from 'vitest';
import { ADJUST_REPLACE_REASON_CODES, EInvoiceProviderError, MISA_GATES, MISA_GATES_DONE, MISA_HOSTS, createMisaEInvoiceProvider, isEInvoiceProvider, misaBlockers } from '../src/index.ts';
import type { MisaRequest } from '../src/index.ts';
import { DRAFT_ID, REF, SECRET, answers, invoiceXml, lost, replay, request, type Step } from './misa-recorded.ts';

const fixedNow = () => new Date('2026-11-03T03:00:00Z');
const T = '/invoice/token';
// A stand-in list for the tests: the real list is data (reason-codes.ts) and is empty until it is read from MISA's guide; these two codes are made up for the tests and mean nothing.
const TEST_CODES = [
  { code: 'TEST-1', label: 'Mã thử nghiệm 1' },
  { code: 'TEST-2', label: 'Mã thử nghiệm 2' },
] as const;
const make = (script: Record<string, Step[]>) => {
  const r = replay({ [T]: [answers.token()], ...script });
  return { ...r, provider: createMisaEInvoiceProvider({ transport: r.transport, now: fixedNow, reasonCodes: TEST_CODES }) };
};
const bodyOf = (call: { body: string | null } | undefined): Record<string, unknown> => JSON.parse(call?.body ?? 'null') as Record<string, unknown>;
const publishing = (calls: readonly MisaRequest[]) => calls.filter((c) => c.url.endsWith('/invoice/publishing'));

describe('MISA adapter: what it declares', () => {
  it('is a provider id on one host, signs with the provider HSM, has no cancel and carries the document\'s limits as data', () => {
    const { provider } = make({});
    expect(isEInvoiceProvider('misa')).toBe(true);
    expect(provider.id).toBe('misa');
    expect(provider.hosts).toEqual([...MISA_HOSTS]);
    expect(provider.hosts).toEqual(['developer.misa.vn']);
    expect(provider.connectFields).toEqual(['clientId', 'clientSecret', 'taxCode', 'username', 'password']);
    expect(provider.capabilities).toMatchObject({ cancel: false, signing: 'provider_hsm', batchSize: 30, maxLinesPerInvoice: 400, sequentialPerSeries: true });
    expect(provider.capabilities.retry.issue).toBe('reconcile_only');
    expect(Object.keys(provider)).not.toContain('cancel');
  });
});

describe('MISA adapter: it is off until its gates are written', () => {
  it('names #2506 and #2507 as blockers and has none of them done', () => {
    expect(MISA_GATES.map((g) => g.issue)).toEqual([2506, 2507]);
    expect(MISA_GATES_DONE).toEqual([]);
    expect(misaBlockers().map((g) => g.issue)).toEqual([2506, 2507]);
    expect(misaBlockers([2506]).map((g) => g.issue)).toEqual([2507]);
    expect(misaBlockers([2506, 2507])).toEqual([]);
  });
});

describe('MISA adapter: connection test', () => {
  it('works with an account that holds a remote certificate, and sends the app and the account as the document says', async () => {
    const { provider, calls } = make({ '/invoice/get-certificates': [answers.certificates(1)] });
    expect(await provider.testConnection(SECRET)).toBe('works');
    const login = calls[0];
    expect(login?.method).toBe('POST');
    expect(login?.url).toBe('https://developer.misa.vn/apis/itg/meinvoice/invoice/token');
    expect(login?.headers).toMatchObject({ ClientID: '00000000-0000-4000-8000-0000000000c1', ClientSecret: 'recorded-client-secret', 'Content-Type': 'application/json' });
    expect(bodyOf(login)).toEqual({ taxcode: '0100000000', username: 'seller@example.test', password: 'recorded-password' });
    expect(calls[1]?.headers.Authorization).toBe('Bearer recorded-token-1');
  });

  it('needs a person when the account has no remote certificate (a USB token cannot be used by a server)', async () => {
    const { provider, calls } = make({ '/invoice/get-certificates': [answers.certificates(0)] });
    expect(await provider.testConnection(SECRET)).toBe('signing_needs_person');
    expect(calls.some((c) => c.url.includes('publishing/token') || c.url.includes('12019'))).toBe(false);
  });

  it('needs a person at the second step, and says wrong credentials, app off and unreachable for what they are', async () => {
    expect(await make({ [T]: [answers.twoStep()] }).provider.testConnection(SECRET)).toBe('signing_needs_person');
    expect(await make({ [T]: [answers.failed('UnAuthorize')] }).provider.testConnection(SECRET)).toBe('wrong_credentials');
    expect(await make({ [T]: [answers.failed('InActiveAppID')] }).provider.testConnection(SECRET)).toBe('api_not_enabled');
    expect(await make({ [T]: [answers.tooMany()] }).provider.testConnection(SECRET)).toBe('unreachable');
    expect(await make({ [T]: [new Error('connect refused')] }).provider.testConnection(SECRET)).toBe('unreachable');
    expect(await make({}).provider.testConnection('not json')).toBe('wrong_credentials');
    expect(await make({}).provider.testConnection(JSON.stringify({ clientId: 'x' }))).toBe('wrong_credentials');
  });
});

describe('MISA adapter: templates and series', () => {
  it('lists the normal coded series, split into the template number and the symbol, for the year', async () => {
    const { provider, calls } = make({ '/invoice/templates': [answers.templates()] });
    expect(await provider.listTemplates(SECRET)).toEqual([
      { templateNo: '1', symbol: 'C26TYY', description: 'Hóa đơn GTGT' },
      { templateNo: '2', symbol: 'C26TAA', description: 'Hóa đơn bán hàng' },
    ]);
    const asked = new URL(calls[1]?.url ?? '');
    expect(Object.fromEntries(asked.searchParams)).toEqual({ invoiceWithCode: 'true', ticket: 'false', year: '2026', haveTempOld: 'false' });
    expect(calls[1]?.method).toBe('GET');
  });
});

describe('MISA adapter: issue', () => {
  it('sends SignType 2 with Ludy\'s key as RefID and exact numbers, and answers pending until the tax authority\'s code arrives', async () => {
    const { provider, calls } = make({ '/invoice/publishing': [answers.published()] });
    const out = await provider.issue(SECRET, request({ lines: [{ description: 'Hàng', unit: null, quantity: '1', unitPrice: '12345678901234.12345678', amount: '12345678901234.12345678', vatRate: '10%', vatAmount: '1234567890123.41234568' }], subtotal: '12345678901234.12345678', vatAmount: '1234567890123.41234568', total: '13580246791357.5358' }));
    expect(out).toEqual({ state: 'pending', ref: REF });
    const sent = publishing(calls)[0];
    expect(sent?.headers).toMatchObject({ ClientID: '00000000-0000-4000-8000-0000000000c1', Authorization: 'Bearer recorded-token-1' });
    const body = sent?.body ?? '';
    // The numbers are written as numbers, digit for digit, never through a float.
    expect(body).toContain('"UnitPrice":12345678901234.12345678');
    expect(body).toContain('"TotalAmountOC":13580246791357.5358');
    expect(body).not.toMatch(/"(UnitPrice|AmountOC|TotalAmountOC)":"/);
    const parsed = JSON.parse(body) as { SignType: number; InvoiceData: Record<string, unknown>[] };
    expect(parsed.SignType).toBe(2);
    expect(parsed.InvoiceData).toHaveLength(1);
    expect(parsed.InvoiceData[0]).toMatchObject({ RefID: DRAFT_ID, InvSeries: '1C26TYY', InvTemplateNo: '1', InvDate: '2026-11-03', CurrencyCode: 'VND', IsSendEmail: false, BuyerLegalName: 'Công ty Mua', BuyerTaxCode: '0100000001' });
    expect(parsed.InvoiceData[0]).not.toHaveProperty('ReferenceType');
  });

  it('is issued at once with the number and the code when MISA answers with both', async () => {
    const { provider } = make({ '/invoice/publishing': [answers.published({ InvCode: 'M1-26-ABCDE-00000000001' })] });
    expect(await provider.issue(SECRET, request())).toEqual({ state: 'issued', ref: REF, number: '00000001', signedAt: '2026-11-03T03:00:00.000Z', taxAuthorityCode: 'M1-26-ABCDE-00000000001' });
  });

  it('writes the totals per rate and the digits the figures carry', async () => {
    const { provider, calls } = make({ '/invoice/publishing': [answers.published()] });
    await provider.issue(SECRET, request());
    const data = (JSON.parse(publishing(calls)[0]?.body ?? '') as { InvoiceData: Record<string, unknown>[] }).InvoiceData[0] ?? {};
    expect(data.TaxRateInfo).toEqual([
      { VATRateName: '10%', AmountWithoutVATOC: 200000, VATAmountOC: 20000 },
      { VATRateName: '8%', AmountWithoutVATOC: 75000, VATAmountOC: 6000 },
    ]);
    expect(data.OptionUserDefined).toMatchObject({ MainCurrency: 'VND', QuantityDecimalDigits: '1', UnitPriceOCDecimalDigits: '0', AmountOCDecimalDigits: '0' });
    expect((data.OriginalInvoiceDetail as Record<string, unknown>[])[1]).toMatchObject({ ItemType: 1, SortOrder: 2, LineNumber: 2, ItemName: 'Hàng B', Quantity: 1.5, VATRateName: '8%', VATAmountOC: 6000 });
  });

  it('names other rates as the document does', async () => {
    const { provider, calls } = make({ '/invoice/publishing': [answers.published()] });
    await provider.issue(SECRET, request({ lines: [{ description: 'A', unit: null, quantity: '1', unitPrice: '100', amount: '100', vatRate: '3.5', vatAmount: '3.5' }, { description: 'B', unit: null, quantity: '1', unitPrice: '100', amount: '100', vatRate: 'KCT', vatAmount: '0' }], subtotal: '200', vatAmount: '3.5', total: '203.5' }));
    const data = (JSON.parse(publishing(calls)[0]?.body ?? '') as { InvoiceData: { OriginalInvoiceDetail: { VATRateName: string }[] }[] }).InvoiceData[0];
    expect(data?.OriginalInvoiceDetail.map((l) => l.VATRateName)).toEqual(['KHAC:3.5%', 'KCT']);
  });

  it('refuses before any call a passport\'s nationality while MISA\'s field name for it is unset, as it does for the identity (#3709)', async () => {
    const { provider, calls } = make({});
    const buyer = { kind: 'individual', taxCode: null, name: 'John Smith', address: null, email: null } as const;
    expect(await provider.issue(SECRET, request({ buyer: { ...buyer, identity: { kind: 'passport', value: 'B1234567', nationality: 'US' } } }))).toEqual({ state: 'rejected', ref: null, code: 'invalid_data' });
    // The identity alone is refused too while its own names are unset, so a nationality can never be sent without the passport it belongs to.
    expect(await provider.issue(SECRET, request({ buyer: { ...buyer, identity: { kind: 'passport', value: 'B1234567' } } }))).toEqual({ state: 'rejected', ref: null, code: 'invalid_data' });
    expect(calls).toHaveLength(0);
  });

  it('writes the consumer label a request carries as the buyer\'s name, and no business name (#3709)', async () => {
    const { provider, calls } = make({ '/invoice/publishing': [answers.published()] });
    await provider.issue(SECRET, request({ buyer: { kind: 'consumer', taxCode: null, name: 'Bán cho người tiêu dùng', address: null, email: null } }));
    const data = (JSON.parse(publishing(calls)[0]?.body ?? '') as { InvoiceData: Array<Record<string, unknown>> }).InvoiceData[0];
    expect(data?.BuyerFullName).toBe('Bán cho người tiêu dùng');
    expect(data?.BuyerLegalName).toBeUndefined();
  });

  it('refuses before sending what the document\'s limits or shapes forbid', async () => {
    const { provider, calls } = make({});
    const line = request().lines[0] as EInvoiceLineLike;
    expect(await provider.issue(SECRET, request({ currency: 'USD' }))).toEqual({ state: 'rejected', ref: null, code: 'invalid_data' });
    expect(await provider.issue(SECRET, request({ lines: Array.from({ length: 401 }, () => line) }))).toEqual({ state: 'rejected', ref: null, code: 'invalid_data' });
    expect(await provider.issue(SECRET, request({ lines: [] }))).toEqual({ state: 'rejected', ref: null, code: 'invalid_data' });
    expect(await provider.issue(SECRET, request({ symbol: 'XX' }))).toEqual({ state: 'rejected', ref: null, code: 'series_unknown' });
    expect(await provider.issue(SECRET, request({ lines: [{ ...line, vatRate: 'abc' }] }))).toEqual({ state: 'rejected', ref: null, code: 'invalid_data' });
    expect(await provider.issue(SECRET, request({ lines: [{ ...line, amount: '1e3' }] }))).toEqual({ state: 'rejected', ref: null, code: 'invalid_data' });
    expect(await provider.issue(SECRET, request({ total: '12,5' }))).toEqual({ state: 'rejected', ref: null, code: 'invalid_data' });
    expect(calls).toHaveLength(0);
  });

  it('accepts exactly 400 lines', async () => {
    const { provider } = make({ '/invoice/publishing': [answers.published({ InvCode: 'C' })] });
    const line = request().lines[0] as EInvoiceLineLike;
    expect((await provider.issue(SECRET, request({ lines: Array.from({ length: 400 }, () => line) }))).state).toBe('issued');
  });

  it('ends a step by the document\'s codes', async () => {
    const ended = async (code: string, itemLevel = true) => (await make({ '/invoice/publishing': [answers.publishError(code, itemLevel)] }).provider.issue(SECRET, request()));
    expect(await ended('TemplateNotExist')).toEqual({ state: 'rejected', ref: null, code: 'series_unknown' });
    expect(await ended('InvoiceTemplateNotExist', false)).toEqual({ state: 'rejected', ref: null, code: 'series_unknown' });
    expect(await ended('RequireError_BuyerAddress')).toEqual({ state: 'rejected', ref: null, code: 'invalid_data' });
    expect(await ended('InvoiceDetail_Quantity')).toEqual({ state: 'rejected', ref: null, code: 'invalid_data' });
    expect(await ended('BuyerTaxCode_TaxCodeInvalid')).toEqual({ state: 'rejected', ref: null, code: 'invalid_data' });
    expect(await ended('ExistsInvoiceNextYear')).toEqual({ state: 'rejected', ref: null, code: 'provider_refused' });
    expect(await ended('LicenseInfo_OutOfInvoice', false)).toEqual({ state: 'rejected', ref: null, code: 'provider_refused' });
    expect(await ended('CallSignServiceFail')).toEqual({ state: 'rejected', ref: null, code: 'provider_refused' });
  });

  it('asks for the key before reading a code the document does not list as a refusal, and does not turn a failed question into a certain failure', async () => {
    const unlisted = make({ '/invoice/publishing': [answers.publishError('SomethingTheDocumentDoesNotList')], '/invoice/status': [answers.statusEmpty()] });
    await expect(unlisted.provider.issue(SECRET, request())).rejects.toMatchObject({ kind: 'lost_answer' });
    const found = make({ '/invoice/publishing': [answers.publishError('SomethingTheDocumentDoesNotList')], '/invoice/status': [answers.status({ SendTaxStatus: 0 })], '/invoice/Download': [answers.xml()] });
    expect(await found.provider.issue(SECRET, request())).toEqual({ state: 'pending', ref: REF });
    // The question itself is refused (the token is not accepted twice): the invoice may exist, so it is a lost answer, never "credentials".
    const refused = make({ '/invoice/publishing': [answers.publishError('SystemError', false)], '/invoice/status': [answers.failed('UnAuthorize')] });
    await expect(refused.provider.issue(SECRET, request())).rejects.toMatchObject({ kind: 'lost_answer' });
  });

  it('writes a rate the finance module stores as KHAC:x%', async () => {
    const { provider, calls } = make({ '/invoice/publishing': [answers.published()] });
    await provider.issue(SECRET, request({ lines: [{ description: 'A', unit: null, quantity: '1', unitPrice: '100', amount: '100', vatRate: 'KHAC:5.26%', vatAmount: '5.26' }], subtotal: '100', vatAmount: '5.26', total: '105.26' }));
    expect(publishing(calls)[0]?.body).toContain('"VATRateName":"KHAC:5.26%"');
  });

  it('answers a duplicate of the key with the invoice MISA holds under it', async () => {
    const { provider, calls } = make({ '/invoice/publishing': [answers.publishError('DuplicateInvoiceRefID')], '/invoice/status': [answers.status({ InvoiceCode: 'M1-26-ABCDE-00000000001' })], '/invoice/Download': [answers.xml()] });
    expect(await provider.issue(SECRET, request())).toEqual({ state: 'issued', ref: REF, number: '00000001', signedAt: '2026-11-03T03:00:00.000Z', taxAuthorityCode: 'M1-26-ABCDE-00000000001' });
    const asked = new URL(calls.find((c) => c.url.includes('/invoice/status'))?.url ?? '');
    expect(asked.searchParams.get('inputType')).toBe('2');
    expect(bodyOf(calls.find((c) => c.url.includes('/invoice/status')))).toEqual([DRAFT_ID]);
  });

  it('does not guess when MISA calls it a duplicate but knows no such key', async () => {
    const { provider } = make({ '/invoice/publishing': [answers.publishError('DuplicateInvoiceRefID')], '/invoice/status': [answers.statusEmpty()] });
    await expect(provider.issue(SECRET, request())).rejects.toMatchObject({ kind: 'lost_answer' });
  });

  it('sends again after the document\'s retry codes only once the key was asked for and found nowhere', async () => {
    const { provider, count } = make({ '/invoice/publishing': [answers.publishError('InvoiceNumberNotCotinuous'), answers.published({ InvCode: 'C' })], '/invoice/status': [answers.statusEmpty()] });
    expect((await provider.issue(SECRET, request())).state).toBe('issued');
    expect(count('/invoice/publishing')).toBe(2);
    expect(count('/invoice/status')).toBe(1);
  });

  it('returns what the key already is instead of sending again after a retry code', async () => {
    const { provider, count } = make({ '/invoice/publishing': [answers.publishError('InvoiceDuplicated')], '/invoice/status': [answers.status({ SendTaxStatus: 0 })], '/invoice/Download': [answers.xml()] });
    expect(await provider.issue(SECRET, request())).toEqual({ state: 'pending', ref: REF });
    expect(count('/invoice/publishing')).toBe(1);
  });

  it('gives up after three tries at a retry code', async () => {
    const { provider, count } = make({ '/invoice/publishing': [answers.publishError('InvoiceDuplicated')], '/invoice/status': [answers.statusEmpty()] });
    await expect(provider.issue(SECRET, request())).rejects.toMatchObject({ kind: 'lost_answer' });
    expect(count('/invoice/publishing')).toBe(3);
  });

  it('asks before sending again after an answer that does not say whether the invoice was made', async () => {
    const { provider, count } = make({ '/invoice/publishing': [answers.publishError('SystemError', false)], '/invoice/status': [answers.statusEmpty()] });
    await expect(provider.issue(SECRET, request())).rejects.toMatchObject({ kind: 'lost_answer' });
    expect(count('/invoice/publishing')).toBe(1);
  });

  it('is a lost answer when the request may have reached MISA, unavailable at a rate limit, credentials when the account is refused', async () => {
    await expect(make({ '/invoice/publishing': [new Error('socket hang up')] }).provider.issue(SECRET, request())).rejects.toMatchObject({ kind: 'lost_answer' });
    await expect(make({ '/invoice/publishing': [{ status: 502, body: '<html>bad gateway</html>' }] }).provider.issue(SECRET, request())).rejects.toMatchObject({ kind: 'lost_answer' });
    await expect(make({ '/invoice/publishing': [answers.tooMany()] }).provider.issue(SECRET, request())).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(make({ [T]: [answers.failed('UnAuthorize')] }).provider.issue(SECRET, request())).rejects.toMatchObject({ kind: 'credentials' });
    await expect(make({}).provider.issue('{}', request())).rejects.toMatchObject({ kind: 'credentials' });
    const none = make({ '/invoice/publishing': [new EInvoiceProviderError('unreachable')] });
    await expect(none.provider.issue(SECRET, request())).rejects.toMatchObject({ kind: 'unreachable' });
  });

  it('logs in again once when the token is refused, and keeps the token between calls', async () => {
    const { provider, count, calls } = make({ [T]: [answers.token('t1'), answers.token('t2')], '/invoice/publishing': [answers.failed('TokenExpiredCode'), answers.published({ InvCode: 'C' })], '/invoice/get-certificates': [answers.certificates(1)] });
    expect((await provider.issue(SECRET, request())).state).toBe('issued');
    expect(count(T)).toBe(2);
    expect(publishing(calls).map((c) => c.headers.Authorization)).toEqual(['Bearer t1', 'Bearer t2']);
    await provider.testConnection(SECRET);
    // The connection test logs in fresh; the issue before it had used the held token.
    expect(count(T)).toBe(3);
  });

  it('does not log in again for a second refusal', async () => {
    const { provider, count } = make({ '/invoice/publishing': [answers.failed('InvalidTokenCode')] });
    await expect(provider.issue(SECRET, request())).rejects.toMatchObject({ kind: 'credentials' });
    expect(count(T)).toBe(2);
  });

  it('sends the requests of one series one at a time', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inFlight = 0;
    let most = 0;
    const slow: Step = async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await gate;
      inFlight -= 1;
      return answers.published({ InvCode: 'C' });
    };
    const { provider } = make({ '/invoice/publishing': [slow] });
    const first = provider.issue(SECRET, request({ key: '11111111-1111-4111-8111-111111111111' }));
    const second = provider.issue(SECRET, request({ key: '22222222-2222-4222-8222-222222222222' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(most).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(most).toBe(1);
  });
});

type EInvoiceLineLike = ReturnType<typeof request>['lines'][number];

describe('MISA adapter: adjustment and replacement', () => {
  const original = { templateNo: '1', symbol: 'C26TYY', number: '00000001', date: '2026-11-03', reasonCode: 'TEST-1' };

  it('names the original, as the document\'s ReferenceType and Org fields', async () => {
    const { provider, calls } = make({ '/invoice/publishing': [answers.published({ InvCode: 'C' })] });
    await provider.adjust(SECRET, { ...request(), original: { ...original, kind: 'adjustment' } });
    await provider.replace(SECRET, { ...request(), original: { ...original, kind: 'replacement' } });
    const [adjust, replace] = publishing(calls).map((c) => (JSON.parse(c.body ?? '') as { SignType: number; InvoiceData: Record<string, unknown>[] }));
    expect(adjust?.SignType).toBe(2);
    expect(adjust?.InvoiceData[0]).toMatchObject({ ReferenceType: 2, OrgInvoiceType: 1, OrgInvTemplateNo: '1', OrgInvSeries: 'C26TYY', OrgInvNo: '00000001', OrgInvDate: '2026-11-03' });
    expect(replace?.InvoiceData[0]).toMatchObject({ ReferenceType: 1, OrgInvNo: '00000001' });
  });

  it('sends the reason code with the original, on an adjustment and on a replacement (#3571)', async () => {
    const { provider, calls } = make({ '/invoice/publishing': [answers.published({ InvCode: 'C' })] });
    await provider.adjust(SECRET, { ...request(), original: { ...original, kind: 'adjustment', reasonCode: 'TEST-1' } });
    await provider.replace(SECRET, { ...request(), original: { ...original, kind: 'replacement', reasonCode: 'TEST-2' } });
    const [adjust, replace] = publishing(calls).map((c) => (JSON.parse(c.body ?? '') as { InvoiceData: Record<string, unknown>[] }));
    expect(adjust?.InvoiceData[0]).toMatchObject({ ReferenceType: 2, AdjustReplaceReasonCode: 'TEST-1' });
    expect(replace?.InvoiceData[0]).toMatchObject({ ReferenceType: 1, AdjustReplaceReasonCode: 'TEST-2' });
  });

  it('refuses a missing or unknown reason code before any call, and a plain invoice carries none', async () => {
    const { provider, calls } = make({ '/invoice/publishing': [answers.published({ InvCode: 'C' })] });
    const refused = { state: 'rejected', ref: null, code: 'invalid_data' };
    for (const reasonCode of ['', 'NOT-IN-THE-LIST', ' TEST-1']) {
      expect(await provider.adjust(SECRET, { ...request(), original: { ...original, kind: 'adjustment', reasonCode } })).toEqual(refused);
      expect(await provider.replace(SECRET, { ...request(), original: { ...original, kind: 'replacement', reasonCode } })).toEqual(refused);
    }
    const missing = { ...original, kind: 'adjustment' as const } as Partial<typeof original> & { kind: 'adjustment' };
    delete missing.reasonCode;
    expect(await provider.adjust(SECRET, { ...request(), original: missing as never })).toEqual(refused);
    expect(calls).toEqual([]);
    await provider.issue(SECRET, request());
    expect('AdjustReplaceReasonCode' in ((bodyOf(publishing(calls)[0]).InvoiceData as Record<string, unknown>[])[0] ?? {})).toBe(false);
  });

  it('refuses every adjustment and replacement while the real list is empty (no code is invented)', async () => {
    const r = replay({ [T]: [answers.token()], '/invoice/publishing': [answers.published({ InvCode: 'C' })] });
    const provider = createMisaEInvoiceProvider({ transport: r.transport, now: fixedNow });
    expect(ADJUST_REPLACE_REASON_CODES.codes).toEqual([]);
    expect(await provider.adjust(SECRET, { ...request(), original: { ...original, kind: 'adjustment' } })).toEqual({ state: 'rejected', ref: null, code: 'invalid_data' });
    expect(r.calls).toEqual([]);
  });

  it('is refused by the document\'s business codes as a refusal of the provider', async () => {
    const { provider } = make({ '/invoice/publishing': [answers.publishError('HasAdjustmentInvoice')] });
    expect(await provider.replace(SECRET, { ...request(), original: { ...original, kind: 'replacement' } })).toEqual({ state: 'rejected', ref: null, code: 'provider_refused' });
  });
});

describe('MISA adapter: status', () => {
  it('reads the number and the code, by the key', async () => {
    const { provider } = make({ '/invoice/status': [answers.status({ InvoiceCode: 'M1-26-ABCDE-00000000001' })], '/invoice/Download': [answers.xml()] });
    expect(await provider.status(SECRET, { key: DRAFT_ID, ref: null })).toEqual({ state: 'issued', ref: REF, number: '00000001', signedAt: '2026-11-03T03:00:00.000Z', taxAuthorityCode: 'M1-26-ABCDE-00000000001' });
  });

  it('reads a code that is only in the XML', async () => {
    const { provider } = make({ '/invoice/status': [answers.status()], '/invoice/Download': [answers.xml(invoiceXml('<MCCQT>M1-26-XML-1</MCCQT>'))] });
    expect(await provider.status(SECRET, { key: DRAFT_ID, ref: null })).toMatchObject({ state: 'issued', taxAuthorityCode: 'M1-26-XML-1' });
  });

  it('is pending while the tax authority has not given the code, and while MISA is still working', async () => {
    const waiting = make({ '/invoice/status': [answers.status({ SendTaxStatus: 0 })], '/invoice/Download': [answers.xml()] });
    expect(await waiting.provider.status(SECRET, { key: DRAFT_ID, ref: null })).toEqual({ state: 'pending', ref: REF });
    const working = make({ '/invoice/status': [answers.status({ PublishStatus: 0 })] });
    expect(await working.provider.status(SECRET, { key: DRAFT_ID, ref: null })).toEqual({ state: 'pending', ref: REF });
    expect(working.count('/invoice/Download')).toBe(0);
  });

  it('is rejected when the tax authority refuses the code or MISA failed the invoice', async () => {
    const refused = make({ '/invoice/status': [answers.status({ SendTaxStatus: 3 })], '/invoice/Download': [answers.xml()] });
    expect(await refused.provider.status(SECRET, { key: DRAFT_ID, ref: null })).toEqual({ state: 'rejected', ref: REF, code: 'rejected_by_tax_authority' });
    const failed = make({ '/invoice/status': [answers.status({ PublishStatus: -1 })] });
    expect(await failed.provider.status(SECRET, { key: DRAFT_ID, ref: null })).toEqual({ state: 'rejected', ref: REF, code: 'provider_refused' });
  });

  it('is unknown when MISA has no record under the key, and tries the reference next', async () => {
    expect(await make({ '/invoice/status': [answers.statusEmpty()] }).provider.status(SECRET, { key: DRAFT_ID, ref: null })).toEqual({ state: 'unknown' });
    expect(await make({ '/invoice/status': [answers.statusNotFound()] }).provider.status(SECRET, { key: DRAFT_ID, ref: null })).toEqual({ state: 'unknown' });
    const byRef = make({ '/invoice/status': [answers.statusEmpty(), answers.status({ SendTaxStatus: 0 })], '/invoice/Download': [answers.xml()] });
    expect(await byRef.provider.status(SECRET, { key: DRAFT_ID, ref: REF })).toEqual({ state: 'pending', ref: REF });
    expect(byRef.calls.filter((c) => c.url.includes('/invoice/status')).map((c) => new URL(c.url).searchParams.get('inputType'))).toEqual(['2', '1']);
  });

  it('does not read a status it does not understand as issued', async () => {
    const { provider } = make({ '/invoice/status': [answers.status({ PublishStatus: 7 })] });
    await expect(provider.status(SECRET, { key: DRAFT_ID, ref: null })).rejects.toMatchObject({ kind: 'unavailable' });
  });
});

describe('MISA adapter: files', () => {
  it('returns the signed XML and the PDF', async () => {
    const pdf = Buffer.from('%PDF-1.7 recorded');
    const { provider, calls } = make({ '/invoice/Download': [answers.xml(), answers.pdf(pdf)] });
    const files = await provider.files(SECRET, REF);
    expect(new TextDecoder().decode(files.xml)).toContain('<SHDon>00000001</SHDon>');
    expect(Buffer.from(files.pdf ?? new Uint8Array()).equals(pdf)).toBe(true);
    const asked = calls.filter((c) => c.url.includes('/invoice/Download')).map((c) => new URL(c.url).searchParams.get('downloadDataType'));
    expect(asked).toEqual(['Xml', 'Pdf']);
    expect(bodyOf(calls.at(-1))).toEqual([REF]);
  });

  it('reads an XML that comes as base64, and keeps the XML when the PDF is not one', async () => {
    const based = Buffer.from(invoiceXml(), 'utf8').toString('base64');
    const { provider } = make({ '/invoice/Download': [answers.xml(based), answers.pdf(Buffer.from('not a pdf'))] });
    const files = await provider.files(SECRET, REF);
    expect(new TextDecoder().decode(files.xml)).toContain('<KHHDon>C26TYY</KHHDon>');
    expect(files.pdf).toBeNull();
  });

  it('refuses when there is no XML, and keeps the XML when the PDF call fails', async () => {
    await expect(make({ '/invoice/Download': [answers.failed('InvalidTransactionID')] }).provider.files(SECRET, REF)).rejects.toMatchObject({ kind: 'unavailable' });
    const { provider } = make({ '/invoice/Download': [answers.xml(), new Error('reset')] });
    expect((await provider.files(SECRET, REF)).pdf).toBeNull();
  });
});

describe('MISA adapter: what it never does', () => {
  it('never calls the USB-token or local-signing path, never asks for another sign type, and never records a credential in a URL', async () => {
    const { provider, calls } = make({
      '/invoice/get-certificates': [answers.certificates(1)],
      '/invoice/templates': [answers.templates()],
      '/invoice/publishing': [answers.published({ InvCode: 'C' })],
      '/invoice/status': [answers.status()],
      '/invoice/Download': [answers.xml(), answers.xml(), answers.pdf(Buffer.from('%PDF-1.7'))],
    });
    await provider.testConnection(SECRET);
    await provider.listTemplates(SECRET);
    await provider.issue(SECRET, request());
    await provider.status(SECRET, { key: DRAFT_ID, ref: null });
    await provider.files(SECRET, REF);
    for (const call of calls) {
      expect(new URL(call.url).host).toBe('developer.misa.vn');
      expect(call.url).not.toContain('publishing/token');
      expect(call.url).not.toContain('12019');
      expect(call.url).not.toContain('recorded-password');
      expect(call.url).not.toContain('recorded-client-secret');
    }
    for (const call of publishing(calls)) expect((JSON.parse(call.body ?? '') as { SignType: number }).SignType).toBe(2);
    expect(calls.filter((c) => c.url.endsWith('/invoice/token') || c.headers.ClientSecret)).toHaveLength(calls.filter((c) => c.url.endsWith('/invoice/token')).length);
  });

  it('puts the credential nowhere in an error', async () => {
    const { provider } = make({ [T]: [answers.failed('UnAuthorize')] });
    const error = await provider.issue(SECRET, request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EInvoiceProviderError);
    expect(String((error as Error).message) + JSON.stringify(error)).not.toContain('recorded-password');
    expect(lost()).toBeInstanceOf(EInvoiceProviderError);
  });
});
