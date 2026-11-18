// SPDX-License-Identifier: AGPL-3.0-only
// The callback reader (#3854): the signature is MISA's HMAC-SHA256 over the `data` string with the ClientID as key, checked before `data` is parsed; only `data` is signed, so the reader hands back what the
// envelope says about the organisation as a hint and nothing more.
import { describe, expect, it } from 'vitest';
import { readCallback, parseCallbackResults, signCallbackData } from '../src/index.ts';

const CLIENT = '0e0a14cf-9e4b-4af9-875b-c490f34a581b';
const REF = 'AB80B9D2-9747-4583-AA60-8286244ECA49';
const entry = (over: Record<string, unknown> = {}) => ({ org_refid: REF, success: false, error_code: 'IsCreatedVoucher', error_message: 'Đã sinh chứng từ kế toán, không thể cập nhật được.', session_id: 'd9a9a4c9-2408-472d-af9a-bb9a2439b9a2', error_call_back_message: null, voucher_type: 1, ...over });
const envelope = (data: string, over: Record<string, unknown> = {}, signed = data) =>
  JSON.stringify({ success: true, app_id: CLIENT, error_code: '', error_message: '', signature: signCallbackData(signed, CLIENT), data_type: 1, org_company_code: 'ludy-abc', data, ...over });

