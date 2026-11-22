// SPDX-License-Identifier: AGPL-3.0-only
// Sandboxed CV extraction (crove-extract only, T12) + Engage Zalo OA / Facebook Page interview invite drafts (#4446 Stage 5D).
// Raw PDF/DOCX bytes are NEVER parsed inside modules or the kernel: all parsing goes strictly through crove-extract.
// CV extraction produces only a tainted editable proposal draft; a human HR admin/owner must explicitly save via hr.recruiting.candidate.add.
import { sql } from 'kysely';
import {
  HR_CANDIDATE_SOURCES,
  HR_CV_MAX_BYTES,
  zHrCvExtractAuditInput,
  zHrCvExtractAuthorizeInput,
  zHrCvExtractCompleteInput,
  zHrCvExtractContextInput,
  zHrCvExtractRequestInput,
  zHrInviteDraftAsk,
  zHrInviteDraftAuditInput,
  type HrCvExtractDraft,
  type HrCvExtractReason,
  type HrEngageChannel,
  type HrInterviewSlot,
  type HrInviteDraftResult,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery, tmpKey } from '@ludy/kernel-runtime';
import { buildEngageInviteDraft, extractCvFieldsDeterministically } from '@ludy/l10n-vn';
import { MANAGERS, resolveEntity } from './employees.ts';
import {
  candidateErased,
  candidateNotFound,
  computeInterviewSlots,
  loadInterviewerNames,
  openingNotFound,
  resolveInterviewerUserId,
} from './recruiting.ts';

export type CvSandboxKind = 'pdf_text' | 'docx_text';

export interface CvSandboxClient {
  extract(
    kind: CvSandboxKind,
    bytes: Uint8Array,
  ): Promise<
    | { ok: true; kind: CvSandboxKind; text: string; pages?: number }
    | { ok: false; code: string; message: string }
  >;
}

export interface CvDraftProposerInput {
  text: string;
  openingTitle: string | null;
  requiredSkills: readonly string[];
  sourceKind: CvSandboxKind;
  lang: 'vi' | 'en';
}

export interface CvDraftProposerResult {
  displayName: string | null;
  email: string | null;
  phone: string | null;
  yearsExperience: number | null;
  matchedSkills: string[];
  notes: string | null;
  textPreview: string | null;
  extractedChars: number;
  sourceKind: CvSandboxKind;
  ai: { ok: boolean; reason: HrCvExtractReason };
  tainted: true;
  draftKind: 'proposal';
  autoSaved: false;
  autonomousDecision: 'none';
}

export type CvDraftProposer = (input: CvDraftProposerInput) => Promise<CvDraftProposerResult>;

export const HR_CV_MAX_EXTRACTED_CHARS = 200_000;

export function hrCvBlobKey(orgId: string, sha256: string): string {
  return tmpKey(orgId, sha256);
}

/**
 * Extracts raw plain text from CV PDF/DOCX bytes strictly via the crove-extract sandbox client (gate T12).
 */
export async function extractCvTextInSandbox(deps: {
  extract: CvSandboxClient;
  kind: CvSandboxKind;
  bytes: Uint8Array;
}): Promise<{ kind: CvSandboxKind; text: string }> {
  if (deps.bytes.byteLength === 0) {
    throw new DomainError('NO_FILE', 400, 'Tệp CV rỗng');
  }
  if (deps.bytes.byteLength > HR_CV_MAX_BYTES) {
    throw new DomainError('TOO_LARGE', 413, 'Tệp CV vượt quá giới hạn 10 MB');
  }
  const result = await deps.extract.extract(deps.kind, deps.bytes);
  if (!result.ok) {
    throw new DomainError('HR_CV_EXTRACT_FAILED', 422, result.message || 'Không đọc được nội dung tệp CV');
  }
  const text = result.text.trim().slice(0, HR_CV_MAX_EXTRACTED_CHARS);
  if (text.length === 0) {
    throw new DomainError('HR_CV_EMPTY_TEXT', 422, 'Tệp CV không có văn bản đọc được (có thể là ảnh scan chưa OCR)');
  }
  return { kind: result.kind, text };
}

