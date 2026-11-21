// SPDX-License-Identifier: AGPL-3.0-only
// Vietnamese SME Starter Contract Drafter modal (Soan hop dong mau, #3822):
// supports 5 built-in starter contracts (NDA 2 chieu, Hop dong dich vu, Bien ban nghiem thu, Bien ban thanh ly,
// Hop dong cong tac vien), offline A4 PDF generation when AI is off, and optional metered Vy clause proposals
// ('sign.contract_draft') shown under tainted 'De xuat' preview before creating an envelope or template.
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import {
  SIGN_CONTRACT_CURRENCIES,
  SIGN_STARTER_TEMPLATE_KINDS,
  type SignContractCurrency,
  type SignContractDraftVariables,
  type SignStarterTemplateKind,
} from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@crove/ui/components/dialog';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { Textarea } from '@crove/ui/components/textarea';
import { AiMeter } from '../ai-meter.tsx';
import { ErrorText } from '../ui.tsx';
import { errorMessage } from '../../lib/api.ts';
import { signApi, uploadSignPdf } from '../../lib/sign-api.ts';
import {
  base64ToPdfBytes,
  buildOfflineStarterContractPdfBytes,
  neutralizeClientContractText,
  normalizeStarterDecimalValue,
} from '../../lib/sign-starter-pdf.ts';
import { toast } from '../../lib/toast.ts';

interface EditableClauseDraft {
  localId: string;
  heading: string;
  body: string;
  proposedByAi: boolean;
}

export interface ContractDrafterDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultPartyAName?: string;
  onEnvelopeCreated?: (envelopeId: string) => void;
  onTemplateCreated?: (templateId: string) => void;
}

