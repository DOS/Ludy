// SPDX-License-Identifier: AGPL-3.0-only
// Unit and SSR UI tests for Notes v2 Quick Add chips, payload builder, and Alt+Q shortcut guard (#3556).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { zTodoCreate } from '@crove/kernel-contract';
import { parseTodoQuickAdd } from '@crove/l10n-vn';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { setActiveLocale } from '../src/i18n/runtime.ts';
import {
  buildTodoCreatePayload,
  hasOpenModalDialog,
  isEditableTarget,
  isQuickCaptureShortcut,
  OPEN_MODAL_DIALOG_SELECTOR,
  shiftDismissedTokens,
} from '../src/lib/quick-add.ts';

const apiState = vi.hoisted(() => ({ current: null as unknown as QueryClient }));

vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({ modules: ['kernel', 'notes', 'projects'] }),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, children, className }: { to: string; params?: Record<string, string>; children: React.ReactNode; className?: string }) => (
    <a href={to.replace('$slug', params?.slug ?? '')} className={className}>
      {children}
    </a>
  ),
  useParams: () => ({ slug: 'acme' }),
  useLocation: () => ({ pathname: '/o/acme/my-work' }),
  useNavigate: () => () => Promise.resolve(),
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  apiState.current = new QC({ defaultOptions: { queries: { retry: false } } });
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') {
          return (opts?: { input?: unknown }) => ({
            queryKey: opts && 'input' in opts ? [...path, opts.input] : path,
            queryFn: () => Promise.reject(new Error('not fetched in SSR test')),
          });
        }
        if (prop === 'key') {
          return (opts?: { input?: unknown }) => (opts && 'input' in opts ? [...path, opts.input] : path);
        }
        return node([...path, prop]);
      },
    });
  return {
    orpc: node([]),
    client: node([]),
    clientForOrg: () => node([]),
    queryClient: apiState.current,
    errorMessage: String,
  };
});

const { TodoQuickAddBar } = await import('../src/components/todo-quick-add.tsx');
const { ShellNav } = await import('../src/components/app-nav.tsx');
const { MyWorkPage } = await import('../src/routes/my-work.tsx');

const NOW = new Date('2026-11-17T08:00:00+07:00');
const TZ = 'Asia/Ho_Chi_Minh';

const altQ = (more: Partial<Parameters<typeof isQuickCaptureShortcut>[0]> = {}) => ({
  key: 'q',
  code: 'KeyQ',
  altKey: true,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  repeat: false,
  defaultPrevented: false,
  isComposing: false,
  target: null,
  ...more,
});

function renderInApp(locale: 'vi' | 'en', node: React.ReactNode): string {
  const qc = apiState.current;
  qc.clear();
  setActiveLocale(locale);
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <I18nProvider>{node}</I18nProvider>
      </QueryClientProvider>,
    );
  } finally {
    setActiveLocale('vi');
  }
}

