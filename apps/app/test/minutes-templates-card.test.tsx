// SPDX-License-Identifier: AGPL-3.0-only
// The minutes templates an organization writes (#3578, part 3): the settings card of an owner or admin, the recorder's picker and the headings of a published custom summary, rendered on the
// server with the list answered from a seeded cache. A template's name and section titles are whatever an admin typed, so they are tried with markup and markdown: every one of them is shown
// as the text it is (escaped, no element made), and the card says in one line that a template is no place for names or personal details.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sectionsToText, type MinutesTemplateCopy, type MinutesTemplateView } from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  // orpc.<a>.<b>.queryOptions() / mutationOptions() / key(): keys are the path, nothing is ever fetched.
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), queryClient: client.current, errorMessage: (e: unknown) => String(e) };
});

const { MinutesTemplatesCard } = await import('../src/components/minutes-templates.tsx');
const { SummaryText, TemplatePicker } = await import('../src/components/meeting-results.tsx');

const at = '2026-11-17T00:00:00.000Z';
const HOSTILE = '<img src=x onerror=alert(1)>';
const view = (id: string, name: string, titles: string[], archived = false): MinutesTemplateView => ({
  id,
  name,
  sections: titles.map((title, i) => ({ key: `s${i + 1}`, title, hint: '' })),
  archived,
  createdAt: at,
  updatedAt: at,
});
const templates: MinutesTemplateView[] = [
  view('00000000-0000-7000-8000-000000000001', `Giao ban ${HOSTILE}`, ['Kết quả', '**bold** thật']),
  view('00000000-0000-7000-8000-000000000002', 'Họp khách hàng', ['Nhu cầu']),
  view('00000000-0000-7000-8000-000000000003', 'Mẫu cũ', ['Một'], true),
];

function render(node: React.ReactNode, locale: 'vi' | 'en' = 'en'): string {
  const qc = client.current;
  qc.setQueryData(['meetings', 'template', 'list'], { templates });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('the settings card', () => {
  beforeEach(() => client.current.clear());

  it('lists each template with its section count, shows the archived one read only, and shows names with markup or markdown as the text they are', () => {
    const html = render(<MinutesTemplatesCard />);
    const rows = html.split('data-testid="minutes-template"').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('Giao ban &lt;img src=x onerror=alert(1)&gt;');
    expect(rows[0]).toContain('2 sections');
    expect(rows[0]).toContain('**bold** thật');
    expect(rows[0]).toContain(`>${en.minutesTemplates.edit}<`);
    expect(rows[2]).toContain(`>${en.minutesTemplates.archived}<`);
    // An archived template has no edit and no archive button.
    expect(rows[2]).not.toContain(`>${en.minutesTemplates.edit}<`);
    expect(rows[2]).not.toContain(`>${en.minutesTemplates.archive}<`);
    expect(html).not.toContain('<img');
    expect(html).not.toMatch(/<[a-z]+[^>]*onerror/i);
    expect(html).not.toContain('<strong');
  });

  it('says in one line, in Vietnamese and in English, that a template holds no names or personal details', () => {
    expect(viMessages.minutesTemplates.noPersonalData).toBe('Không ghi tên người hay thông tin cá nhân vào mẫu');
    expect(en.minutesTemplates.noPersonalData).toBe("Do not put people's names or personal details in a template");
    expect(render(<MinutesTemplatesCard />, 'vi')).toContain('Không ghi tên người hay thông tin cá nhân vào mẫu');
    expect(render(<MinutesTemplatesCard />).replace(/&#x27;/g, "'")).toContain("Do not put people's names or personal details in a template");
  });

  it('has the same words in both languages', () => {
    expect(Object.keys(viMessages.minutesTemplates).sort()).toEqual(Object.keys(en.minutesTemplates).sort());
    expect(Object.keys(viMessages.meetings.templates).sort()).toEqual(Object.keys(en.meetings.templates).sort());
  });
});

describe('the recorder\'s picker', () => {
  beforeEach(() => client.current.clear());
  const copy: MinutesTemplateCopy = { name: 'Mẫu đã chọn', hash: 'a'.repeat(32), sections: [{ key: 's1', title: 'Kết quả', hint: '' }] };

  it('lists the five built-in types, then the active templates of the org by name (no archived one), the name shown as text', () => {
    const html = render(<TemplatePicker meetingId="m1" template="general" copy={null} />);
    const options = [...html.matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);
    expect(options.map((o) => o[0])).toEqual([
      'general',
      'briefing',
      'customer',
      'supplier',
      'one_on_one',
      'org:00000000-0000-7000-8000-000000000001',
      'org:00000000-0000-7000-8000-000000000002',
    ]);
    expect(options[5]?.[1]).toBe('Company template: Giao ban &lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('Mẫu cũ');
  });

  it('shows the meeting\'s own copy as the selected option under its name, though the template it came from is edited or archived', () => {
    const html = render(<TemplatePicker meetingId="m1" template="custom" copy={copy} />);
    expect(html).toContain('value="current-copy" selected="">Current template: Mẫu đã chọn</option>');
    // The org's templates are still offered, to take their current sections.
    expect(html).toContain('value="org:00000000-0000-7000-8000-000000000002">Company template: Họp khách hàng</option>');
  });
});

describe('the published summary of a custom meeting', () => {
  const copy: MinutesTemplateCopy = {
    name: 'Mẫu',
    hash: 'b'.repeat(32),
    sections: [
      { key: 's1', title: HOSTILE, hint: '' },
      { key: 's2', title: '**bold** thật', hint: '' },
    ],
  };

  it('shows the copy\'s headings as escaped text above the text of each section', () => {
    // The helper writes the one text from the sections, as the kernel does.
    const text = sectionsToText('custom', [{ key: 's1', text: 'Nội dung một.' }, { key: 's2', text: 'Nội dung hai.' }], copy.sections);
    const html = render(<SummaryText summary={text} decisions={[]} template="custom" copy={copy} />);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('**bold** thật');
    expect(html).toContain('Nội dung một.');
    expect(html).not.toContain('<img');
    expect(html).not.toMatch(/<[a-z]+[^>]*onerror/i);
  });
});
