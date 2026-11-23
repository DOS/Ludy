// The audit log screen's filter (#672): the form's text fields as the query's filter, and the cursor of the next page;
// and the commands' labels (#1654), on the screen and in the exported file.
import { AUDIT_OUTCOMES, type AuditCursor, type AuditEntry, type AuditFilter, type AuditOutcome, type AuditPage } from '@ludy/kernel-contract';

export interface AuditFilterForm {
  actor: string;
  command: string;
  outcome: string;
  target: string;
  // The target's type, from a link (#1445): it narrows the target id, and goes when the id is changed.
  targetType: string;
  from: string;
  to: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// As zAuditFilter's targetType and zAuditCommand.
const TARGET_TYPE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const COMMAND = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*\.?$/;

// Only what the server would accept: a target that is not a whole id is left out (the screen says so) rather than sent.
export function auditFilter(form: AuditFilterForm): AuditFilter {
  const target = form.target.trim().toLowerCase();
  const targetId = UUID.test(target) ? target : null;
  return {
    ...(form.actor ? { actor: form.actor } : {}),
    ...(form.command ? { command: form.command } : {}),
    ...((AUDIT_OUTCOMES as readonly string[]).includes(form.outcome) ? { outcome: form.outcome as AuditOutcome } : {}),
    ...(targetId ? { targetId } : {}),
    ...(targetId && TARGET_TYPE.test(form.targetType) ? { targetType: form.targetType } : {}),
    ...(DATE.test(form.from) ? { from: form.from } : {}),
    ...(DATE.test(form.to) ? { to: form.to } : {}),
  };
}

// The audit screen's filters in its URL (#1445): a link opens it filtered, for example from a proposal
// (?targetType=kernel.proposal&targetId=<id>). What is not a well-formed value is dropped.
export interface AuditSearch {
  actor?: string;
  command?: string;
  outcome?: AuditOutcome;
  targetType?: string;
  targetId?: string;
  from?: string;
  to?: string;
  // "1" opens the log with the system's own rows shown (#3595): the screen starts without them.
  system?: '1';
}

export function parseAuditSearch(search: Record<string, unknown>): AuditSearch {
  const text = (value: unknown, pattern: RegExp, max = 120) => (typeof value === 'string' && value.length <= max && pattern.test(value) ? value : undefined);
  const actor = typeof search.actor === 'string' && (search.actor === 'system' || UUID.test(search.actor)) ? search.actor.toLowerCase() : undefined;
  const outcome = typeof search.outcome === 'string' && (AUDIT_OUTCOMES as readonly string[]).includes(search.outcome) ? (search.outcome as AuditOutcome) : undefined;
  const found: Record<keyof AuditSearch, string | undefined> = {
    system: search.system === '1' || search.system === 1 || search.system === true ? '1' : undefined,
    actor,
    command: text(search.command, COMMAND),
    outcome,
    targetType: text(search.targetType, TARGET_TYPE),
    targetId: typeof search.targetId === 'string' && UUID.test(search.targetId) ? search.targetId.toLowerCase() : undefined,
    from: text(search.from, DATE, 10),
    to: text(search.to, DATE, 10),
  };
  return Object.fromEntries(Object.entries(found).filter(([, v]) => v !== undefined)) as AuditSearch;
}

// The form a search starts: its values, every other field empty.
export function auditForm(search: AuditSearch): AuditFilterForm {
  return {
    actor: search.actor ?? '',
    command: search.command ?? '',
    outcome: search.outcome ?? '',
    target: search.targetId ?? '',
    targetType: search.targetId ? (search.targetType ?? '') : '',
    from: search.from ?? '',
    to: search.to ?? '',
  };
}

export function nextAuditCursor(page: AuditPage): AuditCursor | undefined {
  const last = page.items.at(-1);
  return page.more && last ? { at: last.at, id: last.id } : undefined;
}

// The catalogs' command labels (#1654): nested by the dotted parts of each command's name.
export interface CommandLabels {
  readonly [part: string]: string | CommandLabels;
}

// The label of a command or query, or null for a name with none (one no longer registered, say).
export function commandLabel(labels: CommandLabels, name: string): string | null {
  let node: string | CommandLabels | undefined = labels;
  for (const part of name.split('.')) {
    if (typeof node !== 'object' || !Object.hasOwn(node, part)) return null;
    node = node[part];
  }
  return typeof node === 'string' ? node : null;
}

// A cell as the server writes it (csvCell in packages/kernel/src/audit-log.ts): quoted when it holds a comma, quote or
// line break, and a leading =, +, - or @ taken as text.
function csvCell(value: string): string {
  const s = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// The rows of a CSV file as the server writes it, each cell as written (quotes and all): a comma or a line break splits
// only outside quotes.
function csvRows(body: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === ',') {
      row.push(body.slice(start, i));
      start = i + 1;
    } else if (!quoted && ch === '\r' && body[i + 1] === '\n') {
      row.push(body.slice(start, i));
      rows.push(row);
      row = [];
      start = i + 2;
      i++;
    }
  }
  if (start < body.length || row.length > 0) rows.push([...row, body.slice(start)]);
  return rows;
}

