// SPDX-License-Identifier: AGPL-3.0-only
// The type question of the create-org screen (#4802), rendered on the server: a fieldset with its legend, two native radios of one group
// (so the arrow keys, Tab and Space work as the browser does for any radio group), "Một mình tôi" chosen by default, a label and a hint on
// each, rows at least 44 px high, and the same words in both languages. The mutation that sends the choice is the kernel's
// (apps/kernel/test/org-create-kind.db.test.ts); the picker is the choice's only UI.
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { ORG_KINDS } from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';
import { DEFAULT_ORG_KIND, OrgKindPicker } from '../src/components/org-kind-picker.tsx';

const render = (value: 'solo' | 'team', locale: 'vi' | 'en' = 'vi') =>
  renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)}>
      <OrgKindPicker value={value} onChange={() => undefined} />
    </IntlProvider>,
  );

const radios = (html: string) => [...html.matchAll(/<input[^>]*type="radio"[^>]*>/g)].map((m) => m[0]);

describe('OrgKindPicker', () => {
  it('defaults to "Một mình tôi"', () => {
    expect(DEFAULT_ORG_KIND).toBe('solo');
    const [solo, team] = radios(render(DEFAULT_ORG_KIND));
    expect(solo).toContain('value="solo"');
    expect(solo).toContain('checked=""');
    expect(team).toContain('value="team"');
    expect(team).not.toContain('checked');
  });

  it('is one fieldset named by its legend, with a native radio per type in a single group', () => {
    const html = render('solo');
    expect(html).toMatch(/^<fieldset[^>]*><legend[^>]*>[^<]+<\/legend>/);
    const inputs = radios(html);
    expect(inputs).toHaveLength(ORG_KINDS.length);
    expect(inputs.map((i) => i.match(/value="([^"]+)"/)?.[1])).toEqual([...ORG_KINDS]);
    expect(new Set(inputs.map((i) => i.match(/name="([^"]+)"/)?.[1])).size).toBe(1);
    // Each radio sits inside its label, so a click anywhere on the row chooses it.
    expect([...html.matchAll(/<label[^>]*>(?:(?!<\/label>).)*<input[^>]*type="radio"/g)]).toHaveLength(2);
  });

  it('chooses the other type when it is the value', () => {
    const [solo, team] = radios(render('team'));
    expect(solo).not.toContain('checked');
    expect(team).toContain('checked=""');
  });

  it('gives every row a 44 px touch target and a visible focus ring', () => {
    const labels = [...render('solo').matchAll(/<label[^>]*class="([^"]*)"/g)].map((m) => m[1] ?? '');
    expect(labels).toHaveLength(2);
    for (const cls of labels) {
      expect(cls).toContain('min-h-11');
      expect(cls).toContain('has-[:focus-visible]:ring-2');
    }
  });

  it('says what each type turns on, in both languages, and that apps switch later in Settings', () => {
    for (const [locale, m] of [['vi', viMessages.onboarding], ['en', en.onboarding]] as const) {
      const html = render('solo', locale);
      for (const key of ['kindLegend', 'kindSolo', 'kindSoloHint', 'kindTeam', 'kindTeamHint', 'kindLater'] as const) {
        expect(html, `${locale} ${key}`).toContain(m[key].replace('{brand}', 'Ludy').replace(/&/g, '&amp;'));
      }
    }
    expect(viMessages.onboarding.kindSolo).toBe('Một mình tôi');
    expect(viMessages.onboarding.kindTeam).toBe('Có nhân viên');
    expect(viMessages.onboarding.kindSoloHint).toContain('Tài chính, Cộng tác và Ludy AI');
    expect(viMessages.onboarding.kindTeamHint).toContain('Nhân sự, eSign và Engage');
  });
});
