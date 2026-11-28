// SPDX-License-Identifier: AGPL-3.0-only
// The card "Chế độ kế toán" in Settings > Kế toán (issue #1403, slice B2), rendered on the server with the state answered from a seeded cache: what is in force, why a switch is not offered, and which
// buttons each role gets; and the form of a choice, whose confirm button stays off until the tax authority is said to be told.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BooksRegimeEntity, BooksRegimeState } from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('@tanstack/react-router', async () => {
  const { createElement: h } = await import('react');
  return {
    useParams: () => ({ slug: 'acme' }),
    Link: ({ children, ...rest }: { children?: unknown }) => h('a', rest, children as never),
  };
});

vi.mock('../src/components/two-factor.tsx', () => ({ StepUpPrompt: () => null }));

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
  return { orpc: node([]), queryClient: client.current, errorMessage: (e: unknown) => String(e), isStepUpRequired: () => false };
});

const { BooksRegimeCard, ChooseForm } = await import('../src/routes/books-regime.tsx');

const idA = '00000000-0000-7000-8000-00000000000a';
const idB = '00000000-0000-7000-8000-00000000000b';
const entity = (over: Partial<BooksRegimeEntity> = {}): BooksRegimeEntity => ({
  legalEntityId: '00000000-0000-7000-8000-000000000001',
  name: 'Công ty TNHH Mẫu',
  isDefault: true,
  regime: 'tt133',
  chartVersion: '2026.1',
  since: null,
  scheduled: null,
  nextSwitchDate: '2027-01-01',
  blockers: [],
  ...over,
});

