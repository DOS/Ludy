// SPDX-License-Identifier: AGPL-3.0-only
// Verifies desktop recording notice stays byte-for-byte identical to packages/meeting-recorder/src/notice.ts, plus consent & 409 copy rules.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONSENT_METHODS,
  RECORDING_NOTICE,
  consentBlocker,
  formatCaptureAlreadyRunning,
  noticeToCopy,
} from '../src/capture/consent.ts';

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
