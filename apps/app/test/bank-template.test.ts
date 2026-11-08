// SPDX-License-Identifier: AGPL-3.0-only
// The form of a saved bank template (#2893): a new one starts valid, columns move one place and stop at the ends, and the problems found are the fields the server would refuse.
import { describe, expect, it } from 'vitest';
import { zHrBankLayout } from '@crove/kernel-contract';
import { blankTemplateForm, formOfTemplate, moveColumn, templateInput, templateProblems } from '../src/lib/bank-template.ts';

const named = () => ({ ...blankTemplateForm(), name: 'Vietcombank' });

describe('bank template form', () => {
  it('starts from the six generic columns and is valid once it has a name, as the contract takes it', () => {
    expect(templateProblems(blankTemplateForm())).toEqual(new Set(['name']));
    const form = named();
    expect(templateProblems(form).size).toBe(0);
    expect(zHrBankLayout.safeParse(templateInput(form).layout).success).toBe(true);
    expect(form.columns.map((c) => c.key)).toEqual(['sequence', 'name', 'account', 'bank', 'amount', 'content']);
  });

  it('moves a column one place and stops at the ends, never losing or repeating one', () => {
    const { columns } = blankTemplateForm();
    expect(moveColumn(columns, 2, -1).map((c) => c.key).slice(0, 3)).toEqual(['sequence', 'account', 'name']);
    expect(moveColumn(columns, 0, 1).map((c) => c.key).slice(0, 2)).toEqual(['name', 'sequence']);
    expect(moveColumn(columns, 0, -1)).toBe(columns);
    expect(moveColumn(columns, 5, 1)).toBe(columns);
    expect(new Set(moveColumn(columns, 3, 1).map((c) => c.key)).size).toBe(6);
  });

  it('names the fields the server would refuse: an empty or long name, an empty or long header, and a content with another brace form', () => {
    const form = named();
    expect(templateProblems({ ...form, name: '   ' })).toEqual(new Set(['name']));
    expect(templateProblems({ ...form, name: 'x'.repeat(81) })).toEqual(new Set(['name']));
    expect(templateProblems({ ...form, columns: form.columns.map((c) => (c.key === 'bank' ? { ...c, header: ' ' } : c)) })).toEqual(new Set(['header:bank']));
    expect(templateProblems({ ...form, columns: form.columns.map((c) => (c.key === 'amount' ? { ...c, header: 'x'.repeat(61) } : c)) })).toEqual(new Set(['header:amount']));
    for (const content of ['', 'Luong {year}', 'Luong {{month}}', 'x'.repeat(141)]) expect(templateProblems({ ...form, content })).toEqual(new Set(['content']));
    expect(templateProblems({ ...form, content: 'Luong thang {month}' }).size).toBe(0);
  });

  it('sends names and headers trimmed and reads a saved template back into the form', () => {
    const form = { ...named(), name: '  VCB ', columns: blankTemplateForm().columns.map((c) => ({ ...c, header: ` ${c.header} ` })), content: ' Luong {month} ' };
    const input = templateInput(form);
    expect(input.name).toBe('VCB');
    expect(input.layout.columns[0]).toEqual({ key: 'sequence', header: 'STT' });
    expect(input.layout.content).toBe('Luong {month}');
    expect(formOfTemplate({ name: input.name, layout: input.layout })).toEqual({ name: 'VCB', columns: input.layout.columns, content: 'Luong {month}' });
  });
});