describe('Alt+Q global Quick Capture shortcut guard (#3556)', () => {
  it('triggers only when notes module is active, user is authenticated, and focus is outside inputs', () => {
    expect(isQuickCaptureShortcut(altQ(), { notesEnabled: true, authenticated: true, activeElement: null })).toBe(true);
    // macOS Option+Q produces key "œ" with code "KeyQ"
    expect(isQuickCaptureShortcut(altQ({ key: 'œ', code: 'KeyQ' }), { notesEnabled: true, authenticated: true })).toBe(true);
    expect(isQuickCaptureShortcut(altQ({ key: 'Q', code: undefined }), { notesEnabled: true, authenticated: true })).toBe(true);

    expect(isQuickCaptureShortcut(altQ(), { notesEnabled: false, authenticated: true })).toBe(false);
    expect(isQuickCaptureShortcut(altQ(), { notesEnabled: true, authenticated: false })).toBe(false);
    expect(isQuickCaptureShortcut(altQ(), { notesEnabled: true, authenticated: true, canWrite: false })).toBe(false);
    expect(isQuickCaptureShortcut(altQ(), { notesEnabled: true, authenticated: true, modalOpen: true })).toBe(false);

    expect(isQuickCaptureShortcut(altQ({ altKey: false }), { notesEnabled: true, authenticated: true })).toBe(false);
    expect(isQuickCaptureShortcut(altQ({ ctrlKey: true }), { notesEnabled: true, authenticated: true })).toBe(false);
    expect(isQuickCaptureShortcut(altQ({ metaKey: true }), { notesEnabled: true, authenticated: true })).toBe(false);
    expect(isQuickCaptureShortcut(altQ({ shiftKey: true }), { notesEnabled: true, authenticated: true })).toBe(false);
    expect(isQuickCaptureShortcut(altQ({ repeat: true }), { notesEnabled: true, authenticated: true })).toBe(false);
    expect(isQuickCaptureShortcut(altQ({ isComposing: true }), { notesEnabled: true, authenticated: true })).toBe(false);
    expect(isQuickCaptureShortcut(altQ({ key: 'w', code: 'KeyW' }), { notesEnabled: true, authenticated: true })).toBe(false);
  });

  it('blocks Alt+Q when document.activeElement or event.target is an editable element', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'input', 'textarea']) {
      const el = { tagName, closest: () => null };
      expect(isEditableTarget(el), tagName).toBe(true);
      expect(isQuickCaptureShortcut(altQ(), { notesEnabled: true, authenticated: true, activeElement: el })).toBe(false);
      expect(
        isQuickCaptureShortcut(altQ({ target: el as unknown as EventTarget }), { notesEnabled: true, authenticated: true }),
      ).toBe(false);
    }
    const contentEditableEl = {
      tagName: 'DIV',
      isContentEditable: true,
      getAttribute: () => 'true',
      closest: () => null,
    };
    expect(isEditableTarget(contentEditableEl)).toBe(true);
    expect(
      isQuickCaptureShortcut(altQ(), { notesEnabled: true, authenticated: true, activeElement: contentEditableEl }),
    ).toBe(false);

    const nestedInEditable = {
      tagName: 'SPAN',
      isContentEditable: false,
      getAttribute: () => null,
      closest: (sel: string) => (sel.includes('contenteditable') ? contentEditableEl : null),
    };
    expect(isEditableTarget(nestedInEditable)).toBe(true);

    const button = { tagName: 'BUTTON', isContentEditable: false, getAttribute: () => null, closest: () => null };
    expect(isEditableTarget(button)).toBe(false);
    expect(isQuickCaptureShortcut(altQ(), { notesEnabled: true, authenticated: true, activeElement: button })).toBe(true);

    // Focusing a button inside a Base UI modal dialog ([role="dialog"] without aria-modal) or native dialog blocks Alt+Q
    const dialogButton = {
      tagName: 'BUTTON',
      isContentEditable: false,
      getAttribute: () => null,
      closest: (sel: string) => (sel.includes('[role="dialog"]:not([data-closed])') ? {} : null),
    };
    expect(isQuickCaptureShortcut(altQ(), { notesEnabled: true, authenticated: true, activeElement: dialogButton })).toBe(false);
    expect(hasOpenModalDialog({ querySelector: (sel) => (sel === OPEN_MODAL_DIALOG_SELECTOR ? ({} as Element) : null) })).toBe(
      true,
    );
    expect(hasOpenModalDialog({ querySelector: () => null })).toBe(false);
  });
});

