// SPDX-License-Identifier: AGPL-3.0-only
// eSign Slice 6d (#4723): Post-sign non-blocking VietQR deposit requests, org bank profile,
// immutable send-time snapshots, EMVCo NAPAS 247 QR payload generation, and Accounting match bridge.
import { randomInt } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@ludy/db';
import {
  ACCOUNT_CODE_PATTERN,
  SIGN_DEPOSIT_MEMO_TOKEN_PATTERN,
  SIGN_SIGNATURE_PNG_MAX_BYTES,
  auditValue,
  normalizeAccountCode,
  tableWrite,
  zSignDepositProfileUpsertInput,
  zSignEnvelopeDepositClearInput,
  zSignEnvelopeDepositSetInput,
  type SignDepositProfileContract,
  type SignDepositProfileGetResult,
  type SignEnvelopeDepositRecordContract,
} from '@ludy/kernel-contract';
import {
  DomainError,
  defineCommand,
  defineQuery,
  type CommandContext,
} from '@ludy/kernel-runtime';
import { Decimal, bankByCode } from '@ludy/l10n-vn';
import { SIGN_DEPOSIT_PROFILE_TABLE, SIGN_ENVELOPE_DEPOSIT_TABLE, signManifest } from './manifest.ts';
import { validateSignaturePngBase64 } from './png.ts';

const ADMIN_ROLES: readonly MemberRole[] = ['owner', 'admin'];
const MEMBER_ROLES: readonly MemberRole[] = ['owner', 'admin', 'member'];

const DEPOSIT_AMOUNT_MAX = new Decimal('9999999999999999.9999');
const MEMO_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MEMO_CODE_LEN = 8;
const MEMO_MAX_ATTEMPTS = 12;
const ACCOUNT_NUMBER_PATTERN = /^[A-Za-z0-9]{4,34}$/;
const EMVCO_NAPAS_GUID = 'A000000727';
const EMVCO_NAPAS_SERVICE_CODE = 'QRIBFTTA';
const EMVCO_CURRENCY_VND = '704';
const EMVCO_COUNTRY_VN = 'VN';
const EMVCO_BIN_PATTERN = /^[0-9]{6}$/;
const EMVCO_AMOUNT_MAX_CHARS = 13;
const DEPOSIT_MATCH_LIMIT = 200;

const ALLOWED_QR_FILE_SOURCES = new Set([
  'sign_deposit_qr',
  'upload',
  'social',
]);
const GATED_SIGN_FILE_SOURCES = new Set([
  'sign_document',
  'sign_sealed',
  'sign_certificate',
  'sign_attachment',
  'sign_deposit_qr',
]);

function actorUserId(ctx: Pick<CommandContext, 'actor'>): string | null {
  return ctx.actor.type === 'user' ? ctx.actor.userId : null;
}

