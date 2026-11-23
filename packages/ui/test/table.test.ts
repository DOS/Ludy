// SPDX-License-Identifier: AGPL-3.0-only
// Table primitive tests (DESIGN.md 4.3): 36px desktop row density, semantic sticky first column tokens,
// z-index layering, and colSpan exclusion.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '../src/components/table.tsx';

function renderSampleTable(options: { stickyFirstCol?: boolean } = {}) {
  return renderToStaticMarkup(
    createElement(
      Table,
      options.stickyFirstCol !== undefined ? { stickyFirstCol: options.stickyFirstCol } : null,
      createElement(
        TableHeader,
        null,
        createElement(
          TableRow,
          null,
          createElement(TableHead, null, 'Employee'),
          createElement(TableHead, { className: 'text-right' }, 'Net pay'),
        ),
      ),
      createElement(
        TableBody,
        null,
        createElement(
          TableRow,
          null,
          createElement(TableCell, null, 'Nguyen Van A'),
          createElement(TableCell, { className: 'text-right tabular-nums' }, '15.000.000'),
        ),
        createElement(
          TableRow,
          null,
          createElement(TableCell, { colSpan: 2, className: 'py-3' }, 'Expanded detail'),
        ),
      ),
      createElement(
        TableFooter,
        null,
        createElement(
          TableRow,
          null,
          createElement(TableCell, null, 'Total'),
          createElement(TableCell, { className: 'text-right tabular-nums' }, '15.000.000'),
        ),
      ),
    ),
  );
}

describe('Table primitive', () => {
  it('uses 36px desktop density defaults on TableHead and TableCell', () => {
    const html = renderSampleTable();
    expect(html).toContain('data-slot="table-container"');
    expect(html).toContain('data-slot="table"');
    expect(html).not.toContain('data-sticky-first-col');
    expect(html).toMatch(/<th[^>]*data-slot="table-head"[^>]*class="[^"]*\bh-9\b[^"]*\bpx-3\b[^"]*\btext-xs\b/);
    expect(html).toMatch(/<td[^>]*data-slot="table-cell"[^>]*class="[^"]*\bpx-3\b[^"]*\bpy-1\.5\b[^"]*\btext-sm\b/);
  });

  it('adds semantic stickyFirstCol classes, z-index hierarchy, and colSpan guard when enabled', () => {
    const html = renderSampleTable({ stickyFirstCol: true });
    expect(html).toContain('data-sticky-first-col=""');
    expect(html).toContain('th:first-child:not([colspan])]:sticky');
    expect(html).toContain('th:first-child:not([colspan])]:left-0');
    expect(html).toContain('th:first-child:not([colspan])]:z-20');
    expect(html).toContain('th:first-child:not([colspan])]:bg-muted');
    expect(html).toContain('tbody_td:first-child:not([colspan])]:sticky');
    expect(html).toContain('tbody_td:first-child:not([colspan])]:left-0');
    expect(html).toContain('tbody_td:first-child:not([colspan])]:z-[5]');
    expect(html).toContain('tbody_td:first-child:not([colspan])]:bg-card');
    expect(html).toContain('tfoot_td:first-child:not([colspan])]:sticky');
    expect(html).toContain('tfoot_td:first-child:not([colspan])]:bg-[color-mix(in_oklch,var(--card),var(--muted)_50%)]');
    expect(html).toContain('bg-[color-mix(in_oklch,var(--card),var(--muted)_50%)]');
    expect(html).toContain('var(--color-border)');
    expect(html).toContain('print:[&amp;_th:first-child:not([colspan])]:static!');
    expect(html).toContain('print:[&amp;_td:first-child:not([colspan])]:static!');
    // Hover selector uses > child combinator and semantic card+muted color-mix token.
    expect(html).toContain('tbody_tr:hover&gt;td:first-child:not([colspan])]:bg-[color-mix(in_oklch,var(--card),var(--muted)_50%)]');
  });
});
