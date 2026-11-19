// SPDX-License-Identifier: AGPL-3.0-only
// The MISA AMIS card in Settings (#3875), rendered on the server with the API's answers seeded in the cache: what an owner or admin can do, what a member or viewer sees, the access code field that
// is a password field and never carries a value, the entities that already have a connection left out of the form, "connected since" and nothing of the code, and no card at all where the connector
// is off and nothing is connected. Plus the small pure helpers the card uses.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LegalEntity, MisaAmisConnection } from '@crove/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { catalog } from '../src/i18n/runtime.ts';
import { connectableEntities, misaAmisCardShown } from '../src/lib/misa-amis-connections.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
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

const { MisaAmisConnectionsCard } = await import('../src/routes/misa-amis-connections.tsx');

type Role = 'owner' | 'admin' | 'member' | 'viewer';
const at = '2026-11-03T00:00:00.000Z';
const entity = (id: string, name: string, isDefault: boolean): LegalEntity => ({ id, name, kind: 'company', taxCode: '0100109100', parentId: null, isDefault, createdAt: at, updatedAt: at });
const connection = (over: Partial<MisaAmisConnection> = {}): MisaAmisConnection => ({ id: 'k1', connectionId: 'c1', legalEntityId: 'e1', displayName: 'MISA AMIS Kế toán', status: 'active', connectedAt: at, lastTestState: null, lastTestedAt: null, ...over });

