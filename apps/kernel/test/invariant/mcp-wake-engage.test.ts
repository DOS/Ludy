// SPDX-License-Identifier: AGPL-3.0-only
// The body of an Engage wake event (#3862, E3 of epic #3857; ADR-0051 decision 13), the invariant: whatever the rules read, an event leaves with ids, days, amounts and enum words and nothing else.
// - the registry of the rules in code holds the types the contract lists, each in the namespace and with the scope of its line, each a well-formed registry entry, and no field of any is free text;
// - every field of every type is an id, a date, an amount or a list of plain words, and a type with an amount has an enum field for the currency (N5 of the #4025 review);
// - for each type a body built from sample data is accepted, and a name, a message, a note, an email, an account number or an extra key in any field, or a field left out, is refused, so no rule can be made to carry one.
// Part of the invariant suite: it imports package code under test, never helpers from outside test/invariant/.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ENGAGE_WAKE_RULES } from '@crove/kernel-contract';
import { LINE_WAKE_EVENTS, lineTypeProblem, wakeBody } from '../../src/mcp-wake-body.ts';

const SCOPE_OF_LINE: Record<string, string> = { engage: 'ludy.engage.write', social: 'ludy.social.draft', ads: 'ludy.ads.draft' };
const head = (type: string) => ({ id: randomUUID(), type, created_at: '2026-11-19T03:00:00.000Z', org: randomUUID(), grant: randomUUID() });

// One valid value for each kind of field, and the registry's own words for an enum.
const sample = (kind: unknown): string => (kind === 'id' ? randomUUID() : kind === 'date' ? '2026-11-19' : kind === 'amount' ? '1250000.5' : (kind as string[])[0]!);
const dataOf = (type: string): Record<string, string> => Object.fromEntries(Object.entries(LINE_WAKE_EVENTS[type]!.fields).map(([name, kind]) => [name, sample(kind)]));

describe('the wake events of Engage carry ids, days, amounts and enum words only (#3862)', () => {
  it('registers the types the contract lists, each well formed, in its line\'s namespace and with its line\'s scope', () => {
    expect(Object.keys(LINE_WAKE_EVENTS).sort()).toEqual(ENGAGE_WAKE_RULES.map((r) => r.type).sort());
    for (const rule of ENGAGE_WAKE_RULES) {
      const entry = LINE_WAKE_EVENTS[rule.type]!;
      expect(entry.scope, rule.type).toBe(rule.scope);
      expect(SCOPE_OF_LINE[rule.type.split('.')[0]!], rule.type).toBe(entry.scope);
      expect(lineTypeProblem(rule.type, entry), rule.type).toBeNull();
    }
  });

  it('has no free text in any field, and an enum for the currency of every amount that is money', () => {
    for (const [type, entry] of Object.entries(LINE_WAKE_EVENTS)) {
      for (const [name, kind] of Object.entries(entry.fields)) {
        if (typeof kind === 'string') expect(['id', 'date', 'amount'], `${type}.${name}`).toContain(kind);
        else for (const word of kind) expect(word, `${type}.${name}`).toMatch(/^[a-z][a-z_]{0,30}$/);
      }
      const amounts = Object.entries(entry.fields).filter(([, kind]) => kind === 'amount');
      if (amounts.length > 0) expect(Object.keys(entry.fields), type).toContain('currency');
    }
  });

  it.each(ENGAGE_WAKE_RULES.map((r) => r.type))('%s builds from sample data and refuses a name, a message, a note, an account number, an extra key and a missing field', (type) => {
    const data = dataOf(type);
    const event = { ...head(type), data };
    const body = JSON.parse(wakeBody(event)) as { type: string; data: Record<string, string> };
    expect(body.type).toBe(type);
    expect(body.data).toEqual(data);
    const hostile = ['Nguyễn Văn A', 'xin chào, gọi lại cho tôi', 'khach@example.com', '0123456789', '<script>alert(1)</script>', ''];
    for (const [name, kind] of Object.entries(LINE_WAKE_EVENTS[type]!.fields)) {
      for (const text of hostile) {
        // A word outside an enum, a name where an id, a date or an amount goes: refused in every field.
        expect(() => wakeBody({ ...event, data: { ...data, [name]: text } }), `${type}.${name} = ${text}`).toThrow();
      }
      const { [name]: _gone, ...without } = data;
      expect(() => wakeBody({ ...event, data: without }), `${type} without ${name}`).toThrow();
      void kind;
    }
    expect(() => wakeBody({ ...event, data: { ...data, customer_name: 'Nguyễn Văn A' } })).toThrow();
    expect(() => wakeBody({ ...event, note: 'gọi lại khách' })).toThrow();
    // Never the data of one type in the clothes of another.
    const other = ENGAGE_WAKE_RULES.find((r) => r.type !== type && JSON.stringify(Object.keys(LINE_WAKE_EVENTS[r.type]!.fields)) !== JSON.stringify(Object.keys(LINE_WAKE_EVENTS[type]!.fields)));
    if (other) expect(() => wakeBody({ ...head(other.type), data })).toThrow();
  });
});
