// SPDX-License-Identifier: AGPL-3.0-only
// The one model call of the member's Vy translating a meeting summary (meetings integrations E1, #3184) goes through the AI budget meter under its own key and nowhere else: outside an
// AI scope it is refused before any request, a spent budget refuses it before any request (the meter is asked for meetings.translate, not for the summary's key), and a provider failure
// is a fixed word that never quotes the provider.
import { describe, expect, it } from 'vitest';
import { AI_FEATURES, AiBudgetExhaustedError, AiMeterMissingError, TranslationModelError, generateMeetingTranslationText, withAiScope, type AiConfig, type AiMeter } from '../src/index.ts';

// A port nothing listens on: any request that was made would fail as a network error, so the tests see it.
const CONFIG: AiConfig = { baseURL: 'http://127.0.0.1:9/v1', apiKey: null, model: 'test-model' };
const PROMPT = { system: 'Dịch', user: 'Bí mật của khách A' };

describe('generateMeetingTranslationText', () => {
  it('has a meter key of its own, in the meetings module', () => {
    expect(AI_FEATURES['meetings.translate']).toBe('meetings');
  });

  it('is refused outside an AI scope, before any request', async () => {
    await expect(generateMeetingTranslationText(CONFIG, PROMPT, 500)).rejects.toBeInstanceOf(AiMeterMissingError);
  });

  it('is refused when the member\'s meter refuses, and the meter was asked for this feature and run', async () => {
    const asked: Array<{ feature: string; module: string; memberRunId: string | null | undefined }> = [];
    const meter: AiMeter = {
      admit: async (call) => {
        asked.push({ feature: call.feature, module: call.module, memberRunId: call.memberRunId });
        throw new AiBudgetExhaustedError('module', null);
      },
      record: async () => undefined,
    };
    await expect(withAiScope({ orgId: 'org-1', memberRunId: 'run-1', meter }, () => generateMeetingTranslationText(CONFIG, PROMPT, 500))).rejects.toBeInstanceOf(AiBudgetExhaustedError);
    expect(asked).toEqual([{ feature: 'meetings.translate', module: 'meetings', memberRunId: 'run-1' }]);
  });

  it('turns a provider failure into a fixed word that quotes nothing', async () => {
    const meter: AiMeter = { admit: async () => undefined, record: async () => undefined };
    const error = await withAiScope({ orgId: 'org-1', memberRunId: 'run-1', meter }, () => generateMeetingTranslationText(CONFIG, PROMPT, 2000)).then(
      () => null,
      (e: unknown) => e as unknown,
    );
    expect(error).toBeInstanceOf(TranslationModelError);
    expect((error as TranslationModelError).message).toMatch(/^TRANSLATE_(FAILED|TIMEOUT)$/);
    expect(String((error as Error).message) + String((error as Error).stack)).not.toContain('Bí mật');
  });
});