interface Seed {
  offered?: boolean;
  connections?: MisaAmisConnection[];
  entities?: LegalEntity[];
  locale?: 'en' | 'vi';
}
function card(role: Role, seed: Seed = {}): string {
  const qc = client.current;
  qc.setQueryData(['misaAmis', 'status'], { offered: seed.offered ?? true });
  qc.setQueryData(['misaAmis', 'connections', 'list'], seed.connections ?? []);
  qc.setQueryData(['legalEntities', 'list'], seed.entities ?? [entity('e1', 'Công ty TNHH Mẫu', true)]);
  const locale = seed.locale ?? 'en';
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <MisaAmisConnectionsCard role={role} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('MisaAmisConnectionsCard', () => {
  beforeEach(() => client.current.clear());

  it.each<Role>(['owner', 'admin'])('as %s: with nothing connected shows the connect form with a password field for the access code, the note that it is encrypted and never shown again', (role) => {
    const html = card(role);
    expect(html).toContain(`>${en.misaAmisConnections.title}<`);
    expect(html).toContain(en.misaAmisConnections.noConnections);
    expect(html).toContain(`aria-label="${en.misaAmisConnections.connectTitle}"`);
    // A visible label above the field, tied to it, not a placeholder.
    const id = /<label for="([^"]+)"[^>]*>Connection code from AMIS<\/label>/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toMatch(new RegExp(`<input[^>]*id="${id}"[^>]*type="password"|<input[^>]*type="password"[^>]*id="${id}"`));
    expect(html).not.toContain('placeholder=');
    expect(html).toContain('autoComplete="off"');
    expect(html).not.toMatch(/<input[^>]*value="[^"]/);
    expect(html).toContain('never shown again');
    // One entity: nothing to choose.
    expect(html).not.toContain(`>${en.misaAmisConnections.entity}</label>`);
    expect(html).not.toContain('misa-amis-target');
  });

  it('lists a connection with "connected since" and its status, shows a disconnect button to an owner, and never carries the access code or any value of it', () => {
    const html = card('owner', { connections: [connection()] });
    expect(html).toContain(`>${en.misaAmisConnections.status.active}<`);
    expect(html).toContain('Connected since');
    expect(html).toContain(`>${en.misaAmisConnections.disconnect}<`);
    expect(html).not.toContain('accessCode":"');
    // The only entity has its connection: no form to connect another.
    expect(html).not.toContain(`aria-label="${en.misaAmisConnections.connectTitle}"`);
  });

  it('shows an owner or admin the test button of a live connection, and "not tested yet" before any test', () => {
    for (const role of ['owner', 'admin'] as const) {
      const html = card(role, { connections: [connection()] });
      expect(html).toContain(`>${en.misaAmisConnections.test}<`);
      expect(html).toContain(en.misaAmisConnections.neverTested);
    }
  });

  it('shows the last test as a sentence of its own state and the time, never a code or AMIS\'s text', () => {
    const states = ['works', 'wrong_credentials', 'unreachable'] as const;
    for (const state of states) {
      const html = card('owner', { connections: [connection({ lastTestState: state, lastTestedAt: at })] });
      expect(html).toContain(en.misaAmisConnections.testState[state]);
      expect(html).toContain('Last tested');
      expect(html).not.toContain(en.misaAmisConnections.neverTested);
    }
    expect(card('owner', { locale: 'vi', connections: [connection({ lastTestState: 'works', lastTestedAt: at })] })).toContain('Kết nối dùng được');
  });

  it('offers no test button for a connection that is not live, and none to a member or a viewer, who still read the last test', () => {
    expect(card('owner', { connections: [connection({ status: 'expired' })] })).not.toContain(`>${en.misaAmisConnections.test}<`);
    for (const role of ['member', 'viewer'] as const) {
      const html = card(role, { connections: [connection({ lastTestState: 'works', lastTestedAt: at })] });
      expect(html).not.toContain(`>${en.misaAmisConnections.test}<`);
      expect(html).toContain(en.misaAmisConnections.testState.works);
    }
  });

  it.each<Role>(['member', 'viewer'])('as %s: sees the connection and no button and no form', (role) => {
    const html = card(role, { connections: [connection()] });
    expect(html).toContain(`>${en.misaAmisConnections.status.active}<`);
    expect(html).not.toContain(`>${en.misaAmisConnections.disconnect}<`);
    expect(html).not.toContain(`aria-label="${en.misaAmisConnections.connectTitle}"`);
    expect(html).not.toContain('type="password"');
  });

  it('with several entities offers only those without a connection, and names the entity of a connection', () => {
    const entities = [entity('e1', 'Công ty TNHH Mẫu', true), entity('e2', 'Chi nhánh Hà Nội', false), entity('e3', 'Chi nhánh Đà Nẵng', false)];
    const html = card('admin', { entities, connections: [connection({ legalEntityId: 'e2' })] });
    expect(html).toContain('Chi nhánh Hà Nội</span>');
    expect(html).toContain(`>${en.misaAmisConnections.entity}</label>`);
    // The connect form's own selector: the preview panel of a connection has selects of its own.
    const form = /<form[\s\S]*?<\/form>/.exec(html)?.[0] ?? '';
    const select = /<select[^>]*>([\s\S]*?)<\/select>/.exec(form)?.[1] ?? '';
    expect(select).toContain('Công ty TNHH Mẫu');
    expect(select).toContain('Chi nhánh Đà Nẵng');
    expect(select).not.toContain('Chi nhánh Hà Nội');
  });

  it('names the one entity left to connect when the org has several, since there is no selector to show it', () => {
    const entities = [entity('e1', 'Công ty TNHH Mẫu', true), entity('e2', 'Chi nhánh Hà Nội', false)];
    const html = card('owner', { entities, connections: [connection({ legalEntityId: 'e1' })] });
    expect(html).toContain('data-testid="misa-amis-target"');
    expect(html).toMatch(/misa-amis-target[^>]*>[^<]*Legal entity[^<]*: [^<]*Chi nhánh Hà Nội/);
    expect(/<form[\s\S]*?<\/form>/.exec(html)?.[0] ?? '').not.toContain('<select');
  });

  it('says the connector is off, with no form, where the deployment does not offer it but an org still has a connection', () => {
    const html = card('owner', { offered: false, connections: [connection()] });
    expect(html).toContain(en.misaAmisConnections.off);
    expect(html).toContain(`>${en.misaAmisConnections.disconnect}<`);
    expect(html).not.toContain('type="password"');
  });

  it('draws no card at all where the connector is off and nothing is connected', () => {
    expect(card('owner', { offered: false, connections: [] })).toBe('');
  });

  it('is worded in Vietnamese too, without naming any setting of the deployment', () => {
    const html = card('owner', { locale: 'vi' });
    expect(html).toContain('Mã kết nối lấy từ AMIS');
    expect(html).not.toContain('CLIENT_ID');
  });
});

describe('misaAmisCardShown and connectableEntities', () => {
  it('shows the card when the connector is offered or a connection exists', () => {
    expect(misaAmisCardShown(true, [])).toBe(true);
    expect(misaAmisCardShown(false, [connection()])).toBe(true);
    expect(misaAmisCardShown(false, [])).toBe(false);
    expect(misaAmisCardShown(undefined, undefined)).toBe(false);
  });

  it('leaves out the entities that already have a connection', () => {
    const entities = [entity('e1', 'A', true), entity('e2', 'B', false)];
    expect(connectableEntities(entities, [connection({ legalEntityId: 'e1' })]).map((e) => e.id)).toEqual(['e2']);
    expect(connectableEntities(entities, [])).toHaveLength(2);
  });
});
