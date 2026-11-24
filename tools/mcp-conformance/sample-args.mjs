// SPDX-License-Identifier: AGPL-3.0-only
// Sample arguments for a tool, made from the JSON Schema the tool advertises (issue #4592). The conformance check calls a proposal tool once, and
// the call is judged on the shape of the answer, so the arguments only have to pass the schema: invented ids, a short text, the first enum value.
import { randomUUID } from 'node:crypto';

/** @param {unknown} schema @param {number} [depth] @returns {unknown} */
export function sampleOf(schema, depth = 0) {
  if (schema === true || schema === undefined || schema === null || typeof schema !== 'object' || depth > 6) return 'sample';
  const s = /** @type {Record<string, any>} */ (schema);
  if ('const' in s) return s.const;
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];
  if (s.default !== undefined) return s.default;
  for (const key of ['anyOf', 'oneOf']) {
    if (Array.isArray(s[key])) {
      const pick = s[key].find((/** @type {any} */ option) => option?.type !== 'null') ?? s[key][0];
      return sampleOf(pick, depth + 1);
    }
  }
  if (Array.isArray(s.allOf) && s.allOf.length > 0) return Object.assign({}, ...s.allOf.map((/** @type {unknown} */ part) => sampleOf(part, depth + 1)));
  const type = Array.isArray(s.type) ? (s.type.find((/** @type {string} */ t) => t !== 'null') ?? 'null') : s.type;
  switch (type) {
    case 'string': {
      if (s.format === 'uuid') return randomUUID();
      if (s.format === 'date') return '2026-01-15';
      if (s.format === 'date-time') return '2026-01-15T03:00:00.000Z';
      if (s.format === 'email') return 'conformance@example.com';
      if (s.format === 'uri' || s.format === 'url') return 'https://example.com/conformance';
      const min = typeof s.minLength === 'number' ? s.minLength : 1;
      const max = typeof s.maxLength === 'number' ? s.maxLength : Infinity;
      return 'conformance sample '.repeat(Math.ceil(Math.max(min, 1) / 19)).slice(0, Math.min(Math.max(min, 1), max));
    }
    case 'integer':
    case 'number':
      return typeof s.minimum === 'number' ? s.minimum : typeof s.exclusiveMinimum === 'number' ? s.exclusiveMinimum + 1 : 1;
    case 'boolean':
      return false;
    case 'array': {
      const count = typeof s.minItems === 'number' ? s.minItems : 0;
      return Array.from({ length: count }, () => sampleOf(s.items, depth + 1));
    }
    case 'null':
      return null;
    default: {
      // An object: every required property, nothing optional.
      const properties = s.properties && typeof s.properties === 'object' ? s.properties : {};
      const required = Array.isArray(s.required) ? s.required : [];
      return Object.fromEntries(required.map((/** @type {string} */ name) => [name, sampleOf(properties[name], depth + 1)]));
    }
  }
}
