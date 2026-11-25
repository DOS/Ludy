// SPDX-License-Identifier: AGPL-3.0-only
// Kernel orchestration for Vy on eSign (#3351, #3821, #3822):
// 1. Reads envelope layout, SHA-256, and declared signer role keys in the caller's own transaction (sign.ai_analysis.source;
//    never reads signer emails or raw secrets).
// 2. Runs Vy outside any database transaction through the AI budget meter (metered 'sign.field_propose', 'sign.clause_summary',
//    'sign.version_diff', 'sign.contract_draft', and 'sign.obligation_extract' inside withAiScope).
// 3. Writes sanitized proposals strictly through Runtime.execute('sign.envelope.propose_fields' | 'sign.ai_analysis.record' |
//    'sign.obligation.propose') so persistence and tenancy enforcement stay inside the sign module.
// When AI is off, unconfigured, busy, not inspected, or AiBudgetExhaustedError fires, returns a structured status cleanly so
// core manual envelope creation, field placement, and sending keep working identically. Failures log codes only, never PDF text.
import {
  AiBudgetExhaustedError,
  AiMeterMissingError,
  SIGN_AI_PROMPT_VERSION,
  SIGN_PLAYBOOK_CHECK_PROMPT_VERSION,
  withAiScope,
  type AiMeter,
  type SignAiPageInput,
  type SignAiReader,
  type SignClauseSummaryResult,
  type SignFieldProposeResult,
  type SignPacketConsistencyDocumentInput,
} from '@ludy/agent';
import {
  SIGN_PLAYBOOK_MAX_TOTAL_CHARS,
  type SignDiffCompareInput,
  type SignDiffCompareResult,
  type SignDrafterProposeInput,
  type SignDrafterProposeResult,
  type SignEnvelopeObligationRecordContract,
  type SignEnvelopePlaybookCheckRecord,
  type SignKycAiOutcomeContract,
  type SignKycAnalyzeResult,
  type SignKycCheckRecordContract,
  type SignKycListResultContract,
  type SignObligationAiOutcome,
  type SignPacketConsistencyCheckInput,
  type SignPacketConsistencyCheckResult,
  type SignPacketConsistencyFinding,
  type SignPlaybookAiOutcome,
  type SignPlaybookEvaluateResult,
  type SignVaultAskInput,
  type SignVaultAskResult,
  type SignVaultSearchResult,
} from '@ludy/kernel-contract';
import {
  DomainError,
  type Actor,
  type Runtime,
  type SystemActor,
  type UserActor,
} from '@ludy/kernel-runtime';
import { Decimal, money } from '@ludy/l10n-vn';
import {
  computeSignVersionDiff,
  type SignAiAnalysisRecord,
  type SignAiExtractedPage,
  type SignAiProposedField,
  type SignAiRiskClause,
  type SignAiSource,
  type SignDiffSourceResult,
  type SignKycSource,
  type SignObligationSource,
  type SignPacketConsistencySource,
  type SignPlaybookSource,
} from '@ludy/mod-sign';
import type { DraftBudget } from './ai-draft-limit.ts';
import { guardAiMeter, memberMeter, systemMeter, type MeterOptions } from './ai-meter.ts';

export type SignAiReaderPort = Pick<SignAiReader, 'proposeFields' | 'summarizeRiskClauses'> &
  Partial<
    Pick<
      SignAiReader,
      'summarizeVersionDiff'
      | 'proposeContractClauses'
      | 'extractObligations'
      | 'answerVaultQuestion'
      | 'checkPlaybook'
      | 'checkKycAttachment'
      | 'checkPacketConsistency'
    >
  >;

export interface SignAi {
  reader: SignAiReaderPort | null;
  budget: DraftBudget;
  obligationBudget?: DraftBudget;
  kycBudget?: DraftBudget;
}

