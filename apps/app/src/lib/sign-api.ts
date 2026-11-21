// SPDX-License-Identifier: AGPL-3.0-only
// Typed eSign API client aligned with #3323 core commands/queries, #3324 public ceremony routes, and #3351 Vy AI (#3325).
import type {
  SignContractDraftVariables,
  SignDiffCompareInput,
  SignDiffCompareResult,
  SignDrafterProposeInput,
  SignDrafterProposeResult,
  SignDrafterRenderPdfResult,
  SignSharedKeyTerm,
  SignSharedSummary,
} from '@crove/kernel-contract';
import { client, fetchFile, uploadFiles } from './api.ts';
import { apiUrl } from './api-base.ts';
import type {
  SignDeliveryMode,
  SignDetectedTag,
  SignEnvelopeStatus,
  SignFieldType,
  SignInspectStatus,
  SignRoutingMode,
  SignSealStatus,
  SignSignerRole,
  SignSignerStatus,
} from './sign-fields.ts';

export type {
  SignContractDraftVariables,
  SignDiffCompareInput,
  SignDiffCompareResult,
  SignDrafterProposeInput,
  SignDrafterProposeResult,
  SignDrafterRenderPdfResult,
  SignSharedKeyTerm,
  SignSharedSummary,
};

export interface SignEnvelopeSummary {
  id: string;
  title: string;
  status: SignEnvelopeStatus;
  routingMode: SignRoutingMode;
  sourceKind: string;
  sourceId: string | null;
  sourceFileId: string;
  inspectStatus: SignInspectStatus;
  sealStatus: SignSealStatus | null;
  certificateCode: string | null;
  pageCount: number | null;
  expiresAt: string | null;
  autoRemindBeforeExpiry?: boolean | undefined;
  sentAt: string | null;
  completedAt: string | null;
  declineAcknowledgedAt?: string | null | undefined;
  voidedAt: string | null;
  expiredAt: string | null;
  version: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  signerSummary: {
    total: number;
    signed: number;
    waitingForMe: boolean;
  };
}

