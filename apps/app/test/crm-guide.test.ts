// SPDX-License-Identifier: AGPL-3.0-only
// The CRM guide (#2231, #2699, #3479, #3596): five steps in each interface language, the brand filled in, the buttons quoted by the labels the screens show.
import { describe, expect, it } from 'vitest';
import { LOCALES } from '../src/i18n/locale.ts';
import { vi } from '../src/i18n/messages/vi.ts';
import { SOURCE_CATALOGS } from '../src/i18n/runtime.ts';
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
      vi.quotes.settings.card,
      vi.quotes.status.superseded,
      vi.quotes.decision.accept,
      vi.quotes.decision.acceptYes,
      vi.quotes.decision.decline,
      vi.quotes.dealOffer.setAmount,
      vi.quotes.dealOffer.dismiss,
      vi.quotes.orders.title,
      vi.quotes.orders.invoice,
      vi.quotes.orders.invoiceOpen,
      vi.quotes.orders.invoiceState.none,
      vi.quotes.orders.invoiceState.draft,
      vi.quotes.orders.invoiceState.issued,
      vi.quotes.orders.cancelOrder,
      vi.quotes.orders.delivery.open,
      vi.quotes.orders.delivery.mark,
      vi.quotes.orders.delivery.takeBack,
      vi.quotes.orders.delivery.stockPending,
      vi.quotes.orders.delivery.stockRecord,
      vi.quotes.orders.delivery.stockRetry,
      vi.quotes.orders.delivery.stockTeach,
      vi.quotes.create, vi.quotes.editor.addItem, vi.quotes.editor.copyFrom, vi.quotes.editor.save, vi.reports.title, vi.reports.tabs.quotes, vi.nav.apps.engage, vi.nav.contacts, vi.nav.deals, vi.contacts.add, vi.contacts.importFile, vi.savedViews.save, vi.deals.add, vi.deals.editStages, vi.deals.process.title, vi.contactImport.steps.preview]) {
      expect(text, label).toContain(`"${label}"`);
    }
  });

  // #3596: the English interface shows no Vietnamese in the guide, but for the names of the stages a new pipeline starts with, which are
  // data a person sees on the board in either language (DEFAULT_PIPELINE_STAGES).
  it('has no Vietnamese in English, but for the default stage names', () => {
    const stages = ['Mới', 'Đã liên hệ', 'Báo giá', 'Thương lượng', 'Thắng', 'Thua'].map((name) => `"${name}"`);
    let text = crmGuide('Ludy', 'en').flatMap((s) => [s.title, ...s.items]).join('\n');
    for (const stage of stages) text = text.replaceAll(stage, '');
    expect(text.match(/[ăâđêôơưàáạảãầấậẩẫằắặẳẵèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]\S*/gi) ?? []).toEqual([]);
  });

  it('has the same five steps and line counts in both languages, and quotes the labels of its own language', () => {
    const vietnamese = crmGuide('Ludy', 'vi');
    const english = crmGuide('Ludy', 'en');
    expect(english.map((s) => s.id)).toEqual(vietnamese.map((s) => s.id));
    expect(english.map((s) => s.items.length)).toEqual(vietnamese.map((s) => s.items.length));
    for (const locale of LOCALES) {
      const m = SOURCE_CATALOGS[locale];
      const text = crmGuide('Ludy', locale).flatMap((s) => s.items).join('\n');
      for (const label of [m.quotes.send.title, m.quotes.orders.invoice, m.deals.add, m.contacts.importFile, m.nav.apps.engage]) expect(text, `${locale} ${label}`).toContain(`"${label}"`);
    }
  });

  it('has no em dash or en dash in either language', () => {
    for (const locale of LOCALES) for (const s of crmGuide('Ludy', locale)) for (const line of [s.title, ...s.items]) expect(line, line).not.toMatch(/[–—]/);
  });
});