function isoString(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function isoOrNull(value: Date | string | null): string | null {
  return value ? isoString(value) : null;
}

export function trimDepositDecimalString(raw: string): string {
  const d = new Decimal(raw.trim());
  const fixed = d.toFixed();
  if (!fixed.includes('.')) return fixed;
  return fixed.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
}

export function parseDepositAmountDecimal(raw: string): string {
  const trimmed = raw.trim();
  if (!/^\d+(?:\.\d{1,4})?$/.test(trimmed)) {
    throw new DomainError('SIGN_DEPOSIT_INVALID_AMOUNT', 422, 'Deposit amount must be a positive whole VND integer');
  }
  const d = new Decimal(trimmed);
  if (!d.isFinite() || d.lte(0) || d.gt(DEPOSIT_AMOUNT_MAX) || !d.isInteger()) {
    throw new DomainError('SIGN_DEPOSIT_INVALID_AMOUNT', 422, 'Deposit amount must be a positive whole VND integer');
  }
  return d.toFixed(0);
}

/**
 * Computes CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, xorOut 0x0000) as specified by EMVCo MPQR.
 */
export function computeEmvcoCrc16(payloadWith6304: string): string {
  let crc = 0xffff;
  const bytes = Buffer.from(payloadWith6304, 'utf8');
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function formatTlv(tag: string, value: string): string {
  const byteLength = Buffer.byteLength(value, 'utf8');
  if (!/^\d{2}$/.test(tag) || byteLength > 99) {
    throw new DomainError('SIGN_DEPOSIT_EMVCO_INVALID', 422, 'Invalid EMVCo VietQR tag payload');
  }
  return `${tag}${String(byteLength).padStart(2, '0')}${value}`;
}

/**
 * Generates an offline EMVCo NAPAS 247 (QRIBFTTA) payload when and only when the bank entry
 * provides a verified 6-digit NAPAS BIN. Never fabricates unverified BINs (#2535).
 */
export function buildVietQrEmvcoPayload(params: {
  bankCode: string;
  accountNumber: string;
  amount: string;
  memoToken: string;
  napasBin?: string | null;
}): string | null {
  const bank = bankByCode(params.bankCode.trim().toUpperCase());
  const bin = (params.napasBin ?? bank?.napasBin ?? '').trim();
  if (!EMVCO_BIN_PATTERN.test(bin)) {
    return null;
  }
  const accountNumber = params.accountNumber.replace(/\s+/g, '').trim();
  if (!ACCOUNT_NUMBER_PATTERN.test(accountNumber)) {
    return null;
  }
  const memoToken = params.memoToken.trim().toUpperCase();
  if (!SIGN_DEPOSIT_MEMO_TOKEN_PATTERN.test(memoToken)) {
    return null;
  }
  let formattedAmount: string;
  try {
    formattedAmount = parseDepositAmountDecimal(params.amount);
  } catch {
    return null;
  }
  if (formattedAmount.length > EMVCO_AMOUNT_MAX_CHARS) {
    return null;
  }

  const beneficiary = formatTlv('00', bin) + formatTlv('01', accountNumber);
  const merchantAccountInfo =
    formatTlv('00', EMVCO_NAPAS_GUID) + formatTlv('01', beneficiary) + formatTlv('02', EMVCO_NAPAS_SERVICE_CODE);
  const additionalData = formatTlv('08', memoToken);

  const unsigned =
    formatTlv('00', '01') +
    formatTlv('01', '12') +
    formatTlv('38', merchantAccountInfo) +
    formatTlv('53', EMVCO_CURRENCY_VND) +
    formatTlv('54', formattedAmount) +
    formatTlv('58', EMVCO_COUNTRY_VN) +
    formatTlv('62', additionalData) +
    '6304';

  return `${unsigned}${computeEmvcoCrc16(unsigned)}`;
}

interface DepositProfileRow {
  org_id: string;
  id: string;
  bank_code: string;
  bank_name: string;
  account_number: string;
  account_holder: string;
  finance_bank_account: string | null;
  vietqr_file_id: string | null;
  vietqr_storage_key: string | null;
  vietqr_generation: string | null;
  vietqr_sha256: string | null;
  is_default: boolean;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface EnvelopeDepositRow {
  org_id: string;
  id: string;
  envelope_id: string;
  amount: string;
  currency: 'VND';
  memo_token: string;
  due_days: number | null;
  deposit_profile_id: string | null;
  note: string | null;
  snapshot_frozen_at: Date | string | null;
  snapshot_bank_code: string | null;
  snapshot_bank_name: string | null;
  snapshot_account_number: string | null;
  snapshot_account_holder: string | null;
  snapshot_finance_bank_account: string | null;
  snapshot_vietqr_file_id: string | null;
  snapshot_vietqr_storage_key: string | null;
  snapshot_vietqr_generation: string | null;
  snapshot_vietqr_sha256: string | null;
  snapshot_emvco_payload: string | null;
  signer_notice_at: Date | string | null;
  signer_notice_note: string | null;
  signer_proof_file_id: string | null;
  signer_proof_filename: string | null;
  signer_proof_sha256: string | null;
  signer_ip_hash: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export function formatDepositProfile(row: DepositProfileRow): SignDepositProfileContract {
  return {
    id: row.id,
    bankCode: row.bank_code,
    bankName: row.bank_name,
    accountNumber: row.account_number,
    accountHolder: row.account_holder,
    financeBankAccount: row.finance_bank_account,
    hasQrPng: Boolean(row.vietqr_file_id),
    vietqrFileId: row.vietqr_file_id,
    isDefault: row.is_default,
    createdAt: isoString(row.created_at),
    updatedAt: isoString(row.updated_at),
  };
}

export function formatEnvelopeDeposit(row: EnvelopeDepositRow): SignEnvelopeDepositRecordContract {
  return {
    id: row.id,
    orgId: row.org_id,
    envelopeId: row.envelope_id,
    amount: trimDepositDecimalString(row.amount),
    currency: 'VND',
    memoToken: row.memo_token,
    dueDays: row.due_days,
    depositProfileId: row.deposit_profile_id,
    note: row.note,
    snapshotFrozenAt: isoOrNull(row.snapshot_frozen_at),
    snapshotBankCode: row.snapshot_bank_code,
    snapshotBankName: row.snapshot_bank_name,
    snapshotAccountNumber: row.snapshot_account_number,
    snapshotAccountHolder: row.snapshot_account_holder,
    snapshotFinanceBankAccount: row.snapshot_finance_bank_account,
    snapshotVietqrFileId: row.snapshot_vietqr_file_id,
    snapshotEmvcoPayload: row.snapshot_emvco_payload,
    signerNoticeAt: isoOrNull(row.signer_notice_at),
    signerNoticeNote: row.signer_notice_note,
    signerProofFileId: row.signer_proof_file_id,
    signerProofFilename: row.signer_proof_filename,
    signerProofSha256: row.signer_proof_sha256,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: isoString(row.created_at),
    updatedAt: isoString(row.updated_at),
  };
}

function generateMemoCandidate(): string {
  let code = '';
  for (let i = 0; i < MEMO_CODE_LEN; i += 1) {
    code += MEMO_ALPHABET[randomInt(0, MEMO_ALPHABET.length)]!;
  }
  return `CK-${code}`;
}

async function generateUniqueMemoToken(ctx: CommandContext): Promise<string> {
  for (let attempt = 0; attempt < MEMO_MAX_ATTEMPTS; attempt += 1) {
    const candidate = generateMemoCandidate();
    const existing = await ctx.trx
      .selectFrom('ludy_sign.envelope_deposit')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('memo_token', '=', candidate)
      .limit(1)
      .executeTakeFirst();
    if (!existing) {
      return candidate;
    }
  }
  throw new DomainError('SIGN_DEPOSIT_MEMO_CONFLICT', 409, 'Could not allocate unique deposit transfer memo token');
}

async function resolveProfileQrFile(
  ctx: CommandContext,
  fileId: string,
): Promise<{
  vietqr_file_id: string;
  vietqr_storage_key: string;
  vietqr_generation: string;
  vietqr_sha256: string;
}> {
  const fileRow = await ctx.trx
    .selectFrom('ludy_kernel.file')
    .select(['id', 'content_type', 'size_bytes', 'source', 'storage_key', 'generation', 'sha256'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', fileId)
    .executeTakeFirst();

  if (!fileRow || fileRow.source === 'meeting_audio' || fileRow.source === 'meeting_video') {
    throw new DomainError('SIGN_DEPOSIT_QR_FILE_INVALID', 404, 'Uploaded VietQR PNG file was not found');
  }
  if (GATED_SIGN_FILE_SOURCES.has(fileRow.source)) {
    const { rows } = await sql<{ allowed: boolean }>`
      SELECT ludy_sign.can_read_sign_file(${fileRow.id}::uuid) AS allowed
    `.execute(ctx.trx);
    if (!rows[0]?.allowed) {
      throw new DomainError('SIGN_DEPOSIT_QR_FILE_INVALID', 404, 'Uploaded VietQR PNG file was not found');
    }
  }
  if (!ALLOWED_QR_FILE_SOURCES.has(fileRow.source)) {
    throw new DomainError('SIGN_DEPOSIT_QR_FILE_INVALID', 422, 'Unsupported source file for VietQR deposit image');
  }
  const confidentialRef = await ctx.trx
    .selectFrom('ludy_sign.envelope as e')
    .select('e.id')
    .where('e.org_id', '=', ctx.orgId)
    .where('e.source_kind', 'in', ['hr_contract', 'meeting_minutes'])
    .where((eb) =>
      eb.or([
        eb('e.source_file_id', '=', fileId),
        eb('e.sealed_file_id', '=', fileId),
        eb('e.certificate_file_id', '=', fileId),
        eb.exists(
          eb
            .selectFrom('ludy_sign.ca_signing_request as r')
            .select('r.id')
            .whereRef('r.org_id', '=', 'e.org_id')
            .whereRef('r.envelope_id', '=', 'e.id')
            .where('r.pades_file_id', '=', fileId),
        ),
        eb.exists(
          eb
            .selectFrom('ludy_sign.field as fld')
            .select('fld.id')
            .whereRef('fld.org_id', '=', 'e.org_id')
            .whereRef('fld.envelope_id', '=', 'e.id')
            .where('fld.attachment_file_id', '=', fileId),
        ),
        eb.exists(
          eb
            .selectFrom('ludy_sign.envelope_document as doc')
            .select('doc.id')
            .whereRef('doc.org_id', '=', 'e.org_id')
            .whereRef('doc.envelope_id', '=', 'e.id')
            .where('doc.file_id', '=', fileId),
        ),
      ]),
    )
    .limit(1)
    .executeTakeFirst();
  if (confidentialRef) {
    throw new DomainError('SIGN_DEPOSIT_QR_FILE_INVALID', 422, 'Confidential envelope files cannot be attached as VietQR image');
  }

  const sizeBytes = Number(fileRow.size_bytes);
  if (
    fileRow.content_type !== 'image/png' ||
    !Number.isFinite(sizeBytes) ||
    sizeBytes < 45 ||
    sizeBytes > SIGN_SIGNATURE_PNG_MAX_BYTES ||
    !fileRow.storage_key ||
    !fileRow.generation ||
    !fileRow.sha256
  ) {
    throw new DomainError(
      'SIGN_INVALID_SIGNATURE_PNG',
      422,
      `VietQR image must be a valid PNG up to ${SIGN_SIGNATURE_PNG_MAX_BYTES} bytes`,
    );
  }

  return {
    vietqr_file_id: fileRow.id,
    vietqr_storage_key: fileRow.storage_key,
    vietqr_generation: fileRow.generation,
    vietqr_sha256: fileRow.sha256,
  };
}

export const DEPOSIT_PROFILE_WRITE = tableWrite(signManifest.tables, 'ludy_sign', 'deposit_profile', [
  'org_id',
  'bank_code',
  'bank_name',
  'account_number',
  'account_holder',
  'finance_bank_account',
  'vietqr_file_id',
  'vietqr_storage_key',
  'vietqr_generation',
  'vietqr_sha256',
  'is_default',
  'created_by',
  'updated_by',
  'created_at',
  'updated_at',
]);

export const ENVELOPE_DEPOSIT_CONFIG_WRITE = tableWrite(signManifest.tables, 'ludy_sign', 'envelope_deposit', [
  'org_id',
  'envelope_id',
  'amount',
  'currency',
  'memo_token',
  'due_days',
  'deposit_profile_id',
  'note',
  'created_by',
  'updated_by',
  'created_at',
  'updated_at',
]);

export const ENVELOPE_DEPOSIT_FREEZE_WRITE = tableWrite(signManifest.tables, 'ludy_sign', 'envelope_deposit', [
  'snapshot_frozen_at',
  'snapshot_bank_code',
  'snapshot_bank_name',
  'snapshot_account_number',
  'snapshot_account_holder',
  'snapshot_finance_bank_account',
  'snapshot_vietqr_file_id',
  'snapshot_vietqr_storage_key',
  'snapshot_vietqr_generation',
  'snapshot_vietqr_sha256',
  'snapshot_emvco_payload',
  'updated_by',
  'updated_at',
]);

export const ENVELOPE_DEPOSIT_PROFILE_REF_CLEAR_WRITE = tableWrite(signManifest.tables, 'ludy_sign', 'envelope_deposit', [
  'deposit_profile_id',
  'updated_by',
  'updated_at',
]);

/**
 * Reads the org's default VietQR deposit bank profile for eSign configuration.
 */
export const depositProfileGet = defineQuery({
  name: 'sign.deposit_profile.get',
  input: z.strictObject({}),
  access: MEMBER_ROLES,
  handler: async (ctx): Promise<SignDepositProfileGetResult> => {
    if (ctx.actor.type !== 'user') {
      throw new DomainError('SIGN_FORBIDDEN', 403, 'Deposit bank profile is restricted to org users');
    }
    const row = await ctx.trx
      .selectFrom('ludy_sign.deposit_profile')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('is_default', '=', true)
      .executeTakeFirst();

    return {
      profile: row ? formatDepositProfile(row) : null,
      canEdit: ctx.role === 'owner' || ctx.role === 'admin',
    };
  },
});

/**
 * Configures or updates the org's default VietQR deposit destination (owner/admin only).
 */
export const depositProfileUpsert = defineCommand({
  name: 'sign.deposit_profile.upsert',
  input: zSignDepositProfileUpsertInput,
  risk: 'R2',
  sideEffect: 'internal',
  access: ADMIN_ROLES,
  writes: [DEPOSIT_PROFILE_WRITE],
  handler: async (ctx, input): Promise<SignDepositProfileContract> => {
    if (ctx.actor.type !== 'user') {
      throw new DomainError('SIGN_FORBIDDEN', 403, 'Only an org owner or admin can update the deposit profile');
    }
    const bank = bankByCode(input.bankCode.trim().toUpperCase());
    if (!bank) {
      throw new DomainError('SIGN_INVALID_BANK_CODE', 422, 'Unknown Vietnam bank code');
    }
    const accountNumber = input.accountNumber.replace(/\s+/g, '').trim();
    if (!ACCOUNT_NUMBER_PATTERN.test(accountNumber)) {
      throw new DomainError(
        'SIGN_INVALID_BANK_ACCOUNT',
        422,
        'Bank account number must be 4 to 34 alphanumeric characters without spaces',
      );
    }
    const accountHolder = input.accountHolder.trim().replace(/\s+/g, ' ');
    if (!accountHolder || accountHolder.length > 200) {
      throw new DomainError('SIGN_INVALID_BANK_ACCOUNT', 422, 'Account holder name must be 1 to 200 characters');
    }
    const rawFinanceBankAccount =
      input.financeBankAccount !== undefined
        ? input.financeBankAccount === null
          ? null
          : normalizeAccountCode(input.financeBankAccount)
        : undefined;
    const financeBankAccount = rawFinanceBankAccount === '' ? null : rawFinanceBankAccount;
    if (financeBankAccount && !ACCOUNT_CODE_PATTERN.test(financeBankAccount)) {
      throw new DomainError(
        'SIGN_INVALID_BANK_ACCOUNT',
        422,
        'Finance bank account code must match accounting subaccount format',
      );
    }

    if (input.vietqrPngBase64 !== undefined) {
      validateSignaturePngBase64(input.vietqrPngBase64);
      throw new DomainError(
        'SIGN_DEPOSIT_QR_FILE_INVALID',
        422,
        'VietQR PNG must be uploaded via file storage so vietqrFileId is recorded before saving',
      );
    }

    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`sign.deposit_profile:${ctx.orgId}`}, 0))`.execute(
      ctx.trx,
    );

    const existing = input.id
      ? await ctx.trx
          .selectFrom('ludy_sign.deposit_profile')
          .selectAll()
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', input.id)
          .forUpdate()
          .executeTakeFirst()
      : input.isDefault === false
        ? undefined
        : await ctx.trx
            .selectFrom('ludy_sign.deposit_profile')
            .selectAll()
            .where('org_id', '=', ctx.orgId)
            .where('is_default', '=', true)
            .forUpdate()
            .executeTakeFirst();

    if (input.id && !existing) {
      throw new DomainError('SIGN_DEPOSIT_PROFILE_NOT_FOUND', 404, 'Deposit profile not found');
    }

    const destinationChanged = Boolean(
      existing && (existing.bank_code !== bank.code || existing.account_number !== accountNumber),
    );
    const nextIsDefault = input.isDefault ?? (existing ? existing.is_default : true);

    let qrColumns: {
      vietqr_file_id: string | null;
      vietqr_storage_key: string | null;
      vietqr_generation: string | null;
      vietqr_sha256: string | null;
    };

    if (input.clearVietqr || input.vietqrFileId === null) {
      qrColumns = {
        vietqr_file_id: null,
        vietqr_storage_key: null,
        vietqr_generation: null,
        vietqr_sha256: null,
      };
    } else if (input.vietqrFileId) {
      qrColumns = await resolveProfileQrFile(ctx, input.vietqrFileId);
    } else if (existing && !destinationChanged) {
      qrColumns = {
        vietqr_file_id: existing.vietqr_file_id,
        vietqr_storage_key: existing.vietqr_storage_key,
        vietqr_generation: existing.vietqr_generation,
        vietqr_sha256: existing.vietqr_sha256,
      };
    } else {
      qrColumns = {
        vietqr_file_id: null,
        vietqr_storage_key: null,
        vietqr_generation: null,
        vietqr_sha256: null,
      };
    }

    const userId = actorUserId(ctx);
    const requestedBankName = input.bankName?.trim().replace(/\s+/g, ' ') ?? '';
    const bankName =
      requestedBankName.length > 0 && requestedBankName.length <= 200 ? requestedBankName : bank.shortName;
    const nextFinanceBankAccount =
      financeBankAccount !== undefined ? financeBankAccount : (existing?.finance_bank_account ?? null);

    if (nextIsDefault && !existing?.is_default) {
      await ctx.trx
        .updateTable('ludy_sign.deposit_profile')
        .set({
          is_default: false,
          updated_by: userId,
          updated_at: ctx.now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('is_default', '=', true)
        .execute();
    }

    let saved: DepositProfileRow;
    if (existing) {
      saved = await ctx.trx
        .updateTable('ludy_sign.deposit_profile')
        .set({
          bank_code: bank.code,
          bank_name: bankName,
          account_number: accountNumber,
          account_holder: accountHolder,
          finance_bank_account: nextFinanceBankAccount,
          vietqr_file_id: qrColumns.vietqr_file_id,
          vietqr_storage_key: qrColumns.vietqr_storage_key,
          vietqr_generation: qrColumns.vietqr_generation,
          vietqr_sha256: qrColumns.vietqr_sha256,
          is_default: nextIsDefault,
          updated_by: userId,
          updated_at: ctx.now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', existing.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    } else {
      saved = await ctx.trx
        .insertInto('ludy_sign.deposit_profile')
        .values({
          org_id: ctx.orgId,
          bank_code: bank.code,
          bank_name: bankName,
          account_number: accountNumber,
          account_holder: accountHolder,
          finance_bank_account: nextFinanceBankAccount,
          vietqr_file_id: qrColumns.vietqr_file_id,
          vietqr_storage_key: qrColumns.vietqr_storage_key,
          vietqr_generation: qrColumns.vietqr_generation,
          vietqr_sha256: qrColumns.vietqr_sha256,
          is_default: nextIsDefault,
          created_by: userId,
          updated_by: userId,
          created_at: ctx.now,
          updated_at: ctx.now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    }

    ctx.audit({
      action: existing ? 'update' : 'create',
      profile_id: saved.id,
      bank_code: auditValue(SIGN_DEPOSIT_PROFILE_TABLE, 'bank_code', saved.bank_code),
      account_number: auditValue(SIGN_DEPOSIT_PROFILE_TABLE, 'account_number', saved.account_number),
      account_holder: auditValue(SIGN_DEPOSIT_PROFILE_TABLE, 'account_holder', saved.account_holder),
      finance_bank_account: saved.finance_bank_account,
      has_qr_png: Boolean(saved.vietqr_file_id),
    });

    await ctx.activity(
      'sign.deposit_profile',
      saved.id,
      existing ? 'sign.deposit_profile.updated' : 'sign.deposit_profile.configured',
      existing ? 'Updated org eSign VietQR deposit bank profile' : 'Configured org eSign VietQR deposit bank profile',
    );

    return formatDepositProfile(saved);
  },
});

/**
 * Removes the org's default VietQR deposit profile without mutating previously sent envelope snapshots.
 */
export const depositProfileClear = defineCommand({
  name: 'sign.deposit_profile.clear',
  input: z.strictObject({}),
  risk: 'R2',
  sideEffect: 'internal',
  access: ADMIN_ROLES,
  writes: [DEPOSIT_PROFILE_WRITE, ENVELOPE_DEPOSIT_PROFILE_REF_CLEAR_WRITE],
  handler: async (ctx): Promise<{ cleared: boolean }> => {
    if (ctx.actor.type !== 'user') {
      throw new DomainError('SIGN_FORBIDDEN', 403, 'Only an org owner or admin can clear the deposit profile');
    }
    const existing = await ctx.trx
      .selectFrom('ludy_sign.deposit_profile')
      .select(['id', 'bank_code'])
      .where('org_id', '=', ctx.orgId)
      .where('is_default', '=', true)
      .forUpdate()
      .executeTakeFirst();

    if (!existing) {
      ctx.audit({ cleared: false });
      return { cleared: false };
    }

    const userId = actorUserId(ctx);
    // Detach only unfrozen draft deposits pointing to the removed profile; sent envelopes keep their immutable snapshot.
    await ctx.trx
      .updateTable('ludy_sign.envelope_deposit')
      .set({
        deposit_profile_id: null,
        updated_by: userId,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('deposit_profile_id', '=', existing.id)
      .where('snapshot_frozen_at', 'is', null)
      .execute();

    await ctx.trx
      .deleteFrom('ludy_sign.deposit_profile')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .execute();

    ctx.audit({
      cleared: true,
      profile_id: existing.id,
      bank_code: auditValue(SIGN_DEPOSIT_PROFILE_TABLE, 'bank_code', existing.bank_code),
    });

    await ctx.activity('sign.deposit_profile', existing.id, 'sign.deposit_profile.cleared', 'Cleared org eSign deposit profile');

    return { cleared: true };
  },
});

/**
 * Sets or updates a draft non-confidential envelope's post-sign VietQR deposit request.
 */
export const envelopeDepositSet = defineCommand({
  name: 'sign.envelope.deposit.set',
  input: zSignEnvelopeDepositSetInput,
  risk: 'R2',
  sideEffect: 'internal',
  access: MEMBER_ROLES,
  writes: [ENVELOPE_DEPOSIT_CONFIG_WRITE],
  handler: async (ctx, input): Promise<SignEnvelopeDepositRecordContract> => {
    const env = await ctx.trx
      .selectFrom('ludy_sign.envelope')
      .select(['id', 'status', 'source_kind', 'title'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.envelopeId)
      .forUpdate()
      .executeTakeFirst();

    if (!env) {
      throw new DomainError('SIGN_ENVELOPE_NOT_FOUND', 404, 'Envelope not found');
    }
    if (env.source_kind === 'hr_contract' || env.source_kind === 'meeting_minutes') {
      throw new DomainError(
        'SIGN_CONFIDENTIAL_DEPOSIT_FORBIDDEN',
        403,
        'Deposit requests are not permitted on HR contract or meeting minutes envelopes',
      );
    }
    if (env.status !== 'draft') {
      throw new DomainError('SIGN_ENVELOPE_NOT_DRAFT', 409, 'Deposit settings can only change while envelope is a draft');
    }

    const amount = parseDepositAmountDecimal(input.amount);
    const note =
      input.note !== undefined ? (input.note === null ? null : input.note.trim() || null) : undefined;
    if (note && note.includes('\u0000')) {
      throw new DomainError('VALIDATION', 422, 'NUL characters are not permitted');
    }

    const existing = await ctx.trx
      .selectFrom('ludy_sign.envelope_deposit')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .forUpdate()
      .executeTakeFirst();

    let profile: { id: string } | undefined;
    if (input.depositProfileId) {
      profile = await ctx.trx
        .selectFrom('ludy_sign.deposit_profile')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.depositProfileId)
        .executeTakeFirst();
    } else {
      if (existing?.deposit_profile_id) {
        profile = await ctx.trx
          .selectFrom('ludy_sign.deposit_profile')
          .select('id')
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', existing.deposit_profile_id)
          .executeTakeFirst();
      }
      if (!profile) {
        profile = await ctx.trx
          .selectFrom('ludy_sign.deposit_profile')
          .select('id')
          .where('org_id', '=', ctx.orgId)
          .where('is_default', '=', true)
          .executeTakeFirst();
      }
    }

    if (!profile) {
      throw new DomainError(
        'SIGN_DEPOSIT_PROFILE_REQUIRED',
        422,
        'Configure an organization VietQR deposit profile in eSign Settings before attaching a deposit request',
      );
    }

    let memoToken: string;
    if (input.memoToken) {
      const requested = input.memoToken.trim().toUpperCase();
      const conflict = await ctx.trx
        .selectFrom('ludy_sign.envelope_deposit')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where('memo_token', '=', requested)
        .where('envelope_id', '!=', env.id)
        .limit(1)
        .executeTakeFirst();
      if (conflict) {
        throw new DomainError('SIGN_DEPOSIT_MEMO_CONFLICT', 409, 'Deposit memo token is already used by another envelope');
      }
      memoToken = requested;
    } else if (existing?.memo_token) {
      memoToken = existing.memo_token;
    } else {
      memoToken = await generateUniqueMemoToken(ctx);
    }

    const userId = actorUserId(ctx);
    const dueDays = input.dueDays !== undefined ? input.dueDays : (existing?.due_days ?? null);
    const finalNote = note !== undefined ? note : (existing?.note ?? null);

    let saved: EnvelopeDepositRow;
    if (existing) {
      saved = await ctx.trx
        .updateTable('ludy_sign.envelope_deposit')
        .set({
          amount,
          currency: 'VND',
          memo_token: memoToken,
          due_days: dueDays,
          deposit_profile_id: profile.id,
          note: finalNote,
          updated_by: userId,
          updated_at: ctx.now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', existing.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    } else {
      saved = await ctx.trx
        .insertInto('ludy_sign.envelope_deposit')
        .values({
          org_id: ctx.orgId,
          envelope_id: env.id,
          amount,
          currency: 'VND',
          memo_token: memoToken,
          due_days: dueDays,
          deposit_profile_id: profile.id,
          note: finalNote,
          created_by: userId,
          updated_by: userId,
          created_at: ctx.now,
          updated_at: ctx.now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    }

    ctx.audit({
      envelope_id: env.id,
      amount: saved.amount,
      currency: saved.currency,
      memo_token: saved.memo_token,
      due_days: saved.due_days,
      deposit_profile_id: saved.deposit_profile_id,
    });

    await ctx.activity(
      'sign.envelope',
      env.id,
      'sign.envelope.deposit_set',
      'Configured post-sign VietQR deposit request on signing envelope',
    );

    return formatEnvelopeDeposit(saved);
  },
});

/**
 * Removes a draft envelope's post-sign deposit request before sending.
 */
export const envelopeDepositClear = defineCommand({
  name: 'sign.envelope.deposit.clear',
  input: zSignEnvelopeDepositClearInput,
  risk: 'R2',
  sideEffect: 'internal',
  access: MEMBER_ROLES,
  writes: [ENVELOPE_DEPOSIT_CONFIG_WRITE],
  handler: async (ctx, input): Promise<{ cleared: boolean }> => {
    const env = await ctx.trx
      .selectFrom('ludy_sign.envelope')
      .select(['id', 'status', 'source_kind', 'title'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.envelopeId)
      .forUpdate()
      .executeTakeFirst();

    if (!env) {
      throw new DomainError('SIGN_ENVELOPE_NOT_FOUND', 404, 'Envelope not found');
    }
    if (env.source_kind === 'hr_contract' || env.source_kind === 'meeting_minutes') {
      throw new DomainError(
        'SIGN_CONFIDENTIAL_DEPOSIT_FORBIDDEN',
        403,
        'Deposit requests are not permitted on HR contract or meeting minutes envelopes',
      );
    }
    if (env.status !== 'draft') {
      throw new DomainError('SIGN_ENVELOPE_NOT_DRAFT', 409, 'Deposit settings can only change while envelope is a draft');
    }

    const deleted = await ctx.trx
      .deleteFrom('ludy_sign.envelope_deposit')
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', '=', env.id)
      .returning('memo_token')
      .executeTakeFirst();

    ctx.audit({
      envelope_id: env.id,
      cleared: Boolean(deleted),
      ...(deleted ? { memo_token: deleted.memo_token } : {}),
    });

    if (deleted) {
      await ctx.activity(
        'sign.envelope',
        env.id,
        'sign.envelope.deposit_cleared',
        'Removed post-sign VietQR deposit request from signing envelope',
      );
    }

    return { cleared: Boolean(deleted) };
  },
});

/**
 * Freezes the org deposit bank profile snapshot onto envelope_deposit atomically when sending a draft envelope.
 */
export async function freezeEnvelopeDepositSnapshot(
  ctx: CommandContext,
  params: { envelopeId: string; sourceKind?: string | undefined; userId: string | null },
): Promise<
  | { frozen: false }
  | {
      frozen: true;
      memoToken: string;
      amount: string;
      auditRedacted: {
        snapshot_account_number: unknown;
        snapshot_account_holder: unknown;
      };
    }
> {
  const deposit = await ctx.trx
    .selectFrom('ludy_sign.envelope_deposit')
    .selectAll()
    .where('org_id', '=', ctx.orgId)
    .where('envelope_id', '=', params.envelopeId)
    .forUpdate()
    .executeTakeFirst();

  if (!deposit) {
    return { frozen: false };
  }
  if (params.sourceKind === 'hr_contract' || params.sourceKind === 'meeting_minutes') {
    throw new DomainError(
      'SIGN_CONFIDENTIAL_DEPOSIT_FORBIDDEN',
      403,
      'Deposit requests are not permitted on HR contract or meeting minutes envelopes',
    );
  }
  if (deposit.snapshot_frozen_at) {
    throw new DomainError('SIGN_DEPOSIT_FROZEN', 409, 'Deposit snapshot is already frozen');
  }

  const profile = deposit.deposit_profile_id
    ? await ctx.trx
        .selectFrom('ludy_sign.deposit_profile')
        .select(['bank_code', 'bank_name', 'account_number', 'account_holder'])
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', deposit.deposit_profile_id)
        .executeTakeFirst()
    : await ctx.trx
        .selectFrom('ludy_sign.deposit_profile')
        .select(['bank_code', 'bank_name', 'account_number', 'account_holder'])
        .where('org_id', '=', ctx.orgId)
        .where('is_default', '=', true)
        .executeTakeFirst();

  if (
    !profile ||
    !profile.bank_code.trim() ||
    !profile.bank_name.trim() ||
    !ACCOUNT_NUMBER_PATTERN.test(profile.account_number.trim()) ||
    !profile.account_holder.trim()
  ) {
    throw new DomainError(
      'SIGN_DEPOSIT_PROFILE_INCOMPLETE',
      422,
      'A complete org deposit bank profile is required before sending an envelope with a deposit request',
    );
  }

  const bank = bankByCode(profile.bank_code);
  const emvcoPayload = buildVietQrEmvcoPayload({
    bankCode: profile.bank_code,
    accountNumber: profile.account_number,
    amount: trimDepositDecimalString(deposit.amount),
    memoToken: deposit.memo_token,
    napasBin: bank?.napasBin ?? null,
  });

  type SqlFreezeRow = {
    frozen?: boolean;
    error?: string;
    memoToken?: string;
    amount?: string;
    accountNumber?: string;
    accountHolder?: string;
  };
  const { rows: freezeRows } = await sql<{ result: SqlFreezeRow }>`
    SELECT ludy_sign.freeze_envelope_deposit_snapshot(
      ${ctx.orgId}::uuid,
      ${params.envelopeId}::uuid,
      ${emvcoPayload},
      ${params.userId}::uuid,
      ${ctx.now}::timestamptz
    ) AS result
  `.execute(ctx.trx);
  const res = freezeRows[0]?.result;
  if (!res || res.error === 'SIGN_DEPOSIT_PROFILE_INCOMPLETE') {
    throw new DomainError(
      'SIGN_DEPOSIT_PROFILE_INCOMPLETE',
      422,
      'A complete org deposit bank profile is required before sending an envelope with a deposit request',
    );
  }
  if (res.error === 'SIGN_INVALID_SIGNATURE_PNG' || res.error === 'SIGN_DEPOSIT_QR_FILE_INVALID') {
    throw new DomainError(res.error, 422, 'Stored VietQR image failed integrity verification');
  }
  if (res.error === 'SIGN_CONFIDENTIAL_DEPOSIT_FORBIDDEN') {
    throw new DomainError('SIGN_CONFIDENTIAL_DEPOSIT_FORBIDDEN', 403, 'Confidential envelope files cannot be linked as deposit QR');
  }
  if (res.error === 'SIGN_DEPOSIT_EMVCO_INVALID') {
    throw new DomainError('SIGN_DEPOSIT_EMVCO_INVALID', 422, 'Invalid EMVCo VietQR tag payload');
  }
  if (!res.frozen) {
    return { frozen: false };
  }

  return {
    frozen: true,
    memoToken: res.memoToken ?? deposit.memo_token,
    amount: trimDepositDecimalString(res.amount ?? deposit.amount),
    auditRedacted: {
      snapshot_account_number: auditValue(
        SIGN_ENVELOPE_DEPOSIT_TABLE,
        'snapshot_account_number',
        res.accountNumber ?? profile.account_number,
      ),
      snapshot_account_holder: auditValue(
        SIGN_ENVELOPE_DEPOSIT_TABLE,
        'snapshot_account_holder',
        res.accountHolder ?? profile.account_holder,
      ),
    },
  };
}

export interface SignDepositMatchCandidate {
  envelopeId: string;
  title: string;
  completedAt: string;
  amount: string;
  currency: 'VND';
  memoToken: string;
  financeBankAccount: string | null;
  signerName: string | null;
  signerNoticeAt: string | null;
}

/**
 * Internal read-only cross-module query consumed by Ludy Accounting (finance.bank.sign_deposit_match, ADR-0050).
 * Returns newest <= 200 completed non-confidential envelopes with frozen deposit snapshots.
 */
export const depositMatchCandidates = defineQuery({
  name: 'sign.deposit.match_candidates',
  input: z.strictObject({}),
  access: MEMBER_ROLES,
  handler: async (ctx): Promise<SignDepositMatchCandidate[]> => {
    const rows = await ctx.trx
      .selectFrom('ludy_sign.envelope_deposit as ed')
      .innerJoin('ludy_sign.envelope as e', (join) =>
        join.onRef('e.org_id', '=', 'ed.org_id').onRef('e.id', '=', 'ed.envelope_id'),
      )
      .select([
        'ed.envelope_id as envelope_id',
        'e.title as title',
        'e.completed_at as completed_at',
        'ed.amount as amount',
        'ed.memo_token as memo_token',
        'ed.snapshot_finance_bank_account as snapshot_finance_bank_account',
        'ed.signer_notice_at as signer_notice_at',
      ])
      .where('ed.org_id', '=', ctx.orgId)
      .where('ed.snapshot_frozen_at', 'is not', null)
      .where('e.status', '=', 'completed')
      .where('e.source_kind', 'not in', ['hr_contract', 'meeting_minutes'])
      .where('e.completed_at', 'is not', null)
      .orderBy('e.completed_at', 'desc')
      .orderBy('e.id', 'desc')
      .limit(DEPOSIT_MATCH_LIMIT)
      .execute();

    if (rows.length === 0) {
      return [];
    }

    const envelopeIds = rows.map((r) => r.envelope_id);
    const signerRows = await ctx.trx
      .selectFrom('ludy_sign.signer')
      .select(['envelope_id', 'name', 'routing_order'])
      .where('org_id', '=', ctx.orgId)
      .where('envelope_id', 'in', envelopeIds)
      .where('signer_role', '<>', 'cc')
      .orderBy('routing_order', 'asc')
      .orderBy('id', 'asc')
      .execute();

    const firstSignerByEnvelope = new Map<string, string>();
    for (const signer of signerRows) {
      if (!firstSignerByEnvelope.has(signer.envelope_id)) {
        firstSignerByEnvelope.set(signer.envelope_id, signer.name);
      }
    }

    return rows.map((row) => ({
      envelopeId: row.envelope_id,
      title: row.title,
      completedAt: isoString(row.completed_at as Date | string),
      amount: trimDepositDecimalString(row.amount),
      currency: 'VND',
      memoToken: row.memo_token,
      financeBankAccount: row.snapshot_finance_bank_account,
      signerName: firstSignerByEnvelope.get(row.envelope_id) ?? null,
      signerNoticeAt: isoOrNull(row.signer_notice_at),
    }));
  },
});

export const signDepositCommands = [depositProfileUpsert, depositProfileClear, envelopeDepositSet, envelopeDepositClear];
export const signDepositQueries = [depositProfileGet, depositMatchCandidates];