describe('signCallbackData', () => {
  it('is the hex HMAC-SHA256 with the ClientID as the key (independent vectors)', () => {
    expect(signCallbackData('The quick brown fox jumps over the lazy dog', 'key')).toBe('f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
    expect(signCallbackData(`[{"org_refid":"${REF}","success":true}]`, CLIENT)).toBe('bae966adcd99deae4c2027708ba38708f8d2f5ff90f989f0cf469937b777fec7');
  });
});

describe('readCallback', () => {
  it('reads a good message into its results, with the id in lower case and MISA\'s code kept when it is a plain word', () => {
    const read = readCallback(envelope(JSON.stringify([entry(), entry({ success: true, error_code: null, error_message: '', session_id: 'e6f76623-3c50-46a0-878e-4599940bf028' })])), CLIENT);
    expect(read).toEqual({
      ok: true,
      callback: {
        dataType: 1,
        orgCompanyCode: 'ludy-abc',
        batchError: null,
        results: [
          { orgRefId: REF.toLowerCase(), voucherType: 1, success: false, errorCode: 'IsCreatedVoucher', errorMessage: 'Đã sinh chứng từ kế toán, không thể cập nhật được.', sessionId: 'd9a9a4c9-2408-472d-af9a-bb9a2439b9a2' },
          { orgRefId: REF.toLowerCase(), voucherType: 1, success: true, errorCode: null, errorMessage: '', sessionId: 'e6f76623-3c50-46a0-878e-4599940bf028' },
        ],
      },
    });
  });

  it('refuses a bad or missing signature before it looks at `data`: even a `data` that is not JSON is `signature`, not `data`', () => {
    const data = 'not json at all';
    expect(readCallback(envelope(data, {}, 'some other text'), CLIENT)).toEqual({ ok: false, reason: 'signature' });
    expect(readCallback(JSON.stringify({ app_id: CLIENT, data_type: 1, org_company_code: 'x', data, signature: '' }), CLIENT)).toEqual({ ok: false, reason: 'signature' });
    // A good signature on a `data` that is not a list of results is `data`.
    expect(readCallback(envelope(data), CLIENT)).toEqual({ ok: false, reason: 'data' });
    // Another key signs: refused.
    expect(readCallback(envelope(JSON.stringify([entry()])), 'another-client-id')).toEqual({ ok: false, reason: 'signature' });
  });

  it('refuses data changed after it was signed, and a signature of another length without throwing', () => {
    const signed = JSON.stringify([entry({ success: false })]);
    expect(readCallback(envelope(JSON.stringify([entry({ success: true })]), {}, signed), CLIENT)).toEqual({ ok: false, reason: 'signature' });
    expect(readCallback(envelope(signed, { signature: 'abcd' }), CLIENT)).toEqual({ ok: false, reason: 'signature' });
    expect(readCallback(envelope(signed, { signature: signCallbackData(signed, CLIENT).toUpperCase() }), CLIENT)).toMatchObject({ ok: true });
  });

  it('refuses a `data` with an unpaired surrogate, which would hash as the replacement character', () => {
    const lone = `[{"org_refid":"${REF}","success":true,"voucher_type":1,"error_message":"\ud800"}]`.replace('\\ud800', '\ud800');
    expect('\ud800'.isWellFormed()).toBe(false);
    const bad = `["\ud800"]`;
    expect(bad.isWellFormed()).toBe(false);
    expect(readCallback(envelope(bad), CLIENT)).toEqual({ ok: false, reason: 'malformed' });
    expect(lone.length).toBeGreaterThan(0);
  });

  it('checks app_id against the ClientID once the signature is good', () => {
    expect(readCallback(envelope(JSON.stringify([entry()]), { app_id: 'another' }), CLIENT)).toEqual({ ok: false, reason: 'app_id' });
    expect(readCallback(envelope(JSON.stringify([entry()]), { app_id: undefined }), CLIENT)).toEqual({ ok: false, reason: 'app_id' });
  });

  it('does not sign org_company_code: a replayed message carrying another one still reads, and says so as a hint the caller must compare', () => {
    const data = JSON.stringify([entry()]);
    const first = readCallback(envelope(data), CLIENT);
    const replayed = readCallback(envelope(data, { org_company_code: 'ludy-other' }), CLIENT);
    expect(first).toMatchObject({ ok: true, callback: { orgCompanyCode: 'ludy-abc' } });
    expect(replayed).toMatchObject({ ok: true, callback: { orgCompanyCode: 'ludy-other' } });
    // Same results either way: the caller takes the organisation from its stored push row by org_refid.
    expect(first.ok && replayed.ok && first.callback.results).toEqual(replayed.ok && replayed.callback.results);
    // And a replay of the same body reads the same.
    expect(readCallback(envelope(data), CLIENT)).toEqual(first);
  });

  it('refuses a body that is not an envelope, and a code or a shape outside the document', () => {
    for (const body of ['', 'null', '[]', '"x"', '{}', '{"signature":1,"data":"x"}', '{"signature":"a"}']) expect(readCallback(body, CLIENT), body).toEqual({ ok: false, reason: 'malformed' });
    expect(readCallback(envelope(JSON.stringify([entry()]), { org_company_code: 'has space' }), CLIENT)).toEqual({ ok: false, reason: 'malformed' });
    expect(readCallback(envelope(JSON.stringify([entry()]), { data_type: 'x' }), CLIENT)).toEqual({ ok: false, reason: 'malformed' });
    expect(readCallback(envelope(JSON.stringify([entry({ org_refid: 'nope' })])), CLIENT)).toEqual({ ok: false, reason: 'data' });
    expect(readCallback(envelope(JSON.stringify([entry({ success: 'yes' })])), CLIENT)).toEqual({ ok: false, reason: 'data' });
    expect(readCallback(envelope(JSON.stringify({ not: 'a list' })), CLIENT)).toEqual({ ok: false, reason: 'data' });
    expect(readCallback(envelope(JSON.stringify(Array.from({ length: 1001 }, () => entry()))), CLIENT)).toEqual({ ok: false, reason: 'data' });
  });
});

describe('a batch error', () => {
  it('is kept when the envelope says the whole batch failed, so an empty list is not read as "nothing to report"', () => {
    expect(readCallback(envelope('[]', { success: false, error_code: 'InvalidParam' }), CLIENT)).toMatchObject({ ok: true, callback: { batchError: 'InvalidParam', results: [] } });
    expect(readCallback(envelope('[]', { success: false, error_code: 'x y' }), CLIENT)).toMatchObject({ ok: true, callback: { batchError: 'unknown' } });
    expect(readCallback(envelope('[]'), CLIENT)).toMatchObject({ ok: true, callback: { batchError: null } });
  });
});

describe('parseCallbackResults', () => {
  it('drops an error code that is not a plain word, and caps text from MISA', () => {
    const [row] = parseCallbackResults(JSON.stringify([entry({ error_code: 'x\n<script>', error_message: 'a'.repeat(900), session_id: null })])) ?? [];
    expect(row).toMatchObject({ errorCode: null, sessionId: null });
    expect(row?.errorMessage).toHaveLength(500);
    expect(parseCallbackResults('[]')).toEqual([]);
    expect(parseCallbackResults('{')).toBeNull();
  });
});
