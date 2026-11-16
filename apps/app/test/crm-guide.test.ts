// SPDX-License-Identifier: AGPL-3.0-only
// The CRM guide (#2231, #2699, #3479): five steps in Vietnamese, the brand filled in, the buttons quoted by the labels the screens show.
import { describe, expect, it } from 'vitest';
import { vi } from '../src/i18n/messages/vi.ts';
import { crmGuide } from '../src/lib/crm-guide.ts';

describe('crmGuide', () => {
  it('has the five steps in order, each with items and no unfilled placeholder', () => {
    const steps = crmGuide('Ludy');
    expect(steps.map((s) => s.id)).toEqual(['crm-contacts', 'crm-import', 'crm-deals', 'crm-quotes', 'crm-quote-order']);
    for (const step of steps) {
      expect(step.items.length).toBeGreaterThan(2);
      for (const text of [step.title, ...step.items]) expect(text, text).not.toMatch(/\{[a-z]+\}/);
    }
    expect(steps.flatMap((s) => s.items).join('\n')).toContain('Ludy');
  });

  it('quotes the buttons and screens by their current Vietnamese labels', () => {
    const text = crmGuide('Ludy').flatMap((s) => s.items).join('\n');
    for (const label of [
      // Step 5 (#3479): sending, the customer's answer, the deal offers, the order, the invoice and the delivery.
      vi.quotes.send.title,
      vi.quotes.send.viaLink,
      vi.quotes.send.sendLink,
      vi.quotes.send.viaEmail,
      vi.quotes.send.sendEmail,
      vi.quotes.send.copyMessage,
      vi.quotes.send.replyInsert,
      vi.quotes.send.revoke,
      vi.quotes.row.pdf,
      vi.quotes.row.revise,
      vi.quotes.settings.open,
      vi.quotes.status.superseded,
      vi.quotes.decision.accept,
      vi.quotes.decision.acceptYes,
      vi.quotes.decision.decline,
      vi.quotes.dealOffer.setAmount,
      vi.quotes.dealOffer.dismiss,
      vi.quotes.orders.title,
      vi.quotes.orders.invoice,
      vi.quotes.orders.invoiceOpen,
      vi.quotes.orders.cancelOrder,
      vi.quotes.orders.delivery.open,
      vi.quotes.orders.delivery.mark,
      vi.quotes.orders.delivery.takeBack,
      vi.quotes.orders.delivery.stockPending,
      vi.quotes.orders.delivery.stockRecord,
      vi.quotes.orders.delivery.stockRetry,
      vi.quotes.orders.delivery.stockTeach,
      vi.quotes.create, vi.quotes.editor.addItem, vi.quotes.editor.copyFrom, vi.quotes.editor.save, vi.reports.title, vi.reports.tabs.quotes, vi.nav.apps.engage, vi.nav.contacts, vi.nav.deals, vi.contacts.add, vi.contacts.importFile, vi.savedViews.save, vi.deals.add, vi.deals.view.settings, vi.contactImport.steps.preview]) {
      expect(text, label).toContain(`"${label}"`);
    }
  });
});
