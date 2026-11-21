// SPDX-License-Identifier: AGPL-3.0-only
// Worker handlers and scheduled sweeps for @crove/mod-sign (#3323, ADR-0053).
// Inspect and seal jobs check runtime.appOn(orgId, 'sign', { fresh: true }) (ADR-0053 'work'); expiry and
// cleanup sweeps run across all active orgs (ADR-0053 'keeping') so sent envelopes expire and stale secrets prune when disabled.
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { Db } from '@crove/db';
import {
  EXTRACT_LIMITS,
  INPUT_ERROR_CODES,
  encodePdfEmbedCmsInput,
  type ExtractClient,
} from '@crove/extract-contract';
import {
  BlobIntegrityError,
  BlobTooLargeError,
  CredentialError,
  DomainError,
  fileKey,
  putFile,
  readVerified,
  sha256Hex,
  type BlobStore,
  type CredentialBroker,
  type Runtime,
} from '@crove/kernel-runtime';
import {
  DEFAULT_OTP_RETENTION_HOURS,
  DEFAULT_RETENTION_DAYS,
  buildCanonicalCertificateArtifact,
  buildPdfSealCertificate,
  buildPdfSealInputBytes,
  generateCertificateCode,
  verifyEventChain,
  type SealedCaConnectionSecret,
  type SignCaJobBeginResult,
  type SignCaJobRecordResult,
  type SignInspectJobData,
  type SignPreExpirySweepResult,
  type SignSealJobData,
} from '@crove/mod-sign';
import {
  CaProviderError,
  SANDBOX_CA_SECRET,
  createSandboxCaAdapter,
  type CaProviderId,
  type CaSignSession,
  type CaSigningAdapter,
} from '@crove/sign';

export const SIGN_ACTOR = { type: 'system' as const, component: 'sign.worker' };
export const SIGN_EXPIRE_SWEEP_CRON = '*/5 * * * *';
export const SIGN_CLEANUP_CRON = '20 3 * * *';
export const SIGN_JOB_RETRY_LIMIT = 3;
const SWEEP_ORG_BATCH = 100;

export interface SignEnvelopeJob {
  orgId: string;
  envelopeId: string;
}

export interface SignCaReconcileJob {
  orgId: string;
  requestId: string;
}

export interface SignTemplateInspectJob {
  orgId: string;
  targetKind: 'template';
  templateId: string;
}

export type SignPdfInspectJob = SignEnvelopeJob | SignTemplateInspectJob;

export function isSignTemplateInspectJob(job: SignPdfInspectJob): job is SignTemplateInspectJob {
  return 'targetKind' in job && job.targetKind === 'template';
}

export interface SignWorkerDeps {
  workerDb: Db;
  runtime: Runtime;
  store: BlobStore;
  extract: ExtractClient;
}

export interface SignCaWorkerDeps extends SignWorkerDeps {
  broker?: CredentialBroker | undefined;
  caAdapters?: Partial<Record<CaProviderId, CaSigningAdapter>> | undefined;
}

const defaultSandboxCaAdapter = createSandboxCaAdapter().adapter;

export type SignSweepDeps = Pick<SignWorkerDeps, 'workerDb' | 'runtime'> & {
  log?: Pick<Console, 'error'>;
  now?: Date;
};

function safeArtifactBase(title: string): string {
  const cleaned = title
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return cleaned || 'document';
}

export async function runSignPdfInspectJob(
  deps: SignWorkerDeps,
  job: SignPdfInspectJob,
): Promise<{ status: 'skipped_app_off' | 'skipped_not_pending' | 'passed' | 'failed'; pageCount?: number }> {
  if (!(await deps.runtime.appOn(job.orgId, 'sign', { fresh: true }))) {
    return { status: 'skipped_app_off' };
  }

  const isTemplate = isSignTemplateInspectJob(job);
  const targetField = isSignTemplateInspectJob(job) ? { templateId: job.templateId } : { envelopeId: job.envelopeId };
  const queryName = isTemplate ? 'sign.template.inspect_job_data' : 'sign.envelope.inspect_job_data';
  const completeCommand = isTemplate ? 'sign.template.inspect_complete' : 'sign.envelope.inspect_complete';
  const options = { actor: SIGN_ACTOR, orgId: job.orgId };
  const data = await deps.runtime.query<SignInspectJobData | null>(queryName, targetField, options);
  const validStatus = isTemplate ? data?.status === 'draft' || data?.status === 'active' : data?.status === 'draft';
  if (!data || !validStatus || data.inspectStatus !== 'pending') {
    return { status: 'skipped_not_pending' };
  }

  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await readVerified(
      deps.store,
      { key: data.sourceStorageKey, generation: data.sourceGeneration, sha256: data.sourceSha256 },
      EXTRACT_LIMITS.maxFileBytes,
    );
  } catch (error) {
    if (error instanceof BlobIntegrityError || error instanceof BlobTooLargeError) {
      await deps.runtime.execute(
        completeCommand,
        { ...targetField, outcome: 'failed', error: error.message.slice(0, 500) },
        options,
      );
      return { status: 'failed' };
    }
    throw error;
  }

  const res = await deps.extract.extract('pdf_inspect', pdfBytes);
  if (!res.ok) {
    if (INPUT_ERROR_CODES.includes(res.code)) {
      await deps.runtime.execute(
        completeCommand,
        { ...targetField, outcome: 'failed', error: res.message.slice(0, 500) },
        options,
      );
      return { status: 'failed' };
    }
    throw new Error(`crove-extract pdf_inspect ${res.code}: ${res.message}`);
  }

  await deps.runtime.execute(
    completeCommand,
    {
      ...targetField,
      outcome: 'passed',
      pageCount: res.pageCount,
      pageDimensions: res.pages.map((p) => ({
        page: p.page,
        widthPt: p.widthPt,
        heightPt: p.heightPt,
        rotation: p.rotation,
      })),
      detectedTags: res.detectedTags ?? [],
    },
    options,
  );
  return { status: 'passed', pageCount: res.pageCount };
}

