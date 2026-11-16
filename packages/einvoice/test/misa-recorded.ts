// SPDX-License-Identifier: AGPL-3.0-only
// Recorded answers of the MISA meInvoice API, shaped by MISA's own developer document (developer.misa.vn): the envelope (Success, ErrorCode, DescriptionErrorCode, Data,
// CustomData, PublishInvoiceResult as a JSON string), the PublishInvoiceResult and InvoiceStatus objects, the Download answer and the XML of the document's sample invoice.
// Every value is made up (no real tax code, token or invoice). Nothing in this directory calls MISA: the transport is a replay.
import { EInvoiceProviderError, type EInvoiceRequest } from '../src/index.ts';
import type { MisaRequest, MisaResponse, MisaTransport } from '../src/misa.ts';

export const SECRET = JSON.stringify({ clientId: '00000000-0000-4000-8000-0000000000c1', clientSecret: 'recorded-client-secret', taxCode: '0100000000', username: 'seller@example.test', password: 'recorded-password' });

export const DRAFT_ID = '5f58b508-79ec-4f1e-9e9d-005056b2d809';
export const REF = '3VFLI65368B5';

const envelope = (extra: Record<string, unknown> = {}): string => JSON.stringify({ Success: true, ErrorCode: null, DescriptionErrorCode: null, Errors: [], Data: null, CustomData: null, ...extra });

export const answers = {
  token: (token = 'recorded-token-1'): MisaResponse => ({ status: 200, body: envelope({ Data: token }) }),
  // The second step: the user's id in CustomData and no token (the document's /invoice/2fa takes UserID from the token answer's CustomData.Id).
  twoStep: (): MisaResponse => ({ status: 200, body: envelope({ Data: null, CustomData: { Id: '9d8f6a20-0000-4000-8000-000000000001' } }) }),
  failed: (code: string | null = null): MisaResponse => ({ status: 200, body: envelope({ Success: false, ErrorCode: code }) }),
  tooMany: (): MisaResponse => ({ status: 429, body: JSON.stringify({ Success: false, ErrorCode: 'TooManyRequests', DescriptionErrorCode: 'Quá giới hạn 10 lần gọi trong 60 giây.' }) }),
  certificates: (count: number): MisaResponse => ({ status: 200, body: envelope({ Data: Array.from({ length: count }, (_, i) => ({ CertificateId: `cert-${i}`, Provider: 'Esign' })) }) }),
  templates: (): MisaResponse => ({
    status: 200,
    body: envelope({
      Data: JSON.stringify([
        { IPTemplateID: 't1', TemplateName: 'Hóa đơn GTGT', InvSeries: '1C26TYY', Inactive: false, IsInheritFromOldTemplate: false, IsSendSummary: false, IsPetrol: false, IsMoreVATRate: false },
        { IPTemplateID: 't2', TemplateName: 'Hóa đơn bán hàng', InvSeries: '2C26TAA', Inactive: false, IsSendSummary: false },
        { IPTemplateID: 't3', TemplateName: 'Hóa đơn máy tính tiền', InvSeries: '1C26MYY', Inactive: false },
        { IPTemplateID: 't4', TemplateName: 'Mẫu ngừng dùng', InvSeries: '1C26TZZ', Inactive: true },
        { IPTemplateID: 't5', TemplateName: 'Xăng dầu', InvSeries: '1C26TPP', Inactive: false, IsPetrol: true },
        { IPTemplateID: 't6', TemplateName: 'Không có mã', InvSeries: '1K26TNN', Inactive: false },
      ]),
    }),
  }),
  // PublishInvoiceResult is a JSON string of a list, as in the document.
  published: (item: Record<string, unknown> = {}): MisaResponse => ({
    status: 200,
    body: envelope({
      CreateInvoiceResult: null,
      PublishInvoiceResult: JSON.stringify([{ RefID: DRAFT_ID, TransactionID: REF, InvTemplateNo: '1', InvSeries: '1C26TYY', InvNo: '00000001', InvCode: null, InvDate: '2026-11-03T00:00:00', ErrorCode: null, CustomData: null, ...item }]),
    }),
  }),
  publishError: (code: string, itemLevel = true): MisaResponse => ({
    status: 200,
    body: itemLevel
      ? envelope({ PublishInvoiceResult: JSON.stringify([{ RefID: DRAFT_ID, ErrorCode: code, DescriptionErrorCode: 'recorded', ErrorData: null, CustomData: null }]) })
      : envelope({ Success: false, ErrorCode: code, DescriptionErrorCode: 'recorded' }),
  }),
  status: (item: Record<string, unknown> = {}): MisaResponse => ({ status: 200, body: envelope({ Data: [{ TransactionID: REF, PublishStatus: 1, ReferenceType: 0, InvoiceCode: null, SendTaxStatus: 2, IsSentEmail: false, IsDelete: false, ReceivedStatus: 0, ...item }] }) }),
  statusEmpty: (): MisaResponse => ({ status: 200, body: envelope({ Data: [] }) }),
  statusNotFound: (): MisaResponse => ({ status: 200, body: envelope({ Success: false, ErrorCode: 'InvalidTransactionID' }) }),
  // Download with Xml returns the XML text itself; the document's DownloadInvoiceResult is {TransactionID, data, ErrorCode}.
  xml: (xml: string = invoiceXml()): MisaResponse => ({ status: 200, body: envelope({ Data: [{ TransactionID: REF, data: xml, ErrorCode: null }] }) }),
  pdf: (bytes: Buffer): MisaResponse => ({ status: 200, body: envelope({ Data: [{ TransactionID: REF, data: bytes.toString('base64'), ErrorCode: null }] }) }),
};

