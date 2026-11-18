// SPDX-License-Identifier: AGPL-3.0-only
// A fake MISA AMIS server for the tests (#3854): the transport the client is given, with MISA's documented behaviour as far as the adapter depends on it. It checks the ClientID header, issues tokens that
// can be expired, queues saved vouchers as requests, answers IsCreatedVoucher for a voucher a person already turned into a voucher, keeps the results a callback would carry, signs a callback the way MISA does
// and answers the polling call. It records every request so a test can read the exact body that went out.
import { signCallbackData, type AmisRequest, type AmisResponse, type AmisTransport } from '../src/index.ts';

export interface FakeCall {
  path: string;
  method: string;
  headers: Readonly<Record<string, string>>;
  body: string;
}
export interface FakeResult {
  org_refid: string;
  success: boolean;
  error_code: string | null;
  error_message: string;
  session_id: string;
  voucher_type: number;
}

export interface FakeMisa {
  transport: AmisTransport;
  calls: FakeCall[];
  /** The requests queued in AMIS, by org_refid. */
  requests: Map<string, { voucherType: number; orgCompanyCode: string; body: Record<string, unknown> }>;
  results: FakeResult[];
  /** A person turned this request into a voucher in AMIS. */
  createVoucher(orgRefId: string): void;
  /** Every token issued so far stops working (MISA answers ExpiredToken). */
  expireTokens(): void;
  /** The next call is answered with this error code (HTTP 200, Success false). */
  failNext(code: string): void;
  /** The next call is answered with this HTTP status and body. */
  rawNext(status: number, body: string): void;
  /** The next call rejects with this error, as a transport does. */
  throwNext(error: unknown): void;
  /** The body MISA would post to the callback URL for these results, signed as MISA signs it. */
  callbackBody(results: readonly FakeResult[], overrides?: { orgCompanyCode?: string; appId?: string }): string;
}

const ok = (data: unknown): AmisResponse => ({ status: 200, body: JSON.stringify({ Success: true, ErrorMessage: '', Data: data }) });
const fail = (code: string): AmisResponse => ({ status: 200, body: JSON.stringify({ Success: false, ErrorCode: code, ErrorMessage: 'lỗi' }) });

export function createFakeMisa(options: { clientId: string; accessCodes: Record<string, string>; dictionary?: Record<number, Record<string, unknown>[]> }): FakeMisa {
  const calls: FakeCall[] = [];
  const requests: FakeMisa['requests'] = new Map();
  const results: FakeResult[] = [];
  const created = new Set<string>();
  const tokens = new Map<string, { orgCompanyCode: string; live: boolean }>();
  let issued = 0;
  let next: AmisResponse | { throws: unknown } | { code: string } | null = null;

  const transport: AmisTransport = async (request: AmisRequest) => {
    const path = new URL(request.url).pathname.replace(/^\/apis/, '');
    calls.push({ path, method: request.method, headers: request.headers, body: request.body });
    if (next !== null) {
      const forced = next;
      next = null;
      if ('throws' in forced) throw forced.throws;
      if ('code' in forced) return fail(forced.code);
      return forced;
    }
    if (request.headers.ClientID !== options.clientId) return fail('InvalidAPPID');
    const body = JSON.parse(request.body) as Record<string, unknown>;
    if (path === '/amiskt/v1/token') {
      const orgCompanyCode = options.accessCodes[String(body.access_code)];
      if (orgCompanyCode === undefined || orgCompanyCode !== body.org_company_code) return fail('InvalidAccessToken');
      const token = `token-${++issued}`;
      tokens.set(token, { orgCompanyCode, live: true });
      return ok({ access_token: token, expired_time: '2026-08-05T20:00:00' });
    }
    const session = tokens.get(request.headers['X-MISA-AccessToken'] ?? '');
    if (!session) return fail('InvalidToken');
    if (!session.live) return fail('ExpiredToken');
    if (path === '/amiskt/v1/get_company_info') return ok({ company_name: 'Công ty thử', branch_id: body.branch_id });
    if (path === '/amiskt/v1/get_dictionary') {
      const rows = options.dictionary?.[Number(body.data_type)] ?? [];
      return ok(rows.slice(Number(body.skip), Number(body.skip) + Number(body.take)));
    }
    if (body.org_company_code !== undefined && body.org_company_code !== session.orgCompanyCode) return fail('InvalidParam');
    if (path === '/amiskt/v1/save') {
      for (const voucher of body.voucher as Array<Record<string, unknown>>) {
        const orgRefId = String(voucher.org_refid);
        const voucherType = Number(voucher.voucher_type);
        const accepted = !created.has(orgRefId);
        if (accepted) requests.set(orgRefId, { voucherType, orgCompanyCode: session.orgCompanyCode, body: voucher });
        results.push({
          org_refid: orgRefId,
          success: accepted,
          error_code: accepted ? null : 'IsCreatedVoucher',
          error_message: accepted ? '' : 'Đã sinh chứng từ kế toán, không thể cập nhật được.',
          session_id: `session-${results.length + 1}`,
          voucher_type: voucherType,
        });
      }
      return ok('Hệ thống đã ghi nhận yêu cầu đồng bộ vào hàng đợi. Kết quả xử lý trả về qua callback.');
    }
    if (path === '/amiskt/v1/delete') {
      for (const v of body.voucher as Array<Record<string, unknown>>) {
        const orgRefId = String(v.org_refid);
        const found = requests.has(orgRefId) && !created.has(orgRefId);
        if (found) requests.delete(orgRefId);
        results.push({ org_refid: orgRefId, success: found, error_code: found ? null : 'VoucherNotFound', error_message: '', session_id: `session-${results.length + 1}`, voucher_type: Number(v.voucher_type) });
      }
      return ok('Đã ghi nhận yêu cầu xóa.');
    }
    if (path === '/amiskt/v1/get_call_back_detail_error') {
      return ok(JSON.stringify(results.slice(Number(body.skip), Number(body.skip) + Number(body.take))));
    }
    if (path === '/amiskt/v1/save_dictionary') return ok('Đã ghi nhận.');
    return fail('InvalidParam');
  };

  return {
    transport,
    calls,
    requests,
    results,
    createVoucher: (orgRefId) => void created.add(orgRefId),
    expireTokens: () => tokens.forEach((t) => void (t.live = false)),
    failNext: (code) => void (next = { code }),
    rawNext: (status, body) => void (next = { status, body }),
    throwNext: (error) => void (next = { throws: error }),
    callbackBody: (rows, overrides = {}) => {
      const data = JSON.stringify(rows);
      return JSON.stringify({
        success: true,
        app_id: overrides.appId ?? options.clientId,
        error_code: '',
        error_message: '',
        signature: signCallbackData(data, options.clientId),
        data_type: 1,
        org_company_code: overrides.orgCompanyCode ?? 'ludy-test',
        data,
      });
    },
  };
}

