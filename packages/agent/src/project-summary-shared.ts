// SPDX-License-Identifier: AGPL-3.0-only
// Shared prompt-framing, taint-allowance, and output-validation helpers for Vy's project weekly status and cycle summary (#4637).
import { draftLinksOutside } from './conversation.ts';
import {
  escapePromptFences,
  hasAddress,
  hasAutonomousActionDirective,
  hasInvisibleFormat,
  hasNegativeNumberSign,
  hasObfuscatedContactOrLink,
  hasProjectWrittenCountWords,
  hasPromptMarkupLeak,
  hasUngroundedMoneyOrScaleWords,
  plainLine,
  stripTrustedPhrases,
} from './injection-guards.ts';
import { summaryNumbersOutside, type SummaryFigure, type SummaryRequest } from './summary.ts';
import { sentencesOf } from './today.ts';

export const PROJECT_WEEKLY_STATUS_SENTENCES_MIN = 3;
export const PROJECT_WEEKLY_STATUS_SENTENCES_MAX = 5;
export const PROJECT_WEEKLY_STATUS_SENTENCE_MAX = 400;
export const PROJECT_WEEKLY_STATUS_TITLE_CHARS = 160;
export const PROJECT_WEEKLY_STATUS_COMMENT_CHARS = 160;

export interface ProjectWeeklyStatusTaskFact {
  title: string;
  tainted: boolean;
  status: string;
  dueDay: string | null;
  commentCount: number;
  latestComment: string | null;
}

export interface ProjectWeeklyStatusModelOutput {
  sentences: readonly string[];
}

export type ProjectWeeklyStatusFailureCode = 'EMPTY' | 'SENTENCES' | 'TOO_LONG' | 'AI_OUTPUT_UNSAFE' | 'LINK' | 'FORMAT';

export type ProjectWeeklyStatusResult =
  | { kind: 'summary'; sentences: string[] }
  | { kind: 'none'; code: ProjectWeeklyStatusFailureCode; badNumbers?: readonly string[] };

const isAsciiSpace = (ch: string | undefined): boolean => ch === ' ' || ch === '\t';

/** Linear O(n) check for Markdown blocks or list/heading prefixes without any backtracking regex. */
export function hasMarkdownNoise(item: string): boolean {
  if (item.includes('```')) return true;
  for (const line of item.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('|')) return true;
    const first = trimmed[0];
    if (first === '-' || first === '*' || first === '•') {
      if (isAsciiSpace(trimmed[1])) return true;
    }
    if (first === '#') {
      let hashes = 1;
      while (hashes < 6 && trimmed[hashes] === '#') hashes += 1;
      if (isAsciiSpace(trimmed[hashes])) return true;
    }
    if (first !== undefined && first >= '0' && first <= '9') {
      let digits = 1;
      while (digits < 4 && trimmed[digits] !== undefined && trimmed[digits]! >= '0' && trimmed[digits]! <= '9') {
        digits += 1;
      }
      const sep = trimmed[digits];
      if ((sep === '.' || sep === ')') && isAsciiSpace(trimmed[digits + 1])) return true;
    }
  }
  return false;
}

export function datePartsForAllowed(date: string | null): string[] {
  if (!date) return [];
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return [date];
  const [, year, month, day] = m as unknown as [string, string, string, string];
  return [date, `${Number(day)}/${Number(month)}/${year}`, `${Number(day)}/${Number(month)}`];
}

export function formatProjectTaskLine(task: ProjectWeeklyStatusTaskFact): string {
  const meta = [
    `status ${plainLine(task.status, 32)}`,
    task.dueDay ? `due ${task.dueDay}` : null,
    task.commentCount > 0 ? `${task.commentCount} comments` : null,
  ]
    .filter(Boolean)
    .join(', ');
  const snippet = task.latestComment ? plainLine(task.latestComment, PROJECT_WEEKLY_STATUS_COMMENT_CHARS) : '';
  const comment = snippet ? `; latest comment: "${escapePromptFences(snippet)}"` : '';
  const trustPrefix = task.tainted === false ? '' : '[coworker-written untrusted title] ';
  return `- ${trustPrefix}"${escapePromptFences(plainLine(task.title, PROJECT_WEEKLY_STATUS_TITLE_CHARS))}" (${meta}${comment})`;
}