describe('Quick Add payload builder & dismissed-span shifting (#3556)', () => {
  it('wires dueOn, dueTime, timeZone, reminder, and recurrence into zTodoCreate while preserving #3558 tokens', () => {
    const input = 'Gửi báo cáo ngày mai 9h mỗi tuần !p1 #thue /KeToan';
    const parsed = parseTodoQuickAdd(input, { now: NOW, timeZone: TZ });
    const payload = buildTodoCreatePayload(input, parsed, NOW);
    expect(payload).not.toBeNull();
    expect(payload?.dueOn).toBe('2026-11-18');
    expect(payload?.dueTime).toBe('09:00');
    expect(payload?.timeZone).toBe(TZ);
    expect(payload?.reminder).toEqual({ at: '2026-11-18T08:30:00+07:00' });
    expect(payload?.recurrence).toEqual({ freq: 'weekly', interval: 1 });
    // Non-date tokens from #3558 stay intact in title until their DB columns land
    expect(payload?.title).toBe('Gửi báo cáo !p1 #thue /KeToan');
    expect(zTodoCreate.safeParse(payload).success).toBe(true);

    const dailyInput = 'Gọi khách mỗi ngày 9h';
    const dailyPayload = buildTodoCreatePayload(dailyInput, parseTodoQuickAdd(dailyInput, { now: NOW, timeZone: TZ }), NOW);
    expect(dailyPayload).toMatchObject({
      title: 'Gọi khách',
      dueOn: '2026-11-17',
      dueTime: '09:00',
      recurrence: { freq: 'daily', interval: 1 },
    });
    expect(zTodoCreate.safeParse(dailyPayload).success).toBe(true);

    const recurrenceOnly = 'mỗi ngày';
    expect(buildTodoCreatePayload(recurrenceOnly, parseTodoQuickAdd(recurrenceOnly, { now: NOW, timeZone: TZ }), NOW)).toBeNull();
  });

  it('falls back to auto reminder when remindAt is already past and rejects empty titles', () => {
    const justBeforeDue = new Date('2026-11-17T08:45:00+07:00');
    const parsed = parseTodoQuickAdd('Gọi khách hôm nay 9h', { now: justBeforeDue, timeZone: TZ });
    const payload = buildTodoCreatePayload('Gọi khách hôm nay 9h', parsed, justBeforeDue);
    expect(payload?.dueOn).toBe('2026-11-17');
    expect(payload?.dueTime).toBe('09:00');
    expect(payload?.reminder).toBe('auto');
    expect(zTodoCreate.safeParse(payload).success).toBe(true);

    const dateOnly = parseTodoQuickAdd('ngày mai', { now: NOW, timeZone: TZ });
    expect(buildTodoCreatePayload('ngày mai', dateOnly, NOW)).toBeNull();
  });

  it('shifts dismissed spans cleanly when text before or after them changes', () => {
    const prev = 'Gọi khách ngày mai 9h';
    const tok = parseTodoQuickAdd(prev, { now: NOW, timeZone: TZ }).tokens[0]!;
    expect(tok.raw).toBe('ngày mai');

    const withPrefix = 'Khẩn: Gọi khách ngày mai 9h';
    const shifted = shiftDismissedTokens(prev, withPrefix, [tok]);
    expect(shifted).toHaveLength(1);
    expect(withPrefix.slice(shifted[0]!.start, shifted[0]!.end)).toBe('ngày mai');

    const editedInside = 'Gọi khách ngày kia 9h';
    expect(shiftDismissedTokens(prev, editedInside, [tok])).toEqual([]);
  });
});

