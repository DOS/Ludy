// SPDX-License-Identifier: AGPL-3.0-only
// Consent window DOM controller (ludy-desktop://ui/consent.html). Talks strictly via preload bridge with zero network/token access.

interface OfferedWindowView {
  hwnd: string;
  pid: number;
  client: string;
  appName: string;
  title: string;
}

interface AgendaEventView {
  id?: string;
  title: string;
  startsAt: string;
  endsAt: string;
  joinHost: string | null;
}

export interface ConsentViewState {
  busy: boolean;
  error: string | null;
  systemFallbackRequired: boolean;
  windows: readonly OfferedWindowView[];
  agendaEnabled: boolean;
  agendaEvents: readonly AgendaEventView[];
  noticeVersion: string;
  noticeText: { vi: string; en: string };
}

interface DesktopBridge {
  consentInit(): Promise<ConsentViewState>;
  consentRefreshWindows(): Promise<OfferedWindowView[]>;
  consentRefreshAgenda(): Promise<AgendaEventView[]>;
  consentCopyNotice(language: 'vi' | 'en'): Promise<void>;
  consentStart(draft: Record<string, unknown>): Promise<{ ok: boolean }>;
  consentCancel(): Promise<void>;
  onConsentState(cb: (state: ConsentViewState) => void): () => void;
}

export const CONSENT_UI_ORIGIN = 'ludy-desktop://ui';

