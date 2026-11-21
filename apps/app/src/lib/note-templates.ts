// SPDX-License-Identifier: AGPL-3.0-only
// Built-in starter note templates and deterministic line-diff helper for version history (#3562, Notes v2 E3).
// Pure TypeScript with no React imports, so it can be unit tested directly.

export type StarterTemplateId = 'meeting-notes' | 'client-note' | 'process-sop' | 'weekly-work-log';

export interface StarterNoteTemplate {
  id: StarterTemplateId;
  name: string;
  description: string;
  title: string;
  body: string;
  tags: string[];
}

const STARTER_VI: readonly StarterNoteTemplate[] = [
  {
    id: 'meeting-notes',
    name: 'Biên bản họp',
    description: 'Mục tiêu buổi họp, người tham dự, quyết định chính và việc cần làm tiếp theo',
    title: 'Biên bản họp',
    body: [
      '## Thông tin chung',
      '- Ngày họp: ',
      '- Người tham dự: ',
      '- Mục tiêu: ',
      '',
      '## Nội dung trao đổi',
      '- ',
      '',
      '## Quyết định đã chốt',
      '- ',
      '',
      '## Việc cần làm tiếp theo',
      '- [ ] ',
    ].join('\n'),
    tags: ['hop'],
  },
  {
    id: 'client-note',
    name: 'Ghi chú khách hàng',
    description: 'Bối cảnh khách hàng, nhu cầu chính, cam kết báo giá và bước chăm sóc kế tiếp',
    title: 'Ghi chú khách hàng',
    body: [
      '## Bối cảnh & liên hệ',
      '- Người liên hệ: ',
      '- Kênh trao đổi: ',
      '',
      '## Nhu cầu & vấn đề cần giải quyết',
      '- ',
      '',
      '## Cam kết & lưu ý quan trọng',
      '- ',
      '',
      '## Bước tiếp theo',
      '- [ ] ',
    ].join('\n'),
    tags: ['khach-hang'],
  },
  {
    id: 'process-sop',
    name: 'SOP quy trình',
    description: 'Mục đích, khi nào áp dụng, các bước thực hiện và điểm kiểm tra chất lượng',
    title: 'Quy trình thực hiện (SOP)',
    body: [
      '## Mục đích & phạm vi',
      '- Khi nào dùng: ',
      '- Người phụ trách: ',
      '',
      '## Các bước thực hiện',
      '- [ ] Bước 1: ',
      '- [ ] Bước 2: ',
      '- [ ] Bước 3: ',
      '',
      '## Lưu ý & kiểm tra trước khi hoàn tất',
      '- ',
    ].join('\n'),
    tags: ['sop', 'quy-trinh'],
  },
  {
    id: 'weekly-work-log',
    name: 'Nhật ký công việc tuần',
    description: 'Ưu tiên đầu tuần, kết quả đã hoàn thành, vướng mắc và kế hoạch tuần tới',
    title: 'Nhật ký công việc tuần',
    body: [
      '## Ưu tiên chính trong tuần',
      '- [ ] ',
      '- [ ] ',
      '',
      '## Việc đã hoàn thành',
      '- ',
      '',
      '## Vướng mắc cần tháo gỡ',
      '- ',
      '',
      '## Kế hoạch tuần tới',
      '- [ ] ',
    ].join('\n'),
    tags: ['tuan'],
  },
];

const STARTER_EN: readonly StarterNoteTemplate[] = [
  {
    id: 'meeting-notes',
    name: 'Meeting notes',
    description: 'Agenda, attendees, key decisions and follow-up action items',
    title: 'Meeting notes',
    body: [
      '## Overview',
      '- Date: ',
      '- Attendees: ',
      '- Goal: ',
      '',
      '## Discussion points',
      '- ',
      '',
      '## Decisions made',
      '- ',
      '',
      '## Action items',
      '- [ ] ',
    ].join('\n'),
    tags: ['meeting'],
  },
  {
    id: 'client-note',
    name: 'Client note',
    description: 'Client context, needs, commitments and next follow-up steps',
    title: 'Client note',
    body: [
      '## Context & contact',
      '- Contact person: ',
      '- Channel: ',
      '',
      '## Needs & pain points',
      '- ',
      '',
      '## Commitments & key notes',
      '- ',
      '',
      '## Next steps',
      '- [ ] ',
    ].join('\n'),
    tags: ['client'],
  },
  {
    id: 'process-sop',
    name: 'Process SOP',
    description: 'Purpose, trigger, step-by-step checklist and quality checks',
    title: 'Standard operating procedure (SOP)',
    body: [
      '## Purpose & scope',
      '- When to use: ',
      '- Owner: ',
      '',
      '## Steps',
      '- [ ] Step 1: ',
      '- [ ] Step 2: ',
      '- [ ] Step 3: ',
      '',
      '## Checks before completion',
      '- ',
    ].join('\n'),
    tags: ['sop', 'process'],
  },
  {
    id: 'weekly-work-log',
    name: 'Weekly work log',
    description: 'Top priorities, completed outcomes, blockers and next week plan',
    title: 'Weekly work log',
    body: [
      '## Top priorities this week',
      '- [ ] ',
      '- [ ] ',
      '',
      '## Completed',
      '- ',
      '',
      '## Blockers',
      '- ',
      '',
      '## Next week',
      '- [ ] ',
    ].join('\n'),
    tags: ['weekly'],
  },
];

