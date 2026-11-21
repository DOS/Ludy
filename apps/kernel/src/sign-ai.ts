// SPDX-License-Identifier: AGPL-3.0-only
// Kernel orchestration for Vy on eSign (#3351):
// 1. Reads envelope layout, SHA-256, and declared signer role keys in the caller's own transaction (sign.ai_analysis.source;
//    never reads signer emails or raw secrets).
// 2. Runs Vy outside any database transaction through the AI budget meter (metered 'sign.field_propose' and 'sign.clause_summary'
//    inside withAiScope).
// 3. Writes sanitized proposals strictly through Runtime.execute('sign.envelope.propose_fields' | 'sign.ai_analysis.record')
//    so persistence and tenancy enforcement stay inside the sign module.
// When AI is off, unconfigured, busy, not inspected, or AiBudgetExhaustedError fires, returns a structured status cleanly so
// core manual envelope creation, field placement, and sending keep working identically. Failures log codes only, never PDF text.
import {
  AiBudgetExhaustedError,
  AiMeterMissingError,
  SIGN_AI_PROMPT_VERSION,
  withAiScope,
  type AiMeter,
  type SignAiPageInput,
  type SignAiReader,
  type SignClauseSummaryResult,
  type SignFieldProposeResult,
} from '@crove/agent';
import type {
  SignEnvelopeObligationRecordContract,
  SignObligationAiOutcome,
} from '@crove/kernel-contract';
import {
  DomainError,
  type Actor,
  type Runtime,
  type SystemActor,
  type UserActor,
} from '@crove/kernel-runtime';
import type {
  SignAiAnalysisRecord,
  SignAiExtractedPage,
  SignAiProposedField,
  SignAiRiskClause,
  SignAiSource,
  SignObligationSource,
} from '@crove/mod-sign';
import type { DraftBudget } from './ai-draft-limit.ts';
import { memberMeter, systemMeter, type MeterOptions } from './ai-meter.ts';

export type SignAiReaderPort = Pick<SignAiReader, 'proposeFields' | 'summarizeRiskClauses'> &
  Partial<Pick<SignAiReader, 'extractObligations'>>;

export interface SignAi {
  reader: SignAiReaderPort | null;
  budget: DraftBudget;
  obligationBudget?: DraftBudget;
}

export function signAi(
  reader: SignAi['reader'],
  budget: DraftBudget,
  obligationBudget?: DraftBudget,
): SignAi {
  return {
    reader,
    budget,
    ...(obligationBudget ? { obligationBudget } : {}),
  };
}

export type SignAiOutcomeState = 'used' | 'off' | 'budget' | 'busy' | 'not_ready' | 'not_draft' | 'no_text' | 'failed';

export interface SignAiOutcome {
  ai: SignAiOutcomeState;
  status: 'completed' | 'off' | 'budget' | 'busy' | 'not_ready' | 'not_draft' | 'no_text' | 'failed';
  analysis: SignAiAnalysisRecord | null;
  proposedFields: SignAiProposedField[];
  riskClauses: SignAiRiskClause[];
  summaryText: string | null;
}

export interface ProposeEnvelopeAnalysisParams {
  ai: SignAi;
  runtime: Pick<Runtime, 'execute' | 'query'>;
  orgId: string;
  actor: UserActor | SystemActor;
  envelopeId: string;
  pages?: readonly SignAiPageInput[];
  inspectPages?: (source: SignAiSource) => Promise<readonly SignAiPageInput[]>;
  meter: AiMeter | 'runtime';
  meterOptions?: MeterOptions;
  promptVersion?: string;
}

class SignAiStoppedError extends Error {
  constructor() {
    super('AI kill switch is active');
    this.name = 'SignAiStoppedError';
  }
}

function emptyOutcome(
  ai: SignAiOutcomeState,
  analysis: SignAiAnalysisRecord | null = null,
): SignAiOutcome {
  return {
    ai,
    status: ai === 'used' ? 'completed' : ai,
    analysis,
    proposedFields: analysis?.proposedFields ?? [],
    riskClauses: analysis?.riskClauses ?? [],
    summaryText: analysis?.summaryText ?? null,
  };
}