export function signAi(
  reader: SignAi['reader'],
  budget: DraftBudget,
  obligationBudget?: DraftBudget,
  kycBudget?: DraftBudget,
): SignAi {
  return {
    reader,
    budget,
    ...(obligationBudget ? { obligationBudget } : {}),
    ...(kycBudget ? { kycBudget } : {}),
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
  expectedSourceSha256?: string;
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
  if (
    params.expectedSourceSha256 &&
    params.expectedSourceSha256.toLowerCase() !== source.sourceSha256.toLowerCase()
  ) {
    throw new DomainError(
      'SIGN_PRIMARY_DOC_CHANGED',
      409,
      'Primary envelope document changed before analysis ran; refresh and try again.',
    );
  }

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
    const guardedMeter = guardAiMeter(baseMeter, {
      isStopped: isAiStopped,
      stoppedError: () => new SignAiStoppedError(),
    });
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

export interface CompareSignPdfVersionsParams {
  ai: SignAi;
  runtime: Pick<Runtime, 'query'>;
  orgId: string;
  actor: UserActor;
  input: SignDiffCompareInput;
  meter: AiMeter | 'runtime';
  meterOptions?: MeterOptions;
}

export async function compareSignPdfVersions(params: CompareSignPdfVersionsParams): Promise<SignDiffCompareResult> {
  const { ai, runtime, orgId, actor, input } = params;
  const source = await runtime.query<SignDiffSourceResult>(
    'sign.diff.source',
    {
      ...(input.fileIdV1 ? { fileIdV1: input.fileIdV1 } : {}),
      ...(input.fileIdV2 ? { fileIdV2: input.fileIdV2 } : {}),
    },
    { actor, orgId },
  );

  // Deterministic diff runs unconditionally so contract comparison works 100% identically when AI is off or over budget.
  const diff = computeSignVersionDiff(input.pagesV1, input.pagesV2);

  if (!input.includeAi || !ai.reader?.summarizeVersionDiff || source.aiStopped) {
    return { diff, ai: 'off', summaryText: null, riskDeltas: [] };
  }

  const hasText =
    input.pagesV1.some((p) => p.text.trim().length > 0) || input.pagesV2.some((p) => p.text.trim().length > 0);
  if (!hasText) {
    return { diff, ai: 'no_text', summaryText: null, riskDeltas: [] };
  }
  if (diff.stats.identical) {
    return { diff, ai: 'no_changes', summaryText: null, riskDeltas: [] };
  }

  const ticket = ai.budget.take(orgId, actorRateKey(actor));
  if (!ticket.allowed) {
    return { diff, ai: 'busy', summaryText: null, riskDeltas: [] };
  }

  const isAiStopped = async (): Promise<boolean> => {
    const latest = await runtime.query<SignDiffSourceResult>('sign.diff.source', {}, { actor, orgId });
    return latest.aiStopped;
  };

  const baseMeter =
    params.meter === 'runtime'
      ? memberMeter(runtime as Runtime, actor, params.meterOptions ?? {})
      : params.meter;
  const guardedMeter = guardAiMeter(baseMeter, {
    isStopped: isAiStopped,
    stoppedError: () => new SignAiStoppedError(),
  });

  try {
    const changedHunks = diff.hunks
      .filter((h): h is typeof h & { kind: 'added' | 'removed' | 'modified' } => h.kind !== 'unchanged')
      .map((h) => ({
        index: h.index,
        kind: h.kind,
        pageV1: h.pageV1,
        pageV2: h.pageV2,
        beforeText: h.beforeText,
        afterText: h.afterText,
      }));

    const summarize = ai.reader.summarizeVersionDiff.bind(ai.reader);
    const aiRes = await withAiScope({ orgId, meter: guardedMeter }, () =>
      summarize({
        ...(input.titleV1 ? { titleV1: input.titleV1 } : {}),
        ...(input.titleV2 ? { titleV2: input.titleV2 } : {}),
        pageCountV1: Math.max(1, diff.pageCountV1),
        pageCountV2: Math.max(1, diff.pageCountV2),
        pagesV1: input.pagesV1,
        pagesV2: input.pagesV2,
        changedHunks,
      }),
    );

    if (await isAiStopped()) {
      return { diff, ai: 'off', summaryText: null, riskDeltas: [] };
    }
    if (aiRes.kind === 'none') {
      return {
        diff,
        ai: aiRes.code === 'REFUSED' ? 'failed' : 'used',
        summaryText: null,
        riskDeltas: [],
      };
    }

    return {
      diff,
      ai: 'used',
      summaryText: aiRes.summaryText,
      riskDeltas: aiRes.riskDeltas,
    };
  } catch (error: unknown) {
    if (error instanceof SignAiStoppedError) {
      return { diff, ai: 'off', summaryText: null, riskDeltas: [] };
    }
    if (error instanceof AiBudgetExhaustedError) {
      return { diff, ai: 'budget', summaryText: null, riskDeltas: [] };
    }
    if (error instanceof AiMeterMissingError) {
      throw error;
    }
    if (error instanceof DomainError && (error.status === 403 || error.status === 404)) {
      throw error;
    }
    console.error('[sign-ai] version diff summary failed', error instanceof Error ? error.name : typeof error);
    return { diff, ai: 'failed', summaryText: null, riskDeltas: [] };
  } finally {
    ticket.release();
  }
}

export interface ProposeSignContractDraftParams {
  ai: SignAi;
  runtime: Pick<Runtime, 'query'>;
  orgId: string;
  actor: UserActor;
  input: SignDrafterProposeInput;
  meter: AiMeter | 'runtime';
  meterOptions?: MeterOptions;
}

export async function proposeSignContractDraftClauses(
  params: ProposeSignContractDraftParams,
): Promise<SignDrafterProposeResult> {
  const { ai, runtime, orgId, actor, input } = params;
  const source = await runtime.query<{ aiStopped: boolean }>('sign.drafter.ai_source', {}, { actor, orgId });

  const normalizedValue = input.variables.contractValue
    ? money(input.variables.contractValue).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed()
    : null;

  if (!ai.reader?.proposeContractClauses || source.aiStopped) {
    return { ai: 'off', summaryNote: null, proposedClauses: [] };
  }

  const ticket = ai.budget.take(orgId, actorRateKey(actor));
  if (!ticket.allowed) {
    return { ai: 'busy', summaryNote: null, proposedClauses: [] };
  }

  const isAiStopped = async (): Promise<boolean> => {
    const latest = await runtime.query<{ aiStopped: boolean }>('sign.drafter.ai_source', {}, { actor, orgId });
    return latest.aiStopped;
  };

  const baseMeter =
    params.meter === 'runtime'
      ? memberMeter(runtime as Runtime, actor, params.meterOptions ?? {})
      : params.meter;
  const guardedMeter = guardAiMeter(baseMeter, {
    isStopped: isAiStopped,
    stoppedError: () => new SignAiStoppedError(),
  });

  try {
    const propose = ai.reader.proposeContractClauses.bind(ai.reader);
    const aiRes = await withAiScope({ orgId, meter: guardedMeter }, () =>
      propose({
        templateKind: input.variables.templateKind,
        partyAName: input.variables.partyA.name,
        partyBName: input.variables.partyB.name,
        scopeSummary: input.variables.scopeSummary,
        contractValue: normalizedValue,
        currency: input.variables.currency,
        effectiveDate: input.variables.effectiveDate,
        expiryDate: input.variables.expiryDate ?? null,
        instructions: input.instructions,
      }),
    );

    if (await isAiStopped()) {
      return { ai: 'off', summaryNote: null, proposedClauses: [] };
    }
    if (aiRes.kind === 'none') {
      return {
        ai: aiRes.code === 'REFUSED' ? 'failed' : 'used',
        summaryNote: null,
        proposedClauses: [],
      };
    }

    return {
      ai: 'used',
      summaryNote: aiRes.summaryNote,
      proposedClauses: aiRes.proposedClauses,
    };
  } catch (error: unknown) {
    if (error instanceof SignAiStoppedError) {
      return { ai: 'off', summaryNote: null, proposedClauses: [] };
    }
    if (error instanceof AiBudgetExhaustedError) {
      return { ai: 'budget', summaryNote: null, proposedClauses: [] };
    }
    if (error instanceof AiMeterMissingError) {
      throw error;
    }
    if (error instanceof DomainError && (error.status === 403 || error.status === 404)) {
      throw error;
    }
    console.error('[sign-ai] contract draft proposal failed', error instanceof Error ? error.name : typeof error);
    return { ai: 'failed', summaryNote: null, proposedClauses: [] };
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
    const guardedMeter = guardAiMeter(baseMeter, {
      isStopped: isAiStopped,
      stoppedError: () => new SignAiStoppedError(),
    });
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

export interface AskSignVaultParams {
  ai: SignAi;
  runtime: Pick<Runtime, 'execute' | 'query'>;
  orgId: string;
  actor: UserActor;
  input: SignVaultAskInput;
  meter: AiMeter | 'runtime';
  meterOptions?: MeterOptions;
}

export async function askSignVault(params: AskSignVaultParams): Promise<SignVaultAskResult> {
  const { ai, runtime, orgId, actor, input } = params;
  const aiSource = await runtime.query<{ aiStopped: boolean }>('sign.drafter.ai_source', {}, { actor, orgId });

  const searchRes = await runtime.query<SignVaultSearchResult>(
    'sign.vault.search',
    {
      question: input.question,
      ...(input.status !== undefined ? { status: input.status } : {}),
      limit: input.limit ?? 12,
    },
    { actor, orgId },
  );

  const items = searchRes.items;
  if (items.length === 0) {
    return { ai: 'no_matches', items: [], summary: null };
  }

  if (!ai.reader?.answerVaultQuestion || aiSource.aiStopped) {
    return { ai: 'off', items, summary: null };
  }

  const ticket = ai.budget.take(orgId, actorRateKey(actor));
  if (!ticket.allowed) {
    return { ai: 'busy', items, summary: null };
  }

  const isAiStopped = async (): Promise<boolean> => {
    const latest = await runtime.query<{ aiStopped: boolean }>('sign.drafter.ai_source', {}, { actor, orgId });
    return latest.aiStopped;
  };

  const baseMeter =
    params.meter === 'runtime'
      ? memberMeter(runtime as Runtime, actor, params.meterOptions ?? {})
      : params.meter;
  const guardedMeter = guardAiMeter(baseMeter, {
    isStopped: isAiStopped,
    stoppedError: () => new SignAiStoppedError(),
  });

  try {
    const answerVault = ai.reader.answerVaultQuestion.bind(ai.reader);
    const aiRes = await withAiScope({ orgId, meter: guardedMeter }, () =>
      answerVault({
        question: input.question,
        candidates: items.map((item) => ({
          envelopeId: item.envelopeId,
          title: item.title,
          status: item.status,
          pageCount: item.pageCount,
          snippets: item.snippets.map((s) => ({
            pageNumber: s.pageNumber,
            text: s.excerpt,
          })),
        })),
      }),
    );

    if (await isAiStopped()) {
      return { ai: 'off', items, summary: null };
    }

    if (aiRes.kind === 'none' || !aiRes.summary) {
      return {
        ai: aiRes.code === 'REFUSED' ? 'failed' : 'empty',
        items,
        summary: null,
      };
    }

    return {
      ai: 'used',
      items,
      summary: aiRes.summary,
    };
  } catch (error: unknown) {
    if (error instanceof SignAiStoppedError) {
      return { ai: 'off', items, summary: null };
    }
    if (error instanceof AiBudgetExhaustedError) {
      return { ai: 'budget', items, summary: null };
    }
    if (error instanceof AiMeterMissingError) {
      throw error;
    }
    if (error instanceof DomainError && (error.status === 403 || error.status === 404)) {
      throw error;
    }
    console.error('[sign-ai] contract vault Q&A failed', error instanceof Error ? error.name : typeof error);
    return { ai: 'failed', items, summary: null };
  } finally {
    ticket.release();
  }
}

export interface EvaluateEnvelopePlaybookParams {
  ai: SignAi;
  runtime: Pick<Runtime, 'execute' | 'query'>;
  orgId: string;
  actor: UserActor | SystemActor;
  envelopeId: string;
  useAi?: boolean;
  pages?: readonly SignAiPageInput[];
  inspectPages?: (source: SignPlaybookSource) => Promise<readonly SignAiPageInput[]>;
  meter: AiMeter | 'runtime';
  meterOptions?: MeterOptions;
  promptVersion?: string;
  idempotencyKey?: string;
}

export async function evaluateEnvelopePlaybook(
  params: EvaluateEnvelopePlaybookParams,
): Promise<SignPlaybookEvaluateResult> {
  const { ai, runtime, orgId, actor, envelopeId } = params;
  if (actor.type !== 'user' && actor.type !== 'system') {
    throw new DomainError('FORBIDDEN', 403, 'Only workspace members or system workers can run contract playbook checks');
  }

  const source = await runtime.query<SignPlaybookSource>(
    'sign.playbook.source',
    { envelopeId },
    { actor, orgId },
  );

  const safeExisting = async (): Promise<SignEnvelopePlaybookCheckRecord | null> => {
    try {
      const res = await runtime.query<{ check: SignEnvelopePlaybookCheckRecord | null }>(
        'sign.playbook.get',
        { envelopeId },
        { actor, orgId },
      );
      return res.check;
    } catch {
      return null;
    }
  };

  if (source.inspectStatus !== 'passed' || !source.pageCount || source.pageCount < 1) {
    return { ai: 'not_ready', check: await safeExisting() };
  }
  if (source.activeRules.length === 0) {
    return { ai: 'no_rules', check: await safeExisting() };
  }
  if (!params.pages && !params.inspectPages) {
    return { ai: 'no_text', check: await safeExisting() };
  }

  const pageCount = source.pageCount;
  const rawPages = params.pages ?? (params.inspectPages ? await params.inspectPages(source) : []);
  const extractedPages: SignAiExtractedPage[] = rawPages
    .filter((p) => Number.isInteger(p.page) && p.page >= 1 && p.page <= pageCount)
    .map((p) => ({ page: p.page, text: p.text }));

  if (extractedPages.every((p) => p.text.trim().length === 0)) {
    return { ai: 'no_text', check: await safeExisting() };
  }

  const totalExtractedChars = extractedPages.reduce((sum, p) => sum + p.text.length, 0);
  if (totalExtractedChars > SIGN_PLAYBOOK_MAX_TOTAL_CHARS) {
    throw new DomainError(
      'SIGN_PLAYBOOK_TEXT_TOO_LARGE',
      422,
      `Total extracted contract text exceeds maximum of ${SIGN_PLAYBOOK_MAX_TOTAL_CHARS} characters`,
    );
  }

  const execOptions = {
    actor,
    orgId,
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
  };

  const recordDeterministicFallback = async (
    aiOutcome: Exclude<SignPlaybookAiOutcome, 'used'>,
    forceOverwrite: boolean,
  ): Promise<SignPlaybookEvaluateResult> => {
    const existing = await safeExisting();
    if (
      !forceOverwrite &&
      existing &&
      !existing.isStale &&
      (existing.mode === 'ai' || existing.mode === 'manual')
    ) {
      return { ai: aiOutcome, check: existing };
    }
    const saved = await runtime.execute<SignEnvelopePlaybookCheckRecord>(
      'sign.playbook.record_check',
      {
        envelopeId,
        sourceSha256: source.sourceSha256,
        mode: 'deterministic',
        promptVersion: null,
        preserveExistingFresh: !forceOverwrite,
        extractedPages,
      },
      execOptions,
    );
    return { ai: aiOutcome, check: saved };
  };

  const wantAi = params.useAi ?? true;
  if (!wantAi) {
    return recordDeterministicFallback('off', true);
  }
  if (!ai.reader?.checkPlaybook || source.aiStopped) {
    return recordDeterministicFallback('off', false);
  }

  const ticket = ai.budget.take(orgId, actorRateKey(actor));
  if (!ticket.allowed) {
    return recordDeterministicFallback('busy', false);
  }

  const promptVersion = params.promptVersion ?? SIGN_PLAYBOOK_CHECK_PROMPT_VERSION;
  const checkPlaybook = ai.reader.checkPlaybook.bind(ai.reader);

  const isAiStopped = async (): Promise<boolean> => {
    const latest = await runtime.query<SignPlaybookSource>(
      'sign.playbook.source',
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
    const guardedMeter = guardAiMeter(baseMeter, {
      isStopped: isAiStopped,
      stoppedError: () => new SignAiStoppedError(),
    });
    return withAiScope({ orgId, meter: guardedMeter }, fn);
  };

  try {
    const aiResult = await runScoped(() =>
      checkPlaybook({
        envelopeTitle: source.title,
        pageCount,
        pages: extractedPages,
        rules: source.activeRules.map((r) => ({
          id: r.id,
          title: r.title,
          guidance: r.guidance,
          severity: r.severity,
          matchKeywords: r.matchKeywords,
        })),
      }),
    );

    if (await isAiStopped()) {
      throw new SignAiStoppedError();
    }

    if (aiResult.kind === 'none' || aiResult.findings.length === 0) {
      return recordDeterministicFallback(
        aiResult.code === 'REFUSED' ? 'failed' : 'empty',
        false,
      );
    }

    const saved = await runtime.execute<SignEnvelopePlaybookCheckRecord>(
      'sign.playbook.record_check',
      {
        envelopeId,
        sourceSha256: source.sourceSha256,
        mode: 'ai',
        promptVersion,
        evaluatedRules: source.activeRules.map((r) => ({ ruleId: r.id, revision: r.revision })),
        aiFindings: aiResult.findings,
        extractedPages,
      },
      execOptions,
    );

    return {
      ai: saved.mode === 'ai' ? 'used' : 'failed',
      check: saved,
    };
  } catch (error: unknown) {
    if (error instanceof SignAiStoppedError) {
      return recordDeterministicFallback('off', false);
    }
    if (error instanceof AiBudgetExhaustedError) {
      return recordDeterministicFallback('budget', false);
    }
    if (error instanceof AiMeterMissingError) {
      throw error;
    }
    if (
      error instanceof DomainError &&
      (error.status === 403 || error.status === 404 || error.status === 409 || error.status === 422)
    ) {
      throw error;
    }
    console.error('[sign-ai] playbook check failed', error instanceof Error ? error.name : typeof error);
    return recordDeterministicFallback('failed', false);
  } finally {
    ticket.release();
  }
}

export interface ProposeEnvelopeKycCheckParams {
  ai: SignAi;
  runtime: Pick<Runtime, 'execute' | 'query'>;
  orgId: string;
  actor: UserActor;
  envelopeId: string;
  fieldId: string;
  expectedEntityName?: string | null | undefined;
  expectedTaxCode?: string | null | undefined;
  expectedSignerName?: string | null | undefined;
  attachmentPages?: readonly SignAiPageInput[] | undefined;
  inspectAttachmentPages?: ((source: SignKycSource) => Promise<readonly SignAiPageInput[]>) | undefined;
  meter: AiMeter | 'runtime';
  meterOptions?: MeterOptions | undefined;
  promptVersion?: string | undefined;
}

function kycOutcome(
  ai: Exclude<SignKycAiOutcomeContract, 'used'>,
  existing: SignKycCheckRecordContract | null = null,
): SignKycAnalyzeResult {
  return {
    ai,
    status: ai,
    check: existing,
  };
}

function normalizeKycAttachmentPages(
  pages: readonly SignAiPageInput[] | null | undefined,
): SignAiExtractedPage[] {
  if (!Array.isArray(pages)) return [];
  const out: SignAiExtractedPage[] = [];
  for (const page of pages) {
    if (!page || typeof page !== 'object') continue;
    if (!Number.isInteger(page.page) || page.page < 1) continue;
    if (typeof page.text !== 'string' || page.text.trim().length === 0) continue;
    out.push({ page: page.page, text: page.text });
  }
  return out;
}

export async function proposeEnvelopeKycCheck(
  params: ProposeEnvelopeKycCheckParams,
): Promise<SignKycAnalyzeResult> {
  const { ai, runtime, orgId, actor, envelopeId, fieldId } = params;
  if (actor.type !== 'user') {
    throw new DomainError('FORBIDDEN', 403, 'Only authenticated workspace members can run KYC attachment checks');
  }

  const source = await runtime.query<SignKycSource>(
    'sign.kyc.source',
    { envelopeId, fieldId },
    { actor, orgId },
  );

  const safeExisting = async (): Promise<SignKycCheckRecordContract | null> => {
    try {
      const list = await runtime.query<SignKycListResultContract>(
        'sign.kyc.list',
        { envelopeId },
        { actor, orgId },
      );
      return list.items.find((i) => i.fieldId === fieldId)?.check ?? null;
    } catch {
      return null;
    }
  };

  if (!ai.reader?.checkKycAttachment || source.aiStopped) {
    return kycOutcome('off', await safeExisting());
  }
  if (!source.sha256Verified) {
    return kycOutcome('not_ready', await safeExisting());
  }

  const fallbackStoredPages = normalizeKycAttachmentPages(
    source.storedTextPreview && source.storedTextPreview.trim().length > 0
      ? [{ page: 1, text: source.storedTextPreview }]
      : [],
  );

  const explicitPages = params.attachmentPages !== undefined ? normalizeKycAttachmentPages(params.attachmentPages) : null;
  if (
    source.contentType !== 'application/pdf' &&
    (!explicitPages || explicitPages.length === 0) &&
    !params.inspectAttachmentPages &&
    fallbackStoredPages.length === 0
  ) {
    return kycOutcome('no_text', await safeExisting());
  }

  let preResolvedPages: SignAiExtractedPage[];
  if (explicitPages !== null) {
    preResolvedPages = explicitPages;
  } else {
    let inspectedPages: SignAiExtractedPage[] = [];
    if (params.inspectAttachmentPages) {
      try {
        inspectedPages = normalizeKycAttachmentPages(await params.inspectAttachmentPages(source));
      } catch (error: unknown) {
        console.warn('[sign-ai] inspectAttachmentPages fallback triggered', error instanceof Error ? error.name : typeof error);
        inspectedPages = [];
      }
    }
    preResolvedPages = inspectedPages.length > 0 ? inspectedPages : fallbackStoredPages;
  }

  if (preResolvedPages.length === 0) {
    return kycOutcome('no_text', await safeExisting());
  }

  const rateBudget = ai.kycBudget ?? ai.budget;
  const ticket = rateBudget.take(orgId, actorRateKey(actor));
  if (!ticket.allowed) {
    return kycOutcome('busy', await safeExisting());
  }

  const promptVersion = params.promptVersion ?? SIGN_AI_PROMPT_VERSION;
  const checkKycAttachment = ai.reader.checkKycAttachment.bind(ai.reader);

  const isAiStopped = async (): Promise<boolean> => {
    const latest = await runtime.query<SignKycSource>(
      'sign.kyc.source',
      { envelopeId, fieldId },
      { actor, orgId },
    );
    return latest.aiStopped;
  };

  const runScoped = async <T>(fn: () => Promise<T>): Promise<T> => {
    const baseMeter =
      params.meter === 'runtime'
        ? memberMeter(runtime as Runtime, actor, params.meterOptions ?? {})
        : params.meter;
    const guardedMeter = guardAiMeter(baseMeter, {
      isStopped: isAiStopped,
      stoppedError: () => new SignAiStoppedError(),
    });
    return withAiScope({ orgId, meter: guardedMeter }, fn);
  };

  try {
    const maxPage = Math.max(
      source.storedPageCount ?? 0,
      ...preResolvedPages.map((p) => p.page),
      1,
    );
    const extractedPages: SignAiExtractedPage[] = preResolvedPages.filter((p) => p.page <= maxPage);

    if (extractedPages.length === 0) {
      return kycOutcome('no_text', await safeExisting());
    }

    const expectedEntityName =
      params.expectedEntityName !== undefined
        ? params.expectedEntityName
        : source.obligationCounterpartyName;
    const expectedSignerName = params.expectedSignerName?.trim() ? params.expectedSignerName.trim() : source.signerName;

    const kycResult = await runScoped(() =>
      checkKycAttachment({
        envelopeTitle: source.envelopeTitle,
        fieldLabel: source.fieldLabel,
        signerName: expectedSignerName,
        signerRoleLabel: source.signerRoleLabel,
        expectedEntityName: expectedEntityName ?? null,
        expectedTaxCode: params.expectedTaxCode ?? null,
        pageCount: maxPage,
        pages: extractedPages,
      }),
    );

    if (await isAiStopped()) {
      throw new SignAiStoppedError();
    }

    if (kycResult.kind === 'none' || !kycResult.proposal) {
      return kycOutcome(kycResult.code === 'REFUSED' ? 'failed' : 'empty', await safeExisting());
    }

    const saved = await runtime.execute<SignKycCheckRecordContract>(
      'sign.kyc.propose_ai',
      {
        envelopeId,
        fieldId,
        promptVersion,
        ...(params.expectedEntityName !== undefined ? { expectedEntityName: params.expectedEntityName } : {}),
        ...(params.expectedTaxCode !== undefined ? { expectedTaxCode: params.expectedTaxCode } : {}),
        ...(params.expectedSignerName !== undefined ? { expectedSignerName: params.expectedSignerName } : {}),
        extractedPages,
        proposal: kycResult.proposal,
      },
      { actor, orgId },
    );

    return {
      ai: 'used',
      status: saved.status,
      check: saved,
    };
  } catch (error: unknown) {
    if (error instanceof SignAiStoppedError || (error instanceof DomainError && error.code === 'SIGN_AI_DISABLED')) {
      return kycOutcome('off', await safeExisting());
    }
    if (error instanceof AiBudgetExhaustedError) {
      return kycOutcome('budget', await safeExisting());
    }
    if (error instanceof AiMeterMissingError) {
      throw error;
    }
    if (error instanceof DomainError && (error.status === 403 || error.status === 404)) {
      throw error;
    }
    console.error('[sign-ai] kyc check failed', error instanceof Error ? error.name : typeof error);
    return kycOutcome('failed', await safeExisting());
  } finally {
    ticket.release();
  }
}

export interface AnalyzeSignPacketConsistencyParams {
  ai: SignAi;
  runtime: Pick<Runtime, 'query'>;
  orgId: string;
  actor: UserActor | SystemActor;
  envelopeId: string;
  documents?: SignPacketConsistencyCheckInput['documents'];
  meter: AiMeter | 'runtime';
  meterOptions?: MeterOptions;
}

export async function analyzeSignPacketConsistency(
  params: AnalyzeSignPacketConsistencyParams,
): Promise<SignPacketConsistencyCheckResult> {
  const { ai, runtime, orgId, actor, envelopeId } = params;
  if (actor.type !== 'user' && actor.type !== 'system') {
    throw new DomainError('FORBIDDEN', 403, 'Only workspace members or system workers can check packet consistency');
  }

  const source = await runtime.query<SignPacketConsistencySource>(
    'sign.packet.consistency_source',
    { envelopeId },
    { actor, orgId },
  );

  // Deterministic check runs unconditionally regardless of AI toggle, budget, or inspect state:
  // in a multi-doc packet with signing/approval parties, flag any annex (docIndex >= 2) missing signature/initial fields.
  const hasSigningParty = source.signers.some((s) => s.signerRole === 'signer' || s.signerRole === 'approver');
  const signatureBearingDocIds = new Set<string>();
  const doc1 = source.documents[0];
  for (const field of source.fields) {
    if (field.fieldType !== 'signature' && field.fieldType !== 'initials' && field.fieldType !== 'stamp') continue;
    const targetDocId = field.documentId ?? doc1?.id ?? '__doc1__';
    signatureBearingDocIds.add(targetDocId);
  }

  const deterministicFindings: SignPacketConsistencyFinding[] = [];
  const missingDocIds = new Set<string>();
  if (hasSigningParty && source.documents.length >= 2) {
    for (const doc of source.documents) {
      if (doc.docIndex < 2) continue;
      const key = doc.id ?? '__doc1__';
      if (!signatureBearingDocIds.has(key)) {
        if (doc.id) missingDocIds.add(doc.id);
        deterministicFindings.push({
          kind: 'missing_signature_field',
          severity: 'warn',
          title: `Tài liệu #${doc.docIndex} chưa có ô chữ ký`,
          explanation: `Tài liệu "${doc.title}" chưa có ô chữ ký hoặc chữ ký nháy nào. Nếu các bên cần ký trực tiếp lên phụ lục này, hãy thêm ô ký trước khi gửi.`,
          documentId: doc.id,
          documentTitle: doc.title,
          pageNumber: doc.pageCount && doc.pageCount >= 1 ? 1 : null,
          quoteExcerpt: null,
          source: 'deterministic',
          tainted: false,
        });
      }
    }
  }

  const outcome = (
    aiState: SignPacketConsistencyCheckResult['ai'],
    findings: SignPacketConsistencyFinding[] = deterministicFindings,
    summaryText: string | null = null,
  ): SignPacketConsistencyCheckResult => ({
    envelopeId: source.envelopeId,
    ai: aiState,
    findings,
    summaryText,
  });

  if (!ai.reader?.checkPacketConsistency || source.aiStopped) {
    return outcome('off');
  }
  if (
    source.inspectStatus !== 'passed' ||
    source.documents.some((doc) => doc.inspectStatus !== 'passed' || !doc.pageCount || doc.pageCount < 1)
  ) {
    return outcome('not_ready');
  }

  const providedDocs = params.documents ?? [];
  const aiDocInputs: SignPacketConsistencyDocumentInput[] = [];
  let totalNonEmptyPages = 0;

  for (const doc of source.documents) {
    const pageCount = doc.pageCount!;
    const matchedInput =
      providedDocs.find((entry) => {
        if (entry.documentId && doc.id) return entry.documentId === doc.id;
        if (!entry.documentId && doc.docIndex === 1) return true;
        return false;
      }) ?? (source.documents.length === 1 ? providedDocs[0] : undefined);

    const boundedPages: SignAiPageInput[] = (matchedInput?.pages ?? [])
      .filter((p) => Number.isInteger(p.page) && p.page >= 1 && p.page <= pageCount && p.text.trim().length > 0)
      .map((p) => ({ page: p.page, text: p.text }));

    totalNonEmptyPages += boundedPages.length;
    const key = doc.id ?? '__doc1__';
    aiDocInputs.push({
      documentId: doc.id,
      docIndex: doc.docIndex,
      title: doc.title,
      pageCount,
      pages: boundedPages,
      missingSignatureField: hasSigningParty && !signatureBearingDocIds.has(key),
    });
  }

  if (totalNonEmptyPages === 0) {
    return outcome('no_text');
  }

  const ticket = ai.budget.take(orgId, actorRateKey(actor));
  if (!ticket.allowed) {
    return outcome('busy');
  }

  const checkPacketConsistency = ai.reader.checkPacketConsistency.bind(ai.reader);
  const isAiStopped = async (): Promise<boolean> => {
    const latest = await runtime.query<SignPacketConsistencySource>(
      'sign.packet.consistency_source',
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
    const guardedMeter = guardAiMeter(baseMeter, {
      isStopped: isAiStopped,
      stoppedError: () => new SignAiStoppedError(),
    });
    return withAiScope({ orgId, meter: guardedMeter }, fn);
  };

  try {
    const aiResult = await runScoped(() =>
      checkPacketConsistency({
        envelopeTitle: source.title,
        documents: aiDocInputs,
      }),
    );

    if (await isAiStopped()) {
      return outcome('off');
    }
    if (aiResult.code === 'REFUSED') {
      return outcome('failed');
    }
    if (aiResult.code === 'NO_TEXT') {
      return outcome('no_text');
    }

    const dedupedAiFindings = aiResult.findings.filter(
      (f) => !(f.kind === 'missing_signature_field' && f.documentId && missingDocIds.has(f.documentId)),
    );
    return outcome('used', [...deterministicFindings, ...dedupedAiFindings], aiResult.summaryText);
  } catch (error: unknown) {
    if (error instanceof SignAiStoppedError || (error instanceof DomainError && error.code === 'SIGN_AI_DISABLED')) {
      return outcome('off');
    }
    if (error instanceof AiBudgetExhaustedError) {
      return outcome('budget');
    }
    if (error instanceof AiMeterMissingError) {
      throw error;
    }
    if (error instanceof DomainError && (error.status === 403 || error.status === 404)) {
      throw error;
    }
    console.error('[sign-ai] packet consistency failed', error instanceof Error ? error.name : typeof error);
    return outcome('failed');
  } finally {
    ticket.release();
  }
}