// The document's sample invoice (its coded-invoice XML), shortened to what the adapter reads and stripped of any real party.
export const invoiceXml = (extra = ''): string =>
  `<?xml version="1.0" encoding="utf-8"?><HDon><DLHDon Id="${REF}"><TTChung><PBan>2.1.0</PBan><THDon>Hóa đơn giá trị gia tăng</THDon><KHMSHDon>1</KHMSHDon><KHHDon>C26TYY</KHHDon><SHDon>00000001</SHDon><NLap>2026-11-03</NLap><DVTTe>VND</DVTTe></TTChung><NDHDon><NBan><Ten>CÔNG TY THỬ NGHIỆM</Ten><MST>0100000000</MST></NBan></NDHDon></DLHDon>${extra}<DSCKS><NBan></NBan></DSCKS></HDon>`;

export const request = (extra: Partial<EInvoiceRequest> = {}): EInvoiceRequest => ({
  key: DRAFT_ID,
  templateNo: '1',
  symbol: 'C26TYY',
  date: '2026-11-03',
  currency: 'VND',
  seller: { taxCode: '0100000000', name: 'Công ty Thử Nghiệm' },
  buyer: { kind: 'business', taxCode: '0100000001', name: 'Công ty Mua', address: '1 Phố Thử, Hà Nội', email: 'mua@example.test' },
  lines: [
    { description: 'Hàng A', unit: 'cái', quantity: '2', unitPrice: '100000', amount: '200000', vatRate: '10%', vatAmount: '20000' },
    { description: 'Hàng B', unit: 'cái', quantity: '1.5', unitPrice: '50000', amount: '75000', vatRate: '8%', vatAmount: '6000' },
  ],
  subtotal: '275000',
  vatAmount: '26000',
  total: '301000',
  ...extra,
});

export type Step = MisaResponse | Error | ((request: MisaRequest) => Promise<MisaResponse> | MisaResponse);

// A replay: each `path` (the part of the URL after the base) has a queue of recorded answers, taken in order (the last one repeats); a path with none is a failure of the test,
// since an adapter must not call anything the test did not record.
export function replay(script: Record<string, Step[]>): { transport: MisaTransport; calls: MisaRequest[]; count: (path: string) => number } {
  const calls: MisaRequest[] = [];
  const used = new Map<string, number>();
  const transport: MisaTransport = async (req) => {
    calls.push(req);
    const url = new URL(req.url);
    if (url.host !== 'developer.misa.vn' || !url.pathname.startsWith('/apis/itg/meinvoice/')) throw new Error(`unrecorded host or base: ${req.url}`);
    const path = url.pathname.slice('/apis/itg/meinvoice'.length);
    const queue = script[path];
    if (!queue || queue.length === 0) throw new Error(`no recorded answer for ${req.method} ${path}`);
    const index = used.get(path) ?? 0;
    used.set(path, index + 1);
    const step = queue[Math.min(index, queue.length - 1)] as Step;
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? step(req) : step;
  };
  return { transport, calls, count: (path) => calls.filter((c) => new URL(c.url).pathname.endsWith(path)).length };
}

export const lost = (): Error => new EInvoiceProviderError('lost_answer');
