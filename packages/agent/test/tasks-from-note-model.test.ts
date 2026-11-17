// SPDX-License-Identifier: AGPL-3.0-only
// Metered model adapter tests for projects.tasks_from_note (#2598).
import { describe, expect, it } from 'vitest';
import {
  AI_FEATURES,
  AiBudgetExhaustedError,
  AiMeterMissingError,
  TasksFromNoteModelError,
  generateTasksFromNoteText,
  generateTasksFromSourceText,
  withAiScope,
  type AiConfig,
  type AiMeter,
} from '../src/index.ts';

const CONFIG: AiConfig = { baseURL: 'http://127.0.0.1:9/v1', apiKey: null, model: 'test-model' };
const PROMPT = { system: 'Extract tasks', user: 'Secret client note' };

describe('generateTasksFromNoteText', () => {
  it('registers its meter key in the projects module', () => {
    expect(AI_FEATURES['projects.tasks_from_note']).toBe('projects');
  });

  it('refuses outside an AI scope before any request', async () => {
    await expect(generateTasksFromNoteText(CONFIG, PROMPT, 500)).rejects.toBeInstanceOf(AiMeterMissingError);
  });

  it('checks the meter under projects.tasks_from_note and memberRunId', async () => {
    const asked: Array<{ feature: string; module: string; memberRunId: string | null | undefined }> = [];
    const meter: AiMeter = {
      admit: async (call) => {
        asked.push({ feature: call.feature, module: call.module, memberRunId: call.memberRunId });
        throw new AiBudgetExhaustedError('module', null);
      },
      record: async () => undefined,
    };
    await expect(
      withAiScope({ orgId: 'org-1', memberRunId: 'run-1', meter }, () => generateTasksFromNoteText(CONFIG, PROMPT, 500)),
    ).rejects.toBeInstanceOf(AiBudgetExhaustedError);
    expect(asked).toEqual([{ feature: 'projects.tasks_from_note', module: 'projects', memberRunId: 'run-1' }]);
  });

  it('turns provider failures into a fixed code that leaks no prompt text', async () => {
    const meter: AiMeter = { admit: async () => undefined, record: async () => undefined };
    const error = await withAiScope({ orgId: 'org-1', memberRunId: 'run-1', meter }, () => generateTasksFromNoteText(CONFIG, PROMPT, 2000)).then(
      () => null,
      (e: unknown) => e as unknown,
    );
    expect(error).toBeInstanceOf(TasksFromNoteModelError);
    expect((error as TasksFromNoteModelError).message).toMatch(/^PROPOSAL_(FAILED|TIMEOUT)$/);
    expect(String((error as Error).message) + String((error as Error).stack)).not.toContain('Secret client note');
  });
});

describe('generateTasksFromSourceText', () => {
  it('registers its meter key in the projects module', () => {
    expect(AI_FEATURES['projects.tasks_from_source']).toBe('projects');
  });

  it('refuses outside an AI scope before any request', async () => {
    await expect(generateTasksFromSourceText(CONFIG, PROMPT, 500)).rejects.toBeInstanceOf(AiMeterMissingError);
  });

  it('checks the meter under projects.tasks_from_source and memberRunId', async () => {
    const asked: Array<{ feature: string; module: string; memberRunId: string | null | undefined }> = [];
    const meter: AiMeter = {
      admit: async (call) => {
        asked.push({ feature: call.feature, module: call.module, memberRunId: call.memberRunId });
        throw new AiBudgetExhaustedError('module', null);
      },
      record: async () => undefined,
    };
    await expect(
      withAiScope({ orgId: 'org-1', memberRunId: 'run-2', meter }, () => generateTasksFromSourceText(CONFIG, PROMPT, 500)),
    ).rejects.toBeInstanceOf(AiBudgetExhaustedError);
    expect(asked).toEqual([{ feature: 'projects.tasks_from_source', module: 'projects', memberRunId: 'run-2' }]);
  });

  it('turns provider failures into a fixed code that leaks no prompt text', async () => {
    const meter: AiMeter = { admit: async () => undefined, record: async () => undefined };
    const error = await withAiScope({ orgId: 'org-1', memberRunId: 'run-2', meter }, () => generateTasksFromSourceText(CONFIG, PROMPT, 2000)).then(
      () => null,
      (e: unknown) => e as unknown,
    );
    expect(error).toBeInstanceOf(TasksFromNoteModelError);
    expect((error as TasksFromNoteModelError).message).toMatch(/^PROPOSAL_(FAILED|TIMEOUT)$/);
    expect(String((error as Error).message) + String((error as Error).stack)).not.toContain('Secret client note');
  });
});
