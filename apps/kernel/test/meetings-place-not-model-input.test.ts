// SPDX-License-Identifier: AGPL-3.0-only
// The place of a meeting (#5013) is read by the meeting's own read and printed on the biên bản, and by nothing else: no model call is given it, and no audit detail, notice, mail or webhook
// names it. A static guard like the other "never in" ones: the files that build model input, notices, mails and hooks never name the meeting's `place` (code, comments stripped). The meeting's
// own read (modules/meetings/src/meetings.ts), its command (place.ts), the manifest and the Word file of the biên bản are the only places that do.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
// The meeting's own read and its command; the manifest class; and the Word file of the biên bản, which prints the place the person typed on the page (the page sends it to the file builder, which
// puts it on the sheet and nowhere else).
const ALLOWED = new Set([
  'modules/meetings/src/meetings.ts',
  'modules/meetings/src/place.ts',
  'modules/meetings/src/manifest.ts',
  'modules/meetings/src/minutes-docx.ts',
  'modules/meetings/src/minutes-docx-file.ts',
]);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    const stat = statSync(join(ROOT, rel));
    if (stat.isDirectory()) out.push(...sources(rel));
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
// The meeting's `place`: a property read, a key, a column name or a selected column.
const PLACE = /\.place\b|\bplace\s*[:,}]|'place'|"place"|\bplace\b\s*\)/;

describe("the meeting's place is not model input, audit detail, a notice, a mail or a hook (#5013)", () => {
  it('is named by no file that builds model input, a notice, a mail, a webhook or an export outside the meeting read, its command and the manifest', () => {
    const files = [
      ...sources('modules/meetings/src'),
      // The model code of the meetings features (the word "place" is used for other things in the rest of the agent package).
      ...sources('packages/agent/src').filter((file) => /meeting|translation|sales-insight/.test(file)),
      'apps/kernel/src/member-vy-ports.ts',
      'apps/kernel/src/mail-templates.ts',
      'apps/kernel/src/worker.ts',
    ];
    const offenders = files.filter((file) => !ALLOWED.has(file) && PLACE.test(code(readFileSync(join(ROOT, file), 'utf8'))));
    expect(offenders.map((f) => relative('.', f))).toEqual([]);
  });

  it('is kept out of the audit detail by the command: it audits the meeting id alone', () => {
    const source = code(readFileSync(join(ROOT, 'modules/meetings/src/place.ts'), 'utf8'));
    const audits = source.match(/ctx\.audit\(([^)]*)\)/g) ?? [];
    expect(audits).toEqual(['ctx.audit({ meetingId: input.meetingId })']);
  });
});
