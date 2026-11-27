// SPDX-License-Identifier: AGPL-3.0-only
// EN/VI catalog, touch-target (>= 44px), and no-em/en-dash UI hygiene tests for Projects GitHub Slice 2 (#5159).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi } from '../src/i18n/messages/vi.ts';

const APP_SRC = fileURLToPath(new URL('../src', import.meta.url));

const SLICE2_GITHUB_KEYS = [
  'outboundRulesTitle',
  'outboundCloseIssueLabel',
  'outboundCloseIssueHint',
  'outboundConfirmBoxTitle',
  'outboundConfirmBoxBody',
  'outboundConfirmCheckbox',
  'outboundConfirmRequired',
  'aiBadge',
  'aiDeterministicBadge',
  'aiSummaryTitle',
  'aiSummaryBtn',
  'aiSummaryRefreshBtn',
  'aiSummaryHint',
  'aiIssueMatchTitle',
  'aiIssueMatchBtn',
  'aiIssueMatchConfirmBtn',
  'aiIssueMatchEmpty',
  'aiFallbackNotice',
  'aiMatchFallbackNotice',
  'aiBusyNotice',
] as const;

describe('Projects GitHub Integration Slice 2 UI & i18n (#5159)', () => {
  it('defines matching EN and VI copy with full Vietnamese diacritics, zero em/en dashes, and zero assistant wording', () => {
    const catalogs = [
      { locale: 'en', data: en },
      { locale: 'vi', data: vi },
    ] as const;

    for (const { locale, data } of catalogs) {
      const gh = data.projects.github as Record<string, string>;
      for (const key of SLICE2_GITHUB_KEYS) {
        const val = gh[key];
        expect(typeof val, `${locale}.projects.github.${key}`).toBe('string');
        expect(val?.trim().length, `${locale}.projects.github.${key} non-empty`).toBeGreaterThan(0);
        expect(val, `${locale}.projects.github.${key} no em/en dash`).not.toMatch(/[\u2014\u2013]/);
        expect(val?.normalize('NFC'), `${locale}.projects.github.${key} no assistant wording`).not.toMatch(/assistant|trợ lý/i);
      }

      const aiFeatures = data.aiMeter.features as Record<string, string>;
      expect(typeof aiFeatures.projects_github_pr_summary).toBe('string');
      expect(typeof aiFeatures.projects_github_issue_match).toBe('string');
      expect(aiFeatures.projects_github_pr_summary).not.toMatch(/[\u2014\u2013]/);
      expect(aiFeatures.projects_github_issue_match).not.toMatch(/[\u2014\u2013]/);

      const cmdGh = data.commandLabels.projects.github as unknown as Record<string, unknown>;
      expect(typeof cmdGh.outbound_context).toBe('string');
      expect(typeof cmdGh.record_outbound).toBe('string');
      expect(typeof cmdGh.ai_pr_summary_source).toBe('string');
      expect(typeof cmdGh.ai_issue_match_source).toBe('string');
    }

    expect((vi.projects.github as Record<string, string>).outboundCloseIssueLabel).toMatch(/[ăâđêôơưàáảãạ]/i);
    expect((vi.projects.github as Record<string, string>).aiIssueMatchConfirmBtn).toBe('Xác nhận gắn');
    expect((en.projects.github as Record<string, string>).aiIssueMatchConfirmBtn).toBe('Confirm Link');
  });

  it('keeps >= 44px (min-h-11) interactive targets on Slice 2 GitHub settings and task link controls with zero em/en dashes', () => {
    const settingsSrc = readFileSync(join(APP_SRC, 'components/project-github-settings.tsx'), 'utf8');
    const linksSrc = readFileSync(join(APP_SRC, 'components/project-task-github-links.tsx'), 'utf8');

    expect(settingsSrc).not.toMatch(/[\u2014\u2013]/);
    expect(linksSrc).not.toMatch(/[\u2014\u2013]/);

    // Confirm both new settings checkboxes & confirm box keep min-h-11 touch targets.
    expect(settingsSrc).toContain('data-testid="github-outbound-close-checkbox"');
    expect(settingsSrc).toContain('data-testid="github-outbound-confirm-checkbox"');
    expect(settingsSrc).toMatch(/flex min-h-11[\s\S]*github-outbound-close-checkbox/);
    expect(settingsSrc).toMatch(/flex min-h-11[\s\S]*github-outbound-confirm-checkbox/);

    // Confirm Vy PR summary button, issue match button, and Confirm Link button use min-h-11 without shrinking below 44px.
    expect(linksSrc).toMatch(/className="min-h-11[^"]*"[\s\S]*data-testid="github-pr-summary-btn"/);
    expect(linksSrc).toMatch(/className="min-h-11[^"]*"[\s\S]*data-testid="github-issue-match-btn"/);
    expect(linksSrc).toMatch(/className="min-h-11[^"]*"[\s\S]*data-testid="github-issue-match-confirm-btn"/);
  });
});
