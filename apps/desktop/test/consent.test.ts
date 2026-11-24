// SPDX-License-Identifier: AGPL-3.0-only
// Verifies desktop recording notice stays byte-for-byte identical to packages/meeting-recorder/src/notice.ts, plus consent & 409 copy rules.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONSENT_METHODS,
  RECORDING_NOTICE,
  consentBlocker,
  formatCaptureAlreadyRunning,
  noticeToCopy,
} from '../src/capture/consent.ts';
import { UI_BUNDLE_MIME, UI_CSP, isExpectedUiOrigin, resolveUiBundleFile } from '../src/capture/ui-bundle.ts';
import { bootConsentUi, type ConsentViewState } from '../src/capture/ui/consent-ui.ts';

async function loadCanonicalNotice(): Promise<typeof RECORDING_NOTICE> {
  const path = fileURLToPath(new URL('../../../packages/meeting-recorder/src/notice.ts', import.meta.url));
  const raw = readFileSync(path, 'utf8');
  const js = stripTypeScriptTypes(raw, { mode: 'strip' });
  const mod = (await import(`data:text/javascript;base64,${Buffer.from(js, 'utf8').toString('base64')}`)) as {
    RECORDING_NOTICE: typeof RECORDING_NOTICE;
  };
  return mod.RECORDING_NOTICE;
}

describe('RECORDING_NOTICE sync', () => {
  it('matches packages/meeting-recorder/src/notice.ts verbatim', async () => {
    const canonical = await loadCanonicalNotice();
    expect(RECORDING_NOTICE).toEqual(canonical);
    expect(RECORDING_NOTICE.version).toBe('2026-11-v1');
    expect(RECORDING_NOTICE.reviewed).toBe(false);
    expect(RECORDING_NOTICE.reviewIssue).toBe(2585);
  });

  it('returns matching notice text and version for vi and en copy', () => {
    expect(noticeToCopy('vi')).toEqual({ text: RECORDING_NOTICE.text.vi, version: RECORDING_NOTICE.version });
    expect(noticeToCopy('en')).toEqual({ text: RECORDING_NOTICE.text.en, version: RECORDING_NOTICE.version });
  });
});

describe('consentBlocker', () => {
  it('blocks missing title, unknown consent method, and unticked checkbox before allowing capture', () => {
    expect(consentBlocker({ title: '   ', consentMethod: 'told_at_start', consentAgreed: true })).toBe('title');
    expect(consentBlocker({ title: 'Standup', consentMethod: 'guessed', consentAgreed: true })).toBe('consentMethod');
    expect(consentBlocker({ title: 'Standup', consentMethod: 'told_at_start', consentAgreed: false })).toBe('consentAgreed');
    for (const method of CONSENT_METHODS) {
      expect(consentBlocker({ title: 'Weekly Sync', consentMethod: method, consentAgreed: true })).toBeNull();
    }
  });
});

describe('formatCaptureAlreadyRunning', () => {
  it('renders desktop, extension, and app capture holders cleanly in vi and en without leaking names', () => {
    const since = '2026-11-24T08:30:00.000Z';
    expect(formatCaptureAlreadyRunning({ kind: 'desktop', since }, 'vi')).toContain('Ứng dụng Ludy Desktop đang ghi cuộc họp này từ ');
    expect(formatCaptureAlreadyRunning({ kind: 'extension', since }, 'vi')).toContain('Tiện ích Ludy đang ghi cuộc họp này từ ');
    expect(formatCaptureAlreadyRunning({ kind: 'app', since }, 'vi')).toContain('Ứng dụng Ludy đang ghi cuộc họp này từ ');

    expect(formatCaptureAlreadyRunning({ kind: 'desktop', since }, 'en')).toContain('Ludy Desktop has been recording this meeting since ');
    expect(formatCaptureAlreadyRunning({ kind: 'extension', since }, 'en')).toContain('The Ludy extension has been recording this meeting since ');
    expect(formatCaptureAlreadyRunning({ kind: 'app', since }, 'en')).toContain('The Ludy app has been recording this meeting since ');
  });

  it('falls back cleanly when details are missing or invalid', () => {
    expect(formatCaptureAlreadyRunning(null, 'vi')).toContain('Cuộc họp này đang được ghi ở một nơi khác');
    expect(formatCaptureAlreadyRunning(null, 'en')).toContain('already being recorded somewhere else');
    expect(formatCaptureAlreadyRunning({ kind: 'desktop', since: 'not-a-date' }, 'en')).toContain('already being recorded somewhere else');
  });
});

