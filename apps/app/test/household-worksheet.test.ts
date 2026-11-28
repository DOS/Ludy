// SPDX-License-Identifier: AGPL-3.0-only
// The request that downloads a household return worksheet (#5324): a POST whose JSON body is the screen's input, and a path with no query, so the typed amounts and the split by trade never reach a URL; and the screen
// builds every download through it (its source names no export URL with a query string).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { worksheetRequest } from '../src/lib/household-worksheet.ts';

describe('the household worksheet download request', () => {
  it('posts the input as a JSON body to a path with no query', () => {
    const input = { legalEntityId: '11111111-1111-4111-8111-111111111111', year: 2026, withheld: '10000000', prepaid: '50000000', noPaymentRevenue: '0' };
    const [path, init] = worksheetRequest('/api/export/household-qtt.xlsx', input);
    expect(path).toBe('/api/export/household-qtt.xlsx');
    expect(path).not.toContain('?');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(String(init.body))).toEqual(input);
    // Nothing the household typed is in the path.
    expect(path).not.toContain('10000000');
  });

  it('carries the split by trade as an array, not as text in a URL', () => {
    const input = { legalEntityId: '11111111-1111-4111-8111-111111111111', year: 2026, quarter: 4, split: [{ trade: 'goods', revenue: '1000000' }, { trade: 'services', revenue: '600000' }], deductionTrade: 'goods' };
    const [path, init] = worksheetRequest('/api/export/household-cnkd.xlsx', input);
    expect(path).toBe('/api/export/household-cnkd.xlsx');
    expect(JSON.parse(String(init.body))).toEqual(input);
  });

  it('is the only way the household screen asks for a worksheet file: no export URL with a query string is left in it', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/routes/household.tsx', import.meta.url)), 'utf8');
    expect(source).toContain("worksheetRequest('/api/export/household-qtt.xlsx'");
    expect(source).toContain("worksheetRequest('/api/export/household-cnkd.xlsx'");
    expect(source).not.toMatch(/household-(qtt|cnkd)\.xlsx\?/);
    expect(source).not.toMatch(/URLSearchParams[^\n]*legalEntityId/);
  });
});
