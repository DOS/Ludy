// SPDX-License-Identifier: AGPL-3.0-only
// The rule for what a crove_meetings SECURITY DEFINER function may return (issue #2575, ADR-0047) and its one locked exception (owner decision of 2026-11-15, meetings integrations A6, #3164),
// tried without a database: every other function that returns text still fails, the four named ones pass only with their named columns and exact types, and `body` is returned by hook_delivery_get alone.
import { describe, expect, it } from 'vitest';
import { BODY_FUNCTION, HOOK_DEFINER_EXECUTORS, HOOK_DEFINER_TEXT, validateDefinerReturnType } from './fixtures/definer-return-types.ts';

const ok = (type: string, name?: string) => validateDefinerReturnType(type, name).ok;

describe('what a crove_meetings definer may return', () => {
  it('still allows metadata scalars, triggers, key ids and kinds, and the tables of those', () => {
    for (const type of ['void', 'uuid', 'boolean', 'integer', 'bigint', 'smallint', 'timestamp with time zone', 'date', 'bytea', 'trigger', 'SETOF uuid']) expect(ok(type, 'any_function'), type).toBe(true);
    expect(ok('TABLE(org_id uuid, id uuid, kind text)', 'hook_open')).toBe(true);
    expect(ok('TABLE(key_id text, wrapped_key bytea)', 'media_key_get')).toBe(true);
  });

  it('still refuses meeting text from every other function, whatever it is called', () => {
    for (const type of ['text', 'jsonb', 'json', 'text[]', 'character varying', 'TABLE(id uuid, title text)', 'TABLE(id uuid, summary text)', 'TABLE(id uuid, body jsonb)', 'TABLE(id uuid, url text)', 'TABLE(id uuid, fields text[])', 'SETOF text']) {
      expect(ok(type, 'meeting_text_reader'), type).toBe(false);
      expect(ok(type, ''), `${type} with no name`).toBe(false);
      expect(ok(type, 'hook_open'), `${type} from hook_open`).toBe(false);
    }
  });

  it('allows exactly the four named functions their named columns of the named types, and nothing more', () => {
    expect(ok('TABLE(id uuid, url text, fields text[], enabled boolean, paused_reason text, secret_hint text, previous_until timestamp with time zone, failing_since timestamp with time zone, consecutive_failures integer, last_delivery_at timestamp with time zone, last_status text, created_at timestamp with time zone)', 'hook_get')).toBe(true);
    expect(ok('TABLE(hook_id uuid, fields text[])', 'hook_for_publish')).toBe(true);
    expect(ok('TABLE(id uuid, hook_id uuid, type text, body jsonb, status text, attempts integer)', 'hook_delivery_get')).toBe(true);
    expect(ok('TABLE(url text, secret_sealed jsonb, previous_sealed jsonb, user_id uuid)', 'hook_target')).toBe(true);
    // A column that is not on the function's list, in any type.
    for (const [name, type] of [
      ['hook_get', 'TABLE(id uuid, url text, title text)'],
      ['hook_get', 'TABLE(id uuid, body jsonb)'],
      ['hook_get', 'TABLE(id uuid, secret_sealed jsonb)'],
      ['hook_for_publish', 'TABLE(hook_id uuid, fields text[], url text)'],
      ['hook_delivery_get', 'TABLE(id uuid, summary text)'],
      ['hook_delivery_get', 'TABLE(id uuid, url text)'],
      ['hook_target', 'TABLE(url text, secret_sealed jsonb, body jsonb)'],
      ['hook_target', 'TABLE(url text, transcript text)'],
    ] as const) expect(ok(type, name), `${name} ${type}`).toBe(false);
    // The right column with another type.
    for (const [name, type] of [
      ['hook_delivery_get', 'TABLE(id uuid, body text)'],
      ['hook_get', 'TABLE(id uuid, fields text)'],
      ['hook_get', 'TABLE(id uuid, url jsonb)'],
      ['hook_target', 'TABLE(url text, secret_sealed text)'],
    ] as const) expect(ok(type, name), `${name} ${type}`).toBe(false);
    // A scalar return of text is no exception for them either, and a name that is only similar gets nothing.
    expect(ok('text', 'hook_get')).toBe(false);
    for (const name of ['hook_get_all', 'hook_delivery', 'hook_target2', 'Hook_Get', 'hook_gett', 'toString', 'constructor', '__proto__']) expect(ok('TABLE(id uuid, url text)', name), name).toBe(false);
  });

  it('lets only hook_delivery_get return a column named body, in any type', () => {
    expect(BODY_FUNCTION).toBe('hook_delivery_get');
    for (const name of ['hook_get', 'hook_for_publish', 'hook_target', 'hook_open', 'other']) expect(validateDefinerReturnType('TABLE(id uuid, body bytea)', name).ok, `${name} body bytea`).toBe(false);
    expect(validateDefinerReturnType('TABLE(id uuid, body bytea)', 'hook_delivery_get').ok, 'bytea is a scalar the rule allows; the exception names body as jsonb').toBe(true);
    expect(validateDefinerReturnType('TABLE(id uuid, body jsonb)', 'hook_delivery_get').ok).toBe(true);
  });

  it('pins the executors of the four to one login role each, and no more functions than these four', () => {
    expect(Object.keys(HOOK_DEFINER_TEXT).sort()).toEqual(['hook_delivery_get', 'hook_for_publish', 'hook_get', 'hook_target']);
    expect(HOOK_DEFINER_EXECUTORS).toEqual({ hook_get: ['crove_app'], hook_for_publish: ['crove_app'], hook_delivery_get: ['crove_worker'], hook_target: ['crove_worker'] });
    expect(Object.keys(HOOK_DEFINER_EXECUTORS).sort()).toEqual(Object.keys(HOOK_DEFINER_TEXT).sort());
  });
});