describe('TodoQuickAddBar & ShellNav SSR rendering (#3556)', () => {
  it('renders live dismissible preview chips in Vietnamese and English', () => {
    const input = 'Gửi báo cáo ngày mai 9h30 hàng tuần thứ hai !p1 #thue /KeToan';
    const viHtml = renderInApp(
      'vi',
      <TodoQuickAddBar initialValue={input} nowOverride={NOW} timeZoneOverride={TZ} />,
    );
    expect(viHtml).toContain('Thêm việc, Enter để lưu');
    expect(viHtml).toContain('data-testid="quick-add-chips"');
    expect(viHtml).toContain('data-testid="quick-add-chip-date"');
    expect(viHtml).toContain('Ngày mai');
    expect(viHtml).toContain('data-testid="quick-add-chip-time"');
    expect(viHtml).toContain('09:30');
    expect(viHtml).toContain('data-testid="quick-add-chip-recurrence"');
    expect(viHtml).toContain('Hàng tuần · Thứ Hai');
    expect(viHtml).toContain('data-testid="quick-add-chip-priority"');
    expect(viHtml).toContain('Ưu tiên P1');
    expect(viHtml).toContain('data-testid="quick-add-chip-tag"');
    expect(viHtml).toContain('#thue');
    expect(viHtml).toContain('data-testid="quick-add-chip-list"');
    expect(viHtml).toContain('KeToan');
    expect(viHtml).toContain('data-testid="quick-add-dismiss-date"');
    expect(viHtml).toContain('min-h-6');
    expect(viHtml).toContain('size-6');
    expect(viHtml).toContain('data-testid="quick-add-preview"');
    expect(buildTodoCreatePayload('vào buổi tối nay', parseTodoQuickAdd('vào buổi tối nay', { now: NOW, timeZone: TZ }), NOW)).toBeNull();

    const enHtml = renderInApp(
      'en',
      <TodoQuickAddBar initialValue="Send report tomorrow 2:30pm every friday !p2 #ops /Admin" nowOverride={NOW} timeZoneOverride={TZ} />,
    );
    expect(enHtml).toContain('Add a to-do, Enter to save');
    expect(enHtml).toContain('Tomorrow');
    expect(enHtml).toContain('14:30');
    expect(enHtml).toContain('Every Friday');
    expect(enHtml).toContain('Priority P2');
    expect(enHtml).toContain('#ops');
    expect(enHtml).toContain('Admin');

    // Interval > 1 with weekday or month day shows the actual multi-interval in the preview chip
    const biweeklyVi = renderInApp('vi', <TodoQuickAddBar initialValue="Họp mỗi 2 tuần thứ sáu 9h" nowOverride={NOW} timeZoneOverride={TZ} />);
    expect(biweeklyVi).toContain('Mỗi 2 tuần · Thứ Sáu');
    const biweeklyEn = renderInApp('en', <TodoQuickAddBar initialValue="Call every 2 weeks on Friday 9am" nowOverride={NOW} timeZoneOverride={TZ} />);
    expect(biweeklyEn).toContain('Every 2 weeks on Friday');
  });

  it('renders MyWorkPage and ShellNav trigger cleanly', () => {
    const myWorkHtml = renderInApp('vi', <MyWorkPage />);
    expect(myWorkHtml).toContain('Thêm việc, Enter để lưu');
    expect(myWorkHtml).toContain('Alt+Q');

    const navWithTrigger = renderInApp(
      'vi',
      <ShellNav
        slug="acme"
        apps={[]}
        app="teamwork"
        inApp={false}
        badges={{}}
        orgs={[{ orgId: '1', slug: 'acme', name: 'Acme' }]}
        email="user@example.com"
        onOpenPalette={() => undefined}
        paletteKeys="Ctrl K"
        onOpenQuickCapture={() => undefined}
      />,
    );
    expect(navWithTrigger).toContain('data-testid="shell-quick-capture-btn"');
    expect(navWithTrigger).toContain('Thêm nhanh việc cần làm (Alt+Q)');

    const navWithoutTrigger = renderInApp(
      'vi',
      <ShellNav
        slug="acme"
        apps={[]}
        app="teamwork"
        inApp={false}
        badges={{}}
        orgs={[{ orgId: '1', slug: 'acme', name: 'Acme' }]}
        email="user@example.com"
        onOpenPalette={() => undefined}
        paletteKeys="Ctrl K"
      />,
    );
    expect(navWithoutTrigger).not.toContain('data-testid="shell-quick-capture-btn"');

    const tonightHtml = renderInApp(
      'en',
      <TodoQuickAddBar initialValue="Call tonight" nowOverride={NOW} timeZoneOverride={TZ} />,
    );
    expect(tonightHtml).toContain('data-testid="quick-add-chip-date"');
    expect(tonightHtml).toContain('19:00');
    expect(tonightHtml).not.toContain('data-testid="quick-add-chip-time"');

    const tmrMorningHtml = renderInApp(
      'en',
      <TodoQuickAddBar initialValue="Call tomorrow morning" nowOverride={NOW} timeZoneOverride={TZ} />,
    );
    expect(tmrMorningHtml).toContain('data-testid="quick-add-chip-date"');
    expect(tmrMorningHtml).toContain('data-testid="quick-add-chip-time"');
    expect(tmrMorningHtml).toContain('09:00');

    const rolledTimeOnlyHtml = renderInApp(
      'vi',
      <TodoQuickAddBar
        initialValue="Gọi khách 9h"
        nowOverride={new Date('2026-11-17T10:00:00+07:00')}
        timeZoneOverride={TZ}
      />,
    );
    expect(rolledTimeOnlyHtml).not.toContain('data-testid="quick-add-chip-date"');
    expect(rolledTimeOnlyHtml).toContain('data-testid="quick-add-chip-time"');
    expect(rolledTimeOnlyHtml).toContain('Ngày mai');
    expect(rolledTimeOnlyHtml).toContain('09:00');
  });
});