describe('UI bundle allowlist, CSP, contrast & strict origin matching', () => {
  it('enforces exact origin matching and rejects sibling-prefix traversal or unlisted files', () => {
    expect(isExpectedUiOrigin('ludy-desktop://ui')).toBe(true);
    expect(isExpectedUiOrigin('ludy-desktop://ui/consent.html')).toBe(true);
    expect(isExpectedUiOrigin('ludy-desktop://ui_evil/consent.html')).toBe(false);
    expect(isExpectedUiOrigin('ludy-desktop://user@ui/consent.html')).toBe(false);
    expect(isExpectedUiOrigin('https://ui/consent.html')).toBe(false);

    const uiRoot = fileURLToPath(new URL('../src/capture/ui', import.meta.url));
    for (const name of Object.keys(UI_BUNDLE_MIME)) {
      const resolved = resolveUiBundleFile(uiRoot, `ludy-desktop://ui/${name}`);
      expect(resolved).toEqual({ path: join(uiRoot, name), mimeType: UI_BUNDLE_MIME[name] });
    }
    expect(resolveUiBundleFile(uiRoot, 'ludy-desktop://ui_extra/consent.html')).toBeNull();
    expect(resolveUiBundleFile(uiRoot, 'ludy-desktop://ui/')).toBeNull();
    expect(resolveUiBundleFile(uiRoot, 'ludy-desktop://ui/../package.json')).toBeNull();
    expect(resolveUiBundleFile(uiRoot, 'ludy-desktop://ui/%2e%2e/main.ts')).toBeNull();
    expect(resolveUiBundleFile(uiRoot, 'ludy-desktop://ui/unknown.js')).toBeNull();
    expect(resolveUiBundleFile(uiRoot, 'ludy-desktop://ui/consent.HTML')).toBeNull();
    expect(resolveUiBundleFile(uiRoot, 'ludy-desktop://ui/consent.html?q=1')).toBeNull();
  });

  it('uses strict style-src CSP without inline styles and meets WCAG AA dark-mode contrast', () => {
    expect(UI_CSP).toContain("style-src 'self'");
    expect(UI_CSP).toContain("base-uri 'none'");
    expect(UI_CSP).toContain("form-action 'none'");
    expect(UI_CSP).not.toContain('unsafe-inline');

    const consentHtml = readFileSync(fileURLToPath(new URL('../src/capture/ui/consent.html', import.meta.url)), 'utf8');
    expect(consentHtml).not.toMatch(/\sstyle=/);

    const css = readFileSync(fileURLToPath(new URL('../src/capture/ui/styles.css', import.meta.url)), 'utf8');
    expect(css).toContain('--accent: #1d4ed8;');
    expect(css).toContain('--danger-fill: #b91c1c;');
  });
});