export function bootConsentUi(): void {
  const bridge = (window as unknown as { ludyDesktopBridge?: DesktopBridge }).ludyDesktopBridge;
  if (!bridge) return;

  let current: ConsentViewState | null = null;
  let noticeLang: 'vi' | 'en' = 'vi';

  const heading = document.getElementById('heading');
  const form = document.getElementById('consent-form') as HTMLFormElement;
  const windowSelect = document.getElementById('window-select') as HTMLSelectElement;
  const agendaWrap = document.getElementById('agenda-wrap')!;
  const agendaSelect = document.getElementById('agenda-select') as HTMLSelectElement;
  const titleInput = document.getElementById('title-input') as HTMLInputElement;
  const joinUrlInput = document.getElementById('join-url-input') as HTMLInputElement;
  const consentMethod = document.getElementById('consent-method') as HTMLSelectElement;
  const noticeText = document.getElementById('notice-text')!;
  const langToggle = document.getElementById('lang-toggle') as HTMLButtonElement;
  const copyBtn = document.getElementById('copy-notice') as HTMLButtonElement;
  const copyStatus = document.getElementById('copy-status')!;
  const consentAgreed = document.getElementById('consent-agreed') as HTMLInputElement;
  const liveNotes = document.getElementById('live-notes') as HTMLInputElement;
  const fallbackBox = document.getElementById('fallback-box')!;
  const fallbackText = document.getElementById('fallback-text')!;
  const fallbackConfirm = document.getElementById('fallback-confirm') as HTMLInputElement;
  const errorBox = document.getElementById('error-box')!;
  const refreshBtn = document.getElementById('refresh-btn') as HTMLButtonElement;
  const cancelBtn = document.getElementById('cancel-btn') as HTMLButtonElement;
  const submitBtn = document.getElementById('submit-btn') as HTMLButtonElement;

  const renderNotice = () => {
    if (!current) return;
    noticeText.textContent = current.noticeText[noticeLang];
    langToggle.textContent = noticeLang === 'vi' ? 'English' : 'Tiếng Việt';
  };

  const renderState = (state: ConsentViewState) => {
    current = state;
    const prevWin = windowSelect.value;
    windowSelect.innerHTML = '';
    for (const w of state.windows) {
      const opt = document.createElement('option');
      opt.value = `pid:${w.pid}`;
      opt.textContent = `${w.appName}: ${w.title}`;
      windowSelect.appendChild(opt);
    }
    const micOpt = document.createElement('option');
    micOpt.value = 'mic-only';
    micOpt.textContent = 'Ghi âm trực tiếp (Micro)';
    windowSelect.appendChild(micOpt);
    if (prevWin && Array.from(windowSelect.options).some((o) => o.value === prevWin)) {
      windowSelect.value = prevWin;
    }

    if (state.agendaEnabled) {
      agendaWrap.classList.remove('hidden');
      const prevAgenda = agendaSelect.value;
      agendaSelect.innerHTML = '';
      const noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.textContent = 'Không chọn sự kiện lịch';
      agendaSelect.appendChild(noneOpt);
      state.agendaEvents.forEach((ev, idx) => {
        const opt = document.createElement('option');
        opt.value = String(idx);
        const time = new Date(ev.startsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        opt.textContent = `${time} - ${ev.title}`;
        opt.dataset.title = ev.title;
        if (ev.id) opt.dataset.agendaId = ev.id;
        agendaSelect.appendChild(opt);
      });
      if (prevAgenda && Array.from(agendaSelect.options).some((o) => o.value === prevAgenda)) {
        agendaSelect.value = prevAgenda;
      }
    } else {
      agendaWrap.classList.add('hidden');
    }

    renderNotice();
    if (state.systemFallbackRequired) {
      fallbackBox.classList.remove('hidden');
      fallbackText.textContent = state.error ?? '';
      errorBox.classList.add('hidden');
    } else {
      fallbackBox.classList.add('hidden');
      fallbackConfirm.checked = false;
      if (state.error) {
        errorBox.textContent = state.error;
        errorBox.classList.remove('hidden');
      } else {
        errorBox.classList.add('hidden');
      }
    }
    submitBtn.disabled = state.busy;
    submitBtn.textContent = state.busy ? 'Đang chuẩn bị...' : 'Bắt đầu ghi âm';
  };

  agendaSelect.addEventListener('change', () => {
    const selected = agendaSelect.selectedOptions[0];
    if (selected?.dataset.title && titleInput.value.trim() === '') {
      titleInput.value = selected.dataset.title;
    }
  });

  langToggle.addEventListener('click', () => {
    noticeLang = noticeLang === 'vi' ? 'en' : 'vi';
    renderNotice();
  });

  copyBtn.addEventListener('click', () => {
    void bridge.consentCopyNotice(noticeLang).then(() => {
      copyStatus.textContent = 'Đã sao chép thông báo vào bộ nhớ tạm.';
    });
  });

  refreshBtn.addEventListener('click', () => {
    void Promise.all([bridge.consentRefreshWindows(), bridge.consentRefreshAgenda()]).then(([wins, events]) => {
      if (!current) return;
      renderState({ ...current, windows: wins, agendaEvents: events });
    });
  });

  cancelBtn.addEventListener('click', () => void bridge.consentCancel());
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') void bridge.consentCancel();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const chosen = windowSelect.value;
    const isMicOnly = chosen === 'mic-only';
    const targetPid = !isMicOnly && chosen.startsWith('pid:') ? Number(chosen.slice(4)) : undefined;
    const selectedAgenda = agendaSelect.selectedOptions[0];
    const agendaId = selectedAgenda?.dataset.agendaId;
    void bridge.consentStart({
      title: titleInput.value,
      consentMethod: consentMethod.value,
      consentAgreed: consentAgreed.checked,
      noticeLanguage: noticeLang,
      liveNotes: liveNotes.checked,
      source: isMicOnly ? 'microphone' : 'system-audio-and-microphone',
      ...(targetPid !== undefined && Number.isInteger(targetPid) ? { targetPid } : {}),
      ...(agendaId ? { agendaId } : {}),
      ...(joinUrlInput.value.trim() ? { joinUrl: joinUrlInput.value.trim() } : {}),
      ...(fallbackConfirm.checked ? { allowSystemFallback: true } : {}),
    });
  });

  bridge.onConsentState(renderState);
  void bridge.consentInit().then((initial) => {
    renderState(initial);
    heading?.focus();
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  bootConsentUi();
}
