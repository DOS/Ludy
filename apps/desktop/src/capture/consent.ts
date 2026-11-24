// SPDX-License-Identifier: AGPL-3.0-only
// Recording consent notice and 409 CAPTURE_ALREADY_RUNNING wording for Ludy Desktop (#4516).
// Kept identically synchronized with packages/meeting-recorder/src/notice.ts (verified by apps/desktop/test/consent.test.ts).
import type { ConsentMethod } from '../server-api.ts';

export const RECORDING_NOTICE_LANGUAGES = ['vi', 'en'] as const;
export type RecordingNoticeLanguage = (typeof RECORDING_NOTICE_LANGUAGES)[number];

export interface RecordingNotice {
  version: string;
  reviewed: false;
  reviewIssue: 2585;
  text: Record<RecordingNoticeLanguage, string>;
}

export const RECORDING_NOTICE: RecordingNotice = {
  version: '2026-11-v1',
  reviewed: false,
  reviewIssue: 2585,
  text: {
    vi: 'Cuộc họp này đang được ghi âm để lập biên bản. Nếu ai không đồng ý, xin báo ngay để chúng tôi dừng ghi.',
    en: 'This meeting is being recorded to prepare the minutes. If anyone does not agree, please say so now and we will stop recording.',
  },
};

export const CONSENT_METHODS: readonly ConsentMethod[] = ['told_at_start', 'in_call_chat', 'in_invite', 'in_writing'] as const;

export type ConsentBlocker = 'title' | 'consentMethod' | 'consentAgreed' | null;

export function consentBlocker(input: { title: string; consentMethod: string; consentAgreed: boolean }): ConsentBlocker {
  if (input.title.trim().length === 0) return 'title';
  if (!(CONSENT_METHODS as readonly string[]).includes(input.consentMethod)) return 'consentMethod';
  if (!input.consentAgreed) return 'consentAgreed';
  return null;
}

export function noticeToCopy(language: RecordingNoticeLanguage): { text: string; version: string } {
  return { text: RECORDING_NOTICE.text[language], version: RECORDING_NOTICE.version };
}

export type CaptureKind = 'extension' | 'app' | 'desktop';

export interface CaptureHeld {
  kind: CaptureKind;
  since: string;
}

const CAPTURE_KIND_LABELS: Record<RecordingNoticeLanguage, Record<CaptureKind, string>> = {
  vi: {
    extension: 'Tiện ích Ludy',
    app: 'Ứng dụng Ludy',
    desktop: 'Ứng dụng Ludy Desktop',
  },
  en: {
    extension: 'The Ludy extension',
    app: 'The Ludy app',
    desktop: 'Ludy Desktop',
  },
};

// Formats 409 CAPTURE_ALREADY_RUNNING for both Vietnamese and English locales without leaking any person name.
export function formatCaptureAlreadyRunning(details: CaptureHeld | null, language: RecordingNoticeLanguage = 'vi'): string {
  if (details) {
    const at = new Date(details.since);
    if (!Number.isNaN(at.getTime())) {
      const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const kind = CAPTURE_KIND_LABELS[language][details.kind];
      if (language === 'en') {
        return `${kind} has been recording this meeting since ${time}. Ask them to share the running meeting instead of recording twice.`;
      }
      return `${kind} đang ghi cuộc họp này từ ${time}. Hãy dùng hoặc xin chia sẻ cuộc họp đang ghi đó thay vì ghi thêm bản thứ hai.`;
    }
  }
  return language === 'en'
    ? 'This meeting is already being recorded somewhere else. Use that recording, or stop it before recording again.'
    : 'Cuộc họp này đang được ghi ở một nơi khác. Hãy dùng bản ghi đó, hoặc dừng nó trước khi ghi lại.';
}