function defaultTodayIso(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function triggerPdfDownload(bytes: Uint8Array, filename: string): void {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ContractDrafterDialog({
  open,
  onOpenChange,
  defaultPartyAName = '',
  onEnvelopeCreated,
  onTemplateCreated,
}: ContractDrafterDialogProps) {
  const t = useTranslations('sign.drafter');
  const common = useTranslations('common');

  const [templateKind, setTemplateKind] = useState<SignStarterTemplateKind>('service_agreement');
  const [contractNumber, setContractNumber] = useState('');
  const [partyAName, setPartyAName] = useState(defaultPartyAName);
  const [partyATaxCode, setPartyATaxCode] = useState('');
  const [partyAAddress, setPartyAAddress] = useState('');
  const [partyARep, setPartyARep] = useState('');

  const [partyBName, setPartyBName] = useState('');
  const [partyBTaxCode, setPartyBTaxCode] = useState('');
  const [partyBAddress, setPartyBAddress] = useState('');
  const [partyBRep, setPartyBRep] = useState('');

  const [scopeSummary, setScopeSummary] = useState('');
  const [contractValue, setContractValue] = useState('');
  const [currency, setCurrency] = useState<SignContractCurrency>('VND');
  const [effectiveDate, setEffectiveDate] = useState(defaultTodayIso);
  const [expiryDate, setExpiryDate] = useState('');

  const [vyInstructions, setVyInstructions] = useState('');
  const [vyAiNotice, setVyAiNotice] = useState<string | null>(null);
  const [customClauses, setCustomClauses] = useState<EditableClauseDraft[]>([]);
  const [formError, setFormError] = useState<string | null>(null);

  const buildValidatedVariables = (): SignContractDraftVariables | null => {
    setFormError(null);
    const cleanA = neutralizeClientContractText(partyAName);
    const cleanB = neutralizeClientContractText(partyBName);
    const cleanScope = neutralizeClientContractText(scopeSummary);
    const cleanEffective = effectiveDate.trim();
    if (!cleanA || !cleanB || !cleanScope || !/^\d{4}-\d{2}-\d{2}$/.test(cleanEffective)) {
      setFormError(t('validationRequiredError'));
      return null;
    }

    let normalizedVal: string | null = null;
    if (contractValue.trim()) {
      normalizedVal = normalizeStarterDecimalValue(contractValue);
      if (normalizedVal === null) {
        setFormError(t('invalidValueError'));
        return null;
      }
    }

    const cleanExpiry = expiryDate.trim() && /^\d{4}-\d{2}-\d{2}$/.test(expiryDate.trim()) ? expiryDate.trim() : null;

    return {
      templateKind,
      contractNumber: contractNumber.trim() ? neutralizeClientContractText(contractNumber) : null,
      partyA: {
        name: cleanA,
        taxCode: partyATaxCode.trim() ? neutralizeClientContractText(partyATaxCode) : null,
        address: partyAAddress.trim() ? neutralizeClientContractText(partyAAddress) : null,
        representative: partyARep.trim() ? neutralizeClientContractText(partyARep) : null,
      },
      partyB: {
        name: cleanB,
        taxCode: partyBTaxCode.trim() ? neutralizeClientContractText(partyBTaxCode) : null,
        address: partyBAddress.trim() ? neutralizeClientContractText(partyBAddress) : null,
        representative: partyBRep.trim() ? neutralizeClientContractText(partyBRep) : null,
      },
      scopeSummary: cleanScope,
      contractValue: normalizedVal,
      currency,
      effectiveDate: cleanEffective,
      expiryDate: cleanExpiry,
      customClauses: customClauses
        .filter((c) => c.heading.trim().length > 0 && c.body.trim().length > 0)
        .map((c) => ({
          heading: neutralizeClientContractText(c.heading),
          body: neutralizeClientContractText(c.body),
          proposedByAi: c.proposedByAi,
        })),
    };
  };

  const renderPdfWithOfflineFallback = async (
    variables: SignContractDraftVariables,
  ): Promise<{ title: string; filename: string; bytes: Uint8Array }> => {
    try {
      const rendered = await signApi.renderStarterContractPdf(variables);
      return {
        title: rendered.title,
        filename: rendered.filename,
        bytes: base64ToPdfBytes(rendered.pdfBase64),
      };
    } catch {
      const fallbackTitle = `${t(`kinds.${variables.templateKind}`)} - ${variables.partyB.name}`.slice(0, 280);
      const fallbackFilename = `${variables.templateKind.replace(/_/g, '-')}-${variables.effectiveDate}.pdf`;
      return {
        title: fallbackTitle,
        filename: fallbackFilename,
        bytes: buildOfflineStarterContractPdfBytes(variables),
      };
    }
  };

  const proposeClausesMutation = useMutation({
    mutationFn: async () => {
      const variables = buildValidatedVariables();
      if (!variables) return null;
      if (!vyInstructions.trim()) return null;
      return signApi.proposeContractClauses({
        variables,
        instructions: vyInstructions.trim(),
      });
    },
    onSuccess: (res) => {
      if (!res) return;
      if (res.ai === 'off' || res.ai === 'budget') {
        setVyAiNotice(t('vyAiOffNotice'));
        return;
      }
      setVyAiNotice(res.summaryNote ?? null);
      if (res.proposedClauses.length > 0) {
        setCustomClauses((prev) => [
          ...prev,
          ...res.proposedClauses.map((clause, idx) => ({
            localId: `vy-clause-${Date.now()}-${idx}`,
            heading: clause.heading,
            body: clause.body,
            proposedByAi: true,
          })),
        ]);
      }
    },
    onError: (err) => setFormError(errorMessage(err)),
  });

  const downloadMutation = useMutation({
    mutationFn: async () => {
      const variables = buildValidatedVariables();
      if (!variables) return null;
      return renderPdfWithOfflineFallback(variables);
    },
    onSuccess: (rendered) => {
      if (!rendered) return;
      triggerPdfDownload(rendered.bytes, rendered.filename);
    },
    onError: (err) => setFormError(errorMessage(err)),
  });

  const createTargetMutation = useMutation({
    mutationFn: async (target: 'envelope' | 'template') => {
      const variables = buildValidatedVariables();
      if (!variables) return null;
      const rendered = await renderPdfWithOfflineFallback(variables);
      const copy = new Uint8Array(rendered.bytes.byteLength);
      copy.set(rendered.bytes);
      const pdfFile = new File([copy], rendered.filename, { type: 'application/pdf' });
      const uploaded = await uploadSignPdf(pdfFile);

      if (target === 'envelope') {
        const created = await signApi.createEnvelope({
          title: rendered.title,
          routingMode: 'parallel',
          sourceFileId: uploaded.fileId,
        });
        return { kind: 'envelope' as const, id: created.envelopeId };
      }

      const createdTpl = await signApi.createTemplate({
        title: rendered.title,
        routingMode: 'parallel',
        sourceFileId: uploaded.fileId,
      });
      return { kind: 'template' as const, id: createdTpl.templateId };
    },
    onSuccess: (res) => {
      if (!res) return;
      onOpenChange(false);
      if (res.kind === 'envelope') {
        toast(t('createdEnvelopeToast'));
        onEnvelopeCreated?.(res.id);
      } else {
        toast(t('createdTemplateToast'));
        onTemplateCreated?.(res.id);
      }
    },
    onError: (err) => setFormError(errorMessage(err)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl" closeLabel={common('close')}>
        <DialogHeader>
          <DialogTitle>{t('dialogTitle')}</DialogTitle>
          <DialogDescription>{t('dialogDescription')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-xs">
          {formError ? <ErrorText>{formError}</ErrorText> : null}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="drafter-template-kind">{t('templateKindLabel')}</Label>
              <NativeSelect
                id="drafter-template-kind"
                value={templateKind}
                className="min-h-11 w-full"
                onChange={(e) => setTemplateKind(e.target.value as SignStarterTemplateKind)}
                data-testid="drafter-template-kind-select"
              >
                {SIGN_STARTER_TEMPLATE_KINDS.map((kind) => (
                  <NativeSelectOption key={kind} value={kind}>
                    {t(`kinds.${kind}`)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor="drafter-contract-number">{t('contractNumberLabel')}</Label>
              <Input
                id="drafter-contract-number"
                value={contractNumber}
                className="min-h-11"
                onChange={(e) => setContractNumber(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-2 rounded-md border bg-muted/20 p-3">
              <p className="font-semibold text-foreground">{t('partyAHeading')}</p>
              <div className="space-y-1">
                <Label htmlFor="drafter-party-a-name">{t('partyNameLabel')}</Label>
                <Input
                  id="drafter-party-a-name"
                  value={partyAName}
                  className="min-h-11"
                  onChange={(e) => setPartyAName(e.target.value)}
                  data-testid="drafter-party-a-name"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="drafter-party-a-tax">{t('partyTaxCodeLabel')}</Label>
                <Input
                  id="drafter-party-a-tax"
                  value={partyATaxCode}
                  className="min-h-11"
                  onChange={(e) => setPartyATaxCode(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="drafter-party-a-address">{t('partyAddressLabel')}</Label>
                <Input
                  id="drafter-party-a-address"
                  value={partyAAddress}
                  className="min-h-11"
                  onChange={(e) => setPartyAAddress(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="drafter-party-a-rep">{t('partyRepLabel')}</Label>
                <Input
                  id="drafter-party-a-rep"
                  value={partyARep}
                  className="min-h-11"
                  onChange={(e) => setPartyARep(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2 rounded-md border bg-muted/20 p-3">
              <p className="font-semibold text-foreground">{t('partyBHeading')}</p>
              <div className="space-y-1">
                <Label htmlFor="drafter-party-b-name">{t('partyNameLabel')}</Label>
                <Input
                  id="drafter-party-b-name"
                  value={partyBName}
                  className="min-h-11"
                  onChange={(e) => setPartyBName(e.target.value)}
                  data-testid="drafter-party-b-name"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="drafter-party-b-tax">{t('partyTaxCodeLabel')}</Label>
                <Input
                  id="drafter-party-b-tax"
                  value={partyBTaxCode}
                  className="min-h-11"
                  onChange={(e) => setPartyBTaxCode(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="drafter-party-b-address">{t('partyAddressLabel')}</Label>
                <Input
                  id="drafter-party-b-address"
                  value={partyBAddress}
                  className="min-h-11"
                  onChange={(e) => setPartyBAddress(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="drafter-party-b-rep">{t('partyRepLabel')}</Label>
                <Input
                  id="drafter-party-b-rep"
                  value={partyBRep}
                  className="min-h-11"
                  onChange={(e) => setPartyBRep(e.target.value)}
                />
              </div>
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="drafter-scope-summary">{t('scopeLabel')}</Label>
            <Textarea
              id="drafter-scope-summary"
              rows={3}
              value={scopeSummary}
              onChange={(e) => setScopeSummary(e.target.value)}
              data-testid="drafter-scope-summary"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="drafter-contract-value">{t('valueLabel')}</Label>
              <Input
                id="drafter-contract-value"
                inputMode="decimal"
                placeholder="15000000"
                value={contractValue}
                className="min-h-11"
                onChange={(e) => setContractValue(e.target.value)}
                data-testid="drafter-contract-value"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="drafter-currency">{t('currencyLabel')}</Label>
              <NativeSelect
                id="drafter-currency"
                value={currency}
                className="min-h-11 w-full"
                onChange={(e) => setCurrency(e.target.value as SignContractCurrency)}
              >
                {SIGN_CONTRACT_CURRENCIES.map((cur) => (
                  <NativeSelectOption key={cur} value={cur}>
                    {cur}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor="drafter-effective-date">{t('effectiveDateLabel')}</Label>
              <Input
                id="drafter-effective-date"
                type="date"
                value={effectiveDate}
                className="min-h-11"
                onChange={(e) => setEffectiveDate(e.target.value)}
                data-testid="drafter-effective-date"
              />
            </div>
          </div>

          <div className="space-y-1 sm:max-w-xs">
            <Label htmlFor="drafter-expiry-date">{t('expiryDateLabel')}</Label>
            <Input
              id="drafter-expiry-date"
              type="date"
              value={expiryDate}
              className="min-h-11"
              onChange={(e) => setExpiryDate(e.target.value)}
            />
          </div>

          <div className="space-y-2 rounded-md border border-dashed border-proposal bg-proposal/10 p-3">
            <AiMeter module="sign" />
            <div className="space-y-1">
              <Label htmlFor="drafter-vy-instructions">{t('vyPromptLabel')}</Label>
              <Textarea
                id="drafter-vy-instructions"
                rows={2}
                placeholder={t('vyPromptPlaceholder')}
                value={vyInstructions}
                onChange={(e) => setVyInstructions(e.target.value)}
                data-testid="drafter-vy-instructions"
              />
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="min-h-11"
              disabled={!vyInstructions.trim()}
              loading={proposeClausesMutation.isPending}
              onClick={() => proposeClausesMutation.mutate()}
              data-testid="drafter-vy-propose-btn"
            >
              {proposeClausesMutation.isPending ? t('vyProposingButton') : t('vyProposeButton')}
            </Button>
            {vyAiNotice ? (
              <p className="rounded bg-card px-2.5 py-1.5 text-muted-foreground" data-testid="drafter-vy-notice">
                {vyAiNotice}
              </p>
            ) : null}
          </div>

          <div className="space-y-2 border-t pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold text-foreground">{t('customClausesHeading')}</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="min-h-11"
                disabled={customClauses.length >= 15}
                onClick={() =>
                  setCustomClauses((prev) => [
                    ...prev,
                    { localId: `manual-clause-${Date.now()}-${prev.length}`, heading: '', body: '', proposedByAi: false },
                  ])
                }
                data-testid="drafter-add-clause-btn"
              >
                {t('addClauseButton')}
              </Button>
            </div>

            {customClauses.map((clause, idx) => (
              <div
                key={clause.localId}
                className="space-y-2 rounded-md border bg-card p-2.5"
                data-testid={`drafter-clause-item-${idx}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-foreground">#{idx + 1}</span>
                    {clause.proposedByAi ? <Badge variant="secondary">{t('proposalBadge')}</Badge> : null}
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="min-h-11 text-destructive"
                    onClick={() => setCustomClauses((prev) => prev.filter((it) => it.localId !== clause.localId))}
                  >
                    {t('removeClauseButton')}
                  </Button>
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`drafter-clause-heading-${idx}`}>{t('clauseHeadingLabel')}</Label>
                  <Input
                    id={`drafter-clause-heading-${idx}`}
                    value={clause.heading}
                    className="min-h-11"
                    onChange={(e) => {
                      const val = e.target.value;
                      setCustomClauses((prev) =>
                        prev.map((it) => (it.localId === clause.localId ? { ...it, heading: val } : it)),
                      );
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`drafter-clause-body-${idx}`}>{t('clauseBodyLabel')}</Label>
                  <Textarea
                    id={`drafter-clause-body-${idx}`}
                    rows={3}
                    value={clause.body}
                    onChange={(e) => {
                      const val = e.target.value;
                      setCustomClauses((prev) =>
                        prev.map((it) => (it.localId === clause.localId ? { ...it, body: val } : it)),
                      );
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        <DialogFooter className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            loading={downloadMutation.isPending}
            onClick={() => downloadMutation.mutate()}
            data-testid="drafter-download-pdf-btn"
          >
            {t('downloadPdfButton')}
          </Button>
          {onTemplateCreated ? (
            <Button
              type="button"
              variant="secondary"
              className="min-h-11"
              loading={createTargetMutation.isPending}
              onClick={() => createTargetMutation.mutate('template')}
              data-testid="drafter-create-template-btn"
            >
              {t('createTemplateButton')}
            </Button>
          ) : null}
          {onEnvelopeCreated ? (
            <Button
              type="button"
              className="min-h-11"
              loading={createTargetMutation.isPending}
              onClick={() => createTargetMutation.mutate('envelope')}
              data-testid="drafter-create-envelope-btn"
            >
              {t('createEnvelopeButton')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