export function starterNoteTemplates(locale: string): readonly StarterNoteTemplate[] {
  return locale.startsWith('en') ? STARTER_EN : STARTER_VI;
}

export type DiffLineKind = 'same' | 'added' | 'removed';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export interface NoteVersionDiff {
  titleChanged: boolean;
  tagsChanged: boolean;
  bodyChanged: boolean;
  addedLines: number;
  removedLines: number;
  lines: DiffLine[];
}

const MAX_LCS_LINES = 400;

function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.replaceAll('\r\n', '\n').split('\n');
}

export function computeLineDiff(olderText: string, newerText: string): DiffLine[] {
  if (olderText === newerText) {
    return splitLines(newerText).map((text) => ({ kind: 'same', text }));
  }
  const a = splitLines(olderText);
  const b = splitLines(newerText);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1;
  }

  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA -= 1;
    endB -= 1;
  }

  const prefix: DiffLine[] = a.slice(0, start).map((text) => ({ kind: 'same', text }));
  const suffix: DiffLine[] = a.slice(endA + 1).map((text) => ({ kind: 'same', text }));
  const midA = a.slice(start, endA + 1);
  const midB = b.slice(start, endB + 1);

  if (midA.length === 0) {
    return [...prefix, ...midB.map((text): DiffLine => ({ kind: 'added', text })), ...suffix];
  }
  if (midB.length === 0) {
    return [...prefix, ...midA.map((text): DiffLine => ({ kind: 'removed', text })), ...suffix];
  }

  // Fallback for very large diffs so computing the diff stays fast on long notes.
  if (midA.length > MAX_LCS_LINES || midB.length > MAX_LCS_LINES) {
    return [
      ...prefix,
      ...midA.map((text): DiffLine => ({ kind: 'removed', text })),
      ...midB.map((text): DiffLine => ({ kind: 'added', text })),
      ...suffix,
    ];
  }

  const cols = midB.length + 1;
  const dp = new Int32Array((midA.length + 1) * cols);
  for (let i = midA.length - 1; i >= 0; i -= 1) {
    for (let j = midB.length - 1; j >= 0; j -= 1) {
      if (midA[i] === midB[j]) {
        dp[i * cols + j] = (dp[(i + 1) * cols + (j + 1)] ?? 0) + 1;
      } else {
        const down = dp[(i + 1) * cols + j] ?? 0;
        const right = dp[i * cols + (j + 1)] ?? 0;
        dp[i * cols + j] = down >= right ? down : right;
      }
    }
  }

  const middle: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < midA.length && j < midB.length) {
    if (midA[i] === midB[j]) {
      middle.push({ kind: 'same', text: midA[i] as string });
      i += 1;
      j += 1;
    } else if ((dp[(i + 1) * cols + j] ?? 0) >= (dp[i * cols + (j + 1)] ?? 0)) {
      middle.push({ kind: 'removed', text: midA[i] as string });
      i += 1;
    } else {
      middle.push({ kind: 'added', text: midB[j] as string });
      j += 1;
    }
  }
  while (i < midA.length) {
    middle.push({ kind: 'removed', text: midA[i] as string });
    i += 1;
  }
  while (j < midB.length) {
    middle.push({ kind: 'added', text: midB[j] as string });
    j += 1;
  }

  return [...prefix, ...middle, ...suffix];
}

export function computeNoteVersionDiff(
  snapshot: { title: string; body: string; tags: readonly string[] },
  current: { title: string; body: string; tags: readonly string[] },
): NoteVersionDiff {
  const lines = computeLineDiff(snapshot.body, current.body);
  let addedLines = 0;
  let removedLines = 0;
  for (const line of lines) {
    if (line.kind === 'added') addedLines += 1;
    else if (line.kind === 'removed') removedLines += 1;
  }
  return {
    titleChanged: snapshot.title !== current.title,
    tagsChanged: snapshot.tags.join('\u0000') !== current.tags.join('\u0000'),
    bodyChanged: snapshot.body !== current.body,
    addedLines,
    removedLines,
    lines,
  };
}
