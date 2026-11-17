// SPDX-License-Identifier: AGPL-3.0-only
// The reason code of an adjusting or a replacing invoice (#3571). MISA's notice to integration partners (forwarded by the owner on 2026-11-17): for the e-invoice data structure of
// Appendix XVII (a draft), the field `AdjustReplaceReasonCode` is required when issuing a replacing (ReferenceType 1) or adjusting (ReferenceType 2) invoice, takes a code from the
// Appendix XVII list and shows in the XML tag <LDDCTThe>. Planned from 2026-12-15, built on a draft: MISA updates it when the official text and XML are issued.
//
// The list is data, never code: it is replaced when the official list is published. THE LIST IS EMPTY ON PURPOSE for now: it was not read from MISA's own guide (developer.misa.vn, the
// item the issue links), and no code is invented. With an empty list every adjustment and replacement is refused before any call (a code outside the list is unknown), which is the safe
// answer while MISA's issuing is off (`MISA_GATES`). Filling `codes` below from the guide, with `source.retrievedAt`, is the whole change that makes them go through.
export interface ReasonCode {
  // The code as Appendix XVII writes it (sent as is).
  readonly code: string;
  // Its Vietnamese label, shown to the person who confirms it.
  readonly label: string;
}

export interface ReasonCodeList {
  readonly source: {
    readonly name: string;
    readonly url: string;
    // The status of the text the codes come from, and the date they were read (null: not read yet).
    readonly status: 'draft' | 'official';
    readonly retrievedAt: string | null;
  };
  readonly codes: readonly ReasonCode[];
}

export const ADJUST_REPLACE_REASON_CODES: ReasonCodeList = {
  source: {
    name: 'Appendix XVII of the e-invoice data structure (draft), as MISA meInvoice\'s integration guide gives it',
    url: 'https://developer.misa.vn/products-openapi/MEINVOICE?item=1b9bc05e-e240-11f1-9e9d-005056b2d809',
    status: 'draft',
    retrievedAt: null,
  },
  codes: [],
};

/** Whether `code` is one of the list's codes. A missing, empty or unknown code is not. */
export function isReasonCode(code: string | null | undefined, list: readonly ReasonCode[] = ADJUST_REPLACE_REASON_CODES.codes): boolean {
  return typeof code === 'string' && code !== '' && list.some((c) => c.code === code);
}