describe('consent-ui agenda event selection without id', () => {
  it('populates agenda events without ev.id, prefills titleInput, and sends agendaId only when present', async () => {
    interface FakeOption {
      value: string;
      textContent: string;
      dataset: Record<string, string>;
    }
    type Listener = (ev: { preventDefault(): void; key?: string }) => void;
    const makeEl = () => {
      const listeners = new Map<string, Listener[]>();
      const classes = new Set<string>();
      const children: FakeOption[] = [];
      let curValue = '';
      return {
        value: '',
        textContent: '',
        checked: false,
        disabled: false,
        dataset: {} as Record<string, string>,
        classList: {
          add: (c: string) => classes.add(c),
          remove: (c: string) => classes.delete(c),
          has: (c: string) => classes.has(c),
        },
        set innerHTML(_v: string) {
          children.length = 0;
        },
        appendChild(opt: FakeOption) {
          children.push(opt);
        },
        get options() {
          return children;
        },
        get selectedOptions() {
          return children.filter((c) => c.value === curValue);
        },
        get selectedIndexValue() {
          return curValue;
        },
        set selectValue(v: string) {
          curValue = v;
        },
        focus() {},
        addEventListener(type: string, cb: Listener) {
          const list = listeners.get(type) ?? [];
          list.push(cb);
          listeners.set(type, list);
        },
        dispatch(type: string) {
          for (const cb of listeners.get(type) ?? []) cb({ preventDefault() {} });
        },
      };
    };

    const byId = new Map<string, ReturnType<typeof makeEl>>();
    for (const id of [
      'heading',
      'consent-form',
      'window-select',
      'agenda-wrap',
      'agenda-select',
      'title-input',
      'join-url-input',
      'consent-method',
      'notice-text',
      'lang-toggle',
      'copy-notice',
      'copy-status',
      'consent-agreed',
      'live-notes',
      'fallback-box',
      'fallback-text',
      'fallback-confirm',
      'error-box',
      'refresh-btn',
      'cancel-btn',
      'submit-btn',
    ]) {
      byId.set(id, makeEl());
    }
    const agendaEl = byId.get('agenda-select')!;
    Object.defineProperty(agendaEl, 'value', {
      get: () => agendaEl.selectedIndexValue,
      set: (v: string) => {
        agendaEl.selectValue = v;
      },
    });
    const winEl = byId.get('window-select')!;
    Object.defineProperty(winEl, 'value', {
      get: () => winEl.selectedIndexValue,
      set: (v: string) => {
        winEl.selectValue = v;
      },
    });

    const submitted: Array<Record<string, unknown>> = [];
    const initialState: ConsentViewState = {
      busy: false,
      error: null,
      systemFallbackRequired: false,
      windows: [],
      agendaEnabled: true,
      agendaEvents: [
        { id: 'ag-1', title: 'Weekly Review', startsAt: '2026-11-24T09:00:00.000Z', endsAt: '2026-11-24T10:00:00.000Z', joinHost: 'meet.google.com' },
        { title: 'Adhoc Sync Without ID', startsAt: '2026-11-24T10:30:00.000Z', endsAt: '2026-11-24T11:00:00.000Z', joinHost: null },
      ],
      noticeVersion: RECORDING_NOTICE.version,
      noticeText: RECORDING_NOTICE.text,
    };

    const g = globalThis as Record<string, unknown>;
    const prevWindow = g.window;
    const prevDocument = g.document;
    try {
      const winListeners = new Map<string, Listener[]>();
      g.document = {
        getElementById: (id: string) => byId.get(id) ?? null,
        createElement: () => ({ value: '', textContent: '', dataset: {} }),
      };
      g.window = {
        ludyDesktopBridge: {
          consentInit: async () => initialState,
          consentRefreshWindows: async () => [],
          consentRefreshAgenda: async () => initialState.agendaEvents,
          consentCopyNotice: async () => undefined,
          consentStart: async (draft: Record<string, unknown>) => {
            submitted.push(draft);
            return { ok: true };
          },
          consentCancel: async () => undefined,
          onConsentState: () => () => undefined,
        },
        addEventListener: (type: string, cb: Listener) => {
          const list = winListeners.get(type) ?? [];
          list.push(cb);
          winListeners.set(type, list);
        },
      };

      bootConsentUi();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(agendaEl.options).toHaveLength(3);
      expect(agendaEl.options[2]?.dataset.title).toBe('Adhoc Sync Without ID');

      // Pick event WITHOUT ev.id -> titleInput prefills, submit omits agendaId.
      agendaEl.value = '1';
      agendaEl.dispatch('change');
      expect(byId.get('title-input')!.value).toBe('Adhoc Sync Without ID');

      byId.get('consent-method')!.value = 'told_at_start';
      byId.get('consent-agreed')!.checked = true;
      byId.get('consent-form')!.dispatch('submit');
      expect(submitted[0]?.title).toBe('Adhoc Sync Without ID');
      expect('agendaId' in submitted[0]!).toBe(false);

      // Pick event WITH ev.id -> clear title, prefill, submit includes agendaId: 'ag-1'.
      byId.get('title-input')!.value = '';
      agendaEl.value = '0';
      agendaEl.dispatch('change');
      expect(byId.get('title-input')!.value).toBe('Weekly Review');
      byId.get('consent-form')!.dispatch('submit');
      expect(submitted[1]?.agendaId).toBe('ag-1');
    } finally {
      g.window = prevWindow;
      g.document = prevDocument;
    }
  });
});