export function collectProjectTaskAllowances(
  tasks: readonly ProjectWeeklyStatusTaskFact[],
  figures: SummaryFigure[],
  channels: string[],
  trustedTexts: string[],
): void {
  for (const task of tasks) {
    // Only human-authored untainted titles may ground numbers, links, or phrases in the output check (#4424).
    if (task.tainted === false) {
      const title = plainLine(task.title, PROJECT_WEEKLY_STATUS_TITLE_CHARS);
      if (title) {
        channels.push(title);
        trustedTexts.push(title);
      }
    }
    if (task.commentCount > 0) figures.push({ label: 'Task comment count', value: task.commentCount });
    if (task.dueDay) {
      for (const part of datePartsForAllowed(task.dueDay)) channels.push(part);
    }
    if (task.latestComment) {
      const snippet = plainLine(task.latestComment, PROJECT_WEEKLY_STATUS_COMMENT_CHARS);
      if (snippet) channels.push(snippet);
    }
  }
}

export function checkProjectSummaryOutput(
  output: ProjectWeeklyStatusModelOutput | null | undefined,
  buildAllowed: () => {
    summaryInput: Pick<SummaryRequest, 'language' | 'period' | 'figures' | 'channels'>;
    trustedTexts: string[];
  },
): ProjectWeeklyStatusResult {
  const rawList = output?.sentences ?? [];
  if (rawList.length === 0) return { kind: 'none', code: 'EMPTY' };

  const maxRawLength = PROJECT_WEEKLY_STATUS_SENTENCES_MAX * PROJECT_WEEKLY_STATUS_SENTENCE_MAX;
  for (const item of rawList) {
    if (item.length > maxRawLength) return { kind: 'none', code: 'TOO_LONG' };
    if (hasInvisibleFormat(item) || hasPromptMarkupLeak(item) || hasMarkdownNoise(item)) {
      return { kind: 'none', code: 'FORMAT' };
    }
  }

  const sentences = rawList.flatMap((item) => sentencesOf(item));
  if (sentences.length === 0) return { kind: 'none', code: 'EMPTY' };
  if (sentences.length < PROJECT_WEEKLY_STATUS_SENTENCES_MIN || sentences.length > PROJECT_WEEKLY_STATUS_SENTENCES_MAX) {
    return { kind: 'none', code: 'SENTENCES' };
  }

  for (const s of sentences) {
    if (hasInvisibleFormat(s) || hasPromptMarkupLeak(s) || hasMarkdownNoise(s)) {
      return { kind: 'none', code: 'FORMAT' };
    }
    if (s.length > PROJECT_WEEKLY_STATUS_SENTENCE_MAX) return { kind: 'none', code: 'TOO_LONG' };
  }

  const joined = sentences.join(' ');
  const { summaryInput, trustedTexts } = buildAllowed();
  if (draftLinksOutside(joined, trustedTexts).length > 0) {
    return { kind: 'none', code: 'LINK' };
  }
  const untrustedRemainder = stripTrustedPhrases(joined, trustedTexts);
  if (hasAddress(untrustedRemainder) || hasObfuscatedContactOrLink(untrustedRemainder) || hasAutonomousActionDirective(joined)) {
    return { kind: 'none', code: 'LINK' };
  }

  const outside = summaryNumbersOutside(joined, summaryInput);
  if (
    outside.length > 0 ||
    hasNegativeNumberSign(untrustedRemainder) ||
    hasUngroundedMoneyOrScaleWords(untrustedRemainder) ||
    hasProjectWrittenCountWords(untrustedRemainder)
  ) {
    return { kind: 'none', code: 'AI_OUTPUT_UNSAFE', badNumbers: outside };
  }

  return { kind: 'summary', sentences };
}