// The audit export (kernel.audit.export) with a command_label column after its command column, in the screen's
// language; every cell of the server's file stays as written. A file without a command column is returned unchanged.
export function withCommandLabels(csv: string, label: (command: string) => string | null): string {
  const bom = csv.startsWith('﻿') ? '﻿' : '';
  const rows = csvRows(csv.slice(bom.length));
  const at = rows[0]?.indexOf('command') ?? -1;
  if (at < 0) return csv;
  const lines = rows.map((cells, i) => {
    const command = cells[at] ?? '';
    const extra = i === 0 ? 'command_label' : csvCell(label(command.startsWith('"') ? command.slice(1, -1).replace(/""/g, '"') : command) ?? '');
    return [...cells.slice(0, at + 1), extra, ...cells.slice(at + 1)].join(',');
  });
  return `${bom}${lines.join('\r\n')}\r\n`;
}

// The system's own rows (#3595): jobs, notifications and event dispatch that nobody did, which the log hides until asked.
// An AI app's call over MCP is not one of them: it names the app that acted.
export function isSystemRow(row: Pick<AuditEntry, 'actorType' | 'via'>): boolean {
  return row.actorType === 'system' && row.via === null;
}

// A label's first letter in lower case, for a sentence that goes on after "Đã" or "Tried to"; a label that starts with an AI
// coworker's name, an acronym or a product name ("Vy ...", "AI ...", "Google ...") keeps its capital.
const KEEP_CAPITAL = /^(Vy|Ly|Dy|Uy|Hy|Google|Zalo|Slack|Teams|Facebook|Instagram|TikTok|YouTube|Meta|Claude|MISA)$/;

export function lowerFirst(label: string): string {
  const word = /^[^\s,.:;()]+/u.exec(label)?.[0] ?? '';
  const keep = KEEP_CAPITAL.test(word) || (word.length > 1 && word === word.toUpperCase() && /\p{Lu}/u.test(word));
  return keep || word === '' ? label : label.charAt(0).toLowerCase() + label.slice(1);
}

// What the screen's object search offers (#3595): a party, or a document by its series, number or party, each with the id the
// log filters by. A document that came through a proposal is offered twice: its own rows (what was done to it later) and its
// approval (the decision and the rows of what it ran, as a link from a proposal shows, #1445); the filter takes one id, so the
// owner picks which. A journal entry is not offered: its rows name no entry, so the filter would find nothing.
export interface AuditTargetChoice {
  key: string;
  kind: 'party' | 'document' | 'approval';
  id: string;
  label: string;
  hint: string;
}

export interface AuditSearchFound {
  parties: readonly { id: string; name: string; taxCode: string | null }[];
  documents: readonly { id: string; series: string; number: string; partyName: string; proposalId: string | null }[];
}

export function auditTargetChoices(found: AuditSearchFound): AuditTargetChoice[] {
  return [
    ...found.parties.map((p): AuditTargetChoice => ({ key: `party-${p.id}`, kind: 'party', id: p.id, label: p.name, hint: p.taxCode ?? '' })),
    ...found.documents.flatMap((d): AuditTargetChoice[] => {
      const label = [d.series, d.number].filter(Boolean).join(' ');
      return [
        { key: `document-${d.id}`, kind: 'document', id: d.id, label, hint: d.partyName },
        ...(d.proposalId ? [{ key: `approval-${d.id}`, kind: 'approval' as const, id: d.proposalId, label, hint: d.partyName }] : []),
      ];
    }),
  ];
}