export interface SignSignerRecord {
  id: string;
  routingOrder: number;
  signerRole: SignSignerRole;
  roleLabel: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  deliveryMode: SignDeliveryMode;
  requireEmailOtp: boolean;
  status: SignSignerStatus;
  tokenLastRemindedAt: string | null;
  preExpiryRemindedAt?: string | null | undefined;
  preExpiryRemindStatus?:
    | 'queued'
    | 'sending'
    | 'sent'
    | 'delivered'
    | 'bounced'
    | 'complained'
    | 'suppressed'
    | 'failed'
    | 'ambiguous'
    | null
    | undefined;
  viewedAt: string | null;
  signedAt: string | null;
  declinedAt: string | null;
  declineReason: string | null;
  otpVerifiedAt: string | null;
  signatureKind: string | null;
  consentAcceptedAt: string | null;
  delegatedFromName?: string | null | undefined;
  delegatedFromEmail?: string | null | undefined;
  delegationReason?: string | null | undefined;
  delegationCount?: number | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface SignFieldRecord {
  id: string;
  signerId: string;
  fieldType: SignFieldType;
  pageNumber: number;
  xNorm: number;
  yNorm: number;
  wNorm: number;
  hNorm: number;
  label: string | null;
  required: boolean;
  proposedByAi: boolean;
  fontSizePt: number | null;
  valueText: string | null;
  valueChecked: boolean | null;
  filledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SignProposedField {
  proposalId: string;
  signerId: string;
  signerRoleKey?: string;
  fieldType: SignFieldType;
  pageNumber: number;
  xNorm: number;
  yNorm: number;
  wNorm: number;
  hNorm: number;
  label: string | null;
  required: boolean;
  confidence?: number | null;
  proposedByAi?: true;
}

export interface SignRiskClause {
  clauseId: string;
  title: string;
  severity: 'low' | 'medium' | 'high';
  pageNumber: number | null;
  quote: string;
  explanation: string;
}

export interface SignAiAnalysis {
  status: 'pending' | 'idle' | 'running' | 'completed' | 'failed' | 'disabled' | 'budget_exhausted';
  summaryText: string | null;
  riskLevel: 'low' | 'medium' | 'high' | null;
  proposedFields: readonly SignProposedField[];
  riskClauses: readonly SignRiskClause[];
  errorMessage?: string | null;
  completedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

// Normalizes both #3351 SignAiAnalysisRecord and optional envelope detail/mock shapes cleanly.
export function normalizeAiAnalysis(raw: unknown): SignAiAnalysis | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const aiOutcome = typeof obj.ai === 'string' ? obj.ai : null;
  const hasAnalysisObj = Boolean(obj.analysis && typeof obj.analysis === 'object');
  const source = (hasAnalysisObj ? obj.analysis : obj) as Record<string, unknown>;
  const rawFields = Array.isArray(source.proposedFields)
    ? source.proposedFields
    : Array.isArray(obj.proposedFields)
      ? obj.proposedFields
      : [];
  const proposedFields: SignProposedField[] = rawFields.map((item, idx) => {
    const f = (item ?? {}) as Record<string, unknown>;
    const signerId = String(f.signerId ?? '');
    const fieldType = (f.fieldType as SignFieldType) ?? 'signature';
    const pageNumber = Number(f.pageNumber ?? 1);
    return {
      proposalId: typeof f.proposalId === 'string' && f.proposalId ? f.proposalId : `prop-${idx}-${signerId}-${pageNumber}-${fieldType}`,
      signerId,
      ...(typeof f.signerRoleKey === 'string' ? { signerRoleKey: f.signerRoleKey } : {}),
      fieldType,
      pageNumber,
      xNorm: Number(f.xNorm ?? 0),
      yNorm: Number(f.yNorm ?? 0),
      wNorm: Number(f.wNorm ?? 0.2),
      hNorm: Number(f.hNorm ?? 0.08),
      label: typeof f.label === 'string' ? f.label : null,
      required: typeof f.required === 'boolean' ? f.required : true,
      confidence: typeof f.confidence === 'number' ? f.confidence : null,
      proposedByAi: true,
    };
  });
  const rawClauses = Array.isArray(source.riskClauses)
    ? source.riskClauses
    : Array.isArray(source.flaggedClauses)
      ? source.flaggedClauses
      : Array.isArray(obj.riskClauses)
        ? obj.riskClauses
        : [];
  const riskClauses: SignRiskClause[] = rawClauses.map((item, idx) => {
    const c = (item ?? {}) as Record<string, unknown>;
    const severity = (c.severity ?? c.riskLevel ?? 'low') as 'low' | 'medium' | 'high';
    const pageRaw = c.pageNumber;
    const pageNumber = typeof pageRaw === 'number' && Number.isFinite(pageRaw) ? pageRaw : null;
    return {
      clauseId: typeof c.clauseId === 'string' && c.clauseId ? c.clauseId : `clause-${idx}-${pageNumber ?? 'x'}`,
      title: String(c.title ?? ''),
      severity,
      pageNumber,
      quote: String(c.quote ?? c.quoteExcerpt ?? ''),
      explanation: String(c.explanation ?? c.note ?? ''),
    };
  });
  const highestRisk: 'low' | 'medium' | 'high' | null =
    (source.riskLevel as 'low' | 'medium' | 'high' | null | undefined) ??
    (riskClauses.some((c) => c.severity === 'high')
      ? 'high'
      : riskClauses.some((c) => c.severity === 'medium')
        ? 'medium'
        : riskClauses.length > 0
          ? 'low'
          : null);
  const summaryRaw = source.summaryText ?? source.summary ?? obj.summaryText ?? null;
  const isDirectFailure =
    !hasAnalysisObj &&
    (aiOutcome === 'not_ready' || aiOutcome === 'not_draft' || aiOutcome === 'no_text' || aiOutcome === 'failed');
  const statusRaw: SignAiAnalysis['status'] =
    aiOutcome === 'off'
      ? 'disabled'
      : aiOutcome === 'budget'
        ? 'budget_exhausted'
        : !hasAnalysisObj && aiOutcome === 'busy'
          ? 'running'
          : isDirectFailure
            ? 'failed'
            : ((source.status as SignAiAnalysis['status'] | undefined) ?? 'completed');
  const errorMessage =
    !hasAnalysisObj && aiOutcome === 'busy'
      ? 'SIGN_AI_BUSY'
      : isDirectFailure
        ? aiOutcome
        : typeof source.errorMessage === 'string'
          ? source.errorMessage
          : null;
  return {
    status: statusRaw,
    summaryText: typeof summaryRaw === 'string' ? summaryRaw : null,
    riskLevel: highestRisk,
    proposedFields,
    riskClauses,
    errorMessage,
    completedAt: typeof source.completedAt === 'string' ? source.completedAt : null,
    createdAt: typeof source.createdAt === 'string' ? source.createdAt : null,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
  };
}

export interface PublicSignField {
  id: string;
  fieldType: SignFieldType;
  pageNumber: number;
  xNorm: number;
  yNorm: number;
  wNorm: number;
  hNorm: number;
  label: string | null;
  required: boolean;
  fontSizePt?: number | null;
}

export type PublicSignViewState =
  | {
      state: 'ready';
      orgName: string;
      title: string;
      message: string | null;
      signerName: string;
      roleLabel: string;
      signerRole: SignSignerRole;
      expiresAt: string;
      pageCount: number;
      pageDimensions?: Array<{ pageNumber: number; widthPt: number; heightPt: number }>;
      requireEmailOtp?: boolean;
      otpVerified?: boolean;
      allowDelegation?: boolean | undefined;
      delegationCount?: number | undefined;
      delegatedFromName?: string | null | undefined;
      fields: readonly PublicSignField[];
      sharedSummary?: SignSharedSummary | null;
    }
  | {
      state: 'delegated';
      title: string;
      delegateName: string;
      maskedDelegateEmail: string | null;
    }
  | {
      state: 'otp_required';
      orgName: string;
      title: string;
      maskedEmail: string | null;
    }
  | {
      state: 'waiting_turn';
      title: string;
      order: number;
    }
  | {
      state: 'already_completed' | 'declined' | 'expired' | 'voided';
      title: string;
      status: string;
      signerRole?: SignSignerRole;
    };

export interface PublicFieldSubmission {
  fieldId: string;
  signaturePngBase64?: string;
  valueText?: string;
  valueChecked?: boolean;
}

export interface PublicCertificateVerifyResponse {
  matched: boolean;
  envelopeTitle?: string;
  envelopeStatus?: string;
  certificateCode?: string;
  sealedSha256?: string;
  completedAt?: string;
  signerCount?: number;
  eventCount?: number;
}

export async function uploadSignPdf(file: File, orgSlug?: string | null): Promise<{ fileId: string }> {
  const result = await uploadFiles([file], 'sign_document', orgSlug);
  const uploaded = result.files[0];
  if (!uploaded) throw new Error('UPLOAD_FAILED');
  return { fileId: uploaded.fileId };
}

export async function downloadSignFile(fileId: string): Promise<Blob> {
  return fetchFile(fileId);
}

export async function downloadSignPdfBytes(fileId: string): Promise<Uint8Array> {
  const blob = await fetchFile(fileId);
  const buffer = await blob.arrayBuffer();
  return new Uint8Array(buffer);
}

export const signApi = {
  listEnvelopes: (input: { status?: SignEnvelopeStatus; limit?: number } = {}) => client.sign.envelope.list(input),
  getEnvelope: (envelopeId: string) => client.sign.envelope.get({ envelopeId }),
  getEnvelopeEvents: (envelopeId: string) => client.sign.envelope.events({ envelopeId }),
  verifyEnvelope: (envelopeId: string) => client.sign.envelope.verify({ envelopeId }),
  createEnvelope: (input: {
    title: string;
    subject?: string;
    message?: string;
    routingMode: SignRoutingMode;
    allowDelegation?: boolean;
    sourceFileId: string;
    expiresAt?: string | null;
    autoRemindBeforeExpiry?: boolean;
  }) => client.sign.envelope.create({ ...input, sourceKind: 'standalone', idempotencyKey: crypto.randomUUID() }),
  updateEnvelope: (input: {
    envelopeId: string;
    expectedVersion?: number;
    title?: string;
    subject?: string | null;
    message?: string | null;
    routingMode?: SignRoutingMode;
    allowDelegation?: boolean;
    expiresAt?: string | null;
    autoRemindBeforeExpiry?: boolean;
  }) => client.sign.envelope.update({ ...input, idempotencyKey: crypto.randomUUID() }),
  setEnvelopeSharedSummary: (input: {
    envelopeId: string;
    shareSummaryWithSigners: boolean;
    sharedSummary: SignSharedSummary | null;
    expectedVersion?: number;
  }) => client.sign.envelope.shared_summary_set({ ...input, idempotencyKey: crypto.randomUUID() }),
  sendEnvelope: (envelopeId: string) => client.sign.envelope.send({ envelopeId }),
  remindEnvelope: (envelopeId: string, signerId?: string) =>
    client.sign.envelope.remind({ envelopeId, ...(signerId ? { signerId } : {}), idempotencyKey: crypto.randomUUID() }),
  voidEnvelope: (envelopeId: string, reason?: string) =>
    client.sign.envelope.void({ envelopeId, ...(reason ? { reason } : {}), idempotencyKey: crypto.randomUUID() }),
  acknowledgeDecline: (envelopeId: string) =>
    client.sign.envelope.acknowledge_decline({ envelopeId, idempotencyKey: crypto.randomUUID() }),
  addSigner: (input: {
    envelopeId: string;
    routingOrder?: number;
    signerRole: SignSignerRole;
    roleLabel?: string;
    name: string;
    email?: string;
    phone?: string;
    deliveryMode: SignDeliveryMode;
    requireEmailOtp: boolean;
  }) => client.sign.signer.add({ ...input, idempotencyKey: crypto.randomUUID() }),
  removeSigner: (envelopeId: string, signerId: string) =>
    client.sign.signer.remove({ envelopeId, signerId, idempotencyKey: crypto.randomUUID() }),
  reorderSigners: (envelopeId: string, orders: Array<{ signerId: string; routingOrder: number }>) =>
    client.sign.signer.reorder({ envelopeId, orders, idempotencyKey: crypto.randomUUID() }),
  createSignerLink: (envelopeId: string, signerId: string, expiresInHours?: number) =>
    client.sign.signer.create_link({ envelopeId, signerId, ...(expiresInHours ? { expiresInHours } : {}) }),
  correctSignerRecipient: (input: {
    envelopeId: string;
    signerId: string;
    name: string;
    email?: string | null;
    phone?: string | null;
    deliveryMode: SignDeliveryMode;
    requireEmailOtp?: boolean;
  }) => client.sign.signer.correct_recipient(input),
  setFields: (
    envelopeId: string,
    fields: Array<{
      signerId: string;
      fieldType: SignFieldType;
      pageNumber: number;
      xNorm: number;
      yNorm: number;
      wNorm: number;
      hNorm: number;
      label?: string;
      required: boolean;
      proposedByAi: boolean;
      fontSizePt?: number;
    }>,
  ) => client.sign.field.set({ envelopeId, fields, idempotencyKey: crypto.randomUUID() }),
  analyzeAi: async (
    envelopeId: string,
    pages?: ReadonlyArray<{ page: number; text: string }>,
  ): Promise<SignAiAnalysis | null> => {
    const res = await client.sign.ai.analyze({
      envelopeId,
      ...(pages && pages.length > 0 ? { pages: [...pages] } : {}),
    });
    return normalizeAiAnalysis(res);
  },
  getAiAnalysis: async (envelopeId: string): Promise<SignAiAnalysis | null> => {
    return normalizeAiAnalysis(await client.sign.ai.get({ envelopeId }));
  },
  comparePdfVersions: (input: SignDiffCompareInput): Promise<SignDiffCompareResult> =>
    client.sign.diff.compare(input),
  proposeContractClauses: (input: SignDrafterProposeInput): Promise<SignDrafterProposeResult> =>
    client.sign.drafter.proposeClauses(input),
  renderStarterContractPdf: (input: SignContractDraftVariables): Promise<SignDrafterRenderPdfResult> =>
    client.sign.drafter.renderPdf(input),
  listTemplates: (input: { status?: SignTemplateStatus; query?: string; limit?: number } = {}) =>
    client.sign.template.list(input),
  getTemplate: (templateId: string) => client.sign.template.get({ templateId }),
  createTemplate: (input: {
    title: string;
    description?: string | null;
    routingMode: SignRoutingMode;
    subject?: string | null;
    message?: string | null;
    expiresInHours?: number | null;
    sourceFileId?: string;
    sourceEnvelopeId?: string;
    copyRolesAndFields?: boolean;
    status?: 'draft' | 'active';
  }) => client.sign.template.create({ ...input, idempotencyKey: crypto.randomUUID() }),
  updateTemplate: (input: {
    templateId: string;
    title?: string;
    description?: string | null;
    routingMode?: SignRoutingMode;
    subject?: string | null;
    message?: string | null;
    expiresInHours?: number | null;
    status?: 'draft' | 'active';
  }) => client.sign.template.update({ ...input, idempotencyKey: crypto.randomUUID() }),
  setTemplateSharedSummary: (input: {
    templateId: string;
    shareSummaryWithSigners: boolean;
    sharedSummary: SignSharedSummary | null;
  }) => client.sign.template.shared_summary_set({ ...input, idempotencyKey: crypto.randomUUID() }),
  setTemplateRoles: (
    templateId: string,
    roles: Array<{
      id?: string;
      roleKey: string;
      signerRole: SignSignerRole;
      roleLabel: string;
      routingOrder: number;
      deliveryMode: SignDeliveryMode;
      requireEmailOtp: boolean;
    }>,
  ) => client.sign.template.roles_set({ templateId, roles, idempotencyKey: crypto.randomUUID() }),
  setTemplateFields: (
    templateId: string,
    fields: Array<{
      templateRoleId?: string;
      roleKey?: string;
      fieldType: SignFieldType;
      pageNumber: number;
      xNorm: number;
      yNorm: number;
      wNorm: number;
      hNorm: number;
      label?: string | null;
      required: boolean;
      fontSizePt?: number | null;
    }>,
  ) => client.sign.template.fields_set({ templateId, fields, idempotencyKey: crypto.randomUUID() }),
  archiveTemplate: (templateId: string) =>
    client.sign.template.archive({ templateId, idempotencyKey: crypto.randomUUID() }),
  instantiateTemplate: (input: {
    templateId: string;
    title?: string;
    subject?: string | null;
    message?: string | null;
    sourceKind?: 'standalone' | 'crm_quote' | 'crm_order' | 'hr_contract' | 'project_acceptance';
    sourceId?: string | null;
    expiresAt?: string | null;
    autoSend?: boolean;
    recipients: Array<{
      roleKey: string;
      name: string;
      email?: string | null;
      phone?: string | null;
      deliveryMode?: SignDeliveryMode;
      requireEmailOtp?: boolean;
    }>;
  }) => client.sign.template.instantiate(input),
  setTemplateDirectLink: (input: {
    templateId: string;
    enabled: boolean;
    requireEmailOtp?: boolean;
    maxUses?: number | null;
    expiresAt?: string | null;
  }) => client.sign.template.direct_link_set(input),
  rotateTemplateDirectLink: (input: {
    templateId: string;
    requireEmailOtp?: boolean;
    maxUses?: number | null;
    expiresAt?: string | null;
  }) => client.sign.template.direct_link_rotate(input),
  getCaSettings: () => client.sign.ca.settings(),
  saveCaConnection: (input: {
    provider: SignCaProvider;
    label: string;
    certRef?: string;
    status?: SignCaConnectionStatus;
    credentials?: SignCaCredentialsInput;
  }) => client.sign.ca.save_connection({ status: 'active', ...input }),
  disableCaConnection: (connectionId: string) => client.sign.ca.disable_connection({ connectionId }),
  testCaConnection: (connectionId: string) => client.sign.ca.test_connection({ connectionId }),
  listCaRequests: (envelopeId: string) => client.sign.ca.list_requests({ envelopeId }),
  initiateCaRequest: (input: { envelopeId: string; caConnectionId?: string; signerId?: string }) =>
    client.sign.ca.initiate_request({ ...input, idempotencyKey: crypto.randomUUID() }),
};

export type SignCaProvider = 'sandbox' | 'vnpt_smartca' | 'viettel_mysign' | 'misa_wesign';
export type SignCaConnectionStatus = 'active' | 'disabled';
export type SignCaCredentialsInput =
  | {
      provider: 'vnpt_smartca';
      spId: string;
      spPassword: string;
      userId: string;
      serialNumber?: string;
      baseUrl?: string;
    }
  | {
      provider: 'viettel_mysign';
      clientId: string;
      clientSecret: string;
      userId: string;
      profileId: string;
      baseUrl?: string;
    }
  | {
      provider: 'misa_wesign';
      clientId: string;
      clientKey: string;
      username: string;
      password: string;
      taxCode?: string;
      userId?: string;
      baseUrl?: string;
    };
export type SignCaTestState =
  | 'works'
  | 'wrong_credentials'
  | 'api_not_enabled'
  | 'ip_not_allowed'
  | 'unreachable'
  | 'signing_needs_person'
  | 'usb_token_unsupported';

export interface SignCaConnectionRecord {
  id: string;
  provider: SignCaProvider;
  label: string;
  certRef: string;
  status: SignCaConnectionStatus;
  lastTestState: SignCaTestState | null;
  lastTestedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SignCaSettingsResult {
  liveCaEnabled: boolean;
  brokerAvailable: boolean;
  connections: SignCaConnectionRecord[];
}

export type SignTemplateStatus = 'draft' | 'active' | 'archived';

export interface SignTemplateRoleRecord {
  id: string;
  roleKey: string;
  signerRole: SignSignerRole;
  roleLabel: string;
  routingOrder: number;
  deliveryMode: SignDeliveryMode;
  requireEmailOtp: boolean;
}

export interface SignTemplateFieldRecord {
  id: string;
  templateRoleId: string;
  roleKey: string;
  fieldType: SignFieldType;
  pageNumber: number;
  xNorm: number;
  yNorm: number;
  wNorm: number;
  hNorm: number;
  label: string | null;
  required: boolean;
  fontSizePt: number | null;
}

export interface SignTemplateDirectLinkDetail {
  id: string;
  enabled: boolean;
  requireEmailOtp: boolean;
  maxUses?: number | null | undefined;
  usesCount?: number | undefined;
  expiresAt?: string | null | undefined;
  lastRotatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SignTemplateSummary {
  id: string;
  title: string;
  description: string | null;
  routingMode: SignRoutingMode;
  subject: string | null;
  message: string | null;
  expiresInHours: number | null;
  status: SignTemplateStatus;
  inspectStatus: SignInspectStatus;
  inspectError: string | null;
  pageCount: number | null;
  roleCount: number;
  nonCcRoleCount: number;
  fieldCount: number;
  directLink: {
    enabled: boolean;
    requireEmailOtp: boolean;
    maxUses?: number | null | undefined;
    usesCount?: number | undefined;
    expiresAt?: string | null | undefined;
    lastRotatedAt: string | null;
  } | null;
  version: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SignTemplateDetail {
  template: {
    id: string;
    title: string;
    description: string | null;
    routingMode: SignRoutingMode;
    subject: string | null;
    message: string | null;
    expiresInHours: number | null;
    status: SignTemplateStatus;
    inspectStatus: SignInspectStatus;
    inspectError: string | null;
    sourceFileId: string;
    sourceSha256: string;
    pageCount: number | null;
    pageDimensions: Array<{ page: number; widthPt: number; heightPt: number; rotation: number }> | null;
    detectedTags?: SignDetectedTag[];
    shareSummaryWithSigners?: boolean;
    sharedSummary?: SignSharedSummary | null;
    version: number;
    archivedAt: string | null;
    createdBy: string;
    createdAt: string;
    updatedAt: string;
  };
  roles: SignTemplateRoleRecord[];
  fields: SignTemplateFieldRecord[];
  directLink: SignTemplateDirectLinkDetail | null;
}

export class PublicSignError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

async function postPublicResponse(path: string, body: unknown): Promise<Response> {
  return fetch(apiUrl(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
}

async function postPublicJson<T>(path: string, body: unknown): Promise<T> {
  const response = await postPublicResponse(path, body);
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { code?: string; message?: string };
    throw new PublicSignError(response.status, data.code ?? 'SIGN_LINK_INVALID', data.message);
  }
  return (await response.json()) as T;
}

function normalizePublicField(raw: Record<string, unknown>): PublicSignField {
  return {
    id: String(raw.id ?? ''),
    fieldType: (raw.fieldType as SignFieldType) ?? 'signature',
    pageNumber: Number(raw.pageNumber ?? 1),
    xNorm: Number(raw.xNorm ?? 0),
    yNorm: Number(raw.yNorm ?? 0),
    wNorm: Number(raw.wNorm ?? 0.2),
    hNorm: Number(raw.hNorm ?? 0.08),
    label: typeof raw.label === 'string' ? raw.label : null,
    required: typeof raw.required === 'boolean' ? raw.required : true,
    fontSizePt: typeof raw.fontSizePt === 'number' ? raw.fontSizePt : null,
  };
}

function normalizePublicSharedSummary(raw: unknown): SignSharedSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const summaryText = typeof obj.summaryText === 'string' && obj.summaryText.trim().length > 0 ? obj.summaryText.trim() : null;
  const rawTerms = Array.isArray(obj.keyTerms) ? obj.keyTerms : [];
  const keyTerms: SignSharedKeyTerm[] = rawTerms.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const item = entry as Record<string, unknown>;
    const label = typeof item.label === 'string' ? item.label.trim() : '';
    const value = typeof item.value === 'string' ? item.value.trim() : '';
    if (!label || !value) return [];
    const pageNumber =
      typeof item.pageNumber === 'number' && Number.isInteger(item.pageNumber) && item.pageNumber >= 1
        ? item.pageNumber
        : null;
    const quoteExcerpt =
      typeof item.quoteExcerpt === 'string' && item.quoteExcerpt.trim().length > 0 ? item.quoteExcerpt.trim() : null;
    return [{ label, value, pageNumber, quoteExcerpt }];
  });
  if (summaryText === null && keyTerms.length === 0) return null;
  return { summaryText, keyTerms };
}

// Public signing ceremony endpoints: token sits exclusively inside JSON POST bodies.
export const publicSignApi = {
  view: async (token: string): Promise<PublicSignViewState> => {
    const raw = await postPublicJson<Record<string, unknown>>('/api/sign/view', { token });
    if (raw.state === 'ready') {
      const legacySigner = (raw.signer && typeof raw.signer === 'object' ? raw.signer : null) as Record<string, unknown> | null;
      const rawFields = Array.isArray(raw.fields) ? (raw.fields as Array<Record<string, unknown>>) : [];
      const sharedSummary = normalizePublicSharedSummary(raw.sharedSummary);
      return {
        state: 'ready',
        orgName: typeof raw.orgName === 'string' ? raw.orgName : '',
        title: String(raw.title ?? ''),
        message: typeof raw.message === 'string' ? raw.message : null,
        signerName: typeof raw.signerName === 'string' ? raw.signerName : String(legacySigner?.name ?? ''),
        roleLabel: typeof raw.roleLabel === 'string' ? raw.roleLabel : String(legacySigner?.roleLabel ?? ''),
        signerRole: raw.signerRole === 'approver' || legacySigner?.signerRole === 'approver' ? 'approver' : 'signer',
        expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : '',
        pageCount: Number(raw.pageCount ?? 1),
        ...(Array.isArray(raw.pageDimensions) ? { pageDimensions: raw.pageDimensions as Array<{ pageNumber: number; widthPt: number; heightPt: number }> } : {}),
        ...(typeof raw.requireEmailOtp === 'boolean' ? { requireEmailOtp: raw.requireEmailOtp } : {}),
        ...(typeof raw.otpVerified === 'boolean' ? { otpVerified: raw.otpVerified } : {}),
        ...(typeof raw.allowDelegation === 'boolean' ? { allowDelegation: raw.allowDelegation } : {}),
        ...(typeof raw.delegationCount === 'number' ? { delegationCount: raw.delegationCount } : {}),
        ...(raw.delegatedFromName === null || typeof raw.delegatedFromName === 'string'
          ? { delegatedFromName: raw.delegatedFromName as string | null }
          : {}),
        fields: rawFields.map(normalizePublicField),
        ...(sharedSummary ? { sharedSummary } : {}),
      };
    }
    return raw as unknown as PublicSignViewState;
  },

  pdf: async (token: string): Promise<Uint8Array> => {
    const response = await postPublicResponse('/api/sign/pdf', { token });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { code?: string; message?: string };
      throw new PublicSignError(response.status, data.code ?? 'SIGN_PDF_UNAVAILABLE', data.message);
    }
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  },

  requestOtp: (token: string) =>
    postPublicJson<{ sent: boolean; expiresInMinutes?: number; maskedEmail?: string | null }>('/api/sign/otp/request', { token }),

  verifyOtp: (token: string, otpCode: string) =>
    postPublicJson<{ ok: boolean; locked: boolean; attemptsRemaining: number; expired?: boolean; notReady?: boolean }>('/api/sign/otp/verify', {
      token,
      code: otpCode,
    }),

  submit: (input: {
    token: string;
    consentAccepted: true;
    signatureKind?: 'draw' | 'type';
    signatureTypedText?: string;
    fields: readonly PublicFieldSubmission[];
  }) =>
    postPublicJson<{
      signerId: string;
      signerStatus: 'signed';
      envelopeStatus: 'sent' | 'in_progress' | 'completed';
      completed: boolean;
      signedAt: string;
    }>('/api/sign/submit', input),

  decline: (input: { token: string; reason: string }) =>
    postPublicJson<{ signerId: string; signerStatus: 'declined'; envelopeStatus: 'declined'; declinedAt: string }>(
      '/api/sign/decline',
      input,
    ),

  delegate: (input: { token: string; delegateName: string; delegateEmail: string; reason: string }) =>
    postPublicJson<{
      signerId: string;
      delegateName: string;
      maskedDelegateEmail: string | null;
      delegationCount: number;
      delegatedAt: string;
    }>('/api/sign/delegate', input),

  verifyPublic: async (input: { certificateCode: string; fileSha256: string }): Promise<PublicCertificateVerifyResponse> => {
    const response = await postPublicResponse('/api/sign/verify', input);
    // Public verify returns an opaque 404 across hash mismatch, unknown code, and MODULE_OFF.
    if (response.status === 404) {
      return { matched: false, certificateCode: input.certificateCode };
    }
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { code?: string; message?: string };
      throw new PublicSignError(response.status, data.code ?? 'VERIFY_FAILED', data.message);
    }
    const payload = (await response.json()) as PublicCertificateVerifyResponse;
    return {
      ...payload,
      certificateCode: payload.certificateCode ?? input.certificateCode,
    };
  },
};

export type PublicDirectSignViewState =
  | {
      state: 'otp_required';
      orgName: string;
      title: string;
      description: string | null;
      roleLabel: string;
      signerRole: 'signer' | 'approver';
      requireEmailOtp: true;
    }
  | {
      state: 'ready';
      orgName: string;
      title: string;
      description: string | null;
      message: string | null;
      roleLabel: string;
      signerRole: 'signer' | 'approver';
      emailRequired: boolean;
      requireEmailOtp: boolean;
      otpVerified: boolean;
      verifiedEmail: string | null;
      pageCount: number;
      pageDimensions?: Array<{ pageNumber: number; widthPt: number; heightPt: number }>;
      fieldCount: number;
      sharedSummary?: SignSharedSummary | null;
    };

export interface PublicDirectOtpRequestResult {
  sent: boolean;
  expiresInMinutes: number;
  maskedEmail: string | null;
}

export interface PublicDirectOtpVerifyResult {
  ok: boolean;
  locked: boolean;
  attemptsRemaining: number;
  expired?: boolean;
  notReady?: boolean;
  otpSessionToken?: string;
  verifiedEmail?: string;
}

export interface PublicDirectStartResult {
  envelopeId: string;
  signerId: string;
  signingToken: string;
  expiresAt: string;
}

// Public direct signing ceremony endpoints (/-/sign/d#<token>, #3551): token sits exclusively inside JSON POST bodies.
export const publicDirectSignApi = {
  view: async (token: string, otpSessionToken?: string | null): Promise<PublicDirectSignViewState> => {
    const raw = await postPublicJson<Record<string, unknown>>('/api/sign/direct/view', {
      token,
      ...(otpSessionToken ? { otpSessionToken } : {}),
    });
    if (raw.state === 'otp_required') {
      return {
        state: 'otp_required',
        orgName: typeof raw.orgName === 'string' ? raw.orgName : '',
        title: String(raw.title ?? ''),
        description: typeof raw.description === 'string' ? raw.description : null,
        roleLabel: typeof raw.roleLabel === 'string' ? raw.roleLabel : '',
        signerRole: raw.signerRole === 'approver' ? 'approver' : 'signer',
        requireEmailOtp: true,
      };
    }
    return {
      state: 'ready',
      orgName: typeof raw.orgName === 'string' ? raw.orgName : '',
      title: String(raw.title ?? ''),
      description: typeof raw.description === 'string' ? raw.description : null,
      message: typeof raw.message === 'string' ? raw.message : null,
      roleLabel: typeof raw.roleLabel === 'string' ? raw.roleLabel : '',
      signerRole: raw.signerRole === 'approver' ? 'approver' : 'signer',
      emailRequired: Boolean(raw.emailRequired),
      requireEmailOtp: Boolean(raw.requireEmailOtp),
      otpVerified: Boolean(raw.otpVerified),
      verifiedEmail: typeof raw.verifiedEmail === 'string' ? raw.verifiedEmail : null,
      pageCount: Number(raw.pageCount ?? 1),
      ...(Array.isArray(raw.pageDimensions)
        ? { pageDimensions: raw.pageDimensions as Array<{ pageNumber: number; widthPt: number; heightPt: number }> }
        : {}),
      fieldCount: Number(raw.fieldCount ?? 0),
      ...(normalizePublicSharedSummary(raw.sharedSummary)
        ? { sharedSummary: normalizePublicSharedSummary(raw.sharedSummary) }
        : {}),
    };
  },

  pdf: async (token: string, otpSessionToken?: string | null): Promise<Uint8Array> => {
    const response = await postPublicResponse('/api/sign/direct/pdf', {
      token,
      ...(otpSessionToken ? { otpSessionToken } : {}),
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { code?: string; message?: string };
      throw new PublicSignError(response.status, data.code ?? 'SIGN_PDF_UNAVAILABLE', data.message);
    }
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  },

  requestOtp: (token: string, email: string) =>
    postPublicJson<PublicDirectOtpRequestResult>('/api/sign/direct/otp/request', { token, email }),

  verifyOtp: async (token: string, email: string, code: string): Promise<PublicDirectOtpVerifyResult> => {
    const response = await postPublicResponse('/api/sign/direct/otp/verify', { token, email, code });
    if (response.status === 200 || response.status === 401 || response.status === 423) {
      return (await response.json()) as PublicDirectOtpVerifyResult;
    }
    const data = (await response.json().catch(() => ({}))) as { code?: string; message?: string };
    throw new PublicSignError(response.status, data.code ?? 'SIGN_LINK_INVALID', data.message);
  },

  start: (input: { token: string; name: string; email?: string | null; otpSessionToken?: string | null }) =>
    postPublicJson<PublicDirectStartResult>('/api/sign/direct/start', {
      token: input.token,
      name: input.name,
      ...(input.email ? { email: input.email } : {}),
      ...(input.otpSessionToken ? { otpSessionToken: input.otpSessionToken } : {}),
    }),
};
