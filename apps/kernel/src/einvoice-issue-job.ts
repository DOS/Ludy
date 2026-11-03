// SPDX-License-Identifier: AGPL-3.0-only
// The issue of a sales e-invoice, the worker's half (#2502, ADR-0044 points 3 to 5), run as the system for a draft a person's approved issue moved to `submitting`. The
// credential is opened here and nowhere else (the API only seals it, ADR-0025). Every provider call is committed to the external_call ledger BEFORE it is made
// (finance.einvoice.job_begin); a call found started is never sent again: the job asks the provider for the draft's key first. What comes back is recorded
// (finance.einvoice.job_record); on `issued` the signed XML and the PDF are fetched, stored as evidence and linked to the draft (finance.einvoice.job_files), and the XML goes through
// the ordinary intake (kernel.file.ingest naming the draft's entity, then the extraction queue), so the sale is posted only from that XML and waits for an ordinary approval.
// Nothing here logs or stores a credential, the buyer's data or a provider's own text: codes and ids.
import { EInvoiceProviderError, SANDBOX_EINVOICE_SECRET, type EInvoiceOutcome, type EInvoiceProvider, type EInvoiceRequest, type EInvoiceStatusAnswer } from '@crove/einvoice';
import type { Db } from '@crove/db';
import { DomainError, fileKey, putFile, sha256Hex, type BlobStore, type CredentialBroker, type Runtime } from '@crove/kernel-runtime';
import { sql } from 'kysely';

const SYSTEM = { type: 'system' as const, component: 'finance.einvoice' };

export interface EInvoiceIssueJob {
  orgId: string;
  draftId: string;
}

export interface EInvoiceIssueDeps {
  runtime: Runtime;
  broker: CredentialBroker;
  store: BlobStore;
  providers: Readonly<Record<string, EInvoiceProvider>>;
}

interface Begun {
  action: 'none' | 'issue' | 'ask' | 'poll' | 'files';
  reason?: string;
  draftId?: string;
  legalEntityId?: string;
  key?: string;
  ref?: string | null;
  connectionId?: string;
  channelProvider?: string;
  adapter?: string;
  request?: EInvoiceRequest;
}

type Result =
  | { outcome: 'issued'; ref: string; number: string; signedAt: string; taxAuthorityCode: string | null }
  | { outcome: 'pending'; ref: string }
  | { outcome: 'still_pending' }
  | { outcome: 'rejected'; ref: string | null; code: 'invalid_data' | 'series_unknown' | 'rejected_by_tax_authority' | 'provider_refused' }
  | { outcome: 'ambiguous'; kind: 'unreachable' | 'timeout' | 'lost_answer' | 'unavailable' }
  | { outcome: 'not_found' }
  | { outcome: 'failed'; code: 'CREDENTIALS' | 'PROVIDER_UNAVAILABLE' };

interface Recorded {
  recorded: boolean;
  state: string;
  resend?: EInvoiceRequest;
}

interface SealedChannelCredential {
  provider: string;
  externalAccountId: string;
  keyId: string;
  envelope: string;
}

// A page of the drafts whose time has come (crove_finance.einvoice_due, the worker login's alone), for the sweep.
export const EINVOICE_DUE_PAGE = 1000;
export async function einvoiceDue(workerDb: Db, after: { orgId: string; draftId: string } | null): Promise<Array<{ orgId: string; draftId: string }>> {
  const { rows } = await sql<{ org_id: string; draft_id: string }>`
    SELECT org_id, draft_id FROM crove_finance.einvoice_due(${after?.orgId ?? null}::uuid, ${after?.draftId ?? null}::uuid, ${EINVOICE_DUE_PAGE}::int)`.execute(workerDb);
  return rows.map((r) => ({ orgId: r.org_id, draftId: r.draft_id }));
}

const fromOutcome = (outcome: EInvoiceOutcome): Result => {
  if (outcome.state === 'issued') return { outcome: 'issued', ref: outcome.ref, number: outcome.number, signedAt: outcome.signedAt, taxAuthorityCode: outcome.taxAuthorityCode };
  if (outcome.state === 'pending') return { outcome: 'pending', ref: outcome.ref };
  return { outcome: 'rejected', ref: outcome.ref, code: outcome.code };
};

// An error of the provider, as the state it leaves: refused credentials are certain (nothing was made), every other failure is not (the call may have reached it).
const fromError = (error: unknown): Result => {
  if (error instanceof EInvoiceProviderError) {
    if (error.kind === 'credentials') return { outcome: 'failed', code: 'CREDENTIALS' };
    return { outcome: 'ambiguous', kind: error.kind };
  }
  return { outcome: 'ambiguous', kind: 'unavailable' };
};

