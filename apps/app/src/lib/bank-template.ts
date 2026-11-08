// SPDX-License-Identifier: AGPL-3.0-only
// The form of a saved bank bulk-salary template (#2893): the six columns in the bank's order with their headers, and the payment's content text. No browser or API imports, so it is unit tested.
// The rules equal the contract's (zHrBankLayout) and the table's check: each column once, a header of 1 to 60 characters, a content of 1 to 140 characters whose only brace form is {month}.
import { HR_BANK_CONTENT_MAX, HR_BANK_HEADER_MAX, HR_BANK_NAME_MAX, zHrBankLayout, type HrBankColumn, type HrBankLayout } from '@crove/kernel-contract';

export interface TemplateForm {
  name: string;
  columns: Array<{ key: HrBankColumn; header: string }>;
  content: string;
}

/** What a new template starts from: the six columns in the generic order. The bank's own headers and order replace it. */
export const blankTemplateForm = (): TemplateForm => ({
  name: '',
  columns: [
    { key: 'sequence', header: 'STT' },
    { key: 'name', header: 'Họ tên' },
    { key: 'account', header: 'Số tài khoản' },
    { key: 'bank', header: 'Ngân hàng' },
    { key: 'amount', header: 'Số tiền' },
    { key: 'content', header: 'Nội dung' },
  ],
  content: 'Lương tháng {month}',
});

export const formOfTemplate = (template: { name: string; layout: HrBankLayout }): TemplateForm => ({ name: template.name, columns: template.layout.columns.map((c) => ({ key: c.key, header: c.header })), content: template.layout.content });

/** The column at `index` moved one place up (-1) or down (1); the same list when it is already at the end. */
export function moveColumn(columns: TemplateForm['columns'], index: number, delta: -1 | 1): TemplateForm['columns'] {
  const to = index + delta;
  if (index < 0 || index >= columns.length || to < 0 || to >= columns.length) return columns;
  const next = [...columns];
  const [moved] = next.splice(index, 1);
  if (moved) next.splice(to, 0, moved);
  return next;
}

/** The form as the server takes it: names and headers trimmed. */
export const templateInput = (form: TemplateForm) => ({
  name: form.name.trim(),
  layout: { columns: form.columns.map((c) => ({ key: c.key, header: c.header.trim() })), content: form.content.trim() },
});

/** The fields that are not valid yet: `name`, `content` and `header:<key>`. Empty when the server would take the form. */
export function templateProblems(form: TemplateForm): Set<string> {
  const problems = new Set<string>();
  const name = form.name.trim();
  if (name === '' || name.length > HR_BANK_NAME_MAX) problems.add('name');
  for (const c of form.columns) {
    const header = c.header.trim();
    if (header === '' || header.length > HR_BANK_HEADER_MAX) problems.add(`header:${c.key}`);
  }
  const content = form.content.trim();
  if (content === '' || content.length > HR_BANK_CONTENT_MAX || !/^([^{}]|\{month\})*$/.test(content)) problems.add('content');
  // The contract is the last word: a form with no problem above is one it takes.
  if (problems.size === 0 && !zHrBankLayout.safeParse(templateInput(form).layout).success) problems.add('content');
  return problems;
}
