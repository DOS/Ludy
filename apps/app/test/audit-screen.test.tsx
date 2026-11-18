// The audit log screen (#672) with command labels (#1654), rendered on the server. It speaks in sentences (#3595): a row says
// what was done, the system's own rows are behind a switch, no command name or id is in the list, and the raw record is in
// the row's detail sheet. The command filter shows each command by its label in the screen's language.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { AuditEntry } from '@crove/kernel-contract';
import { AuditDetailBody } from '../src/components/audit-detail.tsx';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'infiniteOptions')
          return (o: { initialPageParam: unknown; getNextPageParam: unknown }) => ({ ...o, queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: {}, queryClient: client.current, errorMessage: (e: unknown) => String(e) };
});

// The command palette and this screen ask which apps the org has: the finance search is on.
vi.mock('../src/lib/auth.ts', () => ({ getConfig: () => ({ modules: ['kernel', 'finance'] }) }));

// The URL's filters (#1445), as the router hands them to the page.
const search = vi.hoisted(() => ({ current: {} as Record<string, string> }));
vi.mock('@tanstack/react-router', async (importOriginal) => ({ ...(await importOriginal<object>()), useSearch: () => search.current }));

const { AuditPage } = await import('../src/routes/audit.tsx');

const row = (id: string, command: string): AuditEntry => ({
  id,
  at: '2026-10-24T03:00:00.000Z',
  actorType: 'user',
  actorId: '00000000-0000-7000-8000-0000000000a1',
  actorName: 'Lan',
  command,
  outcome: 'ok',
  targetType: null,
  targetId: null,
  proposalId: null,
  via: null,
  detail: null,
});

// A row an AI app wrote over MCP: actor system, the client's self-declared name in `via`.
const mcpRow = (id: string): AuditEntry => ({ ...row(id, 'kernel.mcp.call'), actorType: 'system', actorId: null, actorName: null, via: { kind: 'mcp', clientName: 'Claude Desktop' } });