function render(entities: BooksRegimeEntity[], role: string): string {
  const qc = client.current;
  const state: BooksRegimeState = { entities };
  qc.setQueryData(['booksRegime', 'state'], state);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale="en" messages={catalog('en')}>
        <BooksRegimeCard role={role} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

const b = en.booksRegime;
// The text an English message becomes once its placeholders are filled (the date formats by locale, so only what does not depend on it is compared).
const prefix = (message: string) => message.split('{')[0] ?? message;

describe('BooksRegimeCard', () => {
  beforeEach(() => client.current.clear());

  it('says Circular 133 is in force and offers an owner the switch from the date the state names, with no entity name for one entity', () => {
    const html = render([entity()], 'owner');
    expect(html).toContain(b.current133);
    expect(html).toContain(prefix(b.offered));
    expect(html).toContain(prefix(b.choose));
    expect(html).toContain('2027');
    // No heading with the entity name (the region is still labelled by it for a screen reader, so the name is in an attribute, not in the text).
    expect(html).not.toContain('</h3>');
    expect(html).not.toMatch(/>Công ty TNHH Mẫu</);
    expect(html).not.toContain(b.ownerOnly);
    // The form of a choice is closed until the button is pressed.
    expect(html).not.toContain(b.ack);
    expect(html).toContain('aria-expanded="false"');
    // The place the done message is announced from is on the page, empty.
    expect(html).toMatch(/role="status"[^>]*data-testid="books-regime-done"[^>]*><\/p>|data-testid="books-regime-done"[^>]*role="status"[^>]*><\/p>/);
  });

  // Closed by default so the Accounting tab stays under 1200 px at 1440 wide (the e2e spec measures it): one summary line, the title and where the books stand.
  it('is closed by default with one status line that says where the books stand', () => {
    const status = (html: string) => /data-testid="books-regime-status">([^<]*)</.exec(html)?.[1] ?? '';
    const closed = render([entity()], 'owner');
    expect(closed).toContain('<details');
    expect(closed).not.toMatch(/<details[^>]*\sopen/);
    expect(closed).toContain('<summary');
    expect(closed).toMatch(/aria-labelledby="[^"]+"/);
    expect(status(closed)).toBe('Circular 133');
    expect(status(render([entity({ regime: 'tt99', since: '2027-01-01', nextSwitchDate: null })], 'owner'))).toMatch(/^Circular 99 since .*2027/);
    expect(status(render([entity({ nextSwitchDate: null, scheduled: { effectiveFrom: '2027-01-01', cancellable: true } })], 'owner'))).toMatch(/^Circular 133, Circular 99 chosen from .*2027/);
    expect(status(render([entity(), entity({ legalEntityId: '00000000-0000-7000-8000-000000000002', name: 'Chi nhánh Hà Nội', isDefault: false })], 'owner'))).toBe('2 entities, open to see');
  });

  // The kernel refuses a choice while a posting proposal waits (after the second factor), so the card names the date and the proposals and offers no button.
  it('does not offer the switch while a posting proposal holds it, though a date is named', () => {
    const html = render([entity({ blockers: [{ code: 'PENDING_PROPOSALS', proposalIds: [idA], nextSwitchDate: '2027-01-01' }] })], 'owner');
    expect(html).toContain(prefix(b.offered));
    expect(html).toContain(b.blockersTitle);
    expect(html).toContain('1 posting proposal is not finished');
    expect(html).toContain('Open proposal 1');
    expect(html).not.toContain(prefix(b.choose));
  });

  it('gives a member and a viewer the state and no button, and says who chooses', () => {
    for (const role of ['member', 'viewer']) {
      const html = render([entity()], role);
      expect(html, role).toContain(b.current133);
      expect(html, role).not.toContain(prefix(b.choose));
      expect(html, role).not.toContain(prefix(b.takeBack));
      expect(html, role).toContain(b.ownerOnly);
    }
  });

  it('gives an admin the way to take a waiting choice back, and not the choice', () => {
    const waiting = entity({ nextSwitchDate: null, scheduled: { effectiveFrom: '2027-01-01', cancellable: true } });
    const html = render([waiting], 'admin');
    // The two sentences share their beginning, so the part that differs is compared.
    expect(html).toContain('No entry falls under it yet');
    expect(html).toContain(prefix(b.takeBack));
    expect(html).not.toContain(prefix(b.choose));
    expect(html).not.toContain(b.ownerOnly);
    // An owner too; neither once entries fall under the choice.
    expect(render([waiting], 'owner')).toContain(prefix(b.takeBack));
    const locked = render([entity({ nextSwitchDate: null, scheduled: { effectiveFrom: '2027-01-01', cancellable: false } })], 'owner');
    expect(locked).toContain('Entries already fall under it');
    expect(locked).not.toContain('No entry falls under it yet');
    expect(locked).not.toContain(prefix(b.takeBack));
  });

  it('says why a switch is not offered, one sentence per blocker, with a link to each waiting proposal', () => {
    const html = render(
      [
        entity({
          nextSwitchDate: null,
          blockers: [
            { code: 'FISCAL_YEAR_UNSUPPORTED', fiscalYearEndMonth: 3 },
            { code: 'ENTRIES_ON_OR_AFTER', lastEntryDate: '2026-11-20' },
            { code: 'OPENING_ENTRY_BLOCKS', entryDate: '2026-12-31', entryId: idA, reversed: false },
            { code: 'PENDING_PROPOSALS', proposalIds: [idA, idB], nextSwitchDate: '2027-01-01' },
          ],
        }),
      ],
      'owner',
    );
    expect(html).toContain(b.notOffered);
    for (const code of ['FISCAL_YEAR_UNSUPPORTED', 'ENTRIES_ON_OR_AFTER', 'OPENING_ENTRY_BLOCKS', 'PENDING_PROPOSALS']) expect(html, code).toContain(`data-testid="books-blocker-${code}"`);
    expect(html).toContain(b.blockers.FISCAL_YEAR_UNSUPPORTED);
    expect(html).toContain('2 posting proposals are not finished');
    expect(html).toContain('Open proposal 1');
    expect(html).toContain('Open proposal 2');
    // Nothing to choose while no date is offered.
    expect(html).not.toContain(prefix(b.choose));
  });

  it('shows the entity name only when there are several, and one block each', () => {
    const html = render([entity(), entity({ legalEntityId: '00000000-0000-7000-8000-000000000002', name: 'Chi nhánh Hà Nội', isDefault: false })], 'owner');
    expect(html).toContain('>Công ty TNHH Mẫu</h3>');
    expect(html).toContain('>Chi nhánh Hà Nội</h3>');
    expect(html.split('data-testid="books-regime-entity"')).toHaveLength(3);
  });

  it('says Circular 99 is in force once switched, and offers an owner nothing more', () => {
    const html = render([entity({ regime: 'tt99', since: '2027-01-01', nextSwitchDate: null, blockers: [{ code: 'ALREADY_TT99', effectiveFrom: '2027-01-01' }] })], 'owner');
    expect(html).toContain(prefix(b.current99));
    expect(html).not.toContain(b.current133);
    expect(html).toContain('data-testid="books-blocker-ALREADY_TT99"');
    expect(html).not.toContain(prefix(b.choose));
    // Nobody is told to ask an owner for what no longer needs choosing.
    expect(render([entity({ regime: 'tt99', since: '2027-01-01', nextSwitchDate: null })], 'member')).not.toContain(b.ownerOnly);
  });
});

describe('ChooseForm', () => {
  const form = (notified: boolean, pending = false) =>
    renderToStaticMarkup(
      <IntlProvider locale="en" messages={catalog('en')}>
        <ChooseForm date="01/01/2027" notified={notified} pending={pending} onNotified={() => undefined} onConfirm={() => undefined} onClose={() => undefined} />
      </IntlProvider>,
    );
  // The opening tag of the button whose label is the given text.
  const buttonOf = (html: string, label: string) => html.split('<button').find((chunk) => chunk.includes(`>${label}<`)) ?? '';
  // The attribute itself: every Button carries the class names disabled:opacity-50 and the like, so the word alone proves nothing.
  const isDisabled = (button: string) => /\s(?:disabled=""|aria-disabled="true")/.test(button);

  it('keeps the confirm button off until the tax authority is said to be told, and says Ludy sends nothing to it', () => {
    const confirm = b.confirmChoose.replace('{date}', '01/01/2027');
    expect(form(false)).toContain(b.ack);
    expect(form(false)).toContain(b.ackHint);
    expect(buttonOf(form(false), confirm)).not.toBe('');
    expect(isDisabled(buttonOf(form(false), confirm))).toBe(true);
    expect(isDisabled(buttonOf(form(true), confirm))).toBe(false);
    // Never twice while a request is out.
    expect(isDisabled(buttonOf(form(true, true), confirm))).toBe(true);
  });

  it('labels the group by its title and has a button to close it without a change', () => {
    const html = form(false);
    expect(html).toContain(`aria-label="${b.chooseTitle.replace('{date}', '01/01/2027')}"`);
    expect(buttonOf(html, b.cancel)).not.toBe('');
    expect(isDisabled(buttonOf(html, b.cancel))).toBe(false);
  });
});
