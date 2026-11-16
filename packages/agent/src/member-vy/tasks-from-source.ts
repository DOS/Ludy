// SPDX-License-Identifier: AGPL-3.0-only
// Member-scoped Vy task proposal from a readable note, meeting, or conversation (#2608): pure prompt + deterministic validation.
// Model sees only the caller-readable source wrapped in nonce tags and active seats of project members.
// Model output is untrusted: titles, seat ids and due dates are sanitized and checked before return.
import { privateText, revealPrivateText } from '../private-text.ts';
import type { BoundPorts } from './ports.ts';
import { runFeature } from './run-feature.ts';
import {
  TASKS_FROM_NOTE_LIMITS,
  buildTaskProposalInstruction,
  serializeAllowedSeats,
  stripTaskProposalControlChars,
  validateProposedTasks,
  type CheckedProposalsResult,
  type ProposeTasksFromNoteResult,
  type ProjectMemberSeatOption,
} from './tasks-from-note.ts';

export type TaskSourceKind = 'note' | 'meeting' | 'conversation';
export type TasksFromSourceErrorCode = 'SOURCE_EMPTY' | 'SOURCE_TOO_LONG' | 'PROPOSAL_UNPARSABLE';

export class TasksFromSourceError extends Error {
  readonly code: TasksFromSourceErrorCode;
  constructor(code: TasksFromSourceErrorCode, message: string) {
    super(message);
    this.name = 'TasksFromSourceError';
    this.code = code;
  }
}

export interface TasksFromSourceInput {
  sourceKind: TaskSourceKind;
  projectName: string;
  sourceTitle: string;
  sourceBody: string;
  today: string;
  segments?: ReadonlyArray<{ text: string; today: string }>;
  language: 'vi' | 'en';
  seats: readonly ProjectMemberSeatOption[];
}

const SOURCE_LABELS: Record<TaskSourceKind, { description: string; noun: string }> = {
  note: { description: 'a single work note', noun: 'note' },
  meeting: { description: 'a single meeting record (title, summary, action items, notes, or transcript)', noun: 'meeting record' },
  conversation: { description: 'a single conversation thread', noun: 'conversation' },
};

/** Deterministically validates raw model task proposals against allowed project seats and source dates. */
export function checkProposedTasksFromSource(
  raw: string,
  input: Pick<TasksFromSourceInput, 'sourceTitle' | 'sourceBody' | 'today' | 'segments' | 'seats'>,
): CheckedProposalsResult {
  return validateProposedTasks(raw, input, (msg) => new TasksFromSourceError('PROPOSAL_UNPARSABLE', msg));
}

/** Runs Vy on a single caller-readable source and returns deterministically validated project task proposals. */
export async function proposeTasksFromSource(
  input: TasksFromSourceInput,
  ports: BoundPorts,
): Promise<ProposeTasksFromNoteResult> {
  const sourceText = `${input.sourceTitle}\n${input.sourceBody}`.trim();
  if (sourceText.length === 0) {
    throw new TasksFromSourceError('SOURCE_EMPTY', 'Source has no content to extract tasks from');
  }
  const sourceBytes = Buffer.byteLength(input.sourceTitle, 'utf8') + Buffer.byteLength(input.sourceBody, 'utf8');
  if (sourceBytes > TASKS_FROM_NOTE_LIMITS.sourceBytes) {
    throw new TasksFromSourceError('SOURCE_TOO_LONG', 'Source exceeds maximum byte length for task proposal');
  }

  const label = SOURCE_LABELS[input.sourceKind];
  const instruction = buildTaskProposalInstruction(label.description, label.noun);
  const distinctDates = input.segments ? new Set(input.segments.map((s) => s.today)).size : 0;
  const useDatedSegments = Boolean(
    input.segments &&
      input.segments.length > 0 &&
      (distinctDates > 1 || input.segments.some((s) => s.today !== input.today)),
  );
  const subjectPayload = JSON.stringify({
    today: input.today,
    language: input.language,
    projectName: stripTaskProposalControlChars(input.projectName).trim().slice(0, 200),
    allowedSeats: serializeAllowedSeats(input.seats),
    sourceKind: input.sourceKind,
    sourceTitle: input.sourceTitle,
    ...(useDatedSegments
      ? { sourceSegments: input.segments!.map((s) => ({ messageDate: s.today, text: s.text })) }
      : { sourceBody: input.sourceBody }),
  });

  const out = await runFeature(
    {
      instruction,
      subject: privateText(subjectPayload),
      maxSubjectChars: Math.max(TASKS_FROM_NOTE_LIMITS.sourceBytes + 8_000, subjectPayload.length),
      feature: 'projects.tasks_from_source',
    },
    ports,
  );

  return { ...checkProposedTasksFromSource(revealPrivateText(out.text), input), usage: out.usage };
}