function hostnameMatches(hostname: string, domains: readonly string[]): boolean {
  if (hostname.length === 0 || hostname.length > 254) return false;
  let end = hostname.length;
  while (end > 0 && hostname.charCodeAt(end - 1) === 46) {
    end -= 1;
  }
  if (end === 0 || end > 253) return false;
  const normalized = hostname.slice(0, end).toLowerCase();
  return domains.some((domain) => normalized === domain || normalized.endsWith(`.${domain}`));
}

export function inferSuggestedSource(text: string): (typeof HR_CANDIDATE_SOURCES)[number] {
  const urlMatches = text.match(/https?:\/\/[^\s<>()]+/gi) ?? [];
  for (const rawUrl of urlMatches) {
    try {
      const host = new URL(rawUrl).hostname;
      if (hostnameMatches(host, ['zalo.me'])) return 'zalo_oa';
      if (hostnameMatches(host, ['facebook.com', 'fb.com', 'm.me'])) return 'facebook';
      if (hostnameMatches(host, ['vietnamworks.com', 'topcv.vn', 'itviec.com', 'linkedin.com'])) return 'job_board';
    } catch {
      // Ignore malformed URLs found inside untrusted CV plain text.
    }
  }
  const withoutUrls = text.replace(/https?:\/\/[^\s<>()]+/gi, ' ');
  if (/\bzalo\b/i.test(withoutUrls)) return 'zalo_oa';
  if (/\bfacebook\b/i.test(withoutUrls)) return 'facebook';
  if (/\b(?:vietnamworks|topcv|itviec|linkedin)\b/i.test(withoutUrls)) {
    return 'job_board';
  }
  if (/\b(?:giới\s+thiệu|referral)\b/iu.test(withoutUrls)) return 'referral';
  return 'direct';
}

/**
 * Builds a tainted editable CV proposal draft ("Đề xuất") from sandboxed plain text.
 * Works deterministically with zero AI calls when `propose` is omitted or disabled.
 */
export async function buildCvExtractDraft(deps: {
  text: string;
  sourceKind: CvSandboxKind;
  openingId: string | null;
  openingTitle: string | null;
  requiredSkills: readonly string[];
  lang?: 'vi' | 'en';
  propose?: CvDraftProposer;
}): Promise<HrCvExtractDraft> {
  const lang = deps.lang ?? 'vi';
  const suggestedSource = inferSuggestedSource(deps.text);

  if (deps.propose) {
    const proposed = await deps.propose({
      text: deps.text,
      openingTitle: deps.openingTitle,
      requiredSkills: deps.requiredSkills,
      sourceKind: deps.sourceKind,
      lang,
    });
    return {
      openingId: deps.openingId,
      openingTitle: deps.openingTitle,
      displayName: proposed.displayName,
      email: proposed.email,
      phone: proposed.phone,
      yearsExperience: proposed.yearsExperience,
      matchedSkills: proposed.matchedSkills,
      suggestedSource,
      notes: proposed.notes,
      sourceKind: deps.sourceKind,
      extractedChars: deps.text.length,
      textPreview: proposed.textPreview,
      ai: proposed.ai,
      tainted: true,
      draftKind: 'proposal',
      autoSaved: false,
      autonomousDecision: 'none',
    };
  }

  const deterministic = extractCvFieldsDeterministically(deps.text, deps.requiredSkills);
  return {
    openingId: deps.openingId,
    openingTitle: deps.openingTitle,
    displayName: deterministic.displayName,
    email: deterministic.email,
    phone: deterministic.phone,
    yearsExperience: deterministic.yearsExperience,
    matchedSkills: deterministic.matchedSkills,
    suggestedSource,
    notes: deterministic.notes,
    sourceKind: deps.sourceKind,
    extractedChars: deps.text.length,
    textPreview: deterministic.textPreview,
    ai: { ok: false, reason: 'ai_off' },
    tainted: true,
    draftKind: 'proposal',
    autoSaved: false,
    autonomousDecision: 'none',
  };
}

/**
 * Direct sandboxed CV extraction pipeline helper (`crove-extract` + deterministic fallback + optional Ly proposal).
 */
