// SPDX-License-Identifier: AGPL-3.0-only
// The request that downloads a household return worksheet (#5324): the 01/CNKD and the 02/CNKD-TNCN-QTT files are asked for by POST, with the screen's own input as a JSON body, so the amounts and the split by trade the
// household typed never travel in a URL (an access log, a browser history or a proxy would keep them). The path carries nothing of the household.
type WorksheetPath = '/api/export/household-cnkd.xlsx' | '/api/export/household-qtt.xlsx';

/** The arguments of apiFetch for one worksheet file: the input is the same one the screen asks the query with. */
export function worksheetRequest(path: WorksheetPath, input: Record<string, unknown>): [string, RequestInit] {
  return [path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }];
}
