// SPDX-License-Identifier: AGPL-3.0-only
// A list that opts in with `stacked` (#3649) turns its rows into cards below `sm`, so a phone reaches every cell and button without scrolling sideways; from `sm` up, and for a list that
// does not opt in, it is the table it was.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api.ts', () => ({ takeOrgLeftNotice: () => null, errorMessage: (e: unknown) => String(e) }));

const { DataTable } = await import('../src/components/ui.tsx');

const rows = (
  <tr>
    <td data-label="Phụ trách">Lan</td>
  </tr>
);

describe('DataTable stacked', () => {
  it('makes the rows cards below sm: no header, a block per row and cell, labels before the values, 44 px controls', () => {
    const html = renderToStaticMarkup(
      <DataTable head={['Tên']} stacked>
        {rows}
      </DataTable>,
    ).replaceAll('&amp;', '&');
    for (const cls of ['max-sm:min-w-0', 'max-sm:[&_thead]:hidden', 'max-sm:[&_tr]:block', 'max-sm:[&_td]:block', 'max-sm:[&_td_button]:min-h-11', 'max-sm:[&_td_select]:min-h-11', 'before:content-[attr(data-label)]']) expect(html).toContain(cls);
    expect(html).toContain('data-label="Phụ trách"');
  });

  it('stays the table, 640 px wide with its header, for a list that does not opt in', () => {
    const html = renderToStaticMarkup(<DataTable head={['Tên']}>{rows}</DataTable>);
    expect(html).toContain('min-w-[640px]');
    expect(html).not.toContain('max-sm:');
  });
});
