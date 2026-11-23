// SPDX-License-Identifier: AGPL-3.0-only
// DataTable & TableSkeleton tests (DESIGN.md 4.3, 7; #4521): 36px density alignment,
// stickyFirstCol propagation, stacked mobile card rollout, and ad-hoc TableCell padding cleanup.
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TableCell, TableRow } from '@ludy/ui/components/table';

vi.mock('../src/lib/api.ts', () => ({ takeOrgLeftNotice: () => null }));

const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { DataTable, TableSkeleton } = await import('../src/components/ui.tsx');

function readSrc(relPath: string): string {
  return readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

describe('TableSkeleton and DataTable (#4521)', () => {
  it('aligns TableSkeleton header and row heights with 36px desktop density', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <TableSkeleton columns={4} rows={3} />
      </I18nProvider>,
    );
    const h9Matches = html.match(/\bh-9\b/g) ?? [];
    // 1 header row + 3 body rows = 4 bars at h-9 (36px), with px-3 matching TableHead/TableCell.
    expect(h9Matches).toHaveLength(4);
    expect(html.match(/\bpx-3\b/g)).toHaveLength(4);
  });

  it('uses TableHead px-3 defaults on DataTable and forwards stickyFirstCol and stacked props', () => {
    const html = renderToStaticMarkup(
      <DataTable
        head={['Name', 'Amount']}
        numeric={[1]}
        stickyFirstCol
        stacked
        foot={
          <TableRow>
            <TableCell>Total</TableCell>
            <TableCell className="text-right tabular-nums">100</TableCell>
          </TableRow>
        }
      >
        <TableRow>
          <TableCell data-label="Name">Alice</TableCell>
          <TableCell data-label="Amount" className="text-right tabular-nums">
            100
          </TableCell>
        </TableRow>
      </DataTable>,
    );
    expect(html).toContain('data-sticky-first-col=""');
    expect(html).toContain('max-sm:[&amp;_tr]:block');
    expect(html).toContain('max-sm:[&amp;_td[data-label]:not(:empty)]:before:content-[attr(data-label)]');
    expect(html).toContain('data-label="Name"');
    expect(html).toContain('data-label="Amount"');
    expect(html).toContain('max-sm:[&amp;_th:first-child:not([colspan])]:static!');
    expect(html).toContain('max-sm:[&amp;_td:first-child:not([colspan])]:static!');
    expect(html).toContain('max-sm:[&amp;_td:first-child:not([colspan])]:bg-transparent!');
    expect(html).toContain('max-sm:[&amp;_td:first-child:not([colspan])]:shadow-none!');
    expect(html).toContain('tfoot');
    // DataTable headers rely on TableHead defaults (px-3 text-xs), without an ad-hoc px-4 override.
    expect(html).not.toMatch(/<th[^>]*\bpx-4\b/);
    expect(html).toMatch(/<th[^>]*class="[^"]*\bpx-3\b[^"]*\btext-right\b[^"]*">Amount<\/th>/);
  });

  it('enables stickyFirstCol on wide payroll, declarations, household, and ledger tables', () => {
    const stickyRoutes = [
      '../src/routes/hr-payroll.tsx',
      '../src/routes/hr-declarations.tsx',
      '../src/routes/household.tsx',
      '../src/routes/ledger.tsx',
    ];
    for (const file of stickyRoutes) {
      expect(readSrc(file)).toMatch(/stickyFirstCol\b/);
    }
    expect(readSrc('../src/routes/hr-payroll.tsx')).toContain('bg-muted [&_th]:bg-muted');
  });

  it('enables stacked DataTable rollout with data-label attributes on P1-3 mobile screens', () => {
    const stackedRoutes = [
      '../src/routes/overview.tsx',
      '../src/routes/documents.tsx',
      '../src/routes/vouchers.tsx',
      '../src/routes/sales-invoices.tsx',
      '../src/routes/hr-employees.tsx',
      '../src/routes/sign-envelopes.tsx',
    ];
    for (const file of stackedRoutes) {
      const src = readSrc(file);
      expect(src).toMatch(/<(?:DataTable|Table)[^>]*\bstacked\b/);
      expect(src).toMatch(/data-label=/);
    }

    const signSrc = readSrc('../src/routes/sign-envelopes.tsx');
    expect(signSrc).toContain('data-testid="sign-envelope-list"');
    expect(signSrc).toContain('data-testid="sign-renewals-list"');
    expect(signSrc).toContain('max-md:min-h-11');
    expect(signSrc).toContain('tabular-nums');
    expect(signSrc).toContain('<TableSkeleton');
  });

  it('has no ad-hoc TableCell padding overrides in edited Finance, HR, Documents, and workspace routes', () => {
    const cleanedFiles = [
      '../src/routes/hr-payroll.tsx',
      '../src/routes/hr-declarations.tsx',
      '../src/routes/household.tsx',
      '../src/routes/ledger.tsx',
      '../src/routes/overview.tsx',
      '../src/routes/documents.tsx',
      '../src/routes/vouchers.tsx',
      '../src/routes/sales-invoices.tsx',
      '../src/routes/hr-employees.tsx',
      '../src/routes/sign-envelopes.tsx',
      '../src/routes/customers.tsx',
      '../src/routes/vendors.tsx',
      '../src/routes/bank.tsx',
      '../src/routes/bank-matched.tsx',
      '../src/routes/fixed-assets.tsx',
      '../src/routes/marketplace-balance.tsx',
      '../src/routes/opening-balance.tsx',
      '../src/routes/payment-reminders.tsx',
      '../src/routes/portal-list.tsx',
      '../src/routes/stock.tsx',
      '../src/routes/vat.tsx',
      '../src/routes/hr-attendance.tsx',
      '../src/routes/hr-bank-templates.tsx',
      '../src/routes/hr-my.tsx',
      '../src/routes/hr-recruiting.tsx',
      '../src/components/marketplace-actions.tsx',
      '../src/components/marketplace-orders.tsx',
      '../src/components/sales-number-gaps.tsx',
      '../src/components/staged-statements.tsx',
      '../src/components/stock-ai.tsx',
      '../src/components/stock-counts.tsx',
      '../src/components/hr-attendance-checkin-card.tsx',
      '../src/components/hr-leave-panel.tsx',
      '../src/components/hr-recruiting-stage5d.tsx',
      '../src/components/hr-thirteenth-month-panel.tsx',
      '../src/components/hr-timekeeping-panel.tsx',
    ];
    for (const file of cleanedFiles) {
      const src = readSrc(file);
      expect(src, file).not.toMatch(/<TableCell[^>]*\b(px-[34]|py-2)\b/);
      expect(src, file).not.toMatch(/const NUM = ['"][^'"]*\b(px-[34]|py-3)\b/);
    }
  });
});