function failedOutcome(existing: SignAiAnalysisRecord | null): SignAiOutcome {
  return {
    ai: 'failed',
    status: existing?.status === 'completed' ? 'completed' : 'failed',
    analysis: existing,
    proposedFields: existing?.proposedFields ?? [],
    riskClauses: existing?.riskClauses ?? [],
    summaryText: existing?.summaryText ?? null,
  };
}

function actorRateKey(actor: UserActor | SystemActor): string {
  return actor.type === 'user' ? actor.userId : `system:${actor.component}`;
}

export async function getEnvelopeAiAnalysis(
  runtime: Pick<Runtime, 'query'>,
  envelopeId: string,
  options: { actor: Actor; orgId: string },
): Promise<{ analysis: SignAiAnalysisRecord | null }> {
  const analysis = await runtime.query<SignAiAnalysisRecord | null>(
    'sign.ai_analysis.get',
    { envelopeId },
    options,
  );
  return { analysis };
}

export async function proposeEnvelopeAnalysis(params: ProposeEnvelopeAnalysisParams): Promise<SignAiOutcome> {
  const { ai, runtime, orgId, actor, envelopeId } = params;
  if (actor.type !== 'user' && actor.type !== 'system') {
    throw new DomainError('FORBIDDEN', 403, 'Only workspace members or system workers can run eSign AI analysis');
  }
  const source = await runtime.query<SignAiSource>('sign.ai_analysis.source', { envelopeId }, { actor, orgId });

  const safeExisting = async (): Promise<SignAiAnalysisRecord | null> => {
    try {
      return (await getEnvelopeAiAnalysis(runtime, envelopeId, { actor, orgId })).analysis;
    } catch {
      return null;
    }
  };

  if (!ai.reader || source.aiStopped) {
    return emptyOutcome('off', await safeExisting());
  }
  if (actor.type === 'user' && source.status !== 'draft') {
    return emptyOutcome('not_draft', await safeExisting());
  }
  if (source.inspectStatus !== 'passed' || !source.pageCount || source.pageCount < 1) {
    return emptyOutcome('not_ready');
  }
  if (
    params.pages &&
    params.pages
      .filter((p) => Number.isInteger(p.page) && p.page >= 1 && p.page <= (source.pageCount ?? 0))
      .every((p) => p.text.trim().length === 0)
  ) {
    return emptyOutcome('no_text');
  }
  if (!params.pages && !params.inspectPages) {
    return emptyOutcome('no_text');
  }

  const ticket = ai.budget.take(orgId, actorRateKey(actor));
  if (!ticket.allowed) {
    return emptyOutcome('busy', await safeExisting());
  }

  const commandName = actor.type === 'user' ? 'sign.envelope.propose_fields' : 'sign.ai_analysis.record';
  const promptVersion = params.promptVersion ?? SIGN_AI_PROMPT_VERSION;

  const isAiStopped = async (): Promise<boolean> => {
    const latest = await runtime.query<SignAiSource>('sign.ai_analysis.source', { envelopeId }, { actor, orgId });
    return latest.aiStopped;
  };

  const recordFailure = async (errorMessage: string): Promise<void> => {
    try {
      await runtime.execute(
        commandName,
        {
          envelopeId,
          sourceSha256: source.sourceSha256,
          expectedVersion: source.version,
          status: 'failed',
          proposedFields: [],
          riskClauses: [],
          summaryText: null,
          errorMessage,
          promptVersion,
        },
        { actor, orgId },
      );
    } catch {
      // Preserve clean degradation even if persisting failure status encounters a version or state conflict.
    }
  };

  const runScoped = async <T>(fn: () => Promise<T>): Promise<T> => {
    const baseMeter =
      params.meter === 'runtime'
        ? actor.type === 'user'
          ? memberMeter(runtime as Runtime, actor, params.meterOptions ?? {})
          : systemMeter(runtime as Runtime, params.meterOptions ?? {})
        : params.meter;
    const guardedMeter: AiMeter = {
      admit: async (call) => {
        if (await isAiStopped()) {
          throw new SignAiStoppedError();
        }
        return baseMeter.admit(call);
      },
      record: (call, usage) => baseMeter.record(call, usage),
    };
    return withAiScope({ orgId, meter: guardedMeter }, fn);
  };

  try {
    const pageCount = source.pageCount;
    const rawPages = params.pages ?? (params.inspectPages ? await params.inspectPages(source) : []);
    const extractedPages: SignAiExtractedPage[] = rawPages
      .filter((p) => Number.isInteger(p.page) && p.page >= 1 && p.page <= pageCount)
      .map((p) => ({ page: p.page, text: p.text }));
    if (extractedPages.every((p) => p.text.trim().length === 0)) {
      return emptyOutcome('no_text');
    }
    const reader = ai.reader;
    const dimsByPage = new Map((source.pageDimensions ?? []).map((d) => [d.page, d]));
    const pagesWithDims: SignAiPageInput[] = rawPages
      .filter((p) => Number.isInteger(p.page) && p.page >= 1 && p.page <= pageCount)
      .map((p) => {
        const dims = dimsByPage.get(p.page);
        return {
          page: p.page,
          text: p.text,
          ...(dims ? { widthPt: dims.widthPt, heightPt: dims.heightPt } : {}),
        };
      });

    const { fieldResult, clauseResult, budgetPartial } = await runScoped(async () => {
      const fResult: SignFieldProposeResult =
        source.signers.length > 0
          ? await reader.proposeFields({
              envelopeTitle: source.title,
              pageCount,
              pages: pagesWithDims,
              signerRoles: source.signers.map((s) => ({
                roleKey: s.roleKey,
                roleLabel: s.roleLabel,
                signerRole: s.signerRole,
                routingOrder: s.routingOrder,
              })),
            })
          : { kind: 'none', code: 'NO_SIGNERS', fields: [], droppedCount: 0 };

      if (await isAiStopped()) {
        throw new SignAiStoppedError();
      }
      try {
        const cResult: SignClauseSummaryResult = await reader.summarizeRiskClauses({
          envelopeTitle: source.title,
          pageCount,
          pages: pagesWithDims,
        });
        return { fieldResult: fResult, clauseResult: cResult, budgetPartial: false };
      } catch (err: unknown) {
        if (err instanceof AiBudgetExhaustedError && fResult.kind === 'proposals' && fResult.fields.length > 0) {
          const prior = await safeExisting();
          const keepPriorClauses =
            prior !== null && prior.status === 'completed' && prior.sourceSha256 === source.sourceSha256;
          return {
            fieldResult: fResult,
            clauseResult: {
              kind: 'none',
              code: 'EMPTY',
              summaryText: keepPriorClauses ? prior.summaryText : null,
              riskClauses: keepPriorClauses ? prior.riskClauses : [],
              droppedClauseCount: 0,
              summaryDropped: false,
            } satisfies SignClauseSummaryResult,
            budgetPartial: true,
          };
        }
        throw err;
      }
    });

    if (await isAiStopped()) {
      throw new SignAiStoppedError();
    }

    const signerIdByRoleKey = new Map(source.signers.map((s) => [s.roleKey, s.signerId]));
    const mappedFields = fieldResult.fields.map((f) => ({
      ...f,
      ...(signerIdByRoleKey.has(f.signerRoleKey) ? { signerId: signerIdByRoleKey.get(f.signerRoleKey) } : {}),
    }));

    const hasAnyOutput =
      mappedFields.length > 0 || clauseResult.riskClauses.length > 0 || clauseResult.summaryText !== null;
    if (!hasAnyOutput && (clauseResult.code === 'REFUSED' || fieldResult.droppedCount > 0)) {
      await recordFailure('AI_OUTPUT_REFUSED');
      return failedOutcome(await safeExisting());
    }

    const saved = await runtime.execute<SignAiAnalysisRecord>(
      commandName,
      {
        envelopeId,
        sourceSha256: source.sourceSha256,
        expectedVersion: source.version,
        status: 'completed',
        proposedFields: mappedFields,
        riskClauses: clauseResult.riskClauses,
        summaryText: clauseResult.summaryText,
        errorMessage: null,
        promptVersion,
        extractedPages,
      },
      { actor, orgId },
    );

    return {
      ai: budgetPartial ? 'budget' : 'used',
      status: saved.status === 'failed' ? 'failed' : 'completed',
      analysis: saved,
      proposedFields: saved.proposedFields,
      riskClauses: saved.riskClauses,
      summaryText: saved.summaryText,
    };
  } catch (error: unknown) {
    if (error instanceof SignAiStoppedError) {
      return emptyOutcome('off', await safeExisting());
    }
    if (error instanceof AiBudgetExhaustedError) {
      return emptyOutcome('budget', await safeExisting());
    }
    if (error instanceof AiMeterMissingError) {
      throw error;
    }
    if (error instanceof DomainError && (error.status === 403 || error.status === 404)) {
      throw error;
    }
    if (error instanceof DomainError && error.status === 409) {
      const existing = await safeExisting();
      if (error.code === 'SIGN_ENVELOPE_NOT_DRAFT') return emptyOutcome('not_draft', existing);
      if (error.code === 'SIGN_AI_STOPPED') return emptyOutcome('off', existing);
      return failedOutcome(existing);
    }
    console.error('[sign-ai] analysis failed', error instanceof Error ? error.name : typeof error);
    await recordFailure(error instanceof Error ? error.name : 'AI_ANALYSIS_FAILED');
    return failedOutcome(await safeExisting());
  } finally {
    ticket.release();
  }
}

