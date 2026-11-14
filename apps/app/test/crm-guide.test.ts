// SPDX-License-Identifier: AGPL-3.0-only
// The CRM guide (#2231, #2699): four steps in Vietnamese, the brand filled in, the buttons quoted by the labels the screens show.
import { describe, expect, it } from 'vitest';
import { vi } from '../src/i18n/messages/vi.ts';
import { crmGuide } from '../src/lib/crm-guide.ts';

describe('crmGuide', () => {
  it('has the four steps in order, each with items and no unfilled placeholder', () => {
    const steps = crmGuide('Ludy');
    expect(steps.map((s) => s.id)).toEqual(['crm-contacts', 'crm-import', 'crm-deals', 'crm-quotes']);
    for (const step of steps) {
      expect(step.items.length).toBeGreaterThan(2);
      for (const text of [step.title, ...step.items]) expect(text, text).not.toMatch(/\{[a-z]+\}/);
    }
    expect(steps.flatMap((s) => s.items).join('\n')).toContain('Ludy');
  });

  it('quotes the buttons and screens by their current Vietnamese labels', () => {
    const text = crmGuide('Ludy').flatMap((s) => s.items).join('\n');
    for (const label of [vi.quotes.create, vi.quotes.editor.addItem, vi.quotes.editor.copyFrom, vi.quotes.editor.save, vi.reports.title, vi.reports.tabs.quotes, vi.nav.apps.engage, vi.nav.contacts, vi.nav.deals, vi.contacts.add, vi.contacts.importFile, vi.savedViews.save, vi.deals.add, vi.deals.view.settings, vi.contactImport.steps.preview]) {
      expect(text, label).toContain(`"${label}"`);
    }
  });
});