export async function runSignPdfSealJob(
  deps: SignWorkerDeps,
  job: SignEnvelopeJob,
): Promise<{ status: 'skipped_app_off' | 'skipped' | 'sealed' | 'failed'; certificateCode?: string }> {
  if (!(await deps.runtime.appOn(job.orgId, 'sign', { fresh: true }))) {
    return { status: 'skipped_app_off' };
  }

  const options = { actor: SIGN_ACTOR, orgId: job.orgId };
  const data = await deps.runtime.query<SignSealJobData | null>(
    'sign.envelope.seal_job_data',
    { envelopeId: job.envelopeId },
    options,
  );
  if (!data) return { status: 'skipped' };

  const { envelope, signers, fields, events } = data;
  if (envelope.status !== 'completed' || envelope.sealStatus === 'sealed' || envelope.pageCount === null) {
    return { status: 'skipped' };
  }

  const chain = verifyEventChain(events);
  if (!chain.valid || !chain.tipHash) {
    await deps.runtime.execute(
      'sign.envelope.seal_complete',
      {
        envelopeId: job.envelopeId,
        outcome: 'failed',
        error: (chain.reason ?? 'Event hash chain verification failed before sealing').slice(0, 500),
      },
      options,
    );
    return { status: 'failed' };
  }

  let sourcePdfBytes: Uint8Array;
  try {
    sourcePdfBytes = await readVerified(
      deps.store,
      {
        key: envelope.sourceStorageKey,
        generation: envelope.sourceGeneration,
        sha256: envelope.sourceSha256,
      },
      EXTRACT_LIMITS.maxFileBytes,
    );
  } catch (error) {
    if (error instanceof BlobIntegrityError || error instanceof BlobTooLargeError) {
      await deps.runtime.execute(
        'sign.envelope.seal_complete',
        { envelopeId: job.envelopeId, outcome: 'failed', error: error.message.slice(0, 500) },
        options,
      );
      return { status: 'failed' };
    }
    throw error;
  }

  if (!envelope.completedAtIso) {
    throw new Error(`Completed envelope ${envelope.id} is missing completed_at timestamp`);
  }
  const completedAtIso = envelope.completedAtIso;
  const certificateCode = generateCertificateCode(envelope.id, completedAtIso, chain.tipHash);

  let certificate;
  let sealInputBytes: Uint8Array;
  try {
    certificate = buildPdfSealCertificate({
      certificateCode,
      envelopeTitle: envelope.title,
      sourceSha256: envelope.sourceSha256,
      completedAtIso,
      eventChainTipHash: chain.tipHash,
      signers,
      events,
    });
    sealInputBytes = buildPdfSealInputBytes({
      sourcePdfBytes,
      pageCount: envelope.pageCount,
      fields,
      certificate,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid seal payload';
    await deps.runtime.execute(
      'sign.envelope.seal_complete',
      { envelopeId: job.envelopeId, outcome: 'failed', error: message.slice(0, 500) },
      options,
    );
    return { status: 'failed' };
  }

  const res = await deps.extract.extract('pdf_seal', sealInputBytes);
  if (!res.ok) {
    if (INPUT_ERROR_CODES.includes(res.code)) {
      await deps.runtime.execute(
        'sign.envelope.seal_complete',
        { envelopeId: job.envelopeId, outcome: 'failed', error: res.message.slice(0, 500) },
        options,
      );
      return { status: 'failed' };
    }
    throw new Error(`crove-extract pdf_seal ${res.code}: ${res.message}`);
  }

  const sealedBytes = Buffer.from(res.sealedPdfBase64, 'base64');
  if (sealedBytes.byteLength === 0) {
    await deps.runtime.execute(
      'sign.envelope.seal_complete',
      { envelopeId: job.envelopeId, outcome: 'failed', error: 'pdf_seal returned empty PDF bytes' },
      options,
    );
    return { status: 'failed' };
  }

  const sealedSha256 = sha256Hex(sealedBytes);
  const sealedStorageKey = fileKey(job.orgId, sealedSha256);
  const sealedGeneration = await putFile(deps.store, sealedStorageKey, sealedBytes, 'application/pdf', sealedSha256);

  const certArtifact = buildCanonicalCertificateArtifact({
    envelopeId: envelope.id,
    orgId: job.orgId,
    certificateCode,
    envelopeTitle: envelope.title,
    sourceSha256: envelope.sourceSha256,
    sealedSha256,
    completedAtIso,
    eventChainTipHash: chain.tipHash,
    signers: certificate.signers,
    events: events.map((ev) => ({
      seq: ev.seq,
      eventType: ev.event_type,
      signerId: ev.signer_id,
      actorType: ev.actor_type,
      documentSha256: ev.document_sha256,
      prevEventHash: ev.prev_event_hash,
      eventHash: ev.event_hash,
      occurredAtIso: new Date(ev.occurred_at).toISOString(),
    })),
  });

  const certStorageKey = fileKey(job.orgId, certArtifact.sha256);
  const certGeneration = await putFile(
    deps.store,
    certStorageKey,
    certArtifact.bytes,
    'application/json',
    certArtifact.sha256,
  );

  const base = safeArtifactBase(envelope.title);
  const sealedIngest = await deps.runtime.execute<{ fileId: string }>(
    'kernel.file.ingest',
    {
      filename: `${base}-signed.pdf`,
      contentType: 'application/pdf',
      sizeBytes: sealedBytes.byteLength,
      sha256: sealedSha256,
      storageKey: sealedStorageKey,
      generation: sealedGeneration,
      source: 'sign_sealed',
    },
    options,
  );
  const certIngest = await deps.runtime.execute<{ fileId: string }>(
    'kernel.file.ingest',
    {
      filename: `${base}-certificate.json`,
      contentType: 'application/json',
      sizeBytes: certArtifact.bytes.byteLength,
      sha256: certArtifact.sha256,
      storageKey: certStorageKey,
      generation: certGeneration,
      source: 'sign_certificate',
    },
    options,
  );
  await deps.runtime.execute(
    'sign.envelope.seal_complete',
    {
      envelopeId: job.envelopeId,
      outcome: 'sealed',
      certificateCode,
      sealedFileId: sealedIngest.fileId,
      certificateFileId: certIngest.fileId,
    },
    options,
  );

  return { status: 'sealed', certificateCode };
}

function sweepErrorLabel(error: unknown): string {
  return error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error';
}

export async function sweepSignExpire(deps: SignSweepDeps): Promise<number> {
  const log = deps.log ?? console;
  const { rows: orgs } = await sql<{ org_id: string }>`
    SELECT org_id FROM crove_sign.expire_sweep_due_orgs(${SWEEP_ORG_BATCH}) ORDER BY org_id ASC
  `.execute(deps.workerDb);
  let total = 0;
  for (const row of orgs) {
    try {
      const res = await deps.runtime.execute<{ expiredCount: number }>(
        'sign.envelope.expire_sweep',
        {},
        { actor: SIGN_ACTOR, orgId: row.org_id },
      );
      total += res.expiredCount;
    } catch (error) {
      log.error(`[sign-expire-sweep] org ${row.org_id.slice(0, 8)} failed`, sweepErrorLabel(error));
    }
  }
  return total;
}

export interface SignPreExpirySweepTotals {
  orgs: number;
  envelopes: number;
  remindedSigners: number;
  queuedEmails: number;
  suppressedEmails: number;
}

// ADR-0053 'work': sends at most one 24h pre-expiry reminder email per eligible active email signer
// when org_app_on(org_id, 'sign') is true. Unlike sweepSignExpire ('keeping'), disabled orgs never send mail.
export async function sweepSignPreExpiryReminders(deps: SignSweepDeps): Promise<SignPreExpirySweepTotals> {
  const log = deps.log ?? console;
  const { rows: orgs } = await sql<{ org_id: string }>`
    SELECT org_id
    FROM crove_sign.pre_expiry_remind_due_orgs(${SWEEP_ORG_BATCH}, ${deps.now ?? null}::timestamptz)
    ORDER BY org_id ASC
  `.execute(deps.workerDb);
  const totals: SignPreExpirySweepTotals = {
    orgs: 0,
    envelopes: 0,
    remindedSigners: 0,
    queuedEmails: 0,
    suppressedEmails: 0,
  };
  for (const row of orgs) {
    try {
      if (!(await deps.runtime.appOn(row.org_id, 'sign', { fresh: true }))) {
        continue;
      }
      const res = await deps.runtime.execute<SignPreExpirySweepResult>(
        'sign.envelope.pre_expiry_remind_sweep',
        deps.now ? { now: deps.now.toISOString() } : {},
        { actor: SIGN_ACTOR, orgId: row.org_id },
      );
      totals.orgs += 1;
      totals.envelopes += res.envelopesReminded;
      totals.remindedSigners += res.remindedSigners;
      totals.queuedEmails += res.queuedEmails;
      totals.suppressedEmails += res.suppressedEmails;
    } catch (error) {
      log.error(`[sign-pre-expiry-remind] org ${row.org_id.slice(0, 8)} failed`, sweepErrorLabel(error));
    }
  }
  return totals;
}

export async function sweepSignCleanup(deps: SignSweepDeps): Promise<{
  orgs: number;
  otps: number;
  tokens: number;
  drafts: number;
  draftEvents: number;
}> {
  const log = deps.log ?? console;
  const nowMs = (deps.now ?? new Date()).getTime();
  const otpCutoff = new Date(nowMs - DEFAULT_OTP_RETENTION_HOURS * 3_600_000);
  const tokenCutoff = new Date(nowMs - DEFAULT_RETENTION_DAYS * 86_400_000);
  const { rows: orgs } = await sql<{ org_id: string }>`
    SELECT org_id FROM crove_sign.cleanup_due_orgs_secrets(${otpCutoff}::timestamptz, ${tokenCutoff}::timestamptz, ${SWEEP_ORG_BATCH}) ORDER BY org_id ASC
  `.execute(deps.workerDb);
  const totals = { orgs: 0, otps: 0, tokens: 0, drafts: 0, draftEvents: 0 };
  for (const row of orgs) {
    try {
      const res = await deps.runtime.execute<{ otps: number; tokens: number; drafts: number; draftEvents: number }>(
        'sign.org.cleanup',
        { tokenRetentionDays: DEFAULT_RETENTION_DAYS, otpRetentionHours: DEFAULT_OTP_RETENTION_HOURS },
        { actor: SIGN_ACTOR, orgId: row.org_id },
      );
      totals.orgs += 1;
      totals.otps += res.otps;
      totals.tokens += res.tokens;
      totals.drafts += res.drafts;
      totals.draftEvents += res.draftEvents;
    } catch (error) {
      log.error(`[sign-cleanup] org ${row.org_id.slice(0, 8)} failed`, sweepErrorLabel(error));
    }
  }
  return totals;
}

const MAX_RECOVERY_PAGES = 100;

interface RecoveryCursor {
  updatedAt: string;
  orgId: string;
  envelopeId: string;
}

interface TemplateRecoveryCursor {
  updatedAt: string;
  orgId: string;
  templateId: string;
}

interface CaRecoveryCursor {
  dueAt: string;
  orgId: string;
  requestId: string;
}

const PADES_PLACEHOLDER_BYTES = 32_768;
const PLACEHOLDER_DER_SEQUENCE_BASE64 = 'MAA=';

function padesSubFilterForProvider(provider: CaProviderId): 'ETSI.CAdES.detached' | 'adbe.pkcs7.detached' {
  return provider === 'sandbox' ? 'ETSI.CAdES.detached' : 'adbe.pkcs7.detached';
}

function byteRangeSha256Hex(pdfBytes: Uint8Array, byteRange: readonly [number, number, number, number]): string {
  const [b0, len0, b2, len2] = byteRange;
  return createHash('sha256')
    .update(pdfBytes.subarray(b0, b0 + len0))
    .update(pdfBytes.subarray(b2, b2 + len2))
    .digest('hex');
}

function resolveCaAdapter(
  provider: CaProviderId,
  overrides?: Partial<Record<CaProviderId, CaSigningAdapter>>,
): CaSigningAdapter {
  const custom = overrides?.[provider];
  if (custom) return custom;
  if (provider === 'sandbox') return defaultSandboxCaAdapter;
  throw new DomainError(
    'SIGN_LIVE_CA_GATED',
    422,
    'Live external Vietnam CA signing is gated pending #62 legal review and worker egress wiring',
  );
}

export async function runSignCaReconcileJob(
  deps: SignCaWorkerDeps,
  job: SignCaReconcileJob,
): Promise<{
  status: 'skipped_app_off' | 'skipped' | 'pending' | 'signed' | 'failed';
  reason?: string;
  padesFileId?: string;
  pollAttempts?: number;
  nextPollAt?: string | null;
}> {
  if (!(await deps.runtime.appOn(job.orgId, 'sign', { fresh: true }))) {
    return { status: 'skipped_app_off' };
  }

  const options = { actor: SIGN_ACTOR, orgId: job.orgId };
  let begin = await deps.runtime.execute<SignCaJobBeginResult>(
    'sign.ca.request.job_begin',
    { requestId: job.requestId, prepareOnly: true },
    options,
  );
  if (begin.action === 'none') {
    return { status: 'skipped', reason: begin.reason };
  }

  const recordTerminalFailure = async (errorCode: string, txId?: string | null): Promise<{ status: 'failed'; reason: string }> => {
    if (begin.action === 'none') return { status: 'failed', reason: errorCode };
    await deps.runtime.execute(
      'sign.ca.request.job_record',
      {
        requestId: begin.requestId,
        callKey: begin.callKey,
        outcome: 'terminal_failure',
        status: 'failed',
        errorCode: errorCode.slice(0, 128),
        ...(txId ? { externalTxId: txId } : {}),
      },
      options,
    );
    return { status: 'failed', reason: errorCode };
  };

  let cachedSealedPdfBytes: Uint8Array | null = null;
  const loadSealedPdfBytes = async (): Promise<Uint8Array> => {
    if (cachedSealedPdfBytes) return cachedSealedPdfBytes;
    if (begin.action === 'none') throw new Error('unreachable');
    cachedSealedPdfBytes = await readVerified(
      deps.store,
      {
        key: begin.sealedStorageKey,
        generation: begin.sealedGeneration,
        sha256: begin.sealedSha256,
      },
      EXTRACT_LIMITS.maxFileBytes,
    );
    return cachedSealedPdfBytes;
  };

  if (begin.action === 'prepare') {
    let sealedPdfBytes: Uint8Array;
    try {
      sealedPdfBytes = await loadSealedPdfBytes();
    } catch (error) {
      if (error instanceof BlobIntegrityError || error instanceof BlobTooLargeError) {
        return recordTerminalFailure(error instanceof BlobTooLargeError ? 'BLOB_TOO_LARGE' : 'BLOB_INTEGRITY_ERROR');
      }
      throw error;
    }
    const subFilter = padesSubFilterForProvider(begin.provider);
    const signerName = `Crove eSign (${begin.provider})`;
    const reason = `PAdES seal for ${begin.envelopeTitle.slice(0, 120)}`;
    const fieldName = `CroveCA_${begin.requestId.replace(/-/g, '').slice(0, 16)}`;
    const prepPayload = encodePdfEmbedCmsInput({
      pdfBase64: Buffer.from(sealedPdfBytes).toString('base64'),
      cmsDerBase64: PLACEHOLDER_DER_SEQUENCE_BASE64,
      placeholderBytes: PADES_PLACEHOLDER_BYTES,
      signerName,
      reason,
      signedAtIso: begin.requestCreatedAtIso,
      fieldName,
      subFilter,
    });
    const prepResult = await deps.extract.extract('pdf_embed_cms', prepPayload);
    if (!prepResult.ok) {
      if (INPUT_ERROR_CODES.includes(prepResult.code)) {
        return recordTerminalFailure(`PDF_EMBED_${prepResult.code}`);
      }
      throw new Error(`pdf_embed_cms placeholder transient failure (${prepResult.code}): ${prepResult.message}`);
    }
    const prepBytes = Uint8Array.from(Buffer.from(prepResult.pdfBase64, 'base64'));
    const computedByteRangeSha256 = byteRangeSha256Hex(prepBytes, prepResult.byteRange);
    begin = await deps.runtime.execute<SignCaJobBeginResult>(
      'sign.ca.request.job_begin',
      { requestId: job.requestId, byteRangeDigestSha256: computedByteRangeSha256 },
      options,
    );
    if (begin.action === 'none') {
      return { status: 'skipped', reason: begin.reason };
    }
  }

  let secret = SANDBOX_CA_SECRET;
  if (begin.provider !== 'sandbox') {
    if (!deps.broker) {
      const rec = await deps.runtime.execute<SignCaJobRecordResult>(
        'sign.ca.request.job_record',
        {
          requestId: begin.requestId,
          callKey: begin.callKey,
          outcome: 'transient_retry',
          errorCode: 'BROKER_NOT_CONFIGURED',
        },
        options,
      );
      return rec.status === 'failed'
        ? { status: 'failed', reason: 'broker_unavailable' }
        : { status: 'pending', reason: 'broker_unavailable', pollAttempts: rec.pollAttempts, nextPollAt: rec.nextPollAt };
    }
    try {
      const sealed = await deps.runtime.query<SealedCaConnectionSecret>(
        'sign.ca.connection.secret',
        { connectionId: begin.caConnectionId },
        options,
      );
      secret = deps.broker.open(
        {
          keyId: sealed.keyId,
          envelope: Buffer.from(sealed.secretEnvelope, 'base64'),
        },
        {
          orgId: job.orgId,
          provider: `sign_ca:${sealed.provider}`,
          externalAccountId: sealed.id,
        },
      );
    } catch (error: unknown) {
      if (
        error instanceof DomainError &&
        (error.code === 'SIGN_CA_CONNECTION_OWNER_LEFT' ||
          error.code === 'SIGN_CA_CONNECTION_DISABLED' ||
          error.code === 'SIGN_CA_CONNECTION_NOT_FOUND')
      ) {
        if (begin.action !== 'ask') {
          await deps.runtime.execute(
            'sign.ca.request.job_record',
            {
              requestId: begin.requestId,
              callKey: begin.callKey,
              outcome: 'terminal_failure',
              status: 'failed',
              errorCode: error.code,
            },
            options,
          );
          return { status: 'failed', reason: error.code };
        }
        const rec = await deps.runtime.execute<SignCaJobRecordResult>(
          'sign.ca.request.job_record',
          {
            requestId: begin.requestId,
            callKey: begin.callKey,
            outcome: 'transient_retry',
            errorCode: error.code,
          },
          options,
        );
        return rec.status === 'failed'
          ? { status: 'failed', reason: error.code }
          : { status: 'pending', reason: error.code, pollAttempts: rec.pollAttempts, nextPollAt: rec.nextPollAt };
      }
      if (error instanceof CredentialError) {
        await deps.runtime.execute(
          'sign.ca.request.job_record',
          {
            requestId: begin.requestId,
            callKey: begin.callKey,
            outcome: 'terminal_failure',
            status: 'failed',
            errorCode: 'CREDENTIAL_UNSEAL_FAILED',
          },
          options,
        );
        return { status: 'failed', reason: 'CREDENTIAL_UNSEAL_FAILED' };
      }
      throw error;
    }
  }

  const adapter = resolveCaAdapter(begin.provider, deps.caAdapters);
  let externalTxId = begin.externalTxId;
  let signedAtIso: string | undefined;

  if (begin.action !== 'embed') {
    let session: CaSignSession;
    try {
      if (begin.action === 'initiate') {
        session = await adapter.initiateSign(secret, {
          idempotencyKey: begin.idempotencyKey,
          digestSha256: begin.digestSha256,
          certRef: begin.certRef,
          documentName: begin.envelopeTitle,
          signerReason: 'Ludy eSign PAdES seal',
        });
      } else if (begin.action === 'ask') {
        session = await adapter.pollStatus(secret, { idempotencyKey: begin.idempotencyKey });
      } else {
        session = await adapter.pollStatus(secret, {
          externalTxId: begin.externalTxId,
          idempotencyKey: begin.idempotencyKey,
        });
      }
    } catch (error: unknown) {
      if (error instanceof CaProviderError) {
        if (error.kind === 'lost_answer' || error.kind === 'timeout' || error.kind === 'unreachable' || error.kind === 'unavailable') {
          const rec = await deps.runtime.execute<SignCaJobRecordResult>(
            'sign.ca.request.job_record',
            {
              requestId: begin.requestId,
              callKey: begin.callKey,
              outcome: error.kind === 'lost_answer' ? 'lost_answer' : 'transient_retry',
              errorCode: `CA_${error.kind.toUpperCase()}`,
            },
            options,
          );
          return rec.status === 'failed'
            ? { status: 'failed', reason: error.kind }
            : { status: 'pending', reason: error.kind, pollAttempts: rec.pollAttempts, nextPollAt: rec.nextPollAt };
        }
        await deps.runtime.execute(
          'sign.ca.request.job_record',
          {
            requestId: begin.requestId,
            callKey: begin.callKey,
            outcome: 'terminal_failure',
            status: 'failed',
            errorCode: `CA_${error.kind.toUpperCase()}`,
          },
          options,
        );
        return { status: 'failed', reason: error.kind };
      }
      throw error;
    }

    if (session.status === 'pending') {
      const rec = await deps.runtime.execute<SignCaJobRecordResult>(
        'sign.ca.request.job_record',
        {
          requestId: begin.requestId,
          callKey: begin.callKey,
          outcome: 'pending',
          externalTxId: session.externalTxId,
          challengeCode: session.challengeCode ?? null,
        },
        options,
      );
      return rec.status === 'expired'
        ? { status: 'failed', reason: 'expired' }
        : { status: 'pending', pollAttempts: rec.pollAttempts, nextPollAt: rec.nextPollAt };
    }

    if (session.status === 'rejected' || session.status === 'expired' || session.status === 'failed') {
      await deps.runtime.execute(
        'sign.ca.request.job_record',
        {
          requestId: begin.requestId,
          callKey: begin.callKey,
          outcome: 'terminal_failure',
          status: session.status,
          errorCode: session.errorCode ?? `CA_${session.status.toUpperCase()}`,
          externalTxId: session.externalTxId,
        },
        options,
      );
      return { status: 'failed', reason: session.status };
    }

    externalTxId = session.externalTxId;
    signedAtIso = session.signedAt ?? new Date().toISOString();
    await deps.runtime.execute(
      'sign.ca.request.job_record',
      {
        requestId: begin.requestId,
        callKey: begin.callKey,
        outcome: 'signed_session',
        externalTxId,
        signedAtIso,
      },
      options,
    );
  }

  if (!externalTxId) {
    return { status: 'failed', reason: 'missing_external_tx_id' };
  }

  let signedCms: Awaited<ReturnType<CaSigningAdapter['fetchSignedCms']>>;
  try {
    signedCms = await adapter.fetchSignedCms(secret, {
      externalTxId,
      certRef: begin.certRef,
    });
  } catch (error: unknown) {
    if (error instanceof CaProviderError) {
      if (error.kind === 'timeout' || error.kind === 'unreachable' || error.kind === 'unavailable' || error.kind === 'not_signed') {
        const rec = await deps.runtime.execute<SignCaJobRecordResult>(
          'sign.ca.request.job_record',
          {
            requestId: begin.requestId,
            callKey: begin.callKey,
            outcome: 'transient_retry',
            errorCode: `CA_CMS_${error.kind.toUpperCase()}`,
          },
          options,
        );
        return rec.status === 'failed'
          ? { status: 'failed', reason: error.kind }
          : { status: 'pending', reason: error.kind, pollAttempts: rec.pollAttempts, nextPollAt: rec.nextPollAt };
      }
      await deps.runtime.execute(
        'sign.ca.request.job_record',
        {
          requestId: begin.requestId,
          callKey: begin.callKey,
          outcome: 'terminal_failure',
          status: 'failed',
          errorCode: `CA_CMS_${error.kind.toUpperCase()}`,
          externalTxId,
        },
        options,
      );
      return { status: 'failed', reason: error.kind };
    }
    throw error;
  }

  const subFilter = padesSubFilterForProvider(begin.provider);
  let sealedPdfBytes: Uint8Array;
  try {
    sealedPdfBytes = await loadSealedPdfBytes();
  } catch (error) {
    if (error instanceof BlobIntegrityError || error instanceof BlobTooLargeError) {
      return recordTerminalFailure(
        error instanceof BlobTooLargeError ? 'BLOB_TOO_LARGE' : 'BLOB_INTEGRITY_ERROR',
        externalTxId,
      );
    }
    throw error;
  }

  let embedPayload: Uint8Array;
  try {
    embedPayload = encodePdfEmbedCmsInput({
      pdfBase64: Buffer.from(sealedPdfBytes).toString('base64'),
      cmsDerBase64: Buffer.from(signedCms.cmsDer).toString('base64'),
      placeholderBytes: PADES_PLACEHOLDER_BYTES,
      signerName: `Crove eSign (${begin.provider})`,
      reason: `PAdES seal for ${begin.envelopeTitle.slice(0, 120)}`,
      signedAtIso: begin.requestCreatedAtIso,
      fieldName: `CroveCA_${begin.requestId.replace(/-/g, '').slice(0, 16)}`,
      subFilter,
      ...(signedCms.timestampTokenDer
        ? { timestampTokenBase64: Buffer.from(signedCms.timestampTokenDer).toString('base64') }
        : {}),
      ...(signedCms.ocspResponsesDer && signedCms.ocspResponsesDer.length > 0
        ? { ocspResponsesBase64: signedCms.ocspResponsesDer.map((item) => Buffer.from(item).toString('base64')) }
        : {}),
    });
  } catch (error) {
    if (error instanceof BlobTooLargeError) {
      return recordTerminalFailure('BLOB_TOO_LARGE', externalTxId);
    }
    throw error;
  }

  const embedResult = await deps.extract.extract('pdf_embed_cms', embedPayload);
  if (!embedResult.ok) {
    if (INPUT_ERROR_CODES.includes(embedResult.code)) {
      return recordTerminalFailure(`PDF_EMBED_${embedResult.code}`, externalTxId);
    }
    throw new Error(`pdf_embed_cms transient failure (${embedResult.code}): ${embedResult.message}`);
  }

  const padesBytes = Uint8Array.from(Buffer.from(embedResult.pdfBase64, 'base64'));
  const padesSha256 = sha256Hex(padesBytes);
  if (padesSha256 !== embedResult.signedSha256) {
    throw new Error(`pdf_embed_cms sha256 mismatch: computed ${padesSha256}, reported ${embedResult.signedSha256}`);
  }
  const actualByteRangeSha256 = byteRangeSha256Hex(padesBytes, embedResult.byteRange);
  if (actualByteRangeSha256 !== begin.digestSha256) {
    throw new Error(
      `pdf_embed_cms ByteRange digest mismatch: embedded ${actualByteRangeSha256}, signed ${begin.digestSha256}`,
    );
  }
  if (padesBytes.byteLength > EXTRACT_LIMITS.maxFileBytes) {
    return recordTerminalFailure('PADES_BLOB_TOO_LARGE', externalTxId);
  }

  const padesStorageKey = fileKey(job.orgId, padesSha256);
  const padesGeneration = await putFile(
    deps.store,
    padesStorageKey,
    padesBytes,
    'application/pdf',
    padesSha256,
  );

  const base = safeArtifactBase(begin.envelopeTitle);
  const padesIngest = await deps.runtime.execute<{ fileId: string }>(
    'kernel.file.ingest',
    {
      filename: `${base}-pades.pdf`,
      contentType: 'application/pdf',
      sizeBytes: padesBytes.byteLength,
      sha256: padesSha256,
      storageKey: padesStorageKey,
      generation: padesGeneration,
      source: 'sign_sealed',
    },
    options,
  );

  const completedSignedAtIso = signedCms.signedAt ?? signedAtIso ?? begin.requestCreatedAtIso;
  await deps.runtime.execute(
    'sign.ca.request.job_complete',
    {
      requestId: begin.requestId,
      externalTxId,
      subFilter,
      padesFileId: padesIngest.fileId,
      padesStorageKey,
      padesGeneration,
      padesSha256,
      signedAtIso: completedSignedAtIso,
    },
    options,
  );

  return { status: 'signed', padesFileId: padesIngest.fileId };
}

async function fetchSignRecoveryPage(
  workerDb: Db,
  olderThan: Date,
  batchSize: number,
  orgId: string | null,
  after: RecoveryCursor | null,
) {
  const { rows } = await sql<{
    work_kind: 'inspect' | 'seal';
    org_id: string;
    envelope_id: string;
    updated_at_cursor: string;
  }>`
    SELECT work_kind, org_id, envelope_id, updated_at::text AS updated_at_cursor
    FROM crove_sign.work_recovery_candidates(
      ${olderThan}::timestamptz,
      ${batchSize},
      ${orgId}::uuid,
      ${after?.updatedAt ?? null}::timestamptz,
      ${after?.orgId ?? null}::uuid,
      ${after?.envelopeId ?? null}::uuid
    )
  `.execute(workerDb);
  return rows;
}

async function fetchTemplateRecoveryPage(
  workerDb: Db,
  olderThan: Date,
  batchSize: number,
  orgId: string | null,
  after: TemplateRecoveryCursor | null,
) {
  const { rows } = await sql<{
    org_id: string;
    template_id: string;
    updated_at_cursor: string;
  }>`
    SELECT org_id, template_id, updated_at::text AS updated_at_cursor
    FROM crove_sign.template_work_recovery_candidates(
      ${olderThan}::timestamptz,
      ${batchSize},
      ${orgId}::uuid,
      ${after?.updatedAt ?? null}::timestamptz,
      ${after?.orgId ?? null}::uuid,
      ${after?.templateId ?? null}::uuid
    )
  `.execute(workerDb);
  return rows;
}

async function fetchCaRecoveryPage(
  workerDb: Db,
  olderThan: Date,
  batchSize: number,
  orgId: string | null,
  after: CaRecoveryCursor | null,
) {
  const { rows } = await sql<{
    org_id: string;
    request_id: string;
    due_at_cursor: string;
  }>`
    SELECT org_id, request_id, due_at::text AS due_at_cursor
    FROM crove_sign.ca_work_recovery_candidates(
      ${olderThan}::timestamptz,
      ${batchSize},
      ${orgId}::uuid,
      ${after?.dueAt ?? null}::timestamptz,
      ${after?.orgId ?? null}::uuid,
      ${after?.requestId ?? null}::uuid
    )
  `.execute(workerDb);
  return rows;
}

export interface SignPendingWorkDeps {
  workerDb: Db;
  appOn?: (orgId: string) => Promise<boolean>;
  enqueueInspect: (orgId: string, envelopeId: string) => Promise<void>;
  enqueueSeal: (orgId: string, envelopeId: string) => Promise<void>;
  enqueueTemplateInspect?: (orgId: string, templateId: string) => Promise<void>;
  enqueueCaReconcile?: (orgId: string, requestId: string) => Promise<void>;
  orgId?: string;
  olderThan?: Date;
  batchSize?: number;
  maxPages?: number;
}

export async function sweepSignPendingWork(
  deps: SignPendingWorkDeps,
): Promise<{ inspect: number; seal: number; caReconcile: number }> {
  const olderThan = deps.olderThan ?? new Date(Date.now() - 60_000);
  const batchSize = Math.min(Math.max(Math.trunc(deps.batchSize ?? SWEEP_ORG_BATCH), 1), 500);
  const maxPages = Math.max(Math.trunc(deps.maxPages ?? MAX_RECOVERY_PAGES), 1);
  const enabledCache = new Map<string, boolean>();
  const isEnabled = async (orgId: string) => {
    if (!deps.appOn) return true;
    const cached = enabledCache.get(orgId);
    if (cached !== undefined) return cached;
    const enabled = await deps.appOn(orgId);
    enabledCache.set(orgId, enabled);
    return enabled;
  };
  let inspect = 0;
  let seal = 0;
  let caReconcile = 0;
  let after: RecoveryCursor | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const rows = await fetchSignRecoveryPage(deps.workerDb, olderThan, batchSize, deps.orgId ?? null, after);
    for (const row of rows) {
      if (!(await isEnabled(row.org_id))) continue;
      if (row.work_kind === 'inspect') {
        await deps.enqueueInspect(row.org_id, row.envelope_id);
        inspect += 1;
      } else {
        await deps.enqueueSeal(row.org_id, row.envelope_id);
        seal += 1;
      }
    }
    const last = rows.at(-1);
    if (!last || rows.length < batchSize) break;
    after = { updatedAt: last.updated_at_cursor, orgId: last.org_id, envelopeId: last.envelope_id };
  }
  if (deps.enqueueTemplateInspect) {
    let tplAfter: TemplateRecoveryCursor | null = null;
    for (let page = 0; page < maxPages; page += 1) {
      const tplRows = await fetchTemplateRecoveryPage(deps.workerDb, olderThan, batchSize, deps.orgId ?? null, tplAfter);
      for (const row of tplRows) {
        if (!(await isEnabled(row.org_id))) continue;
        await deps.enqueueTemplateInspect(row.org_id, row.template_id);
        inspect += 1;
      }
      const last = tplRows.at(-1);
      if (!last || tplRows.length < batchSize) break;
      tplAfter = { updatedAt: last.updated_at_cursor, orgId: last.org_id, templateId: last.template_id };
    }
  }
  if (deps.enqueueCaReconcile) {
    let caAfter: CaRecoveryCursor | null = null;
    for (let page = 0; page < maxPages; page += 1) {
      const caRows = await fetchCaRecoveryPage(deps.workerDb, olderThan, batchSize, deps.orgId ?? null, caAfter);
      for (const row of caRows) {
        if (!(await isEnabled(row.org_id))) continue;
        await deps.enqueueCaReconcile(row.org_id, row.request_id);
        caReconcile += 1;
      }
      const last = caRows.at(-1);
      if (!last || caRows.length < batchSize) break;
      caAfter = { dueAt: last.due_at_cursor, orgId: last.org_id, requestId: last.request_id };
    }
  }
  return { inspect, seal, caReconcile };
}
