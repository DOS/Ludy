// SPDX-License-Identifier: AGPL-3.0-only
// What can go wrong with a call to MISA AMIS (#3854), as a kind a caller can act on. An error carries a fixed sentence and, at most, MISA's own short error code (letters only): never a request, a
// response body, a header, the ClientID, an access code or a token, so it is safe to log and to store.

export const AMIS_ERROR_KINDS = [
  // Nothing was sent: the host could not be reached, or the transport refused the call.
  'unreachable',
  // The request may or may not have reached MISA: the answer is unknown. A save or a delete is idempotent by org_refid, so asking again is safe.
  'timeout',
  'lost_answer',
  // The connection itself is refused: the integrator's ClientID, the customer's access code, a disconnected app, no accounting data connected. A person has to act; retrying changes nothing.
  'credentials',
  // The access token was refused or has expired. The client renews it and asks once more before it gives up (then the kind is `credentials`).
  'token',
  // MISA understood the call and refused it (InvalidParam, IsCreatedVoucher, VoucherNotFound, ...): the code says why.
  'refused',
  // MISA or the network answered with an error of its own; asking again later may work.
  'unavailable',
  // The request was refused here, before anything was sent (an amount that is not an exact decimal, more than 500 lines, an id that is not a UUID).
  'invalid_request',
  // MISA answered, but not in the shape of its document.
  'invalid_response',
] as const;
export type AmisErrorKind = (typeof AMIS_ERROR_KINDS)[number];

export const AMIS_INVALID_REASONS = ['too_many_lines', 'no_lines', 'bad_voucher_type', 'mixed_voucher_types', 'bad_org_refid', 'bad_amount', 'bad_value', 'too_many_vouchers', 'bad_page'] as const;
export type AmisInvalidReason = (typeof AMIS_INVALID_REASONS)[number];

const CODE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
/** MISA's own error code when it is a plain word; anything else (it is text from a server) is dropped. */
export function safeAmisCode(value: unknown): string | null {
  return typeof value === 'string' && CODE.test(value) ? value : null;
}

export class AmisError extends Error {
  readonly kind: AmisErrorKind;
  readonly code: string | null;
  readonly reason: AmisInvalidReason | null;
  constructor(kind: AmisErrorKind, options: { code?: string | null; reason?: AmisInvalidReason } = {}) {
    super(`MISA AMIS error: ${kind}${options.code ? ` (${options.code})` : ''}${options.reason ? ` [${options.reason}]` : ''}`);
    this.name = 'AmisError';
    this.kind = kind;
    this.code = options.code ?? null;
    this.reason = options.reason ?? null;
  }
}

// The document's list of error codes ("Danh sách mã lỗi"), with the kind each is handled as and what a person is told. A code the document does not list is `refused` with a generic sentence.
const CODES: Readonly<Record<string, { kind: AmisErrorKind; vi: string }>> = {
  Exception: { kind: 'unavailable', vi: 'AMIS gặp lỗi chưa xác định, hãy thử lại sau' },
  InvalidAPPID: { kind: 'credentials', vi: 'Ứng dụng tích hợp chưa được MISA nhận diện, hãy báo người quản trị Ludy' },
  InvalidToken: { kind: 'token', vi: 'Phiên kết nối với AMIS không hợp lệ' },
  ExpiredToken: { kind: 'token', vi: 'Phiên kết nối với AMIS đã hết hạn' },
  InvalidAccessToken: { kind: 'token', vi: 'Mã kết nối AMIS không hợp lệ' },
  InvalidParam: { kind: 'refused', vi: 'AMIS từ chối vì dữ liệu gửi lên không hợp lệ' },
  IsCreatedVoucher: { kind: 'refused', vi: 'Đã sinh chứng từ kế toán trong AMIS, không thể cập nhật được' },
  VoucherNotFound: { kind: 'refused', vi: 'Không tìm thấy đề nghị sinh chứng từ trong AMIS' },
  DBAmisNotConnectDBAC: { kind: 'credentials', vi: 'AMIS chưa thiết lập kết nối với dữ liệu kế toán nào' },
  AppIDDisconnect: { kind: 'credentials', vi: 'Ứng dụng đã bị ngắt kết nối trong AMIS' },
};

export function amisErrorKind(code: string | null): AmisErrorKind {
  return (code !== null ? CODES[code]?.kind : undefined) ?? 'refused';
}

/** What to tell a person (Vietnamese) about a MISA error code. */
export function amisErrorText(code: string | null): string {
  return (code !== null ? CODES[code]?.vi : undefined) ?? 'AMIS từ chối yêu cầu này';
}
