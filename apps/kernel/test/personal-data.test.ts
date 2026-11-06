// The personal-data registry's per-row handling (#1312): a legal entity the org keeps books for (a client, a household
// whose name and 12-digit code are a person's) is kept by law, and only the org's default entity is the org's own.
import { describe, expect, it } from 'vitest';
import { PERSONAL_DATA_COLUMNS, PERSONAL_DATA_PENDING, PERSONAL_DATA_SCHEMAS, SEALED_COLUMNS, personalDataProbe, rowHandling, type PersonalDataColumn } from '@crove/kernel';
import { hrManifest } from '@crove/mod-hr';
import { notesManifest } from '@crove/mod-notes';

const entries = PERSONAL_DATA_COLUMNS as Record<string, PersonalDataColumn>;

describe('personal-data registry: legal entities (#1312)', () => {
  it('registers the name and the tax code of a legal entity, kept by law', () => {
    expect(entries['crove_kernel.legal_entity.name']).toMatchObject({ kind: 'name', handling: 'keep_legal' });
    expect(entries['crove_kernel.legal_entity.tax_code']).toMatchObject({ kind: 'tax_code', handling: 'keep_legal' });
  });

  it("keeps a non-default entity by law and the default one as the org's own", () => {
    for (const key of ['crove_kernel.legal_entity.name', 'crove_kernel.legal_entity.tax_code']) {
      const entry = entries[key] as PersonalDataColumn;
      expect(rowHandling(entry, { kind: 'household', is_default: false }), key).toEqual({ handling: 'keep_legal', reason: entry.reason });
      expect(rowHandling(entry, { kind: 'household', is_default: true }).handling, key).toBe('keep_org');
      // Anything but a true flag keeps the column's own handling.
      expect(rowHandling(entry, { is_default: 'true' }).handling, key).toBe('keep_legal');
      expect(rowHandling(entry, {}).handling, key).toBe('keep_legal');
    }
  });

  it('leaves columns without an override as they are', () => {
    const tenantCode = entries['crove_kernel.tenant.tax_code'] as PersonalDataColumn;
    expect(rowHandling(tenantCode, { is_default: true })).toEqual({ handling: 'keep_org', reason: tenantCode.reason });
    const partyEmail = entries['crove_kernel.party.email'] as PersonalDataColumn;
    expect(rowHandling(partyEmail, { is_default: true }).handling).toBe('erase');
  });

  it('finds a household by its 12-digit national ID number', () => {
    expect(personalDataProbe('0790 9100 1234')).toEqual({ kind: 'digits', digits: '079091001234' });
  });

  it('finds a bank account number of 8 to 20 digits, and no shorter or longer value (#2402)', () => {
    expect(personalDataProbe('1234 5678 9012 3456 78')).toEqual({ kind: 'digits', digits: '123456789012345678' });
    expect(personalDataProbe('12345678901234567890')?.kind).toBe('digits');
    expect(personalDataProbe('123456789012345678901')).toBeNull();
    expect(personalDataProbe('1234567')).toBeNull();
  });
});

// Notes and to-dos (#1874): crove_notes is in the schemas the invariant scan covers, and every column the notes
// manifest classifies as personal data is either registered or waits for notes step N9 (#1678), so a new one needs a
// decision too, whatever its name.
describe('personal-data registry: notes (#1874)', () => {
  const classified = Object.entries(notesManifest.tables.crove_notes).flatMap(([table, cols]) =>
    Object.entries(cols as Record<string, string>)
      .filter(([, cls]) => cls !== 'internal')
      .map(([column]) => `crove_notes.${table}.${column}`),
  );

  it('scans crove_notes for columns named like personal data', () => {
    expect(PERSONAL_DATA_SCHEMAS).toContain('crove_notes');
  });

  it('registers every personal-data column of crove_notes, or lists it as waiting for notes step N9', () => {
    expect(classified.length).toBeGreaterThan(0);
    const undecided = classified.filter((key) => !(key in PERSONAL_DATA_COLUMNS) && !(key in PERSONAL_DATA_PENDING));
    expect(undecided, 'register these in PERSONAL_DATA_COLUMNS, or list them in PERSONAL_DATA_PENDING with the step that will').toEqual([]);
  });

  it('lists as waiting only columns the manifests classify, and none that is also registered', () => {
    const pending = Object.keys(PERSONAL_DATA_PENDING);
    expect(pending.filter((key) => !classified.includes(key))).toEqual([]);
    expect(pending.filter((key) => key in PERSONAL_DATA_COLUMNS)).toEqual([]);
  });
});

describe('sealed columns (ADR-0017, #2640)', () => {
  it('lists each sealed column by its place, with the shred handling and a reason, and in no registry that clears a value in a mutable row', () => {
    for (const [place, entry] of Object.entries(SEALED_COLUMNS)) {
      expect(place, place).toMatch(/^[a-z][a-z0-9_]*.[a-z][a-z0-9_]*.[a-z][a-z0-9_]*$/);
      expect(entry.handling, place).toBe('shred');
      expect(entry.reason.length, place).toBeGreaterThan(10);
      expect(place in entries, `${place} is sealed: it is erased by its subject's key, not by the finder's clear`).toBe(false);
      expect(place in PERSONAL_DATA_PENDING, place).toBe(false);
    }
  });
});

// The people payroll is run for (#2530): crove_hr is scanned, and every column its manifest classifies as personal data (pii, a national id, a payment account) is either
// registered with its handling or sealed under the person's key and listed as such, never both and never neither. The wage is `sensitive`, an amount that ties to no
// person once the name is gone, so it is in neither.
describe('personal-data registry: payroll people (#2530)', () => {
  const personal = Object.entries(hrManifest.tables.crove_hr).flatMap(([table, cols]) =>
    Object.entries(cols as Record<string, string>)
      .filter(([, cls]) => cls === 'pii' || cls === 'national_id' || cls === 'payment' || cls === 'contact')
      .map(([column]) => `crove_hr.${table}.${column}`),
  );

  it('scans crove_hr for columns named like personal data', () => {
    expect(PERSONAL_DATA_SCHEMAS).toContain('crove_hr');
  });

  it('registers or seals every personal-data column of crove_hr, and none twice', () => {
    expect(personal.length).toBeGreaterThan(0);
    for (const key of personal) {
      const registered = key in PERSONAL_DATA_COLUMNS;
      const sealed = key in SEALED_COLUMNS;
      expect(registered || sealed, `${key} needs a decision: register it in PERSONAL_DATA_COLUMNS, or seal it and list it in SEALED_COLUMNS`).toBe(true);
      expect(registered && sealed, `${key} is both registered and sealed`).toBe(false);
    }
  });

  it('seals the two numbers, and clears the names and the address with the employee erasure', () => {
    expect(Object.keys(SEALED_COLUMNS).sort()).toEqual(['crove_hr.payroll_employee.bank_account_sealed', 'crove_hr.payroll_employee.national_id_sealed']);
    for (const key of ['crove_hr.payroll_employee.display_name', 'crove_hr.payroll_employee.address', 'crove_hr.payroll_dependent.display_name']) {
      expect(entries[key]?.handling, key).toBe('erase');
    }
  });
});