function render(locale: 'vi' | 'en', rows: AuditEntry[] = [row('a', 'kernel.proposal.approve'), row('b', 'kernel.retired.command')]): string {
  const qc = client.current;
  qc.setQueryData(['org', 'get'], { role: 'owner', members: [] });
  qc.setQueryData(['org', 'auditCommands'], ['kernel.proposal.approve', 'kernel.retired.command', 'finance.period.lock']);
  qc.setQueryData(['org', 'audit'], { pages: [{ items: rows, more: false }], pageParams: [undefined] });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <AuditPage />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

const NOTIFY = (id: string): AuditEntry => ({ ...row(id, 'kernel.notification.dispatch'), actorType: 'system', actorId: null, actorName: null, detail: 'aal=aal2; build=dev; policy.P10=self_approved' });
const DISPATCH = (id: string): AuditEntry => ({ ...row(id, 'kernel.agent.dispatch_event'), actorType: 'system', actorId: null, actorName: null });

// The list's table as the owner reads it: its markup, with no filter above it.
const table = (html: string): string => /<table[\s\S]*<\/table>/.exec(html)?.[0] ?? '';
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('AuditPage command labels', () => {
  it('shows the Vietnamese label in the command filter, sorted by label, and a sentence in the list', () => {
    const html = render('vi');
    expect(html).toContain('value="kernel.proposal.approve">Duyệt đề xuất</option>');
    expect(html).toContain('value="finance.period.lock">Khóa sổ kỳ kế toán</option>');
    expect(html.indexOf('Duyệt đề xuất</option>')).toBeLessThan(html.indexOf('Khóa sổ kỳ kế toán</option>'));
    expect(text(table(html))).toContain('Đã duyệt đề xuất');
  });

  it('shows the English label in English, and a command with no label by its name in the filter only', () => {
    const html = render('en');
    expect(html).toContain('value="kernel.proposal.approve">Approve a proposal</option>');
    expect(html).toContain('value="kernel.retired.command">kernel.retired.command</option>');
    expect(text(table(html))).toContain('Approved a proposal');
    // A command no longer registered has no words to show: the list says so, and the name stays in the detail sheet.
    expect(text(table(html))).toContain('Ran an old action that is no longer used');
    expect(table(html)).not.toContain('kernel.retired.command');
  });
});

// AL-1 (#3595): the demo org's four approvals are what the default list shows; the system's routine rows are not in it.
describe('AuditPage default list', () => {
  const approvals = ['a1', 'a2', 'a3', 'a4'].map((id) => row(id, 'kernel.proposal.approve'));
  const rows = [NOTIFY('n1'), approvals[0]!, DISPATCH('d1'), approvals[1]!, NOTIFY('n2'), approvals[2]!, approvals[3]!];

  it('shows four "đã duyệt" rows and no kernel.* text, with a line saying what is hidden', () => {
    const html = render('vi', rows);
    const list = table(html);
    expect(text(list).match(/Đã duyệt đề xuất/g)).toHaveLength(4);
    expect(list).not.toContain('kernel.');
    expect(text(list)).not.toContain('aal=');
    expect(text(list)).not.toContain('Hệ thống');
    expect(text(html)).toContain('Đang ẩn 3 dòng việc tự chạy của hệ thống');
    expect(text(html)).toContain('Hiện cả việc hệ thống');
  });

  it('says the same in English', () => {
    const html = render('en', rows);
    expect(text(table(html)).match(/Approved a proposal/g)).toHaveLength(4);
    expect(table(html)).not.toContain('kernel.');
    expect(text(html)).toContain('Show system activity too');
    expect(text(html)).toContain('Hiding 3 rows of routine system work');
  });

  it('shows the system rows, as sentences, when the link or the switch asks for them', () => {
    search.current = { system: '1' };
    try {
      const html = render('vi', rows);
      expect(text(table(html))).toContain('Đã gửi thông báo');
      expect(text(table(html))).toContain('Đã giao việc cho đồng nghiệp AI theo sự kiện');
      expect(table(html)).not.toContain('kernel.');
      expect(text(table(html))).not.toMatch(/tác tử/i);
    } finally {
      search.current = {};
    }
  });

  it('shows the system rows when the actor filter asks for the system, and only says so when it hid some', () => {
    search.current = { actor: 'system' };
    try {
      expect(text(table(render('vi', rows)))).toContain('Đã gửi thông báo');
    } finally {
      search.current = {};
    }
    expect(text(render('vi', approvals))).not.toContain('Đang ẩn');
  });

  it('keeps the actor and outcome, and a row that did not go through says it tried', () => {
    const refused: AuditEntry = { ...row('r', 'kernel.proposal.approve'), outcome: 'denied' };
    const html = render('vi', [refused]);
    expect(text(table(html))).toContain('Đã thử duyệt đề xuất');
    expect(text(table(html))).toContain('Bị từ chối');
    expect(text(table(html))).toContain('Lan');
    expect(text(table(render('en', [refused])))).toContain('Tried to approve a proposal');
  });

  it('calls an AI coworker a coworker, never a tác tử or an assistant', () => {
    const coworker: AuditEntry = { ...row('c', 'kernel.proposal.request'), actorType: 'agent', actorName: 'Ly' };
    const vi = render('vi', [coworker]);
    expect(text(table(vi))).toContain('Đồng nghiệp AI');
    expect(text(table(vi))).not.toMatch(/tác tử|trợ lý/i);
    const en = render('en', [coworker]);
    expect(text(table(en))).toContain('AI coworker');
    expect(text(table(en))).not.toMatch(/agent|assistant/i);
  });

  it('never says tác tử, even for an AI coworker command that was refused or has no sentence of its own', () => {
    const refused: AuditEntry = { ...row('u', 'kernel.agent.update'), outcome: 'denied' };
    expect(text(table(render('vi', [refused])))).toContain('Đã thử sửa đồng nghiệp AI');
    expect(text(table(render('vi', [refused])))).not.toMatch(/tác tử/i);
    expect(text(table(render('en', [refused])))).toContain('Tried to edit an AI coworker');
  });

  it('writes a short Vietnamese verb in lower case after "Đã"', () => {
    const revoked = row('v', 'kernel.member.role.revoke');
    expect(text(table(render('vi', [revoked])))).toContain('Đã bỏ vai trò của thành viên');
  });
});

// AL-2 (#3595): the object is found by a name or a number, not an id; the raw record is one click away.
describe('AuditPage object filter and detail', () => {
  it('asks for a name or a document number, and has no UUID field', () => {
    const vi = render('vi');
    expect(text(vi)).toContain('Chứng từ hoặc đối tác');
    expect(vi).toContain('placeholder="Gõ tên đối tác hoặc số chứng từ"');
    expect(vi).not.toMatch(/UUID|Mã đối tượng/);
    const en = render('en');
    expect(en).toContain('placeholder="Type a party name or a document number"');
    expect(en).not.toMatch(/UUID|Object id/);
  });

  it('shows the object as its kind and a link to its rows, never its id', () => {
    const withTarget: AuditEntry = { ...row('t', 'kernel.proposal.approve'), targetType: 'kernel.proposal', targetId: '0192f0aa-1111-7222-8333-944445555666' };
    const html = render('vi', [withTarget]);
    expect(text(table(html))).toContain('Đề xuất');
    expect(text(table(html))).toContain('Xem các dòng của mục này');
    expect(table(html)).not.toContain('0192f0aa');
    expect(table(html)).not.toContain('kernel.proposal');
  });

  it('puts the technical record in the detail sheet: the command, the object and the detail line', () => {
    const withTarget: AuditEntry = { ...row('t', 'kernel.proposal.approve'), targetType: 'kernel.proposal', targetId: '0192f0aa-1111-7222-8333-944445555666', detail: 'aal=aal2; policy.P10=self_approved' };
    const wrap = (body: React.ReactNode, locale: 'vi' | 'en') => renderToStaticMarkup(<IntlProvider locale={locale} messages={catalog(locale)}>{body}</IntlProvider>);
    const html = wrap(<AuditDetailBody row={withTarget} sentence="Đã duyệt đề xuất" actor="Lan" objectName="Đề xuất" />, 'vi');
    expect(html).toContain('kernel.proposal.approve');
    expect(html).toContain('0192f0aa-1111-7222-8333-944445555666');
    expect(html).toContain('aal=aal2; policy.P10=self_approved');
    expect(text(html)).toContain('Tên lệnh');
    expect(wrap(<AuditDetailBody row={withTarget} sentence="Approved a proposal" actor="Lan" objectName="Proposal" />, 'en')).toContain('Command name');
  });
});

describe('AuditPage MCP rows (#2975)', () => {
  it('names the AI app and says it is self-declared, never as a person or the bare system', () => {
    const vi = render('vi', [mcpRow('m')]);
    expect(vi).toContain('Qua Claude Desktop (MCP)');
    expect(vi).toContain('Ứng dụng AI tự khai tên');
    // The actor cell itself (the filter also has the word "Hệ thống"): not the bare system label, not a person.
    expect(vi).not.toMatch(/<td[^>]*>Hệ thống/);
    expect(vi).not.toContain('Lan');
    const en = render('en', [mcpRow('m')]);
    expect(en).toContain('Via Claude Desktop (MCP)');
    expect(en).not.toMatch(/<td[^>]*>System/);
  });

  it('keeps the person whose grant was used on a refusal row, under the AI app, never as their own click', () => {
    const refused: AuditEntry = { ...row('r', 'kernel.org.set_approval_preset'), outcome: 'denied', via: { kind: 'mcp', clientName: 'Claude Desktop' } };
    const vi = render('vi', [refused]);
    expect(vi).toContain('Qua Claude Desktop (MCP)');
    expect(vi).toContain('Theo quyền của Lan');
    expect(render('en', [refused])).toContain('Under the grant of Lan');
  });
});

describe('AuditPage filters from the URL (#1445)', () => {
  it('starts the object filter from a link, as a decided proposal opens it, and shows what it is, not its id', () => {
    search.current = { targetId: '0192f0aa-1111-7222-8333-944445555666', targetType: 'kernel.proposal' };
    try {
      const html = render('vi');
      expect(text(html)).toContain('Chỉ xem các dòng của: Đề xuất');
      expect(text(html)).toContain('Bỏ chọn');
      expect(text(html)).not.toContain('0192f0aa');
      // The picker gives way to the chosen object.
      expect(html).not.toContain('placeholder="Gõ tên đối tác hoặc số chứng từ"');
    } finally {
      search.current = {};
    }
  });
});