export async function runEInvoiceIssue(deps: EInvoiceIssueDeps, job: EInvoiceIssueJob): Promise<{ action: string; state: string }> {
  const options = { actor: SYSTEM, orgId: job.orgId };
  const begun = await deps.runtime.execute<Begun>('finance.einvoice.job_begin', { draftId: job.draftId }, options);
  if (begun.action === 'none') return { action: 'none', state: begun.reason ?? 'none' };
  const { action, connectionId, adapter, key, request, draftId, legalEntityId } = begun as Omit<Required<Begun>, 'reason' | 'action'> & { action: 'issue' | 'ask' | 'poll' | 'files' };
  // The adapter switched off on this deployment: nothing is sent; the call stays as it was and a later job asks first.
  if (!Object.hasOwn(deps.providers, adapter)) return { action, state: 'provider_off' };
  const provider = deps.providers[adapter] as EInvoiceProvider;
  const record = (step: 'issue' | 'ask' | 'poll', result: Result) => deps.runtime.execute<Recorded>('finance.einvoice.job_record', { draftId, step, result }, options);

  // The credential: the offline provider has none; a real one is opened here from the sealed copy, and refused once the member who connected it may no longer use it.
  let secret: string;
  if (provider.hosts.length === 0) {
    secret = SANDBOX_EINVOICE_SECRET;
  } else {
    try {
      const sealed = await deps.runtime.query<SealedChannelCredential>('kernel.channel.credential', { connectionId }, options);
      secret = String(deps.broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, { orgId: job.orgId, provider: sealed.provider, externalAccountId: sealed.externalAccountId }));
    } catch (error) {
      if (error instanceof DomainError && (error.code === 'CHANNEL_OWNER_LEFT' || error.code === 'CHANNEL_NOT_ACTIVE')) {
        if (error.code === 'CHANNEL_OWNER_LEFT') await deps.runtime.execute('kernel.channel.mark_expired', { connectionId, reason: 'owner_left' }, options);
        if (action !== 'files') await record(action, { outcome: 'failed', code: 'CREDENTIALS' });
        return { action, state: 'credentials' };
      }
      throw error;
    }
  }

  let state = action === 'files' ? 'issued' : 'unchanged';
  let issued: { ref: string; number: string } | null = action === 'files' ? { ref: begun.ref ?? '', number: '' } : null;
  // The step whose call is in flight, so an error is recorded against the right call (after a not-found answer the call in flight is the send).
  let step: 'issue' | 'ask' | 'poll' = action === 'files' ? 'poll' : action;
  const settle = async (at: 'issue' | 'ask' | 'poll', result: Result) => {
    const done = await record(at, result);
    state = done.state;
    if (result.outcome === 'issued' && done.state === 'issued') issued = { ref: result.ref, number: result.number };
    return done;
  };

  try {
    if (action === 'issue') {
      await settle('issue', fromOutcome(await provider.issue(secret, request)));
    } else if (action === 'ask') {
      step = 'ask';
      // The send was started and never answered: the provider is asked for the key before anything is sent again.
      const answer: EInvoiceStatusAnswer = await provider.status(secret, { key, ref: begun.ref ?? null });
      if (answer.state === 'unknown') {
        const done = await record('ask', { outcome: 'not_found' });
        state = done.state;
        // Nothing was ever made under the key: the same request goes out now, as a new call on the same key.
        if (done.resend) {
          step = 'issue';
          await settle('issue', fromOutcome(await provider.issue(secret, done.resend)));
        }
      } else {
        await settle('ask', fromOutcome(answer));
      }
    } else if (action === 'poll') {
      const answer = await provider.status(secret, { key, ref: begun.ref ?? null });
      // Still pending (or an answer the adapter cannot map) is the same for a poll: ask again later, until the day ends.
      await settle('poll', answer.state === 'unknown' || answer.state === 'pending' ? { outcome: 'still_pending' } : fromOutcome(answer));
    }
  } catch (error) {
    // A step that failed after its call was committed is recorded: refused credentials end it, anything else leaves it for the next try to ask about.
    if (action !== 'files') {
      const done = await record(step, fromError(error));
      state = done.state;
    }
    console.warn(`[einvoice] draft ${draftId.slice(0, 8)} ${action}: ${error instanceof EInvoiceProviderError ? error.kind : 'error'}`);
    if (!(error instanceof EInvoiceProviderError)) throw error;
  }

  if (state === 'issued' && issued) await storeEvidence(deps, { draftId, legalEntityId, ref: issued.ref, provider, secret, options });
  return { action, state };
}

// The signed XML (the original of the invoice) and the PDF (a copy to show) fetched from the provider, stored as evidence and linked to the draft once. The XML goes through the
// ordinary intake naming the draft's entity, so the sale is read, checked and proposed like any other invoice. The PDF is stored for display and never read.
async function storeEvidence(
  deps: EInvoiceIssueDeps,
  at: { draftId: string; legalEntityId: string; ref: string; provider: EInvoiceProvider; secret: string; options: { actor: typeof SYSTEM; orgId: string } },
): Promise<void> {
  const { draftId, options } = at;
  const begin = await deps.runtime.execute<{ ok: boolean; ref: string | null }>('finance.einvoice.job_files', { draftId, step: { kind: 'begin' } }, options);
  if (!begin.ok) return;
  let files;
  try {
    files = await at.provider.files(at.secret, begin.ref ?? at.ref);
  } catch (error) {
    await deps.runtime.execute('finance.einvoice.job_files', { draftId, step: { kind: 'failed' } }, options);
    console.warn(`[einvoice] draft ${draftId.slice(0, 8)} files: ${error instanceof EInvoiceProviderError ? error.kind : 'error'}`);
    return;
  }
  const store = async (bytes: Uint8Array, contentType: string, filename: string, source: 'upload' | 'import', legalEntityId?: string) => {
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(options.orgId, sha256);
    const generation = await putFile(deps.store, storageKey, bytes, contentType, sha256);
    const { fileId } = await deps.runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename, contentType, sizeBytes: bytes.byteLength, sha256, storageKey, generation, source, ...(legalEntityId ? { legalEntityId } : {}) },
      options,
    );
    return fileId;
  };
  const stem = `hoa-don-${draftId.slice(0, 8)}`;
  const signedFileId = await store(files.xml, 'application/xml', `${stem}.xml`, 'upload', at.legalEntityId);
  const pdfFileId = files.pdf ? await store(files.pdf, 'application/pdf', `${stem}.pdf`, 'import') : null;
  await deps.runtime.execute('finance.einvoice.job_files', { draftId, step: { kind: 'stored', signedFileId, pdfFileId } }, options);
}
