// SPDX-License-Identifier: AGPL-3.0-only
// Interactive normalized [0..1] PDF field placer with pointer drag/resize, keyboard nudge, and Vy AI proposal overlays (#3325).
import { useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { cn } from '@ludy/ui/lib/utils';
import type { SignProposedField, SignSignerRecord } from '../../lib/sign-api.ts';
import {
  clampFieldBox,
  nudgeFieldBox,
  resizeFieldBox,
  signerChipStyle,
  type DraftFieldPlacement,
  type NormalizedBox,
} from '../../lib/sign-fields.ts';

export interface FieldOverlayProps {
  pageNumber: number;
  fields: readonly DraftFieldPlacement[];
  proposals: readonly SignProposedField[];
  signers: readonly SignSignerRecord[];
  selectedFieldId: string | null;
  editable: boolean;
  onSelectField: (fieldId: string | null) => void;
  onUpdateFieldBox: (fieldId: string, box: NormalizedBox) => void;
  onDeleteField: (fieldId: string) => void;
  onApplyProposal: (proposal: SignProposedField, adjustedBox?: NormalizedBox) => void;
  onDismissProposal: (proposalId: string) => void;
}

interface ActivePointerDrag {
  kind: 'field' | 'resize' | 'proposal';
  id: string;
  startX: number;
  startY: number;
  originBox: NormalizedBox;
  containerWidth: number;
  containerHeight: number;
  proposal?: SignProposedField;
}

export function FieldOverlayLayer({
  pageNumber,
  fields,
  proposals,
  signers,
  selectedFieldId,
  editable,
  onSelectField,
  onUpdateFieldBox,
  onDeleteField,
  onApplyProposal,
  onDismissProposal,
}: FieldOverlayProps) {
  const t = useTranslations('sign');
  const layerRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<ActivePointerDrag | null>(null);
  const [proposalDraftBox, setProposalDraftBox] = useState<Record<string, NormalizedBox>>({});

  const signerIndexById = new Map<string, number>();
  const signerNameById = new Map<string, string>();
  signers.forEach((signer, idx) => {
    signerIndexById.set(signer.id, idx);
    signerNameById.set(signer.id, signer.name);
  });

  const pageFields = fields.filter((f) => f.pageNumber === pageNumber);
  const pageProposals = proposals.filter((p) => p.pageNumber === pageNumber);

  const releaseCapture = (event: React.PointerEvent<HTMLElement>) => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const beginDrag = (
    event: React.PointerEvent<HTMLElement>,
    kind: ActivePointerDrag['kind'],
    id: string,
    originBox: NormalizedBox,
    proposal?: SignProposedField,
  ) => {
    if (!editable || !layerRef.current) return;
    event.stopPropagation();
    const rect = layerRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    if (kind === 'field' || kind === 'resize') {
      onSelectField(id);
    }
    setDrag({
      kind,
      id,
      startX: event.clientX,
      startY: event.clientY,
      originBox,
      containerWidth: rect.width,
      containerHeight: rect.height,
      ...(proposal ? { proposal } : {}),
    });
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLElement>) => {
    if (!drag) return;
    const dx = (event.clientX - drag.startX) / drag.containerWidth;
    const dy = (event.clientY - drag.startY) / drag.containerHeight;

    if (drag.kind === 'field') {
      onUpdateFieldBox(drag.id, nudgeFieldBox(drag.originBox, dx, dy));
    } else if (drag.kind === 'resize') {
      onUpdateFieldBox(drag.id, resizeFieldBox(drag.originBox, dx, dy));
    } else if (drag.kind === 'proposal') {
      const next = nudgeFieldBox(drag.originBox, dx, dy);
      setProposalDraftBox((prev) => ({ ...prev, [drag.id]: next }));
    }
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLElement>) => {
    releaseCapture(event);
    if (!drag) return;
    if (drag.kind === 'proposal' && drag.proposal) {
      const movedBox = proposalDraftBox[drag.id];
      const movedDistance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (movedBox && movedDistance >= 6) {
        onApplyProposal(drag.proposal, movedBox);
      }
      setProposalDraftBox((prev) => {
        const copy = { ...prev };
        delete copy[drag.id];
        return copy;
      });
    }
    setDrag(null);
  };

  const handlePointerCancel = (event: React.PointerEvent<HTMLElement>) => {
    releaseCapture(event);
    if (!drag) return;
    if (drag.kind === 'proposal') {
      setProposalDraftBox((prev) => {
        if (!(drag.id in prev)) return prev;
        const copy = { ...prev };
        delete copy[drag.id];
        return copy;
      });
    } else {
      onUpdateFieldBox(drag.id, drag.originBox);
    }
    setDrag(null);
  };

  const handleFieldKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, field: DraftFieldPlacement) => {
    if (!editable) return;
    const step = event.shiftKey ? 0.05 : 0.01;
    const isArrow = event.key.startsWith('Arrow');
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      onDeleteField(field.localId);
      return;
    }
    if (!isArrow) return;
    event.preventDefault();
    const dx = event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0;
    const dy = event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0;
    const nextBox = event.altKey ? resizeFieldBox(field, dx, dy) : nudgeFieldBox(field, dx, dy);
    onUpdateFieldBox(field.localId, nextBox);
  };

  return (
    <div ref={layerRef} className="pointer-events-none relative h-full w-full" data-testid="field-overlay-layer">
      {pageProposals.map((proposal) => {
        const box = proposalDraftBox[proposal.proposalId] ?? clampFieldBox(proposal);
        const signerName = signerNameById.get(proposal.signerId) ?? '';
        return (
          <div
            key={proposal.proposalId}
            data-testid={`vy-proposal-field-${proposal.proposalId}`}
            onPointerDown={(e) => beginDrag(e, 'proposal', proposal.proposalId, box, proposal)}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            style={{
              left: `${box.xNorm * 100}%`,
              top: `${box.yNorm * 100}%`,
              width: `${box.wNorm * 100}%`,
              height: `${box.hNorm * 100}%`,
            }}
            className={cn(
              'pointer-events-auto absolute flex flex-col justify-between rounded-md border-2 border-dashed border-proposal bg-proposal/10 p-1 text-proposal select-none',
              editable && 'touch-none cursor-grab active:cursor-grabbing',
            )}
          >
            <div className="flex items-center justify-between gap-1 overflow-hidden">
              <Badge variant="proposal" className="truncate px-1 py-0 text-[10px]">
                {t('vy.proposalBadge')}
              </Badge>
            </div>
            <div className="flex items-center justify-between gap-1">
              <span className="truncate text-[10px] font-medium">
                {t(`fields.types.${proposal.fieldType}`)}
                {signerName ? ` - ${signerName}` : ''}
              </span>
              {editable ? (
                <div className="flex shrink-0 items-center gap-1" onPointerDown={(e) => e.stopPropagation()}>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="h-5 px-1.5 text-[10px]"
                    onClick={() => onApplyProposal(proposal)}
                  >
                    {t('vy.applyProposal')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-5 px-1.5 text-[10px]"
                    onClick={() => onDismissProposal(proposal.proposalId)}
                  >
                    {t('vy.dismissProposal')}
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        );
      })}

      {pageFields.map((field) => {
        const idx = signerIndexById.get(field.signerId) ?? 0;
        const signerName = signerNameById.get(field.signerId) ?? '';
        const palette = signerChipStyle(idx);
        const isSelected = field.localId === selectedFieldId;
        return (
          <div
            key={field.localId}
            role="button"
            tabIndex={0}
            aria-label={`${t(`fields.types.${field.fieldType}`)}${signerName ? ` - ${signerName}` : ''}`}
            data-testid={`placed-field-${field.localId}`}
            onClick={(e) => {
              e.stopPropagation();
              onSelectField(field.localId);
            }}
            onKeyDown={(e) => handleFieldKeyDown(e, field)}
            onPointerDown={(e) => beginDrag(e, 'field', field.localId, field)}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            style={{
              left: `${field.xNorm * 100}%`,
              top: `${field.yNorm * 100}%`,
              width: `${field.wNorm * 100}%`,
              height: `${field.hNorm * 100}%`,
            }}
            className={cn(
              'pointer-events-auto absolute flex flex-col justify-between rounded-md border-2 p-1 text-xs select-none focus-visible:ring-3 focus-visible:ring-ring/60 focus-visible:outline-none',
              palette.border,
              palette.fill,
              palette.text,
              isSelected && 'ring-2 ring-ring',
              editable ? 'touch-none cursor-grab active:cursor-grabbing' : 'cursor-pointer',
            )}
          >
            <div className="flex items-center justify-between gap-1 overflow-hidden">
              <span className="truncate font-semibold">{field.label?.trim() || t(`fields.types.${field.fieldType}`)}</span>
              {field.proposedByAi ? (
                <Badge variant="proposal" className="shrink-0 px-1 py-0 text-[10px]">
                  {t('fields.proposedBadge')}
                </Badge>
              ) : null}
            </div>
            <div className="flex items-center justify-between gap-1 overflow-hidden">
              <span className="truncate text-[10px] opacity-90">{signerName}</span>
              {editable ? (
                <span
                  data-resize-handle="true"
                  onPointerDown={(e) => beginDrag(e, 'resize', field.localId, field)}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={handlePointerCancel}
                  className="size-3 shrink-0 touch-none cursor-nwse-resize rounded-xs border border-current bg-background/80"
                  aria-hidden="true"
                />
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
