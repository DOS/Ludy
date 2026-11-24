// The personal-data registry's per-row handling (#1312): a legal entity the org keeps books for (a client, a household
// whose name and 12-digit code are a person's) is kept by law, and only the org's default entity is the org's own.
import { describe, expect, it } from 'vitest';
import { PERSONAL_DATA_COLUMNS, PERSONAL_DATA_PENDING, PERSONAL_DATA_SCHEMAS, SEALED_COLUMNS, personalDataProbe, rowHandling, type PersonalDataColumn } from '@ludy/kernel';
import { hrManifest } from '@ludy/mod-hr';
import { meetingsManifest } from '@ludy/mod-meetings';
import { notesManifest } from '@ludy/mod-notes';
import { projectsManifest } from '@ludy/mod-projects';
import { signManifest } from '@ludy/mod-sign';

const entries = PERSONAL_DATA_COLUMNS as Record<string, PersonalDataColumn>;

describe('personal-data registry: legal entities (#1312)', () => {
  it('registers the name and the tax code of a legal entity, kept by law', () => {
    expect(entries['ludy_kernel.legal_entity.name']).toMatchObject({ kind: 'name', handling: 'keep_legal' });
    expect(entries['ludy_kernel.legal_entity.tax_code']).toMatchObject({ kind: 'tax_code', handling: 'keep_legal' });
  });

  it("keeps a non-default entity by law and the default one as the org's own", () => {
    for (const key of ['ludy_kernel.legal_entity.name', 'ludy_kernel.legal_entity.tax_code']) {
      const entry = entries[key] as PersonalDataColumn;
      expect(rowHandling(entry, { kind: 'household', is_default: false }), key).toEqual({ handling: 'keep_legal', reason: entry.reason });
      expect(rowHandling(entry, { kind: 'household', is_default: true }).handling, key).toBe('keep_org');
      // Anything but a true flag keeps the column's own handling.
      expect(rowHandling(entry, { is_default: 'true' }).handling, key).toBe('keep_legal');
      expect(rowHandling(entry, {}).handling, key).toBe('keep_legal');
    }
  });

  it('leaves columns without an override as they are', () => {
    const tenantCode = entries['ludy_kernel.tenant.tax_code'] as PersonalDataColumn;
    expect(rowHandling(tenantCode, { is_default: true })).toEqual({ handling: 'keep_org', reason: tenantCode.reason });
    const partyEmail = entries['ludy_kernel.party.email'] as PersonalDataColumn;
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

// Notes and to-dos (#1874): ludy_notes is in the schemas the invariant scan covers, and every column the notes
// manifest classifies as personal data is either registered or waits for notes step N9 (#1678), so a new one needs a
// decision too, whatever its name.
describe('personal-data registry: notes (#1874)', () => {
  const classified = Object.entries(notesManifest.tables.ludy_notes).flatMap(([table, cols]) =>
    Object.entries(cols as Record<string, string>)
      .filter(([, cls]) => cls !== 'internal')
      .map(([column]) => `ludy_notes.${table}.${column}`),
  );

  it('scans ludy_notes for columns named like personal data', () => {
    expect(PERSONAL_DATA_SCHEMAS).toContain('ludy_notes');
  });

  it('registers every personal-data column of ludy_notes, or lists it as waiting for notes step N9', () => {
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

// Meetings (ADR-0047 point 7, #2578): ludy_meetings is scanned, and every column its manifest classifies as personal data
// (a title, the transcript's text and speaker label) is registered with its handling, so a new one needs a decision too.
describe('personal-data registry: meetings (#2578)', () => {
  const personal = Object.entries(meetingsManifest.tables.ludy_meetings).flatMap(([table, cols]) =>
    Object.entries(cols as Record<string, string>)
      .filter(([, cls]) => cls === 'pii' || cls === 'contact' || cls === 'national_id' || cls === 'payment')
      .map(([column]) => `ludy_meetings.${table}.${column}`),
  );

  it('scans ludy_meetings and registers every personal-data column of it, the transcript included', () => {
    expect(PERSONAL_DATA_SCHEMAS).toContain('ludy_meetings');
    expect(personal).toEqual(expect.arrayContaining(['ludy_meetings.meeting.title', 'ludy_meetings.transcript_segment.text', 'ludy_meetings.transcript_segment.speaker_label']));
    expect(personal.filter((key) => !(key in PERSONAL_DATA_COLUMNS) && !(key in PERSONAL_DATA_PENDING)), 'register these in PERSONAL_DATA_COLUMNS').toEqual([]);
    // The finder searches every meeting text column as free text (#2594): the rows an actor reads are listed, the rest counted per recorder.
    for (const key of [
      'ludy_meetings.meeting.title',
      'ludy_meetings.transcript_segment.text',
      'ludy_meetings.transcript_segment.speaker_label',
      'ludy_meetings.meeting_result.summary',
      'ludy_meetings.meeting_result.decisions',
      'ludy_meetings.action_item.title',
      'ludy_meetings.action_item.who_drafted',
      'ludy_meetings.action_item.when_drafted',
    ]) {
      expect(entries[key], key).toMatchObject({ kind: 'free_text', handling: 'erase' });
      expect(entries[key]!.reason.length, key).toBeGreaterThan(20);
    }
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

// The people payroll is run for (#2530): ludy_hr is scanned, and every column its manifest classifies as personal data (pii, a national id, a payment account) is either
// registered with its handling or sealed under the person's key and listed as such, never both and never neither. The wage is `sensitive`, an amount that ties to no
// person once the name is gone, so it is in neither.
describe('personal-data registry: payroll people (#2530)', () => {
  const personal = Object.entries(hrManifest.tables.ludy_hr).flatMap(([table, cols]) =>
    Object.entries(cols as Record<string, string>)
      .filter(([, cls]) => cls === 'pii' || cls === 'national_id' || cls === 'payment' || cls === 'contact')
      .map(([column]) => `ludy_hr.${table}.${column}`),
  );

  it('scans ludy_hr for columns named like personal data', () => {
    expect(PERSONAL_DATA_SCHEMAS).toContain('ludy_hr');
  });

  it('registers or seals every personal-data column of ludy_hr, and none twice', () => {
    expect(personal.length).toBeGreaterThan(0);
    for (const key of personal) {
      const registered = key in PERSONAL_DATA_COLUMNS;
      const sealed = key in SEALED_COLUMNS;
      expect(registered || sealed, `${key} needs a decision: register it in PERSONAL_DATA_COLUMNS, or seal it and list it in SEALED_COLUMNS`).toBe(true);
      expect(registered && sealed, `${key} is both registered and sealed`).toBe(false);
    }
  });

  it('seals the two numbers, and clears the names and the address with the employee erasure', () => {
    expect(Object.keys(SEALED_COLUMNS).sort()).toEqual([
      'ludy_finance.supplier_bank_account.account_holder_sealed',
      'ludy_finance.supplier_bank_account.number_sealed',
      'ludy_hr.onboarding_submission.bank_account_sealed',
      'ludy_hr.onboarding_submission.insurance_number_sealed',
      'ludy_hr.onboarding_submission.national_id_sealed',
      'ludy_hr.onboarding_submission.tax_code_sealed',
      'ludy_hr.payroll_employee.bank_account_sealed',
      'ludy_hr.payroll_employee.insurance_number_sealed',
      'ludy_hr.payroll_employee.national_id_sealed',
      'ludy_hr.payroll_employee.tax_code_sealed',
      'ludy_hr.payroll_employee.work_permit_number_sealed',
    ]);
    for (const key of ['ludy_hr.payroll_employee.display_name', 'ludy_hr.payroll_employee.address', 'ludy_hr.payroll_dependent.display_name']) {
      expect(entries[key]?.handling, key).toBe('erase');
    }
  });
});

describe('personal-data registry: projects (#2591)', () => {
  const personal = Object.entries(projectsManifest.tables.ludy_projects).flatMap(([table, cols]) =>
    Object.entries(cols as Record<string, string>)
      .filter(([, cls]) => cls === 'pii' || cls === 'national_id' || cls === 'payment' || cls === 'contact')
      .map(([column]) => `ludy_projects.${table}.${column}`),
  );

  it('scans ludy_projects for columns named like personal data', () => {
    expect(PERSONAL_DATA_SCHEMAS).toContain('ludy_projects');
  });

  it('registers every personal-data column of ludy_projects for erasure', () => {
    expect(personal.length).toBe(21);
    expect(personal).toEqual(
      expect.arrayContaining([
        'ludy_projects.project.name',
        'ludy_projects.project.description',
        'ludy_projects.project.template_tasks',
        'ludy_projects.project_column.name',
        'ludy_projects.project_cycle.name',
        'ludy_projects.project_cycle.goal',
        'ludy_projects.roadmap_board.title',
        'ludy_projects.roadmap_board.description',
        'ludy_projects.roadmap_item.public_title',
        'ludy_projects.roadmap_item.public_summary',
        'ludy_projects.roadmap_item.submitter_display_name',
        'ludy_projects.roadmap_signal.account_label',
        'ludy_projects.roadmap_signal.quote_excerpt',
        'ludy_projects.roadmap_announcement.title',
        'ludy_projects.roadmap_announcement.body_md',
        'ludy_projects.roadmap_otp.email',
        'ludy_projects.roadmap_subscriber.email_sealed',
        'ludy_projects.time_entry.note',
        'ludy_projects.project_triage_item.title',
        'ludy_projects.project_triage_item.description',
        'ludy_projects.project_triage_item.decline_reason',
      ]),
    );
    for (const key of personal) {
      if (key === 'ludy_projects.roadmap_otp.email' || key === 'ludy_projects.roadmap_subscriber.email_sealed') {
        expect(entries[key]).toMatchObject({ kind: 'email', handling: 'erase', machinery: true });
      } else {
        expect(entries[key]).toMatchObject({ kind: 'free_text', handling: 'erase' });
      }
    }
    expect(entries['ludy_projects.roadmap_vote.voter_email_hash']).toMatchObject({ kind: 'other', handling: 'hashed' });
    expect(entries['ludy_projects.roadmap_subscriber.mail_hash']).toMatchObject({ kind: 'other', handling: 'hashed', machinery: true });
  });
});

describe('personal-data registry: sign (#3323)', () => {
  const personal = Object.entries(signManifest.tables.ludy_sign).flatMap(([table, cols]) =>
    Object.entries(cols as Record<string, string>)
      .filter(([, cls]) => cls === 'pii' || cls === 'contact' || cls === 'national_id' || cls === 'payment' || cls === 'sensitive')
      .map(([column]) => `ludy_sign.${table}.${column}`),
  );

  it('scans ludy_sign and registers every personal-data and hashed column', () => {
    expect(PERSONAL_DATA_SCHEMAS).toContain('ludy_sign');
    expect(personal).toEqual(
      expect.arrayContaining([
        'ludy_sign.signer.name',
        'ludy_sign.signer.email',
        'ludy_sign.signer.phone',
        'ludy_sign.signing_otp.email',
        'ludy_sign.signing_event.actor_label',
      ]),
    );
    const nonToken = personal.filter((key) => key !== 'ludy_sign.signing_token.token_sha256' && key !== 'ludy_sign.signing_otp.otp_sha256');
    expect(nonToken.filter((key) => !(key in PERSONAL_DATA_COLUMNS) && !(key in PERSONAL_DATA_PENDING))).toEqual([]);
    expect(entries['ludy_sign.signing_otp.email']).toMatchObject({ kind: 'email', handling: 'erase', machinery: true });
    expect(entries['ludy_sign.signer.email']).toMatchObject({ kind: 'email', handling: 'keep_record' });
    expect(entries['ludy_sign.signer.phone']).toMatchObject({ kind: 'phone', handling: 'keep_record' });
    expect(entries['ludy_sign.signer.email']?.reason).toContain('unsealed envelope is erased');
  });
});
