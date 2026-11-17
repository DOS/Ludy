// SPDX-License-Identifier: AGPL-3.0-only
// The duplicate check of the add panel: what is looked up while an email or a tax code is typed, and which contact of the loose search answer
// really has exactly that value.
import { describe, expect, it } from 'vitest';
import { duplicateKey, duplicateSearch, findDuplicate, type DuplicateHit } from '../src/lib/contact-duplicate.ts';
// The panel passes its screen's own email check; a plain one stands in here.
const isEmailAddress = (value: string) => /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)*$/.test(value);

const hit = (id: string, over: Partial<DuplicateHit> = {}): DuplicateHit => ({ id, kind: 'person', name: `Khách ${id}`, email: null, taxCode: null, ...over });

describe('duplicateKey', () => {
  it('asks for a whole email, lower-cased, and for nothing half-typed', () => {
    expect(duplicateKey('email', ' An@Khach.TEST ', isEmailAddress)).toEqual({ field: 'email', value: 'an@khach.test' });
    expect(duplicateKey('email', 'an@khach', isEmailAddress)).toEqual({ field: 'email', value: 'an@khach' });
    expect(duplicateKey('email', 'an@', isEmailAddress)).toBeNull();
    expect(duplicateKey('email', '   ', isEmailAddress)).toBeNull();
    // A value the search refuses (over 100 characters) is not looked up.
    expect(duplicateKey('email', `${'a'.repeat(95)}@khach.test`, isEmailAddress)).toBeNull();
  });

  it('asks for a valid tax code by its normal form', () => {
    expect(duplicateKey('taxCode', '0123 456.780', isEmailAddress)).toEqual({ field: 'taxCode', value: '0123456780' });
    expect(duplicateKey('taxCode', '0123456780001', isEmailAddress)).toEqual({ field: 'taxCode', value: '0123456780-001' });
    expect(duplicateKey('taxCode', '12345', isEmailAddress)).toBeNull();
  });
});

describe('duplicateSearch', () => {
  it('searches every kind of contact for the value', () => {
    expect(duplicateSearch({ field: 'email', value: 'an@khach.test' })).toEqual({ v: 1, all: [{ field: 'search', op: 'contains', value: 'an@khach.test' }] });
  });
});

describe('findDuplicate', () => {
  it('finds the contact with the same email whatever its case, and not one that only contains it', () => {
    const hits = [hit('a', { email: 'xan@khach.test' }), hit('b', { email: 'An@Khach.test' })];
    expect(findDuplicate({ field: 'email', value: 'an@khach.test' }, hits)?.id).toBe('b');
    expect(findDuplicate({ field: 'email', value: 'an@khach.test' }, [hit('a', { email: 'xan@khach.test' }), hit('c')])).toBeNull();
  });

  it('finds a company by the digits of its tax code, written any way', () => {
    const hits = [hit('a', { kind: 'organization', taxCode: '0123456781' }), hit('b', { kind: 'organization', taxCode: '0123 456 780' })];
    expect(findDuplicate({ field: 'taxCode', value: '0123456780' }, hits)?.id).toBe('b');
    expect(findDuplicate({ field: 'taxCode', value: '0123456780' }, [hit('c')])).toBeNull();
  });
});