export async function extractAndProposeCv(deps: {
  extract: CvSandboxClient;
  kind: CvSandboxKind;
  bytes: Uint8Array;
  openingId?: string | null;
  openingTitle?: string | null;
  requiredSkills?: readonly string[];
  lang?: 'vi' | 'en';
  propose?: CvDraftProposer;
}): Promise<HrCvExtractDraft> {
  const extracted = await extractCvTextInSandbox({
    extract: deps.extract,
    kind: deps.kind,
    bytes: deps.bytes,
  });
  return buildCvExtractDraft({
    text: extracted.text,
    sourceKind: extracted.kind,
    openingId: deps.openingId ?? null,
    openingTitle: deps.openingTitle ?? null,
    requiredSkills: deps.requiredSkills ?? [],
    ...(deps.lang ? { lang: deps.lang } : {}),
    ...(deps.propose ? { propose: deps.propose } : {}),
  });
}

export interface HrCvExtractContext {
  jobId: string;
  legalEntityId: string;
  openingId: string | null;
  openingTitle: string | null;
  requiredSkills: string[];
  storageKey: string;
  resultKey: string | null;
  resultSha256: string | null;
}

async function resolveOpeningContext(
  ctx: Parameters<typeof resolveEntity>[0],
  openingId: string | undefined,
  requestedEntityId: string | undefined,
): Promise<{ legalEntityId: string; openingId: string | null; openingTitle: string | null; requiredSkills: string[] }> {
  if (!openingId) {
    return {
      legalEntityId: await resolveEntity(ctx, requestedEntityId),
      openingId: null,
      openingTitle: null,
      requiredSkills: [],
    };
  }
  const opening = await ctx.trx
    .selectFrom('crove_hr.job_opening')
    .select(['id', 'legal_entity_id', 'title', 'required_skills', 'status'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', openingId)
    .executeTakeFirst();
  if (!opening) throw openingNotFound();
  if (requestedEntityId !== undefined && opening.legal_entity_id !== requestedEntityId) {
    throw new DomainError('HR_CANDIDATE_WRONG_ENTITY', 422, 'Vị trí tuyển dụng không thuộc pháp nhân đã chọn');
  }
  const legalEntityId = await resolveEntity(ctx, opening.legal_entity_id);
  return {
    legalEntityId,
    openingId: opening.id,
    openingTitle: opening.title,
    requiredSkills: opening.required_skills,
  };
}

export const cvExtractAuthorizeQuery = defineQuery({
  name: 'hr.recruiting.cv_extract.authorize',
  input: zHrCvExtractAuthorizeInput,
  access: MANAGERS,
  handler: async (ctx, input): Promise<{ legalEntityId: string; openingId: string | null }> => {
    const resolved = await resolveOpeningContext(ctx, input.openingId, input.legalEntityId);
    return { legalEntityId: resolved.legalEntityId, openingId: resolved.openingId };
  },
});

export const cvExtractRequestCommand = defineCommand({
  name: 'hr.recruiting.cv_extract.request',
  input: zHrCvExtractRequestInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  writes: [],
  handler: async (ctx, input): Promise<HrCvExtractContext> => {
    const resolved = await resolveOpeningContext(ctx, input.openingId, input.legalEntityId);
    const storageKey = hrCvBlobKey(ctx.orgId, input.sha256);

    ctx.emit('hr.recruiting.cv_extract_queued', {
      jobId: input.jobId,
      storageKey,
      kind: input.kind,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
    });
    ctx.audit({
      jobId: input.jobId,
      legalEntityId: resolved.legalEntityId,
      openingId: resolved.openingId,
      kind: input.kind,
      sizeBytes: input.sizeBytes,
      inputSha256: input.sha256,
    });

    return {
      jobId: input.jobId,
      ...resolved,
      storageKey,
      resultKey: null,
      resultSha256: null,
    };
  },
});

export const cvExtractCompleteCommand = defineCommand({
  name: 'hr.recruiting.cv_extract.complete',
  input: zHrCvExtractCompleteInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  writes: [],
  handler: async (ctx, input): Promise<{ ok: true }> => {
    ctx.audit({
      jobId: input.jobId,
      ok: input.ok,
      resultSha256: input.resultSha256,
    });
    return { ok: true };
  },
});

export const cvExtractContextQuery = defineQuery({
  name: 'hr.recruiting.cv_extract.context',
  input: zHrCvExtractContextInput,
  access: MANAGERS,
  handler: async (ctx, input): Promise<HrCvExtractContext> => {
    const eventsRes = await sql<{
      command: string;
      input_sha256: string | null;
      legal_entity_id: string | null;
      opening_id: string | null;
      result_sha256: string | null;
    }>`
      SELECT
        command,
        detail ->> 'inputSha256' AS input_sha256,
        detail ->> 'legalEntityId' AS legal_entity_id,
        detail ->> 'openingId' AS opening_id,
        detail ->> 'resultSha256' AS result_sha256
      FROM ludy_kernel.audit_event
      WHERE org_id = ${ctx.orgId}::uuid
        AND command IN ('hr.recruiting.cv_extract.request', 'hr.recruiting.cv_extract.complete')
        AND detail ->> 'jobId' = ${input.jobId}
        AND outcome = 'ok'
        AND occurred_at >= pg_catalog.now() - interval '24 hours'
      ORDER BY id DESC
      LIMIT 10
    `.execute(ctx.trx);

    const req = eventsRes.rows.find((row) => row.command === 'hr.recruiting.cv_extract.request');
    if (!req?.input_sha256) {
      throw new DomainError('HR_CV_JOB_NOT_FOUND', 404, 'Không tìm thấy yêu cầu tách CV này');
    }

    if (req.legal_entity_id !== null && input.legalEntityId !== undefined && input.legalEntityId !== req.legal_entity_id) {
      throw new DomainError('HR_CANDIDATE_WRONG_ENTITY', 422, 'Yêu cầu tách CV không thuộc pháp nhân đã chọn');
    }
    if (req.opening_id !== null && input.openingId !== undefined && input.openingId !== req.opening_id) {
      throw new DomainError('HR_CANDIDATE_WRONG_ENTITY', 422, 'Vị trí tuyển dụng không khớp yêu cầu tách CV');
    }

    const openingId = req.opening_id ?? input.openingId ?? undefined;
    const requestedEntityId = req.legal_entity_id ?? input.legalEntityId ?? undefined;
    const resolved = await resolveOpeningContext(ctx, openingId, requestedEntityId);

    const completeRow = eventsRes.rows.find((row) => row.command === 'hr.recruiting.cv_extract.complete');
    const rawSha = completeRow?.result_sha256 ?? null;
    const resultSha256 = rawSha && /^[0-9a-f]{64}$/.test(rawSha) ? rawSha : null;

    return {
      jobId: input.jobId,
      ...resolved,
      storageKey: hrCvBlobKey(ctx.orgId, req.input_sha256),
      resultKey: resultSha256 ? hrCvBlobKey(ctx.orgId, resultSha256) : null,
      resultSha256,
    };
  },
});

export const cvExtractAuditCommand = defineCommand({
  name: 'hr.recruiting.cv_extract.audit',
  input: zHrCvExtractAuditInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  writes: [],
  handler: async (ctx, input): Promise<{ ok: true }> => {
    ctx.audit({
      jobId: input.jobId,
      openingId: input.openingId ?? null,
      kind: input.kind,
      extractedChars: input.extractedChars,
      aiReason: input.aiReason,
      autoSaved: false,
    });
    return { ok: true };
  },
});

export interface HrInviteDraftContext {
  candidateId: string;
  channel: HrEngageChannel;
  candidateLabel: string;
  openingTitle: string;
  interviewerUserId: string | null;
  interviewerName: string | null;
  slots: HrInterviewSlot[];
  lang: 'vi' | 'en';
}

export const inviteDraftContextQuery = defineQuery({
  name: 'hr.recruiting.invite_draft.context',
  input: zHrInviteDraftAsk,
  access: MANAGERS,
  sensitive: true,
  target: (input) => ({ type: 'hr.candidate', id: input.candidateId }),
  handler: async (ctx, input): Promise<HrInviteDraftContext> => {
    const row = await ctx.trx
      .selectFrom('crove_hr.candidate as c')
      .leftJoin('crove_hr.job_opening as o', (join) => join.onRef('o.org_id', '=', 'c.org_id').onRef('o.id', '=', 'c.opening_id'))
      .leftJoin('ludy_kernel.calendar_event as e', (join) =>
        join.onRef('e.org_id', '=', 'c.org_id').onRef('e.id', '=', 'c.interview_event_id').on('e.status', '=', 'active'),
      )
      .select([
        'c.id',
        'c.display_name',
        'c.erased_at',
        'o.title as opening_title',
        'e.user_id as active_interviewer_user_id',
      ])
      .where('c.org_id', '=', ctx.orgId)
      .where('c.id', '=', input.candidateId)
      .executeTakeFirst();
    if (!row) throw candidateNotFound();
    if (row.erased_at !== null) throw candidateErased();

    const targetInterviewerId = await resolveInterviewerUserId(
      ctx,
      input.interviewerUserId ?? row.active_interviewer_user_id ?? undefined,
    );
    const names = await loadInterviewerNames(ctx, [targetInterviewerId]);
    const fromIso = input.from ? `${input.from}T00:00:00.000+07:00` : undefined;
    const toIso = input.to ? `${input.to}T23:59:59.999+07:00` : undefined;

    const slotsResult = await computeInterviewSlots(ctx, {
      interviewerUserId: targetInterviewerId,
      ...(fromIso !== undefined ? { from: fromIso } : {}),
      ...(toIso !== undefined ? { to: toIso } : {}),
      durationMinutes: input.durationMinutes ?? 60,
      maxSlots: 5,
      minGapMinutes: 0,
    });

    const lang = input.lang ?? 'vi';
    const openingTitle = row.opening_title ?? (lang === 'en' ? 'open position' : 'vị trí đang tuyển');
    const candidateLabel = row.display_name.trim() || (lang === 'en' ? 'Candidate' : 'bạn');

    return {
      candidateId: row.id,
      channel: input.channel,
      candidateLabel,
      openingTitle,
      interviewerUserId: targetInterviewerId,
      interviewerName: names.get(targetInterviewerId) ?? null,
      slots: slotsResult.slots,
      lang,
    };
  },
});

export const inviteDraftAuditCommand = defineCommand({
  name: 'hr.recruiting.invite_draft.audit',
  input: zHrInviteDraftAuditInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  target: (input) => ({ type: 'hr.candidate', id: input.candidateId }),
  writes: [],
  handler: async (ctx, input): Promise<{ ok: true }> => {
    ctx.audit({
      candidateId: input.candidateId,
      channel: input.channel,
      slotCount: input.slotCount,
      autoSent: false,
    });
    return { ok: true };
  },
});

/**
 * Formats an editable Vietnamese/English Engage interview invite draft from resolved candidate + interviewer slots.
 */
export function buildEngageInviteDraftResult(context: HrInviteDraftContext): HrInviteDraftResult {
  const message = buildEngageInviteDraft({
    channel: context.channel,
    candidateLabel: context.candidateLabel,
    openingTitle: context.openingTitle,
    interviewerName: context.interviewerName,
    slots: context.slots.map((s) => ({ start: s.startIso, end: s.endIso })),
    lang: context.lang,
  });

  return {
    candidateId: context.candidateId,
    channel: context.channel,
    candidateLabel: context.candidateLabel,
    openingTitle: context.openingTitle,
    interviewerUserId: context.interviewerUserId,
    interviewerName: context.interviewerName,
    slots: context.slots,
    message,
    autoSent: false,
    humanSendRequired: true,
    ai: { ok: false, reason: 'template' },
  };
}

export const hrRecruitingIntakeCommands = [
  cvExtractRequestCommand,
  cvExtractCompleteCommand,
  cvExtractAuditCommand,
  inviteDraftAuditCommand,
];

export const hrRecruitingIntakeQueries = [
  cvExtractAuthorizeQuery,
  cvExtractContextQuery,
  inviteDraftContextQuery,
];
