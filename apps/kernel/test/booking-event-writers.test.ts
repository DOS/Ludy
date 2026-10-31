// SPDX-License-Identifier: AGPL-3.0-only
// Who writes the events a visitor's booking page starts (#2139): the public-booking definers alone. The live calendar check
// runs for these events (the queue crm-booking-live), so a new writer would be a new way to make the worker call a provider.
// The sources are read as text: no database.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const EVENTS = ['crm.booking.requested', 'crm.booking.manage_requested'];

function files(dir: string, keep: (name: string) => boolean): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist') return [];
    const path = join(dir, name);
    return statSync(join(ROOT, path)).isDirectory() ? files(path, keep) : keep(name) ? [path] : [];
  });
}

describe('the writers of the booking request events (#2139)', () => {
  it('are the two existing public-booking definers, and no migration adds another writer', () => {
    const writers: Array<[string, string, string]> = [];
    for (const path of files('supabase/migrations', (n) => n.endsWith('.sql'))) {
      const text = readFileSync(join(ROOT, path), 'utf8');
      for (const event of EVENTS) {
        for (let at = text.indexOf(`'${event}'`); at >= 0; at = text.indexOf(`'${event}'`, at + 1)) {
          // The statement that holds the event name, and the function it is in.
          const before = text.slice(0, at);
          const insert = before.lastIndexOf('INSERT INTO');
          if (insert < 0 || before.slice(insert).includes(';')) continue;
          const fn = [...before.matchAll(/CREATE (?:OR REPLACE )?FUNCTION (crove_[a-z_]+\.[a-z_]+)/g)].at(-1)?.[1] ?? '(none)';
          writers.push([event, fn, basename(path)]);
        }
      }
    }
    expect(writers).toEqual([
      ['crm.booking.requested', 'crove_crm.booking_request', '20261031020000_crove_crm_bookings.sql'],
      ['crm.booking.manage_requested', 'crove_crm.booking_manage_request', '20261031250000_crove_crm_booking_manage.sql'],
    ]);
  });

  it('are not emitted by any command or other source', () => {
    const sources = ['apps', 'packages', 'modules'].flatMap((dir) => files(dir, (n) => /\.(ts|tsx|mjs|js)$/.test(n))).filter((p) => !p.includes('/test/') && !p.includes('.test.'));
    expect(sources.length).toBeGreaterThan(100);
    const emitters = sources.filter((path) => /emit\(\s*['"`]crm\.booking\.(requested|manage_requested)/.test(readFileSync(join(ROOT, path), 'utf8')));
    expect(emitters).toEqual([]);
    // The relay reads them (it does not write them): the only source that names them is the worker's routing.
    const naming = sources.filter((path) => EVENTS.some((event) => readFileSync(join(ROOT, path), 'utf8').includes(`'${event}'`)));
    expect(naming.map((p) => p.replaceAll('\\', '/'))).toEqual(['apps/kernel/src/worker.ts']);
  });
});
