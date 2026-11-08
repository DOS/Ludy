// SPDX-License-Identifier: AGPL-3.0-only
// The restore deletes again the meetings a shred reference names before it opens the API (issue #2579, ADR-0047 point 7): the step is in tools/backup/restore.sh,
// after the WORM archive check and before the stack starts, and a non-zero exit stops the restore (the script runs under errexit with its STEP trap).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = readFileSync(fileURLToPath(new URL('../backup/restore.sh', import.meta.url)), 'utf8');

describe('restore.sh and the shred replay (#2579)', () => {
  it('runs shred-replay after the archive check and before the stack starts', () => {
    const check = script.indexOf('restore-report --reseed --acknowledge');
    const replay = script.indexOf('"$worker" shred-replay');
    const start = script.lastIndexOf('STEP="starting the stack"');
    expect(check).toBeGreaterThan(-1);
    expect(replay).toBeGreaterThan(check);
    expect(start).toBeGreaterThan(replay);
    // Not swallowed: no `|| true` or `|| ` on the command line.
    const line = script.slice(replay, script.indexOf('\n', replay));
    expect(line).not.toContain('||');
  });

  it('is skipped only with the archive check (RESTORE_ARCHIVE=skip)', () => {
    const replay = script.indexOf('"$worker" shred-replay');
    expect(script.slice(script.lastIndexOf('if [', replay), replay)).toContain('RESTORE_ARCHIVE" = check');
  });
});