export interface SignObligationExtractOutcome {
  ai: SignObligationAiOutcome;
  status:
    | 'proposed'
    | 'confirmed'
    | 'off'
    | 'budget'
    | 'busy'
    | 'not_ready'
    | 'not_completed'
    | 'no_text'
    | 'empty'
    | 'failed';
  obligation: SignEnvelopeObligationRecordContract | null;
}

export interface ProposeEnvelopeObligationsParams {
  ai: SignAi;
  runtime: Pick<Runtime, 'execute' | 'query'>;
  orgId: string;
  actor: UserActor | SystemActor;
  envelopeId: string;
  pages?: readonly SignAiPageInput[];
  inspectPages?: (source: SignObligationSource) => Promise<readonly SignAiPageInput[]>;
  meter: AiMeter | 'runtime';
  meterOptions?: MeterOptions;
  promptVersion?: string;
}

function obligationOutcome(
  ai: Exclude<SignObligationAiOutcome, 'used'>,
  existing: SignEnvelopeObligationRecordContract | null = null,
): SignObligationExtractOutcome {
  return {
    ai,
    status: ai,
    obligation: existing,
  };
}

export async function proposeEnvelopeObligations(
  params: ProposeEnvelopeObligationsParams,
): Promise<SignObligationExtractOutcome> {
  const { ai, runtime, orgId, actor, envelopeId } = params;
  if (actor.type !== 'user' && actor.type !== 'system') {
    throw new DomainError('FORBIDDEN', 403, 'Only workspace members or system workers can extract contract obligations');
  }

  const source = await runtime.query<SignObligationSource>(
    'sign.obligation.source',
    { envelopeId },
    { actor, orgId },
  );

  const safeExisting = async (): Promise<SignEnvelopeObligationRecordContract | null> => {
    try {
      const res = await runtime.query<{ obligation: SignEnvelopeObligationRecordContract | null }>(
        'sign.obligation.get',
        { envelopeId },
        { actor, orgId },
      );
      return res.obligation;
    } catch {
      return null;
    }
  };

  if (!ai.reader?.extractObligations || source.aiStopped) {
    return obligationOutcome('off', await safeExisting());
  }
  if (source.status !== 'completed') {
    return obligationOutcome('not_completed', await safeExisting());
  }
  if (source.inspectStatus !== 'passed' || !source.pageCount || source.pageCount < 1) {
    return obligationOutcome('not_ready', await safeExisting());
  }
  if (
    params.pages &&
    params.pages
      .filter((p) => Number.isInteger(p.page) && p.page >= 1 && p.page <= (source.pageCount ?? 0))
      .every((p) => p.text.trim().length === 0)
  ) {
    return obligationOutcome('no_text', await safeExisting());
  }
  if (!params.pages && !params.inspectPages) {
    return obligationOutcome('no_text', await safeExisting());
  }

  const rateBudget = ai.obligationBudget ?? ai.budget;
  const ticket = rateBudget.take(orgId, actorRateKey(actor));
  if (!ticket.allowed) {
    return obligationOutcome('busy', await safeExisting());
  }

  const promptVersion = params.promptVersion ?? SIGN_AI_PROMPT_VERSION;
  const extractObligations = ai.reader.extractObligations.bind(ai.reader);

  const isAiStopped = async (): Promise<boolean> => {
    const latest = await runtime.query<SignObligationSource>(
      'sign.obligation.source',
      { envelopeId },
      { actor, orgId },
    );
    return latest.aiStopped;
  };

  const runScoped = async <T>(fn: () => Promise<T>): Promise<T> => {
    const baseMeter =
      params.meter === 'runtime'
        ? actor.type === 'user'
          ? memberMeter(runtime as Runtime, actor, params.meterOptions ?? {})
          : systemMeter(runtime as Runtime, params.meterOptions ?? {})
        : params.meter;
    const guardedMeter: AiMeter = {
      admit: async (call) => {
        if (await isAiStopped()) {
          throw new SignAiStoppedError();
        }
        return baseMeter.admit(call);
      },
      record: (call, usage) => baseMeter.record(call, usage),
    };
    return withAiScope({ orgId, meter: guardedMeter }, fn);
  };

  try {
    const pageCount = source.pageCount;
    const rawPages = params.pages ?? (params.inspectPages ? await params.inspectPages(source) : []);
    const extractedPages: SignAiExtractedPage[] = rawPages
      .filter((p) => Number.isInteger(p.page) && p.page >= 1 && p.page <= pageCount)
      .map((p) => ({ page: p.page, text: p.text }));
    if (extractedPages.every((p) => p.text.trim().length === 0)) {
      return obligationOutcome('no_text', await safeExisting());
    }

    const extractResult = await runScoped(() =>
      extractObligations({
        envelopeTitle: source.title,
        pageCount,
        pages: extractedPages,
      }),
    );

    if (await isAiStopped()) {
      throw new SignAiStoppedError();
    }

    if (extractResult.kind === 'none' || !extractResult.proposal) {
      return obligationOutcome(
        extractResult.code === 'REFUSED' ? 'failed' : 'empty',
        await safeExisting(),
      );
    }

    const saved = await runtime.execute<SignEnvelopeObligationRecordContract>(
      'sign.obligation.propose',
      {
        envelopeId,
        promptVersion,
        proposal: extractResult.proposal,
        extractedPages,
      },
      { actor, orgId },
    );

    return {
      ai: 'used',
      status: saved.status === 'confirmed' ? 'confirmed' : 'proposed',
      obligation: saved,
    };
  } catch (error: unknown) {
    if (error instanceof SignAiStoppedError) {
      return obligationOutcome('off', await safeExisting());
    }
    if (error instanceof AiBudgetExhaustedError) {
      return obligationOutcome('budget', await safeExisting());
    }
    if (error instanceof AiMeterMissingError) {
      throw error;
    }
    if (error instanceof DomainError && (error.status === 403 || error.status === 404)) {
      throw error;
    }
    if (error instanceof DomainError && error.code === 'SIGN_OBLIGATION_ENVELOPE_NOT_COMPLETED') {
      return obligationOutcome('not_completed', await safeExisting());
    }
    console.error('[sign-ai] obligation extraction failed', error instanceof Error ? error.name : typeof error);
    return obligationOutcome('failed', await safeExisting());
  } finally {
    ticket.release();
  }
}
